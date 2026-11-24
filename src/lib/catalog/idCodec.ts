import type { CatalogSourceId, ExternalMediaIds, MediaKind } from '../types.ts';

export type CanonicalMediaType = 'anime' | 'series' | 'movie';

export interface ParsedAnisyncMediaUri {
  kind: 'media';
  mediaType: CanonicalMediaType;
  source: CatalogSourceId;
  externalId: string;
}

export interface ParsedAnisyncEpisodeUri {
  kind: 'episode';
  mediaType: CanonicalMediaType;
  source: CatalogSourceId;
  externalId: string;
  seasonNumber: number;
  episodeNumber: number;
}

export interface ParsedLegacyUrl {
  kind: 'legacy-url';
  url: string;
}

export type ParsedMediaTarget =
  | ParsedAnisyncMediaUri
  | ParsedAnisyncEpisodeUri
  | ParsedLegacyUrl;

const VALID_SOURCES = new Set<CatalogSourceId>(['thetvdb', 'livechart', 'server']);
const VALID_MEDIA_TYPES = new Set<CanonicalMediaType>(['anime', 'series', 'movie']);

export function isAnisyncUri(raw: string): boolean {
  return typeof raw === 'string' && raw.trim().toLowerCase().startsWith('anisync://');
}

export function buildMediaUri(
  mediaType: CanonicalMediaType,
  source: CatalogSourceId,
  externalId: string | number
): string {
  const cleanId = encodeURIComponent(String(externalId).trim());
  return `anisync://${mediaType}/${source}/${cleanId}`;
}

export function buildLiveChartScheduleUri(
  livechartId: number,
  title: string,
  englishTitle?: string
): string {
  const payload = englishTitle && englishTitle !== title
    ? `${livechartId}~${title}~${englishTitle}`
    : `${livechartId}~${title}`;
  return buildMediaUri('anime', 'livechart', payload);
}

export function parseLiveChartExternalId(externalId: string): {
  livechartId: number;
  title?: string;
  englishTitle?: string;
} {
  const parts = String(externalId || '').split('~');
  const livechartId = Number.parseInt(parts[0] || '', 10);
  return {
    livechartId: Number.isFinite(livechartId) && livechartId > 0 ? livechartId : 0,
    title: parts[1]?.trim() || undefined,
    englishTitle: parts[2]?.trim() || undefined,
  };
}

export function buildEpisodeUri(
  mediaType: CanonicalMediaType,
  source: CatalogSourceId,
  externalId: string | number,
  seasonNumber = 1,
  episodeNumber = 1
): string {
  const cleanId = encodeURIComponent(String(externalId).trim());
  const s = Math.max(0, Math.floor(seasonNumber || 1));
  const e = Math.max(1, Math.floor(episodeNumber || 1));
  return `anisync://episode/${mediaType}/${source}/${cleanId}/s${s}/e${e}`;
}

export function parseAnisyncUri(raw: string): ParsedMediaTarget {
  const trimmed = (raw || '').trim();
  if (!isAnisyncUri(trimmed)) {
    return { kind: 'legacy-url', url: trimmed };
  }

  const withoutScheme = trimmed.slice('anisync://'.length).replace(/\/+$/, '');
  const parts = withoutScheme.split('/').filter(Boolean);

  if (parts[0] === 'episode' && parts.length >= 6) {
    const mediaType = parts[1] as CanonicalMediaType;
    const source = parts[2] as CatalogSourceId;
    const externalId = decodeURIComponent(parts[3]);
    const seasonMatch = parts[4].match(/^s(\d+)$/i);
    const epMatch = parts[5].match(/^e(\d+)$/i);
    if (
      VALID_MEDIA_TYPES.has(mediaType) &&
      VALID_SOURCES.has(source) &&
      externalId &&
      seasonMatch &&
      epMatch
    ) {
      return {
        kind: 'episode',
        mediaType,
        source,
        externalId,
        seasonNumber: Number.parseInt(seasonMatch[1], 10),
        episodeNumber: Number.parseInt(epMatch[1], 10),
      };
    }
  }

  if (parts.length >= 3) {
    const mediaType = parts[0] as CanonicalMediaType;
    const source = parts[1] as CatalogSourceId;
    const externalId = decodeURIComponent(parts[2]);
    if (VALID_MEDIA_TYPES.has(mediaType) && VALID_SOURCES.has(source) && externalId) {
      return {
        kind: 'media',
        mediaType,
        source,
        externalId,
      };
    }
  }

  return { kind: 'legacy-url', url: trimmed };
}

