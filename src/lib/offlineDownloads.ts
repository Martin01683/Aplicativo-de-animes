import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { getStreamProxyUrlAsync, isNativeAndroidApp } from './apiClient.ts';
import { normalizeTopAnimesUrl } from './favoriteAlerts.ts';
import {
  fetchEpisodeDetailsFast,
  getCachedEmbed,
  resolveEmbedCachedGlobal,
} from './prefetchCache.ts';
import type { EpisodeSourceConfig } from './sources/types.ts';
import type {
  AnimeEpisodeLink,
  EpisodeDetails,
  PlayerOption,
  ResolvedEmbed,
  StreamFormat,
  StreamQuality,
  SubtitleTrack,
} from './types.ts';

export const OFFLINE_LOCAL_SERVER_NUME = 'offline-local';
const OFFLINE_INDEX_STORAGE_KEY = 'anisync:offline-downloads:v1';
const WEB_IDB_NAME = 'anisync_offline_videos_v1';
const WEB_IDB_STORE = 'blobs';
const WEB_IDB_VERSION = 1;

export type OfflineDownloadStatus = 'queued' | 'resolving' | 'downloading' | 'completed' | 'error';

export interface OfflineSubtitleFile {
  label: string;
  url: string;
  fileName?: string;
  isDefault: boolean;
}

export interface OfflineDownloadRecord {
  id: string;
  episodeUrl: string;
  canonicalUrl: string;
  title: string;
  seriesTitle: string;
  seriesUrl?: string;
  episodeLabel?: string;
  poster?: string;
  isMovie?: boolean;
  seasonNumber?: number;
  episodeNumber?: number;
  prevUrl?: string;
  nextUrl?: string;
  status: OfflineDownloadStatus;
  queuePosition?: number;
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
  sizeBytes: number;
  completedSegments?: number;
  totalSegments?: number;
  speedBytesPerSec?: number;
  engine?: string;
  format: StreamFormat;
  qualityLabel?: string;
  serverLabel?: string;
  storageKind: 'native' | 'web-idb';
  playbackUrl?: string;
  mediaFile?: string;
  subtitles: OfflineSubtitleFile[];
  savedAt: number;
  errorMessage?: string;
}

export interface OfflineDownloadInput {
  episodeUrl: string;
  title: string;
  seriesTitle?: string;
  seriesUrl?: string;
  episodeLabel?: string;
  poster?: string;
  isMovie?: boolean;
  seasonNumber?: number;
  episodeNumber?: number;
  prevUrl?: string;
  nextUrl?: string;
  resolvedEmbed?: ResolvedEmbed | null;
  serverLabel?: string;
  episodeOptions?: PlayerOption[];
  sources?: EpisodeSourceConfig[];
  audioPreference?: 'ALL' | 'DUB' | 'LEG';
}

interface NativeOfflineProgressEvent {
  id: string;
  episodeUrl?: string;
  status: 'downloading' | 'completed' | 'cancelled' | 'error';
  progress?: number;
  downloadedBytes?: number;
  totalBytes?: number;
  sizeBytes?: number;
  completedSegments?: number;
  totalSegments?: number;
  speedBytesPerSec?: number;
  engine?: string;
  playbackUrl?: string;
  format?: StreamFormat;
  mediaFile?: string;
  errorMessage?: string;
  record?: Partial<OfflineDownloadRecord>;
}

export interface DownloadEnginesInfo {
  aria2Available: boolean;
  aria2Version: string;
  ytdlpAvailable: boolean;
  ytdlpVersion: string;
  maxConnectionsPerServer: number;
  maxSplits: number;
  maxConcurrentSegments: number;
  aria2Repo: string;
  ytdlpRepo: string;
}

export interface YtDlpUpdateResponse {
  updated: boolean;
  previousVersion: string;
  currentVersion: string;
  message: string;
}

interface YtDlpEmbedResolveResponse {
  ok: boolean;
  streams?: StreamQuality[];
  subtitles?: SubtitleTrack[];
  referer?: string;
  title?: string;
  errorMessage?: string;
}

interface OfflineDownloadsNativePlugin {
  startDownload(options: {
    id: string;
    episodeUrl: string;
    canonicalUrl: string;
    streamUrl: string;
    format: StreamFormat;
    referer: string;
    title: string;
    seriesTitle: string;
    seriesUrl: string;
    episodeLabel: string;
    poster: string;
    qualityLabel: string;
    serverLabel: string;
    isMovie: boolean;
    seasonNumber?: number;
    episodeNumber?: number;
    prevUrl?: string;
    nextUrl?: string;
    subtitles: SubtitleTrack[];
  }): Promise<{ started: boolean; id: string }>;
  cancelDownload(options: { id: string }): Promise<{ cancelled: boolean }>;
  deleteDownload(options: { id: string }): Promise<{ deleted: boolean }>;
  deleteAllDownloads(): Promise<{ deleted: boolean }>;
  listDownloads(): Promise<{ downloads: Partial<OfflineDownloadRecord>[]; totalBytes: number }>;
  getPlaybackSource(options: {
    id?: string;
    episodeUrl?: string;
  }): Promise<{
    available: boolean;
    playbackUrl?: string;
    format?: StreamFormat;
    record?: Partial<OfflineDownloadRecord>;
  }>;
  getEngineInfo(): Promise<DownloadEnginesInfo>;
  updateYtDlp(): Promise<YtDlpUpdateResponse>;
  resolveEmbedWithYtDlp(options: {
    embedUrl: string;
    referer?: string;
  }): Promise<YtDlpEmbedResolveResponse>;
  addListener(
    eventName: 'offlineDownloadProgress',
    listenerFunc: (event: NativeOfflineProgressEvent) => void
  ): Promise<PluginListenerHandle>;
}

interface WebStoredVideoBlob {
  id: string;
  videoBlob: Blob;
  mimeType: string;
  subtitles: Array<{ label: string; isDefault: boolean; content: string }>;
}

const OfflineDownloadsNative =
  registerPlugin<OfflineDownloadsNativePlugin>('OfflineDownloads');

export function canonicalOfflineEpisodeUrl(rawUrl: string): string {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) return '';
  if (trimmed.toLowerCase().startsWith('anisync://')) {
    return trimmed.replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();
  }
  const normalized = normalizeTopAnimesUrl(trimmed);
  if (normalized) {
    return normalized.replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();
  }
  return trimmed.replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();
}

