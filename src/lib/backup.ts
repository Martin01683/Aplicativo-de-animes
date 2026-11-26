import {
  canonicalEpisodeProgressKey,
  sanitizeEpisodeProgressMap,
  type EpisodeProgressMap,
} from './playbackProgress.ts';
import {
  DEFAULT_APP_SETTINGS,
  sanitizeAppSettings,
  type AppSettings,
} from './settings.ts';
import type { CatalogMediaItem, WatchHistoryEntry } from './types.ts';

export const ANISYNC_BACKUP_FORMAT = 'anisync-backup' as const;
export const ANISYNC_BACKUP_VERSION = 1 as const;

export type BackupImportMode = 'merge' | 'replace';

export interface AnisyncBackupData {
  favorites: CatalogMediaItem[];
  history: WatchHistoryEntry[];
  progressMap: EpisodeProgressMap;
  mutedFavoriteUrls: string[];
  settings: AppSettings;
}

export interface AnisyncBackupPayload {
  format: typeof ANISYNC_BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  appVersion?: string;
  data: AnisyncBackupData;
}

export interface BackupImportSummary {
  favoritesCount: number;
  historyCount: number;
  progressCount: number;
  mutedCount: number;
  exportedAt: string | null;
}

export type ParseBackupResult =
  | {
      ok: true;
      payload: AnisyncBackupPayload;
      summary: BackupImportSummary;
    }
  | {
      ok: false;
      error: string;
    };

function normalizeMediaUrlKey(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  return trimmed.replace(/^http:\/\//i, 'https://').replace(/\/+$/, '').toLowerCase();
}

function sanitizeFavoritesList(raw: unknown): CatalogMediaItem[] {
  if (!Array.isArray(raw)) return [];
  const out: CatalogMediaItem[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Partial<CatalogMediaItem>;
    const url = typeof obj.url === 'string' ? obj.url.trim() : '';
    const title = typeof obj.title === 'string' ? obj.title.trim() : '';
    if (!url || !title) continue;
    const key = normalizeMediaUrlKey(url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const id = typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim() : key;
    const kind =
      obj.kind === 'movie' || obj.kind === 'series' || obj.kind === 'episode'
        ? obj.kind
        : 'anime';
    const audioType = obj.audioType === 'DUB' || obj.audioType === 'LEG' ? obj.audioType : null;
    out.push({
      id,
      title,
      url,
      poster: typeof obj.poster === 'string' ? obj.poster.trim() : '',
      kind,
      audioType,
      ...(typeof obj.year === 'string' && obj.year.trim() ? { year: obj.year.trim() } : {}),
      ...(typeof obj.rating === 'string' && obj.rating.trim() ? { rating: obj.rating.trim() } : {}),
      ...(typeof obj.quality === 'string' && obj.quality.trim()
        ? { quality: obj.quality.trim() }
        : {}),
      ...(typeof obj.statusBadge === 'string' && obj.statusBadge.trim()
        ? { statusBadge: obj.statusBadge.trim() }
        : {}),
      ...(obj.catalogSource === 'thetvdb' ||
      obj.catalogSource === 'livechart' ||
      obj.catalogSource === 'server'
        ? { catalogSource: obj.catalogSource }
        : {}),
      ...(typeof obj.sourceServerName === 'string' && obj.sourceServerName.trim()
        ? { sourceServerName: obj.sourceServerName.trim() }
        : {}),
      ...(obj.externalIds && typeof obj.externalIds === 'object'
        ? { externalIds: obj.externalIds }
        : {}),
    });
    if (out.length >= 60) break;
  }
  return out;
}

function sanitizeHistoryList(raw: unknown): WatchHistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: WatchHistoryEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Partial<WatchHistoryEntry>;
    const url = typeof obj.url === 'string' ? obj.url.trim() : '';
    const title = typeof obj.title === 'string' ? obj.title.trim() : '';
    if (!url || !title) continue;
    const key = canonicalEpisodeProgressKey(url) || normalizeMediaUrlKey(url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      title,
      url,
      poster: typeof obj.poster === 'string' ? obj.poster.trim() : '',
      kind: obj.kind === 'movie' ? 'movie' : 'episode',
      watchedAt:
        typeof obj.watchedAt === 'string' && obj.watchedAt.trim()
          ? obj.watchedAt.trim()
          : new Date().toISOString(),
      ...(typeof obj.seriesUrl === 'string' && obj.seriesUrl.trim()
        ? { seriesUrl: obj.seriesUrl.trim() }
        : {}),
      ...(typeof obj.seriesTitle === 'string' && obj.seriesTitle.trim()
        ? { seriesTitle: obj.seriesTitle.trim() }
        : {}),
      ...(typeof obj.positionSec === 'number' && Number.isFinite(obj.positionSec) && obj.positionSec >= 0
        ? { positionSec: Math.round(obj.positionSec) }
        : {}),
      ...(typeof obj.durationSec === 'number' && Number.isFinite(obj.durationSec) && obj.durationSec > 0
        ? { durationSec: Math.round(obj.durationSec) }
        : {}),
      ...(typeof obj.completed === 'boolean' ? { completed: obj.completed } : {}),
    });
    if (out.length >= 30) break;
  }
  return out;
}

