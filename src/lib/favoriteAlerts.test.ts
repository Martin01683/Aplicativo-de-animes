import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceBaselineWithWatchedEpisodes,
  buildFavoriteBaseline,
  canonicalEpisodeKey,
  detectNewFavoriteEpisodes,
  extractEpisodeNumber,
  extractMediaSlug,
  isItemFavorited,
  toSeriesFavoriteItem,
} from './favoriteAlerts';
import type { CatalogMediaItem, FavoriteBaselineMap } from './types';

test('extractMediaSlug strips category prefixes and episode suffixes', () => {
  assert.equal(
    extractMediaSlug('https://topanimes.net/animes/hotaru-no-yomeiri-dublado/'),
    'hotaru-no-yomeiri-dublado'
  );
  assert.equal(
    extractMediaSlug('https://topanimes.net/episodio/hotaru-no-yomeiri-dublado-episodio-4/'),
    'hotaru-no-yomeiri-dublado'
  );
  assert.equal(
    extractMediaSlug('https://topanimes.net/filmes/koe-no-katachi/'),
    'koe-no-katachi'
  );
});

test('extractEpisodeNumber parses episode numbers from urls and labels', () => {
  assert.equal(
    extractEpisodeNumber('https://topanimes.net/episodio/hotaru-no-yomeiri-dublado-episodio-5/'),
    5
  );
  assert.equal(extractEpisodeNumber('EP 12'), 12);
  assert.equal(extractEpisodeNumber('Episódio 8'), 8);
  assert.equal(extractEpisodeNumber('Filme Único'), null);
});

test('toSeriesFavoriteItem normalizes episode card to series anime item', () => {
  const episodeCard: CatalogMediaItem = {
    id: 'https://topanimes.net/episodio/hotaru-no-yomeiri-dublado-episodio-4/',
    title: 'Hotaru no Yomeiri Dublado - EP 4',
    episodeLabel: 'EP 4',
    url: 'https://topanimes.net/episodio/hotaru-no-yomeiri-dublado-episodio-4/',
    kind: 'episode',
    poster: 'https://example.com/poster.jpg',
    audioType: 'DUB',
  };

  const seriesItem = toSeriesFavoriteItem(episodeCard);
  assert.equal(seriesItem.url, 'https://topanimes.net/animes/hotaru-no-yomeiri-dublado/');
  assert.equal(seriesItem.kind, 'anime');
  assert.equal(seriesItem.title, 'Hotaru no Yomeiri Dublado');
  assert.equal(isItemFavorited(episodeCard.url, [seriesItem]), true);
});

test('detectNewFavoriteEpisodes detects newer episode against baseline and prevents duplicates', () => {
  const fav: CatalogMediaItem = {
    id: 'https://topanimes.net/animes/hotaru-no-yomeiri-dublado/',
    title: 'Hotaru no Yomeiri Dublado',
    url: 'https://topanimes.net/animes/hotaru-no-yomeiri-dublado/',
    kind: 'anime',
    poster: 'https://example.com/poster.jpg',
    audioType: 'DUB',
  };

  const ep3Release: CatalogMediaItem = {
    id: 'ep3',
    title: 'Hotaru no Yomeiri Dublado',
    episodeLabel: 'EP 3',
    url: 'https://topanimes.net/episodio/hotaru-no-yomeiri-dublado-episodio-3/',
    kind: 'episode',
    poster: 'https://example.com/ep3.jpg',
    audioType: 'DUB',
  };

  const baseline = buildFavoriteBaseline(fav, [ep3Release], null, '2026-11-20T10:00:00Z');
  assert.ok(baseline);
  assert.equal(baseline.lastEpisodeNumber, 3);

  const ep5Release: CatalogMediaItem = {
    id: 'ep5',
    title: 'Hotaru no Yomeiri Dublado',
    episodeLabel: 'EP 5',
    url: 'https://topanimes.net/episodio/hotaru-no-yomeiri-dublado-episodio-5/',
    kind: 'episode',
    poster: 'https://example.com/ep5.jpg',
    audioType: 'DUB',
  };

  const firstRun = detectNewFavoriteEpisodes({
    favorites: [fav],
    releases: [ep5Release],
    baselines: { [fav.url]: baseline },
    existingAlerts: [],
    nowIso: '2026-11-20T12:00:00Z',
  });

  assert.equal(firstRun.newAlerts.length, 1);
  assert.equal(firstRun.newAlerts[0].animeTitle, 'Hotaru no Yomeiri Dublado');
  assert.equal(firstRun.newAlerts[0].episodeLabel, 'EP 5');
  assert.equal(firstRun.nextBaselines[fav.url].lastEpisodeNumber, 5);

  // Running again with same release must not duplicate alert
  const secondRun = detectNewFavoriteEpisodes({
    favorites: [fav],
    releases: [ep5Release],
    baselines: firstRun.nextBaselines,
    existingAlerts: firstRun.nextAlerts,
    nowIso: '2026-11-20T12:05:00Z',
  });
  assert.equal(secondRun.newAlerts.length, 0);
  assert.equal(secondRun.nextAlerts.length, 1);
});

