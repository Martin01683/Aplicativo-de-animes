import type { HttpFetcher } from './httpTypes.ts';

const GOOGLE_TRANSLATE_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';

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
 * Cleans Japanese quotation wrappers (e.g. `「Seg 1」「Seg 2」`) and internal newlines
 * so Google Translate produces natural, readable single-line titles.
 */
export function normalizeTitleForTranslation(raw: string): string {
  let text = raw
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!text) return '';

  // Convert adjacent Japanese segment quotes into a clean slash separator
  text = text
    .replace(/」\s*「/g, ' / ')
    .replace(/』\s*『/g, ' / ');

  // Strip wrapping Japanese corner brackets when they enclose the full string
  if ((text.startsWith('「') && text.endsWith('」')) || (text.startsWith('『') && text.endsWith('』'))) {
    text = text.slice(1, -1).trim();
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

  // Remove redundant outer double-quotes only when wrapping the whole title with no inner quotes
  if (
    ((text.startsWith('"') && text.endsWith('"')) ||
      (text.startsWith('“') && text.endsWith('”'))) &&
    text.length > 2
  ) {
    const inner = text.slice(1, -1).trim();
    if (inner && !/[“”"]/.test(inner)) {
      text = inner;
    }
  }

  return text
    .replace(/\s*\/\s*/g, ' / ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Translates English text to Brazilian Portuguese via Google Translate.
 * Returns `null` if any request fails or yields an empty translation so callers
 * can safely fall back to the original English text.
 */
export async function translateEnglishToPtBr(
  fetchHttp: HttpFetcher,
  englishText: string
): Promise<string | null> {
  const chunks = splitTextForTranslation(englishText);
  if (chunks.length === 0) return null;

  const translatedChunks: string[] = [];
  for (const chunk of chunks) {
    const queryUrl =
      `${GOOGLE_TRANSLATE_ENDPOINT}?client=gtx&sl=en&tl=pt-BR&dt=t&q=${encodeURIComponent(chunk)}`;
    try {
      const res = await fetchHttp(queryUrl, {
        accept: 'application/json, text/plain, */*',
        timeoutMs: 6000,
      });
      if (!res.ok) return null;
      const translated = parseGoogleTranslateResponse(res.body);
      if (!translated) return null;
      translatedChunks.push(translated);
    } catch {
      return null;
    }
  }

  const joined = cleanSynopsisWhitespace(translatedChunks.join('\n\n'));
  return joined || null;
}

/**
 * Translates a single short text (such as an episode title) from `sourceLang` (`en`, `ja`, or `auto`)
 * into Brazilian Portuguese via Google Translate.
 */
export async function translateTextToPtBr(
  fetchHttp: HttpFetcher,
  rawText: string,
  sourceLang: 'auto' | 'en' | 'ja' = 'auto',
  timeoutMs = 5000
): Promise<string | null> {
  const normalized = normalizeTitleForTranslation(rawText);
  if (!normalized) return null;

  const resolvedSourceLang =
    sourceLang === 'auto' && hasJapaneseKana(normalized) ? 'ja' : sourceLang;
  const queryUrl =
    `${GOOGLE_TRANSLATE_ENDPOINT}?client=gtx&sl=${resolvedSourceLang}&tl=pt-BR&dt=t&q=${encodeURIComponent(normalized)}`;
  try {
    const res = await fetchHttp(queryUrl, {
      accept: 'application/json, text/plain, */*',
      timeoutMs,
    });
    if (!res.ok) return null;
    const translated = cleanTranslatedTitle(parseGoogleTranslateResponse(res.body));
    return translated || null;
  } catch {
    return null;
  }
}

const TITLE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const TITLE_CACHE_MAX_ENTRIES = 1500;
const titleTranslationCache = new Map<string, { value: string; expiresAt: number }>();

export function clearTitleTranslationCache(): void {
  titleTranslationCache.clear();
}

function readTitleCache(key: string): string | null {
  const hit = titleTranslationCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    titleTranslationCache.delete(key);
    return null;
  }
  return hit.value;
}

function writeTitleCache(key: string, value: string): void {
  if (!key || !value) return;
  if (titleTranslationCache.size >= TITLE_CACHE_MAX_ENTRIES) {
    const oldest = titleTranslationCache.keys().next().value;
    if (oldest) titleTranslationCache.delete(oldest);
  }
  titleTranslationCache.set(key, {
    value,
    expiresAt: Date.now() + TITLE_CACHE_TTL_MS,
  });
}

interface TitleBatchItem {
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
  const maxTitles = options.maxTitles ?? 120;
  const timeoutMs = options.timeoutMs ?? 5000;
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

  if (pendingUnique.length === 0) return result;

  // For massive multi-hundred-episode series, cover both the beginning and latest episodes
  let scopedPending = pendingUnique;
  if (scopedPending.length > maxTitles) {
    const half = Math.floor(maxTitles / 2);
    scopedPending = [
      ...scopedPending.slice(0, half),
      ...scopedPending.slice(scopedPending.length - (maxTitles - half)),
    ];
  }

  // Separate Japanese/CJK from Latin scripts so Google Translate doesn't misdetect mixed payloads
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

  const jobs: Array<{ sl: 'ja' | 'auto'; batch: TitleBatchItem[] }> = [
    ...buildTitleBatches(jaItems).map((batch) => ({ sl: 'ja' as const, batch })),
    ...buildTitleBatches(cjkItems).map((batch) => ({ sl: 'auto' as const, batch })),
    ...buildTitleBatches(latinItems).map((batch) => ({ sl: 'auto' as const, batch })),
  ];

  const runBatchJob = async (job: { sl: 'ja' | 'auto'; batch: TitleBatchItem[] }): Promise<void> => {
    const joined = job.batch.map((item) => item.normalized).join('\n');
    const queryUrl =
      `${GOOGLE_TRANSLATE_ENDPOINT}?client=gtx&sl=${job.sl}&tl=pt-BR&dt=t&q=${encodeURIComponent(joined)}`;
    try {
      const res = await fetchHttp(queryUrl, {
        accept: 'application/json, text/plain, */*',
        timeoutMs,
      });
      if (!res.ok) return;

      const rawTranslated = parseGoogleTranslateRawResponse(res.body);
      if (!rawTranslated) return;

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
        return;
      }

      // Alignment mismatch safety fallback: translate individually for small batches
      if (job.batch.length > 1 && job.batch.length <= 12) {
        const CONCURRENCY = 4;
        for (let idx = 0; idx < job.batch.length; idx += CONCURRENCY) {
          const slice = job.batch.slice(idx, idx + CONCURRENCY);
          await Promise.all(
            slice.map(async (item) => {
              const single = await translateTextToPtBr(fetchHttp, item.raw, job.sl, timeoutMs);
              if (single) {
                result.set(item.raw, single);
                if (useCache) writeTitleCache(item.raw, single);
              }
            })
          );
        }
      }
    } catch {
      // Non-fatal: caller preserves original episode titles
    }
  };

  // Run up to 3 batches concurrently for fast page enrichment
  const MAX_CONCURRENT_BATCHES = 3;
  for (let i = 0; i < jobs.length; i += MAX_CONCURRENT_BATCHES) {
    await Promise.all(jobs.slice(i, i + MAX_CONCURRENT_BATCHES).map(runBatchJob));
  }

  return result;
}

