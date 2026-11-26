import type { HttpFetcher } from '../../httpTypes.ts';
import {
  HINATASOUL_ORIGIN,
  deriveHinataSoulR2Candidates,
  extractHinataSoulSeasonNumber,
  parseHinataSoulAnimePageHtml,
  parseHinataSoulEpisodePageHtml,
  parseHinataSoulSearchHtml,
  type HinataSoulR2Candidate,
} from '../../hinatasoulParser.ts';
import {
  expandTitleVariantsForMatch,
  scoreTitleSimilarity,
  splitAlternativeTitleString,
  stripSeasonFromTitle,
} from '../../catalog/idCodec.ts';
import type {
  AnimeDetails,
  AnimeEpisodeLink,
  ResolvedEmbed,
  StreamQuality,
} from '../../types.ts';
import {
  isHinataSoulUrl,
  isSafeExternalHttpUrl,
  normalizeHinataSoulUrl,
} from '../../urlSafety.ts';
import type {
  AggregatedServerOption,
  EpisodeSourceConfig,
  EpisodeSourceLookupQuery,
} from '../types.ts';

const TABOOLA_AD_SCRIPT_URL = 'https://cdn.taboola.com/libtrc/unpkg/tfa.js';
const ADBLOCK2_SIGNER_URL = 'https://ads.animeyabu.net/adblock2.php';
const HINATASOUL_PLAYER_REFERER = 'https://www.anitube22.vip/';
const TABOOLA_CACHE_TTL_MS = 30 * 60 * 1000;
const LOOKUP_CACHE_TTL_MS = 10 * 60 * 1000;
const EPISODE_PAGE_CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedLookupEntry<T> {
  value: T;
  expiresAt: number;
}

interface CachedHinataSoulEpisodeData {
  poster?: string;
  candidates: HinataSoulR2Candidate[];
}

let cachedAdScript: { value: string; expiresAt: number } | null = null;
let inFlightAdScript: Promise<string | null> | null = null;

const searchCacheByFetcher = new WeakMap<
  HttpFetcher,
  Map<string, CachedLookupEntry<ReturnType<typeof parseHinataSoulSearchHtml>['results']>>
>();
const animePageCacheByFetcher = new WeakMap<
  HttpFetcher,
  Map<string, CachedLookupEntry<ReturnType<typeof parseHinataSoulAnimePageHtml>>>
>();
const episodePageCacheByFetcher = new WeakMap<
  HttpFetcher,
  Map<string, CachedLookupEntry<CachedHinataSoulEpisodeData>>
>();

