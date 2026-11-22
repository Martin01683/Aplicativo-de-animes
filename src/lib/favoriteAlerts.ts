import {
  buildMediaUri,
  isAnisyncUri,
  parseAnisyncUri,
} from './catalog/idCodec.ts';
import type {
  CatalogMediaItem,
  FavoriteAlertEntry,
  FavoriteBaselineMap,
  FavoriteEpisodeBaseline,
  FavoriteLatestInfo,
} from './types.ts';

export function normalizeTopAnimesUrl(rawUrl: string): string {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) return '';
  if (isAnisyncUri(trimmed)) {
    return trimmed.replace(/\/+$/, '');
  }
  try {
    const u = new URL(trimmed);
    const cleanPath = u.pathname.replace(/\/+$/, '');
    return `${u.origin.toLowerCase()}${cleanPath}/`;
  } catch {
    return trimmed.replace(/\/+$/, '') + '/';
  }
}

export function canonicalEpisodeKey(rawUrl: string): string {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) return '';
  if (isAnisyncUri(trimmed)) {
    return trimmed.replace(/\/+$/, '').toLowerCase();
  }
  const normalized = normalizeTopAnimesUrl(trimmed) || trimmed;
  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const pathname = parsed.pathname.replace(/\/+$/, '').toLowerCase();
    return `${host}${pathname}${parsed.search}`;
  } catch {
    return normalized
      .replace(/^https?:\/\/(?:www\.)?/i, '')
      .replace(/\/+$/, '')
      .toLowerCase();
  }
}

export function extractMediaSlug(rawUrl: string): string {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) return '';
  const anisync = parseAnisyncUri(trimmed);
  if (anisync.kind === 'media' || anisync.kind === 'episode') {
    return `${anisync.mediaType}/${anisync.source}/${anisync.externalId}`.toLowerCase();
  }
  let pathname = trimmed;
  try {
    pathname = new URL(trimmed).pathname;
  } catch {
    // treat as path/slug
  }
  const clean = pathname
    .toLowerCase()
    .replace(/^\/+|\/+$/g, '')
    .replace(/^(?:animes|anime-dublado|donghua|doramas|tokusatsus|filmes|episodio|videos)\//i, '');

  return clean
    .replace(/-episodio-\d+(?:-\d+)?$/i, '')
    .replace(/-ep-\d+(?:-\d+)?$/i, '')
    .trim();
}

