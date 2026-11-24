import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Calendar,
  Clock,
  Heart,
  Info,
  LayoutGrid,
  List,
  Loader2,
  RefreshCw,
  Search,
  Star,
  X,
} from 'lucide-react';
import { isItemFavorited } from '../lib/favoriteAlerts';
import type { MediaNavigationSeed } from '../lib/prefetchCache';
import type {
  CalendarDaySection,
  CatalogMediaItem,
  LiveChartScheduleMode,
  MediaKind,
} from '../lib/types';
import { MediaPoster } from './MediaPoster';

interface LiveChartCalendarProps {
  days: CalendarDaySection[];
  selectedDayId: string;
  scheduleMode: LiveChartScheduleMode;
  loading: boolean;
  error?: string;
  isHidden?: boolean;
  favorites: CatalogMediaItem[];
  onSelectDay: (dayId: string) => void;
  onChangeScheduleMode: (mode: LiveChartScheduleMode) => void;
  onPrefetchScheduleMode?: (mode: LiveChartScheduleMode) => void;
  onRefresh: () => void;
  onOpenItem: (url: string, kind: MediaKind, seed?: MediaNavigationSeed) => void;
  onPrefetchItem?: (url: string, kind: MediaKind, seed?: MediaNavigationSeed) => void;
  onToggleFavorite: (item: CatalogMediaItem) => void;
}

type AudioTrackFilter = 'ALL' | 'DUB' | 'SUB' | 'JP';
type CalendarLayout = 'grid' | 'timeline';

function getServiceBadgeStyle(serviceName: string | undefined): {
  badge: string;
  row: string;
  dot: string;
} {
  const key = (serviceName || '').toLowerCase();
  if (key.includes('crunchyroll')) {
    return {
      badge: 'border-[#f47521]/40 bg-[#f47521]/15 text-[#ff9b54]',
      row: 'bg-[#f47521]/[0.11] text-[#ff9b54]',
      dot: 'bg-[#f47521]',
    };
  }
  if (key.includes('netflix')) {
    return {
      badge: 'border-[#e50914]/40 bg-[#e50914]/15 text-[#ff6b72]',
      row: 'bg-[#e50914]/[0.12] text-[#ff6b72]',
      dot: 'bg-[#e50914]',
    };
  }
  if (key.includes('prime')) {
    return {
      badge: 'border-[#00a8e1]/40 bg-[#00a8e1]/15 text-[#5cd3ff]',
      row: 'bg-[#00a8e1]/[0.11] text-[#5cd3ff]',
      dot: 'bg-[#00a8e1]',
    };
  }
  if (key.includes('disney')) {
    return {
      badge: 'border-[#3b82f6]/40 bg-[#3b82f6]/15 text-[#93c5fd]',
      row: 'bg-[#3b82f6]/[0.12] text-[#93c5fd]',
      dot: 'bg-[#3b82f6]',
    };
  }
  if (key.includes('youtube') || key === 'yt') {
    return {
      badge: 'border-red-500/35 bg-red-500/15 text-red-300',
      row: 'bg-red-500/[0.11] text-red-300',
      dot: 'bg-red-500',
    };
  }
  if (key.includes('hidive')) {
    return {
      badge: 'border-cyan-400/35 bg-cyan-500/15 text-cyan-300',
      row: 'bg-cyan-500/[0.11] text-cyan-300',
      dot: 'bg-cyan-400',
    };
  }
  if (key.includes('wetv') || key.includes('bilibili') || key.includes('iqiyi')) {
    return {
      badge: 'border-amber-400/35 bg-amber-500/15 text-amber-300',
      row: 'bg-amber-500/[0.11] text-amber-300',
      dot: 'bg-amber-400',
    };
  }
  return {
    badge: 'border-white/12 bg-white/6 text-slate-300',
    row: 'bg-white/[0.03] text-slate-300',
    dot: 'bg-slate-400',
  };
}

