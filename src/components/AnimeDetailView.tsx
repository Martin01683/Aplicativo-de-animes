import { useEffect, useMemo, useState } from 'react';
import {
  ArrowDownNarrowWide,
  ArrowLeft,
  ArrowUpWideNarrow,
  Calendar,
  Check,
  CheckCheck,
  Clock,
  ExternalLink,
  Heart,
  Layers,
  Play,
  Search,
  SkipForward,
  Star,
  X,
} from 'lucide-react';
import { isNativeAndroidApp, openExternalOrVlcUrl } from '../lib/apiClient';
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
  FavoriteLatestInfo,
} from '../lib/types';
import { MediaPoster } from './MediaPoster';

interface AnimeDetailViewProps {
  anime: AnimeDetails;
  isFavorite: boolean;
  watchedUrls: Set<string>;
  progressMap?: EpisodeProgressMap;
  onToggleFavorite: (item: CatalogMediaItem, knownLatest?: FavoriteLatestInfo | null) => void;
  onToggleEpisodesWatched: (
    episodes: AnimeEpisodeLink[],
    watched: boolean,
    label?: string
  ) => void;
  onOpenEpisode: (episodeUrl: string) => void;
  onOpenAnime?: (animeUrl: string) => void;
  onBack: () => void;
}

export function AnimeDetailView({
  anime,
  isFavorite,
  watchedUrls,
  progressMap,
  onToggleFavorite,
  onToggleEpisodesWatched,
  onOpenEpisode,
  onOpenAnime,
  onBack,
}: AnimeDetailViewProps) {
  const [episodeFilter, setEpisodeFilter] = useState('');
  const [sortDesc, setSortDesc] = useState(false);

  useEffect(() => {
    setEpisodeFilter('');
    setSortDesc(false);
  }, [anime.url]);

  const latestEpisode = pickLatestAnimeEpisode(anime.episodes, anime.title, anime.poster);
  const firstEpisode = anime.episodes[0];
  const lastEpisodeItem =
    anime.episodes.length > 1 ? anime.episodes[anime.episodes.length - 1] : null;
  const quickLastEpisode =
    latestEpisode && firstEpisode && latestEpisode.episodeUrl !== firstEpisode.url
      ? {
          url: latestEpisode.episodeUrl,
          label: latestEpisode.episodeLabel || latestEpisode.episodeTitle,
        }
      : lastEpisodeItem && firstEpisode && lastEpisodeItem.url !== firstEpisode.url
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

  const totalWatchedCount = anime.episodes.filter(isWatchedEpisode).length;
  const allEpisodesWatched =
    anime.episodes.length > 0 && totalWatchedCount === anime.episodes.length;

  const subtitleParts: string[] = [];
  if (anime.alternativeTitle) subtitleParts.push(anime.alternativeTitle);
  if (
    anime.originalTitle &&
    anime.originalTitle.toLowerCase() !== anime.title.toLowerCase() &&
    anime.originalTitle.toLowerCase() !== (anime.alternativeTitle || '').toLowerCase()
  ) {
    subtitleParts.push(anime.originalTitle);
  }

  const extraMetaItems: Array<{ label: string; value: string; kind?: 'date' | 'clock' | 'star' | 'layers' }> = [];
  if (anime.firstAirDate) {
    extraMetaItems.push({ label: 'Estreia', value: anime.firstAirDate, kind: 'date' });
  }
  if (anime.lastAirDate) {
    extraMetaItems.push({ label: 'Último ep.', value: anime.lastAirDate, kind: 'date' });
  }
  if (anime.averageDuration) {
    extraMetaItems.push({ label: 'Duração', value: anime.averageDuration, kind: 'clock' });
  }
  if (anime.tmdbRating) {
    extraMetaItems.push({
      label: 'TMDb',
      value: anime.tmdbVotes ? `${anime.tmdbRating} (${anime.tmdbVotes})` : anime.tmdbRating,
      kind: 'star',
    });
  }
  if (anime.seasonsCount) {
    extraMetaItems.push({ label: 'Temporadas', value: anime.seasonsCount, kind: 'layers' });
  }
  if (anime.episodesTotalCount && anime.episodesTotalCount !== String(anime.episodes.length)) {
    extraMetaItems.push({ label: 'Total catálogo', value: `${anime.episodesTotalCount} eps` });
  }

  const handleOpenMyAnimeList = () => {
    if (!anime.myAnimeListUrl) return;
    if (isNativeAndroidApp()) {
      void openExternalOrVlcUrl(anime.myAnimeListUrl);
      return;
    }
    window.open(anime.myAnimeListUrl, '_blank', 'noopener,noreferrer');
  };

  const handleToggleFav = () => {
    onToggleFavorite(
      {
        id: anime.url,
        title: anime.title,
        url: anime.url,
        kind: 'anime',
        poster: anime.poster,
        audioType: anime.audioType,
        rating: anime.rating,
        year: anime.year,
      },
      latestEpisode
    );
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-6 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-2 text-sm font-medium text-slate-400 transition-colors hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" />
          <span>Voltar ao catálogo</span>
        </button>

        <button
          type="button"
          onClick={handleToggleFav}
          aria-pressed={isFavorite}
          className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors md:hidden ${
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

      <div className="grid gap-8 rounded-xl border border-white/10 bg-[#151921] p-6 lg:grid-cols-[220px_1fr]">
        <MediaPoster
          src={anime.poster}
          alt={anime.title}
          aspect="portrait"
          className="w-full max-w-[220px] rounded-lg border border-white/10"
        />

        <div className="flex flex-col justify-between gap-5">
          <div>
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs font-medium text-slate-400">
              {anime.audioType && (
                <span
                  className={
                    anime.audioType === 'DUB' ? 'text-emerald-400' : 'text-rose-400'
                  }
                >
                  {anime.audioType === 'DUB' ? 'Dublado' : 'Legendado'}
                </span>
              )}
              {anime.year && (
                <>
                  {anime.audioType && <span>·</span>}
                  <span className="tabular-nums">{anime.year}</span>
                </>
              )}
              {anime.rating && (
                <>
                  {(anime.audioType || anime.year) && <span>·</span>}
                  <span className="inline-flex items-center gap-1 tabular-nums text-amber-400">
                    <Star className="h-3.5 w-3.5 fill-amber-400" />
                    {anime.rating}
                  </span>
                </>
              )}
              {anime.episodes.length > 0 && (
                <>
                  {(anime.audioType || anime.year || anime.rating) && <span>·</span>}
                  <span className="tabular-nums">
                    {anime.episodes.length} episódios
                  </span>
                </>
              )}
            </div>

            <h1 className="mt-2 text-2xl font-bold tracking-tight text-white sm:text-3xl">
              {anime.title}
            </h1>

            {subtitleParts.length > 0 && (
              <p className="mt-1 text-xs font-medium text-slate-400 sm:text-sm">
                {subtitleParts.join(' · ')}
              </p>
            )}

            {anime.genres.length > 0 && (
              <p className="mt-2 text-sm text-slate-400">
                {anime.genres.join(' · ')}
              </p>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-2.5">
              {firstEpisode && (
                <button
                  type="button"
                  onClick={() => onOpenEpisode(firstEpisode.url)}
                  className="inline-flex items-center gap-2 rounded-lg bg-[#f97316] px-4 py-2.5 text-sm font-semibold text-[#0d0f12] transition-colors hover:bg-[#fb923c]"
                >
                  <Play className="h-4 w-4 fill-current" />
                  <span>Assistir {firstEpisode.title}</span>
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
                <span>{isFavorite ? 'Nos Favoritos' : 'Adicionar aos Favoritos'}</span>
              </button>

              {anime.myAnimeListUrl && (
                <button
                  type="button"
                  onClick={handleOpenMyAnimeList}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-sky-500/35 bg-sky-500/10 px-3.5 py-2.5 text-xs font-semibold text-sky-300 transition-colors hover:bg-sky-500/20"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  <span>MyAnimeList</span>
                </button>
              )}

              {anime.allSeasonsUrl && onOpenAnime && (
                <button
                  type="button"
                  onClick={() => onOpenAnime(anime.allSeasonsUrl!)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-[#0d0f12] px-3.5 py-2.5 text-xs font-semibold text-slate-200 transition-colors hover:border-[#f97316]/50 hover:text-white"
                >
                  <Layers className="h-3.5 w-3.5 text-[#f97316]" />
                  <span>Ver todas as temporadas</span>
                </button>
              )}
            </div>

            {extraMetaItems.length > 0 && (
              <dl className="mt-4 flex flex-wrap gap-2 border-t border-white/10 pt-4">
                {extraMetaItems.map((meta) => (
                  <div
                    key={meta.label}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-white/8 bg-[#0d0f12]/70 px-2.5 py-1.5 text-xs"
                  >
                    {meta.kind === 'date' && <Calendar className="h-3 w-3 text-slate-400" />}
                    {meta.kind === 'clock' && <Clock className="h-3 w-3 text-slate-400" />}
                    {meta.kind === 'star' && <Star className="h-3 w-3 fill-amber-400 text-amber-400" />}
                    {meta.kind === 'layers' && <Layers className="h-3 w-3 text-slate-400" />}
                    <dt className="text-slate-400">{meta.label}:</dt>
                    <dd className="font-medium tabular-nums text-slate-200">{meta.value}</dd>
                  </div>
                ))}
              </dl>
            )}

            <p className="mt-4 max-w-3xl whitespace-pre-line border-t border-white/10 pt-4 text-sm leading-relaxed text-slate-300">
              {anime.synopsis || 'Sinopse não disponível para este título.'}
            </p>
          </div>
        </div>
      </div>

      <section className="mt-8">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-white">Episódios</h2>
            {anime.episodes.length > 0 && (
              <span className="font-mono text-xs tabular-nums text-slate-400">
                {totalWatchedCount}/{anime.episodes.length} vistos
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

            {anime.episodes.length > 0 && baseSeasonGroups.length > 1 && (
              <button
                type="button"
                onClick={() =>
                  onToggleEpisodesWatched(
                    anime.episodes,
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
                    ? 'Desmarcar todas as temporadas'
                    : 'Marcar tudo como visto'}
                </span>
              </button>
            )}
          </div>
        </div>

        {anime.episodes.length === 0 ? (
          <div className="rounded-xl border border-white/10 bg-[#151921] p-8 text-center text-sm text-slate-400">
            Nenhum episódio listado nesta página.
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
              const seasonWatchedCount = fullGroup.episodes.filter(isWatchedEpisode).length;
              const seasonAllWatched =
                fullGroup.episodes.length > 0 && seasonWatchedCount === fullGroup.episodes.length;

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
                        {seasonWatchedCount}/{fullGroup.episodes.length} vistos
                      </span>
                    </div>

                    <button
                      type="button"
                      onClick={() =>
                        onToggleEpisodesWatched(
                          fullGroup.episodes,
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
                          ? 'Temporada vista'
                          : 'Marcar temporada como vista'}
                      </span>
                    </button>
                  </div>

                  <div className="divide-y divide-white/8">
                    {group.episodes.map((ep) => {
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
                            className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left"
                          >
                            <div className="flex min-w-0 items-center gap-3 sm:gap-4">
                              <span className="w-12 shrink-0 font-mono text-xs font-medium tabular-nums text-slate-400 sm:w-16">
                                {ep.numberLabel || 'EP'}
                              </span>
                              <div className="min-w-0">
                                <div className="truncate text-sm font-medium text-white group-hover:text-[#f97316]">
                                  {ep.title}
                                </div>
                                {ep.date && (
                                  <div className="mt-0.5 text-xs tabular-nums text-slate-500">
                                    {ep.date}
                                  </div>
                                )}
                              </div>
                            </div>

                            <div className="flex shrink-0 items-center gap-2.5">
                              {resumeSec >= 2 && (
                                <span className="text-xs font-medium tabular-nums text-[#fb923c]">
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
                            <span>{watched ? 'Visto' : 'Marcar visto'}</span>
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
