import { canonicalEpisodeKey, extractMediaSlug } from './favoriteAlerts';
import type { WatchHistoryEntry } from './types';

export type VideoScaleMode = 'best-fit' | 'fit-screen' | 'fill' | '16:9' | 'original';

export const DEFAULT_VIDEO_SCALE: VideoScaleMode = 'best-fit';

export const VIDEO_SCALE_OPTIONS: Array<{
  id: VideoScaleMode;
  index: number;
  label: string;
}> = [
  { id: 'best-fit', index: 0, label: 'Ajustar (Padrão)' },
  { id: 'fit-screen', index: 1, label: 'Ajustar à tela' },
  { id: 'fill', index: 2, label: 'Preencher' },
  { id: '16:9', index: 3, label: '16:9' },
  { id: 'original', index: 4, label: 'Original' },
];

const VALID_VIDEO_SCALES = new Set<VideoScaleMode>(
  VIDEO_SCALE_OPTIONS.map((opt) => opt.id)
);

export function sanitizeVideoScaleMode(value: unknown): VideoScaleMode {
  if (typeof value === 'string' && VALID_VIDEO_SCALES.has(value as VideoScaleMode)) {
    return value as VideoScaleMode;
  }
  return DEFAULT_VIDEO_SCALE;
}

export function videoScaleToIndex(mode: VideoScaleMode): number {
  const found = VIDEO_SCALE_OPTIONS.find((opt) => opt.id === mode);
  return found ? found.index : 0;
}

export function indexToVideoScale(index: number): VideoScaleMode {
  const found = VIDEO_SCALE_OPTIONS.find((opt) => opt.index === index);
  return found ? found.id : DEFAULT_VIDEO_SCALE;
}

export function getVideoScaleLabel(mode: VideoScaleMode): string {
  const found = VIDEO_SCALE_OPTIONS.find((opt) => opt.id === mode);
  return found ? found.label : VIDEO_SCALE_OPTIONS[0].label;
}

export interface EpisodePlaybackProgress {
  url: string;
  positionSec: number;
  durationSec: number;
  completed: boolean;
  updatedAt: string;
}

export type EpisodeProgressMap = Record<string, EpisodePlaybackProgress>;

export const MIN_RESUME_SECONDS = 2;

export function canonicalEpisodeProgressKey(rawUrl: string): string {
  return canonicalEpisodeKey(rawUrl);
}

export function isEpisodeCompleted(
  positionSec: number,
  durationSec: number,
  ended = false
): boolean {
  if (ended) return true;
  if (!Number.isFinite(positionSec) || positionSec <= 0) return false;
  if (!Number.isFinite(durationSec) || durationSec <= 0) return false;

  const remaining = Math.max(0, durationSec - positionSec);
  const ratio = positionSec / durationSec;

  if (durationSec >= 120) {
    return remaining <= 15 || ratio >= 0.97;
  }
  if (durationSec >= 30) {
    return remaining <= 5 || ratio >= 0.96;
  }
  return remaining <= 2 || ratio >= 0.95;
}

export function getResumePositionSec(
  entry: EpisodePlaybackProgress | null | undefined
): number {
  if (!entry || entry.completed) return 0;
  if (!Number.isFinite(entry.positionSec) || entry.positionSec < MIN_RESUME_SECONDS) {
    return 0;
  }
  if (
    Number.isFinite(entry.durationSec) &&
    entry.durationSec > 0 &&
    isEpisodeCompleted(entry.positionSec, entry.durationSec, false)
  ) {
    return 0;
  }
  return entry.positionSec;
}

export function computeProgressSnapshot(params: {
  url: string;
  positionSec: number;
  durationSec: number;
  ended?: boolean;
  forceReset?: boolean;
  nowIso?: string;
}): EpisodePlaybackProgress | null {
  const key = canonicalEpisodeProgressKey(params.url);
  if (!key) return null;

  const cleanPos =
    Number.isFinite(params.positionSec) && params.positionSec > 0 ? params.positionSec : 0;
  const cleanDur =
    Number.isFinite(params.durationSec) && params.durationSec > 0 ? params.durationSec : 0;
  const updatedAt = params.nowIso || new Date().toISOString();

  if (params.forceReset) {
    return {
      url: params.url,
      positionSec: 0,
      durationSec: Math.round(cleanDur * 10) / 10,
      completed: false,
      updatedAt,
    };
  }

  const completed = isEpisodeCompleted(cleanPos, cleanDur, Boolean(params.ended));
  if (completed) {
    return {
      url: params.url,
      positionSec: 0,
      durationSec: Math.round(cleanDur * 10) / 10,
      completed: true,
      updatedAt,
    };
  }

  if (cleanPos < MIN_RESUME_SECONDS) {
    return null;
  }

  return {
    url: params.url,
    positionSec: Math.round(cleanPos * 10) / 10,
    durationSec: Math.round(cleanDur * 10) / 10,
    completed: false,
    updatedAt,
  };
}

