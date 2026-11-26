import type { HttpFetcher } from '../../httpTypes.ts';
import type { AnimeEpisodeLink } from '../../types.ts';

const XEM_API_BASE = 'https://thexem.info/map';
const XEM_HAVEMAP_TTL_MS = 3 * 60 * 60 * 1000;
const XEM_MAPPINGS_TTL_MS = 6 * 60 * 60 * 1000;
const XEM_FAILURE_BACKOFF_MS = 5 * 60 * 1000;
const XEM_REQUEST_TIMEOUT_MS = 2500;

export interface XemTuple {
  season: number;
  episode: number;
  absolute: number;
}

export interface XemSceneTvdbMapping {
  tvdb: XemTuple;
  scene: XemTuple;
}

export interface XemSceneAlias {
  tvdbId: number;
  title: string;
  seasonNumber: number;
}

interface XemCacheBucket {
  mappedIds?: { ids: Set<number>; expiresAt: number };
  mappedIdsInFlight?: Promise<Set<number>>;
  mappingsById: Map<number, { value: XemSceneTvdbMapping[]; expiresAt: number }>;
  mappingsInFlight: Map<number, Promise<XemSceneTvdbMapping[]>>;
  aliasesById?: { map: Map<number, XemSceneAlias[]>; expiresAt: number };
  aliasesInFlight?: Promise<Map<number, XemSceneAlias[]>>;
}

let xemCacheByFetcher = new WeakMap<HttpFetcher, XemCacheBucket>();

export function clearXemCaches(): void {
  xemCacheByFetcher = new WeakMap<HttpFetcher, XemCacheBucket>();
}

function getBucket(fetchHttp: HttpFetcher): XemCacheBucket {
  let bucket = xemCacheByFetcher.get(fetchHttp);
  if (!bucket) {
    bucket = {
      mappingsById: new Map(),
      mappingsInFlight: new Map(),
    };
    xemCacheByFetcher.set(fetchHttp, bucket);
  }
  return bucket;
}

function parseXemTuple(raw: unknown): XemTuple | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const season = Number(obj.season ?? 0);
  const episode = Number(obj.episode ?? 0);
  const absolute = Number(obj.absolute ?? 0);
  if (!Number.isFinite(season) || !Number.isFinite(episode) || !Number.isFinite(absolute)) {
    return null;
  }
  return {
    season: Math.trunc(season),
    episode: Math.trunc(episode),
    absolute: Math.trunc(absolute),
  };
}

export function parseXemMappingsPayload(rawBody: string): XemSceneTvdbMapping[] {
  try {
    const parsed = JSON.parse(rawBody) as { result?: string; data?: unknown[] };
    if (!parsed || String(parsed.result || '').toLowerCase() === 'failure' || !Array.isArray(parsed.data)) {
      return [];
    }
    const out: XemSceneTvdbMapping[] = [];
    for (const row of parsed.data) {
      if (!row || typeof row !== 'object') continue;
      const rec = row as Record<string, unknown>;
      const tvdb = parseXemTuple(rec.tvdb);
      const scene = parseXemTuple(rec.scene);
      if (!tvdb || !scene) continue;
      // Ignore all-zero invalid scene mappings and Specials (Season 0)
      if (tvdb.season <= 0 || tvdb.episode <= 0) continue;
      if (scene.season === 0 && scene.episode === 0 && scene.absolute === 0) continue;
      out.push({ tvdb, scene });
    }
    return out;
  } catch {
    return [];
  }
}

export function parseXemAllNamesPayload(rawBody: string): Map<number, XemSceneAlias[]> {
  const result = new Map<number, XemSceneAlias[]>();
  try {
    const parsed = JSON.parse(rawBody) as {
      result?: string;
      data?: Record<string, Array<Record<string, unknown>>>;
    };
    if (!parsed || String(parsed.result || '').toLowerCase() === 'failure' || !parsed.data) {
      return result;
    }
    for (const [rawId, nameObjects] of Object.entries(parsed.data)) {
      const tvdbId = Number.parseInt(rawId, 10);
      if (!Number.isFinite(tvdbId) || tvdbId <= 0 || !Array.isArray(nameObjects)) continue;
      const list: XemSceneAlias[] = [];
      const seen = new Set<string>();
      for (const entry of nameObjects) {
        if (!entry || typeof entry !== 'object') continue;
        for (const [title, rawSeason] of Object.entries(entry)) {
          const seasonNumber = Number.parseInt(String(rawSeason), 10);
          const cleanTitle = title.trim();
          if (!cleanTitle || !Number.isFinite(seasonNumber)) continue;
          // Filter invalid season > 1 alias quirk for Fate/Zero (tvdbId 79151)
          if (tvdbId === 79151 && seasonNumber > 1) continue;
          const dedupeKey = `${seasonNumber}::${cleanTitle.toLowerCase()}`;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          list.push({ tvdbId, title: cleanTitle, seasonNumber });
        }
      }
      if (list.length > 0) {
        result.set(tvdbId, list);
      }
    }
  } catch {
    // ignore malformed payload
  }
  return result;
}

