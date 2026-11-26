import type { HttpFetcher } from '../../httpTypes.ts';
import { isAbyssEmbedUrl } from '../../abyssDecoder.ts';
import {
  classifyProviderKind,
  extractDooPlayAjaxConfig,
  extractDooPlayNonce,
  extractMissingDooPlayerOptions,
  extractStreamsFromEmbed,
  formatServerLabel,
  isMixDropEmbedUrl,
  parseAnimePageHtml,
  parseDooPlayerAjaxResponse,
  parseEpisodePageHtml,
  parseSearchPageHtml,
  parseWpSearchJson,
} from '../../topanimesParser.ts';
import { extractHinataSoulSeasonNumber } from '../../hinatasoulParser.ts';
import type { AnimeEpisodeLink, PlayerOption, ResolvedEmbed } from '../../types.ts';
import { isSafeExternalHttpUrl, unwrapAvisoUrl } from '../../urlSafety.ts';
import {
  scoreTitleSimilarity,
  splitAlternativeTitleString,
  stripSeasonFromTitle,
} from '../../catalog/idCodec.ts';
import type {
  AggregatedServerOption,
  EpisodeSourceConfig,
  EpisodeSourceLookupQuery,
} from '../types.ts';

const TOPANIMES_DEFAULT_ORIGIN = 'https://topanimes.net';
const TOPANIMES_LOOKUP_CACHE_TTL_MS = 10 * 60 * 1000;

interface CachedLookupEntry<T> {
  value: T;
  expiresAt: number;
}

type TopAnimesSearchCandidate = {
  title: string;
  url: string;
  kind: 'anime' | 'movie' | 'episode' | 'series';
  audioType: 'DUB' | 'LEG' | null;
};

let cachedNonce: { origin: string; value: string; expiresAt: number } | null = null;
let inFlightNonce: { origin: string; promise: Promise<string | null> } | null = null;

const topAnimesSearchCacheByFetcher = new WeakMap<
  HttpFetcher,
  Map<string, CachedLookupEntry<TopAnimesSearchCandidate[]>>
>();
const topAnimesAnimeEpisodesCacheByFetcher = new WeakMap<
  HttpFetcher,
  Map<string, CachedLookupEntry<AnimeEpisodeLink[]>>
>();

function getTopAnimesFetcherMap<T>(
  store: WeakMap<HttpFetcher, Map<string, CachedLookupEntry<T>>>,
  fetchHttp: HttpFetcher
): Map<string, CachedLookupEntry<T>> {
  let map = store.get(fetchHttp);
  if (!map) {
    map = new Map();
    store.set(fetchHttp, map);
  }
  return map;
}

function rememberNonce(origin: string, html: string): string | null {
  const found = extractDooPlayNonce(html);
  if (found) {
    cachedNonce = { origin, value: found, expiresAt: Date.now() + 25 * 60 * 1000 };
  }
  return found;
}

async function getDooPlayNonce(
  fetchHttp: HttpFetcher,
  origin: string,
  forceRefresh = false
): Promise<string | null> {
  if (
    !forceRefresh &&
    cachedNonce &&
    cachedNonce.origin === origin &&
    cachedNonce.expiresAt > Date.now()
  ) {
    return cachedNonce.value;
  }
  if (!forceRefresh && inFlightNonce && inFlightNonce.origin === origin) {
    return inFlightNonce.promise;
  }

  const req = (async () => {
    try {
      const res = await fetchHttp(`${origin}/`, {
        referer: `${origin}/`,
        timeoutMs: 6000,
      });
      if (res.ok) {
        return rememberNonce(origin, res.body);
      }
    } catch {
      // ignore
    }
    return null;
  })();

  inFlightNonce = { origin, promise: req };
  try {
    return await req;
  } finally {
    if (inFlightNonce?.promise === req) {
      inFlightNonce = null;
    }
  }
}

