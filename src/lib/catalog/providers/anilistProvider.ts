import type { HttpFetcher } from '../../httpTypes.ts';
import type {
  AniListCountry,
  AniListDiscoverFilters,
  AniListFormat,
  AniListSeason,
  AniListSortOption,
  AniListStatus,
  AniListTagItem,
  AnimeDetails,
  AnimeMediaTag,
  AudioType,
  CatalogMediaItem,
  DiscoverAudioFilter,
  DiscoverCatalogResponse,
  DiscoverTaxonomyResponse,
  ProviderAvailabilityInfo,
} from '../../types.ts';
import {
  buildAniListMediaUri,
  buildExternalDatabaseLinks,
  canonicalMediaKey,
  normalizeTitleForMatch,
  scoreTitleSimilarity,
  type CanonicalMediaType,
} from '../idCodec.ts';
import {
  ensureProviderIndexLoaded,
  matchTitlesAgainstProviderIndex,
  type ProviderIndexStats,
} from '../providerIndex.ts';
import {
  translateAniListCategory,
  translateAniListTagDescription,
  translateAniListTagName,
} from './anilistTaxonomyPt.ts';

export const ANILIST_GRAPHQL_URL = 'https://graphql.anilist.co';
export const DEFAULT_ANILIST_MIN_TAG_RANK = 18;

export interface FilterChoice<T extends string = string> {
  value: T;
  label: string;
}

export const ANILIST_SORT_OPTIONS: readonly FilterChoice<AniListSortOption>[] = [
  { value: 'TRENDING_DESC', label: 'Em Alta' },
  { value: 'POPULARITY_DESC', label: 'Mais Populares' },
  { value: 'SCORE_DESC', label: 'Melhor Avaliados' },
  { value: 'START_DATE_DESC', label: 'Lançamentos' },
  { value: 'FAVOURITES_DESC', label: 'Favoritos' },
];

export const ANILIST_GENRES: readonly FilterChoice[] = [
  { value: 'Action', label: 'Ação' },
  { value: 'Adventure', label: 'Aventura' },
  { value: 'Comedy', label: 'Comédia' },
  { value: 'Drama', label: 'Drama' },
  { value: 'Ecchi', label: 'Ecchi' },
  { value: 'Fantasy', label: 'Fantasia' },
  { value: 'Horror', label: 'Terror' },
  { value: 'Mahou Shoujo', label: 'Garotas Mágicas' },
  { value: 'Mecha', label: 'Mecha' },
  { value: 'Music', label: 'Música' },
  { value: 'Mystery', label: 'Mistério' },
  { value: 'Psychological', label: 'Psicológico' },
  { value: 'Romance', label: 'Romance' },
  { value: 'Sci-Fi', label: 'Ficção Científica' },
  { value: 'Slice of Life', label: 'Cotidiano' },
  { value: 'Sports', label: 'Esportes' },
  { value: 'Supernatural', label: 'Sobrenatural' },
  { value: 'Thriller', label: 'Suspense' },
];

export const ANILIST_GENRE_LABEL_MAP: Record<string, string> = Object.fromEntries(
  ANILIST_GENRES.map((g) => [g.value, g.label])
);

export const ANILIST_POPULAR_TAGS: readonly FilterChoice[] = [
  { value: 'Isekai', label: 'Isekai' },
  { value: 'Shounen', label: 'Shounen' },
  { value: 'Seinen', label: 'Seinen' },
  { value: 'Shoujo', label: 'Shoujo' },
  { value: 'Josei', label: 'Josei' },
  { value: 'School', label: 'Escola' },
  { value: 'Magic', label: 'Magia' },
  { value: 'Martial Arts', label: 'Artes Marciais' },
  { value: 'Time Manipulation', label: 'Viagem no Tempo' },
  { value: 'Reincarnation', label: 'Reencarnação' },
  { value: 'Cyberpunk', label: 'Cyberpunk' },
  { value: 'Post-Apocalyptic', label: 'Pós-Apocalíptico' },
  { value: 'Vampire', label: 'Vampiros' },
  { value: 'Demons', label: 'Demônios' },
  { value: 'Military', label: 'Militar' },
  { value: 'Historical', label: 'Histórico' },
  { value: 'Parody', label: 'Paródia' },
  { value: 'Survival', label: 'Sobrevivência' },
  { value: 'Revenge', label: 'Vingança' },
  { value: 'Swordplay', label: 'Espadachins' },
  { value: 'Detective', label: 'Detetive' },
  { value: 'Space', label: 'Espaço' },
  { value: 'Mythology', label: 'Mitologia' },
  { value: 'Gore', label: 'Gore / Violento' },
];

export const ANILIST_SEASONS: readonly FilterChoice<AniListSeason>[] = [
  { value: 'WINTER', label: 'Inverno (Jan–Mar)' },
  { value: 'SPRING', label: 'Primavera (Abr–Jun)' },
  { value: 'SUMMER', label: 'Verão (Jul–Set)' },
  { value: 'FALL', label: 'Outono (Out–Dez)' },
];

export const ANILIST_FORMATS: readonly FilterChoice<AniListFormat>[] = [
  { value: 'TV', label: 'Série de TV' },
  { value: 'MOVIE', label: 'Filme' },
  { value: 'OVA', label: 'OVA' },
  { value: 'ONA', label: 'ONA' },
  { value: 'SPECIAL', label: 'Especial' },
];

export const ANILIST_STATUSES: readonly FilterChoice<AniListStatus>[] = [
  { value: 'RELEASING', label: 'Em Lançamento' },
  { value: 'FINISHED', label: 'Finalizado' },
  { value: 'NOT_YET_RELEASED', label: 'Em Breve' },
];

export const ANILIST_COUNTRIES: readonly FilterChoice<AniListCountry>[] = [
  { value: 'JP', label: 'Japão (Anime)' },
  { value: 'CN', label: 'China (Donghua)' },
  { value: 'KR', label: 'Coreia (Aeni)' },
];

export const ANILIST_AUDIO_FILTERS: readonly FilterChoice<DiscoverAudioFilter>[] = [
  { value: 'ALL', label: 'Todos os áudios' },
  { value: 'DUB', label: 'Dublado (DUB)' },
  { value: 'LEG', label: 'Legendado (LEG)' },
];

