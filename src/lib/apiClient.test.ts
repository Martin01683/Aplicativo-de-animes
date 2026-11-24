import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearAnisyncRouterCaches,
  dispatchAnisyncApiRequest,
} from './anisyncApiRouter';
import { routeNativeApiRequest } from './apiClient';

test('routeNativeApiRequest validates /api/media, /api/anime, /api/episode and /api/resolve-embed', async () => {
  const animeBad = await routeNativeApiRequest('/api/anime?url=https://example.com/foo', undefined);
  assert.equal(animeBad.status, 400);

  const mediaBad = await routeNativeApiRequest('/api/media?url=https://example.com/foo', undefined);
  assert.equal(mediaBad.status, 400);

  const epBad = await routeNativeApiRequest('/api/episode?url=http://127.0.0.1/test', undefined);
  assert.equal(epBad.status, 400);

  const embedBad = await routeNativeApiRequest('/api/resolve-embed', undefined);
  assert.equal(embedBad.status, 400);
});

test('routeNativeApiRequest serves /api/home, /api/catalog, /api/search, and /api/glossary strictly from active servers', async () => {
  const topHomeHtml = `
    <html><body>
      <script>var dtGonza = {"nonce":"demo1234"};</script>
      <div id="dt-tvshows">
        <article class="item"><div class="poster"><img src="https://img.example.org/frieren.jpg" /></div>
          <div class="data"><h3><a href="https://topanimes.net/animes/sousou-no-frieren/">Sousou no Frieren</a></h3><span>2023</span></div>
        </article>
      </div>
      <div id="dt-movies">
        <article class="item"><div class="poster"><img src="https://img.example.org/movie.jpg" /></div>
          <div class="data"><h3><a href="https://topanimes.net/filmes/suzume/">Suzume</a></h3><span>2022</span></div>
        </article>
      </div>
      <article class="item se episodes">
        <div class="poster"><img src="https://img.example.org/ep.jpg" alt="Frieren" /><span class="quality">FHD</span></div>
        <div class="data"><a href="https://topanimes.net/episodio/sousou-no-frieren-episodio-12/"><h3>Episódio 12</h3><span class="serie">Sousou no Frieren</span></a></div>
      </article>
    </body></html>`;

  const searchHtml = `
    <div class="search-page">
      <div class="result-item"><article>
        <div class="thumbnail"><a href="https://topanimes.net/animes/sousou-no-frieren/"><img src="https://img.example.org/frieren.jpg" /></a></div>
        <div class="details"><div class="title"><a href="https://topanimes.net/animes/sousou-no-frieren/">Sousou no Frieren</a></div>
        <div class="meta"><span class="year">2023</span></div></div>
      </article></div>
    </div>`;

  const fetchPage = async (targetUrl: string) => {
    if (targetUrl === 'https://topanimes.net/' || targetUrl === 'https://topanimes.net') {
      return { status: 200, ok: true, finalUrl: targetUrl, body: topHomeHtml };
    }
    if (targetUrl.includes('/wp-json/dooplay/search/')) {
      return {
        status: 200,
        ok: true,
        finalUrl: targetUrl,
        body: JSON.stringify({
          '1': {
            title: 'Sousou no Frieren',
            url: 'https://topanimes.net/animes/sousou-no-frieren/',
            img: 'https://img.example.org/frieren.jpg',
            extra: { date: '2023', imdb: '8.9' },
          },
        }),
      };
    }
    if (targetUrl.includes('/wp-json/dooplay/glossary/')) {
      return {
        status: 200,
        ok: true,
        finalUrl: targetUrl,
        body: JSON.stringify({
          '1': {
            title: '86 Eighty-Six',
            url: 'https://topanimes.net/animes/86-eighty-six/',
            img: 'https://img.example.org/86.jpg',
            year: '2021',
          },
        }),
      };
    }
    if (targetUrl.includes('/?s=')) {
      return { status: 200, ok: true, finalUrl: targetUrl, body: searchHtml };
    }
    return { status: 404, ok: false, finalUrl: targetUrl, body: '' };
  };

  const home = await routeNativeApiRequest('/api/home', undefined, { fetchPage });
  assert.equal(home.status, 200);
  const homeBody = home.body as {
    animes: Array<{ url: string; title: string }>;
    movies: Array<{ url: string }>;
    releases: Array<{ url: string }>;
  };
  assert.equal(homeBody.animes[0].title, 'Sousou no Frieren');
  assert.ok(homeBody.animes[0].url.startsWith('https://topanimes.net/'));
  assert.equal(homeBody.movies.length, 1);
  assert.equal(homeBody.releases.length, 1);

  const emptySearch = await routeNativeApiRequest('/api/search?q=', undefined);
  assert.equal(emptySearch.status, 200);
  assert.deepEqual((emptySearch.body as { results: unknown[] }).results, []);

  const search = await routeNativeApiRequest('/api/search?q=frieren', undefined, { fetchPage });
  assert.equal(search.status, 200);
  const searchBody = search.body as { results: Array<{ title: string; url: string }> };
  assert.equal(searchBody.results[0].url, 'https://topanimes.net/animes/sousou-no-frieren/');

  const suggestRes = await routeNativeApiRequest('/api/search-suggest?q=frieren', undefined, {
    fetchPage,
  });
  assert.equal(suggestRes.status, 200);
  const suggestBody = suggestRes.body as { results: Array<{ title: string }> };
  assert.equal(suggestBody.results[0].title, 'Sousou no Frieren');

  const glossaryBad = await routeNativeApiRequest('/api/glossary?term=invalid', undefined);
  assert.equal(glossaryBad.status, 400);

  const glossaryRes = await routeNativeApiRequest('/api/glossary?term=%23&type=tvshows', undefined, {
    fetchPage,
  });
  assert.equal(glossaryRes.status, 200);
  const glossaryBody = glossaryRes.body as { term: string; items: Array<{ title: string }> };
  assert.equal(glossaryBody.term, '#');
  assert.ok(glossaryBody.items.some((item) => item.title.startsWith('86')));
});

