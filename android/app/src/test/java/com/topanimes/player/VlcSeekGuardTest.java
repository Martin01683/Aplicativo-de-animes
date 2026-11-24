package com.topanimes.player;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class VlcSeekGuardTest {

    @Test
    public void forwardFiveSecondSeekIgnoresStalePreSeekTimeChanged() {
        // User at 60s double-taps right (+5s) -> target 65s
        assertFalse(VlcPlayerActivity.hasActiveSeekArrived(60_000L, 60_000L, 65_000L, 50L));
        assertFalse(VlcPlayerActivity.hasActiveSeekArrived(60_400L, 60_000L, 65_000L, 120L));
        assertFalse(VlcPlayerActivity.hasActiveSeekArrived(62_500L, 60_000L, 65_000L, 200L));

        // Real arrival around 65s is accepted
        assertTrue(VlcPlayerActivity.hasActiveSeekArrived(64_200L, 60_000L, 65_000L, 220L));
        assertTrue(VlcPlayerActivity.hasActiveSeekArrived(65_000L, 60_000L, 65_000L, 250L));
        assertTrue(VlcPlayerActivity.hasActiveSeekArrived(65_400L, 60_000L, 65_000L, 300L));
    }

    @Test
    public void backwardFiveSecondSeekIgnoresStaleAheadTimeChanged() {
        // User at 65s double-taps left (-5s) -> target 60s
        assertFalse(VlcPlayerActivity.hasActiveSeekArrived(65_000L, 65_000L, 60_000L, 40L));
        assertFalse(VlcPlayerActivity.hasActiveSeekArrived(65_300L, 65_000L, 60_000L, 100L));
        assertFalse(VlcPlayerActivity.hasActiveSeekArrived(62_500L, 65_000L, 60_000L, 180L));

        // Real arrival around 60s is accepted
        assertTrue(VlcPlayerActivity.hasActiveSeekArrived(60_500L, 65_000L, 60_000L, 220L));
        assertTrue(VlcPlayerActivity.hasActiveSeekArrived(60_000L, 65_000L, 60_000L, 250L));
        assertTrue(VlcPlayerActivity.hasActiveSeekArrived(59_200L, 65_000L, 60_000L, 260L));
    }

    @Test
    public void largeSkipIntroAndStartupResumeSeeksBehaveCleanly() {
        // +85s Skip Intro (60s -> 145s)
        assertFalse(VlcPlayerActivity.hasActiveSeekArrived(60_300L, 60_000L, 145_000L, 80L));
        assertTrue(VlcPlayerActivity.hasActiveSeekArrived(144_200L, 60_000L, 145_000L, 350L));

        // Startup resume where origin == target (300s -> 300s) still rejects stale 0s frame
        assertFalse(VlcPlayerActivity.hasActiveSeekArrived(200L, 300_000L, 300_000L, 100L));
        assertTrue(VlcPlayerActivity.hasActiveSeekArrived(299_500L, 300_000L, 300_000L, 400L));
    }

    @Test
    public void timeoutAlwaysReleasesActiveSeekGuard() {
        assertTrue(VlcPlayerActivity.hasActiveSeekArrived(60_000L, 60_000L, 65_000L, 2_600L));
        assertTrue(VlcPlayerActivity.hasActiveSeekArrived(60_000L, -1L, -1L, 0L));
    }
}
