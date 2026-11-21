import test from 'node:test';
import assert from 'node:assert/strict';
import { routeNativeApiRequest } from './apiClient';

test('routeNativeApiRequest validates /api/anime and /api/episode topanimes.net URLs', async () => {
  const animeBad = await routeNativeApiRequest('/api/anime?url=https://example.com/foo', undefined);
  assert.equal(animeBad.status, 400);

  const epBad = await routeNativeApiRequest('/api/episode?url=http://127.0.0.1/test', undefined);
  assert.equal(epBad.status, 400);

  const embedBad = await routeNativeApiRequest('/api/resolve-embed', undefined);
  assert.equal(embedBad.status, 400);
});

test('routeNativeApiRequest handles /api/home and /api/search with mocked page fetcher', async () => {
  const sampleHtml = `
    <html><body>
      <div class="episodes">
        <article class="item">
          <div class="poster"><img src="https://topanimes.net/poster.jpg" /></div>
          <div class="data"><h3><a href="https://topanimes.net/episodio/frieren-episodio-1/">Frieren — Episódio 1</a></h3></div>
        </article>
      </div>
    </body></html>
  `;

  const home = await routeNativeApiRequest('/api/home', undefined, {
    fetchPage: async () => ({
      status: 200,
      ok: true,
      finalUrl: 'https://topanimes.net/',
      body: sampleHtml,
    }),
    readSnapshot: async () => sampleHtml,
  });
  assert.equal(home.status, 200);

  const emptySearch = await routeNativeApiRequest('/api/search?q=', undefined);
  assert.equal(emptySearch.status, 200);
  assert.deepEqual((emptySearch.body as { results: unknown[] }).results, []);
});

test('routeNativeApiRequest returns health check and safe fallback on /api/apk-info', async () => {
  const health = await routeNativeApiRequest('/api/health', undefined);
  assert.equal(health.status, 200);
  assert.equal((health.body as { ok: boolean }).ok, true);

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
        name: 'TopAnimes Android APK',
        html_url: 'https://github.com/Martin01683/Aplicativo-de-animes/releases/tag/latest-apk',
        published_at: '2026-11-21T02:11:00Z',
        updated_at: '2026-11-21T02:42:12Z',
        body: 'Build automático (7ea7c809c1317142fa6c3aa4818e9716afbfe30c).',
        assets: [
          {
            name: 'TopAnimes.apk',
            size: 92044913,
            updated_at: '2026-11-21T02:42:11Z',
            browser_download_url:
              'https://github.com/Martin01683/Aplicativo-de-animes/releases/download/latest-apk/TopAnimes.apk',
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
  assert.equal(body.release?.apkAsset?.name, 'TopAnimes.apk');
});

test('routeNativeApiRequest serves /api/calendar weekly sections from /calendario/', async () => {
  const calHtml = `
    <div id="archive-content">
      <header><h2>Calendário de Hoje</h2></header>
      <div class="items featured">
        <article class="item tvshows">
          <div class="poster"><img src="https://image.tmdb.org/t/p/w185/a.jpg" alt="Dreamland" /><div class="rating">8.1</div></div>
          <div class="data"><h3><a href="https://topanimes.net/animes/dreamland/">Dreamland</a></h3><span>2026</span></div>
        </article>
      </div>
      <header><h2>Domingo</h2></header>
      <div class="items featured">
        <article class="item tvshows">
          <div class="poster"><img src="https://image.tmdb.org/t/p/w185/b.jpg" alt="One Piece" /></div>
          <div class="data"><h3><a href="https://topanimes.net/animes/one-piece/">One Piece</a></h3><span>1999</span></div>
        </article>
      </div>
    </div>`;

  const res = await routeNativeApiRequest('/api/calendar', undefined, {
    fetchPage: async () => ({
      status: 200,
      ok: true,
      finalUrl: 'https://topanimes.net/calendario/',
      body: calHtml,
    }),
  });

  assert.equal(res.status, 200);
  const body = res.body as { days: Array<{ id: string; items: Array<{ title: string }> }> };
  assert.equal(body.days.length, 2);
  assert.equal(body.days[0].id, 'hoje');
  assert.equal(body.days[1].id, 'domingo');
  assert.equal(body.days[1].items[0].title, 'One Piece');
});

test('routeNativeApiRequest serves /api/search-suggest and /api/glossary using DooPlay nonce', async () => {
  const homeHtml = `<script>var dtGonza = {"nonce":"abc12345"};</script>`;

  const suggestRes = await routeNativeApiRequest('/api/search-suggest?q=frieren', undefined, {
    fetchPage: async (targetUrl) => {
      if (targetUrl.includes('/wp-json/dooplay/search/')) {
        assert.ok(targetUrl.includes('keyword=frieren'));
        assert.ok(targetUrl.includes('nonce=abc12345'));
        return {
          status: 200,
          ok: true,
          finalUrl: targetUrl,
          body: JSON.stringify({
            '1': {
              title: 'Sousou no Frieren',
              url: 'https://topanimes.net/animes/sousou-no-frieren/',
              img: 'https://image.tmdb.org/t/p/w92/f.jpg',
              extra: { date: '2023', imdb: '9.1' },
            },
          }),
        };
      }
      return { status: 200, ok: true, finalUrl: targetUrl, body: homeHtml };
    },
  });

  assert.equal(suggestRes.status, 200);
  const suggestBody = suggestRes.body as {
    sourceMode: string;
    results: Array<{ title: string; rating?: string }>;
  };
  assert.equal(suggestBody.sourceMode, 'live');
  assert.equal(suggestBody.results[0].title, 'Sousou no Frieren');
  assert.equal(suggestBody.results[0].rating, '9.1');

  const glossaryBad = await routeNativeApiRequest('/api/glossary?term=invalid', undefined);
  assert.equal(glossaryBad.status, 400);

  const glossaryRes = await routeNativeApiRequest('/api/glossary?term=%23&type=tvshows', undefined, {
    fetchPage: async (targetUrl) => {
      if (targetUrl.includes('/wp-json/dooplay/glossary/')) {
        assert.ok(targetUrl.includes('term=09'));
        assert.ok(targetUrl.includes('type=tvshows'));
        return {
          status: 200,
          ok: true,
          finalUrl: targetUrl,
          body: JSON.stringify({
            '1': {
              title: '86 Eighty-Six',
              url: 'https://topanimes.net/animes/86-eighty-six/',
              img: 'https://image.tmdb.org/t/p/w185/86.jpg',
              year: '2021',
              imdb: '8.5',
            },
          }),
        };
      }
      return { status: 200, ok: true, finalUrl: targetUrl, body: homeHtml };
    },
  });

  assert.equal(glossaryRes.status, 200);
  const glossaryBody = glossaryRes.body as {
    term: string;
    items: Array<{ title: string; rating?: string }>;
  };
  assert.equal(glossaryBody.term, '#');
  assert.equal(glossaryBody.items[0].title, '86 Eighty-Six');
  assert.equal(glossaryBody.items[0].rating, '8.5');
});

test('routeNativeApiRequest hydrates missing /api/episode servers via doo_player_ajax fallback', async () => {
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
  const body = res.body as { options: Array<{ nume: string; label: string; embedUrl: string }> };
  assert.equal(body.options.length, 2);
  assert.equal(body.options[1].nume, '2');
  assert.equal(body.options[1].label, 'Zuplay');
  assert.equal(body.options[1].embedUrl, 'https://ru-boyceta.booonceivu.shop/?id=video/demo.mp4');
});

