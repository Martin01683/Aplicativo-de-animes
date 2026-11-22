import type { HttpFetcher } from '../httpTypes.ts';
import type { PlayerOption, ResolvedEmbed } from '../types.ts';
import { isSafeExternalHttpUrl } from '../urlSafety.ts';
import {
  isHinataSoulEmbedUrl,
  resolveFromHinataSoulSource,
  resolveHinataSoulEmbed,
} from './providers/hinatasoulSource.ts';
import {
  resolveFromTopAnimesSource,
  resolveTopAnimesEmbed,
} from './providers/topanimesSource.ts';
import {
  DEFAULT_EPISODE_SOURCES,
  TOPANIMES_BUILTIN_SOURCE,
  type AggregatedEpisodeServersResult,
  type AggregatedServerOption,
  type EpisodeSourceConfig,
  type EpisodeSourceLookupQuery,
  type SourceLookupReport,
  type SourceTestResult,
} from './types.ts';

async function resolveFromSingleSource(
  fetchHttp: HttpFetcher,
  source: EpisodeSourceConfig,
  query: EpisodeSourceLookupQuery
): Promise<{
  options: AggregatedServerOption[];
  report: SourceLookupReport;
}> {
  const startedAt = Date.now();
  if (!source.enabled) {
    return {
      options: [],
      report: {
        sourceId: source.id,
        sourceName: source.name,
        sourceKind: source.kind,
        status: 'skipped',
        optionsCount: 0,
        durationMs: 0,
      },
    };
  }

  try {
    const result =
      source.kind === 'hinatasoul'
        ? await resolveFromHinataSoulSource(fetchHttp, source, query)
        : await resolveFromTopAnimesSource(fetchHttp, source, query);

    const report: SourceLookupReport = {
      sourceId: source.id,
      sourceName: source.name,
      sourceKind: source.kind,
      status: result.options.length > 0 ? 'found' : 'not-found',
      optionsCount: result.options.length,
      matchedTitle: result.matchedTitle,
      matchedUrl: result.matchedUrl,
      durationMs: Date.now() - startedAt,
    };
    return { options: result.options, report };
  } catch (err) {
    const report: SourceLookupReport = {
      sourceId: source.id,
      sourceName: source.name,
      sourceKind: source.kind,
      status: 'error',
      optionsCount: 0,
      errorMessage: err instanceof Error ? err.message : 'Falha ao consultar servidor.',
      durationMs: Date.now() - startedAt,
    };
    return { options: [], report };
  }
}

/**
 * Queries all integrated episode servers (TopAnimes & Hinata Soul) in parallel
 * and returns deduplicated playable server options along with per-source reports.
 */
export async function aggregateEpisodeServers(
  fetchHttp: HttpFetcher,
  query: EpisodeSourceLookupQuery,
  options?: {
    sources?: readonly EpisodeSourceConfig[];
    excludeSourceIds?: readonly string[];
  }
): Promise<AggregatedEpisodeServersResult> {
  const exclude = new Set(options?.excludeSourceIds || []);
  const activeSources = (options?.sources || DEFAULT_EPISODE_SOURCES)
    .filter((s) => s.enabled && !exclude.has(s.id))
    .slice()
    .sort((a, b) => a.priority - b.priority);

  const settled = await Promise.all(
    activeSources.map((source) => resolveFromSingleSource(fetchHttp, source, query))
  );

  const aggregatedOptions: AggregatedServerOption[] = [];
  const reports: SourceLookupReport[] = [];
  const seenEmbed = new Set<string>();

  for (const entry of settled) {
    reports.push(entry.report);
    for (const opt of entry.options) {
      const dedupeKey = `${opt.sourceId}::${opt.directStreamUrl || opt.embedUrl}`;
      if (seenEmbed.has(dedupeKey)) continue;
      seenEmbed.add(dedupeKey);
      aggregatedOptions.push(opt);
    }
  }

  return { options: aggregatedOptions, reports };
}

/**
 * Resolves any supported server embed URL (TopAnimes players OR Hinata Soul videos)
 * into direct playable streams.
 */
export async function resolveEmbedByUrl(
  fetchHttp: HttpFetcher,
  rawEmbedUrl: string,
  baseReferer?: string
): Promise<ResolvedEmbed> {
  if (isHinataSoulEmbedUrl(rawEmbedUrl)) {
    return resolveHinataSoulEmbed(fetchHttp, rawEmbedUrl, baseReferer);
  }
  return resolveTopAnimesEmbed(fetchHttp, rawEmbedUrl, baseReferer);
}

/**
 * Resolves a chosen PlayerOption into a playable ResolvedEmbed.
 */
export async function resolveServerOptionToStreams(
  fetchHttp: HttpFetcher,
  option: Pick<
    PlayerOption,
    | 'label'
    | 'embedUrl'
    | 'directStreamUrl'
    | 'directFormat'
    | 'directReferer'
    | 'directSubtitles'
    | 'qualityLabel'
  >
): Promise<ResolvedEmbed> {
  if (option.directStreamUrl && isSafeExternalHttpUrl(option.directStreamUrl)) {
    const format =
      option.directFormat ||
      (/\.m3u8(?:$|\?)/i.test(option.directStreamUrl)
        ? 'hls'
        : /\.(?:mp4|mkv|webm|m4v)(?:$|\?)/i.test(option.directStreamUrl)
          ? 'mp4'
          : 'unknown');
    return {
      embedUrl: option.embedUrl || option.directStreamUrl,
      provider: option.label || 'Servidor',
      status: 'resolved',
      streams: [
        {
          label: option.qualityLabel || (format === 'hls' ? 'HLS' : 'Direto'),
          height: 1080,
          url: option.directStreamUrl,
          format,
        },
      ],
      subtitles: option.directSubtitles || [],
      referer: option.directReferer || option.directStreamUrl,
      preferDirect: true,
    };
  }

  return resolveEmbedByUrl(fetchHttp, option.embedUrl, option.directReferer);
}

/**
 * Tests connectivity for an integrated episode server on demand.
 */
export async function testEpisodeSource(
  fetchHttp: HttpFetcher,
  source: EpisodeSourceConfig = TOPANIMES_BUILTIN_SOURCE
): Promise<SourceTestResult> {
  const startedAt = Date.now();
  const base = source.baseUrl.replace(/\/+$/, '');
  if (!isSafeExternalHttpUrl(base)) {
    return {
      ok: false,
      sourceId: source.id,
      sourceName: source.name,
      message: 'URL externa inválida ou bloqueada por segurança.',
      latencyMs: 0,
    };
  }

  try {
    const res = await fetchHttp(base, {
      method: 'GET',
      timeoutMs: 8000,
    });
    const latencyMs = Date.now() - startedAt;
    if (res.ok) {
      return {
        ok: true,
        sourceId: source.id,
        sourceName: source.name,
        statusCode: res.status,
        message: `Conexão OK (HTTP ${res.status}, ${latencyMs} ms).`,
        latencyMs,
      };
    }
    return {
      ok: false,
      sourceId: source.id,
      sourceName: source.name,
      statusCode: res.status,
      message: `Servidor respondeu com HTTP ${res.status}.`,
      latencyMs,
    };
  } catch (err) {
    return {
      ok: false,
      sourceId: source.id,
      sourceName: source.name,
      message: err instanceof Error ? err.message : 'Falha de conexão ao testar servidor.',
      latencyMs: Date.now() - startedAt,
    };
  }
}