function fnv1a32(input: string, seed: number): string {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function buildOfflineDownloadId(episodeUrl: string): string {
  const canonical = canonicalOfflineEpisodeUrl(episodeUrl);
  const h1 = fnv1a32(canonical, 0x811c9dc5);
  const h2 = fnv1a32(`anisync:${canonical}`, 0x9e3779b1);
  return `dl_${h1}_${h2}`;
}

export function isLocalOfflinePlaybackUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  const lower = url.trim().toLowerCase();
  return (
    lower.startsWith('http://127.0.0.1:') ||
    lower.startsWith('http://localhost:') ||
    lower.startsWith('blob:') ||
    lower.startsWith('file://')
  );
}

function parseQualityHeight(label?: string): number {
  if (!label) return 0;
  const match = label.match(/(\d{3,4})p/i);
  if (match) {
    const parsed = Number.parseInt(match[1], 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  if (/full\s*hd|fhd/i.test(label)) return 1080;
  if (/\bhd\b/i.test(label)) return 720;
  return 0;
}

export function pickBestOfflineStream(
  streams: StreamQuality[],
  preferMp4 = false
): StreamQuality | null {
  if (!Array.isArray(streams) || streams.length === 0) return null;
  const valid = streams.filter((s) => Boolean(s?.url && /^https?:\/\//i.test(s.url)));
  if (!valid.length) return null;

  const isHls = (s: StreamQuality) =>
    s.format === 'hls' || /\.m3u8(?:$|\?)/i.test(s.url);
  const isMp4 = (s: StreamQuality) =>
    s.format === 'mp4' || (!isHls(s) && /\.mp4(?:$|\?)/i.test(s.url));

  const ranked = [...valid].sort((a, b) => {
    if (preferMp4) {
      const aMp4 = isMp4(a) ? 1 : isHls(a) ? -1 : 0;
      const bMp4 = isMp4(b) ? 1 : isHls(b) ? -1 : 0;
      if (bMp4 !== aMp4) return bMp4 - aMp4;
    }
    const aHeight = a.height || parseQualityHeight(a.label);
    const bHeight = b.height || parseQualityHeight(b.label);
    if (bHeight !== aHeight) return bHeight - aHeight;
    // At equal resolution, prefer MP4 over HLS for faster single-file download & instant seek
    const aType = isMp4(a) ? 2 : isHls(a) ? 1 : 0;
    const bType = isMp4(b) ? 2 : isHls(b) ? 1 : 0;
    return bType - aType;
  });

  return ranked[0] || null;
}

export function buildOfflinePlayerOption(record: OfflineDownloadRecord): PlayerOption {
  const qualityTag = record.qualityLabel ? ` (${record.qualityLabel})` : '';
  return {
    nume: OFFLINE_LOCAL_SERVER_NUME,
    label: `Salvo no celular${qualityTag}`,
    embedUrl: `offline://${record.id}`,
    providerKind: 'direct',
    sourceId: 'offline',
    sourceName: 'Armazenamento local',
    directStreamUrl: record.playbackUrl || '',
    directFormat: record.format || 'mp4',
    directReferer: '',
    directSubtitles: (record.subtitles || []).map((s) => ({
      label: s.label,
      url: s.url,
      isDefault: s.isDefault,
    })),
    qualityLabel: record.qualityLabel || 'Offline',
  };
}

export function buildOfflineResolvedEmbed(record: OfflineDownloadRecord): ResolvedEmbed {
  const qualityLabel = record.qualityLabel
    ? `${record.qualityLabel} · Offline`
    : 'Offline';
  const playbackUrl = record.playbackUrl || '';
  return {
    embedUrl: `offline://${record.id}`,
    provider: 'offline',
    status: playbackUrl ? 'resolved' : 'error',
    streams: playbackUrl
      ? [
          {
            label: qualityLabel,
            height: parseQualityHeight(record.qualityLabel) || 720,
            url: playbackUrl,
            format: record.format || 'mp4',
          },
        ]
      : [],
    subtitles: (record.subtitles || []).map((s) => ({
      label: s.label,
      url: s.url,
      isDefault: s.isDefault,
    })),
    poster: record.poster,
    referer: '',
    preferDirect: true,
    errorMessage: playbackUrl ? undefined : 'Arquivo offline indisponível no dispositivo.',
  };
}

export function buildOfflineEpisodeDetails(
  record: OfflineDownloadRecord,
  seriesEpisodes?: AnimeEpisodeLink[]
): EpisodeDetails {
  let prevUrl = record.prevUrl || undefined;
  let nextUrl = record.nextUrl || undefined;

  if ((!prevUrl || !nextUrl) && Array.isArray(seriesEpisodes) && seriesEpisodes.length > 0) {
    const targetKey = record.canonicalUrl || canonicalOfflineEpisodeUrl(record.episodeUrl);
    const idx = seriesEpisodes.findIndex(
      (ep) => canonicalOfflineEpisodeUrl(ep.url) === targetKey
    );
    if (idx >= 0) {
      if (!prevUrl && idx > 0) prevUrl = seriesEpisodes[idx - 1]?.url;
      if (!nextUrl && idx + 1 < seriesEpisodes.length) nextUrl = seriesEpisodes[idx + 1]?.url;
    }
  }

  return {
    title: record.title || 'Episódio salvo',
    seriesTitle: record.seriesTitle || record.title || 'Anime',
    seriesUrl: record.seriesUrl,
    url: record.episodeUrl,
    episodeLabel: record.episodeLabel,
    mediaType: record.isMovie ? 'movie' : 'anime',
    seasonNumber: record.seasonNumber,
    episodeNumber: record.episodeNumber,
    poster: record.poster || '',
    backdrop: record.poster || '',
    synopsis: '',
    genres: [],
    prevUrl,
    nextUrl,
    options: [buildOfflinePlayerOption(record)],
    isMovie: Boolean(record.isMovie),
    sourceMode: 'snapshot',
  };
}

export function computeTotalOfflineBytes(records: Iterable<OfflineDownloadRecord>): number {
  let sum = 0;
  for (const rec of records) {
    if (rec.status === 'completed' && Number.isFinite(rec.sizeBytes) && rec.sizeBytes > 0) {
      sum += rec.sizeBytes;
    }
  }
  return sum;
}

export function formatDownloadSpeed(bytesPerSec?: number): string {
  if (!bytesPerSec || !Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '';
  const mb = bytesPerSec / (1024 * 1024);
  if (mb >= 1) {
    return `${mb.toFixed(mb >= 10 ? 1 : 2)} MB/s`;
  }
  const kb = Math.max(1, Math.round(bytesPerSec / 1024));
  return `${kb} KB/s`;
}

export async function getDownloadEnginesInfo(): Promise<DownloadEnginesInfo | null> {
  if (isNativeAndroidApp()) {
    try {
      return await OfflineDownloadsNative.getEngineInfo();
    } catch {
      return null;
    }
  }
  try {
    const res = await fetch('/api/download-engines/status', {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    return (await res.json()) as DownloadEnginesInfo;
  } catch {
    return null;
  }
}

export async function updateYtDlpEngine(): Promise<YtDlpUpdateResponse> {
  if (!isNativeAndroidApp()) {
    return {
      updated: false,
      previousVersion: '',
      currentVersion: '',
      message: 'Atualização direta no app disponível no Android (no servidor web, use a versão mais recente do yt-dlp).',
    };
  }
  return await OfflineDownloadsNative.updateYtDlp();
}

export async function resolveEmbedFallbackWithYtDlp(
  embedUrl: string,
  referer = 'https://topanimes.net/'
): Promise<ResolvedEmbed | null> {
  if (!embedUrl || !/^https?:\/\//i.test(embedUrl)) return null;
  try {
    let data: YtDlpEmbedResolveResponse | null = null;
    if (isNativeAndroidApp()) {
      data = await OfflineDownloadsNative.resolveEmbedWithYtDlp({ embedUrl, referer });
    } else {
      const res = await fetch('/api/download-engines/resolve-embed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embedUrl, referer }),
        signal: AbortSignal.timeout(25_000),
      });
      if (res.ok) {
        data = (await res.json()) as YtDlpEmbedResolveResponse;
      }
    }
    if (!data?.ok || !Array.isArray(data.streams) || data.streams.length === 0) {
      return null;
    }
    return {
      embedUrl,
      provider: 'yt-dlp',
      status: 'resolved',
      streams: data.streams,
      subtitles: Array.isArray(data.subtitles) ? data.subtitles : [],
      referer: data.referer || referer,
      preferDirect: false,
    };
  } catch {
    return null;
  }
}

// ── Strict FIFO Serial Download Queue (1 active download at a time) ──────────

export interface SerialQueueEntry<T> {
  id: string;
  payload: T;
}

/**
 * Enforces strict single-concurrency FIFO execution even when dozens (e.g. 50+)
 * of downloads are enqueued simultaneously. Removing a queued item cancels it
 * without interrupting the active download; errors on one item never stall the rest.
 */
export class SerialDownloadQueue<T> {
  private readonly pending: SerialQueueEntry<T>[] = [];
  private activeId: string | null = null;
  private pumping = false;
  private readonly runner: (entry: SerialQueueEntry<T>) => Promise<void>;
  private readonly onQueueChange?: () => void;

  constructor(
    runner: (entry: SerialQueueEntry<T>) => Promise<void>,
    onQueueChange?: () => void
  ) {
    this.runner = runner;
    this.onQueueChange = onQueueChange;
  }

  enqueue(id: string, payload: T): { enqueued: boolean; position: number; alreadyActiveOrQueued: boolean } {
    if (this.activeId === id) {
      return { enqueued: false, position: 0, alreadyActiveOrQueued: true };
    }
    const existingIdx = this.pending.findIndex((item) => item.id === id);
    if (existingIdx >= 0) {
      return { enqueued: false, position: existingIdx + 1, alreadyActiveOrQueued: true };
    }
    this.pending.push({ id, payload });
    const position = this.pending.length;
    this.onQueueChange?.();
    void this.pump();
    return { enqueued: true, position, alreadyActiveOrQueued: false };
  }

  removePending(id: string): boolean {
    const idx = this.pending.findIndex((item) => item.id === id);
    if (idx < 0) return false;
    this.pending.splice(idx, 1);
    this.onQueueChange?.();
    return true;
  }

  clearPending(): string[] {
    if (this.pending.length === 0) return [];
    const removed = this.pending.map((item) => item.id);
    this.pending.length = 0;
    this.onQueueChange?.();
    return removed;
  }

  getActiveId(): string | null {
    return this.activeId;
  }

  getPendingIds(): string[] {
    return this.pending.map((item) => item.id);
  }

  getPosition(id: string): number | undefined {
    const idx = this.pending.findIndex((item) => item.id === id);
    return idx >= 0 ? idx + 1 : undefined;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.pending.length > 0) {
        const next = this.pending.shift()!;
        this.activeId = next.id;
        this.onQueueChange?.();
        try {
          await this.runner(next);
        } catch {
          // Individual item failure is handled by the runner; always continue FIFO queue.
        } finally {
          if (this.activeId === next.id) {
            this.activeId = null;
          }
          this.onQueueChange?.();
        }
      }
    } finally {
      this.pumping = false;
    }
  }
}

// ── Reactive store + Native / Web IndexedDB persistence ──────────────────────

type OfflineDownloadsListener = () => void;

const listeners = new Set<OfflineDownloadsListener>();
const recordsById = new Map<string, OfflineDownloadRecord>();
const webAbortControllers = new Map<string, AbortController>();
const webObjectUrls = new Map<string, string[]>();
const nativeCompletionResolvers = new Map<string, () => void>();
let cachedSnapshot: OfflineDownloadRecord[] = [];
let nativeListenerAttached = false;
let hydratedOnce = false;

function resolveNativeCompletionWaiter(id: string): void {
  const resolve = nativeCompletionResolvers.get(id);
  if (resolve) {
    nativeCompletionResolvers.delete(id);
    resolve();
  }
}

function syncQueuePositionsInRecords(): void {
  const pendingIds = offlineDownloadQueue.getPendingIds();
  const posById = new Map<string, number>();
  pendingIds.forEach((qid, idx) => posById.set(qid, idx + 1));

  for (const [id, rec] of recordsById.entries()) {
    const nextPos = rec.status === 'queued' ? posById.get(id) : undefined;
    if (rec.queuePosition !== nextPos) {
      recordsById.set(id, { ...rec, queuePosition: nextPos });
    }
  }
}

function statusSortRank(status: OfflineDownloadStatus): number {
  if (status === 'downloading' || status === 'resolving') return 0;
  if (status === 'queued') return 1;
  return 2;
}

function rebuildSnapshotAndNotify(): void {
  syncQueuePositionsInRecords();
  cachedSnapshot = Array.from(recordsById.values()).sort((a, b) => {
    const rankDiff = statusSortRank(a.status) - statusSortRank(b.status);
    if (rankDiff !== 0) return rankDiff;
    if (a.status === 'queued' && b.status === 'queued') {
      return (a.queuePosition ?? 999_999) - (b.queuePosition ?? 999_999);
    }
    return b.savedAt - a.savedAt;
  });
  persistIndexToLocalStorage();
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // ignore listener errors
    }
  }
}

function persistIndexToLocalStorage(): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const persistable = Array.from(recordsById.values())
      .filter((r) => r.status === 'completed')
      .map((r) => ({
        ...r,
        // Never persist ephemeral blob: URLs across reloads
        playbackUrl: r.storageKind === 'web-idb' ? undefined : r.playbackUrl,
        subtitles:
          r.storageKind === 'web-idb'
            ? r.subtitles.map((s) => ({ ...s, url: '' }))
            : r.subtitles,
      }));
    window.localStorage.setItem(OFFLINE_INDEX_STORAGE_KEY, JSON.stringify(persistable));
  } catch {
    // ignore quota errors
  }
}

function loadIndexFromLocalStorage(): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const raw = window.localStorage.getItem(OFFLINE_INDEX_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Partial<OfflineDownloadRecord>;
      if (!rec.id || !rec.episodeUrl || rec.status !== 'completed') continue;
      recordsById.set(rec.id, {
        id: rec.id,
        episodeUrl: rec.episodeUrl,
        canonicalUrl: rec.canonicalUrl || canonicalOfflineEpisodeUrl(rec.episodeUrl),
        title: rec.title || 'Episódio salvo',
        seriesTitle: rec.seriesTitle || '',
        seriesUrl: rec.seriesUrl,
        episodeLabel: rec.episodeLabel,
        poster: rec.poster,
        isMovie: Boolean(rec.isMovie),
        seasonNumber: rec.seasonNumber,
        episodeNumber: rec.episodeNumber,
        prevUrl: rec.prevUrl,
        nextUrl: rec.nextUrl,
        status: 'completed',
        progress: 100,
        downloadedBytes: rec.sizeBytes || 0,
        totalBytes: rec.sizeBytes || 0,
        sizeBytes: rec.sizeBytes || 0,
        format: rec.format || 'mp4',
        qualityLabel: rec.qualityLabel,
        serverLabel: rec.serverLabel,
        storageKind: rec.storageKind === 'native' ? 'native' : 'web-idb',
        playbackUrl: rec.storageKind === 'native' ? rec.playbackUrl : undefined,
        mediaFile: rec.mediaFile,
        subtitles: Array.isArray(rec.subtitles) ? rec.subtitles : [],
        savedAt: typeof rec.savedAt === 'number' ? rec.savedAt : Date.now(),
      });
    }
    cachedSnapshot = Array.from(recordsById.values()).sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    // ignore corrupt index
  }
}

