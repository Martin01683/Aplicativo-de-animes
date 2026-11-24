import type { HttpFetcher } from '../httpTypes.ts';
import {
  isEpisodeAvailableOnServer,
  parseEpisodeDateToTimestampSec,
  parseEpisodeNumberFromLabel,
} from '../episodeAvailability.ts';
import { fetchHinataSoulAnimeWithEpisodes } from '../sources/providers/hinatasoulSource.ts';
import { parseAnimePageHtml } from '../topanimesParser.ts';
import type {
  AnimeDetails,
  AnimeEpisodeLink,
  AudioType,
  SearchResultItem,
} from '../types.ts';
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
  subtitle: string;
  normalizedSubtitle: string;
  extractedYear: string | null;
}

export interface MatchedSiblingSeason {
  url: string;
  title: string;
  seasonNumber: number;
  partNumber: number | null;
  audioType: AudioType;
  isHinataSoul: boolean;
  score: number;
  groupKey?: string;
  subtitle?: string;
  normalizedSubtitle?: string;
  explicitSeasonNumber?: number | null;
  isFinalSeason?: boolean;
  year?: string;
  fallbackCandidates?: MatchedSiblingSeason[];
}

export interface UnifiedServerSeasonsResult {
  serverEpisodes: AnimeEpisodeLink[];
  unifiedTitle: string;
  unifiedSeasonCount: number;
  addedSeasonPages: number;
  primarySeasonNumber: number;
}

interface TvdbSeasonMeta {
  seasonNumber: number;
  totalEpisodes: number;
  airedEpisodes: number;
  startYear: number | null;
  endYear: number | null;
  allYears: Set<number>;
  startTs: number | null;
  maxEpisodeNumber: number;
  minEpisodeNumber: number;
}

interface AlignableServerPage {
  id: string;
  isPrimary: boolean;
  details: AnimeDetails;
  info: ParsedSeasonTitleInfo;
  episodes: AnimeEpisodeLink[];
  year: number | null;
  earliestEpTs: number | null;
  groupKey: string;
  audioBonus: number;
  isExactSeriesBase: boolean;
  isMultiSeasonPage: boolean;
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
  /\b(?:filme|movie|gekijouban|the movie|ova|oad|ona|special|especial|especiais|recap|summary|resumo|live[\s-]?action|mini[\s-]?anime|picture drama|chibi|omake)\b/i;

const NON_SEASON_COLON_SUBTITLE_RE = /^(?:the\s+animation|the\s+series|animation)\b/i;

export const SPINOFF_DIFFERENTIATOR_TOKENS = new Set([
  '0',
  'zero',
  'ova',
  'oad',
  'ona',
  'movie',
  'filme',
  'film',
  'gekijouban',
  'special',
  'specials',
  'especial',
  'especiais',
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
  'petit',
  'mini',
  'shorts',
  'omake',
  'recap',
  'recaps',
  'resumo',
  'summary',
  'live',
  'action',
  'gakuen',
  'oratoria',
  'stage',
  'musical',
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
  if (
    /\b(?:dublado|dub)\b/i.test(hay) ||
    /\/anime-dublado\//i.test(hay) ||
    /-dublado(?:\/|$)/i.test(hay)
  ) {
    return 'DUB';
  }
  if (/\b(?:legendado|leg)\b/i.test(hay) || /-legendado(?:\/|$)/i.test(hay)) {
    return 'LEG';
  }
  return null;
}

function hasLatinLetters(text: string): boolean {
  return /[A-Za-z]/.test(text);
}

function parseYearInt(raw?: string | null): number | null {
  if (!raw) return null;
  const m = String(raw).match(/\b((?:19|20)\d{2})\b/);
  if (!m?.[1]) return null;
  const y = Number.parseInt(m[1], 10);
  return Number.isFinite(y) && y >= 1950 && y <= 2100 ? y : null;
}

function hasSpinOffMarker(normalizedText: string, refTokens?: ReadonlySet<string>): boolean {
  const tokens = normalizedText.split(' ').filter(Boolean);
  return tokens.some(
    (t) => SPINOFF_DIFFERENTIATOR_TOKENS.has(t) && (!refTokens || !refTokens.has(t))
  );
}

/**
 * Extracts a safe parent series title prefix before a colon/dash subtitle for TheTVDB lookup
 * (e.g. "Kimetsu no Yaiba: Mugen Ressha-hen" -> "Kimetsu no Yaiba"), returning null when the
 * subtitle indicates a standalone spin-off or franchise sequel (e.g. "Naruto: Shippuden",
 * "My Hero Academia: Vigilantes").
 */
export function extractSafeParentPrefixForTvdb(rawTitle: string): string | null {
  const info = extractSeasonAndPartInfo(rawTitle);
  if (!info.hasColonSubtitle) return null;
  const prefix = cleanWhitespace(info.prefixBeforeSubtitle);
  const normPrefix = info.normalizedPrefixBeforeSubtitle;
  if (prefix.length < 4) return null;
  if (normPrefix.length < 8 && normPrefix.split(' ').filter(Boolean).length < 2) {
    return null;
  }
  const prefixTokens = new Set(normPrefix.split(' ').filter(Boolean));
  if (info.normalizedSubtitle && hasSpinOffMarker(info.normalizedSubtitle, prefixTokens)) {
    return null;
  }
  return prefix;
}

/**
 * Extracts normalized base title, explicit season/part/final-season markers, arc subtitle,
 * audio type, and movie/OVA/special classification from a provider anime title.
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

  const yearMatch = original.match(/\(((?:19|20)\d{2})\)/);
  const extractedYear = yearMatch?.[1] || null;

  // Remove audio/quality/TV tags without disturbing the core title or season markers
  let working = original
    .replace(
      /\s*\((?:dublado|legendado|dub|leg|pt[\s-]?br|dual[\s-]?audio|hd|full\s*hd|tv)\)\s*/gi,
      ' '
    )
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

  let explicitSubtitle = '';