test('detectNewFavoriteEpisodes ignores older releases than baseline', () => {
  const fav: CatalogMediaItem = {
    id: 'https://topanimes.net/animes/frieren/',
    title: 'Frieren',
    url: 'https://topanimes.net/animes/frieren/',
    kind: 'anime',
    poster: 'https://example.com/frieren.jpg',
    audioType: 'LEG',
  };

  const ep20Release: CatalogMediaItem = {
    id: 'ep20',
    title: 'Frieren',
    episodeLabel: 'EP 20',
    url: 'https://topanimes.net/episodio/frieren-episodio-20/',
    kind: 'episode',
    poster: 'https://example.com/ep20.jpg',
    audioType: 'LEG',
  };

  const result = detectNewFavoriteEpisodes({
    favorites: [fav],
    releases: [ep20Release],
    baselines: {
      [fav.url]: {
        lastEpisodeUrl: 'https://topanimes.net/episodio/frieren-episodio-22/',
        lastEpisodeNumber: 22,
        updatedAt: '2026-11-20T08:00:00Z',
      },
    },
    existingAlerts: [],
  });

  assert.equal(result.newAlerts.length, 0);
});

test('pickLatestAnimeEpisode picks highest numbered episode regardless of list order', async () => {
  const { pickLatestAnimeEpisode } = await import('./favoriteAlerts');
  const latest = pickLatestAnimeEpisode(
    [
      { numberLabel: '1 - 1', episodeNumber: 1, title: 'Episódio 1', url: 'https://topanimes.net/episodio/anime-episodio-1/' },
      { numberLabel: '1 - 4', episodeNumber: 4, title: 'Episódio 4', url: 'https://topanimes.net/episodio/anime-episodio-4/' },
      { numberLabel: '1 - 2', episodeNumber: 2, title: 'Episódio 2', url: 'https://topanimes.net/episodio/anime-episodio-2/' },
    ],
    'Meu Anime',
    'https://example.com/p.jpg'
  );
  assert.ok(latest);
  assert.equal(latest.episodeNumber, 4);
  assert.equal(latest.episodeLabel, 'EP 4');
});

