import * as cheerio from 'cheerio';
import type { HttpFetcher } from '../../httpTypes.ts';
import type {
  AudioType,
  CalendarDaySection,
  CatalogMediaItem,
  LiveChartScheduleMode,
  ScheduleReleaseInfo,
  WeeklyCalendarResponse,
} from '../../types.ts';
import { isSafeExternalHttpUrl } from '../../urlSafety.ts';
import { buildLiveChartScheduleUri } from '../idCodec.ts';

const LIVECHART_ORIGIN = 'https://www.livechart.me';
const LIVECHART_SCHEDULE_URL = `${LIVECHART_ORIGIN}/schedule?layout=compact_grid`;

const WEEKDAY_NAMES_PT = [
  'Domingo',
  'Segunda',
  'Terça',
  'Quarta',
  'Quinta',
  'Sexta',
  'Sábado',
];

const MONTH_ABBR_PT = [
  'jan',
  'fev',
  'mar',
  'abr',
  'mai',
  'jun',
  'jul',
  'ago',
  'set',
  'out',
  'nov',
  'dez',
];

const SERVICE_NAME_ALIASES: Array<[RegExp, string]> = [
  [/^(?:yt|youtube)$/i, 'YouTube'],
  [/^crunchyroll$/i, 'Crunchyroll'],
  [/^netflix$/i, 'Netflix'],
  [/^(?:prime\s*video|amazon\s*prime(?:\s*video)?)$/i, 'Prime Video'],
  [/^disney\+?$/i, 'Disney+'],
  [/^hidive$/i, 'HIDIVE'],
  [/^wetv$/i, 'WeTV'],
  [/^hulu$/i, 'Hulu'],
  [/^bilibili$/i, 'Bilibili'],
  [/^iqiyi$/i, 'iQIYI'],
  [/^adn$/i, 'ADN'],
  [/^ani-one/i, 'Ani-One'],
  [/^muse/i, 'Muse'],
  [/^abema/i, 'Abema'],
  [/^tubi$/i, 'Tubi'],
  [/^peacock$/i, 'Peacock'],
  [/^max$/i, 'Max'],
];

function cleanText(val: string | undefined): string {
  return String(val || '').replace(/\s+/g, ' ').trim();
}

function normalizeServiceName(raw: string): string {
  const cleaned = cleanText(raw);
  if (!cleaned) return '';
  for (const [pattern, normalized] of SERVICE_NAME_ALIASES) {
    if (pattern.test(cleaned)) return normalized;
  }
  return cleaned;
}

function upgradeLiveChartPoster(src: string | undefined, srcset?: string): string {
  if (srcset) {
    const candidates = srcset
      .split(',')
      .map((part) => part.trim().split(/\s+/)[0])
      .filter(Boolean);
    const large = candidates.find((u) => /\/large\./i.test(u)) || candidates[candidates.length - 1];
    if (large) {
      const abs = large.startsWith('//') ? `https:${large}` : large;
      if (isSafeExternalHttpUrl(abs)) return abs;
    }
  }
  let val = cleanText(src);
  if (!val) return '';
  if (val.startsWith('//')) val = `https:${val}`;
  if (val.startsWith('/')) val = `${LIVECHART_ORIGIN}${val}`;
  val = val.replace(/\/small\.(jpg|jpeg|webp|png)(\?.*)?$/i, '/large.$1$2');
  return isSafeExternalHttpUrl(val) ? val : '';
}

export interface ParsedLiveChartReleaseLabel {
  episodeLabel?: string;
  releaseLabel: string;
  hasDub: boolean;
  hasSub: boolean;
  isJapaneseBroadcast: boolean;
  serviceName?: string;
  audioType: AudioType;
}

/**
 * Parses LiveChart.me release state strings such as:
 * - "EP8 · Sub - Crunchyroll"
 * - "EP8 · Dub, Sub - Prime Video"
 * - "EP8 · Dub, Sub - Netflix"
 * - "EP7 · Streaming (INTL): Sub - Disney+"
 * - "EP13 · Streaming (JP) - YT"
 * - "EP8 · TV (JP): CEN"
 * - "EP1362 · TV (JP)"
 * - "All 12 EPs · Streaming: Dub, Sub - Netflix"
 * - "THTR (JP)"
 */
