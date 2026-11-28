import { apiFetch, clearNativeApiCaches } from './apiClient.ts';
import { inferMediaKindFromTarget, isAnisyncUri } from './catalog/idCodec.ts';
import { computeAdaptiveMediaCacheTtlMs } from './episodeAvailability.ts';
import {
  createEmbedCacheEntry,
  isEmbedCacheEntryValid,
  type CachedEmbedEntry,
} from './embedCache.ts';
import { normalizeTopAnimesUrl } from './favoriteAlerts.ts';
import type { EpisodeSourceConfig } from './sources/types.ts';
import type {
  AniListDiscoverFilters,
  AnimeDetails,
  AnimeEpisodeLink,
  AnimeSynopsisResult,
  AudioType,
  CalendarDaySection,
  CatalogArchiveCategory,
  CatalogFilters,
  CatalogMediaItem,
  CatalogSourceId,
  DiscoverCatalogResponse,
  DiscoverTaxonomyResponse,
  EpisodeDetails,
  EpisodeSynopsisResult,
  ExternalMediaIds,
  GlossaryResponse,
  HomeCatalog,
  LiveChartScheduleMode,
  MediaKind,
  PaginatedCatalogResponse,
  PaginatedSearchResponse,
  PlayerOption,
  ResolvedEmbed,
  SearchSuggestResponse,
  SliderMovieItem,
  WeeklyCalendarResponse,
} from './types.ts';
import { isHinataSoulUrl, isSafeExternalHttpUrl, normalizeHinataSoulUrl } from './urlSafety.ts';

export interface MediaNavigationSeed {
  title?: string;
  poster?: string;
  backdrop?: string;
  kind?: MediaKind;
  audioType?: AudioType;
  year?: string;
  rating?: string;
  episodeLabel?: string;
  sourceServerName?: string;
  catalogSource?: CatalogSourceId;
  externalIds?: ExternalMediaIds;
  genres?: string[];
  synopsis?: string;
  seriesTitle?: string;
  seriesUrl?: string;
  prevUrl?: string;
  nextUrl?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  isMovie?: boolean;
  tvdbEpisodeId?: number;
}

export interface PersistedArchiveSnapshot {
  items: CatalogMediaItem[];
  currentPage: number;
  totalPages: number;
  fetchedAtMs: number;
}

export interface PersistedSwrSnapshot {
  version: 1;
  savedAt: number;
  home?: { data: HomeCatalog; fetchedAtMs: number };
  releases?: {
    items: CatalogMediaItem[];
    currentPage: number;
    totalPages: number;
    fetchedAtMs: number;
  };
  calendar?: Record<string, { days: CalendarDaySection[]; fetchedAtMs: number }>;
  archive?: Partial<Record<CatalogArchiveCategory, PersistedArchiveSnapshot>>;
  featuredAnimes?: CatalogMediaItem[];
  sliderMovies?: SliderMovieItem[];
  catalogFilters?: CatalogFilters;
}

interface TtlEntry<T> {
  value: T;
  expiresAt: number;
}

class ClientCoalescedCache<T> {
  private readonly entries = new Map<string, TtlEntry<T>>();
  private readonly inFlight = new Map<string, Promise<T>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(ttlMs: number, maxEntries = 50) {
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
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit.value;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  set(key: string, value: T, ttlOverrideMs?: number): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    } else if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, {
      value,
      expiresAt: Date.now() + (ttlOverrideMs ?? this.ttlMs),
    });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  async getOrLoad(
    key: string,
    loader: () => Promise<T>,
    options: {
      forceRefresh?: boolean;
      shouldCache?: (value: T) => boolean;
      getTtlMs?: (value: T) => number;
    } = {}
  ): Promise<T> {
    if (!options.forceRefresh) {
      const cached = this.get(key);
      if (cached !== undefined) return cached;
      const pending = this.inFlight.get(key);
      if (pending) return pending;
    }

    const req = loader();
    if (!options.forceRefresh) {
      this.inFlight.set(key, req);
    }
    try {
      const value = await req;
      const canCache = options.shouldCache
        ? options.shouldCache(value)
        : value !== undefined && value !== null;
      if (canCache) {
        this.set(key, value, options.getTtlMs?.(value));
      }
      return value;
    } finally {
      if (this.inFlight.get(key) === req) {
        this.inFlight.delete(key);
      }
    }
  }

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
  }
}

export function normalizeMediaCacheKey(rawUrl: string): string {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) return '';
  if (isAnisyncUri(trimmed)) return trimmed;
  if (isHinataSoulUrl(trimmed)) return normalizeHinataSoulUrl(trimmed) || trimmed;
  return normalizeTopAnimesUrl(trimmed) || trimmed;
}

const ANIME_FULL_TTL_MS = 10 * 60 * 1000;
const ANIME_QUICK_TTL_MS = 3 * 60 * 1000;
const EPISODE_DETAILS_TTL_MS = 5 * 60 * 1000;
const SYNOPSIS_TTL_MS = 30 * 60 * 1000;
const EPISODE_TITLE_TTL_MS = 30 * 60 * 1000;
const CALENDAR_TTL_MS = 5 * 60 * 1000;
const ARCHIVE_TTL_MS = 5 * 60 * 1000;
const GLOSSARY_TTL_MS = 10 * 60 * 1000;
const RELEASES_TTL_MS = 2 * 60 * 1000;
const SEARCH_TTL_MS = 3 * 60 * 1000;

