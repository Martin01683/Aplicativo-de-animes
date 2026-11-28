export type AudioType = 'DUB' | 'LEG' | null;
export type MediaKind = 'episode' | 'anime' | 'series' | 'movie';
export type CatalogSourceId = 'thetvdb' | 'livechart' | 'anilist' | 'server';
export type LiveChartScheduleMode = 'streams' | 'dub' | 'jp';
export type CalendarLayout = 'grid' | 'timeline';

export type AniListSortOption =
  | 'TRENDING_DESC'
  | 'POPULARITY_DESC'
  | 'SCORE_DESC'
  | 'FAVOURITES_DESC'
  | 'START_DATE_DESC';

export type AniListSeason = 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL';
export type AniListFormat = 'TV' | 'MOVIE' | 'OVA' | 'ONA' | 'SPECIAL';
export type AniListStatus = 'RELEASING' | 'FINISHED' | 'NOT_YET_RELEASED';
export type AniListCountry = 'JP' | 'CN' | 'KR';
export type DiscoverAudioFilter = 'ALL' | 'DUB' | 'LEG';

export interface ProviderAvailabilityInfo {
  available: boolean;
  hasLeg: boolean;
  hasDub: boolean;
  legUrl?: string;
  dubUrl?: string;
  providerNames: string[];
  matchedTitle?: string;
  unreleased?: boolean;
}

export interface AniListDiscoverFilters {
  sort?: AniListSortOption;
  genre?: string;
  genres?: string[];
  excludeGenres?: string[];
  tag?: string;
  tags?: string[];
  excludeTags?: string[];
  minimumTagRank?: number;
  season?: AniListSeason | '';
  year?: string;
  format?: AniListFormat | '';
  status?: AniListStatus | '';
  country?: AniListCountry | '';
  audio?: DiscoverAudioFilter;
  onlyAvailable?: boolean;
  search?: string;
  page?: number;
}

export interface AniListTagItem {
  name: string;
  label: string;
  category: string;
  description?: string;
}

export interface DiscoverTaxonomyResponse {
  genres: Array<{ value: string; label: string }>;
  tags: AniListTagItem[];
  sourceMode: 'live' | 'fallback';
  fetchedAt: string;
}

export type CatalogArchiveCategory =
  | 'animes'
  | 'movies'
  | 'series'
  | 'dublado'
  | 'legendado'
  | 'donghua'
  | 'cartoon'
  | 'live-action';

export type StreamFormat = 'hls' | 'mp4' | 'unknown';
export type VlcPlatform = 'windows' | 'mac' | 'linux';

export interface ExternalMediaIds {
  tvdbId?: number;
  tvdbSlug?: string;
  livechartId?: number;
  imdbId?: string;
  tmdbId?: number;
  malId?: number;
  aniListId?: number;
}

export interface CatalogSourceCredentials {
  tvdbApiKey?: string;
  tvdbPin?: string;
}

export interface CatalogPreferences {
  credentials?: CatalogSourceCredentials;
}

export interface ScheduleReleaseInfo {
  livechartId: number;
  releaseLabel: string;
  hasDub: boolean;
  hasSub: boolean;
  isJapaneseBroadcast: boolean;
  serviceName?: string;
  serviceUrl?: string;
  totalEpisodes?: number;
  englishTitle?: string;
  nativeTitle?: string;
  format?: string;
}

export interface CatalogMediaItem {
  id: string;
  title: string;
  episodeLabel?: string;
  url: string;
  kind: MediaKind;
  poster: string;
  audioType: AudioType;
  quality?: string;
  rating?: string;
  year?: string;
  isHiatus?: boolean;
  statusBadge?: string;
  catalogSource?: CatalogSourceId;
  sourceServerName?: string;
  externalIds?: ExternalMediaIds;
  mediaFormat?: string;
  synopsis?: string;
  genres?: string[];
  airingAt?: number;
  scheduleMeta?: ScheduleReleaseInfo;
  englishTitle?: string;
  alternativeTitles?: string[];
  anilistStatus?: AniListStatus;
  episodesCount?: number;
  providerAvailability?: ProviderAvailabilityInfo;
}

export interface DiscoverCatalogResponse {
  items: CatalogMediaItem[];
  currentPage: number;
  nextAniListPage: number | null;
  hasNextPage: boolean;
  totalAniListItems?: number;
  indexedTitlesCount: number;
  indexSourceMode: 'live' | 'cache' | 'passive';
  onlyAvailable: boolean;
  fetchedAt: string;
}

export interface CalendarDaySection {
  id: string;
  label: string;
  dateIso?: string;
  dateLabel?: string;
  isToday: boolean;
  items: CatalogMediaItem[];
}

export interface WeeklyCalendarResponse {
  days: CalendarDaySection[];
  sourceMode: 'live' | 'snapshot';
  scheduleMode?: LiveChartScheduleMode;
  fetchedAt: string;
  catalogSources?: CatalogSourceId[];
}