export function inferMediaKindFromTarget(raw: string): MediaKind {
  const parsed = parseAnisyncUri(raw);
  if (parsed.kind === 'episode') return 'episode';
  if (parsed.kind === 'media') return parsed.mediaType;
  if (/\/filmes\//i.test(raw)) return 'movie';
  if (/\/(?:episodio|videos)\//i.test(raw)) return 'episode';
  if (/\/(?:doramas|tokusatsus)\//i.test(raw)) return 'series';
  return 'anime';
}

export function parentSeriesUriFromEpisode(raw: string): string | null {
  const parsed = parseAnisyncUri(raw);
  if (parsed.kind !== 'episode') return null;
  return buildMediaUri(parsed.mediaType, parsed.source, parsed.externalId);
}

export function canonicalMediaKey(raw: string): string {
  const trimmed = (raw || '').trim();
  if (!trimmed) return '';
  if (isAnisyncUri(trimmed)) {
    return trimmed.replace(/\/+$/, '').toLowerCase();
  }
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const pathname = parsed.pathname.replace(/\/+$/, '').toLowerCase();
    return `${host}${pathname}${parsed.search}`;
  } catch {
    return trimmed
      .replace(/^https?:\/\/(?:www\.)?/i, '')
      .replace(/\/+$/, '')
      .toLowerCase();
  }
}

export interface ExternalDatabaseLink {
  source: CatalogSourceId;
  label: string;
  url: string;
}

export function buildExternalDatabaseLinks(
  ids: ExternalMediaIds | undefined,
  options?: { mediaType?: CanonicalMediaType }
): ExternalDatabaseLink[] {
  if (!ids) return [];
  const links: ExternalDatabaseLink[] = [];
  const isMovie = options?.mediaType === 'movie';

  if (ids.tvdbId || ids.tvdbSlug) {
    const tvdbUrl = ids.tvdbSlug
      ? `https://www.thetvdb.com/${isMovie ? 'movies' : 'series'}/${encodeURIComponent(ids.tvdbSlug)}`
      : `https://www.thetvdb.com/dereferrer/${isMovie ? 'movie' : 'series'}/${ids.tvdbId}`;
    links.push({
      source: 'thetvdb',
      label: 'TheTVDB',
      url: tvdbUrl,
    });
  }

  if (ids.livechartId) {
    links.push({
      source: 'livechart',
      label: 'LiveChart.me',
      url: `https://www.livechart.me/anime/${ids.livechartId}`,
    });
  }

  return links;
}

export function normalizeTitleForMatch(raw: string): string {
  return (raw || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(
      /\b(?:dublado|legendado|dub|leg|online|hd|full\s*hd|assistir|todos os episodios|pt[\s-]?br|dual\s*audio)\b/gi,
      ' '
    )
    .replace(/\b(?:season|temporada)\s*(\d+)\b/gi, ' s$1 ')
    .replace(/(\d+)(?:st|nd|rd|th|a|ª)\s*(?:season|temporada)\b/gi, ' s$1 ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function stripSeasonFromTitle(raw: string): string {
  return (raw || '')
    .replace(
      /\s*\((?:dublado|legendado|dub|leg|pt[\s-]?br|dual[\s-]?audio|hd|full\s*hd|tv)\)\s*/gi,
      ' '
    )
    .replace(
      /\s*[-–—:]?\s*\b(?:(?:the\s+)?final\s+season|temporada\s+final|[uú]ltima\s+temporada)\b.*$/i,
      ''
    )
    .replace(/\s*[-–—:]?\s*\b(?:season|temporada|part|parte|cour)\s*\d+\b.*$/i, '')
    .replace(/\s*[-–—:]?\s*\b\d+(?:st|nd|rd|th|a|ª)\s*(?:season|temporada)\b.*$/i, '')
    .replace(/\s*[-–—]\s*(?:dublado|legendado|dub|leg)\s*$/i, '')
    .replace(/\s+\b(?:dublado|legendado|dub|leg|online|hd|full\s*hd)\b/gi, '')
    .replace(/\s+(?:II|III|IV|V|VI|VII|VIII|IX|X)(?:\s*[-–—:].*|\s*$)/, '')
    .replace(
      /^(.{3,}?[^\d/])\s+([2-9]|1[0-5])(?:\s*(?::|–|—|\s-\s)(?!\s*(?:the\s+animation|the\s+series|animation)\b).*|\s*$)/i,
      '$1'
    )
    .replace(/[-–—:]+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function scoreTitleSimilarity(query: string, candidate: string): number {
  const a = normalizeTitleForMatch(query);
  const b = normalizeTitleForMatch(candidate);
  if (!a || !b) return 0;
  if (a === b) return 1;

  const aTokens = a.split(' ').filter(Boolean);
  const bTokens = b.split(' ').filter(Boolean);
  if (!aTokens.length || !bTokens.length) return 0;

  const aSet = new Set(aTokens);
  const bSet = new Set(bTokens);
  let overlap = 0;
  for (const t of aSet) {
    if (bSet.has(t)) overlap += 1;
  }

  const jaccard = overlap / (aSet.size + bSet.size - overlap);
  const containment = overlap / Math.min(aSet.size, bSet.size);
  const prefixBonus = b.startsWith(a) || a.startsWith(b) ? 0.15 : 0;

  // Penalize season number mismatch (e.g. "Frieren" vs "Frieren s2")
  const aSeason = a.match(/\bs(\d+)\b/)?.[1] || a.match(/\b([2-9])$/)?.[1] || '';
  const bSeason = b.match(/\bs(\d+)\b/)?.[1] || b.match(/\b([2-9])$/)?.[1] || '';
  const seasonPenalty = aSeason !== bSeason ? -0.18 : 0;

  return Math.max(0, Math.min(0.99, jaccard * 0.55 + containment * 0.35 + prefixBonus + seasonPenalty));
}
