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
  countAnimeTrackedEpisodes,
  DEFAULT_VIDEO_SCALE,
  findEpisodeProgressInMap,
  formatHistoryWatchedDate,
  formatHistoryWatchedDateTime,
  formatPlaybackTimestamp,
  getHistoryEntrySeriesName,
  getResumePositionSec,
  getUnifiedEpisodeKeys,
  getVideoScaleLabel,
  groupEpisodesBySeason,
  indexToVideoScale,
  isEpisodeCompleted,
  isEpisodeMarkedWatched,
  isSameHistoryAnime,
  isSameUnifiedEpisode,
  normalizeAudioAgnosticSeriesUrlKey,
  removeAnimeProgressFromMap,
  removeHistoryAnimeFromList,
  removeHistoryEpisodeFromList,
  sanitizeEpisodeProgressMap,
  sanitizeVideoScaleMode,
  stripAudioTagsFromSlug,
  stripAudioTagsFromText,
  syncWatchedEpisodesInHistory,
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

test('removeAnimeProgressFromMap and countAnimeTrackedEpisodes clear all watched/saved episodes of an anime outside the recent history list', () => {
  const frierenSeriesUri = 'anisync://anime/thetvdb/424536';
  const frierenEp5Uri = 'anisync://episode/anime/thetvdb/424536/s1/e5';
  const frierenEp1Uri = 'anisync://episode/anime/thetvdb/424536/s1/e1';
  const frierenHinataEp2 = 'https://www.hinatasoul.com/videos/55555';
  const frierenLegacyTopEp3 = 'https://topanimes.net/episodio/sousou-no-frieren-episodio-3/';
  const soloSeriesUri = 'anisync://anime/thetvdb/389597';
  const soloEp1Uri = 'anisync://episode/anime/thetvdb/389597/s1/e1';
  const unrelatedHinataEp = 'https://www.hinatasoul.com/videos/99999';

  const history: WatchHistoryEntry[] = [
    {
      url: frierenEp5Uri,
      title: 'Sousou no Frieren — Episódio 5',
      seriesTitle: 'Sousou no Frieren',
      seriesUrl: frierenSeriesUri,
      poster: '',
      kind: 'episode',
      watchedAt: '2026-11-26T20:00:00Z',
      completed: true,
    },
    {
      url: soloEp1Uri,
      title: 'Solo Leveling — Episódio 1',
      seriesTitle: 'Solo Leveling',
      seriesUrl: soloSeriesUri,
      poster: '',
      kind: 'episode',
      watchedAt: '2026-11-26T19:00:00Z',
      completed: true,
    },
  ];

  let progressMap: EpisodeProgressMap = {};
  // Older anisync episode with NO seriesUrl/seriesTitle stored (legacy record)
  progressMap = upsertEpisodeProgressMap(progressMap, {
    url: frierenEp1Uri,
    positionSec: 0,
    durationSec: 1420,
    completed: true,
    updatedAt: '2026-11-20T10:00:00Z',
  });
  // Manually marked HinataSoul episode with seriesUrl/seriesTitle metadata
  progressMap = buildWatchedProgressMap(
    progressMap,
    [frierenHinataEp2],
    true,
    '2026-11-21T10:00:00Z',
    1500,
    { seriesUrl: frierenSeriesUri, seriesTitle: 'Sousou no Frieren' }
  );
  // Legacy TopAnimes slug episode with no seriesUrl/seriesTitle
  progressMap[canonicalEpisodeProgressKey(frierenLegacyTopEp3)] = {
    url: frierenLegacyTopEp3,
    positionSec: 0,
    durationSec: 1420,
    completed: true,
    updatedAt: '2026-11-22T10:00:00Z',
  };
  // Recent episode that is also in history
  progressMap = buildWatchedProgressMap(
    progressMap,
    [frierenEp5Uri],
    true,
    '2026-11-26T20:00:00Z',
    1500,
    { seriesUrl: frierenSeriesUri, seriesTitle: 'Sousou no Frieren' }
  );
  // Unrelated animes that MUST stay untouched
  progressMap = buildWatchedProgressMap(
    progressMap,
    [soloEp1Uri],
    true,
    '2026-11-26T19:00:00Z',
    1500,
    { seriesUrl: soloSeriesUri, seriesTitle: 'Solo Leveling' }
  );
  progressMap[canonicalEpisodeProgressKey(unrelatedHinataEp)] = {
    url: unrelatedHinataEp,
    positionSec: 320,
    durationSec: 1440,
    completed: false,
    updatedAt: '2026-11-25T10:00:00Z',
    seriesTitle: 'Jujutsu Kaisen',
  };

  const counts = countAnimeTrackedEpisodes(history, progressMap, history[0]);
  assert.equal(counts.historyCount, 1);
  assert.equal(counts.progressCount, 4);
  assert.equal(counts.totalCount, 4);

  const { nextProgressMap, removedKeys } = removeAnimeProgressFromMap(progressMap, history[0], [
    history[0],
  ]);
  assert.equal(removedKeys.length, 4);
  assert.equal(isEpisodeMarkedWatched(frierenEp1Uri, nextProgressMap), false);
  assert.equal(isEpisodeMarkedWatched(frierenHinataEp2, nextProgressMap), false);
  assert.equal(isEpisodeMarkedWatched(frierenLegacyTopEp3, nextProgressMap), false);
  assert.equal(isEpisodeMarkedWatched(frierenEp5Uri, nextProgressMap), false);
  assert.equal(isEpisodeMarkedWatched(soloEp1Uri, nextProgressMap), true);
  assert.equal(Boolean(nextProgressMap[canonicalEpisodeProgressKey(unrelatedHinataEp)]), true);
});

