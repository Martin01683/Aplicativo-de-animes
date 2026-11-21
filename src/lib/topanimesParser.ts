import * as cheerio from 'cheerio';
import type {
  AnimeDetails,
  AnimeEpisodeLink,
  AudioType,
  CalendarDaySection,
  CatalogFilterOption,
  CatalogFilters,
  CatalogMediaItem,
  EpisodeDetails,
  HomeCatalog,
  MediaKind,
  PlayerOption,
  SearchResultItem,
  SliderMovieItem,
  StreamFormat,
  StreamQuality,
  SubtitleTrack,
  WeeklyCalendarResponse,
} from './types.ts';
import { isSafeExternalHttpUrl, normalizeTopAnimesUrl, unwrapAvisoUrl } from './urlSafety.ts';

const NAMED_HEIGHTS: Record<string, number> = {
  uhd: 2160,
  '4k': 2160,
  '2k': 1440,
  qhd: 1440,
  fhd: 1080,
  hd: 720,
  sd: 480,
  ld: 360,
  fd: 240,
};

const ITAG_HEIGHT: Record<number, number> = {
  5: 240,
  6: 270,
  13: 144,
  17: 144,
  18: 360,
  22: 720,
  34: 360,
  35: 480,
  36: 240,
  37: 1080,
  38: 2160,
  43: 360,
  44: 480,
  45: 720,
  46: 1080,
  59: 480,
  78: 480,
};

const AD_HOST_RE =
  /(?:^|[/._-])(?:ads?|vast|vmap|adserver|doubleclick|googlesyndication|supervideoad|yandex|tracker|metilinksemvoce|viewanalitycs|agl004|videoad|autotop|canalfutebol)(?:[/._?-]|$)/i;

function cleanText(val: string | undefined): string {
  return String(val || '').replace(/\s+/g, ' ').trim();
}

export function inferAudioType(text: string): AudioType {
  const upper = text.toUpperCase();
  if (/\bDUB\b|DUBLAD[OA]/i.test(upper)) return 'DUB';
  if (/\bLEG\b|LEGENDAD[OA]/i.test(upper)) return 'LEG';
  return null;
}

