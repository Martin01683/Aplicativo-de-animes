import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Heart,
  Keyboard,
  Server,
} from 'lucide-react';
import { apiFetch } from '../lib/apiClient';
import {
  createEmbedCacheEntry,
  isEmbedCacheEntryValid,
  type CachedEmbedEntry,
} from '../lib/embedCache';
import { extractEpisodeNumber, normalizeTopAnimesUrl } from '../lib/favoriteAlerts';
import {
  isDesktopShortcutsEnabled,
  isSameEpisodeUrl,
  resolveSeriesPrevNext,
  type NativeVlcPlayResult,
} from '../lib/nativeVlcPlayer';
import {
  isEpisodeMarkedWatched,
  type EpisodeProgressMap,
  type VideoScaleMode,
} from '../lib/playbackProgress';
import { pickBestFailoverServer } from '../lib/serverFailover';
import { formatServerLabel } from '../lib/topanimesParser';
import type {
  AnimeDetails,
  AnimeEpisodeLink,
  CatalogMediaItem,
  EpisodeDetails,
  FavoriteLatestInfo,
  PlayerOption,
  ResolvedEmbed,
} from '../lib/types';
import { AnimePlayer } from './AnimePlayer';
import { MediaPoster } from './MediaPoster';

interface EpisodeWorkspaceProps {
  episode: EpisodeDetails;
  isFavorite: boolean;
  watchedUrls?: Set<string>;
  progressMap?: EpisodeProgressMap;
  initialSeriesEpisodes?: AnimeEpisodeLink[];
  loadingEpisode?: boolean;
  onToggleFavorite: (item: CatalogMediaItem, knownLatest?: FavoriteLatestInfo | null) => void;
  onToggleEpisodeWatched?: (episode: EpisodeDetails, watched: boolean) => void;
  onBack: () => void;
  onNavigateUrl: (url: string, kind: 'episode' | 'anime' | 'movie') => void;
  onNativeSessionSync?: (result: NativeVlcPlayResult) => void;
  onPlaybackProgress?: () => void;
  onToast: (message: string) => void;
  skipIntroSeconds?: number;
  autoPlayNextEpisode?: boolean;
  videoScale?: VideoScaleMode;
  onChangeVideoScale?: (scale: VideoScaleMode) => void;
}

interface ScopedResolvedEmbed {
  episodeUrl: string;
  embedUrl: string;
  data: ResolvedEmbed;
}

function pickInitialOption(options: PlayerOption[]): PlayerOption | null {
  return (
    options.find((o) =>
      ['kojima', 'zuplay', 'vidstreaming', 'playerjs'].includes(o.providerKind)
    ) ||
    options[0] ||
    null
  );
}

