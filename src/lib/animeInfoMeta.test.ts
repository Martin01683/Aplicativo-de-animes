import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAnimeInfoMetaItems,
  extractAnimeProviders,
  parseProviderNames,
  resolveAnimeHeroAudioBadges,
  resolveEpisodeAudioBadges,
  resolveEpisodeMediaKind,
  resolveVisibleGenres,
} from './animeInfoMeta';
import type { AnimeDetails } from './types';

function makeAnime(overrides: Partial<AnimeDetails> = {}): AnimeDetails {
  return {
    url: 'https://topanimes.net/animes/kimetsu-no-yaiba/',
    title: 'Kimetsu no Yaiba',
    kind: 'anime',
    poster: '',
    backdrop: '',
    synopsis: '',
    audioType: 'LEG',
    genres: ['Ação'],
    episodes: [
      {
        title: 'Episódio 1',
        numberLabel: '1', episodeNumber: 1,
        url: 'https://topanimes.net/episodio/kimetsu-1/',
        availableOnServer: true,
      },
    ],
    ...overrides,
  };
}

test('parseProviderNames splits multi-provider strings and deduplicates case-insensitively', () => {
  assert.deepEqual(parseProviderNames('TopAnimes, Hinata Soul · topanimes + AnimeFire'), [
    'TopAnimes',
    'Hinata Soul',
    'AnimeFire',
  ]);
  assert.deepEqual(parseProviderNames(''), []);
});

test('extractAnimeProviders combines sourceServerName with providers found across unified episodes and audio tracks', () => {
  const anime = makeAnime({
    sourceServerName: 'TopAnimes',
    audioTracks: {
      LEG: {
        audioType: 'LEG',
        sourceUrl: 'https://topanimes.net/animes/kimetsu-no-yaiba/',
        playableCount: 1,
        episodes: [
          {
            title: 'Ep 1',
            numberLabel: '1', episodeNumber: 1,
            url: 'https://topanimes.net/episodio/kimetsu-1/',
            availableOnServer: true,
          },
        ],
      },
      DUB: {
        audioType: 'DUB',
        sourceUrl: 'https://www.hinatasoul.com/animes/kimetsu-no-yaiba-dublado',
        playableCount: 1,
        episodes: [
          {
            title: 'Ep 1',
            numberLabel: '1', episodeNumber: 1,
            url: 'https://www.hinatasoul.com/videos/kimetsu-dub-1',
            availableOnServer: true,
          },
        ],
      },
    },
  });

  assert.deepEqual(extractAnimeProviders(anime), ['TopAnimes', 'Hinata Soul']);
});

test('buildAnimeInfoMetaItems includes Nota in Informações when rating > 0 and omits invalid/zero ratings', () => {
  const rated = buildAnimeInfoMetaItems(makeAnime({ status: 'Finalizado', rating: '9.7' }));
  const ratingItem = rated.find((item) => item.id === 'rating');
  assert.ok(ratingItem);
  assert.equal(ratingItem.label, 'Nota');
  assert.equal(ratingItem.value, '9.7');
  assert.equal(ratingItem.kind, 'rating');

  const unrated = buildAnimeInfoMetaItems(makeAnime({ rating: '0' }));
  assert.equal(unrated.find((item) => item.id === 'rating'), undefined);
});

test('buildAnimeInfoMetaItems uses singular Provedor for 1 provider and full-width plural Provedores for multiple', () => {
  const single = buildAnimeInfoMetaItems(makeAnime({ sourceServerName: 'TopAnimes' }));
  const singleProv = single.find((item) => item.id === 'providers');
  assert.ok(singleProv);
  assert.equal(singleProv.label, 'Provedor');
  assert.equal(singleProv.fullWidth, false);
  assert.deepEqual(singleProv.items, ['TopAnimes']);

  const multiple = buildAnimeInfoMetaItems(
    makeAnime({ sourceServerName: 'TopAnimes, Hinata Soul, AniTube' })
  );
  const multiProv = multiple.find((item) => item.id === 'providers');
  assert.ok(multiProv);
  assert.equal(multiProv.label, 'Provedores');
  assert.equal(multiProv.fullWidth, true);
  assert.deepEqual(multiProv.items, ['TopAnimes', 'Hinata Soul', 'AniTube']);
});

