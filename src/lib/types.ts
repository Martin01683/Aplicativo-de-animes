export type AudioType = 'DUB' | 'LEG' | null;
export type MediaKind = 'episode' | 'anime' | 'movie';
export type CatalogArchiveCategory =
  | 'animes'
  | 'movies'
  | 'dublado'
  | 'legendado'
  | 'donghua'
  | 'cartoon'
  | 'live-action';
export type StreamFormat = 'hls' | 'mp4' | 'unknown';
export type VlcPlatform = 'windows' | 'mac' | 'linux';

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
}

export interface HomeCatalog {
  calendar: CatalogMediaItem[];
  releases: CatalogMediaItem[];
  animes: CatalogMediaItem[];
  movies: CatalogMediaItem[];
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
  sourceMode?: 'live' | 'snapshot';
}

export interface SearchResultItem {
  id: string;
  title: string;
  url: string;
  kind: MediaKind;
  poster: string;
  year?: string;
  excerpt?: string;
  audioType: AudioType;
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
  title: string;
  url: string;
  date?: string;
  thumb?: string;
}

export interface AnimeDetails {
  title: string;
  url: string;
  poster: string;
  backdrop: string;
  synopsis: string;
  year?: string;
  rating?: string;
  genres: string[];
  audioType: AudioType;
  episodes: AnimeEpisodeLink[];
}

export interface PlayerOption {
  nume: string;
  label: string;
  embedUrl: string;
  providerKind: 'kojima' | 'zuplay' | 'vidstreaming' | 'playerjs' | 'abyss' | 'blogger' | 'other';
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

export interface EpisodeDetails {
  title: string;
  seriesTitle: string;
  seriesUrl?: string;
  url: string;
  episodeLabel?: string;
  poster: string;
  backdrop: string;
  synopsis: string;
  genres: string[];
  prevUrl?: string;
  nextUrl?: string;
  options: PlayerOption[];
  isMovie: boolean;
  sourceMode?: 'live' | 'snapshot';
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
}

