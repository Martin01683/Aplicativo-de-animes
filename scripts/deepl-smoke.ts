/**
 * Manual smoke test for the DeepL web client (src/lib/deeplTranslate.ts).
 *
 *   npx tsx scripts/deepl-smoke.ts "Your English text here"
 *
 * Sends a single translation request straight from this machine (plain Node fetch, none of the
 * app's own server code in between) and prints every HTTP status along the way, so you can tell in
 * seconds whether DeepL accepts requests from your network. HTTP 429/403 means DeepL refused this
 * client or IP; the app then falls back to Google Translate on its own.
 */
import { translateTextsWithDeepl } from '../src/lib/deeplTranslate.ts';
import type { HttpFetcher } from '../src/lib/httpTypes.ts';

const text =
  process.argv.slice(2).join(' ').trim() ||
  'The heroes depart at sunrise to cross the northern mountains.';

const fetchHttp: HttpFetcher = async (url, options = {}) => {
  const method = options.method ?? 'GET';
  const target = new URL(url);
  const label = `${method} ${target.host}${target.pathname}`;
  const headers: Record<string, string> = { ...options.headers };
  if (options.contentType) headers['Content-Type'] = options.contentType;
  if (options.accept) headers.Accept = options.accept;

  const started = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: options.body,
      signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
    });
    const body = await res.text();
    console.log(`${label} -> HTTP ${res.status} (${Date.now() - started} ms)`);
    return { ok: res.ok, status: res.status, finalUrl: res.url, body };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.log(`${label} -> failed: ${reason}`);
    throw error;
  }
};

const result = await translateTextsWithDeepl(fetchHttp, [text], { sourceLang: 'en' });

if (result) {
  console.log(`\nDeepL OK\n  EN: ${text}\n  PT: ${result[0]}`);
} else {
  console.log(
    '\nDeepL did not translate (see the HTTP status above). The app would use Google Translate instead.',
  );
  process.exitCode = 1;
}
