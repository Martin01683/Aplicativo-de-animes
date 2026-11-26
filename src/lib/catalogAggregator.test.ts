import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEpisodeUri,
  buildExternalDatabaseLinks,
  buildLiveChartScheduleUri,
  buildMediaUri,
  inferMediaKindFromTarget,
  normalizeTitleForMatch,
  parentSeriesUriFromEpisode,
  parseAnisyncUri,
  parseLiveChartExternalId,
  scoreTitleSimilarity,
  stripSeasonFromTitle,
} from './catalog/idCodec';
import {
  getAggregatedMediaDetails,
  getAggregatedWeeklyCalendar,
} from './catalog/catalogAggregator';
import {
  parseLiveChartReleaseLabel,
  parseLiveChartScheduleHtml,
} from './catalog/providers/livechartProvider';
import {
  enrichServerDetailsWithTheTvdb,
  parseTvdbAllSeasonsHtml,
  parseTvdbPublicHtml,
  searchTheTvdb,
} from './catalog/providers/thetvdbProvider';
import type { HttpFetcher } from './httpTypes';

test('idCodec round-trips TheTVDB, LiveChart, server, episode, and direct anisync:// URIs cleanly', () => {
  const animeUri = buildMediaUri('anime', 'thetvdb', 424536);
  assert.equal(animeUri, 'anisync://anime/thetvdb/424536');
  assert.deepEqual(parseAnisyncUri(animeUri), {
    kind: 'media',
    mediaType: 'anime',
    source: 'thetvdb',
    externalId: '424536',
  });
  assert.equal(inferMediaKindFromTarget(animeUri), 'anime');

  const lcUri = buildLiveChartScheduleUri(13232, 'Black Clover 2nd Season', 'Black Clover Second Season');
  const parsedLc = parseAnisyncUri(lcUri);
  assert.equal(parsedLc.kind, 'media');
  if (parsedLc.kind === 'media') {
    assert.equal(parsedLc.source, 'livechart');
    const lcMeta = parseLiveChartExternalId(parsedLc.externalId);
    assert.equal(lcMeta.livechartId, 13232);
    assert.equal(lcMeta.title, 'Black Clover 2nd Season');
    assert.equal(lcMeta.englishTitle, 'Black Clover Second Season');
  }

  const epUri = buildEpisodeUri('series', 'thetvdb', 81189, 2, 5);
  assert.equal(epUri, 'anisync://episode/series/thetvdb/81189/s2/e5');
  assert.deepEqual(parseAnisyncUri(epUri), {
    kind: 'episode',
    mediaType: 'series',
    source: 'thetvdb',
    externalId: '81189',
    seasonNumber: 2,
    episodeNumber: 5,
  });
  assert.equal(inferMediaKindFromTarget(epUri), 'episode');
  assert.equal(parentSeriesUriFromEpisode(epUri), 'anisync://series/thetvdb/81189');

  const links = buildExternalDatabaseLinks(
    { tvdbId: 424536, tvdbSlug: 'sousou-no-frieren', livechartId: 11417 },
    { mediaType: 'anime' }
  );
  assert.deepEqual(
    links.map((l) => l.source),
    ['thetvdb', 'livechart']
  );
  assert.equal(links[0].url, 'https://www.thetvdb.com/series/sousou-no-frieren');
  assert.equal(links[1].url, 'https://www.livechart.me/anime/11417');

  assert.equal(normalizeTitleForMatch('Sousou no Frieren (Dublado) HD'), 'sousou no frieren');
  assert.equal(stripSeasonFromTitle('Black Clover 2nd Season'), 'Black Clover');
  assert.ok(scoreTitleSimilarity('Sousou no Frieren', 'Sousou no Frieren Legendado') > 0.9);
  assert.ok(scoreTitleSimilarity('One Piece', 'Attack on Titan') < 0.2);
});

