import dns from 'node:dns/promises';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import express, { type Request, type Response } from 'express';
import { createServer as createViteServer } from 'vite';
import {
  classifyProviderKind,
  extractDooPlayAjaxConfig,
  extractDooPlayNonce,
  extractMissingDooPlayerOptions,
  extractStreamsFromEmbed,
  inferMediaKindFromUrl,
  parseAnimePageHtml,
  parseCalendarPageHtml,
  parseCatalogArchiveHtml,
  parseDooPlayerAjaxResponse,
  parseEpisodePageHtml,
  parseEpisodesArchiveHtml,
  parseHomeHtml,
  parseSearchPageHtml,
  parseWpGlossaryJson,
  parseWpSearchJson,
} from './src/lib/topanimesParser.ts';
import type {
  CatalogArchiveCategory,
  CatalogFilters,
  CatalogMediaItem,
  EpisodeDetails,
  FavoriteLatestInfo,
  HomeCatalog,
  PlayerOption,
  ResolvedEmbed,
  SearchResultItem,
  VlcPlaylistEntry,
  WeeklyCalendarResponse,
} from './src/lib/types.ts';
import {
  normalizeTopAnimesUrl,
  pickLatestAnimeEpisode,
} from './src/lib/favoriteAlerts.ts';
import {
  isPrivateOrReservedIp,
  isSafeExternalHttpUrl,
  isTopAnimesUrl,
  unwrapAvisoUrl,
} from './src/lib/urlSafety.ts';
import {
  GITHUB_RELEASES_API_URL,
  GITHUB_RELEASES_LIST_API_URL,
  parseGitHubReleasePayload,
} from './src/lib/appUpdater.ts';
import { buildM3uPlaylist, DEFAULT_BROWSER_UA, sanitizeFilename } from './src/lib/vlc.ts';
import {
  adjustContentRangeForStrip,
  findMpegTsSyncOffset,
  isDisguisedContentType,
  isStartAtZeroRange,
  looksLikeM3u8Manifest,
  TS_PROBE_BUFFER_SIZE,
} from './src/lib/mpegTsUnmask.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const TOPANIMES_ORIGIN = 'https://topanimes.net';

const HOME_SNAPSHOT_PATH = path.join(
  __dirname,
  'public/assets/aistudio/captura-topanimes.net-20261120-185536_c8f54b4e.html'
);
const EPISODE_SNAPSHOT_PATH = path.join(
  __dirname,
  'public/assets/aistudio/captura-topanimes.net-20261120-185622_7446cc49.html'
);
const EPISODES_ARCHIVE_SNAPSHOT_PATH = path.join(
  __dirname,
  'public/assets/aistudio/captura-topanimes.net-20261120-193317_58010c0a.html'
);
const ANIME_ARCHIVE_SNAPSHOT_PATH = path.join(
  __dirname,
  'public/assets/aistudio/captura-topanimes.net-20261120-194623_978b4a6c.html'
);
const MOVIES_ARCHIVE_SNAPSHOT_PATH = path.join(
  __dirname,
  'public/assets/aistudio/captura-topanimes.net-20261120-194902_e963a754.html'
);

let cachedFallbackFilters: CatalogFilters | null = null;
function getFallbackCatalogFilters(): CatalogFilters | undefined {
  if (cachedFallbackFilters) return cachedFallbackFilters;
  if (!fs.existsSync(ANIME_ARCHIVE_SNAPSHOT_PATH)) return undefined;
  const html = fs.readFileSync(ANIME_ARCHIVE_SNAPSHOT_PATH, 'utf8');
  cachedFallbackFilters = parseCatalogArchiveHtml(html, 'anime').filters;
  return cachedFallbackFilters;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const homeCache: { entry: CacheEntry<HomeCatalog> | null } = { entry: null };
const HOME_TTL_MS = 3 * 60 * 1000;
const calendarCache: { entry: CacheEntry<WeeklyCalendarResponse> | null } = { entry: null };
const CALENDAR_TTL_MS = 5 * 60 * 1000;
const nonceCache: { entry: CacheEntry<string> | null } = { entry: null };
const NONCE_TTL_MS = 25 * 60 * 1000;

function rememberDooPlayNonceFromHtml(html: string): string | null {
  const found = extractDooPlayNonce(html);
  if (found) {
    nonceCache.entry = { value: found, expiresAt: Date.now() + NONCE_TTL_MS };
  }
  return found;
}

async function assertPublicTarget(rawUrl: string): Promise<URL> {
  if (!isSafeExternalHttpUrl(rawUrl)) {
    throw new Error('URL externa inválida ou bloqueada por segurança.');
  }
  const parsed = new URL(rawUrl);
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) {
    if (isPrivateOrReservedIp(host)) {
      throw new Error('Endereço IP privado bloqueado.');
    }
    return parsed;
  }

  const records = await dns.lookup(host, { all: true });
  if (!records.length) {
    throw new Error('Não foi possível resolver o host remoto.');
  }
  for (const rec of records) {
    if (isPrivateOrReservedIp(rec.address)) {
      throw new Error('Host resolve para endereço IP privado bloqueado.');
    }
  }
  return parsed;
}

async function safeFetch(
  rawUrl: string,
  options: {
    referer?: string;
    range?: string;
    accept?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    method?: 'GET' | 'POST';
    body?: string;
    contentType?: string;
  } = {}
): Promise<globalThis.Response> {
  let currentUrl = rawUrl;
  let currentMethod: 'GET' | 'POST' = options.method === 'POST' ? 'POST' : 'GET';
  let currentBody = currentMethod === 'POST' ? options.body : undefined;
  const maxRedirects = 4;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const validated = await assertPublicTarget(currentUrl);
    const headers: Record<string, string> = {
      'User-Agent': DEFAULT_BROWSER_UA,
      Accept: options.accept || 'text/html,application/xhtml+xml,application/json,*/*;q=0.9',
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
    };
    // filevideo1.com blocks requests carrying csst.online as Referer (403);
    // tiktokcdn.com does not need Referer and works cleanly without leaking topanimes.net
    const isFileVideo = /filevideo1\.com/i.test(validated.hostname);
    const isTikTokCdn = /(?:^|\.)tiktokcdn\.com$/i.test(validated.hostname);
    if (
      options.referer &&
      isSafeExternalHttpUrl(options.referer) &&
      !(isFileVideo && /csst\.online/i.test(options.referer)) &&
      !isTikTokCdn
    ) {
      headers.Referer = options.referer;
    }
    if (options.range && currentMethod === 'GET') {
      headers.Range = options.range;
    }
    if (currentMethod === 'POST') {
      headers['Content-Type'] =
        options.contentType || 'application/x-www-form-urlencoded; charset=UTF-8';
      headers['X-Requested-With'] = 'XMLHttpRequest';
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
    const onExternalAbort = () => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) {
        clearTimeout(timer);
        throw new Error('Conexão cancelada.');
      }
      options.signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    let res: globalThis.Response;
    try {
      res = await fetch(validated.href, {
        method: currentMethod,
        headers,
        body: currentMethod === 'POST' ? currentBody : undefined,
        redirect: 'manual',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onExternalAbort);
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return res;
      if (res.status !== 307 && res.status !== 308) {
        currentMethod = 'GET';
        currentBody = undefined;
      }
      currentUrl = new URL(loc, validated.href).href;
      continue;
    }

    return res;
  }

  throw new Error('Excesso de redirecionamentos ao acessar fonte externa.');
}