function formatLocalTime(airingAtSec: number | undefined): string {
  if (!airingAtSec || airingAtSec <= 0) return '--:--';
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(airingAtSec * 1000));
  } catch {
    return '--:--';
  }
}

function formatCountdown(
  airingAtSec: number | undefined,
  nowMs: number
): { label: string; state: 'future' | 'now' | 'past' } | null {
  if (!airingAtSec || airingAtSec <= 0) return null;
  const diffSec = Math.floor(airingAtSec - nowMs / 1000);
  if (diffSec <= 0) {
    if (diffSec > -3600) {
      return { label: 'Saiu agora', state: 'now' };
    }
    return { label: 'Exibido', state: 'past' };
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

const MODE_OPTIONS: Array<{ id: LiveChartScheduleMode; label: string; title: string }> = [
  { id: 'streams', label: 'Streaming', title: 'Horários de streaming com Sub/Dub (Crunchyroll, Netflix, Prime Video, Disney+)' },
  { id: 'dub', label: 'Dublados', title: 'Priorizar horários de lançamentos dublados' },
  { id: 'jp', label: 'Japão (TV)', title: 'Horário de exibição original no Japão' },
];

function toCalendarSeed(item: CatalogMediaItem): MediaNavigationSeed {
  return {
    title: item.title,
    poster: item.poster,
    kind: 'anime',
    audioType: item.audioType,
    year: item.year,
    rating: item.rating,
    episodeLabel: item.episodeLabel,
    catalogSource: item.catalogSource,
    externalIds: item.externalIds,
  };
}

export function LiveChartCalendar({
  days,
  selectedDayId,
  scheduleMode,
  loading,
  error,
  isHidden = false,
  favorites,
  onSelectDay,
  onChangeScheduleMode,
  onPrefetchScheduleMode,
  onRefresh,
  onOpenItem,
  onPrefetchItem,
  onToggleFavorite,
}: LiveChartCalendarProps) {
  const [layout, setLayout] = useState<CalendarLayout>('grid');
  const [audioFilter, setAudioFilter] = useState<AudioTrackFilter>('ALL');
  const [serviceFilter, setServiceFilter] = useState<string>('ALL');
  const [searchFilter, setSearchFilter] = useState('');
  const [nowMs, setNowMs] = useState(() => Date.now());
  const hoverTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (isHidden) return;
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [isHidden]);

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current !== null) {
        window.clearTimeout(hoverTimerRef.current);
      }
    };
  }, []);

  const scheduleCardPrefetch = useCallback(
    (item: CatalogMediaItem, immediate = false) => {
      if (!onPrefetchItem) return;
      if (hoverTimerRef.current !== null) {
        window.clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
      }
      if (immediate) {
        onPrefetchItem(item.url, 'anime', toCalendarSeed(item));
        return;
      }
      hoverTimerRef.current = window.setTimeout(() => {
        hoverTimerRef.current = null;
        onPrefetchItem(item.url, 'anime', toCalendarSeed(item));
      }, 90);
    },
    [onPrefetchItem]
  );

  const cancelCardPrefetch = useCallback(() => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);

  // Reset service filter if selected service disappears after changing mode
  const allServices = useMemo(() => {
    const counts = new Map<string, number>();
    for (const day of days) {
      for (const item of day.items) {
        const svc = item.scheduleMeta?.serviceName;
        if (!svc) continue;
        counts.set(svc, (counts.get(svc) || 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }));
  }, [days]);

  useEffect(() => {
    if (serviceFilter !== 'ALL' && !allServices.some((s) => s.name === serviceFilter)) {
      setServiceFilter('ALL');
    }
  }, [allServices, serviceFilter]);

  const totalWeekCount = useMemo(
    () => days.reduce((acc, d) => acc + d.items.length, 0),
    [days]
  );

  const visibleDays = useMemo(() => {
    const targetDays =
      selectedDayId === 'all'
        ? days
        : days.filter((d) => d.id === selectedDayId);
    const chosen = targetDays.length > 0 ? targetDays : days.slice(0, 1);

    const q = searchFilter.trim().toLowerCase();

    return chosen.map((day) => {
      const items = day.items.filter((item) => {
        const meta = item.scheduleMeta;
        if (audioFilter === 'DUB' && !meta?.hasDub && item.audioType !== 'DUB') return false;
        if (audioFilter === 'SUB' && !meta?.hasSub && item.audioType !== 'LEG') return false;
        if (audioFilter === 'JP' && !meta?.isJapaneseBroadcast) return false;
        if (serviceFilter !== 'ALL' && meta?.serviceName !== serviceFilter) return false;
        if (q) {
          const hay = `${item.title} ${meta?.englishTitle || ''} ${meta?.serviceName || ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
      return { ...day, items };
    });
  }, [audioFilter, days, searchFilter, selectedDayId, serviceFilter]);

  const totalFilteredCount = useMemo(
    () => visibleDays.reduce((acc, d) => acc + d.items.length, 0),
    [visibleDays]
  );

  const hasActiveFilters = audioFilter !== 'ALL' || serviceFilter !== 'ALL' || Boolean(searchFilter.trim());

  const renderReleaseBadges = (item: CatalogMediaItem, compact = false) => {
    const meta = item.scheduleMeta;
    const svcStyle = getServiceBadgeStyle(meta?.serviceName);
    if (compact) {
      const platformLabel =
        meta?.serviceName || (meta?.isJapaneseBroadcast ? 'TV (JP)' : 'Oficial');
      return (
        <div
          data-calendar-badges-compact="true"
          className="flex w-full min-w-0 flex-col"
        >
          <div
            data-calendar-meta-row="true"
            className="flex min-h-[26px] w-full min-w-0 items-center justify-between gap-1 px-2 py-1 sm:px-2.5"
          >
            {item.episodeLabel ? (
              <span
                data-calendar-episode-tag="true"
                className="min-w-0 truncate text-[10.5px] font-bold leading-none tabular-nums text-white"
              >
                {item.episodeLabel}
              </span>
            ) : (
              <span
                data-calendar-episode-tag="true"
                className="text-[10.5px] font-semibold leading-none text-slate-400"
              >
                Novo
              </span>
            )}
            <div className="flex shrink-0 items-center gap-1">
              {meta?.hasDub && (
                <span
                  data-calendar-audio-tag="DUB"
                  className="rounded border border-emerald-500/40 bg-emerald-500/15 px-1 py-0.5 text-[9.5px] font-bold leading-none tracking-wide text-emerald-300"
                >
                  DUB
                </span>
              )}
              {meta?.hasSub && (
                <span
                  data-calendar-audio-tag="SUB"
                  className="rounded border border-sky-500/40 bg-sky-500/15 px-1 py-0.5 text-[9.5px] font-bold leading-none tracking-wide text-sky-300"
                >
                  SUB
                </span>
              )}
              {!meta?.hasDub && !meta?.hasSub && meta?.isJapaneseBroadcast && (
                <span
                  data-calendar-audio-tag="JP"
                  className="rounded border border-white/12 bg-white/6 px-1 py-0.5 text-[9.5px] font-semibold leading-none text-slate-300"
                >
                  JP
                </span>
              )}
            </div>
          </div>
          <div
            data-calendar-service-row="true"
            title={platformLabel}
            className={`flex min-h-[24px] w-full min-w-0 items-center gap-1.5 border-t border-white/6 px-2 py-1 text-[10.5px] font-semibold leading-none sm:px-2.5 ${svcStyle.row}`}
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${svcStyle.dot}`} />
            <span data-calendar-service-name="true" className="truncate">
              {platformLabel}
            </span>
          </div>
        </div>
      );
    }

    return (
      <div className="flex flex-wrap items-center gap-1.5">
        {item.episodeLabel && (
          <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[11px] font-bold tabular-nums text-white">
            {item.episodeLabel}
          </span>
        )}
        {meta?.hasDub && (
          <span className="rounded border border-emerald-500/40 bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-emerald-300">
            DUB
          </span>
        )}
        {meta?.hasSub && (
          <span className="rounded border border-sky-500/40 bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-sky-300">
            SUB
          </span>
        )}
        {!meta?.hasDub && !meta?.hasSub && meta?.isJapaneseBroadcast && (
          <span className="rounded border border-white/12 bg-white/6 px-1.5 py-0.5 text-[10px] font-semibold text-slate-300">
            JP
          </span>
        )}
        {meta?.serviceName && (
          <span
            className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold ${svcStyle.badge}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${svcStyle.dot}`} />
            <span className="max-w-[110px] truncate">{meta.serviceName}</span>
          </span>
        )}
      </div>
    );
  };

  const renderGridCard = (item: CatalogMediaItem) => {
    const favActive = isItemFavorited(item.url, favorites);
    const timeStr = formatLocalTime(item.airingAt);
    const countdown = formatCountdown(item.airingAt, nowMs);
    const meta = item.scheduleMeta;

    return (
      <article
        key={item.id}
        className="group relative flex flex-col overflow-hidden rounded-xl border border-white/10 bg-[#151921] transition-all hover:border-[#f97316]/60 hover:shadow-lg hover:shadow-black/30"
      >
        <button
          type="button"
          onClick={() => onOpenItem(item.url, 'anime', toCalendarSeed(item))}
          onMouseEnter={() => scheduleCardPrefetch(item)}
          onMouseLeave={cancelCardPrefetch}
          onFocus={() => scheduleCardPrefetch(item)}
          onTouchStart={() => scheduleCardPrefetch(item, true)}
          className="flex flex-1 flex-col text-left"
        >
          {/* Poster with top time/countdown overlay & bottom gradient title */}
          <div className="relative w-full">
            <MediaPoster
              src={item.poster}
              alt={item.title}
              aspect="portrait"
              className="w-full"
            />
            <div className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-black/80 via-black/40 to-transparent" />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-[#0d0f12] via-[#0d0f12]/75 to-transparent" />

            {/* Top-left local time & live countdown pill */}
            <div className="absolute left-2 top-2 flex flex-wrap items-center gap-1 pr-10">
              <span className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-[#0d0f12]/85 px-2 py-0.5 font-mono text-xs font-bold tabular-nums text-white backdrop-blur-md">
                <Clock className="h-3 w-3 text-[#f97316]" />
                {timeStr}
              </span>
              {countdown && (
                <span
                  className={`rounded-md border px-2 py-0.5 text-[11px] font-bold leading-tight tabular-nums shadow-sm shadow-black/60 backdrop-blur-md ${
                    countdown.state === 'now'
                      ? 'border-emerald-400/80 bg-[#052e22]/92 text-emerald-100'
                      : countdown.state === 'future'
                        ? 'border-[#f97316]/85 bg-[#1b0e05]/92 text-[#ffedd5]'
                        : 'border-white/25 bg-[#0d0f12]/92 text-slate-200'
                  }`}
                >
                  {countdown.label}
                </span>
              )}
            </div>

            {/* Bottom poster title + subtle meta */}
            <div className="absolute inset-x-0 bottom-0 p-3">
              <h3 className="line-clamp-2 text-sm font-bold leading-snug text-white drop-shadow group-hover:text-[#fb923c]">
                {item.title}
              </h3>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] tabular-nums text-slate-300">
                {item.mediaFormat && <span>{item.mediaFormat}</span>}
                {item.year && <span>{item.year}</span>}
                {meta?.totalEpisodes && <span>{meta.totalEpisodes} eps</span>}
                {item.rating && Number.parseFloat(item.rating) > 0 && (
                  <span className="inline-flex items-center gap-0.5 text-amber-400">
                    <Star className="h-2.5 w-2.5 fill-amber-400" />
                    {item.rating}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Bottom Release Strip (Row 1: EP + Dub/Sub/JP, Row 2: Full-width Platform bar) */}
          <div
            data-calendar-card-footer="true"
            className="flex w-full shrink-0 flex-col border-t border-white/8 bg-[#12161e]"
          >
            {renderReleaseBadges(item, true)}
          </div>
        </button>

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleFavorite(item);
          }}
          aria-pressed={favActive}
          aria-label={
            favActive
              ? `Remover ${item.title} dos favoritos`
              : `Favoritar ${item.title}`
          }
          className={`absolute right-2 top-2 z-10 flex h-8 w-8 items-center justify-center rounded-full border backdrop-blur-md transition-colors ${
            favActive
              ? 'border-rose-500/60 bg-rose-500/85 text-white'
              : 'border-white/15 bg-[#0d0f12]/75 text-slate-200 hover:border-rose-400/70 hover:text-rose-300'
          }`}
        >
          <Heart className={`h-3.5 w-3.5 ${favActive ? 'fill-white' : ''}`} />
        </button>
      </article>
    );
  };

  const renderDayTimeline = (day: CalendarDaySection) => {
    const slots = new Map<string, { airingAt?: number; items: CatalogMediaItem[] }>();
    for (const item of day.items) {
      const timeKey = formatLocalTime(item.airingAt);
      const existing = slots.get(timeKey);
      if (existing) {
        existing.items.push(item);
      } else {
        slots.set(timeKey, { airingAt: item.airingAt, items: [item] });
      }
    }

    return (
      <div className="space-y-4">
        {Array.from(slots.entries()).map(([timeStr, group]) => {
          const countdown = formatCountdown(group.airingAt, nowMs);
          return (
            <div
              key={`${day.id}-${timeStr}`}
              className="grid gap-3 sm:grid-cols-[110px_1fr]"
            >
              <div className="flex items-center gap-2 sm:flex-col sm:items-end sm:justify-start sm:pt-2 sm:text-right">
                <span className="inline-flex items-center gap-1.5 font-mono text-sm font-bold tabular-nums text-white">
                  <Clock className="h-3.5 w-3.5 text-[#f97316]" />
                  {timeStr}
                </span>
                {countdown && (
                  <span
                    className={`text-[11px] font-medium tabular-nums ${
                      countdown.state === 'now'
                        ? 'text-emerald-400'
                        : countdown.state === 'future'
                          ? 'text-[#fb923c]'
                          : 'text-slate-500'
                    }`}
                  >
                    {countdown.label}
                  </span>
                )}
              </div>

              <div className="grid grid-cols-1 gap-2.5 border-l-2 border-white/10 pl-3 sm:pl-4 md:grid-cols-2">
                {group.items.map((item) => {
                  const favActive = isItemFavorited(item.url, favorites);
                  const meta = item.scheduleMeta;
                  return (
                    <div
                      key={item.id}
                      className="group relative flex items-center gap-3 overflow-hidden rounded-xl border border-white/10 bg-[#151921] p-2.5 transition-colors hover:border-[#f97316]/60"
                    >
                      <button
                        type="button"
                        onClick={() => onOpenItem(item.url, 'anime', toCalendarSeed(item))}
                        onMouseEnter={() => scheduleCardPrefetch(item)}
                        onMouseLeave={cancelCardPrefetch}
                        onFocus={() => scheduleCardPrefetch(item)}
                        onTouchStart={() => scheduleCardPrefetch(item, true)}
                        className="flex min-w-0 flex-1 items-center gap-3 text-left"
                      >
                        <MediaPoster
                          src={item.poster}
                          alt={item.title}
                          aspect="portrait"
                          className="h-20 w-14 shrink-0 rounded-lg border border-white/10"
                        />
                        <div className="min-w-0 flex-1 space-y-1.5 pr-8">
                          <h3 className="line-clamp-2 text-sm font-semibold leading-snug text-white group-hover:text-[#fb923c]">
                            {item.title}
                          </h3>
                          {renderReleaseBadges(item)}
                          {(item.mediaFormat || item.rating || meta?.totalEpisodes) && (
                            <p className="text-[11px] tabular-nums text-slate-400">
                              {[
                                item.mediaFormat,
                                item.year,
                                meta?.totalEpisodes ? `${meta.totalEpisodes} eps` : null,
                                item.rating ? `★ ${item.rating}` : null,
                              ]
                                .filter(Boolean)
                                .join(' · ')}
                            </p>
                          )}
                        </div>
                      </button>

                      <button
                        type="button"
                        onClick={() => onToggleFavorite(item)}
                        aria-pressed={favActive}
                        aria-label={
                          favActive
                            ? `Remover ${item.title} dos favoritos`
                            : `Favoritar ${item.title}`
                        }
                        className={`absolute right-2.5 top-2.5 flex h-7 w-7 items-center justify-center rounded-full border transition-colors ${
                          favActive
                            ? 'border-rose-500/60 bg-rose-500/85 text-white'
                            : 'border-white/10 bg-[#0d0f12]/70 text-slate-300 hover:border-rose-400/60 hover:text-rose-300'
                        }`}
                      >
                        <Heart className={`h-3.5 w-3.5 ${favActive ? 'fill-white' : ''}`} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <section className="space-y-6">
      {/* Header + Mode / Layout controls */}
      <div className="rounded-xl border border-white/10 bg-[#151921] p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Calendar className="h-5 w-5 text-[#f97316]" />
              <h1 className="text-xl font-bold text-white">Calendário de Animes</h1>
              <span className="rounded-md border border-[#f97316]/30 bg-[#f97316]/12 px-2 py-0.5 text-[11px] font-semibold text-[#fb923c]">
                LiveChart.me
              </span>
            </div>
            <p className="mt-1 text-xs text-slate-400">
              Horários no seu fuso local, áudio/legenda (Dub · Sub) e plataformas oficiais. Toque em um anime para ver detalhes no TheTVDB e assistir.
            </p>
            <p
              role="note"
              data-schedule-disclaimer="true"
              className="mt-2 inline-flex items-start gap-1.5 rounded-lg border border-[#f97316]/25 bg-[#f97316]/[0.07] px-2.5 py-1.5 text-[11px] leading-relaxed text-slate-300"
            >
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#fb923c]" />
              <span>
                Os horários e contagens regressivas são{' '}
                <strong className="font-semibold text-white">previsões de lançamentos oficiais</strong>,
                e não o momento em que o episódio ficará disponível nos servidores.
              </span>
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Schedule preference mode */}
            <div
              role="group"
              aria-label="Modo de exibição do calendário"
              className="inline-flex rounded-lg border border-white/10 bg-[#0d0f12] p-0.5"
            >
              {MODE_OPTIONS.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  title={m.title}
                  onClick={() => onChangeScheduleMode(m.id)}
                  onMouseEnter={() => onPrefetchScheduleMode?.(m.id)}
                  onFocus={() => onPrefetchScheduleMode?.(m.id)}
                  onTouchStart={() => onPrefetchScheduleMode?.(m.id)}
                  className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                    scheduleMode === m.id
                      ? 'bg-[#f97316] text-[#0d0f12] font-semibold'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>

            {/* Grid vs Timeline switcher */}
            <div
              role="group"
              aria-label="Layout do calendário"
              className="inline-flex rounded-lg border border-white/10 bg-[#0d0f12] p-0.5"
            >
              <button
                type="button"
                onClick={() => setLayout('grid')}
                aria-pressed={layout === 'grid'}
                title="Grade compacta"
                className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  layout === 'grid'
                    ? 'bg-white/12 text-white'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <LayoutGrid className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Grade</span>
              </button>
              <button
                type="button"
                onClick={() => setLayout('timeline')}
                aria-pressed={layout === 'timeline'}
                title="Linha do tempo por horário"
                className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  layout === 'timeline'
                    ? 'bg-white/12 text-white'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <List className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Horários</span>
              </button>
            </div>

            <button
              type="button"
              disabled={loading}
              onClick={onRefresh}
              aria-label="Atualizar calendário"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-[#0d0f12] text-slate-300 transition-colors hover:border-[#f97316]/60 hover:text-white disabled:opacity-50"
            >
              {loading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-[#f97316]" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        </div>

        {/* Day selector strip */}
        {days.length > 0 && (
          <div
            role="tablist"
            aria-label="Dias da semana"
            className="mt-4 flex gap-1.5 overflow-x-auto pb-1"
          >
            <button
              type="button"
              role="tab"
              aria-selected={selectedDayId === 'all'}
              onClick={() => onSelectDay('all')}
              className={`flex shrink-0 flex-col items-start rounded-lg border px-3 py-1.5 text-left transition-colors ${
                selectedDayId === 'all'
                  ? 'border-[#f97316] bg-[#f97316]/15 text-white'
                  : 'border-white/10 bg-[#0d0f12] text-slate-400 hover:text-white'
              }`}
            >
              <span className="text-xs font-semibold">Semana</span>
              <span className="text-[10px] tabular-nums opacity-75">
                {totalWeekCount} animes
              </span>
            </button>

            {days.map((day) => {
              const active = selectedDayId === day.id;
              return (
                <button
                  key={day.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => onSelectDay(day.id)}
                  className={`flex shrink-0 flex-col items-start rounded-lg border px-3 py-1.5 text-left transition-colors ${
                    active
                      ? 'border-[#f97316] bg-[#f97316]/15 text-white'
                      : 'border-white/10 bg-[#0d0f12] text-slate-400 hover:text-white'
                  }`}
                >
                  <span className="flex items-center gap-1.5 text-xs font-semibold">
                    <span>{day.label}</span>
                    <span className="rounded bg-white/10 px-1 py-0.2 text-[10px] tabular-nums">
                      {day.items.length}
                    </span>
                  </span>
                  {day.dateLabel && (
                    <span className="text-[10px] tabular-nums opacity-75">
                      {day.dateLabel}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {/* Filter bar: Quick Search + Audio Type + Streaming Services */}
        <div className="mt-3.5 space-y-2.5 border-t border-white/8 pt-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
              <input
                type="text"
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                placeholder="Filtrar anime ou serviço..."
                aria-label="Filtrar animes no calendário"
                className="w-full rounded-lg border border-white/10 bg-[#0d0f12] py-1.5 pl-8 pr-7 text-xs text-white placeholder:text-slate-500 focus:border-[#f97316] focus:outline-none"
              />
              {searchFilter && (
                <button
                  type="button"
                  onClick={() => setSearchFilter('')}
                  aria-label="Limpar filtro"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-1">
              {(
                [
                  { id: 'ALL', label: 'Todos' },
                  { id: 'DUB', label: 'Dub' },
                  { id: 'SUB', label: 'Sub' },
                  { id: 'JP', label: 'TV / JP' },
                ] as Array<{ id: AudioTrackFilter; label: string }>
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setAudioFilter(opt.id)}
                  aria-pressed={audioFilter === opt.id}
                  className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                    audioFilter === opt.id
                      ? 'border-[#f97316] bg-[#f97316]/15 text-white'
                      : 'border-white/10 bg-[#0d0f12] text-slate-400 hover:text-white'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {hasActiveFilters && (
              <button
                type="button"
                onClick={() => {
                  setAudioFilter('ALL');
                  setServiceFilter('ALL');
                  setSearchFilter('');
                }}
                className="inline-flex items-center gap-1 rounded-md border border-[#f97316]/35 bg-[#f97316]/10 px-2.5 py-1 text-xs font-medium text-[#fb923c] hover:bg-[#f97316]/20"
              >
                <X className="h-3 w-3" />
                <span>Limpar</span>
              </button>
            )}
          </div>

          {/* Streaming Service Filter Pills */}
          {allServices.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setServiceFilter('ALL')}
                className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  serviceFilter === 'ALL'
                    ? 'border-[#f97316] bg-[#f97316]/15 text-white'
                    : 'border-white/10 bg-[#0d0f12] text-slate-400 hover:text-white'
                }`}
              >
                Todas plataformas
              </button>
              {allServices.slice(0, 10).map((svc) => {
                const active = serviceFilter === svc.name;
                const style = getServiceBadgeStyle(svc.name);
                return (
                  <button
                    key={svc.name}
                    type="button"
                    onClick={() => setServiceFilter(active ? 'ALL' : svc.name)}
                    className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                      active
                        ? style.badge
                        : 'border-white/10 bg-[#0d0f12] text-slate-300 hover:border-white/25 hover:text-white'
                    }`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
                    <span>{svc.name}</span>
                    <span className="tabular-nums opacity-65">({svc.count})</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Calendar Content */}
      {loading && days.length === 0 ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {Array.from({ length: 10 }).map((_, i) => (
            <div
              key={i}
              className="anisync-shimmer aspect-[2/3] rounded-xl border border-white/8"
            />
          ))}
        </div>
      ) : error && days.length === 0 ? (
        <div className="rounded-xl border border-red-500/20 bg-[#151921] p-8 text-center">
          <p className="text-sm text-red-200">{error}</p>
          <button
            type="button"
            onClick={onRefresh}
            className="mt-4 inline-flex items-center gap-2 rounded-lg bg-[#f97316] px-4 py-2 text-xs font-semibold text-[#0d0f12]"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>Tentar novamente</span>
          </button>
        </div>
      ) : totalFilteredCount === 0 ? (
        <div className="rounded-xl border border-white/10 bg-[#151921] p-10 text-center">
          <p className="text-sm text-slate-300">
            Nenhum anime encontrado no calendário com os filtros atuais.
          </p>
          {hasActiveFilters && (
            <button
              type="button"
              onClick={() => {
                setAudioFilter('ALL');
                setServiceFilter('ALL');
                setSearchFilter('');
              }}
              className="mt-4 rounded-lg bg-[#f97316] px-4 py-2 text-xs font-semibold text-[#0d0f12]"
            >
              Mostrar todos
            </button>
          )}
        </div>
      ) : (
        <div
          className={`space-y-8 transition-opacity duration-150 ${
            loading ? 'opacity-65' : 'opacity-100'
          }`}
        >
          {visibleDays
            .filter((d) => d.items.length > 0)
            .map((day) => (
              <div key={day.id} className="space-y-4">
                <div className="flex items-baseline justify-between gap-2 border-b border-white/10 pb-2.5">
                  <div className="flex items-baseline gap-2.5">
                    <h2 className="text-lg font-bold text-white">
                      {day.label}
                    </h2>
                    {day.dateLabel && (
                      <span className="text-xs font-medium text-[#fb923c]">
                        {day.dateLabel}
                      </span>
                    )}
                  </div>
                  <span className="text-xs tabular-nums text-slate-400">
                    {day.items.length} lançamento{day.items.length === 1 ? '' : 's'}
                  </span>
                </div>

                {layout === 'grid' ? (
                  <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                    {day.items.map((item) => renderGridCard(item))}
                  </div>
                ) : (
                  renderDayTimeline(day)
                )}
              </div>
            ))}
        </div>
      )}
    </section>
  );
}
