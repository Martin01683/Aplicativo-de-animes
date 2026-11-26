import { formatEpisodeReleaseDate } from './episodeAvailability';
import type { AnimeDetails, AudioType, MediaKind } from './types';

export type AnimeMetaKind =
  | 'status'
  | 'rating'
  | 'date'
  | 'clock'
  | 'layers'
  | 'studio'
  | 'network'
  | 'globe'
  | 'server';

export interface AnimeInfoMetaItem {
  id: string;
  label: string;
  value: string;
  items?: string[];
  kind: AnimeMetaKind;
  highlight?: boolean;
  fullWidth?: boolean;
}

export function parseProviderNames(raw?: string): string[] {
  if (!raw || !raw.trim()) return [];
  const parts = raw
    .split(/\s*(?:,|·|•|\+|\||\/)\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const key = part.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(part);
  }
  return out;
}

function inferProviderFromUrl(rawUrl?: string): string | null {
  if (!rawUrl) return null;
  if (/hinatasoul/i.test(rawUrl)) return 'Hinata Soul';
  if (/topanimes/i.test(rawUrl)) return 'TopAnimes';
  return null;
}

export function extractAnimeProviders(anime: Pick<
  AnimeDetails,
  'sourceServerName' | 'url' | 'episodes' | 'audioTracks'
>): string[] {
  const providers: string[] = [];
  const seen = new Set<string>();

  const pushProvider = (name: string | null | undefined) => {
    const clean = (name || '').trim();
    if (!clean) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    providers.push(clean);
  };

  for (const name of parseProviderNames(anime.sourceServerName)) {
    pushProvider(name);
  }

  const allEpisodes = [
    ...(anime.episodes || []),
    ...(anime.audioTracks?.DUB?.episodes || []),
    ...(anime.audioTracks?.LEG?.episodes || []),
  ];

  for (const ep of allEpisodes) {
    if (ep.availableOnServer === false) continue;
    pushProvider(inferProviderFromUrl(ep.url));
  }

  if (providers.length === 0) {
    pushProvider(inferProviderFromUrl(anime.url));
  }

  return providers;
}

export function buildAnimeInfoMetaItems(anime: AnimeDetails): AnimeInfoMetaItem[] {
  const items: AnimeInfoMetaItem[] = [];

  if (anime.status) {
    items.push({
      id: 'status',
      label: 'Status',
      value: anime.status,
      kind: 'status',
      highlight: /em exibição|lançamento|airing|ongoing|continuing/i.test(anime.status),
    });
  }

  const parsedRating = anime.rating ? Number.parseFloat(anime.rating) : Number.NaN;
  if (anime.rating && Number.isFinite(parsedRating) && parsedRating > 0) {
    items.push({
      id: 'rating',
      label: 'Nota',
      value: anime.rating.trim(),
      kind: 'rating',
    });
  }

  if (anime.studio) {
    items.push({ id: 'studio', label: 'Estúdio', value: anime.studio, kind: 'studio' });
  }

  if (anime.network) {
    items.push({ id: 'network', label: 'Rede', value: anime.network, kind: 'network' });
  }

  if (anime.firstAirDate) {
    items.push({
      id: 'firstAirDate',
      label: 'Estreia',
      value: formatEpisodeReleaseDate(anime.firstAirDate) || anime.firstAirDate,
      kind: 'date',
    });
  } else if (anime.year) {
    items.push({ id: 'year', label: 'Ano', value: anime.year, kind: 'date' });
  }

  if (anime.lastAirDate) {
    items.push({
      id: 'lastAirDate',
      label: 'Recente',
      value: formatEpisodeReleaseDate(anime.lastAirDate) || anime.lastAirDate,
      kind: 'date',
    });
  }

  if (anime.averageDuration) {
    items.push({
      id: 'duration',
      label: 'Duração',
      value: anime.averageDuration,
      kind: 'clock',
    });
  }

  if (anime.seasonsCount) {
    items.push({
      id: 'seasons',
      label: 'Temporadas',
      value: anime.seasonsCount,
      kind: 'layers',
    });
  }

  if (anime.originalLanguage) {
    items.push({
      id: 'language',
      label: 'Idioma',
      value: anime.originalLanguage,
      kind: 'globe',
    });
  }

  if (anime.originalCountry) {
    items.push({
      id: 'country',
      label: 'País',
      value: anime.originalCountry,
      kind: 'globe',
    });
  }

  const providers = extractAnimeProviders(anime);
  if (providers.length > 0) {
    items.push({
      id: 'providers',
      label: providers.length > 1 ? 'Provedores' : 'Provedor',
      value: providers.join(' · '),
      items: providers,
      kind: 'server',
      fullWidth: providers.length > 1,
    });
  }

  return items;
}

export type HeroAudioBadge = 'DUB' | 'LEG';

