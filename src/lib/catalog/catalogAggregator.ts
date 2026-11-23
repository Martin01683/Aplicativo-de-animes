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
  parseAnisyncUri,
  parseLiveChartExternalId,
  type CanonicalMediaType,
} from './idCodec.ts';
import {
  fetchLiveChartWeeklySchedule,
  findLiveChartScheduleHint,
} from './providers/livechartProvider.ts';
import {
  enrichServerDetailsWithTheTvdb,
  fetchTheTvdbDetails,
  findBestTheTvdbMatch,
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
 * Autocomplete Search Suggestions strictly from the integrated server.
 */
export async function getAggregatedSearchSuggest(
  fetchHttp: HttpFetcher,
  query: string
): Promise<SearchSuggestResponse> {
  return getServerSearchSuggest(fetchHttp, query);
}

/**
 * Full Paginated Search strictly from the integrated server.
 */
export async function getAggregatedSearch(
  fetchHttp: HttpFetcher,
  query: string,
  options: {
    page?: number;
  } = {}
): Promise<PaginatedSearchResponse> {
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

/**
 * Resolves full media metadata (anime, movie, or series) from TheTVDB.
 * - For `anisync://<type>/thetvdb/<id>`: fetches full details & episodes from TheTVDB.
 * - For `anisync://anime/livechart/<id>~<title>`: resolves rich metadata via TheTVDB and checks
 *   the integrated streaming server for immediately playable episodes!
 */
export async function getAggregatedMediaDetails(
  fetchHttp: HttpFetcher,
  targetUri: string,
  prefs?: CatalogPreferences
): Promise<AnimeDetails | null> {
  const parsed = parseAnisyncUri(targetUri);
  if (parsed.kind !== 'media') return null;

  const { mediaType, source, externalId } = parsed;

  // 1. Direct TheTVDB URI
  if (source === 'thetvdb') {
    const tvdbId = Number.parseInt(externalId, 10);
    if (!Number.isFinite(tvdbId) || tvdbId <= 0) return null;
    return fetchTheTvdbDetails(fetchHttp, tvdbId, {
      mediaType,
      credentials: prefs?.credentials,
      includeEpisodes: true,
    });
  }

  // 2. LiveChart.me calendar anime clicked -> enrich via TheTVDB + check server for episodes!
  if (source === 'livechart') {
    const lc = parseLiveChartExternalId(externalId);
    const searchTerms = [lc.title, lc.englishTitle].filter((t): t is string => Boolean(t));
    if (!searchTerms.length) return null;

    const [serverMatch, tvdbMatch, liveChartHint] = await Promise.all([
      findServerAnimePageForTitles(fetchHttp, searchTerms).catch(() => null),
      findBestTheTvdbMatch(fetchHttp, searchTerms, { mediaType: 'anime' }).catch(() => null),
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
        { livechartId: lc.livechartId || undefined }
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
        includeEpisodes: true,
      }).catch(() => null);

      const base = fullTvdb || {
        title: tvdbMatch.title,
        originalTitle: tvdbMatch.originalTitle,
        alternativeTitle: tvdbMatch.englishTitle,
        alternativeTitles: tvdbMatch.alternativeTitles,
        url: targetUri,
        kind: tvdbMatch.mediaType,
        catalogSource: 'thetvdb' as const,
        externalIds: tvdbMatch.externalIds,
        enrichmentSources: ['thetvdb' as const],
        poster: tvdbMatch.poster,
        backdrop: tvdbMatch.backdrop,
        synopsis: tvdbMatch.synopsis,
        synopsisSource: tvdbMatch.synopsisSource,
        synopsisLanguage: tvdbMatch.synopsisLanguage,
        year: tvdbMatch.year,
        firstAirDate: tvdbMatch.firstAirDate,
        status: tvdbMatch.status,
        studio: tvdbMatch.studio,
        network: tvdbMatch.network,
        genres: tvdbMatch.genres,
        audioType: null,
        episodes: [],
      };

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
          serverTitle: lc.title || lc.englishTitle || 'Anime',
          serverUrl: targetUri,
          serverEpisodes: [],
          catalogEpisodes: [],
          liveChartHint,
          serverMatched: false,
          mediaType: 'anime',
        })
      : [];
    return {
      title: lc.title || lc.englishTitle || 'Anime',
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

  return null;
}

/**
 * Re-export TheTVDB server enrichment helper so the API router can enrich any TopAnimes
 * anime or movie page with authoritative TheTVDB metadata.
 */
export { enrichServerDetailsWithTheTvdb };