export interface GlossaryResponse {
  term: string;
  type: string;
  items: CatalogMediaItem[];
  sourceMode: 'live' | 'fallback';
}

export interface CatalogFilterOption {
  label: string;
  slug: string;
  url: string;
}

export interface CatalogFilters {
  genres: CatalogFilterOption[];
  years: CatalogFilterOption[];
  types: CatalogFilterOption[];
}

export interface SliderMovieItem {
  id: string;
  title: string;
  url: string;
  backdrop: string;
  year?: string;
  kind?: MediaKind;
  rating?: string;
  catalogSource?: CatalogSourceId;
  externalIds?: ExternalMediaIds;
}

export interface HomeCatalog {
  calendar: CatalogMediaItem[];
  releases: CatalogMediaItem[];
  animes: CatalogMediaItem[];
  movies: CatalogMediaItem[];
  series?: CatalogMediaItem[];
  sourcesUsed?: CatalogSourceId[];
  sourceMode: 'live' | 'snapshot';
  fetchedAt: string;
}

export interface PaginatedCatalogResponse {
  items: CatalogMediaItem[];
  featured?: CatalogMediaItem[];
  sliderMovies?: SliderMovieItem[];
  filters?: CatalogFilters;
  currentPage: number;
  totalPages: number;
  catalogSource?: CatalogSourceId | 'all';
  sourceMode?: 'live' | 'snapshot';
}

export interface SearchResultItem {
  id: string;
  title: string;
  url: string;
  kind: MediaKind;
  poster: string;
  year?: string;
  rating?: string;
  excerpt?: string;
  audioType: AudioType;
  catalogSource?: CatalogSourceId;
  sourceServerName?: string;
  externalIds?: ExternalMediaIds;
  mediaFormat?: string;
}

export interface SearchSuggestResponse {
  query: string;
  results: SearchResultItem[];
  sourceMode: 'live' | 'fallback';
}

export interface PaginatedSearchResponse {
  query: string;
  results: SearchResultItem[];
  currentPage: number;
  totalPages: number;
  sourceMode: 'live' | 'snapshot';
}

export interface AnimeEpisodeLink {
  numberLabel: string;
  episodeNumber: number | null;
  seasonNumber?: number;
  seasonLabel?: string;
  absoluteNumber?: number;
  sceneSeasonNumber?: number;
  sceneEpisodeNumber?: number;
  sceneAbsoluteEpisodeNumber?: number;
  finaleType?: 'season' | 'series' | 'midseason';
  title: string;
  url: string;
  audioType?: AudioType;
  date?: string;
  thumb?: string;
  fallbackThumb?: string;
  overview?: string;
  durationMinutes?: number;
  rating?: string;
  availableOnServer?: boolean;
  airingAt?: number;
  hasExactAiringTime?: boolean;
  tvdbEpisodeId?: number;
  uncensored?: boolean;
  titleLocalized?: boolean;
}

export interface AnimeAudioTrackData {
  audioType: 'DUB' | 'LEG';
  episodes: AnimeEpisodeLink[];
  playableCount: number;
  sourceUrl?: string;
}

export interface ExternalDatabaseLinkItem {
  source: CatalogSourceId | 'myanimelist';
  label: string;
  url: string;
}

export type MediaRatingSource = 'myanimelist' | 'anilist' | 'provider' | 'thetvdb';

export type MediaGenresSource = 'anilist' | 'thetvdb' | 'myanimelist' | 'provider';

export interface AnimeMediaTag {
  name: string;
  label: string;
  description?: string;
  category?: string;
  rank?: number;
  isSpoiler: boolean;
}

export interface AnimeDetails {
  title: string;
  alternativeTitle?: string;
  alternativeTitles?: string[];
  originalTitle?: string;
  url: string;
  kind?: MediaKind;
  catalogSource?: CatalogSourceId;
  sourceServerName?: string;
  externalIds?: ExternalMediaIds;
  enrichmentSources?: Array<CatalogSourceId | 'myanimelist'>;
  externalLinks?: ExternalDatabaseLinkItem[];
  poster: string;
  fallbackPoster?: string;
  backdrop: string;
  fallbackBackdrop?: string;
  synopsis: string;
  synopsisSource?: EpisodeSynopsisSource;
  synopsisLanguage?: 'pt-BR' | 'en';
  year?: string;
  rating?: string;
  ratingSource?: MediaRatingSource;
  tmdbRating?: string;
  tmdbVotes?: string;
  firstAirDate?: string;
  lastAirDate?: string;
  seasonsCount?: string;
  episodesTotalCount?: string;
  averageDuration?: string;
  status?: string;
  contentRating?: string;
  airsTime?: string;
  seasonNames?: Record<number, string>;
  studio?: string;
  network?: string;
  originalCountry?: string;
  originalLanguage?: string;
  myAnimeListUrl?: string;
  allSeasonsUrl?: string;
  genres: string[];
  genresSource?: MediaGenresSource;
  mediaTags?: AnimeMediaTag[];
  audioType: AudioType;
  episodes: AnimeEpisodeLink[];
  audioTracks?: Partial<Record<'DUB' | 'LEG', AnimeAudioTrackData>>;
  relations?: CatalogMediaItem[];
}

