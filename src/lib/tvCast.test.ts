import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  addManualTvCastDevice,
  buildCastMediaPayload,
  computeCastSeekPositionMs,
  computeCastVolumeLevel,
  computeSyncedCastPositionMs,
  dedupeCastDevices,
  formatCastDeliveryLabel,
  formatCastDurationMs,
  formatCastProtocolLabel,
  formatCastStatusLabel,
  IDLE_TV_CAST_STATE,
  markCastClockSeek,
  reconcileCastClock,
  resolveActiveTvCastDevice,
  resolveCastDisplayedPositionMs,
  sanitizeCastStateSnapshot,
  type TvCastDevice,
  type TvCastStateSnapshot,
} from './tvCast.ts';
import {
  buildDidlLiteMetadata,
  buildMdnsQueryPacket,
  buildSoapEnvelope,
  CAST_NS_RECEIVER,
  convertSrtToVtt,
  decodeCastV2Message,
  encodeCastV2Message,
  formatDlnaTime,
  frameCastV2Message,
  isChromecastVideoCapable,
  parseDlnaTimeMs,
  parseMdnsResponsePacket,
  parseSsdpHeaders,
  parseUpnpDeviceXml,
  rewriteM3u8ForServerLanProxy,
  selectLanIpForDeviceHost,
  UPNP_AV_TRANSPORT_SERVICE,
} from './serverTvCast.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

function readRepoFile(relPath: string): string {
  return readFileSync(resolve(ROOT, relPath), 'utf8');
}

