import test from 'node:test';
import assert from 'node:assert/strict';
import type { HttpFetcher } from './httpTypes.ts';
import {
  clearTvdbEpisodePageCache,
  localizeTvdbEpisodeListTitles,
  parseTvdbAllSeasonsHtml,
  parseTvdbEpisodePageHtml,
  parseTvdbMediaPageTranslations,
  resolveLocalizedEpisodeTitlesByIds,
} from './catalog/providers/thetvdbProvider.ts';
import {
  cleanTranslatedTitle,
  clearTitleTranslationCache,
  normalizeTitleForTranslation,
  translateTitlesBatchToPtBr,
} from './googleTranslate.ts';
import {
  clearAnimeSynopsisCache,
  clearEpisodeSynopsisCache,
  parseGoogleTranslateResponse,
  resolveLocalizedAnimeSynopsis,
  resolveLocalizedEpisodeSynopsis,
  splitTextForTranslation,
} from './episodeSynopsis.ts';

test('parseTvdbEpisodePageHtml extracts strictly PT-BR (pt) and EN (eng), ignoring PT-PT (por) as PT-BR', () => {
  const html = `
    <html><body>
      <div class="change_translation_text" data-language="por" data-title="O Fim da Viagem (PT)">
        <p>Sinopse em português europeu.</p>
      </div>
      <div class="change_translation_text" data-language="pt" data-title="O Fim da Jornada">
        <p>Após derrotar o Rei Demônio, o grupo de Frieren retorna para a Capital Imperial.</p>
      </div>
      <div class="change_translation_text" data-language="eng" data-title="The Journey's End">
        <p>The world celebrates the Demon King's defeat at the hands of the Hero.</p>
      </div>
    </body></html>
  `;

  const parsed = parseTvdbEpisodePageHtml(html);
  assert.equal(parsed.ptBrTitle, 'O Fim da Jornada');
  assert.equal(
    parsed.ptBrOverview,
    'Após derrotar o Rei Demônio, o grupo de Frieren retorna para a Capital Imperial.'
  );
  assert.equal(parsed.engTitle, "The Journey's End");
  assert.equal(
    parsed.engOverview,
    "The world celebrates the Demon King's defeat at the hands of the Hero."
  );

  // When only `por` and `eng` exist (no `pt`), ptBrOverview must remain undefined so EN -> Google Translate runs
  const htmlNoPtBr = `
    <html><body>
      <div class="change_translation_text" data-language="por" data-title="Título PT-PT">
        <p>Apenas português europeu.</p>
      </div>
      <div class="change_translation_text" data-language="eng" data-title="English Title">
        <p>English overview text here.</p>
      </div>
    </body></html>
  `;
  const parsedNoPtBr = parseTvdbEpisodePageHtml(htmlNoPtBr);
  assert.equal(parsedNoPtBr.ptBrOverview, undefined);
  assert.equal(parsedNoPtBr.engOverview, 'English overview text here.');
});

test('parseTvdbAllSeasonsHtml captures tvdbEpisodeId from episode links and ignores network names or TBA titles', () => {
  const html = `
    <ul>
      <li class="list-group-item">
        <span class="episode-label">S01E01</span>
        <h4><a href="/series/sousou-no-frieren/episodes/9350138">The Journey's End</a></h4>
        <ul class="list-inline"><li>September 29, 2023</li><li>Nippon TV</li></ul>
        <div class="list-group-item-text"><p>English summary from guide.</p></div>
      </li>
      <li class="list-group-item">
        <span class="episode-label">S03E13</span>
        <h4><a href="/series/sousou-no-frieren/episodes/9350999">TBA</a></h4>
        <ul class="list-inline"><li>Nippon TV</li></ul>
      </li>
    </ul>
  `;
  const eps = parseTvdbAllSeasonsHtml(html, 424536, 'anime');
  assert.equal(eps.length, 2);
  assert.equal(eps[0].tvdbEpisodeId, 9350138);
  assert.equal(eps[0].date, 'September 29, 2023');
  assert.equal(eps[0].overview, 'English summary from guide.');
  assert.equal(eps[1].title, 'Episódio 13');
  assert.equal(eps[1].date, undefined);
});

