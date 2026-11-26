import type { AnisyncBackupData } from './backup';
import {
  buildWatchedProgressMap,
  canonicalEpisodeProgressKey,
  computeProgressSnapshot,
  formatHistoryEpisodeTitle,
  getResumePositionSec,
  removeHistoryAnimeFromList,
  removeHistoryEpisodeFromList,
  sanitizeEpisodeProgressMap,
  upsertEpisodeProgressMap,
  type EpisodePlaybackProgress,
  type EpisodeProgressMap,
} from './playbackProgress';
import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_APP_SETTINGS_META,
  sanitizeAppSettings,
  type AppSettings,
  type AppSettingsMeta,
} from './settings';
import type {
  CatalogMediaItem,
  FavoriteAlertEntry,
  FavoriteBaselineMap,
  WatchHistoryEntry,
} from './types';

const FAVORITES_KEY = 'anisync:favorites:v1';
const LEGACY_FAVORITES_KEY = 'topvlc:favorites:v1';
const HISTORY_KEY = 'anisync:history:v1';
const LEGACY_HISTORY_KEY = 'topvlc:history:v1';
const PROGRESS_KEY = 'anisync:progress:v1';
const LEGACY_PROGRESS_KEY = 'topvlc:progress:v1';
const ALERTS_KEY = 'anisync:alerts:v1';
const LEGACY_ALERTS_KEY = 'topvlc:alerts:v1';
const BASELINES_KEY = 'anisync:fav_baselines:v1';
const LEGACY_BASELINES_KEY = 'topvlc:fav_baselines:v1';
const SETTINGS_KEY = 'anisync:settings:v1';
const LEGACY_SETTINGS_KEY = 'topvlc:settings:v1';
const SETTINGS_META_KEY = 'anisync:settings_meta:v1';
const LEGACY_SETTINGS_META_KEY = 'topvlc:settings_meta:v1';
const ACK_RELEASE_KEY = 'anisync:ack_release:v1';
const LEGACY_ACK_RELEASE_KEY = 'topvlc:ack_release:v1';
const ROUTE_SESSION_KEY = 'anisync:route_session:v1';
const MUTED_FAVORITES_KEY = 'anisync:muted_favorites:v1';

function readWithLegacyFallback(primaryKey: string, legacyKey: string): string | null {
  const primary = localStorage.getItem(primaryKey);
  if (primary !== null) return primary;
  return localStorage.getItem(legacyKey);
}

