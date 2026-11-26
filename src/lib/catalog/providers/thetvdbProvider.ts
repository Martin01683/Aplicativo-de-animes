import * as cheerio from 'cheerio';
import {
  isEpisodeAvailableOnServer,
  mergeServerAndCatalogEpisodes,
  parseEpisodeDateToTimestampSec,
} from '../../episodeAvailability.ts';
import {
  hasCjkOrJapaneseScript,
  translateEnglishToPtBr,
  translateTitlesBatchToPtBr,
} from '../../googleTranslate.ts';
import type { HttpFetcher } from '../../httpTypes.ts';
import type {
  AnimeAudioTrackData,
  AnimeDetails,
  AnimeEpisodeLink,
  CatalogSourceCredentials,
  EpisodeSynopsisSource,
  ExternalMediaIds,
  MediaKind,
  SearchResultItem,
} from '../../types.ts';
import { isSafeExternalHttpUrl } from '../../urlSafety.ts';
import {
  buildEpisodeUri,
  buildExternalDatabaseLinks,
  buildMediaUri,
  scoreTitleSimilarity,
  stripSeasonFromTitle,
  type CanonicalMediaType,
} from '../idCodec.ts';
import { findLiveChartScheduleHint } from './livechartProvider.ts';
import {
  extractSafeParentPrefixForTvdb,
  extractSeasonAndPartInfo,
  unifyServerSeasonsWithCatalog,
  type UnifiedAudioTrackResult,
} from '../seasonUnifier.ts';

const TVDB_V4_API_BASE = 'https://api4.thetvdb.com/v4';
const TVDB_WEB_SEARCH_URL = 'https://api4.thetvdb.com/web/search/queries';
const TVDB_WEB_ORIGIN = 'https://www.thetvdb.com';

interface CachedTvdbToken {
  apiKey: string;
  token: string;
  expiresAt: number;
}

let cachedTvdbToken: CachedTvdbToken | null = null;

const TVDB_GENRE_PT_MAP: Record<string, string> = {
  action: 'Ação',
  adventure: 'Aventura',
  animation: 'Animação',
  anime: 'Anime',
  children: 'Infantil',
  comedy: 'Comédia',
  crime: 'Crime',
  documentary: 'Documentário',
  drama: 'Drama',
  family: 'Família',
  fantasy: 'Fantasia',
  food: 'Culinária',
  history: 'História',
  horror: 'Terror',
  'martial arts': 'Artes Marciais',
  'mini-series': 'Minissérie',
  musical: 'Musical',
  mystery: 'Mistério',
  romance: 'Romance',
  'science fiction': 'Ficção Científica',
  'sci-fi': 'Ficção Científica',
  sport: 'Esporte',
  sports: 'Esporte',
  suspense: 'Suspense',
  thriller: 'Thriller',
  war: 'Guerra',
  western: 'Faroeste',
};

const TVDB_STATUS_PT_MAP: Record<string, string> = {
  continuing: 'Em exibição',
  ended: 'Finalizado',
  released: 'Lançado',
  upcoming: 'Em breve',
  'in production': 'Em produção',
  announced: 'Anunciado',
  'post production': 'Pós-produção',
};

function cleanText(val: string | undefined | null): string {
  return String(val || '').replace(/\s+/g, ' ').trim();
}

function translateGenre(raw: string): string {
  const cleaned = cleanText(raw);
  if (!cleaned) return '';
  return TVDB_GENRE_PT_MAP[cleaned.toLowerCase()] || cleaned;
}

function translateStatus(raw: string | undefined): string | undefined {
  const cleaned = cleanText(raw);
  if (!cleaned) return undefined;
  return TVDB_STATUS_PT_MAP[cleaned.toLowerCase()] || cleaned;
}