/**
 * Fetches the set of TheTVDB series IDs that have scene/anime mappings on TheXEM.
 * Cached for 3 hours so unmapped series never trigger extra calls.
 */
export async function fetchXemMappedTvdbIds(fetchHttp: HttpFetcher): Promise<Set<number>> {
  const bucket = getBucket(fetchHttp);
  const now = Date.now();
  if (bucket.mappedIds && bucket.mappedIds.expiresAt > now) {
    return bucket.mappedIds.ids;
  }
  if (bucket.mappedIdsInFlight) {
    return bucket.mappedIdsInFlight;
  }

  const req = (async (): Promise<Set<number>> => {
    try {
      const res = await fetchHttp(`${XEM_API_BASE}/havemap?origin=tvdb`, {
        accept: 'application/json',
        timeoutMs: XEM_REQUEST_TIMEOUT_MS,
      });
      if (!res.ok) {
        bucket.mappedIds = { ids: new Set(), expiresAt: Date.now() + XEM_FAILURE_BACKOFF_MS };
        return bucket.mappedIds.ids;
      }
      const parsed = JSON.parse(res.body) as { result?: string; data?: Array<string | number> };
      const ids = new Set<number>();
      if (Array.isArray(parsed?.data)) {
        for (const item of parsed.data) {
          const n = Number.parseInt(String(item), 10);
          if (Number.isFinite(n) && n > 0) ids.add(n);
        }
      }
      bucket.mappedIds = {
        ids,
        expiresAt: Date.now() + (ids.size > 0 ? XEM_HAVEMAP_TTL_MS : XEM_FAILURE_BACKOFF_MS),
      };
      return ids;
    } catch {
      bucket.mappedIds = { ids: new Set(), expiresAt: Date.now() + XEM_FAILURE_BACKOFF_MS };
      return bucket.mappedIds.ids;
    }
  })();

  bucket.mappedIdsInFlight = req;
  try {
    return await req;
  } finally {
    if (bucket.mappedIdsInFlight === req) {
      bucket.mappedIdsInFlight = undefined;
    }
  }
}

/**
 * Fetches TheXEM tvdb <-> scene/streaming episode numbering mappings for a specific TheTVDB ID.
 * Never throws; returns [] if the series is not mapped on TheXEM or the service is unavailable.
 */
export async function fetchXemSceneMappingsForTvdbId(
  fetchHttp: HttpFetcher,
  tvdbId: number,
  options: { skipHaveMapCheck?: boolean } = {}
): Promise<XemSceneTvdbMapping[]> {
  if (!Number.isFinite(tvdbId) || tvdbId <= 0) return [];
  const bucket = getBucket(fetchHttp);
  const now = Date.now();
  const cached = bucket.mappingsById.get(tvdbId);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }
  const inFlight = bucket.mappingsInFlight.get(tvdbId);
  if (inFlight) {
    return inFlight;
  }

  if (!options.skipHaveMapCheck) {
    const mappedIds = await fetchXemMappedTvdbIds(fetchHttp);
    if (mappedIds.size > 0 && !mappedIds.has(tvdbId)) {
      return [];
    }
    if (mappedIds.size === 0) {
      return [];
    }
  }

  const req = (async (): Promise<XemSceneTvdbMapping[]> => {
    try {
      const res = await fetchHttp(
        `${XEM_API_BASE}/all?origin=tvdb&id=${encodeURIComponent(String(tvdbId))}`,
        {
          accept: 'application/json',
          timeoutMs: XEM_REQUEST_TIMEOUT_MS,
        }
      );
      if (!res.ok) {
        bucket.mappingsById.set(tvdbId, {
          value: [],
          expiresAt: Date.now() + XEM_FAILURE_BACKOFF_MS,
        });
        return [];
      }
      const mappings = parseXemMappingsPayload(res.body);
      if (bucket.mappingsById.size > 200) {
        const oldest = bucket.mappingsById.keys().next().value;
        if (oldest !== undefined) bucket.mappingsById.delete(oldest);
      }
      bucket.mappingsById.set(tvdbId, {
        value: mappings,
        expiresAt: Date.now() + XEM_MAPPINGS_TTL_MS,
      });
      return mappings;
    } catch {
      bucket.mappingsById.set(tvdbId, {
        value: [],
        expiresAt: Date.now() + XEM_FAILURE_BACKOFF_MS,
      });
      return [];
    }
  })();

  bucket.mappingsInFlight.set(tvdbId, req);
  try {
    return await req;
  } finally {
    if (bucket.mappingsInFlight.get(tvdbId) === req) {
      bucket.mappingsInFlight.delete(tvdbId);
    }
  }
}

