import test from 'node:test';
import assert from 'node:assert/strict';
import type { HttpFetcher } from './httpTypes';
import {
  DEFAULT_EPISODE_SOURCES,
  HINATASOUL_BUILTIN_SOURCE,
  TOPANIMES_BUILTIN_SOURCE,
  sanitizeEpisodeSources,
  type EpisodeSourceLookupQuery,
} from './sources/types';
import {
  aggregateEpisodeServers,
  resolveEmbedByUrl,
  resolveServerOptionToStreams,
  testEpisodeSource,
} from './sources/sourceAggregator';
import {
  clearHinataSoulCaches,
  resolveFromHinataSoulSource,
} from './sources/providers/hinatasoulSource';
import { resolveFromTopAnimesSource } from './sources/providers/topanimesSource';

test('sanitizeEpisodeSources always returns the active built-in TopAnimes and Hinata Soul servers', () => {
  const defaults = sanitizeEpisodeSources(null);
  assert.equal(defaults.length, DEFAULT_EPISODE_SOURCES.length);
  assert.equal(defaults.length, 2);
  assert.equal(defaults[0].id, 'topanimes');
  assert.equal(defaults[0].enabled, true);
  assert.equal(defaults[0].builtIn, true);
  assert.equal(defaults[1].id, 'hinatasoul');
  assert.equal(defaults[1].enabled, true);
  assert.equal(defaults[1].builtIn, true);
});

