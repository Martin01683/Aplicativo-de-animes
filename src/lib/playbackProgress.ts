import { isAnisyncUri, parentSeriesUriFromEpisode, parseAnisyncUri } from './catalog/idCodec';
import { canonicalEpisodeKey, extractEpisodeNumber, extractMediaSlug } from './favoriteAlerts';
import type { MediaKind, WatchHistoryEntry } from './types';

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
  seriesUrl?: string;
  seriesTitle?: string;
  seasonNumber?: number;
  episodeNumber?: number;
}

export type EpisodeProgressMap = Record<string, EpisodePlaybackProgress>;

export const MIN_RESUME_SECONDS = 2;

export function canonicalEpisodeProgressKey(rawUrl: string): string {
  return canonicalEpisodeKey(rawUrl);
}

const GENERIC_SERIES_NAME_RE =
  /^(?:episodio|ep|filme|movie|ova|especial|special)(?:\s+\d+(?:\.\d+)?)?$/i;

export function stripAudioTagsFromText(raw: string): string {
  const trimmed = (raw || '').trim();
  if (!trimmed) return '';

  let cleaned = trimmed
    // Parenthetical/bracketed standalone audio tags like (Dublado), [DUB], (Dual Áudio), (PT-BR)
    // Intentionally does NOT match "(Dub Japonês)" because "japonês" is not in the token set.
    .replace(
      /[([]\s*(?:dublad[oa]|legendad[oa]|dual\s*[aá]udio|pt[\s-]?br|dub|leg)(?:\s*[/\-|]\s*(?:dublad[oa]|legendad[oa]|dual\s*[aá]udio|pt[\s-]?br|dub|leg))*\s*[)\]]/gi,
      ' '
    )
    // Trailing audio tags with or without separators: "Fool Night Dublado", "Anime - DUB", "Anime | PT-BR"
    .replace(
      /(?:[\s\-–—:|/]+(?:dublad[oa]|legendad[oa]|dual\s*[aá]udio|pt[\s-]?br|dub|leg))+$/i,
      ''
    )
    // Inline Portuguese full audio words (safe as whole words)
    .replace(/\b(?:dublad[oa]|legendad[oa]|dual\s*[aá]udio)\b/gi, ' ')
    .replace(/\s*[-–—:|/]+\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (cleaned.length < 2) {
    cleaned = trimmed;
  }
  return cleaned;
}

export function stripAudioTagsFromSlug(slug: string): string {
  const trimmed = (slug || '').trim().toLowerCase();
  if (!trimmed) return '';
  const stripped = trimmed.replace(
    /(?:-(?:dublad[oa]|legendad[oa]|dual-audio|pt-br|dub|leg))+$/i,
    ''
  );
  return stripped.length >= 2 ? stripped : trimmed;
}

export function normalizeAudioAgnosticSeriesUrlKey(rawUrl: string): string {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) return '';
  if (isAnisyncUri(trimmed)) {
    return canonicalEpisodeProgressKey(trimmed);
  }
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const rawSegments = parsed.pathname
      .toLowerCase()
      .replace(/^\/+|\/+$/g, '')
      .split('/')
      .filter(Boolean);
    if (rawSegments.length === 0) {
      return host;
    }
    if (rawSegments[0] === 'anime-dublado') {
      rawSegments[0] = 'animes';
    }
    rawSegments[rawSegments.length - 1] = stripAudioTagsFromSlug(
      rawSegments[rawSegments.length - 1]
    );
    return `${host}/${rawSegments.join('/')}`;
  } catch {
    const key = canonicalEpisodeProgressKey(trimmed);
    if (!key) return '';
    const parts = key.split('/').filter(Boolean);
    if (parts.length <= 1) return key;
    if (parts[1] === 'anime-dublado') {
      parts[1] = 'animes';
    }
    parts[parts.length - 1] = stripAudioTagsFromSlug(parts[parts.length - 1]);
    return parts.join('/');
  }
}

function isNumericOnlySlug(slug: string): boolean {
  return /^\d+$/.test(slug);
}

function extractAudioAgnosticEpisodeSlug(rawUrl: string): string {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed || isAnisyncUri(trimmed)) return '';

  let pathname = trimmed;
  try {
    pathname = new URL(trimmed).pathname;
  } catch {
    // treat as path/slug
  }

  let clean = pathname
    .toLowerCase()
    .replace(/^\/+|\/+$/g, '')
    .replace(/^(?:animes|anime-dublado|donghua|doramas|tokusatsus|filmes|episodio|videos)\//i, '');

  clean = stripAudioTagsFromSlug(clean);
  clean = clean
    .replace(/-episodio-\d+(?:-\d+)?$/i, '')
    .replace(/-ep-\d+(?:-\d+)?$/i, '')
    .trim();
  clean = stripAudioTagsFromSlug(clean);

  if (!clean || clean.length < 2 || isNumericOnlySlug(clean) || clean.includes('/')) {
    return '';
  }
  return clean;
}

export interface EpisodeIdentityInput {
  url: string;
  seriesUrl?: string;
  seriesTitle?: string;
  title?: string;
  numberLabel?: string;
  seasonNumber?: number;
  episodeNumber?: number | null;
  kind?: MediaKind;
}