test('storage removeHistoryAnime removes both recent history entries and older/manual watched progress for that anime only', async () => {
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
      loadEpisodeProgressMap,
      loadHistory,
      removeHistoryAnime,
      saveEpisodeProgress,
      saveEpisodeProgressMap,
    } = await import('./storage.ts');

    const frierenSeries = 'anisync://anime/thetvdb/424536';
    const frierenEp1 = 'anisync://episode/anime/thetvdb/424536/s1/e1';
    const frierenEp2 = 'https://www.hinatasoul.com/videos/42453602';
    const frierenEp5 = 'anisync://episode/anime/thetvdb/424536/s1/e5';
    const soloSeries = 'anisync://anime/thetvdb/389597';
    const soloEp1 = 'anisync://episode/anime/thetvdb/389597/s1/e1';

    // Simulate older watched episodes that rotated out of the 30-item recent history list
    saveEpisodeProgressMap(
      buildWatchedProgressMap(
        {},
        [frierenEp1, frierenEp2],
        true,
        '2026-11-10T10:00:00.000Z',
        1500,
        { seriesUrl: frierenSeries, seriesTitle: 'Sousou no Frieren' }
      )
    );

    // Watch episode 5 of Frieren and episode 1 of Solo Leveling (in history + progressMap)
    saveEpisodeProgress({
      url: frierenEp5,
      positionSec: 1415,
      durationSec: 1420,
      ended: true,
      meta: {
        title: 'Episódio 5',
        seriesTitle: 'Sousou no Frieren',
        seriesUrl: frierenSeries,
        poster: '',
        kind: 'episode',
      },
    });
    saveEpisodeProgress({
      url: soloEp1,
      positionSec: 1415,
      durationSec: 1420,
      ended: true,
      meta: {
        title: 'Episódio 1',
        seriesTitle: 'Solo Leveling',
        seriesUrl: soloSeries,
        poster: '',
        kind: 'episode',
      },
    });

    const initialHistory = loadHistory();
    assert.equal(initialHistory.length, 2);
    const frierenEntry = initialHistory.find((h) => h.url === frierenEp5);
    assert.ok(frierenEntry);

    const res = removeHistoryAnime(frierenEntry);
    assert.equal(res.history.length, 1);
    assert.equal(res.history[0].url, soloEp1);
    assert.equal(res.removedCount, 1);
    assert.equal(res.removedProgressCount, 3);
    assert.equal(res.totalClearedCount, 3);

    const persistedProgress = loadEpisodeProgressMap();
    assert.equal(isEpisodeMarkedWatched(frierenEp1, persistedProgress), false);
    assert.equal(isEpisodeMarkedWatched(frierenEp2, persistedProgress), false);
    assert.equal(isEpisodeMarkedWatched(frierenEp5, persistedProgress), false);
    assert.equal(isEpisodeMarkedWatched(soloEp1, persistedProgress), true);
  } finally {
    if (prevDescriptor) {
      Object.defineProperty(globalThis, 'localStorage', prevDescriptor);
    } else {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  }
});