test('routeNativeApiRequest returns Anisync health check and safe fallback on /api/apk-info', async () => {
  const health = await routeNativeApiRequest('/api/health', undefined);
  assert.equal(health.status, 200);
  assert.equal((health.body as { ok: boolean; aggregator: string }).ok, true);
  assert.equal((health.body as { ok: boolean; aggregator: string }).aggregator, 'anisync');

  const apkInfo = await routeNativeApiRequest('/api/apk-info', undefined);
  assert.equal(apkInfo.status, 200);
  assert.equal((apkInfo.body as { available: boolean }).available, false);
});

test('routeNativeApiRequest parses GitHub Releases on /api/app-update/check', async () => {
  const res = await routeNativeApiRequest('/api/app-update/check', undefined, {
    fetchPage: async () => ({
      status: 200,
      ok: true,
      finalUrl: 'https://api.github.com/repos/Martin01683/Aplicativo-de-animes/releases/latest',
      body: JSON.stringify({
        id: 453376005,
        tag_name: 'latest-apk',
        name: 'Anisync Android APK',
        html_url: 'https://github.com/Martin01683/Aplicativo-de-animes/releases/tag/latest-apk',
        published_at: '2026-11-21T02:11:00Z',
        updated_at: '2026-11-21T02:42:12Z',
        body: 'Build automático (7ea7c809c1317142fa6c3aa4818e9716afbfe30c).',
        assets: [
          {
            name: 'Anisync.apk',
            size: 92044913,
            updated_at: '2026-11-21T02:42:11Z',
            browser_download_url:
              'https://github.com/Martin01683/Aplicativo-de-animes/releases/download/latest-apk/Anisync.apk',
          },
        ],
      }),
    }),
  });

  assert.equal(res.status, 200);
  const body = res.body as {
    release: { tagName: string; commitSha: string; apkAsset: { name: string } | null } | null;
  };
  assert.equal(body.release?.tagName, 'latest-apk');
  assert.equal(body.release?.commitSha, '7ea7c809c1317142fa6c3aa4818e9716afbfe30c');
  assert.equal(body.release?.apkAsset?.name, 'Anisync.apk');
});

test('routeNativeApiRequest serves /api/calendar weekly schedule from LiveChart.me with Dub/Sub & streaming service info', async () => {
  const tzShiftMs = -180 * 60 * 1000;
  const brtToday = new Date(Date.now() + tzShiftMs);
  brtToday.setUTCHours(12, 0, 0, 0);
  const todayNoonSec = Math.floor((brtToday.getTime() - tzShiftMs) / 1000);
  const res = await routeNativeApiRequest('/api/calendar?mode=streams&tz=-180', undefined, {
    fetchPage: async (targetUrl) => {
      assert.ok(targetUrl.includes('livechart.me/schedule'));
      return {
        status: 200,
        ok: true,
        finalUrl: targetUrl,
        body: `
          <div data-controller="schedule-day">
            <article class="lc-compact-anime-card"
              data-anime-item-id="13232"
              data-anime-item-romanized-native-title="Black Clover 2nd Season">
              <img class="lc-compact-anime-card__poster" src="https://u.livechart.me/anime/13232/poster.jpg" />
              <div class="lc-compact-anime-card__release-state">
                <div><strong>EP8</strong> · Sub - Crunchyroll</div>
                <time data-timestamp="${todayNoonSec}">0d 01h 00m 00s</time>
              </div>
              <ul><li>TV</li><li>2026</li><li>8.33</li></ul>
            </article>
            <article class="lc-compact-anime-card"
              data-anime-item-id="13571"
              data-anime-item-romanized-native-title="Ranma1/2 3rd Season">
              <img class="lc-compact-anime-card__poster" src="https://u.livechart.me/anime/13571/poster.jpg" />
              <div class="lc-compact-anime-card__release-state">
                <div><strong>EP8</strong> · Dub, Sub - Netflix</div>
                <time data-timestamp="${todayNoonSec + 2 * 86400}">2d 00h 00m 00s</time>
              </div>
              <ul><li>TV</li><li>2026</li><li>7.82</li></ul>
            </article>
          </div>`,
      };
    },
  });

  assert.equal(res.status, 200);
  const body = res.body as {
    days: Array<{
      id: string;
      items: Array<{ title: string; scheduleMeta?: { serviceName?: string; hasDub: boolean; hasSub: boolean } }>;
    }>;
  };
  assert.ok(body.days.length >= 2);
  assert.equal(body.days[0].id, 'hoje');
  assert.equal(body.days[0].items[0].scheduleMeta?.serviceName, 'Crunchyroll');
  assert.ok(
    body.days.some((d) =>
      d.items.some(
        (item) =>
          item.title === 'Ranma1/2 3rd Season' &&
          item.scheduleMeta?.serviceName === 'Netflix' &&
          item.scheduleMeta?.hasDub === true
      )
    )
  );
});