/**
 * Fetches alternate anime/season names registered in TheXEM for a TheTVDB series ID.
 */
export async function fetchXemSceneAliasesForTvdbId(
  fetchHttp: HttpFetcher,
  tvdbId: number
): Promise<XemSceneAlias[]> {
  if (!Number.isFinite(tvdbId) || tvdbId <= 0) return [];
  const bucket = getBucket(fetchHttp);
  const now = Date.now();
  if (bucket.aliasesById && bucket.aliasesById.expiresAt > now) {
    return bucket.aliasesById.map.get(tvdbId) || [];
  }
  if (!bucket.aliasesInFlight) {
    bucket.aliasesInFlight = (async (): Promise<Map<number, XemSceneAlias[]>> => {
      try {
        const res = await fetchHttp(`${XEM_API_BASE}/allNames?origin=tvdb&seasonNumbers=true`, {
          accept: 'application/json',
          timeoutMs: XEM_REQUEST_TIMEOUT_MS,
        });
        if (!res.ok) {
          bucket.aliasesById = {
            map: new Map(),
            expiresAt: Date.now() + XEM_FAILURE_BACKOFF_MS,
          };
          return bucket.aliasesById.map;
        }
        const map = parseXemAllNamesPayload(res.body);
        bucket.aliasesById = {
          map,
          expiresAt: Date.now() + (map.size > 0 ? XEM_HAVEMAP_TTL_MS : XEM_FAILURE_BACKOFF_MS),
        };
        return map;
      } catch {
        bucket.aliasesById = {
          map: new Map(),
          expiresAt: Date.now() + XEM_FAILURE_BACKOFF_MS,
        };
        return bucket.aliasesById.map;
      }
    })();
  }
  try {
    const map = await bucket.aliasesInFlight;
    return map.get(tvdbId) || [];
  } finally {
    bucket.aliasesInFlight = undefined;
  }
}

/**
 * Applies TheXEM scene/anime numbering mappings onto TheTVDB catalog episodes, including
 * offset extrapolation for newly aired episodes beyond the latest mapped episode.
 */
