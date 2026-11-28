import test from 'node:test';
import assert from 'node:assert/strict';
import type { HttpFetcher } from './httpTypes.ts';
import {
  buildUnifiedSeriesTitle,
  extractSafeParentPrefixForTvdb,
  extractSeasonAndPartInfo,
  matchSiblingSeasonCandidates,
  unifyServerSeasonsWithCatalog,
} from './catalog/seasonUnifier.ts';
import { stripSeasonFromTitle } from './catalog/idCodec.ts';
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
  assert.equal(unifiedFromS2.title, 'Frieren e a Jornada para o Além');
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

test('unifyServerSeasonsWithCatalog skips provider search when discoverAlternateAudio is disabled and avoids extra fetches when single-season anime has no alternate audio', async () => {
  const fetchedUrls: string[] = [];
  const mockFetcher: HttpFetcher = async (url) => {
    fetchedUrls.push(url);
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

  // With alternate audio discovery disabled: 0 network calls
  const resultNoAlt = await unifyServerSeasonsWithCatalog(mockFetcher, completeDetails, catalogEps, [], {
    discoverAlternateAudio: false,
  });
  assert.equal(fetchedUrls.length, 0);
  assert.equal(resultNoAlt.serverEpisodes.length, 2);
  assert.equal(resultNoAlt.alternateAudioTrack, undefined);

  // With default alternate audio discovery: performs only Page 1 search (no Page 2 / no anime page fetches)
  const resultDefault = await unifyServerSeasonsWithCatalog(mockFetcher, completeDetails, catalogEps);
  assert.equal(resultDefault.serverEpisodes.length, 2);
  assert.equal(resultDefault.alternateAudioTrack, undefined);
  assert.equal(
    fetchedUrls.some((u) => /\/page\/2|\/animes\//i.test(u)),
    false,
    'Should not paginate or fetch extra anime pages when no alternate audio exists'
  );
});

test('extractSeasonAndPartInfo, stripSeasonFromTitle, and extractSafeParentPrefixForTvdb handle numbered-before-colon arcs safely', () => {
  const kny3 = extractSeasonAndPartInfo('Kimetsu no Yaiba 3: Katanakaji no Sato-hen');
  assert.equal(kny3.baseTitle, 'Kimetsu no Yaiba');
  assert.equal(kny3.seasonNumber, 3);
  assert.equal(kny3.hasColonSubtitle, true);
  assert.equal(kny3.prefixBeforeSubtitle, 'Kimetsu no Yaiba');
  assert.equal(kny3.subtitle, 'Katanakaji no Sato-hen');
  assert.equal(kny3.normalizedSubtitle, 'katanakaji no sato hen');
  assert.equal(stripSeasonFromTitle('Kimetsu no Yaiba 3: Katanakaji no Sato-hen'), 'Kimetsu no Yaiba');

  const kny2 = extractSeasonAndPartInfo('Kimetsu no Yaiba 2: Yuukaku-hen');
  assert.equal(kny2.baseTitle, 'Kimetsu no Yaiba');
  assert.equal(kny2.seasonNumber, 2);
  assert.equal(kny2.subtitle, 'Yuukaku-hen');

  const mugenTv = extractSeasonAndPartInfo('Kimetsu no Yaiba: Mugen Ressha-hen (TV)');
  assert.equal(mugenTv.seasonNumber, null);
  assert.equal(mugenTv.hasColonSubtitle, true);
  assert.equal(mugenTv.prefixBeforeSubtitle, 'Kimetsu no Yaiba');
  assert.equal(mugenTv.subtitle, 'Mugen Ressha-hen');
  assert.equal(extractSafeParentPrefixForTvdb('Kimetsu no Yaiba: Mugen Ressha-hen (TV)'), 'Kimetsu no Yaiba');

  // Guard: franchise numbers before ": The Animation" must NOT be stripped as season numbers
  const persona5 = extractSeasonAndPartInfo('Persona 5: The Animation');
  assert.equal(persona5.seasonNumber, null);
  assert.equal(stripSeasonFromTitle('Persona 5: The Animation'), 'Persona 5: The Animation');

  // Guard: standalone sequels & spin-offs must NOT strip back to parent series
  assert.equal(extractSafeParentPrefixForTvdb('Naruto: Shippuden'), null);
  assert.equal(extractSafeParentPrefixForTvdb('My Hero Academia: Vigilantes'), null);
});

function buildTopAnimesAnimeHtml(params: {
  title: string;
  year: string;
  slug: string;
  count: number;
  epDate?: string;
}): string {
  const items = Array.from({ length: params.count }, (_, idx) => {
    const n = idx + 1;
    const dateSpan = params.epDate ? `<span class="date">${params.epDate}</span>` : '';
    return `
      <li>
        <div class="numerando">1 - ${n}</div>
        <div class="episodiotitle"><a href="https://topanimes.net/episodio/${params.slug}-ep-${n}/">Episódio ${n}</a>${dateSpan}</div>
      </li>
    `;
  }).join('');
  return `
    <html><body>
      <div class="sheader">
        <div class="data">
          <h1>${params.title}</h1>
          <div class="extra"><span class="date">${params.year}</span></div>
        </div>
      </div>
      <div id="seasons">
        <div class="se-c">
          <div class="se-q"><span class="se-t">1</span></div>
          <ul class="episodios">${items}</ul>
        </div>
      </div>
    </body></html>
  `;
}

function buildHinataSoulAnimeHtml(params: {
  title: string;
  year: string;
  videoBaseId: number;
  count: number;
}): string {
  const items = Array.from({ length: params.count }, (_, idx) => {
    const n = idx + 1;
    return `
      <div class="ultimosEpisodiosHomeItem">
        <a href="/videos/${params.videoBaseId + n}" title="${params.title} Episódio ${n}">
          <div class="ultimosEpisodiosHomeItemInfosNome">${params.title}</div>
          <div class="ultimosEpisodiosHomeItemInfosNum">Episódio ${String(n).padStart(2, '0')}</div>
        </a>
      </div>
    `;
  }).join('');
  return `
    <html><body>
      <div class="tituloPage"><h1>${params.title}</h1></div>
      <div class="aniInfosSingleNumsItem"><b>Ano:</b> ${params.year}</div>
      <div class="mainSingle"><div class="right"><div class="aniContainer">${items}</div></div></div>
    </body></html>
  `;
}

function buildKimetsuTvdbAllSeasonsHtml(): string {
  const seasonsSpec = [
    { s: 1, count: 26, date: 'April 6, 2019', prefix: 'S1' },
    { s: 2, count: 7, date: 'October 10, 2021', prefix: 'Mugen' },
    { s: 3, count: 11, date: 'December 5, 2021', prefix: 'Yuukaku' },
    { s: 4, count: 11, date: 'April 9, 2023', prefix: 'Katanakaji' },
    { s: 5, count: 8, date: 'May 12, 2024', prefix: 'Hashira' },
  ];
  const lis: string[] = [];
  for (const spec of seasonsSpec) {
    for (let e = 1; e <= spec.count; e += 1) {
      const sPad = String(spec.s).padStart(2, '0');
      const ePad = String(e).padStart(2, '0');
      const epId = spec.s * 1000 + e;
      const dateStr = spec.s === 3 && e >= 5 ? 'January 9, 2022' : spec.date;
      lis.push(`
        <li class="list-group-item">
          <h4><span class="episode-label">S${sPad}E${ePad}</span><a href="/series/demon-slayer-kimetsu-no-yaiba/episodes/${epId}">${spec.prefix} Episode ${e}</a></h4>
          <ul class="list-inline"><li>${dateStr}</li></ul>
          <div class="list-group-item-text"><img data-src="https://artworks.thetvdb.com/banners/kny-s${spec.s}e${e}.jpg" /></div>
        </li>
      `);
    }
  }
  return `<ul>${lis.join('')}</ul>`;
}

test('enrichServerDetailsWithTheTvdb unifies all 5 Kimetsu no Yaiba seasons across TopAnimes (with Page 2) + Hinata Soul from BOTH S1 and 3: Katanakaji no Sato-hen entry points', async () => {
  const topSearchPage1Html = `
    <html><body>
      <div class="search-page">
        <div class="result-item">
          <div class="thumbnail"><a href="https://topanimes.net/animes/kimetsu-no-yaiba/"><span class="tvshows">Anime</span></a></div>
          <div class="details"><div class="title"><a href="https://topanimes.net/animes/kimetsu-no-yaiba/">Kimetsu no Yaiba</a></div><div class="meta"><span class="year">2019</span></div></div>
        </div>
        <div class="result-item">
          <div class="thumbnail"><a href="https://topanimes.net/animes/kimetsu-no-yaiba-dublado/"><span class="tvshows">Anime</span></a></div>
          <div class="details"><div class="title"><a href="https://topanimes.net/animes/kimetsu-no-yaiba-dublado/">Kimetsu no Yaiba Dublado</a></div><div class="meta"><span class="year">2019</span></div></div>
        </div>
        <div class="result-item">
          <div class="thumbnail"><a href="https://topanimes.net/animes/kimetsu-no-yaiba-3-katanakaji-no-sato-hen/"><span class="tvshows">Anime</span></a></div>
          <div class="details"><div class="title"><a href="https://topanimes.net/animes/kimetsu-no-yaiba-3-katanakaji-no-sato-hen/">Kimetsu no Yaiba 3: Katanakaji no Sato-hen</a></div><div class="meta"><span class="year">2023</span></div></div>
        </div>
        <div class="result-item">
          <div class="thumbnail"><a href="https://topanimes.net/filmes/kimetsu-no-yaiba-mugen-ressha-hen/"><span class="movies">Filme</span></a></div>
          <div class="details"><div class="title"><a href="https://topanimes.net/filmes/kimetsu-no-yaiba-mugen-ressha-hen/">Kimetsu no Yaiba: Mugen Ressha-hen (Filme)</a></div><div class="meta"><span class="year">2020</span></div></div>
        </div>
      </div>
      <div class="pagination"><span>Página 1 de 2</span></div>
    </body></html>
  `;

  const topSearchPage2Html = `
    <html><body>
      <div class="search-page">
        <div class="result-item">
          <div class="thumbnail"><a href="https://topanimes.net/animes/kimetsu-no-yaiba-hashira-geiko-hen/"><span class="tvshows">Anime</span></a></div>
          <div class="details"><div class="title"><a href="https://topanimes.net/animes/kimetsu-no-yaiba-hashira-geiko-hen/">Kimetsu no Yaiba: Hashira Geiko-hen</a></div><div class="meta"><span class="year">2024</span></div></div>
        </div>
      </div>
      <div class="pagination"><span>Página 2 de 2</span></div>
    </body></html>
  `;

  // Hinata Soul search cards have NO year metadata, and duplicate Katanakaji no Sato-hen!
  const hsSearchHtml = `
    <html><body>
      <div class="ultimosAnimesHomeItem">
        <a href="https://www.hinatasoul.com/animes/kimetsu-no-yaiba">
          <div class="ultimosAnimesHomeItemInfosNome">Kimetsu no Yaiba</div>
        </a>
      </div>
      <div class="ultimosAnimesHomeItem">
        <a href="https://www.hinatasoul.com/animes/kimetsu-no-yaiba-mugen-ressha-hen">
          <div class="ultimosAnimesHomeItemInfosNome">Kimetsu no Yaiba: Mugen Ressha-hen</div>
        </a>
      </div>
      <div class="ultimosAnimesHomeItem">
        <a href="https://www.hinatasoul.com/animes/kimetsu-no-yaiba-2-yuukaku-hen">
          <div class="ultimosAnimesHomeItemInfosNome">Kimetsu no Yaiba 2: Yuukaku-hen</div>
        </a>
      </div>
      <div class="ultimosAnimesHomeItem">
        <a href="https://www.hinatasoul.com/animes/kimetsu-no-yaiba-3-katanakaji-no-sato-hen">
          <div class="ultimosAnimesHomeItemInfosNome">Kimetsu no Yaiba 3: Katanakaji no Sato-hen</div>
        </a>
      </div>
    </body></html>
  `;

  const tvdbSeriesHtml = `
    <html><body>
      <h1>鬼滅の刃</h1>
      <img class="img-responsive" src="https://artworks.thetvdb.com/banners/v4/series/348545/posters/kny.jpg" />
      <div class="change_translation_text" data-language="pt" data-title="Demon Slayer: Kimetsu no Yaiba">
        <p>Sinopse oficial de Kimetsu no Yaiba em português.</p>
      </div>
      <ul id="series_basic_info">
        <li><strong>TheTVDB.com Series ID</strong><span>348545</span></li>
        <li><strong>Genres</strong><span><a>Anime</a><a>Action</a></span></li>
        <li><strong>Original Country</strong><span>Japan</span></li>
        <li><strong>Original Language</strong><span>Japanese</span></li>
      </ul>
    </body></html>
  `;

  const tvdbAllSeasonsHtml = buildKimetsuTvdbAllSeasonsHtml();
  const topS1Html = buildTopAnimesAnimeHtml({
    title: 'Kimetsu no Yaiba',
    year: '2019',
    slug: 'kny-s1',
    count: 26,
    epDate: 'Apr. 06, 2019',
  });
  const topKatanakajiHtml = buildTopAnimesAnimeHtml({
    title: 'Kimetsu no Yaiba 3: Katanakaji no Sato-hen',
    year: '2023',
    slug: 'kny-katana',
    count: 11,
    epDate: 'Apr. 09, 2023',
  });
  const topHashiraHtml = buildTopAnimesAnimeHtml({
    title: 'Kimetsu no Yaiba: Hashira Geiko-hen',
    year: '2024',
    slug: 'kny-hashira',
    count: 8,
    epDate: 'May 12, 2024',
  });
  const hsMugenHtml = buildHinataSoulAnimeHtml({
    title: 'Kimetsu no Yaiba: Mugen Ressha-hen',
    year: '2021',
    videoBaseId: 20000,
    count: 7,
  });
  const hsYuukakuHtml = buildHinataSoulAnimeHtml({
    title: 'Kimetsu no Yaiba 2: Yuukaku-hen',
    year: '2021',
    videoBaseId: 30000,
    count: 11,
  });
  const hsKatanakajiHtml = buildHinataSoulAnimeHtml({
    title: 'Kimetsu no Yaiba 3: Katanakaji no Sato-hen',
    year: '2023',
    videoBaseId: 40000,
    count: 11,
  });

  const mockFetcher: HttpFetcher = async (url, init) => {
    if (url.includes('api4.thetvdb.com/web/search/queries')) {
      const bodyObj = JSON.parse(String(init?.body || '{}')) as {
        requests?: Array<{ params?: { query?: string } }>;
      };
      const q = (bodyObj.requests?.[0]?.params?.query || '').toLowerCase();
      // Simulate real Algolia behavior: exact "Kimetsu no Yaiba 3: Katanakaji no Sato-hen" returns 0 hits,
      // while stripped base title "Kimetsu no Yaiba" returns TVDB #348545!
      if (q === 'kimetsu no yaiba' || q.includes('demon slayer')) {
        return {
          ok: true,
          status: 200,
          finalUrl: url,
          body: JSON.stringify({
            results: [
              {
                hits: [
                  {
                    id: 348545,
                    type: 'series',
                    name: '鬼滅の刃',
                    slug: 'demon-slayer-kimetsu-no-yaiba',
                    country: 'jpn',
                    primary_language: 'jpn',
                    year: '2019',
                    poster: 'https://artworks.thetvdb.com/banners/v4/series/348545/posters/kny.jpg',
                    translations: {
                      pt: 'Demon Slayer: Kimetsu no Yaiba',
                      eng: 'Demon Slayer: Kimetsu no Yaiba',
                      jpn: '鬼滅の刃',
                    },
                    aliases: ['Kimetsu no Yaiba', 'Demon Slayer'],
                    overviews: { pt: 'Sinopse oficial de Kimetsu no Yaiba em português.' },
                    genres: ['Anime', 'Action'],
                  },
                ],
              },
            ],
          }),
        };
      }
      return { ok: true, status: 200, finalUrl: url, body: JSON.stringify({ results: [{ hits: [] }] }) };
    }
    if (url.includes('/series/demon-slayer-kimetsu-no-yaiba/allseasons/official')) {
      return { ok: true, status: 200, finalUrl: url, body: tvdbAllSeasonsHtml };
    }
    if (url.includes('/series/demon-slayer-kimetsu-no-yaiba')) {
      return {
        ok: true,
        status: 200,
        finalUrl: 'https://www.thetvdb.com/series/demon-slayer-kimetsu-no-yaiba',
        body: tvdbSeriesHtml,
      };
    }
    if (url.includes('topanimes.net/page/2/?s=')) {
      return { ok: true, status: 200, finalUrl: url, body: topSearchPage2Html };
    }
    if (url.includes('topanimes.net/?s=')) {
      return { ok: true, status: 200, finalUrl: url, body: topSearchPage1Html };
    }
    if (url.includes('hinatasoul.com/busca')) {
      return { ok: true, status: 200, finalUrl: url, body: hsSearchHtml };
    }
    if (url === 'https://topanimes.net/animes/kimetsu-no-yaiba/') {
      return { ok: true, status: 200, finalUrl: url, body: topS1Html };
    }
    if (url === 'https://topanimes.net/animes/kimetsu-no-yaiba-3-katanakaji-no-sato-hen/') {
      return { ok: true, status: 200, finalUrl: url, body: topKatanakajiHtml };
    }
    if (url === 'https://topanimes.net/animes/kimetsu-no-yaiba-hashira-geiko-hen/') {
      return { ok: true, status: 200, finalUrl: url, body: topHashiraHtml };
    }
    if (url === 'https://www.hinatasoul.com/animes/kimetsu-no-yaiba-mugen-ressha-hen') {
      return { ok: true, status: 200, finalUrl: url, body: hsMugenHtml };
    }
    if (url === 'https://www.hinatasoul.com/animes/kimetsu-no-yaiba-2-yuukaku-hen') {
      return { ok: true, status: 200, finalUrl: url, body: hsYuukakuHtml };
    }
    if (url === 'https://www.hinatasoul.com/animes/kimetsu-no-yaiba-3-katanakaji-no-sato-hen') {
      return { ok: true, status: 200, finalUrl: url, body: hsKatanakajiHtml };
    }
    return { ok: false, status: 404, finalUrl: url, body: '' };
  };

  const assertAllFiveSeasonsPlayable = (details: AnimeDetails) => {
    assert.equal(details.externalIds?.tvdbId, 348545);
    assert.equal(details.seasonsCount, '5');
    assert.equal(details.episodes.length, 63);
    assert.equal(
      details.episodes.every((ep) => ep.availableOnServer === true),
      true,
      'Every episode across all 5 seasons must be playable'
    );

    const bySeason = new Map<number, AnimeEpisodeLink[]>();
    for (const ep of details.episodes) {
      const s = ep.seasonNumber || 1;
      const arr = bySeason.get(s) || [];
      arr.push(ep);
      bySeason.set(s, arr);
    }

    assert.equal(bySeason.get(1)?.length, 26);
    assert.equal(bySeason.get(2)?.length, 7);
    assert.equal(bySeason.get(3)?.length, 11);
    assert.equal(bySeason.get(4)?.length, 11);
    assert.equal(bySeason.get(5)?.length, 8);

    // Exact season-to-provider alignment check (NO off-by-one shift!)
    assert.match(bySeason.get(1)![0].url, /kny-s1-ep-1/);
    assert.match(bySeason.get(2)![0].url, /hinatasoul\.com\/videos\/20001/);
    assert.match(bySeason.get(3)![0].url, /hinatasoul\.com\/videos\/30001/);
    assert.match(bySeason.get(4)![0].url, /kny-katana-ep-1/);
    assert.match(bySeason.get(5)![0].url, /kny-hashira-ep-1/);

    // Verify TheTVDB episode titles & thumbs aligned cleanly to each season
    assert.equal(bySeason.get(2)![0].title, 'Episódio 1 — Mugen Episode 1');
    assert.equal(bySeason.get(3)![0].title, 'Episódio 1 — Yuukaku Episode 1');
    assert.equal(bySeason.get(4)![0].title, 'Episódio 1 — Katanakaji Episode 1');
    assert.equal(bySeason.get(5)![0].title, 'Episódio 1 — Hashira Episode 1');
    assert.equal(bySeason.get(2)![0].thumb, 'https://artworks.thetvdb.com/banners/kny-s2e1.jpg');
    assert.equal(bySeason.get(3)![0].thumb, 'https://artworks.thetvdb.com/banners/kny-s3e1.jpg');
    assert.equal(bySeason.get(4)![0].thumb, 'https://artworks.thetvdb.com/banners/kny-s4e1.jpg');
    assert.equal(bySeason.get(5)![0].thumb, 'https://artworks.thetvdb.com/banners/kny-s5e1.jpg');
  };

  // Entry Point 1: Open main page "Kimetsu no Yaiba" (Season 1)
  const openedS1: AnimeDetails = {
    title: 'Kimetsu no Yaiba',
    url: 'https://topanimes.net/animes/kimetsu-no-yaiba/',
    kind: 'anime',
    year: '2019',
    poster: '',
    backdrop: '',
    synopsis: '',
    genres: [],
    audioType: 'LEG',
    episodes: Array.from({ length: 26 }, (_, idx) => ({
      numberLabel: `1 - ${idx + 1}`,
      episodeNumber: idx + 1,
      seasonNumber: 1,
      title: `Episódio ${idx + 1}`,
      url: `https://topanimes.net/episodio/kny-s1-ep-${idx + 1}/`,
      date: 'Apr. 06, 2019',
    })),
  };

  const unifiedFromS1 = await enrichServerDetailsWithTheTvdb(mockFetcher, openedS1);
  assert.equal(unifiedFromS1.title, 'Demon Slayer: Kimetsu no Yaiba');
  assertAllFiveSeasonsPlayable(unifiedFromS1);

  // Entry Point 2: Open "Kimetsu no Yaiba 3: Katanakaji no Sato-hen" directly!
  const openedKatanakaji: AnimeDetails = {
    title: 'Kimetsu no Yaiba 3: Katanakaji no Sato-hen',
    url: 'https://topanimes.net/animes/kimetsu-no-yaiba-3-katanakaji-no-sato-hen/',
    kind: 'anime',
    year: '2023',
    poster: '',
    backdrop: '',
    synopsis: '',
    genres: [],
    audioType: 'LEG',
    episodes: Array.from({ length: 11 }, (_, idx) => ({
      numberLabel: `1 - ${idx + 1}`,
      episodeNumber: idx + 1,
      seasonNumber: 1,
      title: `Episódio ${idx + 1}`,
      url: `https://topanimes.net/episodio/kny-katana-ep-${idx + 1}/`,
      date: 'Apr. 09, 2023',
    })),
  };

  const unifiedFromKatanakaji = await enrichServerDetailsWithTheTvdb(mockFetcher, openedKatanakaji);
  assert.equal(unifiedFromKatanakaji.title, 'Demon Slayer: Kimetsu no Yaiba');
  assertAllFiveSeasonsPlayable(unifiedFromKatanakaji);
});

test('unifyServerSeasonsWithCatalog skips a 1-episode unmarked movie under /animes/ and falls back to the real TV arc on the alternate provider', async () => {
  const topSearchHtml = `
    <html><body>
      <div class="search-page">
        <div class="result-item">
          <div class="thumbnail"><a href="https://topanimes.net/animes/kimetsu-no-yaiba-mugen-ressha-hen/"><span class="tvshows">Anime</span></a></div>
          <div class="details"><div class="title"><a href="https://topanimes.net/animes/kimetsu-no-yaiba-mugen-ressha-hen/">Kimetsu no Yaiba: Mugen Ressha-hen</a></div><div class="meta"><span class="year">2020</span></div></div>
        </div>
      </div>
    </body></html>
  `;
  const hsSearchHtml = `
    <html><body>
      <div class="ultimosAnimesHomeItem">
        <a href="https://www.hinatasoul.com/animes/kimetsu-no-yaiba-mugen-ressha-hen">
          <div class="ultimosAnimesHomeItemInfosNome">Kimetsu no Yaiba: Mugen Ressha-hen</div>
        </a>
      </div>
    </body></html>
  `;

  // TopAnimes has a 1-episode theatrical movie mistakenly filed under /animes/
  const topUnmarkedMovieHtml = buildTopAnimesAnimeHtml({
    title: 'Kimetsu no Yaiba: Mugen Ressha-hen',
    year: '2020',
    slug: 'kny-mugen-movie',
    count: 1,
  });
  // Hinata Soul has the real 7-episode TV arc
  const hsMugenTvHtml = buildHinataSoulAnimeHtml({
    title: 'Kimetsu no Yaiba: Mugen Ressha-hen',
    year: '2021',
    videoBaseId: 50000,
    count: 7,
  });

  const mockFetcher: HttpFetcher = async (url) => {
    if (url.includes('topanimes.net/?s=')) return { ok: true, status: 200, finalUrl: url, body: topSearchHtml };
    if (url.includes('hinatasoul.com/busca')) return { ok: true, status: 200, finalUrl: url, body: hsSearchHtml };
    if (url === 'https://topanimes.net/animes/kimetsu-no-yaiba-mugen-ressha-hen/') {
      return { ok: true, status: 200, finalUrl: url, body: topUnmarkedMovieHtml };
    }
    if (url === 'https://www.hinatasoul.com/animes/kimetsu-no-yaiba-mugen-ressha-hen') {
      return { ok: true, status: 200, finalUrl: url, body: hsMugenTvHtml };
    }
    return { ok: false, status: 404, finalUrl: url, body: '' };
  };

  const catalogEps: AnimeEpisodeLink[] = [
    ...Array.from({ length: 26 }, (_, i) => ({
      numberLabel: `EP ${i + 1}`,
      episodeNumber: i + 1,
      seasonNumber: 1,
      title: `S1 Ep ${i + 1}`,
      url: `anisync://episode/anime/thetvdb/348545/s1/e${i + 1}`,
      date: '2019-04-06',
    })),
    ...Array.from({ length: 7 }, (_, i) => ({
      numberLabel: `T2 · EP ${i + 1}`,
      episodeNumber: i + 1,
      seasonNumber: 2,
      title: `Mugen Ep ${i + 1}`,
      url: `anisync://episode/anime/thetvdb/348545/s2/e${i + 1}`,
      date: '2021-10-10',
    })),
  ];

  const openedS1: AnimeDetails = {
    title: 'Kimetsu no Yaiba',
    url: 'https://topanimes.net/animes/kimetsu-no-yaiba/',
    kind: 'anime',
    year: '2019',
    poster: '',
    backdrop: '',
    synopsis: '',
    genres: [],
    audioType: 'LEG',
    episodes: Array.from({ length: 26 }, (_, i) => ({
      numberLabel: `1 - ${i + 1}`,
      episodeNumber: i + 1,
      seasonNumber: 1,
      title: `Episódio ${i + 1}`,
      url: `https://topanimes.net/episodio/kny-s1-ep-${i + 1}/`,
    })),
  };

  const result = await unifyServerSeasonsWithCatalog(mockFetcher, openedS1, catalogEps);
  const s2Eps = result.serverEpisodes.filter((e) => e.seasonNumber === 2);
  assert.equal(s2Eps.length, 7);
  assert.match(s2Eps[0].url, /hinatasoul\.com\/videos\/50001/);
});

test('unifyServerSeasonsWithCatalog never duplicates Katanakaji no Sato-hen across providers even without TheTVDB or with different subtitle languages', async () => {
  const hsSearchHtml = `
    <html><body>
      <div class="ultimosAnimesHomeItem">
        <a href="https://www.hinatasoul.com/animes/kimetsu-no-yaiba-3-katanakaji-no-sato-hen">
          <div class="ultimosAnimesHomeItemInfosNome">Kimetsu no Yaiba 3: Katanakaji no Sato-hen</div>
        </a>
      </div>
      <div class="ultimosAnimesHomeItem">
        <a href="https://www.hinatasoul.com/animes/kimetsu-no-yaiba">
          <div class="ultimosAnimesHomeItemInfosNome">Kimetsu no Yaiba</div>
        </a>
      </div>
    </body></html>
  `;

  const hsS1Html = buildHinataSoulAnimeHtml({
    title: 'Kimetsu no Yaiba',
    year: '2019',
    videoBaseId: 10000,
    count: 26,
  });
  const hsKatanaHtml = buildHinataSoulAnimeHtml({
    title: 'Kimetsu no Yaiba 3: Katanakaji no Sato-hen',
    year: '2023',
    videoBaseId: 40000,
    count: 11,
  });

  const mockFetcher: HttpFetcher = async (url) => {
    if (url.includes('hinatasoul.com/busca')) return { ok: true, status: 200, finalUrl: url, body: hsSearchHtml };
    if (url === 'https://www.hinatasoul.com/animes/kimetsu-no-yaiba') {
      return { ok: true, status: 200, finalUrl: url, body: hsS1Html };
    }
    if (url === 'https://www.hinatasoul.com/animes/kimetsu-no-yaiba-3-katanakaji-no-sato-hen') {
      return { ok: true, status: 200, finalUrl: url, body: hsKatanaHtml };
    }
    return { ok: false, status: 404, finalUrl: url, body: '' };
  };

  // Case A: Without TheTVDB (catalogEpisodes = []), opening TopAnimes "Kimetsu no Yaiba 3: Katanakaji no Sato-hen"
  // puts primary in Season 3, skips Hinata Soul's duplicate Katanakaji, and adds Season 1 (26 eps)
  const openedKatanaNoTvdb: AnimeDetails = {
    title: 'Kimetsu no Yaiba 3: Katanakaji no Sato-hen',
    url: 'https://topanimes.net/animes/kimetsu-no-yaiba-3-katanakaji-no-sato-hen/',
    kind: 'anime',
    year: '2023',
    poster: '',
    backdrop: '',
    synopsis: '',
    genres: [],
    audioType: 'LEG',
    episodes: Array.from({ length: 11 }, (_, idx) => ({
      numberLabel: `1 - ${idx + 1}`,
      episodeNumber: idx + 1,
      seasonNumber: 1,
      title: `Episódio ${idx + 1}`,
      url: `https://topanimes.net/episodio/kny-katana-ep-${idx + 1}/`,
    })),
  };

  const noTvdbRes = await unifyServerSeasonsWithCatalog(mockFetcher, openedKatanaNoTvdb, []);
  assert.equal(noTvdbRes.primarySeasonNumber, 3);
  assert.equal(noTvdbRes.unifiedTitle, 'Kimetsu no Yaiba');
  assert.equal(noTvdbRes.serverEpisodes.filter((e) => e.seasonNumber === 1).length, 26);
  assert.equal(noTvdbRes.serverEpisodes.filter((e) => e.seasonNumber === 3).length, 11);
  assert.equal(noTvdbRes.serverEpisodes.length, 37);

  // Case B: Different-language duplicate ("Kimetsu no Yaiba: Vila dos Ferreiros" 2023 vs Hinata Soul "3: Katanakaji no Sato-hen" 2023)
  // with TheTVDB S3 (2021-2022, 11 eps) and S4 (2023, 11 eps): duplicate must NOT hijack S3!
  const tvdbCatalog: AnimeEpisodeLink[] = [
    ...Array.from({ length: 26 }, (_, i) => ({
      numberLabel: `EP ${i + 1}`,
      episodeNumber: i + 1,
      seasonNumber: 1,
      title: `S1 Ep ${i + 1}`,
      url: `anisync://episode/anime/thetvdb/348545/s1/e${i + 1}`,
      date: '2019-04-06',
    })),
    ...Array.from({ length: 11 }, (_, i) => ({
      numberLabel: `T3 · EP ${i + 1}`,
      episodeNumber: i + 1,
      seasonNumber: 3,
      title: `Yuukaku Ep ${i + 1}`,
      url: `anisync://episode/anime/thetvdb/348545/s3/e${i + 1}`,
      date: i < 5 ? '2021-12-05' : '2022-01-16',
    })),
    ...Array.from({ length: 11 }, (_, i) => ({
      numberLabel: `T4 · EP ${i + 1}`,
      episodeNumber: i + 1,
      seasonNumber: 4,
      title: `Katanakaji Ep ${i + 1}`,
      url: `anisync://episode/anime/thetvdb/348545/s4/e${i + 1}`,
      date: '2023-04-09',
    })),
  ];

  const openedPtArc: AnimeDetails = {
    ...openedKatanaNoTvdb,
    title: 'Kimetsu no Yaiba: Vila dos Ferreiros',
    url: 'https://topanimes.net/animes/kimetsu-no-yaiba-vila-dos-ferreiros/',
  };

  const diffLangRes = await unifyServerSeasonsWithCatalog(mockFetcher, openedPtArc, tvdbCatalog);
  assert.equal(diffLangRes.primarySeasonNumber, 4);
  assert.equal(diffLangRes.serverEpisodes.filter((e) => e.seasonNumber === 1).length, 26);
  assert.equal(diffLangRes.serverEpisodes.filter((e) => e.seasonNumber === 3).length, 0);
  assert.equal(diffLangRes.serverEpisodes.filter((e) => e.seasonNumber === 4).length, 11);
});

test('matchSiblingSeasonCandidates matches colon-free arc titles while still rejecting spin-offs', () => {
  const matched = matchSiblingSeasonCandidates({
    primaryUrl: 'https://topanimes.net/animes/kimetsu-no-yaiba/',
    primaryTitle: 'Kimetsu no Yaiba',
    primaryAudioType: 'LEG',
    primarySeasonNumber: 1,
    referenceTitles: ['Demon Slayer: Kimetsu no Yaiba', 'Kimetsu no Yaiba'],
    tvdbSeasons: [1, 2, 3, 4, 5],
    alreadyCoveredSeasons: new Set([1]),
    searchCandidates: [
      {
        id: 'mugen-nocolon',
        title: 'Kimetsu no Yaiba Mugen Ressha-hen',
        url: 'https://www.hinatasoul.com/animes/kimetsu-no-yaiba-mugen-ressha-hen',
        poster: '',
        kind: 'anime',
        audioType: 'LEG',
      },
      {
        id: 'yuukaku-nocolon',
        title: 'Kimetsu no Yaiba 2 Yuukaku-hen',
        url: 'https://www.hinatasoul.com/animes/kimetsu-no-yaiba-2-yuukaku-hen',
        poster: '',
        kind: 'anime',
        audioType: 'LEG',
      },
      {
        id: 'spinoff-nocolon',
        title: 'Kimetsu no Yaiba Vigilantes',
        url: 'https://topanimes.net/animes/kimetsu-no-yaiba-vigilantes/',
        poster: '',
        kind: 'anime',
        audioType: 'LEG',
      },
    ],
  });

  assert.equal(matched.length, 2);
  assert.equal(
    matched.some((m) => m.normalizedSubtitle === 'mugen ressha hen'),
    true
  );
  assert.equal(
    matched.some((m) => m.normalizedSubtitle === 'yuukaku hen' && m.explicitSeasonNumber === 2),
    true
  );
  assert.equal(
    matched.some((m) => /vigilantes/i.test(m.title)),
    false
  );
});

test('matchSiblingSeasonCandidates never mixes LEG episodes into an incomplete DUB season and strictly honors requiredAudioType', () => {
  const candidates: SearchResultItem[] = [
    {
      id: 'top-dub',
      title: 'Tsuihou sareta Tensei Juukishi wa Game Chishiki de Musou suru Dublado',
      url: 'https://topanimes.net/animes/tsuihou-sareta-tensei-juukishi-dublado/',
      poster: '',
      kind: 'anime',
      audioType: 'DUB',
    },
    {
      id: 'hs-leg',
      title: 'Tsuihou sareta Tensei Juukishi wa Game Chishiki de Musou suru',
      url: 'https://www.hinatasoul.com/animes/tsuihou-sareta-tensei-juukishi',
      poster: '',
      kind: 'anime',
      audioType: 'LEG',
    },
    {
      id: 'top-leg',
      title: 'Tsuihou sareta Tensei Juukishi wa Game Chishiki de Musou suru',
      url: 'https://topanimes.net/animes/tsuihou-sareta-tensei-juukishi/',
      poster: '',
      kind: 'anime',
      audioType: 'LEG',
    },
    {
      id: 'hs-dub',
      title: 'Tsuihou sareta Tensei Juukishi wa Game Chishiki de Musou suru Dublado',
      url: 'https://www.hinatasoul.com/animes/tsuihou-sareta-tensei-juukishi-dublado',
      poster: '',
      kind: 'anime',
      audioType: 'DUB',
    },
  ];

  // Even without requiredAudioType, same-season cross-provider fill on an incomplete DUB page MUST skip LEG!
  const sameSeasonFillOnlyDub = matchSiblingSeasonCandidates({
    primaryUrl: 'https://topanimes.net/animes/tsuihou-sareta-tensei-juukishi-dublado/',
    primaryTitle: 'Tsuihou sareta Tensei Juukishi wa Game Chishiki de Musou suru Dublado',
    primaryAudioType: 'DUB',
    primarySeasonNumber: 1,
    referenceTitles: ['Tsuihou sareta Tensei Juukishi wa Game Chishiki de Musou suru'],
    tvdbSeasons: [1],
    alreadyCoveredSeasons: new Set([1]),
    needMoreEpisodesInPrimarySeason: true,
    searchCandidates: candidates,
  });
  assert.equal(sameSeasonFillOnlyDub.length, 1);
  assert.equal(sameSeasonFillOnlyDub[0].audioType, 'DUB');
  assert.equal(
    sameSeasonFillOnlyDub[0].url,
    'https://www.hinatasoul.com/animes/tsuihou-sareta-tensei-juukishi-dublado'
  );

  // When only LEG exists on the other provider, incomplete DUB page receives ZERO mixed candidates
  const noCrossAudioLeak = matchSiblingSeasonCandidates({
    primaryUrl: 'https://topanimes.net/animes/tsuihou-sareta-tensei-juukishi-dublado/',
    primaryTitle: 'Tsuihou sareta Tensei Juukishi wa Game Chishiki de Musou suru Dublado',
    primaryAudioType: 'DUB',
    requiredAudioType: 'DUB',
    primarySeasonNumber: 1,
    referenceTitles: ['Tsuihou sareta Tensei Juukishi wa Game Chishiki de Musou suru'],
    tvdbSeasons: [1],
    alreadyCoveredSeasons: new Set([1]),
    needMoreEpisodesInPrimarySeason: true,
    searchCandidates: candidates.filter((c) => c.id !== 'hs-dub'),
  });
  assert.equal(noCrossAudioLeak.length, 0);

  // Alternate LEG discovery with requiredAudioType: 'LEG' finds LEG cleanly (with cross-provider fallback)
  const altLegMatch = matchSiblingSeasonCandidates({
    primaryUrl: 'https://topanimes.net/animes/tsuihou-sareta-tensei-juukishi-dublado/',
    primaryTitle: 'Tsuihou sareta Tensei Juukishi wa Game Chishiki de Musou suru Dublado',
    primaryAudioType: 'LEG',
    requiredAudioType: 'LEG',
    primarySeasonNumber: 1,
    referenceTitles: ['Tsuihou sareta Tensei Juukishi wa Game Chishiki de Musou suru'],
    tvdbSeasons: [1],
    alreadyCoveredSeasons: new Set(),
    needMoreEpisodesInPrimarySeason: true,
    primaryHasPlayableEpisodes: false,
    searchCandidates: candidates,
  });
  assert.equal(altLegMatch.length, 1);
  assert.equal(altLegMatch[0].audioType, 'LEG');
  assert.equal(altLegMatch[0].url, 'https://topanimes.net/animes/tsuihou-sareta-tensei-juukishi/');
  assert.equal(
    altLegMatch[0].fallbackCandidates?.[0]?.url,
    'https://www.hinatasoul.com/animes/tsuihou-sareta-tensei-juukishi'
  );
});

test('enrichServerDetailsWithTheTvdb keeps partial DUB (5 eps) and LEG (21 eps) strictly separated in dual audioTracks from either entry point', async () => {
  const topSearchHtml = `
    <html><body>
      <div class="search-page">
        <div class="result-item">
          <div class="thumbnail"><a href="https://topanimes.net/animes/tsuihou-juukishi-dublado/"><span class="tvshows">Anime</span></a></div>
          <div class="details"><div class="title"><a href="https://topanimes.net/animes/tsuihou-juukishi-dublado/">Tsuihou sareta Tensei Juukishi Dublado</a></div><div class="meta"><span class="year">2026</span></div></div>
        </div>
      </div>
    </body></html>
  `;

  const hsSearchHtml = `
    <html><body>
      <div class="ultimosAnimesHomeItem">
        <a href="https://www.hinatasoul.com/animes/tsuihou-juukishi">
          <div class="ultimosAnimesHomeItemInfosNome">Tsuihou sareta Tensei Juukishi</div>
        </a>
      </div>
    </body></html>
  `;

  const topDubHtml = buildTopAnimesAnimeHtml({
    title: 'Tsuihou sareta Tensei Juukishi Dublado',
    year: '2026',
    slug: 'tsuihou-juukishi-dublado',
    count: 5,
    epDate: 'Jul. 10, 2026',
  });

  const hsLegHtml = buildHinataSoulAnimeHtml({
    title: 'Tsuihou sareta Tensei Juukishi',
    year: '2026',
    videoBaseId: 80000,
    count: 21,
  });

  const tvdbSeriesHtml = `
    <html><body>
      <h1>Tsuihou sareta Tensei Juukishi</h1>
      <img class="img-responsive" src="https://artworks.thetvdb.com/banners/juukishi-poster.jpg" />
      <div class="change_translation_text" data-language="pt" data-title="Tsuihou sareta Tensei Juukishi">
        <p>Sinopse oficial em português.</p>
      </div>
      <ul id="series_basic_info">
        <li><strong>TheTVDB.com Series ID</strong><span>551234</span></li>
        <li><strong>Genres</strong><span><a>Anime</a><a>Fantasy</a></span></li>
      </ul>
    </body></html>
  `;

  const tvdbEpisodeRows = Array.from({ length: 26 }, (_, idx) => {
    const epNum = idx + 1;
    const isFuture = epNum > 21;
    const airDate = isFuture ? `December ${epNum - 10}, 2028` : `July ${Math.min(epNum, 28)}, 2026`;
    return `
      <li class="list-group-item">
        <h4><span class="episode-label">S01E${String(epNum).padStart(2, '0')}</span><a href="/series/tsuihou-juukishi/episodes/${5000 + epNum}">Episode ${epNum}</a></h4>
        <ul class="list-inline"><li>${airDate}</li></ul>
      </li>
    `;
  }).join('');

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
                  id: 551234,
                  name: 'Tsuihou sareta Tensei Juukishi',
                  slug: 'tsuihou-juukishi',
                  type: 'series',
                  country: 'jpn',
                  primary_language: 'jpn',
                  year: '2026',
                  genres: ['Anime', 'Fantasy'],
                  poster: 'https://artworks.thetvdb.com/banners/juukishi-poster.jpg',
                },
              ],
            },
          ],
        }),
      };
    }
    if (url.includes('thetvdb.com/series/tsuihou-juukishi/allseasons/official')) {
      return { ok: true, status: 200, finalUrl: url, body: `<ul>${tvdbEpisodeRows}</ul>` };
    }
    if (url.includes('thetvdb.com/series/tsuihou-juukishi')) {
      return { ok: true, status: 200, finalUrl: url, body: tvdbSeriesHtml };
    }
    if (url.includes('topanimes.net/?s=')) {
      return { ok: true, status: 200, finalUrl: url, body: topSearchHtml };
    }
    if (url.includes('hinatasoul.com/busca')) {
      return { ok: true, status: 200, finalUrl: url, body: hsSearchHtml };
    }
    if (url.includes('topanimes.net/animes/tsuihou-juukishi-dublado')) {
      return { ok: true, status: 200, finalUrl: url, body: topDubHtml };
    }
    if (url.includes('hinatasoul.com/animes/tsuihou-juukishi')) {
      return { ok: true, status: 200, finalUrl: url, body: hsLegHtml };
    }
    return { ok: false, status: 404, finalUrl: url, body: '' };
  };

  // Entry Point 1: Opening the Dublado page (5 DUB eps)
  const openedDub: AnimeDetails = {
    title: 'Tsuihou sareta Tensei Juukishi Dublado',
    url: 'https://topanimes.net/animes/tsuihou-juukishi-dublado/',
    kind: 'anime',
    year: '2026',
    poster: '',
    backdrop: '',
    synopsis: '',
    genres: [],
    audioType: 'DUB',
    episodes: Array.from({ length: 5 }, (_, idx) => ({
      numberLabel: `1 - ${idx + 1}`,
      episodeNumber: idx + 1,
      seasonNumber: 1,
      title: `Episódio ${idx + 1}`,
      url: `https://topanimes.net/episodio/tsuihou-juukishi-dublado-ep-${idx + 1}/`,
      date: 'Jul. 10, 2026',
    })),
  };

  const enrichedFromDub = await enrichServerDetailsWithTheTvdb(mockFetcher, openedDub);
  assert.equal(enrichedFromDub.episodes.length, 26);
  const dubPlayable = enrichedFromDub.episodes.filter((e) => e.availableOnServer !== false);
  assert.equal(dubPlayable.length, 5, 'Primary DUB track must NEVER mix in LEG episodes 6..21');
  assert.equal(
    dubPlayable.every((e) => e.url.includes('dublado') && e.audioType === 'DUB'),
    true
  );

  // Dual audioTracks must contain BOTH DUB (5 playable) and LEG (21 playable)
  assert.ok(enrichedFromDub.audioTracks?.DUB);
  assert.ok(enrichedFromDub.audioTracks?.LEG);
  assert.equal(enrichedFromDub.audioTracks.DUB.playableCount, 5);
  assert.equal(enrichedFromDub.audioTracks.LEG.playableCount, 21);
  assert.equal(enrichedFromDub.audioTracks.LEG.episodes.length, 26);
  const legPlayableFromDub = enrichedFromDub.audioTracks.LEG.episodes.filter(
    (e) => e.availableOnServer !== false
  );
  assert.equal(legPlayableFromDub.length, 21);
  assert.equal(
    legPlayableFromDub.every((e) => e.url.includes('hinatasoul.com/videos/') && e.audioType === 'LEG'),
    true
  );
  assert.equal(enrichedFromDub.audioTracks.LEG.episodes[21].availableOnServer, false);

  // Entry Point 2: Opening the Legendado page directly (21 LEG eps) also discovers Dublado (5 eps)
  const openedLeg: AnimeDetails = {
    title: 'Tsuihou sareta Tensei Juukishi',
    url: 'https://www.hinatasoul.com/animes/tsuihou-juukishi',
    kind: 'anime',
    year: '2026',
    poster: '',
    backdrop: '',
    synopsis: '',
    genres: [],
    audioType: 'LEG',
    episodes: Array.from({ length: 21 }, (_, idx) => ({
      numberLabel: `EP ${idx + 1}`,
      episodeNumber: idx + 1,
      seasonNumber: 1,
      title: `Episódio ${idx + 1}`,
      url: `https://www.hinatasoul.com/videos/${80001 + idx}`,
    })),
  };

  const enrichedFromLeg = await enrichServerDetailsWithTheTvdb(mockFetcher, openedLeg);
  assert.equal(
    enrichedFromLeg.episodes.filter((e) => e.availableOnServer !== false).length,
    21
  );
  assert.equal(enrichedFromLeg.audioTracks?.LEG?.playableCount, 21);
  assert.equal(enrichedFromLeg.audioTracks?.DUB?.playableCount, 5);
});

