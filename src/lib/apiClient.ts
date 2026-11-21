import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import {
  GITHUB_RELEASES_API_URL,
  GITHUB_RELEASES_LIST_API_URL,
  isAllowedGitHubDownloadUrl,
  normalizeSha256Digest,
  parseGitHubReleasePayload,
  type ApkDownloadProgressState,
} from './appUpdater';
import {
  normalizeTopAnimesUrl,
  pickLatestAnimeEpisode,
} from './favoriteAlerts';
import {
  extractStreamsFromEmbed,
  inferMediaKindFromUrl,
  parseAnimePageHtml,
  parseCatalogArchiveHtml,
  parseEpisodePageHtml,
  parseEpisodesArchiveHtml,
  parseHomeHtml,
  parseSearchPageHtml,
} from './topanimesParser';
import type {
  CatalogArchiveCategory,
  CatalogFilters,
  FavoriteLatestInfo,
  HomeCatalog,
  ResolvedEmbed,
  SearchResultItem,
} from './types';
import { isSafeExternalHttpUrl, isTopAnimesUrl, unwrapAvisoUrl } from './urlSafety';

export interface NativeFetchPageOptions {
  url: string;
  referer?: string;
  accept?: string;
  timeoutMs?: number;
}

export interface NativeFetchPageResult {
  status: number;
  ok: boolean;
  finalUrl: string;
  body: string;
}

export interface NativeAppBuildInfoResult {
  versionName: string;
  versionCode: number;
}

export type ApkDownloadProgressEvent = ApkDownloadProgressState;

export interface LocalProxyPlugin {
  getProxyBaseUrl(): Promise<{ baseUrl: string }>;
  fetchPage(options: NativeFetchPageOptions): Promise<NativeFetchPageResult>;
  openExternalUrl(options: { url: string }): Promise<{ opened: boolean }>;
  getAppBuildInfo(): Promise<NativeAppBuildInfoResult>;
  downloadAndInstallApk(options: {
    url: string;
    filename?: string;
    expectedSha256?: string;
  }): Promise<{ started: boolean; cancelled?: boolean; needsPermission?: boolean; message?: string }>;
  cancelApkDownload(): Promise<{ cancelled: boolean }>;
  addListener(
    eventName: 'apkDownloadProgress',
    listenerFunc: (event: ApkDownloadProgressEvent) => void
  ): Promise<PluginListenerHandle>;
}

const LocalProxy = registerPlugin<LocalProxyPlugin>('LocalProxy');

const TOPANIMES_ORIGIN = 'https://topanimes.net';
const HOME_SNAPSHOT_URL = '/assets/aistudio/captura-topanimes.net-20261120-185536_c8f54b4e.html';
const EPISODE_SNAPSHOT_URL = '/assets/aistudio/captura-topanimes.net-20261120-185622_7446cc49.html';
const EPISODES_ARCHIVE_SNAPSHOT_URL = '/assets/aistudio/captura-topanimes.net-20261120-193317_58010c0a.html';
const ANIME_ARCHIVE_SNAPSHOT_URL = '/assets/aistudio/captura-topanimes.net-20261120-194623_978b4a6c.html';
const MOVIES_ARCHIVE_SNAPSHOT_URL = '/assets/aistudio/captura-topanimes.net-20261120-194902_e963a754.html';

let cachedProxyBaseUrl = '';
let cachedHome: { value: HomeCatalog; expiresAt: number } | null = null;
let cachedFallbackFilters: CatalogFilters | null = null;

export function isNativeAndroidApp(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
  } catch {
    return false;
  }
}

export async function initApiClient(): Promise<void> {
  if (!isNativeAndroidApp()) return;
  try {
    const res = await LocalProxy.getProxyBaseUrl();
    if (res?.baseUrl) {
      cachedProxyBaseUrl = res.baseUrl.replace(/\/+$/, '');
    }
  } catch {
    // Fallback will retry lazily when needed
  }
}