test('routeNativeApiRequest hydrates TopAnimes /api/episode via doo_player_ajax fallback', async () => {
  const episodeHtml = `
    <html><body>
      <script>var dtAjax = {"url":"/wp-admin/admin-ajax.php","player_api":"https://topanimes.net/wp-json/dooplayer/v2/","play_method":"admin_ajax"};</script>
      <h1>Anime Demo - Episódio 1</h1>
      <ul id="playeroptionsul">
        <li class="dooplay_player_option" data-post="777" data-type="tv" data-nume="1"><span class="title">KojimaCDN</span></li>
        <li class="dooplay_player_option" data-post="777" data-type="tv" data-nume="2"><span class="title">Zuplay</span></li>
      </ul>
      <div id="source-player-1"><iframe src="https://topanimes.net/antivirus2/yes/?id=ep1"></iframe></div>
      <div id="source-player-2"></div>
    </body></html>`;

  const res = await routeNativeApiRequest(
    '/api/episode?url=https%3A%2F%2Ftopanimes.net%2Fepisodio%2Fanime-demo-episodio-1%2F',
    undefined,
    {
      fetchPage: async (targetUrl, opts) => {
        if (targetUrl.includes('/wp-admin/admin-ajax.php')) {
          assert.equal(opts?.method, 'POST');
          assert.ok(opts?.body?.includes('action=doo_player_ajax'));
          assert.ok(opts?.body?.includes('post=777'));
          assert.ok(opts?.body?.includes('nume=2'));
          return {
            status: 200,
            ok: true,
            finalUrl: targetUrl,
            body: JSON.stringify({
              embed_url: 'https://ru-boyceta.booonceivu.shop/?id=video/demo.mp4',
              type: 'iframe',
            }),
          };
        }
        return { status: 200, ok: true, finalUrl: targetUrl, body: episodeHtml };
      },
    }
  );

  assert.equal(res.status, 200);
  const body = res.body as {
    options: Array<{ nume: string; label: string; embedUrl: string; sourceId?: string }>;
  };
  assert.equal(body.options.length, 2);
  assert.equal(body.options[1].nume, '2');
  assert.equal(body.options[1].label, 'Zuplay');
  assert.equal(body.options[1].embedUrl, 'https://ru-boyceta.booonceivu.shop/?id=video/demo.mp4');
  assert.equal(body.options[1].sourceId, 'topanimes');
});

