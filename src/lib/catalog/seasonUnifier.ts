import type { HttpFetcher } from '../httpTypes.ts';
import {
  isEpisodeAvailableOnServer,
  parseEpisodeDateToTimestampSec,
  parseEpisodeNumberFromLabel,
} from '../episodeAvailability.ts';
import { fetchHinataSoulAnimeWithEpisodes } from '../sources/providers/hinatasoulSource.ts';
import { parseAnimePageHtml } from '../topanimesParser.ts';
import type { AnimeDetails, AnimeEpisodeLink, AudioType, SearchResultItem } from '../types.ts';
import {
  isHinataSoulUrl,
  normalizeHinataSoulUrl,
  normalizeTopAnimesUrl,
} from '../urlSafety.ts';
import { normalizeTitleForMatch, stripSeasonFromTitle } from './idCodec.ts';
import { getServerSearch, getServerSearchSuggest } from './serverCatalog.ts';

export interface ParsedSeasonTitleInfo {
  baseTitle: string;
  normalizedBase: string;
  seasonNumber: number | null;
  partNumber: number | null;
  isFinalSeason: boolean;
  audioType: AudioType;
  isMovieOrSpecial: boolean;
  hasColonSubtitle: boolean;
  prefixBeforeSubtitle: string;
  normalizedPrefixBeforeSubtitle: string;
}

export interface MatchedSiblingSeason {
  url: string;
  title: string;
  seasonNumber: number;
  partNumber: number | null;
  audioType: AudioType;
  isHinataSoul: boolean;
  score: number;
}

export interface UnifiedServerSeasonsResult {
  serverEpisodes: AnimeEpisodeLink[];
  unifiedTitle: string;
  unifiedSeasonCount: number;
  addedSeasonPages: number;
  primarySeasonNumber: number;
}

const ROMAN_SEASON_MAP: Record<string, number> = {
  II: 2,
  III: 3,
  IV: 4,
  V: 5,
  VI: 6,
  VII: 7,
  VIII: 8,
  IX: 9,
  X: 10,
};

const MOVIE_OR_SPECIAL_TITLE_RE =
  /\b(?:filme|movie|gekijouban|the movie|ova|oad|ona|special|especial|especiais|recap|summary|resumo|live[\s-]?action|mini[\s-]?anime|picture drama|chibi)\b/i;

const SPINOFF_DIFFERENTIATOR_TOKENS = new Set([
  '0',
  'zero',
  'ova',
  'oad',
  'ona',
  'movie',
  'filme',
  'special',
  'especial',
  'alternative',
  'vigilantes',
  'vigilante',
  'gaiden',
  'spinoff',
  'spin',
  'shippuden',
  'boruto',
  'next',
  'generations',
  'brotherhood',
  'gt',
  'super',
  'kai',
  'daima',
  'z',
  'chibi',
  'mini',
  'shorts',
  'recap',
  'live',
  'action',
]);

function cleanWhitespace(raw?: string): string {
  return String(raw || '').replace(/\s+/g, ' ').trim();
}

function canonicalServerUrl(rawUrl: string): string {
  if (!rawUrl) return '';
  if (isHinataSoulUrl(rawUrl)) {
    return (normalizeHinataSoulUrl(rawUrl) || rawUrl).toLowerCase().replace(/\/+$/, '');
  }
  return (normalizeTopAnimesUrl(rawUrl) || rawUrl).toLowerCase().replace(/\/+$/, '');
}

function inferAudioTypeFromTitleOrUrl(title: string, url?: string, explicit?: AudioType): AudioType {
  if (explicit === 'DUB' || explicit === 'LEG') return explicit;
  const hay = `${title || ''} ${url || ''}`;
  if (/\b(?:dublado|dub)\b/i.test(hay) || /\/anime-dublado\//i.test(hay) || /-dublado(?:\/|$)/i.test(hay)) {
    return 'DUB';
  }
  if (/\b(?:legendado|leg)\b/i.test(hay) || /-legendado(?:\/|$)/i.test(hay)) {
    return 'LEG';
  }
  return null;
}

/**
 * Extracts normalized base title, explicit season/part/final-season markers, audio type,
 * and movie/OVA/special classification from a provider anime title.
 */
