import { Cast, Loader2, Pause, Play, Square } from 'lucide-react';
import {
  formatCastDurationMs,
  formatCastStatusLabel,
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

  const progressPct =
    castState.durationMs > 0
      ? Math.min(100, Math.max(0, (castState.positionMs / castState.durationMs) * 100))
      : 0;

  return (
    <div
      data-active-cast-bar="true"
      className="fixed bottom-[64px] left-3 right-3 z-40 mx-auto max-w-2xl overflow-hidden rounded-xl border border-[#f97316]/45 bg-[#151921]/95 shadow-2xl backdrop-blur-md md:bottom-4 md:left-auto md:right-5 md:w-[390px]"
    >
      {castState.durationMs > 0 && (
        <div className="h-0.5 w-full bg-white/10">
          <div
            className="h-full bg-[#f97316] transition-[width] duration-300"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      )}
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <button
          type="button"
          onClick={onOpenControls}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
        >
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[#f97316]/40 bg-[#f97316]/15 text-[#fb923c]">
            <Cast className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-bold text-white">
              {castState.episodeTitle || 'Transmitindo para TV'}
            </div>
            <div className="flex items-center gap-1.5 truncate text-[11px] text-slate-400">
              <span className="truncate text-[#fb923c]">{castState.deviceName}</span>
              <span>·</span>
              <span className="truncate">
                {castState.durationMs > 0
                  ? `${formatCastDurationMs(castState.positionMs)} / ${formatCastDurationMs(castState.durationMs)}`
                  : formatCastStatusLabel(castState.status)}
              </span>
            </div>
          </div>
        </button>

        {castState.deliveryMode !== 'lan-link' && (
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