test('unifyServerSeasonsWithCatalog keeps multi-season DUB (S1+S2) and LEG (S1+S2+S3) tracks cleanly separated', async () => {
  const topSearchHtml = `
    <html><body>
      <div class="search-page">
        <div class="result-item">
          <div class="thumbnail"><a href="https://topanimes.net/animes/jujutsu-kaisen-dublado/"><span class="tvshows">Anime</span></a></div>
          <div class="details"><div class="title"><a href="https://topanimes.net/animes/jujutsu-kaisen-dublado/">Jujutsu Kaisen Dublado</a></div><div class="meta"><span class="year">2020</span></div></div>
        </div>
        <div class="result-item">
          <div class="thumbnail"><a href="https://topanimes.net/animes/jujutsu-kaisen-2-dublado/"><span class="tvshows">Anime</span></a></div>
          <div class="details"><div class="title"><a href="https://topanimes.net/animes/jujutsu-kaisen-2-dublado/">Jujutsu Kaisen 2nd Season Dublado</a></div><div class="meta"><span class="year">2023</span></div></div>
        </div>
        <div class="result-item">
          <div class="thumbnail"><a href="https://topanimes.net/animes/jujutsu-kaisen/"><span class="tvshows">Anime</span></a></div>
          <div class="details"><div class="title"><a href="https://topanimes.net/animes/jujutsu-kaisen/">Jujutsu Kaisen</a></div><div class="meta"><span class="year">2020</span></div></div>
        </div>
        <div class="result-item">
          <div class="thumbnail"><a href="https://topanimes.net/animes/jujutsu-kaisen-2/"><span class="tvshows">Anime</span></a></div>
          <div class="details"><div class="title"><a href="https://topanimes.net/animes/jujutsu-kaisen-2/">Jujutsu Kaisen 2nd Season</a></div><div class="meta"><span class="year">2023</span></div></div>
        </div>
        <div class="result-item">
          <div class="thumbnail"><a href="https://topanimes.net/animes/jujutsu-kaisen-3/"><span class="tvshows">Anime</span></a></div>
          <div class="details"><div class="title"><a href="https://topanimes.net/animes/jujutsu-kaisen-3/">Jujutsu Kaisen 3rd Season</a></div><div class="meta"><span class="year">2026</span></div></div>
        </div>
      </div>
    </body></html>
  `;

  const mockFetcher: HttpFetcher = async (url) => {
    if (url.includes('topanimes.net/?s=')) {
      return { ok: true, status: 200, finalUrl: url, body: topSearchHtml };
    }
    if (url.includes('animes/jujutsu-kaisen-2-dublado')) {
      return {
        ok: true,
        status: 200,
        finalUrl: url,
        body: buildTopAnimesAnimeHtml({
          title: 'Jujutsu Kaisen 2nd Season Dublado',
          year: '2023',
          slug: 'jjk-s2-dub',
          count: 3,
          epDate: 'Jul. 06, 2023',
        }),
      };
    }
    if (url.includes('animes/jujutsu-kaisen/')) {
      return {
        ok: true,
        status: 200,
        finalUrl: url,
        body: buildTopAnimesAnimeHtml({
          title: 'Jujutsu Kaisen',
          year: '2020',
          slug: 'jjk-s1-leg',
          count: 3,
          epDate: 'Oct. 03, 2020',
        }),
      };
    }
    if (url.includes('animes/jujutsu-kaisen-2/')) {
      return {
        ok: true,
        status: 200,
        finalUrl: url,
        body: buildTopAnimesAnimeHtml({
          title: 'Jujutsu Kaisen 2nd Season',
          year: '2023',
          slug: 'jjk-s2-leg',
          count: 3,
          epDate: 'Jul. 06, 2023',
        }),
      };
    }
    if (url.includes('animes/jujutsu-kaisen-3/')) {
      return {
        ok: true,
        status: 200,
        finalUrl: url,
        body: buildTopAnimesAnimeHtml({
          title: 'Jujutsu Kaisen 3rd Season',
          year: '2026',
          slug: 'jjk-s3-leg',
          count: 2,
          epDate: 'Jan. 10, 2026',
        }),
      };
    }
    return { ok: false, status: 404, finalUrl: url, body: '' };
  };

  const catalogEps: AnimeEpisodeLink[] = [
    ...[1, 2, 3].map((n) => ({
      numberLabel: `EP ${n}`,
      episodeNumber: n,
      seasonNumber: 1,
      title: `S1 Ep ${n}`,
      url: `anisync://episode/anime/thetvdb/377543/s1/e${n}`,
      date: '2020-10-03',
    })),
    ...[1, 2, 3].map((n) => ({
      numberLabel: `T2 · EP ${n}`,
      episodeNumber: n,
      seasonNumber: 2,
      title: `S2 Ep ${n}`,
      url: `anisync://episode/anime/thetvdb/377543/s2/e${n}`,
      date: '2023-07-06',
    })),
    ...[1, 2].map((n) => ({
      numberLabel: `T3 · EP ${n}`,
      episodeNumber: n,
      seasonNumber: 3,
      title: `S3 Ep ${n}`,
      url: `anisync://episode/anime/thetvdb/377543/s3/e${n}`,
      date: '2026-01-10',
    })),
  ];

  const openedDubS1: AnimeDetails = {
    title: 'Jujutsu Kaisen Dublado',
    url: 'https://topanimes.net/animes/jujutsu-kaisen-dublado/',
    kind: 'anime',
    year: '2020',
    poster: '',
    backdrop: '',
    synopsis: '',
    genres: [],
    audioType: 'DUB',
    episodes: [1, 2, 3].map((n) => ({
      numberLabel: `1 - ${n}`,
      episodeNumber: n,
      seasonNumber: 1,
      title: `Episódio ${n}`,
      url: `https://topanimes.net/episodio/jjk-s1-dub-ep-${n}/`,
      date: 'Oct. 03, 2020',
    })),
  };

  const unified = await unifyServerSeasonsWithCatalog(mockFetcher, openedDubS1, catalogEps, [
    'Jujutsu Kaisen',
  ]);

  // Primary DUB track has ONLY S1 + S2 DUB (6 eps) — NEVER leaks S3 LEG into DUB!
  assert.equal(unified.primaryAudioType, 'DUB');
  assert.equal(unified.serverEpisodes.length, 6);
  assert.deepEqual(
    Array.from(new Set(unified.serverEpisodes.map((e) => e.seasonNumber))).sort(),
    [1, 2]
  );
  assert.equal(
    unified.serverEpisodes.every((e) => e.url.includes('-dub-') && e.audioType === 'DUB'),
    true
  );

  // Alternate LEG track has ALL 3 seasons LEG (8 eps)
  assert.ok(unified.alternateAudioTrack);
  assert.equal(unified.alternateAudioTrack.audioType, 'LEG');
  assert.equal(unified.alternateAudioTrack.serverEpisodes.length, 8);
  assert.deepEqual(
    Array.from(
      new Set(unified.alternateAudioTrack.serverEpisodes.map((e) => e.seasonNumber))
    ).sort(),
    [1, 2, 3]
  );
  assert.equal(
    unified.alternateAudioTrack.serverEpisodes.every(
      (e) => e.url.includes('-leg-') && e.audioType === 'LEG'
    ),
    true
  );
});


