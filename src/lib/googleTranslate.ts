import type { HttpFetcher } from './httpTypes.ts';

export const GOOGLE_TRANSLATE_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
export const GOOGLE_DICT_TRANSLATE_ENDPOINT = 'https://clients5.google.com/translate_a/t';

type GoogleTranslateEndpointKey = 'gtx' | 'dict';

const GOOGLE_ENDPOINT_REST_MS = 5 * 60 * 1000;
const googleEndpointRestingUntil = new Map<GoogleTranslateEndpointKey, number>();

export function resetGoogleTranslateState(): void {
  googleEndpointRestingUntil.clear();
}

export function isGoogleEndpointResting(
  endpoint: GoogleTranslateEndpointKey,
  nowMs = Date.now()
): boolean {
  const until = googleEndpointRestingUntil.get(endpoint) ?? 0;
  if (until > nowMs) return true;
  if (until > 0) googleEndpointRestingUntil.delete(endpoint);
  return false;
}

function markGoogleEndpointRateLimited(
  endpoint: GoogleTranslateEndpointKey,
  nowMs = Date.now()
): void {
  googleEndpointRestingUntil.set(endpoint, nowMs + GOOGLE_ENDPOINT_REST_MS);
}

/**
 * Parses JSON returned by `clients5.google.com/translate_a/t?client=dict-chrome-ex`.
 * Depending on whether `sl` is explicit (`en`/`ja`) or `auto`, each array element is either
 * a plain translated string or `[translatedText, detectedSourceLang]`.
 */
export function parseGoogleDictBatchResponse(
  rawJson: string,
  expectedCount: number
): string[] | null {
  if (!rawJson || !rawJson.trim() || expectedCount <= 0) return null;
  try {
    const parsed = JSON.parse(rawJson) as unknown;
    if (!Array.isArray(parsed)) return null;
    if (parsed.length !== expectedCount) return null;
    const out: string[] = [];
    for (const item of parsed) {
      let text = '';
      if (typeof item === 'string') {
        text = item;
      } else if (Array.isArray(item) && typeof item[0] === 'string') {
        text = item[0];
      }
      const trimmed = text.replace(/\r\n/g, '\n').trim();
      if (!trimmed) return null;
      out.push(trimmed);
    }
    return out;
  } catch {
    return null;
  }
}

async function translateTextsViaGoogleDict(
  fetchHttp: HttpFetcher,
  texts: string[],
  sourceLang: 'auto' | 'en' | 'ja',
  timeoutMs: number
): Promise<string[] | null> {
  if (texts.length === 0 || isGoogleEndpointResting('dict')) return null;
  const queryUrl = `${GOOGLE_DICT_TRANSLATE_ENDPOINT}?client=dict-chrome-ex&sl=${sourceLang}&tl=pt-BR`;
  const formBody = texts.map((text) => `q=${encodeURIComponent(text)}`).join('&');
  try {
    const res = await fetchHttp(queryUrl, {
      method: 'POST',
      contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
      body: formBody,
      accept: 'application/json, text/plain, */*',
      timeoutMs,
    });
    if (res.status === 429) {
      markGoogleEndpointRateLimited('dict');
      return null;
    }
    if (!res.ok) return null;
    return parseGoogleDictBatchResponse(res.body, texts.length);
  } catch {
    return null;
  }
}

export function cleanSynopsisWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Splits long text into translation-safe chunks (preserving paragraphs and sentences)
 * so Google Translate GET URLs stay well under URI length limits.
 */
