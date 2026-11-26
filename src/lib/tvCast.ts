import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { StreamQuality, SubtitleTrack } from './types';

export type TvCastProtocolKind = 'chromecast' | 'dlna' | 'lan';
export type TvCastDeliveryPreference = 'auto' | 'proxy' | 'direct';
export type TvCastDeliveryMode = '' | 'direct' | 'background-proxy' | 'lan-link';
export type TvCastStatus =
  | 'idle'
  | 'connecting'
  | 'buffering'
  | 'playing'
  | 'paused'
  | 'stopped'
  | 'error';

export interface TvCastDevice {
  id: string;
  name: string;
  manufacturer?: string;
  model?: string;
  host: string;
  port: number;
  protocol: TvCastProtocolKind;
  avTransportControlUrl?: string;
  renderingControlUrl?: string;
  locationUrl?: string;
}

export interface TvCastMediaPayload {
  streamUrl: string;
  streamFormat: 'hls' | 'mp4' | 'unknown';
  referer: string;
  preferDirect?: boolean;
  episodeUrl?: string;
  title: string;
  seriesTitle?: string;
  seriesUrl?: string;
  poster?: string;
  isMovie?: boolean;
  subtitleUrl?: string;
  subtitleLabel?: string;
  selectedServerNume?: string;
  prevUrl?: string;
  nextUrl?: string;
  autoPlayNextEpisode?: boolean;
  startPositionMs?: number;
  durationMs?: number;
}

export interface TvCastStateSnapshot {
  active: boolean;
  status: TvCastStatus;
  deviceId: string;
  deviceName: string;
  deviceProtocol: TvCastProtocolKind | '';
  deliveryMode: TvCastDeliveryMode;
  episodeUrl: string;
  episodeTitle: string;
  seriesTitle: string;
  seriesUrl: string;
  poster: string;
  streamUrl: string;
  lanStreamUrl: string;
  positionMs: number;
  durationMs: number;
  volume: number;
  muted: boolean;
  hasPrev: boolean;
  hasNext: boolean;
  errorMessage: string;
}

export interface PrepareExternalCastResult {
  streamUrl: string;
  lanStreamUrl: string;
  directUrl: string;
  opened: boolean;
}

interface TvCastNativePlugin {
  discoverDevices(options?: { timeoutMs?: number }): Promise<{ devices: TvCastDevice[] }>;
  stopDiscovery(): Promise<void>;
  addManualDevice(options: {
    host: string;
    port?: number;
    name?: string;
    protocol?: 'chromecast' | 'dlna';
    avTransportControlUrl?: string;
  }): Promise<{ device: TvCastDevice }>;
  startCast(options: {
    device: TvCastDevice;
    media: TvCastMediaPayload;
    deliveryMode?: TvCastDeliveryPreference;
  }): Promise<{ started: boolean }>;
  prepareExternalCast(options: {
    media: TvCastMediaPayload;
    openExternalApp?: boolean;
  }): Promise<PrepareExternalCastResult>;
  play(): Promise<void>;
  pause(): Promise<void>;
  togglePlayPause(): Promise<void>;
  seek(options: { positionMs: number }): Promise<void>;
  seekBy(options: { deltaMs: number }): Promise<void>;
  setVolume(options: { volume: number }): Promise<void>;
  nextEpisode(): Promise<void>;
  prevEpisode(): Promise<void>;
  stopCast(): Promise<void>;
  getCastState(): Promise<TvCastStateSnapshot>;
  addListener(
    eventName: 'castDevicesUpdated',
    listenerFunc: (event: { devices: TvCastDevice[]; scanning: boolean }) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'castStateChanged',
    listenerFunc: (state: TvCastStateSnapshot) => void
  ): Promise<PluginListenerHandle>;
}

const TvCastNative = registerPlugin<TvCastNativePlugin>('TvCast');

export const IDLE_TV_CAST_STATE: TvCastStateSnapshot = {
  active: false,
  status: 'idle',
  deviceId: '',
  deviceName: '',
  deviceProtocol: '',
  deliveryMode: '',
  episodeUrl: '',
  episodeTitle: '',
  seriesTitle: '',
  seriesUrl: '',
  poster: '',
  streamUrl: '',
  lanStreamUrl: '',
  positionMs: 0,
  durationMs: 0,
  volume: 1,
  muted: false,
  hasPrev: false,
  hasNext: false,
  errorMessage: '',
};

