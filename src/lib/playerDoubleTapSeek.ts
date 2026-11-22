export type TapSide = 'left' | 'right' | 'center';
export type PlayerHudMode = 'full' | 'seek-only' | 'hidden';

export const DOUBLE_TAP_WINDOW_MS = 320;
export const SEEK_STREAK_TIMEOUT_MS = 850;
export const DOUBLE_TAP_STEP_SECONDS = 5;

export interface DoubleTapSeekState {
  lastTapTimeMs: number;
  lastTapSide: TapSide | null;
  seekStreakSide: 'left' | 'right' | null;
  seekStreakCount: number;
  seekOnlyHudActive: boolean;
}

export interface DoubleTapEvalResult {
  action: 'double-tap-seek' | 'toggle-controls-now' | 'defer-single-tap';
  nextState: DoubleTapSeekState;
  deltaSeconds: number;
  badgeLabel: string | null;
}

export function createInitialDoubleTapSeekState(): DoubleTapSeekState {
  return {
    lastTapTimeMs: 0,
    lastTapSide: null,
    seekStreakSide: null,
    seekStreakCount: 0,
    seekOnlyHudActive: false,
  };
}

export function classifyTapSide(relX: number, edgeThreshold = 0.38): TapSide {
  if (!Number.isFinite(relX)) return 'center';
  if (relX < edgeThreshold) return 'left';
  if (relX > 1 - edgeThreshold) return 'right';
  return 'center';
}

export function evaluateStageTap(
  state: DoubleTapSeekState,
  side: TapSide,
  nowMs: number,
  options?: {
    doubleTapWindowMs?: number;
    stepSeconds?: number;
  }
): DoubleTapEvalResult {
  const doubleTapWindowMs = options?.doubleTapWindowMs ?? DOUBLE_TAP_WINDOW_MS;
  const stepSeconds = options?.stepSeconds ?? DOUBLE_TAP_STEP_SECONDS;

  if (side === 'center') {
    return {
      action: 'toggle-controls-now',
      nextState: {
        lastTapTimeMs: nowMs,
        lastTapSide: 'center',
        seekStreakSide: null,
        seekStreakCount: 0,
        seekOnlyHudActive: false,
      },
      deltaSeconds: 0,
      badgeLabel: null,
    };
  }

  const isContinuingStreak =
    state.seekOnlyHudActive && state.seekStreakCount > 0 && state.seekStreakSide === side;
  const isDoubleTapOnSide =
    state.lastTapSide === side && nowMs - state.lastTapTimeMs <= doubleTapWindowMs;

  if (isContinuingStreak || isDoubleTapOnSide) {
    const nextCount = state.seekStreakSide === side ? state.seekStreakCount + 1 : 1;
    const totalSeconds = nextCount * stepSeconds;
    const deltaSeconds = side === 'left' ? -stepSeconds : stepSeconds;
    const badgeLabel = `${side === 'left' ? '-' : '+'}${totalSeconds}s`;

    return {
      action: 'double-tap-seek',
      nextState: {
        lastTapTimeMs: nowMs,
        lastTapSide: side,
        seekStreakSide: side,
        seekStreakCount: nextCount,
        seekOnlyHudActive: true,
      },
      deltaSeconds,
      badgeLabel,
    };
  }

  return {
    action: 'defer-single-tap',
    nextState: {
      ...state,
      lastTapTimeMs: nowMs,
      lastTapSide: side,
    },
    deltaSeconds: 0,
    badgeLabel: null,
  };
}

export function clearSeekOnlyState(state: DoubleTapSeekState): DoubleTapSeekState {
  return {
    ...state,
    seekStreakSide: null,
    seekStreakCount: 0,
    seekOnlyHudActive: false,
  };
}

export function resolvePlayerHudMode(params: {
  controlsVisible: boolean;
  seekOnlyHudActive: boolean;
  playing: boolean;
  menuOpen: boolean;
  episodesOpen: boolean;
  useNativeVlc: boolean;
}): PlayerHudMode {
  if (params.useNativeVlc || params.menuOpen || params.episodesOpen) {
    return 'full';
  }
  if (params.seekOnlyHudActive) {
    return 'seek-only';
  }
  if (params.controlsVisible || !params.playing) {
    return 'full';
  }
  return 'hidden';
}
