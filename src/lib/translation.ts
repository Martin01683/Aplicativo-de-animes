import {
  DEEPL_DEFAULT_TIMEOUT_MS,
  isDeeplTranslatorAvailable,
  translateTextsWithDeepl,
  type DeeplSourceLang,
} from './deeplTranslate.ts';
import {
  cleanSynopsisWhitespace,
  cleanTranslatedTitle,
  hasCjkOrJapaneseScript,
  hasJapaneseKana,
  normalizeTitleForTranslation,
  prepareTitleBatchJobs,
  readTitleCache,
  runGoogleTitleBatchJob,
  splitTextForTranslation,
  TITLE_BATCH_CONCURRENCY,
  translateEnglishToPtBr,
  translateTextToPtBr,
  writeTitleCache,
  type TitleBatchItem,
  type TitleBatchJob,
} from './googleTranslate.ts';
import type { HttpFetcher } from './httpTypes.ts';
import type { EpisodeSynopsisSource } from './types.ts';

/**
 * Machine-translation chain used after TheTVDB has no native PT-BR text:
 *
 *   TheTVDB PT-BR  >  DeepL (web endpoint, no API key)  >  Google Translate  >  original text
 *
 * The first step lives in the TheTVDB provider; this module owns the middle two. Every function
 * resolves with `null` / an omitted entry when neither engine produced a translation, so callers
 * can keep the original (English) text as the last resort.
 */

export type TranslationEngine = 'deepl' | 'google';

export interface TranslatedText {
  text: string;
  engine: TranslationEngine;
}

/** Maps the engine that translated a synopsis to the source tag the UI shows. */
export function synopsisSourceForEngine(engine: TranslationEngine): EpisodeSynopsisSource {
  return engine === 'deepl' ? 'thetvdb-deepl' : 'thetvdb-google-translate';
}

/** Synopsis chunk size per DeepL request, comfortably below its 1500-unit anonymous cap. */
const DEEPL_SYNOPSIS_CHUNK_CHARS = 1400;

/** Shorter than this, an unchanged answer is plausibly legitimate (a name, an interjection). */
const MIN_UNTRANSLATED_ECHO_CHARS = 40;

// ---------------------------------------------------------------------------------------------
// Synopses (long English text)
// ---------------------------------------------------------------------------------------------

async function translateSynopsisWithDeepl(
  fetchHttp: HttpFetcher,
  englishText: string,
): Promise<string | null> {
  if (!isDeeplTranslatorAvailable()) return null;

  const chunks = splitTextForTranslation(englishText, DEEPL_SYNOPSIS_CHUNK_CHARS);
  if (chunks.length === 0) return null;

  const translatedChunks: string[] = [];
  for (const chunk of chunks) {
    // Paragraphs travel as separate array entries so the answer keeps its paragraph breaks.
    const paragraphs = chunk
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean);
    const translated = await translateTextsWithDeepl(fetchHttp, paragraphs, { sourceLang: 'en' });
    // All-or-nothing: if any chunk fails, Google translates the whole synopsis so it keeps a
    // single, consistent voice.
    if (!translated) return null;

    const joined = translated.join('\n\n');
    const echoed =
      cleanSynopsisWhitespace(chunk).length >= MIN_UNTRANSLATED_ECHO_CHARS &&
      cleanSynopsisWhitespace(joined) === cleanSynopsisWhitespace(chunk);
    if (echoed) return null; // DeepL handed the English text back untouched

    translatedChunks.push(joined);
  }

  return cleanSynopsisWhitespace(translatedChunks.join('\n\n')) || null;
}

/**
 * Translates an English synopsis to PT-BR: DeepL first, then Google Translate.
 * Returns the text together with the engine that produced it, or `null` if both failed.
 */
export async function translateSynopsisToPtBr(
  fetchHttp: HttpFetcher,
  englishText: string,
): Promise<TranslatedText | null> {
  const viaDeepl = await translateSynopsisWithDeepl(fetchHttp, englishText);
  if (viaDeepl) return { text: viaDeepl, engine: 'deepl' };

  const viaGoogle = await translateEnglishToPtBr(fetchHttp, englishText);
  return viaGoogle ? { text: viaGoogle, engine: 'google' } : null;
}

// ---------------------------------------------------------------------------------------------
// Titles (short text, often Japanese)
// ---------------------------------------------------------------------------------------------

