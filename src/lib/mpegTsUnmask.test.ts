import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  adjustContentRangeForStrip,
  findMpegTsSyncOffset,
  isDisguisedContentType,
  isDisguisedSegmentUrl,
  isStartAtZeroRange,
  looksLikeM3u8Manifest,
  MPEG_TS_PACKET_SIZE,
  MPEG_TS_SYNC_BYTE,
} from './mpegTsUnmask.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(ROOT, relativePath), 'utf-8');
}

// Exact 68-byte 1x1 PNG header prepended to KojimaCDN HLS segments (tiktokcdn.com *.image)
const KOJIMA_PNG_HEADER = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0b, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x60, 0x00, 0x02, 0x00,
  0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4,
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82,
]);

function makeMpegTsPayload(packetCount: number): Uint8Array {
  const buf = new Uint8Array(packetCount * MPEG_TS_PACKET_SIZE);
  for (let i = 0; i < packetCount; i += 1) {
    const base = i * MPEG_TS_PACKET_SIZE;
    buf[base] = MPEG_TS_SYNC_BYTE;
    buf[base + 1] = i === 0 ? 0x40 : 0x01; // payload_unit_start + PID MSB, TEI=0
    buf[base + 2] = i === 0 ? 0x00 : 0x00; // PID LSB
    buf[base + 3] = 0x10 | (i & 0x0f); // payload-only adaptation_field_control=01 + continuity
    buf[base + 4] = 0xff;
  }
  return buf;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

describe('mpegTsUnmask', () => {
  it('detects 68-byte PNG-disguised KojimaCDN MPEG-TS segments', () => {
    assert.equal(KOJIMA_PNG_HEADER.length, 68);
    const segment = concatBytes(KOJIMA_PNG_HEADER, makeMpegTsPayload(10));
    assert.equal(findMpegTsSyncOffset(segment, segment.length, false), 68);
  });

  it('detects clean MPEG-TS starting at byte 0', () => {
    const clean = makeMpegTsPayload(8);
    assert.equal(findMpegTsSyncOffset(clean, clean.length, false), 0);
  });

  it('detects custom non-PNG wrapper headers (e.g. GIF89a) before MPEG-TS packets', () => {
    const fakeGif = Uint8Array.from([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00,
      0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
      0xff, 0xff, 0xff, 0x2c, 0x00, 0x00, 0x00, 0x00,
      0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44,
      0x01, 0x00, 0x3b,
    ]);
    // Note: GIF starts with 0x47 ('G'), must NOT falsely match offset 0!
    const segment = concatBytes(fakeGif, makeMpegTsPayload(6));
    assert.equal(findMpegTsSyncOffset(segment, segment.length, false), fakeGif.length);
  });

  it('handles short 2-packet tail segments at EOF', () => {
    const shortTail = concatBytes(KOJIMA_PNG_HEADER, makeMpegTsPayload(2));
    assert.equal(findMpegTsSyncOffset(shortTail, shortTail.length, true), 68);
  });

  it('returns -1 for non-TS payloads such as MP4, WebVTT, or random encrypted data', () => {
    const mp4 = new Uint8Array(2048);
    mp4.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d], 0);
    assert.equal(findMpegTsSyncOffset(mp4, mp4.length, false), -1);

    const vtt = new TextEncoder().encode('WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nOlá mundo!\n'.repeat(30));
    assert.equal(findMpegTsSyncOffset(vtt, vtt.length, true), -1);

    const randomLike = new Uint8Array(4096);
    for (let i = 0; i < randomLike.length; i += 1) {
      randomLike[i] = (i * 73 + 19) & 0xff;
    }
    assert.equal(findMpegTsSyncOffset(randomLike, randomLike.length, false), -1);
  });

  it('detects disguised URLs, content types, zero-start ranges, and M3U8 manifests', () => {
    assert.equal(
      isDisguisedSegmentUrl(
        'https://p19-ad-site-sign-sg.tiktokcdn.com/tos-alisg-i-d5opwmad15-sg/abc~tplv-d5opwmad15-ttam-origin.image?x-expires=123'
      ),
      true
    );
    assert.equal(isDisguisedSegmentUrl('https://cdn.example.com/seg001.ts'), false);

    assert.equal(isDisguisedContentType('image/png'), true);
    assert.equal(isDisguisedContentType('image/jpeg'), true);
    assert.equal(isDisguisedContentType('application/octet-stream'), true);
    assert.equal(isDisguisedContentType('video/mp2t'), false);

    assert.equal(isStartAtZeroRange(undefined), true);
    assert.equal(isStartAtZeroRange('bytes=0-'), true);
    assert.equal(isStartAtZeroRange('bytes=0-1048575'), true);
    assert.equal(isStartAtZeroRange('bytes=1024-2048'), false);

    const m3u8 = new TextEncoder().encode('\uFEFF\n#EXTM3U\n#EXT-X-VERSION:3\n');
    assert.equal(looksLikeM3u8Manifest(m3u8), true);
    assert.equal(looksLikeM3u8Manifest(KOJIMA_PNG_HEADER), false);
  });

  it('adjusts Content-Range cleanly when stripping fake prefix bytes', () => {
    assert.equal(adjustContentRangeForStrip('bytes 0-1948/1949', 68), 'bytes 0-1880/1881');
    assert.equal(adjustContentRangeForStrip('bytes 0-1948/*', 68), 'bytes 0-1880/*');
    assert.equal(adjustContentRangeForStrip('bytes 100-1948/1949', 68), null);
    assert.equal(adjustContentRangeForStrip('bytes 0-50/51', 68), null);
  });
});