export function EpisodeWorkspace({
  episode,
  isFavorite,
  watchedUrls,
  progressMap,
  initialSeriesEpisodes,
  loadingEpisode = false,
  onToggleFavorite,
  onToggleEpisodeWatched,
  onBack,
  onNavigateUrl,
  onNativeSessionSync,
  onPlaybackProgress,
  onToast,
  skipIntroSeconds = 85,
  autoPlayNextEpisode = false,
  videoScale,
  onChangeVideoScale,
}: EpisodeWorkspaceProps) {
  const desktopShortcutsEnabled = isDesktopShortcutsEnabled();
  const playableOptions = useMemo(
    () =>
      episode.options
        .filter((o) => o.providerKind !== 'abyss' && !/aniplay/i.test(o.label))
        .map((o) => ({ ...o, label: formatServerLabel(o.label, `Servidor ${o.nume}`) })),
    [episode.options]
  );

  const [selectedOption, setSelectedOption] = useState<PlayerOption | null>(() =>
    pickInitialOption(playableOptions)
  );
  const [resolvedState, setResolvedState] = useState<ScopedResolvedEmbed | null>(null);
  const [loadingEmbed, setLoadingEmbed] = useState(false);
  const [failoverExhaustedMsg, setFailoverExhaustedMsg] = useState('');
  const [resumeAfterFailover, setResumeAfterFailover] = useState<{
    timeSec: number;
    autoStart: boolean;
    key: number;
  } | null>(null);

  const embedCacheRef = useRef<Map<string, CachedEmbedEntry>>(new Map());
  const failedServersByEpisodeRef = useRef<Map<string, Set<string>>>(new Map());
  const activeEpisodeUrlRef = useRef(episode.url);
  activeEpisodeUrlRef.current = episode.url;

  const seriesCacheRef = useRef<Map<string, AnimeEpisodeLink[]>>(new Map());
  const [seriesEpisodes, setSeriesEpisodes] = useState<AnimeEpisodeLink[]>(
    initialSeriesEpisodes || []
  );

  const resolved =
    resolvedState &&
    isSameEpisodeUrl(resolvedState.episodeUrl, episode.url) &&
    resolvedState.embedUrl === selectedOption?.embedUrl
      ? resolvedState.data
      : null;

  // Remember whether the player has mounted at least once in this session so fullscreen stays intact during episode switches
  const hasMountedPlayerRef = useRef(false);
  if (resolved?.status === 'resolved' && resolved.streams.length > 0) {
    hasMountedPlayerRef.current = true;
  }

  // Reset selected server whenever episode changes
  useEffect(() => {
    const filtered = episode.options
      .filter((o) => o.providerKind !== 'abyss' && !/aniplay/i.test(o.label))
      .map((o) => ({ ...o, label: formatServerLabel(o.label, `Servidor ${o.nume}`) }));
    setSelectedOption(pickInitialOption(filtered));
    setResolvedState(null);
    setFailoverExhaustedMsg('');
    setResumeAfterFailover(null);
  }, [episode]);

  // Fetch and cache the series episode list so in-fullscreen episode selection is always populated
  useEffect(() => {
    if (episode.isMovie || !episode.seriesUrl) {
      setSeriesEpisodes([]);
      return;
    }

    const seriesKey = normalizeTopAnimesUrl(episode.seriesUrl) || episode.seriesUrl;
    if (initialSeriesEpisodes && initialSeriesEpisodes.length > 0) {
      seriesCacheRef.current.set(seriesKey, initialSeriesEpisodes);
      setSeriesEpisodes(initialSeriesEpisodes);
      return;
    }

    const cached = seriesCacheRef.current.get(seriesKey);
    if (cached && cached.length > 0) {
      setSeriesEpisodes(cached);
      return;
    }

    let cancelled = false;
    apiFetch(`/api/anime?url=${encodeURIComponent(episode.seriesUrl)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: AnimeDetails | null) => {
        if (cancelled || !data || !Array.isArray(data.episodes)) return;
        seriesCacheRef.current.set(seriesKey, data.episodes);
        setSeriesEpisodes(data.episodes);
      })
      .catch(() => {
        // Ignore silent series fetch failures
      });

    return () => {
      cancelled = true;
    };
  }, [episode.isMovie, episode.seriesUrl, initialSeriesEpisodes]);

  const resolveEmbedCached = useCallback(async (opt: PlayerOption): Promise<ResolvedEmbed> => {
    const cacheKey = opt.embedUrl;
    const cached = embedCacheRef.current.get(cacheKey);
    if (isEmbedCacheEntryValid(cached)) {
      return cached.data;
    }
    if (cached) {
      embedCacheRef.current.delete(cacheKey);
    }

    try {
      const res = await apiFetch(`/api/resolve-embed?url=${encodeURIComponent(opt.embedUrl)}`);
      const data = (await res.json()) as ResolvedEmbed;
      const entry = createEmbedCacheEntry(data);
      if (entry) {
        embedCacheRef.current.set(cacheKey, entry);
      } else {
        embedCacheRef.current.delete(cacheKey);
      }
      return data;
    } catch {
      return {
        embedUrl: opt.embedUrl,
        provider: opt.label,
        status: 'error',
        streams: [],
        subtitles: [],
        referer: 'https://topanimes.net/',
        errorMessage: 'Não foi possível contactar o servidor de extração.',
      };
    }
  }, []);

  const findBestAvailableServer = useCallback(
    async (episodeUrlKey: string, failedSet: Set<string>) => {
      const remaining = playableOptions
        .map((option, orderIndex) => ({ option, orderIndex }))
        .filter((item) => !failedSet.has(item.option.nume));

      if (!remaining.length) return null;

      const settled = await Promise.all(
        remaining.map(async ({ option, orderIndex }) => ({
          option,
          orderIndex,
          resolved: await resolveEmbedCached(option),
        }))
      );

      return pickBestFailoverServer(settled, failedSet);
    },
    [playableOptions, resolveEmbedCached]
  );

  // Resolve chosen server via backend (and auto-failover to best quality server if resolution fails)
  useEffect(() => {
    if (!selectedOption) return;
    const targetEpisodeUrl = episode.url;
    const targetOption = selectedOption;
    let cancelled = false;
    setLoadingEmbed(true);
    setFailoverExhaustedMsg('');

    const run = async () => {
      const data = await resolveEmbedCached(targetOption);
      if (cancelled || !isSameEpisodeUrl(activeEpisodeUrlRef.current, targetEpisodeUrl)) return;

      if (data.status === 'resolved' && data.streams.length > 0) {
        setResolvedState({
          episodeUrl: targetEpisodeUrl,
          embedUrl: targetOption.embedUrl,
          data,
        });
        return;
      }

      // Current server failed to resolve playable streams — probe remaining servers in parallel for best quality
      const epKey = normalizeTopAnimesUrl(targetEpisodeUrl) || targetEpisodeUrl;
      const failedSet = failedServersByEpisodeRef.current.get(epKey) ?? new Set<string>();
      failedSet.add(targetOption.nume);
      failedServersByEpisodeRef.current.set(epKey, failedSet);

      const winner = await findBestAvailableServer(epKey, failedSet);
      if (cancelled || !isSameEpisodeUrl(activeEpisodeUrlRef.current, targetEpisodeUrl)) return;

      if (winner) {
        setSelectedOption(winner.option);
        setResolvedState({
          episodeUrl: targetEpisodeUrl,
          embedUrl: winner.option.embedUrl,
          data: winner.resolved,
        });
        onToast(
          `Servidor indisponível — trocado para ${winner.option.label}${
            winner.qualityLabel ? ` (${winner.qualityLabel})` : ''
          }`
        );
      } else {
        setResolvedState({
          episodeUrl: targetEpisodeUrl,
          embedUrl: targetOption.embedUrl,
          data,
        });
      }
    };

    void run().finally(() => {
      if (!cancelled) setLoadingEmbed(false);
    });

    return () => {
      cancelled = true;
    };
  }, [episode.url, findBestAvailableServer, onToast, resolveEmbedCached, selectedOption]);

  const handleServerPlaybackFailed = useCallback(
    async (failedNume: string, resumeTimeSec: number) => {
      const targetEpisodeUrl = episode.url;
      const epKey = normalizeTopAnimesUrl(targetEpisodeUrl) || targetEpisodeUrl;
      const failedSet = failedServersByEpisodeRef.current.get(epKey) ?? new Set<string>();
      failedSet.add(failedNume);
      failedServersByEpisodeRef.current.set(epKey, failedSet);

      // Invalidate any cached signed stream URL (e.g. expired BunnyCDN token) for the failed server
      const failedOpt = playableOptions.find((o) => o.nume === failedNume);
      if (failedOpt) {
        embedCacheRef.current.delete(failedOpt.embedUrl);
      }

      setLoadingEmbed(true);
      try {
        const winner = await findBestAvailableServer(epKey, failedSet);
        if (!isSameEpisodeUrl(activeEpisodeUrlRef.current, targetEpisodeUrl)) return;

        if (winner) {
          setFailoverExhaustedMsg('');
          setResumeAfterFailover({
            timeSec: resumeTimeSec > 2 ? resumeTimeSec : 0,
            autoStart: true,
            key: Date.now(),
          });
          setSelectedOption(winner.option);
          setResolvedState({
            episodeUrl: targetEpisodeUrl,
            embedUrl: winner.option.embedUrl,
            data: winner.resolved,
          });
          onToast(
            `Falha no servidor — trocado para ${winner.option.label}${
              winner.qualityLabel ? ` (${winner.qualityLabel})` : ''
            }`
          );
        } else {
          setFailoverExhaustedMsg(
            'Nenhum servidor conseguiu reproduzir este episódio. Tente novamente ou selecione outro servidor abaixo.'
          );
        }
      } finally {
        setLoadingEmbed(false);
      }
    },
    [episode.url, findBestAvailableServer, onToast, playableOptions]
  );

  const handleManualServerSelect = useCallback(
    (opt: PlayerOption) => {
      const epKey = normalizeTopAnimesUrl(episode.url) || episode.url;
      const failedSet = failedServersByEpisodeRef.current.get(epKey);
      if (failedSet?.has(opt.nume)) {
        failedSet.delete(opt.nume);
        embedCacheRef.current.delete(opt.embedUrl);
      }
      setFailoverExhaustedMsg('');
      setSelectedOption({ ...opt });
    },
    [episode.url]
  );

  const handleRetryAllServers = useCallback(() => {
    const epKey = normalizeTopAnimesUrl(episode.url) || episode.url;
    failedServersByEpisodeRef.current.delete(epKey);
    embedCacheRef.current.clear();
    setFailoverExhaustedMsg('');
    const first = pickInitialOption(playableOptions);
    if (first) {
      setSelectedOption({ ...first });
    }
  }, [episode.url, playableOptions]);

  const adjacent = useMemo(
    () => resolveSeriesPrevNext(seriesEpisodes, episode.url),
    [seriesEpisodes, episode.url]
  );

  const effectivePrevUrl = episode.prevUrl || adjacent.prevUrl;
  const effectiveNextUrl = episode.nextUrl || adjacent.nextUrl;

  const isTransitioning = loadingEpisode || loadingEmbed;
  const hasResolvedStreams =
    resolved?.status === 'resolved' && resolved.streams.length > 0;
  const showPlayer = hasResolvedStreams || hasMountedPlayerRef.current;

  const epKey = normalizeTopAnimesUrl(episode.url) || episode.url;
  const currentFailedSet = failedServersByEpisodeRef.current.get(epKey);
  const hasUntriedFallbackServers = playableOptions.some(
    (opt) => opt.nume !== selectedOption?.nume && !currentFailedSet?.has(opt.nume)
  );

  return (
    <div className="mx-auto max-w-7xl px-4 py-5 sm:px-6 sm:py-8 lg:px-8">
      {/* Top Breadcrumb & Prev/Next Episode Controls */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 sm:mb-6">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-slate-400 sm:text-sm">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1.5 font-medium text-slate-300 transition-colors hover:text-white"
          >
            <ArrowLeft className="h-4 w-4" />
            <span>Voltar</span>
          </button>
          {episode.seriesUrl && (
            <>
              <span>/</span>
              <button
                type="button"
                onClick={() => onNavigateUrl(episode.seriesUrl!, 'anime')}
                className="truncate font-medium text-slate-300 transition-colors hover:text-[#f97316]"
              >
                {episode.seriesTitle}
              </button>
            </>
          )}
          {episode.episodeLabel && (
            <>
              <span>/</span>
              <span className="text-slate-200">{episode.episodeLabel}</span>
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!effectivePrevUrl || isTransitioning}
            onClick={() => effectivePrevUrl && onNavigateUrl(effectivePrevUrl, 'episode')}
            className="inline-flex items-center gap-1 rounded-lg border border-white/12 bg-[#151921] px-3 py-2 text-xs font-medium text-slate-200 transition-colors hover:border-white/25 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronLeft className="h-4 w-4" />
            <span>Anterior</span>
          </button>
          <button
            type="button"
            disabled={!effectiveNextUrl || isTransitioning}
            onClick={() => effectiveNextUrl && onNavigateUrl(effectiveNextUrl, 'episode')}
            className="inline-flex items-center gap-1 rounded-lg border border-white/12 bg-[#151921] px-3 py-2 text-xs font-medium text-slate-200 transition-colors hover:border-white/25 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <span>Próximo</span>
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Main Cinema Player + Metadata Layout */}
      <div className="grid gap-6 lg:grid-cols-[1fr_320px] lg:gap-8">
        <div className="min-w-0 space-y-5">
          {showPlayer ? (
            <AnimePlayer
              title={episode.title}
              episodeUrl={episode.url}
              seriesUrl={episode.seriesUrl}
              seriesTitle={episode.seriesTitle}
              seriesEpisodes={seriesEpisodes}
              watchedUrls={watchedUrls}
              playerOptions={playableOptions}
              selectedServerNume={selectedOption?.nume}
              streams={hasResolvedStreams ? resolved.streams : []}
              referer={resolved?.referer || 'https://topanimes.net/'}
              preferDirect={resolved?.preferDirect}
              poster={episode.backdrop || episode.poster}
              subtitles={hasResolvedStreams ? resolved.subtitles : []}
              hasPrev={Boolean(effectivePrevUrl)}
              hasNext={Boolean(effectiveNextUrl)}
              prevUrl={effectivePrevUrl}
              nextUrl={effectiveNextUrl}
              loadingEpisode={isTransitioning}
              hasUntriedFallbackServers={hasUntriedFallbackServers}
              resumeAfterFailover={resumeAfterFailover}
              errorMessage={
                failoverExhaustedMsg ||
                (!isTransitioning && !hasResolvedStreams
                  ? resolved?.errorMessage ||
                    'Selecione outro servidor abaixo (KojimaCDN, Zuplay, Vidstreaming ou Ruplay) para assistir no player.'
                  : '')
              }
              skipIntroSeconds={skipIntroSeconds}
              autoPlayNextEpisode={autoPlayNextEpisode}
              videoScale={videoScale}
              onPrevEpisode={() =>
                effectivePrevUrl && onNavigateUrl(effectivePrevUrl, 'episode')
              }
              onNextEpisode={() =>
                effectiveNextUrl && onNavigateUrl(effectiveNextUrl, 'episode')
              }
              onSelectEpisode={(epUrl) => {
                if (!isSameEpisodeUrl(epUrl, episode.url)) {
                  onNavigateUrl(epUrl, 'episode');
                }
              }}
              onSelectServer={(nume) => {
                const match = playableOptions.find((o) => o.nume === nume);
                if (match) handleManualServerSelect(match);
              }}
              onChangeVideoScale={onChangeVideoScale}
              onPlaybackProgress={onPlaybackProgress}
              onServerPlaybackFailed={handleServerPlaybackFailed}
              onRetryEpisodePlayback={handleRetryAllServers}
              onNativeSessionSync={onNativeSessionSync}
              onToast={onToast}
            />
          ) : isTransitioning ? (
            <div className="flex aspect-video w-full flex-col items-center justify-center rounded-xl border border-white/10 bg-[#151921] p-6 text-center">
              <div className="h-10 w-10 animate-spin rounded-full border-3 border-white/15 border-t-[#f97316]" />
              <p className="mt-3 text-sm font-medium text-slate-300">
                Extraindo vídeo e legendas...
              </p>
            </div>
          ) : (
            <div className="flex aspect-video w-full flex-col items-center justify-center rounded-xl border border-white/10 bg-[#151921] p-6 text-center">
              <p className="max-w-md text-sm leading-relaxed text-slate-300">
                {failoverExhaustedMsg ||
                  resolved?.errorMessage ||
                  'Selecione outro servidor abaixo (KojimaCDN, Zuplay, Vidstreaming ou Ruplay) para assistir no player.'}
              </p>
            </div>
          )}

          {/* Title, Favorite & Server Switcher Card */}
          <section className="rounded-xl border border-white/10 bg-[#151921] p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/8 pb-4">
              <div className="min-w-0">
                <h1 className="text-lg font-bold text-white sm:text-2xl">
                  {episode.title}
                </h1>
                {episode.genres.length > 0 && (
                  <p className="mt-1 text-xs text-slate-400">
                    {episode.genres.join(' · ')}
                  </p>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {onToggleEpisodeWatched && (() => {
                  const watched = isEpisodeMarkedWatched(episode.url, progressMap, watchedUrls);
                  return (
                    <button
                      type="button"
                      onClick={() => onToggleEpisodeWatched(episode, !watched)}
                      aria-pressed={watched}
                      className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                        watched
                          ? 'border-emerald-500/45 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/20'
                          : 'border-white/12 bg-[#0d0f12] text-slate-300 hover:border-emerald-500/50 hover:text-white'
                      }`}
                    >
                      <Check className="h-3.5 w-3.5" />
                      <span>{watched ? 'Visto' : 'Marcar como visto'}</span>
                    </button>
                  );
                })()}

                <button
                  type="button"
                  onClick={() => {
                    const epNum =
                      extractEpisodeNumber(episode.episodeLabel || '') ??
                      extractEpisodeNumber(episode.title) ??
                      extractEpisodeNumber(episode.url);
                    onToggleFavorite(
                      {
                        id: episode.seriesUrl || episode.url,
                        title: episode.seriesTitle,
                        url: episode.seriesUrl || episode.url,
                        kind: episode.isMovie ? 'movie' : 'anime',
                        poster: episode.poster || episode.backdrop,
                        audioType: null,
                      },
                      episode.isMovie
                        ? null
                        : {
                            episodeUrl: normalizeTopAnimesUrl(episode.url),
                            episodeTitle: episode.title,
                            episodeLabel:
                              episode.episodeLabel ||
                              (epNum !== null ? `EP ${epNum}` : 'Episódio atual'),
                            episodeNumber: epNum,
                            poster: episode.backdrop || episode.poster,
                          }
                    );
                  }}
                  aria-pressed={isFavorite}
                  className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                    isFavorite
                      ? 'border-rose-500/40 bg-rose-500/10 text-rose-300'
                      : 'border-white/12 bg-[#0d0f12] text-slate-300 hover:text-white'
                  }`}
                >
                  <Heart
                    className={`h-3.5 w-3.5 ${isFavorite ? 'fill-rose-400 text-rose-400' : ''}`}
                  />
                  <span>{isFavorite ? 'Nos Favoritos' : 'Favoritar'}</span>
                </button>
              </div>
            </div>

            <div className="pt-4">
              <div className="mb-2.5 flex items-center justify-between gap-2 text-xs font-medium text-slate-400">
                <span className="inline-flex items-center gap-2">
                  <Server className="h-3.5 w-3.5 text-[#f97316]" />
                  <span>Servidores</span>
                </span>
                {resolved?.status === 'resolved' && (
                  <span className="text-[11px] text-emerald-400">
                    {resolved.provider}
                  </span>
                )}
              </div>

              {playableOptions.length === 0 ? (
                <p className="text-sm text-amber-300">
                  Nenhum servidor de vídeo compatível foi encontrado nesta página.
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {playableOptions.map((opt) => {
                    const active = selectedOption?.nume === opt.nume;
                    return (
                      <button
                        key={opt.nume}
                        type="button"
                        onClick={() => handleManualServerSelect(opt)}
                        className={`min-h-[40px] rounded-lg border px-3.5 py-2 text-xs font-medium transition-colors sm:text-sm ${
                          active
                            ? 'border-[#f97316] bg-[#f97316]/15 text-white'
                            : 'border-white/10 bg-[#0d0f12] text-slate-300 hover:border-white/25 hover:text-white'
                        }`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-white/8 bg-[#0d0f12] px-3.5 py-2.5 text-[11px] leading-relaxed text-slate-400">
              <Keyboard className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#f97316]" />
              {desktopShortcutsEnabled ? (
                <span>
                  <strong className="text-slate-200">Gestos &amp; Atalhos:</strong> toque duplo nas laterais para ±5s, segure na tela ou Espaço para 2×, botão <strong className="text-slate-200">+{skipIntroSeconds}s</strong> pula abertura, e arraste arquivos <span className="font-mono">.ass/.srt/.vtt</span> para carregar legendas locais.
                </span>
              ) : (
                <span>
                  <strong className="text-slate-200">Gestos:</strong> deslize esq./dir. para brilho e volume · toque duplo ±5s · segure 2×.
                </span>
              )}
            </div>
          </section>
        </div>

        {/* Episode Metadata Sidebar */}
        <aside className="space-y-4">
          <div className="overflow-hidden rounded-xl border border-white/10 bg-[#151921]">
            <MediaPoster
              src={episode.backdrop || episode.poster}
              alt={episode.title}
              aspect="landscape"
              className="w-full border-b border-white/8"
            />
            <div className="p-5">
              <div className="text-xs font-medium text-[#f97316]">
                {episode.isMovie ? 'Filme' : 'Episódio'}
              </div>
              <h2 className="mt-1 text-base font-semibold text-white">
                {episode.seriesTitle}
              </h2>
              {episode.synopsis && (
                <p className="mt-3 text-xs leading-relaxed text-slate-400">
                  {episode.synopsis}
                </p>
              )}
              {episode.seriesUrl && (
                <button
                  type="button"
                  onClick={() => onNavigateUrl(episode.seriesUrl!, 'anime')}
                  className="mt-4 w-full rounded-lg border border-white/12 bg-[#0d0f12] px-3 py-2.5 text-xs font-medium text-slate-200 transition-colors hover:border-[#f97316]/60 hover:text-white"
                >
                  Ver todos os episódios
                </button>
              )}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
