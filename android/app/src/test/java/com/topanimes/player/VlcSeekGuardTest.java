package com.topanimes.player;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class VlcSeekGuardTest {

    @Test
    public void forwardFiveSecondSeekIgnoresSynchronousVlcEchoAndKeyframePreroll() {
        // User at 60s taps +5s (or double-taps right) -> target 65s.
        // 1) VLC 3.0 TimeCallback() synchronously emits TimeChanged(65_000) while echo barrier is pending.
        assertFalse(
            VlcPlayerActivity.hasActiveSeekArrived(65_000L, 60_000L, 65_000L, 0L, true, false)
        );
        // 2) Even if a raced exact targetMs echo arrives immediately after barrier (< 220ms),
        //    it must NOT disarm the guard before pre-seek/preroll ticks drain.
        assertFalse(
            VlcPlayerActivity.hasActiveSeekArrived(65_000L, 60_000L, 65_000L, 15L, false, false)
        );
        // 3) Pre-seek tick (60.4s), MP4 preceding keyframe reset (60.0s), and preroll ticks (62.5s, 64.2s)
        //    must ALL be ignored so displayed time never snaps 01:05 -> 01:00 -> 01:05 or 01:05 -> 01:04 -> 01:05.
        assertFalse(VlcPlayerActivity.hasActiveSeekArrived(60_000L, 60_000L, 65_000L, 50L));
        assertFalse(VlcPlayerActivity.hasActiveSeekArrived(60_400L, 60_000L, 65_000L, 120L));
        assertFalse(VlcPlayerActivity.hasActiveSeekArrived(62_500L, 60_000L, 65_000L, 200L));
        assertFalse(VlcPlayerActivity.hasActiveSeekArrived(64_200L, 60_000L, 65_000L, 300L));

        // 4) Real playback arrival at >= 65s (display "01:05") is accepted cleanly.
        assertTrue(VlcPlayerActivity.hasActiveSeekArrived(65_000L, 60_000L, 65_000L, 250L));
        assertTrue(VlcPlayerActivity.hasActiveSeekArrived(65_150L, 60_000L, 65_000L, 180L));
        assertTrue(VlcPlayerActivity.hasActiveSeekArrived(65_400L, 60_000L, 65_000L, 350L));

        // 5) Phase-2 relaxed fallback (> 1800ms) still accepts a container that snapped to 64.2s,
        //    while STILL rejecting stale 60.0s origin ticks.
        assertFalse(VlcPlayerActivity.hasActiveSeekArrived(60_000L, 60_000L, 65_000L, 1_900L));
        assertTrue(VlcPlayerActivity.hasActiveSeekArrived(64_200L, 60_000L, 65_000L, 1_900L));
    }

    @Test
    public void fullVlc3025ForwardSeekTimelineNeverBouncesDisplayedClockBackward() {
        // Simulates the exact VLC 3.0.25 event sequence observed after mediaPlayer.setTime(65_000, false):
        //   t=0ms   (barrier=true):  65_000 (TimeCallback synchronous echo)
        //   t=5ms   (barrier=false): 65_000 (hypothetical raced echo)
        //   t=30ms  (barrier=false): 60_250 (in-flight pre-seek MainLoopStatistics)
        //   t=75ms  (barrier=false): 60_000 (mp4.c Seek to preceding keyframe + b_force_update)
        //   t=180ms (barrier=false): 62_800 (mid-preroll)
        //   t=320ms (barrier=false): 64_400 (late preroll, would display 01:04)
        //   t=450ms (barrier=false): 65_050 (real playback at target -> display 01:05)
        //   t=700ms (barrier=false): 65_300 (normal playback)
        //   t=1450ms(barrier=false): 66_050 (display 01:06)
        long originMs = 60_000L;
        long targetMs = 65_000L;
        long activeTargetMs = targetMs;
        long displayedMs = targetMs; // UI jumps immediately to 01:05 on user tap

        long[][] events = new long[][] {
            { 65_000L, 0L, 1L },
            { 65_000L, 5L, 0L },
            { 60_250L, 30L, 0L },
            { 60_000L, 75L, 0L },
            { 62_800L, 180L, 0L },
            { 64_400L, 320L, 0L },
            { 65_050L, 450L, 0L },
            { 65_300L, 700L, 0L },
            { 66_050L, 1450L, 0L },
        };

        for (long[] ev : events) {
            long timeMs = ev[0];
            long elapsedMs = ev[1];
            boolean barrier = ev[2] == 1L;
            if (activeTargetMs >= 0L) {
                if (VlcPlayerActivity.hasActiveSeekArrived(timeMs, originMs, activeTargetMs, elapsedMs, barrier, false)) {
                    activeTargetMs = -1L;
                } else {
                    // Ignored — displayedMs must stay >= 65_000 (never bounce back to 60_000!)
                    assertTrue("Displayed clock must remain at target while seek settles", displayedMs >= 65_000L);
                    continue;
                }
            }
            assertTrue(
                "Displayed clock jumped backward from " + displayedMs + "ms to " + timeMs + "ms",
                timeMs >= displayedMs
            );
            displayedMs = timeMs;
        }
        assertEquals(-1L, activeTargetMs);
        assertEquals(66_050L, displayedMs);
    }

    @Test
    public void backwardFiveSecondSeekIgnoresEchoStaleAheadAndEarlierKeyframePreroll() {
        // User at 65s taps -5s -> target 60s
        assertFalse(
            VlcPlayerActivity.hasActiveSeekArrived(60_000L, 65_000L, 60_000L, 0L, true, false)
        );
        assertFalse(
            VlcPlayerActivity.hasActiveSeekArrived(60_000L, 65_000L, 60_000L, 10L, false, false)
        );
        // Stale pre-seek ahead timestamps (65s) must be rejected
        assertFalse(VlcPlayerActivity.hasActiveSeekArrived(65_000L, 65_000L, 60_000L, 40L));
        assertFalse(VlcPlayerActivity.hasActiveSeekArrived(65_300L, 65_000L, 60_000L, 100L));
        assertFalse(VlcPlayerActivity.hasActiveSeekArrived(62_500L, 65_000L, 60_000L, 180L));
        // Preceding keyframe preroll (e.g. 52s -> 58s before 60s) must ALSO be rejected!
        assertFalse(VlcPlayerActivity.hasActiveSeekArrived(52_000L, 65_000L, 60_000L, 80L));
        assertFalse(VlcPlayerActivity.hasActiveSeekArrived(58_500L, 65_000L, 60_000L, 200L));

        // Real arrival at 60.0s..60.5s is accepted
        assertTrue(VlcPlayerActivity.hasActiveSeekArrived(60_500L, 65_000L, 60_000L, 220L));
        assertTrue(VlcPlayerActivity.hasActiveSeekArrived(60_000L, 65_000L, 60_000L, 250L));
        // Phase-2 relaxed fallback (> 1800ms) accepts slight keyframe landing at 59.2s
        assertTrue(VlcPlayerActivity.hasActiveSeekArrived(59_200L, 65_000L, 60_000L, 1_900L));
    }

    @Test
    public void largeSkipIntroAndStartupResumeSeeksBehaveCleanly() {
        // +85s Skip Intro (60s -> 145s)
        assertFalse(VlcPlayerActivity.hasActiveSeekArrived(60_300L, 60_000L, 145_000L, 80L));
        assertTrue(VlcPlayerActivity.hasActiveSeekArrived(145_100L, 60_000L, 145_000L, 350L));
        assertTrue(VlcPlayerActivity.hasActiveSeekArrived(144_200L, 60_000L, 145_000L, 1_900L));

        // Startup resume where origin == target (300s -> 300s) still rejects stale 0s frame
        assertFalse(VlcPlayerActivity.hasActiveSeekArrived(200L, 300_000L, 300_000L, 100L));
        assertTrue(VlcPlayerActivity.hasActiveSeekArrived(299_600L, 300_000L, 300_000L, 400L));
    }

    @Test
    public void bufferingExtendsSeekTimeoutAndHardTimeoutAlwaysReleasesGuard() {
        // Slow HTTP range seek actively buffering at 3.5s must NOT snap back to origin 60s
        assertFalse(
            VlcPlayerActivity.hasActiveSeekArrived(60_000L, 60_000L, 65_000L, 3_500L, false, true)
        );
        // Even at 6.5s while buffering, still protected
        assertFalse(
            VlcPlayerActivity.hasActiveSeekArrived(60_000L, 60_000L, 65_000L, 6_500L, false, true)
        );
        // Past buffering hard timeout (> 10s), always releases
        assertTrue(
            VlcPlayerActivity.hasActiveSeekArrived(60_000L, 60_000L, 65_000L, 10_500L, false, true)
        );
        // Past normal non-buffering timeout (> 5s), always releases
        assertTrue(VlcPlayerActivity.hasActiveSeekArrived(60_000L, 60_000L, 65_000L, 5_100L));
        assertTrue(VlcPlayerActivity.hasActiveSeekArrived(60_000L, -1L, -1L, 0L));
    }
}
