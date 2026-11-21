import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Heart,
  Keyboard,
  Server,
} from 'lucide-react';
import { apiFetch } from '../lib/apiClient';
import { extractEpisodeNumber, normalizeTopAnimesUrl } from '../lib/favoriteAlerts';
import { isDesktopShortcutsEnabled } from '../lib/nativeVlcPlayer';
import type {
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
  onToggleFavorite: (item: CatalogMediaItem, knownLatest?: FavoriteLatestInfo | null) => void;
  onBack: () => void;
  onNavigateUrl: (url: string, kind: 'episode' | 'anime' | 'movie') => void;
  onToast: (message: string) => void;
}

export function EpisodeWorkspace({
  episode,
  isFavorite,
  onToggleFavorite,
  onBack,
  onNavigateUrl,
  onToast,
}: EpisodeWorkspaceProps) {
  const desktopShortcutsEnabled = isDesktopShortcutsEnabled();
  const playableOptions = episode.options.filter(
    (o) => o.providerKind !== 'abyss' && !/aniplay/i.test(o.label)
  );

  const [selectedOption, setSelectedOption] = useState<PlayerOption | null>(() => {
    return (
      playableOptions.find((o) =>
        ['kojima', 'zuplay', 'vidstreaming', 'playerjs'].includes(o.providerKind)
      ) ||
      playableOptions[0] ||
      null
    );
  });
  const [resolved, setResolved] = useState<ResolvedEmbed | null>(null);
  const [loadingEmbed, setLoadingEmbed] = useState(false);

  // Reset selected server whenever episode changes
  useEffect(() => {
    const filtered = episode.options.filter(
      (o) => o.providerKind !== 'abyss' && !/aniplay/i.test(o.label)
    );
    const preferred =
      filtered.find((o) =>
        ['kojima', 'zuplay', 'vidstreaming', 'playerjs'].includes(o.providerKind)
      ) ||
      filtered[0] ||
      null;
    setSelectedOption(preferred);
    setResolved(null);
  }, [episode]);

  // Resolve chosen server via backend
  useEffect(() => {
    if (!selectedOption) return;
    let cancelled = false;
    setLoadingEmbed(true);
    setResolved(null);

    apiFetch(`/api/resolve-embed?url=${encodeURIComponent(selectedOption.embedUrl)}`)
      .then((res) => res.json())
      .then((data: ResolvedEmbed) => {
        if (cancelled) return;
        setResolved(data);
      })
      .catch(() => {
        if (cancelled) return;
        setResolved({
          embedUrl: selectedOption.embedUrl,
          provider: selectedOption.label,
          status: 'error',
          streams: [],
          subtitles: [],
          referer: 'https://topanimes.net/',
          errorMessage: 'Não foi possível contactar o servidor de extração.',
        });
      })
      .finally(() => {
        if (!cancelled) setLoadingEmbed(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedOption]);

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
            <span>Catálogo</span>
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
            disabled={!episode.prevUrl}
            onClick={() => episode.prevUrl && onNavigateUrl(episode.prevUrl, 'episode')}
            className="inline-flex items-center gap-1 rounded-lg border border-white/12 bg-[#151921] px-3 py-2 text-xs font-medium text-slate-200 transition-colors hover:border-white/25 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronLeft className="h-4 w-4" />
            <span>Anterior</span>
          </button>
          <button
            type="button"
            disabled={!episode.nextUrl}
            onClick={() => episode.nextUrl && onNavigateUrl(episode.nextUrl, 'episode')}
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
          {/* Custom Script AnimePlayer */}
          {loadingEmbed ? (
            <div className="flex aspect-video w-full flex-col items-center justify-center rounded-xl border border-white/10 bg-[#151921] p-6 text-center">
              <div className="h-10 w-10 animate-spin rounded-full border-3 border-white/15 border-t-[#f97316]" />
              <p className="mt-3 text-sm font-medium text-slate-300">
                Extraindo vídeo e legendas...
              </p>
            </div>
          ) : resolved?.status === 'resolved' && resolved.streams.length > 0 ? (
            <AnimePlayer
              title={episode.title}
              streams={resolved.streams}
              referer={resolved.referer}
              preferDirect={resolved.preferDirect}
              poster={episode.backdrop || episode.poster}
              subtitles={resolved.subtitles}
              hasPrev={Boolean(episode.prevUrl)}
              hasNext={Boolean(episode.nextUrl)}
              onPrevEpisode={() => episode.prevUrl && onNavigateUrl(episode.prevUrl, 'episode')}
              onNextEpisode={() => episode.nextUrl && onNavigateUrl(episode.nextUrl, 'episode')}
              onToast={onToast}
            />
          ) : (
            <div className="flex aspect-video w-full flex-col items-center justify-center rounded-xl border border-white/10 bg-[#151921] p-6 text-center">
              <p className="max-w-md text-sm leading-relaxed text-slate-300">
                {resolved?.errorMessage ||
                  'Selecione outro servidor abaixo (KojimaCDN, Zuplay, Vidstreaming ou ruplay) para assistir no player.'}
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
                        onClick={() => setSelectedOption(opt)}
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
                  <strong className="text-slate-200">Gestos &amp; Atalhos:</strong> toque duplo nas laterais para ±5s, segure na tela ou Espaço para 2×, botão <strong className="text-slate-200">+85s</strong> pula abertura, e arraste arquivos <span className="font-mono">.ass/.srt/.vtt</span> para carregar legendas locais.
                </span>
              ) : (
                <span>
                  <strong className="text-slate-200">Controles Touch (LibVLC):</strong> toque duplo nas laterais para ±5s, segure no vídeo para 2×, botão <strong className="text-slate-200">+85s</strong> pula abertura e gerencie áudio, legendas e qualidade diretamente no player.
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
