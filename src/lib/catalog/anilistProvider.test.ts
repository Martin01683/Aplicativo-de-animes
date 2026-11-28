import test from 'node:test';
import assert from 'node:assert/strict';
import type { HttpFetcher } from '../httpTypes';
import { dispatchAnisyncApiRequest, clearAnisyncRouterCaches } from '../anisyncApiRouter';
import {
  buildAniListMediaUri,
  buildExternalDatabaseLinks,
  parseAniListExternalId,
  parseAnisyncUri,
} from './idCodec';
import {
  buildAniListDiscoverVariables,
  clearAniListTaxonomyCache,
  discoverAniListCatalog,
  fetchAniListTaxonomy,
  mapRawAniListMediaTags,
  sanitizeAniListTagName,
} from './providers/anilistProvider';
import { createProviderIndexStore } from './providerIndex';

test('AniList URI codec roundtrips cleanly and emits AniList external link', () => {
  const uri = buildAniListMediaUri(154587, 'Sousou no Frieren', "Frieren: Beyond Journey's End");
  const parsed = parseAnisyncUri(uri);
  assert.equal(parsed.kind, 'media');
  if (parsed.kind === 'media') {
    assert.equal(parsed.source, 'anilist');
    assert.equal(parsed.mediaType, 'anime');
    const al = parseAniListExternalId(parsed.externalId);
    assert.equal(al.aniListId, 154587);
    assert.equal(al.title, 'Sousou no Frieren');
    assert.equal(al.englishTitle, "Frieren: Beyond Journey's End");
  }

  const links = buildExternalDatabaseLinks({ aniListId: 154587, malId: 52991 });
  assert.equal(links.some((l) => l.source === 'anilist' && l.url === 'https://anilist.co/anime/154587'), true);
});

test('sanitizeAniListTagName allows official AniList tag syntax and blocks invalid characters', () => {
  assert.equal(sanitizeAniListTagName('Yandere'), 'Yandere');
  assert.equal(sanitizeAniListTagName('Youkai'), 'Youkai');
  assert.equal(sanitizeAniListTagName('Boys\' Love'), "Boys' Love");
  assert.equal(sanitizeAniListTagName('4-koma'), '4-koma');
  assert.equal(sanitizeAniListTagName('Post-Apocalyptic'), 'Post-Apocalyptic');
  assert.equal(sanitizeAniListTagName('  VTuber  '), 'VTuber');
  assert.equal(sanitizeAniListTagName(''), null);
  assert.equal(sanitizeAniListTagName('Tag<script>alert(1)</script>'), null);
  assert.equal(sanitizeAniListTagName('A'.repeat(80)), null);
});

test('buildAniListDiscoverVariables validates multi-select genres/tags and hides NOT_YET_RELEASED when onlyAvailable is true', () => {
  const varsAvail = buildAniListDiscoverVariables(
    {
      sort: 'SCORE_DESC',
      genre: 'Action',
      tag: 'Isekai',
      year: '2024',
      season: 'SPRING',
      format: 'TV',
      onlyAvailable: true,
    },
    1,
    40
  );
  assert.deepEqual(varsAvail.sort, ['SCORE_DESC']);
  assert.deepEqual(varsAvail.genreIn, ['Action']);
  assert.deepEqual(varsAvail.tagIn, ['Isekai']);
  assert.equal(varsAvail.seasonYear, 2024);
  assert.equal(varsAvail.season, 'SPRING');
  assert.equal(varsAvail.format, 'TV');
  assert.equal(varsAvail.statusNot, 'NOT_YET_RELEASED');

  const varsMulti = buildAniListDiscoverVariables(
    {
      genres: ['Action', 'Fantasy', 'InvalidGenreNotInList'],
      tags: ['Yandere', 'Youkai', 'Zombie', 'VTuber', 'Bad<script>'],
      year: '1800',
      onlyAvailable: false,
    },
    2,
    20
  );
  assert.deepEqual(varsMulti.genreIn, ['Action', 'Fantasy']);
  assert.deepEqual(varsMulti.tagIn, ['Yandere', 'Youkai', 'Zombie', 'VTuber']);
  assert.equal(varsMulti.seasonYear, undefined);
  assert.equal(varsMulti.statusNot, undefined);
});

