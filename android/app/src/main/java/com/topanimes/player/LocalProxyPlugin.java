package com.topanimes.player;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.PendingIntentCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.pm.PackageInfoCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.ref.WeakReference;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.net.URL;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

@CapacitorPlugin(
    name = "LocalProxy",
    permissions = {
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class LocalProxyPlugin extends Plugin {
    private static final String TAG = "TopAnimesLocalProxy";
    private static final String CHANNEL_EPISODES_ID = "anisync_episodes";
    private static final String CHANNEL_UPDATES_ID = "anisync_updates";
    private static final String DEFAULT_UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
    private static final Pattern DIRECT_HOSTS_PATTERN = Pattern.compile(
        "(?:^|\\.)(?:booonceivu\\.shop|123flmsfree\\.com|321moviesfree\\.com)$",
        Pattern.CASE_INSENSITIVE
    );
    private static final Pattern DISGUISED_SEGMENT_PATH_PATTERN = Pattern.compile(
        "\\.(?:image|png|jpe?g|gif|webp|bmp|ico|svg|js|css|html?|txt)$",
        Pattern.CASE_INSENSITIVE
    );
    private static final Pattern DISGUISED_CONTENT_TYPE_PATTERN = Pattern.compile(
        "^(?:image/|text/(?:plain|html|css|javascript)|application/(?:javascript|x-javascript|octet-stream)|binary/octet-stream)",
        Pattern.CASE_INSENSITIVE
    );
    private static final Pattern ZERO_RANGE_PATTERN = Pattern.compile(
        "^bytes=0-\\d*$",
        Pattern.CASE_INSENSITIVE
    );
    private static final Pattern CONTENT_RANGE_PATTERN = Pattern.compile(
        "^bytes\\s+(\\d+)-(\\d+)/(\\d+|\\*)$",
        Pattern.CASE_INSENSITIVE
    );
    private static final Pattern URI_ATTR_PATTERN = Pattern.compile("URI=\"([^\"]+)\"", Pattern.CASE_INSENSITIVE);
    private static final Pattern M3U8_EXT_PATTERN = Pattern.compile("\\.m3u8(?:$|\\?)", Pattern.CASE_INSENSITIVE);
    private static final Pattern EXTINF_DURATION_PATTERN = Pattern.compile(
        "^#EXTINF:([0-9]+(?:\\.[0-9]+)?)",
        Pattern.CASE_INSENSITIVE
    );
    private static final int MPEG_TS_PACKET_SIZE = 188;
    private static final int MPEG_TS_SYNC_BYTE = 0x47;
    private static final int TS_PROBE_BUFFER_SIZE = 32768;
    private static final long BUFFER_REPORT_STEP_BYTES = 131072L;

    public interface BufferProgressListener {
        void onByteRangeBuffered(long sessionId, long rangeStart, long rangeEnd, long totalBytes);
        void onHlsTimeBuffered(long sessionId, long segStartMs, long segEndMs);
    }

    public static volatile String sharedProxyBaseUrl = "";
    private static volatile long activeBufferListenerSessionId = 0L;
    private static volatile BufferProgressListener activeBufferListener = null;

    public static void setBufferProgressListener(long sessionId, BufferProgressListener listener) {
        if (sessionId <= 0L || listener == null) {
            activeBufferListenerSessionId = 0L;
            activeBufferListener = null;
            return;
        }
        activeBufferListenerSessionId = sessionId;
        activeBufferListener = listener;
    }

    public static void clearBufferProgressListener(long sessionId) {
        if (sessionId <= 0L || activeBufferListenerSessionId == sessionId) {
            activeBufferListenerSessionId = 0L;
            activeBufferListener = null;
        }
    }

    private static void notifyByteRangeBuffered(long sessionId, long rangeStart, long rangeEnd, long totalBytes) {
        if (sessionId <= 0L || totalBytes <= 0L || rangeEnd <= rangeStart) return;
        BufferProgressListener listener = activeBufferListener;
        if (listener != null && activeBufferListenerSessionId == sessionId) {
            listener.onByteRangeBuffered(sessionId, rangeStart, Math.min(rangeEnd, totalBytes), totalBytes);
        }
    }

    private static void notifyHlsTimeBuffered(long sessionId, long segStartMs, long segEndMs) {
        if (sessionId <= 0L || segEndMs <= 0L || segEndMs < segStartMs) return;
        BufferProgressListener listener = activeBufferListener;
        if (listener != null && activeBufferListenerSessionId == sessionId) {
            listener.onHlsTimeBuffered(sessionId, segStartMs, segEndMs);
        }
    }
    private static volatile WeakReference<LocalProxyPlugin> activeInstanceRef = new WeakReference<>(null);
    private static ServerSocket sharedServerSocket;
    private static volatile int sharedProxyPort = -1;
    private static volatile boolean sharedProxyRunning = false;
    private static ExecutorService sharedProxyExecutor;

    public static void notifyInstallStage(String stage, int percent, String message) {
        LocalProxyPlugin instance = activeInstanceRef.get();
        if (instance != null) {
            if ("installed".equals(stage) || "cancelled".equals(stage) || "error".equals(stage)) {
                instance.activeApkSessionId = -1;
            }
            instance.emitDownloadProgress(0L, 0L, percent, stage, message);
        }
    }

    public static synchronized String ensureSharedProxyBaseUrl() {
        if (sharedProxyRunning && sharedProxyPort > 0 && sharedServerSocket != null && !sharedServerSocket.isClosed()) {
            sharedProxyBaseUrl = "http://127.0.0.1:" + sharedProxyPort;
            return sharedProxyBaseUrl;
        }
        try {
            if (sharedProxyExecutor == null || sharedProxyExecutor.isShutdown()) {
                sharedProxyExecutor = Executors.newCachedThreadPool();
            }
            sharedServerSocket = new ServerSocket(0, 64, InetAddress.getByName("127.0.0.1"));
            sharedProxyPort = sharedServerSocket.getLocalPort();
            sharedProxyBaseUrl = "http://127.0.0.1:" + sharedProxyPort;
            sharedProxyRunning = true;

            final ServerSocket boundSocket = sharedServerSocket;
            final ExecutorService pool = sharedProxyExecutor;
            Thread acceptThread = new Thread(() -> {
                while (sharedProxyRunning && !boundSocket.isClosed()) {
                    try {
                        Socket client = boundSocket.accept();
                        pool.execute(() -> handleSocketStatic(client));
                    } catch (IOException e) {
                        if (sharedProxyRunning) {
                            Log.w(TAG, "Accept error: " + e.getMessage());
                        }
                    }
                }
            }, "TopAnimesProxyAccept");
            acceptThread.setDaemon(true);
            acceptThread.start();
            Log.i(TAG, "Local proxy started on 127.0.0.1:" + sharedProxyPort);
        } catch (IOException e) {
            Log.e(TAG, "Failed to start local proxy", e);
        }
        return sharedProxyBaseUrl;
    }

    public static String buildSharedProxyUrl(String targetUrl, String referer) {
        return buildSharedProxyUrl(targetUrl, referer, 0L);
    }

    public static String buildSharedProxyUrl(String targetUrl, String referer, long sessionId) {
        String base = sharedProxyBaseUrl;
        if (base == null || base.isEmpty() || !sharedProxyRunning) {
            base = ensureSharedProxyBaseUrl();
        }
        if (base == null || base.isEmpty() || targetUrl == null || targetUrl.isEmpty()) {
            return targetUrl;
        }
        try {
            String safeReferer = (referer != null && isSafeHttpUrl(referer)) ? referer : "https://topanimes.net/";
            String pathSuffix = M3U8_EXT_PATTERN.matcher(targetUrl).find() ? "/stream-proxy/playlist.m3u8" : "/stream-proxy";
            return base + pathSuffix + "?url="
                + URLEncoder.encode(targetUrl, "UTF-8")
                + "&referer=" + URLEncoder.encode(safeReferer, "UTF-8")
                + (sessionId > 0L ? "&sid=" + sessionId : "");
        } catch (Exception e) {
            return targetUrl;
        }
    }

    private ExecutorService executor;
    private final AtomicLong activeApkDownloadId = new AtomicLong(0L);
    private volatile HttpURLConnection activeApkConnection = null;
    private volatile PackageInstaller.Session activeApkSession = null;
    private volatile int activeApkSessionId = -1;

    @Override
    public void load() {
        super.load();
        activeInstanceRef = new WeakReference<>(this);
        startProxyServer();
    }

    @Override
    protected void handleOnDestroy() {
        if (activeInstanceRef.get() == this) {
            activeInstanceRef.clear();
        }
        cancelActiveApkDownloadInternal();
        if (executor != null) {
            executor.shutdownNow();
            executor = null;
        }
        super.handleOnDestroy();
    }

    private synchronized void startProxyServer() {
        if (executor == null || executor.isShutdown()) {
            executor = Executors.newCachedThreadPool();
        }
        ensureSharedProxyBaseUrl();
    }

    @PluginMethod
    public void getProxyBaseUrl(PluginCall call) {
        String base = ensureSharedProxyBaseUrl();
        JSObject ret = new JSObject();
        ret.put("baseUrl", base != null ? base : "");
        call.resolve(ret);
    }

    @PluginMethod
    public void fetchPage(PluginCall call) {
        String rawUrl = call.getString("url", "");
        if (!isSafeHttpUrl(rawUrl)) {
            call.reject("URL inválida ou não permitida.");
            return;
        }
        String referer = call.getString("referer", "");
        String accept = call.getString("accept", "text/html,application/xhtml+xml,application/json,*/*;q=0.9");
        String rawMethod = call.getString("method", "GET");
        String method = "POST".equalsIgnoreCase(rawMethod)
            ? "POST"
            : "PROPFIND".equalsIgnoreCase(rawMethod)
                ? "PROPFIND"
                : "GET";
        String requestBody = call.getString("body", null);
        String contentType = call.getString("contentType", null);
        JSObject rawHeaders = call.getObject("headers", null);
        Map<String, String> customHeaders = new HashMap<>();
        if (rawHeaders != null) {
            java.util.Iterator<String> keys = rawHeaders.keys();
            while (keys.hasNext()) {
                String k = keys.next();
                String v = rawHeaders.optString(k, "");
                if (k != null && !v.isEmpty()) {
                    customHeaders.put(k, v);
                }
            }
        }
        int timeoutMs = call.getInt("timeoutMs", 12000);

        if (executor == null || executor.isShutdown()) {
            startProxyServer();
        }

        executor.execute(() -> {
            HttpURLConnection conn = null;
            try {
                RedirectResult res = openWithRedirects(
                    rawUrl,
                    referer,
                    accept,
                    null,
                    timeoutMs,
                    method,
                    requestBody,
                    contentType,
                    customHeaders
                );
                conn = res.connection;
                int status = conn.getResponseCode();
                InputStream stream = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                String body = stream != null ? readStreamAsString(stream) : "";

                JSObject ret = new JSObject();
                ret.put("status", status);
                ret.put("ok", status >= 200 && status < 300);
                ret.put("finalUrl", res.finalUrl);
                ret.put("body", body);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : "Falha na requisição HTTP.");
            } finally {
                if (conn != null) {
                    conn.disconnect();
                }
            }
        });
    }

    @PluginMethod
    public void openExternalUrl(PluginCall call) {
        String rawUrl = call.getString("url", "");
        if (rawUrl == null || rawUrl.trim().isEmpty()) {
            call.reject("URL obrigatória.");
            return;
        }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(rawUrl.trim()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            JSObject ret = new JSObject();
            ret.put("opened", true);
            call.resolve(ret);
        } catch (Exception e) {
            JSObject ret = new JSObject();
            ret.put("opened", false);
            call.resolve(ret);
        }
    }

    @PluginMethod
    public void getAppBuildInfo(PluginCall call) {
        try {
            PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            long versionCode = PackageInfoCompat.getLongVersionCode(info);
            JSObject ret = new JSObject();
            ret.put("versionName", info.versionName != null ? info.versionName : "1.0");
            ret.put("versionCode", versionCode);
            call.resolve(ret);
        } catch (Exception e) {
            JSObject ret = new JSObject();
            ret.put("versionName", "1.0");
            ret.put("versionCode", 1);
            call.resolve(ret);
        }
    }

    private String resolveNotificationPermissionStatus() {
        Context ctx = getContext();
        if (ctx == null) return "unsupported";
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            int granted = ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS);
            if (granted == PackageManager.PERMISSION_GRANTED) {
                return NotificationManagerCompat.from(ctx).areNotificationsEnabled() ? "granted" : "denied";
            }
            PermissionState state = getPermissionState("notifications");
            if (state == PermissionState.DENIED) {
                return "denied";
            }
            return "default";
        }
        return NotificationManagerCompat.from(ctx).areNotificationsEnabled() ? "granted" : "denied";
    }

    private void ensureNotificationChannels(Context ctx) {
        NotificationManager manager = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;

        NotificationChannel episodesChannel = new NotificationChannel(
            CHANNEL_EPISODES_ID,
            "Novos Episódios",
            NotificationManager.IMPORTANCE_HIGH
        );
        episodesChannel.setDescription("Avisos quando novos episódios dos seus animes favoritos ficam disponíveis.");
        manager.createNotificationChannel(episodesChannel);

        NotificationChannel updatesChannel = new NotificationChannel(
            CHANNEL_UPDATES_ID,
            "Atualizações do Anisync",
            NotificationManager.IMPORTANCE_DEFAULT
        );
        updatesChannel.setDescription("Avisos quando uma nova versão do aplicativo está disponível.");
        manager.createNotificationChannel(updatesChannel);
    }

    @PluginMethod
    public void getNotificationPermission(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("status", resolveNotificationPermissionStatus());
        call.resolve(ret);
    }

    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        Context ctx = getContext();
        if (ctx == null) {
            JSObject ret = new JSObject();
            ret.put("status", "unsupported");
            call.resolve(ret);
            return;
        }
        ensureNotificationChannels(ctx);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            int granted = ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS);
            if (granted == PackageManager.PERMISSION_GRANTED) {
                JSObject ret = new JSObject();
                ret.put("status", resolveNotificationPermissionStatus());
                call.resolve(ret);
                return;
            }
            requestPermissionForAlias("notifications", call, "notificationPermissionsCallback");
            return;
        }
        JSObject ret = new JSObject();
        ret.put("status", resolveNotificationPermissionStatus());
        call.resolve(ret);
    }

    @PermissionCallback
    private void notificationPermissionsCallback(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("status", resolveNotificationPermissionStatus());
        call.resolve(ret);
    }

    @PluginMethod
    public void showLocalNotification(PluginCall call) {
        Context ctx = getContext();
        if (ctx == null) {
            JSObject ret = new JSObject();
            ret.put("shown", false);
            call.resolve(ret);
            return;
        }
        if (!"granted".equals(resolveNotificationPermissionStatus())) {
            JSObject ret = new JSObject();
            ret.put("shown", false);
            call.resolve(ret);
            return;
        }

        String title = call.getString("title", "Anisync");
        String body = call.getString("body", "");
        String channelRaw = call.getString("channelId", CHANNEL_EPISODES_ID);
        String channelId = CHANNEL_UPDATES_ID.equals(channelRaw) ? CHANNEL_UPDATES_ID : CHANNEL_EPISODES_ID;
        String targetUrl = call.getString("targetUrl", "");
        String mediaKind = call.getString("mediaKind", "episode");
        int notifId = call.getInt("id", (int) (System.currentTimeMillis() & 0x7fffffff));

        try {
            ensureNotificationChannels(ctx);

            Intent launchIntent = new Intent(ctx, MainActivity.class);
            launchIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            if (targetUrl != null && !targetUrl.trim().isEmpty()) {
                launchIntent.putExtra(MainActivity.EXTRA_NOTIFICATION_URL, targetUrl.trim());
                launchIntent.putExtra(MainActivity.EXTRA_NOTIFICATION_KIND, mediaKind != null ? mediaKind : "episode");
            }

            PendingIntent pendingIntent = PendingIntentCompat.getActivity(
                ctx,
                notifId,
                launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT,
                false
            );

            NotificationCompat.Builder builder = new NotificationCompat.Builder(ctx, channelId)
                .setSmallIcon(R.drawable.ic_stat_anisync)
                .setColor(0xFFF97316)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setPriority(CHANNEL_EPISODES_ID.equals(channelId)
                    ? NotificationCompat.PRIORITY_HIGH
                    : NotificationCompat.PRIORITY_DEFAULT)
                .setAutoCancel(true);

            if (pendingIntent != null) {
                builder.setContentIntent(pendingIntent);
            }

            NotificationManagerCompat.from(ctx).notify(notifId, builder.build());

            JSObject ret = new JSObject();
            ret.put("shown", true);
            call.resolve(ret);
        } catch (Exception e) {
            Log.w(TAG, "Failed to post local notification: " + e.getMessage());
            JSObject ret = new JSObject();
            ret.put("shown", false);
            call.resolve(ret);
        }
    }

    @PluginMethod
    public void consumePendingNotificationTarget(PluginCall call) {
        String[] target = MainActivity.consumePendingNotificationTarget();
        JSObject ret = new JSObject();
        if (target != null && target[0] != null) {
            ret.put("url", target[0]);
            ret.put("kind", target[1] != null ? target[1] : "episode");
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void cancelApkDownload(PluginCall call) {
        boolean cancelled = cancelActiveApkDownloadInternal();
        emitDownloadProgress(0L, 0L, 0, "cancelled", "Atualização cancelada.");
        JSObject ret = new JSObject();
        ret.put("cancelled", cancelled);
        call.resolve(ret);
    }

    private synchronized boolean cancelActiveApkDownloadInternal() {
        boolean hadActive = activeApkConnection != null || activeApkSession != null || activeApkSessionId >= 0;
        activeApkDownloadId.incrementAndGet();

        final HttpURLConnection conn = activeApkConnection;
        activeApkConnection = null;
        if (conn != null) {
            if (executor != null && !executor.isShutdown()) {
                executor.execute(() -> {
                    try {
                        conn.disconnect();
                    } catch (Exception ignored) {
                    }
                });
            } else {
                try {
                    conn.disconnect();
                } catch (Exception ignored) {
                }
            }
        }

        PackageInstaller.Session sess = activeApkSession;
        activeApkSession = null;
        if (sess != null) {
            try {
                sess.abandon();
            } catch (Exception ignored) {
            }
        }

        int sessId = activeApkSessionId;
        activeApkSessionId = -1;
        if (sessId >= 0) {
            try {
                getContext().getPackageManager().getPackageInstaller().abandonSession(sessId);
            } catch (Exception ignored) {
            }
        }

        return hadActive;
    }

    private synchronized long prepareNewApkDownload() {
        cancelActiveApkDownloadInternal();
        return activeApkDownloadId.incrementAndGet();
    }

    private void ensureApkDownloadActive(long downloadId) {
        if (activeApkDownloadId.get() != downloadId || Thread.currentThread().isInterrupted()) {
            throw new CancellationException("Atualização cancelada.");
        }
    }

    @PluginMethod
    public void downloadAndInstallApk(PluginCall call) {
        String rawUrl = call.getString("url", "");
        String expectedSha256 = normalizeSha256Hex(call.getString("expectedSha256", ""));
        if (!isAllowedInitialGitHubApkUrl(rawUrl)) {
            call.reject("URL de download do GitHub inválida ou não permitida.");
            return;
        }

        Context ctx = getContext();
        String pkgName = ctx.getPackageName();

        if (!ctx.getPackageManager().canRequestPackageInstalls()) {
            try {
                Intent permIntent = new Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + pkgName)
                );
                permIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(permIntent);
            } catch (Exception e) {
                Log.w(TAG, "Failed opening unknown app sources settings", e);
            }
            JSObject ret = new JSObject();
            ret.put("started", false);
            ret.put("needsPermission", true);
            ret.put("message", "Ative 'Permitir desta fonte' nas configurações e tente novamente.");
            call.resolve(ret);
            return;
        }

        if (executor == null || executor.isShutdown()) {
            startProxyServer();
        }

        final long downloadId = prepareNewApkDownload();

        executor.execute(() -> {
            File stagingApk = new File(ctx.getCacheDir(), "topanimes_update_staging.apk");
            HttpURLConnection conn = null;
            PackageInstaller.Session session = null;
            try {
                ensureApkDownloadActive(downloadId);
                emitDownloadProgress(0L, 0L, 0, "downloading", null);

                String currentUrl = rawUrl.trim();
                for (int hop = 0; hop <= 6; hop++) {
                    ensureApkDownloadActive(downloadId);
                    if (!isAllowedGitHubCdnUrl(currentUrl)) {
                        throw new IOException("Redirecionamento fora dos domínios oficiais do GitHub.");
                    }
                    URL parsed = new URL(currentUrl);
                    conn = (HttpURLConnection) parsed.openConnection();
                    activeApkConnection = conn;
                    ensureApkDownloadActive(downloadId);
                    conn.setInstanceFollowRedirects(false);
                    conn.setConnectTimeout(15000);
                    conn.setReadTimeout(30000);
                    conn.setRequestMethod("GET");
                    conn.setRequestProperty("User-Agent", DEFAULT_UA);
                    conn.setRequestProperty("Accept", "application/vnd.android.package-archive,application/octet-stream,*/*");

                    int code = conn.getResponseCode();
                    if (code >= 300 && code < 400) {
                        String loc = conn.getHeaderField("Location");
                        conn.disconnect();
                        if (activeApkConnection == conn) {
                            activeApkConnection = null;
                        }
                        conn = null;
                        if (loc == null || loc.isEmpty()) {
                            throw new IOException("Redirecionamento vazio ao baixar APK.");
                        }
                        currentUrl = new URL(parsed, loc).toString();
                        continue;
                    }
                    if (code < 200 || code >= 300) {
                        throw new IOException("GitHub retornou HTTP " + code + " ao baixar APK.");
                    }
                    break;
                }

                if (conn == null) {
                    throw new IOException("Excesso de redirecionamentos ao baixar APK.");
                }

                long totalBytes = -1L;
                try {
                    String cl = conn.getHeaderField("Content-Length");
                    if (cl != null) totalBytes = Long.parseLong(cl.trim());
                } catch (NumberFormatException ignored) {
                }

                MessageDigest sha256 = MessageDigest.getInstance("SHA-256");
                long downloaded = 0L;
                long lastEmitAt = 0L;
                byte[] buf = new byte[32768];

                try (InputStream in = new BufferedInputStream(conn.getInputStream());
                     FileOutputStream fos = new FileOutputStream(stagingApk)) {
                    int n;
                    while ((n = in.read(buf)) != -1) {
                        ensureApkDownloadActive(downloadId);
                        fos.write(buf, 0, n);
                        sha256.update(buf, 0, n);
                        downloaded += n;
                        long now = System.currentTimeMillis();
                        if (now - lastEmitAt >= 120L) {
                            lastEmitAt = now;
                            int pct = totalBytes > 0L
                                ? (int) Math.min(99L, (downloaded * 100L) / totalBytes)
                                : 0;
                            emitDownloadProgress(downloaded, totalBytes, pct, "downloading", null);
                        }
                    }
                    fos.getFD().sync();
                }

                ensureApkDownloadActive(downloadId);
                emitDownloadProgress(downloaded, totalBytes, 100, "verifying", null);

                if (!expectedSha256.isEmpty()) {
                    String actualSha256 = bytesToHex(sha256.digest());
                    if (!expectedSha256.equalsIgnoreCase(actualSha256)) {
                        throw new IOException("Falha na verificação SHA-256 do APK baixado.");
                    }
                }

                verifySelfUpdateArchive(ctx, stagingApk);

                ensureApkDownloadActive(downloadId);
                emitDownloadProgress(downloaded, totalBytes, 100, "installing", null);

                PackageInstaller installer = ctx.getPackageManager().getPackageInstaller();
                PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(
                    PackageInstaller.SessionParams.MODE_FULL_INSTALL
                );
                params.setAppPackageName(pkgName);
                params.setSize(stagingApk.length());
                params.setInstallReason(PackageManager.INSTALL_REASON_USER);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED);
                }

                int sessionId = installer.createSession(params);
                activeApkSessionId = sessionId;
                session = installer.openSession(sessionId);
                activeApkSession = session;

                try (InputStream apkIn = new BufferedInputStream(new FileInputStream(stagingApk));
                     OutputStream sessionOut = session.openWrite("TopAnimes.apk", 0L, stagingApk.length())) {
                    int read;
                    while ((read = apkIn.read(buf)) != -1) {
                        ensureApkDownloadActive(downloadId);
                        sessionOut.write(buf, 0, read);
                    }
                    session.fsync(sessionOut);
                }

                ensureApkDownloadActive(downloadId);

                // Remove temporary file right away once copied into PackageManager's session
                //noinspection ResultOfMethodCallIgnored
                stagingApk.delete();

                Intent callbackIntent = new Intent(ctx, ApkInstallReceiver.class);
                PendingIntent pendingIntent = PendingIntentCompat.getBroadcast(
                    ctx,
                    sessionId,
                    callbackIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT,
                    true
                );
                if (pendingIntent == null) {
                    throw new IOException("Não foi possível criar PendingIntent de instalação.");
                }
                session.commit(pendingIntent.getIntentSender());
                session.close();
                if (activeApkSession == session) {
                    activeApkSession = null;
                }
                session = null;

                JSObject ret = new JSObject();
                ret.put("started", true);
                ret.put("needsPermission", false);
                call.resolve(ret);
            } catch (CancellationException ce) {
                Log.i(TAG, "Self-update cancelled by user");
                if (session != null) {
                    try {
                        session.abandon();
                    } catch (Exception ignored) {
                    }
                }
                activeApkSession = null;
                activeApkSessionId = -1;
                emitDownloadProgress(0L, 0L, 0, "cancelled", "Atualização cancelada.");
                JSObject ret = new JSObject();
                ret.put("started", false);
                ret.put("cancelled", true);
                ret.put("needsPermission", false);
                ret.put("message", "Atualização cancelada.");
                call.resolve(ret);
            } catch (Exception e) {
                if (session != null) {
                    try {
                        session.abandon();
                    } catch (Exception ignored) {
                    }
                }
                activeApkSession = null;
                activeApkSessionId = -1;
                if (activeApkDownloadId.get() != downloadId || Thread.currentThread().isInterrupted()) {
                    Log.i(TAG, "Self-update aborted due to cancellation");
                    emitDownloadProgress(0L, 0L, 0, "cancelled", "Atualização cancelada.");
                    JSObject ret = new JSObject();
                    ret.put("started", false);
                    ret.put("cancelled", true);
                    ret.put("needsPermission", false);
                    ret.put("message", "Atualização cancelada.");
                    call.resolve(ret);
                } else {
                    Log.e(TAG, "Self-update failed", e);
                    String msg = e.getMessage() != null ? e.getMessage() : "Falha ao baixar e validar atualização.";
                    emitDownloadProgress(0L, 0L, 0, "error", msg);
                    call.reject(msg);
                }
            } finally {
                if (conn != null) {
                    try {
                        conn.disconnect();
                    } catch (Exception ignored) {
                    }
                    if (activeApkConnection == conn) {
                        activeApkConnection = null;
                    }
                }
                if (stagingApk.exists()) {
                    //noinspection ResultOfMethodCallIgnored
                    stagingApk.delete();
                }
            }
        });
    }

    private void emitDownloadProgress(
        long downloadedBytes,
        long totalBytes,
        int percent,
        String stage,
        String message
    ) {
        JSObject payload = new JSObject();
        payload.put("downloadedBytes", downloadedBytes);
        payload.put("totalBytes", totalBytes);
        payload.put("percent", percent);
        payload.put("stage", stage);
        if (message != null && !message.isEmpty()) {
            payload.put("message", message);
        }
        notifyListeners("apkDownloadProgress", payload);
    }

    private static void verifySelfUpdateArchive(Context ctx, File apkFile) throws IOException {
        PackageManager pm = ctx.getPackageManager();
        String expectedPkg = ctx.getPackageName();

        int archiveFlags = getSigningFlags();
        PackageInfo archiveInfo = pm.getPackageArchiveInfo(apkFile.getAbsolutePath(), archiveFlags);
        if (archiveInfo == null || !expectedPkg.equals(archiveInfo.packageName)) {
            throw new IOException("Pacote inválido ou incompatível com " + expectedPkg + ".");
        }

        Set<String> installedCerts;
        try {
            PackageInfo installedInfo = pm.getPackageInfo(expectedPkg, archiveFlags);
            installedCerts = extractCertSha256s(installedInfo);
        } catch (Exception e) {
            installedCerts = Collections.emptySet();
        }
        Set<String> archiveCerts = extractCertSha256s(archiveInfo);

        if (!installedCerts.isEmpty() && !archiveCerts.isEmpty()
            && Collections.disjoint(installedCerts, archiveCerts)) {
            throw new IOException("Assinatura digital da atualização não corresponde à versão instalada.");
        }
    }

    @SuppressWarnings({"deprecation", "PackageManagerGetSignatures"})
    private static int getSigningFlags() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            return PackageManager.GET_SIGNING_CERTIFICATES;
        }
        return PackageManager.GET_SIGNATURES;
    }

    private static Set<String> extractCertSha256s(PackageInfo info) {
        Set<String> hashes = new HashSet<>();
        if (info == null) return hashes;
        try {
            Signature[] sigs = null;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                SigningInfo si = info.signingInfo;
                if (si != null) {
                    sigs = si.hasMultipleSigners() ? si.getApkContentsSigners() : si.getSigningCertificateHistory();
                }
            } else {
                @SuppressWarnings("deprecation")
                Signature[] legacy = info.signatures;
                sigs = legacy;
            }
            if (sigs != null) {
                MessageDigest md = MessageDigest.getInstance("SHA-256");
                for (Signature s : sigs) {
                    if (s != null) {
                        hashes.add(bytesToHex(md.digest(s.toByteArray())));
                        md.reset();
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return hashes;
    }

    private static String normalizeSha256Hex(String raw) {
        if (raw == null) return "";
        String clean = raw.trim().replaceFirst("(?i)^sha256:", "").trim();
        return clean.matches("^[0-9a-fA-F]{64}$") ? clean.toLowerCase(Locale.ROOT) : "";
    }

    private static String bytesToHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(String.format(Locale.ROOT, "%02x", b & 0xff));
        }
        return sb.toString();
    }

    private static boolean isAllowedInitialGitHubApkUrl(String rawUrl) {
        if (!isAllowedGitHubCdnUrl(rawUrl)) return false;
        try {
            URI uri = URI.create(rawUrl.trim());
            String host = uri.getHost() != null ? uri.getHost().toLowerCase(Locale.ROOT) : "";
            String path = uri.getPath() != null ? uri.getPath().toLowerCase(Locale.ROOT) : "";
            if ("github.com".equals(host) || "www.github.com".equals(host)) {
                return path.startsWith("/martin01683/aplicativo-de-animes/releases/");
            }
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private static boolean isAllowedGitHubCdnUrl(String rawUrl) {
        if (rawUrl == null || rawUrl.trim().isEmpty()) return false;
        try {
            URI uri = URI.create(rawUrl.trim());
            String scheme = uri.getScheme() != null ? uri.getScheme().toLowerCase(Locale.ROOT) : "";
            if (!"https".equals(scheme)) return false;
            String host = uri.getHost() != null ? uri.getHost().toLowerCase(Locale.ROOT) : "";
            return "github.com".equals(host)
                || host.endsWith(".github.com")
                || "githubusercontent.com".equals(host)
                || host.endsWith(".githubusercontent.com");
        } catch (Exception e) {
            return false;
        }
    }

    private static void handleSocketStatic(Socket client) {
        try (Socket sock = client) {
            sock.setSoTimeout(30000);
            InputStream in = new BufferedInputStream(sock.getInputStream());
            OutputStream out = sock.getOutputStream();

            String requestLine = readLine(in);
            if (requestLine == null || requestLine.isEmpty()) return;

            String[] parts = requestLine.split(" ");
            if (parts.length < 2) return;
            String method = parts[0].toUpperCase(Locale.ROOT);
            String target = parts[1];

            Map<String, String> reqHeaders = new HashMap<>();
            String headerLine;
            while ((headerLine = readLine(in)) != null && !headerLine.isEmpty()) {
                int idx = headerLine.indexOf(':');
                if (idx > 0) {
                    reqHeaders.put(
                        headerLine.substring(0, idx).trim().toLowerCase(Locale.ROOT),
                        headerLine.substring(idx + 1).trim()
                    );
                }
            }

            if ("OPTIONS".equals(method)) {
                writeCorsHeaders(out, 204, "No Content", null, 0, null, null, false);
                out.flush();
                return;
            }

            if (!target.startsWith("/stream-proxy")) {
                writeSimpleResponse(out, 404, "Not Found", "Not Found");
                return;
            }

            Map<String, String> query = parseQuery(target);
            String targetUrl = query.getOrDefault("url", "");
            String refererParam = query.getOrDefault("referer", "https://topanimes.net/");
            String referer = isSafeHttpUrl(refererParam) ? refererParam : "https://topanimes.net/";
            boolean isDownload = "1".equals(query.get("download"));
            boolean isHlsSegment = "1".equals(query.get("hls_seg"));
            long sessionId = parseLongQueryParam(query, "sid", 0L);
            long segStartMs = parseLongQueryParam(query, "seg_start_ms", -1L);
            long segEndMs = parseLongQueryParam(query, "seg_end_ms", -1L);

            if (!isSafeHttpUrl(targetUrl)) {
                writeSimpleResponse(out, 400, "Bad Request", "URL inválida");
                return;
            }

            String rangeHeader = reqHeaders.get("range");
            HttpURLConnection conn = null;
            try {
                RedirectResult upstream = openWithRedirects(targetUrl, referer, "*/*", rangeHeader, 20000);
                conn = upstream.connection;
                int status = conn.getResponseCode();
                String contentType = conn.getContentType();
                boolean isPlaylist = (contentType != null && contentType.toLowerCase(Locale.ROOT).contains("mpegurl"))
                    || (contentType != null && contentType.toLowerCase(Locale.ROOT).contains("m3u8"))
                    || M3U8_EXT_PATTERN.matcher(targetUrl).find();

                if (isPlaylist && status >= 200 && status < 300) {
                    String rawManifest = readStreamAsString(conn.getInputStream());
                    String rewritten = rewriteM3u8Playlist(rawManifest, upstream.finalUrl, referer, sessionId);
                    byte[] payload = rewritten.getBytes(StandardCharsets.UTF_8);
                    writeCorsHeaders(
                        out,
                        200,
                        "OK",
                        "application/vnd.apple.mpegurl; charset=utf-8",
                        payload.length,
                        null,
                        null,
                        false
                    );
                    if (!"HEAD".equals(method)) {
                        out.write(payload);
                    }
                    out.flush();
                    return;
                }

                String statusText = status == 206 ? "Partial Content" : (status == 200 ? "OK" : "Upstream");
                long contentLength = -1;
                try {
                    String cl = conn.getHeaderField("Content-Length");
                    if (cl != null) contentLength = Long.parseLong(cl.trim());
                } catch (NumberFormatException ignored) {
                }
                String contentRange = conn.getHeaderField("Content-Range");
                String acceptRanges = conn.getHeaderField("Accept-Ranges");
                long[] byteWindow = (!isDownload && status >= 200 && status < 300)
                    ? parseByteRangeWindow(status, contentRange, contentLength)
                    : null;
                long rangeStart = byteWindow != null ? byteWindow[0] : -1L;
                long totalBytes = byteWindow != null ? byteWindow[1] : -1L;
                boolean shouldReportBuffer = sessionId > 0L
                    && !isDownload
                    && !"HEAD".equals(method)
                    && status >= 200
                    && status < 300
                    && (segEndMs > 0L || totalBytes > 0L);

                InputStream bodyStream = status >= 400 ? conn.getErrorStream() : conn.getInputStream();

                // KojimaCDN and similar HLS hosts disguise MPEG-TS segments with a prepended fake
                // PNG/image header and image/* Content-Type (which breaks LibVLC's adaptive demuxer).
                // Probe the initial bytes and strip any leading wrapper before 0x47 TS sync packets.
                boolean shouldProbeTs = status >= 200
                    && status < 300
                    && !isDownload
                    && bodyStream != null
                    && isStartAtZeroRange(rangeHeader)
                    && (isHlsSegment || isDisguisedContentType(contentType));

                if (shouldProbeTs) {
                    byte[] probeBuf = new byte[TS_PROBE_BUFFER_SIZE];
                    int probeLen = readUpTo(bodyStream, probeBuf);
                    boolean reachedEof = probeLen < probeBuf.length;

                    if (looksLikeM3u8Manifest(probeBuf, probeLen)) {
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
                        String rewritten = rewriteM3u8Playlist(rawManifest, upstream.finalUrl, referer, sessionId);
                        byte[] payload = rewritten.getBytes(StandardCharsets.UTF_8);
                        writeCorsHeaders(
                            out,
                            200,
                            "OK",
                            "application/vnd.apple.mpegurl; charset=utf-8",
                            payload.length,
                            null,
                            null,
                            false
                        );
                        if (!"HEAD".equals(method)) {
                            out.write(payload);
                        }
                        out.flush();
                        return;
                    }

                    int tsOffset = findMpegTsSyncOffset(probeBuf, probeLen, reachedEof);
                    int outStatus = status;
                    String outStatusText = statusText;
                    String outContentType = contentType != null ? contentType : "application/octet-stream";
                    long outContentLength = contentLength;
                    String outContentRange = contentRange;
                    String outAcceptRanges = acceptRanges;

                    if (tsOffset >= 0) {
                        outContentType = "video/mp2t";
                        if (tsOffset > 0) {
                            if (outContentLength >= tsOffset) {
                                outContentLength -= tsOffset;
                            } else if (outContentLength >= 0) {
                                outContentLength = -1;
                            }
                            if (outStatus == 206) {
                                String adjustedRange = adjustContentRangeForStrip(outContentRange, tsOffset);
                                if (adjustedRange != null) {
                                    outContentRange = adjustedRange;
                                } else {
                                    outStatus = 200;
                                    outStatusText = "OK";
                                    outContentRange = null;
                                }
                            }
                            outAcceptRanges = null;
                        }
                    }

                    writeCorsHeaders(
                        out,
                        outStatus,
                        outStatusText,
                        outContentType,
                        outContentLength,
                        outContentRange,
                        outAcceptRanges,
                        false
                    );

                    if (!"HEAD".equals(method)) {
                        int startOff = tsOffset > 0 ? tsOffset : 0;
                        long totalSent = 0L;
                        long lastReportedSent = 0L;
                        long expectedLen = outContentLength > 0L ? outContentLength : contentLength;
                        if (probeLen > startOff) {
                            int firstChunk = probeLen - startOff;
                            out.write(probeBuf, startOff, firstChunk);
                            totalSent += firstChunk;
                            if (shouldReportBuffer && (reachedEof || totalSent - lastReportedSent >= BUFFER_REPORT_STEP_BYTES)) {
                                lastReportedSent = totalSent;
                                reportStreamChunkProgress(
                                    sessionId, segStartMs, segEndMs, rangeStart, totalBytes, totalSent, expectedLen, reachedEof
                                );
                            }
                        }
                        if (!reachedEof) {
                            byte[] buf = new byte[65536];
                            int read;
                            while ((read = bodyStream.read(buf)) != -1) {
                                out.write(buf, 0, read);
                                totalSent += read;
                                if (shouldReportBuffer && totalSent - lastReportedSent >= BUFFER_REPORT_STEP_BYTES) {
                                    lastReportedSent = totalSent;
                                    reportStreamChunkProgress(
                                        sessionId, segStartMs, segEndMs, rangeStart, totalBytes, totalSent, expectedLen, false
                                    );
                                }
                            }
                            if (shouldReportBuffer && totalSent > 0L) {
                                reportStreamChunkProgress(
                                    sessionId, segStartMs, segEndMs, rangeStart, totalBytes, totalSent, expectedLen, true
                                );
                            }
                        }
                    }
                    out.flush();
                    return;
                }

                writeCorsHeaders(
                    out,
                    status,
                    statusText,
                    contentType != null ? contentType : "application/octet-stream",
                    contentLength,
                    contentRange,
                    acceptRanges,
                    isDownload
                );

                if (bodyStream != null && !"HEAD".equals(method)) {
                    byte[] buf = new byte[65536];
                    int read;
                    long totalSent = 0L;
                    long lastReportedSent = 0L;
                    while ((read = bodyStream.read(buf)) != -1) {
                        out.write(buf, 0, read);
                        totalSent += read;
                        if (shouldReportBuffer && totalSent - lastReportedSent >= BUFFER_REPORT_STEP_BYTES) {
                            lastReportedSent = totalSent;
                            reportStreamChunkProgress(
                                sessionId, segStartMs, segEndMs, rangeStart, totalBytes, totalSent, contentLength, false
                            );
                        }
                    }
                    if (shouldReportBuffer && totalSent > 0L) {
                        reportStreamChunkProgress(
                            sessionId, segStartMs, segEndMs, rangeStart, totalBytes, totalSent, contentLength, true
                        );
                    }
                }
                out.flush();
            } finally {
                if (conn != null) conn.disconnect();
            }
        } catch (Exception e) {
            Log.d(TAG, "Proxy socket closed: " + e.getMessage());
        }
    }

    private static class RedirectResult {
        final HttpURLConnection connection;
        final String finalUrl;

        RedirectResult(HttpURLConnection connection, String finalUrl) {
            this.connection = connection;
            this.finalUrl = finalUrl;
        }
    }

    private static RedirectResult openWithRedirects(
        String rawUrl,
        String referer,
        String accept,
        String rangeHeader,
        int timeoutMs
    ) throws IOException {
        return openWithRedirects(rawUrl, referer, accept, rangeHeader, timeoutMs, "GET", null, null, null);
    }

    private static RedirectResult openWithRedirects(
        String rawUrl,
        String referer,
        String accept,
        String rangeHeader,
        int timeoutMs,
        String initialMethod,
        String requestBody,
        String contentType,
        Map<String, String> customHeaders
    ) throws IOException {
        String currentUrl = rawUrl;
        String currentMethod = "POST".equalsIgnoreCase(initialMethod)
            ? "POST"
            : "PROPFIND".equalsIgnoreCase(initialMethod)
                ? "PROPFIND"
                : "GET";
        String currentBody = "POST".equals(currentMethod) ? requestBody : null;
        for (int hop = 0; hop <= 4; hop++) {
            if (!isSafeHttpUrl(currentUrl)) {
                throw new IOException("URL bloqueada por segurança.");
            }
            URL parsed = new URL(currentUrl);
            HttpURLConnection conn = (HttpURLConnection) parsed.openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(timeoutMs);
            conn.setReadTimeout(timeoutMs);
            conn.setRequestMethod(currentMethod);
            conn.setRequestProperty("User-Agent", DEFAULT_UA);
            conn.setRequestProperty("Accept", accept != null ? accept : "*/*");
            conn.setRequestProperty("Accept-Language", "pt-BR,pt;q=0.9,en;q=0.8");

            String host = parsed.getHost() != null ? parsed.getHost().toLowerCase(Locale.ROOT) : "";
            boolean isFileVideo = host.contains("filevideo1.com");
            boolean isTikTokCdn = host.equals("tiktokcdn.com") || host.endsWith(".tiktokcdn.com");
            if (referer != null
                && !referer.isEmpty()
                && isSafeHttpUrl(referer)
                && !(isFileVideo && referer.toLowerCase(Locale.ROOT).contains("csst.online"))
                && !isTikTokCdn) {
                conn.setRequestProperty("Referer", referer);
            }
            if (rangeHeader != null && !rangeHeader.isEmpty() && "GET".equals(currentMethod)) {
                conn.setRequestProperty("Range", rangeHeader);
            }
            if (customHeaders != null && !customHeaders.isEmpty()) {
                for (Map.Entry<String, String> entry : customHeaders.entrySet()) {
                    String key = entry.getKey();
                    String val = entry.getValue();
                    if (key == null || val == null || val.isEmpty()) continue;
                    String lowerKey = key.toLowerCase(Locale.ROOT);
                    if ("authorization".equals(lowerKey)
                        || "origin".equals(lowerKey)
                        || "cookie".equals(lowerKey)) {
                        conn.setRequestProperty(key, val);
                    }
                }
            }

            if ("POST".equals(currentMethod) && currentBody != null) {
                byte[] payload = currentBody.getBytes(StandardCharsets.UTF_8);
                conn.setDoOutput(true);
                String ct = contentType != null && !contentType.isEmpty()
                    ? contentType
                    : "application/x-www-form-urlencoded; charset=UTF-8";
                conn.setRequestProperty("Content-Type", ct);
                if (!ct.toLowerCase(Locale.ROOT).contains("application/json")) {
                    conn.setRequestProperty("X-Requested-With", "XMLHttpRequest");
                }
                conn.setFixedLengthStreamingMode(payload.length);
                try (OutputStream out = conn.getOutputStream()) {
                    out.write(payload);
                }
            }

            int code = conn.getResponseCode();
            if (code >= 300 && code < 400) {
                String loc = conn.getHeaderField("Location");
                conn.disconnect();
                if (loc == null || loc.isEmpty()) {
                    throw new IOException("Redirecionamento sem destino.");
                }
                if (code != 307 && code != 308 && "POST".equals(currentMethod)) {
                    currentMethod = "GET";
                    currentBody = null;
                }
                currentUrl = new URL(parsed, loc).toString();
                continue;
            }
            return new RedirectResult(conn, parsed.toString());
        }
        throw new IOException("Excesso de redirecionamentos.");
    }

    private static long parseLongQueryParam(Map<String, String> query, String key, long fallback) {
        if (query == null || key == null) return fallback;
        String raw = query.get(key);
        if (raw == null || raw.trim().isEmpty()) return fallback;
        try {
            return Long.parseLong(raw.trim());
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    private static long[] parseByteRangeWindow(int status, String contentRange, long contentLength) {
        if (contentRange != null && !contentRange.trim().isEmpty()) {
            Matcher m = CONTENT_RANGE_PATTERN.matcher(contentRange.trim());
            if (m.matches()) {
                try {
                    long start = Long.parseLong(m.group(1));
                    String totalStr = m.group(3);
                    if (!"*".equals(totalStr)) {
                        long total = Long.parseLong(totalStr);
                        if (start >= 0L && total > 0L) {
                            return new long[] { start, total };
                        }
                    }
                } catch (NumberFormatException ignored) {
                }
            }
        }
        if (status == 200 && contentLength > 0L) {
            return new long[] { 0L, contentLength };
        }
        return null;
    }

    private static void reportStreamChunkProgress(
        long sessionId,
        long segStartMs,
        long segEndMs,
        long rangeStart,
        long totalBytes,
        long totalSentBytes,
        long expectedStreamLength,
        boolean finished
    ) {
        if (sessionId <= 0L) return;
        if (segEndMs > 0L && segEndMs >= segStartMs) {
            long reportedEndMs = segEndMs;
            if (!finished && expectedStreamLength > 0L && totalSentBytes >= 0L) {
                double frac = Math.min(1.0, totalSentBytes / (double) expectedStreamLength);
                reportedEndMs = segStartMs + Math.round((segEndMs - segStartMs) * frac);
            }
            if (reportedEndMs > segStartMs || finished) {
                notifyHlsTimeBuffered(sessionId, segStartMs, reportedEndMs);
            }
            return;
        }
        if (totalBytes > 0L && rangeStart >= 0L && totalSentBytes > 0L) {
            notifyByteRangeBuffered(sessionId, rangeStart, rangeStart + totalSentBytes, totalBytes);
        }
    }

    private static String rewriteM3u8Playlist(String manifest, String baseManifestUrl, String referer, long sessionId) {
        String[] lines = manifest.split("\\r?\\n");
        StringBuilder sb = new StringBuilder();
        double cumulativeSec = 0.0;
        double pendingSegmentSec = -1.0;
        for (int i = 0; i < lines.length; i++) {
            String line = lines[i];
            String trimmed = line.trim();
            if (trimmed.isEmpty()) {
                sb.append(line);
            } else if (trimmed.startsWith("#")) {
                Matcher extInf = EXTINF_DURATION_PATTERN.matcher(trimmed);
                if (extInf.find()) {
                    try {
                        double durSec = Double.parseDouble(extInf.group(1));
                        if (durSec > 0.0) {
                            pendingSegmentSec = durSec;
                        }
                    } catch (NumberFormatException ignored) {
                    }
                }
                Matcher m = URI_ATTR_PATTERN.matcher(line);
                StringBuffer replaced = new StringBuffer();
                while (m.find()) {
                    String rawUri = m.group(1);
                    String replacement = m.group(0);
                    try {
                        String abs = new URL(new URL(baseManifestUrl), rawUri).toString();
                        if (isSafeHttpUrl(abs)) {
                            URL absUrl = new URL(abs);
                            String host = absUrl.getHost();
                            boolean isNestedPlaylist = M3U8_EXT_PATTERN.matcher(abs).find();
                            if (!isNestedPlaylist
                                && host != null
                                && DIRECT_HOSTS_PATTERN.matcher(host).find()
                                && !isDisguisedSegmentUrl(absUrl)) {
                                replacement = "URI=\"" + abs + "\"";
                            } else {
                                replacement = "URI=\"" + buildProxyUrl(abs, referer, false, isNestedPlaylist, sessionId, -1L, -1L) + "\"";
                            }
                        }
                    } catch (Exception ignored) {
                    }
                    m.appendReplacement(replaced, Matcher.quoteReplacement(replacement));
                }
                m.appendTail(replaced);
                sb.append(replaced);
            } else {
                try {
                    String abs = new URL(new URL(baseManifestUrl), trimmed).toString();
                    if (isSafeHttpUrl(abs)) {
                        URL absUrl = new URL(abs);
                        String host = absUrl.getHost();
                        boolean isNestedPlaylist = M3U8_EXT_PATTERN.matcher(abs).find();
                        long segStartMs = -1L;
                        long segEndMs = -1L;
                        if (!isNestedPlaylist && pendingSegmentSec > 0.0) {
                            segStartMs = Math.round(cumulativeSec * 1000.0);
                            cumulativeSec += pendingSegmentSec;
                            segEndMs = Math.round(cumulativeSec * 1000.0);
                            pendingSegmentSec = -1.0;
                        }
                        if (!isNestedPlaylist
                            && host != null
                            && DIRECT_HOSTS_PATTERN.matcher(host).find()
                            && !isDisguisedSegmentUrl(absUrl)) {
                            sb.append(abs);
                        } else {
                            sb.append(buildProxyUrl(abs, referer, !isNestedPlaylist, isNestedPlaylist, sessionId, segStartMs, segEndMs));
                        }
                    } else {
                        sb.append(line);
                    }
                } catch (Exception e) {
                    sb.append(line);
                }
            }
            if (i < lines.length - 1) sb.append('\n');
        }
        return sb.toString();
    }

    private static String buildProxyUrl(
        String absUrl,
        String referer,
        boolean isHlsSegment,
        boolean isPlaylistUrl,
        long sessionId,
        long segStartMs,
        long segEndMs
    ) {
        try {
            String pathSuffix = isPlaylistUrl
                ? "/stream-proxy/playlist.m3u8"
                : (isHlsSegment ? "/stream-proxy/segment.ts" : "/stream-proxy");
            StringBuilder url = new StringBuilder();
            url.append("http://127.0.0.1:").append(sharedProxyPort).append(pathSuffix)
                .append("?url=").append(URLEncoder.encode(absUrl, "UTF-8"))
                .append("&referer=").append(URLEncoder.encode(referer, "UTF-8"));
            if (isHlsSegment) {
                url.append("&hls_seg=1");
            }
            if (sessionId > 0L) {
                url.append("&sid=").append(sessionId);
            }
            if (isHlsSegment && segStartMs >= 0L && segEndMs > segStartMs) {
                url.append("&seg_start_ms=").append(segStartMs)
                    .append("&seg_end_ms=").append(segEndMs);
            }
            return url.toString();
        } catch (Exception e) {
            return absUrl;
        }
    }

    private static boolean isDisguisedSegmentUrl(URL url) {
        if (url == null) return false;
        String path = url.getPath();
        return path != null && DISGUISED_SEGMENT_PATH_PATTERN.matcher(path).find();
    }

    private static boolean isDisguisedContentType(String contentType) {
        return contentType != null && DISGUISED_CONTENT_TYPE_PATTERN.matcher(contentType.trim()).find();
    }

    private static boolean isStartAtZeroRange(String rangeHeader) {
        if (rangeHeader == null || rangeHeader.trim().isEmpty()) return true;
        return ZERO_RANGE_PATTERN.matcher(rangeHeader.trim()).matches();
    }

    private static int readUpTo(InputStream in, byte[] buf) throws IOException {
        int total = 0;
        while (total < buf.length) {
            int n = in.read(buf, total, buf.length - total);
            if (n == -1) break;
            total += n;
        }
        return total;
    }

    private static boolean looksLikeM3u8Manifest(byte[] buf, int len) {
        int i = 0;
        if (len >= 3
            && (buf[0] & 0xFF) == 0xEF
            && (buf[1] & 0xFF) == 0xBB
            && (buf[2] & 0xFF) == 0xBF) {
            i = 3;
        }
        while (i < len && (buf[i] == ' ' || buf[i] == '\t' || buf[i] == '\r' || buf[i] == '\n')) {
            i++;
        }
        if (len - i < 7) return false;
        return buf[i] == '#'
            && buf[i + 1] == 'E'
            && buf[i + 2] == 'X'
            && buf[i + 3] == 'T'
            && buf[i + 4] == 'M'
            && buf[i + 5] == '3'
            && buf[i + 6] == 'U';
    }

    private static boolean isValidTsPacketHeader(byte[] buf, int pos) {
        if ((buf[pos] & 0xFF) != MPEG_TS_SYNC_BYTE) return false;
        // transport_error_indicator must be 0
        if ((buf[pos + 1] & 0x80) != 0) return false;
        // adaptation_field_control must be non-zero (01, 10, or 11)
        return (buf[pos + 3] & 0x30) != 0;
    }

    private static boolean isValidMpegTsStart(
        byte[] buf,
        int len,
        int offset,
        boolean reachedEof,
        boolean relaxedMinPackets
    ) {
        if (offset < 0 || offset >= len) return false;
        int remaining = len - offset;
        if (remaining >= MPEG_TS_PACKET_SIZE * 5) {
            for (int k = 0; k < 5; k++) {
                if (!isValidTsPacketHeader(buf, offset + k * MPEG_TS_PACKET_SIZE)) {
                    return false;
                }
            }
            return true;
        }
        if (reachedEof) {
            if (remaining < MPEG_TS_PACKET_SIZE * 2 || (remaining % MPEG_TS_PACKET_SIZE) != 0) {
                return false;
            }
            int packetCount = remaining / MPEG_TS_PACKET_SIZE;
            for (int k = 0; k < packetCount; k++) {
                if (!isValidTsPacketHeader(buf, offset + k * MPEG_TS_PACKET_SIZE)) {
                    return false;
                }
            }
            return true;
        }
        int requiredPackets = relaxedMinPackets ? 3 : 4;
        if (remaining >= MPEG_TS_PACKET_SIZE * requiredPackets) {
            for (int k = 0; k < requiredPackets; k++) {
                if (!isValidTsPacketHeader(buf, offset + k * MPEG_TS_PACKET_SIZE)) {
                    return false;
                }
            }
            return true;
        }
        return false;
    }

    private static int findPngEndOffset(byte[] buf, int len) {
        if (len < 16) return -1;
        if ((buf[0] & 0xFF) != 0x89
            || buf[1] != 'P'
            || buf[2] != 'N'
            || buf[3] != 'G'
            || buf[4] != 0x0D
            || buf[5] != 0x0A
            || buf[6] != 0x1A
            || buf[7] != 0x0A) {
            return -1;
        }
        for (int i = 8; i + 8 <= len; i++) {
            if (buf[i] == 'I'
                && buf[i + 1] == 'E'
                && buf[i + 2] == 'N'
                && buf[i + 3] == 'D') {
                return i + 8;
            }
        }
        return -1;
    }

    private static int findMpegTsSyncOffset(byte[] buf, int len, boolean reachedEof) {
        if (len < MPEG_TS_PACKET_SIZE * 2) return -1;
        if (isValidMpegTsStart(buf, len, 0, reachedEof, true)) {
            return 0;
        }
        int pngEnd = findPngEndOffset(buf, len);
        if (pngEnd > 0 && isValidMpegTsStart(buf, len, pngEnd, reachedEof, true)) {
            return pngEnd;
        }
        int maxOffset = len - MPEG_TS_PACKET_SIZE * 2;
        for (int i = 1; i <= maxOffset; i++) {
            if ((buf[i] & 0xFF) != MPEG_TS_SYNC_BYTE) continue;
            if (isValidMpegTsStart(buf, len, i, reachedEof, false)) {
                return i;
            }
        }
        return -1;
    }

    private static String adjustContentRangeForStrip(String contentRange, int stripBytes) {
        if (contentRange == null || stripBytes <= 0) return null;
        Matcher m = CONTENT_RANGE_PATTERN.matcher(contentRange.trim());
        if (!m.matches()) return null;
        try {
            long start = Long.parseLong(m.group(1));
            long end = Long.parseLong(m.group(2));
            if (start != 0L || end < stripBytes) return null;
            long newEnd = end - stripBytes;
            String totalStr = m.group(3);
            if ("*".equals(totalStr)) {
                return "bytes 0-" + newEnd + "/*";
            }
            long total = Long.parseLong(totalStr);
            if (total <= stripBytes) return null;
            return "bytes 0-" + newEnd + "/" + (total - stripBytes);
        } catch (NumberFormatException ignored) {
            return null;
        }
    }

    private static boolean isSafeHttpUrl(String rawUrl) {
        if (rawUrl == null || rawUrl.trim().isEmpty()) return false;
        try {
            URI uri = URI.create(rawUrl.trim());
            String scheme = uri.getScheme() != null ? uri.getScheme().toLowerCase(Locale.ROOT) : "";
            if (!"http".equals(scheme) && !"https".equals(scheme)) return false;
            String host = uri.getHost() != null ? uri.getHost().toLowerCase(Locale.ROOT) : "";
            if (host.isEmpty()) return false;
            return !host.equals("localhost") && !host.equals("127.0.0.1") && !host.equals("::1");
        } catch (Exception e) {
            return false;
        }
    }

    private static Map<String, String> parseQuery(String target) {
        Map<String, String> map = new HashMap<>();
        int qIdx = target.indexOf('?');
        if (qIdx < 0 || qIdx + 1 >= target.length()) return map;
        String qs = target.substring(qIdx + 1);
        for (String pair : qs.split("&")) {
            int eq = pair.indexOf('=');
            if (eq > 0) {
                try {
                    String k = URLDecoder.decode(pair.substring(0, eq), "UTF-8");
                    String v = URLDecoder.decode(pair.substring(eq + 1), "UTF-8");
                    map.put(k, v);
                } catch (Exception ignored) {
                }
            }
        }
        return map;
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        int b;
        while ((b = in.read()) != -1) {
            if (b == '\n') break;
            if (b != '\r') buf.write(b);
        }
        if (b == -1 && buf.size() == 0) return null;
        return buf.toString(StandardCharsets.UTF_8.name());
    }

    private static String readStreamAsString(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) != -1) {
            out.write(buf, 0, n);
        }
        return out.toString(StandardCharsets.UTF_8.name());
    }

    private static void writeCorsHeaders(
        OutputStream out,
        int status,
        String statusText,
        String contentType,
        long contentLength,
        String contentRange,
        String acceptRanges,
        boolean isDownload
    ) throws IOException {
        StringBuilder sb = new StringBuilder();
        sb.append("HTTP/1.1 ").append(status).append(' ').append(statusText).append("\r\n");
        sb.append("Access-Control-Allow-Origin: *\r\n");
        sb.append("Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n");
        sb.append("Access-Control-Allow-Headers: Range, Content-Type, Accept\r\n");
        sb.append("Connection: close\r\n");
        if (contentType != null && !contentType.isEmpty()) {
            sb.append("Content-Type: ").append(contentType).append("\r\n");
        }
        if (contentLength >= 0) {
            sb.append("Content-Length: ").append(contentLength).append("\r\n");
        }
        if (contentRange != null && !contentRange.isEmpty()) {
            sb.append("Content-Range: ").append(contentRange).append("\r\n");
        }
        if (acceptRanges != null && !acceptRanges.isEmpty()) {
            sb.append("Accept-Ranges: ").append(acceptRanges).append("\r\n");
        }
        if (isDownload) {
            sb.append("Content-Disposition: attachment\r\n");
        }
        sb.append("\r\n");
        out.write(sb.toString().getBytes(StandardCharsets.US_ASCII));
    }

    private static void writeSimpleResponse(OutputStream out, int status, String reason, String body) throws IOException {
        byte[] payload = body.getBytes(StandardCharsets.UTF_8);
        writeCorsHeaders(out, status, reason, "text/plain; charset=utf-8", payload.length, null, null, false);
        out.write(payload);
        out.flush();
    }
}