test('routeNativeApiRequest resolves canonical TheTVDB anisync://episode across integrated server', async () => {
  const res = await routeNativeApiRequest(
    '/api/episode',
    {
      method: 'POST',
      body: JSON.stringify({
        url: 'anisync://episode/anime/thetvdb/424536/s1/e2',
      }),
    },
    {
      fetchPage: async (targetUrl) => {
        if (targetUrl.includes('thetvdb.com/dereferrer/series/424536')) {
          return {
            status: 200,
            ok: true,
            finalUrl: 'https://www.thetvdb.com/series/sousou-no-frieren',
            body: `
              <html><body>
                <h1>Sousou no Frieren</h1>
                <div class="change_translation_text" data-language="pt" data-title="Sousou no Frieren"><p>Aventura de Frieren.</p></div>
                <ul id="series_basic_info">
                  <li><strong>TheTVDB.com Series ID</strong><span>424536</span></li>
                </ul>
              </body></html>`,
          };
        }
        if (targetUrl.includes('topanimes.net/?s=')) {
          return {
            status: 200,
            ok: true,
            finalUrl: targetUrl,
            body: `
              <div class="search-page">
                <div class="result-item">
                  <article>
                    <div class="details">
                      <div class="title"><a href="https://topanimes.net/animes/sousou-no-frieren/">Sousou no Frieren</a></div>
                    </div>
                  </article>
                </div>
              </div>`,
          };
        }
        if (targetUrl.includes('topanimes.net/animes/sousou-no-frieren/')) {
          return {
            status: 200,
            ok: true,
            finalUrl: targetUrl,
            body: `
              <html><body>
                <h1>Sousou no Frieren</h1>
                <div id="seasons">
                  <div class="se-c">
                    <div class="se-q"><span class="se-t">1</span><span class="title">Temporada 1</span></div>
                    <ul class="episodios">
                      <li>
                        <div class="numerando">1 - 2</div>
                        <div class="epnumber">2</div>
                        <div class="episodiotitle"><a href="https://topanimes.net/episodio/sousou-no-frieren-episodio-2/">Episódio 2</a></div>
                      </li>
                    </ul>
                  </div>
                </div>
              </body></html>`,
          };
        }
        if (targetUrl.includes('topanimes.net/episodio/sousou-no-frieren-episodio-2/')) {
          return {
            status: 200,
            ok: true,
            finalUrl: targetUrl,
            body: `
              <html><body>
                <h1>Sousou no Frieren — Episódio 2</h1>
                <ul id="playeroptionsul">
                  <li class="dooplay_player_option" data-post="500" data-type="tv" data-nume="1"><span class="title">KojimaCDN</span></li>
                </ul>
                <div id="source-player-1"><iframe src="https://topanimes.net/antivirus2/yes/?id=frieren-ep2"></iframe></div>
              </body></html>`,
          };
        }
        return { status: 404, ok: false, finalUrl: targetUrl, body: '' };
      },
    }
  );

  assert.equal(res.status, 200);
  const body = res.body as {
    isMovie: boolean;
    options: Array<{ embedUrl: string; sourceId?: string }>;
    sourceReports?: Array<{ sourceId: string; status: string }>;
  };
  assert.equal(body.isMovie, false);
  assert.equal(body.options.length, 1);
  assert.equal(body.options[0].embedUrl, 'https://topanimes.net/antivirus2/yes/?id=frieren-ep2');
  assert.equal(body.options[0].sourceId, 'topanimes');
  assert.equal(
    body.sourceReports?.find((r) => r.sourceId === 'topanimes')?.status,
    'found'
  );
});