loadIndexFromLocalStorage();

export function subscribeOfflineDownloads(listener: OfflineDownloadsListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getOfflineDownloadsSnapshot(): OfflineDownloadRecord[] {
  return cachedSnapshot;
}

export function getOfflineDownloadByUrl(episodeUrl: string): OfflineDownloadRecord | undefined {
  const key = canonicalOfflineEpisodeUrl(episodeUrl);
  if (!key) return undefined;
  const directId = buildOfflineDownloadId(episodeUrl);
  const direct = recordsById.get(directId);
  if (direct) return direct;
  for (const rec of recordsById.values()) {
    if (rec.canonicalUrl === key) return rec;
  }
  return undefined;
}

export function getCompletedOfflineDownload(episodeUrl: string): OfflineDownloadRecord | undefined {
  const hit = getOfflineDownloadByUrl(episodeUrl);
  return hit && hit.status === 'completed' ? hit : undefined;
}

// ── Web IndexedDB helpers ────────────────────────────────────────────────────

function openWebBlobDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('Armazenamento offline (IndexedDB) indisponível neste navegador.'));
      return;
    }
    const req = indexedDB.open(WEB_IDB_NAME, WEB_IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(WEB_IDB_STORE)) {
        db.createObjectStore(WEB_IDB_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Erro ao abrir banco offline.'));
  });
}

