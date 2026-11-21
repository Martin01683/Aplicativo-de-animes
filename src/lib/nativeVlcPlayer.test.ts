import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

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

// Regression: switching focus to another Android app destroys SurfaceView surfaces and causes
// LibVLC's AWindow.onSurfaceDestroyed() to detach views and disable the video track. Returning
// to TopAnimes left the video black because VlcPlayerActivity never re-attached views or restored
// playback in onStart()/onResume().
describe('VlcPlayerActivity - Android focus & LibVLC surface lifecycle', () => {
  const activityJava = readFileSync(
    resolve(ROOT, 'android/app/src/main/java/com/topanimes/player/VlcPlayerActivity.java'),
    'utf-8'
  );

  it('detaches LibVLC views and stops playback cleanly in onStop()', () => {
    const onStopMatch = activityJava.match(/protected void onStop\(\)[\s\S]*?\r?\n {4}\}/);
    assert.ok(onStopMatch, 'missing onStop() lifecycle override');
    assert.match(onStopMatch[0], /mediaPlayer\.stop\(\)/);
    assert.match(onStopMatch[0], /mediaPlayer\.detachViews\(\)/);
    assert.match(onStopMatch[0], /shouldStartPlaybackOnStart\s*=\s*true/);
  });

  it('re-attaches LibVLC views and restores video scale + playback on foreground return', () => {
    const onStartMatch = activityJava.match(/protected void onStart\(\)[\s\S]*?\r?\n {4}\}/);
    assert.ok(onStartMatch, 'missing onStart() lifecycle override');
    assert.match(onStartMatch[0], /attachVideoViewsIfNeeded\(\)/);
    assert.match(onStartMatch[0], /restorePlaybackAfterForeground\(/);

    const onResumeMatch = activityJava.match(/protected void onResume\(\)[\s\S]*?\r?\n {4}\}/);
    assert.ok(onResumeMatch, 'missing onResume() lifecycle override');
    assert.match(onResumeMatch[0], /enterImmersiveMode\(\)/);
    assert.match(onResumeMatch[0], /attachVideoViewsIfNeeded\(\)/);

    const attachHelperMatch = activityJava.match(
      /private void attachVideoViewsIfNeeded\(\)[\s\S]*?\r?\n {4}\}/
    );
    assert.ok(attachHelperMatch, 'missing attachVideoViewsIfNeeded() helper');
    assert.match(attachHelperMatch[0], /!mediaPlayer\.getVLCVout\(\)\.areViewsAttached\(\)/);
    assert.match(
      attachHelperMatch[0],
      /mediaPlayer\.attachViews\(videoLayout,\s*null,\s*true,\s*false\)/
    );
    assert.match(
      attachHelperMatch[0],
      /mediaPlayer\.setVideoScale\(SCALE_OPTIONS\[currentScaleIdx\]\)/
    );
  });

  it('registers and removes IVLCVout.Callback and handles Event.Vout for surface recovery', () => {
    assert.match(activityJava, /mediaPlayer\.getVLCVout\(\)\.addCallback\(voutCallback\)/);
    assert.match(activityJava, /mediaPlayer\.getVLCVout\(\)\.removeCallback\(voutCallback\)/);
    assert.match(activityJava, /case MediaPlayer\.Event\.Vout:/);
    assert.match(activityJava, /public void onWindowFocusChanged\(boolean hasFocus\)/);
  });

  it('defers playback start if stream preparation completes while activity is stopped', () => {
    const prepMatch = activityJava.match(
      /private void prepareAndPlayCurrentStream\(boolean pauseAfterFirstFrame\)[\s\S]*?\r?\n {4}\}/
    );
    assert.ok(prepMatch, 'missing prepareAndPlayCurrentStream(boolean)');
    assert.match(prepMatch[0], /if\s*\(!isActivityStarted\)/);
    assert.match(prepMatch[0], /attachVideoViewsIfNeeded\(\)/);
  });
});