export async function hydrateDooPlayEpisodeOptions(
  fetchHttp: HttpFetcher,
  html: string,
  pageUrl: string,
  initialOptions: PlayerOption[]
): Promise<PlayerOption[]> {
  const missing = extractMissingDooPlayerOptions(html);
  if (!missing.length) return initialOptions;

  const cfg = extractDooPlayAjaxConfig(html);
  const existingByNume = new Map<string, PlayerOption>();
  for (const opt of initialOptions) {
    existingByNume.set(opt.nume, opt);
  }

  const hydrated = await Promise.all(
    missing.map(async (item): Promise<PlayerOption | null> => {
      const preferWpJson = cfg.playMethod === 'wp_json';
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const useWpJson = (attempt === 0) === preferWpJson;
        const attemptTimeoutMs = attempt === 0 ? 4500 : 3500;
        try {
          let body = '';
          if (useWpJson) {
            const target = `${cfg.playerApi}${encodeURIComponent(item.post)}/${encodeURIComponent(
              item.type
            )}/${encodeURIComponent(item.nume)}`;
            const res = await fetchHttp(target, {
              referer: pageUrl,
              accept: 'application/json,text/html,*/*;q=0.9',
              timeoutMs: attemptTimeoutMs,
            });
            if (res.ok) body = res.body;
          } else {
            const formBody = new URLSearchParams({
              action: 'doo_player_ajax',
              post: item.post,
              nume: item.nume,
              type: item.type,
            }).toString();
            const res = await fetchHttp(cfg.ajaxUrl, {
              method: 'POST',
              body: formBody,
              referer: pageUrl,
              accept: 'application/json,text/html,*/*;q=0.9',
              timeoutMs: attemptTimeoutMs,
            });
            if (res.ok) body = res.body;
          }

          const embedUrl = parseDooPlayerAjaxResponse(body, pageUrl);
          if (embedUrl) {
            const providerKind = classifyProviderKind(item.label, embedUrl);
            return {
              nume: item.nume,
              label: formatServerLabel(item.label, `Servidor ${item.nume}`),
              embedUrl,
              providerKind,
            };
          }
        } catch {
          // try alternate method
        }
      }
      return null;
    })
  );

  let changed = false;
  for (const opt of hydrated) {
    if (!opt || existingByNume.has(opt.nume)) continue;
    existingByNume.set(opt.nume, opt);
    changed = true;
  }

  if (!changed) return initialOptions;

  return Array.from(existingByNume.values()).sort((a, b) => {
    const na = Number.parseInt(a.nume, 10);
    const nb = Number.parseInt(b.nume, 10);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return a.nume.localeCompare(b.nume);
  });
}

function pickMatchingEpisodeFromList(
  episodes: AnimeEpisodeLink[],
  seasonNumber = 1,
  episodeNumber = 1
): AnimeEpisodeLink | null {
  if (!episodes.length) return null;

  // 1. Exact season + episode number match
  const exactSeasonMatch = episodes.find(
    (ep) =>
      ep.episodeNumber === episodeNumber &&
      (ep.seasonNumber === seasonNumber || (!ep.seasonNumber && seasonNumber === 1))
  );
  if (exactSeasonMatch) return exactSeasonMatch;

  // 2. Match by episode number directly (common when TopAnimes lists each season as its own anime page)
  const byEpNum = episodes.find((ep) => ep.episodeNumber === episodeNumber);
  if (byEpNum) return byEpNum;

  // 3. Fallback by index if episodes are ordered 1..N
  if (episodeNumber >= 1 && episodeNumber <= episodes.length) {
    return episodes[episodeNumber - 1];
  }
  return null;
}

async function searchTopAnimesCandidates(
  fetchHttp: HttpFetcher,
  origin: string,
  term: string
): Promise<TopAnimesSearchCandidate[]> {
  const clean = term.trim();
  if (clean.length < 2) return [];

  const cacheKey = `${origin}::${clean.toLowerCase()}`;
  const cache = getTopAnimesFetcherMap(topAnimesSearchCacheByFetcher, fetchHttp);
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const storeResult = (items: TopAnimesSearchCandidate[]) => {
    if (cache.size > 60) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
    cache.set(cacheKey, {
      value: items,
      expiresAt: Date.now() + TOPANIMES_LOOKUP_CACHE_TTL_MS,
    });
    return items;
  };

  // Try fast wp-json dooplay search first
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const nonce = await getDooPlayNonce(fetchHttp, origin, attempt > 0);
      if (!nonce) break;
      const apiUrl = `${origin}/wp-json/dooplay/search/?keyword=${encodeURIComponent(
        clean
      )}&nonce=${encodeURIComponent(nonce)}`;
      const res = await fetchHttp(apiUrl, {
        referer: `${origin}/`,
        accept: 'application/json,*/*;q=0.9',
        timeoutMs: 5500,
      });
      if (!res.ok) continue;
      const rawJson = JSON.parse(res.body) as Record<string, unknown>;
      if (rawJson && 'error' in rawJson) {
        if (attempt === 0 && /nonce|invalid|security/i.test(String(rawJson.error || ''))) {
          continue;
        }
        break;
      }
      const parsed = parseWpSearchJson(rawJson as Parameters<typeof parseWpSearchJson>[0]);
      if (parsed.length > 0) {
        return storeResult(
          parsed.map((r) => ({
            title: r.title,
            url: r.url,
            kind: r.kind,
            audioType: r.audioType,
          }))
        );
      }
      break;
    } catch {
      // Fall through to HTML search
    }
  }

  // Fallback to HTML search page
  try {
    const res = await fetchHttp(`${origin}/?s=${encodeURIComponent(clean)}`, {
      referer: `${origin}/`,
      timeoutMs: 6500,
    });
    if (res.ok) {
      rememberNonce(origin, res.body);
      const parsed = parseSearchPageHtml(res.body);
      return storeResult(
        parsed.results.map((r) => ({
          title: r.title,
          url: r.url,
          kind: r.kind,
          audioType: r.audioType,
        }))
      );
    }
  } catch {
    // ignore
  }
  return [];
}

