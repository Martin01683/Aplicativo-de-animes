import type { HttpFetcher } from '../httpTypes.ts';
import { HINATASOUL_BUILTIN_SOURCE, TOPANIMES_BUILTIN_SOURCE } from '../sources/types.ts';
import type {
  AudioType,
  DiscoverAudioFilter,
  MediaKind,
  ProviderAvailabilityInfo,
} from '../types.ts';
import { isHinataSoulUrl, normalizeHinataSoulUrl, normalizeTopAnimesUrl } from '../urlSafety.ts';
import {
  expandTitleVariantsForMatch,
  normalizeTitleForMatch,
  scoreTitleSimilarity,
  stripSeasonFromTitle,
} from './idCodec.ts';

export interface SitemapUrlEntry {
  loc: string;
  lastmod?: string;
}

export interface ParsedProviderSlugEntry {
  url: string;
  slug: string;
  displayTitle: string;
  normalizedTitle: string;
  baseNormalizedTitle: string;
  kind: 'anime' | 'movie' | 'series';
  audioType: 'LEG' | 'DUB';
  providerName: string;
}

export interface ProviderIndexRecord {
  key: string;
  normalizedTitle: string;
  baseNormalizedTitle: string;
  displayTitle: string;
  kind: 'anime' | 'movie' | 'series';
  legUrl?: string;
  dubUrl?: string;
  providerNames: string[];
  tokens: string[];
}

export interface ProviderIndexStats {
  totalEntries: number;
  sitemapEntries: number;
  passiveEntries: number;
  sourceMode: 'live' | 'cache' | 'passive';
  loadedAtMs: number;
}

const INDEX_TTL_MS = 24 * 60 * 60 * 1000;
const STORAGE_KEY = 'anisync:provider_index:v1';
const DEFAULT_DELAY_MS = 140;
const DEFAULT_MAX_TVSHOW_PAGES = 20;
const DEFAULT_MAX_MOVIE_PAGES = 4;

const STOP_TOKENS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'into',
  'that',
  'this',
  'your',
  'you',
  'our',
  'are',
  'was',
  'were',
  'have',
  'has',
  'had',
  'not',
  'but',
  'all',
  'can',
  'will',
  'just',
  'more',
  'one',
  'two',
  'new',
  'anime',
  'movie',
  'filme',
  'series',
  'part',
  'season',
  'temporada',
  'ova',
  'ona',
  'special',
  'no',
  'wa',
  'wo',
  'ga',
  'ni',
  'de',
  'to',
  'ka',
  'na',
  'da',
]);

function decodeXmlEntities(raw: string): string {
  return raw
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();
}

/**
 * Parses standard XML sitemaps (<url><loc>...</loc><lastmod>...</lastmod></url>)
 * without requiring a DOM parser so it runs identically in Node and browsers.
 */
