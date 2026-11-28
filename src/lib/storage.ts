import type { AnisyncBackupData } from './backup';
import {
  buildWatchedProgressMap,
  canonicalEpisodeProgressKey,
  computeProgressSnapshot,
  findEpisodeProgressInMap,
  formatHistoryEpisodeTitle,
  getResumePositionSec,
  isSameUnifiedEpisode,
  removeAnimeProgressFromMap,
  removeHistoryAnimeFromList,
  removeHistoryEpisodeFromList,
  sanitizeEpisodeProgressMap,
  syncWatchedEpisodesInHistory,
  upsertEpisodeProgressMap,
  type EpisodeIdentityInput,
  type EpisodePlaybackProgress,
  type EpisodeProgressMap,
  type WatchedEpisodeHistoryItem,
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
        const savedProgress = findEpisodeProgressInMap(progressMap, item.url, item);
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
  const previousAll = loadHistory();
  const prevMatch = previousAll.find((item) => isSameUnifiedEpisode(item, entry));
  const progressMap = loadEpisodeProgressMap();
  const savedProgress = findEpisodeProgressInMap(progressMap, entry.url, {
    seriesTitle: entry.seriesTitle || prevMatch?.seriesTitle,
    seriesUrl: entry.seriesUrl || prevMatch?.seriesUrl,
    title: entry.title || prevMatch?.title,
    seasonNumber: entry.seasonNumber ?? prevMatch?.seasonNumber,
    episodeNumber: entry.episodeNumber ?? prevMatch?.episodeNumber,
    kind: entry.kind || prevMatch?.kind,
  });

  const seriesTitle = (entry.seriesTitle || prevMatch?.seriesTitle || '').trim() || undefined;
  const seriesUrl = (entry.seriesUrl || prevMatch?.seriesUrl || '').trim() || undefined;
  const seasonNumber = entry.seasonNumber ?? prevMatch?.seasonNumber;
  const episodeNumber = entry.episodeNumber ?? prevMatch?.episodeNumber;
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
    ...(typeof seasonNumber === 'number' ? { seasonNumber } : {}),
    ...(typeof episodeNumber === 'number' ? { episodeNumber } : {}),
    positionSec,
    durationSec,
    completed,
  };

  const existing = previousAll.filter((item) => !isSameUnifiedEpisode(item, mergedEntry));
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

function clearEpisodesProgressTargets(targets: EpisodeIdentityInput[]): EpisodeProgressMap {
  const currentMap = loadEpisodeProgressMap();
  if (targets.length === 0) return currentMap;
  let changed = false;
  const next = { ...currentMap };
  for (const target of targets) {
    const key = canonicalEpisodeProgressKey(target.url);
    if (key && next[key]) {
      delete next[key];
      changed = true;
    }
    for (const [entryKey, entry] of Object.entries(next)) {
      if (!entry) continue;
      if (isSameUnifiedEpisode(entry, target)) {
        delete next[entryKey];
        changed = true;
      }
    }
  }
  if (changed) {
    saveEpisodeProgressMap(next);
  }
  return changed ? next : currentMap;
}