export function resolveAnimeHeroAudioBadges(
  anime: Pick<AnimeDetails, 'audioType' | 'audioTracks' | 'kind'>
): HeroAudioBadge[] {
  const isMovie = anime.kind === 'movie';
  const dubTrack = anime.audioTracks?.DUB;
  const legTrack = anime.audioTracks?.LEG;

  const hasBothTracks = Boolean(
    !isMovie &&
      dubTrack &&
      legTrack &&
      dubTrack.episodes.length > 0 &&
      legTrack.episodes.length > 0 &&
      (dubTrack.playableCount > 0 || legTrack.playableCount > 0)
  );
  if (hasBothTracks) {
    return ['DUB', 'LEG'];
  }

  const hasDubTrack = Boolean(
    !isMovie && dubTrack && dubTrack.episodes.length > 0 && dubTrack.playableCount > 0
  );
  const hasLegTrack = Boolean(
    !isMovie && legTrack && legTrack.episodes.length > 0 && legTrack.playableCount > 0
  );
  if (hasDubTrack && hasLegTrack) return ['DUB', 'LEG'];
  if (hasDubTrack) return ['DUB'];
  if (hasLegTrack) return ['LEG'];

  if (anime.audioType === 'DUB' || anime.audioType === 'LEG') {
    return [anime.audioType];
  }
  return [];
}

function cleanGenreList(
  genres: readonly string[] | undefined,
  redundantLabel: string
): string[] {
  if (!genres || genres.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of genres) {
    const clean = raw.trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (key === redundantLabel) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

export function resolveVisibleGenres(
  primaryGenres?: readonly string[],
  fallbackGenres?: readonly string[],
  kind?: MediaKind | null
): string[] {
  const redundantLabel = kind === 'movie' ? 'filme' : kind === 'series' ? 'série' : 'anime';
  const primary = cleanGenreList(primaryGenres, redundantLabel);
  if (primary.length > 0) return primary;
  return cleanGenreList(fallbackGenres, redundantLabel);
}

export function resolveEpisodeMediaKind(params: {
  isMovie?: boolean;
  mediaType?: 'anime' | 'series' | 'movie';
  seriesKind?: MediaKind | null;
  seriesUrl?: string;
  url?: string;
}): 'anime' | 'series' | 'movie' {
  if (
    params.isMovie ||
    params.mediaType === 'movie' ||
    params.seriesKind === 'movie' ||
    /\/filmes?\//i.test(params.url || '') ||
    /\/filmes?\//i.test(params.seriesUrl || '')
  ) {
    return 'movie';
  }
  if (
    params.mediaType === 'series' ||
    params.seriesKind === 'series' ||
    /\/series\//i.test(params.seriesUrl || '') ||
    /\/series\//i.test(params.url || '')
  ) {
    return 'series';
  }
  return 'anime';
}

function inferAudioFromText(text?: string): HeroAudioBadge | null {
  if (!text) return null;
  if (/\bdublado\b|\bdub\b|-dublado\b|-dub(?=\/|-|$|\d)/i.test(text)) return 'DUB';
  if (/\blegendado\b|\bleg\b|-legendado\b|-leg(?=\/|-|$|\d)/i.test(text)) return 'LEG';
  return null;
}

export function resolveEpisodeAudioBadges(params: {
  matchedEpisodeAudio?: AudioType;
  selectedOptionAudio?: AudioType;
  seriesAudioType?: AudioType;
  title?: string;
  seriesTitle?: string;
  url?: string;
  seriesUrl?: string;
  options?: readonly { audioType?: AudioType; label?: string }[];
}): HeroAudioBadge[] {
  if (params.matchedEpisodeAudio === 'DUB' || params.matchedEpisodeAudio === 'LEG') {
    return [params.matchedEpisodeAudio];
  }

  const fromTitleOrUrl =
    inferAudioFromText(params.title) ||
    inferAudioFromText(params.url) ||
    inferAudioFromText(params.seriesTitle) ||
    inferAudioFromText(params.seriesUrl);
  if (fromTitleOrUrl) {
    return [fromTitleOrUrl];
  }

  if (params.selectedOptionAudio === 'DUB' || params.selectedOptionAudio === 'LEG') {
    return [params.selectedOptionAudio];
  }

  if (params.seriesAudioType === 'DUB' || params.seriesAudioType === 'LEG') {
    return [params.seriesAudioType];
  }

  if (params.options && params.options.length > 0) {
    const found = new Set<HeroAudioBadge>();
    for (const opt of params.options) {
      if (opt.audioType === 'DUB' || opt.audioType === 'LEG') {
        found.add(opt.audioType);
      } else {
        const inferred = inferAudioFromText(opt.label);
        if (inferred) found.add(inferred);
      }
    }
    const ordered: HeroAudioBadge[] = [];
    if (found.has('DUB')) ordered.push('DUB');
    if (found.has('LEG')) ordered.push('LEG');
    return ordered;
  }

  return [];
}



