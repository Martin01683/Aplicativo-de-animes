import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownNarrowWide,
  ArrowLeft,
  ArrowUpWideNarrow,
  Bell,
  BellOff,
  Building2,
  Calendar,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Clock,
  CloudOff,
  Download,
  ExternalLink,
  Film,
  Globe,
  HardDrive,
  Heart,
  Info,
  Layers,
  Loader2,
  Play,
  Radio,
  RefreshCw,
  Search,
  Server,
  Shield,
  SkipForward,
  Star,
  Trash2,
  Tv,
  X,
} from 'lucide-react';
import { apiFetch, isNativeAndroidApp, openExternalOrVlcUrl } from '../lib/apiClient';
import { formatBytes } from '../lib/appUpdater';
import {
  buildAnimeInfoMetaItems,
  formatSeasonDisplayHeading,
  isSynopsisTextOverflowing,
  resolveAnimeHeroAudioBadges,
  resolveVisibleGenres,
} from '../lib/animeInfoMeta';
import {
  formatEpisodeCardBadge,
  formatEpisodeCardTitle,
  formatEpisodeCountdown,
  formatEpisodeFinaleBadge,
  formatEpisodePlayCtaLabel,
  formatEpisodeReleaseDate,
  isEpisodeAvailableOnServer,
  isEpisodeUncensored,
  pickImageWithFallback,
} from '../lib/episodeAvailability';
import { pickLatestAnimeEpisode } from '../lib/favoriteAlerts';
import {
  canonicalOfflineEpisodeUrl,
  type OfflineDownloadInput,
  type OfflineDownloadRecord,
} from '../lib/offlineDownloads';
import {
  canonicalEpisodeProgressKey,
  formatPlaybackTimestamp,
  getResumePositionSec,
  groupEpisodesBySeason,
  isEpisodeMarkedWatched,
  type EpisodeProgressMap,
} from '../lib/playbackProgress';
import {
  buildSeedFromAnimeEpisode,
  getCachedAnimeSynopsis,
  readCachedEpisodeTitles,
  setCachedAnimeSynopsis,
  writeCachedEpisodeTitles,
  type MediaNavigationSeed,
} from '../lib/prefetchCache';
import type {
  AnimeDetails,
  AnimeEpisodeLink,
  AnimeSynopsisResult,
  CatalogMediaItem,
  FavoriteLatestInfo,
} from '../lib/types';
import { MediaPoster } from './MediaPoster';

export type AnimeDetailLoadingStage = 'idle' | 'seed' | 'quick' | 'ready';

interface AnimeDetailViewProps {
  anime: AnimeDetails;
  isFavorite: boolean;
  isMuted?: boolean;
  watchedUrls: Set<string>;
  progressMap?: EpisodeProgressMap;
  loadingStage?: AnimeDetailLoadingStage;
  detailError?: string;
  onRetryDetail?: () => void;
  onToggleFavorite: (item: CatalogMediaItem, knownLatest?: FavoriteLatestInfo | null) => void;
  onToggleMuteFavorite?: (animeUrl: string) => void;
  onToggleEpisodesWatched: (
    episodes: AnimeEpisodeLink[],
    watched: boolean,
    label?: string
  ) => void;
  onOpenEpisode: (episodeUrl: string, seed?: MediaNavigationSeed) => void;
  onOpenAnime?: (animeUrl: string, seed?: MediaNavigationSeed) => void;
  onPrefetchEpisode?: (episodeUrl: string, seed?: MediaNavigationSeed) => void;
  onPrefetchAnime?: (animeUrl: string, seed?: MediaNavigationSeed) => void;
  offlineDownloadsByKey?: Map<string, OfflineDownloadRecord>;
  onStartOfflineDownload?: (input: OfflineDownloadInput) => Promise<void> | void;
  onStartBatchOfflineDownload?: (
    inputs: OfflineDownloadInput[],
    label?: string
  ) => Promise<void> | void;
  onCancelOfflineDownload?: (idOrUrl: string) => Promise<void> | void;
  onDeleteOfflineDownload?: (idOrUrl: string) => Promise<void> | void;
  onLoadingStateChange?: (loading: boolean) => void;
  onBack: () => void;
}