function loadSnapshotCatalog(): HomeCatalog | null {
  if (!fs.existsSync(HOME_SNAPSHOT_PATH)) return null;
  const html = fs.readFileSync(HOME_SNAPSHOT_PATH, 'utf8');
  return parseHomeHtml(html, 'snapshot');
}

async function getHomeCatalog(): Promise<HomeCatalog> {
  if (homeCache.entry && homeCache.entry.expiresAt > Date.now()) {
    return homeCache.entry.value;
  }

  try {
    const res = await safeFetch(`${TOPANIMES_ORIGIN}/`, {
      referer: `${TOPANIMES_ORIGIN}/`,
      timeoutMs: 9000,
    });
    if (res.ok) {
      const html = await res.text();
      rememberDooPlayNonceFromHtml(html);
      const parsed = parseHomeHtml(html, 'live');
      if (parsed.releases.length > 0 || parsed.animes.length > 0) {
        homeCache.entry = { value: parsed, expiresAt: Date.now() + HOME_TTL_MS };
        return parsed;
      }
    }
  } catch {
    // Fallback to local capture snapshot below
  }

  const snapshot = loadSnapshotCatalog();
  if (snapshot) {
    homeCache.entry = { value: snapshot, expiresAt: Date.now() + 60 * 1000 };
    return snapshot;
  }

  throw new Error('Não foi possível carregar o catálogo do TopAnimes.');
}

async function getDooPlayNonce(forceRefresh = false): Promise<string | null> {
  if (!forceRefresh && nonceCache.entry && nonceCache.entry.expiresAt > Date.now()) {
    return nonceCache.entry.value;
  }
  try {
    const res = await safeFetch(`${TOPANIMES_ORIGIN}/`, {
      referer: `${TOPANIMES_ORIGIN}/`,
      timeoutMs: 8000,
    });
    if (res.ok) {
      const html = await res.text();
      return rememberDooPlayNonceFromHtml(html);
    }
  } catch {
    // Ignore nonce fetch errors
  }
  return null;
}

async function getWeeklyCalendar(): Promise<WeeklyCalendarResponse> {
  if (calendarCache.entry && calendarCache.entry.expiresAt > Date.now()) {
    return calendarCache.entry.value;
  }

  try {
    const res = await safeFetch(`${TOPANIMES_ORIGIN}/calendario/`, {
      referer: `${TOPANIMES_ORIGIN}/`,
      timeoutMs: 10000,
    });
    if (res.ok) {
      const html = await res.text();
      rememberDooPlayNonceFromHtml(html);
      const parsed = parseCalendarPageHtml(html, 'live');
      if (parsed.days.length > 0) {
        calendarCache.entry = { value: parsed, expiresAt: Date.now() + CALENDAR_TTL_MS };
        return parsed;
      }
    }
  } catch {
    // Fallback to home calendar below
  }

  const home = await getHomeCatalog();
  const fallback: WeeklyCalendarResponse = {
    days: [
      {
        id: 'hoje',
        label: 'Hoje',
        isToday: true,
        items: home.calendar,
      },
    ],
    sourceMode: 'snapshot',
    fetchedAt: new Date().toISOString(),
  };
  calendarCache.entry = { value: fallback, expiresAt: Date.now() + 60 * 1000 };
  return fallback;
}

async function hydrateEpisodeWithDooPlayAjax(
  html: string,
  pageUrl: string,
  parsed: EpisodeDetails
): Promise<EpisodeDetails> {
  const missing = extractMissingDooPlayerOptions(html);
  if (missing.length === 0) return parsed;

  const cfg = extractDooPlayAjaxConfig(html);
  const existingByNume = new Map<string, PlayerOption>();
  for (const opt of parsed.options) {
    existingByNume.set(opt.nume, opt);
  }

  const hydratedList = await Promise.all(
    missing.map(async (item): Promise<PlayerOption | null> => {
      const preferWpJson = cfg.playMethod === 'wp_json';
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const useWpJson = (attempt === 0) === preferWpJson;
        try {
          let body = '';
          if (useWpJson) {
            const target = `${cfg.playerApi}${encodeURIComponent(item.post)}/${encodeURIComponent(
              item.type
            )}/${encodeURIComponent(item.nume)}`;
            const res = await safeFetch(target, {
              referer: pageUrl,
              accept: 'application/json,text/html,*/*;q=0.9',
              timeoutMs: 8000,
            });
            if (res.ok) body = await res.text();
          } else {
            const formBody = new URLSearchParams({
              action: 'doo_player_ajax',
              post: item.post,
              nume: item.nume,
              type: item.type,
            }).toString();
            const res = await safeFetch(cfg.ajaxUrl, {
              method: 'POST',
              body: formBody,
              referer: pageUrl,
              accept: 'application/json,text/html,*/*;q=0.9',
              timeoutMs: 8000,
            });
            if (res.ok) body = await res.text();
          }

          const embedUrl = parseDooPlayerAjaxResponse(body, pageUrl);
          if (embedUrl) {
            const providerKind = classifyProviderKind(item.label, embedUrl);
            if (providerKind === 'abyss') return null;
            return {
              nume: item.nume,
              label: item.label,
              embedUrl,
              providerKind,
            };
          }
        } catch {
          // Try alternate DooPlay method
        }
      }
      return null;
    })
  );

  let changed = false;
  for (const opt of hydratedList) {
    if (!opt || existingByNume.has(opt.nume)) continue;
    existingByNume.set(opt.nume, opt);
    changed = true;
  }

  if (!changed) return parsed;

  const merged = Array.from(existingByNume.values()).sort((a, b) => {
    const na = Number.parseInt(a.nume, 10);
    const nb = Number.parseInt(b.nume, 10);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return a.nume.localeCompare(b.nume);
  });

  return {
    ...parsed,
    options: merged,
  };
}

