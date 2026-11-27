import {
  buildFallbackRemoteRelease,
  buildGitHubExpandedAssetsUrl,
  GITHUB_LATEST_RELEASE_WEB_URL,
  GITHUB_RELEASES_API_URL,
  GITHUB_RELEASES_ATOM_URL,
  GITHUB_RELEASES_LIST_API_URL,
  parseGitHubExpandedAssetsHtml,
  parseGitHubLatestWebJson,
  parseGitHubReleasePayload,
  parseGitHubReleasesAtom,
  type RemoteAppRelease,
} from './appUpdater.ts';
import {
  enrichServerDetailsWithTheTvdb,
  getAggregatedCatalogPage,
  getAggregatedGlossary,
  getAggregatedHomeCatalog,
  getAggregatedMediaDetails,
  getAggregatedRandomMedia,
  getAggregatedRecentEpisodes,
  getAggregatedSearch,
  getAggregatedSearchSuggest,
  getAggregatedWeeklyCalendar,
  type MediaDetailsResolveOptions,
} from './catalog/catalogAggregator.ts';
import {
  buildEpisodeUri,
  buildMediaUri,
  isAnisyncUri,
  parseAnisyncUri,
  splitAlternativeTitleString,
} from './catalog/idCodec.ts';
import {
  findBestTheTvdbMatch,
  preloadTheTvdbProfileFromHints,
  resolveLocalizedEpisodeTitlesByIds,
} from './catalog/providers/thetvdbProvider.ts';
import { enrichDetailsWithMyAnimeListRating } from './catalog/providers/malProvider.ts';
import type { SnapshotAssetReader } from './catalog/serverCatalog.ts';
import {
  extractEpisodeNumber,
  normalizeTopAnimesUrl,
  pickLatestAnimeEpisode,
} from './favoriteAlerts.ts';
import {
  resolveLocalizedAnimeSynopsis,
  resolveLocalizedEpisodeSynopsis,
} from './episodeSynopsis.ts';
import {
  extractHinataSoulSeasonNumber,
  parseHinataSoulEpisodePageHtml,
} from './hinatasoulParser.ts';
import type { HttpFetcher } from './httpTypes.ts';
import {
  aggregateEpisodeServers,
  resolveEmbedByUrl,
  resolveServerOptionToStreams,
  testEpisodeSource,
} from './sources/sourceAggregator.ts';
import {
  fetchHinataSoulAnimeWithEpisodes,
  prefetchHinataSoulAdScript,
  rememberHinataSoulEpisodePage,
} from './sources/providers/hinatasoulSource.ts';
import { hydrateDooPlayEpisodeOptions } from './sources/providers/topanimesSource.ts';
import {
  DEFAULT_EPISODE_SOURCES,
  HINATASOUL_BUILTIN_SOURCE,
  TOPANIMES_BUILTIN_SOURCE,
  type EpisodeSourceConfig,
  type EpisodeSourceLookupQuery,
} from './sources/types.ts';
import {
  inferMediaKindFromUrl,
  parseAnimePageHtml,
  parseEpisodePageHtml,
} from './topanimesParser.ts';
import {
  createEmbedCacheEntry,
  isEmbedCacheEntryValid,
  type CachedEmbedEntry,
} from './embedCache.ts';
import type {
  AnimeDetails,
  CatalogArchiveCategory,
  CatalogPreferences,
  EpisodeDetails,
  EpisodeSourceReportSummary,
  FavoriteLatestInfo,
  GlossaryResponse,
  HomeCatalog,
  LiveChartScheduleMode,
  PaginatedCatalogResponse,
  PaginatedSearchResponse,
  PlayerOption,
  ResolvedEmbed,
  SearchSuggestResponse,
  WeeklyCalendarResponse,
} from './types.ts';
import {
  isHinataSoulUrl,
  isSupportedServerSiteUrl,
  normalizeHinataSoulUrl,
} from './urlSafety.ts';

export interface AnisyncApiResponse {
  status: number;
  body: unknown;
}

export interface AnisyncRouterContext {
  fetchHttp: HttpFetcher;
  serviceName: string;
  catalogPrefs?: CatalogPreferences;
  snapshotReader?: SnapshotAssetReader;
  useCache?: boolean;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class CoalescedTtlCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly inFlight = new Map<string, Promise<T>>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(ttlMs: number, maxEntries = 60) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  get(key: string): T | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh recency order for LRU eviction
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit.value;
  }

  set(key: string, value: T, ttlOverrideMs?: number): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    } else if (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
    }
    this.entries.set(key, {
      value,
      expiresAt: Date.now() + (ttlOverrideMs ?? this.ttlMs),
    });
  }

  async getOrLoad(
    key: string,
    loader: () => Promise<T>,
    options: {
      useCache: boolean;
      forceRefresh?: boolean;
      shouldCache?: (value: T) => boolean;
    }
  ): Promise<T> {
    if (options.useCache && !options.forceRefresh) {
      const cached = this.get(key);
      if (cached !== undefined) return cached;
      const pending = this.inFlight.get(key);
      if (pending) return pending;
    }

    const promise = loader();
    if (options.useCache && !options.forceRefresh) {
      this.inFlight.set(key, promise);
    }
    try {
      const value = await promise;
      const canStore = options.shouldCache ? options.shouldCache(value) : value !== null && value !== undefined;
      if (options.useCache && canStore) {
        this.set(key, value);
      }
      return value;
    } finally {
      if (this.inFlight.get(key) === promise) {
        this.inFlight.delete(key);
      }
    }
  }

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
  }
}

const HOME_TTL_MS = 3 * 60 * 1000;
const EPISODES_FEED_TTL_MS = 2 * 60 * 1000;
const CATALOG_TTL_MS = 5 * 60 * 1000;
const GLOSSARY_TTL_MS = 10 * 60 * 1000;
const SEARCH_TTL_MS = 2 * 60 * 1000;
const CALENDAR_TTL_MS = 5 * 60 * 1000;
const DETAILS_TTL_MS = 10 * 60 * 1000;
const RAW_SERVER_DETAILS_TTL_MS = 2 * 60 * 1000;
const EPISODE_DETAILS_TTL_MS = 3 * 60 * 1000;

const homeCache = new CoalescedTtlCache<HomeCatalog>(HOME_TTL_MS, 8);
const episodesFeedCache = new CoalescedTtlCache<PaginatedCatalogResponse>(EPISODES_FEED_TTL_MS, 20);
const catalogPageCache = new CoalescedTtlCache<PaginatedCatalogResponse>(CATALOG_TTL_MS, 50);
const glossaryCache = new CoalescedTtlCache<GlossaryResponse>(GLOSSARY_TTL_MS, 40);
const searchSuggestCache = new CoalescedTtlCache<SearchSuggestResponse>(SEARCH_TTL_MS, 60);
const searchPageCache = new CoalescedTtlCache<PaginatedSearchResponse>(SEARCH_TTL_MS, 40);
const calendarCache = new CoalescedTtlCache<WeeklyCalendarResponse>(CALENDAR_TTL_MS, 12);
const mediaDetailsCache = new CoalescedTtlCache<AnimeDetails | null>(DETAILS_TTL_MS, 60);
const rawServerDetailsCache = new CoalescedTtlCache<AnimeDetails>(RAW_SERVER_DETAILS_TTL_MS, 50);
const episodeDetailsRouterCache = new CoalescedTtlCache<EpisodeDetails>(EPISODE_DETAILS_TTL_MS, 50);

const resolvedEmbedCache = new Map<string, CachedEmbedEntry>();
const resolvedEmbedInFlight = new Map<string, Promise<ResolvedEmbed>>();
const MAX_RESOLVED_EMBED_CACHE = 80;

// In-flight coalescer per HttpFetcher for raw server anime page scrapes so `stage=quick`
// and full enriched `/api/media` fired together always share 1 single HTTP request.
const rawServerInFlightByFetcher = new WeakMap<HttpFetcher, Map<string, Promise<AnimeDetails>>>();