function sanitizeMutedList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    const key = normalizeMediaUrlKey(trimmed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= 100) break;
  }
  return out;
}

export function buildAnisyncBackupPayload(
  data: AnisyncBackupData,
  options: { appVersion?: string; exportedAt?: string } = {}
): AnisyncBackupPayload {
  return {
    format: ANISYNC_BACKUP_FORMAT,
    version: ANISYNC_BACKUP_VERSION,
    exportedAt: options.exportedAt || new Date().toISOString(),
    ...(options.appVersion ? { appVersion: options.appVersion } : {}),
    data: {
      favorites: sanitizeFavoritesList(data.favorites),
      history: sanitizeHistoryList(data.history),
      progressMap: sanitizeEpisodeProgressMap(data.progressMap),
      mutedFavoriteUrls: sanitizeMutedList(data.mutedFavoriteUrls),
      settings: sanitizeAppSettings(data.settings),
    },
  };
}

export function serializeAnisyncBackup(payload: AnisyncBackupPayload): string {
  return JSON.stringify(payload, null, 2);
}

export function buildBackupFilename(now = new Date()): string {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `anisync-backup-${yyyy}-${mm}-${dd}.json`;
}

export function parseAnisyncBackupJson(rawText: string): ParseBackupResult {
  if (!rawText || !rawText.trim()) {
    return { ok: false, error: 'O arquivo de backup está vazio.' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { ok: false, error: 'Arquivo JSON inválido ou corrompido.' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Formato de backup não reconhecido.' };
  }

  const root = parsed as Record<string, unknown>;
  if (root.format !== undefined && root.format !== ANISYNC_BACKUP_FORMAT) {
    return { ok: false, error: 'Este arquivo não é um backup válido do Anisync.' };
  }

  const rawData =
    root.data && typeof root.data === 'object' && !Array.isArray(root.data)
      ? (root.data as Record<string, unknown>)
      : root;

  const hasRecognizedSection =
    Array.isArray(rawData.favorites) ||
    Array.isArray(rawData.history) ||
    (rawData.progressMap && typeof rawData.progressMap === 'object') ||
    Array.isArray(rawData.mutedFavoriteUrls) ||
    (rawData.settings && typeof rawData.settings === 'object');

  if (!hasRecognizedSection) {
    return { ok: false, error: 'O backup não contém dados reconhecidos do Anisync.' };
  }

  const exportedAt =
    typeof root.exportedAt === 'string' && root.exportedAt.trim() ? root.exportedAt.trim() : null;

  const data: AnisyncBackupData = {
    favorites: sanitizeFavoritesList(rawData.favorites),
    history: sanitizeHistoryList(rawData.history),
    progressMap: sanitizeEpisodeProgressMap(rawData.progressMap),
    mutedFavoriteUrls: sanitizeMutedList(rawData.mutedFavoriteUrls),
    settings: sanitizeAppSettings(rawData.settings),
  };

  const payload: AnisyncBackupPayload = {
    format: ANISYNC_BACKUP_FORMAT,
    version: typeof root.version === 'number' ? root.version : ANISYNC_BACKUP_VERSION,
    exportedAt: exportedAt || new Date().toISOString(),
    ...(typeof root.appVersion === 'string' && root.appVersion.trim()
      ? { appVersion: root.appVersion.trim() }
      : {}),
    data,
  };

  return {
    ok: true,
    payload,
    summary: {
      favoritesCount: data.favorites.length,
      historyCount: data.history.length,
      progressCount: Object.keys(data.progressMap).length,
      mutedCount: data.mutedFavoriteUrls.length,
      exportedAt,
    },
  };
}

/**
 * Combines current local user data with an imported backup in either `replace` or `merge` mode.
 */
export function mergeAnisyncBackupData(
  current: AnisyncBackupData,
  incoming: AnisyncBackupData,
  mode: BackupImportMode
): AnisyncBackupData {
  if (mode === 'replace') {
    return {
      favorites: sanitizeFavoritesList(incoming.favorites),
      history: sanitizeHistoryList(incoming.history),
      progressMap: sanitizeEpisodeProgressMap(incoming.progressMap),
      mutedFavoriteUrls: sanitizeMutedList(incoming.mutedFavoriteUrls),
      settings: sanitizeAppSettings(incoming.settings),
    };
  }

  // Merge favorites: preserve current items first, append new ones from backup
  const mergedFavorites: CatalogMediaItem[] = [];
  const favSeen = new Set<string>();
  for (const item of [...current.favorites, ...incoming.favorites]) {
    const key = normalizeMediaUrlKey(item.url);
    if (!key || favSeen.has(key)) continue;
    favSeen.add(key);
    mergedFavorites.push(item);
    if (mergedFavorites.length >= 60) break;
  }

  // Merge progressMap: keep completed entries, or whichever entry was updated most recently
  const mergedProgress: EpisodeProgressMap = { ...sanitizeEpisodeProgressMap(current.progressMap) };
  for (const [key, inc] of Object.entries(sanitizeEpisodeProgressMap(incoming.progressMap))) {
    const cur = mergedProgress[key];
    if (!cur) {
      mergedProgress[key] = inc;
      continue;
    }
    const curTime = Date.parse(cur.updatedAt || '') || 0;
    const incTime = Date.parse(inc.updatedAt || '') || 0;
    if (inc.completed && !cur.completed) {
      mergedProgress[key] = inc;
    } else if (!cur.completed && (incTime > curTime || (incTime === curTime && inc.positionSec > cur.positionSec))) {
      mergedProgress[key] = inc;
    }
  }

  // Merge history: union by canonical key, prefer newer watchedAt, sorted newest-first
  const historyByKey = new Map<string, WatchHistoryEntry>();
  for (const entry of [...current.history, ...incoming.history]) {
    const key = canonicalEpisodeProgressKey(entry.url) || normalizeMediaUrlKey(entry.url);
    if (!key) continue;
    const prev = historyByKey.get(key);
    if (!prev) {
      historyByKey.set(key, entry);
      continue;
    }
    const prevTs = Date.parse(prev.watchedAt || '') || 0;
    const nextTs = Date.parse(entry.watchedAt || '') || 0;
    if (nextTs > prevTs || (entry.completed && !prev.completed)) {
      historyByKey.set(key, { ...prev, ...entry });
    }
  }
  const mergedHistory = Array.from(historyByKey.values())
    .sort((a, b) => (Date.parse(b.watchedAt || '') || 0) - (Date.parse(a.watchedAt || '') || 0))
    .slice(0, 30);

  // Merge muted favorites
  const mergedMuted = sanitizeMutedList([
    ...current.mutedFavoriteUrls,
    ...incoming.mutedFavoriteUrls,
  ]);

  // Merge settings: keep current settings, letting non-default incoming settings override defaults
  const sanitizedCurrent = sanitizeAppSettings(current.settings);
  const sanitizedIncoming = sanitizeAppSettings(incoming.settings);
  const mergedSettings: AppSettings = sanitizeAppSettings({
    ...sanitizedCurrent,
    ...Object.fromEntries(
      Object.entries(sanitizedIncoming).filter(([k, v]) => {
        if (k === 'catalogCredentials') {
          return Boolean(
            (v as AppSettings['catalogCredentials'])?.tvdbApiKey ||
              sanitizedCurrent.catalogCredentials?.tvdbApiKey
          );
        }
        return JSON.stringify(v) !== JSON.stringify((DEFAULT_APP_SETTINGS as unknown as Record<string, unknown>)[k]);
      })
    ),
    catalogCredentials: {
      ...(sanitizedIncoming.catalogCredentials || {}),
      ...(sanitizedCurrent.catalogCredentials?.tvdbApiKey
        ? { tvdbApiKey: sanitizedCurrent.catalogCredentials.tvdbApiKey }
        : {}),
      ...(sanitizedCurrent.catalogCredentials?.tvdbPin
        ? { tvdbPin: sanitizedCurrent.catalogCredentials.tvdbPin }
        : {}),
    },
  });

  return {
    favorites: mergedFavorites,
    history: mergedHistory,
    progressMap: mergedProgress,
    mutedFavoriteUrls: mergedMuted,
    settings: mergedSettings,
  };
}
