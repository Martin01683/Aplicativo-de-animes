import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildWatchedProgressMap,
  canonicalEpisodeProgressKey,
  computeProgressSnapshot,
  countAnimeEpisodesInHistory,
  DEFAULT_VIDEO_SCALE,
  formatPlaybackTimestamp,
  getHistoryEntrySeriesName,
  getResumePositionSec,
  getVideoScaleLabel,
  groupEpisodesBySeason,
  indexToVideoScale,
  isEpisodeCompleted,
  isEpisodeMarkedWatched,
  isSameHistoryAnime,
  removeHistoryAnimeFromList,
  removeHistoryEpisodeFromList,
  sanitizeEpisodeProgressMap,
  sanitizeVideoScaleMode,
  upsertEpisodeProgressMap,
  videoScaleToIndex,
  type EpisodeProgressMap,
} from './playbackProgress';
import type { WatchHistoryEntry } from './types';

test('canonicalEpisodeProgressKey normalizes scheme, www, and trailing slash', () => {
  assert.equal(
    canonicalEpisodeProgressKey('https://topanimes.net/episodio/frieren-ep-1/'),
    canonicalEpisodeProgressKey('http://www.topanimes.net/episodio/frieren-ep-1')
  );
  assert.notEqual(
    canonicalEpisodeProgressKey('https://topanimes.net/episodio/frieren-ep-1/'),
    canonicalEpisodeProgressKey('https://topanimes.net/episodio/frieren-ep-2/')
  );
});

test('isEpisodeCompleted distinguishes incomplete mid-episode stops from finished episodes', () => {
  // 24-minute episode stopped halfway or near ending credits still resumes
  assert.equal(isEpisodeCompleted(720, 1440, false), false);
  assert.equal(isEpisodeCompleted(1350, 1440, false), false);
  // Within final 15s or >= 97% is considered watched to the end
  assert.equal(isEpisodeCompleted(1426, 1440, false), true);
  assert.equal(isEpisodeCompleted(1400, 1440, false), true);
  // Explicit ended event is always completed
  assert.equal(isEpisodeCompleted(10, 1440, true), true);
  // Short 30s sample video: 12s is incomplete, 29s is complete
  assert.equal(isEpisodeCompleted(12, 30, false), false);
  assert.equal(isEpisodeCompleted(29, 30, false), true);
});

test('computeProgressSnapshot & getResumePositionSec handle resume, completion, and rewatch', () => {
  const epUrl = 'https://topanimes.net/episodio/kusuriya-ep-8/';

  // Too early (< 2s) does not overwrite existing progress with 0
  assert.equal(
    computeProgressSnapshot({ url: epUrl, positionSec: 1.2, durationSec: 1440 }),
    null
  );

  // Mid-episode stop saves resumable timestamp
  const mid = computeProgressSnapshot({
    url: epUrl,
    positionSec: 345.67,
    durationSec: 1440,
    nowIso: '2026-11-21T10:00:00.000Z',
  });
  assert.ok(mid);
  assert.equal(mid.completed, false);
  assert.equal(mid.positionSec, 345.7);
  assert.equal(getResumePositionSec(mid), 345.7);

  // Watched to the end resets resume position to 0 and marks completed
  const done = computeProgressSnapshot({
    url: epUrl,
    positionSec: 1435,
    durationSec: 1440,
    ended: true,
    nowIso: '2026-11-21T10:20:00.000Z',
  });
  assert.ok(done);
  assert.equal(done.completed, true);
  assert.equal(done.positionSec, 0);
  assert.equal(getResumePositionSec(done), 0);

  // Rewatching a completed episode and stopping midway resumes at new point
  const rewatch = computeProgressSnapshot({
    url: epUrl,
    positionSec: 120,
    durationSec: 1440,
    nowIso: '2026-11-21T11:00:00.000Z',
  });
  assert.ok(rewatch);
  assert.equal(rewatch.completed, false);
  assert.equal(getResumePositionSec(rewatch), 120);
});

