import * as cheerio from 'cheerio';
import { mergeServerAndCatalogEpisodes } from '../../episodeAvailability.ts';
import type { HttpFetcher } from '../../httpTypes.ts';
import type {
  AnimeDetails,
  AnimeEpisodeLink,
  CatalogSourceCredentials,
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
  const cleaned = cleanText(raw);
  if (!cleaned) return '';
  if (/\/images\/missing\//i.test(cleaned)) return '';
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
  const synopsis = pickPreferredTranslation(hit.overviews, hit.overview);

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
    synopsis,
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
): Promise<Array<{ hit: TvdbWebSearchHit; parsed: TvdbRichMatch }>> {
  const cleanQuery = query.trim();
  if (!cleanQuery) return [];

  const facetFilters =
    options.mediaType === 'movie'
      ? [['type:movie']]
      : options.mediaType === 'series' || options.mediaType === 'anime'
        ? [['type:series']]
        : [['type:series', 'type:movie']];

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
              hitsPerPage: Math.min(20, Math.max(5, options.limit || 12)),
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
    const out: Array<{ hit: TvdbWebSearchHit; parsed: TvdbRichMatch }> = [];
    for (const hit of hits) {
      const parsed = parseTvdbWebSearchHit(hit);
      if (parsed) out.push({ hit, parsed });
    }
    return out;
  } catch {
    return [];
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
  for (const raw of terms) {
    const t = cleanText(raw);
    if (t.length < 2) continue;
    if (!uniqueTerms.some((x) => x.toLowerCase() === t.toLowerCase())) {
      uniqueTerms.push(t);
    }
    const stripped = stripSeasonFromTitle(t);
    if (
      stripped.length >= 2 &&
      stripped.toLowerCase() !== t.toLowerCase() &&
      !uniqueTerms.some((x) => x.toLowerCase() === stripped.toLowerCase())
    ) {
      uniqueTerms.push(stripped);
    }
    if (uniqueTerms.length >= 4) break;
  }
  if (!uniqueTerms.length) return null;

  const searchType: 'all' | 'anime' | 'series' | 'movie' =
    options.mediaType === 'movie'
      ? 'movie'
      : options.mediaType === 'anime' || options.mediaType === 'series'
        ? options.mediaType
        : 'all';

  let best: { match: TvdbRichMatch; rank: number; sim: number } | null = null;

  for (const term of uniqueTerms.slice(0, 2)) {
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

  const ptBlock = translations.get('pt') || translations.get('por');
  const engBlock = translations.get('eng');
  const jpnBlock = translations.get('jpn');

  const title = ptBlock?.title || engBlock?.title || rawH1 || ogTitle;
  if (!title) return null;

  const synopsis =
    ptBlock?.synopsis ||
    engBlock?.synopsis ||
    cleanText($('meta[property="og:description"], meta[name="description"]').attr('content'));

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
  for (const b of [ptBlock, engBlock, jpnBlock]) {
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
  $('img.img-responsive').each((_, img) => {
    if (poster) return;
    const src = $(img).attr('src') || $(img).attr('data-src') || '';
    if (/artworks\.thetvdb\.com\/banners\/.*\/posters\//i.test(src)) {
      poster = isValidArtworkUrl(src);
    }
  });
  if (!poster) {
    poster =
      isValidArtworkUrl($('meta[property="og:image"]').attr('content')) ||
      isValidArtworkUrl($('img.img-responsive').first().attr('src'));
  }

  let backdrop = '';
  const bgMatch = html.match(/https:\/\/artworks\.thetvdb\.com\/banners\/[^"'\s)]+(?:backgrounds|fanart|banners)\/[^"'\s)]+/i);
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

    const rawTitle = cleanText($li.find('h4 a').first().text());
    const date = cleanText($li.find('ul.list-inline li').first().text()) || undefined;
    const overview = cleanText($li.find('.list-group-item-text p').first().text()) || undefined;
    const imgEl = $li.find('img').first();
    const thumb = isValidArtworkUrl(imgEl.attr('data-src') || imgEl.attr('src')) || undefined;

    const title = rawTitle ? `Episódio ${episodeNumber} — ${rawTitle}` : `Episódio ${episodeNumber}`;
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
    });
  });

  episodes.sort((a, b) => (a.seasonNumber || 1) - (b.seasonNumber || 1) || (a.episodeNumber || 0) - (b.episodeNumber || 0));
  return episodes;
}

export async function fetchTheTvdbDetails(
  fetchHttp: HttpFetcher,
  tvdbId: number,
  options: {
    mediaType?: CanonicalMediaType;
    credentials?: CatalogSourceCredentials;
    slugHint?: string;
    includeEpisodes?: boolean;
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
          ? fetchHttp(`${TVDB_V4_API_BASE}/series/${tvdbId}/episodes/default/pt?page=0`, {
              accept: 'application/json',
              headers: { Authorization: `Bearer ${token}` },
              timeoutMs: 9000,
            }).catch(() =>
              fetchHttp(`${TVDB_V4_API_BASE}/series/${tvdbId}/episodes/default?page=0`, {
                accept: 'application/json',
                headers: { Authorization: `Bearer ${token}` },
                timeoutMs: 9000,
              })
            )
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
            });
          } else if (epsRes && epsRes.ok) {
            const ePayload = JSON.parse(epsRes.body) as {
              data?: {
                episodes?: Array<{
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
              episodes.push({
                numberLabel: sNum > 1 ? `T${sNum} · EP ${ep.number}` : `EP ${ep.number}`,
                episodeNumber: ep.number,
                seasonNumber: sNum,
                seasonLabel: `Temporada ${sNum}`,
                title: ep.name ? `Episódio ${ep.number} — ${ep.name}` : `Episódio ${ep.number}`,
                url: buildEpisodeUri(resolvedType, 'thetvdb', tvdbId, sNum, ep.number),
                date: ep.aired || undefined,
                thumb: isValidArtworkUrl(ep.image) || undefined,
                overview: ep.overview || undefined,
                durationMinutes: ep.runtime || undefined,
              });
            }
          }

          const title = ptName || d.name;
          const studio = d.companies?.find((c) => /studio|production/i.test(c.companyType?.companyTypeName || ''))?.name;
          const network = d.companies?.find((c) => /network/i.test(c.companyType?.companyTypeName || ''))?.name;
          const runtimeVal = d.averageRuntime || d.runtime;
          const uri = buildMediaUri(resolvedType, 'thetvdb', tvdbId);

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
            poster: isValidArtworkUrl(d.image),
            backdrop: isValidArtworkUrl(d.image),
            synopsis: ptOverview || d.overview || '',
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
            episodes,
          };
        }
      }
    } catch {
      // Fall through to public TheTVDB.com HTML parsing
    }
  }

  // 2. Public TheTVDB.com page (zero API key required!)
  const pageUrl = options.slugHint
    ? `${TVDB_WEB_ORIGIN}/${mediaType === 'movie' ? 'movies' : 'series'}/${encodeURIComponent(options.slugHint)}`
    : `${TVDB_WEB_ORIGIN}/dereferrer/${mediaType === 'movie' ? 'movie' : 'series'}/${tvdbId}`;

  try {
    const res = await fetchHttp(pageUrl, {
      referer: `${TVDB_WEB_ORIGIN}/`,
      timeoutMs: 10000,
    });
    if (!res.ok) return null;

    const details = parseTvdbPublicHtml(res.body, tvdbId, mediaType, res.finalUrl || pageUrl);
    if (!details) return null;

    // Load full official episodes guide for series/anime when requested
    if (details.kind !== 'movie' && includeEpisodes && details.externalIds?.tvdbSlug) {
      try {
        const epsRes = await fetchHttp(
          `${TVDB_WEB_ORIGIN}/series/${encodeURIComponent(details.externalIds.tvdbSlug)}/allseasons/official`,
          {
            referer: res.finalUrl || pageUrl,
            timeoutMs: 10000,
          }
        );
        if (epsRes.ok) {
          const parsedEps = parseTvdbAllSeasonsHtml(
            epsRes.body,
            details.externalIds.tvdbId || tvdbId,
            (details.kind as CanonicalMediaType) || 'anime'
          );
          if (parsedEps.length > 0) {
            details.episodes = parsedEps;
            const seasons = new Set(parsedEps.map((e) => e.seasonNumber || 1));
            details.seasonsCount = String(seasons.size);
            details.episodesTotalCount = String(parsedEps.length);
          }
        }
      } catch {
        // Keep base metadata even if episode list request fails
      }
    }

    return details;
  } catch {
    return null;
  }
}

