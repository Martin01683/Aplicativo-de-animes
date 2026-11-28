import type { HttpFetcher } from '../../httpTypes.ts';
import type { AnimeDetails } from '../../types.ts';
import {
  buildExternalDatabaseLinks,
  normalizeTitleForMatch,
  scoreTitleSimilarity,
  type CanonicalMediaType,
} from '../idCodec.ts';

export const MAL_SITE_BASE_URL = 'https://myanimelist.net';
export const MAL_PREFIX_SEARCH_URL = `${MAL_SITE_BASE_URL}/search/prefix.json`;

export interface MyAnimeListRatingResult {
  malId: number;
  score: string;
  url: string;
  matchedTitle?: string;
}

interface MalCacheEntry {
  value: MyAnimeListRatingResult | null;
  expiresAt: number;
}

interface MalFetcherCache {
  entries: Map<string, MalCacheEntry>;
  inFlight: Map<string, Promise<MyAnimeListRatingResult | null>>;
}

const MAL_HIT_TTL_MS = 30 * 60 * 1000;
const MAL_MISS_TTL_MS = 10 * 60 * 1000;
const MAL_MAX_CACHE_ENTRIES = 200;
const MAL_PAGE_TIMEOUT_MS = 3500;
const MAL_SEARCH_TIMEOUT_MS = 3000;

const malCacheByFetcher = new WeakMap<HttpFetcher, MalFetcherCache>();

function getMalCache(fetchHttp: HttpFetcher): MalFetcherCache {
  let cache = malCacheByFetcher.get(fetchHttp);
  if (!cache) {
    cache = {
      entries: new Map(),
      inFlight: new Map(),
    };
    malCacheByFetcher.set(fetchHttp, cache);
  }
  return cache;
}

function readMalCache(cache: MalFetcherCache, key: string): MalCacheEntry | undefined {
  const hit = cache.entries.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    cache.entries.delete(key);
    return undefined;
  }
  return hit;
}

function writeMalCache(
  cache: MalFetcherCache,
  key: string,
  value: MyAnimeListRatingResult | null
): void {
  if (cache.entries.has(key)) {
    cache.entries.delete(key);
  } else if (cache.entries.size >= MAL_MAX_CACHE_ENTRIES) {
    const oldest = cache.entries.keys().next().value;
    if (oldest) cache.entries.delete(oldest);
  }
  cache.entries.set(key, {
    value,
    expiresAt: Date.now() + (value ? MAL_HIT_TTL_MS : MAL_MISS_TTL_MS),
  });
}

/**
 * Extracts a numeric MyAnimeList anime ID from a URL like
 * `https://myanimelist.net/anime/52991/Sousou_no_Frieren`.
 */
export function parseMalIdFromUrl(rawUrl?: string | null): number | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const match = rawUrl.trim().match(/myanimelist\.net\/anime\/(\d+)/i);
  if (!match?.[1]) return null;
  const id = Number.parseInt(match[1], 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/**
 * Normalizes a MyAnimeList score string (e.g. `"9.24"`, `"7.6"` -> `"7.60"`).
 * Rejects `"N/A"`, zero, negative, or >10 values.
 */
export function normalizeMalScore(raw: unknown): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const cleaned = String(raw).trim().replace(',', '.');
  if (!cleaned || /^n\/?a$/i.test(cleaned)) return null;
  const num = Number.parseFloat(cleaned);
  if (!Number.isFinite(num) || num <= 0 || num > 10) return null;
  return num.toFixed(2);
}

/**
 * Parses the live user score from a `https://myanimelist.net/anime/{id}` HTML page.
 */
