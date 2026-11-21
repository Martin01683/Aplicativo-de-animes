import type { NavSection } from '../components/Header';
import {
  DEFAULT_VIDEO_SCALE,
  sanitizeVideoScaleMode,
  type VideoScaleMode,
} from './playbackProgress';

export type EpisodeCheckIntervalMinutes = 0 | 1 | 5 | 15 | 30 | 60;
export type AppUpdateIntervalHours = 6 | 24 | 168;
export type DefaultAudioFilter = 'ALL' | 'DUB' | 'LEG';
export type SkipIntroSeconds = 30 | 60 | 85 | 90;

export interface AppSettings {
  episodeCheckIntervalMinutes: EpisodeCheckIntervalMinutes;
  checkEpisodesOnStartup: boolean;
  notifyNewEpisodes: boolean;
  autoCheckAppUpdates: boolean;
  checkAppUpdatesOnStartup: boolean;
  appUpdateIntervalHours: AppUpdateIntervalHours;
  autoDownloadAppUpdates: boolean;
  defaultSection: NavSection;
  defaultAudioFilter: DefaultAudioFilter;
  skipIntroSeconds: SkipIntroSeconds;
  autoPlayNextEpisode: boolean;
  videoScale: VideoScaleMode;
}

export interface AppSettingsMeta {
  lastEpisodeCheckAt: string | null;
  lastAppUpdateCheckAt: string | null;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  episodeCheckIntervalMinutes: 15,
  checkEpisodesOnStartup: true,
  notifyNewEpisodes: true,
  autoCheckAppUpdates: true,
  checkAppUpdatesOnStartup: true,
  appUpdateIntervalHours: 24,
  autoDownloadAppUpdates: false,
  defaultSection: 'releases',
  defaultAudioFilter: 'ALL',
  skipIntroSeconds: 85,
  autoPlayNextEpisode: false,
  videoScale: DEFAULT_VIDEO_SCALE,
};

export const DEFAULT_APP_SETTINGS_META: AppSettingsMeta = {
  lastEpisodeCheckAt: null,
  lastAppUpdateCheckAt: null,
};

export const EPISODE_CHECK_INTERVAL_OPTIONS: Array<{
  value: EpisodeCheckIntervalMinutes;
  label: string;
  shortLabel: string;
}> = [
  { value: 1, label: 'A cada 1 minuto', shortLabel: '1 min' },
  { value: 5, label: 'A cada 5 minutos', shortLabel: '5 min' },
  { value: 15, label: 'A cada 15 minutos (Padrão)', shortLabel: '15 min' },
  { value: 30, label: 'A cada 30 minutos', shortLabel: '30 min' },
  { value: 60, label: 'A cada 1 hora', shortLabel: '1 hora' },
  { value: 0, label: 'Somente manual', shortLabel: 'Manual' },
];

export const APP_UPDATE_INTERVAL_OPTIONS: Array<{
  value: AppUpdateIntervalHours;
  label: string;
}> = [
  { value: 6, label: 'A cada 6 horas' },
  { value: 24, label: 'Diariamente (1x por dia)' },
  { value: 168, label: 'Semanalmente' },
];

export const SKIP_INTRO_OPTIONS: SkipIntroSeconds[] = [30, 60, 85, 90];

const VALID_EPISODE_INTERVALS = new Set<number>([0, 1, 5, 15, 30, 60]);
const VALID_UPDATE_INTERVALS = new Set<number>([6, 24, 168]);
const VALID_SECTIONS = new Set<NavSection>(['releases', 'calendar', 'catalog', 'library']);
const VALID_AUDIO_FILTERS = new Set<DefaultAudioFilter>(['ALL', 'DUB', 'LEG']);
const VALID_SKIP_SECONDS = new Set<number>([30, 60, 85, 90]);