/**
 * Enriches media details coming from the streaming server (TopAnimes / Hinata Soul)
 * with complete metadata & official episode schedule from TheTVDB + LiveChart.me
 * while preserving all playable server episodes and flagging missing/upcoming ones!
 */
export async function enrichServerDetailsWithTheTvdb(
  fetchHttp: HttpFetcher,
  serverDetails: AnimeDetails,
  credentials?: CatalogSourceCredentials,
  extra?: { livechartId?: number }
): Promise<AnimeDetails> {
  const queryTerms = [
    serverDetails.title,
    serverDetails.originalTitle,
    serverDetails.alternativeTitle,
    ...(serverDetails.alternativeTitles || []),
  ].filter((t): t is string => Boolean(t && t.trim()));

  if (!queryTerms.length) return serverDetails;

  const isMovie = serverDetails.kind === 'movie' || /\/filmes\//i.test(serverDetails.url);
  const [bestMatch, liveChartHint] = await Promise.all([
    findBestTheTvdbMatch(fetchHttp, queryTerms, {
      mediaType: serverDetails.kind || (isMovie ? 'movie' : 'anime'),
      year: serverDetails.year,
    }),
    !isMovie
      ? findLiveChartScheduleHint(fetchHttp, {
          livechartId: extra?.livechartId ?? serverDetails.externalIds?.livechartId,
          titles: queryTerms,
        }).catch(() => null)
      : Promise.resolve(null),
  ]);

  if (!bestMatch) {
    if (!isMovie && liveChartHint) {
      const mergedWithSchedule = mergeServerAndCatalogEpisodes({
        serverTitle: serverDetails.title,
        serverUrl: serverDetails.url,
        serverEpisodes: serverDetails.episodes,
        catalogEpisodes: [],
        liveChartHint,
        serverMatched: serverDetails.episodes.length > 0,
        mediaType: (serverDetails.kind as CanonicalMediaType) || 'anime',
      });
      return {
        ...serverDetails,
        episodes: mergedWithSchedule,
      };
    }
    return serverDetails;
  }

  // Fetch full TheTVDB details page + official episodes guide for non-movies
  const fullTvdb = await fetchTheTvdbDetails(fetchHttp, bestMatch.tvdbId, {
    mediaType: bestMatch.mediaType,
    credentials,
    slugHint: bestMatch.slug,
    includeEpisodes: !isMovie && bestMatch.mediaType !== 'movie',
  }).catch(() => null);

  const tvdb = fullTvdb || null;
  const resolvedLiveChartHint =
    liveChartHint ||
    (!isMovie
      ? await findLiveChartScheduleHint(fetchHttp, {
          livechartId: extra?.livechartId ?? serverDetails.externalIds?.livechartId,
          titles: [
            ...queryTerms,
            tvdb?.title || '',
            tvdb?.originalTitle || '',
            tvdb?.alternativeTitle || '',
            bestMatch.title,
            bestMatch.englishTitle || '',
          ].filter(Boolean),
        }).catch(() => null)
      : null);

  const mergedIds: ExternalMediaIds = {
    ...serverDetails.externalIds,
    ...bestMatch.externalIds,
    ...tvdb?.externalIds,
    ...(resolvedLiveChartHint?.livechartId
      ? { livechartId: resolvedLiveChartHint.livechartId }
      : {}),
  };
  const resolvedKind: CanonicalMediaType =
    serverDetails.kind === 'movie' || bestMatch.mediaType === 'movie'
      ? 'movie'
      : serverDetails.kind === 'series'
        ? 'series'
        : bestMatch.mediaType;

  const altTitles = Array.from(
    new Set(
      [
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
        .filter((t) => t && t.toLowerCase() !== serverDetails.title.toLowerCase())
    )
  ).slice(0, 10);

  const tvdbGenres = tvdb?.genres?.length ? tvdb.genres : bestMatch.genres;
  const tvdbSynopsis = tvdb?.synopsis || bestMatch.synopsis;

  const mergedEpisodes =
    resolvedKind === 'movie'
      ? serverDetails.episodes
      : mergeServerAndCatalogEpisodes({
          serverTitle: serverDetails.title,
          serverUrl: serverDetails.url,
          serverEpisodes: serverDetails.episodes,
          catalogEpisodes: tvdb?.episodes || [],
          liveChartHint: resolvedLiveChartHint,
          serverMatched: serverDetails.episodes.length > 0,
          tvdbId: bestMatch.tvdbId,
          mediaType: resolvedKind,
        });

  return {
    ...serverDetails,
    kind: resolvedKind,
    catalogSource: 'thetvdb',
    externalIds: mergedIds,
    enrichmentSources: ['thetvdb'],
    externalLinks: buildExternalDatabaseLinks(mergedIds, { mediaType: resolvedKind }),
    originalTitle: tvdb?.originalTitle || bestMatch.originalTitle || serverDetails.originalTitle,
    alternativeTitle:
      tvdb?.title && tvdb.title.toLowerCase() !== serverDetails.title.toLowerCase()
        ? tvdb.title
        : tvdb?.alternativeTitle || serverDetails.alternativeTitle,
    alternativeTitles: altTitles,
    poster: serverDetails.poster || tvdb?.poster || bestMatch.poster,
    backdrop: tvdb?.backdrop || bestMatch.backdrop || serverDetails.backdrop || serverDetails.poster,
    synopsis: tvdbSynopsis || serverDetails.synopsis,
    year: tvdb?.year || bestMatch.year || serverDetails.year,
    firstAirDate: tvdb?.firstAirDate || bestMatch.firstAirDate || serverDetails.firstAirDate,
    lastAirDate: tvdb?.lastAirDate || serverDetails.lastAirDate,
    averageDuration: tvdb?.averageDuration || serverDetails.averageDuration,
    seasonsCount: tvdb?.seasonsCount || serverDetails.seasonsCount,
    status: tvdb?.status || bestMatch.status || serverDetails.status,
    studio: tvdb?.studio || bestMatch.studio || serverDetails.studio,
    network: tvdb?.network || bestMatch.network || serverDetails.network,
    originalCountry: tvdb?.originalCountry || bestMatch.originalCountry,
    originalLanguage: tvdb?.originalLanguage || bestMatch.originalLanguage,
    genres: tvdbGenres.length > 0 ? tvdbGenres : serverDetails.genres,
    episodes: mergedEpisodes,
  };
}
