import type {
  CatalogSourceCredentials,
  EpisodeSynopsisResult,
} from './types.ts';
import type { CanonicalMediaType } from './catalog/idCodec.ts';
import type { HttpFetcher } from './httpTypes.ts';
import { fetchTheTvdbEpisodeTranslations } from './catalog/providers/thetvdbProvider.ts';

const GOOGLE_TRANSLATE_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
const SYNOPSIS_CACHE_TTL_MS = 30 * 60 * 1000;
const SYNOPSIS_CACHE_MAX_ENTRIES = 250;

interface CachedSynopsisEntry {
  expiresAt: number;
  value: EpisodeSynopsisResult | null;
}

const synopsisCache = new Map<string, CachedSynopsisEntry>();

export function clearEpisodeSynopsisCache(): void {
  synopsisCache.clear();
}

function cleanWhitespace(text: string): string {
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
  const normalized = cleanWhitespace(text);
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
 * Extracts translated text from Google Translate's `translate_a/single` JSON payload.
 * Returns empty string on malformed or empty payloads.
 */
export function parseGoogleTranslateResponse(rawJson: string): string {
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
    return cleanWhitespace(segments.join(''));
  } catch {
    return '';
  }
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

  const joined = cleanWhitespace(translatedChunks.join('\n\n'));
  return joined || null;
}

export interface ResolveEpisodeSynopsisInput {
  title?: string;
  originalTitle?: string;
  alternativeTitles?: string[];
  year?: string;
  mediaType?: CanonicalMediaType;
  seasonNumber?: number;
  episodeNumber?: number;
  tvdbId?: number;
  tvdbSlug?: string;
  tvdbEpisodeId?: number;
  fallbackEnglishOverview?: string;
  credentials?: CatalogSourceCredentials;
  useCache?: boolean;
}

function buildSynopsisCacheKey(input: ResolveEpisodeSynopsisInput): string {
  if (input.tvdbEpisodeId && input.tvdbEpisodeId > 0) {
    return `tvdb-ep:${input.tvdbEpisodeId}`;
  }
  const seriesKey =
    (input.tvdbId && input.tvdbId > 0 ? `id:${input.tvdbId}` : '') ||
    (input.tvdbSlug ? `slug:${input.tvdbSlug.toLowerCase()}` : '') ||
    `title:${(input.title || input.originalTitle || '').trim().toLowerCase()}`;
  const s = input.seasonNumber && input.seasonNumber > 0 ? input.seasonNumber : 1;
  const e = input.episodeNumber && input.episodeNumber > 0 ? input.episodeNumber : 0;
  return `${seriesKey}|s${s}e${e}`;
}

function writeSynopsisCache(key: string, value: EpisodeSynopsisResult | null): void {
  if (synopsisCache.size >= SYNOPSIS_CACHE_MAX_ENTRIES) {
    const oldestKey = synopsisCache.keys().next().value;
    if (oldestKey) synopsisCache.delete(oldestKey);
  }
  synopsisCache.set(key, {
    expiresAt: Date.now() + SYNOPSIS_CACHE_TTL_MS,
    value,
  });
}

/**
 * Resolves the episode synopsis from TheTVDB.com following strict localization priority:
 * 1. Native PT-BR synopsis from TheTVDB.com (`data-language="pt"` / v4 `/translations/pt`)
 * 2. English synopsis from TheTVDB.com translated to PT-BR via Google Translate
 * 3. Original English synopsis from TheTVDB.com if Google Translate fails
 */
export async function resolveLocalizedEpisodeSynopsis(
  fetchHttp: HttpFetcher,
  input: ResolveEpisodeSynopsisInput
): Promise<EpisodeSynopsisResult | null> {
  if (input.mediaType === 'movie') return null;

  const useCache = input.useCache !== false;
  const cacheKey = buildSynopsisCacheKey(input);
  if (useCache) {
    const hit = synopsisCache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) {
      return hit.value;
    }
  }

  const translations = await fetchTheTvdbEpisodeTranslations(fetchHttp, {
    title: input.title,
    originalTitle: input.originalTitle,
    alternativeTitles: input.alternativeTitles,
    year: input.year,
    mediaType: input.mediaType || 'anime',
    seasonNumber: input.seasonNumber,
    episodeNumber: input.episodeNumber,
    tvdbId: input.tvdbId,
    tvdbSlug: input.tvdbSlug,
    tvdbEpisodeId: input.tvdbEpisodeId,
    fallbackEnglishOverview: input.fallbackEnglishOverview,
    credentials: input.credentials,
  });

  if (!translations) {
    if (useCache) writeSynopsisCache(cacheKey, null);
    return null;
  }

  // 1. Native PT-BR synopsis from TheTVDB.com
  const ptBr = cleanWhitespace(translations.ptBrOverview || '');
  if (ptBr) {
    const result: EpisodeSynopsisResult = {
      synopsis: ptBr,
      language: 'pt-BR',
      source: 'thetvdb-pt-br',
      episodeTitle: translations.ptBrTitle || translations.engTitle,
      tvdbEpisodeId: translations.tvdbEpisodeId,
      tvdbSeriesId: translations.tvdbSeriesId,
    };
    if (useCache) writeSynopsisCache(cacheKey, result);
    return result;
  }

  // 2. English synopsis from TheTVDB.com -> translate via Google Translate
  const eng = cleanWhitespace(translations.engOverview || '');
  if (!eng) {
    if (useCache) writeSynopsisCache(cacheKey, null);
    return null;
  }

  const translatedPtBr = await translateEnglishToPtBr(fetchHttp, eng);
  if (translatedPtBr) {
    const result: EpisodeSynopsisResult = {
      synopsis: translatedPtBr,
      language: 'pt-BR',
      source: 'thetvdb-google-translate',
      episodeTitle: translations.ptBrTitle || translations.engTitle,
      tvdbEpisodeId: translations.tvdbEpisodeId,
      tvdbSeriesId: translations.tvdbSeriesId,
    };
    if (useCache) writeSynopsisCache(cacheKey, result);
    return result;
  }

  // 3. Fallback to original English synopsis if Google Translate failed
  const fallbackResult: EpisodeSynopsisResult = {
    synopsis: eng,
    language: 'en',
    source: 'thetvdb-en',
    episodeTitle: translations.ptBrTitle || translations.engTitle,
    tvdbEpisodeId: translations.tvdbEpisodeId,
    tvdbSeriesId: translations.tvdbSeriesId,
  };
  if (useCache) writeSynopsisCache(cacheKey, fallbackResult);
  return fallbackResult;
}