export function applyXemMappingsToEpisodes(
  episodes: readonly AnimeEpisodeLink[],
  mappings: readonly XemSceneTvdbMapping[]
): AnimeEpisodeLink[] {
  if (episodes.length === 0 || mappings.length === 0) {
    return episodes as AnimeEpisodeLink[];
  }

  const mappingByTvdbKey = new Map<string, XemSceneTvdbMapping>();
  const mappingsByTvdbSeason = new Map<number, XemSceneTvdbMapping[]>();
  const mappingsBySceneSeason = new Map<number, XemSceneTvdbMapping[]>();
  const firstTvdbEpBySeason = new Map<number, number>();
  let lastTvdbSeason = 0;
  let lastSceneSeason = 0;

  for (const m of mappings) {
    if (m.tvdb.season <= 0 || m.tvdb.episode <= 0) continue;
    const key = `${m.tvdb.season}:${m.tvdb.episode}`;
    mappingByTvdbKey.set(key, m);

    const tvdbBucket = mappingsByTvdbSeason.get(m.tvdb.season) || [];
    tvdbBucket.push(m);
    mappingsByTvdbSeason.set(m.tvdb.season, tvdbBucket);

    const sceneBucket = mappingsBySceneSeason.get(m.scene.season) || [];
    sceneBucket.push(m);
    mappingsBySceneSeason.set(m.scene.season, sceneBucket);

    const prevFirst = firstTvdbEpBySeason.get(m.tvdb.season);
    if (prevFirst === undefined || m.tvdb.episode < prevFirst) {
      firstTvdbEpBySeason.set(m.tvdb.season, m.tvdb.episode);
    }

    if (m.tvdb.season > lastTvdbSeason) lastTvdbSeason = m.tvdb.season;
    if (m.scene.season > lastSceneSeason) lastSceneSeason = m.scene.season;
  }

  if (mappingByTvdbKey.size === 0) {
    return episodes as AnimeEpisodeLink[];
  }

  // Pass 1: apply direct exact TheXEM mappings
  const mappedSeasons = new Set<number>();
  const next = episodes.map((ep) => {
    const s = ep.seasonNumber || 1;
    const e = ep.episodeNumber;
    if (s <= 0 || !e || e <= 0) return ep;
    const match = mappingByTvdbKey.get(`${s}:${e}`);
    if (!match) return ep;
    mappedSeasons.add(s);
    return {
      ...ep,
      ...(match.tvdb.absolute > 0 && !ep.absoluteNumber
        ? { absoluteNumber: match.tvdb.absolute }
        : {}),
      ...(match.scene.season > 0 ? { sceneSeasonNumber: match.scene.season } : {}),
      ...(match.scene.episode > 0 ? { sceneEpisodeNumber: match.scene.episode } : {}),
      ...(match.scene.absolute > 0 ? { sceneAbsoluteEpisodeNumber: match.scene.absolute } : {}),
    };
  });

  const hasNonSpecialSceneMapping = next.some(
    (ep) => Boolean(ep.sceneEpisodeNumber) && ep.sceneSeasonNumber !== 0
  );
  if (!hasNonSpecialSceneMapping) {
    return next;
  }

  // Pass 2: extrapolate numbering for newer unmapped episodes beyond the latest mapping
  return next.map((ep) => {
    const s = ep.seasonNumber || 1;
    const e = ep.episodeNumber;
    if (s <= 0 || !e || e <= 0 || ep.sceneEpisodeNumber !== undefined) {
      return ep;
    }

    const firstMappedInSeason = firstTvdbEpBySeason.get(s);
    const isUnverifiedCandidate =
      (mappedSeasons.has(s) && firstMappedInSeason !== undefined && e >= firstMappedInSeason) ||
      (lastSceneSeason !== lastTvdbSeason && s > lastTvdbSeason);

    if (!isUnverifiedCandidate || s < lastTvdbSeason) {
      return ep;
    }

    const seasonMappings = mappingsByTvdbSeason.get(s) || [];
    if (seasonMappings.some((m) => m.tvdb.episode >= e)) {
      return ep;
    }

    if (seasonMappings.length > 0) {
      const lastEpMapping = [...seasonMappings].sort((a, b) => a.tvdb.episode - b.tvdb.episode)[
        seasonMappings.length - 1
      ];
      const sceneSeasonList = mappingsBySceneSeason.get(lastEpMapping.scene.season) || [];
      const lastSceneMapping = [...sceneSeasonList].sort(
        (a, b) => a.scene.episode - b.scene.episode
      )[sceneSeasonList.length - 1];
      if (!lastSceneMapping || lastSceneMapping.tvdb.season === 0) {
        return ep;
      }

      const offset = e - lastEpMapping.tvdb.episode;
      return {
        ...ep,
        ...(lastEpMapping.scene.season > 0
          ? { sceneSeasonNumber: lastEpMapping.scene.season }
          : {}),
        sceneEpisodeNumber: lastEpMapping.scene.episode + offset,
        ...(lastEpMapping.scene.absolute > 0
          ? { sceneAbsoluteEpisodeNumber: lastEpMapping.scene.absolute + offset }
          : {}),
      };
    }

    if (lastTvdbSeason !== lastSceneSeason) {
      const seasonOffset = s - lastTvdbSeason;
      return {
        ...ep,
        sceneSeasonNumber: lastSceneSeason + seasonOffset,
        sceneEpisodeNumber: e,
      };
    }

    return ep;
  });
}
