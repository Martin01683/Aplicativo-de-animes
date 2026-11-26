import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEEPL_MAX_TEXT_UNITS,
  DEEPL_ONESHOT_FREE_ENDPOINT,
  buildDeeplHeaders,
  buildDeeplRequestBody,
  buildDeeplUserAgent,
  isDeeplTranslatorAvailable,
  isValidAppVersion,
  parseAppStoreLookup,
  parseDeeplResponse,
  resetDeeplTranslatorState,
  setDeeplWebEnabled,
  translateTextsWithDeepl,
} from './deeplTranslate.ts';
import type { HttpFetcher, HttpFetchOptions, HttpFetchResult } from './httpTypes.ts';

interface Call {
  url: string;
  options: HttpFetchOptions;
}

const MINUTE = 60_000;

function reply(url: string, status: number, body: unknown = ''): HttpFetchResult {
  return {
    status,
    ok: status >= 200 && status < 300,
    finalUrl: url,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

function appStorePayload(version: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    resultCount: 1,
    results: [
      {
        trackId: 1552407475,
        bundleId: 'com.linguee.DeepLMobileTranslator',
        artistName: 'DeepL SE',
        version,
        ...overrides,
      },
    ],
  });
}

/** Echoes every requested text back as `PT: <text>`, the way a healthy DeepL answers. */
function healthyDeepl(call: Call): HttpFetchResult {
  const texts = (JSON.parse(call.options.body || '{}') as { text: string[] }).text;
  return reply(call.url, 200, {
    translations: texts.map((text) => ({ text: `PT: ${text}`, detected_source_language: 'EN' })),
  });
}