export function loadFavorites(): CatalogMediaItem[] {
  try {
    const raw = readWithLegacyFallback(FAVORITES_KEY, LEGACY_FAVORITES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveFavorites(items: CatalogMediaItem[]): void {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(items.slice(0, 60)));
  } catch {
    // ignore storage quota errors
  }
}

export function loadHistory(): WatchHistoryEntry[] {
  try {
    const raw = readWithLegacyFallback(HISTORY_KEY, LEGACY_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const progressMap = loadEpisodeProgressMap();
    return parsed
      .filter((item): item is WatchHistoryEntry => Boolean(item && typeof item.url === 'string' && item.url.trim()))
      .map((item) => {
        const key = canonicalEpisodeProgressKey(item.url);
        const savedProgress = key ? progressMap[key] : undefined;
        const completed = Boolean(savedProgress ? savedProgress.completed : item.completed);
        const positionSec = completed
          ? 0
          : (savedProgress?.positionSec ?? item.positionSec);
        const durationSec =
          savedProgress && savedProgress.durationSec > 0
            ? savedProgress.durationSec
            : item.durationSec;
        return {
          ...item,
          title: formatHistoryEpisodeTitle(item.title, item.seriesTitle),
          positionSec,
          durationSec,
          completed,
        };
      });
  } catch {
    return [];
  }
}

export function pushHistoryEntry(entry: WatchHistoryEntry): WatchHistoryEntry[] {
  const entryKey = canonicalEpisodeProgressKey(entry.url);
  const previousAll = loadHistory();
  const prevMatch = previousAll.find(
    (item) => canonicalEpisodeProgressKey(item.url) === entryKey || item.url === entry.url
  );
  const progressMap = loadEpisodeProgressMap();
  const savedProgress = entryKey ? progressMap[entryKey] : undefined;

  const seriesTitle = (entry.seriesTitle || prevMatch?.seriesTitle || '').trim() || undefined;
  const seriesUrl = (entry.seriesUrl || prevMatch?.seriesUrl || '').trim() || undefined;
  const poster = (entry.poster || prevMatch?.poster || '').trim();
  const completed = Boolean(
    entry.completed ?? savedProgress?.completed ?? prevMatch?.completed
  );
  const positionSec = completed
    ? 0
    : (entry.positionSec ?? savedProgress?.positionSec ?? prevMatch?.positionSec);
  const durationSec =
    entry.durationSec && entry.durationSec > 0
      ? entry.durationSec
      : (savedProgress?.durationSec ?? prevMatch?.durationSec);

  const mergedEntry: WatchHistoryEntry = {
    ...prevMatch,
    ...entry,
    title: formatHistoryEpisodeTitle(entry.title || prevMatch?.title || 'Episódio', seriesTitle),
    poster,
    seriesTitle,
    seriesUrl,
    positionSec,
    durationSec,
    completed,
  };

  const existing = previousAll.filter(
    (item) => canonicalEpisodeProgressKey(item.url) !== entryKey && item.url !== entry.url
  );
  const next = [mergedEntry, ...existing].slice(0, 30);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
  return next;
}

export function clearHistory(): void {
  try {
    localStorage.removeItem(HISTORY_KEY);
    localStorage.removeItem(LEGACY_HISTORY_KEY);
  } catch {
    // ignore
  }
}

function persistHistoryList(items: WatchHistoryEntry[]): void {
  try {
    if (items.length === 0) {
      localStorage.removeItem(HISTORY_KEY);
      localStorage.removeItem(LEGACY_HISTORY_KEY);
    } else {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(items));
    }
  } catch {
    // ignore
  }
}

function clearEpisodesProgressUrls(urls: string[]): EpisodeProgressMap {
  const currentMap = loadEpisodeProgressMap();
  if (urls.length === 0) return currentMap;
  let changed = false;
  const next = { ...currentMap };
  for (const url of urls) {
    const key = canonicalEpisodeProgressKey(url);
    if (key && next[key]) {
      delete next[key];
      changed = true;
    }
  }
  if (changed) {
    saveEpisodeProgressMap(next);
  }
  return changed ? next : currentMap;
}

export function removeHistoryEpisode(url: string): {
  history: WatchHistoryEntry[];
  progressMap: EpisodeProgressMap;
  removedCount: number;
} {
  const { nextHistory, removedUrls } = removeHistoryEpisodeFromList(loadHistory(), url);
  persistHistoryList(nextHistory);
  const progressMap = clearEpisodesProgressUrls(
    removedUrls.length > 0 ? removedUrls : [url]
  );
  return {
    history: nextHistory,
    progressMap,
    removedCount: removedUrls.length,
  };
}

export function removeHistoryAnime(entry: WatchHistoryEntry): {
  history: WatchHistoryEntry[];
  progressMap: EpisodeProgressMap;
  removedCount: number;
} {
  const { nextHistory, removedUrls } = removeHistoryAnimeFromList(loadHistory(), entry);
  persistHistoryList(nextHistory);
  const progressMap = clearEpisodesProgressUrls(
    removedUrls.length > 0 ? removedUrls : [entry.url]
  );
  return {
    history: nextHistory,
    progressMap,
    removedCount: removedUrls.length,
  };
}

export function loadEpisodeProgressMap(): EpisodeProgressMap {
  try {
    const raw = readWithLegacyFallback(PROGRESS_KEY, LEGACY_PROGRESS_KEY);
    if (!raw) return {};
    return sanitizeEpisodeProgressMap(JSON.parse(raw));
  } catch {
    return {};
  }
}

export function saveEpisodeProgressMap(map: EpisodeProgressMap): void {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(map));
  } catch {
    // ignore storage quota errors
  }
}

