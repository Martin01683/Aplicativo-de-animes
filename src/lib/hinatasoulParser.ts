import * as cheerio from 'cheerio';
import type {
  AnimeDetails,
  AnimeEpisodeLink,
  AudioType,
  CatalogMediaItem,
  EpisodeDetails,
  HomeCatalog,
  MediaKind,
  PlayerOption,
  SearchResultItem,
} from './types.ts';
import {
  isSafeExternalHttpUrl,
  normalizeHinataSoulUrl,
} from './urlSafety.ts';
import { isUncensoredEpisodeTitle } from './episodeAvailability.ts';
import { splitAlternativeTitleString } from './catalog/idCodec.ts';

export const HINATASOUL_ORIGIN = 'https://www.hinatasoul.com';
export const HINATASOUL_R2_ORIGIN =
  'https://173fe263eae04670ecfcebf237fd6480.r2.cloudflarestorage.com';

export interface HinataSoulQualityTab {
  target: string;
  label: string;
  height: number;
  redirectHref?: string;
  iframeSrc?: string;
}

export interface HinataSoulR2Candidate {
  label: string;
  height: number;
  r2Url: string;
}

const WIN1252_REVERSE_MAP: Record<number, number> = {
  0x20ac: 0x80,
  0x201a: 0x82,
  0x0192: 0x83,
  0x201e: 0x84,
  0x2026: 0x85,
  0x2020: 0x86,
  0x2021: 0x87,
  0x02c6: 0x88,
  0x2030: 0x89,
  0x0160: 0x8a,
  0x2039: 0x8b,
  0x0152: 0x8c,
  0x017d: 0x8e,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201c: 0x93,
  0x201d: 0x94,
  0x2022: 0x95,
  0x2013: 0x96,
  0x2014: 0x97,
  0x02dc: 0x98,
  0x2122: 0x99,
  0x0161: 0x9a,
  0x203a: 0x9b,
  0x0153: 0x9c,
  0x017e: 0x9e,
  0x0178: 0x9f,
};

const MOJIBAKE_RE = /Ã[\u0080-\u00bf\u0152-\u017e\u2013-\u203a]|â€[\u0080-\u00bf\u0152-\u017e\u2013-\u203a\u2122]|Â[\u00a0-\u00bf]/;

