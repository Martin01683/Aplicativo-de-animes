export interface WebActiveSeekGuard {
  originSec: number;
  targetSec: number;
  issuedAtMs: number;
}

export const WEB_ACTIVE_SEEK_TIMEOUT_MS = 4500;

export function resolveSeekBaseTimeSec(
  videoCurrentTimeSec: number,
  activeGuard: WebActiveSeekGuard | null,
  nowMs: number,
  videoSeeking: boolean,
): number {
  if (
    activeGuard &&
    (videoSeeking || nowMs - activeGuard.issuedAtMs <= WEB_ACTIVE_SEEK_TIMEOUT_MS)
  ) {
    return activeGuard.targetSec;
  }
  return Number.isFinite(videoCurrentTimeSec) && videoCurrentTimeSec >= 0
    ? videoCurrentTimeSec
    : 0;
}

export function shouldAcceptWebTimeUpdate(
  reportedTimeSec: number,
  videoSeeking: boolean,
  activeGuard: WebActiveSeekGuard | null,
  nowMs: number,
): { accept: boolean; clearGuard: boolean } {
  if (!Number.isFinite(reportedTimeSec) || reportedTimeSec < 0) {
    return { accept: false, clearGuard: false };
  }
  if (!activeGuard) {
    return { accept: !videoSeeking, clearGuard: false };
  }
  const elapsedMs = nowMs - activeGuard.issuedAtMs;
  if (elapsedMs > WEB_ACTIVE_SEEK_TIMEOUT_MS && !videoSeeking) {
    return { accept: true, clearGuard: true };
  }
  if (videoSeeking) {
    return { accept: false, clearGuard: false };
  }

  const delta = activeGuard.targetSec - activeGuard.originSec;
  const dist = Math.abs(delta);
  const tightTolSec = Math.min(0.5, Math.max(0.25, dist / 4));
  const relaxedTolSec = Math.min(1.5, Math.max(tightTolSec, dist / 3));
  const targetFloorSec = Math.floor(activeGuard.targetSec);

  if (delta > 0) {
    if (dist < 1.5) {
      const arrived = reportedTimeSec >= Math.max(0, activeGuard.targetSec - tightTolSec);
      return { accept: arrived, clearGuard: arrived };
    }
    const lower =
      elapsedMs >= 1800
        ? activeGuard.targetSec - relaxedTolSec
        : Math.max(activeGuard.targetSec - tightTolSec, targetFloorSec);
    const minAcceptable = Math.max(activeGuard.originSec + Math.min(dist / 2, 1), lower);
    const arrived = reportedTimeSec >= minAcceptable;
    return { accept: arrived, clearGuard: arrived };
  }

  if (delta < 0) {
    if (dist < 1.5) {
      const arrived = reportedTimeSec <= activeGuard.targetSec + 1;
      return { accept: arrived, clearGuard: arrived };
    }
    const lower =
      elapsedMs >= 1800
        ? Math.max(0, activeGuard.targetSec - relaxedTolSec)
        : Math.max(0, Math.max(activeGuard.targetSec - tightTolSec, targetFloorSec));
    const upperTol =
      elapsedMs >= 1800 ? Math.max(1.5, relaxedTolSec) : Math.max(tightTolSec, 0.999);
    const maxAcceptable = Math.min(
      activeGuard.originSec - Math.min(dist / 2, 1),
      activeGuard.targetSec + upperTol,
    );
    const arrived = reportedTimeSec >= lower && reportedTimeSec <= maxAcceptable;
    return { accept: arrived, clearGuard: arrived };
  }

  const arrived = Math.abs(reportedTimeSec - activeGuard.targetSec) <= 1;
  return { accept: arrived, clearGuard: arrived };
}
