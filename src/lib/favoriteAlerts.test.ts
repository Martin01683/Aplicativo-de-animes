import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFavoriteBaseline,
  detectNewFavoriteEpisodes,
  extractEpisodeNumber,
  extractMediaSlug,
  isItemFavorited,
  toSeriesFavoriteItem,
} from './favoriteAlerts';
import type { CatalogMediaItem } from './types';

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