export function getEpisodeProgress(url: string): EpisodePlaybackProgress | null {
  const key = canonicalEpisodeProgressKey(url);
  if (!key) return null;
  const map = loadEpisodeProgressMap();
  return map[key] || null;
}

export function getEpisodeResumeSeconds(url: string): number {
  return getResumePositionSec(getEpisodeProgress(url));
}

export interface EpisodeHistoryMeta {
  title?: string;
  seriesTitle?: string;
  seriesUrl?: string;
  poster?: string;
  kind?: 'episode' | 'movie';
  watchedAt?: string;
  promoteInHistory?: boolean;
}

export function saveEpisodeProgress(params: {
  url: string;
  positionSec: number;
  durationSec: number;
  ended?: boolean;
  forceReset?: boolean;
  meta?: EpisodeHistoryMeta;
}): { map: EpisodeProgressMap; history: WatchHistoryEntry[] | null } {
  const snapshot = computeProgressSnapshot(params);
  const currentMap = loadEpisodeProgressMap();
  if (!snapshot) {
    return { map: currentMap, history: null };
  }

  const nextMap = upsertEpisodeProgressMap(currentMap, snapshot);
  saveEpisodeProgressMap(nextMap);

  const key = canonicalEpisodeProgressKey(params.url);
  const currentHistory = loadHistory();
  let updatedHistory: WatchHistoryEntry[] | null = null;
  const existingIdx = key
    ? currentHistory.findIndex((item) => canonicalEpisodeProgressKey(item.url) === key)
    : -1;

  if (existingIdx >= 0) {
    const item = currentHistory[existingIdx];
    const seriesTitle = (params.meta?.seriesTitle || item.seriesTitle || '').trim() || undefined;
    const seriesUrl = (params.meta?.seriesUrl || item.seriesUrl || '').trim() || undefined;
    const poster = (params.meta?.poster || item.poster || '').trim();
    const rawTitle = (params.meta?.title || item.title || 'Episódio').trim();
    const updatedItem: WatchHistoryEntry = {
      ...item,
      title: formatHistoryEpisodeTitle(rawTitle, seriesTitle),
      poster,
      seriesTitle,
      seriesUrl,
      kind: params.meta?.kind || item.kind,
      watchedAt: params.meta?.watchedAt || item.watchedAt,
      positionSec: snapshot.positionSec,
      durationSec: snapshot.durationSec > 0 ? snapshot.durationSec : item.durationSec,
      completed: snapshot.completed,
    };

    if (params.meta?.promoteInHistory) {
      const rest = currentHistory.filter((_, idx) => idx !== existingIdx);
      updatedHistory = [updatedItem, ...rest].slice(0, 30);
    } else {
      updatedHistory = currentHistory.map((entry, idx) =>
        idx === existingIdx ? updatedItem : entry
      );
    }
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(updatedHistory));
    } catch {
      // ignore
    }
  } else if (key && params.meta?.title) {
    const seriesTitle = (params.meta.seriesTitle || '').trim() || undefined;
    const seriesUrl = (params.meta.seriesUrl || '').trim() || undefined;
    const newItem: WatchHistoryEntry = {
      title: formatHistoryEpisodeTitle(params.meta.title, seriesTitle),
      url: params.url,
      poster: (params.meta.poster || '').trim(),
      kind: params.meta.kind || 'episode',
      watchedAt: params.meta.watchedAt || new Date().toISOString(),
      seriesUrl,
      seriesTitle,
      positionSec: snapshot.positionSec,
      durationSec: snapshot.durationSec,
      completed: snapshot.completed,
    };
    updatedHistory = [newItem, ...currentHistory].slice(0, 30);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(updatedHistory));
    } catch {
      // ignore
    }
  }

  return { map: nextMap, history: updatedHistory };
}

export function clearEpisodeProgress(url: string): EpisodeProgressMap {
  const key = canonicalEpisodeProgressKey(url);
  const currentMap = loadEpisodeProgressMap();
  if (!key || !currentMap[key]) return currentMap;
  const next = { ...currentMap };
  delete next[key];
  saveEpisodeProgressMap(next);
  return next;
}