export function isNativeAndroidCastSupported(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
  } catch {
    return false;
  }
}

export function dedupeCastDevices(devices: readonly TvCastDevice[]): TvCastDevice[] {
  const byKey = new Map<string, TvCastDevice>();
  for (const dev of devices) {
    if (!dev || !dev.host) continue;
    const key = dev.id || `${dev.protocol}:${dev.host}:${dev.port}`;
    byKey.set(key, dev);
  }
  return Array.from(byKey.values()).sort((a, b) => {
    if (a.protocol !== b.protocol) {
      return a.protocol === 'chromecast' ? -1 : 1;
    }
    return a.name.localeCompare(b.name, 'pt-BR');
  });
}

export function formatCastDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatCastProtocolLabel(protocol: TvCastProtocolKind | ''): string {
  if (protocol === 'chromecast') return 'Chromecast / Android TV';
  if (protocol === 'dlna') return 'Smart TV (DLNA)';
  if (protocol === 'lan') return 'Link Wi-Fi (2º plano)';
  return 'TV';
}

export function formatCastStatusLabel(status: TvCastStatus): string {
  switch (status) {
    case 'connecting':
      return 'Conectando à TV...';
    case 'buffering':
      return 'Carregando na TV...';
    case 'playing':
      return 'Reproduzindo na TV';
    case 'paused':
      return 'Pausado na TV';
    case 'stopped':
      return 'Transmissão finalizada';
    case 'error':
      return 'Erro na transmissão';
    default:
      return 'Inativo';
  }
}

export function formatCastDeliveryLabel(mode: TvCastDeliveryMode): string {
  if (mode === 'direct') return 'Direto na TV · independente do app';
  if (mode === 'lan-link') return 'Servidor Wi-Fi ativo em 2º plano';
  if (mode === 'background-proxy') return 'Segundo plano ativo · pode sair do app';
  return '';
}

export function buildCastMediaPayload(params: {
  stream: StreamQuality;
  subtitles?: readonly SubtitleTrack[];
  activeSubtitleUrl?: string;
  referer?: string;
  preferDirect?: boolean;
  episodeUrl?: string;
  title: string;
  seriesTitle?: string;
  seriesUrl?: string;
  poster?: string;
  isMovie?: boolean;
  selectedServerNume?: string;
  prevUrl?: string;
  nextUrl?: string;
  autoPlayNextEpisode?: boolean;
  startPositionMs?: number;
  durationMs?: number;
}): TvCastMediaPayload {
  const subs = params.subtitles || [];
  let chosenSub: SubtitleTrack | undefined;
  if (params.activeSubtitleUrl) {
    chosenSub = subs.find((s) => s.url === params.activeSubtitleUrl);
  }
  if (!chosenSub && subs.length > 0) {
    chosenSub = subs.find((s) => s.isDefault) || subs[0];
  }

  return {
    streamUrl: params.stream.url,
    streamFormat: params.stream.format || (/\.m3u8(?:$|\?)/i.test(params.stream.url) ? 'hls' : 'mp4'),
    referer: params.referer || 'https://topanimes.net/',
    preferDirect: Boolean(params.preferDirect),
    episodeUrl: params.episodeUrl || '',
    title: params.title || 'Episódio',
    seriesTitle: params.seriesTitle || '',
    seriesUrl: params.seriesUrl || '',
    poster: params.poster || '',
    isMovie: Boolean(params.isMovie),
    subtitleUrl: chosenSub?.url || '',
    subtitleLabel: chosenSub?.label || '',
    selectedServerNume: params.selectedServerNume || '',
    prevUrl: params.prevUrl || '',
    nextUrl: params.nextUrl || '',
    autoPlayNextEpisode: Boolean(params.autoPlayNextEpisode),
    startPositionMs: Math.max(0, Math.round(params.startPositionMs || 0)),
    durationMs: Math.max(0, Math.round(params.durationMs || 0)),
  };
}