async function putWebVideoBlob(entry: WebStoredVideoBlob): Promise<void> {
  const db = await openWebBlobDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(WEB_IDB_STORE, 'readwrite');
    tx.objectStore(WEB_IDB_STORE).put(entry);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error('Erro ao gravar vídeo offline no navegador.'));
    };
  });
}

async function getWebVideoBlob(id: string): Promise<WebStoredVideoBlob | null> {
  const db = await openWebBlobDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(WEB_IDB_STORE, 'readonly');
    const req = tx.objectStore(WEB_IDB_STORE).get(id);
    req.onsuccess = () => {
      db.close();
      resolve((req.result as WebStoredVideoBlob | undefined) || null);
    };
    req.onerror = () => {
      db.close();
      reject(req.error || new Error('Erro ao ler vídeo offline.'));
    };
  });
}

async function deleteWebVideoBlob(id: string): Promise<void> {
  try {
    const db = await openWebBlobDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(WEB_IDB_STORE, 'readwrite');
      tx.objectStore(WEB_IDB_STORE).delete(id);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    });
  } catch {
    // ignore
  }
}

async function clearAllWebVideoBlobs(): Promise<void> {
  try {
    const db = await openWebBlobDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(WEB_IDB_STORE, 'readwrite');
      tx.objectStore(WEB_IDB_STORE).clear();
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    });
  } catch {
    // ignore
  }
}

function revokeWebObjectUrls(id: string): void {
  const urls = webObjectUrls.get(id);
  if (!urls) return;
  for (const url of urls) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  }
  webObjectUrls.delete(id);
}

function attachWebBlobUrls(
  id: string,
  stored: WebStoredVideoBlob
): { playbackUrl: string; subtitles: OfflineSubtitleFile[] } {
  revokeWebObjectUrls(id);
  const created: string[] = [];
  const playbackUrl = URL.createObjectURL(stored.videoBlob);
  created.push(playbackUrl);
  const subtitles: OfflineSubtitleFile[] = (stored.subtitles || []).map((s) => {
    const subBlob = new Blob([s.content], { type: 'text/vtt;charset=utf-8' });
    const subUrl = URL.createObjectURL(subBlob);
    created.push(subUrl);
    return {
      label: s.label,
      url: subUrl,
      isDefault: s.isDefault,
    };
  });
  webObjectUrls.set(id, created);
  return { playbackUrl, subtitles };
}

