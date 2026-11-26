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
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

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

    public static final String ACTION_START_CAST = "com.topanimes.player.cast.START";
    public static final String ACTION_PREPARE_LAN_ONLY = "com.topanimes.player.cast.PREPARE_LAN";
    public static final String ACTION_PLAY = "com.topanimes.player.cast.PLAY";
    public static final String ACTION_PAUSE = "com.topanimes.player.cast.PAUSE";
    public static final String ACTION_TOGGLE_PLAY_PAUSE = "com.topanimes.player.cast.TOGGLE";
    public static final String ACTION_SEEK_TO = "com.topanimes.player.cast.SEEK_TO";
    public static final String ACTION_SEEK_BY = "com.topanimes.player.cast.SEEK_BY";
    public static final String ACTION_SET_VOLUME = "com.topanimes.player.cast.SET_VOLUME";
    public static final String ACTION_NEXT_EPISODE = "com.topanimes.player.cast.NEXT_EP";
    public static final String ACTION_PREV_EPISODE = "com.topanimes.player.cast.PREV_EP";
    public static final String ACTION_STOP_CAST = "com.topanimes.player.cast.STOP";

    public static final String EXTRA_DEVICE_JSON = "deviceJson";
    public static final String EXTRA_MEDIA_JSON = "mediaJson";
    public static final String EXTRA_POSITION_MS = "positionMs";
    public static final String EXTRA_DELTA_MS = "deltaMs";
    public static final String EXTRA_VOLUME = "volume";
    public static final String EXTRA_DELIVERY_MODE = "deliveryMode";

    public interface StateListener {
        void onCastStateChanged(JSONObject stateSnapshot);
    }

    private static final Set<StateListener> STATE_LISTENERS = new CopyOnWriteArraySet<>();
    private static final Object STATE_LOCK = new Object();
    private static volatile TvCastService runningInstance = null;
    private static volatile JSONObject latestStateJson = buildIdleStateJson();

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

    public static String getActiveLanStreamUrl() {
        return latestStateJson.optString("lanStreamUrl", "");
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
            o.put("volume", 1.0);
            o.put("muted", false);
            o.put("hasPrev", false);
            o.put("hasNext", false);
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
    private String subtitleLabel = "Legenda";
    private String selectedServerNume = "";
    private String prevUrl = "";
    private String nextUrl = "";
    private boolean autoPlayNextEpisode = false;
    private String deliveryPreference = "auto";
    private String lanStreamUrl = "";

    private volatile long positionMs = 0L;
    private volatile long durationMs = 0L;
    private volatile double volume = 1.0;
    private volatile boolean muted = false;
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
                handlePrepareLanOnlyRequest(mediaRaw);
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
        broadcastState(buildIdleStateJson());
        super.onDestroy();
    }

    // -------------------------------------------------------------------------
    // Session Orchestration
    // -------------------------------------------------------------------------

    private void handleStartCastRequest(String deviceRaw, String mediaRaw, String modePref) {
        TvCastProtocol.CastDevice parsedDevice = parseDeviceFromJson(deviceRaw);
        if (parsedDevice == null || parsedDevice.host.isEmpty()) {
            errorMessage = "Dispositivo de TV inválido.";
            status = "error";
            publishCurrentState();
            stopSessionAndService();
            return;
        }

        if (!applyMediaJson(mediaRaw)) {
            errorMessage = "Nenhum stream válido disponível para transmitir.";
            status = "error";
            publishCurrentState();
            stopSessionAndService();
            return;
        }

        deliveryPreference = (modePref != null && !modePref.trim().isEmpty())
            ? modePref.trim().toLowerCase(Locale.ROOT)
            : "auto";
        activeDevice = parsedDevice;
        sessionActive = true;
        status = "connecting";
        errorMessage = "";
        lastSeekTargetMs = -1L;
        lastSeekRequestedAtMs = 0L;
        handledCompletionForEpisode = false;
        attemptedDirectFallback = false;

        acquireLocks();
        updateNotification();
        publishCurrentState();

        final int gen = castSessionGen.incrementAndGet();
        ioExecutor.execute(() -> connectAndLoadMedia(gen, false));
    }

    private void handlePrepareLanOnlyRequest(String mediaRaw) {
        if (!applyMediaJson(mediaRaw)) {
            errorMessage = "Nenhum stream válido disponível para preparar o link de TV.";
            status = "error";
            publishCurrentState();
            stopSessionAndService();
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
            updateNotification();
            publishCurrentState();
        });
    }

    private void connectAndLoadMedia(int gen, boolean forceProxy) {
        if (gen != castSessionGen.get() || activeDevice == null) return;

        closeActiveRemoteControllers();

        boolean isHls = TvCastProtocol.isHlsStreamUrl(streamUrl, streamFormat);
        String mimeType = TvCastProtocol.inferStreamMimeType(streamUrl, streamFormat);

        String builtLanUrl = ensureLanStreamUrlForCurrentMedia();
        lanStreamUrl = builtLanUrl;

        String targetUrl = "";
        String chosenMode = "background-proxy";

        boolean canTryDirect = !forceProxy
            && !"proxy".equals(deliveryPreference)
            && !isHls
            && (subtitleUrl.isEmpty() || TvCastProtocol.PROTOCOL_DLNA.equals(activeDevice.protocol));

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
                if (probeDirectPlayable(streamUrl)) {
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

        String lanSubtitleUrl = (!subtitleUrl.isEmpty() && !builtLanUrl.isEmpty())
            ? buildLanSubtitleUrl()
            : "";

        try {
            if (TvCastProtocol.PROTOCOL_DLNA.equals(activeDevice.protocol)) {
                DlnaController dlna = new DlnaController(activeDevice);
                synchronized (sessionLock) {
                    dlnaController = dlna;
                }
                try {
                    dlna.loadAndPlay(targetUrl, mimeType, episodeTitle, seriesTitle, posterUrl, positionMs);
                } catch (Exception directErr) {
                    if ("direct".equals(chosenMode) && !builtLanUrl.isEmpty() && !attemptedDirectFallback) {
                        attemptedDirectFallback = true;
                        deliveryMode = "background-proxy";
                        dlna.loadAndPlay(builtLanUrl, mimeType, episodeTitle, seriesTitle, posterUrl, positionMs);
                    } else {
                        throw directErr;
                    }
                }
                if (gen != castSessionGen.get()) return;
                status = "playing";
                startPollingLoop(gen);
                updateNotification();
                publishCurrentState();
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
                    lanSubtitleUrl,
                    subtitleLabel
                );
                if (gen != castSessionGen.get()) return;
                startPollingLoop(gen);
                updateNotification();
                publishCurrentState();
            }
        } catch (Exception e) {
            Log.e(TAG, "Cast connection/load failed", e);
            failSession(
                gen,
                "Não foi possível conectar à TV (" + activeDevice.name + "): "
                    + (e.getMessage() != null ? e.getMessage() : "verifique se estão no mesmo Wi-Fi.")
            );
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
            if (chromecastController != null) {
                chromecastController.setVolume(level);
            } else if (dlnaController != null) {
                dlnaController.setVolume(level);
            }
            volume = level;
            muted = level <= 0.001;
            publishCurrentState();
        } catch (Exception e) {
            Log.w(TAG, "SetVolume failed: " + e.getMessage());
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
            subtitleUrl = !resolved.subtitles.isEmpty() ? resolved.subtitles.get(0).url : "";
            subtitleLabel = !resolved.subtitles.isEmpty() ? resolved.subtitles.get(0).label : "Legenda";
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
            } catch (Exception e) {
                Log.d(TAG, "Status poll error: " + e.getMessage());
            }
        }, 2, 2, TimeUnit.SECONDS);
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
        activeSubtitleSourceUrl = subtitleUrl;
        activeSubtitleReferer = referer;
        boolean isHls = TvCastProtocol.isHlsStreamUrl(streamUrl, streamFormat);
        return TvCastProtocol.buildLanProxyUrl(base, lanSecretToken, streamUrl, referer, false, isHls);
    }

    private String buildLanSubtitleUrl() {
        String base = ensureLanProxyBaseUrl();
        if (base.isEmpty() || lanSecretToken.isEmpty() || subtitleUrl.isEmpty()) return "";
        return base + "/cast/" + lanSecretToken + "/subtitle.vtt";
    }

    private void handleLanClientSocket(Socket client) {
        try (Socket sock = client) {
            sock.setSoTimeout(30000);
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
                writeLanHeaders(out, 204, "No Content", null, 0L, null, null);
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

            if (pathOnly.endsWith("/subtitle.vtt")) {
                serveLanSubtitle(out, method);
                return;
            }

            Map<String, String> query = LocalProxyPlugin.parseQuery(target);
            String targetUrl = query.getOrDefault("url", streamUrl);
            String refParam = query.getOrDefault("referer", referer);
            String safeRef = LocalProxyPlugin.isSafeHttpUrl(refParam) ? refParam : "https://topanimes.net/";
            boolean isHlsSegment = "1".equals(query.get("hls_seg"));

            if (!LocalProxyPlugin.isSafeHttpUrl(targetUrl)) {
                writeLanSimpleError(out, 400, "Bad Request", "Invalid media URL");
                return;
            }

            String rangeHeader = reqHeaders.get("range");
            HttpURLConnection conn = null;
            try {
                LocalProxyPlugin.RedirectResult upstream = LocalProxyPlugin.openWithRedirects(
                    targetUrl,
                    safeRef,
                    "*/*",
                    rangeHeader,
                    20000
                );
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
                        null
                    );
                    if (!"HEAD".equals(method)) {
                        out.write(payload);
                    }
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
                            null
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

                    writeLanHeaders(out, outStatus, outStatusText, outCt, outCl, outCr, outAr);
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
                writeLanHeaders(out, code, statusText, outCt, contentLength, contentRange, acceptRanges);
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

    private void serveLanSubtitle(OutputStream out, String method) throws IOException {
        String subUrl = activeSubtitleSourceUrl;
        if (subUrl == null || subUrl.isEmpty() || !LocalProxyPlugin.isSafeHttpUrl(subUrl)) {
            writeLanSimpleError(out, 404, "Not Found", "No subtitle");
            return;
        }
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
            String raw = LocalProxyPlugin.readStreamAsString(conn.getInputStream());
            String vtt = TvCastProtocol.convertSrtToVtt(raw);
            byte[] payload = vtt.getBytes(StandardCharsets.UTF_8);
            writeLanHeaders(out, 200, "OK", "text/vtt; charset=utf-8", payload.length, null, null);
            if (!"HEAD".equals(method)) {
                out.write(payload);
            }
            out.flush();
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static void writeLanHeaders(
        OutputStream out,
        int status,
        String statusText,
        String contentType,
        long contentLength,
        String contentRange,
        String acceptRanges
    ) throws IOException {
        StringBuilder sb = new StringBuilder(320);
        sb.append("HTTP/1.1 ").append(status).append(' ').append(statusText).append("\r\n");
        sb.append("Access-Control-Allow-Origin: *\r\n");
        sb.append("Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n");
        sb.append("Access-Control-Allow-Headers: Range, Origin, Content-Type, Accept\r\n");
        sb.append("Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges\r\n");
        sb.append("transferMode.dlna.org: Streaming\r\n");
        sb.append("contentFeatures.dlna.org: DLNA.ORG_OP=01;DLNA.ORG_CI=0\r\n");
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
        writeLanHeaders(out, code, reason, "text/plain; charset=utf-8", payload.length, null, null);
        out.write(payload);
        out.flush();
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

        private SSLSocket socket;
        private OutputStream outStream;
        private volatile boolean closed = false;
        private volatile String appSessionId = "";
        private volatile String transportId = "";
        private volatile long mediaSessionId = -1L;
        private volatile boolean mediaLoaded = false;

        private String pendingMediaUrl = "";
        private String pendingMimeType = "video/mp4";
        private String pendingTitle = "";
        private String pendingSubtitle = "";
        private String pendingPoster = "";
        private long pendingStartMs = 0L;
        private String pendingVttUrl = "";
        private String pendingVttLabel = "";
        private long lastPingSentMs = 0L;

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
            String vttLabel
        ) throws Exception {
            this.pendingMediaUrl = mediaUrl;
            this.pendingMimeType = mimeType;
            this.pendingTitle = title;
            this.pendingSubtitle = subtitle;
            this.pendingPoster = poster;
            this.pendingStartMs = startPosMs;
            this.pendingVttUrl = vttUrl != null ? vttUrl : "";
            this.pendingVttLabel = vttLabel != null ? vttLabel : "Legenda";

            SSLContext sslCtx = SSLContext.getInstance("TLS");
            sslCtx.init(null, new TrustManager[] { new LanCastTrustManager() }, new SecureRandom());
            SSLSocket sslSocket = (SSLSocket) sslCtx.getSocketFactory().createSocket();
            sslSocket.connect(new InetSocketAddress(device.host, device.port), 8000);
            sslSocket.setSoTimeout(0);
            sslSocket.startHandshake();

            this.socket = sslSocket;
            this.outStream = sslSocket.getOutputStream();
            this.lastPingSentMs = System.currentTimeMillis();

            Thread reader = new Thread(this::readLoop, "AnisyncCastReader");
            reader.setDaemon(true);
            reader.start();

            sendJson("receiver-0", TvCastProtocol.CAST_NS_CONNECTION, "{\"type\":\"CONNECT\",\"origin\":{}}");
            JSONObject launch = new JSONObject();
            launch.put("type", "LAUNCH");
            launch.put("appId", TvCastProtocol.CHROMECAST_DEFAULT_MEDIA_RECEIVER_APP_ID);
            launch.put("requestId", requestIdSeq.getAndIncrement());
            sendJson("receiver-0", TvCastProtocol.CAST_NS_RECEIVER, launch.toString());
        }

        private void readLoop() {
            try {
                InputStream in = socket.getInputStream();
                while (!closed && socket != null && !socket.isClosed()) {
                    TvCastProtocol.CastPacket packet = TvCastProtocol.readFramedCastMessage(in);
                    if (packet == null) break;
                    handleIncomingPacket(packet);
                }
            } catch (Exception e) {
                if (!closed) {
                    Log.d(TAG, "Chromecast socket closed: " + e.getMessage());
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
                    JSONObject volObj = st.optJSONObject("volume");
                    if (volObj != null) {
                        if (volObj.has("level")) {
                            volume = Math.max(0.0, Math.min(1.0, volObj.optDouble("level", volume)));
                        }
                        if (volObj.has("muted")) {
                            muted = volObj.optBoolean("muted", muted);
                        }
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
                                if (!newTransport.isEmpty() && !newTransport.equals(transportId)) {
                                    transportId = newTransport;
                                    appSessionId = newSession;
                                    sendJson(transportId, TvCastProtocol.CAST_NS_CONNECTION, "{\"type\":\"CONNECT\",\"origin\":{}}");
                                    if (!mediaLoaded) {
                                        mediaLoaded = true;
                                        sendLoadCommand(pendingMediaUrl);
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
                        if (mediaObj != null && mediaObj.has("duration")) {
                            long dMs = Math.round(mediaObj.optDouble("duration", 0.0) * 1000.0);
                            if (dMs > 0L) durationMs = dMs;
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

            if (!pendingVttUrl.isEmpty() && "background-proxy".equals(deliveryMode)) {
                JSONArray tracks = new JSONArray();
                JSONObject track = new JSONObject();
                track.put("trackId", 1);
                track.put("type", "TEXT");
                track.put("trackContentId", pendingVttUrl);
                track.put("trackContentType", "text/vtt");
                track.put("name", pendingVttLabel.isEmpty() ? "Português" : pendingVttLabel);
                track.put("language", "pt-BR");
                track.put("subtype", "SUBTITLES");
                tracks.put(track);
                media.put("tracks", tracks);

                JSONArray activeIds = new JSONArray();
                activeIds.put(1);
                load.put("activeTrackIds", activeIds);
            }

            load.put("media", media);
            sendJson(transportId, TvCastProtocol.CAST_NS_MEDIA, load.toString());
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

        void pollStatus() throws Exception {
            if (closed) return;
            long now = System.currentTimeMillis();
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
        }

        void stopAndClose() {
            if (closed) return;
            closed = true;
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
            try {
                if (socket != null) socket.close();
            } catch (Exception ignored) {
            }
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

    // -------------------------------------------------------------------------
    // DLNA / UPnP AVTransport + RenderingControl SOAP Controller
    // -------------------------------------------------------------------------

    private final class DlnaController {
        private final TvCastProtocol.CastDevice device;
        private boolean sawPlaying = false;

        DlnaController(TvCastProtocol.CastDevice device) {
            this.device = device;
        }

        void loadAndPlay(
            String mediaUrl,
            String mimeType,
            String title,
            String series,
            String poster,
            long startPosMs
        ) throws IOException {
            try {
                sendSoap(
                    device.avTransportControlUrl,
                    TvCastProtocol.UPNP_AV_TRANSPORT_SERVICE,
                    "Stop",
                    singletonInstanceArgs()
                );
            } catch (Exception ignored) {
            }

            String didl = TvCastProtocol.buildDidlLiteMetadata(title, series, poster, mediaUrl, mimeType);
            Map<String, String> setUriArgs = new LinkedHashMap<>();
            setUriArgs.put("InstanceID", "0");
            setUriArgs.put("CurrentURI", mediaUrl);
            setUriArgs.put("CurrentURIMetaData", didl);

            try {
                sendSoap(
                    device.avTransportControlUrl,
                    TvCastProtocol.UPNP_AV_TRANSPORT_SERVICE,
                    "SetAVTransportURI",
                    setUriArgs
                );
            } catch (IOException metadataErr) {
                // Some Smart TVs reject DIDL-Lite metadata; retry cleanly with empty metadata
                setUriArgs.put("CurrentURIMetaData", "");
                sendSoap(
                    device.avTransportControlUrl,
                    TvCastProtocol.UPNP_AV_TRANSPORT_SERVICE,
                    "SetAVTransportURI",
                    setUriArgs
                );
            }

            Map<String, String> playArgs = new LinkedHashMap<>();
            playArgs.put("InstanceID", "0");
            playArgs.put("Speed", "1");
            sendSoap(
                device.avTransportControlUrl,
                TvCastProtocol.UPNP_AV_TRANSPORT_SERVICE,
                "Play",
                playArgs
            );

            if (startPosMs > 2000L) {
                try {
                    Thread.sleep(900L);
                    seek(startPosMs);
                } catch (Exception ignored) {
                }
            }
        }

        void play() throws IOException {
            Map<String, String> args = new LinkedHashMap<>();
            args.put("InstanceID", "0");
            args.put("Speed", "1");
            sendSoap(device.avTransportControlUrl, TvCastProtocol.UPNP_AV_TRANSPORT_SERVICE, "Play", args);
        }

        void pause() throws IOException {
            sendSoap(
                device.avTransportControlUrl,
                TvCastProtocol.UPNP_AV_TRANSPORT_SERVICE,
                "Pause",
                singletonInstanceArgs()
            );
        }

        void seek(long targetMs) throws IOException {
            Map<String, String> args = new LinkedHashMap<>();
            args.put("InstanceID", "0");
            args.put("Unit", "REL_TIME");
            args.put("Target", TvCastProtocol.formatDlnaTime(targetMs));
            sendSoap(device.avTransportControlUrl, TvCastProtocol.UPNP_AV_TRANSPORT_SERVICE, "Seek", args);
        }

        void setVolume(double level) throws IOException {
            if (device.renderingControlUrl.isEmpty()) return;
            int volInt = (int) Math.round(Math.max(0.0, Math.min(1.0, level)) * 100.0);
            Map<String, String> args = new LinkedHashMap<>();
            args.put("InstanceID", "0");
            args.put("Channel", "Master");
            args.put("DesiredVolume", String.valueOf(volInt));
            sendSoap(device.renderingControlUrl, TvCastProtocol.UPNP_RENDERING_CONTROL_SERVICE, "SetVolume", args);
        }

        void stopQuietly() {
            try {
                sendSoap(
                    device.avTransportControlUrl,
                    TvCastProtocol.UPNP_AV_TRANSPORT_SERVICE,
                    "Stop",
                    singletonInstanceArgs()
                );
            } catch (Exception ignored) {
            }
        }

        void pollStatus(int gen) throws IOException {
            String transportXml = sendSoap(
                device.avTransportControlUrl,
                TvCastProtocol.UPNP_AV_TRANSPORT_SERVICE,
                "GetTransportInfo",
                singletonInstanceArgs()
            );
            String transportState = TvCastProtocol.extractXmlTagValue(transportXml, "CurrentTransportState")
                .toUpperCase(Locale.ROOT);

            String posXml = sendSoap(
                device.avTransportControlUrl,
                TvCastProtocol.UPNP_AV_TRANSPORT_SERVICE,
                "GetPositionInfo",
                singletonInstanceArgs()
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

            if ("PLAYING".equals(transportState)) {
                sawPlaying = true;
                status = "playing";
            } else if ("PAUSED_PLAYBACK".equals(transportState)) {
                status = "paused";
            } else if ("TRANSITIONING".equals(transportState)) {
                status = "buffering";
            } else if ("STOPPED".equals(transportState) || "NO_MEDIA_PRESENT".equals(transportState)) {
                if (sawPlaying && durationMs > 10_000L && positionMs >= durationMs - 20_000L) {
                    handleNaturalEpisodeCompleted(gen);
                    return;
                }
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
            if (controlUrl == null || controlUrl.isEmpty()) {
                throw new IOException("Missing DLNA control URL");
            }
            byte[] payload = TvCastProtocol.buildSoapEnvelope(serviceType, action, args)
                .getBytes(StandardCharsets.UTF_8);
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(controlUrl).openConnection();
                conn.setConnectTimeout(5000);
                conn.setReadTimeout(6000);
                conn.setRequestMethod("POST");
                conn.setDoOutput(true);
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
                    throw new IOException("TV DLNA retornou HTTP " + code + " para " + action);
                }
                return responseBody;
            } finally {
                if (conn != null) conn.disconnect();
            }
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

        if ("lan-link".equals(deliveryMode)) {
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
            o.put("volume", volume);
            o.put("muted", muted);
            o.put("hasPrev", prevUrl != null && !prevUrl.isEmpty());
            o.put("hasNext", nextUrl != null && !nextUrl.isEmpty());
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
            if (!TvCastProtocol.isSafeExternalHttpUrl(sUrl)) {
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
            subtitleUrl = m.optString("subtitleUrl", "").trim();
            subtitleLabel = m.optString("subtitleLabel", "Legenda").trim();
            selectedServerNume = m.optString("selectedServerNume", "").trim();
            prevUrl = m.optString("prevUrl", "").trim();
            nextUrl = m.optString("nextUrl", "").trim();
            autoPlayNextEpisode = m.optBoolean("autoPlayNextEpisode", false);
            positionMs = Math.max(0L, m.optLong("startPositionMs", 0L));
            durationMs = Math.max(0L, m.optLong("durationMs", 0L));
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