test('fetchAniListTaxonomy loads full non-adult genres and tags and filters out Hentai/isAdult', async () => {
  clearAniListTaxonomyCache();
  const mockFetch: HttpFetcher = async (url) => ({
    status: 200,
    ok: true,
    finalUrl: url,
    body: JSON.stringify({
      data: {
        GenreCollection: ['Action', 'Hentai', 'Supernatural'],
        MediaTagCollection: [
          { name: 'Zombie', category: 'Cast-Traits', description: 'Undead creatures', isAdult: false },
          { name: 'Youkai', category: 'Cast-Traits', description: 'Japanese spirits', isAdult: false },
          { name: 'Yandere', category: 'Cast-Traits', description: 'Obsessive love', isAdult: false },
          { name: 'Explicit Adult Tag', category: 'Sexual Content', description: 'Adult', isAdult: true },
        ],
      },
    }),
  });

  const taxonomy = await fetchAniListTaxonomy(mockFetch, { forceRefresh: true });
  assert.equal(taxonomy.sourceMode, 'live');
  assert.deepEqual(
    taxonomy.genres.map((g) => g.value),
    ['Action', 'Supernatural']
  );
  assert.deepEqual(
    taxonomy.tags.map((t) => t.name),
    ['Yandere', 'Youkai', 'Zombie']
  );
  assert.equal(taxonomy.tags.find((t) => t.name === 'Zombie')?.label, 'Zumbis');
  assert.equal(taxonomy.tags.find((t) => t.name === 'Zombie')?.category, 'Traços');
  assert.equal(
    taxonomy.tags.find((t) => t.name === 'Zombie')?.description?.includes('cadáveres reanimados'),
    true
  );
});

test('discoverAniListCatalog filters unavailable titles, deduplicates unified series, and backfills next page', async () => {
  const store = createProviderIndexStore();
  store.upsertEntry({
    displayTitle: 'Sousou No Frieren',
    url: 'https://topanimes.net/animes/sousou-no-frieren/',
    kind: 'anime',
    audioType: 'LEG',
    providerName: 'TopAnimes',
    origin: 'sitemap',
  });
  store.upsertEntry({
    displayTitle: 'Sousou No Frieren',
    url: 'https://topanimes.net/animes/sousou-no-frieren-dublado/',
    kind: 'anime',
    audioType: 'DUB',
    providerName: 'TopAnimes',
    origin: 'sitemap',
  });
  store.upsertEntry({
    displayTitle: 'Solo Leveling',
    url: 'https://topanimes.net/animes/solo-leveling/',
    kind: 'anime',
    audioType: 'LEG',
    providerName: 'TopAnimes',
    origin: 'sitemap',
  });

  const requestedPages: number[] = [];
  const mockFetch: HttpFetcher = async (_url, options) => {
    const body = JSON.parse(options?.body || '{}') as { variables?: { page?: number } };
    const page = body.variables?.page || 1;
    requestedPages.push(page);

    if (page === 1) {
      return {
        status: 200,
        ok: true,
        finalUrl: 'https://graphql.anilist.co',
        body: JSON.stringify({
          data: {
            Page: {
              pageInfo: { total: 4, currentPage: 1, lastPage: 2, hasNextPage: true },
              media: [
                {
                  id: 1,
                  title: { romaji: 'Sousou no Frieren', english: "Frieren: Beyond Journey's End" },
                  coverImage: { large: 'https://img/frieren.jpg' },
                  averageScore: 91,
                  seasonYear: 2023,
                  format: 'TV',
                  status: 'FINISHED',
                  genres: ['Adventure', 'Fantasy'],
                },
                {
                  id: 2,
                  title: { romaji: 'Sousou no Frieren 2nd Season' },
                  coverImage: { large: 'https://img/frieren2.jpg' },
                  averageScore: 90,
                  seasonYear: 2026,
                  format: 'TV',
                  status: 'RELEASING',
                  genres: ['Adventure', 'Fantasy'],
                },
                {
                  id: 3,
                  title: { romaji: 'Completely Missing Obscure Title' },
                  coverImage: { large: 'https://img/missing.jpg' },
                  averageScore: 70,
                  seasonYear: 2025,
                  format: 'TV',
                  status: 'FINISHED',
                  genres: ['Drama'],
                },
              ],
            },
          },
        }),
      };
    }

    return {
      status: 200,
      ok: true,
      finalUrl: 'https://graphql.anilist.co',
      body: JSON.stringify({
        data: {
          Page: {
            pageInfo: { total: 4, currentPage: 2, lastPage: 2, hasNextPage: false },
            media: [
              {
                id: 4,
                title: { romaji: 'Ore dake Level Up na Ken', english: 'Solo Leveling' },
                coverImage: { large: 'https://img/solo.jpg' },
                averageScore: 84,
                seasonYear: 2024,
                format: 'TV',
                status: 'FINISHED',
                genres: ['Action'],
              },
            ],
          },
        },
      }),
    };
  };

  const onlyAvailRes = await discoverAniListCatalog(
    mockFetch,
    { onlyAvailable: true, audio: 'ALL', page: 1 },
    {
      targetPageSize: 2,
      maxScanPages: 3,
      matcher: (q) => store.matchTitles(q),
      ensureIndex: async () => store.getStats(),
    }
  );

  // Backfilled page 2, deduplicated Frieren S1 + S2, skipped Missing Title, matched Solo Leveling via English alias!
  assert.deepEqual(requestedPages, [1, 2]);
  assert.equal(onlyAvailRes.items.length, 2);
  assert.equal(onlyAvailRes.items[0].url, 'https://topanimes.net/animes/sousou-no-frieren/');
  assert.equal(onlyAvailRes.items[0].providerAvailability?.hasDub, true);
  assert.equal(onlyAvailRes.items[0].providerAvailability?.hasLeg, true);
  assert.equal(onlyAvailRes.items[1].url, 'https://topanimes.net/animes/solo-leveling/');
  assert.equal(onlyAvailRes.hasNextPage, false);

  // DUB filter picks dubUrl directly and excludes LEG-only Solo Leveling
  const dubOnlyRes = await discoverAniListCatalog(
    mockFetch,
    { onlyAvailable: true, audio: 'DUB', page: 1 },
    {
      targetPageSize: 5,
      maxScanPages: 2,
      matcher: (q) => store.matchTitles(q),
      ensureIndex: async () => store.getStats(),
    }
  );
  assert.equal(dubOnlyRes.items.length, 1);
  assert.equal(dubOnlyRes.items[0].url, 'https://topanimes.net/animes/sousou-no-frieren-dublado/');
  assert.equal(dubOnlyRes.items[0].audioType, 'DUB');

  // Unfiltered mode includes unavailable items with anisync://anime/anilist/... URI
  const allRes = await discoverAniListCatalog(
    mockFetch,
    { onlyAvailable: false, page: 1 },
    {
      targetPageSize: 5,
      matcher: (q) => store.matchTitles(q),
      ensureIndex: async () => store.getStats(),
    }
  );
  assert.equal(allRes.items.length, 3);
  const missingItem = allRes.items.find((i) => i.id === 'anilist-3');
  assert.ok(missingItem);
  assert.equal(missingItem.providerAvailability?.available, false);
  assert.equal(missingItem.url.startsWith('anisync://anime/anilist/3'), true);
});