  // Detect "Final Season" / "Temporada Final"
  let isFinalSeason = false;
  const finalMatch = working.match(
    /\s*[-–—:]?\s*\b(?:(?:the\s+)?final\s+season|temporada\s+final|[uú]ltima\s+temporada)\b(?:\s*(?::|–|—|\s-\s)\s*(.+))?$/i
  );
  if (finalMatch) {
    isFinalSeason = true;
    if (finalMatch[1]?.trim()) {
      explicitSubtitle = cleanWhitespace(finalMatch[1]);
    }
    working = working
      .replace(
        /\s*[-–—:]?\s*\b(?:(?:the\s+)?final\s+season|temporada\s+final|[uú]ltima\s+temporada)\b.*$/i,
        ''
      )
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Extract explicit numeric season (e.g. "2nd Season", "2ª Temporada", "Season 2", "Temporada 2", "S2")
  let seasonNumber: number | null = null;
  const numericPatterns: RegExp[] = [
    /\s*[-–—:]?\s*\b0*(\d{1,2})(?:st|nd|rd|th|a|ª)\s*(?:season|temporada)\b(?:\s*(?::|–|—|\s-\s)\s*(.+))?$/i,
    /\s*[-–—:]?\s*\b(?:season|temporada)\s*0*(\d{1,2})\b(?:\s*(?::|–|—|\s-\s)\s*(.+))?$/i,
    /\s*[-–—:]?\s*\bS0*(\d{1,2})\b(?:\s*(?::|–|—|\s-\s)\s*(.+)|\s*$)/i,
  ];
  for (const re of numericPatterns) {
    const m = working.match(re);
    if (m?.[1]) {
      const n = Number.parseInt(m[1], 10);
      if (Number.isFinite(n) && n >= 1 && n <= 30) {
        seasonNumber = n;
        if (m[2]?.trim() && !explicitSubtitle) {
          explicitSubtitle = cleanWhitespace(m[2]);
        }
        working = working.replace(re, '').replace(/\s+/g, ' ').trim();
        break;
      }
    }
  }

  // Trailing Roman numeral season (e.g. "Overlord IV", "Mob Psycho 100 III", "DanMachi III: Arc")
  if (seasonNumber === null && !isFinalSeason) {
    const romanMatch = working.match(
      /\s+(II|III|IV|V|VI|VII|VIII|IX|X)(?:\s*(?::|–|—|\s-\s)\s*(.+)|\s*$)/
    );
    if (romanMatch?.[1] && ROMAN_SEASON_MAP[romanMatch[1]]) {
      seasonNumber = ROMAN_SEASON_MAP[romanMatch[1]];
      if (romanMatch[2]?.trim() && !explicitSubtitle) {
        explicitSubtitle = cleanWhitespace(romanMatch[2]);
      }
      working = working
        .replace(/\s+(?:II|III|IV|V|VI|VII|VIII|IX|X)(?:\s*(?::|–|—|\s-\s).*|\s*$)/, '')
        .replace(/\s+/g, ' ')
        .trim();
    }
  }

  // Arabic numeral 2..15 followed by ": Subtitle" or " - Subtitle"
  // (e.g. "Kimetsu no Yaiba 3: Katanakaji no Sato-hen", NOT "Persona 5: The Animation" or "Mob Psycho 100: Reigen")
  if (seasonNumber === null && !isFinalSeason) {
    const beforeColonNumMatch = working.match(
      /^(.+?[^\d/])\s+([2-9]|1[0-5])\s*(?::|–|—|\s-\s)\s*(.+)$/
    );
    if (beforeColonNumMatch?.[1] && beforeColonNumMatch[2] && beforeColonNumMatch[3]) {
      const candidateBase = beforeColonNumMatch[1].trim();
      const num = Number.parseInt(beforeColonNumMatch[2], 10);
      const sub = cleanWhitespace(beforeColonNumMatch[3]);
      if (
        candidateBase.length >= 3 &&
        Number.isFinite(num) &&
        num >= 2 &&
        num <= 15 &&
        sub.length >= 2 &&
        !NON_SEASON_COLON_SUBTITLE_RE.test(sub)
      ) {
        seasonNumber = num;
        working = candidateBase;
        if (!explicitSubtitle) {
          explicitSubtitle = sub;
        }
      }
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

  const baseTitle =
    working.replace(/[-–—:]+\s*$/, '').trim() || stripSeasonFromTitle(original) || original;
  const normalizedBase = normalizeTitleForMatch(baseTitle);

  let hasColonSubtitle = false;
  let prefixBeforeSubtitle = baseTitle;
  let subtitle = explicitSubtitle;

  if (subtitle) {
    hasColonSubtitle = true;
    prefixBeforeSubtitle = baseTitle;
  } else {
    const colonMatch = baseTitle.match(/^(.{4,}?)\s*(?::|–|—|\s-\s)\s*(.+)$/);
    if (colonMatch?.[1] && colonMatch[2]) {
      hasColonSubtitle = true;
      prefixBeforeSubtitle = colonMatch[1].trim();
      subtitle = cleanWhitespace(colonMatch[2]);
    }
  }

  const normalizedPrefixBeforeSubtitle = normalizeTitleForMatch(prefixBeforeSubtitle);
  const normalizedSubtitle = normalizeTitleForMatch(subtitle);

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
    subtitle,
    normalizedSubtitle,
    extractedYear,
  };
}

/**
 * Strips season/arc suffix from an anime title when multiple seasons have been unified onto a single page,
 * preserving the "Dublado" tag if the opened title was explicitly marked Dublado.
 */
export function buildUnifiedSeriesTitle(
  rawTitle: string,
  audioType?: AudioType,
  preferPrefixBeforeSubtitle = false
): string {
  const info = extractSeasonAndPartInfo(rawTitle, undefined, audioType);
  const core =
    preferPrefixBeforeSubtitle && info.hasColonSubtitle && info.prefixBeforeSubtitle.length >= 4
      ? info.prefixBeforeSubtitle
      : info.baseTitle;
  if (!core) return cleanWhitespace(rawTitle);
  const hadDubTag = /\bdublado\b/i.test(rawTitle);
  if (hadDubTag && !/\bdublado\b/i.test(core)) {
    return `${core} Dublado`;
  }
  return core;
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

function buildReferenceNormalizedBases(
  primaryTitle: string,
  referenceTitles: readonly string[]
): string[] {
  const out = new Set<string>();
  for (const t of [primaryTitle, ...referenceTitles]) {
    if (!t || !t.trim()) continue;
    const info = extractSeasonAndPartInfo(t);
    if (info.normalizedBase.length >= 2) out.add(info.normalizedBase);
    if (
      info.hasColonSubtitle &&
      info.normalizedPrefixBeforeSubtitle.length >= 4 &&
      (info.normalizedPrefixBeforeSubtitle.length >= 8 ||
        info.normalizedPrefixBeforeSubtitle.split(' ').length >= 2)
    ) {
      out.add(info.normalizedPrefixBeforeSubtitle);
    }
    // For bilingual titles like "Demon Slayer: Kimetsu no Yaiba", the second segment is also an official series title
    if (
      info.hasColonSubtitle &&
      info.seasonNumber === null &&
      !info.isFinalSeason &&
      info.normalizedSubtitle.length >= 8 &&
      info.normalizedSubtitle.split(' ').length >= 2 &&
      referenceTitles.includes(t) &&
      !hasSpinOffMarker(info.normalizedSubtitle)
    ) {
      out.add(info.normalizedSubtitle);
    }
  }
  return Array.from(out);
}

function buildTvdbSeasonMetas(catalogEpisodes: readonly AnimeEpisodeLink[]): TvdbSeasonMeta[] {
  const nowSec = Math.floor(Date.now() / 1000);
  const bySeason = new Map<
    number,
    {
      total: number;
      aired: number;
      allYears: Set<number>;
      earliestTs: number | null;
      earliestYear: number | null;
      maxEp: number;
      minEp: number;
    }
  >();

  for (const ep of catalogEpisodes) {
    const s = ep.seasonNumber || 1;
    if (s <= 0) continue;
    let bucket = bySeason.get(s);
    if (!bucket) {
      bucket = {
        total: 0,
        aired: 0,
        allYears: new Set<number>(),
        earliestTs: null,
        earliestYear: null,
        maxEp: 0,
        minEp: Infinity,
      };
      bySeason.set(s, bucket);
    }
    bucket.total += 1;

    const epNum = ep.episodeNumber ?? parseEpisodeNumberFromLabel(ep.numberLabel || ep.title);
    if (epNum !== null && epNum > 0) {
      bucket.maxEp = Math.max(bucket.maxEp, epNum);
      bucket.minEp = Math.min(bucket.minEp, epNum);
    }

    const ts = ep.airingAt ?? parseEpisodeDateToTimestampSec(ep.date);
    const isAired = ts !== undefined ? ts <= nowSec - 3600 : true;
    if (isAired) bucket.aired += 1;

    let yearInt: number | null;
    if (ts && ts > 0) {
      yearInt = new Date(ts * 1000).getUTCFullYear();
      if (bucket.earliestTs === null || ts < bucket.earliestTs) {
        bucket.earliestTs = ts;
        bucket.earliestYear = yearInt;
      }
    } else {
      yearInt = parseYearInt(ep.date);
      if (yearInt !== null && bucket.earliestYear === null) {
        bucket.earliestYear = yearInt;
      }
    }
    if (yearInt !== null) {
      bucket.allYears.add(yearInt);
    }
  }

  return Array.from(bySeason.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([seasonNumber, data]) => {
      const yearsArr = Array.from(data.allYears).sort((a, b) => a - b);
      const startYear = data.earliestYear ?? (yearsArr.length > 0 ? yearsArr[0] : null);
      const endYear = yearsArr.length > 0 ? yearsArr[yearsArr.length - 1] : startYear;
      return {
        seasonNumber,
        totalEpisodes: data.total,
        airedEpisodes: data.aired,
        startYear,
        endYear,
        allYears: data.allYears,
        startTs: data.earliestTs,
        maxEpisodeNumber: data.maxEp,
        minEpisodeNumber: Number.isFinite(data.minEp) ? data.minEp : 1,
      };
    });
}

function computeCandidateGroupKey(
  info: ParsedSeasonTitleInfo,
  isExactSeriesBase: boolean,
  fallbackSeason: number
): string {
  const partSuffix = `p${info.partNumber || 1}`;
  if (isExactSeriesBase && info.seasonNumber === null && !info.isFinalSeason) {
    if (info.partNumber && info.partNumber > 1) {
      return `s${fallbackSeason}:${partSuffix}`;
    }
    return `s1:${partSuffix}`;
  }
  if (info.normalizedSubtitle) {
    return `sub:${info.normalizedSubtitle}:${partSuffix}`;
  }
  if (info.isFinalSeason) {
    return `final:${partSuffix}`;
  }
  if (info.seasonNumber !== null) {
    return `s${info.seasonNumber}:${partSuffix}`;
  }
  if (info.partNumber && info.partNumber > 1) {
    return `s${fallbackSeason}:${partSuffix}`;
  }
  return `s1:${partSuffix}`;
}

function buildExternalReferenceNormalizedBases(referenceTitles: readonly string[]): string[] {
  const out = new Set<string>();
  for (const t of referenceTitles) {
    if (!t || !t.trim()) continue;
    const info = extractSeasonAndPartInfo(t);
    if (info.normalizedBase.length >= 2) out.add(info.normalizedBase);
  }
  return Array.from(out);
}

function isExactBaseMatchToRefs(
  info: ParsedSeasonTitleInfo,
  externalRefNormalizedBases: readonly string[]
): boolean {
  if (info.seasonNumber !== null || info.isFinalSeason) return false;
  if (!info.hasColonSubtitle) return true;
  // A title with a colon (like "Kaguya-sama: Love is War" or "Demon Slayer: Kimetsu no Yaiba")
  // is an exact base series title only when external metadata (e.g. TheTVDB) lists that full title!
  return externalRefNormalizedBases.some(
    (ref) => scoreStrictBaseMatch(ref, info.normalizedBase) >= 0.85
  );
}

/**
 * Deterministically selects sibling season/arc pages from provider search results that belong to
 * the exact same anime, grouping cross-provider duplicates of the same season/arc with fallback
 * priority while strictly rejecting movies, OVAs, specials, and spin-offs.
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
  primaryHasPlayableEpisodes?: boolean;
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
    primaryHasPlayableEpisodes = true,
  } = params;

  const primaryCanon = canonicalServerUrl(primaryUrl);
  const primaryIsHs = isHinataSoulUrl(primaryUrl);
  const primaryInfo = extractSeasonAndPartInfo(primaryTitle, primaryUrl, primaryAudioType);
  const effectivePrimaryAudio = primaryInfo.audioType || 'LEG';

  const refNormalizedBases = buildReferenceNormalizedBases(primaryTitle, referenceTitles);
  if (!refNormalizedBases.length) return [];
  const externalRefNormalizedBases = buildExternalReferenceNormalizedBases(referenceTitles);

  const refTokenUnion = new Set(refNormalizedBases.flatMap((b) => b.split(' ').filter(Boolean)));
  const primaryIsExactBase = isExactBaseMatchToRefs(primaryInfo, externalRefNormalizedBases);
  const primaryGroupKey = computeCandidateGroupKey(
    primaryInfo,
    primaryIsExactBase,
    primarySeasonNumber
  );

  const maxTvdbSeason = tvdbSeasons.length > 0 ? tvdbSeasons[tvdbSeasons.length - 1] : 0;
  const tvdbMetas = buildTvdbSeasonMetas(catalogEpisodes);
  const metaBySeason = new Map(tvdbMetas.map((m) => [m.seasonNumber, m]));
  const uncoveredTvdbSeasons = tvdbSeasons.filter((s) => !alreadyCoveredSeasons.has(s));

  const allowUnnumberedArcs =
    uncoveredTvdbSeasons.length > 0 ||
    tvdbSeasons.length > 1 ||
    primaryInfo.hasColonSubtitle ||
    primaryInfo.seasonNumber !== null ||
    primaryInfo.isFinalSeason ||
    catalogEpisodes.length === 0;

  const groupedCandidates = new Map<string, MatchedSiblingSeason[]>();

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

    let isArcMatch = false;
    let resolvedSeason: number | null = null;
    const resolvedPart: number | null = info.partNumber;
    let inferredArcSubtitle = info.normalizedSubtitle;
    let inferredExplicitSeason = info.seasonNumber;

    if (baseScore >= 0.8) {
      // Reject spin-off marker introduced in an explicit subtitle (e.g. "Boku no Hero Academia 2: Vigilantes")
      if (info.normalizedSubtitle && hasSpinOffMarker(info.normalizedSubtitle, refTokenUnion)) {
        continue;
      }

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
    } else if (info.hasColonSubtitle && !info.isFinalSeason && allowUnnumberedArcs) {
      // Subtitled arc season (e.g. "Kimetsu no Yaiba: Mugen Ressha-hen", "Kimetsu no Yaiba: Yuukaku-hen",
      // "Kimetsu no Yaiba: Hashira Geiko-hen", "Dr. Stone: Stone Wars", "Solo Leveling: Arise from the Shadow")
      if (hasSpinOffMarker(info.normalizedSubtitle || info.normalizedBase, refTokenUnion)) {
        continue;
      }

      const candYearInt = parseYearInt(cand.year || info.extractedYear);
      const strictPrefixMatch = refNormalizedBases.some(
        (ref) =>
          (ref.length >= 8 || ref.split(' ').length >= 2) &&
          info.normalizedPrefixBeforeSubtitle === ref
      );
      const shortPrefixWithYearMatch =
        !strictPrefixMatch &&
        candYearInt !== null &&
        uncoveredTvdbSeasons.length > 0 &&
        refNormalizedBases.some(
          (ref) => ref.length >= 5 && info.normalizedPrefixBeforeSubtitle === ref
        );

      if (strictPrefixMatch || shortPrefixWithYearMatch) {
        isArcMatch = true;
        baseScore = 0.86;
        // Try to resolve unique TheTVDB season by year when available; otherwise keep 0 (resolved after fetching!)
        if (candYearInt !== null && uncoveredTvdbSeasons.length > 0) {
          const yearMatches = uncoveredTvdbSeasons.filter((s) => {
            const meta = metaBySeason.get(s);
            return meta && (meta.startYear === candYearInt || meta.allYears.has(candYearInt));
          });
          if (yearMatches.length === 1) {
            resolvedSeason = yearMatches[0];
          } else {
            resolvedSeason = info.seasonNumber ?? 0;
          }
        } else {
          resolvedSeason = info.seasonNumber ?? 0;
        }
      }
    } else if (!info.hasColonSubtitle && !info.isFinalSeason && allowUnnumberedArcs) {
      // Colon-free arc season (e.g. "Kimetsu no Yaiba Mugen Ressha-hen", "Kimetsu no Yaiba 2 Yuukaku-hen",
      // "Solo Leveling Arise from the Shadow", "Dr. Stone Stone Wars")
      const matchingRef = refNormalizedBases.find(
        (ref) =>
          ref.length >= 8 &&
          ref.split(' ').length >= 2 &&
          info.normalizedBase.startsWith(`${ref} `)
      );
      if (matchingRef) {
        const rawSuffix = info.normalizedBase.slice(matchingRef.length + 1).trim();
        if (rawSuffix && !hasSpinOffMarker(rawSuffix, refTokenUnion)) {
          const leadNumMatch = rawSuffix.match(/^([2-9]|1[0-5])\s+(.+)$/);
          const arcSub = leadNumMatch ? leadNumMatch[2].trim() : rawSuffix;
          const arcSeason = leadNumMatch ? Number.parseInt(leadNumMatch[1], 10) : info.seasonNumber;
          if (arcSub && !hasSpinOffMarker(arcSub, refTokenUnion)) {
            isArcMatch = true;
            inferredArcSubtitle = arcSub;
            inferredExplicitSeason = arcSeason;
            baseScore = 0.84;
            const candYearInt = parseYearInt(cand.year || info.extractedYear);
            if (candYearInt !== null && uncoveredTvdbSeasons.length > 0) {
              const yearMatches = uncoveredTvdbSeasons.filter((s) => {
                const meta = metaBySeason.get(s);
                return meta && (meta.startYear === candYearInt || meta.allYears.has(candYearInt));
              });
              resolvedSeason = yearMatches.length === 1 ? yearMatches[0] : (arcSeason ?? 0);
            } else {
              resolvedSeason = arcSeason ?? 0;
            }
          }
        }
      }
    }

    if (resolvedSeason === null) continue;
    if (resolvedSeason > 0 && maxTvdbSeason > 0 && resolvedSeason > maxTvdbSeason + 1) {
      continue;
    }

    const effectiveInfo: ParsedSeasonTitleInfo =
      inferredArcSubtitle !== info.normalizedSubtitle || inferredExplicitSeason !== info.seasonNumber
        ? {
            ...info,
            normalizedSubtitle: inferredArcSubtitle,
            subtitle: info.subtitle || inferredArcSubtitle,
            seasonNumber: inferredExplicitSeason,
            hasColonSubtitle: Boolean(inferredArcSubtitle) || info.hasColonSubtitle,
          }
        : info;

    const candIsExactBase = !isArcMatch && isExactBaseMatchToRefs(effectiveInfo, externalRefNormalizedBases);
    const groupKey = computeCandidateGroupKey(effectiveInfo, candIsExactBase, primarySeasonNumber);
    const isContinuationPart = Boolean(resolvedPart && resolvedPart > 1);

    // Skip candidates that represent the exact same arc/season as the opened page
    // (unless primary is missing episodes or empty and this is a continuation / cross-provider backup)
    if (primaryHasPlayableEpisodes && groupKey === primaryGroupKey) {
      if (!needMoreEpisodesInPrimarySeason) {
        continue;
      }
      // If primary needs more episodes, only allow the OTHER provider with the same audio
      if (isHinataSoulUrl(cand.url) === primaryIsHs) {
        continue;
      }
    }

    // For plain numbered seasons (no arc subtitle), skip already-covered seasons unless continuation Part 2+
    // or cross-provider backup for an incomplete primary season. Account for provider-vs-TheTVDB season shifts.
    const primaryHasSeasonShift =
      primaryInfo.seasonNumber !== null && primaryInfo.seasonNumber !== primarySeasonNumber;
    const isAlreadyCoveredPlainSeason =
      !effectiveInfo.normalizedSubtitle &&
      resolvedSeason > 0 &&
      (resolvedSeason === 1
        ? alreadyCoveredSeasons.has(1)
        : primaryHasSeasonShift
          ? resolvedSeason === primaryInfo.seasonNumber
          : alreadyCoveredSeasons.has(resolvedSeason));
    if (isAlreadyCoveredPlainSeason) {
      const allowSameSeasonFill =
        needMoreEpisodesInPrimarySeason &&
        resolvedSeason === (primaryHasSeasonShift ? primaryInfo.seasonNumber : primarySeasonNumber) &&
        (isContinuationPart || isHinataSoulUrl(cand.url) !== primaryIsHs);
      if (!allowSameSeasonFill) {
        continue;
      }
    }

    // Also skip subtitled arcs when the opened page has the exact same normalizedSubtitle
    if (
      primaryHasPlayableEpisodes &&
      effectiveInfo.normalizedSubtitle &&
      primaryInfo.normalizedSubtitle &&
      effectiveInfo.normalizedSubtitle === primaryInfo.normalizedSubtitle &&
      (resolvedPart || 1) === (primaryInfo.partNumber || 1)
    ) {
      if (!needMoreEpisodesInPrimarySeason || isHinataSoulUrl(cand.url) === primaryIsHs) {
        continue;
      }
    }

    const candAudio = info.audioType || 'LEG';
    const candIsHs = isHinataSoulUrl(cand.url);

    let totalScore = baseScore;
    if (candAudio === effectivePrimaryAudio) {
      totalScore += 0.35;
    } else if (effectivePrimaryAudio === 'DUB' && candAudio === 'LEG') {
      totalScore -= 0.05;
    } else if (effectivePrimaryAudio === 'LEG' && candAudio === 'DUB') {
      totalScore -= 0.18;
    }
    if (candIsHs === primaryIsHs) {
      totalScore += 0.15;
    }
    if (cand.year && /^\d{4}$/.test(cand.year)) {
      totalScore += 0.02;
    }

    const entry: MatchedSiblingSeason = {
      url: cand.url,
      title: cand.title,
      seasonNumber: resolvedSeason,
      partNumber: resolvedPart,
      audioType: effectiveInfo.audioType,
      isHinataSoul: candIsHs,
      score: totalScore,
      groupKey,
      subtitle: effectiveInfo.subtitle || undefined,
      normalizedSubtitle: effectiveInfo.normalizedSubtitle || undefined,
      explicitSeasonNumber: effectiveInfo.seasonNumber,
      isFinalSeason: effectiveInfo.isFinalSeason,
      year: cand.year || effectiveInfo.extractedYear || undefined,
    };

    const list = groupedCandidates.get(groupKey) || [];
    list.push(entry);
    groupedCandidates.set(groupKey, list);
  }

  const winners: MatchedSiblingSeason[] = [];
  for (const list of groupedCandidates.values()) {
    list.sort((a, b) => b.score - a.score);
    const best = list[0];
    // Keep up to 1 fallback candidate (preferring the alternate provider) in case the winner fails or returns 0 episodes
    const fallbacks = list
      .slice(1)
      .sort((a, b) => {
        const aAltProvider = a.isHinataSoul !== best.isHinataSoul ? 1 : 0;
        const bAltProvider = b.isHinataSoul !== best.isHinataSoul ? 1 : 0;
        if (aAltProvider !== bAltProvider) return bAltProvider - aAltProvider;
        return b.score - a.score;
      })
      .slice(0, 2);
    winners.push({
      ...best,
      fallbackCandidates: fallbacks.length > 0 ? fallbacks : undefined,
    });
  }

  return winners
    .sort((a, b) => {
      const aSortS = a.seasonNumber > 0 ? a.seasonNumber : 999;
      const bSortS = b.seasonNumber > 0 ? b.seasonNumber : 999;
      if (aSortS !== bSortS) return aSortS - bSortS;
      const aYear = parseYearInt(a.year) ?? 9999;
      const bYear = parseYearInt(b.year) ?? 9999;
      if (aYear !== bYear) return aYear - bYear;
      if ((a.partNumber || 1) !== (b.partNumber || 1)) {
        return (a.partNumber || 1) - (b.partNumber || 1);
      }
      return b.score - a.score;
    })
    .slice(0, 12);
}

function buildEpisodeSeasonLabel(
  seasonNumber: number,
  epNum: number | null,
  fallbackLabel?: string
): string {
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
    rebaseStartFromOne?: boolean;
  } = {}
): AnimeEpisodeLink[] {
  const { partOffset = 0, preserveMultiSeason = false, rebaseStartFromOne = false } = options;
  const distinctSeasons = new Set(episodes.map((e) => e.seasonNumber || 1));
  const keepOriginalSeasons = preserveMultiSeason && distinctSeasons.size > 1;

  let rebaseShift = 0;
  if (rebaseStartFromOne && !keepOriginalSeasons && partOffset === 0 && episodes.length > 0) {
    const nums = episodes
      .map((ep) => ep.episodeNumber ?? parseEpisodeNumberFromLabel(ep.numberLabel || ep.title))
      .filter((n): n is number => n !== null && n > 0);
    if (nums.length > 0) {
      const minEp = Math.min(...nums);
      if (minEp > 1) {
        rebaseShift = minEp - 1;
      }
    }
  }

  return episodes.map((ep) => {
    const rawEpNum = ep.episodeNumber ?? parseEpisodeNumberFromLabel(ep.numberLabel || ep.title);
    const sNum = keepOriginalSeasons ? ep.seasonNumber || 1 : targetSeason;
    const adjustedEpNum =
      rawEpNum !== null && !keepOriginalSeasons ? rawEpNum - rebaseShift + partOffset : rawEpNum;
    const needsRenumberedLabel =
      !keepOriginalSeasons &&
      (sNum > 1 || partOffset > 0 || rebaseShift > 0) &&
      (!ep.numberLabel ||
        /^\s*\d+\s*[-·]\s*\d+\s*$/.test(ep.numberLabel) ||
        /^\s*T\d+\s*[-·]\s*EP\.?\s*\d+\s*$/i.test(ep.numberLabel) ||
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

async function fetchSiblingServerDetails(
  fetchHttp: HttpFetcher,
  candidate: MatchedSiblingSeason
): Promise<AnimeDetails | null> {
  try {
    if (candidate.isHinataSoul) {
      const details = await fetchHinataSoulAnimeWithEpisodes(fetchHttp, candidate.url, {
        maxPages: 6,
        timeoutMs: 8000,
      });
      return details || null;
    }
    const origin = new URL(candidate.url).origin;
    const res = await fetchHttp(candidate.url, {
      referer: `${origin}/`,
      timeoutMs: 8000,
    });
    if (!res.ok) return null;
    return parseAnimePageHtml(res.body, candidate.url);
  } catch {
    return null;
  }
}

async function fetchSiblingGroupDetails(
  fetchHttp: HttpFetcher,
  candidate: MatchedSiblingSeason,
  tvdbMetas: readonly TvdbSeasonMeta[]
): Promise<{ cand: MatchedSiblingSeason; details: AnimeDetails } | null> {
  const currentYear = new Date().getUTCFullYear();
  const allTvdbSeasonsHaveMultipleAiredEps =
    tvdbMetas.length > 0 && tvdbMetas.every((m) => m.airedEpisodes >= 4);

  const attempts = [candidate, ...(candidate.fallbackCandidates || [])];
  for (const attempt of attempts) {
    const details = await fetchSiblingServerDetails(fetchHttp, attempt);
    if (!details) continue;
    if (details.kind === 'movie' || /\/filmes?\//i.test(details.url)) continue;
    const playable = details.episodes.filter(isEpisodeAvailableOnServer);
    if (playable.length === 0) continue;

    // Guard against a 1-episode theatrical movie mistakenly filed under /animes/ without "Filme" in the title:
    // skip it so the next fallback candidate (e.g. the real 7-ep TV arc on another provider) can be tried!
    const attemptInfo = extractSeasonAndPartInfo(
      details.title || attempt.title,
      details.url,
      details.audioType ?? attempt.audioType
    );
    const attemptTiming = extractPageYearAndEarliestTs(
      details,
      playable,
      attempt.year || attemptInfo.extractedYear
    );
    const looksLikeUnmarkedMovie =
      playable.length === 1 &&
      attemptInfo.hasColonSubtitle &&
      attemptInfo.seasonNumber === null &&
      !attemptInfo.isFinalSeason &&
      attemptTiming.year !== null &&
      attemptTiming.year < currentYear &&
      allTvdbSeasonsHaveMultipleAiredEps;
    if (looksLikeUnmarkedMovie) continue;

    return { cand: attempt, details: { ...details, episodes: playable } };
  }
  return null;
}

function extractPageYearAndEarliestTs(
  details: AnimeDetails,
  episodes: readonly AnimeEpisodeLink[],
  fallbackYear?: string | null
): { year: number | null; earliestEpTs: number | null } {
  let earliestEpTs: number | null = null;
  let earliestEpYear: number | null = null;

  for (const ep of episodes) {
    const ts = ep.airingAt ?? parseEpisodeDateToTimestampSec(ep.date);
    if (ts && ts > 0) {
      if (earliestEpTs === null || ts < earliestEpTs) {
        earliestEpTs = ts;
        earliestEpYear = new Date(ts * 1000).getUTCFullYear();
      }
    } else if (earliestEpYear === null && ep.date) {
      earliestEpYear = parseYearInt(ep.date);
    }
  }

  const year =
    parseYearInt(details.year) ??
    parseYearInt(details.firstAirDate) ??
    earliestEpYear ??
    parseYearInt(fallbackYear);

  return { year, earliestEpTs };
}

/**
 * Scores how well a fetched single-season server page matches a specific TheTVDB season using
 * air year, earliest episode timestamp, episode count vs aired/total count, and title season markers.
 */
function scorePageToTvdbSeason(
  page: AlignableServerPage,
  tvdbSeason: TvdbSeasonMeta,
  allTvdbMetas: readonly TvdbSeasonMeta[]
): number {
  let score = 0;

  const epCount = page.episodes.length;
  const expected = tvdbSeason.airedEpisodes > 0 ? tvdbSeason.airedEpisodes : tvdbSeason.totalEpisodes;
  const tvdbS1Year = allTvdbMetas[0]?.startYear ?? null;
  const maxTvdbSeason = allTvdbMetas[allTvdbMetas.length - 1]?.seasonNumber ?? 1;

  // 1. Air year & exact timestamp alignment
  if (page.year !== null && tvdbSeason.startYear !== null) {
    if (page.year === tvdbSeason.startYear) {
      score += 45;
    } else if (tvdbSeason.allYears.has(page.year)) {
      score += 32;
    } else if (Math.abs(page.year - tvdbSeason.startYear) === 1) {
      score += 8;
    } else if (
      page.year < tvdbSeason.startYear - 1 &&
      tvdbS1Year !== null &&
      page.year === tvdbS1Year &&
      page.info.seasonNumber === tvdbSeason.seasonNumber &&
      !page.info.hasColonSubtitle
    ) {
      // Common streaming site typo: Season 2+ page copied Season 1's premiere year
      score -= 10;
    } else {
      score -= 60;
    }
  }

  if (page.earliestEpTs !== null && tvdbSeason.startTs !== null) {
    const daysDiff = Math.abs(page.earliestEpTs - tvdbSeason.startTs) / 86400;
    if (daysDiff <= 45) score += 22;
    else if (daysDiff <= 100) score += 10;
    else if (daysDiff >= 300) score -= 15;
  }

  // 2. Episode count alignment (cleanly separates same-year arcs like 7-ep Mugen Train vs 11-ep Yuukaku-hen!)
  if (tvdbSeason.totalEpisodes > 0 && epCount > 0) {
    if (epCount === expected || epCount === tvdbSeason.totalEpisodes) {
      score += 35;
    } else if (
      Math.abs(epCount - expected) === 1 ||
      Math.abs(epCount - tvdbSeason.totalEpisodes) === 1
    ) {
      score += 24;
    } else if (epCount > tvdbSeason.totalEpisodes) {
      const excess = epCount - tvdbSeason.totalEpisodes;
      if (excess <= 2) score -= 8;
      else score -= 45;
    } else {
      const isOngoingSeason = tvdbSeason.airedEpisodes < tvdbSeason.totalEpisodes;
      if (tvdbSeason.airedEpisodes > 0 && Math.abs(epCount - tvdbSeason.airedEpisodes) <= 2) {
        score += 24;
      } else if (isOngoingSeason) {
        score += 10;
      } else {
        const ratio = epCount / Math.max(1, expected);
        if (ratio >= 0.75) score += 8;
        else if (ratio >= 0.4) score -= 4;
        else score -= 28;
      }
    }
  }

  // 3. Title season / base / Final Season / arc-subtitle hints
  const isPlainBase =
    page.isExactSeriesBase &&
    page.info.seasonNumber === null &&
    !page.info.isFinalSeason &&
    page.info.partNumber === null;

  if (isPlainBase) {
    score += tvdbSeason.seasonNumber === 1 ? 38 : -35;
  } else if (page.info.isFinalSeason) {
    if (tvdbSeason.seasonNumber === maxTvdbSeason) score += 38;
    else if (tvdbSeason.seasonNumber === maxTvdbSeason - 1) score += 4;
    else score -= 38;
  } else if (page.info.seasonNumber !== null) {
    const diff = tvdbSeason.seasonNumber - page.info.seasonNumber;
    if (diff === 0) {
      score += 28;
    } else if (diff === 1 && page.info.hasColonSubtitle) {
      // Gracefully allows +1 shift when an earlier arc (e.g. Mugen Train TV) is its own TheTVDB season
      score += 14;
    } else if (diff === 1) {
      score += 5;
    } else if (diff === 2 && page.info.hasColonSubtitle) {
      score += 0;
    } else if (diff === -1) {
      score -= 10;
    } else {
      score -= 38;
    }
  } else if (page.info.hasColonSubtitle && allTvdbMetas.length > 1) {
    // Subtitled arc without an explicit season number usually belongs to Season 2+
    score += tvdbSeason.seasonNumber > 1 ? 6 : -12;
  }

  // 4. Priority tie-breakers (primary opened page + audio/provider match)
  if (page.isPrimary) score += 3;
  score += page.audioBonus;

  return score;
}

/**
 * Exact maximum-weight 1-to-1 bipartite assignment (Hungarian / Kuhn-Munkres algorithm).
 * Requires `numRows <= numCols` and all weights finite.
 */
function solveMaxWeightAssignment(weights: readonly (readonly number[])[]): number[] {
  const numRows = weights.length;
  if (numRows === 0) return [];
  const numCols = weights[0].length;
  let maxW = -Infinity;
  for (let i = 0; i < numRows; i += 1) {
    for (let j = 0; j < numCols; j += 1) {
      if (weights[i][j] > maxW) maxW = weights[i][j];
    }
  }

  const u = new Array<number>(numRows + 1).fill(0);
  const v = new Array<number>(numCols + 1).fill(0);
  const p = new Array<number>(numCols + 1).fill(0);
  const way = new Array<number>(numCols + 1).fill(0);

  for (let i = 1; i <= numRows; i += 1) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(numCols + 1).fill(Infinity);
    const used = new Array<boolean>(numCols + 1).fill(false);

    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= numCols; j += 1) {
        if (used[j]) continue;
        const cur = maxW - weights[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= numCols; j += 1) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);

    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }

  const rowToCol = new Array<number>(numRows).fill(-1);
  for (let j = 1; j <= numCols; j += 1) {
    if (p[j] > 0) {
      rowToCol[p[j] - 1] = j - 1;
    }
  }
  return rowToCol;
}

/**
 * Globally aligns fetched single-season server pages onto available TheTVDB seasons 1-to-1
 * so provider season numbering shifts (e.g. Kimetsu no Yaiba MAL 1..4 vs TheTVDB 1..5) and
 * same-year multi-arc seasons (Mugen Train 7 eps + Yuukaku-hen 11 eps) map with zero collisions.
 */
function alignPagesToTvdbSeasons(
  pages: readonly AlignableServerPage[],
  availableTvdbMetas: readonly TvdbSeasonMeta[],
  allTvdbMetas: readonly TvdbSeasonMeta[]
): Map<string, number> {
  const assigned = new Map<string, number>();
  if (!pages.length || !availableTvdbMetas.length) return assigned;

  const numPages = pages.length;
  const numSeasons = availableTvdbMetas.length;
  const numCols = numSeasons + numPages; // last `numPages` columns = "unassigned"

  const SIBLING_MIN_SCORE = 10;
  const PRIMARY_MIN_SCORE = -30;

  const matrix: number[][] = [];
  for (let i = 0; i < numPages; i += 1) {
    const page = pages[i];
    const row = new Array<number>(numCols).fill(-10000);
    for (let j = 0; j < numSeasons; j += 1) {
      const s = scorePageToTvdbSeason(page, availableTvdbMetas[j], allTvdbMetas);
      row[j] = s;
    }
    // Diagonal unassigned column with threshold weight
    row[numSeasons + i] = page.isPrimary ? PRIMARY_MIN_SCORE - 0.1 : SIBLING_MIN_SCORE - 0.1;
    matrix.push(row);
  }

  const rowToCol = solveMaxWeightAssignment(matrix);
  for (let i = 0; i < numPages; i += 1) {
    const col = rowToCol[i];
    if (col >= 0 && col < numSeasons) {
      const minThreshold = pages[i].isPrimary ? PRIMARY_MIN_SCORE : SIBLING_MIN_SCORE;
      if (matrix[i][col] >= minThreshold) {
        assigned.set(pages[i].id, availableTvdbMetas[col].seasonNumber);
      }
    }
  }

  return assigned;
}

function buildSearchQueries(
  primaryInfo: ParsedSeasonTitleInfo,
  extraReferenceTitles: readonly string[]
): string[] {
  const rawCandidates: string[] = [];

  // Prefer the cleanest series prefix first (e.g. "Kimetsu no Yaiba" even when opened on "Kimetsu no Yaiba 3: Katanakaji no Sato-hen" or "Kimetsu no Yaiba: Mugen Ressha-hen")
  if (
    primaryInfo.hasColonSubtitle &&
    primaryInfo.prefixBeforeSubtitle.length >= 4 &&
    (primaryInfo.normalizedPrefixBeforeSubtitle.length >= 8 ||
      primaryInfo.normalizedPrefixBeforeSubtitle.split(' ').length >= 2)
  ) {
    rawCandidates.push(primaryInfo.prefixBeforeSubtitle);
  }
  rawCandidates.push(primaryInfo.baseTitle);

  for (const ref of extraReferenceTitles) {
    if (!ref || !ref.trim()) continue;
    const info = extractSeasonAndPartInfo(ref);
    if (
      info.hasColonSubtitle &&
      info.prefixBeforeSubtitle.length >= 4 &&
      (info.normalizedPrefixBeforeSubtitle.length >= 8 ||
        info.normalizedPrefixBeforeSubtitle.split(' ').length >= 2)
    ) {
      rawCandidates.push(info.prefixBeforeSubtitle);
    }
    rawCandidates.push(info.baseTitle);
    // Bilingual title second half (e.g. "Demon Slayer: Kimetsu no Yaiba" -> "Kimetsu no Yaiba")
    if (
      info.hasColonSubtitle &&
      info.subtitle.length >= 6 &&
      info.normalizedSubtitle.split(' ').length >= 2 &&
      !hasSpinOffMarker(info.normalizedSubtitle)
    ) {
      rawCandidates.push(info.subtitle);
    }
  }

  // Deduplicate and prioritize Latin-script queries (TopAnimes & Hinata Soul index Latin/romanized titles)
  const latin: string[] = [];
  const other: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawCandidates) {
    const cleaned = cleanWhitespace(raw);
    if (cleaned.length < 3) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (hasLatinLetters(cleaned)) latin.push(cleaned);
    else other.push(cleaned);
  }

