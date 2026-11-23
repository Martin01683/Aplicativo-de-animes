import test from 'node:test';
import assert from 'node:assert/strict';
import type { HttpFetcher } from './httpTypes.ts';
import {
  buildUnifiedSeriesTitle,
  extractSeasonAndPartInfo,
  matchSiblingSeasonCandidates,
  unifyServerSeasonsWithCatalog,
} from './catalog/seasonUnifier.ts';
import { enrichServerDetailsWithTheTvdb } from './catalog/providers/thetvdbProvider.ts';
import type { AnimeDetails, AnimeEpisodeLink, SearchResultItem } from './types.ts';

test('extractSeasonAndPartInfo parses numbered, Roman, Final Season, Part/Cour, Dublado, and rejects movies/OVAs', () => {
  const s2Pt = extractSeasonAndPartInfo('Sousou no Frieren 2ª Temporada Dublado');
  assert.equal(s2Pt.baseTitle, 'Sousou no Frieren');
  assert.equal(s2Pt.seasonNumber, 2);
  assert.equal(s2Pt.audioType, 'DUB');
  assert.equal(s2Pt.isMovieOrSpecial, false);

  const s2En = extractSeasonAndPartInfo('Black Clover 2nd Season');
  assert.equal(s2En.baseTitle, 'Black Clover');
  assert.equal(s2En.seasonNumber, 2);

  const trailingNum = extractSeasonAndPartInfo('Boku no Hero Academia 6');
  assert.equal(trailingNum.baseTitle, 'Boku no Hero Academia');
  assert.equal(trailingNum.seasonNumber, 6);

  const roman = extractSeasonAndPartInfo('Mob Psycho 100 III');
  assert.equal(roman.baseTitle, 'Mob Psycho 100');
  assert.equal(roman.seasonNumber, 3);

  const part2 = extractSeasonAndPartInfo('Spy x Family Part 2');
  assert.equal(part2.baseTitle, 'Spy x Family');
  assert.equal(part2.seasonNumber, null);
  assert.equal(part2.partNumber, 2);

  const s2Part2 = extractSeasonAndPartInfo('Mushoku Tensei 2nd Season Part 2');
  assert.equal(s2Part2.baseTitle, 'Mushoku Tensei');
  assert.equal(s2Part2.seasonNumber, 2);
  assert.equal(s2Part2.partNumber, 2);

  const finalS = extractSeasonAndPartInfo('Shingeki no Kyojin: The Final Season');
  assert.equal(finalS.baseTitle, 'Shingeki no Kyojin');
  assert.equal(finalS.isFinalSeason, true);

  const movie = extractSeasonAndPartInfo('Kimetsu no Yaiba: Mugen Ressha-hen (Filme)');
  assert.equal(movie.isMovieOrSpecial, true);

  const jjk0 = extractSeasonAndPartInfo('Jujutsu Kaisen 0');
  assert.equal(jjk0.seasonNumber, null);
  assert.equal(jjk0.baseTitle, 'Jujutsu Kaisen 0');

  const ranma = extractSeasonAndPartInfo('Ranma 1/2 3rd Season');
  assert.equal(ranma.baseTitle, 'Ranma 1/2');
  assert.equal(ranma.seasonNumber, 3);

  assert.equal(buildUnifiedSeriesTitle('Sousou no Frieren 2ª Temporada'), 'Sousou no Frieren');
  assert.equal(
    buildUnifiedSeriesTitle('Sousou no Frieren 2ª Temporada Dublado', 'DUB'),
    'Sousou no Frieren Dublado'
  );
});

