import { useEffect, useMemo, useState } from 'react';
import {
  ArrowDownNarrowWide,
  ArrowLeft,
  ArrowUpWideNarrow,
  Bell,
  BellOff,
  Building2,
  Calendar,
  Check,
  CheckCheck,
  Clock,
  CloudOff,
  ExternalLink,
  Film,
  Globe,
  Heart,
  Layers,
  Play,
  Radio,
  Search,
  SkipForward,
  Star,
  Tv,
  X,
} from 'lucide-react';
import { isNativeAndroidApp, openExternalOrVlcUrl } from '../lib/apiClient';
import {
  formatEpisodeCountdown,
  formatEpisodeReleaseDate,
  isEpisodeAvailableOnServer,
} from '../lib/episodeAvailability';
import { pickLatestAnimeEpisode } from '../lib/favoriteAlerts';
import {
  canonicalEpisodeProgressKey,
  formatPlaybackTimestamp,
  getResumePositionSec,
  groupEpisodesBySeason,
  isEpisodeMarkedWatched,
  type EpisodeProgressMap,
} from '../lib/playbackProgress';
import type {
  AnimeDetails,
  AnimeEpisodeLink,
  CatalogMediaItem,
  CatalogSourceId,
  FavoriteLatestInfo,
} from '../lib/types';
import { MediaPoster } from './MediaPoster';

interface AnimeDetailViewProps {
  anime: AnimeDetails;
  isFavorite: boolean;
  isMuted?: boolean;
  watchedUrls: Set<string>;
  progressMap?: EpisodeProgressMap;
  onToggleFavorite: (item: CatalogMediaItem, knownLatest?: FavoriteLatestInfo | null) => void;
  onToggleMuteFavorite?: (animeUrl: string) => void;
  onToggleEpisodesWatched: (
    episodes: AnimeEpisodeLink[],
    watched: boolean,
    label?: string
  ) => void;
  onOpenEpisode: (episodeUrl: string) => void;
  onOpenAnime?: (animeUrl: string) => void;
  onBack: () => void;
}

const SOURCE_BADGE_STYLE: Record<CatalogSourceId, string> = {
  thetvdb: 'border-[#f97316]/35 bg-[#f97316]/12 text-[#fb923c] hover:bg-[#f97316]/20',
  livechart: 'border-[#f97316]/35 bg-[#f97316]/12 text-[#fb923c] hover:bg-[#f97316]/20',
  server: 'border-white/15 bg-white/8 text-slate-200 hover:bg-white/12',
};