async function fetchTopAnimesAnimeEpisodesCached(
  fetchHttp: HttpFetcher,
  origin: string,
  animeUrl: string
): Promise<AnimeEpisodeLink[] | null> {
  const cache = getTopAnimesFetcherMap(topAnimesAnimeEpisodesCacheByFetcher, fetchHttp);
  const cached = cache.get(animeUrl);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const animeRes = await fetchHttp(animeUrl, {
    referer: `${origin}/`,
    timeoutMs: 7000,
  });
  if (!animeRes.ok) return null;
  const anime = parseAnimePageHtml(animeRes.body, animeUrl);
  if (cache.size > 60) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(animeUrl, {
    value: anime.episodes,
    expiresAt: Date.now() + TOPANIMES_LOOKUP_CACHE_TTL_MS,
  });
  return anime.episodes;
}

/**
 * Resolves TopAnimes purely as a server/episode provider for any canonical anime/movie query.
 */
export async function resolveFromTopAnimesSource(
  fetchHttp: HttpFetcher,
  source: EpisodeSourceConfig,
  query: EpisodeSourceLookupQuery
): Promise<{
  options: AggregatedServerOption[];
  matchedTitle?: string;
  matchedUrl?: string;
}> {
  const origin = source.baseUrl.replace(/\/+$/, '') || TOPANIMES_DEFAULT_ORIGIN;

  // Fast path if we already have a direct TopAnimes episode/movie page URL
  if (query.legacyEpisodeUrl && query.legacyEpisodeUrl.startsWith(origin)) {
    const res = await fetchHttp(query.legacyEpisodeUrl, {
      referer: `${origin}/`,
      timeoutMs: 10000,
    });
    if (!res.ok) return { options: [] };
    rememberNonce(origin, res.body);
    const ep = parseEpisodePageHtml(res.body, query.legacyEpisodeUrl);
    const hydrated = await hydrateDooPlayEpisodeOptions(fetchHttp, res.body, query.legacyEpisodeUrl, ep.options);
    return {
      matchedTitle: ep.title,
      matchedUrl: query.legacyEpisodeUrl,
      options: hydrated
        .filter((o) => o.providerKind !== 'abyss' && !/aniplay/i.test(o.label))
        .map((o) => ({
          ...o,
          nume: `${source.id}:${o.nume}`,
          label: `${source.name} · ${formatServerLabel(o.label, `Servidor ${o.nume}`)}`,
          sourceId: source.id,
          sourceName: source.name,
          sourceKind: source.kind,
          matchedPageUrl: query.legacyEpisodeUrl,
        })),
    };
  }

  // Build deduplicated search terms (primary title, romaji/original title, synonyms)
  const rawTerms: string[] = [];
  const rawSeen = new Set<string>();
  for (const input of [query.title, query.originalTitle, ...(query.alternativeTitles || [])]) {
    for (const part of splitAlternativeTitleString(input)) {
      if (part.length < 2 || !/[a-z0-9]/i.test(part)) continue;
      const key = part.toLowerCase();
      if (rawSeen.has(key)) continue;
      rawSeen.add(key);
      rawTerms.push(part);
    }
  }

  const titleSeason = extractHinataSoulSeasonNumber(query.title || '');
  const targetSeason =
    query.seasonNumber && query.seasonNumber > 1 ? query.seasonNumber : titleSeason;

  const searchTerms: string[] = [];
  const pushTerm = (candidate: string) => {
    const clean = candidate.trim();
    if (clean.length < 2) return;
    if (searchTerms.some((s) => s.toLowerCase() === clean.toLowerCase())) return;
    searchTerms.push(clean);
  };
  for (const term of rawTerms) {
    pushTerm(term);
    const stripped = stripSeasonFromTitle(term);
    if (stripped && stripped.toLowerCase() !== term.toLowerCase()) {
      pushTerm(stripped);
    }
    if (term.includes(':') && searchTerms.length < 4) {
      const short = term.split(':')[0].trim();
      if (short.length >= 3) pushTerm(short);
    }
    if (searchTerms.length >= 4) break;
  }

  const candidateMap = new Map<
    string,
    {
      title: string;
      url: string;
      kind: 'anime' | 'movie' | 'episode' | 'series';
      audioType: 'DUB' | 'LEG' | null;
      score: number;
    }
  >();

  const ingestFound = (found: TopAnimesSearchCandidate[]) => {
    for (const item of found) {
      if (query.mediaType === 'movie' && item.kind === 'episode') continue;
      if (query.mediaType !== 'movie' && item.kind === 'movie') continue;
      const candBase = stripSeasonFromTitle(item.title) || item.title;
      const bestFull = Math.max(...rawTerms.map((ref) => scoreTitleSimilarity(ref, item.title)));
      const bestBase = Math.max(
        ...rawTerms.map((ref) => scoreTitleSimilarity(stripSeasonFromTitle(ref) || ref, candBase))
      );
      const baseSim = Math.max(bestFull, bestBase);
      if (baseSim < 0.35) continue;

      const candSeason = extractHinataSoulSeasonNumber(item.title);
      let adjustedScore = baseSim;
      if (targetSeason > 1) {
        if (candSeason === targetSeason) adjustedScore += 0.3;
        else if (candSeason === 1) adjustedScore -= 0.25;
        else adjustedScore -= 0.4;
      } else if (candSeason > 1) {
        adjustedScore -= 0.3;
      }

      if (adjustedScore < 0.35) continue;
      const existing = candidateMap.get(item.url);
      if (!existing || adjustedScore > existing.score) {
        candidateMap.set(item.url, { ...item, score: adjustedScore });
      }
    }
  };

  const limitedTerms = searchTerms.slice(0, 3);
  if (limitedTerms.length > 0) {
    ingestFound(await searchTopAnimesCandidates(fetchHttp, origin, limitedTerms[0]));
    const strongThreshold = targetSeason > 1 ? 1.05 : 0.85;
    const hasStrongMatch = Array.from(candidateMap.values()).some(
      (c) => c.score >= strongThreshold
    );
    if (!hasStrongMatch && limitedTerms.length > 1) {
      const rest = await Promise.all(
        limitedTerms.slice(1).map((term) => searchTopAnimesCandidates(fetchHttp, origin, term))
      );
      for (const found of rest) {
        ingestFound(found);
      }
    }
  }

  const ranked = Array.from(candidateMap.values()).sort((a, b) => b.score - a.score);
  if (!ranked.length) return { options: [] };

  // Pick up to 2 best matches (e.g. Legendado + Dublado versions of the same anime!)
  const chosenTargets: typeof ranked = [];
  const seenAudio = new Set<string>();
  for (const cand of ranked) {
    if (cand.score < ranked[0].score - 0.2) continue;
    const audioKey = cand.audioType || 'LEG';
    if (query.audioPreference === 'DUB' && audioKey !== 'DUB' && ranked.some((r) => r.audioType === 'DUB' && r.score >= 0.55)) {
      continue;
    }
    if (query.audioPreference === 'LEG' && audioKey === 'DUB' && ranked.some((r) => r.audioType !== 'DUB' && r.score >= 0.55)) {
      continue;
    }
    if (seenAudio.has(audioKey)) continue;
    seenAudio.add(audioKey);
    chosenTargets.push(cand);
    if (chosenTargets.length >= 2) break;
  }

  const settledTargets = await Promise.all(
    chosenTargets.map(async (target) => {
      try {
        let episodePageUrl = target.url;
        if (query.mediaType !== 'movie' && target.kind !== 'episode') {
          const episodes = await fetchTopAnimesAnimeEpisodesCached(fetchHttp, origin, target.url);
          if (!episodes) return null;
          const epMatch = pickMatchingEpisodeFromList(
            episodes,
            query.seasonNumber || 1,
            query.episodeNumber || 1
          );
          if (!epMatch) return null;
          episodePageUrl = epMatch.url;
        }

        const epRes = await fetchHttp(episodePageUrl, {
          referer: target.url,
          timeoutMs: 7500,
        });
        if (!epRes.ok) return null;
        rememberNonce(origin, epRes.body);
        const parsedEp = parseEpisodePageHtml(epRes.body, episodePageUrl);
        const hydrated = await hydrateDooPlayEpisodeOptions(
          fetchHttp,
          epRes.body,
          episodePageUrl,
          parsedEp.options
        );

        const audioTag =
          target.audioType === 'DUB' ? 'DUB' : target.audioType === 'LEG' ? 'LEG' : null;
        const audioSuffix = audioTag ? ` [${audioTag}]` : '';
        const targetOptions: AggregatedServerOption[] = [];
        for (const opt of hydrated) {
          if (opt.providerKind === 'abyss' || /aniplay/i.test(opt.label)) continue;
          const cleanLabel = formatServerLabel(opt.label, `Servidor ${opt.nume}`);
          targetOptions.push({
            ...opt,
            nume: `${source.id}:${audioTag || 'def'}:${opt.nume}`,
            label: `${source.name}${audioSuffix} · ${cleanLabel}`,
            sourceId: source.id,
            sourceName: source.name,
            sourceKind: source.kind,
            audioType: audioTag,
            matchedPageUrl: episodePageUrl,
          });
        }

        return {
          title: target.title,
          episodePageUrl,
          options: targetOptions,
        };
      } catch {
        return null;
      }
    })
  );

  const aggregated: AggregatedServerOption[] = [];
  let firstMatchedTitle: string | undefined;
  let firstMatchedUrl: string | undefined;

  for (const resolved of settledTargets) {
    if (!resolved) continue;
    aggregated.push(...resolved.options);
    if (!firstMatchedUrl && resolved.options.length > 0) {
      firstMatchedTitle = resolved.title;
      firstMatchedUrl = resolved.episodePageUrl;
    }
  }

  return {
    options: aggregated,
    matchedTitle: firstMatchedTitle,
    matchedUrl: firstMatchedUrl,
  };
}