test('GET /api/discover routes cleanly through dispatchAnisyncApiRequest', async () => {
  clearAnisyncRouterCaches();
  const mockFetch: HttpFetcher = async (url) => {
    if (url.includes('graphql.anilist.co')) {
      return {
        status: 200,
        ok: true,
        finalUrl: url,
        body: JSON.stringify({
          data: {
            Page: {
              pageInfo: { total: 1, currentPage: 1, lastPage: 1, hasNextPage: false },
              media: [
                {
                  id: 99,
                  title: { romaji: 'Cowboy Bebop' },
                  coverImage: { large: 'https://img/bebop.jpg' },
                  averageScore: 86,
                  seasonYear: 1998,
                  format: 'TV',
                  status: 'FINISHED',
                  genres: ['Action', 'Sci-Fi'],
                },
              ],
            },
          },
        }),
      };
    }
    if (url.endsWith('/tvshows-sitemap1.xml')) {
      return {
        status: 200,
        ok: true,
        finalUrl: url,
        body: '<urlset><url><loc>https://topanimes.net/animes/cowboy-bebop/</loc></url></urlset>',
      };
    }
    return { status: 404, ok: false, finalUrl: url, body: '' };
  };

  const res = await dispatchAnisyncApiRequest(
    '/api/discover?sort=SCORE_DESC&genres=Action,Sci-Fi&tags=Youkai,Witch&onlyAvailable=1',
    { method: 'GET' },
    { fetchHttp: mockFetch, serviceName: 'test', useCache: false }
  );

  assert.equal(res.status, 200);
  const payload = res.body as { items: Array<{ title: string; url: string }> };
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].title, 'Cowboy Bebop');
  assert.equal(payload.items[0].url, 'https://topanimes.net/animes/cowboy-bebop/');
});

