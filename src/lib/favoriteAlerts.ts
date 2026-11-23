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

function findMatchingReleasesForFavorite(
  favorite: CatalogMediaItem,
  releases: CatalogMediaItem[]
): FavoriteLatestInfo[] {
  const favSlug = extractMediaSlug(favorite.url);
  const favTitleNorm = cleanEpisodeSeriesTitle(favorite.title).toLowerCase();

  const matches: FavoriteLatestInfo[] = [];
  const seenUrls = new Set<string>();
  for (const rel of releases) {
    const relSlug = extractMediaSlug(rel.url);
    const relTitleNorm = cleanEpisodeSeriesTitle(rel.title).toLowerCase();
    const matchesSlug = Boolean(favSlug && relSlug && favSlug === relSlug);
    const matchesTitle = Boolean(favTitleNorm && relTitleNorm && favTitleNorm === relTitleNorm);
    if (!matchesSlug && !matchesTitle) continue;

    const normUrl = normalizeTopAnimesUrl(rel.url);
    if (seenUrls.has(normUrl)) continue;
    seenUrls.add(normUrl);

    const epNum =
      extractEpisodeNumber(rel.episodeLabel || '') ??
      extractEpisodeNumber(rel.title) ??
      extractEpisodeNumber(rel.url);

    matches.push({
      episodeUrl: normUrl,
      episodeTitle: rel.episodeLabel
        ? `${cleanEpisodeSeriesTitle(rel.title)} — ${rel.episodeLabel}`
        : rel.title,
      episodeLabel: rel.episodeLabel || (epNum !== null ? `EP ${epNum}` : 'Novo episódio'),
      episodeNumber: epNum,
      poster: rel.poster || favorite.poster,
      audioType: rel.audioType ?? favorite.audioType ?? null,
      sourceServerName: rel.sourceServerName || favorite.sourceServerName,
    });
  }

  return matches.sort((a, b) => {
    if (a.episodeNumber !== null && b.episodeNumber !== null) {
      return b.episodeNumber - a.episodeNumber;
    }
    if (b.episodeNumber !== null) return 1;
    if (a.episodeNumber !== null) return -1;
    return 0;
  });
}

function findLatestReleaseForFavorite(
  favorite: CatalogMediaItem,
  releases: CatalogMediaItem[]
): FavoriteLatestInfo | null {
  const matches = findMatchingReleasesForFavorite(favorite, releases);
  return matches[0] || null;
}

export function pickLatestAnimeEpisode(
  episodes: Array<{
    numberLabel: string;
    episodeNumber: number | null;
    seasonNumber?: number;
    title: string;
    url: string;
    thumb?: string;
    availableOnServer?: boolean;
  }>,
  seriesTitle: string,
  fallbackPoster: string,
  meta?: { audioType?: CatalogMediaItem['audioType']; sourceServerName?: string }
): FavoriteLatestInfo | null {
  const recent = pickRecentAnimeEpisodes(episodes, seriesTitle, fallbackPoster, 5, meta);
  if (recent.length === 0) return null;
  const top = recent[0];
  return {
    ...top,
    recentEpisodes: recent,
  };
}