test('syncWatchedEpisodesInHistory mirrors Crunchyroll: marking adds/promotes watched entries (latest first) and unmarking removes them', () => {
  const soloEntry: WatchHistoryEntry = {
    url: 'anisync://episode/anime/thetvdb/389597/s1/e2',
    title: 'Solo Leveling — Episódio 2',
    seriesTitle: 'Solo Leveling',
    seriesUrl: 'anisync://anime/thetvdb/389597',
    poster: 'https://img.example/solo.jpg',
    kind: 'episode',
    watchedAt: '2026-11-25T18:00:00.000Z',
    positionSec: 400,
    durationSec: 1420,
    completed: false,
  };

  // Mark a single episode not yet in history
  let hist = syncWatchedEpisodesInHistory(
    [soloEntry],
    [
      {
        url: 'anisync://episode/anime/thetvdb/424536/s1/e1',
        title: 'O Fim da Jornada',
        seasonNumber: 1,
        episodeNumber: 1,
        poster: 'https://img.example/frieren1.jpg',
        seriesTitle: 'Sousou no Frieren',
        seriesUrl: 'anisync://anime/thetvdb/424536',
        kind: 'episode',
      },
    ],
    true,
    '2026-11-26T10:00:00.000Z'
  );
  assert.equal(hist.length, 2);
  assert.equal(hist[0].url, 'anisync://episode/anime/thetvdb/424536/s1/e1');
  assert.equal(hist[0].title, 'Sousou no Frieren — Episódio 1 — O Fim da Jornada');
  assert.equal(hist[0].completed, true);
  assert.equal(hist[0].positionSec, 0);

  // Mark an in-progress episode as watched: promotes to top, marks completed, clears positionSec
  hist = syncWatchedEpisodesInHistory(
    hist,
    [
      {
        url: soloEntry.url,
        title: 'Episódio 2',
        seasonNumber: 1,
        episodeNumber: 2,
        seriesTitle: 'Solo Leveling',
        seriesUrl: 'anisync://anime/thetvdb/389597',
      },
    ],
    true,
    '2026-11-26T11:00:00.000Z'
  );
  assert.equal(hist.length, 2);
  assert.equal(hist[0].url, soloEntry.url);
  assert.equal(hist[0].completed, true);
  assert.equal(hist[0].positionSec, 0);
  assert.equal(hist[0].poster, 'https://img.example/solo.jpg');

  // Mark a season batch (ep 2 and ep 3): highest episode comes first in history
  hist = syncWatchedEpisodesInHistory(
    hist,
    [
      {
        url: 'anisync://episode/anime/thetvdb/424536/s1/e2',
        title: 'Não Precisava Ser Magia',
        seasonNumber: 1,
        episodeNumber: 2,
        seriesTitle: 'Sousou no Frieren',
        seriesUrl: 'anisync://anime/thetvdb/424536',
      },
      {
        url: 'anisync://episode/anime/thetvdb/424536/s1/e3',
        title: 'Unknown',
        seasonNumber: 1,
        episodeNumber: 3,
        seriesTitle: 'Sousou no Frieren',
        seriesUrl: 'anisync://anime/thetvdb/424536',
      },
    ],
    true,
    '2026-11-26T12:00:00.000Z'
  );
  assert.equal(hist[0].url, 'anisync://episode/anime/thetvdb/424536/s1/e3');
  assert.equal(hist[0].title, 'Sousou no Frieren — Episódio 3');
  assert.equal(hist[1].url, 'anisync://episode/anime/thetvdb/424536/s1/e2');
  assert.equal(hist[2].url, soloEntry.url);

  // Unmarking episodes removes them from history too
  hist = syncWatchedEpisodesInHistory(
    hist,
    [
      { url: 'anisync://episode/anime/thetvdb/424536/s1/e2' },
      { url: 'anisync://episode/anime/thetvdb/424536/s1/e3' },
    ],
    false
  );
  assert.equal(hist.length, 2);
  assert.equal(hist.some((h) => h.url.endsWith('/e2') && h.seriesTitle === 'Sousou no Frieren'), false);
  assert.equal(hist.some((h) => h.url.endsWith('/e3')), false);
  assert.equal(hist[0].url, soloEntry.url);
});