function getFetcherMap<T>(
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

export function clearHinataSoulCaches(): void {
  cachedAdScript = null;
  inFlightAdScript = null;
}

export function rememberHinataSoulEpisodePage(
  fetchHttp: HttpFetcher,
  rawUrl: string,
  parsed: ReturnType<typeof parseHinataSoulEpisodePageHtml>
): void {
  const key = normalizeHinataSoulUrl(rawUrl) || rawUrl.trim();
  if (!key) return;
  const candidates = deriveHinataSoulR2Candidates(parsed.contentUrl, parsed.qualities);
  if (!candidates.length) return;
  const map = getFetcherMap(episodePageCacheByFetcher, fetchHttp);
  if (map.size > 40) {
    const oldest = map.keys().next().value;
    if (oldest) map.delete(oldest);
  }
  map.set(key, {
    value: {
      poster: parsed.episode.poster || undefined,
      candidates,
    },
    expiresAt: Date.now() + EPISODE_PAGE_CACHE_TTL_MS,
  });
}

export function prefetchHinataSoulAdScript(fetchHttp: HttpFetcher): Promise<string | null> {
  return getAdValidationPayload(fetchHttp).catch(() => null);
}

export function isHinataSoulEmbedUrl(rawUrl: string): boolean {
  if (!rawUrl || !isSafeExternalHttpUrl(rawUrl)) return false;
  if (isHinataSoulUrl(rawUrl)) return true;
  try {
    const parsed = new URL(rawUrl.trim());
    const host = parsed.hostname.toLowerCase();
    if (/(?:^|\.)anitube22\.vip$/i.test(host) && /playerricas/i.test(parsed.pathname)) {
      return true;
    }
    if (/(?:^|\.)fatshark\.xyz$/i.test(host) || /(?:^|\.)rs12fbv\.lol$/i.test(host)) {
      return true;
    }
    if (
      host === '173fe263eae04670ecfcebf237fd6480.r2.cloudflarestorage.com' ||
      (host.endsWith('.r2.cloudflarestorage.com') &&
        /^\/(?:ziphone[a-z]?|z\d{3}|zful)\/\d+\.mp4$/i.test(parsed.pathname))
    ) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function buildHinataSoulAnimePageUrl(animeUrl: string, page: number): string {
  const clean = animeUrl.replace(/\/page\/\d+\/?$/i, '').replace(/\/+$/, '');
  return page <= 1 ? clean : `${clean}/page/${page}`;
}

function sortAndDedupeEpisodes(episodes: AnimeEpisodeLink[]): AnimeEpisodeLink[] {
  const seen = new Set<string>();
  const out: AnimeEpisodeLink[] = [];
  for (const ep of episodes) {
    if (!ep.url || seen.has(ep.url)) continue;
    seen.add(ep.url);
    out.push(ep);
  }
  return out.sort((a, b) => {
    const na = a.episodeNumber;
    const nb = b.episodeNumber;
    if (na !== null && nb !== null && na !== nb) return na - nb;
    return 0;
  });
}

/**
 * Loads a Hinata Soul anime/series/movie page along with its paginated episodes.
 * - Set `onlyLatest: true` (e.g. for favorites checking) to fetch page 1 and jump directly
 *   to the last page when paginated.
 * - Otherwise fetches pages up to `maxPages` (plus the last page if more exist).
 */
export async function fetchHinataSoulAnimeWithEpisodes(
  fetchHttp: HttpFetcher,
  rawAnimeUrl: string,
  options: {
    maxPages?: number;
    onlyLatest?: boolean;
    timeoutMs?: number;
  } = {}
): Promise<AnimeDetails | null> {
  const animeUrl = normalizeHinataSoulUrl(rawAnimeUrl);
  if (!animeUrl) return null;

  const timeoutMs = options.timeoutMs ?? 9000;
  const maxPages = Math.max(1, options.maxPages ?? 8);
  const firstRes = await fetchHttp(animeUrl, {
    referer: `${HINATASOUL_ORIGIN}/`,
    timeoutMs,
  });
  if (!firstRes.ok) return null;

  const page1 = parseHinataSoulAnimePageHtml(firstRes.body, animeUrl, 1);
  if (page1.totalPages <= 1) {
    return page1.details;
  }

  const extraPages: number[] = [];
  if (options.onlyLatest) {
    extraPages.push(page1.totalPages);
  } else {
    const capped = Math.min(page1.totalPages, maxPages);
    for (let p = 2; p <= capped; p += 1) {
      extraPages.push(p);
    }
    if (page1.totalPages > capped) {
      extraPages.push(page1.totalPages);
    }
  }

  const allEpisodes: AnimeEpisodeLink[] = [...page1.details.episodes];

  for (let i = 0; i < extraPages.length; i += 4) {
    const chunk = extraPages.slice(i, i + 4);
    const settled = await Promise.all(
      chunk.map(async (pageNum) => {
        try {
          const pageUrl = buildHinataSoulAnimePageUrl(animeUrl, pageNum);
          const res = await fetchHttp(pageUrl, {
            referer: animeUrl,
            timeoutMs,
          });
          if (!res.ok) return [];
          return parseHinataSoulAnimePageHtml(res.body, animeUrl, pageNum).details.episodes;
        } catch {
          return [];
        }
      })
    );
    for (const eps of settled) {
      allEpisodes.push(...eps);
    }
  }

  return {
    ...page1.details,
    episodes: sortAndDedupeEpisodes(allEpisodes),
  };
}

function findEpisodeInList(
  episodes: readonly AnimeEpisodeLink[],
  episodeNumber: number
): AnimeEpisodeLink | null {
  if (!episodes.length) return null;
  const exact = episodes.find((ep) => ep.episodeNumber === episodeNumber);
  if (exact) return exact;
  return null;
}

async function fetchParsedHinataSoulAnimePageCached(
  fetchHttp: HttpFetcher,
  animeUrl: string,
  pageNum: number,
  referer: string,
  timeoutMs: number
): Promise<ReturnType<typeof parseHinataSoulAnimePageHtml> | null> {
  const pageUrl = buildHinataSoulAnimePageUrl(animeUrl, pageNum);
  const cache = getFetcherMap(animePageCacheByFetcher, fetchHttp);
  const cached = cache.get(pageUrl);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const res = await fetchHttp(pageUrl, {
    referer,
    timeoutMs,
  });
  if (!res.ok) return null;

  const parsed = parseHinataSoulAnimePageHtml(res.body, animeUrl, pageNum);
  if (cache.size > 60) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(pageUrl, {
    value: parsed,
    expiresAt: Date.now() + LOOKUP_CACHE_TTL_MS,
  });
  return parsed;
}

/**
 * Efficiently locates episode `episodeNumber` on a paginated Hinata Soul anime page
 * (usually in 1 request for eps 1-24, or 2 requests for any higher episode like One Piece ep 500).
 */
async function findHinataSoulEpisodeByNumber(
  fetchHttp: HttpFetcher,
  animeUrl: string,
  episodeNumber: number,
  isMovie: boolean
): Promise<AnimeEpisodeLink | null> {
  const page1 = await fetchParsedHinataSoulAnimePageCached(
    fetchHttp,
    animeUrl,
    1,
    `${HINATASOUL_ORIGIN}/`,
    7000
  );
  if (!page1 || !page1.details.episodes.length) return null;

  if (isMovie) {
    return page1.details.episodes[0];
  }

  const foundOnPage1 = findEpisodeInList(page1.details.episodes, episodeNumber);
  if (foundOnPage1) return foundOnPage1;

  if (page1.totalPages <= 1) {
    if (episodeNumber >= 1 && episodeNumber <= page1.details.episodes.length) {
      return page1.details.episodes[episodeNumber - 1];
    }
    return null;
  }

  const perPage = Math.max(1, page1.details.episodes.length);
  const estimatedPage = Math.max(
    2,
    Math.min(page1.totalPages, Math.ceil(episodeNumber / perPage))
  );

  const pagesToTry = [estimatedPage];
  if (estimatedPage - 1 >= 2) pagesToTry.push(estimatedPage - 1);
  if (estimatedPage + 1 <= page1.totalPages) pagesToTry.push(estimatedPage + 1);

  for (const pageNum of pagesToTry) {
    try {
      const parsed = await fetchParsedHinataSoulAnimePageCached(
        fetchHttp,
        animeUrl,
        pageNum,
        animeUrl,
        6500
      );
      if (!parsed) continue;
      const match = findEpisodeInList(parsed.details.episodes, episodeNumber);
      if (match) return match;
    } catch {
      // Try next candidate page
    }
  }

  return null;
}

async function searchHinataSoulCandidates(
  fetchHttp: HttpFetcher,
  origin: string,
  term: string
) {
  const clean = term.trim();
  if (clean.length < 2) return [];
  const cacheKey = `${origin}::${clean.toLowerCase()}`;
  const cache = getFetcherMap(searchCacheByFetcher, fetchHttp);
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  try {
    const res = await fetchHttp(`${origin}/busca?busca=${encodeURIComponent(clean)}`, {
      referer: `${origin}/`,
      timeoutMs: 6500,
    });
    if (!res.ok) return [];
    const results = parseHinataSoulSearchHtml(res.body, 1, origin).results;
    if (cache.size > 60) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
    cache.set(cacheKey, {
      value: results,
      expiresAt: Date.now() + LOOKUP_CACHE_TTL_MS,
    });
    return results;
  } catch {
    return [];
  }
}

function scoreHinataSoulCandidate(
  refTitles: readonly string[],
  targetSeason: number,
  candTitle: string
): { score: number; baseSimilarity: number } {
  const candSeason = extractHinataSoulSeasonNumber(candTitle);
  const candVariants = expandTitleVariantsForMatch(candTitle);
  const candBaseVariants = Array.from(
    new Set(candVariants.map((v) => stripSeasonFromTitle(v) || v))
  );

  let bestFull = 0;
  let bestBase = 0;
  let matchedSeasonSpecificRef = false;

  for (const ref of refTitles) {
    const refBase = stripSeasonFromTitle(ref) || ref;
    const refSeason = extractHinataSoulSeasonNumber(ref);
    for (const cv of candVariants) {
      const full = scoreTitleSimilarity(ref, cv);
      if (full > bestFull) {
        bestFull = full;
        if (targetSeason > 1 && refSeason === targetSeason && full >= 0.8) {
          matchedSeasonSpecificRef = true;
        }
      }
    }
    for (const cb of candBaseVariants) {
      const base = scoreTitleSimilarity(refBase, cb);
      if (base > bestBase) bestBase = base;
    }
  }

  const baseSimilarity = Math.max(bestFull, bestBase);
  if (baseSimilarity < 0.45) {
    return { score: 0, baseSimilarity };
  }

  let score = baseSimilarity;
  if (targetSeason > 1) {
    if (candSeason === targetSeason || matchedSeasonSpecificRef) {
      score += 0.3;
    } else if (candSeason === 1) {
      score -= 0.25;
    } else {
      score -= 0.45;
    }
  } else if (candSeason > 1) {
    score -= 0.35;
  } else {
    score += 0.1;
  }

  return { score, baseSimilarity };
}

/**
 * Resolves Hinata Soul as an episode server source for any canonical anime/series/movie query.
 */
export async function resolveFromHinataSoulSource(
  fetchHttp: HttpFetcher,
  source: EpisodeSourceConfig,
  query: EpisodeSourceLookupQuery
): Promise<{
  options: AggregatedServerOption[];
  matchedTitle?: string;
  matchedUrl?: string;
}> {
  const origin = source.baseUrl.replace(/\/+$/, '') || HINATASOUL_ORIGIN;

  // Fast path if we already have a direct Hinata Soul episode page URL
  if (query.legacyEpisodeUrl && isHinataSoulUrl(query.legacyEpisodeUrl)) {
    const res = await fetchHttp(query.legacyEpisodeUrl, {
      referer: `${origin}/`,
      timeoutMs: 10000,
    });
    if (!res.ok) return { options: [] };
    const parsed = parseHinataSoulEpisodePageHtml(res.body, query.legacyEpisodeUrl, origin);
    return {
      matchedTitle: parsed.episode.title,
      matchedUrl: parsed.episode.url,
      options: parsed.episode.options.map((o) => ({
        ...o,
        sourceId: source.id,
        sourceName: source.name,
        sourceKind: source.kind,
      })),
    };
  }

  const rawTermSet = new Set<string>();
  const rawTerms: string[] = [];
  for (const rawInput of [query.title, query.originalTitle, ...(query.alternativeTitles || [])]) {
    for (const part of splitAlternativeTitleString(rawInput)) {
      if (part.length < 2 || !/[a-z0-9]/i.test(part)) continue;
      const key = part.toLowerCase();
      if (rawTermSet.has(key)) continue;
      rawTermSet.add(key);
      rawTerms.push(part);
    }
  }

  if (!rawTerms.length) return { options: [] };

  const primaryTitleSeason = extractHinataSoulSeasonNumber(query.title || '');
  const targetSeason =
    query.seasonNumber && query.seasonNumber > 1 ? query.seasonNumber : primaryTitleSeason;

  const searchTerms: string[] = [];
  const pushTerm = (candidate: string) => {
    const clean = candidate.trim();
    if (clean.length < 2) return;
    if (searchTerms.some((s) => s.toLowerCase() === clean.toLowerCase())) return;
    searchTerms.push(clean);
  };

  // Prioritize base/season-appropriate aliases before mismatched later-season aliases
  const prioritizedTerms = [...rawTerms].sort((a, b) => {
    const aSeason = extractHinataSoulSeasonNumber(a);
    const bSeason = extractHinataSoulSeasonNumber(b);
    const aMatch = aSeason === targetSeason ? 0 : 1;
    const bMatch = bSeason === targetSeason ? 0 : 1;
    return aMatch - bMatch;
  });

  for (const term of prioritizedTerms) {
    const termSeason = extractHinataSoulSeasonNumber(term);
    if (targetSeason === 1 && termSeason > 1) {
      const stripped = stripSeasonFromTitle(term);
      if (stripped && stripped.length >= 2) pushTerm(stripped);
      continue;
    }
    pushTerm(term);
    const stripped = stripSeasonFromTitle(term);
    if (stripped && stripped.toLowerCase() !== term.toLowerCase()) {
      pushTerm(stripped);
    }
    if (term.includes(':')) {
      const short = term.split(':')[0].trim();
      if (short.length >= 3) pushTerm(short);
    }
    if (searchTerms.length >= 5) break;
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

  const ingestFound = (
    found: Awaited<ReturnType<typeof searchHinataSoulCandidates>>
  ) => {
    for (const item of found) {
      if (item.kind === 'episode') continue;
      if (query.mediaType !== 'movie' && item.kind === 'movie') continue;
      const { score, baseSimilarity } = scoreHinataSoulCandidate(
        rawTerms,
        targetSeason,
        item.title
      );
      if (baseSimilarity < 0.45 || score < 0.35) continue;

      const mediaBoost = query.mediaType === 'movie' && item.kind === 'movie' ? 0.15 : 0;
      const finalScore = score + mediaBoost;
      const existing = candidateMap.get(item.url);
      if (!existing || finalScore > existing.score) {
        candidateMap.set(item.url, {
          title: item.title,
          url: item.url,
          kind: item.kind,
          audioType: item.audioType,
          score: finalScore,
        });
      }
    }
  };

  const limitedTerms = searchTerms.slice(0, 4);
  if (limitedTerms.length > 0) {
    ingestFound(await searchHinataSoulCandidates(fetchHttp, origin, limitedTerms[0]));
    const hasStrongMatch = Array.from(candidateMap.values()).some((c) => c.score >= 1.05);
    if (!hasStrongMatch && limitedTerms.length > 1) {
      const rest = await Promise.all(
        limitedTerms.slice(1).map((term) => searchHinataSoulCandidates(fetchHttp, origin, term))
      );
      for (const found of rest) {
        ingestFound(found);
      }
    }
  }

  const ranked = Array.from(candidateMap.values()).sort((a, b) => b.score - a.score);
  if (!ranked.length) return { options: [] };

  // Pick up to 2 best matches (Legendado + Dublado versions of the same anime/season)
  const chosenTargets: typeof ranked = [];
  const seenAudio = new Set<string>();
  for (const cand of ranked) {
    if (cand.score < ranked[0].score - 0.2) continue;
    const audioKey = cand.audioType || 'LEG';
    if (
      query.audioPreference === 'DUB' &&
      audioKey !== 'DUB' &&
      ranked.some((r) => r.audioType === 'DUB' && r.score >= 0.55)
    ) {
      continue;
    }
    if (
      query.audioPreference === 'LEG' &&
      audioKey === 'DUB' &&
      ranked.some((r) => r.audioType !== 'DUB' && r.score >= 0.55)
    ) {
      continue;
    }
    if (seenAudio.has(audioKey)) continue;
    seenAudio.add(audioKey);
    chosenTargets.push(cand);
    if (chosenTargets.length >= 2) break;
  }

  const epNum = query.episodeNumber || 1;
  const isMovie = query.mediaType === 'movie';

  const resolvedTargets = await Promise.all(
    chosenTargets.map(async (target) => {
      try {
        const epMatch = await findHinataSoulEpisodeByNumber(
          fetchHttp,
          target.url,
          epNum,
          isMovie
        );
        if (!epMatch) return null;
        return { target, epMatch };
      } catch {
        return null;
      }
    })
  );

  const options: AggregatedServerOption[] = [];
  let firstMatchedTitle: string | undefined;
  let firstMatchedUrl: string | undefined;

  for (const entry of resolvedTargets) {
    if (!entry) continue;
    const { target, epMatch } = entry;
    const audioTag = target.audioType === 'DUB' ? 'DUB' : 'LEG';
    options.push({
      nume: `${source.id}:${audioTag}:1`,
      label: `${source.name} [${audioTag}] · Full HD / HD / SD`,
      embedUrl: epMatch.url,
      providerKind: 'hinatasoul',
      sourceId: source.id,
      sourceName: source.name,
      sourceKind: source.kind,
      audioType: audioTag,
      matchedPageUrl: epMatch.url,
      directReferer: `${origin}/`,
      qualityLabel: 'Full HD',
    });

    if (!firstMatchedUrl) {
      firstMatchedTitle = target.title;
      firstMatchedUrl = epMatch.url;
    }
  }

  return {
    options,
    matchedTitle: firstMatchedTitle,
    matchedUrl: firstMatchedUrl,
  };
}

async function getAdValidationPayload(fetchHttp: HttpFetcher): Promise<string | null> {
  if (cachedAdScript && cachedAdScript.expiresAt > Date.now()) {
    return cachedAdScript.value;
  }
  if (inFlightAdScript) {
    return inFlightAdScript;
  }

  inFlightAdScript = (async () => {
    try {
      const res = await fetchHttp(TABOOLA_AD_SCRIPT_URL, {
        referer: HINATASOUL_PLAYER_REFERER,
        accept: '*/*',
        timeoutMs: 8000,
      });
      if (res.ok && res.body && res.body.length > 100) {
        cachedAdScript = {
          value: res.body,
          expiresAt: Date.now() + TABOOLA_CACHE_TTL_MS,
        };
        return res.body;
      }
    } catch {
      // ignore
    }
    return null;
  })();

  try {
    return await inFlightAdScript;
  } finally {
    inFlightAdScript = null;
  }
}

function parseAdblock2Publicidade(rawBody: string): string | null {
  try {
    const parsed = JSON.parse(rawBody) as Array<{ publicidade?: unknown; ads?: unknown }>;
    if (!Array.isArray(parsed) || !parsed.length) return null;
    const val = parsed[0]?.publicidade;
    if (typeof val === 'string' && val.trim().startsWith('?')) {
      return val.trim();
    }
  } catch {
    // ignore malformed JSON
  }
  return null;
}

/**
 * Signs a Hinata Soul Cloudflare R2 MP4 URL using the 2-step `adblock2.php` token exchange.
 */
async function signHinataSoulR2Url(
  fetchHttp: HttpFetcher,
  r2Url: string,
  adPayload: string
): Promise<string | null> {
  if (!isSafeExternalHttpUrl(r2Url)) return null;

  try {
    const formBody = new URLSearchParams({
      category: 'client',
      type: 'premium',
      ad: adPayload,
      url: r2Url,
    }).toString();

    const step1 = await fetchHttp(ADBLOCK2_SIGNER_URL, {
      method: 'POST',
      body: formBody,
      referer: HINATASOUL_PLAYER_REFERER,
      accept: 'application/json,text/plain,*/*',
      timeoutMs: 10000,
    });
    if (!step1.ok) return null;

    const token = parseAdblock2Publicidade(step1.body);
    if (!token) return null;

    const step2Url = `${ADBLOCK2_SIGNER_URL}?token=${encodeURIComponent(
      token
    )}&url=${encodeURIComponent(r2Url)}`;
    const step2 = await fetchHttp(step2Url, {
      referer: HINATASOUL_PLAYER_REFERER,
      accept: 'application/json,text/plain,*/*',
      timeoutMs: 10000,
    });
    if (!step2.ok) return null;

    const signedQuery = parseAdblock2Publicidade(step2.body);
    if (!signedQuery) return null;

    const finalUrl = `${r2Url}${signedQuery}`;
    return isSafeExternalHttpUrl(finalUrl) ? finalUrl : null;
  } catch {
    return null;
  }
}

function extractVidUrlFromPlayerPage(url: string, body = ''): string | null {
  try {
    const parsed = new URL(url);
    const paramUrl = parsed.searchParams.get('url');
    if (paramUrl && isSafeExternalHttpUrl(paramUrl)) {
      return paramUrl;
    }
  } catch {
    // ignore
  }
  if (body) {
    const varVid = body.match(/var\s+vid\s*=\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i);
    if (varVid?.[1] && isSafeExternalHttpUrl(varVid[1])) {
      return varVid[1];
    }
    const iframeMatch = body.match(
      /<iframe[^>]+src=["'](https?:\/\/[^"']*playerricas[^"']+)["']/i
    );
    if (iframeMatch?.[1]) {
      return extractVidUrlFromPlayerPage(iframeMatch[1].replace(/&amp;/g, '&'));
    }
  }
  return null;
}

/**
 * Fallback redirect follower (strict TLS via `fetchHttp`) if `meta[itemprop="contentURL"]`
 * is ever absent on a Hinata Soul episode page.
 */
async function followHinataSoulRedirectForVid(
  fetchHttp: HttpFetcher,
  startUrl: string,
  referer: string
): Promise<string | null> {
  let currentUrl = startUrl;
  let currentRef = referer;
  for (let hop = 0; hop < 4; hop += 1) {
    if (!isSafeExternalHttpUrl(currentUrl)) return null;
    const directVid = extractVidUrlFromPlayerPage(currentUrl);
    if (directVid) return directVid;

    try {
      const res = await fetchHttp(currentUrl, {
        referer: currentRef,
        timeoutMs: 8000,
      });
      const bodyVid = extractVidUrlFromPlayerPage(res.finalUrl || currentUrl, res.body);
      if (bodyVid) return bodyVid;

      const metaRefresh = res.body.match(
        /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url=([^"'\s>]+)/i
      );
      if (metaRefresh?.[1]) {
        currentRef = currentUrl;
        currentUrl = new URL(metaRefresh[1].replace(/&amp;/g, '&'), currentUrl).href;
        continue;
      }
      break;
    } catch {
      break;
    }
  }
  return null;
}

/**
 * Resolves a Hinata Soul episode URL (`https://www.hinatasoul.com/videos/<id>`),
 * `playerricas.php` embed, or R2 video URL into signed direct MP4 streams across all available qualities.
 */
export async function resolveHinataSoulEmbed(
  fetchHttp: HttpFetcher,
  rawEmbedUrl: string,
  baseReferer = `${HINATASOUL_ORIGIN}/`
): Promise<ResolvedEmbed> {
  const cleanUrl = (rawEmbedUrl || '').trim();
  if (!isSafeExternalHttpUrl(cleanUrl)) {
    return {
      embedUrl: rawEmbedUrl,
      provider: 'Hinata Soul',
      status: 'error',
      streams: [],
      subtitles: [],
      referer: baseReferer,
      errorMessage: 'URL do Hinata Soul bloqueada ou inválida.',
    };
  }

  try {
    // Warm up Taboola ad script in parallel with fetching/parsing the episode page
    const adPayloadPromise = getAdValidationPayload(fetchHttp);

    let candidates: HinataSoulR2Candidate[] = [];
    let poster: string | undefined;

    if (isHinataSoulUrl(cleanUrl)) {
      const cacheKey = normalizeHinataSoulUrl(cleanUrl) || cleanUrl;
      const cachedEp = getFetcherMap(episodePageCacheByFetcher, fetchHttp).get(cacheKey);
      if (cachedEp && cachedEp.expiresAt > Date.now() && cachedEp.value.candidates.length > 0) {
        poster = cachedEp.value.poster;
        candidates = cachedEp.value.candidates;
      } else {
        const pageRes = await fetchHttp(cleanUrl, {
          referer: baseReferer,
          timeoutMs: 10000,
        });
        if (!pageRes.ok) {
          return {
            embedUrl: cleanUrl,
            provider: 'Hinata Soul',
            status: 'error',
            streams: [],
            subtitles: [],
            referer: baseReferer,
            errorMessage: `Hinata Soul respondeu com HTTP ${pageRes.status}.`,
          };
        }

        const parsed = parseHinataSoulEpisodePageHtml(pageRes.body, cleanUrl);
        rememberHinataSoulEpisodePage(fetchHttp, cleanUrl, parsed);
        poster = parsed.episode.poster || undefined;
        candidates = deriveHinataSoulR2Candidates(parsed.contentUrl, parsed.qualities);

        // Fallback if contentURL was missing: inspect inline iframes or safe redirect links
        if (!candidates.length && parsed.qualities.length > 0) {
          const sortedTabs = [...parsed.qualities].sort((a, b) => b.height - a.height);
          const fallbackCandidates = await Promise.all(
            sortedTabs.map(async (tab): Promise<HinataSoulR2Candidate | null> => {
              const target = tab.iframeSrc || tab.redirectHref;
              if (!target) return null;
              const vid = await followHinataSoulRedirectForVid(fetchHttp, target, cleanUrl);
              if (!vid) return null;
              return {
                label:
                  tab.height >= 1080
                    ? '1080p (Full HD)'
                    : tab.height >= 720
                      ? '720p (HD)'
                      : '480p (SD)',
                height: tab.height,
                r2Url: vid,
              };
            })
          );
          candidates = fallbackCandidates.filter((c): c is HinataSoulR2Candidate => Boolean(c));
        }
      }
    } else {
      const directVid =
        extractVidUrlFromPlayerPage(cleanUrl) ||
        (cleanUrl.includes('.r2.cloudflarestorage.com/') ? cleanUrl.split('?')[0] : null) ||
        (await followHinataSoulRedirectForVid(fetchHttp, cleanUrl, baseReferer));

      if (directVid) {
        const height = /\/zful\//i.test(directVid)
          ? 1080
          : /\/z(?:111|222|333|444)\//i.test(directVid)
            ? 720
            : 480;
        candidates = [
          {
            label: height >= 1080 ? '1080p (Full HD)' : height >= 720 ? '720p (HD)' : '480p (SD)',
            height,
            r2Url: directVid,
          },
        ];
      }
    }

    if (!candidates.length) {
      return {
        embedUrl: cleanUrl,
        provider: 'Hinata Soul',
        status: 'embed-only',
        streams: [],
        subtitles: [],
        poster,
        referer: cleanUrl,
        errorMessage: 'Nenhum vídeo disponível encontrado nesta página do Hinata Soul.',
      };
    }

    const adPayload = await adPayloadPromise;
    if (!adPayload) {
      return {
        embedUrl: cleanUrl,
        provider: 'Hinata Soul',
        status: 'error',
        streams: [],
        subtitles: [],
        poster,
        referer: HINATASOUL_PLAYER_REFERER,
        errorMessage:
          'Não foi possível validar o player do Hinata Soul. Verifique se algum bloqueador de DNS bloqueia o carregamento.',
      };
    }

    const signedResults = await Promise.all(
      candidates.map(async (cand): Promise<StreamQuality | null> => {
        const signedUrl = await signHinataSoulR2Url(fetchHttp, cand.r2Url, adPayload);
        if (!signedUrl) return null;
        return {
          label: cand.label,
          height: cand.height,
          url: signedUrl,
          format: 'mp4',
        };
      })
    );

    const streams = signedResults
      .filter((s): s is StreamQuality => Boolean(s))
      .sort((a, b) => b.height - a.height);

    if (!streams.length) {
      return {
        embedUrl: cleanUrl,
        provider: 'Hinata Soul',
        status: 'error',
        streams: [],
        subtitles: [],
        poster,
        referer: HINATASOUL_PLAYER_REFERER,
        errorMessage: 'Não foi possível assinar os streams do Hinata Soul agora.',
      };
    }

    return {
      embedUrl: cleanUrl,
      provider: 'Hinata Soul',
      status: 'resolved',
      streams,
      subtitles: [],
      poster,
      referer: HINATASOUL_PLAYER_REFERER,
      // R2 does not send Access-Control-Allow-Origin headers; use local stream proxy for seamless web CORS + Android Range playback
      preferDirect: false,
    };
  } catch (err) {
    return {
      embedUrl: cleanUrl,
      provider: 'Hinata Soul',
      status: 'error',
      streams: [],
      subtitles: [],
      referer: baseReferer,
      errorMessage: err instanceof Error ? err.message : 'Falha ao consultar o Hinata Soul.',
    };
  }
}