test('GET /api/discover/meta returns full AniList genres and tags taxonomy', async () => {
  clearAnisyncRouterCaches();
  clearAniListTaxonomyCache();
  const mockFetch: HttpFetcher = async (url) => ({
    status: 200,
    ok: true,
    finalUrl: url,
    body: JSON.stringify({
      data: {
        GenreCollection: ['Action', 'Fantasy', 'Hentai'],
        MediaTagCollection: [
          { name: 'Wuxia', category: 'Theme-Fantasy', description: 'Chinese martial arts', isAdult: false },
          { name: 'Youkai', category: 'Cast-Traits', description: 'Japanese spirits', isAdult: false },
          { name: 'Zombie', category: 'Cast-Traits', description: 'Undead', isAdult: false },
        ],
      },
    }),
  });

  const res = await dispatchAnisyncApiRequest(
    '/api/discover/meta',
    { method: 'GET' },
    { fetchHttp: mockFetch, serviceName: 'test', useCache: false }
  );

  assert.equal(res.status, 200);
  const body = res.body as {
    genres: Array<{ value: string; label: string }>;
    tags: Array<{ name: string; label: string }>;
    sourceMode: string;
  };
  assert.equal(body.sourceMode, 'live');
  assert.deepEqual(
    body.genres.map((g) => g.value),
    ['Action', 'Fantasy']
  );
  assert.deepEqual(
    body.tags.map((t) => t.name),
    ['Wuxia', 'Youkai', 'Zombie']
  );
});

test('GET /api/media?stage=metadata resolves from TheTVDB + MAL with zero slow provider requests', async () => {
  clearAnisyncRouterCaches();
  const requestedUrls: string[] = [];

  const mockFetch: HttpFetcher = async (url) => {
    requestedUrls.push(url);
    if (url.includes('topanimes.net') || url.includes('hinatasoul.com')) {
      throw new Error(`Unexpected slow provider request during stage=metadata: ${url}`);
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
                  id: 76885,
                  type: 'series',
                  name: 'Cowboy Bebop',
                  slug: 'cowboy-bebop',
                  country: 'jpn',
                  primary_language: 'jpn',
                  year: '1998',
                  poster: 'https://artworks.thetvdb.com/banners/posters/76885.jpg',
                  translations: { pt: 'Cowboy Bebop' },
                  overviews: { pt: 'Caçadores de recompensas no espaço.' },
                  genres: ['Action', 'Sci-Fi'],
                },
              ],
            },
          ],
        }),
      };
    }
    if (url.includes('/series/cowboy-bebop/allseasons/official')) {
      return {
        status: 200,
        ok: true,
        finalUrl: url,
        body: `<ul><li class="list-group-item"><h4><span class="episode-label">S01E01</span><a href="/series/cowboy-bebop/episodes/1">Asteroid Blues</a></h4></li></ul>`,
      };
    }
    if (url.includes('/series/cowboy-bebop')) {
      return {
        status: 200,
        ok: true,
        finalUrl: 'https://www.thetvdb.com/series/cowboy-bebop',
        body: `<html><body>
          <h1>Cowboy Bebop</h1>
          <img class="img-responsive" src="https://artworks.thetvdb.com/banners/posters/76885.jpg" />
          <div class="change_translation_text" data-language="pt" data-title="Cowboy Bebop">
            <p>Caçadores de recompensas no espaço.</p>
          </div>
          <ul id="series_basic_info">
            <li><strong>TheTVDB.com Series ID</strong><span>76885</span></li>
            <li><strong>Status</strong><span>Ended</span></li>
            <li><strong>Studio</strong><span><a>Sunrise</a></span></li>
            <li><strong>Genres</strong><span><a>Action</a><a>Sci-Fi</a></span></li>
          </ul>
        </body></html>`,
      };
    }
    if (url.includes('myanimelist.net/search/prefix.json')) {
      return {
        status: 200,
        ok: true,
        finalUrl: url,
        body: JSON.stringify({
          categories: [
            {
              type: 'anime',
              items: [
                {
                  id: 1,
                  name: 'Cowboy Bebop',
                  url: 'https://myanimelist.net/anime/1/Cowboy_Bebop',
                  payload: {
                    score: '8.75',
                    media_type: 'TV',
                    start_year: 1998,
                  },
                },
              ],
            },
          ],
        }),
      };
    }
    return { status: 404, ok: false, finalUrl: url, body: '' };
  };

  const res = await dispatchAnisyncApiRequest(
    '/api/media?url=https%3A%2F%2Ftopanimes.net%2Fanimes%2Fcowboy-bebop%2F&title=Cowboy+Bebop&stage=metadata',
    { method: 'GET' },
    { fetchHttp: mockFetch, serviceName: 'test', useCache: false }
  );

  assert.equal(res.status, 200);
  const body = res.body as {
    title: string;
    studio?: string;
    poster: string;
    synopsis: string;
    rating?: string;
    enrichmentSources?: string[];
    episodes: Array<{ title: string; availableOnServer?: boolean }>;
  };
  assert.equal(body.title, 'Cowboy Bebop');
  assert.equal(body.studio, 'Sunrise');
  assert.equal(body.poster, 'https://artworks.thetvdb.com/banners/posters/76885.jpg');
  assert.equal(body.synopsis, 'Caçadores de recompensas no espaço.');
  assert.equal(body.rating, '8.75');
  assert.equal(body.enrichmentSources?.includes('thetvdb'), true);
  assert.equal(body.episodes.length, 1);
  assert.equal(body.episodes[0].availableOnServer, false);
  assert.equal(
    requestedUrls.some((u) => u.includes('topanimes.net') || u.includes('hinatasoul.com')),
    false
  );
});

