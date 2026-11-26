import { formatEpisodeReleaseDate } from './episodeAvailability';
import type { AnimeDetails } from './types';

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