export const VALID_ANILIST_SORTS = new Set<AniListSortOption>(
  ANILIST_SORT_OPTIONS.map((o) => o.value)
);
export const VALID_ANILIST_GENRES = new Set<string>(ANILIST_GENRES.map((g) => g.value));
export const VALID_ANILIST_TAGS = new Set<string>(ANILIST_POPULAR_TAGS.map((t) => t.value));
export const VALID_ANILIST_SEASONS = new Set<AniListSeason>(ANILIST_SEASONS.map((s) => s.value));
export const VALID_ANILIST_FORMATS = new Set<AniListFormat>(ANILIST_FORMATS.map((f) => f.value));
export const VALID_ANILIST_STATUSES = new Set<AniListStatus>(ANILIST_STATUSES.map((s) => s.value));
export const VALID_ANILIST_COUNTRIES = new Set<AniListCountry>(
  ANILIST_COUNTRIES.map((c) => c.value)
);

const SAFE_ANILIST_TAG_RE = /^[A-Za-z0-9 '&\-/().+!?,:]+$/;

/**
 * Validates any official AniList tag name safely (allows all 360+ MediaTagCollection entries
 * while blocking injection/control characters).
 */
export function sanitizeAniListTagName(raw: string): string | null {
  const clean = (raw || '').replace(/\s+/g, ' ').trim();
  if (!clean || clean.length < 2 || clean.length > 64) return null;
  if (!SAFE_ANILIST_TAG_RE.test(clean)) return null;
  return clean;
}

export function formatAniListTagLabel(name: string): string {
  return translateAniListTagName(name);
}

interface RawAniListTag {
  name?: string | null;
  description?: string | null;
  category?: string | null;
  rank?: number | null;
  isMediaSpoiler?: boolean | null;
  isGeneralSpoiler?: boolean | null;
  isAdult?: boolean | null;
}

interface RawAniListMedia {
  id: number;
  idMal?: number | null;
  title?: {
    romaji?: string | null;
    english?: string | null;
    native?: string | null;
    userPreferred?: string | null;
  } | null;
  synonyms?: string[] | null;
  coverImage?: {
    extraLarge?: string | null;
    large?: string | null;
  } | null;
  bannerImage?: string | null;
  averageScore?: number | null;
  seasonYear?: number | null;
  startDate?: {
    year?: number | null;
  } | null;
  format?: string | null;
  status?: string | null;
  episodes?: number | null;
  duration?: number | null;
  genres?: string[] | null;
  description?: string | null;
  studios?: {
    nodes?: Array<{ name?: string | null }> | null;
  } | null;
  tags?: RawAniListTag[] | null;
}

interface RawAniListPageResponse {
  data?: {
    Page?: {
      pageInfo?: {
        total?: number;
        currentPage?: number;
        lastPage?: number;
        hasNextPage?: boolean;
      };
      media?: RawAniListMedia[];
    };
  };
  errors?: Array<{ message?: string }>;
}

const DISCOVER_QUERY = `
query AnisyncDiscover(
  $page: Int!,
  $perPage: Int!,
  $sort: [MediaSort],
  $genreIn: [String],
  $genreNotIn: [String],
  $tagIn: [String],
  $tagNotIn: [String],
  $minimumTagRank: Int,
  $season: MediaSeason,
  $seasonYear: Int,
  $format: MediaFormat,
  $status: MediaStatus,
  $statusNot: MediaStatus,
  $countryOfOrigin: CountryCode,
  $search: String
) {
  Page(page: $page, perPage: $perPage) {
    pageInfo {
      total
      currentPage
      lastPage
      hasNextPage
    }
    media(
      type: ANIME,
      isAdult: false,
      sort: $sort,
      genre_in: $genreIn,
      genre_not_in: $genreNotIn,
      tag_in: $tagIn,
      tag_not_in: $tagNotIn,
      minimumTagRank: $minimumTagRank,
      season: $season,
      seasonYear: $seasonYear,
      format: $format,
      status: $status,
      status_not: $statusNot,
      countryOfOrigin: $countryOfOrigin,
      search: $search
    ) {
      id
      idMal
      title {
        romaji
        english
        native
        userPreferred
      }
      synonyms
      coverImage {
        extraLarge
        large
      }
      bannerImage
      averageScore
      seasonYear
      startDate {
        year
      }
      format
      status
      episodes
      genres
    }
  }
}
`;

const TAXONOMY_QUERY = `
query AnisyncTaxonomy {
  GenreCollection
  MediaTagCollection {
    name
    category
    description
    isAdult
  }
}
`;

const MEDIA_DETAILS_FIELDS = `
  id
  idMal
  title {
    romaji
    english
    native
    userPreferred
  }
  synonyms
  coverImage {
    extraLarge
    large
  }
  bannerImage
  averageScore
  seasonYear
  startDate {
    year
  }
  format
  status
  episodes
  duration
  genres
  description(asHtml: false)
  studios(isMain: true) {
    nodes {
      name
    }
  }
  tags {
    name
    description
    category
    rank
    isMediaSpoiler
    isGeneralSpoiler
    isAdult
  }
`;

const MEDIA_BY_ID_QUERY = `
query AnisyncMediaById($id: Int!) {
  Media(id: $id, type: ANIME, isAdult: false) {
    ${MEDIA_DETAILS_FIELDS}
  }
}
`;

const MEDIA_BY_MAL_ID_QUERY = `
query AnisyncMediaByMalId($idMal: Int!) {
  Media(idMal: $idMal, type: ANIME, isAdult: false) {
    ${MEDIA_DETAILS_FIELDS}
  }
}
`;

const MEDIA_SEARCH_DETAILS_QUERY = `
query AnisyncMediaSearchDetails($search: String!) {
  Page(page: 1, perPage: 6) {
    media(search: $search, type: ANIME, isAdult: false, sort: [SEARCH_MATCH, POPULARITY_DESC]) {
      ${MEDIA_DETAILS_FIELDS}
    }
  }
}
`;

export function translateAniListGenreToPt(genre: string): string {
  return ANILIST_GENRE_LABEL_MAP[genre] || genre;
}

function stripAniListHtml(raw?: string | null): string {
  if (!raw) return '';
  return raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function formatAniListMediaFormat(raw?: string | null): string | undefined {
  switch ((raw || '').toUpperCase()) {
    case 'TV':
      return 'TV';
    case 'TV_SHORT':
      return 'TV Curta';
    case 'MOVIE':
      return 'Filme';
    case 'OVA':
      return 'OVA';
    case 'ONA':
      return 'ONA';
    case 'SPECIAL':
      return 'Especial';
    default:
      return undefined;
  }
}

export function buildAniListDiscoverVariables(
  filters: AniListDiscoverFilters,
  page: number,
  perPage: number
): Record<string, unknown> {
  const onlyAvailable = filters.onlyAvailable !== false;
  const sort: AniListSortOption =
    filters.sort && VALID_ANILIST_SORTS.has(filters.sort) ? filters.sort : 'TRENDING_DESC';

  const vars: Record<string, unknown> = {
    page: Math.max(1, Math.floor(page)),
    perPage: Math.min(50, Math.max(10, Math.floor(perPage))),
    sort: filters.search?.trim() ? ['SEARCH_MATCH', sort] : [sort],
  };

  const rawGenres = [
    ...(Array.isArray(filters.genres) ? filters.genres : []),
    ...(filters.genre ? [filters.genre] : []),
  ];
  const validGenres = Array.from(
    new Set(rawGenres.map((g) => g.trim()).filter((g) => VALID_ANILIST_GENRES.has(g)))
  ).slice(0, 6);
  if (validGenres.length > 0) {
    vars.genreIn = validGenres;
  }

  const includedGenreSet = new Set(validGenres);
  const rawExcludeGenres = Array.isArray(filters.excludeGenres) ? filters.excludeGenres : [];
  const validExcludeGenres = Array.from(
    new Set(
      rawExcludeGenres
        .map((g) => g.trim())
        .filter((g) => VALID_ANILIST_GENRES.has(g) && !includedGenreSet.has(g))
    )
  ).slice(0, 12);
  if (validExcludeGenres.length > 0) {
    vars.genreNotIn = validExcludeGenres;
  }

  const rawTags = [
    ...(Array.isArray(filters.tags) ? filters.tags : []),
    ...(filters.tag ? [filters.tag] : []),
  ];
  const validTags = Array.from(
    new Set(
      rawTags
        .map((t) => sanitizeAniListTagName(t))
        .filter((t): t is string => Boolean(t))
    )
  ).slice(0, 6);
  if (validTags.length > 0) {
    vars.tagIn = validTags;
  }

  const includedTagSet = new Set(validTags.map((t) => t.toLowerCase()));
  const rawExcludeTags = Array.isArray(filters.excludeTags) ? filters.excludeTags : [];
  const validExcludeTags = Array.from(
    new Set(
      rawExcludeTags
        .map((t) => sanitizeAniListTagName(t))
        .filter((t): t is string => t !== null && t.length > 0 && !includedTagSet.has(t.toLowerCase()))
    )
  ).slice(0, 12);
  if (validExcludeTags.length > 0) {
    vars.tagNotIn = validExcludeTags;
  }
  if (
    typeof filters.minimumTagRank === 'number' &&
    Number.isFinite(filters.minimumTagRank)
  ) {
    const clampedRank = Math.min(100, Math.max(0, Math.round(filters.minimumTagRank)));
    if (clampedRank !== DEFAULT_ANILIST_MIN_TAG_RANK || validTags.length > 0 || validExcludeTags.length > 0) {
      vars.minimumTagRank = clampedRank;
    }
  }
  if (filters.season && VALID_ANILIST_SEASONS.has(filters.season)) {
    vars.season = filters.season;
  }
  const parsedYear = filters.year ? Number.parseInt(filters.year, 10) : NaN;
  if (Number.isFinite(parsedYear) && parsedYear >= 1960 && parsedYear <= 2030) {
    vars.seasonYear = parsedYear;
  }
  if (filters.format && VALID_ANILIST_FORMATS.has(filters.format)) {
    vars.format = filters.format;
  }
  if (filters.status && VALID_ANILIST_STATUSES.has(filters.status)) {
    vars.status = filters.status;
  } else if (onlyAvailable) {
    // Prevent pre-release placeholder entries from wasting slots when filtering for playable animes
    vars.statusNot = 'NOT_YET_RELEASED';
  }
  if (filters.country && VALID_ANILIST_COUNTRIES.has(filters.country)) {
    vars.countryOfOrigin = filters.country;
  }
  const search = filters.search?.trim();
  if (search) {
    vars.search = search;
  }

  return vars;
}

function collectAniListTitles(media: RawAniListMedia): {
  primaryTitle: string;
  englishTitle?: string;
  allTitles: string[];
} {
  const romaji = media.title?.romaji?.trim() || '';
  const english = media.title?.english?.trim() || '';
  const preferred = media.title?.userPreferred?.trim() || '';
  const native = media.title?.native?.trim() || '';
  const synonyms = Array.isArray(media.synonyms)
    ? media.synonyms.map((s) => (s || '').trim()).filter((s) => s.length >= 2)
    : [];

  const primaryTitle = romaji || english || preferred || native || `Anime #${media.id}`;
  const englishTitle = english && english !== primaryTitle ? english : undefined;

  const seen = new Set<string>();
  const allTitles: string[] = [];
  for (const candidate of [romaji, english, preferred, ...synonyms, native]) {
    const clean = candidate.trim();
    if (!clean || clean.length < 2) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    allTitles.push(clean);
  }

  return { primaryTitle, englishTitle, allTitles };
}

function mapRawAniListMediaToCatalogItem(
  media: RawAniListMedia,
  availability: ProviderAvailabilityInfo,
  audioFilter: DiscoverAudioFilter
): CatalogMediaItem {
  const { primaryTitle, englishTitle, allTitles } = collectAniListTitles(media);
  const mediaKind = media.format === 'MOVIE' ? 'movie' : 'anime';
  const yearNum = media.seasonYear || media.startDate?.year;
  const year = yearNum && yearNum > 1900 ? String(yearNum) : undefined;
  const score =
    typeof media.averageScore === 'number' && media.averageScore > 0
      ? (media.averageScore / 10).toFixed(1)
      : undefined;

  const isUnreleased = media.status === 'NOT_YET_RELEASED';
  const effectiveAvailability: ProviderAvailabilityInfo = isUnreleased
    ? {
        ...availability,
        available: false,
        unreleased: true,
      }
    : availability;

  // Prefer the matched provider URL directly when available so opening hits the fast
  // provider + TheTVDB pipeline and shares exact canonical keys with Favorites/History.
  const resolvedProviderUrl = effectiveAvailability.available
    ? audioFilter === 'DUB'
      ? effectiveAvailability.dubUrl || effectiveAvailability.legUrl
      : effectiveAvailability.legUrl || effectiveAvailability.dubUrl
    : undefined;

  const targetUrl =
    resolvedProviderUrl || buildAniListMediaUri(media.id, primaryTitle, englishTitle, mediaKind);

  const audioType: AudioType = effectiveAvailability.available
    ? audioFilter === 'DUB' && effectiveAvailability.hasDub
      ? 'DUB'
      : effectiveAvailability.hasDub && !effectiveAvailability.hasLeg
        ? 'DUB'
        : effectiveAvailability.hasLeg
          ? 'LEG'
          : null
    : null;

  const statusBadge = isUnreleased
    ? 'Em breve'
    : !effectiveAvailability.available
      ? 'Indisponível'
      : media.status === 'RELEASING'
        ? 'Em exibição'
        : undefined;

  return {
    id: `anilist-${media.id}`,
    title: primaryTitle,
    englishTitle,
    alternativeTitles: allTitles,
    url: targetUrl,
    kind: mediaKind,
    poster: media.coverImage?.extraLarge || media.coverImage?.large || '',
    audioType,
    rating: score,
    year,
    statusBadge,
    catalogSource: 'anilist',
    sourceServerName: effectiveAvailability.providerNames[0] || undefined,
    externalIds: {
      aniListId: media.id,
      ...(media.idMal && media.idMal > 0 ? { malId: media.idMal } : {}),
    },
    mediaFormat: formatAniListMediaFormat(media.format),
    genres: (media.genres || []).map(translateAniListGenreToPt),
    anilistStatus:
      media.status === 'RELEASING' ||
      media.status === 'FINISHED' ||
      media.status === 'NOT_YET_RELEASED'
        ? media.status
        : undefined,
    episodesCount: typeof media.episodes === 'number' && media.episodes > 0 ? media.episodes : undefined,
    providerAvailability: effectiveAvailability,
  };
}

async function queryAniListPage(
  fetchHttp: HttpFetcher,
  filters: AniListDiscoverFilters,
  page: number,
  perPage: number
): Promise<{
  media: RawAniListMedia[];
  hasNextPage: boolean;
  total?: number;
}> {
  const variables = buildAniListDiscoverVariables(filters, page, perPage);
  const res = await fetchHttp(ANILIST_GRAPHQL_URL, {
    method: 'POST',
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({ query: DISCOVER_QUERY, variables }),
    timeoutMs: 11000,
  });

  if (!res.ok) {
    throw new Error(`AniList retornou HTTP ${res.status}.`);
  }

  const parsed = JSON.parse(res.body) as RawAniListPageResponse;
  if (parsed.errors?.length && !parsed.data?.Page) {
    throw new Error(parsed.errors[0]?.message || 'Falha ao consultar AniList.');
  }

  const pageData = parsed.data?.Page;
  return {
    media: Array.isArray(pageData?.media) ? pageData.media : [],
    hasNextPage: Boolean(pageData?.pageInfo?.hasNextPage),
    total: pageData?.pageInfo?.total,
  };
}

export interface DiscoverAniListOptions {
  targetPageSize?: number;
  maxScanPages?: number;
  matcher?: typeof matchTitlesAgainstProviderIndex;
  ensureIndex?: (fetchHttp: HttpFetcher) => Promise<ProviderIndexStats>;
}

/**
 * Discovers anime via AniList GraphQL and annotates/filters every title against the local
 * provider availability index (0 extra scraping requests per AniList item).
 */
export async function discoverAniListCatalog(
  fetchHttp: HttpFetcher,
  filters: AniListDiscoverFilters = {},
  options: DiscoverAniListOptions = {}
): Promise<DiscoverCatalogResponse> {
  const onlyAvailable = filters.onlyAvailable !== false;
  const audioFilter: DiscoverAudioFilter =
    filters.audio === 'DUB' || filters.audio === 'LEG' ? filters.audio : 'ALL';
  const startPage = Math.max(1, Math.floor(filters.page || 1));
  const targetPageSize = options.targetPageSize ?? 20;
  const maxScanPages = onlyAvailable ? (options.maxScanPages ?? 4) : 1;
  const perPage = onlyAvailable ? 40 : targetPageSize;
  const matcher = options.matcher ?? matchTitlesAgainstProviderIndex;
  const loadIndex = options.ensureIndex ?? ((f: HttpFetcher) => ensureProviderIndexLoaded(f));

  // Kick off provider index warmup and the first AniList GraphQL page in parallel
  const [indexStats, firstPageResult] = await Promise.all([
    loadIndex(fetchHttp).catch(
      (): ProviderIndexStats => ({
        totalEntries: 0,
        sitemapEntries: 0,
        passiveEntries: 0,
        sourceMode: 'passive',
        loadedAtMs: 0,
      })
    ),
    queryAniListPage(fetchHttp, filters, startPage, perPage),
  ]);

  const collected: CatalogMediaItem[] = [];
  const seenKeys = new Set<string>();
  let currentScanPage = startPage;
  let lastPageResult = firstPageResult;
  let totalAniListItems = firstPageResult.total;

  const processPage = (mediaList: RawAniListMedia[]) => {
    for (const raw of mediaList) {
      const { allTitles } = collectAniListTitles(raw);
      const mediaKind = raw.format === 'MOVIE' ? 'movie' : 'anime';
      const availability = matcher({
        titles: allTitles,
        mediaKind,
        audioFilter,
      });

      const mapped = mapRawAniListMediaToCatalogItem(raw, availability, audioFilter);

      if (onlyAvailable && !mapped.providerAvailability?.available) {
        continue;
      }

      // Deduplicate multi-season AniList entries that resolve to the same unified provider page
      // when showing only available titles; keep distinct AniList entries when browsing unfiltered.
      const dedupeKey =
        onlyAvailable && mapped.providerAvailability?.available
          ? canonicalMediaKey(mapped.url)
          : mapped.id;
      if (!dedupeKey || seenKeys.has(dedupeKey)) continue;
      seenKeys.add(dedupeKey);
      collected.push(mapped);
    }
  };

  processPage(lastPageResult.media);

  // Backfill additional AniList pages when filtering strictly by provider availability
  let scannedPages = 1;
  while (
    onlyAvailable &&
    collected.length < targetPageSize &&
    lastPageResult.hasNextPage &&
    scannedPages < maxScanPages
  ) {
    currentScanPage += 1;
    scannedPages += 1;
    try {
      lastPageResult = await queryAniListPage(fetchHttp, filters, currentScanPage, perPage);
      if (typeof lastPageResult.total === 'number') {
        totalAniListItems = lastPageResult.total;
      }
      processPage(lastPageResult.media);
    } catch {
      break;
    }
  }

  const nextAniListPage = lastPageResult.hasNextPage ? currentScanPage + 1 : null;

  return {
    items: collected,
    currentPage: startPage,
    nextAniListPage,
    hasNextPage: Boolean(nextAniListPage),
    totalAniListItems,
    indexedTitlesCount: indexStats.totalEntries,
    indexSourceMode: indexStats.sourceMode,
    onlyAvailable,
    fetchedAt: new Date().toISOString(),
  };
}

export interface AniListMediaLookupDetails {
  aniListId: number;
  malId?: number;
  title: string;
  englishTitle?: string;
  nativeTitle?: string;
  allTitles: string[];
  poster: string;
  backdrop: string;
  synopsis: string;
  year?: string;
  rating?: string;
  genres: string[];
  mediaTags: AnimeMediaTag[];
  kind: 'anime' | 'movie';
  episodesCount?: number;
  averageDuration?: string;
  studio?: string;
  status?: string;
}

function formatAniListStatusPt(raw?: string | null): string | undefined {
  switch ((raw || '').toUpperCase()) {
    case 'RELEASING':
      return 'Em exibição';
    case 'FINISHED':
      return 'Finalizado';
    case 'NOT_YET_RELEASED':
      return 'Em breve';
    case 'CANCELLED':
      return 'Cancelado';
    case 'HIATUS':
      return 'Em hiato';
    default:
      return undefined;
  }
}

export function mapRawAniListMediaTags(rawTags?: readonly RawAniListTag[] | null): AnimeMediaTag[] {
  if (!Array.isArray(rawTags) || rawTags.length === 0) return [];
  const seen = new Set<string>();
  const mapped: AnimeMediaTag[] = [];

  for (const raw of rawTags) {
    if (!raw || raw.isAdult) continue;
    const cleanName = sanitizeAniListTagName(raw.name || '');
    if (!cleanName) continue;
    const key = cleanName.toLowerCase();
    if (seen.has(key)) continue;
    const rank = typeof raw.rank === 'number' && Number.isFinite(raw.rank) ? Math.round(raw.rank) : undefined;
    // Keep relevant tags (rank >= 40 or unranked); skip noisy low-relevance tags
    if (rank !== undefined && rank < 40) continue;
    seen.add(key);
    mapped.push({
      name: cleanName,
      label: translateAniListTagName(cleanName),
      category: raw.category ? translateAniListCategory(raw.category.trim()) : undefined,
      description: translateAniListTagDescription(cleanName, raw.description || undefined),
      rank,
      isSpoiler: Boolean(raw.isMediaSpoiler || raw.isGeneralSpoiler),
    });
  }

  mapped.sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0));
  return mapped.slice(0, 18);
}