test('parseGoogleTranslateResponse joins translated segments and rejects malformed input', () => {
  const payload = JSON.stringify([
    [
      ['Primeira frase traduzida. ', 'First translated sentence. ', null, null, 3],
      ['Segunda frase traduzida.', 'Second translated sentence.', null, null, 3],
    ],
    null,
    'en',
  ]);
  assert.equal(
    parseGoogleTranslateResponse(payload),
    'Primeira frase traduzida. Segunda frase traduzida.'
  );
  assert.equal(parseGoogleTranslateResponse('not json'), '');
  assert.equal(parseGoogleTranslateResponse('[]'), '');
});

test('splitTextForTranslation splits long synopses cleanly without losing text', () => {
  const text = 'Sentence one. '.repeat(80) + '\n\n' + 'Sentence two. '.repeat(80);
  const chunks = splitTextForTranslation(text, 400);
  assert.ok(chunks.length >= 4);
  assert.ok(chunks.every((c) => c.length <= 400));
});

test('resolveLocalizedEpisodeSynopsis prefers native TheTVDB PT-BR without calling Google Translate', async () => {
  clearEpisodeSynopsisCache();
  let googleTranslateCalled = false;

  const mockFetch: HttpFetcher = async (url) => {
    if (url.includes('translate.googleapis.com')) {
      googleTranslateCalled = true;
      return { ok: true, status: 200, finalUrl: url, body: '[]' };
    }
    if (url.includes('/episodes/9350138') || url.includes('/dereferrer/episode/9350138')) {
      return {
        ok: true,
        status: 200,
        finalUrl: url,
        body: `
          <div class="change_translation_text" data-language="pt" data-title="O Fim da Jornada">
            <p>Sinopse oficial em português do Brasil direto do TheTVDB.</p>
          </div>
          <div class="change_translation_text" data-language="eng" data-title="The Journey's End">
            <p>Official English synopsis.</p>
          </div>
        `,
      };
    }
    return { ok: false, status: 404, finalUrl: url, body: '' };
  };

  const result = await resolveLocalizedEpisodeSynopsis(mockFetch, {
    tvdbEpisodeId: 9350138,
    tvdbSlug: 'sousou-no-frieren',
    useCache: false,
  });

  assert.equal(googleTranslateCalled, false);
  assert.deepEqual(result, {
    synopsis: 'Sinopse oficial em português do Brasil direto do TheTVDB.',
    language: 'pt-BR',
    source: 'thetvdb-pt-br',
    episodeTitle: 'O Fim da Jornada',
    tvdbEpisodeId: 9350138,
    tvdbSeriesId: undefined,
  });
});

test('resolveLocalizedEpisodeSynopsis translates TheTVDB English via Google Translate when PT-BR is missing', async () => {
  clearEpisodeSynopsisCache();
  const translateUrls: string[] = [];

  const mockFetch: HttpFetcher = async (url) => {
    if (url.includes('/episodes/777001')) {
      return {
        ok: true,
        status: 200,
        finalUrl: url,
        body: `
          <div class="change_translation_text" data-language="eng" data-title="A New Dawn">
            <p>The heroes depart at sunrise to cross the northern mountains.</p>
          </div>
        `,
      };
    }
    if (url.includes('translate.googleapis.com')) {
      translateUrls.push(url);
      if (url.includes('A%20New%20Dawn')) {
        return {
          ok: true,
          status: 200,
          finalUrl: url,
          body: JSON.stringify([[['Um Novo Amanhecer', 'A New Dawn']], null, 'en']),
        };
      }
      return {
        ok: true,
        status: 200,
        finalUrl: url,
        body: JSON.stringify([
          [
            [
              'Os heróis partem ao nascer do sol para atravessar as montanhas do norte.',
              'The heroes depart at sunrise to cross the northern mountains.',
            ],
          ],
          null,
          'en',
        ]),
      };
    }
    return { ok: false, status: 404, finalUrl: url, body: '' };
  };

  const result = await resolveLocalizedEpisodeSynopsis(mockFetch, {
    tvdbEpisodeId: 777001,
    tvdbSlug: 'horizon-chronicles',
    useCache: false,
  });

  assert.ok(translateUrls.some((u) => /sl=en&tl=pt-BR/.test(u)));
  assert.deepEqual(result, {
    synopsis: 'Os heróis partem ao nascer do sol para atravessar as montanhas do norte.',
    language: 'pt-BR',
    source: 'thetvdb-google-translate',
    episodeTitle: 'Um Novo Amanhecer',
    tvdbEpisodeId: 777001,
    tvdbSeriesId: undefined,
  });
});