test('routeNativeApiRequest serves Hinata Soul /api/anime, /api/episode, /api/resolve-embed, /api/search, and /api/sources/test', async () => {
  const fetchPage = async (targetUrl: string, opts?: { method?: string }) => {
    if (targetUrl === 'https://www.hinatasoul.com' || targetUrl === 'https://www.hinatasoul.com/') {
      return { status: 200, ok: true, finalUrl: targetUrl, body: '<html>OK</html>' };
    }
    if (targetUrl.includes('hinatasoul.com/busca?busca=')) {
      return {
        status: 200,
        ok: true,
        finalUrl: targetUrl,
        body: `
          <div class="ultimosAnimesHomeItem">
            <a href="https://www.hinatasoul.com/animes/sousou-no-frieren-2nd-season">
              <div class="ultimosAnimesHomeItemImg"><img src="https://www.hinatasoul.com/media/categories/video/frieren2.jpg" /></div>
              <div class="ultimosAnimesHomeItemInfos">
                <div class="ultimosAnimesHomeItemInfosNome">Sousou no Frieren 2nd Season</div>
              </div>
            </a>
          </div>`,
      };
    }
    if (targetUrl === 'https://www.hinatasoul.com/animes/sousou-no-frieren-2nd-season') {
      return {
        status: 200,
        ok: true,
        finalUrl: targetUrl,
        body: `
          <html><body>
            <div class="tituloPage"><h1>Sousou no Frieren 2nd Season</h1></div>
            <div class="mainSingle">
              <div class="left">
                <div class="aniInfosSingle">
                  <div class="aniInfosSingleCapa"><img src="https://www.hinatasoul.com/media/categories/video/frieren2.jpg" /></div>
                  <div class="aniInfosSingleNums"><div class="aniInfosSingleNumsItem"><b>Ano</b> 2026</div></div>
                  <div class="aniInfosSingleGeneros"><b>Gêneros</b><span>Fantasia</span></div>
                  <div class="aniInfosSingleSinopse"><b>Sinopse</b><p>Nova jornada de Frieren.</p></div>
                </div>
              </div>
              <div class="right"><div class="aniContainer">
                <div class="ultimosEpisodiosHomeItem">
                  <a href="/videos/538184" title="Sousou no Frieren 2nd Season ep 1">
                    <div class="ultimosEpisodiosHomeItemInfosNum">Episódio 01</div>
                  </a>
                </div>
              </div></div>
            </div>
          </body></html>`,
      };
    }
    if (targetUrl === 'https://www.hinatasoul.com/videos/538184') {
      return {
        status: 200,
        ok: true,
        finalUrl: targetUrl,
        body: `
          <html><body>
            <h1 class="epTituloNome">Sousou no Frieren 2nd Season ep 1</h1>
            <meta itemprop="contentURL" content="https://static.merceriadajoanasd21.online/iphonec/538184.mp4" />
            <div class="AbasBox">
              <div class="Aba active" data-target="0">SD</div>
              <div class="Aba" data-target="1">HD</div>
              <div class="Aba" data-target="2">FULLHD</div>
            </div>
            <div class="controlesBox">
              <div class="controlesBoxItem"><a href="https://www.hinatasoul.com/animes/sousou-no-frieren-2nd-season" title="Lista de Episódios">Lista</a></div>
            </div>
          </body></html>`,
      };
    }
    if (targetUrl === 'https://cdn.taboola.com/libtrc/unpkg/tfa.js') {
      return { status: 200, ok: true, finalUrl: targetUrl, body: 'a'.repeat(500) };
    }
    if (targetUrl.startsWith('https://ads.animeyabu.net/adblock2.php')) {
      if (opts?.method === 'POST') {
        return {
          status: 200,
          ok: true,
          finalUrl: targetUrl,
          body: JSON.stringify([{ ads: 'OK', publicidade: '?wmsAuthSign=testtok' }]),
        };
      }
      return {
        status: 200,
        ok: true,
        finalUrl: targetUrl,
        body: JSON.stringify([
          {
            ads: 'OK',
            publicidade:
              '?response-content-type=video%2Fmp4&X-Amz-Date=20261122T012517Z&X-Amz-Expires=3600&X-Amz-Signature=abc123',
          },
        ]),
      };
    }
    return { status: 404, ok: false, finalUrl: targetUrl, body: '' };
  };

  // 1. Search returns Hinata Soul titles
  const searchRes = await routeNativeApiRequest('/api/search?q=frieren', undefined, { fetchPage });
  assert.equal(searchRes.status, 200);
  const searchBody = searchRes.body as {
    results: Array<{ url: string; sourceServerName?: string }>;
  };
  assert.ok(
    searchBody.results.some(
      (r) =>
        r.url === 'https://www.hinatasoul.com/animes/sousou-no-frieren-2nd-season' &&
        r.sourceServerName === 'Hinata Soul'
    )
  );

  // 2. Anime details page
  const animeRes = await routeNativeApiRequest(
    '/api/anime?url=' +
      encodeURIComponent('https://www.hinatasoul.com/animes/sousou-no-frieren-2nd-season'),
    undefined,
    { fetchPage }
  );
  assert.equal(animeRes.status, 200);
  const animeBody = animeRes.body as {
    title: string;
    sourceServerName?: string;
    episodes: Array<{ url: string }>;
  };
  assert.equal(animeBody.title, 'Sousou no Frieren 2nd Season');
  assert.equal(animeBody.sourceServerName, 'Hinata Soul');
  assert.equal(animeBody.episodes[0].url, 'https://www.hinatasoul.com/videos/538184');

  // 3. Episode details page
  const epRes = await routeNativeApiRequest(
    '/api/episode?url=' + encodeURIComponent('https://www.hinatasoul.com/videos/538184'),
    undefined,
    { fetchPage }
  );
  assert.equal(epRes.status, 200);
  const epBody = epRes.body as {
    seriesUrl?: string;
    options: Array<{ embedUrl: string; sourceId?: string; providerKind: string }>;
  };
  assert.equal(epBody.seriesUrl, 'https://www.hinatasoul.com/animes/sousou-no-frieren-2nd-season');
  assert.equal(epBody.options[0].sourceId, 'hinatasoul');
  assert.equal(epBody.options[0].providerKind, 'hinatasoul');

  // 4. Resolve embed into Full HD / HD / SD MP4 streams
  const embedRes = await routeNativeApiRequest(
    '/api/resolve-embed?url=' + encodeURIComponent('https://www.hinatasoul.com/videos/538184'),
    undefined,
    { fetchPage }
  );
  assert.equal(embedRes.status, 200);
  const embedBody = embedRes.body as {
    status: string;
    provider: string;
    streams: Array<{ height: number; url: string; format: string }>;
  };
  assert.equal(embedBody.status, 'resolved');
  assert.equal(embedBody.provider, 'Hinata Soul');
  assert.equal(embedBody.streams.length, 3);
  assert.equal(embedBody.streams[0].height, 1080);
  assert.equal(embedBody.streams[0].format, 'mp4');

  // 5. /api/sources/test tests Hinata Soul specifically when requested
  const testRes = await routeNativeApiRequest(
    '/api/sources/test',
    {
      method: 'POST',
      body: JSON.stringify({ source: { id: 'hinatasoul', kind: 'hinatasoul' } }),
    },
    { fetchPage }
  );
  assert.equal(testRes.status, 200);
  const testBody = testRes.body as { ok: boolean; sourceId: string; sourceName: string };
  assert.equal(testBody.ok, true);
  assert.equal(testBody.sourceId, 'hinatasoul');
  assert.equal(testBody.sourceName, 'Hinata Soul');
});