function mapRawAniListMediaToLookupDetails(media: RawAniListMedia): AniListMediaLookupDetails {
  const { primaryTitle, englishTitle, allTitles } = collectAniListTitles(media);
  const yearNum = media.seasonYear || media.startDate?.year;
  const studioNodes = Array.isArray(media.studios?.nodes) ? media.studios.nodes : [];
  const studioNames = Array.from(
    new Set(
      studioNodes
        .map((n) => (n?.name || '').trim())
        .filter(Boolean)
    )
  );

  return {
    aniListId: media.id,
    malId: media.idMal && media.idMal > 0 ? media.idMal : undefined,
    title: primaryTitle,
    englishTitle,
    nativeTitle: media.title?.native?.trim() || undefined,
    allTitles,
    poster: media.coverImage?.extraLarge || media.coverImage?.large || '',
    backdrop: media.bannerImage || media.coverImage?.extraLarge || '',
    synopsis: stripAniListHtml(media.description),
    year: yearNum && yearNum > 1900 ? String(yearNum) : undefined,
    rating:
      typeof media.averageScore === 'number' && media.averageScore > 0
        ? (media.averageScore / 10).toFixed(1)
        : undefined,
    genres: Array.from(new Set((media.genres || []).map(translateAniListGenreToPt).filter(Boolean))),
    mediaTags: mapRawAniListMediaTags(media.tags),
    kind: media.format === 'MOVIE' ? 'movie' : 'anime',
    episodesCount: typeof media.episodes === 'number' && media.episodes > 0 ? media.episodes : undefined,
    averageDuration:
      typeof media.duration === 'number' && media.duration > 0 ? `${media.duration} min` : undefined,
    studio: studioNames.length > 0 ? studioNames.join(', ') : undefined,
    status: formatAniListStatusPt(media.status),
  };
}

