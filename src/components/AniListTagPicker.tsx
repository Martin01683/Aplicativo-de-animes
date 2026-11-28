import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Check, ChevronDown, Info, Loader2, Minus, Plus, Search, Tag, X } from 'lucide-react';
import { DEFAULT_ANILIST_MIN_TAG_RANK } from '../lib/catalog/providers/anilistProvider';
import type { AniListTagItem } from '../lib/types';

interface AniListTagPickerProps {
  genres: Array<{ value: string; label: string }>;
  tags: AniListTagItem[];
  selectedGenres: string[];
  excludedGenres?: string[];
  selectedTags: string[];
  excludedTags?: string[];
  minimumTagRank?: number;
  defaultMinimumTagRank?: number;
  loadingTaxonomy?: boolean;
  maxGenres?: number;
  maxExcludedGenres?: number;
  maxTags?: number;
  maxExcludedTags?: number;
  onToggleGenre: (genreValue: string) => void;
  onToggleTag: (tagName: string) => void;
  onChangeMinimumTagRank?: (nextValue: number) => void;
  onClearAll: () => void;
}

function normalizeSearchToken(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function formatShortCategory(category: string): string {
  if (!category) return '';
  const parts = category.split('-');
  return parts.length > 1 ? parts.slice(1).join(' ') : category;
}

export function AniListTagPicker({
  genres,
  tags,
  selectedGenres,
  excludedGenres = [],
  selectedTags,
  excludedTags = [],
  minimumTagRank = DEFAULT_ANILIST_MIN_TAG_RANK,
  defaultMinimumTagRank = DEFAULT_ANILIST_MIN_TAG_RANK,
  loadingTaxonomy = false,
  maxGenres = 6,
  maxExcludedGenres = 12,
  maxTags = 6,
  maxExcludedTags = 12,
  onToggleGenre,
  onToggleTag,
  onChangeMinimumTagRank,
  onClearAll,
}: AniListTagPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hoveredTag, setHoveredTag] = useState<AniListTagItem | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const clampedMinTagRank = Math.min(100, Math.max(0, Math.round(minimumTagRank)));
  const isCustomMinTagRank = clampedMinTagRank !== defaultMinimumTagRank;
  const latestRankRef = useRef(clampedMinTagRank);
  latestRankRef.current = clampedMinTagRank;

  const holdTimeoutRef = useRef<number | null>(null);
  const holdIntervalRef = useRef<number | null>(null);
  const pointerTriggeredRef = useRef(false);

  const stopHoldRepeat = useCallback(() => {
    if (holdTimeoutRef.current !== null) {
      window.clearTimeout(holdTimeoutRef.current);
      holdTimeoutRef.current = null;
    }
    if (holdIntervalRef.current !== null) {
      window.clearInterval(holdIntervalRef.current);
      holdIntervalRef.current = null;
    }
  }, []);

  const stepMinimumTagRank = useCallback(
    (delta: number) => {
      if (!onChangeMinimumTagRank) return;
      const next = Math.min(100, Math.max(0, latestRankRef.current + delta));
      if (next === latestRankRef.current) {
        stopHoldRepeat();
        return;
      }
      latestRankRef.current = next;
      onChangeMinimumTagRank(next);
    },
    [onChangeMinimumTagRank, stopHoldRepeat]
  );

  const startHoldRepeat = useCallback(
    (delta: number, event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      event.preventDefault();
      stopHoldRepeat();
      pointerTriggeredRef.current = true;
      stepMinimumTagRank(delta);

      holdTimeoutRef.current = window.setTimeout(() => {
        holdIntervalRef.current = window.setInterval(() => {
          stepMinimumTagRank(delta);
        }, 55);
      }, 340);
    },
    [stepMinimumTagRank, stopHoldRepeat]
  );

  useEffect(() => {
    const handleGlobalRelease = () => stopHoldRepeat();
    window.addEventListener('pointerup', handleGlobalRelease);
    window.addEventListener('pointercancel', handleGlobalRelease);
    window.addEventListener('blur', handleGlobalRelease);
    return () => {
      stopHoldRepeat();
      window.removeEventListener('pointerup', handleGlobalRelease);
      window.removeEventListener('pointercancel', handleGlobalRelease);
      window.removeEventListener('blur', handleGlobalRelease);
    };
  }, [stopHoldRepeat]);

  useEffect(() => {
    if (!open) stopHoldRepeat();
  }, [open, stopHoldRepeat]);

  const selectedGenreSet = useMemo(() => new Set(selectedGenres), [selectedGenres]);
  const excludedGenreSet = useMemo(() => new Set(excludedGenres), [excludedGenres]);
  const selectedTagSet = useMemo(() => new Set(selectedTags), [selectedTags]);
  const excludedTagSet = useMemo(() => new Set(excludedTags), [excludedTags]);
  const totalSelected =
    selectedGenres.length +
    excludedGenres.length +
    selectedTags.length +
    excludedTags.length +
    (isCustomMinTagRank ? 1 : 0);

  useEffect(() => {
    if (!open) {
      setHoveredTag(null);
      return;
    }

    const focusTimer = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 10);

    const handleMouseDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const normalizedQuery = useMemo(() => normalizeSearchToken(query), [query]);

  const filteredGenres = useMemo(() => {
    if (!normalizedQuery) return genres;
    return genres.filter((g) => {
      const en = normalizeSearchToken(g.value);
      const pt = normalizeSearchToken(g.label);
      return en.includes(normalizedQuery) || pt.includes(normalizedQuery);
    });
  }, [genres, normalizedQuery]);

  const filteredTags = useMemo(() => {
    if (!normalizedQuery) return tags;
    return tags.filter((t) => {
      const name = normalizeSearchToken(t.name);
      const label = normalizeSearchToken(t.label);
      const cat = normalizeSearchToken(t.category);
      return (
        name.includes(normalizedQuery) ||
        label.includes(normalizedQuery) ||
        cat.includes(normalizedQuery)
      );
    });
  }, [tags, normalizedQuery]);

  const buttonLabel = useMemo(() => {
    if (totalSelected === 0) return 'Gêneros & Tags';
    if (totalSelected === 1) {
      if (selectedGenres.length === 1) {
        const found = genres.find((g) => g.value === selectedGenres[0]);
        return found ? found.label : selectedGenres[0];
      }
      if (excludedGenres.length === 1) {
        const found = genres.find((g) => g.value === excludedGenres[0]);
        return `Sem ${found ? found.label : excludedGenres[0]}`;
      }
      if (selectedTags.length === 1) {
        const foundTag = tags.find((t) => t.name === selectedTags[0]);
        return foundTag ? foundTag.label : selectedTags[0];
      }
      if (excludedTags.length === 1) {
        const foundTag = tags.find((t) => t.name === excludedTags[0]);
        return `Sem ${foundTag ? foundTag.label : excludedTags[0]}`;
      }
      if (isCustomMinTagRank) {
        return `Tag ≥ ${clampedMinTagRank}%`;
      }
    }
    return `Gêneros & Tags (${totalSelected})`;
  }, [
    totalSelected,
    selectedGenres,
    excludedGenres,
    selectedTags,
    excludedTags,
    isCustomMinTagRank,
    clampedMinTagRank,
    genres,
    tags,
  ]);

  const hasResults = filteredGenres.length > 0 || filteredTags.length > 0;
  const genreLimitReached = selectedGenres.length >= maxGenres;
  const excludedGenreLimitReached = excludedGenres.length >= maxExcludedGenres;
  const tagLimitReached = selectedTags.length >= maxTags;
  const excludedTagLimitReached = excludedTags.length >= maxExcludedTags;

  return (
    <div ref={containerRef} className="relative col-span-2 sm:col-span-1">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Selecionar gêneros e tags do AniList"
        onClick={() => setOpen((prev) => !prev)}
        className={`inline-flex w-full items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors sm:min-w-[185px] sm:max-w-[230px] sm:px-3 ${
          open || totalSelected > 0
            ? 'border-[#f97316]/70 bg-[#f97316]/12 text-white'
            : 'border-white/12 bg-[#0d0f12] text-slate-200 hover:border-white/25 hover:text-white'
        }`}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <Tag
            className={`h-3.5 w-3.5 shrink-0 ${
              open || totalSelected > 0 ? 'text-[#f97316]' : 'text-slate-400'
            }`}
          />
          <span className="truncate">{buttonLabel}</span>
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ${
            open ? 'rotate-180 text-[#f97316]' : ''
          }`}
        />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Gêneros e Tags do AniList"
          className="absolute left-0 top-full z-40 mt-1.5 w-full overflow-hidden rounded-xl border border-white/15 bg-[#12161f] shadow-2xl shadow-black/70 sm:w-[356px]"
        >
          {/* Search Input Header */}
          <div className="space-y-1.5 border-b border-white/10 p-2.5">
            <div className="relative flex items-center">
              <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-slate-400" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar em PT ou EN (ex: Bruxas, Youkai)..."
                aria-label="Buscar gênero ou tag do AniList"
                className="w-full rounded-lg border border-white/12 bg-[#0d0f12] py-1.5 pl-8 pr-7 text-xs text-white placeholder:text-slate-500 focus:border-[#f97316] focus:outline-none"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => {
                    setQuery('');
                    inputRef.current?.focus();
                  }}
                  aria-label="Limpar busca de tags"
                  className="absolute right-2 rounded p-0.5 text-slate-400 hover:text-white"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 px-0.5 text-[10px] text-slate-400">
              <span className="font-medium text-slate-300">Clique:</span>
              <span className="inline-flex items-center gap-1">
                <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded border border-[#f97316] bg-[#f97316] text-[#0d0f12]">
                  <Check className="h-2.5 w-2.5 stroke-[3]" />
                </span>
                <span>1× incluir</span>
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded border border-rose-500 bg-rose-500 text-white">
                  <Minus className="h-2.5 w-2.5 stroke-[3]" />
                </span>
                <span>2× excluir</span>
              </span>
              <span className="inline-flex items-center gap-1 text-slate-500">
                <span className="inline-flex h-3.5 w-3.5 rounded border border-white/25 bg-[#0d0f12]" />
                <span>3× limpar</span>
              </span>
            </div>

            {onChangeMinimumTagRank && (
              <div
                data-testid="min-tag-rank-control"
                className="space-y-1.5 rounded-lg border border-white/8 bg-[#0d0f12]/80 px-2.5 py-2"
              >
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="font-medium text-slate-200">
                    Porcentagem mínima da tag
                  </span>
                  <div className="flex items-center gap-1.5">
                    <span
                      data-testid="min-tag-rank-value"
                      className={`font-mono text-xs font-semibold tabular-nums ${
                        isCustomMinTagRank ? 'text-[#fb923c]' : 'text-white'
                      }`}
                    >
                      {clampedMinTagRank}%
                    </span>
                    <span className="text-[10px] text-slate-500">
                      (padrão: {defaultMinimumTagRank}%)
                    </span>
                    {isCustomMinTagRank && (
                      <button
                        type="button"
                        data-testid="min-tag-rank-reset"
                        aria-label={`Restaurar porcentagem padrão (${defaultMinimumTagRank}%)`}
                        title={`Restaurar padrão (${defaultMinimumTagRank}%)`}
                        onClick={() => onChangeMinimumTagRank(defaultMinimumTagRank)}
                        className="rounded p-0.5 text-slate-400 transition-colors hover:bg-white/10 hover:text-white"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    data-testid="min-tag-rank-dec"
                    disabled={clampedMinTagRank <= 0}
                    aria-label="Diminuir porcentagem mínima da tag em 1%"
                    title="Diminuir 1% (segure para diminuir continuamente)"
                    onPointerDown={(e) => startHoldRepeat(-1, e)}
                    onPointerUp={stopHoldRepeat}
                    onPointerLeave={stopHoldRepeat}
                    onPointerCancel={stopHoldRepeat}
                    onClick={() => {
                      if (pointerTriggeredRef.current) {
                        pointerTriggeredRef.current = false;
                        return;
                      }
                      stepMinimumTagRank(-1);
                    }}
                    className="flex h-7 w-7 shrink-0 touch-none select-none items-center justify-center rounded-md border border-white/12 bg-[#151921] text-slate-200 transition-colors hover:border-[#f97316]/60 hover:text-white active:bg-[#f97316]/20 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Minus className="h-3.5 w-3.5" />
                  </button>

                  <input
                    type="range"
                    data-testid="min-tag-rank-slider"
                    min={0}
                    max={100}
                    step={1}
                    value={clampedMinTagRank}
                    aria-label="Porcentagem mínima da tag"
                    onChange={(e) =>
                      onChangeMinimumTagRank(
                        Math.min(100, Math.max(0, Number.parseInt(e.target.value, 10) || 0))
                      )
                    }
                    className="h-1.5 w-full cursor-pointer accent-[#f97316]"
                  />

                  <button
                    type="button"
                    data-testid="min-tag-rank-inc"
                    disabled={clampedMinTagRank >= 100}
                    aria-label="Aumentar porcentagem mínima da tag em 1%"
                    title="Aumentar 1% (segure para aumentar continuamente)"
                    onPointerDown={(e) => startHoldRepeat(1, e)}
                    onPointerUp={stopHoldRepeat}
                    onPointerLeave={stopHoldRepeat}
                    onPointerCancel={stopHoldRepeat}
                    onClick={() => {
                      if (pointerTriggeredRef.current) {
                        pointerTriggeredRef.current = false;
                        return;
                      }
                      stepMinimumTagRank(1);
                    }}
                    className="flex h-7 w-7 shrink-0 touch-none select-none items-center justify-center rounded-md border border-white/12 bg-[#151921] text-slate-200 transition-colors hover:border-[#f97316]/60 hover:text-white active:bg-[#f97316]/20 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </div>

                <p
                  data-testid="min-tag-rank-help"
                  className="text-[10.5px] leading-snug text-slate-400"
                >
                  Válido para tags selecionadas: define a relevância mínima no AniList —
                  quanto maior a %, mais forte é o tema no anime.
                </p>
              </div>
            )}
          </div>

          {/* Scrollable Genres + Tags List */}
          <div
            data-testid="anilist-tag-picker-list"
            className="max-h-56 overflow-y-auto overscroll-contain p-1.5 sm:max-h-72"
          >
            {!hasResults ? (
              <p className="px-3 py-6 text-center text-xs text-slate-400">
                Nenhum gênero ou tag encontrado para &ldquo;{query}&rdquo;.
              </p>
            ) : (
              <>
                {filteredGenres.length > 0 && (
                  <div className="mb-2">
                    <div className="flex items-center justify-between px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                      <span>Gêneros</span>
                      <span className="tabular-nums text-slate-500">{filteredGenres.length}</span>
                    </div>
                    <div className="space-y-0.5">
                      {filteredGenres.map((genreItem) => {
                        const isSelected = selectedGenreSet.has(genreItem.value);
                        const isExcluded = excludedGenreSet.has(genreItem.value);
                        const filterState = isSelected
                          ? 'include'
                          : isExcluded
                            ? 'exclude'
                            : 'none';
                        const isDisabled =
                          filterState === 'none' &&
                          genreLimitReached &&
                          excludedGenreLimitReached;

                        return (
                          <button
                            key={genreItem.value}
                            type="button"
                            disabled={isDisabled}
                            data-genre-item={genreItem.value}
                            data-filter-state={filterState}
                            aria-pressed={
                              isSelected ? 'true' : isExcluded ? 'mixed' : 'false'
                            }
                            title={
                              isSelected
                                ? `${genreItem.label}: incluído (clique novamente para excluir)`
                                : isExcluded
                                  ? `${genreItem.label}: excluído (clique novamente para limpar)`
                                  : `${genreItem.label}: clique para incluir, clique 2× para excluir`
                            }
                            onClick={() => onToggleGenre(genreItem.value)}
                            className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors ${
                              isSelected
                                ? 'bg-[#f97316]/18 font-semibold text-white'
                                : isExcluded
                                  ? 'bg-rose-500/15 font-medium text-rose-200 hover:bg-rose-500/20'
                                  : isDisabled
                                    ? 'cursor-not-allowed text-slate-600'
                                    : 'text-slate-200 hover:bg-white/6 hover:text-white'
                            }`}
                          >
                            <span className="flex min-w-0 items-center gap-2">
                              <span
                                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                                  isSelected
                                    ? 'border-[#f97316] bg-[#f97316] text-[#0d0f12]'
                                    : isExcluded
                                      ? 'border-rose-500 bg-rose-500 text-white'
                                      : 'border-white/20 bg-[#0d0f12]'
                                }`}
                              >
                                {isSelected ? (
                                  <Check className="h-3 w-3 stroke-[2.75]" />
                                ) : isExcluded ? (
                                  <Minus className="h-3 w-3 stroke-[2.75]" />
                                ) : null}
                              </span>
                              <span className={`truncate ${isExcluded ? 'line-through' : ''}`}>
                                {genreItem.label}
                              </span>
                            </span>
                            {genreItem.label !== genreItem.value && (
                              <span
                                className={`shrink-0 text-[10px] ${
                                  isExcluded ? 'text-rose-300/60' : 'text-slate-500'
                                }`}
                              >
                                {genreItem.value}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {filteredTags.length > 0 && (
                  <div>
                    <div className="flex items-center justify-between px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                      <span className="inline-flex items-center gap-1.5">
                        <span>Tags do AniList</span>
                        {loadingTaxonomy && (
                          <Loader2 className="h-3 w-3 animate-spin text-[#f97316]" />
                        )}
                      </span>
                      <span className="tabular-nums text-slate-500">{filteredTags.length}</span>
                    </div>
                    <div className="space-y-0.5">
                      {filteredTags.map((tagItem) => {
                        const isSelected = selectedTagSet.has(tagItem.name);
                        const isExcluded = excludedTagSet.has(tagItem.name);
                        const filterState = isSelected
                          ? 'include'
                          : isExcluded
                            ? 'exclude'
                            : 'none';
                        const isDisabled =
                          filterState === 'none' &&
                          tagLimitReached &&
                          excludedTagLimitReached;
                        const shortCat = formatShortCategory(tagItem.category);
                        const hasDistinctEnglish =
                          tagItem.label.toLowerCase() !== tagItem.name.toLowerCase();
                        const rightSideText = hasDistinctEnglish ? tagItem.name : shortCat;
                        const stateHint = isSelected
                          ? 'Incluída (clique novamente para excluir)'
                          : isExcluded
                            ? 'Excluída (clique novamente para limpar)'
                            : 'Clique para incluir, 2× para excluir';
                        const tooltipText = [
                          hasDistinctEnglish
                            ? `${tagItem.label} (${tagItem.name})`
                            : tagItem.label,
                          stateHint,
                          shortCat ? `[${shortCat}]` : '',
                          tagItem.description || '',
                        ]
                          .filter(Boolean)
                          .join(' · ');

                        const isPreviewActive = hoveredTag?.name === tagItem.name;

                        return (
                          <div
                            key={tagItem.name}
                            className={`flex items-center gap-1 rounded-lg transition-colors ${
                              isSelected
                                ? 'bg-[#f97316]/18'
                                : isExcluded
                                  ? 'bg-rose-500/15 hover:bg-rose-500/20'
                                  : isDisabled
                                    ? ''
                                    : 'hover:bg-white/6'
                            }`}
                          >
                            <button
                              type="button"
                              disabled={isDisabled}
                              data-tag-item={tagItem.name}
                              data-filter-state={filterState}
                              aria-pressed={
                                isSelected ? 'true' : isExcluded ? 'mixed' : 'false'
                              }
                              title={tooltipText}
                              onMouseEnter={() => setHoveredTag(tagItem)}
                              onFocus={() => setHoveredTag(tagItem)}
                              onClick={() => {
                                setHoveredTag(tagItem);
                                onToggleTag(tagItem.name);
                              }}
                              className={`flex min-w-0 flex-1 items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors ${
                                isSelected
                                  ? 'font-semibold text-white'
                                  : isExcluded
                                    ? 'font-medium text-rose-200'
                                    : isDisabled
                                      ? 'cursor-not-allowed text-slate-600'
                                      : 'text-slate-200 hover:text-white'
                              }`}
                            >
                              <span className="flex min-w-0 items-center gap-2">
                                <span
                                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                                    isSelected
                                      ? 'border-[#f97316] bg-[#f97316] text-[#0d0f12]'
                                      : isExcluded
                                        ? 'border-rose-500 bg-rose-500 text-white'
                                        : 'border-white/20 bg-[#0d0f12]'
                                  }`}
                                >
                                  {isSelected ? (
                                    <Check className="h-3 w-3 stroke-[2.75]" />
                                  ) : isExcluded ? (
                                    <Minus className="h-3 w-3 stroke-[2.75]" />
                                  ) : null}
                                </span>
                                <span className={`truncate ${isExcluded ? 'line-through' : ''}`}>
                                  {tagItem.label}
                                </span>
                              </span>
                              {rightSideText && (
                                <span
                                  className={`max-w-[44%] shrink-0 truncate text-[10px] ${
                                    isExcluded ? 'text-rose-300/60' : 'text-slate-400'
                                  }`}
                                >
                                  {rightSideText}
                                </span>
                              )}
                            </button>

                            {tagItem.description && (
                              <button
                                type="button"
                                aria-label={`Ver descrição de ${tagItem.label}`}
                                aria-pressed={isPreviewActive}
                                onClick={() =>
                                  setHoveredTag((prev) =>
                                    prev?.name === tagItem.name ? null : tagItem
                                  )
                                }
                                className={`mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors ${
                                  isPreviewActive
                                    ? 'bg-[#f97316]/25 text-[#fb923c]'
                                    : 'text-slate-500 hover:bg-white/10 hover:text-slate-200'
                                }`}
                              >
                                <Info className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Live Translated Tag Description Preview (on hover, focus, or tap on info icon) */}
          {hoveredTag?.description && (
            <div
              data-testid="anilist-tag-description-preview"
              className="border-t border-white/10 bg-[#0b0e15] px-3 py-2 text-[11px] leading-snug text-slate-300"
            >
              <div className="mb-0.5 flex items-center justify-between gap-2">
                <span className="truncate font-semibold text-white">
                  {hoveredTag.label}
                  {hoveredTag.label.toLowerCase() !== hoveredTag.name.toLowerCase() && (
                    <span className="ml-1 font-normal text-slate-400">({hoveredTag.name})</span>
                  )}
                </span>
                <div className="flex shrink-0 items-center gap-1.5">
                  {hoveredTag.category && (
                    <span className="text-[10px] text-[#fb923c]/85">
                      {formatShortCategory(hoveredTag.category)}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => setHoveredTag(null)}
                    aria-label="Fechar descrição da tag"
                    className="rounded p-0.5 text-slate-500 hover:text-white"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              </div>
              <p className="text-slate-400">{hoveredTag.description}</p>
            </div>
          )}

          {/* Popover Footer */}
          <div className="flex items-center justify-between gap-2 border-t border-white/10 bg-[#0d1017] px-3 py-2 text-[11px] text-slate-400">
            <span className="tabular-nums">
              {totalSelected > 0
                ? `${totalSelected} selecionado${totalSelected === 1 ? '' : 's'}`
                : `${genres.length} gêneros · ${tags.length} tags`}
            </span>
            <div className="flex items-center gap-2">
              {totalSelected > 0 && (
                <button
                  type="button"
                  onClick={onClearAll}
                  className="font-medium text-[#fb923c] hover:text-white"
                >
                  Limpar
                </button>
              )}
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md border border-white/15 bg-white/5 px-2 py-0.5 font-medium text-slate-200 hover:border-white/30 hover:text-white"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
