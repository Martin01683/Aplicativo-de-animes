import test from 'node:test';
import assert from 'node:assert/strict';
import type { HttpFetcher, HttpFetchOptions, HttpFetchResult } from './httpTypes.ts';
import {
  clearTvdbEpisodePageCache,
  localizeTvdbEpisodeListTitles,
  parseTvdbAllSeasonsHtml,
} from './catalog/providers/thetvdbProvider.ts';
import {
  DEEPL_ONESHOT_FREE_ENDPOINT,
  isDeeplTranslatorAvailable,
  resetDeeplTranslatorState,
  setDeeplWebEnabled,
} from './deeplTranslate.ts';
import {
  clearAnimeSynopsisCache,
  clearEpisodeSynopsisCache,
  resolveLocalizedAnimeSynopsis,
  resolveLocalizedEpisodeSynopsis,
  splitTextForTranslation,
} from './episodeSynopsis.ts';
import { clearTitleTranslationCache, translateTitlesBatchToPtBr } from './googleTranslate.ts';
import {
  synopsisSourceForEngine,
  translateSynopsisToPtBr,
  translateTitleToPtBr,
  translateTitlesBatchWithFallback,
} from './translation.ts';

// ---------------------------------------------------------------------------------------------
// Test network: TheTVDB pages + DeepL + Google Translate + Apple's lookup, all in memory
// ---------------------------------------------------------------------------------------------

interface Call {
  url: string;
  options: HttpFetchOptions;
}

interface DeeplBody {
  text: string[];
  source_lang?: string;
  target_lang: string;
}