test('POST /api/episode with deferCrossSources returns immediately without blocking on secondary source and reuses cached Hinata Soul episode HTML', async () => {
  const fetchedUrls: string[] = [];
  const fetchPage = async (targetUrl: string, opts?: { method?: string }) => {
    fetchedUrls.push(targetUrl);
    if (targetUrl === 'https://www.hinatasoul.com/videos/999001') {
      return {
        status: 200,
        ok: true,
        finalUrl: targetUrl,
        body: `
          <html><body>
            <h1 class="epTituloNome">Sousou no Frieren 2nd Season ep 1</h1>
            <meta itemprop="contentURL" content="https://static.merceriadajoanasd21.online/iphonec/999001.mp4" />
            <div class="AbasBox">
              <div class="Aba active" data-target="0">HD</div>
              <div class="Aba" data-target="1">FULLHD</div>
            </div>
            <div class="controlesBox">
              <div class="controlesBoxItem"><a href="https://www.hinatasoul.com/animes/sousou-no-frieren-2nd-season" title="Lista de Episódios">Lista</a></div>
            </div>
          </body></html>`,
      };
    }
    if (targetUrl === 'https://cdn.taboola.com/libtrc/unpkg/tfa.js') {
      return { status: 200, ok: true, finalUrl: targetUrl, body: 'a'.repeat(500) };
    }
    if (targetUrl.startsWith('https://ads.animeyabu.net/adblock2.php')) {
      if (opts?.method === 'POST') {
        return {
          status: 200,
          ok: true,
          finalUrl: targetUrl,
          body: JSON.stringify([{ ads: 'OK', publicidade: '?wmsAuthSign=tok' }]),
        };
      }
      return {
        status: 200,
        ok: true,
        finalUrl: targetUrl,
        body: JSON.stringify([
          {
            ads: 'OK',
            publicidade:
              '?response-content-type=video%2Fmp4&X-Amz-Date=20261122T012517Z&X-Amz-Expires=3600&X-Amz-Signature=sig',
          },
        ]),
      };
    }
    return { status: 404, ok: false, finalUrl: targetUrl, body: '' };
  };

  // 1. Fast episode open should NOT touch topanimes.net at all
  const epRes = await routeNativeApiRequest(
    '/api/episode',
    {
      method: 'POST',
      body: JSON.stringify({
        url: 'https://www.hinatasoul.com/videos/999001',
        deferCrossSources: true,
      }),
    },
    { fetchPage }
  );
  assert.equal(epRes.status, 200);
  const epBody = epRes.body as {
    options: Array<{ sourceId?: string }>;
    sourceReports?: Array<{ sourceId: string }>;
  };
  assert.equal(epBody.options.length, 1);
  assert.equal(epBody.options[0].sourceId, 'hinatasoul');
  assert.equal(epBody.sourceReports?.length, 1);
  assert.equal(
    fetchedUrls.some((u) => u.includes('topanimes.net')),
    false,
    'deferCrossSources must not block on TopAnimes search'
  );

  // 2. Subsequent /api/resolve-embed reuses cached Hinata Soul episode page (only 1 GET of /videos/999001)
  const embedRes = await routeNativeApiRequest(
    '/api/resolve-embed?url=' + encodeURIComponent('https://www.hinatasoul.com/videos/999001'),
    undefined,
    { fetchPage }
  );
  assert.equal(embedRes.status, 200);
  const embedBody = embedRes.body as { status: string; streams: Array<{ height: number }> };
  assert.equal(embedBody.status, 'resolved');
  assert.equal(embedBody.streams.length, 2);
  const videoPageFetches = fetchedUrls.filter(
    (u) => u === 'https://www.hinatasoul.com/videos/999001'
  );
  assert.equal(videoPageFetches.length, 1, 'must not re-download Hinata Soul episode HTML');
});