interface AniListLookupCacheEntry {
  value: AniListMediaLookupDetails | null;
  expiresAt: number;
}

interface AniListFetcherLookupCache {
  entries: Map<string, AniListLookupCacheEntry>;
  inFlight: Map<string, Promise<AniListMediaLookupDetails | null>>;
}

const ANILIST_LOOKUP_HIT_TTL_MS = 15 * 60 * 1000;
const ANILIST_LOOKUP_MISS_TTL_MS = 5 * 60 * 1000;
const ANILIST_LOOKUP_MAX_ENTRIES = 200;
const ANILIST_METADATA_TIMEOUT_MS = 4500;
const anilistLookupCacheByFetcher = new WeakMap<HttpFetcher, AniListFetcherLookupCache>();

function getAniListLookupCache(fetchHttp: HttpFetcher): AniListFetcherLookupCache {
  let cache = anilistLookupCacheByFetcher.get(fetchHttp);
  if (!cache) {
    cache = { entries: new Map(), inFlight: new Map() };
    anilistLookupCacheByFetcher.set(fetchHttp, cache);
  }
  return cache;
}

function pickBestAniListSearchCandidate(
  candidates: readonly RawAniListMedia[],
  queryTitles: readonly string[],
  options: { targetYear?: number | null; isMovie?: boolean }
): RawAniListMedia | null {
  if (candidates.length === 0 || queryTitles.length === 0) return null;

  let best: RawAniListMedia | null = null;
  let bestScore = -1;

  for (const media of candidates) {
    const { allTitles } = collectAniListTitles(media);
    let titleSim = 0;
    for (const q of queryTitles) {
      for (const t of allTitles) {
        const sim = scoreTitleSimilarity(q, t);
        if (sim > titleSim) titleSim = sim;
      }
    }
    if (titleSim < 0.68) continue;

    let total = titleSim * 100;
    const mediaYear = media.seasonYear || media.startDate?.year || null;
    if (options.targetYear && mediaYear) {
      const diff = Math.abs(options.targetYear - mediaYear);
      if (diff === 0) total += 16;
      else if (diff === 1) total += 8;
      else if (diff >= 3) total -= 14;
    }

    const fmt = (media.format || '').toUpperCase();
    if (options.isMovie) {
      if (fmt === 'MOVIE') total += 12;
      else if (fmt === 'TV') total -= 8;
    } else {
      if (fmt === 'TV' || fmt === 'ONA') total += 10;
      else if (fmt === 'MOVIE') total -= 10;
    }
    if (fmt === 'MUSIC' || fmt === 'SPECIAL') total -= 20;

    if (queryTitles.some((q) => allTitles.some((t) => normalizeTitleForMatch(q) === normalizeTitleForMatch(t)))) {
      total += 12;
    }

    if (total > bestScore) {
      bestScore = total;
      best = media;
    }
  }

  return bestScore >= 72 ? best : null;
}