test('resolveLocalizedEpisodeSynopsis falls back to original English when Google Translate fails', async () => {
  clearEpisodeSynopsisCache();

  const mockFetch: HttpFetcher = async (url) => {
    if (url.includes('/episodes/777002')) {
      return {
        ok: true,
        status: 200,
        finalUrl: url,
        body: `
          <div class="change_translation_text" data-language="eng" data-title="The Silent Gate">
            <p>A mysterious gate opens above the valley as night falls.</p>
          </div>
        `,
      };
    }
    if (url.includes('translate.googleapis.com')) {
      return { ok: false, status: 503, finalUrl: url, body: 'Service Unavailable' };
    }
    return { ok: false, status: 404, finalUrl: url, body: '' };
  };

  const result = await resolveLocalizedEpisodeSynopsis(mockFetch, {
    tvdbEpisodeId: 777002,
    tvdbSlug: 'horizon-chronicles',
    useCache: false,
  });

  assert.deepEqual(result, {
    synopsis: 'A mysterious gate opens above the valley as night falls.',
    language: 'en',
    source: 'thetvdb-en',
    episodeTitle: 'The Silent Gate',
    tvdbEpisodeId: 777002,
    tvdbSeriesId: undefined,
  });
});

test('resolveLocalizedEpisodeSynopsis resolves episode from tvdbSlug + season/episode guide', async () => {
  clearEpisodeSynopsisCache();

  const mockFetch: HttpFetcher = async (url) => {
    if (url.includes('/series/demo-anime/allseasons/official')) {
      return {
        ok: true,
        status: 200,
        finalUrl: url,
        body: `
          <ul>
            <li class="list-group-item">
              <span class="episode-label">S01E02</span>
              <h4><a href="/series/demo-anime/episodes/888002">Second Trial</a></h4>
              <div class="list-group-item-text"><p>Fallback English overview.</p></div>
            </li>
          </ul>
        `,
      };
    }
    if (url.includes('/series/demo-anime/episodes/888002')) {
      return {
        ok: true,
        status: 200,
        finalUrl: url,
        body: `
          <div class="change_translation_text" data-language="pt" data-title="Segundo Desafio">
            <p>O protagonista enfrenta o segundo desafio no templo antigo.</p>
          </div>
        `,
      };
    }
    return { ok: false, status: 404, finalUrl: url, body: '' };
  };

  const result = await resolveLocalizedEpisodeSynopsis(mockFetch, {
    tvdbSlug: 'demo-anime',
    tvdbId: 55500,
    seasonNumber: 1,
    episodeNumber: 2,
    useCache: false,
  });

  assert.equal(result?.source, 'thetvdb-pt-br');
  assert.equal(result?.episodeTitle, 'Segundo Desafio');
  assert.equal(result?.synopsis, 'O protagonista enfrenta o segundo desafio no templo antigo.');
  assert.equal(result?.tvdbEpisodeId, 888002);
});

