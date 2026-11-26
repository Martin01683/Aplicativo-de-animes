import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  aes256CtrCrypt,
  encryptAbyssSoraToken,
  extractAbyssStreamsFromHtml,
  isAbyssEmbedUrl,
  md5AbyssNumericQuirk,
  md5Utf8,
} from './abyssDecoder.ts';
import type { HttpFetcher } from './httpTypes.ts';
import { pickPrimaryEmbedOption } from './prefetchCache.ts';
import { resolveTopAnimesEmbed } from './sources/providers/topanimesSource.ts';
import { extractStreamsFromEmbed, parseEpisodePageHtml } from './topanimesParser.ts';

function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), 'utf8');
}

function buildSyntheticAbyssHtml(params: {
  slug: string;
  md5_id: number;
  user_id: number;
  mediaObj: Record<string, unknown>;
  config?: Record<string, unknown>;
}): string {
  const secret = `${params.user_id}:${params.slug}:${params.md5_id}`;
  const md5Hex = crypto.createHash('md5').update(secret, 'utf8').digest('hex');
  const key = Buffer.from(md5Hex, 'utf8');
  const iv = key.subarray(0, 16);
  const cipher = crypto.createCipheriv('aes-256-ctr', key, iv);
  const enc = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(params.mediaObj), 'utf8')),
    cipher.final(),
  ]);
  const datasObj = {
    slug: params.slug,
    md5_id: params.md5_id,
    user_id: params.user_id,
    media: enc.toString('latin1'),
    config: params.config || {},
  };
  const b64 = Buffer.from(JSON.stringify(datasObj), 'latin1').toString('base64');
  return `<!doctype html><html><body><script src="https://iamcdn.net/player-v2/core.bundle.js"></script><script>const datas = "${b64}"; window.onload = () => SoTrym(datas);</script></body></html>`;
}