export function extractSeasonAndPartInfo(
  rawTitle: string,
  rawUrl?: string,
  explicitAudio?: AudioType
): ParsedSeasonTitleInfo {
  const original = cleanWhitespace(rawTitle);
  const audioType = inferAudioTypeFromTitleOrUrl(original, rawUrl, explicitAudio);
  const isMovieOrSpecial =
    Boolean(rawUrl && /\/filmes?\//i.test(rawUrl)) || MOVIE_OR_SPECIAL_TITLE_RE.test(original);

  // Remove audio/quality tags without disturbing the core title or season markers
  let working = original
    .replace(/\s*\((?:dublado|legendado|dub|leg|pt[\s-]?br|dual[\s-]?audio|hd|full\s*hd)\)\s*/gi, ' ')
    .replace(/\s*[-–—]\s*(?:dublado|legendado|dub|leg)\s*$/i, '')
    .replace(/\s+\b(?:dublado|legendado|online|full\s*hd|hd)\b\s*$/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Extract explicit Part / Cour number (e.g. "Part 2", "Parte 2", "Cour 2")
  let partNumber: number | null = null;
  const partMatch = working.match(/(?:[-–—:]\s*|\s+)\b(?:part|parte|cour)\s*0*(\d{1,2})\b/i);
  if (partMatch?.[1]) {
    const p = Number.parseInt(partMatch[1], 10);
    if (Number.isFinite(p) && p >= 1 && p <= 10) {
      partNumber = p;
    }
    working = working
      .replace(/(?:[-–—:]\s*|\s+)\b(?:part|parte|cour)\s*0*\d{1,2}\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Detect "Final Season" / "Temporada Final"
  let isFinalSeason = false;
  if (/\b(?:(?:the\s+)?final\s+season|temporada\s+final|[uú]ltima\s+temporada)\b/i.test(working)) {
    isFinalSeason = true;
    working = working
      .replace(/\s*[-–—:]?\s*\b(?:(?:the\s+)?final\s+season|temporada\s+final|[uú]ltima\s+temporada)\b.*$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Extract explicit numeric season (e.g. "2nd Season", "2ª Temporada", "Season 2", "Temporada 2", "S2")
  let seasonNumber: number | null = null;
  const numericPatterns: RegExp[] = [
    /\s*[-–—:]?\s*\b0*(\d{1,2})(?:st|nd|rd|th|a|ª)\s*(?:season|temporada)\b.*$/i,
    /\s*[-–—:]?\s*\b(?:season|temporada)\s*0*(\d{1,2})\b.*$/i,
    /\s*[-–—:]?\s*\bS0*(\d{1,2})\b(?:\s*[-–—:].*|\s*$)/i,
  ];
  for (const re of numericPatterns) {
    const m = working.match(re);
    if (m?.[1]) {
      const n = Number.parseInt(m[1], 10);
      if (Number.isFinite(n) && n >= 1 && n <= 30) {
        seasonNumber = n;
        working = working.replace(re, '').replace(/\s+/g, ' ').trim();
        break;
      }
    }
  }

  // Trailing Roman numeral season (e.g. "Overlord IV", "Mob Psycho 100 II", "DanMachi III: Arc")
  if (seasonNumber === null && !isFinalSeason) {
    const romanMatch = working.match(/\s+(II|III|IV|V|VI|VII|VIII|IX|X)(?:\s*[-–—:].*|\s*$)/);
    if (romanMatch?.[1] && ROMAN_SEASON_MAP[romanMatch[1]]) {
      seasonNumber = ROMAN_SEASON_MAP[romanMatch[1]];
      working = working
        .replace(/\s+(?:II|III|IV|V|VI|VII|VIII|IX|X)(?:\s*[-–—:].*|\s*$)/, '')
        .replace(/\s+/g, ' ')
        .trim();
    }
  }

  // Trailing Arabic numeral 2..15 after a word (e.g. "Boku no Hero Academia 6", NOT "Mob Psycho 100", "Ranma 1/2", "Jujutsu Kaisen 0")
  if (seasonNumber === null && !isFinalSeason) {
    const trailingNumMatch = working.match(/^(.+?[^\d/])\s+([2-9]|1[0-5])(?:\s*$)/);
    if (trailingNumMatch?.[1] && trailingNumMatch[2]) {
      const candidateBase = trailingNumMatch[1].trim();
      const num = Number.parseInt(trailingNumMatch[2], 10);
      if (candidateBase.length >= 3 && Number.isFinite(num) && num >= 2 && num <= 15) {
        seasonNumber = num;
        working = candidateBase;
      }
    }
  }

  const baseTitle = working.replace(/[-–—:]+\s*$/, '').trim() || stripSeasonFromTitle(original) || original;
  const normalizedBase = normalizeTitleForMatch(baseTitle);

  const colonParts = baseTitle.split(/\s*(?::|–|—|\s-\s)\s*/);
  const hasColonSubtitle = colonParts.length >= 2 && colonParts[0].trim().length >= 4;
  const prefixBeforeSubtitle = hasColonSubtitle ? colonParts[0].trim() : baseTitle;
  const normalizedPrefixBeforeSubtitle = normalizeTitleForMatch(prefixBeforeSubtitle);

  return {
    baseTitle,
    normalizedBase,
    seasonNumber,
    partNumber,
    isFinalSeason,
    audioType,
    isMovieOrSpecial,
    hasColonSubtitle,
    prefixBeforeSubtitle,
    normalizedPrefixBeforeSubtitle,
  };
}

/**
 * Strips season suffix from an anime title when multiple seasons have been unified onto a single page,
 * preserving the "Dublado" tag if the opened title was explicitly marked Dublado.
 */
export function buildUnifiedSeriesTitle(rawTitle: string, audioType?: AudioType): string {
  const info = extractSeasonAndPartInfo(rawTitle, undefined, audioType);
  if (!info.baseTitle) return cleanWhitespace(rawTitle);
  const hadDubTag = /\bdublado\b/i.test(rawTitle);
  if (hadDubTag && !/\bdublado\b/i.test(info.baseTitle)) {
    return `${info.baseTitle} Dublado`;
  }
  return info.baseTitle;
}

function scoreStrictBaseMatch(refNormalized: string, candNormalized: string): number {
  if (!refNormalized || !candNormalized) return 0;
  if (refNormalized === candNormalized) return 1.0;

  const refTokens = refNormalized.split(' ').filter(Boolean);
  const candTokens = candNormalized.split(' ').filter(Boolean);
  if (refTokens.length < 2 || candTokens.length < 2) return 0;

  const refSet = new Set(refTokens);
  const candSet = new Set(candTokens);

  // Reject if candidate introduces a spin-off / prequel / franchise differentiator token absent from ref
  for (const t of candSet) {
    if (!refSet.has(t) && SPINOFF_DIFFERENTIATOR_TOKENS.has(t)) {
      return 0;
    }
  }
  for (const t of refSet) {
    if (!candSet.has(t) && SPINOFF_DIFFERENTIATOR_TOKENS.has(t)) {
      return 0;
    }
  }

  let overlap = 0;
  for (const t of refSet) {
    if (candSet.has(t)) overlap += 1;
  }

  const minLen = Math.min(refSet.size, candSet.size);
  const maxLen = Math.max(refSet.size, candSet.size);
  if (overlap !== minLen) return 0;
  if (maxLen - minLen > 1) return 0;

  const ratio = overlap / maxLen;
  return ratio >= 0.8 ? ratio : 0;
}

function extractSeasonYearsFromCatalog(
  catalogEpisodes: readonly AnimeEpisodeLink[]
): Map<number, Set<string>> {
  const bySeason = new Map<number, Set<string>>();
  for (const ep of catalogEpisodes) {
    const s = ep.seasonNumber || 1;
    let year = '';
    if (ep.date) {
      const m = ep.date.match(/\b((?:19|20)\d{2})\b/);
      if (m?.[1]) year = m[1];
    }
    if (!year && ep.airingAt && ep.airingAt > 0) {
      year = String(new Date(ep.airingAt * 1000).getUTCFullYear());
    }
    if (!year) continue;
    let set = bySeason.get(s);
    if (!set) {
      set = new Set();
      bySeason.set(s, set);
    }
    set.add(year);
  }
  return bySeason;
}

function extractSeasonStartYearFromCatalog(
  catalogEpisodes: readonly AnimeEpisodeLink[]
): Map<number, string> {
  const earliestTsBySeason = new Map<number, number>();
  const yearBySeason = new Map<number, string>();
  for (const ep of catalogEpisodes) {
    const s = ep.seasonNumber || 1;
    const ts = ep.airingAt ?? parseEpisodeDateToTimestampSec(ep.date);
    if (ts && ts > 0) {
      const prev = earliestTsBySeason.get(s);
      if (prev === undefined || ts < prev) {
        earliestTsBySeason.set(s, ts);
        yearBySeason.set(s, String(new Date(ts * 1000).getUTCFullYear()));
      }
    } else if (!yearBySeason.has(s) && ep.date) {
      const m = ep.date.match(/\b((?:19|20)\d{2})\b/);
      if (m?.[1]) yearBySeason.set(s, m[1]);
    }
  }
  return yearBySeason;
}

function hasSpinOffMarker(normalizedText: string): boolean {
  const tokens = normalizedText.split(' ').filter(Boolean);
  return tokens.some((t) => SPINOFF_DIFFERENTIATOR_TOKENS.has(t));
}

/**
 * Deterministically selects sibling season pages from provider search results that belong to
 * the exact same anime, avoiding movies, OVAs, spin-offs, and already-covered seasons.
 */
export function matchSiblingSeasonCandidates(params: {
  primaryUrl: string;
  primaryTitle: string;
  primaryAudioType?: AudioType;
  primarySeasonNumber: number;
  referenceTitles: string[];
  tvdbSeasons: number[];
  catalogEpisodes?: readonly AnimeEpisodeLink[];
  alreadyCoveredSeasons: ReadonlySet<number>;
  needMoreEpisodesInPrimarySeason?: boolean;
  searchCandidates: readonly SearchResultItem[];
}): MatchedSiblingSeason[] {
  const {
    primaryUrl,
    primaryTitle,
    primaryAudioType,
    primarySeasonNumber,
    referenceTitles,
    tvdbSeasons,
    catalogEpisodes = [],
    alreadyCoveredSeasons,
    needMoreEpisodesInPrimarySeason = false,
    searchCandidates,
  } = params;

  const primaryCanon = canonicalServerUrl(primaryUrl);
  const primaryIsHs = isHinataSoulUrl(primaryUrl);
  const effectivePrimaryAudio =
    inferAudioTypeFromTitleOrUrl(primaryTitle, primaryUrl, primaryAudioType) || 'LEG';

  const refNormalizedBases = Array.from(
    new Set(
      [primaryTitle, ...referenceTitles]
        .map((t) => extractSeasonAndPartInfo(t))
        .flatMap((info) => [info.normalizedBase, info.normalizedPrefixBeforeSubtitle])
        .filter((s) => s.length >= 2)
    )
  );
  if (!refNormalizedBases.length) return [];

  const maxTvdbSeason = tvdbSeasons.length > 0 ? tvdbSeasons[tvdbSeasons.length - 1] : 0;
  const seasonStartYears = extractSeasonStartYearFromCatalog(catalogEpisodes);
  const seasonAllYears = extractSeasonYearsFromCatalog(catalogEpisodes);
  const uncoveredTvdbSeasons = tvdbSeasons.filter((s) => !alreadyCoveredSeasons.has(s));

  const bestByBucket = new Map<string, MatchedSiblingSeason>();

  for (const cand of searchCandidates) {
    if (!cand.url || !cand.title) continue;
    if (cand.kind === 'episode' || cand.kind === 'movie') continue;
    const candCanon = canonicalServerUrl(cand.url);
    if (!candCanon || candCanon === primaryCanon) continue;

    const info = extractSeasonAndPartInfo(cand.title, cand.url, cand.audioType);
    if (info.isMovieOrSpecial) continue;

    let baseScore = 0;
    for (const ref of refNormalizedBases) {
      const s = scoreStrictBaseMatch(ref, info.normalizedBase);
      if (s > baseScore) baseScore = s;
    }

    let resolvedSeason: number | null = null;
    let resolvedPart: number | null = info.partNumber;

    if (baseScore >= 0.8) {
      if (info.isFinalSeason) {
        resolvedSeason =
          maxTvdbSeason > 1 ? maxTvdbSeason : Math.max(2, primarySeasonNumber + 1);
      } else if (info.seasonNumber !== null) {
        resolvedSeason = info.seasonNumber;
      } else if (info.partNumber !== null && info.partNumber > 1) {
        resolvedSeason = primarySeasonNumber;
      } else {
        resolvedSeason = 1;
      }
    } else if (
      info.hasColonSubtitle &&
      info.seasonNumber === null &&
      !info.isFinalSeason &&
      uncoveredTvdbSeasons.length > 0 &&
      cand.year &&
      /^\d{4}$/.test(cand.year)
    ) {
      // Subtitled arc season (e.g. "Kimetsu no Yaiba: Yuukaku-hen" (2021)) matching a unique uncovered TheTVDB season by year!
      const prefixMatchesRef = refNormalizedBases.some(
        (ref) =>
          (ref.length >= 8 || ref.split(' ').length >= 2) &&
          info.normalizedPrefixBeforeSubtitle === ref
      );
      if (prefixMatchesRef && !hasSpinOffMarker(info.normalizedBase)) {
        const yearMatches = uncoveredTvdbSeasons.filter(
          (s) => seasonStartYears.get(s) === cand.year || seasonAllYears.get(s)?.has(cand.year!)
        );
        if (yearMatches.length === 1) {
          resolvedSeason = yearMatches[0];
          resolvedPart = null;
          baseScore = 0.86;
        }
      }
    }

    if (resolvedSeason === null || resolvedSeason < 1) continue;

    // Skip seasons already covered by the opened page, unless this is a continuation Part 2+ for an incomplete primary season
    const isContinuationPart = Boolean(resolvedPart && resolvedPart > 1);
    if (alreadyCoveredSeasons.has(resolvedSeason)) {
      if (!(isContinuationPart && resolvedSeason === primarySeasonNumber && needMoreEpisodesInPrimarySeason)) {
        continue;
      }
    }

    // If TheTVDB gave us an authoritative multi-season list, avoid pulling nonsensical high seasons far beyond it
    if (maxTvdbSeason > 0 && resolvedSeason > maxTvdbSeason + 1) {
      continue;
    }

    const candAudio = info.audioType || 'LEG';
    const candIsHs = isHinataSoulUrl(cand.url);

    let totalScore = baseScore;
    if (candAudio === effectivePrimaryAudio) {
      totalScore += 0.3;
    } else if (effectivePrimaryAudio === 'DUB' && candAudio === 'LEG') {
      totalScore -= 0.05;
    } else if (effectivePrimaryAudio === 'LEG' && candAudio === 'DUB') {
      totalScore -= 0.15;
    }
    if (candIsHs === primaryIsHs) {
      totalScore += 0.15;
    }

    const bucketKey = `${resolvedSeason}:p${resolvedPart || 1}`;
    const existing = bestByBucket.get(bucketKey);
    if (!existing || totalScore > existing.score) {
      bestByBucket.set(bucketKey, {
        url: cand.url,
        title: cand.title,
        seasonNumber: resolvedSeason,
        partNumber: resolvedPart,
        audioType: info.audioType,
        isHinataSoul: candIsHs,
        score: totalScore,
      });
    }
  }

  return Array.from(bestByBucket.values())
    .sort((a, b) => a.seasonNumber - b.seasonNumber || (a.partNumber || 1) - (b.partNumber || 1))
    .slice(0, 10);
}

function buildEpisodeSeasonLabel(seasonNumber: number, epNum: number | null, fallbackLabel?: string): string {
  if (epNum !== null && epNum > 0) {
    return seasonNumber > 1 ? `T${seasonNumber} · EP ${epNum}` : `EP ${epNum}`;
  }
  return fallbackLabel || (seasonNumber > 1 ? `T${seasonNumber}` : 'EP');
}

function normalizeEpisodesForSeason(
  episodes: readonly AnimeEpisodeLink[],
  targetSeason: number,
  options: {
    partOffset?: number;
    preserveMultiSeason?: boolean;
  } = {}
): AnimeEpisodeLink[] {
  const { partOffset = 0, preserveMultiSeason = false } = options;
  const distinctSeasons = new Set(episodes.map((e) => e.seasonNumber || 1));
  const keepOriginalSeasons = preserveMultiSeason && distinctSeasons.size > 1;

  return episodes.map((ep) => {
    const rawEpNum = ep.episodeNumber ?? parseEpisodeNumberFromLabel(ep.numberLabel || ep.title);
    const sNum = keepOriginalSeasons ? ep.seasonNumber || 1 : targetSeason;
    const adjustedEpNum =
      rawEpNum !== null && !keepOriginalSeasons ? rawEpNum + partOffset : rawEpNum;
    const needsRenumberedLabel =
      !keepOriginalSeasons &&
      (sNum > 1 || partOffset > 0) &&
      (!ep.numberLabel ||
        /^\s*1\s*[-·]\s*\d+\s*$/.test(ep.numberLabel) ||
        /^\s*(?:ep\.?\s*)?\d+\s*$/i.test(ep.numberLabel));

    return {
      ...ep,
      seasonNumber: sNum,
      seasonLabel: `Temporada ${sNum}`,
      episodeNumber: adjustedEpNum,
      numberLabel: needsRenumberedLabel
        ? buildEpisodeSeasonLabel(sNum, adjustedEpNum, ep.numberLabel)
        : ep.numberLabel || buildEpisodeSeasonLabel(sNum, adjustedEpNum),
      availableOnServer: true,
    };
  });
}

async function fetchSiblingServerPage(
  fetchHttp: HttpFetcher,
  candidate: MatchedSiblingSeason
): Promise<AnimeEpisodeLink[]> {
  try {
    if (candidate.isHinataSoul) {
      const details = await fetchHinataSoulAnimeWithEpisodes(fetchHttp, candidate.url, {
        maxPages: 6,
        timeoutMs: 8000,
      });
      return details?.episodes || [];
    }
    const origin = new URL(candidate.url).origin;
    const res = await fetchHttp(candidate.url, {
      referer: `${origin}/`,
      timeoutMs: 8000,
    });
    if (!res.ok) return [];
    return parseAnimePageHtml(res.body, candidate.url).episodes;
  } catch {
    return [];
  }
}

/**
 * Discovers and merges sibling season pages across integrated streaming providers (TopAnimes &
 * Hinata Soul) so every anime detail page displays ALL seasons organized in one unified view.
 */
export async function unifyServerSeasonsWithCatalog(
  fetchHttp: HttpFetcher,
  serverDetails: AnimeDetails,
  catalogEpisodes: readonly AnimeEpisodeLink[],
  extraReferenceTitles: string[] = []
): Promise<UnifiedServerSeasonsResult> {
  const isMovie = serverDetails.kind === 'movie' || /\/filmes?\//i.test(serverDetails.url);
  if (isMovie) {
    return {
      serverEpisodes: serverDetails.episodes,
      unifiedTitle: serverDetails.title,
      unifiedSeasonCount: 1,
      addedSeasonPages: 0,
      primarySeasonNumber: 1,
    };
  }

  const primaryInfo = extractSeasonAndPartInfo(
    serverDetails.title,
    serverDetails.url,
    serverDetails.audioType
  );
  const tvdbSeasons = Array.from(
    new Set(catalogEpisodes.map((e) => e.seasonNumber || 1).filter((s) => s > 0))
  ).sort((a, b) => a - b);
  const maxTvdbSeason = tvdbSeasons.length > 0 ? tvdbSeasons[tvdbSeasons.length - 1] : 0;

  const rawPrimarySeasons = new Set(serverDetails.episodes.map((e) => e.seasonNumber || 1));
  const primaryIsSingleFlatSeason = rawPrimarySeasons.size <= 1;

  // Resolve which season the opened server page represents
  let primarySeasonNumber = 1;
  if (primaryInfo.isFinalSeason) {
    primarySeasonNumber = maxTvdbSeason > 1 ? maxTvdbSeason : 2;
  } else if (primaryInfo.seasonNumber !== null && primaryInfo.seasonNumber > 0) {
    primarySeasonNumber = primaryInfo.seasonNumber;
  } else if (primaryIsSingleFlatSeason && rawPrimarySeasons.size === 1) {
    primarySeasonNumber = Array.from(rawPrimarySeasons)[0];
  } else if (
    primaryInfo.hasColonSubtitle &&
    serverDetails.year &&
    /^\d{4}$/.test(serverDetails.year) &&
    tvdbSeasons.length > 1
  ) {
    const startYears = extractSeasonStartYearFromCatalog(catalogEpisodes);
    const matching = tvdbSeasons.filter((s) => startYears.get(s) === serverDetails.year);
    if (matching.length === 1) {
      primarySeasonNumber = matching[0];
    }
  }

  // Normalize opened page's own playable episodes to their true season number
  const playablePrimaryEps = serverDetails.episodes.filter(isEpisodeAvailableOnServer);
  const normalizedPrimaryEps = primaryIsSingleFlatSeason
    ? normalizeEpisodesForSeason(playablePrimaryEps, primarySeasonNumber)
    : normalizeEpisodesForSeason(playablePrimaryEps, 1, { preserveMultiSeason: true });

  // Detect continuous absolute numbering (e.g. One Piece 1..1120 or Black Clover 1..170 in 1 flat list)
  const primaryMaxEp = normalizedPrimaryEps.reduce((m, e) => Math.max(m, e.episodeNumber || 0), 0);
  const catalogS1Max = catalogEpisodes
    .filter((e) => (e.seasonNumber || 1) === 1)
    .reduce((m, e) => Math.max(m, e.episodeNumber || 0), 0);
  const usesContinuousAbsolute =
    primaryIsSingleFlatSeason &&
    primarySeasonNumber === 1 &&
    catalogS1Max > 0 &&
    primaryMaxEp > catalogS1Max;

  // Determine which seasons are already covered by the opened page
  const coveredSeasons = new Set<number>();
  if (usesContinuousAbsolute) {
    // Count how many catalog seasons are already covered by episodes 1..primaryMaxEp
    const sortedCatalog = [...catalogEpisodes].sort(
      (a, b) =>
        (a.seasonNumber || 1) - (b.seasonNumber || 1) ||
        (a.episodeNumber || 0) - (b.episodeNumber || 0)
    );
    sortedCatalog.forEach((ep, idx) => {
      if (idx + 1 <= primaryMaxEp) {
        coveredSeasons.add(ep.seasonNumber || 1);
      }
    });
    if (coveredSeasons.size === 0) coveredSeasons.add(1);
  } else if (primaryIsSingleFlatSeason) {
    coveredSeasons.add(primarySeasonNumber);
  } else {
    for (const s of rawPrimarySeasons) coveredSeasons.add(s);
  }

  // Check if primary season has significantly fewer episodes than already-aired TheTVDB episodes (e.g. split-cour Part 1)
  const nowSec = Math.floor(Date.now() / 1000);
  const airedInPrimarySeason = catalogEpisodes.filter((ep) => {
    if ((ep.seasonNumber || 1) !== primarySeasonNumber) return false;
    const ts = ep.airingAt ?? parseEpisodeDateToTimestampSec(ep.date);
    return ts !== undefined ? ts <= nowSec - 86400 : true;
  }).length;
  const primarySeasonEpCount = normalizedPrimaryEps.filter(
    (e) => (e.seasonNumber || 1) === primarySeasonNumber
  ).length;
  const needMoreEpisodesInPrimarySeason =
    primarySeasonEpCount > 0 && airedInPrimarySeason >= primarySeasonEpCount + 3;

  const hasMissingTvdbSeasons = tvdbSeasons.some((s) => !coveredSeasons.has(s));
  const shouldSearchSiblings =
    hasMissingTvdbSeasons ||
    primarySeasonNumber > 1 ||
    needMoreEpisodesInPrimarySeason ||
    catalogEpisodes.length === 0;

  if (!shouldSearchSiblings) {
    return {
      serverEpisodes: normalizedPrimaryEps,
      unifiedTitle: serverDetails.title,
      unifiedSeasonCount: Math.max(1, coveredSeasons.size, tvdbSeasons.length),
      addedSeasonPages: 0,
      primarySeasonNumber,
    };
  }

  // Build concise search query terms (base title without season suffix)
  const searchQueries = Array.from(
    new Set(
      [
        primaryInfo.baseTitle,
        primaryInfo.prefixBeforeSubtitle,
        ...extraReferenceTitles.map((t) => extractSeasonAndPartInfo(t).baseTitle),
      ]
        .map((q) => cleanWhitespace(q))
        .filter((q) => q.length >= 3)
    )
  ).slice(0, 2);

  if (!searchQueries.length) {
    return {
      serverEpisodes: normalizedPrimaryEps,
      unifiedTitle: serverDetails.title,
      unifiedSeasonCount: Math.max(1, coveredSeasons.size, tvdbSeasons.length),
      addedSeasonPages: 0,
      primarySeasonNumber,
    };
  }

  // Search providers in parallel (full search returns both TopAnimes + Hinata Soul with years & audio tags)
  const searchPool: SearchResultItem[] = [];
  const seenSearchUrls = new Set<string>();
  const addResults = (items: readonly SearchResultItem[]) => {
    for (const item of items) {
      const k = canonicalServerUrl(item.url);
      if (!k || seenSearchUrls.has(k)) continue;
      seenSearchUrls.add(k);
      searchPool.push(item);
    }
  };

  const primaryQuery = searchQueries[0];
  const [fullPrimary, suggestPrimary] = await Promise.all([
    getServerSearch(fetchHttp, primaryQuery, 1).catch(() => null),
    getServerSearchSuggest(fetchHttp, primaryQuery).catch(() => null),
  ]);
  if (fullPrimary?.results?.length) addResults(fullPrimary.results);
  if (suggestPrimary?.results?.length) addResults(suggestPrimary.results);

  // If a second distinct base title exists (e.g. Japanese romanized vs English title) and we still miss seasons, query it too
  let matchedSiblings = matchSiblingSeasonCandidates({
    primaryUrl: serverDetails.url,
    primaryTitle: serverDetails.title,
    primaryAudioType: serverDetails.audioType,
    primarySeasonNumber,
    referenceTitles: extraReferenceTitles,
    tvdbSeasons,
    catalogEpisodes,
    alreadyCoveredSeasons: coveredSeasons,
    needMoreEpisodesInPrimarySeason,
    searchCandidates: searchPool,
  });

  const foundSeasonsSet = new Set([...coveredSeasons, ...matchedSiblings.map((m) => m.seasonNumber)]);
  const stillMissingSeasons =
    tvdbSeasons.some((s) => !foundSeasonsSet.has(s)) ||
    (primarySeasonNumber > 1 && !foundSeasonsSet.has(1));

  if (stillMissingSeasons && searchQueries.length > 1) {
    const altQuery = searchQueries[1];
    const [fullAlt, suggestAlt] = await Promise.all([
      getServerSearch(fetchHttp, altQuery, 1).catch(() => null),
      getServerSearchSuggest(fetchHttp, altQuery).catch(() => null),
    ]);
    if (fullAlt?.results?.length) addResults(fullAlt.results);
    if (suggestAlt?.results?.length) addResults(suggestAlt.results);

    matchedSiblings = matchSiblingSeasonCandidates({
      primaryUrl: serverDetails.url,
      primaryTitle: serverDetails.title,
      primaryAudioType: serverDetails.audioType,
      primarySeasonNumber,
      referenceTitles: extraReferenceTitles,
      tvdbSeasons,
      catalogEpisodes,
      alreadyCoveredSeasons: coveredSeasons,
      needMoreEpisodesInPrimarySeason,
      searchCandidates: searchPool,
    });
  }

  if (!matchedSiblings.length) {
    return {
      serverEpisodes: normalizedPrimaryEps,
      unifiedTitle: serverDetails.title,
      unifiedSeasonCount: Math.max(1, coveredSeasons.size, tvdbSeasons.length),
      addedSeasonPages: 0,
      primarySeasonNumber,
    };
  }

  // Fetch matched sibling season pages in bounded parallel batches of 4
  const fetchedByCandidate: Array<{
    cand: MatchedSiblingSeason;
    episodes: AnimeEpisodeLink[];
  }> = [];

  for (let i = 0; i < matchedSiblings.length; i += 4) {
    const batch = matchedSiblings.slice(i, i + 4);
    const settled = await Promise.all(
      batch.map(async (cand) => ({
        cand,
        episodes: await fetchSiblingServerPage(fetchHttp, cand),
      }))
    );
    for (const entry of settled) {
      if (entry.episodes.length > 0) {
        fetchedByCandidate.push(entry);
      }
    }
  }

  if (!fetchedByCandidate.length) {
    return {
      serverEpisodes: normalizedPrimaryEps,
      unifiedTitle: serverDetails.title,
      unifiedSeasonCount: Math.max(1, coveredSeasons.size, tvdbSeasons.length),
      addedSeasonPages: 0,
      primarySeasonNumber,
    };
  }

  // Merge primary + sibling episodes, never overwriting any (season, episode) already present in primary
  const mergedEpisodes: AnimeEpisodeLink[] = [...normalizedPrimaryEps];
  const seenSeasonEp = new Set<string>();
  const seenUrls = new Set<string>();
  const maxEpBySeason = new Map<number, number>();

  for (const ep of normalizedPrimaryEps) {
    const s = ep.seasonNumber || 1;
    const n = ep.episodeNumber;
    if (n !== null) {
      seenSeasonEp.add(`${s}:${n}`);
      maxEpBySeason.set(s, Math.max(maxEpBySeason.get(s) || 0, n));
    }
    if (ep.url) seenUrls.add(canonicalServerUrl(ep.url));
  }

  let addedSeasonPages = 0;

  for (const { cand, episodes } of fetchedByCandidate) {
    let targetSeason = cand.seasonNumber;
    let partOffset = 0;

    if (cand.partNumber && cand.partNumber > 1) {
      const epNums = episodes
        .map((e) => e.episodeNumber ?? parseEpisodeNumberFromLabel(e.numberLabel || e.title))
        .filter((n): n is number => n !== null && n > 0);
      const minEp = epNums.length > 0 ? Math.min(...epNums) : 1;
      const existingMax = maxEpBySeason.get(targetSeason) || 0;

      if (minEp <= existingMax && existingMax > 0) {
        const catalogSeasonCount = catalogEpisodes.filter(
          (e) => (e.seasonNumber || 1) === targetSeason
        ).length;
        if (catalogSeasonCount >= existingMax + Math.min(episodes.length, 4)) {
          // TheTVDB puts Part 1 + Part 2 inside the same season -> offset Part 2 numbers after Part 1!
          partOffset = existingMax;
        } else if (!coveredSeasons.has(targetSeason + 1)) {
          // TheTVDB splits Part 2 into the next season
          targetSeason = targetSeason + 1;
        }
      }
    }

    const normalizedSibling = normalizeEpisodesForSeason(episodes, targetSeason, {
      partOffset,
      preserveMultiSeason: !cand.partNumber,
    });

    let addedFromThisPage = 0;
    for (const ep of normalizedSibling) {
      const uKey = canonicalServerUrl(ep.url);
      if (uKey && seenUrls.has(uKey)) continue;
      const s = ep.seasonNumber || 1;
      const n = ep.episodeNumber;
      if (n !== null && seenSeasonEp.has(`${s}:${n}`)) continue;

      if (uKey) seenUrls.add(uKey);
      if (n !== null) {
        seenSeasonEp.add(`${s}:${n}`);
        maxEpBySeason.set(s, Math.max(maxEpBySeason.get(s) || 0, n));
      }
      mergedEpisodes.push(ep);
      addedFromThisPage += 1;
    }

    if (addedFromThisPage > 0) {
      addedSeasonPages += 1;
    }
  }

  mergedEpisodes.sort(
    (a, b) =>
      (a.seasonNumber || 1) - (b.seasonNumber || 1) ||
      (a.episodeNumber || 0) - (b.episodeNumber || 0)
  );

  const distinctUnifiedSeasons = new Set(mergedEpisodes.map((e) => e.seasonNumber || 1));
  const shouldCleanTitle =
    (distinctUnifiedSeasons.size > 1 || addedSeasonPages > 0) &&
    (primaryInfo.seasonNumber !== null || primaryInfo.isFinalSeason || primaryInfo.partNumber !== null);

  return {
    serverEpisodes: mergedEpisodes,
    unifiedTitle: shouldCleanTitle
      ? buildUnifiedSeriesTitle(serverDetails.title, serverDetails.audioType)
      : serverDetails.title,
    unifiedSeasonCount: Math.max(distinctUnifiedSeasons.size, tvdbSeasons.length, 1),
    addedSeasonPages,
    primarySeasonNumber,
  };
}
