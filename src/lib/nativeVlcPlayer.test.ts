import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  classifyPlayerTapZone,
  classifyVerticalSwipeAction,
  computeSwipeBrightness,
  computeSwipeVolume,
  findUpcomingNextEpisode,
  isSameEpisodeUrl,
  resolveSeriesPrevNext,
  shouldEnableDesktopShortcuts,
} from './nativeVlcPlayer.ts';
import type { AnimeEpisodeLink } from './types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

describe('nativeVlcPlayer & platform guards', () => {
  it('disables desktop keyboard shortcuts inside the native Android APK', () => {
    assert.equal(
      shouldEnableDesktopShortcuts(
        true,
        'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36'
      ),
      false
    );
    assert.equal(
      shouldEnableDesktopShortcuts(true, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'),
      false
    );
  });

  it('disables desktop keyboard shortcuts on Android mobile browsers', () => {
    assert.equal(
      shouldEnableDesktopShortcuts(
        false,
        'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36'
      ),
      false
    );
  });

  it('enables desktop keyboard shortcuts on desktop web browsers', () => {
    assert.equal(
      shouldEnableDesktopShortcuts(
        false,
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36'
      ),
      true
    );
    assert.equal(
      shouldEnableDesktopShortcuts(
        false,
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15'
      ),
      true
    );
  });

  it('matches episode URLs across trailing slashes and http/https variants', () => {
    assert.equal(
      isSameEpisodeUrl(
        'https://topanimes.net/episodio/frieren-episodio-5/',
        'http://www.topanimes.net/episodio/frieren-episodio-5'
      ),
      true
    );
    assert.equal(
      isSameEpisodeUrl(
        'https://topanimes.net/episodio/frieren-episodio-5/',
        'https://topanimes.net/episodio/frieren-episodio-6/'
      ),
      false
    );
  });

  it('resolves adjacent prev/next episodes for both ascending and descending episode lists', () => {
    const asc: AnimeEpisodeLink[] = [
      { numberLabel: '1', episodeNumber: 1, title: 'Ep 1', url: 'https://topanimes.net/episodio/a-ep-1/' },
      { numberLabel: '2', episodeNumber: 2, title: 'Ep 2', url: 'https://topanimes.net/episodio/a-ep-2/' },
      { numberLabel: '3', episodeNumber: 3, title: 'Ep 3', url: 'https://topanimes.net/episodio/a-ep-3/' },
    ];
    assert.deepEqual(resolveSeriesPrevNext(asc, 'https://topanimes.net/episodio/a-ep-2'), {
      currentIndex: 1,
      prevUrl: 'https://topanimes.net/episodio/a-ep-1/',
      nextUrl: 'https://topanimes.net/episodio/a-ep-3/',
    });

    const desc: AnimeEpisodeLink[] = [...asc].reverse();
    assert.deepEqual(resolveSeriesPrevNext(desc, 'https://topanimes.net/episodio/a-ep-2/'), {
      currentIndex: 1,
      prevUrl: 'https://topanimes.net/episodio/a-ep-1/',
      nextUrl: 'https://topanimes.net/episodio/a-ep-3/',
    });
  });

  it('never advances into unreleased/unavailable episodes and surfaces upcomingNextEpisode instead', () => {
    const mixed: AnimeEpisodeLink[] = [
      {
        numberLabel: 'EP 1',
        episodeNumber: 1,
        seasonNumber: 1,
        title: 'Ep 1',
        url: 'https://topanimes.net/episodio/a-ep-1/',
        availableOnServer: true,
      },
      {
        numberLabel: 'EP 2',
        episodeNumber: 2,
        seasonNumber: 1,
        title: 'Ep 2',
        url: 'https://topanimes.net/episodio/a-ep-2/',
        availableOnServer: true,
      },
      {
        numberLabel: 'EP 3',
        episodeNumber: 3,
        seasonNumber: 1,
        title: 'Ep 3',
        url: 'anisync://episode/anime/thetvdb/100/s1/e3',
        availableOnServer: false,
        date: '2026-11-29',
        airingAt: Math.floor(Date.parse('2026-11-29T19:00:00Z') / 1000),
        hasExactAiringTime: true,
      },
    ];

    // On the last available episode (EP 2), nextUrl must be undefined (never EP 3!)
    assert.deepEqual(resolveSeriesPrevNext(mixed, 'https://topanimes.net/episodio/a-ep-2/'), {
      currentIndex: 1,
      prevUrl: 'https://topanimes.net/episodio/a-ep-1/',
      nextUrl: undefined,
    });

    // findUpcomingNextEpisode identifies EP 3 so the player can show its release forecast
    const upcoming = findUpcomingNextEpisode(mixed, 'https://topanimes.net/episodio/a-ep-2/');
    assert.ok(upcoming);
    assert.equal(upcoming.episodeNumber, 3);
    assert.equal(upcoming.availableOnServer, false);

    // On EP 1, EP 2 is available so there is no unavailable upcoming next episode
    assert.equal(findUpcomingNextEpisode(mixed, 'https://topanimes.net/episodio/a-ep-1/'), undefined);
  });

  it('classifies left/center/right tap zones and vertical brightness vs volume sides', () => {
    assert.equal(classifyPlayerTapZone(120, 1000), 'left');
    assert.equal(classifyPlayerTapZone(500, 1000), 'center');
    assert.equal(classifyPlayerTapZone(820, 1000), 'right');
    assert.equal(classifyVerticalSwipeAction(300, 1000), 'brightness');
    assert.equal(classifyVerticalSwipeAction(600, 1000), 'volume');
  });

  it('computes clamped brightness and volume deltas cleanly for upward/downward swipes', () => {
    assert.ok(Math.abs(computeSwipeBrightness(0.5, -100, 400) - 0.75) < 0.001);
    assert.equal(computeSwipeBrightness(0.1, 200, 400), 0.01);
    assert.equal(computeSwipeBrightness(0.9, -200, 400), 1);

    assert.deepEqual(computeSwipeVolume(8, 15, -100, 300), {
      volume: 13,
      percent: 87,
      muted: false,
    });
    assert.deepEqual(computeSwipeVolume(3, 15, 300, 300), {
      volume: 0,
      percent: 0,
      muted: true,
    });
  });
});

// Regression: switching focus to another Android app destroys SurfaceView surfaces and causes
// LibVLC's AWindow.onSurfaceDestroyed() to detach views and disable the video track. Returning
// to TopAnimes left the video black because VlcPlayerActivity never re-attached views or restored
// playback in onStart()/onResume().
describe('VlcPlayerActivity - Android focus & LibVLC surface lifecycle', () => {
  const activityJava = readFileSync(
    resolve(ROOT, 'android/app/src/main/java/com/topanimes/player/VlcPlayerActivity.java'),
    'utf-8'
  );

  it('detaches LibVLC views and stops playback cleanly in onStop()', () => {
    const onStopMatch = activityJava.match(/protected void onStop\(\)[\s\S]*?\r?\n {4}\}/);
    assert.ok(onStopMatch, 'missing onStop() lifecycle override');
    assert.match(onStopMatch[0], /mediaPlayer\.stop\(\)/);
    assert.match(onStopMatch[0], /mediaPlayer\.detachViews\(\)/);
    assert.match(onStopMatch[0], /shouldStartPlaybackOnStart\s*=\s*true/);
  });

  it('re-attaches LibVLC views and restores video scale + playback on foreground return', () => {
    const onStartMatch = activityJava.match(/protected void onStart\(\)[\s\S]*?\r?\n {4}\}/);
    assert.ok(onStartMatch, 'missing onStart() lifecycle override');
    assert.match(onStartMatch[0], /attachVideoViewsIfNeeded\(\)/);
    assert.match(onStartMatch[0], /restorePlaybackAfterForeground\(/);

    const onResumeMatch = activityJava.match(/protected void onResume\(\)[\s\S]*?\r?\n {4}\}/);
    assert.ok(onResumeMatch, 'missing onResume() lifecycle override');
    assert.match(onResumeMatch[0], /enterImmersiveMode\(\)/);
    assert.match(onResumeMatch[0], /attachVideoViewsIfNeeded\(\)/);

    const attachHelperMatch = activityJava.match(
      /private void attachVideoViewsIfNeeded\(\)[\s\S]*?\r?\n {4}\}/
    );
    assert.ok(attachHelperMatch, 'missing attachVideoViewsIfNeeded() helper');
    assert.match(attachHelperMatch[0], /!mediaPlayer\.getVLCVout\(\)\.areViewsAttached\(\)/);
    assert.match(
      attachHelperMatch[0],
      /mediaPlayer\.attachViews\(videoLayout,\s*null,\s*true,\s*false\)/
    );
    assert.match(
      attachHelperMatch[0],
      /mediaPlayer\.setVideoScale\(SCALE_OPTIONS\[currentScaleIdx\]\)/
    );
  });

  it('registers and removes IVLCVout.Callback and handles Event.Vout for surface recovery', () => {
    assert.match(activityJava, /mediaPlayer\.getVLCVout\(\)\.addCallback\(voutCallback\)/);
    assert.match(activityJava, /mediaPlayer\.getVLCVout\(\)\.removeCallback\(voutCallback\)/);
    assert.match(activityJava, /case MediaPlayer\.Event\.Vout:/);
    assert.match(activityJava, /public void onWindowFocusChanged\(boolean hasFocus\)/);
  });

  it('defers playback start if stream preparation completes while activity is stopped', () => {
    const prepMatch = activityJava.match(
      /private void prepareAndPlayCurrentStream\(boolean pauseAfterFirstFrame\)[\s\S]*?\r?\n {4}\}/
    );
    assert.ok(prepMatch, 'missing prepareAndPlayCurrentStream(boolean)');
    assert.match(prepMatch[0], /if\s*\(!isActivityStarted\)/);
    assert.match(prepMatch[0], /attachVideoViewsIfNeeded\(\)/);
  });

  it('prevents runaway auto-advance on premature LibVLC EndReached events', () => {
    // 1. Must require real forward playback progress (not Vout + 0ms tick) before confirming playback started
    assert.match(activityJava, /long forwardProgressMs = timeMs - firstTimeChangedMs;/);
    assert.match(
      activityJava,
      /boolean confirmedWithVideo = hasActiveVout[\s\S]*?playbackTimeAdvanceCount >= 2[\s\S]*?forwardProgressMs >= 500L;/
    );

    // 2. Must validate genuine playback end (position vs duration + elapsed time) in Event.EndReached
    assert.match(
      activityJava,
      /private static boolean isGenuinePlaybackEndMs\(long posMs, long durMs\)/
    );
    assert.match(
      activityJava,
      /if\s*\(!hasPlaybackStartedForStream[\s\S]*?\|\|\s*!enoughWatchTime[\s\S]*?\|\|\s*!isGenuinePlaybackEndMs\(posMs, durMs\)\)/
    );
    assert.match(
      activityJava,
      /Premature EndReached[\s\S]*?handlePlaybackError\(\);[\s\S]*?return;/
    );

    // 3. Must assign activePlaybackSessionGen AFTER setMedia() and right before play()
    assert.match(
      activityJava,
      /activePlaybackSessionGen = -1L;[\s\S]*?mediaPlayer\.setMedia\(media\);[\s\S]*?activePlaybackSessionGen = \+\+sessionCounter;[\s\S]*?mediaPlayer\.play\(\);/
    );

    // 4. Must immediately clear Vout / TimeChanged / elapsed markers in loadEpisodeInFullscreen
    const loadEpMatch = activityJava.match(
      /private void loadEpisodeInFullscreen\(String rawTargetUrl, boolean saveOutgoingProgress\)[\s\S]*?\r?\n {4}\}/
    );
    assert.ok(loadEpMatch, 'missing loadEpisodeInFullscreen(String, boolean)');
    assert.match(loadEpMatch[0], /hasActiveVout = false;/);
    assert.match(loadEpMatch[0], /firstTimeChangedMs = -1L;/);
    assert.match(loadEpMatch[0], /userSeekedInCurrentStream = false;/);
    assert.match(loadEpMatch[0], /streamPreparedWallMs = 0L;/);
  });

  it('separates Legendas and Áudio into distinct menus in VlcPlayerActivity', () => {
    assert.doesNotMatch(activityJava, /Legendas & Áudio/);
    assert.match(
      activityJava,
      /addSettingsRow\("Legendas",\s*getActiveSubtitleSummary\(\),\s*false,\s*v\s*->\s*renderSettingsTab\("subs"\)\)/
    );
    assert.match(
      activityJava,
      /addSettingsRow\("Áudio",\s*getActiveAudioSummary\(\),\s*false,\s*v\s*->\s*renderSettingsTab\("audio"\)\)/
    );
    assert.match(activityJava, /if\s*\("subs"\.equals\(tab\)\)[\s\S]*?settingsHeaderTitle\.setText\("Legendas"\)/);
    assert.match(activityJava, /if\s*\("audio"\.equals\(tab\)\)[\s\S]*?settingsHeaderTitle\.setText\("Áudio"\)/);
  });

  it('labels subtitle/audio tracks with language instead of raw LibVLC "Track N"', () => {
    // Every external subtitle goes through attachSubtitleSlave so its label is remembered.
    const rawAddSlaveCalls = activityJava.match(/mediaPlayer\.addSlave\(/g) ?? [];
    assert.equal(rawAddSlaveCalls.length, 1, 'only attachSubtitleSlave may call mediaPlayer.addSlave');
    assert.match(
      activityJava,
      /private void attachSubtitleSlave\(Uri uri, boolean select, String label\)[\s\S]*?pendingSlaveSubtitleLabels\.addLast/
    );
    // ESAdded binds the next pending label to the new Text ES id.
    assert.match(
      activityJava,
      /case MediaPlayer\.Event\.ESAdded:[\s\S]*?IMedia\.Track\.Type\.Text[\s\S]*?slaveSubtitleLabelsById\.put\(esId, label\)/
    );
    // Menus and summaries use the language-aware label builder.
    assert.match(activityJava, /buildTrackLabels\(spuTracks, false\)/);
    assert.match(activityJava, /buildTrackLabels\(audioTracks, true\)/);
    assert.match(activityJava, /idioma não informado/);
    assert.doesNotMatch(activityJava, /formatSubtitleTrackName|formatAudioTrackName/);
  });
});