test('GET /api/media?stage=metadata falls back to AniList for anisync://anime/anilist URIs when TheTVDB misses', async () => {
  clearAnisyncRouterCaches();
  const mockFetch: HttpFetcher = async (url) => {
    if (url.includes('topanimes.net') || url.includes('hinatasoul.com')) {
      throw new Error(`Unexpected slow provider request during AniList metadata fallback: ${url}`);
    }
    if (url.includes('graphql.anilist.co')) {
      return {
        status: 200,
        ok: true,
        finalUrl: url,
        body: JSON.stringify({
          data: {
            Media: {
              id: 99,
              idMal: 1,
              title: { romaji: 'Cowboy Bebop', english: 'Cowboy Bebop', native: 'カウボーイビバップ' },
              coverImage: { extraLarge: 'https://img/al-bebop.jpg' },
              bannerImage: 'https://img/al-bebop-banner.jpg',
              description: 'Space bounty hunters.',
              averageScore: 86,
              seasonYear: 1998,
              format: 'TV',
              status: 'FINISHED',
              episodes: 26,
              duration: 24,
              genres: ['Action', 'Sci-Fi'],
              studios: { nodes: [{ name: 'Sunrise' }] },
            },
          },
        }),
      };
    }
    return { status: 404, ok: false, finalUrl: url, body: '' };
  };

  const target = encodeURIComponent(buildAniListMediaUri(99, 'Cowboy Bebop'));
  const res = await dispatchAnisyncApiRequest(
    `/api/media?url=${target}&stage=metadata`,
    { method: 'GET' },
    { fetchHttp: mockFetch, serviceName: 'test', useCache: false }
  );

  assert.equal(res.status, 200);
  const body = res.body as {
    title: string;
    poster: string;
    year?: string;
    genres: string[];
    enrichmentSources?: string[];
  };
  assert.equal(body.title, 'Cowboy Bebop');
  assert.equal(body.poster, 'https://img/al-bebop.jpg');
  assert.equal(body.year, '1998');
  assert.equal(body.genres.includes('Ação'), true);
  assert.equal(body.enrichmentSources?.includes('anilist'), true);
});