export function parseLiveChartReleaseLabel(raw: string): ParsedLiveChartReleaseLabel {
  const normalized = cleanText(raw);
  if (!normalized) {
    return {
      releaseLabel: '',
      hasDub: false,
      hasSub: false,
      isJapaneseBroadcast: false,
      audioType: null,
    };
  }

  let episodePart = '';
  let detailPart = normalized;

  const dotIdx = normalized.indexOf('·');
  if (dotIdx >= 0) {
    episodePart = cleanText(normalized.slice(0, dotIdx));
    detailPart = cleanText(normalized.slice(dotIdx + 1));
  } else if (/^(?:EP\s*\d|All\s+\d+\s+EPs?)/i.test(normalized)) {
    episodePart = normalized;
    detailPart = '';
  }

  let formattedEpisode = episodePart;
  if (/^EP(\d+(?:[–-]\d+)?)$/i.test(episodePart)) {
    formattedEpisode = episodePart.replace(/^EP/i, 'EP ');
  } else if (/^All\s+(\d+)\s+EPs?$/i.test(episodePart)) {
    formattedEpisode = episodePart.replace(/^All\s+(\d+)\s+EPs?$/i, 'Todos $1 EPs');
  }

  const hasDub = /\bDub\b/i.test(detailPart);
  const hasSub = /\bSub\b|\bSimulcast\b/i.test(detailPart);
  const isJapaneseBroadcast =
    /\b(?:TV|Streaming|THTR)\s*\(JP\)/i.test(detailPart) ||
    /\bTHTR\b/i.test(detailPart) ||
    (!hasDub && !hasSub && /\b(?:TV|Streaming)\s*\(China\)/i.test(detailPart));

  let serviceName: string | undefined;
  const dashIdx = detailPart.lastIndexOf(' - ');
  if (dashIdx >= 0) {
    const candidate = cleanText(detailPart.slice(dashIdx + 3));
    if (candidate) serviceName = normalizeServiceName(candidate);
  } else if (/\bTV\s*\(JP\)/i.test(detailPart)) {
    serviceName = 'TV (JP)';
  } else if (/\bTHTR\s*\(JP\)/i.test(detailPart)) {
    serviceName = 'Cinema (JP)';
  } else if (/\bStreaming\s*\(JP\)/i.test(detailPart)) {
    serviceName = 'Streaming (JP)';
  } else if (/\bStreaming\s*\(China\)/i.test(detailPart)) {
    serviceName = 'Streaming (CN)';
  }

  if (!formattedEpisode && /\bTHTR\s*\(JP\)/i.test(detailPart)) {
    formattedEpisode = 'Estreia Cinema';
  }

  const audioType: AudioType = hasDub ? 'DUB' : hasSub ? 'LEG' : null;

  return {
    episodeLabel: formattedEpisode || undefined,
    releaseLabel: detailPart || normalized,
    hasDub,
    hasSub,
    isJapaneseBroadcast,
    serviceName,
    audioType,
  };
}

function getLiveChartPreferenceCookie(mode: LiveChartScheduleMode): string {
  const ps = mode === 'dub' ? 'abm' : mode === 'jp' ? 'er' : 'sbm';
  const globalVal = encodeURIComponent(`ps=${ps}&pl=pt-br.pt.en-us&ptl=rom`);
  return `lc.uset.global=${globalVal}`;
}