test('detectNewFavoriteEpisodes suppresses notifications for episodes already marked as watched while still alerting on subsequent unwatched episodes', () => {
  const fav: CatalogMediaItem = {
    id: 'https://topanimes.net/animes/solo-leveling/',
    title: 'Solo Leveling',
    url: 'https://topanimes.net/animes/solo-leveling/',
    kind: 'anime',
    poster: 'https://example.com/sl.jpg',
    audioType: 'LEG',
  };

  const baselines: FavoriteBaselineMap = {
    [fav.url]: {
      lastEpisodeUrl: 'https://topanimes.net/episodio/solo-leveling-episodio-10/',
      lastEpisodeNumber: 10,
      updatedAt: '2026-11-20T08:00:00Z',
    },
  };

  const ep12Release: CatalogMediaItem = {
    id: 'ep12',
    title: 'Solo Leveling',
    episodeLabel: 'EP 12',
    url: 'https://topanimes.net/episodio/solo-leveling-episodio-12/',
    kind: 'episode',
    poster: 'https://example.com/ep12.jpg',
    audioType: 'LEG',
  };

  // User already marked Season 1 (including EP 12) as watched
  const watchedKeys = new Set([
    canonicalEpisodeKey('https://topanimes.net/episodio/solo-leveling-episodio-11/'),
    canonicalEpisodeKey('https://topanimes.net/episodio/solo-leveling-episodio-12/'),
  ]);

  const checkWatched = detectNewFavoriteEpisodes({
    favorites: [fav],
    releases: [ep12Release],
    baselines,
    existingAlerts: [],
    watchedEpisodeKeys: watchedKeys,
    nowIso: '2026-11-21T10:00:00Z',
  });

  // No notification should be created for EP 12, and baseline advances silently
  assert.equal(checkWatched.newAlerts.length, 0);
  assert.equal(checkWatched.nextAlerts.length, 0);
  assert.equal(checkWatched.nextBaselines[fav.url].lastEpisodeNumber, 12);

  // When EP 13 comes out later and is NOT marked watched, notification MUST fire
  const ep13Release: CatalogMediaItem = {
    id: 'ep13',
    title: 'Solo Leveling',
    episodeLabel: 'EP 13',
    url: 'https://topanimes.net/episodio/solo-leveling-episodio-13/',
    kind: 'episode',
    poster: 'https://example.com/ep13.jpg',
    audioType: 'LEG',
  };

  const checkUnwatched = detectNewFavoriteEpisodes({
    favorites: [fav],
    releases: [ep13Release],
    baselines: checkWatched.nextBaselines,
    existingAlerts: checkWatched.nextAlerts,
    watchedEpisodeKeys: watchedKeys,
    nowIso: '2026-11-21T12:00:00Z',
  });

  assert.equal(checkUnwatched.newAlerts.length, 1);
  assert.equal(checkUnwatched.newAlerts[0].episodeLabel, 'EP 13');
});

test('advanceBaselineWithWatchedEpisodes updates favorite baseline to highest marked episode', () => {
  const animeUrl = 'https://topanimes.net/animes/frieren/';
  const next = advanceBaselineWithWatchedEpisodes({
    animeUrl,
    episodes: [
      { url: 'https://topanimes.net/episodio/frieren-episodio-1/', episodeNumber: 1 },
      { url: 'https://topanimes.net/episodio/frieren-episodio-28/', episodeNumber: 28 },
    ],
    baselines: {
      [animeUrl]: {
        lastEpisodeUrl: 'https://topanimes.net/episodio/frieren-episodio-5/',
        lastEpisodeNumber: 5,
        updatedAt: '2026-11-20T00:00:00Z',
      },
    },
    nowIso: '2026-11-21T12:00:00Z',
  });

  assert.equal(next[animeUrl].lastEpisodeNumber, 28);
  assert.equal(
    next[animeUrl].lastEpisodeUrl,
    'https://topanimes.net/episodio/frieren-episodio-28/'
  );
});

test('detectNewFavoriteEpisodes detects multiple dropped episodes without losing intermediate episodes', () => {
  const fav: CatalogMediaItem = {
    id: 'https://topanimes.net/animes/dandadan/',
    title: 'Dandadan',
    url: 'https://topanimes.net/animes/dandadan/',
    kind: 'anime',
    poster: 'https://example.com/dandadan.jpg',
    audioType: 'DUB',
  };

  const result = detectNewFavoriteEpisodes({
    favorites: [fav],
    releases: [],
    baselines: {
      [fav.url]: {
        lastEpisodeUrl: 'https://topanimes.net/episodio/dandadan-episodio-3/',
        lastEpisodeNumber: 3,
        updatedAt: '2026-11-20T08:00:00Z',
      },
    },
    existingAlerts: [],
    latestByAnimeUrl: {
      [fav.url]: {
        poster: 'https://example.com/dandadan.jpg',
        episodeUrl: 'https://topanimes.net/episodio/dandadan-episodio-5/',
        episodeNumber: 5,
        episodeLabel: 'EP 5',
        episodeTitle: 'Episódio 5',
        audioType: 'DUB',
        recentEpisodes: [
          {
            episodeUrl: 'https://topanimes.net/episodio/dandadan-episodio-5/',
            episodeNumber: 5,
            episodeLabel: 'EP 5',
            episodeTitle: 'Episódio 5',
          },
          {
            episodeUrl: 'https://topanimes.net/episodio/dandadan-episodio-4/',
            episodeNumber: 4,
            episodeLabel: 'EP 4',
            episodeTitle: 'Episódio 4',
          },
          {
            episodeUrl: 'https://topanimes.net/episodio/dandadan-episodio-3/',
            episodeNumber: 3,
            episodeLabel: 'EP 3',
            episodeTitle: 'Episódio 3',
          },
        ],
      },
    },
    nowIso: '2026-11-22T12:00:00Z',
  });

  assert.equal(result.newAlerts.length, 2);
  assert.deepEqual(
    result.newAlerts.map((a) => a.episodeLabel),
    ['EP 5', 'EP 4']
  );
  assert.equal(result.newAlerts[0].audioType, 'DUB');
  assert.equal(result.nextBaselines[fav.url].lastEpisodeNumber, 5);
});

