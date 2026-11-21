import { Capacitor, registerPlugin } from '@capacitor/core';
import type { StreamQuality, SubtitleTrack } from './types';

export interface NativeVlcPlayOptions {
  title: string;
  streams: StreamQuality[];
  subtitles: SubtitleTrack[];
  referer: string;
  preferDirect?: boolean;
  startPositionMs?: number;
  streamIndex?: number;
  hasPrev?: boolean;
  hasNext?: boolean;
}

export interface NativeVlcPlayResult {
  action: 'closed' | 'prev' | 'next';
  positionMs: number;
  durationMs: number;
  streamIndex: number;
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

export async function playWithNativeVlc(
  options: NativeVlcPlayOptions
): Promise<NativeVlcPlayResult> {
  return NativeVlcPlayer.play(options);
}