export function splitTextForTranslation(text: string, maxChunkChars = 1400): string[] {
  const normalized = cleanSynopsisWhitespace(text);
  if (!normalized) return [];
  if (normalized.length <= maxChunkChars) return [normalized];

  const paragraphs = normalized.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = '';

  const flush = () => {
    if (current.trim()) {
      chunks.push(current.trim());
      current = '';
    }
  };

  for (const rawPara of paragraphs) {
    const para = rawPara.trim();
    if (!para) continue;

    if (para.length <= maxChunkChars) {
      if (!current) {
        current = para;
      } else if (current.length + 2 + para.length <= maxChunkChars) {
        current = `${current}\n\n${para}`;
      } else {
        flush();
        current = para;
      }
      continue;
    }

    // Split oversized paragraph by sentence boundaries
    flush();
    const sentences = para.split(/(?<=[.!?])\s+/);
    let sentenceBuf = '';
    for (const rawSentence of sentences) {
      const sentence = rawSentence.trim();
      if (!sentence) continue;
      if (sentence.length > maxChunkChars) {
        if (sentenceBuf) {
          chunks.push(sentenceBuf.trim());
          sentenceBuf = '';
        }
        for (let i = 0; i < sentence.length; i += maxChunkChars) {
          chunks.push(sentence.slice(i, i + maxChunkChars).trim());
        }
      } else if (!sentenceBuf) {
        sentenceBuf = sentence;
      } else if (sentenceBuf.length + 1 + sentence.length <= maxChunkChars) {
        sentenceBuf = `${sentenceBuf} ${sentence}`;
      } else {
        chunks.push(sentenceBuf.trim());
        sentenceBuf = sentence;
      }
    }
    if (sentenceBuf.trim()) {
      chunks.push(sentenceBuf.trim());
    }
  }

  flush();
  return chunks;
}

/**
 * Extracts raw translated text from Google Translate's `translate_a/single` JSON payload
 * while preserving exact line breaks (needed for multi-line batch alignment).
 */
export function parseGoogleTranslateRawResponse(rawJson: string): string {
  if (!rawJson || !rawJson.trim()) return '';
  try {
    const parsed = JSON.parse(rawJson) as unknown;
    if (!Array.isArray(parsed) || !Array.isArray(parsed[0])) return '';
    const segments: string[] = [];
    for (const item of parsed[0]) {
      if (Array.isArray(item) && typeof item[0] === 'string' && item[0].length > 0) {
        segments.push(item[0]);
      }
    }
    return segments.join('').replace(/\r\n/g, '\n');
  } catch {
    return '';
  }
}

/**
 * Extracts translated text from Google Translate's `translate_a/single` JSON payload.
 * Returns empty string on malformed or empty payloads.
 */
export function parseGoogleTranslateResponse(rawJson: string): string {
  const raw = parseGoogleTranslateRawResponse(rawJson);
  return raw ? cleanSynopsisWhitespace(raw) : '';
}

export function hasJapaneseKana(text: string): boolean {
  return /[\u3040-\u30ff]/.test(text);
}

export function hasCjkOrJapaneseScript(text: string): boolean {
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/.test(text);
}

/**
 * Cleans Japanese quotation/bracket wrappers (e.g. `「Seg 1」「Seg 2」`, `【逸脱】`)
 * and internal newlines so Google Translate produces natural, readable single-line titles.
 */
export function normalizeTitleForTranslation(raw: string): string {
  let text = raw
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!text) return '';

  // Convert adjacent Japanese segment quotes/brackets into a clean slash separator
  text = text
    .replace(/」\s*「/g, ' / ')
    .replace(/』\s*『/g, ' / ')
    .replace(/】\s*【/g, ' / ')
    .replace(/〕\s*〔/g, ' / ')
    .replace(/》\s*《/g, ' / ');

  const wrapperPairs: Array<[string, string]> = [
    ['「', '」'],
    ['『', '』'],
    ['【', '】'],
    ['〔', '〕'],
    ['《', '》'],
    ['[', ']'],
  ];
  for (const [open, close] of wrapperPairs) {
    if (text.startsWith(open) && text.endsWith(close) && text.length > 2) {
      const inner = text.slice(1, -1).trim();
      if (inner && !inner.includes(open) && !inner.includes(close)) {
        text = inner;
      }
    }
  }

  return text
    .replace(/\s*\/\s*/g, ' / ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function cleanTranslatedTitle(raw: string): string {
  let text = raw
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!text) return '';

  // Remove redundant outer quotes or brackets when wrapping the full title
  const wrapperPairs: Array<[string, string]> = [
    ['"', '"'],
    ['“', '”'],
    ['[', ']'],
    ['【', '】'],
    ['「', '」'],
    ['『', '』'],
  ];
  for (const [open, close] of wrapperPairs) {
    if (text.startsWith(open) && text.endsWith(close) && text.length > 2) {
      const inner = text.slice(1, -1).trim();
      if (inner && !inner.includes(open) && !inner.includes(close)) {
        text = inner;
      }
    }
  }

  text = text
    .replace(/\s*\/\s*/g, ' / ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // Capitalize a lowercase initial letter (e.g. Google Translate returning "desvio" for "【逸脱】")
  if (/^\p{Ll}/u.test(text)) {
    text = text.charAt(0).toLocaleUpperCase('pt-BR') + text.slice(1);
  }

  return text;
}