export function removeHistoryEpisode(
  url: string,
  meta?: Omit<EpisodeIdentityInput, 'url'>
): {
  history: WatchHistoryEntry[];
  progressMap: EpisodeProgressMap;
  removedCount: number;
} {
  const currentHistory = loadHistory();
  const matchedEntry = currentHistory.find((item) =>
    isSameUnifiedEpisode(item, { url, ...meta })
  );
  const effectiveMeta: Omit<EpisodeIdentityInput, 'url'> = {
    seriesTitle: meta?.seriesTitle || matchedEntry?.seriesTitle,
    seriesUrl: meta?.seriesUrl || matchedEntry?.seriesUrl,
    title: meta?.title || matchedEntry?.title,
    seasonNumber: meta?.seasonNumber ?? matchedEntry?.seasonNumber,
    episodeNumber: meta?.episodeNumber ?? matchedEntry?.episodeNumber,
    kind: meta?.kind || matchedEntry?.kind,
  };
  const { nextHistory, removedUrls, removedEntries } = removeHistoryEpisodeFromList(
    currentHistory,
    url,
    effectiveMeta
  );
  persistHistoryList(nextHistory);
  const progressTargets: EpisodeIdentityInput[] =
    removedEntries.length > 0 ? removedEntries : [{ url, ...effectiveMeta }];
  const progressMap = clearEpisodesProgressTargets(progressTargets);
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
  removedProgressCount: number;
  totalClearedCount: number;
} {
  const { nextHistory, removedUrls, removedEntries } = removeHistoryAnimeFromList(
    loadHistory(),
    entry
  );
  persistHistoryList(nextHistory);

  const currentProgressMap = loadEpisodeProgressMap();
  const { nextProgressMap, removedKeys } = removeAnimeProgressFromMap(
    currentProgressMap,
    entry,
    removedEntries
  );
  if (removedKeys.length > 0) {
    saveEpisodeProgressMap(nextProgressMap);
  }

  const uniqueCleared: EpisodeIdentityInput[] = [];
  const addCleared = (item: EpisodeIdentityInput) => {
    if (!uniqueCleared.some((existing) => isSameUnifiedEpisode(existing, item))) {
      uniqueCleared.push(item);
    }
  };
  for (const removedEntry of removedEntries) {
    addCleared(removedEntry);
  }
  for (const key of removedKeys) {
    const prevProgress = currentProgressMap[key];
    if (prevProgress) addCleared(prevProgress);
  }

  return {
    history: nextHistory,
    progressMap: nextProgressMap,
    removedCount: removedUrls.length,
    removedProgressCount: removedKeys.length,
    totalClearedCount: Math.max(removedUrls.length, uniqueCleared.length),
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

export function getEpisodeProgress(
  url: string,
  meta?: Omit<EpisodeIdentityInput, 'url'>
): EpisodePlaybackProgress | null {
  const key = canonicalEpisodeProgressKey(url);
  if (!key) return null;
  const map = loadEpisodeProgressMap();
  return findEpisodeProgressInMap(map, url, meta) || null;
}

export function getEpisodeResumeSeconds(
  url: string,
  meta?: Omit<EpisodeIdentityInput, 'url'>
): number {
  return getResumePositionSec(getEpisodeProgress(url, meta));
}

export interface EpisodeHistoryMeta {
  title?: string;
  seriesTitle?: string;
  seriesUrl?: string;
  seasonNumber?: number;
  episodeNumber?: number;
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
  const snapshot = computeProgressSnapshot({
    ...params,
    seriesUrl: params.meta?.seriesUrl,
    seriesTitle: params.meta?.seriesTitle,
    seasonNumber: params.meta?.seasonNumber,
    episodeNumber: params.meta?.episodeNumber,
    title: params.meta?.title,
  });
  const currentMap = loadEpisodeProgressMap();
  if (!snapshot) {
    return { map: currentMap, history: null };
  }

  const nextMap = upsertEpisodeProgressMap(currentMap, snapshot);
  saveEpisodeProgressMap(nextMap);

  const key = canonicalEpisodeProgressKey(params.url);
  const currentHistory = loadHistory();
  let updatedHistory: WatchHistoryEntry[] | null = null;
  const targetIdentity: EpisodeIdentityInput = {
    url: params.url,
    seriesTitle: params.meta?.seriesTitle ?? snapshot.seriesTitle,
    seriesUrl: params.meta?.seriesUrl ?? snapshot.seriesUrl,
    title: params.meta?.title,
    seasonNumber: params.meta?.seasonNumber ?? snapshot.seasonNumber,
    episodeNumber: params.meta?.episodeNumber ?? snapshot.episodeNumber,
    kind: params.meta?.kind,
  };
  const existingIdx = key
    ? currentHistory.findIndex((item) => isSameUnifiedEpisode(item, targetIdentity))
    : -1;

  if (existingIdx >= 0) {
    const item = currentHistory[existingIdx];
    const seriesTitle = (params.meta?.seriesTitle || item.seriesTitle || '').trim() || undefined;
    const seriesUrl = (params.meta?.seriesUrl || item.seriesUrl || '').trim() || undefined;
    const seasonNumber = params.meta?.seasonNumber ?? snapshot.seasonNumber ?? item.seasonNumber;
    const episodeNumber =
      params.meta?.episodeNumber ?? snapshot.episodeNumber ?? item.episodeNumber;
    const poster = (params.meta?.poster || item.poster || '').trim();
    const rawTitle = (params.meta?.title || item.title || 'Episódio').trim();
    const updatedItem: WatchHistoryEntry = {
      ...item,
      url: params.url,
      title: formatHistoryEpisodeTitle(rawTitle, seriesTitle),
      poster,
      seriesTitle,
      seriesUrl,
      ...(typeof seasonNumber === 'number' ? { seasonNumber } : {}),
      ...(typeof episodeNumber === 'number' ? { episodeNumber } : {}),
      kind: params.meta?.kind || item.kind,
      watchedAt: params.meta?.watchedAt || item.watchedAt,
      positionSec: snapshot.positionSec,
      durationSec: snapshot.durationSec > 0 ? snapshot.durationSec : item.durationSec,
      completed: snapshot.completed,
    };

    const rest = currentHistory.filter(
      (entry, idx) => idx !== existingIdx && !isSameUnifiedEpisode(entry, updatedItem)
    );
    if (params.meta?.promoteInHistory) {
      updatedHistory = [updatedItem, ...rest].slice(0, 30);
    } else {
      updatedHistory = currentHistory
        .map((entry, idx) => (idx === existingIdx ? updatedItem : entry))
        .filter((entry, idx) => idx === existingIdx || !isSameUnifiedEpisode(entry, updatedItem));
    }
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(updatedHistory));
    } catch {
      // ignore
    }
  } else if (key && params.meta?.title) {
    const seriesTitle = (params.meta.seriesTitle || '').trim() || undefined;
    const seriesUrl = (params.meta.seriesUrl || '').trim() || undefined;
    const seasonNumber = params.meta.seasonNumber ?? snapshot.seasonNumber;
    const episodeNumber = params.meta.episodeNumber ?? snapshot.episodeNumber;
    const newItem: WatchHistoryEntry = {
      title: formatHistoryEpisodeTitle(params.meta.title, seriesTitle),
      url: params.url,
      poster: (params.meta.poster || '').trim(),
      kind: params.meta.kind || 'episode',
      watchedAt: params.meta.watchedAt || new Date().toISOString(),
      seriesUrl,
      seriesTitle,
      ...(typeof seasonNumber === 'number' ? { seasonNumber } : {}),
      ...(typeof episodeNumber === 'number' ? { episodeNumber } : {}),
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

export function clearEpisodeProgress(
  url: string,
  meta?: Omit<EpisodeIdentityInput, 'url'>
): EpisodeProgressMap {
  return clearEpisodesProgressTargets([{ url, ...meta }]);
}

export function setEpisodesWatched(
  urls: string[],
  watched: boolean,
  meta?: {
    seriesUrl?: string;
    seriesTitle?: string;
    episodes?: WatchedEpisodeHistoryItem[];
  }
): { map: EpisodeProgressMap; history: WatchHistoryEntry[] } {
  const nowIso = new Date().toISOString();
  const currentMap = loadEpisodeProgressMap();
  const nextMap = buildWatchedProgressMap(
    currentMap,
    urls,
    watched,
    nowIso,
    1500,
    meta
  );
  saveEpisodeProgressMap(nextMap);

  const historyItems: WatchedEpisodeHistoryItem[] =
    meta?.episodes && meta.episodes.length > 0
      ? meta.episodes.map((ep) => ({
          ...ep,
          seriesUrl: ep.seriesUrl || meta.seriesUrl,
          seriesTitle: ep.seriesTitle || meta.seriesTitle,
        }))
      : urls.map((url) => ({
          url,
          seriesUrl: meta?.seriesUrl,
          seriesTitle: meta?.seriesTitle,
        }));

  const currentHistory = loadHistory();
  const updatedHistory = syncWatchedEpisodesInHistory(
    currentHistory,
    historyItems,
    watched,
    nowIso,
    30
  );
  persistHistoryList(updatedHistory);

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

