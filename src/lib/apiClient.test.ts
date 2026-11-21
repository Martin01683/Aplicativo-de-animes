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