describe('tvCast helpers', () => {
  it('deduplicates discovered TV devices and prioritizes Chromecast before DLNA sorted by name', () => {
    const list: TvCastDevice[] = [
      { id: 'dlna:2', name: 'TV Quarto', host: '192.168.1.20', port: 9197, protocol: 'dlna' },
      { id: 'cast:1', name: 'Sala Chromecast', host: '192.168.1.10', port: 8009, protocol: 'chromecast' },
      { id: 'dlna:1', name: 'LG OLED', host: '192.168.1.15', port: 1500, protocol: 'dlna' },
      { id: 'cast:1', name: 'Sala Chromecast Atualizada', host: '192.168.1.10', port: 8009, protocol: 'chromecast' },
    ];

    const deduped = dedupeCastDevices(list);
    assert.equal(deduped.length, 3);
    assert.equal(deduped[0].name, 'Sala Chromecast Atualizada');
    assert.equal(deduped[1].name, 'LG OLED');
    assert.equal(deduped[2].name, 'TV Quarto');
  });

  it('formats durations, protocol labels, status labels, and background delivery hints cleanly', () => {
    assert.equal(formatCastDurationMs(0), '0:00');
    assert.equal(formatCastDurationMs(65_000), '1:05');
    assert.equal(formatCastDurationMs(3_661_000), '1:01:01');

    assert.equal(formatCastProtocolLabel('chromecast'), 'Chromecast / Android TV');
    assert.equal(formatCastProtocolLabel('dlna'), 'Smart TV (DLNA)');
    assert.equal(formatCastStatusLabel('playing'), 'Reproduzindo na TV');
    assert.equal(formatCastStatusLabel('paused'), 'Pausado na TV');
    assert.match(formatCastDeliveryLabel('background-proxy'), /pode sair do app/i);
    assert.match(formatCastDeliveryLabel('direct'), /independente/i);
  });

  it('builds cast media payload with default subtitle selection and sanitized snapshot defaults', () => {
    const payload = buildCastMediaPayload({
      stream: { label: '1080p', height: 1080, url: 'https://cdn.example.com/ep1.m3u8', format: 'hls' },
      subtitles: [
        { label: 'EN', url: 'https://cdn.example.com/en.vtt', isDefault: false },
        { label: 'PT-BR', url: 'https://cdn.example.com/pt.srt', isDefault: true },
      ],
      referer: 'https://topanimes.net/',
      episodeUrl: 'https://topanimes.net/episodio/frieren-1/',
      title: 'Frieren — EP 1',
      seriesTitle: 'Frieren',
      startPositionMs: 123_456.7,
      durationMs: 1_440_000,
      autoPlayNextEpisode: true,
      nextUrl: 'https://topanimes.net/episodio/frieren-2/',
    });

    assert.equal(payload.streamFormat, 'hls');
    assert.equal(payload.subtitleUrl, 'https://cdn.example.com/pt.srt');
    assert.equal(payload.subtitleLabel, 'PT-BR');
    assert.equal(payload.startPositionMs, 123_457);
    assert.equal(payload.autoPlayNextEpisode, true);

    const sanitized = sanitizeCastStateSnapshot({ active: true, status: 'playing', volume: 2.5 });
    assert.equal(sanitized.active, true);
    assert.equal(sanitized.volume, 1);
    assert.deepEqual(sanitizeCastStateSnapshot(null), IDLE_TV_CAST_STATE);
  });

  it('computes clamped seek/volume positions and preserves drag/pending seek targets without snapping back', () => {
    // 23:39 = 1,419,000 ms on a 200px wide track starting at x=50
    assert.equal(computeCastSeekPositionMs(50, 50, 200, 1_419_000), 0);
    assert.equal(computeCastSeekPositionMs(150, 50, 200, 1_419_000), 710_000);
    assert.equal(computeCastSeekPositionMs(300, 50, 200, 1_419_000), 1_419_000);
    assert.equal(computeCastSeekPositionMs(-20, 50, 200, 1_419_000), 0);

    assert.equal(computeCastVolumeLevel(50, 50, 200), 0);
    assert.equal(computeCastVolumeLevel(150, 50, 200), 0.5);
    assert.equal(computeCastVolumeLevel(260, 50, 200), 1);

    // While user holds/drags, scrubPositionMs owns the bar even if live TV poll is still at 0:00
    assert.equal(
      resolveCastDisplayedPositionMs({
        livePositionMs: 0,
        durationMs: 1_419_000,
        scrubPositionMs: 600_000,
        pendingSeekMs: 300_000,
      }),
      600_000
    );

    // After release, pendingSeekMs holds until TV catches up or expires
    assert.equal(
      resolveCastDisplayedPositionMs({
        livePositionMs: 0,
        durationMs: 1_419_000,
        scrubPositionMs: null,
        pendingSeekMs: 600_000,
        pendingSeekExpired: false,
      }),
      600_000
    );

    // Once expired/settled, live TV position takes over cleanly
    assert.equal(
      resolveCastDisplayedPositionMs({
        livePositionMs: 602_000,
        durationMs: 1_419_000,
        scrubPositionMs: null,
        pendingSeekMs: 600_000,
        pendingSeekExpired: true,
      }),
      602_000
    );
  });

  it('keeps cast clock synchronized after seek even when DLNA TV emits 0:00 during buffering or playback', () => {
    const baseState: TvCastStateSnapshot = {
      ...IDLE_TV_CAST_STATE,
      active: true,
      status: 'playing',
      deviceId: 'dlna:lg-webos',
      deviceName: '[LG] webOS TV',
      deviceProtocol: 'dlna',
      deliveryMode: 'background-proxy',
      episodeUrl: 'https://topanimes.net/episodio/anime-1/',
      episodeTitle: 'Episódio 1',
      positionMs: 15_000,
      durationMs: 1_419_000,
    };

    // Initial lock
    let clock = reconcileCastClock(null, baseState, 10_000);
    assert.ok(clock);
    assert.equal(computeSyncedCastPositionMs(clock, baseState.durationMs, 10_000), 15_000);

    // User drags to 12:00 (720_000 ms) and releases at t=20_000
    clock = markCastClockSeek(clock, baseState, 720_000, 20_000);
    assert.equal(computeSyncedCastPositionMs(clock, baseState.durationMs, 20_000), 720_000);

    // Immediate optimistic echo from TvCastService at t=20_100 must NOT disarm seek protection
    clock = reconcileCastClock(clock, { ...baseState, positionMs: 720_000 }, 20_100);
    assert.ok(clock);
    assert.equal(clock.seekPendingTargetMs, 720_000);

    // 1.5s later, LG TV transitions/buffers and reports RelTime = 00:00:00 -> MUST NOT reset to 0:00!
    clock = reconcileCastClock(
      clock,
      { ...baseState, status: 'buffering', positionMs: 0 },
      21_500
    );
    assert.ok(clock);
    assert.ok(computeSyncedCastPositionMs(clock, baseState.durationMs, 22_000) >= 720_000);

    // Even if LG TV reports playing with RelTime stuck at 00:00:00, clock continues advancing smoothly
    clock = reconcileCastClock(
      clock,
      { ...baseState, status: 'playing', positionMs: 0 },
      23_000
    );
    assert.ok(clock);
    const estPlaying = computeSyncedCastPositionMs(clock, baseState.durationMs, 25_000);
    assert.ok(estPlaying >= 723_000 && estPlaying <= 726_000);

    // Once LG TV reports genuine advancing RelTime near target (725_000 ms at t=25_000), lock onto it
    clock = reconcileCastClock(
      clock,
      { ...baseState, status: 'playing', positionMs: 725_000 },
      25_000
    );
    assert.ok(clock);
    assert.equal(clock.seekPendingTargetMs, null);
    assert.equal(computeSyncedCastPositionMs(clock, baseState.durationMs, 25_000), 725_000);

    // Intentional seek back to 0:00 MUST be respected
    clock = markCastClockSeek(clock, baseState, 0, 30_000);
    clock = reconcileCastClock(clock, { ...baseState, status: 'playing', positionMs: 0 }, 30_200);
    assert.ok(clock);
    assert.equal(computeSyncedCastPositionMs(clock, baseState.durationMs, 30_200), 200);

    // Active device resolver matches by id, saved fallback, and name
    const lgDev: TvCastDevice = {
      id: 'dlna:lg-webos',
      name: '[LG] webOS TV',
      host: '192.168.1.40',
      port: 1581,
      protocol: 'dlna',
      avTransportControlUrl: 'http://192.168.1.40:1581/AVTransport/control',
    };
    assert.equal(resolveActiveTvCastDevice(baseState, [lgDev], null)?.id, 'dlna:lg-webos');
    assert.equal(resolveActiveTvCastDevice(baseState, [], lgDev)?.id, 'dlna:lg-webos');
    assert.equal(
      resolveActiveTvCastDevice({ ...baseState, deviceId: '' }, [lgDev], null)?.id,
      'dlna:lg-webos'
    );
  });
});