export function sanitizeCastStateSnapshot(raw: Partial<TvCastStateSnapshot> | null | undefined): TvCastStateSnapshot {
  if (!raw || typeof raw !== 'object') return { ...IDLE_TV_CAST_STATE };
  return {
    active: Boolean(raw.active),
    status: raw.status || 'idle',
    deviceId: raw.deviceId || '',
    deviceName: raw.deviceName || '',
    deviceProtocol: raw.deviceProtocol || '',
    deliveryMode: raw.deliveryMode || '',
    episodeUrl: raw.episodeUrl || '',
    episodeTitle: raw.episodeTitle || '',
    seriesTitle: raw.seriesTitle || '',
    seriesUrl: raw.seriesUrl || '',
    poster: raw.poster || '',
    streamUrl: raw.streamUrl || '',
    lanStreamUrl: raw.lanStreamUrl || '',
    positionMs: Math.max(0, Number(raw.positionMs) || 0),
    durationMs: Math.max(0, Number(raw.durationMs) || 0),
    volume: typeof raw.volume === 'number' && Number.isFinite(raw.volume) ? Math.max(0, Math.min(1, raw.volume)) : 1,
    muted: Boolean(raw.muted),
    hasPrev: Boolean(raw.hasPrev),
    hasNext: Boolean(raw.hasNext),
    errorMessage: raw.errorMessage || '',
  };
}

export interface TvCastDiscoveryResult {
  devices: TvCastDevice[];
  supported: boolean;
  error?: string;
}

const webCastStateListeners = new Set<(state: TvCastStateSnapshot) => void>();
let webLatestCastState: TvCastStateSnapshot = { ...IDLE_TV_CAST_STATE };
let webStatePollTimer: ReturnType<typeof setInterval> | null = null;
let webStatePollInFlight = false;