async function resolveEmbedUrl(rawEmbedUrl: string): Promise<ResolvedEmbed> {
  const cleanEmbed = unwrapAvisoUrl(rawEmbedUrl) || rawEmbedUrl;
  const baseReferer = `${TOPANIMES_ORIGIN}/`;

  if (!isSafeExternalHttpUrl(cleanEmbed)) {
    return {
      embedUrl: rawEmbedUrl,
      provider: 'Desconhecido',
      status: 'error',
      streams: [],
      subtitles: [],
      referer: baseReferer,
      errorMessage: 'URL do servidor bloqueada ou inválida.',
    };
  }

  // Abyss / short.icu uses encrypted runtime JS challenges
  if (/abyssplayer\.com|abyss\.to|abysscdn\.com|short\.icu/i.test(cleanEmbed)) {
    return {
      embedUrl: cleanEmbed,
      provider: 'aniplay',
      status: 'embed-only',
      streams: [],
      subtitles: [],
      referer: baseReferer,
      errorMessage: 'Servidor indisponível neste player.',
    };
  }

  let fetchTarget = cleanEmbed;
  if (/sk-boyceta\.booonceivu\.shop/i.test(cleanEmbed)) {
    const u = new URL(cleanEmbed);
    u.searchParams.set('mode', 'to-salvando-seu-ip');
    fetchTarget = u.href;
  }

  try {
    const res = await safeFetch(fetchTarget, {
      referer: baseReferer,
      timeoutMs: 12000,
    });
    if (!res.ok) {
      return {
        embedUrl: cleanEmbed,
        provider: 'Servidor',
        status: 'error',
        streams: [],
        subtitles: [],
        referer: baseReferer,
        errorMessage: `Servidor respondeu com HTTP ${res.status}.`,
      };
    }

    const body = await res.text();
    let extracted = extractStreamsFromEmbed(cleanEmbed, body);

    // Some Zuplay entries appear wrapped as csst.online/embed/video/...; fall back to ru-boyceta.booonceivu.shop
    if (!extracted.streams.length) {
      const zuplayPathMatch = cleanEmbed.match(/^https?:\/\/csst\.online\/embed\/(video\/[^?#]+)/i);
      if (zuplayPathMatch?.[1]) {
        const zuplayFallbackUrl = `https://ru-boyceta.booonceivu.shop/?id=${encodeURIComponent(zuplayPathMatch[1])}`;
        const zRes = await safeFetch(zuplayFallbackUrl, {
          referer: baseReferer,
          timeoutMs: 12000,
        });
        if (zRes.ok) {
          extracted = extractStreamsFromEmbed(zuplayFallbackUrl, await zRes.text());
        }
      }
    }

    if (!extracted.streams.length) {
      return {
        embedUrl: cleanEmbed,
        provider: extracted.provider,
        status: 'embed-only',
        streams: [],
        subtitles: extracted.subtitles,
        poster: extracted.poster,
        referer: cleanEmbed,
        errorMessage:
          'Nenhum link direto .m3u8/.mp4 encontrado neste servidor. Tente outro servidor abaixo.',
      };
    }

    const streamReferer = /csst\.online/i.test(cleanEmbed)
      ? 'https://www.incvideo1.online/'
      : /antivirus|booonceivu/i.test(cleanEmbed)
        ? baseReferer
        : cleanEmbed;

    const firstUrl = extracted.streams[0]?.url || '';
    const preferDirect =
      /(?:^|\.)(?:booonceivu\.shop|123flmsfree\.com|321moviesfree\.com|tiktokcdn\.com)$/i.test(
        new URL(firstUrl).hostname
      );

    return {
      embedUrl: cleanEmbed,
      provider: extracted.provider,
      status: 'resolved',
      streams: extracted.streams,
      subtitles: extracted.subtitles,
      poster: extracted.poster,
      referer: streamReferer,
      preferDirect,
    };
  } catch (err) {
    return {
      embedUrl: cleanEmbed,
      provider: 'Servidor',
      status: 'error',
      streams: [],
      subtitles: [],
      referer: baseReferer,
      errorMessage: err instanceof Error ? err.message : 'Falha ao consultar o servidor.',
    };
  }
}

const DIRECT_SEGMENT_HOSTS_RE =
  /(?:^|\.)(?:tiktokcdn\.com|booonceivu\.shop|123flmsfree\.com|321moviesfree\.com)$/i;

function rewriteM3u8Playlist(manifest: string, baseManifestUrl: string, referer: string): string {
  const lines = manifest.split(/\r?\n/);
  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      // Rewrite URI="..." attributes inside #EXT-X-KEY / #EXT-X-MEDIA / #EXT-X-MAP
      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/gi, (_, rawUri: string) => {
          try {
            const abs = new URL(rawUri, baseManifestUrl).href;
            if (!isSafeExternalHttpUrl(abs)) return `URI="${rawUri}"`;
            if (DIRECT_SEGMENT_HOSTS_RE.test(new URL(abs).hostname)) return `URI="${abs}"`;
            const proxied = `/api/stream-proxy?url=${encodeURIComponent(abs)}&referer=${encodeURIComponent(referer)}`;
            return `URI="${proxied}"`;
          } catch {
            return `URI="${rawUri}"`;
          }
        });
      }

      try {
        const abs = new URL(trimmed, baseManifestUrl).href;
        if (!isSafeExternalHttpUrl(abs)) return line;
        if (DIRECT_SEGMENT_HOSTS_RE.test(new URL(abs).hostname)) return abs;
        const isNestedPlaylist = /\.m3u8(?:$|\?)/i.test(abs);
        return `/api/stream-proxy?url=${encodeURIComponent(abs)}&referer=${encodeURIComponent(referer)}${isNestedPlaylist ? '' : '&hls_seg=1'}`;
      } catch {
        return line;
      }
    })
    .join('\n');
}