function cleanText(raw: string | undefined): string {
  return String(raw || '')
    .replace(/\u200b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Repairs double-encoded UTF-8-as-Windows-1252 mojibake occasionally emitted in Hinata Soul synopses
 * (e.g. "ApÃ³s ... â€“ ... Ã©lfico" -> "Após ... – ... élfico").
 */
export function fixHinataSoulMojibake(raw: string | undefined): string {
  const input = String(raw || '').trim();
  if (!input) return '';
  if (!MOJIBAKE_RE.test(input)) {
    return input.replace(/\u200b/g, '').trim();
  }

  try {
    const bytes = new Uint8Array(input.length);
    for (let i = 0; i < input.length; i += 1) {
      const code = input.charCodeAt(i);
      if (code <= 0xff) {
        bytes[i] = code;
      } else if (code in WIN1252_REVERSE_MAP) {
        bytes[i] = WIN1252_REVERSE_MAP[code];
      } else {
        return input.replace(/\u200b/g, '').trim();
      }
    }
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return decoded.replace(/\u200b/g, '').trim();
  } catch {
    return input.replace(/\u200b/g, '').trim();
  }
}

function normalizeImageUrl(raw: string | undefined, baseOrigin = HINATASOUL_ORIGIN): string {
  const trimmed = cleanText(raw);
  if (!trimmed) return '';
  try {
    const resolved = new URL(trimmed, baseOrigin).href;
    return isSafeExternalHttpUrl(resolved) ? resolved : '';
  } catch {
    return '';
  }
}

function makeSlugId(url: string, fallback: string): string {
  try {
    const pathname = new URL(url).pathname.replace(/^\/+|\/+$/g, '');
    return pathname ? `hinatasoul:${pathname}` : fallback;
  } catch {
    return fallback;
  }
}

export function inferHinataSoulAudioType(url: string, text = ''): AudioType {
  const combined = `${url} ${text}`;
  if (/\/anime-dublado\b|\bDUB\b|DUBLAD[OA]/i.test(combined)) {
    return 'DUB';
  }
  if (/\/(?:animes|donghua)\b|\bLEG\b|LEGENDAD[OA]/i.test(combined)) {
    return 'LEG';
  }
  return null;
}

export function inferHinataSoulMediaKind(
  url: string,
  typeText = '',
  title = ''
): MediaKind {
  if (/\/videos\/\d+/i.test(url)) return 'episode';
  if (/\b(?:filme|movie)\b/i.test(`${typeText} ${title}`)) return 'movie';
  if (/\/(?:doramas|tokusatsus)\//i.test(url)) return 'series';
  return 'anime';
}

export function cleanHinataSoulSeriesTitle(rawTitle: string): string {
  return cleanText(rawTitle)
    .replace(/\s*[-–—]\s*(?:ep\.?|epis[oó]dio)\s*\d+(?:\s*[-–]\s*\d+)?(?:\.\d+)?.*$/i, '')
    .replace(/\s+(?:ep\.?|epis[oó]dio)\s*\d+(?:\s*[-–]\s*\d+)?(?:\.\d+)?.*$/i, '')
    .replace(/\s+(?:online|full\s*hd)\s*$/i, '')
    .trim();
}

export function extractHinataSoulEpisodeNumber(text: string): number | null {
  const cleaned = cleanText(text);
  if (!cleaned) return null;
  const epMatch = cleaned.match(/(?:epis[oó]dio|ep\.?)\s*0*(\d+(?:\.\d+)?)/i);
  if (epMatch?.[1]) {
    const n = Number.parseFloat(epMatch[1]);
    return Number.isFinite(n) ? n : null;
  }
  const trailing = cleaned.match(/\b0*(\d+)\s*$/);
  if (trailing?.[1]) {
    const n = Number.parseInt(trailing[1], 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

export function extractHinataSoulSeasonNumber(title: string): number {
  const cleaned = cleanText(title)
    .replace(/\s*[-–—]\s*(?:dublad[oa]|legendad[oa]|dub|leg|online|full\s*hd)\s*$/i, '')
    .replace(/\s*\((?:dublad[oa]|legendad[oa]|dub|leg|pt[\s-]?br|dual[\s-]?audio)\)\s*$/i, '')
    .replace(/\s+(?:dublad[oa]|legendad[oa]|dub|leg|online|full\s*hd)\s*$/i, '')
    .trim();
  if (!cleaned) return 1;

  const patterns: RegExp[] = [
    /\b(\d+)(?:st|nd|rd|th|a|ª)\s*(?:season|temporada)\b/i,
    /\b(?:season|temporada)\s*(\d+)\b/i,
    /\bs(\d{1,2})\b/i,
    /\bparte?\s*(\d+)\b/i,
  ];
  for (const re of patterns) {
    const m = cleaned.match(re);
    if (m?.[1]) {
      const n = Number.parseInt(m[1], 10);
      if (Number.isFinite(n) && n >= 1 && n <= 20) return n;
    }
  }

  // Trailing Roman numerals (e.g. "Shiguang Dailiren III", "Overlord IV")
  const romanMatch = cleaned.match(/\s+(II|III|IV|V|VI)(?:\s*[:\-–]|$)/);
  if (romanMatch?.[1]) {
    const map: Record<string, number> = { II: 2, III: 3, IV: 4, V: 5, VI: 6 };
    return map[romanMatch[1]] || 1;
  }

  // Trailing season integer (e.g. "Yuru Camp 2", "Sousou no Frieren 2 Dublado", or "Kimetsu no Yaiba 2: Yuukaku-hen")
  const trailingNum = cleaned.match(/\s+([2-9]|1[0-5])(?:\s*[:\-–]|$)/);
  if (trailingNum?.[1]) {
    const n = Number.parseInt(trailingNum[1], 10);
    if (Number.isFinite(n) && n >= 2 && n <= 15) return n;
  }

  return 1;
}

function parsePaginationFromLetterBoxes(
  $: cheerio.CheerioAPI,
  currentPageHint = 1
): { currentPage: number; totalPages: number } {
  let maxPage = Math.max(1, currentPageHint);

  $('.letterBox').each((_, box) => {
    const links = $(box).find('a[href]');
    let isPaginationBox = false;
    const nums: number[] = [];

    links.each((__, a) => {
      const href = $(a).attr('href') || '';
      const pathMatch = href.match(/\/page\/(\d+)(?:\/|$|\?)/i);
      const queryMatch = href.match(/[?&]page=(\d+)(?:&|$)/i);
      const rawNum = pathMatch?.[1] || queryMatch?.[1];
      if (rawNum) {
        isPaginationBox = true;
        const parsed = Number.parseInt(rawNum, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          nums.push(parsed);
        }
      }
    });

    if (isPaginationBox && nums.length > 0) {
      const boxMax = Math.max(...nums);
      if (boxMax > maxPage) maxPage = boxMax;
    }
  });

  return {
    currentPage: Math.max(1, currentPageHint),
    totalPages: Math.max(1, currentPageHint, maxPage),
  };
}

function parseAnimeCardNodes(
  $: cheerio.CheerioAPI,
  scope: ReturnType<cheerio.CheerioAPI>,
  defaultKind: MediaKind = 'anime',
  forcedAudio: AudioType = null,
  baseOrigin = HINATASOUL_ORIGIN
): CatalogMediaItem[] {
  const seen = new Set<string>();
  const items: CatalogMediaItem[] = [];

  scope.find('.ultimosAnimesHomeItem').each((idx, el) => {
    const root = $(el);
    const anchorEl = root.find('a[href]').first();
    const link = anchorEl.attr('href') || '';
    const url = normalizeHinataSoulUrl(link, baseOrigin);
    const title =
      cleanText(root.find('.ultimosAnimesHomeItemInfosNome').first().text()) ||
      cleanText(root.find('img').first().attr('alt')) ||
      cleanText(anchorEl.attr('title'));
    if (!url || !title || seen.has(url)) return;
    seen.add(url);

    const tipoText = cleanText(root.find('.ultimosAnimesHomeItemTipo').first().text());
    const qntEps = cleanText(root.find('.ultimosAnimesHomeItemQntEps').first().text());
    const imgEl = root.find('.ultimosAnimesHomeItemImg img, img').first();
    const poster = normalizeImageUrl(
      imgEl.attr('src') || imgEl.attr('data-src'),
      baseOrigin
    );
    const audioType = forcedAudio || inferHinataSoulAudioType(url, `${title} ${tipoText}`);
    const kind =
      defaultKind !== 'anime' ? defaultKind : inferHinataSoulMediaKind(url, tipoText, title);

    items.push({
      id: makeSlugId(url, `hs-anime-${idx}`),
      title,
      url,
      kind,
      poster,
      audioType,
      episodeLabel:
        qntEps && !/^0\/\?+/i.test(qntEps) ? qntEps.replace(/\s+/g, ' ') : undefined,
      catalogSource: 'server',
      sourceServerName: 'Hinata Soul',
    });
  });

  return items;
}

function parseEpisodeCardNodes(
  $: cheerio.CheerioAPI,
  scope: ReturnType<cheerio.CheerioAPI>,
  baseOrigin = HINATASOUL_ORIGIN
): CatalogMediaItem[] {
  const seen = new Set<string>();
  const items: CatalogMediaItem[] = [];

  scope.find('.ultimosEpisodiosHomeItem').each((idx, el) => {
    const root = $(el);
    const aEl = root.find('a[href]').first();
    const link = aEl.attr('href') || '';
    const url = normalizeHinataSoulUrl(link, baseOrigin);
    const rawName =
      cleanText(root.find('.ultimosEpisodiosHomeItemInfosNome').first().text()) ||
      cleanText(aEl.attr('title')) ||
      cleanText(root.find('img').first().attr('alt'));
    if (!url || !rawName || seen.has(url)) return;
    seen.add(url);

    const epNumText = cleanText(
      root.find('.ultimosEpisodiosHomeItemInfosNum').first().text()
    );
    const epNum =
      extractHinataSoulEpisodeNumber(epNumText) ?? extractHinataSoulEpisodeNumber(rawName);
    const seriesTitle = cleanHinataSoulSeriesTitle(rawName) || rawName;
    const epLabel = epNumText || (epNum !== null ? `Episódio ${epNum}` : undefined);
    const imgEl = root.find('.ultimosEpisodiosHomeItemImg img, img').first();
    const poster = normalizeImageUrl(
      imgEl.attr('src') || imgEl.attr('data-src'),
      baseOrigin
    );
    const audioType = inferHinataSoulAudioType(url, rawName) || 'LEG';

    items.push({
      id: makeSlugId(url, `hs-ep-${idx}`),
      title: seriesTitle,
      episodeLabel: epLabel,
      url,
      kind: 'episode',
      poster,
      audioType,
      catalogSource: 'server',
      sourceServerName: 'Hinata Soul',
    });
  });

  return items;
}

/**
 * Parses Hinata Soul homepage (`https://www.hinatasoul.com/`) into releases, animes, movies, and series.
 */
export function parseHinataSoulHomeHtml(
  html: string,
  sourceMode: 'live' | 'snapshot' = 'live',
  baseOrigin = HINATASOUL_ORIGIN
): HomeCatalog {
  const $ = cheerio.load(html);
  const releases: CatalogMediaItem[] = [];
  const animes: CatalogMediaItem[] = [];
  const movies: CatalogMediaItem[] = [];
  const series: CatalogMediaItem[] = [];

  const seenRelease = new Set<string>();
  const seenAnime = new Set<string>();

  $('.tituloContainer').each((_, headerEl) => {
    const heading = cleanText($(headerEl).find('.titulo').text()).toLowerCase();
    const container = $(headerEl).next();
    if (!container.length) return;

    const isReleasesSection =
      heading.includes('últimos episódios') ||
      heading.includes('ultimos episodios') ||
      heading.includes('envios recentes');
    const isAnimeSection =
      heading.includes('últimos animes') ||
      heading.includes('ultimos animes') ||
      heading.includes('recomendados');

    if (isReleasesSection) {
      const eps = parseEpisodeCardNodes($, container, baseOrigin);
      for (const ep of eps) {
        if (seenRelease.has(ep.url)) continue;
        seenRelease.add(ep.url);
        releases.push(ep);
      }
      return;
    }

    if (isAnimeSection) {
      const forcedAudio: AudioType = heading.includes('dublado') ? 'DUB' : null;
      const cards = parseAnimeCardNodes($, container, 'anime', forcedAudio, baseOrigin);
      for (const card of cards) {
        if (seenAnime.has(card.url)) continue;
        seenAnime.add(card.url);
        if (card.kind === 'movie') {
          movies.push(card);
        } else if (card.kind === 'series') {
          series.push(card);
        } else {
          animes.push(card);
        }
      }
    }
  });

  // Fallback if layout headings change
  if (!releases.length) {
    releases.push(...parseEpisodeCardNodes($, $.root(), baseOrigin));
  }
  if (!animes.length) {
    for (const card of parseAnimeCardNodes($, $.root(), 'anime', null, baseOrigin)) {
      if (card.kind === 'movie') movies.push(card);
      else if (card.kind === 'series') series.push(card);
      else animes.push(card);
    }
  }

  return {
    calendar: [],
    releases,
    animes,
    movies,
    series,
    sourcesUsed: ['server'],
    sourceMode,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Parses Hinata Soul catalog archive pages (`/animes`, `/anime-dublado`, `/donghua`, `/doramas`, `/tokusatsus`, `/animes/letra/a`).
 */
export function parseHinataSoulCatalogHtml(
  html: string,
  defaultKind: MediaKind = 'anime',
  forcedAudio: AudioType = null,
  currentPageHint = 1,
  baseOrigin = HINATASOUL_ORIGIN
): {
  items: CatalogMediaItem[];
  currentPage: number;
  totalPages: number;
} {
  const $ = cheerio.load(html);
  const items = parseAnimeCardNodes($, $.root(), defaultKind, forcedAudio, baseOrigin);
  const { currentPage, totalPages } = parsePaginationFromLetterBoxes($, currentPageHint);
  return { items, currentPage, totalPages };
}

/**
 * Parses Hinata Soul search results (`/busca?busca=<query>&page=<page>`).
 */
export function parseHinataSoulSearchHtml(
  html: string,
  currentPageHint = 1,
  baseOrigin = HINATASOUL_ORIGIN
): {
  results: SearchResultItem[];
  currentPage: number;
  totalPages: number;
} {
  const { items, currentPage, totalPages } = parseHinataSoulCatalogHtml(
    html,
    'anime',
    null,
    currentPageHint,
    baseOrigin
  );
  const results: SearchResultItem[] = items.map((item) => ({
    id: item.id,
    title: item.title,
    url: item.url,
    kind: item.kind,
    poster: item.poster,
    audioType: item.audioType,
    excerpt: item.episodeLabel,
    catalogSource: 'server',
    sourceServerName: 'Hinata Soul',
  }));
  return { results, currentPage, totalPages };
}

/**
 * Parses a Hinata Soul anime/series/movie page (e.g. `https://www.hinatasoul.com/animes/sousou-no-frieren-2nd-season`).
 */
export function parseHinataSoulAnimePageHtml(
  html: string,
  pageUrl: string,
  currentPageHint = 1,
  baseOrigin = HINATASOUL_ORIGIN
): {
  details: AnimeDetails;
  currentPage: number;
  totalPages: number;
} {
  const $ = cheerio.load(html);
  const canonicalUrl = normalizeHinataSoulUrl(pageUrl, baseOrigin) || pageUrl;

  const rawH1 = cleanText($('.tituloPage h1').first().text());
  const ogTitle = cleanText($('meta[property="og:title"]').attr('content'))
    .replace(/\s*-\s*Hinata\s*Soul.*$/i, '')
    .trim();
  const title = rawH1 || ogTitle || 'Anime';

  const poster = normalizeImageUrl(
    $('.aniInfosSingleCapa img').first().attr('src') ||
      $('meta[property="og:image"]').attr('content'),
    baseOrigin
  );

  let episodesTotalCount: string | undefined;
  let year: string | undefined;
  let typeText = '';

  $('.aniInfosSingleNumsItem').each((_, el) => {
    const label = cleanText($(el).find('b').first().text()).toLowerCase();
    const cloned = $(el).clone();
    cloned.find('b').remove();
    const val = cleanText(cloned.text());
    if (!val) return;
    if (label.includes('epis')) {
      if (!/^0\/\?+/i.test(val)) episodesTotalCount = val;
    } else if (label.includes('ano')) {
      const ym = val.match(/\b(19\d{2}|20\d{2})\b/);
      if (ym) year = ym[1];
    } else if (label.includes('tipo')) {
      typeText = val;
    }
  });

  let alternativeTitle: string | undefined;
  let studio: string | undefined;
  const alternativeTitles: string[] = [];

  $('.aniInfosSingleInfoItem').each((_, el) => {
    const label = cleanText($(el).find('b').first().text()).toLowerCase();
    const val = cleanText($(el).find('span').first().text());
    if (!val || /^desconhecido$/i.test(val)) return;
    if (label.includes('alternativo')) {
      alternativeTitle = val;
      for (const alias of splitAlternativeTitleString(val)) {
        if (!alternativeTitles.includes(alias)) alternativeTitles.push(alias);
      }
    } else if (label.includes('estúdio') || label.includes('estudio')) {
      studio = val;
    }
  });

  const genres: string[] = [];
  $('.aniInfosSingleGeneros span').each((_, el) => {
    const g = cleanText($(el).text());
    if (g && !genres.includes(g)) genres.push(g);
  });

  const rawSynopsis = $('.aniInfosSingleSinopse p').first().text();
  const synopsis = fixHinataSoulMojibake(rawSynopsis);

  const malHref = cleanText($('a[href*="myanimelist.net"]').first().attr('href'));
  const myAnimeListUrl = isSafeExternalHttpUrl(malHref) ? malHref : undefined;

  const audioType = inferHinataSoulAudioType(canonicalUrl, title);
  const kind = inferHinataSoulMediaKind(canonicalUrl, typeText, title);
  const inferredSeason = extractHinataSoulSeasonNumber(title);

  // Scope episodes strictly to `.mainSingle .right .aniContainer` so we skip recommended cards in `.cbox`
  const episodesScope = $('.mainSingle .right .aniContainer').first();
  const episodes: AnimeEpisodeLink[] = [];
  const seenEp = new Set<string>();

  const epContainer = episodesScope.length ? episodesScope : $('.mainSingle .right').first();
  epContainer.find('.ultimosEpisodiosHomeItem').each((idx, el) => {
    const root = $(el);
    const aEl = root.find('a[href]').first();
    const epUrl = normalizeHinataSoulUrl(aEl.attr('href') || '', baseOrigin);
    if (!epUrl || !/\/videos\/\d+/i.test(epUrl) || seenEp.has(epUrl)) return;
    seenEp.add(epUrl);

    const rawName = cleanText(
      root.find('.ultimosEpisodiosHomeItemInfosNome').first().text() ||
        aEl.attr('title')
    );
    const rawNumText = cleanText(
      root.find('.ultimosEpisodiosHomeItemInfosNum').first().text()
    );
    const date = cleanText(root.find('.lancaster_episodio_info_data').first().text());
    const thumb = normalizeImageUrl(
      root.find('img').first().attr('src') || root.find('img').first().attr('data-src'),
      baseOrigin
    );

    const epNum =
      extractHinataSoulEpisodeNumber(rawNumText) ??
      extractHinataSoulEpisodeNumber(rawName);

    const numberLabel =
      epNum !== null
        ? inferredSeason > 1
          ? `T${inferredSeason} - EP ${epNum}`
          : `EP ${epNum}`
        : rawNumText || `EP ${idx + 1}`;
    const epTitle = rawNumText || (epNum !== null ? `Episódio ${epNum}` : rawName || `Episódio ${idx + 1}`);

    const uncensored = isUncensoredEpisodeTitle(rawNumText) || isUncensoredEpisodeTitle(rawName);

    episodes.push({
      numberLabel,
      episodeNumber: epNum,
      seasonNumber: inferredSeason,
      seasonLabel: `Temporada ${inferredSeason}`,
      title: epTitle,
      url: epUrl,
      date: date || undefined,
      thumb: thumb || undefined,
      ...(uncensored ? { uncensored: true } : {}),
    });
  });

  const relations = parseAnimeCardNodes($, $('.cbox'), 'anime', null, baseOrigin);
  const { currentPage, totalPages } = parsePaginationFromLetterBoxes($, currentPageHint);

  const details: AnimeDetails = {
    title,
    alternativeTitle,
    alternativeTitles: alternativeTitles.length ? alternativeTitles : undefined,
    url: canonicalUrl,
    kind,
    catalogSource: 'server',
    sourceServerName: 'Hinata Soul',
    poster,
    backdrop: poster,
    synopsis,
    year,
    episodesTotalCount,
    studio,
    myAnimeListUrl,
    genres,
    audioType,
    episodes,
    relations: relations.length ? relations : undefined,
  };

  return { details, currentPage, totalPages };
}

function qualityHeightFromLabel(label: string, target: string): number {
  const upper = label.toUpperCase().replace(/\s+/g, '');
  if (upper.includes('4K') || upper.includes('2160')) return 2160;
  if (upper.includes('FULLHD') || upper.includes('FHD') || upper.includes('1080')) return 1080;
  if (upper.includes('720') || upper === 'HD') return 720;
  if (upper.includes('480') || upper === 'SD') return 480;
  if (upper.includes('360')) return 360;
  if (target === '2') return 1080;
  if (target === '1') return 720;
  return 480;
}

function formatQualityTabLabel(height: number, rawLabel: string): string {
  if (height >= 1080) return '1080p (Full HD)';
  if (height >= 720) return '720p (HD)';
  if (height >= 480) return '480p (SD)';
  return rawLabel || 'SD';
}

/**
 * Derives Cloudflare R2 video object URLs directly from Hinata Soul's `meta[itemprop="contentURL"]`
 * and available `.AbasBox .Aba` quality tabs.
 *
 * Empirically verified bucket mapping across Hinata Soul catalog:
 * - `.../iphonec/<id>.mp4` -> SD=`ziphonec/<id>.mp4`, HD=`z333/<id>.mp4`, FULLHD=`zful/<id>.mp4`
 * - `.../iphoneb/<id>.mp4` -> SD=`ziphoneb/<id>.mp4`, HD=`z222/<id>.mp4`, FULLHD=`zful/<id>.mp4`
 * - `.../iphonea/<id>.mp4` -> SD=`ziphonea/<id>.mp4`, HD=`z111/<id>.mp4`, FULLHD=`zful/<id>.mp4`
 * - `.../iphoned/<id>.mp4` -> SD=`ziphoned/<id>.mp4`, HD=`z444/<id>.mp4`, FULLHD=`zful/<id>.mp4`
 */
export function deriveHinataSoulR2Candidates(
  contentUrl: string,
  qualities: readonly HinataSoulQualityTab[]
): HinataSoulR2Candidate[] {
  const cleanUrl = cleanText(contentUrl);
  const match = cleanUrl.match(/\/([a-z0-9_-]+)\/(\d+\.mp4)(?:$|\?)/i);
  if (!match) return [];

  const sdPrefix = match[1].toLowerCase();
  const fileName = match[2];

  const sdBucket = sdPrefix.startsWith('z') ? sdPrefix : `z${sdPrefix}`;
  let hdBucket = 'z333';
  if (sdPrefix === 'iphoneb') hdBucket = 'z222';
  else if (sdPrefix === 'iphonea' || sdPrefix === 'iphone') hdBucket = 'z111';
  else if (sdPrefix === 'iphoned') hdBucket = 'z444';
  else if (sdPrefix === 'iphonec') hdBucket = 'z333';

  const effectiveTabs: HinataSoulQualityTab[] =
    qualities.length > 0
      ? [...qualities]
      : [
          { target: '1', label: 'HD', height: 720 },
          { target: '0', label: 'SD', height: 480 },
        ];

  const out: HinataSoulR2Candidate[] = [];
  const seenUrl = new Set<string>();

  for (const tab of effectiveTabs) {
    let bucket: string;
    if (tab.height >= 1080) {
      bucket = 'zful';
    } else if (tab.height >= 720) {
      bucket = hdBucket;
    } else {
      bucket = sdBucket;
    }
    const r2Url = `${HINATASOUL_R2_ORIGIN}/${bucket}/${fileName}`;
    if (seenUrl.has(r2Url)) continue;
    seenUrl.add(r2Url);
    out.push({
      label: formatQualityTabLabel(tab.height, tab.label),
      height: tab.height,
      r2Url,
    });
  }

  return out.sort((a, b) => b.height - a.height);
}

/**
 * Parses a Hinata Soul episode page (`https://www.hinatasoul.com/videos/<id>`).
 */
export function parseHinataSoulEpisodePageHtml(
  html: string,
  pageUrl: string,
  baseOrigin = HINATASOUL_ORIGIN
): {
  episode: EpisodeDetails;
  contentUrl: string;
  qualities: HinataSoulQualityTab[];
} {
  const $ = cheerio.load(html);
  const canonicalUrl = normalizeHinataSoulUrl(pageUrl, baseOrigin) || pageUrl;

  const rawTitle =
    cleanText($('h1.epTituloNome').first().text()) ||
    cleanText($('meta[itemprop="name"]').first().attr('content')) ||
    cleanText($('title').first().text())
      .replace(/\s*Online\s*-\s*Hinata\s*Soul.*$/i, '')
      .trim() ||
    'Episódio';

  const seriesTitle = cleanHinataSoulSeriesTitle(rawTitle) || rawTitle;
  const epNum = extractHinataSoulEpisodeNumber(rawTitle);
  const seasonNum = extractHinataSoulSeasonNumber(seriesTitle);
  const audioType = inferHinataSoulAudioType(canonicalUrl, rawTitle);

  const poster = normalizeImageUrl(
    $('meta[property="og:image"]').attr('content') ||
      $('link[itemprop="thumbnailUrl"]').attr('href') ||
      $('meta[itemprop="thumbnailUrl"]').attr('content'),
    baseOrigin
  );

  const contentUrl = cleanText($('meta[itemprop="contentURL"]').attr('content'));

  let seriesUrl: string | undefined;
  let prevUrl: string | undefined;
  let nextUrl: string | undefined;

  $('.controlesBox a[href]').each((_, el) => {
    const href = normalizeHinataSoulUrl($(el).attr('href') || '', baseOrigin);
    if (!href) return;
    const titleAttr = cleanText($(el).attr('title')).toLowerCase();
    const text = cleanText($(el).text()).toLowerCase();
    if (
      titleAttr.includes('lista') ||
      /\/(?:animes|anime-dublado|donghua|doramas|tokusatsus)\//i.test(href)
    ) {
      seriesUrl = href;
    } else if (titleAttr.includes('anterior') || text.includes('anterior')) {
      prevUrl = href;
    } else if (titleAttr.includes('próximo') || titleAttr.includes('proximo') || text.includes('próximo') || text.includes('proximo')) {
      nextUrl = href;
    }
  });

  const qualities: HinataSoulQualityTab[] = [];
  $('.AbasBox .Aba').each((idx, el) => {
    const label = cleanText($(el).text()) || `Qualidade ${idx + 1}`;
    const target = cleanText($(el).attr('data-target') || $(el).attr('aba-type') || String(idx));
    const height = qualityHeightFromLabel(label, target);
    const container = $(`.playerContainer[id="${target}"]`).first();
    const redirectHref = cleanText(container.find('a[href]').first().attr('href')) || undefined;
    const iframeSrc =
      cleanText(
        container.find('iframe').first().attr('src') ||
          container.find('iframe').first().attr('data-src')
      ) || undefined;
    qualities.push({
      target,
      label,
      height,
      redirectHref: redirectHref && isSafeExternalHttpUrl(redirectHref) ? redirectHref : undefined,
      iframeSrc: iframeSrc && isSafeExternalHttpUrl(iframeSrc) ? iframeSrc : undefined,
    });
  });

  const qualitySummary = qualities
    .slice()
    .sort((a, b) => b.height - a.height)
    .map((q) => (q.height >= 1080 ? 'Full HD' : q.height >= 720 ? 'HD' : 'SD'))
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .join(' / ');

  const audioSuffix = audioType ? ` [${audioType}]` : '';
  const options: PlayerOption[] = [];
  if (contentUrl || qualities.some((q) => q.redirectHref || q.iframeSrc)) {
    options.push({
      nume: 'hinatasoul:1',
      label: `Hinata Soul${audioSuffix}${qualitySummary ? ` · ${qualitySummary}` : ''}`,
      embedUrl: canonicalUrl,
      providerKind: 'hinatasoul',
      sourceId: 'hinatasoul',
      sourceName: 'Hinata Soul',
      sourceKind: 'hinatasoul',
      audioType,
      matchedPageUrl: canonicalUrl,
      directReferer: `${baseOrigin}/`,
      qualityLabel: qualitySummary || 'Full HD',
    });
  }

  const epLabel =
    epNum !== null
      ? seasonNum > 1
        ? `T${seasonNum} · EP ${epNum}`
        : `EP ${epNum}`
      : undefined;

  const episode: EpisodeDetails = {
    title: rawTitle,
    seriesTitle,
    seriesUrl,
    url: canonicalUrl,
    episodeLabel: epLabel,
    mediaType: seriesUrl ? (inferHinataSoulMediaKind(seriesUrl, '', seriesTitle) === 'episode' ? 'anime' : inferHinataSoulMediaKind(seriesUrl, '', seriesTitle) as 'anime' | 'series' | 'movie') : 'anime',
    seasonNumber: seasonNum,
    episodeNumber: epNum ?? undefined,
    catalogSource: 'server',
    poster,
    backdrop: poster,
    synopsis: '',
    genres: [],
    prevUrl,
    nextUrl,
    options,
    isMovie: false,
    sourceMode: 'live',
  };

  return { episode, contentUrl, qualities };
}