async function ensureProxyBaseUrl(): Promise<string> {
  if (cachedProxyBaseUrl) return cachedProxyBaseUrl;
  if (!isNativeAndroidApp()) return '';
  try {
    const res = await LocalProxy.getProxyBaseUrl();
    if (res?.baseUrl) {
      cachedProxyBaseUrl = res.baseUrl.replace(/\/+$/, '');
      return cachedProxyBaseUrl;
    }
  } catch {
    // Ignore
  }
  return '';
}

export function getStreamProxyUrl(targetUrl: string, referer = `${TOPANIMES_ORIGIN}/`): string {
  const params = new URLSearchParams({
    url: targetUrl,
    referer: referer || `${TOPANIMES_ORIGIN}/`,
  });
  if (isNativeAndroidApp() && cachedProxyBaseUrl) {
    return `${cachedProxyBaseUrl}/stream-proxy?${params.toString()}`;
  }
  return `/api/stream-proxy?${params.toString()}`;
}

export async function getStreamProxyUrlAsync(
  targetUrl: string,
  referer = `${TOPANIMES_ORIGIN}/`
): Promise<string> {
  if (isNativeAndroidApp() && !cachedProxyBaseUrl) {
    await ensureProxyBaseUrl();
  }
  return getStreamProxyUrl(targetUrl, referer);
}

export async function openExternalOrVlcUrl(url: string): Promise<boolean> {
  if (isNativeAndroidApp()) {
    try {
      const res = await LocalProxy.openExternalUrl({ url });
      return Boolean(res?.opened);
    } catch {
      return false;
    }
  }
  window.location.href = url;
  return true;
}

export async function getNativeAppBuildInfo(): Promise<NativeAppBuildInfoResult | null> {
  if (!isNativeAndroidApp()) return null;
  try {
    return await LocalProxy.getAppBuildInfo();
  } catch {
    return null;
  }
}

export async function addApkDownloadProgressListener(
  listener: (event: ApkDownloadProgressEvent) => void
): Promise<PluginListenerHandle | null> {
  if (!isNativeAndroidApp()) return null;
  try {
    return await LocalProxy.addListener('apkDownloadProgress', listener);
  } catch {
    return null;
  }
}

export async function cancelAppUpdateDownload(): Promise<boolean> {
  if (!isNativeAndroidApp()) return false;
  try {
    const res = await LocalProxy.cancelApkDownload();
    return Boolean(res?.cancelled);
  } catch {
    return false;
  }
}

export async function downloadAppUpdateApk(
  downloadUrl: string,
  filename = 'TopAnimes.apk',
  expectedSha256?: string
): Promise<{
  mode: 'native-installer' | 'permission-required' | 'browser-download' | 'cancelled';
  message?: string;
}> {
  if (!isAllowedGitHubDownloadUrl(downloadUrl)) {
    throw new Error('URL de download do GitHub inválida ou não permitida.');
  }
  if (isNativeAndroidApp()) {
    const cleanSha256 = normalizeSha256Digest(expectedSha256);
    const res = await LocalProxy.downloadAndInstallApk({
      url: downloadUrl,
      filename,
      expectedSha256: cleanSha256 || undefined,
    });
    if (res?.cancelled) {
      return {
        mode: 'cancelled',
        message: res.message || 'Atualização cancelada.',
      };
    }
    if (res?.needsPermission) {
      return {
        mode: 'permission-required',
        message:
          res.message ||
          "Ative 'Permitir desta fonte' nas configurações do Android e tente novamente.",
      };
    }
    return { mode: 'native-installer' };
  }

  const anchor = document.createElement('a');
  anchor.href = downloadUrl;
  anchor.download = filename;
  anchor.rel = 'noopener noreferrer';
  anchor.target = '_blank';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  return { mode: 'browser-download' };
}

export interface ApiJsonResponse {
  status: number;
  body: unknown;
}

export type PageFetcher = (
  url: string,
  options?: { referer?: string; accept?: string; timeoutMs?: number }
) => Promise<NativeFetchPageResult>;