function normalizeNativeRecord(raw: Partial<OfflineDownloadRecord>): OfflineDownloadRecord | null {
  if (!raw?.id || !raw?.episodeUrl) return null;
  const sizeBytes = Number(raw.sizeBytes || 0);
  return {
    id: raw.id,
    episodeUrl: raw.episodeUrl,
    canonicalUrl: raw.canonicalUrl || canonicalOfflineEpisodeUrl(raw.episodeUrl),
    title: raw.title || 'Episódio salvo',
    seriesTitle: raw.seriesTitle || '',
    seriesUrl: raw.seriesUrl || undefined,
    episodeLabel: raw.episodeLabel || undefined,
    poster: raw.poster || undefined,
    isMovie: Boolean(raw.isMovie),
    seasonNumber: raw.seasonNumber && raw.seasonNumber > 0 ? raw.seasonNumber : undefined,
    episodeNumber: raw.episodeNumber && raw.episodeNumber > 0 ? raw.episodeNumber : undefined,
    prevUrl: raw.prevUrl || undefined,
    nextUrl: raw.nextUrl || undefined,
    status: 'completed',
    progress: 100,
    downloadedBytes: sizeBytes,
    totalBytes: sizeBytes,
    sizeBytes,
    format: (raw.format as StreamFormat) || 'mp4',
    qualityLabel: raw.qualityLabel || undefined,
    serverLabel: raw.serverLabel || undefined,
    storageKind: 'native',
    playbackUrl: raw.playbackUrl || undefined,
    mediaFile: raw.mediaFile || undefined,
    subtitles: Array.isArray(raw.subtitles) ? raw.subtitles : [],
    savedAt: typeof raw.savedAt === 'number' && raw.savedAt > 0 ? raw.savedAt : Date.now(),
  };
}

async function attachNativeProgressListenerOnce(): Promise<void> {
  if (nativeListenerAttached || !isNativeAndroidApp()) return;
  nativeListenerAttached = true;
  try {
    await OfflineDownloadsNative.addListener('offlineDownloadProgress', (event) => {
      if (!event?.id) return;
      const existing = recordsById.get(event.id);
      if (event.status === 'cancelled') {
        if (existing && existing.status !== 'completed') {
          recordsById.delete(event.id);
          rebuildSnapshotAndNotify();
        }
        resolveNativeCompletionWaiter(event.id);
        return;
      }
      if (event.status === 'error') {
        if (existing) {
          recordsById.set(event.id, {
            ...existing,
            status: 'error',
            queuePosition: undefined,
            progress: 0,
            errorMessage: event.errorMessage || 'Falha ao baixar episódio.',
          });
          rebuildSnapshotAndNotify();
        }
        resolveNativeCompletionWaiter(event.id);
        return;
      }
      if (event.status === 'completed') {
        const merged = event.record ? normalizeNativeRecord(event.record) : null;
        if (merged) {
          recordsById.set(merged.id, merged);
        } else if (existing) {
          const finalBytes = event.sizeBytes || existing.downloadedBytes;
          recordsById.set(existing.id, {
            ...existing,
            status: 'completed',
            queuePosition: undefined,
            progress: 100,
            downloadedBytes: finalBytes,
            totalBytes: finalBytes,
            sizeBytes: finalBytes,
            playbackUrl: event.playbackUrl || existing.playbackUrl,
            format: event.format || existing.format,
            mediaFile: event.mediaFile || existing.mediaFile,
            savedAt: Date.now(),
            errorMessage: undefined,
          });
        }
        rebuildSnapshotAndNotify();
        resolveNativeCompletionWaiter(event.id);
        return;
      }
      if (event.status === 'downloading' && existing) {
        recordsById.set(event.id, {
          ...existing,
          status: 'downloading',
          progress: typeof event.progress === 'number' ? event.progress : existing.progress,
          downloadedBytes:
            typeof event.downloadedBytes === 'number'
              ? event.downloadedBytes
              : existing.downloadedBytes,
          totalBytes:
            typeof event.totalBytes === 'number' ? event.totalBytes : existing.totalBytes,
          completedSegments: event.completedSegments,
          totalSegments: event.totalSegments,
          speedBytesPerSec:
            typeof event.speedBytesPerSec === 'number'
              ? event.speedBytesPerSec
              : existing.speedBytesPerSec,
          engine: event.engine || existing.engine,
          errorMessage: undefined,
        });
        rebuildSnapshotAndNotify();
      }
    });
  } catch {
    nativeListenerAttached = false;
  }
}

export async function hydrateOfflineDownloads(): Promise<OfflineDownloadRecord[]> {
  if (isNativeAndroidApp()) {
    await attachNativeProgressListenerOnce();
    try {
      const res = await OfflineDownloadsNative.listDownloads();
      const nativeIds = new Set<string>();
      for (const raw of res?.downloads || []) {
        const normalized = normalizeNativeRecord(raw);
        if (normalized) {
          nativeIds.add(normalized.id);
          recordsById.set(normalized.id, normalized);
        }
      }
      for (const [id, rec] of Array.from(recordsById.entries())) {
        if (rec.storageKind === 'native' && rec.status === 'completed' && !nativeIds.has(id)) {
          recordsById.delete(id);
        }
      }
      hydratedOnce = true;
      rebuildSnapshotAndNotify();
    } catch {
      // Keep localStorage cache on transient startup issue
    }
    return cachedSnapshot;
  }

  // Web/Desktop: verify IndexedDB entries still exist
  if (!hydratedOnce && typeof indexedDB !== 'undefined') {
    hydratedOnce = true;
    let changed = false;
    for (const [id, rec] of Array.from(recordsById.entries())) {
      if (rec.storageKind !== 'web-idb' || rec.status !== 'completed') continue;
      try {
        const stored = await getWebVideoBlob(id);
        if (!stored) {
          recordsById.delete(id);
          changed = true;
        }
      } catch {
        // ignore
      }
    }
    if (changed) {
      rebuildSnapshotAndNotify();
    }
  }
  return cachedSnapshot;
}

export async function ensureOfflinePlaybackSource(
  recordOrUrl: OfflineDownloadRecord | string
): Promise<OfflineDownloadRecord | null> {
  const record =
    typeof recordOrUrl === 'string'
      ? getCompletedOfflineDownload(recordOrUrl)
      : recordOrUrl;
  if (!record || record.status !== 'completed') return null;

  if (record.storageKind === 'native' && isNativeAndroidApp()) {
    try {
      const res = await OfflineDownloadsNative.getPlaybackSource({
        id: record.id,
        episodeUrl: record.episodeUrl,
      });
      if (!res?.available || !res.playbackUrl) {
        recordsById.delete(record.id);
        rebuildSnapshotAndNotify();
        return null;
      }
      const normalized = res.record ? normalizeNativeRecord(res.record) : null;
      const updated: OfflineDownloadRecord = normalized || {
        ...record,
        playbackUrl: res.playbackUrl,
        format: res.format || record.format,
      };
      recordsById.set(updated.id, updated);
      rebuildSnapshotAndNotify();
      return updated;
    } catch {
      return record.playbackUrl ? record : null;
    }
  }

  if (record.storageKind === 'web-idb') {
    if (record.playbackUrl && record.playbackUrl.startsWith('blob:')) {
      return record;
    }
    try {
      const stored = await getWebVideoBlob(record.id);
      if (!stored) {
        recordsById.delete(record.id);
        rebuildSnapshotAndNotify();
        return null;
      }
      const attached = attachWebBlobUrls(record.id, stored);
      const updated: OfflineDownloadRecord = {
        ...record,
        playbackUrl: attached.playbackUrl,
        subtitles: attached.subtitles,
      };
      recordsById.set(updated.id, updated);
      rebuildSnapshotAndNotify();
      return updated;
    } catch {
      return null;
    }
  }

  return record.playbackUrl ? record : null;
}

