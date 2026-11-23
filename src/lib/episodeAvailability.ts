import { buildEpisodeUri, type CanonicalMediaType } from './catalog/idCodec.ts';
import type { AnimeEpisodeLink } from './types.ts';

export interface LiveChartAnimeScheduleHint {
  livechartId?: number;
  episodeNumber: number;
  airingAt: number;
  totalEpisodes?: number;
  serviceName?: string;
  poster?: string;
}

export interface EpisodeCountdownInfo {
  label: string;
  state: 'future' | 'now' | 'pending' | 'tba';
}

const MONTH_NAME_MAP: Record<string, number> = {
  jan: 1,
  january: 1,
  janeiro: 1,
  feb: 2,
  february: 2,
  fev: 2,
  fevereiro: 2,
  mar: 3,
  march: 3,
  marco: 3,
  março: 3,
  apr: 4,
  april: 4,
  abr: 4,
  abril: 4,
  may: 5,
  mai: 5,
  maio: 5,
  jun: 6,
  june: 6,
  junho: 6,
  jul: 7,
  july: 7,
  julho: 7,
  aug: 8,
  august: 8,
  ago: 8,
  agosto: 8,
  sep: 9,
  sept: 9,
  september: 9,
  set: 9,
  setembro: 9,
  oct: 10,
  october: 10,
  out: 10,
  outubro: 10,
  nov: 11,
  november: 11,
  novembro: 11,
  dec: 12,
  december: 12,
  dez: 12,
  dezembro: 12,
};

const WEEK_SECONDS = 7 * 24 * 60 * 60;

export function isEpisodeAvailableOnServer(
  ep: Pick<AnimeEpisodeLink, 'availableOnServer'> | null | undefined
): boolean {
  return ep ? ep.availableOnServer !== false : false;
}

