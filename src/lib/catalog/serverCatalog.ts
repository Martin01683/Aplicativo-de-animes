import type { HttpFetcher } from '../httpTypes.ts';
import {
  extractHinataSoulSeasonNumber,
  parseHinataSoulCatalogHtml,
  parseHinataSoulHomeHtml,
  parseHinataSoulSearchHtml,
} from '../hinatasoulParser.ts';
import { fetchHinataSoulAnimeWithEpisodes } from '../sources/providers/hinatasoulSource.ts';
import {
  HINATASOUL_BUILTIN_SOURCE,
  TOPANIMES_BUILTIN_SOURCE,
} from '../sources/types.ts';
import {
  extractDooPlayNonce,
  inferMediaKindFromUrl,
  parseAnimePageHtml,
  parseCatalogArchiveHtml,
  parseEpisodesArchiveHtml,
  parseHomeHtml,
  parseSearchPageHtml,
  parseWpGlossaryJson,
  parseWpSearchJson,
} from '../topanimesParser.ts';
import type {
  AnimeDetails,
  AudioType,
  CatalogArchiveCategory,
  CatalogFilters,
  CatalogMediaItem,
  GlossaryResponse,
  HomeCatalog,
  MediaKind,
  PaginatedCatalogResponse,
  PaginatedSearchResponse,
  SearchResultItem,
} from '../types.ts';
import {
  isHinataSoulUrl,
  normalizeHinataSoulUrl,
  normalizeTopAnimesUrl,
} from '../urlSafety.ts';
import {
  normalizeTitleForMatch,
  scoreTitleSimilarity,
  stripSeasonFromTitle,
} from './idCodec.ts';

export type SnapshotAssetReader = (assetFileName: string) => Promise<string | null>;

const SNAPSHOT_FILES = {
  home: 'captura-topanimes.net-20261120-185536_c8f54b4e.html',
  episodes: 'captura-topanimes.net-20261120-193317_58010c0a.html',
  animes: 'captura-topanimes.net-20261120-194623_978b4a6c.html',
  movies: 'captura-topanimes.net-20261120-194902_e963a754.html',
} as const;

const nonceCacheByOrigin = new Map<string, { value: string; expiresAt: number }>();
const NONCE_TTL_MS = 25 * 60 * 1000;

function rememberNonce(origin: string, html: string): string | null {
  const found = extractDooPlayNonce(html);
  if (found) {
    nonceCacheByOrigin.set(origin, { value: found, expiresAt: Date.now() + NONCE_TTL_MS });
  }
  return found;
}

async function getDooPlayNonceForOrigin(
  fetchHttp: HttpFetcher,
  origin: string,
  forceRefresh = false
): Promise<string | null> {
  if (!forceRefresh) {
    const cached = nonceCacheByOrigin.get(origin);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
  }
  try {
    const res = await fetchHttp(`${origin}/`, {
      referer: `${origin}/`,
      timeoutMs: 8000,
    });
    if (res.ok) {
      return rememberNonce(origin, res.body);
    }
  } catch {
    // ignore
  }
  return null;
}

function tagServerItems(items: CatalogMediaItem[], serverName: string): CatalogMediaItem[] {
  return items.map((item) => ({
    ...item,
    catalogSource: 'server',
    sourceServerName: item.sourceServerName || serverName,
  }));
}

function tagServerSearchItems(items: SearchResultItem[], serverName: string): SearchResultItem[] {
  return items.map((item) => ({
    ...item,
    catalogSource: 'server',
    sourceServerName: item.sourceServerName || serverName,
  }));
}

function cleanText(raw?: string): string {
  return String(raw || '').replace(/\s+/g, ' ').trim();
}

function canonicalServerUrlKey(url: string): string {
  if (isHinataSoulUrl(url)) return normalizeHinataSoulUrl(url) || url;
  return normalizeTopAnimesUrl(url) || url;
}

function mergeCatalogItemsByUrl(
  primary: readonly CatalogMediaItem[],
  secondary: readonly CatalogMediaItem[],
  dedupeByTitleAndAudio = false
): CatalogMediaItem[] {
  const seenUrl = new Set<string>();
  const seenSig = new Set<string>();
  const out: CatalogMediaItem[] = [];

  const add = (item: CatalogMediaItem, checkSig: boolean) => {
    const key = canonicalServerUrlKey(item.url);
    if (!key || seenUrl.has(key)) return;
    const sig = dedupeByTitleAndAudio
      ? `${normalizeTitleForMatch(item.title)}::${item.episodeLabel ? item.episodeLabel.replace(/\D+/g, '') : ''}::${item.audioType || 'LEG'}`
      : '';
    if (checkSig && sig && seenSig.has(sig)) return;
    seenUrl.add(key);
    if (sig) seenSig.add(sig);
    out.push(item);
  };

  for (const item of primary) add(item, false);
  for (const item of secondary) add(item, dedupeByTitleAndAudio);
  return out;
}