test('LiveChart provider parses release labels (Dub, Sub, Crunchyroll, Netflix, Prime Video, Disney+, YT, TV JP)', () => {
  const cr = parseLiveChartReleaseLabel('EP8 · Sub - Crunchyroll');
  assert.equal(cr.episodeLabel, 'EP 8');
  assert.equal(cr.hasSub, true);
  assert.equal(cr.hasDub, false);
  assert.equal(cr.serviceName, 'Crunchyroll');
  assert.equal(cr.audioType, 'LEG');

  const nf = parseLiveChartReleaseLabel('EP8 · Dub, Sub - Netflix');
  assert.equal(nf.episodeLabel, 'EP 8');
  assert.equal(nf.hasDub, true);
  assert.equal(nf.hasSub, true);
  assert.equal(nf.serviceName, 'Netflix');
  assert.equal(nf.audioType, 'DUB');

  const pv = parseLiveChartReleaseLabel('EP8 · Dub, Sub - Prime Video');
  assert.equal(pv.serviceName, 'Prime Video');
  assert.equal(pv.hasDub, true);
  assert.equal(pv.hasSub, true);

  const dp = parseLiveChartReleaseLabel('EP7 · Streaming (INTL): Sub - Disney+');
  assert.equal(dp.serviceName, 'Disney+');
  assert.equal(dp.hasSub, true);

  const yt = parseLiveChartReleaseLabel('EP13 · Streaming (JP) - YT');
  assert.equal(yt.serviceName, 'YouTube');
  assert.equal(yt.isJapaneseBroadcast, true);

  const tvJp = parseLiveChartReleaseLabel('EP1362 · TV (JP)');
  assert.equal(tvJp.episodeLabel, 'EP 1362');
  assert.equal(tvJp.serviceName, 'TV (JP)');
  assert.equal(tvJp.isJapaneseBroadcast, true);
});

test('LiveChart provider parses Compact Grid schedule HTML with timestamps, ratings, services, and local day grouping', async () => {
  const sampleHtml = `
    <main>
      <div data-controller="schedule-day">
        <div class="lc-schedule-heading" id="Saturday">
          <time datetime="2026-11-21">sábado</time>
        </div>
        <article class="lc-compact-anime-card"
          data-anime-item-id="13232"
          data-anime-item-romanized-native-title="Black Clover 2nd Season"
          data-anime-item-english-title="Black Clover Second Season"
          data-anime-item-total-episodes="24">
          <img class="lc-compact-anime-card__poster"
            src="https://u.livechart.me/anime/13232/poster_image/abc.webp/small.jpg"
            srcset="https://u.livechart.me/anime/13232/poster_image/abc.webp/small.jpg 1x, https://u.livechart.me/anime/13232/poster_image/abc.webp/large.jpg 2x" />
          <a href="https://www.crunchyroll.com/series/GRE50KV36" target="_blank">Watch</a>
          <div class="lc-compact-anime-card__release-state">
            <div><strong>EP8</strong> · Sub - Crunchyroll</div>
            <time data-timestamp="1795273200">0d 00h 00m 00s</time>
          </div>
          <ul><li>TV</li><li>2026</li><li>8.33</li></ul>
        </article>
        <article class="lc-compact-anime-card"
          data-anime-item-id="13571"
          data-anime-item-romanized-native-title="Ranma1/2 3rd Season">
          <img class="lc-compact-anime-card__poster"
            src="https://u.livechart.me/anime/13571/poster_image/ranma.webp/small.jpg" />
          <a href="https://www.netflix.com/title/81171925" target="_blank">Watch</a>
          <div class="lc-compact-anime-card__release-state">
            <div><strong>EP8</strong> · Dub, Sub - Netflix</div>
            <time data-timestamp="1795280400">0d 00h 00m 00s</time>
          </div>
          <ul><li>TV</li><li>2026</li><li>7.82</li></ul>
        </article>
      </div>
    </main>`;

  const parsed = parseLiveChartScheduleHtml(sampleHtml, {
    mode: 'streams',
    tzOffsetMinutes: -180,
    nowMs: Date.parse('2026-11-21T15:00:00Z'),
  });

  assert.equal(parsed.sourceMode, 'live');
  assert.equal(parsed.scheduleMode, 'streams');
  assert.equal(parsed.days.length, 1);
  assert.equal(parsed.days[0].id, 'hoje');
  assert.equal(parsed.days[0].isToday, true);
  assert.equal(parsed.days[0].items.length, 2);

  const first = parsed.days[0].items[0];
  assert.equal(first.title, 'Black Clover 2nd Season');
  assert.equal(first.episodeLabel, 'EP 8');
  assert.equal(first.rating, '8.33');
  assert.equal(first.poster, 'https://u.livechart.me/anime/13232/poster_image/abc.webp/large.jpg');
  assert.equal(first.scheduleMeta?.serviceName, 'Crunchyroll');
  assert.equal(first.scheduleMeta?.hasSub, true);
  assert.equal(first.scheduleMeta?.hasDub, false);
  assert.equal(first.scheduleMeta?.totalEpisodes, 24);

  const second = parsed.days[0].items[1];
  assert.equal(second.title, 'Ranma1/2 3rd Season');
  assert.equal(second.scheduleMeta?.serviceName, 'Netflix');
  assert.equal(second.scheduleMeta?.hasDub, true);
  assert.equal(second.scheduleMeta?.hasSub, true);
  assert.equal(second.audioType, 'DUB');

  // Verify livechartProvider passes the streams cookie when fetching via getAggregatedWeeklyCalendar
  let capturedCookie = '';
  const calendarRes = await getAggregatedWeeklyCalendar(
    async (url, opts) => {
      assert.ok(url.includes('livechart.me/schedule'));
      capturedCookie = opts?.headers?.Cookie || '';
      return { status: 200, ok: true, finalUrl: url, body: sampleHtml };
    },
    { mode: 'dub', tzOffsetMinutes: -180 }
  );
  assert.ok(capturedCookie.includes('ps%3Dabm'));
  assert.equal(calendarRes.days[0].items.length, 2);
});

