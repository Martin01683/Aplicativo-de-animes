import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyTapSide,
  clearSeekOnlyState,
  createInitialDoubleTapSeekState,
  DOUBLE_TAP_WINDOW_MS,
  evaluateStageTap,
  resolvePlayerHudMode,
} from './playerDoubleTapSeek';

describe('playerDoubleTapSeek state machine', () => {
  it('classifies left, center, and right tap zones accurately', () => {
    assert.equal(classifyTapSide(0.1), 'left');
    assert.equal(classifyTapSide(0.37), 'left');
    assert.equal(classifyTapSide(0.5), 'center');
    assert.equal(classifyTapSide(0.63), 'right');
    assert.equal(classifyTapSide(0.95), 'right');
    assert.equal(classifyTapSide(Number.NaN), 'center');
  });

  it('defers single side tap and enters seek-only mode on second tap within window', () => {
    let state = createInitialDoubleTapSeekState();

    const tap1 = evaluateStageTap(state, 'right', 1000);
    assert.equal(tap1.action, 'defer-single-tap');
    assert.equal(tap1.deltaSeconds, 0);
    assert.equal(tap1.badgeLabel, null);
    assert.equal(tap1.nextState.seekOnlyHudActive, false);
    state = tap1.nextState;

    const tap2 = evaluateStageTap(state, 'right', 1000 + DOUBLE_TAP_WINDOW_MS - 40);
    assert.equal(tap2.action, 'double-tap-seek');
    assert.equal(tap2.deltaSeconds, 5);
    assert.equal(tap2.badgeLabel, '+5s');
    assert.equal(tap2.nextState.seekOnlyHudActive, true);
    assert.equal(tap2.nextState.seekStreakSide, 'right');
    assert.equal(tap2.nextState.seekStreakCount, 1);
  });

  it('accumulates seek streak on subsequent same-side taps even past double-tap window while seek-only HUD is active', () => {
    let state = createInitialDoubleTapSeekState();
    state = evaluateStageTap(state, 'left', 1000).nextState;

    const seek1 = evaluateStageTap(state, 'left', 1180);
    assert.equal(seek1.action, 'double-tap-seek');
    assert.equal(seek1.badgeLabel, '-5s');
    state = seek1.nextState;

    // 450ms later (> 320ms double-tap window, but still inside 850ms seek-only streak window)
    const seek2 = evaluateStageTap(state, 'left', 1630);
    assert.equal(seek2.action, 'double-tap-seek');
    assert.equal(seek2.deltaSeconds, -5);
    assert.equal(seek2.badgeLabel, '-10s');
    assert.equal(seek2.nextState.seekStreakCount, 2);
    assert.equal(seek2.nextState.seekOnlyHudActive, true);
    state = seek2.nextState;

    const seek3 = evaluateStageTap(state, 'left', 2000);
    assert.equal(seek3.action, 'double-tap-seek');
    assert.equal(seek3.badgeLabel, '-15s');
    assert.equal(seek3.nextState.seekStreakCount, 3);
  });

  it('switches direction cleanly when double-tapping the opposite side during an active streak', () => {
    let state = createInitialDoubleTapSeekState();
    state = evaluateStageTap(state, 'right', 1000).nextState;
    state = evaluateStageTap(state, 'right', 1150).nextState;
    assert.equal(state.seekStreakSide, 'right');
    assert.equal(state.seekStreakCount, 1);

    // First tap on opposite side defers without flashing full HUD
    const opp1 = evaluateStageTap(state, 'left', 1400);
    assert.equal(opp1.action, 'defer-single-tap');
    assert.equal(opp1.nextState.seekOnlyHudActive, true);
    state = opp1.nextState;

    // Second tap on opposite side switches direction to -5s
    const opp2 = evaluateStageTap(state, 'left', 1580);
    assert.equal(opp2.action, 'double-tap-seek');
    assert.equal(opp2.deltaSeconds, -5);
    assert.equal(opp2.badgeLabel, '-5s');
    assert.equal(opp2.nextState.seekStreakSide, 'left');
    assert.equal(opp2.nextState.seekStreakCount, 1);
    assert.equal(opp2.nextState.seekOnlyHudActive, true);
  });

  it('exits seek-only mode on center tap or timeout clear', () => {
    let state = createInitialDoubleTapSeekState();
    state = evaluateStageTap(state, 'right', 1000).nextState;
    state = evaluateStageTap(state, 'right', 1150).nextState;
    assert.equal(state.seekOnlyHudActive, true);

    const centerTap = evaluateStageTap(state, 'center', 1350);
    assert.equal(centerTap.action, 'toggle-controls-now');
    assert.equal(centerTap.nextState.seekOnlyHudActive, false);
    assert.equal(centerTap.nextState.seekStreakCount, 0);

    const cleared = clearSeekOnlyState(state);
    assert.equal(cleared.seekOnlyHudActive, false);
    assert.equal(cleared.seekStreakSide, null);
    assert.equal(cleared.seekStreakCount, 0);
  });

  it('resolves HUD mode so double-tap seek hides full controls even when paused or HUD was open', () => {
    assert.equal(
      resolvePlayerHudMode({
        controlsVisible: true,
        seekOnlyHudActive: true,
        playing: true,
        menuOpen: false,
        episodesOpen: false,
        useNativeVlc: false,
      }),
      'seek-only'
    );

    assert.equal(
      resolvePlayerHudMode({
        controlsVisible: false,
        seekOnlyHudActive: true,
        playing: false,
        menuOpen: false,
        episodesOpen: false,
        useNativeVlc: false,
      }),
      'seek-only'
    );

    assert.equal(
      resolvePlayerHudMode({
        controlsVisible: false,
        seekOnlyHudActive: false,
        playing: true,
        menuOpen: false,
        episodesOpen: false,
        useNativeVlc: false,
      }),
      'hidden'
    );

    assert.equal(
      resolvePlayerHudMode({
        controlsVisible: true,
        seekOnlyHudActive: false,
        playing: true,
        menuOpen: false,
        episodesOpen: false,
        useNativeVlc: false,
      }),
      'full'
    );
  });
});
