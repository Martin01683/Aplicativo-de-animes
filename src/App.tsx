import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { WifiOff } from 'lucide-react';
import { AnimeDetailView } from './components/AnimeDetailView';
import { CatalogView } from './components/CatalogView';
import { EpisodeWorkspace } from './components/EpisodeWorkspace';
import { Header, type NavSection } from './components/Header';
import { MobileTabBar } from './components/MobileTabBar';
import { SettingsModal } from './components/SettingsModal';
import { useOnlineStatus } from './hooks/useOnlineStatus';
import {
  addApkDownloadProgressListener,
  apiFetch,
  downloadAppUpdateApk,
  getNativeAppBuildInfo,
  isNativeAndroidApp,
  type ApkDownloadProgressEvent,
} from './lib/apiClient';
import {
  buildReleaseIdentityKey,
  evaluateUpdateStatus,
  getAppBuildInfo,
  type AppBuildInfo,
  type AppUpdateCheckResult,
  type RemoteAppRelease,
} from './lib/appUpdater';
import {
  buildFavoriteBaseline,
  detectNewFavoriteEpisodes,
  findMatchingFavorite,
  isItemFavorited,
  normalizeTopAnimesUrl,
  toSeriesFavoriteItem,
} from './lib/favoriteAlerts';
import { isSameEpisodeUrl, setNativeVlcVideoScale } from './lib/nativeVlcPlayer';
import {
  sanitizeVideoScaleMode,
  type EpisodeProgressMap,
} from './lib/playbackProgress';
import {
  pushRouteFrame,
  resolveBackNavigationStep,
  type AppRouteFrame,
} from './lib/navigationHistory';
import {
  DEFAULT_APP_SETTINGS,
  getEpisodeCheckIntervalMs,
  shouldRunScheduledAppUpdateCheck,
  type AppSettings,
  type AppSettingsMeta,
} from './lib/settings';
import {
  clearAllEpisodeProgress,
  clearFavoriteAlerts,
  clearHistory,
  loadAcknowledgedReleaseKey,
  loadAppSettings,
  loadAppSettingsMeta,
  loadEpisodeProgressMap,
  loadFavoriteAlerts,
  loadFavoriteBaselines,
  loadFavorites,
  loadHistory,
  pushHistoryEntry,
  saveAcknowledgedReleaseKey,
  saveAppSettings,
  saveAppSettingsMeta,
  saveEpisodeProgress,
  saveFavoriteAlerts,
  saveFavoriteBaselines,
  saveFavorites,
} from './lib/storage';
import type {
  AnimeDetails,
  CatalogArchiveCategory,
  CatalogFilters,
  CatalogMediaItem,
  EpisodeDetails,
  FavoriteAlertEntry,
  FavoriteBaselineMap,
  FavoriteLatestInfo,
  HomeCatalog,
  MediaKind,
  PaginatedCatalogResponse,
  PaginatedSearchResponse,
  SearchResultItem,
  SliderMovieItem,
  WatchHistoryEntry,
} from './lib/types';

type ActiveRoute = AppRouteFrame;