test('TheTVDB provider searches publicly without API key, parses PT-BR series/movie HTML and seasons, and enriches server details', async () => {
  const tvdbSeriesHtml = `
    <html><body>
      <h1>葬送のフリーレン</h1>
      <img class="img-responsive" src="https://artworks.thetvdb.com/banners/v4/series/424536/posters/68d6d5b36aa2f.jpg" />
      <div class="change_translation_text" data-language="eng" data-title="Frieren: Beyond Journey's End">
        <p>Decades after her party defeated the Demon King.</p>
      </div>
      <div class="change_translation_text" data-language="pt" data-title="Frieren e a Jornada para o Além">
        <p>Após uma missão de 10 anos ao lado do herói Himmel, a maga elfa Frieren inicia uma nova jornada.</p>
        <div class="block">Aliases <span>Frieren</span></div>
      </div>
      <ul id="series_basic_info">
        <li><strong>TheTVDB.com Series ID</strong><span>424536</span></li>
        <li><strong>Status</strong><span>Continuing</span></li>
        <li><strong>First Aired</strong><span>September 29, 2023</span></li>
        <li><strong>Studio</strong><span><a>Madhouse</a></span></li>
        <li><strong>Network</strong><span><a>Nippon TV</a></span></li>
        <li><strong>Average Runtime</strong><span>25 minutes</span></li>
        <li><strong>Genres</strong><span><a>Adventure</a><a>Animation</a><a>Anime</a><a>Fantasy</a></span></li>
        <li><strong>Original Country</strong><span>Japan</span></li>
        <li><strong>Original Language</strong><span>Japanese</span></li>
      </ul>
      <a href="https://www.thetvdb.com/series/sousou-no-frieren/seasons/official/1">Season 1</a>
      <a href="https://www.thetvdb.com/series/sousou-no-frieren/seasons/official/2">Season 2</a>
    </body></html>`;

  const parsedSeries = parseTvdbPublicHtml(
    tvdbSeriesHtml,
    424536,
    'anime',
    'https://www.thetvdb.com/series/sousou-no-frieren'
  );
  assert.ok(parsedSeries);
  assert.equal(parsedSeries.title, 'Frieren e a Jornada para o Além');
  assert.equal(parsedSeries.originalTitle, '葬送のフリーレン');
  assert.equal(parsedSeries.alternativeTitle, "Frieren: Beyond Journey's End");
  assert.equal(parsedSeries.status, 'Em exibição');
  assert.equal(parsedSeries.studio, 'Madhouse');
  assert.equal(parsedSeries.network, 'Nippon TV');
  assert.equal(parsedSeries.averageDuration, '25 min');
  assert.equal(parsedSeries.seasonsCount, '2');
  assert.equal(parsedSeries.year, '2023');
  assert.ok(parsedSeries.genres.includes('Aventura'));
  assert.ok(parsedSeries.genres.includes('Fantasia'));
  assert.ok(!parsedSeries.synopsis.includes('Aliases'));
  assert.equal(parsedSeries.externalLinks?.[0]?.url, 'https://www.thetvdb.com/series/sousou-no-frieren');

  const allSeasonsHtml = `
    <ul>
      <li class="list-group-item">
        <h4><span class="episode-label">S01E01</span><a href="/series/sousou-no-frieren/episodes/1">The Journey's End</a></h4>
        <ul class="list-inline"><li>September 29, 2023</li><li>Nippon TV</li></ul>
        <div class="list-group-item-text"><p>Primeiro episódio.</p><img data-src="https://artworks.thetvdb.com/banners/ep1.jpg" /></div>
      </li>
      <li class="list-group-item">
        <h4><span class="episode-label">S00E01</span><a href="/series/sousou-no-frieren/episodes/0">Special</a></h4>
      </li>
    </ul>`;
  const eps = parseTvdbAllSeasonsHtml(allSeasonsHtml, 424536, 'anime');
  assert.equal(eps.length, 1);
  assert.equal(eps[0].episodeNumber, 1);
  assert.equal(eps[0].seasonNumber, 1);
  assert.equal(eps[0].thumb, 'https://artworks.thetvdb.com/banners/ep1.jpg');
  assert.equal(eps[0].url, 'anisync://episode/anime/thetvdb/424536/s1/e1');

  // Keyless web search + enrichment of a server page
  const mockFetcher: HttpFetcher = async (url, opts) => {
    if (url.includes('api4.thetvdb.com/web/search/queries')) {
      assert.equal(opts?.method, 'POST');
      return {
        status: 200,
        ok: true,
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
                  follower_count: 246143,
                  poster: 'https://artworks.thetvdb.com/banners/v4/series/424536/posters/68d6d5b36aa2f.jpg',
                  translations: {
                    pt: 'Frieren e a Jornada para o Além',
                    eng: "Frieren: Beyond Journey's End",
                  },
                  overviews: {
                    pt: 'Após derrotar o Rei Demônio, Frieren parte em nova jornada.',
                  },
                  genres: ['Adventure', 'Fantasy'],
                },
              ],
            },
          ],
        }),
      };
    }
    if (url.includes('thetvdb.com/series/sousou-no-frieren/allseasons/official')) {
      return { status: 200, ok: true, finalUrl: url, body: allSeasonsHtml };
    }
    if (url.includes('thetvdb.com/series/sousou-no-frieren') || url.includes('dereferrer/series/424536')) {
      return {
        status: 200,
        ok: true,
        finalUrl: 'https://www.thetvdb.com/series/sousou-no-frieren',
        body: tvdbSeriesHtml,
      };
    }
    return { status: 404, ok: false, finalUrl: url, body: '' };
  };

  const searchResults = await searchTheTvdb(mockFetcher, 'Frieren');
  assert.equal(searchResults.length, 1);
  assert.equal(searchResults[0].title, 'Frieren e a Jornada para o Além');
  assert.equal(searchResults[0].url, 'anisync://anime/thetvdb/424536');

  const serverStub = {
    title: 'Sousou no Frieren Dublado',
    url: 'https://topanimes.net/animes/sousou-no-frieren-dublado/',
    kind: 'anime' as const,
    poster: 'https://image.tmdb.org/p.jpg',
    backdrop: 'https://image.tmdb.org/b.jpg',
    synopsis: '',
    genres: [],
    audioType: 'DUB' as const,
    episodes: [
      {
        numberLabel: '1 - 1',
        episodeNumber: 1,
        seasonNumber: 1,
        title: 'Episódio 1',
        url: 'https://topanimes.net/episodio/sousou-no-frieren-dublado-episodio-1/',
      },
    ],
  };

  const enriched = await enrichServerDetailsWithTheTvdb(mockFetcher, serverStub);
  assert.equal(enriched.studio, 'Madhouse');
  assert.equal(enriched.network, 'Nippon TV');
  assert.equal(enriched.status, 'Em exibição');
  assert.equal(enriched.externalIds?.tvdbId, 424536);
  // Prioritizes TheTVDB official anime artwork & PT-BR synopsis metadata over streaming server poster
  assert.equal(
    enriched.poster,
    'https://artworks.thetvdb.com/banners/v4/series/424536/posters/68d6d5b36aa2f.jpg'
  );
  assert.equal(enriched.synopsisSource, 'thetvdb-pt-br');
  assert.equal(enriched.synopsisLanguage, 'pt-BR');
  // Preserves playable server episodes untouched while upgrading to TheTVDB episode thumbnail!
  assert.equal(enriched.episodes.length, 1);
  assert.equal(
    enriched.episodes[0].url,
    'https://topanimes.net/episodio/sousou-no-frieren-dublado-episodio-1/'
  );
  assert.equal(enriched.episodes[0].thumb, 'https://artworks.thetvdb.com/banners/ep1.jpg');

  // Direct anisync://anime/thetvdb/424536 lookup returns full TheTVDB metadata + episodes
  const directTvdb = await getAggregatedMediaDetails(mockFetcher, 'anisync://anime/thetvdb/424536');
  assert.ok(directTvdb);
  assert.equal(directTvdb.title, 'Frieren e a Jornada para o Além');
  assert.equal(directTvdb.episodes.length, 1);
  assert.equal(directTvdb.episodes[0].url, 'anisync://episode/anime/thetvdb/424536/s1/e1');
});

