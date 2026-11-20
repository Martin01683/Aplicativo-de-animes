const TOPANIMES_HOSTS = new Set(['topanimes.net', 'www.topanimes.net']);

const IPV4_PRIVATE_PATTERNS = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./,
];

export function isPrivateOrReservedIp(ip: string): boolean {
  const lower = ip.toLowerCase().trim();
  if (!lower) return true;
  if (lower === '::1' || lower === '::' || lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) {
    return true;
  }
  if (lower.startsWith('::ffff:')) {
    const v4 = lower.slice(7);
    return IPV4_PRIVATE_PATTERNS.some((re) => re.test(v4));
  }
  return IPV4_PRIVATE_PATTERNS.some((re) => re.test(lower));
}

export function isSafeExternalHttpUrl(rawUrl: string): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;

  const host = parsed.hostname.toLowerCase();
  if (!host) return false;
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return false;
  }

  // Literal IPv4 / IPv6 checks
  const bareHost = host.replace(/^\[|\]$/g, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bareHost) || bareHost.includes(':')) {
    if (isPrivateOrReservedIp(bareHost)) return false;
  }

  return true;
}

export function isTopAnimesUrl(rawUrl: string): boolean {
  if (!isSafeExternalHttpUrl(rawUrl)) return false;
  try {
    const parsed = new URL(rawUrl.trim());
    return TOPANIMES_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function normalizeTopAnimesUrl(rawUrl: string, fallbackBase = 'https://topanimes.net'): string {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed === '#' || trimmed.startsWith('javascript:')) return '';
  try {
    const resolved = new URL(trimmed, fallbackBase);
    if (!isTopAnimesUrl(resolved.href)) return '';
    return resolved.href;
  } catch {
    return '';
  }
}

/**
 * Unwraps TopAnimes `/aviso/?url=<encoded>` wrappers and fixes missing `?` on `poster=` params
 * that TopAnimes sometimes embeds (e.g. `https://csst.online/embed/1095810&poster=...`).
 */
export function unwrapAvisoUrl(rawUrl: string, baseOrigin = 'https://topanimes.net'): string {
  if (!rawUrl || typeof rawUrl !== 'string' || rawUrl === 'about:blank') return '';
  let candidate = rawUrl.trim();

  try {
    const parsed = new URL(candidate, baseOrigin);
    if (TOPANIMES_HOSTS.has(parsed.hostname.toLowerCase()) && /^\/aviso\/?$/.test(parsed.pathname)) {
      const inner = parsed.searchParams.get('url');
      if (inner) {
        candidate = inner.trim();
      }
    }
  } catch {
    return '';
  }

  // Fix malformed `&poster=` or `&thumbnail=` when the embed URL path had no `?`
  try {
    const u = new URL(candidate);
    if (!u.search && u.pathname.includes('&')) {
      const [cleanPath] = u.pathname.split('&');
      u.pathname = cleanPath;
      candidate = u.href;
    }
  } catch {
    return '';
  }

  return isSafeExternalHttpUrl(candidate) ? candidate : '';
}