declare global {
  interface Window {
    __topAnimesHandleAndroidBack?: () => boolean;
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

export default function App() {
  const isOnline = useOnlineStatus();
  const [settings, setSettings] = useState<AppSettings>(() => loadAppSettings());
  const [settingsMeta, setSettingsMeta] = useState<AppSettingsMeta>(() => loadAppSettingsMeta());
  const [acknowledgedReleaseKey, setAcknowledgedReleaseKey] = useState<string | null>(() =>
    loadAcknowledgedReleaseKey()
  );
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [routeStack, setRouteStack] = useState<ActiveRoute[]>([{ view: 'catalog' }]);
  const route = routeStack[routeStack.length - 1] ?? { view: 'catalog' };
  const [activeSection, setActiveSection] = useState<NavSection>(() => loadAppSettings().defaultSection);

  const [catalog, setCatalog] = useState<HomeCatalog | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [catalogError, setCatalogError] = useState('');

  const [releases, setReleases] = useState<CatalogMediaItem[]>([]);
  const [releasesPage, setReleasesPage] = useState(1);
  const [releasesTotalPages, setReleasesTotalPages] = useState(1);
  const [loadingMoreReleases, setLoadingMoreReleases] = useState(false);

  const [archiveCategory, setArchiveCategory] = useState<CatalogArchiveCategory>('animes');
  const [archiveState, setArchiveState] = useState<
    Record<CatalogArchiveCategory, ArchiveCategoryBucket>
  >({
    animes: { ...EMPTY_BUCKET },
    movies: { ...EMPTY_BUCKET },
    dublado: { ...EMPTY_BUCKET },
    legendado: { ...EMPTY_BUCKET },
    donghua: { ...EMPTY_BUCKET },
    cartoon: { ...EMPTY_BUCKET },
    'live-action': { ...EMPTY_BUCKET },
  });
  const [featuredAnimes, setFeaturedAnimes] = useState<CatalogMediaItem[]>([]);
  const [sliderMovies, setSliderMovies] = useState<SliderMovieItem[]>([]);
  const [catalogFilters, setCatalogFilters] = useState<CatalogFilters>({
    genres: [],
    years: [],
    types: [],
  });
  const [selectedGenre, setSelectedGenre] = useState('');
  const [selectedYear, setSelectedYear] = useState('');
  const [filteredCatalog, setFilteredCatalog] = useState<ArchiveCategoryBucket>({
    ...EMPTY_BUCKET,
  });

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResultItem[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchPage, setSearchPage] = useState(1);
  const [searchTotalPages, setSearchTotalPages] = useState(1);
  const [loadingMoreSearch, setLoadingMoreSearch] = useState(false);
  const [loadingRandom, setLoadingRandom] = useState(false);

  const [animeDetails, setAnimeDetails] = useState<AnimeDetails | null>(null);
  const [episodeDetails, setEpisodeDetails] = useState<EpisodeDetails | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState('');

  const [favorites, setFavorites] = useState<CatalogMediaItem[]>(() => loadFavorites());
  const [baselines, setBaselines] = useState<FavoriteBaselineMap>(() => loadFavoriteBaselines());
  const [alerts, setAlerts] = useState<FavoriteAlertEntry[]>(() => loadFavoriteAlerts());
  const [checkingAlerts, setCheckingAlerts] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState<
    NotificationPermission | 'unsupported'
  >(() =>
    typeof window !== 'undefined' && 'Notification' in window
      ? Notification.permission
      : 'unsupported'
  );
  const [history, setHistory] = useState<WatchHistoryEntry[]>(() => loadHistory());
  const [progressMap, setProgressMap] = useState<EpisodeProgressMap>(() =>
    loadEpisodeProgressMap()
  );
  const [toast, setToast] = useState<string>('');

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

  const favoritesRef = useRef(favorites);
  const baselinesRef = useRef(baselines);
  const alertsRef = useRef(alerts);
  const releasesRef = useRef(releases);
  const settingsRef = useRef(settings);
  const settingsMetaRef = useRef(settingsMeta);
  const buildInfoRef = useRef(buildInfo);
  const acknowledgedReleaseKeyRef = useRef(acknowledgedReleaseKey);
  const routeRef = useRef(route);
  const routeStackRef = useRef(routeStack);
  const animeDetailsCacheRef = useRef<Map<string, AnimeDetails>>(new Map());
  const episodeDetailsCacheRef = useRef<Map<string, EpisodeDetails>>(new Map());
  const navRequestGenRef = useRef(0);
  const handlingPopstateRef = useRef(false);
  const initialCheckDoneRef = useRef(false);
  const autoDownloadTriggeredForRef = useRef<string | null>(null);

  favoritesRef.current = favorites;
  baselinesRef.current = baselines;
  alertsRef.current = alerts;
  releasesRef.current = releases;
  settingsRef.current = settings;
  settingsMetaRef.current = settingsMeta;
  buildInfoRef.current = buildInfo;
  acknowledgedReleaseKeyRef.current = acknowledgedReleaseKey;
  routeRef.current = route;
  routeStackRef.current = routeStack;

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => {
      setToast((current) => (current === message ? '' : current));
    }, 3500);
  }, []);

  const refreshProgressState = useCallback(() => {
    setProgressMap(loadEpisodeProgressMap());
    setHistory(loadHistory());
  }, []);

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    if (patch.videoScale) {
      void setNativeVlcVideoScale(sanitizeVideoScaleMode(patch.videoScale));
    }
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveAppSettings(next);
      return next;
    });
  }, []);

  const resetSettings = useCallback(() => {
    const defaults = { ...DEFAULT_APP_SETTINGS };
    setSettings(defaults);
    saveAppSettings(defaults);
    void setNativeVlcVideoScale(defaults.videoScale);
    showToast('Configurações restauradas para o padrão.');
  }, [showToast]);

  const dispatchDeviceNotifications = useCallback(async (newAlerts: FavoriteAlertEntry[]) => {
    if (!settingsRef.current.notifyNewEpisodes) return;
    if (!newAlerts.length) return;
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;

    const first = newAlerts[0];
    const title =
      newAlerts.length === 1
        ? `Novo episódio: ${first.animeTitle}`
        : `${newAlerts.length} novos episódios dos favoritos`;
    const body =
      newAlerts.length === 1
        ? `${first.episodeLabel} já está disponível para assistir.`
        : `${first.animeTitle} (${first.episodeLabel}) e mais ${newAlerts.length - 1} anime(s).`;

    try {
      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.ready;
        if (reg && typeof reg.showNotification === 'function') {
          await reg.showNotification(title, {
            body,
            icon: '/pwa-192x192.png',
            badge: '/pwa-192x192.png',
            tag: `topanimes-${first.id}`,
          });
          return;
        }
      }
      new Notification(title, {
        body,
        icon: '/pwa-192x192.png',
      });
    } catch {
      // Ignore browser notification restrictions
    }
  }, []);

  const checkFavoriteUpdates = useCallback(
    async (options: { manual?: boolean; currentReleases?: CatalogMediaItem[] } = {}) => {
      const currentFavs = favoritesRef.current;
      const currentReleases = options.currentReleases || releasesRef.current;
      if (!currentFavs.length) {
        if (options.manual) {
          showToast('Favorite um anime primeiro para verificar novos episódios.');
        }
        return;
      }

      setCheckingAlerts(true);
      try {
        let latestByAnimeUrl: Record<string, FavoriteLatestInfo> = {};
        const seriesUrls = currentFavs
          .filter((f) => f.kind !== 'movie' && !/\/filmes\//i.test(f.url))
          .map((f) => f.url)
          .slice(0, 10);

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
          showToast(
            detection.newAlerts.length === 1
              ? `Novo episódio: ${first.animeTitle} (${first.episodeLabel})`
              : `${detection.newAlerts.length} novos episódios dos favoritos!`
          );
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

  const handleDownloadAppUpdate = useCallback(
    async (explicitRelease?: RemoteAppRelease | null) => {
      const targetRelease = explicitRelease || appUpdateResult?.latestRelease;
      const asset = targetRelease?.apkAsset;
      if (!asset?.downloadUrl) {
        showToast('Nenhum arquivo de atualização encontrado nesta release.');
        return;
      }
      pendingUpdateReleaseRef.current = targetRelease || null;
      setDownloadingAppUpdate(true);
      setApkDownloadProgress(
        isNativeAndroidApp()
          ? { downloadedBytes: 0, totalBytes: asset.sizeBytes || 0, percent: 0, stage: 'downloading' }
          : null
      );
      try {
        const result = await downloadAppUpdateApk(
          asset.downloadUrl,
          asset.name || 'TopAnimes.apk',
          asset.digest
        );
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
        const msg = err instanceof Error ? err.message : 'Falha ao iniciar download da atualização.';
        setApkDownloadProgress((prev) =>
          prev ? { ...prev, stage: 'error', message: msg } : null
        );
        showToast(msg);
      } finally {
        setDownloadingAppUpdate(false);
      }
    },
    [appUpdateResult, markReleaseAcknowledged, showToast]
  );

  const checkForAppUpdates = useCallback(
    async (options: { manual?: boolean; triggerAutoDownload?: boolean } = {}) => {
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
            showToast(`Nova atualização encontrada: ${evaluated.latestRelease.releaseName}`);
          } else {
            showToast('Nova versão do TopAnimes disponível nas Configurações.');
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
        setCheckingAppUpdate(false);
      }
    },
    [handleDownloadAppUpdate, showToast]
  );

  const fetchCatalog = useCallback(async () => {
    setLoadingCatalog(true);
    setCatalogError('');
    try {
      const [homeRes, epRes] = await Promise.all([
        apiFetch('/api/home'),
        apiFetch('/api/episodes?page=1').catch(() => null),
      ]);
      const data = await homeRes.json();
      if (!homeRes.ok) throw new Error(data.error || 'Erro ao carregar catálogo');
      const home = data as HomeCatalog;
      setCatalog(home);

      let loadedReleases = home.releases;
      if (epRes && epRes.ok) {
        const epData = (await epRes.json()) as PaginatedCatalogResponse;
        loadedReleases = epData.items.length ? epData.items : home.releases;
        setReleases(loadedReleases);
        setReleasesPage(epData.currentPage || 1);
        setReleasesTotalPages(epData.totalPages || 1);
      } else {
        setReleases(home.releases);
        setReleasesPage(1);
        setReleasesTotalPages(1);
      }

      setArchiveState((prev) => ({
        ...prev,
        animes: prev.animes.initialized
          ? prev.animes
          : { ...prev.animes, items: home.animes },
        movies: prev.movies.initialized
          ? prev.movies
          : { ...prev.movies, items: home.movies },
      }));

      if (
        !initialCheckDoneRef.current &&
        settingsRef.current.checkEpisodesOnStartup &&
        favoritesRef.current.length > 0
      ) {
        initialCheckDoneRef.current = true;
        void checkFavoriteUpdates({ currentReleases: loadedReleases });
      }
    } catch (err) {
      setCatalogError(
        err instanceof Error ? err.message : 'Falha ao conectar ao catálogo.'
      );
    } finally {
      setLoadingCatalog(false);
    }
  }, [checkFavoriteUpdates]);

  useEffect(() => {
    fetchCatalog();
  }, [fetchCatalog]);

  // Dynamic episode/news check interval configured in Settings
  useEffect(() => {
    const intervalMs = getEpisodeCheckIntervalMs(settings.episodeCheckIntervalMinutes);
    if (!intervalMs) return;

    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible' && favoritesRef.current.length > 0) {
        void checkFavoriteUpdates();
      }
    }, intervalMs);
    return () => window.clearInterval(interval);
  }, [checkFavoriteUpdates, settings.episodeCheckIntervalMinutes]);

  // Load native Android version info and run scheduled GitHub update check
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

      if (
        !cancelled &&
        shouldRunScheduledAppUpdateCheck(
          settingsRef.current,
          settingsMetaRef.current.lastAppUpdateCheckAt
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
      setApkDownloadProgress(event);
      if (event.stage === 'installed') {
        setDownloadingAppUpdate(false);
        markReleaseAcknowledged(pendingUpdateReleaseRef.current);
        showToast('Atualização instalada com sucesso!');
      } else if (event.stage === 'error') {
        setDownloadingAppUpdate(false);
        if (event.message) {
          showToast(event.message);
        }
      }
    });

    return () => {
      active = false;
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
        const res = await apiFetch(
          `/api/catalog?category=${encodeURIComponent(category)}&page=${page}`
        );
        const data = (await res.json()) as PaginatedCatalogResponse & { error?: string };
        if (!res.ok) throw new Error(data.error || 'Erro ao carregar categoria');

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
              items: merged.length ? merged : current.items,
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
        const params = new URLSearchParams();
        params.set('page', String(opts.page));
        if (opts.genre) params.set('genre', opts.genre);
        else if (opts.year) params.set('year', opts.year);

        const res = await apiFetch(`/api/catalog?${params.toString()}`);
        const data = (await res.json()) as PaginatedCatalogResponse & { error?: string };
        if (!res.ok) throw new Error(data.error || 'Erro ao aplicar filtro');

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
    [showToast]
  );

  useEffect(() => {
    if (
      activeSection === 'catalog' &&
      !selectedGenre &&
      !selectedYear &&
      !archiveState[archiveCategory].initialized &&
      !archiveState[archiveCategory].loading
    ) {
      fetchArchivePage(archiveCategory, 1, false);
    }
  }, [activeSection, archiveCategory, archiveState, fetchArchivePage, selectedGenre, selectedYear]);

  const handleLoadMoreReleases = useCallback(async () => {
    if (loadingMoreReleases || releasesPage >= releasesTotalPages) return;
    const nextPage = releasesPage + 1;
    setLoadingMoreReleases(true);
    try {
      const res = await apiFetch(`/api/episodes?page=${nextPage}`);
      const data = (await res.json()) as PaginatedCatalogResponse & { error?: string };
      if (!res.ok) throw new Error(data.error || 'Erro ao carregar mais episódios');
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
    setFilteredCatalog({ ...EMPTY_BUCKET });
    setArchiveCategory(category);
  }, []);

  const handleSelectGenre = useCallback(
    (genreSlug: string) => {
      setSelectedYear('');
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
      setSelectedYear(yearSlug);
      if (!yearSlug) {
        setFilteredCatalog({ ...EMPTY_BUCKET });
        return;
      }
      void fetchFilteredCatalog({ year: yearSlug, page: 1, append: false });
    },
    [fetchFilteredCatalog]
  );

  const handleClearCatalogFilters = useCallback(() => {
    setSelectedGenre('');
    setSelectedYear('');
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
      fetchArchivePage(category, bucket.currentPage + 1, true);
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
        const res = await apiFetch(`/api/search?q=${encodeURIComponent(query)}&page=1`);
        const data = (await res.json()) as PaginatedSearchResponse & { error?: string };
        if (!res.ok) throw new Error(data.error || 'Erro na busca');
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
      const res = await apiFetch(
        `/api/search?q=${encodeURIComponent(searchQuery)}&page=${nextPage}`
      );
      const data = (await res.json()) as PaginatedSearchResponse & { error?: string };
      if (!res.ok) throw new Error(data.error || 'Erro ao carregar mais resultados');
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

  const loadAnimeDetailsForRoute = useCallback(async (url: string, reqGen: number) => {
    const cacheKey = normalizeTopAnimesUrl(url) || url;
    const cached = animeDetailsCacheRef.current.get(cacheKey);
    if (cached) {
      setAnimeDetails(cached);
      setLoadingDetail(false);
      setDetailError('');
      return;
    }

    setLoadingDetail(true);
    setDetailError('');
    setAnimeDetails(null);
    try {
      const res = await apiFetch(`/api/anime?url=${encodeURIComponent(url)}`);
      const data = await res.json();
      if (navRequestGenRef.current !== reqGen) return;
      if (!res.ok) throw new Error(data.error || 'Erro ao carregar anime');
      const details = data as AnimeDetails;
      animeDetailsCacheRef.current.set(cacheKey, details);
      setAnimeDetails(details);
    } catch (err) {
      if (navRequestGenRef.current !== reqGen) return;
      setDetailError(
        err instanceof Error ? err.message : 'Falha ao carregar episódios.'
      );
    } finally {
      if (navRequestGenRef.current === reqGen) {
        setLoadingDetail(false);
      }
    }
  }, []);

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
    async (url: string, explicitKind?: MediaKind) => {
      const inferredKind: MediaKind =
        explicitKind ||
        (/\/filmes\//i.test(url)
          ? 'movie'
          : /\/episodio\//i.test(url)
            ? 'episode'
            : 'anime');

      const reqGen = ++navRequestGenRef.current;
      const nextFrame: ActiveRoute =
        inferredKind === 'anime' ? { view: 'anime', url } : { view: 'episode', url };

      const prevStack = routeStackRef.current;
      const nextStack = pushRouteFrame(prevStack, nextFrame);
      routeStackRef.current = nextStack;
      setRouteStack(nextStack);
      pushBrowserHistoryIfNeeded(prevStack.length, nextStack.length);

      if (inferredKind === 'anime') {
        await loadAnimeDetailsForRoute(url, reqGen);
        return;
      }

      const epCacheKey = normalizeTopAnimesUrl(url) || url;
      const cachedEp = episodeDetailsCacheRef.current.get(epCacheKey);
      const preserveExistingEpisode = routeRef.current.view === 'episode';

      setDetailError('');
      if (cachedEp) {
        setEpisodeDetails(cachedEp);
        setLoadingDetail(false);
        const updatedHistory = pushHistoryEntry({
          url: cachedEp.url,
          title: cachedEp.title,
          seriesTitle: cachedEp.seriesTitle,
          seriesUrl: cachedEp.seriesUrl,
          poster: cachedEp.backdrop || cachedEp.poster,
          kind: cachedEp.isMovie ? 'movie' : 'episode',
          watchedAt: new Date().toISOString(),
        });
        setHistory(updatedHistory);
        return;
      }

      setLoadingDetail(true);
      if (!preserveExistingEpisode) {
        setEpisodeDetails(null);
      }
      try {
        const res = await apiFetch(`/api/episode?url=${encodeURIComponent(url)}`);
        const data = await res.json();
        if (navRequestGenRef.current !== reqGen) return;
        if (!res.ok) throw new Error(data.error || 'Erro ao carregar episódio');
        const ep = data as EpisodeDetails;
        episodeDetailsCacheRef.current.set(epCacheKey, ep);
        setEpisodeDetails(ep);
        const updatedHistory = pushHistoryEntry({
          url: ep.url,
          title: ep.title,
          seriesTitle: ep.seriesTitle,
          seriesUrl: ep.seriesUrl,
          poster: ep.backdrop || ep.poster,
          kind: ep.isMovie ? 'movie' : 'episode',
          watchedAt: new Date().toISOString(),
        });
        setHistory(updatedHistory);
      } catch (err) {
        if (navRequestGenRef.current !== reqGen) return;
        setDetailError(
          err instanceof Error ? err.message : 'Falha ao extrair players.'
        );
      } finally {
        if (navRequestGenRef.current === reqGen) {
          setLoadingDetail(false);
        }
      }
    },
    [loadAnimeDetailsForRoute, pushBrowserHistoryIfNeeded]
  );

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

  const handleOpenAlert = useCallback(
    (alert: FavoriteAlertEntry) => {
      setAlerts((prev) => {
        const next = prev.map((a) => (a.id === alert.id ? { ...a, read: true } : a));
        saveFavoriteAlerts(next);
        return next;
      });
      void openMediaUrl(alert.episodeUrl, 'episode');
    },
    [openMediaUrl]
  );

  const handleRequestPushNotifications = useCallback(async () => {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      showToast('Este navegador não suporta notificações.');
      return;
    }
    try {
      const perm = await Notification.requestPermission();
      setNotificationPermission(perm);
      if (perm === 'granted') {
        showToast('Notificações ativadas neste dispositivo!');
      } else if (perm === 'denied') {
        showToast('Notificações bloqueadas no navegador. Alertas continuam no sininho.');
      }
    } catch {
      showToast('Não foi possível solicitar permissão de notificação.');
    }
  }, [showToast]);

  const unreadAlertCount = useMemo(
    () => alerts.filter((a) => !a.read).length,
    [alerts]
  );

  const watchedUrls = useMemo(
    () => new Set(history.map((h) => h.url)),
    [history]
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
    const step = resolveBackNavigationStep({
      settingsOpen,
      routeStack: routeStackRef.current,
      hasSearchResults: searchResults !== null,
      hasCatalogFilters: Boolean(selectedGenre || selectedYear),
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
    searchResults,
    selectedGenre,
    selectedYear,
    settings.defaultSection,
    settingsOpen,
  ]);

  const navigateBackStepRef = useRef(navigateBackStep);
  navigateBackStepRef.current = navigateBackStep;

  // Expose Android native back handler and sync browser popstate on Web
  useEffect(() => {
    window.__topAnimesHandleAndroidBack = () => navigateBackStepRef.current();

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

  const handleOpenRandom = useCallback(async () => {
    if (loadingRandom) return;
    setLoadingRandom(true);
    try {
      const res = await apiFetch('/api/random');
      const data = (await res.json()) as { url?: string; kind?: MediaKind; error?: string };
      if (!res.ok || !data.url) {
        throw new Error(data.error || 'Não foi possível sortear um anime.');
      }
      await openMediaUrl(data.url, data.kind);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Não foi possível sortear um anime.');
    } finally {
      setLoadingRandom(false);
    }
  }, [loadingRandom, openMediaUrl, showToast]);

  return (
    <div className="min-h-screen bg-[#0d0f12] text-[#f1f5f9]">
      <Header
        activeSection={activeSection}
        onSelectSection={handleSelectSection}
        onGoHome={() => handleSelectSection('releases')}
        alerts={alerts}
        unreadCount={unreadAlertCount}
        checkingAlerts={checkingAlerts}
        notificationPermission={notificationPermission}
        onCheckAlerts={() => void checkFavoriteUpdates({ manual: true })}
        onMarkAllRead={handleMarkAllAlertsRead}
        onOpenAlert={handleOpenAlert}
        onRequestPushNotifications={() => void handleRequestPushNotifications()}
        hasAppUpdate={Boolean(appUpdateResult?.hasUpdate)}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {!isOnline && (
        <div className="border-b border-amber-500/30 bg-amber-500/15 px-4 py-2 text-center text-xs font-medium text-amber-200">
          <span className="inline-flex items-center gap-2">
            <WifiOff className="h-3.5 w-3.5" />
            Sem conexão com a internet — exibindo catálogo salvo quando disponível.
          </span>
        </div>
      )}

      <main className="pb-24 md:pb-16">
        {route.view === 'catalog' && (
          <CatalogView
            catalog={catalog}
            loading={loadingCatalog}
            error={catalogError}
            activeSection={activeSection}
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
            filteredCatalog={filteredCatalog}
            favorites={favorites}
            history={history}
            alerts={alerts}
            checkingAlerts={checkingAlerts}
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
            onClearCatalogFilters={handleClearCatalogFilters}
            onLoadMoreFiltered={handleLoadMoreFiltered}
            onOpenItem={openMediaUrl}
            onToggleFavorite={toggleFavorite}
            onCheckFavoriteUpdates={() => void checkFavoriteUpdates({ manual: true })}
            onMarkAllAlertsRead={handleMarkAllAlertsRead}
            onOpenAlert={handleOpenAlert}
            onRequestPushNotifications={() => void handleRequestPushNotifications()}
            onClearHistory={() => {
              clearHistory();
              clearAllEpisodeProgress();
              setHistory([]);
              setProgressMap({});
              showToast('Histórico limpo.');
            }}
            onSelectSection={handleSelectSection}
            defaultAudioFilter={settings.defaultAudioFilter}
          />
        )}

        {route.view === 'anime' && (
          <>
            {loadingDetail && !animeDetails ? (
              <div className="mx-auto max-w-7xl space-y-4 px-4 py-8 sm:px-6 lg:px-8">
                <div className="h-64 animate-pulse rounded-xl border border-white/8 bg-[#151921]" />
                <div className="h-40 animate-pulse rounded-xl border border-white/8 bg-[#151921]" />
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
              <AnimeDetailView
                anime={animeDetails}
                isFavorite={isItemFavorited(animeDetails.url, favorites)}
                watchedUrls={watchedUrls}
                progressMap={progressMap}
                onToggleFavorite={toggleFavorite}
                onOpenEpisode={(epUrl) => openMediaUrl(epUrl, 'episode')}
                onBack={() => navigateBackStep()}
              />
            ) : null}
          </>
        )}

        {route.view === 'episode' && (
          <>
            {loadingDetail && !episodeDetails ? (
              <div className="mx-auto max-w-7xl space-y-4 px-4 py-8 sm:px-6 lg:px-8">
                <div className="aspect-video animate-pulse rounded-xl border border-white/8 bg-[#151921]" />
                <div className="h-44 animate-pulse rounded-xl border border-white/8 bg-[#151921]" />
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
              <EpisodeWorkspace
                episode={episodeDetails}
                isFavorite={isItemFavorited(
                  episodeDetails.seriesUrl || episodeDetails.url,
                  favorites
                )}
                watchedUrls={watchedUrls}
                initialSeriesEpisodes={
                  animeDetails &&
                  episodeDetails.seriesUrl &&
                  isSameEpisodeUrl(animeDetails.url, episodeDetails.seriesUrl)
                    ? animeDetails.episodes
                    : undefined
                }
                loadingEpisode={loadingDetail}
                onToggleFavorite={toggleFavorite}
                onBack={() => navigateBackStep()}
                onNavigateUrl={openMediaUrl}
                onNativeSessionSync={(result) => {
                  if (result.videoScale) {
                    updateSettings({ videoScale: sanitizeVideoScaleMode(result.videoScale) });
                  }
                  if (Array.isArray(result.visitedEpisodes) && result.visitedEpisodes.length > 0) {
                    let nextHist = history;
                    for (const visited of result.visitedEpisodes) {
                      if (!visited?.url) continue;
                      nextHist = pushHistoryEntry({
                        url: visited.url,
                        title: visited.title || episodeDetails.title,
                        seriesTitle: episodeDetails.seriesTitle,
                        seriesUrl: episodeDetails.seriesUrl,
                        poster: episodeDetails.backdrop || episodeDetails.poster,
                        kind: episodeDetails.isMovie ? 'movie' : 'episode',
                        watchedAt: new Date().toISOString(),
                      });
                      if (
                        typeof visited.positionMs === 'number' ||
                        typeof visited.completed === 'boolean'
                      ) {
                        saveEpisodeProgress({
                          url: visited.url,
                          positionSec: (visited.positionMs || 0) / 1000,
                          durationSec: (visited.durationMs || 0) / 1000,
                          ended: Boolean(visited.completed),
                        });
                      }
                    }
                    setHistory(nextHist);
                  }
                  const activeResUrl = result.episodeUrl || episodeDetails.url;
                  if (activeResUrl && typeof result.positionMs === 'number') {
                    saveEpisodeProgress({
                      url: activeResUrl,
                      positionSec: result.positionMs / 1000,
                      durationSec: (result.durationMs || 0) / 1000,
                    });
                  }
                  refreshProgressState();
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
              />
            ) : null}
          </>
        )}
      </main>

      <MobileTabBar
        activeSection={activeSection}
        unreadCount={unreadAlertCount}
        onSelectSection={handleSelectSection}
      />

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        settingsMeta={settingsMeta}
        onUpdateSettings={updateSettings}
        onResetSettings={resetSettings}
        favoritesCount={favorites.length}
        checkingEpisodes={checkingAlerts}
        notificationPermission={notificationPermission}
        onCheckEpisodesNow={() => {
          void fetchCatalog();
          void checkFavoriteUpdates({ manual: true });
        }}
        onRequestPushNotifications={() => void handleRequestPushNotifications()}
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
        onApplySwUpdate={handleApplySwUpdate}
        historyCount={history.length}
        alertsCount={alerts.length}
        onClearHistory={() => {
          clearHistory();
          clearAllEpisodeProgress();
          setHistory([]);
          setProgressMap({});
          showToast('Histórico limpo.');
        }}
        onClearAlerts={() => {
          clearFavoriteAlerts();
          setAlerts([]);
          showToast('Avisos limpos.');
        }}
      />

      {toast && (
        <div
          role="status"
          className="fixed bottom-20 right-4 z-50 rounded-lg border border-white/15 bg-[#151921] px-4 py-2.5 text-xs font-medium text-white shadow-xl md:bottom-5 md:right-5"
        >
          {toast}
        </div>
      )}
    </div>
  );
}