test('storage setEpisodesWatched persists watched additions and unwatched removals in both progressMap and history', async () => {
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
    const { loadEpisodeProgressMap, loadHistory, setEpisodesWatched } = await import('./storage.ts');
    const ep1 = 'anisync://episode/anime/thetvdb/424536/s1/e1';
    const ep2 = 'anisync://episode/anime/thetvdb/424536/s1/e2';
    const series = 'anisync://anime/thetvdb/424536';

    // Mark episode 1 as watched -> appears in both progressMap and history
    setEpisodesWatched([ep1], true, {
      seriesUrl: series,
      seriesTitle: 'Sousou no Frieren',
      episodes: [
        {
          url: ep1,
          title: 'O Fim da Jornada',
          seasonNumber: 1,
          episodeNumber: 1,
          poster: 'https://img.example/ep1.jpg',
        },
      ],
    });
    assert.equal(isEpisodeMarkedWatched(ep1, loadEpisodeProgressMap()), true);
    let hist = loadHistory();
    assert.equal(hist.length, 1);
    assert.equal(hist[0].url, ep1);
    assert.equal(hist[0].completed, true);

    // Mark episode 2 as watched -> moves to top of history above ep 1
    setEpisodesWatched([ep2], true, {
      seriesUrl: series,
      seriesTitle: 'Sousou no Frieren',
      episodes: [
        {
          url: ep2,
          title: 'Não Precisava Ser Magia',
          seasonNumber: 1,
          episodeNumber: 2,
        },
      ],
    });
    hist = loadHistory();
    assert.equal(hist.length, 2);
    assert.equal(hist[0].url, ep2);
    assert.equal(hist[1].url, ep1);

    // Unmark episode 2 -> removed from both progressMap and history, ep 1 stays
    setEpisodesWatched([ep2], false, {
      seriesUrl: series,
      seriesTitle: 'Sousou no Frieren',
    });
    assert.equal(isEpisodeMarkedWatched(ep2, loadEpisodeProgressMap()), false);
    assert.equal(isEpisodeMarkedWatched(ep1, loadEpisodeProgressMap()), true);
    hist = loadHistory();
    assert.equal(hist.length, 1);
    assert.equal(hist[0].url, ep1);
  } finally {
    if (prevDescriptor) {
      Object.defineProperty(globalThis, 'localStorage', prevDescriptor);
    } else {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  }
});