function extractEpisodeNumberFromTextOrUrl(raw: string): number | null {
  if (!raw) return null;
  const fromBase = extractEpisodeNumber(raw);
  if (fromBase !== null) return fromBase;

  const epSlugMatch = raw.match(/-ep-(\d+(?:\.\d+)?)(?:-(?:dublad[oa]|legendad[oa]|dual-audio|pt-br|dub|leg))?(?:\/|$|\?)/i);
  if (epSlugMatch?.[1]) {
    const n = Number.parseFloat(epSlugMatch[1]);
    if (Number.isFinite(n)) return n;
  }

  const seasonEpMatch = raw.match(/(?:\bS\d+\s*E|\b\d+\s*x\s*)(\d+(?:\.\d+)?)/i);
  if (seasonEpMatch?.[1]) {
    const n = Number.parseFloat(seasonEpMatch[1]);
    if (Number.isFinite(n)) return n;
  }

  return null;
}

function extractSeasonNumberFromText(raw: string): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const dashMatch = trimmed.match(/^(\d+)\s*[-–/]\s*\d+/);
  if (dashMatch?.[1]) {
    const n = Number.parseInt(dashMatch[1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const tMatch = trimmed.match(/(?:\bT|Temporada\s*|Season\s*|S)(\d+)(?=\s*(?:[·\-:xE]|Epis[oó]dio|Ep\.?|\b))/i);
  if (tMatch?.[1]) {
    const n = Number.parseInt(tMatch[1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const xMatch = trimmed.match(/\b(\d+)\s*x\s*\d+/i);
  if (xMatch?.[1]) {
    const n = Number.parseInt(xMatch[1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function extractEpisodeCoordinates(input: EpisodeIdentityInput): {
  seasonNumber: number;
  explicitSeason: boolean;
  episodeNumber: number | null;
} {
  const parsedUri = parseAnisyncUri(input.url || '');

  let seasonNumber = 1;
  let explicitSeason = false;
  if (
    typeof input.seasonNumber === 'number' &&
    Number.isFinite(input.seasonNumber) &&
    input.seasonNumber >= 0
  ) {
    seasonNumber = Math.floor(input.seasonNumber);
    explicitSeason = true;
  } else if (parsedUri.kind === 'episode') {
    seasonNumber = parsedUri.seasonNumber;
    explicitSeason = true;
  } else {
    const parsedFromLabel = input.numberLabel ? extractSeasonNumberFromText(input.numberLabel) : null;
    const parsedFromTitle = input.title ? extractSeasonNumberFromText(input.title) : null;
    if (parsedFromLabel !== null) {
      seasonNumber = parsedFromLabel;
      explicitSeason = true;
    } else if (parsedFromTitle !== null) {
      seasonNumber = parsedFromTitle;
      explicitSeason = true;
    }
  }

  let episodeNumber: number | null = null;
  if (
    typeof input.episodeNumber === 'number' &&
    Number.isFinite(input.episodeNumber) &&
    input.episodeNumber > 0
  ) {
    episodeNumber = input.episodeNumber;
  } else if (parsedUri.kind === 'episode') {
    episodeNumber = parsedUri.episodeNumber;
  } else {
    if (input.numberLabel) {
      const labelTrimmed = input.numberLabel.trim();
      const dashEp = labelTrimmed.match(/^\d+\s*[-–/]\s*(\d+(?:\.\d+)?)/);
      if (dashEp?.[1]) {
        const n = Number.parseFloat(dashEp[1]);
        if (Number.isFinite(n) && n > 0) episodeNumber = n;
      }
      if (episodeNumber === null) {
        episodeNumber = extractEpisodeNumberFromTextOrUrl(labelTrimmed);
      }
      if (episodeNumber === null && /^\d+(?:\.\d+)?$/.test(labelTrimmed)) {
        const n = Number.parseFloat(labelTrimmed);
        if (Number.isFinite(n) && n > 0) episodeNumber = n;
      }
    }
    if (episodeNumber === null && input.title) {
      episodeNumber = extractEpisodeNumberFromTextOrUrl(input.title);
    }
    if (episodeNumber === null && input.url) {
      episodeNumber = extractEpisodeNumberFromTextOrUrl(input.url);
    }
  }

  return { seasonNumber, explicitSeason, episodeNumber };
}

export function getUnifiedEpisodeKeys(input: EpisodeIdentityInput): string[] {
  const keys = new Set<string>();
  const url = (input.url || '').trim();
  const parsedUri = parseAnisyncUri(url);
  const { seasonNumber, episodeNumber } = extractEpisodeCoordinates(input);
  const isMovie = input.kind === 'movie';

  if (parsedUri.kind === 'episode') {
    keys.add(
      `ep:anisync:${parsedUri.mediaType}/${parsedUri.source}/${parsedUri.externalId.toLowerCase()}:s${parsedUri.seasonNumber}:e${parsedUri.episodeNumber}`
    );
  }

  const resolvedSeriesUrl = (input.seriesUrl || parentSeriesUriFromEpisode(url) || '').trim();
  if (resolvedSeriesUrl) {
    const normSeriesUrl = normalizeAudioAgnosticSeriesUrlKey(resolvedSeriesUrl);
    if (normSeriesUrl) {
      if (episodeNumber !== null) {
        keys.add(`ep:surl:${normSeriesUrl}:s${seasonNumber}:e${episodeNumber}`);
      } else if (isMovie) {
        keys.add(`ep:movie:surl:${normSeriesUrl}`);
      }
    }
  }

  const cleanSlug = extractAudioAgnosticEpisodeSlug(url);
  if (cleanSlug) {
    if (episodeNumber !== null) {
      keys.add(`ep:slug:${cleanSlug}:e${episodeNumber}`);
    } else if (isMovie) {
      keys.add(`ep:movie:slug:${cleanSlug}`);
    }
  }

  const rawSeriesName =
    (input.seriesTitle || '').trim() ||
    (input.title
      ? getHistoryEntrySeriesName({ title: input.title, seriesTitle: input.seriesTitle })
      : '');
  const normSeriesName = normalizeHistorySeriesKey(rawSeriesName);
  if (
    normSeriesName &&
    normSeriesName.length >= 2 &&
    !GENERIC_SERIES_NAME_RE.test(normSeriesName)
  ) {
    if (episodeNumber !== null) {
      keys.add(`ep:sname:${normSeriesName}:s${seasonNumber}:e${episodeNumber}`);
    } else if (isMovie) {
      keys.add(`ep:movie:sname:${normSeriesName}`);
    }
  }

  return Array.from(keys);
}

export function getEpisodeIdentityKeys(input: EpisodeIdentityInput): string[] {
  const keys = new Set<string>();
  const exactKey = canonicalEpisodeProgressKey(input.url);
  if (exactKey) keys.add(exactKey);
  for (const k of getUnifiedEpisodeKeys(input)) {
    keys.add(k);
  }
  return Array.from(keys);
}

export function isSameUnifiedEpisode(
  a: EpisodeIdentityInput,
  b: EpisodeIdentityInput
): boolean {
  const keyA = canonicalEpisodeProgressKey(a.url);
  const keyB = canonicalEpisodeProgressKey(b.url);
  if (keyA && keyB && keyA === keyB) return true;
  if (a.url && b.url && a.url.trim() === b.url.trim()) return true;

  const unifiedA = getUnifiedEpisodeKeys(a);
  if (unifiedA.length === 0) return false;
  const unifiedB = getUnifiedEpisodeKeys(b);
  if (unifiedB.length === 0) return false;

  const setB = new Set(unifiedB);
  for (const k of unifiedA) {
    if (setB.has(k)) return true;
  }
  return false;
}

export function findEpisodeProgressInMap(
  progressMap: EpisodeProgressMap | undefined,
  url: string,
  meta?: Omit<EpisodeIdentityInput, 'url'>
): EpisodePlaybackProgress | undefined {
  if (!progressMap) return undefined;
  const exactKey = canonicalEpisodeProgressKey(url);
  if (exactKey && progressMap[exactKey]) {
    return progressMap[exactKey];
  }

  const targetKeys = new Set(getUnifiedEpisodeKeys({ url, ...meta }));
  if (targetKeys.size === 0) return undefined;

  let best: EpisodePlaybackProgress | undefined;
  let bestTime = -1;

  for (const entry of Object.values(progressMap)) {
    if (!entry?.url) continue;
    const entryKeys = getUnifiedEpisodeKeys(entry);
    let matched = false;
    for (const k of entryKeys) {
      if (targetKeys.has(k)) {
        matched = true;
        break;
      }
    }
    if (!matched) continue;
    const ts = Date.parse(entry.updatedAt || '') || 0;
    if (!best || ts >= bestTime) {
      best = entry;
      bestTime = ts;
    }
  }

  return best;
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
  seriesUrl?: string;
  seriesTitle?: string;
  seasonNumber?: number;
  episodeNumber?: number | null;
  title?: string;
}): EpisodePlaybackProgress | null {
  const key = canonicalEpisodeProgressKey(params.url);
  if (!key) return null;

  const cleanPos =
    Number.isFinite(params.positionSec) && params.positionSec > 0 ? params.positionSec : 0;
  const cleanDur =
    Number.isFinite(params.durationSec) && params.durationSec > 0 ? params.durationSec : 0;
  const updatedAt = params.nowIso || new Date().toISOString();
  const seriesUrl =
    (params.seriesUrl || parentSeriesUriFromEpisode(params.url) || '').trim() || undefined;
  const seriesTitle = (params.seriesTitle || '').trim() || undefined;
  const coords = extractEpisodeCoordinates({
    url: params.url,
    seriesUrl,
    seriesTitle,
    title: params.title,
    seasonNumber: params.seasonNumber,
    episodeNumber: params.episodeNumber,
  });
  const seriesMeta = {
    ...(seriesUrl ? { seriesUrl } : {}),
    ...(seriesTitle ? { seriesTitle } : {}),
    ...(coords.explicitSeason ? { seasonNumber: coords.seasonNumber } : {}),
    ...(coords.episodeNumber !== null ? { episodeNumber: coords.episodeNumber } : {}),
  };

  if (params.forceReset) {
    return {
      url: params.url,
      positionSec: 0,
      durationSec: Math.round(cleanDur * 10) / 10,
      completed: false,
      updatedAt,
      ...seriesMeta,
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
      ...seriesMeta,
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
    ...seriesMeta,
  };
}

export function upsertEpisodeProgressMap(
  map: EpisodeProgressMap,
  entry: EpisodePlaybackProgress,
  maxEntries = 1500
): EpisodeProgressMap {
  const key = canonicalEpisodeProgressKey(entry.url);
  if (!key) return map;

  const existing = map[key];
  const entryUnifiedKeys = new Set(getUnifiedEpisodeKeys(entry));

  // Find any counterpart DUB/LEG entries in map that represent the same episode
  const counterpartKeys: string[] = [];
  let counterpartMeta: EpisodePlaybackProgress | undefined;
  if (entryUnifiedKeys.size > 0) {
    for (const [otherKey, otherEntry] of Object.entries(map)) {
      if (otherKey === key || !otherEntry) continue;
      const otherUnified = getUnifiedEpisodeKeys(otherEntry);
      if (otherUnified.some((k) => entryUnifiedKeys.has(k))) {
        counterpartKeys.push(otherKey);
        if (
          !counterpartMeta ||
          (Date.parse(otherEntry.updatedAt || '') || 0) >=
            (Date.parse(counterpartMeta.updatedAt || '') || 0)
        ) {
          counterpartMeta = otherEntry;
        }
      }
    }
  }

  const fallbackMeta = existing || counterpartMeta;
  const mergedSeriesUrl =
    (
      entry.seriesUrl ||
      fallbackMeta?.seriesUrl ||
      parentSeriesUriFromEpisode(entry.url) ||
      ''
    ).trim() || undefined;
  const mergedSeriesTitle =
    (entry.seriesTitle || fallbackMeta?.seriesTitle || '').trim() || undefined;
  const mergedSeasonNumber =
    typeof entry.seasonNumber === 'number' && Number.isFinite(entry.seasonNumber)
      ? Math.floor(entry.seasonNumber)
      : fallbackMeta?.seasonNumber;
  const mergedEpisodeNumber =
    typeof entry.episodeNumber === 'number' && Number.isFinite(entry.episodeNumber)
      ? entry.episodeNumber
      : fallbackMeta?.episodeNumber;
  const mergedDurationSec =
    entry.durationSec > 0
      ? entry.durationSec
      : entry.completed && fallbackMeta && fallbackMeta.durationSec > 0
        ? fallbackMeta.durationSec
        : entry.durationSec;

  const mergedEntry: EpisodePlaybackProgress = {
    ...entry,
    durationSec: mergedDurationSec,
    ...(mergedSeriesUrl ? { seriesUrl: mergedSeriesUrl } : {}),
    ...(mergedSeriesTitle ? { seriesTitle: mergedSeriesTitle } : {}),
    ...(typeof mergedSeasonNumber === 'number' ? { seasonNumber: mergedSeasonNumber } : {}),
    ...(typeof mergedEpisodeNumber === 'number' ? { episodeNumber: mergedEpisodeNumber } : {}),
  };

  const next: EpisodeProgressMap = {
    ...map,
    [key]: mergedEntry,
  };
  for (const staleKey of counterpartKeys) {
    delete next[staleKey];
  }

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
    const seriesUrl =
      typeof rec.seriesUrl === 'string' && rec.seriesUrl.trim() ? rec.seriesUrl.trim() : undefined;
    const seriesTitle =
      typeof rec.seriesTitle === 'string' && rec.seriesTitle.trim()
        ? rec.seriesTitle.trim()
        : undefined;
    const seasonNumber =
      typeof rec.seasonNumber === 'number' &&
      Number.isFinite(rec.seasonNumber) &&
      rec.seasonNumber >= 0
        ? Math.floor(rec.seasonNumber)
        : undefined;
    const episodeNumber =
      typeof rec.episodeNumber === 'number' &&
      Number.isFinite(rec.episodeNumber) &&
      rec.episodeNumber > 0
        ? rec.episodeNumber
        : undefined;
    out[key] = {
      url,
      positionSec: completed ? 0 : positionSec,
      durationSec,
      completed,
      updatedAt,
      ...(seriesUrl ? { seriesUrl } : {}),
      ...(seriesTitle ? { seriesTitle } : {}),
      ...(typeof seasonNumber === 'number' ? { seasonNumber } : {}),
      ...(typeof episodeNumber === 'number' ? { episodeNumber } : {}),
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

export function formatHistoryWatchedDate(iso: string | null | undefined): string {
  if (!iso || typeof iso !== 'string') return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

export function formatHistoryWatchedDateTime(iso: string | null | undefined): string {
  if (!iso || typeof iso !== 'string') return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${dd}/${mm}/${yyyy} às ${hh}:${min}`;
}

export function buildWatchedProgressMap(
  currentMap: EpisodeProgressMap,
  urls: string[],
  watched: boolean,
  nowIso: string = new Date().toISOString(),
  maxEntries = 1500,
  meta?: {
    seriesUrl?: string;
    seriesTitle?: string;
    episodes?: WatchedEpisodeHistoryItem[];
  }
): EpisodeProgressMap {
  let next: EpisodeProgressMap = { ...currentMap };
  const cleanMetaSeriesUrl = (meta?.seriesUrl || '').trim() || undefined;
  const cleanMetaSeriesTitle = (meta?.seriesTitle || '').trim() || undefined;

  const epMetaByKey = new Map<string, WatchedEpisodeHistoryItem>();
  if (meta?.episodes) {
    for (const ep of meta.episodes) {
      const k = canonicalEpisodeProgressKey(ep.url) || ep.url.trim();
      if (k && !epMetaByKey.has(k)) {
        epMetaByKey.set(k, ep);
      }
    }
  }

  for (const rawUrl of urls) {
    const url = (rawUrl || '').trim();
    const key = canonicalEpisodeProgressKey(url);
    if (!key) continue;

    const epMeta = epMetaByKey.get(key) || epMetaByKey.get(url);
    const identityInput: EpisodeIdentityInput = {
      url,
      seriesUrl: epMeta?.seriesUrl || cleanMetaSeriesUrl || parentSeriesUriFromEpisode(url) || undefined,
      seriesTitle: epMeta?.seriesTitle || cleanMetaSeriesTitle || undefined,
      title: epMeta?.title,
      numberLabel: epMeta?.numberLabel,
      seasonNumber: epMeta?.seasonNumber,
      episodeNumber: epMeta?.episodeNumber,
      kind: epMeta?.kind,
    };

    if (watched) {
      const existing = findEpisodeProgressInMap(next, url, identityInput);
      const seriesUrl =
        identityInput.seriesUrl || existing?.seriesUrl || parentSeriesUriFromEpisode(url) || undefined;
      const seriesTitle = identityInput.seriesTitle || existing?.seriesTitle || undefined;
      const coords = extractEpisodeCoordinates(identityInput);
      const seasonNumber = coords.explicitSeason ? coords.seasonNumber : existing?.seasonNumber;
      const episodeNumber =
        coords.episodeNumber !== null ? coords.episodeNumber : existing?.episodeNumber;
      next = upsertEpisodeProgressMap(
        next,
        {
          url,
          positionSec: 0,
          durationSec: existing?.durationSec ?? 0,
          completed: true,
          updatedAt: nowIso,
          ...(seriesUrl ? { seriesUrl } : {}),
          ...(seriesTitle ? { seriesTitle } : {}),
          ...(typeof seasonNumber === 'number' ? { seasonNumber } : {}),
          ...(typeof episodeNumber === 'number' ? { episodeNumber } : {}),
        },
        maxEntries
      );
    } else {
      delete next[key];
      const targetKeys = new Set(getUnifiedEpisodeKeys(identityInput));
      if (targetKeys.size > 0) {
        for (const [entryKey, entry] of Object.entries(next)) {
          if (!entry) continue;
          const entryUnified = getUnifiedEpisodeKeys(entry);
          if (entryUnified.some((k) => targetKeys.has(k))) {
            delete next[entryKey];
          }
        }
      }
    }
  }
  return next;
}

export interface WatchedEpisodeHistoryItem {
  url: string;
  title?: string;
  numberLabel?: string;
  seasonNumber?: number;
  episodeNumber?: number | null;
  poster?: string;
  seriesTitle?: string;
  seriesUrl?: string;
  kind?: 'episode' | 'movie';
}

const PLACEHOLDER_EPISODE_TITLE_RE = /^(?:unknown|tba|tbd|untitled|n\/a|sem\s+t[ií]tulo|-+)$/i;

function formatWatchedEpisodeHistoryTitle(
  ep: WatchedEpisodeHistoryItem,
  seriesTitle?: string
): string {
  const rawTitle = (ep.title || '').trim();
  const cleanTitle = PLACEHOLDER_EPISODE_TITLE_RE.test(rawTitle) ? '' : rawTitle;
  const cleanSeries = (seriesTitle || '').trim();

  if (ep.kind === 'movie') {
    return formatHistoryEpisodeTitle(cleanTitle || cleanSeries || 'Filme', cleanSeries);
  }

  if (
    cleanTitle &&
    /(?:epis[oó]dio|ep\.?\s*\d+|\bT\d+\s*[·\-:]\s*EP|\b\d+\s*x\s*\d+)/i.test(cleanTitle)
  ) {
    return formatHistoryEpisodeTitle(cleanTitle, cleanSeries);
  }

  if (typeof ep.episodeNumber === 'number' && Number.isFinite(ep.episodeNumber)) {
    const seasonNum =
      typeof ep.seasonNumber === 'number' && Number.isFinite(ep.seasonNumber) && ep.seasonNumber > 0
        ? Math.floor(ep.seasonNumber)
        : 1;
    const epPrefix =
      seasonNum > 1
        ? `T${seasonNum} · Episódio ${ep.episodeNumber}`
        : `Episódio ${ep.episodeNumber}`;
    const combined =
      cleanTitle && cleanTitle.toLowerCase() !== cleanSeries.toLowerCase()
        ? `${epPrefix} — ${cleanTitle}`
        : epPrefix;
    return formatHistoryEpisodeTitle(combined, cleanSeries);
  }

  const label = (ep.numberLabel || '').trim();
  if (label) {
    const combined =
      cleanTitle && cleanTitle.toLowerCase() !== label.toLowerCase()
        ? `${label} — ${cleanTitle}`
        : label;
    return formatHistoryEpisodeTitle(combined, cleanSeries);
  }

  return formatHistoryEpisodeTitle(cleanTitle || 'Episódio', cleanSeries);
}

export function syncWatchedEpisodesInHistory(
  currentHistory: WatchHistoryEntry[],
  episodes: WatchedEpisodeHistoryItem[],
  watched: boolean,
  nowIso: string = new Date().toISOString(),
  maxItems = 30
): WatchHistoryEntry[] {
  const deduped: Array<{ key: string; ep: WatchedEpisodeHistoryItem; index: number }> = [];

  episodes.forEach((ep, index) => {
    const url = (ep.url || '').trim();
    if (!url) return;
    const normalizedEp: WatchedEpisodeHistoryItem = { ...ep, url };
    if (deduped.some((existing) => isSameUnifiedEpisode(existing.ep, normalizedEp))) {
      return;
    }
    const key = canonicalEpisodeProgressKey(url) || url;
    deduped.push({ key, ep: normalizedEp, index });
  });

  if (deduped.length === 0) {
    return currentHistory;
  }

  const matchesAnyTarget = (item: WatchHistoryEntry) =>
    deduped.some(({ ep }) => isSameUnifiedEpisode(item, ep));

  if (!watched) {
    return currentHistory.filter((item) => !matchesAnyTarget(item));
  }

  const ordered =
    deduped.length > 1
      ? [...deduped].sort((a, b) => {
          const sa =
            typeof a.ep.seasonNumber === 'number' && Number.isFinite(a.ep.seasonNumber)
              ? a.ep.seasonNumber
              : 0;
          const sb =
            typeof b.ep.seasonNumber === 'number' && Number.isFinite(b.ep.seasonNumber)
              ? b.ep.seasonNumber
              : 0;
          if (sa !== sb) return sb - sa;

          const ea =
            typeof a.ep.episodeNumber === 'number' && Number.isFinite(a.ep.episodeNumber)
              ? a.ep.episodeNumber
              : null;
          const eb =
            typeof b.ep.episodeNumber === 'number' && Number.isFinite(b.ep.episodeNumber)
              ? b.ep.episodeNumber
              : null;
          if (ea !== null && eb !== null && ea !== eb) return eb - ea;
          if (eb !== null && ea === null) return 1;
          if (ea !== null && eb === null) return -1;

          return b.index - a.index;
        })
      : deduped;

  const baseMs = Date.parse(nowIso) || Date.now();
  const nextMarkedEntries: WatchHistoryEntry[] = ordered.map(({ ep }, idx) => {
    const existing = currentHistory.find((item) => isSameUnifiedEpisode(item, ep));
    const seriesTitle = (ep.seriesTitle || existing?.seriesTitle || '').trim() || undefined;
    const seriesUrl =
      (ep.seriesUrl || existing?.seriesUrl || parentSeriesUriFromEpisode(ep.url) || '').trim() ||
      undefined;
    const poster = (ep.poster || existing?.poster || '').trim();
    const kind: 'episode' | 'movie' =
      ep.kind === 'movie' || (!ep.kind && existing?.kind === 'movie') ? 'movie' : 'episode';
    const coords = extractEpisodeCoordinates({ ...ep, seriesTitle, seriesUrl, kind });
    const seasonNumber = coords.explicitSeason ? coords.seasonNumber : existing?.seasonNumber;
    const episodeNumber =
      coords.episodeNumber !== null ? coords.episodeNumber : existing?.episodeNumber;
    const title =
      existing?.title && !ep.title && ep.episodeNumber == null && !ep.numberLabel
        ? formatHistoryEpisodeTitle(existing.title, seriesTitle)
        : formatWatchedEpisodeHistoryTitle({ ...ep, kind }, seriesTitle);

    return {
      ...existing,
      url: ep.url,
      title,
      seriesTitle,
      seriesUrl,
      ...(typeof seasonNumber === 'number' ? { seasonNumber } : {}),
      ...(typeof episodeNumber === 'number' ? { episodeNumber } : {}),
      poster,
      kind,
      watchedAt: idx === 0 ? nowIso : new Date(baseMs - idx).toISOString(),
      positionSec: 0,
      durationSec: existing?.durationSec,
      completed: true,
    };
  });

  const remaining = currentHistory.filter((item) => !matchesAnyTarget(item));

  return [...nextMarkedEntries, ...remaining].slice(0, maxItems);
}

export function isEpisodeMarkedWatched(
  url: string,
  progressMap?: EpisodeProgressMap,
  watchedUrls?: Set<string>,
  meta?: Omit<EpisodeIdentityInput, 'url'>
): boolean {
  const key = canonicalEpisodeProgressKey(url);
  if (key && progressMap?.[key]?.completed) return true;
  if (watchedUrls?.has(url)) return true;
  if (key && watchedUrls?.has(key)) return true;

  const unifiedKeys = getUnifiedEpisodeKeys({ url, ...meta });
  if (watchedUrls && unifiedKeys.length > 0) {
    for (const k of unifiedKeys) {
      if (watchedUrls.has(k)) return true;
    }
  }

  if (progressMap && unifiedKeys.length > 0) {
    const matched = findEpisodeProgressInMap(progressMap, url, meta);
    if (matched?.completed) return true;
  }

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
  return stripAudioTagsFromText(raw)
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
    .replace(/\s*[-–—:]\s*(?:temporada\s*\d+\s*[-–—]?\s*)?(?:T\d+\s*[·\-:]\s*)?(?:epis[oó]dio|ep\.?)\s*\d+(?:\.\d+)?.*$/i, '')
    .replace(/\s+(?:epis[oó]dio|ep\.?)\s*\d+(?:\.\d+)?.*$/i, '')
    .replace(/\s*[-–—]\s*\d+\s*x\s*\d+.*$/i, '')
    .trim();
  return cleaned || (entry.title || '').trim();
}

export function isSameHistoryAnime(a: WatchHistoryEntry, b: WatchHistoryEntry): boolean {
  if (isSameUnifiedEpisode(a, b)) return true;

  const resolvedSeriesUrlA = a.seriesUrl || parentSeriesUriFromEpisode(a.url) || '';
  const resolvedSeriesUrlB = b.seriesUrl || parentSeriesUriFromEpisode(b.url) || '';
  const seriesUrlA = resolvedSeriesUrlA
    ? normalizeAudioAgnosticSeriesUrlKey(resolvedSeriesUrlA)
    : '';
  const seriesUrlB = resolvedSeriesUrlB
    ? normalizeAudioAgnosticSeriesUrlKey(resolvedSeriesUrlB)
    : '';
  if (seriesUrlA && seriesUrlB && seriesUrlA === seriesUrlB) return true;

  const nameKeyA = normalizeHistorySeriesKey(getHistoryEntrySeriesName(a));
  const nameKeyB = normalizeHistorySeriesKey(getHistoryEntrySeriesName(b));
  if (nameKeyA && nameKeyB && nameKeyA === nameKeyB) return true;

  if (!seriesUrlA || !seriesUrlB) {
    const slugA = stripAudioTagsFromSlug(extractMediaSlug(a.url));
    const slugB = stripAudioTagsFromSlug(extractMediaSlug(b.url));
    if (
      slugA &&
      slugB &&
      !isNumericOnlySlug(slugA) &&
      !isNumericOnlySlug(slugB) &&
      slugA === slugB
    ) {
      return true;
    }
  }

  return false;
}

interface HistoryAnimeIdentifiers {
  episodeUrlKeys: Set<string>;
  seriesUrlKeys: Set<string>;
  seriesNameKeys: Set<string>;
  mediaSlugs: Set<string>;
}

function collectHistoryAnimeIdentifiers(
  target: WatchHistoryEntry,
  matchedHistoryEntries: WatchHistoryEntry[] = []
): HistoryAnimeIdentifiers {
  const episodeUrlKeys = new Set<string>();
  const seriesUrlKeys = new Set<string>();
  const seriesNameKeys = new Set<string>();
  const mediaSlugs = new Set<string>();

  const addEntry = (entry: WatchHistoryEntry) => {
    for (const k of getEpisodeIdentityKeys(entry)) {
      episodeUrlKeys.add(k);
    }

    const parentUri = parentSeriesUriFromEpisode(entry.url);
    for (const candidateSeriesUrl of [entry.seriesUrl, parentUri]) {
      if (!candidateSeriesUrl) continue;
      const sk = normalizeAudioAgnosticSeriesUrlKey(candidateSeriesUrl);
      if (sk) seriesUrlKeys.add(sk);
      const slug = stripAudioTagsFromSlug(extractMediaSlug(candidateSeriesUrl));
      if (slug && !isNumericOnlySlug(slug)) {
        mediaSlugs.add(slug);
      }
    }

    const epSlug =
      extractAudioAgnosticEpisodeSlug(entry.url) ||
      stripAudioTagsFromSlug(extractMediaSlug(entry.url));
    if (epSlug && !isNumericOnlySlug(epSlug)) {
      mediaSlugs.add(epSlug);
    }

    const nameKey = normalizeHistorySeriesKey(getHistoryEntrySeriesName(entry));
    if (nameKey) {
      seriesNameKeys.add(nameKey);
    }
  };

  addEntry(target);
  for (const item of matchedHistoryEntries) {
    addEntry(item);
  }

  return { episodeUrlKeys, seriesUrlKeys, seriesNameKeys, mediaSlugs };
}

function doesProgressEntryMatchAnime(
  progressKey: string,
  entry: EpisodePlaybackProgress,
  ids: HistoryAnimeIdentifiers
): boolean {
  const urlKey = canonicalEpisodeProgressKey(entry.url) || progressKey;
  if (urlKey && ids.episodeUrlKeys.has(urlKey)) return true;
  for (const uk of getUnifiedEpisodeKeys(entry)) {
    if (ids.episodeUrlKeys.has(uk)) return true;
  }

  const parentUri = parentSeriesUriFromEpisode(entry.url);
  for (const candidateSeriesUrl of [entry.seriesUrl, parentUri]) {
    if (!candidateSeriesUrl) continue;
    const sk = normalizeAudioAgnosticSeriesUrlKey(candidateSeriesUrl);
    if (sk && ids.seriesUrlKeys.has(sk)) return true;
  }

  if (entry.seriesTitle) {
    const nameKey = normalizeHistorySeriesKey(entry.seriesTitle);
    if (nameKey && ids.seriesNameKeys.has(nameKey)) return true;
  }

  for (const candidateUrl of [entry.seriesUrl, entry.url]) {
    if (!candidateUrl) continue;
    const slug =
      extractAudioAgnosticEpisodeSlug(candidateUrl) ||
      stripAudioTagsFromSlug(extractMediaSlug(candidateUrl));
    if (!slug || isNumericOnlySlug(slug)) continue;
    if (ids.mediaSlugs.has(slug)) return true;
    if (!slug.includes('/')) {
      const slugAsName = normalizeHistorySeriesKey(slug);
      if (slugAsName.length >= 3 && ids.seriesNameKeys.has(slugAsName)) {
        return true;
      }
    }
  }

  return false;
}

export function removeAnimeProgressFromMap(
  progressMap: EpisodeProgressMap,
  target: WatchHistoryEntry,
  matchedHistoryEntries: WatchHistoryEntry[] = []
): { nextProgressMap: EpisodeProgressMap; removedKeys: string[] } {
  const ids = collectHistoryAnimeIdentifiers(target, matchedHistoryEntries);
  const removedKeys: string[] = [];
  let changed = false;
  const nextProgressMap: EpisodeProgressMap = {};

  for (const [key, entry] of Object.entries(progressMap)) {
    if (!entry) continue;
    if (doesProgressEntryMatchAnime(key, entry, ids)) {
      removedKeys.push(key);
      changed = true;
    } else {
      nextProgressMap[key] = entry;
    }
  }

  return {
    nextProgressMap: changed ? nextProgressMap : progressMap,
    removedKeys,
  };
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

export function countAnimeTrackedEpisodes(
  history: WatchHistoryEntry[],
  progressMap: EpisodeProgressMap | undefined,
  target: WatchHistoryEntry
): { historyCount: number; progressCount: number; totalCount: number } {
  const matchedHistory: WatchHistoryEntry[] = [];
  const uniqueTracked: EpisodeIdentityInput[] = [];

  const registerUnique = (input: EpisodeIdentityInput) => {
    if (!uniqueTracked.some((existing) => isSameUnifiedEpisode(existing, input))) {
      uniqueTracked.push(input);
    }
  };

  for (const item of history) {
    if (isSameHistoryAnime(item, target)) {
      matchedHistory.push(item);
      registerUnique(item);
    }
  }

  let progressCount = 0;
  if (progressMap) {
    const ids = collectHistoryAnimeIdentifiers(target, matchedHistory);
    for (const [key, entry] of Object.entries(progressMap)) {
      if (!entry) continue;
      if (doesProgressEntryMatchAnime(key, entry, ids)) {
        progressCount += 1;
        registerUnique(entry);
      }
    }
  }

  return {
    historyCount: matchedHistory.length,
    progressCount,
    totalCount: uniqueTracked.length,
  };
}

export function removeHistoryEpisodeFromList(
  history: WatchHistoryEntry[],
  targetUrl: string,
  targetMeta?: Omit<EpisodeIdentityInput, 'url'>
): {
  nextHistory: WatchHistoryEntry[];
  removedUrls: string[];
  removedEntries: WatchHistoryEntry[];
} {
  const targetInput: EpisodeIdentityInput = { url: targetUrl, ...targetMeta };
  const nextHistory: WatchHistoryEntry[] = [];
  const removedUrls: string[] = [];
  const removedEntries: WatchHistoryEntry[] = [];

  for (const item of history) {
    if (isSameUnifiedEpisode(item, targetInput)) {
      removedUrls.push(item.url);
      removedEntries.push(item);
    } else {
      nextHistory.push(item);
    }
  }

  return { nextHistory, removedUrls, removedEntries };
}

export function removeHistoryAnimeFromList(
  history: WatchHistoryEntry[],
  target: WatchHistoryEntry
): {
  nextHistory: WatchHistoryEntry[];
  removedUrls: string[];
  removedEntries: WatchHistoryEntry[];
} {
  const nextHistory: WatchHistoryEntry[] = [];
  const removedUrls: string[] = [];
  const removedEntries: WatchHistoryEntry[] = [];

  for (const item of history) {
    if (isSameHistoryAnime(item, target)) {
      removedUrls.push(item.url);
      removedEntries.push(item);
    } else {
      nextHistory.push(item);
    }
  }

  return { nextHistory, removedUrls, removedEntries };
}