describe('Android background TV Cast architecture & UI wiring guards', () => {
  it('declares background mediaPlayback Foreground Service (stopWithTask=false) and Wi-Fi permissions in AndroidManifest', () => {
    const manifest = readRepoFile('android/app/src/main/AndroidManifest.xml');
    assert.match(manifest, /android\.permission\.FOREGROUND_SERVICE_MEDIA_PLAYBACK/);
    assert.match(manifest, /android\.permission\.FOREGROUND_SERVICE"/);
    assert.match(manifest, /android\.permission\.CHANGE_WIFI_MULTICAST_STATE/);
    assert.match(manifest, /android\.permission\.ACCESS_WIFI_STATE/);
    assert.match(manifest, /android\.permission\.WAKE_LOCK/);
    assert.match(
      manifest,
      /<service[\s\S]*?android:name="\.TvCastService"[\s\S]*?android:exported="false"[\s\S]*?android:stopWithTask="false"[\s\S]*?android:foregroundServiceType="mediaPlayback"/
    );
  });

  it('registers TvCastPlugin in MainActivity and implements Chromecast + DLNA + token-gated LAN proxy in TvCastService', () => {
    const mainActivity = readRepoFile(
      'android/app/src/main/java/com/topanimes/player/MainActivity.java'
    );
    const castService = readRepoFile(
      'android/app/src/main/java/com/topanimes/player/TvCastService.java'
    );
    const castPlugin = readRepoFile(
      'android/app/src/main/java/com/topanimes/player/TvCastPlugin.java'
    );
    const castDiscovery = readRepoFile(
      'android/app/src/main/java/com/topanimes/player/TvCastDiscovery.java'
    );
    const castProtocol = readRepoFile(
      'android/app/src/main/java/com/topanimes/player/TvCastProtocol.java'
    );

    assert.match(mainActivity, /registerPlugin\(TvCastPlugin\.class\);/);

    // Foreground service keeps casting alive when app is closed/swiped
    assert.match(castService, /ServiceInfo\.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK/);
    assert.match(castService, /ServiceCompat\.startForeground\(/);
    assert.match(castService, /public void onTaskRemoved\(Intent rootIntent\)/);
    assert.match(castService, /return START_STICKY;/);
    assert.match(castService, /new Notification\.MediaStyle\(\)/);
    assert.match(castService, /VlcPlayerActivity\.saveCastEpisodeProgress\(/);

    // Token-gated LAN proxy + CORS + DLNA headers + HLS LAN rewriting
    assert.match(castService, /InetAddress\.getByName\("0\.0\.0\.0"\)/);
    assert.match(castService, /Access-Control-Allow-Origin: \*/);
    assert.match(castService, /transferMode\.dlna\.org: Streaming/);
    assert.match(castService, /TvCastProtocol\.rewriteM3u8ForLanProxy\(/);

    // Dual protocols: Chromecast Default Media Receiver + DLNA AVTransport
    assert.match(castProtocol, /CHROMECAST_DEFAULT_MEDIA_RECEIVER_APP_ID\s*=\s*"CC1AD845"/);
    assert.match(castProtocol, /UPNP_AV_TRANSPORT_SERVICE\s*=\s*"urn:schemas-upnp-org:service:AVTransport:1"/);
    assert.match(castService, /SetAVTransportURI/);
    assert.match(castDiscovery, /_googlecast\._tcp\./);
    assert.match(castDiscovery, /239\.255\.255\.250/);

    // Capacitor plugin exposes discovery & background control APIs
    assert.match(castPlugin, /@CapacitorPlugin\(name = "TvCast"\)/);
    assert.match(castPlugin, /public void discoverDevices\(PluginCall call\)/);
    assert.match(castPlugin, /public void startCast\(PluginCall call\)/);
    assert.match(castPlugin, /public void prepareExternalCast\(PluginCall call\)/);
    assert.match(castPlugin, /ContextCompat\.startForegroundService\(/);
  });

  it('wires TV Cast button in VlcPlayerActivity, AnimePlayer, EpisodeWorkspace, and ActiveCastBar in App', () => {
    assert.ok(
      existsSync(resolve(ROOT, 'android/app/src/main/res/drawable/ic_player_cast.xml'))
    );
    const vlcLayout = readRepoFile('android/app/src/main/res/layout/activity_vlc_player.xml');
    const vlcJava = readRepoFile(
      'android/app/src/main/java/com/topanimes/player/VlcPlayerActivity.java'
    );
    const animePlayer = readRepoFile('src/components/AnimePlayer.tsx');
    const episodeWorkspace = readRepoFile('src/components/EpisodeWorkspace.tsx');
    const appTsx = readRepoFile('src/App.tsx');

    assert.match(vlcLayout, /android:id="@\+id\/vlc_btn_cast"/);
    assert.match(vlcJava, /btnCast = findViewById\(R\.id\.vlc_btn_cast\)/);
    assert.match(vlcJava, /public static void saveCastEpisodeProgress\(/);
    assert.match(vlcJava, /Continuar em 2º plano/);

    assert.match(animePlayer, /data-player-cast-btn="true"/);
    assert.match(episodeWorkspace, /data-episode-cast-btn="true"/);
    assert.match(appTsx, /<ActiveCastBar/);
    assert.match(appTsx, /<TvCastModal/);

    // Android discovery runs raw mDNS + ssdp:all alongside NsdManager
    const castDiscovery = readRepoFile(
      'android/app/src/main/java/com/topanimes/player/TvCastDiscovery.java'
    );
    assert.match(castDiscovery, /224\.0\.0\.251/);
    assert.match(castDiscovery, /SSDP_ALL_TARGET/);
    assert.match(castDiscovery, /startRawMdnsDiscovery/);
  });

  it('wires automatic Wi-Fi TV discovery and casting routes in server.ts and TvCastModal for Web + Android', () => {
    const serverTs = readRepoFile('server.ts');
    const modalTsx = readRepoFile('src/components/TvCastModal.tsx');

    assert.match(serverTs, /app\.get\('\/api\/tv-cast\/discover'/);
    assert.match(serverTs, /app\.get\('\/api\/tv-cast\/state'/);
    assert.match(serverTs, /app\.post\('\/api\/tv-cast\/start'/);
    assert.match(serverTs, /app\.post\('\/api\/tv-cast\/control'/);
    assert.match(serverTs, /app\.post\('\/api\/tv-cast\/stop'/);
    assert.match(serverTs, /app\.post\('\/api\/tv-cast\/prepare-link'/);
    assert.match(serverTs, /app\.get\('\/api\/tv-cast\/media\/:token\/:asset'/);

    // Web modal must NOT lock the automatic Wi-Fi TV list behind isNativeAndroid-only
    assert.match(modalTsx, /data-cast-wifi-discovery="true"/);
    assert.match(modalTsx, /canAutoDiscover\s*=\s*isNativeAndroid\s*\|\|\s*lanDiscoverySupported/);
    assert.match(modalTsx, /discoverTvCastDevicesDetailed/);

    // Seekbar must support touch press-hold-drag-release without flooding tvCastSeek on every drag pixel
    assert.match(modalTsx, /data-cast-seekbar="true"/);
    assert.match(modalTsx, /touch-none/);
    assert.match(modalTsx, /setPointerCapture/);
    assert.match(modalTsx, /onPointerUp=\{handleSeekPointerUp\}/);
    assert.doesNotMatch(modalTsx, /onChange=\{\(e\) => void tvCastSeek/);

    // Remote controls must stay reachable when leaving TvCastModal and allow switching video server on TV
    const activeBarTsx = readRepoFile('src/components/ActiveCastBar.tsx');
    const headerTsx = readRepoFile('src/components/Header.tsx');
    const episodeWorkspaceTsx = readRepoFile('src/components/EpisodeWorkspace.tsx');
    assert.match(activeBarTsx, /z-\[45\]/);
    assert.match(activeBarTsx, /safe-area-inset-bottom/);
    assert.match(activeBarTsx, /data-active-cast-open-controls="true"/);
    assert.match(headerTsx, /data-header-cast-btn="true"/);
    assert.match(modalTsx, /data-cast-server-switcher="true"/);
    assert.match(episodeWorkspaceTsx, /onSwitchTvCastServer/);
  });
});

describe('serverTvCast Node Wi-Fi discovery & protocol codecs', () => {
  it('encodes, frames, and decodes Google Cast V2 protobuf messages cleanly', () => {
    const jsonPayload = JSON.stringify({ type: 'LAUNCH', appId: 'CC1AD845', requestId: 7 });
    const encoded = encodeCastV2Message('sender-1', 'receiver-0', CAST_NS_RECEIVER, jsonPayload);
    const framed = frameCastV2Message(encoded);

    assert.equal(framed.readUInt32BE(0), encoded.length);
    const decoded = decodeCastV2Message(framed.subarray(4));
    assert.equal(decoded.protocolVersion, 0);
    assert.equal(decoded.sourceId, 'sender-1');
    assert.equal(decoded.destinationId, 'receiver-0');
    assert.equal(decoded.namespace, CAST_NS_RECEIVER);
    assert.equal(decoded.payloadType, 0);
    assert.equal(decoded.payloadUtf8, jsonPayload);
  });

  it('builds mDNS PTR queries and parses PTR/SRV/TXT/A Chromecast response packets', () => {
    const query = buildMdnsQueryPacket('_googlecast._tcp.local', 12, true);
    assert.equal(query.readUInt16BE(4), 1); // QDCOUNT
    assert.equal(query.readUInt16BE(query.length - 4), 12); // PTR
    assert.equal(query.readUInt16BE(query.length - 2), 0x8001); // QU + IN

    const encodeName = (name: string): Buffer => {
      const parts = name.split('.').map((label) => {
        const b = Buffer.from(label, 'utf8');
        return Buffer.concat([Buffer.from([b.length]), b]);
      });
      return Buffer.concat([...parts, Buffer.from([0])]);
    };

    const u16 = (v: number) => {
      const b = Buffer.alloc(2);
      b.writeUInt16BE(v, 0);
      return b;
    };
    const u32 = (v: number) => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(v, 0);
      return b;
    };

    const instance = 'Sala-TV._googlecast._tcp.local';
    const hostTarget = 'sala-tv.local';
    const ptrRdata = encodeName(instance);
    const srvRdata = Buffer.concat([u16(0), u16(0), u16(8009), encodeName(hostTarget)]);
    const txtRdata = Buffer.concat(
      ['fn=TV da Sala', 'md=Google TV', 'id=tv01', 'ca=4101'].map((kv) => {
        const b = Buffer.from(kv, 'utf8');
        return Buffer.concat([Buffer.from([b.length]), b]);
      })
    );
    const aRdata = Buffer.from([192, 168, 1, 77]);

    const header = Buffer.concat([u16(0), u16(0x8400), u16(0), u16(4), u16(0), u16(0)]);
    const rrPtr = Buffer.concat([
      encodeName('_googlecast._tcp.local'),
      u16(12),
      u16(1),
      u32(120),
      u16(ptrRdata.length),
      ptrRdata,
    ]);
    const rrSrv = Buffer.concat([
      encodeName(instance),
      u16(33),
      u16(1),
      u32(120),
      u16(srvRdata.length),
      srvRdata,
    ]);
    const rrTxt = Buffer.concat([
      encodeName(instance),
      u16(16),
      u16(1),
      u32(120),
      u16(txtRdata.length),
      txtRdata,
    ]);
    const rrA = Buffer.concat([
      encodeName(hostTarget),
      u16(1),
      u16(1),
      u32(120),
      u16(4),
      aRdata,
    ]);

    const parsed = parseMdnsResponsePacket(Buffer.concat([header, rrPtr, rrSrv, rrTxt, rrA]));
    assert.equal(parsed.ptrs[0]?.target, instance);
    assert.equal(parsed.srvs[0]?.port, 8009);
    assert.equal(parsed.srvs[0]?.target, hostTarget);
    assert.equal(parsed.txts[0]?.attrs.fn, 'TV da Sala');
    assert.equal(parsed.txts[0]?.attrs.md, 'Google TV');
    assert.equal(parsed.aRecords[0]?.ip, '192.168.1.77');

    assert.equal(isChromecastVideoCapable('4101'), true);
    assert.equal(isChromecastVideoCapable('4100'), false);
    assert.equal(isChromecastVideoCapable(''), true);
  });

  it('parses SSDP/UPnP Smart TV descriptions, builds DIDL-Lite + SOAP, and rewrites LAN HLS/SRT', async () => {
    const headers = parseSsdpHeaders(
      'HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.90:9197/dmr\r\nST: ssdp:all\r\n\r\n'
    );
    assert.equal(headers.location, 'http://192.168.1.90:9197/dmr');

    const xml =
      '<root><device>' +
      '<friendlyName>LG Smart TV &amp; Sala</friendlyName>' +
      '<manufacturer>LG</manufacturer>' +
      '<modelName>OLED55C3</modelName>' +
      '<UDN>uuid:lg-oled-55</UDN>' +
      '<serviceList>' +
      '<service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/AVTransport/control</controlURL></service>' +
      '<service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><controlURL>/RenderingControl/control</controlURL></service>' +
      '</serviceList></device></root>';

    const tv = parseUpnpDeviceXml(xml, 'http://192.168.1.90:9197/dmr');
    assert.ok(tv);
    assert.equal(tv.name, 'LG Smart TV & Sala');
    assert.equal(tv.protocol, 'dlna');
    assert.equal(tv.avTransportControlUrl, 'http://192.168.1.90:9197/AVTransport/control');
    assert.equal(tv.renderingControlUrl, 'http://192.168.1.90:9197/RenderingControl/control');

    const didl = buildDidlLiteMetadata({
      title: 'Frieren & Fern - EP 1',
      seriesTitle: 'Frieren',
      poster: 'https://img.example.com/p.jpg?a=1&b=2',
      mediaUrl: 'http://192.168.1.10:3000/api/tv-cast/media/tok/stream.mp4',
      mimeType: 'video/mp4',
    });
    assert.match(didl, /Frieren &amp; Fern - EP 1/);
    assert.match(didl, /DLNA\.ORG_OP=01;DLNA\.ORG_CI=0/);

    const soap = buildSoapEnvelope(UPNP_AV_TRANSPORT_SERVICE, 'Play', {
      InstanceID: '0',
      Speed: '1',
    });
    assert.match(soap, /<u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">/);

    assert.equal(formatDlnaTime(3_725_000), '01:02:05');
    assert.equal(parseDlnaTimeMs('01:02:05'), 3_725_000);
    assert.equal(parseDlnaTimeMs('NOT_IMPLEMENTED'), -1);

    const rewritten = rewriteM3u8ForServerLanProxy(
      '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:6,\nseg1.png\n',
      'https://cdn.example.com/hls/master.m3u8',
      'http://192.168.1.10:3000',
      'tok123',
      'https://topanimes.net/'
    );
    assert.ok(!rewritten.includes('127.0.0.1'));
    assert.match(rewritten, /http:\/\/192\.168\.1\.10:3000\/api\/tv-cast\/media\/tok123\/segment\.ts\?/);
    assert.match(rewritten, /&hls_seg=1/);

    const vtt = convertSrtToVtt('1\r\n00:00:01,500 --> 00:00:03,250\r\nOi TV!\r\n');
    assert.ok(vtt.startsWith('WEBVTT\n\n'));
    assert.ok(vtt.includes('00:00:01.500 --> 00:00:03.250'));

    const lanIp = selectLanIpForDeviceHost('192.168.1.90');
    assert.notEqual(lanIp, '127.0.0.1');

    const manual = await addManualTvCastDevice({ host: '192.168.1.55', name: 'TV Quarto' });
    assert.equal(manual.host, '192.168.1.55');
    assert.equal(manual.port, 8009);
    assert.equal(manual.protocol, 'chromecast');
    assert.equal(manual.name, 'TV Quarto');
  });
});
