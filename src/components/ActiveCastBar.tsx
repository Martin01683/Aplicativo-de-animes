import { Cast, ChevronUp, Loader2, Pause, Play, Square } from 'lucide-react';
import {
  formatCastDurationMs,
  formatCastStatusLabel,
  hasRemoteTvControls,
  tvCastPause,
  tvCastPlay,
  tvCastStop,
  type TvCastStateSnapshot,
} from '../lib/tvCast';

interface ActiveCastBarProps {
  castState: TvCastStateSnapshot;
  onOpenControls: () => void;
  onStop?: () => void;
}

export function ActiveCastBar({ castState, onOpenControls, onStop }: ActiveCastBarProps) {
  if (!castState.active) return null;

  const isPlaying =
    castState.status === 'playing' ||
    castState.status === 'buffering' ||
    castState.status === 'connecting';
  const showRemoteControls = hasRemoteTvControls(castState);

  const progressPct =
    castState.durationMs > 0
      ? Math.min(100, Math.max(0, (castState.positionMs / castState.durationMs) * 100))
      : 0;

  return (
    <div
      data-active-cast-bar="true"
      className="fixed bottom-[calc(68px+env(safe-area-inset-bottom))] left-3 right-3 z-[45] mx-auto max-w-2xl overflow-hidden rounded-xl border border-[#f97316]/55 bg-[#151921]/95 shadow-2xl shadow-black/60 backdrop-blur-md md:bottom-4 md:left-auto md:right-5 md:w-[410px]"
    >
      {castState.durationMs > 0 && (
        <div className="h-0.5 w-full bg-white/10">
          <div
            className="h-full bg-[#f97316] transition-[width] duration-300"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      )}
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button
          type="button"
          data-active-cast-open-controls="true"
          onClick={onOpenControls}
          aria-label="Abrir controles da transmissão na TV"
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg text-left transition-opacity hover:opacity-95"
        >
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[#f97316]/45 bg-[#f97316]/15 text-[#fb923c]">
            <Cast className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-bold text-white">
              {castState.episodeTitle || 'Transmitindo para TV'}
            </div>
            <div className="flex items-center gap-1.5 truncate text-[11px] text-slate-400">
              <span className="truncate text-[#fb923c]">{castState.deviceName}</span>
              <span>·</span>
              <span className="truncate tabular-nums">
                {castState.durationMs > 0
                  ? `${formatCastDurationMs(castState.positionMs)} / ${formatCastDurationMs(castState.durationMs)}`
                  : formatCastStatusLabel(castState.status)}
              </span>
            </div>
          </div>
        </button>

        <button
          type="button"
          onClick={onOpenControls}
          aria-label="Controles da TV"
          title="Abrir barra de tempo, volume e servidores da TV"
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-[#f97316]/40 bg-[#f97316]/12 px-2 text-[11px] font-semibold text-[#fb923c] hover:bg-[#f97316]/20"
        >
          <ChevronUp className="h-3.5 w-3.5" />
          <span className="hidden xs:inline sm:inline">Controles</span>
        </button>

        {showRemoteControls && (
          <button
            type="button"
            onClick={() => void (isPlaying ? tvCastPause() : tvCastPlay())}
            aria-label={isPlaying ? 'Pausar na TV' : 'Reproduzir na TV'}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#f97316] text-[#0d0f12] hover:bg-[#fb923c]"
          >
            {castState.status === 'connecting' || castState.status === 'buffering' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : isPlaying ? (
              <Pause className="h-4 w-4 fill-current" />
            ) : (
              <Play className="ml-0.5 h-4 w-4 fill-current" />
            )}
          </button>
        )}

        <button
          type="button"
          onClick={() => {
            void tvCastStop();
            onStop?.();
          }}
          aria-label="Parar transmissão na TV"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-300 hover:border-rose-400/50 hover:bg-rose-500/15 hover:text-rose-200"
        >
          <Square className="h-3.5 w-3.5 fill-current" />
        </button>
      </div>
    </div>
  );
}
