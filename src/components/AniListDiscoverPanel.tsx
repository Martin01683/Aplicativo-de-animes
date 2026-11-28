import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  Heart,
  Loader2,
  RefreshCw,
  Star,
  X,
} from 'lucide-react';
import {
  ANILIST_AUDIO_FILTERS,
  ANILIST_COUNTRIES,
  ANILIST_FORMATS,
  ANILIST_GENRES,
  ANILIST_POPULAR_TAGS,
  ANILIST_SEASONS,
  ANILIST_SORT_OPTIONS,
  ANILIST_STATUSES,
  DEFAULT_ANILIST_MIN_TAG_RANK,
  formatAniListTagLabel,
} from '../lib/catalog/providers/anilistProvider';
import { isItemFavorited } from '../lib/favoriteAlerts';
import {
  fetchDiscoverCatalogCached,
  fetchDiscoverTaxonomyCached,
  type MediaNavigationSeed,
} from '../lib/prefetchCache';
import type {
  AniListCountry,
  AniListDiscoverFilters,
  AniListFormat,
  AniListSeason,
  AniListSortOption,
  AniListStatus,
  AniListTagItem,
  CatalogMediaItem,
  DiscoverAudioFilter,
  MediaKind,
} from '../lib/types';
import { AniListTagPicker } from './AniListTagPicker';
import { MediaPoster } from './MediaPoster';

interface AniListDiscoverPanelProps {
  active: boolean;
  isHidden?: boolean;
  favorites: CatalogMediaItem[];
  onOpenItem: (url: string, kind: MediaKind, seed?: MediaNavigationSeed) => void;
  onPrefetchItem?: (url: string, kind: MediaKind, seed?: MediaNavigationSeed) => void;
  onToggleFavorite: (item: CatalogMediaItem) => void;
}

const CURRENT_YEAR = new Date().getFullYear();
const YEAR_OPTIONS: string[] = Array.from(
  { length: CURRENT_YEAR + 1 - 1990 + 1 },
  (_, i) => String(CURRENT_YEAR + 1 - i)
);

const INITIAL_FALLBACK_TAGS: AniListTagItem[] = ANILIST_POPULAR_TAGS.map((t) => ({
  name: t.value,
  label: formatAniListTagLabel(t.value),
  category: 'Popular',
}));

function buildSeedFromDiscoverItem(item: CatalogMediaItem): MediaNavigationSeed {
  return {
    title: item.title,
    poster: item.poster,
    kind: item.kind,
    audioType: item.audioType,
    year: item.year,
    rating: item.rating,
    genres: item.genres,
    catalogSource: item.catalogSource,
    sourceServerName: item.sourceServerName,
    externalIds: item.externalIds,
    isMovie: item.kind === 'movie',
  };
}

