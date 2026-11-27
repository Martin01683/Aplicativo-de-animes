package com.topanimes.player;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.drawable.Icon;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
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

    private static final long MEDIA_SESSION_ACTIONS =
        PlaybackState.ACTION_PLAY
            | PlaybackState.ACTION_PAUSE
            | PlaybackState.ACTION_PLAY_PAUSE
            | PlaybackState.ACTION_STOP
            | PlaybackState.ACTION_SEEK_TO
            | PlaybackState.ACTION_FAST_FORWARD
            | PlaybackState.ACTION_REWIND
            | PlaybackState.ACTION_SKIP_TO_NEXT
            | PlaybackState.ACTION_SKIP_TO_PREVIOUS;

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
                ioExecutor.execute(() -> performSeekTo(targetMs));
                break;
            }
            case ACTION_SEEK_BY: {
                long deltaMs = intent.getLongExtra(EXTRA_DELTA_MS, 0L);
                ioExecutor.execute(() -> performSeekTo(Math.max(0L, positionMs + deltaMs)));
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
        boolean sameDeviceReconnect = activeDevice != null
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
        }
        activeMediaTracksJson = new JSONArray();
        activeTrackIdsJson = new JSONArray();
        lastSeekTargetMs = positionMs > 2000L ? positionMs : -1L;
        lastSeekRequestedAtMs = positionMs > 2000L ? System.currentTimeMillis() : 0L;
        handledCompletionForEpisode = false;
        attemptedDirectFallback = false;

        acquireLocks();
        updateNotification();
        publishCurrentState();

        final int gen = castSessionGen.incrementAndGet();
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
            updateNotification();
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

    private void connectAndLoadMedia(int gen, boolean forceProxy) {
        if (gen != castSessionGen.get() || activeDevice == null) return;

        closeActiveRemoteControllers();

        TvCastProtocol.LocalOfflineAsset localOffline = TvCastProtocol.parseLocalOfflineAsset(streamUrl);
        boolean isLocalOffline = localOffline != null;
        boolean isHls = TvCastProtocol.isHlsStreamUrl(streamUrl, streamFormat);
        String mimeType = TvCastProtocol.inferStreamMimeType(streamUrl, streamFormat);

        String builtLanUrl = ensureLanStreamUrlForCurrentMedia();
        lanStreamUrl = builtLanUrl;
        if (!builtLanUrl.isEmpty()) {
            latestPreparedLanStreamUrl = builtLanUrl;
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
            if (builtLanUrl.isEmpty()) {
                if (!isLocalOffline && probeDirectPlayable(streamUrl)) {
                    targetUrl = streamUrl;
                    chosenMode = "direct";
                } else {
                    failSession(gen, "Conecte o celular e a TV na mesma rede Wi-Fi para transmitir.");
                    return;
                }
            } else {
                targetUrl = builtLanUrl;
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

        Exception lastError = null;
        DlnaController pendingDlna = null;
        for (int attempt = 1; attempt <= 2; attempt++) {
            if (gen != castSessionGen.get()) return;
            try {
                if (TvCastProtocol.PROTOCOL_DLNA.equals(activeDevice.protocol)) {
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
                    try {
                        dlna.loadAndPlay(
                            targetUrl,
                            mimeType,
                            episodeTitle,
                            seriesTitle,
                            posterUrl,
                            positionMs,
                            lanSubtitleSrtUrl
                        );
                    } catch (Exception directErr) {
                        if ("direct".equals(chosenMode) && !builtLanUrl.isEmpty() && !attemptedDirectFallback) {
                            attemptedDirectFallback = true;
                            deliveryMode = "background-proxy";
                            dlna.loadAndPlay(
                                builtLanUrl,
                                mimeType,
                                episodeTitle,
                                seriesTitle,
                                posterUrl,
                                positionMs,
                                lanSubtitleSrtUrl
                            );
                        } else {
                            throw directErr;
                        }
                    }
                    if (gen != castSessionGen.get()) return;
                    status = "playing";
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
            status = "playing";
            updateNotification();
            publishCurrentState();
        } catch (Exception e) {
            Log.w(TAG, "Play failed: " + e.getMessage());
        }
    }

    private void performPause() {
        try {
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
        long clamped = Math.max(0L, targetMs);
        if (durationMs > 0L && clamped > durationMs) {
            clamped = Math.max(0L, durationMs - 1000L);
        }
        lastSeekTargetMs = clamped;
        lastSeekRequestedAtMs = System.currentTimeMillis();
        try {
            if (chromecastController != null) {
                chromecastController.seek(clamped);
            } else if (dlnaController != null) {
                dlnaController.seek(clamped);
            }
            positionMs = clamped;
            persistProgressIfNeeded(true, false);
            updateNotification();
            publishCurrentState();
        } catch (Exception e) {
            Log.w(TAG, "Seek failed: " + e.getMessage());
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
        castSessionGen.incrementAndGet();
        persistProgressIfNeeded(true, false);
        sessionActive = false;
        status = "idle";
        latestPreparedLanStreamUrl = "";
        teardownControllersAndServer();
        releaseLocks();
        broadcastState(buildIdleStateJson());
        stopForegroundCompat();
        stopSelf();
    }

    private void teardownControllersAndServer() {
        stopPollingLoop();
        closeActiveRemoteControllers();
        stopLanProxyServer();
    }

    private void closeActiveRemoteControllers() {
        ChromecastController cc;
        DlnaController dc;
        synchronized (sessionLock) {
            cc = chromecastController;
            chromecastController = null;
            dc = dlnaController;
            dlnaController = null;
        }
        if (cc != null) {
            cc.stopAndClose();
        }
        if (dc != null) {
            dc.stopQuietly();
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
                LocalProxyPlugin.RedirectResult upstream;
                if (isHeadRequest && !likelyPlaylistRequest) {
                    if (TvCastProtocol.shouldAvoidUpstreamHead(targetUrl)) {
                        usedRangeProbeForHead = true;
                        upstream = openUpstreamWithRetry(targetUrl, safeRef, "bytes=0-0", "GET");
                    } else {
                        upstream = openUpstreamWithRetry(targetUrl, safeRef, null, "HEAD");
                        int headCode = upstream.connection.getResponseCode();
                        if (headCode < 200 || headCode >= 300) {
                            upstream.connection.disconnect();
                            usedRangeProbeForHead = true;
                            upstream = openUpstreamWithRetry(targetUrl, safeRef, "bytes=0-0", "GET");
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
                    String outCt = contentType != null && !contentType.isEmpty()
                        ? contentType
                        : TvCastProtocol.inferStreamMimeType(targetUrl, streamFormat);
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
                if (acceptRanges == null || acceptRanges.trim().isEmpty()) {
                    acceptRanges = "bytes";
                }

                InputStream bodyStream = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
                boolean shouldProbeTs = code >= 200
                    && code < 300
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
                    String outCt = contentType != null ? contentType : "application/octet-stream";
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

                String outCt = contentType != null && !contentType.isEmpty()
                    ? contentType
                    : TvCastProtocol.inferStreamMimeType(targetUrl, streamFormat);
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
        StringBuilder sb = new StringBuilder(384);
        sb.append("HTTP/1.1 ").append(status).append(' ').append(statusText).append("\r\n");
        sb.append("Access-Control-Allow-Origin: *\r\n");
        sb.append("Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n");
        sb.append("Access-Control-Allow-Headers: Range, Origin, Content-Type, Accept\r\n");
        sb.append("Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges\r\n");
        boolean isHlsCt = contentType != null && contentType.toLowerCase(Locale.ROOT).contains("mpegurl");
        sb.append("transferMode.dlna.org: Streaming\r\n");
        sb.append("contentFeatures.dlna.org: DLNA.ORG_OP=")
            .append(isHlsCt ? "10" : "01")
            .append(";DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000\r\n");
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
                hasSub ? subtitleSrtUrl : ""
            );

            try {
                setUriAndPlayWithMetadata(mediaUrl, primaryDidl);
            } catch (IOException primaryErr) {
                if (hasSub) {
                    try {
                        String plainDidl = TvCastProtocol.buildDidlLiteMetadata(
                            title,
                            series,
                            poster,
                            mediaUrl,
                            mimeType
                        );
                        setUriAndPlayWithMetadata(mediaUrl, plainDidl);
                    } catch (IOException plainErr) {
                        setUriAndPlayWithMetadata(mediaUrl, "");
                    }
                } else {
                    // Some Smart TVs reject DIDL-Lite metadata; retry cleanly with empty metadata
                    setUriAndPlayWithMetadata(mediaUrl, "");
                }
            }

            if (startPosMs > 2000L) {
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
            if (renderingControlUrl == null || renderingControlUrl.isEmpty()) return false;
            boolean syncedAny = false;
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
                    1,
                    false
                );
                double parsedVol = TvCastProtocol.parseDlnaVolumeLevel(volXml);
                if (parsedVol >= 0.0) {
                    volume = parsedVol;
                    volumeSynced = true;
                    syncedAny = true;
                }
            } catch (Exception e) {
                Log.d(TAG, "DLNA GetVolume failed: " + e.getMessage());
            }
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
                    1,
                    false
                );
                Boolean parsedMute = TvCastProtocol.parseDlnaMuteState(muteXml);
                if (parsedMute != null) {
                    muted = parsedMute;
                } else if (syncedAny) {
                    muted = volume <= 0.001;
                }
            } catch (Exception ignored) {
            }
            return syncedAny;
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
                    2000,
                    2000,
                    1,
                    false
                );
            } catch (Exception ignored) {
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
            String transportState = "";
            boolean transportOk = false;
            boolean posOk = false;

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
                long reportedPos = relRaw > 0L ? relRaw : (absRaw > 0L ? absRaw : relRaw);
                long durMs = TvCastProtocol.parseDlnaTimeMs(TvCastProtocol.extractXmlTagValue(posXml, "TrackDuration"));
                long nowMs = System.currentTimeMillis();
                boolean withinSeekGrace = lastSeekTargetMs >= 0L && (nowMs - lastSeekRequestedAtMs) < 8000L;
                boolean userSoughtNearStart = lastSeekTargetMs >= 0L && lastSeekTargetMs <= 2000L;
                boolean ignoreZeroReset = reportedPos <= 2000L
                    && !userSoughtNearStart
                    && positionMs >= 8000L
                    && ("TRANSITIONING".equals(transportState) || "PLAYING".equals(transportState) || withinSeekGrace);
                boolean ignoreStaleSeekPoll = withinSeekGrace
                    && Math.abs(reportedPos - lastSeekTargetMs) > 12_000L;
                if (reportedPos >= 0L && !ignoreZeroReset && !ignoreStaleSeekPoll) {
                    positionMs = reportedPos;
                    if (withinSeekGrace && Math.abs(reportedPos - lastSeekTargetMs) <= 8000L) {
                        lastSeekTargetMs = -1L;
                    }
                }
                if (durMs > 0L) durationMs = durMs;
                posOk = true;
            } catch (Exception e) {
                Log.d(TAG, "DLNA GetPositionInfo error: " + e.getMessage());
            }

            if (!transportOk && !posOk) {
                consecutivePollFailures++;
                if (consecutivePollFailures >= 4) {
                    refreshControlUrlsFromLocation(false);
                }
                return;
            }
            consecutivePollFailures = 0;

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
            pollCount++;
            if ((!volumeSynced || (pollCount % 4 == 0)) && (System.currentTimeMillis() - lastVolumeSetAtMs) >= 2500L) {
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
                        throw new SoapHttpException(code, "TV DLNA retornou HTTP " + code + " para " + action);
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
                public void onSeekTo(long pos) {
                    ioExecutor.execute(() -> performSeekTo(pos));
                }

                @Override
                public void onFastForward() {
                    ioExecutor.execute(() -> performSeekTo(positionMs + 15_000L));
                }

                @Override
                public void onRewind() {
                    ioExecutor.execute(() -> performSeekTo(Math.max(0L, positionMs - 15_000L)));
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
        if (ms != null) {
            try {
                ms.setActive(false);
                ms.release();
            } catch (Exception ignored) {
            }
        }
    }

    private void updateMediaSessionState() {
        if (mediaSession == null) return;
        try {
            MediaMetadata.Builder meta = new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, episodeTitle);
            String sub = activeDevice != null ? ("Transmitindo em " + activeDevice.name) : "Transmitindo para TV";
            meta.putString(MediaMetadata.METADATA_KEY_ARTIST, sub);
            if (durationMs > 0L) {
                meta.putLong(MediaMetadata.METADATA_KEY_DURATION, durationMs);
            }
            mediaSession.setMetadata(meta.build());

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
            PlaybackState playbackState = new PlaybackState.Builder()
                .setActions(MEDIA_SESSION_ACTIONS)
                .setState(pbState, Math.max(0L, positionMs), "playing".equals(status) ? 1.0f : 0.0f)
                .build();
            mediaSession.setPlaybackState(playbackState);
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

        String deviceLabel = activeDevice != null ? activeDevice.name : "TV";
        String modeHint = "direct".equals(deliveryMode)
            ? "Direto na TV · pode fechar o app"
            : "lan-link".equals(deliveryMode)
                ? "Link de TV ativo em segundo plano"
                : "Em segundo plano · pode fechar o app";

        Notification.Builder builder = new Notification.Builder(this, CHANNEL_CAST_ID)
            .setSmallIcon(R.drawable.ic_stat_anisync)
            .setColor(0xFFF97316)
            .setContentTitle(episodeTitle != null && !episodeTitle.isEmpty() ? episodeTitle : "Transmitindo para TV")
            .setContentText("TV: " + deviceLabel + " · " + modeHint)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setVisibility(Notification.VISIBILITY_PUBLIC);

        if (contentIntent != null) {
            builder.setContentIntent(contentIntent);
        }

        boolean hasControls = TvCastProtocol.hasRemotePlaybackControls(
            activeDevice != null ? activeDevice.protocol : "",
            deliveryMode
        );
        if (!hasControls) {
            builder.addAction(buildServiceAction(
                R.drawable.ic_player_close,
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
                R.drawable.ic_player_close,
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
        try {
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
        if (!completed && positionMs < 2000L) {
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
            positionMs,
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
            o.put("positionMs", Math.max(0L, positionMs));
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