test('audio tag stripping preserves season numbers, Japanese dub note, and unrelated words', () => {
  assert.equal(stripAudioTagsFromText('Fool Night Dublado'), 'Fool Night');
  assert.equal(stripAudioTagsFromText('Fool Night (Dublado)'), 'Fool Night');
  assert.equal(stripAudioTagsFromText('Fool Night [DUB]'), 'Fool Night');
  assert.equal(stripAudioTagsFromText('Fool Night - Dual Áudio'), 'Fool Night');
  assert.equal(stripAudioTagsFromText('Solo Leveling 2 Dublado'), 'Solo Leveling 2');
  assert.equal(
    stripAudioTagsFromText('Zi Jin: Yu Miao Fang (Dub Japonês)'),
    'Zi Jin: Yu Miao Fang (Dub Japonês)'
  );
  assert.equal(stripAudioTagsFromText('Legend of Galactic Heroes'), 'Legend of Galactic Heroes');
  assert.equal(stripAudioTagsFromText('Dublin Chronicles'), 'Dublin Chronicles');

  assert.equal(stripAudioTagsFromSlug('fool-night-dublado'), 'fool-night');
  assert.equal(stripAudioTagsFromSlug('solo-leveling-2-dublado'), 'solo-leveling-2');
  assert.equal(
    normalizeAudioAgnosticSeriesUrlKey('https://topanimes.net/anime-dublado/fool-night-dublado/'),
    normalizeAudioAgnosticSeriesUrlKey('https://topanimes.net/animes/fool-night/')
  );
});

test('DUB and LEG episodes unify across slug URLs, HinataSoul numeric IDs, and localized titles while keeping seasons isolated', () => {
  // 1. TopAnimes slug-based DUB <-> LEG
  const legUrl = 'https://topanimes.net/episodio/fool-night-episodio-12/';
  const dubUrl = 'https://topanimes.net/episodio/fool-night-dublado-episodio-12/';
  assert.equal(isSameUnifiedEpisode({ url: legUrl }, { url: dubUrl }), true);

  let map: EpisodeProgressMap = {};
  map = buildWatchedProgressMap(map, [legUrl], true, '2026-11-27T10:00:00.000Z');
  assert.equal(isEpisodeMarkedWatched(legUrl, map), true);
  assert.equal(isEpisodeMarkedWatched(dubUrl, map), true);

  // Unmarking DUB clears the LEG entry too
  map = buildWatchedProgressMap(map, [dubUrl], false);
  assert.equal(isEpisodeMarkedWatched(legUrl, map), false);
  assert.equal(isEpisodeMarkedWatched(dubUrl, map), false);
  assert.equal(Object.keys(map).length, 0);

  // 2. HinataSoul opaque numeric URLs unified via seriesUrl + (season, episode)
  const hinataLeg = 'https://www.hinatasoul.com/videos/11111';
  const hinataDub = 'https://www.hinatasoul.com/videos/22222';
  const unifiedSeriesUrl = 'anisync://anime/thetvdb/424536';
  const legMeta = {
    seriesUrl: unifiedSeriesUrl,
    seriesTitle: 'Sousou no Frieren',
    seasonNumber: 1,
    episodeNumber: 5,
  };
  const dubMeta = {
    seriesUrl: unifiedSeriesUrl,
    seriesTitle: 'Sousou no Frieren Dublado',
    seasonNumber: 1,
    episodeNumber: 5,
  };
  assert.equal(
    isSameUnifiedEpisode({ url: hinataLeg, ...legMeta }, { url: hinataDub, ...dubMeta }),
    true
  );

  // 3. Localized title mismatch across tracks under same unified seriesUrl
  const jpLegUrl = 'https://topanimes.net/episodio/koori-no-jouheki-2-episodio-9/';
  const ptDubUrl = 'https://topanimes.net/episodio/parede-de-gelo-2-dublado-episodio-9/';
  const unifiedIceSeries = 'anisync://anime/thetvdb/999001';
  let localizedMap = buildWatchedProgressMap(
    {},
    [jpLegUrl],
    true,
    '2026-11-27T10:00:00.000Z',
    1500,
    {
      seriesUrl: unifiedIceSeries,
      seriesTitle: 'Koori no Jouheki',
      episodes: [{ url: jpLegUrl, seasonNumber: 2, episodeNumber: 9 }],
    }
  );
  assert.equal(
    isEpisodeMarkedWatched(ptDubUrl, localizedMap, undefined, {
      seriesUrl: unifiedIceSeries,
      seriesTitle: 'Koori no Jouheki',
      seasonNumber: 2,
      episodeNumber: 9,
    }),
    true
  );
  localizedMap = buildWatchedProgressMap(localizedMap, [ptDubUrl], false, undefined, 1500, {
    seriesUrl: unifiedIceSeries,
    seriesTitle: 'Koori no Jouheki',
    episodes: [{ url: ptDubUrl, seasonNumber: 2, episodeNumber: 9 }],
  });
  assert.equal(Object.keys(localizedMap).length, 0);

  // 4. Season isolation: S1 E1 must NOT match S2 E1
  const s1Ep1 = {
    url: 'https://topanimes.net/episodio/solo-leveling-episodio-1/',
    seriesUrl: 'anisync://anime/thetvdb/389597',
    seriesTitle: 'Solo Leveling',
    seasonNumber: 1,
    episodeNumber: 1,
  };
  const s2Ep1Dub = {
    url: 'https://topanimes.net/episodio/solo-leveling-2-dublado-episodio-1/',
    seriesUrl: 'anisync://anime/thetvdb/389597',
    seriesTitle: 'Solo Leveling',
    seasonNumber: 2,
    episodeNumber: 1,
  };
  const s2HomeDub = {
    url: 'https://topanimes.net/episodio/solo-leveling-2-dublado-episodio-1/',
    title: 'Solo Leveling 2 Dublado',
    numberLabel: 'Episódio 1',
  };
  assert.equal(isSameUnifiedEpisode(s1Ep1, s2Ep1Dub), false);
  assert.equal(isSameUnifiedEpisode(s1Ep1, s2HomeDub), false);
  assert.equal(isSameUnifiedEpisode(s2Ep1Dub, s2HomeDub), true);
  assert.ok(getUnifiedEpisodeKeys(s2HomeDub).includes('ep:slug:solo-leveling-2:e1'));
});

