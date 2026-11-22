import type { ResolvedEmbed, StreamQuality } from './types';

export const DEFAULT_EMBED_CACHE_TTL_MS = 20 * 60 * 1000;
export const SIGNED_URL_EXPIRY_SAFETY_MARGIN_MS = 90 * 1000;

export interface CachedEmbedEntry {
  data: ResolvedEmbed;
  cachedAtMs: number;
  expiresAtMs: number;
}

/**
 * Inspects signed stream URLs (such as BunnyCDN `b-cdn.net` `?token=...&expires=<unix_sec>`
 * or Cloudflare R2 / AWS S3 SigV4 `?X-Amz-Date=YYYYMMDDTHHMMSSZ&X-Amz-Expires=<sec>`)
 * and returns the earliest expiration timestamp in milliseconds, or `null` if none is present.
 */
export function extractEarliestStreamExpiresAtMs(streams: readonly StreamQuality[]): number | null {
  let earliestMs: number | null = null;

  for (const stream of streams) {
    if (!stream?.url) continue;
    try {
      const parsed = new URL(stream.url);
      let tsMs: number | null = null;

      const raw =
        parsed.searchParams.get('expires') ||
        parsed.searchParams.get('exp') ||
        parsed.searchParams.get('expire');
      if (raw && /^\d{9,13}$/.test(raw.trim())) {
        const numeric = Number.parseInt(raw.trim(), 10);
        if (Number.isFinite(numeric) && numeric > 0) {
          // 13-digit values are already milliseconds; 9-10-digit values are Unix seconds
          tsMs = numeric > 1e12 ? numeric : numeric * 1000;
        }
      }

      if (tsMs === null) {
        const amzDate = parsed.searchParams.get('X-Amz-Date') || parsed.searchParams.get('x-amz-date');
        const amzExpires =
          parsed.searchParams.get('X-Amz-Expires') || parsed.searchParams.get('x-amz-expires');
        if (amzDate && amzExpires && /^\d+$/.test(amzExpires.trim())) {
          const dm = amzDate.trim().match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/i);
          const expSec = Number.parseInt(amzExpires.trim(), 10);
          if (dm && Number.isFinite(expSec) && expSec > 0) {
            const signedAtMs = Date.UTC(
              Number.parseInt(dm[1], 10),
              Number.parseInt(dm[2], 10) - 1,
              Number.parseInt(dm[3], 10),
              Number.parseInt(dm[4], 10),
              Number.parseInt(dm[5], 10),
              Number.parseInt(dm[6], 10)
            );
            if (Number.isFinite(signedAtMs) && signedAtMs > 0) {
              tsMs = signedAtMs + expSec * 1000;
            }
          }
        }
      }

      if (tsMs !== null && (earliestMs === null || tsMs < earliestMs)) {
        earliestMs = tsMs;
      }
    } catch {
      // Ignore malformed URLs
    }
  }

  return earliestMs;
}

export function shouldCacheResolvedEmbed(embed: ResolvedEmbed): boolean {
  return embed.status === 'resolved' && embed.streams.length > 0;
}

export function createEmbedCacheEntry(
  embed: ResolvedEmbed,
  nowMs = Date.now()
): CachedEmbedEntry | null {
  if (!shouldCacheResolvedEmbed(embed)) return null;

  const defaultExpiresAtMs = nowMs + DEFAULT_EMBED_CACHE_TTL_MS;
  const streamExpiresAtMs = extractEarliestStreamExpiresAtMs(embed.streams);
  if (streamExpiresAtMs === null) {
    return {
      data: embed,
      cachedAtMs: nowMs,
      expiresAtMs: defaultExpiresAtMs,
    };
  }

  const safeSignedExpiresAtMs = streamExpiresAtMs - SIGNED_URL_EXPIRY_SAFETY_MARGIN_MS;
  if (safeSignedExpiresAtMs <= nowMs) {
    return null;
  }

  return {
    data: embed,
    cachedAtMs: nowMs,
    expiresAtMs: Math.min(defaultExpiresAtMs, safeSignedExpiresAtMs),
  };
}

export function isEmbedCacheEntryValid(
  entry: CachedEmbedEntry | undefined | null,
  nowMs = Date.now()
): entry is CachedEmbedEntry {
  if (!entry) return false;
  if (!shouldCacheResolvedEmbed(entry.data)) return false;
  return nowMs < entry.expiresAtMs;
}