/**
 * Translates English text to Brazilian Portuguese via Google Translate,
 * failing over between `translate.googleapis.com/translate_a/single` (gtx) and
 * `clients5.google.com/translate_a/t` (dict-chrome-ex) with per-endpoint HTTP 429 cooldowns.
 * Returns `null` if both endpoints fail or yield empty output so callers keep original English.
 */
export async function translateEnglishToPtBr(
  fetchHttp: HttpFetcher,
  englishText: string
): Promise<string | null> {
  const chunks = splitTextForTranslation(englishText);
  if (chunks.length === 0) return null;

  const translatedChunks: string[] = [];
  for (const chunk of chunks) {
    let translated = '';

    if (!isGoogleEndpointResting('gtx')) {
      const queryUrl =
        `${GOOGLE_TRANSLATE_ENDPOINT}?client=gtx&sl=en&tl=pt-BR&dt=t&q=${encodeURIComponent(chunk)}`;
      try {
        const res = await fetchHttp(queryUrl, {
          accept: 'application/json, text/plain, */*',
          timeoutMs: 6000,
        });
        if (res.status === 429) {
          markGoogleEndpointRateLimited('gtx');
        } else if (res.ok) {
          translated = parseGoogleTranslateResponse(res.body);
        }
      } catch {
        // Fall through to secondary Google endpoint
      }
    }

    if (!translated) {
      const viaDict = await translateTextsViaGoogleDict(fetchHttp, [chunk], 'en', 6000);
      if (viaDict?.[0]) {
        translated = cleanSynopsisWhitespace(viaDict[0]);
      }
    }

    if (!translated) return null;
    translatedChunks.push(translated);
  }

  const joined = cleanSynopsisWhitespace(translatedChunks.join('\n\n'));
  return joined || null;
}

const TITLE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const TITLE_CACHE_MAX_ENTRIES = 1500;
const TITLE_CACHE_STORAGE_KEY = 'anisync:title_translations:v1';
const TITLE_CACHE_PERSIST_MAX_ENTRIES = 400;
const TITLE_CACHE_PERSIST_DEBOUNCE_MS = 400;

const titleTranslationCache = new Map<string, { value: string; expiresAt: number }>();
let titleCacheHydratedFromStorage = false;
let titleCachePersistTimer: ReturnType<typeof setTimeout> | null = null;

function hydrateTitleCacheFromStorage(): void {
  if (titleCacheHydratedFromStorage) return;
  titleCacheHydratedFromStorage = true;
  if (typeof localStorage === 'undefined') return;
  try {
    const raw = localStorage.getItem(TITLE_CACHE_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const now = Date.now();
    for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (!key || !entry || typeof entry !== 'object') continue;
      const val = (entry as { v?: unknown }).v;
      const exp = (entry as { e?: unknown }).e;
      if (typeof val === 'string' && val && typeof exp === 'number' && exp > now) {
        if (!titleTranslationCache.has(key)) {
          titleTranslationCache.set(key, { value: val, expiresAt: exp });
        }
      }
    }
  } catch {
    // Ignore malformed persisted translation cache
  }
}

function flushTitleCacheToStorageNow(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const now = Date.now();
    const validEntries: Array<[string, { v: string; e: number }]> = [];
    for (const [key, entry] of titleTranslationCache.entries()) {
      if (entry.expiresAt > now) {
        validEntries.push([key, { v: entry.value, e: entry.expiresAt }]);
      }
    }
    const recent = validEntries.slice(-TITLE_CACHE_PERSIST_MAX_ENTRIES);
    if (recent.length === 0) {
      localStorage.removeItem(TITLE_CACHE_STORAGE_KEY);
      return;
    }
    const serialized: Record<string, { v: string; e: number }> = {};
    for (const [k, v] of recent) {
      serialized[k] = v;
    }
    localStorage.setItem(TITLE_CACHE_STORAGE_KEY, JSON.stringify(serialized));
  } catch {
    // Ignore storage quota errors
  }
}

