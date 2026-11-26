import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  buildAnisyncBackupPayload,
  buildBackupFilename,
  mergeAnisyncBackupData,
  parseAnisyncBackupJson,
  serializeAnisyncBackup,
  type AnisyncBackupData,
} from './backup.ts';
import { parseReleaseChangelog } from './changelogParser.ts';
import {
  clearTitleTranslationCache,
  GOOGLE_DICT_TRANSLATE_ENDPOINT,
  GOOGLE_TRANSLATE_ENDPOINT,
  isGoogleEndpointResting,
  parseGoogleDictBatchResponse,
  resetGoogleTranslateState,
  translateEnglishToPtBr,
  translateTitlesBatchToPtBr,
} from './googleTranslate.ts';
import {
  createResilientHttpFetcher,
  HostFailureTracker,
  isTransientHttpStatus,
  isTransientNetworkError,
  parseRetryAfterMs,
} from './hostResilience.ts';
import type { HttpFetcher, HttpFetchOptions } from './httpTypes.ts';
import { DEFAULT_APP_SETTINGS } from './settings.ts';

function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), 'utf8');
}

describe('App resilience, backup, changelog, and updater enhancements', () => {
  it('fails over from Google GTX to clients5 dict-chrome-ex on HTTP 429 and rests the rate-limited endpoint', async () => {
    clearTitleTranslationCache();
    resetGoogleTranslateState();

    const calls: Array<{ url: string; options?: HttpFetchOptions }> = [];
    const fetchHttp: HttpFetcher = async (url, options) => {
      calls.push({ url, options });
      if (url.startsWith(GOOGLE_TRANSLATE_ENDPOINT)) {
        return { status: 429, ok: false, finalUrl: url, body: 'Too Many Requests' };
      }
      if (url.startsWith(GOOGLE_DICT_TRANSLATE_ENDPOINT)) {
        const params = new URLSearchParams(options?.body || '');
        const queries = params.getAll('q');
        return {
          status: 200,
          ok: true,
          finalUrl: url,
          body: JSON.stringify(queries.map((q) => [`PT:${q}`, 'en'])),
        };
      }
      return { status: 404, ok: false, finalUrl: url, body: '' };
    };

    const synopsis = await translateEnglishToPtBr(fetchHttp, 'A mage travels north after victory.');
    assert.equal(synopsis, 'PT:A mage travels north after victory.');
    assert.equal(isGoogleEndpointResting('gtx'), true);
    assert.equal(isGoogleEndpointResting('dict'), false);

    // Second request goes directly to clients5 without hitting resting GTX
    const callsBeforeBatch = calls.length;
    const batch = await translateTitlesBatchToPtBr(
      fetchHttp,
      ['The Journey Begins', 'Beyond the Horizon'],
      { useCache: false }
    );
    assert.equal(batch.get('The Journey Begins'), 'PT:The Journey Begins');
    assert.equal(batch.get('Beyond the Horizon'), 'PT:Beyond the Horizon');

    const batchCalls = calls.slice(callsBeforeBatch);
    assert.equal(
      batchCalls.some((c) => c.url.startsWith(GOOGLE_TRANSLATE_ENDPOINT)),
      false,
      'GTX should be skipped while resting after 429'
    );
    assert.equal(
      batchCalls.some((c) => c.url.startsWith(GOOGLE_DICT_TRANSLATE_ENDPOINT)),
      true
    );

    assert.deepEqual(parseGoogleDictBatchResponse('["Um","Dois"]', 2), ['Um', 'Dois']);
    assert.deepEqual(parseGoogleDictBatchResponse('[["Um","en"],["Dois","ja"]]', 2), ['Um', 'Dois']);
    assert.equal(parseGoogleDictBatchResponse('["Só um"]', 2), null);

    clearTitleTranslationCache();
  });

  it('tracks failing hosts with HostFailureTracker, retries transient GET errors with jitter, and honors Retry-After', async () => {
    let clock = 10_000;
    const tracker = new HostFailureTracker(60_000, () => clock);
    assert.equal(tracker.isFailing('down.example.com'), false);
    tracker.markFailed('down.example.com');
    assert.equal(tracker.isFailing('DOWN.EXAMPLE.COM'), true);
    clock += 60_000;
    assert.equal(tracker.isFailing('down.example.com'), false);

    assert.equal(isTransientHttpStatus(503), true);
    assert.equal(isTransientHttpStatus(408), true);
    assert.equal(isTransientHttpStatus(404), false);
    assert.equal(isTransientHttpStatus(403), false);
    assert.equal(parseRetryAfterMs('2', 0, 10_000), 2000);
    assert.equal(parseRetryAfterMs('999', 0, 4000), 4000);
    assert.equal(isTransientNetworkError(new Error('socket hang up')), true);
    assert.equal(isTransientNetworkError(new Error('URL externa bloqueada por segurança.')), false);

    // 1. Transient 503 recovers on retry 2
    const sleeps: number[] = [];
    let attemptCount = 0;
    const resilient = createResilientHttpFetcher(
      async (url) => {
        attemptCount += 1;
        if (url.includes('flaky.example.com')) {
          if (attemptCount === 1) return { status: 503, ok: false, finalUrl: url, body: 'unavailable' };
          return { status: 200, ok: true, finalUrl: url, body: 'ok' };
        }
        if (url.includes('limited.example.com')) {
          if (attemptCount === 3) {
            return { status: 429, ok: false, finalUrl: url, body: 'slow down', retryAfter: '1' };
          }
          return { status: 200, ok: true, finalUrl: url, body: 'passed' };
        }
        if (url.includes('dead.example.com')) {
          throw new Error('connect ETIMEDOUT');
        }
        return { status: 404, ok: false, finalUrl: url, body: 'not found' };
      },
      {
        tracker: new HostFailureTracker(60_000, () => clock),
        maxAttempts: 2,
        initialDelayMs: 200,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        random: () => 0,
        now: () => clock,
      }
    );

    const flakyRes = await resilient('https://flaky.example.com/page');
    assert.equal(flakyRes.status, 200);
    assert.equal(attemptCount, 2);
    assert.deepEqual(sleeps, [200]);

    // 2. 429 respects Retry-After
    const limitedRes = await resilient('https://limited.example.com/api');
    assert.equal(limitedRes.status, 200);
    assert.equal(sleeps[sleeps.length - 1], 1000);

    // 3. Dead host burns 2 attempts once, then trips circuit breaker -> 1 fast attempt on follow-up
    const beforeDead = attemptCount;
    await assert.rejects(() => resilient('https://dead.example.com/a'));
    assert.equal(attemptCount - beforeDead, 2);

    const beforeSecondDead = attemptCount;
    await assert.rejects(() => resilient('https://dead.example.com/b'));
    assert.equal(attemptCount - beforeSecondDead, 1, 'Failing host should fail fast with 1 attempt');

    // 4. Deterministic 404 is never retried
    const before404 = attemptCount;
    const res404 = await resilient('https://ok.example.com/missing');
    assert.equal(res404.status, 404);
    assert.equal(attemptCount - before404, 1);
  });

  it('exports, parses, validates, merges, and replaces JSON user backups cleanly', () => {
    const current: AnisyncBackupData = {
      favorites: [
        {
          id: 'tvdb-424536',
          title: 'Frieren',
          url: 'anisync://media/anime/thetvdb/424536',
          poster: 'p1',
          kind: 'anime',
          audioType: 'LEG',
        },
      ],
      history: [
        {
          title: 'Frieren - EP 1',
          url: 'https://topanimes.net/episodio/frieren-ep-1/',
          poster: 'p1',
          kind: 'episode',
          watchedAt: '2026-11-20T10:00:00.000Z',
          positionSec: 300,
          durationSec: 1440,
          completed: false,
        },
      ],
      progressMap: {
        'https://topanimes.net/episodio/frieren-ep-1': {
          url: 'https://topanimes.net/episodio/frieren-ep-1/',
          positionSec: 300,
          durationSec: 1440,
          completed: false,
          updatedAt: '2026-11-20T10:00:00.000Z',
        },
      },
      mutedFavoriteUrls: ['anisync://media/anime/thetvdb/424536'],
      settings: { ...DEFAULT_APP_SETTINGS, defaultAudioFilter: 'LEG' },
    };

    const incoming: AnisyncBackupData = {
      favorites: [
        {
          id: 'tvdb-424536',
          title: 'Frieren',
          url: 'anisync://media/anime/thetvdb/424536/',
          poster: 'p1',
          kind: 'anime',
          audioType: 'LEG',
        },
        {
          id: 'tvdb-442330',
          title: 'Dandadan',
          url: 'anisync://media/anime/thetvdb/442330',
          poster: 'p2',
          kind: 'anime',
          audioType: 'DUB',
        },
      ],
      history: [
        {
          title: 'Frieren - EP 1',
          url: 'https://topanimes.net/episodio/frieren-ep-1/',
          poster: 'p1',
          kind: 'episode',
          watchedAt: '2026-11-25T15:00:00.000Z',
          positionSec: 0,
          durationSec: 1440,
          completed: true,
        },
      ],
      progressMap: {
        'https://topanimes.net/episodio/frieren-ep-1': {
          url: 'https://topanimes.net/episodio/frieren-ep-1/',
          positionSec: 0,
          durationSec: 1440,
          completed: true,
          updatedAt: '2026-11-25T15:00:00.000Z',
        },
      },
      mutedFavoriteUrls: ['anisync://media/anime/thetvdb/442330'],
      settings: { ...DEFAULT_APP_SETTINGS, autoPlayNextEpisode: false },
    };

    const payload = buildAnisyncBackupPayload(incoming, { appVersion: '1.2.0' });
    const serialized = serializeAnisyncBackup(payload);
    const parsed = parseAnisyncBackupJson(serialized);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.summary.favoritesCount, 2);
    assert.equal(parsed.summary.progressCount, 1);

    const merged = mergeAnisyncBackupData(current, parsed.payload.data, 'merge');
    assert.equal(merged.favorites.length, 2, 'Should deduplicate Frieren and add Dandadan');
    assert.equal(merged.progressMap['topanimes.net/episodio/frieren-ep-1'].completed, true);
    assert.equal(merged.mutedFavoriteUrls.length, 2);
    assert.equal(merged.settings.autoPlayNextEpisode, false);

    const replaced = mergeAnisyncBackupData(current, parsed.payload.data, 'replace');
    assert.equal(replaced.favorites.length, 2);
    assert.equal(replaced.mutedFavoriteUrls.length, 1);
    assert.equal(replaced.settings.defaultAudioFilter, DEFAULT_APP_SETTINGS.defaultAudioFilter);

    assert.equal(parseAnisyncBackupJson('{broken').ok, false);
    assert.equal(parseAnisyncBackupJson('{"format":"other","data":{}}').ok, false);
    assert.match(buildBackupFilename(new Date('2026-11-26T12:00:00Z')), /^anisync-backup-2026-11-26\.json$/);
  });

  it('parses GitHub release Markdown into clean categorized sections without commit hash noise', () => {
    const rawNotes = `
# v1.4.0 (2026-11-26)

### ✨ Features
- **TV Cast:** Descoberta automática de TVs no Wi-Fi ([a1b2c3d](https://github.com/Martin01683/Aplicativo-de-animes/commit/a1b2c3d4e5f6))
- Suporte a tradução com DeepL (deadbeef)

### 🐛 Bug Fixes
- **TheTVDB:** Ignora fanart de série como capa de episódio ([9988776](https://github.com/Martin01683/Aplicativo-de-animes/commit/99887766))
- Commit: \`a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2\`

---
**Full Changelog**: https://github.com/Martin01683/Aplicativo-de-animes/compare/v1.3.0...v1.4.0
`;

    const sections = parseReleaseChangelog(rawNotes);
    assert.equal(sections.length, 2);
    assert.equal(sections[0].title, 'Novidades');
    assert.equal(sections[0].items.length, 2);
    assert.equal(sections[0].items[0].scope, 'TV Cast');
    assert.equal(sections[0].items[0].text, 'Descoberta automática de TVs no Wi-Fi');
    assert.equal(sections[0].items[1].text, 'Suporte a tradução com DeepL');
    assert.equal(sections[1].title, 'Correções');
    assert.equal(sections[1].items.length, 1);
    assert.equal(sections[1].items[0].scope, 'TheTVDB');
  });

  it('wires hardened Android self-updater, background confirmation handoff, watchdog, and Manifest permissions', () => {
    const manifest = readRepoFile('android/app/src/main/AndroidManifest.xml');
    assert.match(manifest, /android\.permission\.ACCESS_LOCAL_NETWORK/);
    assert.match(manifest, /android\.permission\.UPDATE_PACKAGES_WITHOUT_USER_ACTION/);
    assert.match(manifest, /android\.permission\.ENFORCE_UPDATE_OWNERSHIP/);

    const mainActivity = readRepoFile('android/app/src/main/java/com/topanimes/player/MainActivity.java');
    assert.match(mainActivity, /isInForeground\(\)/);
    assert.match(mainActivity, /flushPendingInstallConfirmation\(this\)/);

    const receiver = readRepoFile('android/app/src/main/java/com/topanimes/player/ApkInstallReceiver.java');
    assert.match(receiver, /onInstallUserActionRequired/);
    assert.match(receiver, /onInstallAborted/);
    assert.match(receiver, /onInstallFailed/);

    const proxyPlugin = readRepoFile('android/app/src/main/java/com/topanimes/player/LocalProxyPlugin.java');
    assert.match(proxyPlugin, /downloadApkWithResume/);
    assert.match(proxyPlugin, /resolveGitHubAssetViaApi/);
    assert.match(proxyPlugin, /startSessionWatchdog/);
    assert.match(proxyPlugin, /launchLegacyApkInstallFallback/);
    assert.match(proxyPlugin, /setRequestUpdateOwnership\(true\)/);
    assert.match(proxyPlugin, /exportBackupFile/);
    assert.match(proxyPlugin, /saveBackupToDownloads/);
    assert.match(proxyPlugin, /MediaStore\.Downloads/);
    assert.match(proxyPlugin, /Retry-After/);

    const settingsModal = readRepoFile('src/components/SettingsModal.tsx');
    assert.match(settingsModal, /data-release-changelog="true"/);
    assert.match(settingsModal, /data-backup-section="true"/);
    assert.match(settingsModal, /data-backup-export-downloads="true"/);
  });
});