const animeDetailsFullCache = new ClientCoalescedCache<AnimeDetails>(ANIME_FULL_TTL_MS, 50);
const animeDetailsQuickCache = new ClientCoalescedCache<AnimeDetails>(ANIME_QUICK_TTL_MS, 50);
const episodeDetailsCache = new ClientCoalescedCache<EpisodeDetails>(EPISODE_DETAILS_TTL_MS, 50);
const animeSynopsisCache = new ClientCoalescedCache<AnimeSynopsisResult | null>(SYNOPSIS_TTL_MS, 100);
const episodeSynopsisCache = new ClientCoalescedCache<EpisodeSynopsisResult | null>(SYNOPSIS_TTL_MS, 120);
const calendarCache = new ClientCoalescedCache<WeeklyCalendarResponse>(CALENDAR_TTL_MS, 12);
const archivePageCache = new ClientCoalescedCache<PaginatedCatalogResponse>(ARCHIVE_TTL_MS, 40);
const filteredCatalogCache = new ClientCoalescedCache<PaginatedCatalogResponse>(ARCHIVE_TTL_MS, 40);
const discoverCatalogCache = new ClientCoalescedCache<DiscoverCatalogResponse>(ARCHIVE_TTL_MS, 50);
const discoverTaxonomyCache = new ClientCoalescedCache<DiscoverTaxonomyResponse>(24 * 60 * 60 * 1000, 4);
const glossaryCache = new ClientCoalescedCache<GlossaryResponse>(GLOSSARY_TTL_MS, 40);
const releasesPageCache = new ClientCoalescedCache<PaginatedCatalogResponse>(RELEASES_TTL_MS, 15);
const searchPageCache = new ClientCoalescedCache<PaginatedSearchResponse>(SEARCH_TTL_MS, 30);
const searchSuggestCache = new ClientCoalescedCache<SearchSuggestResponse>(SEARCH_TTL_MS, 60);

const episodeTitlesCache = new Map<number, { title: string | null; expiresAt: number }>();
const MAX_EPISODE_TITLE_CACHE = 600;

const embedCache = new Map<string, CachedEmbedEntry>();
const embedInFlight = new Map<string, Promise<ResolvedEmbed>>();
const MAX_EMBED_CACHE = 80;

// --- Persistent SWR snapshot (localStorage) ---

const SWR_STORAGE_KEY = 'anisync:swr_snapshot:v1';
const MAX_PERSISTED_SWR_AGE_MS = 24 * 60 * 60 * 1000;
export const SWR_SOFT_FRESH_TTL_MS = 2 * 60 * 1000;

let inMemorySwrSnapshot: PersistedSwrSnapshot | null = null;
let swrSaveTimer: number | null = null;

function isLocalStorageAvailable(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage !== null;
  } catch {
    return false;
  }
}