async function resolveStreamForDownload(
  input: OfflineDownloadInput,
  preferMp4: boolean
): Promise<{
  stream: StreamQuality;
  referer: string;
  subtitles: SubtitleTrack[];
  serverLabel: string;
  prevUrl?: string;
  nextUrl?: string;
  title?: string;
  seriesTitle?: string;
  seriesUrl?: string;
  poster?: string;
  seasonNumber?: number;
  episodeNumber?: number;
}> {
  if (
    input.resolvedEmbed &&
    input.resolvedEmbed.status === 'resolved' &&
    input.resolvedEmbed.streams.length > 0
  ) {
    const picked = pickBestOfflineStream(input.resolvedEmbed.streams, preferMp4);
    if (picked && (!preferMp4 || picked.format !== 'hls')) {
      return {
        stream: picked,
        referer: input.resolvedEmbed.referer || 'https://topanimes.net/',
        subtitles: input.resolvedEmbed.subtitles || [],
        serverLabel: input.serverLabel || input.resolvedEmbed.provider || 'Servidor atual',
      };
    }
  }

  let options: PlayerOption[] = (input.episodeOptions || []).filter(
    (o) => o.nume !== OFFLINE_LOCAL_SERVER_NUME
  );
  let resolvedDetails: EpisodeDetails | null = null;

  if (!options.length) {
    resolvedDetails = await fetchEpisodeDetailsFast(input.episodeUrl, {
      sources: input.sources,
      audioPreference: input.audioPreference,
    });
    options = (resolvedDetails.options || []).filter(
      (o) => o.nume !== OFFLINE_LOCAL_SERVER_NUME
    );
  }

  if (!options.length) {
    throw new Error('Nenhum servidor disponível para baixar este episódio.');
  }

  const prioritized = [...options].sort((a, b) => {
    const score = (o: PlayerOption) => {
      if (o.directStreamUrl) return 4;
      if (['hinatasoul', 'abyss', 'direct', 'playerjs'].includes(o.providerKind)) return 3;
      if (['kojima', 'zuplay', 'vidstreaming'].includes(o.providerKind)) return 2;
      return 1;
    };
    return score(b) - score(a);
  });

  let fallbackHlsCandidate: {
    stream: StreamQuality;
    referer: string;
    subtitles: SubtitleTrack[];
    serverLabel: string;
  } | null = null;

  for (const opt of prioritized.slice(0, 6)) {
    const cached = !opt.directStreamUrl ? getCachedEmbed(opt.embedUrl) : undefined;
    let embed =
      cached && cached.status === 'resolved' && cached.streams.length > 0
        ? cached
        : await resolveEmbedCachedGlobal(opt);

    if (
      (embed.status !== 'resolved' || !embed.streams.length) &&
      opt.embedUrl &&
      /^https?:\/\//i.test(opt.embedUrl)
    ) {
      const ytFallback = await resolveEmbedFallbackWithYtDlp(
        opt.embedUrl,
        opt.directReferer || 'https://topanimes.net/'
      );
      if (ytFallback && ytFallback.streams.length > 0) {
        embed = ytFallback;
      }
    }

    if (embed.status !== 'resolved' || !embed.streams.length) continue;
    const picked = pickBestOfflineStream(embed.streams, preferMp4);
    if (!picked) continue;

    const isHls = picked.format === 'hls' || /\.m3u8(?:$|\?)/i.test(picked.url);
    if (preferMp4 && isHls) {
      if (!fallbackHlsCandidate) {
        fallbackHlsCandidate = {
          stream: picked,
          referer: embed.referer || 'https://topanimes.net/',
          subtitles: embed.subtitles || [],
          serverLabel: opt.label || embed.provider,
        };
      }
      continue;
    }

    return {
      stream: picked,
      referer: embed.referer || 'https://topanimes.net/',
      subtitles: embed.subtitles || [],
      serverLabel: opt.label || embed.provider,
      prevUrl: resolvedDetails?.prevUrl,
      nextUrl: resolvedDetails?.nextUrl,
      title: resolvedDetails?.title,
      seriesTitle: resolvedDetails?.seriesTitle,
      seriesUrl: resolvedDetails?.seriesUrl,
      poster: resolvedDetails?.backdrop || resolvedDetails?.poster,
      seasonNumber: resolvedDetails?.seasonNumber,
      episodeNumber: resolvedDetails?.episodeNumber,
    };
  }

  if (fallbackHlsCandidate) {
    if (preferMp4) {
      throw new Error(
        'Este episódio só tem servidor HLS (.m3u8). O download de HLS funciona no aplicativo Android.'
      );
    }
    return {
      ...fallbackHlsCandidate,
      prevUrl: resolvedDetails?.prevUrl,
      nextUrl: resolvedDetails?.nextUrl,
      title: resolvedDetails?.title,
      seriesTitle: resolvedDetails?.seriesTitle,
      seriesUrl: resolvedDetails?.seriesUrl,
      poster: resolvedDetails?.backdrop || resolvedDetails?.poster,
      seasonNumber: resolvedDetails?.seasonNumber,
      episodeNumber: resolvedDetails?.episodeNumber,
    };
  }

  throw new Error('Não foi possível encontrar um link de vídeo válido para download.');
}