test('buildAniListDiscoverVariables and GET /api/discover support excludeGenres (genre_not_in) and excludeTags (tag_not_in) without overlap', async () => {
  const vars = buildAniListDiscoverVariables(
    {
      genres: ['Action', 'Fantasy'],
      excludeGenres: ['Ecchi', 'Horror', 'Action', 'NotAGenre'],
      tags: ['Isekai'],
      excludeTags: ['Harem', 'Gore', 'isekai', 'Bad<script>'],
      minimumTagRank: 65,
      onlyAvailable: false,
    },
    1,
    20
  );
  assert.deepEqual(vars.genreIn, ['Action', 'Fantasy']);
  assert.deepEqual(vars.genreNotIn, ['Ecchi', 'Horror']);
  assert.deepEqual(vars.tagIn, ['Isekai']);
  assert.deepEqual(vars.tagNotIn, ['Harem', 'Gore']);
  assert.equal(vars.minimumTagRank, 65);

  clearAnisyncRouterCaches();
  let capturedVariables: Record<string, unknown> = {};
  const mockFetch: HttpFetcher = async (url, opts) => {
    if (url.includes('graphql.anilist.co')) {
      const parsed = JSON.parse(opts?.body || '{}') as { variables?: Record<string, unknown> };
      capturedVariables = parsed.variables || {};
      return {
        status: 200,
        ok: true,
        finalUrl: url,
        body: JSON.stringify({
          data: {
            Page: {
              pageInfo: { total: 0, currentPage: 1, lastPage: 1, hasNextPage: false },
              media: [],
            },
          },
        }),
      };
    }
    return { status: 404, ok: false, finalUrl: url, body: '' };
  };

  const res = await dispatchAnisyncApiRequest(
    '/api/discover?genres=Action&excludeGenres=Ecchi,Horror,Action&tags=Isekai&excludeTags=Harem,Gore,isekai&minTagRank=60&onlyAvailable=0',
    { method: 'GET' },
    { fetchHttp: mockFetch, serviceName: 'test', useCache: false }
  );
  assert.equal(res.status, 200);
  assert.deepEqual(capturedVariables.genreIn, ['Action']);
  assert.deepEqual(capturedVariables.genreNotIn, ['Ecchi', 'Horror']);
  assert.deepEqual(capturedVariables.tagIn, ['Isekai']);
  assert.deepEqual(capturedVariables.tagNotIn, ['Harem', 'Gore']);
  assert.equal(capturedVariables.minimumTagRank, 60);
});

test('mapRawAniListMediaTags translates tags, preserves spoiler flags, and filters adult/low-rank tags', () => {
  const mapped = mapRawAniListMediaTags([
    { name: 'Time Manipulation', category: 'Theme-Sci-Fi', rank: 92, isMediaSpoiler: false, isGeneralSpoiler: false, isAdult: false },
    { name: 'Tragedy', category: 'Theme-Drama', rank: 85, isMediaSpoiler: true, isGeneralSpoiler: false, isAdult: false },
    { name: 'Amnesia', category: 'Cast-Traits', rank: 70, isMediaSpoiler: false, isGeneralSpoiler: true, isAdult: false },
    { name: 'NoiseTag', category: 'Other', rank: 20, isMediaSpoiler: false, isGeneralSpoiler: false, isAdult: false },
    { name: 'ExplicitAdult', category: 'Sexual Content', rank: 95, isMediaSpoiler: false, isGeneralSpoiler: false, isAdult: true },
  ]);

  assert.equal(mapped.length, 3);
  assert.equal(mapped[0].name, 'Time Manipulation');
  assert.equal(mapped[0].isSpoiler, false);
  assert.equal(mapped[1].name, 'Tragedy');
  assert.equal(mapped[1].isSpoiler, true);
  assert.equal(mapped[2].name, 'Amnesia');
  assert.equal(mapped[2].isSpoiler, true);
});

