package com.topanimes.player;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.drawable.Icon;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

import androidx.core.app.PendingIntentCompat;
import androidx.core.app.ServiceCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * Android Foreground Service (foregroundServiceType="mediaPlayback", stopWithTask="false")
 * that manages TV casting (Chromecast / Google TV / Android TV + DLNA Smart TVs) and a
 * token-gated LAN stream proxy so episodes keep playing on the TV even when the user
 * minimizes Anisync, locks the phone screen, switches apps, or swipes the app away.
 */
public class TvCastService extends Service {
    private static final String TAG = "AnisyncTvCastService";
    private static final String CHANNEL_CAST_ID = "anisync_tv_cast";
    private static final int CAST_NOTIFICATION_ID = 42001;
    private static final long WAKE_LOCK_TIMEOUT_MS = 6L * 60L * 60L * 1000L;
    private static final Pattern BYTE_RANGE_PATTERN = Pattern.compile("^bytes=(\\d*)-(\\d*)$", Pattern.CASE_INSENSITIVE);

    public static final String ACTION_START_CAST = "com.topanimes.player.cast.START";
    public static final String ACTION_PREPARE_LAN_ONLY = "com.topanimes.player.cast.PREPARE_LAN";
    public static final String ACTION_PLAY = "com.topanimes.player.cast.PLAY";
    public static final String ACTION_PAUSE = "com.topanimes.player.cast.PAUSE";
    public static final String ACTION_TOGGLE_PLAY_PAUSE = "com.topanimes.player.cast.TOGGLE";
    public static final String ACTION_SEEK_TO = "com.topanimes.player.cast.SEEK_TO";
    public static final String ACTION_SEEK_BY = "com.topanimes.player.cast.SEEK_BY";
    public static final String ACTION_SET_VOLUME = "com.topanimes.player.cast.SET_VOLUME";
    public static final String ACTION_SET_TRACKS = "com.topanimes.player.cast.SET_TRACKS";
    public static final String ACTION_NEXT_EPISODE = "com.topanimes.player.cast.NEXT_EP";
    public static final String ACTION_PREV_EPISODE = "com.topanimes.player.cast.PREV_EP";
    public static final String ACTION_STOP_CAST = "com.topanimes.player.cast.STOP";

    public static final String EXTRA_DEVICE_JSON = "deviceJson";
    public static final String EXTRA_MEDIA_JSON = "mediaJson";
    public static final String EXTRA_POSITION_MS = "positionMs";
    public static final String EXTRA_DELTA_MS = "deltaMs";
    public static final String EXTRA_VOLUME = "volume";
    public static final String EXTRA_DELIVERY_MODE = "deliveryMode";
    public static final String EXTRA_PRESERVE_ACTIVE_CONTROLLER = "preserveActiveController";
    public static final String EXTRA_TRACKS_JSON = "tracksJson";

    public interface StateListener {
        void onCastStateChanged(JSONObject stateSnapshot);
    }

    private static final class SubtitleEntry {
        final String label;
        final String url;
        final boolean isDefault;

        SubtitleEntry(String label, String url, boolean isDefault) {
            this.label = label != null ? label : "Legenda";
            this.url = url != null ? url : "";
            this.isDefault = isDefault;
        }
    }

    private static final Set<StateListener> STATE_LISTENERS = new CopyOnWriteArraySet<>();
    private static final Object STATE_LOCK = new Object();
    private static volatile TvCastService runningInstance = null;
    private static volatile JSONObject latestStateJson = buildIdleStateJson();
    private static volatile String latestPreparedLanStreamUrl = "";

    private static final String CUSTOM_ACTION_STOP_CAST = "com.topanimes.player.action.MEDIA_STOP_CAST";

    private static final long MEDIA_SESSION_BASE_ACTIONS =
        PlaybackState.ACTION_PLAY
            | PlaybackState.ACTION_PAUSE
            | PlaybackState.ACTION_PLAY_PAUSE
            | PlaybackState.ACTION_STOP
            | PlaybackState.ACTION_SEEK_TO
            | PlaybackState.ACTION_FAST_FORWARD
            | PlaybackState.ACTION_REWIND;

    private static long buildMediaSessionActions(boolean hasPrev, boolean hasNext) {
        long actions = MEDIA_SESSION_BASE_ACTIONS;
        if (hasPrev) actions |= PlaybackState.ACTION_SKIP_TO_PREVIOUS;
        if (hasNext) actions |= PlaybackState.ACTION_SKIP_TO_NEXT;
        return actions;
    }

    public static void addStateListener(StateListener listener) {
        if (listener != null) {
            STATE_LISTENERS.add(listener);
        }
    }

    public static void removeStateListener(StateListener listener) {
        if (listener != null) {
            STATE_LISTENERS.remove(listener);
        }
    }

    public static JSONObject getCurrentStateJson() {
        synchronized (STATE_LOCK) {
            try {
                return new JSONObject(latestStateJson.toString());
            } catch (Exception e) {
                return buildIdleStateJson();
            }
        }
    }

    public static boolean isCastActive() {
        return latestStateJson.optBoolean("active", false);
    }

    public static boolean hasActiveRemoteController() {
        return isCastActive()
            && TvCastProtocol.hasRemotePlaybackControls(
                latestStateJson.optString("deviceProtocol", ""),
                latestStateJson.optString("deliveryMode", "")
            );
    }

    public static String getActiveLanStreamUrl() {
        return latestStateJson.optString("lanStreamUrl", "");
    }

    public static String getPreparedLanStreamUrl() {
        String prepared = latestPreparedLanStreamUrl;
        if (prepared != null && !prepared.isEmpty()) {
            return prepared;
        }
        return getActiveLanStreamUrl();
    }

    public static void clearPreparedLanStreamUrl() {
        latestPreparedLanStreamUrl = "";
    }

    public static void clearErrorState() {
        boolean shouldBroadcast = false;
        synchronized (STATE_LOCK) {
            if (!latestStateJson.optBoolean("active", false)
                && ("error".equals(latestStateJson.optString("status", ""))
                    || !latestStateJson.optString("errorMessage", "").isEmpty())) {
                latestStateJson = buildIdleStateJson();
                shouldBroadcast = true;
            }
        }
        TvCastService inst = runningInstance;
        if (inst != null && !inst.sessionActive) {
            inst.errorMessage = "";
            if ("error".equals(inst.status)) {
                inst.status = "idle";
            }
        }
        if (shouldBroadcast) {
            broadcastState(buildIdleStateJson());
        }
    }

    private static JSONObject buildIdleStateJson() {
        JSONObject o = new JSONObject();
        try {
            o.put("active", false);
            o.put("status", "idle");
            o.put("deviceId", "");
            o.put("deviceName", "");
            o.put("deviceProtocol", "");
            o.put("deliveryMode", "");
            o.put("episodeUrl", "");
            o.put("episodeTitle", "");
            o.put("seriesTitle", "");
            o.put("seriesUrl", "");
            o.put("poster", "");
            o.put("streamUrl", "");
            o.put("lanStreamUrl", "");
            o.put("positionMs", 0L);
            o.put("durationMs", 0L);
            o.put("stateTimestampMs", 0L);
            o.put("volume", 0.0);
            o.put("muted", false);
            o.put("volumeSynced", false);
            o.put("hasPrev", false);
            o.put("hasNext", false);
            o.put("selectedServerNume", "");
            o.put("qualityLabel", "");
            o.put("audioLabel", "");
            o.put("subtitleUrl", "");
            o.put("subtitleLabel", "");
            o.put("mediaTracks", new JSONArray());
            o.put("activeTrackIds", new JSONArray());
            o.put("errorMessage", "");
        } catch (Exception ignored) {
        }
        return o;
    }

    public static void requestStopImmediately() {
        TvCastService inst = runningInstance;
        if (inst != null) {
            inst.stopSessionAndService();
        }
    }

    private static void broadcastState(JSONObject nextState) {
        synchronized (STATE_LOCK) {
            latestStateJson = nextState;
        }
        for (StateListener listener : STATE_LISTENERS) {
            try {
                listener.onCastStateChanged(new JSONObject(nextState.toString()));
            } catch (Exception ignored) {
            }
        }
    }

    // -------------------------------------------------------------------------
    // Instance State
    // -------------------------------------------------------------------------

    private ExecutorService ioExecutor;
    private ExecutorService proxyExecutor;
    private ScheduledExecutorService scheduler;
    private ScheduledFuture<?> pollFuture;

    private ServerSocket lanServerSocket;
    private final Set<Socket> activeLanClientSockets = ConcurrentHashMap.newKeySet();
    private volatile int lanServerPort = -1;
    private volatile boolean lanServerRunning = false;
    private volatile String lanSecretToken = "";
    private volatile String activeSubtitleSourceUrl = "";
    private volatile String activeSubtitleReferer = "https://topanimes.net/";
    private final List<SubtitleEntry> subtitleEntries = new CopyOnWriteArrayList<>();

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private MediaSession mediaSession;

    private final Object sessionLock = new Object();
    private final AtomicInteger castSessionGen = new AtomicInteger(0);

    private volatile boolean sessionActive = false;
    private volatile String status = "idle";
    private volatile String deliveryMode = "background-proxy";
    private volatile String errorMessage = "";

    private TvCastProtocol.CastDevice activeDevice = null;
    private String episodeUrl = "";
    private String episodeTitle = "Anisync";
    private String seriesTitle = "";
    private String seriesUrl = "";
    private String posterUrl = "";
    private boolean isMovie = false;
    private String streamUrl = "";
    private String streamFormat = "mp4";
    private String referer = "https://topanimes.net/";
    private boolean preferDirect = false;
    private String subtitleUrl = "";
    private String subtitleLabel = "";
    private boolean subtitleDisabled = false;
    private String qualityLabel = "";
    private String audioLabel = "";
    private String selectedServerNume = "";
    private String prevUrl = "";
    private String nextUrl = "";
    private boolean autoPlayNextEpisode = false;
    private String deliveryPreference = "auto";
    private String lanStreamUrl = "";
    private volatile JSONArray activeMediaTracksJson = new JSONArray();
    private volatile JSONArray activeTrackIdsJson = new JSONArray();

    private volatile long positionMs = 0L;
    private volatile long durationMs = 0L;
    private volatile double volume = 0.0;
    private volatile boolean muted = false;
    private volatile boolean volumeSynced = false;
    private volatile long lastVolumeSetAtMs = 0L;
    private volatile long lastProgressPersistMs = 0L;
    private volatile long lastSeekTargetMs = -1L;
    private volatile long lastSeekRequestedAtMs = 0L;
    private volatile boolean handledCompletionForEpisode = false;
    private volatile boolean attemptedDirectFallback = false;
    private volatile TvCastProtocol.HlsPlaylistInfo activeDlnaHlsPlan = null;
    private volatile boolean hlsTsRelayActive = false;
    private volatile boolean hlsRelaySwitching = false;
    private volatile long hlsTsBaseOffsetMs = 0L;
    private volatile long hlsTsRelayStartMs = 0L;
    private volatile long hlsRelayFirstRawPosMs = -1L;
    private volatile long hlsRelayLastRawPosMs = -1L;
    private volatile boolean hlsRelayRawPosAdvancing = false;
    private volatile long hlsRelayAnchorPosMs = 0L;
    private volatile long hlsRelayAnchorWallMs = 0L;
    private final AtomicInteger hlsRelaySeekSeq = new AtomicInteger(0);
    private final AtomicInteger hlsRelayStreamSeq = new AtomicInteger(0);
    private final AtomicInteger hlsTimeSeekRequestCount = new AtomicInteger(0);
    private volatile boolean hlsTimeSeekFailedForDevice = false;
    private volatile long hlsPendingTimeSeekTargetMs = -1L;
    private volatile int hlsPendingTimeSeekSegIdx = -1;
    private volatile long hlsPendingTimeSeekAtMs = 0L;
    private volatile long hlsRelayInitialLoadAtMs = 0L;
    private final AtomicInteger seekRequestGen = new AtomicInteger(0);
    private volatile long pendingSeekTargetMs = -1L;
    private final Set<Socket> activeHlsRelaySockets = ConcurrentHashMap.newKeySet();
    private final Map<String, byte[]> hlsAesKeyCache = new ConcurrentHashMap<>();
    private volatile boolean dlnaNeedsPostPlayVolumeResync = false;

    private volatile String cachedArtworkUrl = "";
    private volatile Bitmap cachedArtworkBitmap = null;
    private volatile String loadingArtworkUrl = "";
    private volatile String lastMetadataSignature = "";
    private volatile String lastNotificationSignature = "";

    private ChromecastController chromecastController = null;
    private DlnaController dlnaController = null;

    @Override
    public void onCreate() {
        super.onCreate();
        runningInstance = this;
        ioExecutor = Executors.newSingleThreadExecutor();
        proxyExecutor = Executors.newCachedThreadPool();
        scheduler = Executors.newSingleThreadScheduledExecutor();
        ensureNotificationChannel();
        setupMediaSession();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_STOP_CAST.equals(action)) {
            stopSessionAndService();
            return START_NOT_STICKY;
        }

        // Start foreground immediately so Android 12-16 never throws ForegroundServiceDidNotStartInTimeException
        startForegroundCompat(buildNotification());

        if (intent == null || action == null) {
            if (!sessionActive) {
                stopSelf();
                return START_NOT_STICKY;
            }
            return START_STICKY;
        }

        switch (action) {
            case ACTION_START_CAST: {
                String deviceRaw = intent.getStringExtra(EXTRA_DEVICE_JSON);
                String mediaRaw = intent.getStringExtra(EXTRA_MEDIA_JSON);
                String modePref = intent.getStringExtra(EXTRA_DELIVERY_MODE);
                handleStartCastRequest(deviceRaw, mediaRaw, modePref);
                break;
            }
            case ACTION_PREPARE_LAN_ONLY: {
                String mediaRaw = intent.getStringExtra(EXTRA_MEDIA_JSON);
                boolean preserveActive = intent.getBooleanExtra(EXTRA_PRESERVE_ACTIVE_CONTROLLER, false);
                handlePrepareLanOnlyRequest(mediaRaw, preserveActive);
                break;
            }
            case ACTION_PLAY:
                ioExecutor.execute(this::performPlay);
                break;
            case ACTION_PAUSE:
                ioExecutor.execute(this::performPause);
                break;
            case ACTION_TOGGLE_PLAY_PAUSE:
                ioExecutor.execute(this::performTogglePlayPause);
                break;
            case ACTION_SEEK_TO: {
                long targetMs = Math.max(0L, intent.getLongExtra(EXTRA_POSITION_MS, 0L));
                int seq = seekRequestGen.incrementAndGet();
                pendingSeekTargetMs = targetMs;
                ioExecutor.execute(() -> performSeekTo(targetMs, seq));
                break;
            }
            case ACTION_SEEK_BY: {
                long deltaMs = intent.getLongExtra(EXTRA_DELTA_MS, 0L);
                long baseMs = pendingSeekTargetMs >= 0L ? pendingSeekTargetMs : getEffectiveLivePositionMs();
                long targetMs = Math.max(0L, baseMs + deltaMs);
                int seq = seekRequestGen.incrementAndGet();
                pendingSeekTargetMs = targetMs;
                ioExecutor.execute(() -> performSeekTo(targetMs, seq));
                break;
            }
            case ACTION_SET_VOLUME: {
                double vol = intent.getDoubleExtra(EXTRA_VOLUME, 1.0);
                ioExecutor.execute(() -> performSetVolume(Math.max(0.0, Math.min(1.0, vol))));
                break;
            }
            case ACTION_SET_TRACKS: {
                String tracksRaw = intent.getStringExtra(EXTRA_TRACKS_JSON);
                ioExecutor.execute(() -> performSetTracks(tracksRaw));
                break;
            }
            case ACTION_NEXT_EPISODE:
                ioExecutor.execute(() -> switchEpisodeInBackground(nextUrl));
                break;
            case ACTION_PREV_EPISODE:
                ioExecutor.execute(() -> switchEpisodeInBackground(prevUrl));
                break;
            default:
                break;
        }