test('matchSiblingSeasonCandidates discovers missing seasons, preserves audio & provider preference, and rejects movies/spin-offs', () => {
  const candidates: SearchResultItem[] = [
    {
      id: 'jjk-1',
      title: 'Jujutsu Kaisen',
      url: 'https://topanimes.net/animes/jujutsu-kaisen/',
      poster: '',
      kind: 'anime',
      audioType: 'LEG',
    },
    {
      id: 'jjk-1-dub',
      title: 'Jujutsu Kaisen Dublado',
      url: 'https://topanimes.net/animes/jujutsu-kaisen-dublado/',
      poster: '',
      kind: 'anime',
      audioType: 'DUB',
    },
    {
      id: 'jjk-2',
      title: 'Jujutsu Kaisen 2nd Season',
      url: 'https://topanimes.net/animes/jujutsu-kaisen-2nd-season/',
      poster: '',
      kind: 'anime',
      audioType: 'LEG',
    },
    {
      id: 'jjk-2-dub',
      title: 'Jujutsu Kaisen 2nd Season Dublado',
      url: 'https://topanimes.net/animes/jujutsu-kaisen-2nd-season-dublado/',
      poster: '',
      kind: 'anime',
      audioType: 'DUB',
    },
    {
      id: 'jjk-3',
      title: 'Jujutsu Kaisen 3rd Season',
      url: 'https://www.hinatasoul.com/animes/jujutsu-kaisen-3',
      poster: '',
      kind: 'anime',
      audioType: 'LEG',
    },
    {
      id: 'jjk-0',
      title: 'Jujutsu Kaisen 0',
      url: 'https://topanimes.net/animes/jujutsu-kaisen-0/',
      poster: '',
      kind: 'anime',
      audioType: 'LEG',
    },
    {
      id: 'jjk-movie',
      title: 'Jujutsu Kaisen: The Movie',
      url: 'https://topanimes.net/filmes/jujutsu-kaisen-movie/',
      poster: '',
      kind: 'movie',
      audioType: 'LEG',
    },
  ];

  // Opening Season 1 Dublado -> picks Season 2 Dublado (same audio!) and falls back to Season 3 LEG on Hinata Soul
  const fromDubS1 = matchSiblingSeasonCandidates({
    primaryUrl: 'https://topanimes.net/animes/jujutsu-kaisen-dublado/',
    primaryTitle: 'Jujutsu Kaisen Dublado',
    primaryAudioType: 'DUB',
    primarySeasonNumber: 1,
    referenceTitles: ['Jujutsu Kaisen'],
    tvdbSeasons: [1, 2, 3],
    alreadyCoveredSeasons: new Set([1]),
    searchCandidates: candidates,
  });

  assert.equal(fromDubS1.length, 2);
  assert.equal(fromDubS1[0].seasonNumber, 2);
  assert.equal(fromDubS1[0].url, 'https://topanimes.net/animes/jujutsu-kaisen-2nd-season-dublado/');
  assert.equal(fromDubS1[1].seasonNumber, 3);
  assert.equal(fromDubS1[1].url, 'https://www.hinatasoul.com/animes/jujutsu-kaisen-3');

  // Opening Season 2 LEG -> picks Season 1 LEG (same provider/audio) and Season 3 LEG
  const fromLegS2 = matchSiblingSeasonCandidates({
    primaryUrl: 'https://topanimes.net/animes/jujutsu-kaisen-2nd-season/',
    primaryTitle: 'Jujutsu Kaisen 2nd Season',
    primaryAudioType: 'LEG',
    primarySeasonNumber: 2,
    referenceTitles: ['Jujutsu Kaisen'],
    tvdbSeasons: [1, 2, 3],
    alreadyCoveredSeasons: new Set([2]),
    searchCandidates: candidates,
  });

  assert.equal(fromLegS2.length, 2);
  assert.equal(fromLegS2[0].seasonNumber, 1);
  assert.equal(fromLegS2[0].url, 'https://topanimes.net/animes/jujutsu-kaisen/');
  assert.equal(fromLegS2[1].seasonNumber, 3);
  assert.equal(fromLegS2[1].url, 'https://www.hinatasoul.com/animes/jujutsu-kaisen-3');
});

