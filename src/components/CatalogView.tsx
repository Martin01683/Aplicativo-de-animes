import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  Search,
  X,
  Clock,
  Heart,
  Trash2,
  RefreshCw,
  Loader2,
  ChevronDown,
  Bell,
  BellOff,
  Check,
  CheckCheck,
  ExternalLink,
  Play,
  Shuffle,
  Sparkles,
  Film,
  Star,
  Tv,
  ArrowRight,
  SlidersHorizontal,
} from 'lucide-react';
import { apiFetch } from '../lib/apiClient';
import { isItemFavorited } from '../lib/favoriteAlerts';
import {
  filterFavoriteAlerts,
  isFavoriteMuted,
  type NotificationPermissionStatus,
} from '../lib/notifications';
import {
  canonicalEpisodeProgressKey,
  countAnimeEpisodesInHistory,
  formatPlaybackTimestamp,
  getHistoryEntrySeriesName,
  isEpisodeCompleted,
} from '../lib/playbackProgress';
import { formatRelativeTimestamp } from '../lib/settings';
import type {
  AudioType,
  CalendarDaySection,
  CatalogArchiveCategory,
  CatalogFilters,
  CatalogMediaItem,
  FavoriteAlertEntry,
  HomeCatalog,
  LiveChartScheduleMode,
  MediaKind,
  SearchResultItem,
  SearchSuggestResponse,
  SliderMovieItem,
  WatchHistoryEntry,
} from '../lib/types';
import type { NavSection } from './Header';
import { LiveChartCalendar } from './LiveChartCalendar';
import { MediaPoster } from './MediaPoster';

const GLOSSARY_TERMS = [
  '#',
  'A',
  'B',
  'C',
  'D',
  'E',
  'F',
  'G',
  'H',
  'I',
  'J',
  'K',
  'L',
  'M',
  'N',
  'O',
  'P',
  'Q',
  'R',
  'S',
  'T',
  'U',
  'V',
  'W',
  'X',
  'Y',
  'Z',
] as const;

export interface ArchiveCategoryState {
  items: CatalogMediaItem[];
  currentPage: number;
  totalPages: number;
  loading: boolean;
  initialized: boolean;
}

interface CatalogViewProps {
  catalog: HomeCatalog | null;
  loading: boolean;
  error: string;
  activeSection: NavSection;
  searchQuery: string;
  searchResults: SearchResultItem[] | null;
  searching: boolean;
  searchPage: number;
  searchTotalPages: number;
  loadingMoreSearch: boolean;
  loadingRandom: boolean;
  releases: CatalogMediaItem[];
  releasesPage: number;
  releasesTotalPages: number;
  loadingMoreReleases: boolean;
  archiveCategory: CatalogArchiveCategory;
  archiveState: Record<CatalogArchiveCategory, ArchiveCategoryState>;
  featuredAnimes: CatalogMediaItem[];
  sliderMovies: SliderMovieItem[];
  catalogFilters: CatalogFilters;
  selectedGenre: string;
  selectedYear: string;
  selectedGlossary: string;
  filteredCatalog: ArchiveCategoryState;
  weeklyCalendarDays: CalendarDaySection[];
  selectedCalendarDay: string;
  calendarScheduleMode: LiveChartScheduleMode;
  loadingWeeklyCalendar: boolean;
  calendarError: string;
  favorites: CatalogMediaItem[];
  mutedFavoriteUrls: string[];
  history: WatchHistoryEntry[];
  alerts: FavoriteAlertEntry[];
  checkingAlerts: boolean;
  lastEpisodeCheckAt: string | null;
  notificationPermission: NotificationPermissionStatus;
  onRetryCatalog: () => void;
  onSearch: (query: string) => void;
  onLoadMoreSearch: () => void;
  onClearSearch: () => void;
  onOpenRandom: () => void;
  onLoadMoreReleases: () => void;
  onSelectArchiveCategory: (category: CatalogArchiveCategory) => void;
  onLoadMoreArchiveCategory: (category: CatalogArchiveCategory) => void;
  onSelectGenre: (genreSlug: string) => void;
  onSelectYear: (yearSlug: string) => void;
  onSelectGlossary: (term: string) => void;
  onClearCatalogFilters: () => void;
  onLoadMoreFiltered: () => void;
  onSelectCalendarDay: (dayId: string) => void;
  onChangeCalendarScheduleMode: (mode: LiveChartScheduleMode) => void;
  onRefreshCalendar: () => void;
  onOpenItem: (url: string, kind: MediaKind) => void;
  onToggleFavorite: (item: CatalogMediaItem) => void;
  onToggleMuteFavorite: (animeUrl: string) => void;
  onCheckFavoriteUpdates: () => void;
  onMarkAllAlertsRead: () => void;
  onMarkAlertRead: (alertId: string) => void;
  onDismissAlert: (alertId: string) => void;
  onClearReadAlerts: () => void;
  onOpenAlert: (alert: FavoriteAlertEntry) => void;
  onRequestPushNotifications: () => void;
  onSendTestNotification: () => void;
  onOpenNotificationSettings: () => void;
  onClearHistory: () => void;
  onRemoveHistoryEntry: (entry: WatchHistoryEntry) => void;
  onRemoveHistoryAnime: (entry: WatchHistoryEntry) => void;
  onSelectSection: (section: NavSection) => void;
  defaultAudioFilter: 'ALL' | 'DUB' | 'LEG';
  watchedEpisodeKeys?: Set<string>;
}

const BASE_ARCHIVE_TABS: Array<{ id: CatalogArchiveCategory; label: string }> = [
  { id: 'animes', label: 'Animes' },
  { id: 'movies', label: 'Filmes' },
  { id: 'dublado', label: 'Dublados' },
  { id: 'legendado', label: 'Legendados' },
  { id: 'donghua', label: 'Donghua' },
  { id: 'cartoon', label: 'Cartoon' },
  { id: 'live-action', label: 'Live Action' },
];

function kindDisplayLabel(kind: MediaKind): string {
  switch (kind) {
    case 'movie':
      return 'Filme';
    case 'series':
      return 'Série';
    case 'episode':
      return 'Episódio';
    default:
      return 'Anime';
  }
}