test('parseTvdbEpisodePageHtml extracts TheTVDB episode image and normalizes relative /banners paths while ignoring placeholders', () => {
  const html = `
    <html>
      <head>
        <meta property="og:image" content="https://www.thetvdb.com/images/missing/episode.jpg" />
      </head>
      <body>
        <img src="/images/v2/logo.png" />
        <img data-src="/banners/v4/episode/9350138/screencap/6516d0c091a5d.jpg" />
        <div class="change_translation_text" data-language="pt" data-title="O Fim da Jornada">
          <p>Sinopse oficial em PT-BR.</p>
        </div>
      </body>
    </html>
  `;
  const parsed = parseTvdbEpisodePageHtml(html);
  assert.equal(
    parsed.episodeImage,
    'https://artworks.thetvdb.com/banners/v4/episode/9350138/screencap/6516d0c091a5d.jpg'
  );
  assert.equal(parsed.ptBrOverview, 'Sinopse oficial em PT-BR.');
});

test('parseTvdbMediaPageTranslations extracts PT-BR/EN synopses and official TheTVDB poster/backdrop', () => {
  const html = `
    <html>
      <head>
        <meta property="og:image" content="https://artworks.thetvdb.com/banners/v4/series/424536/posters/poster.jpg" />
      </head>
      <body>
        <img class="img-responsive" src="/banners/v4/series/424536/posters/poster.jpg" />
        <div style="background-image:url('https://artworks.thetvdb.com/banners/v4/series/424536/backgrounds/bg.jpg')"></div>
        <div class="change_translation_text" data-language="por">
          <p>Português europeu ignorado.</p>
        </div>
        <div class="change_translation_text" data-language="eng">
          <p>An elf mage sets out on a new journey.</p>
        </div>
      </body>
    </html>
  `;
  const parsed = parseTvdbMediaPageTranslations(html);
  assert.equal(parsed.ptBrOverview, undefined);
  assert.equal(parsed.engOverview, 'An elf mage sets out on a new journey.');
  assert.equal(
    parsed.poster,
    'https://artworks.thetvdb.com/banners/v4/series/424536/posters/poster.jpg'
  );
  assert.equal(
    parsed.backdrop,
    'https://artworks.thetvdb.com/banners/v4/series/424536/backgrounds/bg.jpg'
  );
});