describe('Android TopAnimesEpisodeResolver & LocalProxyPlugin improvements', () => {
  const resolverJavaPath = resolve(
    ROOT,
    'android/app/src/main/java/com/topanimes/player/TopAnimesEpisodeResolver.java'
  );
  const proxyJavaPath = resolve(
    ROOT,
    'android/app/src/main/java/com/topanimes/player/LocalProxyPlugin.java'
  );
  const resolverJava = readFileSync(resolverJavaPath, 'utf8');
  const proxyJava = readFileSync(proxyJavaPath, 'utf8');

  it('parses JW Player sources & tracks in TopAnimesEpisodeResolver so KojimaCDN 1080p short-circuits', () => {
    assert.match(resolverJava, /Pattern\.compile\("sources\\\\s\*:\\\\s\*\(\\\\\[[\s\S]*?parseLooseJsArray/);
    assert.match(resolverJava, /Pattern\.compile\("tracks\\\\s\*:\\\\s\*\(\\\\\[[\s\S]*?parseLooseJsArray/);
    assert.match(resolverJava, /private static JSONArray parseLooseJsArray\(String raw\)/);
  });

  it('hydrates missing player iframes via doo_player_ajax / wp-json and filters new ad domains', () => {
    assert.match(resolverJava, /hydrateMissingDooPlayerSources\(html,\s*episodeUrl,\s*sourceMap\)/);
    assert.match(resolverJava, /action=doo_player_ajax&post=/);
    assert.match(resolverJava, /private static String postFormText\(/);
    assert.match(resolverJava, /metilinksemvoce\|viewanalitycs\|agl004\|videoad\|autotop\|canalfutebol/);
    assert.match(resolverJava, /private static String formatServerLabel\(String raw, String fallback\)/);
  });

  it('supports HTTP POST in LocalProxyPlugin.fetchPage for native DooPlay AJAX requests', () => {
    assert.match(proxyJava, /String rawMethod = call\.getString\("method",\s*"GET"\)/);
    assert.match(proxyJava, /String requestBody = call\.getString\("body",\s*null\)/);
    assert.match(proxyJava, /conn\.setDoOutput\(true\)/);
  });

  it('supports Hinata Soul episode, embed, and series episode resolution in TopAnimesEpisodeResolver', () => {
    assert.match(resolverJava, /public static boolean isHinataSoulUrl\(String rawUrl\)/);
    assert.match(resolverJava, /private static ResolvedEpisodeData resolveHinataSoulEpisode\(/);
    assert.match(resolverJava, /private static ResolvedEmbedData resolveHinataSoulEmbed\(/);
    assert.match(resolverJava, /private static List<EpisodeLink> fetchHinataSoulSeriesEpisodes\(/);
    assert.match(resolverJava, /ads\.animeyabu\.net\/adblock2\.php/);
  });

  it('keeps the centered Android play button unobstructed in AnimePlayer and VlcPlayerActivity', () => {
    const animePlayerTsx = readFileSync(
      resolve(ROOT, 'src/components/AnimePlayer.tsx'),
      'utf8'
    );
    const headerTsx = readFileSync(resolve(ROOT, 'src/components/Header.tsx'), 'utf8');
    const vlcLayoutXml = readFileSync(
      resolve(ROOT, 'android/app/src/main/res/layout/activity_vlc_player.xml'),
      'utf8'
    );
    const activityJava = readFileSync(
      resolve(ROOT, 'android/app/src/main/java/com/topanimes/player/VlcPlayerActivity.java'),
      'utf8'
    );

    // Center Play button sits above the bottom HUD (z-[35] when menus are closed) with touch-manipulation
    assert.match(
      animePlayerTsx,
      /aria-label="Reproduzir episódio"[\s\S]*?touch-manipulation[\s\S]*?menuOpen \|\| episodesOpen \? 'z-20' : 'z-\[35\]'/
    );
    // Outer bottom HUD gradient must be pointer-events-none so it never swallows taps over the center play button on mobile
    assert.match(
      animePlayerTsx,
      /pointer-events-none absolute inset-x-0 bottom-0 z-30 bg-gradient-to-t/
    );
    // Synchronous launch guard prevents duplicate native activity launches on rapid taps
    assert.match(animePlayerTsx, /nativeLaunchingRef\.current/);

    // Native fullscreen layout places vlc_btn_play_center after vlc_bottom_bar so it always stays on top
    const bottomBarIdx = vlcLayoutXml.indexOf('android:id="@+id/vlc_bottom_bar"');
    const centerBtnIdx = vlcLayoutXml.indexOf('android:id="@+id/vlc_btn_play_center"');
    assert.ok(bottomBarIdx > 0 && centerBtnIdx > bottomBarIdx, 'vlc_btn_play_center must follow vlc_bottom_bar');

    // Native togglePlayPause cancels stale single-tap HUD toggles and updates icons immediately
    const toggleMatch = activityJava.match(/private void togglePlayPause\(\)[\s\S]*?\r?\n {4}\}/);
    assert.ok(toggleMatch, 'missing togglePlayPause()');
    assert.match(toggleMatch[0], /uiHandler\.removeCallbacks\(singleTapRunnable\)/);
    assert.match(toggleMatch[0], /mediaPlayer\.play\(\);[\s\S]*?updatePlayPauseIcons\(true\)/);

    // Header brand subtitle only shows Animes (no Séries / Filmes)
    assert.doesNotMatch(headerTsx, /Animes\s*·\s*Séries\s*·\s*Filmes/);
  });

  it('pauses on headphone unplug/disconnect and owns Android MediaSession + media keys so external VLC is not triggered', () => {
    const activityJava = readFileSync(
      resolve(ROOT, 'android/app/src/main/java/com/topanimes/player/VlcPlayerActivity.java'),
      'utf8'
    );
    const animeDetailTsx = readFileSync(
      resolve(ROOT, 'src/components/AnimeDetailView.tsx'),
      'utf8'
    );

    // Becoming noisy receiver for wired/Bluetooth disconnect
    assert.match(activityJava, /AudioManager\.ACTION_AUDIO_BECOMING_NOISY/);
    assert.match(activityJava, /Context\.RECEIVER_NOT_EXPORTED/);
    assert.match(activityJava, /registerBecomingNoisyReceiver\(\)/);
    assert.match(activityJava, /unregisterBecomingNoisyReceiver\(\)/);

    // Active MediaSession + PlaybackState so Bluetooth earbud play/pause does not wake external VLC
    assert.match(activityJava, /private void setupMediaSession\(\)/);
    assert.match(activityJava, /new MediaSession\(this,\s*TAG\)/);
    assert.match(activityJava, /mediaSession\.setPlaybackState\(playbackState\)/);
    assert.match(activityJava, /mediaSession\.setActive\(true\)/);
    assert.match(activityJava, /private void releaseMediaSession\(\)/);

    // Media key consumption in onKeyDown + onKeyUp
    assert.match(activityJava, /public boolean onKeyDown\(int keyCode,\s*KeyEvent event\)/);
    assert.match(activityJava, /public boolean onKeyUp\(int keyCode,\s*KeyEvent event\)/);
    assert.match(activityJava, /KeyEvent\.KEYCODE_MEDIA_PLAY/);
    assert.match(activityJava, /KeyEvent\.KEYCODE_MEDIA_PAUSE/);
    assert.match(activityJava, /KeyEvent\.KEYCODE_HEADSETHOOK/);

    // Episode list shows "Parou em" below the title on mobile instead of crowding the title row
    assert.match(
      animeDetailTsx,
      /font-medium text-\[#fb923c\] sm:hidden[\s\S]*?Parou em \{formatPlaybackTimestamp\(resumeSec\)\}/
    );
    assert.match(
      animeDetailTsx,
      /hidden text-xs font-medium tabular-nums text-\[#fb923c\] sm:inline[\s\S]*?Parou em \{formatPlaybackTimestamp\(resumeSec\)\}/
    );
  });

  it('configures Anisync brand name and sole standard launcher icon in AndroidManifest', () => {
    const manifestXml = readFileSync(
      resolve(ROOT, 'android/app/src/main/AndroidManifest.xml'),
      'utf8'
    );
    const stringsXml = readFileSync(
      resolve(ROOT, 'android/app/src/main/res/values/strings.xml'),
      'utf8'
    );
    const bgColorsXml = readFileSync(
      resolve(ROOT, 'android/app/src/main/res/values/ic_launcher_background.xml'),
      'utf8'
    );

    assert.match(stringsXml, /<string name="app_name">Anisync<\/string>/);
    assert.match(stringsXml, /<string name="title_activity_main">Anisync<\/string>/);
    assert.match(
      manifestXml,
      /<activity[\s\S]*?android:name="\.MainActivity"[\s\S]*?android\.intent\.category\.LAUNCHER/
    );
    assert.doesNotMatch(manifestXml, /<activity-alias/);
    assert.match(bgColorsXml, /<color name="ic_launcher_background">#0e1115<\/color>/);
    assert.ok(existsSync(resolve(ROOT, 'public/pwa-192x192.png')));
    assert.ok(existsSync(resolve(ROOT, 'public/pwa-512x512.png')));
    assert.ok(
      existsSync(
        resolve(ROOT, 'android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.png')
      )
    );
  });

  it('keeps VlcPlayerActivity alive across screen-off/launcher reopen and persists pending watch session', () => {
    const manifestXml = readFileSync(
      resolve(ROOT, 'android/app/src/main/AndroidManifest.xml'),
      'utf8'
    );
    const activityJava = readFileSync(
      resolve(ROOT, 'android/app/src/main/java/com/topanimes/player/VlcPlayerActivity.java'),
      'utf8'
    );
    const pluginJava = readFileSync(
      resolve(ROOT, 'android/app/src/main/java/com/topanimes/player/NativeVlcPlayerPlugin.java'),
      'utf8'
    );
    const resolverJava = readFileSync(
      resolve(ROOT, 'android/app/src/main/java/com/topanimes/player/TopAnimesEpisodeResolver.java'),
      'utf8'
    );

    // MainActivity must use singleTop (never singleTask) so tapping the launcher icon after
    // screen-off does not perform CLEAR_TOP and destroy VlcPlayerActivity
    assert.match(manifestXml, /android:name="\.MainActivity"[\s\S]*?android:launchMode="singleTop"/);
    assert.doesNotMatch(manifestXml, /android:launchMode="singleTask"/);

    // Active seek guard prevents pre-seek 0:00 TimeChanged events from resetting lastKnownPositionMs
    assert.match(activityJava, /activeSeekTargetMs\s*=\s*target/);
    assert.match(activityJava, /long\s+targetBeforeApply\s*=\s*pendingSeekMs/);
    assert.match(activityJava, /waitingForSeekCompletion/);

    // Full state and pending session are persisted in onPause/onStop/onSaveInstanceState
    assert.match(activityJava, /PREF_PENDING_SESSION_JSON/);
    assert.match(activityJava, /persistPendingSessionPref\(/);
    assert.match(activityJava, /consumePendingSessionJson\(/);
    assert.match(activityJava, /restoreFromSavedInstanceState\(savedInstanceState\)/);
    assert.match(pluginJava, /public void consumePendingSession\(PluginCall call\)/);
    assert.match(pluginJava, /VlcPlayerActivity\.consumePendingSessionJson\(getContext\(\)\)/);

    // Fullscreen episode switching supports both TopAnimes and Hinata Soul URLs
    assert.match(resolverJava, /public static String normalizeSupportedEpisodeUrl\(String rawUrl\)/);
    assert.match(
      activityJava,
      /TopAnimesEpisodeResolver\.normalizeSupportedEpisodeUrl\(rawTargetUrl\)/
    );
  });
});



