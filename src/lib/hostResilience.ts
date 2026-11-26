import type { HttpFetchOptions, HttpFetchResult, HttpFetcher } from './httpTypes.ts';

/**
 * Remembers hosts whose retry cycle was just exhausted. While a host is inside its cool-off
 * window, follow-up requests get a single fast attempt instead of paying the entire exponential
 * backoff cascade again.
 */
export class HostFailureTracker {
  private readonly failures = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(ttlMs = 60_000, now: () => number = () => Date.now()) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  private normalizeHost(host: string | null | undefined): string | null {
    if (!host) return null;
    const clean = host.trim().toLowerCase();
    return clean || null;
  }

  isFailing(host: string | null | undefined): boolean {
    const key = this.normalizeHost(host);
    if (!key) return false;
    const failedAt = this.failures.get(key);
    if (failedAt === undefined) return false;
    if (this.now() - failedAt >= this.ttlMs) {
      this.failures.delete(key);
      return false;
    }
    return true;
  }

  markFailed(host: string | null | undefined): void {
    const key = this.normalizeHost(host);
    if (!key) return;
    this.failures.set(key, this.now());
  }

  clear(host: string | null | undefined): void {
    const key = this.normalizeHost(host);
    if (!key) return;
    this.failures.delete(key);
  }

  reset(): void {
    this.failures.clear();
  }
}

/** Hosts that manage their own dedicated 429 endpoint failover/circuit-breakers. */
const DEDICATED_RATE_LIMIT_HOST_RE =
  /(?:^|\.)(?:deepl\.com|translate\.googleapis\.com|clients5\.google\.com)$/i;

/** Statuses that describe a momentary server-side condition rather than a settled answer. */
export function isTransientHttpStatus(status: number): boolean {
  return status === 408 || (status >= 500 && status <= 599);
}

/**
 * Parses an HTTP `Retry-After` header (either delta-seconds or HTTP-date) into milliseconds,
 * clamped to `[0, maxMs]`. Returns `null` when missing or unparseable.
 */
export function parseRetryAfterMs(
  headerValue: string | null | undefined,
  nowMs = Date.now(),
  maxMs = 15_000
): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (!trimmed) return null;

  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const sec = Number.parseFloat(trimmed);
    if (!Number.isFinite(sec)) return null;
    return Math.min(maxMs, Math.max(0, Math.round(sec * 1000)));
  }

  const parsedDate = Date.parse(trimmed);
  if (Number.isFinite(parsedDate)) {
    return Math.min(maxMs, Math.max(0, parsedDate - nowMs));
  }

  return null;
}

/**
 * Classifies whether a thrown fetch error represents a transient network blip (timeout, dropped
 * socket, temporary DNS issue) rather than a deterministic rejection (SSRF guard, invalid URL,
 * explicit user cancellation).
 */
export function isTransientNetworkError(error: unknown): boolean {
  if (!error) return false;
  const errObj = error as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
  const name = typeof errObj.name === 'string' ? errObj.name : '';
  const code = typeof errObj.code === 'string' ? errObj.code : '';
  const message = typeof errObj.message === 'string' ? errObj.message : String(error);

  if (
    /bloquead[oa]|inv[aá]lid[oa]|privado|cancelad[oa]|not allowed|unsupported/i.test(message)
  ) {
    return false;
  }

  if (
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    /^(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EPIPE|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|UND_ERR_SOCKET)$/i.test(
      code
    )
  ) {
    return true;
  }

  if (
    /timeout|timed out|socket|network|econnreset|etimedout|fetch failed|failed to fetch|connection reset|broken pipe|eof|aborted|temporarily unavailable/i.test(
      message
    )
  ) {
    return true;
  }

  if (errObj.cause && errObj.cause !== error) {
    return isTransientNetworkError(errObj.cause);
  }

  return false;
}

export function extractHostname(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

export interface ResilientFetcherOptions {
  tracker?: HostFailureTracker;
  /** Maximum total attempts for healthy hosts on idempotent GET requests (default: 2). */
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** Max `Retry-After` wait tolerated on interactive 429 retries (default: 4000ms). */
  maxRetryAfterWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Wraps an `HttpFetcher` with per-host resilience and smart retries:
 * - Per-host circuit breaker (`HostFailureTracker`) so failing hosts get 1 fast attempt during cool-off
 * - Exponential backoff with jitter for transient 408/5xx/network blips on GET requests
 * - Respects HTTP 429 `Retry-After` (skipping hosts that manage their own multi-endpoint failover)
 * - Never retries deterministic client errors (400/401/403/404) or non-idempotent POST requests
 */
export function createResilientHttpFetcher(
  baseFetcher: HttpFetcher,
  options: ResilientFetcherOptions = {}
): HttpFetcher {
  const tracker = options.tracker ?? new HostFailureTracker();
  const configuredMaxAttempts = Math.max(1, options.maxAttempts ?? 2);
  const initialDelayMs = Math.max(0, options.initialDelayMs ?? 350);
  const maxDelayMs = Math.max(initialDelayMs, options.maxDelayMs ?? 3_500);
  const maxRetryAfterWaitMs = Math.max(0, options.maxRetryAfterWaitMs ?? 4_000);
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? (() => Date.now());

  return async (url: string, fetchOptions?: HttpFetchOptions): Promise<HttpFetchResult> => {
    const host = extractHostname(url);
    const method = (fetchOptions?.method || 'GET').toUpperCase();
    const isIdempotentGet = method === 'GET';
    const hasDedicatedRateLimiter = Boolean(host && DEDICATED_RATE_LIMIT_HOST_RE.test(host));
    const maxAttempts =
      !isIdempotentGet || tracker.isFailing(host) ? 1 : configuredMaxAttempts;

    let attempt = 0;
    let delayMs = initialDelayMs;

    while (true) {
      attempt += 1;
      try {
        const res = await baseFetcher(url, fetchOptions);

        // Any settled response (2xx, 3xx, or deterministic 4xx like 403/404) proves the host is reachable
        if (res.ok || (res.status >= 300 && res.status < 500 && res.status !== 408 && res.status !== 429)) {
          tracker.clear(host);
          return res;
        }

        // HTTP 429 with Retry-After support (only for hosts without their own failover layer)
        if (res.status === 429) {
          if (hasDedicatedRateLimiter || attempt >= maxAttempts) {
            return res;
          }
          const retryAfter = parseRetryAfterMs(res.retryAfter, now(), maxRetryAfterWaitMs);
          const wait = retryAfter !== null ? retryAfter : delayMs;
          if (wait > maxRetryAfterWaitMs) return res;
          if (wait > 0) await sleep(wait);
          delayMs = Math.min(maxDelayMs, delayMs * 2);
          continue;
        }

        // Transient 408 / 5xx server hiccups
        if (isTransientHttpStatus(res.status)) {
          if (attempt >= maxAttempts) {
            if (!hasDedicatedRateLimiter) tracker.markFailed(host);
            return res;
          }
          const jitter = Math.floor(random() * (Math.floor(delayMs / 2) + 1));
          await sleep(delayMs + jitter);
          delayMs = Math.min(maxDelayMs, delayMs * 2);
          continue;
        }

        return res;
      } catch (err) {
        if (!isTransientNetworkError(err)) {
          throw err;
        }
        if (attempt >= maxAttempts) {
          if (!hasDedicatedRateLimiter) tracker.markFailed(host);
          throw err;
        }
        const jitter = Math.floor(random() * (Math.floor(delayMs / 2) + 1));
        await sleep(delayMs + jitter);
        delayMs = Math.min(maxDelayMs, delayMs * 2);
      }
    }
  };
}