async function createAppServer(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ ok: true, service: 'topvlc' });
  });

  const apkPath = path.join(__dirname, 'downloads/TopAnimes.apk');

  app.get('/api/apk-info', (_req: Request, res: Response) => {
    if (fs.existsSync(apkPath)) {
      const stat = fs.statSync(apkPath);
      res.json({
        available: true,
        url: '/downloads/TopAnimes.apk',
        filename: 'TopAnimes.apk',
        sizeBytes: stat.size,
      });
      return;
    }
    res.json({ available: false });
  });

  app.get('/downloads/TopAnimes.apk', (_req: Request, res: Response) => {
    if (!fs.existsSync(apkPath)) {
      res.status(404).send('APK ainda não foi gerado.');
      return;
    }
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', 'attachment; filename="TopAnimes.apk"');
    res.sendFile(apkPath);
  });

  app.get('/api/app-update/check', async (_req: Request, res: Response) => {
    try {
      let response = await safeFetch(GITHUB_RELEASES_API_URL, {
        accept: 'application/vnd.github+json',
        timeoutMs: 10000,
      });

      let payload: unknown = null;
      if (response.ok) {
        payload = await response.json();
      } else if (response.status === 404) {
        response = await safeFetch(GITHUB_RELEASES_LIST_API_URL, {
          accept: 'application/vnd.github+json',
          timeoutMs: 10000,
        });
        if (response.ok) {
          const list = (await response.json()) as unknown[];
          payload = Array.isArray(list) ? list[0] : null;
        }
      }

      if (!response.ok && response.status !== 404) {
        res.status(502).json({
          error: `GitHub retornou HTTP ${response.status} ao verificar atualizações.`,
        });
        return;
      }

      const release = parseGitHubReleasePayload(payload);
      res.json({
        checkedAt: new Date().toISOString(),
        release,
      });
    } catch (err) {
      res.status(502).json({
        error:
          err instanceof Error
            ? err.message
            : 'Não foi possível consultar atualizações no GitHub agora.',
      });
    }
  });

  app.get('/api/home', async (_req: Request, res: Response) => {
    try {
      const catalog = await getHomeCatalog();
      res.json(catalog);
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Erro ao carregar catálogo.',
      });
    }
  });

  app.get('/api/calendar', async (_req: Request, res: Response) => {
    try {
      const calendar = await getWeeklyCalendar();
      res.json(calendar);
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Erro ao carregar calendário semanal.',
      });
    }
  });

  app.get('/api/search-suggest', async (req: Request, res: Response) => {
    const query = String(req.query.q || '').trim();
    if (query.length < 2) {
      res.json({ query, results: [], sourceMode: 'live' });
      return;
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const nonce = await getDooPlayNonce(attempt > 0);
        if (!nonce) break;
        const apiUrl = `${TOPANIMES_ORIGIN}/wp-json/dooplay/search/?keyword=${encodeURIComponent(
          query
        )}&nonce=${encodeURIComponent(nonce)}`;
        const response = await safeFetch(apiUrl, {
          referer: `${TOPANIMES_ORIGIN}/`,
          accept: 'application/json,*/*;q=0.9',
          timeoutMs: 7000,
        });
        if (!response.ok) {
          if (attempt === 0) continue;
          break;
        }
        const rawJson = (await response.json()) as Record<string, unknown>;
        if (rawJson && typeof rawJson === 'object' && 'error' in rawJson) {
          if (attempt === 0 && /nonce|invalid|security/i.test(String(rawJson.error || ''))) {
            continue;
          }
          res.json({ query, results: [], sourceMode: 'live' });
          return;
        }
        const results = parseWpSearchJson(
          rawJson as Parameters<typeof parseWpSearchJson>[0]
        ).slice(0, 10);
        res.json({ query, results, sourceMode: 'live' });
        return;
      } catch {
        if (attempt === 0) continue;
      }
    }

    try {
      const catalog = await getHomeCatalog();
      const needle = query.toLowerCase();
      const pool = [...catalog.animes, ...catalog.calendar, ...catalog.movies, ...catalog.releases];
      const seen = new Set<string>();
      const results: SearchResultItem[] = [];
      for (const item of pool) {
        if (seen.has(item.url)) continue;
        if (item.title.toLowerCase().includes(needle)) {
          seen.add(item.url);
          results.push({
            id: item.id,
            title: item.title,
            url: item.url,
            kind: item.kind,
            poster: item.poster,
            year: item.year,
            rating: item.rating,
            audioType: item.audioType,
          });
          if (results.length >= 8) break;
        }
      }
      res.json({ query, results, sourceMode: 'fallback' });
    } catch {
      res.json({ query, results: [], sourceMode: 'fallback' });
    }
  });

  app.get('/api/glossary', async (req: Request, res: Response) => {
    const rawTerm = String(req.query.term || '').trim().toLowerCase();
    const isNumericBucket = rawTerm === '#' || rawTerm === '09' || rawTerm === '0-9';
    const apiTerm = isNumericBucket ? '09' : /^[a-z]$/.test(rawTerm) ? rawTerm : '';
    const displayTerm = isNumericBucket ? '#' : apiTerm.toUpperCase();
    const rawType = String(req.query.type || 'all').trim().toLowerCase();
    const type = ['all', 'tvshows', 'movies'].includes(rawType) ? rawType : 'all';

    if (!apiTerm) {
      res.status(400).json({ error: 'Informe uma letra válida (A-Z ou #).' });
      return;
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const nonce = await getDooPlayNonce(attempt > 0);
        if (!nonce) break;
        const apiUrl = `${TOPANIMES_ORIGIN}/wp-json/dooplay/glossary/?term=${encodeURIComponent(
          apiTerm
        )}&nonce=${encodeURIComponent(nonce)}&type=${encodeURIComponent(type)}`;
        const response = await safeFetch(apiUrl, {
          referer: `${TOPANIMES_ORIGIN}/animes/`,
          accept: 'application/json,*/*;q=0.9',
          timeoutMs: 8000,
        });
        if (!response.ok) {
          if (attempt === 0) continue;
          break;
        }
        const rawJson = (await response.json()) as Record<string, unknown>;
        if (rawJson && typeof rawJson === 'object' && 'error' in rawJson) {
          if (attempt === 0 && /nonce|invalid|security/i.test(String(rawJson.error || ''))) {
            continue;
          }
          res.json({ term: displayTerm, type, items: [], sourceMode: 'live' });
          return;
        }
        const items = parseWpGlossaryJson(rawJson as Parameters<typeof parseWpGlossaryJson>[0]);
        res.json({ term: displayTerm, type, items, sourceMode: 'live' });
        return;
      } catch {
        if (attempt === 0) continue;
      }
    }

    try {
      const catalog = await getHomeCatalog();
      const pool: CatalogMediaItem[] =
        type === 'movies'
          ? catalog.movies
          : type === 'tvshows'
            ? [...catalog.animes, ...catalog.calendar]
            : [...catalog.animes, ...catalog.calendar, ...catalog.movies];
      const seen = new Set<string>();
      const items = pool.filter((item) => {
        if (seen.has(item.url)) return false;
        const firstChar = item.title.trim().charAt(0).toLowerCase();
        const matches = isNumericBucket ? /^[^a-z]$/.test(firstChar) : firstChar === apiTerm;
        if (!matches) return false;
        seen.add(item.url);
        return true;
      });
      res.json({ term: displayTerm, type, items, sourceMode: 'fallback' });
    } catch {
      res.json({ term: displayTerm, type, items: [], sourceMode: 'fallback' });
    }
  });

  app.get('/api/episodes', async (req: Request, res: Response) => {
    const rawPage = Number.parseInt(String(req.query.page || '1'), 10);
    const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
    const targetUrl =
      page > 1
        ? `${TOPANIMES_ORIGIN}/episodio/page/${page}/`
        : `${TOPANIMES_ORIGIN}/episodio/`;

    try {
      const response = await safeFetch(targetUrl, {
        referer: `${TOPANIMES_ORIGIN}/`,
        timeoutMs: 9000,
      });
      if (response.ok) {
        const html = await response.text();
        const parsed = parseEpisodesArchiveHtml(html);
        res.json({ ...parsed, sourceMode: 'live' });
        return;
      }
    } catch {
      // Fallback below
    }

    if (page === 1 && fs.existsSync(EPISODES_ARCHIVE_SNAPSHOT_PATH)) {
      const html = fs.readFileSync(EPISODES_ARCHIVE_SNAPSHOT_PATH, 'utf8');
      const parsed = parseEpisodesArchiveHtml(html);
      res.json({ ...parsed, sourceMode: 'snapshot' });
      return;
    }

    try {
      const home = await getHomeCatalog();
      res.json({
        items: page === 1 ? home.releases : [],
        currentPage: page,
        totalPages: 1,
        sourceMode: 'snapshot',
      });
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Erro ao carregar episódios.',
      });
    }
  });

  app.get('/api/catalog', async (req: Request, res: Response) => {
    const rawCategory = String(req.query.category || 'animes').toLowerCase();
    const validCategories: CatalogArchiveCategory[] = [
      'animes',
      'movies',
      'dublado',
      'legendado',
      'donghua',
      'cartoon',
      'live-action',
    ];
    const category: CatalogArchiveCategory = validCategories.includes(
      rawCategory as CatalogArchiveCategory
    )
      ? (rawCategory as CatalogArchiveCategory)
      : 'animes';

    const rawGenre = String(req.query.genre || '').trim().toLowerCase();
    const genre = /^[a-z0-9-]+$/.test(rawGenre) ? rawGenre : '';
    const rawYear = String(req.query.year || '').trim();
    const year = /^\d{4}$/.test(rawYear) ? rawYear : '';

    const rawPage = Number.parseInt(String(req.query.page || '1'), 10);
    const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;

    const basePathMap: Record<CatalogArchiveCategory, string> = {
      animes: '/animes/',
      movies: '/filmes/',
      dublado: '/tipo/dublado/',
      legendado: '/tipo/legendado/',
      donghua: '/tipo/donghua/',
      cartoon: '/tipo/cartoon/',
      'live-action': '/tipo/live-action/',
    };

    const basePath = genre
      ? `/genero/${genre}/`
      : year
        ? `/l/${year}/`
        : basePathMap[category];

    const targetUrl =
      page > 1
        ? `${TOPANIMES_ORIGIN}${basePath}page/${page}/`
        : `${TOPANIMES_ORIGIN}${basePath}`;

    const defaultKind = !genre && !year && category === 'movies' ? 'movie' : 'anime';
    const forcedAudio =
      !genre && !year && category === 'dublado'
        ? 'DUB'
        : !genre && !year && category === 'legendado'
          ? 'LEG'
          : null;

    try {
      const response = await safeFetch(targetUrl, {
        referer: `${TOPANIMES_ORIGIN}/`,
        timeoutMs: 9000,
      });
      if (response.ok) {
        const html = await response.text();
        const parsed = parseCatalogArchiveHtml(html, defaultKind, forcedAudio);
        const fallbackFilters = getFallbackCatalogFilters();
        const filters =
          parsed.filters.genres.length > 0 ? parsed.filters : fallbackFilters;
        res.json({ ...parsed, filters, sourceMode: 'live' });
        return;
      }
    } catch {
      // Fallback below
    }

    if (!genre && !year && page === 1) {
      if (category === 'animes' && fs.existsSync(ANIME_ARCHIVE_SNAPSHOT_PATH)) {
        const html = fs.readFileSync(ANIME_ARCHIVE_SNAPSHOT_PATH, 'utf8');
        const parsed = parseCatalogArchiveHtml(html, 'anime', null);
        res.json({ ...parsed, sourceMode: 'snapshot' });
        return;
      }
      if (category === 'movies' && fs.existsSync(MOVIES_ARCHIVE_SNAPSHOT_PATH)) {
        const html = fs.readFileSync(MOVIES_ARCHIVE_SNAPSHOT_PATH, 'utf8');
        const parsed = parseCatalogArchiveHtml(html, 'movie', null);
        res.json({
          ...parsed,
          filters: getFallbackCatalogFilters(),
          sourceMode: 'snapshot',
        });
        return;
      }
    }

    try {
      const home = await getHomeCatalog();
      const pool =
        category === 'movies'
          ? home.movies
          : category === 'dublado'
            ? [...home.animes, ...home.calendar].filter((i) => i.audioType === 'DUB')
            : category === 'legendado'
              ? [...home.animes, ...home.calendar].filter((i) => i.audioType !== 'DUB')
              : home.animes;
      res.json({
        items: page === 1 ? pool : [],
        featured: [],
        sliderMovies: [],
        filters: getFallbackCatalogFilters(),
        currentPage: page,
        totalPages: 1,
        sourceMode: 'snapshot',
      });
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Erro ao carregar catálogo.',
      });
    }
  });

  app.get('/api/random', async (_req: Request, res: Response) => {
    try {
      const response = await safeFetch(`${TOPANIMES_ORIGIN}/aleatorio`, {
        referer: `${TOPANIMES_ORIGIN}/`,
        timeoutMs: 8000,
      });
      const finalUrl = normalizeTopAnimesUrl(response.url || '');
      if (
        response.ok &&
        finalUrl &&
        isTopAnimesUrl(finalUrl) &&
        /\/(?:animes|filmes)\/[^/]+/i.test(finalUrl)
      ) {
        res.json({ url: finalUrl, kind: inferMediaKindFromUrl(finalUrl) });
        return;
      }
    } catch {
      // Fallback to random item from catalog
    }

    try {
      const home = await getHomeCatalog();
      const pool = [...home.animes, ...home.movies, ...home.calendar].filter((item) =>
        /\/(?:animes|filmes)\/[^/]+/i.test(item.url)
      );
      if (pool.length > 0) {
        const chosen = pool[Math.floor(Math.random() * pool.length)];
        res.json({ url: chosen.url, kind: chosen.kind });
        return;
      }
    } catch {
      // Fall through to error
    }

    res.status(502).json({ error: 'Não foi possível sortear um anime agora.' });
  });

  app.get('/api/search', async (req: Request, res: Response) => {
    const query = String(req.query.q || '').trim();
    const rawPage = Number.parseInt(String(req.query.page || '1'), 10);
    const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;

    if (!query) {
      res.json({ query: '', results: [], currentPage: 1, totalPages: 1, sourceMode: 'live' });
      return;
    }

    try {
      const searchUrl =
        page > 1
          ? `${TOPANIMES_ORIGIN}/page/${page}/?s=${encodeURIComponent(query)}`
          : `${TOPANIMES_ORIGIN}/?s=${encodeURIComponent(query)}`;
      const response = await safeFetch(searchUrl, {
        referer: `${TOPANIMES_ORIGIN}/`,
        timeoutMs: 9000,
      });
      if (response.ok) {
        const html = await response.text();
        const parsed = parseSearchPageHtml(html);
        res.json({
          query,
          results: parsed.results,
          currentPage: parsed.currentPage,
          totalPages: parsed.totalPages,
          sourceMode: 'live',
        });
        return;
      }
    } catch {
      // Fallback to local catalog filtering
    }

    try {
      const catalog = await getHomeCatalog();
      const needle = query.toLowerCase();
      const pool = [...catalog.releases, ...catalog.animes, ...catalog.calendar, ...catalog.movies];
      const seen = new Set<string>();
      const results: SearchResultItem[] = [];
      for (const item of pool) {
        if (seen.has(item.url)) continue;
        if (
          item.title.toLowerCase().includes(needle) ||
          (item.episodeLabel && item.episodeLabel.toLowerCase().includes(needle))
        ) {
          seen.add(item.url);
          results.push({
            id: item.id,
            title: item.episodeLabel ? `${item.title} — ${item.episodeLabel}` : item.title,
            url: item.url,
            kind: item.kind,
            poster: item.poster,
            year: item.year,
            audioType: item.audioType,
          });
        }
      }
      res.json({
        query,
        results: page === 1 ? results : [],
        currentPage: page,
        totalPages: 1,
        sourceMode: 'snapshot',
      });
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Erro ao buscar no catálogo.',
      });
    }
  });

  app.get('/api/anime', async (req: Request, res: Response) => {
    const url = String(req.query.url || '').trim();
    if (!isTopAnimesUrl(url)) {
      res.status(400).json({ error: 'Informe uma URL válida de topanimes.net.' });
      return;
    }

    try {
      const response = await safeFetch(url, {
        referer: `${TOPANIMES_ORIGIN}/`,
        timeoutMs: 10000,
      });
      if (!response.ok) {
        res.status(response.status).json({ error: `TopAnimes retornou HTTP ${response.status}.` });
        return;
      }
      const html = await response.text();
      const anime = parseAnimePageHtml(html, url);
      res.json(anime);
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Falha ao carregar os episódios do anime.',
      });
    }
  });

  app.post('/api/favorites/check', async (req: Request, res: Response) => {
    const body = req.body as { urls?: unknown };
    const rawUrls = Array.isArray(body?.urls) ? body.urls : [];
    const safeUrls = rawUrls
      .filter((u): u is string => typeof u === 'string' && isTopAnimesUrl(u) && !/\/filmes\//i.test(u))
      .map((u) => normalizeTopAnimesUrl(u))
      .filter((u, idx, arr) => Boolean(u) && arr.indexOf(u) === idx)
      .slice(0, 10);

    const latestByUrl: Record<string, FavoriteLatestInfo> = {};
    for (let i = 0; i < safeUrls.length; i += 3) {
      const chunk = safeUrls.slice(i, i + 3);
      await Promise.all(
        chunk.map(async (animeUrl) => {
          try {
            const response = await safeFetch(animeUrl, {
              referer: `${TOPANIMES_ORIGIN}/`,
              timeoutMs: 7000,
            });
            if (!response.ok) return;
            const html = await response.text();
            const anime = parseAnimePageHtml(html, animeUrl);
            const latest = pickLatestAnimeEpisode(anime.episodes, anime.title, anime.poster);
            if (latest) {
              latestByUrl[animeUrl] = latest;
            }
          } catch {
            // Skip unreachable titles silently
          }
        })
      );
    }

    res.json({ latestByUrl });
  });

  app.get('/api/episode', async (req: Request, res: Response) => {
    const url = String(req.query.url || '').trim();
    if (!isTopAnimesUrl(url)) {
      res.status(400).json({ error: 'Informe uma URL válida de episódio ou filme em topanimes.net.' });
      return;
    }

    try {
      const response = await safeFetch(url, {
        referer: `${TOPANIMES_ORIGIN}/`,
        timeoutMs: 10000,
      });
      if (response.ok) {
        const html = await response.text();
        rememberDooPlayNonceFromHtml(html);
        const parsed = await hydrateEpisodeWithDooPlayAjax(
          html,
          url,
          parseEpisodePageHtml(html, url)
        );
        res.json({ ...parsed, sourceMode: 'live' });
        return;
      }
    } catch {
      // Check snapshot fallback if matches Kusuriya Ep 8
    }

    if (url.includes('kusuriya-no-hitorigoto-3-episodio-8') && fs.existsSync(EPISODE_SNAPSHOT_PATH)) {
      const html = fs.readFileSync(EPISODE_SNAPSHOT_PATH, 'utf8');
      const parsed = parseEpisodePageHtml(html, url);
      res.json({ ...parsed, sourceMode: 'snapshot' });
      return;
    }

    res.status(502).json({ error: 'Não foi possível extrair os servidores deste episódio.' });
  });

  app.get('/api/resolve-embed', async (req: Request, res: Response) => {
    const url = String(req.query.url || '').trim();
    if (!url) {
      res.status(400).json({ error: 'Parâmetro url obrigatório.' });
      return;
    }
    const resolved = await resolveEmbedUrl(url);
    res.json(resolved);
  });

  app.get('/api/playlist.m3u', (req: Request, res: Response) => {
    const streamUrl = String(req.query.streamUrl || '').trim();
    const title = String(req.query.title || 'TopVLC').trim();
    const referer = String(req.query.referer || `${TOPANIMES_ORIGIN}/`).trim();
    const subtitleUrl = String(req.query.subtitleUrl || '').trim();

    if (!isSafeExternalHttpUrl(streamUrl)) {
      res.status(400).json({ error: 'URL de stream inválida.' });
      return;
    }

    const content = buildM3uPlaylist([
      {
        title,
        streamUrl,
        referer: isSafeExternalHttpUrl(referer) ? referer : `${TOPANIMES_ORIGIN}/`,
        subtitleUrl: isSafeExternalHttpUrl(subtitleUrl) ? subtitleUrl : undefined,
      },
    ]);

    const filename = `${sanitizeFilename(title)}.m3u`;
    res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(content);
  });

  app.post('/api/playlist.m3u', (req: Request, res: Response) => {
    const body = req.body as { filename?: string; entries?: VlcPlaylistEntry[] };
    const entries = Array.isArray(body?.entries) ? body.entries : [];
    const safeEntries = entries.filter((e) => e && isSafeExternalHttpUrl(e.streamUrl));

    if (!safeEntries.length) {
      res.status(400).json({ error: 'Nenhuma URL de stream válida enviada para a playlist.' });
      return;
    }

    const content = buildM3uPlaylist(safeEntries);
    const filename = `${sanitizeFilename(body?.filename || 'playlist_topanimes')}.m3u`;
    res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(content);
  });

  app.get('/api/season-m3u', async (req: Request, res: Response) => {
    const animeUrl = String(req.query.url || '').trim();
    if (!isTopAnimesUrl(animeUrl)) {
      res.status(400).json({ error: 'Informe a URL válida de um anime em topanimes.net.' });
      return;
    }

    try {
      const animeRes = await safeFetch(animeUrl, { referer: `${TOPANIMES_ORIGIN}/`, timeoutMs: 10000 });
      if (!animeRes.ok) {
        res.status(animeRes.status).json({ error: 'Falha ao carregar lista de episódios.' });
        return;
      }
      const anime = parseAnimePageHtml(await animeRes.text(), animeUrl);
      const batch = anime.episodes.slice(0, 30);
      const entries: VlcPlaylistEntry[] = [];

      // Process in small chunks of 4 to avoid hammering upstream
      for (let i = 0; i < batch.length; i += 4) {
        const chunk = batch.slice(i, i + 4);
        const resolvedChunk = await Promise.all(
          chunk.map(async (ep) => {
            try {
              const epRes = await safeFetch(ep.url, { referer: animeUrl, timeoutMs: 9000 });
              if (!epRes.ok) return null;
              const details = parseEpisodePageHtml(await epRes.text(), ep.url);
              const preferred = details.options.filter((o) =>
                ['kojima', 'zuplay', 'vidstreaming', 'playerjs'].includes(o.providerKind)
              );
              const ordered = [...preferred, ...details.options.filter((o) => !preferred.includes(o))];
              for (const opt of ordered) {
                const resolved = await resolveEmbedUrl(opt.embedUrl);
                if (resolved.streams.length) {
                  return {
                    title: `${anime.title} — ${ep.title}`,
                    streamUrl: resolved.streams[0].url,
                    referer: resolved.referer,
                    subtitleUrl: resolved.subtitles[0]?.url,
                  } satisfies VlcPlaylistEntry;
                }
              }
            } catch {
              return null;
            }
            return null;
          })
        );
        for (const item of resolvedChunk) {
          if (item) entries.push(item);
        }
      }

      if (!entries.length) {
        res.status(404).json({ error: 'Nenhum stream compatível foi encontrado para esta temporada.' });
        return;
      }

      const content = buildM3uPlaylist(entries);
      const filename = `${sanitizeFilename(anime.title)}_temporada.m3u`;
      res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(content);
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Erro ao montar playlist da temporada.',
      });
    }
  });

  const PROXY_RANGE_CHUNK_BYTES = 4 * 1024 * 1024; // Keep responses well under Cloud Run's 32 MiB HTTP/1.1 cap

  app.get('/api/stream-proxy', async (req: Request, res: Response) => {
    const targetUrl = String(req.query.url || '').trim();
    const refererParam = String(req.query.referer || `${TOPANIMES_ORIGIN}/`).trim();
    const referer = isSafeExternalHttpUrl(refererParam) ? refererParam : `${TOPANIMES_ORIGIN}/`;
    const isDownload = String(req.query.download || '') === '1';
    const isHlsSegment = String(req.query.hls_seg || '') === '1';

    if (!isSafeExternalHttpUrl(targetUrl)) {
      res.status(400).send('URL inválida');
      return;
    }

    const streamAbort = new AbortController();
    req.on('close', () => {
      if (!res.writableEnded) streamAbort.abort();
    });

    try {
      let rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : undefined;
      if (!isDownload && rangeHeader) {
        const rangeMatch = rangeHeader.match(/^bytes=(\d+)-(\d*)$/i);
        if (rangeMatch) {
          const start = Number.parseInt(rangeMatch[1], 10);
          const rawEnd = rangeMatch[2] ? Number.parseInt(rangeMatch[2], 10) : null;
          const maxEnd = start + PROXY_RANGE_CHUNK_BYTES - 1;
          const clampedEnd = rawEnd === null ? maxEnd : Math.min(rawEnd, maxEnd);
          rangeHeader = `bytes=${start}-${clampedEnd}`;
        }
      }

      const upstream = await safeFetch(targetUrl, {
        referer,
        range: rangeHeader,
        accept: '*/*',
        timeoutMs: 20000,
        signal: streamAbort.signal,
      });

      const contentType = upstream.headers.get('content-type') || '';
      const isPlaylist =
        /mpegurl|m3u8/i.test(contentType) || /\.m3u8(?:$|\?)/i.test(targetUrl);

      if (isPlaylist && upstream.ok) {
        const text = await upstream.text();
        const rewritten = rewriteM3u8Playlist(text, upstream.url || targetUrl, referer);
        res.status(200);
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(rewritten);
        return;
      }

      const shouldProbeTs =
        upstream.ok &&
        !isDownload &&
        Boolean(upstream.body) &&
        isStartAtZeroRange(rangeHeader) &&
        (isHlsSegment || isDisguisedContentType(contentType));

      if (shouldProbeTs && upstream.body) {
        const reader = upstream.body.getReader();
        const onAbort = () => {
          reader.cancel().catch(() => {});
        };
        streamAbort.signal.addEventListener('abort', onAbort, { once: true });

        try {
          const probeChunks: Buffer[] = [];
          let bufferedLen = 0;
          let reachedEof = false;

          while (bufferedLen < TS_PROBE_BUFFER_SIZE) {
            const { done, value } = await reader.read();
            if (done) {
              reachedEof = true;
              break;
            }
            if (value && value.byteLength > 0) {
              const chunkBuf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
              probeChunks.push(chunkBuf);
              bufferedLen += chunkBuf.length;
            }
          }

          const initialBuf = Buffer.concat(probeChunks, bufferedLen);

          if (looksLikeM3u8Manifest(initialBuf, Math.min(initialBuf.length, TS_PROBE_BUFFER_SIZE))) {
            const restChunks: Buffer[] = [initialBuf];
            if (!reachedEof) {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value && value.byteLength > 0) {
                  restChunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
                }
              }
            }
            const rawManifest = Buffer.concat(restChunks).toString('utf8');
            const rewritten = rewriteM3u8Playlist(rawManifest, upstream.url || targetUrl, referer);
            res.status(200);
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.send(rewritten);
            return;
          }

          const tsOffset = findMpegTsSyncOffset(initialBuf, initialBuf.length, reachedEof);
          let outStatus = upstream.status;
          let outContentType = contentType || 'application/octet-stream';
          const rawLength = upstream.headers.get('content-length');
          let outContentLength = rawLength ? Number.parseInt(rawLength, 10) : -1;
          if (!Number.isFinite(outContentLength)) outContentLength = -1;
          let outContentRange = upstream.headers.get('content-range');
          let outAcceptRanges = upstream.headers.get('accept-ranges');

          if (tsOffset >= 0) {
            outContentType = 'video/mp2t';
            if (tsOffset > 0) {
              if (outContentLength >= tsOffset) {
                outContentLength -= tsOffset;
              } else if (outContentLength >= 0) {
                outContentLength = -1;
              }
              if (outStatus === 206) {
                const adjusted = adjustContentRangeForStrip(outContentRange, tsOffset);
                if (adjusted) {
                  outContentRange = adjusted;
                } else {
                  outStatus = 200;
                  outContentRange = null;
                }
              }
              outAcceptRanges = null;
            }
          }

          res.status(outStatus);
          res.setHeader('Content-Type', outContentType);
          if (outContentLength >= 0) res.setHeader('Content-Length', String(outContentLength));
          if (outContentRange) res.setHeader('Content-Range', outContentRange);
          if (outAcceptRanges) res.setHeader('Accept-Ranges', outAcceptRanges);
          res.setHeader('Access-Control-Allow-Origin', '*');

          const firstSlice = tsOffset > 0 ? initialBuf.subarray(tsOffset) : initialBuf;
          if (firstSlice.length > 0 && !res.write(firstSlice)) {
            await new Promise<void>((resolve) => res.once('drain', resolve));
          }

          if (!reachedEof) {
            while (!streamAbort.signal.aborted && !res.writableEnded) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value && value.byteLength > 0) {
                const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
                if (!res.write(buf)) {
                  await new Promise<void>((resolve) => res.once('drain', resolve));
                }
              }
            }
          }
          if (!res.writableEnded) res.end();
          return;
        } finally {
          streamAbort.signal.removeEventListener('abort', onAbort);
          reader.releaseLock();
        }
      }

      res.status(upstream.status);
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        const val = upstream.headers.get(h);
        if (val) res.setHeader(h, val);
      }
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (isDownload) {
        res.setHeader('Content-Disposition', 'attachment');
      }

      if (!upstream.body) {
        res.end();
        return;
      }

      const nodeStream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
      nodeStream.on('error', () => {
        if (!res.headersSent) res.status(502);
        res.end();
      });
      nodeStream.pipe(res);
    } catch (err) {
      if (!res.headersSent && !streamAbort.signal.aborted) {
        res.status(502).send(err instanceof Error ? err.message : 'Erro no proxy de mídia');
      }
    }
  });

  const httpServer = http.createServer(app);

  if (process.env.NODE_ENV !== 'production') {
    const disableHmr = process.env.DISABLE_HMR === 'true';
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: !disableHmr,
        ws: disableHmr ? false : { server: httpServer },
      },
      appType: 'custom',
    });
    app.use(vite.middlewares);

    app.use(async (req: Request, res: Response, next) => {
      if (req.originalUrl.startsWith('/api/')) {
        next();
        return;
      }
      try {
        const templatePath = path.resolve(__dirname, 'index.html');
        let html = fs.readFileSync(templatePath, 'utf-8');
        html = await vite.transformIndexHtml(req.originalUrl, html);
        if (disableHmr) {
          html = html.replace(/<script\s+type="module"\s+src="\/@vite\/client"><\/script>\s*/i, '');
        }
        res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
      } catch (e) {
        vite.ssrFixStacktrace(e as Error);
        next(e);
      }
    });
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`TopVLC server running on http://0.0.0.0:${PORT}`);
  });
}

createAppServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