async function getFallbackFilters(snapshotReader?: SnapshotAssetReader): Promise<CatalogFilters | undefined> {
  if (!snapshotReader) return undefined;
  try {
    const html = await snapshotReader(SNAPSHOT_FILES.animes);
    if (!html) return undefined;
    return parseCatalogArchiveHtml(html, 'anime').filters;
  } catch {
    return undefined;
  }
}

const HINATASOUL_HOME_DEDUPE_TTL_MS = 30 * 1000;
const HINATASOUL_SEARCH_DEDUPE_TTL_MS = 60 * 1000;

interface DedupeCacheSlot<T> {
  value?: T;
  expiresAt: number;
  inFlight?: Promise<T>;
}

const hsHomeDedupeByFetcher = new WeakMap<HttpFetcher, DedupeCacheSlot<HomeCatalog | null>>();
const hsSearchDedupeByFetcher = new WeakMap<
  HttpFetcher,
  Map<string, DedupeCacheSlot<{ results: SearchResultItem[]; totalPages: number }>>
>();

async function fetchHinataSoulHomeSafe(fetchHttp: HttpFetcher): Promise<HomeCatalog | null> {
  const now = Date.now();
  const existing = hsHomeDedupeByFetcher.get(fetchHttp);
  if (existing) {
    if (existing.expiresAt > now && existing.value !== undefined) {
      return existing.value;
    }
    if (existing.inFlight) {
      return existing.inFlight;
    }
  }

  const hsOrigin = HINATASOUL_BUILTIN_SOURCE.baseUrl.replace(/\/+$/, '');
  const req = (async (): Promise<HomeCatalog | null> => {
    try {
      const res = await fetchHttp(`${hsOrigin}/`, {
        referer: `${hsOrigin}/`,
        timeoutMs: 9000,
      });
      if (!res.ok) return null;
      const parsed = parseHinataSoulHomeHtml(res.body, 'live', hsOrigin);
      if (
        parsed.releases.length > 0 ||
        parsed.animes.length > 0 ||
        parsed.movies.length > 0 ||
        (parsed.series && parsed.series.length > 0)
      ) {
        return parsed;
      }
    } catch {
      // Ignore Hinata Soul transient errors so TopAnimes still loads cleanly
    }
    return null;
  })();

  const slot: DedupeCacheSlot<HomeCatalog | null> = { expiresAt: 0, inFlight: req };
  hsHomeDedupeByFetcher.set(fetchHttp, slot);

  try {
    const value = await req;
    if (value) {
      slot.value = value;
      slot.expiresAt = Date.now() + HINATASOUL_HOME_DEDUPE_TTL_MS;
    }
    return value;
  } finally {
    slot.inFlight = undefined;
  }
}

/**
 * Loads the Home catalog from all integrated streaming servers (TopAnimes + Hinata Soul).
 */
