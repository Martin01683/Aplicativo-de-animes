import { Capacitor, registerPlugin } from '@capacitor/core';
import { isEpisodeAvailableOnServer } from './episodeAvailability';
import { canonicalEpisodeKey as canonicalKey } from './favoriteAlerts';
import type { VideoScaleMode } from './playbackProgress';
import type {
  AnimeAudioTrackData,
  AnimeDetails,
  AnimeEpisodeLink,
  PlayerOption,
  StreamQuality,
  SubtitleTrack,
} from './types';

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

function isSeriesEpisodeListAscending(episodes: AnimeEpisodeLink[]): boolean {
  if (episodes.length < 2) return true;
  const firstSeason = episodes[0].seasonNumber || 1;
  const lastSeason = episodes[episodes.length - 1].seasonNumber || 1;
  if (firstSeason !== lastSeason) {
    return lastSeason > firstSeason;
  }
  const firstNum = episodes[0].episodeNumber;
  const lastNum = episodes[episodes.length - 1].episodeNumber;
  if (
    typeof firstNum === 'number' &&
    typeof lastNum === 'number' &&
    firstNum !== lastNum
  ) {
    return lastNum > firstNum;
  }
  return true;
}

/**
 * Resolves adjacent previous/next PLAYABLE episode URLs from a series episode list,
 * handling both ascending (Ep 1 -> Ep N) and descending (Ep N -> Ep 1) orders
 * while never advancing into unreleased/unavailable episodes.
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

  const ascending = isSeriesEpisodeListAscending(episodes);
  const prevStep = ascending ? -1 : 1;
  const nextStep = ascending ? 1 : -1;

  let prevUrl: string | undefined;
  for (let i = currentIndex + prevStep; i >= 0 && i < episodes.length; i += prevStep) {
    if (isEpisodeAvailableOnServer(episodes[i])) {
      prevUrl = episodes[i].url;
      break;
    }
  }

  let nextUrl: string | undefined;
  for (let i = currentIndex + nextStep; i >= 0 && i < episodes.length; i += nextStep) {
    if (isEpisodeAvailableOnServer(episodes[i])) {
      nextUrl = episodes[i].url;
      break;
    }
  }

  return {
    currentIndex,
    prevUrl,
    nextUrl,
  };
}

/**
 * Returns the immediately following episode in chronological order when it is NOT yet
 * available on streaming servers (so the player can inform the user of its official release
 * forecast instead of navigating to a dead page).
 */
export function findUpcomingNextEpisode(
  episodes: AnimeEpisodeLink[],
  currentUrl: string
): AnimeEpisodeLink | undefined {
  if (!episodes.length || !currentUrl) return undefined;
  const currentIndex = episodes.findIndex((ep) => isSameEpisodeUrl(ep.url, currentUrl));
  if (currentIndex < 0) return undefined;

  const ascending = isSeriesEpisodeListAscending(episodes);
  const nextIdx = ascending ? currentIndex + 1 : currentIndex - 1;
  if (nextIdx < 0 || nextIdx >= episodes.length) return undefined;

  const candidate = episodes[nextIdx];
  return isEpisodeAvailableOnServer(candidate) ? undefined : candidate;
}

/**
 * Resolves the episode list for the exact audio track (DUB or LEG) that owns `episodeUrl`
 * (or `episodeSeriesUrl`), preventing Prev/Next episode navigation from silently crossing
 * between dubbed and subbed tracks when both are available on the same anime page.
 */
export function resolveSeriesEpisodesForEpisode(
  anime: AnimeDetails | null | undefined,
  episodeUrl?: string,
  episodeSeriesUrl?: string
): AnimeEpisodeLink[] | undefined {
  if (!anime) return undefined;

  const tracks = [anime.audioTracks?.DUB, anime.audioTracks?.LEG].filter(
    (t): t is AnimeAudioTrackData => Boolean(t && t.episodes.length > 0)
  );

  if (episodeUrl) {
    for (const track of tracks) {
      if (track.episodes.some((ep) => isSameEpisodeUrl(ep.url, episodeUrl))) {
        return track.episodes;
      }
    }
    if (anime.episodes.some((ep) => isSameEpisodeUrl(ep.url, episodeUrl))) {
      return anime.episodes;
    }
  }

  if (episodeSeriesUrl) {
    for (const track of tracks) {
      if (track.sourceUrl && isSameEpisodeUrl(track.sourceUrl, episodeSeriesUrl)) {
        return track.episodes;
      }
    }
    if (isSameEpisodeUrl(anime.url, episodeSeriesUrl)) {
      return anime.episodes;
    }
  }

  return undefined;
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

