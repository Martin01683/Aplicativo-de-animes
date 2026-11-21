import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shouldEnableDesktopShortcuts } from './nativeVlcPlayer.ts';

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
});
