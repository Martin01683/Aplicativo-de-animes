import type { VlcPlatform, VlcPlaylistEntry } from './types.ts';
import { isSafeExternalHttpUrl } from './urlSafety.ts';

export const DEFAULT_BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export function sanitizeFilename(name: string): string {
  const cleaned = String(name || 'playlist')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 96);
  return cleaned || 'topvlc_episodio';
}

function sanitizeM3uHeaderValue(val: string): string {
  return String(val || '').replace(/[\r\n]+/g, ' ').trim();
}

export function buildM3uPlaylist(entries: VlcPlaylistEntry[]): string {
  const lines: string[] = ['#EXTM3U'];

  for (const entry of entries) {
    if (!isSafeExternalHttpUrl(entry.streamUrl)) continue;
    const duration = typeof entry.durationSeconds === 'number' && entry.durationSeconds > 0
      ? Math.round(entry.durationSeconds)
      : -1;
    const title = sanitizeM3uHeaderValue(entry.title || 'Episódio');
    lines.push(`#EXTINF:${duration},${title}`);

    if (entry.referer && isSafeExternalHttpUrl(entry.referer)) {
      lines.push(`#EXTVLCOPT:http-referrer=${sanitizeM3uHeaderValue(entry.referer)}`);
    }
    const ua = sanitizeM3uHeaderValue(entry.userAgent || DEFAULT_BROWSER_UA);
    lines.push(`#EXTVLCOPT:http-user-agent=${ua}`);

    if (entry.subtitleUrl && isSafeExternalHttpUrl(entry.subtitleUrl)) {
      lines.push(`#EXTVLCOPT:sub-file=${sanitizeM3uHeaderValue(entry.subtitleUrl)}`);
    }

    lines.push(entry.streamUrl.trim());
  }

  return `${lines.join('\n')}\n`;
}

export function buildVlcProtocolUrl(streamUrl: string): string {
  if (!isSafeExternalHttpUrl(streamUrl)) return '';
  return `vlc://${streamUrl.trim()}`;
}

function escapePosixSingleQuote(val: string): string {
  return `'${String(val).replace(/'/g, `'\\''`)}'`;
}

function escapePowerShellDoubleQuote(val: string): string {
  return `"${String(val).replace(/[`"$]/g, '`$&')}"`;
}

export function buildVlcCliCommand(entry: VlcPlaylistEntry, platform: VlcPlatform): string {
  if (!isSafeExternalHttpUrl(entry.streamUrl)) return '';
  const referer = entry.referer && isSafeExternalHttpUrl(entry.referer)
    ? entry.referer
    : 'https://topanimes.net/';
  const sub = entry.subtitleUrl && isSafeExternalHttpUrl(entry.subtitleUrl)
    ? entry.subtitleUrl
    : '';
  const title = sanitizeM3uHeaderValue(entry.title || 'TopVLC');

  if (platform === 'windows') {
    const parts = [
      'vlc.exe',
      escapePowerShellDoubleQuote(entry.streamUrl),
      `--http-referrer=${escapePowerShellDoubleQuote(referer)}`,
      `--meta-title=${escapePowerShellDoubleQuote(title)}`,
    ];
    if (sub) {
      parts.push(`--sub-file=${escapePowerShellDoubleQuote(sub)}`);
    }
    return parts.join(' ');
  }

  const bin = platform === 'mac' ? '/Applications/VLC.app/Contents/MacOS/VLC' : 'vlc';
  const parts = [
    bin,
    escapePosixSingleQuote(entry.streamUrl),
    `--http-referrer=${escapePosixSingleQuote(referer)}`,
    `--meta-title=${escapePosixSingleQuote(title)}`,
  ];
  if (sub) {
    parts.push(`--sub-file=${escapePosixSingleQuote(sub)}`);
  }
  return parts.join(' ');
}
