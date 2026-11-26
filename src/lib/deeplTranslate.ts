import type { HttpFetcher } from './httpTypes.ts';

/**
 * DeepL translation WITHOUT the official API (no API key, no account).
 *
 * It talks to the stateless "oneshot" endpoint that DeepL's own iOS app uses for anonymous
 * translations. The request shape was reverse-engineered by the open-source DeepLX project
 * (OwO-Network/DeepLX, MIT license); the identity constants below mirror its
 * `translate/translate.go` as of October 2026.
 *
 * Maintenance notes:
 * - This is an UNDOCUMENTED endpoint. DeepL can change or block it at any time, and automated
 *   use may conflict with DeepL's terms of service. Callers must always keep a fallback
 *   (see `translation.ts`: TheTVDB PT-BR > DeepL > Google Translate > original text).
 * - DeepL answers clients with an inconsistent or stale identity with HTTP 429/403. The iOS app
 *   version is therefore resolved at runtime from Apple's public lookup API; the pinned
 *   constants are only the fallback and may need a refresh now and then.
 * - A 429/403 answer opens a circuit breaker so the app stops calling DeepL for a while instead
 *   of hammering it (and paying its latency) on every translation.
 * - Anonymous requests are capped at 1500 UTF-16 code units of text per request.
 */

export const DEEPL_ONESHOT_FREE_ENDPOINT = 'https://oneshot-free.www.deepl.com/v1/translate';

/** Anonymous cap on the combined length of `text[]`, counted in UTF-16 code units (JS `.length`). */
export const DEEPL_MAX_TEXT_UNITS = 1500;

/** Default per-request timeout; short on purpose so a slow DeepL never stalls the Google fallback. */
export const DEEPL_DEFAULT_TIMEOUT_MS = 4500;

const APP_STORE_LOOKUP_URL = 'https://itunes.apple.com/lookup?id=1552407475&country=us';
const APP_STORE_TRACK_ID = 1552407475;
const APP_STORE_BUNDLE_ID = 'com.linguee.DeepLMobileTranslator';
const APP_STORE_SELLER = 'DeepL SE';

// Identity of the DeepL iOS client. Keep these on one coherent profile (see DeepLX).
const FALLBACK_APP_VERSION = '26.52';
const APP_BUILD = '5443737';
const OS_VERSION = '26.0';
const CFNETWORK_VERSION = '3826.600.41';
const DARWIN_VERSION = '25.0.0';

const APP_STORE_TIMEOUT_MS = 3000;
const APP_VERSION_TTL_MS = 24 * 60 * 60 * 1000;
const APP_VERSION_RETRY_MS = 15 * 60 * 1000;

/** Pause after DeepL explicitly blocked/refused us (HTTP 429/403). */
const BLOCKED_COOLDOWN_MS = 30 * 60 * 1000;
/** Pause after repeated generic failures (timeouts, 5xx, unexpected payloads). */
const FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
const FAILURE_THRESHOLD = 3;

export type DeeplSourceLang = 'en' | 'ja' | 'auto';

export interface DeeplTranslateOptions {
  /** Source-language hint; `auto` (default) lets DeepL detect it. */
  sourceLang?: DeeplSourceLang;
  timeoutMs?: number;
}

export interface DeeplIdentity {
  appVersion: string;
  instanceId: string;
  sessionId: string;
}

// ---------------------------------------------------------------------------------------------
// Module state (per process / per app session)
// ---------------------------------------------------------------------------------------------

let clock: () => number = () => Date.now();
let forcedEnabled: boolean | undefined;
let pausedUntil = 0;
let consecutiveFailures = 0;
let sessionIds: { instanceId: string; sessionId: string } | null = null;
let appVersionCache: { value: string; fetchedAt: number } | null = null;
let appVersionAttemptAt: number | null = null;
let appVersionInflight: Promise<string> | null = null;

/** Resets breaker, caches and identity. Intended for tests (optionally injecting a clock). */
export function resetDeeplTranslatorState(overrides: { now?: () => number } = {}): void {
  clock = overrides.now ?? (() => Date.now());
  forcedEnabled = undefined;
  pausedUntil = 0;
  consecutiveFailures = 0;
  sessionIds = null;
  appVersionCache = null;
  appVersionAttemptAt = null;
  appVersionInflight = null;
}

/**
 * Programmatic switch for the DeepL step. `undefined` goes back to the `DEEPL_WEB_ENABLED`
 * environment variable (set it to `false`/`0`/`off`/`no` to disable DeepL on the server).
 */
export function setDeeplWebEnabled(enabled: boolean | undefined): void {
  forcedEnabled = enabled;
}