test('enrichServerDetailsWithTheTvdb translates English-only TheTVDB synopsis via Google Translate and prioritizes TheTVDB images', async () => {
  const tvdbEnglishHtml = `
    <html><body>
      <h1>Starlight Blade</h1>
      <img class="img-responsive" src="/banners/v4/series/909090/posters/starlight.jpg" />
      <div style="background-image:url('https://artworks.thetvdb.com/banners/v4/series/909090/backgrounds/starlight-bg.jpg')"></div>
      <div class="change_translation_text" data-language="eng" data-title="Starlight Blade">
        <p>Two siblings defend their floating city from ancient sky machines.</p>
      </div>
      <ul id="series_basic_info">
        <li><strong>TheTVDB.com Series ID</strong><span>909090</span></li>
        <li><strong>Genres</strong><span><a>Anime</a><a>Action</a></span></li>
        <li><strong>Original Country</strong><span>Japan</span></li>
        <li><strong>Original Language</strong><span>Japanese</span></li>
      </ul>
    </body></html>`;

  const allSeasonsHtml = `
    <ul>
      <li class="list-group-item">
        <img src="/images/v2/placeholder.png" />
        <h4><span class="episode-label">S01E01</span><a href="/series/starlight-blade/episodes/5001">Skyfall</a></h4>
        <div class="list-group-item-text">
          <img data-src="/banners/v4/episode/5001/screencap/ep1.jpg" />
          <p>First episode summary.</p>
        </div>
      </li>
    </ul>`;

  const mockFetcher: HttpFetcher = async (url) => {
    if (url.includes('api4.thetvdb.com/web/search/queries')) {
      return {
        status: 200,
        ok: true,
        finalUrl: url,
        body: JSON.stringify({
          results: [
            {
              hits: [
                {
                  id: 909090,
                  type: 'series',
                  name: 'Starlight Blade',
                  slug: 'starlight-blade',
                  country: 'jpn',
                  primary_language: 'jpn',
                  year: '2026',
                  poster: '/banners/v4/series/909090/posters/starlight.jpg',
                  translations: { eng: 'Starlight Blade' },
                  overviews: { eng: 'Two siblings defend their floating city from ancient sky machines.' },
                  genres: ['Anime', 'Action'],
                },
              ],
            },
          ],
        }),
      };
    }
    if (url.includes('/allseasons/official')) {
      return { status: 200, ok: true, finalUrl: url, body: allSeasonsHtml };
    }
    if (url.includes('/series/starlight-blade')) {
      return {
        status: 200,
        ok: true,
        finalUrl: 'https://www.thetvdb.com/series/starlight-blade',
        body: tvdbEnglishHtml,
      };
    }
    if (url.includes('translate.googleapis.com')) {
      return {
        status: 200,
        ok: true,
        finalUrl: url,
        body: JSON.stringify([
          [
            [
              'Dois irmãos defendem sua cidade flutuante de antigas máquinas celestes.',
              'Two siblings defend their floating city from ancient sky machines.',
            ],
          ],
          null,
          'en',
        ]),
      };
    }
    return { status: 404, ok: false, finalUrl: url, body: '' };
  };

  const enriched = await enrichServerDetailsWithTheTvdb(mockFetcher, {
    title: 'Starlight Blade',
    url: 'https://topanimes.net/animes/starlight-blade/',
    kind: 'anime',
    poster: 'https://topanimes.net/wp-content/uploads/server-poster.jpg',
    backdrop: 'https://topanimes.net/wp-content/uploads/server-bg.jpg',
    synopsis: 'Sinopse antiga do servidor.',
    genres: [],
    audioType: 'LEG',
    episodes: [
      {
        numberLabel: '1 - 1',
        episodeNumber: 1,
        seasonNumber: 1,
        title: 'Episódio 1',
        url: 'https://topanimes.net/episodio/starlight-blade-ep-1/',
        thumb: 'https://topanimes.net/wp-content/uploads/server-ep1.jpg',
      },
    ],
  });

  assert.equal(
    enriched.synopsis,
    'Dois irmãos defendem sua cidade flutuante de antigas máquinas celestes.'
  );
  assert.equal(enriched.synopsisSource, 'thetvdb-google-translate');
  assert.equal(enriched.synopsisLanguage, 'pt-BR');
  assert.equal(
    enriched.poster,
    'https://artworks.thetvdb.com/banners/v4/series/909090/posters/starlight.jpg'
  );
  assert.equal(
    enriched.backdrop,
    'https://artworks.thetvdb.com/banners/v4/series/909090/backgrounds/starlight-bg.jpg'
  );
  assert.equal(
    enriched.episodes[0].thumb,
    'https://artworks.thetvdb.com/banners/v4/episode/5001/screencap/ep1.jpg'
  );
  assert.equal(
    enriched.fallbackPoster,
    'https://topanimes.net/wp-content/uploads/server-poster.jpg'
  );
  assert.equal(
    enriched.fallbackBackdrop,
    'https://topanimes.net/wp-content/uploads/server-bg.jpg'
  );
  assert.equal(
    enriched.episodes[0].fallbackThumb,
    'https://topanimes.net/wp-content/uploads/server-ep1.jpg'
  );
});