export function loadPersistedSwrSnapshot(): PersistedSwrSnapshot | null {
  if (inMemorySwrSnapshot) {
    if (Date.now() - inMemorySwrSnapshot.savedAt <= MAX_PERSISTED_SWR_AGE_MS) {
      return inMemorySwrSnapshot;
    }
    inMemorySwrSnapshot = null;
  }
  if (!isLocalStorageAvailable()) return null;
  try {
    const raw = localStorage.getItem(SWR_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedSwrSnapshot>;
    if (!parsed || parsed.version !== 1 || typeof parsed.savedAt !== 'number') {
      return null;
    }
    if (Date.now() - parsed.savedAt > MAX_PERSISTED_SWR_AGE_MS) {
      localStorage.removeItem(SWR_STORAGE_KEY);
      return null;
    }
    inMemorySwrSnapshot = parsed as PersistedSwrSnapshot;
    return inMemorySwrSnapshot;
  } catch {
    return null;
  }
}

export function isSwrDataFresh(fetchedAtMs: number | undefined, ttlMs = SWR_SOFT_FRESH_TTL_MS): boolean {
  if (!fetchedAtMs || !Number.isFinite(fetchedAtMs)) return false;
  return Date.now() - fetchedAtMs < ttlMs;
}

function flushSwrSnapshotNow(): void {
  if (!inMemorySwrSnapshot || !isLocalStorageAvailable()) return;
  try {
    localStorage.setItem(SWR_STORAGE_KEY, JSON.stringify(inMemorySwrSnapshot));
  } catch {
    // Trim heavier optional sections and retry once if storage quota is tight
    try {
      const compact: PersistedSwrSnapshot = {
        version: 1,
        savedAt: inMemorySwrSnapshot.savedAt,
        home: inMemorySwrSnapshot.home,
        releases: inMemorySwrSnapshot.releases
          ? {
              ...inMemorySwrSnapshot.releases,
              items: inMemorySwrSnapshot.releases.items.slice(0, 24),
            }
          : undefined,
      };
      localStorage.setItem(SWR_STORAGE_KEY, JSON.stringify(compact));
    } catch {
      // Ignore storage quota errors cleanly
    }
  }
}

function scheduleSwrSnapshotFlush(): void {
  if (!isLocalStorageAvailable()) return;
  if (typeof window === 'undefined') {
    flushSwrSnapshotNow();
    return;
  }
  if (swrSaveTimer !== null) return;
  swrSaveTimer = window.setTimeout(() => {
    swrSaveTimer = null;
    flushSwrSnapshotNow();
  }, 450);
}

function ensureSwrSnapshot(): PersistedSwrSnapshot {
  const current = loadPersistedSwrSnapshot();
  if (current) return current;
  inMemorySwrSnapshot = { version: 1, savedAt: Date.now() };
  return inMemorySwrSnapshot;
}

export function persistSwrHome(home: HomeCatalog): void {
  if (!home || (home.releases.length === 0 && home.animes.length === 0 && home.movies.length === 0)) {
    return;
  }
  const snap = ensureSwrSnapshot();
  const now = Date.now();
  snap.savedAt = now;
  snap.home = {
    data: {
      ...home,
      releases: home.releases.slice(0, 32),
      animes: home.animes.slice(0, 30),
      movies: home.movies.slice(0, 30),
      series: (home.series || []).slice(0, 24),
      calendar: home.calendar.slice(0, 20),
    },
    fetchedAtMs: now,
  };
  scheduleSwrSnapshotFlush();
}

export function persistSwrReleases(
  items: CatalogMediaItem[],
  currentPage: number,
  totalPages: number
): void {
  if (!items.length || currentPage !== 1) return;
  const snap = ensureSwrSnapshot();
  const now = Date.now();
  snap.savedAt = now;
  snap.releases = {
    items: items.slice(0, 36),
    currentPage: 1,
    totalPages: Math.max(1, totalPages),
    fetchedAtMs: now,
  };
  scheduleSwrSnapshotFlush();
}

export function persistSwrCalendar(mode: LiveChartScheduleMode, days: CalendarDaySection[]): void {
  if (!days.length) return;
  const snap = ensureSwrSnapshot();
  const now = Date.now();
  snap.savedAt = now;
  snap.calendar = {
    ...(snap.calendar || {}),
    [mode]: { days, fetchedAtMs: now },
  };
  scheduleSwrSnapshotFlush();
}

export function persistSwrArchive(
  category: CatalogArchiveCategory,
  pageData: PaginatedCatalogResponse
): void {
  if (!pageData.items.length || (pageData.currentPage && pageData.currentPage > 1)) return;
  const snap = ensureSwrSnapshot();
  const now = Date.now();
  snap.savedAt = now;
  const nextArchive: Partial<Record<CatalogArchiveCategory, PersistedArchiveSnapshot>> = {
    ...(snap.archive || {}),
    [category]: {
      items: pageData.items.slice(0, 36),
      currentPage: 1,
      totalPages: Math.max(1, pageData.totalPages || 1),
      fetchedAtMs: now,
    },
  };
  // Keep at most 4 archive categories persisted to stay compact
  const archiveKeys = Object.keys(nextArchive) as CatalogArchiveCategory[];
  if (archiveKeys.length > 4) {
    archiveKeys
      .sort((a, b) => (nextArchive[a]?.fetchedAtMs || 0) - (nextArchive[b]?.fetchedAtMs || 0))
      .slice(0, archiveKeys.length - 4)
      .forEach((oldKey) => {
        delete nextArchive[oldKey];
      });
  }
  snap.archive = nextArchive;
  if (category === 'animes' && Array.isArray(pageData.featured) && pageData.featured.length > 0) {
    snap.featuredAnimes = pageData.featured.slice(0, 12);
  }
  if (
    category === 'movies' &&
    Array.isArray(pageData.sliderMovies) &&
    pageData.sliderMovies.length > 0
  ) {
    snap.sliderMovies = pageData.sliderMovies.slice(0, 8);
  }
  if (pageData.filters && pageData.filters.genres.length > 0) {
    snap.catalogFilters = pageData.filters;
  }
  scheduleSwrSnapshotFlush();
}

export function clearPersistedSwrSnapshot(): void {
  inMemorySwrSnapshot = null;
  if (swrSaveTimer !== null && typeof window !== 'undefined') {
    window.clearTimeout(swrSaveTimer);
    swrSaveTimer = null;
  }
  if (!isLocalStorageAvailable()) return;
  try {
    localStorage.removeItem(SWR_STORAGE_KEY);
  } catch {
    // ignore
  }
}

// --- Network-aware concurrency-limited background prefetch scheduler ---

interface QueuedPrefetchTask {
  key: string;
  run: () => Promise<unknown>;
}

const MAX_BG_CONCURRENCY = 2;
const MAX_BG_QUEUE = 10;

let activeBgTasks = 0;
const activeBgKeys = new Set<string>();
const bgQueue: QueuedPrefetchTask[] = [];

export function canBackgroundPrefetch(options: { intentTriggered?: boolean } = {}): boolean {
  if (typeof navigator === 'undefined') return true;
  if (navigator.onLine === false) return false;
  const nav = navigator as Navigator & {
    connection?: { saveData?: boolean; effectiveType?: string };
  };
  const conn = nav.connection;
  if (conn?.saveData) return false;
  if (!options.intentTriggered && (conn?.effectiveType === '2g' || conn?.effectiveType === 'slow-2g')) {
    return false;
  }
  return true;
}

function drainBackgroundQueue(): void {
  while (activeBgTasks < MAX_BG_CONCURRENCY && bgQueue.length > 0) {
    const next = bgQueue.shift();
    if (!next) break;
    activeBgTasks += 1;
    activeBgKeys.add(next.key);
    void Promise.resolve()
      .then(() => next.run())
      .catch(() => {
        // Background prefetch is strictly best-effort
      })
      .finally(() => {
        activeBgTasks = Math.max(0, activeBgTasks - 1);
        activeBgKeys.delete(next.key);
        drainBackgroundQueue();
      });
  }
}

export function scheduleBackgroundPrefetch(
  key: string,
  task: () => Promise<unknown>,
  options: { intentTriggered?: boolean } = {}
): void {
  if (!canBackgroundPrefetch(options)) return;
  if (activeBgKeys.has(key) || bgQueue.some((t) => t.key === key)) return;
  if (bgQueue.length >= MAX_BG_QUEUE) {
    // Evict oldest queued prefetch so recent user intent takes priority
    bgQueue.shift();
  }
  bgQueue.push({ key, run: task });
  drainBackgroundQueue();
}

export function getBackgroundPrefetchStats(): { active: number; queued: number } {
  return { active: activeBgTasks, queued: bgQueue.length };
}

// --- JS chunk & image preloaders ---

type RouteChunkName = 'anime' | 'episode' | 'settings';
const chunkPreloaders: Partial<Record<RouteChunkName, () => Promise<unknown>>> = {};
const preloadedChunks = new Set<RouteChunkName>();

export function registerRouteChunkPreloaders(
  loaders: Partial<Record<RouteChunkName, () => Promise<unknown>>>
): void {
  Object.assign(chunkPreloaders, loaders);
}

export function preloadRouteChunk(name: RouteChunkName): void {
  if (preloadedChunks.has(name)) return;
  const loader = chunkPreloaders[name];
  if (!loader) return;
  preloadedChunks.add(name);
  void loader().catch(() => {
    preloadedChunks.delete(name);
  });
}

export function preloadAllRouteChunks(): void {
  preloadRouteChunk('anime');
  preloadRouteChunk('episode');
}

const preloadedImages = new Set<string>();
const MAX_PRELOADED_IMAGES = 80;

export function preloadImage(src?: string): void {
  if (!src || typeof Image === 'undefined') return;
  if (!canBackgroundPrefetch({ intentTriggered: true })) return;
  const clean = src.trim();
  if (!clean || preloadedImages.has(clean)) return;
  if (preloadedImages.size >= MAX_PRELOADED_IMAGES) {
    const oldest = preloadedImages.values().next().value;
    if (oldest) preloadedImages.delete(oldest);
  }
  preloadedImages.add(clean);
  try {
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    img.decoding = 'async';
    img.src = clean;
  } catch {
    // ignore
  }
}

// --- Shared Cache Accessors & Coalesced API Loaders ---

export function getCachedAnimeDetailsFull(url: string): AnimeDetails | undefined {
  return animeDetailsFullCache.get(normalizeMediaCacheKey(url));
}

export function setCachedAnimeDetailsFull(url: string, details: AnimeDetails): void {
  const key = normalizeMediaCacheKey(url);
  if (!key) return;
  const adaptiveTtlMs = computeAdaptiveMediaCacheTtlMs(details);
  animeDetailsFullCache.set(key, details, adaptiveTtlMs);
  // Also index by canonical details.url if redirected/normalized differently
  const canonKey = normalizeMediaCacheKey(details.url);
  if (canonKey && canonKey !== key) {
    animeDetailsFullCache.set(canonKey, details, adaptiveTtlMs);
  }
}

export function getCachedAnimeDetailsQuick(url: string): AnimeDetails | undefined {
  const key = normalizeMediaCacheKey(url);
  return animeDetailsFullCache.get(key) || animeDetailsQuickCache.get(key);
}

export async function fetchAnimeDetailsQuick(url: string): Promise<AnimeDetails> {
  const key = normalizeMediaCacheKey(url);
  const fullHit = animeDetailsFullCache.get(key);
  if (fullHit) return fullHit;

  return animeDetailsQuickCache.getOrLoad(key, async () => {
    const res = await apiFetch(`/api/media?url=${encodeURIComponent(url)}&stage=quick`);
    const data = (await res.json()) as AnimeDetails & { error?: string };
    if (!res.ok) throw new Error(data.error || 'Erro ao carregar detalhes do título');
    if (data.enrichmentSources && data.enrichmentSources.length > 0) {
      // Router returned an already-enriched cache hit!
      setCachedAnimeDetailsFull(url, data);
    }
    return data;
  });
}

export interface AnimeDetailsLookupHints {
  title?: string;
  tvdbId?: number;
  tvdbSlug?: string;
  kind?: MediaKind;
  year?: string;
}

const animeDetailsMetadataCache = new ClientCoalescedCache<AnimeDetails>(5 * 60 * 1000, 60);

function buildAnimeDetailsParams(
  url: string,
  hints?: AnimeDetailsLookupHints,
  extraParams?: Record<string, string>
): URLSearchParams {
  const params = new URLSearchParams({ url, fast: '1', ...(extraParams || {}) });
  const hintTitle = hints?.title?.trim();
  if (hintTitle) params.set('title', hintTitle);
  if (
    typeof hints?.tvdbId === 'number' &&
    Number.isFinite(hints.tvdbId) &&
    hints.tvdbId > 0
  ) {
    params.set('tvdbId', String(Math.trunc(hints.tvdbId)));
  }
  const hintTvdbSlug = hints?.tvdbSlug?.trim();
  if (hintTvdbSlug) params.set('tvdbSlug', hintTvdbSlug);
  if (hints?.kind === 'anime' || hints?.kind === 'movie' || hints?.kind === 'series') {
    params.set('kind', hints.kind);
  }
  const hintYear = hints?.year?.trim();
  if (hintYear) params.set('year', hintYear);
  return params;
}

export async function fetchAnimeDetailsMetadata(
  url: string,
  options: { hints?: AnimeDetailsLookupHints } = {}
): Promise<AnimeDetails | null> {
  const key = normalizeMediaCacheKey(url);
  const fullHit = animeDetailsFullCache.get(key);
  if (fullHit) return fullHit;

  try {
    return await animeDetailsMetadataCache.getOrLoad(key, async () => {
      const params = buildAnimeDetailsParams(url, options.hints, { stage: 'metadata' });
      const res = await apiFetch(`/api/media?${params.toString()}`);
      if (!res.ok) {
        throw new Error('Metadata not found');
      }
      return (await res.json()) as AnimeDetails;
    });
  } catch {
    return null;
  }
}

export async function fetchAnimeDetailsFull(
  url: string,
  options: { forceRefresh?: boolean; hints?: AnimeDetailsLookupHints } = {}
): Promise<AnimeDetails> {
  const key = normalizeMediaCacheKey(url);
  return animeDetailsFullCache.getOrLoad(
    key,
    async () => {
      const params = buildAnimeDetailsParams(url, options.hints);
      const res = await apiFetch(`/api/media?${params.toString()}`);
      const data = (await res.json()) as AnimeDetails & { error?: string };
      if (!res.ok) throw new Error(data.error || 'Erro ao carregar detalhes do título');
      const canonKey = normalizeMediaCacheKey(data.url);
      if (canonKey && canonKey !== key) {
        animeDetailsFullCache.set(canonKey, data, computeAdaptiveMediaCacheTtlMs(data));
      }
      return data;
    },
    {
      forceRefresh: options.forceRefresh,
      getTtlMs: (details) => computeAdaptiveMediaCacheTtlMs(details),
    }
  );
}

export function getCachedEpisodeDetails(url: string): EpisodeDetails | undefined {
  return episodeDetailsCache.get(normalizeMediaCacheKey(url));
}

export function setCachedEpisodeDetails(url: string, details: EpisodeDetails): void {
  const key = normalizeMediaCacheKey(url);
  if (!key) return;
  episodeDetailsCache.set(key, details);
}

export function deleteCachedEpisodeDetails(url: string): void {
  const key = normalizeMediaCacheKey(url);
  if (key) episodeDetailsCache.delete(key);
}

export async function fetchEpisodeDetailsFast(
  url: string,
  options: {
    sources?: EpisodeSourceConfig[];
    audioPreference?: 'ALL' | 'DUB' | 'LEG';
    deferCrossSources?: boolean;
    bypassCache?: boolean;
  } = {}
): Promise<EpisodeDetails> {
  const key = normalizeMediaCacheKey(url);
  if (options.bypassCache) {
    episodeDetailsCache.delete(key);
  }
  return episodeDetailsCache.getOrLoad(
    key,
    async () => {
      const res = await apiFetch('/api/episode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          sources: options.sources,
          audioPreference: options.audioPreference,
          deferCrossSources: options.deferCrossSources ?? !options.bypassCache,
          refresh: Boolean(options.bypassCache),
        }),
      });
      const data = (await res.json()) as EpisodeDetails & { error?: string };
      if (!res.ok) throw new Error(data.error || 'Erro ao consultar fontes do episódio');
      return data;
    },
    { forceRefresh: options.bypassCache }
  );
}