export type SnapshotFetcher = (assetPath: string) => Promise<string | null>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

async function defaultSnapshotFetcher(assetPath: string): Promise<string | null> {
  try {
    const res = await window.fetch(assetPath);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function nativePageFetcher(
  url: string,
  options: { referer?: string; accept?: string; timeoutMs?: number } = {}
): Promise<NativeFetchPageResult> {
  if (!isSafeExternalHttpUrl(url)) {
    throw new Error('URL externa inválida ou bloqueada por segurança.');
  }
  return LocalProxy.fetchPage({
    url,
    referer: options.referer,
    accept: options.accept,
    timeoutMs: options.timeoutMs,
  });
}

async function getFallbackCatalogFilters(
  readSnapshot: SnapshotFetcher
): Promise<CatalogFilters | undefined> {
  if (cachedFallbackFilters) return cachedFallbackFilters;
  const html = await readSnapshot(ANIME_ARCHIVE_SNAPSHOT_URL);
  if (!html) return undefined;
  cachedFallbackFilters = parseCatalogArchiveHtml(html, 'anime').filters;
  return cachedFallbackFilters;
}

async function getNativeHomeCatalog(
  fetchPage: PageFetcher,
  readSnapshot: SnapshotFetcher
): Promise<HomeCatalog> {
  if (cachedHome && cachedHome.expiresAt > Date.now()) {
    return cachedHome.value;
  }

  try {
    const res = await fetchPage(`${TOPANIMES_ORIGIN}/`, {
      referer: `${TOPANIMES_ORIGIN}/`,
      timeoutMs: 9000,
    });
    if (res.ok) {
      const parsed = parseHomeHtml(res.body, 'live');
      if (parsed.releases.length > 0 || parsed.animes.length > 0) {
        cachedHome = { value: parsed, expiresAt: Date.now() + 3 * 60 * 1000 };
        return parsed;
      }
    }
  } catch {
    // Fall back to bundled snapshot
  }

  const snapHtml = await readSnapshot(HOME_SNAPSHOT_URL);
  if (snapHtml) {
    const parsed = parseHomeHtml(snapHtml, 'snapshot');
    cachedHome = { value: parsed, expiresAt: Date.now() + 60 * 1000 };
    return parsed;
  }

  throw new Error('Não foi possível carregar o catálogo do TopAnimes.');
}

async function resolveNativeEmbedUrl(
  rawEmbedUrl: string,
  fetchPage: PageFetcher
): Promise<ResolvedEmbed> {
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
    const res = await fetchPage(fetchTarget, {
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

    let extracted = extractStreamsFromEmbed(cleanEmbed, res.body);

    if (!extracted.streams.length) {
      const zuplayPathMatch = cleanEmbed.match(/^https?:\/\/csst\.online\/embed\/(video\/[^?#]+)/i);
      if (zuplayPathMatch?.[1]) {
        const zuplayFallbackUrl = `https://ru-boyceta.booonceivu.shop/?id=${encodeURIComponent(zuplayPathMatch[1])}`;
        const zRes = await fetchPage(zuplayFallbackUrl, {
          referer: baseReferer,
          timeoutMs: 12000,
        });
        if (zRes.ok) {
          extracted = extractStreamsFromEmbed(zuplayFallbackUrl, zRes.body);
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

export async function routeNativeApiRequest(
  pathWithQuery: string,
  init: RequestInit | undefined,
  deps: {
    fetchPage?: PageFetcher;
    readSnapshot?: SnapshotFetcher;
  } = {}
): Promise<ApiJsonResponse> {
  const fetchPage = deps.fetchPage || nativePageFetcher;
  const readSnapshot = deps.readSnapshot || defaultSnapshotFetcher;
  const url = new URL(pathWithQuery, 'http://localhost');
  const pathname = url.pathname;

  if (pathname === '/api/health') {
    return { status: 200, body: { ok: true, service: 'topvlc-android' } };
  }

  if (pathname === '/api/apk-info') {
    return { status: 200, body: { available: false } };
  }

  if (pathname === '/api/app-update/check') {
    try {
      let response = await fetchPage(GITHUB_RELEASES_API_URL, {
        accept: 'application/vnd.github+json',
        timeoutMs: 10000,
      });

      let payload: unknown = null;
      if (response.ok) {
        payload = JSON.parse(response.body);
      } else if (response.status === 404) {
        response = await fetchPage(GITHUB_RELEASES_LIST_API_URL, {
          accept: 'application/vnd.github+json',
          timeoutMs: 10000,
        });
        if (response.ok) {
          const list = JSON.parse(response.body) as unknown[];
          payload = Array.isArray(list) ? list[0] : null;
        }
      }

      if (!response.ok && response.status !== 404) {
        return {
          status: 502,
          body: { error: `GitHub retornou HTTP ${response.status} ao verificar atualizações.` },
        };
      }

      return {
        status: 200,
        body: {
          checkedAt: new Date().toISOString(),
          release: parseGitHubReleasePayload(payload),
        },
      };
    } catch (err) {
      return {
        status: 502,
        body: {
          error:
            err instanceof Error
              ? err.message
              : 'Não foi possível consultar atualizações no GitHub agora.',
        },
      };
    }
  }

  if (pathname === '/api/home') {
    try {
      const catalog = await getNativeHomeCatalog(fetchPage, readSnapshot);
      return { status: 200, body: catalog };
    } catch (err) {
      return {
        status: 502,
        body: { error: err instanceof Error ? err.message : 'Erro ao carregar catálogo.' },
      };
    }
  }

  if (pathname === '/api/episodes') {
    const rawPage = Number.parseInt(url.searchParams.get('page') || '1', 10);
    const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
    const targetUrl =
      page > 1
        ? `${TOPANIMES_ORIGIN}/episodio/page/${page}/`
        : `${TOPANIMES_ORIGIN}/episodio/`;

    try {
      const response = await fetchPage(targetUrl, {
        referer: `${TOPANIMES_ORIGIN}/`,
        timeoutMs: 9000,
      });
      if (response.ok) {
        const parsed = parseEpisodesArchiveHtml(response.body);
        return { status: 200, body: { ...parsed, sourceMode: 'live' } };
      }
    } catch {
      // Fall back below
    }

    if (page === 1) {
      const snapHtml = await readSnapshot(EPISODES_ARCHIVE_SNAPSHOT_URL);
      if (snapHtml) {
        const parsed = parseEpisodesArchiveHtml(snapHtml);
        return { status: 200, body: { ...parsed, sourceMode: 'snapshot' } };
      }
    }

    try {
      const home = await getNativeHomeCatalog(fetchPage, readSnapshot);
      return {
        status: 200,
        body: {
          items: page === 1 ? home.releases : [],
          currentPage: page,
          totalPages: 1,
          sourceMode: 'snapshot',
        },
      };
    } catch (err) {
      return {
        status: 502,
        body: { error: err instanceof Error ? err.message : 'Erro ao carregar episódios.' },
      };
    }
  }

  if (pathname === '/api/catalog') {
    const rawCategory = (url.searchParams.get('category') || 'animes').toLowerCase();
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

    const rawGenre = (url.searchParams.get('genre') || '').trim().toLowerCase();
    const genre = /^[a-z0-9-]+$/.test(rawGenre) ? rawGenre : '';
    const rawYear = (url.searchParams.get('year') || '').trim();
    const year = /^\d{4}$/.test(rawYear) ? rawYear : '';
    const rawPage = Number.parseInt(url.searchParams.get('page') || '1', 10);
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
      const response = await fetchPage(targetUrl, {
        referer: `${TOPANIMES_ORIGIN}/`,
        timeoutMs: 9000,
      });
      if (response.ok) {
        const parsed = parseCatalogArchiveHtml(response.body, defaultKind, forcedAudio);
        const fallbackFilters = await getFallbackCatalogFilters(readSnapshot);
        const filters =
          parsed.filters.genres.length > 0 ? parsed.filters : fallbackFilters;
        return { status: 200, body: { ...parsed, filters, sourceMode: 'live' } };
      }
    } catch {
      // Fall back below
    }

    if (!genre && !year && page === 1) {
      if (category === 'animes') {
        const html = await readSnapshot(ANIME_ARCHIVE_SNAPSHOT_URL);
        if (html) {
          const parsed = parseCatalogArchiveHtml(html, 'anime', null);
          return { status: 200, body: { ...parsed, sourceMode: 'snapshot' } };
        }
      }
      if (category === 'movies') {
        const html = await readSnapshot(MOVIES_ARCHIVE_SNAPSHOT_URL);
        if (html) {
          const parsed = parseCatalogArchiveHtml(html, 'movie', null);
          return {
            status: 200,
            body: {
              ...parsed,
              filters: await getFallbackCatalogFilters(readSnapshot),
              sourceMode: 'snapshot',
            },
          };
        }
      }
    }

    try {
      const home = await getNativeHomeCatalog(fetchPage, readSnapshot);
      const pool =
        category === 'movies'
          ? home.movies
          : category === 'dublado'
            ? [...home.animes, ...home.calendar].filter((i) => i.audioType === 'DUB')
            : category === 'legendado'
              ? [...home.animes, ...home.calendar].filter((i) => i.audioType !== 'DUB')
              : home.animes;
      return {
        status: 200,
        body: {
          items: page === 1 ? pool : [],
          featured: [],
          sliderMovies: [],
          filters: await getFallbackCatalogFilters(readSnapshot),
          currentPage: page,
          totalPages: 1,
          sourceMode: 'snapshot',
        },
      };
    } catch (err) {
      return {
        status: 502,
        body: { error: err instanceof Error ? err.message : 'Erro ao carregar catálogo.' },
      };
    }
  }

  if (pathname === '/api/random') {
    try {
      const response = await fetchPage(`${TOPANIMES_ORIGIN}/aleatorio`, {
        referer: `${TOPANIMES_ORIGIN}/`,
        timeoutMs: 8000,
      });
      const finalUrl = normalizeTopAnimesUrl(response.finalUrl || '');
      if (
        response.ok &&
        finalUrl &&
        isTopAnimesUrl(finalUrl) &&
        /\/(?:animes|filmes)\/[^/]+/i.test(finalUrl)
      ) {
        return { status: 200, body: { url: finalUrl, kind: inferMediaKindFromUrl(finalUrl) } };
      }
    } catch {
      // Fallback below
    }

    try {
      const home = await getNativeHomeCatalog(fetchPage, readSnapshot);
      const pool = [...home.animes, ...home.movies, ...home.calendar].filter((item) =>
        /\/(?:animes|filmes)\/[^/]+/i.test(item.url)
      );
      if (pool.length > 0) {
        const chosen = pool[Math.floor(Math.random() * pool.length)];
        return { status: 200, body: { url: chosen.url, kind: chosen.kind } };
      }
    } catch {
      // Fall through
    }

    return { status: 502, body: { error: 'Não foi possível sortear um anime agora.' } };
  }

  if (pathname === '/api/search') {
    const query = (url.searchParams.get('q') || '').trim();
    const rawPage = Number.parseInt(url.searchParams.get('page') || '1', 10);
    const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;

    if (!query) {
      return {
        status: 200,
        body: { query: '', results: [], currentPage: 1, totalPages: 1, sourceMode: 'live' },
      };
    }

    try {
      const searchUrl =
        page > 1
          ? `${TOPANIMES_ORIGIN}/page/${page}/?s=${encodeURIComponent(query)}`
          : `${TOPANIMES_ORIGIN}/?s=${encodeURIComponent(query)}`;
      const response = await fetchPage(searchUrl, {
        referer: `${TOPANIMES_ORIGIN}/`,
        timeoutMs: 9000,
      });
      if (response.ok) {
        const parsed = parseSearchPageHtml(response.body);
        return {
          status: 200,
          body: {
            query,
            results: parsed.results,
            currentPage: parsed.currentPage,
            totalPages: parsed.totalPages,
            sourceMode: 'live',
          },
        };
      }
    } catch {
      // Fallback below
    }

    try {
      const catalog = await getNativeHomeCatalog(fetchPage, readSnapshot);
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
      return {
        status: 200,
        body: {
          query,
          results: page === 1 ? results : [],
          currentPage: page,
          totalPages: 1,
          sourceMode: 'snapshot',
        },
      };
    } catch (err) {
      return {
        status: 502,
        body: { error: err instanceof Error ? err.message : 'Erro ao buscar no catálogo.' },
      };
    }
  }

  if (pathname === '/api/anime') {
    const target = (url.searchParams.get('url') || '').trim();
    if (!isTopAnimesUrl(target)) {
      return { status: 400, body: { error: 'Informe uma URL válida de topanimes.net.' } };
    }
    try {
      const response = await fetchPage(target, {
        referer: `${TOPANIMES_ORIGIN}/`,
        timeoutMs: 10000,
      });
      if (!response.ok) {
        return { status: response.status, body: { error: `TopAnimes retornou HTTP ${response.status}.` } };
      }
      return { status: 200, body: parseAnimePageHtml(response.body, target) };
    } catch (err) {
      return {
        status: 502,
        body: { error: err instanceof Error ? err.message : 'Falha ao carregar os episódios do anime.' },
      };
    }
  }

  if (pathname === '/api/favorites/check') {
    let rawUrls: unknown[] = [];
    if (typeof init?.body === 'string') {
      try {
        const parsed = JSON.parse(init.body) as { urls?: unknown };
        if (Array.isArray(parsed?.urls)) rawUrls = parsed.urls;
      } catch {
        // ignore invalid body
      }
    }
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
            const response = await fetchPage(animeUrl, {
              referer: `${TOPANIMES_ORIGIN}/`,
              timeoutMs: 7000,
            });
            if (!response.ok) return;
            const anime = parseAnimePageHtml(response.body, animeUrl);
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

    return { status: 200, body: { latestByUrl } };
  }

  if (pathname === '/api/episode') {
    const target = (url.searchParams.get('url') || '').trim();
    if (!isTopAnimesUrl(target)) {
      return {
        status: 400,
        body: { error: 'Informe uma URL válida de episódio ou filme em topanimes.net.' },
      };
    }

    try {
      const response = await fetchPage(target, {
        referer: `${TOPANIMES_ORIGIN}/`,
        timeoutMs: 10000,
      });
      if (response.ok) {
        const parsed = parseEpisodePageHtml(response.body, target);
        return { status: 200, body: { ...parsed, sourceMode: 'live' } };
      }
    } catch {
      // Check snapshot fallback below
    }

    if (target.includes('kusuriya-no-hitorigoto-3-episodio-8')) {
      const snapHtml = await readSnapshot(EPISODE_SNAPSHOT_URL);
      if (snapHtml) {
        const parsed = parseEpisodePageHtml(snapHtml, target);
        return { status: 200, body: { ...parsed, sourceMode: 'snapshot' } };
      }
    }

    return { status: 502, body: { error: 'Não foi possível extrair os servidores deste episódio.' } };
  }

  if (pathname === '/api/resolve-embed') {
    const target = (url.searchParams.get('url') || '').trim();
    if (!target) {
      return { status: 400, body: { error: 'Parâmetro url obrigatório.' } };
    }
    const resolved = await resolveNativeEmbedUrl(target, fetchPage);
    return { status: 200, body: resolved };
  }

  return { status: 404, body: { error: `Rota desconhecida: ${pathname}` } };
}

export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  if (!isNativeAndroidApp() || !input.startsWith('/api/')) {
    return window.fetch(input, init);
  }
  await ensureProxyBaseUrl();
  const result = await routeNativeApiRequest(input, init);
  return jsonResponse(result.body, result.status);
}