test('matchSiblingSeasonCandidates matches subtitled arc seasons by unique TheTVDB air year and rejects spin-offs', () => {
  const catalogEps: AnimeEpisodeLink[] = [
    {
      numberLabel: 'EP 1',
      episodeNumber: 1,
      seasonNumber: 1,
      title: 'Ep 1',
      url: 'anisync://episode/anime/thetvdb/1/s1/e1',
      date: '2019-04-06',
    },
    {
      numberLabel: 'T2 · EP 1',
      episodeNumber: 1,
      seasonNumber: 2,
      title: 'Ep 1',
      url: 'anisync://episode/anime/thetvdb/1/s2/e1',
      date: '2021-12-05',
    },
    {
      numberLabel: 'T3 · EP 1',
      episodeNumber: 1,
      seasonNumber: 3,
      title: 'Ep 1',
      url: 'anisync://episode/anime/thetvdb/1/s3/e1',
      date: '2023-04-09',
    },
  ];

  const matched = matchSiblingSeasonCandidates({
    primaryUrl: 'https://topanimes.net/animes/kimetsu-no-yaiba/',
    primaryTitle: 'Kimetsu no Yaiba',
    primaryAudioType: 'LEG',
    primarySeasonNumber: 1,
    referenceTitles: ['Kimetsu no Yaiba', 'Demon Slayer'],
    tvdbSeasons: [1, 2, 3],
    catalogEpisodes: catalogEps,
    alreadyCoveredSeasons: new Set([1]),
    searchCandidates: [
      {
        id: 'kny-2',
        title: 'Kimetsu no Yaiba: Yuukaku-hen',
        url: 'https://topanimes.net/animes/kimetsu-no-yaiba-yuukaku-hen/',
        poster: '',
        kind: 'anime',
        audioType: 'LEG',
        year: '2021',
      },
      {
        id: 'kny-3',
        title: 'Kimetsu no Yaiba: Katanakaji no Sato-hen',
        url: 'https://topanimes.net/animes/kimetsu-no-yaiba-katanakaji-no-sato-hen/',
        poster: '',
        kind: 'anime',
        audioType: 'LEG',
        year: '2023',
      },
      {
        id: 'kny-spinoff',
        title: 'Kimetsu no Yaiba: Vigilantes',
        url: 'https://topanimes.net/animes/kimetsu-no-yaiba-vigilantes/',
        poster: '',
        kind: 'anime',
        audioType: 'LEG',
        year: '2023',
      },
      {
        id: 'kny-movie',
        title: 'Kimetsu no Yaiba: Mugen Ressha-hen (Filme)',
        url: 'https://topanimes.net/filmes/kimetsu-mugen/',
        poster: '',
        kind: 'movie',
        audioType: 'LEG',
        year: '2020',
      },
    ],
  });

  assert.equal(matched.length, 2);
  assert.equal(matched[0].seasonNumber, 2);
  assert.equal(matched[0].url, 'https://topanimes.net/animes/kimetsu-no-yaiba-yuukaku-hen/');
  assert.equal(matched[1].seasonNumber, 3);
  assert.equal(matched[1].url, 'https://topanimes.net/animes/kimetsu-no-yaiba-katanakaji-no-sato-hen/');
});

