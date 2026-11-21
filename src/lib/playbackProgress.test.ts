import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildWatchedProgressMap,
  canonicalEpisodeProgressKey,
  computeProgressSnapshot,
  DEFAULT_VIDEO_SCALE,
  formatPlaybackTimestamp,
  getResumePositionSec,
  getVideoScaleLabel,
  groupEpisodesBySeason,
  indexToVideoScale,
  isEpisodeCompleted,
  isEpisodeMarkedWatched,
  sanitizeEpisodeProgressMap,
  sanitizeVideoScaleMode,
  upsertEpisodeProgressMap,
  videoScaleToIndex,
  type EpisodeProgressMap,
} from './playbackProgress';

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
