import { extractMediaSlug, normalizeTopAnimesUrl } from './favoriteAlerts.ts';
import type { EpisodeCheckIntervalMinutes } from './settings.ts';
import type { FavoriteAlertEntry } from './types.ts';

export type NotificationPermissionStatus = 'granted' | 'denied' | 'default' | 'unsupported';
export type NotificationFilterTab = 'all' | 'unread' | 'episodes' | 'system';

export type ToastKind = 'info' | 'success' | 'warning' | 'error' | 'episode' | 'update';

export interface AppNotificationToast {
  id: string;
  kind: ToastKind;
  title: string;
  description?: string;
  poster?: string;
  actionLabel?: string;
  onAction?: () => void;
  durationMs: number;
  dedupeKey?: string;
}

export interface QuietHoursConfig {
  quietHoursEnabled: boolean;
  quietHoursStart: number;
  quietHoursEnd: number;
}

export function sanitizeHourValue(raw: unknown, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.floor(n);
  if (rounded < 0 || rounded > 23) return fallback;
  return rounded;
}

export function formatHourLabel(hour: number): string {
  const safe = sanitizeHourValue(hour, 0);
  return `${String(safe).padStart(2, '0')}:00`;
}

export function isWithinQuietHours(
  config: QuietHoursConfig,
  now: Date = new Date()
): boolean {
  if (!config.quietHoursEnabled) return false;
  const start = sanitizeHourValue(config.quietHoursStart, 23);
  const end = sanitizeHourValue(config.quietHoursEnd, 8);
  if (start === end) return false;

  const currentHour = now.getHours();
  if (start < end) {
    return currentHour >= start && currentHour < end;
  }
  // Overnight window, e.g. 23:00 -> 08:00
  return currentHour >= start || currentHour < end;
}

export function shouldRunCatchUpEpisodeCheck(
  intervalMinutes: EpisodeCheckIntervalMinutes,
  lastCheckedAt: string | null,
  nowMs: number = Date.now()
): boolean {
  if (!intervalMinutes || intervalMinutes <= 0) return false;
  if (!lastCheckedAt) return true;
  const lastMs = Date.parse(lastCheckedAt);
  if (!Number.isFinite(lastMs)) return true;
  const intervalMs = intervalMinutes * 60 * 1000;
  return nowMs - lastMs >= intervalMs;
}

export function filterFavoriteAlerts(
  alerts: FavoriteAlertEntry[],
  tab: NotificationFilterTab
): FavoriteAlertEntry[] {
  switch (tab) {
    case 'unread':
      return alerts.filter((a) => !a.read);
    case 'system':
      return [];
    case 'episodes':
    case 'all':
    default:
      return alerts;
  }
}

export function markSingleAlertRead(
  alerts: FavoriteAlertEntry[],
  alertId: string
): FavoriteAlertEntry[] {
  let changed = false;
  const next = alerts.map((item) => {
    if (item.id === alertId && !item.read) {
      changed = true;
      return { ...item, read: true };
    }
    return item;
  });
  return changed ? next : alerts;
}

export function toggleSingleAlertRead(
  alerts: FavoriteAlertEntry[],
  alertId: string
): FavoriteAlertEntry[] {
  return alerts.map((item) =>
    item.id === alertId ? { ...item, read: !item.read } : item
  );
}

export function dismissSingleAlert(
  alerts: FavoriteAlertEntry[],
  alertId: string
): FavoriteAlertEntry[] {
  return alerts.filter((item) => item.id !== alertId);
}

export function clearReadFavoriteAlerts(alerts: FavoriteAlertEntry[]): FavoriteAlertEntry[] {
  return alerts.filter((item) => !item.read);
}

