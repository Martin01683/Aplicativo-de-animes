import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveSeekBaseTimeSec,
  shouldAcceptWebTimeUpdate,
  WEB_ACTIVE_SEEK_TIMEOUT_MS,
  type WebActiveSeekGuard,
} from './playerSeekGuard.ts';

describe('playerSeekGuard (web +5s/-5s & scrub anti-bounce guard)', () => {
  it('blocks stale timeupdate events during video.seeking and before arrival on +5s forward seek', () => {
    const t0 = 10_000;
    const guard: WebActiveSeekGuard = {
      originSec: 60,
      targetSec: 65,
      issuedAtMs: t0,
    };

    // While browser/HLS is still seeking, all timeupdates are ignored
    assert.deepEqual(shouldAcceptWebTimeUpdate(60.2, true, guard, t0 + 40), {
      accept: false,
      clearGuard: false,
    });
    assert.deepEqual(shouldAcceptWebTimeUpdate(65.0, true, guard, t0 + 80), {
      accept: false,
      clearGuard: false,
    });

    // Even if seeking flag clears momentarily before HLS finishes repositioning, stale origin/preroll is rejected
    assert.deepEqual(shouldAcceptWebTimeUpdate(60.1, false, guard, t0 + 150), {
      accept: false,
      clearGuard: false,
    });
    assert.deepEqual(shouldAcceptWebTimeUpdate(64.2, false, guard, t0 + 300), {
      accept: false,
      clearGuard: false,
    });

    // Real arrival at >= 65.0s accepts and clears the guard cleanly
    assert.deepEqual(shouldAcceptWebTimeUpdate(65.05, false, guard, t0 + 420), {
      accept: true,
      clearGuard: true,
    });
  });

  it('anchors rapid consecutive +5s taps on the active seek target instead of a lagging video.currentTime', () => {
    const t0 = 20_000;
    const guard: WebActiveSeekGuard = {
      originSec: 60,
      targetSec: 65,
      issuedAtMs: t0,
    };

    // Even if video.currentTime momentarily reports 60s while seeking, the next +5s anchors at 65s -> 70s
    assert.equal(resolveSeekBaseTimeSec(60, guard, t0 + 120, true), 65);
    assert.equal(resolveSeekBaseTimeSec(60, guard, t0 + 250, false), 65);

    // After guard expires and video is no longer seeking, normal video.currentTime is used
    assert.equal(
      resolveSeekBaseTimeSec(72.4, guard, t0 + WEB_ACTIVE_SEEK_TIMEOUT_MS + 100, false),
      72.4,
    );
  });

  it('rejects both stale ahead times and earlier keyframe preroll times on -5s backward seek', () => {
    const t0 = 30_000;
    const guard: WebActiveSeekGuard = {
      originSec: 65,
      targetSec: 60,
      issuedAtMs: t0,
    };

    assert.deepEqual(shouldAcceptWebTimeUpdate(65.1, false, guard, t0 + 100), {
      accept: false,
      clearGuard: false,
    });
    assert.deepEqual(shouldAcceptWebTimeUpdate(54.0, false, guard, t0 + 150), {
      accept: false,
      clearGuard: false,
    });
    assert.deepEqual(shouldAcceptWebTimeUpdate(60.2, false, guard, t0 + 300), {
      accept: true,
      clearGuard: true,
    });
  });
});
