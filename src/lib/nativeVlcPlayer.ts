import { Capacitor, registerPlugin } from '@capacitor/core';
import { canonicalEpisodeKey as canonicalKey } from './favoriteAlerts';
import type { VideoScaleMode } from './playbackProgress';
import type { AnimeEpisodeLink, PlayerOption, StreamQuality, SubtitleTrack } from './types';

export interface NativeVlcPlayOptions {
  title: string;
  episodeUrl?: string;
  seriesUrl?: string;
  seriesTitle?: string;
  poster?: string;
  isMovie?: boolean;
  streams: StreamQuality[];
  subtitles: SubtitleTrack[];
  episodes?: AnimeEpisodeLink[];
  watchedUrls?: string[];
  options?: PlayerOption[];
  selectedServerNume?: string;
  referer: string;
  preferDirect?: boolean;
  startPositionMs?: number;
  forceStartPosition?: boolean;
  streamIndex?: number;
  videoScale?: VideoScaleMode;
  hasPrev?: boolean;
  hasNext?: boolean;
  prevUrl?: string;
  nextUrl?: string;
  skipIntroSeconds?: number;
  autoPlayNextEpisode?: boolean;
}

export interface NativeVlcVisitedEpisode {
  url: string;
  title: string;
  seriesTitle?: string;
  seriesUrl?: string;
  poster?: string;
  isMovie?: boolean;
  positionMs?: number;
  durationMs?: number;
  completed?: boolean;
  watchedAtMs?: number;
}

export interface NativeVlcPlayResult {
  action: 'closed' | 'prev' | 'next' | 'select';
  episodeUrl?: string;
  positionMs: number;
  durationMs: number;
  completed?: boolean;
  streamIndex: number;
  videoScale?: VideoScaleMode;
  visitedEpisodes?: NativeVlcVisitedEpisode[];
}

export interface NativeVlcPlayerPlugin {
  play(options: NativeVlcPlayOptions): Promise<NativeVlcPlayResult>;
  setVideoScale(options: { videoScale: VideoScaleMode }): Promise<void>;
  consumePendingSession(): Promise<{ session: NativeVlcPlayResult | null }>;
}

const NativeVlcPlayer = registerPlugin<NativeVlcPlayerPlugin>('NativeVlcPlayer');

export function shouldEnableDesktopShortcuts(
  isNativeAndroid: boolean,
  userAgent: string
): boolean {
  if (isNativeAndroid) return false;
  if (/\bAndroid\b/i.test(userAgent || '')) return false;
  return true;
}

export function isAndroidNativeVlcSupported(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
  } catch {
    return false;
  }
}

export function isDesktopShortcutsEnabled(): boolean {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return shouldEnableDesktopShortcuts(isAndroidNativeVlcSupported(), ua);
}

export function isSameEpisodeUrl(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  return canonicalKey(a) === canonicalKey(b);
}

/**
 * Resolves adjacent previous/next episode URLs from a series episode list,
 * handling both ascending (Ep 1 -> Ep N) and descending (Ep N -> Ep 1) orders.
 */
export function resolveSeriesPrevNext(
  episodes: AnimeEpisodeLink[],
  currentUrl: string
): { prevUrl?: string; nextUrl?: string; currentIndex: number } {
  if (!episodes.length || !currentUrl) {
    return { currentIndex: -1 };
  }
  const currentIndex = episodes.findIndex((ep) => isSameEpisodeUrl(ep.url, currentUrl));
  if (currentIndex < 0) {
    return { currentIndex: -1 };
  }

  // Detect ordering when numeric episode numbers are present
  let ascending = true;
  if (episodes.length >= 2) {
    const firstNum = episodes[0].episodeNumber;
    const lastNum = episodes[episodes.length - 1].episodeNumber;
    if (
      typeof firstNum === 'number' &&
      typeof lastNum === 'number' &&
      firstNum !== lastNum
    ) {
      ascending = lastNum > firstNum;
    }
  }

  const prevIdx = ascending ? currentIndex - 1 : currentIndex + 1;
  const nextIdx = ascending ? currentIndex + 1 : currentIndex - 1;

  return {
    currentIndex,
    prevUrl: prevIdx >= 0 && prevIdx < episodes.length ? episodes[prevIdx].url : undefined,
    nextUrl: nextIdx >= 0 && nextIdx < episodes.length ? episodes[nextIdx].url : undefined,
  };
}

export async function playWithNativeVlc(
  options: NativeVlcPlayOptions
): Promise<NativeVlcPlayResult> {
  return NativeVlcPlayer.play(options);
}

export async function setNativeVlcVideoScale(videoScale: VideoScaleMode): Promise<void> {
  if (!isAndroidNativeVlcSupported()) return;
  try {
    await NativeVlcPlayer.setVideoScale({ videoScale });
  } catch {
    // ignore if native plugin method is unavailable
  }
}

export async function consumeNativeVlcPendingSession(): Promise<NativeVlcPlayResult | null> {
  if (!isAndroidNativeVlcSupported()) return null;
  try {
    const res = await NativeVlcPlayer.consumePendingSession();
    return res?.session || null;
  } catch {
    return null;
  }
}

export type PlayerGestureSide = 'left' | 'center' | 'right';

export function classifyPlayerTapZone(x: number, width: number): PlayerGestureSide {
  if (width <= 0) return 'center';
  const rel = x / width;
  if (rel < 0.38) return 'left';
  if (rel > 0.62) return 'right';
  return 'center';
}

export function classifyVerticalSwipeAction(downX: number, width: number): 'brightness' | 'volume' {
  if (width <= 0) return 'brightness';
  return downX < width * 0.5 ? 'brightness' : 'volume';
}

export function computeSwipeBrightness(
  startBrightness: number,
  deltaY: number,
  gestureRangePx: number
): number {
  const safeRange = Math.max(1, gestureRangePx);
  const next = startBrightness + -deltaY / safeRange;
  return Math.max(0.01, Math.min(1, next));
}

export function computeSwipeVolume(
  startVolume: number,
  maxVolume: number,
  deltaY: number,
  gestureRangePx: number
): { volume: number; percent: number; muted: boolean } {
  const safeMax = Math.max(1, maxVolume);
  const safeRange = Math.max(1, gestureRangePx);
  const raw = startVolume + (-deltaY / safeRange) * safeMax;
  const volume = Math.round(Math.max(0, Math.min(safeMax, raw)));
  const percent = Math.round((volume * 100) / safeMax);
  return { volume, percent, muted: volume === 0 };
}

