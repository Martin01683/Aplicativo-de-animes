import type {
  AudioType,
  ExternalMediaIds,
  PlayerOption,
  StreamFormat,
  SubtitleTrack,
} from '../types.ts';

export type EpisodeSourceCategory = 'site';

export type EpisodeSourceKind = 'topanimes' | 'hinatasoul';

export type SupportedMediaScope = 'anime' | 'series' | 'movie';

export interface EpisodeSourceConfig {
  id: string;
  name: string;
  category: EpisodeSourceCategory;
  kind: EpisodeSourceKind;
  enabled: boolean;
  priority: number;
  baseUrl: string;
  supportsMedia: SupportedMediaScope[];
  notes?: string;
  builtIn?: boolean;
}

export interface EpisodeSourceLookupQuery {
  title: string;
  originalTitle?: string;
  alternativeTitles?: string[];
  mediaType: SupportedMediaScope;
  seasonNumber?: number;
  episodeNumber?: number;
  year?: string;
  externalIds?: ExternalMediaIds;
  audioPreference?: 'ALL' | 'DUB' | 'LEG';
  legacyEpisodeUrl?: string;
}

export interface AggregatedServerOption extends PlayerOption {
  sourceId: string;
  sourceName: string;
  sourceKind: EpisodeSourceKind;
  audioType?: AudioType;
  matchedPageUrl?: string;
  directStreamUrl?: string;
  directFormat?: StreamFormat;
  directReferer?: string;
  directSubtitles?: SubtitleTrack[];
  qualityLabel?: string;
}

export interface SourceLookupReport {
  sourceId: string;
  sourceName: string;
  sourceKind: EpisodeSourceKind;
  status: 'found' | 'not-found' | 'error' | 'skipped';
  optionsCount: number;
  matchedTitle?: string;
  matchedUrl?: string;
  errorMessage?: string;
  durationMs: number;
}

export interface AggregatedEpisodeServersResult {
  options: AggregatedServerOption[];
  reports: SourceLookupReport[];
}

export interface SourceTestResult {
  ok: boolean;
  sourceId: string;
  sourceName: string;
  statusCode?: number;
  message: string;
  latencyMs: number;
}

export const TOPANIMES_BUILTIN_SOURCE: EpisodeSourceConfig = {
  id: 'topanimes',
  name: 'TopAnimes',
  category: 'site',
  kind: 'topanimes',
  enabled: true,
  priority: 10,
  baseUrl: 'https://topanimes.net',
  supportsMedia: ['anime', 'movie'],
  notes: 'Fonte integrada de servidores para animes (Legendado e Dublado) e filmes de anime.',
  builtIn: true,
};

export const HINATASOUL_BUILTIN_SOURCE: EpisodeSourceConfig = {
  id: 'hinatasoul',
  name: 'Hinata Soul',
  category: 'site',
  kind: 'hinatasoul',
  enabled: true,
  priority: 20,
  baseUrl: 'https://www.hinatasoul.com',
  supportsMedia: ['anime', 'series', 'movie'],
  notes:
    'Fonte integrada de servidores com reprodução direta SD, HD e Full HD para animes Legendados e Dublados.',
  builtIn: true,
};

export const DEFAULT_EPISODE_SOURCES: EpisodeSourceConfig[] = [
  { ...TOPANIMES_BUILTIN_SOURCE },
  { ...HINATASOUL_BUILTIN_SOURCE },
];

export const EPISODE_SOURCE_KIND_META: Record<
  EpisodeSourceKind,
  {
    label: string;
    category: EpisodeSourceCategory;
    description: string;
    urlPlaceholder: string;
    defaultMedia: SupportedMediaScope[];
  }
> = {
  topanimes: {
    label: 'TopAnimes (Integrado)',
    category: 'site',
    description: 'Busca automática de servidores KojimaCDN, Zuplay, Vidstreaming e Ruplay.',
    urlPlaceholder: 'https://topanimes.net',
    defaultMedia: ['anime', 'movie'],
  },
  hinatasoul: {
    label: 'Hinata Soul (Integrado)',
    category: 'site',
    description: 'Busca automática de servidores diretos SD, HD e Full HD (Legendado e Dublado).',
    urlPlaceholder: 'https://www.hinatasoul.com',
    defaultMedia: ['anime', 'series', 'movie'],
  },
};

export function sanitizeEpisodeSources(_raw?: unknown): EpisodeSourceConfig[] {
  return DEFAULT_EPISODE_SOURCES.map((source) => ({
    ...source,
    supportsMedia: [...source.supportsMedia],
  }));
}