/**
 * Resolves a video embed URL (KojimaCDN, Zuplay, Vidstreaming, PlayerJS, Blogger, etc.)
 * into direct playable HLS/MP4 streams and subtitles.
 */
export async function resolveTopAnimesEmbed(
  fetchHttp: HttpFetcher,
  rawEmbedUrl: string,
  baseReferer = `${TOPANIMES_DEFAULT_ORIGIN}/`
): Promise<ResolvedEmbed> {
  const cleanEmbed = unwrapAvisoUrl(rawEmbedUrl) || rawEmbedUrl;

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

  let fetchTarget = cleanEmbed;
  if (/sk-boyceta\.booonceivu\.shop/i.test(cleanEmbed)) {
    const u = new URL(cleanEmbed);
    u.searchParams.set('mode', 'to-salvando-seu-ip');
    fetchTarget = u.href;
  }

  try {
    const res = await fetchHttp(fetchTarget, {
      referer: baseReferer,
      timeoutMs: 12000,
    });
    if (!res.ok) {
      return {
        embedUrl: cleanEmbed,
        provider: isAbyssEmbedUrl(cleanEmbed) ? 'Aniplay' : 'Servidor',
        status: 'error',
        streams: [],
        subtitles: [],
        referer: baseReferer,
        errorMessage: `Servidor respondeu com HTTP ${res.status}.`,
      };
    }

    const effectiveEmbedUrl =
      res.finalUrl && isSafeExternalHttpUrl(res.finalUrl) ? res.finalUrl : cleanEmbed;

    let extracted = extractStreamsFromEmbed(effectiveEmbedUrl, res.body);

    if (!extracted.streams.length) {
      const zuplayPathMatch = cleanEmbed.match(/^https?:\/\/csst\.online\/embed\/(video\/[^?#]+)/i);
      if (zuplayPathMatch?.[1]) {
        const zuplayFallbackUrl = `https://ru-boyceta.booonceivu.shop/?id=${encodeURIComponent(
          zuplayPathMatch[1]
        )}`;
        const zRes = await fetchHttp(zuplayFallbackUrl, {
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
        referer: effectiveEmbedUrl,
        errorMessage:
          'Nenhum link direto .m3u8/.mp4 encontrado neste servidor. Tente outro servidor abaixo.',
      };
    }

    const isAbyss = isAbyssEmbedUrl(effectiveEmbedUrl) || extracted.provider === 'Aniplay';
    const streamReferer = isAbyss
      ? `${new URL(effectiveEmbedUrl).origin}/`
      : /csst\.online/i.test(effectiveEmbedUrl)
        ? 'https://www.incvideo1.online/'
        : isMixDropEmbedUrl(effectiveEmbedUrl)
          ? `${new URL(effectiveEmbedUrl).origin}/`
          : /antivirus|booonceivu/i.test(effectiveEmbedUrl)
            ? baseReferer
            : effectiveEmbedUrl;

    const firstUrl = extracted.streams[0]?.url || '';
    const preferDirect =
      !isAbyss &&
      /(?:^|\.)(?:booonceivu\.shop|123flmsfree\.com|321moviesfree\.com)$/i.test(
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
