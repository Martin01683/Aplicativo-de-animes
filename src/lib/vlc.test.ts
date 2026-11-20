import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildM3uPlaylist,
  buildVlcCliCommand,
  buildVlcProtocolUrl,
  sanitizeFilename,
} from './vlc.ts';

describe('vlc helpers', () => {
  it('generates valid EXTM3U playlist with referrer, user-agent, and subtitle options', () => {
    const m3u = buildM3uPlaylist([
      {
        title: 'Kusuriya no Hitorigoto 3 - EP 8',
        streamUrl: 'https://cdn.example.com/ep8.m3u8?token=123',
        referer: 'https://topanimes.net/',
        subtitleUrl: 'https://cdn.example.com/pt-br.vtt',
      },
      {
        title: 'Blocked unsafe entry',
        streamUrl: 'http://127.0.0.1:8080/secret.mp4',
      },
    ]);

    assert.ok(m3u.startsWith('#EXTM3U\n'));
    assert.ok(m3u.includes('#EXTINF:-1,Kusuriya no Hitorigoto 3 - EP 8'));
    assert.ok(m3u.includes('#EXTVLCOPT:http-referrer=https://topanimes.net/'));
    assert.ok(m3u.includes('#EXTVLCOPT:sub-file=https://cdn.example.com/pt-br.vtt'));
    assert.ok(m3u.includes('https://cdn.example.com/ep8.m3u8?token=123'));
    assert.ok(!m3u.includes('127.0.0.1'));
  });

  it('builds safe vlc:// protocol URLs and platform CLI commands', () => {
    assert.equal(
      buildVlcProtocolUrl('https://cdn.example.com/video.mp4'),
      'vlc://https://cdn.example.com/video.mp4'
    );
    assert.equal(buildVlcProtocolUrl('javascript:alert(1)'), '');

    const winCmd = buildVlcCliCommand(
      {
        title: 'Ep 8',
        streamUrl: 'https://cdn.example.com/video.m3u8',
        referer: 'https://topanimes.net/',
      },
      'windows'
    );
    assert.ok(winCmd.startsWith('vlc.exe "https://cdn.example.com/video.m3u8"'));
    assert.ok(winCmd.includes('--http-referrer="https://topanimes.net/"'));

    const linuxCmd = buildVlcCliCommand(
      {
        title: 'Ep 8',
        streamUrl: 'https://cdn.example.com/video.m3u8',
        subtitleUrl: 'https://cdn.example.com/sub.vtt',
      },
      'linux'
    );
    assert.ok(linuxCmd.startsWith("vlc 'https://cdn.example.com/video.m3u8'"));
    assert.ok(linuxCmd.includes("--sub-file='https://cdn.example.com/sub.vtt'"));
  });

  it('sanitizes filenames cleanly', () => {
    assert.equal(sanitizeFilename('Kusuriya no Hitorigoto 3 – Episódio 8!'), 'Kusuriya_no_Hitorigoto_3_Episodio_8');
  });
});