test('enrichServerDetailsWithTheTvdb unifies split Season 1 and Season 2 provider pages onto one page from either entry', async () => {
  const topAnimesS1Html = `
    <html><body>
      <div class="data"><h1>Sousou no Frieren</h1></div>
      <div id="seasons">
        <div class="se-c">
          <div class="se-q"><span class="se-t">1</span></div>
          <ul class="episodios">
            <li>
              <div class="numerando">1 - 1</div>
              <div class="episodiotitle"><a href="https://topanimes.net/episodio/frieren-ep-1/">Episódio 1</a></div>
            </li>
            <li>
              <div class="numerando">1 - 2</div>
              <div class="episodiotitle"><a href="https://topanimes.net/episodio/frieren-ep-2/">Episódio 2</a></div>
            </li>
          </ul>
        </div>
      </div>
    </body></html>
  `;

  const topAnimesS2Html = `
    <html><body>
      <div class="data"><h1>Sousou no Frieren 2ª Temporada</h1></div>
      <div id="seasons">
        <div class="se-c">
          <div class="se-q"><span class="se-t">1</span></div>
          <ul class="episodios">
            <li>
              <div class="numerando">1 - 1</div>
              <div class="episodiotitle"><a href="https://topanimes.net/episodio/frieren-2-ep-1/">Episódio 1</a></div>
            </li>
          </ul>
        </div>
      </div>
    </body></html>
  `;

  const topAnimesSearchHtml = `
    <html><body>
      <div class="search-page">
        <div class="result-item">
          <div class="thumbnail"><a href="https://topanimes.net/animes/sousou-no-frieren/"><img src="https://example.com/s1.jpg" /><span class="tvshows">Anime</span></a></div>
          <div class="details"><div class="title"><a href="https://topanimes.net/animes/sousou-no-frieren/">Sousou no Frieren</a></div><div class="meta"><span class="year">2023</span></div></div>
        </div>
        <div class="result-item">
          <div class="thumbnail"><a href="https://topanimes.net/animes/sousou-no-frieren-2/"><img src="https://example.com/s2.jpg" /><span class="tvshows">Anime</span></a></div>
          <div class="details"><div class="title"><a href="https://topanimes.net/animes/sousou-no-frieren-2/">Sousou no Frieren 2ª Temporada</a></div><div class="meta"><span class="year">2026</span></div></div>
        </div>
      </div>
    </body></html>
  `;

  const tvdbAllSeasonsHtml = `
    <ul>
      <li class="list-group-item">
        <h4><span class="episode-label">S01E01</span><a href="/series/sousou-no-frieren/episodes/101">The Journey's End</a></h4>
        <div class="list-group-item-text"><img data-src="https://artworks.thetvdb.com/banners/ep101.jpg" /></div>
      </li>
      <li class="list-group-item">
        <h4><span class="episode-label">S01E02</span><a href="/series/sousou-no-frieren/episodes/102">It Didn't Have to Be Magic</a></h4>
        <div class="list-group-item-text"><img data-src="https://artworks.thetvdb.com/banners/ep102.jpg" /></div>
      </li>
      <li class="list-group-item">
        <h4><span class="episode-label">S02E01</span><a href="/series/sousou-no-frieren/episodes/201">New Horizon</a></h4>
        <div class="list-group-item-text"><img data-src="https://artworks.thetvdb.com/banners/ep201.jpg" /></div>
      </li>
      <li class="list-group-item">
        <h4><span class="episode-label">S02E02</span><a href="/series/sousou-no-frieren/episodes/202">Second Horizon</a></h4>
        <ul class="list-inline"><li>December 10, 2026</li></ul>
      </li>
    </ul>
  `;

  const tvdbSeriesHtml = `
    <html><body>
      <h1>葬送のフリーレン</h1>
      <img class="img-responsive" src="https://artworks.thetvdb.com/banners/v4/series/424536/posters/frieren.jpg" />
      <div class="change_translation_text" data-language="pt" data-title="Frieren e a Jornada para o Além">
        <p>Sinopse oficial do anime em português.</p>
      </div>
      <ul id="series_basic_info">
        <li><strong>TheTVDB.com Series ID</strong><span>424536</span></li>
        <li><strong>Genres</strong><span><a>Anime</a><a>Fantasy</a></span></li>
        <li><strong>Original Country</strong><span>Japan</span></li>
        <li><strong>Original Language</strong><span>Japanese</span></li>
      </ul>
    </body></html>
  `;

  const mockFetcher: HttpFetcher = async (url) => {
    if (url.includes('api4.thetvdb.com/web/search/queries')) {
      return {
        ok: true,
        status: 200,
        finalUrl: url,
        body: JSON.stringify({
          results: [
            {
              hits: [
                {
                  id: 424536,
                  type: 'series',
                  name: '葬送のフリーレン',
                  slug: 'sousou-no-frieren',
                  country: 'jpn',
                  primary_language: 'jpn',
                  year: '2023',
                  poster: 'https://artworks.thetvdb.com/banners/v4/series/424536/posters/frieren.jpg',
                  translations: { pt: 'Frieren e a Jornada para o Além', eng: 'Frieren' },
                  overviews: { pt: 'Sinopse oficial do anime em português.' },
                  genres: ['Anime', 'Fantasy'],
                },
              ],
            },
          ],
        }),
      };
    }
    if (url.includes('/series/sousou-no-frieren/allseasons/official')) {
      return { ok: true, status: 200, finalUrl: url, body: tvdbAllSeasonsHtml };
    }
    if (url.includes('/series/sousou-no-frieren')) {
      return {
        ok: true,
        status: 200,
        finalUrl: 'https://www.thetvdb.com/series/sousou-no-frieren',
        body: tvdbSeriesHtml,
      };
    }
    if (url.includes('topanimes.net/?s=')) {
      return { ok: true, status: 200, finalUrl: url, body: topAnimesSearchHtml };
    }
    if (url.includes('topanimes.net/animes/sousou-no-frieren-2')) {
      return { ok: true, status: 200, finalUrl: url, body: topAnimesS2Html };
    }
    if (url.includes('topanimes.net/animes/sousou-no-frieren')) {
      return { ok: true, status: 200, finalUrl: url, body: topAnimesS1Html };
    }
    return { ok: false, status: 404, finalUrl: url, body: '' };
  };

  // Opening Season 2 directly -> pulls Season 1 too, cleans title, unifies both seasons!
  const openedS2: AnimeDetails = {
    title: 'Sousou no Frieren 2ª Temporada',
    url: 'https://topanimes.net/animes/sousou-no-frieren-2/',
    kind: 'anime',
    poster: 'https://topanimes.net/s2.jpg',
    backdrop: '',
    synopsis: '',
    genres: [],
    audioType: 'LEG',
    episodes: [
      {
        numberLabel: '1 - 1',
        episodeNumber: 1,
        seasonNumber: 1,
        title: 'Episódio 1',
        url: 'https://topanimes.net/episodio/frieren-2-ep-1/',
      },
    ],
  };

  const unifiedFromS2 = await enrichServerDetailsWithTheTvdb(mockFetcher, openedS2);
  assert.equal(unifiedFromS2.title, 'Sousou no Frieren');
  assert.equal(unifiedFromS2.seasonsCount, '2');
  assert.equal(unifiedFromS2.episodes.length, 4);

  // Season 1 episodes pulled from sibling page are playable with TheTVDB thumbs!
  assert.equal(unifiedFromS2.episodes[0].seasonNumber, 1);
  assert.equal(unifiedFromS2.episodes[0].availableOnServer, true);
  assert.equal(unifiedFromS2.episodes[0].url, 'https://topanimes.net/episodio/frieren-ep-1/');
  assert.equal(unifiedFromS2.episodes[0].thumb, 'https://artworks.thetvdb.com/banners/ep101.jpg');

  assert.equal(unifiedFromS2.episodes[1].seasonNumber, 1);
  assert.equal(unifiedFromS2.episodes[1].availableOnServer, true);
  assert.equal(unifiedFromS2.episodes[1].url, 'https://topanimes.net/episodio/frieren-ep-2/');

  // Season 2 episode 1 is playable and normalized to T2 · EP 1, episode 2 is upcoming!
  assert.equal(unifiedFromS2.episodes[2].seasonNumber, 2);
  assert.equal(unifiedFromS2.episodes[2].availableOnServer, true);
  assert.equal(unifiedFromS2.episodes[2].url, 'https://topanimes.net/episodio/frieren-2-ep-1/');
  assert.equal(unifiedFromS2.episodes[2].numberLabel, 'T2 · EP 1');
  assert.equal(unifiedFromS2.episodes[2].thumb, 'https://artworks.thetvdb.com/banners/ep201.jpg');

  assert.equal(unifiedFromS2.episodes[3].seasonNumber, 2);
  assert.equal(unifiedFromS2.episodes[3].availableOnServer, false);
});

