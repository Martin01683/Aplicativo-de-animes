import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { getStreamProxyUrl } from './apiClient.ts';
import {
  buildOfflineDownloadId,
  buildOfflineEpisodeDetails,
  buildOfflinePlayerOption,
  buildOfflineResolvedEmbed,
  canonicalOfflineEpisodeUrl,
  computeTotalOfflineBytes,
  formatDownloadSpeed,
  isLocalOfflinePlaybackUrl,
  OFFLINE_LOCAL_SERVER_NUME,
  pickBestOfflineStream,
  SerialDownloadQueue,
  type OfflineDownloadRecord,
} from './offlineDownloads.ts';
import { buildServerAria2Args } from './serverDownloadEngines.ts';
import {
  ARIA2_REPO_URL,
  buildAria2MaxSpeedArgs,
  buildYtDlpAria2Args,
  parseReleaseTagFromRedirectUrl,
  parseSha256SumsEntry,
  pickLatestStableAria2Tag,
  pickLatestStableYtDlpTag,
  YTDLP_REPO_URL,
} from '../../scripts/resolve-download-engines.mjs';

function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), 'utf8');
}

describe('offline video download engine helpers', () => {
  it('canonicalizes episode URLs and produces deterministic Android-safe download IDs', () => {
    const a = canonicalOfflineEpisodeUrl('https://topanimes.net/episodio/one-piece-1100/#player');
    const b = canonicalOfflineEpisodeUrl('https://TOPANIMES.NET/episodio/one-piece-1100');
    assert.equal(a, b);

    const idA = buildOfflineDownloadId('https://topanimes.net/episodio/one-piece-1100/');
    const idB = buildOfflineDownloadId('https://topanimes.net/episodio/one-piece-1100#top');
    const idOther = buildOfflineDownloadId('https://topanimes.net/episodio/one-piece-1101/');
    assert.equal(idA, idB);
    assert.notEqual(idA, idOther);
    assert.match(idA, /^[a-zA-Z0-9_-]{4,64}$/);

    const anisyncId = buildOfflineDownloadId('anisync://episode/tvdb/12345/s1/e2/');
    assert.equal(
      anisyncId,
      buildOfflineDownloadId('ANISYNC://episode/tvdb/12345/s1/e2#hash')
    );
    assert.match(anisyncId, /^[a-zA-Z0-9_-]{4,64}$/);
  });

  it('identifies local offline playback URLs and prevents double-proxying in getStreamProxyUrl', () => {
    assert.equal(
      isLocalOfflinePlaybackUrl('http://127.0.0.1:43210/offline/dl_abc_123/video.mp4'),
      true
    );
    assert.equal(
      isLocalOfflinePlaybackUrl('http://localhost:8080/offline/dl_abc_123/playlist.m3u8'),
      true
    );
    assert.equal(isLocalOfflinePlaybackUrl('blob:https://anisync.app/1234-5678'), true);
    assert.equal(isLocalOfflinePlaybackUrl('file:///storage/emulated/0/video.mp4'), true);

    assert.equal(isLocalOfflinePlaybackUrl('https://cdn.example.com/video.mp4'), false);
    assert.equal(isLocalOfflinePlaybackUrl(''), false);
    assert.equal(isLocalOfflinePlaybackUrl(null), false);

    const localLoopback = 'http://127.0.0.1:43210/offline/dl_12345678_87654321/video.mp4';
    assert.equal(getStreamProxyUrl(localLoopback), localLoopback);
    assert.equal(getStreamProxyUrl('blob:https://anisync.app/abc'), 'blob:https://anisync.app/abc');

    const remoteUrl = 'https://cdn.example.com/ep1.mp4';
    assert.match(getStreamProxyUrl(remoteUrl), /^\/api\/stream-proxy\?/);
  });

  it('picks the best stream for Android (highest res, MP4 tie-break) and Web (preferMp4)', () => {
    const streams = [
      { label: '720p', height: 720, url: 'https://cdn.test/720.mp4', format: 'mp4' as const },
      { label: '1080p', height: 1080, url: 'https://cdn.test/1080.m3u8', format: 'hls' as const },
    ];

    const nativePick = pickBestOfflineStream(streams, false);
    assert.equal(nativePick?.url, 'https://cdn.test/1080.m3u8');

    const webPick = pickBestOfflineStream(streams, true);
    assert.equal(webPick?.url, 'https://cdn.test/720.mp4');

    const tieStreams = [
      { label: '1080p HLS', height: 1080, url: 'https://cdn.test/1080.m3u8', format: 'hls' as const },
      { label: '1080p MP4', height: 1080, url: 'https://cdn.test/1080.mp4', format: 'mp4' as const },
    ];
    assert.equal(pickBestOfflineStream(tieStreams, false)?.url, 'https://cdn.test/1080.mp4');
  });

  it('builds offline PlayerOption, ResolvedEmbed, and EpisodeDetails with local playback priority', () => {
    const record: OfflineDownloadRecord = {
      id: 'dl_11111111_22222222',
      episodeUrl: 'https://topanimes.net/episodio/frieren-ep-2/',
      canonicalUrl: canonicalOfflineEpisodeUrl('https://topanimes.net/episodio/frieren-ep-2/'),
      title: 'Episódio 2',
      seriesTitle: 'Frieren',
      seriesUrl: 'https://topanimes.net/animes/frieren/',
      episodeLabel: 'T1 · EP 2',
      poster: 'https://img.test/frieren.jpg',
      isMovie: false,
      seasonNumber: 1,
      episodeNumber: 2,
      status: 'completed',
      progress: 100,
      downloadedBytes: 120_000_000,
      totalBytes: 120_000_000,
      sizeBytes: 120_000_000,
      format: 'mp4',
      qualityLabel: '1080p',
      storageKind: 'native',
      playbackUrl: 'http://127.0.0.1:41234/offline/dl_11111111_22222222/video.mp4',
      mediaFile: 'video.mp4',
      subtitles: [
        {
          label: 'Português (BR)',
          url: 'http://127.0.0.1:41234/offline/dl_11111111_22222222/sub_0.vtt',
          fileName: 'sub_0.vtt',
          isDefault: true,
        },
      ],
      savedAt: 1700000000000,
    };

    const opt = buildOfflinePlayerOption(record);
    assert.equal(opt.nume, OFFLINE_LOCAL_SERVER_NUME);
    assert.equal(opt.directStreamUrl, record.playbackUrl);
    assert.equal(opt.directSubtitles?.length, 1);

    const embed = buildOfflineResolvedEmbed(record);
    assert.equal(embed.status, 'resolved');
    assert.equal(embed.preferDirect, true);
    assert.equal(embed.streams[0]?.url, record.playbackUrl);
    assert.equal(embed.subtitles[0]?.url, record.subtitles[0]?.url);

    const details = buildOfflineEpisodeDetails(record, [
      { numberLabel: '1', episodeNumber: 1, title: 'Ep 1', url: 'https://topanimes.net/episodio/frieren-ep-1/' },
      { numberLabel: '2', episodeNumber: 2, title: 'Ep 2', url: 'https://topanimes.net/episodio/frieren-ep-2/' },
      { numberLabel: '3', episodeNumber: 3, title: 'Ep 3', url: 'https://topanimes.net/episodio/frieren-ep-3/' },
    ]);
    assert.equal(details.options[0]?.nume, OFFLINE_LOCAL_SERVER_NUME);
    assert.equal(details.prevUrl, 'https://topanimes.net/episodio/frieren-ep-1/');
    assert.equal(details.nextUrl, 'https://topanimes.net/episodio/frieren-ep-3/');

    const total = computeTotalOfflineBytes([
      record,
      { ...record, id: 'dl_partial', status: 'downloading', sizeBytes: 50_000_000 },
    ]);
    assert.equal(total, 120_000_000);
  });

  it('wires Android native offline plugin, loopback Range serving, VLC offline playback, and both UI entry points', () => {
    const mainActivity = readRepoFile(
      'android/app/src/main/java/com/topanimes/player/MainActivity.java'
    );
    assert.match(mainActivity, /registerPlugin\(OfflineDownloadsPlugin\.class\)/);

    const localProxy = readRepoFile(
      'android/app/src/main/java/com/topanimes/player/LocalProxyPlugin.java'
    );
    assert.match(localProxy, /if \(target\.startsWith\("\/offline\/"\)\)/);
    assert.match(localProxy, /handleOfflineMediaRequest\(/);
    assert.match(localProxy, /RandomAccessFile/);
    assert.match(localProxy, /206,\s*\r?\n\s*"Partial Content"/);

    const offlinePlugin = readRepoFile(
      'android/app/src/main/java/com/topanimes/player/OfflineDownloadsPlugin.java'
    );
    assert.match(offlinePlugin, /@CapacitorPlugin\(name = "OfflineDownloads"\)/);
    assert.match(offlinePlugin, /downloadMp4OrAutoHls/);
    assert.match(offlinePlugin, /downloadHlsStream/);
    assert.match(offlinePlugin, /findMpegTsSyncOffset/);
    assert.match(offlinePlugin, /findCompletedDownloadForEpisodeUrl/);

    const vlcActivity = readRepoFile(
      'android/app/src/main/java/com/topanimes/player/VlcPlayerActivity.java'
    );
    assert.match(vlcActivity, /isLocalOfflineUrl\(/);
    assert.match(vlcActivity, /:file-caching=300/);
    assert.match(vlcActivity, /OfflineDownloadsPlugin\.findCompletedDownloadForEpisodeUrl/);

    const workspace = readRepoFile('src/components/EpisodeWorkspace.tsx');
    assert.match(workspace, /o\.nume === OFFLINE_LOCAL_SERVER_NUME/);
    assert.match(workspace, /data-episode-download-btn="true"/);
    assert.match(workspace, /data-playing-offline-badge="true"/);

    const animeDetail = readRepoFile('src/components/AnimeDetailView.tsx');
    assert.match(animeDetail, /data-episode-download-btn="true"/);
    assert.match(animeDetail, /data-episode-offline-badge="true"/);

    const settings = readRepoFile('src/components/SettingsModal.tsx');
    assert.match(settings, /data-offline-downloads-section="true"/);
    assert.match(settings, /data-download-engine-info="true"/);
    assert.match(settings, /data-update-ytdlp-btn="true"/);
  });

  it('resolves latest stable aria2 and yt-dlp tags, validates SHA-256 sums, and tunes aria2c for maximum speed', () => {
    assert.equal(ARIA2_REPO_URL, 'https://github.com/aria2/aria2.git');
    assert.equal(YTDLP_REPO_URL, 'https://github.com/yt-dlp/yt-dlp.git');

    assert.equal(
      parseReleaseTagFromRedirectUrl('https://github.com/aria2/aria2/releases/tag/release-1.37.0'),
      'release-1.37.0'
    );
    assert.equal(
      parseReleaseTagFromRedirectUrl('https://github.com/yt-dlp/yt-dlp/releases/tag/2026.11.23'),
      '2026.11.23'
    );

    // Must pick highest stable version and ignore pre-releases/rc/alpha tags
    assert.equal(
      pickLatestStableAria2Tag([
        'release-1.36.0',
        'release-1.38.0-rc1',
        'release-1.37.0',
        'release-1.37.10',
        'release-1.37.2',
      ]),
      'release-1.37.10'
    );
    assert.equal(
      pickLatestStableYtDlpTag([
        '2026.10.01',
        '2026.11.23',
        '2026.11.23.1',
        '2026.12.01-nightly',
        '2026.11.09',
      ]),
      '2026.11.23.1'
    );

    const shaText = [
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  yt-dlp.exe',
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef  yt-dlp',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  *yt-dlp_linux',
    ].join('\n');
    assert.equal(
      parseSha256SumsEntry(shaText, 'yt-dlp'),
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    );
    assert.equal(parseSha256SumsEntry(shaText, 'missing'), '');

    const aria2Args = buildAria2MaxSpeedArgs({
      dir: '/tmp/dl',
      out: 'video.mp4',
      referer: 'https://topanimes.net/',
      caCertificate: '/tmp/ca.pem',
    });
    assert.ok(aria2Args.includes('--max-connection-per-server=16'));
    assert.ok(aria2Args.includes('--split=32'));
    assert.ok(aria2Args.includes('--min-split-size=1M'));
    assert.ok(aria2Args.includes('--max-concurrent-downloads=16'));
    assert.ok(aria2Args.includes('--file-allocation=none'));
    assert.ok(aria2Args.includes('--disk-cache=32M'));
    assert.ok(aria2Args.includes('--max-overall-download-limit=0'));
    assert.ok(aria2Args.includes('--max-download-limit=0'));
    assert.ok(aria2Args.includes('--enable-http-pipelining=true'));
    assert.ok(aria2Args.includes('--optimize-concurrent-downloads=true'));
    assert.ok(aria2Args.includes('--ca-certificate=/tmp/ca.pem'));

    const ytArgs = buildYtDlpAria2Args({
      aria2Binary: 'libaria2c.so',
      referer: 'https://topanimes.net/',
      outputTemplate: '/tmp/video.mp4',
    });
    assert.ok(ytArgs.includes('--downloader'));
    assert.ok(ytArgs.includes('libaria2c.so'));
    assert.ok(ytArgs.includes('--concurrent-fragments'));
    assert.ok(ytArgs.some((a) => a.includes('aria2c:') && a.includes('-x 16') && a.includes('-s 32')));

    const serverArgs = buildServerAria2Args({
      url: 'https://cdn.example.com/ep1.mp4',
      outDir: '/tmp/dl',
      outFileName: 'video.mp4',
      referer: 'https://topanimes.net/',
    });
    assert.ok(serverArgs.includes('--max-connection-per-server=16'));
    assert.ok(serverArgs.includes('--split=32'));
    assert.ok(serverArgs.includes('--max-overall-download-limit=0'));

    assert.equal(formatDownloadSpeed(0), '');
    assert.equal(formatDownloadSpeed(512 * 1024), '512 KB/s');
    assert.equal(formatDownloadSpeed(12.5 * 1024 * 1024), '12.5 MB/s');
  });

  it('wires CI latest-stable aria2 + yt-dlp build pipeline, Android packaging, and native/server engines', () => {
    const workflow = readRepoFile('.github/workflows/test.yml');
    assert.match(workflow, /node scripts\/resolve-download-engines\.mjs --github-output/);
    assert.match(workflow, /aria2-android-\$\{\{ steps\.resolve-engines\.outputs\.aria2_tag \}\}/);
    assert.match(workflow, /bash scripts\/build-aria2-android\.sh "\$ARIA2_TAG"/);
    assert.match(workflow, /bash scripts\/fetch-ytdlp-stable\.sh "\$YTDLP_TAG" "\$ARIA2_TAG"/);
    assert.match(workflow, /lib\/arm64-v8a\/libaria2c\.so/);
    assert.match(workflow, /assets\/download-engines\.json/);
    assert.match(workflow, /raw\/ytdlp/);

    const buildAria2 = readRepoFile('scripts/build-aria2-android.sh');
    assert.match(buildAria2, /https:\/\/github\.com\/aria2\/aria2\.git/);
    assert.match(buildAria2, /max-page-size=16384/);
    assert.match(buildAria2, /arm64-v8a armeabi-v7a x86_64/);
    assert.match(buildAria2, /libaria2c\.so/);
    assert.ok(!buildAria2.includes('\r'), 'scripts/build-aria2-android.sh must use pure LF endings');

    const fetchYtDlp = readRepoFile('scripts/fetch-ytdlp-stable.sh');
    assert.match(fetchYtDlp, /https:\/\/github\.com\/yt-dlp\/yt-dlp\.git/);
    assert.match(fetchYtDlp, /SHA2-256SUMS/);
    assert.match(fetchYtDlp, /res\/raw\/ytdlp|"\$RAW_DIR\/ytdlp"/);
    assert.match(fetchYtDlp, /download-engines\.json/);
    assert.ok(!fetchYtDlp.includes('\r'), 'scripts/fetch-ytdlp-stable.sh must use pure LF endings');

    const buildGradle = readRepoFile('android/app/build.gradle');
    assert.match(buildGradle, /useLegacyPackaging = true/);
    assert.match(buildGradle, /keepDebugSymbols \+= '\*\*\/\*\.zip\.so'/);
    assert.match(buildGradle, /io\.github\.junkfood02\.youtubedl-android:library:0\.18\.1/);
    assert.match(buildGradle, /exclude group: 'org\.jetbrains\.kotlin', module: 'kotlin-stdlib-jdk8'/);

    const manifest = readRepoFile('android/app/src/main/AndroidManifest.xml');
    assert.match(manifest, /android:extractNativeLibs="true"/);

    const engineMgr = readRepoFile(
      'android/app/src/main/java/com/topanimes/player/DownloadEngineManager.java'
    );
    assert.match(engineMgr, /ARIA2_MAX_CONNECTIONS_PER_SERVER = 16/);
    assert.match(engineMgr, /ARIA2_MAX_SPLITS = 32/);
    assert.match(engineMgr, /ARIA2_MAX_CONCURRENT_SEGMENTS = 16/);
    assert.match(engineMgr, /ensureCaCertificateBundle/);
    assert.match(engineMgr, /updateYtDlpStable/);
    assert.match(engineMgr, /extractStreamsWithYtDlp/);
    assert.match(engineMgr, /downloadWithYtDlpAndAria2/);
    assert.match(engineMgr, /SHA-256/);

    const offlinePlugin = readRepoFile(
      'android/app/src/main/java/com/topanimes/player/OfflineDownloadsPlugin.java'
    );
    assert.match(offlinePlugin, /downloadMp4WithAria2/);
    assert.match(offlinePlugin, /downloadMp4ParallelJava/);
    assert.match(offlinePlugin, /downloadHlsBatchWithAria2/);
    assert.match(offlinePlugin, /downloadHlsAssetsParallelJava/);
    assert.match(offlinePlugin, /public void getEngineInfo\(/);
    assert.match(offlinePlugin, /public void updateYtDlp\(/);
    assert.match(offlinePlugin, /public void resolveEmbedWithYtDlp\(/);

    const serverTs = readRepoFile('server.ts');
    assert.match(serverTs, /app\.get\('\/api\/download-engines\/status'/);
    assert.match(serverTs, /app\.post\('\/api\/download-engines\/resolve-embed'/);
    assert.match(serverTs, /app\.get\('\/api\/download-engines\/fast-download'/);

    // Configurable FIFO worker pool (defaults to 1, resizable up to 5) across Android native + UI
    assert.match(offlinePlugin, /DEFAULT_MAX_CONCURRENT_DOWNLOADS = 1/);
    assert.match(offlinePlugin, /ThreadPoolExecutor downloadExecutor = createDownloadExecutor\(\)/);
    assert.match(offlinePlugin, /public void setMaxConcurrentDownloads\(/);
    const animeDetail = readRepoFile('src/components/AnimeDetailView.tsx');
    assert.match(animeDetail, /data-episode-download-queued="true"/);
    assert.match(animeDetail, /data-season-download-desktop=\{group\.seasonNumber\}/);
    assert.match(animeDetail, /data-season-download-mobile=\{group\.seasonNumber\}/);
    assert.match(animeDetail, /Baixar temporada/);
    assert.match(animeDetail, /Temporada salva/);
    const workspace = readRepoFile('src/components/EpisodeWorkspace.tsx');
    assert.match(workspace, /data-episode-download-queued="true"/);
    const settings = readRepoFile('src/components/SettingsModal.tsx');
    assert.match(settings, /data-offline-queue-badge="true"/);
    assert.match(settings, /data-offline-clear-queue-btn="true"/);
    assert.match(settings, /data-offline-concurrency-selector="true"/);
    assert.match(settings, /data-offline-concurrency-option=\{count\}/);
  });

  it('executes 50 simultaneously enqueued downloads strictly in FIFO queue (max 1 concurrent) with cancellation and error resilience', async () => {
    let runningNow = 0;
    let maxConcurrent = 0;
    const completedOrder: number[] = [];
    const resolvers: Array<() => void> = [];

    const queue = new SerialDownloadQueue<number>(async (entry) => {
      runningNow += 1;
      maxConcurrent = Math.max(maxConcurrent, runningNow);
      try {
        await new Promise<void>((resolve) => {
          resolvers.push(resolve);
          setTimeout(resolve, 1);
        });
        if (entry.payload === 7) {
          throw new Error('Simulated failure on episode 7');
        }
        completedOrder.push(entry.payload);
      } finally {
        runningNow -= 1;
      }
    });

    // Enqueue 50 episodes simultaneously!
    const results = [];
    for (let i = 1; i <= 50; i += 1) {
      results.push(queue.enqueue(`ep_${i}`, i));
    }
    assert.equal(results.length, 50);
    // Duplicate enqueue while active/queued is ignored cleanly
    assert.equal(queue.enqueue('ep_10', 10).alreadyActiveOrQueued, true);

    // Cancel a queued episode (#25) before its turn arrives
    assert.equal(queue.removePending('ep_25'), true);

    // Wait for entire 50-item queue to drain
    while (queue.getActiveId() !== null || queue.getPendingIds().length > 0) {
      await new Promise((r) => setTimeout(r, 2));
    }

    assert.equal(maxConcurrent, 1, 'Never more than 1 download may run simultaneously');
    // 50 items minus #7 (failed) and #25 (cancelled) = 48 completed in strict FIFO order
    assert.equal(completedOrder.length, 48);
    assert.ok(!completedOrder.includes(7));
    assert.ok(!completedOrder.includes(25));
    for (let i = 1; i < completedOrder.length; i += 1) {
      assert.ok(
        completedOrder[i] > completedOrder[i - 1],
        `FIFO order violated at index ${i}: ${completedOrder[i - 1]} -> ${completedOrder[i]}`
      );
    }

    // Verify clearPending empties waiting items without crashing
    const holdResolvers: Array<() => void> = [];
    const clearQueue = new SerialDownloadQueue<number>(async () => {
      await new Promise<void>((resolve) => {
        holdResolvers.push(resolve);
      });
    });
    clearQueue.enqueue('a', 1);
    clearQueue.enqueue('b', 2);
    clearQueue.enqueue('c', 3);
    assert.deepEqual(clearQueue.getPendingIds(), ['b', 'c']);
    assert.deepEqual(clearQueue.clearPending(), ['b', 'c']);
    assert.deepEqual(clearQueue.getPendingIds(), []);
    holdResolvers.forEach((fn) => fn());
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(clearQueue.getActiveId(), null);
  });

  it('supports configurable concurrent downloads (default 1, up to 5) and wakes waiting items when limit increases', async () => {
    let activeNow = 0;
    let peakActive = 0;
    const startedIds: string[] = [];
    const resolvers = new Map<string, () => void>();

    const queue = new SerialDownloadQueue<number>(async (entry) => {
      activeNow += 1;
      peakActive = Math.max(peakActive, activeNow);
      startedIds.push(entry.id);
      try {
        await new Promise<void>((resolve) => {
          resolvers.set(entry.id, resolve);
        });
      } finally {
        activeNow -= 1;
      }
    });

    assert.equal(queue.getMaxConcurrency(), 1, 'Default concurrency must be 1');

    for (let i = 1; i <= 6; i += 1) {
      queue.enqueue(`ep_${i}`, i);
    }
    assert.equal(queue.getActiveCount(), 1);
    assert.deepEqual(queue.getPendingIds(), ['ep_2', 'ep_3', 'ep_4', 'ep_5', 'ep_6']);

    // Raising concurrency from 1 to 3 immediately wakes ep_2 and ep_3 in FIFO order!
    queue.setMaxConcurrency(3);
    assert.equal(queue.getMaxConcurrency(), 3);
    assert.equal(queue.getActiveCount(), 3);
    assert.deepEqual(queue.getActiveIds(), ['ep_1', 'ep_2', 'ep_3']);
    assert.deepEqual(queue.getPendingIds(), ['ep_4', 'ep_5', 'ep_6']);
    assert.equal(peakActive, 3);

    // Lowering concurrency back to 1 does not kill running tasks, and waits before starting ep_4
    queue.setMaxConcurrency(1);
    resolvers.get('ep_1')?.();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(queue.getActiveCount(), 2, 'Still 2 active (ep_2, ep_3); ep_4 waits for slot');
    assert.deepEqual(queue.getPendingIds(), ['ep_4', 'ep_5', 'ep_6']);

    // Raise to 2 -> ep_4 stays queued while 2 are active; finish ep_2 -> ep_4 starts
    queue.setMaxConcurrency(2);
    resolvers.get('ep_2')?.();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(queue.getActiveCount(), 2);
    assert.ok(startedIds.includes('ep_4'));

    // Drain remaining
    while (queue.getActiveCount() > 0 || queue.getPendingIds().length > 0) {
      for (const [id, done] of Array.from(resolvers.entries())) {
        resolvers.delete(id);
        done();
      }
      await new Promise((r) => setTimeout(r, 3));
    }

    assert.equal(peakActive, 3, 'Never exceeded configured peak concurrency of 3');
    assert.deepEqual(startedIds, ['ep_1', 'ep_2', 'ep_3', 'ep_4', 'ep_5', 'ep_6']);
  });
});