function createFetch(routes: {
  appStore?: (call: Call) => HttpFetchResult;
  deepl?: (call: Call) => HttpFetchResult;
}) {
  const calls: Call[] = [];
  const fetchHttp: HttpFetcher = async (url, options = {}) => {
    const call = { url, options };
    calls.push(call);
    if (url.startsWith('https://itunes.apple.com/lookup')) {
      return routes.appStore ? routes.appStore(call) : reply(url, 404);
    }
    if (url === DEEPL_ONESHOT_FREE_ENDPOINT) {
      if (!routes.deepl) throw new Error('unexpected DeepL request');
      return routes.deepl(call);
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  return {
    fetchHttp,
    calls,
    deeplCalls: () => calls.filter((c) => c.url === DEEPL_ONESHOT_FREE_ENDPOINT),
    appStoreCalls: () => calls.filter((c) => c.url.startsWith('https://itunes.apple.com/lookup')),
  };
}

const IDENTITY = { appVersion: '26.60', instanceId: 'instance-1', sessionId: 'session-1' };

test('buildDeeplRequestBody mirrors the iOS client payload (field order included)', () => {
  const body = JSON.parse(buildDeeplRequestBody(['Hello'], 'en', IDENTITY)) as Record<
    string,
    unknown
  >;
  assert.deepEqual(body, {
    text: ['Hello'],
    target_lang: 'pt-BR',
    source_lang: 'en',
    usage_type: 'translate',
    app_information: {
      os: 'iOS',
      os_version: '26.0',
      app_version: '26.60',
      app_build: '5443737',
      instance_id: 'instance-1',
    },
  });
  assert.deepEqual(Object.keys(body), [
    'text',
    'target_lang',
    'source_lang',
    'usage_type',
    'app_information',
  ]);

  // `auto` means "let DeepL detect it": the field is omitted, not sent as "auto"
  const auto = JSON.parse(buildDeeplRequestBody(['こんにちは'], 'auto', IDENTITY)) as Record<
    string,
    unknown
  >;
  assert.equal('source_lang' in auto, false);
  assert.equal(
    (JSON.parse(buildDeeplRequestBody(['こんにちは'], 'ja', IDENTITY)) as { source_lang: string })
      .source_lang,
    'ja',
  );
});

test('buildDeeplHeaders sends the anonymous iOS identity with a User-Agent matching the app version', () => {
  const headers = buildDeeplHeaders(IDENTITY);
  assert.equal(headers.Authorization, 'None');
  assert.equal(headers['User-Agent'], buildDeeplUserAgent('26.60'));
  assert.match(headers['User-Agent'], /^DeepL\/26\.60 CFNetwork\/[\d.]+ Darwin\/[\d.]+$/);
  assert.equal(headers['x-app-os-version'], '26.0');
  assert.equal(headers['x-app-instance-id'], 'instance-1');
  assert.equal(headers['x-app-session-id'], 'session-1');
});

test('parseDeeplResponse accepts only exactly aligned, non-empty translations', () => {
  const ok = JSON.stringify({
    translations: [{ text: 'Olá' }, { text: 'Mundo', detected_source_language: 'EN' }],
  });
  assert.deepEqual(parseDeeplResponse(ok, 2), ['Olá', 'Mundo']);

  assert.equal(parseDeeplResponse(ok, 3), null, 'count mismatch');
  assert.equal(
    parseDeeplResponse(JSON.stringify({ translations: [{ text: '' }] }), 1),
    null,
    'empty entry',
  );
  assert.equal(
    parseDeeplResponse(JSON.stringify({ translations: [{ text: '   ' }] }), 1),
    null,
    'blank entry',
  );
  assert.equal(parseDeeplResponse(JSON.stringify({ translations: [{}] }), 1), null, 'missing text');
  assert.equal(parseDeeplResponse(JSON.stringify({ translations: 'nope' }), 1), null);
  assert.equal(parseDeeplResponse(JSON.stringify({ result: {} }), 1), null);
  assert.equal(parseDeeplResponse('not json', 1), null);
  assert.equal(parseDeeplResponse('', 1), null);
});

test('parseAppStoreLookup only trusts an unmistakable DeepL iOS listing with a plausible version', () => {
  assert.equal(parseAppStoreLookup(appStorePayload('26.61.2')), '26.61.2');

  assert.equal(parseAppStoreLookup(appStorePayload('26.61', { bundleId: 'com.evil.app' })), null);
  assert.equal(
    parseAppStoreLookup(appStorePayload('26.61', { artistName: 'Somebody Else' })),
    null,
  );
  assert.equal(parseAppStoreLookup(appStorePayload('26.61', { trackId: 42 })), null);
  assert.equal(parseAppStoreLookup(appStorePayload('latest')), null);
  assert.equal(parseAppStoreLookup(appStorePayload('26')), null);
  assert.equal(parseAppStoreLookup(JSON.stringify({ resultCount: 0, results: [] })), null);
  assert.equal(parseAppStoreLookup('not json'), null);

  assert.equal(isValidAppVersion('26.52'), true);
  assert.equal(isValidAppVersion('1.2.3.4'), true);
  assert.equal(isValidAppVersion('1.2.3.4.5'), false);
  assert.equal(isValidAppVersion('26.x'), false);
});

test('translateTextsWithDeepl posts the oneshot request with the App Store version and returns results in order', async () => {
  resetDeeplTranslatorState();
  const { fetchHttp, calls, deeplCalls } = createFetch({
    appStore: (c) => reply(c.url, 200, appStorePayload('26.77.1')),
    deepl: healthyDeepl,
  });

  const result = await translateTextsWithDeepl(fetchHttp, ['Hello world.', 'Second line.'], {
    sourceLang: 'en',
  });
  assert.deepEqual(result, ['PT: Hello world.', 'PT: Second line.']);

  // The version lookup happens first, then exactly one translation request
  assert.equal(calls[0].url.startsWith('https://itunes.apple.com/lookup?id=1552407475'), true);
  assert.equal(deeplCalls().length, 1);

  const { options } = deeplCalls()[0];
  assert.equal(options.method, 'POST');
  assert.equal(options.contentType, 'application/json');
  assert.equal(options.headers?.Authorization, 'None');
  assert.match(options.headers?.['User-Agent'] || '', /^DeepL\/26\.77\.1 CFNetwork\//);
  const body = JSON.parse(options.body || '{}') as {
    text: string[];
    source_lang: string;
    target_lang: string;
    app_information: { app_version: string };
  };
  assert.deepEqual(body.text, ['Hello world.', 'Second line.']);
  assert.equal(body.source_lang, 'en');
  assert.equal(body.target_lang, 'pt-BR');
  assert.equal(body.app_information.app_version, '26.77.1');
});

test('the App Store lookup is cached, shared by concurrent callers, and keeps a stable app identity', async () => {
  resetDeeplTranslatorState();
  const { fetchHttp, deeplCalls, appStoreCalls } = createFetch({
    appStore: (c) => reply(c.url, 200, appStorePayload('26.70')),
    deepl: healthyDeepl,
  });

  // Two cold callers racing must trigger a single lookup...
  await Promise.all([
    translateTextsWithDeepl(fetchHttp, ['One']),
    translateTextsWithDeepl(fetchHttp, ['Two']),
  ]);
  await translateTextsWithDeepl(fetchHttp, ['Three']);

  assert.equal(appStoreCalls().length, 1);
  assert.equal(deeplCalls().length, 3);

  // ...and the caller that arrived while it was in flight must WAIT for the real version instead
  // of sending the stale pinned one (a stale version is what DeepL answers with HTTP 429).
  for (const call of deeplCalls()) {
    assert.match(call.options.headers?.['User-Agent'] || '', /^DeepL\/26\.70 /);
    assert.equal(
      (JSON.parse(call.options.body || '{}') as { app_information: { app_version: string } })
        .app_information.app_version,
      '26.70',
    );
  }

  const identities = deeplCalls().map((c) => ({
    instance: c.options.headers?.['x-app-instance-id'],
    session: c.options.headers?.['x-app-session-id'],
  }));
  assert.equal(new Set(identities.map((i) => i.instance)).size, 1, 'instance id is stable');
  assert.equal(new Set(identities.map((i) => i.session)).size, 1, 'session id is stable');
  assert.notEqual(identities[0].instance, identities[0].session);
  assert.match(
    identities[0].instance || '',
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

test('a failing App Store lookup falls back to the pinned version instead of blocking translation', async () => {
  resetDeeplTranslatorState();
  const { fetchHttp, deeplCalls } = createFetch({
    appStore: (c) => reply(c.url, 500),
    deepl: healthyDeepl,
  });

  assert.deepEqual(await translateTextsWithDeepl(fetchHttp, ['Hello']), ['PT: Hello']);
  assert.match(deeplCalls()[0].options.headers?.['User-Agent'] || '', /^DeepL\/\d+\.\d+/);
  assert.equal(
    (
      JSON.parse(deeplCalls()[0].options.body || '{}') as {
        app_information: { app_version: string };
      }
    ).app_information.app_version,
    '26.52',
  );
});

test('requests above the 1500 UTF-16 unit cap are rejected locally; the cap itself is allowed', async () => {
  resetDeeplTranslatorState();
  const { fetchHttp, calls, deeplCalls } = createFetch({ deepl: healthyDeepl });

  assert.equal(DEEPL_MAX_TEXT_UNITS, 1500);
  assert.equal(await translateTextsWithDeepl(fetchHttp, ['a'.repeat(1501)]), null);
  assert.equal(await translateTextsWithDeepl(fetchHttp, ['a'.repeat(1000), 'b'.repeat(501)]), null);
  assert.equal(calls.length, 0, 'oversized input must never reach the network');

  // An astral character is a surrogate pair: it counts as two units, like in JavaScript/Kotlin
  assert.equal(await translateTextsWithDeepl(fetchHttp, ['😀'.repeat(751)]), null);
  assert.equal(calls.length, 0);

  const atCap = await translateTextsWithDeepl(fetchHttp, ['a'.repeat(1500)]);
  assert.deepEqual(atCap, [`PT: ${'a'.repeat(1500)}`]);
  assert.equal(deeplCalls().length, 1);
});

test('blank entries are not sent and keep their position in the result', async () => {
  resetDeeplTranslatorState();
  const { fetchHttp, deeplCalls } = createFetch({ deepl: healthyDeepl });

  const result = await translateTextsWithDeepl(fetchHttp, ['Hello', '   ', 'World']);
  assert.deepEqual(result, ['PT: Hello', '   ', 'PT: World']);
  assert.deepEqual((JSON.parse(deeplCalls()[0].options.body || '{}') as { text: string[] }).text, [
    'Hello',
    'World',
  ]);

  const before = deeplCalls().length;
  assert.equal(await translateTextsWithDeepl(fetchHttp, ['', '  ']), null);
  assert.equal(await translateTextsWithDeepl(fetchHttp, []), null);
  assert.equal(deeplCalls().length, before, 'nothing to translate means no request');
});

test('HTTP 429 opens the circuit breaker for 30 minutes, then a new attempt is allowed', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let now = 1_000_000;
  resetDeeplTranslatorState({ now: () => now });
  let status = 429;
  const { fetchHttp, deeplCalls } = createFetch({
    deepl: (c) =>
      status === 429 ? reply(c.url, 429, { error: 'Too many requests' }) : healthyDeepl(c),
  });

  assert.equal(await translateTextsWithDeepl(fetchHttp, ['Hello']), null);
  assert.equal(deeplCalls().length, 1);
  assert.equal(isDeeplTranslatorAvailable(), false);

  // While paused no request leaves the process
  assert.equal(await translateTextsWithDeepl(fetchHttp, ['Hello again']), null);
  assert.equal(deeplCalls().length, 1);

  now += 29 * MINUTE;
  assert.equal(isDeeplTranslatorAvailable(), false);

  now += 2 * MINUTE;
  assert.equal(isDeeplTranslatorAvailable(), true);
  status = 200;
  assert.deepEqual(await translateTextsWithDeepl(fetchHttp, ['Back online']), ['PT: Back online']);
  assert.equal(deeplCalls().length, 2);
});

test('HTTP 403 also pauses DeepL and forces the app version to be looked up again', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let now = 5_000_000;
  resetDeeplTranslatorState({ now: () => now });
  let forbidden = true;
  const { fetchHttp, deeplCalls, appStoreCalls } = createFetch({
    appStore: (c) => reply(c.url, 200, appStorePayload('26.80')),
    deepl: (c) => (forbidden ? reply(c.url, 403, { title: 'OutdatedClient' }) : healthyDeepl(c)),
  });

  assert.equal(await translateTextsWithDeepl(fetchHttp, ['Hello']), null);
  assert.equal(isDeeplTranslatorAvailable(), false);
  assert.equal(appStoreCalls().length, 1);

  now += 31 * MINUTE;
  forbidden = false;
  assert.deepEqual(await translateTextsWithDeepl(fetchHttp, ['Hello']), ['PT: Hello']);
  assert.equal(appStoreCalls().length, 2, 'the possibly outdated version is refreshed');
  assert.equal(deeplCalls().length, 2);
});

test('three consecutive generic failures pause DeepL for 5 minutes; a success resets the counter', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let now = 9_000_000;
  resetDeeplTranslatorState({ now: () => now });
  let healthy = false;
  const { fetchHttp, deeplCalls } = createFetch({
    deepl: (c) => (healthy ? healthyDeepl(c) : reply(c.url, 500, 'boom')),
  });

  for (let i = 0; i < 3; i += 1) {
    assert.equal(isDeeplTranslatorAvailable(), true);
    assert.equal(await translateTextsWithDeepl(fetchHttp, ['Hello']), null);
  }
  assert.equal(isDeeplTranslatorAvailable(), false);
  assert.equal(await translateTextsWithDeepl(fetchHttp, ['Hello']), null);
  assert.equal(deeplCalls().length, 3, 'paused: no fourth request');

  // Half-open: after the pause a single failure re-opens the breaker immediately
  now += 5 * MINUTE + 1000;
  assert.equal(isDeeplTranslatorAvailable(), true);
  assert.equal(await translateTextsWithDeepl(fetchHttp, ['Hello']), null);
  assert.equal(isDeeplTranslatorAvailable(), false);
  assert.equal(deeplCalls().length, 4);

  // A success closes it for good: one later failure no longer trips it
  now += 5 * MINUTE + 1000;
  healthy = true;
  assert.deepEqual(await translateTextsWithDeepl(fetchHttp, ['Fine']), ['PT: Fine']);
  healthy = false;
  assert.equal(await translateTextsWithDeepl(fetchHttp, ['Hello']), null);
  assert.equal(isDeeplTranslatorAvailable(), true);
});

test('misaligned or malformed DeepL answers are rejected as a whole and counted as failures', async (t) => {
  t.mock.method(console, 'warn', () => {});
  resetDeeplTranslatorState();
  const bodies = [
    { translations: [{ text: 'Só uma' }] }, // asked for two
    { translations: [{ text: 'Olá' }, { text: '' }] }, // empty entry
    '<html>captcha</html>',
  ];
  let next = 0;
  const { fetchHttp, deeplCalls } = createFetch({
    deepl: (c) => reply(c.url, 200, bodies[next++]),
  });

  assert.equal(await translateTextsWithDeepl(fetchHttp, ['One', 'Two']), null);
  assert.equal(await translateTextsWithDeepl(fetchHttp, ['One', 'Two']), null);
  assert.equal(isDeeplTranslatorAvailable(), true);
  assert.equal(await translateTextsWithDeepl(fetchHttp, ['One', 'Two']), null);
  assert.equal(isDeeplTranslatorAvailable(), false, 'three bad answers in a row pause DeepL');
  assert.equal(deeplCalls().length, 3);
});

test('network errors never throw out of translateTextsWithDeepl', async (t) => {
  t.mock.method(console, 'warn', () => {});
  resetDeeplTranslatorState();
  const fetchHttp: HttpFetcher = async () => {
    throw new Error('socket hang up');
  };
  assert.equal(await translateTextsWithDeepl(fetchHttp, ['Hello']), null);
});

test('DeepL can be switched off programmatically or through DEEPL_WEB_ENABLED', async () => {
  const previous = process.env.DEEPL_WEB_ENABLED;
  try {
    resetDeeplTranslatorState();
    const { fetchHttp, calls } = createFetch({ deepl: healthyDeepl });

    setDeeplWebEnabled(false);
    assert.equal(isDeeplTranslatorAvailable(), false);
    assert.equal(await translateTextsWithDeepl(fetchHttp, ['Hello']), null);
    assert.equal(
      calls.length,
      0,
      'disabled means no network traffic at all (not even the version lookup)',
    );

    setDeeplWebEnabled(undefined);
    delete process.env.DEEPL_WEB_ENABLED;
    assert.equal(isDeeplTranslatorAvailable(), true);

    for (const off of ['false', 'FALSE', '0', 'off', 'no', ' false ']) {
      process.env.DEEPL_WEB_ENABLED = off;
      assert.equal(isDeeplTranslatorAvailable(), false, `"${off}" disables DeepL`);
    }
    for (const on of ['true', '1', 'yes', '']) {
      process.env.DEEPL_WEB_ENABLED = on;
      assert.equal(isDeeplTranslatorAvailable(), true, `"${on}" keeps DeepL enabled`);
    }

    process.env.DEEPL_WEB_ENABLED = 'false';
    setDeeplWebEnabled(true);
    assert.equal(
      isDeeplTranslatorAvailable(),
      true,
      'the programmatic override wins over the env var',
    );
  } finally {
    if (previous === undefined) delete process.env.DEEPL_WEB_ENABLED;
    else process.env.DEEPL_WEB_ENABLED = previous;
    resetDeeplTranslatorState();
  }
});