export async function getServerHomeCatalog(
  fetchHttp: HttpFetcher,
  snapshotReader?: SnapshotAssetReader
): Promise<HomeCatalog> {
  const topSource = TOPANIMES_BUILTIN_SOURCE;
  const topOrigin = topSource.baseUrl.replace(/\/+$/, '');

  const [topParsed, hsParsed] = await Promise.all([
    (async (): Promise<HomeCatalog | null> => {
      try {
        const res = await fetchHttp(`${topOrigin}/`, {
          referer: `${topOrigin}/`,
          timeoutMs: 9000,
        });
        if (!res.ok) return null;
        rememberNonce(topOrigin, res.body);
        const parsed = parseHomeHtml(res.body, 'live');
        if (parsed.releases.length > 0 || parsed.animes.length > 0) {
          return {
            calendar: tagServerItems(parsed.calendar, topSource.name),
            releases: tagServerItems(parsed.releases, topSource.name),
            animes: tagServerItems(parsed.animes, topSource.name),
            movies: tagServerItems(parsed.movies, topSource.name),
            series: [],
            sourcesUsed: ['server'],
            sourceMode: 'live',
            fetchedAt: parsed.fetchedAt,
          };
        }
      } catch {
        // Fall through
      }
      return null;
    })(),
    fetchHinataSoulHomeSafe(fetchHttp),
  ]);

  if (topParsed || hsParsed) {
    return {
      calendar: topParsed?.calendar || [],
      releases: mergeCatalogItemsByUrl(
        topParsed?.releases || [],
        hsParsed?.releases || [],
        true
      ),
      animes: mergeCatalogItemsByUrl(
        topParsed?.animes || [],
        hsParsed?.animes || [],
        true
      ),
      movies: mergeCatalogItemsByUrl(
        topParsed?.movies || [],
        hsParsed?.movies || [],
        true
      ),
      series: mergeCatalogItemsByUrl(
        topParsed?.series || [],
        hsParsed?.series || [],
        true
      ),
      sourcesUsed: ['server'],
      sourceMode: 'live',
      fetchedAt: topParsed?.fetchedAt || hsParsed?.fetchedAt || new Date().toISOString(),
    };
  }

  if (snapshotReader) {
    try {
      const snapHtml = await snapshotReader(SNAPSHOT_FILES.home);
      if (snapHtml) {
        const parsed = parseHomeHtml(snapHtml, 'snapshot');
        return {
          calendar: tagServerItems(parsed.calendar, topSource.name),
          releases: tagServerItems(parsed.releases, topSource.name),
          animes: tagServerItems(parsed.animes, topSource.name),
          movies: tagServerItems(parsed.movies, topSource.name),
          series: [],
          sourcesUsed: ['server'],
          sourceMode: 'snapshot',
          fetchedAt: parsed.fetchedAt,
        };
      }
    } catch {
      // ignore
    }
  }

  return {
    calendar: [],
    releases: [],
    animes: [],
    movies: [],
    series: [],
    sourcesUsed: ['server'],
    sourceMode: 'snapshot',
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Loads paginated recently-released episodes from the integrated servers (TopAnimes + Hinata Soul).
 */
export async function getServerRecentEpisodes(
  fetchHttp: HttpFetcher,
  page = 1,
  snapshotReader?: SnapshotAssetReader
): Promise<PaginatedCatalogResponse> {
  const safePage = Math.max(1, page);
  const topSource = TOPANIMES_BUILTIN_SOURCE;
  const origin = topSource.baseUrl.replace(/\/+$/, '');
  const targetUrl =
    safePage > 1 ? `${origin}/episodio/page/${safePage}/` : `${origin}/episodio/`;

  const [topResult, hsReleases] = await Promise.all([
    (async () => {
      try {
        const res = await fetchHttp(targetUrl, {
          referer: `${origin}/`,
          timeoutMs: 9000,
        });
        if (!res.ok) return null;
        rememberNonce(origin, res.body);
        const parsed = parseEpisodesArchiveHtml(res.body);
        return {
          items: tagServerItems(parsed.items, topSource.name),
          currentPage: parsed.currentPage,
          totalPages: parsed.totalPages,
        };
      } catch {
        return null;
      }
    })(),
    safePage === 1
      ? fetchHinataSoulHomeSafe(fetchHttp).then((h) => h?.releases || [])
      : Promise.resolve([] as CatalogMediaItem[]),
  ]);

  if (topResult || hsReleases.length > 0) {
    const merged = mergeCatalogItemsByUrl(topResult?.items || [], hsReleases, true);
    return {
      items: merged,
      currentPage: topResult?.currentPage || safePage,
      totalPages: topResult?.totalPages || 1,
      catalogSource: 'server',
      sourceMode: 'live',
    };
  }

  if (safePage === 1 && snapshotReader) {
    try {
      const snapHtml = await snapshotReader(SNAPSHOT_FILES.episodes);
      if (snapHtml) {
        const parsed = parseEpisodesArchiveHtml(snapHtml);
        return {
          items: tagServerItems(parsed.items, topSource.name),
          currentPage: parsed.currentPage,
          totalPages: parsed.totalPages,
          catalogSource: 'server',
          sourceMode: 'snapshot',
        };
      }
    } catch {
      // ignore
    }
  }

  const home = await getServerHomeCatalog(fetchHttp, snapshotReader);
  return {
    items: safePage === 1 ? home.releases : [],
    currentPage: safePage,
    totalPages: 1,
    catalogSource: 'server',
    sourceMode: home.sourceMode,
  };
}

function getHinataSoulCategoryPath(category: CatalogArchiveCategory): string | null {
  switch (category) {
    case 'animes':
    case 'legendado':
      return '/animes';
    case 'dublado':
      return '/anime-dublado';
    case 'donghua':
      return '/donghua';
    case 'series':
      return '/doramas';
    case 'live-action':
      return '/tokusatsus';
    default:
      return null;
  }
}

/**
 * Loads paginated catalog archives from the integrated servers (TopAnimes + Hinata Soul).
 */
export async function getServerCatalogPage(
  fetchHttp: HttpFetcher,
  params: {
    category: CatalogArchiveCategory;
    genre?: string;
    year?: string;
    page?: number;
  },
  snapshotReader?: SnapshotAssetReader
): Promise<PaginatedCatalogResponse> {
  const safePage = Math.max(1, params.page || 1);
  const genre = (params.genre || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  const year = /^\d{4}$/.test(params.year || '') ? String(params.year) : '';
  const topSource = TOPANIMES_BUILTIN_SOURCE;
  const topOrigin = topSource.baseUrl.replace(/\/+$/, '');
  const hsSource = HINATASOUL_BUILTIN_SOURCE;
  const hsOrigin = hsSource.baseUrl.replace(/\/+$/, '');
  const defaultKind: MediaKind =
    params.category === 'movies'
      ? 'movie'
      : params.category === 'series' || params.category === 'live-action'
        ? 'series'
        : 'anime';
  const forcedAudio: AudioType =
    params.category === 'dublado'
      ? 'DUB'
      : params.category === 'legendado'
        ? 'LEG'
        : null;

  let basePath: string;
  if (genre) {
    basePath = `/genero/${genre}`;
  } else if (year) {
    basePath = `/l/${year}`;
  } else if (params.category === 'movies') {
    basePath = '/filmes';
  } else if (params.category === 'animes' || params.category === 'series') {
    basePath = '/animes';
  } else {
    basePath = `/tipo/${params.category}`;
  }

  const topTargetUrl =
    safePage > 1 ? `${topOrigin}${basePath}/page/${safePage}/` : `${topOrigin}${basePath}/`;

  const hsBasePath = !genre && !year ? getHinataSoulCategoryPath(params.category) : null;
  const hsTargetUrl = hsBasePath
    ? safePage > 1
      ? `${hsOrigin}${hsBasePath}/page/${safePage}`
      : `${hsOrigin}${hsBasePath}`
    : null;

  const [topParsed, hsParsed] = await Promise.all([
    (async () => {
      try {
        const res = await fetchHttp(topTargetUrl, {
          referer: `${topOrigin}/`,
          timeoutMs: 10000,
        });
        if (!res.ok) return null;
        rememberNonce(topOrigin, res.body);
        return parseCatalogArchiveHtml(res.body, defaultKind, forcedAudio);
      } catch {
        return null;
      }
    })(),
    hsTargetUrl
      ? (async () => {
          try {
            const res = await fetchHttp(hsTargetUrl, {
              referer: `${hsOrigin}/`,
              timeoutMs: 9000,
            });
            if (!res.ok) return null;
            return parseHinataSoulCatalogHtml(
              res.body,
              defaultKind,
              forcedAudio,
              safePage,
              hsOrigin
            );
          } catch {
            return null;
          }
        })()
      : Promise.resolve(null),
  ]);

  if (topParsed || (hsParsed && hsParsed.items.length > 0)) {
    const topItems = topParsed ? tagServerItems(topParsed.items, topSource.name) : [];
    const hsItems = hsParsed ? tagServerItems(hsParsed.items, hsSource.name) : [];
    const mergedItems = mergeCatalogItemsByUrl(topItems, hsItems, false);
    const fallbackFilters =
      topParsed && topParsed.filters.genres.length > 0
        ? topParsed.filters
        : await getFallbackFilters(snapshotReader);

    return {
      items: mergedItems,
      featured: topParsed ? tagServerItems(topParsed.featured, topSource.name) : [],
      sliderMovies: topParsed?.sliderMovies || [],
      filters: fallbackFilters,
      currentPage: topParsed?.currentPage || hsParsed?.currentPage || safePage,
      totalPages: Math.max(topParsed?.totalPages || 1, hsParsed?.totalPages || 1),
      catalogSource: 'server',
      sourceMode: 'live',
    };
  }

  // Snapshot fallback (just like main branch)
  if (safePage === 1 && !genre && !year && snapshotReader) {
    const snapName = params.category === 'movies' ? SNAPSHOT_FILES.movies : SNAPSHOT_FILES.animes;
    try {
      const snapHtml = await snapshotReader(snapName);
      if (snapHtml) {
        const parsed = parseCatalogArchiveHtml(snapHtml, defaultKind, forcedAudio);
        return {
          items: tagServerItems(parsed.items, topSource.name),
          featured: tagServerItems(parsed.featured, topSource.name),
          sliderMovies: parsed.sliderMovies,
          filters: parsed.filters,
          currentPage: parsed.currentPage,
          totalPages: parsed.totalPages,
          catalogSource: 'server',
          sourceMode: 'snapshot',
        };
      }
    } catch {
      // ignore
    }
  }

  return {
    items: [],
    filters: await getFallbackFilters(snapshotReader),
    currentPage: safePage,
    totalPages: 1,
    catalogSource: 'server',
    sourceMode: 'snapshot',
  };
}

/**
 * Loads alphabetical A-Z glossary from the integrated servers (TopAnimes + Hinata Soul).
 */
export async function getServerGlossary(
  fetchHttp: HttpFetcher,
  rawTerm: string,
  rawType = 'all',
  snapshotReader?: SnapshotAssetReader
): Promise<GlossaryResponse> {
  const lower = rawTerm.trim().toLowerCase();
  const isNumericBucket = lower === '#' || lower === '09' || lower === '0-9';
  const apiTerm = isNumericBucket ? '09' : /^[a-z]$/.test(lower) ? lower : '';
  const displayTerm = isNumericBucket ? '#' : apiTerm.toUpperCase();
  const type = ['all', 'tvshows', 'movies'].includes(rawType.toLowerCase())
    ? rawType.toLowerCase()
    : 'all';

  if (!apiTerm) {
    return { term: rawTerm, type, items: [], sourceMode: 'fallback' };
  }

  const topSource = TOPANIMES_BUILTIN_SOURCE;
  const topOrigin = topSource.baseUrl.replace(/\/+$/, '');
  const hsSource = HINATASOUL_BUILTIN_SOURCE;
  const hsOrigin = hsSource.baseUrl.replace(/\/+$/, '');

  const [topItems, hsItems] = await Promise.all([
    (async (): Promise<CatalogMediaItem[] | null> => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const nonce = await getDooPlayNonceForOrigin(fetchHttp, topOrigin, attempt > 0);
          if (!nonce) break;
          const apiUrl = `${topOrigin}/wp-json/dooplay/glossary/?term=${encodeURIComponent(
            apiTerm
          )}&nonce=${encodeURIComponent(nonce)}&type=${encodeURIComponent(type)}`;
          const res = await fetchHttp(apiUrl, {
            referer: `${topOrigin}/animes/`,
            accept: 'application/json,*/*;q=0.9',
            timeoutMs: 8000,
          });
          if (!res.ok) {
            if (attempt === 0) continue;
            break;
          }
          const rawJson = JSON.parse(res.body) as Record<string, unknown>;
          if (rawJson && typeof rawJson === 'object' && 'error' in rawJson) {
            if (attempt === 0 && /nonce|invalid|security/i.test(String(rawJson.error || ''))) {
              continue;
            }
            return [];
          }
          return tagServerItems(
            parseWpGlossaryJson(rawJson as Parameters<typeof parseWpGlossaryJson>[0]),
            topSource.name
          );
        } catch {
          if (attempt === 0) continue;
        }
      }
      return null;
    })(),
    type !== 'movies'
      ? (async (): Promise<CatalogMediaItem[] | null> => {
          try {
            const letterSegment = isNumericBucket ? 'numeros' : apiTerm;
            const res = await fetchHttp(`${hsOrigin}/animes/letra/${letterSegment}`, {
              referer: `${hsOrigin}/`,
              timeoutMs: 8000,
            });
            if (!res.ok) return null;
            const parsed = parseHinataSoulCatalogHtml(res.body, 'anime', 'LEG', 1, hsOrigin);
            return tagServerItems(parsed.items, hsSource.name);
          } catch {
            return null;
          }
        })()
      : Promise.resolve(null),
  ]);

  if (topItems !== null || hsItems !== null) {
    const merged = mergeCatalogItemsByUrl(topItems || [], hsItems || [], false);
    return { term: displayTerm, type, items: merged, sourceMode: 'live' };
  }

  // Fallback filter over home catalog
  try {
    const home = await getServerHomeCatalog(fetchHttp, snapshotReader);
    const pool: CatalogMediaItem[] =
      type === 'movies'
        ? home.movies
        : type === 'tvshows'
          ? [...home.animes, ...home.calendar]
          : [...home.animes, ...home.calendar, ...home.movies];
    const seen = new Set<string>();
    const items = pool.filter((item) => {
      if (seen.has(item.url)) return false;
      const firstChar = item.title.trim().charAt(0).toLowerCase();
      const matches = isNumericBucket ? /^[^a-z]$/.test(firstChar) : firstChar === apiTerm;
      if (!matches) return false;
      seen.add(item.url);
      return true;
    });
    return { term: displayTerm, type, items, sourceMode: 'fallback' };
  } catch {
    return { term: displayTerm, type, items: [], sourceMode: 'fallback' };
  }
}