export function clearAnisyncRouterCaches(): void {
  homeCache.clear();
  episodesFeedCache.clear();
  catalogPageCache.clear();
  glossaryCache.clear();
  searchSuggestCache.clear();
  searchPageCache.clear();
  calendarCache.clear();
  mediaDetailsCache.clear();
  rawServerDetailsCache.clear();
  episodeDetailsRouterCache.clear();
  resolvedEmbedCache.clear();
  resolvedEmbedInFlight.clear();
}

const VALID_CATEGORIES = new Set<CatalogArchiveCategory>([
  'animes',
  'movies',
  'series',
  'dublado',
  'legendado',
  'donghua',
  'cartoon',
  'live-action',
]);

const VALID_SCHEDULE_MODES = new Set<LiveChartScheduleMode>(['streams', 'dub', 'jp']);

function isAllowedServerSiteUrl(rawUrl: string): boolean {
  return isSupportedServerSiteUrl(rawUrl);
}

function findBuiltinSourceFromBody(rawBody: unknown): EpisodeSourceConfig {
  if (rawBody && typeof rawBody === 'object') {
    const rec = rawBody as { source?: { id?: unknown; kind?: unknown }; sourceId?: unknown };
    const requestedId = String(rec.source?.id || rec.sourceId || '')
      .trim()
      .toLowerCase();
    const requestedKind = String(rec.source?.kind || '')
      .trim()
      .toLowerCase();
    const matched = DEFAULT_EPISODE_SOURCES.find(
      (s) =>
        (requestedId && s.id.toLowerCase() === requestedId) ||
        (requestedKind && s.kind.toLowerCase() === requestedKind)
    );
    if (matched) return matched;
  }
  return TOPANIMES_BUILTIN_SOURCE;
}

async function getCachedMediaDetails(
  fetchHttp: HttpFetcher,
  uri: string,
  prefs: CatalogPreferences | undefined,
  useCache: boolean,
  skipEpisodePageHydration = false,
  hints?: Omit<MediaDetailsResolveOptions, 'skipEpisodePageHydration'>
): Promise<AnimeDetails | null> {
  return mediaDetailsCache.getOrLoad(
    uri,
    async () => {
      const details = await getAggregatedMediaDetails(fetchHttp, uri, prefs, {
        skipEpisodePageHydration,
        ...hints,
      });
      if (!details) return null;
      return enrichDetailsWithMyAnimeListRating(fetchHttp, details).catch(() => details);
    },
    {
      useCache,
      shouldCache: (val) => Boolean(val),
    }
  );
}

async function fetchRawServerAnimeDetailsCoalesced(
  fetchHttp: HttpFetcher,
  target: string,
  normKey: string,
  isHinataSoul: boolean,
  useCache: boolean
): Promise<AnimeDetails> {
  if (useCache) {
    const cached = rawServerDetailsCache.get(normKey);
    if (cached) return cached;
  }

  let inFlightMap = rawServerInFlightByFetcher.get(fetchHttp);
  if (!inFlightMap) {
    inFlightMap = new Map();
    rawServerInFlightByFetcher.set(fetchHttp, inFlightMap);
  }
  const existing = inFlightMap.get(normKey);
  if (existing) return existing;

  const promise = (async (): Promise<AnimeDetails> => {
    if (isHinataSoul) {
      const fetched = await fetchHinataSoulAnimeWithEpisodes(fetchHttp, target, {
        maxPages: 8,
        timeoutMs: 10000,
      });
      if (!fetched) {
        throw new Error('Não foi possível carregar os detalhes deste título no Hinata Soul.');
      }
      return {
        ...fetched,
        sourceServerName: HINATASOUL_BUILTIN_SOURCE.name,
      };
    }

    const origin = new URL(target).origin;
    const response = await fetchHttp(target, {
      referer: `${origin}/`,
      timeoutMs: 10000,
    });
    if (!response.ok) {
      const err = new Error(`Servidor retornou HTTP ${response.status}.`) as Error & {
        httpStatus?: number;
      };
      err.httpStatus = response.status;
      throw err;
    }

    const rawDetails = parseAnimePageHtml(response.body, target);
    return {
      ...rawDetails,
      kind: inferMediaKindFromUrl(target),
      sourceServerName: TOPANIMES_BUILTIN_SOURCE.name,
    };
  })();

  inFlightMap.set(normKey, promise);
  try {
    const baseDetails = await promise;
    if (useCache) {
      rawServerDetailsCache.set(normKey, baseDetails);
    }
    return baseDetails;
  } finally {
    if (inFlightMap.get(normKey) === promise) {
      inFlightMap.delete(normKey);
    }
  }
}

async function resolveEmbedCachedInRouter(
  cacheKey: string,
  loader: () => Promise<ResolvedEmbed>,
  useCache: boolean
): Promise<ResolvedEmbed> {
  if (useCache) {
    const cached = resolvedEmbedCache.get(cacheKey);
    if (isEmbedCacheEntryValid(cached)) {
      return cached.data;
    }
    if (cached) {
      resolvedEmbedCache.delete(cacheKey);
    }
    const pending = resolvedEmbedInFlight.get(cacheKey);
    if (pending) return pending;
  }

  const req = loader();
  if (useCache) {
    resolvedEmbedInFlight.set(cacheKey, req);
  }
  try {
    const resolved = await req;
    if (useCache) {
      const entry = createEmbedCacheEntry(resolved);
      if (entry) {
        if (resolvedEmbedCache.size >= MAX_RESOLVED_EMBED_CACHE) {
          const oldest = resolvedEmbedCache.keys().next().value;
          if (oldest) resolvedEmbedCache.delete(oldest);
        }
        resolvedEmbedCache.set(cacheKey, entry);
      }
    }
    return resolved;
  } finally {
    if (resolvedEmbedInFlight.get(cacheKey) === req) {
      resolvedEmbedInFlight.delete(cacheKey);
    }
  }
}

function getCachedSeriesMeta(seriesUrl?: string): {
  genres?: string[];
  originalTitle?: string;
  alternativeTitles?: string[];
} {
  if (!seriesUrl) return {};
  const normSeries = isHinataSoulUrl(seriesUrl)
    ? normalizeHinataSoulUrl(seriesUrl) || seriesUrl
    : normalizeTopAnimesUrl(seriesUrl) || seriesUrl;
  const cachedMedia =
    mediaDetailsCache.get(normSeries) || rawServerDetailsCache.get(normSeries) || null;
  if (!cachedMedia) return {};
  const seen = new Set<string>();
  const alts: string[] = [];
  const push = (raw?: string) => {
    for (const part of splitAlternativeTitleString(raw)) {
      if (part.length < 2) continue;
      const key = part.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      alts.push(part);
    }
  };
  push(cachedMedia.title);
  push(cachedMedia.originalTitle);
  push(cachedMedia.alternativeTitle);
  if (cachedMedia.alternativeTitles?.length) {
    for (const alt of cachedMedia.alternativeTitles) push(alt);
  }
  return {
    genres: cachedMedia.genres?.length ? cachedMedia.genres : undefined,
    originalTitle: cachedMedia.originalTitle?.trim() || undefined,
    alternativeTitles: alts.length ? alts : undefined,
  };
}

function getCachedSeriesGenres(seriesUrl?: string): string[] | undefined {
  return getCachedSeriesMeta(seriesUrl).genres;
}

