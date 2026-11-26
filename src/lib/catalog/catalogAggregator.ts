import type { HttpFetcher } from '../httpTypes.ts';
import type {
  AnimeDetails,
  CatalogArchiveCategory,
  CatalogPreferences,
  GlossaryResponse,
  HomeCatalog,
  LiveChartScheduleMode,
  MediaKind,
  PaginatedCatalogResponse,
  PaginatedSearchResponse,
  SearchSuggestResponse,
  WeeklyCalendarResponse,
} from '../types.ts';
import { mergeServerAndCatalogEpisodes } from '../episodeAvailability.ts';
import {
  buildExternalDatabaseLinks,
  isAnisyncUri,
  parseAnisyncUri,
  parseDirectTvdbIdQuery,
  parseLiveChartExternalId,
  type CanonicalMediaType,
} from './idCodec.ts';
import {
  fetchLiveChartWeeklySchedule,
  findLiveChartScheduleHint,
} from './providers/livechartProvider.ts';
import {
  buildAnimeDetailsFromTvdbRichMatch,
  enrichServerDetailsWithTheTvdb,
  fetchTheTvdbDetails,
  findBestTheTvdbMatch,
  searchTheTvdb,
} from './providers/thetvdbProvider.ts';
import {
  findServerAnimePageForTitles,
  getServerCatalogPage,
  getServerGlossary,
  getServerHomeCatalog,
  getServerRandomMedia,
  getServerRecentEpisodes,
  getServerSearch,
  getServerSearchSuggest,
  type SnapshotAssetReader,
} from './serverCatalog.ts';

/**
 * Home Catalog: strictly reflects what is available on the integrated streaming server
 * (matching the main branch).
 */
export async function getAggregatedHomeCatalog(
  fetchHttp: HttpFetcher,
  options: {
    snapshotReader?: SnapshotAssetReader;
  } = {}
): Promise<HomeCatalog> {
  return getServerHomeCatalog(fetchHttp, options.snapshotReader);
}

/**
 * Paginated recent episodes directly from the integrated server.
 */
export async function getAggregatedRecentEpisodes(
  fetchHttp: HttpFetcher,
  page = 1,
  options: {
    snapshotReader?: SnapshotAssetReader;
  } = {}
): Promise<PaginatedCatalogResponse> {
  return getServerRecentEpisodes(fetchHttp, page, options.snapshotReader);
}

/**
 * Weekly Anime Schedule powered exclusively by LiveChart.me (with exact times, Dub/Sub, and streaming services).
 */
export async function getAggregatedWeeklyCalendar(
  fetchHttp: HttpFetcher,
  options: {
    mode?: LiveChartScheduleMode;
    tzOffsetMinutes?: number;
  } = {}
): Promise<WeeklyCalendarResponse> {
  return fetchLiveChartWeeklySchedule(fetchHttp, {
    mode: options.mode || 'streams',
    tzOffsetMinutes: options.tzOffsetMinutes,
  });
}

/**
 * Paginated Catalog Archive strictly from the integrated server (Animes, Filmes, Dublados, Legendados, etc.).
 */
export async function getAggregatedCatalogPage(
  fetchHttp: HttpFetcher,
  params: {
    category: CatalogArchiveCategory;
    genre?: string;
    year?: string;
    page?: number;
  },
  options: {
    snapshotReader?: SnapshotAssetReader;
  } = {}
): Promise<PaginatedCatalogResponse> {
  return getServerCatalogPage(fetchHttp, params, options.snapshotReader);
}

/**
 * Alphabetical A-Z Glossary strictly from the integrated server.
 */
export async function getAggregatedGlossary(
  fetchHttp: HttpFetcher,
  term: string,
  type = 'all',
  options: {
    snapshotReader?: SnapshotAssetReader;
  } = {}
): Promise<GlossaryResponse> {
  return getServerGlossary(fetchHttp, term, type, options.snapshotReader);
}

/**
 * Autocomplete Search Suggestions strictly from the integrated server
 * (with direct `tvdb:<id>` lookup shortcut).
 */
export async function getAggregatedSearchSuggest(
  fetchHttp: HttpFetcher,
  query: string
): Promise<SearchSuggestResponse> {
  if (parseDirectTvdbIdQuery(query)) {
    const results = await searchTheTvdb(fetchHttp, query).catch(() => []);
    return {
      query,
      results,
      sourceMode: 'live',
    };
  }
  return getServerSearchSuggest(fetchHttp, query);
}

/**
 * Full Paginated Search strictly from the integrated server
 * (with direct `tvdb:<id>` lookup shortcut).
 */