export function inferMediaKindFromUrl(url: string): MediaKind {
  if (/\/filmes\//i.test(url)) return 'movie';
  if (/\/episodio\//i.test(url)) return 'episode';
  return 'anime';
}

function makeSlugId(url: string, fallback: string): string {
  try {
    const pathname = new URL(url).pathname.replace(/^\/+|\/+$/g, '');
    return pathname || fallback;
  } catch {
    return fallback;
  }
}

function upgradeImageUrl(raw: string | undefined): string {
  let val = cleanText(raw);
  if (!val) return '';
  if (val.startsWith('//')) val = `https:${val}`;
  val = val.replace(/\/t\/p\/w(?:92|154|185)\//i, '/t/p/w342/');
  return isSafeExternalHttpUrl(val) ? val : '';
}

function parsePaginationMeta($: cheerio.CheerioAPI): {
  currentPage: number;
  totalPages: number;
} {
  const pagText = cleanText($('.pagination span').first().text());
  const match = pagText.match(/Page\s+(\d+)\s+of\s+(\d+)/i);
  if (match) {
    return {
      currentPage: Math.max(1, Number.parseInt(match[1], 10)),
      totalPages: Math.max(1, Number.parseInt(match[2], 10)),
    };
  }
  const currentText = cleanText($('.pagination .current').first().text());
  const currentPage = Number.parseInt(currentText, 10) || 1;
  let maxPage = currentPage;
  $('.pagination a').each((_, el) => {
    const n = Number.parseInt(cleanText($(el).text()), 10);
    if (Number.isFinite(n) && n > maxPage) maxPage = n;
  });
  return { currentPage, totalPages: Math.max(currentPage, maxPage) };
}

function extractEpisodeArticles($: cheerio.CheerioAPI): CatalogMediaItem[] {
  const seen = new Set<string>();
  const items: CatalogMediaItem[] = [];
  $('article.item.se.episodes').each((idx, el) => {
    const root = $(el);
    const link = root.find('.data a').attr('href') || root.find('.season_m a').attr('href');
    const url = normalizeTopAnimesUrl(link || '');
    const seriesTitle = cleanText(root.find('.data .serie').text());
    const epLabel = cleanText(root.find('.data h3').text());
    const altTitle = cleanText(root.find('.poster img').attr('alt'));
    const title = seriesTitle || altTitle;
    if (!url || !title || seen.has(url)) return;
    seen.add(url);

    const badgeText = cleanText(root.find('.buttonextra').text());
    const audioType = inferAudioType(badgeText || title);
    const quality = cleanText(root.find('.quality').text());
    const poster = upgradeImageUrl(
      root.find('.poster img').attr('src') || root.find('.poster img').attr('data-src')
    );

    items.push({
      id: makeSlugId(url, `ep-${idx}`),
      title,
      episodeLabel: epLabel || undefined,
      url,
      kind: 'episode',
      poster,
      audioType,
      quality: quality || undefined,
    });
  });
  return items;
}

export function parseHomeHtml(
  html: string,
  sourceMode: 'live' | 'snapshot' = 'live'
): HomeCatalog {
  const $ = cheerio.load(html);

  const calendar: CatalogMediaItem[] = [];
  $('#dt-seasons .item').each((idx, el) => {
    const root = $(el);
    const link = root.find('.data h3 a').attr('href') || root.find('.poster a').attr('href');
    const url = normalizeTopAnimesUrl(link || '');
    const title = cleanText(root.find('.data h3 a').text()) || cleanText(root.find('.poster img').attr('alt'));
    if (!url || !title) return;

    const badgeText = cleanText(root.find('.buttonextra').text());
    const audioType = inferAudioType(badgeText || title);
    const adiadoText = cleanText(root.find('.adiado_text').text());
    const isAdiado = /\bADIADO\b/i.test(adiadoText);
    const isHiatus = /\bHIATO\b/i.test(adiadoText) || isAdiado;
    const statusBadge = isAdiado ? 'Adiado' : isHiatus ? 'Hiato' : undefined;
    const poster = upgradeImageUrl(root.find('.poster img').attr('src') || root.find('.poster img').attr('data-src'));
    const year = cleanText(root.find('.data span').first().text());

    calendar.push({
      id: makeSlugId(url, `cal-${idx}`),
      title,
      url,
      kind: inferMediaKindFromUrl(url),
      poster,
      audioType,
      year: year || undefined,
      isHiatus,
      statusBadge,
    });
  });

  const releases = extractEpisodeArticles($);

  const animes: CatalogMediaItem[] = [];
  $('#dt-tvshows .item').each((idx, el) => {
    const root = $(el);
    const link = root.find('.data h3 a').attr('href') || root.find('.poster a').attr('href');
    const url = normalizeTopAnimesUrl(link || '');
    const title = cleanText(root.find('.data h3 a').text()) || cleanText(root.find('.poster img').attr('alt'));
    if (!url || !title) return;

    const rating = cleanText(root.find('.rating').text());
    const poster = upgradeImageUrl(root.find('.poster img').attr('src') || root.find('.poster img').attr('data-src'));
    const year = cleanText(root.find('.data span').first().text());

    animes.push({
      id: makeSlugId(url, `anime-${idx}`),
      title,
      url,
      kind: 'anime',
      poster,
      audioType: inferAudioType(title),
      rating: rating || undefined,
      year: year || undefined,
    });
  });

  const movies: CatalogMediaItem[] = [];
  $('#dt-movies .item').each((idx, el) => {
    const root = $(el);
    const link = root.find('.data h3 a').attr('href') || root.find('.poster a').attr('href');
    const url = normalizeTopAnimesUrl(link || '');
    const title = cleanText(root.find('.data h3 a').text()) || cleanText(root.find('.poster img').attr('alt'));
    if (!url || !title) return;

    const rating = cleanText(root.find('.rating').text());
    const quality = cleanText(root.find('.quality').text());
    const poster = upgradeImageUrl(root.find('.poster img').attr('src') || root.find('.poster img').attr('data-src'));
    const year = cleanText(root.find('.data span').first().text());

    movies.push({
      id: makeSlugId(url, `movie-${idx}`),
      title,
      url,
      kind: 'movie',
      poster,
      audioType: inferAudioType(title),
      rating: rating || undefined,
      quality: quality || undefined,
      year: year || undefined,
    });
  });

  return {
    calendar,
    releases,
    animes,
    movies,
    sourceMode,
    fetchedAt: new Date().toISOString(),
  };
}

function normalizeCalendarDayMeta(rawTitle: string, index: number): {
  id: string;
  label: string;
  isToday: boolean;
} {
  const cleaned = cleanText(rawTitle);
  const folded = cleaned
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  if (folded.includes('hoje')) return { id: 'hoje', label: 'Hoje', isToday: true };
  if (folded.includes('domingo')) return { id: 'domingo', label: 'Domingo', isToday: false };
  if (folded.includes('segunda')) return { id: 'segunda', label: 'Segunda', isToday: false };
  if (folded.includes('terca')) return { id: 'terca', label: 'Terça', isToday: false };
  if (folded.includes('quarta')) return { id: 'quarta', label: 'Quarta', isToday: false };
  if (folded.includes('quinta')) return { id: 'quinta', label: 'Quinta', isToday: false };
  if (folded.includes('sexta')) return { id: 'sexta', label: 'Sexta', isToday: false };
  if (folded.includes('sabado')) return { id: 'sabado', label: 'Sábado', isToday: false };
  const slug = folded.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `dia-${index}`;
  return { id: slug, label: cleaned || `Dia ${index + 1}`, isToday: false };
}

export function parseCalendarPageHtml(
  html: string,
  sourceMode: 'live' | 'snapshot' = 'live'
): WeeklyCalendarResponse {
  const $ = cheerio.load(html);
  const days: CalendarDaySection[] = [];
  const seenDayIds = new Set<string>();

  const container = $('#archive-content').first().length
    ? $('#archive-content').first()
    : $('.module .content').first();

  const headers = container.children('header');
  headers.each((sectionIdx, headerEl) => {
    const rawHeading = cleanText($(headerEl).find('h2, h1').first().text());
    if (!rawHeading) return;
    const grid = $(headerEl).nextAll('.items').first();
    if (!grid.length) return;

    const meta = normalizeCalendarDayMeta(rawHeading, sectionIdx);
    if (seenDayIds.has(meta.id)) return;
    seenDayIds.add(meta.id);

    const items: CatalogMediaItem[] = [];
    const seenUrls = new Set<string>();
    grid.find('article.item').each((idx, el) => {
      const root = $(el);
      const link = root.find('.data h3 a').attr('href') || root.find('.poster a').attr('href');
      const url = normalizeTopAnimesUrl(link || '');
      const title =
        cleanText(root.find('.data h3 a').text()) || cleanText(root.find('.poster img').attr('alt'));
      if (!url || !title || seenUrls.has(url)) return;
      seenUrls.add(url);

      const badgeText = cleanText(root.find('.buttonextra').text());
      const audioType = inferAudioType(badgeText || title);
      const adiadoText = cleanText(root.find('.adiado_text').text());
      const isAdiado = /\bADIADO\b/i.test(adiadoText);
      const isHiatus = /\bHIATO\b/i.test(adiadoText) || isAdiado;
      const statusBadge = isAdiado ? 'Adiado' : isHiatus ? 'Hiato' : undefined;
      const poster = upgradeImageUrl(
        root.find('.poster img').attr('src') || root.find('.poster img').attr('data-src')
      );
      const year = cleanText(root.find('.data span').first().text());
      const rawRating = cleanText(root.find('.rating').first().text());
      const numericRating = Number.parseFloat(rawRating);
      const rating =
        Number.isFinite(numericRating) && numericRating > 0
          ? Number(numericRating.toFixed(1)).toString()
          : undefined;

      items.push({
        id: makeSlugId(url, `wcal-${meta.id}-${idx}`),
        title,
        url,
        kind: inferMediaKindFromUrl(url),
        poster,
        audioType,
        rating,
        year: year || undefined,
        isHiatus,
        statusBadge,
      });
    });

    days.push({
      id: meta.id,
      label: meta.label,
      isToday: meta.isToday,
      items,
    });
  });

  return {
    days,
    sourceMode,
    fetchedAt: new Date().toISOString(),
  };
}

export function parseEpisodesArchiveHtml(html: string): {
  items: CatalogMediaItem[];
  currentPage: number;
  totalPages: number;
} {
  const $ = cheerio.load(html);
  return {
    items: extractEpisodeArticles($),
    ...parsePaginationMeta($),
  };
}

function parseArchiveCard(
  $: cheerio.CheerioAPI,
  el: Parameters<cheerio.CheerioAPI>[0],
  idx: number,
  defaultKind: MediaKind,
  forcedAudioType: AudioType,
  idPrefix: string
): CatalogMediaItem | null {
  const root = $(el);
  if (root.hasClass('episodes')) return null;
  const link = root.find('.data h3 a').attr('href') || root.find('.poster a').attr('href');
  const url = normalizeTopAnimesUrl(link || '');
  const title =
    cleanText(root.find('.data h3 a').text()) || cleanText(root.find('.poster img').attr('alt'));
  if (!url || !title) return null;

  const rawRating = cleanText(root.find('.rating').text());
  const numericRating = Number.parseFloat(rawRating);
  const rating = Number.isFinite(numericRating) && numericRating > 0 ? rawRating : '';
  const quality = cleanText(root.find('.quality').text());
  const poster = upgradeImageUrl(
    root.find('.poster img').attr('src') || root.find('.poster img').attr('data-src')
  );
  const year = cleanText(root.find('.data span').first().text());
  const inferredKind: MediaKind = root.hasClass('movies')
    ? 'movie'
    : inferMediaKindFromUrl(url) === 'movie'
      ? 'movie'
      : defaultKind;

  return {
    id: makeSlugId(url, `${idPrefix}-${idx}`),
    title,
    url,
    kind: inferredKind,
    poster,
    audioType: inferAudioType(title) ?? forcedAudioType,
    rating: rating || undefined,
    quality: quality || undefined,
    year: year || undefined,
  };
}

export function parseCatalogFilters($: cheerio.CheerioAPI): CatalogFilters {
  const genres: CatalogFilterOption[] = [];
  const years: CatalogFilterOption[] = [];
  const types: CatalogFilterOption[] = [];
  const seenGenre = new Set<string>();
  const seenYear = new Set<string>();
  const seenType = new Set<string>();

  $('.filter .select select option').each((_, el) => {
    const rawVal = cleanText($(el).attr('value'));
    const label = cleanText($(el).text());
    if (!rawVal || !/^https?:\/\//i.test(rawVal) || !label) return;
    const normalizedUrl = normalizeTopAnimesUrl(rawVal);
    if (!normalizedUrl) return;

    const genreMatch = normalizedUrl.match(/\/genero\/([a-z0-9-]+)\/?$/i);
    if (genreMatch?.[1]) {
      const slug = genreMatch[1].toLowerCase();
      if (!seenGenre.has(slug)) {
        seenGenre.add(slug);
        genres.push({ label, slug, url: normalizedUrl });
      }
      return;
    }

    const yearMatch = normalizedUrl.match(/\/l\/(\d{4})\/?$/i);
    if (yearMatch?.[1]) {
      const slug = yearMatch[1];
      if (!seenYear.has(slug)) {
        seenYear.add(slug);
        years.push({ label, slug, url: normalizedUrl });
      }
      return;
    }

    const typeMatch = normalizedUrl.match(/\/tipo\/([a-z0-9-]+)\/?$/i);
    if (typeMatch?.[1]) {
      const slug = typeMatch[1].toLowerCase();
      if (!seenType.has(slug)) {
        seenType.add(slug);
        types.push({ label, slug, url: normalizedUrl });
      }
    }
  });

  years.sort((a, b) => Number.parseInt(b.slug, 10) - Number.parseInt(a.slug, 10));
  return { genres, years, types };
}

export function parseCatalogArchiveHtml(
  html: string,
  defaultKind: MediaKind = 'anime',
  forcedAudioType: AudioType = null
): {
  items: CatalogMediaItem[];
  featured: CatalogMediaItem[];
  sliderMovies: SliderMovieItem[];
  filters: CatalogFilters;
  currentPage: number;
  totalPages: number;
} {
  const $ = cheerio.load(html);

  const seenFeatured = new Set<string>();
  const featured: CatalogMediaItem[] = [];
  $('.items.featured article.item').each((idx, el) => {
    const card = parseArchiveCard($, el, idx, defaultKind, forcedAudioType, 'feat');
    if (!card || seenFeatured.has(card.url)) return;
    seenFeatured.add(card.url);
    featured.push(card);
  });

  const seenSlider = new Set<string>();
  const seenSliderBackdrop = new Set<string>();
  const sliderMovies: SliderMovieItem[] = [];
  $('#slider-movies .item').each((idx, el) => {
    const root = $(el);
    const link = root.find('a').first().attr('href');
    const url = normalizeTopAnimesUrl(link || '');
    const title =
      cleanText(root.find('h3.title').text()) ||
      cleanText(root.find('.image img').attr('alt')).replace(/\s+Online$/i, '');
    if (!url || !title || seenSlider.has(url)) return;
    const backdrop = upgradeImageUrl(
      root.find('.image img').attr('src') || root.find('.image img').attr('data-src')
    );
    if (!backdrop || seenSliderBackdrop.has(backdrop)) return;
    seenSlider.add(url);
    seenSliderBackdrop.add(backdrop);
    const year = cleanText(root.find('strong.year').text());
    sliderMovies.push({
      id: makeSlugId(url, `slide-${idx}`),
      title,
      url,
      backdrop,
      year: year || undefined,
    });
  });

  const seenItems = new Set<string>();
  const items: CatalogMediaItem[] = [];
  const primaryNodes = $('#archive-content article.item');
  const targetNodes =
    primaryNodes.length > 0 ? primaryNodes : $('.items:not(.featured) article.item');

  targetNodes.each((idx, el) => {
    const card = parseArchiveCard($, el, idx, defaultKind, forcedAudioType, 'cat');
    if (!card || seenItems.has(card.url)) return;
    seenItems.add(card.url);
    items.push(card);
  });

  return {
    items,
    featured,
    sliderMovies,
    filters: parseCatalogFilters($),
    ...parsePaginationMeta($),
  };
}

export function parseSearchPageHtml(html: string): {
  results: SearchResultItem[];
  currentPage: number;
  totalPages: number;
} {
  const $ = cheerio.load(html);
  const results: SearchResultItem[] = [];

  $('.search-page .result-item').each((idx, el) => {
    const root = $(el);
    const link = root.find('.details .title a').attr('href') || root.find('.thumbnail a').attr('href');
    const url = normalizeTopAnimesUrl(link || '');
    const title = cleanText(root.find('.details .title a').text()) || cleanText(root.find('.thumbnail img').attr('alt'));
    if (!url || !title) return;

    const poster = upgradeImageUrl(root.find('.thumbnail img').attr('src') || root.find('.thumbnail img').attr('data-src'));
    const year = cleanText(root.find('.meta .year').text());
    const excerpt = cleanText(root.find('.contenido p').text());
    const isMovieBadge = root.find('.thumbnail .movies').length > 0;

    results.push({
      id: makeSlugId(url, `sr-${idx}`),
      title,
      url,
      kind: isMovieBadge ? 'movie' : inferMediaKindFromUrl(url),
      poster,
      year: year || undefined,
      excerpt: excerpt || undefined,
      audioType: inferAudioType(title),
    });
  });

  return {
    results,
    ...parsePaginationMeta($),
  };
}

export function parseSearchHtml(html: string): SearchResultItem[] {
  return parseSearchPageHtml(html).results;
}

export function parseWpSearchJson(
  payload: Record<
    string,
    {
      title?: string;
      url?: string;
      img?: string;
      extra?: { date?: string | boolean; imdb?: string | number | boolean };
    }
  >
): SearchResultItem[] {
  if (!payload || typeof payload !== 'object' || 'error' in payload) return [];
  const results: SearchResultItem[] = [];
  for (const [key, item] of Object.entries(payload)) {
    if (!item || typeof item !== 'object') continue;
    const url = normalizeTopAnimesUrl(item.url || '');
    const title = cleanText(item.title);
    if (!url || !title) continue;
    const rawDate = typeof item.extra?.date === 'string' ? cleanText(item.extra.date) : '';
    const rawImdb =
      typeof item.extra?.imdb === 'string' || typeof item.extra?.imdb === 'number'
        ? cleanText(String(item.extra.imdb))
        : '';
    const parsedImdb = Number.parseFloat(rawImdb);
    const rating =
      Number.isFinite(parsedImdb) && parsedImdb > 0
        ? Number(parsedImdb.toFixed(1)).toString()
        : undefined;
    results.push({
      id: makeSlugId(url, `wp-${key}`),
      title,
      url,
      kind: inferMediaKindFromUrl(url),
      poster: upgradeImageUrl(item.img),
      year: rawDate || undefined,
      rating,
      audioType: inferAudioType(title),
    });
  }
  return results;
}

export function parseWpGlossaryJson(
  payload: Record<
    string,
    {
      title?: string;
      url?: string;
      img?: string;
      year?: string | number | boolean;
      imdb?: string | number | boolean;
    }
  >
): CatalogMediaItem[] {
  if (!payload || typeof payload !== 'object' || 'error' in payload) return [];
  const items: CatalogMediaItem[] = [];
  const seen = new Set<string>();
  for (const [key, item] of Object.entries(payload)) {
    if (!item || typeof item !== 'object') continue;
    const url = normalizeTopAnimesUrl(item.url || '');
    const title = cleanText(item.title);
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);

    const rawYear =
      typeof item.year === 'string' || typeof item.year === 'number'
        ? cleanText(String(item.year))
        : '';
    const rawImdb =
      typeof item.imdb === 'string' || typeof item.imdb === 'number'
        ? cleanText(String(item.imdb))
        : '';
    const parsedImdb = Number.parseFloat(rawImdb);
    const rating =
      Number.isFinite(parsedImdb) && parsedImdb > 0
        ? Number(parsedImdb.toFixed(1)).toString()
        : undefined;

    items.push({
      id: makeSlugId(url, `gl-${key}`),
      title,
      url,
      kind: inferMediaKindFromUrl(url),
      poster: upgradeImageUrl(item.img),
      audioType: inferAudioType(title),
      rating,
      year: rawYear || undefined,
    });
  }
  return items;
}

export function extractDooPlayNonce(html: string): string | null {
  if (!html) return null;
  const dtGonzaMatch = html.match(/var\s+dtGonza\s*=\s*(\{[\s\S]*?\});/);
  if (dtGonzaMatch?.[1]) {
    const nonceMatch = dtGonzaMatch[1].match(/["']nonce["']\s*:\s*["']([a-zA-Z0-9_-]{4,64})["']/);
    if (nonceMatch?.[1]) return nonceMatch[1];
  }
  const fallbackMatch = html.match(/["']glossary["']\s*:[\s\S]{0,200}?["']nonce["']\s*:\s*["']([a-zA-Z0-9_-]{4,64})["']/);
  return fallbackMatch?.[1] || null;
}

export interface DooPlayAjaxConfig {
  ajaxUrl: string;
  playerApi: string;
  playMethod: 'admin_ajax' | 'wp_json';
}

export function extractDooPlayAjaxConfig(html: string): DooPlayAjaxConfig {
  const defaults: DooPlayAjaxConfig = {
    ajaxUrl: 'https://topanimes.net/wp-admin/admin-ajax.php',
    playerApi: 'https://topanimes.net/wp-json/dooplayer/v2/',
    playMethod: 'admin_ajax',
  };
  if (!html) return defaults;

  const dtAjaxMatch = html.match(/var\s+dtAjax\s*=\s*(\{[\s\S]*?\});/);
  if (!dtAjaxMatch?.[1]) return defaults;

  const rawBlock = dtAjaxMatch[1];
  const urlMatch = rawBlock.match(/["']url["']\s*:\s*["']([^"']+)["']/);
  const apiMatch = rawBlock.match(/["']player_api["']\s*:\s*["']([^"']+)["']/);
  const methodMatch = rawBlock.match(/["']play_method["']\s*:\s*["']([^"']+)["']/);

  const normalizedAjaxUrl = urlMatch?.[1]
    ? normalizeTopAnimesUrl(urlMatch[1].replace(/\\\//g, '/')) || defaults.ajaxUrl
    : defaults.ajaxUrl;
  const normalizedApi = apiMatch?.[1]
    ? normalizeTopAnimesUrl(apiMatch[1].replace(/\\\//g, '/')) || defaults.playerApi
    : defaults.playerApi;

  return {
    ajaxUrl: normalizedAjaxUrl,
    playerApi: normalizedApi.endsWith('/') ? normalizedApi : `${normalizedApi}/`,
    playMethod: methodMatch?.[1] === 'wp_json' ? 'wp_json' : 'admin_ajax',
  };
}

export interface MissingDooPlayerOption {
  post: string;
  nume: string;
  type: string;
  label: string;
}

export function extractMissingDooPlayerOptions(html: string): MissingDooPlayerOption[] {
  const $ = cheerio.load(html);
  const resolvedNumes = new Set<string>();

  $('[id^="source-player-"]').each((_, el) => {
    const id = $(el).attr('id') || '';
    const nume = id.replace(/^source-player-/, '');
    if (!nume || nume === 'trailer') return;
    const iframe = $(el).find('iframe').first();
    const rawSrc = iframe.attr('src') || iframe.attr('data-src') || '';
    if (unwrapAvisoUrl(rawSrc)) {
      resolvedNumes.add(nume);
    }
  });

  const missing: MissingDooPlayerOption[] = [];
  $('#playeroptionsul li.dooplay_player_option').each((_, el) => {
    const li = $(el);
    const nume = cleanText(li.attr('data-nume'));
    const post = cleanText(li.attr('data-post'));
    const type = cleanText(li.attr('data-type')) || 'tv';
    if (!nume || !post || nume === 'trailer' || resolvedNumes.has(nume)) return;
    const label = cleanText(li.find('.title').text()) || `Servidor ${nume}`;
    if (classifyProviderKind(label, '') === 'abyss') return;
    missing.push({ post, nume, type, label });
  });

  return missing;
}

export function parseDooPlayerAjaxResponse(body: string, baseUrl = 'https://topanimes.net/'): string {
  const trimmed = String(body || '').trim();
  if (!trimmed) return '';

  let rawTarget: string;
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { embed_url?: unknown; url?: unknown };
      const val =
        typeof parsed.embed_url === 'string'
          ? parsed.embed_url
          : typeof parsed.url === 'string'
            ? parsed.url
            : '';
      rawTarget = val.trim();
    } catch {
      return '';
    }
  } else {
    rawTarget = trimmed;
  }

  if (!rawTarget) return '';

  if (/<iframe\b/i.test(rawTarget)) {
    const iframeMatch = rawTarget.match(/<iframe[^>]+(?:src|data-src)=["']([^"']+)["']/i);
    rawTarget = iframeMatch?.[1]?.trim() || '';
  }
  if (!rawTarget) return '';

  let resolved = rawTarget;
  try {
    resolved = new URL(rawTarget, baseUrl).href;
  } catch {
    // keep rawTarget
  }
  return unwrapAvisoUrl(resolved);
}

export function parseSeasonNumberFromLabel(label: string): number | null {
  const trimmed = cleanText(label);
  if (!trimmed) return null;
  const dashMatch = trimmed.match(/^(\d+)\s*[-–/]\s*\d+/);
  if (dashMatch?.[1]) {
    const n = Number.parseInt(dashMatch[1], 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const wordMatch = trimmed.match(/(?:temporada|season|t)\s*0*(\d+)/i);
  if (wordMatch?.[1]) {
    const n = Number.parseInt(wordMatch[1], 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

function extractYearFromDateText(text: string): string | undefined {
  const clean = cleanText(text);
  if (!clean) return undefined;
  const fullYear = clean.match(/\b((?:19|20)\d{2})\b/);
  if (fullYear?.[1]) return fullYear[1];
  const shortDate = clean.match(/^\d{1,2}\/\d{1,2}\/(\d{2})$/);
  if (shortDate?.[1]) {
    const yy = Number.parseInt(shortDate[1], 10);
    return String(yy >= 50 ? 1900 + yy : 2000 + yy);
  }
  return undefined;
}

function looksLikePureYearOrDate(text: string): boolean {
  const clean = cleanText(text);
  if (!clean) return false;
  return /^(?:(?:19|20)\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|(?:jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez|feb|apr|may|aug|sep|oct|dec)[a-z.]*\s+\d{1,2},?\s+(?:19|20)\d{2})$/i.test(
    clean
  );
}

export function parseAnimePageHtml(html: string, pageUrl: string): AnimeDetails {
  const $ = cheerio.load(html);
  const canonicalUrl = normalizeTopAnimesUrl(pageUrl) || pageUrl;

  const rawTitle = cleanText($('.sheader .data h1').first().text()) || cleanText($('h1').first().text());
  const title = rawTitle.replace(/\s*-\s*TopAnimes\.net\s*$/i, '').trim() || 'Anime';

  const poster = upgradeImageUrl(
    $('.sheader .poster img').attr('src') ||
      $('.sheader .poster img').attr('data-src') ||
      $('.poster img').first().attr('src')
  );
  const backdrop = upgradeImageUrl($('meta[property="og:image"]').attr('content')) || poster;

  const synopsisParagraphs: string[] = [];
  $('#info .wp-content p, .sbox .wp-content p, .wp-content p').each((_, el) => {
    const p = cleanText($(el).text());
    if (p && !synopsisParagraphs.includes(p)) synopsisParagraphs.push(p);
  });
  const synopsis = synopsisParagraphs.join('\n\n');

  const rawHeaderDate = cleanText($('.sheader .extra .date').first().text());
  let year: string | undefined;
  let alternativeTitle: string | undefined;
  if (rawHeaderDate) {
    if (looksLikePureYearOrDate(rawHeaderDate)) {
      year = extractYearFromDateText(rawHeaderDate) || rawHeaderDate;
    } else if (rawHeaderDate.toLowerCase() !== title.toLowerCase()) {
      alternativeTitle = rawHeaderDate;
    }
  }

  let originalTitle: string | undefined;
  let tmdbRating: string | undefined;
  let tmdbVotes: string | undefined;
  let firstAirDate: string | undefined;
  let lastAirDate: string | undefined;
  let seasonsCount: string | undefined;
  let episodesTotalCount: string | undefined;
  let averageDuration: string | undefined;
  let myAnimeListUrl: string | undefined;

  $('#info .custom_fields, .custom_fields').each((_, el) => {
    const field = $(el);
    const rawLabel = cleanText(field.find('.variante').first().text());
    const foldedLabel = rawLabel
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    const valorEl = field.find('.valor, .valor2').first();
    const valueText = cleanText(valorEl.text());

    if (!foldedLabel) return;

    if (foldedLabel.includes('titulo original') && valueText) {
      originalTitle = originalTitle || valueText;
    } else if (foldedLabel.includes('tmdb') || foldedLabel.includes('imdb')) {
      const strongScore = cleanText(valorEl.find('strong').first().text());
      const scoreMatch = (strongScore || valueText).match(/(\d+(?:[.,]\d+)?)/);
      if (scoreMatch?.[1]) {
        const normalizedScore = scoreMatch[1].replace(',', '.');
        if (Number.parseFloat(normalizedScore) > 0) {
          tmdbRating = tmdbRating || normalizedScore;
        }
      }
      const votesMatch = valueText.match(/(\d[\d.,]*\s*votos?)/i);
      if (votesMatch?.[1]) {
        tmdbVotes = tmdbVotes || cleanText(votesMatch[1]);
      }
    } else if (foldedLabel.includes('estreia') && valueText) {
      firstAirDate = firstAirDate || valueText;
    } else if (foldedLabel.includes('ultimo episodio') && valueText) {
      lastAirDate = lastAirDate || valueText;
    } else if (foldedLabel === 'temporadas' && valueText) {
      seasonsCount = seasonsCount || valueText;
    } else if (foldedLabel === 'episodios' && valueText) {
      episodesTotalCount = episodesTotalCount || valueText;
    } else if (foldedLabel.includes('duracao') && valueText) {
      averageDuration = averageDuration || valueText;
    } else if (foldedLabel.includes('links')) {
      valorEl.find('a[href]').each((__, aEl) => {
        const href = cleanText($(aEl).attr('href'));
        if (
          !myAnimeListUrl &&
          href &&
          isSafeExternalHttpUrl(href) &&
          /(?:^|\.)myanimelist\.net$/i.test(new URL(href).hostname)
        ) {
          myAnimeListUrl = href;
        }
      });
    }
  });

  if (!year && firstAirDate) {
    year = extractYearFromDateText(firstAirDate);
  }

  const rawAllSeasons = cleanText($('seasons[data]').first().attr('data'));
  const allSeasonsUrl = rawAllSeasons ? normalizeTopAnimesUrl(rawAllSeasons) || undefined : undefined;

  const rawRating =
    cleanText($('.dt_rating_vgs').first().text()) ||
    cleanText($('.sheader .rating-value').first().text()) ||
    tmdbRating ||
    '';
  const numericRating = Number.parseFloat(rawRating);
  const rating =
    Number.isFinite(numericRating) && numericRating > 0 ? rawRating : undefined;

  const genres: string[] = [];
  $('.sgeneros a').each((_, el) => {
    const g = cleanText($(el).text());
    if (g && !genres.includes(g)) genres.push(g);
  });

  const episodes: AnimeEpisodeLink[] = [];
  const seenEpisodeUrls = new Set<string>();
  const seasonContainers = $('#seasons .se-c, #seasons .se-cu');

  const pushEpisodeLi = (
    li: ReturnType<typeof $>,
    containerSeasonNum: number | null,
    containerSeasonTitle: string
  ) => {
    const href = normalizeTopAnimesUrl(li.find('.episodiotitle a').attr('href') || '');
    if (!href || seenEpisodeUrls.has(href)) return;
    seenEpisodeUrls.add(href);
    const epTitle = cleanText(li.find('.episodiotitle a').text()) || 'Episódio';
    const numberLabel = cleanText(li.find('.numerando').text());
    const epNumText = cleanText(li.find('.epnumber').text());
    const parsedNum = Number.parseInt(epNumText, 10);
    const date = cleanText(li.find('.episodiotitle .date').text());
    const thumb = upgradeImageUrl(li.find('.imagen img').attr('src') || li.find('.imagen img').attr('data-src'));

    const parsedSeasonFromLabel = parseSeasonNumberFromLabel(numberLabel);
    const seasonNumber = parsedSeasonFromLabel ?? containerSeasonNum ?? 1;
    const seasonLabel =
      containerSeasonTitle && (!parsedSeasonFromLabel || parsedSeasonFromLabel === containerSeasonNum)
        ? containerSeasonTitle
        : `Temporada ${seasonNumber}`;

    episodes.push({
      numberLabel: numberLabel || (Number.isFinite(parsedNum) ? String(parsedNum) : ''),
      episodeNumber: Number.isFinite(parsedNum) ? parsedNum : null,
      seasonNumber,
      seasonLabel,
      title: epTitle,
      url: href,
      date: date || undefined,
      thumb: thumb || undefined,
    });
  };

  if (seasonContainers.length > 0) {
    seasonContainers.each((idx, secEl) => {
      const sec = $(secEl);
      const rawSeT = Number.parseInt(cleanText(sec.find('.se-q .se-t').first().text()), 10);
      const rawSeTitle = cleanText(sec.find('.se-q .title').first().text());
      const fallbackSeasonNum =
        Number.isFinite(rawSeT) && rawSeT > 0 ? rawSeT : idx + 1;
      sec.find('.episodios li').each((_, el) => {
        pushEpisodeLi($(el), fallbackSeasonNum, rawSeTitle);
      });
    });
  } else {
    $('#seasons .episodios li').each((_, el) => {
      pushEpisodeLi($(el), null, '');
    });
  }

  return {
    title,
    alternativeTitle,
    originalTitle,
    url: canonicalUrl,
    poster,
    backdrop,
    synopsis,
    year,
    rating,
    tmdbRating,
    tmdbVotes,
    firstAirDate,
    lastAirDate,
    seasonsCount,
    episodesTotalCount,
    averageDuration,
    myAnimeListUrl,
    allSeasonsUrl,
    genres,
    audioType: inferAudioType(title),
    episodes,
  };
}

export function classifyProviderKind(
  label: string,
  embedUrl: string
): PlayerOption['providerKind'] {
  const lowerUrl = embedUrl.toLowerCase();
  const lowerLabel = label.toLowerCase();
  if (lowerUrl.includes('/antivirus') || lowerLabel.includes('kojima')) return 'kojima';
  if (lowerUrl.includes('sk-boyceta') || lowerLabel.includes('vidstreaming')) return 'vidstreaming';
  if (lowerUrl.includes('booonceivu') || lowerLabel.includes('zuplay')) return 'zuplay';
  if (lowerUrl.includes('csst.online') || lowerLabel.includes('ruplay')) return 'playerjs';
  if (lowerUrl.includes('abyss') || lowerUrl.includes('short.icu') || lowerLabel.includes('aniplay')) return 'abyss';
  if (lowerUrl.includes('blogger.com/video.g') || lowerLabel === 'bg') return 'blogger';
  return 'other';
}

export function parseEpisodePageHtml(html: string, pageUrl: string): EpisodeDetails {
  const $ = cheerio.load(html);
  const canonicalUrl = normalizeTopAnimesUrl(pageUrl) || pageUrl;
  const isMovie = /\/filmes\//i.test(canonicalUrl);

  const hisTitle = cleanText($('#titleHis').text());
  const h1Title = cleanText($('.sbox .data h1, .sheader .data h1, h1').first().text())
    .replace(/^\s*Assistir\s+/i, '')
    .replace(/\s*-\s*TopAnimes\.net\s*$/i, '')
    .trim();

  const title = hisTitle || h1Title || 'Episódio';

  // Build iframe map keyed by `source-player-<nume>`
  const sourceMap = new Map<string, string>();
  $('[id^="source-player-"]').each((_, el) => {
    const id = $(el).attr('id') || '';
    const nume = id.replace(/^source-player-/, '');
    if (!nume || nume === 'trailer') return;
    const iframe = $(el).find('iframe').first();
    const rawSrc = iframe.attr('src') || iframe.attr('data-src') || '';
    const unwrapped = unwrapAvisoUrl(rawSrc);
    if (unwrapped) {
      sourceMap.set(nume, unwrapped);
    }
  });

  const options: PlayerOption[] = [];
  $('#playeroptionsul li.dooplay_player_option').each((_, el) => {
    const li = $(el);
    const nume = cleanText(li.attr('data-nume'));
    if (!nume || nume === 'trailer') return;
    const label = cleanText(li.find('.title').text()) || `Servidor ${nume}`;
    const embedUrl = sourceMap.get(nume) || '';
    if (!embedUrl) return;
    const providerKind = classifyProviderKind(label, embedUrl);
    if (providerKind === 'abyss') return;
    options.push({
      nume,
      label,
      embedUrl,
      providerKind,
    });
  });

  // If no #playeroptionsul options matched but `.mega-protect-card[data-player-url]` exists, include it
  if (!options.length) {
    const protectUrl = unwrapAvisoUrl($('.mega-protect-card[data-player-url]').attr('data-player-url') || '');
    if (protectUrl) {
      options.push({
        nume: '1',
        label: 'Servidor Principal',
        embedUrl: protectUrl,
        providerKind: classifyProviderKind('', protectUrl),
      });
    }
  }

  let prevUrl: string | undefined;
  let nextUrl: string | undefined;
  let seriesUrl: string | undefined;

  const navLinks = $('.pag_episodes a');
  navLinks.each((idx, el) => {
    const anchor = $(el);
    const text = cleanText(anchor.text());
    const href = normalizeTopAnimesUrl(anchor.attr('href') || '');
    if (!href) return;
    if (/\/animes\//i.test(href) && !/anterior|pr[oó]ximo/i.test(text)) {
      seriesUrl = href;
    } else if (/anterior/i.test(text) || idx === 0) {
      prevUrl = href;
    } else if (/pr[oó]ximo/i.test(text) || idx === 2) {
      nextUrl = href;
    }
  });

  if (!seriesUrl) {
    const breadcrumbSeries = $('a[href*="/animes/"]').first().attr('href');
    const normalized = normalizeTopAnimesUrl(breadcrumbSeries || '');
    if (normalized) seriesUrl = normalized;
  }

  const epSplit = title.split(/\s+-\s+(?:EP\s*\d+|Epis[oó]dio\s*\d+)/i);
  const seriesTitle = cleanText(epSplit[0]) || title;
  const epMatch = title.match(/(?:EP|Epis[oó]dio)\s*(\d+)/i);
  const episodeLabel = epMatch ? `Episódio ${epMatch[1]}` : isMovie ? 'Filme Completo' : undefined;

  const poster = upgradeImageUrl($('.poster img').first().attr('src'));
  const backdrop = upgradeImageUrl($('meta[property="og:image"]').attr('content')) || poster;
  const synopsis = cleanText($('#info .wp-content p, .wp-content p').first().text());

  const genres: string[] = [];
  $('.sgeneros a').each((_, el) => {
    const g = cleanText($(el).text());
    if (g && !genres.includes(g)) genres.push(g);
  });

  return {
    title,
    seriesTitle,
    seriesUrl,
    url: canonicalUrl,
    episodeLabel,
    poster,
    backdrop,
    synopsis,
    genres,
    prevUrl,
    nextUrl,
    options,
    isMovie,
  };
}

function labelToHeight(label: string, url = ''): number {
  const clean = String(label || '').trim().toLowerCase();
  const numMatch = clean.match(/(\d{3,4})\s*p?/);
  if (numMatch) return Number.parseInt(numMatch[1], 10);
  if (NAMED_HEIGHTS[clean]) return NAMED_HEIGHTS[clean];
  const urlMatch = url.match(/(?:^|[^\d])(2160|1440|1080|720|480|360|240)p?(?:[^\d]|$)/);
  if (urlMatch) return Number.parseInt(urlMatch[1], 10);
  return 0;
}

function guessStreamFormat(url: string, hintType = ''): StreamFormat {
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // ignore
  }
  if (/\.m3u8(?:$|\/)/i.test(pathname) || /hls|mpegurl|m3u8/i.test(hintType)) return 'hls';
  if (/\.(?:mp4|webm|m4v|mkv)\/?$/i.test(pathname) || /videoplayback\/?$/i.test(pathname) || /mp4/i.test(hintType)) {
    return 'mp4';
  }
  return 'unknown';
}

function formatQualityLabel(rawLabel: string, height: number, format: StreamFormat): string {
  const clean = cleanText(rawLabel);
  if (/^\d{3,4}p$/i.test(clean)) return clean;
  if (height > 0 && clean) return `${clean} (${height}p)`;
  if (height > 0) return `${height}p`;
  if (clean) return clean;
  return format === 'hls' ? 'HLS Auto' : 'Original';
}

function dedupeAndSortStreams(list: StreamQuality[]): StreamQuality[] {
  const seen = new Set<string>();
  const out: StreamQuality[] = [];
  for (const item of list) {
    if (!isSafeExternalHttpUrl(item.url) || AD_HOST_RE.test(item.url)) continue;
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    out.push(item);
  }
  out.sort((a, b) => b.height - a.height);
  return out;
}

function dedupeSubtitles(list: SubtitleTrack[]): SubtitleTrack[] {
  const seen = new Set<string>();
  const out: SubtitleTrack[] = [];
  for (const item of list) {
    if (!isSafeExternalHttpUrl(item.url) || seen.has(item.url)) continue;
    seen.add(item.url);
    out.push(item);
  }
  return out;
}

function tryParseLooseJsArray(raw: string): unknown[] | null {
  // Replace unquoted keys after `{` or `,`, convert single-quoted strings safely, strip trailing commas
  let normalized = raw.replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":');
  normalized = normalized.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, inner: string) =>
    JSON.stringify(inner.replace(/\\'/g, "'"))
  );
  normalized = normalized.replace(/,\s*([}\]])/g, '$1');
  try {
    const parsed = JSON.parse(normalized);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function extractStreamsFromEmbed(
  embedUrl: string,
  body: string
): {
  streams: StreamQuality[];
  subtitles: SubtitleTrack[];
  poster?: string;
  provider: string;
} {
  const trimmed = body.trim();
  const streams: StreamQuality[] = [];
  const subtitles: SubtitleTrack[] = [];
  let poster: string | undefined;

  // 1. Vidstreaming JSON (`{ status: "success", midias: [...], legendas: [...] }`)
  if (trimmed.startsWith('{')) {
    try {
      const json = JSON.parse(trimmed) as {
        status?: string;
        capa?: string | null;
        midias?: Array<{ qualidade?: string; url?: string }>;
        legendas?: Array<{ label?: string; url?: string; default?: boolean }>;
      };
      if (json && Array.isArray(json.midias)) {
        if (json.capa && isSafeExternalHttpUrl(json.capa)) poster = json.capa;
        for (const m of json.midias) {
          if (!m?.url) continue;
          const abs = new URL(m.url, embedUrl).href;
          const format = guessStreamFormat(abs);
          const height = labelToHeight(m.qualidade || '', abs);
          streams.push({
            label: formatQualityLabel(m.qualidade || '', height, format),
            height,
            url: abs,
            format,
          });
        }
        if (Array.isArray(json.legendas)) {
          for (const sub of json.legendas) {
            if (!sub?.url) continue;
            const abs = new URL(sub.url, embedUrl).href;
            const label = cleanText(sub.label) || 'Legenda';
            subtitles.push({
              label,
              url: abs,
              isDefault: !!sub.default || /portugu[eê]s|pt[-_]?br/i.test(label),
            });
          }
        }
        return {
          streams: dedupeAndSortStreams(streams),
          subtitles: dedupeSubtitles(subtitles),
          poster,
          provider: 'Vidstreaming',
        };
      }
    } catch {
      // fall through to HTML extraction
    }
  }

  // 2. Playerjs (`new Playerjs({ ... })` or `Playerjs({ ... })`) - scan all blocks (mobile/desktop branches)
  for (const pjsMatch of body.matchAll(/Playerjs\s*\(\s*(\{[\s\S]*?\})\s*\)/gi)) {
    const block = pjsMatch[1];
    const fileMatch = block.match(/file\s*:\s*(['"])([\s\S]*?)\1/);
    const subMatch = block.match(/subtitles?\s*:\s*(['"])([\s\S]*?)\1/);
    const posterMatch = block.match(/(?:poster|image)\s*:\s*(['"])([\s\S]*?)\1/);
    if (!poster && posterMatch?.[2] && isSafeExternalHttpUrl(posterMatch[2])) {
      poster = posterMatch[2];
    }
    if (fileMatch?.[2] && !fileMatch[2].startsWith('#')) {
      const parts = fileMatch[2].split(/,\s*(?=\[|https?:\/\/|\/\/)|\s+or\s+/i);
      for (const part of parts) {
        const m = part.trim().match(/^(?:\[([^\]]+)\])?\s*(.+)$/);
        if (!m?.[2]) continue;
        try {
          const abs = new URL(m[2].trim(), embedUrl).href;
          const format = guessStreamFormat(abs);
          const lbl = cleanText(m[1]);
          const height = labelToHeight(lbl, abs);
          streams.push({
            label: formatQualityLabel(lbl, height, format),
            height,
            url: abs,
            format,
          });
        } catch {
          // skip malformed
        }
      }
    }
    if (subMatch?.[2]) {
      const subParts = subMatch[2].split(/,\s*(?=\[|https?:\/\/|\/\/)/i);
      for (const sp of subParts) {
        const sm = sp.trim().match(/^(?:\[([^\]]+)\])?\s*(.+)$/);
        if (!sm?.[2]) continue;
        try {
          const abs = new URL(sm[2].trim(), embedUrl).href;
          const lbl = cleanText(sm[1]) || 'Legenda';
          subtitles.push({
            label: lbl,
            url: abs,
            isDefault: /portugu[eê]s|pt[-_]?br/i.test(lbl),
          });
        } catch {
          // skip
        }
      }
    }
    if (streams.length) {
      return {
        streams: dedupeAndSortStreams(streams),
        subtitles: dedupeSubtitles(subtitles),
        poster,
        provider: 'Playerjs',
      };
    }
  }

  // 3. Blogger (<c-wiz data-p="..."> containing googlevideo.com/videoplayback)
  if (body.includes('googlevideo.com/videoplayback')) {
    const unescaped = body.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) =>
      String.fromCharCode(Number.parseInt(h, 16))
    );
    const re = /\["(https:\/\/[^"\s]+?googlevideo\.com\/videoplayback\?[^"\s]+)",\[(\d+)\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(unescaped)) !== null) {
      const itag = Number.parseInt(m[2], 10);
      const height = ITAG_HEIGHT[itag] || 0;
      streams.push({
        label: height ? `${height}p` : `itag ${itag}`,
        height,
        url: m[1],
        format: 'mp4',
      });
    }
    if (streams.length) {
      return {
        streams: dedupeAndSortStreams(streams),
        subtitles: [],
        poster,
        provider: 'Blogger',
      };
    }
  }

  // 4. JW Player (`jwplayer(...).setup({...})`) & generic inline stream scan
  const jwSourcesMatch = body.match(/sources\s*:\s*(\[[\s\S]*?\])/);
  if (jwSourcesMatch) {
    const parsed = tryParseLooseJsArray(jwSourcesMatch[1]) as
      | Array<{ file?: string; src?: string; url?: string; label?: string; type?: string }>
      | null;
    if (parsed) {
      for (const s of parsed) {
        const rawUrl = s?.file || s?.src || s?.url;
        if (!rawUrl) continue;
        try {
          const abs = new URL(rawUrl, embedUrl).href;
          const format = guessStreamFormat(abs, s.type || '');
          const height = labelToHeight(s.label || '', abs);
          streams.push({
            label: formatQualityLabel(s.label || '', height, format),
            height,
            url: abs,
            format,
          });
        } catch {
          // skip
        }
      }
    }
  }

  // Extract JW Player tracks if present
  const tracksMatch = body.match(/tracks\s*:\s*(\[[\s\S]*?\])/);
  if (tracksMatch) {
    const parsed = tryParseLooseJsArray(tracksMatch[1]) as
      | Array<{ file?: string; label?: string; kind?: string; default?: boolean }>
      | null;
    if (parsed) {
      for (const t of parsed) {
        if (!t?.file || (t.kind && !/captions|subtitles/i.test(t.kind))) continue;
        try {
          const abs = new URL(t.file, embedUrl).href;
          subtitles.push({
            label: cleanText(t.label) || 'Legenda',
            url: abs,
            isDefault: !!t.default,
          });
        } catch {
          // skip
        }
      }
    }
  }

  // Fallback direct scan for `.m3u8` and `.mp4` URLs
  if (!streams.length) {
    const urlRe = /https?:\/\/[^"'\\\s<>]+?(?:\.m3u8|\.mp4)(?:\?[^"'\\\s<>]*)?/gi;
    let m: RegExpExecArray | null;
    while ((m = urlRe.exec(body)) !== null) {
      const foundUrl = m[0];
      if (AD_HOST_RE.test(foundUrl)) continue;
      const format = guessStreamFormat(foundUrl);
      const height = labelToHeight('', foundUrl);
      streams.push({
        label: formatQualityLabel('', height, format),
        height,
        url: foundUrl,
        format,
      });
    }
  }

  const imageMatch = body.match(/["']?image["']?\s*:\s*["'](https?:\/\/[^"']+)["']/i);
  if (!poster && imageMatch?.[1] && isSafeExternalHttpUrl(imageMatch[1])) {
    poster = imageMatch[1];
  }

  return {
    streams: dedupeAndSortStreams(streams),
    subtitles: dedupeSubtitles(subtitles),
    poster,
    provider: embedUrl.includes('booonceivu.shop')
      ? 'Zuplay'
      : embedUrl.includes('antivirus')
        ? 'KojimaCDN'
        : 'Direto',
  };
}