function reply(url: string, status: number, body: unknown = ''): HttpFetchResult {
  return {
    status,
    ok: status >= 200 && status < 300,
    finalUrl: url,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

/** DeepL that answers from a dictionary and marks anything unknown as `PT: <text>`. */
function deeplFrom(dictionary: Record<string, string> = {}) {
  return (call: Call, body: DeeplBody): HttpFetchResult =>
    reply(call.url, 200, {
      translations: body.text.map((text) => ({ text: dictionary[text] ?? `PT: ${text}` })),
    });
}

const deeplBlocked = (call: Call): HttpFetchResult =>
  reply(call.url, 429, { error: 'Too many requests' });
const deeplDown = (call: Call): HttpFetchResult => reply(call.url, 500, 'boom');

/** Google that translates line by line from a dictionary and marks anything else as `GG: <line>`. */
function googleFrom(dictionary: Record<string, string> = {}) {
  return (call: Call, q: string): HttpFetchResult => {
    const translated = q
      .split('\n')
      .map((line) => dictionary[line] ?? `GG: ${line}`)
      .join('\n');
    return reply(call.url, 200, [[[translated, q]], null, 'en']);
  };
}

const googleDown = (call: Call): HttpFetchResult => reply(call.url, 503, 'Service Unavailable');

function createNetwork(handlers: {
  deepl?: (call: Call, body: DeeplBody) => HttpFetchResult;
  google?: (call: Call, q: string) => HttpFetchResult;
  /** Returns the HTML of a TheTVDB page for the URL, or undefined when there is none (404). */
  tvdb?: (url: string) => string | undefined;
}) {
  const calls: Call[] = [];
  const fetchHttp: HttpFetcher = async (url, options = {}) => {
    const call = { url, options };
    calls.push(call);
    if (url.startsWith('https://itunes.apple.com/')) return reply(url, 404);
    if (url === DEEPL_ONESHOT_FREE_ENDPOINT) {
      return handlers.deepl
        ? handlers.deepl(call, JSON.parse(options.body || '{}') as DeeplBody)
        : reply(url, 404);
    }
    if (url.includes('translate.googleapis.com')) {
      const q = new URL(url).searchParams.get('q') || '';
      return handlers.google ? handlers.google(call, q) : reply(url, 404);
    }
    const page = handlers.tvdb?.(url);
    return page !== undefined ? reply(url, 200, page) : reply(url, 404);
  };
  const bodyOf = (call: Call) => JSON.parse(call.options.body || '{}') as DeeplBody;
  return {
    fetchHttp,
    calls,
    bodyOf,
    deeplRequests: () => calls.filter((c) => c.url === DEEPL_ONESHOT_FREE_ENDPOINT),
    googleRequests: () => calls.filter((c) => c.url.includes('translate.googleapis.com')),
    appStoreRequests: () => calls.filter((c) => c.url.startsWith('https://itunes.apple.com/')),
  };
}

/** Every test starts from a cold, enabled DeepL and empty caches. */
function freshState(): void {
  resetDeeplTranslatorState();
  clearTitleTranslationCache();
  clearEpisodeSynopsisCache();
  clearAnimeSynopsisCache();
  clearTvdbEpisodePageCache();
}

const episodePage = (
  engTitle: string,
  engOverview: string,
  pt?: { title: string; overview: string },
) => `
  ${
    pt
      ? `<div class="change_translation_text" data-language="pt" data-title="${pt.title}"><p>${pt.overview}</p></div>`
      : ''
  }
  <div class="change_translation_text" data-language="eng" data-title="${engTitle}">
    <p>${engOverview}</p>
  </div>
`;

const paragraph = (n: number): string => `Paragraph ${n}: ${Array(95).fill('word').join(' ')}`;

// ---------------------------------------------------------------------------------------------
// Chain: synopses
// ---------------------------------------------------------------------------------------------

test('synopsisSourceForEngine maps each engine to the source tag the UI labels', () => {
  assert.equal(synopsisSourceForEngine('deepl'), 'thetvdb-deepl');
  assert.equal(synopsisSourceForEngine('google'), 'thetvdb-google-translate');
});

test('translateSynopsisToPtBr uses DeepL first, sends paragraphs as separate entries, and never touches Google', async () => {
  freshState();
  const p1 = 'The heroes depart at sunrise.';
  const p2 = 'The journey is long and dangerous.';
  const net = createNetwork({
    deepl: deeplFrom({
      [p1]: 'Os heróis partem ao amanhecer.',
      [p2]: 'A jornada é longa e perigosa.',
    }),
  });

  const result = await translateSynopsisToPtBr(net.fetchHttp, `${p1}\n\n${p2}`);

  assert.deepEqual(result, {
    text: 'Os heróis partem ao amanhecer.\n\nA jornada é longa e perigosa.',
    engine: 'deepl',
  });
  assert.equal(net.deeplRequests().length, 1);
  const body = net.bodyOf(net.deeplRequests()[0]);
  assert.deepEqual(body.text, [p1, p2]);
  assert.equal(body.source_lang, 'en');
  assert.equal(body.target_lang, 'pt-BR');
  assert.equal(net.googleRequests().length, 0);
});

test('translateSynopsisToPtBr falls back to Google when DeepL is blocked and stops calling DeepL while blocked', async (t) => {
  t.mock.method(console, 'warn', () => {});
  freshState();
  const net = createNetwork({ deepl: deeplBlocked, google: googleFrom() });

  const first = await translateSynopsisToPtBr(net.fetchHttp, 'The first synopsis of the day.');
  assert.deepEqual(first, { text: 'GG: The first synopsis of the day.', engine: 'google' });
  assert.equal(net.deeplRequests().length, 1);
  assert.equal(isDeeplTranslatorAvailable(), false);

  const second = await translateSynopsisToPtBr(net.fetchHttp, 'The second synopsis of the day.');
  assert.deepEqual(second, { text: 'GG: The second synopsis of the day.', engine: 'google' });
  assert.equal(net.deeplRequests().length, 1, 'no further DeepL traffic while the breaker is open');
});

test('translateSynopsisToPtBr returns null only when both engines fail', async (t) => {
  t.mock.method(console, 'warn', () => {});
  freshState();
  const net = createNetwork({ deepl: deeplDown, google: googleDown });
  assert.equal(
    await translateSynopsisToPtBr(net.fetchHttp, 'A synopsis nobody can translate.'),
    null,
  );
  assert.equal(net.deeplRequests().length, 1);
  assert.ok(net.googleRequests().length >= 1);
});

test('translateSynopsisToPtBr treats an untouched English echo from DeepL as a failure and lets Google translate', async () => {
  freshState();
  const english = 'A young swordsman travels across a fractured kingdom.';
  const net = createNetwork({
    deepl: (call, body) =>
      reply(call.url, 200, { translations: body.text.map((text) => ({ text })) }), // echoes the input
    google: googleFrom({ [english]: 'Um jovem espadachim viaja por um reino fragmentado.' }),
  });

  const result = await translateSynopsisToPtBr(net.fetchHttp, english);
  assert.deepEqual(result, {
    text: 'Um jovem espadachim viaja por um reino fragmentado.',
    engine: 'google',
  });
  assert.equal(isDeeplTranslatorAvailable(), true, 'a well-formed echo is not an outage');
});

test('long synopses are chunked under the DeepL cap and every paragraph keeps its order', async () => {
  freshState();
  const paragraphs = [1, 2, 3, 4, 5, 6].map(paragraph);
  const net = createNetwork({ deepl: deeplFrom() });

  const result = await translateSynopsisToPtBr(net.fetchHttp, paragraphs.join('\n\n'));

  assert.equal(result?.engine, 'deepl');
  assert.equal(result?.text, paragraphs.map((p) => `PT: ${p}`).join('\n\n'));
  assert.equal(
    net.deeplRequests().length,
    splitTextForTranslation(paragraphs.join('\n\n'), 1400).length,
  );
  assert.ok(net.deeplRequests().length >= 2, 'the fixture really needs several requests');
  for (const request of net.deeplRequests()) {
    const units = net.bodyOf(request).text.reduce((sum, text) => sum + text.length, 0);
    assert.ok(units <= 1500, `request carried ${units} units, above the 1500 cap`);
  }
  assert.equal(net.googleRequests().length, 0);
});

test('if DeepL fails midway, the whole synopsis goes to Google so it keeps one consistent voice', async (t) => {
  t.mock.method(console, 'warn', () => {});
  freshState();
  const paragraphs = [1, 2, 3, 4, 5, 6].map(paragraph);
  let deeplRequestNumber = 0;
  const net = createNetwork({
    deepl: (call, body) => (++deeplRequestNumber === 1 ? deeplFrom()(call, body) : deeplDown(call)),
    google: googleFrom(),
  });

  const result = await translateSynopsisToPtBr(net.fetchHttp, paragraphs.join('\n\n'));

  assert.equal(result?.engine, 'google');
  assert.ok(result?.text.includes('GG: Paragraph 1:'));
  assert.ok(result?.text.includes('GG: Paragraph 5:'));
  assert.equal(result?.text.includes('PT:'), false, 'no DeepL chunk is mixed into the Google text');
  assert.equal(net.deeplRequests().length, 2);
});

test('with DeepL switched off the chain is Google-only and generates no DeepL or App Store traffic', async () => {
  freshState();
  setDeeplWebEnabled(false);
  const net = createNetwork({ deepl: deeplFrom(), google: googleFrom() });

  assert.deepEqual(await translateSynopsisToPtBr(net.fetchHttp, 'Only Google may answer this.'), {
    text: 'GG: Only Google may answer this.',
    engine: 'google',
  });
  assert.equal(
    await translateTitleToPtBr(net.fetchHttp, 'Only Google titles'),
    'GG: Only Google titles',
  );
  assert.equal(net.deeplRequests().length, 0);
  assert.equal(net.appStoreRequests().length, 0);
});

// ---------------------------------------------------------------------------------------------
// Chain: single titles
// ---------------------------------------------------------------------------------------------

test('translateTitleToPtBr uses DeepL with a Japanese hint for kana, then serves the repeat from cache', async () => {
  freshState();
  const net = createNetwork({ deepl: deeplFrom({ はじまりの冒険: 'A aventura que começa' }) });

  assert.equal(
    await translateTitleToPtBr(net.fetchHttp, 'はじまりの冒険'),
    'A aventura que começa',
  );
  assert.equal(net.bodyOf(net.deeplRequests()[0]).source_lang, 'ja');
  assert.equal(net.googleRequests().length, 0);

  assert.equal(
    await translateTitleToPtBr(net.fetchHttp, 'はじまりの冒険'),
    'A aventura que começa',
  );
  assert.equal(
    net.deeplRequests().length,
    1,
    'second lookup is answered by the shared title cache',
  );
});

test('translateTitleToPtBr falls back to Google when DeepL fails', async (t) => {
  t.mock.method(console, 'warn', () => {});
  freshState();
  const net = createNetwork({ deepl: deeplDown, google: googleFrom({ 契約: 'Pacto' }) });

  assert.equal(await translateTitleToPtBr(net.fetchHttp, '契約'), 'Pacto');
  assert.equal(net.deeplRequests().length, 1);
  assert.equal(net.googleRequests().length, 1);
});

test('translateTitleToPtBr rejects an unchanged CJK answer from DeepL but accepts unchanged Latin names', async () => {
  freshState();
  const net = createNetwork({
    deepl: (call, body) =>
      reply(call.url, 200, { translations: body.text.map((text) => ({ text })) }),
    google: googleFrom({ 契約: 'Pacto' }),
  });

  assert.equal(
    await translateTitleToPtBr(net.fetchHttp, '契約'),
    'Pacto',
    'untranslated CJK goes to Google',
  );
  assert.equal(net.googleRequests().length, 1);

  assert.equal(
    await translateTitleToPtBr(net.fetchHttp, 'Naruto'),
    'Naruto',
    'a name can stay as it is',
  );
  assert.equal(net.googleRequests().length, 1, 'Latin echo did not trigger Google');
});

// ---------------------------------------------------------------------------------------------
// Chain: batch titles
// ---------------------------------------------------------------------------------------------

test('translateTitlesBatchWithFallback sends one positional array per batch to DeepL and caches the result', async () => {
  freshState();
  const titles = ['The Pact', "The Journey's End", 'A New Dawn'];
  const net = createNetwork({
    deepl: deeplFrom({
      'The Pact': 'O Pacto',
      "The Journey's End": 'O Fim da Jornada',
      'A New Dawn': 'Um Novo Amanhecer',
    }),
  });

  const result = await translateTitlesBatchWithFallback(net.fetchHttp, titles);

  assert.deepEqual(Object.fromEntries(result), {
    'The Pact': 'O Pacto',
    "The Journey's End": 'O Fim da Jornada',
    'A New Dawn': 'Um Novo Amanhecer',
  });
  assert.equal(net.deeplRequests().length, 1);
  assert.deepEqual(net.bodyOf(net.deeplRequests()[0]).text, titles);
  assert.equal(
    'source_lang' in net.bodyOf(net.deeplRequests()[0]),
    false,
    'Latin titles use auto-detection',
  );
  assert.equal(net.googleRequests().length, 0);

  await translateTitlesBatchWithFallback(net.fetchHttp, titles);
  assert.equal(net.deeplRequests().length, 1, 'the second run is served entirely from the cache');
});

test('kana titles and Latin titles travel in separate DeepL requests with the right source hint', async () => {
  freshState();
  const net = createNetwork({
    deepl: deeplFrom({ はじまりの冒険: 'A aventura que começa', 'The Pact': 'O Pacto' }),
  });

  const result = await translateTitlesBatchWithFallback(net.fetchHttp, [
    'はじまりの冒険',
    'The Pact',
  ]);

  assert.equal(result.get('はじまりの冒険'), 'A aventura que começa');
  assert.equal(result.get('The Pact'), 'O Pacto');
  const bodies = net.deeplRequests().map(net.bodyOf);
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies.find((b) => b.source_lang === 'ja')?.text, ['はじまりの冒険']);
  assert.deepEqual(bodies.find((b) => b.source_lang === undefined)?.text, ['The Pact']);
});

test('an untranslated CJK entry is retried alone on Google while the rest keeps its DeepL translation', async () => {
  freshState();
  const net = createNetwork({
    deepl: (call) => reply(call.url, 200, { translations: [{ text: 'Desvio' }, { text: '契約' }] }),
    google: googleFrom({ 契約: 'Pacto' }),
  });

  const result = await translateTitlesBatchWithFallback(net.fetchHttp, ['逸脱', '契約']);

  assert.equal(result.get('逸脱'), 'Desvio');
  assert.equal(result.get('契約'), 'Pacto');
  assert.equal(net.deeplRequests().length, 1);
  assert.equal(net.googleRequests().length, 1);
  assert.equal(
    new URL(net.googleRequests()[0].url).searchParams.get('q'),
    '契約',
    'only the unresolved title',
  );
});

test('a misaligned DeepL batch is handed to Google in full', async (t) => {
  t.mock.method(console, 'warn', () => {});
  freshState();
  const net = createNetwork({
    deepl: (call) => reply(call.url, 200, { translations: [{ text: 'Só uma' }] }), // asked for two
    google: googleFrom({ 'The Pact': 'O Pacto', 'A New Dawn': 'Um Novo Amanhecer' }),
  });

  const result = await translateTitlesBatchWithFallback(net.fetchHttp, ['The Pact', 'A New Dawn']);

  assert.equal(result.get('The Pact'), 'O Pacto');
  assert.equal(result.get('A New Dawn'), 'Um Novo Amanhecer');
});

test('with DeepL blocked the batch result is identical to the Google-only batch (no behavior change)', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const titles = ['The Pact', "The Journey's End", 'A New Dawn', '契約'];
  const google = googleFrom({ 'The Pact': 'O Pacto', 契約: 'Pacto' });

  freshState();
  const chained = createNetwork({ deepl: deeplBlocked, google });
  const viaChain = await translateTitlesBatchWithFallback(chained.fetchHttp, titles);

  freshState();
  const googleOnly = createNetwork({ google });
  const viaGoogle = await translateTitlesBatchToPtBr(googleOnly.fetchHttp, titles);

  assert.deepEqual(Object.fromEntries(viaChain), Object.fromEntries(viaGoogle));
  assert.ok(viaChain.size >= 3);
});