async function runWebOfflineDownload(
  record: OfflineDownloadRecord,
  stream: StreamQuality,
  referer: string,
  subtitles: SubtitleTrack[]
): Promise<OfflineDownloadRecord> {
  const controller = new AbortController();
  webAbortControllers.set(record.id, controller);

  try {
    const fastUrl = `/api/download-engines/fast-download?url=${encodeURIComponent(
      stream.url
    )}&referer=${encodeURIComponent(referer || 'https://topanimes.net/')}`;
    let res: Response | null = null;
    try {
      const fastRes = await fetch(fastUrl, { signal: controller.signal });
      if (fastRes.ok) {
        res = fastRes;
      }
    } catch (err) {
      if (controller.signal.aborted) throw err;
    }

    if (!res) {
      const fetchUrl = await getStreamProxyUrlAsync(stream.url, referer);
      res = await fetch(fetchUrl, { signal: controller.signal });
    }
    if (!res.ok) {
      throw new Error(`Servidor retornou HTTP ${res.status} ao baixar vídeo.`);
    }
    const contentLengthHeader = res.headers.get('content-length');
    const totalBytes = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) || 0 : 0;
    const contentType = res.headers.get('content-type') || 'video/mp4';
    const engineHeader = res.headers.get('x-anisync-download-engine') || undefined;

    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let downloadedBytes = 0;
    let lastEmit = 0;
    let lastSpeedTime = Date.now();
    let lastSpeedBytes = 0;
    let smoothedSpeed = 0;

    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          const copy = new Uint8Array(new ArrayBuffer(value.byteLength));
          copy.set(value);
          chunks.push(copy);
          downloadedBytes += value.byteLength;
          const now = Date.now();
          if (now - lastEmit >= 250) {
            const elapsedMs = Math.max(1, now - lastSpeedTime);
            const instantSpeed = ((downloadedBytes - lastSpeedBytes) * 1000) / elapsedMs;
            smoothedSpeed = smoothedSpeed > 0 ? (smoothedSpeed * 2 + instantSpeed) / 3 : instantSpeed;
            lastSpeedTime = now;
            lastSpeedBytes = downloadedBytes;
            lastEmit = now;
            const pct =
              totalBytes > 0 ? Math.min(99, Math.round((downloadedBytes / totalBytes) * 99)) : 0;
            recordsById.set(record.id, {
              ...record,
              status: 'downloading',
              progress: pct,
              downloadedBytes,
              totalBytes,
              speedBytesPerSec: Math.round(smoothedSpeed),
              engine: engineHeader,
            });
            rebuildSnapshotAndNotify();
          }
        }
      }
    } else {
      const buf = await res.arrayBuffer();
      chunks.push(new Uint8Array(buf));
      downloadedBytes = buf.byteLength;
    }

    if (downloadedBytes <= 0) {
      throw new Error('Arquivo de vídeo vazio recebido do servidor.');
    }

    const videoBlob = new Blob(chunks, {
      type: contentType.includes('video/') ? contentType : 'video/mp4',
    });

    const savedSubs: Array<{ label: string; isDefault: boolean; content: string }> = [];
    for (const sub of subtitles) {
      if (controller.signal.aborted) break;
      try {
        const subFetchUrl = await getStreamProxyUrlAsync(sub.url, referer);
        const subRes = await fetch(subFetchUrl, { signal: controller.signal });
        if (subRes.ok) {
          const content = await subRes.text();
          if (content.trim()) {
            savedSubs.push({
              label: sub.label,
              isDefault: sub.isDefault,
              content,
            });
          }
        }
      } catch {
        // Subtitles are best-effort
      }
    }

    const stored: WebStoredVideoBlob = {
      id: record.id,
      videoBlob,
      mimeType: videoBlob.type,
      subtitles: savedSubs,
    };
    await putWebVideoBlob(stored);

    const attached = attachWebBlobUrls(record.id, stored);
    const completed: OfflineDownloadRecord = {
      ...record,
      status: 'completed',
      progress: 100,
      downloadedBytes: videoBlob.size,
      totalBytes: videoBlob.size,
      sizeBytes: videoBlob.size,
      format: 'mp4',
      playbackUrl: attached.playbackUrl,
      subtitles: attached.subtitles,
      savedAt: Date.now(),
      errorMessage: undefined,
    };
    recordsById.set(completed.id, completed);
    rebuildSnapshotAndNotify();
    return completed;
  } finally {
    webAbortControllers.delete(record.id);
  }
}

async function executeQueuedOfflineDownload(
  id: string,
  input: OfflineDownloadInput
): Promise<void> {
  const existing = recordsById.get(id);
  if (!existing || existing.status === 'completed') {
    return;
  }

  const native = isNativeAndroidApp();
  if (native) {
    await attachNativeProgressListenerOnce();
  }

  const resolvingRec: OfflineDownloadRecord = {
    ...existing,
    status: 'resolving',
    queuePosition: undefined,
    progress: 0,
    errorMessage: undefined,
  };
  recordsById.set(id, resolvingRec);
  rebuildSnapshotAndNotify();

  try {
    // Resolve the stream URL JUST IN TIME right when this episode reaches the head
    // of the FIFO queue, preventing token/URL expiration even for episode #50!
    const resolved = await resolveStreamForDownload(input, !native);
    const currentAfterResolve = recordsById.get(id);
    if (!currentAfterResolve || currentAfterResolve.status !== 'resolving') {
      // Cancelled while resolving
      return;
    }

    const updated: OfflineDownloadRecord = {
      ...currentAfterResolve,
      title: input.title || resolved.title || currentAfterResolve.title,
      seriesTitle: input.seriesTitle || resolved.seriesTitle || currentAfterResolve.seriesTitle,
      seriesUrl: input.seriesUrl || resolved.seriesUrl || currentAfterResolve.seriesUrl,
      poster: input.poster || resolved.poster || currentAfterResolve.poster,
      prevUrl: input.prevUrl || resolved.prevUrl || currentAfterResolve.prevUrl,
      nextUrl: input.nextUrl || resolved.nextUrl || currentAfterResolve.nextUrl,
      seasonNumber: input.seasonNumber ?? resolved.seasonNumber ?? currentAfterResolve.seasonNumber,
      episodeNumber:
        input.episodeNumber ?? resolved.episodeNumber ?? currentAfterResolve.episodeNumber,
      status: 'downloading',
      queuePosition: undefined,
      format: resolved.stream.format,
      qualityLabel: resolved.stream.label,
      serverLabel: resolved.serverLabel,
    };
    recordsById.set(id, updated);
    rebuildSnapshotAndNotify();

    if (native) {
      // Wait for native Android completion/error/cancel event before releasing the FIFO queue lock.
      const nativeDone = new Promise<void>((resolve) => {
        nativeCompletionResolvers.set(id, resolve);
      });
      try {
        await OfflineDownloadsNative.startDownload({
          id,
          episodeUrl: updated.episodeUrl,
          canonicalUrl: updated.canonicalUrl,
          streamUrl: resolved.stream.url,
          format: resolved.stream.format,
          referer: resolved.referer,
          title: updated.title,
          seriesTitle: updated.seriesTitle,
          seriesUrl: updated.seriesUrl || '',
          episodeLabel: updated.episodeLabel || '',
          poster: updated.poster || '',
          qualityLabel: updated.qualityLabel || '',
          serverLabel: updated.serverLabel || '',
          isMovie: Boolean(updated.isMovie),
          seasonNumber: updated.seasonNumber,
          episodeNumber: updated.episodeNumber,
          prevUrl: updated.prevUrl,
          nextUrl: updated.nextUrl,
          subtitles: resolved.subtitles,
        });
      } catch (startErr) {
        resolveNativeCompletionWaiter(id);
        throw startErr;
      }
      await nativeDone;
      return;
    }

    await runWebOfflineDownload(updated, resolved.stream, resolved.referer, resolved.subtitles);
  } catch (err) {
    resolveNativeCompletionWaiter(id);
    const isAbort =
      err instanceof Error &&
      (err.name === 'AbortError' || /cancelado|aborted/i.test(err.message));
    if (isAbort) {
      recordsById.delete(id);
      rebuildSnapshotAndNotify();
      return;
    }
    const message =
      err instanceof Error && err.message
        ? err.message
        : 'Não foi possível baixar este episódio.';
    const failed: OfflineDownloadRecord = {
      ...(recordsById.get(id) || resolvingRec),
      status: 'error',
      queuePosition: undefined,
      progress: 0,
      errorMessage: message,
    };
    recordsById.set(id, failed);
    rebuildSnapshotAndNotify();
  }
}