export function getCachedEmbed(embedUrl: string): ResolvedEmbed | undefined {
  const hit = embedCache.get(embedUrl);
  if (isEmbedCacheEntryValid(hit)) return hit.data;
  if (hit) embedCache.delete(embedUrl);
  return undefined;
}

export function deleteCachedEmbed(embedUrl: string): void {
  embedCache.delete(embedUrl);
}

export function clearCachedEmbeds(): void {
  embedCache.clear();
  embedInFlight.clear();
}

export async function resolveEmbedCachedGlobal(opt: PlayerOption): Promise<ResolvedEmbed> {
  if (opt.directStreamUrl && isSafeExternalHttpUrl(opt.directStreamUrl)) {
    const format =
      opt.directFormat ||
      (/\.m3u8(?:$|\?)/i.test(opt.directStreamUrl)
        ? 'hls'
        : /\.(?:mp4|mkv|webm|m4v)(?:$|\?)/i.test(opt.directStreamUrl)
          ? 'mp4'
          : 'unknown');
    return {
      embedUrl: opt.embedUrl || opt.directStreamUrl,
      provider: opt.label,
      status: 'resolved',
      streams: [
        {
          label: opt.qualityLabel || (format === 'hls' ? 'HLS' : 'Direto'),
          height: 1080,
          url: opt.directStreamUrl,
          format,
        },
      ],
      subtitles: opt.directSubtitles || [],
      referer: opt.directReferer || opt.directStreamUrl,
      preferDirect: true,
    };
  }

  const cacheKey = opt.embedUrl;
  const cached = embedCache.get(cacheKey);
  if (isEmbedCacheEntryValid(cached)) {
    return cached.data;
  }
  if (cached) {
    embedCache.delete(cacheKey);
  }

  const pending = embedInFlight.get(cacheKey);
  if (pending) return pending;

  const req = (async (): Promise<ResolvedEmbed> => {
    try {
      const res = await apiFetch(`/api/resolve-embed?url=${encodeURIComponent(opt.embedUrl)}`);
      const data = (await res.json()) as ResolvedEmbed;
      const entry = createEmbedCacheEntry(data);
      if (entry) {
        if (embedCache.size >= MAX_EMBED_CACHE) {
          const oldest = embedCache.keys().next().value;
          if (oldest) embedCache.delete(oldest);
        }
        embedCache.set(cacheKey, entry);
      } else {
        embedCache.delete(cacheKey);
      }
      return data;
    } catch {
      return {
        embedUrl: opt.embedUrl,
        provider: opt.label,
        status: 'error',
        streams: [],
        subtitles: [],
        referer: opt.directReferer || 'https://topanimes.net/',
        errorMessage: 'Não foi possível contactar o servidor de extração.',
      };
    }
  })();

  embedInFlight.set(cacheKey, req);
  try {
    return await req;
  } finally {
    if (embedInFlight.get(cacheKey) === req) {
      embedInFlight.delete(cacheKey);
    }
  }
}