test('dispatchAnisyncApiRequest coalesces parallel stage=quick and fast=1 /api/media requests and skips synchronous episode page scrapes', async () => {
  clearAnisyncRouterCaches();
  const fetchedUrls: string[] = [];
  const animeHtml = `
    <html><body>
      <div class="sheader">
        <div class="poster"><img src="https://img.example.org/demo.jpg" /></div>
        <div class="data"><h1>Solo Demo</h1><div class="extra"><span class="date">2025</span></div></div>
      </div>
      <div id="info"><div class="wp-content"><p>Sinopse base do servidor.</p></div></div>
      <div id="seasons">
        <div class="se-c">
          <div class="se-q"><span class="se-t">1</span></div>
          <ul class="episodios">
            <li>
              <div class="numerando">1 - 1</div>
              <div class="episodiotitle"><a href="https://topanimes.net/episodio/solo-demo-episodio-1/">Episódio 1</a></div>
            </li>
          </ul>
        </div>
      </div>
    </body></html>`;

  const fetchHttp = async (targetUrl: string) => {
    fetchedUrls.push(targetUrl);
    if (targetUrl === 'https://topanimes.net/animes/solo-demo/') {
      await new Promise((r) => setTimeout(r, 15));
      return { status: 200, ok: true, finalUrl: targetUrl, body: animeHtml };
    }
    if (targetUrl.includes('api4.thetvdb.com/web/search/queries')) {
      return {
        status: 200,
        ok: true,
        finalUrl: targetUrl,
        body: JSON.stringify({
          results: [
            {
              hits: [
                {
                  id: '555123',
                  objectID: 'series-555123',
                  type: 'series',
                  slug: 'solo-demo',
                  name: 'Solo Demo',
                  year: '2025',
                  country: 'jpn',
                  primary_language: 'jpn',
                  translations: { pt: 'Solo Demo', eng: 'Solo Demo' },
                  overviews: { pt: 'Sinopse oficial em PT-BR' },
                },
              ],
            },
          ],
        }),
      };
    }
    if (targetUrl.includes('thetvdb.com/series/solo-demo/allseasons/official')) {
      return {
        status: 200,
        ok: true,
        finalUrl: targetUrl,
        body: `
          <ul class="list-group">
            <li class="list-group-item">
              <h4>
                <span class="episode-label">S01E01</span>
                <a href="/series/solo-demo/episodes/777111">First Episode EN</a>
              </h4>
            </li>
          </ul>`,
      };
    }
    if (targetUrl.includes('thetvdb.com/series/solo-demo') || targetUrl.includes('thetvdb.com/dereferrer/series/555123')) {
      return {
        status: 200,
        ok: true,
        finalUrl: 'https://www.thetvdb.com/series/solo-demo',
        body: `
          <html>
            <head><title>Solo Demo - TheTVDB.com</title></head>
            <body>
              <h1>Solo Demo</h1>
              <div class="change_translation_text" data-language="pt" data-title="Solo Demo"><p>Sinopse oficial em PT-BR</p></div>
              <ul id="series_basic_info">
                <li><strong>TheTVDB.com Series ID</strong><span>555123</span></li>
              </ul>
            </body>
          </html>`,
      };
    }
    return { status: 404, ok: false, finalUrl: targetUrl, body: '' };
  };

  try {
    const encoded = encodeURIComponent('https://topanimes.net/animes/solo-demo/');
    const [quickRes, fullRes] = await Promise.all([
      dispatchAnisyncApiRequest(
        `/api/media?url=${encoded}&stage=quick`,
        { method: 'GET' },
        { fetchHttp, serviceName: 'test', useCache: true }
      ),
      dispatchAnisyncApiRequest(
        `/api/media?url=${encoded}&fast=1`,
        { method: 'GET' },
        { fetchHttp, serviceName: 'test', useCache: true }
      ),
    ]);

    assert.equal(quickRes.status, 200);
    assert.equal(fullRes.status, 200);

    const quickBody = quickRes.body as { title: string; episodes: Array<{ url: string }> };
    const fullBody = fullRes.body as {
      title: string;
      synopsis: string;
      episodes: Array<{ tvdbEpisodeId?: number }>;
    };
    assert.equal(quickBody.title, 'Solo Demo');
    assert.equal(quickBody.episodes.length, 1);
    assert.equal(fullBody.synopsis, 'Sinopse oficial em PT-BR');
    assert.equal(fullBody.episodes[0].tvdbEpisodeId, 777111);

    // Parallel quick + full must coalesce into a single TopAnimes anime HTML request
    const animePageHits = fetchedUrls.filter(
      (u) => u === 'https://topanimes.net/animes/solo-demo/'
    );
    assert.equal(animePageHits.length, 1, 'stage=quick and fast=1 must coalesce raw server HTML fetch');

    // fast=1 must NOT scrape individual TheTVDB episode pages synchronously
    assert.equal(
      fetchedUrls.some((u) => u.includes('/episodes/777111')),
      false,
      'fast=1 must defer individual TheTVDB episode page fetches to client /api/episode-titles'
    );

    // Subsequent stage=quick should immediately return the already-cached enriched result
    const warmQuick = await dispatchAnisyncApiRequest(
      `/api/media?url=${encoded}&stage=quick`,
      { method: 'GET' },
      { fetchHttp, serviceName: 'test', useCache: true }
    );
    assert.equal((warmQuick.body as { synopsis: string }).synopsis, 'Sinopse oficial em PT-BR');
  } finally {
    clearAnisyncRouterCaches();
  }
});