function dedupeSearchResults(list: SearchResultItem[]): SearchResultItem[] {
  const seen = new Set<string>();
  const out: SearchResultItem[] = [];
  for (const item of list) {
    const key = canonicalServerUrlKey(item.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

async function fetchHinataSoulSearchSafe(
  fetchHttp: HttpFetcher,
  query: string,
  page = 1
): Promise<{ results: SearchResultItem[]; totalPages: number }> {
  const cacheKey = `${query.trim().toLowerCase()}::p${page}`;
  let map = hsSearchDedupeByFetcher.get(fetchHttp);
  if (!map) {
    map = new Map();
    hsSearchDedupeByFetcher.set(fetchHttp, map);
  }

  const now = Date.now();
  const existing = map.get(cacheKey);
  if (existing) {
    if (existing.expiresAt > now && existing.value !== undefined) {
      return existing.value;
    }
    if (existing.inFlight) {
      return existing.inFlight;
    }
  }

  const hsSource = HINATASOUL_BUILTIN_SOURCE;
  const hsOrigin = hsSource.baseUrl.replace(/\/+$/, '');
  const targetUrl =
    page > 1
      ? `${hsOrigin}/busca?busca=${encodeURIComponent(query)}&page=${page}`
      : `${hsOrigin}/busca?busca=${encodeURIComponent(query)}`;

  const req = (async (): Promise<{ results: SearchResultItem[]; totalPages: number }> => {
    try {
      const res = await fetchHttp(targetUrl, {
        referer: `${hsOrigin}/`,
        timeoutMs: 8000,
      });
      if (!res.ok) return { results: [], totalPages: 1 };
      const parsed = parseHinataSoulSearchHtml(res.body, page, hsOrigin);
      return {
        results: tagServerSearchItems(parsed.results, hsSource.name),
        totalPages: parsed.totalPages,
      };
    } catch {
      return { results: [], totalPages: 1 };
    }
  })();

  if (map.size > 60) {
    const oldest = map.keys().next().value;
    if (oldest) map.delete(oldest);
  }
  const slot: DedupeCacheSlot<{ results: SearchResultItem[]; totalPages: number }> = {
    expiresAt: 0,
    inFlight: req,
  };
  map.set(cacheKey, slot);

  try {
    const value = await req;
    slot.value = value;
    slot.expiresAt = Date.now() + HINATASOUL_SEARCH_DEDUPE_TTL_MS;
    return value;
  } finally {
    slot.inFlight = undefined;
  }
}

/**
 * Fast autocomplete search across all integrated streaming servers (TopAnimes + Hinata Soul).
 */
export async function getServerSearchSuggest(
  fetchHttp: HttpFetcher,
  rawQuery: string
): Promise<{ query: string; results: SearchResultItem[]; sourceMode: 'live' | 'fallback' }> {
  const query = rawQuery.trim();
  if (query.length < 2) {
    return { query, results: [], sourceMode: 'live' };
  }

  const topSource = TOPANIMES_BUILTIN_SOURCE;
  const topOrigin = topSource.baseUrl.replace(/\/+$/, '');

  const [topResults, hsSearch] = await Promise.all([
    (async (): Promise<SearchResultItem[]> => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const nonce = await getDooPlayNonceForOrigin(fetchHttp, topOrigin, attempt > 0);
          if (!nonce) break;
          const apiUrl = `${topOrigin}/wp-json/dooplay/search/?keyword=${encodeURIComponent(
            query
          )}&nonce=${encodeURIComponent(nonce)}`;
          const res = await fetchHttp(apiUrl, {
            referer: `${topOrigin}/`,
            accept: 'application/json,*/*;q=0.9',
            timeoutMs: 7000,
          });
          if (!res.ok) {
            if (attempt === 0) continue;
            break;
          }
          const rawJson = JSON.parse(res.body) as Record<string, unknown>;
          if (rawJson && typeof rawJson === 'object' && 'error' in rawJson) {
            if (attempt === 0 && /nonce|invalid|security/i.test(String(rawJson.error || ''))) {
              continue;
            }
            break;
          }
          return tagServerSearchItems(
            parseWpSearchJson(rawJson as Parameters<typeof parseWpSearchJson>[0]),
            topSource.name
          );
        } catch {
          if (attempt === 0) continue;
        }
      }
      return [];
    })(),
    fetchHinataSoulSearchSafe(fetchHttp, query, 1),
  ]);

  const combined = dedupeSearchResults([...topResults, ...hsSearch.results]).slice(0, 12);

  return {
    query,
    results: combined,
    sourceMode: 'live',
  };
}