export function parseSitemapXmlEntries(xml: string): SitemapUrlEntry[] {
  if (!xml || typeof xml !== 'string') return [];
  const entries: SitemapUrlEntry[] = [];
  const urlBlockRe = /<url\b[^>]*>([\s\S]*?)<\/url>/gi;
  let match: RegExpExecArray | null;

  while ((match = urlBlockRe.exec(xml)) !== null) {
    const block = match[1];
    const locMatch = block.match(/<loc\b[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/loc>/i);
    if (!locMatch?.[1]) continue;
    const loc = decodeXmlEntities(locMatch[1]);
    if (!loc || !/^https?:\/\//i.test(loc)) continue;
    const lastmodMatch = block.match(
      /<lastmod\b[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/lastmod>/i
    );
    const lastmod = lastmodMatch?.[1] ? decodeXmlEntities(lastmodMatch[1]) : undefined;
    entries.push({ loc, lastmod });
  }

  return entries;
}

/**
 * Extracts title, media kind, and LEG/DUB audio variant from a TopAnimes sitemap URL.
 * Returns null for root archive URLs (/animes/, /filmes/) or episode URLs.
 */
export function parseTopAnimesSitemapUrl(
  loc: string,
  providerName = TOPANIMES_BUILTIN_SOURCE.name
): ParsedProviderSlugEntry | null {
  const normalizedUrl = normalizeTopAnimesUrl(loc);
  if (!normalizedUrl) return null;

  let pathname: string;
  try {
    pathname = new URL(normalizedUrl).pathname;
  } catch {
    return null;
  }

  const m = pathname.match(/^\/(animes|filmes)\/([^/]+)\/?$/i);
  if (!m) return null;

  const section = m[1].toLowerCase();
  const rawSlug = decodeURIComponent(m[2]).trim().toLowerCase();
  if (!rawSlug || rawSlug === 'page') return null;

  let audioType: 'LEG' | 'DUB' = 'LEG';
  let cleanSlug = rawSlug;

  if (/(?:-dublado(?:-pt-br)?|-dub-pt-br|-dub)$/i.test(cleanSlug)) {
    audioType = 'DUB';
    cleanSlug = cleanSlug.replace(/(?:-dublado(?:-pt-br)?|-dub-pt-br|-dub)+$/i, '');
  } else if (/(?:-dub-japones|-legendado|-leg)$/i.test(cleanSlug)) {
    audioType = 'LEG';
    cleanSlug = cleanSlug.replace(/(?:-dub-japones|-legendado|-leg)+$/i, '');
  }

  cleanSlug = cleanSlug.replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!cleanSlug || cleanSlug.length < 2) return null;

  const displayTitle = cleanSlug
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

  const normalizedTitle = normalizeTitleForMatch(displayTitle);
  if (!normalizedTitle) return null;

  const baseStripped = stripSeasonFromTitle(displayTitle);
  const baseNormalizedTitle = normalizeTitleForMatch(baseStripped) || normalizedTitle;

  return {
    url: normalizedUrl,
    slug: cleanSlug,
    displayTitle,
    normalizedTitle,
    baseNormalizedTitle,
    kind: section === 'filmes' ? 'movie' : 'anime',
    audioType,
    providerName,
  };
}

function extractSignificantTokens(normalizedTitle: string): string[] {
  const raw = normalizedTitle.split(' ').filter(Boolean);
  const significant = raw.filter((t) => t.length >= 3 && !STOP_TOKENS.has(t));
  if (significant.length > 0) return Array.from(new Set(significant));
  return Array.from(new Set(raw.filter((t) => t.length >= 2)));
}

function sleepMs(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLocalStorageUsable(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage !== null;
  } catch {
    return false;
  }
}

interface PersistedIndexPayload {
  v: 1;
  loadedAtMs: number;
  entries: Array<{
    t: string;
    k: 'a' | 'm' | 's';
    l?: string;
    d?: string;
    p: string[];
  }>;
}

class ProviderAvailabilityIndexStore {
  private readonly recordsByKey = new Map<string, ProviderIndexRecord>();
  private readonly exactLookup = new Map<string, string[]>();
  private readonly baseLookup = new Map<string, string[]>();
  private readonly tokenLookup = new Map<string, Set<string>>();

  private loadedAtMs = 0;
  private sitemapEntriesCount = 0;
  private passiveEntriesCount = 0;
  private sourceMode: 'live' | 'cache' | 'passive' = 'passive';
  private inFlightLoad: Promise<ProviderIndexStats> | null = null;
  private hydratedFromStorage = false;

  private addToMultiMap(map: Map<string, string[]>, key: string, recordKey: string): void {
    if (!key) return;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, [recordKey]);
      return;
    }
    if (!existing.includes(recordKey)) {
      existing.push(recordKey);
    }
  }

  upsertEntry(entry: {
    displayTitle: string;
    url: string;
    kind: 'anime' | 'movie' | 'series';
    audioType: 'LEG' | 'DUB';
    providerName: string;
    origin?: 'sitemap' | 'passive';
  }): boolean {
    const normalizedTitle = normalizeTitleForMatch(entry.displayTitle);
    if (!normalizedTitle || normalizedTitle.length < 2) return false;

    const stripped = stripSeasonFromTitle(entry.displayTitle);
    const baseNormalizedTitle = normalizeTitleForMatch(stripped) || normalizedTitle;
    const recordKey = `${entry.kind}:${normalizedTitle}`;

    let rec = this.recordsByKey.get(recordKey);
    let isNew = false;
    if (!rec) {
      isNew = true;
      const tokens = extractSignificantTokens(normalizedTitle);
      rec = {
        key: recordKey,
        normalizedTitle,
        baseNormalizedTitle,
        displayTitle: entry.displayTitle.trim(),
        kind: entry.kind,
        providerNames: [],
        tokens,
      };
      this.recordsByKey.set(recordKey, rec);
      this.addToMultiMap(this.exactLookup, normalizedTitle, recordKey);
      if (baseNormalizedTitle.length >= 4) {
        this.addToMultiMap(this.baseLookup, baseNormalizedTitle, recordKey);
      }
      for (const token of tokens) {
        let bucket = this.tokenLookup.get(token);
        if (!bucket) {
          bucket = new Set();
          this.tokenLookup.set(token, bucket);
        }
        bucket.add(recordKey);
      }
    }

    if (entry.audioType === 'DUB') {
      if (!rec.dubUrl || entry.providerName === TOPANIMES_BUILTIN_SOURCE.name) {
        rec.dubUrl = entry.url;
      }
    } else {
      if (!rec.legUrl || entry.providerName === TOPANIMES_BUILTIN_SOURCE.name) {
        rec.legUrl = entry.url;
      }
    }

    if (entry.providerName && !rec.providerNames.includes(entry.providerName)) {
      rec.providerNames.push(entry.providerName);
    }

    if (isNew) {
      if (entry.origin === 'sitemap') this.sitemapEntriesCount += 1;
      else this.passiveEntriesCount += 1;
    }

    return isNew;
  }

  hydrateFromLocalStorageOnce(): void {
    if (this.hydratedFromStorage) return;
    this.hydratedFromStorage = true;
    if (!isLocalStorageUsable()) return;

    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<PersistedIndexPayload>;
      if (
        !parsed ||
        parsed.v !== 1 ||
        typeof parsed.loadedAtMs !== 'number' ||
        !Array.isArray(parsed.entries)
      ) {
        return;
      }
      if (Date.now() - parsed.loadedAtMs > INDEX_TTL_MS) {
        localStorage.removeItem(STORAGE_KEY);
        return;
      }

      for (const item of parsed.entries) {
        const kind: 'anime' | 'movie' | 'series' =
          item.k === 'm' ? 'movie' : item.k === 's' ? 'series' : 'anime';
        const primaryProvider = item.p?.[0] || TOPANIMES_BUILTIN_SOURCE.name;
        if (item.l) {
          this.upsertEntry({
            displayTitle: item.t,
            url: item.l,
            kind,
            audioType: 'LEG',
            providerName: primaryProvider,
            origin: 'sitemap',
          });
        }
        if (item.d) {
          this.upsertEntry({
            displayTitle: item.t,
            url: item.d,
            kind,
            audioType: 'DUB',
            providerName: primaryProvider,
            origin: 'sitemap',
          });
        }
      }

      if (parsed.entries.length > 0) {
        this.loadedAtMs = parsed.loadedAtMs;
        this.sourceMode = 'cache';
      }
    } catch {
      // Ignore corrupt storage entries cleanly
    }
  }

  private persistToLocalStorage(): void {
    if (!isLocalStorageUsable() || this.recordsByKey.size === 0) return;
    try {
      const entries: PersistedIndexPayload['entries'] = [];
      for (const rec of this.recordsByKey.values()) {
        entries.push({
          t: rec.displayTitle,
          k: rec.kind === 'movie' ? 'm' : rec.kind === 'series' ? 's' : 'a',
          ...(rec.legUrl ? { l: rec.legUrl } : {}),
          ...(rec.dubUrl ? { d: rec.dubUrl } : {}),
          p: rec.providerNames,
        });
      }
      const payload: PersistedIndexPayload = {
        v: 1,
        loadedAtMs: this.loadedAtMs,
        entries,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Ignore quota exceeded
    }
  }

  getStats(): ProviderIndexStats {
    return {
      totalEntries: this.recordsByKey.size,
      sitemapEntries: this.sitemapEntriesCount,
      passiveEntries: this.passiveEntriesCount,
      sourceMode: this.sourceMode,
      loadedAtMs: this.loadedAtMs,
    };
  }

  isFresh(): boolean {
    return this.loadedAtMs > 0 && Date.now() - this.loadedAtMs < INDEX_TTL_MS && this.sitemapEntriesCount > 0;
  }

  async ensureLoaded(
    fetchHttp: HttpFetcher,
    options: {
      forceRefresh?: boolean;
      delayMs?: number;
      maxTvShowPages?: number;
      maxMoviePages?: number;
    } = {}
  ): Promise<ProviderIndexStats> {
    this.hydrateFromLocalStorageOnce();

    if (!options.forceRefresh && this.isFresh()) {
      return this.getStats();
    }
    if (this.inFlightLoad && !options.forceRefresh) {
      return this.inFlightLoad;
    }

    const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
    const maxTvShowPages = options.maxTvShowPages ?? DEFAULT_MAX_TVSHOW_PAGES;
    const maxMoviePages = options.maxMoviePages ?? DEFAULT_MAX_MOVIE_PAGES;
    const origin = TOPANIMES_BUILTIN_SOURCE.baseUrl.replace(/\/+$/, '');

    const task = (async (): Promise<ProviderIndexStats> => {
      let fetchedCount = 0;
      let rateLimited = false;

      const fetchSitemapFile = async (sitemapPath: string): Promise<SitemapUrlEntry[] | 'stop' | 'rate-limited'> => {
        try {
          const res = await fetchHttp(`${origin}/${sitemapPath}`, {
            referer: `${origin}/`,
            accept: 'application/xml,text/xml,*/*;q=0.8',
            timeoutMs: 10000,
          });
          if (res.status === 429 || res.status === 503) {
            return 'rate-limited';
          }
          if (!res.ok || !res.body) {
            return 'stop';
          }
          const entries = parseSitemapXmlEntries(res.body);
          if (entries.length === 0) return 'stop';
          return entries;
        } catch {
          return 'stop';
        }
      };

      // 1. Sequential polite indexing of TopAnimes TV shows (animes) sitemaps
      for (let page = 1; page <= maxTvShowPages; page += 1) {
        if (page > 1 && delayMs > 0) {
          await sleepMs(delayMs);
        }
        const path = `tvshows-sitemap${page}.xml`;
        const result = await fetchSitemapFile(path);
        if (result === 'rate-limited') {
          rateLimited = true;
          break;
        }
        if (result === 'stop') {
          // Fallback once on page 1 to unnumbered tvshows-sitemap.xml
          if (page === 1) {
            const fallback = await fetchSitemapFile('tvshows-sitemap.xml');
            if (Array.isArray(fallback)) {
              for (const entry of fallback) {
                const parsed = parseTopAnimesSitemapUrl(entry.loc);
                if (parsed) {
                  this.upsertEntry({ ...parsed, origin: 'sitemap' });
                  fetchedCount += 1;
                }
              }
            }
          }
          break;
        }

        for (const entry of result) {
          const parsed = parseTopAnimesSitemapUrl(entry.loc);
          if (parsed) {
            this.upsertEntry({ ...parsed, origin: 'sitemap' });
            fetchedCount += 1;
          }
        }

        // RankMath emits 200 URLs per full sitemap chunk; fewer than 180 signals the last page
        if (result.length < 180) {
          break;
        }
      }

      // 2. Sequential polite indexing of TopAnimes movies sitemap(s)
      if (!rateLimited) {
        for (let page = 1; page <= maxMoviePages; page += 1) {
          if (delayMs > 0) {
            await sleepMs(delayMs);
          }
          const path = page === 1 ? 'movies-sitemap.xml' : `movies-sitemap${page}.xml`;
          const result = await fetchSitemapFile(path);
          if (result === 'rate-limited' || result === 'stop') {
            break;
          }
          for (const entry of result) {
            const parsed = parseTopAnimesSitemapUrl(entry.loc);
            if (parsed) {
              this.upsertEntry({ ...parsed, origin: 'sitemap' });
              fetchedCount += 1;
            }
          }
          if (result.length < 180) {
            break;
          }
        }
      }

      if (fetchedCount > 0) {
        this.loadedAtMs = Date.now();
        this.sourceMode = 'live';
        this.persistToLocalStorage();
      } else if (this.recordsByKey.size > 0 && this.loadedAtMs === 0) {
        this.sourceMode = 'passive';
      }

      return this.getStats();
    })();

    this.inFlightLoad = task;
    try {
      return await task;
    } finally {
      if (this.inFlightLoad === task) {
        this.inFlightLoad = null;
      }
    }
  }

  registerPassiveItems(
    items: ReadonlyArray<{
      title: string;
      url: string;
      kind?: MediaKind;
      audioType?: AudioType;
      sourceServerName?: string;
    }>
  ): number {
    let added = 0;
    for (const item of items) {
      if (!item?.url || !item?.title) continue;
      if (item.kind === 'episode') continue;
      if (/\/(?:episodio|videos)\//i.test(item.url)) continue;

      const isHs = isHinataSoulUrl(item.url);
      const cleanUrl = isHs
        ? normalizeHinataSoulUrl(item.url)
        : normalizeTopAnimesUrl(item.url);
      if (!cleanUrl) continue;

      const providerName =
        item.sourceServerName ||
        (isHs ? HINATASOUL_BUILTIN_SOURCE.name : TOPANIMES_BUILTIN_SOURCE.name);

      const inferredKind: 'anime' | 'movie' | 'series' =
        item.kind === 'movie' || /\/filmes\//i.test(cleanUrl)
          ? 'movie'
          : item.kind === 'series' || /\/(?:doramas|tokusatsus)\//i.test(cleanUrl)
            ? 'series'
            : 'anime';

      const inferredAudio: 'LEG' | 'DUB' =
        item.audioType === 'DUB' ||
        /\bdublado\b|\bdub\b/i.test(item.title) ||
        /-dublado(?:\/|$)/i.test(cleanUrl)
          ? 'DUB'
          : 'LEG';

      // Clean trailing "(Dublado)" / "Dublado" from display title before indexing
      const displayTitle = item.title
        .replace(/\s*\((?:dublado|legendado|dub|leg)\)\s*/gi, ' ')
        .replace(/\s*[-–—]\s*(?:dublado|legendado)\s*$/i, '')
        .replace(/\s+\b(?:dublado|legendado)\b$/i, '')
        .replace(/\s+/g, ' ')
        .trim();

      if (!displayTitle) continue;

      if (
        this.upsertEntry({
          displayTitle,
          url: cleanUrl,
          kind: inferredKind,
          audioType: inferredAudio,
          providerName,
          origin: 'passive',
        })
      ) {
        added += 1;
      }
    }
    return added;
  }

  matchTitles(query: {
    titles: readonly string[];
    mediaKind?: 'anime' | 'movie' | 'series';
    audioFilter?: DiscoverAudioFilter;
    allowSeasonStripFallback?: boolean;
  }): ProviderAvailabilityInfo {
    this.hydrateFromLocalStorageOnce();

    const preferredKind = query.mediaKind || 'anime';
    const allowSeasonFallback = query.allowSeasonStripFallback !== false;

    const expandedTitles: string[] = [];
    const seenRaw = new Set<string>();
    for (const raw of query.titles) {
      if (!raw || typeof raw !== 'string') continue;
      for (const variant of expandTitleVariantsForMatch(raw)) {
        const key = variant.toLowerCase();
        if (seenRaw.has(key)) continue;
        seenRaw.add(key);
        expandedTitles.push(variant);
      }
    }

    const normalizedCandidates: string[] = [];
    const baseCandidates: string[] = [];
    const seenNorm = new Set<string>();
    const seenBase = new Set<string>();

    for (const title of expandedTitles) {
      const norm = normalizeTitleForMatch(title);
      if (norm && norm.length >= 2 && !seenNorm.has(norm)) {
        seenNorm.add(norm);
        normalizedCandidates.push(norm);
      }
      if (allowSeasonFallback) {
        const stripped = stripSeasonFromTitle(title);
        const baseNorm = normalizeTitleForMatch(stripped);
        if (baseNorm && baseNorm.length >= 4 && !seenBase.has(baseNorm)) {
          seenBase.add(baseNorm);
          baseCandidates.push(baseNorm);
        }
        // Also try clause before colon for subtitle-heavy sequel names (e.g. "Bleach: Sennen Kessen-hen")
        const beforeColon = title.split(/\s*[:–—]\s*/)[0]?.trim() || '';
        const colonNorm = normalizeTitleForMatch(beforeColon);
        if (colonNorm && colonNorm.length >= 6 && !seenBase.has(colonNorm)) {
          seenBase.add(colonNorm);
          baseCandidates.push(colonNorm);
        }
      }
    }

    const collectRecords = (keys: string[] | undefined): ProviderIndexRecord[] => {
      if (!keys?.length) return [];
      const out: ProviderIndexRecord[] = [];
      for (const k of keys) {
        const r = this.recordsByKey.get(k);
        if (r) out.push(r);
      }
      return out;
    };

    const pickByKind = (records: ProviderIndexRecord[]): ProviderIndexRecord[] => {
      if (records.length <= 1) return records;
      const sameKind = records.filter((r) => r.kind === preferredKind);
      return sameKind.length > 0 ? sameKind : records;
    };

    const buildResult = (matchedRecords: ProviderIndexRecord[]): ProviderAvailabilityInfo => {
      const filtered = pickByKind(matchedRecords);
      let legUrl: string | undefined;
      let dubUrl: string | undefined;
      const providerNames = new Set<string>();
      let matchedTitle: string | undefined;

      for (const rec of filtered) {
        if (!matchedTitle) matchedTitle = rec.displayTitle;
        if (!legUrl && rec.legUrl) legUrl = rec.legUrl;
        if (!dubUrl && rec.dubUrl) dubUrl = rec.dubUrl;
        for (const p of rec.providerNames) providerNames.add(p);
      }

      const hasLeg = Boolean(legUrl);
      const hasDub = Boolean(dubUrl);
      const audioFilter = query.audioFilter || 'ALL';
      const available =
        audioFilter === 'DUB'
          ? hasDub
          : audioFilter === 'LEG'
            ? hasLeg
            : hasLeg || hasDub;

      return {
        available,
        hasLeg,
        hasDub,
        legUrl,
        dubUrl,
        providerNames: Array.from(providerNames),
        matchedTitle,
      };
    };

    // Pass 1: Exact normalized title match (O(1))
    const exactHits: ProviderIndexRecord[] = [];
    for (const norm of normalizedCandidates) {
      exactHits.push(...collectRecords(this.exactLookup.get(norm)));
    }
    if (exactHits.length > 0) {
      return buildResult(exactHits);
    }

    // Pass 2: Season-stripped base title match (matches AniList sequel seasons to unified series pages)
    if (allowSeasonFallback) {
      const baseHits: ProviderIndexRecord[] = [];
      for (const base of baseCandidates) {
        baseHits.push(...collectRecords(this.exactLookup.get(base)));
        baseHits.push(...collectRecords(this.baseLookup.get(base)));
      }
      if (baseHits.length > 0) {
        // For movies, do NOT loosely match a movie title to an anime TV series unless exact
        const usable =
          preferredKind === 'movie'
            ? baseHits.filter((r) => r.kind === 'movie')
            : baseHits;
        if (usable.length > 0) {
          return buildResult(usable);
        }
      }
    }

    // Pass 3: High-precision token-indexed similarity match (catches punctuation/romanization drift like "Frieren" vs "Sousou no Frieren")
    const candidateKeys = new Set<string>();
    for (const norm of normalizedCandidates) {
      const tokens = extractSignificantTokens(norm);
      for (const tok of tokens) {
        const bucket = this.tokenLookup.get(tok);
        if (!bucket) continue;
        // Skip ultra-common tokens to stay fast and avoid noise
        if (bucket.size > 120) continue;
        for (const rk of bucket) {
          candidateKeys.add(rk);
        }
      }
    }

    let bestScore = 0;
    let bestRecord: ProviderIndexRecord | null = null;

    for (const rk of candidateKeys) {
      const rec = this.recordsByKey.get(rk);
      if (!rec) continue;
      if (preferredKind === 'movie' && rec.kind !== 'movie') continue;

      for (const norm of normalizedCandidates) {
        if (norm.length < 4 || rec.normalizedTitle.length < 4) continue;
        const sim = scoreTitleSimilarity(norm, rec.normalizedTitle);
        if (sim < 0.87) continue;

        // Guard against short single-token substring collisions (e.g. "monster" vs "monster rancher")
        const aToks = extractSignificantTokens(norm);
        const bToks = rec.tokens;
        const shared = aToks.filter((t) => bToks.includes(t)).length;
        const minToks = Math.min(aToks.length, bToks.length);
        const maxToks = Math.max(aToks.length, bToks.length);
        if (minToks === 1 && maxToks >= 2 && sim < 0.94) continue;
        if (minToks >= 2 && shared < Math.ceil(minToks * 0.75)) continue;

        const kindBonus = rec.kind === preferredKind ? 0.02 : 0;
        const finalScore = sim + kindBonus;
        if (finalScore > bestScore) {
          bestScore = finalScore;
          bestRecord = rec;
        }
      }
    }

    if (bestRecord) {
      return buildResult([bestRecord]);
    }

    return {
      available: false,
      hasLeg: false,
      hasDub: false,
      providerNames: [],
    };
  }

  clear(): void {
    this.recordsByKey.clear();
    this.exactLookup.clear();
    this.baseLookup.clear();
    this.tokenLookup.clear();
    this.loadedAtMs = 0;
    this.sitemapEntriesCount = 0;
    this.passiveEntriesCount = 0;
    this.sourceMode = 'passive';
    this.inFlightLoad = null;
    this.hydratedFromStorage = false;
    if (isLocalStorageUsable()) {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        // ignore
      }
    }
  }
}