function scheduleTitleCachePersist(): void {
  if (typeof localStorage === 'undefined') return;
  if (titleCachePersistTimer !== null) {
    clearTimeout(titleCachePersistTimer);
  }
  titleCachePersistTimer = setTimeout(() => {
    titleCachePersistTimer = null;
    flushTitleCacheToStorageNow();
  }, TITLE_CACHE_PERSIST_DEBOUNCE_MS);
}

export function clearTitleTranslationCache(): void {
  titleTranslationCache.clear();
  googleEndpointRestingUntil.clear();
  titleCacheHydratedFromStorage = false;
  if (titleCachePersistTimer !== null) {
    clearTimeout(titleCachePersistTimer);
    titleCachePersistTimer = null;
  }
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(TITLE_CACHE_STORAGE_KEY);
    } catch {
      // Ignore storage errors
    }
  }
}

export function readTitleCache(key: string): string | null {
  hydrateTitleCacheFromStorage();
  const hit = titleTranslationCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    titleTranslationCache.delete(key);
    return null;
  }
  // Refresh LRU recency order
  titleTranslationCache.delete(key);
  titleTranslationCache.set(key, hit);
  return hit.value;
}

export function writeTitleCache(key: string, value: string): void {
  if (!key || !value) return;
  hydrateTitleCacheFromStorage();
  if (titleTranslationCache.has(key)) {
    titleTranslationCache.delete(key);
  } else if (titleTranslationCache.size >= TITLE_CACHE_MAX_ENTRIES) {
    const oldest = titleTranslationCache.keys().next().value;
    if (oldest) titleTranslationCache.delete(oldest);
  }
  titleTranslationCache.set(key, {
    value,
    expiresAt: Date.now() + TITLE_CACHE_TTL_MS,
  });
  scheduleTitleCachePersist();
}

/**
 * Translates a single short text (such as an episode title) from `sourceLang` (`en`, `ja`, or `auto`)
 * into Brazilian Portuguese via Google Translate (with gtx -> dict-chrome-ex failover),
 * reusing the shared persistent title translation cache.
 */
export async function translateTextToPtBr(
  fetchHttp: HttpFetcher,
  rawText: string,
  sourceLang: 'auto' | 'en' | 'ja' = 'auto',
  timeoutMs = 5000,
  useCache = true
): Promise<string | null> {
  const raw = rawText.trim();
  if (!raw) return null;
  const normalized = normalizeTitleForTranslation(raw);
  if (!normalized) return null;

  if (useCache) {
    const cached = readTitleCache(raw) || readTitleCache(normalized);
    if (cached) return cached;
  }

  const resolvedSourceLang =
    sourceLang === 'auto' && hasJapaneseKana(normalized) ? 'ja' : sourceLang;
  let translated = '';

  if (!isGoogleEndpointResting('gtx')) {
    const queryUrl =
      `${GOOGLE_TRANSLATE_ENDPOINT}?client=gtx&sl=${resolvedSourceLang}&tl=pt-BR&dt=t&q=${encodeURIComponent(normalized)}`;
    try {
      const res = await fetchHttp(queryUrl, {
        accept: 'application/json, text/plain, */*',
        timeoutMs,
      });
      if (res.status === 429) {
        markGoogleEndpointRateLimited('gtx');
      } else if (res.ok) {
        translated = cleanTranslatedTitle(parseGoogleTranslateResponse(res.body));
      }
    } catch {
      // Fall through to secondary Google endpoint
    }
  }

  if (!translated) {
    const viaDict = await translateTextsViaGoogleDict(
      fetchHttp,
      [normalized],
      resolvedSourceLang,
      timeoutMs
    );
    if (viaDict?.[0]) {
      translated = cleanTranslatedTitle(viaDict[0]);
    }
  }

  if (!translated) return null;
  if (useCache) {
    writeTitleCache(raw, translated);
    if (normalized !== raw) writeTitleCache(normalized, translated);
  }
  return translated;
}

