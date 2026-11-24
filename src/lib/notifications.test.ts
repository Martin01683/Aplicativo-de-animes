import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clearReadFavoriteAlerts,
  dismissSingleAlert,
  dismissToastItem,
  enqueueToastItem,
  filterFavoriteAlerts,
  formatHourLabel,
  isFavoriteMuted,
  isWithinQuietHours,
  markSingleAlertRead,
  pruneAlertsForRemovedFavorite,
  removeFavoriteMutedUrl,
  sanitizeHourValue,
  shouldRunCatchUpEpisodeCheck,
  toggleFavoriteMutedUrl,
  toggleSingleAlertRead,
  type AppNotificationToast,
} from './notifications';
import type { FavoriteAlertEntry } from './types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

function makeAlert(overrides: Partial<FavoriteAlertEntry> = {}): FavoriteAlertEntry {
  return {
    id: overrides.id || 'alert-1',
    animeUrl: overrides.animeUrl || 'https://topanimes.net/animes/frieren/',
    animeTitle: overrides.animeTitle || 'Frieren',
    episodeTitle: overrides.episodeTitle || 'Episódio 10',
    episodeUrl: overrides.episodeUrl || 'https://topanimes.net/episodio/frieren-episodio-10/',
    episodeLabel: overrides.episodeLabel || 'EP 10',
    poster: overrides.poster || 'https://example.com/p.jpg',
    detectedAt: overrides.detectedAt || '2026-11-22T10:00:00.000Z',
    read: overrides.read ?? false,
    audioType: overrides.audioType,
    sourceServerName: overrides.sourceServerName,
  };
}

test('sanitizeHourValue and formatHourLabel handle valid and invalid hours', () => {
  assert.equal(sanitizeHourValue(0, 23), 0);
  assert.equal(sanitizeHourValue(23.8, 8), 23);
  assert.equal(sanitizeHourValue(-1, 23), 23);
  assert.equal(sanitizeHourValue(24, 8), 8);
  assert.equal(sanitizeHourValue('bad', 22), 22);
  assert.equal(formatHourLabel(8), '08:00');
  assert.equal(formatHourLabel(23), '23:00');
});

test('isWithinQuietHours supports overnight, daytime, equal, and disabled ranges', () => {
  assert.equal(
    isWithinQuietHours(
      { quietHoursEnabled: false, quietHoursStart: 23, quietHoursEnd: 8 },
      new Date(2026, 10, 22, 2, 0)
    ),
    false
  );

  // Overnight 23:00 -> 08:00
  const overnight = { quietHoursEnabled: true, quietHoursStart: 23, quietHoursEnd: 8 };
  assert.equal(isWithinQuietHours(overnight, new Date(2026, 10, 22, 23, 30)), true);
  assert.equal(isWithinQuietHours(overnight, new Date(2026, 10, 22, 3, 15)), true);
  assert.equal(isWithinQuietHours(overnight, new Date(2026, 10, 22, 8, 0)), false);
  assert.equal(isWithinQuietHours(overnight, new Date(2026, 10, 22, 14, 0)), false);

  // Daytime 12:00 -> 14:00
  const daytime = { quietHoursEnabled: true, quietHoursStart: 12, quietHoursEnd: 14 };
  assert.equal(isWithinQuietHours(daytime, new Date(2026, 10, 22, 12, 0)), true);
  assert.equal(isWithinQuietHours(daytime, new Date(2026, 10, 22, 13, 59)), true);
  assert.equal(isWithinQuietHours(daytime, new Date(2026, 10, 22, 14, 0)), false);

  // Start === End disables window cleanly
  assert.equal(
    isWithinQuietHours(
      { quietHoursEnabled: true, quietHoursStart: 10, quietHoursEnd: 10 },
      new Date(2026, 10, 22, 10, 30)
    ),
    false
  );
});

test('shouldRunCatchUpEpisodeCheck respects manual mode and elapsed interval', () => {
  const now = Date.parse('2026-11-22T12:00:00.000Z');
  assert.equal(shouldRunCatchUpEpisodeCheck(0, null, now), false);
  assert.equal(shouldRunCatchUpEpisodeCheck(15, null, now), true);
  assert.equal(shouldRunCatchUpEpisodeCheck(15, '2026-11-22T11:50:00.000Z', now), false);
  assert.equal(shouldRunCatchUpEpisodeCheck(15, '2026-11-22T11:44:00.000Z', now), true);
});

test('alert management helpers filter, mark read, dismiss, clear read, and prune by favorite', () => {
  const a1 = makeAlert({ id: 'a1', read: false, animeUrl: 'https://topanimes.net/animes/frieren/' });
  const a2 = makeAlert({
    id: 'a2',
    read: true,
    animeUrl: 'https://topanimes.net/animes/solo-leveling/',
  });
  const list = [a1, a2];

  assert.equal(filterFavoriteAlerts(list, 'all').length, 2);
  assert.equal(filterFavoriteAlerts(list, 'unread').length, 1);
  assert.equal(filterFavoriteAlerts(list, 'episodes').length, 2);
  assert.equal(filterFavoriteAlerts(list, 'system').length, 0);

  const marked = markSingleAlertRead(list, 'a1');
  assert.equal(marked[0].read, true);
  assert.equal(markSingleAlertRead(marked, 'a1'), marked); // reference stable if already read

  const toggled = toggleSingleAlertRead(marked, 'a1');
  assert.equal(toggled[0].read, false);

  const dismissed = dismissSingleAlert(list, 'a1');
  assert.deepEqual(
    dismissed.map((x) => x.id),
    ['a2']
  );

  const clearedRead = clearReadFavoriteAlerts(list);
  assert.deepEqual(
    clearedRead.map((x) => x.id),
    ['a1']
  );

  const pruned = pruneAlertsForRemovedFavorite(list, 'https://topanimes.net/animes/frieren');
  assert.deepEqual(
    pruned.map((x) => x.id),
    ['a2']
  );
});