export type MediaDetails = AnimeDetails;

export type PlayerProviderKind =
  | 'kojima'
  | 'zuplay'
  | 'vidstreaming'
  | 'playerjs'
  | 'hinatasoul'
  | 'abyss'
  | 'blogger'
  | 'direct'
  | 'other';

export interface PlayerOption {
  nume: string;
  label: string;
  embedUrl: string;
  providerKind: PlayerProviderKind;
  sourceId?: string;
  sourceName?: string;
  sourceKind?: string;
  audioType?: AudioType;
  matchedPageUrl?: string;
  directStreamUrl?: string;
  directFormat?: StreamFormat;
  directReferer?: string;
  directSubtitles?: SubtitleTrack[];
  qualityLabel?: string;
}

export interface StreamQuality {
  label: string;
  height: number;
  url: string;
  format: StreamFormat;
}

export interface SubtitleTrack {
  label: string;
  url: string;
  isDefault: boolean;
}

export interface ResolvedEmbed {
  embedUrl: string;
  provider: string;
  status: 'resolved' | 'embed-only' | 'error';
  streams: StreamQuality[];
  subtitles: SubtitleTrack[];
  poster?: string;
  referer: string;
  preferDirect?: boolean;
  errorMessage?: string;
}

export interface EpisodeSourceReportSummary {
  sourceId: string;
  sourceName: string;
  sourceKind: string;
  status: 'found' | 'not-found' | 'error' | 'skipped';
  optionsCount: number;
  matchedTitle?: string;
  matchedUrl?: string;
  errorMessage?: string;
  durationMs: number;
}

export interface EpisodeDetails {
  title: string;
  seriesTitle: string;
  seriesUrl?: string;
  url: string;
  episodeLabel?: string;
  mediaType?: 'anime' | 'series' | 'movie';
  seasonNumber?: number;
  episodeNumber?: number;
  originalTitle?: string;
  alternativeTitles?: string[];
  year?: string;
  catalogSource?: CatalogSourceId;
  externalIds?: ExternalMediaIds;
  poster: string;
  backdrop: string;
  synopsis: string;
  genres: string[];
  mediaTags?: AnimeMediaTag[];
  prevUrl?: string;
  nextUrl?: string;
  options: PlayerOption[];
  sourceReports?: EpisodeSourceReportSummary[];
  isMovie: boolean;
  sourceMode?: 'live' | 'snapshot';
}

export type EpisodeSynopsisSource =
  | 'thetvdb-pt-br'
  | 'thetvdb-deepl'
  | 'thetvdb-google-translate'
  | 'thetvdb-en';

export interface EpisodeSynopsisResult {
  synopsis: string;
  language: 'pt-BR' | 'en';
  source: EpisodeSynopsisSource;
  episodeTitle?: string;
  episodeImage?: string;
  tvdbEpisodeId?: number;
  tvdbSeriesId?: number;
}

export interface AnimeSynopsisResult {
  synopsis: string;
  language: 'pt-BR' | 'en';
  source: EpisodeSynopsisSource;
  poster?: string;
  backdrop?: string;
  tvdbId?: number;
  tvdbSlug?: string;
}

export interface VlcPlaylistEntry {
  title: string;
  streamUrl: string;
  referer?: string;
  userAgent?: string;
  subtitleUrl?: string;
  durationSeconds?: number;
}

export interface WatchHistoryEntry {
  url: string;
  title: string;
  seriesTitle?: string;
  seriesUrl?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  poster: string;
  kind: MediaKind;
  watchedAt: string;
  preferredServer?: string;
  positionSec?: number;
  durationSec?: number;
  completed?: boolean;
}

export interface FavoriteAlertEntry {
  id: string;
  animeUrl: string;
  animeTitle: string;
  episodeTitle: string;
  episodeLabel: string;
  episodeUrl: string;
  poster: string;
  detectedAt: string;
  read: boolean;
  audioType?: AudioType;
  sourceServerName?: string;
}

export interface FavoriteEpisodeBaseline {
  lastEpisodeUrl: string;
  lastEpisodeNumber: number | null;
  updatedAt: string;
}

export type FavoriteBaselineMap = Record<string, FavoriteEpisodeBaseline>;

export interface FavoriteLatestInfo {
  episodeUrl: string;
  episodeTitle: string;
  episodeLabel: string;
  episodeNumber: number | null;
  poster?: string;
  audioType?: AudioType;
  sourceServerName?: string;
  recentEpisodes?: Array<{
    episodeUrl: string;
    episodeTitle: string;
    episodeLabel: string;
    episodeNumber: number | null;
    poster?: string;
    audioType?: AudioType;
    sourceServerName?: string;
  }>;
}