/** Cleans a DeepL title and rejects answers that are unusable or visibly untranslated. */
function acceptDeeplTitle(source: string, output: string | undefined): string | null {
  if (!output) return null;
  const cleaned = cleanTranslatedTitle(output);
  if (!cleaned) return null;
  // CJK text that comes back unchanged was not translated: let Google have a go instead.
  if (hasCjkOrJapaneseScript(source) && cleaned === source.trim()) return null;
  return cleaned;
}

/**
 * Translates one short text (an episode title) to PT-BR: DeepL first, then Google Translate.
 * Shares the title cache with the Google-only helpers, whatever engine produced the entry.
 */
export async function translateTitleToPtBr(
  fetchHttp: HttpFetcher,
  rawText: string,
  sourceLang: 'auto' | 'en' | 'ja' = 'auto',
  timeoutMs = 5000,
  useCache = true,
): Promise<string | null> {
  const raw = rawText.trim();
  if (!raw) return null;
  const normalized = normalizeTitleForTranslation(raw);
  if (!normalized) return null;

  if (useCache) {
    const cached = readTitleCache(raw) || readTitleCache(normalized);
    if (cached) return cached;
  }

  if (isDeeplTranslatorAvailable()) {
    const resolvedSource: DeeplSourceLang =
      sourceLang === 'auto' && hasJapaneseKana(normalized) ? 'ja' : sourceLang;
    const translated = await translateTextsWithDeepl(fetchHttp, [normalized], {
      sourceLang: resolvedSource,
      timeoutMs: Math.min(timeoutMs, DEEPL_DEFAULT_TIMEOUT_MS),
    });
    const title = acceptDeeplTitle(normalized, translated?.[0]);
    if (title) {
      if (useCache) {
        writeTitleCache(raw, title);
        if (normalized !== raw) writeTitleCache(normalized, title);
      }
      return title;
    }
  }

  return translateTextToPtBr(fetchHttp, rawText, sourceLang, timeoutMs, useCache);
}

/** One batch job: DeepL for the whole batch, then Google for whatever DeepL did not resolve. */
async function translateTitleJobWithFallback(
  fetchHttp: HttpFetcher,
  job: TitleBatchJob,
  result: Map<string, string>,
  options: { useCache: boolean; timeoutMs: number },
): Promise<void> {
  let unresolved: TitleBatchItem[] = job.batch;

  if (isDeeplTranslatorAvailable()) {
    const translated = await translateTextsWithDeepl(
      fetchHttp,
      job.batch.map((item) => item.normalized),
      { sourceLang: job.sl, timeoutMs: Math.min(options.timeoutMs, DEEPL_DEFAULT_TIMEOUT_MS) },
    );
    if (translated && translated.length === job.batch.length) {
      unresolved = [];
      job.batch.forEach((item, index) => {
        const title = acceptDeeplTitle(item.normalized, translated[index]);
        if (title) {
          result.set(item.raw, title);
          if (options.useCache) writeTitleCache(item.raw, title);
        } else {
          unresolved.push(item);
        }
      });
    }
  }

  if (unresolved.length > 0) {
    await runGoogleTitleBatchJob(fetchHttp, { sl: job.sl, batch: unresolved }, result, options);
  }
}

/**
 * Batch-translates episode titles to PT-BR: each batch goes to DeepL first (positional array in,
 * array out) and anything DeepL could not resolve is retried through Google Translate.
 * Never throws; titles neither engine could translate are simply left out of the map.
 */
export async function translateTitlesBatchWithFallback(
  fetchHttp: HttpFetcher,
  rawTitles: string[],
  options: { useCache?: boolean; maxTitles?: number; timeoutMs?: number } = {},
): Promise<Map<string, string>> {
  const useCache = options.useCache !== false;
  const timeoutMs = options.timeoutMs ?? 5000;
  const { result, jobs } = prepareTitleBatchJobs(rawTitles, options);

  for (let i = 0; i < jobs.length; i += TITLE_BATCH_CONCURRENCY) {
    await Promise.all(
      jobs
        .slice(i, i + TITLE_BATCH_CONCURRENCY)
        .map((job) =>
          translateTitleJobWithFallback(fetchHttp, job, result, { useCache, timeoutMs }),
        ),
    );
  }

  return result;
}