test('upsertEpisodeProgressMap prunes oldest entries when exceeding cap and sanitizes cleanly', () => {
  let map: EpisodeProgressMap = {};
  for (let i = 1; i <= 5; i++) {
    map = upsertEpisodeProgressMap(
      map,
      {
        url: `https://topanimes.net/episodio/ep-${i}/`,
        positionSec: i * 10,
        durationSec: 1000,
        completed: false,
        updatedAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
      },
      3
    );
  }
  const keys = Object.keys(map);
  assert.equal(keys.length, 3);
  assert.equal(Boolean(map['topanimes.net/episodio/ep-1']), false);
  assert.equal(Boolean(map['topanimes.net/episodio/ep-5']), true);

  const sanitized = sanitizeEpisodeProgressMap({
    bad: null,
    'topanimes.net/episodio/ep-5': {
      url: 'https://topanimes.net/episodio/ep-5/',
      positionSec: 50,
      durationSec: 1000,
      completed: false,
      updatedAt: '2026-11-21T10:00:00.000Z',
    },
  });
  assert.equal(Object.keys(sanitized).length, 1);
  assert.equal(getResumePositionSec(sanitized['topanimes.net/episodio/ep-5']), 50);
});

test('videoScale helpers round-trip modes, indices, and fallback safely', () => {
  assert.equal(sanitizeVideoScaleMode('invalid'), DEFAULT_VIDEO_SCALE);
  assert.equal(sanitizeVideoScaleMode('fill'), 'fill');
  assert.equal(sanitizeVideoScaleMode('16:9'), '16:9');
  assert.equal(videoScaleToIndex('fit-screen'), 1);
  assert.equal(videoScaleToIndex('original'), 4);
  assert.equal(indexToVideoScale(2), 'fill');
  assert.equal(indexToVideoScale(99), 'best-fit');
  assert.equal(getVideoScaleLabel('fill'), 'Preencher');
});

test('formatPlaybackTimestamp formats mm:ss and h:mm:ss cleanly', () => {
  assert.equal(formatPlaybackTimestamp(65), '1:05');
  assert.equal(formatPlaybackTimestamp(3661), '1:01:01');
});

test('buildWatchedProgressMap marks and unmarks single episodes and entire seasons cleanly', () => {
  const s1Urls = [
    'https://topanimes.net/episodio/anime-episodio-1/',
    'https://topanimes.net/episodio/anime-episodio-2/',
    'https://topanimes.net/episodio/anime-episodio-3/',
  ];
  let map = buildWatchedProgressMap({}, s1Urls, true, '2026-11-21T12:00:00Z');
  for (const u of s1Urls) {
    assert.equal(isEpisodeMarkedWatched(u, map), true);
    assert.equal(getResumePositionSec(map[canonicalEpisodeProgressKey(u)]), 0);
  }

  // Unmark a single episode while keeping the rest watched
  map = buildWatchedProgressMap(map, [s1Urls[1]], false);
  assert.equal(isEpisodeMarkedWatched(s1Urls[0], map), true);
  assert.equal(isEpisodeMarkedWatched(s1Urls[1], map), false);
  assert.equal(isEpisodeMarkedWatched(s1Urls[2], map), true);

  // Unmark entire season
  map = buildWatchedProgressMap(map, s1Urls, false);
  for (const u of s1Urls) {
    assert.equal(isEpisodeMarkedWatched(u, map), false);
  }
});

test('groupEpisodesBySeason groups episodes by explicit seasonNumber or numerando label', () => {
  const groups = groupEpisodesBySeason([
    { numberLabel: '1 - 1', title: 'EP 1', url: 'https://topanimes.net/episodio/a-1/' },
    { numberLabel: '1 - 2', title: 'EP 2', url: 'https://topanimes.net/episodio/a-2/' },
    { numberLabel: '2 - 1', title: 'EP 1 T2', url: 'https://topanimes.net/episodio/a-3/' },
    {
      numberLabel: 'EP 4',
      seasonNumber: 3,
      seasonLabel: 'Temporada 3 (Final)',
      title: 'EP 4',
      url: 'https://topanimes.net/episodio/a-4/',
    },
  ]);

  assert.equal(groups.length, 3);
  assert.equal(groups[0].seasonNumber, 1);
  assert.equal(groups[0].label, 'Temporada 1');
  assert.equal(groups[0].episodes.length, 2);
  assert.equal(groups[1].seasonNumber, 2);
  assert.equal(groups[1].episodes.length, 1);
  assert.equal(groups[2].seasonNumber, 3);
  assert.equal(groups[2].label, 'Temporada 3 (Final)');
});

