import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildAnimeInfoMetaItems,
  formatSeasonDisplayHeading,
} from './animeInfoMeta.ts';
import { getAggregatedSearch } from './catalog/catalogAggregator.ts';
import {
  extractQueryYear,
  levenshteinDistance,
  parseDirectTvdbIdQuery,
  scoreTitleSimilarity,
} from './catalog/idCodec.ts';
import {
  fetchTheTvdbDetails,
  parseTvdbAllSeasonsHtml,
  parseTvdbPublicHtml,
  searchTheTvdb,
} from './catalog/providers/thetvdbProvider.ts';
import {
  applyXemMappingsToEpisodes,
  clearXemCaches,
  fetchXemSceneMappingsForTvdbId,
  parseXemAllNamesPayload,
  parseXemMappingsPayload,
} from './catalog/providers/xemProvider.ts';
import {
  adjustBatchReleaseAirDates,
  adjustMultiEpisodeAirTimes,
  computeAdaptiveMediaCacheTtlMs,
  formatEpisodeFinaleBadge,
  inferSeriesFinaleType,
  isEpisodeFanartPlaceholderUrl,
  mergeServerAndCatalogEpisodes,
} from './episodeAvailability.ts';
import type { HttpFetcher } from './httpTypes.ts';
import type { AnimeEpisodeLink } from './types.ts';