test('upsertEpisodeProgressMap prunes stale DUB/LEG counterparts so rewatching never leaves conflicting completed state', () => {
  const legUrl = 'https://topanimes.net/episodio/fool-night-episodio-5/';
  const dubUrl = 'https://topanimes.net/episodio/fool-night-dublado-episodio-5/';

  // Finish episode 5 in LEG
  const finishedSnap = computeProgressSnapshot({
    url: legUrl,
    positionSec: 1410,
    durationSec: 1420,
    ended: true,
    nowIso: '2026-11-27T10:00:00.000Z',
    seriesTitle: 'Fool Night',
  });
  assert.ok(finishedSnap);
  let map = upsertEpisodeProgressMap({}, finishedSnap);
  assert.equal(isEpisodeMarkedWatched(dubUrl, map), true);

  // Rewatch episode 5 in DUB and stop at 5:00 (300s)
  const rewatchSnap = computeProgressSnapshot({
    url: dubUrl,
    positionSec: 300,
    durationSec: 1420,
    nowIso: '2026-11-27T11:00:00.000Z',
    seriesTitle: 'Fool Night Dublado',
  });
  assert.ok(rewatchSnap);
  map = upsertEpisodeProgressMap(map, rewatchSnap);

  assert.equal(Object.keys(map).length, 1);
  assert.equal(isEpisodeMarkedWatched(legUrl, map), false);
  assert.equal(isEpisodeMarkedWatched(dubUrl, map), false);
  assert.equal(findEpisodeProgressInMap(map, legUrl)?.positionSec, 300);
  assert.equal(findEpisodeProgressInMap(map, dubUrl)?.positionSec, 300);
});