/**
 * Fetches full single-entry metadata from AniList when opening an `anisync://anime/anilist/...` URI.
 */
export async function fetchAniListMediaById(
  fetchHttp: HttpFetcher,
  aniListId: number
): Promise<AniListMediaLookupDetails | null> {
  if (!Number.isFinite(aniListId) || aniListId <= 0) return null;
  try {
    const res = await fetchHttp(ANILIST_GRAPHQL_URL, {
      method: 'POST',
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        query: MEDIA_BY_ID_QUERY,
        variables: { id: Math.trunc(aniListId) },
      }),
      timeoutMs: ANILIST_METADATA_TIMEOUT_MS,
    });
    if (!res.ok) return null;
    const parsed = JSON.parse(res.body) as {
      data?: { Media?: RawAniListMedia | null };
    };
    const media = parsed.data?.Media;
    if (!media) return null;
    return mapRawAniListMediaToLookupDetails(media);
  } catch {
    return null;
  }
}

function cleanAniListLookupTitle(raw: string): string {
  return raw
    .replace(/\s*\((?:dublado|legendado|dub|leg|tv|jp|en)\)\s*/gi, ' ')
    .replace(/\s*-\s*(?:dublado|legendado)\s*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Fast, coalesced AniList metadata lookup (by aniListId, malId, or Latin/English/Romaji titles).
 * Powers AniList-first genres (`AniList > TVDB > MyAnimeList > Providers`), spoiler-tagged mediaTags,
 * and 2nd-tier metadata fallback (`TVDB > AniList > MyAnimeList > Providers`).
 */
export async function fetchAniListMetadataForAnime(
  fetchHttp: HttpFetcher,
  lookup: {
    aniListId?: number;
    malId?: number;
    titles?: readonly (string | undefined)[];
    year?: string;
    kind?: CanonicalMediaType;
  }
): Promise<AniListMediaLookupDetails | null> {
  const aniListId =
    typeof lookup.aniListId === 'number' && Number.isFinite(lookup.aniListId) && lookup.aniListId > 0
      ? Math.trunc(lookup.aniListId)
      : undefined;
  const malId =
    typeof lookup.malId === 'number' && Number.isFinite(lookup.malId) && lookup.malId > 0
      ? Math.trunc(lookup.malId)
      : undefined;

  if (!aniListId && !malId && lookup.kind === 'series') {
    return null;
  }

  const latinTitles: string[] = [];
  const otherTitles: string[] = [];
  const seen = new Set<string>();
  for (const raw of lookup.titles || []) {
    if (!raw) continue;
    const cleaned = cleanAniListLookupTitle(raw);
    if (!cleaned || cleaned.length < 2) continue;
    const norm = normalizeTitleForMatch(cleaned);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    if (/[A-Za-z]/.test(cleaned)) latinTitles.push(cleaned);
    else otherTitles.push(cleaned);
  }
  const titleCandidates = [...latinTitles, ...otherTitles];

  const yearMatch = lookup.year?.match(/\b((?:19|20)\d{2})\b/);
  const targetYear = yearMatch?.[1] ? Number.parseInt(yearMatch[1], 10) : null;

  const cacheKey = aniListId
    ? `al:${aniListId}`
    : malId
      ? `mal:${malId}`
      : titleCandidates.length > 0
        ? `q:${normalizeTitleForMatch(titleCandidates[0])}|${targetYear || ''}|${lookup.kind || 'anime'}`
        : '';
  if (!cacheKey) return null;

  const cache = getAniListLookupCache(fetchHttp);
  const cached = cache.entries.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  if (cached) cache.entries.delete(cacheKey);

  const pending = cache.inFlight.get(cacheKey);
  if (pending) return pending;

  const promise = (async (): Promise<AniListMediaLookupDetails | null> => {
    try {
      if (aniListId) {
        const byId = await fetchAniListMediaById(fetchHttp, aniListId);
        if (byId) return byId;
      }

      if (malId) {
        try {
          const res = await fetchHttp(ANILIST_GRAPHQL_URL, {
            method: 'POST',
            contentType: 'application/json',
            accept: 'application/json',
            body: JSON.stringify({
              query: MEDIA_BY_MAL_ID_QUERY,
              variables: { idMal: malId },
            }),
            timeoutMs: ANILIST_METADATA_TIMEOUT_MS,
          });
          if (res.ok) {
            const parsed = JSON.parse(res.body) as { data?: { Media?: RawAniListMedia | null } };
            if (parsed.data?.Media) {
              return mapRawAniListMediaToLookupDetails(parsed.data.Media);
            }
          }
        } catch {
          // fall through to title search
        }
      }

      const isMovie = lookup.kind === 'movie';
      for (const query of titleCandidates.slice(0, 2)) {
        try {
          const res = await fetchHttp(ANILIST_GRAPHQL_URL, {
            method: 'POST',
            contentType: 'application/json',
            accept: 'application/json',
            body: JSON.stringify({
              query: MEDIA_SEARCH_DETAILS_QUERY,
              variables: { search: query.slice(0, 90) },
            }),
            timeoutMs: ANILIST_METADATA_TIMEOUT_MS,
          });
          if (!res.ok) continue;
          const parsed = JSON.parse(res.body) as RawAniListPageResponse;
          const mediaList = Array.isArray(parsed.data?.Page?.media) ? parsed.data.Page.media : [];
          const best = pickBestAniListSearchCandidate(mediaList, titleCandidates, {
            targetYear,
            isMovie,
          });
          if (best) {
            return mapRawAniListMediaToLookupDetails(best);
          }
        } catch {
          // try next title candidate
        }
      }

      return null;
    } finally {
      cache.inFlight.delete(cacheKey);
    }
  })();

  cache.inFlight.set(cacheKey, promise);
  const resolved = await promise;

  if (cache.entries.size >= ANILIST_LOOKUP_MAX_ENTRIES) {
    const oldest = cache.entries.keys().next().value;
    if (oldest) cache.entries.delete(oldest);
  }
  cache.entries.set(cacheKey, {
    value: resolved,
    expiresAt: Date.now() + (resolved ? ANILIST_LOOKUP_HIT_TTL_MS : ANILIST_LOOKUP_MISS_TTL_MS),
  });
  return resolved;
}

/**
 * Builds an immediate metadata-only AnimeDetails from AniList when TheTVDB has no match.
 */
export function buildFastMetadataDetailsFromAniList(
  alInfo: AniListMediaLookupDetails,
  targetUrl: string,
  options: { audioType?: AudioType; kind?: CanonicalMediaType } = {}
): AnimeDetails {
  const resolvedKind: CanonicalMediaType =
    options.kind === 'movie' || alInfo.kind === 'movie' ? 'movie' : options.kind || 'anime';
  const extIds = {
    aniListId: alInfo.aniListId,
    ...(alInfo.malId ? { malId: alInfo.malId } : {}),
  };
  return {
    title: alInfo.title,
    originalTitle: alInfo.nativeTitle,
    alternativeTitle:
      alInfo.englishTitle && alInfo.englishTitle !== alInfo.title ? alInfo.englishTitle : undefined,
    alternativeTitles: alInfo.allTitles,
    url: targetUrl,
    kind: resolvedKind,
    catalogSource: 'anilist',
    enrichmentSources: ['anilist'],
    externalIds: extIds,
    externalLinks: buildExternalDatabaseLinks(extIds, { mediaType: resolvedKind }),
    poster: alInfo.poster,
    backdrop: alInfo.backdrop || alInfo.poster,
    synopsis: alInfo.synopsis,
    year: alInfo.year,
    rating: alInfo.rating,
    ratingSource: alInfo.rating ? 'anilist' : undefined,
    genres: alInfo.genres,
    genresSource: alInfo.genres.length > 0 ? 'anilist' : undefined,
    mediaTags: alInfo.mediaTags.length > 0 ? alInfo.mediaTags : undefined,
    studio: alInfo.studio,
    averageDuration: alInfo.averageDuration,
    status: alInfo.status,
    episodesTotalCount: alInfo.episodesCount ? String(alInfo.episodesCount) : undefined,
    audioType: options.audioType ?? null,
    episodes: [],
  };
}

/**
 * Enriches an `AnimeDetails` object with AniList metadata:
 * - Genres priority: **AniList > TVDB > MyAnimeList > Providers** (for anime)
 * - General metadata priority: **TVDB > AniList > MyAnimeList > Providers**
 * - Attaches translated `mediaTags` with `isSpoiler` flags.
 */
export async function enrichDetailsWithAniListMetadata(
  fetchHttp: HttpFetcher,
  details: AnimeDetails,
  options: { preloadedAniList?: AniListMediaLookupDetails | null } = {}
): Promise<AnimeDetails> {
  if (
    details.kind === 'series' &&
    !details.externalIds?.aniListId &&
    !details.externalIds?.malId
  ) {
    return details;
  }

  const alInfo =
    options.preloadedAniList !== undefined
      ? options.preloadedAniList
      : await fetchAniListMetadataForAnime(fetchHttp, {
          aniListId: details.externalIds?.aniListId,
          malId: details.externalIds?.malId,
          titles: [
            details.alternativeTitle,
            ...(details.alternativeTitles || []),
            details.title,
            details.originalTitle,
          ],
          year: details.year || details.firstAirDate,
          kind: details.kind === 'movie' ? 'movie' : details.kind === 'series' ? 'series' : 'anime',
        }).catch(() => null);

  if (!alInfo) return details;

  const hasTvdb = Boolean(details.enrichmentSources?.includes('thetvdb'));
  const mediaType: CanonicalMediaType =
    details.kind === 'movie' ? 'movie' : details.kind === 'series' ? 'series' : 'anime';

  const mergedIds = {
    ...(details.externalIds || {}),
    aniListId: details.externalIds?.aniListId || alInfo.aniListId,
    ...(details.externalIds?.malId || alInfo.malId
      ? { malId: details.externalIds?.malId || alInfo.malId }
      : {}),
  };

  // Genres: AniList > TVDB > MyAnimeList > Providers
  const useAniListGenres = alInfo.genres.length > 0;
  const resolvedGenres = useAniListGenres ? alInfo.genres : details.genres;
  const resolvedGenresSource = useAniListGenres ? 'anilist' : details.genresSource;

  // General metadata: TVDB > AniList > MyAnimeList > Providers
  const nextTitle = hasTvdb ? details.title : alInfo.title || details.title;
  const nextPoster = hasTvdb
    ? details.poster || alInfo.poster || ''
    : alInfo.poster || details.poster || '';
  const nextFallbackPoster =
    !hasTvdb && alInfo.poster && details.poster && details.poster !== alInfo.poster
      ? details.fallbackPoster || details.poster
      : details.fallbackPoster || (alInfo.poster && alInfo.poster !== nextPoster ? alInfo.poster : undefined);
  const nextBackdrop = hasTvdb
    ? details.backdrop || alInfo.backdrop || nextPoster
    : alInfo.backdrop || details.backdrop || nextPoster;
  const nextSynopsis = hasTvdb
    ? details.synopsis || alInfo.synopsis || ''
    : alInfo.synopsis || details.synopsis || '';

  const mergedAltTitles = Array.from(
    new Set(
      [...(details.alternativeTitles || []), ...alInfo.allTitles].filter(Boolean)
    )
  );

  const nextEnrichmentSources = Array.from(
    new Set([...(details.enrichmentSources || []), 'anilist' as const])
  );

  const keepRating =
    details.ratingSource === 'myanimelist'
      ? { rating: details.rating, ratingSource: details.ratingSource }
      : alInfo.rating
        ? { rating: alInfo.rating, ratingSource: 'anilist' as const }
        : { rating: details.rating, ratingSource: details.ratingSource };

  return {
    ...details,
    title: nextTitle,
    originalTitle: details.originalTitle || alInfo.nativeTitle,
    alternativeTitle: details.alternativeTitle || alInfo.englishTitle,
    alternativeTitles: mergedAltTitles.length > 0 ? mergedAltTitles : details.alternativeTitles,
    poster: nextPoster,
    fallbackPoster: nextFallbackPoster,
    backdrop: nextBackdrop,
    synopsis: nextSynopsis,
    year: details.year || alInfo.year,
    status: details.status || alInfo.status,
    studio: details.studio || alInfo.studio,
    averageDuration: details.averageDuration || alInfo.averageDuration,
    episodesTotalCount:
      details.episodesTotalCount || (alInfo.episodesCount ? String(alInfo.episodesCount) : undefined),
    genres: resolvedGenres,
    genresSource: resolvedGenresSource,
    mediaTags: alInfo.mediaTags.length > 0 ? alInfo.mediaTags : details.mediaTags,
    rating: keepRating.rating,
    ratingSource: keepRating.ratingSource,
    enrichmentSources: nextEnrichmentSources,
    externalIds: mergedIds,
    externalLinks: buildExternalDatabaseLinks(mergedIds, { mediaType }),
  };
}

const TAXONOMY_TTL_MS = 24 * 60 * 60 * 1000;
let cachedTaxonomy: { data: DiscoverTaxonomyResponse; expiresAt: number } | null = null;

function buildFallbackTaxonomy(): DiscoverTaxonomyResponse {
  return {
    genres: ANILIST_GENRES.map((g) => ({ value: g.value, label: g.label })),
    tags: ANILIST_POPULAR_TAGS.map((t) => ({
      name: t.value,
      label: formatAniListTagLabel(t.value),
      category: 'Populares',
      description: translateAniListTagDescription(t.value),
    })),
    sourceMode: 'fallback',
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Loads the complete official AniList GenreCollection and non-adult MediaTagCollection
 * (all ~360+ tags: VTuber, War, Werewolf, Witch, Wuxia, Yakuza, Yandere, Youkai, Yuri, Zombie, etc.).
 */
export async function fetchAniListTaxonomy(
  fetchHttp: HttpFetcher,
  options: { forceRefresh?: boolean } = {}
): Promise<DiscoverTaxonomyResponse> {
  if (!options.forceRefresh && cachedTaxonomy && cachedTaxonomy.expiresAt > Date.now()) {
    return cachedTaxonomy.data;
  }

  try {
    const res = await fetchHttp(ANILIST_GRAPHQL_URL, {
      method: 'POST',
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({ query: TAXONOMY_QUERY }),
      timeoutMs: 10000,
    });
    if (!res.ok) {
      return cachedTaxonomy?.data || buildFallbackTaxonomy();
    }

    const parsed = JSON.parse(res.body) as {
      data?: {
        GenreCollection?: string[];
        MediaTagCollection?: Array<{
          name?: string;
          category?: string;
          description?: string;
          isAdult?: boolean;
        }>;
      };
    };

    const rawGenres = Array.isArray(parsed.data?.GenreCollection)
      ? parsed.data.GenreCollection.filter((g) => g && g !== 'Hentai')
      : [];
    const genres =
      rawGenres.length > 0
        ? rawGenres
            .map((g) => ({ value: g, label: translateAniListGenreToPt(g) }))
            .sort((a, b) => a.label.localeCompare(b.label, 'pt-BR', { sensitivity: 'base' }))
        : ANILIST_GENRES.map((g) => ({ value: g.value, label: g.label })).sort((a, b) =>
            a.label.localeCompare(b.label, 'pt-BR', { sensitivity: 'base' })
          );

    const rawTags = Array.isArray(parsed.data?.MediaTagCollection)
      ? parsed.data.MediaTagCollection
      : [];
    const seenTags = new Set<string>();
    const tags: AniListTagItem[] = [];
    for (const t of rawTags) {
      if (!t || t.isAdult) continue;
      const cleanName = sanitizeAniListTagName(t.name || '');
      if (!cleanName) continue;
      const key = cleanName.toLowerCase();
      if (seenTags.has(key)) continue;
      seenTags.add(key);
      tags.push({
        name: cleanName,
        label: translateAniListTagName(cleanName),
        category: translateAniListCategory((t.category || 'Outros').trim()),
        description: translateAniListTagDescription(cleanName, t.description),
      });
    }
    tags.sort((a, b) => a.label.localeCompare(b.label, 'pt-BR', { sensitivity: 'base' }));

    if (tags.length === 0) {
      return cachedTaxonomy?.data || buildFallbackTaxonomy();
    }

    const result: DiscoverTaxonomyResponse = {
      genres,
      tags,
      sourceMode: 'live',
      fetchedAt: new Date().toISOString(),
    };
    cachedTaxonomy = {
      data: result,
      expiresAt: Date.now() + TAXONOMY_TTL_MS,
    };
    return result;
  } catch {
    return cachedTaxonomy?.data || buildFallbackTaxonomy();
  }
}

export function clearAniListTaxonomyCache(): void {
  cachedTaxonomy = null;
}