export function upsertEpisodeProgressMap(
  map: EpisodeProgressMap,
  entry: EpisodePlaybackProgress,
  maxEntries = 1500
): EpisodeProgressMap {
  const key = canonicalEpisodeProgressKey(entry.url);
  if (!key) return map;

  const next: EpisodeProgressMap = {
    ...map,
    [key]: entry,
  };

  const keys = Object.keys(next);
  if (keys.length <= maxEntries) {
    return next;
  }

  keys.sort((a, b) => {
    const ta = Date.parse(next[a]?.updatedAt || '') || 0;
    const tb = Date.parse(next[b]?.updatedAt || '') || 0;
    return tb - ta;
  });

  const trimmed: EpisodeProgressMap = {};
  for (const k of keys.slice(0, maxEntries)) {
    trimmed[k] = next[k];
  }
  return trimmed;
}

export function sanitizeEpisodeProgressMap(raw: unknown): EpisodeProgressMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  const out: EpisodeProgressMap = {};
  for (const [, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!val || typeof val !== 'object' || Array.isArray(val)) continue;
    const rec = val as Record<string, unknown>;
    const url = typeof rec.url === 'string' ? rec.url.trim() : '';
    const key = canonicalEpisodeProgressKey(url);
    if (!key) continue;
    const positionSec =
      typeof rec.positionSec === 'number' && Number.isFinite(rec.positionSec) && rec.positionSec >= 0
        ? rec.positionSec
        : 0;
    const durationSec =
      typeof rec.durationSec === 'number' && Number.isFinite(rec.durationSec) && rec.durationSec >= 0
        ? rec.durationSec
        : 0;
    const completed = Boolean(rec.completed);
    const updatedAt =
      typeof rec.updatedAt === 'string' && rec.updatedAt ? rec.updatedAt : new Date(0).toISOString();
    out[key] = {
      url,
      positionSec: completed ? 0 : positionSec,
      durationSec,
      completed,
      updatedAt,
    };
  }
  return out;
}