export function getCachedAnimeSynopsis(url: string): { hit: boolean; value: AnimeSynopsisResult | null } {
  const key = normalizeMediaCacheKey(url);
  if (!animeSynopsisCache.has(key)) return { hit: false, value: null };
  return { hit: true, value: animeSynopsisCache.get(key) ?? null };
}

export function setCachedAnimeSynopsis(url: string, value: AnimeSynopsisResult | null): void {
  const key = normalizeMediaCacheKey(url);
  if (key) animeSynopsisCache.set(key, value);
}

export function getCachedEpisodeSynopsis(url: string): { hit: boolean; value: EpisodeSynopsisResult | null } {
  const key = normalizeMediaCacheKey(url);
  if (!episodeSynopsisCache.has(key)) return { hit: false, value: null };
  return { hit: true, value: episodeSynopsisCache.get(key) ?? null };
}

export function setCachedEpisodeSynopsis(url: string, value: EpisodeSynopsisResult | null): void {
  const key = normalizeMediaCacheKey(url);
  if (key) episodeSynopsisCache.set(key, value);
}

export function readCachedEpisodeTitles(ids: readonly number[]): {
  byId: Record<number, string>;
  settledIds: number[];
  missingIds: number[];
} {
  const now = Date.now();
  const byId: Record<number, string> = {};
  const settledIds: number[] = [];
  const missingIds: number[] = [];

  for (const id of ids) {
    const entry = episodeTitlesCache.get(id);
    if (entry && entry.expiresAt > now) {
      settledIds.push(id);
      if (entry.title) {
        byId[id] = entry.title;
      }
    } else {
      if (entry) episodeTitlesCache.delete(id);
      missingIds.push(id);
    }
  }

  return { byId, settledIds, missingIds };
}

export function writeCachedEpisodeTitles(
  byId: Record<number, string>,
  settledIds: readonly number[]
): void {
  const expiresAt = Date.now() + EPISODE_TITLE_TTL_MS;
  for (const id of settledIds) {
    if (!Number.isFinite(id) || id <= 0) continue;
    if (!episodeTitlesCache.has(id) && episodeTitlesCache.size >= MAX_EPISODE_TITLE_CACHE) {
      const oldest = episodeTitlesCache.keys().next().value;
      if (oldest !== undefined) episodeTitlesCache.delete(oldest);
    }
    const title = byId[id]?.trim() || null;
    episodeTitlesCache.set(id, { title, expiresAt });
  }
}