const defaultStore = new ProviderAvailabilityIndexStore();

export function createProviderIndexStore(): ProviderAvailabilityIndexStore {
  return new ProviderAvailabilityIndexStore();
}

export function ensureProviderIndexLoaded(
  fetchHttp: HttpFetcher,
  options?: {
    forceRefresh?: boolean;
    delayMs?: number;
    maxTvShowPages?: number;
    maxMoviePages?: number;
  }
): Promise<ProviderIndexStats> {
  return defaultStore.ensureLoaded(fetchHttp, options);
}

export function registerProviderIndexItems(
  items: ReadonlyArray<{
    title: string;
    url: string;
    kind?: MediaKind;
    audioType?: AudioType;
    sourceServerName?: string;
  }>
): number {
  return defaultStore.registerPassiveItems(items);
}

export function matchTitlesAgainstProviderIndex(query: {
  titles: readonly string[];
  mediaKind?: 'anime' | 'movie' | 'series';
  audioFilter?: DiscoverAudioFilter;
  allowSeasonStripFallback?: boolean;
}): ProviderAvailabilityInfo {
  return defaultStore.matchTitles(query);
}

export function getProviderIndexStats(): ProviderIndexStats {
  return defaultStore.getStats();
}

export function clearProviderIndex(): void {
  defaultStore.clear();
}