test('unifyServerSeasonsWithCatalog offsets restarting split-cour Part 2 episodes inside Season 1 when TheTVDB groups both cours together', async () => {
  const part2Html = `
    <html><body>
      <div class="data"><h1>Spy x Family Part 2</h1></div>
      <div id="seasons">
        <div class="se-c">
          <div class="se-q"><span class="se-t">1</span></div>
          <ul class="episodios">
            <li><div class="numerando">1 - 1</div><div class="episodiotitle"><a href="https://topanimes.net/episodio/spy-p2-ep-1/">Episódio 1</a></div></li>
            <li><div class="numerando">1 - 2</div><div class="episodiotitle"><a href="https://topanimes.net/episodio/spy-p2-ep-2/">Episódio 2</a></div></li>
          </ul>
        </div>
      </div>
    </body></html>
  `;

  const searchHtml = `
    <html><body>
      <div class="search-page">
        <div class="result-item">
          <div class="thumbnail"><a href="https://topanimes.net/animes/spy-x-family-part-2/"><span class="tvshows">Anime</span></a></div>
          <div class="details"><div class="title"><a href="https://topanimes.net/animes/spy-x-family-part-2/">Spy x Family Part 2</a></div></div>
        </div>
      </div>
    </body></html>
  `;

  const mockFetcher: HttpFetcher = async (url) => {
    if (url.includes('topanimes.net/?s=')) {
      return { ok: true, status: 200, finalUrl: url, body: searchHtml };
    }
    if (url.includes('spy-x-family-part-2')) {
      return { ok: true, status: 200, finalUrl: url, body: part2Html };
    }
    return { ok: false, status: 404, finalUrl: url, body: '' };
  };

  // TheTVDB Season 1 has 6 already-aired episodes, while Part 1 page only has 2 episodes
  const catalogEps: AnimeEpisodeLink[] = Array.from({ length: 6 }, (_, i) => ({
    numberLabel: `EP ${i + 1}`,
    episodeNumber: i + 1,
    seasonNumber: 1,
    title: `Episódio ${i + 1}`,
    url: `anisync://episode/anime/thetvdb/300/s1/e${i + 1}`,
    date: '2022-04-10',
  }));

  const part1Details: AnimeDetails = {
    title: 'Spy x Family',
    url: 'https://topanimes.net/animes/spy-x-family/',
    kind: 'anime',
    poster: '',
    backdrop: '',
    synopsis: '',
    genres: [],
    audioType: 'LEG',
    episodes: [
      {
        numberLabel: '1 - 1',
        episodeNumber: 1,
        seasonNumber: 1,
        title: 'Episódio 1',
        url: 'https://topanimes.net/episodio/spy-ep-1/',
      },
      {
        numberLabel: '1 - 2',
        episodeNumber: 2,
        seasonNumber: 1,
        title: 'Episódio 2',
        url: 'https://topanimes.net/episodio/spy-ep-2/',
      },
    ],
  };

  const result = await unifyServerSeasonsWithCatalog(mockFetcher, part1Details, catalogEps);
  assert.equal(result.addedSeasonPages, 1);
  assert.equal(result.serverEpisodes.length, 4);
  assert.deepEqual(
    result.serverEpisodes.map((e) => `${e.seasonNumber}:${e.episodeNumber}`),
    ['1:1', '1:2', '1:3', '1:4']
  );
});

