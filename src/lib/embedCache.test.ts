import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createEmbedCacheEntry,
  DEFAULT_EMBED_CACHE_TTL_MS,
  extractEarliestStreamExpiresAtMs,
  isEmbedCacheEntryValid,
  SIGNED_URL_EXPIRY_SAFETY_MARGIN_MS,
} from './embedCache.ts';
import type { ResolvedEmbed } from './types.ts';

function makeResolvedEmbed(urls: string[], status: ResolvedEmbed['status'] = 'resolved'): ResolvedEmbed {
  return {
    embedUrl: 'https://topanimes.net/antivirus2/yes/?id=demo',
    provider: 'KojimaCDN',
    status,
    streams: urls.map((url, idx) => ({
      label: idx === 0 ? '1080p' : '720p',
      height: idx === 0 ? 1080 : 720,
      url,
      format: 'hls',
    })),
    subtitles: [],
    referer: 'https://topanimes.net/',
  };
}

describe('embedCache', () => {
  it('extracts the earliest expires timestamp from BunnyCDN signed URLs', () => {
    const earliest = extractEarliestStreamExpiresAtMs([
      {
        label: '1080p',
        height: 1080,
        url: 'https://doce-de-leite-vegano.b-cdn.net/stream.m3u8?token=abc&expires=1795286692',
        format: 'hls',
      },
      {
        label: '720p',
        height: 720,
        url: 'https://doce-de-leite-vegano.b-cdn.net/stream720.m3u8?token=def&expires=1795280000',
        format: 'hls',
      },
    ]);
    assert.equal(earliest, 1795280000 * 1000);
  });

  it('caps cache expiration below signed stream expires minus safety margin', () => {
    const nowMs = 1_795_280_000_000;
    const fiveMinLaterSec = Math.floor((nowMs + 5 * 60 * 1000) / 1000);
    const embed = makeResolvedEmbed([
      `https://doce-de-leite-vegano.b-cdn.net/cdn_stream.m3u8?token=xyz&expires=${fiveMinLaterSec}`,
    ]);

    const entry = createEmbedCacheEntry(embed, nowMs);
    assert.ok(entry);
    assert.equal(entry.expiresAtMs, fiveMinLaterSec * 1000 - SIGNED_URL_EXPIRY_SAFETY_MARGIN_MS);
    assert.equal(isEmbedCacheEntryValid(entry, nowMs + 60 * 1000), true);
    assert.equal(isEmbedCacheEntryValid(entry, entry.expiresAtMs), false);
  });

  it('uses default TTL for unsigned streams and refuses to cache expired or failed embeds', () => {
    const nowMs = 1_795_280_000_000;
    const unsigned = makeResolvedEmbed(['https://cdn.example.com/master.m3u8']);
    const unsignedEntry = createEmbedCacheEntry(unsigned, nowMs);
    assert.ok(unsignedEntry);
    assert.equal(unsignedEntry.expiresAtMs, nowMs + DEFAULT_EMBED_CACHE_TTL_MS);

    const almostExpiredSec = Math.floor((nowMs + 30 * 1000) / 1000);
    const expiringSoon = makeResolvedEmbed([
      `https://doce-de-leite-vegano.b-cdn.net/cdn_stream.m3u8?token=xyz&expires=${almostExpiredSec}`,
    ]);
    assert.equal(createEmbedCacheEntry(expiringSoon, nowMs), null);

    const errored = makeResolvedEmbed([], 'error');
    assert.equal(createEmbedCacheEntry(errored, nowMs), null);
  });

  it('extracts expiration timestamps from Cloudflare R2 / AWS SigV4 X-Amz-Date + X-Amz-Expires URLs', () => {
    const earliest = extractEarliestStreamExpiresAtMs([
      {
        label: '1080p (Full HD)',
        height: 1080,
        url: 'https://173fe263eae04670ecfcebf237fd6480.r2.cloudflarestorage.com/zful/538184.mp4?X-Amz-Date=20261122T010000Z&X-Amz-Expires=3600&X-Amz-Signature=abc',
        format: 'mp4',
      },
    ]);
    assert.equal(earliest, Date.UTC(2026, 10, 22, 2, 0, 0));
  });
});