export async function fetchCalendarCached(
  mode: LiveChartScheduleMode,
  tzOffsetMinutes: number,
  options: { refresh?: boolean } = {}
): Promise<WeeklyCalendarResponse> {
  const key = `${mode}:${tzOffsetMinutes}`;
  return calendarCache.getOrLoad(
    key,
    async () => {
      const params = new URLSearchParams({
        mode,
        tz: String(tzOffsetMinutes),
      });
      if (options.refresh) params.set('refresh', '1');
      const res = await apiFetch(`/api/calendar?${params.toString()}`);
      const data = (await res.json()) as WeeklyCalendarResponse & { error?: string };
      if (!res.ok) throw new Error(data.error || 'Erro ao carregar calendário no LiveChart.me.');
      if (Array.isArray(data.days) && data.days.length > 0) {
        persistSwrCalendar(mode, data.days);
      }
      return data;
    },
    { forceRefresh: options.refresh }
  );
}

export async function fetchArchivePageCached(
  category: CatalogArchiveCategory,
  page: number,
  options: { forceRefresh?: boolean } = {}
): Promise<PaginatedCatalogResponse> {
  const key = `${category}:p${page}`;
  return archivePageCache.getOrLoad(
    key,
    async () => {
      const params = new URLSearchParams({
        category,
        page: String(page),
      });
      const res = await apiFetch(`/api/catalog?${params.toString()}`);
      const data = (await res.json()) as PaginatedCatalogResponse & { error?: string };
      if (!res.ok) throw new Error(data.error || 'Erro ao carregar categoria');
      if (page === 1) {
        persistSwrArchive(category, data);
      }
      return data;
    },
    { forceRefresh: options.forceRefresh, shouldCache: (val) => val.items.length > 0 }
  );
}

export async function fetchFilteredCatalogCached(params: {
  category: CatalogArchiveCategory;
  genre?: string;
  year?: string;
  page: number;
}): Promise<PaginatedCatalogResponse> {
  const key = `${params.category}|g:${(params.genre || '').toLowerCase()}|y:${params.year || ''}|p:${params.page}`;
  return filteredCatalogCache.getOrLoad(
    key,
    async () => {
      const qs = new URLSearchParams({
        category: params.category,
        page: String(params.page),
      });
      if (params.genre) qs.set('genre', params.genre);
      else if (params.year) qs.set('year', params.year);
      const res = await apiFetch(`/api/catalog?${qs.toString()}`);
      const data = (await res.json()) as PaginatedCatalogResponse & { error?: string };
      if (!res.ok) throw new Error(data.error || 'Erro ao aplicar filtro');
      return data;
    },
    { shouldCache: (val) => val.items.length > 0 }
  );
}

export async function fetchDiscoverCatalogCached(
  filters: AniListDiscoverFilters,
  options: { forceRefresh?: boolean } = {}
): Promise<DiscoverCatalogResponse> {
  const qs = new URLSearchParams();
  if (filters.sort) qs.set('sort', filters.sort);
  const genres = Array.from(
    new Set([
      ...(filters.genres || []),
      ...(filters.genre ? [filters.genre] : []),
    ].filter(Boolean))
  );
  if (genres.length > 0) qs.set('genres', genres.join(','));
  const excludeGenres = Array.from(
    new Set((filters.excludeGenres || []).filter((g) => Boolean(g) && !genres.includes(g)))
  );
  if (excludeGenres.length > 0) qs.set('excludeGenres', excludeGenres.join(','));
  const tags = Array.from(
    new Set([
      ...(filters.tags || []),
      ...(filters.tag ? [filters.tag] : []),
    ].filter(Boolean))
  );
  if (tags.length > 0) qs.set('tags', tags.join(','));
  const includedTagLower = new Set(tags.map((t) => t.toLowerCase()));
  const excludeTags = Array.from(
    new Set(
      (filters.excludeTags || []).filter(
        (t) => Boolean(t) && !includedTagLower.has(t.toLowerCase())
      )
    )
  );
  if (excludeTags.length > 0) qs.set('excludeTags', excludeTags.join(','));
  if (
    typeof filters.minimumTagRank === 'number' &&
    Number.isFinite(filters.minimumTagRank)
  ) {
    qs.set('minTagRank', String(Math.min(100, Math.max(0, Math.round(filters.minimumTagRank)))));
  }
  if (filters.season) qs.set('season', filters.season);
  if (filters.year) qs.set('year', filters.year);
  if (filters.format) qs.set('format', filters.format);
  if (filters.status) qs.set('status', filters.status);
  if (filters.country) qs.set('country', filters.country);
  if (filters.audio && filters.audio !== 'ALL') qs.set('audio', filters.audio);
  qs.set('onlyAvailable', filters.onlyAvailable === false ? '0' : '1');
  if (filters.search?.trim()) qs.set('search', filters.search.trim());
  qs.set('page', String(Math.max(1, filters.page || 1)));
  if (options.forceRefresh) qs.set('refresh', '1');

  const key = qs.toString();
  return discoverCatalogCache.getOrLoad(
    key,
    async () => {
      const res = await apiFetch(`/api/discover?${qs.toString()}`);
      const data = (await res.json()) as DiscoverCatalogResponse & { error?: string };
      if (!res.ok) throw new Error(data.error || 'Erro ao carregar descoberta no AniList');
      return data;
    },
    {
      forceRefresh: options.forceRefresh,
      shouldCache: (val) => val.items.length > 0 || val.indexedTitlesCount > 0,
    }
  );
}

export async function fetchDiscoverTaxonomyCached(): Promise<DiscoverTaxonomyResponse> {
  return discoverTaxonomyCache.getOrLoad(
    'meta',
    async () => {
      const res = await apiFetch('/api/discover/meta');
      const data = (await res.json()) as DiscoverTaxonomyResponse & { error?: string };
      if (!res.ok) throw new Error(data.error || 'Erro ao carregar gêneros e tags do AniList');
      return data;
    },
    {
      shouldCache: (val) => val.sourceMode === 'live' && val.tags.length > 0,
    }
  );
}

export async function fetchGlossaryCached(
  term: string,
  type: 'movies' | 'tvshows' | 'all'
): Promise<GlossaryResponse> {
  const key = `${term.toUpperCase()}|${type}`;
  return glossaryCache.getOrLoad(
    key,
    async () => {
      const res = await apiFetch(
        `/api/glossary?term=${encodeURIComponent(term)}&type=${encodeURIComponent(type)}`
      );
      const data = (await res.json()) as GlossaryResponse & { error?: string };
      if (!res.ok) throw new Error(data.error || 'Erro ao consultar índice alfabético');
      return data;
    },
    { shouldCache: (val) => val.sourceMode === 'live' && val.items.length > 0 }
  );
}