describe('Aniplay / Abyss native protocol decoder', () => {
  it('matches Node node:crypto MD5, numeric-quirk MD5, and AES-256-CTR bit-for-bit', () => {
    for (const sample of ['', 'abc', '384573:6Lio1p48-:32575116', 'Anisync-áéíóú-1234567890']) {
      const expected = crypto.createHash('md5').update(sample, 'utf8').digest('hex');
      assert.equal(md5Utf8(sample), expected);
    }

    const size = 296819217;
    const digitBuf = Buffer.from(Array.from(String(size), (ch) => Number(ch)));
    assert.equal(
      md5AbyssNumericQuirk(size),
      crypto.createHash('md5').update(digitBuf).digest('hex')
    );

    const key = Buffer.from(crypto.createHash('md5').update('test-key').digest('hex'), 'utf8');
    const iv = key.subarray(0, 16);
    const plain = Buffer.from(
      '/mp4/32575116/5/296819217?v=6Lio1p48-&extra=padding-over-two-aes-blocks-123456',
      'utf8'
    );
    const nodeCipher = crypto.createCipheriv('aes-256-ctr', key, iv);
    const expectedEnc = Buffer.concat([nodeCipher.update(plain), nodeCipher.final()]);

    const actualEnc = aes256CtrCrypt(new Uint8Array(plain), new Uint8Array(key), new Uint8Array(iv));
    assert.equal(Buffer.from(actualEnc).toString('hex'), expectedEnc.toString('hex'));

    const roundtrip = aes256CtrCrypt(actualEnc, new Uint8Array(key), new Uint8Array(iv));
    assert.equal(Buffer.from(roundtrip).toString('utf8'), plain.toString('utf8'));

    // Exact /sora/ double-base64 token check
    const pathStr = '/mp4/32575116/5/296819217?v=6Lio1p48-';
    const numKey = Buffer.from(crypto.createHash('md5').update(digitBuf).digest('hex'), 'utf8');
    const soraCipher = crypto.createCipheriv('aes-256-ctr', numKey, numKey.subarray(0, 16));
    const soraEnc = Buffer.concat([soraCipher.update(Buffer.from(pathStr, 'utf8')), soraCipher.final()]);
    const expectedToken = Buffer.from(soraEnc.toString('base64').replace(/=/g, ''), 'latin1')
      .toString('base64')
      .replace(/=/g, '');
    assert.equal(encryptAbyssSoraToken(pathStr, size), expectedToken);
  });

  it('recognizes all Abyss/Aniplay domains and extracts sorted MP4 streams, subtitles, and poster', () => {
    assert.equal(isAbyssEmbedUrl('https://abyssplayer.com/6Lio1p48-'), true);
    assert.equal(isAbyssEmbedUrl('https://abysscdn.com/?v=abc'), true);
    assert.equal(isAbyssEmbedUrl('https://play.abyss.to/v/xyz'), true);
    assert.equal(isAbyssEmbedUrl('https://short.icu/6Lio1p48-'), true);
    assert.equal(isAbyssEmbedUrl('https://topanimes.net/antivirus2/'), false);

    const html = buildSyntheticAbyssHtml({
      slug: '6Lio1p48-',
      md5_id: 32575116,
      user_id: 384573,
      mediaObj: {
        mp4: {
          sources: [
            { label: '480p', res_id: 3, size: 126534796, codec: 'h264', status: true, sub: 'sub480' },
            { label: '1080p', res_id: 5, size: 296819217, codec: 'av1', status: true, sub: 'subav1' },
            { label: '1080p', res_id: 5, size: 296819218, codec: 'h264', status: true, sub: 'sub1080' },
            { label: '2160p', res_id: 7, size: 999999999, codec: 'h264', status: true, sub: 'sub4k' },
          ],
          domains: [
            'sub480.sssrr.org',
            'subav1.sssrr.org',
            'sub1080.sssrr.org',
            'sub4k.sssrr.org',
          ],
        },
      },
      config: {
        poster: true,
        subtitles: [
          { lang: 'Portugu%C3%AAs%20(BR)', slug: 'ptbr01', type: 'vtt' },
          { lang: 'English', slug: 'en01', type: 'vtt' },
        ],
      },
    });

    const parsed = extractAbyssStreamsFromHtml(
      'https://abyssplayer.com/6Lio1p48-?thumbnail=https%3A%2F%2Fimage.tmdb.org%2Fp.jpg',
      html
    );
    assert.ok(parsed);
    assert.equal(parsed.provider, 'Aniplay');
    assert.equal(parsed.poster, 'https://image.tmdb.org/p.jpg');
    assert.deepEqual(
      parsed.streams.map((s) => s.label),
      ['1080p', '480p']
    );
    // Preferred h264 over av1 for 1080p and excluded 2160p
    assert.match(parsed.streams[0].url, /^https:\/\/sub1080\.sssrr\.org\/sora\/296819218\//);
    assert.equal(parsed.streams[0].format, 'mp4');
    assert.equal(parsed.subtitles.length, 2);
    assert.equal(parsed.subtitles[0].label, 'Português (BR)');
    assert.equal(parsed.subtitles[0].isDefault, true);
    assert.equal(parsed.subtitles[0].url, 'https://cdn.iamcdn.net/subtitle/32575116/ptbr01.vtt');

    // Also works seamlessly through topanimesParser.extractStreamsFromEmbed
    const viaParser = extractStreamsFromEmbed('https://abyssplayer.com/6Lio1p48-', html);
    assert.equal(viaParser.provider, 'Aniplay');
    assert.equal(viaParser.streams.length, 2);
  });

  it('includes Aniplay in episode parsing, resolves via short.icu redirect with proper Referer, and wires Android Java', async () => {
    const epHtml = `
      <html><body>
        <h1 id="titleHis">Frieren Episódio 1</h1>
        <ul id="playeroptionsul">
          <li class="dooplay_player_option" data-nume="1"><span class="title">aniplay</span></li>
        </ul>
        <div id="source-player-1">
          <iframe src="https://topanimes.net/aviso/?url=https%3A%2F%2Fshort.icu%2F6Lio1p48-"></iframe>
        </div>
      </body></html>
    `;
    const ep = parseEpisodePageHtml(epHtml, 'https://topanimes.net/episodio/frieren-1/');
    assert.equal(ep.options.length, 1);
    assert.equal(ep.options[0].label, 'Aniplay');
    assert.equal(ep.options[0].providerKind, 'abyss');
    assert.equal(ep.options[0].embedUrl, 'https://short.icu/6Lio1p48-');

    const primary = pickPrimaryEmbedOption(ep.options);
    assert.equal(primary?.nume, '1');

    const abyssHtml = buildSyntheticAbyssHtml({
      slug: '6Lio1p48-',
      md5_id: 32575116,
      user_id: 384573,
      mediaObj: {
        mp4: {
          sources: [{ label: '720p', res_id: 4, size: 247922224, codec: 'h264', status: true, sub: 'ygfi' }],
          domains: ['ygfi.sssrr.org'],
        },
      },
    });

    const mockFetch: HttpFetcher = async () => ({
      status: 200,
      ok: true,
      finalUrl: 'https://abyssplayer.com/6Lio1p48-',
      body: abyssHtml,
    });

    const resolved = await resolveTopAnimesEmbed(mockFetch, 'https://short.icu/6Lio1p48-');
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.provider, 'Aniplay');
    assert.equal(resolved.referer, 'https://abyssplayer.com/');
    assert.equal(resolved.preferDirect, false);
    assert.equal(resolved.streams.length, 1);
    assert.equal(resolved.streams[0].label, '720p');
    assert.match(resolved.streams[0].url, /^https:\/\/ygfi\.sssrr\.org\/sora\/247922224\//);

    // Verify Android native resolver & UI wiring
    const javaResolver = readRepoFile(
      'android/app/src/main/java/com/topanimes/player/TopAnimesEpisodeResolver.java'
    );
    assert.match(javaResolver, /extractAbyssStreams\(/);
    assert.match(javaResolver, /encryptAbyssSoraToken\(/);
    assert.match(javaResolver, /md5AbyssNumericQuirk\(/);
    assert.match(javaResolver, /AES\/CTR\/NoPadding/);
    assert.doesNotMatch(javaResolver, /if \("abyss"\.equals\(kind\)\) continue;/);

    const workspace = readRepoFile('src/components/EpisodeWorkspace.tsx');
    assert.doesNotMatch(workspace, /o\.providerKind !== 'abyss'/);
  });
});