async function fetchTvCastJson<T>(
  url: string,
  init?: RequestInit
): Promise<{ ok: boolean; status: number; data: T | null }> {
  if (typeof fetch !== 'function') {
    return { ok: false, status: 0, data: null };
  }
  try {
    const res = await fetch(url, init);
    const contentType = res.headers.get('content-type') || '';
    if (!/application\/json/i.test(contentType)) {
      return { ok: false, status: res.status, data: null };
    }
    const data = (await res.json()) as T;
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

function stopWebCastPolling(): void {
  if (webStatePollTimer !== null) {
    clearInterval(webStatePollTimer);
    webStatePollTimer = null;
  }
}

function syncWebCastPolling(): void {
  if (
    isNativeAndroidCastSupported() ||
    typeof window === 'undefined' ||
    !webLatestCastState.active ||
    webCastStateListeners.size === 0
  ) {
    stopWebCastPolling();
    return;
  }
  if (webStatePollTimer !== null) return;
  webStatePollTimer = setInterval(() => {
    if (webStatePollInFlight || !webLatestCastState.active) return;
    webStatePollInFlight = true;
    void fetchTvCastJson<{ supported?: boolean; state?: Partial<TvCastStateSnapshot> }>(
      '/api/tv-cast/state'
    )
      .then((res) => {
        if (res.ok && res.data?.supported && res.data.state) {
          notifyWebCastState(res.data.state);
        }
      })
      .finally(() => {
        webStatePollInFlight = false;
      });
  }, 2000);
}

function notifyWebCastState(raw: Partial<TvCastStateSnapshot> | null | undefined): TvCastStateSnapshot {
  const sanitized = sanitizeCastStateSnapshot(raw);
  webLatestCastState = sanitized;
  for (const listener of webCastStateListeners) {
    try {
      listener(sanitized);
    } catch {
      // ignore subscriber errors
    }
  }
  syncWebCastPolling();
  return sanitized;
}

export async function discoverTvCastDevicesDetailed(
  timeoutMs = 5500
): Promise<TvCastDiscoveryResult> {
  if (isNativeAndroidCastSupported()) {
    const res = await TvCastNative.discoverDevices({ timeoutMs });
    return {
      devices: dedupeCastDevices(res?.devices || []),
      supported: true,
    };
  }

  const clamped = Math.max(1500, Math.min(10_000, Math.round(timeoutMs)));
  const res = await fetchTvCastJson<{
    supported?: boolean;
    devices?: TvCastDevice[];
    error?: string;
  }>(`/api/tv-cast/discover?timeoutMs=${clamped}`);

  if (!res.data || res.data.supported !== true) {
    return { devices: [], supported: false };
  }

  return {
    devices: dedupeCastDevices(res.data.devices || []),
    supported: true,
    error: res.data.error,
  };
}

export async function discoverTvCastDevices(timeoutMs = 5500): Promise<TvCastDevice[]> {
  const res = await discoverTvCastDevicesDetailed(timeoutMs);
  return res.devices;
}

export async function stopTvCastDiscovery(): Promise<void> {
  if (!isNativeAndroidCastSupported()) return;
  try {
    await TvCastNative.stopDiscovery();
  } catch {
    // ignore
  }
}

export async function addManualTvCastDevice(options: {
  host: string;
  port?: number;
  name?: string;
  protocol?: 'chromecast' | 'dlna';
  avTransportControlUrl?: string;
}): Promise<TvCastDevice> {
  if (isNativeAndroidCastSupported()) {
    const res = await TvCastNative.addManualDevice(options);
    return res.device;
  }

  const cleanHost = (options.host || '').trim();
  if (!cleanHost || /\s/.test(cleanHost)) {
    throw new Error('Informe um endereço IP válido da TV na rede Wi-Fi (ex.: 192.168.1.50).');
  }
  const protocol = options.protocol === 'dlna' ? 'dlna' : 'chromecast';
  const defaultPort = protocol === 'dlna' ? 80 : 8009;
  const port =
    typeof options.port === 'number' && Number.isFinite(options.port) && options.port > 0
      ? Math.round(options.port)
      : defaultPort;

  return {
    id: `${protocol === 'dlna' ? 'dlna' : 'cast'}:manual:${cleanHost}:${port}`,
    name: options.name?.trim() || `TV (${cleanHost})`,
    manufacturer: protocol === 'dlna' ? 'Smart TV' : 'Google Cast',
    model: 'Manual',
    host: cleanHost,
    port,
    protocol,
    avTransportControlUrl: options.avTransportControlUrl || '',
    renderingControlUrl: '',
    locationUrl: '',
  };
}

export async function startNativeTvCast(
  device: TvCastDevice,
  media: TvCastMediaPayload,
  deliveryMode: TvCastDeliveryPreference = 'auto'
): Promise<boolean> {
  if (isNativeAndroidCastSupported()) {
    const res = await TvCastNative.startCast({ device, media, deliveryMode });
    return Boolean(res?.started);
  }

  const res = await fetchTvCastJson<{
    started?: boolean;
    state?: Partial<TvCastStateSnapshot>;
    error?: string;
  }>('/api/tv-cast/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device, media, deliveryMode }),
  });

  if (!res.ok || !res.data?.started) {
    throw new Error(res.data?.error || 'Não foi possível iniciar a transmissão na TV.');
  }

  if (res.data.state) {
    notifyWebCastState(res.data.state);
  }
  return true;
}

export const startTvCast = startNativeTvCast;

export async function prepareExternalTvCast(
  media: TvCastMediaPayload,
  openExternalApp: boolean
): Promise<PrepareExternalCastResult | null> {
  if (isNativeAndroidCastSupported()) {
    return TvCastNative.prepareExternalCast({ media, openExternalApp });
  }

  const res = await fetchTvCastJson<PrepareExternalCastResult>('/api/tv-cast/prepare-link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ media }),
  });

  if (!res.ok || !res.data) return null;
  void getNativeTvCastState();
  return res.data;
}

export async function getNativeTvCastState(): Promise<TvCastStateSnapshot> {
  if (isNativeAndroidCastSupported()) {
    try {
      const raw = await TvCastNative.getCastState();
      return sanitizeCastStateSnapshot(raw);
    } catch {
      return { ...IDLE_TV_CAST_STATE };
    }
  }

  const res = await fetchTvCastJson<{
    supported?: boolean;
    state?: Partial<TvCastStateSnapshot>;
  }>('/api/tv-cast/state');

  if (res.ok && res.data?.supported && res.data.state) {
    return notifyWebCastState(res.data.state);
  }
  return { ...IDLE_TV_CAST_STATE };
}

async function sendWebCastControl(body: {
  action: 'play' | 'pause' | 'toggle' | 'seek' | 'seekBy' | 'volume';
  positionMs?: number;
  deltaMs?: number;
  volume?: number;
}): Promise<void> {
  const res = await fetchTvCastJson<{
    ok?: boolean;
    state?: Partial<TvCastStateSnapshot>;
  }>('/api/tv-cast/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.ok && res.data?.state) {
    notifyWebCastState(res.data.state);
  }
}