test('resolveLocalizedAnimeSynopsis prefers native PT-BR, translates EN via Google Translate, and falls back to EN', async () => {
  clearAnimeSynopsisCache();
  let translateCalls = 0;

  const mockFetch: HttpFetcher = async (url) => {
    if (url.includes('/series/native-pt-anime')) {
      return {
        ok: true,
        status: 200,
        finalUrl: url,
        body: `
          <img class="img-responsive" src="https://artworks.thetvdb.com/banners/v4/series/1001/posters/p1.jpg" />
          <div class="change_translation_text" data-language="pt">
            <p>Sinopse nativa do anime em português do Brasil.</p>
          </div>
          <div class="change_translation_text" data-language="eng">
            <p>English anime synopsis.</p>
          </div>
        `,
      };
    }
    if (url.includes('/series/english-only-anime')) {
      return {
        ok: true,
        status: 200,
        finalUrl: url,
        body: `
          <img class="img-responsive" src="https://artworks.thetvdb.com/banners/v4/series/1002/posters/p2.jpg" />
          <div style="background:url('https://artworks.thetvdb.com/banners/v4/series/1002/backgrounds/b2.jpg')"></div>
          <div class="change_translation_text" data-language="eng">
            <p>A young swordsman travels across a fractured kingdom.</p>
          </div>
        `,
      };
    }
    if (url.includes('/movies/english-movie')) {
      return {
        ok: true,
        status: 200,
        finalUrl: url,
        body: `
          <img class="img-responsive" src="https://artworks.thetvdb.com/banners/v4/movie/2001/posters/pm.jpg" />
          <div class="change_translation_text" data-language="eng">
            <p>A standalone anime movie adventure.</p>
          </div>
        `,
      };
    }
    if (url.includes('translate.googleapis.com')) {
      translateCalls++;
      if (url.includes('standalone')) {
        return { ok: false, status: 503, finalUrl: url, body: '' };
      }
      return {
        ok: true,
        status: 200,
        finalUrl: url,
        body: JSON.stringify([
          [
            [
              'Um jovem espadachim viaja por um reino fragmentado.',
              'A young swordsman travels across a fractured kingdom.',
            ],
          ],
          null,
          'en',
        ]),
      };
    }
    return { ok: false, status: 404, finalUrl: url, body: '' };
  };

  const nativePt = await resolveLocalizedAnimeSynopsis(mockFetch, {
    tvdbId: 1001,
    tvdbSlug: 'native-pt-anime',
    useCache: false,
  });
  assert.equal(translateCalls, 0);
  assert.equal(nativePt?.source, 'thetvdb-pt-br');
  assert.equal(nativePt?.language, 'pt-BR');
  assert.equal(nativePt?.synopsis, 'Sinopse nativa do anime em português do Brasil.');
  assert.equal(
    nativePt?.poster,
    'https://artworks.thetvdb.com/banners/v4/series/1001/posters/p1.jpg'
  );

  const translated = await resolveLocalizedAnimeSynopsis(mockFetch, {
    tvdbId: 1002,
    tvdbSlug: 'english-only-anime',
    useCache: false,
  });
  assert.equal(translateCalls, 1);
  assert.equal(translated?.source, 'thetvdb-google-translate');
  assert.equal(translated?.language, 'pt-BR');
  assert.equal(translated?.synopsis, 'Um jovem espadachim viaja por um reino fragmentado.');
  assert.equal(
    translated?.poster,
    'https://artworks.thetvdb.com/banners/v4/series/1002/posters/p2.jpg'
  );
  assert.equal(
    translated?.backdrop,
    'https://artworks.thetvdb.com/banners/v4/series/1002/backgrounds/b2.jpg'
  );

  const movieFallback = await resolveLocalizedAnimeSynopsis(mockFetch, {
    tvdbId: 2001,
    tvdbSlug: 'english-movie',
    mediaType: 'movie',
    useCache: false,
  });
  assert.equal(movieFallback?.source, 'thetvdb-en');
  assert.equal(movieFallback?.language, 'en');
  assert.equal(movieFallback?.synopsis, 'A standalone anime movie adventure.');
  assert.equal(
    movieFallback?.poster,
    'https://artworks.thetvdb.com/banners/v4/movie/2001/posters/pm.jpg'
  );
});

