import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeeplHost, mergeForwardedHeaders } from './forwardedHeaders.ts';

const DEEPL_IDENTITY = {
  'User-Agent': 'DeepL/26.52 CFNetwork/3826.600.41 Darwin/25.0.0',
  'Accept-Language': 'en-US,en;q=0.9',
  'x-app-os-version': '26.0',
  'x-app-instance-id': 'instance-1',
  'x-app-session-id': 'session-1',
};

test('isDeeplHost matches deepl.com and its subdomains, and nothing that merely looks like them', () => {
  for (const host of [
    'deepl.com',
    'www.deepl.com',
    'www2.deepl.com',
    'oneshot-free.www.deepl.com',
    'API.DEEPL.COM',
  ]) {
    assert.equal(isDeeplHost(host), true, host);
  }
  for (const host of [
    'notdeepl.com',
    'xdeepl.com',
    'deepl.com.evil.io',
    'evil.io/deepl.com',
    'deepl.co',
    'deepl.community',
    'translate.googleapis.com',
    '',
  ]) {
    assert.equal(isDeeplHost(host), false, host);
  }
});

test('authorization, origin and cookie are still forwarded to any host, with trimmed values', () => {
  const target: Record<string, string> = { 'User-Agent': 'default-ua' };
  mergeForwardedHeaders(
    target,
    { Authorization: '  Bearer token ', Cookie: 'a=b', origin: 'https://example.com' },
    'api.thetvdb.com',
  );
  assert.deepEqual(target, {
    'User-Agent': 'default-ua',
    Authorization: 'Bearer token',
    Cookie: 'a=b',
    origin: 'https://example.com',
  });
});

test('DeepL identity headers are dropped for every other host, look-alikes included', () => {
  for (const host of [
    'translate.googleapis.com',
    'api.thetvdb.com',
    'notdeepl.com',
    'deepl.com.evil.io',
  ]) {
    const target: Record<string, string> = {
      'User-Agent': 'default-ua',
      'Accept-Language': 'pt-BR',
    };
    mergeForwardedHeaders(target, DEEPL_IDENTITY, host);
    assert.deepEqual(target, { 'User-Agent': 'default-ua', 'Accept-Language': 'pt-BR' }, host);
  }
});

test('on DeepL hosts the identity headers replace the defaults instead of duplicating them', () => {
  const target: Record<string, string> = {
    'User-Agent': 'Mozilla default',
    Accept: '*/*',
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
  };
  mergeForwardedHeaders(
    target,
    // lower-case names on purpose: HTTP header names are case-insensitive
    {
      'user-agent': DEEPL_IDENTITY['User-Agent'],
      'accept-language': DEEPL_IDENTITY['Accept-Language'],
      'x-app-os-version': DEEPL_IDENTITY['x-app-os-version'],
      'x-app-instance-id': DEEPL_IDENTITY['x-app-instance-id'],
      'x-app-session-id': DEEPL_IDENTITY['x-app-session-id'],
      Authorization: 'None',
    },
    'oneshot-free.www.deepl.com',
  );

  const names = Object.keys(target).map((name) => name.toLowerCase());
  assert.equal(new Set(names).size, names.length, `duplicate header names: ${names.join(', ')}`);
  assert.equal(target['user-agent'], DEEPL_IDENTITY['User-Agent']);
  assert.equal(target['User-Agent'], undefined, 'the default User-Agent is gone');
  assert.equal(target['accept-language'], DEEPL_IDENTITY['Accept-Language']);
  assert.equal(target['x-app-os-version'], '26.0');
  assert.equal(target['x-app-instance-id'], 'instance-1');
  assert.equal(target['x-app-session-id'], 'session-1');
  assert.equal(target.Authorization, 'None');
  assert.equal(target.Accept, '*/*', 'unrelated defaults are untouched');
});

test('headers outside the allowlist are never forwarded, not even to DeepL; blanks and missing input are ignored', () => {
  const target: Record<string, string> = { 'User-Agent': 'default-ua' };
  mergeForwardedHeaders(
    target,
    {
      Host: 'evil.example',
      'X-Forwarded-For': '10.0.0.1',
      Referer: 'https://evil.example',
      'Content-Length': '1',
      Authorization: '   ',
      'x-app-session-id': '',
    },
    'www.deepl.com',
  );
  assert.deepEqual(target, { 'User-Agent': 'default-ua' });

  assert.doesNotThrow(() => mergeForwardedHeaders(target, undefined, 'www.deepl.com'));
  assert.deepEqual(target, { 'User-Agent': 'default-ua' });
});
