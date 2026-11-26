import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APP_UPDATE_INTERVAL_OPTIONS,
  DEFAULT_APP_SETTINGS,
  EPISODE_CHECK_INTERVAL_OPTIONS,
  formatRelativeTimestamp,
  getEpisodeCheckIntervalMs,
  sanitizeAppSettings,
  shouldRunScheduledAppUpdateCheck,
} from './settings';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

test('sanitizeAppSettings falls back cleanly on invalid or partial input', () => {
  assert.equal(DEFAULT_APP_SETTINGS.episodeCheckIntervalMinutes, 15);
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
      videoScale: 'invalid-scale',
    }),
    {
      ...DEFAULT_APP_SETTINGS,
      notifyNewEpisodes: false,
      autoDownloadAppUpdates: true,
    }
  );
});

test('sanitizeAppSettings preserves valid user values and migrates legacy removed notification options safely', () => {
  const result = sanitizeAppSettings({
    episodeCheckIntervalMinutes: 15,
    checkEpisodesOnStartup: false,
    notifyNewEpisodes: false,
    showInAppEpisodeToasts: false,
    notificationSound: true,
    quietHoursEnabled: true,
    quietHoursStart: 22,
    quietHoursEnd: 7,
    notifyAudioFilter: 'LEG',
    autoCheckAppUpdates: true,
    checkAppUpdatesOnStartup: false,
    appUpdateIntervalHours: 6,
    autoDownloadAppUpdates: true,
    defaultSection: 'library',
    defaultAudioFilter: 'DUB',
    calendarLayout: 'timeline',
    skipIntroSeconds: 90,
    autoPlayNextEpisode: true,
    videoScale: 'fill',
  });

  assert.equal(result.episodeCheckIntervalMinutes, 15);
  assert.equal(result.checkEpisodesOnStartup, false);
  assert.equal(result.notifyNewEpisodes, false);
  assert.equal(result.showInAppEpisodeToasts, false);
  // Removed options always migrate cleanly to disabled so users aren't stuck with hidden toggles
  assert.equal(result.notificationSound, false);
  assert.equal(result.quietHoursEnabled, false);
  assert.equal(result.quietHoursStart, 22);
  assert.equal(result.quietHoursEnd, 7);
  assert.equal(result.notifyAudioFilter, 'LEG');
  assert.equal(result.checkAppUpdatesOnStartup, false);
  assert.equal(result.appUpdateIntervalHours, 6);
  assert.equal(result.autoDownloadAppUpdates, true);
  assert.equal(result.defaultSection, 'library');
  assert.equal(result.defaultAudioFilter, 'DUB');
  assert.equal(result.calendarLayout, 'timeline');
  assert.equal(sanitizeAppSettings({ calendarLayout: 'invalid' }).calendarLayout, 'grid');
  assert.equal(result.skipIntroSeconds, 90);
  assert.equal(result.autoPlayNextEpisode, true);
  assert.equal(result.videoScale, 'fill');
  assert.equal(DEFAULT_APP_SETTINGS.maxConcurrentDownloads, 1);
  assert.equal(sanitizeAppSettings({ maxConcurrentDownloads: 3 }).maxConcurrentDownloads, 3);
  assert.equal(sanitizeAppSettings({ maxConcurrentDownloads: 0 }).maxConcurrentDownloads, 1);
  assert.equal(sanitizeAppSettings({ maxConcurrentDownloads: 99 }).maxConcurrentDownloads, 5);
  assert.equal(sanitizeAppSettings({ maxConcurrentDownloads: 'bad' }).maxConcurrentDownloads, 1);

  // Legacy 1 min and 5 min intervals migrate safely to 15 min
  assert.equal(sanitizeAppSettings({ episodeCheckIntervalMinutes: 1 }).episodeCheckIntervalMinutes, 15);
  assert.equal(sanitizeAppSettings({ episodeCheckIntervalMinutes: 5 }).episodeCheckIntervalMinutes, 15);
  assert.deepEqual(
    EPISODE_CHECK_INTERVAL_OPTIONS.map((opt) => opt.value),
    [15, 30, 60, 0]
  );

  // Invalid quiet hours and audio filter fall back cleanly
  const badNotificationOpts = sanitizeAppSettings({
    quietHoursStart: 99,
    quietHoursEnd: -3,
    notifyAudioFilter: 'INVALID',
  });
  assert.equal(badNotificationOpts.quietHoursStart, DEFAULT_APP_SETTINGS.quietHoursStart);
  assert.equal(badNotificationOpts.quietHoursEnd, DEFAULT_APP_SETTINGS.quietHoursEnd);
  assert.equal(badNotificationOpts.notifyAudioFilter, 'ALL');

  // Legacy appUpdateIntervalHours: 0 migrates to checkAppUpdatesOnStartup: true + 24h periodic interval
  const migrated = sanitizeAppSettings({ appUpdateIntervalHours: 0 });
  assert.equal(migrated.checkAppUpdatesOnStartup, true);
  assert.equal(migrated.appUpdateIntervalHours, 24);

  // Dropdown options must only contain periodic frequencies (startup check is a separate toggle)
  assert.deepEqual(
    APP_UPDATE_INTERVAL_OPTIONS.map((opt) => opt.value),
    [6, 24, 168]
  );

  // SettingsModal omits removed options
  const modalTsx = readFileSync(resolve(ROOT, 'src/components/SettingsModal.tsx'), 'utf8');
  assert.doesNotMatch(modalTsx, /Som discreto ao chegar episódio novo/);
  assert.doesNotMatch(modalTsx, /Horário silencioso \(Não perturbe\)/);
});

