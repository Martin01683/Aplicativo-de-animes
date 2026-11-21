import { ArrowLeft, Heart, Play, Star } from 'lucide-react';
import { pickLatestAnimeEpisode } from '../lib/favoriteAlerts';
import {
  canonicalEpisodeProgressKey,
  formatPlaybackTimestamp,
  getResumePositionSec,
  type EpisodeProgressMap,
} from '../lib/playbackProgress';
import type { AnimeDetails, CatalogMediaItem, FavoriteLatestInfo } from '../lib/types';
import { MediaPoster } from './MediaPoster';

interface AnimeDetailViewProps {
  anime: AnimeDetails;
  isFavorite: boolean;
  watchedUrls: Set<string>;
  progressMap?: EpisodeProgressMap;
  onToggleFavorite: (item: CatalogMediaItem, knownLatest?: FavoriteLatestInfo | null) => void;
  onOpenEpisode: (episodeUrl: string) => void;
  onBack: () => void;
}

export function AnimeDetailView({
  anime,
  isFavorite,
  watchedUrls,
  progressMap,
  onToggleFavorite,
  onOpenEpisode,
  onBack,
}: AnimeDetailViewProps) {
  const latestEpisode = pickLatestAnimeEpisode(anime.episodes, anime.title, anime.poster);
  const firstEpisode = anime.episodes[0];

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

            {anime.genres.length > 0 && (
              <p className="mt-2 text-sm text-slate-400">
                {anime.genres.join(' · ')}
              </p>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-3">
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
            </div>

            <p className="mt-4 max-w-3xl border-t border-white/10 pt-4 text-sm leading-relaxed text-slate-300">
              {anime.synopsis || 'Sinopse não disponível para este título.'}
            </p>
          </div>
        </div>
      </div>

      <section className="mt-8">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Episódios</h2>
          <span className="font-mono text-xs tabular-nums text-slate-400">
            {anime.episodes.length} disponíveis
          </span>
        </div>

        {anime.episodes.length === 0 ? (
          <div className="rounded-xl border border-white/10 bg-[#151921] p-8 text-center text-sm text-slate-400">
            Nenhum episódio listado nesta página.
          </div>
        ) : (
          <div className="divide-y divide-white/8 overflow-hidden rounded-xl border border-white/10 bg-[#151921]">
            {anime.episodes.map((ep) => {
              const epKey = canonicalEpisodeProgressKey(ep.url);
              const epProgress = epKey ? progressMap?.[epKey] : undefined;
              const resumeSec = getResumePositionSec(epProgress);
              const watched = watchedUrls.has(ep.url) || Boolean(epProgress?.completed);
              return (
                <button
                  key={ep.url}
                  type="button"
                  onClick={() => onOpenEpisode(ep.url)}
                  className="group flex w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors hover:bg-white/5"
                >
                  <div className="flex min-w-0 items-center gap-4">
                    <span className="w-16 shrink-0 font-mono text-xs font-medium tabular-nums text-slate-400">
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

                  <div className="flex shrink-0 items-center gap-3">
                    {resumeSec >= 2 ? (
                      <span className="text-xs font-medium tabular-nums text-[#fb923c]">
                        Parou em {formatPlaybackTimestamp(resumeSec)}
                      </span>
                    ) : watched ? (
                      <span className="text-xs font-medium text-emerald-400">
                        Visto
                      </span>
                    ) : null}
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-300 group-hover:text-white">
                      <Play className="h-3.5 w-3.5 text-[#f97316]" />
                      {resumeSec >= 2 ? 'Retomar' : 'Abrir'}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