  return [...latin, ...other].slice(0, 3);
}

/**
 * Discovers and merges sibling season/arc pages across integrated streaming providers (TopAnimes &
 * Hinata Soul) so every anime detail page displays ALL available seasons organized in one unified view.
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
  const externalRefNormalizedBases = buildExternalReferenceNormalizedBases(extraReferenceTitles);
  const primaryIsExactBase = isExactBaseMatchToRefs(primaryInfo, externalRefNormalizedBases);

  const tvdbMetas = buildTvdbSeasonMetas(catalogEpisodes);
  const tvdbSeasons = tvdbMetas.map((m) => m.seasonNumber);
  const maxTvdbSeason = tvdbSeasons.length > 0 ? tvdbSeasons[tvdbSeasons.length - 1] : 0;
  const tvdbMetaBySeason = new Map(tvdbMetas.map((m) => [m.seasonNumber, m]));

  const playablePrimaryEps = serverDetails.episodes.filter(isEpisodeAvailableOnServer);
  const rawPrimarySeasons = new Set(playablePrimaryEps.map((e) => e.seasonNumber || 1));
  const primaryIsSingleFlatSeason = rawPrimarySeasons.size <= 1;

  // Estimate the opened page's season number against TheTVDB using full metadata (year + episode count + title!)
  const primaryMetaTiming = extractPageYearAndEarliestTs(
    serverDetails,
    playablePrimaryEps,
    primaryInfo.extractedYear
  );

  // Detect continuous absolute numbering (e.g. One Piece 1..1120 or Black Clover 1..170 in 1 flat list)
  const rawPrimaryMaxEp = playablePrimaryEps.reduce(
    (m, e) => Math.max(m, e.episodeNumber ?? parseEpisodeNumberFromLabel(e.numberLabel || e.title) ?? 0),
    0
  );
  const catalogS1Max = tvdbMetaBySeason.get(1)?.maxEpisodeNumber ?? 0;
  const usesContinuousAbsolute =
    primaryIsSingleFlatSeason &&
    primaryInfo.seasonNumber === null &&
    !primaryInfo.isFinalSeason &&
    primaryIsExactBase &&
    catalogS1Max > 0 &&
    rawPrimaryMaxEp > catalogS1Max;

  let primarySeasonNumber = 1;
  if (primaryIsSingleFlatSeason && !usesContinuousAbsolute) {
    if (tvdbMetas.length > 0 && playablePrimaryEps.length > 0) {
      const soloPrimaryPage: AlignableServerPage = {
        id: '__primary__',
        isPrimary: true,
        details: serverDetails,
        info: primaryInfo,
        episodes: playablePrimaryEps,
        year: primaryMetaTiming.year,
        earliestEpTs: primaryMetaTiming.earliestEpTs,
        groupKey: computeCandidateGroupKey(primaryInfo, primaryIsExactBase, 1),
        audioBonus: 1,
        isExactSeriesBase: primaryIsExactBase,
        isMultiSeasonPage: false,
      };
      const initialAlign = alignPagesToTvdbSeasons([soloPrimaryPage], tvdbMetas, tvdbMetas);
      const alignedPrimary = initialAlign.get('__primary__');
      if (alignedPrimary !== undefined) {
        primarySeasonNumber = alignedPrimary;
      } else if (primaryInfo.isFinalSeason) {
        primarySeasonNumber = maxTvdbSeason > 1 ? maxTvdbSeason : 2;
      } else if (primaryInfo.seasonNumber !== null && primaryInfo.seasonNumber > 0) {
        primarySeasonNumber = primaryInfo.seasonNumber;
      } else if (rawPrimarySeasons.size === 1) {
        primarySeasonNumber = Array.from(rawPrimarySeasons)[0];
      }
    } else if (primaryInfo.isFinalSeason) {
      primarySeasonNumber = maxTvdbSeason > 1 ? maxTvdbSeason : 2;
    } else if (primaryInfo.seasonNumber !== null && primaryInfo.seasonNumber > 0) {
      primarySeasonNumber = primaryInfo.seasonNumber;
    } else if (rawPrimarySeasons.size === 1) {
      primarySeasonNumber = Array.from(rawPrimarySeasons)[0];
    }
  }

  // Determine which seasons are already covered by the opened page
  const coveredSeasons = new Set<number>();
  if (usesContinuousAbsolute) {
    const sortedCatalog = [...catalogEpisodes].sort(
      (a, b) =>
        (a.seasonNumber || 1) - (b.seasonNumber || 1) ||
        (a.episodeNumber || 0) - (b.episodeNumber || 0)
    );
    sortedCatalog.forEach((ep, idx) => {
      if (idx + 1 <= rawPrimaryMaxEp) {
        coveredSeasons.add(ep.seasonNumber || 1);
      }
    });
    if (coveredSeasons.size === 0) coveredSeasons.add(1);
  } else if (primaryIsSingleFlatSeason) {
    if (playablePrimaryEps.length > 0) {
      coveredSeasons.add(primarySeasonNumber);
    }
  } else {
    for (const s of rawPrimarySeasons) coveredSeasons.add(s);
  }

  // Check if primary season has significantly fewer episodes than already-aired TheTVDB episodes (e.g. split-cour Part 1)
  const primarySeasonMeta = tvdbMetaBySeason.get(primarySeasonNumber);
  const airedInPrimarySeason = primarySeasonMeta?.airedEpisodes ?? 0;
  const primarySeasonEpCount = primaryIsSingleFlatSeason
    ? playablePrimaryEps.length
    : playablePrimaryEps.filter((e) => (e.seasonNumber || 1) === primarySeasonNumber).length;
  const needMoreEpisodesInPrimarySeason =
    primarySeasonEpCount > 0 && airedInPrimarySeason >= primarySeasonEpCount + 3;

  const hasMissingTvdbSeasons = tvdbSeasons.some((s) => !coveredSeasons.has(s));
  const shouldSearchSiblings =
    hasMissingTvdbSeasons ||
    primarySeasonNumber > 1 ||
    primaryInfo.seasonNumber !== null ||
    primaryInfo.isFinalSeason ||
    primaryInfo.partNumber !== null ||
    (primaryInfo.hasColonSubtitle && !primaryIsExactBase) ||
    needMoreEpisodesInPrimarySeason ||
    catalogEpisodes.length === 0 ||
    playablePrimaryEps.length === 0;

  const buildFallbackNormalizedPrimary = (): AnimeEpisodeLink[] =>
    primaryIsSingleFlatSeason
      ? normalizeEpisodesForSeason(playablePrimaryEps, primarySeasonNumber)
      : normalizeEpisodesForSeason(playablePrimaryEps, 1, { preserveMultiSeason: true });

  if (!shouldSearchSiblings) {
    return {
      serverEpisodes: buildFallbackNormalizedPrimary(),
      unifiedTitle: serverDetails.title,
      unifiedSeasonCount: Math.max(1, coveredSeasons.size, tvdbSeasons.length),
      addedSeasonPages: 0,
      primarySeasonNumber,
    };
  }

  const searchQueries = buildSearchQueries(primaryInfo, extraReferenceTitles);
  if (!searchQueries.length) {
    return {
      serverEpisodes: buildFallbackNormalizedPrimary(),
      unifiedTitle: serverDetails.title,
      unifiedSeasonCount: Math.max(1, coveredSeasons.size, tvdbSeasons.length),
      addedSeasonPages: 0,
      primarySeasonNumber,
    };
  }

  // Collect provider search candidates (seeding free relation cards from the opened page if available)
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

  if (serverDetails.relations?.length) {
    addResults(
      serverDetails.relations.map((rel) => ({
        id: rel.id,
        title: rel.title,
        url: rel.url,
        kind: rel.kind,
        poster: rel.poster,
        year: rel.year,
        audioType: rel.audioType,
        catalogSource: rel.catalogSource,
        sourceServerName: rel.sourceServerName,
      }))
    );
  }

  const runCandidateMatch = () =>
    matchSiblingSeasonCandidates({
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
      primaryHasPlayableEpisodes: playablePrimaryEps.length > 0,
    });

  const primaryQuery = searchQueries[0];
  const [fullPrimary, suggestPrimary] = await Promise.all([
    getServerSearch(fetchHttp, primaryQuery, 1).catch(() => null),
    getServerSearchSuggest(fetchHttp, primaryQuery).catch(() => null),
  ]);
  if (fullPrimary?.results?.length) addResults(fullPrimary.results);
  if (suggestPrimary?.results?.length) addResults(suggestPrimary.results);

  let matchedSiblings = runCandidateMatch();

  const needsMoreCandidates = (matched: readonly MatchedSiblingSeason[]): boolean => {
    if (tvdbSeasons.length > 0) {
      const uncoveredCount = tvdbSeasons.filter((s) => !coveredSeasons.has(s)).length;
      const nonPartMatched = matched.filter((m) => !m.partNumber || m.partNumber === 1).length;
      if (nonPartMatched < uncoveredCount) return true;
    }
    if (
      (primarySeasonNumber > 1 || (primaryInfo.hasColonSubtitle && !primaryIsExactBase)) &&
      !matched.some((m) => m.seasonNumber === 1)
    ) {
      return true;
    }
    return false;
  };

  // Fetch Page 2 (for large franchises with 10+ LEG/DUB/movie entries like Kimetsu no Yaiba)
  // and/or alternate title query (e.g. "Demon Slayer" vs "Kimetsu no Yaiba") in parallel if still missing seasons
  if (needsMoreCandidates(matchedSiblings)) {
    const extraTasks: Array<Promise<SearchResultItem[]>> = [];

    if (fullPrimary && fullPrimary.totalPages > 1) {
      extraTasks.push(
        getServerSearch(fetchHttp, primaryQuery, 2)
          .then((r) => r?.results || [])
          .catch(() => [])
      );
      if (fullPrimary.totalPages >= 3 && tvdbSeasons.length >= 4) {
        extraTasks.push(
          getServerSearch(fetchHttp, primaryQuery, 3)
            .then((r) => r?.results || [])
            .catch(() => [])
        );
      }
    }

    if (searchQueries.length > 1) {
      const altQuery = searchQueries[1];
      extraTasks.push(
        getServerSearch(fetchHttp, altQuery, 1)
          .then((r) => r?.results || [])
          .catch(() => [])
      );
      extraTasks.push(
        getServerSearchSuggest(fetchHttp, altQuery)
          .then((r) => r?.results || [])
          .catch(() => [])
      );
    }

    if (extraTasks.length > 0) {
      const extraSettled = await Promise.all(extraTasks);
      for (const batch of extraSettled) {
        if (batch.length) addResults(batch);
      }
      matchedSiblings = runCandidateMatch();
    }
  }

  // Third fallback query if still missing seasons (e.g. bilingual subtitle query)
  if (needsMoreCandidates(matchedSiblings) && searchQueries.length > 2) {
    const thirdQuery = searchQueries[2];
    const [fullThird, suggestThird] = await Promise.all([
      getServerSearch(fetchHttp, thirdQuery, 1).catch(() => null),
      getServerSearchSuggest(fetchHttp, thirdQuery).catch(() => null),
    ]);
    if (fullThird?.results?.length) addResults(fullThird.results);
    if (suggestThird?.results?.length) addResults(suggestThird.results);
    matchedSiblings = runCandidateMatch();
  }

  if (!matchedSiblings.length) {
    return {
      serverEpisodes: buildFallbackNormalizedPrimary(),
      unifiedTitle: serverDetails.title,
      unifiedSeasonCount: Math.max(1, coveredSeasons.size, tvdbSeasons.length),
      addedSeasonPages: 0,
      primarySeasonNumber,
    };
  }

  // Fetch full AnimeDetails for each sibling group (with automatic fallback inside the group if #1 fails/is empty)
  const fetchedSiblings: Array<{
    cand: MatchedSiblingSeason;
    details: AnimeDetails;
    info: ParsedSeasonTitleInfo;
    year: number | null;
    earliestEpTs: number | null;
    isExactSeriesBase: boolean;
    isMultiSeasonPage: boolean;
  }> = [];

  for (let i = 0; i < matchedSiblings.length; i += 4) {
    const batch = matchedSiblings.slice(i, i + 4);
    const settled = await Promise.all(
      batch.map((cand) => fetchSiblingGroupDetails(fetchHttp, cand, tvdbMetas))
    );
    for (const entry of settled) {
      if (!entry) continue;
      const { cand, details } = entry;
      const rawInfo = extractSeasonAndPartInfo(
        details.title || cand.title,
        details.url,
        details.audioType ?? cand.audioType
      );
      const info: ParsedSeasonTitleInfo =
        !rawInfo.normalizedSubtitle && cand.normalizedSubtitle
          ? {
              ...rawInfo,
              hasColonSubtitle: true,
              subtitle: rawInfo.subtitle || cand.subtitle || cand.normalizedSubtitle,
              normalizedSubtitle: cand.normalizedSubtitle,
              seasonNumber: rawInfo.seasonNumber ?? cand.explicitSeasonNumber ?? null,
            }
          : rawInfo;
      const timing = extractPageYearAndEarliestTs(
        details,
        details.episodes,
        cand.year || info.extractedYear
      );
      const distinctRawSeasons = new Set(details.episodes.map((e) => e.seasonNumber || 1));

      fetchedSiblings.push({
        cand,
        details,
        info,
        year: timing.year,
        earliestEpTs: timing.earliestEpTs,
        isExactSeriesBase: isExactBaseMatchToRefs(info, externalRefNormalizedBases),
        isMultiSeasonPage: distinctRawSeasons.size > 1,
      });
    }
  }

  if (!fetchedSiblings.length) {
    return {
      serverEpisodes: buildFallbackNormalizedPrimary(),
      unifiedTitle: serverDetails.title,
      unifiedSeasonCount: Math.max(1, coveredSeasons.size, tvdbSeasons.length),
      addedSeasonPages: 0,
      primarySeasonNumber,
    };
  }

  // Separate main season pages vs continuation Part 2+ split-cour pages
  const mainSiblings = fetchedSiblings.filter(
    (s) => !(s.info.partNumber && s.info.partNumber > 1) && !(s.cand.partNumber && s.cand.partNumber > 1)
  );
  const continuationSiblings = fetchedSiblings.filter(
    (s) => Boolean((s.info.partNumber && s.info.partNumber > 1) || (s.cand.partNumber && s.cand.partNumber > 1))
  );

  // Resolve authoritative season numbers for primary + main sibling pages
  const assignedSeasonById = new Map<string, number>();

  if (tvdbMetas.length > 0) {
    // Exclude seasons already covered by a multi-season primary page or continuous absolute numbering
    const lockedSeasons = new Set<number>();
    if (usesContinuousAbsolute || !primaryIsSingleFlatSeason) {
      for (const s of coveredSeasons) lockedSeasons.add(s);
    }

    const alignablePages: AlignableServerPage[] = [];
    if (primaryIsSingleFlatSeason && !usesContinuousAbsolute && playablePrimaryEps.length > 0) {
      alignablePages.push({
        id: '__primary__',
        isPrimary: true,
        details: serverDetails,
        info: primaryInfo,
        episodes: playablePrimaryEps,
        year: primaryMetaTiming.year,
        earliestEpTs: primaryMetaTiming.earliestEpTs,
        groupKey: computeCandidateGroupKey(primaryInfo, primaryIsExactBase, primarySeasonNumber),
        audioBonus: 2,
        isExactSeriesBase: primaryIsExactBase,
        isMultiSeasonPage: false,
      });
    }

    mainSiblings.forEach((sib, idx) => {
      if (sib.isMultiSeasonPage) return;
      alignablePages.push({
        id: `sib:${idx}`,
        isPrimary: false,
        details: sib.details,
        info: sib.info,
        episodes: sib.details.episodes,
        year: sib.year,
        earliestEpTs: sib.earliestEpTs,
        groupKey: sib.cand.groupKey || `sib:${idx}`,
        audioBonus: Math.max(0, Math.min(2, sib.cand.score)),
        isExactSeriesBase: sib.isExactSeriesBase,
        isMultiSeasonPage: false,
      });
    });

    const availableMetas = tvdbMetas.filter((m) => !lockedSeasons.has(m.seasonNumber));
    const optimal = alignPagesToTvdbSeasons(alignablePages, availableMetas, tvdbMetas);

    for (const [id, s] of optimal.entries()) {
      assignedSeasonById.set(id, s);
    }

    // Update primarySeasonNumber from the joint global assignment (joint alignment is even more accurate than solo!)
    const jointPrimarySeason = optimal.get('__primary__');
    if (jointPrimarySeason !== undefined) {
      primarySeasonNumber = jointPrimarySeason;
    }

    // For incomplete primary season where a cross-provider backup fetched the SAME season, allow it to fill missing episodes
    if (needMoreEpisodesInPrimarySeason) {
      mainSiblings.forEach((sib, idx) => {
        const id = `sib:${idx}`;
        if (assignedSeasonById.has(id) || sib.isMultiSeasonPage) return;
        const primaryKey = computeCandidateGroupKey(
          primaryInfo,
          primaryIsExactBase,
          primarySeasonNumber
        );
        if (sib.cand.groupKey === primaryKey && sib.details.episodes.length > playablePrimaryEps.length) {
          assignedSeasonById.set(id, primarySeasonNumber);
        }
      });
    }
  } else {
    // No TheTVDB metadata available -> assign deterministically by explicit season & chronological year with zero duplicates
    assignedSeasonById.set('__primary__', primarySeasonNumber);
    const usedNoTvdbSeasons = new Set<number>(
      primaryIsSingleFlatSeason ? [primarySeasonNumber] : Array.from(rawPrimarySeasons)
    );

    // First assign siblings with explicit seasonNumber or exact base (S1)
    const unnumberedArcSiblings: Array<{ idx: number; year: number }> = [];
    mainSiblings.forEach((sib, idx) => {
      const id = `sib:${idx}`;
      if (sib.isMultiSeasonPage) return;
      if (sib.isExactSeriesBase && sib.info.seasonNumber === null && !sib.info.isFinalSeason) {
        if (!usedNoTvdbSeasons.has(1)) {
          assignedSeasonById.set(id, 1);
          usedNoTvdbSeasons.add(1);
        }
      } else if (sib.info.seasonNumber !== null && !usedNoTvdbSeasons.has(sib.info.seasonNumber)) {
        assignedSeasonById.set(id, sib.info.seasonNumber);
        usedNoTvdbSeasons.add(sib.info.seasonNumber);
      } else if (sib.info.isFinalSeason) {
        const nextS = Math.max(2, ...Array.from(usedNoTvdbSeasons)) + 1;
        assignedSeasonById.set(id, nextS);
        usedNoTvdbSeasons.add(nextS);
      } else if (sib.info.hasColonSubtitle && sib.info.seasonNumber === null) {
        unnumberedArcSiblings.push({ idx, year: sib.year ?? 9999 });
      }
    });

    // Then assign unnumbered subtitled arcs in chronological year order to free season numbers >= 2
    unnumberedArcSiblings.sort((a, b) => a.year - b.year);
    for (const item of unnumberedArcSiblings) {
      let nextS = 2;
      while (usedNoTvdbSeasons.has(nextS)) nextS += 1;
      assignedSeasonById.set(`sib:${item.idx}`, nextS);
      usedNoTvdbSeasons.add(nextS);
    }
  }

  // Normalize primary episodes with their final authoritative season number
  const normalizedPrimaryEps = primaryIsSingleFlatSeason
    ? normalizeEpisodesForSeason(playablePrimaryEps, primarySeasonNumber)
    : normalizeEpisodesForSeason(playablePrimaryEps, 1, { preserveMultiSeason: true });

  // Merge primary + assigned sibling episodes, never overwriting any (season, episode) already present in primary
  const mergedEpisodes: AnimeEpisodeLink[] = [...normalizedPrimaryEps];
  const seenSeasonEp = new Set<string>();
  const seenUrls = new Set<string>();
  const maxEpBySeason = new Map<number, number>();
  const assignedSeasonBySubtitle = new Map<string, number>();
  const assignedSeasonByExplicitNum = new Map<number, number>();

  if (primaryInfo.normalizedSubtitle && primaryIsSingleFlatSeason) {
    assignedSeasonBySubtitle.set(primaryInfo.normalizedSubtitle, primarySeasonNumber);
  }
  if (primaryInfo.seasonNumber !== null && primaryIsSingleFlatSeason) {
    assignedSeasonByExplicitNum.set(primaryInfo.seasonNumber, primarySeasonNumber);
  }

  for (const ep of normalizedPrimaryEps) {
    const s = ep.seasonNumber || 1;
    const n = ep.episodeNumber;
    if (n !== null) {
      seenSeasonEp.add(`${s}:${n}`);
      maxEpBySeason.set(s, Math.max(maxEpBySeason.get(s) || 0, n));
    }
    if (ep.url) seenUrls.add(canonicalServerUrl(ep.url));
  }

  const appendNormalizedEpisodes = (eps: readonly AnimeEpisodeLink[]): number => {
    let added = 0;
    for (const ep of eps) {
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
      added += 1;
    }
    return added;
  };

  let addedSeasonPages = 0;

  // 1. Append all assigned main sibling pages
  mainSiblings.forEach((sib, idx) => {
    const id = `sib:${idx}`;
    if (sib.isMultiSeasonPage) {
      const normalizedMulti = normalizeEpisodesForSeason(sib.details.episodes, 1, {
        preserveMultiSeason: true,
      });
      if (appendNormalizedEpisodes(normalizedMulti) > 0) {
        addedSeasonPages += 1;
      }
      return;
    }

    const targetSeason = assignedSeasonById.get(id);
    if (!targetSeason || targetSeason < 1) return;

    if (sib.info.normalizedSubtitle) {
      assignedSeasonBySubtitle.set(sib.info.normalizedSubtitle, targetSeason);
    }
    if (sib.info.seasonNumber !== null) {
      assignedSeasonByExplicitNum.set(sib.info.seasonNumber, targetSeason);
    }

    // Detect disjoint continuous numbering on a Season 2+ page (e.g. eps 27..37 for a TheTVDB season numbered 1..11)
    const targetMeta = tvdbMetaBySeason.get(targetSeason);
    let rebaseStartFromOne = false;
    if (targetSeason > 1 && targetMeta && targetMeta.minEpisodeNumber === 1 && targetMeta.maxEpisodeNumber > 0) {
      const epNums = sib.details.episodes
        .map((e) => e.episodeNumber ?? parseEpisodeNumberFromLabel(e.numberLabel || e.title))
        .filter((n): n is number => n !== null && n > 0);
      if (epNums.length >= 2 && Math.min(...epNums) > targetMeta.maxEpisodeNumber) {
        rebaseStartFromOne = true;
      }
    }

    const normalizedSibling = normalizeEpisodesForSeason(sib.details.episodes, targetSeason, {
      preserveMultiSeason: false,
      rebaseStartFromOne,
    });

    if (appendNormalizedEpisodes(normalizedSibling) > 0) {
      addedSeasonPages += 1;
    }
  });

  // 2. Append split-cour continuation Part 2+ pages (e.g. "Spy x Family Part 2", "Dr. Stone: New World Part 2")
  continuationSiblings.sort(
    (a, b) =>
      (a.info.partNumber || a.cand.partNumber || 2) - (b.info.partNumber || b.cand.partNumber || 2)
  );

  for (const sib of continuationSiblings) {
    let targetSeason = primarySeasonNumber;
    if (sib.info.normalizedSubtitle && assignedSeasonBySubtitle.has(sib.info.normalizedSubtitle)) {
      targetSeason = assignedSeasonBySubtitle.get(sib.info.normalizedSubtitle)!;
    } else if (sib.info.seasonNumber !== null) {
      targetSeason = assignedSeasonByExplicitNum.get(sib.info.seasonNumber) ?? sib.info.seasonNumber;
    } else if (sib.info.isFinalSeason && maxTvdbSeason > 1) {
      targetSeason = maxTvdbSeason;
    } else if (sib.cand.seasonNumber > 0) {
      targetSeason = sib.cand.seasonNumber;
    }

    let partOffset = 0;
    const epNums = sib.details.episodes
      .map((e) => e.episodeNumber ?? parseEpisodeNumberFromLabel(e.numberLabel || e.title))
      .filter((n): n is number => n !== null && n > 0);
    const minEp = epNums.length > 0 ? Math.min(...epNums) : 1;
    const existingMax = maxEpBySeason.get(targetSeason) || 0;

    if (minEp <= existingMax && existingMax > 0) {
      const catalogSeasonCount = tvdbMetaBySeason.get(targetSeason)?.totalEpisodes ?? 0;
      const seasonTaken = new Set(mergedEpisodes.map((e) => e.seasonNumber || 1));
      if (catalogSeasonCount >= existingMax + Math.min(sib.details.episodes.length, 4)) {
        // TheTVDB groups Part 1 + Part 2 inside the same season -> offset Part 2 numbers after Part 1!
        partOffset = existingMax;
      } else if (!seasonTaken.has(targetSeason + 1)) {
        // TheTVDB splits Part 2 into the next season
        targetSeason = targetSeason + 1;
      }
    }

    const normalizedPart = normalizeEpisodesForSeason(sib.details.episodes, targetSeason, {
      partOffset,
      preserveMultiSeason: false,
    });
    if (appendNormalizedEpisodes(normalizedPart) > 0) {
      addedSeasonPages += 1;
    }
  }

  mergedEpisodes.sort(
    (a, b) =>
      (a.seasonNumber || 1) - (b.seasonNumber || 1) ||
      (a.episodeNumber || 0) - (b.episodeNumber || 0)
  );

  const distinctUnifiedSeasons = new Set(mergedEpisodes.map((e) => e.seasonNumber || 1));
  const unifiedMultiple = distinctUnifiedSeasons.size > 1 || addedSeasonPages > 0;
  const shouldCleanSubtitledArc =
    unifiedMultiple &&
    primaryInfo.hasColonSubtitle &&
    !primaryIsExactBase &&
    primaryInfo.prefixBeforeSubtitle.length >= 4;
  const shouldCleanSeasonSuffix =
    unifiedMultiple &&
    (primaryInfo.seasonNumber !== null ||
      primaryInfo.isFinalSeason ||
      primaryInfo.partNumber !== null);

  return {
    serverEpisodes: mergedEpisodes,
    unifiedTitle:
      shouldCleanSeasonSuffix || shouldCleanSubtitledArc
        ? buildUnifiedSeriesTitle(
            serverDetails.title,
            serverDetails.audioType,
            shouldCleanSubtitledArc
          )
        : serverDetails.title,
    unifiedSeasonCount: Math.max(distinctUnifiedSeasons.size, tvdbSeasons.length, 1),
    addedSeasonPages,
    primarySeasonNumber,
  };
}