test('history removal helpers remove either a single episode or all episodes of the same anime', () => {
  const history: WatchHistoryEntry[] = [
    {
      url: 'https://topanimes.net/episodio/sousou-no-frieren-episodio-1/',
      title: 'Sousou no Frieren - Episódio 1',
      seriesTitle: 'Sousou no Frieren',
      seriesUrl: 'https://topanimes.net/animes/sousou-no-frieren/',
      poster: '',
      kind: 'episode',
      watchedAt: '2026-11-21T20:00:00Z',
    },
    {
      url: 'https://www.hinatasoul.com/videos/12345',
      title: 'Sousou no Frieren - Episódio 2',
      seriesTitle: 'Sousou no Frieren',
      seriesUrl: 'https://www.hinatasoul.com/animes/sousou-no-frieren',
      poster: '',
      kind: 'episode',
      watchedAt: '2026-11-21T21:00:00Z',
    },
    {
      url: 'https://topanimes.net/episodio/sousou-no-frieren-episodio-3/',
      title: 'Sousou no Frieren - Episódio 3',
      poster: '',
      kind: 'episode',
      watchedAt: '2026-11-21T21:30:00Z',
    },
    {
      url: 'https://topanimes.net/episodio/solo-leveling-episodio-4/',
      title: 'Solo Leveling - Episódio 4',
      seriesTitle: 'Solo Leveling',
      seriesUrl: 'https://topanimes.net/animes/solo-leveling/',
      poster: '',
      kind: 'episode',
      watchedAt: '2026-11-21T22:00:00Z',
    },
  ];

  assert.equal(getHistoryEntrySeriesName(history[2]), 'Sousou no Frieren');
  assert.equal(isSameHistoryAnime(history[0], history[1]), true);
  assert.equal(isSameHistoryAnime(history[0], history[2]), true);
  assert.equal(isSameHistoryAnime(history[0], history[3]), false);
  assert.equal(countAnimeEpisodesInHistory(history, history[0]), 3);

  const single = removeHistoryEpisodeFromList(history, history[1].url);
  assert.equal(single.removedUrls.length, 1);
  assert.equal(single.nextHistory.length, 3);
  assert.equal(single.nextHistory.some((h) => h.url === history[1].url), false);
  assert.equal(single.nextHistory.some((h) => h.url === history[0].url), true);

  const allSeries = removeHistoryAnimeFromList(history, history[0]);
  assert.equal(allSeries.removedUrls.length, 3);
  assert.equal(allSeries.nextHistory.length, 1);
  assert.equal(allSeries.nextHistory[0].url, history[3].url);
});

test('App.tsx requires confirmation before bulk history clearing (clear all or all episodes of an anime)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const appTsx = readFileSync(resolve(here, '../App.tsx'), 'utf8');

  assert.match(appTsx, /onClearHistory=\{requestClearAllHistory\}/);
  assert.match(appTsx, /onRemoveHistoryAnime=\{requestRemoveHistoryAnime\}/);
  assert.match(appTsx, /role="alertdialog"[\s\S]*?confirmPendingHistoryRemoval/);
  const clearAllMatches = appTsx.match(/onClearHistory=\{requestClearAllHistory\}/g) ?? [];
  assert.equal(
    clearAllMatches.length,
    2,
    'both CatalogView and SettingsModal clear-history actions must ask confirmation'
  );
});