export function sanitizeAppSettings(raw: unknown): AppSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_APP_SETTINGS };
  }
  const input = raw as Record<string, unknown>;

  const episodeCheckIntervalMinutes = VALID_EPISODE_INTERVALS.has(
    Number(input.episodeCheckIntervalMinutes)
  )
    ? (Number(input.episodeCheckIntervalMinutes) as EpisodeCheckIntervalMinutes)
    : DEFAULT_APP_SETTINGS.episodeCheckIntervalMinutes;

  const rawUpdateInterval = Number(input.appUpdateIntervalHours);
  const legacyCheckOnStartup =
    input.appUpdateIntervalHours !== undefined &&
    input.appUpdateIntervalHours !== null &&
    input.appUpdateIntervalHours !== '' &&
    rawUpdateInterval === 0;

  const appUpdateIntervalHours = VALID_UPDATE_INTERVALS.has(rawUpdateInterval)
    ? (rawUpdateInterval as AppUpdateIntervalHours)
    : DEFAULT_APP_SETTINGS.appUpdateIntervalHours;

  const checkAppUpdatesOnStartup =
    typeof input.checkAppUpdatesOnStartup === 'boolean'
      ? input.checkAppUpdatesOnStartup
      : legacyCheckOnStartup
        ? true
        : DEFAULT_APP_SETTINGS.checkAppUpdatesOnStartup;

  const defaultSection = VALID_SECTIONS.has(input.defaultSection as NavSection)
    ? (input.defaultSection as NavSection)
    : DEFAULT_APP_SETTINGS.defaultSection;

  const defaultAudioFilter = VALID_AUDIO_FILTERS.has(
    input.defaultAudioFilter as DefaultAudioFilter
  )
    ? (input.defaultAudioFilter as DefaultAudioFilter)
    : DEFAULT_APP_SETTINGS.defaultAudioFilter;

  const skipIntroSeconds = VALID_SKIP_SECONDS.has(Number(input.skipIntroSeconds))
    ? (Number(input.skipIntroSeconds) as SkipIntroSeconds)
    : DEFAULT_APP_SETTINGS.skipIntroSeconds;

  return {
    episodeCheckIntervalMinutes,
    checkEpisodesOnStartup:
      typeof input.checkEpisodesOnStartup === 'boolean'
        ? input.checkEpisodesOnStartup
        : DEFAULT_APP_SETTINGS.checkEpisodesOnStartup,
    notifyNewEpisodes:
      typeof input.notifyNewEpisodes === 'boolean'
        ? input.notifyNewEpisodes
        : DEFAULT_APP_SETTINGS.notifyNewEpisodes,
    autoCheckAppUpdates:
      typeof input.autoCheckAppUpdates === 'boolean'
        ? input.autoCheckAppUpdates
        : DEFAULT_APP_SETTINGS.autoCheckAppUpdates,
    checkAppUpdatesOnStartup,
    appUpdateIntervalHours,
    autoDownloadAppUpdates:
      typeof input.autoDownloadAppUpdates === 'boolean'
        ? input.autoDownloadAppUpdates
        : DEFAULT_APP_SETTINGS.autoDownloadAppUpdates,
    defaultSection,
    defaultAudioFilter,
    skipIntroSeconds,
    autoPlayNextEpisode:
      typeof input.autoPlayNextEpisode === 'boolean'
        ? input.autoPlayNextEpisode
        : DEFAULT_APP_SETTINGS.autoPlayNextEpisode,
    videoScale: sanitizeVideoScaleMode(input.videoScale),
  };
}

export function getEpisodeCheckIntervalMs(minutes: EpisodeCheckIntervalMinutes): number | null {
  if (!minutes || minutes <= 0) return null;
  return minutes * 60 * 1000;
}

export function shouldRunScheduledAppUpdateCheck(
  settings: Pick<AppSettings, 'autoCheckAppUpdates' | 'appUpdateIntervalHours'> & {
    checkAppUpdatesOnStartup?: boolean;
  },
  lastCheckedAt: string | null,
  nowMs: number = Date.now(),
  options?: { isStartup?: boolean }
): boolean {
  if (options?.isStartup && settings.checkAppUpdatesOnStartup) {
    return true;
  }
  if (!settings.autoCheckAppUpdates) return false;
  if (!lastCheckedAt) return true;
  const lastMs = Date.parse(lastCheckedAt);
  if (!Number.isFinite(lastMs)) return true;
  const intervalMs = settings.appUpdateIntervalHours * 60 * 60 * 1000;
  return nowMs - lastMs >= intervalMs;
}

export function formatRelativeTimestamp(iso: string | null, nowMs: number = Date.now()): string {
  if (!iso) return 'Ainda não verificado';
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return 'Ainda não verificado';
  const diffSec = Math.max(0, Math.floor((nowMs - parsed) / 1000));
  if (diffSec < 45) return 'Agora mesmo';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `Há ${diffMin} min`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `Há ${diffHours} h`;
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(parsed));
  } catch {
    return iso;
  }
}
