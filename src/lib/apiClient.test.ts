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

