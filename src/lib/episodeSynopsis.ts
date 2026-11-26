import type {
  AnimeSynopsisResult,
  CatalogSourceCredentials,
  EpisodeSynopsisResult,
} from './types.ts';
import type { CanonicalMediaType } from './catalog/idCodec.ts';
import type { HttpFetcher } from './httpTypes.ts';
import {
  clearTvdbEpisodePageCache,
  fetchTheTvdbEpisodeTranslations,
  fetchTheTvdbMediaTranslations,
} from './catalog/providers/thetvdbProvider.ts';
import {
  cleanSynopsisWhitespace,
  parseGoogleTranslateResponse,
  splitTextForTranslation,
  translateEnglishToPtBr,
  translateTextToPtBr,
} from './googleTranslate.ts';
import {
  synopsisSourceForEngine,
  translateSynopsisToPtBr,
  translateTitleToPtBr,
} from './translation.ts';

export { parseGoogleTranslateResponse, splitTextForTranslation, translateEnglishToPtBr, translateTextToPtBr };

const SYNOPSIS_CACHE_TTL_MS = 30 * 60 * 1000;
const SYNOPSIS_CACHE_MAX_ENTRIES = 250;

interface CachedSynopsisEntry<T> {
  expiresAt: number;
  value: T | null;
}

const synopsisCache = new Map<string, CachedSynopsisEntry<EpisodeSynopsisResult>>();
const animeSynopsisCache = new Map<string, CachedSynopsisEntry<AnimeSynopsisResult>>();

export function clearEpisodeSynopsisCache(): void {
  synopsisCache.clear();
  clearTvdbEpisodePageCache();
}

export function clearAnimeSynopsisCache(): void {
  animeSynopsisCache.clear();
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

function writeCacheEntry<T>(
  cache: Map<string, CachedSynopsisEntry<T>>,
  key: string,
  value: T | null
): void {
  if (cache.size >= SYNOPSIS_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) cache.delete(oldestKey);
  }
  cache.set(key, {
    expiresAt: Date.now() + SYNOPSIS_CACHE_TTL_MS,
    value,
  });
}

/**
 * Resolves the episode synopsis & artwork from TheTVDB.com following strict localization priority:
 * 1. Native PT-BR synopsis from TheTVDB.com (`data-language="pt"` / v4 `/translations/pt`)
 * 2. English synopsis from TheTVDB.com translated to PT-BR via DeepL (web endpoint, no API key)
 * 3. Same English synopsis translated via Google Translate if DeepL fails
 * 4. Original English synopsis from TheTVDB.com if both translators fail
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
    useCache,
  });

  if (!translations) {
    if (useCache) writeCacheEntry(synopsisCache, cacheKey, null);
    return null;
  }

  const imageFields = translations.episodeImage ? { episodeImage: translations.episodeImage } : {};

  const resolveEpisodeTitle = async (): Promise<string | undefined> => {
    if (translations.ptBrTitle) return translations.ptBrTitle;
    if (translations.engTitle) {
      const translatedTitle = await translateTitleToPtBr(
        fetchHttp,
        translations.engTitle,
        'en',
        5000,
        useCache
      );
      return translatedTitle || translations.engTitle;
    }
    if (translations.originalTitle) {
      const translatedTitle = await translateTitleToPtBr(
        fetchHttp,
        translations.originalTitle,
        'auto',
        5000,
        useCache
      );
      return translatedTitle || translations.originalTitle;
    }
    return undefined;
  };

  // 1. Native PT-BR synopsis from TheTVDB.com
  const ptBr = cleanSynopsisWhitespace(translations.ptBrOverview || '');
  if (ptBr) {
    const episodeTitle = await resolveEpisodeTitle();
    const result: EpisodeSynopsisResult = {
      synopsis: ptBr,
      language: 'pt-BR',
      source: 'thetvdb-pt-br',
      episodeTitle,
      ...imageFields,
      tvdbEpisodeId: translations.tvdbEpisodeId,
      tvdbSeriesId: translations.tvdbSeriesId,
    };
    if (useCache) writeCacheEntry(synopsisCache, cacheKey, result);
    return result;
  }

  // 2. English synopsis from TheTVDB.com -> translate via DeepL, then Google Translate
  const eng = cleanSynopsisWhitespace(translations.engOverview || '');
  if (!eng) {
    if (useCache) writeCacheEntry(synopsisCache, cacheKey, null);
    return null;
  }

  const [translated, episodeTitle] = await Promise.all([
    translateSynopsisToPtBr(fetchHttp, eng),
    resolveEpisodeTitle(),
  ]);
  if (translated) {
    const result: EpisodeSynopsisResult = {
      synopsis: translated.text,
      language: 'pt-BR',
      source: synopsisSourceForEngine(translated.engine),
      episodeTitle,
      ...imageFields,
      tvdbEpisodeId: translations.tvdbEpisodeId,
      tvdbSeriesId: translations.tvdbSeriesId,
    };
    if (useCache) writeCacheEntry(synopsisCache, cacheKey, result);
    return result;
  }

  // 3. Fallback to original English synopsis if both translators failed
  const fallbackResult: EpisodeSynopsisResult = {
    synopsis: eng,
    language: 'en',
    source: 'thetvdb-en',
    episodeTitle,
    ...imageFields,
    tvdbEpisodeId: translations.tvdbEpisodeId,
    tvdbSeriesId: translations.tvdbSeriesId,
  };
  if (useCache) writeCacheEntry(synopsisCache, cacheKey, fallbackResult);
  return fallbackResult;
}

export interface ResolveAnimeSynopsisInput {
  title?: string;
  originalTitle?: string;
  alternativeTitles?: string[];
  year?: string;
  mediaType?: CanonicalMediaType;
  tvdbId?: number;
  tvdbSlug?: string;
  fallbackEnglishOverview?: string;
  credentials?: CatalogSourceCredentials;
  useCache?: boolean;
}

function buildAnimeSynopsisCacheKey(input: ResolveAnimeSynopsisInput): string {
  const kind = input.mediaType || 'anime';
  if (input.tvdbId && input.tvdbId > 0) {
    return `tvdb-media:${kind}:id:${input.tvdbId}`;
  }
  if (input.tvdbSlug) {
    return `tvdb-media:${kind}:slug:${input.tvdbSlug.toLowerCase()}`;
  }
  const titleKey = (input.title || input.originalTitle || '').trim().toLowerCase();
  const yearKey = (input.year || '').trim();
  return `tvdb-media:${kind}:title:${titleKey}|${yearKey}`;
}

/**
 * Resolves the anime/series/movie synopsis & artwork from TheTVDB.com following strict localization priority:
 * 1. Native PT-BR synopsis from TheTVDB.com (`data-language="pt"` / v4 `/translations/pt`)
 * 2. English synopsis from TheTVDB.com translated to PT-BR via DeepL (web endpoint, no API key)
 * 3. Same English synopsis translated via Google Translate if DeepL fails
 * 4. Original English synopsis from TheTVDB.com if both translators fail
 */
