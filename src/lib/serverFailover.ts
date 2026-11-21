import { isSameEpisodeUrl } from './nativeVlcPlayer';
import type { PlayerOption, ResolvedEmbed, StreamQuality } from './types';

const PROVIDER_TIEBREAKER: Record<PlayerOption['providerKind'], number> = {
  kojima: 5,
  zuplay: 4,
  vidstreaming: 3,
  playerjs: 2,
  blogger: 1,
  other: 1,
  abyss: 0,
};

/**
 * Computes a numeric quality score for a stream so failover always picks
 * the server offering the highest video resolution.
 * Adaptive HLS streams without an explicit height in the playlist link default
 * to 720 so explicit 1080p streams beat them, while adaptive HLS beats 480p/360p.
 */
export function scoreStreamQuality(stream: Pick<StreamQuality, 'height' | 'format' | 'url'>): number {
  if (typeof stream.height === 'number' && Number.isFinite(stream.height) && stream.height > 0) {
    return stream.height;
  }
  const isHls = stream.format === 'hls' || /\.m3u8(?:$|\?)/i.test(stream.url || '');
  return isHls ? 720 : 1;
}

export function getResolvedBestQuality(
  resolved: Pick<ResolvedEmbed, 'status' | 'streams'> | null | undefined
): { score: number; label: string } {
  if (!resolved || resolved.status !== 'resolved' || !resolved.streams.length) {
    return { score: 0, label: '' };
  }
  let bestScore = 0;
  let bestLabel = '';
  for (const s of resolved.streams) {
    const score = scoreStreamQuality(s);
    if (score > bestScore) {
      bestScore = score;
      bestLabel = s.label || (s.height > 0 ? `${s.height}p` : 'Auto');
    }
  }
  return { score: bestScore, label: bestLabel };
}

export interface ServerResolutionCandidate {
  option: PlayerOption;
  resolved: ResolvedEmbed;
  orderIndex: number;
}

export function pickBestFailoverServer(
  candidates: readonly ServerResolutionCandidate[],
  failedServerNumes: ReadonlySet<string>
): { option: PlayerOption; resolved: ResolvedEmbed; qualityLabel: string; qualityScore: number } | null {
  const viable = candidates
    .filter(
      (c) =>
        !failedServerNumes.has(c.option.nume) &&
        c.resolved.status === 'resolved' &&
        c.resolved.streams.length > 0
    )
    .map((c) => {
      const best = getResolvedBestQuality(c.resolved);
      return {
        ...c,
        qualityScore: best.score,
        qualityLabel: best.label,
        providerScore: PROVIDER_TIEBREAKER[c.option.providerKind] ?? 0,
      };
    });

  if (!viable.length) return null;

  viable.sort((a, b) => {
    if (b.qualityScore !== a.qualityScore) return b.qualityScore - a.qualityScore;
    if (b.providerScore !== a.providerScore) return b.providerScore - a.providerScore;
    return a.orderIndex - b.orderIndex;
  });

  const winner = viable[0];
  return {
    option: winner.option,
    resolved: winner.resolved,
    qualityLabel: winner.qualityLabel,
    qualityScore: winner.qualityScore,
  };
}

/**
 * Guards auto-advancing to the next episode so stale events, unstarted/broken
 * episodes, or duplicate end triggers never skip intermediate chapters.
 */
export function shouldAutoAdvanceEpisode(params: {
  autoPlayNextEpisode: boolean;
  loadingEpisode: boolean;
  playbackFailed: boolean;
  hasPlaybackStarted: boolean;
  currentEpisodeUrl?: string;
  nextEpisodeUrl?: string;
  alreadyTriggeredForUrl?: string | null;
}): boolean {
  if (!params.autoPlayNextEpisode) return false;
  if (params.loadingEpisode || params.playbackFailed) return false;
  if (!params.hasPlaybackStarted) return false;
  if (!params.currentEpisodeUrl || !params.nextEpisodeUrl) return false;
  if (isSameEpisodeUrl(params.currentEpisodeUrl, params.nextEpisodeUrl)) return false;
  if (
    params.alreadyTriggeredForUrl &&
    isSameEpisodeUrl(params.alreadyTriggeredForUrl, params.currentEpisodeUrl)
  ) {
    return false;
  }
  return true;
}
