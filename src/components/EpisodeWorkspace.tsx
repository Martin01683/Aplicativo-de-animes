import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Bell,
  BellOff,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  CloudOff,
  Heart,
  Keyboard,
  Layers,
  Loader2,
  RefreshCw,
  Server,
} from 'lucide-react';
import { apiFetch } from '../lib/apiClient';
import {
  applyLocalizedEpisodeTitles,
  collectUnlocalizedEpisodeIds,
  formatEpisodeCountdown,
  formatEpisodeReleaseDate,
  formatUpcomingEpisodeNotice,
  formatUpcomingEpisodeShortLabel,
  isEpisodeAvailableOnServer,
  isEpisodeUncensored,
  isUncensoredEpisodeTitle,
} from '../lib/episodeAvailability';
import { extractEpisodeNumber, normalizeTopAnimesUrl } from '../lib/favoriteAlerts';
import {
  findUpcomingNextEpisode,
  isDesktopShortcutsEnabled,
  isSameEpisodeUrl,
  resolveSeriesEpisodesForEpisode,
  resolveSeriesPrevNext,
  type NativeVlcPlayResult,
} from '../lib/nativeVlcPlayer';
import {
  isEpisodeMarkedWatched,
  type EpisodeProgressMap,
  type VideoScaleMode,
} from '../lib/playbackProgress';
import {
  clearCachedEmbeds,
  deleteCachedEmbed,
  fetchAnimeDetailsFull,
  getCachedAnimeDetailsFull,
  getCachedEmbed,
  getCachedEpisodeSynopsis,
  readCachedEpisodeTitles,
  resolveEmbedCachedGlobal,
  setCachedEpisodeSynopsis,
  writeCachedEpisodeTitles,
  type MediaNavigationSeed,
} from '../lib/prefetchCache';
import { pickBestFailoverServer } from '../lib/serverFailover';
import { formatServerLabel } from '../lib/serverLabel';
import type {
  AnimeEpisodeLink,
  AnimeSynopsisResult,
  CatalogMediaItem,
  EpisodeDetails,
  EpisodeSynopsisResult,
  ExternalMediaIds,
  FavoriteLatestInfo,
  PlayerOption,
  ResolvedEmbed,
} from '../lib/types';
import { AnimePlayer } from './AnimePlayer';

interface EpisodeWorkspaceProps {
  episode: EpisodeDetails;
  isFavorite: boolean;
  isMuted?: boolean;
  watchedUrls?: Set<string>;
  progressMap?: EpisodeProgressMap;
  initialSeriesEpisodes?: AnimeEpisodeLink[];
  initialSeriesArtwork?: { poster?: string; backdrop?: string };
  initialSeriesExternalIds?: ExternalMediaIds;
  loadingEpisode?: boolean;
  loadingExtraServers?: boolean;
  loadingExtraServerNames?: string[];
  onToggleFavorite: (item: CatalogMediaItem, knownLatest?: FavoriteLatestInfo | null) => void;
  onToggleMuteFavorite?: (animeUrl: string) => void;
  onToggleEpisodeWatched?: (episode: EpisodeDetails, watched: boolean) => void;
  onBack: () => void;
  onNavigateUrl: (
    url: string,
    kind: 'episode' | 'anime' | 'series' | 'movie',
    seed?: MediaNavigationSeed
  ) => void;
  onPrefetchEpisode?: (
    episodeUrl: string,
    seed?: MediaNavigationSeed,
    options?: { preResolvePrimaryEmbed?: boolean }
  ) => void;
  onPrefetchAnime?: (animeUrl: string, seed?: MediaNavigationSeed) => void;
  onRefreshSources?: () => void;
  onNativeSessionSync?: (result: NativeVlcPlayResult) => void;
  onPlaybackProgress?: () => void;
  onToast: (message: string) => void;
  skipIntroSeconds?: number;
  autoPlayNextEpisode?: boolean;
  videoScale?: VideoScaleMode;
  onChangeVideoScale?: (scale: VideoScaleMode) => void;
  onLoadingStateChange?: (loading: boolean) => void;
}

interface ScopedResolvedEmbed {
  episodeUrl: string;
  embedUrl: string;
  data: ResolvedEmbed;
}

function pickInitialOption(options: PlayerOption[]): PlayerOption | null {
  return (
    options.find((o) => Boolean(o.directStreamUrl)) ||
    options.find((o) =>
      ['hinatasoul', 'kojima', 'zuplay', 'vidstreaming', 'playerjs', 'direct'].includes(
        o.providerKind
      )
    ) ||
    options[0] ||
    null
  );
}