test('unifyServerSeasonsWithCatalog skips provider search completely when single-season anime is already complete', async () => {
  let networkCalls = 0;
  const mockFetcher: HttpFetcher = async (url) => {
    networkCalls += 1;
    return { ok: false, status: 404, finalUrl: url, body: '' };
  };

  const completeDetails: AnimeDetails = {
    title: 'Cowboy Bebop',
    url: 'https://topanimes.net/animes/cowboy-bebop/',
    kind: 'anime',
    poster: '',
    backdrop: '',
    synopsis: '',
    genres: [],
    audioType: 'LEG',
    episodes: [
      {
        numberLabel: 'EP 1',
        episodeNumber: 1,
        seasonNumber: 1,
        title: 'Episódio 1',
        url: 'https://topanimes.net/episodio/cb-1/',
      },
      {
        numberLabel: 'EP 2',
        episodeNumber: 2,
        seasonNumber: 1,
        title: 'Episódio 2',
        url: 'https://topanimes.net/episodio/cb-2/',
      },
    ],
  };

  const catalogEps: AnimeEpisodeLink[] = [
    {
      numberLabel: 'EP 1',
      episodeNumber: 1,
      seasonNumber: 1,
      title: 'Asteroid Blues',
      url: 'anisync://episode/anime/thetvdb/10/s1/e1',
      date: '1998-04-03',
    },
    {
      numberLabel: 'EP 2',
      episodeNumber: 2,
      seasonNumber: 1,
      title: 'Stray Dog Strut',
      url: 'anisync://episode/anime/thetvdb/10/s1/e2',
      date: '1998-04-10',
    },
  ];

  const result = await unifyServerSeasonsWithCatalog(mockFetcher, completeDetails, catalogEps);
  assert.equal(networkCalls, 0);
  assert.equal(result.serverEpisodes.length, 2);
});