export function CatalogView({
  catalog,
  loading,
  error,
  activeSection,
  searchQuery,
  searchResults,
  searching,
  searchPage,
  searchTotalPages,
  loadingMoreSearch,
  loadingRandom,
  releases,
  releasesPage,
  releasesTotalPages,
  loadingMoreReleases,
  archiveCategory,
  archiveState,
  featuredAnimes,
  sliderMovies,
  catalogFilters,
  selectedGenre,
  selectedYear,
  selectedGlossary,
  filteredCatalog,
  weeklyCalendarDays,
  selectedCalendarDay,
  calendarScheduleMode,
  loadingWeeklyCalendar,
  calendarError,
  favorites,
  mutedFavoriteUrls,
  history,
  alerts,
  checkingAlerts,
  lastEpisodeCheckAt,
  notificationPermission,
  onRetryCatalog,
  onSearch,
  onLoadMoreSearch,
  onClearSearch,
  onOpenRandom,
  onLoadMoreReleases,
  onSelectArchiveCategory,
  onLoadMoreArchiveCategory,
  onSelectGenre,
  onSelectYear,
  onSelectGlossary,
  onClearCatalogFilters,
  onLoadMoreFiltered,
  onSelectCalendarDay,
  onChangeCalendarScheduleMode,
  onRefreshCalendar,
  onOpenItem,
  onToggleFavorite,
  onToggleMuteFavorite,
  onCheckFavoriteUpdates,
  onMarkAllAlertsRead,
  onMarkAlertRead,
  onDismissAlert,
  onClearReadAlerts,
  onOpenAlert,
  onRequestPushNotifications,
  onSendTestNotification,
  onOpenNotificationSettings,
  onClearHistory,
  onRemoveHistoryEntry,
  onRemoveHistoryAnime,
  onSelectSection,
  defaultAudioFilter,
  watchedEpisodeKeys,
}: CatalogViewProps) {
  const [searchInput, setSearchInput] = useState(searchQuery);
  const [audioFilter, setAudioFilter] = useState<'ALL' | 'DUB' | 'LEG'>(defaultAudioFilter);
  const [libraryAlertFilter, setLibraryAlertFilter] = useState<'all' | 'unread'>('all');
  const [glossaryExpanded, setGlossaryExpanded] = useState(false);
  const [suggestions, setSuggestions] = useState<SearchResultItem[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [openHistoryMenuKey, setOpenHistoryMenuKey] = useState<string | null>(null);
  const searchBoxRef = useRef<HTMLDivElement>(null);
  const suggestReqGenRef = useRef(0);

  useEffect(() => {
    setAudioFilter(defaultAudioFilter);
  }, [defaultAudioFilter]);

  useEffect(() => {
    setSearchInput(searchQuery);
  }, [searchQuery]);

  useEffect(() => {
    if (selectedGlossary) setGlossaryExpanded(true);
  }, [selectedGlossary]);

  useEffect(() => {
    const handleOutside = (e: MouseEvent) => {
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target as Node)) {
        setSuggestOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, []);

  useEffect(() => {
    if (!openHistoryMenuKey) return;
    const handleOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-history-menu-root]')) return;
      setOpenHistoryMenuKey(null);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenHistoryMenuKey(null);
    };
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [openHistoryMenuKey]);

  useEffect(() => {
    const trimmed = searchInput.trim();
    if (!suggestOpen || trimmed.length < 2) {
      setSuggestions([]);
      setLoadingSuggestions(false);
      return;
    }

    const reqId = ++suggestReqGenRef.current;
    const timer = window.setTimeout(() => {
      setLoadingSuggestions(true);
      apiFetch(`/api/search-suggest?q=${encodeURIComponent(trimmed)}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data: SearchSuggestResponse | null) => {
          if (suggestReqGenRef.current !== reqId) return;
          setSuggestions(Array.isArray(data?.results) ? data.results.slice(0, 8) : []);
        })
        .catch(() => {
          if (suggestReqGenRef.current !== reqId) return;
          setSuggestions([]);
        })
        .finally(() => {
          if (suggestReqGenRef.current === reqId) {
            setLoadingSuggestions(false);
          }
        });
    }, 280);

    return () => window.clearTimeout(timer);
  }, [searchInput, suggestOpen]);

  const handleSearchSubmit = (e: FormEvent) => {
    e.preventDefault();
    setSuggestOpen(false);
    onSearch(searchInput.trim());
  };

  const filterByAudio = (items: CatalogMediaItem[]): CatalogMediaItem[] => {
    if (audioFilter === 'ALL') return items;
    return items.filter((item) => {
      const effectiveAudio: AudioType = item.audioType ?? 'LEG';
      return effectiveAudio === audioFilter;
    });
  };

  const archiveTabs = useMemo(() => {
    const hasServerSeries =
      Boolean(catalog?.series && catalog.series.length > 0) ||
      archiveState.series.items.length > 0;
    if (!hasServerSeries) return BASE_ARCHIVE_TABS;
    return [
      BASE_ARCHIVE_TABS[0],
      BASE_ARCHIVE_TABS[1],
      { id: 'series' as CatalogArchiveCategory, label: 'Séries' },
      ...BASE_ARCHIVE_TABS.slice(2),
    ];
  }, [archiveState.series.items.length, catalog?.series]);

  const continueWatchingItems = useMemo(() => {
    return history
      .filter((entry) => {
        const pos = entry.positionSec ?? 0;
        const dur = entry.durationSec ?? 0;
        const completed =
          Boolean(entry.completed) || (dur > 0 && isEpisodeCompleted(pos, dur, false));
        return !completed && pos >= 2;
      })
      .slice(0, 4);
  }, [history]);

  const renderCard = (
    item: CatalogMediaItem,
    aspect: 'portrait' | 'landscape',
    progressMeta?: { label?: string; pct?: number },
    historyMenu?: {
      menuKey: string;
      entry: WatchHistoryEntry;
      animeEpisodeCount: number;
      animeName: string;
    },
    showMuteButton = false
  ) => {
    const favActive = isItemFavorited(item.url, favorites);
    const favMuted = showMuteButton && favActive && isFavoriteMuted(item.url, mutedFavoriteUrls);
    const metaParts: string[] = [];
    if (favMuted) {
      metaParts.push('Silenciado');
    }
    if (progressMeta?.label) {
      metaParts.push(progressMeta.label);
    } else if (
      item.kind === 'episode' &&
      watchedEpisodeKeys?.has(canonicalEpisodeProgressKey(item.url))
    ) {
      metaParts.push('Visto');
    }
    if (item.episodeLabel) metaParts.push(item.episodeLabel);
    if (item.year) metaParts.push(item.year);
    if (item.quality) metaParts.push(item.quality);
    if (item.rating && Number.parseFloat(item.rating) > 0) metaParts.push(`★ ${item.rating}`);
    if (item.isHiatus && item.statusBadge) metaParts.push(item.statusBadge);
    if (item.sourceServerName) metaParts.push(item.sourceServerName);

    const isHistoryMenuOpen = Boolean(
      historyMenu && openHistoryMenuKey === historyMenu.menuKey
    );

    return (
      <div
        key={`${item.url}-${item.id}`}
        className={`group relative flex flex-col rounded-xl border border-white/10 bg-[#151921] transition-colors hover:border-[#f97316]/60 ${
          isHistoryMenuOpen ? 'z-20 overflow-visible' : 'overflow-hidden'
        }`}
      >
        <button
          type="button"
          onClick={() => onOpenItem(item.url, item.kind)}
          className="flex flex-1 flex-col text-left"
        >
          <div className="relative w-full overflow-hidden rounded-t-xl border-b border-white/8">
            <MediaPoster
              src={item.poster}
              alt={item.title}
              aspect={aspect}
              className="w-full"
            />
            {item.audioType && (
              <span
                className={`pointer-events-none absolute left-2 top-2 rounded-md border px-1.5 py-0.5 text-[10px] font-bold tracking-wide backdrop-blur-md ${
                  item.audioType === 'DUB'
                    ? 'border-emerald-400/45 bg-emerald-500/80 text-[#052e16]'
                    : 'border-white/15 bg-[#0d0f12]/80 text-slate-200'
                }`}
              >
                {item.audioType}
              </span>
            )}
            {typeof progressMeta?.pct === 'number' && progressMeta.pct > 0 && (
              <div className="absolute inset-x-0 bottom-0 h-1 bg-black/60">
                <div
                  className="h-full bg-[#f97316]"
                  style={{ width: `${Math.min(100, Math.max(4, progressMeta.pct))}%` }}
                />
              </div>
            )}
          </div>
          <div className="flex flex-1 flex-col justify-between p-3">
            <h3 className="line-clamp-2 text-sm font-semibold leading-snug text-white group-hover:text-[#fb923c]">
              {item.title}
            </h3>
            {metaParts.length > 0 && (
              <p className="mt-1.5 truncate text-xs tabular-nums text-slate-400">
                {metaParts.join(' · ')}
              </p>
            )}
          </div>
        </button>

        {historyMenu && (
          <div data-history-menu-root className="absolute right-12 top-2 z-20">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setOpenHistoryMenuKey((prev) =>
                  prev === historyMenu.menuKey ? null : historyMenu.menuKey
                );
              }}
              aria-expanded={isHistoryMenuOpen}
              aria-haspopup="menu"
              aria-label={`Remover ${item.title} do histórico`}
              title="Remover do histórico"
              className={`flex h-8 w-8 items-center justify-center rounded-full border backdrop-blur-md transition-colors ${
                isHistoryMenuOpen
                  ? 'border-rose-500/70 bg-rose-500/85 text-white'
                  : 'border-white/15 bg-[#0d0f12]/75 text-slate-200 hover:border-rose-400/70 hover:text-rose-300'
              }`}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>

            {isHistoryMenuOpen && (
              <div
                role="menu"
                aria-label="Opções de remoção do histórico"
                onClick={(e) => e.stopPropagation()}
                className="absolute right-0 top-10 z-30 w-56 rounded-xl border border-white/15 bg-[#0d0f12]/95 p-1.5 text-xs text-slate-200 shadow-2xl backdrop-blur-md"
              >
                <div className="truncate border-b border-white/10 px-2.5 pb-1.5 pt-1 text-[11px] font-medium text-slate-400">
                  {historyMenu.animeName}
                </div>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpenHistoryMenuKey(null);
                    onRemoveHistoryEntry(historyMenu.entry);
                  }}
                  className="mt-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-slate-200 transition-colors hover:bg-white/10 hover:text-white"
                >
                  <X className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                  <span>Remover este episódio</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpenHistoryMenuKey(null);
                    onRemoveHistoryAnime(historyMenu.entry);
                  }}
                  className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-rose-300 transition-colors hover:bg-rose-500/15 hover:text-rose-200"
                >
                  <span className="inline-flex items-center gap-2">
                    <Trash2 className="h-3.5 w-3.5 shrink-0" />
                    <span>Todos deste anime</span>
                  </span>
                  {historyMenu.animeEpisodeCount > 1 && (
                    <span className="rounded bg-rose-500/20 px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums text-rose-200">
                      {historyMenu.animeEpisodeCount}
                    </span>
                  )}
                </button>
              </div>
            )}
          </div>
        )}

        {showMuteButton && favActive && !historyMenu && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleMuteFavorite(item.url);
            }}
            aria-pressed={favMuted}
            aria-label={
              favMuted
                ? `Ativar avisos de ${item.title}`
                : `Silenciar avisos de ${item.title}`
            }
            title={favMuted ? 'Ativar avisos deste anime' : 'Silenciar avisos deste anime'}
            className={`absolute right-12 top-2 z-10 flex h-8 w-8 items-center justify-center rounded-full border backdrop-blur-md transition-colors ${
              favMuted
                ? 'border-white/20 bg-[#0d0f12]/90 text-slate-400 hover:border-[#f97316]/60 hover:text-white'
                : 'border-[#f97316]/50 bg-[#0d0f12]/80 text-[#fb923c] hover:bg-[#f97316]/20'
            }`}
          >
            {favMuted ? <BellOff className="h-3.5 w-3.5" /> : <Bell className="h-3.5 w-3.5" />}
          </button>
        )}

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
      </div>
    );
  };

  const hasActiveFilter = Boolean(selectedGenre || selectedYear || selectedGlossary);
  const displayedArchive = hasActiveFilter
    ? filteredCatalog
    : archiveState[archiveCategory];
  const activeGenreLabel = catalogFilters.genres.find((g) => g.slug === selectedGenre)?.label;

  const showSuggestDropdown =
    suggestOpen && searchInput.trim().length >= 2 && (loadingSuggestions || suggestions.length > 0);
  const showGlobalSearchBar = activeSection !== 'calendar' || searchResults !== null;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
      {/* Compact Search Bar (shown outside Calendar so Calendar stays ultra clean) */}
      {showGlobalSearchBar && (
        <section className="mb-6">
          <form onSubmit={handleSearchSubmit} className="flex flex-wrap gap-2 sm:flex-nowrap">
            <div ref={searchBoxRef} className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <input
                id="catalog-search-input"
                type="text"
                autoComplete="off"
                aria-label="Buscar nos servidores disponíveis"
                value={searchInput}
                onFocus={() => {
                  if (searchInput.trim().length >= 2) setSuggestOpen(true);
                }}
                onChange={(e) => {
                  setSearchInput(e.target.value);
                  setSuggestOpen(e.target.value.trim().length >= 2);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setSuggestOpen(false);
                  }
                }}
                placeholder="Buscar anime nos servidores..."
                className="w-full rounded-xl border border-white/12 bg-[#151921] py-2.5 pl-10 pr-9 text-sm text-white placeholder:text-slate-500 focus:border-[#f97316] focus:outline-none"
              />
              {(searchInput || searchResults !== null) && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchInput('');
                    setSuggestions([]);
                    setSuggestOpen(false);
                    onClearSearch();
                  }}
                  aria-label="Limpar busca"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              )}

              {showSuggestDropdown && (
                <div
                  role="listbox"
                  aria-label="Sugestões de busca"
                  className="absolute left-0 right-0 top-full z-30 mt-1.5 overflow-hidden rounded-xl border border-white/15 bg-[#151921] shadow-2xl"
                >
                  {loadingSuggestions && suggestions.length === 0 ? (
                    <div className="flex items-center gap-2 px-3.5 py-3 text-xs text-slate-400">
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-[#f97316]" />
                      <span>Buscando nos servidores...</span>
                    </div>
                  ) : (
                    <div className="max-h-80 divide-y divide-white/8 overflow-y-auto">
                      {suggestions.map((item) => (
                        <button
                          key={item.url}
                          type="button"
                          role="option"
                          onClick={() => {
                            setSuggestOpen(false);
                            onOpenItem(item.url, item.kind);
                          }}
                          className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-white/5"
                        >
                          <MediaPoster
                            src={item.poster}
                            alt={item.title}
                            aspect="portrait"
                            className="h-12 w-9 shrink-0 rounded border border-white/10"
                          />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-white">
                              {item.title}
                            </p>
                            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                              <span>{kindDisplayLabel(item.kind)}</span>
                              {item.audioType && (
                                <span
                                  className={
                                    item.audioType === 'DUB'
                                      ? 'font-semibold text-emerald-400'
                                      : 'text-slate-300'
                                  }
                                >
                                  {item.audioType === 'DUB' ? 'Dublado' : 'Legendado'}
                                </span>
                              )}
                              {item.year && <span className="tabular-nums">{item.year}</span>}
                              {item.rating && (
                                <span className="inline-flex items-center gap-0.5 tabular-nums text-amber-400">
                                  <Star className="h-3 w-3 fill-amber-400" />
                                  {item.rating}
                                </span>
                              )}
                              {item.sourceServerName && (
                                <span className="rounded bg-white/8 px-1.5 py-0.5 text-[10px] text-slate-300">
                                  {item.sourceServerName}
                                </span>
                              )}
                            </div>
                          </div>
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={() => {
                          setSuggestOpen(false);
                          onSearch(searchInput.trim());
                        }}
                        className="flex w-full items-center justify-center gap-1.5 bg-[#0d0f12]/70 px-3.5 py-2.5 text-xs font-semibold text-[#fb923c] transition-colors hover:bg-[#f97316]/15"
                      >
                        <Search className="h-3.5 w-3.5" />
                        <span>Ver todos os resultados para &ldquo;{searchInput.trim()}&rdquo;</span>
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="flex w-full gap-2 sm:w-auto">
              <button
                type="submit"
                className="flex-1 shrink-0 rounded-xl bg-[#f97316] px-5 py-2.5 text-sm font-semibold text-[#0d0f12] transition-colors hover:bg-[#fb923c] sm:flex-initial"
              >
                Buscar
              </button>
              <button
                type="button"
                disabled={loadingRandom}
                onClick={onOpenRandom}
                aria-label="Abrir título aleatório"
                className="inline-flex flex-1 shrink-0 items-center justify-center gap-1.5 rounded-xl border border-white/12 bg-[#151921] px-3.5 py-2.5 text-sm font-medium text-slate-200 transition-colors hover:border-[#f97316]/60 hover:text-white disabled:opacity-50 sm:flex-initial"
              >
                {loadingRandom ? (
                  <Loader2 className="h-4 w-4 animate-spin text-[#f97316]" />
                ) : (
                  <Shuffle className="h-4 w-4 text-[#f97316]" />
                )}
                <span>Aleatório</span>
              </button>
            </div>
          </form>
        </section>
      )}

      {/* Search Results View */}
      {searchResults !== null ? (
        <section>
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-3">
            <div>
              <h1 className="text-xl font-bold text-white">
                Resultados para &ldquo;{searchQuery}&rdquo;
              </h1>
              <p className="mt-0.5 text-xs tabular-nums text-slate-400">
                {searching
                  ? 'Consultando servidores disponíveis...'
                  : `${searchResults.length} título(s) disponível(is)${
                      searchTotalPages > 1
                        ? ` · Página ${searchPage} de ${searchTotalPages}`
                        : ''
                    }`}
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setSearchInput('');
                onClearSearch();
              }}
              className="rounded-lg border border-white/12 bg-[#151921] px-3 py-1.5 text-xs font-medium text-slate-300 hover:text-white"
            >
              Voltar
            </button>
          </div>

          {searching ? (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
              {Array.from({ length: 10 }).map((_, i) => (
                <div
                  key={i}
                  className="aspect-[2/3] animate-pulse rounded-xl border border-white/8 bg-[#151921]"
                />
              ))}
            </div>
          ) : searchResults.length === 0 ? (
            <div className="rounded-xl border border-white/10 bg-[#151921] p-10 text-center">
              <p className="text-sm text-slate-300">
                Nenhum título disponível nos servidores para &ldquo;{searchQuery}&rdquo;.
              </p>
              <button
                type="button"
                onClick={() => {
                  setSearchInput('');
                  onClearSearch();
                }}
                className="mt-4 rounded-lg bg-[#f97316] px-4 py-2 text-xs font-semibold text-[#0d0f12]"
              >
                Voltar ao início
              </button>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                {searchResults.map((item) =>
                  renderCard(
                    {
                      id: item.id,
                      title: item.title,
                      url: item.url,
                      kind: item.kind,
                      poster: item.poster,
                      audioType: item.audioType,
                      year: item.year,
                      rating: item.rating,
                      sourceServerName: item.sourceServerName,
                    },
                    'portrait'
                  )
                )}
              </div>

              {searchPage < searchTotalPages && (
                <div className="mt-7 flex justify-center">
                  <button
                    type="button"
                    disabled={loadingMoreSearch}
                    onClick={onLoadMoreSearch}
                    className="inline-flex items-center gap-2 rounded-xl border border-white/12 bg-[#151921] px-5 py-2.5 text-sm font-medium text-white transition-colors hover:border-[#f97316]/60 disabled:opacity-50"
                  >
                    {loadingMoreSearch ? (
                      <Loader2 className="h-4 w-4 animate-spin text-[#f97316]" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-[#f97316]" />
                    )}
                    <span>
                      {loadingMoreSearch
                        ? 'Carregando resultados...'
                        : `Carregar mais (página ${searchPage + 1} de ${searchTotalPages})`}
                    </span>
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      ) : activeSection === 'calendar' ? (
        /* LiveChart.me Weekly Anime Schedule */
        <LiveChartCalendar
          days={weeklyCalendarDays}
          selectedDayId={selectedCalendarDay}
          scheduleMode={calendarScheduleMode}
          loading={loadingWeeklyCalendar}
          error={calendarError}
          favorites={favorites}
          onSelectDay={onSelectCalendarDay}
          onChangeScheduleMode={onChangeCalendarScheduleMode}
          onRefresh={onRefreshCalendar}
          onOpenItem={onOpenItem}
          onToggleFavorite={onToggleFavorite}
        />
      ) : activeSection === 'library' ? (
        /* Library View (Notifications, Favorites, Watch History) */
        <div className="space-y-10">
          {(() => {
            const unreadAlertsCount = alerts.filter((a) => !a.read).length;
            const readAlertsCount = alerts.length - unreadAlertsCount;
            const visibleAlerts = filterFavoriteAlerts(alerts, libraryAlertFilter);
            return (
              <section>
                <div className="mb-4 flex flex-wrap items-start justify-between gap-3 border-b border-white/10 pb-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <Bell className="h-4 w-4 text-[#f97316]" />
                      <h1 className="text-xl font-bold text-white">Notificações dos Favoritos</h1>
                      {unreadAlertsCount > 0 && (
                        <span className="text-xs font-semibold tabular-nums text-[#fb923c]">
                          · {unreadAlertsCount} nova{unreadAlertsCount === 1 ? '' : 's'}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs tabular-nums text-slate-400">
                      Última verificação: {formatRelativeTimestamp(lastEpisodeCheckAt)}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {notificationPermission !== 'unsupported' &&
                      notificationPermission === 'default' && (
                        <button
                          type="button"
                          onClick={onRequestPushNotifications}
                          className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-[#f97316]/40 bg-[#f97316]/12 px-3 py-1.5 text-xs font-medium text-[#fb923c] hover:bg-[#f97316]/20"
                        >
                          <Bell className="h-3.5 w-3.5" />
                          <span>Ativar alertas no aparelho</span>
                        </button>
                      )}

                    {notificationPermission === 'granted' && (
                      <button
                        type="button"
                        onClick={onSendTestNotification}
                        className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-white/12 bg-[#151921] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-[#f97316]/60 hover:text-white"
                      >
                        <Bell className="h-3.5 w-3.5 text-emerald-400" />
                        <span>Testar alerta</span>
                      </button>
                    )}

                    {notificationPermission === 'denied' && (
                      <span className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-white/10 bg-[#151921] px-3 py-1.5 text-xs text-slate-400">
                        <BellOff className="h-3.5 w-3.5 text-slate-500" />
                        <span>Alertas apenas no app</span>
                      </span>
                    )}

                    <button
                      type="button"
                      disabled={checkingAlerts || favorites.length === 0}
                      onClick={onCheckFavoriteUpdates}
                      className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-white/12 bg-[#151921] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-[#f97316]/60 disabled:opacity-50"
                    >
                      {checkingAlerts ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-[#f97316]" />
                      ) : (
                        <RefreshCw className="h-3.5 w-3.5 text-[#f97316]" />
                      )}
                      <span>{checkingAlerts ? 'Verificando...' : 'Verificar agora'}</span>
                    </button>

                    <button
                      type="button"
                      onClick={onOpenNotificationSettings}
                      className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-white/12 bg-[#151921] px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-[#f97316]/60 hover:text-white"
                    >
                      <SlidersHorizontal className="h-3.5 w-3.5 text-[#f97316]" />
                      <span>Configurar</span>
                    </button>
                  </div>
                </div>

                {alerts.length > 0 && (
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                    <div
                      role="tablist"
                      aria-label="Filtrar avisos dos favoritos"
                      className="inline-flex rounded-lg border border-white/10 bg-[#151921] p-1"
                    >
                      {(
                        [
                          { id: 'all', label: `Todas (${alerts.length})` },
                          { id: 'unread', label: `Não lidas (${unreadAlertsCount})` },
                        ] as const
                      ).map((tab) => (
                        <button
                          key={tab.id}
                          type="button"
                          role="tab"
                          aria-selected={libraryAlertFilter === tab.id}
                          onClick={() => setLibraryAlertFilter(tab.id)}
                          className={`min-h-[32px] whitespace-nowrap rounded-md px-3 py-1 text-xs font-medium tabular-nums transition-colors ${
                            libraryAlertFilter === tab.id
                              ? 'bg-[#f97316] text-[#0d0f12]'
                              : 'text-slate-300 hover:text-white'
                          }`}
                        >
                          {tab.label}
                        </button>
                      ))}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {unreadAlertsCount > 0 && (
                        <button
                          type="button"
                          onClick={onMarkAllAlertsRead}
                          className="inline-flex min-h-[34px] items-center gap-1.5 rounded-lg border border-white/12 bg-[#151921] px-3 py-1.5 text-xs font-medium text-emerald-300 hover:border-emerald-500/50"
                        >
                          <CheckCheck className="h-3.5 w-3.5" />
                          <span>Marcar todas como lidas</span>
                        </button>
                      )}
                      {readAlertsCount > 0 && (
                        <button
                          type="button"
                          onClick={onClearReadAlerts}
                          className="inline-flex min-h-[34px] items-center gap-1.5 rounded-lg border border-white/12 bg-[#151921] px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-rose-500/45 hover:text-rose-300"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          <span>Limpar lidas</span>
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {visibleAlerts.length === 0 ? (
                  <div className="rounded-xl border border-white/10 bg-[#151921] px-4 py-4 text-xs leading-relaxed text-slate-400">
                    {favorites.length === 0
                      ? 'Favorite qualquer título pelo coração nos cards ou na página de detalhes para receber avisos de novos episódios.'
                      : libraryAlertFilter === 'unread' && alerts.length > 0
                        ? 'Você já leu todas as notificações recentes.'
                        : 'Nenhum episódio novo detectado desde a última verificação.'}
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {visibleAlerts.slice(0, 30).map((alert) => {
                      const metaLine = [
                        alert.episodeLabel,
                        alert.audioType || null,
                        formatRelativeTimestamp(alert.detectedAt),
                      ]
                        .filter(Boolean)
                        .join(' · ');

                      return (
                        <div
                          key={alert.id}
                          className={`group flex items-start gap-3 rounded-xl border p-3 transition-colors hover:border-[#f97316]/60 ${
                            alert.read
                              ? 'border-white/10 bg-[#151921] opacity-80'
                              : 'border-[#f97316]/45 bg-[#f97316]/10'
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => onOpenAlert(alert)}
                            className="flex min-w-0 flex-1 items-start gap-3 text-left"
                          >
                            <MediaPoster
                              src={alert.poster}
                              alt={alert.animeTitle}
                              aspect="portrait"
                              className="h-16 w-12 shrink-0 rounded-lg border border-white/10"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <h3 className="truncate text-sm font-semibold text-white group-hover:text-[#fb923c]">
                                  {alert.animeTitle}
                                </h3>
                                {!alert.read && (
                                  <span className="shrink-0 text-[10px] font-semibold text-[#fb923c]">
                                    · Novo
                                  </span>
                                )}
                              </div>
                              <p className="mt-1 truncate text-xs font-medium tabular-nums text-slate-300">
                                {metaLine}
                              </p>
                              <span className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-semibold text-[#fb923c]">
                                <Play className="h-3 w-3 fill-current" />
                                <span>Assistir agora</span>
                              </span>
                            </div>
                          </button>

                          <div className="flex shrink-0 items-center gap-1">
                            {!alert.read && (
                              <button
                                type="button"
                                onClick={() => onMarkAlertRead(alert.id)}
                                aria-label={`Marcar ${alert.animeTitle} ${alert.episodeLabel} como lida`}
                                title="Marcar como lida"
                                className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-[#0d0f12] text-slate-300 transition-colors hover:border-emerald-500/50 hover:text-emerald-300"
                              >
                                <Check className="h-3.5 w-3.5" />
                              </button>
                            )}
                            {alert.animeUrl && (
                              <button
                                type="button"
                                onClick={() => onOpenItem(alert.animeUrl, 'anime')}
                                aria-label={`Abrir página de ${alert.animeTitle}`}
                                title="Abrir página do anime"
                                className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-[#0d0f12] text-slate-300 transition-colors hover:border-[#f97316]/50 hover:text-white"
                              >
                                <ExternalLink className="h-3.5 w-3.5" />
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => onDismissAlert(alert.id)}
                              aria-label={`Dispensar aviso de ${alert.animeTitle} ${alert.episodeLabel}`}
                              title="Dispensar aviso"
                              className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-[#0d0f12] text-slate-400 transition-colors hover:border-rose-500/50 hover:text-rose-300"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })()}

          <section>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-3">
              <div className="flex items-center gap-2">
                <Heart className="h-4 w-4 text-rose-400" />
                <h2 className="text-xl font-bold text-white">Meus Favoritos</h2>
              </div>
              {favorites.length > 0 && (
                <span className="text-xs text-slate-400">
                  Use o sininho no card para silenciar ou ativar avisos por anime
                </span>
              )}
            </div>

            {favorites.length === 0 ? (
              <div className="rounded-xl border border-white/10 bg-[#151921] p-8 text-center text-sm text-slate-400">
                Você ainda não favoritou nenhum título.
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                {favorites.map((fav) => renderCard(fav, 'portrait', undefined, undefined, true))}
              </div>
            )}
          </section>

          <section>
            <div className="mb-4 flex items-center justify-between border-b border-white/10 pb-3">
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-[#f97316]" />
                <h2 className="text-xl font-bold text-white">Histórico Recente</h2>
              </div>
              {history.length > 0 && (
                <button
                  type="button"
                  onClick={onClearHistory}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400 hover:text-rose-400"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>Limpar histórico</span>
                </button>
              )}
            </div>

            {history.length === 0 ? (
              <div className="rounded-xl border border-white/10 bg-[#151921] p-8 text-center">
                <p className="text-sm text-slate-400">
                  Os episódios e filmes que você abrir aparecerão aqui para retomar rapidamente.
                </p>
                <button
                  type="button"
                  onClick={() => onSelectSection('releases')}
                  className="mt-4 rounded-lg bg-[#f97316] px-4 py-2 text-xs font-semibold text-[#0d0f12]"
                >
                  Explorar início
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {history.map((entry) => {
                  const pos = entry.positionSec ?? 0;
                  const dur = entry.durationSec ?? 0;
                  const completed =
                    Boolean(entry.completed) ||
                    (dur > 0 && isEpisodeCompleted(pos, dur, false));
                  const hasIncompleteResume = !completed && pos >= 2;
                  const progressLabel = completed
                    ? 'Assistido'
                    : hasIncompleteResume
                      ? `Continuar em ${formatPlaybackTimestamp(pos)}`
                      : undefined;
                  const progressPct =
                    hasIncompleteResume && dur > 0 ? Math.min(99, (pos / dur) * 100) : undefined;
                  return renderCard(
                    {
                      id: entry.url,
                      title: entry.title,
                      url: entry.url,
                      kind: entry.kind,
                      poster: entry.poster,
                      audioType: null,
                    },
                    'landscape',
                    { label: progressLabel, pct: progressPct },
                    {
                      menuKey: `hist-${entry.url}`,
                      entry,
                      animeEpisodeCount: countAnimeEpisodesInHistory(history, entry),
                      animeName: getHistoryEntrySeriesName(entry),
                    }
                  );
                })}
              </div>
            )}
          </section>
        </div>
      ) : loading && !catalog ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="aspect-video animate-pulse rounded-xl border border-white/8 bg-[#151921]"
            />
          ))}
        </div>
      ) : error && !catalog ? (
        <div className="rounded-xl border border-red-500/20 bg-[#151921] p-8 text-center">
          <p className="text-sm text-red-200">{error}</p>
          <button
            type="button"
            onClick={onRetryCatalog}
            className="mt-4 inline-flex items-center gap-2 rounded-lg bg-[#f97316] px-4 py-2 text-xs font-semibold text-[#0d0f12]"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>Tentar novamente</span>
          </button>
        </div>
      ) : catalog ? (
        <>
          {/* Home View: Available on Active Servers (like main branch, neatly organized) */}
          {activeSection === 'releases' && (
            <div className="space-y-10">
              {/* Continue Watching Strip */}
              {continueWatchingItems.length > 0 && (
                <section>
                  <div className="mb-4 flex items-center justify-between gap-2 border-b border-white/10 pb-2.5">
                    <div className="flex items-center gap-2">
                      <Clock className="h-4 w-4 text-[#f97316]" />
                      <h2 className="text-base font-bold text-white">Continuar Assistindo</h2>
                    </div>
                    <button
                      type="button"
                      onClick={() => onSelectSection('library')}
                      className="inline-flex items-center gap-1 text-xs font-medium text-[#fb923c] hover:underline"
                    >
                      <span>Ver histórico</span>
                      <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    {continueWatchingItems.map((entry) => {
                      const pos = entry.positionSec ?? 0;
                      const dur = entry.durationSec ?? 0;
                      const pct = dur > 0 ? Math.min(99, (pos / dur) * 100) : 15;
                      return renderCard(
                        {
                          id: `cw-${entry.url}`,
                          title: entry.title,
                          url: entry.url,
                          kind: entry.kind,
                          poster: entry.poster,
                          audioType: null,
                        },
                        'landscape',
                        { label: `Parou em ${formatPlaybackTimestamp(pos)}`, pct },
                        {
                          menuKey: `cw-${entry.url}`,
                          entry,
                          animeEpisodeCount: countAnimeEpisodesInHistory(history, entry),
                          animeName: getHistoryEntrySeriesName(entry),
                        }
                      );
                    })}
                  </div>
                </section>
              )}

              {/* New Episode Releases from Active Servers */}
              <section>
                <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-3">
                  <div>
                    <h1 className="text-xl font-bold text-white">Novos Lançamentos</h1>
                    <p className="mt-0.5 text-xs text-slate-400">
                      Episódios disponíveis nos servidores — toque para assistir direto no player
                    </p>
                  </div>

                  <div className="flex items-center gap-1.5">
                    {(['ALL', 'DUB', 'LEG'] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setAudioFilter(mode)}
                        className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                          audioFilter === mode
                            ? 'border-[#f97316] bg-[#f97316]/15 text-white'
                            : 'border-white/10 bg-[#151921] text-slate-400 hover:text-white'
                        }`}
                      >
                        {mode === 'ALL'
                          ? 'Todos'
                          : mode === 'DUB'
                            ? 'Dublados'
                            : 'Legendados'}
                      </button>
                    ))}
                  </div>
                </div>

                {filterByAudio(releases).length === 0 ? (
                  <div className="rounded-xl border border-white/10 bg-[#151921] p-8 text-center text-sm text-slate-400">
                    Nenhum episódio encontrado para o filtro selecionado.
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    {filterByAudio(releases).map((item) => renderCard(item, 'landscape'))}
                  </div>
                )}

                {releasesPage < releasesTotalPages && (
                  <div className="mt-7 flex justify-center">
                    <button
                      type="button"
                      disabled={loadingMoreReleases}
                      onClick={onLoadMoreReleases}
                      className="inline-flex items-center gap-2 rounded-xl border border-white/12 bg-[#151921] px-5 py-2.5 text-sm font-medium text-white transition-colors hover:border-[#f97316]/60 disabled:opacity-50"
                    >
                      {loadingMoreReleases ? (
                        <Loader2 className="h-4 w-4 animate-spin text-[#f97316]" />
                      ) : (
                        <ChevronDown className="h-4 w-4 text-[#f97316]" />
                      )}
                      <span>
                        {loadingMoreReleases
                          ? 'Carregando episódios...'
                          : `Carregar mais lançamentos (página ${releasesPage + 1} de ${releasesTotalPages})`}
                      </span>
                    </button>
                  </div>
                )}
              </section>

              {/* Recent Animes Available on Servers */}
              {catalog.animes.length > 0 && (
                <section>
                  <div className="mb-4 flex items-center justify-between gap-2 border-b border-white/10 pb-2.5">
                    <div className="flex items-center gap-2">
                      <Tv className="h-4 w-4 text-[#f97316]" />
                      <h2 className="text-lg font-bold text-white">Animes Recentes</h2>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        onSelectArchiveCategory('animes');
                        onSelectSection('catalog');
                      }}
                      className="inline-flex items-center gap-1 text-xs font-medium text-[#fb923c] hover:underline"
                    >
                      <span>Ver catálogo</span>
                      <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                    {catalog.animes.slice(0, 10).map((item) => renderCard(item, 'portrait'))}
                  </div>
                </section>
              )}

              {/* Recent Movies Available on Servers */}
              {catalog.movies.length > 0 && (
                <section>
                  <div className="mb-4 flex items-center justify-between gap-2 border-b border-white/10 pb-2.5">
                    <div className="flex items-center gap-2">
                      <Film className="h-4 w-4 text-[#f97316]" />
                      <h2 className="text-lg font-bold text-white">Filmes Recentes</h2>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        onSelectArchiveCategory('movies');
                        onSelectSection('catalog');
                      }}
                      className="inline-flex items-center gap-1 text-xs font-medium text-[#fb923c] hover:underline"
                    >
                      <span>Ver filmes</span>
                      <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                    {catalog.movies.slice(0, 10).map((item) => renderCard(item, 'portrait'))}
                  </div>
                </section>
              )}

              {/* Server Series */}
              {catalog.series && catalog.series.length > 0 && (
                <section>
                  <div className="mb-4 flex items-center justify-between gap-2 border-b border-white/10 pb-2.5">
                    <div className="flex items-center gap-2">
                      <Tv className="h-4 w-4 text-emerald-400" />
                      <h2 className="text-lg font-bold text-white">Séries nos Servidores</h2>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        onSelectArchiveCategory('series');
                        onSelectSection('catalog');
                      }}
                      className="inline-flex items-center gap-1 text-xs font-medium text-[#fb923c] hover:underline"
                    >
                      <span>Ver séries</span>
                      <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                    {catalog.series.slice(0, 10).map((item) => renderCard(item, 'portrait'))}
                  </div>
                </section>
              )}
            </div>
          )}

          {/* Catalog View: Clean Server Archive (like main branch, uncluttered) */}
          {activeSection === 'catalog' && (
            <section className="space-y-7">
              <div className="rounded-xl border border-white/10 bg-[#151921] p-4 sm:p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h1 className="text-xl font-bold text-white">Catálogo</h1>
                    <p className="mt-0.5 text-xs tabular-nums text-slate-400">
                      {hasActiveFilter
                        ? `${
                            selectedGlossary
                              ? `Índice A–Z: ${selectedGlossary}`
                              : selectedGenre
                                ? `Gênero: ${activeGenreLabel || selectedGenre}`
                                : `Ano: ${selectedYear}`
                          } · ${displayedArchive.items.length} título(s)${
                            displayedArchive.totalPages > 1
                              ? ` · Página ${displayedArchive.currentPage} de ${displayedArchive.totalPages}`
                              : ''
                          }`
                        : displayedArchive.totalPages > 1
                          ? `Disponíveis nos servidores · Página ${displayedArchive.currentPage} de ${displayedArchive.totalPages}`
                          : 'Animes disponíveis nos servidores integrados'}
                    </p>
                  </div>

                  {/* Category Tabs */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    {archiveTabs.map((tab) => {
                      const active = !hasActiveFilter && archiveCategory === tab.id;
                      return (
                        <button
                          key={tab.id}
                          type="button"
                          onClick={() => onSelectArchiveCategory(tab.id)}
                          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                            active
                              ? 'border-[#f97316] bg-[#f97316]/15 text-white'
                              : 'border-white/10 bg-[#0d0f12] text-slate-400 hover:text-white'
                          }`}
                        >
                          {tab.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Compact Filter Row + Collapsible A-Z Index */}
                <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-white/8 pt-3.5">
                  {catalogFilters.genres.length > 0 && (
                    <select
                      aria-label="Filtrar por gênero"
                      value={selectedGenre}
                      onChange={(e) => onSelectGenre(e.target.value)}
                      className="rounded-lg border border-white/12 bg-[#0d0f12] px-3 py-1.5 text-xs font-medium text-slate-200 focus:border-[#f97316] focus:outline-none"
                    >
                      <option value="">Gênero</option>
                      {catalogFilters.genres.map((g) => (
                        <option key={g.slug} value={g.slug}>
                          {g.label}
                        </option>
                      ))}
                    </select>
                  )}

                  {catalogFilters.years.length > 0 && (
                    <select
                      aria-label="Filtrar por ano"
                      value={selectedYear}
                      onChange={(e) => onSelectYear(e.target.value)}
                      className="rounded-lg border border-white/12 bg-[#0d0f12] px-3 py-1.5 text-xs font-medium text-slate-200 focus:border-[#f97316] focus:outline-none"
                    >
                      <option value="">Ano</option>
                      {catalogFilters.years.map((y) => (
                        <option key={y.slug} value={y.slug}>
                          {y.label}
                        </option>
                      ))}
                    </select>
                  )}

                  <button
                    type="button"
                    onClick={() => setGlossaryExpanded((prev) => !prev)}
                    aria-expanded={glossaryExpanded}
                    className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                      glossaryExpanded || selectedGlossary
                        ? 'border-[#f97316]/50 bg-[#f97316]/12 text-[#fb923c]'
                        : 'border-white/12 bg-[#0d0f12] text-slate-300 hover:text-white'
                    }`}
                  >
                    <SlidersHorizontal className="h-3.5 w-3.5" />
                    <span>{selectedGlossary ? `Índice: ${selectedGlossary}` : 'Índice A–Z'}</span>
                  </button>

                  {hasActiveFilter && (
                    <button
                      type="button"
                      onClick={onClearCatalogFilters}
                      className="inline-flex items-center gap-1 rounded-lg border border-[#f97316]/40 bg-[#f97316]/12 px-3 py-1.5 text-xs font-medium text-[#fb923c] hover:bg-[#f97316]/20"
                    >
                      <X className="h-3.5 w-3.5" />
                      <span>Limpar filtros</span>
                    </button>
                  )}
                </div>

                {glossaryExpanded && (
                  <div
                    className="mt-3 flex flex-wrap items-center gap-1 border-t border-white/8 pt-3"
                    aria-label="Navegação alfabética A-Z"
                  >
                    {GLOSSARY_TERMS.map((letter) => {
                      const active = selectedGlossary === letter;
                      return (
                        <button
                          key={letter}
                          type="button"
                          onClick={() => onSelectGlossary(active ? '' : letter)}
                          aria-pressed={active}
                          className={`flex h-7 min-w-[28px] items-center justify-center rounded-md border px-1.5 text-xs font-semibold transition-colors ${
                            active
                              ? 'border-[#f97316] bg-[#f97316] text-[#0d0f12]'
                              : 'border-white/10 bg-[#0d0f12] text-slate-300 hover:border-[#f97316]/50 hover:text-white'
                          }`}
                        >
                          {letter}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Featured Animes Strip */}
              {!hasActiveFilter &&
                archiveCategory === 'animes' &&
                featuredAnimes.length > 0 && (
                  <div>
                    <div className="mb-3 flex items-center gap-2">
                      <Sparkles className="h-4 w-4 text-[#f97316]" />
                      <h2 className="text-base font-semibold text-white">Em Destaque</h2>
                    </div>
                    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                      {featuredAnimes.slice(0, 8).map((item) => renderCard(item, 'portrait'))}
                    </div>
                  </div>
                )}

              {/* Featured Movies Strip */}
              {!hasActiveFilter &&
                archiveCategory === 'movies' &&
                sliderMovies.length > 0 && (
                  <div>
                    <div className="mb-3 flex items-center gap-2">
                      <Film className="h-4 w-4 text-[#f97316]" />
                      <h2 className="text-base font-semibold text-white">Filmes em Destaque</h2>
                    </div>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                      {sliderMovies.slice(0, 6).map((movie) => {
                        const favItem: CatalogMediaItem = {
                          id: movie.id,
                          title: movie.title,
                          url: movie.url,
                          kind: 'movie',
                          poster: movie.backdrop,
                          audioType: null,
                          year: movie.year,
                        };
                        const favActive = isItemFavorited(movie.url, favorites);
                        return (
                          <div
                            key={movie.url}
                            className="group relative flex flex-col overflow-hidden rounded-xl border border-white/10 bg-[#151921] transition-colors hover:border-[#f97316]/60"
                          >
                            <button
                              type="button"
                              onClick={() => onOpenItem(movie.url, 'movie')}
                              className="flex flex-1 flex-col text-left"
                            >
                              <MediaPoster
                                src={movie.backdrop}
                                alt={movie.title}
                                aspect="landscape"
                                className="w-full border-b border-white/8"
                              />
                              <div className="p-3">
                                <h3 className="line-clamp-1 text-sm font-semibold text-white group-hover:text-[#fb923c]">
                                  {movie.title}
                                </h3>
                                {movie.year && (
                                  <p className="mt-0.5 text-xs tabular-nums text-slate-400">
                                    {movie.year}
                                  </p>
                                )}
                              </div>
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onToggleFavorite(favItem);
                              }}
                              aria-pressed={favActive}
                              aria-label={
                                favActive
                                  ? `Remover ${movie.title} dos favoritos`
                                  : `Favoritar ${movie.title}`
                              }
                              className={`absolute right-2 top-2 z-10 flex h-8 w-8 items-center justify-center rounded-full border backdrop-blur-md transition-colors ${
                                favActive
                                  ? 'border-rose-500/60 bg-rose-500/85 text-white'
                                  : 'border-white/15 bg-[#0d0f12]/75 text-slate-200 hover:border-rose-400/70 hover:text-rose-300'
                              }`}
                            >
                              <Heart className={`h-3.5 w-3.5 ${favActive ? 'fill-white' : ''}`} />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

              {displayedArchive.loading && displayedArchive.items.length === 0 ? (
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                  {Array.from({ length: 10 }).map((_, i) => (
                    <div
                      key={i}
                      className="aspect-[2/3] animate-pulse rounded-xl border border-white/8 bg-[#151921]"
                    />
                  ))}
                </div>
              ) : displayedArchive.items.length === 0 ? (
                <div className="rounded-xl border border-white/10 bg-[#151921] p-10 text-center text-sm text-slate-400">
                  Nenhum título encontrado para os filtros selecionados.
                </div>
              ) : (
                <div>
                  <h2 className="mb-3.5 text-base font-semibold text-white">
                    {hasActiveFilter
                      ? selectedGlossary
                        ? `Títulos com "${selectedGlossary}"`
                        : selectedGenre
                          ? `Gênero: ${activeGenreLabel || selectedGenre}`
                          : `Lançamentos de ${selectedYear}`
                      : archiveTabs.find((t) => t.id === archiveCategory)?.label || 'Catálogo'}
                  </h2>
                  <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                    {displayedArchive.items.map((item) => renderCard(item, 'portrait'))}
                  </div>

                  {displayedArchive.currentPage < displayedArchive.totalPages && (
                    <div className="mt-7 flex justify-center">
                      <button
                        type="button"
                        disabled={displayedArchive.loading}
                        onClick={() =>
                          hasActiveFilter
                            ? onLoadMoreFiltered()
                            : onLoadMoreArchiveCategory(archiveCategory)
                        }
                        className="inline-flex items-center gap-2 rounded-xl border border-white/12 bg-[#151921] px-5 py-2.5 text-sm font-medium text-white transition-colors hover:border-[#f97316]/60 disabled:opacity-50"
                      >
                        {displayedArchive.loading ? (
                          <Loader2 className="h-4 w-4 animate-spin text-[#f97316]" />
                        ) : (
                          <ChevronDown className="h-4 w-4 text-[#f97316]" />
                        )}
                        <span>
                          {displayedArchive.loading
                            ? 'Carregando títulos...'
                            : `Carregar mais (página ${displayedArchive.currentPage + 1} de ${displayedArchive.totalPages})`}
                        </span>
                      </button>
                    </div>
                  )}
                </div>
              )}
            </section>
          )}
        </>
      ) : null}
    </div>
  );
}
