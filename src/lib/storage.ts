import {
  buildWatchedProgressMap,
  canonicalEpisodeProgressKey,
  computeProgressSnapshot,
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
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function pushHistoryEntry(entry: WatchHistoryEntry): WatchHistoryEntry[] {
  const entryKey = canonicalEpisodeProgressKey(entry.url);
  const previousAll = loadHistory();
  const prevMatch = previousAll.find(
    (item) => canonicalEpisodeProgressKey(item.url) === entryKey
  );
  const progressMap = loadEpisodeProgressMap();
  const savedProgress = entryKey ? progressMap[entryKey] : undefined;

  const mergedEntry: WatchHistoryEntry = {
    ...entry,
    positionSec:
      entry.positionSec ?? savedProgress?.positionSec ?? prevMatch?.positionSec,
    durationSec:
      entry.durationSec ?? savedProgress?.durationSec ?? prevMatch?.durationSec,
    completed: entry.completed ?? savedProgress?.completed ?? prevMatch?.completed,
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

export function saveEpisodeProgress(params: {
  url: string;
  positionSec: number;
  durationSec: number;
  ended?: boolean;
  forceReset?: boolean;
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
  if (
    key &&
    currentHistory.some((item) => canonicalEpisodeProgressKey(item.url) === key)
  ) {
    updatedHistory = currentHistory.map((item) =>
      canonicalEpisodeProgressKey(item.url) === key
        ? {
            ...item,
            positionSec: snapshot.positionSec,
            durationSec: snapshot.durationSec,
            completed: snapshot.completed,
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
    localStorage.setItem(ALERTS_KEY, JSON.stringify(alerts.slice(0, 40)));
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