test('storage unifies DUB and LEG history cards, resume progress, single-episode deletion, and full-anime deletion', async () => {
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
      getEpisodeResumeSeconds,
      loadEpisodeProgressMap,
      loadHistory,
      removeHistoryAnime,
      removeHistoryEpisode,
      saveEpisodeProgress,
      setEpisodesWatched,
    } = await import('./storage.ts');

    const ep12Leg = 'https://topanimes.net/episodio/fool-night-episodio-12/';
    const ep12Dub = 'https://topanimes.net/episodio/fool-night-dublado-episodio-12/';
    const ep11Leg = 'https://topanimes.net/episodio/fool-night-episodio-11/';
    const ep10Dub = 'https://topanimes.net/episodio/fool-night-dublado-episodio-10/';

    // Watch Ep 12 LEG until 420s -> resume time is shared with Ep 12 DUB
    saveEpisodeProgress({
      url: ep12Leg,
      positionSec: 420,
      durationSec: 1420,
      meta: {
        title: 'Fool Night — Episódio 12',
        seriesTitle: 'Fool Night',
        seriesUrl: 'https://topanimes.net/animes/fool-night/',
        seasonNumber: 1,
        episodeNumber: 12,
      },
    });
    assert.equal(getEpisodeResumeSeconds(ep12Dub), 420);
    assert.equal(loadHistory().length, 1);

    // Continue Ep 12 on DUB until 900s -> updates the SINGLE unified history card, no duplicate
    saveEpisodeProgress({
      url: ep12Dub,
      positionSec: 900,
      durationSec: 1420,
      meta: {
        title: 'Fool Night Dublado — Episódio 12',
        seriesTitle: 'Fool Night Dublado',
        seriesUrl: 'https://topanimes.net/anime-dublado/fool-night-dublado/',
        seasonNumber: 1,
        episodeNumber: 12,
        promoteInHistory: true,
      },
    });
    assert.equal(loadHistory().length, 1);
    assert.equal(getEpisodeResumeSeconds(ep12Leg), 900);
    assert.equal(Object.keys(loadEpisodeProgressMap()).length, 1);

    // Remove Ep 12 via LEG URL -> removes DUB card & progress too
    const singleRemoval = removeHistoryEpisode(ep12Leg);
    assert.equal(singleRemoval.history.length, 0);
    assert.equal(Object.keys(singleRemoval.progressMap).length, 0);

    // Mark Ep 11 LEG and Ep 10 DUB as watched -> removing anime from DUB entry clears BOTH tracks
    setEpisodesWatched([ep11Leg], true, {
      seriesUrl: 'https://topanimes.net/animes/fool-night/',
      seriesTitle: 'Fool Night',
      episodes: [{ url: ep11Leg, seasonNumber: 1, episodeNumber: 11 }],
    });
    setEpisodesWatched([ep10Dub], true, {
      seriesUrl: 'https://topanimes.net/anime-dublado/fool-night-dublado/',
      seriesTitle: 'Fool Night Dublado',
      episodes: [{ url: ep10Dub, seasonNumber: 1, episodeNumber: 10 }],
    });
    const histBefore = loadHistory();
    assert.equal(histBefore.length, 2);
    assert.equal(isSameHistoryAnime(histBefore[0], histBefore[1]), true);
    assert.equal(
      countAnimeTrackedEpisodes(histBefore, loadEpisodeProgressMap(), histBefore[0]).totalCount,
      2
    );

    const animeRemoval = removeHistoryAnime(histBefore[0]);
    assert.equal(animeRemoval.history.length, 0);
    assert.equal(Object.keys(animeRemoval.progressMap).length, 0);
    assert.equal(animeRemoval.totalClearedCount, 2);
  } finally {
    if (prevDescriptor) {
      Object.defineProperty(globalThis, 'localStorage', prevDescriptor);
    } else {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  }
});

test('formatHistoryWatchedDate and formatHistoryWatchedDateTime format local DD/MM/YYYY dates cleanly', () => {
  const sample = new Date(2026, 2, 5, 9, 7, 0).toISOString();
  assert.equal(formatHistoryWatchedDate(sample), '05/03/2026');
  assert.equal(formatHistoryWatchedDateTime(sample), '05/03/2026 às 09:07');

  const novSample = new Date(2026, 10, 27, 21, 45, 0).toISOString();
  assert.equal(formatHistoryWatchedDate(novSample), '27/11/2026');
  assert.equal(formatHistoryWatchedDateTime(novSample), '27/11/2026 às 21:45');

  assert.equal(formatHistoryWatchedDate(''), '');
  assert.equal(formatHistoryWatchedDate('invalid-date'), '');
  assert.equal(formatHistoryWatchedDate(undefined), '');
  assert.equal(formatHistoryWatchedDateTime(null), '');
});