test('resolveAnimeHeroAudioBadges returns both DUB and LEG simultaneously when both audio tracks exist', () => {
  const dualAudio = makeAnime({
    audioType: 'LEG',
    audioTracks: {
      DUB: {
        audioType: 'DUB',
        sourceUrl: 'https://topanimes.net/animes/kimetsu-dub/',
        playableCount: 5,
        episodes: [{ title: 'Ep 1', numberLabel: '1', episodeNumber: 1, url: 'https://topanimes.net/ep/dub-1/', availableOnServer: true }],
      },
      LEG: {
        audioType: 'LEG',
        sourceUrl: 'https://topanimes.net/animes/kimetsu/',
        playableCount: 26,
        episodes: [{ title: 'Ep 1', numberLabel: '1', episodeNumber: 1, url: 'https://topanimes.net/ep/leg-1/', availableOnServer: true }],
      },
    },
  });
  assert.deepEqual(resolveAnimeHeroAudioBadges(dualAudio), ['DUB', 'LEG']);

  const singleLeg = makeAnime({ audioType: 'LEG' });
  assert.deepEqual(resolveAnimeHeroAudioBadges(singleLeg), ['LEG']);

  const singleDub = makeAnime({ audioType: 'DUB' });
  assert.deepEqual(resolveAnimeHeroAudioBadges(singleDub), ['DUB']);

  const noAudio = makeAnime({ audioType: null });
  assert.deepEqual(resolveAnimeHeroAudioBadges(noAudio), []);
});

test('resolveVisibleGenres prioritizes TheTVDB primary genres, filters redundant media labels, and falls back to provider genres', () => {
  assert.deepEqual(
    resolveVisibleGenres(
      ['Ação', 'Aventura', 'Animação', 'Anime', 'Fantasia', 'ação'],
      ['Ação', 'Fantasia', 'Shounen'],
      'anime'
    ),
    ['Ação', 'Aventura', 'Animação', 'Fantasia']
  );

  assert.deepEqual(
    resolveVisibleGenres([], ['Ação', 'Anime', 'Fantasia', 'Shounen'], 'anime'),
    ['Ação', 'Fantasia', 'Shounen']
  );

  assert.deepEqual(
    resolveVisibleGenres(['Anime', '  '], ['Drama', 'Suspense'], 'anime'),
    ['Drama', 'Suspense']
  );

  assert.deepEqual(
    resolveVisibleGenres(['Filme', 'Ação', 'Ficção Científica'], undefined, 'movie'),
    ['Ação', 'Ficção Científica']
  );

  assert.deepEqual(
    resolveVisibleGenres(['Série', 'Drama', 'Mistério'], undefined, 'series'),
    ['Drama', 'Mistério']
  );
});

test('resolveEpisodeMediaKind distinguishes anime, movie, and series from episode or parent series metadata', () => {
  assert.equal(resolveEpisodeMediaKind({ isMovie: true }), 'movie');
  assert.equal(
    resolveEpisodeMediaKind({ url: 'https://topanimes.net/filmes/suzume/' }),
    'movie'
  );
  assert.equal(
    resolveEpisodeMediaKind({ seriesUrl: 'https://topanimes.net/series/the-last-of-us/' }),
    'series'
  );
  assert.equal(resolveEpisodeMediaKind({ seriesKind: 'series' }), 'series');
  assert.equal(
    resolveEpisodeMediaKind({ seriesUrl: 'https://topanimes.net/animes/solo-leveling/' }),
    'anime'
  );
});

test('resolveEpisodeAudioBadges identifies Dublado or Legendado for episodes opened directly from Home', () => {
  assert.deepEqual(
    resolveEpisodeAudioBadges({
      title: 'Solo Leveling Dublado - EP 1',
      url: 'https://topanimes.net/episodio/solo-leveling-dublado-episodio-1/',
    }),
    ['DUB']
  );
  assert.deepEqual(
    resolveEpisodeAudioBadges({
      title: 'Sousou no Frieren - EP 1',
      matchedEpisodeAudio: 'LEG',
    }),
    ['LEG']
  );
  assert.deepEqual(
    resolveEpisodeAudioBadges({
      title: 'Sousou no Frieren - EP 1',
      seriesAudioType: 'LEG',
    }),
    ['LEG']
  );
  assert.deepEqual(
    resolveEpisodeAudioBadges({
      title: 'Anime X - EP 2',
      options: [{ label: 'Vidstreaming', audioType: 'DUB' }],
    }),
    ['DUB']
  );
});