function formatDayMetaFromUtcDate(
  shiftedDate: Date,
  todayIso: string
): { id: string; label: string; dateIso: string; dateLabel: string; isToday: boolean } {
  const yyyy = shiftedDate.getUTCFullYear();
  const mm = String(shiftedDate.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(shiftedDate.getUTCDate()).padStart(2, '0');
  const dateIso = `${yyyy}-${mm}-${dd}`;
  const weekday = WEEKDAY_NAMES_PT[shiftedDate.getUTCDay()] || 'Dia';
  const monthAbbr = MONTH_ABBR_PT[shiftedDate.getUTCMonth()] || '';
  const dateLabel = `${shiftedDate.getUTCDate()} ${monthAbbr}`;
  const isToday = dateIso === todayIso;
  return {
    id: isToday ? 'hoje' : dateIso,
    label: isToday ? 'Hoje' : weekday,
    dateIso,
    dateLabel,
    isToday,
  };
}

function parseTimestampFromRangesAttr(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const match = raw.match(/\[\[\s*(\d{9,12})\s*,/);
  if (!match?.[1]) return undefined;
  const ts = Number.parseInt(match[1], 10);
  return Number.isFinite(ts) && ts > 0 ? ts : undefined;
}

function extractCompactGridEntries($: cheerio.CheerioAPI): Array<{
  fallbackDateIso?: string;
  item: CatalogMediaItem;
}> {
  const entries: Array<{ fallbackDateIso?: string; item: CatalogMediaItem }> = [];
  const dayContainers = $('[data-controller*="schedule-day"]');

  const parseCard = (cardEl: Parameters<cheerio.CheerioAPI>[0], fallbackDateIso?: string) => {
    const $c = $(cardEl);
    const idRaw = cleanText($c.attr('data-anime-item-id'));
    const livechartId = Number.parseInt(idRaw, 10);
    if (!Number.isFinite(livechartId) || livechartId <= 0) return;

    const romTitle = cleanText($c.attr('data-anime-item-romanized-native-title'));
    const engTitle = cleanText($c.attr('data-anime-item-english-title'));
    const nativeTitle = cleanText($c.attr('data-anime-item-native-title'));
    const linkTitle = cleanText($c.find('a[href*="/anime/"]').first().text());
    const title = romTitle || engTitle || linkTitle;
    if (!title) return;

    const totalEpsRaw = Number.parseInt(cleanText($c.attr('data-anime-item-total-episodes')), 10);
    const totalEpisodes = Number.isFinite(totalEpsRaw) && totalEpsRaw > 0 ? totalEpsRaw : undefined;

    const img = $c.find('img.lc-compact-anime-card__poster, img').first();
    const poster = upgradeLiveChartPoster(
      img.attr('src') || img.attr('data-src'),
      img.attr('srcset')
    );

    const relState = $c.find('.lc-compact-anime-card__release-state').first();
    const relRaw = cleanText(relState.find('div').first().text());
    const parsedRel = parseLiveChartReleaseLabel(relRaw);

    const tsAttr =
      relState.find('time[data-timestamp]').first().attr('data-timestamp') ||
      $c.find('time[data-timestamp]').first().attr('data-timestamp');
    const parsedTs = tsAttr ? Number.parseInt(tsAttr, 10) : NaN;
    const airingAt =
      Number.isFinite(parsedTs) && parsedTs > 0
        ? parsedTs
        : parseTimestampFromRangesAttr(
            $c.find('[data-viewing-progression-episode-ranges-value]').attr(
              'data-viewing-progression-episode-ranges-value'
            )
          );

    const streamHref = cleanText(
      $c.find('a[target="_blank"][href^="http"]').first().attr('href')
    );
    const serviceUrl = streamHref && isSafeExternalHttpUrl(streamHref) ? streamHref : undefined;

    let mediaFormat: string | undefined;
    let year: string | undefined;
    let rating: string | undefined;
    $c.find('ul li').each((_, liEl) => {
      const txt = cleanText($(liEl).text());
      if (!txt) return;
      if (/^(?:19|20)\d{2}$/.test(txt)) {
        year = year || txt;
      } else if (/^\d+(?:\.\d+)?$/.test(txt) && Number.parseFloat(txt) <= 10) {
        rating = rating || txt;
      } else if (!mediaFormat && txt.length <= 20) {
        mediaFormat = txt;
      }
    });

    const uri = buildLiveChartScheduleUri(livechartId, title, engTitle || undefined);
    const scheduleMeta: ScheduleReleaseInfo = {
      livechartId,
      releaseLabel: parsedRel.releaseLabel,
      hasDub: parsedRel.hasDub,
      hasSub: parsedRel.hasSub,
      isJapaneseBroadcast: parsedRel.isJapaneseBroadcast,
      serviceName: parsedRel.serviceName,
      serviceUrl,
      totalEpisodes,
      englishTitle: engTitle || undefined,
      nativeTitle: nativeTitle || undefined,
      format: mediaFormat,
    };

    entries.push({
      fallbackDateIso,
      item: {
        id: `lc-${livechartId}-${airingAt || 0}`,
        title,
        episodeLabel: parsedRel.episodeLabel,
        url: uri,
        kind: 'anime',
        poster,
        audioType: parsedRel.audioType,
        rating,
        year,
        mediaFormat,
        airingAt,
        catalogSource: 'livechart',
        externalIds: { livechartId },
        statusBadge: parsedRel.serviceName || parsedRel.releaseLabel || undefined,
        scheduleMeta,
      },
    });
  };

  if (dayContainers.length > 0) {
    dayContainers.each((_, dayEl) => {
      const $d = $(dayEl);
      const dateAttr = cleanText($d.find('.lc-schedule-heading time[datetime]').first().attr('datetime'));
      const fallbackDateIso = /^\d{4}-\d{2}-\d{2}$/.test(dateAttr) ? dateAttr : undefined;
      $d.find('article.lc-compact-anime-card').each((__, cardEl) => {
        parseCard(cardEl, fallbackDateIso);
      });
    });
  } else {
    $('article.lc-compact-anime-card').each((_, cardEl) => {
      parseCard(cardEl, undefined);
    });
  }

  return entries;
}

function extractTimetableEntries($: cheerio.CheerioAPI): Array<{
  fallbackDateIso?: string;
  item: CatalogMediaItem;
}> {
  const entries: Array<{ fallbackDateIso?: string; item: CatalogMediaItem }> = [];

  $('.lc-timetable-day').each((_, dayEl) => {
    const $d = $(dayEl);
    const dateAttr = cleanText($d.find('.lc-timetable-day__heading time[datetime]').first().attr('datetime'));
    const fallbackDateIso = /^\d{4}-\d{2}-\d{2}$/.test(dateAttr) ? dateAttr : undefined;

    $d.find('.lc-timetable-timeslot').each((__, slotEl) => {
      const $slot = $(slotEl);
      const slotTsRaw = Number.parseInt(cleanText($slot.attr('data-timestamp')), 10);
      const slotTs = Number.isFinite(slotTsRaw) && slotTsRaw > 0 ? slotTsRaw : undefined;

      $slot.find('.lc-timetable-anime-block').each((___, blockEl) => {
        const $b = $(blockEl);
        const livechartId = Number.parseInt(cleanText($b.attr('data-anime-item-id')), 10);
        if (!Number.isFinite(livechartId) || livechartId <= 0) return;

        const romTitle = cleanText($b.attr('data-anime-item-romanized-native-title'));
        const engTitle = cleanText($b.attr('data-anime-item-english-title'));
        const linkTitle = cleanText($b.find('.lc-timetable-anime-block__title').first().text());
        const title = romTitle || linkTitle || engTitle;
        if (!title) return;

        const totalEpsRaw = Number.parseInt(cleanText($b.attr('data-anime-item-total-episodes')), 10);
        const totalEpisodes = Number.isFinite(totalEpsRaw) && totalEpsRaw > 0 ? totalEpsRaw : undefined;

        const img = $b.find('img.lc-timetable-anime-block__poster, img').first();
        const poster = upgradeLiveChartPoster(
          img.attr('src') || img.attr('data-src'),
          img.attr('srcset')
        );

        const relRaw = cleanText($b.find('.lc-timetable-anime-block__label').first().text());
        const parsedRel = parseLiveChartReleaseLabel(relRaw);

        const streamHref = cleanText(
          $b.find('a.lc-timetable-anime-block__action-button[href^="http"]').first().attr('href')
        );
        const serviceUrl = streamHref && isSafeExternalHttpUrl(streamHref) ? streamHref : undefined;

        const airingAt =
          slotTs ||
          parseTimestampFromRangesAttr(
            $b.find('[data-progress-action-button-episode-ranges-value]').attr(
              'data-progress-action-button-episode-ranges-value'
            )
          );

        const uri = buildLiveChartScheduleUri(livechartId, title, engTitle || undefined);
        const scheduleMeta: ScheduleReleaseInfo = {
          livechartId,
          releaseLabel: parsedRel.releaseLabel,
          hasDub: parsedRel.hasDub,
          hasSub: parsedRel.hasSub,
          isJapaneseBroadcast: parsedRel.isJapaneseBroadcast,
          serviceName: parsedRel.serviceName,
          serviceUrl,
          totalEpisodes,
          englishTitle: engTitle || undefined,
        };

        entries.push({
          fallbackDateIso,
          item: {
            id: `lc-${livechartId}-${airingAt || 0}`,
            title,
            episodeLabel: parsedRel.episodeLabel,
            url: uri,
            kind: 'anime',
            poster,
            audioType: parsedRel.audioType,
            airingAt,
            catalogSource: 'livechart',
            externalIds: { livechartId },
            statusBadge: parsedRel.serviceName || parsedRel.releaseLabel || undefined,
            scheduleMeta,
          },
        });
      });
    });
  });

  return entries;
}

/**
 * Parses LiveChart.me /schedule HTML (both Compact Grid and Timetable layouts)
 * and groups entries cleanly by local day sorted chronologically by airing time.
 */
export function parseLiveChartScheduleHtml(
  html: string,
  options: {
    mode?: LiveChartScheduleMode;
    /** Local timezone offset in minutes relative to UTC (e.g. -180 for BRT / UTC-3). */
    tzOffsetMinutes?: number;
    nowMs?: number;
  } = {}
): WeeklyCalendarResponse {
  const mode = options.mode || 'streams';
  const tzOffsetMin = Number.isFinite(options.tzOffsetMinutes)
    ? (options.tzOffsetMinutes as number)
    : -180;
  const nowMs = options.nowMs ?? Date.now();
  const tzShiftMs = tzOffsetMin * 60 * 1000;

  const $ = cheerio.load(html);
  let rawEntries = extractCompactGridEntries($);
  if (rawEntries.length === 0) {
    rawEntries = extractTimetableEntries($);
  }

  const todayShifted = new Date(nowMs + tzShiftMs);
  const todayIso = `${todayShifted.getUTCFullYear()}-${String(
    todayShifted.getUTCMonth() + 1
  ).padStart(2, '0')}-${String(todayShifted.getUTCDate()).padStart(2, '0')}`;

  const byDateIso = new Map<
    string,
    {
      meta: { id: string; label: string; dateIso: string; dateLabel: string; isToday: boolean };
      items: CatalogMediaItem[];
      seenKeys: Set<string>;
    }
  >();

  for (const entry of rawEntries) {
    let meta: { id: string; label: string; dateIso: string; dateLabel: string; isToday: boolean };
    if (entry.item.airingAt && entry.item.airingAt > 0) {
      const shifted = new Date(entry.item.airingAt * 1000 + tzShiftMs);
      meta = formatDayMetaFromUtcDate(shifted, todayIso);
    } else if (entry.fallbackDateIso) {
      const [y, m, d] = entry.fallbackDateIso.split('-').map((n) => Number.parseInt(n, 10));
      const synthetic = new Date(Date.UTC(y, (m || 1) - 1, d || 1, 12, 0, 0));
      meta = formatDayMetaFromUtcDate(synthetic, todayIso);
    } else {
      meta = formatDayMetaFromUtcDate(todayShifted, todayIso);
    }

    let bucket = byDateIso.get(meta.dateIso);
    if (!bucket) {
      bucket = { meta, items: [], seenKeys: new Set<string>() };
      byDateIso.set(meta.dateIso, bucket);
    }

    const dedupeKey = `${entry.item.externalIds?.livechartId || entry.item.title}::${entry.item.episodeLabel || ''}::${entry.item.airingAt || 0}`;
    if (bucket.seenKeys.has(dedupeKey)) continue;
    bucket.seenKeys.add(dedupeKey);
    bucket.items.push(entry.item);
  }

  const sortedDateKeys = Array.from(byDateIso.keys()).sort((a, b) => a.localeCompare(b));
  const days: CalendarDaySection[] = sortedDateKeys.map((key) => {
    const bucket = byDateIso.get(key)!;
    bucket.items.sort((a, b) => {
      const ta = a.airingAt ?? Number.MAX_SAFE_INTEGER;
      const tb = b.airingAt ?? Number.MAX_SAFE_INTEGER;
      if (ta !== tb) return ta - tb;
      return a.title.localeCompare(b.title);
    });
    return {
      id: bucket.meta.id,
      label: bucket.meta.label,
      dateIso: bucket.meta.dateIso,
      dateLabel: bucket.meta.dateLabel,
      isToday: bucket.meta.isToday,
      items: bucket.items,
    };
  });

  // Put "Hoje" first if present and drop any past days older than yesterday
  const todayIdx = days.findIndex((d) => d.isToday);
  const orderedDays = todayIdx > 0 ? [...days.slice(todayIdx), ...days.slice(0, todayIdx)] : days;

  return {
    days: orderedDays.slice(0, 7),
    sourceMode: orderedDays.length > 0 ? 'live' : 'snapshot',
    scheduleMode: mode,
    fetchedAt: new Date(nowMs).toISOString(),
    catalogSources: ['livechart'],
  };
}

export async function fetchLiveChartWeeklySchedule(
  fetchHttp: HttpFetcher,
  options: {
    mode?: LiveChartScheduleMode;
    tzOffsetMinutes?: number;
  } = {}
): Promise<WeeklyCalendarResponse> {
  const mode = options.mode || 'streams';
  const cookie = getLiveChartPreferenceCookie(mode);

  const res = await fetchHttp(LIVECHART_SCHEDULE_URL, {
    referer: `${LIVECHART_ORIGIN}/`,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    headers: { Cookie: cookie },
    timeoutMs: 12000,
  });

  if (!res.ok) {
    throw new Error(`LiveChart.me retornou HTTP ${res.status}.`);
  }

  return parseLiveChartScheduleHtml(res.body, {
    mode,
    tzOffsetMinutes: options.tzOffsetMinutes,
  });
}