// ---------------------------------------------------------------------------------------------
// Full priority order through the real resolvers:
//   TheTVDB PT-BR  >  DeepL  >  Google Translate  >  original English
// ---------------------------------------------------------------------------------------------

const EPISODE_ENG_TITLE = 'A New Dawn';
const EPISODE_ENG_OVERVIEW = 'The heroes depart at sunrise to cross the northern mountains.';
const EPISODE_DEEPL = {
  [EPISODE_ENG_TITLE]: 'Um Novo Amanhecer',
  [EPISODE_ENG_OVERVIEW]:
    'Os heróis partem ao nascer do sol para atravessar as montanhas do norte.',
};

async function resolveEpisode(
  net: ReturnType<typeof createNetwork>,
  id: number,
): ReturnType<typeof resolveLocalizedEpisodeSynopsis> {
  return resolveLocalizedEpisodeSynopsis(net.fetchHttp, {
    tvdbEpisodeId: id,
    tvdbSlug: 'horizon-chronicles',
    useCache: false,
  });
}

test('episode priority: native TheTVDB PT-BR wins and no translator is even contacted', async () => {
  freshState();
  const net = createNetwork({
    deepl: deeplFrom(),
    google: googleFrom(),
    tvdb: (url) =>
      url.includes('/episodes/777100')
        ? episodePage(EPISODE_ENG_TITLE, EPISODE_ENG_OVERVIEW, {
            title: 'Um Novo Dia',
            overview: 'Sinopse oficial em português do Brasil.',
          })
        : undefined,
  });

  const result = await resolveEpisode(net, 777100);

  assert.equal(result?.source, 'thetvdb-pt-br');
  assert.equal(result?.synopsis, 'Sinopse oficial em português do Brasil.');
  assert.equal(result?.episodeTitle, 'Um Novo Dia');
  assert.equal(net.deeplRequests().length, 0);
  assert.equal(net.googleRequests().length, 0);
  assert.equal(net.appStoreRequests().length, 0);
});