/**
 * Full paginated search across all integrated streaming servers (TopAnimes + Hinata Soul).
 */
export async function getServerSearch(
  fetchHttp: HttpFetcher,
  rawQuery: string,
  page = 1
): Promise<PaginatedSearchResponse> {
  const query = rawQuery.trim();
  const safePage = Math.max(1, page);
  if (!query) {
    return { query: '', results: [], currentPage: 1, totalPages: 1, sourceMode: 'live' };
  }

  const topSource = TOPANIMES_BUILTIN_SOURCE;
  const topOrigin = topSource.baseUrl.replace(/\/+$/, '');
  const topSearchUrl =
    safePage > 1
      ? `${topOrigin}/page/${safePage}/?s=${encodeURIComponent(query)}`
      : `${topOrigin}/?s=${encodeURIComponent(query)}`;

  const [topSearch, hsSearch] = await Promise.all([
    (async (): Promise<{ results: SearchResultItem[]; totalPages: number }> => {
      try {
        const res = await fetchHttp(topSearchUrl, {
          referer: `${topOrigin}/`,
          timeoutMs: 9000,
        });
        if (!res.ok) return { results: [], totalPages: 1 };
        rememberNonce(topOrigin, res.body);
        const parsed = parseSearchPageHtml(res.body);
        return {
          results: tagServerSearchItems(parsed.results, topSource.name),
          totalPages: parsed.totalPages,
        };
      } catch {
        return { results: [], totalPages: 1 };
      }
    })(),
    fetchHinataSoulSearchSafe(fetchHttp, query, safePage),
  ]);

  const combined = dedupeSearchResults([...topSearch.results, ...hsSearch.results]);
  const totalPages = Math.max(1, topSearch.totalPages, hsSearch.totalPages);

  return {
    query,
    results: combined,
    currentPage: safePage,
    totalPages,
    sourceMode: 'live',
  };
}

