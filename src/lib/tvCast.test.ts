import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
  hasRemoteTvControls,
  IDLE_TV_CAST_STATE,
  markCastClockSeek,
  parseHlsMasterVariants,
  reconcileCastClock,
  resolveActiveTvCastDevice,
  resolveCastDisplayedPositionMs,
  sanitizeCastStateSnapshot,
  stepCastVolumePercent,
  type TvCastDevice,
  type TvCastStateSnapshot,
} from './tvCast.ts';
import {
  buildDidlLiteMetadata,
  buildMdnsQueryPacket,
  buildSoapEnvelope,
  CAST_NS_RECEIVER,
  convertSrtToVtt,
  convertVttToSrt,
  decodeCastV2Message,
  encodeCastV2Message,
  formatDlnaTime,
  frameCastV2Message,
  isChromecastVideoCapable,
  isGenuineServerDlnaCompletion,
  parseDlnaMuteState,
  parseDlnaTimeMs,
  parseDlnaVolumeLevel,
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
    assert.equal(sanitized.volumeSynced, false);
    assert.equal(IDLE_TV_CAST_STATE.volume, 0);
    assert.equal(IDLE_TV_CAST_STATE.volumeSynced, false);
    const unsyncedDefault = sanitizeCastStateSnapshot({ active: true, status: 'connecting' });
    assert.equal(unsyncedDefault.volume, 0);
    assert.equal(unsyncedDefault.volumeSynced, false);
    const syncedSnapshot = sanitizeCastStateSnapshot({
      active: true,
      status: 'playing',
      volume: 0.28,
      muted: false,
      volumeSynced: true,
    });
    assert.equal(syncedSnapshot.volume, 0.28);
    assert.equal(syncedSnapshot.volumeSynced, true);
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
    assert.equal(computeCastVolumeLevel(52, 50, 200), 0.01);
    assert.equal(computeCastVolumeLevel(260, 50, 200), 1);

    assert.equal(stepCastVolumePercent(0.42, 1), 0.43);
    assert.equal(stepCastVolumePercent(0.42, -1), 0.41);
    assert.equal(stepCastVolumePercent(0, -1), 0);
    assert.equal(stepCastVolumePercent(1, 1), 1);

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
    assert.match(modalTsx, /handleRelativeSeek\(-5_000\)/);
    assert.match(modalTsx, /handleRelativeSeek\(5_000\)/);
    assert.match(modalTsx, /data-cast-volume-dec="true"/);
    assert.match(modalTsx, /data-cast-volume-inc="true"/);
    assert.match(modalTsx, /data-cast-volume-slider="true"/);
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

  it('syncs real TV volume & mute BEFORE starting playback on Android, Server, and UI (never defaults to 100%)', () => {
    const castService = readRepoFile(
      'android/app/src/main/java/com/topanimes/player/TvCastService.java'
    );
    const castProtocol = readRepoFile(
      'android/app/src/main/java/com/topanimes/player/TvCastProtocol.java'
    );
    const serverCast = readRepoFile('src/lib/serverTvCast.ts');
    const modalTsx = readRepoFile('src/components/TvCastModal.tsx');

    // Android protocol parses UPnP RenderingControl GetVolume / GetMute
    assert.match(castProtocol, /public static double parseDlnaVolumeLevel\(String xml\)/);
    assert.match(castProtocol, /public static Boolean parseDlnaMuteState\(String xml\)/);

    // Android TvCastService defaults volume to 0.0 (unsynced) and queries TV BEFORE loading media
    assert.match(castService, /private volatile double volume = 0\.0;/);
    assert.match(castService, /private volatile boolean volumeSynced = false;/);
    const androidSyncIdx = castService.indexOf('dlna.syncVolumeFromTv()');
    const androidLoadIdx = castService.indexOf('dlna.loadAndPlay(');
    assert.ok(androidSyncIdx > 0 && androidLoadIdx > androidSyncIdx, 'Android DLNA must sync volume before loadAndPlay');
    assert.match(castService, /pollCount\+\+;[\s\S]*?syncVolumeFromTv\(\);/);
    const androidGetStatusIdx = castService.indexOf('statusReq.put("type", "GET_STATUS");');
    const androidLaunchIdx = castService.indexOf('launch.put("type", "LAUNCH");');
    assert.ok(
      androidGetStatusIdx > 0 && androidLaunchIdx > androidGetStatusIdx,
      'Android Chromecast must query GET_STATUS before LAUNCH'
    );

    // Server Node TV Cast defaults volume to 0 (unsynced) and queries TV BEFORE starting playback
    assert.match(serverCast, /volume:\s*0,\s*\r?\n\s*muted:\s*false,\s*\r?\n\s*volumeSynced:\s*false/);
    const serverDlnaSyncIdx = serverCast.indexOf('await syncServerDlnaVolume(sess);');
    const serverDlnaPlayIdx = serverCast.indexOf("await sendDlnaSoap(device.avTransportControlUrl!, UPNP_AV_TRANSPORT_SERVICE, 'Play'");
    assert.ok(
      serverDlnaSyncIdx > 0 && serverDlnaPlayIdx > serverDlnaSyncIdx,
      'Server DLNA must sync volume before Play'
    );
    const serverCastGetStatusIdx = serverCast.indexOf("type: 'GET_STATUS',\r\n      requestId:");
    const serverCastGetStatusAltIdx = serverCast.indexOf("type: 'GET_STATUS',\n      requestId:");
    const serverCastStatusPos = serverCastGetStatusIdx > 0 ? serverCastGetStatusIdx : serverCastGetStatusAltIdx;
    const serverCastLaunchIdx = serverCast.indexOf("type: 'LAUNCH',");
    assert.ok(
      serverCastStatusPos > 0 && serverCastLaunchIdx > serverCastStatusPos,
      'Server Chromecast must query GET_STATUS before LAUNCH'
    );

    // UI guards relative -1%/+1% buttons and displays "--" instead of 100% until synced
    assert.match(modalTsx, /disabled=\{!volumeSynced\}/);
    assert.match(modalTsx, /data-cast-volume-value="true"/);
    assert.match(modalTsx, /volumeSynced \? `\$\{Math\.round\(volumePct\)\}%` : '--'/);
  });

  it('never uses Capacitor PluginCall.getLong() (which returns 0L for JSON Integer timestamps) and hardens DLNA seeking', () => {
    const javaDir = resolve(ROOT, 'android/app/src/main/java/com/topanimes/player');
    const javaFiles = readdirSync(javaDir).filter((f) => f.endsWith('.java'));
    for (const file of javaFiles) {
      const content = readFileSync(resolve(javaDir, file), 'utf8');
      assert.doesNotMatch(
        content,
        /\bcall\.getLong\(/,
        `${file} must not call Capacitor PluginCall.getLong() — org.json deserializes numbers < 2^31 as Integer, causing PluginCall.getLong() to silently return default 0L and restart TV/VLC playback from 00:00:00!`
      );
    }

    const castPlugin = readRepoFile(
      'android/app/src/main/java/com/topanimes/player/TvCastPlugin.java'
    );
    assert.match(castPlugin, /readLongParam\(call,\s*"positionMs",\s*0L\)/);
    assert.match(castPlugin, /readLongParam\(call,\s*"deltaMs",\s*0L\)/);
    assert.match(castPlugin, /readLongParam\(call,\s*"timeoutMs",\s*5500L\)/);

    const vlcPlugin = readRepoFile(
      'android/app/src/main/java/com/topanimes/player/NativeVlcPlayerPlugin.java'
    );
    assert.match(vlcPlugin, /readLongParam\(call,\s*"startPositionMs",\s*0L\)/);

    const localProxy = readRepoFile(
      'android/app/src/main/java/com/topanimes/player/LocalProxyPlugin.java'
    );
    assert.match(localProxy, /"HEAD"\.equalsIgnoreCase\(initialMethod\)/);
    assert.match(localProxy, /conn\.setRequestProperty\("Accept-Encoding",\s*"identity"\)/);

    const castProtocol = readRepoFile(
      'android/app/src/main/java/com/topanimes/player/TvCastProtocol.java'
    );
    const castService = readRepoFile(
      'android/app/src/main/java/com/topanimes/player/TvCastService.java'
    );
    assert.match(castProtocol, /DLNA\.ORG_FLAGS=01700000000000000000000000000000/);
    assert.match(castService, /DLNA\.ORG_FLAGS=01700000000000000000000000000000/);
    assert.match(castService, /absArgs\.put\("Unit",\s*"ABS_TIME"\)/);
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

    assert.equal(
      parseDlnaVolumeLevel('<GetVolumeResponse><CurrentVolume>0</CurrentVolume></GetVolumeResponse>'),
      0
    );
    assert.equal(
      parseDlnaVolumeLevel('<GetVolumeResponse><CurrentVolume>37</CurrentVolume></GetVolumeResponse>'),
      0.37
    );
    assert.equal(
      parseDlnaVolumeLevel('<GetVolumeResponse><CurrentVolume>120</CurrentVolume></GetVolumeResponse>'),
      1
    );
    assert.equal(parseDlnaVolumeLevel('<GetVolumeResponse></GetVolumeResponse>'), null);
    assert.equal(
      parseDlnaMuteState('<GetMuteResponse><CurrentMute>1</CurrentMute></GetMuteResponse>'),
      true
    );
    assert.equal(
      parseDlnaMuteState('<GetMuteResponse><CurrentMute>false</CurrentMute></GetMuteResponse>'),
      false
    );
    assert.equal(parseDlnaMuteState('<GetMuteResponse></GetMuteResponse>'), null);

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

  it('guards Bug #1/#2/#3/#4/#5 and Quality/Audio/Subtitles TV Cast features end-to-end', () => {
    // Bug #1: hasRemoteTvControls keeps controls visible for DLNA/Chromecast and hides only pure lan-link
    assert.equal(
      hasRemoteTvControls({ active: true, deviceProtocol: 'dlna', deliveryMode: 'background-proxy' }),
      true
    );
    assert.equal(
      hasRemoteTvControls({ active: true, deviceProtocol: 'chromecast', deliveryMode: 'direct' }),
      true
    );
    assert.equal(
      hasRemoteTvControls({ active: true, deviceProtocol: 'dlna', deliveryMode: 'lan-link' }),
      true
    );
    assert.equal(
      hasRemoteTvControls({ active: true, deviceProtocol: 'lan', deliveryMode: 'lan-link' }),
      false
    );
    assert.equal(
      hasRemoteTvControls({ active: false, deviceProtocol: 'dlna', deliveryMode: 'background-proxy' }),
      false
    );

    // Bug #2: reconcileCastClock uses stateTimestampMs to remove bridge latency & syncs paused at 0
    const tsBase: TvCastStateSnapshot = {
      ...IDLE_TV_CAST_STATE,
      active: true,
      status: 'playing',
      deviceId: 'dlna:lg',
      deviceName: 'LG TV',
      deviceProtocol: 'dlna',
      deliveryMode: 'background-proxy',
      episodeUrl: 'https://topanimes.net/episodio/test-1/',
      positionMs: 30_000,
      durationMs: 1_440_000,
      stateTimestampMs: 100_000,
    };
    let clock = reconcileCastClock(null, tsBase, 100_400);
    assert.ok(clock);
    assert.equal(computeSyncedCastPositionMs(clock, tsBase.durationMs, 100_400), 30_400);
    clock = reconcileCastClock(
      clock,
      { ...tsBase, status: 'paused', positionMs: 0, stateTimestampMs: 101_000 },
      101_000
    );
    assert.ok(clock);
    assert.equal(computeSyncedCastPositionMs(clock, tsBase.durationMs, 102_000), 0);

    // Bug #3: isGenuineServerDlnaCompletion prevents premature disconnects on short segments or single hiccups
    assert.equal(isGenuineServerDlnaCompletion(true, 0, 15_000, 5), false);
    assert.equal(isGenuineServerDlnaCompletion(true, 1_435_000, 1_440_000, 1), false);
    assert.equal(isGenuineServerDlnaCompletion(true, 1_435_000, 1_440_000, 2), false);
    assert.equal(isGenuineServerDlnaCompletion(true, 500_000, 1_440_000, 5), false);
    assert.equal(isGenuineServerDlnaCompletion(true, 1_432_000, 1_440_000, 3), true);

    // Alteração #1: VTT->SRT + DLNA DIDL-Lite subtitle sidecar + HLS master variants + subtitleDisabled payload
    const srt = convertVttToSrt('WEBVTT\n\n00:02.500 --> 00:05.000 align:center\n<b>Oi!</b>\n');
    assert.match(srt, /^1\n00:00:02,500 --> 00:00:05,000\nOi!/);

    const didlSub = buildDidlLiteMetadata({
      title: 'Ep 1',
      mediaUrl: 'http://192.168.1.10:3000/api/tv-cast/media/tok/stream.mp4',
      mimeType: 'video/mp4',
      subtitleUrl: 'http://192.168.1.10:3000/api/tv-cast/media/tok/subtitle.srt',
    });
    assert.match(didlSub, /protocolInfo="http-get:\*:text\/srt:\*"/);
    assert.match(didlSub, /sec:CaptionInfoEx sec:type="srt"/);

    const masterM3u8 = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=854x480',
      '480p/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080',
      '1080p/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720',
      'https://cdn.example.com/720p.m3u8',
    ].join('\n');
    const variants = parseHlsMasterVariants(masterM3u8, 'https://cdn.example.com/hls/master.m3u8');
    assert.equal(variants.length, 3);
    assert.equal(variants[0]?.label, '1080p');
    assert.equal(variants[0]?.url, 'https://cdn.example.com/hls/1080p/index.m3u8');
    assert.equal(variants[1]?.label, '720p');
    assert.equal(variants[2]?.label, '480p');

    const disabledSubPayload = buildCastMediaPayload({
      stream: { label: '1080p', height: 1080, url: 'https://cdn.example.com/ep.mp4', format: 'mp4' },
      subtitles: [{ label: 'PT-BR', url: 'https://cdn.example.com/pt.vtt', isDefault: true }],
      subtitleDisabled: true,
      qualityLabel: '1080p',
      audioLabel: 'Legendado',
      title: 'Ep 1',
    });
    assert.equal(disabledSubPayload.subtitleDisabled, true);
    assert.equal(disabledSubPayload.subtitleUrl, '');
    assert.equal(disabledSubPayload.subtitles?.length, 1);
    assert.equal(disabledSubPayload.qualityLabel, '1080p');
    assert.equal(disabledSubPayload.audioLabel, 'Legendado');

    // Static architecture guards across Android & UI
    const modal = readFileSync(resolve(ROOT, 'src/components/TvCastModal.tsx'), 'utf8');
    assert.match(modal, /hasRemoteTvControls\(castState\)/);
    assert.match(modal, /data-cast-server-selector="true"/);
    assert.match(modal, /data-cast-quality-selector="true"/);
    assert.match(modal, /data-cast-audio-selector="true"/);
    assert.match(modal, /data-cast-subtitle-selector="true"/);
    assert.ok(
      (modal.match(/data-cast-server-selector="true"/g) || []).length >= 2,
      'TvCastModal must show Servidor selector both before casting and during active cast'
    );

    const bar = readFileSync(resolve(ROOT, 'src/components/ActiveCastBar.tsx'), 'utf8');
    assert.match(bar, /hasRemoteTvControls\(castState\)/);

    const svc = readFileSync(
      resolve(ROOT, 'android/app/src/main/java/com/topanimes/player/TvCastService.java'),
      'utf8'
    );
    assert.match(svc, /EXTRA_PRESERVE_ACTIVE_CONTROLLER/);
    assert.match(svc, /ACTION_SET_TRACKS/);
    assert.match(svc, /EDIT_TRACKS_INFO/);
    assert.match(svc, /isSupportedCastSourceUrl/);
    assert.match(svc, /rewriteOfflineM3u8ForLanProxy/);
    assert.match(svc, /isGenuineDlnaCompletion/);
    assert.match(svc, /setKeepAlive\(true\)/);
    assert.match(svc, /shouldAvoidUpstreamHead/);
    assert.match(svc, /"bytes=0-0"/);
    assert.match(svc, /openLanHttpConnection/);
    assert.match(svc, /setUriAndPlayWithMetadata/);

    const vlc = readFileSync(
      resolve(ROOT, 'android/app/src/main/java/com/topanimes/player/VlcPlayerActivity.java'),
      'utf8'
    );
    assert.match(vlc, /currentStreamIsLocalOffline/);
    assert.match(vlc, /resolveEffectiveBufferedPositionMs/);
    assert.match(vlc, /!currentStreamIsLocalOffline && !hasProxyBufferTelemetry/);
    assert.match(vlc, /TvCastService\.clearErrorState\(\)/);

    // Follow-up regressions: Vidstreaming HLS->TS DLNA relay, stale error clearing, active-guarded menus, & LG volume resync
    assert.match(svc, /resolveDlnaHlsPlanIfApplicable/);
    assert.match(svc, /serveLanHlsContinuousRelay/);
    assert.match(svc, /normalizeDlnaVideoMimeType/);
    assert.match(svc, /clearErrorState\(\)/);
    assert.match(svc, /boolean justStartedPlaying = !sawPlaying && "PLAYING"\.equals\(transportState\)/);
    assert.match(svc, /dlna\.syncVolumeFromTv\(false\)/);
    assert.match(svc, /boolean sameDeviceReconnect = sessionActive/);

    const plugin = readFileSync(
      resolve(ROOT, 'android/app/src/main/java/com/topanimes/player/TvCastPlugin.java'),
      'utf8'
    );
    assert.match(plugin, /public void clearError\(PluginCall call\)/);

    const appTsx = readFileSync(resolve(ROOT, 'src/App.tsx'), 'utf8');
    assert.match(appTsx, /const clearStaleCastError = useCallback/);
    assert.match(appTsx, /\(tvCastState\.active && tvCastState\.episodeUrl\)/);
    assert.match(appTsx, /\(syncedTvCastState\.active \? syncedTvCastState\.audioLabel : ''\)/);
    assert.match(appTsx, /onDismissError=\{clearStaleCastError\}/);
    assert.match(modal, /data-cast-error-banner="true"/);

    const serverCast = readFileSync(resolve(ROOT, 'src/lib/serverTvCast.ts'), 'utf8');
    assert.match(serverCast, /await syncServerDlnaVolume\(sess, false\)/);
    assert.match(serverCast, /const justStartedPlaying = !sess\.dlnaSawPlaying && tState === 'PLAYING'/);

    // Off-main-thread remote Stop (prevents NetworkOnMainThreadException swallowing AVTransport#Stop) + selected readOnly chips
    assert.match(svc, /Looper\.myLooper\(\) == Looper\.getMainLooper\(\)/);
    assert.match(svc, /AnisyncCastRemoteStop/);
    assert.match(svc, /activeLanClientSockets/);
    assert.match(svc, /public static void requestStopImmediately\(\)/);
    assert.match(plugin, /TvCastService\.requestStopImmediately\(\)/);
    assert.ok(
      (modal.match(/data-selected="true"/g) || []).length >= 4,
      'TvCastModal must mark readOnly Quality and Audio chips as selected (orange) both before and during cast'
    );

    // Vidstreaming seek & playback time sync guards: frozen RelTime must never snap playing clock backwards
    let frozenClock = reconcileCastClock(
      null,
      { ...tsBase, status: 'playing', positionMs: 300_000, stateTimestampMs: 200_000 },
      200_000
    );
    assert.ok(frozenClock);
    frozenClock = reconcileCastClock(
      frozenClock,
      { ...tsBase, status: 'playing', positionMs: 300_000, stateTimestampMs: 203_000 },
      203_000
    );
    assert.ok(frozenClock);
    assert.equal(computeSyncedCastPositionMs(frozenClock, tsBase.durationMs, 203_000), 303_000);
    frozenClock = reconcileCastClock(
      frozenClock,
      { ...tsBase, status: 'playing', positionMs: 300_000, stateTimestampMs: 206_000 },
      206_000
    );
    assert.ok(frozenClock);
    assert.equal(computeSyncedCastPositionMs(frozenClock, tsBase.durationMs, 206_000), 306_000);
    frozenClock = reconcileCastClock(
      frozenClock,
      { ...tsBase, status: 'paused', positionMs: 306_000, stateTimestampMs: 206_500 },
      206_500
    );
    assert.ok(frozenClock);
    assert.equal(computeSyncedCastPositionMs(frozenClock, tsBase.durationMs, 210_000), 306_000);

    assert.match(svc, /findHlsSegmentIndexForSeek/);
    assert.match(svc, /resolveHlsRelayPositionMs/);
    assert.match(svc, /parseHttpByteRangeHeader/);
    assert.match(svc, /hlsRelaySwitching/);
    assert.match(svc, /seekRequestGen/);
    assert.match(svc, /activeHlsRelaySockets/);

    // YouTube-style notification artwork + Stop CustomAction + DLNA TimeSeekRange TV HUD sync guards
    assert.match(svc, /CUSTOM_ACTION_STOP_CAST/);
    assert.match(svc, /public void onCustomAction\(String action, Bundle extras\)/);
    assert.match(svc, /METADATA_KEY_ALBUM_ART/);
    assert.match(svc, /R\.drawable\.ic_cast_stop/);
    assert.match(svc, /ensurePosterArtworkLoaded/);
    assert.match(svc, /TimeSeekRange\.dlna\.org/);
    assert.match(svc, /parseDlnaTimeSeekRangeStartMs/);
    assert.match(svc, /formatDlnaTimeSeekRangeHeader/);
  });
});
