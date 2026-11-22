import {
  GITHUB_RELEASES_API_URL,
  GITHUB_RELEASES_LIST_API_URL,
  parseGitHubReleasePayload,
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
} from './catalog/catalogAggregator.ts';
import {
  buildEpisodeUri,
  buildMediaUri,
  isAnisyncUri,
  parseAnisyncUri,
} from './catalog/idCodec.ts';
import type { SnapshotAssetReader } from './catalog/serverCatalog.ts';
import {
  extractEpisodeNumber,
  normalizeTopAnimesUrl,
  pickLatestAnimeEpisode,
} from './favoriteAlerts.ts';
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
import type {
  AnimeDetails,
  CatalogArchiveCategory,
  CatalogPreferences,
  EpisodeDetails,
  EpisodeSourceReportSummary,
  FavoriteLatestInfo,
  HomeCatalog,
  LiveChartScheduleMode,
  PlayerOption,
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

const homeCache = new Map<string, CacheEntry<HomeCatalog>>();
const calendarCache = new Map<string, CacheEntry<WeeklyCalendarResponse>>();
const mediaDetailsCache = new Map<string, CacheEntry<AnimeDetails>>();

const HOME_TTL_MS = 3 * 60 * 1000;
const CALENDAR_TTL_MS = 5 * 60 * 1000;
const DETAILS_TTL_MS = 10 * 60 * 1000;

export function clearAnisyncRouterCaches(): void {
  homeCache.clear();
  calendarCache.clear();
  mediaDetailsCache.clear();
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
  useCache: boolean
): Promise<AnimeDetails | null> {
  if (useCache) {
    const cached = mediaDetailsCache.get(uri);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
  }
  const details = await getAggregatedMediaDetails(fetchHttp, uri, prefs);
  if (details && useCache) {
    mediaDetailsCache.set(uri, { value: details, expiresAt: Date.now() + DETAILS_TTL_MS });
  }
  return details;
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
  const details = await getCachedMediaDetails(fetchHttp, seriesUri, prefs, useCache);
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
      prevEp?.url ||
      (!isMovie && parsed.episodeNumber > 1
        ? buildEpisodeUri(
            parsed.mediaType,
            parsed.source,
            parsed.externalId,
            parsed.seasonNumber,
            parsed.episodeNumber - 1
          )
        : undefined),
    nextUrl: nextEp?.url,
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
    try {
      let response = await fetchHttp(GITHUB_RELEASES_API_URL, {
        accept: 'application/vnd.github+json',
        timeoutMs: 10000,
      });

      let payload: unknown = null;
      if (response.ok) {
        payload = JSON.parse(response.body);
      } else if (response.status === 404) {
        response = await fetchHttp(GITHUB_RELEASES_LIST_API_URL, {
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
      const ck = DEFAULT_EPISODE_SOURCES.map((s) => s.id).join('+');
      if (useCache) {
        const cached = homeCache.get(ck);
        if (cached && cached.expiresAt > Date.now()) {
          return { status: 200, body: cached.value };
        }
      }
      const catalog = await getAggregatedHomeCatalog(fetchHttp, {
        snapshotReader,
      });
      if (useCache) {
        homeCache.set(ck, { value: catalog, expiresAt: Date.now() + HOME_TTL_MS });
      }
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
      if (useCache && !forceRefresh) {
        const cached = calendarCache.get(ck);
        if (cached && cached.expiresAt > Date.now()) {
          return { status: 200, body: cached.value };
        }
      }
      const calendar = await getAggregatedWeeklyCalendar(fetchHttp, {
        mode,
        tzOffsetMinutes,
      });
      if (useCache) {
        calendarCache.set(ck, { value: calendar, expiresAt: Date.now() + CALENDAR_TTL_MS });
      }
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
    try {
      const result = await getAggregatedRecentEpisodes(fetchHttp, page, {
        snapshotReader,
      });
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

    try {
      const result = await getAggregatedCatalogPage(
        fetchHttp,
        { category, genre, year, page },
        { snapshotReader }
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
      const glossary = await getAggregatedGlossary(fetchHttp, validLetter, rawType, {
        snapshotReader,
      });
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
      const res = await getAggregatedSearchSuggest(fetchHttp, query);
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
      const res = await getAggregatedSearch(fetchHttp, query, { page });
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
    const allowedSite = isAllowedServerSiteUrl(target);
    if (!target || (!isAnisyncUri(target) && !allowedSite)) {
      return {
        status: 400,
        body: { error: 'Informe um identificador anisync:// válido ou URL de servidor suportada.' },
      };
    }

    if (isAnisyncUri(target)) {
      try {
        const details = await getCachedMediaDetails(
          fetchHttp,
          target,
          catalogPrefs,
          useCache
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
    if (useCache) {
      const cached = mediaDetailsCache.get(normKey);
      if (cached && cached.expiresAt > Date.now()) {
        return { status: 200, body: cached.value };
      }
    }

    try {
      let baseDetails: AnimeDetails | null = null;

      if (isHinataSoul) {
        const fetched = await fetchHinataSoulAnimeWithEpisodes(fetchHttp, target, {
          maxPages: 8,
          timeoutMs: 10000,
        });
        if (!fetched) {
          return {
            status: 502,
            body: { error: 'Não foi possível carregar os detalhes deste título no Hinata Soul.' },
          };
        }
        baseDetails = {
          ...fetched,
          sourceServerName: HINATASOUL_BUILTIN_SOURCE.name,
        };
      } else {
        const origin = new URL(target).origin;
        const response = await fetchHttp(target, {
          referer: `${origin}/`,
          timeoutMs: 10000,
        });
        if (!response.ok) {
          return {
            status: response.status,
            body: { error: `Servidor retornou HTTP ${response.status}.` },
          };
        }

        const rawDetails = parseAnimePageHtml(response.body, target);
        baseDetails = {
          ...rawDetails,
          kind: inferMediaKindFromUrl(target),
          sourceServerName: TOPANIMES_BUILTIN_SOURCE.name,
        };
      }

      const enriched = await enrichServerDetailsWithTheTvdb(
        fetchHttp,
        baseDetails,
        catalogPrefs?.credentials
      ).catch(() => baseDetails);

      if (useCache) {
        mediaDetailsCache.set(normKey, {
          value: enriched,
          expiresAt: Date.now() + DETAILS_TTL_MS,
        });
      }
      return { status: 200, body: enriched };
    } catch (err) {
      return {
        status: 502,
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
      .slice(0, 10);

    const latestByUrl: Record<string, FavoriteLatestInfo> = {};
    for (let i = 0; i < safeUrls.length; i += 3) {
      const chunk = safeUrls.slice(i, i + 3);
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
              const latest = pickLatestAnimeEpisode(details.episodes, details.title, details.poster);
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
                hsDetails.poster
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
            const latest = pickLatestAnimeEpisode(anime.episodes, anime.title, anime.poster);
            if (latest) latestByUrl[mediaUri] = latest;
          } catch {
            // Skip unreachable titles silently
          }
        })
      );
    }

    return { status: 200, body: { latestByUrl } };
  }

  if (pathname === '/api/episode') {
    const bodyObj = (options.jsonBody || {}) as {
      url?: string;
      audioPreference?: 'ALL' | 'DUB' | 'LEG';
      deferCrossSources?: boolean;
    };
    const target = (url.searchParams.get('url') || bodyObj.url || '').trim();
    const audioPref =
      (url.searchParams.get('audio') as 'ALL' | 'DUB' | 'LEG' | null) ||
      bodyObj.audioPreference ||
      undefined;
    const deferCrossSources =
      Boolean(bodyObj.deferCrossSources) || url.searchParams.get('fast') === '1';

    const allowedSite = isAllowedServerSiteUrl(target);
    if (!target || (!isAnisyncUri(target) && !allowedSite)) {
      return {
        status: 400,
        body: { error: 'Informe um identificador anisync:// válido ou URL de episódio suportada.' },
      };
    }

    if (isAnisyncUri(target)) {
      try {
        const ep = await resolveCanonicalEpisodeDetails(
          fetchHttp,
          target,
          audioPref,
          catalogPrefs,
          useCache
        );
        if (!ep) {
          return { status: 404, body: { error: 'Episódio ou título não encontrado.' } };
        }
        return { status: 200, body: ep };
      } catch (err) {
        return {
          status: 502,
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
      const startedAt = Date.now();
      try {
        const origin = new URL(target).origin;
        const response = await fetchHttp(target, {
          referer: `${origin}/`,
          timeoutMs: 10000,
        });
        if (response.ok) {
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
            return {
              status: 200,
              body: {
                ...parsed,
                options: primaryOptions,
                sourceReports: [primaryReport],
                sourceMode: 'live',
              },
            };
          }

          const extra = parsed.seriesTitle
            ? await aggregateEpisodeServers(
                fetchHttp,
                {
                  title: parsed.seriesTitle,
                  mediaType: parsed.mediaType || 'anime',
                  seasonNumber: parsed.seasonNumber || 1,
                  episodeNumber: parsed.episodeNumber || 1,
                  audioPreference: audioPref,
                },
                { excludeSourceIds: [HINATASOUL_BUILTIN_SOURCE.id] }
              ).catch(() => ({ options: [], reports: [] }))
            : { options: [], reports: [] };

          return {
            status: 200,
            body: {
              ...parsed,
              options: [...primaryOptions, ...extra.options],
              sourceReports: [primaryReport, ...extra.reports],
              sourceMode: 'live',
            },
          };
        }
      } catch {
        // fall through
      }
      return {
        status: 502,
        body: { error: 'Não foi possível extrair os servidores deste episódio no Hinata Soul.' },
      };
    }

    // Direct TopAnimes episode / movie page (+ optional/deferred cross-server augmentation from Hinata Soul)
    const startedAt = Date.now();
    try {
      const origin = new URL(target).origin;
      const response = await fetchHttp(target, {
        referer: `${origin}/`,
        timeoutMs: 10000,
      });
      if (response.ok) {
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
            return {
              status: 200,
              body: {
                ...parsed,
                episodeNumber: inferredEpNum,
                seasonNumber: inferredSeason,
                options: primaryOptions,
                sourceReports: [primaryReport],
                sourceMode: 'live',
              },
            };
          }

          const extra = parsed.seriesTitle
            ? await aggregateEpisodeServers(
                fetchHttp,
                {
                  title: parsed.seriesTitle,
                  mediaType: parsed.isMovie ? 'movie' : 'anime',
                  seasonNumber: inferredSeason,
                  episodeNumber: inferredEpNum,
                  audioPreference: audioPref,
                },
                { excludeSourceIds: [TOPANIMES_BUILTIN_SOURCE.id] }
              ).catch(() => ({ options: [], reports: [] }))
            : { options: [], reports: [] };

          return {
            status: 200,
            body: {
              ...parsed,
              episodeNumber: inferredEpNum,
              seasonNumber: inferredSeason,
              options: [...primaryOptions, ...extra.options],
              sourceReports: [primaryReport, ...extra.reports],
              sourceMode: 'live',
            },
          };
        }

        const [hydrated, extra] = await Promise.all([
          hydrateDooPlayEpisodeOptions(fetchHttp, response.body, target, parsed.options),
          parsed.seriesTitle
            ? aggregateEpisodeServers(
                fetchHttp,
                {
                  title: parsed.seriesTitle,
                  mediaType: parsed.isMovie ? 'movie' : 'anime',
                  seasonNumber: inferredSeason,
                  episodeNumber: inferredEpNum,
                  audioPreference: audioPref,
                },
                { excludeSourceIds: [TOPANIMES_BUILTIN_SOURCE.id] }
              ).catch(() => ({ options: [], reports: [] }))
            : Promise.resolve({ options: [], reports: [] }),
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
          status: 200,
          body: {
            ...parsed,
            episodeNumber: inferredEpNum,
            seasonNumber: inferredSeason,
            options: [...primaryOptions, ...extra.options],
            sourceReports: [primaryReport, ...extra.reports],
            sourceMode: 'live',
          },
        };
      }
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
    const result = await aggregateEpisodeServers(fetchHttp, bodyObj.query, {
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
      const resolved = await resolveServerOptionToStreams(fetchHttp, opt);
      return { status: 200, body: resolved };
    }

    const target = (url.searchParams.get('url') || '').trim();
    if (!target) {
      return { status: 400, body: { error: 'Parâmetro url obrigatório.' } };
    }
    const resolved = await resolveEmbedByUrl(fetchHttp, target);
    return { status: 200, body: resolved };
  }

  return { status: 404, body: { error: `Rota desconhecida: ${pathname}` } };
}
