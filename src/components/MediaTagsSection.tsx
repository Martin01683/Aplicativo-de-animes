import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Info,
  Tag,
  X,
} from 'lucide-react';
import type { AnimeMediaTag } from '../lib/types';

interface MediaTagsSectionProps {
  tags?: readonly AnimeMediaTag[];
  resetKey: string;
}

const INITIAL_VISIBLE_REGULAR_TAGS = 9;

export function MediaTagsSection({ tags, resetKey }: MediaTagsSectionProps) {
  const [showAllRegular, setShowAllRegular] = useState(false);
  const [showSpoilers, setShowSpoilers] = useState(false);
  const [showRankInfo, setShowRankInfo] = useState(false);
  const [activeTag, setActiveTag] = useState<AnimeMediaTag | null>(null);

  useEffect(() => {
    setShowAllRegular(false);
    setShowSpoilers(false);
    setShowRankInfo(false);
    setActiveTag(null);
  }, [resetKey]);

  const { regularTags, spoilerTags, hasRankedTags } = useMemo(() => {
    const list = Array.isArray(tags) ? tags : [];
    const regular: AnimeMediaTag[] = [];
    const spoilers: AnimeMediaTag[] = [];
    let ranked = false;
    for (const tag of list) {
      if (typeof tag.rank === 'number' && tag.rank > 0) ranked = true;
      if (tag.isSpoiler) spoilers.push(tag);
      else regular.push(tag);
    }
    return { regularTags: regular, spoilerTags: spoilers, hasRankedTags: ranked };
  }, [tags]);

  if (regularTags.length === 0 && spoilerTags.length === 0) {
    return null;
  }

  const visibleRegularTags = showAllRegular
    ? regularTags
    : regularTags.slice(0, INITIAL_VISIBLE_REGULAR_TAGS);
  const hiddenRegularCount = Math.max(0, regularTags.length - visibleRegularTags.length);

  const renderActiveTagDetail = (visibilityClass = '') => {
    if (!activeTag) return null;
    return (
      <div
        data-testid="media-tag-detail-box"
        className={`rounded-lg border border-white/10 bg-[#090b10] px-3 py-2.5 text-xs leading-relaxed text-slate-300 ${visibilityClass}`}
      >
        <div className="mb-1 flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-semibold text-white">{activeTag.label}</span>
            {activeTag.label.toLowerCase() !== activeTag.name.toLowerCase() && (
              <span className="text-[11px] text-slate-500">
                ({activeTag.name})
              </span>
            )}
            {typeof activeTag.rank === 'number' && activeTag.rank > 0 && (
              <span className="font-mono text-[11px] font-medium tabular-nums text-[#fdba74]">
                · {activeTag.rank}% de relevância
              </span>
            )}
            {activeTag.isSpoiler && (
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-300">
                <AlertTriangle className="h-3 w-3 shrink-0" />
                Spoiler
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => setActiveTag(null)}
            aria-label="Fechar detalhes da tag"
            className="shrink-0 rounded p-0.5 text-slate-500 transition-colors hover:text-white"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <p className="text-[11.5px] leading-relaxed text-slate-400">
          {activeTag.description || 'Tag oficial do catálogo AniList.'}
        </p>
      </div>
    );
  };

  const renderTagTile = (tag: AnimeMediaTag) => {
    const isSelected = activeTag?.name === tag.name;
    const rank =
      typeof tag.rank === 'number' && tag.rank > 0
        ? Math.min(100, Math.max(0, Math.round(tag.rank)))
        : null;
    const tooltip = [
      tag.label !== tag.name ? `${tag.label} (${tag.name})` : tag.label,
      tag.isSpoiler ? '[Spoiler]' : '',
      rank !== null ? `Relevância: ${rank}%` : '',
      tag.description || '',
    ]
      .filter(Boolean)
      .join(' · ');

    return (
      <div key={tag.name} className="min-w-0 space-y-1.5">
        <button
          type="button"
          data-media-tag={tag.name}
          data-spoiler-tag={tag.isSpoiler ? 'true' : 'false'}
          title={tooltip}
          aria-pressed={isSelected}
          onClick={() =>
            setActiveTag((prev) => (prev?.name === tag.name ? null : tag))
          }
          className={`group relative flex w-full min-w-0 items-center justify-between gap-2 overflow-hidden rounded-lg border px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#f97316] ${
            tag.isSpoiler
              ? isSelected
                ? 'border-amber-400/65 bg-amber-500/18 text-amber-100'
                : 'border-amber-500/25 bg-amber-500/[0.07] text-amber-100/90 hover:border-amber-400/45 hover:bg-amber-500/[0.12]'
              : isSelected
                ? 'border-[#f97316]/60 bg-[#f97316]/14 text-white'
                : 'border-white/[0.07] bg-white/[0.025] text-slate-200 hover:border-white/18 hover:bg-white/[0.055] hover:text-white'
          }`}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            {tag.isSpoiler && (
              <AlertTriangle className="h-3 w-3 shrink-0 text-amber-400" />
            )}
            <span className="truncate text-[11.5px] font-medium leading-tight">
              {tag.label}
            </span>
          </span>

          {rank !== null && (
            <span
              className={`shrink-0 font-mono text-[10.5px] font-semibold tabular-nums ${
                tag.isSpoiler
                  ? 'text-amber-300/85'
                  : isSelected
                    ? 'text-[#fdba74]'
                    : 'text-slate-400 group-hover:text-slate-300'
              }`}
            >
              {rank}%
            </span>
          )}

          {rank !== null && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] bg-white/[0.04]"
            >
              <span
                className={`block h-full transition-opacity ${
                  tag.isSpoiler
                    ? 'bg-amber-400/65'
                    : isSelected
                      ? 'bg-[#f97316]'
                      : 'bg-[#f97316]/45 group-hover:bg-[#f97316]/75'
                }`}
                style={{ width: `${rank}%` }}
              />
            </span>
          )}
        </button>

        {isSelected && renderActiveTagDetail('sm:hidden')}
      </div>
    );
  };

  return (
    <div
      data-testid="media-tags-section"
      className="overflow-hidden rounded-xl border border-white/8 bg-[#0d0f12]/60"
    >
      {/* Structured Header matching Informações */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/8 px-3.5 py-2">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
            <Tag className="h-3 w-3 text-[#f97316]" />
            <span>Tags</span>
          </span>
          <span className="text-[10px] font-medium tabular-nums text-slate-500">
            {regularTags.length} {regularTags.length === 1 ? 'tema' : 'temas'}
            {spoilerTags.length > 0
              ? ` · ${spoilerTags.length} ${spoilerTags.length === 1 ? 'spoiler' : 'spoilers'}`
              : ''}
          </span>
        </div>

        {spoilerTags.length > 0 && (
          <button
            type="button"
            data-testid="toggle-spoiler-tags"
            aria-expanded={showSpoilers}
            onClick={() => {
              setShowSpoilers((prev) => {
                const next = !prev;
                if (!next && activeTag?.isSpoiler) {
                  setActiveTag(null);
                }
                return next;
              });
            }}
            className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors ${
              showSpoilers
                ? 'border-amber-500/45 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25'
                : 'border-amber-500/25 bg-amber-500/[0.06] text-amber-300/90 hover:border-amber-400/45 hover:bg-amber-500/14 hover:text-amber-200'
            }`}
          >
            {showSpoilers ? (
              <>
                <EyeOff className="h-3 w-3 shrink-0" />
                <span>Ocultar spoilers</span>
              </>
            ) : (
              <>
                <Eye className="h-3 w-3 shrink-0" />
                <span>
                  Mostrar {spoilerTags.length}{' '}
                  {spoilerTags.length === 1 ? 'spoiler' : 'spoilers'}
                </span>
              </>
            )}
          </button>
        )}
      </div>

      {/* Percentage Explanation Bar at Top */}
      {hasRankedTags && (
        <div className="space-y-2 border-b border-white/8 bg-white/[0.02] px-3.5 py-2 text-[11px]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              data-testid="tag-rank-info-toggle"
              aria-expanded={showRankInfo}
              onClick={() => setShowRankInfo((prev) => !prev)}
              className="inline-flex items-center gap-1.5 text-left text-slate-400 transition-colors hover:text-slate-200"
            >
              <Info className="h-3 w-3 shrink-0 text-slate-500" />
              <span>
                <span className="font-mono text-slate-300">%</span> indica a relevância
                do tema na obra (AniList)
              </span>
            </button>
            <span className="hidden text-[10.5px] text-slate-500 sm:inline">
              Clique em uma tag para ver a descrição
            </span>
          </div>

          {showRankInfo && (
            <div
              data-testid="tag-rank-info-box"
              className="flex items-start justify-between gap-2.5 rounded-lg border border-white/10 bg-[#090b10] px-3 py-2 text-[11.5px] leading-relaxed text-slate-400"
            >
              <p>
                A porcentagem (<span className="font-mono text-slate-200">%</span>) e a
                barra em cada tag indicam o grau de relevância desse tema para a obra
                segundo os votos da comunidade do AniList — quanto maior o valor, mais
                forte é a presença dele no anime.
              </p>
              <button
                type="button"
                onClick={() => setShowRankInfo(false)}
                aria-label="Fechar explicação da porcentagem"
                className="shrink-0 rounded p-0.5 text-slate-500 transition-colors hover:text-white"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      )}

      {/* Organized Tag Grids */}
      <div className="space-y-3 px-3.5 py-3">
        {visibleRegularTags.length > 0 && (
          <div className="space-y-2">
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
              {visibleRegularTags.map(renderTagTile)}
            </div>

            {activeTag && !activeTag.isSpoiler && renderActiveTagDetail('hidden sm:block')}

            {regularTags.length > INITIAL_VISIBLE_REGULAR_TAGS && (
              <div className="flex justify-start">
                <button
                  type="button"
                  data-testid="toggle-more-tags"
                  onClick={() => setShowAllRegular((prev) => !prev)}
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-400 transition-colors hover:text-[#fb923c]"
                >
                  {showAllRegular ? (
                    <>
                      <ChevronUp className="h-3.5 w-3.5" />
                      <span>Mostrar menos tags</span>
                    </>
                  ) : (
                    <>
                      <ChevronDown className="h-3.5 w-3.5" />
                      <span>
                        Ver mais {hiddenRegularCount}{' '}
                        {hiddenRegularCount === 1 ? 'tag' : 'tags'}
                      </span>
                    </>
                  )}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Separated Spoiler Section (hidden by default) */}
        {showSpoilers && spoilerTags.length > 0 && (
          <div
            data-testid="spoiler-tags-group"
            className={`space-y-2 ${
              visibleRegularTags.length > 0
                ? 'border-t border-amber-500/15 pt-2.5'
                : ''
            }`}
          >
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-amber-300/80">
              <AlertTriangle className="h-3 w-3 shrink-0 text-amber-400" />
              <span>Tags com spoiler</span>
            </div>
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
              {spoilerTags.map(renderTagTile)}
            </div>

            {activeTag && activeTag.isSpoiler && renderActiveTagDetail('hidden sm:block')}
          </div>
        )}
      </div>
    </div>
  );
}