describe('Android KojimaCDN playback regression guards', () => {
  const localProxyJava = readRepoFile(
    'android/app/src/main/java/com/topanimes/player/LocalProxyPlugin.java'
  );
  const vlcActivityJava = readRepoFile(
    'android/app/src/main/java/com/topanimes/player/VlcPlayerActivity.java'
  );
  const resolverJava = readRepoFile(
    'android/app/src/main/java/com/topanimes/player/TopAnimesEpisodeResolver.java'
  );
  const topanimesSourceTs = readRepoFile('src/lib/sources/providers/topanimesSource.ts');

  it('never bypasses LocalProxyPlugin for tiktokcdn.com on Android', () => {
    const directHostsMatch = localProxyJava.match(
      /DIRECT_HOSTS_PATTERN\s*=\s*Pattern\.compile\(([\s\S]*?)\);/
    );
    assert.ok(directHostsMatch, 'DIRECT_HOSTS_PATTERN must exist in LocalProxyPlugin.java');
    assert.doesNotMatch(directHostsMatch[1], /tiktokcdn/i);

    assert.doesNotMatch(resolverJava, /tiktokcdn\.com/i);

    const nativePreferDirectMatch = topanimesSourceTs.match(
      /export async function resolveTopAnimesEmbed[\s\S]*?const preferDirect\s*=\s*([^;]+);/
    );
    assert.ok(nativePreferDirectMatch, 'resolveTopAnimesEmbed preferDirect must exist');
    assert.doesNotMatch(nativePreferDirectMatch[1], /tiktokcdn/i);
  });

  it('unmasks disguised MPEG-TS segments to video/mp2t inside LocalProxyPlugin.java', () => {
    assert.match(localProxyJava, /findMpegTsSyncOffset\(/);
    assert.match(localProxyJava, /outContentType\s*=\s*"video\/mp2t"/);
    assert.match(localProxyJava, /ensureSharedProxyBaseUrl\(/);
    assert.match(localProxyJava, /\/stream-proxy\/segment\.ts/);
  });

  it('does not prematurely mark playback started inside LibVLC Event.Playing', () => {
    const playingBlockMatch = vlcActivityJava.match(
      /case MediaPlayer\.Event\.Playing:([\s\S]*?)case MediaPlayer\.Event\.Paused:/
    );
    assert.ok(playingBlockMatch, 'MediaPlayer.Event.Playing case must exist');
    assert.doesNotMatch(
      playingBlockMatch[1],
      /hasPlaybackStartedForStream\s*=\s*true/,
      'Event.Playing must not set hasPlaybackStartedForStream=true before Vout/TimeChanged confirms frames'
    );
    assert.doesNotMatch(
      playingBlockMatch[1],
      /removeCallbacks\(loadWatchdogRunnable\)/,
      'Event.Playing must keep loadWatchdogRunnable armed until playback is confirmed'
    );
    assert.match(vlcActivityJava, /private void markPlaybackStartedForStream\(\)/);
  });
});