test('formatHistoryEpisodeTitle prefixes bare episode titles with seriesTitle without duplicating existing prefixes', async () => {
  const { formatHistoryEpisodeTitle } = await import('./playbackProgress.ts');
  assert.equal(
    formatHistoryEpisodeTitle('Episódio 5', 'Sousou no Frieren'),
    'Sousou no Frieren — Episódio 5'
  );
  assert.equal(
    formatHistoryEpisodeTitle('Sousou no Frieren - Episódio 5', 'Sousou no Frieren'),
    'Sousou no Frieren - Episódio 5'
  );
  assert.equal(formatHistoryEpisodeTitle('Episódio 1'), 'Episódio 1');
});

test('storage syncs loadHistory, pushHistoryEntry, saveEpisodeProgress with meta, and route session across restarts', async () => {
  const store = new Map<string, string>();
  const prevDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const mockStorage: Storage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => {
      store.clear();
    },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: mockStorage,
  });

  try {
    const {
      loadActiveRouteSession,
      loadEpisodeProgressMap,
      loadHistory,
      pushHistoryEntry,
      saveActiveRouteSession,
      saveEpisodeProgress,
    } = await import('./storage.ts');

    const ep1Url = 'https://topanimes.net/episodio/frieren-episodio-1/';
    const ep2Url = 'https://www.hinatasoul.com/videos/987654';

    // Saving progress with meta inserts a new history entry even if pushHistoryEntry wasn't called first
    saveEpisodeProgress({
      url: ep1Url,
      positionSec: 185,
      durationSec: 1420,
      meta: {
        title: 'Episódio 1',
        seriesTitle: 'Sousou no Frieren',
        seriesUrl: 'https://topanimes.net/animes/frieren/',
        poster: 'https://img.example/frieren.jpg',
        kind: 'episode',
      },
    });

    let hist = loadHistory();
    assert.equal(hist.length, 1);
    assert.equal(hist[0].title, 'Sousou no Frieren — Episódio 1');
    assert.equal(hist[0].positionSec, 185);
    assert.equal(hist[0].completed, false);

    // Completing an episode via fullscreen switch records it in history and progressMap
    saveEpisodeProgress({
      url: ep2Url,
      positionSec: 1400,
      durationSec: 1420,
      ended: true,
      meta: {
        title: 'Episódio 2',
        seriesTitle: 'Sousou no Frieren',
        seriesUrl: 'https://topanimes.net/animes/frieren/',
        poster: 'https://img.example/frieren.jpg',
        kind: 'episode',
        promoteInHistory: true,
      },
    });
    pushHistoryEntry({
      url: ep2Url,
      title: 'Episódio 2',
      seriesTitle: 'Sousou no Frieren',
      seriesUrl: 'https://topanimes.net/animes/frieren/',
      poster: 'https://img.example/frieren.jpg',
      kind: 'episode',
      watchedAt: '2026-11-22T10:00:00.000Z',
    });

    hist = loadHistory();
    assert.equal(hist.length, 2);
    assert.equal(hist[0].url, ep2Url);
    assert.equal(hist[0].title, 'Sousou no Frieren — Episódio 2');
    assert.equal(hist[0].completed, true);
    assert.equal(hist[0].positionSec, 0);

    const pMap = loadEpisodeProgressMap();
    assert.equal(pMap['hinatasoul.com/videos/987654']?.completed, true);

    // Active route session persists and restores the episode workspace across screen-off WebView reloads
    saveActiveRouteSession({
      routeStack: [
        { view: 'catalog' },
        { view: 'anime', url: 'https://topanimes.net/animes/frieren/' },
        { view: 'episode', url: ep2Url },
      ],
      activeSection: 'catalog',
    });
    const restoredSession = loadActiveRouteSession();
    assert.equal(restoredSession.activeSection, 'catalog');
    assert.equal(restoredSession.routeStack.length, 3);
    assert.deepEqual(restoredSession.routeStack[2], { view: 'episode', url: ep2Url });
  } finally {
    if (prevDescriptor) {
      Object.defineProperty(globalThis, 'localStorage', prevDescriptor);
    } else {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  }
});