export function AnimeDetailView({
  anime,
  isFavorite,
  isMuted = false,
  watchedUrls,
  progressMap,
  loadingStage = 'ready',
  detailError = '',
  onRetryDetail,
  onToggleFavorite,
  onToggleMuteFavorite,
  onToggleEpisodesWatched,
  onOpenEpisode,
  onPrefetchEpisode,
  offlineDownloadsByKey,
  onStartOfflineDownload,
  onStartBatchOfflineDownload,
  onCancelOfflineDownload,
  onDeleteOfflineDownload,
  onLoadingStateChange,
  onBack,
}: AnimeDetailViewProps) {
  const [episodeFilter, setEpisodeFilter] = useState('');
  const [sortDesc, setSortDesc] = useState(false);
  const [confirmDeleteOfflineId, setConfirmDeleteOfflineId] = useState('');

  useEffect(() => {
    if (!confirmDeleteOfflineId) return;
    const timer = window.setTimeout(() => setConfirmDeleteOfflineId(''), 4000);
    return () => window.clearTimeout(timer);
  }, [confirmDeleteOfflineId]);
  const [synopsisExpandedUrl, setSynopsisExpandedUrl] = useState('');
  const [failedHeroImageUrls, setFailedHeroImageUrls] = useState<string[]>([]);
  const [selectedAudioState, setSelectedAudioState] = useState<{
    animeUrl: string;
    audio: 'DUB' | 'LEG';
  }>({ animeUrl: '', audio: 'LEG' });
  const [selectedSeasonState, setSelectedSeasonState] = useState<{
    animeUrl: string;
    season: number | 'all';
  }>({ animeUrl: '', season: 'all' });
  const [seasonExpandState, setSeasonExpandState] = useState<{
    animeUrl: string;
    overrides: Record<number, boolean>;
  }>({ animeUrl: '', overrides: {} });
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [localizedSynopsisState, setLocalizedSynopsisState] = useState<{
    animeUrl: string;
    loading: boolean;
    result: AnimeSynopsisResult | null;
  }>(() => {
    const cached = getCachedAnimeSynopsis(anime.url);
    return cached.hit
      ? { animeUrl: anime.url, loading: false, result: cached.value }
      : { animeUrl: '', loading: false, result: null };
  });
  const [hydratedTitlesState, setHydratedTitlesState] = useState<{
    animeUrl: string;
    byId: Record<number, string>;
    settledIds: number[];
  }>({ animeUrl: '', byId: {}, settledIds: [] });
  const settledEpisodeTitleIdsRef = useRef<{ animeUrl: string; ids: Set<number> }>({
    animeUrl: '',
    ids: new Set(),
  });
  const epHoverTimerRef = useRef<number | null>(null);

  const scheduleEpisodeHoverPrefetch = useCallback(
    (episodeUrl: string, seed?: MediaNavigationSeed) => {
      if (!onPrefetchEpisode || !episodeUrl) return;
      if (epHoverTimerRef.current !== null) {
        window.clearTimeout(epHoverTimerRef.current);
      }
      epHoverTimerRef.current = window.setTimeout(() => {
        epHoverTimerRef.current = null;
        onPrefetchEpisode(episodeUrl, seed);
      }, 85);
    },
    [onPrefetchEpisode]
  );

  const cancelEpisodeHoverPrefetch = useCallback(() => {
    if (epHoverTimerRef.current !== null) {
      window.clearTimeout(epHoverTimerRef.current);
      epHoverTimerRef.current = null;
    }
  }, []);

  const triggerImmediateEpisodePrefetch = useCallback(
    (episodeUrl: string, seed?: MediaNavigationSeed) => {
      cancelEpisodeHoverPrefetch();
      if (onPrefetchEpisode && episodeUrl) {
        onPrefetchEpisode(episodeUrl, seed);
      }
    },
    [cancelEpisodeHoverPrefetch, onPrefetchEpisode]
  );

  useEffect(() => {
    return () => {
      if (epHoverTimerRef.current !== null) {
        window.clearTimeout(epHoverTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setEpisodeFilter('');
    setSortDesc(false);
  }, [anime.url]);

  // Fetch TheTVDB anime synopsis (PT-BR -> Google Translate -> EN fallback) & artwork when needed
  useEffect(() => {
    // Wait until real server/enriched metadata arrives before requesting TheTVDB synopsis
    if (loadingStage === 'seed' || loadingStage === 'quick') {
      const cached = getCachedAnimeSynopsis(anime.url);
      if (cached.hit) {
        setLocalizedSynopsisState({
          animeUrl: anime.url,
          loading: false,
          result: cached.value,
        });
      }
      return;
    }

    const alreadyLocalizedFromTvdb =
      Boolean(anime.synopsis && anime.synopsis.trim()) &&
      (anime.synopsisSource === 'thetvdb-pt-br' ||
        anime.synopsisSource === 'thetvdb-deepl' ||
        anime.synopsisSource === 'thetvdb-google-translate');

    if (alreadyLocalizedFromTvdb) {
      const result: AnimeSynopsisResult = {
        synopsis: anime.synopsis,
        language: anime.synopsisLanguage || 'pt-BR',
        source: anime.synopsisSource!,
        poster: anime.poster || undefined,
        backdrop: anime.backdrop || undefined,
        tvdbId: anime.externalIds?.tvdbId,
        tvdbSlug: anime.externalIds?.tvdbSlug,
      };
      setCachedAnimeSynopsis(anime.url, result);
      setLocalizedSynopsisState({
        animeUrl: anime.url,
        loading: false,
        result,
      });
      return;
    }

    // Backend already resolved the profile directly from TheTVDB and found no untranslated EN synopsis
    if (
      anime.enrichmentSources?.includes('thetvdb') &&
      anime.synopsisSource !== 'thetvdb-en'
    ) {
      setLocalizedSynopsisState({
        animeUrl: anime.url,
        loading: false,
        result: null,
      });
      return;
    }

    const cached = getCachedAnimeSynopsis(anime.url);
    if (cached.hit) {
      setLocalizedSynopsisState({
        animeUrl: anime.url,
        loading: false,
        result: cached.value,
      });
      return;
    }

    const tvdbId = anime.externalIds?.tvdbId;
    const tvdbSlug = anime.externalIds?.tvdbSlug;
    if (!anime.title && !anime.originalTitle && !tvdbId && !tvdbSlug) {
      setLocalizedSynopsisState({ animeUrl: anime.url, loading: false, result: null });
      return;
    }

    const params = new URLSearchParams();
    if (anime.title) params.set('title', anime.title);
    if (anime.originalTitle) params.set('originalTitle', anime.originalTitle);
    if (anime.year) params.set('year', anime.year);
    if (anime.kind) params.set('mediaType', anime.kind);
    if (tvdbId && tvdbId > 0) params.set('tvdbId', String(tvdbId));
    if (tvdbSlug) params.set('tvdbSlug', tvdbSlug);
    if (anime.synopsisSource === 'thetvdb-en' && anime.synopsis) {
      params.set('englishOverview', anime.synopsis.slice(0, 1800));
    }

    let cancelled = false;
    setLocalizedSynopsisState({ animeUrl: anime.url, loading: true, result: null });

    apiFetch(`/api/anime-synopsis?${params.toString()}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((payload: { result?: AnimeSynopsisResult | null } | null) => {
        if (cancelled) return;
        const resolvedResult = payload?.result ?? null;
        setCachedAnimeSynopsis(anime.url, resolvedResult);
        setLocalizedSynopsisState({
          animeUrl: anime.url,
          loading: false,
          result: resolvedResult,
        });
      })
      .catch(() => {
        if (!cancelled) {
          setLocalizedSynopsisState({
            animeUrl: anime.url,
            loading: false,
            result: null,
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    anime.backdrop,
    anime.enrichmentSources,
    anime.externalIds?.tvdbId,
    anime.externalIds?.tvdbSlug,
    anime.kind,
    anime.originalTitle,
    anime.poster,
    anime.synopsis,
    anime.synopsisLanguage,
    anime.synopsisSource,
    anime.title,
    anime.url,
    anime.year,
    loadingStage,
  ]);

  const scopedSynopsis =
    localizedSynopsisState.animeUrl === anime.url
      ? localizedSynopsisState
      : (() => {
          const cached = getCachedAnimeSynopsis(anime.url);
          return cached.hit
            ? { loading: false, result: cached.value }
            : { loading: false, result: null };
        })();
  const tvdbAnimeSynopsis = scopedSynopsis.result;
  const effectivePoster =
    tvdbAnimeSynopsis?.poster || anime.poster || anime.fallbackPoster || '';
  const effectiveBackdrop =
    tvdbAnimeSynopsis?.backdrop ||
    anime.backdrop ||
    anime.fallbackBackdrop ||
    effectivePoster;
  const heroPosterSrc = pickImageWithFallback(
    [
      tvdbAnimeSynopsis?.poster,
      anime.poster,
      anime.fallbackPoster,
      tvdbAnimeSynopsis?.backdrop,
      anime.backdrop,
      anime.fallbackBackdrop,
    ],
    failedHeroImageUrls
  );
  const heroBackdropSrc = pickImageWithFallback(
    [
      tvdbAnimeSynopsis?.backdrop,
      anime.backdrop,
      anime.fallbackBackdrop,
      tvdbAnimeSynopsis?.poster,
      anime.poster,
      anime.fallbackPoster,
    ],
    failedHeroImageUrls
  );
  const markHeroImageFailed = (failedUrl: string) => {
    if (!failedUrl) return;
    setFailedHeroImageUrls((prev) => (prev.includes(failedUrl) ? prev : [...prev, failedUrl]));
  };

  const isMovie = anime.kind === 'movie';
  const isSeries = anime.kind === 'series';

  const defaultAudioTrack: 'DUB' | 'LEG' = anime.audioType === 'DUB' ? 'DUB' : 'LEG';
  const dubTrack = anime.audioTracks?.DUB;
  const legTrack = anime.audioTracks?.LEG;
  const hasBothAudioTracks = Boolean(
    !isMovie &&
      dubTrack &&
      legTrack &&
      dubTrack.episodes.length > 0 &&
      legTrack.episodes.length > 0 &&
      (dubTrack.playableCount > 0 || legTrack.playableCount > 0)
  );
  const activeAudioTab: 'DUB' | 'LEG' =
    hasBothAudioTracks && selectedAudioState.animeUrl === anime.url
      ? selectedAudioState.audio
      : defaultAudioTrack;
  const heroAudioBadges = useMemo(() => resolveAnimeHeroAudioBadges(anime), [anime]);
  const activeEpisodes = useMemo(
    () =>
      hasBothAudioTracks
        ? activeAudioTab === 'DUB'
          ? dubTrack!.episodes
          : legTrack!.episodes
        : anime.episodes,
    [activeAudioTab, anime.episodes, dubTrack, hasBothAudioTracks, legTrack]
  );

  const displayTitle = useMemo(() => {
    if (!hasBothAudioTracks) return anime.title;
    const stripped = anime.title
      .replace(/(?:[\s\-–—]+(?:\(?\s*(?:dublado|legendado|dub|leg)\s*\)?))+$/i, '')
      .trim();
    return stripped.length >= 2 ? stripped : anime.title;
  }, [anime.title, hasBothAudioTracks]);

  const legPlayableKeys = useMemo(() => {
    const keys = new Set<string>();
    if (!legTrack) return keys;
    for (const ep of legTrack.episodes) {
      if (isEpisodeAvailableOnServer(ep) && ep.episodeNumber !== null) {
        keys.add(`${ep.seasonNumber || 1}:${ep.episodeNumber}`);
      }
    }
    return keys;
  }, [legTrack]);

  const hasScheduledEpisodes = useMemo(
    () => activeEpisodes.some((ep) => !isEpisodeAvailableOnServer(ep)),
    [activeEpisodes]
  );

  useEffect(() => {
    if (!hasScheduledEpisodes) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [hasScheduledEpisodes]);

  const playableEpisodes = useMemo(
    () => activeEpisodes.filter(isEpisodeAvailableOnServer),
    [activeEpisodes]
  );
  const unavailableCount = activeEpisodes.length - playableEpisodes.length;

  const primaryLatestEpisode = useMemo(
    () =>
      pickLatestAnimeEpisode(
        anime.episodes.filter(isEpisodeAvailableOnServer),
        anime.title,
        effectivePoster
      ),
    [anime.episodes, anime.title, effectivePoster]
  );

  const latestEpisode = useMemo(
    () => pickLatestAnimeEpisode(playableEpisodes, displayTitle, effectivePoster),
    [playableEpisodes, displayTitle, effectivePoster]
  );
  const firstEpisode = playableEpisodes[0];
  const lastEpisodeItem =
    playableEpisodes.length > 1 ? playableEpisodes[playableEpisodes.length - 1] : null;
  const quickLastEpisode = useMemo(
    () =>
      !isMovie && latestEpisode && firstEpisode && latestEpisode.episodeUrl !== firstEpisode.url
        ? {
            url: latestEpisode.episodeUrl,
            label: latestEpisode.episodeLabel || latestEpisode.episodeTitle,
          }
        : !isMovie && lastEpisodeItem && firstEpisode && lastEpisodeItem.url !== firstEpisode.url
          ? {
              url: lastEpisodeItem.url,
              label: formatEpisodeCardBadge(lastEpisodeItem, isMovie),
            }
          : null,
    [firstEpisode, isMovie, lastEpisodeItem, latestEpisode]
  );

  const baseSeasonGroups = useMemo(() => groupEpisodesBySeason(activeEpisodes), [activeEpisodes]);

  const activeSeasonTab: number | 'all' = useMemo(() => {
    if (selectedSeasonState.animeUrl !== anime.url) return 'all';
    if (selectedSeasonState.season === 'all') return 'all';
    const exists = baseSeasonGroups.some((g) => g.seasonNumber === selectedSeasonState.season);
    return exists ? selectedSeasonState.season : 'all';
  }, [anime.url, baseSeasonGroups, selectedSeasonState.animeUrl, selectedSeasonState.season]);

  // Eagerly hydrate official TheTVDB PT-BR episode titles via /api/episode-titles as soon as
  // the anime profile opens (in 28-episode batches) so titles never swap visibly when expanding seasons.
  const allUnlocalizedEpisodeIds = useMemo(() => {
    if (isMovie) return [] as number[];
    const ids: number[] = [];
    const seen = new Set<number>();
    const sources = [
      anime.episodes,
      dubTrack?.episodes || [],
      legTrack?.episodes || [],
    ];
    for (const list of sources) {
      for (const ep of list) {
        if (
          ep.titleLocalized ||
          !ep.tvdbEpisodeId ||
          ep.tvdbEpisodeId <= 0 ||
          seen.has(ep.tvdbEpisodeId)
        ) {
          continue;
        }
        seen.add(ep.tvdbEpisodeId);
        ids.push(ep.tvdbEpisodeId);
      }
    }
    return ids;
  }, [anime.episodes, dubTrack?.episodes, isMovie, legTrack?.episodes]);

  const allUnlocalizedEpisodeIdsKey = useMemo(
    () => allUnlocalizedEpisodeIds.join(','),
    [allUnlocalizedEpisodeIds]
  );

  const cachedEpisodeTitlesSnapshot = useMemo(
    () => readCachedEpisodeTitles(allUnlocalizedEpisodeIds),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allUnlocalizedEpisodeIdsKey, hydratedTitlesState.settledIds.length]
  );

  const hydratedTitlesById = useMemo(
    () => ({
      ...cachedEpisodeTitlesSnapshot.byId,
      ...(hydratedTitlesState.animeUrl === anime.url ? hydratedTitlesState.byId : {}),
    }),
    [
      anime.url,
      cachedEpisodeTitlesSnapshot.byId,
      hydratedTitlesState.animeUrl,
      hydratedTitlesState.byId,
    ]
  );

  const visibleSeasonGroups = useMemo(() => {
    const query = episodeFilter.trim().toLowerCase();
    const isPureDigits = /^\d+$/.test(query);
    const numericTarget = isPureDigits ? Number.parseInt(query, 10) : null;

    const sourceGroups =
      !query && activeSeasonTab !== 'all'
        ? baseSeasonGroups.filter((g) => g.seasonNumber === activeSeasonTab)
        : baseSeasonGroups;

    const groups = sourceGroups
      .map((group) => {
        const filtered = !query
          ? group.episodes
          : group.episodes.filter((ep) => {
              const hydratedTitle = ep.tvdbEpisodeId
                ? hydratedTitlesById[ep.tvdbEpisodeId] || ''
                : '';
              if (numericTarget !== null) {
                if (ep.episodeNumber === numericTarget) return true;
                const labelMatch = ep.numberLabel.match(/(\d+)\s*$/);
                if (labelMatch && Number.parseInt(labelMatch[1], 10) === numericTarget) {
                  return true;
                }
                const titleNum = ep.title.match(/\b(\d+)\b/);
                if (titleNum && Number.parseInt(titleNum[1], 10) === numericTarget) {
                  return true;
                }
                return (
                  ep.numberLabel.toLowerCase().includes(query) ||
                  ep.title.toLowerCase().includes(query) ||
                  hydratedTitle.toLowerCase().includes(query)
                );
              }
              return (
                ep.title.toLowerCase().includes(query) ||
                hydratedTitle.toLowerCase().includes(query) ||
                ep.numberLabel.toLowerCase().includes(query) ||
                (ep.date && ep.date.toLowerCase().includes(query)) ||
                (isEpisodeUncensored(ep) && 'sem censura uncensored'.includes(query))
              );
            });
        const ordered = sortDesc ? [...filtered].reverse() : filtered;
        return { ...group, episodes: ordered };
      })
      .filter((g) => g.episodes.length > 0);

    return sortDesc ? [...groups].reverse() : groups;
  }, [activeSeasonTab, baseSeasonGroups, episodeFilter, hydratedTitlesById, sortDesc]);

  const isWatchedEpisode = (ep: AnimeEpisodeLink) =>
    isEpisodeMarkedWatched(ep.url, progressMap, watchedUrls);

  const hasActiveEpisodeSearch = episodeFilter.trim().length > 0;
  const isSeasonExpanded = (seasonNumber: number): boolean => {
    if (isMovie || hasActiveEpisodeSearch || activeSeasonTab !== 'all') return true;
    if (
      seasonExpandState.animeUrl === anime.url &&
      Object.prototype.hasOwnProperty.call(seasonExpandState.overrides, seasonNumber)
    ) {
      return seasonExpandState.overrides[seasonNumber];
    }
    return baseSeasonGroups.length <= 1;
  };

  const settledTitleIdsSet = useMemo(
    () =>
      new Set<number>([
        ...cachedEpisodeTitlesSnapshot.settledIds,
        ...(hydratedTitlesState.animeUrl === anime.url ? hydratedTitlesState.settledIds : []),
      ]),
    [
      anime.url,
      cachedEpisodeTitlesSnapshot.settledIds,
      hydratedTitlesState.animeUrl,
      hydratedTitlesState.settledIds,
    ]
  );

  const isEpisodeTitleLoading = (ep: AnimeEpisodeLink): boolean => {
    if (isMovie || ep.titleLocalized || !ep.tvdbEpisodeId || ep.tvdbEpisodeId <= 0) {
      return false;
    }
    if (hydratedTitlesById[ep.tvdbEpisodeId]) {
      return false;
    }
    return !settledTitleIdsSet.has(ep.tvdbEpisodeId);
  };

  const isHydratingEpisodeTitles = useMemo(
    () =>
      !isMovie &&
      allUnlocalizedEpisodeIds.some(
        (id) => !hydratedTitlesById[id] && !settledTitleIdsSet.has(id)
      ),
    [allUnlocalizedEpisodeIds, hydratedTitlesById, isMovie, settledTitleIdsSet]
  );

  const alreadyLocalizedSynopsis =
    Boolean(anime.synopsis && anime.synopsis.trim()) &&
    (anime.synopsisSource === 'thetvdb-pt-br' ||
      anime.synopsisSource === 'thetvdb-deepl' ||
      anime.synopsisSource === 'thetvdb-google-translate');
  const alreadyResolvedByTvdb =
    alreadyLocalizedSynopsis ||
    (Boolean(anime.enrichmentSources?.includes('thetvdb')) &&
      anime.synopsisSource !== 'thetvdb-en');
  const hasSynopsisQueryInput = Boolean(
    anime.title ||
      anime.originalTitle ||
      anime.externalIds?.tvdbId ||
      anime.externalIds?.tvdbSlug
  );
  const isSynopsisPending =
    scopedSynopsis.loading ||
    (loadingStage === 'ready' &&
      !alreadyResolvedByTvdb &&
      !getCachedAnimeSynopsis(anime.url).hit &&
      hasSynopsisQueryInput &&
      localizedSynopsisState.animeUrl !== anime.url);

  const isAnimeContentHydrating =
    loadingStage === 'seed' ||
    loadingStage === 'quick' ||
    isSynopsisPending ||
    isHydratingEpisodeTitles;

  useLayoutEffect(() => {
    onLoadingStateChange?.(isAnimeContentHydrating);
  }, [isAnimeContentHydrating, onLoadingStateChange]);

  useLayoutEffect(() => {
    return () => {
      onLoadingStateChange?.(false);
    };
  }, [onLoadingStateChange]);

  useEffect(() => {
    if (isMovie || !allUnlocalizedEpisodeIdsKey) return;
    if (settledEpisodeTitleIdsRef.current.animeUrl !== anime.url) {
      settledEpisodeTitleIdsRef.current = { animeUrl: anime.url, ids: new Set() };
    }
    const parsedIds = allUnlocalizedEpisodeIdsKey
      .split(',')
      .map((s) => Number.parseInt(s, 10))
      .filter((id) => Number.isFinite(id) && id > 0);
    const { missingIds } = readCachedEpisodeTitles(parsedIds);
    const idsToFetch = missingIds.filter(
      (id) => !settledEpisodeTitleIdsRef.current.ids.has(id)
    );
    if (idsToFetch.length === 0) return;

    const batches: number[][] = [];
    for (let i = 0; i < idsToFetch.length; i += 28) {
      batches.push(idsToFetch.slice(i, i + 28));
    }

    let cancelled = false;
    const tvdbSlug = anime.externalIds?.tvdbSlug;
    const tvdbId = anime.externalIds?.tvdbId;

    const runBatch = async (batchIds: number[]) => {
      const params = new URLSearchParams({ ids: batchIds.join(',') });
      if (tvdbSlug) params.set('tvdbSlug', tvdbSlug);
      if (tvdbId) params.set('tvdbId', String(tvdbId));

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
        // Non-fatal: settle IDs so cards fall back cleanly to guide titles
      }

      if (okToCache) {
        writeCachedEpisodeTitles(nextEntries, batchIds);
      }
      if (cancelled) return;
      if (settledEpisodeTitleIdsRef.current.animeUrl === anime.url) {
        for (const id of batchIds) {
          settledEpisodeTitleIdsRef.current.ids.add(id);
        }
      }
      setHydratedTitlesState((prev) => {
        const prevById = prev.animeUrl === anime.url ? prev.byId : {};
        const prevSettled = prev.animeUrl === anime.url ? prev.settledIds : [];
        const mergedSettled = Array.from(new Set([...prevSettled, ...batchIds]));
        return {
          animeUrl: anime.url,
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
    allUnlocalizedEpisodeIdsKey,
    anime.externalIds?.tvdbId,
    anime.externalIds?.tvdbSlug,
    anime.url,
    isMovie,
  ]);

  // Quietly prefetch the primary CTA episode in background shortly after the detail page renders
  useEffect(() => {
    if (!onPrefetchEpisode || !firstEpisode || loadingStage === 'seed') return;
    const timer = window.setTimeout(() => {
      onPrefetchEpisode(
        firstEpisode.url,
        buildSeedFromAnimeEpisode(anime, firstEpisode, activeEpisodes)
      );
    }, 520);
    return () => window.clearTimeout(timer);
  }, [activeEpisodes, anime, firstEpisode, loadingStage, onPrefetchEpisode]);

  const toggleSeasonExpanded = (seasonNumber: number) => {
    const currentlyExpanded = isSeasonExpanded(seasonNumber);
    setSeasonExpandState((prev) => ({
      animeUrl: anime.url,
      overrides: {
        ...(prev.animeUrl === anime.url ? prev.overrides : {}),
        [seasonNumber]: !currentlyExpanded,
      },
    }));
  };

  const allVisibleSeasonsExpanded =
    visibleSeasonGroups.length > 0 &&
    visibleSeasonGroups.every((g) => isSeasonExpanded(g.seasonNumber));

  const toggleAllSeasonsExpanded = () => {
    const nextExpanded = !allVisibleSeasonsExpanded;
    const nextOverrides: Record<number, boolean> = {};
    for (const group of baseSeasonGroups) {
      nextOverrides[group.seasonNumber] = nextExpanded;
    }
    setSeasonExpandState({
      animeUrl: anime.url,
      overrides: nextOverrides,
    });
  };

  const totalWatchedCount = playableEpisodes.filter(isWatchedEpisode).length;
  const allEpisodesWatched =
    playableEpisodes.length > 0 && totalWatchedCount === playableEpisodes.length;

  const subtitleParts: string[] = [];
  if (
    anime.alternativeTitle &&
    anime.alternativeTitle.toLowerCase() !== displayTitle.toLowerCase()
  ) {
    subtitleParts.push(anime.alternativeTitle);
  }
  if (
    anime.originalTitle &&
    anime.originalTitle.toLowerCase() !== anime.title.toLowerCase() &&
    anime.originalTitle.toLowerCase() !== displayTitle.toLowerCase() &&
    anime.originalTitle.toLowerCase() !== (anime.alternativeTitle || '').toLowerCase()
  ) {
    subtitleParts.push(anime.originalTitle);
  }

  const visibleGenres = resolveVisibleGenres(anime.genres, undefined, anime.kind);

  const extraMetaItems = useMemo(() => buildAnimeInfoMetaItems(anime), [anime]);

  // Show TheTVDB, MyAnimeList, and LiveChart.me links
  const externalLinks = useMemo(() => {
    return (anime.externalLinks || []).filter(
      (link) =>
        link.source === 'thetvdb' ||
        link.source === 'myanimelist' ||
        link.source === 'livechart'
    );
  }, [anime.externalLinks]);

  const handleOpenExternalLink = (targetUrl: string) => {
    if (!targetUrl) return;
    if (isNativeAndroidApp()) {
      void openExternalOrVlcUrl(targetUrl);
      return;
    }
    window.open(targetUrl, '_blank', 'noopener,noreferrer');
  };

  const handleToggleFav = () => {
    onToggleFavorite(
      {
        id: anime.url,
        title: anime.title,
        url: anime.url,
        kind: anime.kind || 'anime',
        poster: effectivePoster,
        audioType: anime.audioType,
        rating: anime.rating,
        year: anime.year,
        catalogSource: anime.catalogSource,
        externalIds: anime.externalIds,
      },
      primaryLatestEpisode
    );
  };

  const isSynopsisExpanded = synopsisExpandedUrl === anime.url;
  const displaySynopsis = tvdbAnimeSynopsis?.synopsis || anime.synopsis;
  const activeSynopsisSource = tvdbAnimeSynopsis?.source || anime.synopsisSource;
  const synopsisSourceCaption =
    activeSynopsisSource === 'thetvdb-pt-br'
      ? 'TheTVDB · PT-BR'
      : activeSynopsisSource === 'thetvdb-deepl'
        ? 'TheTVDB · Traduzido via DeepL'
        : activeSynopsisSource === 'thetvdb-google-translate'
          ? 'TheTVDB · Traduzido via Google Tradutor'
          : activeSynopsisSource === 'thetvdb-en'
            ? 'TheTVDB · Original (EN)'
            : null;
  const awaitingSynopsis =
    (scopedSynopsis.loading || loadingStage === 'seed' || loadingStage === 'quick') &&
    !displaySynopsis;
  const synopsisParagraphRef = useRef<HTMLParagraphElement | null>(null);
  const synopsisMeasureKey = `${anime.url}::${displaySynopsis || ''}`;
  const [synopsisOverflowState, setSynopsisOverflowState] = useState<{
    key: string;
    overflowing: boolean;
  }>({ key: '', overflowing: false });

  useLayoutEffect(() => {
    if (awaitingSynopsis || !displaySynopsis) {
      setSynopsisOverflowState({ key: synopsisMeasureKey, overflowing: false });
      return;
    }
    const el = synopsisParagraphRef.current;
    if (!el) return;

    const measure = () => {
      const computedLineHeight = Number.parseFloat(window.getComputedStyle(el).lineHeight);
      const nextOverflowing = isSynopsisTextOverflowing({
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        lineHeight: computedLineHeight,
        isExpanded: isSynopsisExpanded,
        maxLines: 4,
      });
      setSynopsisOverflowState((prev) =>
        prev.key === synopsisMeasureKey && prev.overflowing === nextOverflowing
          ? prev
          : { key: synopsisMeasureKey, overflowing: nextOverflowing }
      );
    };

    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => measure());
      observer.observe(el);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [awaitingSynopsis, displaySynopsis, isSynopsisExpanded, synopsisMeasureKey]);

  const canExpandSynopsis = Boolean(
    displaySynopsis &&
      synopsisOverflowState.key === synopsisMeasureKey &&
      synopsisOverflowState.overflowing
  );

  const firstEpisodeSeed = useMemo(
    () => (firstEpisode ? buildSeedFromAnimeEpisode(anime, firstEpisode, activeEpisodes) : undefined),
    [activeEpisodes, anime, firstEpisode]
  );
  const quickLastEpisodeSeed = useMemo(() => {
    if (!quickLastEpisode) return undefined;
    const matched = activeEpisodes.find((ep) => ep.url === quickLastEpisode.url);
    return matched
      ? buildSeedFromAnimeEpisode(anime, matched, activeEpisodes)
      : {
          title: `${anime.title} — ${quickLastEpisode.label}`,
          seriesTitle: anime.title,
          seriesUrl: anime.url,
          poster: effectivePoster,
          backdrop: effectiveBackdrop,
          episodeLabel: quickLastEpisode.label,
          kind: isMovie ? ('movie' as const) : ('episode' as const),
          isMovie,
          genres: anime.genres,
        };
  }, [activeEpisodes, anime, effectiveBackdrop, effectivePoster, isMovie, quickLastEpisode]);

  return (
    <div className="mx-auto max-w-7xl anisync-view-enter px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
      <div className="mb-5 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-2 text-sm font-medium text-slate-400 transition-colors hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" />
          <span>Voltar</span>
        </button>
      </div>

      {/* Hero Info Card enriched by TheTVDB */}
      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#151921]">
        {heroBackdropSrc && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 hidden overflow-hidden md:block"
          >
            <img
              src={heroBackdropSrc}
              alt=""
              decoding="async"
              referrerPolicy="no-referrer"
              onError={() => markHeroImageFailed(heroBackdropSrc)}
              className="h-full w-full object-cover object-center opacity-[0.16] blur-[2px]"
            />
            <div className="absolute inset-0 bg-gradient-to-r from-[#151921] via-[#151921]/92 to-[#151921]/72" />
            <div className="absolute inset-0 bg-gradient-to-t from-[#151921] via-transparent to-[#151921]/35" />
          </div>
        )}

        <div className="relative md:grid md:grid-cols-[230px_1fr] md:items-start md:gap-6 md:p-6 lg:grid-cols-[250px_1fr] lg:gap-8 lg:p-7 xl:grid-cols-[264px_1fr]">
          {heroPosterSrc && (
            <div
              data-hero-banner="true"
              className="relative aspect-[4/5] w-full overflow-hidden bg-[#0d0f12] md:aspect-auto md:rounded-xl md:border md:border-white/15 md:shadow-[0_20px_50px_rgba(0,0,0,0.65)] md:ring-1 md:ring-white/10"
            >
              <img
                src={heroPosterSrc}
                alt={displayTitle}
                fetchPriority="high"
                decoding="async"
                referrerPolicy="no-referrer"
                onError={() => markHeroImageFailed(heroPosterSrc)}
                className="block h-full w-full object-fill md:h-auto md:object-contain"
              />
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-[#151921] via-[#151921]/20 to-transparent md:hidden"
              />
            </div>
          )}

          <div className="min-w-0 space-y-4 px-4 pb-5 pt-3 sm:px-6 sm:pb-6 sm:pt-4 md:p-0">
            {/* Identity: Title -> Subtitle -> Unified Type, Audio & Genre Tags */}
            <div className="space-y-2">
              <h1 className="text-xl font-bold leading-snug tracking-tight text-white sm:text-2xl lg:text-3xl">
                {displayTitle}
              </h1>

              {subtitleParts.length > 0 && (
                <p className="text-xs font-medium leading-relaxed text-slate-400 sm:text-sm">
                  {subtitleParts.join(' · ')}
                </p>
              )}

              <div
                data-hero-badges="true"
                className="flex flex-wrap items-center gap-1.5 pt-0.5"
              >
                <span className="inline-flex items-center gap-1 rounded-full border border-[#f97316]/30 bg-[#f97316]/12 px-2.5 py-0.5 text-[11px] font-semibold text-[#fb923c] sm:text-xs">
                  {isMovie ? <Film className="h-3 w-3" /> : <Tv className="h-3 w-3" />}
                  <span>{isMovie ? 'Filme' : isSeries ? 'Série' : 'Anime'}</span>
                </span>
                {heroAudioBadges.map((audioBadge) => (
                  <span
                    key={audioBadge}
                    data-hero-audio-badge={audioBadge}
                    className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold sm:text-xs ${
                      audioBadge === 'DUB'
                        ? 'border-emerald-500/35 bg-emerald-500/12 text-emerald-300'
                        : 'border-sky-500/35 bg-sky-500/12 text-sky-300'
                    }`}
                  >
                    {audioBadge === 'DUB' ? 'Dublado' : 'Legendado'}
                  </span>
                ))}
                {visibleGenres.map((genre) => (
                  <span
                    key={genre}
                    className="rounded-full border border-white/10 bg-[#0d0f12]/70 px-2.5 py-0.5 text-[11px] font-medium text-slate-300 sm:text-xs"
                  >
                    {genre}
                  </span>
                ))}
              </div>
            </div>

            {/* Synopsis right below genres */}
            {awaitingSynopsis ? (
              <div
                data-anime-synopsis-loading="true"
                className="max-w-3xl space-y-2 border-t border-white/10 pt-3.5"
                aria-label="Carregando sinopse do anime"
              >
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                    Sinopse
                  </span>
                  <span className="text-[11px] font-medium text-slate-500">
                    {loadingStage === 'seed'
                      ? 'Carregando detalhes...'
                      : 'Buscando sinopse no TheTVDB...'}
                  </span>
                </div>
                <div className="anisync-shimmer h-3.5 w-3/4 rounded" />
                <div className="anisync-shimmer h-3.5 w-full rounded" />
                <div className="anisync-shimmer h-3.5 w-5/6 rounded" />
              </div>
            ) : (
              <div
                data-anime-synopsis="true"
                data-synopsis-source={activeSynopsisSource || 'fallback'}
                className="max-w-3xl space-y-1.5 border-t border-white/10 pt-3.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                    Sinopse
                  </span>
                  {scopedSynopsis.loading ? (
                    <span className="text-[11px] font-medium text-slate-500">
                      Buscando sinopse no TheTVDB...
                    </span>
                  ) : synopsisSourceCaption ? (
                    <span className="text-[11px] font-medium text-slate-500">
                      {synopsisSourceCaption}
                    </span>
                  ) : null}
                </div>
                <p
                  ref={synopsisParagraphRef}
                  className={`whitespace-pre-line text-[13.5px] leading-relaxed text-slate-300 sm:text-sm ${
                    !isSynopsisExpanded ? 'line-clamp-4' : ''
                  }`}
                >
                  {displaySynopsis || 'Sinopse não disponível para este título no TheTVDB.'}
                </p>
                {canExpandSynopsis && (
                  <button
                    type="button"
                    onClick={() =>
                      setSynopsisExpandedUrl((prev) => (prev === anime.url ? '' : anime.url))
                    }
                    className="text-xs font-semibold text-[#fb923c] transition-colors hover:text-[#fdba74]"
                  >
                    {isSynopsisExpanded ? 'Recolher sinopse' : 'Ler sinopse completa'}
                  </button>
                )}
              </div>
            )}

            {/* Complete Anime Info Panel + External Sources */}
            {(extraMetaItems.length > 0 || externalLinks.length > 0) && (
              <div
                data-anime-info-panel="true"
                className="overflow-hidden rounded-xl border border-white/8 bg-[#0d0f12]/60"
              >
                <div className="flex items-center justify-between border-b border-white/8 px-3.5 py-2">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                    Informações
                  </span>
                  {extraMetaItems.length > 0 && (
                    <span className="text-[10px] font-medium tabular-nums text-slate-500">
                      {extraMetaItems.length} {extraMetaItems.length === 1 ? 'detalhe' : 'detalhes'}
                    </span>
                  )}
                </div>

                {extraMetaItems.length > 0 && (
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-3.5 py-3 text-xs sm:grid-cols-3 xl:grid-cols-4">
                    {extraMetaItems.map((meta) => {
                      const isMultiItemCategory = Boolean(meta.items && meta.items.length > 1);
                      return (
                        <div
                          key={meta.id}
                          data-anime-meta={meta.id}
                          className={`min-w-0 ${
                            meta.fullWidth
                              ? 'col-span-full border-t border-white/8 pt-2.5'
                              : ''
                          }`}
                        >
                          <dt className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-slate-500">
                            {meta.kind === 'status' && (
                              <span
                                aria-hidden="true"
                                className={`h-2 w-2 shrink-0 rounded-full ${
                                  meta.highlight ? 'bg-emerald-400' : 'bg-slate-500'
                                }`}
                              />
                            )}
                            {meta.kind === 'rating' && (
                              <Star className="h-3 w-3 shrink-0 fill-amber-400 text-amber-400" />
                            )}
                            {meta.kind === 'shield' && (
                              <Shield className="h-3 w-3 shrink-0 text-slate-400" />
                            )}
                            {meta.kind === 'date' && <Calendar className="h-3 w-3 shrink-0 text-slate-400" />}
                            {meta.kind === 'clock' && <Clock className="h-3 w-3 shrink-0 text-slate-400" />}
                            {meta.kind === 'layers' && <Layers className="h-3 w-3 shrink-0 text-slate-400" />}
                            {meta.kind === 'studio' && <Building2 className="h-3 w-3 shrink-0 text-slate-400" />}
                            {meta.kind === 'network' && <Radio className="h-3 w-3 shrink-0 text-slate-400" />}
                            {meta.kind === 'globe' && <Globe className="h-3 w-3 shrink-0 text-slate-400" />}
                            {meta.kind === 'server' && <Server className="h-3 w-3 shrink-0 text-slate-400" />}
                            <span className="leading-tight">{meta.label}</span>
                          </dt>
                          {isMultiItemCategory && meta.items ? (
                            <dd
                              title={meta.value}
                              className="mt-1.5 flex flex-wrap items-center gap-1.5"
                            >
                              {meta.items.map((entry) => (
                                <span
                                  key={entry}
                                  data-anime-meta-chip={meta.id}
                                  data-anime-provider-chip={meta.kind === 'server' ? 'true' : undefined}
                                  className="inline-flex max-w-full items-center break-words rounded-md border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] font-semibold leading-snug text-slate-200"
                                >
                                  {entry}
                                </span>
                              ))}
                            </dd>
                          ) : meta.kind === 'rating' ? (
                            <dd
                              title={
                                anime.ratingSource === 'myanimelist'
                                  ? `${meta.value} (MyAnimeList)`
                                  : `${meta.value} (Provedor)`
                              }
                              className="mt-0.5 break-words font-bold leading-snug tabular-nums text-amber-400"
                            >
                              {meta.value}
                            </dd>
                          ) : (
                            <dd
                              title={meta.value}
                              className={`mt-0.5 break-words font-semibold leading-snug tabular-nums ${
                                meta.highlight
                                  ? 'text-emerald-300'
                                  : 'text-slate-200'
                              }`}
                            >
                              {meta.value}
                            </dd>
                          )}
                        </div>
                      );
                    })}
                  </dl>
                )}

                {externalLinks.length > 0 && (
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/8 bg-white/[0.02] px-3.5 py-2 text-[11px]">
                    <span className="text-slate-500">Fontes externas</span>
                    <div className="flex flex-wrap items-center gap-3 font-medium">
                      {externalLinks.map((link, idx) => (
                        <span key={`${link.source}-${link.url}`} className="inline-flex items-center gap-3">
                          {idx > 0 && <span className="text-white/15">·</span>}
                          <button
                            type="button"
                            onClick={() => handleOpenExternalLink(link.url)}
                            className="inline-flex items-center gap-1 text-slate-300 transition-colors hover:text-[#fb923c]"
                          >
                            <span>{link.label}</span>
                            <ExternalLink className="h-3 w-3 shrink-0" />
                          </button>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Action Buttons after Info Panel */}
            <div data-anime-actions="true" className="space-y-2.5 pt-0.5">
              <div className="flex flex-wrap items-center gap-2 sm:gap-2.5">
                {firstEpisode && (
                  <button
                    type="button"
                    onMouseEnter={() =>
                      scheduleEpisodeHoverPrefetch(firstEpisode.url, firstEpisodeSeed)
                    }
                    onMouseLeave={cancelEpisodeHoverPrefetch}
                    onFocus={() =>
                      triggerImmediateEpisodePrefetch(firstEpisode.url, firstEpisodeSeed)
                    }
                    onTouchStart={() =>
                      triggerImmediateEpisodePrefetch(firstEpisode.url, firstEpisodeSeed)
                    }
                    onClick={() => onOpenEpisode(firstEpisode.url, firstEpisodeSeed)}
                    className="inline-flex h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-xl bg-[#f97316] px-4 text-sm font-bold text-[#0d0f12] shadow-lg shadow-orange-500/15 transition-colors hover:bg-[#fb923c] sm:flex-none sm:px-5"
                  >
                    <Play className="h-4 w-4 shrink-0 fill-current" />
                    <span className="truncate">{formatEpisodePlayCtaLabel(firstEpisode, isMovie)}</span>
                  </button>
                )}

                {quickLastEpisode && (
                  <button
                    type="button"
                    onMouseEnter={() =>
                      scheduleEpisodeHoverPrefetch(quickLastEpisode.url, quickLastEpisodeSeed)
                    }
                    onMouseLeave={cancelEpisodeHoverPrefetch}
                    onFocus={() =>
                      triggerImmediateEpisodePrefetch(quickLastEpisode.url, quickLastEpisodeSeed)
                    }
                    onTouchStart={() =>
                      triggerImmediateEpisodePrefetch(quickLastEpisode.url, quickLastEpisodeSeed)
                    }
                    onClick={() => onOpenEpisode(quickLastEpisode.url, quickLastEpisodeSeed)}
                    className="hidden h-11 items-center gap-2 rounded-xl border border-[#f97316]/45 bg-[#f97316]/12 px-4 text-xs font-semibold text-[#fb923c] transition-colors hover:bg-[#f97316]/20 sm:inline-flex"
                  >
                    <SkipForward className="h-4 w-4 shrink-0" />
                    <span>Último ({quickLastEpisode.label})</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={handleToggleFav}
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
                    onClick={() => onToggleMuteFavorite(anime.url)}
                    aria-pressed={isMuted}
                    aria-label={
                      isMuted
                        ? `Ativar avisos de novos episódios de ${anime.title}`
                        : `Silenciar avisos de novos episódios de ${anime.title}`
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

              {quickLastEpisode && (
                <button
                  type="button"
                  onTouchStart={() =>
                    triggerImmediateEpisodePrefetch(quickLastEpisode.url, quickLastEpisodeSeed)
                  }
                  onClick={() => onOpenEpisode(quickLastEpisode.url, quickLastEpisodeSeed)}
                  className="flex h-10 w-full items-center justify-between rounded-xl border border-white/10 bg-[#0d0f12]/80 px-3.5 text-xs font-semibold text-slate-200 transition-colors hover:border-[#f97316]/45 hover:text-[#fb923c] sm:hidden"
                >
                  <span className="inline-flex items-center gap-2">
                    <SkipForward className="h-4 w-4 shrink-0 text-[#f97316]" />
                    <span>Ir para o último lançado</span>
                  </span>
                  <span className="rounded-md bg-[#f97316]/15 px-2 py-0.5 font-mono text-[11px] font-bold text-[#fb923c]">
                    {quickLastEpisode.label}
                  </span>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Episodes / Movie Playback Section */}
      <section className="mt-8">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2 className="text-lg font-semibold text-white">
              {isMovie ? 'Reprodução' : 'Episódios'}
            </h2>
            {!isMovie && activeEpisodes.length > 0 && (
              <span className="font-mono text-xs tabular-nums text-slate-400">
                {playableEpisodes.length > 0
                  ? `${totalWatchedCount}/${playableEpisodes.length} vistos`
                  : `${activeEpisodes.length} episódio${activeEpisodes.length === 1 ? '' : 's'}`}
                {unavailableCount > 0 && (
                  <span className="text-[#fb923c]">
                    {' '}
                    · {unavailableCount} {unavailableCount === 1 ? 'indisponível' : 'indisponíveis'}
                  </span>
                )}
              </span>
            )}
            {loadingStage === 'quick' && (
              <span className="text-[11px] font-medium text-slate-500">
                Sincronizando metadados e temporadas...
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {activeEpisodes.length > 1 && (
              <>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                  <input
                    type="text"
                    value={episodeFilter}
                    onChange={(e) => setEpisodeFilter(e.target.value)}
                    placeholder="Buscar episódio..."
                    aria-label="Buscar episódio por número ou título"
                    className="w-40 rounded-lg border border-white/12 bg-[#151921] py-1.5 pl-8 pr-7 text-xs text-white placeholder:text-slate-500 focus:border-[#f97316] focus:outline-none sm:w-48"
                  />
                  {episodeFilter && (
                    <button
                      type="button"
                      onClick={() => setEpisodeFilter('')}
                      aria-label="Limpar busca de episódio"
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:text-white"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => setSortDesc((prev) => !prev)}
                  aria-pressed={sortDesc}
                  title="Alternar ordem dos episódios"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/12 bg-[#151921] px-3 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:border-[#f97316]/60 hover:text-white"
                >
                  {sortDesc ? (
                    <ArrowUpWideNarrow className="h-3.5 w-3.5 text-[#f97316]" />
                  ) : (
                    <ArrowDownNarrowWide className="h-3.5 w-3.5 text-[#f97316]" />
                  )}
                  <span>{sortDesc ? 'Mais recentes' : 'Crescente'}</span>
                </button>
              </>
            )}

            {!isMovie &&
              baseSeasonGroups.length > 1 &&
              !hasActiveEpisodeSearch &&
              activeSeasonTab === 'all' && (
                <button
                  type="button"
                  data-toggle-all-seasons="true"
                  onClick={toggleAllSeasonsExpanded}
                  aria-pressed={allVisibleSeasonsExpanded}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/12 bg-[#151921] px-3 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:border-[#f97316]/60 hover:text-white"
                >
                  {allVisibleSeasonsExpanded ? (
                    <ChevronsDownUp className="h-3.5 w-3.5 text-[#f97316]" />
                  ) : (
                    <ChevronsUpDown className="h-3.5 w-3.5 text-[#f97316]" />
                  )}
                  <span>{allVisibleSeasonsExpanded ? 'Recolher tudo' : 'Expandir tudo'}</span>
                </button>
              )}

            {playableEpisodes.length > 0 && baseSeasonGroups.length > 1 && (
              <button
                type="button"
                onClick={() =>
                  onToggleEpisodesWatched(
                    playableEpisodes,
                    !allEpisodesWatched,
                    allEpisodesWatched
                      ? 'Todas as temporadas desmarcadas'
                      : 'Todas as temporadas marcadas como vistas'
                  )
                }
                aria-pressed={allEpisodesWatched}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                  allEpisodesWatched
                    ? 'border-emerald-500/45 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/20'
                    : 'border-white/12 bg-[#151921] text-slate-200 hover:border-[#f97316]/60 hover:text-white'
                }`}
              >
                <CheckCheck className="h-3.5 w-3.5" />
                <span>
                  {allEpisodesWatched
                    ? 'Desmarcar todas'
                    : 'Marcar tudo como visto'}
                </span>
              </button>
            )}
          </div>
        </div>

        {isHydratingEpisodeTitles && (
          <p
            data-episode-titles-loading="true"
            className="mb-3 text-[11px] font-medium text-slate-500"
          >
            Buscando títulos dos episódios no TheTVDB...
          </p>
        )}

        {hasBothAudioTracks && dubTrack && legTrack && (
          <div
            data-audio-track-tabs="true"
            className="mb-4 flex flex-wrap items-center justify-between gap-2.5 rounded-xl border border-white/10 bg-[#151921] p-2"
          >
            <div
              role="tablist"
              aria-label="Áudio dos episódios"
              className="inline-flex w-full items-center gap-1.5 rounded-lg bg-[#0d0f12] p-1 sm:w-auto"
            >
              {(['DUB', 'LEG'] as const).map((audioKey) => {
                const track = audioKey === 'DUB' ? dubTrack : legTrack;
                const isSelected = activeAudioTab === audioKey;
                const label = audioKey === 'DUB' ? 'Dublado' : 'Legendado';
                const activeStyle =
                  audioKey === 'DUB'
                    ? 'border-emerald-500/45 bg-emerald-500/15 text-emerald-300 shadow-sm'
                    : 'border-sky-500/45 bg-sky-500/15 text-sky-300 shadow-sm';
                const countStyle = isSelected
                  ? audioKey === 'DUB'
                    ? 'bg-emerald-500/20 text-emerald-200'
                    : 'bg-sky-500/20 text-sky-200'
                  : 'bg-white/6 text-slate-400';

                return (
                  <button
                    key={audioKey}
                    type="button"
                    role="tab"
                    data-audio-track-tab={audioKey}
                    aria-selected={isSelected}
                    onClick={() =>
                      setSelectedAudioState({ animeUrl: anime.url, audio: audioKey })
                    }
                    className={`inline-flex flex-1 items-center justify-center gap-2 rounded-md border px-3.5 py-2 text-xs font-semibold transition-colors sm:flex-none ${
                      isSelected
                        ? activeStyle
                        : 'border-transparent text-slate-400 hover:bg-white/[0.04] hover:text-slate-200'
                    }`}
                  >
                    <span>{label}</span>
                    <span
                      className={`rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold tabular-nums ${countStyle}`}
                    >
                      {track.playableCount}
                    </span>
                  </button>
                );
              })}
            </div>

            <p className="px-1.5 text-[11px] text-slate-400">
              {activeAudioTab === 'DUB'
                ? `${dubTrack.playableCount} ${dubTrack.playableCount === 1 ? 'episódio dublado disponível' : 'episódios dublados disponíveis'}`
                : `${legTrack.playableCount} ${legTrack.playableCount === 1 ? 'episódio legendado disponível' : 'episódios legendados disponíveis'}`}
            </p>
          </div>
        )}

        {!isMovie && baseSeasonGroups.length > 1 && (
          <div
            data-season-tabs="true"
            role="tablist"
            aria-label="Temporadas do anime"
            className="mb-4 flex items-center gap-2 overflow-x-auto pb-1"
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeSeasonTab === 'all'}
              onClick={() =>
                setSelectedSeasonState({ animeUrl: anime.url, season: 'all' })
              }
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${
                activeSeasonTab === 'all'
                  ? 'border-[#f97316] bg-[#f97316]/15 text-[#fb923c]'
                  : 'border-white/12 bg-[#151921] text-slate-300 hover:border-white/25 hover:text-white'
              }`}
            >
              <span>Todas ({baseSeasonGroups.length})</span>
              <span className="font-mono text-[11px] font-normal tabular-nums text-slate-400">
                {activeEpisodes.length} eps
              </span>
            </button>

            {baseSeasonGroups.map((group) => {
              const isSelected = activeSeasonTab === group.seasonNumber;
              const groupPlayable = group.episodes.filter(isEpisodeAvailableOnServer);
              const groupWatched = groupPlayable.filter(isWatchedEpisode).length;
              const groupAllWatched =
                groupPlayable.length > 0 && groupWatched === groupPlayable.length;

              return (
                <button
                  key={group.seasonNumber}
                  type="button"
                  role="tab"
                  aria-selected={isSelected}
                  onClick={() =>
                    setSelectedSeasonState({
                      animeUrl: anime.url,
                      season: group.seasonNumber,
                    })
                  }
                  className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${
                    isSelected
                      ? 'border-[#f97316] bg-[#f97316]/15 text-[#fb923c]'
                      : groupAllWatched
                        ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-300 hover:border-emerald-400/55'
                        : 'border-white/12 bg-[#151921] text-slate-300 hover:border-white/25 hover:text-white'
                  }`}
                >
                  {groupAllWatched && <Check className="h-3.5 w-3.5 shrink-0 text-emerald-400" />}
                  <span>{group.label}</span>
                  <span className="font-mono text-[11px] font-normal tabular-nums text-slate-400">
                    {group.episodes.length}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {!isMovie && unavailableCount > 0 && (
          <div
            role="note"
            data-schedule-disclaimer="true"
            className="mb-4 flex items-start gap-2.5 rounded-xl border border-[#f97316]/25 bg-[#f97316]/[0.07] px-3.5 py-2.5 text-xs leading-relaxed text-slate-300"
          >
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-[#fb923c]" />
            <p>
              As datas e contagens regressivas indicam a{' '}
              <strong className="font-semibold text-white">previsão de lançamento oficial</strong>, e
              não o horário exato em que o episódio ficará disponível nos servidores.
            </p>
          </div>
        )}

        {activeEpisodes.length === 0 ? (
          loadingStage === 'seed' ? (
            <div
              data-episodes-loading="true"
              className="overflow-hidden rounded-xl border border-white/10 bg-[#151921] divide-y divide-white/8"
              aria-label="Carregando episódios"
            >
              {Array.from({ length: 4 }).map((_, idx) => (
                <div key={idx} className="flex items-start gap-3 px-3.5 py-3 sm:gap-4 sm:px-4">
                  <div className="anisync-shimmer mt-0.5 h-[54px] w-[96px] shrink-0 rounded-md sm:h-16 sm:w-28" />
                  <div className="min-w-0 flex-1 space-y-2 py-0.5">
                    <div className="anisync-shimmer h-3 w-20 rounded" />
                    <div className="anisync-shimmer h-4 w-3/4 rounded" />
                    <div className="anisync-shimmer h-3 w-1/3 rounded" />
                  </div>
                </div>
              ))}
            </div>
          ) : detailError ? (
            <div className="rounded-xl border border-red-500/20 bg-[#151921] p-8 text-center">
              <p className="text-sm text-red-200">{detailError}</p>
              {onRetryDetail && (
                <button
                  type="button"
                  onClick={onRetryDetail}
                  className="mt-4 inline-flex items-center gap-2 rounded-lg bg-[#f97316] px-4 py-2 text-xs font-semibold text-[#0d0f12]"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  <span>Tentar novamente</span>
                </button>
              )}
            </div>
          ) : (
            <div className="rounded-xl border border-white/10 bg-[#151921] p-8 text-center text-sm text-slate-400">
              Nenhum episódio listado nos provedores ativos para este título ainda.
            </div>
          )
        ) : visibleSeasonGroups.length === 0 ? (
          <div className="rounded-xl border border-white/10 bg-[#151921] p-8 text-center">
            <p className="text-sm text-slate-400">
              Nenhum episódio encontrado para &ldquo;{episodeFilter}&rdquo;.
            </p>
            <button
              type="button"
              onClick={() => setEpisodeFilter('')}
              className="mt-3 rounded-lg bg-[#f97316] px-3.5 py-1.5 text-xs font-semibold text-[#0d0f12]"
            >
              Limpar filtro
            </button>
          </div>
        ) : (
          <div className="space-y-3.5">
            {visibleSeasonGroups.map((group) => {
              const fullGroup =
                baseSeasonGroups.find((g) => g.seasonNumber === group.seasonNumber) || group;
              const seasonPlayableEpisodes = fullGroup.episodes.filter(isEpisodeAvailableOnServer);
              const seasonUnavailableCount =
                fullGroup.episodes.length - seasonPlayableEpisodes.length;
              const seasonWatchedCount = seasonPlayableEpisodes.filter(isWatchedEpisode).length;
              const seasonAllWatched =
                seasonPlayableEpisodes.length > 0 &&
                seasonWatchedCount === seasonPlayableEpisodes.length;
              const totalSeasonEpisodes = fullGroup.episodes.length;
              const seasonBadgeLabel =
                seasonPlayableEpisodes.length > 0
                  ? `${seasonWatchedCount}/${seasonPlayableEpisodes.length}`
                  : `0/${totalSeasonEpisodes}`;
              const seasonBadgeClass = seasonAllWatched
                ? 'border-emerald-500/45 bg-emerald-500/20 text-emerald-300'
                : 'border-[#f97316]/35 bg-[#f97316]/15 text-[#fb923c]';
              const seasonExpanded = isSeasonExpanded(group.seasonNumber);
              const seasonPanelId = `season-panel-${group.seasonNumber}`;
              const canCollapseSeason =
                !isMovie && !hasActiveEpisodeSearch && activeSeasonTab === 'all';
              const seasonCustomName = !isMovie
                ? anime.seasonNames?.[group.seasonNumber]?.trim() || ''
                : '';
              const seasonDisplayTitle = isMovie
                ? group.label
                : formatSeasonDisplayHeading(group.seasonNumber, group.label, anime.seasonNames);
              const canDownloadSeason =
                !isMovie &&
                seasonPlayableEpisodes.length > 0 &&
                Boolean(onStartBatchOfflineDownload || onStartOfflineDownload);
              const seasonOfflineSavedCount = seasonPlayableEpisodes.filter((ep) => {
                const rec = offlineDownloadsByKey?.get(canonicalOfflineEpisodeUrl(ep.url));
                return rec?.status === 'completed';
              }).length;
              const seasonOfflineActiveRecs = seasonPlayableEpisodes
                .map((ep) => offlineDownloadsByKey?.get(canonicalOfflineEpisodeUrl(ep.url)))
                .filter(
                  (rec): rec is OfflineDownloadRecord =>
                    rec !== undefined &&
                    (rec.status === 'queued' ||
                      rec.status === 'resolving' ||
                      rec.status === 'downloading')
                );
              const seasonOfflineRemainingEps = seasonPlayableEpisodes.filter((ep) => {
                const rec = offlineDownloadsByKey?.get(canonicalOfflineEpisodeUrl(ep.url));
                return (
                  !rec ||
                  (rec.status !== 'completed' &&
                    rec.status !== 'queued' &&
                    rec.status !== 'resolving' &&
                    rec.status !== 'downloading')
                );
              });
              const seasonAllSavedOffline =
                seasonPlayableEpisodes.length > 0 &&
                seasonOfflineSavedCount === seasonPlayableEpisodes.length;
              const handleDownloadSeasonClick = () => {
                if (seasonAllSavedOffline) return;
                if (seasonOfflineRemainingEps.length === 0 && seasonOfflineActiveRecs.length > 0) {
                  if (onCancelOfflineDownload) {
                    for (const rec of seasonOfflineActiveRecs) {
                      void onCancelOfflineDownload(rec.id);
                    }
                  }
                  return;
                }
                const inputs: OfflineDownloadInput[] = seasonOfflineRemainingEps.map((ep) => {
                  const seed = buildSeedFromAnimeEpisode(anime, ep, activeEpisodes);
                  const epBadge = formatEpisodeCardBadge(ep, isMovie);
                  const hydratedTitle =
                    ep.tvdbEpisodeId && hydratedTitlesById[ep.tvdbEpisodeId]
                      ? hydratedTitlesById[ep.tvdbEpisodeId]
                      : '';
                  const epTitle = hydratedTitle || formatEpisodeCardTitle(ep, isMovie);
                  return {
                    episodeUrl: ep.url,
                    title: epTitle,
                    seriesTitle: anime.title,
                    seriesUrl: anime.url,
                    episodeLabel: epBadge,
                    poster: ep.thumb || anime.backdrop || anime.poster,
                    isMovie: false,
                    seasonNumber: ep.seasonNumber,
                    episodeNumber: ep.episodeNumber ?? undefined,
                    prevUrl: seed.prevUrl,
                    nextUrl: seed.nextUrl,
                  };
                });
                if (onStartBatchOfflineDownload) {
                  void onStartBatchOfflineDownload(inputs, group.label);
                } else if (onStartOfflineDownload) {
                  for (const item of inputs) {
                    void onStartOfflineDownload(item);
                  }
                }
              };
              const seasonDownloadLabel = seasonAllSavedOffline
                ? 'Temporada salva'
                : seasonOfflineRemainingEps.length === 0 && seasonOfflineActiveRecs.length > 0
                  ? `Baixando (${seasonOfflineSavedCount}/${seasonPlayableEpisodes.length})`
                  : seasonOfflineSavedCount > 0 || seasonOfflineActiveRecs.length > 0
                    ? `Baixar restantes (${seasonOfflineRemainingEps.length})`
                    : `Baixar temporada (${seasonPlayableEpisodes.length})`;
              const seasonDownloadClass = seasonAllSavedOffline
                ? 'border-emerald-500/45 bg-emerald-500/15 text-emerald-300'
                : seasonOfflineRemainingEps.length === 0 && seasonOfflineActiveRecs.length > 0
                  ? 'border-[#f97316]/50 bg-[#f97316]/15 text-[#fb923c] hover:bg-[#f97316]/25'
                  : 'border-white/12 bg-[#151921] text-slate-200 hover:border-emerald-500/50 hover:text-white';

              return (
                <div
                  key={group.seasonNumber}
                  data-season-card={group.seasonNumber}
                  data-season-expanded={seasonExpanded ? 'true' : 'false'}
                  className="overflow-hidden rounded-xl border border-white/10 bg-[#151921]"
                >
                  <div
                    data-season-header={group.seasonNumber}
                    className={`flex items-center justify-between gap-2 bg-[#0d0f12]/55 px-4 py-2.5 transition-colors ${
                      seasonExpanded ? 'border-b border-white/10' : ''
                    } ${canCollapseSeason ? 'hover:bg-white/[0.04]' : ''}`}
                  >
                    {canCollapseSeason ? (
                      <button
                        type="button"
                        data-season-toggle={group.seasonNumber}
                        aria-expanded={seasonExpanded}
                        aria-controls={seasonPanelId}
                        onClick={() => toggleSeasonExpanded(group.seasonNumber)}
                        title={seasonDisplayTitle}
                        className="flex min-w-0 flex-1 items-center gap-2 py-0.5 text-left"
                      >
                        <span className="shrink-0 whitespace-nowrap text-xs font-semibold uppercase tracking-wide text-white sm:text-sm sm:normal-case sm:tracking-normal">
                          {group.label}
                        </span>
                        {seasonCustomName &&
                          seasonCustomName.toLowerCase() !== group.label.toLowerCase() && (
                            <span
                              data-season-arc-name={group.seasonNumber}
                              className="truncate text-xs font-medium text-slate-400 sm:text-[13px]"
                            >
                              · {seasonCustomName}
                            </span>
                          )}
                        <span
                          data-season-badge={group.seasonNumber}
                          className={`inline-flex shrink-0 items-center rounded-md border px-2 py-0.5 font-mono text-[11px] font-semibold tabular-nums ${seasonBadgeClass}`}
                        >
                          {seasonBadgeLabel}
                        </span>
                        {seasonUnavailableCount > 0 && (
                          <span className="truncate font-mono text-[11px] tabular-nums text-[#fb923c]">
                            · {seasonUnavailableCount}{' '}
                            {seasonUnavailableCount === 1 ? 'indisponível' : 'indisponíveis'}
                          </span>
                        )}
                      </button>
                    ) : (
                      <div
                        title={seasonDisplayTitle}
                        className="flex min-w-0 flex-1 items-center gap-2"
                      >
                        <span className="shrink-0 whitespace-nowrap text-xs font-semibold uppercase tracking-wide text-white sm:text-sm sm:normal-case sm:tracking-normal">
                          {group.label}
                        </span>
                        {seasonCustomName &&
                          seasonCustomName.toLowerCase() !== group.label.toLowerCase() && (
                            <span
                              data-season-arc-name={group.seasonNumber}
                              className="truncate text-xs font-medium text-slate-400 sm:text-[13px]"
                            >
                              · {seasonCustomName}
                            </span>
                          )}
                        <span
                          data-season-badge={group.seasonNumber}
                          className={`inline-flex shrink-0 items-center rounded-md border px-2 py-0.5 font-mono text-[11px] font-semibold tabular-nums ${seasonBadgeClass}`}
                        >
                          {seasonBadgeLabel}
                        </span>
                        {seasonUnavailableCount > 0 && (
                          <span className="truncate font-mono text-[11px] tabular-nums text-[#fb923c]">
                            · {seasonUnavailableCount}{' '}
                            {seasonUnavailableCount === 1 ? 'indisponível' : 'indisponíveis'}
                          </span>
                        )}
                      </div>
                    )}

                    <div className="flex shrink-0 items-center gap-2">
                      {canDownloadSeason && (
                        <button
                          type="button"
                          data-season-download-desktop={group.seasonNumber}
                          disabled={seasonAllSavedOffline}
                          onClick={handleDownloadSeasonClick}
                          title={
                            seasonAllSavedOffline
                              ? `Todos os episódios de ${group.label} já estão salvos offline`
                              : seasonOfflineRemainingEps.length === 0 &&
                                  seasonOfflineActiveRecs.length > 0
                                ? `Toque para cancelar os downloads em andamento/na fila de ${group.label}`
                                : `Baixar todos os episódios disponíveis de ${group.label} para assistir offline`
                          }
                          className={`hidden sm:inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium tabular-nums transition-colors disabled:cursor-default ${seasonDownloadClass}`}
                        >
                          {seasonAllSavedOffline ? (
                            <HardDrive className="h-3.5 w-3.5 shrink-0 text-emerald-300" />
                          ) : seasonOfflineRemainingEps.length === 0 &&
                            seasonOfflineActiveRecs.length > 0 ? (
                            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                          ) : (
                            <Download className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                          )}
                          <span>{seasonDownloadLabel}</span>
                          {seasonOfflineRemainingEps.length === 0 &&
                            seasonOfflineActiveRecs.length > 0 && (
                              <X className="h-3 w-3 shrink-0 opacity-80" />
                            )}
                        </button>
                      )}

                      {seasonPlayableEpisodes.length > 0 && (
                        <button
                          type="button"
                          data-season-mark-desktop={group.seasonNumber}
                          onClick={() =>
                            onToggleEpisodesWatched(
                              seasonPlayableEpisodes,
                              !seasonAllWatched,
                              seasonAllWatched
                                ? `${group.label} desmarcada`
                                : `${group.label} marcada como vista`
                            )
                          }
                          aria-pressed={seasonAllWatched}
                          className={`hidden sm:inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors ${
                            seasonAllWatched
                              ? 'border-emerald-500/45 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/20'
                              : 'border-white/12 bg-[#151921] text-slate-200 hover:border-emerald-500/50 hover:text-white'
                          }`}
                        >
                          <CheckCheck className="h-3.5 w-3.5" />
                          <span>
                            {seasonAllWatched
                              ? isMovie
                                ? 'Visto'
                                : 'Temporada vista'
                              : isMovie
                                ? 'Marcar como visto'
                                : 'Marcar temporada como vista'}
                          </span>
                        </button>
                      )}

                      {canCollapseSeason && (
                        <button
                          type="button"
                          data-season-chevron={group.seasonNumber}
                          aria-expanded={seasonExpanded}
                          aria-controls={seasonPanelId}
                          aria-label={
                            seasonExpanded
                              ? `Recolher ${group.label}`
                              : `Expandir ${group.label}`
                          }
                          onClick={() => toggleSeasonExpanded(group.seasonNumber)}
                          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/10 text-slate-200 transition-colors hover:bg-white/15 hover:text-white"
                        >
                          <ChevronDown
                            className={`h-4 w-4 transition-transform duration-200 ${
                              seasonExpanded ? 'rotate-180' : ''
                            }`}
                          />
                        </button>
                      )}
                    </div>
                  </div>

                  {seasonExpanded && (
                    <div
                      id={seasonPanelId}
                      data-season-episodes={group.seasonNumber}
                      className="divide-y divide-white/8"
                    >
                    {seasonPlayableEpisodes.length > 0 && (
                      <div
                        data-season-mobile-actions={group.seasonNumber}
                        className="flex flex-wrap items-center justify-end gap-2 bg-[#0d0f12]/30 px-4 py-2 sm:hidden"
                      >
                        {canDownloadSeason && (
                          <button
                            type="button"
                            data-season-download-mobile={group.seasonNumber}
                            disabled={seasonAllSavedOffline}
                            onClick={handleDownloadSeasonClick}
                            title={
                              seasonAllSavedOffline
                                ? `Todos os episódios de ${group.label} já estão salvos offline`
                                : seasonOfflineRemainingEps.length === 0 &&
                                    seasonOfflineActiveRecs.length > 0
                                  ? `Toque para cancelar os downloads em andamento/na fila de ${group.label}`
                                  : `Baixar todos os episódios disponíveis de ${group.label} para assistir offline`
                            }
                            className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium tabular-nums transition-colors disabled:cursor-default ${seasonDownloadClass}`}
                          >
                            {seasonAllSavedOffline ? (
                              <HardDrive className="h-3.5 w-3.5 shrink-0 text-emerald-300" />
                            ) : seasonOfflineRemainingEps.length === 0 &&
                              seasonOfflineActiveRecs.length > 0 ? (
                              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                            ) : (
                              <Download className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                            )}
                            <span>{seasonDownloadLabel}</span>
                            {seasonOfflineRemainingEps.length === 0 &&
                              seasonOfflineActiveRecs.length > 0 && (
                                <X className="h-3 w-3 shrink-0 opacity-80" />
                              )}
                          </button>
                        )}
                        <button
                          type="button"
                          data-season-mark-mobile={group.seasonNumber}
                          onClick={() =>
                            onToggleEpisodesWatched(
                              seasonPlayableEpisodes,
                              !seasonAllWatched,
                              seasonAllWatched
                                ? `${group.label} desmarcada`
                                : `${group.label} marcada como vista`
                            )
                          }
                          aria-pressed={seasonAllWatched}
                          className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors ${
                            seasonAllWatched
                              ? 'border-emerald-500/45 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/20'
                              : 'border-white/12 bg-[#151921] text-slate-200 hover:border-emerald-500/50 hover:text-white'
                          }`}
                        >
                          <CheckCheck className="h-3.5 w-3.5" />
                          <span>
                            {seasonAllWatched
                              ? isMovie
                                ? 'Visto'
                                : 'Temporada vista'
                              : isMovie
                                ? 'Marcar como visto'
                                : 'Marcar temporada como vista'}
                          </span>
                        </button>
                      </div>
                    )}
                    {group.episodes.map((ep) => {
                      const available = isEpisodeAvailableOnServer(ep);
                      const formattedDate = formatEpisodeReleaseDate(
                        ep.date,
                        ep.airingAt,
                        ep.hasExactAiringTime
                      );
                      const epBadge = formatEpisodeCardBadge(ep, isMovie);
                      const hydratedTitle = ep.tvdbEpisodeId
                        ? hydratedTitlesById[ep.tvdbEpisodeId]
                        : undefined;
                      const epTitleLoading = isEpisodeTitleLoading(ep);
                      const epDisplayTitle = hydratedTitle || formatEpisodeCardTitle(ep, isMovie);
                      const uncensored = isEpisodeUncensored(ep);
                      const finaleBadge = !isMovie ? formatEpisodeFinaleBadge(ep.finaleType) : null;

                      if (!available) {
                        const countdown = formatEpisodeCountdown(ep.airingAt, nowMs, ep.date);
                        const isMissingDubOnly =
                          hasBothAudioTracks &&
                          activeAudioTab === 'DUB' &&
                          countdown.state === 'pending' &&
                          ep.episodeNumber !== null &&
                          legPlayableKeys.has(`${ep.seasonNumber || 1}:${ep.episodeNumber}`);
                        const badgeLabel = isMissingDubOnly ? 'Sem dublagem' : countdown.label;
                        const badgeTitle = isMissingDubOnly
                          ? 'Ainda sem dublagem; disponível na aba Legendado.'
                          : countdown.state === 'pending'
                            ? 'Episódio já exibido, mas ainda não publicado nos provedores.'
                            : undefined;

                        return (
                          <div
                            key={`${ep.url}-${ep.seasonNumber || 1}-${ep.episodeNumber || ep.numberLabel}`}
                            data-episode-unavailable="true"
                            className="bg-[#0d0f12]/35 px-3.5 py-3 sm:px-4"
                          >
                            <div className="flex items-start gap-3 sm:gap-4">
                              {ep.thumb || ep.fallbackThumb ? (
                                <MediaPoster
                                  src={ep.thumb}
                                  fallbackSrc={ep.fallbackThumb}
                                  alt={epDisplayTitle}
                                  aspect="landscape"
                                  className="mt-0.5 h-[54px] w-[96px] shrink-0 rounded-md border border-white/10 opacity-60 sm:h-16 sm:w-28"
                                />
                              ) : null}

                              <div className="min-w-0 flex-1">
                                <div className="flex items-center justify-between gap-2">
                                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                                    <span className="font-mono text-[11px] font-semibold tabular-nums text-slate-400 sm:text-xs">
                                      {epBadge}
                                    </span>
                                    {uncensored && (
                                      <span
                                        data-episode-uncensored="true"
                                        className="inline-flex shrink-0 items-center rounded border border-rose-500/40 bg-rose-500/15 px-1.5 py-[1px] text-[10px] font-semibold leading-tight text-rose-300"
                                      >
                                        Sem censura
                                      </span>
                                    )}
                                    {finaleBadge && (
                                      <span
                                        data-episode-finale={ep.finaleType}
                                        className="inline-flex shrink-0 items-center rounded border border-amber-500/40 bg-amber-500/15 px-1.5 py-[1px] text-[10px] font-semibold leading-tight text-amber-300"
                                      >
                                        {finaleBadge}
                                      </span>
                                    )}
                                  </div>

                                  <span
                                    title={badgeTitle}
                                    className={`inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-bold leading-tight tabular-nums shadow-sm shadow-black/60 backdrop-blur-md ${
                                      countdown.state === 'now'
                                        ? 'border-emerald-400/80 bg-[#052e22]/92 text-emerald-100'
                                        : countdown.state === 'future'
                                          ? 'border-[#f97316]/85 bg-[#1b0e05]/92 text-[#ffedd5]'
                                          : countdown.state === 'pending'
                                            ? 'border-white/20 bg-[#0d0f12]/92 text-slate-300'
                                            : 'border-white/20 bg-[#0d0f12]/90 text-slate-300'
                                    }`}
                                  >
                                    {countdown.state === 'pending' ? (
                                      <CloudOff className="h-3 w-3 shrink-0 text-slate-400" />
                                    ) : (
                                      <Clock
                                        className={`h-3 w-3 shrink-0 ${
                                          countdown.state === 'now'
                                            ? 'text-emerald-300'
                                            : countdown.state === 'future'
                                              ? 'text-[#f97316]'
                                              : 'text-slate-400'
                                        }`}
                                      />
                                    )}
                                    <span>{badgeLabel}</span>
                                  </span>
                                </div>

                                {epTitleLoading ? (
                                  <div
                                    data-episode-title-loading="true"
                                    className="mt-1.5 space-y-1.5"
                                    aria-label="Carregando título do episódio"
                                  >
                                    <div className="h-3.5 w-3/4 animate-pulse rounded bg-white/10" />
                                    <div className="h-3 w-1/2 animate-pulse rounded bg-white/8" />
                                  </div>
                                ) : (
                                  <div
                                    data-episode-title="true"
                                    className="mt-1 line-clamp-2 text-[13.5px] font-medium leading-snug text-slate-300 sm:text-sm"
                                  >
                                    {epDisplayTitle}
                                  </div>
                                )}

                                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] tabular-nums text-slate-400 sm:text-xs">
                                  <span className="inline-flex items-center gap-1">
                                    <Calendar className="h-3 w-3 shrink-0 text-slate-500" />
                                    <span>{formattedDate || 'Data ainda não confirmada'}</span>
                                  </span>
                                  {ep.durationMinutes && (
                                    <span className="text-slate-500">{ep.durationMinutes} min</span>
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      }

                      const epKey = canonicalEpisodeProgressKey(ep.url);
                      const epProgress = epKey ? progressMap?.[epKey] : undefined;
                      const resumeSec = getResumePositionSec(epProgress);
                      const progressPct =
                        resumeSec >= 2 && epProgress && epProgress.durationSec > 0
                          ? Math.min(
                              96,
                              Math.max(4, Math.round((resumeSec / epProgress.durationSec) * 100))
                            )
                          : 0;
                      const watched = isWatchedEpisode(ep);
                      const epSeed = buildSeedFromAnimeEpisode(anime, ep, activeEpisodes);
                      const epOffline = offlineDownloadsByKey?.get(
                        canonicalOfflineEpisodeUrl(ep.url)
                      );
                      return (
                        <div
                          key={ep.url}
                          data-episode-card="true"
                          className="group px-3.5 py-3 transition-colors hover:bg-white/5 sm:px-4"
                        >
                          <div className="flex items-start gap-3 sm:gap-4">
                            {ep.thumb ? (
                              <button
                                type="button"
                                onMouseEnter={() => scheduleEpisodeHoverPrefetch(ep.url, epSeed)}
                                onMouseLeave={cancelEpisodeHoverPrefetch}
                                onFocus={() => triggerImmediateEpisodePrefetch(ep.url, epSeed)}
                                onTouchStart={() => triggerImmediateEpisodePrefetch(ep.url, epSeed)}
                                onClick={() => onOpenEpisode(ep.url, epSeed)}
                                aria-label={`Assistir ${epBadge}: ${epDisplayTitle}`}
                                className="relative mt-0.5 h-[54px] w-[96px] shrink-0 overflow-hidden rounded-md border border-white/10 sm:h-16 sm:w-28"
                              >
                                <MediaPoster
                                  src={ep.thumb}
                                  fallbackSrc={ep.fallbackThumb}
                                  alt={epDisplayTitle}
                                  aspect="landscape"
                                  className="h-full w-full"
                                />
                                <span
                                  aria-hidden="true"
                                  className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/20 transition-colors group-hover:bg-black/35"
                                >
                                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-black/65 text-[#f97316] ring-1 ring-white/20 transition-transform group-hover:scale-110 sm:h-7 sm:w-7">
                                    <Play className="h-3 w-3 translate-x-[0.5px] fill-current sm:h-3.5 sm:w-3.5" />
                                  </span>
                                </span>
                                {progressPct > 0 && (
                                  <span
                                    aria-hidden="true"
                                    className="pointer-events-none absolute inset-x-0 bottom-0 h-1 bg-black/60"
                                  >
                                    <span
                                      className="block h-full bg-[#f97316]"
                                      style={{ width: `${progressPct}%` }}
                                    />
                                  </span>
                                )}
                              </button>
                            ) : null}

                            <div className="min-w-0 flex-1">
                              <button
                                type="button"
                                onMouseEnter={() => scheduleEpisodeHoverPrefetch(ep.url, epSeed)}
                                onMouseLeave={cancelEpisodeHoverPrefetch}
                                onFocus={() => triggerImmediateEpisodePrefetch(ep.url, epSeed)}
                                onTouchStart={() => triggerImmediateEpisodePrefetch(ep.url, epSeed)}
                                onClick={() => onOpenEpisode(ep.url, epSeed)}
                                className="block w-full text-left"
                              >
                                <div className="flex flex-wrap items-center gap-1.5">
                                  {!ep.thumb && (
                                    <Play className="h-3 w-3 shrink-0 fill-current text-[#f97316]" />
                                  )}
                                  <span className="font-mono text-[11px] font-semibold tabular-nums text-[#fb923c] sm:text-xs">
                                    {epBadge}
                                  </span>
                                  {uncensored && (
                                    <span
                                      data-episode-uncensored="true"
                                      className="inline-flex shrink-0 items-center rounded border border-rose-500/40 bg-rose-500/15 px-1.5 py-[1px] text-[10px] font-semibold leading-tight text-rose-300"
                                    >
                                      Sem censura
                                    </span>
                                  )}
                                  {finaleBadge && (
                                    <span
                                      data-episode-finale={ep.finaleType}
                                      className="inline-flex shrink-0 items-center rounded border border-amber-500/40 bg-amber-500/15 px-1.5 py-[1px] text-[10px] font-semibold leading-tight text-amber-300"
                                    >
                                      {finaleBadge}
                                    </span>
                                  )}
                                  {epOffline?.status === 'completed' && (
                                    <span
                                      data-episode-offline-badge="true"
                                      className="inline-flex shrink-0 items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/15 px-1.5 py-[1px] text-[10px] font-semibold leading-tight text-emerald-300"
                                    >
                                      <HardDrive className="h-2.5 w-2.5 shrink-0" />
                                      <span>Offline</span>
                                    </span>
                                  )}
                                </div>

                                {epTitleLoading ? (
                                  <div
                                    data-episode-title-loading="true"
                                    className="mt-1 space-y-1.5"
                                    aria-label="Carregando título do episódio"
                                  >
                                    <div className="h-3.5 w-5/6 animate-pulse rounded bg-white/10" />
                                    <div className="h-3 w-1/2 animate-pulse rounded bg-white/8" />
                                  </div>
                                ) : (
                                  <div
                                    data-episode-title="true"
                                    className="mt-0.5 line-clamp-2 text-[13.5px] font-medium leading-snug text-white transition-colors group-hover:text-[#f97316] sm:text-sm"
                                  >
                                    {epDisplayTitle}
                                  </div>
                                )}
                              </button>

                              <div className="mt-1.5 flex items-center justify-between gap-2">
                                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] tabular-nums text-slate-500 sm:text-xs">
                                  {formattedDate && <span>{formattedDate}</span>}
                                  {ep.durationMinutes && <span>{ep.durationMinutes} min</span>}
                                  {ep.rating && (
                                    <span className="text-amber-400/90">★ {ep.rating}</span>
                                  )}
                                  {resumeSec >= 2 && (
                                    <span className="font-medium text-[#fb923c]">
                                      Parou em {formatPlaybackTimestamp(resumeSec)}
                                    </span>
                                  )}
                                </div>

                                <div className="flex shrink-0 items-center gap-1.5">
                                  {onStartOfflineDownload && (() => {
                                    const dlStatus = epOffline?.status;
                                    const isQueued = dlStatus === 'queued';
                                    const isBusy =
                                      dlStatus === 'resolving' || dlStatus === 'downloading';
                                    const isSaved = dlStatus === 'completed';
                                    const isError = dlStatus === 'error';

                                    if (isQueued && epOffline) {
                                      return (
                                        <button
                                          type="button"
                                          data-episode-download-btn="true"
                                          data-episode-download-queued="true"
                                          onClick={() => void onCancelOfflineDownload?.(epOffline.id)}
                                          aria-label={`Remover ${epBadge} da fila de downloads`}
                                          title={
                                            epOffline.queuePosition
                                              ? `Na fila (#${epOffline.queuePosition}) · Toque para remover da fila`
                                              : 'Na fila de downloads · Toque para cancelar'
                                          }
                                          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-amber-400/40 bg-amber-500/12 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-amber-300 transition-colors hover:bg-amber-500/20 sm:px-2.5 sm:py-1 sm:text-xs"
                                        >
                                          <Clock className="h-3 w-3 shrink-0 sm:h-3.5 sm:w-3.5" />
                                          <span>
                                            {epOffline.queuePosition
                                              ? `Fila #${epOffline.queuePosition}`
                                              : 'Na fila'}
                                          </span>
                                          <X className="h-3 w-3 shrink-0 opacity-80" />
                                        </button>
                                      );
                                    }

                                    if (isBusy && epOffline) {
                                      return (
                                        <button
                                          type="button"
                                          data-episode-download-btn="true"
                                          onClick={() => void onCancelOfflineDownload?.(epOffline.id)}
                                          aria-label={`Cancelar download de ${epBadge}`}
                                          title="Toque para cancelar o download"
                                          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[#f97316]/50 bg-[#f97316]/15 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-[#fb923c] transition-colors hover:bg-[#f97316]/25 sm:px-2.5 sm:py-1 sm:text-xs"
                                        >
                                          <Loader2 className="h-3 w-3 shrink-0 animate-spin sm:h-3.5 sm:w-3.5" />
                                          <span>
                                            {dlStatus === 'resolving'
                                              ? '...'
                                              : `${epOffline.progress}%`}
                                          </span>
                                          <X className="h-3 w-3 shrink-0 opacity-80" />
                                        </button>
                                      );
                                    }

                                    if (isSaved && epOffline) {
                                      const confirming = confirmDeleteOfflineId === epOffline.id;
                                      return (
                                        <div
                                          data-episode-download-btn="true"
                                          className="inline-flex shrink-0 items-center overflow-hidden rounded-md border border-emerald-500/45 bg-emerald-500/15 text-[11px] font-medium text-emerald-300 sm:text-xs"
                                        >
                                          <button
                                            type="button"
                                            onClick={() => onOpenEpisode(ep.url, epSeed)}
                                            aria-label={`Assistir ${epBadge} offline`}
                                            title={
                                              epOffline.sizeBytes > 0
                                                ? `Salvo offline (${formatBytes(epOffline.sizeBytes)}) · Toque para assistir`
                                                : 'Salvo offline · Toque para assistir'
                                            }
                                            className="inline-flex items-center gap-1 px-2 py-0.5 transition-colors hover:bg-emerald-500/20 sm:px-2.5 sm:py-1"
                                          >
                                            <HardDrive className="h-3 w-3 shrink-0 sm:h-3.5 sm:w-3.5" />
                                            <span>Salvo</span>
                                          </button>
                                          {onDeleteOfflineDownload && (
                                            <button
                                              type="button"
                                              onClick={() => {
                                                if (confirming) {
                                                  setConfirmDeleteOfflineId('');
                                                  void onDeleteOfflineDownload(epOffline.id);
                                                } else {
                                                  setConfirmDeleteOfflineId(epOffline.id);
                                                }
                                              }}
                                              aria-label={
                                                confirming
                                                  ? `Confirmar exclusão do vídeo salvo de ${epBadge}`
                                                  : `Apagar vídeo salvo de ${epBadge}`
                                              }
                                              title={
                                                confirming
                                                  ? 'Toque novamente para apagar'
                                                  : epOffline.sizeBytes > 0
                                                    ? `Apagar vídeo salvo (${formatBytes(epOffline.sizeBytes)})`
                                                    : 'Apagar vídeo salvo'
                                              }
                                              className={`inline-flex items-center gap-1 border-l px-1.5 py-0.5 transition-colors sm:px-2 sm:py-1 ${
                                                confirming
                                                  ? 'border-rose-500/45 bg-rose-500/25 text-rose-200 hover:bg-rose-500/35'
                                                  : 'border-emerald-500/30 text-emerald-200/80 hover:bg-rose-500/20 hover:text-rose-200'
                                              }`}
                                            >
                                              <Trash2 className="h-3 w-3 shrink-0" />
                                              {confirming && <span>Apagar?</span>}
                                            </button>
                                          )}
                                        </div>
                                      );
                                    }

                                    return (
                                      <button
                                        type="button"
                                        data-episode-download-btn="true"
                                        onClick={() =>
                                          void onStartOfflineDownload({
                                            episodeUrl: ep.url,
                                            title: epDisplayTitle,
                                            seriesTitle: anime.title,
                                            seriesUrl: anime.url,
                                            episodeLabel: epBadge,
                                            poster: ep.thumb || anime.backdrop || anime.poster,
                                            isMovie,
                                            seasonNumber: ep.seasonNumber,
                                            episodeNumber: ep.episodeNumber ?? undefined,
                                            prevUrl: epSeed.prevUrl,
                                            nextUrl: epSeed.nextUrl,
                                          })
                                        }
                                        aria-label={
                                          isError
                                            ? `Tentar baixar ${epBadge} novamente`
                                            : `Baixar ${epBadge} para assistir offline`
                                        }
                                        title={
                                          isError
                                            ? epOffline?.errorMessage ||
                                              'Falha no download. Toque para tentar novamente.'
                                            : 'Baixar vídeo para assistir sem internet'
                                        }
                                        className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors sm:px-2.5 sm:py-1 sm:text-xs ${
                                          isError
                                            ? 'border-amber-500/45 bg-amber-500/12 text-amber-200 hover:bg-amber-500/20'
                                            : 'border-white/12 bg-[#0d0f12] text-slate-300 hover:border-emerald-500/50 hover:text-white'
                                        }`}
                                      >
                                        <Download className="h-3 w-3 shrink-0 text-emerald-400 sm:h-3.5 sm:w-3.5" />
                                        <span>{isError ? 'Tentar' : 'Baixar'}</span>
                                      </button>
                                    );
                                  })()}

                                  <button
                                    type="button"
                                    onClick={() => onToggleEpisodesWatched([ep], !watched)}
                                    aria-pressed={watched}
                                    aria-label={
                                      watched
                                        ? `Desmarcar ${epBadge} como visto`
                                        : `Marcar ${epBadge} como visto`
                                    }
                                    className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors sm:px-2.5 sm:py-1 sm:text-xs ${
                                      watched
                                        ? 'border-emerald-500/45 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/20'
                                        : 'border-white/12 bg-[#0d0f12] text-slate-400 hover:border-emerald-500/50 hover:text-white'
                                    }`}
                                  >
                                    <Check className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
                                    <span>Visto</span>
                                  </button>
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
