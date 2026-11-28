import test from 'node:test';
import assert from 'node:assert/strict';
import type { HttpFetcher } from '../httpTypes';
import {
  createProviderIndexStore,
  parseSitemapXmlEntries,
  parseTopAnimesSitemapUrl,
} from './providerIndex';

test('parseSitemapXmlEntries extracts loc and lastmod including CDATA and XML entities', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
  <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url>
      <loc>https://topanimes.net/animes/sousou-no-frieren/</loc>
      <lastmod>2026-03-10T12:00:00+00:00</lastmod>
    </url>
    <url>
      <loc><![CDATA[https://topanimes.net/animes/sousou-no-frieren-dublado/]]></loc>
    </url>
    <url>
      <loc>https://topanimes.net/filmes/kimi-no-na-wa/?a=1&amp;b=2</loc>
    </url>
  </urlset>`;

  const entries = parseSitemapXmlEntries(xml);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].loc, 'https://topanimes.net/animes/sousou-no-frieren/');
  assert.equal(entries[0].lastmod, '2026-03-10T12:00:00+00:00');
  assert.equal(entries[1].loc, 'https://topanimes.net/animes/sousou-no-frieren-dublado/');
  assert.equal(entries[2].loc, 'https://topanimes.net/filmes/kimi-no-na-wa/?a=1&b=2');
});

test('parseTopAnimesSitemapUrl classifies LEG, DUB, movies, and ignores archive roots', () => {
  assert.equal(parseTopAnimesSitemapUrl('https://topanimes.net/animes/'), null);
  assert.equal(parseTopAnimesSitemapUrl('https://topanimes.net/filmes/'), null);
  assert.equal(parseTopAnimesSitemapUrl('https://topanimes.net/episodio/naruto-ep-1/'), null);

  const leg = parseTopAnimesSitemapUrl('https://topanimes.net/animes/sousou-no-frieren/');
  assert.ok(leg);
  assert.equal(leg.kind, 'anime');
  assert.equal(leg.audioType, 'LEG');
  assert.equal(leg.normalizedTitle, 'sousou no frieren');

  const dub = parseTopAnimesSitemapUrl('https://topanimes.net/animes/sousou-no-frieren-dublado/');
  assert.ok(dub);
  assert.equal(dub.kind, 'anime');
  assert.equal(dub.audioType, 'DUB');
  assert.equal(dub.normalizedTitle, 'sousou no frieren');

  const jp = parseTopAnimesSitemapUrl('https://topanimes.net/animes/one-piece-dub-japones/');
  assert.ok(jp);
  assert.equal(jp.audioType, 'LEG');
  assert.equal(jp.normalizedTitle, 'one piece');

  const movie = parseTopAnimesSitemapUrl('https://topanimes.net/filmes/suzume-no-tojimari-dublado/');
  assert.ok(movie);
  assert.equal(movie.kind, 'movie');
  assert.equal(movie.audioType, 'DUB');
  assert.equal(movie.normalizedTitle, 'suzume no tojimari');
});

test('ProviderIndexStore loads sitemaps sequentially, merges LEG/DUB, and stops on 429', async () => {
  const store = createProviderIndexStore();
  const requestedUrls: string[] = [];

  const mockFetch: HttpFetcher = async (url) => {
    requestedUrls.push(url);
    if (url.endsWith('/tvshows-sitemap1.xml')) {
      return {
        status: 200,
        ok: true,
        finalUrl: url,
        body: `<urlset>
          <url><loc>https://topanimes.net/animes/jujutsu-kaisen/</loc></url>
          <url><loc>https://topanimes.net/animes/jujutsu-kaisen-dublado/</loc></url>
          <url><loc>https://topanimes.net/animes/monster-musume-no-iru-nichijou/</loc></url>
        </urlset>`,
      };
    }
    if (url.endsWith('/movies-sitemap.xml')) {
      return {
        status: 200,
        ok: true,
        finalUrl: url,
        body: `<urlset>
          <url><loc>https://topanimes.net/filmes/kimi-no-na-wa/</loc></url>
        </urlset>`,
      };
    }
    return { status: 404, ok: false, finalUrl: url, body: '' };
  };

  const stats = await store.ensureLoaded(mockFetch, { delayMs: 0 });
  assert.equal(stats.sourceMode, 'live');
  assert.equal(stats.totalEntries, 3);
  assert.deepEqual(requestedUrls, [
    'https://topanimes.net/tvshows-sitemap1.xml',
    'https://topanimes.net/movies-sitemap.xml',
  ]);

  // Exact match with both LEG and DUB
  const jjk = store.matchTitles({
    titles: ['Jujutsu Kaisen 2nd Season', 'Sorcery Fight'],
    mediaKind: 'anime',
  });
  assert.equal(jjk.available, true);
  assert.equal(jjk.hasLeg, true);
  assert.equal(jjk.hasDub, true);
  assert.equal(jjk.legUrl, 'https://topanimes.net/animes/jujutsu-kaisen/');
  assert.equal(jjk.dubUrl, 'https://topanimes.net/animes/jujutsu-kaisen-dublado/');

  // Audio filter DUB vs LEG
  const movieDub = store.matchTitles({
    titles: ['Kimi no Na wa.', 'Your Name.'],
    mediaKind: 'movie',
    audioFilter: 'DUB',
  });
  assert.equal(movieDub.hasLeg, true);
  assert.equal(movieDub.hasDub, false);
  assert.equal(movieDub.available, false);

  // False-positive guard: "Monster" must NOT match "Monster Musume no Iru Nichijou"
  const monster = store.matchTitles({
    titles: ['Monster'],
    mediaKind: 'anime',
  });
  assert.equal(monster.available, false);

  // Rate-limit (429) aborts immediately without requesting movies-sitemap.xml
  const rlStore = createProviderIndexStore();
  const rlCalls: string[] = [];
  const rlFetch: HttpFetcher = async (url) => {
    rlCalls.push(url);
    return { status: 429, ok: false, finalUrl: url, body: '' };
  };
  await rlStore.ensureLoaded(rlFetch, { delayMs: 0 });
  assert.deepEqual(rlCalls, ['https://topanimes.net/tvshows-sitemap1.xml']);
});

test('ProviderIndexStore passively indexes HinataSoul anime titles while ignoring episode URLs', () => {
  const store = createProviderIndexStore();
  const added = store.registerPassiveItems([
    {
      title: 'Dandadan Dublado',
      url: 'https://www.hinatasoul.com/animes/dandadan-dublado',
      kind: 'anime',
      audioType: 'DUB',
      sourceServerName: 'Hinata Soul',
    },
    {
      title: 'Dandadan Episódio 1',
      url: 'https://www.hinatasoul.com/videos/123456/',
      kind: 'episode',
      audioType: 'LEG',
      sourceServerName: 'Hinata Soul',
    },
  ]);

  assert.equal(added, 1);
  const match = store.matchTitles({
    titles: ['Dandadan', 'DAN DA DAN'],
    mediaKind: 'anime',
    audioFilter: 'DUB',
  });
  assert.equal(match.available, true);
  assert.equal(match.hasDub, true);
  assert.equal(match.dubUrl, 'https://www.hinatasoul.com/animes/dandadan-dublado');
  assert.deepEqual(match.providerNames, ['Hinata Soul']);
});
