import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_APP_SETTINGS,
  formatRelativeTimestamp,
  getEpisodeCheckIntervalMs,
  sanitizeAppSettings,
  shouldRunScheduledAppUpdateCheck,
} from './settings';

test('sanitizeAppSettings falls back cleanly on invalid or partial input', () => {
  assert.deepEqual(sanitizeAppSettings(null), DEFAULT_APP_SETTINGS);
  assert.deepEqual(sanitizeAppSettings([]), DEFAULT_APP_SETTINGS);
  assert.deepEqual(
    sanitizeAppSettings({
      episodeCheckIntervalMinutes: 999,
      appUpdateIntervalHours: 999,
      defaultSection: 'invalid',
      defaultAudioFilter: 'BAD',
      skipIntroSeconds: 42,
      notifyNewEpisodes: false,
      autoDownloadAppUpdates: true,
    }),
    {
      ...DEFAULT_APP_SETTINGS,
      notifyNewEpisodes: false,
      autoDownloadAppUpdates: true,
    }
  );
});

test('sanitizeAppSettings preserves valid user values', () => {
  const result = sanitizeAppSettings({
    episodeCheckIntervalMinutes: 15,
    checkEpisodesOnStartup: false,
    notifyNewEpisodes: false,
    autoCheckAppUpdates: true,
    appUpdateIntervalHours: 6,
    autoDownloadAppUpdates: true,
    defaultSection: 'library',
    defaultAudioFilter: 'DUB',
    skipIntroSeconds: 90,
    autoPlayNextEpisode: true,
  });

  assert.equal(result.episodeCheckIntervalMinutes, 15);
  assert.equal(result.checkEpisodesOnStartup, false);
  assert.equal(result.notifyNewEpisodes, false);
  assert.equal(result.appUpdateIntervalHours, 6);
  assert.equal(result.autoDownloadAppUpdates, true);
  assert.equal(result.defaultSection, 'library');
  assert.equal(result.defaultAudioFilter, 'DUB');
  assert.equal(result.skipIntroSeconds, 90);
  assert.equal(result.autoPlayNextEpisode, true);
});

test('getEpisodeCheckIntervalMs returns null for manual mode and ms otherwise', () => {
  assert.equal(getEpisodeCheckIntervalMs(0), null);
  assert.equal(getEpisodeCheckIntervalMs(1), 60_000);
  assert.equal(getEpisodeCheckIntervalMs(15), 900_000);
  assert.equal(getEpisodeCheckIntervalMs(60), 3_600_000);
});

test('shouldRunScheduledAppUpdateCheck respects autoCheck toggle and interval window', () => {
  const now = Date.parse('2026-11-21T12:00:00.000Z');

  assert.equal(
    shouldRunScheduledAppUpdateCheck(
      { autoCheckAppUpdates: false, appUpdateIntervalHours: 0 },
      null,
      now
    ),
    false
  );

  assert.equal(
    shouldRunScheduledAppUpdateCheck(
      { autoCheckAppUpdates: true, appUpdateIntervalHours: 0 },
      '2026-11-21T11:59:00.000Z',
      now
    ),
    true
  );

  assert.equal(
    shouldRunScheduledAppUpdateCheck(
      { autoCheckAppUpdates: true, appUpdateIntervalHours: 24 },
      '2026-11-21T06:00:00.000Z',
      now
    ),
    false
  );

  assert.equal(
    shouldRunScheduledAppUpdateCheck(
      { autoCheckAppUpdates: true, appUpdateIntervalHours: 24 },
      '2026-11-20T11:00:00.000Z',
      now
    ),
    true
  );
});

test('formatRelativeTimestamp formats recent and null timestamps cleanly', () => {
  const now = Date.parse('2026-11-21T12:00:00.000Z');
  assert.equal(formatRelativeTimestamp(null, now), 'Ainda não verificado');
  assert.equal(formatRelativeTimestamp('2026-11-21T11:59:40.000Z', now), 'Agora mesmo');
  assert.equal(formatRelativeTimestamp('2026-11-21T11:45:00.000Z', now), 'Há 15 min');
  assert.equal(formatRelativeTimestamp('2026-11-21T09:00:00.000Z', now), 'Há 3 h');
});