async function resolveCrossSourceAliasesForEpisode(
  fetchHttp: HttpFetcher,
  params: {
    seriesTitle: string;
    seriesUrl?: string;
    mediaType: 'anime' | 'series' | 'movie';
    originalTitle?: string;
    alternativeTitles?: string[];
  }
): Promise<{ originalTitle?: string; alternativeTitles: string[]; genres?: string[] }> {
  const seen = new Set<string>();
  const aliases: string[] = [];
  let resolvedOriginal = params.originalTitle?.trim() || undefined;
  let resolvedGenres = getCachedSeriesGenres(params.seriesUrl);

  const pushAlias = (raw: string | undefined) => {
    for (const part of splitAlternativeTitleString(raw)) {
      if (part.length < 2) continue;
      const key = part.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      aliases.push(part);
    }
  };

  pushAlias(params.originalTitle);
  if (params.alternativeTitles?.length) {
    for (const alt of params.alternativeTitles) pushAlias(alt);
  }

  // Instant cache check using parent series URL (zero extra HTTP requests when opened from anime page)
  if (params.seriesUrl) {
    const normSeries = isHinataSoulUrl(params.seriesUrl)
      ? normalizeHinataSoulUrl(params.seriesUrl) || params.seriesUrl
      : normalizeTopAnimesUrl(params.seriesUrl) || params.seriesUrl;
    const cachedMedia =
      mediaDetailsCache.get(normSeries) || rawServerDetailsCache.get(normSeries) || null;
    if (cachedMedia) {
      if (!resolvedOriginal && cachedMedia.originalTitle) {
        resolvedOriginal = cachedMedia.originalTitle;
      }
      pushAlias(cachedMedia.title);
      pushAlias(cachedMedia.originalTitle);
      pushAlias(cachedMedia.alternativeTitle);
      if (cachedMedia.alternativeTitles?.length) {
        for (const alt of cachedMedia.alternativeTitles) pushAlias(alt);
      }
    }
  }

  const baseLower = params.seriesTitle.trim().toLowerCase();
  const hasDistinctLatinAlias = aliases.some(
    (a) => /[a-z]/i.test(a) && a.toLowerCase() !== baseLower
  );

  // If no distinct Latin alias is known yet (e.g. direct episode link for "Solo Leveling"),
  // query cached TheTVDB search to pull romaji/English synonyms like "Ore dake Level Up na Ken".
  if (!hasDistinctLatinAlias && params.seriesTitle.trim().length >= 2) {
    const tvdbMatch = await findBestTheTvdbMatch(fetchHttp, [params.seriesTitle], {
      mediaType: params.mediaType,
    }).catch(() => null);
    if (tvdbMatch) {
      if (!resolvedOriginal && tvdbMatch.originalTitle) {
        resolvedOriginal = tvdbMatch.originalTitle;
      }
      if (!resolvedGenres?.length && tvdbMatch.genres?.length) {
        resolvedGenres = tvdbMatch.genres;
      }
      pushAlias(tvdbMatch.title);
      pushAlias(tvdbMatch.englishTitle);
      pushAlias(tvdbMatch.originalTitle);
      for (const alt of tvdbMatch.alternativeTitles || []) {
        pushAlias(alt);
      }
    }
  }

  return {
    originalTitle: resolvedOriginal,
    alternativeTitles: aliases.filter((a) => a.toLowerCase() !== baseLower),
    genres: resolvedGenres,
  };
}

async function resolveCanonicalEpisodeDetails(
  fetchHttp: HttpFetcher,
  targetUri: string,
  audioPreference: 'ALL' | 'DUB' | 'LEG' | undefined,
  prefs: CatalogPreferences | undefined,
  useCache: boolean
): Promise<EpisodeDetails | null> {
  const parsed = parseAnisyncUri(targetUri);
  if (parsed.kind !== 'episode') return null;

  const seriesUri = buildMediaUri(parsed.mediaType, parsed.source, parsed.externalId);
  const details = await getCachedMediaDetails(fetchHttp, seriesUri, prefs, useCache, true);
  if (!details) return null;

  const matchingEpIdx = details.episodes.findIndex(
    (ep) =>
      ep.episodeNumber === parsed.episodeNumber &&
      (ep.seasonNumber || 1) === parsed.seasonNumber
  );
  const matchedEp = matchingEpIdx >= 0 ? details.episodes[matchingEpIdx] : null;
  const prevEp = matchingEpIdx > 0 ? details.episodes[matchingEpIdx - 1] : null;
  const nextEp =
    matchingEpIdx >= 0 && matchingEpIdx < details.episodes.length - 1
      ? details.episodes[matchingEpIdx + 1]
      : null;

  const lookupQuery: EpisodeSourceLookupQuery = {
    title: details.title,
    originalTitle: details.originalTitle,
    alternativeTitles: details.alternativeTitles,
    mediaType: parsed.mediaType,
    seasonNumber: parsed.seasonNumber,
    episodeNumber: parsed.episodeNumber,
    year: details.year,
    externalIds: details.externalIds,
    audioPreference,
  };

  const aggregated = await aggregateEpisodeServers(fetchHttp, lookupQuery);

  const isMovie = parsed.mediaType === 'movie';
  const epLabel = isMovie
    ? 'Filme'
    : parsed.seasonNumber > 1
      ? `T${parsed.seasonNumber} · EP ${parsed.episodeNumber}`
      : `EP ${parsed.episodeNumber}`;
  const fullTitle = isMovie
    ? details.title
    : matchedEp?.title
      ? `${details.title} — ${matchedEp.title}`
      : `${details.title} — Episódio ${parsed.episodeNumber}`;

  return {
    title: fullTitle,
    seriesTitle: details.title,
    seriesUrl: seriesUri,
    url: targetUri,
    episodeLabel: epLabel,
    mediaType: parsed.mediaType,
    seasonNumber: parsed.seasonNumber,
    episodeNumber: parsed.episodeNumber,
    originalTitle: details.originalTitle,
    alternativeTitles: details.alternativeTitles,
    year: details.year,
    catalogSource: details.catalogSource,
    externalIds: details.externalIds,
    poster: details.poster,
    backdrop: matchedEp?.thumb || details.backdrop || details.poster,
    synopsis: matchedEp?.overview || details.synopsis,
    genres: details.genres,
    prevUrl:
      (prevEp && prevEp.availableOnServer !== false ? prevEp.url : undefined) ||
      (!isMovie && !prevEp && parsed.episodeNumber > 1
        ? buildEpisodeUri(
            parsed.mediaType,
            parsed.source,
            parsed.externalId,
            parsed.seasonNumber,
            parsed.episodeNumber - 1
          )
        : undefined),
    nextUrl: nextEp && nextEp.availableOnServer !== false ? nextEp.url : undefined,
    options: aggregated.options,
    sourceReports: aggregated.reports,
    isMovie,
    sourceMode: 'live',
  };
}