export async function getAggregatedSearch(
  fetchHttp: HttpFetcher,
  query: string,
  options: {
    page?: number;
  } = {}
): Promise<PaginatedSearchResponse> {
  if (parseDirectTvdbIdQuery(query)) {
    const results = await searchTheTvdb(fetchHttp, query).catch(() => []);
    return {
      query,
      results,
      currentPage: 1,
      totalPages: 1,
      sourceMode: 'live',
    };
  }
  return getServerSearch(fetchHttp, query, options.page || 1);
}

/**
 * Random Media picker strictly from the integrated server.
 */
export async function getAggregatedRandomMedia(
  fetchHttp: HttpFetcher,
  options: {
    snapshotReader?: SnapshotAssetReader;
  } = {}
): Promise<{ url: string; kind: MediaKind } | null> {
  return getServerRandomMedia(fetchHttp, options.snapshotReader);
}

export interface MediaDetailsResolveOptions {
  skipEpisodePageHydration?: boolean;
  hintTitle?: string;
  hintTvdbId?: number;
  hintTvdbSlug?: string;
  hintYear?: string;
  hintMediaType?: CanonicalMediaType;
}

function dedupeTitleCandidates(rawList: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of rawList) {
    const clean = (item || '').trim();
    if (!clean || clean.length < 2) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

function extractFallbackInfoFromAnisyncUri(rawUri: string): {
  mediaType?: CanonicalMediaType;
  titleCandidates: string[];
} {
  if (!isAnisyncUri(rawUri)) return { titleCandidates: [] };
  const withoutScheme = rawUri.trim().slice('anisync://'.length).replace(/\/+$/, '');
  const parts = withoutScheme.split('/').filter(Boolean);
  const typeOffset = parts[0] === 'episode' ? 1 : 0;
  const rawType = parts[typeOffset];
  const mediaType: CanonicalMediaType | undefined =
    rawType === 'anime' || rawType === 'series' || rawType === 'movie' ? rawType : undefined;
  const rawExternal = parts[typeOffset + 2];
  if (!rawExternal) return { mediaType, titleCandidates: [] };

  let decoded = rawExternal;
  try {
    decoded = decodeURIComponent(rawExternal);
  } catch {
    // keep rawExternal
  }

  const titleCandidates: string[] = [];
  if (decoded.includes('~')) {
    const tildeParts = decoded.split('~').slice(1);
    for (const tp of tildeParts) {
      const clean = tp.trim();
      if (clean && !/^\d+$/.test(clean)) titleCandidates.push(clean);
    }
  } else if (!/^\d+$/.test(decoded)) {
    const slugTitle = decoded.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (slugTitle.length >= 2) titleCandidates.push(slugTitle);
  }

  return { mediaType, titleCandidates };
}

/**
 * Resolves full media metadata (anime, movie, or series) from TheTVDB first,
 * with resilient recovery for legacy anisync:// URIs and streaming-provider fallback.
 */
export async function getAggregatedMediaDetails(
  fetchHttp: HttpFetcher,
  targetUri: string,
  prefs?: CatalogPreferences,
  options?: MediaDetailsResolveOptions
): Promise<AnimeDetails | null> {
  const parsed = parseAnisyncUri(targetUri);

  // Normalize known media or episode URIs
  const knownTarget =
    parsed.kind === 'media' || parsed.kind === 'episode'
      ? {
          mediaType: parsed.mediaType,
          source: parsed.source,
          externalId: parsed.externalId,
        }
      : null;

  // 1. Direct TheTVDB URI
  if (knownTarget?.source === 'thetvdb') {
    const { mediaType, externalId } = knownTarget;
    const tvdbId = /^\d+$/.test(externalId.trim()) ? Number.parseInt(externalId.trim(), 10) : NaN;
    if (Number.isFinite(tvdbId) && tvdbId > 0) {
      const directDetails = await fetchTheTvdbDetails(fetchHttp, tvdbId, {
        mediaType,
        credentials: prefs?.credentials,
        slugHint: options?.hintTvdbSlug,
        titleHint: options?.hintTitle,
        includeEpisodes: true,
        skipEpisodePageHydration: options?.skipEpisodePageHydration,
      }).catch(() => null);
      if (directDetails) return directDetails;
    }

    // Recovery if direct TVDB ID lookup failed or externalId was a slug:
    // search TheTVDB by title/slug, then fall back to streaming providers if needed.
    const fallbackTerms = dedupeTitleCandidates([
      options?.hintTitle,
      !Number.isFinite(tvdbId) ? externalId.replace(/[-_]+/g, ' ') : undefined,
    ]);
    if (fallbackTerms.length > 0) {
      const tvdbMatch = await findBestTheTvdbMatch(fetchHttp, fallbackTerms, {
        mediaType,
        year: options?.hintYear,
      }).catch(() => null);
      if (tvdbMatch) {
        const recovered = await fetchTheTvdbDetails(fetchHttp, tvdbMatch.tvdbId, {
          mediaType: tvdbMatch.mediaType,
          credentials: prefs?.credentials,
          slugHint: tvdbMatch.slug,
          titleHint: fallbackTerms[0],
          includeEpisodes: true,
          skipEpisodePageHydration: options?.skipEpisodePageHydration,
        }).catch(() => null);
        return recovered || buildAnimeDetailsFromTvdbRichMatch(tvdbMatch);
      }

      const serverFallback = await findServerAnimePageForTitles(fetchHttp, fallbackTerms).catch(
        () => null
      );
      if (serverFallback) return serverFallback.details;
    }

    return null;
  }

  // 2. LiveChart.me calendar anime clicked -> enrich via TheTVDB + check server for episodes!
  if (knownTarget?.source === 'livechart') {
    const lc = parseLiveChartExternalId(knownTarget.externalId);
    const searchTerms = dedupeTitleCandidates([lc.title, lc.englishTitle, options?.hintTitle]);

    if (!searchTerms.length && options?.hintTvdbId && options.hintTvdbId > 0) {
      const directByHint = await fetchTheTvdbDetails(fetchHttp, options.hintTvdbId, {
        mediaType: options.hintMediaType || 'anime',
        credentials: prefs?.credentials,
        slugHint: options.hintTvdbSlug,
        includeEpisodes: true,
        skipEpisodePageHydration: options.skipEpisodePageHydration,
      }).catch(() => null);
      if (directByHint) return directByHint;
    }
    if (!searchTerms.length) return null;

    const [serverMatch, tvdbMatch, liveChartHint] = await Promise.all([
      findServerAnimePageForTitles(fetchHttp, searchTerms).catch(() => null),
      findBestTheTvdbMatch(fetchHttp, searchTerms, {
        mediaType: 'anime',
        year: options?.hintYear,
      }).catch(() => null),
      findLiveChartScheduleHint(fetchHttp, {
        livechartId: lc.livechartId || undefined,
        titles: searchTerms,
      }).catch(() => null),
    ]);

    let resolvedServerMatch = serverMatch;
    if (!resolvedServerMatch && tvdbMatch) {
      const extraTitles = [
        tvdbMatch.title,
        tvdbMatch.originalTitle,
        tvdbMatch.englishTitle,
        ...tvdbMatch.alternativeTitles,
      ]
        .filter((t): t is string => Boolean(t && t.trim()))
        .filter((t) => !searchTerms.some((existing) => existing.toLowerCase() === t.toLowerCase()));
      if (extraTitles.length > 0) {
        resolvedServerMatch = await findServerAnimePageForTitles(
          fetchHttp,
          extraTitles.slice(0, 3)
        ).catch(() => null);
      }
    }

    if (resolvedServerMatch) {
      const enriched = await enrichServerDetailsWithTheTvdb(
        fetchHttp,
        resolvedServerMatch.details,
        prefs?.credentials,
        {
          livechartId: lc.livechartId || undefined,
          skipEpisodePageHydration: options?.skipEpisodePageHydration,
        }
      ).catch(() => resolvedServerMatch.details);

      const mergedIds = {
        ...enriched.externalIds,
        livechartId: lc.livechartId || undefined,
      };
      return {
        ...enriched,
        externalIds: mergedIds,
        externalLinks: buildExternalDatabaseLinks(mergedIds, {
          mediaType: (enriched.kind as CanonicalMediaType) || 'anime',
        }),
      };
    }

    if (tvdbMatch) {
      const fullTvdb = await fetchTheTvdbDetails(fetchHttp, tvdbMatch.tvdbId, {
        mediaType: tvdbMatch.mediaType,
        credentials: prefs?.credentials,
        slugHint: tvdbMatch.slug,
        titleHint: searchTerms[0],
        includeEpisodes: true,
        skipEpisodePageHydration: options?.skipEpisodePageHydration,
      }).catch(() => null);

      const base = fullTvdb || buildAnimeDetailsFromTvdbRichMatch(tvdbMatch, targetUri);

      const scheduledEpisodes =
        base.kind === 'movie'
          ? base.episodes
          : mergeServerAndCatalogEpisodes({
              serverTitle: lc.title || base.title,
              serverUrl: targetUri,
              serverEpisodes: [],
              catalogEpisodes: base.episodes,
              liveChartHint,
              serverMatched: false,
              tvdbId: tvdbMatch.tvdbId,
              mediaType: (base.kind as CanonicalMediaType) || 'anime',
              unifyAllSeasons: true,
            });

      const mergedIds = {
        ...base.externalIds,
        livechartId: lc.livechartId || undefined,
      };
      return {
        ...base,
        poster: base.poster || liveChartHint?.poster || '',
        episodes: scheduledEpisodes,
        externalIds: mergedIds,
        externalLinks: buildExternalDatabaseLinks(mergedIds, {
          mediaType: (base.kind as CanonicalMediaType) || 'anime',
        }),
      };
    }

    // Minimal graceful fallback if neither server nor TheTVDB matched
    const fallbackIds = lc.livechartId ? { livechartId: lc.livechartId } : undefined;
    const fallbackEpisodes = liveChartHint
      ? mergeServerAndCatalogEpisodes({
          serverTitle: lc.title || lc.englishTitle || options?.hintTitle || 'Anime',
          serverUrl: targetUri,
          serverEpisodes: [],
          catalogEpisodes: [],
          liveChartHint,
          serverMatched: false,
          mediaType: 'anime',
        })
      : [];
    return {
      title: lc.title || lc.englishTitle || options?.hintTitle || 'Anime',
      alternativeTitle: lc.englishTitle && lc.englishTitle !== lc.title ? lc.englishTitle : undefined,
      url: targetUri,
      kind: 'anime',
      catalogSource: 'livechart',
      externalIds: fallbackIds,
      externalLinks: buildExternalDatabaseLinks(fallbackIds, { mediaType: 'anime' }),
      poster: liveChartHint?.poster || '',
      backdrop: '',
      synopsis:
        'Ainda não encontramos episódios disponíveis no servidor ativo para este título do calendário.',
      genres: [],
      audioType: null,
      episodes: fallbackEpisodes,
    };
  }

  // 3. Legacy or unknown anisync:// URIs (e.g. saved favorites from anilist/jikan/mal/tmdb/kitsu/server)
  if (isAnisyncUri(targetUri)) {
    const uriFallback = extractFallbackInfoFromAnisyncUri(targetUri);
    const resolvedMediaType: CanonicalMediaType =
      options?.hintMediaType || knownTarget?.mediaType || uriFallback.mediaType || 'anime';
    const searchTerms = dedupeTitleCandidates([
      options?.hintTitle,
      ...uriFallback.titleCandidates,
    ]);

    const tvdbFromIdPromise =
      options?.hintTvdbId && options.hintTvdbId > 0
        ? fetchTheTvdbDetails(fetchHttp, options.hintTvdbId, {
            mediaType: resolvedMediaType,
            credentials: prefs?.credentials,
            slugHint: options.hintTvdbSlug,
            titleHint: searchTerms[0],
            includeEpisodes: true,
            skipEpisodePageHydration: options.skipEpisodePageHydration,
          }).catch(() => null)
        : Promise.resolve(null);

    const tvdbFromTitlePromise =
      searchTerms.length > 0 && !(options?.hintTvdbId && options.hintTvdbId > 0)
        ? findBestTheTvdbMatch(fetchHttp, searchTerms, {
            mediaType: resolvedMediaType,
            year: options?.hintYear,
          }).catch(() => null)
        : Promise.resolve(null);

    const serverMatchPromise =
      searchTerms.length > 0
        ? findServerAnimePageForTitles(fetchHttp, searchTerms).catch(() => null)
        : Promise.resolve(null);

    const [tvdbById, tvdbMatch, serverMatch] = await Promise.all([
      tvdbFromIdPromise,
      tvdbFromTitlePromise,
      serverMatchPromise,
    ]);

    if (serverMatch) {
      return enrichServerDetailsWithTheTvdb(fetchHttp, serverMatch.details, prefs?.credentials, {
        skipEpisodePageHydration: options?.skipEpisodePageHydration,
      }).catch(() => serverMatch.details);
    }

    if (tvdbById) return tvdbById;

    if (tvdbMatch) {
      const fullTvdb = await fetchTheTvdbDetails(fetchHttp, tvdbMatch.tvdbId, {
        mediaType: tvdbMatch.mediaType,
        credentials: prefs?.credentials,
        slugHint: tvdbMatch.slug,
        titleHint: searchTerms[0],
        includeEpisodes: true,
        skipEpisodePageHydration: options?.skipEpisodePageHydration,
      }).catch(() => null);
      return fullTvdb || buildAnimeDetailsFromTvdbRichMatch(tvdbMatch);
    }
  }

  return null;
}

/**
 * Re-export TheTVDB server enrichment helper so the API router can enrich any TopAnimes
 * anime or movie page with authoritative TheTVDB metadata.
 */
export { enrichServerDetailsWithTheTvdb };