function isValidArtworkUrl(raw: string | undefined): string {
  let cleaned = cleanText(raw);
  if (!cleaned) return '';
  if (cleaned.startsWith('//')) {
    cleaned = `https:${cleaned}`;
  } else if (/^\/banners\//i.test(cleaned)) {
    cleaned = `https://artworks.thetvdb.com${cleaned}`;
  }
  if (/\/images\/(?:missing|v2\/(?:logo|placeholder))/i.test(cleaned)) return '';
  if (/^https?:\/\/(?:www\.)?thetvdb\.com\/images\//i.test(cleaned)) return '';
  return isSafeExternalHttpUrl(cleaned) ? cleaned : '';
}

function extractTvdbIdFromHit(hit: TvdbWebSearchHit): number {
  const candidates = [
    hit.tvdb_id,
    hit.id,
    typeof hit.objectID === 'string' ? hit.objectID.replace(/^(?:series|movie)-/i, '') : '',
  ];
  for (const cand of candidates) {
    if (cand === undefined || cand === null) continue;
    const parsed = Number.parseInt(String(cand), 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function inferTvdbMediaType(
  rawType: string | undefined,
  country?: string,
  language?: string,
  genres?: string[]
): CanonicalMediaType {
  if (rawType && /movie/i.test(rawType)) return 'movie';
  const isAnime =
    /^(?:jpn|ja|japan)$/i.test(country || '') ||
    /^(?:jpn|ja|japanese)$/i.test(language || '') ||
    Boolean(genres?.some((g) => /anime/i.test(g)));
  return isAnime ? 'anime' : 'series';
}

export interface TvdbWebSearchHit {
  id?: string | number;
  tvdb_id?: string | number;
  objectID?: string;
  type?: string;
  primary_type?: string;
  name?: string;
  slug?: string;
  url?: string;
  year?: string | number;
  release_year?: string | number;
  first_air_date?: string;
  status?: string;
  country?: string;
  primary_language?: string;
  network?: string;
  latest_network?: string;
  studios?: string[];
  companies?: string[];
  genres?: string[];
  aliases?: string[];
  follower_count?: number;
  poster?: string;
  image?: string;
  image_url?: string;
  banner?: string;
  thumbnail?: string;
  overview?: string;
  translations?: Record<string, string>;
  overviews?: Record<string, string>;
  remote_ids?: Array<{ id?: string; sourceName?: string }>;
}

export interface TvdbRichMatch {
  tvdbId: number;
  slug?: string;
  mediaType: CanonicalMediaType;
  title: string;
  originalTitle?: string;
  englishTitle?: string;
  alternativeTitles: string[];
  synopsis: string;
  synopsisSource?: EpisodeSynopsisSource;
  synopsisLanguage?: 'pt-BR' | 'en';
  poster: string;
  backdrop: string;
  year?: string;
  firstAirDate?: string;
  status?: string;
  studio?: string;
  network?: string;
  genres: string[];
  originalCountry?: string;
  originalLanguage?: string;
  externalIds: ExternalMediaIds;
  score: number;
}

function pickPreferredTranslation(
  map: Record<string, string> | undefined,
  fallback?: string
): string {
  if (map && typeof map === 'object') {
    const pt = cleanText(map.pt || map['pt-br'] || map.por);
    if (pt) return pt;
    const eng = cleanText(map.eng || map.en);
    if (eng) return eng;
  }
  return cleanText(fallback);
}

function pickLocalizedTvdbOverview(
  map: Record<string, string> | undefined,
  fallback?: string
): {
  synopsis: string;
  synopsisSource?: EpisodeSynopsisSource;
  synopsisLanguage?: 'pt-BR' | 'en';
} {
  if (map && typeof map === 'object') {
    const ptBr = cleanText(map.pt || map['pt-br'] || map.pt_br);
    if (ptBr) {
      return { synopsis: ptBr, synopsisSource: 'thetvdb-pt-br', synopsisLanguage: 'pt-BR' };
    }
    const eng = cleanText(map.eng || map.en);
    if (eng) {
      return { synopsis: eng, synopsisSource: 'thetvdb-en', synopsisLanguage: 'en' };
    }
  }
  const fb = cleanText(fallback);
  if (fb) {
    return { synopsis: fb, synopsisSource: 'thetvdb-en', synopsisLanguage: 'en' };
  }
  const por = map && typeof map === 'object' ? cleanText(map.por) : '';
  return { synopsis: por };
}

export function parseTvdbWebSearchHit(hit: TvdbWebSearchHit): TvdbRichMatch | null {
  const tvdbId = extractTvdbIdFromHit(hit);
  if (!tvdbId) return null;

  const rawType = hit.type || hit.primary_type || 'series';
  if (!/^(?:series|movie)$/i.test(rawType)) return null;

  const title = pickPreferredTranslation(hit.translations, hit.name);
  if (!title) return null;

  const mediaType = inferTvdbMediaType(rawType, hit.country, hit.primary_language, hit.genres);
  const originalTitle = cleanText(hit.name) || undefined;
  const englishTitle = cleanText(hit.translations?.eng) || undefined;

  const altSet = new Set<string>();
  const pushAlt = (val?: string) => {
    const c = cleanText(val);
    if (c && c.toLowerCase() !== title.toLowerCase()) altSet.add(c);
  };
  pushAlt(originalTitle);
  pushAlt(englishTitle);
  if (Array.isArray(hit.aliases)) {
    for (const a of hit.aliases.slice(0, 12)) pushAlt(a);
  }
  if (hit.translations?.jpn) pushAlt(hit.translations.jpn);

  const poster =
    isValidArtworkUrl(hit.poster) ||
    isValidArtworkUrl(hit.image_url) ||
    isValidArtworkUrl(hit.image) ||
    isValidArtworkUrl(hit.thumbnail);
  const backdrop = isValidArtworkUrl(hit.banner) || poster;
  const localizedOverview = pickLocalizedTvdbOverview(hit.overviews, hit.overview);

  const yearRaw =
    hit.year !== undefined && hit.year !== null && String(hit.year).trim()
      ? String(hit.year).trim()
      : hit.release_year
        ? String(hit.release_year)
        : hit.first_air_date?.slice(0, 4) || '';
  const year = /^\d{4}$/.test(yearRaw) ? yearRaw : undefined;

  const genres = Array.from(
    new Set((hit.genres || []).map((g) => translateGenre(g)).filter(Boolean))
  );

  const studio =
    cleanText(hit.studios?.[0]) || cleanText(hit.companies?.[0]) || undefined;
  const network = cleanText(hit.latest_network || hit.network) || undefined;

  const imdbRemote = hit.remote_ids?.find((r) => /imdb/i.test(r.sourceName || ''))?.id;
  const externalIds: ExternalMediaIds = {
    tvdbId,
    tvdbSlug: cleanText(hit.slug) || undefined,
    imdbId: imdbRemote && /^tt\d+$/i.test(imdbRemote) ? imdbRemote : undefined,
  };

  return {
    tvdbId,
    slug: cleanText(hit.slug) || undefined,
    mediaType,
    title,
    originalTitle,
    englishTitle,
    alternativeTitles: Array.from(altSet).slice(0, 10),
    synopsis: localizedOverview.synopsis,
    synopsisSource: localizedOverview.synopsisSource,
    synopsisLanguage: localizedOverview.synopsisLanguage,
    poster,
    backdrop,
    year,
    firstAirDate: cleanText(hit.first_air_date) || undefined,
    status: translateStatus(hit.status),
    studio,
    network,
    genres,
    originalCountry: cleanText(hit.country) || undefined,
    originalLanguage: cleanText(hit.primary_language) || undefined,
    externalIds,
    score: 0,
  };
}

function slugToTitleCandidate(slug?: string): string | undefined {
  const s = cleanText(slug);
  if (!s || /^\d+$/.test(s)) return undefined;
  const humanized = s
    .replace(/-(?:19|20)\d{2}$/, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  return humanized.length >= 2 ? humanized : undefined;
}

function scoreTvdbCandidate(
  queryTerms: string[],
  hit: TvdbWebSearchHit,
  parsed: TvdbRichMatch,
  hint?: { mediaType?: MediaKind; year?: string }
): number {
  const candidateTitles = [
    parsed.title,
    parsed.originalTitle,
    parsed.englishTitle,
    slugToTitleCandidate(parsed.slug),
    ...parsed.alternativeTitles,
    hit.translations?.pt,
    hit.translations?.por,
    hit.translations?.eng,
    hit.translations?.jpn,
  ].filter((t): t is string => Boolean(t && t.trim()));

  let bestSim = 0;
  for (const q of queryTerms) {
    const qStripped = stripSeasonFromTitle(q);
    for (const c of candidateTitles) {
      bestSim = Math.max(bestSim, scoreTitleSimilarity(q, c));
      if (qStripped && qStripped !== q) {
        bestSim = Math.max(bestSim, scoreTitleSimilarity(qStripped, c) * 0.94);
      }
      const cStripped = stripSeasonFromTitle(c);
      if (cStripped && cStripped !== c) {
        bestSim = Math.max(bestSim, scoreTitleSimilarity(q, cStripped) * 0.94);
      }
    }
  }

  let score = bestSim;

  // Popularity tie-breaker via follower_count (prevents obscure 1978 titles beating mainstream anime/shows)
  const followers = typeof hit.follower_count === 'number' && hit.follower_count > 0 ? hit.follower_count : 0;
  score += Math.min(0.18, Math.log10(followers + 1) * 0.03);

  // Reward mediaType alignment
  if (hint?.mediaType) {
    if (hint.mediaType === 'movie') {
      score += parsed.mediaType === 'movie' ? 0.14 : -0.25;
    } else if (hint.mediaType === 'anime') {
      if (parsed.mediaType === 'anime') score += 0.14;
      else if (parsed.mediaType === 'series') score += 0.04;
      else score -= 0.18;
    } else if (hint.mediaType === 'series') {
      if (parsed.mediaType === 'series' || parsed.mediaType === 'anime') score += 0.1;
      else score -= 0.2;
    }
  }

  // Reward year match when provided
  if (hint?.year && parsed.year) {
    const diff = Math.abs(Number.parseInt(hint.year, 10) - Number.parseInt(parsed.year, 10));
    if (diff === 0) score += 0.08;
    else if (diff === 1) score += 0.04;
    else if (diff >= 10) score -= 0.12;
  }

  // Slight bonus if PT-BR overview exists
  if (hit.overviews?.pt || hit.overviews?.por) {
    score += 0.02;
  }

  return score;
}

async function getTvdbBearerToken(
  fetchHttp: HttpFetcher,
  credentials?: CatalogSourceCredentials
): Promise<string | null> {
  const apiKey = credentials?.tvdbApiKey?.trim();
  if (!apiKey) return null;

  if (cachedTvdbToken && cachedTvdbToken.apiKey === apiKey && cachedTvdbToken.expiresAt > Date.now()) {
    return cachedTvdbToken.token;
  }

  try {
    const bodyObj: Record<string, string> = { apikey: apiKey };
    if (credentials?.tvdbPin?.trim()) bodyObj.pin = credentials.tvdbPin.trim();
    const res = await fetchHttp(`${TVDB_V4_API_BASE}/login`, {
      method: 'POST',
      accept: 'application/json',
      contentType: 'application/json',
      body: JSON.stringify(bodyObj),
      timeoutMs: 9000,
    });
    if (!res.ok) return null;
    const parsed = JSON.parse(res.body) as { data?: { token?: string } };
    const token = parsed?.data?.token?.trim();
    if (!token) return null;
    cachedTvdbToken = {
      apiKey,
      token,
      expiresAt: Date.now() + 12 * 60 * 60 * 1000,
    };
    return token;
  } catch {
    return null;
  }
}

const TVDB_WEB_SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
type TvdbWebSearchHitPair = Array<{ hit: TvdbWebSearchHit; parsed: TvdbRichMatch }>;
const tvdbWebSearchCacheByFetcher = new WeakMap<
  HttpFetcher,
  Map<string, { value?: TvdbWebSearchHitPair; expiresAt: number; inFlight?: Promise<TvdbWebSearchHitPair> }>
>();

/**
 * Queries TheTVDB's public web search API (no API key required) for series, anime, and movies.
 */
export async function searchTheTvdbWebHits(
  fetchHttp: HttpFetcher,
  query: string,
  options: {
    mediaType?: 'all' | 'anime' | 'series' | 'movie';
    limit?: number;
  } = {}
): Promise<TvdbWebSearchHitPair> {
  const cleanQuery = query.trim();
  if (!cleanQuery) return [];

  const limit = Math.min(20, Math.max(5, options.limit || 12));
  const cacheKey = `${options.mediaType || 'all'}::${limit}::${cleanQuery.toLowerCase()}`;
  let map = tvdbWebSearchCacheByFetcher.get(fetchHttp);
  if (!map) {
    map = new Map();
    tvdbWebSearchCacheByFetcher.set(fetchHttp, map);
  }
  const now = Date.now();
  const existing = map.get(cacheKey);
  if (existing) {
    if (existing.expiresAt > now && existing.value !== undefined) {
      return existing.value;
    }
    if (existing.inFlight) {
      return existing.inFlight;
    }
  }

  const facetFilters =
    options.mediaType === 'movie'
      ? [['type:movie']]
      : options.mediaType === 'series' || options.mediaType === 'anime'
        ? [['type:series']]
        : [['type:series', 'type:movie']];

  const req = (async (): Promise<TvdbWebSearchHitPair> => {
    try {
      const res = await fetchHttp(TVDB_WEB_SEARCH_URL, {
        method: 'POST',
        accept: 'application/json',
        contentType: 'application/json',
        referer: `${TVDB_WEB_ORIGIN}/search`,
        headers: { Origin: TVDB_WEB_ORIGIN },
        body: JSON.stringify({
          requests: [
            {
              indexName: 'TVDB',
              params: {
                query: cleanQuery,
                hitsPerPage: limit,
                facetFilters,
              },
            },
          ],
        }),
        timeoutMs: 9000,
      });

      if (!res.ok) return [];
      const payload = JSON.parse(res.body) as {
        results?: Array<{ hits?: TvdbWebSearchHit[] }>;
      };
      const hits = payload?.results?.[0]?.hits || [];
      const out: TvdbWebSearchHitPair = [];
      for (const hit of hits) {
        const parsed = parseTvdbWebSearchHit(hit);
        if (parsed) out.push({ hit, parsed });
      }
      return out;
    } catch {
      return [];
    }
  })();

  if (map.size > 80) {
    const oldest = map.keys().next().value;
    if (oldest) map.delete(oldest);
  }
  const slot: { value?: TvdbWebSearchHitPair; expiresAt: number; inFlight?: Promise<TvdbWebSearchHitPair> } = {
    expiresAt: 0,
    inFlight: req,
  };
  map.set(cacheKey, slot);

  try {
    const value = await req;
    slot.value = value;
    slot.expiresAt = Date.now() + TVDB_WEB_SEARCH_CACHE_TTL_MS;
    return value;
  } finally {
    slot.inFlight = undefined;
  }
}

export async function searchTheTvdb(
  fetchHttp: HttpFetcher,
  query: string,
  credentials?: CatalogSourceCredentials,
  options: { mediaType?: 'all' | 'anime' | 'series' | 'movie'; limit?: number } = {}
): Promise<SearchResultItem[]> {
  const cleanQuery = query.trim();
  if (!cleanQuery) return [];

  // 1. Official TheTVDB v4 API if the user configured an API key
  const token = await getTvdbBearerToken(fetchHttp, credentials);
  if (token) {
    try {
      const typeParam =
        options.mediaType === 'movie'
          ? '&type=movie'
          : options.mediaType === 'series' || options.mediaType === 'anime'
            ? '&type=series'
            : '';
      const res = await fetchHttp(
        `${TVDB_V4_API_BASE}/search?query=${encodeURIComponent(cleanQuery)}${typeParam}&limit=${options.limit || 12}`,
        {
          accept: 'application/json',
          headers: { Authorization: `Bearer ${token}` },
          timeoutMs: 9000,
        }
      );
      if (res.ok) {
        const parsed = JSON.parse(res.body) as { data?: TvdbWebSearchHit[] };
        const out: SearchResultItem[] = [];
        for (const row of parsed.data || []) {
          const hit = parseTvdbWebSearchHit(row);
          if (!hit) continue;
          const uri = buildMediaUri(hit.mediaType, 'thetvdb', hit.tvdbId);
          out.push({
            id: uri,
            title: hit.title,
            url: uri,
            kind: hit.mediaType,
            poster: hit.poster,
            year: hit.year,
            excerpt: hit.synopsis.slice(0, 180) || undefined,
            audioType: null,
            catalogSource: 'thetvdb',
            externalIds: hit.externalIds,
          });
        }
        if (out.length > 0) return out;
      }
    } catch {
      // Fall through to keyless TheTVDB web search
    }
  }

  // 2. Public keyless TheTVDB web search
  const webHits = await searchTheTvdbWebHits(fetchHttp, cleanQuery, options);
  const scored = webHits
    .map(({ hit, parsed }) => ({
      parsed,
      rank: scoreTvdbCandidate([cleanQuery], hit, parsed, {
        mediaType: options.mediaType && options.mediaType !== 'all' ? options.mediaType : undefined,
      }),
    }))
    .sort((a, b) => b.rank - a.rank);

  return scored.map(({ parsed }) => {
    const uri = buildMediaUri(parsed.mediaType, 'thetvdb', parsed.tvdbId);
    return {
      id: uri,
      title: parsed.title,
      url: uri,
      kind: parsed.mediaType,
      poster: parsed.poster,
      year: parsed.year,
      excerpt: parsed.synopsis.slice(0, 180) || undefined,
      audioType: null,
      catalogSource: 'thetvdb',
      externalIds: parsed.externalIds,
    };
  });
}

/**
 * Finds the single best matching TheTVDB record for a given title/hints (anime, series, or movie).
 */
export async function findBestTheTvdbMatch(
  fetchHttp: HttpFetcher,
  terms: string[],
  options: {
    mediaType?: MediaKind;
    year?: string;
  } = {}
): Promise<TvdbRichMatch | null> {
  const uniqueTerms: string[] = [];
  const pushTerm = (rawCandidate: string | null | undefined) => {
    const clean = cleanText(rawCandidate);
    if (clean.length < 2) return;
    if (!uniqueTerms.some((x) => x.toLowerCase() === clean.toLowerCase())) {
      uniqueTerms.push(clean);
    }
  };
  for (const raw of terms) {
    const t = cleanText(raw);
    if (t.length < 2) continue;
    pushTerm(t);
    const stripped = stripSeasonFromTitle(t);
    if (stripped.length >= 2 && stripped.toLowerCase() !== t.toLowerCase()) {
      pushTerm(stripped);
    }
    const parentPrefix = extractSafeParentPrefixForTvdb(t);
    if (parentPrefix && parentPrefix.toLowerCase() !== t.toLowerCase()) {
      pushTerm(parentPrefix);
    }
    if (uniqueTerms.length >= 6) break;
  }
  if (!uniqueTerms.length) return null;

  const searchType: 'all' | 'anime' | 'series' | 'movie' =
    options.mediaType === 'movie'
      ? 'movie'
      : options.mediaType === 'anime' || options.mediaType === 'series'
        ? options.mediaType
        : 'all';

  let best: { match: TvdbRichMatch; rank: number; sim: number } | null = null;

  for (const term of uniqueTerms.slice(0, 3)) {
    const webHits = await searchTheTvdbWebHits(fetchHttp, term, {
      mediaType: searchType,
      limit: 10,
    });
    for (const { hit, parsed } of webHits) {
      const candidateTitles = [
        parsed.title,
        parsed.originalTitle,
        parsed.englishTitle,
        slugToTitleCandidate(parsed.slug),
        ...parsed.alternativeTitles,
        hit.translations?.pt,
        hit.translations?.por,
        hit.translations?.eng,
        hit.translations?.jpn,
      ].filter((x): x is string => Boolean(x));

      let pureSim = 0;
      for (const qt of uniqueTerms) {
        for (const ct of candidateTitles) {
          pureSim = Math.max(pureSim, scoreTitleSimilarity(qt, ct));
          const ctBase = stripSeasonFromTitle(ct);
          if (ctBase) pureSim = Math.max(pureSim, scoreTitleSimilarity(stripSeasonFromTitle(qt), ctBase) * 0.95);
        }
      }

      const rank = scoreTvdbCandidate(uniqueTerms, hit, parsed, options);
      if (pureSim >= 0.48 && (!best || rank > best.rank)) {
        best = { match: { ...parsed, score: pureSim }, rank, sim: pureSim };
      }
    }
    if (best && best.sim >= 0.85) break;
  }

  return best ? best.match : null;
}

function extractCleanTranslationText($: cheerio.CheerioAPI, el: Parameters<cheerio.CheerioAPI>[0]): {
  title: string;
  synopsis: string;
  aliases: string[];
} {
  const $node = $(el);
  const title = cleanText($node.attr('data-title'));
  const aliases: string[] = [];

  // Extract aliases if listed inside the translation block
  $node.find('.block, .aliases').each((_, blk) => {
    const blkText = cleanText($(blk).text());
    if (/^aliases\b/i.test(blkText)) {
      $(blk)
        .find('li, span')
        .each((__, item) => {
          const a = cleanText($(item).text());
          if (a && !/^aliases$/i.test(a) && !aliases.includes(a)) aliases.push(a);
        });
    }
  });

  // Extract clean synopsis paragraphs excluding aliases/tagline side blocks
  const paragraphs: string[] = [];
  $node.children('p').each((_, p) => {
    const txt = cleanText($(p).text());
    if (txt) paragraphs.push(txt);
  });

  let synopsis = paragraphs.join('\n\n');
  if (!synopsis) {
    const clone = $node.clone();
    clone.find('.block, .aliases, h4, ul').remove();
    synopsis = cleanText(clone.text());
  }

  return { title, synopsis, aliases };
}

/**
 * Parses a public TheTVDB.com series or movie HTML page with full PT-BR/EN translations,
 * studio, network, runtime, genres, release dates, aliases, poster, and slug.
 */
export function parseTvdbPublicHtml(
  html: string,
  tvdbId: number,
  mediaTypeHint: CanonicalMediaType = 'anime',
  canonicalPageUrl?: string
): AnimeDetails | null {
  const $ = cheerio.load(html);

  const rawH1 = cleanText($('h1#series_title, h1#movie_title, h1').first().text());
  const ogTitle = cleanText($('meta[property="og:title"]').attr('content')).replace(
    /\s*-\s*TheTVDB\.com$/i,
    ''
  );

  // Extract localized titles & synopses from .change_translation_text blocks
  const translations = new Map<string, { title: string; synopsis: string; aliases: string[] }>();
  $('.change_translation_text[data-language]').each((_, el) => {
    const lang = cleanText($(el).attr('data-language')).toLowerCase();
    if (!lang) return;
    translations.set(lang, extractCleanTranslationText($, el));
  });

  const ptBrBlock =
    translations.get('pt') || translations.get('pt-br') || translations.get('pt_br');
  const porBlock = translations.get('por');
  const ptBlock = ptBrBlock || porBlock;
  const engBlock = translations.get('eng') || translations.get('en');
  const jpnBlock = translations.get('jpn');

  const title = ptBlock?.title || engBlock?.title || rawH1 || ogTitle;
  if (!title) return null;

  const metaDescription = cleanText(
    $('meta[property="og:description"], meta[name="description"]').attr('content')
  );
  let synopsis = '';
  let synopsisSource: EpisodeSynopsisSource | undefined;
  let synopsisLanguage: 'pt-BR' | 'en' | undefined;
  if (ptBrBlock?.synopsis) {
    synopsis = ptBrBlock.synopsis;
    synopsisSource = 'thetvdb-pt-br';
    synopsisLanguage = 'pt-BR';
  } else if (engBlock?.synopsis) {
    synopsis = engBlock.synopsis;
    synopsisSource = 'thetvdb-en';
    synopsisLanguage = 'en';
  } else if (porBlock?.synopsis) {
    synopsis = porBlock.synopsis;
  } else if (metaDescription) {
    synopsis = metaDescription;
    synopsisSource = 'thetvdb-en';
    synopsisLanguage = 'en';
  }

  const originalTitle = rawH1 && rawH1 !== title ? rawH1 : jpnBlock?.title || undefined;
  const alternativeTitle =
    engBlock?.title && engBlock.title.toLowerCase() !== title.toLowerCase()
      ? engBlock.title
      : undefined;

  const altTitlesSet = new Set<string>();
  const addAlt = (v?: string) => {
    const c = cleanText(v);
    if (c && c.toLowerCase() !== title.toLowerCase()) altTitlesSet.add(c);
  };
  addAlt(alternativeTitle);
  addAlt(originalTitle);
  for (const b of [ptBrBlock, porBlock, engBlock, jpnBlock]) {
    for (const a of b?.aliases || []) addAlt(a);
  }

  // Parse #series_basic_info metadata list (used on both series and movie pages)
  let parsedTvdbId = tvdbId;
  let status: string | undefined;
  let firstAirDate: string | undefined;
  let lastAirDate: string | undefined;
  let studio: string | undefined;
  let network: string | undefined;
  let averageDuration: string | undefined;
  let originalCountry: string | undefined;
  let originalLanguage: string | undefined;
  let imdbId: string | undefined;
  const genres: string[] = [];

  $('#series_basic_info li.list-group-item, #series_basic_info li').each((_, li) => {
    const $li = $(li);
    const key = cleanText($li.find('strong').first().text()).toLowerCase();
    if (!key) return;
    const $span = $li.find('span').first();
    const rawVal = cleanText($span.length ? $span.text() : $li.text().replace($li.find('strong').first().text(), ''));

    if (key.includes('thetvdb.com') && key.includes('id')) {
      const idNum = Number.parseInt(rawVal, 10);
      if (Number.isFinite(idNum) && idNum > 0) parsedTvdbId = idNum;
    } else if (key === 'status') {
      status = translateStatus(rawVal);
    } else if (key === 'first aired') {
      firstAirDate = firstAirDate || rawVal;
    } else if (key === 'released') {
      const brMatch = rawVal.match(/Brazil\s+([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/i);
      const wwMatch = rawVal.match(/Worldwide\s+([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/i);
      const anyDate = rawVal.match(/([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/);
      firstAirDate = firstAirDate || brMatch?.[1] || wwMatch?.[1] || anyDate?.[1] || rawVal;
    } else if (key === 'recent') {
      lastAirDate = lastAirDate || rawVal;
    } else if (key === 'studio' || key === 'production company') {
      if (!studio) {
        const links = $li
          .find('a')
          .map((__, a) => cleanText($(a).text()))
          .get()
          .filter(Boolean);
        studio = links.length > 0 ? links.slice(0, 2).join(', ') : rawVal;
      }
    } else if (key === 'network') {
      const links = $li
        .find('a')
        .map((__, a) => cleanText($(a).text()))
        .get()
        .filter(Boolean);
      network = links.length > 0 ? links.slice(0, 2).join(', ') : rawVal;
    } else if (key === 'average runtime' || key === 'runtime') {
      const minsMatch = rawVal.match(/(\d+)\s*min/i);
      averageDuration = minsMatch ? `${minsMatch[1]} min` : rawVal;
    } else if (key === 'genres') {
      $li.find('a').each((__, a) => {
        const g = translateGenre($(a).text());
        if (g && !genres.includes(g)) genres.push(g);
      });
    } else if (key === 'original country') {
      originalCountry = rawVal;
    } else if (key === 'original language') {
      originalLanguage = rawVal;
    } else if (key === 'on other sites') {
      $li.find('a[href]').each((__, a) => {
        const href = $(a).attr('href') || '';
        const ttMatch = href.match(/imdb\.com\/title\/(tt\d+)/i);
        if (ttMatch?.[1]) imdbId = ttMatch[1];
      });
    }
  });

  // Extract slug from canonical URL or internal links
  let slug: string | undefined;
  const urlSlugMatch = (canonicalPageUrl || '').match(/\/(?:series|movies)\/([^/?#]+)/i);
  if (urlSlugMatch?.[1] && !/^\d+$/.test(urlSlugMatch[1])) {
    slug = urlSlugMatch[1];
  } else {
    const linkHref = $('a[href*="/series/"][href*="/seasons/"], a[href*="/movies/"][href*="/translations"]').first().attr('href') || '';
    const linkMatch = linkHref.match(/\/(?:series|movies)\/([^/?#]+)/i);
    if (linkMatch?.[1] && !/^\d+$/.test(linkMatch[1])) slug = linkMatch[1];
  }

  // Detect movie vs anime vs series accurately
  const isMoviePage =
    mediaTypeHint === 'movie' ||
    Boolean(canonicalPageUrl && /\/movies\//i.test(canonicalPageUrl)) ||
    html.includes('TheTVDB.com Movie ID');
  const resolvedMediaType: CanonicalMediaType = isMoviePage
    ? 'movie'
    : inferTvdbMediaType('series', originalCountry, originalLanguage, genres);

  // Extract official seasons count
  const officialSeasonNums = new Set<number>();
  $('a[href*="/seasons/official/"]').each((_, a) => {
    const m = ($(a).attr('href') || '').match(/\/seasons\/official\/(\d+)/);
    if (m?.[1]) {
      const n = Number.parseInt(m[1], 10);
      if (Number.isFinite(n) && n > 0) officialSeasonNums.add(n);
    }
  });
  const seasonsCount = officialSeasonNums.size > 0 ? String(officialSeasonNums.size) : undefined;

  // Poster & Backdrop artwork
  let poster = '';
  $('img').each((_, img) => {
    if (poster) return;
    const $img = $(img);
    const src = $img.attr('data-src') || $img.attr('data-original') || $img.attr('src') || '';
    const valid = isValidArtworkUrl(src);
    if (valid && /\/banners\/.*\/posters\//i.test(valid)) {
      poster = valid;
    }
  });
  if (!poster) {
    poster =
      isValidArtworkUrl($('meta[property="og:image"]').attr('content')) ||
      isValidArtworkUrl(
        $('img.img-responsive').first().attr('data-src') ||
          $('img.img-responsive').first().attr('src')
      );
  }

  let backdrop = '';
  const bgMatch = html.match(
    /(?:https?:)?\/\/artworks\.thetvdb\.com\/banners\/[^"'\s)]+(?:backgrounds|fanart|banners)\/[^"'\s)]+/i
  );
  if (bgMatch?.[0]) backdrop = isValidArtworkUrl(bgMatch[0]);
  if (!backdrop) backdrop = poster;

  const yearMatch = (firstAirDate || '').match(/\b((?:19|20)\d{2})\b/);
  const year = yearMatch?.[1];

  const externalIds: ExternalMediaIds = {
    tvdbId: parsedTvdbId,
    tvdbSlug: slug,
    imdbId,
  };
  const uri = buildMediaUri(resolvedMediaType, 'thetvdb', parsedTvdbId);

  const episodes: AnimeEpisodeLink[] =
    resolvedMediaType === 'movie'
      ? [
          {
            numberLabel: 'Filme',
            episodeNumber: 1,
            seasonNumber: 1,
            seasonLabel: 'Filme',
            title: 'Filme Completo',
            url: buildEpisodeUri('movie', 'thetvdb', parsedTvdbId, 1, 1),
            date: firstAirDate,
            thumb: backdrop || poster || undefined,
          },
        ]
      : [];

  return {
    title,
    alternativeTitle,
    alternativeTitles: Array.from(altTitlesSet).slice(0, 10),
    originalTitle,
    url: uri,
    kind: resolvedMediaType,
    catalogSource: 'thetvdb',
    externalIds,
    enrichmentSources: ['thetvdb'],
    externalLinks: buildExternalDatabaseLinks(externalIds, { mediaType: resolvedMediaType }),
    poster,
    backdrop,
    synopsis,
    synopsisSource,
    synopsisLanguage,
    year,
    firstAirDate,
    lastAirDate,
    seasonsCount,
    averageDuration,
    status,
    studio,
    network,
    originalCountry,
    originalLanguage,
    genres,
    audioType: null,
    episodes,
  };
}

/**
 * Parses TheTVDB `/series/{slug}/allseasons/official` HTML into structured episodes across seasons.
 */
export function parseTvdbAllSeasonsHtml(
  html: string,
  tvdbId: number,
  mediaType: CanonicalMediaType = 'anime'
): AnimeEpisodeLink[] {
  const $ = cheerio.load(html);
  const episodes: AnimeEpisodeLink[] = [];
  const seen = new Set<string>();

  $('li.list-group-item').each((_, el) => {
    const $li = $(el);
    const labelText = cleanText($li.find('.episode-label').first().text());
    const seMatch = labelText.match(/S0*(\d+)E0*(\d+)/i);
    if (!seMatch) return;

    const seasonNumber = Number.parseInt(seMatch[1], 10);
    const episodeNumber = Number.parseInt(seMatch[2], 10);
    if (!Number.isFinite(seasonNumber) || seasonNumber <= 0) return; // skip Specials (Season 0)
    if (!Number.isFinite(episodeNumber) || episodeNumber <= 0) return;

    const key = `${seasonNumber}:${episodeNumber}`;
    if (seen.has(key)) return;
    seen.add(key);

    const titleAnchor = $li.find('h4 a').first();
    const inlinePtTitle = cleanText(
      $li
        .find(
          '.change_translation_text[data-language="pt"], .change_translation_text[data-language="pt-br"]'
        )
        .first()
        .attr('data-title') || ''
    );
    const rawTitle = inlinePtTitle || cleanText(titleAnchor.text());
    const cleanEpTitle = rawTitle && !/^(?:tba|tbd)$/i.test(rawTitle) ? rawTitle : '';
    const epHref = titleAnchor.attr('href') || '';
    const epIdMatch = epHref.match(/\/episodes\/(\d+)/i);
    const tvdbEpisodeId = epIdMatch ? Number.parseInt(epIdMatch[1], 10) : undefined;
    let date: string | undefined;
    $li.find('ul.list-inline li').each((__, metaLi) => {
      if (date) return;
      const candidate = cleanText($(metaLi).text());
      if (candidate && parseEpisodeDateToTimestampSec(candidate) !== undefined) {
        date = candidate;
      }
    });
    const overview = cleanText($li.find('.list-group-item-text p').first().text()) || undefined;
    let thumb: string | undefined;
    $li.find('img').each((__, img) => {
      if (thumb) return;
      const $img = $(img);
      const candidate = isValidArtworkUrl(
        $img.attr('data-src') || $img.attr('data-original') || $img.attr('src')
      );
      if (candidate) thumb = candidate;
    });

    const title = cleanEpTitle
      ? `Episódio ${episodeNumber} — ${cleanEpTitle}`
      : `Episódio ${episodeNumber}`;
    episodes.push({
      numberLabel: seasonNumber > 1 ? `T${seasonNumber} · EP ${episodeNumber}` : `EP ${episodeNumber}`,
      episodeNumber,
      seasonNumber,
      seasonLabel: `Temporada ${seasonNumber}`,
      title,
      url: buildEpisodeUri(mediaType, 'thetvdb', tvdbId, seasonNumber, episodeNumber),
      date,
      thumb,
      overview,
      tvdbEpisodeId: Number.isFinite(tvdbEpisodeId) ? tvdbEpisodeId : undefined,
    });
  });

  episodes.sort((a, b) => (a.seasonNumber || 1) - (b.seasonNumber || 1) || (a.episodeNumber || 0) - (b.episodeNumber || 0));
  return episodes;
}

const EPISODE_PREFIX_SUBTITLE_RE = /^Episódio\s+(\d+)\s+—\s+(.+)$/;
const TVDB_EP_PAGE_CACHE_TTL_MS = 60 * 60 * 1000;
const TVDB_EP_PAGE_CACHE_MAX_ENTRIES = 1000;
const tvdbEpisodePageCache = new Map<
  number,
  { value: TvdbEpisodeTranslations; expiresAt: number }
>();

export function clearTvdbEpisodePageCache(): void {
  tvdbEpisodePageCache.clear();
}

function readTvdbEpisodePageCache(tvdbEpisodeId: number): TvdbEpisodeTranslations | null {
  const hit = tvdbEpisodePageCache.get(tvdbEpisodeId);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    tvdbEpisodePageCache.delete(tvdbEpisodeId);
    return null;
  }
  return hit.value;
}

function writeTvdbEpisodePageCache(
  tvdbEpisodeId: number,
  value: TvdbEpisodeTranslations
): void {
  if (!Number.isFinite(tvdbEpisodeId) || tvdbEpisodeId <= 0) return;
  if (tvdbEpisodePageCache.size >= TVDB_EP_PAGE_CACHE_MAX_ENTRIES) {
    const oldest = tvdbEpisodePageCache.keys().next().value;
    if (oldest !== undefined) tvdbEpisodePageCache.delete(oldest);
  }
  tvdbEpisodePageCache.set(tvdbEpisodeId, {
    value,
    expiresAt: Date.now() + TVDB_EP_PAGE_CACHE_TTL_MS,
  });
}

async function fetchPublicTvdbEpisodePage(
  fetchHttp: HttpFetcher,
  tvdbEpisodeId: number,
  options: {
    tvdbSlug?: string;
    tvdbSeriesId?: number;
    timeoutMs?: number;
    useCache?: boolean;
  } = {}
): Promise<TvdbEpisodeTranslations | null> {
  if (!Number.isFinite(tvdbEpisodeId) || tvdbEpisodeId <= 0) return null;
  const useCache = options.useCache !== false;
  if (useCache) {
    const cached = readTvdbEpisodePageCache(tvdbEpisodeId);
    if (cached) return cached;
  }

  const slug = cleanText(options.tvdbSlug || '');
  const epPageUrl = slug
    ? `${TVDB_WEB_ORIGIN}/series/${encodeURIComponent(slug)}/episodes/${tvdbEpisodeId}`
    : `${TVDB_WEB_ORIGIN}/dereferrer/episode/${tvdbEpisodeId}`;

  try {
    const res = await fetchHttp(epPageUrl, {
      referer: `${TVDB_WEB_ORIGIN}/`,
      timeoutMs: options.timeoutMs ?? 4500,
    });
    if (!res.ok) return null;
    const parsed = parseTvdbEpisodePageHtml(res.body);
    const enriched: TvdbEpisodeTranslations = {
      ...parsed,
      tvdbEpisodeId,
      ...(options.tvdbSeriesId ? { tvdbSeriesId: options.tvdbSeriesId } : {}),
    };
    if (useCache) {
      writeTvdbEpisodePageCache(tvdbEpisodeId, enriched);
    }
    return enriched;
  } catch {
    return null;
  }
}

/**
 * Resolves official localized PT-BR episode titles for a list of TheTVDB episode IDs
 * following strict priority:
 * 1. Native TheTVDB PT-BR title (`data-language="pt"`)
 * 2. Official TheTVDB English title translated to PT-BR via Google Translate
 * 3. Original (e.g. Japanese) title translated to PT-BR via Google Translate
 * Also warms the shared episode page cache so opening any episode in EpisodeWorkspace is instant.
 */
export async function resolveLocalizedEpisodeTitlesByIds(
  fetchHttp: HttpFetcher,
  tvdbEpisodeIds: number[],
  options: {
    tvdbSlug?: string;
    tvdbSeriesId?: number;
    useCache?: boolean;
    maxIds?: number;
    concurrency?: number;
    timeoutMs?: number;
  } = {}
): Promise<Record<number, string>> {
  const maxIds = options.maxIds ?? 28;
  const concurrency = options.concurrency ?? 6;
  const timeoutMs = options.timeoutMs ?? 4500;
  const useCache = options.useCache !== false;

  const uniqueIds = Array.from(
    new Set(tvdbEpisodeIds.filter((id) => Number.isFinite(id) && id > 0))
  ).slice(0, maxIds);
  if (uniqueIds.length === 0) return {};

  const pageResults = new Map<number, TvdbEpisodeTranslations>();
  for (let i = 0; i < uniqueIds.length; i += concurrency) {
    const slice = uniqueIds.slice(i, i + concurrency);
    await Promise.all(
      slice.map(async (epId) => {
        const trans = await fetchPublicTvdbEpisodePage(fetchHttp, epId, {
          tvdbSlug: options.tvdbSlug,
          tvdbSeriesId: options.tvdbSeriesId,
          timeoutMs,
          useCache,
        });
        if (trans) {
          pageResults.set(epId, trans);
        }
      })
    );
  }

  const resolved: Record<number, string> = {};
  const toTranslateById = new Map<number, string>();
  const toTranslateList: string[] = [];

  for (const [epId, trans] of pageResults.entries()) {
    if (trans.ptBrTitle) {
      resolved[epId] = trans.ptBrTitle;
      continue;
    }
    const candidate = trans.engTitle || trans.originalTitle || '';
    if (candidate) {
      toTranslateById.set(epId, candidate);
      toTranslateList.push(candidate);
    }
  }

  if (toTranslateList.length > 0) {
    const translatedMap = await translateTitlesBatchToPtBr(fetchHttp, toTranslateList, {
      useCache,
    });
    for (const [epId, rawCandidate] of toTranslateById.entries()) {
      resolved[epId] = translatedMap.get(rawCandidate) || rawCandidate;
    }
  }

  return resolved;
}

/**
 * Localizes episode titles parsed from TheTVDB episode guides to PT-BR:
 * - For seasonal/standard series (<= 28 episodes with `tvdbEpisodeId`), fetches each episode's
 *   official TheTVDB page directly in parallel to get native PT-BR titles (e.g. "As Exceções")
 *   and warm the shared episode synopsis/title cache so list and player match 100%.
 * - Falls back to batched Google Translate (EN > original) for episodes without native PT-BR
 *   or for large multi-season series (> 28 episodes, whose expanded seasons hydrate on demand).
 */
export async function localizeTvdbEpisodeListTitles(
  fetchHttp: HttpFetcher,
  episodes: AnimeEpisodeLink[],
  options: {
    tvdbSlug?: string;
    tvdbSeriesId?: number;
    onlyCjk?: boolean;
    useCache?: boolean;
    skipDirectEpisodePages?: boolean;
    skipTranslateForHydratableIds?: boolean;
    maxDirectEpisodePages?: number;
  } = {}
): Promise<AnimeEpisodeLink[]> {
  if (episodes.length === 0) return episodes;
  const useCache = options.useCache !== false;
  const maxDirect = options.maxDirectEpisodePages ?? 28;

  // 1. Directly fetch individual TheTVDB episode pages for native PT-BR titles on standard-sized series
  const pageByEpisodeId = new Map<number, TvdbEpisodeTranslations>();

  // Always pick up zero-cost in-memory cache hits even when deferring network fetches
  if (useCache) {
    for (const ep of episodes) {
      if (ep.tvdbEpisodeId && ep.tvdbEpisodeId > 0 && !pageByEpisodeId.has(ep.tvdbEpisodeId)) {
        const cached = readTvdbEpisodePageCache(ep.tvdbEpisodeId);
        if (cached) {
          pageByEpisodeId.set(ep.tvdbEpisodeId, cached);
        }
      }
    }
  }

  const eligibleIds =
    !options.skipDirectEpisodePages && !options.onlyCjk
      ? Array.from(
          new Set(
            episodes
              .map((ep) => ep.tvdbEpisodeId)
              .filter(
                (id): id is number =>
                  typeof id === 'number' &&
                  Number.isFinite(id) &&
                  id > 0 &&
                  !pageByEpisodeId.has(id)
              )
          )
        )
      : [];

  if (eligibleIds.length > 0 && eligibleIds.length <= maxDirect) {
    const CONCURRENCY = 6;
    for (let i = 0; i < eligibleIds.length; i += CONCURRENCY) {
      const slice = eligibleIds.slice(i, i + CONCURRENCY);
      await Promise.all(
        slice.map(async (epId) => {
          const trans = await fetchPublicTvdbEpisodePage(fetchHttp, epId, {
            tvdbSlug: options.tvdbSlug,
            tvdbSeriesId: options.tvdbSeriesId,
            timeoutMs: 4500,
            useCache,
          });
          if (trans) {
            pageByEpisodeId.set(epId, trans);
          }
        })
      );
    }
  }

  // 2. Collect non-native-PT-BR subtitles for batched Google Translate
  const subtitlesToTranslate: string[] = [];
  const candidateSubtitleByIndex = new Map<number, string>();

  episodes.forEach((ep, idx) => {
    const pageTrans = ep.tvdbEpisodeId ? pageByEpisodeId.get(ep.tvdbEpisodeId) : undefined;
    if (pageTrans?.ptBrTitle) {
      return; // Official native TheTVDB PT-BR title — no machine translation needed
    }
    if (
      options.skipTranslateForHydratableIds &&
      !pageTrans &&
      ep.tvdbEpisodeId &&
      ep.tvdbEpisodeId > 0
    ) {
      return; // AnimeDetailView will hydrate official PT-BR titles asynchronously via /api/episode-titles
    }

    const m = ep.title.match(EPISODE_PREFIX_SUBTITLE_RE);
    const guideSub = m?.[2]?.trim() || '';
    const bestNonPtSub = pageTrans?.engTitle || pageTrans?.originalTitle || guideSub;
    if (!bestNonPtSub) return;
    if (options.onlyCjk && !hasCjkOrJapaneseScript(bestNonPtSub)) return;

    candidateSubtitleByIndex.set(idx, bestNonPtSub);
    subtitlesToTranslate.push(bestNonPtSub);
  });

  const translatedMap =
    subtitlesToTranslate.length > 0
      ? await translateTitlesBatchToPtBr(fetchHttp, subtitlesToTranslate, {
          useCache,
        })
      : new Map<string, string>();

  return episodes.map((ep, idx) => {
    const pageTrans = ep.tvdbEpisodeId ? pageByEpisodeId.get(ep.tvdbEpisodeId) : undefined;
    const epNum =
      ep.episodeNumber && ep.episodeNumber > 0
        ? String(ep.episodeNumber)
        : ep.title.match(EPISODE_PREFIX_SUBTITLE_RE)?.[1] || '';

    const extraFields: Partial<AnimeEpisodeLink> = {};
    if (pageTrans) {
      extraFields.titleLocalized = true;
      if (!ep.thumb && pageTrans.episodeImage) {
        extraFields.thumb = pageTrans.episodeImage;
      }
      if (!ep.overview && (pageTrans.ptBrOverview || pageTrans.engOverview)) {
        extraFields.overview = pageTrans.ptBrOverview || pageTrans.engOverview;
      }
    }

    // Priority 1: Native PT-BR title from TheTVDB episode page
    if (pageTrans?.ptBrTitle) {
      return {
        ...ep,
        ...extraFields,
        title: epNum ? `Episódio ${epNum} — ${pageTrans.ptBrTitle}` : pageTrans.ptBrTitle,
      };
    }

    // Priority 2/3: Translated EN or original title -> fallback to raw candidate
    const candidate = candidateSubtitleByIndex.get(idx);
    if (candidate) {
      const translated = translatedMap.get(candidate) || (pageTrans?.engTitle ? pageTrans.engTitle : '');
      if (translated) {
        return {
          ...ep,
          ...extraFields,
          title: epNum ? `Episódio ${epNum} — ${translated}` : translated,
        };
      }
    }

    return Object.keys(extraFields).length > 0 ? { ...ep, ...extraFields } : ep;
  });
}

export function buildAnimeDetailsFromTvdbRichMatch(
  match: TvdbRichMatch,
  targetUri?: string
): AnimeDetails {
  const resolvedType: CanonicalMediaType = match.mediaType || 'anime';
  const uri = targetUri || buildMediaUri(resolvedType, 'thetvdb', match.tvdbId);
  return {
    title: match.title,
    originalTitle: match.originalTitle,
    alternativeTitle: match.englishTitle,
    alternativeTitles: match.alternativeTitles,
    url: uri,
    kind: resolvedType,
    catalogSource: 'thetvdb',
    externalIds: match.externalIds,
    enrichmentSources: ['thetvdb'],
    externalLinks: buildExternalDatabaseLinks(match.externalIds, { mediaType: resolvedType }),
    poster: match.poster,
    backdrop: match.backdrop,
    synopsis: match.synopsis,
    synopsisSource: match.synopsisSource,
    synopsisLanguage: match.synopsisLanguage,
    year: match.year,
    firstAirDate: match.firstAirDate,
    status: match.status,
    studio: match.studio,
    network: match.network,
    originalCountry: match.originalCountry,
    originalLanguage: match.originalLanguage,
    genres: match.genres,
    audioType: null,
    episodes: [],
  };
}

export async function fetchTheTvdbDetails(
  fetchHttp: HttpFetcher,
  tvdbId: number,
  options: {
    mediaType?: CanonicalMediaType;
    credentials?: CatalogSourceCredentials;
    slugHint?: string;
    titleHint?: string;
    includeEpisodes?: boolean;
    skipEpisodePageHydration?: boolean;
  } = {}
): Promise<AnimeDetails | null> {
  if (!Number.isFinite(tvdbId) || tvdbId <= 0) return null;
  const mediaType = options.mediaType || 'anime';
  const includeEpisodes = options.includeEpisodes !== false;

  // 1. Official TheTVDB v4 API when API Key is configured
  const token = await getTvdbBearerToken(fetchHttp, options.credentials);
  if (token) {
    try {
      const endpoint = mediaType === 'movie' ? 'movies' : 'series';
      let epsCameFromPt = false;
      const [mainRes, ptTransRes, epsRes] = await Promise.all([
        fetchHttp(`${TVDB_V4_API_BASE}/${endpoint}/${tvdbId}/extended`, {
          accept: 'application/json',
          headers: { Authorization: `Bearer ${token}` },
          timeoutMs: 9000,
        }),
        fetchHttp(`${TVDB_V4_API_BASE}/${endpoint}/${tvdbId}/translations/pt`, {
          accept: 'application/json',
          headers: { Authorization: `Bearer ${token}` },
          timeoutMs: 7000,
        }).catch(() => null),
        mediaType !== 'movie' && includeEpisodes
          ? (async () => {
              try {
                const ptEps = await fetchHttp(
                  `${TVDB_V4_API_BASE}/series/${tvdbId}/episodes/default/pt?page=0`,
                  {
                    accept: 'application/json',
                    headers: { Authorization: `Bearer ${token}` },
                    timeoutMs: 9000,
                  }
                );
                if (ptEps.ok) {
                  epsCameFromPt = true;
                  return ptEps;
                }
              } catch {
                // Fall back to default episodes endpoint below
              }
              return fetchHttp(`${TVDB_V4_API_BASE}/series/${tvdbId}/episodes/default?page=0`, {
                accept: 'application/json',
                headers: { Authorization: `Bearer ${token}` },
                timeoutMs: 9000,
              }).catch(() => null);
            })()
          : Promise.resolve(null),
      ]);

      if (mainRes.ok) {
        const payload = JSON.parse(mainRes.body) as {
          data?: {
            id?: number;
            name?: string;
            slug?: string;
            image?: string;
            overview?: string;
            firstAired?: string;
            lastAired?: string;
            year?: string;
            averageRuntime?: number;
            runtime?: number;
            originalCountry?: string;
            originalLanguage?: string;
            status?: { name?: string };
            genres?: Array<{ name?: string }>;
            companies?: Array<{ name?: string; companyType?: { companyTypeName?: string } }>;
            remoteIds?: Array<{ id?: string; sourceName?: string }>;
            aliases?: Array<{ name?: string }>;
            artworks?: Array<{ image?: string; type?: number; score?: number }>;
          };
        };
        const d = payload.data;
        if (d?.name) {
          let ptName = '';
          let ptOverview = '';
          if (ptTransRes?.ok) {
            try {
              const ptJson = JSON.parse(ptTransRes.body) as {
                data?: { name?: string; overview?: string };
              };
              ptName = cleanText(ptJson.data?.name);
              ptOverview = cleanText(ptJson.data?.overview);
            } catch {
              // ignore
            }
          }

          const resolvedType: CanonicalMediaType =
            mediaType === 'movie'
              ? 'movie'
              : inferTvdbMediaType(
                  'series',
                  d.originalCountry,
                  d.originalLanguage,
                  (d.genres || []).map((g) => g.name || '')
                );
          const imdbRemote = d.remoteIds?.find((r) => /imdb/i.test(r.sourceName || ''))?.id;
          const externalIds: ExternalMediaIds = {
            tvdbId,
            tvdbSlug: d.slug || options.slugHint,
            imdbId: imdbRemote && /^tt\d+$/i.test(imdbRemote) ? imdbRemote : undefined,
          };

          const poster = isValidArtworkUrl(d.image);
          const bestBgArtwork = (d.artworks || [])
            .filter((a) => (a.type === 3 || a.type === 15) && isValidArtworkUrl(a.image))
            .sort((a, b) => (b.score || 0) - (a.score || 0))[0];
          const backdrop = isValidArtworkUrl(bestBgArtwork?.image) || poster;

          const episodes: AnimeEpisodeLink[] = [];
          if (resolvedType === 'movie') {
            episodes.push({
              numberLabel: 'Filme',
              episodeNumber: 1,
              seasonNumber: 1,
              seasonLabel: 'Filme',
              title: 'Filme Completo',
              url: buildEpisodeUri('movie', 'thetvdb', tvdbId, 1, 1),
              date: d.firstAired || undefined,
              thumb: backdrop || poster || undefined,
            });
          } else if (epsRes && epsRes.ok) {
            const ePayload = JSON.parse(epsRes.body) as {
              data?: {
                episodes?: Array<{
                  id?: number;
                  number?: number;
                  seasonNumber?: number;
                  name?: string;
                  aired?: string;
                  image?: string;
                  overview?: string;
                  runtime?: number;
                }>;
              };
            };
            for (const ep of ePayload.data?.episodes || []) {
              if (!ep.number || ep.number <= 0 || ep.seasonNumber === 0) continue;
              const sNum = ep.seasonNumber && ep.seasonNumber > 0 ? ep.seasonNumber : 1;
              const cleanApiEpName =
                ep.name && !/^(?:tba|tbd)$/i.test(ep.name.trim()) ? ep.name.trim() : '';
              episodes.push({
                numberLabel: sNum > 1 ? `T${sNum} · EP ${ep.number}` : `EP ${ep.number}`,
                episodeNumber: ep.number,
                seasonNumber: sNum,
                seasonLabel: `Temporada ${sNum}`,
                title: cleanApiEpName
                  ? `Episódio ${ep.number} — ${cleanApiEpName}`
                  : `Episódio ${ep.number}`,
                url: buildEpisodeUri(resolvedType, 'thetvdb', tvdbId, sNum, ep.number),
                date: ep.aired || undefined,
                thumb: isValidArtworkUrl(ep.image) || undefined,
                overview: ep.overview || undefined,
                durationMinutes: ep.runtime || undefined,
                tvdbEpisodeId: ep.id && ep.id > 0 ? ep.id : undefined,
                ...(epsCameFromPt && cleanApiEpName && !hasCjkOrJapaneseScript(cleanApiEpName)
                  ? { titleLocalized: true }
                  : {}),
              });
            }
          }

          const localizedV4Episodes =
            resolvedType !== 'movie' && episodes.length > 0
              ? await localizeTvdbEpisodeListTitles(fetchHttp, episodes, {
                  tvdbSlug: externalIds.tvdbSlug,
                  tvdbSeriesId: tvdbId,
                  onlyCjk: epsCameFromPt,
                  skipDirectEpisodePages: options.skipEpisodePageHydration,
                })
              : episodes;

          const title = ptName || d.name;
          const studio = d.companies?.find((c) => /studio|production/i.test(c.companyType?.companyTypeName || ''))?.name;
          const network = d.companies?.find((c) => /network/i.test(c.companyType?.companyTypeName || ''))?.name;
          const runtimeVal = d.averageRuntime || d.runtime;
          const uri = buildMediaUri(resolvedType, 'thetvdb', tvdbId);

          let finalSynopsis = ptOverview || '';
          let finalSynopsisSource: EpisodeSynopsisSource | undefined = ptOverview
            ? 'thetvdb-pt-br'
            : undefined;
          let finalSynopsisLanguage: 'pt-BR' | 'en' | undefined = ptOverview ? 'pt-BR' : undefined;
          if (!finalSynopsis && d.overview) {
            const engOverview = cleanText(d.overview);
            if (engOverview) {
              const translated = await translateEnglishToPtBr(fetchHttp, engOverview);
              if (translated) {
                finalSynopsis = translated;
                finalSynopsisSource = 'thetvdb-google-translate';
                finalSynopsisLanguage = 'pt-BR';
              } else {
                finalSynopsis = engOverview;
                finalSynopsisSource = 'thetvdb-en';
                finalSynopsisLanguage = 'en';
              }
            }
          }

          return {
            title,
            originalTitle: d.name !== title ? d.name : undefined,
            alternativeTitles: (d.aliases || [])
              .map((a) => cleanText(a.name))
              .filter((a) => a && a.toLowerCase() !== title.toLowerCase())
              .slice(0, 10),
            url: uri,
            kind: resolvedType,
            catalogSource: 'thetvdb',
            externalIds,
            enrichmentSources: ['thetvdb'],
            externalLinks: buildExternalDatabaseLinks(externalIds, { mediaType: resolvedType }),
            poster,
            backdrop,
            synopsis: finalSynopsis,
            synopsisSource: finalSynopsisSource,
            synopsisLanguage: finalSynopsisLanguage,
            year: d.year || d.firstAired?.slice(0, 4) || undefined,
            firstAirDate: d.firstAired || undefined,
            lastAirDate: d.lastAired || undefined,
            averageDuration: runtimeVal ? `${runtimeVal} min` : undefined,
            status: translateStatus(d.status?.name),
            studio,
            network,
            originalCountry: d.originalCountry,
            originalLanguage: d.originalLanguage,
            genres: Array.from(
              new Set((d.genres || []).map((g) => translateGenre(g.name || '')).filter(Boolean))
            ),
            audioType: null,
            episodes: localizedV4Episodes,
          };
        }
      }
    } catch {
      // Fall through to public TheTVDB.com HTML parsing
    }
  }

  // 2. Public TheTVDB.com page (zero API key required!)
  const tryLoadPublicHtmlPage = async (
    pageUrl: string,
    effectiveType: CanonicalMediaType,
    effectiveId: number
  ): Promise<{ details: AnimeDetails; finalUrl: string } | null> => {
    try {
      const res = await fetchHttp(pageUrl, {
        referer: `${TVDB_WEB_ORIGIN}/`,
        timeoutMs: 12000,
      });
      if (!res.ok) return null;
      const parsed = parseTvdbPublicHtml(
        res.body,
        effectiveId,
        effectiveType,
        res.finalUrl || pageUrl
      );
      if (!parsed) return null;
      return { details: parsed, finalUrl: res.finalUrl || pageUrl };
    } catch {
      return null;
    }
  };

  const dereferrerUrl = `${TVDB_WEB_ORIGIN}/dereferrer/${mediaType === 'movie' ? 'movie' : 'series'}/${tvdbId}`;
  const primaryPageUrl = options.slugHint
    ? `${TVDB_WEB_ORIGIN}/${mediaType === 'movie' ? 'movies' : 'series'}/${encodeURIComponent(options.slugHint)}`
    : dereferrerUrl;

  let loaded = await tryLoadPublicHtmlPage(primaryPageUrl, mediaType, tvdbId);

  // If a stale slugHint failed, retry the canonical dereferrer URL
  if (!loaded && options.slugHint) {
    loaded = await tryLoadPublicHtmlPage(dereferrerUrl, mediaType, tvdbId);
  }

  // If the primary HTML page failed (e.g., dereferrer hiccup, wrong mediaType, or transient block),
  // recover via TheTVDB's public JSON search API (by titleHint and/or numeric ID).
  let recoveredSearchMatch: TvdbRichMatch | null = null;
  if (!loaded) {
    const cleanTitleHint = cleanText(options.titleHint);
    const searchQueries: string[] = [];
    if (cleanTitleHint.length >= 2) searchQueries.push(cleanTitleHint);
    searchQueries.push(String(tvdbId));

    for (const q of searchQueries) {
      const hits = await searchTheTvdbWebHits(fetchHttp, q, {
        mediaType: 'all',
        limit: 10,
      }).catch(() => []);
      const exactIdHit = hits.find((h) => h.parsed.tvdbId === tvdbId)?.parsed;
      if (exactIdHit) {
        recoveredSearchMatch = exactIdHit;
        break;
      }
    }

    if (!recoveredSearchMatch && cleanTitleHint.length >= 2) {
      recoveredSearchMatch = await findBestTheTvdbMatch(fetchHttp, [cleanTitleHint], {
        mediaType,
      }).catch(() => null);
    }

    if (recoveredSearchMatch?.slug) {
      const recoveredType = recoveredSearchMatch.mediaType || mediaType;
      const slugUrl = `${TVDB_WEB_ORIGIN}/${recoveredType === 'movie' ? 'movies' : 'series'}/${encodeURIComponent(recoveredSearchMatch.slug)}`;
      if (slugUrl !== primaryPageUrl) {
        loaded = await tryLoadPublicHtmlPage(slugUrl, recoveredType, recoveredSearchMatch.tvdbId);
      }
    }

    // Last HTML fallback: try opposite mediaType dereferrer (e.g. saved as movie when it's a series)
    if (!loaded && !recoveredSearchMatch) {
      const altType: CanonicalMediaType = mediaType === 'movie' ? 'anime' : 'movie';
      const altUrl = `${TVDB_WEB_ORIGIN}/dereferrer/${altType === 'movie' ? 'movie' : 'series'}/${tvdbId}`;
      loaded = await tryLoadPublicHtmlPage(altUrl, altType, tvdbId);
    }
  }

  // If HTML remained unreachable but TheTVDB JSON search succeeded, build a valid profile directly from it
  if (!loaded && recoveredSearchMatch) {
    const fallbackDetails = buildAnimeDetailsFromTvdbRichMatch(recoveredSearchMatch);
    if (fallbackDetails.synopsisSource === 'thetvdb-en' && fallbackDetails.synopsis) {
      const translated = await translateEnglishToPtBr(fetchHttp, fallbackDetails.synopsis).catch(
        () => null
      );
      if (translated) {
        fallbackDetails.synopsis = translated;
        fallbackDetails.synopsisSource = 'thetvdb-google-translate';
        fallbackDetails.synopsisLanguage = 'pt-BR';
      }
    }
    return fallbackDetails;
  }

  if (!loaded) return null;

  const { details, finalUrl } = loaded;
  const resolvedTvdbId = details.externalIds?.tvdbId || tvdbId;

  // Translate English synopsis via Google Translate in parallel with episode guide fetch when PT-BR is missing
  const translatePromise =
    details.synopsisSource === 'thetvdb-en' && details.synopsis
      ? translateEnglishToPtBr(fetchHttp, details.synopsis).catch(() => null)
      : Promise.resolve(null);

  // Load full official episodes guide for series/anime when requested
  const episodesPromise =
    details.kind !== 'movie' && includeEpisodes && details.externalIds?.tvdbSlug
      ? fetchHttp(
          `${TVDB_WEB_ORIGIN}/series/${encodeURIComponent(details.externalIds.tvdbSlug)}/allseasons/official`,
          {
            referer: finalUrl,
            timeoutMs: 15000,
          }
        ).catch(() => null)
      : Promise.resolve(null);

  const [translatedSynopsis, epsRes] = await Promise.all([translatePromise, episodesPromise]);

  if (translatedSynopsis) {
    details.synopsis = translatedSynopsis;
    details.synopsisSource = 'thetvdb-google-translate';
    details.synopsisLanguage = 'pt-BR';
  }

  if (epsRes?.ok) {
    const parsedEps = parseTvdbAllSeasonsHtml(
      epsRes.body,
      resolvedTvdbId,
      (details.kind as CanonicalMediaType) || 'anime'
    );
    if (parsedEps.length > 0) {
      details.episodes = await localizeTvdbEpisodeListTitles(fetchHttp, parsedEps, {
        tvdbSlug: details.externalIds?.tvdbSlug,
        tvdbSeriesId: resolvedTvdbId,
        skipDirectEpisodePages: options.skipEpisodePageHydration,
        skipTranslateForHydratableIds: options.skipEpisodePageHydration,
      });
      const seasons = new Set(details.episodes.map((e) => e.seasonNumber || 1));
      details.seasonsCount = String(seasons.size);
      details.episodesTotalCount = String(details.episodes.length);
    }
  }

  return details;
}

function buildDualAudioTracks(params: {
  primaryAudio: 'DUB' | 'LEG';
  primaryEpisodes: AnimeEpisodeLink[];
  primarySourceUrl: string;
  alternateTrack?: UnifiedAudioTrackResult;
  mergeAlternateEpisodes: (
    serverEpisodes: AnimeEpisodeLink[],
    sourceUrl: string
  ) => AnimeEpisodeLink[];
}): Partial<Record<'DUB' | 'LEG', AnimeAudioTrackData>> | undefined {
  const {
    primaryAudio,
    primaryEpisodes,
    primarySourceUrl,
    alternateTrack,
    mergeAlternateEpisodes,
  } = params;
  if (!alternateTrack || alternateTrack.serverEpisodes.length === 0) {
    return undefined;
  }

  const alternateSourceUrl = alternateTrack.sourceUrl || primarySourceUrl;
  const mergedAlternate = mergeAlternateEpisodes(
    alternateTrack.serverEpisodes,
    alternateSourceUrl
  );
  const alternatePlayableCount = mergedAlternate.filter(isEpisodeAvailableOnServer).length;
  if (alternatePlayableCount === 0) {
    return undefined;
  }

  const primaryPlayableCount = primaryEpisodes.filter(isEpisodeAvailableOnServer).length;
  return {
    [primaryAudio]: {
      audioType: primaryAudio,
      episodes: primaryEpisodes,
      playableCount: primaryPlayableCount,
      sourceUrl: primarySourceUrl,
    },
    [alternateTrack.audioType]: {
      audioType: alternateTrack.audioType,
      episodes: mergedAlternate,
      playableCount: alternatePlayableCount,
      sourceUrl: alternateTrack.sourceUrl,
    },
  };
}

export interface PreloadedTvdbProfile {
  bestMatch: TvdbRichMatch;
  fullTvdb: AnimeDetails | null;
}

/**
 * Starts resolving the full TheTVDB profile & official episode guide directly from
 * lightweight navigation hints (tvdbId or title) so the router can run TheTVDB in
 * parallel with the streaming provider playback-link lookup from t = 0.
 */
export async function preloadTheTvdbProfileFromHints(
  fetchHttp: HttpFetcher,
  hints: {
    tvdbId?: number;
    tvdbSlug?: string;
    title?: string;
    mediaType?: CanonicalMediaType;
    year?: string;
  },
  credentials?: CatalogSourceCredentials,
  options: { skipEpisodePageHydration?: boolean } = {}
): Promise<PreloadedTvdbProfile | null> {
  const mediaType = hints.mediaType || 'anime';
  const isMovie = mediaType === 'movie';
  const tvdbId =
    typeof hints.tvdbId === 'number' && Number.isFinite(hints.tvdbId) && hints.tvdbId > 0
      ? Math.trunc(hints.tvdbId)
      : undefined;

  if (tvdbId) {
    const fullTvdb = await fetchTheTvdbDetails(fetchHttp, tvdbId, {
      mediaType,
      credentials,
      slugHint: hints.tvdbSlug,
      titleHint: hints.title,
      includeEpisodes: !isMovie,
      skipEpisodePageHydration: options.skipEpisodePageHydration,
    }).catch(() => null);
    if (!fullTvdb) return null;
    const syntheticMatch: TvdbRichMatch = {
      tvdbId,
      slug: fullTvdb.externalIds?.tvdbSlug,
      mediaType: (fullTvdb.kind as CanonicalMediaType) || mediaType,
      title: fullTvdb.title,
      originalTitle: fullTvdb.originalTitle,
      englishTitle: fullTvdb.alternativeTitle,
      alternativeTitles: fullTvdb.alternativeTitles || [],
      synopsis: fullTvdb.synopsis || '',
      synopsisSource: fullTvdb.synopsisSource,
      synopsisLanguage: fullTvdb.synopsisLanguage,
      poster: fullTvdb.poster || '',
      backdrop: fullTvdb.backdrop || '',
      year: fullTvdb.year,
      firstAirDate: fullTvdb.firstAirDate,
      status: fullTvdb.status,
      studio: fullTvdb.studio,
      network: fullTvdb.network,
      genres: fullTvdb.genres || [],
      originalCountry: fullTvdb.originalCountry,
      originalLanguage: fullTvdb.originalLanguage,
      externalIds: fullTvdb.externalIds || { tvdbId },
      score: 1000,
    };
    return { bestMatch: syntheticMatch, fullTvdb };
  }

  const rawTitle = cleanText(hints.title);
  if (!rawTitle || rawTitle.length < 2) return null;

  const titleInfo = extractSeasonAndPartInfo(rawTitle, '', null);
  const isLaterSeasonOrArc =
    (titleInfo.seasonNumber !== null && titleInfo.seasonNumber > 1) ||
    titleInfo.isFinalSeason ||
    titleInfo.hasColonSubtitle;

  const bestMatch = await findBestTheTvdbMatch(fetchHttp, [rawTitle], {
    mediaType,
    year: isLaterSeasonOrArc ? undefined : hints.year,
  }).catch(() => null);

  if (!bestMatch) return null;

  const fullTvdb = await fetchTheTvdbDetails(fetchHttp, bestMatch.tvdbId, {
    mediaType: bestMatch.mediaType,
    credentials,
    slugHint: bestMatch.slug,
    titleHint: rawTitle,
    includeEpisodes: !isMovie && bestMatch.mediaType !== 'movie',
    skipEpisodePageHydration: options.skipEpisodePageHydration,
  }).catch(() => null);

  return { bestMatch, fullTvdb };
}

/**
 * Builds the anime/movie/series profile & official episode schedule directly from TheTVDB
 * (+ LiveChart.me airing schedule) and attaches playable streaming links from the integrated
 * providers (TopAnimes / Hinata Soul).
 */
export async function enrichServerDetailsWithTheTvdb(
  fetchHttp: HttpFetcher,
  serverDetails: AnimeDetails,
  credentials?: CatalogSourceCredentials,
  extra?: {
    livechartId?: number;
    skipEpisodePageHydration?: boolean;
    preloadedTvdb?: PreloadedTvdbProfile | null;
  }
): Promise<AnimeDetails> {
  const queryTerms = [
    serverDetails.title,
    serverDetails.originalTitle,
    serverDetails.alternativeTitle,
    ...(serverDetails.alternativeTitles || []),
  ].filter((t): t is string => Boolean(t && t.trim()));

  if (!queryTerms.length) return serverDetails;

  const isMovie = serverDetails.kind === 'movie' || /\/filmes\//i.test(serverDetails.url);
  const primaryTitleInfo = extractSeasonAndPartInfo(
    serverDetails.title,
    serverDetails.url,
    serverDetails.audioType
  );
  const primaryAudio: 'DUB' | 'LEG' = primaryTitleInfo.audioType === 'DUB' ? 'DUB' : 'LEG';
  const isLikelyLaterSeasonOrArc =
    (primaryTitleInfo.seasonNumber !== null && primaryTitleInfo.seasonNumber > 1) ||
    primaryTitleInfo.isFinalSeason ||
    primaryTitleInfo.hasColonSubtitle;

  const preloadedMatch = extra?.preloadedTvdb?.bestMatch || null;
  const [bestMatch, liveChartHint] = await Promise.all([
    preloadedMatch
      ? Promise.resolve(preloadedMatch)
      : findBestTheTvdbMatch(fetchHttp, queryTerms, {
          mediaType: serverDetails.kind || (isMovie ? 'movie' : 'anime'),
          year: isLikelyLaterSeasonOrArc ? undefined : serverDetails.year,
        }),
    !isMovie
      ? findLiveChartScheduleHint(fetchHttp, {
          livechartId: extra?.livechartId ?? serverDetails.externalIds?.livechartId,
          titles: queryTerms,
        }).catch(() => null)
      : Promise.resolve(null),
  ]);

  if (!bestMatch) {
    const unifiedWithoutTvdb = !isMovie
      ? await unifyServerSeasonsWithCatalog(fetchHttp, serverDetails, [], queryTerms).catch(
          () => null
        )
      : null;
    const activeEpisodes = unifiedWithoutTvdb?.serverEpisodes || serverDetails.episodes;
    const activeTitle = unifiedWithoutTvdb?.unifiedTitle || serverDetails.title;
    const activeSeasonsCount =
      unifiedWithoutTvdb && unifiedWithoutTvdb.unifiedSeasonCount > 1
        ? String(unifiedWithoutTvdb.unifiedSeasonCount)
        : serverDetails.seasonsCount;
    const cleanAltTitle = stripSeasonFromTitle(activeTitle) || activeTitle;

    if (!isMovie && liveChartHint) {
      const mergedWithSchedule = mergeServerAndCatalogEpisodes({
        serverTitle: serverDetails.title,
        serverUrl: serverDetails.url,
        serverEpisodes: activeEpisodes,
        catalogEpisodes: [],
        liveChartHint,
        serverMatched: activeEpisodes.length > 0,
        mediaType: (serverDetails.kind as CanonicalMediaType) || 'anime',
        unifyAllSeasons: true,
      });
      const audioTracks = buildDualAudioTracks({
        primaryAudio: unifiedWithoutTvdb?.primaryAudioType || primaryAudio,
        primaryEpisodes: mergedWithSchedule,
        primarySourceUrl: serverDetails.url,
        alternateTrack: unifiedWithoutTvdb?.alternateAudioTrack,
        mergeAlternateEpisodes: (altEps, altUrl) =>
          mergeServerAndCatalogEpisodes({
            serverTitle: cleanAltTitle,
            serverUrl: altUrl,
            serverEpisodes: altEps,
            catalogEpisodes: [],
            liveChartHint,
            serverMatched: altEps.length > 0,
            mediaType: (serverDetails.kind as CanonicalMediaType) || 'anime',
            unifyAllSeasons: true,
          }),
      });
      return {
        ...serverDetails,
        title: activeTitle,
        seasonsCount: activeSeasonsCount,
        episodes: mergedWithSchedule,
        ...(audioTracks ? { audioTracks } : {}),
      };
    }

    const fallbackAudioTracks = !isMovie
      ? buildDualAudioTracks({
          primaryAudio: unifiedWithoutTvdb?.primaryAudioType || primaryAudio,
          primaryEpisodes: activeEpisodes,
          primarySourceUrl: serverDetails.url,
          alternateTrack: unifiedWithoutTvdb?.alternateAudioTrack,
          mergeAlternateEpisodes: (altEps) => altEps,
        })
      : undefined;

    if (
      unifiedWithoutTvdb &&
      (unifiedWithoutTvdb.addedSeasonPages > 0 || Boolean(fallbackAudioTracks))
    ) {
      return {
        ...serverDetails,
        title: activeTitle,
        seasonsCount: activeSeasonsCount,
        episodes: activeEpisodes,
        ...(fallbackAudioTracks ? { audioTracks: fallbackAudioTracks } : {}),
      };
    }
    return serverDetails;
  }

  // Fetch full TheTVDB details page + official episodes guide for non-movies (reusing parallel preload when available)
  const fullTvdb =
    extra?.preloadedTvdb &&
    extra.preloadedTvdb.bestMatch.tvdbId === bestMatch.tvdbId &&
    extra.preloadedTvdb.fullTvdb
      ? extra.preloadedTvdb.fullTvdb
      : await fetchTheTvdbDetails(fetchHttp, bestMatch.tvdbId, {
          mediaType: bestMatch.mediaType,
          credentials,
          slugHint: bestMatch.slug,
          includeEpisodes: !isMovie && bestMatch.mediaType !== 'movie',
          skipEpisodePageHydration: extra?.skipEpisodePageHydration,
        }).catch(() => null);

  const tvdb = fullTvdb || null;
  const resolvedKind: CanonicalMediaType =
    serverDetails.kind === 'movie' || bestMatch.mediaType === 'movie'
      ? 'movie'
      : serverDetails.kind === 'series'
        ? 'series'
        : bestMatch.mediaType;

  const extraReferenceTitles = [
    serverDetails.originalTitle || '',
    serverDetails.alternativeTitle || '',
    ...(serverDetails.alternativeTitles || []),
    tvdb?.title || '',
    tvdb?.originalTitle || '',
    tvdb?.alternativeTitle || '',
    ...(tvdb?.alternativeTitles || []),
    bestMatch.title,
    bestMatch.originalTitle || '',
    bestMatch.englishTitle || '',
    ...bestMatch.alternativeTitles,
  ].filter(Boolean);

  const [resolvedLiveChartHint, unifiedSeasons] = await Promise.all([
    liveChartHint
      ? Promise.resolve(liveChartHint)
      : !isMovie
        ? findLiveChartScheduleHint(fetchHttp, {
            livechartId: extra?.livechartId ?? serverDetails.externalIds?.livechartId,
            titles: extraReferenceTitles,
          }).catch(() => null)
        : Promise.resolve(null),
    resolvedKind !== 'movie'
      ? unifyServerSeasonsWithCatalog(
          fetchHttp,
          serverDetails,
          tvdb?.episodes || [],
          extraReferenceTitles
        ).catch(() => null)
      : Promise.resolve(null),
  ]);

  const mergedIds: ExternalMediaIds = {
    ...serverDetails.externalIds,
    ...bestMatch.externalIds,
    ...tvdb?.externalIds,
    ...(resolvedLiveChartHint?.livechartId
      ? { livechartId: resolvedLiveChartHint.livechartId }
      : {}),
  };

  const resolvedTitle = unifiedSeasons?.unifiedTitle || serverDetails.title;

  const altTitles = Array.from(
    new Set(
      [
        serverDetails.title,
        serverDetails.alternativeTitle,
        serverDetails.originalTitle,
        ...(serverDetails.alternativeTitles || []),
        tvdb?.title,
        tvdb?.originalTitle,
        tvdb?.alternativeTitle,
        ...(tvdb?.alternativeTitles || []),
        bestMatch.title,
        bestMatch.originalTitle,
        bestMatch.englishTitle,
        ...bestMatch.alternativeTitles,
      ]
        .map((t) => cleanText(t))
        .filter((t) => t && t.toLowerCase() !== resolvedTitle.toLowerCase())
    )
  ).slice(0, 10);

  const tvdbGenres = tvdb?.genres?.length ? tvdb.genres : bestMatch.genres;
  let tvdbSynopsis = tvdb?.synopsis || '';
  let tvdbSynopsisSource = tvdb?.synopsis ? tvdb.synopsisSource : undefined;
  let tvdbSynopsisLanguage = tvdb?.synopsis ? tvdb.synopsisLanguage : undefined;

  if (!tvdbSynopsis && bestMatch.synopsis) {
    tvdbSynopsis = bestMatch.synopsis;
    tvdbSynopsisSource = bestMatch.synopsisSource;
    tvdbSynopsisLanguage = bestMatch.synopsisLanguage;
    if (tvdbSynopsisSource === 'thetvdb-en') {
      const translated = await translateEnglishToPtBr(fetchHttp, tvdbSynopsis).catch(() => null);
      if (translated) {
        tvdbSynopsis = translated;
        tvdbSynopsisSource = 'thetvdb-google-translate';
        tvdbSynopsisLanguage = 'pt-BR';
      }
    }
  }

  const resolvedPoster = tvdb?.poster || bestMatch.poster || serverDetails.poster;
  const fallbackPoster =
    serverDetails.poster && serverDetails.poster !== resolvedPoster
      ? serverDetails.poster
      : undefined;
  const resolvedBackdrop =
    tvdb?.backdrop ||
    bestMatch.backdrop ||
    tvdb?.poster ||
    bestMatch.poster ||
    serverDetails.backdrop ||
    serverDetails.poster;
  const providerBackdropCandidate = serverDetails.backdrop || serverDetails.poster;
  const fallbackBackdrop =
    providerBackdropCandidate && providerBackdropCandidate !== resolvedBackdrop
      ? providerBackdropCandidate
      : undefined;

  const unifiedServerEps = unifiedSeasons?.serverEpisodes || serverDetails.episodes;

  const mergedEpisodes =
    resolvedKind === 'movie'
      ? serverDetails.episodes.map((ep) => {
          const tvdbMovieThumb = tvdb?.backdrop || bestMatch.backdrop || tvdb?.poster || bestMatch.poster;
          return {
            ...ep,
            thumb: tvdbMovieThumb || ep.thumb,
            ...(tvdbMovieThumb && ep.thumb && ep.thumb !== tvdbMovieThumb
              ? { fallbackThumb: ep.thumb }
              : {}),
          };
        })
      : mergeServerAndCatalogEpisodes({
          serverTitle: resolvedTitle,
          serverUrl: serverDetails.url,
          serverEpisodes: unifiedServerEps,
          catalogEpisodes: tvdb?.episodes || [],
          liveChartHint: resolvedLiveChartHint,
          serverMatched: unifiedServerEps.length > 0,
          tvdbId: bestMatch.tvdbId,
          mediaType: resolvedKind,
          unifyAllSeasons: true,
        });

  const cleanAlternateTitle = stripSeasonFromTitle(resolvedTitle) || resolvedTitle;
  const audioTracks =
    resolvedKind !== 'movie'
      ? buildDualAudioTracks({
          primaryAudio: unifiedSeasons?.primaryAudioType || primaryAudio,
          primaryEpisodes: mergedEpisodes,
          primarySourceUrl: serverDetails.url,
          alternateTrack: unifiedSeasons?.alternateAudioTrack,
          mergeAlternateEpisodes: (altEps, altUrl) =>
            mergeServerAndCatalogEpisodes({
              serverTitle: cleanAlternateTitle,
              serverUrl: altUrl,
              serverEpisodes: altEps,
              catalogEpisodes: tvdb?.episodes || [],
              liveChartHint: resolvedLiveChartHint,
              serverMatched: altEps.length > 0,
              tvdbId: bestMatch.tvdbId,
              mediaType: resolvedKind,
              unifyAllSeasons: true,
            }),
        })
      : undefined;

  const mergedSeasonCount =
    resolvedKind !== 'movie' && mergedEpisodes.length > 0
      ? new Set(mergedEpisodes.map((ep) => ep.seasonNumber || 1)).size
      : 0;

  return {
    ...serverDetails,
    title: resolvedTitle,
    kind: resolvedKind,
    catalogSource: 'thetvdb',
    externalIds: mergedIds,
    enrichmentSources: ['thetvdb'],
    externalLinks: buildExternalDatabaseLinks(mergedIds, { mediaType: resolvedKind }),
    originalTitle: tvdb?.originalTitle || bestMatch.originalTitle || serverDetails.originalTitle,
    alternativeTitle:
      tvdb?.title && tvdb.title.toLowerCase() !== resolvedTitle.toLowerCase()
        ? tvdb.title
        : tvdb?.alternativeTitle || serverDetails.alternativeTitle,
    alternativeTitles: altTitles,
    poster: resolvedPoster,
    ...(fallbackPoster ? { fallbackPoster } : {}),
    backdrop: resolvedBackdrop,
    ...(fallbackBackdrop ? { fallbackBackdrop } : {}),
    synopsis: tvdbSynopsis || serverDetails.synopsis,
    synopsisSource: tvdbSynopsis ? tvdbSynopsisSource : serverDetails.synopsisSource,
    synopsisLanguage: tvdbSynopsis ? tvdbSynopsisLanguage : serverDetails.synopsisLanguage,
    year: tvdb?.year || bestMatch.year || serverDetails.year,
    rating: tvdb?.rating || serverDetails.rating,
    firstAirDate: tvdb?.firstAirDate || bestMatch.firstAirDate || serverDetails.firstAirDate,
    lastAirDate: tvdb?.lastAirDate || serverDetails.lastAirDate,
    averageDuration: tvdb?.averageDuration || serverDetails.averageDuration,
    seasonsCount:
      mergedSeasonCount > 0
        ? String(mergedSeasonCount)
        : tvdb?.seasonsCount || serverDetails.seasonsCount,
    status: tvdb?.status || bestMatch.status || serverDetails.status,
    studio: tvdb?.studio || bestMatch.studio || serverDetails.studio,
    network: tvdb?.network || bestMatch.network || serverDetails.network,
    originalCountry: tvdb?.originalCountry || bestMatch.originalCountry,
    originalLanguage: tvdb?.originalLanguage || bestMatch.originalLanguage,
    genres: tvdbGenres.length > 0 ? tvdbGenres : serverDetails.genres,
    episodes: mergedEpisodes,
    ...(audioTracks ? { audioTracks } : {}),
  };
}

export interface TvdbEpisodeTranslations {
  ptBrOverview?: string;
  ptBrTitle?: string;
  engOverview?: string;
  engTitle?: string;
  originalTitle?: string;
  episodeImage?: string;
  tvdbEpisodeId?: number;
  tvdbSeriesId?: number;
}

/**
 * Parses a public TheTVDB.com episode HTML page (`/series/{slug}/episodes/{id}`)
 * and extracts strictly PT-BR (`pt`) and English (`eng`) overviews, episode titles, and artwork.
 */
export function parseTvdbEpisodePageHtml(html: string): TvdbEpisodeTranslations {
  const $ = cheerio.load(html);
  const translations = new Map<string, { title: string; synopsis: string }>();

  $('.change_translation_text[data-language]').each((_, el) => {
    const lang = cleanText($(el).attr('data-language')).toLowerCase();
    if (!lang) return;
    const extracted = extractCleanTranslationText($, el);
    translations.set(lang, { title: extracted.title, synopsis: extracted.synopsis });
  });

  // Strictly PT-BR on TheTVDB (`pt` = Portuguese - Brazil; `por` is European Portuguese)
  const ptBrBlock =
    translations.get('pt') || translations.get('pt-br') || translations.get('pt_br');
  const engBlock = translations.get('eng') || translations.get('en');
  const jpnBlock = translations.get('jpn') || translations.get('ja');
  const rawH1 = cleanText($('h1#episode_title, h1.translated_title, h1').first().text());
  const candidateOriginalTitle =
    jpnBlock?.title ||
    (rawH1 && !/^(?:tba|tbd)$/i.test(rawH1) ? rawH1 : '');

  let episodeImage = '';
  $('img').each((_, img) => {
    if (episodeImage) return;
    const rawSrc = $(img).attr('data-src') || $(img).attr('data-original') || $(img).attr('src') || '';
    const valid = isValidArtworkUrl(rawSrc);
    if (valid && /\/banners\/.*(?:episode|episodes|screencap)/i.test(valid)) {
      episodeImage = valid;
    }
  });
  if (!episodeImage) {
    const ogImg = isValidArtworkUrl($('meta[property="og:image"]').attr('content'));
    if (ogImg) episodeImage = ogImg;
  }

  return {
    ptBrOverview: ptBrBlock?.synopsis || undefined,
    ptBrTitle: ptBrBlock?.title || undefined,
    engOverview: engBlock?.synopsis || undefined,
    engTitle: engBlock?.title || undefined,
    ...(candidateOriginalTitle &&
    candidateOriginalTitle !== ptBrBlock?.title &&
    candidateOriginalTitle !== engBlock?.title
      ? { originalTitle: candidateOriginalTitle }
      : {}),
    ...(episodeImage ? { episodeImage } : {}),
  };
}

function matchTvdbEpisodeFromList(
  episodes: AnimeEpisodeLink[],
  seasonNumber: number,
  episodeNumber: number
): AnimeEpisodeLink | undefined {
  if (!episodes.length || !Number.isFinite(episodeNumber) || episodeNumber <= 0) return undefined;

  const targetSeason = Number.isFinite(seasonNumber) && seasonNumber > 0 ? seasonNumber : 1;
  const exact = episodes.find(
    (ep) => (ep.seasonNumber || 1) === targetSeason && ep.episodeNumber === episodeNumber
  );
  if (exact) return exact;

  // Absolute episode numbering fallback (e.g. provider lists Episode 25 for Season 2 Ep 1)
  if (targetSeason === 1 && episodeNumber <= episodes.length) {
    return episodes[episodeNumber - 1];
  }

  return episodes.find((ep) => ep.episodeNumber === episodeNumber);
}

/**
 * Fetches localized PT-BR and EN episode overview translations & artwork from TheTVDB.com
 * for a given episode (by tvdbEpisodeId, tvdbId/tvdbSlug, or series title + season/episode).
 */
export async function fetchTheTvdbEpisodeTranslations(
  fetchHttp: HttpFetcher,
  options: {
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
): Promise<TvdbEpisodeTranslations | null> {
  const useCache = options.useCache !== false;
  let tvdbEpisodeId =
    options.tvdbEpisodeId && options.tvdbEpisodeId > 0 ? options.tvdbEpisodeId : undefined;
  let tvdbSeriesId = options.tvdbId && options.tvdbId > 0 ? options.tvdbId : undefined;
  let tvdbSlug = cleanText(options.tvdbSlug) || undefined;
  let fallbackEngOverview = cleanText(options.fallbackEnglishOverview) || undefined;
  let fallbackEpisodeImage: string | undefined;

  // 1. Resolve tvdbEpisodeId via series episode guide if we don't already have it
  if (!tvdbEpisodeId) {
    const seasonNum =
      options.seasonNumber && options.seasonNumber > 0 ? options.seasonNumber : 1;
    const epNum = options.episodeNumber && options.episodeNumber > 0 ? options.episodeNumber : 0;
    if (!epNum) {
      return fallbackEngOverview ? { engOverview: fallbackEngOverview } : null;
    }

    if (!tvdbSeriesId && !tvdbSlug) {
      const searchTerms = [
        options.title,
        options.originalTitle,
        ...(options.alternativeTitles || []),
      ].filter((x): x is string => Boolean(x && x.trim().length >= 2));

      if (searchTerms.length > 0) {
        const bestMatch = await findBestTheTvdbMatch(fetchHttp, searchTerms, {
          mediaType: options.mediaType === 'series' ? 'series' : 'anime',
          year: options.year,
        }).catch(() => null);
        if (bestMatch) {
          tvdbSeriesId = bestMatch.tvdbId;
          tvdbSlug = bestMatch.slug || undefined;
        }
      }
    }

    let seriesEpisodes: AnimeEpisodeLink[] = [];
    if (tvdbSlug) {
      try {
        const epsRes = await fetchHttp(
          `${TVDB_WEB_ORIGIN}/series/${encodeURIComponent(tvdbSlug)}/allseasons/official`,
          {
            referer: `${TVDB_WEB_ORIGIN}/series/${encodeURIComponent(tvdbSlug)}`,
            timeoutMs: 9000,
          }
        );
        if (epsRes.ok) {
          seriesEpisodes = parseTvdbAllSeasonsHtml(
            epsRes.body,
            tvdbSeriesId || 0,
            options.mediaType || 'anime'
          );
        }
      } catch {
        // fall through to fetchTheTvdbDetails below
      }
    }

    if (seriesEpisodes.length === 0 && tvdbSeriesId) {
      const details = await fetchTheTvdbDetails(fetchHttp, tvdbSeriesId, {
        mediaType: options.mediaType || 'anime',
        slugHint: tvdbSlug,
        credentials: options.credentials,
        includeEpisodes: true,
        skipEpisodePageHydration: true,
      }).catch(() => null);
      if (details) {
        seriesEpisodes = details.episodes;
        tvdbSlug = tvdbSlug || details.externalIds?.tvdbSlug;
      }
    }

    const matched = matchTvdbEpisodeFromList(seriesEpisodes, seasonNum, epNum);
    if (matched) {
      tvdbEpisodeId = matched.tvdbEpisodeId;
      if (!fallbackEngOverview && matched.overview) {
        fallbackEngOverview = cleanText(matched.overview) || undefined;
      }
      if (matched.thumb) {
        fallbackEpisodeImage = matched.thumb;
      }
    }
  }

  if (!tvdbEpisodeId) {
    return fallbackEngOverview
      ? {
          engOverview: fallbackEngOverview,
          ...(fallbackEpisodeImage ? { episodeImage: fallbackEpisodeImage } : {}),
          tvdbSeriesId,
        }
      : null;
  }

  // Instant shared cache hit (pre-warmed when opening the anime page!)
  if (useCache) {
    const cached = readTvdbEpisodePageCache(tvdbEpisodeId);
    if (cached) {
      const episodeImage = cached.episodeImage || fallbackEpisodeImage;
      return {
        ptBrOverview: cached.ptBrOverview,
        ptBrTitle: cached.ptBrTitle,
        engOverview: cached.engOverview || fallbackEngOverview,
        engTitle: cached.engTitle,
        ...(cached.originalTitle ? { originalTitle: cached.originalTitle } : {}),
        ...(episodeImage ? { episodeImage } : {}),
        tvdbEpisodeId,
        tvdbSeriesId: cached.tvdbSeriesId ?? tvdbSeriesId,
      };
    }
  }

  // 2. Try official TheTVDB v4 API episode translations when API key is configured
  const token = await getTvdbBearerToken(fetchHttp, options.credentials);
  if (token) {
    try {
      const [ptRes, engRes, baseRes] = await Promise.all([
        fetchHttp(`${TVDB_V4_API_BASE}/episodes/${tvdbEpisodeId}/translations/pt`, {
          accept: 'application/json',
          headers: { Authorization: `Bearer ${token}` },
          timeoutMs: 6500,
        }).catch(() => null),
        fetchHttp(`${TVDB_V4_API_BASE}/episodes/${tvdbEpisodeId}/translations/eng`, {
          accept: 'application/json',
          headers: { Authorization: `Bearer ${token}` },
          timeoutMs: 6500,
        }).catch(() => null),
        !fallbackEpisodeImage
          ? fetchHttp(`${TVDB_V4_API_BASE}/episodes/${tvdbEpisodeId}`, {
              accept: 'application/json',
              headers: { Authorization: `Bearer ${token}` },
              timeoutMs: 6500,
            }).catch(() => null)
          : Promise.resolve(null),
      ]);

      let ptBrOverview: string | undefined;
      let ptBrTitle: string | undefined;
      let engOverview: string | undefined;
      let engTitle: string | undefined;
      let apiImage = fallbackEpisodeImage;

      if (ptRes?.ok) {
        const parsed = JSON.parse(ptRes.body) as { data?: { name?: string; overview?: string } };
        ptBrOverview = cleanText(parsed.data?.overview) || undefined;
        ptBrTitle = cleanText(parsed.data?.name) || undefined;
      }
      if (engRes?.ok) {
        const parsed = JSON.parse(engRes.body) as { data?: { name?: string; overview?: string } };
        engOverview = cleanText(parsed.data?.overview) || undefined;
        engTitle = cleanText(parsed.data?.name) || undefined;
      }
      if (!apiImage && baseRes?.ok) {
        const parsed = JSON.parse(baseRes.body) as { data?: { image?: string } };
        const validImg = isValidArtworkUrl(parsed.data?.image);
        if (validImg) apiImage = validImg;
      }

      if (ptBrOverview || engOverview) {
        const v4Result: TvdbEpisodeTranslations = {
          ptBrOverview,
          ptBrTitle,
          engOverview: engOverview || fallbackEngOverview,
          engTitle,
          ...(apiImage ? { episodeImage: apiImage } : {}),
          tvdbEpisodeId,
          tvdbSeriesId,
        };
        if (useCache) writeTvdbEpisodePageCache(tvdbEpisodeId, v4Result);
        return v4Result;
      }
    } catch {
      // Fall through to public TheTVDB.com episode HTML page
    }
  }

  // 3. Public TheTVDB.com episode page (zero API key required)
  const parsed = await fetchPublicTvdbEpisodePage(fetchHttp, tvdbEpisodeId, {
    tvdbSlug,
    tvdbSeriesId,
    timeoutMs: 9000,
    useCache,
  });
  if (parsed) {
    const episodeImage = parsed.episodeImage || fallbackEpisodeImage;
    return {
      ptBrOverview: parsed.ptBrOverview,
      ptBrTitle: parsed.ptBrTitle,
      engOverview: parsed.engOverview || fallbackEngOverview,
      engTitle: parsed.engTitle,
      ...(parsed.originalTitle ? { originalTitle: parsed.originalTitle } : {}),
      ...(episodeImage ? { episodeImage } : {}),
      tvdbEpisodeId,
      tvdbSeriesId,
    };
  }

  if (fallbackEngOverview) {
    return {
      engOverview: fallbackEngOverview,
      ...(fallbackEpisodeImage ? { episodeImage: fallbackEpisodeImage } : {}),
      tvdbEpisodeId,
      tvdbSeriesId,
    };
  }

  return null;
}

export interface TvdbMediaTranslations {
  ptBrOverview?: string;
  engOverview?: string;
  poster?: string;
  backdrop?: string;
  tvdbId?: number;
  tvdbSlug?: string;
}

/**
 * Parses a public TheTVDB.com series or movie HTML page and extracts strictly
 * PT-BR (`pt`) and English (`eng`) synopses plus official poster & backdrop artwork.
 */
export function parseTvdbMediaPageTranslations(html: string): TvdbMediaTranslations {
  const $ = cheerio.load(html);
  const translations = new Map<string, { title: string; synopsis: string }>();

  $('.change_translation_text[data-language]').each((_, el) => {
    const lang = cleanText($(el).attr('data-language')).toLowerCase();
    if (!lang) return;
    const extracted = extractCleanTranslationText($, el);
    translations.set(lang, { title: extracted.title, synopsis: extracted.synopsis });
  });

  // Strictly PT-BR on TheTVDB (`pt` = Portuguese - Brazil; `por` is European Portuguese)
  const ptBrBlock =
    translations.get('pt') || translations.get('pt-br') || translations.get('pt_br');
  const engBlock = translations.get('eng') || translations.get('en');

  let poster = '';
  $('img').each((_, img) => {
    if (poster) return;
    const $img = $(img);
    const src = $img.attr('data-src') || $img.attr('data-original') || $img.attr('src') || '';
    const valid = isValidArtworkUrl(src);
    if (valid && /\/banners\/.*\/posters\//i.test(valid)) {
      poster = valid;
    }
  });
  if (!poster) {
    poster =
      isValidArtworkUrl($('meta[property="og:image"]').attr('content')) ||
      isValidArtworkUrl(
        $('img.img-responsive').first().attr('data-src') ||
          $('img.img-responsive').first().attr('src')
      );
  }

  let backdrop = '';
  const bgMatch = html.match(
    /(?:https?:)?\/\/artworks\.thetvdb\.com\/banners\/[^"'\s)]+(?:backgrounds|fanart|banners)\/[^"'\s)]+/i
  );
  if (bgMatch?.[0]) backdrop = isValidArtworkUrl(bgMatch[0]);
  if (!backdrop) backdrop = poster;

  return {
    ptBrOverview: ptBrBlock?.synopsis || undefined,
    engOverview: engBlock?.synopsis || undefined,
    ...(poster ? { poster } : {}),
    ...(backdrop ? { backdrop } : {}),
  };
}

/**
 * Fetches localized PT-BR and EN series/movie synopses & artwork from TheTVDB.com
 * (by tvdbId/tvdbSlug or title/originalTitle/year), mirroring episode synopsis resolution.
 */
export async function fetchTheTvdbMediaTranslations(
  fetchHttp: HttpFetcher,
  options: {
    title?: string;
    originalTitle?: string;
    alternativeTitles?: string[];
    year?: string;
    mediaType?: CanonicalMediaType;
    tvdbId?: number;
    tvdbSlug?: string;
    fallbackEnglishOverview?: string;
    credentials?: CatalogSourceCredentials;
  }
): Promise<TvdbMediaTranslations | null> {
  let tvdbId = options.tvdbId && options.tvdbId > 0 ? options.tvdbId : undefined;
  let tvdbSlug = cleanText(options.tvdbSlug) || undefined;
  let mediaType: CanonicalMediaType = options.mediaType || 'anime';
  let fallbackEngOverview = cleanText(options.fallbackEnglishOverview) || undefined;
  let fallbackPtBrOverview: string | undefined;
  let fallbackPoster: string | undefined;
  let fallbackBackdrop: string | undefined;

  // 1. Resolve tvdbId / tvdbSlug via keyless search if missing
  if (!tvdbId && !tvdbSlug) {
    const searchTerms = [
      options.title,
      options.originalTitle,
      ...(options.alternativeTitles || []),
    ].filter((x): x is string => Boolean(x && x.trim().length >= 2));

    if (searchTerms.length > 0) {
      const bestMatch = await findBestTheTvdbMatch(fetchHttp, searchTerms, {
        mediaType,
        year: options.year,
      }).catch(() => null);
      if (bestMatch) {
        tvdbId = bestMatch.tvdbId;
        tvdbSlug = bestMatch.slug || undefined;
        mediaType = bestMatch.mediaType;
        if (bestMatch.poster) fallbackPoster = bestMatch.poster;
        if (bestMatch.backdrop) fallbackBackdrop = bestMatch.backdrop;
        if (bestMatch.synopsis) {
          if (bestMatch.synopsisSource === 'thetvdb-pt-br') {
            fallbackPtBrOverview = bestMatch.synopsis;
          } else if (!fallbackEngOverview) {
            fallbackEngOverview = bestMatch.synopsis;
          }
        }
      }
    }
  }

  if (!tvdbId && !tvdbSlug) {
    return fallbackPtBrOverview || fallbackEngOverview
      ? {
          ptBrOverview: fallbackPtBrOverview,
          engOverview: fallbackEngOverview,
          ...(fallbackPoster ? { poster: fallbackPoster } : {}),
          ...(fallbackBackdrop ? { backdrop: fallbackBackdrop } : {}),
        }
      : null;
  }

  const isMovie = mediaType === 'movie';
  const apiSegment = isMovie ? 'movies' : 'series';

  // 2. Try official TheTVDB v4 API translations when API key is configured
  const token = await getTvdbBearerToken(fetchHttp, options.credentials);
  if (token && tvdbId) {
    try {
      const [ptRes, engRes, baseRes] = await Promise.all([
        fetchHttp(`${TVDB_V4_API_BASE}/${apiSegment}/${tvdbId}/translations/pt`, {
          accept: 'application/json',
          headers: { Authorization: `Bearer ${token}` },
          timeoutMs: 6500,
        }).catch(() => null),
        fetchHttp(`${TVDB_V4_API_BASE}/${apiSegment}/${tvdbId}/translations/eng`, {
          accept: 'application/json',
          headers: { Authorization: `Bearer ${token}` },
          timeoutMs: 6500,
        }).catch(() => null),
        !fallbackPoster
          ? fetchHttp(`${TVDB_V4_API_BASE}/${apiSegment}/${tvdbId}`, {
              accept: 'application/json',
              headers: { Authorization: `Bearer ${token}` },
              timeoutMs: 6500,
            }).catch(() => null)
          : Promise.resolve(null),
      ]);

      let ptBrOverview: string | undefined;
      let engOverview: string | undefined;
      let apiPoster = fallbackPoster;

      if (ptRes?.ok) {
        const parsed = JSON.parse(ptRes.body) as { data?: { overview?: string } };
        ptBrOverview = cleanText(parsed.data?.overview) || undefined;
      }
      if (engRes?.ok) {
        const parsed = JSON.parse(engRes.body) as { data?: { overview?: string } };
        engOverview = cleanText(parsed.data?.overview) || undefined;
      }
      if (!apiPoster && baseRes?.ok) {
        const parsed = JSON.parse(baseRes.body) as { data?: { image?: string } };
        const validImg = isValidArtworkUrl(parsed.data?.image);
        if (validImg) apiPoster = validImg;
      }

      if (ptBrOverview || engOverview) {
        return {
          ptBrOverview,
          engOverview: engOverview || fallbackEngOverview,
          ...(apiPoster ? { poster: apiPoster } : {}),
          ...(fallbackBackdrop || apiPoster ? { backdrop: fallbackBackdrop || apiPoster } : {}),
          tvdbId,
          tvdbSlug,
        };
      }
    } catch {
      // Fall through to public TheTVDB.com HTML page
    }
  }

  // 3. Public TheTVDB.com series/movie page (zero API key required)
  const pageUrl = tvdbSlug
    ? `${TVDB_WEB_ORIGIN}/${isMovie ? 'movies' : 'series'}/${encodeURIComponent(tvdbSlug)}`
    : `${TVDB_WEB_ORIGIN}/dereferrer/${isMovie ? 'movie' : 'series'}/${tvdbId}`;

  try {
    const res = await fetchHttp(pageUrl, {
      referer: `${TVDB_WEB_ORIGIN}/`,
      timeoutMs: 9000,
    });
    if (res.ok) {
      const parsed = parseTvdbMediaPageTranslations(res.body);
      const poster = parsed.poster || fallbackPoster;
      const backdrop = parsed.backdrop || fallbackBackdrop || poster;
      return {
        ptBrOverview: parsed.ptBrOverview || fallbackPtBrOverview,
        engOverview: parsed.engOverview || fallbackEngOverview,
        ...(poster ? { poster } : {}),
        ...(backdrop ? { backdrop } : {}),
        tvdbId,
        tvdbSlug,
      };
    }
  } catch {
    // Fall back to search overview if available
  }

  if (fallbackPtBrOverview || fallbackEngOverview) {
    return {
      ptBrOverview: fallbackPtBrOverview,
      engOverview: fallbackEngOverview,
      ...(fallbackPoster ? { poster: fallbackPoster } : {}),
      ...(fallbackBackdrop ? { backdrop: fallbackBackdrop } : {}),
      tvdbId,
      tvdbSlug,
    };
  }

  return null;
}