test('normalizeTitleForTranslation cleans Japanese segment quotes and translateTitlesBatchToPtBr separates JA vs Latin scripts', async () => {
  clearTitleTranslationCache();

  assert.equal(
    normalizeTitleForTranslation('「オスガキにも穴はあるんだよな…」「かいちょーは梅くんに貰われました」'),
    'オスガキにも穴はあるんだよな… / かいちょーは梅くんに貰われました'
  );
  assert.equal(normalizeTitleForTranslation('「こまろと不思議な箱」'), 'こまろと不思議な箱');

  const requestedUrls: string[] = [];
  const mockFetch: HttpFetcher = async (url) => {
    requestedUrls.push(url);
    const parsedUrl = new URL(url);
    const sl = parsedUrl.searchParams.get('sl');
    const q = parsedUrl.searchParams.get('q') || '';
    if (sl === 'ja') {
      const translated = q
        .split('\n')
        .map((line) =>
          line.includes('オスガキ')
            ? 'Até o pirralho tem seus furos... / A presidente foi levada pelo Ume-kun'
            : 'Komaro e a caixa misteriosa'
        )
        .join('\n');
      return { ok: true, status: 200, finalUrl: url, body: JSON.stringify([[[translated, q]], null, 'ja']) };
    }
    const translated = q
      .split('\n')
      .map((line) => (line === "The Journey's End" ? 'O Fim da Jornada' : line))
      .join('\n');
    return { ok: true, status: 200, finalUrl: url, body: JSON.stringify([[[translated, q]], null, 'en']) };
  };

  const map = await translateTitlesBatchToPtBr(
    mockFetch,
    [
      '「オスガキにも穴はあるんだよな…」「かいちょーは梅くんに貰われました」',
      '「こまろと不思議な箱」',
      "The Journey's End",
    ],
    { useCache: false }
  );

  // Must issue separate requests for Japanese (sl=ja) and Latin (sl=auto) scripts
  assert.equal(requestedUrls.length, 2);
  assert.ok(requestedUrls.some((u) => u.includes('sl=ja&tl=pt-BR')));
  assert.ok(requestedUrls.some((u) => u.includes('sl=auto&tl=pt-BR')));
  assert.equal(
    map.get('「オスガキにも穴はあるんだよな…」「かいちょーは梅くんに貰われました」'),
    'Até o pirralho tem seus furos... / A presidente foi levada pelo Ume-kun'
  );
  assert.equal(map.get('「こまろと不思議な箱」'), 'Komaro e a caixa misteriosa');
  assert.equal(map.get("The Journey's End"), 'O Fim da Jornada');
});

test('localizeTvdbEpisodeListTitles translates public /allseasons/official Japanese episode titles and falls back cleanly on line mismatch', async () => {
  clearTitleTranslationCache();

  const html = `
    <ul>
      <li class="list-group-item">
        <span class="episode-label">S01E01</span>
        <h4><a href="/series/seitokai/episodes/101">「オスガキにも穴はあるんだよな…」</a></h4>
      </li>
      <li class="list-group-item">
        <span class="episode-label">S01E02</span>
        <h4><a href="/series/seitokai/episodes/102">「メシにも穴はあるんだよな…」</a></h4>
      </li>
    </ul>
  `;
  const parsed = parseTvdbAllSeasonsHtml(html, 463051, 'anime');

  // Simulate batch returning wrong line count when direct episode pages are unavailable
  let batchAttempted = false;
  const mockFetch: HttpFetcher = async (url) => {
    if (!url.includes('translate.googleapis.com')) {
      return { ok: false, status: 404, finalUrl: url, body: '' };
    }
    const q = new URL(url).searchParams.get('q') || '';
    if (q.includes('\n')) {
      batchAttempted = true;
      return {
        ok: true,
        status: 200,
        finalUrl: url,
        body: JSON.stringify([[['Linha única quebrada', q]], null, 'ja']),
      };
    }
    if (q.includes('オスガキ')) {
      return {
        ok: true,
        status: 200,
        finalUrl: url,
        body: JSON.stringify([[['Até o pirralho tem seus furos...', q]], null, 'ja']),
      };
    }
    return {
      ok: true,
      status: 200,
      finalUrl: url,
      body: JSON.stringify([[['A hora do rango também tem seus furos...', q]], null, 'ja']),
    };
  };

  const localized = await localizeTvdbEpisodeListTitles(mockFetch, parsed, { useCache: false });
  assert.equal(batchAttempted, true);
  assert.equal(localized[0].title, 'Episódio 1 — Até o pirralho tem seus furos...');
  assert.equal(localized[1].title, 'Episódio 2 — A hora do rango também tem seus furos...');
});