export function parseEpisodeNumberFromLabel(label?: string): number | null {
  if (!label) return null;
  const cleaned = label.trim();
  if (!cleaned) return null;
  const epMatch = cleaned.match(/(?:ep\.?|epis[oó]dio)\s*0*(\d+)/i);
  if (epMatch?.[1]) {
    const n = Number.parseInt(epMatch[1], 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const seMatch = cleaned.match(/S\d+E0*(\d+)/i);
  if (seMatch?.[1]) {
    const n = Number.parseInt(seMatch[1], 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const dashMatch = cleaned.match(/^\d+\s*[-·]\s*0*(\d+)$/);
  if (dashMatch?.[1]) {
    const n = Number.parseInt(dashMatch[1], 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  if (/^\d+$/.test(cleaned)) {
    const n = Number.parseInt(cleaned, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

export function extractExplicitSeasonNumber(title?: string): number | null {
  if (!title) return null;
  const t = title.trim();
  if (!t) return null;

  const patterns: RegExp[] = [
    /\b(?:season|temporada)\s*0*(\d{1,2})\b/i,
    /\b0*(\d{1,2})(?:ª|a|st|nd|rd|th)?\s*(?:temporada|season)\b/i,
    /\bS0*(\d{1,2})\b(?:\s|$)/,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m?.[1]) {
      const n = Number.parseInt(m[1], 10);
      if (Number.isFinite(n) && n >= 1 && n <= 30) return n;
    }
  }
  return null;
}

/**
 * Parses common episode air-date strings (ISO, TheTVDB English, PT-BR) into a Unix timestamp (seconds).
 * Date-only values default to 15:00 UTC (12:00 BRT) so calendar day formatting never shifts across timezones.
 */
export function parseEpisodeDateToTimestampSec(dateStr?: string): number | undefined {
  if (!dateStr) return undefined;
  const raw = dateStr.trim();
  if (!raw) return undefined;

  // Full ISO timestamp with explicit time
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw)) {
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
  }

  // ISO date-only: YYYY-MM-DD
  const isoMatch = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    const y = Number.parseInt(isoMatch[1], 10);
    const m = Number.parseInt(isoMatch[2], 10);
    const d = Number.parseInt(isoMatch[3], 10);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return Math.floor(Date.UTC(y, m - 1, d, 15, 0, 0) / 1000);
    }
  }

  // DD/MM/YYYY
  const brSlash = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (brSlash) {
    const d = Number.parseInt(brSlash[1], 10);
    const m = Number.parseInt(brSlash[2], 10);
    const y = Number.parseInt(brSlash[3], 10);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return Math.floor(Date.UTC(y, m - 1, d, 15, 0, 0) / 1000);
    }
  }

  // English Month DD, YYYY (TheTVDB format, e.g. "November 29, 2026" or "Nov. 29, 2026")
  const enNamed = raw.match(/^([A-Za-zÀ-ÿ]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (enNamed) {
    const month = MONTH_NAME_MAP[enNamed[1].toLowerCase()];
    const d = Number.parseInt(enNamed[2], 10);
    const y = Number.parseInt(enNamed[3], 10);
    if (month && d >= 1 && d <= 31) {
      return Math.floor(Date.UTC(y, month - 1, d, 15, 0, 0) / 1000);
    }
  }

  // PT-BR DD [de] Month [de] YYYY (e.g. "29 nov. 2026", "29 de novembro de 2026")
  const ptNamed = raw.match(/^(\d{1,2})\s+(?:de\s+)?([A-Za-zÀ-ÿ]+)\.?\s+(?:de\s+)?(\d{4})$/i);
  if (ptNamed) {
    const d = Number.parseInt(ptNamed[1], 10);
    const month = MONTH_NAME_MAP[ptNamed[2].toLowerCase()];
    const y = Number.parseInt(ptNamed[3], 10);
    if (month && d >= 1 && d <= 31) {
      return Math.floor(Date.UTC(y, month - 1, d, 15, 0, 0) / 1000);
    }
  }

  return undefined;
}

/**
 * Formats an episode's release date cleanly in PT-BR for display underneath the episode title.
 * Includes local HH:mm when an exact airing timestamp is known (e.g. from LiveChart.me).
 */
export function formatEpisodeReleaseDate(
  dateStr?: string,
  airingAtSec?: number,
  hasExactTime = false
): string | null {
  const ts =
    typeof airingAtSec === 'number' && Number.isFinite(airingAtSec) && airingAtSec > 0
      ? airingAtSec
      : parseEpisodeDateToTimestampSec(dateStr);

  if (!ts) {
    return null;
  }

  try {
    const d = new Date(ts * 1000);
    const datePart = new Intl.DateTimeFormat('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(d);

    if (hasExactTime) {
      const timePart = new Intl.DateTimeFormat('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(d);
      return `${datePart} · ${timePart}`;
    }

    return datePart;
  } catch {
    return (dateStr || '').trim() || null;
  }
}

/**
 * Formats an unavailable episode's countdown matching the exact semantics and style of LiveChartCalendar.
 */
export function formatEpisodeCountdown(
  airingAtSec?: number,
  nowMs = Date.now(),
  dateStr?: string
): EpisodeCountdownInfo {
  const ts =
    typeof airingAtSec === 'number' && Number.isFinite(airingAtSec) && airingAtSec > 0
      ? airingAtSec
      : parseEpisodeDateToTimestampSec(dateStr);

  if (!ts) {
    return { label: 'A ser anunciada', state: 'tba' };
  }

  const diffSec = Math.floor(ts - nowMs / 1000);
  if (diffSec <= 0) {
    if (diffSec > -3600) {
      return { label: 'Saiu agora', state: 'now' };
    }
    return { label: 'Indisponível', state: 'pending' };
  }

  const days = Math.floor(diffSec / 86400);
  const hours = Math.floor((diffSec % 86400) / 3600);
  const mins = Math.floor((diffSec % 3600) / 60);

  if (days > 0) {
    return { label: `Em ${days}d ${hours}h`, state: 'future' };
  }
  if (hours > 0) {
    return { label: `Em ${hours}h ${String(mins).padStart(2, '0')}m`, state: 'future' };
  }
  return { label: `Em ${Math.max(1, mins)}m`, state: 'future' };
}

/**
 * Normalizes an upcoming episode's short label so bare numeric strings like "3"
 * render as "EP 3" instead of awkward "Próx. 3" or "3 ainda não disponível".
 */
export function formatUpcomingEpisodeShortLabel(
  ep: Pick<AnimeEpisodeLink, 'numberLabel' | 'episodeNumber'>
): string {
  const raw = (ep.numberLabel || '').trim();
  if (raw) {
    if (/^\d+(?:\.\d+)?$/.test(raw)) {
      return `EP ${raw}`;
    }
    return raw;
  }
  if (ep.episodeNumber !== null && ep.episodeNumber !== undefined) {
    return `EP ${ep.episodeNumber}`;
  }
  return 'Próximo episódio';
}

/**
 * Formats a concise PT-BR release forecast notice for an upcoming unavailable episode
 * (used by the player Next button, auto-advance end notice, and EpisodeWorkspace header).
 */
export function formatUpcomingEpisodeNotice(
  ep: Pick<AnimeEpisodeLink, 'numberLabel' | 'episodeNumber' | 'date' | 'airingAt' | 'hasExactAiringTime'>,
  nowMs = Date.now()
): string {
  const epTag = formatUpcomingEpisodeShortLabel(ep);
  const dateText = formatEpisodeReleaseDate(ep.date, ep.airingAt, ep.hasExactAiringTime);
  const countdown = formatEpisodeCountdown(ep.airingAt, nowMs, ep.date);

  if (countdown.state === 'future') {
    return dateText
      ? `${epTag} ainda não disponível · Previsão oficial: ${dateText} (${countdown.label})`
      : `${epTag} ainda não disponível · Previsão oficial: ${countdown.label}`;
  }
  if (countdown.state === 'now') {
    return dateText
      ? `${epTag} acabou de estrear (${dateText}), mas ainda não está nos servidores.`
      : `${epTag} acabou de estrear, mas ainda não está nos servidores.`;
  }
  if (countdown.state === 'pending') {
    return dateText
      ? `${epTag} (lançamento oficial em ${dateText}) ainda não está disponível nos servidores.`
      : `${epTag} ainda não está disponível nos servidores.`;
  }
  return `${epTag} ainda não disponível nos servidores (data oficial não confirmada).`;
}

function isGenericEpisodeTitle(title: string): boolean {
  return /^(?:epis[oó]dio|episode|ep\.?)\s*\d+(?:\s*[-–—:]?\s*(?:final)?)?$/i.test(title.trim());
}

function formatIsoDateFromSec(sec: number): string {
  const d = new Date(sec * 1000);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function buildScheduledPlaceholderUrl(
  baseId: string,
  seasonNumber: number,
  episodeNumber: number,
  tvdbId?: number,
  mediaType: CanonicalMediaType = 'anime'
): string {
  if (tvdbId && tvdbId > 0) {
    return buildEpisodeUri(mediaType, 'thetvdb', tvdbId, seasonNumber, episodeNumber);
  }
  return `anisync://episode/${mediaType}/schedule/${encodeURIComponent(baseId)}/s${seasonNumber}/e${episodeNumber}`;
}

/**
 * Merges playable server episodes with the complete official episode list (TheTVDB) and
 * LiveChart.me exact airing schedule so the detail view displays ALL episodes the anime has,
 * clearly flagging episodes not yet available on servers with release date + live countdown.
 */
export function mergeServerAndCatalogEpisodes(params: {
  serverTitle: string;
  serverUrl: string;
  serverEpisodes: AnimeEpisodeLink[];
  catalogEpisodes: AnimeEpisodeLink[];
  liveChartHint?: LiveChartAnimeScheduleHint | null;
  serverMatched: boolean;
  tvdbId?: number;
  mediaType?: CanonicalMediaType;
  unifyAllSeasons?: boolean;
}): AnimeEpisodeLink[] {
  const {
    serverTitle,
    serverUrl,
    serverEpisodes,
    catalogEpisodes,
    liveChartHint,
    serverMatched,
    tvdbId,
    mediaType = 'anime',
    unifyAllSeasons = false,
  } = params;

  const explicitSeason = extractExplicitSeasonNumber(serverTitle);
  const serverSeasons = new Set(serverEpisodes.map((e) => e.seasonNumber || 1));
  const serverIsSingleFlatSeason = serverSeasons.size <= 1;

  // Determine whether catalog episodes should be scoped to one specific season (e.g. "Anime 2nd Season" page)
  let scopedCatalog = catalogEpisodes.map((ep) => {
    const parsedTs = ep.airingAt ?? parseEpisodeDateToTimestampSec(ep.date);
    return {
      ...ep,
      seasonNumber: ep.seasonNumber || 1,
      episodeNumber: ep.episodeNumber ?? parseEpisodeNumberFromLabel(ep.numberLabel || ep.title),
      airingAt: parsedTs,
      hasExactAiringTime: Boolean(ep.hasExactAiringTime),
    };
  });

  let mappedServerSeason = 1;
  const singleServerSeason =
    serverIsSingleFlatSeason && serverSeasons.size === 1
      ? Array.from(serverSeasons)[0]
      : null;
  const targetSingleSeason =
    explicitSeason && explicitSeason > 1
      ? explicitSeason
      : singleServerSeason && singleServerSeason > 1
        ? singleServerSeason
        : null;

  if (targetSingleSeason && serverIsSingleFlatSeason) {
    const matchingSeasonCatalog = scopedCatalog.filter(
      (ep) => ep.seasonNumber === targetSingleSeason
    );
    if (matchingSeasonCatalog.length > 0) {
      if (!unifyAllSeasons) {
        scopedCatalog = matchingSeasonCatalog;
      }
      mappedServerSeason = targetSingleSeason;
    }
  }

  // Upgrade catalog timestamps with LiveChart exact airing time (and project exact weekly time to subsequent episodes in the same season)
  const targetLiveChartSeason = (() => {
    if (!liveChartHint) return mappedServerSeason;
    if (explicitSeason && explicitSeason > 1) return explicitSeason;
    // If catalog has multiple seasons, prefer the highest/latest season that contains or precedes liveChartHint.episodeNumber
    const distinctSeasons = Array.from(new Set(scopedCatalog.map((e) => e.seasonNumber || 1))).sort(
      (a, b) => a - b
    );
    if (distinctSeasons.length > 1) {
      const latestSeason = distinctSeasons[distinctSeasons.length - 1];
      const latestSeasonEps = scopedCatalog.filter((e) => (e.seasonNumber || 1) === latestSeason);
      const maxEp = latestSeasonEps.reduce((m, e) => Math.max(m, e.episodeNumber || 0), 0);
      if (liveChartHint.episodeNumber <= Math.max(maxEp + 2, liveChartHint.totalEpisodes || 0)) {
        return latestSeason;
      }
    }
    return distinctSeasons[0] || 1;
  })();

  if (liveChartHint && liveChartHint.airingAt > 0 && liveChartHint.episodeNumber > 0) {
    scopedCatalog = scopedCatalog.map((ep) => {
      if ((ep.seasonNumber || 1) !== targetLiveChartSeason || !ep.episodeNumber) return ep;
      if (ep.episodeNumber === liveChartHint.episodeNumber) {
        return {
          ...ep,
          airingAt: liveChartHint.airingAt,
          hasExactAiringTime: true,
          date: ep.date || formatIsoDateFromSec(liveChartHint.airingAt),
        };
      }
      // For subsequent episodes in the same season, if their calendar date aligns within +/-36h of the weekly cadence,
      // upgrade them to the exact weekly streaming hour from LiveChart!
      if (ep.episodeNumber > liveChartHint.episodeNumber) {
        const projected =
          liveChartHint.airingAt + (ep.episodeNumber - liveChartHint.episodeNumber) * WEEK_SECONDS;
        if (!ep.airingAt || Math.abs(ep.airingAt - projected) <= 36 * 3600) {
          return {
            ...ep,
            airingAt: projected,
            hasExactAiringTime: true,
            date: ep.date || formatIsoDateFromSec(projected),
          };
        }
      }
      return ep;
    });

    // If LiveChart knows totalEpisodes (or the next airing episode) beyond what catalog listed, synthesize scheduled entries
    const existingNumsInSeason = new Set(
      scopedCatalog
        .filter((e) => (e.seasonNumber || 1) === targetLiveChartSeason && e.episodeNumber)
        .map((e) => e.episodeNumber!)
    );
    const maxServerEpInTargetSeason = serverEpisodes.reduce((max, ep) => {
      const s =
        explicitSeason && explicitSeason > 1 && serverIsSingleFlatSeason
          ? mappedServerSeason
          : ep.seasonNumber || 1;
      if (s !== targetLiveChartSeason) return max;
      const n = ep.episodeNumber ?? parseEpisodeNumberFromLabel(ep.numberLabel || ep.title) ?? 0;
      return Math.max(max, n);
    }, 0);

    const upperBound = Math.max(
      liveChartHint.episodeNumber,
      liveChartHint.totalEpisodes && liveChartHint.totalEpisodes <= 100
        ? liveChartHint.totalEpisodes
        : liveChartHint.episodeNumber
    );
    const startEp = Math.max(1, Math.min(liveChartHint.episodeNumber, maxServerEpInTargetSeason + 1));

    for (let epNum = startEp; epNum <= upperBound; epNum++) {
      if (existingNumsInSeason.has(epNum)) continue;
      // Only synthesize episodes from the upcoming LiveChart episode onward (or gaps between server max and LiveChart episode)
      if (epNum < liveChartHint.episodeNumber && epNum <= maxServerEpInTargetSeason) continue;
      const isCurrentOrFuture = epNum >= liveChartHint.episodeNumber;
      const projectedAiringAt =
        liveChartHint.airingAt + (epNum - liveChartHint.episodeNumber) * WEEK_SECONDS;
      scopedCatalog.push({
        numberLabel:
          targetLiveChartSeason > 1 ? `T${targetLiveChartSeason} · EP ${epNum}` : `EP ${epNum}`,
        episodeNumber: epNum,
        seasonNumber: targetLiveChartSeason,
        seasonLabel: `Temporada ${targetLiveChartSeason}`,
        title: `Episódio ${epNum}`,
        url: buildScheduledPlaceholderUrl(
          String(liveChartHint.livechartId || serverUrl || serverTitle),
          targetLiveChartSeason,
          epNum,
          tvdbId,
          mediaType
        ),
        date: formatIsoDateFromSec(projectedAiringAt),
        airingAt: projectedAiringAt,
        hasExactAiringTime: isCurrentOrFuture,
        availableOnServer: false,
      });
      existingNumsInSeason.add(epNum);
    }
  }

  // Case 1: No streaming server matched at all -> return all catalog/scheduled episodes marked unavailable on servers
  if (!serverMatched || serverEpisodes.length === 0) {
    return scopedCatalog
      .map((ep) => ({
        ...ep,
        availableOnServer: false,
      }))
      .sort(
        (a, b) =>
          (a.seasonNumber || 1) - (b.seasonNumber || 1) ||
          (a.episodeNumber || 0) - (b.episodeNumber || 0)
      );
  }

  // Case 2: Streaming server has playable episodes -> match against catalog & append missing/upcoming ones
  if (scopedCatalog.length === 0) {
    return serverEpisodes.map((ep) => ({
      ...ep,
      availableOnServer: true,
      airingAt: ep.airingAt ?? parseEpisodeDateToTimestampSec(ep.date),
    }));
  }

  // Index server episodes by both (season, epNum) and flat sequential epNum (for continuous anime numbering)
  const serverBySeasonEp = new Map<string, AnimeEpisodeLink>();
  const serverByFlatEp = new Map<number, AnimeEpisodeLink>();
  const normalizedServerEps = serverEpisodes.map((ep) => {
    const epNum = ep.episodeNumber ?? parseEpisodeNumberFromLabel(ep.numberLabel || ep.title);
    const sNum =
      explicitSeason && explicitSeason > 1 && serverIsSingleFlatSeason
        ? mappedServerSeason
        : ep.seasonNumber || 1;
    const item: AnimeEpisodeLink = {
      ...ep,
      episodeNumber: epNum,
      seasonNumber: sNum,
      seasonLabel: ep.seasonLabel || `Temporada ${sNum}`,
      availableOnServer: true,
    };
    if (epNum !== null) {
      serverBySeasonEp.set(`${sNum}:${epNum}`, item);
      if (!serverByFlatEp.has(epNum)) {
        serverByFlatEp.set(epNum, item);
      }
    }
    return item;
  });

  // Sort catalog episodes to compute cumulative absolute episode numbers for flat-numbered anime servers
  const sortedCatalog = [...scopedCatalog].sort(
    (a, b) =>
      (a.seasonNumber || 1) - (b.seasonNumber || 1) ||
      (a.episodeNumber || 0) - (b.episodeNumber || 0)
  );

  const serverMaxNum = normalizedServerEps.reduce((m, e) => Math.max(m, e.episodeNumber || 0), 0);
  const season1CatalogMax = sortedCatalog
    .filter((e) => (e.seasonNumber || 1) === 1)
    .reduce((m, e) => Math.max(m, e.episodeNumber || 0), 0);
  const usesContinuousAbsoluteNumbering =
    serverIsSingleFlatSeason && !explicitSeason && season1CatalogMax > 0 && serverMaxNum > season1CatalogMax;

  const consumedServerUrls = new Set<string>();
  const merged: AnimeEpisodeLink[] = [];

  sortedCatalog.forEach((catEp, absIdx) => {
    const sNum = catEp.seasonNumber || 1;
    const eNum = catEp.episodeNumber;
    const absNum = absIdx + 1;

    let matchedServer: AnimeEpisodeLink | undefined;
    if (eNum !== null) {
      matchedServer = serverBySeasonEp.get(`${sNum}:${eNum}`);
    }
    if (!matchedServer && usesContinuousAbsoluteNumbering) {
      matchedServer = serverByFlatEp.get(absNum);
    }

    if (matchedServer) {
      consumedServerUrls.add(matchedServer.url);
      const preferCatalogTitle =
        Boolean(catEp.title) &&
        !isGenericEpisodeTitle(catEp.title) &&
        isGenericEpisodeTitle(matchedServer.title);
      const hasMisleadingSeason1Label =
        sNum > 1 && /^\s*1\s*[-·]\s*\d+\s*$/.test(matchedServer.numberLabel || '');
      merged.push({
        ...matchedServer,
        title: preferCatalogTitle ? catEp.title : matchedServer.title,
        seasonNumber: sNum,
        seasonLabel: catEp.seasonLabel || matchedServer.seasonLabel || `Temporada ${sNum}`,
        numberLabel: hasMisleadingSeason1Label
          ? catEp.numberLabel || `T${sNum} · EP ${eNum ?? ''}`.trim()
          : matchedServer.numberLabel || catEp.numberLabel,
        date: matchedServer.date || catEp.date,
        thumb: catEp.thumb || matchedServer.thumb,
        overview: matchedServer.overview || catEp.overview,
        durationMinutes: matchedServer.durationMinutes || catEp.durationMinutes,
        airingAt: matchedServer.airingAt ?? catEp.airingAt,
        hasExactAiringTime: matchedServer.hasExactAiringTime || catEp.hasExactAiringTime,
        tvdbEpisodeId: matchedServer.tvdbEpisodeId ?? catEp.tvdbEpisodeId,
        availableOnServer: true,
      });
    } else {
      merged.push({
        ...catEp,
        availableOnServer: false,
      });
    }
  });

  // Safety guard: if a server page HAS playable episodes, but ZERO of them aligned with
  // TheTVDB's season/episode numbering (e.g. a split-cour Season 2 page on TopAnimes vs a single
  // 24-ep Season 1 on TheTVDB), never dump mismatched historical catalog episodes as fake
  // unavailable rows — keep the playable server episodes cleanly!
  if (consumedServerUrls.size === 0 && normalizedServerEps.length > 0) {
    return normalizedServerEps
      .map((ep) => ({
        ...ep,
        availableOnServer: true,
        airingAt: ep.airingAt ?? parseEpisodeDateToTimestampSec(ep.date),
      }))
      .sort(
        (a, b) =>
          (a.seasonNumber || 1) - (b.seasonNumber || 1) ||
          (a.episodeNumber || 0) - (b.episodeNumber || 0)
      );
  }

  // Preserve any extra server episodes not present in the catalog
  for (const srvEp of normalizedServerEps) {
    if (!consumedServerUrls.has(srvEp.url)) {
      merged.push({
        ...srvEp,
        availableOnServer: true,
        airingAt: srvEp.airingAt ?? parseEpisodeDateToTimestampSec(srvEp.date),
      });
    }
  }

  merged.sort(
    (a, b) =>
      (a.seasonNumber || 1) - (b.seasonNumber || 1) ||
      (a.episodeNumber || 0) - (b.episodeNumber || 0)
  );

  return merged;
}