export async function fetchReleasesPageCached(
  page: number,
  options: { forceRefresh?: boolean } = {}
): Promise<PaginatedCatalogResponse> {
  const key = `p${page}`;
  return releasesPageCache.getOrLoad(
    key,
    async () => {
      const res = await apiFetch(`/api/episodes?page=${page}`);
      const data = (await res.json()) as PaginatedCatalogResponse & { error?: string };
      if (!res.ok) throw new Error(data.error || 'Erro ao carregar mais episódios');
      if (page === 1 && data.items.length > 0) {
        persistSwrReleases(data.items, data.currentPage || 1, data.totalPages || 1);
      }
      return data;
    },
    { forceRefresh: options.forceRefresh, shouldCache: (val) => val.items.length > 0 }
  );
}

export async function fetchSearchSuggestCached(query: string): Promise<SearchSuggestResponse> {
  const trimmed = query.trim();
  const key = trimmed.toLowerCase();
  return searchSuggestCache.getOrLoad(
    key,
    async () => {
      const res = await apiFetch(`/api/search-suggest?q=${encodeURIComponent(trimmed)}`);
      const data = (await res.json()) as SearchSuggestResponse;
      if (!res.ok) return { query: trimmed, results: [], sourceMode: 'fallback' };
      return data;
    },
    { shouldCache: (val) => val.sourceMode === 'live' }
  );
}

export async function fetchSearchPageCached(
  query: string,
  page: number
): Promise<PaginatedSearchResponse> {
  const trimmed = query.trim();
  const key = `${trimmed.toLowerCase()}|p:${page}`;
  return searchPageCache.getOrLoad(
    key,
    async () => {
      const res = await apiFetch(
        `/api/search?q=${encodeURIComponent(trimmed)}&page=${page}`
      );
      const data = (await res.json()) as PaginatedSearchResponse & { error?: string };
      if (!res.ok) throw new Error(data.error || 'Erro na busca');
      return data;
    },
    { shouldCache: (val) => val.sourceMode === 'live' }
  );
}

export function clearPrefetchCaches(scope: 'all' | 'episodes' | 'catalog' = 'all'): void {
  if (scope === 'episodes' || scope === 'all') {
    episodeDetailsCache.clear();
    embedCache.clear();
    embedInFlight.clear();
  }
  if (scope === 'catalog' || scope === 'all') {
    animeDetailsFullCache.clear();
    animeDetailsQuickCache.clear();
    animeDetailsMetadataCache.clear();
    archivePageCache.clear();
    filteredCatalogCache.clear();
    discoverCatalogCache.clear();
    glossaryCache.clear();
    releasesPageCache.clear();
    searchPageCache.clear();
    searchSuggestCache.clear();
    clearPersistedSwrSnapshot();
  }
  if (scope === 'all') {
    calendarCache.clear();
    animeSynopsisCache.clear();
    episodeSynopsisCache.clear();
    episodeTitlesCache.clear();
    clearNativeApiCaches();
  }
}

// --- Optimistic Shell Builders (Zero Blank Loading Screens!) ---

export function buildOptimisticAnimeDetails(
  url: string,
  seed?: MediaNavigationSeed | null
): AnimeDetails | null {
  if (!seed?.title) return null;
  const kind = seed.kind || inferMediaKindFromTarget(url);
  const poster = seed.poster || '';
  const backdrop = seed.backdrop || poster;
  return {
    title: seed.title,
    url,
    kind: kind === 'episode' ? 'anime' : kind,
    catalogSource: seed.catalogSource,
    sourceServerName: seed.sourceServerName,
    externalIds: seed.externalIds,
    poster,
    backdrop,
    synopsis: seed.synopsis || '',
    year: seed.year,
    rating: seed.rating,
    genres: seed.genres || [],
    audioType: seed.audioType ?? null,
    episodes: [],
  };
}