test('localizeTvdbEpisodeListTitles directly fetches native TheTVDB PT-BR titles (matching EpisodeWorkspace) and warms shared cache', async () => {
  clearEpisodeSynopsisCache();
  clearTvdbEpisodePageCache();
  clearTitleTranslationCache();

  // Japanese lenticular brackets 【...】 and stray [desvio] are cleaned and capitalized
  assert.equal(normalizeTitleForTranslation('【逸脱】'), '逸脱');
  assert.equal(cleanTranslatedTitle('[desvio]'), 'Desvio');

  const guideHtml = `
    <ul>
      <li class="list-group-item">
        <span class="episode-label">S01E02</span>
        <h4><a href="/series/kashita-maryoku/episodes/2002">【契約】</a></h4>
      </li>
      <li class="list-group-item">
        <span class="episode-label">S01E05</span>
        <h4><a href="/series/kashita-maryoku/episodes/2005">【逸脱】</a></h4>
      </li>
    </ul>
  `;
  const parsed = parseTvdbAllSeasonsHtml(guideHtml, 500001, 'anime');

  let ep2005PageFetches = 0;
  const translatedQueries: string[] = [];
  const mockFetch: HttpFetcher = async (url) => {
    if (url.includes('/series/kashita-maryoku/episodes/2005')) {
      ep2005PageFetches++;
      return {
        ok: true,
        status: 200,
        finalUrl: url,
        body: `
          <div class="change_translation_text" data-language="pt" data-title="As Exceções">
            <p>Lent salva Rinka, abandonada por seu grupo, de um irregular.</p>
          </div>
          <div class="change_translation_text" data-language="eng" data-title="The Outliers">
            <p>Lent saves Rinka from an irregular.</p>
          </div>
        `,
      };
    }
    if (url.includes('/series/kashita-maryoku/episodes/2002')) {
      return {
        ok: true,
        status: 200,
        finalUrl: url,
        body: `
          <div class="change_translation_text" data-language="eng" data-title="The Pact">
            <p>A new pact is formed.</p>
          </div>
        `,
      };
    }
    if (url.includes('translate.googleapis.com')) {
      const q = new URL(url).searchParams.get('q') || '';
      translatedQueries.push(q);
      return {
        ok: true,
        status: 200,
        finalUrl: url,
        body: JSON.stringify([[['O Pacto', q]], null, 'en']),
      };
    }
    return { ok: false, status: 404, finalUrl: url, body: '' };
  };

  const localized = await localizeTvdbEpisodeListTitles(mockFetch, parsed, {
    tvdbSlug: 'kashita-maryoku',
    tvdbSeriesId: 500001,
    useCache: true,
  });

  // Ep 5 gets native TheTVDB PT-BR "As Exceções" directly without calling Google Translate
  assert.equal(localized[1].title, 'Episódio 5 — As Exceções');
  assert.equal(localized[1].titleLocalized, true);
  // Ep 2 had no PT-BR on TheTVDB -> prefers official EN "The Pact" translated to PT-BR over Japanese 【契約】
  assert.equal(localized[0].title, 'Episódio 2 — O Pacto');
  assert.equal(localized[0].titleLocalized, true);
  assert.deepEqual(translatedQueries, ['The Pact']);
  assert.equal(ep2005PageFetches, 1);

  // Opening Ep 5 in EpisodeWorkspace immediately hits the pre-warmed shared episode page cache (0 extra fetches!)
  const workspaceResult = await resolveLocalizedEpisodeSynopsis(mockFetch, {
    tvdbEpisodeId: 2005,
    tvdbSlug: 'kashita-maryoku',
    useCache: true,
  });
  assert.equal(ep2005PageFetches, 1);
  assert.equal(workspaceResult?.episodeTitle, 'As Exceções');
  assert.equal(workspaceResult?.source, 'thetvdb-pt-br');
  assert.equal(
    workspaceResult?.synopsis,
    'Lent salva Rinka, abandonada por seu grupo, de um irregular.'
  );

  // On-demand /api/episode-titles helper resolves identically from cache too
  const byIds = await resolveLocalizedEpisodeTitlesByIds(mockFetch, [2002, 2005], {
    tvdbSlug: 'kashita-maryoku',
    useCache: true,
  });
  assert.equal(ep2005PageFetches, 1);
  assert.deepEqual(byIds, { 2002: 'O Pacto', 2005: 'As Exceções' });
});


