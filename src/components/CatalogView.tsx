import { useEffect, useRef, useState, type FormEvent } from 'react';
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
  CheckCheck,
  Play,
  Shuffle,
  Sparkles,
  Film,
  Calendar,
  Star,
} from 'lucide-react';
import { apiFetch } from '../lib/apiClient';
import { isItemFavorited } from '../lib/favoriteAlerts';
import {
  canonicalEpisodeProgressKey,
  formatPlaybackTimestamp,
  isEpisodeCompleted,
} from '../lib/playbackProgress';
import type {
  AudioType,
  CalendarDaySection,
  CatalogArchiveCategory,
  CatalogFilters,
  CatalogMediaItem,
  FavoriteAlertEntry,
  HomeCatalog,
  MediaKind,
  SearchResultItem,
  SearchSuggestResponse,
  SliderMovieItem,
  WatchHistoryEntry,
} from '../lib/types';
import type { NavSection } from './Header';
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
  loadingWeeklyCalendar: boolean;
  favorites: CatalogMediaItem[];
  history: WatchHistoryEntry[];
  alerts: FavoriteAlertEntry[];
  checkingAlerts: boolean;
  notificationPermission: NotificationPermission | 'unsupported';
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
  onOpenItem: (url: string, kind: MediaKind) => void;
  onToggleFavorite: (item: CatalogMediaItem) => void;
  onCheckFavoriteUpdates: () => void;
  onMarkAllAlertsRead: () => void;
  onOpenAlert: (alert: FavoriteAlertEntry) => void;
  onRequestPushNotifications: () => void;
  onClearHistory: () => void;
  onSelectSection: (section: NavSection) => void;
  defaultAudioFilter: 'ALL' | 'DUB' | 'LEG';
  watchedEpisodeKeys?: Set<string>;
}