export function AniListDiscoverPanel({
  active,
  isHidden = false,
  favorites,
  onOpenItem,
  onPrefetchItem,
  onToggleFavorite,
}: AniListDiscoverPanelProps) {
  const [sort, setSort] = useState<AniListSortOption>('TRENDING_DESC');
  const [selectedGenres, setSelectedGenres] = useState<string[]>([]);
  const [excludedGenres, setExcludedGenres] = useState<string[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [excludedTags, setExcludedTags] = useState<string[]>([]);
  const [minimumTagRank, setMinimumTagRank] = useState<number>(DEFAULT_ANILIST_MIN_TAG_RANK);
  const [debouncedMinTagRank, setDebouncedMinTagRank] = useState<number>(
    DEFAULT_ANILIST_MIN_TAG_RANK
  );
  const [season, setSeason] = useState<AniListSeason | ''>('');
  const [year, setYear] = useState('');
  const [format, setFormat] = useState<AniListFormat | ''>('');
  const [status, setStatus] = useState<AniListStatus | ''>('');
  const [country, setCountry] = useState<AniListCountry | ''>('');
  const [audio, setAudio] = useState<DiscoverAudioFilter>('ALL');
  const [onlyAvailable, setOnlyAvailable] = useState(true);

  const [taxonomyGenres, setTaxonomyGenres] = useState<Array<{ value: string; label: string }>>(
    () => [...ANILIST_GENRES]
  );
  const [taxonomyTags, setTaxonomyTags] = useState<AniListTagItem[]>(INITIAL_FALLBACK_TAGS);
  const [loadingTaxonomy, setLoadingTaxonomy] = useState(false);
  const taxonomyLoadedRef = useRef(false);

  const [items, setItems] = useState<CatalogMediaItem[]>([]);
  const [nextPage, setNextPage] = useState<number | null>(null);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [indexedTitlesCount, setIndexedTitlesCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [initialized, setInitialized] = useState(false);

  const requestSeqRef = useRef(0);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const hoverTimerRef = useRef<number | null>(null);

  // Fetch full official AniList taxonomy (~18 genres + ~363 tags) once when panel activates
  useEffect(() => {
    if (!active || taxonomyLoadedRef.current) return;
    taxonomyLoadedRef.current = true;
    let cancelled = false;
    setLoadingTaxonomy(true);
    fetchDiscoverTaxonomyCached()
      .then((meta) => {
        if (cancelled) return;
        if (meta.genres.length > 0) setTaxonomyGenres(meta.genres);
        if (meta.tags.length > 0) setTaxonomyTags(meta.tags);
      })
      .catch(() => {
        // Keep fallback genres & popular tags silently
      })
      .finally(() => {
        if (!cancelled) setLoadingTaxonomy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active]);

  // Debounce minimumTagRank commits so press-and-hold or dragging only fires 1 API call on release
  useEffect(() => {
    if (minimumTagRank === debouncedMinTagRank) return;
    const timer = window.setTimeout(() => {
      setDebouncedMinTagRank(minimumTagRank);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [minimumTagRank, debouncedMinTagRank]);

  const hasTagFilters = selectedTags.length > 0 || excludedTags.length > 0;
  const isCustomMinTagRank = minimumTagRank !== DEFAULT_ANILIST_MIN_TAG_RANK;

  const activeFilters = useMemo<AniListDiscoverFilters>(
    () => ({
      sort,
      genres: selectedGenres.length > 0 ? selectedGenres : undefined,
      excludeGenres: excludedGenres.length > 0 ? excludedGenres : undefined,
      tags: selectedTags.length > 0 ? selectedTags : undefined,
      excludeTags: excludedTags.length > 0 ? excludedTags : undefined,
      minimumTagRank:
        hasTagFilters && debouncedMinTagRank !== DEFAULT_ANILIST_MIN_TAG_RANK
          ? debouncedMinTagRank
          : undefined,
      season,
      year: year || undefined,
      format,
      status,
      country,
      audio,
      onlyAvailable,
    }),
    [
      sort,
      selectedGenres,
      excludedGenres,
      selectedTags,
      excludedTags,
      hasTagFilters,
      debouncedMinTagRank,
      season,
      year,
      format,
      status,
      country,
      audio,
      onlyAvailable,
    ]
  );

  const activeFilterCount =
    selectedGenres.length +
    excludedGenres.length +
    selectedTags.length +
    excludedTags.length +
    (isCustomMinTagRank ? 1 : 0) +
    [season, year, format, status, country, audio !== 'ALL' ? audio : ''].filter(Boolean).length;
  const hasCustomFilter = activeFilterCount > 0;

  // Tri-state cycle: neutral -> include -> exclude -> neutral
  const toggleGenre = useCallback(
    (genreValue: string) => {
      if (selectedGenres.includes(genreValue)) {
        setSelectedGenres((prev) => prev.filter((g) => g !== genreValue));
        setExcludedGenres((prev) => {
          if (prev.includes(genreValue) || prev.length >= 12) return prev;
          return [...prev, genreValue];
        });
        return;
      }
      if (excludedGenres.includes(genreValue)) {
        setExcludedGenres((prev) => prev.filter((g) => g !== genreValue));
        return;
      }
      if (selectedGenres.length < 6) {
        setSelectedGenres((prev) => [...prev, genreValue]);
      } else if (excludedGenres.length < 12) {
        setExcludedGenres((prev) => [...prev, genreValue]);
      }
    },
    [selectedGenres, excludedGenres]
  );

  // Tri-state cycle for tags: neutral -> include -> exclude -> neutral
  const toggleTag = useCallback(
    (tagName: string) => {
      if (selectedTags.includes(tagName)) {
        setSelectedTags((prev) => prev.filter((t) => t !== tagName));
        setExcludedTags((prev) => {
          if (prev.includes(tagName) || prev.length >= 12) return prev;
          return [...prev, tagName];
        });
        return;
      }
      if (excludedTags.includes(tagName)) {
        setExcludedTags((prev) => prev.filter((t) => t !== tagName));
        return;
      }
      if (selectedTags.length < 6) {
        setSelectedTags((prev) => [...prev, tagName]);
      } else if (excludedTags.length < 12) {
        setExcludedTags((prev) => [...prev, tagName]);
      }
    },
    [selectedTags, excludedTags]
  );

  const removeIncludedGenre = useCallback((genreValue: string) => {
    setSelectedGenres((prev) => prev.filter((g) => g !== genreValue));
  }, []);

  const removeExcludedGenre = useCallback((genreValue: string) => {
    setExcludedGenres((prev) => prev.filter((g) => g !== genreValue));
  }, []);

  const removeIncludedTag = useCallback((tagName: string) => {
    setSelectedTags((prev) => prev.filter((t) => t !== tagName));
  }, []);

  const removeExcludedTag = useCallback((tagName: string) => {
    setExcludedTags((prev) => prev.filter((t) => t !== tagName));
  }, []);

  const clearGenresAndTags = useCallback(() => {
    setSelectedGenres([]);
    setExcludedGenres([]);
    setSelectedTags([]);
    setExcludedTags([]);
    setMinimumTagRank(DEFAULT_ANILIST_MIN_TAG_RANK);
    setDebouncedMinTagRank(DEFAULT_ANILIST_MIN_TAG_RANK);
  }, []);

  const clearAllFilters = useCallback(() => {
    setSort('TRENDING_DESC');
    setSelectedGenres([]);
    setExcludedGenres([]);
    setSelectedTags([]);
    setExcludedTags([]);
    setMinimumTagRank(DEFAULT_ANILIST_MIN_TAG_RANK);
    setDebouncedMinTagRank(DEFAULT_ANILIST_MIN_TAG_RANK);
    setSeason('');
    setYear('');
    setFormat('');
    setStatus('');
    setCountry('');
    setAudio('ALL');
  }, []);

  const genreLabelLookup = useMemo(() => {
    const map = new Map<string, string>();
    for (const g of taxonomyGenres) map.set(g.value, g.label);
    return map;
  }, [taxonomyGenres]);

  const tagLabelLookup = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of taxonomyTags) map.set(t.name, t.label);
    return map;
  }, [taxonomyTags]);

  const loadPage = useCallback(
    async (pageToLoad: number, append: boolean, forceRefresh = false) => {
      const seq = ++requestSeqRef.current;
      if (append) {
        setLoadingMore(true);
      } else {
        setLoading(true);
        setError('');
      }

      try {
        const res = await fetchDiscoverCatalogCached(
          { ...activeFilters, page: pageToLoad },
          { forceRefresh }
        );
        if (seq !== requestSeqRef.current) return;

        setIndexedTitlesCount(res.indexedTitlesCount || 0);
        setNextPage(res.nextAniListPage);
        setHasNextPage(res.hasNextPage);
        setInitialized(true);
        setItems((prev) => {
          if (!append) return res.items;
          const seen = new Set(prev.map((it) => it.url || it.id));
          const merged = [...prev];
          for (const it of res.items) {
            const key = it.url || it.id;
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(it);
          }
          return merged;
        });
      } catch (err) {
        if (seq !== requestSeqRef.current) return;
        if (!append) {
          setError(
            err instanceof Error
              ? err.message
              : 'Não foi possível carregar o catálogo do AniList.'
          );
        }
      } finally {
        if (seq === requestSeqRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [activeFilters]
  );

  // Load page 1 whenever panel becomes active or filters change
  useEffect(() => {
    if (!active) return;
    void loadPage(1, false);
  }, [active, loadPage]);

  // Cleanup hover prefetch timer on unmount
  useEffect(() => {
    return () => {
      if (hoverTimerRef.current !== null) {
        window.clearTimeout(hoverTimerRef.current);
      }
    };
  }, []);

  // Auto-load next page via IntersectionObserver
  useEffect(() => {
    if (!active || isHidden || !hasNextPage || !nextPage || loading || loadingMore) return;
    const node = loadMoreRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadPage(nextPage, true);
        }
      },
      { rootMargin: '420px 0px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [active, isHidden, hasNextPage, nextPage, loading, loadingMore, loadPage]);

  const scheduleHoverPrefetch = useCallback(
    (item: CatalogMediaItem) => {
      if (!onPrefetchItem) return;
      if (hoverTimerRef.current !== null) {
        window.clearTimeout(hoverTimerRef.current);
      }
      hoverTimerRef.current = window.setTimeout(() => {
        hoverTimerRef.current = null;
        onPrefetchItem(item.url, item.kind, buildSeedFromDiscoverItem(item));
      }, 140);
    },
    [onPrefetchItem]
  );

  const cancelHoverPrefetch = useCallback(() => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);

  const handleStatusChange = useCallback((nextStatus: AniListStatus | '') => {
    setStatus(nextStatus);
    if (nextStatus === 'NOT_YET_RELEASED') {
      setOnlyAvailable(false);
    }
  }, []);

  return (
    <div className="space-y-5">
      {/* Compact Unified Toolbar: Sort Tabs + Availability Switch + Filters */}
      <div className="rounded-xl border border-white/10 bg-[#151921] p-3.5 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          {/* Ranking / Sort Tabs */}
          <div
            className="flex flex-wrap items-center gap-1.5"
            role="group"
            aria-label="Ordenação do catálogo AniList"
          >
            {ANILIST_SORT_OPTIONS.map((opt) => {
              const isSelected = sort === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => setSort(opt.value)}
                  className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors sm:px-3 ${
                    isSelected
                      ? 'border-[#f97316] bg-[#f97316]/15 text-white'
                      : 'border-white/10 bg-[#0d0f12] text-slate-400 hover:text-white'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>

          {/* Availability Toggle + Refresh */}
          <div className="flex w-full items-center justify-between gap-2 sm:w-auto sm:justify-end">
            <button
              type="button"
              role="switch"
              aria-checked={onlyAvailable}
              onClick={() => setOnlyAvailable((prev) => !prev)}
              className={`inline-flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors sm:px-3 ${
                onlyAvailable
                  ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/20'
                  : 'border-white/12 bg-[#0d0f12] text-slate-300 hover:border-white/25 hover:text-white'
              }`}
            >
              <CheckCircle2
                className={`h-3.5 w-3.5 ${onlyAvailable ? 'text-emerald-400' : 'text-slate-500'}`}
              />
              <span>Somente disponíveis</span>
              <span
                className={`ml-0.5 inline-flex h-4 w-7 items-center rounded-full p-0.5 transition-colors ${
                  onlyAvailable ? 'bg-emerald-500 justify-end' : 'bg-white/15 justify-start'
                }`}
                aria-hidden="true"
              >
                <span className="h-3 w-3 rounded-full bg-white shadow-sm" />
              </span>
            </button>

            <button
              type="button"
              onClick={() => void loadPage(1, false, true)}
              disabled={loading}
              aria-label="Atualizar resultados do AniList"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-[#0d0f12] text-slate-300 transition-colors hover:border-[#f97316]/60 hover:text-white disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin text-[#f97316]' : ''}`} />
            </button>
          </div>
        </div>

        {/* Rich AniList + Audio Filters (always visible on both mobile/Android and desktop) */}
        <div
          data-testid="anilist-filters-bar"
          className="mt-3 grid grid-cols-2 gap-2 border-t border-white/8 pt-3 sm:flex sm:flex-wrap sm:items-center"
        >
          <AniListTagPicker
            genres={taxonomyGenres}
            tags={taxonomyTags}
            selectedGenres={selectedGenres}
            excludedGenres={excludedGenres}
            selectedTags={selectedTags}
            excludedTags={excludedTags}
            minimumTagRank={minimumTagRank}
            defaultMinimumTagRank={DEFAULT_ANILIST_MIN_TAG_RANK}
            loadingTaxonomy={loadingTaxonomy}
            onToggleGenre={toggleGenre}
            onToggleTag={toggleTag}
            onChangeMinimumTagRank={setMinimumTagRank}
            onClearAll={clearGenresAndTags}
          />

          <select
            aria-label="Filtrar por áudio disponível"
            value={audio}
            onChange={(e) => setAudio(e.target.value as DiscoverAudioFilter)}
            className="w-full rounded-lg border border-white/12 bg-[#0d0f12] px-2.5 py-1.5 text-xs font-medium text-slate-200 focus:border-[#f97316] focus:outline-none sm:w-auto sm:px-3"
          >
            {ANILIST_AUDIO_FILTERS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>

          <select
            aria-label="Filtrar por temporada no AniList"
            value={season}
            onChange={(e) => setSeason(e.target.value as AniListSeason | '')}
            className="w-full rounded-lg border border-white/12 bg-[#0d0f12] px-2.5 py-1.5 text-xs font-medium text-slate-200 focus:border-[#f97316] focus:outline-none sm:w-auto sm:px-3"
          >
            <option value="">Temporada</option>
            {ANILIST_SEASONS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>

          <select
            aria-label="Filtrar por ano no AniList"
            value={year}
            onChange={(e) => setYear(e.target.value)}
            className="w-full rounded-lg border border-white/12 bg-[#0d0f12] px-2.5 py-1.5 text-xs font-medium text-slate-200 focus:border-[#f97316] focus:outline-none sm:w-auto sm:px-3"
          >
            <option value="">Ano</option>
            {YEAR_OPTIONS.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>

          <select
            aria-label="Filtrar por formato no AniList"
            value={format}
            onChange={(e) => setFormat(e.target.value as AniListFormat | '')}
            className="w-full rounded-lg border border-white/12 bg-[#0d0f12] px-2.5 py-1.5 text-xs font-medium text-slate-200 focus:border-[#f97316] focus:outline-none sm:w-auto sm:px-3"
          >
            <option value="">Formato</option>
            {ANILIST_FORMATS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>

          <select
            aria-label="Filtrar por status no AniList"
            value={status}
            onChange={(e) => handleStatusChange(e.target.value as AniListStatus | '')}
            className="w-full rounded-lg border border-white/12 bg-[#0d0f12] px-2.5 py-1.5 text-xs font-medium text-slate-200 focus:border-[#f97316] focus:outline-none sm:w-auto sm:px-3"
          >
            <option value="">Status</option>
            {ANILIST_STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>

          <select
            aria-label="Filtrar por país de origem"
            value={country}
            onChange={(e) => setCountry(e.target.value as AniListCountry | '')}
            className="w-full rounded-lg border border-white/12 bg-[#0d0f12] px-2.5 py-1.5 text-xs font-medium text-slate-200 focus:border-[#f97316] focus:outline-none sm:w-auto sm:px-3"
          >
            <option value="">País</option>
            {ANILIST_COUNTRIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>

          {hasCustomFilter && (
            <button
              type="button"
              onClick={clearAllFilters}
              className="col-span-2 inline-flex items-center justify-center gap-1 rounded-lg border border-[#f97316]/40 bg-[#f97316]/12 px-3 py-1.5 text-xs font-medium text-[#fb923c] transition-colors hover:bg-[#f97316]/20 sm:col-span-1"
            >
              <X className="h-3.5 w-3.5" />
              <span>Limpar filtros</span>
            </button>
          )}
        </div>

        {/* Selected & Excluded Genre & Tag Chips (visible on desktop & mobile whenever active) */}
        {(selectedGenres.length > 0 ||
          excludedGenres.length > 0 ||
          selectedTags.length > 0 ||
          excludedTags.length > 0 ||
          isCustomMinTagRank) && (
          <div
            data-testid="anilist-selected-tags"
            className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-white/8 pt-2.5"
          >
            {selectedGenres.map((genreValue) => {
              const label = genreLabelLookup.get(genreValue) || genreValue;
              const showEn = label.toLowerCase() !== genreValue.toLowerCase();
              return (
                <button
                  key={`genre-${genreValue}`}
                  type="button"
                  onClick={() => removeIncludedGenre(genreValue)}
                  aria-label={`Remover gênero ${label}`}
                  className="inline-flex items-center gap-1 rounded-md border border-[#f97316]/45 bg-[#f97316]/15 px-2 py-0.5 text-[11px] font-medium text-[#fdba74] transition-colors hover:bg-[#f97316]/25 hover:text-white"
                >
                  <span>{label}</span>
                  {showEn && <span className="text-[10px] text-[#fdba74]/70">· {genreValue}</span>}
                  <X className="h-3 w-3" />
                </button>
              );
            })}
            {excludedGenres.map((genreValue) => {
              const label = genreLabelLookup.get(genreValue) || genreValue;
              const showEn = label.toLowerCase() !== genreValue.toLowerCase();
              return (
                <button
                  key={`exclude-genre-${genreValue}`}
                  type="button"
                  data-excluded-genre-chip={genreValue}
                  onClick={() => removeExcludedGenre(genreValue)}
                  aria-label={`Remover exclusão do gênero ${label}`}
                  className="inline-flex items-center gap-1 rounded-md border border-rose-500/45 bg-rose-500/15 px-2 py-0.5 text-[11px] font-medium text-rose-200 transition-colors hover:bg-rose-500/25 hover:text-white"
                >
                  <span>Sem {label}</span>
                  {showEn && <span className="text-[10px] text-rose-300/70">· {genreValue}</span>}
                  <X className="h-3 w-3" />
                </button>
              );
            })}
            {selectedTags.map((tagName) => {
              const label = tagLabelLookup.get(tagName) || formatAniListTagLabel(tagName);
              const showEn = label.toLowerCase() !== tagName.toLowerCase();
              return (
                <button
                  key={`tag-${tagName}`}
                  type="button"
                  onClick={() => removeIncludedTag(tagName)}
                  aria-label={`Remover tag ${label}`}
                  className="inline-flex items-center gap-1 rounded-md border border-sky-400/35 bg-sky-500/12 px-2 py-0.5 text-[11px] font-medium text-sky-200 transition-colors hover:bg-sky-500/25 hover:text-white"
                >
                  <span>#{label}</span>
                  {showEn && <span className="text-[10px] text-sky-300/70">· {tagName}</span>}
                  <X className="h-3 w-3" />
                </button>
              );
            })}
            {excludedTags.map((tagName) => {
              const label = tagLabelLookup.get(tagName) || formatAniListTagLabel(tagName);
              const showEn = label.toLowerCase() !== tagName.toLowerCase();
              return (
                <button
                  key={`exclude-tag-${tagName}`}
                  type="button"
                  data-excluded-tag-chip={tagName}
                  onClick={() => removeExcludedTag(tagName)}
                  aria-label={`Remover exclusão da tag ${label}`}
                  className="inline-flex items-center gap-1 rounded-md border border-rose-500/45 bg-rose-500/15 px-2 py-0.5 text-[11px] font-medium text-rose-200 transition-colors hover:bg-rose-500/25 hover:text-white"
                >
                  <span>Sem #{label}</span>
                  {showEn && <span className="text-[10px] text-rose-300/70">· {tagName}</span>}
                  <X className="h-3 w-3" />
                </button>
              );
            })}
            {isCustomMinTagRank && (
              <button
                type="button"
                data-testid="min-tag-rank-chip"
                onClick={() => {
                  setMinimumTagRank(DEFAULT_ANILIST_MIN_TAG_RANK);
                  setDebouncedMinTagRank(DEFAULT_ANILIST_MIN_TAG_RANK);
                }}
                aria-label={`Restaurar porcentagem mínima da tag para o padrão (${DEFAULT_ANILIST_MIN_TAG_RANK}%)`}
                className="inline-flex items-center gap-1 rounded-md border border-white/20 bg-white/[0.06] px-2 py-0.5 text-[11px] font-medium text-slate-200 transition-colors hover:border-[#f97316]/50 hover:text-white"
              >
                <span className="font-mono tabular-nums">Tag ≥ {minimumTagRank}%</span>
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Results Area */}
      {error && items.length === 0 ? (
        <div className="rounded-xl border border-rose-500/30 bg-rose-950/20 p-8 text-center">
          <p className="text-sm text-rose-200">{error}</p>
          <button
            type="button"
            onClick={() => void loadPage(1, false, true)}
            className="mt-4 inline-flex items-center gap-2 rounded-lg border border-white/15 bg-[#151921] px-4 py-2 text-xs font-semibold text-white transition-colors hover:border-[#f97316]/60"
          >
            <RefreshCw className="h-3.5 w-3.5 text-[#f97316]" />
            <span>Tentar novamente</span>
          </button>
        </div>
      ) : loading && items.length === 0 ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {Array.from({ length: 10 }).map((_, idx) => (
            <div
              key={idx}
              className="anisync-shimmer aspect-[2/3] rounded-xl border border-white/8"
            />
          ))}
        </div>
      ) : initialized && items.length === 0 ? (
        <div className="rounded-xl border border-white/10 bg-[#151921] p-10 text-center">
          <p className="text-sm font-medium text-slate-200">
            {onlyAvailable
              ? 'Nenhum anime com esses filtros foi encontrado disponível nos provedores agora.'
              : 'Nenhum título encontrado no AniList para os filtros selecionados.'}
          </p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            {onlyAvailable && (
              <button
                type="button"
                onClick={() => setOnlyAvailable(false)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#f97316]/50 bg-[#f97316]/15 px-4 py-2 text-xs font-semibold text-[#fb923c] transition-colors hover:bg-[#f97316]/25"
              >
                <span>Incluir títulos indisponíveis / futuros</span>
              </button>
            )}
            {hasCustomFilter && (
              <button
                type="button"
                onClick={clearAllFilters}
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/12 bg-[#0d0f12] px-4 py-2 text-xs font-medium text-slate-200 transition-colors hover:border-white/25 hover:text-white"
              >
                <X className="h-3.5 w-3.5" />
                <span>Limpar filtros</span>
              </button>
            )}
          </div>
        </div>
      ) : (
        <div>
          <div className="mb-3.5 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-base font-semibold text-white">
              {ANILIST_SORT_OPTIONS.find((s) => s.value === sort)?.label || 'Em Alta'}
              {(() => {
                const activeLabels = [
                  ...selectedGenres.map((g) => genreLabelLookup.get(g) || g),
                  ...excludedGenres.map((g) => `Sem ${genreLabelLookup.get(g) || g}`),
                  ...selectedTags.map((t) => tagLabelLookup.get(t) || t),
                  ...excludedTags.map((t) => `Sem ${tagLabelLookup.get(t) || t}`),
                ];
                if (activeLabels.length === 0) return '';
                const preview = activeLabels.slice(0, 2).join(', ');
                const extra = activeLabels.length > 2 ? ` +${activeLabels.length - 2}` : '';
                return ` · ${preview}${extra}`;
              })()}
            </h3>
            <span className="text-xs tabular-nums text-slate-400">
              {items.length} {items.length === 1 ? 'título' : 'títulos'}
              {onlyAvailable && indexedTitlesCount > 0
                ? ` · ${indexedTitlesCount.toLocaleString('pt-BR')} verificados`
                : ''}
            </span>
          </div>

          <div
            data-testid="anilist-discover-grid"
            className={`grid grid-cols-2 gap-4 transition-opacity duration-200 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 ${
              loading ? 'opacity-60' : 'opacity-100'
            }`}
          >
            {items.map((item, idx) => {
              const avail = item.providerAvailability;
              const isAvailable = Boolean(avail?.available);
              const favActive = isItemFavorited(item.url, favorites);
              const seed = buildSeedFromDiscoverItem(item);

              const badgeText = isAvailable
                ? avail?.hasDub && avail?.hasLeg
                  ? 'DUB · LEG'
                  : avail?.hasDub
                    ? 'DUB'
                    : 'LEG'
                : avail?.unreleased
                  ? 'Em breve'
                  : 'Indisponível';

              const badgeClass = isAvailable
                ? avail?.hasDub
                  ? 'bg-emerald-600/90 text-white'
                  : 'bg-[#f97316]/95 text-[#0d0f12]'
                : avail?.unreleased
                  ? 'bg-sky-500/85 text-white'
                  : 'bg-[#0d0f12]/85 text-slate-300 border border-white/15';

              return (
                <div
                  key={`${item.id}-${item.url}`}
                  className={`group relative flex flex-col overflow-hidden rounded-xl border bg-[#151921] transition-colors ${
                    isAvailable
                      ? 'border-white/10 hover:border-[#f97316]/60'
                      : 'border-white/8 opacity-85 hover:opacity-100 hover:border-white/25'
                  }`}
                >
                  <button
                    type="button"
                    onMouseEnter={() => scheduleHoverPrefetch(item)}
                    onMouseLeave={cancelHoverPrefetch}
                    onFocus={() => onPrefetchItem?.(item.url, item.kind, seed)}
                    onTouchStart={() => onPrefetchItem?.(item.url, item.kind, seed)}
                    onClick={() => onOpenItem(item.url, item.kind, seed)}
                    className="flex flex-1 flex-col text-left"
                  >
                    <div className="relative w-full">
                      <MediaPoster
                        src={item.poster}
                        alt={item.title}
                        aspect="portrait"
                        priority={idx < 5}
                        className="w-full border-b border-white/8"
                      />

                      {/* Availability / Audio Badge */}
                      <span
                        className={`pointer-events-none absolute left-2 top-2 rounded-md px-2 py-0.5 text-[10px] font-bold tracking-wide shadow-sm backdrop-blur-sm ${badgeClass}`}
                      >
                        {badgeText}
                      </span>

                      {/* AniList Score */}
                      {item.rating && (
                        <span className="pointer-events-none absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-md bg-[#0d0f12]/85 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-amber-300 backdrop-blur-sm">
                          <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
                          <span>{item.rating}</span>
                        </span>
                      )}
                    </div>

                    <div className="flex flex-1 flex-col justify-between p-2.5 sm:p-3">
                      <h4 className="line-clamp-2 text-xs font-semibold leading-snug text-white group-hover:text-[#fb923c] sm:text-sm">
                        {item.title}
                      </h4>
                      <div className="mt-1.5 space-y-0.5">
                        {(item.year || item.mediaFormat) && (
                          <p className="text-[11px] tabular-nums text-slate-400">
                            {[item.year, item.mediaFormat].filter(Boolean).join(' · ')}
                          </p>
                        )}
                        {item.genres && item.genres.length > 0 && (
                          <p className="line-clamp-1 text-[11px] text-slate-500">
                            {item.genres.slice(0, 2).join(', ')}
                          </p>
                        )}
                      </div>
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
                </div>
              );
            })}
          </div>

          {hasNextPage && nextPage && (
            <div ref={loadMoreRef} className="mt-7 flex justify-center">
              <button
                type="button"
                disabled={loadingMore}
                onClick={() => void loadPage(nextPage, true)}
                className="inline-flex items-center gap-2 rounded-xl border border-white/12 bg-[#151921] px-5 py-2.5 text-sm font-medium text-white transition-colors hover:border-[#f97316]/60 disabled:opacity-50"
              >
                {loadingMore ? (
                  <Loader2 className="h-4 w-4 animate-spin text-[#f97316]" />
                ) : (
                  <ChevronDown className="h-4 w-4 text-[#f97316]" />
                )}
                <span>{loadingMore ? 'Carregando mais títulos...' : 'Carregar mais do AniList'}</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