export async function resolveLocalizedAnimeSynopsis(
  fetchHttp: HttpFetcher,
  input: ResolveAnimeSynopsisInput
): Promise<AnimeSynopsisResult | null> {
  const useCache = input.useCache !== false;
  const cacheKey = buildAnimeSynopsisCacheKey(input);
  if (useCache) {
    const hit = animeSynopsisCache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) {
      return hit.value;
    }
  }

  const translations = await fetchTheTvdbMediaTranslations(fetchHttp, {
    title: input.title,
    originalTitle: input.originalTitle,
    alternativeTitles: input.alternativeTitles,
    year: input.year,
    mediaType: input.mediaType || 'anime',
    tvdbId: input.tvdbId,
    tvdbSlug: input.tvdbSlug,
    fallbackEnglishOverview: input.fallbackEnglishOverview,
    credentials: input.credentials,
  });

  if (!translations) {
    if (useCache) writeCacheEntry(animeSynopsisCache, cacheKey, null);
    return null;
  }

  const artworkFields = {
    ...(translations.poster ? { poster: translations.poster } : {}),
    ...(translations.backdrop ? { backdrop: translations.backdrop } : {}),
  };

  // 1. Native PT-BR synopsis from TheTVDB.com
  const ptBr = cleanSynopsisWhitespace(translations.ptBrOverview || '');
  if (ptBr) {
    const result: AnimeSynopsisResult = {
      synopsis: ptBr,
      language: 'pt-BR',
      source: 'thetvdb-pt-br',
      ...artworkFields,
      tvdbId: translations.tvdbId,
      tvdbSlug: translations.tvdbSlug,
    };
    if (useCache) writeCacheEntry(animeSynopsisCache, cacheKey, result);
    return result;
  }

  // 2. English synopsis from TheTVDB.com -> translate via DeepL, then Google Translate
  const eng = cleanSynopsisWhitespace(translations.engOverview || '');
  if (!eng) {
    if (useCache) writeCacheEntry(animeSynopsisCache, cacheKey, null);
    return null;
  }

  const translated = await translateSynopsisToPtBr(fetchHttp, eng);
  if (translated) {
    const result: AnimeSynopsisResult = {
      synopsis: translated.text,
      language: 'pt-BR',
      source: synopsisSourceForEngine(translated.engine),
      ...artworkFields,
      tvdbId: translations.tvdbId,
      tvdbSlug: translations.tvdbSlug,
    };
    if (useCache) writeCacheEntry(animeSynopsisCache, cacheKey, result);
    return result;
  }

  // 3. Fallback to original English synopsis if both translators failed
  const fallbackResult: AnimeSynopsisResult = {
    synopsis: eng,
    language: 'en',
    source: 'thetvdb-en',
    ...artworkFields,
    tvdbId: translations.tvdbId,
    tvdbSlug: translations.tvdbSlug,
  };
  if (useCache) writeCacheEntry(animeSynopsisCache, cacheKey, fallbackResult);
  return fallbackResult;
}