export function pickRecentAnimeEpisodes(
  episodes: Array<{
    numberLabel: string;
    episodeNumber: number | null;
    seasonNumber?: number;
    title: string;
    url: string;
    thumb?: string;
    availableOnServer?: boolean;
  }>,
  seriesTitle: string,
  fallbackPoster: string,
  limit = 5,
  meta?: { audioType?: CatalogMediaItem['audioType']; sourceServerName?: string }
): FavoriteLatestInfo[] {
  const playableEpisodes = episodes.filter((ep) => ep.availableOnServer !== false);
  if (!playableEpisodes.length) return [];
  const mapped: Array<{ info: FavoriteLatestInfo; seasonNumber: number; orderIndex: number }> =
    playableEpisodes.map((ep, idx) => {
      const num = ep.episodeNumber ?? extractEpisodeNumber(ep.url) ?? extractEpisodeNumber(ep.title);
      const seasonNum =
        ep.seasonNumber && Number.isFinite(ep.seasonNumber) && ep.seasonNumber > 0
          ? ep.seasonNumber
          : 1;
      const formattedLabel =
        num !== null
          ? seasonNum > 1
            ? `T${seasonNum} · EP ${num}`
            : `EP ${num}`
          : ep.numberLabel || ep.title;
      return {
        seasonNumber: seasonNum,
        orderIndex: idx,
        info: {
          episodeUrl: normalizeTopAnimesUrl(ep.url),
          episodeTitle: `${seriesTitle} — ${ep.title}`,
          episodeLabel: formattedLabel,
          episodeNumber: num,
          poster: ep.thumb || fallbackPoster,
          audioType: meta?.audioType ?? null,
          sourceServerName: meta?.sourceServerName,
        },
      };
    });

  mapped.sort((a, b) => {
    if (a.seasonNumber !== b.seasonNumber) {
      return b.seasonNumber - a.seasonNumber;
    }
    if (a.info.episodeNumber !== null && b.info.episodeNumber !== null) {
      return b.info.episodeNumber - a.info.episodeNumber;
    }
    if (b.info.episodeNumber !== null) return 1;
    if (a.info.episodeNumber !== null) return -1;
    return b.orderIndex - a.orderIndex;
  });

  const seen = new Set<string>();
  const out: FavoriteLatestInfo[] = [];
  for (const entry of mapped) {
    if (seen.has(entry.info.episodeUrl)) continue;
    seen.add(entry.info.episodeUrl);
    out.push(entry.info);
    if (out.length >= limit) break;
  }
  return out;
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

function isFavoriteEntryMuted(favorite: CatalogMediaItem, mutedFavoriteUrls?: string[]): boolean {
  if (!mutedFavoriteUrls || mutedFavoriteUrls.length === 0) return false;
  const favNorm = normalizeTopAnimesUrl(favorite.url);
  const favSlug = extractMediaSlug(favorite.url);
  return mutedFavoriteUrls.some((entry) => {
    if (normalizeTopAnimesUrl(entry) === favNorm) return true;
    const slug = extractMediaSlug(entry);
    return Boolean(favSlug && slug && slug === favSlug);
  });
}

function matchesAudioNotificationFilter(
  candidateAudio: CatalogMediaItem['audioType'] | undefined,
  favoriteAudio: CatalogMediaItem['audioType'] | undefined,
  filter?: 'ALL' | 'DUB' | 'LEG'
): boolean {
  if (!filter || filter === 'ALL') return true;
  const effective = candidateAudio ?? favoriteAudio ?? null;
  if (!effective) return true;
  return effective === filter;
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
  mutedFavoriteUrls?: string[];
  notifyAudioFilter?: 'ALL' | 'DUB' | 'LEG';
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
    mutedFavoriteUrls,
    notifyAudioFilter = 'ALL',
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
    const matchingReleases = findMatchingReleasesForFavorite(fav, releases);

    // Collect all candidate episodes from both /api/favorites/check (including recentEpisodes) and releases feed
    const candidateMap = new Map<string, FavoriteLatestInfo>();
    const addCandidate = (cand: FavoriteLatestInfo | null | undefined) => {
      if (!cand?.episodeUrl) return;
      const normEpUrl = normalizeTopAnimesUrl(cand.episodeUrl);
      if (!candidateMap.has(normEpUrl)) {
        candidateMap.set(normEpUrl, {
          ...cand,
          episodeUrl: normEpUrl,
          audioType: cand.audioType ?? fav.audioType ?? null,
          sourceServerName: cand.sourceServerName || fav.sourceServerName,
        });
      }
    };

    if (fromCheck) {
      addCandidate(fromCheck);
      if (Array.isArray(fromCheck.recentEpisodes)) {
        for (const recent of fromCheck.recentEpisodes) {
          addCandidate(recent);
        }
      }
    }
    for (const rel of matchingReleases) {
      addCandidate(rel);
    }

    const candidates = Array.from(candidateMap.values()).sort((a, b) => {
      if (a.episodeNumber !== null && b.episodeNumber !== null) {
        return b.episodeNumber - a.episodeNumber;
      }
      if (b.episodeNumber !== null) return 1;
      if (a.episodeNumber !== null) return -1;
      return 0;
    });

    const latest = candidates[0] || null;
    if (!latest) continue;

    const latestEpUrl = normalizeTopAnimesUrl(latest.episodeUrl);
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

    const isLatestOlderOrEqual =
      latest.episodeNumber !== null &&
      existingBaseline.lastEpisodeNumber !== null &&
      latest.episodeNumber <= existingBaseline.lastEpisodeNumber;

    if (isLatestOlderOrEqual) continue;

    // Advance baseline to the newest detected episode
    nextBaselines[baselineKey] = {
      lastEpisodeUrl: latestEpUrl,
      lastEpisodeNumber: latest.episodeNumber,
      updatedAt: nowIso,
    };

    // If this anime is muted by the user, advance baseline silently without creating alerts
    if (isFavoriteEntryMuted(fav, mutedFavoriteUrls)) {
      continue;
    }

    // Collect every candidate episode strictly newer than the previous baseline (capped at 5 per anime)
    const newerCandidates = candidates
      .filter((cand) => {
        const candUrl = normalizeTopAnimesUrl(cand.episodeUrl);
        if (candUrl === baselineUrl) return false;
        if (
          cand.episodeNumber !== null &&
          existingBaseline.lastEpisodeNumber !== null
        ) {
          return cand.episodeNumber > existingBaseline.lastEpisodeNumber;
        }
        return candUrl === latestEpUrl;
      })
      .slice(0, 5);

    for (const cand of newerCandidates) {
      const candEpUrl = normalizeTopAnimesUrl(cand.episodeUrl);
      const candCanonicalKey = canonicalEpisodeKey(cand.episodeUrl);
      const alreadyWatched = Boolean(
        watchedEpisodeKeys &&
          (watchedEpisodeKeys.has(candCanonicalKey) ||
            watchedEpisodeKeys.has(candEpUrl) ||
            watchedEpisodeKeys.has(cand.episodeUrl))
      );
      if (alreadyWatched) continue;

      if (!matchesAudioNotificationFilter(cand.audioType, fav.audioType, notifyAudioFilter)) {
        continue;
      }

      if (!existingEpisodeUrls.has(candEpUrl)) {
        existingEpisodeUrls.add(candEpUrl);
        newAlerts.push({
          id: `${baselineKey}::${candEpUrl}`,
          animeUrl: fav.url,
          animeTitle: fav.title,
          episodeTitle: cand.episodeTitle,
          episodeLabel: cand.episodeLabel,
          episodeUrl: cand.episodeUrl,
          poster: cand.poster || fav.poster,
          detectedAt: nowIso,
          read: false,
          audioType: cand.audioType ?? fav.audioType ?? null,
          sourceServerName: cand.sourceServerName || fav.sourceServerName,
        });
      }
    }
  }

  const nextAlerts = [...newAlerts, ...existingAlerts].slice(0, 60);
  return { newAlerts, nextAlerts, nextBaselines };
}