test('TopAnimes works strictly as the integrated episode server source via title + episode matching', async () => {
  const mockFetcher: HttpFetcher = async (url) => {
    if (url.includes('/?s=')) {
      return {
        status: 200,
        ok: true,
        finalUrl: url,
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
    if (url.includes('/animes/sousou-no-frieren/')) {
      return {
        status: 200,
        ok: true,
        finalUrl: url,
        body: `
          <html><body>
            <h1>Sousou no Frieren</h1>
            <div id="seasons">
              <div class="se-c">
                <div class="se-q"><span class="se-t">1</span><span class="title">Temporada 1</span></div>
                <ul class="episodios">
                  <li>
                    <div class="numerando">1 - 1</div>
                    <div class="epnumber">1</div>
                    <div class="episodiotitle"><a href="https://topanimes.net/episodio/sousou-no-frieren-episodio-1/">Episódio 1</a></div>
                  </li>
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
    if (url.includes('/episodio/sousou-no-frieren-episodio-2/')) {
      return {
        status: 200,
        ok: true,
        finalUrl: url,
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
    return { status: 404, ok: false, finalUrl: url, body: '' };
  };

  const query: EpisodeSourceLookupQuery = {
    title: 'Sousou no Frieren',
    mediaType: 'anime',
    seasonNumber: 1,
    episodeNumber: 2,
    externalIds: { tvdbId: 424536 },
  };

  const res = await resolveFromTopAnimesSource(mockFetcher, TOPANIMES_BUILTIN_SOURCE, query);
  assert.equal(res.options.length, 1);
  assert.equal(res.options[0].sourceId, 'topanimes');
  assert.equal(res.options[0].embedUrl, 'https://topanimes.net/antivirus2/yes/?id=frieren-ep2');
  assert.ok(res.options[0].label.includes('TopAnimes'));
});

test('aggregateEpisodeServers, resolveServerOptionToStreams, and testEpisodeSource work end-to-end', async () => {
  const mockFetcher: HttpFetcher = async (url) => {
    if (url === 'https://topanimes.net' || url === 'https://topanimes.net/') {
      return { status: 200, ok: true, finalUrl: url, body: '<html>OK</html>' };
    }
    if (url.includes('/?s=')) {
      return {
        status: 200,
        ok: true,
        finalUrl: url,
        body: `
          <div class="search-page">
            <div class="result-item">
              <article>
                <div class="details">
                  <div class="title"><a href="https://topanimes.net/filmes/suzume/">Suzume</a></div>
                </div>
              </article>
            </div>
          </div>`,
      };
    }
    if (url.includes('/filmes/suzume/')) {
      return {
        status: 200,
        ok: true,
        finalUrl: url,
        body: `
          <html><body>
            <h1>Suzume</h1>
            <ul id="playeroptionsul">
              <li class="dooplay_player_option" data-post="900" data-type="movie" data-nume="1"><span class="title">KojimaCDN</span></li>
            </ul>
            <div id="source-player-1"><iframe src="https://topanimes.net/antivirus2/yes/?id=suzume"></iframe></div>
          </body></html>`,
      };
    }
    return { status: 404, ok: false, finalUrl: url, body: '' };
  };

  const agg = await aggregateEpisodeServers(mockFetcher, {
    title: 'Suzume',
    mediaType: 'movie',
  });
  assert.equal(agg.options.length, 1);
  assert.equal(agg.reports.length, 2);
  assert.equal(agg.reports[0].sourceId, 'topanimes');
  assert.equal(agg.reports[0].status, 'found');
  assert.equal(agg.reports[1].sourceId, 'hinatasoul');
  assert.equal(agg.reports[1].status, 'not-found');

  // Direct stream short-circuits without extra HTTP requests
  const resolved = await resolveServerOptionToStreams(
    async () => {
      throw new Error('Should not fetch for direct streams');
    },
    {
      label: 'TopAnimes · KojimaCDN',
      embedUrl: 'https://cdn.example.org/movie.m3u8',
      directStreamUrl: 'https://cdn.example.org/movie.m3u8',
    }
  );
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.streams[0].url, 'https://cdn.example.org/movie.m3u8');
  assert.equal(resolved.streams[0].format, 'hls');

  // Connection test for integrated TopAnimes server
  const testRes = await testEpisodeSource(mockFetcher, TOPANIMES_BUILTIN_SOURCE);
  assert.equal(testRes.ok, true);
  assert.ok(testRes.message.includes('Conexão OK'));
});

test('Hinata Soul resolves Season 2 (LEG + DUB) and signs Full HD / HD / SD R2 streams', async () => {
  clearHinataSoulCaches();
  const mockFetcher: HttpFetcher = async (url, opts) => {
    if (url === 'https://www.hinatasoul.com' || url === 'https://www.hinatasoul.com/') {
      return { status: 200, ok: true, finalUrl: url, body: '<html>Hinata Soul OK</html>' };
    }
    if (url.includes('hinatasoul.com/busca?busca=')) {
      return {
        status: 200,
        ok: true,
        finalUrl: url,
        body: `
          <div class="ultimosAnimesHomeItem">
            <a href="https://www.hinatasoul.com/animes/5f7d55809b35178f5be64480dadf57fe89362c08">
              <div class="ultimosAnimesHomeItemInfos"><div class="ultimosAnimesHomeItemInfosNome">Sousou no Frieren</div></div>
            </a>
          </div>
          <div class="ultimosAnimesHomeItem">
            <a href="https://www.hinatasoul.com/animes/sousou-no-frieren-2nd-season">
              <div class="ultimosAnimesHomeItemInfos"><div class="ultimosAnimesHomeItemInfosNome">Sousou no Frieren 2nd Season</div></div>
            </a>
          </div>
          <div class="ultimosAnimesHomeItem">
            <a href="https://www.hinatasoul.com/anime-dublado/sousou-no-frieren-2nd-season-dublado">
              <div class="ultimosAnimesHomeItemInfos"><div class="ultimosAnimesHomeItemInfosNome">Sousou no Frieren 2nd Season - Dublado</div></div>
            </a>
          </div>`,
      };
    }
    if (url === 'https://www.hinatasoul.com/animes/sousou-no-frieren-2nd-season') {
      return {
        status: 200,
        ok: true,
        finalUrl: url,
        body: `
          <div class="tituloPage"><h1>Sousou no Frieren 2nd Season</h1></div>
          <div class="mainSingle"><div class="right"><div class="aniContainer">
            <div class="ultimosEpisodiosHomeItem">
              <a href="/videos/538184" title="Sousou no Frieren 2nd Season ep 1">
                <div class="ultimosEpisodiosHomeItemInfosNum">Episódio 01</div>
              </a>
            </div>
            <div class="ultimosEpisodiosHomeItem">
              <a href="/videos/538568" title="Sousou no Frieren 2nd Season ep 2">
                <div class="ultimosEpisodiosHomeItemInfosNum">Episódio 02</div>
              </a>
            </div>
          </div></div></div>`,
      };
    }
    if (url === 'https://www.hinatasoul.com/anime-dublado/sousou-no-frieren-2nd-season-dublado') {
      return {
        status: 200,
        ok: true,
        finalUrl: url,
        body: `
          <div class="tituloPage"><h1>Sousou no Frieren 2nd Season - Dublado</h1></div>
          <div class="mainSingle"><div class="right"><div class="aniContainer">
            <div class="ultimosEpisodiosHomeItem">
              <a href="/videos/542597" title="Sousou no Frieren 2nd Season - Dublado ep 1">
                <div class="ultimosEpisodiosHomeItemInfosNum">Episódio 01</div>
              </a>
            </div>
            <div class="ultimosEpisodiosHomeItem">
              <a href="/videos/543000" title="Sousou no Frieren 2nd Season - Dublado ep 2">
                <div class="ultimosEpisodiosHomeItemInfosNum">Episódio 02</div>
              </a>
            </div>
          </div></div></div>`,
      };
    }
    if (url === 'https://www.hinatasoul.com/videos/538568') {
      return {
        status: 200,
        ok: true,
        finalUrl: url,
        body: `
          <html><body>
            <h1 class="epTituloNome">Sousou no Frieren 2nd Season ep 2</h1>
            <meta itemprop="contentURL" content="https://static.merceriadajoanasd21.online/iphonec/538568.mp4" />
            <div class="AbasBox">
              <div class="Aba active" data-target="0">SD</div>
              <div class="Aba" data-target="1">HD</div>
              <div class="Aba" data-target="2">FULLHD</div>
            </div>
          </body></html>`,
      };
    }
    if (url === 'https://cdn.taboola.com/libtrc/unpkg/tfa.js') {
      return { status: 200, ok: true, finalUrl: url, body: 'x'.repeat(500) };
    }
    if (url.startsWith('https://ads.animeyabu.net/adblock2.php')) {
      if (opts?.method === 'POST') {
        return {
          status: 200,
          ok: true,
          finalUrl: url,
          body: JSON.stringify([{ ads: 'OK', publicidade: '?wmsAuthSign=tok123' }]),
        };
      }
      return {
        status: 200,
        ok: true,
        finalUrl: url,
        body: JSON.stringify([
          {
            ads: 'OK',
            publicidade:
              '?response-content-type=video%2Fmp4&X-Amz-Date=20261122T012517Z&X-Amz-Expires=3600&X-Amz-Signature=deadbeef',
          },
        ]),
      };
    }
    return { status: 404, ok: false, finalUrl: url, body: '' };
  };

  const res = await resolveFromHinataSoulSource(mockFetcher, HINATASOUL_BUILTIN_SOURCE, {
    title: 'Sousou no Frieren',
    mediaType: 'anime',
    seasonNumber: 2,
    episodeNumber: 2,
  });

  assert.equal(res.options.length, 2);
  assert.equal(res.options[0].sourceId, 'hinatasoul');
  assert.equal(res.options[0].providerKind, 'hinatasoul');
  assert.equal(res.options[0].audioType, 'LEG');
  assert.equal(res.options[0].embedUrl, 'https://www.hinatasoul.com/videos/538568');
  assert.equal(res.options[1].audioType, 'DUB');
  assert.equal(res.options[1].embedUrl, 'https://www.hinatasoul.com/videos/543000');

  const resolved = await resolveEmbedByUrl(mockFetcher, res.options[0].embedUrl);
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.provider, 'Hinata Soul');
  assert.equal(resolved.streams.length, 3);
  assert.deepEqual(
    resolved.streams.map((s) => s.height),
    [1080, 720, 480]
  );
  assert.ok(resolved.streams[0].url.includes('/zful/538568.mp4?'));
  assert.ok(resolved.streams[1].url.includes('/z333/538568.mp4?'));
  assert.ok(resolved.streams[2].url.includes('/ziphonec/538568.mp4?'));
  assert.equal(resolved.preferDirect, false);

  const testRes = await testEpisodeSource(mockFetcher, HINATASOUL_BUILTIN_SOURCE);
  assert.equal(testRes.ok, true);
  assert.equal(testRes.sourceId, 'hinatasoul');
});

test('Hinata Soul resolves Solo Leveling under hex-hash URL via split romaji alias from composite alternativeTitles', async () => {
  const searchedQueries: string[] = [];
  const soloHashUrl =
    'https://www.hinatasoul.com/animes/2fb91a215b53e7b3d3416c707b39a990f835820e';

  const mockFetcher: HttpFetcher = async (url) => {
    if (url.startsWith('https://www.hinatasoul.com/busca?busca=')) {
      const q = decodeURIComponent(url.split('busca=')[1] || '');
      searchedQueries.push(q);
      if (q.toLowerCase() === 'ore dake level up na ken') {
        return {
          status: 200,
          ok: true,
          finalUrl: url,
          body: `
            <div class="ultimosAnimesHomeItem">
              <a href="/animes/2fb91a215b53e7b3d3416c707b39a990f835820e">
                <div class="ultimosAnimesHomeItemInfos">
                  <div class="ultimosAnimesHomeItemInfosNome">Ore dake Level Up na Ken</div>
                  <div class="ultimosAnimesHomeItemTipo">Anime</div>
                </div>
              </a>
            </div>`,
        };
      }
      return { status: 200, ok: true, finalUrl: url, body: '<div class="aniContainer"></div>' };
    }
    if (url === soloHashUrl) {
      return {
        status: 200,
        ok: true,
        finalUrl: url,
        body: `
          <div class="tituloPage"><h1>Ore dake Level Up na Ken</h1></div>
          <div class="mainSingle"><div class="right"><div class="aniContainer">
            <div class="ultimosEpisodiosHomeItem">
              <a href="/videos/510007" title="Ore dake Level Up na Ken ep 7">
                <div class="ultimosEpisodiosHomeItemInfosNum">Episódio 07</div>
              </a>
            </div>
          </div></div></div>`,
      };
    }
    return { status: 404, ok: false, finalUrl: url, body: '' };
  };

  const res = await resolveFromHinataSoulSource(mockFetcher, HINATASOUL_BUILTIN_SOURCE, {
    title: 'Solo Leveling',
    originalTitle: '俺だけレベルアップな件',
    alternativeTitles: [
      'Ore dake Level Up na Ken | Na Honjaman Level Up, I Level Up Alone',
      'Only I Level Up',
      'Solo Leveling Season 2 -Arise from the Shadow-',
    ],
    mediaType: 'anime',
    seasonNumber: 1,
    episodeNumber: 7,
  });

  assert.ok(
    searchedQueries.some((q) => q.toLowerCase() === 'ore dake level up na ken'),
    `Expected romaji alias query, got: ${JSON.stringify(searchedQueries)}`
  );
  assert.equal(res.options.length, 1);
  assert.equal(res.options[0].sourceId, 'hinatasoul');
  assert.equal(res.options[0].embedUrl, 'https://www.hinatasoul.com/videos/510007');
});

test('resolveEmbedByUrl resolves MixDrop packed embeds with origin referer and proxy mode', async () => {
  const mockFetcher: HttpFetcher = async (url) => {
    if (url === 'https://mixdrop.ag/e/pkd3x7wjcq4p3p') {
      return {
        status: 200,
        ok: true,
        finalUrl: url,
        body: `<script>eval(function(p,a,c,k,e,d){e=function(c){return c};if(!''.replace(/^/,String)){while(c--){d[c]=k[c]||c}k=[function(e){return d[e]}];e=function(){return'\\\\w+'};c=1};while(c--){if(k[c]){p=p.replace(new RegExp('\\\\b'+e(c)+'\\\\b','g'),k[c])}}return p}('1.7="//3-2.5.4/6/8.9?10=11";',10,12,'|MDCore|delivery31|a|net|mxcontent|v2|wurl|pkd3x7wjcq4p3p|mp4|s|tok123'.split('|'),0,{}))</script>`,
      };
    }
    return { status: 404, ok: false, finalUrl: url, body: '' };
  };

  const resolved = await resolveEmbedByUrl(mockFetcher, 'https://mixdrop.ag/e/pkd3x7wjcq4p3p');
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.provider, 'MixDrop');
  assert.equal(resolved.referer, 'https://mixdrop.ag/');
  assert.equal(resolved.preferDirect, false);
  assert.equal(
    resolved.streams[0]?.url,
    'https://a-delivery31.mxcontent.net/v2/pkd3x7wjcq4p3p.mp4?s=tok123'
  );
});