test('per-favorite mute helpers match normalized URLs and slugs reliably', () => {
  const url = 'https://topanimes.net/animes/solo-leveling/';
  const first = toggleFavoriteMutedUrl(url, []);
  assert.equal(first.muted, true);
  assert.equal(isFavoriteMuted('https://topanimes.net/animes/solo-leveling', first.nextMutedUrls), true);

  const second = toggleFavoriteMutedUrl('https://topanimes.net/animes/solo-leveling', first.nextMutedUrls);
  assert.equal(second.muted, false);
  assert.equal(second.nextMutedUrls.length, 0);

  const removed = removeFavoriteMutedUrl(url, first.nextMutedUrls);
  assert.equal(removed.length, 0);
});

test('toast queue deduplicates by dedupeKey, enforces max visible cap, and dismisses cleanly', () => {
  const t = (id: string, dedupeKey?: string): AppNotificationToast => ({
    id,
    kind: 'info',
    title: `Toast ${id}`,
    durationMs: 3000,
    dedupeKey,
  });

  let queue: AppNotificationToast[] = [];
  queue = enqueueToastItem(queue, t('1', 'ep-1'), 3);
  queue = enqueueToastItem(queue, t('2'), 3);
  queue = enqueueToastItem(queue, t('3', 'ep-1'), 3); // replaces '1'
  assert.deepEqual(
    queue.map((x) => x.id),
    ['2', '3']
  );

  queue = enqueueToastItem(queue, t('4'), 3);
  queue = enqueueToastItem(queue, t('5'), 3); // evicts oldest '2'
  assert.deepEqual(
    queue.map((x) => x.id),
    ['3', '4', '5']
  );

  queue = dismissToastItem(queue, '4');
  assert.deepEqual(
    queue.map((x) => x.id),
    ['3', '5']
  );
});

test('Android native notification bridge declares POST_NOTIFICATIONS, channels, and deep-link wiring', () => {
  const manifest = readFileSync(
    resolve(ROOT, 'android/app/src/main/AndroidManifest.xml'),
    'utf-8'
  );
  const plugin = readFileSync(
    resolve(ROOT, 'android/app/src/main/java/com/topanimes/player/LocalProxyPlugin.java'),
    'utf-8'
  );
  const mainActivity = readFileSync(
    resolve(ROOT, 'android/app/src/main/java/com/topanimes/player/MainActivity.java'),
    'utf-8'
  );

  const densities = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'];
  for (const density of densities) {
    const pngBytes = readFileSync(
      resolve(ROOT, `android/app/src/main/res/drawable-${density}/ic_stat_anisync.png`)
    );
    assert.ok(pngBytes.length > 200, `ic_stat_anisync.png (${density}) must be a valid non-empty PNG`);
    assert.equal(pngBytes[0], 0x89);
    assert.equal(pngBytes[1], 0x50);
    assert.equal(pngBytes[2], 0x4e);
    assert.equal(pngBytes[3], 0x47);
  }

  assert.match(manifest, /android\.permission\.POST_NOTIFICATIONS/);
  assert.match(plugin, /public void getNotificationPermission\(/);
  assert.match(plugin, /public void requestNotificationPermission\(/);
  assert.match(plugin, /public void showLocalNotification\(/);
  assert.match(plugin, /public void consumePendingNotificationTarget\(/);
  assert.match(plugin, /\.setSmallIcon\(R\.drawable\.ic_stat_anisync\)/);
  assert.match(plugin, /\.setColor\(0xFFF97316\)/);
  assert.doesNotMatch(plugin, /\.setSmallIcon\(R\.mipmap\.ic_launcher\)/);
  assert.doesNotMatch(plugin, /\.setLargeIcon\(/);
  assert.match(plugin, /anisync_episodes/);
  assert.match(plugin, /anisync_updates/);
  assert.match(mainActivity, /EXTRA_NOTIFICATION_URL/);
  assert.match(mainActivity, /consumePendingNotificationTarget/);
  assert.match(mainActivity, /__anisyncOpenNotificationTarget/);
});

test('Header settings gear hides update badge and update buttons jump directly to updates settings section', () => {
  const headerSource = readFileSync(resolve(ROOT, 'src/components/Header.tsx'), 'utf-8');
  const appSource = readFileSync(resolve(ROOT, 'src/App.tsx'), 'utf-8');
  const settingsModalSource = readFileSync(
    resolve(ROOT, 'src/components/SettingsModal.tsx'),
    'utf-8'
  );

  const settingsButtonChunk = headerSource.slice(headerSource.indexOf('<Settings className='));
  assert.doesNotMatch(settingsButtonChunk, /hasAppUpdate/);
  assert.match(appSource, /onOpenUpdateSettings=\{\(\) => openSettingsModal\('updates'\)\}/);
  assert.match(
    appSource,
    /if \(targetKind === 'settings'\) \{\s*openSettingsModal\('updates'\);/
  );
  assert.match(settingsModalSource, /focusSection === 'updates'/);
  assert.match(settingsModalSource, /id="settings-updates-panel"\s+ref=\{updatesPanelRef\}/);
});