test('dispatchAnisyncApiRequest coalesces Hinata Soul homepage between /api/home and /api/episodes and caches /api/catalog', async () => {
  clearAnisyncRouterCaches();
  const fetchedUrls: string[] = [];
  const topHomeHtml = `
    <html><body>
      <div id="dt-tvshows">
        <article class="item"><div class="poster"><img src="https://img.example.org/a.jpg" /></div>
          <div class="data"><h3><a href="https://topanimes.net/animes/alpha/">Alpha</a></h3></div>
        </article>
      </div>
      <article class="item se episodes">
        <div class="poster"><img src="https://img.example.org/e.jpg" alt="Alpha" /></div>
        <div class="data"><a href="https://topanimes.net/episodio/alpha-episodio-1/"><h3>Episódio 1</h3><span class="serie">Alpha</span></a></div>
      </article>
    </body></html>`;

  const topArchiveHtml = `
    <html><body>
      <div class="items normal">
        <article class="item tvshows"><div class="poster"><img src="https://img.example.org/a.jpg" /></div>
          <div class="data"><h3><a href="https://topanimes.net/animes/alpha/">Alpha</a></h3></div>
        </article>
      </div>
      <div class="pagination"><span>Página 1 de 3</span></div>
    </body></html>`;

  const hinataHomeHtml = `
    <html><body>
      <div class="ultimosEpisodiosHomeItem">
        <a href="https://www.hinatasoul.com/videos/1001" title="Beta Episódio 1">
          <img src="https://img.example.org/beta.jpg" />
          <div class="ultimosEpisodiosHomeItemInfosNome">Beta</div>
          <div class="ultimosEpisodiosHomeItemInfosNum">Episódio 1</div>
        </a>
      </div>
    </body></html>`;

  const fetchHttp = async (targetUrl: string) => {
    fetchedUrls.push(targetUrl);
    if (targetUrl === 'https://www.hinatasoul.com/' || targetUrl === 'https://www.hinatasoul.com') {
      await new Promise((r) => setTimeout(r, 15));
      return { status: 200, ok: true, finalUrl: targetUrl, body: hinataHomeHtml };
    }
    if (targetUrl === 'https://topanimes.net/' || targetUrl === 'https://topanimes.net') {
      return { status: 200, ok: true, finalUrl: targetUrl, body: topHomeHtml };
    }
    if (targetUrl.startsWith('https://topanimes.net/episodio/')) {
      return { status: 200, ok: true, finalUrl: targetUrl, body: topHomeHtml };
    }
    if (targetUrl.startsWith('https://topanimes.net/animes/')) {
      return { status: 200, ok: true, finalUrl: targetUrl, body: topArchiveHtml };
    }
    return { status: 404, ok: false, finalUrl: targetUrl, body: '' };
  };

  try {
    const [homeRes, epsRes] = await Promise.all([
      dispatchAnisyncApiRequest(
        '/api/home',
        { method: 'GET' },
        { fetchHttp, serviceName: 'test', useCache: true }
      ),
      dispatchAnisyncApiRequest(
        '/api/episodes?page=1',
        { method: 'GET' },
        { fetchHttp, serviceName: 'test', useCache: true }
      ),
    ]);
    assert.equal(homeRes.status, 200);
    assert.equal(epsRes.status, 200);

    const hinataHomeHits = fetchedUrls.filter((u) => u.startsWith('https://www.hinatasoul.com'));
    assert.equal(
      hinataHomeHits.length,
      1,
      'parallel /api/home and /api/episodes?page=1 must share a single Hinata Soul home request'
    );

    // First /api/catalog hits upstream; second hits router TTL cache cleanly
    const cat1 = await dispatchAnisyncApiRequest(
      '/api/catalog?category=animes&page=1',
      { method: 'GET' },
      { fetchHttp, serviceName: 'test', useCache: true }
    );
    const hitsAfterFirst = fetchedUrls.filter((u) => u.startsWith('https://topanimes.net/animes/')).length;
    const cat2 = await dispatchAnisyncApiRequest(
      '/api/catalog?category=animes&page=1',
      { method: 'GET' },
      { fetchHttp, serviceName: 'test', useCache: true }
    );
    const hitsAfterSecond = fetchedUrls.filter((u) => u.startsWith('https://topanimes.net/animes/')).length;

    assert.equal(cat1.status, 200);
    assert.equal(cat2.status, 200);
    assert.equal(hitsAfterFirst, 1);
    assert.equal(hitsAfterSecond, 1, 'second /api/catalog request must be served from router cache');
  } finally {
    clearAnisyncRouterCaches();
  }
});

