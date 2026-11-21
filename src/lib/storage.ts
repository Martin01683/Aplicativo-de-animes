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

const FAVORITES_KEY = 'topvlc:favorites:v1';
const HISTORY_KEY = 'topvlc:history:v1';
const ALERTS_KEY = 'topvlc:alerts:v1';
const BASELINES_KEY = 'topvlc:fav_baselines:v1';
const SETTINGS_KEY = 'topvlc:settings:v1';
const SETTINGS_META_KEY = 'topvlc:settings_meta:v1';
const ACK_RELEASE_KEY = 'topvlc:ack_release:v1';

export function loadFavorites(): CatalogMediaItem[] {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
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
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function pushHistoryEntry(entry: WatchHistoryEntry): WatchHistoryEntry[] {
  const existing = loadHistory().filter((item) => item.url !== entry.url);
  const next = [entry, ...existing].slice(0, 30);
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
  } catch {
    // ignore
  }
}

export function loadFavoriteAlerts(): FavoriteAlertEntry[] {
  try {
    const raw = localStorage.getItem(ALERTS_KEY);
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
  } catch {
    // ignore
  }
}

export function loadFavoriteBaselines(): FavoriteBaselineMap {
  try {
    const raw = localStorage.getItem(BASELINES_KEY);
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
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_APP_SETTINGS };
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
    const raw = localStorage.getItem(SETTINGS_META_KEY);
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
    return localStorage.getItem(ACK_RELEASE_KEY) || null;
  } catch {
    return null;
  }
}

export function saveAcknowledgedReleaseKey(key: string | null): void {
  try {
    if (!key) {
      localStorage.removeItem(ACK_RELEASE_KEY);
    } else {
      localStorage.setItem(ACK_RELEASE_KEY, key);
    }
  } catch {
    // ignore
  }
}