export async function tvCastPlay(): Promise<void> {
  if (!isNativeAndroidCastSupported()) {
    await sendWebCastControl({ action: 'play' });
    return;
  }
  await TvCastNative.play();
}

export async function tvCastPause(): Promise<void> {
  if (!isNativeAndroidCastSupported()) {
    await sendWebCastControl({ action: 'pause' });
    return;
  }
  await TvCastNative.pause();
}

export async function tvCastTogglePlayPause(): Promise<void> {
  if (!isNativeAndroidCastSupported()) {
    await sendWebCastControl({ action: 'toggle' });
    return;
  }
  await TvCastNative.togglePlayPause();
}

export async function tvCastSeek(positionMs: number): Promise<void> {
  const clamped = Math.max(0, Math.round(positionMs));
  if (!isNativeAndroidCastSupported()) {
    await sendWebCastControl({ action: 'seek', positionMs: clamped });
    return;
  }
  await TvCastNative.seek({ positionMs: clamped });
}

export async function tvCastSeekBy(deltaMs: number): Promise<void> {
  const rounded = Math.round(deltaMs);
  if (!isNativeAndroidCastSupported()) {
    await sendWebCastControl({ action: 'seekBy', deltaMs: rounded });
    return;
  }
  await TvCastNative.seekBy({ deltaMs: rounded });
}

export async function tvCastSetVolume(volume: number): Promise<void> {
  const clamped = Math.max(0, Math.min(1, volume));
  if (!isNativeAndroidCastSupported()) {
    await sendWebCastControl({ action: 'volume', volume: clamped });
    return;
  }
  await TvCastNative.setVolume({ volume: clamped });
}

export async function tvCastNextEpisode(): Promise<void> {
  if (!isNativeAndroidCastSupported()) return;
  await TvCastNative.nextEpisode();
}

export async function tvCastPrevEpisode(): Promise<void> {
  if (!isNativeAndroidCastSupported()) return;
  await TvCastNative.prevEpisode();
}

export async function tvCastStop(): Promise<void> {
  if (!isNativeAndroidCastSupported()) {
    const res = await fetchTvCastJson<{ ok?: boolean; state?: Partial<TvCastStateSnapshot> }>(
      '/api/tv-cast/stop',
      { method: 'POST' }
    );
    notifyWebCastState(res.data?.state || IDLE_TV_CAST_STATE);
    return;
  }
  await TvCastNative.stopCast();
}

export async function addTvCastStateListener(
  listener: (state: TvCastStateSnapshot) => void
): Promise<PluginListenerHandle | null> {
  if (!isNativeAndroidCastSupported()) {
    webCastStateListeners.add(listener);
    syncWebCastPolling();
    return {
      remove: async () => {
        webCastStateListeners.delete(listener);
        syncWebCastPolling();
      },
    };
  }
  try {
    return await TvCastNative.addListener('castStateChanged', (raw) => {
      listener(sanitizeCastStateSnapshot(raw));
    });
  } catch {
    return null;
  }
}

export async function addTvCastDevicesListener(
  listener: (event: { devices: TvCastDevice[]; scanning: boolean }) => void
): Promise<PluginListenerHandle | null> {
  if (!isNativeAndroidCastSupported()) return null;
  try {
    return await TvCastNative.addListener('castDevicesUpdated', (ev) => {
      listener({
        devices: dedupeCastDevices(ev?.devices || []),
        scanning: Boolean(ev?.scanning),
      });
    });
  } catch {
    return null;
  }
}

type RemotePlaybackVideo = HTMLVideoElement & {
  remote?: {
    prompt?: () => Promise<void>;
    state?: 'connecting' | 'connected' | 'disconnected';
  };
  webkitShowPlaybackTargetPicker?: () => void;
};

export function isWebRemotePlaybackSupported(video: HTMLVideoElement | null): boolean {
  if (!video) return false;
  const v = video as RemotePlaybackVideo;
  return Boolean(v.remote?.prompt || v.webkitShowPlaybackTargetPicker);
}

export async function promptWebRemotePlayback(video: HTMLVideoElement | null): Promise<boolean> {
  if (!video) return false;
  const v = video as RemotePlaybackVideo;
  if (v.remote?.prompt) {
    await v.remote.prompt();
    return true;
  }
  if (v.webkitShowPlaybackTargetPicker) {
    v.webkitShowPlaybackTargetPicker();
    return true;
  }
  return false;
}