test('getAggregatedMediaDetails recovers TheTVDB URI via JSON search when /dereferrer fails and resolves legacy anisync:// favorites', async () => {
  const nintamaHtml = `
    <html><body>
      <h1 id="series_title">Nintama Rantarou</h1>
      <img class="img-responsive" src="https://artworks.thetvdb.com/banners/v4/series/286895/posters/672caa37ec50e.jpg" />
      <div class="change_translation_text" data-language="eng" data-title="Nintama Rantarou">
        <p>When Rantaro and his crew start in the hard art of the ninja.</p>
      </div>
      <ul id="series_basic_info">
        <li><strong>TheTVDB.com Series ID</strong><span>286895</span></li>
        <li><strong>Genres</strong><span><a>Anime</a><a>Comedy</a></span></li>
        <li><strong>Original Country</strong><span>Japan</span></li>
        <li><strong>Original Language</strong><span>Japanese</span></li>
      </ul>
    </body></html>`;

  const nintamaAllSeasonsHtml = `
    <ul>
      <li class="list-group-item">
        <h4><span class="episode-label">S01E01</span><a href="/series/nintama-rantarou/episodes/5040100">Enter the Ninja Academy</a></h4>
        <div class="list-group-item-text"><p>Rantaro arrives at school.</p></div>
      </li>
    </ul>`;

  const mockFetcher: HttpFetcher = async (url) => {
    // Simulate /dereferrer/series/286895 failing with 503
    if (url.includes('/dereferrer/series/286895')) {
      return { status: 503, ok: false, finalUrl: url, body: '' };
    }
    if (url.includes('api4.thetvdb.com/web/search/queries')) {
      return {
        status: 200,
        ok: true,
        finalUrl: url,
        body: JSON.stringify({
          results: [
            {
              hits: [
                {
                  id: 286895,
                  type: 'series',
                  name: 'Nintama Rantarou',
                  slug: 'nintama-rantarou',
                  country: 'jpn',
                  primary_language: 'jpn',
                  year: '1993',
                  poster: '/banners/v4/series/286895/posters/672caa37ec50e.jpg',
                  translations: { eng: 'Nintama Rantarou', jpn: '忍たま乱太郎' },
                  overviews: { eng: 'When Rantaro and his crew start in the hard art of the ninja.' },
                  genres: ['Anime', 'Comedy'],
                },
              ],
            },
          ],
        }),
      };
    }
    if (url.includes('/series/nintama-rantarou/allseasons/official')) {
      return { status: 200, ok: true, finalUrl: url, body: nintamaAllSeasonsHtml };
    }
    if (url.includes('/series/nintama-rantarou')) {
      return {
        status: 200,
        ok: true,
        finalUrl: 'https://www.thetvdb.com/series/nintama-rantarou',
        body: nintamaHtml,
      };
    }
    return { status: 404, ok: false, finalUrl: url, body: '' };
  };

  // 1. Direct TheTVDB URI recovers via search API + slug page when dereferrer fails
  const recovered = await getAggregatedMediaDetails(
    mockFetcher,
    'anisync://anime/thetvdb/286895',
    undefined,
    { hintTitle: 'Nintama Rantarou', skipEpisodePageHydration: true }
  );
  assert.ok(recovered);
  assert.equal(recovered.title, 'Nintama Rantarou');
  assert.equal(recovered.externalIds?.tvdbId, 286895);
  assert.equal(recovered.episodes.length, 1);

  // 2. Legacy favorite URI (e.g. anilist) resolves via TheTVDB using hintTitle
  const legacyFav = await getAggregatedMediaDetails(
    mockFetcher,
    'anisync://anime/anilist/9317',
    undefined,
    { hintTitle: 'Nintama Rantarou', skipEpisodePageHydration: true }
  );
  assert.ok(legacyFav);
  assert.equal(legacyFav.title, 'Nintama Rantarou');
  assert.equal(legacyFav.externalIds?.tvdbId, 286895);
  assert.equal(legacyFav.episodes.length, 1);
});

