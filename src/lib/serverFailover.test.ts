import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getResolvedBestQuality,
  pickBestFailoverServer,
  scoreStreamQuality,
  shouldAutoAdvanceEpisode,
} from './serverFailover';
import type { PlayerOption, ResolvedEmbed } from './types';

function makeOpt(nume: string, label: string, providerKind: PlayerOption['providerKind']): PlayerOption {
  return {
    nume,
    label,
    embedUrl: `https://example.com/embed/${nume}`,
    providerKind,
  };
}

function makeResolved(
  nume: string,
  status: ResolvedEmbed['status'],
  heights: Array<{ height: number; format?: 'hls' | 'mp4' | 'unknown'; label?: string }>
): ResolvedEmbed {
  return {
    embedUrl: `https://example.com/embed/${nume}`,
    provider: `Srv ${nume}`,
    status,
    streams: heights.map((h, i) => ({
      height: h.height,
      format: h.format ?? 'mp4',
      label: h.label ?? (h.height > 0 ? `${h.height}p` : 'HLS Auto'),
      url: `https://cdn.example.com/${nume}-${i}.${h.format === 'hls' ? 'm3u8' : 'mp4'}`,
    })),
    subtitles: [],
    referer: 'https://topanimes.net/',
  };
}

test('scoreStreamQuality ranks explicit heights above adaptive HLS and SD above unknown', () => {
  assert.equal(scoreStreamQuality({ height: 1080, format: 'mp4', url: 'https://a/v.mp4' }), 1080);
  assert.equal(scoreStreamQuality({ height: 0, format: 'hls', url: 'https://a/m.m3u8' }), 720);
  assert.equal(scoreStreamQuality({ height: 480, format: 'mp4', url: 'https://a/v.mp4' }), 480);
  assert.equal(scoreStreamQuality({ height: 0, format: 'unknown', url: 'https://a/v' }), 1);
});

test('pickBestFailoverServer excludes failed servers and selects highest-quality working server', () => {
  const candidates = [
    {
      option: makeOpt('1', 'KojimaCDN', 'kojima'),
      resolved: makeResolved('1', 'resolved', [{ height: 1080, format: 'hls', label: '1080p' }]),
      orderIndex: 0,
    },
    {
      option: makeOpt('2', 'BG', 'blogger'),
      resolved: makeResolved('2', 'resolved', [{ height: 480, format: 'mp4', label: '480p' }]),
      orderIndex: 1,
    },
    {
      option: makeOpt('3', 'Zuplay', 'zuplay'),
      resolved: makeResolved('3', 'resolved', [{ height: 1080, format: 'mp4', label: '1080p' }]),
      orderIndex: 2,
    },
    {
      option: makeOpt('4', 'Ruplay', 'playerjs'),
      resolved: makeResolved('4', 'error', []),
      orderIndex: 3,
    },
  ];

  // Server 1 failed -> should jump straight to Server 3 (1080p) instead of Server 2 (480p)
  const winner = pickBestFailoverServer(candidates, new Set(['1']));
  assert.ok(winner);
  assert.equal(winner.option.nume, '3');
  assert.equal(winner.qualityScore, 1080);
  assert.equal(winner.qualityLabel, '1080p');

  // If 1 and 3 failed -> falls back to 2 (480p), never 4 (error)
  const fallback = pickBestFailoverServer(candidates, new Set(['1', '3']));
  assert.ok(fallback);
  assert.equal(fallback.option.nume, '2');
  assert.equal(fallback.qualityScore, 480);

  // All failed -> null
  assert.equal(pickBestFailoverServer(candidates, new Set(['1', '2', '3'])), null);
});

test('pickBestFailoverServer breaks equal-quality ties by provider reliability', () => {
  const candidates = [
    {
      option: makeOpt('1', 'BG', 'blogger'),
      resolved: makeResolved('1', 'resolved', [{ height: 720, format: 'mp4' }]),
      orderIndex: 0,
    },
    {
      option: makeOpt('2', 'Zuplay', 'zuplay'),
      resolved: makeResolved('2', 'resolved', [{ height: 0, format: 'hls', label: 'HLS Auto' }]),
      orderIndex: 1,
    },
  ];

  const winner = pickBestFailoverServer(candidates, new Set());
  assert.ok(winner);
  assert.equal(winner.option.nume, '2');
  assert.deepEqual(getResolvedBestQuality(candidates[1].resolved), {
    score: 720,
    label: 'HLS Auto',
  });
});

test('shouldAutoAdvanceEpisode blocks unstarted, loading, failed, and duplicate end triggers', () => {
  const ep1 = 'https://topanimes.net/episodio/anime-episodio-1/';
  const ep2 = 'https://topanimes.net/episodio/anime-episodio-2/';

  assert.equal(
    shouldAutoAdvanceEpisode({
      autoPlayNextEpisode: true,
      loadingEpisode: false,
      playbackFailed: false,
      hasPlaybackStarted: true,
      currentEpisodeUrl: ep1,
      nextEpisodeUrl: ep2,
      alreadyTriggeredForUrl: null,
    }),
    true
  );

  // Unstarted episode ended immediately (e.g. broken stream) -> do NOT skip to ep 3!
  assert.equal(
    shouldAutoAdvanceEpisode({
      autoPlayNextEpisode: true,
      loadingEpisode: false,
      playbackFailed: false,
      hasPlaybackStarted: false,
      currentEpisodeUrl: ep1,
      nextEpisodeUrl: ep2,
    }),
    false
  );

  // Duplicate onEnded for same episode -> blocked
  assert.equal(
    shouldAutoAdvanceEpisode({
      autoPlayNextEpisode: true,
      loadingEpisode: false,
      playbackFailed: false,
      hasPlaybackStarted: true,
      currentEpisodeUrl: ep1,
      nextEpisodeUrl: ep2,
      alreadyTriggeredForUrl: ep1,
    }),
    false
  );

  // Still loading next episode -> blocked
  assert.equal(
    shouldAutoAdvanceEpisode({
      autoPlayNextEpisode: true,
      loadingEpisode: true,
      playbackFailed: false,
      hasPlaybackStarted: true,
      currentEpisodeUrl: ep1,
      nextEpisodeUrl: ep2,
    }),
    false
  );
});