test('Metadata hierarchy prioritizes TVDB > AniList > MyAnimeList > Providers for info and AniList > TVDB > MyAnimeList > Providers for genres', async () => {
  clearAnisyncRouterCaches();

  // Case 1: TVDB + AniList + MAL all available -> TVDB wins title/poster/synopsis, AniList wins genres + spoiler mediaTags, MAL wins rating
  const fullChainFetch: HttpFetcher = async (url, opts) => {
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
                  id: 76885,
                  type: 'series',
                  name: 'Cowboy Bebop',
                  slug: 'cowboy-bebop',
                  country: 'jpn',
                  primary_language: 'jpn',
                  year: '1998',
                  poster: 'https://artworks.thetvdb.com/banners/posters/76885.jpg',
                  translations: { pt: 'Cowboy Bebop (TVDB)' },
                  overviews: { pt: 'Sinopse oficial do TVDB.' },
                  genres: ['Animation', 'Crime'],
                },
              ],
            },
          ],
        }),
      };
    }
    if (url.includes('/series/cowboy-bebop/allseasons/official')) {
      return { status: 200, ok: true, finalUrl: url, body: '<ul></ul>' };
    }
    if (url.includes('/series/cowboy-bebop')) {
      return {
        status: 200,
        ok: true,
        finalUrl: 'https://www.thetvdb.com/series/cowboy-bebop',
        body: `<html><body>
          <h1>Cowboy Bebop</h1>
          <img class="img-responsive" src="https://artworks.thetvdb.com/banners/posters/76885.jpg" />
          <div class="change_translation_text" data-language="pt" data-title="Cowboy Bebop (TVDB)"><p>Sinopse oficial do TVDB.</p></div>
          <ul id="series_basic_info">
            <li><strong>TheTVDB.com Series ID</strong><span>76885</span></li>
            <li><strong>Genres</strong><span><a>Animation</a><a>Crime</a></span></li>
          </ul>
        </body></html>`,
      };
    }
    if (url.includes('graphql.anilist.co')) {
      const q = (opts?.body || '').toString();
      if (q.includes('Page(')) {
        return {
          status: 200,
          ok: true,
          finalUrl: url,
          body: JSON.stringify({
            data: {
              Page: {
                media: [
                  {
                    id: 1,
                    idMal: 1,
                    title: { romaji: 'Cowboy Bebop', english: 'Cowboy Bebop' },
                    coverImage: { extraLarge: 'https://img/al-bebop.jpg' },
                    genres: ['Action', 'Adventure', 'Drama', 'Sci-Fi'],
                    averageScore: 86,
                    seasonYear: 1998,
                    format: 'TV',
                    status: 'FINISHED',
                    tags: [
                      { name: 'Space', category: 'Setting', rank: 94, isMediaSpoiler: false, isGeneralSpoiler: false, isAdult: false },
                      { name: 'Tragedy', category: 'Theme', rank: 78, isMediaSpoiler: true, isGeneralSpoiler: false, isAdult: false },
                    ],
                  },
                ],
              },
            },
          }),
        };
      }
    }
    if (url.includes('myanimelist.net/anime/1')) {
      return {
        status: 200,
        ok: true,
        finalUrl: url,
        body: '<html><span itemprop="ratingValue">8.75</span></html>',
      };
    }
    return { status: 404, ok: false, finalUrl: url, body: '' };
  };

  const res1 = await dispatchAnisyncApiRequest(
    '/api/media?url=https%3A%2F%2Ftopanimes.net%2Fanimes%2Fcowboy-bebop%2F&title=Cowboy+Bebop&stage=metadata',
    { method: 'GET' },
    { fetchHttp: fullChainFetch, serviceName: 'test', useCache: false }
  );
  assert.equal(res1.status, 200);
  const body1 = res1.body as {
    title: string;
    poster: string;
    synopsis: string;
    rating?: string;
    genres: string[];
    genresSource?: string;
    mediaTags?: Array<{ name: string; isSpoiler: boolean }>;
  };
  assert.equal(body1.title, 'Cowboy Bebop (TVDB)');
  assert.equal(body1.poster, 'https://artworks.thetvdb.com/banners/posters/76885.jpg');
  assert.equal(body1.synopsis, 'Sinopse oficial do TVDB.');
  assert.equal(body1.rating, '8.75');
  assert.equal(body1.genresSource, 'anilist');
  assert.deepEqual(body1.genres, ['Ação', 'Aventura', 'Drama', 'Ficção Científica']);
  assert.equal(body1.mediaTags?.some((t) => t.name === 'Space' && !t.isSpoiler), true);
  assert.equal(body1.mediaTags?.some((t) => t.name === 'Tragedy' && t.isSpoiler), true);

  // Case 2: TVDB & AniList both miss -> MyAnimeList serves as 3rd fallback!
  clearAnisyncRouterCaches();
  const malFallbackFetch: HttpFetcher = async (url) => {
    if (url.includes('myanimelist.net/search/prefix.json')) {
      return {
        status: 200,
        ok: true,
        finalUrl: url,
        body: JSON.stringify({
          categories: [
            {
              type: 'anime',
              items: [
                {
                  id: 7777,
                  name: 'Rare OVA Title',
                  url: 'https://myanimelist.net/anime/7777/Rare_OVA_Title',
                  payload: { score: '7.42', media_type: 'OVA', start_year: 2005 },
                },
              ],
            },
          ],
        }),
      };
    }
    if (url.includes('myanimelist.net/anime/7777')) {
      return {
        status: 200,
        ok: true,
        finalUrl: url,
        body: `<html><head><meta property="og:image" content="https://cdn.myanimelist.net/images/anime/7777.jpg" /></head>
          <body>
            <h1 class="title-name">Rare OVA Title</h1>
            <p itemprop="description">Rare MAL synopsis.</p>
            <span itemprop="ratingValue">7.42</span>
            <span itemprop="genre">Mystery</span><span itemprop="genre">Horror</span>
          </body></html>`,
      };
    }
    return { status: 404, ok: false, finalUrl: url, body: '' };
  };

  const res2 = await dispatchAnisyncApiRequest(
    '/api/media?url=https%3A%2F%2Ftopanimes.net%2Fanimes%2Frare-ova-title%2F&title=Rare+OVA+Title&stage=metadata',
    { method: 'GET' },
    { fetchHttp: malFallbackFetch, serviceName: 'test', useCache: false }
  );
  assert.equal(res2.status, 200);
  const body2 = res2.body as {
    title: string;
    poster: string;
    rating?: string;
    genres: string[];
    genresSource?: string;
  };
  assert.equal(body2.title, 'Rare OVA Title');
  assert.equal(body2.poster, 'https://cdn.myanimelist.net/images/anime/7777.jpg');
  assert.equal(body2.rating, '7.42');
  assert.equal(body2.genresSource, 'myanimelist');
  assert.deepEqual(body2.genres, ['Mistério', 'Terror']);

  // Case 3: TVDB, AniList, AND MyAnimeList all miss -> Provider-only content STILL loads as last fallback!
  clearAnisyncRouterCaches();
  const providerOnlyFetch: HttpFetcher = async (url) => {
    if (url.includes('topanimes.net/animes/exclusivo-do-provedor')) {
      return {
        status: 200,
        ok: true,
        finalUrl: 'https://topanimes.net/animes/exclusivo-do-provedor/',
        body: `<html><body>
          <div class="sheader">
            <div class="poster"><img src="https://topanimes.net/excl.jpg" /></div>
            <div class="data"><h1>Exclusivo do Provedor</h1><div class="sgeneros"><a href="#">Ação</a></div></div>
          </div>
          <div class="wp-content"><p>Conteúdo disponível apenas no provedor.</p></div>
          <div id="seasons"><div class="se-c"><div class="se-q"><span class="se-t">1</span></div>
            <ul class="episodios"><li><div class="numerando">1 - 1</div><div class="episodiotitle"><a href="https://topanimes.net/episodio/exclusivo-ep-1/">Episódio 1</a></div></li></ul>
          </div></div>
        </body></html>`,
      };
    }
    return { status: 404, ok: false, finalUrl: url, body: '' };
  };

  const res3 = await dispatchAnisyncApiRequest(
    '/api/media?url=https%3A%2F%2Ftopanimes.net%2Fanimes%2Fexclusivo-do-provedor%2F&title=Exclusivo+do+Provedor',
    { method: 'GET' },
    { fetchHttp: providerOnlyFetch, serviceName: 'test', useCache: false }
  );
  assert.equal(res3.status, 200);
  const body3 = res3.body as { title: string; poster: string; synopsis: string; episodes: Array<{ url: string }> };
  assert.equal(body3.title, 'Exclusivo do Provedor');
  assert.equal(body3.poster, 'https://topanimes.net/excl.jpg');
  assert.equal(body3.synopsis, 'Conteúdo disponível apenas no provedor.');
  assert.equal(body3.episodes.length, 1);
});