test('getEpisodeCheckIntervalMs returns null for manual mode and ms otherwise', () => {
  assert.equal(getEpisodeCheckIntervalMs(0), null);
  assert.equal(getEpisodeCheckIntervalMs(15), 900_000);
  assert.equal(getEpisodeCheckIntervalMs(30), 1_800_000);
  assert.equal(getEpisodeCheckIntervalMs(60), 3_600_000);
});

test('shouldRunScheduledAppUpdateCheck separates startup check from periodic interval window', () => {
  const now = Date.parse('2026-11-21T12:00:00.000Z');

  // Both toggles disabled -> never runs
  assert.equal(
    shouldRunScheduledAppUpdateCheck(
      { autoCheckAppUpdates: false, checkAppUpdatesOnStartup: false, appUpdateIntervalHours: 24 },
      null,
      now,
      { isStartup: true }
    ),
    false
  );

  // Startup toggle enabled runs on startup even if periodic autoCheck is disabled or recently checked
  assert.equal(
    shouldRunScheduledAppUpdateCheck(
      { autoCheckAppUpdates: false, checkAppUpdatesOnStartup: true, appUpdateIntervalHours: 24 },
      '2026-11-21T11:59:00.000Z',
      now,
      { isStartup: true }
    ),
    true
  );

  // Startup toggle must NOT trigger periodic background checks while the app stays open
  assert.equal(
    shouldRunScheduledAppUpdateCheck(
      { autoCheckAppUpdates: true, checkAppUpdatesOnStartup: true, appUpdateIntervalHours: 24 },
      '2026-11-21T06:00:00.000Z',
      now
    ),
    false
  );

  // Periodic interval check with startup disabled waits for the configured window
  assert.equal(
    shouldRunScheduledAppUpdateCheck(
      { autoCheckAppUpdates: true, checkAppUpdatesOnStartup: false, appUpdateIntervalHours: 24 },
      '2026-11-21T06:00:00.000Z',
      now,
      { isStartup: true }
    ),
    false
  );

  assert.equal(
    shouldRunScheduledAppUpdateCheck(
      { autoCheckAppUpdates: true, checkAppUpdatesOnStartup: false, appUpdateIntervalHours: 24 },
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

test('App.tsx runs startup app update check at most once without callback dependency loops', () => {
  const appTsx = readFileSync(resolve(ROOT, 'src/App.tsx'), 'utf-8');
  assert.match(appTsx, /appUpdateResultRef\.current\?\.latestRelease/);
  assert.doesNotMatch(appTsx, /\[appUpdateResult,\s*markReleaseAcknowledged,\s*showToast\]/);
  assert.match(appTsx, /if\s*\(cancelled\s*\|\|\s*startupAppUpdateCheckedRef\.current\)\s*return;/);
  assert.match(appTsx, /if\s*\(checkingAppUpdateRef\.current\)\s*return;/);
  assert.match(appTsx, /updateToastNotifiedForRef\.current\s*!==\s*key/);
});