describe('TheTVDB and TheXEM metadata enhancements', () => {
  it('extracts embedded years, direct tvdb: IDs, and matches typos/articles via Levenshtein', () => {
    assert.deepEqual(extractQueryYear('Hunter x Hunter 2011'), {
      cleanQuery: 'Hunter x Hunter',
      year: '2011',
    });
    assert.deepEqual(extractQueryYear('Fruits Basket (2019)'), {
      cleanQuery: 'Fruits Basket',
      year: '2019',
    });
    assert.deepEqual(extractQueryYear('1984'), { cleanQuery: '1984' });

    assert.equal(parseDirectTvdbIdQuery('tvdb:389597'), 389597);
    assert.equal(parseDirectTvdbIdQuery('TVDBID: 0012345'), 12345);
    assert.equal(parseDirectTvdbIdQuery('tvdb:abc'), null);
    assert.equal(parseDirectTvdbIdQuery('Frieren'), null);

    assert.equal(levenshteinDistance('frieren', 'frierem'), 1);
    assert.ok(scoreTitleSimilarity('Frierem', 'Frieren') >= 0.78);
    assert.ok(scoreTitleSimilarity('Jujutsu Kiasen', 'Jujutsu Kaisen') >= 0.75);
    assert.ok(scoreTitleSimilarity('Eminence in Shadow', 'The Eminence in Shadow') >= 0.95);
    assert.equal(scoreTitleSimilarity('3%', '3 percent'), 1);
    assert.ok(scoreTitleSimilarity('Frieren', 'Frieren Season 2') < 0.85);
  });

  it('applies TheXEM mappings with offset extrapolation and aligns split-cour & absolute episodes', async () => {
    clearXemCaches();

    const parsed = parseXemMappingsPayload(
      JSON.stringify({
        result: 'success',
        data: [
          { tvdb: { season: 1, episode: 13, absolute: 13 }, scene: { season: 2, episode: 1, absolute: 13 } },
          { tvdb: { season: 1, episode: 14, absolute: 14 }, scene: { season: 2, episode: 2, absolute: 14 } },
          { tvdb: { season: 0, episode: 1, absolute: 0 }, scene: { season: 0, episode: 1, absolute: 0 } },
          { tvdb: { season: 1, episode: 99, absolute: 99 }, scene: { season: 0, episode: 0, absolute: 0 } },
        ],
      })
    );
    assert.equal(parsed.length, 2);

    const aliases = parseXemAllNamesPayload(
      JSON.stringify({
        result: 'success',
        data: {
          '389597': [{ 'Frieren Split Cour': 2 }],
          '79151': [{ 'Fate/Zero S1': 1 }, { 'Fate/Zero S2': 2 }],
        },
      })
    );
    assert.equal(aliases.get(389597)?.[0]?.title, 'Frieren Split Cour');
    // Fate/Zero season > 1 alias quirk filtered out
    assert.equal(aliases.get(79151)?.length, 1);

    // Unmapped series skips /all after checking /havemap
    let allCalledForUnmapped = false;
    const xemFetcher: HttpFetcher = async (url) => {
      if (url.includes('/havemap')) {
        return { ok: true, status: 200, finalUrl: url, body: JSON.stringify({ result: 'success', data: ['389597'] }) };
      }
      if (url.includes('/all') && url.includes('id=999999')) {
        allCalledForUnmapped = true;
      }
      if (url.includes('/all') && url.includes('id=389597')) {
        return {
          ok: true,
          status: 200,
          finalUrl: url,
          body: JSON.stringify({
            result: 'success',
            data: [
              { tvdb: { season: 1, episode: 13, absolute: 13 }, scene: { season: 2, episode: 1, absolute: 13 } },
              { tvdb: { season: 1, episode: 14, absolute: 14 }, scene: { season: 2, episode: 2, absolute: 14 } },
            ],
          }),
        };
      }
      return { ok: false, status: 404, finalUrl: url, body: '' };
    };

    const unmapped = await fetchXemSceneMappingsForTvdbId(xemFetcher, 999999);
    assert.deepEqual(unmapped, []);
    assert.equal(allCalledForUnmapped, false);

    const mapped = await fetchXemSceneMappingsForTvdbId(xemFetcher, 389597);
    assert.equal(mapped.length, 2);

    // Extrapolates unmapped newer ep 15 -> scene S2E3 abs 15
    const catalogEps: AnimeEpisodeLink[] = [
      { numberLabel: 'EP 13', episodeNumber: 13, seasonNumber: 1, title: 'Episódio 13 — A', url: 'anisync://ep/13' },
      { numberLabel: 'EP 14', episodeNumber: 14, seasonNumber: 1, title: 'Episódio 14 — B', url: 'anisync://ep/14' },
      { numberLabel: 'EP 15', episodeNumber: 15, seasonNumber: 1, title: 'Episódio 15 — C', url: 'anisync://ep/15' },
    ];
    const withXem = applyXemMappingsToEpisodes(catalogEps, mapped);
    assert.equal(withXem[0].sceneSeasonNumber, 2);
    assert.equal(withXem[0].sceneEpisodeNumber, 1);
    assert.equal(withXem[2].sceneSeasonNumber, 2);
    assert.equal(withXem[2].sceneEpisodeNumber, 3);
    assert.equal(withXem[2].sceneAbsoluteEpisodeNumber, 15);

    // Merge split-cour server Season 2 (E1..E3) onto TVDB Season 1 (E13..E15) via XEM
    const serverS2: AnimeEpisodeLink[] = [
      { numberLabel: 'T2 · EP 1', episodeNumber: 1, seasonNumber: 2, title: 'Episódio 1', url: 'https://srv/s2e1' },
      { numberLabel: 'T2 · EP 2', episodeNumber: 2, seasonNumber: 2, title: 'Episódio 2', url: 'https://srv/s2e2' },
      { numberLabel: 'T2 · EP 3', episodeNumber: 3, seasonNumber: 2, title: 'Episódio 3', url: 'https://srv/s2e3' },
    ];
    const merged = mergeServerAndCatalogEpisodes({
      serverTitle: 'Split Anime 2nd Season',
      serverUrl: 'https://srv/split-2',
      serverEpisodes: serverS2,
      catalogEpisodes: withXem,
      serverMatched: true,
      tvdbId: 389597,
    });
    assert.equal(merged.length, 3);
    assert.equal(merged[0].url, 'https://srv/s2e1');
    assert.equal(merged[0].title, 'Episódio 13 — A');
    assert.equal(merged[2].url, 'https://srv/s2e3');
    assert.equal(merged[2].title, 'Episódio 15 — C');
    assert.equal(merged[2].availableOnServer, true);
  });

  it('paginates TheTVDB v4 episodes across links.next, filters fanart thumbs, and extracts rich metadata', async () => {
    const mockFetcher: HttpFetcher = async (url) => {
      if (url.endsWith('/v4/login')) {
        return { ok: true, status: 200, finalUrl: url, body: JSON.stringify({ data: { token: 'tok-v4-test' } }) };
      }
      if (url.includes('/v4/series/424242/extended')) {
        return {
          ok: true,
          status: 200,
          finalUrl: url,
          body: JSON.stringify({
            data: {
              id: 424242,
              name: 'Epic Long Anime',
              slug: 'epic-long-anime',
              image: 'https://artworks.thetvdb.com/banners/v4/series/424242/posters/p.jpg',
              overview: 'English overview',
              firstAired: '2020-01-05',
              lastAired: '2024-03-24',
              year: '2020',
              airsTime: '23:00',
              averageRuntime: 24,
              originalCountry: 'jpn',
              originalLanguage: 'jpn',
              status: { name: 'Ended' },
              contentRatings: [
                { country: 'usa', name: 'TV-14' },
                { country: 'bra', name: '14' },
              ],
              seasons: [
                { number: 0, name: 'Specials', type: { type: 'official' } },
                { number: 1, name: 'Season 1', type: { type: 'official' } },
                { number: 2, name: 'Entertainment District Arc', type: { type: 'official' } },
              ],
              genres: [{ name: 'Anime' }, { name: 'Action' }],
              remoteIds: [
                { sourceName: 'IMDB', id: 'tt1234567' },
                { sourceName: 'TheMovieDB.com', id: '95479' },
                { sourceName: 'MyAnimeList', id: '52991' },
                { sourceName: 'AniList', id: '154587' },
              ],
            },
          }),
        };
      }
      if (url.includes('/v4/series/424242/translations/pt')) {
        return {
          ok: true,
          status: 200,
          finalUrl: url,
          body: JSON.stringify({
            data: { name: 'Anime Épico Longo', overview: 'Sinopse nativa em PT-BR.' },
          }),
        };
      }
      if (url.includes('/episodes/default/pt?page=0')) {
        return {
          ok: true,
          status: 200,
          finalUrl: url,
          body: JSON.stringify({
            data: {
              episodes: [
                { id: 100, number: 1, seasonNumber: 0, name: 'OVA 1' }, // Special skipped!
                {
                  id: 101,
                  number: 1,
                  seasonNumber: 1,
                  absoluteNumber: 1,
                  name: 'Começo',
                  aired: '2020-01-05',
                  image: 'https://artworks.thetvdb.com/banners/v4/series/424242/backgrounds/bg-940.jpg',
                },
              ],
            },
            links: {
              next: 'https://api4.thetvdb.com/v4/series/424242/episodes/default/pt?page=1',
            },
          }),
        };
      }
      if (url.includes('/episodes/default/pt?page=1')) {
        return {
          ok: true,
          status: 200,
          finalUrl: url,
          body: JSON.stringify({
            data: {
              episodes: [
                {
                  id: 201,
                  number: 1,
                  seasonNumber: 2,
                  absoluteNumber: 2,
                  name: 'Arco 2',
                  aired: '2024-03-17',
                  image: 'https://artworks.thetvdb.com/banners/v4/episode/201/screencap/ep2.jpg',
                },
                {
                  id: 202,
                  number: 2,
                  seasonNumber: 2,
                  absoluteNumber: 3,
                  name: 'Desfecho',
                  aired: '2024-03-24',
                  finaleType: 'series',
                  image: 'https://artworks.thetvdb.com/banners/v4/episode/202/screencap/ep3.jpg',
                },
              ],
            },
            links: { next: null },
          }),
        };
      }
      return { ok: false, status: 404, finalUrl: url, body: '' };
    };

    const details = await fetchTheTvdbDetails(mockFetcher, 424242, {
      mediaType: 'anime',
      credentials: { tvdbApiKey: 'test-key-v4' },
      includeEpisodes: true,
      skipEpisodePageHydration: true,
    });

    assert.ok(details);
    assert.equal(details.episodes.length, 3); // page 0 + page 1, excluding Season 0 Special
    assert.equal(details.episodes[0].thumb, undefined); // -940. fanart rejected!
    assert.equal(details.episodes[1].absoluteNumber, 2);
    assert.equal(details.episodes[2].finaleType, 'series');
    assert.equal(details.contentRating, '14');
    assert.equal(details.airsTime, '23:00');
    assert.deepEqual(details.seasonNames, { 2: 'Entertainment District Arc' });
    assert.equal(details.externalIds?.imdbId, 'tt1234567');
    assert.equal(details.externalIds?.tmdbId, 95479);
    assert.equal(details.externalIds?.malId, 52991);
    assert.equal(details.externalIds?.aniListId, 154587);

    // Direct tvdb: ID search from searchTheTvdb and getAggregatedSearch
    const directRes = await searchTheTvdb(mockFetcher, 'tvdb:424242', { tvdbApiKey: 'test-key-v4' });
    assert.equal(directRes.length, 1);
    assert.equal(directRes[0].externalIds?.tvdbId, 424242);

    const barSearch = await getAggregatedSearch(mockFetcher, 'tvdb:424242');
    assert.equal(barSearch.results.length, 0); // public HTML 404 on mockFetcher without key, returns safely without throwing
  });

  it('staggers multi-episode premieres, fills batch air dates, infers finaleType, and computes adaptive cache TTLs', () => {
    const baseTs = Math.floor(Date.UTC(2023, 8, 29, 15, 0, 0) / 1000);
    const sameDayPremiere: AnimeEpisodeLink[] = [
      { numberLabel: 'EP 1', episodeNumber: 1, seasonNumber: 1, title: 'EP 1 — Fim da Jornada', url: 'u1', date: '2023-09-29', airingAt: baseTs },
      { numberLabel: 'EP 2', episodeNumber: 2, seasonNumber: 1, title: 'EP 2 — Não Precisava Ser Magia', url: 'u2', date: '2023-09-29', airingAt: baseTs },
    ];
    const staggered = adjustMultiEpisodeAirTimes(sameDayPremiere, 24);
    assert.equal(staggered[0].airingAt, baseTs);
    assert.equal(staggered[1].airingAt, baseTs + 24 * 60);

    const batchNoDates: AnimeEpisodeLink[] = [
      { numberLabel: 'EP 1', episodeNumber: 1, seasonNumber: 1, title: 'Episódio 1 — A', url: 'u1' },
      { numberLabel: 'EP 2', episodeNumber: 2, seasonNumber: 1, title: 'Episódio 2 — B', url: 'u2' },
    ];
    const withBatchDates = adjustBatchReleaseAirDates(batchNoDates, 'Finalizado', '2022-09-13');
    assert.equal(withBatchDates[0].date, '2022-09-13');
    assert.ok((withBatchDates[1].airingAt || 0) > 0);

    const withFinale = inferSeriesFinaleType(withBatchDates, 'Finalizado');
    assert.equal(withFinale[0].finaleType, undefined);
    assert.equal(withFinale[1].finaleType, 'series');
    assert.equal(formatEpisodeFinaleBadge('series'), 'Final da série');
    assert.equal(formatEpisodeFinaleBadge('season'), 'Final da temporada');

    assert.equal(
      isEpisodeFanartPlaceholderUrl('https://artworks.thetvdb.com/banners/fanart/original/123-940.jpg'),
      true
    );
    assert.equal(
      isEpisodeFanartPlaceholderUrl('https://artworks.thetvdb.com/banners/v4/episode/1/screencap/abc.jpg'),
      false
    );

    const nowMs = Date.UTC(2026, 10, 26, 12, 0, 0);
    // 1. Aired episode with generic/TBA title -> short TTL (3 min)
    assert.equal(
      computeAdaptiveMediaCacheTtlMs(
        {
          status: 'Em exibição',
          episodes: [
            { numberLabel: 'EP 1', episodeNumber: 1, seasonNumber: 1, title: 'Episódio 1', url: 'u1', date: '2026-11-20' },
          ],
        },
        nowMs
      ),
      3 * 60 * 1000
    );
    // 2. Ongoing series -> 10 min
    assert.equal(
      computeAdaptiveMediaCacheTtlMs(
        {
          status: 'Em exibição',
          episodes: [
            { numberLabel: 'EP 1', episodeNumber: 1, seasonNumber: 1, title: 'Episódio 1 — Nome Real', url: 'u1', date: '2026-11-20' },
          ],
        },
        nowMs
      ),
      10 * 60 * 1000
    );
    // 3. Recently ended (<30 days) -> 30 min
    assert.equal(
      computeAdaptiveMediaCacheTtlMs(
        {
          status: 'Finalizado',
          episodes: [
            { numberLabel: 'EP 12', episodeNumber: 12, seasonNumber: 1, title: 'Episódio 12 — O Adeus', url: 'u12', date: '2026-11-15' },
          ],
        },
        nowMs
      ),
      30 * 60 * 1000
    );
    // 4. Long ended (>30 days) -> 60 min
    assert.equal(
      computeAdaptiveMediaCacheTtlMs(
        {
          status: 'Finalizado',
          episodes: [
            { numberLabel: 'EP 28', episodeNumber: 28, seasonNumber: 1, title: 'Episódio 28 — Fim', url: 'u28', date: '2024-03-22' },
          ],
        },
        nowMs
      ),
      60 * 60 * 1000
    );
  });

  it('parses HTML On Other Sites IDs, contentRating, custom season headings, and renders subtle info meta', () => {
    const html = `
      <html><body>
        <h1 id="series_title">Demon Slayer</h1>
        <div class="change_translation_text" data-language="pt" data-title="Demon Slayer">
          <p>Sinopse em português.</p>
        </div>
        <ul id="series_basic_info">
          <li class="list-group-item"><strong>Status</strong><span>Ended</span></li>
          <li class="list-group-item"><strong>Content Rating</strong><span>TV-14</span></li>
          <li class="list-group-item"><strong>Airs</strong><span>Sunday at 11:15 PM</span></li>
          <li class="list-group-item"><strong>Original Language</strong><span>Japanese</span></li>
          <li class="list-group-item"><strong>On Other Sites</strong>
            <a href="https://www.imdb.com/title/tt9335498/">IMDB</a>
            <a href="https://www.themoviedb.org/tv/85937">TMDB</a>
            <a href="https://myanimelist.net/anime/38000">MAL</a>
            <a href="https://anilist.co/anime/101922">AniList</a>
          </li>
        </ul>
        <a href="/series/demon-slayer/seasons/official/1">Season 1</a>
        <a href="/series/demon-slayer/seasons/official/2">Distrito do Entretenimento</a>
      </body></html>
    `;
    const parsed = parseTvdbPublicHtml(html, 348545, 'anime', 'https://www.thetvdb.com/series/demon-slayer');
    assert.ok(parsed);
    assert.equal(parsed.contentRating, 'TV-14');
    assert.equal(parsed.airsTime, '11:15 PM');
    assert.equal(parsed.externalIds?.imdbId, 'tt9335498');
    assert.equal(parsed.externalIds?.tmdbId, 85937);
    assert.equal(parsed.externalIds?.malId, 38000);
    assert.equal(parsed.externalIds?.aniListId, 101922);
    assert.deepEqual(parsed.seasonNames, { 2: 'Distrito do Entretenimento' });

    const meta = buildAnimeInfoMetaItems(parsed);
    const cert = meta.find((m) => m.id === 'contentRating');
    assert.deepEqual(cert, {
      id: 'contentRating',
      label: 'Classificação',
      value: 'TV-14',
      kind: 'shield',
    });

    assert.equal(
      formatSeasonDisplayHeading(2, 'Temporada 2', parsed.seasonNames),
      'Temporada 2 · Distrito do Entretenimento'
    );
    assert.equal(formatSeasonDisplayHeading(1, 'Temporada 1', parsed.seasonNames), 'Temporada 1');

    // Verify allseasons HTML skips fanart thumbs and Season 0 Specials
    const allSeasonsHtml = `
      <li class="list-group-item"><span class="episode-label">S00E01</span><h4><a href="/episodes/1">Special</a></h4></li>
      <li class="list-group-item">
        <span class="episode-label">S01E01</span>
        <h4><a href="/episodes/2">Crueldade</a></h4>
        <img src="https://artworks.thetvdb.com/banners/fanart/original/348545-940.jpg" />
      </li>
    `;
    const eps = parseTvdbAllSeasonsHtml(allSeasonsHtml, 348545, 'anime');
    assert.equal(eps.length, 1);
    assert.equal(eps[0].seasonNumber, 1);
    assert.equal(eps[0].thumb, undefined);
  });
});