test('episode priority: with no PT-BR, DeepL translates both synopsis and title and the source says so', async () => {
  freshState();
  const net = createNetwork({
    deepl: deeplFrom(EPISODE_DEEPL),
    google: googleFrom(),
    tvdb: (url) =>
      url.includes('/episodes/777101')
        ? episodePage(EPISODE_ENG_TITLE, EPISODE_ENG_OVERVIEW)
        : undefined,
  });

  const result = await resolveEpisode(net, 777101);

  assert.deepEqual(result, {
    synopsis: 'Os heróis partem ao nascer do sol para atravessar as montanhas do norte.',
    language: 'pt-BR',
    source: 'thetvdb-deepl',
    episodeTitle: 'Um Novo Amanhecer',
    tvdbEpisodeId: 777101,
    tvdbSeriesId: undefined,
  });
  assert.equal(net.googleRequests().length, 0);
  assert.equal(
    net.appStoreRequests().length,
    1,
    'racing title+synopsis requests share one version lookup',
  );
});

test('episode priority: when DeepL is blocked, Google Translate takes over and the source says so', async (t) => {
  t.mock.method(console, 'warn', () => {});
  freshState();
  const net = createNetwork({
    deepl: deeplBlocked,
    google: googleFrom(EPISODE_DEEPL),
    tvdb: (url) =>
      url.includes('/episodes/777102')
        ? episodePage(EPISODE_ENG_TITLE, EPISODE_ENG_OVERVIEW)
        : undefined,
  });

  const result = await resolveEpisode(net, 777102);

  assert.equal(result?.source, 'thetvdb-google-translate');
  assert.equal(result?.language, 'pt-BR');
  assert.equal(
    result?.synopsis,
    'Os heróis partem ao nascer do sol para atravessar as montanhas do norte.',
  );
  assert.equal(result?.episodeTitle, 'Um Novo Amanhecer');
});

