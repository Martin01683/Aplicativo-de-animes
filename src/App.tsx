import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ArrowLeft, Trash2, WifiOff } from 'lucide-react';
import { ActiveCastBar } from './components/ActiveCastBar';
import type { AnimeDetailLoadingStage } from './components/AnimeDetailView';
import { CatalogView } from './components/CatalogView';
import { Header, type NavSection } from './components/Header';
import { MobileTabBar } from './components/MobileTabBar';
import { NotificationToastStack } from './components/NotificationToastStack';
import { TvCastModal } from './components/TvCastModal';

const loadAnimeDetailView = () =>
  import('./components/AnimeDetailView').then((m) => ({ default: m.AnimeDetailView }));
const loadEpisodeWorkspace = () =>
  import('./components/EpisodeWorkspace').then((m) => ({ default: m.EpisodeWorkspace }));
const loadSettingsModal = () =>
  import('./components/SettingsModal').then((m) => ({ default: m.SettingsModal }));

const AnimeDetailView = lazy(loadAnimeDetailView);
const EpisodeWorkspace = lazy(loadEpisodeWorkspace);
const SettingsModal = lazy(loadSettingsModal);
import { useOnlineStatus } from './hooks/useOnlineStatus';
import {
  usePageImagesPending,
  useSettledLoadingIndicator,
} from './hooks/usePageImagesPending';
import {
  addApkDownloadProgressListener,
  apiFetch,
  cancelAppUpdateDownload,
  consumePendingNotificationTarget,
  downloadAppUpdateApk,
  exportBackupJsonFile,
  getDeviceNotificationPermission,
  getNativeAppBuildInfo,
  isNativeAndroidApp,
  requestDeviceNotificationPermission,
  showNativeLocalNotification,
  type ApkDownloadProgressEvent,
} from './lib/apiClient';
import {
  buildReleaseIdentityKey,
  evaluateUpdateStatus,
  getAppBuildInfo,
  reduceApkDownloadProgress,
  type AppBuildInfo,
  type AppUpdateCheckResult,
  type RemoteAppRelease,
} from './lib/appUpdater';
import {
  buildAnisyncBackupPayload,
  buildBackupFilename,
  mergeAnisyncBackupData,
  serializeAnisyncBackup,
  type AnisyncBackupPayload,
  type BackupImportMode,
} from './lib/backup';
import { inferMediaKindFromTarget, isAnisyncUri, parseAnisyncUri } from './lib/catalog/idCodec';
import {
  advanceBaselineWithWatchedEpisodes,
  buildFavoriteBaseline,
  canonicalEpisodeKey,
  detectNewFavoriteEpisodes,
  findMatchingFavorite,
  isItemFavorited,
  normalizeTopAnimesUrl,
  toSeriesFavoriteItem,
} from './lib/favoriteAlerts';
import {
  consumeNativeVlcPendingSession,
  isSameEpisodeUrl,
  resolveSeriesEpisodesForEpisode,
  setNativeVlcVideoScale,
  type NativeVlcPlayResult,
} from './lib/nativeVlcPlayer';
import {
  clearReadFavoriteAlerts,
  dismissSingleAlert,
  dismissToastItem,
  enqueueToastItem,
  isFavoriteMuted,
  isWithinQuietHours,
  markSingleAlertRead,
  playNotificationChime,
  pruneAlertsForRemovedFavorite,
  removeFavoriteMutedUrl,
  shouldRunCatchUpEpisodeCheck,
  syncAppBadge,
  toggleFavoriteMutedUrl,
  type AppNotificationToast,
  type NotificationPermissionStatus,
  type ToastKind,
} from './lib/notifications';
import {
  canonicalEpisodeProgressKey,
  countAnimeEpisodesInHistory,
  getHistoryEntrySeriesName,
  sanitizeVideoScaleMode,
  type EpisodeProgressMap,
} from './lib/playbackProgress';
import {
  pushRouteFrame,
  resolveBackNavigationStep,
  type AppRouteFrame,
} from './lib/navigationHistory';
import { isActivePageLoading } from './lib/pageLoadingState';
import {
  buildOptimisticEpisodeDetails,
  canBackgroundPrefetch,
  clearPrefetchCaches,
  deleteCachedEpisodeDetails,
  fetchAnimeDetailsFull,
  fetchAnimeDetailsQuick,
  fetchArchivePageCached,
  fetchCalendarCached,
  fetchEpisodeDetailsFast,
  fetchFilteredCatalogCached,
  fetchGlossaryCached,
  fetchReleasesPageCached,
  fetchSearchPageCached,
  getCachedAnimeDetailsFull,
  getCachedEpisodeDetails,
  isSwrDataFresh,
  loadPersistedSwrSnapshot,
  persistSwrHome,
  prefetchAnimeTarget,
  prefetchArchiveCategoryTarget,
  prefetchCalendarTarget,
  prefetchEpisodeTarget,
  prefetchReleasesPageTarget,
  preloadAllRouteChunks,
  preloadRouteChunk,
  registerRouteChunkPreloaders,
  scheduleBackgroundPrefetch,
  setCachedEpisodeDetails,
  type MediaNavigationSeed,
} from './lib/prefetchCache';
import {
  DEFAULT_APP_SETTINGS,
  getEpisodeCheckIntervalMs,
  shouldRunScheduledAppUpdateCheck,
  type AppSettings,
  type AppSettingsMeta,
} from './lib/settings';
import {
  addTvCastStateListener,
  getNativeTvCastState,
  IDLE_TV_CAST_STATE,
  type TvCastMediaPayload,
  type TvCastStateSnapshot,
} from './lib/tvCast';
import {
  clearAllEpisodeProgress,
  clearFavoriteAlerts,
  clearHistory,
  collectUserBackupData,
  loadAcknowledgedReleaseKey,
  loadActiveRouteSession,
  loadAppSettings,
  loadAppSettingsMeta,
  loadEpisodeProgressMap,
  loadFavoriteAlerts,
  loadFavoriteBaselines,
  loadFavorites,
  loadHistory,
  loadMutedFavoriteUrls,
  persistUserBackupData,
  pushHistoryEntry,
  removeHistoryAnime,
  removeHistoryEpisode,
  saveAcknowledgedReleaseKey,
  saveActiveRouteSession,
  saveAppSettings,
  saveAppSettingsMeta,
  saveEpisodeProgress,
  saveFavoriteAlerts,
  saveFavoriteBaselines,
  saveFavorites,
  saveMutedFavoriteUrls,
  setEpisodesWatched,
} from './lib/storage';
import type {
  AnimeDetails,
  CalendarDaySection,
  CalendarLayout,
  CatalogArchiveCategory,
  CatalogFilters,
  CatalogMediaItem,
  EpisodeDetails,
  FavoriteAlertEntry,
  FavoriteBaselineMap,
  FavoriteLatestInfo,
  HomeCatalog,
  LiveChartScheduleMode,
  MediaKind,
  SearchResultItem,
  SliderMovieItem,
  WatchHistoryEntry,
} from './lib/types';

registerRouteChunkPreloaders({
  anime: loadAnimeDetailView,
  episode: loadEpisodeWorkspace,
  settings: loadSettingsModal,
});

type ActiveRoute = AppRouteFrame;

declare global {
  interface Window {
    __topAnimesHandleAndroidBack?: () => boolean;
    __anisyncOpenNotificationTarget?: (url: string, kind?: string) => void;
  }
}

interface ArchiveCategoryBucket {
  items: CatalogMediaItem[];
  currentPage: number;
  totalPages: number;
  loading: boolean;
  initialized: boolean;
}

const EMPTY_BUCKET: ArchiveCategoryBucket = {
  items: [],
  currentPage: 1,
  totalPages: 1,
  loading: false,
  initialized: false,
};

function dedupeMediaItems(list: CatalogMediaItem[]): CatalogMediaItem[] {
  const seen = new Set<string>();
  const out: CatalogMediaItem[] = [];
  for (const item of list) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    out.push(item);
  }
  return out;
}

function dedupeSearchItems(list: SearchResultItem[]): SearchResultItem[] {
  const seen = new Set<string>();
  const out: SearchResultItem[] = [];
  for (const item of list) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    out.push(item);
  }
  return out;
}

function RouteSuspenseFallback({
  onPendingChange,
  children,
}: {
  onPendingChange: (pending: boolean) => void;
  children: ReactNode;
}) {
  useLayoutEffect(() => {
    onPendingChange(true);
    return () => onPendingChange(false);
  }, [onPendingChange]);
  return <>{children}</>;
}