/**
 * Picks a random title available on the integrated streaming servers.
 */
export async function getServerRandomMedia(
  fetchHttp: HttpFetcher,
  snapshotReader?: SnapshotAssetReader
): Promise<{ url: string; kind: MediaKind } | null> {
  const topSource = TOPANIMES_BUILTIN_SOURCE;
  const origin = topSource.baseUrl.replace(/\/+$/, '');
  try {
    const res = await fetchHttp(`${origin}/aleatorio/`, {
      referer: `${origin}/`,
      timeoutMs: 9000,
    });
    const finalUrl = normalizeTopAnimesUrl(res.finalUrl || '');
    if (finalUrl && /\/(?:animes|filmes)\//i.test(finalUrl)) {
      return { url: finalUrl, kind: inferMediaKindFromUrl(finalUrl) };
    }
  } catch {
    // fall through to catalog pool
  }

  const home = await getServerHomeCatalog(fetchHttp, snapshotReader);
  const pool = [...home.animes, ...home.movies, ...home.calendar].filter(
    (it) => it.kind === 'anime' || it.kind === 'movie'
  );
  if (!pool.length) return null;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  return { url: pick.url, kind: pick.kind };
}

function buildProgressiveServerSearchTerms(titles: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const cleaned = cleanText(raw);
    if (cleaned.length < 3) return;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(cleaned);
  };

  for (const title of titles) {
    const cleaned = cleanText(title);
    if (!cleaned) continue;
    const withoutTrailingPunct = cleaned.replace(/[.!?…]+$/g, '').trim();
    const strippedSeason = stripSeasonFromTitle(withoutTrailingPunct);

    add(withoutTrailingPunct);
    if (strippedSeason && strippedSeason !== withoutTrailingPunct) {
      add(strippedSeason);
    }

    // Clause before colon/dash for long subtitle titles
    const beforeColon = withoutTrailingPunct.split(/\s*[:–—]\s*/)[0]?.trim() || '';
    if (beforeColon.length >= 4 && beforeColon !== withoutTrailingPunct) {
      add(beforeColon);
    }

    // WordPress/DooPlay search fails on long titles with commas/punctuation mismatches ->
    // add a concise 4-word punctuation-free prefix when the title has 5+ words.
    const words = withoutTrailingPunct
      .replace(/[,.:;!?()[\]"'“”‘’/]+/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
    if (words.length >= 5) {
      add(words.slice(0, 4).join(' '));
      add(words.slice(0, 3).join(' '));
    }
  }

  return out.slice(0, 6);
}

/**
 * Checks whether a calendar anime title (e.g. from LiveChart.me) already exists on any
 * integrated server (TopAnimes or Hinata Soul) so clicking a calendar card can immediately load playable episodes!
 */
export async function findServerAnimePageForTitles(
  fetchHttp: HttpFetcher,
  titles: string[]
): Promise<{ details: AnimeDetails; serverName: string } | null> {
  const topSource = TOPANIMES_BUILTIN_SOURCE;
  const hsSource = HINATASOUL_BUILTIN_SOURCE;

  const cleanTerms = Array.from(
    new Set(titles.map((t) => cleanText(t)).filter((t) => t.length >= 2))
  ).slice(0, 4);
  if (!cleanTerms.length) return null;

  const targetSeason = Math.max(...cleanTerms.map((t) => extractHinataSoulSeasonNumber(t)));
  const searchTerms = buildProgressiveServerSearchTerms(cleanTerms);

  type MatchedServerCandidate = {
    url: string;
    title: string;
    score: number;
    isHinataSoul: boolean;
  };
  let best: MatchedServerCandidate | null = null;

  const evaluateResults = (
    results: SearchResultItem[],
    currentBest: MatchedServerCandidate | null
  ): MatchedServerCandidate | null => {
    let nextBest = currentBest;
    for (const r of results) {
      if (r.kind === 'episode') continue;
      const rawSim = Math.max(...cleanTerms.map((ref) => scoreTitleSimilarity(ref, r.title)));
      const candSeason = extractHinataSoulSeasonNumber(r.title);
      let adjusted = rawSim;
      if (targetSeason > 1) {
        if (candSeason === targetSeason) adjusted += 0.15;
        else if (candSeason !== targetSeason) adjusted -= 0.2;
      } else if (candSeason > 1) {
        adjusted -= 0.25;
      }

      if (rawSim >= 0.6 && adjusted >= 0.65 && (!nextBest || adjusted > nextBest.score)) {
        nextBest = {
          url: r.url,
          title: r.title,
          score: adjusted,
          isHinataSoul: isHinataSoulUrl(r.url),
        };
      }
    }
    return nextBest;
  };

  for (const term of searchTerms) {
    const suggest = await getServerSearchSuggest(fetchHttp, term).catch(() => ({
      query: term,
      results: [] as SearchResultItem[],
      sourceMode: 'fallback' as const,
    }));
    best = evaluateResults(suggest.results, best);
    if (best && best.score >= 0.92) break;
  }

  // Fallback to full server search HTML (/?s=... + Hinata Soul) if fast suggest missed a valid match
  if (!best || best.score < 0.8) {
    const fallbackTerms = searchTerms.slice(0, 2);
    for (const term of fallbackTerms) {
      const full = await getServerSearch(fetchHttp, term, 1).catch(() => null);
      if (full?.results?.length) {
        best = evaluateResults(full.results, best);
      }
      if (best && best.score >= 0.92) break;
    }
  }

  if (!best) return null;

  try {
    if (best.isHinataSoul) {
      const details = await fetchHinataSoulAnimeWithEpisodes(fetchHttp, best.url, {
        maxPages: 6,
        timeoutMs: 9000,
      });
      if (!details) return null;
      return {
        details: {
          ...details,
          sourceServerName: hsSource.name,
        },
        serverName: hsSource.name,
      };
    }

    const res = await fetchHttp(best.url, {
      referer: `${topSource.baseUrl.replace(/\/+$/, '')}/`,
      timeoutMs: 9000,
    });
    if (!res.ok) return null;
    const details = parseAnimePageHtml(res.body, best.url);
    return {
      details: {
        ...details,
        kind: inferMediaKindFromUrl(best.url),
        sourceServerName: topSource.name,
      },
      serverName: topSource.name,
    };
  } catch {
    return null;
  }
}