export function extractEpisodeNumber(textOrUrl: string): number | null {
  if (!textOrUrl) return null;
  const anisync = parseAnisyncUri(textOrUrl);
  if (anisync.kind === 'episode') {
    return anisync.episodeNumber;
  }
  const slugMatch = textOrUrl.match(/-episodio-(\d+(?:\.\d+)?)(?:\/|$|\?)/i);
  if (slugMatch?.[1]) {
    const n = Number.parseFloat(slugMatch[1]);
    return Number.isFinite(n) ? n : null;
  }
  const labelMatch = textOrUrl.match(/(?:epis[oó]dio|ep\.?)\s*(\d+(?:\.\d+)?)/i);
  if (labelMatch?.[1]) {
    const n = Number.parseFloat(labelMatch[1]);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function cleanEpisodeSeriesTitle(rawTitle: string): string {
  return rawTitle
    .replace(/\s*[-–—]\s*(?:EP|Epis[oó]dio)\s*\d+(?:\.\d+)?(?:\s*Final)?\s*$/i, '')
    .replace(/\s+Epis[oó]dio\s+\d+(?:\.\d+)?(?:\s*Final)?\s*$/i, '')
    .trim();
}

export function toSeriesFavoriteItem(item: CatalogMediaItem): CatalogMediaItem {
  const parsed = parseAnisyncUri(item.url);
  if (parsed.kind === 'episode') {
    const seriesUri = buildMediaUri(parsed.mediaType, parsed.source, parsed.externalId);
    return {
      ...item,
      id: seriesUri,
      url: seriesUri,
      kind: parsed.mediaType,
      title: cleanEpisodeSeriesTitle(item.title) || item.title,
      episodeLabel: undefined,
    };
  }
  if (parsed.kind === 'media') {
    const norm = normalizeTopAnimesUrl(item.url);
    return {
      ...item,
      id: norm,
      url: norm,
      kind: parsed.mediaType,
    };
  }
  if (item.kind !== 'episode' && !/\/(?:episodio|videos)\//i.test(item.url)) {
    return {
      ...item,
      url: normalizeTopAnimesUrl(item.url),
      id: normalizeTopAnimesUrl(item.url),
    };
  }
  if (/\/videos\/\d+/i.test(item.url)) {
    const norm = normalizeTopAnimesUrl(item.url);
    return {
      ...item,
      id: norm,
      url: norm,
    };
  }
  const slug = extractMediaSlug(item.url);
  if (!slug) return item;
  let origin = 'https://topanimes.net';
  try {
    origin = new URL(item.url).origin;
  } catch {
    // default
  }
  const seriesUrl = `${origin}/animes/${slug}/`;
  return {
    ...item,
    id: seriesUrl,
    url: seriesUrl,
    kind: 'anime',
    title: cleanEpisodeSeriesTitle(item.title) || item.title,
    episodeLabel: undefined,
  };
}

export function findMatchingFavorite(
  url: string,
  favorites: CatalogMediaItem[]
): CatalogMediaItem | undefined {
  const norm = normalizeTopAnimesUrl(url);
  const slug = extractMediaSlug(url);
  return favorites.find((fav) => {
    if (normalizeTopAnimesUrl(fav.url) === norm) return true;
    const favSlug = extractMediaSlug(fav.url);
    return Boolean(slug && favSlug && favSlug === slug);
  });
}

export function isItemFavorited(url: string, favorites: CatalogMediaItem[]): boolean {
  return Boolean(findMatchingFavorite(url, favorites));
}

function findLatestReleaseForFavorite(
  favorite: CatalogMediaItem,
  releases: CatalogMediaItem[]
): FavoriteLatestInfo | null {
  const favSlug = extractMediaSlug(favorite.url);
  const favTitleNorm = cleanEpisodeSeriesTitle(favorite.title).toLowerCase();

  let best: FavoriteLatestInfo | null = null;
  for (const rel of releases) {
    const relSlug = extractMediaSlug(rel.url);
    const relTitleNorm = cleanEpisodeSeriesTitle(rel.title).toLowerCase();
    const matchesSlug = Boolean(favSlug && relSlug && favSlug === relSlug);
    const matchesTitle = Boolean(favTitleNorm && relTitleNorm && favTitleNorm === relTitleNorm);
    if (!matchesSlug && !matchesTitle) continue;

    const epNum =
      extractEpisodeNumber(rel.episodeLabel || '') ??
      extractEpisodeNumber(rel.title) ??
      extractEpisodeNumber(rel.url);

    const candidate: FavoriteLatestInfo = {
      episodeUrl: normalizeTopAnimesUrl(rel.url),
      episodeTitle: rel.episodeLabel
        ? `${cleanEpisodeSeriesTitle(rel.title)} — ${rel.episodeLabel}`
        : rel.title,
      episodeLabel: rel.episodeLabel || (epNum !== null ? `EP ${epNum}` : 'Novo episódio'),
      episodeNumber: epNum,
      poster: rel.poster || favorite.poster,
    };

    if (!best) {
      best = candidate;
    } else if (
      candidate.episodeNumber !== null &&
      (best.episodeNumber === null || candidate.episodeNumber > best.episodeNumber)
    ) {
      best = candidate;
    }
  }
  return best;
}

export function pickLatestAnimeEpisode(
  episodes: Array<{
    numberLabel: string;
    episodeNumber: number | null;
    title: string;
    url: string;
    thumb?: string;
  }>,
  seriesTitle: string,
  fallbackPoster: string
): FavoriteLatestInfo | null {
  if (!episodes.length) return null;
  let best = episodes[episodes.length - 1];
  let bestNum =
    best.episodeNumber ?? extractEpisodeNumber(best.url) ?? extractEpisodeNumber(best.title);

  for (const ep of episodes) {
    const num = ep.episodeNumber ?? extractEpisodeNumber(ep.url) ?? extractEpisodeNumber(ep.title);
    if (num !== null && (bestNum === null || num > bestNum)) {
      best = ep;
      bestNum = num;
    }
  }

  return {
    episodeUrl: normalizeTopAnimesUrl(best.url),
    episodeTitle: `${seriesTitle} — ${best.title}`,
    episodeLabel: bestNum !== null ? `EP ${bestNum}` : best.numberLabel || best.title,
    episodeNumber: bestNum,
    poster: best.thumb || fallbackPoster,
  };
}

export function buildFavoriteBaseline(
  favorite: CatalogMediaItem,
  releases: CatalogMediaItem[],
  knownLatest?: FavoriteLatestInfo | null,
  nowIso: string = new Date().toISOString()
): FavoriteEpisodeBaseline | null {
  const fromReleases = findLatestReleaseForFavorite(favorite, releases);
  const chosen = pickNewerCandidate(knownLatest || null, fromReleases);
  if (!chosen) return null;
  return {
    lastEpisodeUrl: normalizeTopAnimesUrl(chosen.episodeUrl),
    lastEpisodeNumber: chosen.episodeNumber,
    updatedAt: nowIso,
  };
}

function pickNewerCandidate(
  a: FavoriteLatestInfo | null,
  b: FavoriteLatestInfo | null
): FavoriteLatestInfo | null {
  if (!a) return b;
  if (!b) return a;
  if (a.episodeNumber !== null && b.episodeNumber !== null) {
    return a.episodeNumber >= b.episodeNumber ? a : b;
  }
  if (b.episodeNumber !== null && a.episodeNumber === null) return b;
  return a;
}

export function advanceBaselineWithWatchedEpisodes(params: {
  animeUrl: string;
  episodes: Array<{
    url: string;
    episodeNumber?: number | null;
    title?: string;
    numberLabel?: string;
  }>;
  baselines: FavoriteBaselineMap;
  nowIso?: string;
}): FavoriteBaselineMap {
  const { animeUrl, episodes, baselines, nowIso = new Date().toISOString() } = params;
  if (!animeUrl || episodes.length === 0) return baselines;

  const baselineKey = normalizeTopAnimesUrl(animeUrl) || animeUrl;
  let bestEp: { url: string; episodeNumber: number | null } | null = null;
  for (const ep of episodes) {
    if (!ep.url) continue;
    const epNum =
      ep.episodeNumber ??
      extractEpisodeNumber(ep.url) ??
      extractEpisodeNumber(ep.title || '') ??
      extractEpisodeNumber(ep.numberLabel || '');
    if (!bestEp) {
      bestEp = { url: normalizeTopAnimesUrl(ep.url), episodeNumber: epNum };
    } else if (
      epNum !== null &&
      (bestEp.episodeNumber === null || epNum >= bestEp.episodeNumber)
    ) {
      bestEp = { url: normalizeTopAnimesUrl(ep.url), episodeNumber: epNum };
    }
  }
  if (!bestEp) return baselines;

  const current = baselines[baselineKey] || baselines[animeUrl];
  if (
    current &&
    current.lastEpisodeNumber !== null &&
    bestEp.episodeNumber !== null &&
    bestEp.episodeNumber < current.lastEpisodeNumber
  ) {
    return baselines;
  }

  return {
    ...baselines,
    [baselineKey]: {
      lastEpisodeUrl: bestEp.url,
      lastEpisodeNumber: bestEp.episodeNumber ?? current?.lastEpisodeNumber ?? null,
      updatedAt: nowIso,
    },
  };
}

export function detectNewFavoriteEpisodes(params: {
  favorites: CatalogMediaItem[];
  releases: CatalogMediaItem[];
  baselines: FavoriteBaselineMap;
  existingAlerts: FavoriteAlertEntry[];
  latestByAnimeUrl?: Record<string, FavoriteLatestInfo>;
  watchedEpisodeKeys?: Set<string>;
  nowIso?: string;
}): {
  newAlerts: FavoriteAlertEntry[];
  nextAlerts: FavoriteAlertEntry[];
  nextBaselines: FavoriteBaselineMap;
} {
  const {
    favorites,
    releases,
    baselines,
    existingAlerts,
    latestByAnimeUrl = {},
    watchedEpisodeKeys,
    nowIso = new Date().toISOString(),
  } = params;

  const nextBaselines: FavoriteBaselineMap = { ...baselines };
  const newAlerts: FavoriteAlertEntry[] = [];
  const existingEpisodeUrls = new Set(
    existingAlerts.map((a) => normalizeTopAnimesUrl(a.episodeUrl))
  );

  for (const fav of favorites) {
    const favNormUrl = normalizeTopAnimesUrl(fav.url);
    const fromCheck =
      latestByAnimeUrl[fav.url] ||
      latestByAnimeUrl[favNormUrl] ||
      null;
    const fromReleases = findLatestReleaseForFavorite(fav, releases);
    const latest = pickNewerCandidate(fromCheck, fromReleases);
    if (!latest) continue;

    const latestEpUrl = normalizeTopAnimesUrl(latest.episodeUrl);
    const latestCanonicalKey = canonicalEpisodeKey(latest.episodeUrl);
    const alreadyWatched = Boolean(
      watchedEpisodeKeys &&
        (watchedEpisodeKeys.has(latestCanonicalKey) ||
          watchedEpisodeKeys.has(latestEpUrl) ||
          watchedEpisodeKeys.has(latest.episodeUrl))
    );
    const baselineKey = favNormUrl || fav.url;
    const existingBaseline = nextBaselines[baselineKey] || nextBaselines[fav.url];

    if (!existingBaseline) {
      // Seed baseline silently on first encounter so existing catalog episodes don't spam alerts
      nextBaselines[baselineKey] = {
        lastEpisodeUrl: latestEpUrl,
        lastEpisodeNumber: latest.episodeNumber,
        updatedAt: nowIso,
      };
      continue;
    }

    const baselineUrl = normalizeTopAnimesUrl(existingBaseline.lastEpisodeUrl);
    if (latestEpUrl === baselineUrl) continue;

    const isStrictlyOlder =
      latest.episodeNumber !== null &&
      existingBaseline.lastEpisodeNumber !== null &&
      latest.episodeNumber <= existingBaseline.lastEpisodeNumber;

    if (isStrictlyOlder) continue;

    nextBaselines[baselineKey] = {
      lastEpisodeUrl: latestEpUrl,
      lastEpisodeNumber: latest.episodeNumber,
      updatedAt: nowIso,
    };

    if (alreadyWatched) {
      continue;
    }

    if (!existingEpisodeUrls.has(latestEpUrl)) {
      existingEpisodeUrls.add(latestEpUrl);
      newAlerts.push({
        id: `${baselineKey}::${latestEpUrl}`,
        animeUrl: fav.url,
        animeTitle: fav.title,
        episodeTitle: latest.episodeTitle,
        episodeLabel: latest.episodeLabel,
        episodeUrl: latest.episodeUrl,
        poster: latest.poster || fav.poster,
        detectedAt: nowIso,
        read: false,
      });
    }
  }

  const nextAlerts = [...newAlerts, ...existingAlerts].slice(0, 40);
  return { newAlerts, nextAlerts, nextBaselines };
}
