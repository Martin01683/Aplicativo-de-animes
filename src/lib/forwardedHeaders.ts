/**
 * Which caller-supplied request headers the HTTP fetchers (Node `safeFetch` in server.ts and the
 * Android `LocalProxyPlugin`) are willing to forward upstream. Everything else is dropped.
 *
 * Keep the Java twin (`LocalProxyPlugin.openWithRedirects`) in sync when changing these lists.
 */

const ALWAYS_FORWARDED_HEADERS = new Set(['authorization', 'origin', 'cookie']);

/**
 * Identity headers that are forwarded ONLY to DeepL's own hosts. `deeplTranslate.ts` needs them to
 * present the coherent iOS-client profile DeepL's anonymous endpoint expects; no other host ever
 * gets a caller-controlled `User-Agent`.
 */
const DEEPL_FORWARDED_HEADERS = new Set([
  'user-agent',
  'accept-language',
  'x-app-os-version',
  'x-app-instance-id',
  'x-app-session-id',
]);

/** True for `deepl.com` and any of its subdomains (but not look-alikes such as `notdeepl.com`). */
export function isDeeplHost(hostname: string): boolean {
  return /(?:^|\.)deepl\.com$/i.test(hostname);
}

/**
 * Copies the permitted `custom` headers into `target` (mutating it). Header names are
 * case-insensitive, so any default already present under another casing (e.g. `User-Agent`) is
 * replaced rather than duplicated. Blank values are ignored.
 */
export function mergeForwardedHeaders(
  target: Record<string, string>,
  custom: Record<string, string> | undefined,
  hostname: string,
): void {
  if (!custom) return;
  const allowDeeplIdentity = isDeeplHost(hostname);

  for (const [name, value] of Object.entries(custom)) {
    const lower = name.toLowerCase();
    const permitted =
      ALWAYS_FORWARDED_HEADERS.has(lower) ||
      (allowDeeplIdentity && DEEPL_FORWARDED_HEADERS.has(lower));
    if (!permitted || typeof value !== 'string' || !value.trim()) continue;

    for (const existing of Object.keys(target)) {
      if (existing.toLowerCase() === lower) delete target[existing];
    }
    target[name] = value.trim();
  }
}
