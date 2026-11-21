import { normalizeTopAnimesUrl } from './favoriteAlerts';

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
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) return '';
  const normalized = normalizeTopAnimesUrl(trimmed) || trimmed;
  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const pathname = parsed.pathname.replace(/\/+$/, '').toLowerCase();
    return `${host}${pathname}${parsed.search}`;
  } catch {
    return normalized
      .replace(/^https?:\/\/(?:www\.)?/i, '')
      .replace(/\/+$/, '')
      .toLowerCase();
  }
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
  maxEntries = 200
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