export function parseMalAnimePageScore(html: string): string | null {
  if (!html) return null;
  const patterns: RegExp[] = [
    /itemprop=["']ratingValue["'][^>]*>\s*([0-9]+(?:[.,][0-9]+)?)\s*</i,
    /class=["'][^"']*\bscore-label\b[^"']*["'][^>]*>\s*([0-9]+(?:[.,][0-9]+)?)\s*</i,
    /"ratingValue"\s*:\s*"?([0-9]+(?:\.[0-9]+)?)"?/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) {
      const normalized = normalizeMalScore(m[1]);
      if (normalized) return normalized;
    }
  }
  return null;
}

interface MalPrefixItem {
  id: number;
  name: string;
  url: string;
  score: string | null;
  mediaType: string;
  startYear: number | null;
}

/**
 * Parses JSON returned by `https://myanimelist.net/search/prefix.json?type=anime&keyword=...`.
 */
export function parseMalPrefixSearchJson(rawJson: string): MalPrefixItem[] {
  if (!rawJson || !rawJson.trim()) return [];
  try {
    const parsed = JSON.parse(rawJson) as {
      categories?: Array<{
        type?: string;
        items?: Array<{
          id?: unknown;
          name?: unknown;
          url?: unknown;
          payload?: {
            score?: unknown;
            media_type?: unknown;
            start_year?: unknown;
          };
        }>;
      }>;
    };
    const categories = Array.isArray(parsed?.categories) ? parsed.categories : [];
    const out: MalPrefixItem[] = [];
    for (const cat of categories) {
      if (cat?.type && cat.type.toLowerCase() !== 'anime') continue;
      const items = Array.isArray(cat?.items) ? cat.items : [];
      for (const item of items) {
        const id = typeof item.id === 'number' ? item.id : Number.parseInt(String(item.id || ''), 10);
        const name = typeof item.name === 'string' ? item.name.trim() : '';
        const url =
          typeof item.url === 'string' && item.url.trim()
            ? item.url.trim()
            : id > 0
              ? `${MAL_SITE_BASE_URL}/anime/${id}`
              : '';
        if (!Number.isFinite(id) || id <= 0 || !name) continue;
        const startYearRaw = item.payload?.start_year;
        const startYear =
          typeof startYearRaw === 'number' && Number.isFinite(startYearRaw)
            ? startYearRaw
            : typeof startYearRaw === 'string' && /^\d{4}$/.test(startYearRaw.trim())
              ? Number.parseInt(startYearRaw.trim(), 10)
              : null;
        out.push({
          id,
          name,
          url,
          score: normalizeMalScore(item.payload?.score),
          mediaType: typeof item.payload?.media_type === 'string' ? item.payload.media_type.trim() : '',
          startYear,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

function cleanMalSearchTitle(raw: string): string {
  return raw
    .replace(/\s*\((?:dublado|legendado|dub|leg|tv|jp|en)\)\s*/gi, ' ')
    .replace(/\s*-\s*(?:dublado|legendado)\s*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function extractTargetYear(details: Pick<AnimeDetails, 'year' | 'firstAirDate'>): number | null {
  const candidates = [details.firstAirDate, details.year];
  for (const raw of candidates) {
    if (!raw) continue;
    const m = raw.match(/\b((?:19|20)\d{2})\b/);
    if (m?.[1]) {
      const y = Number.parseInt(m[1], 10);
      if (Number.isFinite(y) && y >= 1950 && y <= 2100) return y;
    }
  }
  return null;
}

function pickBestMalSearchItem(
  items: readonly MalPrefixItem[],
  queryTitles: readonly string[],
  options: { targetYear?: number | null; isMovie?: boolean }
): MalPrefixItem | null {
  if (items.length === 0 || queryTitles.length === 0) return null;

  let bestItem: MalPrefixItem | null = null;
  let bestScore = -1;

  for (const item of items) {
    let titleSim = 0;
    for (const q of queryTitles) {
      const sim = scoreTitleSimilarity(q, item.name);
      if (sim > titleSim) titleSim = sim;
    }
    if (titleSim < 0.65) continue;

    let total = titleSim * 100;

    // Year alignment strongly disambiguates remakes and sequels
    if (options.targetYear && item.startYear) {
      const diff = Math.abs(options.targetYear - item.startYear);
      if (diff === 0) total += 18;
      else if (diff === 1) total += 8;
      else if (diff >= 3) total -= 18;
    }

    // Media type alignment (Movie vs TV/ONA/OVA, deprioritize Music/PV/CM/Special)
    const mt = item.mediaType.toLowerCase();
    if (options.isMovie) {
      if (mt === 'movie') total += 12;
      else if (mt === 'tv') total -= 8;
    } else {
      if (mt === 'tv' || mt === 'ona') total += 10;
      else if (mt === 'movie') total -= 10;
    }
    if (mt === 'music' || mt === 'cm' || mt === 'pv' || mt === 'tv special') {
      total -= 25;
    }

    // Prefer entries with an actual MAL score over unrated spin-offs/trailers
    if (item.score) {
      total += 6;
    }

    // Exact normalized title match bonus
    const normItem = normalizeTitleForMatch(item.name);
    if (queryTitles.some((q) => normalizeTitleForMatch(q) === normItem)) {
      total += 12;
    }

    if (total > bestScore) {
      bestScore = total;
      bestItem = item;
    }
  }

  return bestScore >= 72 ? bestItem : null;
}

export async function fetchMyAnimeListRatingById(
  fetchHttp: HttpFetcher,
  malId: number
): Promise<MyAnimeListRatingResult | null> {
  if (!Number.isFinite(malId) || malId <= 0) return null;
  const pageUrl = `${MAL_SITE_BASE_URL}/anime/${malId}`;
  try {
    const res = await fetchHttp(pageUrl, {
      accept: 'text/html,application/xhtml+xml,*/*;q=0.9',
      timeoutMs: MAL_PAGE_TIMEOUT_MS,
    });
    if (!res.ok || !res.body) return null;
    const score = parseMalAnimePageScore(res.body);
    if (!score) return null;
    return {
      malId,
      score,
      url: res.finalUrl && /myanimelist\.net\/anime\/\d+/i.test(res.finalUrl) ? res.finalUrl : pageUrl,
    };
  } catch {
    return null;
  }
}

export async function resolveMyAnimeListRating(
  fetchHttp: HttpFetcher,
  details: Pick<
    AnimeDetails,
    | 'title'
    | 'originalTitle'
    | 'alternativeTitle'
    | 'alternativeTitles'
    | 'year'
    | 'firstAirDate'
    | 'kind'
    | 'externalIds'
    | 'myAnimeListUrl'
  >
): Promise<MyAnimeListRatingResult | null> {
  const knownMalId =
    (details.externalIds?.malId && details.externalIds.malId > 0
      ? details.externalIds.malId
      : null) ?? parseMalIdFromUrl(details.myAnimeListUrl);

  // Skip searching live-action TV series on MAL unless an explicit MAL ID/URL is already known
  if (!knownMalId && details.kind === 'series') {
    return null;
  }

  const targetYear = extractTargetYear(details);
  const latinCandidates: string[] = [];
  const nonLatinCandidates: string[] = [];
  const seenTitles = new Set<string>();
  const pushTitle = (raw?: string) => {
    if (!raw) return;
    const cleaned = cleanMalSearchTitle(raw);
    if (!cleaned || cleaned.length < 2) return;
    const norm = normalizeTitleForMatch(cleaned);
    if (!norm || seenTitles.has(norm)) return;
    seenTitles.add(norm);
    // MAL prefix search indexes Romaji & English much better than pure CJK kanji/kana
    if (/[A-Za-z]/.test(cleaned)) {
      latinCandidates.push(cleaned);
    } else {
      nonLatinCandidates.push(cleaned);
    }
  };

  pushTitle(details.alternativeTitle);
  if (Array.isArray(details.alternativeTitles)) {
    for (const alt of details.alternativeTitles) pushTitle(alt);
  }
  pushTitle(details.title);
  pushTitle(details.originalTitle);
  const titleCandidates = [...latinCandidates, ...nonLatinCandidates];

  const cacheKey = knownMalId
    ? `id:${knownMalId}`
    : titleCandidates.length > 0
      ? `q:${normalizeTitleForMatch(titleCandidates[0])}|${targetYear || ''}|${details.kind || 'anime'}`
      : '';

  if (!cacheKey) return null;

  const cache = getMalCache(fetchHttp);
  const cached = readMalCache(cache, cacheKey);
  if (cached !== undefined) return cached.value;

  const pending = cache.inFlight.get(cacheKey);
  if (pending) return pending;

  const promise = (async (): Promise<MyAnimeListRatingResult | null> => {
    try {
      // 1. Direct lookup when MAL ID is already known (via TheTVDB or TopAnimes)
      if (knownMalId) {
        const direct = await fetchMyAnimeListRatingById(fetchHttp, knownMalId);
        if (direct) return direct;
      }

      // 2. Lightweight JSON search on myanimelist.net/search/prefix.json
      const isMovie = details.kind === 'movie';
      const searchQueries = titleCandidates.slice(0, 3);
      for (const query of searchQueries) {
        const searchUrl = `${MAL_PREFIX_SEARCH_URL}?type=anime&keyword=${encodeURIComponent(query.slice(0, 80))}`;
        try {
          const res = await fetchHttp(searchUrl, {
            accept: 'application/json, text/plain, */*',
            referer: `${MAL_SITE_BASE_URL}/`,
            timeoutMs: MAL_SEARCH_TIMEOUT_MS,
          });
          if (!res.ok || !res.body) continue;
          const items = parseMalPrefixSearchJson(res.body);
          const match = pickBestMalSearchItem(items, titleCandidates, {
            targetYear,
            isMovie,
          });
          if (!match) continue;
          if (match.score) {
            return {
              malId: match.id,
              score: match.score,
              url: match.url,
              matchedTitle: match.name,
            };
          }
          // Matched entry had no score in prefix payload -> try its direct MAL page once
          const fromPage = await fetchMyAnimeListRatingById(fetchHttp, match.id);
          if (fromPage) {
            return { ...fromPage, matchedTitle: match.name };
          }
        } catch {
          // Try next title candidate or fall back cleanly
        }
      }

      return null;
    } finally {
      cache.inFlight.delete(cacheKey);
    }
  })();

  cache.inFlight.set(cacheKey, promise);
  const resolved = await promise;
  writeMalCache(cache, cacheKey, resolved);
  return resolved;
}

/**
 * Enriches an `AnimeDetails` object with its live MyAnimeList score (`https://myanimelist.net/`),
 * preserving the streaming provider's rating as fallback whenever MAL has no score or is unreachable.
 */
export async function enrichDetailsWithMyAnimeListRating(
  fetchHttp: HttpFetcher,
  details: AnimeDetails
): Promise<AnimeDetails> {
  const providerFallbackRating = details.rating?.trim() || undefined;
  const resolved = await resolveMyAnimeListRating(fetchHttp, details).catch(() => null);

  if (!resolved) {
    if (providerFallbackRating && !details.ratingSource) {
      return {
        ...details,
        rating: providerFallbackRating,
        ratingSource: 'provider',
      };
    }
    return details;
  }

  const mergedIds = {
    ...(details.externalIds || {}),
    malId: details.externalIds?.malId || resolved.malId,
  };
  const mediaType: CanonicalMediaType =
    details.kind === 'movie' ? 'movie' : details.kind === 'series' ? 'series' : 'anime';

  return {
    ...details,
    rating: resolved.score,
    ratingSource: 'myanimelist',
    myAnimeListUrl: details.myAnimeListUrl || resolved.url,
    externalIds: mergedIds,
    externalLinks: buildExternalDatabaseLinks(mergedIds, { mediaType }),
  };
}

export interface MyAnimeListFallbackDetails {
  malId: number;
  url: string;
  title?: string;
  poster?: string;
  synopsis?: string;
  genres: string[];
  rating?: string;
  year?: string;
  status?: string;
  studio?: string;
  episodesTotalCount?: string;
}

const MAL_GENRE_PT_MAP: Record<string, string> = {
  action: 'Ação',
  adventure: 'Aventura',
  comedy: 'Comédia',
  drama: 'Drama',
  ecchi: 'Ecchi',
  fantasy: 'Fantasia',
  horror: 'Terror',
  'mahou shoujo': 'Garotas Mágicas',
  mecha: 'Mecha',
  music: 'Música',
  mystery: 'Mistério',
  psychological: 'Psicológico',
  romance: 'Romance',
  'sci-fi': 'Ficção Científica',
  'slice of life': 'Cotidiano',
  sports: 'Esportes',
  supernatural: 'Sobrenatural',
  suspense: 'Suspense',
  thriller: 'Suspense',
  'avant garde': 'Vanguarda',
  gourmet: 'Gastronomia',
  'award winning': 'Premiado',
  'boys love': 'Boys Love',
  'girls love': 'Girls Love',
};

function decodeHtmlEntitiesBasic(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function translateMalGenreToPt(raw: string): string {
  const clean = decodeHtmlEntitiesBasic(raw);
  if (!clean) return '';
  return MAL_GENRE_PT_MAP[clean.toLowerCase()] || clean;
}

/**
 * Parses metadata fields from a MyAnimeList anime page HTML for fallback use
 * when TheTVDB and AniList do not have an entry (or when genres are missing).
 */
export function parseMalAnimePageMetadata(
  html: string,
  malId: number,
  pageUrl: string
): MyAnimeListFallbackDetails | null {
  if (!html) return null;

  const titleMatch =
    html.match(/<h1[^>]*class=["'][^"']*title-name[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i) ||
    html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
  const title = titleMatch?.[1]
    ? decodeHtmlEntitiesBasic(titleMatch[1].replace(/<[^>]+>/g, ''))
        .replace(/\s*-\s*MyAnimeList\.net$/i, '')
        .trim()
    : undefined;

  const posterMatch =
    html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i) ||
    html.match(/<img[^>]*data-src=["'](https:\/\/cdn\.myanimelist\.net\/images\/anime\/[^"']+)["']/i);
  const poster = posterMatch?.[1]?.trim() || undefined;

  const synopsisMatch = html.match(
    /<p[^>]*itemprop=["']description["'][^>]*>([\s\S]*?)<\/p>/i
  );
  const rawSynopsis = synopsisMatch?.[1]
    ? decodeHtmlEntitiesBasic(
        synopsisMatch[1]
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/\[Written by MAL Rewrite\]/gi, '')
      )
    : '';
  const synopsis =
    rawSynopsis && !/^No synopsis information has been added/i.test(rawSynopsis)
      ? rawSynopsis
      : undefined;

  const genres: string[] = [];
  const seenGenres = new Set<string>();
  const genreRe = /<span[^>]*itemprop=["']genre["'][^>]*>([^<]+)<\/span>/gi;
  let gm: RegExpExecArray | null;
  while ((gm = genreRe.exec(html)) !== null) {
    const translated = translateMalGenreToPt(gm[1] || '');
    if (!translated) continue;
    const key = translated.toLowerCase();
    if (seenGenres.has(key)) continue;
    seenGenres.add(key);
    genres.push(translated);
  }

  const score = parseMalAnimePageScore(html) || undefined;

  const airedMatch = html.match(/Aired:<\/span>\s*[^<]*\b((?:19|20)\d{2})\b/i);
  const year = airedMatch?.[1] || undefined;

  const statusMatch = html.match(/Status:<\/span>\s*([^<\n]+)/i);
  const rawStatus = statusMatch?.[1]?.trim().toLowerCase() || '';
  const status = rawStatus.includes('currently airing')
    ? 'Em exibição'
    : rawStatus.includes('finished airing')
      ? 'Finalizado'
      : rawStatus.includes('not yet aired')
        ? 'Em breve'
        : undefined;

  const episodesMatch = html.match(/Episodes:<\/span>\s*(\d+)/i);
  const episodesTotalCount = episodesMatch?.[1] || undefined;

  const studioMatch = html.match(
    /Studios?:<\/span>[\s\S]{0,240}?<a[^>]*>([^<]+)<\/a>/i
  );
  const studioRaw = studioMatch?.[1] ? decodeHtmlEntitiesBasic(studioMatch[1]) : '';
  const studio = studioRaw && !/none found|add some/i.test(studioRaw) ? studioRaw : undefined;

  if (!title && !poster && !synopsis && genres.length === 0 && !score) {
    return null;
  }

  return {
    malId,
    url: pageUrl,
    title,
    poster,
    synopsis,
    genres,
    rating: score,
    year,
    status,
    studio,
    episodesTotalCount,
  };
}

/**
 * Fetches MyAnimeList metadata as the 3rd fallback layer (`TVDB > AniList > MyAnimeList > Providers`)
 * and 3rd genre fallback (`AniList > TVDB > MyAnimeList > Providers`).
 */
export async function fetchMyAnimeListFallbackDetails(
  fetchHttp: HttpFetcher,
  lookup: Pick<
    AnimeDetails,
    | 'title'
    | 'originalTitle'
    | 'alternativeTitle'
    | 'alternativeTitles'
    | 'year'
    | 'firstAirDate'
    | 'kind'
    | 'externalIds'
    | 'myAnimeListUrl'
  >
): Promise<MyAnimeListFallbackDetails | null> {
  const knownMalId =
    (lookup.externalIds?.malId && lookup.externalIds.malId > 0
      ? lookup.externalIds.malId
      : null) ?? parseMalIdFromUrl(lookup.myAnimeListUrl);

  let malId = knownMalId;
  let pageUrl = malId ? `${MAL_SITE_BASE_URL}/anime/${malId}` : '';

  if (!malId) {
    const resolved = await resolveMyAnimeListRating(fetchHttp, lookup).catch(() => null);
    if (!resolved) return null;
    malId = resolved.malId;
    pageUrl = resolved.url || `${MAL_SITE_BASE_URL}/anime/${malId}`;
  }

  try {
    const res = await fetchHttp(pageUrl, {
      accept: 'text/html,application/xhtml+xml,*/*;q=0.9',
      timeoutMs: MAL_PAGE_TIMEOUT_MS,
    });
    if (!res.ok || !res.body) return null;
    const finalUrl =
      res.finalUrl && /myanimelist\.net\/anime\/\d+/i.test(res.finalUrl) ? res.finalUrl : pageUrl;
    return parseMalAnimePageMetadata(res.body, malId, finalUrl);
  } catch {
    return null;
  }
}

/**
 * Applies MyAnimeList metadata strictly as fallback for missing fields (`TVDB > AniList > MyAnimeList > Providers`)
 * and for genres when neither AniList nor TheTVDB provided them (`AniList > TVDB > MyAnimeList > Providers`).
 */
export async function enrichDetailsWithMyAnimeListFallback(
  fetchHttp: HttpFetcher,
  details: AnimeDetails,
  options: { forceWhenMissingCoreInfo?: boolean } = {}
): Promise<AnimeDetails> {
  if (details.kind === 'series' && !details.externalIds?.malId && !details.myAnimeListUrl) {
    return details;
  }

  const hasAuthoritativeGenres =
    details.genres.length > 0 &&
    (details.genresSource === 'anilist' || details.genresSource === 'thetvdb');
  const hasTvdbOrAniList = Boolean(
    details.enrichmentSources?.includes('thetvdb') ||
      details.enrichmentSources?.includes('anilist')
  );
  const needsFallback =
    options.forceWhenMissingCoreInfo ||
    !hasTvdbOrAniList ||
    !hasAuthoritativeGenres ||
    !details.poster ||
    !details.synopsis;

  if (!needsFallback) {
    return details;
  }

  const malMeta = await fetchMyAnimeListFallbackDetails(fetchHttp, details).catch(() => null);
  if (!malMeta) return details;

  const mergedIds = {
    ...(details.externalIds || {}),
    malId: details.externalIds?.malId || malMeta.malId,
  };
  const mediaType: CanonicalMediaType =
    details.kind === 'movie' ? 'movie' : details.kind === 'series' ? 'series' : 'anime';

  const useMalGenres = !hasAuthoritativeGenres && malMeta.genres.length > 0;
  const nextEnrichmentSources = Array.from(
    new Set([...(details.enrichmentSources || []), 'myanimelist' as const])
  );

  return {
    ...details,
    title: hasTvdbOrAniList ? details.title : malMeta.title || details.title,
    poster: hasTvdbOrAniList ? details.poster || malMeta.poster || '' : malMeta.poster || details.poster,
    fallbackPoster:
      !hasTvdbOrAniList && malMeta.poster && details.poster && details.poster !== malMeta.poster
        ? details.fallbackPoster || details.poster
        : details.fallbackPoster,
    backdrop:
      details.backdrop ||
      (hasTvdbOrAniList ? malMeta.poster || '' : malMeta.poster || details.poster),
    synopsis: hasTvdbOrAniList
      ? details.synopsis || malMeta.synopsis || ''
      : malMeta.synopsis || details.synopsis,
    year: details.year || malMeta.year,
    status: details.status || malMeta.status,
    studio: details.studio || malMeta.studio,
    episodesTotalCount: details.episodesTotalCount || malMeta.episodesTotalCount,
    genres: useMalGenres ? malMeta.genres : details.genres,
    genresSource: useMalGenres ? 'myanimelist' : details.genresSource,
    rating: details.ratingSource === 'myanimelist' ? details.rating : malMeta.rating || details.rating,
    ratingSource:
      details.ratingSource === 'myanimelist'
        ? details.ratingSource
        : malMeta.rating
          ? 'myanimelist'
          : details.ratingSource,
    myAnimeListUrl: details.myAnimeListUrl || malMeta.url,
    enrichmentSources: nextEnrichmentSources,
    externalIds: mergedIds,
    externalLinks: buildExternalDatabaseLinks(mergedIds, { mediaType }),
  };
}