function readEnvEnabled(): boolean {
  try {
    const raw = typeof process !== 'undefined' ? process.env?.DEEPL_WEB_ENABLED : undefined;
    return !raw || !/^(?:0|false|off|no)$/i.test(raw.trim());
  } catch {
    return true;
  }
}

/** True when DeepL is enabled and not currently paused by the circuit breaker. */
export function isDeeplTranslatorAvailable(): boolean {
  const enabled = forcedEnabled !== undefined ? forcedEnabled : readEnvEnabled();
  return enabled && clock() >= pausedUntil;
}

function newUuid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // RFC 4122 v4
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Stable for the life of the process, like the iOS app's install/session IDs. */
function getSessionIds(): { instanceId: string; sessionId: string } {
  if (!sessionIds) sessionIds = { instanceId: newUuid(), sessionId: newUuid() };
  return sessionIds;
}

// ---------------------------------------------------------------------------------------------
// Request / response helpers (pure, unit-tested)
// ---------------------------------------------------------------------------------------------

export function buildDeeplUserAgent(appVersion: string): string {
  return `DeepL/${appVersion} CFNetwork/${CFNETWORK_VERSION} Darwin/${DARWIN_VERSION}`;
}

export function buildDeeplHeaders(identity: DeeplIdentity): Record<string, string> {
  return {
    // `Authorization: None` is the literal value the iOS client sends for anonymous requests.
    Authorization: 'None',
    'User-Agent': buildDeeplUserAgent(identity.appVersion),
    'Accept-Language': 'en-US,en;q=0.9',
    'x-app-os-version': OS_VERSION,
    'x-app-instance-id': identity.instanceId,
    'x-app-session-id': identity.sessionId,
  };
}

export function buildDeeplRequestBody(
  texts: string[],
  sourceLang: DeeplSourceLang,
  identity: DeeplIdentity,
): string {
  return JSON.stringify({
    text: texts,
    target_lang: 'pt-BR',
    ...(sourceLang !== 'auto' ? { source_lang: sourceLang } : {}),
    usage_type: 'translate',
    app_information: {
      os: 'iOS',
      os_version: OS_VERSION,
      app_version: identity.appVersion,
      app_build: APP_BUILD,
      instance_id: identity.instanceId,
    },
  });
}

/**
 * Extracts exactly `expectedCount` non-empty translations from a oneshot response. The endpoint
 * answers `text[]` positionally, so anything else (wrong count, empty entry, malformed JSON)
 * invalidates the whole batch instead of risking misaligned results.
 */
export function parseDeeplResponse(rawJson: string, expectedCount: number): string[] | null {
  if (!rawJson || !rawJson.trim()) return null;
  try {
    const parsed = JSON.parse(rawJson) as { translations?: unknown } | null;
    const translations = parsed?.translations;
    if (!Array.isArray(translations) || translations.length !== expectedCount) return null;
    const out: string[] = [];
    for (const item of translations) {
      const text = (item as { text?: unknown } | null)?.text;
      if (typeof text !== 'string' || !text.trim()) return null;
      out.push(text);
    }
    return out;
  } catch {
    return null;
  }
}

/** Accepts the dotted numeric forms DeepL ships ("26.42", "26.52.1", "1.2.3.4"). */
export function isValidAppVersion(version: string): boolean {
  return /^\d+(?:\.\d+){1,3}$/.test(version);
}

/**
 * Reads the DeepL iOS marketing version out of Apple's lookup payload. Anything that is not
 * unmistakably the DeepL app is rejected so a bogus answer is never advertised to DeepL.
 */
