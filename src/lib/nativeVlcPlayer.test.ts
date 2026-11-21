import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyPlayerTapZone,
  classifyVerticalSwipeAction,
  computeSwipeBrightness,
  computeSwipeVolume,
  isSameEpisodeUrl,
  resolveSeriesPrevNext,
  shouldEnableDesktopShortcuts,
} from './nativeVlcPlayer.ts';
import type { AnimeEpisodeLink } from './types.ts';

describe('nativeVlcPlayer & platform guards', () => {
  it('disables desktop keyboard shortcuts inside the native Android APK', () => {
    assert.equal(
      shouldEnableDesktopShortcuts(
        true,
        'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36'
      ),
      false
    );
    assert.equal(
      shouldEnableDesktopShortcuts(true, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'),
      false
    );
  });

  it('disables desktop keyboard shortcuts on Android mobile browsers', () => {
    assert.equal(
      shouldEnableDesktopShortcuts(
        false,
        'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36'
      ),
      false
    );
  });

  it('enables desktop keyboard shortcuts on desktop web browsers', () => {
    assert.equal(
      shouldEnableDesktopShortcuts(
        false,
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36'
      ),
      true
    );
    assert.equal(
      shouldEnableDesktopShortcuts(
        false,
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15'
      ),
      true
    );
  });

  it('matches episode URLs across trailing slashes and http/https variants', () => {
    assert.equal(
      isSameEpisodeUrl(
        'https://topanimes.net/episodio/frieren-episodio-5/',
        'http://www.topanimes.net/episodio/frieren-episodio-5'
      ),
      true
    );
    assert.equal(
      isSameEpisodeUrl(
        'https://topanimes.net/episodio/frieren-episodio-5/',
        'https://topanimes.net/episodio/frieren-episodio-6/'
      ),
      false
    );
  });

  it('resolves adjacent prev/next episodes for both ascending and descending episode lists', () => {
    const asc: AnimeEpisodeLink[] = [
      { numberLabel: '1', episodeNumber: 1, title: 'Ep 1', url: 'https://topanimes.net/episodio/a-ep-1/' },
      { numberLabel: '2', episodeNumber: 2, title: 'Ep 2', url: 'https://topanimes.net/episodio/a-ep-2/' },
      { numberLabel: '3', episodeNumber: 3, title: 'Ep 3', url: 'https://topanimes.net/episodio/a-ep-3/' },
    ];
    assert.deepEqual(resolveSeriesPrevNext(asc, 'https://topanimes.net/episodio/a-ep-2'), {
      currentIndex: 1,
      prevUrl: 'https://topanimes.net/episodio/a-ep-1/',
      nextUrl: 'https://topanimes.net/episodio/a-ep-3/',
    });

    const desc: AnimeEpisodeLink[] = [...asc].reverse();
    assert.deepEqual(resolveSeriesPrevNext(desc, 'https://topanimes.net/episodio/a-ep-2/'), {
      currentIndex: 1,
      prevUrl: 'https://topanimes.net/episodio/a-ep-1/',
      nextUrl: 'https://topanimes.net/episodio/a-ep-3/',
    });
  });

  it('classifies left/center/right tap zones and vertical brightness vs volume sides', () => {
    assert.equal(classifyPlayerTapZone(120, 1000), 'left');
    assert.equal(classifyPlayerTapZone(500, 1000), 'center');
    assert.equal(classifyPlayerTapZone(820, 1000), 'right');
    assert.equal(classifyVerticalSwipeAction(300, 1000), 'brightness');
    assert.equal(classifyVerticalSwipeAction(600, 1000), 'volume');
  });

  it('computes clamped brightness and volume deltas cleanly for upward/downward swipes', () => {
    assert.ok(Math.abs(computeSwipeBrightness(0.5, -100, 400) - 0.75) < 0.001);
    assert.equal(computeSwipeBrightness(0.1, 200, 400), 0.01);
    assert.equal(computeSwipeBrightness(0.9, -200, 400), 1);

    assert.deepEqual(computeSwipeVolume(8, 15, -100, 300), {
      volume: 13,
      percent: 87,
      muted: false,
    });
    assert.deepEqual(computeSwipeVolume(3, 15, 300, 300), {
      volume: 0,
      percent: 0,
      muted: true,
    });
  });
});