export async function dispatchAnisyncApiRequest(
  pathWithQuery: string,
  options: {
    method?: string;
    jsonBody?: unknown;
  },
  ctx: AnisyncRouterContext
): Promise<AnisyncApiResponse> {
  const { fetchHttp, serviceName, catalogPrefs, snapshotReader, useCache = true } = ctx;

  const url = new URL(pathWithQuery, 'http://localhost');
  const pathname = url.pathname;
  const method = (options.method || 'GET').toUpperCase();

  if (pathname === '/api/health') {
    return {
      status: 200,
      body: { ok: true, service: serviceName, aggregator: 'anisync' },
    };
  }

  if (pathname === '/api/apk-info') {
    return { status: 200, body: { available: false } };
  }

  if (pathname === '/api/app-update/check') {
    const fetchGitHubWebFallbackRelease = async (): Promise<RemoteAppRelease | null> => {
      const [latestSettled, atomSettled] = await Promise.allSettled([
        fetchHttp(GITHUB_LATEST_RELEASE_WEB_URL, {
          accept: 'application/json',
          timeoutMs: 10000,
        }),
        fetchHttp(GITHUB_RELEASES_ATOM_URL, {
          accept: 'application/atom+xml, application/xml, text/xml',
          timeoutMs: 10000,
        }),
      ]);

      const latestHint =
        latestSettled.status === 'fulfilled' && latestSettled.value.ok
          ? parseGitHubLatestWebJson(latestSettled.value.body, latestSettled.value.finalUrl)
          : null;
      const atomXml =
        atomSettled.status === 'fulfilled' && atomSettled.value.ok ? atomSettled.value.body : '';
      const atomEntry = atomXml ? parseGitHubReleasesAtom(atomXml, latestHint?.tagName) : null;
      const resolvedTag = latestHint?.tagName || atomEntry?.tagName || '';
      if (!resolvedTag) return null;

      let apkAsset = null;
      try {
        const assetsRes = await fetchHttp(buildGitHubExpandedAssetsUrl(resolvedTag), {
          accept: 'text/html',
          timeoutMs: 10000,
        });
        if (assetsRes.ok) {
          apkAsset = parseGitHubExpandedAssetsHtml(assetsRes.body, resolvedTag);
        }
      } catch {
        // Fall back to deterministic official GitHub release download URL below
      }

      return buildFallbackRemoteRelease({
        latestHint,
        atomEntry,
        apkAsset,
      });
    };

    try {
      let apiStatus = 0;
      let apiOk = false;
      let payload: unknown = null;

      try {
        let response = await fetchHttp(GITHUB_RELEASES_API_URL, {
          accept: 'application/vnd.github+json',
          timeoutMs: 10000,
        });
        apiStatus = response.status;
        apiOk = response.ok;

        if (response.ok) {
          payload = JSON.parse(response.body);
        } else if (response.status === 404) {
          response = await fetchHttp(GITHUB_RELEASES_LIST_API_URL, {
            accept: 'application/vnd.github+json',
            timeoutMs: 10000,
          });
          apiStatus = response.status;
          apiOk = response.ok;
          if (response.ok) {
            const list = JSON.parse(response.body) as unknown[];
            payload = Array.isArray(list) ? list[0] : null;
          }
        }
      } catch {
        apiOk = false;
      }

      const apiRelease = apiOk ? parseGitHubReleasePayload(payload) : null;
      if (apiRelease || (apiOk && apiStatus !== 404)) {
        return {
          status: 200,
          body: {
            checkedAt: new Date().toISOString(),
            release: apiRelease,
          },
        };
      }

      // When api.github.com hits HTTP 403/429 (e.g. shared mobile 4G CGNAT rate limit) or fails,
      // fall back cleanly to official github.com non-API release endpoints (latest + expanded_assets + Atom).
      if (apiStatus !== 404) {
        const fallbackRelease = await fetchGitHubWebFallbackRelease();
        if (fallbackRelease) {
          return {
            status: 200,
            body: {
              checkedAt: new Date().toISOString(),
              release: fallbackRelease,
            },
          };
        }
      } else {
        return {
          status: 200,
          body: {
            checkedAt: new Date().toISOString(),
            release: null,
          },
        };
      }

      return {
        status: 502,
        body: {
          error:
            apiStatus > 0
              ? `GitHub retornou HTTP ${apiStatus} ao verificar atualizações.`
              : 'Não foi possível consultar atualizações no GitHub agora.',
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
    const forceRefresh = url.searchParams.get('refresh') === '1';
    try {
      const ck = DEFAULT_EPISODE_SOURCES.map((s) => s.id).join('+');
      const catalog = await homeCache.getOrLoad(
        ck,
        () =>
          getAggregatedHomeCatalog(fetchHttp, {
            snapshotReader,
          }),
        { useCache, forceRefresh }
      );
      return { status: 200, body: catalog };
    } catch (err) {
      return {
        status: 502,
        body: { error: err instanceof Error ? err.message : 'Erro ao carregar catálogo.' },
      };
    }
  }

  if (pathname === '/api/calendar') {
    const rawMode = (url.searchParams.get('mode') || 'streams').toLowerCase() as LiveChartScheduleMode;
    const mode: LiveChartScheduleMode = VALID_SCHEDULE_MODES.has(rawMode) ? rawMode : 'streams';
    const rawTz = url.searchParams.get('tz');
    const parsedTz = rawTz !== null ? Number.parseInt(rawTz, 10) : -180;
    const tzOffsetMinutes =
      Number.isFinite(parsedTz) && parsedTz >= -720 && parsedTz <= 840 ? parsedTz : -180;
    const forceRefresh = url.searchParams.get('refresh') === '1';

    try {
      const ck = `${mode}:${tzOffsetMinutes}`;
      const calendar = await calendarCache.getOrLoad(
        ck,
        () =>
          getAggregatedWeeklyCalendar(fetchHttp, {
            mode,
            tzOffsetMinutes,
          }),
        { useCache, forceRefresh }
      );
      return { status: 200, body: calendar };
    } catch (err) {
      return {
        status: 502,
        body: {
          error:
            err instanceof Error
              ? err.message
              : 'Erro ao carregar calendário de animes no LiveChart.me.',
        },
      };
    }
  }

  if (pathname === '/api/episodes') {
    const rawPage = Number.parseInt(url.searchParams.get('page') || '1', 10);
    const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
    const forceRefresh = url.searchParams.get('refresh') === '1';
    try {
      const result = await episodesFeedCache.getOrLoad(
        `p:${page}`,
        () =>
          getAggregatedRecentEpisodes(fetchHttp, page, {
            snapshotReader,
          }),
        {
          useCache,
          forceRefresh,
          shouldCache: (val) => val.items.length > 0,
        }
      );
      return { status: 200, body: result };
    } catch (err) {
      return {
        status: 502,
        body: { error: err instanceof Error ? err.message : 'Erro ao carregar lançamentos.' },
      };
    }
  }

  if (pathname === '/api/catalog') {
    const rawCat = (url.searchParams.get('category') || 'animes').toLowerCase() as CatalogArchiveCategory;
    const category: CatalogArchiveCategory = VALID_CATEGORIES.has(rawCat) ? rawCat : 'animes';
    const genre = (url.searchParams.get('genre') || '').trim();
    const year = /^\d{4}$/.test(url.searchParams.get('year') || '')
      ? String(url.searchParams.get('year'))
      : '';
    const rawPage = Number.parseInt(url.searchParams.get('page') || '1', 10);
    const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
    const forceRefresh = url.searchParams.get('refresh') === '1';

    try {
      const ck = `${category}|g:${genre.toLowerCase()}|y:${year}|p:${page}`;
      const result = await catalogPageCache.getOrLoad(
        ck,
        () =>
          getAggregatedCatalogPage(
            fetchHttp,
            { category, genre, year, page },
            { snapshotReader }
          ),
        {
          useCache,
          forceRefresh,
          shouldCache: (val) => val.items.length > 0,
        }
      );
      return { status: 200, body: result };
    } catch (err) {
      return {
        status: 502,
        body: { error: err instanceof Error ? err.message : 'Erro ao carregar catálogo.' },
      };
    }
  }

  if (pathname === '/api/glossary') {
    const rawTerm = (url.searchParams.get('term') || '').trim();
    const lower = rawTerm.toLowerCase();
    const isNum = lower === '#' || lower === '09' || lower === '0-9';
    const validLetter = isNum ? '#' : /^[a-z]$/.test(lower) ? lower.toUpperCase() : '';
    const rawType = (url.searchParams.get('type') || 'all').trim().toLowerCase();
    if (!validLetter) {
      return { status: 400, body: { error: 'Informe uma letra válida (A-Z ou #).' } };
    }
    try {
      const ck = `${validLetter}|${rawType}`;
      const glossary = await glossaryCache.getOrLoad(
        ck,
        () =>
          getAggregatedGlossary(fetchHttp, validLetter, rawType, {
            snapshotReader,
          }),
        {
          useCache,
          shouldCache: (val) => val.sourceMode === 'live' && val.items.length > 0,
        }
      );
      return { status: 200, body: glossary };
    } catch {
      return {
        status: 200,
        body: { term: validLetter, type: rawType, items: [], sourceMode: 'fallback' },
      };
    }
  }

  if (pathname === '/api/search-suggest') {
    const query = (url.searchParams.get('q') || '').trim();
    if (query.length < 2) {
      return { status: 200, body: { query, results: [], sourceMode: 'live' } };
    }
    try {
      const res = await searchSuggestCache.getOrLoad(
        query.toLowerCase(),
        () => getAggregatedSearchSuggest(fetchHttp, query),
        {
          useCache,
          shouldCache: (val) => val.sourceMode === 'live',
        }
      );
      return { status: 200, body: res };
    } catch {
      return { status: 200, body: { query, results: [], sourceMode: 'fallback' } };
    }
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
      const ck = `${query.toLowerCase()}|p:${page}`;
      const res = await searchPageCache.getOrLoad(
        ck,
        () => getAggregatedSearch(fetchHttp, query, { page }),
        {
          useCache,
          shouldCache: (val) => val.sourceMode === 'live',
        }
      );
      return { status: 200, body: res };
    } catch (err) {
      return {
        status: 502,
        body: { error: err instanceof Error ? err.message : 'Erro ao buscar no servidor.' },
      };
    }
  }

  if (pathname === '/api/random') {
    try {
      const pick = await getAggregatedRandomMedia(fetchHttp, {
        snapshotReader,
      });
      if (pick) return { status: 200, body: pick };
    } catch {
      // fall through
    }
    return { status: 502, body: { error: 'Não foi possível sortear um título agora.' } };
  }

  if (pathname === '/api/anime' || pathname === '/api/media') {
    const target = (url.searchParams.get('url') || '').trim();
    const stage = (url.searchParams.get('stage') || '').trim().toLowerCase();
    const fastMode = url.searchParams.get('fast') === '1';
    const allowedSite = isAllowedServerSiteUrl(target);
    if (!target || (!isAnisyncUri(target) && !allowedSite)) {
      return {
        status: 400,
        body: { error: 'Informe um identificador anisync:// válido ou URL de servidor suportada.' },
      };
    }

    const hintTitle = (url.searchParams.get('title') || '').trim() || undefined;
    const rawHintTvdbId = Number.parseInt(url.searchParams.get('tvdbId') || '', 10);
    const hintTvdbId =
      Number.isFinite(rawHintTvdbId) && rawHintTvdbId > 0 ? rawHintTvdbId : undefined;
    const hintTvdbSlug = (url.searchParams.get('tvdbSlug') || '').trim() || undefined;
    const rawHintKind = (url.searchParams.get('kind') || '').trim().toLowerCase();
    const explicitHintMediaType =
      rawHintKind === 'movie' || rawHintKind === 'series' || rawHintKind === 'anime'
        ? rawHintKind
        : undefined;
    const hintYear = (url.searchParams.get('year') || '').trim() || undefined;

    if (isAnisyncUri(target)) {
      try {
        const details = await getCachedMediaDetails(
          fetchHttp,
          target,
          catalogPrefs,
          useCache,
          fastMode,
          {
            hintTitle,
            hintTvdbId,
            hintTvdbSlug,
            hintYear,
            hintMediaType: explicitHintMediaType,
          }
        );
        if (!details) {
          return { status: 404, body: { error: 'Título não encontrado no TheTVDB.' } };
        }
        return { status: 200, body: details };
      } catch (err) {
        return {
          status: 502,
          body: {
            error: err instanceof Error ? err.message : 'Falha ao carregar detalhes do título.',
          },
        };
      }
    }

    // Server anime/movie page (TopAnimes or Hinata Soul) -> enriched with TheTVDB!
    const isHinataSoul = isHinataSoulUrl(target);
    const normKey = isHinataSoul
      ? normalizeHinataSoulUrl(target) || target
      : normalizeTopAnimesUrl(target) || target;

    // Even in stage=quick, return the full enriched cached payload immediately if already warm
    if (useCache) {
      const cachedFull = mediaDetailsCache.get(normKey);
      if (cachedFull) {
        return { status: 200, body: cachedFull };
      }
    }

    if (stage === 'quick') {
      try {
        const baseDetails = await fetchRawServerAnimeDetailsCoalesced(
          fetchHttp,
          target,
          normKey,
          isHinataSoul,
          useCache
        );
        return { status: 200, body: baseDetails };
      } catch (err) {
        const httpStatus = (err as { httpStatus?: number })?.httpStatus;
        return {
          status: httpStatus || 502,
          body: {
            error:
              err instanceof Error ? err.message : 'Falha ao carregar detalhes e episódios.',
          },
        };
      }
    }

    const inferredKind = inferMediaKindFromUrl(target);
    const hintMediaType =
      explicitHintMediaType ||
      (inferredKind === 'movie' || inferredKind === 'anime' ? inferredKind : undefined);

    try {
      const enriched = await mediaDetailsCache.getOrLoad(
        normKey,
        async () => {
          const tvdbPreloadPromise =
            hintTvdbId || hintTitle
              ? preloadTheTvdbProfileFromHints(
                  fetchHttp,
                  {
                    tvdbId: hintTvdbId,
                    tvdbSlug: hintTvdbSlug,
                    title: hintTitle,
                    mediaType: hintMediaType,
                    year: hintYear,
                  },
                  catalogPrefs?.credentials,
                  { skipEpisodePageHydration: fastMode }
                ).catch(() => null)
              : Promise.resolve(null);

          const [baseDetails, preloadedTvdb] = await Promise.all([
            fetchRawServerAnimeDetailsCoalesced(
              fetchHttp,
              target,
              normKey,
              isHinataSoul,
              useCache
            ),
            tvdbPreloadPromise,
          ]);

          const tvdbEnriched = await enrichServerDetailsWithTheTvdb(
            fetchHttp,
            baseDetails,
            catalogPrefs?.credentials,
            {
              skipEpisodePageHydration: fastMode,
              preloadedTvdb,
            }
          ).catch(() => baseDetails);

          return enrichDetailsWithMyAnimeListRating(fetchHttp, tvdbEnriched).catch(
            () => tvdbEnriched
          );
        },
        {
          useCache,
          shouldCache: (val) => Boolean(val),
        }
      );

      if (!enriched) {
        return { status: 502, body: { error: 'Falha ao carregar detalhes e episódios.' } };
      }
      return { status: 200, body: enriched };
    } catch (err) {
      const httpStatus = (err as { httpStatus?: number })?.httpStatus;
      return {
        status: httpStatus || 502,
        body: { error: err instanceof Error ? err.message : 'Falha ao carregar detalhes e episódios.' },
      };
    }
  }

  if (pathname === '/api/favorites/check' && method === 'POST') {
    const body = (options.jsonBody || {}) as { urls?: unknown };
    const rawUrls = Array.isArray(body?.urls) ? body.urls : [];
    const safeUrls = rawUrls
      .filter(
        (u): u is string =>
          typeof u === 'string' &&
          (isAnisyncUri(u) || (isAllowedServerSiteUrl(u) && !/\/filmes\//i.test(u)))
      )
      .map((u) => normalizeTopAnimesUrl(u))
      .filter((u, idx, arr) => Boolean(u) && arr.indexOf(u) === idx)
      .slice(0, 30);

    const latestByUrl: Record<string, FavoriteLatestInfo> = {};
    for (let i = 0; i < safeUrls.length; i += 4) {
      const chunk = safeUrls.slice(i, i + 4);
      await Promise.all(
        chunk.map(async (mediaUri) => {
          try {
            if (isAnisyncUri(mediaUri)) {
              const details = await getAggregatedMediaDetails(
                fetchHttp,
                mediaUri,
                catalogPrefs
              );
              if (!details) return;
              const latest = pickLatestAnimeEpisode(details.episodes, details.title, details.poster, {
                audioType: details.audioType,
                sourceServerName: details.sourceServerName,
              });
              if (latest) latestByUrl[mediaUri] = latest;
              return;
            }
            if (isHinataSoulUrl(mediaUri)) {
              const hsDetails = await fetchHinataSoulAnimeWithEpisodes(fetchHttp, mediaUri, {
                onlyLatest: true,
                timeoutMs: 7000,
              });
              if (!hsDetails) return;
              const latest = pickLatestAnimeEpisode(
                hsDetails.episodes,
                hsDetails.title,
                hsDetails.poster,
                {
                  audioType: hsDetails.audioType,
                  sourceServerName: HINATASOUL_BUILTIN_SOURCE.name,
                }
              );
              if (latest) latestByUrl[mediaUri] = latest;
              return;
            }
            const origin = new URL(mediaUri).origin;
            const response = await fetchHttp(mediaUri, {
              referer: `${origin}/`,
              timeoutMs: 7000,
            });
            if (!response.ok) return;
            const anime = parseAnimePageHtml(response.body, mediaUri);
            const latest = pickLatestAnimeEpisode(anime.episodes, anime.title, anime.poster, {
              audioType: anime.audioType,
              sourceServerName: TOPANIMES_BUILTIN_SOURCE.name,
            });
            if (latest) latestByUrl[mediaUri] = latest;
          } catch {
            // Skip unreachable titles silently
          }
        })
      );
    }

    return { status: 200, body: { latestByUrl } };
  }

  if (pathname === '/api/episode-synopsis') {
    const title = (url.searchParams.get('title') || '').trim();
    const originalTitle = (url.searchParams.get('originalTitle') || '').trim() || undefined;
    const year = (url.searchParams.get('year') || '').trim() || undefined;
    const mediaTypeParam = (url.searchParams.get('mediaType') || '').trim();
    const mediaType =
      mediaTypeParam === 'series'
        ? 'series'
        : mediaTypeParam === 'movie'
          ? 'movie'
          : 'anime';
    const seasonRaw = Number.parseInt(url.searchParams.get('season') || '', 10);
    const episodeRaw = Number.parseInt(url.searchParams.get('episode') || '', 10);
    const tvdbIdRaw = Number.parseInt(url.searchParams.get('tvdbId') || '', 10);
    const tvdbEpisodeIdRaw = Number.parseInt(url.searchParams.get('tvdbEpisodeId') || '', 10);
    const tvdbSlug = (url.searchParams.get('tvdbSlug') || '').trim() || undefined;
    const fallbackEnglishOverview =
      (url.searchParams.get('englishOverview') || '').trim().slice(0, 2000) || undefined;

    if (!title && !originalTitle && !tvdbIdRaw && !tvdbSlug && !tvdbEpisodeIdRaw) {
      return { status: 400, body: { error: 'Parâmetros insuficientes para buscar sinopse do episódio.' } };
    }

    try {
      const result = await resolveLocalizedEpisodeSynopsis(fetchHttp, {
        title: title || undefined,
        originalTitle,
        year,
        mediaType,
        seasonNumber: Number.isFinite(seasonRaw) && seasonRaw > 0 ? seasonRaw : 1,
        episodeNumber: Number.isFinite(episodeRaw) && episodeRaw > 0 ? episodeRaw : undefined,
        tvdbId: Number.isFinite(tvdbIdRaw) && tvdbIdRaw > 0 ? tvdbIdRaw : undefined,
        tvdbSlug,
        tvdbEpisodeId:
          Number.isFinite(tvdbEpisodeIdRaw) && tvdbEpisodeIdRaw > 0
            ? tvdbEpisodeIdRaw
            : undefined,
        fallbackEnglishOverview,
        credentials: catalogPrefs?.credentials,
        useCache,
      });

      return { status: 200, body: { result } };
    } catch {
      return { status: 200, body: { result: null } };
    }
  }

  if (pathname === '/api/episode-titles') {
    const rawIds = (url.searchParams.get('ids') || '').trim();
    const tvdbSlug = (url.searchParams.get('tvdbSlug') || '').trim() || undefined;
    const tvdbIdRaw = Number.parseInt(url.searchParams.get('tvdbId') || '', 10);
    const ids = rawIds
      .split(',')
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0)
      .slice(0, 28);

    if (ids.length === 0) {
      return { status: 200, body: { titlesById: {} } };
    }

    try {
      const titlesById = await resolveLocalizedEpisodeTitlesByIds(fetchHttp, ids, {
        tvdbSlug,
        tvdbSeriesId: Number.isFinite(tvdbIdRaw) && tvdbIdRaw > 0 ? tvdbIdRaw : undefined,
        useCache,
      });
      return { status: 200, body: { titlesById } };
    } catch {
      return { status: 200, body: { titlesById: {} } };
    }
  }

  if (pathname === '/api/anime-synopsis') {
    const title = (url.searchParams.get('title') || '').trim();
    const originalTitle = (url.searchParams.get('originalTitle') || '').trim() || undefined;
    const year = (url.searchParams.get('year') || '').trim() || undefined;
    const mediaTypeParam = (url.searchParams.get('mediaType') || '').trim();
    const mediaType =
      mediaTypeParam === 'series'
        ? 'series'
        : mediaTypeParam === 'movie'
          ? 'movie'
          : 'anime';
    const tvdbIdRaw = Number.parseInt(url.searchParams.get('tvdbId') || '', 10);
    const tvdbSlug = (url.searchParams.get('tvdbSlug') || '').trim() || undefined;
    const fallbackEnglishOverview =
      (url.searchParams.get('englishOverview') || '').trim().slice(0, 2000) || undefined;

    if (!title && !originalTitle && !tvdbIdRaw && !tvdbSlug) {
      return { status: 400, body: { error: 'Parâmetros insuficientes para buscar sinopse do anime.' } };
    }

    try {
      const result = await resolveLocalizedAnimeSynopsis(fetchHttp, {
        title: title || undefined,
        originalTitle,
        year,
        mediaType,
        tvdbId: Number.isFinite(tvdbIdRaw) && tvdbIdRaw > 0 ? tvdbIdRaw : undefined,
        tvdbSlug,
        fallbackEnglishOverview,
        credentials: catalogPrefs?.credentials,
        useCache,
      });

      return { status: 200, body: { result } };
    } catch {
      return { status: 200, body: { result: null } };
    }
  }

  if (pathname === '/api/episode') {
    const bodyObj = (options.jsonBody || {}) as {
      url?: string;
      audioPreference?: 'ALL' | 'DUB' | 'LEG';
      deferCrossSources?: boolean;
      refresh?: boolean;
    };
    const target = (url.searchParams.get('url') || bodyObj.url || '').trim();
    const audioPref =
      (url.searchParams.get('audio') as 'ALL' | 'DUB' | 'LEG' | null) ||
      bodyObj.audioPreference ||
      undefined;
    const deferCrossSources =
      Boolean(bodyObj.deferCrossSources) || url.searchParams.get('fast') === '1';
    const forceRefresh = Boolean(bodyObj.refresh) || url.searchParams.get('refresh') === '1';

    const allowedSite = isAllowedServerSiteUrl(target);
    if (!target || (!isAnisyncUri(target) && !allowedSite)) {
      return {
        status: 400,
        body: { error: 'Informe um identificador anisync:// válido ou URL de episódio suportada.' },
      };
    }

    const normEpTarget = isHinataSoulUrl(target)
      ? normalizeHinataSoulUrl(target) || target
      : isAnisyncUri(target)
        ? target
        : normalizeTopAnimesUrl(target) || target;
    const epCacheKey = `${normEpTarget}|a:${audioPref || 'ALL'}|d:${deferCrossSources ? 1 : 0}`;

    if (useCache && !forceRefresh) {
      const cachedEp = episodeDetailsRouterCache.get(epCacheKey);
      if (cachedEp) {
        return { status: 200, body: cachedEp };
      }
    }

    if (isAnisyncUri(target)) {
      try {
        const ep = await episodeDetailsRouterCache.getOrLoad(
          epCacheKey,
          async () => {
            const resolved = await resolveCanonicalEpisodeDetails(
              fetchHttp,
              target,
              audioPref,
              catalogPrefs,
              useCache
            );
            if (!resolved) {
              const notFound = new Error('Episódio ou título não encontrado.') as Error & {
                httpStatus?: number;
              };
              notFound.httpStatus = 404;
              throw notFound;
            }
            return resolved;
          },
          {
            useCache,
            forceRefresh,
            shouldCache: (val) => val.options.length > 0,
          }
        );
        return { status: 200, body: ep };
      } catch (err) {
        const httpStatus = (err as { httpStatus?: number })?.httpStatus;
        return {
          status: httpStatus || 502,
          body: {
            error:
              err instanceof Error
                ? err.message
                : 'Não foi possível consultar o servidor deste episódio.',
          },
        };
      }
    }

    // Direct Hinata Soul episode page (+ optional/deferred cross-server augmentation from TopAnimes)
    if (isHinataSoulUrl(target)) {
      try {
        const resultEp = await episodeDetailsRouterCache.getOrLoad(
          epCacheKey,
          async () => {
            const startedAt = Date.now();
            const origin = new URL(target).origin;
            const response = await fetchHttp(target, {
              referer: `${origin}/`,
              timeoutMs: 10000,
            });
            if (!response.ok) {
              throw new Error(
                'Não foi possível extrair os servidores deste episódio no Hinata Soul.'
              );
            }
            const parsedFull = parseHinataSoulEpisodePageHtml(response.body, target, origin);
            rememberHinataSoulEpisodePage(fetchHttp, target, parsedFull);
            void prefetchHinataSoulAdScript(fetchHttp);

            const { episode: parsed } = parsedFull;
            const primaryOptions: PlayerOption[] = parsed.options.map((o) => ({
              ...o,
              sourceId: HINATASOUL_BUILTIN_SOURCE.id,
              sourceName: HINATASOUL_BUILTIN_SOURCE.name,
              sourceKind: HINATASOUL_BUILTIN_SOURCE.kind,
            }));
            const primaryReport: EpisodeSourceReportSummary = {
              sourceId: HINATASOUL_BUILTIN_SOURCE.id,
              sourceName: HINATASOUL_BUILTIN_SOURCE.name,
              sourceKind: HINATASOUL_BUILTIN_SOURCE.kind,
              status: primaryOptions.length > 0 ? 'found' : 'not-found',
              optionsCount: primaryOptions.length,
              matchedTitle: parsed.title,
              matchedUrl: parsed.url,
              durationMs: Date.now() - startedAt,
            };

            if (deferCrossSources && primaryOptions.length > 0) {
              const cachedMeta = getCachedSeriesMeta(parsed.seriesUrl);
              return {
                ...parsed,
                genres: cachedMeta.genres?.length ? cachedMeta.genres : parsed.genres,
                originalTitle: parsed.originalTitle || cachedMeta.originalTitle,
                alternativeTitles: parsed.alternativeTitles?.length
                  ? parsed.alternativeTitles
                  : cachedMeta.alternativeTitles,
                options: primaryOptions,
                sourceReports: [primaryReport],
                sourceMode: 'live' as const,
              };
            }

            const crossAliases = parsed.seriesTitle
              ? await resolveCrossSourceAliasesForEpisode(fetchHttp, {
                  seriesTitle: parsed.seriesTitle,
                  seriesUrl: parsed.seriesUrl,
                  mediaType: parsed.mediaType || 'anime',
                  originalTitle: parsed.originalTitle,
                  alternativeTitles: parsed.alternativeTitles,
                })
              : {
                  originalTitle: undefined,
                  alternativeTitles: [] as string[],
                  genres: undefined as string[] | undefined,
                };

            const extra = parsed.seriesTitle
              ? await aggregateEpisodeServers(
                  fetchHttp,
                  {
                    title: parsed.seriesTitle,
                    originalTitle: crossAliases.originalTitle,
                    alternativeTitles: crossAliases.alternativeTitles,
                    mediaType: parsed.mediaType || 'anime',
                    seasonNumber: parsed.seasonNumber || 1,
                    episodeNumber: parsed.episodeNumber || 1,
                    audioPreference: audioPref,
                  },
                  { excludeSourceIds: [HINATASOUL_BUILTIN_SOURCE.id] }
                ).catch(() => ({ options: [], reports: [] }))
              : { options: [], reports: [] };

            return {
              ...parsed,
              genres: crossAliases.genres?.length ? crossAliases.genres : parsed.genres,
              originalTitle: parsed.originalTitle || crossAliases.originalTitle,
              alternativeTitles:
                parsed.alternativeTitles?.length
                  ? parsed.alternativeTitles
                  : crossAliases.alternativeTitles.length
                    ? crossAliases.alternativeTitles
                    : undefined,
              options: [...primaryOptions, ...extra.options],
              sourceReports: [primaryReport, ...extra.reports],
              sourceMode: 'live' as const,
            };
          },
          {
            useCache,
            forceRefresh,
            shouldCache: (val) => val.options.length > 0,
          }
        );
        return { status: 200, body: resultEp };
      } catch {
        // fall through
      }
      return {
        status: 502,
        body: { error: 'Não foi possível extrair os servidores deste episódio no Hinata Soul.' },
      };
    }

    // Direct TopAnimes episode / movie page (+ optional/deferred cross-server augmentation from Hinata Soul)
    try {
      const resultEp = await episodeDetailsRouterCache.getOrLoad(
        epCacheKey,
        async () => {
          const startedAt = Date.now();
          const origin = new URL(target).origin;
          const response = await fetchHttp(target, {
            referer: `${origin}/`,
            timeoutMs: 10000,
          });
          if (!response.ok) {
            throw new Error('Não foi possível extrair os servidores deste episódio.');
          }
          const parsed = parseEpisodePageHtml(response.body, target);
          const inferredEpNum =
            parsed.episodeNumber ??
            extractEpisodeNumber(target) ??
            extractEpisodeNumber(parsed.episodeLabel || '') ??
            extractEpisodeNumber(parsed.title) ??
            1;
          const inferredSeason =
            parsed.seasonNumber || extractHinataSoulSeasonNumber(parsed.seriesTitle || parsed.title);

          if (deferCrossSources) {
            const hydrated = await hydrateDooPlayEpisodeOptions(
              fetchHttp,
              response.body,
              target,
              parsed.options
            );
            const primaryOptions: PlayerOption[] = hydrated.map((o) => ({
              ...o,
              sourceId: TOPANIMES_BUILTIN_SOURCE.id,
              sourceName: TOPANIMES_BUILTIN_SOURCE.name,
              sourceKind: TOPANIMES_BUILTIN_SOURCE.kind,
            }));
            const primaryReport: EpisodeSourceReportSummary = {
              sourceId: TOPANIMES_BUILTIN_SOURCE.id,
              sourceName: TOPANIMES_BUILTIN_SOURCE.name,
              sourceKind: TOPANIMES_BUILTIN_SOURCE.kind,
              status: primaryOptions.length > 0 ? 'found' : 'not-found',
              optionsCount: primaryOptions.length,
              matchedTitle: parsed.title,
              matchedUrl: target,
              durationMs: Date.now() - startedAt,
            };

            if (primaryOptions.length > 0) {
              const cachedMeta = getCachedSeriesMeta(parsed.seriesUrl);
              return {
                ...parsed,
                genres: cachedMeta.genres?.length ? cachedMeta.genres : parsed.genres,
                originalTitle: parsed.originalTitle || cachedMeta.originalTitle,
                alternativeTitles: parsed.alternativeTitles?.length
                  ? parsed.alternativeTitles
                  : cachedMeta.alternativeTitles,
                episodeNumber: inferredEpNum,
                seasonNumber: inferredSeason,
                options: primaryOptions,
                sourceReports: [primaryReport],
                sourceMode: 'live' as const,
              };
            }

            const crossAliases = parsed.seriesTitle
              ? await resolveCrossSourceAliasesForEpisode(fetchHttp, {
                  seriesTitle: parsed.seriesTitle,
                  seriesUrl: parsed.seriesUrl,
                  mediaType: parsed.isMovie ? 'movie' : 'anime',
                  originalTitle: parsed.originalTitle,
                  alternativeTitles: parsed.alternativeTitles,
                })
              : {
                  originalTitle: undefined,
                  alternativeTitles: [] as string[],
                  genres: undefined as string[] | undefined,
                };

            const extra = parsed.seriesTitle
              ? await aggregateEpisodeServers(
                  fetchHttp,
                  {
                    title: parsed.seriesTitle,
                    originalTitle: crossAliases.originalTitle,
                    alternativeTitles: crossAliases.alternativeTitles,
                    mediaType: parsed.isMovie ? 'movie' : 'anime',
                    seasonNumber: inferredSeason,
                    episodeNumber: inferredEpNum,
                    audioPreference: audioPref,
                  },
                  { excludeSourceIds: [TOPANIMES_BUILTIN_SOURCE.id] }
                ).catch(() => ({ options: [], reports: [] }))
              : { options: [], reports: [] };

            return {
              ...parsed,
              genres: crossAliases.genres?.length ? crossAliases.genres : parsed.genres,
              originalTitle: parsed.originalTitle || crossAliases.originalTitle,
              alternativeTitles:
                parsed.alternativeTitles?.length
                  ? parsed.alternativeTitles
                  : crossAliases.alternativeTitles.length
                    ? crossAliases.alternativeTitles
                    : undefined,
              episodeNumber: inferredEpNum,
              seasonNumber: inferredSeason,
              options: [...primaryOptions, ...extra.options],
              sourceReports: [primaryReport, ...extra.reports],
              sourceMode: 'live' as const,
            };
          }

          const [hydrated, extraWithAliases] = await Promise.all([
            hydrateDooPlayEpisodeOptions(fetchHttp, response.body, target, parsed.options),
            parsed.seriesTitle
              ? (async () => {
                  const crossAliases = await resolveCrossSourceAliasesForEpisode(fetchHttp, {
                    seriesTitle: parsed.seriesTitle!,
                    seriesUrl: parsed.seriesUrl,
                    mediaType: parsed.isMovie ? 'movie' : 'anime',
                    originalTitle: parsed.originalTitle,
                    alternativeTitles: parsed.alternativeTitles,
                  });
                  const extraRes = await aggregateEpisodeServers(
                    fetchHttp,
                    {
                      title: parsed.seriesTitle!,
                      originalTitle: crossAliases.originalTitle,
                      alternativeTitles: crossAliases.alternativeTitles,
                      mediaType: parsed.isMovie ? 'movie' : 'anime',
                      seasonNumber: inferredSeason,
                      episodeNumber: inferredEpNum,
                      audioPreference: audioPref,
                    },
                    { excludeSourceIds: [TOPANIMES_BUILTIN_SOURCE.id] }
                  ).catch(() => ({ options: [], reports: [] }));
                  return { ...extraRes, crossAliases };
                })()
              : Promise.resolve({
                  options: [],
                  reports: [],
                  crossAliases: {
                    originalTitle: undefined,
                    alternativeTitles: [] as string[],
                    genres: undefined as string[] | undefined,
                  },
                }),
          ]);

          const primaryOptions: PlayerOption[] = hydrated.map((o) => ({
            ...o,
            sourceId: TOPANIMES_BUILTIN_SOURCE.id,
            sourceName: TOPANIMES_BUILTIN_SOURCE.name,
            sourceKind: TOPANIMES_BUILTIN_SOURCE.kind,
          }));
          const primaryReport: EpisodeSourceReportSummary = {
            sourceId: TOPANIMES_BUILTIN_SOURCE.id,
            sourceName: TOPANIMES_BUILTIN_SOURCE.name,
            sourceKind: TOPANIMES_BUILTIN_SOURCE.kind,
            status: primaryOptions.length > 0 ? 'found' : 'not-found',
            optionsCount: primaryOptions.length,
            matchedTitle: parsed.title,
            matchedUrl: target,
            durationMs: Date.now() - startedAt,
          };

          return {
            ...parsed,
            genres: extraWithAliases.crossAliases.genres?.length
              ? extraWithAliases.crossAliases.genres
              : parsed.genres,
            originalTitle: parsed.originalTitle || extraWithAliases.crossAliases.originalTitle,
            alternativeTitles:
              parsed.alternativeTitles?.length
                ? parsed.alternativeTitles
                : extraWithAliases.crossAliases.alternativeTitles.length
                  ? extraWithAliases.crossAliases.alternativeTitles
                  : undefined,
            episodeNumber: inferredEpNum,
            seasonNumber: inferredSeason,
            options: [...primaryOptions, ...extraWithAliases.options],
            sourceReports: [primaryReport, ...extraWithAliases.reports],
            sourceMode: 'live' as const,
          };
        },
        {
          useCache,
          forceRefresh,
          shouldCache: (val) => val.options.length > 0,
        }
      );
      return { status: 200, body: resultEp };
    } catch {
      // fall through
    }
    return {
      status: 502,
      body: { error: 'Não foi possível extrair os servidores deste episódio.' },
    };
  }

  if (pathname === '/api/sources/resolve' && method === 'POST') {
    const bodyObj = (options.jsonBody || {}) as {
      query?: EpisodeSourceLookupQuery;
      excludeSourceIds?: string[];
    };
    if (!bodyObj?.query?.title) {
      return { status: 400, body: { error: 'Informe query.title para consultar o servidor.' } };
    }
    const crossAliases = await resolveCrossSourceAliasesForEpisode(fetchHttp, {
      seriesTitle: bodyObj.query.title,
      seriesUrl: bodyObj.query.seriesUrl,
      mediaType: bodyObj.query.mediaType || 'anime',
      originalTitle: bodyObj.query.originalTitle,
      alternativeTitles: bodyObj.query.alternativeTitles,
    }).catch(() => ({
      originalTitle: bodyObj.query?.originalTitle,
      alternativeTitles: bodyObj.query?.alternativeTitles || [],
    }));
    const enrichedQuery: EpisodeSourceLookupQuery = {
      ...bodyObj.query,
      originalTitle: bodyObj.query.originalTitle || crossAliases.originalTitle,
      alternativeTitles:
        crossAliases.alternativeTitles.length > 0
          ? Array.from(
              new Set([
                ...(bodyObj.query.alternativeTitles || []),
                ...crossAliases.alternativeTitles,
              ])
            )
          : bodyObj.query.alternativeTitles,
    };
    const result = await aggregateEpisodeServers(fetchHttp, enrichedQuery, {
      excludeSourceIds: Array.isArray(bodyObj.excludeSourceIds)
        ? bodyObj.excludeSourceIds.filter((s): s is string => typeof s === 'string')
        : undefined,
    });
    return { status: 200, body: result };
  }

  if (pathname === '/api/sources/test' && method === 'POST') {
    const targetSource = findBuiltinSourceFromBody(options.jsonBody);
    const result = await testEpisodeSource(fetchHttp, targetSource);
    return { status: 200, body: result };
  }

  if (pathname === '/api/resolve-embed') {
    if (method === 'POST' && options.jsonBody && typeof options.jsonBody === 'object') {
      const opt = options.jsonBody as PlayerOption;
      if (!opt.embedUrl && !opt.directStreamUrl) {
        return {
          status: 400,
          body: { error: 'Parâmetro embedUrl ou directStreamUrl obrigatório.' },
        };
      }
      const cacheKey = opt.directStreamUrl || opt.embedUrl;
      const resolved = await resolveEmbedCachedInRouter(
        cacheKey,
        () => resolveServerOptionToStreams(fetchHttp, opt),
        useCache
      );
      return { status: 200, body: resolved };
    }

    const target = (url.searchParams.get('url') || '').trim();
    if (!target) {
      return { status: 400, body: { error: 'Parâmetro url obrigatório.' } };
    }
    const resolved = await resolveEmbedCachedInRouter(
      target,
      () => resolveEmbedByUrl(fetchHttp, target),
      useCache
    );
    return { status: 200, body: resolved };
  }

  return { status: 404, body: { error: `Rota desconhecida: ${pathname}` } };
}