export function AnimeDetailView({
  anime,
  isFavorite,
  isMuted = false,
  watchedUrls,
  progressMap,
  onToggleFavorite,
  onToggleMuteFavorite,
  onToggleEpisodesWatched,
  onOpenEpisode,
  onOpenAnime,
  onBack,
}: AnimeDetailViewProps) {
  const [episodeFilter, setEpisodeFilter] = useState('');
  const [sortDesc, setSortDesc] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    setEpisodeFilter('');
    setSortDesc(false);
  }, [anime.url]);

  const hasScheduledEpisodes = useMemo(
    () => anime.episodes.some((ep) => !isEpisodeAvailableOnServer(ep)),
    [anime.episodes]
  );

  useEffect(() => {
    if (!hasScheduledEpisodes) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [hasScheduledEpisodes]);

  const isMovie = anime.kind === 'movie';
  const isSeries = anime.kind === 'series';

  const playableEpisodes = useMemo(
    () => anime.episodes.filter(isEpisodeAvailableOnServer),
    [anime.episodes]
  );
  const unavailableCount = anime.episodes.length - playableEpisodes.length;

  const latestEpisode = pickLatestAnimeEpisode(playableEpisodes, anime.title, anime.poster);
  const firstEpisode = playableEpisodes[0];
  const lastEpisodeItem =
    playableEpisodes.length > 1 ? playableEpisodes[playableEpisodes.length - 1] : null;
  const quickLastEpisode =
    !isMovie && latestEpisode && firstEpisode && latestEpisode.episodeUrl !== firstEpisode.url
      ? {
          url: latestEpisode.episodeUrl,
          label: latestEpisode.episodeLabel || latestEpisode.episodeTitle,
        }
      : !isMovie && lastEpisodeItem && firstEpisode && lastEpisodeItem.url !== firstEpisode.url
        ? {
            url: lastEpisodeItem.url,
            label: lastEpisodeItem.title,
          }
        : null;

  const baseSeasonGroups = useMemo(() => groupEpisodesBySeason(anime.episodes), [anime.episodes]);

  const visibleSeasonGroups = useMemo(() => {
    const query = episodeFilter.trim().toLowerCase();
    const isPureDigits = /^\d+$/.test(query);
    const numericTarget = isPureDigits ? Number.parseInt(query, 10) : null;

    const groups = baseSeasonGroups
      .map((group) => {
        const filtered = !query
          ? group.episodes
          : group.episodes.filter((ep) => {
              if (numericTarget !== null) {
                if (ep.episodeNumber === numericTarget) return true;
                const labelMatch = ep.numberLabel.match(/(\d+)\s*$/);
                if (labelMatch && Number.parseInt(labelMatch[1], 10) === numericTarget) {
                  return true;
                }
                const titleNum = ep.title.match(/\b(\d+)\b/);
                if (titleNum && Number.parseInt(titleNum[1], 10) === numericTarget) {
                  return true;
                }
                return (
                  ep.numberLabel.toLowerCase().includes(query) ||
                  ep.title.toLowerCase().includes(query)
                );
              }
              return (
                ep.title.toLowerCase().includes(query) ||
                ep.numberLabel.toLowerCase().includes(query) ||
                (ep.date && ep.date.toLowerCase().includes(query))
              );
            });
        const ordered = sortDesc ? [...filtered].reverse() : filtered;
        return { ...group, episodes: ordered };
      })
      .filter((g) => g.episodes.length > 0);

    return sortDesc ? [...groups].reverse() : groups;
  }, [baseSeasonGroups, episodeFilter, sortDesc]);

  const isWatchedEpisode = (ep: AnimeEpisodeLink) =>
    isEpisodeMarkedWatched(ep.url, progressMap, watchedUrls);

  const totalWatchedCount = playableEpisodes.filter(isWatchedEpisode).length;
  const allEpisodesWatched =
    playableEpisodes.length > 0 && totalWatchedCount === playableEpisodes.length;

  const subtitleParts: string[] = [];
  if (anime.alternativeTitle) subtitleParts.push(anime.alternativeTitle);
  if (
    anime.originalTitle &&
    anime.originalTitle.toLowerCase() !== anime.title.toLowerCase() &&
    anime.originalTitle.toLowerCase() !== (anime.alternativeTitle || '').toLowerCase()
  ) {
    subtitleParts.push(anime.originalTitle);
  }

  const extraMetaItems: Array<{
    label: string;
    value: string;
    kind?: 'date' | 'clock' | 'layers' | 'studio' | 'network' | 'globe';
  }> = [];
  if (anime.status) {
    extraMetaItems.push({ label: 'Status', value: anime.status });
  }
  if (anime.studio) {
    extraMetaItems.push({ label: 'Estúdio', value: anime.studio, kind: 'studio' });
  }
  if (anime.network) {
    extraMetaItems.push({ label: 'Rede', value: anime.network, kind: 'network' });
  }
  if (anime.firstAirDate) {
    extraMetaItems.push({ label: 'Estreia', value: anime.firstAirDate, kind: 'date' });
  }
  if (anime.lastAirDate) {
    extraMetaItems.push({ label: 'Recente', value: anime.lastAirDate, kind: 'date' });
  }
  if (anime.averageDuration) {
    extraMetaItems.push({ label: 'Duração', value: anime.averageDuration, kind: 'clock' });
  }
  if (anime.seasonsCount) {
    extraMetaItems.push({ label: 'Temporadas', value: anime.seasonsCount, kind: 'layers' });
  }
  if (anime.originalLanguage) {
    extraMetaItems.push({ label: 'Idioma', value: anime.originalLanguage, kind: 'globe' });
  }

  // Only show TheTVDB and LiveChart.me links
  const externalLinks = useMemo(() => {
    return (anime.externalLinks || []).filter(
      (link) => link.source === 'thetvdb' || link.source === 'livechart'
    );
  }, [anime.externalLinks]);

  const handleOpenExternalLink = (targetUrl: string) => {
    if (!targetUrl) return;
    if (isNativeAndroidApp()) {
      void openExternalOrVlcUrl(targetUrl);
      return;
    }
    window.open(targetUrl, '_blank', 'noopener,noreferrer');
  };

  const handleToggleFav = () => {
    onToggleFavorite(
      {
        id: anime.url,
        title: anime.title,
        url: anime.url,
        kind: anime.kind || 'anime',
        poster: anime.poster,
        audioType: anime.audioType,
        rating: anime.rating,
        year: anime.year,
        catalogSource: anime.catalogSource,
        externalIds: anime.externalIds,
      },
      latestEpisode
    );
  };

  const hasDistinctBackdrop = Boolean(anime.backdrop && anime.backdrop !== anime.poster);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
      <div className="mb-5 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-2 text-sm font-medium text-slate-400 transition-colors hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" />
          <span>Voltar</span>
        </button>

        <div className="flex items-center gap-2 md:hidden">
          {isFavorite && onToggleMuteFavorite && (
            <button
              type="button"
              onClick={() => onToggleMuteFavorite(anime.url)}
              aria-pressed={isMuted}
              aria-label={
                isMuted
                  ? `Ativar avisos de ${anime.title}`
                  : `Silenciar avisos de ${anime.title}`
              }
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors ${
                isMuted
                  ? 'border-white/15 bg-[#151921] text-slate-400 hover:text-white'
                  : 'border-[#f97316]/40 bg-[#f97316]/12 text-[#fb923c] hover:bg-[#f97316]/20'
              }`}
            >
              {isMuted ? <BellOff className="h-3.5 w-3.5" /> : <Bell className="h-3.5 w-3.5" />}
              <span>{isMuted ? 'Silenciado' : 'Avisos'}</span>
            </button>
          )}
          <button
            type="button"
            onClick={handleToggleFav}
            aria-pressed={isFavorite}
            className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${
              isFavorite
                ? 'border-rose-500/50 bg-rose-500/15 text-rose-200 hover:bg-rose-500/20'
                : 'border-white/15 bg-[#151921] text-white hover:border-rose-400/60 hover:text-rose-200'
            }`}
          >
            <Heart
              className={`h-3.5 w-3.5 ${isFavorite ? 'fill-rose-400 text-rose-400' : 'text-rose-400'}`}
            />
            <span>{isFavorite ? 'Nos Favoritos' : 'Favoritar'}</span>
          </button>
        </div>
      </div>

      {/* Hero Info Card enriched by TheTVDB */}
      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#151921]">
        {hasDistinctBackdrop && (
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            <img
              src={anime.backdrop}
              alt=""
              aria-hidden="true"
              referrerPolicy="no-referrer"
              className="h-full w-full object-cover opacity-15 blur-sm"
            />
            <div className="absolute inset-0 bg-gradient-to-r from-[#151921] via-[#151921]/92 to-[#151921]/80" />
          </div>
        )}

        <div className="relative grid gap-6 p-5 sm:p-7 lg:grid-cols-[220px_1fr] lg:gap-8">
          <MediaPoster
            src={anime.poster}
            alt={anime.title}
            aspect="portrait"
            className="mx-auto w-full max-w-[220px] rounded-xl border border-white/10 shadow-xl lg:mx-0"
          />

          <div className="flex flex-col justify-between gap-5">
            <div>
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-xs font-medium text-slate-400">
                <span className="inline-flex items-center gap-1 rounded-md border border-[#f97316]/30 bg-[#f97316]/12 px-2 py-0.5 text-[#fb923c]">
                  {isMovie ? <Film className="h-3 w-3" /> : <Tv className="h-3 w-3" />}
                  <span>{isMovie ? 'Filme' : isSeries ? 'Série' : 'Anime'}</span>
                </span>
                {anime.audioType && (
                  <span
                    className={`rounded-md border px-2 py-0.5 font-semibold ${
                      anime.audioType === 'DUB'
                        ? 'border-emerald-500/35 bg-emerald-500/12 text-emerald-300'
                        : 'border-sky-500/35 bg-sky-500/12 text-sky-300'
                    }`}
                  >
                    {anime.audioType === 'DUB' ? 'Dublado' : 'Legendado'}
                  </span>
                )}
                {anime.year && <span className="tabular-nums text-slate-300">{anime.year}</span>}
                {anime.rating && Number.parseFloat(anime.rating) > 0 && (
                  <span className="inline-flex items-center gap-1 tabular-nums text-amber-400">
                    <Star className="h-3.5 w-3.5 fill-amber-400" />
                    {anime.rating}
                  </span>
                )}
                {!isMovie && anime.episodes.length > 0 && (
                  <span className="tabular-nums text-slate-300">
                    {anime.episodes.length} episódio{anime.episodes.length === 1 ? '' : 's'}
                  </span>
                )}
                {anime.sourceServerName && (
                  <span className="rounded-md border border-white/10 bg-[#0d0f12]/70 px-2 py-0.5 text-[11px] text-slate-300">
                    Servidor: {anime.sourceServerName}
                  </span>
                )}
              </div>

              <h1 className="mt-3 text-2xl font-bold tracking-tight text-white sm:text-3xl">
                {anime.title}
              </h1>

              {subtitleParts.length > 0 && (
                <p className="mt-1 text-xs font-medium text-slate-400 sm:text-sm">
                  {subtitleParts.join(' · ')}
                </p>
              )}

              {anime.genres.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {anime.genres.map((genre) => (
                    <span
                      key={genre}
                      className="rounded-md border border-white/10 bg-[#0d0f12]/65 px-2.5 py-0.5 text-xs text-slate-300"
                    >
                      {genre}
                    </span>
                  ))}
                </div>
              )}

              <div className="mt-5 flex flex-wrap items-center gap-2.5">
                {firstEpisode && (
                  <button
                    type="button"
                    onClick={() => onOpenEpisode(firstEpisode.url)}
                    className="inline-flex items-center gap-2 rounded-lg bg-[#f97316] px-4 py-2.5 text-sm font-semibold text-[#0d0f12] transition-colors hover:bg-[#fb923c]"
                  >
                    <Play className="h-4 w-4 fill-current" />
                    <span>{isMovie ? 'Assistir Filme' : `Assistir ${firstEpisode.title}`}</span>
                  </button>
                )}

                {quickLastEpisode && (
                  <button
                    type="button"
                    onClick={() => onOpenEpisode(quickLastEpisode.url)}
                    className="inline-flex items-center gap-2 rounded-lg border border-[#f97316]/45 bg-[#f97316]/12 px-4 py-2.5 text-sm font-semibold text-[#fb923c] transition-colors hover:bg-[#f97316]/20"
                  >
                    <SkipForward className="h-4 w-4" />
                    <span>Último ({quickLastEpisode.label})</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={handleToggleFav}
                  aria-pressed={isFavorite}
                  className={`inline-flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-semibold transition-colors ${
                    isFavorite
                      ? 'border-rose-500/45 bg-rose-500/15 text-rose-200 hover:bg-rose-500/20'
                      : 'border-white/15 bg-[#0d0f12] text-slate-200 hover:border-rose-400/50 hover:text-white'
                  }`}
                >
                  <Heart
                    className={`h-4 w-4 ${isFavorite ? 'fill-rose-400 text-rose-400' : 'text-rose-400'}`}
                  />
                  <span>{isFavorite ? 'Nos Favoritos' : 'Favoritar'}</span>
                </button>

                {isFavorite && onToggleMuteFavorite && (
                  <button
                    type="button"
                    onClick={() => onToggleMuteFavorite(anime.url)}
                    aria-pressed={isMuted}
                    aria-label={
                      isMuted
                        ? `Ativar avisos de novos episódios de ${anime.title}`
                        : `Silenciar avisos de novos episódios de ${anime.title}`
                    }
                    className={`inline-flex items-center gap-2 rounded-lg border px-3.5 py-2.5 text-xs font-semibold transition-colors ${
                      isMuted
                        ? 'border-white/15 bg-[#0d0f12] text-slate-400 hover:border-white/25 hover:text-white'
                        : 'border-[#f97316]/40 bg-[#f97316]/12 text-[#fb923c] hover:bg-[#f97316]/20'
                    }`}
                  >
                    {isMuted ? <BellOff className="h-4 w-4" /> : <Bell className="h-4 w-4" />}
                    <span>{isMuted ? 'Avisos silenciados' : 'Avisos ativos'}</span>
                  </button>
                )}

                {anime.allSeasonsUrl && onOpenAnime && (
                  <button
                    type="button"
                    onClick={() => onOpenAnime(anime.allSeasonsUrl!)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-[#0d0f12] px-3.5 py-2.5 text-xs font-semibold text-slate-200 transition-colors hover:border-[#f97316]/50 hover:text-white"
                  >
                    <Layers className="h-3.5 w-3.5 text-[#f97316]" />
                    <span>Todas as temporadas</span>
                  </button>
                )}

                {externalLinks.map((link) => (
                  <button
                    key={`${link.source}-${link.url}`}
                    type="button"
                    onClick={() => handleOpenExternalLink(link.url)}
                    className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2.5 text-xs font-semibold transition-colors ${SOURCE_BADGE_STYLE[link.source]}`}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    <span>{link.label}</span>
                  </button>
                ))}
              </div>

              {extraMetaItems.length > 0 && (
                <dl className="mt-5 flex flex-wrap gap-2 border-t border-white/10 pt-4">
                  {extraMetaItems.map((meta) => (
                    <div
                      key={meta.label}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-white/8 bg-[#0d0f12]/70 px-2.5 py-1.5 text-xs"
                    >
                      {meta.kind === 'date' && <Calendar className="h-3 w-3 text-slate-400" />}
                      {meta.kind === 'clock' && <Clock className="h-3 w-3 text-slate-400" />}
                      {meta.kind === 'layers' && <Layers className="h-3 w-3 text-slate-400" />}
                      {meta.kind === 'studio' && <Building2 className="h-3 w-3 text-slate-400" />}
                      {meta.kind === 'network' && <Radio className="h-3 w-3 text-slate-400" />}
                      {meta.kind === 'globe' && <Globe className="h-3 w-3 text-slate-400" />}
                      <dt className="text-slate-400">{meta.label}:</dt>
                      <dd className="font-medium tabular-nums text-slate-200">{meta.value}</dd>
                    </div>
                  ))}
                </dl>
              )}

              <p className="mt-4 max-w-3xl whitespace-pre-line border-t border-white/10 pt-4 text-sm leading-relaxed text-slate-300">
                {anime.synopsis || 'Sinopse não disponível para este título no TheTVDB.'}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Episodes / Movie Playback Section */}
      <section className="mt-8">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-white">
              {isMovie ? 'Reprodução' : 'Episódios'}
            </h2>
            {!isMovie && anime.episodes.length > 0 && (
              <span className="font-mono text-xs tabular-nums text-slate-400">
                {playableEpisodes.length > 0
                  ? `${totalWatchedCount}/${playableEpisodes.length} vistos`
                  : `${anime.episodes.length} episódio${anime.episodes.length === 1 ? '' : 's'}`}
                {unavailableCount > 0 && (
                  <span className="text-[#fb923c]">
                    {' '}
                    · {unavailableCount} {unavailableCount === 1 ? 'indisponível' : 'indisponíveis'}
                  </span>
                )}
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {anime.episodes.length > 1 && (
              <>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                  <input
                    type="text"
                    value={episodeFilter}
                    onChange={(e) => setEpisodeFilter(e.target.value)}
                    placeholder="Buscar episódio..."
                    aria-label="Buscar episódio por número ou título"
                    className="w-40 rounded-lg border border-white/12 bg-[#151921] py-1.5 pl-8 pr-7 text-xs text-white placeholder:text-slate-500 focus:border-[#f97316] focus:outline-none sm:w-48"
                  />
                  {episodeFilter && (
                    <button
                      type="button"
                      onClick={() => setEpisodeFilter('')}
                      aria-label="Limpar busca de episódio"
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:text-white"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => setSortDesc((prev) => !prev)}
                  aria-pressed={sortDesc}
                  title="Alternar ordem dos episódios"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/12 bg-[#151921] px-3 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:border-[#f97316]/60 hover:text-white"
                >
                  {sortDesc ? (
                    <ArrowUpWideNarrow className="h-3.5 w-3.5 text-[#f97316]" />
                  ) : (
                    <ArrowDownNarrowWide className="h-3.5 w-3.5 text-[#f97316]" />
                  )}
                  <span>{sortDesc ? 'Mais recentes' : 'Crescente'}</span>
                </button>
              </>
            )}

            {playableEpisodes.length > 0 && baseSeasonGroups.length > 1 && (
              <button
                type="button"
                onClick={() =>
                  onToggleEpisodesWatched(
                    playableEpisodes,
                    !allEpisodesWatched,
                    allEpisodesWatched
                      ? 'Todas as temporadas desmarcadas'
                      : 'Todas as temporadas marcadas como vistas'
                  )
                }
                aria-pressed={allEpisodesWatched}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                  allEpisodesWatched
                    ? 'border-emerald-500/45 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/20'
                    : 'border-white/12 bg-[#151921] text-slate-200 hover:border-[#f97316]/60 hover:text-white'
                }`}
              >
                <CheckCheck className="h-3.5 w-3.5" />
                <span>
                  {allEpisodesWatched
                    ? 'Desmarcar todas'
                    : 'Marcar tudo como visto'}
                </span>
              </button>
            )}
          </div>
        </div>

        {anime.episodes.length === 0 ? (
          <div className="rounded-xl border border-white/10 bg-[#151921] p-8 text-center text-sm text-slate-400">
            Nenhum episódio listado nos servidores ativos para este título ainda.
          </div>
        ) : visibleSeasonGroups.length === 0 ? (
          <div className="rounded-xl border border-white/10 bg-[#151921] p-8 text-center">
            <p className="text-sm text-slate-400">
              Nenhum episódio encontrado para &ldquo;{episodeFilter}&rdquo;.
            </p>
            <button
              type="button"
              onClick={() => setEpisodeFilter('')}
              className="mt-3 rounded-lg bg-[#f97316] px-3.5 py-1.5 text-xs font-semibold text-[#0d0f12]"
            >
              Limpar filtro
            </button>
          </div>
        ) : (
          <div className="space-y-5">
            {visibleSeasonGroups.map((group) => {
              const fullGroup =
                baseSeasonGroups.find((g) => g.seasonNumber === group.seasonNumber) || group;
              const seasonPlayableEpisodes = fullGroup.episodes.filter(isEpisodeAvailableOnServer);
              const seasonUnavailableCount =
                fullGroup.episodes.length - seasonPlayableEpisodes.length;
              const seasonWatchedCount = seasonPlayableEpisodes.filter(isWatchedEpisode).length;
              const seasonAllWatched =
                seasonPlayableEpisodes.length > 0 &&
                seasonWatchedCount === seasonPlayableEpisodes.length;

              return (
                <div
                  key={group.seasonNumber}
                  className="overflow-hidden rounded-xl border border-white/10 bg-[#151921]"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-[#0d0f12]/55 px-4 py-2.5">
                    <div className="flex items-center gap-2.5">
                      <span className="text-xs font-semibold uppercase tracking-wide text-slate-200">
                        {group.label}
                      </span>
                      <span className="font-mono text-[11px] tabular-nums text-slate-400">
                        {seasonPlayableEpisodes.length > 0
                          ? `${seasonWatchedCount}/${seasonPlayableEpisodes.length} vistos`
                          : `${fullGroup.episodes.length} eps`}
                        {seasonUnavailableCount > 0 && (
                          <span className="text-[#fb923c]">
                            {' '}
                            · {seasonUnavailableCount} em breve
                          </span>
                        )}
                      </span>
                    </div>

                    {seasonPlayableEpisodes.length > 0 && (
                      <button
                        type="button"
                        onClick={() =>
                          onToggleEpisodesWatched(
                            seasonPlayableEpisodes,
                            !seasonAllWatched,
                            seasonAllWatched
                              ? `${group.label} desmarcada`
                              : `${group.label} marcada como vista`
                          )
                        }
                        aria-pressed={seasonAllWatched}
                        className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors ${
                          seasonAllWatched
                            ? 'border-emerald-500/45 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/20'
                            : 'border-white/12 bg-[#151921] text-slate-200 hover:border-emerald-500/50 hover:text-white'
                        }`}
                      >
                        <CheckCheck className="h-3.5 w-3.5" />
                        <span>
                          {seasonAllWatched
                            ? isMovie
                              ? 'Visto'
                              : 'Temporada vista'
                            : isMovie
                              ? 'Marcar como visto'
                              : 'Marcar temporada como vista'}
                        </span>
                      </button>
                    )}
                  </div>

                  <div className="divide-y divide-white/8">
                    {group.episodes.map((ep) => {
                      const available = isEpisodeAvailableOnServer(ep);
                      const formattedDate = formatEpisodeReleaseDate(
                        ep.date,
                        ep.airingAt,
                        ep.hasExactAiringTime
                      );

                      if (!available) {
                        const countdown = formatEpisodeCountdown(ep.airingAt, nowMs, ep.date);
                        return (
                          <div
                            key={`${ep.url}-${ep.seasonNumber || 1}-${ep.episodeNumber || ep.numberLabel}`}
                            data-episode-unavailable="true"
                            className="flex items-center justify-between gap-2.5 bg-[#0d0f12]/35 px-4 py-3 sm:gap-4"
                          >
                            <div className="flex min-w-0 flex-1 items-center gap-2.5 sm:gap-4">
                              {ep.thumb ? (
                                <MediaPoster
                                  src={ep.thumb}
                                  alt={ep.title}
                                  aspect="landscape"
                                  className="hidden h-12 w-20 shrink-0 rounded-md border border-white/10 opacity-60 sm:block"
                                />
                              ) : null}
                              <span className="w-12 shrink-0 font-mono text-xs font-medium tabular-nums text-slate-500 sm:w-20">
                                {ep.numberLabel || 'EP'}
                              </span>
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-sm font-medium text-slate-300">
                                  {ep.title}
                                </div>
                                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs tabular-nums text-slate-400">
                                  <span className="inline-flex items-center gap-1">
                                    <Calendar className="h-3 w-3 shrink-0 text-slate-500" />
                                    <span>{formattedDate || 'Data ainda não confirmada'}</span>
                                  </span>
                                  {ep.durationMinutes && (
                                    <span className="text-slate-500">{ep.durationMinutes} min</span>
                                  )}
                                </div>
                              </div>
                            </div>

                            <div className="flex shrink-0 items-center">
                              <span
                                title={
                                  countdown.state === 'pending'
                                    ? 'Episódio já exibido, mas ainda não publicado nos servidores.'
                                    : undefined
                                }
                                className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-bold leading-tight tabular-nums shadow-sm shadow-black/60 backdrop-blur-md ${
                                  countdown.state === 'now'
                                    ? 'border-emerald-400/80 bg-[#052e22]/92 text-emerald-100'
                                    : countdown.state === 'future'
                                      ? 'border-[#f97316]/85 bg-[#1b0e05]/92 text-[#ffedd5]'
                                      : countdown.state === 'pending'
                                        ? 'border-white/20 bg-[#0d0f12]/92 text-slate-300'
                                        : 'border-white/20 bg-[#0d0f12]/90 text-slate-300'
                                }`}
                              >
                                {countdown.state === 'pending' ? (
                                  <CloudOff className="h-3 w-3 shrink-0 text-slate-400" />
                                ) : (
                                  <Clock
                                    className={`h-3 w-3 shrink-0 ${
                                      countdown.state === 'now'
                                        ? 'text-emerald-300'
                                        : countdown.state === 'future'
                                          ? 'text-[#f97316]'
                                          : 'text-slate-400'
                                    }`}
                                  />
                                )}
                                <span>{countdown.label}</span>
                              </span>
                            </div>
                          </div>
                        );
                      }

                      const epKey = canonicalEpisodeProgressKey(ep.url);
                      const epProgress = epKey ? progressMap?.[epKey] : undefined;
                      const resumeSec = getResumePositionSec(epProgress);
                      const watched = isWatchedEpisode(ep);
                      return (
                        <div
                          key={ep.url}
                          className="group flex items-center justify-between gap-2 px-4 py-3 transition-colors hover:bg-white/5 sm:gap-4"
                        >
                          <button
                            type="button"
                            onClick={() => onOpenEpisode(ep.url)}
                            className="flex min-w-0 flex-1 items-center justify-between gap-2.5 text-left sm:gap-3"
                          >
                            <div className="flex min-w-0 flex-1 items-center gap-2.5 sm:gap-4">
                              {ep.thumb ? (
                                <MediaPoster
                                  src={ep.thumb}
                                  alt={ep.title}
                                  aspect="landscape"
                                  className="hidden h-12 w-20 shrink-0 rounded-md border border-white/10 sm:block"
                                />
                              ) : null}
                              <span className="w-12 shrink-0 font-mono text-xs font-medium tabular-nums text-slate-400 sm:w-20">
                                {ep.numberLabel || 'EP'}
                              </span>
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-sm font-medium text-white group-hover:text-[#f97316]">
                                  {ep.title}
                                </div>
                                {(formattedDate || ep.durationMinutes || ep.rating || resumeSec >= 2) && (
                                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs tabular-nums text-slate-500">
                                    {formattedDate && <span>{formattedDate}</span>}
                                    {ep.durationMinutes && <span>{ep.durationMinutes} min</span>}
                                    {ep.rating && (
                                      <span className="text-amber-400/90">★ {ep.rating}</span>
                                    )}
                                    {resumeSec >= 2 && (
                                      <span className="font-medium text-[#fb923c] sm:hidden">
                                        Parou em {formatPlaybackTimestamp(resumeSec)}
                                      </span>
                                    )}
                                  </div>
                                )}
                              </div>
                            </div>

                            <div className="flex shrink-0 items-center gap-2.5">
                              {resumeSec >= 2 && (
                                <span className="hidden text-xs font-medium tabular-nums text-[#fb923c] sm:inline">
                                  Parou em {formatPlaybackTimestamp(resumeSec)}
                                </span>
                              )}
                              <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-300 group-hover:text-white">
                                <Play className="h-3.5 w-3.5 text-[#f97316]" />
                                <span className="hidden sm:inline">
                                  {resumeSec >= 2 ? 'Retomar' : 'Abrir'}
                                </span>
                              </span>
                            </div>
                          </button>

                          <button
                            type="button"
                            onClick={() => onToggleEpisodesWatched([ep], !watched)}
                            aria-pressed={watched}
                            aria-label={
                              watched
                                ? `Desmarcar ${ep.title} como visto`
                                : `Marcar ${ep.title} como visto`
                            }
                            className={`inline-flex shrink-0 items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                              watched
                                ? 'border-emerald-500/45 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/20'
                                : 'border-white/12 bg-[#0d0f12] text-slate-300 hover:border-emerald-500/50 hover:text-white'
                            }`}
                          >
                            <Check className="h-3.5 w-3.5" />
                            <span>{watched ? 'Visto' : 'Visto'}</span>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