export function setEpisodesWatched(
  urls: string[],
  watched: boolean
): { map: EpisodeProgressMap; history: WatchHistoryEntry[] | null } {
  const currentMap = loadEpisodeProgressMap();
  const nextMap = buildWatchedProgressMap(currentMap, urls, watched);
  saveEpisodeProgressMap(nextMap);

  const keySet = new Set(urls.map((u) => canonicalEpisodeProgressKey(u)).filter(Boolean));
  const currentHistory = loadHistory();
  let updatedHistory: WatchHistoryEntry[] | null = null;

  if (
    keySet.size > 0 &&
    currentHistory.some((item) => keySet.has(canonicalEpisodeProgressKey(item.url)))
  ) {
    updatedHistory = currentHistory.map((item) =>
      keySet.has(canonicalEpisodeProgressKey(item.url))
        ? {
            ...item,
            positionSec: 0,
            completed: watched,
          }
        : item
    );
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(updatedHistory));
    } catch {
      // ignore
    }
  }

  return { map: nextMap, history: updatedHistory };
}

export function clearAllEpisodeProgress(): void {
  try {
    localStorage.removeItem(PROGRESS_KEY);
    localStorage.removeItem(LEGACY_PROGRESS_KEY);
  } catch {
    // ignore
  }
}