const offlineDownloadQueue = new SerialDownloadQueue<OfflineDownloadInput>(
  async (entry) => {
    await executeQueuedOfflineDownload(entry.id, entry.payload);
  },
  () => {
    rebuildSnapshotAndNotify();
  }
);

export function getOfflineDownloadQueueLength(): number {
  return offlineDownloadQueue.getPendingIds().length;
}

export async function startEpisodeOfflineDownload(
  input: OfflineDownloadInput
): Promise<OfflineDownloadRecord> {
  const canonicalUrl = canonicalOfflineEpisodeUrl(input.episodeUrl);
  const id = buildOfflineDownloadId(input.episodeUrl);
  const existing = recordsById.get(id);
  if (
    existing &&
    (existing.status === 'queued' ||
      existing.status === 'resolving' ||
      existing.status === 'downloading')
  ) {
    return existing;
  }

  const native = isNativeAndroidApp();
  if (native) {
    await attachNativeProgressListenerOnce();
  }

  const hasActiveOrPending =
    offlineDownloadQueue.getActiveId() !== null ||
    offlineDownloadQueue.getPendingIds().length > 0;

  const initial: OfflineDownloadRecord = {
    id,
    episodeUrl: input.episodeUrl,
    canonicalUrl,
    title: input.title || 'Episódio',
    seriesTitle: input.seriesTitle || '',
    seriesUrl: input.seriesUrl,
    episodeLabel: input.episodeLabel,
    poster: input.poster,
    isMovie: input.isMovie,
    seasonNumber: input.seasonNumber,
    episodeNumber: input.episodeNumber,
    prevUrl: input.prevUrl,
    nextUrl: input.nextUrl,
    status: 'queued',
    queuePosition: hasActiveOrPending ? offlineDownloadQueue.getPendingIds().length + 1 : undefined,
    progress: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    sizeBytes: 0,
    format: 'unknown',
    serverLabel: input.serverLabel,
    storageKind: native ? 'native' : 'web-idb',
    subtitles: [],
    savedAt: Date.now(),
  };

  recordsById.set(id, initial);
  offlineDownloadQueue.enqueue(id, input);
  return recordsById.get(id) || initial;
}

export function clearOfflineDownloadQueue(): number {
  const removedIds = offlineDownloadQueue.clearPending();
  for (const id of removedIds) {
    const rec = recordsById.get(id);
    if (rec && rec.status === 'queued') {
      recordsById.delete(id);
    }
  }
  if (removedIds.length > 0) {
    rebuildSnapshotAndNotify();
  }
  return removedIds.length;
}

export async function cancelEpisodeOfflineDownload(idOrEpisodeUrl: string): Promise<void> {
  const rec = recordsById.get(idOrEpisodeUrl) || getOfflineDownloadByUrl(idOrEpisodeUrl);
  const id = rec?.id || buildOfflineDownloadId(idOrEpisodeUrl);

  // If this episode is only waiting in the FIFO queue, remove it without disturbing the active download.
  if (offlineDownloadQueue.removePending(id)) {
    const current = recordsById.get(id);
    if (current && current.status !== 'completed') {
      recordsById.delete(id);
      rebuildSnapshotAndNotify();
    }
    return;
  }

  const webCtrl = webAbortControllers.get(id);
  if (webCtrl) {
    webCtrl.abort();
    webAbortControllers.delete(id);
  }
  if (isNativeAndroidApp()) {
    try {
      await OfflineDownloadsNative.cancelDownload({ id });
    } catch {
      // ignore
    }
  }
  recordsById.delete(id);
  rebuildSnapshotAndNotify();
  resolveNativeCompletionWaiter(id);
}

export async function deleteEpisodeOfflineDownload(idOrEpisodeUrl: string): Promise<void> {
  const rec = recordsById.get(idOrEpisodeUrl) || getOfflineDownloadByUrl(idOrEpisodeUrl);
  const id = rec?.id || buildOfflineDownloadId(idOrEpisodeUrl);

  offlineDownloadQueue.removePending(id);

  const webCtrl = webAbortControllers.get(id);
  if (webCtrl) {
    webCtrl.abort();
    webAbortControllers.delete(id);
  }
  revokeWebObjectUrls(id);

  if (isNativeAndroidApp()) {
    try {
      await OfflineDownloadsNative.deleteDownload({ id });
    } catch {
      // ignore
    }
  } else {
    await deleteWebVideoBlob(id);
  }

  recordsById.delete(id);
  rebuildSnapshotAndNotify();
  resolveNativeCompletionWaiter(id);
}

export async function deleteAllOfflineDownloads(): Promise<void> {
  offlineDownloadQueue.clearPending();
  for (const ctrl of webAbortControllers.values()) {
    ctrl.abort();
  }
  webAbortControllers.clear();
  for (const id of Array.from(webObjectUrls.keys())) {
    revokeWebObjectUrls(id);
  }
  for (const id of Array.from(nativeCompletionResolvers.keys())) {
    resolveNativeCompletionWaiter(id);
  }
  if (isNativeAndroidApp()) {
    try {
      await OfflineDownloadsNative.deleteAllDownloads();
    } catch {
      // ignore
    }
  } else {
    await clearAllWebVideoBlobs();
  }
  recordsById.clear();
  rebuildSnapshotAndNotify();
}