test('detectNewFavoriteEpisodes suppresses alerts for muted favorites and mismatched audio filter while advancing baseline', () => {
  const dubFav: CatalogMediaItem = {
    id: 'https://topanimes.net/animes/anime-dub/',
    title: 'Anime Dublado',
    url: 'https://topanimes.net/animes/anime-dub/',
    kind: 'anime',
    poster: 'https://example.com/dub.jpg',
    audioType: 'DUB',
  };
  const legFav: CatalogMediaItem = {
    id: 'https://topanimes.net/animes/anime-leg/',
    title: 'Anime Legendado',
    url: 'https://topanimes.net/animes/anime-leg/',
    kind: 'anime',
    poster: 'https://example.com/leg.jpg',
    audioType: 'LEG',
  };

  const baselines: FavoriteBaselineMap = {
    [dubFav.url]: {
      lastEpisodeUrl: 'https://topanimes.net/episodio/anime-dub-episodio-1/',
      lastEpisodeNumber: 1,
      updatedAt: '2026-11-20T00:00:00Z',
    },
    [legFav.url]: {
      lastEpisodeUrl: 'https://topanimes.net/episodio/anime-leg-episodio-1/',
      lastEpisodeNumber: 1,
      updatedAt: '2026-11-20T00:00:00Z',
    },
  };

  const releases: CatalogMediaItem[] = [
    {
      id: 'dub-2',
      title: 'Anime Dublado',
      episodeLabel: 'EP 2',
      url: 'https://topanimes.net/episodio/anime-dub-episodio-2/',
      kind: 'episode',
      poster: 'https://example.com/dub.jpg',
      audioType: 'DUB',
    },
    {
      id: 'leg-2',
      title: 'Anime Legendado',
      episodeLabel: 'EP 2',
      url: 'https://topanimes.net/episodio/anime-leg-episodio-2/',
      kind: 'episode',
      poster: 'https://example.com/leg.jpg',
      audioType: 'LEG',
    },
  ];

  // Mute dubFav -> only legFav alerts, but dubFav baseline still advances
  const mutedRun = detectNewFavoriteEpisodes({
    favorites: [dubFav, legFav],
    releases,
    baselines,
    existingAlerts: [],
    mutedFavoriteUrls: [dubFav.url],
    nowIso: '2026-11-22T10:00:00Z',
  });
  assert.equal(mutedRun.newAlerts.length, 1);
  assert.equal(mutedRun.newAlerts[0].animeTitle, 'Anime Legendado');
  assert.equal(mutedRun.nextBaselines[dubFav.url].lastEpisodeNumber, 2);

  // Filter to DUB only -> only dubFav alerts
  const audioFilteredRun = detectNewFavoriteEpisodes({
    favorites: [dubFav, legFav],
    releases,
    baselines,
    existingAlerts: [],
    notifyAudioFilter: 'DUB',
    nowIso: '2026-11-22T10:00:00Z',
  });
  assert.equal(audioFilteredRun.newAlerts.length, 1);
  assert.equal(audioFilteredRun.newAlerts[0].animeTitle, 'Anime Dublado');
  assert.equal(audioFilteredRun.nextBaselines[legFav.url].lastEpisodeNumber, 2);
});