export default function App() {
  const isOnline = useOnlineStatus();
  const initialSwr = useMemo(() => loadPersistedSwrSnapshot(), []);
  const [settings, setSettings] = useState<AppSettings>(() => loadAppSettings());
  const [settingsMeta, setSettingsMeta] = useState<AppSettingsMeta>(() => loadAppSettingsMeta());
  const [acknowledgedReleaseKey, setAcknowledgedReleaseKey] = useState<string | null>(() =>
    loadAcknowledgedReleaseKey()
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsFocusSection, setSettingsFocusSection] = useState<
    'sources' | 'catalog' | 'notifications' | 'updates' | 'general'
  >('general');
  const [tvCastState, setTvCastState] = useState<TvCastStateSnapshot>(() => ({
    ...IDLE_TV_CAST_STATE,
  }));
  const [tvCastModalOpen, setTvCastModalOpen] = useState(false);
  const [tvCastMediaPayload, setTvCastMediaPayload] = useState<TvCastMediaPayload | null>(null);
  const tvCastModalOpenRef = useRef(false);
  tvCastModalOpenRef.current = tvCastModalOpen;
  const [tvCastWebHelpers, setTvCastWebHelpers] = useState<{
    pauseLocal?: () => void;
    canPromptWebRemote?: boolean;
    promptWebRemote?: () => Promise<void>;
  }>({});
  const lastCastSyncedRef = useRef<{ url: string; sec: number; completed: boolean }>({
    url: '',
    sec: 0,
    completed: false,
  });

  const initialRouteSession = useMemo(() => loadActiveRouteSession(), []);
  const [routeStack, setRouteStack] = useState<ActiveRoute[]>(() =>
    initialRouteSession.routeStack.length > 0
      ? initialRouteSession.routeStack
      : [{ view: 'catalog' }]
  );
  const route = routeStack[routeStack.length - 1] ?? { view: 'catalog' };
  const [activeSection, setActiveSection] = useState<NavSection>(() =>
    initialRouteSession.routeStack.length > 1
      ? initialRouteSession.activeSection
      : loadAppSettings().defaultSection
  );

  const [catalog, setCatalog] = useState<HomeCatalog | null>(() => initialSwr?.home?.data ?? null);
  const [loadingCatalog, setLoadingCatalog] = useState(() => !initialSwr?.home?.data);
  const [catalogError, setCatalogError] = useState('');

  const [releases, setReleases] = useState<CatalogMediaItem[]>(
    () => initialSwr?.releases?.items ?? initialSwr?.home?.data.releases ?? []
  );
  const [releasesPage, setReleasesPage] = useState(1);
  const [releasesTotalPages, setReleasesTotalPages] = useState(
    () => initialSwr?.releases?.totalPages ?? 1
  );
  const [loadingInitialReleases, setLoadingInitialReleases] = useState(true);
  const [loadingMoreReleases, setLoadingMoreReleases] = useState(false);

  const [archiveCategory, setArchiveCategory] = useState<CatalogArchiveCategory>('animes');
  const [archiveState, setArchiveState] = useState<
    Record<CatalogArchiveCategory, ArchiveCategoryBucket>
  >(() => {
    const buildInitialBucket = (
      category: CatalogArchiveCategory,
      homeFallback?: CatalogMediaItem[]
    ): ArchiveCategoryBucket => {
      const snap = initialSwr?.archive?.[category];
      if (snap && snap.items.length > 0) {
        return {
          items: snap.items,
          currentPage: snap.currentPage || 1,
          totalPages: snap.totalPages || 1,
          loading: false,
          initialized: isSwrDataFresh(snap.fetchedAtMs),
        };
      }
      if (homeFallback && homeFallback.length > 0) {
        return { ...EMPTY_BUCKET, items: homeFallback };
      }
      return { ...EMPTY_BUCKET };
    };
    return {
      animes: buildInitialBucket('animes', initialSwr?.home?.data.animes),
      movies: buildInitialBucket('movies', initialSwr?.home?.data.movies),
      series: buildInitialBucket('series', initialSwr?.home?.data.series),
      dublado: buildInitialBucket('dublado'),
      legendado: buildInitialBucket('legendado'),
      donghua: buildInitialBucket('donghua'),
      cartoon: buildInitialBucket('cartoon'),
      'live-action': buildInitialBucket('live-action'),
    };
  });
  const [featuredAnimes, setFeaturedAnimes] = useState<CatalogMediaItem[]>(
    () => initialSwr?.featuredAnimes ?? []
  );
  const [sliderMovies, setSliderMovies] = useState<SliderMovieItem[]>(
    () => initialSwr?.sliderMovies ?? []
  );
  const [catalogFilters, setCatalogFilters] = useState<CatalogFilters>(
    () =>
      initialSwr?.catalogFilters ?? {
        genres: [],
        years: [],
        types: [],
      }
  );
  const [selectedGenre, setSelectedGenre] = useState('');
  const [selectedYear, setSelectedYear] = useState('');
  const [selectedGlossary, setSelectedGlossary] = useState('');
  const [filteredCatalog, setFilteredCatalog] = useState<ArchiveCategoryBucket>({
    ...EMPTY_BUCKET,
  });

  const [weeklyCalendarDays, setWeeklyCalendarDays] = useState<CalendarDaySection[]>(() => {
    const mode = loadAppSettings().calendarScheduleMode;
    return initialSwr?.calendar?.[mode]?.days ?? [];
  });
  const [selectedCalendarDay, setSelectedCalendarDay] = useState('hoje');
  const [loadingWeeklyCalendar, setLoadingWeeklyCalendar] = useState(false);
  const [calendarError, setCalendarError] = useState('');
  const [weeklyCalendarInitialized, setWeeklyCalendarInitialized] = useState(() => {
    const mode = loadAppSettings().calendarScheduleMode;
    const snap = initialSwr?.calendar?.[mode];
    return Boolean(snap && snap.days.length > 0 && isSwrDataFresh(snap.fetchedAtMs));
  });

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResultItem[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchPage, setSearchPage] = useState(1);
  const [searchTotalPages, setSearchTotalPages] = useState(1);
  const [loadingMoreSearch, setLoadingMoreSearch] = useState(false);
  const [loadingRandom, setLoadingRandom] = useState(false);

  const [animeDetails, setAnimeDetails] = useState<AnimeDetails | null>(null);
  const [animeDetailStage, setAnimeDetailStage] = useState<AnimeDetailLoadingStage>('idle');
  const [episodeDetails, setEpisodeDetails] = useState<EpisodeDetails | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [routeChunkLoading, setRouteChunkLoading] = useState(false);
  const [animeViewHydrating, setAnimeViewHydrating] = useState(false);
  const [episodeViewLoading, setEpisodeViewLoading] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const [loadingExtraServers, setLoadingExtraServers] = useState<{
    episodeUrl: string;
    sourceNames: string[];
    gen: number;
  } | null>(null);
  const extraServersGenRef = useRef(0);
  const [detailError, setDetailError] = useState('');

  const [favorites, setFavorites] = useState<CatalogMediaItem[]>(() => loadFavorites());
  const [mutedFavoriteUrls, setMutedFavoriteUrls] = useState<string[]>(() =>
    loadMutedFavoriteUrls()
  );
  const [baselines, setBaselines] = useState<FavoriteBaselineMap>(() => loadFavoriteBaselines());
  const [alerts, setAlerts] = useState<FavoriteAlertEntry[]>(() => loadFavoriteAlerts());
  const [checkingAlerts, setCheckingAlerts] = useState(false);
  const [notificationPermission, setNotificationPermission] =
    useState<NotificationPermissionStatus>(() => {
      if (isNativeAndroidApp()) return 'default';
      if (typeof window !== 'undefined' && 'Notification' in window) {
        return Notification.permission;
      }
      return 'unsupported';
    });
  const [history, setHistory] = useState<WatchHistoryEntry[]>(() => loadHistory());
  const [pendingHistoryRemoval, setPendingHistoryRemoval] = useState<
    | { kind: 'all'; count: number }
    | { kind: 'anime'; entry: WatchHistoryEntry; animeName: string; count: number }
    | null
  >(null);
  const [progressMap, setProgressMap] = useState<EpisodeProgressMap>(() =>
    loadEpisodeProgressMap()
  );
  const [toasts, setToasts] = useState<AppNotificationToast[]>([]);
  const toastCounterRef = useRef(0);

  const [buildInfo, setBuildInfo] = useState<AppBuildInfo>(() => getAppBuildInfo());
  const [appUpdateResult, setAppUpdateResult] = useState<AppUpdateCheckResult | null>(null);
  const [checkingAppUpdate, setCheckingAppUpdate] = useState(false);
  const [appUpdateError, setAppUpdateError] = useState('');
  const [downloadingAppUpdate, setDownloadingAppUpdate] = useState(false);
  const [apkDownloadProgress, setApkDownloadProgress] = useState<ApkDownloadProgressEvent | null>(
    null
  );
  const [swUpdateAvailable, setSwUpdateAvailable] = useState(false);
  const waitingSwRef = useRef<ServiceWorker | null>(null);
  const pendingUpdateReleaseRef = useRef<RemoteAppRelease | null>(null);
  const apkUpdateRequestTokenRef = useRef(0);
  const apkInstalledClearTimerRef = useRef<number | null>(null);

  const catalogRef = useRef(catalog);
  const favoritesRef = useRef(favorites);
  const mutedFavoriteUrlsRef = useRef(mutedFavoriteUrls);
  const baselinesRef = useRef(baselines);
  const alertsRef = useRef(alerts);
  const checkingAlertsRef = useRef(checkingAlerts);
  const releasesRef = useRef(releases);
  const historyRef = useRef(history);
  const animeDetailsRef = useRef(animeDetails);
  const episodeDetailsRef = useRef(episodeDetails);
  const settingsRef = useRef(settings);
  const settingsMetaRef = useRef(settingsMeta);
  const buildInfoRef = useRef(buildInfo);
  const appUpdateResultRef = useRef(appUpdateResult);
  const acknowledgedReleaseKeyRef = useRef(acknowledgedReleaseKey);
  const routeRef = useRef(route);
  const routeStackRef = useRef(routeStack);
  const watchedEpisodeKeysRef = useRef<Set<string>>(new Set());
  const catalogScrollYRef = useRef(0);
  const prevRouteViewRef = useRef(route.view);
  const navRequestGenRef = useRef(0);
  const handlingPopstateRef = useRef(false);
  const initialCheckDoneRef = useRef(false);
  const initialRouteHydratedRef = useRef(false);
  const startupAppUpdateCheckedRef = useRef(false);
  const checkingAppUpdateRef = useRef(false);
  const autoDownloadTriggeredForRef = useRef<string | null>(null);
  const updateToastNotifiedForRef = useRef<string | null>(null);

  catalogRef.current = catalog;
  favoritesRef.current = favorites;
  mutedFavoriteUrlsRef.current = mutedFavoriteUrls;
  baselinesRef.current = baselines;
  alertsRef.current = alerts;
  checkingAlertsRef.current = checkingAlerts;
  releasesRef.current = releases;
  historyRef.current = history;
  animeDetailsRef.current = animeDetails;
  episodeDetailsRef.current = episodeDetails;
  settingsRef.current = settings;
  settingsMetaRef.current = settingsMeta;
  buildInfoRef.current = buildInfo;
  appUpdateResultRef.current = appUpdateResult;
  acknowledgedReleaseKeyRef.current = acknowledgedReleaseKey;
  routeRef.current = route;
  routeStackRef.current = routeStack;

  const activeRouteUrl = route.view === 'catalog' ? '' : route.url;

  // Preserve exact scroll position when leaving/returning to CatalogView (zero re-mount)
  useEffect(() => {
    const prevView = prevRouteViewRef.current;
    prevRouteViewRef.current = route.view;
    if (typeof window === 'undefined') return;
    if (route.view === 'catalog' && prevView !== 'catalog') {
      const targetY = catalogScrollYRef.current;
      window.requestAnimationFrame(() => {
        window.scrollTo(0, targetY);
      });
    } else if (route.view !== 'catalog') {
      window.scrollTo(0, 0);
    }
  }, [route.view, activeRouteUrl]);

  useEffect(() => {
    saveActiveRouteSession({ routeStack, activeSection });
  }, [routeStack, activeSection]);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => dismissToastItem(prev, id));
  }, []);

  const showToast = useCallback(
    (
      message: string,
      options?: {
        kind?: ToastKind;
        description?: string;
        poster?: string;
        actionLabel?: string;
        onAction?: () => void;
        durationMs?: number;
        dedupeKey?: string;
      }
    ) => {
      const id = `toast-${++toastCounterRef.current}-${Date.now()}`;
      const inferredKind: ToastKind =
        options?.kind ||
        (/falha|erro|não foi possível|bloquead/i.test(message)
          ? 'warning'
          : /ativad|adicionado|concluíd|restaurad|reativad/i.test(message)
            ? 'success'
            : 'info');
      const item: AppNotificationToast = {
        id,
        kind: inferredKind,
        title: message,
        description: options?.description,
        poster: options?.poster,
        actionLabel: options?.actionLabel,
        onAction: options?.onAction,
        durationMs: options?.durationMs ?? (options?.actionLabel ? 6500 : 3800),
        dedupeKey: options?.dedupeKey,
      };
      setToasts((prev) => enqueueToastItem(prev, item, 3));
    },
    []
  );

  const refreshProgressState = useCallback(() => {
    setProgressMap(loadEpisodeProgressMap());
    setHistory(loadHistory());
  }, []);

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    if (patch.videoScale) {
      void setNativeVlcVideoScale(sanitizeVideoScaleMode(patch.videoScale));
    }
    if (patch.episodeSources || patch.defaultAudioFilter) {
      clearPrefetchCaches('episodes');
    }
    if (patch.catalogCredentials || patch.episodeSources) {
      clearPrefetchCaches('catalog');
      setArchiveState((prev) => ({
        animes: { ...prev.animes, initialized: false },
        movies: { ...prev.movies, initialized: false },
        series: { ...prev.series, initialized: false },
        dublado: { ...prev.dublado, initialized: false },
        legendado: { ...prev.legendado, initialized: false },
        donghua: { ...prev.donghua, initialized: false },
        cartoon: { ...prev.cartoon, initialized: false },
        'live-action': { ...prev['live-action'], initialized: false },
      }));
    }
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveAppSettings(next);
      return next;
    });
  }, []);

  const resetSettings = useCallback(() => {
    const defaults = { ...DEFAULT_APP_SETTINGS };
    clearPrefetchCaches('all');
    setSettings(defaults);
    saveAppSettings(defaults);
    void setNativeVlcVideoScale(defaults.videoScale);
    showToast('Configurações restauradas para o padrão.');
  }, [showToast]);

  const handleExportBackup = useCallback(async () => {
    try {
      const data = collectUserBackupData();
      const payload = buildAnisyncBackupPayload(data, {
        appVersion: buildInfo.androidVersionName || buildInfo.version,
      });
      const filename = buildBackupFilename();
      const res = await exportBackupJsonFile(filename, serializeAnisyncBackup(payload));
      showToast(res.message);
    } catch {
      showToast('Não foi possível exportar o backup.');
    }
  }, [buildInfo.androidVersionName, buildInfo.version, showToast]);

  const handleImportBackup = useCallback(
    (payload: AnisyncBackupPayload, mode: BackupImportMode) => {
      const current = collectUserBackupData();
      const nextData = mergeAnisyncBackupData(current, payload.data, mode);
      const persisted = persistUserBackupData(nextData);
      clearPrefetchCaches('catalog');
      setFavorites(persisted.favorites);
      setHistory(persisted.history);
      setProgressMap(persisted.progressMap);
      setMutedFavoriteUrls(persisted.mutedFavoriteUrls);
      setSettings(persisted.settings);
      void setNativeVlcVideoScale(persisted.settings.videoScale);
      showToast(
        mode === 'replace'
          ? `Backup restaurado (${persisted.favorites.length} favoritos · ${persisted.history.length} no histórico).`
          : `Backup mesclado (${persisted.favorites.length} favoritos · ${persisted.history.length} no histórico).`
      );
    },
    [showToast]
  );

  const openNotificationTargetRef = useRef<(url: string, kind?: string) => void>(() => undefined);

  const deliverSystemNotification = useCallback(
    async (payload: {
      title: string;
      body: string;
      channel: 'episodes' | 'updates';
      tag: string;
      targetUrl?: string;
      targetKind?: string;
      bypassQuietHours?: boolean;
      bypassSetting?: boolean;
    }): Promise<boolean> => {
      if (!payload.bypassSetting && !settingsRef.current.notifyNewEpisodes) return false;
      if (!payload.bypassQuietHours && isWithinQuietHours(settingsRef.current)) return false;

      if (isNativeAndroidApp()) {
        const mediaKind: MediaKind | 'settings' | undefined =
          payload.targetKind === 'settings' ||
          payload.targetKind === 'episode' ||
          payload.targetKind === 'anime' ||
          payload.targetKind === 'movie' ||
          payload.targetKind === 'series'
            ? payload.targetKind
            : undefined;
        return showNativeLocalNotification({
          title: payload.title,
          body: payload.body,
          channelId: payload.channel === 'updates' ? 'anisync_updates' : 'anisync_episodes',
          targetUrl: payload.targetUrl || (mediaKind === 'settings' ? 'anisync://settings' : undefined),
          mediaKind,
        });
      }

      if (typeof window === 'undefined' || !('Notification' in window)) return false;
      if (Notification.permission !== 'granted') return false;

      try {
        const notification = new Notification(payload.title, {
          body: payload.body,
          icon: '/pwa-192x192.png',
          badge: '/pwa-192x192.png',
          tag: payload.tag,
        });
        notification.onclick = () => {
          window.focus();
          if (payload.targetUrl || payload.targetKind === 'settings') {
            openNotificationTargetRef.current(payload.targetUrl || '', payload.targetKind);
          }
          notification.close();
        };
        return true;
      } catch {
        // Fallback for mobile browsers that require ServiceWorkerRegistration.showNotification
        try {
          if ('serviceWorker' in navigator) {
            const reg = await navigator.serviceWorker.ready;
            if (reg && typeof reg.showNotification === 'function') {
              await reg.showNotification(payload.title, {
                body: payload.body,
                icon: '/pwa-192x192.png',
                badge: '/pwa-192x192.png',
                tag: payload.tag,
              });
              return true;
            }
          }
        } catch {
          // Ignore browser notification restrictions
        }
        return false;
      }
    },
    []
  );

  const dispatchDeviceNotifications = useCallback(
    async (newAlerts: FavoriteAlertEntry[]) => {
      if (!newAlerts.length) return;
      const first = newAlerts[0];
      const title =
        newAlerts.length === 1
          ? `Novo episódio: ${first.animeTitle}`
          : `${newAlerts.length} novos episódios dos favoritos`;
      const body =
        newAlerts.length === 1
          ? `${first.episodeLabel}${first.audioType ? ` (${first.audioType})` : ''} já está disponível para assistir.`
          : `${first.animeTitle} (${first.episodeLabel}) e mais ${newAlerts.length - 1} episódio(s).`;

      await deliverSystemNotification({
        title,
        body,
        channel: 'episodes',
        tag: `anisync-${first.id}`,
        targetUrl: first.episodeUrl,
        targetKind: 'episode',
      });
    },
    [deliverSystemNotification]
  );

  const checkFavoriteUpdates = useCallback(
    async (options: { manual?: boolean; currentReleases?: CatalogMediaItem[] } = {}) => {
      const currentFavs = favoritesRef.current;
      const currentReleases = options.currentReleases || releasesRef.current;
      if (!currentFavs.length) {
        if (options.manual) {
          showToast('Favorite um título primeiro para verificar novos episódios.');
        }
        return;
      }

      setCheckingAlerts(true);
      try {
        let latestByAnimeUrl: Record<string, FavoriteLatestInfo> = {};
        const seriesUrls = currentFavs
          .filter((f) => f.kind !== 'movie' && !/\/filmes\//i.test(f.url))
          .map((f) => f.url)
          .slice(0, 30);

        if (seriesUrls.length > 0 && navigator.onLine) {
          try {
            const res = await apiFetch('/api/favorites/check', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ urls: seriesUrls }),
            });
            if (res.ok) {
              const data = (await res.json()) as {
                latestByUrl?: Record<string, FavoriteLatestInfo>;
              };
              latestByAnimeUrl = data.latestByUrl || {};
            }
          } catch {
            // Fall back to checking against current releases feed
          }
        }

        const detection = detectNewFavoriteEpisodes({
          favorites: currentFavs,
          releases: currentReleases,
          baselines: baselinesRef.current,
          existingAlerts: alertsRef.current,
          latestByAnimeUrl,
          watchedEpisodeKeys: watchedEpisodeKeysRef.current,
          mutedFavoriteUrls: mutedFavoriteUrlsRef.current,
          notifyAudioFilter: settingsRef.current.notifyAudioFilter,
        });

        setBaselines(detection.nextBaselines);
        saveFavoriteBaselines(detection.nextBaselines);
        setAlerts(detection.nextAlerts);
        saveFavoriteAlerts(detection.nextAlerts);

        const checkedAt = new Date().toISOString();
        setSettingsMeta((prev) => {
          const next = { ...prev, lastEpisodeCheckAt: checkedAt };
          saveAppSettingsMeta(next);
          return next;
        });

        if (detection.newAlerts.length > 0) {
          const first = detection.newAlerts[0];
          const inQuietHours = isWithinQuietHours(settingsRef.current);

          if (settingsRef.current.showInAppEpisodeToasts) {
            showToast(
              detection.newAlerts.length === 1
                ? `Novo episódio: ${first.animeTitle}`
                : `${detection.newAlerts.length} novos episódios disponíveis`,
              {
                kind: 'episode',
                description:
                  detection.newAlerts.length === 1
                    ? `${first.episodeLabel}${first.audioType ? ` · ${first.audioType}` : ''} pronto para assistir`
                    : `${first.animeTitle} (${first.episodeLabel}) e mais ${detection.newAlerts.length - 1}`,
                poster: first.poster || undefined,
                actionLabel: detection.newAlerts.length === 1 ? 'Assistir' : 'Ver avisos',
                onAction: () => {
                  if (detection.newAlerts.length === 1) {
                    setAlerts((prev) => {
                      const next = markSingleAlertRead(prev, first.id);
                      saveFavoriteAlerts(next);
                      return next;
                    });
                    openNotificationTargetRef.current(first.episodeUrl, 'episode');
                  } else {
                    setActiveSection('library');
                    setRouteStack([{ view: 'catalog' }]);
                  }
                },
                dedupeKey: `episode-drop-${first.id}`,
                durationMs: 7000,
              }
            );
          }

          if (settingsRef.current.notificationSound && !inQuietHours) {
            playNotificationChime();
          }

          void dispatchDeviceNotifications(detection.newAlerts);
        } else if (options.manual) {
          showToast('Nenhum novo episódio encontrado agora.');
        }
      } finally {
        setCheckingAlerts(false);
      }
    },
    [dispatchDeviceNotifications, showToast]
  );

  const markReleaseAcknowledged = useCallback((targetRelease: RemoteAppRelease | null | undefined) => {
    if (!targetRelease) return;
    const key = buildReleaseIdentityKey(targetRelease);
    setAcknowledgedReleaseKey(key);
    saveAcknowledgedReleaseKey(key);
    setAppUpdateResult((prev) =>
      prev
        ? {
            ...prev,
            hasUpdate: false,
            reason: 'up-to-date',
          }
        : prev
    );
  }, []);

  const handleDismissApkProgress = useCallback(() => {
    if (apkInstalledClearTimerRef.current !== null) {
      window.clearTimeout(apkInstalledClearTimerRef.current);
      apkInstalledClearTimerRef.current = null;
    }
    setApkDownloadProgress(null);
  }, []);

  const handleCancelAppUpdate = useCallback(() => {
    apkUpdateRequestTokenRef.current += 1;
    pendingUpdateReleaseRef.current = null;
    if (apkInstalledClearTimerRef.current !== null) {
      window.clearTimeout(apkInstalledClearTimerRef.current);
      apkInstalledClearTimerRef.current = null;
    }
    setDownloadingAppUpdate(false);
    setApkDownloadProgress(null);
    showToast('Atualização cancelada.');
    void cancelAppUpdateDownload();
  }, [showToast]);

  const handleDownloadAppUpdate = useCallback(
    async (explicitRelease?: RemoteAppRelease | null) => {
      const targetRelease = explicitRelease || appUpdateResultRef.current?.latestRelease;
      const asset = targetRelease?.apkAsset;
      if (!asset?.downloadUrl) {
        showToast('Nenhum arquivo de atualização encontrado nesta release.');
        return;
      }
      const token = ++apkUpdateRequestTokenRef.current;
      if (apkInstalledClearTimerRef.current !== null) {
        window.clearTimeout(apkInstalledClearTimerRef.current);
        apkInstalledClearTimerRef.current = null;
      }
      pendingUpdateReleaseRef.current = targetRelease || null;
      setDownloadingAppUpdate(true);
      if (isNativeAndroidApp()) {
        setToasts([]);
      }
      setApkDownloadProgress(
        isNativeAndroidApp()
          ? { downloadedBytes: 0, totalBytes: asset.sizeBytes || 0, percent: 0, stage: 'downloading' }
          : null
      );
      try {
        const result = await downloadAppUpdateApk(
          asset.downloadUrl,
          asset.name || 'Anisync.apk',
          asset.digest
        );
        if (apkUpdateRequestTokenRef.current !== token) return;
        if (result.mode === 'cancelled') {
          setApkDownloadProgress(null);
          showToast(result.message || 'Atualização cancelada.');
          return;
        }
        if (result.mode === 'permission-required') {
          showToast(
            result.message ||
              "Ative 'Permitir desta fonte' nas configurações do Android e tente novamente."
          );
          setApkDownloadProgress(null);
          return;
        }
        if (result.mode === 'browser-download') {
          markReleaseAcknowledged(targetRelease);
          showToast(`Download iniciado: ${asset.name}`);
          return;
        }
        showToast('Verificação concluída — confirme a instalação no sistema Android.');
      } catch (err) {
        if (apkUpdateRequestTokenRef.current !== token) return;
        const msg = err instanceof Error ? err.message : 'Falha ao iniciar download da atualização.';
        const reduced = reduceApkDownloadProgress({
          downloadedBytes: 0,
          totalBytes: asset.sizeBytes || 0,
          percent: 0,
          stage: 'error',
          message: msg,
        });
        setApkDownloadProgress(reduced.progress);
        showToast(reduced.toastMessage || msg);
      } finally {
        if (apkUpdateRequestTokenRef.current === token) {
          setDownloadingAppUpdate(false);
        }
      }
    },
    [markReleaseAcknowledged, showToast]
  );

  const checkForAppUpdates = useCallback(
    async (options: { manual?: boolean; triggerAutoDownload?: boolean } = {}) => {
      if (checkingAppUpdateRef.current) return;
      checkingAppUpdateRef.current = true;
      setCheckingAppUpdate(true);
      setAppUpdateError('');
      try {
        const res = await apiFetch('/api/app-update/check');
        const data = (await res.json()) as {
          checkedAt?: string;
          release?: RemoteAppRelease | null;
          error?: string;
        };
        if (!res.ok) {
          throw new Error(data.error || 'Erro ao verificar atualizações no GitHub.');
        }

        const checkedAt = data.checkedAt || new Date().toISOString();
        const evaluated = evaluateUpdateStatus({
          currentBuild: buildInfoRef.current,
          remoteRelease: data.release || null,
          acknowledgedReleaseKey: acknowledgedReleaseKeyRef.current,
          checkedAt,
        });

        setAppUpdateResult(evaluated);
        setSettingsMeta((prev) => {
          const next = { ...prev, lastAppUpdateCheckAt: checkedAt };
          saveAppSettingsMeta(next);
          return next;
        });

        if (evaluated.hasUpdate && evaluated.latestRelease) {
          const key = buildReleaseIdentityKey(evaluated.latestRelease);
          if (
            options.triggerAutoDownload &&
            settingsRef.current.autoDownloadAppUpdates &&
            evaluated.latestRelease.apkAsset &&
            autoDownloadTriggeredForRef.current !== key
          ) {
            autoDownloadTriggeredForRef.current = key;
            void handleDownloadAppUpdate(evaluated.latestRelease);
          } else if (options.manual) {
            showToast(`Nova atualização encontrada: ${evaluated.latestRelease.releaseName}`, {
              kind: 'update',
              actionLabel: 'Ver',
              onAction: () => openNotificationTargetRef.current('', 'settings'),
              dedupeKey: `app-update-${key}`,
            });
          } else if (updateToastNotifiedForRef.current !== key) {
            updateToastNotifiedForRef.current = key;
            showToast('Nova versão do Anisync disponível', {
              kind: 'update',
              description: `${evaluated.latestRelease.releaseName || evaluated.latestRelease.tagName} pronta nas Configurações.`,
              actionLabel: 'Ver',
              onAction: () => openNotificationTargetRef.current('', 'settings'),
              dedupeKey: `app-update-${key}`,
            });
            void deliverSystemNotification({
              title: 'Nova versão do Anisync disponível',
              body: `${evaluated.latestRelease.releaseName || evaluated.latestRelease.tagName} pronta para instalar nas Configurações.`,
              channel: 'updates',
              tag: `anisync-update-${key}`,
              targetKind: 'settings',
            });
          }
        } else if (options.manual) {
          showToast('Você já está na versão mais recente.');
        }
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : 'Não foi possível verificar atualizações agora.';
        setAppUpdateError(msg);
        if (options.manual) {
          showToast(msg);
        }
      } finally {
        checkingAppUpdateRef.current = false;
        setCheckingAppUpdate(false);
      }
    },
    [deliverSystemNotification, handleDownloadAppUpdate, showToast]
  );

  const fetchCatalog = useCallback(async () => {
    setLoadingCatalog(true);
    setLoadingInitialReleases(true);
    setCatalogError('');
    // Fire /api/episodes?page=1 in parallel without blocking /api/home first paint
    const episodesPromise = fetchReleasesPageCached(1).catch(() => null);
    try {
      const homeRes = await apiFetch('/api/home');
      const data = await homeRes.json();
      if (!homeRes.ok) throw new Error(data.error || 'Erro ao carregar catálogo');
      const home = data as HomeCatalog;
      setCatalog(home);
      persistSwrHome(home);

      // Show home releases right away if no fuller page-1 list has arrived yet
      setReleases((prev) => (prev.length === 0 ? home.releases : prev));

      setArchiveState((prev) => ({
        ...prev,
        animes: prev.animes.initialized
          ? prev.animes
          : {
              ...prev.animes,
              items: prev.animes.items.length ? prev.animes.items : home.animes,
            },
        movies: prev.movies.initialized
          ? prev.movies
          : {
              ...prev.movies,
              items: prev.movies.items.length ? prev.movies.items : home.movies,
            },
        series: prev.series.initialized
          ? prev.series
          : {
              ...prev.series,
              items: prev.series.items.length ? prev.series.items : home.series || [],
            },
      }));

      setLoadingCatalog(false);

      const epData = await episodesPromise;
      const loadedReleases =
        epData && epData.items.length > 0 ? epData.items : home.releases;
      setReleases(loadedReleases);
      setReleasesPage(epData?.currentPage || 1);
      setReleasesTotalPages(epData?.totalPages || 1);

      if (
        !initialCheckDoneRef.current &&
        settingsRef.current.checkEpisodesOnStartup &&
        favoritesRef.current.length > 0
      ) {
        initialCheckDoneRef.current = true;
        void checkFavoriteUpdates({ currentReleases: loadedReleases });
      }
    } catch (err) {
      if (!catalogRef.current) {
        setCatalogError(
          err instanceof Error ? err.message : 'Falha ao conectar ao catálogo.'
        );
      }
    } finally {
      setLoadingCatalog(false);
      setLoadingInitialReleases(false);
    }
  }, [checkFavoriteUpdates]);

  useEffect(() => {
    void fetchCatalog();
  }, [fetchCatalog]);

  // Idle background warmup: preload detail/player JS chunks + warm Calendar & Catalog archives silently
  useEffect(() => {
    if (!isOnline) return;
    let cancelled = false;
    const runWarmup = () => {
      if (cancelled) return;
      preloadAllRouteChunks();
      if (!canBackgroundPrefetch()) return;

      const mode = settingsRef.current.calendarScheduleMode;
      const tzOffsetMinutes = -new Date().getTimezoneOffset();
      scheduleBackgroundPrefetch(`warmup-calendar:${mode}:${tzOffsetMinutes}`, async () => {
        const data = await fetchCalendarCached(mode, tzOffsetMinutes);
        if (!cancelled && Array.isArray(data.days) && data.days.length > 0) {
          setWeeklyCalendarDays(data.days);
          setSelectedCalendarDay((current) =>
            current === 'all' || data.days.some((d) => d.id === current)
              ? current
              : data.days[0].id
          );
          setWeeklyCalendarInitialized(true);
        }
      });

      scheduleBackgroundPrefetch('warmup-archive:animes:p1', async () => {
        const data = await fetchArchivePageCached('animes', 1);
        if (cancelled) return;
        if (Array.isArray(data.featured) && data.featured.length > 0) {
          setFeaturedAnimes(data.featured);
        }
        if (data.filters && data.filters.genres.length > 0) {
          setCatalogFilters(data.filters);
        }
        setArchiveState((prev) =>
          prev.animes.initialized && prev.animes.currentPage > 1
            ? prev
            : {
                ...prev,
                animes: {
                  items: data.items || [],
                  currentPage: data.currentPage || 1,
                  totalPages: data.totalPages || 1,
                  loading: false,
                  initialized: true,
                },
              }
        );
      });

      prefetchArchiveCategoryTarget('movies', 1);
    };

    const win = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (typeof win.requestIdleCallback === 'function') {
      const idleId = win.requestIdleCallback(runWarmup, { timeout: 1400 });
      return () => {
        cancelled = true;
        win.cancelIdleCallback?.(idleId);
      };
    }
    const timer = window.setTimeout(runWarmup, 420);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [isOnline]);

  // Dynamic episode/news check interval + foreground/reconnect catch-up
  useEffect(() => {
    const intervalMs = getEpisodeCheckIntervalMs(settings.episodeCheckIntervalMinutes);
    if (!intervalMs) return;

    const runIfDue = () => {
      if (
        document.visibilityState === 'visible' &&
        navigator.onLine &&
        favoritesRef.current.length > 0 &&
        !checkingAlertsRef.current &&
        shouldRunCatchUpEpisodeCheck(
          settingsRef.current.episodeCheckIntervalMinutes,
          settingsMetaRef.current.lastEpisodeCheckAt
        )
      ) {
        void checkFavoriteUpdates();
      }
    };

    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible' && favoritesRef.current.length > 0) {
        void checkFavoriteUpdates();
      }
    }, intervalMs);

    document.addEventListener('visibilitychange', runIfDue);
    window.addEventListener('online', runIfDue);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', runIfDue);
      window.removeEventListener('online', runIfDue);
    };
  }, [checkFavoriteUpdates, settings.episodeCheckIntervalMinutes]);

  // Sync device notification permission status (Android + Web)
  useEffect(() => {
    let active = true;
    const refreshPermission = async () => {
      const status = await getDeviceNotificationPermission();
      if (active) setNotificationPermission(status);
    };
    void refreshPermission();
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void refreshPermission();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', refreshPermission);
    return () => {
      active = false;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', refreshPermission);
    };
  }, []);

  // Load native Android version info and run one-shot startup GitHub update check
  useEffect(() => {
    let cancelled = false;

    const initUpdates = async () => {
      if (isNativeAndroidApp()) {
        const nativeInfo = await getNativeAppBuildInfo();
        if (!cancelled && nativeInfo) {
          setBuildInfo((prev) => ({
            ...prev,
            androidVersionName: nativeInfo.versionName,
            androidVersionCode: nativeInfo.versionCode,
          }));
        }
      }

      if (cancelled || startupAppUpdateCheckedRef.current) return;
      startupAppUpdateCheckedRef.current = true;

      if (
        shouldRunScheduledAppUpdateCheck(
          settingsRef.current,
          settingsMetaRef.current.lastAppUpdateCheckAt,
          Date.now(),
          { isStartup: true }
        )
      ) {
        void checkForAppUpdates({ manual: false, triggerAutoDownload: true });
      }
    };

    const startupTimer = window.setTimeout(() => {
      void initUpdates();
    }, 1200);

    return () => {
      cancelled = true;
      window.clearTimeout(startupTimer);
    };
  }, [checkForAppUpdates]);

  // Listen to native APK download / verification / PackageInstaller stage events
  useEffect(() => {
    if (!isNativeAndroidApp()) return;
    let active = true;
    const handlePromise = addApkDownloadProgressListener((event) => {
      if (!active) return;
      if (apkInstalledClearTimerRef.current !== null) {
        window.clearTimeout(apkInstalledClearTimerRef.current);
        apkInstalledClearTimerRef.current = null;
      }
      const reduced = reduceApkDownloadProgress(event);
      setApkDownloadProgress(reduced.progress);
      setDownloadingAppUpdate(reduced.downloading);
      if (reduced.acknowledgeRelease) {
        markReleaseAcknowledged(pendingUpdateReleaseRef.current);
        apkInstalledClearTimerRef.current = window.setTimeout(() => {
          apkInstalledClearTimerRef.current = null;
          setApkDownloadProgress((current) =>
            current?.stage === 'installed' ? null : current
          );
        }, 4500);
      }
      if (reduced.toastMessage) {
        showToast(reduced.toastMessage);
      }
    });

    return () => {
      active = false;
      if (apkInstalledClearTimerRef.current !== null) {
        window.clearTimeout(apkInstalledClearTimerRef.current);
        apkInstalledClearTimerRef.current = null;
      }
      void handlePromise.then((handle) => handle?.remove());
    };
  }, [markReleaseAcknowledged, showToast]);

  // Periodic background check for GitHub app updates when interval > 0
  useEffect(() => {
    if (!settings.autoCheckAppUpdates || settings.appUpdateIntervalHours <= 0) return;
    const pollMs = Math.min(settings.appUpdateIntervalHours * 60 * 60 * 1000, 60 * 60 * 1000);
    const interval = window.setInterval(() => {
      if (
        document.visibilityState === 'visible' &&
        shouldRunScheduledAppUpdateCheck(
          settingsRef.current,
          settingsMetaRef.current.lastAppUpdateCheckAt
        )
      ) {
        void checkForAppUpdates({ manual: false, triggerAutoDownload: true });
      }
    }, pollMs);
    return () => window.clearInterval(interval);
  }, [checkForAppUpdates, settings.appUpdateIntervalHours, settings.autoCheckAppUpdates]);

  // Detect waiting PWA Service Worker updates on Web
  useEffect(() => {
    if (isNativeAndroidApp() || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return;
    }
    let mounted = true;
    navigator.serviceWorker
      .getRegistration()
      .then((reg) => {
        if (!mounted || !reg) return;
        if (reg.waiting) {
          waitingSwRef.current = reg.waiting;
          setSwUpdateAvailable(true);
        }
        reg.addEventListener('updatefound', () => {
          const nextWorker = reg.installing;
          if (!nextWorker) return;
          nextWorker.addEventListener('statechange', () => {
            if (nextWorker.state === 'installed' && navigator.serviceWorker.controller) {
              waitingSwRef.current = nextWorker;
              setSwUpdateAvailable(true);
            }
          });
        });
      })
      .catch(() => {
        // Ignore service worker registration restrictions
      });

    return () => {
      mounted = false;
    };
  }, []);

  const handleApplySwUpdate = useCallback(() => {
    const waiting = waitingSwRef.current;
    if (waiting) {
      waiting.postMessage({ type: 'SKIP_WAITING' });
    }
    window.location.reload();
  }, []);

  const fetchArchivePage = useCallback(
    async (category: CatalogArchiveCategory, page: number, append: boolean) => {
      setArchiveState((prev) => ({
        ...prev,
        [category]: { ...prev[category], loading: true },
      }));

      try {
        const data = await fetchArchivePageCached(category, page);

        if (category === 'animes' && Array.isArray(data.featured) && data.featured.length > 0) {
          setFeaturedAnimes(data.featured);
        }
        if (category === 'movies' && Array.isArray(data.sliderMovies) && data.sliderMovies.length > 0) {
          setSliderMovies(data.sliderMovies);
        }
        if (data.filters && data.filters.genres.length > 0) {
          setCatalogFilters(data.filters);
        }

        setArchiveState((prev) => {
          const current = prev[category];
          const merged = append
            ? dedupeMediaItems([...current.items, ...(data.items || [])])
            : data.items || [];
          return {
            ...prev,
            [category]: {
              items: append ? (merged.length ? merged : current.items) : merged,
              currentPage: data.currentPage || page,
              totalPages: data.totalPages || 1,
              loading: false,
              initialized: true,
            },
          };
        });
      } catch (err) {
        setArchiveState((prev) => ({
          ...prev,
          [category]: { ...prev[category], loading: false, initialized: true },
        }));
        showToast(err instanceof Error ? err.message : 'Falha ao carregar títulos.');
      }
    },
    [showToast]
  );

  const fetchFilteredCatalog = useCallback(
    async (opts: { genre?: string; year?: string; page: number; append: boolean }) => {
      setFilteredCatalog((prev) => ({ ...prev, loading: true }));
      try {
        const data = await fetchFilteredCatalogCached({
          category: archiveCategory,
          genre: opts.genre,
          year: opts.year,
          page: opts.page,
        });

        if (data.filters && data.filters.genres.length > 0) {
          setCatalogFilters(data.filters);
        }

        setFilteredCatalog((prev) => ({
          items: opts.append
            ? dedupeMediaItems([...prev.items, ...(data.items || [])])
            : data.items || [],
          currentPage: data.currentPage || opts.page,
          totalPages: data.totalPages || 1,
          loading: false,
          initialized: true,
        }));
      } catch (err) {
        setFilteredCatalog((prev) => ({ ...prev, loading: false, initialized: true }));
        showToast(err instanceof Error ? err.message : 'Falha ao filtrar títulos.');
      }
    },
    [archiveCategory, showToast]
  );

  const fetchWeeklyCalendar = useCallback(
    async (options: { mode?: LiveChartScheduleMode; refresh?: boolean } = {}) => {
      const effectiveMode = options.mode ?? settingsRef.current.calendarScheduleMode;
      const tzOffsetMinutes = -new Date().getTimezoneOffset();
      setLoadingWeeklyCalendar(true);
      setCalendarError('');
      try {
        const data = await fetchCalendarCached(effectiveMode, tzOffsetMinutes, {
          refresh: options.refresh,
        });
        if (Array.isArray(data.days) && data.days.length > 0) {
          setWeeklyCalendarDays(data.days);
          setSelectedCalendarDay((current) =>
            current === 'all' || data.days.some((d) => d.id === current)
              ? current
              : data.days[0].id
          );
        }
      } catch (err) {
        setCalendarError(
          err instanceof Error ? err.message : 'Não foi possível carregar o calendário do LiveChart.me.'
        );
      } finally {
        setLoadingWeeklyCalendar(false);
        setWeeklyCalendarInitialized(true);
      }
    },
    []
  );

  useEffect(() => {
    if (activeSection === 'calendar' && !weeklyCalendarInitialized && !loadingWeeklyCalendar) {
      void fetchWeeklyCalendar();
    }
  }, [activeSection, fetchWeeklyCalendar, loadingWeeklyCalendar, weeklyCalendarInitialized]);

  const fetchGlossaryCatalog = useCallback(
    async (term: string, category: CatalogArchiveCategory) => {
      setFilteredCatalog((prev) => ({ ...prev, loading: true }));
      try {
        const type =
          category === 'movies'
            ? 'movies'
            : category === 'animes'
              ? 'tvshows'
              : 'all';
        const data = await fetchGlossaryCached(term, type);
        setFilteredCatalog({
          items: Array.isArray(data.items) ? data.items : [],
          currentPage: 1,
          totalPages: 1,
          loading: false,
          initialized: true,
        });
      } catch (err) {
        setFilteredCatalog((prev) => ({ ...prev, loading: false, initialized: true }));
        showToast(err instanceof Error ? err.message : 'Falha ao consultar índice alfabético.');
      }
    },
    [showToast]
  );

  useEffect(() => {
    if (
      activeSection === 'catalog' &&
      !selectedGenre &&
      !selectedYear &&
      !selectedGlossary &&
      !archiveState[archiveCategory].initialized &&
      !archiveState[archiveCategory].loading
    ) {
      void fetchArchivePage(archiveCategory, 1, false);
    }
  }, [
    activeSection,
    archiveCategory,
    archiveState,
    fetchArchivePage,
    selectedGenre,
    selectedGlossary,
    selectedYear,
  ]);

  const handleLoadMoreReleases = useCallback(async () => {
    if (loadingMoreReleases || releasesPage >= releasesTotalPages) return;
    const nextPage = releasesPage + 1;
    setLoadingMoreReleases(true);
    try {
      const data = await fetchReleasesPageCached(nextPage);
      setReleases((prev) => dedupeMediaItems([...prev, ...(data.items || [])]));
      setReleasesPage(data.currentPage || nextPage);
      setReleasesTotalPages(data.totalPages || releasesTotalPages);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Falha ao carregar episódios.');
    } finally {
      setLoadingMoreReleases(false);
    }
  }, [loadingMoreReleases, releasesPage, releasesTotalPages, showToast]);

  const handleSelectArchiveCategory = useCallback((category: CatalogArchiveCategory) => {
    setSelectedGenre('');
    setSelectedYear('');
    setSelectedGlossary('');
    setFilteredCatalog({ ...EMPTY_BUCKET });
    setArchiveCategory(category);
  }, []);

  const handleChangeCalendarScheduleMode = useCallback(
    (mode: LiveChartScheduleMode) => {
      updateSettings({ calendarScheduleMode: mode });
      void fetchWeeklyCalendar({ mode });
    },
    [fetchWeeklyCalendar, updateSettings]
  );

  const handleChangeCalendarLayout = useCallback(
    (layout: CalendarLayout) => {
      updateSettings({ calendarLayout: layout });
    },
    [updateSettings]
  );

  const handleSelectGenre = useCallback(
    (genreSlug: string) => {
      setSelectedYear('');
      setSelectedGlossary('');
      setSelectedGenre(genreSlug);
      if (!genreSlug) {
        setFilteredCatalog({ ...EMPTY_BUCKET });
        return;
      }
      void fetchFilteredCatalog({ genre: genreSlug, page: 1, append: false });
    },
    [fetchFilteredCatalog]
  );

  const handleSelectYear = useCallback(
    (yearSlug: string) => {
      setSelectedGenre('');
      setSelectedGlossary('');
      setSelectedYear(yearSlug);
      if (!yearSlug) {
        setFilteredCatalog({ ...EMPTY_BUCKET });
        return;
      }
      void fetchFilteredCatalog({ year: yearSlug, page: 1, append: false });
    },
    [fetchFilteredCatalog]
  );

  const handleSelectGlossary = useCallback(
    (term: string) => {
      setSelectedGenre('');
      setSelectedYear('');
      setSelectedGlossary(term);
      if (!term) {
        setFilteredCatalog({ ...EMPTY_BUCKET });
        return;
      }
      void fetchGlossaryCatalog(term, archiveCategory);
    },
    [archiveCategory, fetchGlossaryCatalog]
  );

  const handleClearCatalogFilters = useCallback(() => {
    setSelectedGenre('');
    setSelectedYear('');
    setSelectedGlossary('');
    setFilteredCatalog({ ...EMPTY_BUCKET });
  }, []);

  const handleLoadMoreFiltered = useCallback(() => {
    if (filteredCatalog.loading || filteredCatalog.currentPage >= filteredCatalog.totalPages) return;
    void fetchFilteredCatalog({
      genre: selectedGenre || undefined,
      year: selectedYear || undefined,
      page: filteredCatalog.currentPage + 1,
      append: true,
    });
  }, [fetchFilteredCatalog, filteredCatalog, selectedGenre, selectedYear]);

  const handleLoadMoreArchiveCategory = useCallback(
    (category: CatalogArchiveCategory) => {
      const bucket = archiveState[category];
      if (bucket.loading || bucket.currentPage >= bucket.totalPages) return;
      void fetchArchivePage(category, bucket.currentPage + 1, true);
    },
    [archiveState, fetchArchivePage]
  );

  const handleSearch = useCallback(
    async (query: string) => {
      if (!query) {
        setSearchQuery('');
        setSearchResults(null);
        setSearchPage(1);
        setSearchTotalPages(1);
        return;
      }
      navRequestGenRef.current += 1;
      setRouteStack([{ view: 'catalog' }]);
      setSearchQuery(query);
      setSearching(true);
      setSearchPage(1);
      setSearchTotalPages(1);
      try {
        const data = await fetchSearchPageCached(query, 1);
        setSearchResults(Array.isArray(data.results) ? data.results : []);
        setSearchPage(data.currentPage || 1);
        setSearchTotalPages(data.totalPages || 1);
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Erro ao buscar');
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    },
    [showToast]
  );

  const handleLoadMoreSearch = useCallback(async () => {
    if (!searchQuery || loadingMoreSearch || searchPage >= searchTotalPages) return;
    const nextPage = searchPage + 1;
    setLoadingMoreSearch(true);
    try {
      const data = await fetchSearchPageCached(searchQuery, nextPage);
      setSearchResults((prev) =>
        dedupeSearchItems([...(prev || []), ...(data.results || [])])
      );
      setSearchPage(data.currentPage || nextPage);
      setSearchTotalPages(data.totalPages || searchTotalPages);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro ao carregar mais resultados');
    } finally {
      setLoadingMoreSearch(false);
    }
  }, [loadingMoreSearch, searchPage, searchQuery, searchTotalPages, showToast]);

  const loadAnimeDetailsForRoute = useCallback(
    async (url: string, reqGen: number, seed?: MediaNavigationSeed) => {
      preloadRouteChunk('anime');
      const fullCached = getCachedAnimeDetailsFull(url);
      if (fullCached) {
        setAnimeDetails(fullCached);
        setAnimeDetailStage('ready');
        setLoadingDetail(false);
        setDetailError('');
        return;
      }

      // Build the profile & episodes directly from TheTVDB (never flash provider artwork/metadata
      // or raw unmerged provider episodes only to overwrite them moments later).
      setLoadingDetail(true);
      setDetailError('');
      setAnimeDetails(null);
      setAnimeDetailStage('seed');

      const fallbackFav = !seed ? findMatchingFavorite(url, favoritesRef.current) : undefined;
      const effectiveTitle = seed?.title || fallbackFav?.title;
      const effectiveTvdbId = seed?.externalIds?.tvdbId ?? fallbackFav?.externalIds?.tvdbId;
      const effectiveTvdbSlug = seed?.externalIds?.tvdbSlug || fallbackFav?.externalIds?.tvdbSlug;
      const effectiveKind = seed?.kind ?? fallbackFav?.kind;
      const effectiveYear = seed?.year || fallbackFav?.year;
      const hints =
        effectiveTitle || effectiveTvdbId || effectiveTvdbSlug || effectiveKind || effectiveYear
          ? {
              title: effectiveTitle,
              tvdbId: effectiveTvdbId,
              tvdbSlug: effectiveTvdbSlug,
              kind: effectiveKind === 'episode' ? ('anime' as const) : effectiveKind,
              year: effectiveYear,
            }
          : undefined;

      try {
        const fullDetails = await fetchAnimeDetailsFull(url, { hints });
        if (navRequestGenRef.current !== reqGen) return;
        setAnimeDetails(fullDetails);
        setAnimeDetailStage('ready');
      } catch (err) {
        if (navRequestGenRef.current !== reqGen) return;
        // Fallback strictly to the provider page if the primary TVDB-enriched request fails
        if (!isAnisyncUri(url)) {
          try {
            const providerFallback = await fetchAnimeDetailsQuick(url);
            if (navRequestGenRef.current !== reqGen) return;
            setAnimeDetails(providerFallback);
            setAnimeDetailStage('ready');
            return;
          } catch {
            // Fall through and surface original error below
          }
        }
        setDetailError(
          err instanceof Error ? err.message : 'Falha ao carregar detalhes do título.'
        );
        setAnimeDetailStage('ready');
      } finally {
        if (navRequestGenRef.current === reqGen) {
          setLoadingDetail(false);
        }
      }
    },
    []
  );

  const resolveKnownEpisodeMeta = useCallback((targetUrl: string) => {
    const key = canonicalEpisodeProgressKey(targetUrl);
    if (!key) return null;

    const currentAnime = animeDetailsRef.current;
    if (currentAnime) {
      const candidateTrackEps = [
        ...currentAnime.episodes,
        ...(currentAnime.audioTracks?.DUB?.episodes || []),
        ...(currentAnime.audioTracks?.LEG?.episodes || []),
      ];
      const matchedEp = candidateTrackEps.find(
        (ep) => canonicalEpisodeProgressKey(ep.url) === key || ep.url === targetUrl
      );
      if (matchedEp) {
        const matchedTrack =
          matchedEp.audioType === 'DUB'
            ? currentAnime.audioTracks?.DUB
            : matchedEp.audioType === 'LEG'
              ? currentAnime.audioTracks?.LEG
              : undefined;
        return {
          title: matchedEp.title || `${currentAnime.title} — ${matchedEp.numberLabel || 'Episódio'}`,
          seriesTitle: currentAnime.title,
          seriesUrl: matchedTrack?.sourceUrl || currentAnime.url,
          poster: currentAnime.poster,
          backdrop: matchedEp.thumb || currentAnime.backdrop || currentAnime.poster,
          episodeLabel: matchedEp.numberLabel || undefined,
          isMovie: currentAnime.kind === 'movie',
        };
      }
    }

    const currentEp = episodeDetailsRef.current;
    if (currentEp && (canonicalEpisodeProgressKey(currentEp.url) === key || currentEp.url === targetUrl)) {
      return {
        title: currentEp.title,
        seriesTitle: currentEp.seriesTitle,
        seriesUrl: currentEp.seriesUrl,
        poster: currentEp.backdrop || currentEp.poster,
        backdrop: currentEp.backdrop || currentEp.poster,
        episodeLabel: currentEp.episodeLabel,
        isMovie: currentEp.isMovie,
      };
    }

    const histMatch = historyRef.current.find(
      (item) => canonicalEpisodeProgressKey(item.url) === key || item.url === targetUrl
    );
    if (histMatch) {
      return {
        title: histMatch.title,
        seriesTitle: histMatch.seriesTitle,
        seriesUrl: histMatch.seriesUrl,
        poster: histMatch.poster,
        backdrop: histMatch.poster,
        episodeLabel: undefined,
        isMovie: histMatch.kind === 'movie',
      };
    }

    const relMatch = releasesRef.current.find(
      (item) => canonicalEpisodeProgressKey(item.url) === key || item.url === targetUrl
    );
    if (relMatch) {
      return {
        title: relMatch.title,
        seriesTitle: undefined,
        seriesUrl: undefined,
        poster: relMatch.poster,
        backdrop: relMatch.poster,
        episodeLabel: relMatch.episodeLabel,
        isMovie: relMatch.kind === 'movie',
      };
    }

    return null;
  }, []);

  const loadEpisodeDetailsForRoute = useCallback(
    async (
      url: string,
      reqGen: number,
      options: {
        bypassCache?: boolean;
        preserveExisting?: boolean;
        seed?: MediaNavigationSeed;
      } = {}
    ) => {
      preloadRouteChunk('episode');
      const openedEpKey = canonicalEpisodeKey(url);
      if (openedEpKey) {
        const hasMatchingUnread = alertsRef.current.some(
          (a) => !a.read && canonicalEpisodeKey(a.episodeUrl) === openedEpKey
        );
        if (hasMatchingUnread) {
          const nextAlerts = alertsRef.current.map((a) =>
            canonicalEpisodeKey(a.episodeUrl) === openedEpKey ? { ...a, read: true } : a
          );
          setAlerts(nextAlerts);
          saveFavoriteAlerts(nextAlerts);
        }
      }
      const knownMeta = resolveKnownEpisodeMeta(url);
      if (!options.bypassCache) {
        const cachedEp = getCachedEpisodeDetails(url);
        if (cachedEp) {
          setEpisodeDetails(cachedEp);
          setLoadingDetail(false);
          setDetailError('');
          return;
        }
      } else {
        deleteCachedEpisodeDetails(url);
      }

      setDetailError('');
      setLoadingDetail(true);
      setLoadingExtraServers(null);
      if (!options.preserveExisting) {
        const mergedSeed: MediaNavigationSeed | undefined =
          options.seed || knownMeta
            ? {
                title: options.seed?.title || knownMeta?.title,
                seriesTitle: options.seed?.seriesTitle || knownMeta?.seriesTitle,
                seriesUrl: options.seed?.seriesUrl || knownMeta?.seriesUrl,
                poster: options.seed?.poster || knownMeta?.poster,
                backdrop: options.seed?.backdrop || knownMeta?.backdrop || options.seed?.poster,
                episodeLabel: options.seed?.episodeLabel || knownMeta?.episodeLabel,
                seasonNumber: options.seed?.seasonNumber,
                episodeNumber: options.seed?.episodeNumber,
                prevUrl: options.seed?.prevUrl,
                nextUrl: options.seed?.nextUrl,
                kind: options.seed?.kind,
                isMovie: options.seed?.isMovie ?? knownMeta?.isMovie,
                year: options.seed?.year,
                genres: options.seed?.genres,
                externalIds: options.seed?.externalIds,
                catalogSource: options.seed?.catalogSource,
              }
            : undefined;
        const optimisticEp = buildOptimisticEpisodeDetails(
          url,
          mergedSeed,
          animeDetailsRef.current
        );
        setEpisodeDetails(optimisticEp);
      }
      try {
        const rawEp = await fetchEpisodeDetailsFast(url, {
          sources: settingsRef.current.episodeSources,
          audioPreference: settingsRef.current.defaultAudioFilter,
          deferCrossSources: !options.bypassCache,
          bypassCache: options.bypassCache,
        });
        if (navRequestGenRef.current !== reqGen) return;
        const ep: EpisodeDetails = {
          ...rawEp,
          seriesTitle:
            rawEp.seriesTitle ||
            options.seed?.seriesTitle ||
            knownMeta?.seriesTitle ||
            rawEp.title,
          seriesUrl: rawEp.seriesUrl || options.seed?.seriesUrl || knownMeta?.seriesUrl || '',
          poster: rawEp.poster || options.seed?.poster || knownMeta?.poster || '',
          backdrop:
            rawEp.backdrop ||
            rawEp.poster ||
            options.seed?.backdrop ||
            knownMeta?.backdrop ||
            knownMeta?.poster ||
            '',
          genres: rawEp.genres.length > 0 ? rawEp.genres : options.seed?.genres || [],
        };
        setCachedEpisodeDetails(url, ep);
        setEpisodeDetails(ep);

        // Augment with secondary integrated servers (e.g. Hinata Soul) in the background
        // while showing an explicit loading indicator next to the server list.
        const reportedIds = new Set((ep.sourceReports || []).map((r) => r.sourceId));
        const pendingSourceNames = settingsRef.current.episodeSources
          .filter((s) => s.enabled && !reportedIds.has(s.id))
          .map((s) => s.name);
        const hasPendingSecondarySource =
          !options.bypassCache &&
          !ep.url.startsWith('anisync://') &&
          Boolean(ep.seriesTitle) &&
          reportedIds.size === 1 &&
          pendingSourceNames.length > 0;

        if (hasPendingSecondarySource) {
          const extraGen = ++extraServersGenRef.current;
          const excludeSourceIds = Array.from(reportedIds);
          setLoadingExtraServers({
            episodeUrl: ep.url,
            sourceNames: pendingSourceNames,
            gen: extraGen,
          });
          void apiFetch('/api/sources/resolve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              excludeSourceIds,
              query: {
                title: ep.seriesTitle,
                originalTitle: ep.originalTitle,
                alternativeTitles: ep.alternativeTitles,
                mediaType: ep.isMovie ? 'movie' : ep.mediaType || 'anime',
                seasonNumber: ep.seasonNumber || 1,
                episodeNumber: ep.episodeNumber || 1,
                audioPreference: settingsRef.current.defaultAudioFilter,
              },
            }),
          })
            .then((extraRes) => (extraRes.ok ? extraRes.json() : null))
            .then(
              (
                extraData: {
                  options?: EpisodeDetails['options'];
                  reports?: EpisodeDetails['sourceReports'];
                } | null
              ) => {
                if (!extraData) return;
                const extraOpts = Array.isArray(extraData.options) ? extraData.options : [];
                const extraReports = Array.isArray(extraData.reports) ? extraData.reports : [];
                if (!extraOpts.length && !extraReports.length) return;

                const mergeEpisode = (base: EpisodeDetails): EpisodeDetails => {
                  const seenKeys = new Set(
                    base.options.map(
                      (o) => `${o.sourceId || ''}::${o.directStreamUrl || o.embedUrl}`
                    )
                  );
                  const mergedOptions = [...base.options];
                  for (const opt of extraOpts) {
                    const key = `${opt.sourceId || ''}::${opt.directStreamUrl || opt.embedUrl}`;
                    if (seenKeys.has(key)) continue;
                    seenKeys.add(key);
                    mergedOptions.push(opt);
                  }
                  const seenReportIds = new Set(
                    (base.sourceReports || []).map((r) => r.sourceId)
                  );
                  const mergedReports = [...(base.sourceReports || [])];
                  for (const rep of extraReports) {
                    if (seenReportIds.has(rep.sourceId)) continue;
                    seenReportIds.add(rep.sourceId);
                    mergedReports.push(rep);
                  }
                  return {
                    ...base,
                    options: mergedOptions,
                    sourceReports: mergedReports,
                  };
                };

                const cachedNow = getCachedEpisodeDetails(url);
                if (cachedNow) {
                  setCachedEpisodeDetails(url, mergeEpisode(cachedNow));
                }
                setEpisodeDetails((prev) =>
                  prev && isSameEpisodeUrl(prev.url, ep.url) ? mergeEpisode(prev) : prev
                );
              }
            )
            .catch(() => {
              // Secondary background augmentation is best-effort
            })
            .finally(() => {
              setLoadingExtraServers((current) =>
                current && current.gen === extraGen ? null : current
              );
            });
        }
      } catch (err) {
        if (navRequestGenRef.current !== reqGen) return;
        setDetailError(
          err instanceof Error ? err.message : 'Falha ao consultar fontes de vídeo.'
        );
      } finally {
        if (navRequestGenRef.current === reqGen) {
          setLoadingDetail(false);
        }
      }
    },
    [resolveKnownEpisodeMeta]
  );

  const syncNativeSessionResult = useCallback(
    (
      result: NativeVlcPlayResult,
      fallbackMeta?: {
        url?: string;
        title?: string;
        seriesTitle?: string;
        seriesUrl?: string;
        poster?: string;
        isMovie?: boolean;
      }
    ) => {
      if (result.videoScale) {
        updateSettings({ videoScale: sanitizeVideoScaleMode(result.videoScale) });
      }

      const visitedList = Array.isArray(result.visitedEpisodes) ? result.visitedEpisodes : [];
      if (visitedList.length > 0) {
        const sortedVisited = [...visitedList].sort(
          (a, b) => (a.watchedAtMs || 0) - (b.watchedAtMs || 0)
        );
        let nextHist = historyRef.current;
        for (const visited of sortedVisited) {
          if (!visited?.url) continue;
          const known = resolveKnownEpisodeMeta(visited.url);
          const epTitle = visited.title || known?.title || fallbackMeta?.title || 'Episódio';
          const epSeriesTitle =
            visited.seriesTitle || known?.seriesTitle || fallbackMeta?.seriesTitle;
          const epSeriesUrl = visited.seriesUrl || known?.seriesUrl || fallbackMeta?.seriesUrl;
          const epPoster = visited.poster || known?.poster || fallbackMeta?.poster || '';
          const epIsMovie = Boolean(visited.isMovie ?? known?.isMovie ?? fallbackMeta?.isMovie);
          const watchedAt =
            typeof visited.watchedAtMs === 'number' && visited.watchedAtMs > 0
              ? new Date(visited.watchedAtMs).toISOString()
              : new Date().toISOString();
          const posSec = Math.max(0, (visited.positionMs || 0) / 1000);
          const durSec = Math.max(0, (visited.durationMs || 0) / 1000);
          const completedFlag = Boolean(visited.completed);

          if (
            typeof visited.positionMs === 'number' ||
            typeof visited.completed === 'boolean'
          ) {
            saveEpisodeProgress({
              url: visited.url,
              positionSec: posSec,
              durationSec: durSec,
              ended: completedFlag,
              meta: {
                title: epTitle,
                seriesTitle: epSeriesTitle,
                seriesUrl: epSeriesUrl,
                poster: epPoster,
                kind: epIsMovie ? 'movie' : 'episode',
                watchedAt,
                promoteInHistory: true,
              },
            });
          }

          nextHist = pushHistoryEntry({
            url: visited.url,
            title: epTitle,
            seriesTitle: epSeriesTitle,
            seriesUrl: epSeriesUrl,
            poster: epPoster,
            kind: epIsMovie ? 'movie' : 'episode',
            watchedAt,
            positionSec: completedFlag ? 0 : posSec > 0 ? posSec : undefined,
            durationSec: durSec > 0 ? durSec : undefined,
            completed: completedFlag ? true : undefined,
          });
        }
        historyRef.current = nextHist;
        setHistory(nextHist);
      }

      const activeResUrl = result.episodeUrl || fallbackMeta?.url;
      if (activeResUrl && typeof result.positionMs === 'number') {
        const matchingVisited = visitedList.find((v) => isSameEpisodeUrl(v.url, activeResUrl));
        const known = resolveKnownEpisodeMeta(activeResUrl);
        const epTitle =
          matchingVisited?.title || known?.title || fallbackMeta?.title || 'Episódio';
        const epSeriesTitle =
          matchingVisited?.seriesTitle || known?.seriesTitle || fallbackMeta?.seriesTitle;
        const epSeriesUrl =
          matchingVisited?.seriesUrl || known?.seriesUrl || fallbackMeta?.seriesUrl;
        const epPoster =
          matchingVisited?.poster || known?.poster || fallbackMeta?.poster || '';
        const epIsMovie = Boolean(
          matchingVisited?.isMovie ?? known?.isMovie ?? fallbackMeta?.isMovie
        );
        const completedFlag = Boolean(result.completed || matchingVisited?.completed);
        const posSec = Math.max(0, result.positionMs / 1000);
        const durSec = Math.max(0, (result.durationMs || 0) / 1000);

        saveEpisodeProgress({
          url: activeResUrl,
          positionSec: posSec,
          durationSec: durSec,
          ended: completedFlag,
          meta: {
            title: epTitle,
            seriesTitle: epSeriesTitle,
            seriesUrl: epSeriesUrl,
            poster: epPoster,
            kind: epIsMovie ? 'movie' : 'episode',
            watchedAt: new Date().toISOString(),
            promoteInHistory: true,
          },
        });

        if (visitedList.length === 0) {
          const nextHist = pushHistoryEntry({
            url: activeResUrl,
            title: epTitle,
            seriesTitle: epSeriesTitle,
            seriesUrl: epSeriesUrl,
            poster: epPoster,
            kind: epIsMovie ? 'movie' : 'episode',
            watchedAt: new Date().toISOString(),
            positionSec: completedFlag ? 0 : posSec > 0 ? posSec : undefined,
            durationSec: durSec > 0 ? durSec : undefined,
            completed: completedFlag ? true : undefined,
          });
          historyRef.current = nextHist;
          setHistory(nextHist);
        }
      }

      refreshProgressState();
    },
    [refreshProgressState, resolveKnownEpisodeMeta, updateSettings]
  );

  // Hydrate restored active route (episode or anime details) on startup
  useEffect(() => {
    if (initialRouteHydratedRef.current) return;
    initialRouteHydratedRef.current = true;
    const currentRoute = routeRef.current;
    if (currentRoute.view === 'episode' && currentRoute.url) {
      const reqGen = ++navRequestGenRef.current;
      void loadEpisodeDetailsForRoute(currentRoute.url, reqGen);
    } else if (currentRoute.view === 'anime' && currentRoute.url) {
      const reqGen = ++navRequestGenRef.current;
      void loadAnimeDetailsForRoute(currentRoute.url, reqGen);
    }
  }, [loadAnimeDetailsForRoute, loadEpisodeDetailsForRoute]);

  // Consume any persisted native VLC session on startup or foreground return
  useEffect(() => {
    const syncPending = async () => {
      const pending = await consumeNativeVlcPendingSession();
      if (!pending) return;
      const currentEp = episodeDetailsRef.current;
      syncNativeSessionResult(
        pending,
        currentEp
          ? {
              url: currentEp.url,
              title: currentEp.title,
              seriesTitle: currentEp.seriesTitle,
              seriesUrl: currentEp.seriesUrl,
              poster: currentEp.backdrop || currentEp.poster,
              isMovie: currentEp.isMovie,
            }
          : undefined
      );
      if (
        pending.episodeUrl &&
        routeRef.current.view === 'episode' &&
        !isSameEpisodeUrl(pending.episodeUrl, routeRef.current.url)
      ) {
        const reqGen = ++navRequestGenRef.current;
        const nextStack = pushRouteFrame(routeStackRef.current, {
          view: 'episode',
          url: pending.episodeUrl,
        });
        routeStackRef.current = nextStack;
        setRouteStack(nextStack);
        void loadEpisodeDetailsForRoute(pending.episodeUrl, reqGen, { preserveExisting: true });
      }
    };

    void syncPending();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void syncPending();
      }
    };
    const onFocus = () => {
      void syncPending();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
    };
  }, [loadEpisodeDetailsForRoute, syncNativeSessionResult]);

  const handleRefreshEpisodeSources = useCallback(() => {
    const currentRoute = routeRef.current;
    if (currentRoute.view !== 'episode' || !currentRoute.url) return;
    const reqGen = ++navRequestGenRef.current;
    void loadEpisodeDetailsForRoute(currentRoute.url, reqGen, {
      bypassCache: true,
      preserveExisting: true,
    });
  }, [loadEpisodeDetailsForRoute]);

  const pushBrowserHistoryIfNeeded = useCallback((prevLen: number, nextLen: number) => {
    if (isNativeAndroidApp() || handlingPopstateRef.current) return;
    if (nextLen > prevLen && typeof window !== 'undefined' && window.history?.pushState) {
      try {
        window.history.pushState({ topAnimesStackDepth: nextLen }, '');
      } catch {
        // Ignore browser history restrictions
      }
    }
  }, []);

  const openMediaUrl = useCallback(
    async (url: string, explicitKind?: MediaKind, seed?: MediaNavigationSeed) => {
      const parsed = parseAnisyncUri(url);
      const inferredKind: MediaKind = explicitKind || inferMediaKindFromTarget(url);
      const opensDetailPage =
        parsed.kind === 'media' ||
        (parsed.kind === 'legacy-url' &&
          (inferredKind === 'anime' || inferredKind === 'series'));

      if (routeRef.current.view === 'catalog' && typeof window !== 'undefined') {
        catalogScrollYRef.current = window.scrollY;
      }

      const reqGen = ++navRequestGenRef.current;
      const nextFrame: ActiveRoute = opensDetailPage
        ? { view: 'anime', url }
        : { view: 'episode', url };

      const prevStack = routeStackRef.current;
      const nextStack = pushRouteFrame(prevStack, nextFrame);
      routeStackRef.current = nextStack;
      setRouteStack(nextStack);
      pushBrowserHistoryIfNeeded(prevStack.length, nextStack.length);

      if (opensDetailPage) {
        await loadAnimeDetailsForRoute(url, reqGen, seed);
        return;
      }

      const preserveExisting = routeRef.current.view === 'episode';
      await loadEpisodeDetailsForRoute(url, reqGen, { preserveExisting, seed });
    },
    [loadAnimeDetailsForRoute, loadEpisodeDetailsForRoute, pushBrowserHistoryIfNeeded]
  );

  const handlePrefetchAnime = useCallback(
    (animeUrl: string, seed?: MediaNavigationSeed) => {
      prefetchAnimeTarget(animeUrl, seed, { intentTriggered: true });
    },
    []
  );

  const handlePrefetchEpisode = useCallback(
    (
      episodeUrl: string,
      seed?: MediaNavigationSeed,
      options?: { preResolvePrimaryEmbed?: boolean }
    ) => {
      prefetchEpisodeTarget(episodeUrl, {
        seed,
        sources: settingsRef.current.episodeSources,
        audioPreference: settingsRef.current.defaultAudioFilter,
        preResolvePrimaryEmbed: options?.preResolvePrimaryEmbed ?? true,
        intentTriggered: true,
      });
    },
    []
  );

  const handlePrefetchItem = useCallback(
    (url: string, explicitKind?: MediaKind, seed?: MediaNavigationSeed) => {
      if (!url) return;
      const parsed = parseAnisyncUri(url);
      const inferredKind: MediaKind = explicitKind || inferMediaKindFromTarget(url);
      const opensDetailPage =
        parsed.kind === 'media' ||
        (parsed.kind === 'legacy-url' &&
          (inferredKind === 'anime' || inferredKind === 'series'));

      if (opensDetailPage) {
        handlePrefetchAnime(url, seed);
      } else {
        handlePrefetchEpisode(url, seed, { preResolvePrimaryEmbed: true });
      }
    },
    [handlePrefetchAnime, handlePrefetchEpisode]
  );

  const handlePrefetchArchiveCategory = useCallback((category: CatalogArchiveCategory) => {
    prefetchArchiveCategoryTarget(category, 1, { intentTriggered: true });
  }, []);

  const handlePrefetchCalendarMode = useCallback((mode: LiveChartScheduleMode) => {
    prefetchCalendarTarget(mode, { intentTriggered: true });
  }, []);

  const handlePrefetchSection = useCallback(
    (section: NavSection) => {
      if (section === 'calendar') {
        prefetchCalendarTarget(settingsRef.current.calendarScheduleMode, { intentTriggered: true });
      } else if (section === 'catalog') {
        prefetchArchiveCategoryTarget(archiveCategory, 1, { intentTriggered: true });
      } else if (section === 'releases') {
        prefetchReleasesPageTarget(1, { intentTriggered: true });
      }
    },
    [archiveCategory]
  );

  const handlePrefetchMoreReleases = useCallback(() => {
    if (releasesPage >= releasesTotalPages) return;
    prefetchReleasesPageTarget(releasesPage + 1, { intentTriggered: true });
  }, [releasesPage, releasesTotalPages]);

  const handlePrefetchMoreArchive = useCallback(
    (category: CatalogArchiveCategory) => {
      const bucket = archiveState[category];
      if (!bucket || bucket.currentPage >= bucket.totalPages) return;
      prefetchArchiveCategoryTarget(category, bucket.currentPage + 1, { intentTriggered: true });
    },
    [archiveState]
  );

  const handlePrefetchMoreFiltered = useCallback(() => {
    if (
      filteredCatalog.currentPage >= filteredCatalog.totalPages ||
      (!selectedGenre && !selectedYear)
    ) {
      return;
    }
    const nextPage = filteredCatalog.currentPage + 1;
    scheduleBackgroundPrefetch(
      `filtered:${archiveCategory}:${selectedGenre}:${selectedYear}:p${nextPage}`,
      () =>
        fetchFilteredCatalogCached({
          category: archiveCategory,
          genre: selectedGenre || undefined,
          year: selectedYear || undefined,
          page: nextPage,
        }),
      { intentTriggered: true }
    );
  }, [
    archiveCategory,
    filteredCatalog.currentPage,
    filteredCatalog.totalPages,
    selectedGenre,
    selectedYear,
  ]);

  const handlePrefetchMoreSearch = useCallback(() => {
    if (!searchQuery || searchPage >= searchTotalPages) return;
    const nextPage = searchPage + 1;
    scheduleBackgroundPrefetch(
      `search:${searchQuery.trim().toLowerCase()}:p${nextPage}`,
      () => fetchSearchPageCached(searchQuery, nextPage),
      { intentTriggered: true }
    );
  }, [searchPage, searchQuery, searchTotalPages]);

  const toggleFavorite = useCallback(
    (rawItem: CatalogMediaItem, knownLatest?: FavoriteLatestInfo | null) => {
      const normalizedItem = toSeriesFavoriteItem(rawItem);
      const existing = findMatchingFavorite(normalizedItem.url, favoritesRef.current);

      if (existing) {
        const nextFavs = favoritesRef.current.filter((f) => f.url !== existing.url);
        setFavorites(nextFavs);
        saveFavorites(nextFavs);

        const nextBaselines = { ...baselinesRef.current };
        delete nextBaselines[normalizeTopAnimesUrl(existing.url)];
        delete nextBaselines[existing.url];
        setBaselines(nextBaselines);
        saveFavoriteBaselines(nextBaselines);

        const prunedAlerts = pruneAlertsForRemovedFavorite(alertsRef.current, existing.url);
        if (prunedAlerts.length !== alertsRef.current.length) {
          setAlerts(prunedAlerts);
          saveFavoriteAlerts(prunedAlerts);
        }

        const nextMuted = removeFavoriteMutedUrl(existing.url, mutedFavoriteUrlsRef.current);
        if (nextMuted !== mutedFavoriteUrlsRef.current) {
          setMutedFavoriteUrls(nextMuted);
          saveMutedFavoriteUrls(nextMuted);
        }

        showToast('Removido dos favoritos.');
        return;
      }

      const nextFavs = [normalizedItem, ...favoritesRef.current];
      setFavorites(nextFavs);
      saveFavorites(nextFavs);

      const seeded = buildFavoriteBaseline(
        normalizedItem,
        releasesRef.current,
        knownLatest
      );
      if (seeded) {
        const key = normalizeTopAnimesUrl(normalizedItem.url) || normalizedItem.url;
        const nextBaselines = {
          ...baselinesRef.current,
          [key]: seeded,
        };
        setBaselines(nextBaselines);
        saveFavoriteBaselines(nextBaselines);
      }

      showToast('Adicionado aos favoritos! Você será avisado quando sair episódio novo.');
    },
    [showToast]
  );

  const handleMarkAllAlertsRead = useCallback(() => {
    setAlerts((prev) => {
      const next = prev.map((a) => ({ ...a, read: true }));
      saveFavoriteAlerts(next);
      return next;
    });
  }, []);

  const handleMarkAlertRead = useCallback((alertId: string) => {
    setAlerts((prev) => {
      const next = markSingleAlertRead(prev, alertId);
      if (next !== prev) saveFavoriteAlerts(next);
      return next;
    });
  }, []);

  const handleDismissAlert = useCallback((alertId: string) => {
    setAlerts((prev) => {
      const next = dismissSingleAlert(prev, alertId);
      saveFavoriteAlerts(next);
      return next;
    });
  }, []);

  const handleClearReadAlerts = useCallback(() => {
    setAlerts((prev) => {
      const next = clearReadFavoriteAlerts(prev);
      saveFavoriteAlerts(next);
      return next;
    });
    showToast('Avisos lidos removidos.');
  }, [showToast]);

  const handleToggleMuteFavorite = useCallback(
    (animeUrl: string) => {
      const { muted, nextMutedUrls } = toggleFavoriteMutedUrl(
        animeUrl,
        mutedFavoriteUrlsRef.current
      );
      setMutedFavoriteUrls(nextMutedUrls);
      saveMutedFavoriteUrls(nextMutedUrls);
      showToast(
        muted
          ? 'Avisos deste anime silenciados.'
          : 'Avisos deste anime reativados!'
      );
    },
    [showToast]
  );

  const handleUnmuteAllFavorites = useCallback(() => {
    setMutedFavoriteUrls([]);
    saveMutedFavoriteUrls([]);
    showToast('Avisos reativados para todos os favoritos!');
  }, [showToast]);

  const handleOpenAlert = useCallback(
    (alert: FavoriteAlertEntry) => {
      setAlerts((prev) => {
        const next = markSingleAlertRead(prev, alert.id);
        saveFavoriteAlerts(next);
        return next;
      });
      void openMediaUrl(alert.episodeUrl, 'episode', {
        title: alert.episodeTitle || `${alert.animeTitle} — ${alert.episodeLabel}`,
        seriesTitle: alert.animeTitle,
        seriesUrl: alert.animeUrl,
        poster: alert.poster,
        backdrop: alert.poster,
        episodeLabel: alert.episodeLabel,
        kind: 'episode',
      });
    },
    [openMediaUrl]
  );

  const handleRequestPushNotifications = useCallback(async () => {
    try {
      const perm = await requestDeviceNotificationPermission();
      setNotificationPermission(perm);
      if (perm === 'granted') {
        showToast('Notificações ativadas neste dispositivo!');
      } else if (perm === 'denied') {
        showToast(
          isNativeAndroidApp()
            ? 'Notificações bloqueadas nas configurações do Android. Alertas continuam no sininho.'
            : 'Notificações bloqueadas no navegador. Alertas continuam no sininho.'
        );
      } else if (perm === 'unsupported') {
        showToast('Este navegador não suporta notificações do sistema.');
      }
    } catch {
      showToast('Não foi possível solicitar permissão de notificação.');
    }
  }, [showToast]);

  const handleSendTestNotification = useCallback(async () => {
    const sampleFav = favoritesRef.current[0];
    const title = sampleFav
      ? `Teste de alerta: ${sampleFav.title}`
      : 'Teste de notificação do Anisync';
    const description =
      'É assim que os avisos de novos episódios aparecem no app e no seu aparelho.';

    if (settingsRef.current.notificationSound) {
      playNotificationChime();
    }

    const systemSent = await deliverSystemNotification({
      title,
      body: description,
      channel: 'episodes',
      tag: 'anisync-test-notification',
      targetUrl: sampleFav?.url,
      targetKind: sampleFav ? 'anime' : undefined,
      bypassQuietHours: true,
      bypassSetting: true,
    });

    showToast(title, {
      kind: 'episode',
      description: systemSent
        ? 'Notificação enviada ao dispositivo e exibida aqui no app.'
        : description,
      poster: sampleFav?.poster || '/pwa-192x192.png',
      actionLabel: sampleFav ? 'Abrir' : undefined,
      onAction: sampleFav ? () => void openMediaUrl(sampleFav.url, sampleFav.kind) : undefined,
      dedupeKey: 'test-notification',
      durationMs: 6000,
    });
  }, [deliverSystemNotification, openMediaUrl, showToast]);

  const unreadAlertCount = useMemo(
    () => alerts.filter((a) => !a.read).length,
    [alerts]
  );

  const quietHoursActive = isWithinQuietHours(settings);

  // Sync PWA App Badge counter with unread notifications + system updates
  useEffect(() => {
    syncAppBadge(unreadAlertCount + (appUpdateResult?.hasUpdate ? 1 : 0));
  }, [appUpdateResult?.hasUpdate, unreadAlertCount]);

  const watchedUrls = useMemo(() => {
    const urls = new Set<string>();
    for (const entry of Object.values(progressMap)) {
      if (!entry?.completed || !entry.url) continue;
      urls.add(entry.url);
      const norm = normalizeTopAnimesUrl(entry.url);
      if (norm) urls.add(norm);
    }
    for (const item of history) {
      if (!item.completed || !item.url) continue;
      urls.add(item.url);
      const norm = normalizeTopAnimesUrl(item.url);
      if (norm) urls.add(norm);
    }
    return urls;
  }, [history, progressMap]);

  const watchedEpisodeKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const url of watchedUrls) {
      const key = canonicalEpisodeProgressKey(url);
      if (key) keys.add(key);
    }
    return keys;
  }, [watchedUrls]);

  watchedEpisodeKeysRef.current = watchedEpisodeKeys;

  const handleToggleEpisodesWatched = useCallback(
    (
      episodes: Array<{
        url: string;
        episodeNumber?: number | null;
        title?: string;
        numberLabel?: string;
      }>,
      watched: boolean,
      options?: { animeUrl?: string; toastMessage?: string }
    ) => {
      const urls = episodes.map((ep) => ep.url).filter(Boolean);
      if (urls.length === 0) return;

      const { map: nextMap, history: nextHistory } = setEpisodesWatched(urls, watched);
      setProgressMap(nextMap);
      if (nextHistory) {
        setHistory(nextHistory);
      }

      if (watched) {
        const keySet = new Set(urls.map((u) => canonicalEpisodeKey(u)).filter(Boolean));
        const hasMatchingUnreadAlert = alertsRef.current.some(
          (a) => !a.read && keySet.has(canonicalEpisodeKey(a.episodeUrl))
        );
        if (hasMatchingUnreadAlert) {
          const nextAlerts = alertsRef.current.map((a) =>
            keySet.has(canonicalEpisodeKey(a.episodeUrl)) ? { ...a, read: true } : a
          );
          setAlerts(nextAlerts);
          saveFavoriteAlerts(nextAlerts);
        }

        if (options?.animeUrl) {
          const favMatch = findMatchingFavorite(options.animeUrl, favoritesRef.current);
          if (favMatch) {
            const nextBaselines = advanceBaselineWithWatchedEpisodes({
              animeUrl: favMatch.url,
              episodes,
              baselines: baselinesRef.current,
            });
            if (nextBaselines !== baselinesRef.current) {
              setBaselines(nextBaselines);
              saveFavoriteBaselines(nextBaselines);
            }
          }
        }
      }

      const defaultMsg =
        urls.length === 1
          ? watched
            ? 'Episódio marcado como visto.'
            : 'Episódio desmarcado como visto.'
          : watched
            ? `${urls.length} episódios marcados como vistos.`
            : `${urls.length} episódios desmarcados.`;
      showToast(options?.toastMessage || defaultMsg);
    },
    [showToast]
  );

  const handleSelectSection = (section: NavSection) => {
    navRequestGenRef.current += 1;
    setActiveSection(section);
    setSearchQuery('');
    setSearchResults(null);
    setSearchPage(1);
    setSearchTotalPages(1);
    setRouteStack([{ view: 'catalog' }]);
  };

  const navigateBackStep = useCallback((): boolean => {
    if (pendingHistoryRemoval) {
      setPendingHistoryRemoval(null);
      return true;
    }
    const step = resolveBackNavigationStep({
      settingsOpen,
      routeStack: routeStackRef.current,
      hasSearchResults: searchResults !== null,
      hasCatalogFilters: Boolean(selectedGenre || selectedYear || selectedGlossary),
      activeSection,
      defaultSection: settings.defaultSection,
    });

    switch (step.type) {
      case 'close-settings':
        setSettingsOpen(false);
        return true;
      case 'pop-route': {
        const reqGen = ++navRequestGenRef.current;
        routeStackRef.current = step.nextStack;
        setRouteStack(step.nextStack);
        setLoadingDetail(false);
        setDetailError('');
        if (step.target.view === 'anime') {
          void loadAnimeDetailsForRoute(step.target.url, reqGen);
        } else if (step.target.view === 'episode') {
          void loadEpisodeDetailsForRoute(step.target.url, reqGen);
        }
        return true;
      }
      case 'clear-search':
        setSearchQuery('');
        setSearchResults(null);
        setSearchPage(1);
        setSearchTotalPages(1);
        return true;
      case 'clear-catalog-filters':
        handleClearCatalogFilters();
        return true;
      case 'switch-section':
        setActiveSection(step.section as NavSection);
        return true;
      case 'at-root':
      default:
        return false;
    }
  }, [
    activeSection,
    handleClearCatalogFilters,
    loadAnimeDetailsForRoute,
    loadEpisodeDetailsForRoute,
    pendingHistoryRemoval,
    searchResults,
    selectedGenre,
    selectedGlossary,
    selectedYear,
    settings.defaultSection,
    settingsOpen,
  ]);

  const navigateBackStepRef = useRef(navigateBackStep);
  navigateBackStepRef.current = navigateBackStep;

  const handleOpenTvCast = useCallback(
    (
      payload: TvCastMediaPayload | null,
      helpers?: {
        pauseLocal?: () => void;
        canPromptWebRemote?: boolean;
        promptWebRemote?: () => Promise<void>;
      }
    ) => {
      if (payload) {
        setTvCastMediaPayload(payload);
      }
      setTvCastWebHelpers(helpers || {});
      setTvCastModalOpen(true);
    },
    []
  );

  // Sync live native background TV Cast state and persist watch progress even after reopening the app
  useEffect(() => {
    let cancelled = false;
    let listenerHandle: { remove: () => Promise<void> } | null = null;

    const applyCastState = (next: TvCastStateSnapshot) => {
      if (cancelled) return;
      setTvCastState(next);
      if (next.episodeUrl && (next.positionMs >= 2000 || next.status === 'stopped')) {
        const posSec = Math.max(0, Math.floor(next.positionMs / 1000));
        const durSec = Math.max(0, Math.floor(next.durationMs / 1000));
        const completed =
          next.status === 'stopped' && durSec > 10 && posSec >= Math.max(5, durSec - 20);
        const prev = lastCastSyncedRef.current;
        if (
          prev.url !== next.episodeUrl ||
          Math.abs(posSec - prev.sec) >= 5 ||
          completed !== prev.completed
        ) {
          lastCastSyncedRef.current = { url: next.episodeUrl, sec: posSec, completed };
          saveEpisodeProgress({
            url: next.episodeUrl,
            positionSec: posSec,
            durationSec: durSec,
            ended: completed,
            meta: next.episodeTitle
              ? {
                  title: next.episodeTitle,
                  seriesTitle: next.seriesTitle || undefined,
                  seriesUrl: next.seriesUrl || undefined,
                  poster: next.poster || '',
                  kind: 'episode',
                  watchedAt: new Date().toISOString(),
                  promoteInHistory: true,
                }
              : undefined,
          });
          refreshProgressState();
        }
      }
    };

    void getNativeTvCastState().then(applyCastState);
    void addTvCastStateListener(applyCastState).then((h) => {
      if (cancelled) {
        void h?.remove();
      } else {
        listenerHandle = h;
      }
    });

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void getNativeTvCastState().then(applyCastState);
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      void listenerHandle?.remove();
    };
  }, [refreshProgressState]);

  // Expose Android native back handler and sync browser popstate on Web
  useEffect(() => {
    window.__topAnimesHandleAndroidBack = () => {
      if (tvCastModalOpenRef.current) {
        setTvCastModalOpen(false);
        return true;
      }
      return navigateBackStepRef.current();
    };

    const onPopState = () => {
      if (isNativeAndroidApp()) return;
      handlingPopstateRef.current = true;
      try {
        navigateBackStepRef.current();
      } finally {
        handlingPopstateRef.current = false;
      }
    };
    window.addEventListener('popstate', onPopState);

    return () => {
      delete window.__topAnimesHandleAndroidBack;
      window.removeEventListener('popstate', onPopState);
    };
  }, []);

  useEffect(() => {
    if (!pendingHistoryRemoval) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPendingHistoryRemoval(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pendingHistoryRemoval]);

  const requestClearAllHistory = useCallback(() => {
    if (history.length === 0) return;
    setPendingHistoryRemoval({ kind: 'all', count: history.length });
  }, [history.length]);

  const requestRemoveHistoryAnime = useCallback(
    (entry: WatchHistoryEntry) => {
      const count = countAnimeEpisodesInHistory(history, entry);
      const animeName = getHistoryEntrySeriesName(entry);
      setPendingHistoryRemoval({
        kind: 'anime',
        entry,
        animeName,
        count: Math.max(1, count),
      });
    },
    [history]
  );

  const confirmPendingHistoryRemoval = useCallback(() => {
    if (!pendingHistoryRemoval) return;
    if (pendingHistoryRemoval.kind === 'all') {
      clearHistory();
      clearAllEpisodeProgress();
      setHistory([]);
      setProgressMap({});
      showToast('Histórico limpo.');
    } else {
      const res = removeHistoryAnime(pendingHistoryRemoval.entry);
      setHistory(res.history);
      setProgressMap(res.progressMap);
      showToast(
        res.removedCount > 1
          ? `${res.removedCount} episódios de ${pendingHistoryRemoval.animeName} removidos do histórico.`
          : `Episódio de ${pendingHistoryRemoval.animeName} removido do histórico.`
      );
    }
    setPendingHistoryRemoval(null);
  }, [pendingHistoryRemoval, showToast]);

  const handleOpenRandom = useCallback(async () => {
    if (loadingRandom) return;
    setLoadingRandom(true);
    try {
      const res = await apiFetch('/api/random');
      const data = (await res.json()) as { url?: string; kind?: MediaKind; error?: string };
      if (!res.ok || !data.url) {
        throw new Error(data.error || 'Não foi possível sortear um título.');
      }
      await openMediaUrl(data.url, data.kind);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Não foi possível sortear um título.');
    } finally {
      setLoadingRandom(false);
    }
  }, [loadingRandom, openMediaUrl, showToast]);

  const settingsSnapshotOnOpenRef = useRef<{ catalog: string; sources: string } | null>(null);

  const openSettingsModal = useCallback(
    (section: 'sources' | 'catalog' | 'notifications' | 'updates' | 'general' = 'general') => {
      settingsSnapshotOnOpenRef.current = {
        catalog: JSON.stringify({
          creds: settingsRef.current.catalogCredentials,
        }),
        sources: JSON.stringify(settingsRef.current.episodeSources),
      };
      setSettingsFocusSection(section);
      setSettingsOpen(true);
    },
    []
  );

  openNotificationTargetRef.current = (targetUrl: string, targetKind?: string) => {
    if (targetKind === 'settings') {
      openSettingsModal('updates');
      return;
    }
    if (targetUrl) {
      const mediaKind: MediaKind =
        targetKind === 'anime' || targetKind === 'movie' || targetKind === 'series'
          ? targetKind
          : 'episode';
      void openMediaUrl(targetUrl, mediaKind);
    }
  };

  // Handle deep-link taps from native Android notifications (cold start & warm intent)
  useEffect(() => {
    window.__anisyncOpenNotificationTarget = (url: string, kind?: string) => {
      openNotificationTargetRef.current(url, kind);
    };

    const checkPendingTarget = async () => {
      const pending = await consumePendingNotificationTarget();
      if (!pending) return;
      openNotificationTargetRef.current(pending.url, pending.kind);
    };

    void checkPendingTarget();
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void checkPendingTarget();
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      delete window.__anisyncOpenNotificationTarget;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const closeSettingsModal = useCallback(() => {
    setSettingsOpen(false);
    const snap = settingsSnapshotOnOpenRef.current;
    settingsSnapshotOnOpenRef.current = null;
    if (snap) {
      const nextCatalogSnap = JSON.stringify({
        creds: settingsRef.current.catalogCredentials,
      });
      const nextSourcesSnap = JSON.stringify(settingsRef.current.episodeSources);
      if (nextCatalogSnap !== snap.catalog || nextSourcesSnap !== snap.sources) {
        void fetchCatalog();
      }
      if (nextSourcesSnap !== snap.sources && routeRef.current.view === 'episode') {
        handleRefreshEpisodeSources();
      }
    }
    if (
      apkDownloadProgress?.stage === 'error' ||
      apkDownloadProgress?.stage === 'installed' ||
      apkDownloadProgress?.stage === 'cancelled'
    ) {
      handleDismissApkProgress();
    }
  }, [
    apkDownloadProgress?.stage,
    fetchCatalog,
    handleDismissApkProgress,
    handleRefreshEpisodeSources,
  ]);

  const pageScopeKey =
    route.view === 'catalog'
      ? `catalog:${activeSection}:${archiveCategory}:${selectedGenre}:${selectedYear}:${selectedGlossary}:${searchQuery}`
      : `${route.view}:${route.url}`;

  const { documentLoading, pendingVisibleImages } = usePageImagesPending(mainRef, pageScopeKey);

  const isEpisodeExtraServersActive = Boolean(
    route.view === 'episode' &&
      episodeDetails &&
      loadingExtraServers &&
      isSameEpisodeUrl(loadingExtraServers.episodeUrl, episodeDetails.url)
  );

  const isPageLoadingRaw = isActivePageLoading({
    routeView: route.view,
    activeSection,
    documentLoading,
    routeChunkLoading,
    loadingCatalog,
    loadingInitialReleases,
    loadingMoreReleases,
    loadingWeeklyCalendar,
    weeklyCalendarInitialized,
    hasCalendarError: Boolean(calendarError),
    loadingArchiveCategory: archiveState[archiveCategory].loading,
    archiveCategoryInitialized: archiveState[archiveCategory].initialized,
    hasActiveCatalogFilter: Boolean(selectedGenre || selectedYear || selectedGlossary),
    loadingFilteredCatalog: filteredCatalog.loading,
    searching,
    loadingMoreSearch,
    loadingRandom,
    loadingDetail,
    animeDetailStage,
    animeViewHydrating,
    loadingExtraServers: isEpisodeExtraServersActive,
    episodeViewLoading,
    pendingVisibleImages,
  });

  const isHeaderBusy = useSettledLoadingIndicator(isPageLoadingRaw);

  return (
    <div className="min-h-screen bg-[#0d0f12] text-[#f1f5f9]">
      <Header
        activeSection={activeSection}
        isBusy={isHeaderBusy}
        onSelectSection={handleSelectSection}
        onPrefetchSection={handlePrefetchSection}
        onPrefetchSettings={() => preloadRouteChunk('settings')}
        onGoHome={() => handleSelectSection('releases')}
        alerts={alerts}
        unreadCount={unreadAlertCount}
        checkingAlerts={checkingAlerts}
        lastEpisodeCheckAt={settingsMeta.lastEpisodeCheckAt}
        notificationPermission={notificationPermission}
        quietHoursActive={quietHoursActive}
        quietHoursEnd={settings.quietHoursEnd}
        onCheckAlerts={() => void checkFavoriteUpdates({ manual: true })}
        onMarkAllRead={handleMarkAllAlertsRead}
        onMarkAlertRead={handleMarkAlertRead}
        onDismissAlert={handleDismissAlert}
        onClearReadAlerts={handleClearReadAlerts}
        onOpenAlert={handleOpenAlert}
        onOpenAlertAnime={(animeUrl) => void openMediaUrl(animeUrl, 'anime')}
        onRequestPushNotifications={() => void handleRequestPushNotifications()}
        onSendTestNotification={() => void handleSendTestNotification()}
        onOpenNotificationSettings={() => openSettingsModal('notifications')}
        onOpenUpdateSettings={() => openSettingsModal('updates')}
        hasAppUpdate={Boolean(appUpdateResult?.hasUpdate)}
        latestRelease={appUpdateResult?.latestRelease || null}
        onOpenSettings={() => openSettingsModal('general')}
      />

      {!isOnline && (
        <div className="border-b border-amber-500/30 bg-amber-500/15 px-4 py-2 text-center text-xs font-medium text-amber-200">
          <span className="inline-flex items-center gap-2">
            <WifiOff className="h-3.5 w-3.5" />
            Sem conexão com a internet — exibindo catálogo salvo quando disponível.
          </span>
        </div>
      )}

      <main ref={mainRef} className="pb-24 md:pb-16">
        <div className={route.view === 'catalog' ? '' : 'hidden'} aria-hidden={route.view !== 'catalog'}>
          <CatalogView
            catalog={catalog}
            loading={loadingCatalog}
            error={catalogError}
            activeSection={activeSection}
            isHidden={route.view !== 'catalog'}
            searchQuery={searchQuery}
            searchResults={searchResults}
            searching={searching}
            searchPage={searchPage}
            searchTotalPages={searchTotalPages}
            loadingMoreSearch={loadingMoreSearch}
            loadingRandom={loadingRandom}
            releases={releases}
            releasesPage={releasesPage}
            releasesTotalPages={releasesTotalPages}
            loadingMoreReleases={loadingMoreReleases}
            archiveCategory={archiveCategory}
            archiveState={archiveState}
            featuredAnimes={featuredAnimes}
            sliderMovies={sliderMovies}
            catalogFilters={catalogFilters}
            selectedGenre={selectedGenre}
            selectedYear={selectedYear}
            selectedGlossary={selectedGlossary}
            filteredCatalog={filteredCatalog}
            weeklyCalendarDays={weeklyCalendarDays}
            selectedCalendarDay={selectedCalendarDay}
            calendarScheduleMode={settings.calendarScheduleMode}
            calendarLayout={settings.calendarLayout}
            loadingWeeklyCalendar={loadingWeeklyCalendar}
            calendarError={calendarError}
            favorites={favorites}
            mutedFavoriteUrls={mutedFavoriteUrls}
            history={history}
            alerts={alerts}
            checkingAlerts={checkingAlerts}
            lastEpisodeCheckAt={settingsMeta.lastEpisodeCheckAt}
            notificationPermission={notificationPermission}
            onRetryCatalog={fetchCatalog}
            onSearch={handleSearch}
            onLoadMoreSearch={handleLoadMoreSearch}
            onClearSearch={() => {
              setSearchQuery('');
              setSearchResults(null);
              setSearchPage(1);
              setSearchTotalPages(1);
            }}
            onOpenRandom={() => void handleOpenRandom()}
            onLoadMoreReleases={handleLoadMoreReleases}
            onSelectArchiveCategory={handleSelectArchiveCategory}
            onLoadMoreArchiveCategory={handleLoadMoreArchiveCategory}
            onSelectGenre={handleSelectGenre}
            onSelectYear={handleSelectYear}
            onSelectGlossary={handleSelectGlossary}
            onClearCatalogFilters={handleClearCatalogFilters}
            onLoadMoreFiltered={handleLoadMoreFiltered}
            onSelectCalendarDay={setSelectedCalendarDay}
            onChangeCalendarScheduleMode={handleChangeCalendarScheduleMode}
            onChangeCalendarLayout={handleChangeCalendarLayout}
            onRefreshCalendar={() => void fetchWeeklyCalendar({ refresh: true })}
            onOpenItem={openMediaUrl}
            onPrefetchItem={handlePrefetchItem}
            onPrefetchArchiveCategory={handlePrefetchArchiveCategory}
            onPrefetchCalendarMode={handlePrefetchCalendarMode}
            onPrefetchMoreReleases={handlePrefetchMoreReleases}
            onPrefetchMoreArchive={handlePrefetchMoreArchive}
            onPrefetchMoreFiltered={handlePrefetchMoreFiltered}
            onPrefetchMoreSearch={handlePrefetchMoreSearch}
            onToggleFavorite={toggleFavorite}
            onToggleMuteFavorite={handleToggleMuteFavorite}
            onCheckFavoriteUpdates={() => void checkFavoriteUpdates({ manual: true })}
            onMarkAllAlertsRead={handleMarkAllAlertsRead}
            onMarkAlertRead={handleMarkAlertRead}
            onDismissAlert={handleDismissAlert}
            onClearReadAlerts={handleClearReadAlerts}
            onOpenAlert={handleOpenAlert}
            onRequestPushNotifications={() => void handleRequestPushNotifications()}
            onSendTestNotification={() => void handleSendTestNotification()}
            onOpenNotificationSettings={() => openSettingsModal('notifications')}
            onClearHistory={requestClearAllHistory}
            onRemoveHistoryEntry={(entry) => {
              const res = removeHistoryEpisode(entry.url);
              setHistory(res.history);
              setProgressMap(res.progressMap);
              showToast('Episódio removido do histórico.');
            }}
            onRemoveHistoryAnime={requestRemoveHistoryAnime}
            onSelectSection={handleSelectSection}
            defaultAudioFilter={settings.defaultAudioFilter}
            watchedEpisodeKeys={watchedEpisodeKeys}
          />
        </div>

        {route.view === 'anime' && (
          <>
            {loadingDetail && !animeDetails ? (
              <div
                data-anime-profile-skeleton="true"
                aria-label="Carregando perfil do anime no TheTVDB"
                className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8"
              >
                <div className="mb-5 flex items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => navigateBackStep()}
                    className="inline-flex items-center gap-2 text-sm font-medium text-slate-400 transition-colors hover:text-white"
                  >
                    <ArrowLeft className="h-4 w-4" />
                    <span>Voltar</span>
                  </button>
                </div>

                <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#151921]">
                  <div className="md:grid md:grid-cols-[230px_1fr] md:items-start md:gap-6 md:p-6 lg:grid-cols-[250px_1fr] lg:gap-8 lg:p-7 xl:grid-cols-[264px_1fr]">
                    <div className="anisync-shimmer aspect-[4/5] w-full bg-[#0d0f12] md:aspect-[2/3] md:rounded-xl" />
                    <div className="space-y-4 px-4 pb-5 pt-4 sm:px-6 sm:pb-6 md:p-0">
                      <div className="space-y-2.5">
                        <div className="anisync-shimmer h-7 w-2/3 rounded-lg" />
                        <div className="anisync-shimmer h-4 w-1/2 rounded" />
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          <div className="anisync-shimmer h-6 w-16 rounded-full" />
                          <div className="anisync-shimmer h-6 w-20 rounded-full" />
                          <div className="anisync-shimmer h-6 w-20 rounded-full" />
                          <div className="anisync-shimmer h-6 w-16 rounded-full" />
                        </div>
                      </div>
                      <div className="space-y-2 border-t border-white/10 pt-3.5">
                        <div className="anisync-shimmer h-3.5 w-full rounded" />
                        <div className="anisync-shimmer h-3.5 w-11/12 rounded" />
                        <div className="anisync-shimmer h-3.5 w-4/5 rounded" />
                      </div>
                      <div className="anisync-shimmer h-32 rounded-xl border border-white/8" />
                      <div className="flex gap-2.5 pt-1">
                        <div className="anisync-shimmer h-11 w-44 rounded-xl" />
                        <div className="anisync-shimmer h-11 w-28 rounded-xl" />
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-8 space-y-3">
                  <div className="anisync-shimmer h-6 w-36 rounded-lg" />
                  <div className="anisync-shimmer h-20 rounded-xl border border-white/8" />
                  <div className="anisync-shimmer h-20 rounded-xl border border-white/8" />
                  <div className="anisync-shimmer h-20 rounded-xl border border-white/8" />
                </div>
              </div>
            ) : detailError && !animeDetails ? (
              <div className="mx-auto max-w-2xl px-4 py-12 text-center">
                <div className="rounded-xl border border-red-500/20 bg-[#151921] p-8">
                  <p className="text-sm text-red-200">{detailError}</p>
                  <button
                    type="button"
                    onClick={() => setRouteStack([{ view: 'catalog' }])}
                    className="mt-4 rounded-lg bg-[#f97316] px-4 py-2 text-xs font-semibold text-[#0d0f12]"
                  >
                    Voltar ao catálogo
                  </button>
                </div>
              </div>
            ) : animeDetails ? (
              <Suspense
                fallback={
                  <RouteSuspenseFallback onPendingChange={setRouteChunkLoading}>
                    <div className="mx-auto max-w-7xl space-y-4 px-4 py-8 sm:px-6 lg:px-8">
                      <div className="anisync-shimmer h-64 rounded-2xl border border-white/8" />
                      <div className="anisync-shimmer h-44 rounded-xl border border-white/8" />
                    </div>
                  </RouteSuspenseFallback>
                }
              >
                <AnimeDetailView
                  anime={animeDetails}
                  isFavorite={isItemFavorited(animeDetails.url, favorites)}
                  isMuted={isFavoriteMuted(animeDetails.url, mutedFavoriteUrls)}
                  watchedUrls={watchedUrls}
                  progressMap={progressMap}
                  loadingStage={animeDetailStage}
                  detailError={detailError}
                  onRetryDetail={() => {
                    const reqGen = ++navRequestGenRef.current;
                    void loadAnimeDetailsForRoute(animeDetails.url, reqGen);
                  }}
                  onToggleFavorite={toggleFavorite}
                  onToggleMuteFavorite={handleToggleMuteFavorite}
                  onToggleEpisodesWatched={(eps, watched, label) =>
                    handleToggleEpisodesWatched(eps, watched, {
                      animeUrl: animeDetails.url,
                      toastMessage: label,
                    })
                  }
                  onOpenEpisode={(epUrl, seed) => openMediaUrl(epUrl, 'episode', seed)}
                  onOpenAnime={(animeUrl, seed) => void openMediaUrl(animeUrl, 'anime', seed)}
                  onPrefetchEpisode={handlePrefetchEpisode}
                  onPrefetchAnime={handlePrefetchAnime}
                  onLoadingStateChange={setAnimeViewHydrating}
                  onBack={() => navigateBackStep()}
                />
              </Suspense>
            ) : null}
          </>
        )}

        {route.view === 'episode' && (
          <>
            {loadingDetail && !episodeDetails ? (
              <div className="mx-auto max-w-5xl space-y-4 px-4 py-8 sm:px-6 lg:px-8">
                <div className="anisync-shimmer aspect-video rounded-xl border border-white/8" />
                <div className="anisync-shimmer h-44 rounded-xl border border-white/8" />
              </div>
            ) : detailError && !episodeDetails ? (
              <div className="mx-auto max-w-2xl px-4 py-12 text-center">
                <div className="rounded-xl border border-red-500/20 bg-[#151921] p-8">
                  <p className="text-sm text-red-200">{detailError}</p>
                  <button
                    type="button"
                    onClick={() => setRouteStack([{ view: 'catalog' }])}
                    className="mt-4 rounded-lg bg-[#f97316] px-4 py-2 text-xs font-semibold text-[#0d0f12]"
                  >
                    Voltar ao catálogo
                  </button>
                </div>
              </div>
            ) : episodeDetails ? (
              <Suspense
                fallback={
                  <RouteSuspenseFallback onPendingChange={setRouteChunkLoading}>
                    <div className="mx-auto max-w-5xl space-y-4 px-4 py-8 sm:px-6 lg:px-8">
                      <div className="anisync-shimmer aspect-video rounded-xl border border-white/8" />
                      <div className="anisync-shimmer h-44 rounded-xl border border-white/8" />
                    </div>
                  </RouteSuspenseFallback>
                }
              >
                {(() => {
                  const matchedTrackEpisodes = resolveSeriesEpisodesForEpisode(
                    animeDetails,
                    episodeDetails.url,
                    episodeDetails.seriesUrl
                  );
                  const matchesLoadedAnime =
                    Boolean(matchedTrackEpisodes) ||
                    Boolean(
                      animeDetails &&
                        episodeDetails.seriesUrl &&
                        normalizeTopAnimesUrl(animeDetails.url) ===
                          normalizeTopAnimesUrl(episodeDetails.seriesUrl)
                    );
                  return (
                    <EpisodeWorkspace
                      episode={episodeDetails}
                      isFavorite={isItemFavorited(
                        episodeDetails.seriesUrl || episodeDetails.url,
                        favorites
                      )}
                      isMuted={isFavoriteMuted(
                        episodeDetails.seriesUrl || episodeDetails.url,
                        mutedFavoriteUrls
                      )}
                      watchedUrls={watchedUrls}
                      progressMap={progressMap}
                      initialSeriesEpisodes={matchedTrackEpisodes}
                      initialSeriesArtwork={
                        matchesLoadedAnime && animeDetails
                          ? {
                              poster: animeDetails.poster || undefined,
                              backdrop: animeDetails.backdrop || undefined,
                            }
                          : undefined
                      }
                      initialSeriesExternalIds={
                        matchesLoadedAnime ? animeDetails?.externalIds : undefined
                      }
                      initialSeriesGenres={
                        matchesLoadedAnime ? animeDetails?.genres : undefined
                      }
                      initialSeriesKind={
                        matchesLoadedAnime ? animeDetails?.kind : undefined
                      }
                      initialSeriesAudioType={
                        matchesLoadedAnime ? animeDetails?.audioType : undefined
                      }
                  loadingEpisode={loadingDetail}
                  loadingExtraServers={Boolean(
                    loadingExtraServers &&
                      isSameEpisodeUrl(loadingExtraServers.episodeUrl, episodeDetails.url)
                  )}
                  loadingExtraServerNames={
                    loadingExtraServers &&
                    isSameEpisodeUrl(loadingExtraServers.episodeUrl, episodeDetails.url)
                      ? loadingExtraServers.sourceNames
                      : []
                  }
                  onToggleFavorite={toggleFavorite}
                  onToggleMuteFavorite={handleToggleMuteFavorite}
                  onToggleEpisodeWatched={(ep, watched) =>
                    handleToggleEpisodesWatched(
                      [
                        {
                          url: ep.url,
                          title: ep.title,
                          numberLabel: ep.episodeLabel || '',
                        },
                      ],
                      watched,
                      {
                        animeUrl: ep.seriesUrl || ep.url,
                      }
                    )
                  }
                  onBack={() => navigateBackStep()}
                  onNavigateUrl={openMediaUrl}
                  onPrefetchEpisode={handlePrefetchEpisode}
                  onPrefetchAnime={handlePrefetchAnime}
                  onRefreshSources={handleRefreshEpisodeSources}
                  onNativeSessionSync={(result) => {
                    syncNativeSessionResult(result, {
                      url: episodeDetails.url,
                      title: episodeDetails.title,
                      seriesTitle: episodeDetails.seriesTitle,
                      seriesUrl: episodeDetails.seriesUrl,
                      poster: episodeDetails.backdrop || episodeDetails.poster,
                      isMovie: episodeDetails.isMovie,
                    });
                    if (
                      result.episodeUrl &&
                      !isSameEpisodeUrl(result.episodeUrl, episodeDetails.url)
                    ) {
                      void openMediaUrl(result.episodeUrl, 'episode');
                    } else if (result.action === 'prev' && episodeDetails.prevUrl) {
                      void openMediaUrl(episodeDetails.prevUrl, 'episode');
                    } else if (result.action === 'next' && episodeDetails.nextUrl) {
                      void openMediaUrl(episodeDetails.nextUrl, 'episode');
                    }
                  }}
                  onPlaybackProgress={refreshProgressState}
                  onToast={showToast}
                  skipIntroSeconds={85}
                  autoPlayNextEpisode={settings.autoPlayNextEpisode}
                  videoScale={settings.videoScale}
                  onChangeVideoScale={(videoScale) => updateSettings({ videoScale })}
                  castState={tvCastState}
                  onOpenTvCast={handleOpenTvCast}
                  onLoadingStateChange={setEpisodeViewLoading}
                />
                  );
                })()}
              </Suspense>
            ) : null}
          </>
        )}
      </main>

      <ActiveCastBar
        castState={tvCastState}
        onOpenControls={() => setTvCastModalOpen(true)}
        onStop={() => showToast('Transmissão encerrada na TV.')}
      />

      <MobileTabBar
        activeSection={activeSection}
        unreadCount={unreadAlertCount}
        onSelectSection={handleSelectSection}
        onPrefetchSection={handlePrefetchSection}
      />

      <TvCastModal
        open={tvCastModalOpen}
        onClose={() => setTvCastModalOpen(false)}
        castState={tvCastState}
        mediaPayload={tvCastMediaPayload}
        skipIntroSeconds={settings.skipIntroSeconds}
        canPromptWebRemote={Boolean(tvCastWebHelpers.canPromptWebRemote)}
        onPromptWebRemote={tvCastWebHelpers.promptWebRemote}
        onPauseLocalPlayback={tvCastWebHelpers.pauseLocal}
        onToast={showToast}
      />

      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsModal
            open={settingsOpen}
            focusSection={settingsFocusSection}
            onClose={closeSettingsModal}
            settings={settings}
            settingsMeta={settingsMeta}
            onUpdateSettings={updateSettings}
            onResetSettings={resetSettings}
            favoritesCount={favorites.length}
            mutedFavoritesCount={mutedFavoriteUrls.length}
            checkingEpisodes={checkingAlerts}
            notificationPermission={notificationPermission}
            onCheckEpisodesNow={() => {
              void fetchCatalog();
              void checkFavoriteUpdates({ manual: true });
            }}
            onRequestPushNotifications={() => void handleRequestPushNotifications()}
            onSendTestNotification={() => void handleSendTestNotification()}
            onUnmuteAllFavorites={handleUnmuteAllFavorites}
            buildInfo={buildInfo}
            isNativeAndroid={isNativeAndroidApp()}
            appUpdateResult={appUpdateResult}
            checkingAppUpdate={checkingAppUpdate}
            appUpdateError={appUpdateError}
            downloadingAppUpdate={downloadingAppUpdate}
            apkDownloadProgress={apkDownloadProgress}
            swUpdateAvailable={swUpdateAvailable}
            onCheckAppUpdateNow={() => void checkForAppUpdates({ manual: true })}
            onDownloadAppUpdate={() => void handleDownloadAppUpdate()}
            onCancelAppUpdate={handleCancelAppUpdate}
            onDismissApkProgress={handleDismissApkProgress}
            onApplySwUpdate={handleApplySwUpdate}
            historyCount={history.length}
            alertsCount={alerts.length}
            onClearHistory={requestClearAllHistory}
            onClearAlerts={() => {
              clearFavoriteAlerts();
              setAlerts([]);
              showToast('Avisos limpos.');
            }}
            onExportBackup={handleExportBackup}
            onImportBackup={handleImportBackup}
          />
        </Suspense>
      )}

      {pendingHistoryRemoval && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="confirm-history-removal-title"
          aria-describedby="confirm-history-removal-desc"
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
          onClick={() => setPendingHistoryRemoval(null)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-white/12 bg-[#151921] p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-rose-500/35 bg-rose-500/15 text-rose-400">
                <Trash2 className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h2
                  id="confirm-history-removal-title"
                  className="text-base font-bold text-white"
                >
                  {pendingHistoryRemoval.kind === 'all'
                    ? 'Limpar todo o histórico?'
                    : `Remover todos de ${pendingHistoryRemoval.animeName}?`}
                </h2>
                <p
                  id="confirm-history-removal-desc"
                  className="mt-1.5 text-xs leading-relaxed text-slate-300"
                >
                  {pendingHistoryRemoval.kind === 'all'
                    ? `Isso vai remover ${pendingHistoryRemoval.count} ${
                        pendingHistoryRemoval.count === 1 ? 'item' : 'itens'
                      } do histórico e apagar o progresso salvo dos episódios.`
                    : pendingHistoryRemoval.count > 1
                      ? `Isso vai remover todos os ${pendingHistoryRemoval.count} episódios de "${pendingHistoryRemoval.animeName}" do histórico e apagar o progresso salvo deles.`
                      : `Isso vai remover todos os registros de "${pendingHistoryRemoval.animeName}" do histórico e apagar o progresso salvo.`}
                </p>
              </div>
            </div>

            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingHistoryRemoval(null)}
                className="min-h-[40px] rounded-lg border border-white/12 bg-[#0d0f12] px-4 py-2 text-xs font-semibold text-slate-200 transition-colors hover:border-white/25 hover:text-white"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={confirmPendingHistoryRemoval}
                className="min-h-[40px] rounded-lg bg-rose-500 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-rose-400"
              >
                {pendingHistoryRemoval.kind === 'all'
                  ? 'Limpar histórico'
                  : 'Remover todos'}
              </button>
            </div>
          </div>
        </div>
      )}

      <NotificationToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