        return START_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // Intentionally do NOT stop casting when user closes/swipes the app window away.
        // Playback continues on TV with notification controls until finished or stopped by user.
        if (sessionActive) {
            updateNotification();
        }
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        teardownControllersAndServer();
        releaseLocks();
        releaseMediaSession();
        if (scheduler != null) {
            scheduler.shutdownNow();
            scheduler = null;
        }
        if (ioExecutor != null) {
            ioExecutor.shutdownNow();
            ioExecutor = null;
        }
        if (proxyExecutor != null) {
            proxyExecutor.shutdownNow();
            proxyExecutor = null;
        }
        if (runningInstance == this) {
            runningInstance = null;
        }
        latestPreparedLanStreamUrl = "";
        if (!"error".equals(status) || errorMessage == null || errorMessage.isEmpty()) {
            broadcastState(buildIdleStateJson());
        }
        super.onDestroy();
    }

    // -------------------------------------------------------------------------
    // Session Orchestration
    // -------------------------------------------------------------------------

    private void handleStartCastRequest(String deviceRaw, String mediaRaw, String modePref) {
        TvCastProtocol.CastDevice parsedDevice = parseDeviceFromJson(deviceRaw);
        if (parsedDevice == null || parsedDevice.host.isEmpty()) {
            failSession(castSessionGen.incrementAndGet(), "Dispositivo de TV inválido.");
            return;
        }

        if (!applyMediaJson(mediaRaw)) {
            failSession(castSessionGen.incrementAndGet(), "Nenhum stream válido disponível para transmitir.");
            return;
        }

        deliveryPreference = (modePref != null && !modePref.trim().isEmpty())
            ? modePref.trim().toLowerCase(Locale.ROOT)
            : "auto";
        boolean isLocalOffline = TvCastProtocol.parseLocalOfflineAsset(streamUrl) != null;
        boolean sameDeviceReconnect = sessionActive
            && activeDevice != null
            && activeDevice.id.equals(parsedDevice.id)
            && activeDevice.protocol.equals(parsedDevice.protocol);
        activeDevice = parsedDevice;
        sessionActive = true;
        // Always reset deliveryMode immediately so controls never vanish after a previous lan-link session
        deliveryMode = (!isLocalOffline && "direct".equals(deliveryPreference))
            ? "direct"
            : "background-proxy";
        status = "connecting";
        errorMessage = "";
        if (!sameDeviceReconnect) {
            volume = 0.0;
            muted = false;
            volumeSynced = false;
            lastVolumeSetAtMs = 0L;
            hlsTimeSeekFailedForDevice = false;
        }
        dlnaNeedsPostPlayVolumeResync = true;
        activeDlnaHlsPlan = null;
        resetHlsRelayState();
        hlsAesKeyCache.clear();
        activeMediaTracksJson = new JSONArray();
        activeTrackIdsJson = new JSONArray();
        lastSeekTargetMs = positionMs > 2000L ? positionMs : -1L;
        lastSeekRequestedAtMs = positionMs > 2000L ? System.currentTimeMillis() : 0L;
        handledCompletionForEpisode = false;
        attemptedDirectFallback = false;

        acquireLocks();
        final int gen = castSessionGen.incrementAndGet();
        ensurePosterArtworkLoaded(posterUrl, referer, gen);
        updateNotification(true);
        publishCurrentState();

        ioExecutor.execute(() -> connectAndLoadMedia(gen, false));
    }

    private void handlePrepareLanOnlyRequest(String mediaRaw, boolean preserveActiveController) {
        boolean hasLiveTvController = sessionActive
            && activeDevice != null
            && TvCastProtocol.hasRemotePlaybackControls(activeDevice.protocol, deliveryMode)
            && (dlnaController != null || chromecastController != null);

        if (preserveActiveController && hasLiveTvController) {
            // Preserve the active TV session and remote controls; only build a LAN proxy URL for copying/sharing.
            ioExecutor.execute(() -> {
                String built = buildLanStreamUrlFromRawMediaJson(mediaRaw);
                if (built.isEmpty()) {
                    built = ensureLanStreamUrlForCurrentMedia();
                }
                latestPreparedLanStreamUrl = built;
            });
            return;
        }

        if (!applyMediaJson(mediaRaw)) {
            failSession(
                castSessionGen.incrementAndGet(),
                "Nenhum stream válido disponível para preparar o link de TV."
            );
            return;
        }

        closeActiveRemoteControllers();
        activeDevice = new TvCastProtocol.CastDevice(
            "lan-link",
            "App externo / Smart TV",
            "Rede local Wi-Fi",
            "Servidor em segundo plano",
            "lan",
            0,
            "lan",
            "",
            "",
            ""
        );
        sessionActive = true;
        deliveryMode = "lan-link";
        status = "playing";
        errorMessage = "";
        acquireLocks();

        final int gen = castSessionGen.incrementAndGet();
        ensurePosterArtworkLoaded(posterUrl, referer, gen);
        ioExecutor.execute(() -> {
            if (gen != castSessionGen.get()) return;
            String lanUrl = ensureLanStreamUrlForCurrentMedia();
            if (lanUrl.isEmpty()) {
                errorMessage = "Conecte o celular ao Wi-Fi para gerar o link de TV na rede local.";
                status = "error";
                publishCurrentState();
                return;
            }
            lanStreamUrl = lanUrl;
            latestPreparedLanStreamUrl = lanUrl;
            updateNotification(true);
            publishCurrentState();
        });
    }

    private String buildLanStreamUrlFromRawMediaJson(String raw) {
        String base = ensureLanProxyBaseUrl();
        if (base.isEmpty() || lanSecretToken.isEmpty() || raw == null || raw.trim().isEmpty()) return "";
        try {
            JSONObject m = new JSONObject(raw);
            String sUrl = m.optString("streamUrl", "").trim();
            String sFmt = m.optString("streamFormat", "mp4").trim();
            String sRef = m.optString("referer", "https://topanimes.net/").trim();
            TvCastProtocol.LocalOfflineAsset offline = TvCastProtocol.parseLocalOfflineAsset(sUrl);
            if (offline != null) {
                return TvCastProtocol.buildLanOfflineAssetUrl(base, lanSecretToken, offline.downloadId, offline.fileName);
            }
            if (!TvCastProtocol.isSafeExternalHttpUrl(sUrl)) return "";
            boolean isHls = TvCastProtocol.isHlsStreamUrl(sUrl, sFmt);
            return TvCastProtocol.buildLanProxyUrl(base, lanSecretToken, sUrl, sRef, false, isHls);
        } catch (Exception e) {
            return "";
        }
    }

    private String buildActiveLanCleanUrl(int gen, boolean asPlaylist) {
        String base = ensureLanProxyBaseUrl();
        if (base.isEmpty() || lanSecretToken.isEmpty()) return "";
        return base + "/cast/" + lanSecretToken + "/m" + gen + "/" + (asPlaylist ? "playlist.m3u8" : "video.mp4");
    }

    private String buildActiveLanRelayUrl(int gen, int seekSeq, int startIdx, boolean isFmp4) {
        String base = ensureLanProxyBaseUrl();
        if (base.isEmpty() || lanSecretToken.isEmpty()) return "";
        return base + "/cast/" + lanSecretToken + "/m" + gen + "/s" + seekSeq + "/i" + Math.max(0, startIdx) + "/"
            + (isFmp4 ? "video-fmp4.mp4" : "video.ts");
    }

    private void resetHlsRelayState() {
        hlsRelaySwitching = false;
        hlsTsRelayActive = false;
        hlsTsBaseOffsetMs = 0L;
        hlsTsRelayStartMs = 0L;
        hlsRelayFirstRawPosMs = -1L;
        hlsRelayLastRawPosMs = -1L;
        hlsRelayRawPosAdvancing = false;
        hlsRelayAnchorPosMs = 0L;
        hlsRelayAnchorWallMs = 0L;
        hlsPendingTimeSeekTargetMs = -1L;
        hlsPendingTimeSeekSegIdx = -1;
        hlsPendingTimeSeekAtMs = 0L;
        hlsRelayInitialLoadAtMs = 0L;
        pendingSeekTargetMs = -1L;
    }

    private void closeActiveHlsRelaySockets() {
        for (Socket s : activeHlsRelaySockets) {
            try {
                s.close();
            } catch (Exception ignored) {
            }
        }
        activeHlsRelaySockets.clear();
    }

    private long getEffectiveLivePositionMs() {
        if (hlsTsRelayActive) {
            return TvCastProtocol.resolveHlsRelayPositionMs(
                hlsTsBaseOffsetMs,
                hlsRelayLastRawPosMs,
                hlsRelayFirstRawPosMs,
                hlsRelayRawPosAdvancing,
                hlsRelayAnchorPosMs,
                hlsRelayAnchorWallMs,
                System.currentTimeMillis(),
                durationMs,
                "playing".equals(status)
            );
        }
        return Math.max(0L, positionMs);
    }

    private TvCastProtocol.HlsPlaylistInfo resolveDlnaHlsPlanIfApplicable(int gen, boolean knownHls) {
        if (gen != castSessionGen.get()) return null;
        try {
            TvCastProtocol.LocalOfflineAsset localOffline = TvCastProtocol.parseLocalOfflineAsset(streamUrl);
            if (localOffline != null) {
                if (!knownHls && !localOffline.fileName.toLowerCase(Locale.ROOT).endsWith(".m3u8")) {
                    return null;
                }
                File root = LocalProxyPlugin.getOfflineMediaRootDir(this);
                if (root == null || !root.exists()) return null;
                File manifestFile = new File(new File(root, localOffline.downloadId), localOffline.fileName);
                String rootCanon = root.getCanonicalPath();
                String fileCanon = manifestFile.getCanonicalPath();
                if (!fileCanon.startsWith(rootCanon + File.separator) || !manifestFile.isFile()) return null;
                String rawManifest;
                try (FileInputStream fis = new FileInputStream(manifestFile)) {
                    rawManifest = LocalProxyPlugin.readStreamAsString(fis);
                }
                if (rawManifest == null || !rawManifest.contains("#EXTM3U")) return null;
                String offlineBaseUrl = streamUrl;
                TvCastProtocol.HlsPlaylistInfo parsed = TvCastProtocol.parseHlsPlaylistForDlna(rawManifest, offlineBaseUrl);
                return !parsed.segments.isEmpty() ? parsed : null;
            }

            if (!TvCastProtocol.isSafeExternalHttpUrl(streamUrl)) return null;
            String currentUrl = streamUrl;
            String safeRef = LocalProxyPlugin.isSafeHttpUrl(referer) ? referer : "https://topanimes.net/";
            for (int depth = 0; depth < 3; depth++) {
                if (gen != castSessionGen.get()) return null;
                String probeRange = (!knownHls && depth == 0) ? "bytes=0-4095" : null;
                HttpURLConnection conn = null;
                String manifestBody = null;
                String finalUrl = currentUrl;
                try {
                    LocalProxyPlugin.RedirectResult res = openUpstreamWithRetry(currentUrl, safeRef, probeRange, "GET");
                    conn = res.connection;
                    finalUrl = res.finalUrl != null && !res.finalUrl.isEmpty() ? res.finalUrl : currentUrl;
                    int code = conn.getResponseCode();
                    if (code < 200 || code >= 300) return null;
                    String ct = conn.getContentType();
                    String lowerCt = ct != null ? ct.toLowerCase(Locale.ROOT) : "";
                    boolean ctIsHls = lowerCt.contains("mpegurl") || lowerCt.contains("m3u8");
                    if (probeRange != null) {
                        byte[] probe = new byte[4096];
                        int n;
                        try (InputStream in = conn.getInputStream()) {
                            n = LocalProxyPlugin.readUpTo(in, probe);
                        }
                        if (!ctIsHls && !LocalProxyPlugin.looksLikeM3u8Manifest(probe, n)) {
                            return null;
                        }
                        conn.disconnect();
                        conn = null;
                        LocalProxyPlugin.RedirectResult fullRes = openUpstreamWithRetry(finalUrl, safeRef, null, "GET");
                        conn = fullRes.connection;
                        finalUrl = fullRes.finalUrl != null && !fullRes.finalUrl.isEmpty() ? fullRes.finalUrl : finalUrl;
                        int fullCode = conn.getResponseCode();
                        if (fullCode < 200 || fullCode >= 300) return null;
                        manifestBody = LocalProxyPlugin.readStreamAsString(conn.getInputStream());
                    } else {
                        manifestBody = LocalProxyPlugin.readStreamAsString(conn.getInputStream());
                    }
                } finally {
                    if (conn != null) conn.disconnect();
                }

                if (manifestBody == null || !manifestBody.contains("#EXTM3U")) {
                    return null;
                }
                TvCastProtocol.HlsPlaylistInfo parsed = TvCastProtocol.parseHlsPlaylistForDlna(manifestBody, finalUrl);
                if (parsed.isMaster && !parsed.bestVariantUrl.isEmpty()) {
                    currentUrl = parsed.bestVariantUrl;
                    continue;
                }
                return !parsed.segments.isEmpty() ? parsed : null;
            }
        } catch (Exception e) {
            Log.d(TAG, "DLNA HLS plan probe skipped: " + e.getMessage());
        }
        return null;
    }

    private void connectAndLoadMedia(int gen, boolean forceProxy) {
        if (gen != castSessionGen.get() || activeDevice == null) return;

        closeActiveRemoteControllers();
        activeDlnaHlsPlan = null;
        resetHlsRelayState();

        TvCastProtocol.LocalOfflineAsset localOffline = TvCastProtocol.parseLocalOfflineAsset(streamUrl);
        boolean isLocalOffline = localOffline != null;
        boolean isHls = TvCastProtocol.isHlsStreamUrl(streamUrl, streamFormat);
        boolean isDlnaDevice = TvCastProtocol.PROTOCOL_DLNA.equals(activeDevice.protocol);

        if (isDlnaDevice) {
            boolean shouldProbeHls = isHls
                || (!isLocalOffline && !"mp4".equalsIgnoreCase(streamFormat));
            if (shouldProbeHls) {
                TvCastProtocol.HlsPlaylistInfo hlsPlan = resolveDlnaHlsPlanIfApplicable(gen, isHls);
                if (gen != castSessionGen.get()) return;
                if (hlsPlan != null && !hlsPlan.segments.isEmpty()) {
                    activeDlnaHlsPlan = hlsPlan;
                    isHls = true;
                    if (hlsPlan.totalDurationMs > 0L && durationMs <= 0L) {
                        durationMs = hlsPlan.totalDurationMs;
                    }
                }
            }
        }

        String mimeType = TvCastProtocol.inferStreamMimeType(streamUrl, isHls ? "hls" : streamFormat);
        String builtLanUrl = ensureLanStreamUrlForCurrentMedia();
        lanStreamUrl = builtLanUrl;
        if (!builtLanUrl.isEmpty()) {
            latestPreparedLanStreamUrl = builtLanUrl;
        }

        // For DLNA Smart TVs, use short query-free LAN URLs (/cast/<token>/m<gen>/video.mp4 or playlist.m3u8)
        // so strict UPnP XML parsers never choke on long URLs or &amp; query strings.
        String dlnaStandardLanUrl = builtLanUrl;
        if (isDlnaDevice && !isLocalOffline && !builtLanUrl.isEmpty()) {
            String cleanUrl = buildActiveLanCleanUrl(gen, isHls);
            if (!cleanUrl.isEmpty()) {
                dlnaStandardLanUrl = cleanUrl;
            }
        }

        String targetUrl = "";
        String chosenMode = "background-proxy";

        boolean hasActiveSubtitle = !subtitleDisabled && !subtitleUrl.isEmpty();
        boolean canTryDirect = !forceProxy
            && !isLocalOffline
            && !"proxy".equals(deliveryPreference)
            && !isHls
            && !hasActiveSubtitle;

        if (canTryDirect) {
            boolean directPrefForced = "direct".equals(deliveryPreference);
            boolean isChromecast = TvCastProtocol.PROTOCOL_CHROMECAST.equals(activeDevice.protocol);
            if (directPrefForced || (isChromecast && probeDirectPlayable(streamUrl))) {
                targetUrl = streamUrl;
                chosenMode = "direct";
            }
        }

        if (targetUrl.isEmpty()) {
            String preferredProxyUrl = isDlnaDevice ? dlnaStandardLanUrl : builtLanUrl;
            if (preferredProxyUrl.isEmpty()) {
                if (!isLocalOffline && probeDirectPlayable(streamUrl)) {
                    targetUrl = streamUrl;
                    chosenMode = "direct";
                } else {
                    failSession(gen, "Conecte o celular e a TV na mesma rede Wi-Fi para transmitir.");
                    return;
                }
            } else {
                targetUrl = preferredProxyUrl;
                chosenMode = "background-proxy";
            }
        }

        if (gen != castSessionGen.get()) return;

        deliveryMode = chosenMode;
        status = "buffering";
        errorMessage = "";
        updateNotification();
        publishCurrentState();

        String lanSubtitleVttUrl = (hasActiveSubtitle && !builtLanUrl.isEmpty())
            ? buildLanSubtitleUrl()
            : "";
        String lanSubtitleSrtUrl = (hasActiveSubtitle && !builtLanUrl.isEmpty())
            ? buildLanSubtitleSrtUrl()
            : "";

        TvCastProtocol.HlsPlaylistInfo hlsPlan = activeDlnaHlsPlan;
        boolean canUseHlsRelay = isDlnaDevice
            && hlsPlan != null
            && !hlsPlan.segments.isEmpty()
            && !builtLanUrl.isEmpty();
        boolean preferHlsRelayFirst = canUseHlsRelay
            && TvCastProtocol.isLikelyHlsUnsupportedDlnaDevice(activeDevice);

        Exception lastError = null;
        DlnaController pendingDlna = null;
        for (int attempt = 1; attempt <= 2; attempt++) {
            if (gen != castSessionGen.get()) return;
            try {
                if (isDlnaDevice) {
                    DlnaController dlna = pendingDlna != null ? pendingDlna : new DlnaController(activeDevice);
                    pendingDlna = dlna;
                    if (attempt > 1) {
                        dlna.refreshControlUrlsFromLocation(true);
                    }
                    synchronized (sessionLock) {
                        dlnaController = dlna;
                    }
                    // Sync the TV's actual volume & mute BEFORE loading or playing media
                    // so the app matches the TV instead of assuming 100%.
                    if (dlna.syncVolumeFromTv()) {
                        publishCurrentState();
                    }

                    boolean loadedViaRelay = false;
                    if (preferHlsRelayFirst) {
                        try {
                            loadDlnaViaHlsContinuousRelay(dlna, gen, hlsPlan, positionMs, lanSubtitleSrtUrl);
                            loadedViaRelay = true;
                        } catch (Exception relayErr) {
                            Log.w(TAG, "DLNA HLS->TS relay failed, falling back to m3u8: " + relayErr.getMessage());
                            resetHlsRelayState();
                        }
                    }

                    if (!loadedViaRelay) {
                        try {
                            dlna.loadAndPlay(
                                targetUrl,
                                mimeType,
                                episodeTitle,
                                seriesTitle,
                                posterUrl,
                                positionMs,
                                lanSubtitleSrtUrl,
                                durationMs,
                                false
                            );
                        } catch (Exception primaryErr) {
                            if (canUseHlsRelay) {
                                // Smart TV rejected .m3u8 (typically HTTP 500 / UPnP 714 Illegal MIME-type):
                                // automatically transcode/remux HLS segments into a continuous MPEG-TS/fMP4 stream.
                                Log.i(TAG, "DLNA TV rejected HLS playlist (" + primaryErr.getMessage() + "); switching to continuous MPEG-TS relay");
                                deliveryMode = "background-proxy";
                                loadDlnaViaHlsContinuousRelay(dlna, gen, hlsPlan, positionMs, lanSubtitleSrtUrl);
                            } else if ("direct".equals(chosenMode) && !dlnaStandardLanUrl.isEmpty() && !attemptedDirectFallback) {
                                attemptedDirectFallback = true;
                                deliveryMode = "background-proxy";
                                dlna.loadAndPlay(
                                    dlnaStandardLanUrl,
                                    mimeType,
                                    episodeTitle,
                                    seriesTitle,
                                    posterUrl,
                                    positionMs,
                                    lanSubtitleSrtUrl,
                                    durationMs,
                                    false
                                );
                            } else {
                                throw primaryErr;
                            }
                        }
                    }
                    if (gen != castSessionGen.get()) return;
                    status = "playing";
                    // Re-query TV volume immediately after Play (LG webOS DMR reports real volume once playback opens;
                    // keep allowZeroAsSynced=false until PLAYING so a transitioning 0% does not falsely mark muted).
                    if (dlna.syncVolumeFromTv(false)) {
                        dlnaNeedsPostPlayVolumeResync = false;
                    }
                    startPollingLoop(gen);
                    updateNotification();
                    publishCurrentState();
                    return;
                } else {
                    ChromecastController cast = new ChromecastController(activeDevice, gen);
                    synchronized (sessionLock) {
                        chromecastController = cast;
                    }
                    cast.connectAndLoad(
                        targetUrl,
                        mimeType,
                        episodeTitle,
                        seriesTitle,
                        posterUrl,
                        positionMs,
                        lanSubtitleVttUrl,
                        subtitleLabel,
                        subtitleDisabled
                    );
                    if (gen != castSessionGen.get()) return;
                    startPollingLoop(gen);
                    updateNotification();
                    publishCurrentState();
                    return;
                }
            } catch (Exception e) {
                lastError = e;
                closeActiveRemoteControllers();
                if (attempt < 2 && gen == castSessionGen.get()) {
                    Log.w(TAG, "Cast attempt " + attempt + " failed (" + e.getMessage() + "), retrying...");
                    try {
                        Thread.sleep(700L);
                    } catch (InterruptedException ie) {
                        Thread.currentThread().interrupt();
                        return;
                    }
                }
            }
        }

        Log.e(TAG, "Cast connection/load failed", lastError);
        failSession(
            gen,
            "Não foi possível conectar à TV (" + activeDevice.name + "): "
                + (lastError != null && lastError.getMessage() != null
                    ? lastError.getMessage()
                    : "verifique se estão no mesmo Wi-Fi.")
        );
    }

    private void loadDlnaViaHlsContinuousRelay(
        DlnaController dlna,
        int gen,
        TvCastProtocol.HlsPlaylistInfo plan,
        long startPosMs,
        String lanSubtitleSrtUrl
    ) throws IOException {
        loadDlnaViaHlsContinuousRelay(dlna, gen, plan, startPosMs, -1, lanSubtitleSrtUrl);
    }

    private void loadDlnaViaHlsContinuousRelay(
        DlnaController dlna,
        int gen,
        TvCastProtocol.HlsPlaylistInfo plan,
        long startPosMs,
        int explicitSegIdx,
        String lanSubtitleSrtUrl
    ) throws IOException {
        boolean isFmp4 = !plan.initMapUrl.isEmpty();
        String relayMime = isFmp4 ? "video/mp4" : "video/mp2t";
        int segIdx = explicitSegIdx >= 0
            ? Math.min(plan.segments.size() - 1, explicitSegIdx)
            : TvCastProtocol.findHlsSegmentIndexForTimeMs(plan.segments, startPosMs);
        long snappedStartMs = segIdx > 0 ? plan.segments.get(segIdx).startMs : 0L;
        int seekSeq = hlsRelaySeekSeq.incrementAndGet();
        hlsRelayStreamSeq.incrementAndGet();
        String relayUrl = buildActiveLanRelayUrl(gen, seekSeq, segIdx, isFmp4);
        if (relayUrl.isEmpty()) {
            throw new IOException("Proxy Wi-Fi indisponível para stream HLS.");
        }
        hlsRelaySwitching = true;
        try {
            closeActiveHlsRelaySockets();
            hlsTsRelayActive = true;
            hlsTsBaseOffsetMs = snappedStartMs;
            hlsTsRelayStartMs = snappedStartMs;
            hlsRelayInitialLoadAtMs = System.currentTimeMillis();
            hlsRelayFirstRawPosMs = -1L;
            hlsRelayLastRawPosMs = -1L;
            hlsRelayRawPosAdvancing = false;
            hlsRelayAnchorPosMs = snappedStartMs;
            hlsRelayAnchorWallMs = 0L;
            positionMs = snappedStartMs;
            lastSeekTargetMs = snappedStartMs;
            lastSeekRequestedAtMs = System.currentTimeMillis();
            if (plan.totalDurationMs > 0L) {
                durationMs = plan.totalDurationMs;
            }
            lanStreamUrl = relayUrl;
            dlna.loadAndPlay(
                relayUrl,
                relayMime,
                episodeTitle,
                seriesTitle,
                posterUrl,
                0L,
                lanSubtitleSrtUrl,
                plan.totalDurationMs,
                true
            );
            lastSeekRequestedAtMs = System.currentTimeMillis();
        } finally {
            hlsRelaySwitching = false;
        }
    }

    private void failSession(int gen, String msg) {
        if (gen != castSessionGen.get()) return;
        status = "error";
        errorMessage = msg;
        sessionActive = false;
        stopPollingLoop();
        closeActiveRemoteControllers();
        publishCurrentState();
        releaseLocks();
        stopForegroundCompat();
        stopSelf();
    }

    private void performPlay() {
        try {
            if (chromecastController != null) {
                chromecastController.play();
            } else if (dlnaController != null) {
                dlnaController.play();
            }
            if (hlsTsRelayActive) {
                hlsRelayAnchorPosMs = Math.max(hlsTsBaseOffsetMs, positionMs);
                hlsRelayAnchorWallMs = System.currentTimeMillis();
            }
            status = "playing";
            updateNotification();
            publishCurrentState();
        } catch (Exception e) {
            Log.w(TAG, "Play failed: " + e.getMessage());
        }
    }

    private void performPause() {
        try {
            if (hlsTsRelayActive) {
                long livePos = getEffectiveLivePositionMs();
                positionMs = livePos;
                hlsRelayAnchorPosMs = livePos;
                hlsRelayAnchorWallMs = 0L;
            }
            if (chromecastController != null) {
                chromecastController.pause();
            } else if (dlnaController != null) {
                dlnaController.pause();
            }
            status = "paused";
            persistProgressIfNeeded(true, false);
            updateNotification();
            publishCurrentState();
        } catch (Exception e) {
            Log.w(TAG, "Pause failed: " + e.getMessage());
        }
    }

    private void performTogglePlayPause() {
        if ("playing".equals(status) || "buffering".equals(status)) {
            performPause();
        } else {
            performPlay();
        }
    }

    private void performSeekTo(long targetMs) {
        performSeekTo(targetMs, seekRequestGen.incrementAndGet());
    }

    private void performSeekTo(long targetMs, int reqSeq) {
        if (reqSeq != seekRequestGen.get()) return;
        long clamped = Math.max(0L, targetMs);
        if (durationMs > 0L && clamped > durationMs) {
            clamped = Math.max(0L, durationMs - 1000L);
        }
        long currentLivePosMs = getEffectiveLivePositionMs();
        lastSeekTargetMs = clamped;
        lastSeekRequestedAtMs = System.currentTimeMillis();
        try {
            if (chromecastController != null) {
                chromecastController.seek(clamped);
            } else if (dlnaController != null) {
                TvCastProtocol.HlsPlaylistInfo plan = activeDlnaHlsPlan;
                if (hlsTsRelayActive && plan != null && !plan.segments.isEmpty()) {
                    int targetSegIdx = TvCastProtocol.findHlsSegmentIndexForSeek(
                        plan.segments,
                        currentLivePosMs,
                        clamped
                    );
                    long snappedPreviewMs = targetSegIdx > 0 ? plan.segments.get(targetSegIdx).startMs : 0L;
                    positionMs = snappedPreviewMs;
                    lastSeekTargetMs = snappedPreviewMs;
                    status = "buffering";
                    publishCurrentState();

                    boolean handledByTimeSeek = false;
                    if (!hlsTimeSeekFailedForDevice && plan.totalDurationMs > 0L) {
                        int beforeCount = hlsTimeSeekRequestCount.get();
                        hlsPendingTimeSeekTargetMs = snappedPreviewMs;
                        hlsPendingTimeSeekSegIdx = targetSegIdx;
                        hlsPendingTimeSeekAtMs = System.currentTimeMillis();
                        hlsRelaySwitching = true;
                        try {
                            dlnaController.seek(snappedPreviewMs);
                            long deadline = System.currentTimeMillis() + 1800L;
                            while (System.currentTimeMillis() < deadline && reqSeq == seekRequestGen.get()) {
                                if (hlsTimeSeekRequestCount.get() > beforeCount) {
                                    handledByTimeSeek = true;
                                    break;
                                }
                                try {
                                    Thread.sleep(80L);
                                } catch (InterruptedException ie) {
                                    Thread.currentThread().interrupt();
                                    break;
                                }
                            }
                        } catch (Exception seekErr) {
                            Log.i(TAG, "DLNA TimeSeekRange seek unsupported (" + seekErr.getMessage() + "); falling back to URI reload");
                        } finally {
                            hlsRelaySwitching = false;
                        }
                        if (!handledByTimeSeek && reqSeq == seekRequestGen.get()) {
                            hlsTimeSeekFailedForDevice = true;
                            hlsPendingTimeSeekTargetMs = -1L;
                            hlsPendingTimeSeekSegIdx = -1;
                        }
                    }

                    if (!handledByTimeSeek) {
                        if (reqSeq != seekRequestGen.get()) return;
                        String lanSubSrt = (!subtitleDisabled && !subtitleUrl.isEmpty())
                            ? buildLanSubtitleSrtUrl()
                            : "";
                        loadDlnaViaHlsContinuousRelay(
                            dlnaController,
                            castSessionGen.get(),
                            plan,
                            clamped,
                            targetSegIdx,
                            lanSubSrt
                        );
                    }

                    if (reqSeq != seekRequestGen.get()) return;
                    clamped = hlsTsBaseOffsetMs;
                    status = "buffering";
                } else {
                    dlnaController.seek(clamped);
                }
            }
            if (reqSeq != seekRequestGen.get()) return;
            positionMs = clamped;
            if (reqSeq == seekRequestGen.get()) {
                pendingSeekTargetMs = -1L;
            }
            persistProgressIfNeeded(true, false);
            updateNotification();
            publishCurrentState();
        } catch (Exception e) {
            Log.w(TAG, "Seek failed: " + e.getMessage());
            if (reqSeq == seekRequestGen.get()) {
                pendingSeekTargetMs = -1L;
            }
        }
    }

    private void performSetVolume(double level) {
        try {
            lastVolumeSetAtMs = System.currentTimeMillis();
            if (chromecastController != null) {
                chromecastController.setVolume(level);
            } else if (dlnaController != null) {
                dlnaController.setVolume(level);
            }
            volume = level;
            muted = level <= 0.001;
            volumeSynced = true;
            publishCurrentState();
        } catch (Exception e) {
            Log.w(TAG, "SetVolume failed: " + e.getMessage());
        }
    }

    private void performSetTracks(String tracksRaw) {
        if (!sessionActive || activeDevice == null || tracksRaw == null || tracksRaw.trim().isEmpty()) {
            return;
        }
        try {
            JSONObject obj = new JSONObject(tracksRaw);
            boolean hasActiveIds = obj.has("activeTrackIds");
            List<Long> trackIds = new ArrayList<>();
            if (hasActiveIds) {
                JSONArray arr = obj.optJSONArray("activeTrackIds");
                if (arr != null) {
                    for (int i = 0; i < arr.length(); i++) {
                        long id = arr.optLong(i, -1L);
                        if (id >= 0L) trackIds.add(id);
                    }
                }
            }
            if (obj.has("subtitleDisabled")) {
                subtitleDisabled = obj.optBoolean("subtitleDisabled", false);
            }
            if (obj.has("subtitleUrl")) {
                String nextSubUrl = obj.optString("subtitleUrl", "").trim();
                subtitleUrl = subtitleDisabled ? "" : nextSubUrl;
                activeSubtitleSourceUrl = subtitleUrl;
            }
            if (obj.has("subtitleLabel")) {
                subtitleLabel = subtitleDisabled ? "" : obj.optString("subtitleLabel", "").trim();
            }

            ChromecastController cc;
            DlnaController dc;
            synchronized (sessionLock) {
                cc = chromecastController;
                dc = dlnaController;
            }

            if (cc != null && hasActiveIds) {
                cc.editTracksInfo(trackIds);
                JSONArray nextIds = new JSONArray();
                for (Long id : trackIds) nextIds.put(id);
                activeTrackIdsJson = nextIds;
                publishCurrentState();
                return;
            }

            if (dc != null && obj.has("subtitleUrl")) {
                // Reload DLNA URI at current playback position with updated DIDL-Lite subtitle sidecar (or none)
                final int gen = castSessionGen.incrementAndGet();
                connectAndLoadMedia(gen, true);
                return;
            }

            publishCurrentState();
        } catch (Exception e) {
            Log.w(TAG, "SetTracks failed: " + e.getMessage());
        }
    }

    private void switchEpisodeInBackground(String targetEpisodeUrl) {
        if (!sessionActive || activeDevice == null || targetEpisodeUrl == null || targetEpisodeUrl.trim().isEmpty()) {
            return;
        }
        final int gen = castSessionGen.incrementAndGet();
        persistProgressIfNeeded(true, false);
        status = "buffering";
        errorMessage = "";
        updateNotification();
        publishCurrentState();

        try {
            OfflineDownloadsPlugin.OfflinePlaybackInfo offline =
                OfflineDownloadsPlugin.findCompletedDownloadForEpisodeUrl(this, targetEpisodeUrl.trim());
            if (gen != castSessionGen.get()) return;
            if (offline != null && offline.playbackUrl != null && !offline.playbackUrl.isEmpty()) {
                episodeUrl = offline.episodeUrl;
                episodeTitle = offline.title;
                if (offline.seriesUrl != null && !offline.seriesUrl.isEmpty()) {
                    seriesUrl = offline.seriesUrl;
                }
                selectedServerNume = "offline-local";
                streamUrl = offline.playbackUrl;
                streamFormat = offline.format != null ? offline.format : "mp4";
                qualityLabel = offline.qualityLabel != null ? offline.qualityLabel : "Offline";
                subtitleEntries.clear();
                for (OfflineDownloadsPlugin.OfflineSubtitleInfo sub : offline.subtitles) {
                    subtitleEntries.add(new SubtitleEntry(sub.label, sub.url, sub.isDefault));
                }
                if (!subtitleDisabled && !offline.subtitles.isEmpty()) {
                    subtitleUrl = offline.subtitles.get(0).url;
                    subtitleLabel = offline.subtitles.get(0).label;
                } else {
                    subtitleUrl = "";
                    subtitleLabel = "";
                }
                positionMs = 0L;
                durationMs = 0L;
                lastSeekTargetMs = -1L;
                lastSeekRequestedAtMs = 0L;
                handledCompletionForEpisode = false;
                attemptedDirectFallback = false;
                connectAndLoadMedia(gen, true);
                return;
            }

            TopAnimesEpisodeResolver.ResolvedEpisodeData resolved =
                TopAnimesEpisodeResolver.resolveEpisode(targetEpisodeUrl.trim(), selectedServerNume);
            if (gen != castSessionGen.get()) return;
            if (resolved == null || resolved.streams.isEmpty()) {
                errorMessage = "Não foi possível resolver o próximo episódio em segundo plano.";
                publishCurrentState();
                return;
            }
            TopAnimesEpisodeResolver.StreamCandidate best = resolved.streams.get(0);
            for (TopAnimesEpisodeResolver.StreamCandidate sc : resolved.streams) {
                if (sc.height > best.height) {
                    best = sc;
                }
            }
            episodeUrl = resolved.episodeUrl;
            episodeTitle = resolved.title;
            if (resolved.seriesUrl != null && !resolved.seriesUrl.isEmpty()) {
                seriesUrl = resolved.seriesUrl;
            }
            prevUrl = resolved.prevUrl != null ? resolved.prevUrl : "";
            nextUrl = resolved.nextUrl != null ? resolved.nextUrl : "";
            selectedServerNume = resolved.selectedServerNume != null ? resolved.selectedServerNume : selectedServerNume;
            referer = resolved.referer != null && !resolved.referer.isEmpty() ? resolved.referer : referer;
            preferDirect = resolved.preferDirect;
            streamUrl = best.url;
            streamFormat = best.format != null ? best.format : "mp4";
            qualityLabel = best.label != null ? best.label : "";
            subtitleEntries.clear();
            for (TopAnimesEpisodeResolver.SubtitleCandidate sub : resolved.subtitles) {
                subtitleEntries.add(new SubtitleEntry(sub.label, sub.url, sub.isDefault));
            }
            if (!subtitleDisabled && !resolved.subtitles.isEmpty()) {
                subtitleUrl = resolved.subtitles.get(0).url;
                subtitleLabel = resolved.subtitles.get(0).label;
            } else {
                subtitleUrl = "";
                subtitleLabel = "";
            }
            positionMs = 0L;
            durationMs = 0L;
            lastSeekTargetMs = -1L;
            lastSeekRequestedAtMs = 0L;
            handledCompletionForEpisode = false;
            attemptedDirectFallback = false;

            connectAndLoadMedia(gen, false);
        } catch (Exception e) {
            Log.w(TAG, "Background episode switch failed: " + e.getMessage());
            errorMessage = "Falha ao carregar episódio seguinte na TV.";
            publishCurrentState();
        }
    }

    private void handleNaturalEpisodeCompleted(int gen) {
        if (gen != castSessionGen.get() || handledCompletionForEpisode) return;
        handledCompletionForEpisode = true;
        persistProgressIfNeeded(true, true);

        if (autoPlayNextEpisode && nextUrl != null && !nextUrl.trim().isEmpty()) {
            ioExecutor.execute(() -> switchEpisodeInBackground(nextUrl));
            return;
        }
        status = "stopped";
        publishCurrentState();
        stopSessionAndService();
    }

    private void stopSessionAndService() {
        final int stopGen = castSessionGen.incrementAndGet();
        persistProgressIfNeeded(true, false);
        sessionActive = false;
        status = "idle";
        latestPreparedLanStreamUrl = "";
        resetHlsRelayState();
        stopPollingLoop();

        final ChromecastController cc;
        final DlnaController dc;
        synchronized (sessionLock) {
            cc = chromecastController;
            chromecastController = null;
            dc = dlnaController;
            dlnaController = null;
        }

        // Update app UI & remove foreground notification immediately
        broadcastState(buildIdleStateJson());
        stopForegroundCompat();

        Runnable remoteStopAndCleanup = () -> {
            try {
                // Send Stop to TV FIRST while Wi-Fi lock is still held so LG webOS / Chromecast
                // exits the video cleanly and immediately without a network-drop error dialog.
                if (cc != null) {
                    cc.stopAndClose();
                }
                if (dc != null) {
                    dc.stopQuietly();
                }
            } finally {
                if (castSessionGen.get() == stopGen) {
                    stopLanProxyServer();
                    releaseLocks();
                    stopSelf();
                }
            }
        };

        if (cc != null || dc != null) {
            if (Looper.myLooper() == Looper.getMainLooper()) {
                Thread stopThread = new Thread(remoteStopAndCleanup, "AnisyncCastRemoteStop");
                stopThread.start();
            } else {
                remoteStopAndCleanup.run();
            }
        } else {
            stopLanProxyServer();
            releaseLocks();
            stopSelf();
        }
    }

    private void teardownControllersAndServer() {
        stopPollingLoop();
        closeActiveRemoteControllers();
        stopLanProxyServer();
    }

    private void closeActiveRemoteControllers() {
        final ChromecastController cc;
        final DlnaController dc;
        synchronized (sessionLock) {
            cc = chromecastController;
            chromecastController = null;
            dc = dlnaController;
            dlnaController = null;
        }
        if (cc == null && dc == null) return;
        Runnable stopTask = () -> {
            if (cc != null) {
                cc.stopAndClose();
            }
            if (dc != null) {
                dc.stopQuietly();
            }
        };
        if (Looper.myLooper() == Looper.getMainLooper()) {
            Thread stopThread = new Thread(stopTask, "AnisyncCastCloseRemote");
            stopThread.start();
        } else {
            stopTask.run();
        }
    }

    private void startPollingLoop(int gen) {
        stopPollingLoop();
        if (scheduler == null || scheduler.isShutdown()) return;
        // Poll every 1s for real-time playback time sync with the TV; catch Throwable so the scheduler never stops.
        pollFuture = scheduler.scheduleAtFixedRate(() -> {
            if (gen != castSessionGen.get() || !sessionActive) return;
            try {
                ChromecastController cc;
                DlnaController dc;
                synchronized (sessionLock) {
                    cc = chromecastController;
                    dc = dlnaController;
                }
                if (cc != null) {
                    cc.pollStatus();
                } else if (dc != null) {
                    dc.pollStatus(gen);
                }
            } catch (Throwable t) {
                Log.d(TAG, "Status poll error: " + t.getMessage());
            }
        }, 1, 1, TimeUnit.SECONDS);
    }

    private void stopPollingLoop() {
        ScheduledFuture<?> f = pollFuture;
        pollFuture = null;
        if (f != null) {
            f.cancel(false);
        }
    }

    // -------------------------------------------------------------------------
    // Direct Probe + Token-Gated Background LAN HTTP Proxy
    // -------------------------------------------------------------------------

    private boolean probeDirectPlayable(String rawUrl) {
        if (!TvCastProtocol.isSafeExternalHttpUrl(rawUrl)) return false;
        HttpURLConnection conn = null;
        try {
            URL url = new URL(rawUrl);
            conn = (HttpURLConnection) url.openConnection();
            conn.setInstanceFollowRedirects(true);
            conn.setConnectTimeout(3000);
            conn.setReadTimeout(3000);
            conn.setRequestMethod("GET");
            conn.setRequestProperty("Range", "bytes=0-4095");
            conn.setRequestProperty("Accept", "*/*");
            int code = conn.getResponseCode();
            if (code != 200 && code != 206) return false;
            String ct = conn.getContentType();
            String lowerCt = ct != null ? ct.toLowerCase(Locale.ROOT) : "";
            if (lowerCt.startsWith("text/") || lowerCt.startsWith("image/") || lowerCt.contains("html")) {
                return false;
            }
            byte[] probe = new byte[256];
            int n;
            try (InputStream in = conn.getInputStream()) {
                n = LocalProxyPlugin.readUpTo(in, probe);
            }
            if (n < 12) return false;
            // Reject PNG-disguised chunks or HTML error pages
            if ((probe[0] & 0xFF) == 0x89 && probe[1] == 'P' && probe[2] == 'N' && probe[3] == 'G') {
                return false;
            }
            if (probe[0] == '<') return false;
            return true;
        } catch (Exception e) {
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private synchronized String ensureLanProxyBaseUrl() {
        String lanIp = TvCastDiscovery.getLocalLanIpv4Address(this);
        if (lanIp.isEmpty()) {
            return "";
        }
        if (lanServerRunning && lanServerPort > 0 && lanServerSocket != null && !lanServerSocket.isClosed()) {
            return "http://" + lanIp + ":" + lanServerPort;
        }
        try {
            byte[] tokenBytes = new byte[16];
            new SecureRandom().nextBytes(tokenBytes);
            StringBuilder hex = new StringBuilder(32);
            for (byte b : tokenBytes) {
                hex.append(String.format(Locale.ROOT, "%02x", b & 0xff));
            }
            lanSecretToken = hex.toString();

            lanServerSocket = new ServerSocket();
            lanServerSocket.setReuseAddress(true);
            lanServerSocket.bind(new InetSocketAddress(InetAddress.getByName("0.0.0.0"), 0), 64);
            lanServerPort = lanServerSocket.getLocalPort();
            lanServerRunning = true;

            final ServerSocket bound = lanServerSocket;
            Thread acceptThread = new Thread(() -> {
                while (lanServerRunning && !bound.isClosed()) {
                    try {
                        Socket client = bound.accept();
                        if (proxyExecutor != null && !proxyExecutor.isShutdown()) {
                            proxyExecutor.execute(() -> handleLanClientSocket(client));
                        } else {
                            client.close();
                        }
                    } catch (IOException e) {
                        if (lanServerRunning) {
                            Log.d(TAG, "LAN proxy accept: " + e.getMessage());
                        }
                    }
                }
            }, "AnisyncCastLanProxy");
            acceptThread.setDaemon(true);
            acceptThread.start();
            Log.i(TAG, "Background LAN Cast Proxy running at http://" + lanIp + ":" + lanServerPort);
            return "http://" + lanIp + ":" + lanServerPort;
        } catch (Exception e) {
            Log.e(TAG, "Failed starting LAN Cast Proxy", e);
            return "";
        }
    }

    private synchronized void stopLanProxyServer() {
        lanServerRunning = false;
        lanServerPort = -1;
        lanSecretToken = "";
        ServerSocket sock = lanServerSocket;
        lanServerSocket = null;
        if (sock != null) {
            try {
                sock.close();
            } catch (Exception ignored) {
            }
        }
        for (Socket client : activeLanClientSockets) {
            try {
                client.close();
            } catch (Exception ignored) {
            }
        }
        activeLanClientSockets.clear();
        activeHlsRelaySockets.clear();
    }

    private String ensureLanStreamUrlForCurrentMedia() {
        String base = ensureLanProxyBaseUrl();
        if (base.isEmpty() || streamUrl.isEmpty() || lanSecretToken.isEmpty()) return "";
        activeSubtitleSourceUrl = subtitleDisabled ? "" : subtitleUrl;
        activeSubtitleReferer = referer;
        TvCastProtocol.LocalOfflineAsset offline = TvCastProtocol.parseLocalOfflineAsset(streamUrl);
        if (offline != null) {
            return TvCastProtocol.buildLanOfflineAssetUrl(base, lanSecretToken, offline.downloadId, offline.fileName);
        }
        boolean isHls = TvCastProtocol.isHlsStreamUrl(streamUrl, streamFormat);
        return TvCastProtocol.buildLanProxyUrl(base, lanSecretToken, streamUrl, referer, false, isHls);
    }

    private String buildLanSubtitleUrl() {
        String base = ensureLanProxyBaseUrl();
        if (base.isEmpty() || lanSecretToken.isEmpty() || subtitleDisabled || subtitleUrl.isEmpty()) return "";
        return base + "/cast/" + lanSecretToken + "/subtitle.vtt";
    }

    private String buildLanSubtitleSrtUrl() {
        String base = ensureLanProxyBaseUrl();
        if (base.isEmpty() || lanSecretToken.isEmpty() || subtitleDisabled || subtitleUrl.isEmpty()) return "";
        return base + "/cast/" + lanSecretToken + "/subtitle.srt";
    }

    private String buildLanIndexedSubtitleUrl(int idx, boolean asSrt) {
        String base = ensureLanProxyBaseUrl();
        if (base.isEmpty() || lanSecretToken.isEmpty() || idx < 0) return "";
        return base + "/cast/" + lanSecretToken + "/subtitles/" + idx + (asSrt ? ".srt" : ".vtt");
    }

    private void handleLanClientSocket(Socket client) {
        activeLanClientSockets.add(client);
        try (Socket sock = client) {
            sock.setSoTimeout(30000);
            try {
                sock.setKeepAlive(true);
                sock.setTcpNoDelay(true);
            } catch (Exception ignored) {
            }
            InputStream in = new BufferedInputStream(sock.getInputStream());
            OutputStream out = sock.getOutputStream();

            String requestLine = LocalProxyPlugin.readLine(in);
            if (requestLine == null || requestLine.isEmpty()) return;

            String[] parts = requestLine.split(" ");
            if (parts.length < 2) return;
            String method = parts[0].toUpperCase(Locale.ROOT);
            String target = parts[1];

            Map<String, String> reqHeaders = new HashMap<>();
            String headerLine;
            while ((headerLine = LocalProxyPlugin.readLine(in)) != null && !headerLine.isEmpty()) {
                int idx = headerLine.indexOf(':');
                if (idx > 0) {
                    reqHeaders.put(
                        headerLine.substring(0, idx).trim().toLowerCase(Locale.ROOT),
                        headerLine.substring(idx + 1).trim()
                    );
                }
            }

            if ("OPTIONS".equals(method)) {
                writeLanHeaders(out, 204, "No Content", null, 0L, null, null, null);
                out.flush();
                return;
            }

            String expectedPrefix = "/cast/" + lanSecretToken + "/";
            if (lanSecretToken.isEmpty() || !target.startsWith(expectedPrefix)) {
                writeLanSimpleError(out, 403, "Forbidden", "Invalid cast session token");
                return;
            }

            String pathOnly = target;
            int qIdx = pathOnly.indexOf('?');
            if (qIdx >= 0) pathOnly = pathOnly.substring(0, qIdx);

            String hostHeader = reqHeaders.get("host");
            String lanBase = (hostHeader != null && !hostHeader.trim().isEmpty())
                ? ("http://" + hostHeader.trim())
                : ensureLanProxyBaseUrl();

            String relPath = pathOnly.substring(expectedPrefix.length());
            if ("subtitle.vtt".equals(relPath)) {
                serveLanSubtitle(out, method, activeSubtitleSourceUrl, false);
                return;
            }
            if ("subtitle.srt".equals(relPath)) {
                serveLanSubtitle(out, method, activeSubtitleSourceUrl, true);
                return;
            }
            if (relPath.startsWith("subtitles/")) {
                String subSpec = relPath.substring("subtitles/".length());
                boolean wantSrt = subSpec.endsWith(".srt");
                boolean wantVtt = subSpec.endsWith(".vtt");
                if (wantSrt || wantVtt) {
                    String numPart = subSpec.substring(0, subSpec.length() - 4);
                    try {
                        int subIdx = Integer.parseInt(numPart);
                        if (subIdx >= 0 && subIdx < subtitleEntries.size()) {
                            serveLanSubtitle(out, method, subtitleEntries.get(subIdx).url, wantSrt);
                            return;
                        }
                    } catch (NumberFormatException ignored) {
                    }
                }
                writeLanSimpleError(out, 404, "Not Found", "Subtitle track not found");
                return;
            }

            if (relPath.startsWith("offline/")) {
                serveLanOfflineAsset(relPath.substring("offline/".length()), method, reqHeaders, lanBase, out);
                return;
            }

            if (relPath.endsWith("/video.ts") || relPath.endsWith("/video-fmp4.mp4")) {
                boolean isFmp4 = relPath.endsWith("/video-fmp4.mp4");
                int reqSeekSeq = -1;
                int reqStartIdx = -1;
                String[] relayParts = relPath.split("/");
                for (String part : relayParts) {
                    if (part.length() > 1 && part.charAt(0) == 's') {
                        try {
                            reqSeekSeq = Integer.parseInt(part.substring(1));
                        } catch (NumberFormatException ignored) {
                        }
                    } else if (part.length() > 1 && part.charAt(0) == 'i') {
                        try {
                            reqStartIdx = Integer.parseInt(part.substring(1));
                        } catch (NumberFormatException ignored) {
                        }
                    }
                }
                serveLanHlsContinuousRelay(client, out, method, reqHeaders, lanBase, isFmp4, reqSeekSeq, reqStartIdx);
                return;
            }

            Map<String, String> query = LocalProxyPlugin.parseQuery(target);
            String targetUrl = query.getOrDefault("url", streamUrl);
            TvCastProtocol.LocalOfflineAsset targetOffline = TvCastProtocol.parseLocalOfflineAsset(targetUrl);
            if (targetOffline != null) {
                serveLanOfflineAsset(
                    targetOffline.downloadId + "/" + targetOffline.fileName,
                    method,
                    reqHeaders,
                    lanBase,
                    out
                );
                return;
            }

            String refParam = query.getOrDefault("referer", referer);
            String safeRef = LocalProxyPlugin.isSafeHttpUrl(refParam) ? refParam : "https://topanimes.net/";
            boolean isHlsSegment = "1".equals(query.get("hls_seg"));

            if (!LocalProxyPlugin.isSafeHttpUrl(targetUrl)) {
                writeLanSimpleError(out, 400, "Bad Request", "Invalid media URL");
                return;
            }

            String captionHeaderUrl = (!subtitleDisabled && !activeSubtitleSourceUrl.isEmpty() && !isHlsSegment)
                ? (lanBase + "/cast/" + lanSecretToken + "/subtitle.srt")
                : null;
            String rangeHeader = reqHeaders.get("range");
            boolean isHeadRequest = "HEAD".equals(method);
            boolean likelyPlaylistRequest = pathOnly.endsWith(".m3u8") || TvCastProtocol.isHlsStreamUrl(targetUrl, "");
            HttpURLConnection conn = null;
            try {
                boolean usedRangeProbeForHead = false;
                boolean upstreamWasHead = false;
                LocalProxyPlugin.RedirectResult upstream;
                if (isHeadRequest && !likelyPlaylistRequest) {
                    if (TvCastProtocol.shouldAvoidUpstreamHead(targetUrl)) {
                        usedRangeProbeForHead = true;
                        upstream = openUpstreamWithRetry(targetUrl, safeRef, "bytes=0-0", "GET");
                    } else {
                        upstream = openUpstreamWithRetry(targetUrl, safeRef, null, "HEAD");
                        int headCode = upstream.connection.getResponseCode();
                        String headCl = upstream.connection.getHeaderField("Content-Length");
                        if (headCode < 200 || headCode >= 300 || headCl == null || headCl.trim().isEmpty()) {
                            upstream.connection.disconnect();
                            usedRangeProbeForHead = true;
                            upstream = openUpstreamWithRetry(targetUrl, safeRef, "bytes=0-0", "GET");
                        } else {
                            upstreamWasHead = true;
                        }
                    }
                } else {
                    upstream = openUpstreamWithRetry(
                        targetUrl,
                        safeRef,
                        isHeadRequest ? null : rangeHeader,
                        "GET"
                    );
                }
                conn = upstream.connection;
                int code = conn.getResponseCode();
                String contentType = conn.getContentType();
                boolean isPlaylist = (contentType != null && contentType.toLowerCase(Locale.ROOT).contains("mpegurl"))
                    || (contentType != null && contentType.toLowerCase(Locale.ROOT).contains("m3u8"))
                    || TvCastProtocol.isHlsStreamUrl(targetUrl, "");

                if (isPlaylist && code >= 200 && code < 300) {
                    if (upstreamWasHead) {
                        conn.disconnect();
                        upstream = openUpstreamWithRetry(targetUrl, safeRef, null, "GET");
                        conn = upstream.connection;
                        code = conn.getResponseCode();
                    }
                    String rawManifest = LocalProxyPlugin.readStreamAsString(conn.getInputStream());
                    String rewritten = TvCastProtocol.rewriteM3u8ForLanProxy(
                        rawManifest,
                        upstream.finalUrl,
                        lanBase,
                        lanSecretToken,
                        safeRef
                    );
                    byte[] payload = rewritten.getBytes(StandardCharsets.UTF_8);
                    writeLanHeaders(
                        out,
                        200,
                        "OK",
                        "application/vnd.apple.mpegurl; charset=utf-8",
                        payload.length,
                        null,
                        null,
                        captionHeaderUrl
                    );
                    if (!"HEAD".equals(method)) {
                        out.write(payload);
                    }
                    out.flush();
                    return;
                }

                if (isHeadRequest && usedRangeProbeForHead && code >= 200 && code < 300) {
                    String cr = conn.getHeaderField("Content-Range");
                    long fullLen = TvCastProtocol.parseTotalLengthFromContentRange(cr);
                    if (fullLen < 0L && code == 200) {
                        try {
                            String cl = conn.getHeaderField("Content-Length");
                            if (cl != null) fullLen = Long.parseLong(cl.trim());
                        } catch (NumberFormatException ignored) {
                        }
                    }
                    String outCt = TvCastProtocol.normalizeDlnaVideoMimeType(contentType, targetUrl, streamFormat);
                    writeLanHeaders(out, 200, "OK", outCt, fullLen, null, "bytes", captionHeaderUrl);
                    out.flush();
                    return;
                }

                String statusText = code == 206 ? "Partial Content" : (code == 200 ? "OK" : "Upstream");
                long contentLength = -1L;
                try {
                    String cl = conn.getHeaderField("Content-Length");
                    if (cl != null) contentLength = Long.parseLong(cl.trim());
                } catch (NumberFormatException ignored) {
                }
                String contentRange = conn.getHeaderField("Content-Range");
                String acceptRanges = conn.getHeaderField("Accept-Ranges");
                if (acceptRanges == null || acceptRanges.trim().isEmpty()
                    || ("none".equalsIgnoreCase(acceptRanges.trim()) && contentLength > 0L && !isHlsSegment && !isPlaylist)) {
                    acceptRanges = "bytes";
                }

                InputStream bodyStream = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
                boolean shouldProbeTs = code >= 200
                    && code < 300
                    && !upstreamWasHead
                    && bodyStream != null
                    && LocalProxyPlugin.isStartAtZeroRange(rangeHeader)
                    && (isHlsSegment || LocalProxyPlugin.isDisguisedContentType(contentType));

                if (shouldProbeTs) {
                    byte[] probeBuf = new byte[32768];
                    int probeLen = LocalProxyPlugin.readUpTo(bodyStream, probeBuf);
                    boolean reachedEof = probeLen < probeBuf.length;

                    if (LocalProxyPlugin.looksLikeM3u8Manifest(probeBuf, probeLen)) {
                        ByteArrayOutputStream manifestOut = new ByteArrayOutputStream(probeLen + 8192);
                        manifestOut.write(probeBuf, 0, probeLen);
                        if (!reachedEof) {
                            byte[] restBuf = new byte[8192];
                            int rn;
                            while ((rn = bodyStream.read(restBuf)) != -1) {
                                manifestOut.write(restBuf, 0, rn);
                            }
                        }
                        String rawManifest = manifestOut.toString(StandardCharsets.UTF_8.name());
                        String rewritten = TvCastProtocol.rewriteM3u8ForLanProxy(
                            rawManifest,
                            upstream.finalUrl,
                            lanBase,
                            lanSecretToken,
                            safeRef
                        );
                        byte[] payload = rewritten.getBytes(StandardCharsets.UTF_8);
                        writeLanHeaders(
                            out,
                            200,
                            "OK",
                            "application/vnd.apple.mpegurl; charset=utf-8",
                            payload.length,
                            null,
                            null,
                            captionHeaderUrl
                        );
                        if (!"HEAD".equals(method)) {
                            out.write(payload);
                        }
                        out.flush();
                        return;
                    }

                    int tsOffset = LocalProxyPlugin.findMpegTsSyncOffset(probeBuf, probeLen, reachedEof);
                    int outStatus = code;
                    String outStatusText = statusText;
                    String outCt = TvCastProtocol.normalizeDlnaVideoMimeType(contentType, targetUrl, streamFormat);
                    long outCl = contentLength;
                    String outCr = contentRange;
                    String outAr = acceptRanges;

                    if (tsOffset >= 0) {
                        outCt = "video/mp2t";
                        if (tsOffset > 0) {
                            if (outCl >= tsOffset) {
                                outCl -= tsOffset;
                            } else if (outCl >= 0) {
                                outCl = -1L;
                            }
                            if (outStatus == 206) {
                                String adjustedRange = LocalProxyPlugin.adjustContentRangeForStrip(outCr, tsOffset);
                                if (adjustedRange != null) {
                                    outCr = adjustedRange;
                                } else {
                                    outStatus = 200;
                                    outStatusText = "OK";
                                    outCr = null;
                                }
                            }
                            outAr = null;
                        }
                    }

                    writeLanHeaders(out, outStatus, outStatusText, outCt, outCl, outCr, outAr, captionHeaderUrl);
                    if (!"HEAD".equals(method)) {
                        int startOff = Math.max(0, tsOffset);
                        if (probeLen > startOff) {
                            out.write(probeBuf, startOff, probeLen - startOff);
                        }
                        if (!reachedEof) {
                            byte[] buf = new byte[65536];
                            int rn;
                            while ((rn = bodyStream.read(buf)) != -1) {
                                out.write(buf, 0, rn);
                            }
                        }
                    }
                    out.flush();
                    return;
                }

                String outCt = TvCastProtocol.normalizeDlnaVideoMimeType(contentType, targetUrl, streamFormat);
                if (!isHeadRequest && rangeHeader != null && code == 200 && bodyStream != null && contentLength > 0L) {
                    long[] byteRange = TvCastProtocol.parseHttpByteRangeHeader(rangeHeader, contentLength);
                    if (byteRange != null && (byteRange[0] > 0L || byteRange[1] < contentLength - 1L)) {
                        long rangeStart = byteRange[0];
                        long rangeEnd = byteRange[1];
                        long toSkip = rangeStart;
                        byte[] skipBuf = new byte[65536];
                        while (toSkip > 0L && lanServerRunning && sessionActive) {
                            int rn = bodyStream.read(skipBuf, 0, (int) Math.min(skipBuf.length, toSkip));
                            if (rn == -1) break;
                            toSkip -= rn;
                        }
                        if (toSkip == 0L) {
                            long partLen = (rangeEnd - rangeStart) + 1L;
                            String emuContentRange = "bytes " + rangeStart + "-" + rangeEnd + "/" + contentLength;
                            writeLanHeaders(out, 206, "Partial Content", outCt, partLen, emuContentRange, "bytes", captionHeaderUrl);
                            long remaining = partLen;
                            byte[] buf = new byte[65536];
                            while (remaining > 0L && lanServerRunning && sessionActive) {
                                int rn = bodyStream.read(buf, 0, (int) Math.min(buf.length, remaining));
                                if (rn == -1) break;
                                out.write(buf, 0, rn);
                                remaining -= rn;
                            }
                            out.flush();
                            return;
                        }
                    }
                }

                writeLanHeaders(out, code, statusText, outCt, contentLength, contentRange, acceptRanges, captionHeaderUrl);
                if (bodyStream != null && !"HEAD".equals(method)) {
                    byte[] buf = new byte[65536];
                    int rn;
                    while ((rn = bodyStream.read(buf)) != -1) {
                        out.write(buf, 0, rn);
                    }
                }
                out.flush();
            } finally {
                if (conn != null) conn.disconnect();
            }
        } catch (Exception e) {
            Log.d(TAG, "LAN proxy socket closed: " + e.getMessage());
        } finally {
            activeLanClientSockets.remove(client);
        }
    }

    /**
     * Streams an HLS playlist's segments sequentially as a single continuous MPEG-TS (video/mp2t)
     * or fragmented MP4 (video/mp4) HTTP response so DLNA Smart TVs without native .m3u8 support
     * (notably LG webOS, Samsung Tizen, Sony BRAVIA) play Vidstreaming/KojimaCDN/Zuplay HLS
     * streams natively without HTTP 500 / UPnP 714 Illegal MIME-type errors.
     */
    private void serveLanHlsContinuousRelay(
        Socket client,
        OutputStream out,
        String method,
        Map<String, String> reqHeaders,
        String lanBase,
        boolean isFmp4,
        int reqSeekSeq,
        int reqStartIdx
    ) throws IOException {
        TvCastProtocol.HlsPlaylistInfo plan = activeDlnaHlsPlan;
        if (plan == null || plan.segments.isEmpty()) {
            writeLanSimpleError(out, 404, "Not Found", "No active HLS relay plan");
            return;
        }
        if (reqSeekSeq > 0 && hlsRelaySeekSeq.get() != reqSeekSeq) {
            writeLanSimpleError(out, 410, "Gone", "Superseded HLS relay seek");
            return;
        }

        String rawTimeSeek = reqHeaders != null ? reqHeaders.get("timeseekrange.dlna.org") : null;
        long reqTimeSeekMs = TvCastProtocol.parseDlnaTimeSeekRangeStartMs(rawTimeSeek);
        boolean useClockNpt = rawTimeSeek != null && rawTimeSeek.contains(":");
        long nowMs = System.currentTimeMillis();

        int startIdx;
        boolean isTimeSeekEvent = false;
        boolean matchedPhoneSeek = false;
        if (reqTimeSeekMs >= 0L) {
            boolean isInitialZeroProbeOnResumedUri = reqStartIdx > 0
                && reqTimeSeekMs == 0L
                && (nowMs - hlsRelayInitialLoadAtMs) < 5000L
                && hlsPendingTimeSeekTargetMs != 0L;
            if (isInitialZeroProbeOnResumedUri) {
                startIdx = Math.min(plan.segments.size() - 1, reqStartIdx);
            } else {
                isTimeSeekEvent = true;
                int pendingIdx = hlsPendingTimeSeekSegIdx;
                long pendingTarget = hlsPendingTimeSeekTargetMs;
                if (pendingIdx >= 0
                    && (nowMs - hlsPendingTimeSeekAtMs) < 5000L
                    && Math.abs(reqTimeSeekMs - pendingTarget) <= 15_000L) {
                    startIdx = Math.min(plan.segments.size() - 1, pendingIdx);
                    matchedPhoneSeek = true;
                } else {
                    startIdx = TvCastProtocol.findHlsSegmentIndexForSeek(
                        plan.segments,
                        getEffectiveLivePositionMs(),
                        reqTimeSeekMs
                    );
                }
            }
        } else {
            startIdx = reqStartIdx >= 0
                ? Math.min(plan.segments.size() - 1, reqStartIdx)
                : TvCastProtocol.findHlsSegmentIndexForTimeMs(plan.segments, hlsTsRelayStartMs);
        }

        long snappedStartMs = startIdx > 0 ? plan.segments.get(startIdx).startMs : 0L;
        String timeSeekRespHeader = plan.totalDurationMs > 0L
            ? TvCastProtocol.formatDlnaTimeSeekRangeHeader(snappedStartMs, plan.totalDurationMs, useClockNpt)
            : "";

        String mime = isFmp4 ? "video/mp4" : "video/mp2t";
        String captionHeaderUrl = (!subtitleDisabled && !activeSubtitleSourceUrl.isEmpty())
            ? (lanBase + "/cast/" + lanSecretToken + "/subtitle.srt")
            : null;
        writeLanHeaders(out, 200, "OK", mime, -1L, null, "none", captionHeaderUrl, true, timeSeekRespHeader);
        out.flush();
        if ("HEAD".equals(method)) {
            return;
        }

        if (isTimeSeekEvent) {
            hlsTsBaseOffsetMs = snappedStartMs;
            hlsTsRelayStartMs = snappedStartMs;
            hlsRelayFirstRawPosMs = -1L;
            hlsRelayLastRawPosMs = -1L;
            hlsRelayRawPosAdvancing = false;
            hlsRelayAnchorPosMs = snappedStartMs;
            hlsRelayAnchorWallMs = nowMs;
            positionMs = snappedStartMs;
            lastSeekTargetMs = snappedStartMs;
            lastSeekRequestedAtMs = nowMs;
            hlsTimeSeekRequestCount.incrementAndGet();
            if (matchedPhoneSeek) {
                hlsPendingTimeSeekTargetMs = -1L;
                hlsPendingTimeSeekSegIdx = -1;
            } else {
                publishCurrentState();
            }
        }

        final int startGen = castSessionGen.get();
        final int startSeq = reqSeekSeq > 0 ? reqSeekSeq : hlsRelaySeekSeq.get();
        final int myStreamSeq = hlsRelayStreamSeq.incrementAndGet();
        final String safeRef = LocalProxyPlugin.isSafeHttpUrl(referer) ? referer : "https://topanimes.net/";

        if (isTimeSeekEvent) {
            closeActiveHlsRelaySockets();
        }
        activeHlsRelaySockets.add(client);
        try {
            if (isFmp4 && !plan.initMapUrl.isEmpty()) {
                byte[] initBytes = fetchRelaySegmentBytes(plan.initMapUrl, safeRef);
                if (initBytes != null && initBytes.length > 0) {
                    out.write(initBytes);
                    out.flush();
                }
            }

            for (int i = startIdx; i < plan.segments.size(); i++) {
                if (!lanServerRunning || !sessionActive
                    || castSessionGen.get() != startGen
                    || hlsRelaySeekSeq.get() != startSeq
                    || hlsRelayStreamSeq.get() != myStreamSeq) {
                    break;
                }
                TvCastProtocol.HlsSegmentEntry seg = plan.segments.get(i);
                byte[] segBytes = fetchRelaySegmentBytes(seg.url, safeRef);
                if (segBytes == null || segBytes.length == 0) {
                    continue;
                }
                if ("AES-128".equalsIgnoreCase(seg.keyMethod) && !seg.keyUri.isEmpty()) {
                    byte[] decrypted = decryptHlsAes128Segment(segBytes, seg.keyUri, seg.keyIvHex, seg.mediaSequence, safeRef);
                    if (decrypted != null) {
                        segBytes = decrypted;
                    }
                }
                int writeOffset = 0;
                if (!isFmp4) {
                    int tsOffset = LocalProxyPlugin.findMpegTsSyncOffset(segBytes, segBytes.length, true);
                    if (tsOffset > 0 && tsOffset < segBytes.length) {
                        writeOffset = tsOffset;
                    }
                }
                out.write(segBytes, writeOffset, segBytes.length - writeOffset);
                out.flush();
            }
        } finally {
            activeHlsRelaySockets.remove(client);
        }
    }

    private byte[] fetchRelaySegmentBytes(String segUrl, String safeRef) {
        if (segUrl == null || segUrl.isEmpty()) return null;
        TvCastProtocol.LocalOfflineAsset offline = TvCastProtocol.parseLocalOfflineAsset(segUrl);
        if (offline != null) {
            try {
                File root = LocalProxyPlugin.getOfflineMediaRootDir(this);
                if (root == null || !root.exists()) return null;
                File targetFile = new File(new File(root, offline.downloadId), offline.fileName);
                String rootCanon = root.getCanonicalPath();
                String fileCanon = targetFile.getCanonicalPath();
                if (!fileCanon.startsWith(rootCanon + File.separator) || !targetFile.isFile()) return null;
                ByteArrayOutputStream baos = new ByteArrayOutputStream((int) Math.min(targetFile.length(), 2 * 1024 * 1024));
                try (FileInputStream fis = new FileInputStream(targetFile)) {
                    byte[] buf = new byte[65536];
                    int n;
                    while ((n = fis.read(buf)) != -1) {
                        baos.write(buf, 0, n);
                    }
                }
                return baos.toByteArray();
            } catch (Exception e) {
                Log.d(TAG, "Offline HLS relay segment read failed: " + e.getMessage());
                return null;
            }
        }
        HttpURLConnection conn = null;
        try {
            LocalProxyPlugin.RedirectResult res = openUpstreamWithRetry(segUrl, safeRef, null, "GET");
            conn = res.connection;
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) return null;
            ByteArrayOutputStream baos = new ByteArrayOutputStream(262144);
            try (InputStream in = conn.getInputStream()) {
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) != -1) {
                    baos.write(buf, 0, n);
                }
            }
            return baos.toByteArray();
        } catch (Exception e) {
            Log.d(TAG, "Remote HLS relay segment fetch failed: " + e.getMessage());
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private byte[] decryptHlsAes128Segment(
        byte[] cipherBytes,
        String keyUri,
        String keyIvHex,
        long mediaSequence,
        String safeRef
    ) {
        try {
            byte[] keyBytes = hlsAesKeyCache.get(keyUri);
            if (keyBytes == null) {
                byte[] fetched = fetchRelaySegmentBytes(keyUri, safeRef);
                if (fetched != null && fetched.length == 16) {
                    keyBytes = fetched;
                    hlsAesKeyCache.put(keyUri, keyBytes);
                }
            }
            if (keyBytes == null || keyBytes.length != 16) return null;
            byte[] iv = TvCastProtocol.buildAes128IvBytes(keyIvHex, mediaSequence);
            Cipher cipher = Cipher.getInstance("AES/CBC/PKCS5Padding");
            cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(keyBytes, "AES"), new IvParameterSpec(iv));
            return cipher.doFinal(cipherBytes);
        } catch (Exception e) {
            Log.d(TAG, "HLS AES-128 segment decrypt failed: " + e.getMessage());
            return null;
        }
    }

    private LocalProxyPlugin.RedirectResult openUpstreamWithRetry(
        String targetUrl,
        String safeRef,
        String rangeHeader,
        String method
    ) throws IOException {
        IOException lastErr = null;
        for (int attempt = 1; attempt <= 2; attempt++) {
            try {
                return LocalProxyPlugin.openWithRedirects(
                    targetUrl,
                    safeRef,
                    "*/*",
                    rangeHeader,
                    20000,
                    method
                );
            } catch (IOException ioe) {
                lastErr = ioe;
                if (attempt < 2) {
                    try {
                        Thread.sleep(300L);
                    } catch (InterruptedException ie) {
                        Thread.currentThread().interrupt();
                        throw ioe;
                    }
                }
            }
        }
        throw lastErr != null ? lastErr : new IOException("Falha ao acessar stream remoto.");
    }

    private void serveLanOfflineAsset(
        String rel,
        String method,
        Map<String, String> reqHeaders,
        String lanBase,
        OutputStream out
    ) throws IOException {
        if (!"GET".equals(method) && !"HEAD".equals(method)) {
            writeLanSimpleError(out, 405, "Method Not Allowed", "Method Not Allowed");
            return;
        }
        int slashIdx = rel.indexOf('/');
        if (slashIdx <= 0 || slashIdx >= rel.length() - 1) {
            writeLanSimpleError(out, 404, "Not Found", "Invalid offline asset path");
            return;
        }
        String downloadId = rel.substring(0, slashIdx);
        String fileName = rel.substring(slashIdx + 1);
        if (!TvCastProtocol.isSafeOfflineAssetName(downloadId, fileName)) {
            writeLanSimpleError(out, 400, "Bad Request", "Unsafe offline asset path");
            return;
        }

        File root = LocalProxyPlugin.getOfflineMediaRootDir(this);
        if (root == null || !root.exists()) {
            writeLanSimpleError(out, 404, "Not Found", "Offline storage unavailable");
            return;
        }
        File targetFile = new File(new File(root, downloadId), fileName);
        String rootCanon = root.getCanonicalPath();
        String fileCanon = targetFile.getCanonicalPath();
        if (!fileCanon.startsWith(rootCanon + File.separator) || !targetFile.isFile()) {
            writeLanSimpleError(out, 404, "Not Found", "Offline asset not found");
            return;
        }

        String lowerName = fileName.toLowerCase(Locale.ROOT);
        String captionHeaderUrl = (!subtitleDisabled && !activeSubtitleSourceUrl.isEmpty()
            && (lowerName.endsWith(".mp4") || lowerName.endsWith(".m3u8")))
            ? (lanBase + "/cast/" + lanSecretToken + "/subtitle.srt")
            : null;

        if (lowerName.endsWith(".m3u8")) {
            String rawManifest;
            try (FileInputStream fis = new FileInputStream(targetFile)) {
                rawManifest = LocalProxyPlugin.readStreamAsString(fis);
            }
            String rewritten = TvCastProtocol.rewriteOfflineM3u8ForLanProxy(
                rawManifest,
                lanBase,
                lanSecretToken,
                downloadId
            );
            byte[] payload = rewritten.getBytes(StandardCharsets.UTF_8);
            writeLanHeaders(
                out,
                200,
                "OK",
                "application/vnd.apple.mpegurl; charset=utf-8",
                payload.length,
                null,
                null,
                captionHeaderUrl
            );
            if (!"HEAD".equals(method)) {
                out.write(payload);
            }
            out.flush();
            return;
        }

        long fileLen = targetFile.length();
        String mime = TvCastProtocol.guessOfflineMimeType(fileName);
        long start = 0L;
        long end = fileLen > 0L ? fileLen - 1L : -1L;
        boolean isRange = false;

        String rangeHeader = reqHeaders.get("range");
        if (rangeHeader != null && !rangeHeader.trim().isEmpty() && fileLen > 0L) {
            String firstSpec = rangeHeader.trim();
            int commaIdx = firstSpec.indexOf(',');
            if (commaIdx > 0) {
                firstSpec = firstSpec.substring(0, commaIdx).trim();
            }
            Matcher m = BYTE_RANGE_PATTERN.matcher(firstSpec);
            if (m.matches()) {
                String startStr = m.group(1);
                String endStr = m.group(2);
                try {
                    if (startStr != null && !startStr.isEmpty()) {
                        start = Long.parseLong(startStr);
                        end = (endStr != null && !endStr.isEmpty())
                            ? Math.min(Long.parseLong(endStr), fileLen - 1L)
                            : fileLen - 1L;
                    } else if (endStr != null && !endStr.isEmpty()) {
                        long suffixLen = Long.parseLong(endStr);
                        if (suffixLen > 0L) {
                            start = Math.max(0L, fileLen - suffixLen);
                            end = fileLen - 1L;
                        }
                    }
                    if (start < 0L || start >= fileLen || start > end) {
                        writeLanHeaders(
                            out,
                            416,
                            "Range Not Satisfiable",
                            "text/plain; charset=utf-8",
                            0L,
                            "bytes */" + fileLen,
                            "bytes",
                            null
                        );
                        out.flush();
                        return;
                    }
                    isRange = true;
                } catch (NumberFormatException ignored) {
                    start = 0L;
                    end = fileLen - 1L;
                    isRange = false;
                }
            }
        }

        long contentLength = fileLen == 0L ? 0L : (end - start + 1L);
        if (isRange) {
            writeLanHeaders(
                out,
                206,
                "Partial Content",
                mime,
                contentLength,
                "bytes " + start + "-" + end + "/" + fileLen,
                "bytes",
                captionHeaderUrl
            );
        } else {
            writeLanHeaders(
                out,
                200,
                "OK",
                mime,
                contentLength,
                null,
                "bytes",
                captionHeaderUrl
            );
        }

        if (!"HEAD".equals(method) && contentLength > 0L) {
            try (RandomAccessFile raf = new RandomAccessFile(targetFile, "r")) {
                raf.seek(start);
                byte[] buf = new byte[65536];
                long remaining = contentLength;
                while (remaining > 0L) {
                    int toRead = (int) Math.min(buf.length, remaining);
                    int n = raf.read(buf, 0, toRead);
                    if (n == -1) break;
                    out.write(buf, 0, n);
                    remaining -= n;
                }
            }
        }
        out.flush();
    }

    private void serveLanSubtitle(OutputStream out, String method, String subUrl, boolean asSrt) throws IOException {
        if (subUrl == null || subUrl.isEmpty() || !TvCastProtocol.isSupportedCastSourceUrl(subUrl)) {
            writeLanSimpleError(out, 404, "Not Found", "No subtitle");
            return;
        }
        String raw = null;
        TvCastProtocol.LocalOfflineAsset offlineSub = TvCastProtocol.parseLocalOfflineAsset(subUrl);
        if (offlineSub != null) {
            File root = LocalProxyPlugin.getOfflineMediaRootDir(this);
            if (root != null && root.exists()) {
                File subFile = new File(new File(root, offlineSub.downloadId), offlineSub.fileName);
                String rootCanon = root.getCanonicalPath();
                String fileCanon = subFile.getCanonicalPath();
                if (fileCanon.startsWith(rootCanon + File.separator) && subFile.isFile()) {
                    try (FileInputStream fis = new FileInputStream(subFile)) {
                        raw = LocalProxyPlugin.readStreamAsString(fis);
                    }
                }
            }
            if (raw == null) {
                writeLanSimpleError(out, 404, "Not Found", "Offline subtitle unavailable");
                return;
            }
        } else {
            HttpURLConnection conn = null;
            try {
                LocalProxyPlugin.RedirectResult res = LocalProxyPlugin.openWithRedirects(
                    subUrl,
                    activeSubtitleReferer,
                    "text/vtt,text/plain,*/*",
                    null,
                    10000
                );
                conn = res.connection;
                int code = conn.getResponseCode();
                if (code < 200 || code >= 300) {
                    writeLanSimpleError(out, 404, "Not Found", "Subtitle unavailable");
                    return;
                }
                raw = LocalProxyPlugin.readStreamAsString(conn.getInputStream());
            } finally {
                if (conn != null) conn.disconnect();
            }
        }

        String body = asSrt ? TvCastProtocol.convertVttToSrt(raw) : TvCastProtocol.convertSrtToVtt(raw);
        String ct = asSrt ? "text/srt; charset=utf-8" : "text/vtt; charset=utf-8";
        byte[] payload = body.getBytes(StandardCharsets.UTF_8);
        writeLanHeaders(out, 200, "OK", ct, payload.length, null, null, null);
        if (!"HEAD".equals(method)) {
            out.write(payload);
        }
        out.flush();
    }

    private static void writeLanHeaders(
        OutputStream out,
        int status,
        String statusText,
        String contentType,
        long contentLength,
        String contentRange,
        String acceptRanges,
        String captionInfoUrl
    ) throws IOException {
        writeLanHeaders(
            out,
            status,
            statusText,
            contentType,
            contentLength,
            contentRange,
            acceptRanges,
            captionInfoUrl,
            false,
            null
        );
    }

    private static void writeLanHeaders(
        OutputStream out,
        int status,
        String statusText,
        String contentType,
        long contentLength,
        String contentRange,
        String acceptRanges,
        String captionInfoUrl,
        boolean continuousRelay,
        String timeSeekRangeHeader
    ) throws IOException {
        StringBuilder sb = new StringBuilder(448);
        sb.append("HTTP/1.1 ").append(status).append(' ').append(statusText).append("\r\n");
        sb.append("Access-Control-Allow-Origin: *\r\n");
        sb.append("Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n");
        sb.append("Access-Control-Allow-Headers: Range, Origin, Content-Type, Accept, TimeSeekRange.dlna.org\r\n");
        sb.append("Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges, TimeSeekRange.dlna.org\r\n");
        boolean hasTimeSeek = timeSeekRangeHeader != null && !timeSeekRangeHeader.isEmpty();
        boolean isHlsCt = contentType != null && contentType.toLowerCase(Locale.ROOT).contains("mpegurl");
        String dlnaOp = continuousRelay ? (hasTimeSeek ? "10" : "00") : (isHlsCt ? "10" : "01");
        String dlnaCi = continuousRelay ? "1" : "0";
        sb.append("transferMode.dlna.org: Streaming\r\n");
        sb.append("contentFeatures.dlna.org: DLNA.ORG_OP=")
            .append(dlnaOp)
            .append(";DLNA.ORG_CI=")
            .append(dlnaCi)
            .append(";DLNA.ORG_FLAGS=01700000000000000000000000000000\r\n");
        if (hasTimeSeek) {
            sb.append("TimeSeekRange.dlna.org: ").append(timeSeekRangeHeader).append("\r\n");
        }
        if (captionInfoUrl != null && !captionInfoUrl.isEmpty()) {
            sb.append("CaptionInfo.sec: ").append(captionInfoUrl).append("\r\n");
        }
        sb.append("Connection: close\r\n");
        if (contentType != null && !contentType.isEmpty()) {
            sb.append("Content-Type: ").append(contentType).append("\r\n");
        }
        if (contentLength >= 0L) {
            sb.append("Content-Length: ").append(contentLength).append("\r\n");
        }
        if (contentRange != null && !contentRange.isEmpty()) {
            sb.append("Content-Range: ").append(contentRange).append("\r\n");
        }
        if (acceptRanges != null && !acceptRanges.isEmpty()) {
            sb.append("Accept-Ranges: ").append(acceptRanges).append("\r\n");
        }
        sb.append("\r\n");
        out.write(sb.toString().getBytes(StandardCharsets.US_ASCII));
    }

    private static void writeLanSimpleError(OutputStream out, int code, String reason, String body) throws IOException {
        byte[] payload = body.getBytes(StandardCharsets.UTF_8);
        writeLanHeaders(out, code, reason, "text/plain; charset=utf-8", payload.length, null, null, null);
        out.write(payload);
        out.flush();
    }

    private Network findLanNetwork() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return null;
            Network active = cm.getActiveNetwork();
            if (active != null) {
                NetworkCapabilities caps = cm.getNetworkCapabilities(active);
                if (caps != null
                    && (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                        || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))) {
                    return active;
                }
            }
            @SuppressWarnings("deprecation")
            Network[] all = cm.getAllNetworks();
            if (all != null) {
                for (Network net : all) {
                    if (net == null) continue;
                    NetworkCapabilities caps = cm.getNetworkCapabilities(net);
                    if (caps != null
                        && (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                            || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))) {
                        return net;
                    }
                }
            }
        } catch (Exception e) {
            Log.d(TAG, "LAN network lookup failed: " + e.getMessage());
        }
        return null;
    }

    private HttpURLConnection openLanHttpConnection(String urlStr) throws IOException {
        URL url = new URL(urlStr);
        Network lanNet = findLanNetwork();
        if (lanNet != null) {
            try {
                return (HttpURLConnection) lanNet.openConnection(url);
            } catch (Exception e) {
                Log.d(TAG, "Wi-Fi network openConnection fallback: " + e.getMessage());
            }
        }
        return (HttpURLConnection) url.openConnection();
    }

    // -------------------------------------------------------------------------
    // Chromecast V2 TLS Controller (Default Media Receiver CC1AD845)
    // -------------------------------------------------------------------------

    private final class ChromecastController {
        private final TvCastProtocol.CastDevice device;
        private final int gen;
        private final String senderId = "sender-anisync-" + (System.currentTimeMillis() & 0xffff);
        private final AtomicInteger requestIdSeq = new AtomicInteger(1);
        private final Object writeLock = new Object();
        private final AtomicBoolean reconnecting = new AtomicBoolean(false);

        private volatile SSLSocket socket;
        private volatile OutputStream outStream;
        private volatile boolean closed = false;
        private volatile String appSessionId = "";
        private volatile String transportId = "";
        private volatile long mediaSessionId = -1L;
        private volatile boolean mediaLoaded = false;
        private volatile boolean reattachPending = false;
        private final CountDownLatch initialVolumeLatch = new CountDownLatch(1);

        private String pendingMediaUrl = "";
        private String pendingMimeType = "video/mp4";
        private String pendingTitle = "";
        private String pendingSubtitle = "";
        private String pendingPoster = "";
        private long pendingStartMs = 0L;
        private String pendingVttUrl = "";
        private String pendingVttLabel = "";
        private boolean pendingSubDisabled = false;
        private volatile long lastPingSentMs = 0L;
        private volatile long lastPacketReceivedMs = 0L;
        private volatile int reconnectAttempts = 0;

        ChromecastController(TvCastProtocol.CastDevice device, int gen) {
            this.device = device;
            this.gen = gen;
        }

        void connectAndLoad(
            String mediaUrl,
            String mimeType,
            String title,
            String subtitle,
            String poster,
            long startPosMs,
            String vttUrl,
            String vttLabel,
            boolean subDisabled
        ) throws Exception {
            this.pendingMediaUrl = mediaUrl;
            this.pendingMimeType = mimeType;
            this.pendingTitle = title;
            this.pendingSubtitle = subtitle;
            this.pendingPoster = poster;
            this.pendingStartMs = startPosMs;
            this.pendingVttUrl = vttUrl != null ? vttUrl : "";
            this.pendingVttLabel = vttLabel != null ? vttLabel : "Legenda";
            this.pendingSubDisabled = subDisabled;

            openTlsSocketAndReader();

            sendJson("receiver-0", TvCastProtocol.CAST_NS_CONNECTION, "{\"type\":\"CONNECT\",\"origin\":{}}");
            // Query receiver status first so the TV's real volume & mute are synced BEFORE launching/loading media.
            JSONObject statusReq = new JSONObject();
            statusReq.put("type", "GET_STATUS");
            statusReq.put("requestId", requestIdSeq.getAndIncrement());
            sendJson("receiver-0", TvCastProtocol.CAST_NS_RECEIVER, statusReq.toString());
            try {
                initialVolumeLatch.await(1500L, TimeUnit.MILLISECONDS);
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
            }
            if (closed || gen != castSessionGen.get()) return;

            if (transportId.isEmpty() && !mediaLoaded) {
                JSONObject launch = new JSONObject();
                launch.put("type", "LAUNCH");
                launch.put("appId", TvCastProtocol.CHROMECAST_DEFAULT_MEDIA_RECEIVER_APP_ID);
                launch.put("requestId", requestIdSeq.getAndIncrement());
                sendJson("receiver-0", TvCastProtocol.CAST_NS_RECEIVER, launch.toString());
            }
        }

        private void openTlsSocketAndReader() throws Exception {
            SSLContext sslCtx = SSLContext.getInstance("TLS");
            sslCtx.init(null, new TrustManager[] { new LanCastTrustManager() }, new SecureRandom());
            SSLSocket sslSocket = null;
            Network lanNet = findLanNetwork();
            if (lanNet != null) {
                Socket raw = null;
                try {
                    raw = lanNet.getSocketFactory().createSocket();
                    raw.connect(new InetSocketAddress(device.host, device.port), 8000);
                    sslSocket = (SSLSocket) sslCtx.getSocketFactory().createSocket(raw, device.host, device.port, true);
                } catch (Exception e) {
                    if (raw != null) {
                        try {
                            raw.close();
                        } catch (Exception ignored) {
                        }
                    }
                    sslSocket = null;
                }
            }
            if (sslSocket == null) {
                sslSocket = (SSLSocket) sslCtx.getSocketFactory().createSocket();
                sslSocket.connect(new InetSocketAddress(device.host, device.port), 8000);
            }
            try {
                sslSocket.setKeepAlive(true);
                sslSocket.setTcpNoDelay(true);
            } catch (Exception ignored) {
            }
            sslSocket.setSoTimeout(0);
            sslSocket.startHandshake();

            synchronized (writeLock) {
                this.socket = sslSocket;
                this.outStream = sslSocket.getOutputStream();
            }
            long now = System.currentTimeMillis();
            this.lastPingSentMs = now;
            this.lastPacketReceivedMs = now;

            final SSLSocket readerSocket = sslSocket;
            Thread reader = new Thread(() -> readLoop(readerSocket), "AnisyncCastReader");
            reader.setDaemon(true);
            reader.start();
        }

        private void readLoop(SSLSocket targetSocket) {
            try {
                InputStream in = targetSocket.getInputStream();
                while (!closed && targetSocket == socket && !targetSocket.isClosed()) {
                    TvCastProtocol.CastPacket packet = TvCastProtocol.readFramedCastMessage(in);
                    if (packet == null) break;
                    lastPacketReceivedMs = System.currentTimeMillis();
                    reconnectAttempts = 0;
                    handleIncomingPacket(packet);
                }
            } catch (Exception e) {
                if (!closed && targetSocket == socket) {
                    Log.d(TAG, "Chromecast socket closed: " + e.getMessage());
                }
            }
            if (!closed && targetSocket == socket && gen == castSessionGen.get() && sessionActive) {
                reconnectAsync();
            }
        }

        private void reconnectAsync() {
            if (closed || gen != castSessionGen.get() || !sessionActive) return;
            if (!reconnecting.compareAndSet(false, true)) return;

            Thread t = new Thread(() -> {
                try {
                    while (!closed && gen == castSessionGen.get() && sessionActive && reconnectAttempts < 5) {
                        reconnectAttempts++;
                        long backoffMs = Math.min(4000L, 700L * reconnectAttempts);
                        try {
                            Thread.sleep(backoffMs);
                        } catch (InterruptedException ie) {
                            Thread.currentThread().interrupt();
                            return;
                        }
                        if (closed || gen != castSessionGen.get() || !sessionActive) return;
                        try {
                            closeSocketOnly();
                            // Clear transportId while keeping mediaLoaded=true so RECEIVER_STATUS re-attaches
                            // cleanly to the running media receiver without restarting playback.
                            transportId = "";
                            reattachPending = true;
                            openTlsSocketAndReader();
                            sendJson("receiver-0", TvCastProtocol.CAST_NS_CONNECTION, "{\"type\":\"CONNECT\",\"origin\":{}}");
                            JSONObject statusReq = new JSONObject();
                            statusReq.put("type", "GET_STATUS");
                            statusReq.put("requestId", requestIdSeq.getAndIncrement());
                            sendJson("receiver-0", TvCastProtocol.CAST_NS_RECEIVER, statusReq.toString());
                            Log.i(TAG, "Chromecast reconnected on attempt " + reconnectAttempts);
                            return;
                        } catch (Exception e) {
                            Log.w(TAG, "Chromecast reconnect attempt " + reconnectAttempts + " failed: " + e.getMessage());
                        }
                    }
                } finally {
                    reconnecting.set(false);
                }
            }, "AnisyncCastReconnect");
            t.setDaemon(true);
            t.start();
        }

        private void closeSocketOnly() {
            SSLSocket old;
            synchronized (writeLock) {
                old = socket;
                socket = null;
                outStream = null;
            }
            if (old != null) {
                try {
                    old.close();
                } catch (Exception ignored) {
                }
            }
        }

        private void handleIncomingPacket(TvCastProtocol.CastPacket packet) {
            if (closed || gen != castSessionGen.get()) return;
            String ns = packet.namespace;
            String raw = packet.payloadUtf8;
            if (raw == null || raw.isEmpty()) return;

            try {
                JSONObject json = new JSONObject(raw);
                String type = json.optString("type", "");

                if (TvCastProtocol.CAST_NS_HEARTBEAT.equals(ns)) {
                    if ("PING".equals(type)) {
                        sendJson("receiver-0", TvCastProtocol.CAST_NS_HEARTBEAT, "{\"type\":\"PONG\"}");
                    }
                    return;
                }

                if (TvCastProtocol.CAST_NS_RECEIVER.equals(ns) && "LAUNCH_ERROR".equals(type)) {
                    failSession(gen, "A TV recusou iniciar o receptor de vídeo (" + json.optString("reason", "erro") + ").");
                    return;
                }

                if (TvCastProtocol.CAST_NS_RECEIVER.equals(ns) && "RECEIVER_STATUS".equals(type)) {
                    JSONObject st = json.optJSONObject("status");
                    if (st == null) return;
                    boolean volumeUpdated = false;
                    JSONObject volObj = st.optJSONObject("volume");
                    if (volObj != null) {
                        if (volObj.has("level")) {
                            volume = Math.max(0.0, Math.min(1.0, volObj.optDouble("level", volume)));
                            volumeSynced = true;
                            volumeUpdated = true;
                        }
                        if (volObj.has("muted")) {
                            muted = volObj.optBoolean("muted", muted);
                            volumeUpdated = true;
                        }
                    }
                    initialVolumeLatch.countDown();
                    if (volumeUpdated) {
                        publishCurrentState();
                    }

                    JSONArray apps = st.optJSONArray("applications");
                    if (apps != null) {
                        for (int i = 0; i < apps.length(); i++) {
                            JSONObject app = apps.optJSONObject(i);
                            if (app == null) continue;
                            String appId = app.optString("appId", "");
                            if (TvCastProtocol.CHROMECAST_DEFAULT_MEDIA_RECEIVER_APP_ID.equals(appId)) {
                                String newTransport = app.optString("transportId", "");
                                String newSession = app.optString("sessionId", "");
                                if (!newTransport.isEmpty() && (!newTransport.equals(transportId) || reattachPending)) {
                                    transportId = newTransport;
                                    appSessionId = newSession;
                                    reattachPending = false;
                                    sendJson(transportId, TvCastProtocol.CAST_NS_CONNECTION, "{\"type\":\"CONNECT\",\"origin\":{}}");
                                    if (!mediaLoaded) {
                                        mediaLoaded = true;
                                        sendLoadCommand(pendingMediaUrl);
                                    } else {
                                        // Re-attached after a transient socket drop: fetch live status without reloading!
                                        JSONObject msReq = new JSONObject();
                                        msReq.put("type", "GET_STATUS");
                                        msReq.put("requestId", requestIdSeq.getAndIncrement());
                                        sendJson(transportId, TvCastProtocol.CAST_NS_MEDIA, msReq.toString());
                                    }
                                }
                                break;
                            }
                        }
                    }
                    return;
                }

                if (TvCastProtocol.CAST_NS_MEDIA.equals(ns)) {
                    if ("LOAD_FAILED".equals(type)) {
                        if ("direct".equals(deliveryMode) && !attemptedDirectFallback && !lanStreamUrl.isEmpty()) {
                            attemptedDirectFallback = true;
                            deliveryMode = "background-proxy";
                            sendLoadCommand(lanStreamUrl);
                            updateNotification();
                            publishCurrentState();
                        } else {
                            failSession(gen, "A TV não conseguiu reproduzir este servidor. Tente outro servidor.");
                        }
                        return;
                    }
                    if ("MEDIA_STATUS".equals(type)) {
                        JSONArray arr = json.optJSONArray("status");
                        if (arr == null || arr.length() == 0) return;
                        JSONObject ms = arr.optJSONObject(0);
                        if (ms == null) return;
                        mediaSessionId = ms.optLong("mediaSessionId", mediaSessionId);
                        String playerState = ms.optString("playerState", "");
                        String idleReason = ms.optString("idleReason", "");
                        if (ms.has("currentTime")) {
                            long tMs = Math.round(ms.optDouble("currentTime", 0.0) * 1000.0);
                            if (tMs >= 0L) positionMs = tMs;
                        }
                        JSONObject mediaObj = ms.optJSONObject("media");
                        if (mediaObj != null) {
                            if (mediaObj.has("duration")) {
                                long dMs = Math.round(mediaObj.optDouble("duration", 0.0) * 1000.0);
                                if (dMs > 0L) durationMs = dMs;
                            }
                            if (mediaObj.has("tracks")) {
                                JSONArray rawTracks = mediaObj.optJSONArray("tracks");
                                JSONArray parsedTracks = new JSONArray();
                                if (rawTracks != null) {
                                    for (int i = 0; i < rawTracks.length(); i++) {
                                        JSONObject tr = rawTracks.optJSONObject(i);
                                        if (tr == null) continue;
                                        long trId = tr.optLong("trackId", -1L);
                                        String trType = tr.optString("type", "").toUpperCase(Locale.ROOT);
                                        if (trId < 0L || trType.isEmpty()) continue;
                                        JSONObject norm = new JSONObject();
                                        norm.put("trackId", trId);
                                        norm.put("type", trType);
                                        norm.put("name", tr.optString("name", ""));
                                        norm.put("language", tr.optString("language", ""));
                                        norm.put("subtype", tr.optString("subtype", ""));
                                        parsedTracks.put(norm);
                                    }
                                }
                                activeMediaTracksJson = parsedTracks;
                            }
                        }
                        if (ms.has("activeTrackIds")) {
                            JSONArray rawActive = ms.optJSONArray("activeTrackIds");
                            JSONArray normActive = new JSONArray();
                            if (rawActive != null) {
                                for (int i = 0; i < rawActive.length(); i++) {
                                    long id = rawActive.optLong(i, -1L);
                                    if (id >= 0L) normActive.put(id);
                                }
                            }
                            activeTrackIdsJson = normActive;
                        }

                        if ("PLAYING".equals(playerState)) {
                            status = "playing";
                        } else if ("PAUSED".equals(playerState)) {
                            status = "paused";
                        } else if ("BUFFERING".equals(playerState)) {
                            status = "buffering";
                        } else if ("IDLE".equals(playerState)) {
                            if ("FINISHED".equals(idleReason)) {
                                handleNaturalEpisodeCompleted(gen);
                                return;
                            }
                            if ("ERROR".equals(idleReason)) {
                                if ("direct".equals(deliveryMode) && !attemptedDirectFallback && !lanStreamUrl.isEmpty()) {
                                    attemptedDirectFallback = true;
                                    deliveryMode = "background-proxy";
                                    sendLoadCommand(lanStreamUrl);
                                    return;
                                }
                                failSession(gen, "Erro de reprodução na TV. Tente outro servidor.");
                                return;
                            }
                        }
                        persistProgressIfNeeded(false, false);
                        updateNotification();
                        publishCurrentState();
                    }
                }
            } catch (Exception e) {
                Log.d(TAG, "Cast packet parse ignored: " + e.getMessage());
            }
        }

        private void sendLoadCommand(String urlToLoad) throws Exception {
            if (transportId.isEmpty()) return;
            JSONObject metadata = new JSONObject();
            metadata.put("metadataType", 0);
            metadata.put("title", pendingTitle);
            if (!pendingSubtitle.isEmpty()) {
                metadata.put("subtitle", pendingSubtitle);
            }
            if (!pendingPoster.isEmpty()) {
                JSONArray imgs = new JSONArray();
                JSONObject img = new JSONObject();
                img.put("url", pendingPoster);
                imgs.put(img);
                metadata.put("images", imgs);
            }

            JSONObject media = new JSONObject();
            media.put("contentId", urlToLoad);
            media.put("streamType", "BUFFERED");
            media.put("contentType", pendingMimeType);
            media.put("metadata", metadata);

            JSONObject load = new JSONObject();
            load.put("type", "LOAD");
            load.put("requestId", requestIdSeq.getAndIncrement());
            load.put("autoplay", true);
            if (pendingStartMs > 1000L) {
                load.put("currentTime", pendingStartMs / 1000.0);
            }

            if ("background-proxy".equals(deliveryMode)) {
                JSONArray tracks = new JSONArray();
                long selectedTrackId = -1L;
                if (!subtitleEntries.isEmpty()) {
                    for (int i = 0; i < subtitleEntries.size(); i++) {
                        SubtitleEntry entry = subtitleEntries.get(i);
                        String indexedVtt = buildLanIndexedSubtitleUrl(i, false);
                        if (indexedVtt.isEmpty()) continue;
                        long trackId = i + 1L;
                        JSONObject track = new JSONObject();
                        track.put("trackId", trackId);
                        track.put("type", "TEXT");
                        track.put("trackContentId", indexedVtt);
                        track.put("trackContentType", "text/vtt");
                        track.put("name", entry.label.isEmpty() ? ("Legenda " + trackId) : entry.label);
                        track.put("language", "pt-BR");
                        track.put("subtype", "SUBTITLES");
                        tracks.put(track);
                        if (!pendingSubDisabled) {
                            if (!subtitleUrl.isEmpty() && subtitleUrl.equals(entry.url)) {
                                selectedTrackId = trackId;
                            } else if (selectedTrackId < 0L && entry.isDefault) {
                                selectedTrackId = trackId;
                            }
                        }
                    }
                    if (!pendingSubDisabled && selectedTrackId < 0L && tracks.length() > 0 && !subtitleUrl.isEmpty()) {
                        selectedTrackId = 1L;
                    }
                } else if (!pendingVttUrl.isEmpty()) {
                    JSONObject track = new JSONObject();
                    track.put("trackId", 1L);
                    track.put("type", "TEXT");
                    track.put("trackContentId", pendingVttUrl);
                    track.put("trackContentType", "text/vtt");
                    track.put("name", pendingVttLabel.isEmpty() ? "Português" : pendingVttLabel);
                    track.put("language", "pt-BR");
                    track.put("subtype", "SUBTITLES");
                    tracks.put(track);
                    if (!pendingSubDisabled) {
                        selectedTrackId = 1L;
                    }
                }

                if (tracks.length() > 0) {
                    media.put("tracks", tracks);
                    JSONArray activeIds = new JSONArray();
                    if (!pendingSubDisabled && selectedTrackId > 0L) {
                        activeIds.put(selectedTrackId);
                    }
                    load.put("activeTrackIds", activeIds);
                }
            }

            load.put("media", media);
            sendJson(transportId, TvCastProtocol.CAST_NS_MEDIA, load.toString());
        }

        void editTracksInfo(List<Long> trackIds) throws Exception {
            if (transportId.isEmpty() || mediaSessionId < 0L) return;
            JSONObject cmd = new JSONObject();
            cmd.put("type", "EDIT_TRACKS_INFO");
            cmd.put("mediaSessionId", mediaSessionId);
            JSONArray ids = new JSONArray();
            if (trackIds != null) {
                for (Long id : trackIds) {
                    if (id != null && id >= 0L) ids.put(id.longValue());
                }
            }
            cmd.put("activeTrackIds", ids);
            cmd.put("requestId", requestIdSeq.getAndIncrement());
            sendJson(transportId, TvCastProtocol.CAST_NS_MEDIA, cmd.toString());
        }

        void play() throws Exception {
            if (transportId.isEmpty() || mediaSessionId < 0L) return;
            JSONObject cmd = new JSONObject();
            cmd.put("type", "PLAY");
            cmd.put("mediaSessionId", mediaSessionId);
            cmd.put("requestId", requestIdSeq.getAndIncrement());
            sendJson(transportId, TvCastProtocol.CAST_NS_MEDIA, cmd.toString());
        }

        void pause() throws Exception {
            if (transportId.isEmpty() || mediaSessionId < 0L) return;
            JSONObject cmd = new JSONObject();
            cmd.put("type", "PAUSE");
            cmd.put("mediaSessionId", mediaSessionId);
            cmd.put("requestId", requestIdSeq.getAndIncrement());
            sendJson(transportId, TvCastProtocol.CAST_NS_MEDIA, cmd.toString());
        }

        void seek(long targetMs) throws Exception {
            if (transportId.isEmpty() || mediaSessionId < 0L) return;
            JSONObject cmd = new JSONObject();
            cmd.put("type", "SEEK");
            cmd.put("mediaSessionId", mediaSessionId);
            cmd.put("currentTime", targetMs / 1000.0);
            cmd.put("resumeState", "PLAYBACK_START");
            cmd.put("requestId", requestIdSeq.getAndIncrement());
            sendJson(transportId, TvCastProtocol.CAST_NS_MEDIA, cmd.toString());
        }

        void setVolume(double level) throws Exception {
            JSONObject vol = new JSONObject();
            vol.put("level", level);
            vol.put("muted", level <= 0.001);
            JSONObject cmd = new JSONObject();
            cmd.put("type", "SET_VOLUME");
            cmd.put("volume", vol);
            cmd.put("requestId", requestIdSeq.getAndIncrement());
            sendJson("receiver-0", TvCastProtocol.CAST_NS_RECEIVER, cmd.toString());
        }

        void pollStatus() {
            if (closed || reconnecting.get()) return;
            long now = System.currentTimeMillis();
            if (lastPacketReceivedMs > 0L && (now - lastPacketReceivedMs) > 15_000L) {
                Log.w(TAG, "Chromecast heartbeat timeout (" + (now - lastPacketReceivedMs) + "ms); reconnecting");
                closeSocketOnly();
                reconnectAsync();
                return;
            }
            try {
                if (now - lastPingSentMs >= 4500L) {
                    lastPingSentMs = now;
                    sendJson("receiver-0", TvCastProtocol.CAST_NS_HEARTBEAT, "{\"type\":\"PING\"}");
                }
                if (!transportId.isEmpty()) {
                    JSONObject st = new JSONObject();
                    st.put("type", "GET_STATUS");
                    st.put("requestId", requestIdSeq.getAndIncrement());
                    sendJson(transportId, TvCastProtocol.CAST_NS_MEDIA, st.toString());
                }
            } catch (Exception e) {
                Log.w(TAG, "Chromecast poll failed (" + e.getMessage() + "); scheduling reconnect");
                closeSocketOnly();
                reconnectAsync();
            }
        }

        void stopAndClose() {
            if (closed) return;
            closed = true;
            initialVolumeLatch.countDown();
            try {
                if (!transportId.isEmpty() && mediaSessionId >= 0L) {
                    JSONObject stop = new JSONObject();
                    stop.put("type", "STOP");
                    stop.put("mediaSessionId", mediaSessionId);
                    stop.put("requestId", requestIdSeq.getAndIncrement());
                    sendJson(transportId, TvCastProtocol.CAST_NS_MEDIA, stop.toString());
                } else if (!appSessionId.isEmpty()) {
                    JSONObject stop = new JSONObject();
                    stop.put("type", "STOP");
                    stop.put("sessionId", appSessionId);
                    stop.put("requestId", requestIdSeq.getAndIncrement());
                    sendJson("receiver-0", TvCastProtocol.CAST_NS_RECEIVER, stop.toString());
                }
            } catch (Exception ignored) {
            }
            closeSocketOnly();
        }

        private void sendJson(String destination, String namespace, String payload) throws IOException {
            synchronized (writeLock) {
                if (outStream == null) throw new IOException("Cast stream not open");
                TvCastProtocol.writeFramedCastMessage(outStream, senderId, destination, namespace, payload);
            }
        }
    }

    /**
     * Local LAN TrustManager used solely for Google Cast V2 TLS connections on port 8009
     * (Chromecast / Google TV receivers use device-issued self-signed certificates on LAN).
     */
    private static final class LanCastTrustManager implements X509TrustManager {
        @Override
        public void checkClientTrusted(X509Certificate[] chain, String authType) {
        }

        @Override
        public void checkServerTrusted(X509Certificate[] chain, String authType) {
        }

        @Override
        public X509Certificate[] getAcceptedIssuers() {
            return new X509Certificate[0];
        }
    }

    private static final class SoapHttpException extends IOException {
        final int statusCode;

        SoapHttpException(int statusCode, String message) {
            super(message);
            this.statusCode = statusCode;
        }
    }

    // -------------------------------------------------------------------------
    // DLNA / UPnP AVTransport + RenderingControl SOAP Controller
    // -------------------------------------------------------------------------

    private final class DlnaController {
        private final TvCastProtocol.CastDevice device;
        private volatile String avTransportUrl;
        private volatile String renderingControlUrl;
        private volatile boolean mediaLoadCompleted = false;
        private boolean sawPlaying = false;
        private int pollCount = 0;
        private int consecutiveStoppedPolls = 0;
        private int consecutivePollFailures = 0;
        private long lastControlRefreshAtMs = 0L;

        DlnaController(TvCastProtocol.CastDevice device) {
            this.device = device;
            this.avTransportUrl = device.avTransportControlUrl != null ? device.avTransportControlUrl : "";
            this.renderingControlUrl = device.renderingControlUrl != null ? device.renderingControlUrl : "";
        }

        private void setUriAndPlayWithMetadata(String mediaUrl, String metadata) throws IOException {
            Map<String, String> setUriArgs = new LinkedHashMap<>();
            setUriArgs.put("InstanceID", "0");
            setUriArgs.put("CurrentURI", mediaUrl);
            setUriArgs.put("CurrentURIMetaData", metadata != null ? metadata : "");
            sendSoap(
                avTransportUrl,
                TvCastProtocol.UPNP_AV_TRANSPORT_SERVICE,
                "SetAVTransportURI",
                setUriArgs
            );

            Map<String, String> playArgs = new LinkedHashMap<>();
            playArgs.put("InstanceID", "0");
            playArgs.put("Speed", "1");
            sendSoap(
                avTransportUrl,
                TvCastProtocol.UPNP_AV_TRANSPORT_SERVICE,
                "Play",
                playArgs
            );
        }

        void loadAndPlay(
            String mediaUrl,
            String mimeType,
            String title,
            String series,
            String poster,
            long startPosMs,
            String subtitleSrtUrl
        ) throws IOException {
            loadAndPlay(mediaUrl, mimeType, title, series, poster, startPosMs, subtitleSrtUrl, 0L, false);
        }

        void loadAndPlay(
            String mediaUrl,
            String mimeType,
            String title,
            String series,
            String poster,
            long startPosMs,
            String subtitleSrtUrl,
            long mediaDurationMs,
            boolean continuousRelay
        ) throws IOException {
            mediaLoadCompleted = false;
            sawPlaying = false;
            consecutiveStoppedPolls = 0;
            consecutivePollFailures = 0;

            try {
                sendSoap(
                    avTransportUrl,
                    TvCastProtocol.UPNP_AV_TRANSPORT_SERVICE,
                    "Stop",
                    singletonInstanceArgs(),
                    3000,
                    3000,
                    1,
                    false
                );
            } catch (Exception ignored) {
            }

            boolean hasSub = subtitleSrtUrl != null && !subtitleSrtUrl.isEmpty();
            String primaryDidl = TvCastProtocol.buildDidlLiteMetadata(
                title,
                series,
                poster,
                mediaUrl,
                mimeType,
                hasSub ? subtitleSrtUrl : "",
                mediaDurationMs,
                continuousRelay
            );
            String minimalDidl = TvCastProtocol.buildMinimalDidlLiteMetadata(
                title,
                mediaUrl,
                mimeType,
                mediaDurationMs
            );

            try {
                setUriAndPlayWithMetadata(mediaUrl, primaryDidl);
            } catch (IOException primaryErr) {
                boolean loadedFallback = false;
                if (hasSub) {
                    try {
                        String plainDidl = TvCastProtocol.buildDidlLiteMetadata(
                            title,
                            series,
                            poster,
                            mediaUrl,
                            mimeType,
                            "",
                            mediaDurationMs,
                            continuousRelay
                        );
                        setUriAndPlayWithMetadata(mediaUrl, plainDidl);
                        loadedFallback = true;
                    } catch (IOException ignored) {
                    }
                }
                if (!loadedFallback) {
                    try {
                        setUriAndPlayWithMetadata(mediaUrl, minimalDidl);
                        loadedFallback = true;
                    } catch (IOException ignored) {
                    }
                }
                if (!loadedFallback) {
                    // Some Smart TVs reject DIDL-Lite metadata; retry cleanly with empty metadata
                    setUriAndPlayWithMetadata(mediaUrl, "");
                }
            }
            mediaLoadCompleted = true;

            if (startPosMs > 2000L && !continuousRelay) {
                // Arm seek guard BEFORE seeking so early 00:00:00 polls cannot reset positionMs to 0
                lastSeekTargetMs = startPosMs;
                lastSeekRequestedAtMs = System.currentTimeMillis();
                try {
                    long deadline = System.currentTimeMillis() + 4500L;
                    while (System.currentTimeMillis() < deadline) {
                        Thread.sleep(350L);
                        try {
                            String tXml = sendSoap(
                                avTransportUrl,
                                TvCastProtocol.UPNP_AV_TRANSPORT_SERVICE,
                                "GetTransportInfo",
                                singletonInstanceArgs(),
                                2500,
                                3000,
                                1,
                                true
                            );
                            String tState = TvCastProtocol.extractXmlTagValue(tXml, "CurrentTransportState")
                                .toUpperCase(Locale.ROOT);
                            if ("PLAYING".equals(tState)) {
                                break;
                            }
                        } catch (Exception ignored) {
                            break;
                        }
                    }
                    lastSeekRequestedAtMs = System.currentTimeMillis();
                    seek(startPosMs);
                } catch (Exception ignored) {
                }
            }
        }

        void play() throws IOException {
            Map<String, String> args = new LinkedHashMap<>();
            args.put("InstanceID", "0");
            args.put("Speed", "1");
            sendSoap(avTransportUrl, TvCastProtocol.UPNP_AV_TRANSPORT_SERVICE, "Play", args);
        }

        void pause() throws IOException {
            sendSoap(
                avTransportUrl,
                TvCastProtocol.UPNP_AV_TRANSPORT_SERVICE,
                "Pause",
                singletonInstanceArgs()
            );
        }

        void seek(long targetMs) throws IOException {
            String formatted = TvCastProtocol.formatDlnaTime(targetMs);
            Map<String, String> args = new LinkedHashMap<>();
            args.put("InstanceID", "0");
            args.put("Unit", "REL_TIME");
            args.put("Target", formatted);
            try {
                sendSoap(avTransportUrl, TvCastProtocol.UPNP_AV_TRANSPORT_SERVICE, "Seek", args);
            } catch (IOException relErr) {
                // Some DLNA Smart TVs reject REL_TIME (SOAP 710) and require ABS_TIME.
                Map<String, String> absArgs = new LinkedHashMap<>();
                absArgs.put("InstanceID", "0");
                absArgs.put("Unit", "ABS_TIME");
                absArgs.put("Target", formatted);
                try {
                    sendSoap(avTransportUrl, TvCastProtocol.UPNP_AV_TRANSPORT_SERVICE, "Seek", absArgs);
                } catch (IOException absErr) {
                    throw relErr;
                }
            }
        }

        boolean syncVolumeFromTv() {
            return syncVolumeFromTv(mediaLoadCompleted && (sawPlaying || pollCount >= 3));
        }

        boolean syncVolumeFromTv(boolean allowZeroAsSynced) {
            if (renderingControlUrl == null || renderingControlUrl.isEmpty()) return false;
            double parsedVol = -1.0;
            try {
                Map<String, String> volArgs = new LinkedHashMap<>();
                volArgs.put("InstanceID", "0");
                volArgs.put("Channel", "Master");
                String volXml = sendSoap(
                    renderingControlUrl,
                    TvCastProtocol.UPNP_RENDERING_CONTROL_SERVICE,
                    "GetVolume",
                    volArgs,
                    2500,
                    3000,
                    2,
                    true
                );
                parsedVol = TvCastProtocol.parseDlnaVolumeLevel(volXml);
            } catch (Exception e) {
                Log.d(TAG, "DLNA GetVolume failed: " + e.getMessage());
            }

            Boolean parsedMute = null;
            try {
                Map<String, String> muteArgs = new LinkedHashMap<>();
                muteArgs.put("InstanceID", "0");
                muteArgs.put("Channel", "Master");
                String muteXml = sendSoap(
                    renderingControlUrl,
                    TvCastProtocol.UPNP_RENDERING_CONTROL_SERVICE,
                    "GetMute",
                    muteArgs,
                    2500,
                    3000,
                    2,
                    true
                );
                parsedMute = TvCastProtocol.parseDlnaMuteState(muteXml);
            } catch (Exception e) {
                Log.d(TAG, "DLNA GetMute failed: " + e.getMessage());
            }

            if (parsedVol >= 0.0) {
                boolean effectiveMuted = parsedMute != null ? parsedMute : (parsedVol <= 0.001);
                if (!allowZeroAsSynced && (parsedVol <= 0.001 || effectiveMuted)) {
                    // LG webOS DMR commonly reports 0/muted while idle or transitioning before PLAYING.
                    // Wait until playback opens instead of prematurely showing the TV as muted.
                    dlnaNeedsPostPlayVolumeResync = true;
                    return false;
                }
                volume = parsedVol;
                muted = effectiveMuted;
                volumeSynced = true;
                dlnaNeedsPostPlayVolumeResync = false;
                return true;
            }

            if (volumeSynced && parsedMute != null) {
                muted = parsedMute;
            }
            return false;
        }

        void setVolume(double level) throws IOException {
            if (renderingControlUrl == null || renderingControlUrl.isEmpty()) return;
            int volInt = (int) Math.round(Math.max(0.0, Math.min(1.0, level)) * 100.0);
            if (volInt > 0 && muted) {
                try {
                    Map<String, String> unmuteArgs = new LinkedHashMap<>();
                    unmuteArgs.put("InstanceID", "0");
                    unmuteArgs.put("Channel", "Master");
                    unmuteArgs.put("DesiredMute", "0");
                    sendSoap(renderingControlUrl, TvCastProtocol.UPNP_RENDERING_CONTROL_SERVICE, "SetMute", unmuteArgs);
                } catch (Exception ignored) {
                }
            }
            Map<String, String> args = new LinkedHashMap<>();
            args.put("InstanceID", "0");
            args.put("Channel", "Master");
            args.put("DesiredVolume", String.valueOf(volInt));
            sendSoap(renderingControlUrl, TvCastProtocol.UPNP_RENDERING_CONTROL_SERVICE, "SetVolume", args);
        }

        void stopQuietly() {
            try {
                sendSoap(
                    avTransportUrl,
                    TvCastProtocol.UPNP_AV_TRANSPORT_SERVICE,
                    "Stop",
                    singletonInstanceArgs(),
                    2500,
                    2500,
                    2,
                    true
                );
            } catch (Exception firstErr) {
                Log.w(TAG, "DLNA Stop failed (" + firstErr.getMessage() + "); refreshing control URL and retrying");
                try {
                    refreshControlUrlsFromLocation(true);
                    sendSoap(
                        avTransportUrl,
                        TvCastProtocol.UPNP_AV_TRANSPORT_SERVICE,
                        "Stop",
                        singletonInstanceArgs(),
                        2500,
                        2500,
                        1,
                        true
                    );
                } catch (Exception secondErr) {
                    Log.w(TAG, "DLNA Stop retry failed: " + secondErr.getMessage());
                }
            }
        }

        void refreshControlUrlsFromLocation(boolean force) {
            if (device.locationUrl == null || device.locationUrl.isEmpty()) return;
            long now = System.currentTimeMillis();
            if (!force && (now - lastControlRefreshAtMs) < 10_000L) return;
            lastControlRefreshAtMs = now;
            HttpURLConnection conn = null;
            try {
                conn = openLanHttpConnection(device.locationUrl);
                conn.setConnectTimeout(3000);
                conn.setReadTimeout(3000);
                conn.setRequestMethod("GET");
                int code = conn.getResponseCode();
                if (code < 200 || code >= 300) return;
                String xml;
                try (InputStream in = conn.getInputStream()) {
                    xml = LocalProxyPlugin.readStreamAsString(in);
                }
                TvCastProtocol.CastDevice refreshed = TvCastProtocol.parseUpnpDeviceDescription(xml, device.locationUrl);
                if (refreshed != null) {
                    if (!refreshed.avTransportControlUrl.isEmpty()) {
                        avTransportUrl = refreshed.avTransportControlUrl;
                    }
                    if (!refreshed.renderingControlUrl.isEmpty()) {
                        renderingControlUrl = refreshed.renderingControlUrl;
                    }
                    Log.i(TAG, "Refreshed DLNA control URLs from " + device.locationUrl);
                }
            } catch (Exception e) {
                Log.d(TAG, "DLNA control URL refresh failed: " + e.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
            }
        }

        void pollStatus(int gen) {
            if (hlsRelaySwitching) return;
            String transportState = "";
            boolean transportOk = false;
            boolean posOk = false;
            long rawReportedPos = -1L;
            long durMs = -1L;

            try {
                String transportXml = sendSoap(
                    avTransportUrl,
                    TvCastProtocol.UPNP_AV_TRANSPORT_SERVICE,
                    "GetTransportInfo",
                    singletonInstanceArgs(),
                    3000,
                    3500,
                    2,
                    true
                );
                transportState = TvCastProtocol.extractXmlTagValue(transportXml, "CurrentTransportState")
                    .toUpperCase(Locale.ROOT);
                transportOk = true;
            } catch (Exception e) {
                Log.d(TAG, "DLNA GetTransportInfo error: " + e.getMessage());
            }

            if (hlsRelaySwitching || gen != castSessionGen.get()) return;

            try {
                String posXml = sendSoap(
                    avTransportUrl,
                    TvCastProtocol.UPNP_AV_TRANSPORT_SERVICE,
                    "GetPositionInfo",
                    singletonInstanceArgs(),
                    3000,
                    3500,
                    2,
                    true
                );
                long relRaw = TvCastProtocol.parseDlnaTimeMs(TvCastProtocol.extractXmlTagValue(posXml, "RelTime"));
                long absRaw = TvCastProtocol.parseDlnaTimeMs(TvCastProtocol.extractXmlTagValue(posXml, "AbsTime"));
                rawReportedPos = relRaw > 0L ? relRaw : (absRaw > 0L ? absRaw : relRaw);
                durMs = TvCastProtocol.parseDlnaTimeMs(TvCastProtocol.extractXmlTagValue(posXml, "TrackDuration"));
                posOk = true;
            } catch (Exception e) {
                Log.d(TAG, "DLNA GetPositionInfo error: " + e.getMessage());
            }

            if (hlsRelaySwitching || gen != castSessionGen.get()) return;

            if (!transportOk && !posOk) {
                consecutivePollFailures++;
                if (consecutivePollFailures >= 4) {
                    refreshControlUrlsFromLocation(false);
                }
                return;
            }
            consecutivePollFailures = 0;

            long nowMs = System.currentTimeMillis();
            if (!transportOk && posOk && "buffering".equals(status) && (nowMs - lastSeekRequestedAtMs) > 2500L) {
                transportState = "PLAYING";
            }

            boolean justStartedPlaying = !sawPlaying && "PLAYING".equals(transportState);
            if ("PLAYING".equals(transportState)) {
                sawPlaying = true;
                consecutiveStoppedPolls = 0;
                status = "playing";
            } else if ("PAUSED_PLAYBACK".equals(transportState)) {
                consecutiveStoppedPolls = 0;
                status = "paused";
            } else if ("TRANSITIONING".equals(transportState)) {
                consecutiveStoppedPolls = 0;
                status = "buffering";
            } else if ("STOPPED".equals(transportState) || "NO_MEDIA_PRESENT".equals(transportState)) {
                consecutiveStoppedPolls++;
                if (TvCastProtocol.isGenuineDlnaCompletion(sawPlaying, positionMs, durationMs, consecutiveStoppedPolls)) {
                    handleNaturalEpisodeCompleted(gen);
                    return;
                }
            }

            if (hlsTsRelayActive) {
                TvCastProtocol.HlsPlaylistInfo hlsPlan = activeDlnaHlsPlan;
                if (hlsPlan != null && hlsPlan.totalDurationMs > 0L) {
                    durationMs = hlsPlan.totalDurationMs;
                }
                if ("playing".equals(status)) {
                    if (hlsRelayAnchorWallMs == 0L) {
                        hlsRelayAnchorPosMs = Math.max(hlsTsBaseOffsetMs, positionMs);
                        hlsRelayAnchorWallMs = nowMs;
                    }
                    boolean validRawSample = rawReportedPos >= 0L;
                    if (validRawSample && hlsRelayRawPosAdvancing && hlsRelayLastRawPosMs >= 5000L
                        && rawReportedPos < hlsRelayLastRawPosMs - 3000L) {
                        // Ignore sudden bogus reset-to-zero mid-playback glitches on LG webOS
                        validRawSample = false;
                    }
                    if (validRawSample) {
                        if (hlsRelayFirstRawPosMs < 0L) {
                            if (rawReportedPos <= 5_000L) {
                                // TV reports relative stream time starting near 00:00:00
                                hlsRelayFirstRawPosMs = 0L;
                            } else if (Math.abs(rawReportedPos - hlsTsBaseOffsetMs) <= 15_000L) {
                                // TV reports original episode MPEG-TS PTS matching our segment offset
                                hlsRelayFirstRawPosMs = hlsTsBaseOffsetMs;
                            } else {
                                // TV reports arbitrary non-zero muxer PTS
                                hlsRelayFirstRawPosMs = rawReportedPos;
                            }
                        }
                        if (hlsRelayLastRawPosMs >= 0L
                            && rawReportedPos > hlsRelayLastRawPosMs
                            && (rawReportedPos - hlsRelayLastRawPosMs) <= 15_000L) {
                            hlsRelayRawPosAdvancing = true;
                        }
                        hlsRelayLastRawPosMs = rawReportedPos;
                    }
                    long effectiveRaw = validRawSample ? rawReportedPos : -1L;
                    long nextPos = TvCastProtocol.resolveHlsRelayPositionMs(
                        hlsTsBaseOffsetMs,
                        effectiveRaw,
                        hlsRelayFirstRawPosMs,
                        hlsRelayRawPosAdvancing && validRawSample,
                        hlsRelayAnchorPosMs,
                        hlsRelayAnchorWallMs,
                        nowMs,
                        durationMs,
                        true
                    );
                    positionMs = nextPos;
                    hlsRelayAnchorPosMs = nextPos;
                    hlsRelayAnchorWallMs = nowMs;
                    if (lastSeekTargetMs >= 0L && Math.abs(nextPos - lastSeekTargetMs) <= 8000L) {
                        lastSeekTargetMs = -1L;
                    }
                } else if ("paused".equals(status) || "buffering".equals(status)) {
                    hlsRelayAnchorPosMs = Math.max(hlsTsBaseOffsetMs, positionMs);
                    hlsRelayAnchorWallMs = 0L;
                }
            } else if (posOk) {
                long reportedPos = rawReportedPos;
                boolean withinSeekGrace = lastSeekTargetMs >= 0L && (nowMs - lastSeekRequestedAtMs) < 8000L;
                boolean userSoughtNearStart = lastSeekTargetMs >= 0L && lastSeekTargetMs <= 2000L;
                boolean ignoreZeroReset = reportedPos <= 2000L
                    && !userSoughtNearStart
                    && (positionMs >= 8000L || (withinSeekGrace && lastSeekTargetMs >= 4000L))
                    && ("TRANSITIONING".equals(transportState) || "PLAYING".equals(transportState) || withinSeekGrace);
                boolean ignoreStaleSeekPoll = withinSeekGrace
                    && Math.abs(reportedPos - lastSeekTargetMs) > 12_000L;
                if (reportedPos >= 0L && !ignoreZeroReset && !ignoreStaleSeekPoll) {
                    positionMs = reportedPos;
                    if (withinSeekGrace && Math.abs(reportedPos - lastSeekTargetMs) <= 8000L) {
                        lastSeekTargetMs = -1L;
                    }
                }
                if (durMs > 0L) {
                    durationMs = durMs;
                }
            }

            pollCount++;
            if ((justStartedPlaying || dlnaNeedsPostPlayVolumeResync || !volumeSynced || pollCount <= 6 || (pollCount % 3 == 0))
                && (System.currentTimeMillis() - lastVolumeSetAtMs) >= 2500L) {
                syncVolumeFromTv();
            }
            persistProgressIfNeeded(false, false);
            updateNotification();
            publishCurrentState();
        }

        private Map<String, String> singletonInstanceArgs() {
            Map<String, String> args = new LinkedHashMap<>();
            args.put("InstanceID", "0");
            return args;
        }

        private String sendSoap(
            String controlUrl,
            String serviceType,
            String action,
            Map<String, String> args
        ) throws IOException {
            return sendSoap(controlUrl, serviceType, action, args, 5000, 8000, 3, false);
        }

        private String sendSoap(
            String controlUrl,
            String serviceType,
            String action,
            Map<String, String> args,
            int connectTimeoutMs,
            int readTimeoutMs,
            int maxAttempts,
            boolean forceConnectionClose
        ) throws IOException {
            if (controlUrl == null || controlUrl.isEmpty()) {
                throw new IOException("Missing DLNA control URL");
            }
            byte[] payload = TvCastProtocol.buildSoapEnvelope(serviceType, action, args)
                .getBytes(StandardCharsets.UTF_8);
            int attempts = Math.max(1, maxAttempts);
            IOException lastErr = null;
            for (int attempt = 1; attempt <= attempts; attempt++) {
                HttpURLConnection conn = null;
                try {
                    conn = openLanHttpConnection(controlUrl);
                    conn.setConnectTimeout(connectTimeoutMs);
                    conn.setReadTimeout(readTimeoutMs);
                    conn.setRequestMethod("POST");
                    conn.setDoOutput(true);
                    if (forceConnectionClose || attempt > 1) {
                        conn.setRequestProperty("Connection", "close");
                    }
                    conn.setRequestProperty("Content-Type", "text/xml; charset=\"utf-8\"");
                    conn.setRequestProperty("SOAPACTION", "\"" + serviceType + "#" + action + "\"");
                    conn.setFixedLengthStreamingMode(payload.length);
                    try (OutputStream out = conn.getOutputStream()) {
                        out.write(payload);
                    }
                    int code = conn.getResponseCode();
                    InputStream stream = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
                    String responseBody = stream != null ? LocalProxyPlugin.readStreamAsString(stream) : "";
                    if (code < 200 || code >= 300) {
                        String faultDetail = TvCastProtocol.extractUpnpSoapFaultDetail(responseBody);
                        String suffix = faultDetail.isEmpty() ? "" : (" (" + faultDetail + ")");
                        throw new SoapHttpException(code, "TV DLNA retornou HTTP " + code + " para " + action + suffix);
                    }
                    return responseBody;
                } catch (SoapHttpException httpErr) {
                    // SOAP faults (e.g. HTTP 500 / UPnP 710) are deterministic; fail fast for fallbacks
                    throw httpErr;
                } catch (IOException ioErr) {
                    lastErr = ioErr;
                    if (attempt < attempts) {
                        try {
                            Thread.sleep(180L * attempt);
                        } catch (InterruptedException ie) {
                            Thread.currentThread().interrupt();
                            throw ioErr;
                        }
                    }
                } finally {
                    if (conn != null) conn.disconnect();
                }
            }
            throw lastErr != null ? lastErr : new IOException("DLNA SOAP falhou para " + action);
        }
    }

    // -------------------------------------------------------------------------
    // MediaSession, Persistent Notification & Locks
    // -------------------------------------------------------------------------

    private void ensureNotificationChannel() {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_CAST_ID,
            "Transmissão para TV",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Mantém e controla a transmissão do Anisync para a TV em segundo plano.");
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    private void setupMediaSession() {
        if (mediaSession != null) return;
        try {
            mediaSession = new MediaSession(this, TAG);
            mediaSession.setCallback(new MediaSession.Callback() {
                @Override
                public void onPlay() {
                    ioExecutor.execute(() -> performPlay());
                }

                @Override
                public void onPause() {
                    ioExecutor.execute(() -> performPause());
                }

                @Override
                public void onStop() {
                    stopSessionAndService();
                }

                @Override
                public void onCustomAction(String action, Bundle extras) {
                    if (CUSTOM_ACTION_STOP_CAST.equals(action)) {
                        stopSessionAndService();
                    }
                }

                @Override
                public void onSeekTo(long pos) {
                    long targetMs = Math.max(0L, pos);
                    int seq = seekRequestGen.incrementAndGet();
                    pendingSeekTargetMs = targetMs;
                    ioExecutor.execute(() -> performSeekTo(targetMs, seq));
                }

                @Override
                public void onFastForward() {
                    long baseMs = pendingSeekTargetMs >= 0L ? pendingSeekTargetMs : getEffectiveLivePositionMs();
                    long targetMs = Math.max(0L, baseMs + 15_000L);
                    int seq = seekRequestGen.incrementAndGet();
                    pendingSeekTargetMs = targetMs;
                    ioExecutor.execute(() -> performSeekTo(targetMs, seq));
                }

                @Override
                public void onRewind() {
                    long baseMs = pendingSeekTargetMs >= 0L ? pendingSeekTargetMs : getEffectiveLivePositionMs();
                    long targetMs = Math.max(0L, baseMs - 15_000L);
                    int seq = seekRequestGen.incrementAndGet();
                    pendingSeekTargetMs = targetMs;
                    ioExecutor.execute(() -> performSeekTo(targetMs, seq));
                }

                @Override
                public void onSkipToNext() {
                    ioExecutor.execute(() -> switchEpisodeInBackground(nextUrl));
                }

                @Override
                public void onSkipToPrevious() {
                    ioExecutor.execute(() -> switchEpisodeInBackground(prevUrl));
                }
            });
            mediaSession.setActive(true);
        } catch (Exception e) {
            Log.w(TAG, "Failed setting up cast MediaSession", e);
        }
    }

    private void releaseMediaSession() {
        MediaSession ms = mediaSession;
        mediaSession = null;
        lastMetadataSignature = "";
        lastNotificationSignature = "";
        if (ms != null) {
            try {
                ms.setActive(false);
                ms.release();
            } catch (Exception ignored) {
            }
        }
    }

    private void ensurePosterArtworkLoaded(String targetUrl, String refUrl, int gen) {
        String cleanUrl = targetUrl != null ? targetUrl.trim() : "";
        if (cleanUrl.isEmpty() || !TvCastProtocol.isSafeExternalHttpUrl(cleanUrl)) {
            if (!cachedArtworkUrl.isEmpty()) {
                cachedArtworkUrl = "";
                cachedArtworkBitmap = null;
                lastMetadataSignature = "";
                lastNotificationSignature = "";
            }
            return;
        }
        if (cleanUrl.equals(cachedArtworkUrl) && cachedArtworkBitmap != null) {
            return;
        }
        if (cleanUrl.equals(loadingArtworkUrl)) {
            return;
        }
        ExecutorService exec = proxyExecutor;
        if (exec == null || exec.isShutdown()) {
            return;
        }
        loadingArtworkUrl = cleanUrl;
        final String safeRef = LocalProxyPlugin.isSafeHttpUrl(refUrl) ? refUrl : "https://topanimes.net/";
        exec.execute(() -> {
            try {
                String lower = cleanUrl.toLowerCase(Locale.ROOT);
                boolean needsSiteRef = lower.contains("topanimes")
                    || lower.contains("hinatasoul")
                    || lower.contains("animesonline");
                byte[] imgBytes = fetchImageBytes(cleanUrl, needsSiteRef ? safeRef : "");
                if (imgBytes == null && !needsSiteRef) {
                    imgBytes = fetchImageBytes(cleanUrl, safeRef);
                }
                if (imgBytes == null || imgBytes.length == 0) return;

                Bitmap raw = BitmapFactory.decodeByteArray(imgBytes, 0, imgBytes.length);
                if (raw == null) return;
                Bitmap square = cropArtworkToSquare(raw, 512);
                if (square == null) return;

                if (cleanUrl.equals(posterUrl != null ? posterUrl.trim() : "")) {
                    cachedArtworkUrl = cleanUrl;
                    cachedArtworkBitmap = square;
                    lastMetadataSignature = "";
                    lastNotificationSignature = "";
                    if (gen == castSessionGen.get() && sessionActive) {
                        updateNotification(true);
                    }
                }
            } catch (Exception e) {
                Log.d(TAG, "Cast notification artwork load skipped: " + e.getMessage());
            } finally {
                if (cleanUrl.equals(loadingArtworkUrl)) {
                    loadingArtworkUrl = "";
                }
            }
        });
    }

    private static byte[] fetchImageBytes(String imageUrl, String refHeader) {
        HttpURLConnection conn = null;
        try {
            LocalProxyPlugin.RedirectResult res = LocalProxyPlugin.openWithRedirects(
                imageUrl,
                refHeader != null ? refHeader : "",
                "image/webp,image/jpeg,image/png,image/*,*/*;q=0.8",
                null,
                8000,
                "GET"
            );
            conn = res.connection;
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) return null;
            final int maxBytes = 4 * 1024 * 1024;
            ByteArrayOutputStream baos = new ByteArrayOutputStream(65536);
            try (InputStream in = conn.getInputStream()) {
                byte[] buf = new byte[16384];
                int n;
                int total = 0;
                while ((n = in.read(buf)) != -1) {
                    total += n;
                    if (total > maxBytes) return null;
                    baos.write(buf, 0, n);
                }
            }
            return baos.toByteArray();
        } catch (Exception e) {
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static Bitmap cropArtworkToSquare(Bitmap raw, int maxDim) {
        int w = raw.getWidth();
        int h = raw.getHeight();
        if (w <= 0 || h <= 0) return null;
        int size = Math.min(w, h);
        int x = Math.max(0, (w - size) / 2);
        // Upper-center bias on tall portrait anime posters so faces stay framed cleanly
        int y = h > w ? Math.max(0, (h - size) / 4) : Math.max(0, (h - size) / 2);
        Bitmap cropped = Bitmap.createBitmap(raw, x, y, size, size);
        if (cropped != raw) {
            raw.recycle();
        }
        if (size > maxDim) {
            Bitmap scaled = Bitmap.createScaledBitmap(cropped, maxDim, maxDim, true);
            if (scaled != cropped) {
                cropped.recycle();
            }
            return scaled;
        }
        return cropped;
    }

    private Bitmap getActiveArtworkBitmap() {
        String curPoster = posterUrl != null ? posterUrl.trim() : "";
        if (!curPoster.isEmpty() && curPoster.equals(cachedArtworkUrl)) {
            return cachedArtworkBitmap;
        }
        return null;
    }

    private void updateMediaSessionState() {
        if (mediaSession == null) return;
        try {
            String notifTitle = TvCastProtocol.buildNotificationTitle(episodeTitle, seriesTitle);
            String deviceName = activeDevice != null ? activeDevice.name : "";
            String notifSub = TvCastProtocol.buildNotificationSubtitle(
                seriesTitle,
                episodeTitle,
                qualityLabel,
                audioLabel,
                deviceName
            );
            Bitmap art = getActiveArtworkBitmap();
            String metaSig = notifTitle + "|" + notifSub + "|" + seriesTitle + "|" + durationMs
                + "|" + (art != null ? cachedArtworkUrl : "");

            if (!metaSig.equals(lastMetadataSignature)) {
                MediaMetadata.Builder meta = new MediaMetadata.Builder()
                    .putString(MediaMetadata.METADATA_KEY_TITLE, notifTitle)
                    .putString(MediaMetadata.METADATA_KEY_DISPLAY_TITLE, notifTitle)
                    .putString(MediaMetadata.METADATA_KEY_ARTIST, notifSub)
                    .putString(MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE, notifSub)
                    .putString(
                        MediaMetadata.METADATA_KEY_DISPLAY_DESCRIPTION,
                        !deviceName.isEmpty() ? ("Transmitindo em " + deviceName) : "Transmitindo para TV"
                    );
                if (seriesTitle != null && !seriesTitle.trim().isEmpty()) {
                    meta.putString(MediaMetadata.METADATA_KEY_ALBUM, seriesTitle.trim());
                }
                if (durationMs > 0L) {
                    meta.putLong(MediaMetadata.METADATA_KEY_DURATION, durationMs);
                }
                if (art != null) {
                    meta.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, art);
                    meta.putBitmap(MediaMetadata.METADATA_KEY_ART, art);
                    meta.putBitmap(MediaMetadata.METADATA_KEY_DISPLAY_ICON, art);
                }
                mediaSession.setMetadata(meta.build());
                lastMetadataSignature = metaSig;
            }

            int pbState;
            if ("playing".equals(status)) {
                pbState = PlaybackState.STATE_PLAYING;
            } else if ("paused".equals(status)) {
                pbState = PlaybackState.STATE_PAUSED;
            } else if ("connecting".equals(status) || "buffering".equals(status)) {
                pbState = PlaybackState.STATE_BUFFERING;
            } else {
                pbState = PlaybackState.STATE_STOPPED;
            }
            boolean hasPrev = prevUrl != null && !prevUrl.trim().isEmpty();
            boolean hasNext = nextUrl != null && !nextUrl.trim().isEmpty();
            PlaybackState.Builder pbBuilder = new PlaybackState.Builder()
                .setActions(buildMediaSessionActions(hasPrev, hasNext))
                .setState(pbState, Math.max(0L, getEffectiveLivePositionMs()), "playing".equals(status) ? 1.0f : 0.0f)
                .addCustomAction(
                    new PlaybackState.CustomAction.Builder(
                        CUSTOM_ACTION_STOP_CAST,
                        "Parar transmissão",
                        R.drawable.ic_cast_stop
                    ).build()
                );
            mediaSession.setPlaybackState(pbBuilder.build());
        } catch (Exception ignored) {
        }
    }

    private Notification buildNotification() {
        updateMediaSessionState();

        Intent openAppIntent = new Intent(this, MainActivity.class);
        openAppIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (episodeUrl != null && !episodeUrl.isEmpty()) {
            openAppIntent.putExtra(MainActivity.EXTRA_NOTIFICATION_URL, episodeUrl);
            openAppIntent.putExtra(MainActivity.EXTRA_NOTIFICATION_KIND, isMovie ? "movie" : "episode");
        }
        PendingIntent contentIntent = PendingIntentCompat.getActivity(
            this,
            CAST_NOTIFICATION_ID,
            openAppIntent,
            PendingIntent.FLAG_UPDATE_CURRENT,
            false
        );

        String deviceName = activeDevice != null ? activeDevice.name : "";
        String notifTitle = TvCastProtocol.buildNotificationTitle(episodeTitle, seriesTitle);
        String notifSub = TvCastProtocol.buildNotificationSubtitle(
            seriesTitle,
            episodeTitle,
            qualityLabel,
            audioLabel,
            deviceName
        );
        Bitmap art = getActiveArtworkBitmap();

        Notification.Builder builder = new Notification.Builder(this, CHANNEL_CAST_ID)
            .setSmallIcon(R.drawable.ic_stat_anisync)
            .setColor(0xFFF97316)
            .setContentTitle(notifTitle)
            .setContentText(notifSub)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setVisibility(Notification.VISIBILITY_PUBLIC);

        if (art != null) {
            builder.setLargeIcon(art);
        }

        if (contentIntent != null) {
            builder.setContentIntent(contentIntent);
        }

        boolean hasControls = TvCastProtocol.hasRemotePlaybackControls(
            activeDevice != null ? activeDevice.protocol : "",
            deliveryMode
        );
        if (!hasControls) {
            builder.addAction(buildServiceAction(
                R.drawable.ic_cast_stop,
                "Parar servidor",
                ACTION_STOP_CAST,
                104,
                0L
            ));
        } else {
            boolean isPlayingNow = "playing".equals(status) || "buffering".equals(status);
            builder.addAction(buildServiceAction(
                R.drawable.ic_player_rew5,
                "-15s",
                ACTION_SEEK_BY,
                101,
                -15_000L
            ));
            builder.addAction(buildServiceAction(
                isPlayingNow ? R.drawable.ic_player_pause : R.drawable.ic_player_play,
                isPlayingNow ? "Pausar" : "Reproduzir",
                ACTION_TOGGLE_PLAY_PAUSE,
                102,
                0L
            ));
            builder.addAction(buildServiceAction(
                R.drawable.ic_cast_stop,
                "Parar",
                ACTION_STOP_CAST,
                103,
                0L
            ));
            if (mediaSession != null) {
                builder.setStyle(
                    new Notification.MediaStyle()
                        .setMediaSession(mediaSession.getSessionToken())
                        .setShowActionsInCompactView(0, 1, 2)
                );
            }
        }

        return builder.build();
    }

    private Notification.Action buildServiceAction(
        int iconRes,
        String label,
        String action,
        int reqCode,
        long deltaMs
    ) {
        Intent intent = new Intent(this, TvCastService.class);
        intent.setAction(action);
        if (deltaMs != 0L) {
            intent.putExtra(EXTRA_DELTA_MS, deltaMs);
        }
        PendingIntent pi = PendingIntentCompat.getService(
            this,
            reqCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT,
            false
        );
        return new Notification.Action.Builder(
            Icon.createWithResource(this, iconRes),
            label,
            pi
        ).build();
    }

    private void startForegroundCompat(Notification notification) {
        int fgsType = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
            ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
            : 0;
        ServiceCompat.startForeground(this, CAST_NOTIFICATION_ID, notification, fgsType);
    }

    private void stopForegroundCompat() {
        try {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        } catch (Exception ignored) {
        }
    }

    private void updateNotification() {
        updateNotification(false);
    }

    private void updateNotification(boolean force) {
        try {
            updateMediaSessionState();
            String deviceName = activeDevice != null ? activeDevice.name : "";
            String notifTitle = TvCastProtocol.buildNotificationTitle(episodeTitle, seriesTitle);
            String notifSub = TvCastProtocol.buildNotificationSubtitle(
                seriesTitle,
                episodeTitle,
                qualityLabel,
                audioLabel,
                deviceName
            );
            boolean hasPrev = prevUrl != null && !prevUrl.trim().isEmpty();
            boolean hasNext = nextUrl != null && !nextUrl.trim().isEmpty();
            Bitmap art = getActiveArtworkBitmap();
            String sig = status + "|" + notifTitle + "|" + notifSub + "|" + deliveryMode
                + "|" + hasPrev + "|" + hasNext + "|" + (art != null ? cachedArtworkUrl : "");
            if (!force && sig.equals(lastNotificationSignature)) {
                return;
            }
            lastNotificationSignature = sig;
            NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) {
                manager.notify(CAST_NOTIFICATION_ID, buildNotification());
            }
        } catch (Exception ignored) {
        }
    }

    @SuppressWarnings("deprecation")
    private void acquireLocks() {
        try {
            if (wakeLock == null) {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                if (pm != null) {
                    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "anisync:TvCastWakeLock");
                    wakeLock.setReferenceCounted(false);
                }
            }
            if (wakeLock != null && !wakeLock.isHeld()) {
                wakeLock.acquire(WAKE_LOCK_TIMEOUT_MS);
            }
        } catch (Exception e) {
            Log.w(TAG, "Unable to acquire WakeLock: " + e.getMessage());
        }

        try {
            if (wifiLock == null) {
                WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                if (wm != null) {
                    int mode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                        ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                        : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
                    wifiLock = wm.createWifiLock(mode, "anisync:TvCastWifiLock");
                    wifiLock.setReferenceCounted(false);
                }
            }
            if (wifiLock != null && !wifiLock.isHeld()) {
                wifiLock.acquire();
            }
        } catch (Exception e) {
            Log.w(TAG, "Unable to acquire WifiLock: " + e.getMessage());
        }
    }

    private void releaseLocks() {
        if (wakeLock != null) {
            try {
                if (wakeLock.isHeld()) wakeLock.release();
            } catch (Exception ignored) {
            }
            wakeLock = null;
        }
        if (wifiLock != null) {
            try {
                if (wifiLock.isHeld()) wifiLock.release();
            } catch (Exception ignored) {
            }
            wifiLock = null;
        }
    }

    // -------------------------------------------------------------------------
    // State Serialization & Watch Progress Persistence
    // -------------------------------------------------------------------------

    private void persistProgressIfNeeded(boolean force, boolean completed) {
        if (episodeUrl == null || episodeUrl.isEmpty()) return;
        long now = System.currentTimeMillis();
        if (!force && !completed && (now - lastProgressPersistMs) < 5000L) {
            return;
        }
        long livePosMs = getEffectiveLivePositionMs();
        if (!completed && livePosMs < 2000L) {
            return;
        }
        lastProgressPersistMs = now;
        VlcPlayerActivity.saveCastEpisodeProgress(
            this,
            episodeUrl,
            episodeTitle,
            seriesTitle,
            seriesUrl,
            posterUrl,
            isMovie,
            livePosMs,
            durationMs,
            completed
        );
    }

    private void publishCurrentState() {
        JSONObject o = new JSONObject();
        try {
            o.put("active", sessionActive);
            o.put("status", status);
            o.put("deviceId", activeDevice != null ? activeDevice.id : "");
            o.put("deviceName", activeDevice != null ? activeDevice.name : "");
            o.put("deviceProtocol", activeDevice != null ? activeDevice.protocol : "");
            o.put("deliveryMode", deliveryMode);
            o.put("episodeUrl", episodeUrl);
            o.put("episodeTitle", episodeTitle);
            o.put("seriesTitle", seriesTitle);
            o.put("seriesUrl", seriesUrl);
            o.put("poster", posterUrl);
            o.put("streamUrl", streamUrl);
            o.put("lanStreamUrl", lanStreamUrl);
            o.put("positionMs", Math.max(0L, getEffectiveLivePositionMs()));
            o.put("durationMs", Math.max(0L, durationMs));
            o.put("stateTimestampMs", System.currentTimeMillis());
            o.put("volume", volume);
            o.put("muted", muted);
            o.put("volumeSynced", volumeSynced);
            o.put("hasPrev", prevUrl != null && !prevUrl.isEmpty());
            o.put("hasNext", nextUrl != null && !nextUrl.isEmpty());
            o.put("selectedServerNume", selectedServerNume != null ? selectedServerNume : "");
            o.put("qualityLabel", qualityLabel != null ? qualityLabel : "");
            o.put("audioLabel", audioLabel != null ? audioLabel : "");
            o.put("subtitleUrl", subtitleDisabled ? "" : (subtitleUrl != null ? subtitleUrl : ""));
            o.put("subtitleLabel", subtitleDisabled ? "" : (subtitleLabel != null ? subtitleLabel : ""));
            o.put("mediaTracks", new JSONArray(activeMediaTracksJson.toString()));
            o.put("activeTrackIds", new JSONArray(activeTrackIdsJson.toString()));
            o.put("errorMessage", errorMessage != null ? errorMessage : "");
        } catch (Exception ignored) {
        }
        broadcastState(o);
    }

    private boolean applyMediaJson(String raw) {
        if (raw == null || raw.trim().isEmpty()) return false;
        try {
            JSONObject m = new JSONObject(raw);
            String sUrl = m.optString("streamUrl", "").trim();
            if (!TvCastProtocol.isSupportedCastSourceUrl(sUrl)) {
                return false;
            }
            streamUrl = sUrl;
            streamFormat = m.optString("streamFormat", "mp4").trim();
            referer = m.optString("referer", "https://topanimes.net/").trim();
            preferDirect = m.optBoolean("preferDirect", false);
            episodeUrl = m.optString("episodeUrl", "").trim();
            episodeTitle = m.optString("title", "Anisync").trim();
            if (episodeTitle.isEmpty()) episodeTitle = "Anisync";
            seriesTitle = m.optString("seriesTitle", "").trim();
            seriesUrl = m.optString("seriesUrl", "").trim();
            posterUrl = m.optString("poster", "").trim();
            isMovie = m.optBoolean("isMovie", false);
            subtitleDisabled = m.optBoolean("subtitleDisabled", false);
            subtitleUrl = subtitleDisabled ? "" : m.optString("subtitleUrl", "").trim();
            subtitleLabel = subtitleDisabled ? "" : m.optString("subtitleLabel", "Legenda").trim();
            qualityLabel = m.optString("qualityLabel", "").trim();
            audioLabel = m.optString("audioLabel", "").trim();
            selectedServerNume = m.optString("selectedServerNume", "").trim();
            prevUrl = m.optString("prevUrl", "").trim();
            nextUrl = m.optString("nextUrl", "").trim();
            autoPlayNextEpisode = m.optBoolean("autoPlayNextEpisode", false);
            positionMs = Math.max(0L, m.optLong("startPositionMs", 0L));
            durationMs = Math.max(0L, m.optLong("durationMs", 0L));

            subtitleEntries.clear();
            JSONArray rawSubs = m.optJSONArray("subtitles");
            if (rawSubs != null) {
                for (int i = 0; i < rawSubs.length(); i++) {
                    JSONObject subObj = rawSubs.optJSONObject(i);
                    if (subObj == null) continue;
                    String subU = subObj.optString("url", "").trim();
                    if (!TvCastProtocol.isSupportedCastSourceUrl(subU)) continue;
                    String subL = subObj.optString("label", "Legenda").trim();
                    boolean subDef = subObj.optBoolean("default", false);
                    subtitleEntries.add(new SubtitleEntry(subL, subU, subDef));
                }
            }
            if (subtitleEntries.isEmpty() && !subtitleUrl.isEmpty() && TvCastProtocol.isSupportedCastSourceUrl(subtitleUrl)) {
                subtitleEntries.add(new SubtitleEntry(subtitleLabel.isEmpty() ? "Legenda" : subtitleLabel, subtitleUrl, true));
            }
            activeMediaTracksJson = new JSONArray();
            activeTrackIdsJson = new JSONArray();
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private static TvCastProtocol.CastDevice parseDeviceFromJson(String raw) {
        if (raw == null || raw.trim().isEmpty()) return null;
        try {
            JSONObject d = new JSONObject(raw);
            String host = d.optString("host", "").trim();
            if (host.isEmpty()) return null;
            String protocol = d.optString("protocol", TvCastProtocol.PROTOCOL_CHROMECAST).trim();
            int defaultPort = TvCastProtocol.PROTOCOL_DLNA.equalsIgnoreCase(protocol)
                ? 80
                : TvCastProtocol.CHROMECAST_DEFAULT_PORT;
            return new TvCastProtocol.CastDevice(
                d.optString("id", protocol + ":" + host),
                d.optString("name", host),
                d.optString("manufacturer", ""),
                d.optString("model", ""),
                host,
                d.optInt("port", defaultPort),
                protocol,
                d.optString("avTransportControlUrl", ""),
                d.optString("renderingControlUrl", ""),
                d.optString("locationUrl", "")
            );
        } catch (Exception e) {
            return null;
        }
    }
}
