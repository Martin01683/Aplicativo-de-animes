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
  const titleCandidates: string[] = [];
  const seenTitles = new Set<string>();
  const pushTitle = (raw?: string) => {
    if (!raw) return;
    const cleaned = cleanMalSearchTitle(raw);
    if (!cleaned || cleaned.length < 2) return;
    const norm = normalizeTitleForMatch(cleaned);
    if (!norm || seenTitles.has(norm)) return;
    seenTitles.add(norm);
    titleCandidates.push(cleaned);
  };

  pushTitle(details.originalTitle);
  pushTitle(details.title);
  if (Array.isArray(details.alternativeTitles)) {
    for (const alt of details.alternativeTitles) pushTitle(alt);
  }
  pushTitle(details.alternativeTitle);

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
      const searchQueries = titleCandidates.slice(0, 2);
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