export interface TitleBatchItem {
  raw: string;
  normalized: string;
}

function buildTitleBatches(
  items: TitleBatchItem[],
  maxItemsPerBatch = 20,
  maxCharsPerBatch = 1050
): TitleBatchItem[][] {
  const batches: TitleBatchItem[][] = [];
  let current: TitleBatchItem[] = [];
  let currentLen = 0;

  for (const item of items) {
    const addLen = (current.length > 0 ? 1 : 0) + item.normalized.length;
    if (
      current.length > 0 &&
      (current.length >= maxItemsPerBatch || currentLen + addLen > maxCharsPerBatch)
    ) {
      batches.push(current);
      current = [item];
      currentLen = item.normalized.length;
    } else {
      current.push(item);
      currentLen += addLen;
    }
  }

  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

export interface TitleBatchJob {
  /** Source-language hint for the engine: `ja` for kana titles, `auto` for everything else. */
  sl: 'ja' | 'auto';
  batch: TitleBatchItem[];
}

/** Maximum number of title batches translated concurrently. */
export const TITLE_BATCH_CONCURRENCY = 3;

/**
 * Engine-agnostic preparation for batch title translation: dedupes titles, skips placeholders
 * (`TBA`, `TBD`, bare numbers), serves cache hits straight into `result`, normalizes the rest,
 * limits very long series to their first/last `maxTitles`, and groups titles by script
 * (`ja` vs CJK vs Latin) so mixed payloads never confuse language detection.
 * `jobs` is empty when nothing is left to translate.
 */
export function prepareTitleBatchJobs(
  rawTitles: string[],
  options: { useCache?: boolean; maxTitles?: number } = {}
): { result: Map<string, string>; jobs: TitleBatchJob[] } {
  const useCache = options.useCache !== false;
  const maxTitles = options.maxTitles ?? 120;
  const result = new Map<string, string>();
  const pendingUnique: TitleBatchItem[] = [];
  const seenRaw = new Set<string>();

  for (const rawTitle of rawTitles) {
    const raw = rawTitle.trim();
    if (!raw || seenRaw.has(raw)) continue;
    seenRaw.add(raw);

    if (/^(?:tba|tbd|\d+)$/i.test(raw)) continue;

    if (useCache) {
      const cached = readTitleCache(raw);
      if (cached) {
        result.set(raw, cached);
        continue;
      }
    }

    const normalized = normalizeTitleForTranslation(raw);
    if (!normalized) continue;
    pendingUnique.push({ raw, normalized });
  }

  if (pendingUnique.length === 0) return { result, jobs: [] };

  // For massive multi-hundred-episode series, cover both the beginning and latest episodes
  let scopedPending = pendingUnique;
  if (scopedPending.length > maxTitles) {
    const half = Math.floor(maxTitles / 2);
    scopedPending = [
      ...scopedPending.slice(0, half),
      ...scopedPending.slice(scopedPending.length - (maxTitles - half)),
    ];
  }

  // Separate Japanese/CJK from Latin scripts so the engine doesn't misdetect mixed payloads
  const jaItems: TitleBatchItem[] = [];
  const cjkItems: TitleBatchItem[] = [];
  const latinItems: TitleBatchItem[] = [];
  for (const item of scopedPending) {
    if (hasJapaneseKana(item.normalized)) {
      jaItems.push(item);
    } else if (hasCjkOrJapaneseScript(item.normalized)) {
      cjkItems.push(item);
    } else {
      latinItems.push(item);
    }
  }

  const jobs: TitleBatchJob[] = [
    ...buildTitleBatches(jaItems).map((batch) => ({ sl: 'ja' as const, batch })),
    ...buildTitleBatches(cjkItems).map((batch) => ({ sl: 'auto' as const, batch })),
    ...buildTitleBatches(latinItems).map((batch) => ({ sl: 'auto' as const, batch })),
  ];
  return { result, jobs };
}

/**
 * Translates one title batch through Google Translate: tries `gtx` (newline-joined with strict
 * 1-to-1 line alignment validation) and falls back to `clients5.google.com/translate_a/t`
 * (positional multi-`q` POST where each title maps 1-to-1 without newline merges), writing
 * results into `result` and the shared persistent cache.
 */
export async function runGoogleTitleBatchJob(
  fetchHttp: HttpFetcher,
  job: TitleBatchJob,
  result: Map<string, string>,
  options: { useCache: boolean; timeoutMs: number }
): Promise<void> {
  const { useCache, timeoutMs } = options;
  let gtxHandled = false;

  if (!isGoogleEndpointResting('gtx')) {
    const joined = job.batch.map((item) => item.normalized).join('\n');
    const queryUrl =
      `${GOOGLE_TRANSLATE_ENDPOINT}?client=gtx&sl=${job.sl}&tl=pt-BR&dt=t&q=${encodeURIComponent(joined)}`;
    try {
      const res = await fetchHttp(queryUrl, {
        accept: 'application/json, text/plain, */*',
        timeoutMs,
      });
      if (res.status === 429) {
        markGoogleEndpointRateLimited('gtx');
      } else if (res.ok) {
        const rawTranslated = parseGoogleTranslateRawResponse(res.body);
        if (rawTranslated) {
          const lines = rawTranslated
            .split('\n')
            .map((line) => cleanTranslatedTitle(line))
            .filter((line) => line.length > 0);

          if (lines.length === job.batch.length) {
            for (let i = 0; i < job.batch.length; i++) {
              const translated = lines[i];
              if (!translated) continue;
              result.set(job.batch[i].raw, translated);
              if (useCache) writeTitleCache(job.batch[i].raw, translated);
            }
            gtxHandled = true;
          }
        }
      }
    } catch {
      // Fall through to secondary endpoint
    }
  }

  if (gtxHandled) return;

  // Secondary endpoint: positional multi-q POST (exact 1-to-1 alignment, immune to newline merging)
  const viaDict = await translateTextsViaGoogleDict(
    fetchHttp,
    job.batch.map((item) => item.normalized),
    job.sl,
    timeoutMs
  );
  if (viaDict && viaDict.length === job.batch.length) {
    let anyStored = false;
    for (let i = 0; i < job.batch.length; i++) {
      const translated = cleanTranslatedTitle(viaDict[i]);
      if (!translated) continue;
      result.set(job.batch[i].raw, translated);
      if (useCache) writeTitleCache(job.batch[i].raw, translated);
      anyStored = true;
    }
    if (anyStored) return;
  }

  // Alignment mismatch safety fallback: translate individually for small batches
  if (job.batch.length > 1 && job.batch.length <= 12) {
    const CONCURRENCY = 4;
    for (let idx = 0; idx < job.batch.length; idx += CONCURRENCY) {
      const slice = job.batch.slice(idx, idx + CONCURRENCY);
      await Promise.all(
        slice.map(async (item) => {
          const single = await translateTextToPtBr(fetchHttp, item.raw, job.sl, timeoutMs, useCache);
          if (single) {
            result.set(item.raw, single);
            if (useCache) writeTitleCache(item.raw, single);
          }
        })
      );
    }
  }
}

/**
 * Batch-translates episode titles into PT-BR via Google Translate while keeping scripts separated
 * (`ja` vs `cjk` vs `auto`/Latin), validating 1-to-1 line alignment, and caching results in memory.
 * Never throws: any failed batch gracefully omits its entries so callers keep original titles.
 */
export async function translateTitlesBatchToPtBr(
  fetchHttp: HttpFetcher,
  rawTitles: string[],
  options: { useCache?: boolean; maxTitles?: number; timeoutMs?: number } = {}
): Promise<Map<string, string>> {
  const useCache = options.useCache !== false;
  const timeoutMs = options.timeoutMs ?? 5000;
  const { result, jobs } = prepareTitleBatchJobs(rawTitles, options);

  // Run a few batches concurrently for fast page enrichment
  for (let i = 0; i < jobs.length; i += TITLE_BATCH_CONCURRENCY) {
    await Promise.all(
      jobs
        .slice(i, i + TITLE_BATCH_CONCURRENCY)
        .map((job) => runGoogleTitleBatchJob(fetchHttp, job, result, { useCache, timeoutMs }))
    );
  }

  return result;
}