test('getAggregatedMediaDetails falls back to streaming provider when TheTVDB is unreachable', async () => {
  const providerSearchHtml = `
    <div class="search-page">
      <div class="result-item">
        <article>
          <div class="thumbnail"><a href="https://topanimes.net/animes/nintama-rantarou/"><img src="https://topanimes.net/nintama.jpg" /></a></div>
          <div class="details"><div class="title"><a href="https://topanimes.net/animes/nintama-rantarou/">Nintama Rantarou</a></div></div>
        </article>
      </div>
    </div>`;

  const providerAnimeHtml = `
    <html><body>
      <div class="sheader">
        <div class="poster"><img src="https://topanimes.net/nintama.jpg" /></div>
        <div class="data"><h1>Nintama Rantarou</h1><div class="extra"><span class="date">1993</span></div></div>
      </div>
      <div class="wp-content"><p>Sinopse do provedor para Nintama Rantarou.</p></div>
      <div id="seasons">
        <div class="se-c">
          <div class="se-q"><span class="se-t">1</span></div>
          <div class="se-a">
            <ul class="episodios">
              <li>
                <div class="numerando">1 - 1</div>
                <div class="episodiotitle"><a href="https://topanimes.net/episodio/nintama-rantarou-episodio-1/">Episódio 1</a></div>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </body></html>`;

  const mockFetcher: HttpFetcher = async (url) => {
    if (url.includes('thetvdb.com')) {
      return { status: 503, ok: false, finalUrl: url, body: '' };
    }
    if (url.includes('topanimes.net/?s=')) {
      return { status: 200, ok: true, finalUrl: url, body: providerSearchHtml };
    }
    if (url.includes('topanimes.net/animes/nintama-rantarou')) {
      return {
        status: 200,
        ok: true,
        finalUrl: 'https://topanimes.net/animes/nintama-rantarou/',
        body: providerAnimeHtml,
      };
    }
    return { status: 404, ok: false, finalUrl: url, body: '' };
  };

  const fallbackResult = await getAggregatedMediaDetails(
    mockFetcher,
    'anisync://anime/thetvdb/286895',
    undefined,
    { hintTitle: 'Nintama Rantarou', skipEpisodePageHydration: true }
  );
  assert.ok(fallbackResult);
  assert.equal(fallbackResult.title, 'Nintama Rantarou');
  assert.equal(fallbackResult.poster, 'https://topanimes.net/nintama.jpg');
  assert.equal(fallbackResult.episodes.length, 1);
  assert.equal(
    fallbackResult.episodes[0].url,
    'https://topanimes.net/episodio/nintama-rantarou-episodio-1/'
  );
});