export function pruneAlertsForRemovedFavorite(
  alerts: FavoriteAlertEntry[],
  removedAnimeUrl: string
): FavoriteAlertEntry[] {
  const norm = normalizeTopAnimesUrl(removedAnimeUrl);
  const slug = extractMediaSlug(removedAnimeUrl);
  return alerts.filter((alert) => {
    const alertNorm = normalizeTopAnimesUrl(alert.animeUrl);
    if (norm && alertNorm === norm) return false;
    const alertSlug = extractMediaSlug(alert.animeUrl);
    if (slug && alertSlug && alertSlug === slug) return false;
    return true;
  });
}

export function isFavoriteMuted(animeUrl: string, mutedUrls: string[]): boolean {
  if (!animeUrl || mutedUrls.length === 0) return false;
  const norm = normalizeTopAnimesUrl(animeUrl);
  const slug = extractMediaSlug(animeUrl);
  return mutedUrls.some((entry) => {
    if (normalizeTopAnimesUrl(entry) === norm) return true;
    const entrySlug = extractMediaSlug(entry);
    return Boolean(slug && entrySlug && entrySlug === slug);
  });
}

export function toggleFavoriteMutedUrl(
  animeUrl: string,
  mutedUrls: string[]
): { muted: boolean; nextMutedUrls: string[] } {
  const norm = normalizeTopAnimesUrl(animeUrl) || animeUrl;
  const slug = extractMediaSlug(animeUrl);
  const alreadyMuted = isFavoriteMuted(animeUrl, mutedUrls);
  if (alreadyMuted) {
    const nextMutedUrls = mutedUrls.filter((entry) => {
      if (normalizeTopAnimesUrl(entry) === norm) return false;
      const entrySlug = extractMediaSlug(entry);
      if (slug && entrySlug && entrySlug === slug) return false;
      return true;
    });
    return { muted: false, nextMutedUrls };
  }
  return {
    muted: true,
    nextMutedUrls: [norm, ...mutedUrls.filter((entry) => normalizeTopAnimesUrl(entry) !== norm)],
  };
}

export function removeFavoriteMutedUrl(animeUrl: string, mutedUrls: string[]): string[] {
  if (!isFavoriteMuted(animeUrl, mutedUrls)) return mutedUrls;
  return toggleFavoriteMutedUrl(animeUrl, mutedUrls).nextMutedUrls;
}

export function enqueueToastItem(
  queue: AppNotificationToast[],
  toast: AppNotificationToast,
  maxVisible = 3
): AppNotificationToast[] {
  const filtered = toast.dedupeKey
    ? queue.filter((item) => item.dedupeKey !== toast.dedupeKey)
    : queue.filter((item) => item.id !== toast.id);
  const next = [...filtered, toast];
  return next.length > maxVisible ? next.slice(next.length - maxVisible) : next;
}

export function dismissToastItem(
  queue: AppNotificationToast[],
  id: string
): AppNotificationToast[] {
  return queue.filter((item) => item.id !== id);
}

export function syncAppBadge(unreadCount: number): void {
  if (typeof navigator === 'undefined') return;
  const nav = navigator as Navigator & {
    setAppBadge?: (count?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  try {
    if (unreadCount > 0 && typeof nav.setAppBadge === 'function') {
      void nav.setAppBadge(unreadCount).catch(() => undefined);
    } else if (unreadCount <= 0 && typeof nav.clearAppBadge === 'function') {
      void nav.clearAppBadge().catch(() => undefined);
    }
  } catch {
    // Ignore unsupported badge API errors
  }
}

export function playNotificationChime(): void {
  if (typeof window === 'undefined') return;
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return;

  try {
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    const notes = [659.25, 880]; // Gentle E5 -> A5 chime

    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + idx * 0.11);

      gain.gain.setValueAtTime(0.0001, now + idx * 0.11);
      gain.gain.exponentialRampToValueAtTime(0.08, now + idx * 0.11 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.11 + 0.24);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + idx * 0.11);
      osc.stop(now + idx * 0.11 + 0.26);
    });

    window.setTimeout(() => {
      void ctx.close().catch(() => undefined);
    }, 600);
  } catch {
    // Browser autoplay policy may block audio without gesture; fail silently
  }
}