export function buildOptimisticEpisodeDetails(
  url: string,
  seed?: MediaNavigationSeed | null,
  parentAnime?: AnimeDetails | null
): EpisodeDetails | null {
  const title = seed?.title?.trim();
  const seriesTitle = seed?.seriesTitle?.trim() || parentAnime?.title || title || '';
  if (!title && !seriesTitle) return null;

  const isMovie = Boolean(
    seed?.isMovie ?? (seed?.kind === 'movie' || parentAnime?.kind === 'movie' || /\/filmes?\//i.test(url))
  );
  const poster = seed?.poster || parentAnime?.poster || '';
  const backdrop = seed?.backdrop || seed?.poster || parentAnime?.backdrop || parentAnime?.poster || '';

  return {
    title: title || seriesTitle,
    seriesTitle: seriesTitle || title || 'Episódio',
    seriesUrl: seed?.seriesUrl || parentAnime?.url || '',
    url,
    episodeLabel: seed?.episodeLabel || (isMovie ? 'Filme' : undefined),
    mediaType:
      parentAnime?.kind === 'series'
        ? 'series'
        : isMovie
          ? 'movie'
          : 'anime',
    seasonNumber: seed?.seasonNumber,
    episodeNumber: seed?.episodeNumber,
    originalTitle: parentAnime?.originalTitle,
    alternativeTitles: parentAnime?.alternativeTitles,
    year: seed?.year || parentAnime?.year,
    catalogSource: seed?.catalogSource || parentAnime?.catalogSource,
    externalIds: seed?.externalIds || parentAnime?.externalIds,
    poster,
    backdrop,
    synopsis: seed?.synopsis || '',
    genres: seed?.genres || parentAnime?.genres || [],
    prevUrl: seed?.prevUrl,
    nextUrl: seed?.nextUrl,
    options: [],
    isMovie,
    sourceMode: 'live',
  };
}

export function pickPrimaryEmbedOption(options: readonly PlayerOption[]): PlayerOption | null {
  const playable = options;
  return (
    playable.find((o) => Boolean(o.directStreamUrl)) ||
    playable.find((o) =>
      ['hinatasoul', 'kojima', 'zuplay', 'abyss', 'vidstreaming', 'playerjs', 'direct'].includes(
        o.providerKind
      )
    ) ||
    playable[0] ||
    null
  );
}

// --- High-Level Intent & Background Prefetch Orchestrators ---

export function prefetchAnimeTarget(
  url: string,
  seed?: MediaNavigationSeed | null,
  options: { intentTriggered?: boolean } = {}
): void {
  if (!url) return;
  preloadRouteChunk('anime');
  // Only preload seed artwork when it already comes from TheTVDB; avoid preloading
  // provider covers that will never be rendered on the TVDB-authored profile.
  if (seed?.catalogSource === 'thetvdb') {
    if (seed.poster) preloadImage(seed.poster);
    if (seed.backdrop) preloadImage(seed.backdrop);
  }

  const key = normalizeMediaCacheKey(url);
  if (animeDetailsFullCache.has(key)) return;

  const hints: AnimeDetailsLookupHints | undefined = seed
    ? {
        title: seed.title,
        tvdbId: seed.externalIds?.tvdbId,
        tvdbSlug: seed.externalIds?.tvdbSlug,
        kind: seed.kind === 'episode' ? 'anime' : seed.kind,
        year: seed.year,
      }
    : undefined;

  scheduleBackgroundPrefetch(
    `anime:${key}`,
    async () => {
      const details = await fetchAnimeDetailsFull(url, { hints });
      if (details.poster) preloadImage(details.poster);
      if (details.backdrop) preloadImage(details.backdrop);
    },
    options
  );
}

export function prefetchEpisodeTarget(
  url: string,
  options: {
    seed?: MediaNavigationSeed | null;
    sources?: EpisodeSourceConfig[];
    audioPreference?: 'ALL' | 'DUB' | 'LEG';
    preResolvePrimaryEmbed?: boolean;
    intentTriggered?: boolean;
  } = {}
): void {
  if (!url) return;
  preloadRouteChunk('episode');
  if (options.seed?.backdrop) preloadImage(options.seed.backdrop);
  else if (options.seed?.poster) preloadImage(options.seed.poster);

  const key = normalizeMediaCacheKey(url);
  const cachedEp = episodeDetailsCache.get(key);
  if (cachedEp) {
    if (options.preResolvePrimaryEmbed) {
      const primaryOpt = pickPrimaryEmbedOption(cachedEp.options);
      if (primaryOpt && !primaryOpt.directStreamUrl && !getCachedEmbed(primaryOpt.embedUrl)) {
        scheduleBackgroundPrefetch(
          `embed:${primaryOpt.embedUrl}`,
          () => resolveEmbedCachedGlobal(primaryOpt),
          { intentTriggered: options.intentTriggered }
        );
      }
    }
    return;
  }

  scheduleBackgroundPrefetch(
    `episode:${key}`,
    async () => {
      const ep = await fetchEpisodeDetailsFast(url, {
        sources: options.sources,
        audioPreference: options.audioPreference,
        deferCrossSources: true,
      });
      if (ep.backdrop) preloadImage(ep.backdrop);
      else if (ep.poster) preloadImage(ep.poster);

      if (options.preResolvePrimaryEmbed) {
        const primaryOpt = pickPrimaryEmbedOption(ep.options);
        if (primaryOpt && !primaryOpt.directStreamUrl && !getCachedEmbed(primaryOpt.embedUrl)) {
          await resolveEmbedCachedGlobal(primaryOpt);
        }
      }
    },
    { intentTriggered: options.intentTriggered }
  );
}

export function prefetchCalendarTarget(
  mode: LiveChartScheduleMode,
  options: { intentTriggered?: boolean } = {}
): void {
  const tzOffsetMinutes = -new Date().getTimezoneOffset();
  const key = `${mode}:${tzOffsetMinutes}`;
  if (calendarCache.has(key)) return;
  scheduleBackgroundPrefetch(
    `calendar:${key}`,
    () => fetchCalendarCached(mode, tzOffsetMinutes),
    options
  );
}

export function prefetchArchiveCategoryTarget(
  category: CatalogArchiveCategory,
  page = 1,
  options: { intentTriggered?: boolean } = {}
): void {
  const key = `${category}:p${page}`;
  if (archivePageCache.has(key)) return;
  scheduleBackgroundPrefetch(
    `archive:${key}`,
    () => fetchArchivePageCached(category, page),
    options
  );
}

export function prefetchReleasesPageTarget(
  page: number,
  options: { intentTriggered?: boolean } = {}
): void {
  const key = `p${page}`;
  if (releasesPageCache.has(key)) return;
  scheduleBackgroundPrefetch(
    `releases:${key}`,
    () => fetchReleasesPageCached(page),
    options
  );
}

export function buildSeedFromAnimeEpisode(
  anime: AnimeDetails,
  ep: AnimeEpisodeLink,
  episodesList?: readonly AnimeEpisodeLink[]
): MediaNavigationSeed {
  let prevUrl: string | undefined;
  let nextUrl: string | undefined;
  if (episodesList && episodesList.length > 1) {
    const idx = episodesList.findIndex((item) => item.url === ep.url);
    if (idx > 0 && episodesList[idx - 1].availableOnServer !== false) {
      prevUrl = episodesList[idx - 1].url;
    }
    if (idx >= 0 && idx < episodesList.length - 1 && episodesList[idx + 1].availableOnServer !== false) {
      nextUrl = episodesList[idx + 1].url;
    }
  }
  return {
    title: ep.title || `${anime.title} — ${ep.numberLabel || 'Episódio'}`,
    seriesTitle: anime.title,
    seriesUrl: anime.url,
    poster: anime.poster,
    backdrop: ep.thumb || anime.backdrop || anime.poster,
    episodeLabel: ep.numberLabel || undefined,
    seasonNumber: ep.seasonNumber,
    episodeNumber: ep.episodeNumber ?? undefined,
    isMovie: anime.kind === 'movie',
    kind: anime.kind === 'movie' ? 'movie' : 'episode',
    year: anime.year,
    genres: anime.genres,
    externalIds: anime.externalIds,
    catalogSource: anime.catalogSource,
    tvdbEpisodeId: ep.tvdbEpisodeId,
    prevUrl,
    nextUrl,
  };
}