export function formatPlaybackTimestamp(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

export function buildWatchedProgressMap(
  currentMap: EpisodeProgressMap,
  urls: string[],
  watched: boolean,
  nowIso: string = new Date().toISOString(),
  maxEntries = 1500
): EpisodeProgressMap {
  let next: EpisodeProgressMap = { ...currentMap };
  for (const rawUrl of urls) {
    const url = (rawUrl || '').trim();
    const key = canonicalEpisodeProgressKey(url);
    if (!key) continue;

    if (watched) {
      const existing = next[key];
      next = upsertEpisodeProgressMap(
        next,
        {
          url: existing?.url || url,
          positionSec: 0,
          durationSec: existing?.durationSec ?? 0,
          completed: true,
          updatedAt: nowIso,
        },
        maxEntries
      );
    } else {
      delete next[key];
    }
  }
  return next;
}

export function isEpisodeMarkedWatched(
  url: string,
  progressMap?: EpisodeProgressMap,
  watchedUrls?: Set<string>
): boolean {
  const key = canonicalEpisodeProgressKey(url);
  if (key && progressMap?.[key]?.completed) return true;
  if (watchedUrls?.has(url)) return true;
  if (key && watchedUrls?.has(key)) return true;
  return false;
}

export interface SeasonEpisodeGroup<T> {
  seasonNumber: number;
  label: string;
  episodes: T[];
}

export function groupEpisodesBySeason<
  T extends { seasonNumber?: number; seasonLabel?: string; numberLabel?: string },
>(episodes: T[]): Array<SeasonEpisodeGroup<T>> {
  const groups = new Map<number, SeasonEpisodeGroup<T>>();

  for (const ep of episodes) {
    let seasonNumber =
      typeof ep.seasonNumber === 'number' &&
      Number.isFinite(ep.seasonNumber) &&
      ep.seasonNumber > 0
        ? Math.floor(ep.seasonNumber)
        : 0;

    if (!seasonNumber && ep.numberLabel) {
      const m = ep.numberLabel.trim().match(/^(\d+)\s*[-–/]\s*\d+/);
      if (m?.[1]) {
        const parsed = Number.parseInt(m[1], 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          seasonNumber = parsed;
        }
      }
    }

    if (!seasonNumber) {
      seasonNumber = 1;
    }

    const label = ep.seasonLabel?.trim() || `Temporada ${seasonNumber}`;
    const existing = groups.get(seasonNumber);
    if (existing) {
      existing.episodes.push(ep);
    } else {
      groups.set(seasonNumber, {
        seasonNumber,
        label,
        episodes: [ep],
      });
    }
  }

  return Array.from(groups.values()).sort((a, b) => a.seasonNumber - b.seasonNumber);
}

function normalizeHistorySeriesKey(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function formatHistoryEpisodeTitle(title: string, seriesTitle?: string): string {
  const cleanTitle = (title || '').trim() || 'Episódio';
  const cleanSeries = (seriesTitle || '').trim();
  if (!cleanSeries) return cleanTitle;
  const normSeries = normalizeHistorySeriesKey(cleanSeries);
  const normTitle = normalizeHistorySeriesKey(cleanTitle);
  if (normSeries && normTitle.startsWith(normSeries)) {
    return cleanTitle;
  }
  return `${cleanSeries} — ${cleanTitle}`;
}

export function getHistoryEntrySeriesName(
  entry: Pick<WatchHistoryEntry, 'title' | 'seriesTitle'>
): string {
  const explicit = (entry.seriesTitle || '').trim();
  if (explicit) return explicit;
  const cleaned = (entry.title || '')
    .replace(/\s*[-–—:]\s*(?:temporada\s*\d+\s*[-–—]?\s*)?(?:epis[oó]dio|ep\.?)\s*\d+(?:\.\d+)?.*$/i, '')
    .replace(/\s+(?:epis[oó]dio|ep\.?)\s*\d+(?:\.\d+)?.*$/i, '')
    .replace(/\s*[-–—]\s*\d+\s*x\s*\d+.*$/i, '')
    .trim();
  return cleaned || (entry.title || '').trim();
}

export function isSameHistoryAnime(a: WatchHistoryEntry, b: WatchHistoryEntry): boolean {
  const keyA = canonicalEpisodeProgressKey(a.url);
  const keyB = canonicalEpisodeProgressKey(b.url);
  if (keyA && keyB && keyA === keyB) return true;
  if (a.url && b.url && a.url === b.url) return true;

  const seriesUrlA = a.seriesUrl ? canonicalEpisodeProgressKey(a.seriesUrl) : '';
  const seriesUrlB = b.seriesUrl ? canonicalEpisodeProgressKey(b.seriesUrl) : '';
  if (seriesUrlA && seriesUrlB && seriesUrlA === seriesUrlB) return true;

  const nameKeyA = normalizeHistorySeriesKey(getHistoryEntrySeriesName(a));
  const nameKeyB = normalizeHistorySeriesKey(getHistoryEntrySeriesName(b));
  if (nameKeyA && nameKeyB && nameKeyA === nameKeyB) return true;

  if (!seriesUrlA || !seriesUrlB) {
    const slugA = extractMediaSlug(a.url);
    const slugB = extractMediaSlug(b.url);
    if (slugA && slugB && slugA === slugB) return true;
  }

  return false;
}

export function countAnimeEpisodesInHistory(
  history: WatchHistoryEntry[],
  target: WatchHistoryEntry
): number {
  let count = 0;
  for (const item of history) {
    if (isSameHistoryAnime(item, target)) count += 1;
  }
  return count;
}

export function removeHistoryEpisodeFromList(
  history: WatchHistoryEntry[],
  targetUrl: string
): { nextHistory: WatchHistoryEntry[]; removedUrls: string[] } {
  const targetKey = canonicalEpisodeProgressKey(targetUrl);
  const nextHistory: WatchHistoryEntry[] = [];
  const removedUrls: string[] = [];

  for (const item of history) {
    const itemKey = canonicalEpisodeProgressKey(item.url);
    const matches =
      (targetKey && itemKey && itemKey === targetKey) || item.url === targetUrl;
    if (matches) {
      removedUrls.push(item.url);
    } else {
      nextHistory.push(item);
    }
  }

  return { nextHistory, removedUrls };
}

export function removeHistoryAnimeFromList(
  history: WatchHistoryEntry[],
  target: WatchHistoryEntry
): { nextHistory: WatchHistoryEntry[]; removedUrls: string[] } {
  const nextHistory: WatchHistoryEntry[] = [];
  const removedUrls: string[] = [];

  for (const item of history) {
    if (isSameHistoryAnime(item, target)) {
      removedUrls.push(item.url);
    } else {
      nextHistory.push(item);
    }
  }

  return { nextHistory, removedUrls };
}
