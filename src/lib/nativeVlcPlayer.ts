import { Capacitor, registerPlugin } from '@capacitor/core';
import { normalizeTopAnimesUrl } from './favoriteAlerts';
import type { AnimeEpisodeLink, PlayerOption, StreamQuality, SubtitleTrack } from './types';

export interface NativeVlcPlayOptions {
  title: string;
  episodeUrl?: string;
  seriesUrl?: string;
  seriesTitle?: string;
  streams: StreamQuality[];
  subtitles: SubtitleTrack[];
  episodes?: AnimeEpisodeLink[];
  watchedUrls?: string[];
  options?: PlayerOption[];
  selectedServerNume?: string;
  referer: string;
  preferDirect?: boolean;
  startPositionMs?: number;
  streamIndex?: number;
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
}

export interface NativeVlcPlayResult {
  action: 'closed' | 'prev' | 'next' | 'select';
  episodeUrl?: string;
  positionMs: number;
  durationMs: number;
  streamIndex: number;
  visitedEpisodes?: NativeVlcVisitedEpisode[];
}

export interface NativeVlcPlayerPlugin {
  play(options: NativeVlcPlayOptions): Promise<NativeVlcPlayResult>;
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

function canonicalEpisodeKey(raw: string): string {
  const normalized = normalizeTopAnimesUrl(raw) || raw.trim();
  try {
    const u = new URL(normalized);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '').toLowerCase();
    return `${host}${path}${u.search}`;
  } catch {
    return normalized.replace(/^https?:\/\/(?:www\.)?/i, '').replace(/\/+$/, '').toLowerCase();
  }
}

export function isSameEpisodeUrl(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  return canonicalEpisodeKey(a) === canonicalEpisodeKey(b);
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
