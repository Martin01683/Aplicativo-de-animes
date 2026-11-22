export interface BufferedTimeRangeLike {
  length: number;
  start(index: number): number;
  end(index: number): number;
}

/**
 * Returns the furthest contiguous buffered timestamp (in seconds) covering the
 * current playback position, falling back to the nearest buffered range when
 * playback has not yet entered a range.
 */
export function resolveBufferedEndSec(
  buffered: BufferedTimeRangeLike | null | undefined,
  currentTimeSec: number,
  durationSec = 0,
): number {
  if (!buffered || buffered.length <= 0) {
    return 0;
  }

  const safeCurrent = Number.isFinite(currentTimeSec) && currentTimeSec > 0 ? currentTimeSec : 0;
  const toleranceSec = 0.5;
  let matchedEnd = -1;

  for (let i = 0; i < buffered.length; i += 1) {
    const start = buffered.start(i);
    const end = buffered.end(i);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    if (safeCurrent >= start - toleranceSec && safeCurrent <= end + toleranceSec) {
      if (end > matchedEnd) matchedEnd = end;
    }
  }

  if (matchedEnd < 0) {
    // Fallback to the earliest range ahead of playback (or last valid range)
    let fallbackEnd = 0;
    for (let i = 0; i < buffered.length; i += 1) {
      const start = buffered.start(i);
      const end = buffered.end(i);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      if (start >= safeCurrent) {
        fallbackEnd = end;
        break;
      }
      fallbackEnd = Math.max(fallbackEnd, end);
    }
    matchedEnd = fallbackEnd;
  }

  if (matchedEnd < 0) return 0;
  if (Number.isFinite(durationSec) && durationSec > 0) {
    return Math.min(durationSec, Math.max(0, matchedEnd));
  }
  return Math.max(0, matchedEnd);
}