export function parseAppStoreLookup(rawJson: string): string | null {
  try {
    const parsed = JSON.parse(rawJson) as { resultCount?: unknown; results?: unknown } | null;
    if (
      parsed?.resultCount !== 1 ||
      !Array.isArray(parsed.results) ||
      parsed.results.length !== 1
    ) {
      return null;
    }
    const app = parsed.results[0] as {
      trackId?: unknown;
      bundleId?: unknown;
      artistName?: unknown;
      version?: unknown;
    } | null;
    if (
      app?.trackId !== APP_STORE_TRACK_ID ||
      app.bundleId !== APP_STORE_BUNDLE_ID ||
      app.artistName !== APP_STORE_SELLER
    ) {
      return null;
    }
    return typeof app.version === 'string' && isValidAppVersion(app.version) ? app.version : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// App version resolution
// ---------------------------------------------------------------------------------------------

/**
 * Current DeepL iOS version: cached for 24h, looked up lazily (never at startup), retried at most
 * every 15 minutes after a failure, and falling back to the last known/pinned version.
 */
async function resolveAppVersion(fetchHttp: HttpFetcher): Promise<string> {
  const now = clock();
  if (appVersionCache && now - appVersionCache.fetchedAt < APP_VERSION_TTL_MS) {
    return appVersionCache.value;
  }
  // Join a lookup that is already running BEFORE applying the retry back-off below: the back-off
  // is armed the moment the first caller starts, so checking it first would send every concurrent
  // caller off with the stale pinned version instead of the one being resolved.
  if (appVersionInflight) return appVersionInflight;
  const lastKnown = appVersionCache?.value ?? FALLBACK_APP_VERSION;
  if (appVersionAttemptAt !== null && now - appVersionAttemptAt < APP_VERSION_RETRY_MS) {
    return lastKnown;
  }

  appVersionAttemptAt = now;
  appVersionInflight = (async () => {
    try {
      const res = await fetchHttp(APP_STORE_LOOKUP_URL, {
        accept: 'application/json',
        timeoutMs: APP_STORE_TIMEOUT_MS,
      });
      const version = res.ok ? parseAppStoreLookup(res.body) : null;
      if (version) {
        appVersionCache = { value: version, fetchedAt: clock() };
        return version;
      }
    } catch {
      // Non-fatal: keep using the last known/pinned version
    }
    return lastKnown;
  })().finally(() => {
    appVersionInflight = null;
  });
  return appVersionInflight;
}

// ---------------------------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------------------------

function tripBlocked(status: number): void {
  pausedUntil = clock() + BLOCKED_COOLDOWN_MS;
  if (status === 403) {
    // Possibly an outdated client: look the app version up again after the pause.
    appVersionCache = null;
    appVersionAttemptAt = null;
  }
  console.warn(
    `[deepl] HTTP ${status}: DeepL refused the request; falling back to Google Translate for ${BLOCKED_COOLDOWN_MS / 60000} min.`,
  );
}

function noteFailure(): void {
  consecutiveFailures += 1;
  // The counter is only reset by a success, so the first failure after a pause trips again at
  // once (half-open breaker) instead of needing another full round of failures.
  if (consecutiveFailures >= FAILURE_THRESHOLD) {
    pausedUntil = clock() + FAILURE_COOLDOWN_MS;
    console.warn(
      `[deepl] ${consecutiveFailures} consecutive failures; falling back to Google Translate for ${FAILURE_COOLDOWN_MS / 60000} min.`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

/**
 * Translates `texts` into Brazilian Portuguese through DeepL's anonymous oneshot endpoint.
 *
 * - Positional: the result has the same length/order as `texts`; blank entries are not sent and
 *   come back as they were.
 * - All-or-nothing: returns `null` when DeepL is disabled/paused, the request fails, or the answer
 *   is not exactly aligned with the request, so callers can fall back to another engine.
 * - The combined length of the non-blank texts must stay within `DEEPL_MAX_TEXT_UNITS`; larger
 *   inputs are rejected locally (callers are expected to chunk).
 * - Never throws.
 */
export async function translateTextsWithDeepl(
  fetchHttp: HttpFetcher,
  texts: string[],
  options: DeeplTranslateOptions = {},
): Promise<string[] | null> {
  if (!isDeeplTranslatorAvailable()) return null;

  const positions: number[] = [];
  const requested: string[] = [];
  let totalUnits = 0;
  texts.forEach((text, index) => {
    if (!text || !text.trim()) return;
    positions.push(index);
    requested.push(text);
    totalUnits += text.length;
  });
  if (requested.length === 0 || totalUnits > DEEPL_MAX_TEXT_UNITS) return null;

  try {
    const appVersion = await resolveAppVersion(fetchHttp);
    // Another concurrent request may have tripped the breaker while the version was resolving.
    if (!isDeeplTranslatorAvailable()) return null;

    const identity: DeeplIdentity = { appVersion, ...getSessionIds() };
    const res = await fetchHttp(DEEPL_ONESHOT_FREE_ENDPOINT, {
      method: 'POST',
      contentType: 'application/json',
      accept: '*/*',
      headers: buildDeeplHeaders(identity),
      body: buildDeeplRequestBody(requested, options.sourceLang ?? 'auto', identity),
      timeoutMs: options.timeoutMs ?? DEEPL_DEFAULT_TIMEOUT_MS,
    });

    if (res.status === 429 || res.status === 403) {
      tripBlocked(res.status);
      return null;
    }
    if (!res.ok) {
      noteFailure();
      return null;
    }

    const translations = parseDeeplResponse(res.body, requested.length);
    if (!translations) {
      noteFailure();
      return null;
    }

    consecutiveFailures = 0;
    const merged = texts.slice();
    positions.forEach((position, i) => {
      merged[position] = translations[i];
    });
    return merged;
  } catch {
    noteFailure();
    return null;
  }
}