test('episode priority: when both translators fail, the original English from TheTVDB is kept', async (t) => {
  t.mock.method(console, 'warn', () => {});
  freshState();
  const net = createNetwork({
    deepl: deeplDown,
    google: googleDown,
    tvdb: (url) =>
      url.includes('/episodes/777103')
        ? episodePage('The Silent Gate', 'A mysterious gate opens above the valley.')
        : undefined,
  });

  const result = await resolveEpisode(net, 777103);

  assert.deepEqual(result, {
    synopsis: 'A mysterious gate opens above the valley.',
    language: 'en',
    source: 'thetvdb-en',
    episodeTitle: 'The Silent Gate',
    tvdbEpisodeId: 777103,
    tvdbSeriesId: undefined,
  });
});

test('anime synopsis priority: PT-BR > DeepL > Google Translate > English', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const english = 'A young swordsman travels across a fractured kingdom.';
  const portuguese = 'Um jovem espadachim viaja por um reino fragmentado.';
  const page = (url: string): string | undefined => {
    if (url.includes('/series/native-pt-anime')) {
      return `<div class="change_translation_text" data-language="pt"><p>Sinopse nativa do anime.</p></div>
              <div class="change_translation_text" data-language="eng"><p>${english}</p></div>`;
    }
    if (url.includes('/series/english-only-anime')) {
      return `<div class="change_translation_text" data-language="eng"><p>${english}</p></div>`;
    }
    return undefined;
  };
  const resolve = (net: ReturnType<typeof createNetwork>, tvdbId: number, tvdbSlug: string) =>
    resolveLocalizedAnimeSynopsis(net.fetchHttp, { tvdbId, tvdbSlug, useCache: false });

  // 1. native PT-BR: nothing is translated
  freshState();
  let net = createNetwork({ deepl: deeplFrom(), google: googleFrom(), tvdb: page });
  let result = await resolve(net, 1001, 'native-pt-anime');
  assert.equal(result?.source, 'thetvdb-pt-br');
  assert.equal(net.deeplRequests().length + net.googleRequests().length, 0);

  // 2. DeepL available
  freshState();
  net = createNetwork({
    deepl: deeplFrom({ [english]: portuguese }),
    google: googleFrom(),
    tvdb: page,
  });
  result = await resolve(net, 1002, 'english-only-anime');
  assert.equal(result?.source, 'thetvdb-deepl');
  assert.equal(result?.language, 'pt-BR');
  assert.equal(result?.synopsis, portuguese);
  assert.equal(net.googleRequests().length, 0);

  // 3. DeepL blocked, Google available
  freshState();
  net = createNetwork({
    deepl: deeplBlocked,
    google: googleFrom({ [english]: portuguese }),
    tvdb: page,
  });
  result = await resolve(net, 1002, 'english-only-anime');
  assert.equal(result?.source, 'thetvdb-google-translate');
  assert.equal(result?.synopsis, portuguese);

  // 4. both down: original English
  freshState();
  net = createNetwork({ deepl: deeplDown, google: googleDown, tvdb: page });
  result = await resolve(net, 1002, 'english-only-anime');
  assert.equal(result?.source, 'thetvdb-en');
  assert.equal(result?.language, 'en');
  assert.equal(result?.synopsis, english);
});

test('episode list titles: Japanese titles are translated by DeepL (ja hint) without touching Google', async () => {
  freshState();
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
  const net = createNetwork({
    deepl: (call, body) =>
      reply(call.url, 200, {
        translations: body.text.map((text) => ({
          text: text.includes('オスガキ')
            ? 'Até o pirralho tem seus furos...'
            : 'A hora do rango também tem seus furos...',
        })),
      }),
  });

  const localized = await localizeTvdbEpisodeListTitles(net.fetchHttp, parsed, { useCache: false });

  assert.equal(localized[0].title, 'Episódio 1 — Até o pirralho tem seus furos...');
  assert.equal(localized[1].title, 'Episódio 2 — A hora do rango também tem seus furos...');
  assert.equal(net.googleRequests().length, 0);
  assert.equal(net.deeplRequests().length, 1, 'both titles travel in a single positional request');
  assert.equal(net.bodyOf(net.deeplRequests()[0]).source_lang, 'ja');
  assert.equal(net.bodyOf(net.deeplRequests()[0]).text.length, 2);
});