export function EpisodeWorkspace({
  episode,
  isFavorite,
  isMuted = false,
  watchedUrls,
  progressMap,
  initialSeriesEpisodes,
  initialSeriesArtwork,
  initialSeriesExternalIds,
  loadingEpisode = false,
  loadingExtraServers = false,
  loadingExtraServerNames = [],
  onToggleFavorite,
  onToggleMuteFavorite,
  onToggleEpisodeWatched,
  onBack,
  onNavigateUrl,
  onPrefetchEpisode,
  onPrefetchAnime,
  onRefreshSources,
  onNativeSessionSync,
  onPlaybackProgress,
  onToast,
  skipIntroSeconds = 85,
  autoPlayNextEpisode = false,
  videoScale,
  onChangeVideoScale,
  onLoadingStateChange,
}: EpisodeWorkspaceProps) {
  const desktopShortcutsEnabled = isDesktopShortcutsEnabled();

  const playableOptions = useMemo(() => {
    return episode.options
      .filter((o) => o.providerKind !== 'abyss' && !/aniplay/i.test(o.label))
      .map((o) => ({ ...o, label: formatServerLabel(o.label, `Servidor ${o.nume}`) }));
  }, [episode.options]);

  const [selectedOption, setSelectedOption] = useState<PlayerOption | null>(() =>
    pickInitialOption(playableOptions)
  );
  const [resolvedState, setResolvedState] = useState<ScopedResolvedEmbed | null>(() => {
    const initialOpt = pickInitialOption(playableOptions);
    if (!initialOpt || initialOpt.directStreamUrl) return null;
    const cached = getCachedEmbed(initialOpt.embedUrl);
    if (cached && cached.status === 'resolved' && cached.streams.length > 0) {
      return { episodeUrl: episode.url, embedUrl: initialOpt.embedUrl, data: cached };
    }
    return null;
  });
  const [loadingEmbed, setLoadingEmbed] = useState(false);
  const [failoverExhaustedMsg, setFailoverExhaustedMsg] = useState('');
  const [resumeAfterFailover, setResumeAfterFailover] = useState<{
    timeSec: number;
    autoStart: boolean;
    key: number;
  } | null>(null);

  const failedServersByEpisodeRef = useRef<Map<string, Set<string>>>(new Map());
  const activeEpisodeUrlRef = useRef(episode.url);
  activeEpisodeUrlRef.current = episode.url;

  const seriesExternalIdsCacheRef = useRef<Map<string, ExternalMediaIds>>(new Map());
  const seriesArtworkCacheRef = useRef<Map<string, { poster?: string; backdrop?: string }>>(
    new Map()
  );
  const [seriesEpisodes, setSeriesEpisodes] = useState<AnimeEpisodeLink[]>(
    initialSeriesEpisodes || []
  );
  const [seriesExternalIds, setSeriesExternalIds] = useState<ExternalMediaIds | undefined>(
    episode.externalIds || initialSeriesExternalIds
  );
  const [seriesArtwork, setSeriesArtwork] = useState<{ poster?: string; backdrop?: string }>(
    initialSeriesArtwork || {}
  );
  const [seriesMediaReadyForUrl, setSeriesMediaReadyForUrl] = useState<string>(
    initialSeriesEpisodes && initialSeriesEpisodes.length > 0 ? episode.seriesUrl || '' : ''
  );
  const [hydratedSeriesTitlesState, setHydratedSeriesTitlesState] = useState<{
    scopeKey: string;
    byId: Record<number, string>;
    settledIds: number[];
  }>({ scopeKey: '', byId: {}, settledIds: [] });
  const settledSeriesTitleIdsRef = useRef<{ scopeKey: string; ids: Set<number> }>({
    scopeKey: '',
    ids: new Set(),
  });

  const [localizedSynopsisState, setLocalizedSynopsisState] = useState<{
    episodeUrl: string;
    loading: boolean;
    result: EpisodeSynopsisResult | null;
  }>(() => {
    const cached = getCachedEpisodeSynopsis(episode.url);
    return {
      episodeUrl: episode.url,
      loading: false,
      result: cached.hit ? cached.value : null,
    };
  });

  const resolved =
    resolvedState &&
    isSameEpisodeUrl(resolvedState.episodeUrl, episode.url) &&
    resolvedState.embedUrl === selectedOption?.embedUrl
      ? resolvedState.data
      : null;

  const hasMountedPlayerRef = useRef(false);
  if (resolved?.status === 'resolved' && resolved.streams.length > 0) {
    hasMountedPlayerRef.current = true;
  }

  const lastResetEpisodeUrlRef = useRef(episode.url);

  // Reset selected server when switching episodes, while preserving playback when
  // background cross-server options arrive for the SAME episode.
  useEffect(() => {
    if (!isSameEpisodeUrl(lastResetEpisodeUrlRef.current, episode.url)) {
      lastResetEpisodeUrlRef.current = episode.url;
      const nextOpt = pickInitialOption(playableOptions);
      setSelectedOption(nextOpt);
      const cachedNext = nextOpt && !nextOpt.directStreamUrl ? getCachedEmbed(nextOpt.embedUrl) : undefined;
      setResolvedState(
        nextOpt && cachedNext && cachedNext.status === 'resolved' && cachedNext.streams.length > 0
          ? { episodeUrl: episode.url, embedUrl: nextOpt.embedUrl, data: cachedNext }
          : null
      );
      setFailoverExhaustedMsg('');
      setResumeAfterFailover(null);
      return;
    }

    setSelectedOption((current) => {
      if (
        current &&
        playableOptions.some(
          (o) => o.nume === current.nume && o.embedUrl === current.embedUrl
        )
      ) {
        return current;
      }
      return pickInitialOption(playableOptions);
    });

    if (failoverExhaustedMsg) {
      const epKey = normalizeTopAnimesUrl(episode.url) || episode.url;
      const failedSet = failedServersByEpisodeRef.current.get(epKey);
      const freshOption = playableOptions.find((o) => !failedSet?.has(o.nume));
      if (freshOption) {
        setFailoverExhaustedMsg('');
        setSelectedOption(freshOption);
      }
    }
  }, [episode.url, failoverExhaustedMsg, playableOptions]);

  // Fetch and cache the series episode list so in-fullscreen episode selection, TheTVDB IDs & artwork are populated
  useEffect(() => {
    if (episode.isMovie || !episode.seriesUrl) {
      setSeriesEpisodes([]);
      setSeriesExternalIds(episode.externalIds || initialSeriesExternalIds);
      setSeriesArtwork(initialSeriesArtwork || {});
      setSeriesMediaReadyForUrl(episode.seriesUrl || '__none__');
      return;
    }

    const seriesUrl = episode.seriesUrl;
    const seriesKey = normalizeTopAnimesUrl(seriesUrl) || seriesUrl;
    if (initialSeriesExternalIds) {
      seriesExternalIdsCacheRef.current.set(seriesKey, initialSeriesExternalIds);
    }
    if (initialSeriesArtwork?.poster || initialSeriesArtwork?.backdrop) {
      seriesArtworkCacheRef.current.set(seriesKey, initialSeriesArtwork);
    }
    const hasEnrichedInitialEpisodes = Boolean(
      initialSeriesEpisodes &&
        initialSeriesEpisodes.length > 0 &&
        initialSeriesEpisodes.some((ep) => Boolean(ep.tvdbEpisodeId || ep.titleLocalized))
    );
    if (hasEnrichedInitialEpisodes && initialSeriesEpisodes) {
      setSeriesEpisodes(initialSeriesEpisodes);
      const cachedIds = seriesExternalIdsCacheRef.current.get(seriesKey);
      setSeriesExternalIds(episode.externalIds || initialSeriesExternalIds || cachedIds);
      setSeriesArtwork(
        initialSeriesArtwork || seriesArtworkCacheRef.current.get(seriesKey) || {}
      );
      setSeriesMediaReadyForUrl(seriesUrl);
      return;
    }

    const cachedDetails = getCachedAnimeDetailsFull(seriesUrl);
    if (cachedDetails) {
      const resolvedTrackEps =
        resolveSeriesEpisodesForEpisode(cachedDetails, episode.url, seriesUrl) ||
        cachedDetails.episodes;
      if (resolvedTrackEps.length > 0) {
        setSeriesEpisodes(resolvedTrackEps);
        if (cachedDetails.externalIds) {
          seriesExternalIdsCacheRef.current.set(seriesKey, cachedDetails.externalIds);
        }
        if (cachedDetails.poster || cachedDetails.backdrop) {
          seriesArtworkCacheRef.current.set(seriesKey, {
            poster: cachedDetails.poster || undefined,
            backdrop: cachedDetails.backdrop || undefined,
          });
        }
        setSeriesExternalIds(
          episode.externalIds ||
            initialSeriesExternalIds ||
            cachedDetails.externalIds ||
            seriesExternalIdsCacheRef.current.get(seriesKey)
        );
        setSeriesArtwork(
          initialSeriesArtwork ||
            seriesArtworkCacheRef.current.get(seriesKey) ||
            {}
        );
        setSeriesMediaReadyForUrl(seriesUrl);
        return;
      }
    }

    let cancelled = false;
    fetchAnimeDetailsFull(seriesUrl, {
      hints: {
        title: episode.seriesTitle,
        tvdbId: episode.externalIds?.tvdbId ?? initialSeriesExternalIds?.tvdbId,
        kind: episode.mediaType,
        year: episode.year,
      },
    })
      .then((data) => {
        if (cancelled) return;
        if (data && Array.isArray(data.episodes)) {
          const resolvedTrackEps =
            resolveSeriesEpisodesForEpisode(data, episode.url, seriesUrl) || data.episodes;
          setSeriesEpisodes(resolvedTrackEps);
        }
        if (data?.externalIds) {
          seriesExternalIdsCacheRef.current.set(seriesKey, data.externalIds);
          setSeriesExternalIds((prev) => ({ ...data.externalIds, ...prev }));
        }
        if (data?.poster || data?.backdrop) {
          const art = {
            poster: data.poster || undefined,
            backdrop: data.backdrop || undefined,
          };
          seriesArtworkCacheRef.current.set(seriesKey, art);
          setSeriesArtwork(art);
        }
        setSeriesMediaReadyForUrl(seriesUrl);
      })
      .catch(() => {
        if (!cancelled) {
          if (initialSeriesEpisodes && initialSeriesEpisodes.length > 0) {
            setSeriesEpisodes(initialSeriesEpisodes);
          }
          setSeriesMediaReadyForUrl(seriesUrl);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    episode.externalIds,
    episode.isMovie,
    episode.mediaType,
    episode.seriesTitle,
    episode.seriesUrl,
    episode.url,
    episode.year,
    initialSeriesArtwork,
    initialSeriesEpisodes,
    initialSeriesExternalIds,
  ]);

  const seriesTitlesScopeKey = episode.seriesUrl || episode.url;
  const unlocalizedSeriesEpisodeIds = useMemo(
    () => collectUnlocalizedEpisodeIds(seriesEpisodes, episode.isMovie),
    [episode.isMovie, seriesEpisodes]
  );
  const unlocalizedSeriesEpisodeIdsKey = useMemo(
    () => unlocalizedSeriesEpisodeIds.join(','),
    [unlocalizedSeriesEpisodeIds]
  );

  const cachedSeriesTitlesSnapshot = useMemo(
    () => readCachedEpisodeTitles(unlocalizedSeriesEpisodeIds),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [unlocalizedSeriesEpisodeIdsKey, hydratedSeriesTitlesState.settledIds.length]
  );

  const hydratedSeriesTitlesById = useMemo(
    () => ({
      ...cachedSeriesTitlesSnapshot.byId,
      ...(hydratedSeriesTitlesState.scopeKey === seriesTitlesScopeKey
        ? hydratedSeriesTitlesState.byId
        : {}),
    }),
    [
      cachedSeriesTitlesSnapshot.byId,
      hydratedSeriesTitlesState.byId,
      hydratedSeriesTitlesState.scopeKey,
      seriesTitlesScopeKey,
    ]
  );

  useEffect(() => {
    if (episode.isMovie || !unlocalizedSeriesEpisodeIdsKey) return;
    if (settledSeriesTitleIdsRef.current.scopeKey !== seriesTitlesScopeKey) {
      settledSeriesTitleIdsRef.current = { scopeKey: seriesTitlesScopeKey, ids: new Set() };
    }
    const parsedIds = unlocalizedSeriesEpisodeIdsKey
      .split(',')
      .map((s) => Number.parseInt(s, 10))
      .filter((id) => Number.isFinite(id) && id > 0);
    const { missingIds } = readCachedEpisodeTitles(parsedIds);
    const idsToFetch = missingIds.filter(
      (id) => !settledSeriesTitleIdsRef.current.ids.has(id)
    );
    if (idsToFetch.length === 0) return;

    const batches: number[][] = [];
    for (let i = 0; i < idsToFetch.length; i += 28) {
      batches.push(idsToFetch.slice(i, i + 28));
    }

    let cancelled = false;
    const tvdbSlug = episode.externalIds?.tvdbSlug || seriesExternalIds?.tvdbSlug;
    const tvdbId = episode.externalIds?.tvdbId || seriesExternalIds?.tvdbId;

    const runBatch = async (batchIds: number[]) => {
      const params = new URLSearchParams({ ids: batchIds.join(',') });
      if (tvdbSlug) params.set('tvdbSlug', tvdbSlug);
      if (tvdbId && tvdbId > 0) params.set('tvdbId', String(tvdbId));

      const nextEntries: Record<number, string> = {};
      let okToCache = false;
      try {
        const res = await apiFetch(`/api/episode-titles?${params.toString()}`);
        const data: { titlesById?: Record<string, string> } | null = res.ok
          ? await res.json()
          : null;
        if (res.ok) {
          okToCache = true;
        }
        if (data?.titlesById) {
          for (const [k, v] of Object.entries(data.titlesById)) {
            const numId = Number.parseInt(k, 10);
            if (Number.isFinite(numId) && numId > 0 && typeof v === 'string' && v.trim()) {
              nextEntries[numId] = v.trim();
            }
          }
        }
      } catch {
        // Non-fatal: keep fallback guide titles
      }

      if (okToCache) {
        writeCachedEpisodeTitles(nextEntries, batchIds);
      }
      if (cancelled) return;
      if (settledSeriesTitleIdsRef.current.scopeKey === seriesTitlesScopeKey) {
        for (const id of batchIds) {
          settledSeriesTitleIdsRef.current.ids.add(id);
        }
      }
      setHydratedSeriesTitlesState((prev) => {
        const prevById = prev.scopeKey === seriesTitlesScopeKey ? prev.byId : {};
        const prevSettled = prev.scopeKey === seriesTitlesScopeKey ? prev.settledIds : [];
        const mergedSettled = Array.from(new Set([...prevSettled, ...batchIds]));
        return {
          scopeKey: seriesTitlesScopeKey,
          byId: { ...prevById, ...nextEntries },
          settledIds: mergedSettled,
        };
      });
    };

    const concurrency = Math.min(2, batches.length);
    let cursor = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      while (!cancelled && cursor < batches.length) {
        const batch = batches[cursor++];
        if (batch) {
          await runBatch(batch);
        }
      }
    });
    void Promise.all(workers);

    return () => {
      cancelled = true;
    };
  }, [
    episode.externalIds?.tvdbId,
    episode.externalIds?.tvdbSlug,
    episode.isMovie,
    seriesExternalIds?.tvdbId,
    seriesExternalIds?.tvdbSlug,
    seriesTitlesScopeKey,
    unlocalizedSeriesEpisodeIdsKey,
  ]);

  const localizedSeriesEpisodes = useMemo(
    () => applyLocalizedEpisodeTitles(seriesEpisodes, hydratedSeriesTitlesById),
    [hydratedSeriesTitlesById, seriesEpisodes]
  );

  const matchedSeriesEpisode = useMemo(() => {
    if (!localizedSeriesEpisodes.length) return undefined;
    const byUrl = localizedSeriesEpisodes.find((ep) => isSameEpisodeUrl(ep.url, episode.url));
    if (byUrl) return byUrl;
    const targetEpNum =
      episode.episodeNumber ??
      extractEpisodeNumber(episode.episodeLabel || '') ??
      extractEpisodeNumber(episode.title) ??
      extractEpisodeNumber(episode.url);
    if (!targetEpNum) return undefined;
    const targetSeason = episode.seasonNumber || 1;
    return (
      localizedSeriesEpisodes.find(
        (ep) => (ep.seasonNumber || 1) === targetSeason && ep.episodeNumber === targetEpNum
      ) || localizedSeriesEpisodes.find((ep) => ep.episodeNumber === targetEpNum)
    );
  }, [episode.episodeLabel, episode.episodeNumber, episode.seasonNumber, episode.title, episode.url, localizedSeriesEpisodes]);

  // Fetch TheTVDB episode/movie synopsis & artwork (PT-BR -> Google Translate -> EN fallback) asynchronously
  useEffect(() => {
    const cachedSynopsis = getCachedEpisodeSynopsis(episode.url);
    if (cachedSynopsis.hit) {
      setLocalizedSynopsisState({
        episodeUrl: episode.url,
        loading: false,
        result: cachedSynopsis.value,
      });
      return;
    }

    // If still on a bare optimistic seed without series context yet, wait for real episode metadata
    if (loadingEpisode && episode.options.length === 0 && !episode.seriesUrl) {
      return;
    }

    const tvdbId = episode.externalIds?.tvdbId || seriesExternalIds?.tvdbId;
    const tvdbSlug = episode.externalIds?.tvdbSlug || seriesExternalIds?.tvdbSlug;

    if (episode.isMovie) {
      const movieTitle = episode.seriesTitle || episode.title;
      if (!tvdbId && !tvdbSlug && !movieTitle) {
        setLocalizedSynopsisState({ episodeUrl: episode.url, loading: false, result: null });
        return;
      }
      const params = new URLSearchParams();
      params.set('mediaType', 'movie');
      if (movieTitle) params.set('title', movieTitle);
      if (episode.originalTitle) params.set('originalTitle', episode.originalTitle);
      if (episode.year) params.set('year', episode.year);
      if (tvdbId && tvdbId > 0) params.set('tvdbId', String(tvdbId));
      if (tvdbSlug) params.set('tvdbSlug', tvdbSlug);

      let cancelled = false;
      setLocalizedSynopsisState({ episodeUrl: episode.url, loading: true, result: null });

      apiFetch(`/api/anime-synopsis?${params.toString()}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((payload: { result?: AnimeSynopsisResult | null } | null) => {
          if (cancelled) return;
          const movieRes = payload?.result ?? null;
          const mapped: EpisodeSynopsisResult | null = movieRes
            ? {
                synopsis: movieRes.synopsis,
                language: movieRes.language,
                source: movieRes.source,
                episodeImage: movieRes.backdrop || movieRes.poster,
                tvdbSeriesId: movieRes.tvdbId,
              }
            : null;
          setCachedEpisodeSynopsis(episode.url, mapped);
          if (movieRes?.poster || movieRes?.backdrop) {
            setSeriesArtwork((prev) => ({
              poster: movieRes.poster || prev.poster,
              backdrop: movieRes.backdrop || prev.backdrop,
            }));
          }
          setLocalizedSynopsisState({
            episodeUrl: episode.url,
            loading: false,
            result: mapped,
          });
        })
        .catch(() => {
          if (!cancelled) {
            setLocalizedSynopsisState({
              episodeUrl: episode.url,
              loading: false,
              result: null,
            });
          }
        });

      return () => {
        cancelled = true;
      };
    }

    const tvdbEpisodeId = matchedSeriesEpisode?.tvdbEpisodeId;
    const seasonNum = matchedSeriesEpisode?.seasonNumber || episode.seasonNumber || 1;
    const epNum =
      matchedSeriesEpisode?.episodeNumber ??
      episode.episodeNumber ??
      extractEpisodeNumber(episode.episodeLabel || '') ??
      extractEpisodeNumber(episode.title) ??
      extractEpisodeNumber(episode.url) ??
      undefined;

    // Wait for /api/media if we don't yet have TheTVDB identifiers so we avoid duplicate searches
    const waitingForSeriesIds =
      Boolean(episode.seriesUrl) &&
      seriesMediaReadyForUrl !== episode.seriesUrl &&
      !tvdbEpisodeId &&
      !tvdbId &&
      !tvdbSlug;

    if (waitingForSeriesIds) {
      setLocalizedSynopsisState({ episodeUrl: episode.url, loading: true, result: null });
      return;
    }

    if (!tvdbEpisodeId && !epNum) {
      setLocalizedSynopsisState({ episodeUrl: episode.url, loading: false, result: null });
      return;
    }

    const params = new URLSearchParams();
    if (episode.seriesTitle) params.set('title', episode.seriesTitle);
    if (episode.originalTitle) params.set('originalTitle', episode.originalTitle);
    if (episode.year) params.set('year', episode.year);
    if (episode.mediaType) params.set('mediaType', episode.mediaType);
    if (seasonNum > 0) params.set('season', String(seasonNum));
    if (epNum && epNum > 0) params.set('episode', String(epNum));
    if (tvdbId && tvdbId > 0) params.set('tvdbId', String(tvdbId));
    if (tvdbSlug) params.set('tvdbSlug', tvdbSlug);
    if (tvdbEpisodeId && tvdbEpisodeId > 0) params.set('tvdbEpisodeId', String(tvdbEpisodeId));
    if (matchedSeriesEpisode?.overview) {
      params.set('englishOverview', matchedSeriesEpisode.overview.slice(0, 1800));
    }

    let cancelled = false;
    setLocalizedSynopsisState({ episodeUrl: episode.url, loading: true, result: null });

    apiFetch(`/api/episode-synopsis?${params.toString()}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((payload: { result?: EpisodeSynopsisResult | null } | null) => {
        if (cancelled) return;
        const resolvedResult = payload?.result ?? null;
        setCachedEpisodeSynopsis(episode.url, resolvedResult);
        setLocalizedSynopsisState({
          episodeUrl: episode.url,
          loading: false,
          result: resolvedResult,
        });
      })
      .catch(() => {
        if (!cancelled) {
          setLocalizedSynopsisState({
            episodeUrl: episode.url,
            loading: false,
            result: null,
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    episode.episodeLabel,
    episode.episodeNumber,
    episode.externalIds?.tvdbId,
    episode.externalIds?.tvdbSlug,
    episode.isMovie,
    episode.mediaType,
    episode.options.length,
    episode.originalTitle,
    episode.seasonNumber,
    episode.seriesTitle,
    episode.seriesUrl,
    episode.title,
    episode.url,
    episode.year,
    loadingEpisode,
    matchedSeriesEpisode?.episodeNumber,
    matchedSeriesEpisode?.overview,
    matchedSeriesEpisode?.seasonNumber,
    matchedSeriesEpisode?.tvdbEpisodeId,
    seriesExternalIds?.tvdbId,
    seriesExternalIds?.tvdbSlug,
    seriesMediaReadyForUrl,
  ]);

  const resolveEmbedCached = useCallback(async (opt: PlayerOption): Promise<ResolvedEmbed> => {
    return resolveEmbedCachedGlobal(opt);
  }, []);

  const findBestAvailableServer = useCallback(
    async (_episodeUrlKey: string, failedSet: Set<string>) => {
      const remaining = playableOptions
        .map((option, orderIndex) => ({ option, orderIndex }))
        .filter((item) => !failedSet.has(item.option.nume));

      if (!remaining.length) return null;

      const settled = await Promise.all(
        remaining.map(async ({ option, orderIndex }) => ({
          option,
          orderIndex,
          resolved: await resolveEmbedCached(option),
        }))
      );

      return pickBestFailoverServer(settled, failedSet);
    },
    [playableOptions, resolveEmbedCached]
  );

  // Resolve chosen server via backend (and auto-failover to best quality server if resolution fails)
  useEffect(() => {
    if (!selectedOption) {
      setLoadingEmbed(false);
      return;
    }
    const targetEpisodeUrl = episode.url;
    const targetOption = selectedOption;

    // Zero-latency hit when the primary stream was prefetched in the background
    if (!targetOption.directStreamUrl) {
      const preCached = getCachedEmbed(targetOption.embedUrl);
      if (preCached && preCached.status === 'resolved' && preCached.streams.length > 0) {
        setResolvedState({
          episodeUrl: targetEpisodeUrl,
          embedUrl: targetOption.embedUrl,
          data: preCached,
        });
        setLoadingEmbed(false);
        setFailoverExhaustedMsg('');
        return;
      }
    }

    let cancelled = false;
    setLoadingEmbed(true);
    setFailoverExhaustedMsg('');

    const run = async () => {
      const data = await resolveEmbedCached(targetOption);
      if (cancelled || !isSameEpisodeUrl(activeEpisodeUrlRef.current, targetEpisodeUrl)) return;

      if (data.status === 'resolved' && data.streams.length > 0) {
        setResolvedState({
          episodeUrl: targetEpisodeUrl,
          embedUrl: targetOption.embedUrl,
          data,
        });
        return;
      }

      const epKey = normalizeTopAnimesUrl(targetEpisodeUrl) || targetEpisodeUrl;
      const failedSet = failedServersByEpisodeRef.current.get(epKey) ?? new Set<string>();
      failedSet.add(targetOption.nume);
      failedServersByEpisodeRef.current.set(epKey, failedSet);

      const winner = await findBestAvailableServer(epKey, failedSet);
      if (cancelled || !isSameEpisodeUrl(activeEpisodeUrlRef.current, targetEpisodeUrl)) return;

      if (winner) {
        setSelectedOption(winner.option);
        setResolvedState({
          episodeUrl: targetEpisodeUrl,
          embedUrl: winner.option.embedUrl,
          data: winner.resolved,
        });
        onToast(
          `Servidor indisponível — trocado para ${winner.option.label}${
            winner.qualityLabel ? ` (${winner.qualityLabel})` : ''
          }`
        );
      } else {
        setResolvedState({
          episodeUrl: targetEpisodeUrl,
          embedUrl: targetOption.embedUrl,
          data,
        });
      }
    };

    void run().finally(() => {
      if (!cancelled) setLoadingEmbed(false);
    });

    return () => {
      cancelled = true;
    };
  }, [episode.url, findBestAvailableServer, onToast, resolveEmbedCached, selectedOption]);

  const handleServerPlaybackFailed = useCallback(
    async (failedNume: string, resumeTimeSec: number) => {
      const targetEpisodeUrl = episode.url;
      const epKey = normalizeTopAnimesUrl(targetEpisodeUrl) || targetEpisodeUrl;
      const failedSet = failedServersByEpisodeRef.current.get(epKey) ?? new Set<string>();
      failedSet.add(failedNume);
      failedServersByEpisodeRef.current.set(epKey, failedSet);

      const failedOpt = playableOptions.find((o) => o.nume === failedNume);
      if (failedOpt) {
        deleteCachedEmbed(failedOpt.embedUrl);
      }

      setLoadingEmbed(true);
      try {
        const winner = await findBestAvailableServer(epKey, failedSet);
        if (!isSameEpisodeUrl(activeEpisodeUrlRef.current, targetEpisodeUrl)) return;

        if (winner) {
          setFailoverExhaustedMsg('');
          setResumeAfterFailover({
            timeSec: resumeTimeSec > 2 ? resumeTimeSec : 0,
            autoStart: true,
            key: Date.now(),
          });
          setSelectedOption(winner.option);
          setResolvedState({
            episodeUrl: targetEpisodeUrl,
            embedUrl: winner.option.embedUrl,
            data: winner.resolved,
          });
          onToast(
            `Falha no servidor — trocado para ${winner.option.label}${
              winner.qualityLabel ? ` (${winner.qualityLabel})` : ''
            }`
          );
        } else {
          setFailoverExhaustedMsg(
            'Nenhum servidor conseguiu reproduzir este episódio. Tente outro servidor ou clique em Rebuscar.'
          );
        }
      } finally {
        setLoadingEmbed(false);
      }
    },
    [episode.url, findBestAvailableServer, onToast, playableOptions]
  );

  const handleManualServerSelect = useCallback(
    (opt: PlayerOption) => {
      const epKey = normalizeTopAnimesUrl(episode.url) || episode.url;
      const failedSet = failedServersByEpisodeRef.current.get(epKey);
      if (failedSet?.has(opt.nume)) {
        failedSet.delete(opt.nume);
        deleteCachedEmbed(opt.embedUrl);
      }
      setFailoverExhaustedMsg('');
      setSelectedOption({ ...opt });
    },
    [episode.url]
  );

  const handleRetryAllServers = useCallback(() => {
    const epKey = normalizeTopAnimesUrl(episode.url) || episode.url;
    failedServersByEpisodeRef.current.delete(epKey);
    clearCachedEmbeds();
    setFailoverExhaustedMsg('');
    const first = pickInitialOption(playableOptions);
    if (first) {
      setSelectedOption({ ...first });
    }
  }, [episode.url, playableOptions]);

  const adjacent = useMemo(
    () => resolveSeriesPrevNext(seriesEpisodes, episode.url),
    [seriesEpisodes, episode.url]
  );

  const upcomingNextEpisode = useMemo(
    () => findUpcomingNextEpisode(seriesEpisodes, episode.url),
    [seriesEpisodes, episode.url]
  );

  const isUrlMarkedUnavailable = useCallback(
    (targetUrl?: string) =>
      Boolean(
        targetUrl &&
          seriesEpisodes.some(
            (ep) => isSameEpisodeUrl(ep.url, targetUrl) && !isEpisodeAvailableOnServer(ep)
          )
      ),
    [seriesEpisodes]
  );

  const effectivePrevUrl =
    (episode.prevUrl && !isUrlMarkedUnavailable(episode.prevUrl) ? episode.prevUrl : undefined) ||
    adjacent.prevUrl;
  const effectiveNextUrl =
    (episode.nextUrl && !isUrlMarkedUnavailable(episode.nextUrl) ? episode.nextUrl : undefined) ||
    adjacent.nextUrl;

  const activeUpcomingNext = !effectiveNextUrl ? upcomingNextEpisode : undefined;

  const [nowMs, setNowMs] = useState(() => Date.now());
  const [upcomingBannerTrigger, setUpcomingBannerTrigger] = useState(0);
  useEffect(() => {
    if (!activeUpcomingNext) return;
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [activeUpcomingNext]);

  const isTransitioning = loadingEpisode || loadingEmbed;
  const hasResolvedStreams =
    resolved?.status === 'resolved' && resolved.streams.length > 0;
  const showPlayer = hasResolvedStreams || hasMountedPlayerRef.current;

  const epKey = normalizeTopAnimesUrl(episode.url) || episode.url;
  const currentFailedSet = failedServersByEpisodeRef.current.get(epKey);
  const hasUntriedFallbackServers = playableOptions.some(
    (opt) => opt.nume !== selectedOption?.nume && !currentFailedSet?.has(opt.nume)
  );

  const parentMediaKind: 'anime' | 'series' | 'movie' =
    episode.mediaType || (episode.isMovie ? 'movie' : 'anime');

  const scopedSynopsis =
    localizedSynopsisState.episodeUrl === episode.url
      ? localizedSynopsisState
      : (() => {
          const cached = getCachedEpisodeSynopsis(episode.url);
          return cached.hit
            ? { loading: false, result: cached.value }
            : { loading: false, result: null };
        })();

  const isSeriesMediaLoading =
    !episode.isMovie &&
    Boolean(episode.seriesUrl) &&
    seriesMediaReadyForUrl !== episode.seriesUrl;
  const isEpisodeSynopsisPending =
    scopedSynopsis.loading ||
    (!getCachedEpisodeSynopsis(episode.url).hit &&
      !loadingEpisode &&
      localizedSynopsisState.episodeUrl !== episode.url);
  const isEmbedPending =
    loadingEmbed ||
    (Boolean(selectedOption) &&
      !loadingEpisode &&
      !(
        resolvedState &&
        isSameEpisodeUrl(resolvedState.episodeUrl, episode.url) &&
        resolvedState.embedUrl === selectedOption?.embedUrl
      ));
  const isEpisodeWorkspaceLoading =
    loadingEpisode ||
    loadingExtraServers ||
    isSeriesMediaLoading ||
    isEpisodeSynopsisPending ||
    isEmbedPending;

  useLayoutEffect(() => {
    onLoadingStateChange?.(isEpisodeWorkspaceLoading);
  }, [isEpisodeWorkspaceLoading, onLoadingStateChange]);

  useLayoutEffect(() => {
    return () => {
      onLoadingStateChange?.(false);
    };
  }, [onLoadingStateChange]);
  const tvdbSynopsis = scopedSynopsis.result;
  const displaySynopsis = tvdbSynopsis?.synopsis || episode.synopsis;
  const synopsisSourceCaption =
    tvdbSynopsis?.source === 'thetvdb-pt-br'
      ? 'TheTVDB · PT-BR'
      : tvdbSynopsis?.source === 'thetvdb-google-translate'
        ? 'TheTVDB · Traduzido via Google Tradutor'
        : tvdbSynopsis?.source === 'thetvdb-en'
          ? 'TheTVDB · Original (EN)'
          : null;

  const effectiveEpisodePoster =
    tvdbSynopsis?.episodeImage ||
    matchedSeriesEpisode?.thumb ||
    episode.backdrop ||
    seriesArtwork.backdrop ||
    episode.poster ||
    seriesArtwork.poster ||
    '';
  const effectiveSeriesPoster =
    seriesArtwork.poster || episode.poster || effectiveEpisodePoster;

  const buildAdjacentEpisodeSeed = useCallback(
    (targetUrl: string): MediaNavigationSeed => {
      const matched = localizedSeriesEpisodes.find((ep) => isSameEpisodeUrl(ep.url, targetUrl));
      return {
        title:
          matched?.title ||
          (matched?.numberLabel
            ? `${episode.seriesTitle} — ${matched.numberLabel}`
            : episode.seriesTitle),
        seriesTitle: episode.seriesTitle,
        seriesUrl: episode.seriesUrl,
        poster: effectiveSeriesPoster,
        backdrop: matched?.thumb || effectiveEpisodePoster,
        episodeLabel: matched?.numberLabel || undefined,
        seasonNumber: matched?.seasonNumber,
        episodeNumber: matched?.episodeNumber ?? undefined,
        kind: episode.isMovie ? 'movie' : 'episode',
        isMovie: episode.isMovie,
        year: episode.year,
        genres: episode.genres,
        externalIds: episode.externalIds || seriesExternalIds,
        catalogSource: episode.catalogSource,
      };
    },
    [
      effectiveEpisodePoster,
      effectiveSeriesPoster,
      episode.catalogSource,
      episode.externalIds,
      episode.genres,
      episode.isMovie,
      episode.seriesTitle,
      episode.seriesUrl,
      episode.year,
      localizedSeriesEpisodes,
      seriesExternalIds,
    ]
  );

  const seriesNavSeed = useMemo<MediaNavigationSeed | undefined>(() => {
    if (!episode.seriesUrl) return undefined;
    return {
      title: episode.seriesTitle,
      poster: effectiveSeriesPoster,
      backdrop: seriesArtwork.backdrop || episode.backdrop || effectiveSeriesPoster,
      kind: parentMediaKind,
      year: episode.year,
      genres: episode.genres,
      externalIds: episode.externalIds || seriesExternalIds,
      catalogSource: episode.catalogSource,
      isMovie: episode.isMovie,
    };
  }, [
    effectiveSeriesPoster,
    episode.backdrop,
    episode.catalogSource,
    episode.externalIds,
    episode.genres,
    episode.isMovie,
    episode.seriesTitle,
    episode.seriesUrl,
    episode.year,
    parentMediaKind,
    seriesArtwork.backdrop,
    seriesExternalIds,
  ]);

  // Quietly pre-warm the next episode (and its primary video stream) shortly after current playback resolves
  useEffect(() => {
    if (!onPrefetchEpisode || !effectiveNextUrl || !hasResolvedStreams || episode.isMovie) {
      return;
    }
    const timer = window.setTimeout(() => {
      onPrefetchEpisode(effectiveNextUrl, buildAdjacentEpisodeSeed(effectiveNextUrl), {
        preResolvePrimaryEmbed: true,
      });
    }, 1800);
    return () => window.clearTimeout(timer);
  }, [
    buildAdjacentEpisodeSeed,
    effectiveNextUrl,
    episode.isMovie,
    hasResolvedStreams,
    onPrefetchEpisode,
  ]);

  return (
    <div className="mx-auto max-w-5xl anisync-view-enter px-4 py-5 sm:px-6 sm:py-8 lg:px-8">
      {/* Top Breadcrumb & Prev/Next Episode Controls */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 sm:mb-6">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-slate-400 sm:text-sm">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1.5 font-medium text-slate-300 transition-colors hover:text-white"
          >
            <ArrowLeft className="h-4 w-4" />
            <span>Voltar</span>
          </button>
          {episode.seriesUrl && (
            <>
              <span>/</span>
              <button
                type="button"
                onMouseEnter={() => onPrefetchAnime?.(episode.seriesUrl!, seriesNavSeed)}
                onFocus={() => onPrefetchAnime?.(episode.seriesUrl!, seriesNavSeed)}
                onTouchStart={() => onPrefetchAnime?.(episode.seriesUrl!, seriesNavSeed)}
                onClick={() => onNavigateUrl(episode.seriesUrl!, parentMediaKind, seriesNavSeed)}
                className="truncate font-medium text-slate-300 transition-colors hover:text-[#f97316]"
              >
                {episode.seriesTitle}
              </button>
            </>
          )}
          {episode.episodeLabel && (
            <>
              <span>/</span>
              <span className="text-slate-200">{episode.episodeLabel}</span>
            </>
          )}
        </div>

        {!episode.isMovie && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={!effectivePrevUrl || isTransitioning}
              onMouseEnter={() =>
                effectivePrevUrl &&
                onPrefetchEpisode?.(effectivePrevUrl, buildAdjacentEpisodeSeed(effectivePrevUrl), {
                  preResolvePrimaryEmbed: true,
                })
              }
              onFocus={() =>
                effectivePrevUrl &&
                onPrefetchEpisode?.(effectivePrevUrl, buildAdjacentEpisodeSeed(effectivePrevUrl), {
                  preResolvePrimaryEmbed: true,
                })
              }
              onTouchStart={() =>
                effectivePrevUrl &&
                onPrefetchEpisode?.(effectivePrevUrl, buildAdjacentEpisodeSeed(effectivePrevUrl), {
                  preResolvePrimaryEmbed: true,
                })
              }
              onClick={() =>
                effectivePrevUrl &&
                onNavigateUrl(
                  effectivePrevUrl,
                  'episode',
                  buildAdjacentEpisodeSeed(effectivePrevUrl)
                )
              }
              className="inline-flex items-center gap-1 rounded-lg border border-white/12 bg-[#151921] px-3 py-2 text-xs font-medium text-slate-200 transition-colors hover:border-white/25 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronLeft className="h-4 w-4" />
              <span>Anterior</span>
            </button>
            {activeUpcomingNext ? (() => {
              const nextDate = formatEpisodeReleaseDate(
                activeUpcomingNext.date,
                activeUpcomingNext.airingAt,
                activeUpcomingNext.hasExactAiringTime
              );
              const nextCountdown = formatEpisodeCountdown(
                activeUpcomingNext.airingAt,
                nowMs,
                activeUpcomingNext.date
              );
              const nextEpLabel = formatUpcomingEpisodeShortLabel(activeUpcomingNext);
              return (
                <button
                  type="button"
                  data-upcoming-next-pill="true"
                  onClick={() => setUpcomingBannerTrigger((prev) => prev + 1)}
                  title={`${formatUpcomingEpisodeNotice(activeUpcomingNext, nowMs)} (previsão oficial, não disponibilidade nos servidores)`}
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium tabular-nums transition-colors ${
                    nextCountdown.state === 'future'
                      ? 'border-[#f97316]/50 bg-[#1b0e05]/90 text-[#ffedd5] hover:border-[#f97316]/80'
                      : nextCountdown.state === 'now'
                        ? 'border-emerald-400/55 bg-[#052e22]/90 text-emerald-100'
                        : 'border-white/15 bg-[#151921] text-slate-300 hover:border-white/25'
                  }`}
                >
                  {nextCountdown.state === 'pending' ? (
                    <CloudOff className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                  ) : (
                    <Clock
                      className={`h-3.5 w-3.5 shrink-0 ${
                        nextCountdown.state === 'now'
                          ? 'text-emerald-300'
                          : nextCountdown.state === 'future'
                            ? 'text-[#f97316]'
                            : 'text-slate-400'
                      }`}
                    />
                  )}
                  <span className="truncate">
                    Próx. {nextEpLabel}
                    {nextDate ? ` · ${nextDate}` : ''}
                    {` · ${nextCountdown.label}`}
                  </span>
                </button>
              );
            })() : (
              <button
                type="button"
                disabled={!effectiveNextUrl || isTransitioning}
                onMouseEnter={() =>
                  effectiveNextUrl &&
                  onPrefetchEpisode?.(
                    effectiveNextUrl,
                    buildAdjacentEpisodeSeed(effectiveNextUrl),
                    { preResolvePrimaryEmbed: true }
                  )
                }
                onFocus={() =>
                  effectiveNextUrl &&
                  onPrefetchEpisode?.(
                    effectiveNextUrl,
                    buildAdjacentEpisodeSeed(effectiveNextUrl),
                    { preResolvePrimaryEmbed: true }
                  )
                }
                onTouchStart={() =>
                  effectiveNextUrl &&
                  onPrefetchEpisode?.(
                    effectiveNextUrl,
                    buildAdjacentEpisodeSeed(effectiveNextUrl),
                    { preResolvePrimaryEmbed: true }
                  )
                }
                onClick={() =>
                  effectiveNextUrl &&
                  onNavigateUrl(
                    effectiveNextUrl,
                    'episode',
                    buildAdjacentEpisodeSeed(effectiveNextUrl)
                  )
                }
                className="inline-flex items-center gap-1 rounded-lg border border-white/12 bg-[#151921] px-3 py-2 text-xs font-medium text-slate-200 transition-colors hover:border-white/25 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <span>Próximo</span>
                <ChevronRight className="h-4 w-4" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Main Cinema Player + Metadata Layout */}
      <div className="min-w-0 space-y-5">
        {showPlayer ? (
          <AnimePlayer
            title={episode.title}
            episodeUrl={episode.url}
            seriesUrl={episode.seriesUrl}
            seriesTitle={episode.seriesTitle}
            isMovie={episode.isMovie}
            seriesEpisodes={localizedSeriesEpisodes}
            watchedUrls={watchedUrls}
            playerOptions={playableOptions}
            selectedServerNume={selectedOption?.nume}
            streams={hasResolvedStreams ? resolved.streams : []}
            referer={resolved?.referer || 'https://topanimes.net/'}
            preferDirect={resolved?.preferDirect}
            poster={effectiveEpisodePoster}
            subtitles={hasResolvedStreams ? resolved.subtitles : []}
            hasPrev={Boolean(effectivePrevUrl)}
            hasNext={Boolean(effectiveNextUrl)}
            prevUrl={effectivePrevUrl}
            nextUrl={effectiveNextUrl}
            upcomingNextEpisode={activeUpcomingNext}
            upcomingBannerTrigger={upcomingBannerTrigger}
            loadingEpisode={isTransitioning}
            hasUntriedFallbackServers={hasUntriedFallbackServers}
            resumeAfterFailover={resumeAfterFailover}
            errorMessage={
              failoverExhaustedMsg ||
              (!isTransitioning && !hasResolvedStreams
                ? resolved?.errorMessage ||
                  'Selecione outro servidor abaixo ou tente novamente em instantes.'
                : '')
            }
            skipIntroSeconds={skipIntroSeconds}
            autoPlayNextEpisode={autoPlayNextEpisode}
            videoScale={videoScale}
            onPrevEpisode={() =>
              effectivePrevUrl &&
              onNavigateUrl(
                effectivePrevUrl,
                'episode',
                buildAdjacentEpisodeSeed(effectivePrevUrl)
              )
            }
            onNextEpisode={() =>
              effectiveNextUrl &&
              onNavigateUrl(
                effectiveNextUrl,
                'episode',
                buildAdjacentEpisodeSeed(effectiveNextUrl)
              )
            }
            onSelectEpisode={(epUrl) => {
              if (!isSameEpisodeUrl(epUrl, episode.url)) {
                onNavigateUrl(epUrl, 'episode', buildAdjacentEpisodeSeed(epUrl));
              }
            }}
            onSelectServer={(nume) => {
              const match = playableOptions.find((o) => o.nume === nume);
              if (match) handleManualServerSelect(match);
            }}
            onChangeVideoScale={onChangeVideoScale}
            onPlaybackProgress={onPlaybackProgress}
            onServerPlaybackFailed={handleServerPlaybackFailed}
            onRetryEpisodePlayback={handleRetryAllServers}
            onNativeSessionSync={onNativeSessionSync}
            onToast={onToast}
          />
        ) : isTransitioning ? (
          <div className="relative flex aspect-video w-full flex-col items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-[#0b0e14] p-6 text-center">
            {effectiveEpisodePoster && (
              <>
                <img
                  src={effectiveEpisodePoster}
                  alt=""
                  aria-hidden="true"
                  decoding="async"
                  referrerPolicy="no-referrer"
                  className="pointer-events-none absolute inset-0 h-full w-full scale-105 object-cover opacity-35 blur-md"
                />
                <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-[#0b0e14]/90 via-[#0b0e14]/55 to-[#0b0e14]/75" />
              </>
            )}
            <div className="relative z-10 inline-flex items-center gap-2.5 rounded-full border border-white/15 bg-[#0d0f12]/80 px-4 py-2 text-xs font-medium text-slate-200 shadow-lg backdrop-blur-md sm:text-sm">
              <Loader2 className="h-4 w-4 animate-spin text-[#f97316]" />
              <span>Preparando vídeo...</span>
            </div>
          </div>
        ) : (
          <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 rounded-xl border border-white/10 bg-[#151921] p-6 text-center">
            <Server className="h-9 w-9 text-[#f97316]/80" />
            <p className="max-w-md text-sm leading-relaxed text-slate-300">
              {failoverExhaustedMsg ||
                resolved?.errorMessage ||
                'Nenhum servidor encontrado automaticamente para este título.'}
            </p>
          </div>
        )}

        {/* Title, Episode Synopsis, All Episodes Button, Favorite & Aggregated Server Switcher Card */}
        <section className="rounded-xl border border-white/10 bg-[#151921] p-4 sm:p-5">
          <div className="space-y-3.5 border-b border-white/8 pb-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-lg font-bold text-white sm:text-2xl">
                  {episode.title}
                </h1>
                {(isEpisodeUncensored(matchedSeriesEpisode) ||
                  isUncensoredEpisodeTitle(episode.title) ||
                  isUncensoredEpisodeTitle(episode.episodeLabel)) && (
                  <span
                    data-episode-uncensored="true"
                    className="inline-flex shrink-0 items-center rounded border border-rose-500/40 bg-rose-500/15 px-2 py-0.5 text-[11px] font-semibold leading-tight text-rose-300"
                  >
                    Sem censura
                  </span>
                )}
              </div>
              {episode.genres.length > 0 && (
                <p className="mt-1 text-xs text-slate-400">
                  {episode.genres.join(' · ')}
                </p>
              )}
            </div>

            {/* Episode Synopsis (TheTVDB PT-BR -> Google Translate -> EN fallback) */}
            {scopedSynopsis.loading && !tvdbSynopsis ? (
              <div
                data-episode-synopsis-loading="true"
                className="space-y-2"
                aria-label="Carregando sinopse do episódio"
              >
                <div className="anisync-shimmer h-3 w-2/3 rounded" />
                <div className="anisync-shimmer h-3 w-full rounded" />
                <div className="anisync-shimmer h-3 w-5/6 rounded" />
              </div>
            ) : displaySynopsis ? (
              <div
                data-episode-synopsis="true"
                data-synopsis-source={tvdbSynopsis?.source || 'fallback'}
                className="space-y-1.5"
              >
                {tvdbSynopsis?.episodeTitle && (
                  <p className="text-xs font-semibold text-slate-200 sm:text-sm">
                    {tvdbSynopsis.episodeTitle}
                  </p>
                )}
                <p className="whitespace-pre-line text-xs leading-relaxed text-slate-300 sm:text-sm">
                  {displaySynopsis}
                </p>
                {synopsisSourceCaption && (
                  <p className="text-[11px] font-medium text-slate-500">
                    {synopsisSourceCaption}
                  </p>
                )}
              </div>
            ) : null}

            {/* Ver todos os episódios button — positioned directly above Marcar como visto & Favoritar */}
            {episode.seriesUrl && (
              <div>
                <button
                  type="button"
                  onMouseEnter={() => onPrefetchAnime?.(episode.seriesUrl!, seriesNavSeed)}
                  onFocus={() => onPrefetchAnime?.(episode.seriesUrl!, seriesNavSeed)}
                  onTouchStart={() => onPrefetchAnime?.(episode.seriesUrl!, seriesNavSeed)}
                  onClick={() => onNavigateUrl(episode.seriesUrl!, parentMediaKind, seriesNavSeed)}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-white/12 bg-[#0d0f12] px-3.5 py-2.5 text-xs font-medium text-slate-200 transition-colors hover:border-[#f97316]/60 hover:text-white sm:w-auto"
                >
                  <Layers className="h-3.5 w-3.5 text-[#f97316]" />
                  <span>{episode.isMovie ? 'Ver detalhes do filme' : 'Ver todos os episódios'}</span>
                </button>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 sm:gap-2.5">
              {onToggleEpisodeWatched && (() => {
                const watched = isEpisodeMarkedWatched(episode.url, progressMap, watchedUrls);
                return (
                  <button
                    type="button"
                    onClick={() => onToggleEpisodeWatched(episode, !watched)}
                    aria-pressed={watched}
                    aria-label={watched ? 'Visto' : 'Marcar como visto'}
                    title={watched ? 'Visto' : 'Marcar como visto'}
                    className={`inline-flex h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-xl border px-4 text-xs font-semibold transition-colors sm:flex-none sm:text-sm ${
                      watched
                        ? 'border-emerald-500/45 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/20'
                        : 'border-white/15 bg-[#0d0f12] text-slate-200 hover:border-emerald-400/50 hover:text-white'
                    }`}
                  >
                    <Check
                      className={`h-4 w-4 shrink-0 ${
                        watched ? 'text-emerald-300' : 'text-emerald-400'
                      }`}
                    />
                    <span className="truncate">{watched ? 'Visto' : 'Marcar como visto'}</span>
                  </button>
                );
              })()}

              <button
                type="button"
                onClick={() => {
                  const epNum =
                    episode.episodeNumber ??
                    extractEpisodeNumber(episode.episodeLabel || '') ??
                    extractEpisodeNumber(episode.title) ??
                    extractEpisodeNumber(episode.url);
                  onToggleFavorite(
                    {
                      id: episode.seriesUrl || episode.url,
                      title: episode.seriesTitle,
                      url: episode.seriesUrl || episode.url,
                      kind: parentMediaKind,
                      poster: effectiveSeriesPoster,
                      audioType: null,
                      catalogSource: episode.catalogSource,
                      externalIds: episode.externalIds,
                    },
                    episode.isMovie
                      ? null
                      : {
                          episodeUrl: normalizeTopAnimesUrl(episode.url),
                          episodeTitle: episode.title,
                          episodeLabel:
                            episode.episodeLabel ||
                            (epNum !== null ? `EP ${epNum}` : 'Episódio atual'),
                          episodeNumber: epNum,
                          poster: effectiveEpisodePoster,
                        }
                  );
                }}
                aria-pressed={isFavorite}
                aria-label={isFavorite ? 'Nos Favoritos' : 'Favoritar'}
                title={isFavorite ? 'Nos Favoritos' : 'Favoritar'}
                className={`inline-flex h-11 w-11 shrink-0 items-center justify-center gap-2 rounded-xl border text-xs font-semibold transition-colors sm:w-auto sm:px-4 sm:text-sm ${
                  isFavorite
                    ? 'border-rose-500/45 bg-rose-500/15 text-rose-200 hover:bg-rose-500/20'
                    : 'border-white/15 bg-[#0d0f12] text-slate-200 hover:border-rose-400/50 hover:text-white'
                }`}
              >
                <Heart
                  className={`h-[18px] w-[18px] shrink-0 sm:h-4 sm:w-4 ${
                    isFavorite ? 'fill-rose-400 text-rose-400' : 'text-rose-400'
                  }`}
                />
                <span className="hidden sm:inline">
                  {isFavorite ? 'Nos Favoritos' : 'Favoritar'}
                </span>
              </button>

              {isFavorite && onToggleMuteFavorite && (
                <button
                  type="button"
                  onClick={() => onToggleMuteFavorite(episode.seriesUrl || episode.url)}
                  aria-pressed={isMuted}
                  aria-label={
                    isMuted
                      ? `Ativar avisos de novos episódios de ${episode.seriesTitle}`
                      : `Silenciar avisos de novos episódios de ${episode.seriesTitle}`
                  }
                  title={isMuted ? 'Avisos silenciados' : 'Avisos ativos'}
                  className={`inline-flex h-11 w-11 shrink-0 items-center justify-center gap-2 rounded-xl border text-xs font-semibold transition-colors sm:w-auto sm:px-3.5 ${
                    isMuted
                      ? 'border-white/15 bg-[#0d0f12] text-slate-400 hover:border-white/25 hover:text-white'
                      : 'border-[#f97316]/40 bg-[#f97316]/12 text-[#fb923c] hover:bg-[#f97316]/20'
                  }`}
                >
                  {isMuted ? (
                    <BellOff className="h-[18px] w-[18px] shrink-0 sm:h-4 sm:w-4" />
                  ) : (
                    <Bell className="h-[18px] w-[18px] shrink-0 sm:h-4 sm:w-4" />
                  )}
                  <span className="hidden sm:inline">
                    {isMuted ? 'Avisos silenciados' : 'Avisos ativos'}
                  </span>
                </button>
              )}
            </div>
          </div>

          {/* Aggregated Sources & Server Selector */}
          <div className="pt-4">
            <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2 text-xs font-medium text-slate-400">
              <span className="inline-flex items-center gap-2">
                <Server className="h-3.5 w-3.5 text-[#f97316]" />
                <span>Servidores dos Provedores ({playableOptions.length})</span>
              </span>
              {onRefreshSources && (
                <button
                  type="button"
                  disabled={loadingEpisode}
                  onClick={onRefreshSources}
                  className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-[#0d0f12] px-2.5 py-1 text-[11px] font-medium text-slate-300 hover:border-[#f97316]/50 hover:text-white disabled:opacity-50"
                >
                  <RefreshCw className={`h-3 w-3 text-[#f97316] ${loadingEpisode ? 'animate-spin' : ''}`} />
                  <span>Rebuscar</span>
                </button>
              )}
            </div>

            {/* Per-Source Resolution Reports */}
            {((episode.sourceReports && episode.sourceReports.length > 0) ||
              loadingExtraServers) && (
              <div className="mb-3 flex flex-wrap gap-1.5">
                {(episode.sourceReports || [])
                  .filter((r) => r.status !== 'skipped')
                  .map((rep) => (
                    <span
                      key={rep.sourceId}
                      title={rep.errorMessage || rep.matchedTitle || rep.sourceName}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${
                        rep.status === 'found'
                          ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-300'
                          : rep.status === 'error'
                            ? 'border-red-500/35 bg-red-500/10 text-red-300'
                            : 'border-white/10 bg-[#0d0f12] text-slate-400'
                      }`}
                    >
                      <span>{rep.sourceName}</span>
                      <span className="font-mono text-[10px] opacity-80">
                        {rep.status === 'found'
                          ? `${rep.optionsCount} srv`
                          : rep.status === 'error'
                            ? 'erro'
                            : '0'}
                      </span>
                    </span>
                  ))}
                {loadingExtraServers && (
                  <span
                    role="status"
                    aria-live="polite"
                    className="inline-flex items-center gap-1.5 rounded-full border border-[#f97316]/35 bg-[#f97316]/10 px-2.5 py-0.5 text-[11px] font-medium text-[#fb923c]"
                  >
                    <Loader2 className="h-3 w-3 animate-spin" />
                    <span>
                      {loadingExtraServerNames.length > 0
                        ? `${loadingExtraServerNames.join(', ')} carregando...`
                        : 'Carregando mais servidores...'}
                    </span>
                  </span>
                )}
              </div>
            )}

            {playableOptions.length === 0 && !loadingExtraServers ? (
              <p className="text-sm text-amber-300/90">
                Nenhum servidor de vídeo encontrado nos provedores integrados para este título. Toque em Rebuscar para tentar novamente.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {playableOptions.map((opt) => {
                  const active = selectedOption?.nume === opt.nume;
                  return (
                    <button
                      key={opt.nume}
                      type="button"
                      onClick={() => handleManualServerSelect(opt)}
                      className={`min-h-[40px] rounded-lg border px-3.5 py-2 text-xs font-medium transition-colors sm:text-sm ${
                        active
                          ? 'border-[#f97316] bg-[#f97316]/15 text-white'
                          : 'border-white/10 bg-[#0d0f12] text-slate-300 hover:border-white/25 hover:text-white'
                      }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
                {loadingExtraServers && (
                  <span
                    aria-hidden="true"
                    className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-dashed border-[#f97316]/35 bg-[#0d0f12]/70 px-3.5 py-2 text-xs font-medium text-slate-300 sm:text-sm"
                  >
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-[#f97316]" />
                    <span>
                      {loadingExtraServerNames.length > 0
                        ? `Buscando ${loadingExtraServerNames.join(', ')}...`
                        : 'Buscando mais servidores...'}
                    </span>
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-white/8 bg-[#0d0f12] px-3.5 py-2.5 text-[11px] leading-relaxed text-slate-400">
            <Keyboard className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#f97316]" />
            {desktopShortcutsEnabled ? (
              <span>
                <strong className="text-slate-200">Gestos &amp; Atalhos:</strong> toque duplo nas laterais para ±5s, segure na tela ou Espaço para 2×, botão <strong className="text-slate-200">+{skipIntroSeconds}s</strong> pula abertura, e arraste arquivos <span className="font-mono">.ass/.srt/.vtt</span> para carregar legendas locais.
              </span>
            ) : (
              <span>
                <strong className="text-slate-200">Gestos:</strong> deslize esq./dir. para brilho e volume · toque duplo ±5s · segure 2×.
              </span>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