export function loadFavoriteAlerts(): FavoriteAlertEntry[] {
  try {
    const raw = readWithLegacyFallback(ALERTS_KEY, LEGACY_ALERTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveFavoriteAlerts(alerts: FavoriteAlertEntry[]): void {
  try {
    localStorage.setItem(ALERTS_KEY, JSON.stringify(alerts.slice(0, 60)));
  } catch {
    // ignore
  }
}

export function clearFavoriteAlerts(): void {
  try {
    localStorage.removeItem(ALERTS_KEY);
    localStorage.removeItem(LEGACY_ALERTS_KEY);
  } catch {
    // ignore
  }
}

export function loadMutedFavoriteUrls(): string[] {
  try {
    const raw = localStorage.getItem(MUTED_FAVORITES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((u): u is string => typeof u === 'string' && Boolean(u.trim()))
      : [];
  } catch {
    return [];
  }
}

export function saveMutedFavoriteUrls(urls: string[]): void {
  try {
    localStorage.setItem(MUTED_FAVORITES_KEY, JSON.stringify(urls.slice(0, 100)));
  } catch {
    // ignore
  }
}

export function loadFavoriteBaselines(): FavoriteBaselineMap {
  try {
    const raw = readWithLegacyFallback(BASELINES_KEY, LEGACY_BASELINES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function saveFavoriteBaselines(baselines: FavoriteBaselineMap): void {
  try {
    localStorage.setItem(BASELINES_KEY, JSON.stringify(baselines));
  } catch {
    // ignore
  }
}

export function loadAppSettings(): AppSettings {
  try {
    const raw = readWithLegacyFallback(SETTINGS_KEY, LEGACY_SETTINGS_KEY);
    if (!raw) return sanitizeAppSettings(null);
    return sanitizeAppSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_APP_SETTINGS };
  }
}

export function saveAppSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(sanitizeAppSettings(settings)));
  } catch {
    // ignore
  }
}

export function loadAppSettingsMeta(): AppSettingsMeta {
  try {
    const raw = readWithLegacyFallback(SETTINGS_META_KEY, LEGACY_SETTINGS_META_KEY);
    if (!raw) return { ...DEFAULT_APP_SETTINGS_META };
    const parsed = JSON.parse(raw) as Partial<AppSettingsMeta>;
    return {
      lastEpisodeCheckAt:
        typeof parsed?.lastEpisodeCheckAt === 'string' ? parsed.lastEpisodeCheckAt : null,
      lastAppUpdateCheckAt:
        typeof parsed?.lastAppUpdateCheckAt === 'string' ? parsed.lastAppUpdateCheckAt : null,
    };
  } catch {
    return { ...DEFAULT_APP_SETTINGS_META };
  }
}

export function saveAppSettingsMeta(meta: AppSettingsMeta): void {
  try {
    localStorage.setItem(SETTINGS_META_KEY, JSON.stringify(meta));
  } catch {
    // ignore
  }
}

export function loadAcknowledgedReleaseKey(): string | null {
  try {
    return readWithLegacyFallback(ACK_RELEASE_KEY, LEGACY_ACK_RELEASE_KEY) || null;
  } catch {
    return null;
  }
}

export function saveAcknowledgedReleaseKey(key: string | null): void {
  try {
    if (!key) {
      localStorage.removeItem(ACK_RELEASE_KEY);
      localStorage.removeItem(LEGACY_ACK_RELEASE_KEY);
    } else {
      localStorage.setItem(ACK_RELEASE_KEY, key);
    }
  } catch {
    // ignore
  }
}

export type PersistedRouteNode =
  | { view: 'catalog' }
  | { view: 'anime'; url: string }
  | { view: 'episode'; url: string };

export type PersistedCatalogSection = 'releases' | 'calendar' | 'catalog' | 'library';

export interface PersistedRouteSession {
  routeStack: PersistedRouteNode[];
  activeSection: PersistedCatalogSection;
}

const VALID_SECTIONS = new Set<PersistedCatalogSection>([
  'releases',
  'calendar',
  'catalog',
  'library',
]);

export function loadActiveRouteSession(): PersistedRouteSession {
  const fallback: PersistedRouteSession = {
    routeStack: [{ view: 'catalog' }],
    activeSection: 'releases',
  };
  try {
    const raw = localStorage.getItem(ROUTE_SESSION_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<PersistedRouteSession>;
    const activeSection: PersistedCatalogSection =
      typeof parsed?.activeSection === 'string' &&
      VALID_SECTIONS.has(parsed.activeSection as PersistedCatalogSection)
        ? (parsed.activeSection as PersistedCatalogSection)
        : 'releases';

    if (!Array.isArray(parsed?.routeStack) || parsed.routeStack.length === 0) {
      return { routeStack: [{ view: 'catalog' }], activeSection };
    }

    const sanitizedStack: PersistedRouteNode[] = [];
    for (const node of parsed.routeStack) {
      if (!node || typeof node !== 'object') continue;
      const view = (node as { view?: unknown }).view;
      if (view === 'catalog') {
        sanitizedStack.push({ view: 'catalog' });
      } else if (view === 'anime' || view === 'episode') {
        const url = typeof (node as { url?: unknown }).url === 'string'
          ? (node as { url: string }).url.trim()
          : '';
        if (url) {
          sanitizedStack.push(view === 'anime' ? { view: 'anime', url } : { view: 'episode', url });
        }
      }
    }

    if (sanitizedStack.length === 0) {
      sanitizedStack.push({ view: 'catalog' });
    } else if (sanitizedStack[0].view !== 'catalog') {
      sanitizedStack.unshift({ view: 'catalog' });
    }

    return {
      routeStack: sanitizedStack.slice(-10),
      activeSection,
    };
  } catch {
    return fallback;
  }
}

export function saveActiveRouteSession(session: PersistedRouteSession): void {
  try {
    const sanitizedStack: PersistedRouteNode[] = session.routeStack.map((node) =>
      node.view === 'episode' ? { view: 'episode', url: node.url } : node
    );
    localStorage.setItem(
      ROUTE_SESSION_KEY,
      JSON.stringify({
        routeStack: sanitizedStack.slice(-10),
        activeSection: session.activeSection,
      })
    );
  } catch {
    // ignore
  }
}

export function collectUserBackupData(): AnisyncBackupData {
  return {
    favorites: loadFavorites(),
    history: loadHistory(),
    progressMap: loadEpisodeProgressMap(),
    mutedFavoriteUrls: loadMutedFavoriteUrls(),
    settings: loadAppSettings(),
  };
}

export function persistUserBackupData(data: AnisyncBackupData): AnisyncBackupData {
  saveFavorites(data.favorites);
  saveEpisodeProgressMap(data.progressMap);
  persistHistoryList(data.history);
  saveMutedFavoriteUrls(data.mutedFavoriteUrls);
  saveAppSettings(data.settings);
  return collectUserBackupData();
}