const ARCHIVE_TABS: Array<{ id: CatalogArchiveCategory; label: string }> = [
  { id: 'animes', label: 'Animes' },
  { id: 'movies', label: 'Filmes' },
  { id: 'dublado', label: 'Dublados' },
  { id: 'legendado', label: 'Legendados' },
  { id: 'donghua', label: 'Donghua' },
  { id: 'cartoon', label: 'Cartoon' },
  { id: 'live-action', label: 'Live Action' },
];

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
  loadingWeeklyCalendar,
  favorites,
  history,
  alerts,
  checkingAlerts,
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
  onOpenItem,
  onToggleFavorite,
  onCheckFavoriteUpdates,
  onMarkAllAlertsRead,
  onOpenAlert,
  onRequestPushNotifications,
  onClearHistory,
  onSelectSection,
  defaultAudioFilter,
  watchedEpisodeKeys,
}: CatalogViewProps) {
  const [searchInput, setSearchInput] = useState(searchQuery);
  const [audioFilter, setAudioFilter] = useState<'ALL' | 'DUB' | 'LEG'>(defaultAudioFilter);
  const [suggestions, setSuggestions] = useState<SearchResultItem[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const searchBoxRef = useRef<HTMLDivElement>(null);
  const suggestReqGenRef = useRef(0);

  useEffect(() => {
    setAudioFilter(defaultAudioFilter);
  }, [defaultAudioFilter]);

  useEffect(() => {
    setSearchInput(searchQuery);
  }, [searchQuery]);

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
    }, 300);

    return () => window.clearTimeout(timer);
  }, [searchInput, suggestOpen]);

  const handleSearchSubmit = (e: FormEvent) => {
    e.preventDefault();
    setSuggestOpen(false);
    onSearch(searchInput.trim());
  };

  const filterByAudio = (items: CatalogMediaItem[]) => {
    if (audioFilter === 'ALL') return items;
    return items.filter((item) => {
      const effective: AudioType = item.audioType;
      return effective === audioFilter;
    });
  };

  const renderCard = (
    item: CatalogMediaItem,
    aspect: 'portrait' | 'landscape',
    progressMeta?: { label?: string; pct?: number }
  ) => {
    const metaParts: string[] = [];
    if (progressMeta?.label) {
      metaParts.push(progressMeta.label);
    } else if (
      item.kind === 'episode' &&
      watchedEpisodeKeys?.has(canonicalEpisodeProgressKey(item.url))
    ) {
      metaParts.push('Visto');
    }
    if (item.episodeLabel) metaParts.push(item.episodeLabel);
    if (item.audioType === 'DUB') metaParts.push('Dublado');
    else if (item.audioType === 'LEG') metaParts.push('Legendado');
    if (item.quality) metaParts.push(item.quality);
    if (item.year) metaParts.push(item.year);
    if (item.rating && Number.parseFloat(item.rating) > 0) metaParts.push(`★ ${item.rating}`);
    if (item.statusBadge) metaParts.push(item.statusBadge);
    else if (item.isHiatus) metaParts.push('Hiato');

    const favActive = isItemFavorited(item.url, favorites);

    return (
      <div
        key={item.url}
        className="group relative flex flex-col overflow-hidden rounded-xl border border-white/10 bg-[#151921] transition-colors hover:border-[#f97316]/60"
      >
        <button
          type="button"
          onClick={() => onOpenItem(item.url, item.kind)}
          className="flex flex-1 flex-col text-left"
        >
          <div className="relative w-full border-b border-white/8">
            <MediaPoster
              src={item.poster}
              alt={item.title}
              aspect={aspect}
              className="w-full"
            />
            {typeof progressMeta?.pct === 'number' && progressMeta.pct > 0 && (
              <div className="absolute inset-x-0 bottom-0 h-1 bg-black/60">
                <div
                  className="h-full bg-[#f97316]"
                  style={{ width: `${Math.min(100, Math.max(4, progressMeta.pct))}%` }}
                />
              </div>
            )}
          </div>
          <div className="flex flex-1 flex-col justify-between p-3.5">
            <h3 className="line-clamp-2 text-sm font-semibold leading-snug text-white group-hover:text-[#f97316]">
              {item.title}
            </h3>
            {metaParts.length > 0 && (
              <p className="mt-1.5 truncate text-xs tabular-nums text-slate-400">
                {metaParts.join(' · ')}
              </p>
            )}
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
          <Heart className={`h-4 w-4 ${favActive ? 'fill-white' : ''}`} />
        </button>
      </div>
    );
  };

  const hasActiveFilter = Boolean(selectedGenre || selectedYear || selectedGlossary);
  const displayedArchive = hasActiveFilter
    ? filteredCatalog
    : archiveState[archiveCategory];
  const activeGenreLabel = catalogFilters.genres.find((g) => g.slug === selectedGenre)?.label;

  const effectiveCalendarDays: CalendarDaySection[] =
    weeklyCalendarDays.length > 0
      ? weeklyCalendarDays
      : catalog
        ? [{ id: 'hoje', label: 'Hoje', isToday: true, items: catalog.calendar }]
        : [];
  const activeCalendarDay =
    effectiveCalendarDays.find((d) => d.id === selectedCalendarDay) ||
    effectiveCalendarDays[0] ||
    null;

  const showSuggestDropdown =
    suggestOpen && searchInput.trim().length >= 2 && (loadingSuggestions || suggestions.length > 0);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
      {/* Control Strip: Search & Random Discovery */}
      <section className="mb-7 rounded-xl border border-white/10 bg-[#151921] p-4 sm:p-5">
        <form onSubmit={handleSearchSubmit} className="flex flex-col gap-2">
          <label
            htmlFor="catalog-search-input"
            className="text-xs font-medium text-slate-400"
          >
            Buscar anime, episódio ou filme
          </label>
          <div className="flex flex-wrap gap-2 sm:flex-nowrap">
            <div ref={searchBoxRef} className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <input
                id="catalog-search-input"
                type="text"
                autoComplete="off"
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
                placeholder="Ex: Kusuriya, Frieren, Naruto, Dublado..."
                className="w-full rounded-lg border border-white/12 bg-[#0d0f12] py-2.5 pl-9 pr-9 text-sm text-white placeholder:text-slate-500 focus:border-[#f97316] focus:outline-none"
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
                      <span>Buscando sugestões...</span>
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
                              <span>{item.kind === 'movie' ? 'Filme' : 'Anime'}</span>
                              {item.audioType && (
                                <span
                                  className={
                                    item.audioType === 'DUB'
                                      ? 'text-emerald-400'
                                      : 'text-rose-400'
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
                className="flex-1 shrink-0 rounded-lg bg-[#f97316] px-5 py-2.5 text-sm font-semibold text-[#0d0f12] transition-colors hover:bg-[#fb923c] sm:flex-initial"
              >
                Buscar
              </button>
              <button
                type="button"
                disabled={loadingRandom}
                onClick={onOpenRandom}
                aria-label="Abrir anime aleatório"
                className="inline-flex flex-1 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-white/12 bg-[#0d0f12] px-3.5 py-2.5 text-sm font-medium text-slate-200 transition-colors hover:border-[#f97316]/60 hover:text-white disabled:opacity-50 sm:flex-initial"
              >
                {loadingRandom ? (
                  <Loader2 className="h-4 w-4 animate-spin text-[#f97316]" />
                ) : (
                  <Shuffle className="h-4 w-4 text-[#f97316]" />
                )}
                <span>Aleatório</span>
              </button>
            </div>
          </div>
        </form>
      </section>

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
                  ? 'Consultando catálogo...'
                  : `${searchResults.length} resultado(s) exibido(s)${
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
              Voltar ao catálogo
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
                Nenhum título encontrado para &ldquo;{searchQuery}&rdquo;.
              </p>
              <button
                type="button"
                onClick={() => {
                  setSearchInput('');
                  onClearSearch();
                }}
                className="mt-4 rounded-lg bg-[#f97316] px-4 py-2 text-xs font-semibold text-[#0d0f12]"
              >
                Ver lançamentos recentes
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
      ) : activeSection === 'library' ? (
        /* Library View (New Episode Alerts, History & Favorites) */
        <div className="space-y-10">
          <section>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-3">
              <div className="flex items-center gap-2">
                <Bell className="h-4 w-4 text-[#f97316]" />
                <h1 className="text-xl font-bold text-white">
                  Notificações dos Favoritos
                </h1>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {notificationPermission !== 'unsupported' &&
                  notificationPermission === 'default' && (
                    <button
                      type="button"
                      onClick={onRequestPushNotifications}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-[#f97316]/40 bg-[#f97316]/12 px-3 py-1.5 text-xs font-medium text-[#fb923c] hover:bg-[#f97316]/20"
                    >
                      <Bell className="h-3.5 w-3.5" />
                      <span>Ativar alertas no celular</span>
                    </button>
                  )}

                {notificationPermission === 'denied' && (
                  <span className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#151921] px-3 py-1.5 text-xs text-slate-400">
                    <Bell className="h-3.5 w-3.5 text-slate-500" />
                    <span>Alertas apenas no app (bloqueado no navegador)</span>
                  </span>
                )}

                <button
                  type="button"
                  disabled={checkingAlerts || favorites.length === 0}
                  onClick={onCheckFavoriteUpdates}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/12 bg-[#151921] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-[#f97316]/60 disabled:opacity-50"
                >
                  {checkingAlerts ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-[#f97316]" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5 text-[#f97316]" />
                  )}
                  <span>
                    {checkingAlerts ? 'Verificando...' : 'Verificar novos episódios'}
                  </span>
                </button>

                {alerts.some((a) => !a.read) && (
                  <button
                    type="button"
                    onClick={onMarkAllAlertsRead}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-white/12 bg-[#151921] px-3 py-1.5 text-xs font-medium text-slate-300 hover:text-white"
                  >
                    <CheckCheck className="h-3.5 w-3.5 text-emerald-400" />
                    <span>Marcar tudo como lido</span>
                  </button>
                )}
              </div>
            </div>

            {alerts.length === 0 ? (
              <div className="rounded-xl border border-white/10 bg-[#151921] px-4 py-3.5 text-xs leading-relaxed text-slate-400">
                {favorites.length === 0
                  ? 'Favorite qualquer anime pelo coração nos cards ou pelo botão Favoritar na página do anime para receber avisos quando sair episódio novo.'
                  : 'Nenhum episódio novo detectado desde a última verificação.'}
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {alerts.slice(0, 9).map((alert) => (
                  <button
                    key={alert.id}
                    type="button"
                    onClick={() => onOpenAlert(alert)}
                    className={`flex items-center gap-3.5 rounded-xl border p-3 text-left transition-colors hover:border-[#f97316]/60 ${
                      alert.read
                        ? 'border-white/10 bg-[#151921] opacity-80'
                        : 'border-[#f97316]/45 bg-[#f97316]/10'
                    }`}
                  >
                    <MediaPoster
                      src={alert.poster}
                      alt={alert.animeTitle}
                      aspect="portrait"
                      className="h-16 w-12 shrink-0 rounded-lg border border-white/10"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        {!alert.read && (
                          <span className="h-2 w-2 shrink-0 rounded-full bg-[#f97316]" />
                        )}
                        <h3 className="truncate text-sm font-semibold text-white">
                          {alert.animeTitle}
                        </h3>
                      </div>
                      <p className="mt-1 text-xs font-medium text-[#fb923c]">
                        {alert.episodeLabel} disponível
                      </p>
                      <span className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-slate-300">
                        <Play className="h-3 w-3 text-[#f97316]" />
                        Assistir agora
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section>
            <div className="mb-4 flex items-center gap-2 border-b border-white/10 pb-3">
              <Heart className="h-4 w-4 text-rose-400" />
              <h2 className="text-xl font-bold text-white">Meus Favoritos</h2>
            </div>

            {favorites.length === 0 ? (
              <div className="rounded-xl border border-white/10 bg-[#151921] p-8 text-center text-sm text-slate-400">
                Você ainda não favoritou nenhum anime ou filme. Use o botão de coração nos cards ou o botão Favoritar na página do anime.
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                {favorites.map((fav) => renderCard(fav, 'portrait'))}
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
                  Explorar lançamentos
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
                    { label: progressLabel, pct: progressPct }
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
          {activeSection === 'releases' && (
            <section>
              <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-3">
                <div>
                  <h1 className="text-xl font-bold text-white">
                    Novos Lançamentos
                  </h1>
                  <p className="mt-0.5 text-xs text-slate-400">
                    Toque em qualquer episódio para assistir direto no player próprio
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

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {filterByAudio(releases).map((item) =>
                  renderCard(item, 'landscape')
                )}
              </div>

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
          )}

          {activeSection === 'calendar' && (
            <section>
              <div className="mb-5 space-y-4 border-b border-white/10 pb-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <Calendar className="h-4 w-4 text-[#f97316]" />
                      <h1 className="text-xl font-bold text-white">
                        Calendário Semanal
                      </h1>
                    </div>
                    <p className="mt-0.5 text-xs text-slate-400">
                      Séries em exibição semanal — filtre por dia da semana e abra para escolher o episódio
                    </p>
                  </div>

                  {loadingWeeklyCalendar && (
                    <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-[#f97316]" />
                      <span>Atualizando semana...</span>
                    </span>
                  )}
                </div>

                {effectiveCalendarDays.length > 1 && (
                  <div
                    role="tablist"
                    aria-label="Dias da semana"
                    className="flex flex-wrap items-center gap-1.5"
                  >
                    {effectiveCalendarDays.map((day) => {
                      const active = activeCalendarDay?.id === day.id;
                      return (
                        <button
                          key={day.id}
                          type="button"
                          role="tab"
                          aria-selected={active}
                          onClick={() => onSelectCalendarDay(day.id)}
                          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                            active
                              ? 'border-[#f97316] bg-[#f97316]/15 text-white'
                              : 'border-white/10 bg-[#151921] text-slate-400 hover:text-white'
                          }`}
                        >
                          {day.label}
                          <span className="ml-1.5 tabular-nums opacity-75">
                            ({day.items.length})
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {loadingWeeklyCalendar && !activeCalendarDay ? (
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                  {Array.from({ length: 10 }).map((_, i) => (
                    <div
                      key={i}
                      className="aspect-[2/3] animate-pulse rounded-xl border border-white/8 bg-[#151921]"
                    />
                  ))}
                </div>
              ) : !activeCalendarDay || activeCalendarDay.items.length === 0 ? (
                <div className="rounded-xl border border-white/10 bg-[#151921] p-10 text-center text-sm text-slate-400">
                  Nenhum anime listado para este dia no momento.
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                  {activeCalendarDay.items.map((item) => renderCard(item, 'portrait'))}
                </div>
              )}
            </section>
          )}

          {activeSection === 'catalog' && (
            <section className="space-y-8">
              <div className="space-y-4 border-b border-white/10 pb-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h1 className="text-xl font-bold text-white">Animes &amp; Filmes</h1>
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
                          ? `Exibindo ${displayedArchive.items.length} título(s) · Página ${displayedArchive.currentPage} de ${displayedArchive.totalPages}`
                          : 'Navegue por categoria, gênero, ano ou índice alfabético A–Z'}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    {ARCHIVE_TABS.map((tab) => {
                      const active = !hasActiveFilter && archiveCategory === tab.id;
                      const count = archiveState[tab.id].items.length;
                      return (
                        <button
                          key={tab.id}
                          type="button"
                          onClick={() => onSelectArchiveCategory(tab.id)}
                          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                            active
                              ? 'border-[#f97316] bg-[#f97316]/15 text-white'
                              : 'border-white/10 bg-[#151921] text-slate-400 hover:text-white'
                          }`}
                        >
                          {tab.label}
                          {count > 0 ? ` (${count})` : ''}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Genre & Year Filter Bar */}
                {(catalogFilters.genres.length > 0 || catalogFilters.years.length > 0 || hasActiveFilter) && (
                  <div className="flex flex-wrap items-center gap-2.5">
                    {catalogFilters.genres.length > 0 && (
                      <select
                        aria-label="Filtrar por gênero"
                        value={selectedGenre}
                        onChange={(e) => onSelectGenre(e.target.value)}
                        className="rounded-lg border border-white/12 bg-[#151921] px-3 py-2 text-xs font-medium text-slate-200 focus:border-[#f97316] focus:outline-none"
                      >
                        <option value="">Por Gênero</option>
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
                        className="rounded-lg border border-white/12 bg-[#151921] px-3 py-2 text-xs font-medium text-slate-200 focus:border-[#f97316] focus:outline-none"
                      >
                        <option value="">Por Ano</option>
                        {catalogFilters.years.map((y) => (
                          <option key={y.slug} value={y.slug}>
                            {y.label}
                          </option>
                        ))}
                      </select>
                    )}

                    {hasActiveFilter && (
                      <button
                        type="button"
                        onClick={onClearCatalogFilters}
                        className="inline-flex items-center gap-1 rounded-lg border border-[#f97316]/40 bg-[#f97316]/12 px-3 py-2 text-xs font-medium text-[#fb923c] hover:bg-[#f97316]/20"
                      >
                        <X className="h-3.5 w-3.5" />
                        <span>Limpar filtros</span>
                      </button>
                    )}
                  </div>
                )}

                {/* Alphabetical A-Z Glossary Strip */}
                <div className="flex flex-wrap items-center gap-1" aria-label="Navegação alfabética A-Z">
                  <span className="mr-1 text-[11px] font-medium text-slate-400">A–Z:</span>
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
                            : 'border-white/10 bg-[#151921] text-slate-300 hover:border-[#f97316]/50 hover:text-white'
                        }`}
                      >
                        {letter}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Em Destaque Strip on Animes Tab */}
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

              {/* Filmes em Destaque Widescreen Slider Cards on Filmes Tab */}
              {!hasActiveFilter &&
                archiveCategory === 'movies' &&
                sliderMovies.length > 0 && (
                  <div>
                    <div className="mb-3 flex items-center gap-2">
                      <Film className="h-4 w-4 text-[#f97316]" />
                      <h2 className="text-base font-semibold text-white">Filmes em Destaque</h2>
                    </div>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
                      {sliderMovies.slice(0, 5).map((movie) => {
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
                                <h3 className="line-clamp-1 text-sm font-semibold text-white group-hover:text-[#f97316]">
                                  {movie.title}
                                </h3>
                                {movie.year && (
                                  <p className="mt-1 text-xs tabular-nums text-slate-400">
                                    {movie.year} · Filme
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
                              <Heart className={`h-4 w-4 ${favActive ? 'fill-white' : ''}`} />
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
                  <h2 className="mb-3 text-base font-semibold text-white">
                    {hasActiveFilter
                      ? selectedGlossary
                        ? `Títulos com "${selectedGlossary}"`
                        : selectedGenre
                          ? `Animes de ${activeGenreLabel || selectedGenre}`
                          : `Lançamentos de ${selectedYear}`
                      : archiveCategory === 'movies'
                        ? 'Catálogo de Filmes'
                        : 'Adicionado recentemente'}
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