test('POST /api/catalog/test verifies connectivity for TheTVDB, AniList, MyAnimeList, and LiveChart.me', async () => {
  const seenUrls: string[] = [];
  const mockFetch: HttpFetcher = async (url) => {
    seenUrls.push(url);
    return { status: 200, ok: true, finalUrl: url, body: '{}' };
  };

  for (const serviceId of ['thetvdb', 'anilist', 'myanimelist', 'livechart']) {
    const res = await dispatchAnisyncApiRequest(
      '/api/catalog/test',
      { method: 'POST', jsonBody: { serviceId } },
      { fetchHttp: mockFetch, serviceName: 'test', useCache: false }
    );
    assert.equal(res.status, 200);
    const body = res.body as { ok: boolean; sourceId: string; message: string };
    assert.equal(body.ok, true);
    assert.equal(body.sourceId, serviceId);
    assert.match(body.message, /Conexão OK/);
  }

  assert.equal(seenUrls.some((u) => u.includes('thetvdb.com')), true);
  assert.equal(seenUrls.some((u) => u.includes('graphql.anilist.co')), true);
  assert.equal(seenUrls.some((u) => u.includes('myanimelist.net')), true);
  assert.equal(seenUrls.some((u) => u.includes('livechart.me')), true);

  const invalidRes = await dispatchAnisyncApiRequest(
    '/api/catalog/test',
    { method: 'POST', jsonBody: { serviceId: 'unknown' } },
    { fetchHttp: mockFetch, serviceName: 'test', useCache: false }
  );
  assert.equal(invalidRes.status, 400);
});


