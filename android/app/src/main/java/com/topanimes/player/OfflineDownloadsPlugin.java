package com.topanimes.player;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.SystemClock;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.PendingIntentCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

@CapacitorPlugin(name = "OfflineDownloads")
public class OfflineDownloadsPlugin extends Plugin {
    private static final String TAG = "TopAnimesOfflineDL";
    private static final String CHANNEL_OFFLINE_DOWNLOADS_ID = "anisync_offline_downloads";
    private static final int NOTIFICATION_ID_BASE = 5200;
    private static final int TS_PROBE_BUFFER_SIZE = 32768;
    private static final int MP4_MAX_ATTEMPTS = 4;
    private static final int SEGMENT_MAX_ATTEMPTS = 3;
    private static final int JAVA_MP4_PARALLEL_CHUNKS = 8;
    private static final int JAVA_HLS_PARALLEL_THREADS = 12;
    private static final int DEFAULT_MAX_CONCURRENT_DOWNLOADS = 1;
    private static final int MAX_CONCURRENT_DOWNLOADS_CAP = 5;
    private static final Pattern ARIA2_PERCENT_PATTERN = Pattern.compile("\\((\\d{1,3})%\\)");
    private static final Pattern ARIA2_SPEED_PATTERN = Pattern.compile("DL:([0-9.]+)(KiB|MiB|GiB|B)", Pattern.CASE_INSENSITIVE);
    private static final Pattern SAFE_ID_PATTERN = Pattern.compile("^[a-zA-Z0-9_-]{4,64}$");
    private static final Pattern URI_ATTR_PATTERN = Pattern.compile("URI=\"([^\"]+)\"", Pattern.CASE_INSENSITIVE);
    private static final Pattern BANDWIDTH_ATTR_PATTERN = Pattern.compile("BANDWIDTH=(\\d+)", Pattern.CASE_INSENSITIVE);
    private static final Pattern RESOLUTION_ATTR_PATTERN = Pattern.compile("RESOLUTION=\\d+x(\\d+)", Pattern.CASE_INSENSITIVE);
    private static final Pattern CONTENT_RANGE_TOTAL_PATTERN = Pattern.compile(
        "^bytes\\s+\\d+-\\d+/(\\d+)$",
        Pattern.CASE_INSENSITIVE
    );

    public static final class OfflineSubtitleInfo {
        public final String label;
        public final String url;
        public final String fileName;
        public final boolean isDefault;

        public OfflineSubtitleInfo(String label, String url, String fileName, boolean isDefault) {
            this.label = label;
            this.url = url;
            this.fileName = fileName;
            this.isDefault = isDefault;
        }
    }

    public static final class OfflinePlaybackInfo {
        public final String id;
        public final String episodeUrl;
        public final String title;
        public final String seriesTitle;
        public final String seriesUrl;
        public final String poster;
        public final String playbackUrl;
        public final String format;
        public final String qualityLabel;
        public final List<OfflineSubtitleInfo> subtitles;

        public OfflinePlaybackInfo(
            String id,
            String episodeUrl,
            String title,
            String seriesTitle,
            String seriesUrl,
            String poster,
            String playbackUrl,
            String format,
            String qualityLabel,
            List<OfflineSubtitleInfo> subtitles
        ) {
            this.id = id;
            this.episodeUrl = episodeUrl;
            this.title = title;
            this.seriesTitle = seriesTitle;
            this.seriesUrl = seriesUrl;
            this.poster = poster;
            this.playbackUrl = playbackUrl;
            this.format = format;
            this.qualityLabel = qualityLabel;
            this.subtitles = subtitles;
        }
    }

    private static final class ActiveDownloadTask {
        final String id;
        final AtomicBoolean cancelled = new AtomicBoolean(false);
        volatile HttpURLConnection activeConnection = null;
        final Set<HttpURLConnection> activeConnections = Collections.newSetFromMap(new ConcurrentHashMap<>());
        volatile Process activeProcess = null;
        volatile String activeYtDlpProcessId = null;

        ActiveDownloadTask(String id) {
            this.id = id;
        }

        void registerConnection(HttpURLConnection conn) {
            if (conn != null) {
                activeConnection = conn;
                activeConnections.add(conn);
            }
        }

        void unregisterConnection(HttpURLConnection conn) {
            if (conn != null) {
                activeConnections.remove(conn);
                if (activeConnection == conn) {
                    activeConnection = null;
                }
            }
        }

        void cancel() {
            cancelled.set(true);
            Process proc = activeProcess;
            if (proc != null) {
                try {
                    proc.destroyForcibly();
                } catch (Exception ignored) {
                }
            }
            String ytId = activeYtDlpProcessId;
            if (ytId != null && !ytId.isEmpty()) {
                DownloadEngineManager.destroyYtDlpProcess(ytId);
            }
            HttpURLConnection conn = activeConnection;
            if (conn != null) {
                try {
                    conn.disconnect();
                } catch (Exception ignored) {
                }
            }
            for (HttpURLConnection c : activeConnections) {
                try {
                    c.disconnect();
                } catch (Exception ignored) {
                }
            }
            activeConnections.clear();
        }
    }

    private static final class SubtitleRequest {
        final String label;
        final String url;
        final boolean isDefault;

        SubtitleRequest(String label, String url, boolean isDefault) {
            this.label = label;
            this.url = url;
            this.isDefault = isDefault;
        }
    }

    private static final class DownloadRequest {
        final String id;
        final String episodeUrl;
        final String canonicalUrl;
        final String streamUrl;
        final String format;
        final String referer;
        final String title;
        final String seriesTitle;
        final String seriesUrl;
        final String episodeLabel;
        final String poster;
        final String qualityLabel;
        final String serverLabel;
        final boolean isMovie;
        final int seasonNumber;
        final int episodeNumber;
        final String prevUrl;
        final String nextUrl;
        final List<SubtitleRequest> subtitles;

        DownloadRequest(
            String id,
            String episodeUrl,
            String canonicalUrl,
            String streamUrl,
            String format,
            String referer,
            String title,
            String seriesTitle,
            String seriesUrl,
            String episodeLabel,
            String poster,
            String qualityLabel,
            String serverLabel,
            boolean isMovie,
            int seasonNumber,
            int episodeNumber,
            String prevUrl,
            String nextUrl,
            List<SubtitleRequest> subtitles
        ) {
            this.id = id;
            this.episodeUrl = episodeUrl;
            this.canonicalUrl = canonicalUrl;
            this.streamUrl = streamUrl;
            this.format = format;
            this.referer = referer;
            this.title = title;
            this.seriesTitle = seriesTitle;
            this.seriesUrl = seriesUrl;
            this.episodeLabel = episodeLabel;
            this.poster = poster;
            this.qualityLabel = qualityLabel;
            this.serverLabel = serverLabel;
            this.isMovie = isMovie;
            this.seasonNumber = seasonNumber;
            this.episodeNumber = episodeNumber;
            this.prevUrl = prevUrl;
            this.nextUrl = nextUrl;
            this.subtitles = subtitles;
        }
    }

    private static final class DownloadOutcome {
        final String mediaFile;
        final String format;
        final long bytesWritten;

        DownloadOutcome(String mediaFile, String format, long bytesWritten) {
            this.mediaFile = mediaFile;
            this.format = format;
            this.bytesWritten = bytesWritten;
        }
    }

    private static final class ProgressEmitter {
        private final OfflineDownloadsPlugin plugin;
        private final Context ctx;
        private final DownloadRequest req;
        private long lastEventMs = 0L;
        private long lastNotifyMs = 0L;
        private int lastEventPercent = -1;
        private long lastSampleMs = 0L;
        private long lastSampleBytes = 0L;
        private long smoothedSpeedBps = 0L;

        ProgressEmitter(OfflineDownloadsPlugin plugin, Context ctx, DownloadRequest req) {
            this.plugin = plugin;
            this.ctx = ctx;
            this.req = req;
        }

        synchronized void emit(
            int percent,
            long downloadedBytes,
            long totalBytes,
            int completedSegments,
            int totalSegments,
            boolean force
        ) {
            emitWithMeta(percent, downloadedBytes, totalBytes, completedSegments, totalSegments, -1L, "", force);
        }

        synchronized void emitWithMeta(
            int percent,
            long downloadedBytes,
            long totalBytes,
            int completedSegments,
            int totalSegments,
            long explicitSpeedBps,
            String engine,
            boolean force
        ) {
            int clamped = Math.max(0, Math.min(99, percent));
            long now = SystemClock.elapsedRealtime();

            long speedBps = explicitSpeedBps;
            if (speedBps < 0L) {
                if (lastSampleMs > 0L && now > lastSampleMs + 250L && downloadedBytes >= lastSampleBytes) {
                    long deltaBytes = downloadedBytes - lastSampleBytes;
                    long deltaMs = now - lastSampleMs;
                    long instant = (deltaBytes * 1000L) / deltaMs;
                    smoothedSpeedBps = smoothedSpeedBps > 0L
                        ? ((smoothedSpeedBps * 2L + instant) / 3L)
                        : instant;
                    lastSampleMs = now;
                    lastSampleBytes = downloadedBytes;
                } else if (lastSampleMs == 0L) {
                    lastSampleMs = now;
                    lastSampleBytes = downloadedBytes;
                }
                speedBps = smoothedSpeedBps;
            } else {
                smoothedSpeedBps = speedBps;
                lastSampleMs = now;
                lastSampleBytes = downloadedBytes;
            }

            if (force || now - lastEventMs >= 350L || Math.abs(clamped - lastEventPercent) >= 2) {
                lastEventMs = now;
                lastEventPercent = clamped;
                JSObject payload = new JSObject();
                payload.put("id", req.id);
                payload.put("episodeUrl", req.episodeUrl);
                payload.put("status", "downloading");
                payload.put("progress", clamped);
                payload.put("downloadedBytes", downloadedBytes);
                payload.put("totalBytes", totalBytes);
                payload.put("completedSegments", completedSegments);
                payload.put("totalSegments", totalSegments);
                if (speedBps > 0L) {
                    payload.put("speedBytesPerSec", speedBps);
                }
                if (engine != null && !engine.isEmpty()) {
                    payload.put("engine", engine);
                }
                plugin.emitProgressEvent(payload);
            }
            if (force || now - lastNotifyMs >= 900L) {
                lastNotifyMs = now;
                postDownloadNotification(ctx, req, clamped, downloadedBytes, totalBytes, speedBps, false);
            }
        }
    }

    // Configurable FIFO worker pool: defaults to 1 active download at a time so aria2c dedicates
    // 100% of bandwidth to each episode, and can be raised up to 5 simultaneous downloads from Settings.
    private final Object poolResizeLock = new Object();
    private volatile int maxConcurrentDownloads = DEFAULT_MAX_CONCURRENT_DOWNLOADS;
    private final ThreadPoolExecutor downloadExecutor = createDownloadExecutor();
    private final ExecutorService ioExecutor = Executors.newSingleThreadExecutor();
    private final ConcurrentHashMap<String, ActiveDownloadTask> activeTasks = new ConcurrentHashMap<>();

    private static ThreadPoolExecutor createDownloadExecutor() {
        ThreadPoolExecutor exec = new ThreadPoolExecutor(
            DEFAULT_MAX_CONCURRENT_DOWNLOADS,
            DEFAULT_MAX_CONCURRENT_DOWNLOADS,
            60L,
            TimeUnit.SECONDS,
            new LinkedBlockingQueue<>()
        );
        exec.allowCoreThreadTimeOut(true);
        return exec;
    }

    private int applyMaxConcurrentDownloads(int requested) {
        int clamped = Math.max(DEFAULT_MAX_CONCURRENT_DOWNLOADS, Math.min(MAX_CONCURRENT_DOWNLOADS_CAP, requested));
        synchronized (poolResizeLock) {
            if (clamped > maxConcurrentDownloads) {
                downloadExecutor.setMaximumPoolSize(clamped);
                downloadExecutor.setCorePoolSize(clamped);
                downloadExecutor.prestartAllCoreThreads();
            } else if (clamped < maxConcurrentDownloads) {
                downloadExecutor.setCorePoolSize(clamped);
                downloadExecutor.setMaximumPoolSize(clamped);
            }
            maxConcurrentDownloads = clamped;
        }
        return clamped;
    }

    @PluginMethod
    public void setMaxConcurrentDownloads(PluginCall call) {
        Integer raw = call.getInt("limit", DEFAULT_MAX_CONCURRENT_DOWNLOADS);
        int applied = applyMaxConcurrentDownloads(raw != null ? raw : DEFAULT_MAX_CONCURRENT_DOWNLOADS);
        JSObject ret = new JSObject();
        ret.put("limit", applied);
        call.resolve(ret);
    }

    @Override
    public void load() {
        super.load();
        Context ctx = getContext();
        if (ctx != null) {
            Context appCtx = ctx.getApplicationContext();
            LocalProxyPlugin.getOfflineMediaRootDir(appCtx);
            ensureDownloadChannel(appCtx);
            ioExecutor.execute(() -> DownloadEngineManager.syncYtDlpIfDue(appCtx));
        }
    }

    @Override
    protected void handleOnDestroy() {
        for (ActiveDownloadTask task : activeTasks.values()) {
            task.cancel();
        }
        activeTasks.clear();
        downloadExecutor.shutdownNow();
        ioExecutor.shutdownNow();
        super.handleOnDestroy();
    }

    public static String canonicalEpisodeKey(String rawUrl) {
        if (rawUrl == null) return "";
        String trimmed = rawUrl.trim();
        if (trimmed.isEmpty()) return "";
        int hashIdx = trimmed.indexOf('#');
        if (hashIdx >= 0) {
            trimmed = trimmed.substring(0, hashIdx);
        }
        String lower = trimmed.toLowerCase(Locale.ROOT);
        if (lower.startsWith("anisync://")) {
            while (lower.endsWith("/")) {
                lower = lower.substring(0, lower.length() - 1);
            }
            return lower;
        }
        while (trimmed.endsWith("/") && trimmed.length() > 1) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        return trimmed.toLowerCase(Locale.ROOT);
    }

    public static OfflinePlaybackInfo findCompletedDownloadForEpisodeUrl(Context ctx, String rawEpisodeUrl) {
        if (ctx == null || rawEpisodeUrl == null || rawEpisodeUrl.trim().isEmpty()) {
            return null;
        }
        String targetKey = canonicalEpisodeKey(rawEpisodeUrl);
        if (targetKey.isEmpty()) return null;

        File root = LocalProxyPlugin.getOfflineMediaRootDir(ctx);
        if (root == null || !root.isDirectory()) return null;
        File[] children = root.listFiles();
        if (children == null) return null;

        for (File itemDir : children) {
            if (!itemDir.isDirectory()) continue;
            File metaFile = new File(itemDir, "meta.json");
            if (!metaFile.isFile()) continue;
            try {
                JSONObject meta = readJsonObject(metaFile);
                if (meta == null) continue;
                if (!"completed".equals(meta.optString("status", ""))) continue;
                String storedCanonical = meta.optString("canonicalUrl", "");
                String storedEpisodeUrl = meta.optString("episodeUrl", "");
                if (!targetKey.equals(canonicalEpisodeKey(storedCanonical))
                    && !targetKey.equals(canonicalEpisodeKey(storedEpisodeUrl))) {
                    continue;
                }
                String id = meta.optString("id", itemDir.getName());
                String mediaFile = meta.optString("mediaFile", "");
                if (mediaFile.isEmpty() || !new File(itemDir, mediaFile).isFile()) {
                    continue;
                }
                LocalProxyPlugin.ensureSharedProxyBaseUrl();
                String playbackUrl = LocalProxyPlugin.buildOfflineMediaUrl(id, mediaFile);
                if (playbackUrl.isEmpty()) continue;

                List<OfflineSubtitleInfo> subs = new ArrayList<>();
                JSONArray subsArr = meta.optJSONArray("subtitles");
                if (subsArr != null) {
                    for (int i = 0; i < subsArr.length(); i++) {
                        JSONObject subObj = subsArr.optJSONObject(i);
                        if (subObj == null) continue;
                        String subFile = subObj.optString("fileName", "");
                        if (subFile.isEmpty() || !new File(itemDir, subFile).isFile()) continue;
                        String subUrl = LocalProxyPlugin.buildOfflineMediaUrl(id, subFile);
                        if (subUrl.isEmpty()) continue;
                        subs.add(new OfflineSubtitleInfo(
                            subObj.optString("label", "Legenda " + (i + 1)),
                            subUrl,
                            subFile,
                            subObj.optBoolean("isDefault", i == 0)
                        ));
                    }
                }
                return new OfflinePlaybackInfo(
                    id,
                    storedEpisodeUrl.isEmpty() ? rawEpisodeUrl.trim() : storedEpisodeUrl,
                    meta.optString("title", "Episódio offline"),
                    meta.optString("seriesTitle", ""),
                    meta.optString("seriesUrl", ""),
                    meta.optString("poster", ""),
                    playbackUrl,
                    meta.optString("format", "mp4"),
                    meta.optString("qualityLabel", "Offline"),
                    subs
                );
            } catch (Exception ignored) {
            }
        }
        return null;
    }

    @PluginMethod
    public void startDownload(PluginCall call) {
        String id = call.getString("id", "").trim();
        String episodeUrl = call.getString("episodeUrl", "").trim();
        String streamUrl = call.getString("streamUrl", "").trim();
        if (!SAFE_ID_PATTERN.matcher(id).matches()) {
            call.reject("ID de download inválido.");
            return;
        }
        if (episodeUrl.isEmpty() || !LocalProxyPlugin.isSafeHttpUrl(streamUrl)) {
            call.reject("URL de vídeo inválida para download.");
            return;
        }

        Context appCtx = getContext() != null ? getContext().getApplicationContext() : null;
        if (appCtx == null) {
            call.reject("Contexto Android indisponível.");
            return;
        }

        String refererRaw = call.getString("referer", "https://topanimes.net/");
        String referer = LocalProxyPlugin.isSafeHttpUrl(refererRaw) ? refererRaw : "https://topanimes.net/";
        String format = call.getString("format", "unknown");
        String canonicalUrl = call.getString("canonicalUrl", canonicalEpisodeKey(episodeUrl));
        String title = call.getString("title", "Episódio");
        String seriesTitle = call.getString("seriesTitle", "");
        String seriesUrl = call.getString("seriesUrl", "");
        String episodeLabel = call.getString("episodeLabel", "");
        String poster = call.getString("poster", "");
        String qualityLabel = call.getString("qualityLabel", "");
        String serverLabel = call.getString("serverLabel", "");
        boolean isMovie = Boolean.TRUE.equals(call.getBoolean("isMovie", false));
        Integer seasonNumObj = call.getInt("seasonNumber");
        Integer epNumObj = call.getInt("episodeNumber");
        int seasonNumber = seasonNumObj != null ? seasonNumObj : 0;
        int episodeNumber = epNumObj != null ? epNumObj : 0;
        String prevUrl = call.getString("prevUrl", "");
        String nextUrl = call.getString("nextUrl", "");

        List<SubtitleRequest> subRequests = new ArrayList<>();
        JSArray subsArr = call.getArray("subtitles");
        if (subsArr != null) {
            for (int i = 0; i < subsArr.length(); i++) {
                JSONObject item = subsArr.optJSONObject(i);
                if (item == null) continue;
                String subUrl = item.optString("url", "").trim();
                if (!LocalProxyPlugin.isSafeHttpUrl(subUrl)) continue;
                subRequests.add(new SubtitleRequest(
                    item.optString("label", "Legenda " + (i + 1)),
                    subUrl,
                    item.optBoolean("isDefault", i == 0)
                ));
            }
        }

        DownloadRequest req = new DownloadRequest(
            id,
            episodeUrl,
            canonicalUrl != null && !canonicalUrl.isEmpty() ? canonicalUrl : canonicalEpisodeKey(episodeUrl),
            streamUrl,
            format != null ? format : "unknown",
            referer,
            title != null && !title.isEmpty() ? title : "Episódio",
            seriesTitle != null ? seriesTitle : "",
            seriesUrl != null ? seriesUrl : "",
            episodeLabel != null ? episodeLabel : "",
            poster != null ? poster : "",
            qualityLabel != null ? qualityLabel : "",
            serverLabel != null ? serverLabel : "",
            isMovie,
            seasonNumber,
            episodeNumber,
            prevUrl != null ? prevUrl : "",
            nextUrl != null ? nextUrl : "",
            subRequests
        );

        ActiveDownloadTask previous = activeTasks.remove(id);
        if (previous != null) {
            previous.cancel();
        }
        ActiveDownloadTask task = new ActiveDownloadTask(id);
        activeTasks.put(id, task);

        LocalProxyPlugin.getOfflineMediaRootDir(appCtx);
        LocalProxyPlugin.ensureSharedProxyBaseUrl();
        ensureDownloadChannel(appCtx);

        JSObject immediate = new JSObject();
        immediate.put("started", true);
        immediate.put("id", id);
        call.resolve(immediate);

        downloadExecutor.execute(() -> runDownloadTask(appCtx, req, task));
    }

    @PluginMethod
    public void cancelDownload(PluginCall call) {
        String id = call.getString("id", "").trim();
        if (!SAFE_ID_PATTERN.matcher(id).matches()) {
            JSObject ret = new JSObject();
            ret.put("cancelled", false);
            call.resolve(ret);
            return;
        }
        ActiveDownloadTask task = activeTasks.remove(id);
        if (task != null) {
            task.cancel();
        }
        Context appCtx = getContext() != null ? getContext().getApplicationContext() : null;
        if (appCtx != null) {
            cancelDownloadNotification(appCtx, id);
            ioExecutor.execute(() -> {
                File root = LocalProxyPlugin.getOfflineMediaRootDir(appCtx);
                if (root != null) {
                    deleteRecursively(new File(root, id));
                }
            });
        }
        JSObject cancelledEvt = new JSObject();
        cancelledEvt.put("id", id);
        cancelledEvt.put("status", "cancelled");
        emitProgressEvent(cancelledEvt);

        JSObject ret = new JSObject();
        ret.put("cancelled", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void deleteDownload(PluginCall call) {
        String id = call.getString("id", "").trim();
        if (!SAFE_ID_PATTERN.matcher(id).matches()) {
            JSObject ret = new JSObject();
            ret.put("deleted", false);
            call.resolve(ret);
            return;
        }
        ActiveDownloadTask task = activeTasks.remove(id);
        if (task != null) {
            task.cancel();
        }
        Context appCtx = getContext() != null ? getContext().getApplicationContext() : null;
        ioExecutor.execute(() -> {
            if (appCtx != null) {
                cancelDownloadNotification(appCtx, id);
                File root = LocalProxyPlugin.getOfflineMediaRootDir(appCtx);
                if (root != null) {
                    deleteRecursively(new File(root, id));
                }
            }
            JSObject ret = new JSObject();
            ret.put("deleted", true);
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void deleteAllDownloads(PluginCall call) {
        for (ActiveDownloadTask task : activeTasks.values()) {
            task.cancel();
        }
        activeTasks.clear();
        Context appCtx = getContext() != null ? getContext().getApplicationContext() : null;
        ioExecutor.execute(() -> {
            if (appCtx != null) {
                File root = LocalProxyPlugin.getOfflineMediaRootDir(appCtx);
                if (root != null && root.isDirectory()) {
                    File[] children = root.listFiles();
                    if (children != null) {
                        for (File child : children) {
                            cancelDownloadNotification(appCtx, child.getName());
                            deleteRecursively(child);
                        }
                    }
                }
            }
            JSObject ret = new JSObject();
            ret.put("deleted", true);
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void listDownloads(PluginCall call) {
        Context appCtx = getContext() != null ? getContext().getApplicationContext() : null;
        ioExecutor.execute(() -> {
            JSArray list = new JSArray();
            long totalBytes = 0L;
            if (appCtx != null) {
                LocalProxyPlugin.ensureSharedProxyBaseUrl();
                File root = LocalProxyPlugin.getOfflineMediaRootDir(appCtx);
                if (root != null && root.isDirectory()) {
                    File[] children = root.listFiles();
                    if (children != null) {
                        Arrays.sort(children, Comparator.comparingLong(File::lastModified).reversed());
                        for (File itemDir : children) {
                            if (!itemDir.isDirectory()) continue;
                            File metaFile = new File(itemDir, "meta.json");
                            if (!metaFile.isFile()) {
                                if (!activeTasks.containsKey(itemDir.getName())) {
                                    deleteRecursively(itemDir);
                                }
                                continue;
                            }
                            JSONObject meta = readJsonObject(metaFile);
                            if (meta == null) {
                                if (!activeTasks.containsKey(itemDir.getName())) {
                                    deleteRecursively(itemDir);
                                }
                                continue;
                            }
                            String status = meta.optString("status", "");
                            String id = meta.optString("id", itemDir.getName());
                            if (!"completed".equals(status)) {
                                if (!activeTasks.containsKey(id)) {
                                    deleteRecursively(itemDir);
                                }
                                continue;
                            }
                            String mediaFile = meta.optString("mediaFile", "");
                            if (mediaFile.isEmpty() || !new File(itemDir, mediaFile).isFile()) {
                                deleteRecursively(itemDir);
                                continue;
                            }
                            JSObject record = buildClientRecord(itemDir, meta);
                            if (record != null) {
                                totalBytes += meta.optLong("sizeBytes", 0L);
                                list.put(record);
                            }
                        }
                    }
                }
            }
            JSObject ret = new JSObject();
            ret.put("downloads", list);
            ret.put("totalBytes", totalBytes);
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void getPlaybackSource(PluginCall call) {
        String id = call.getString("id", "").trim();
        String episodeUrl = call.getString("episodeUrl", "").trim();
        Context appCtx = getContext() != null ? getContext().getApplicationContext() : null;
        ioExecutor.execute(() -> {
            JSObject ret = new JSObject();
            ret.put("available", false);
            if (appCtx == null) {
                call.resolve(ret);
                return;
            }
            LocalProxyPlugin.ensureSharedProxyBaseUrl();
            File root = LocalProxyPlugin.getOfflineMediaRootDir(appCtx);
            if (root == null || !root.isDirectory()) {
                call.resolve(ret);
                return;
            }

            File matchedDir = null;
            JSONObject matchedMeta = null;

            if (SAFE_ID_PATTERN.matcher(id).matches()) {
                File candidateDir = new File(root, id);
                File metaFile = new File(candidateDir, "meta.json");
                if (metaFile.isFile()) {
                    JSONObject meta = readJsonObject(metaFile);
                    if (meta != null && "completed".equals(meta.optString("status", ""))) {
                        String mf = meta.optString("mediaFile", "");
                        if (!mf.isEmpty() && new File(candidateDir, mf).isFile()) {
                            matchedDir = candidateDir;
                            matchedMeta = meta;
                        }
                    }
                }
            }

            if (matchedDir == null && !episodeUrl.isEmpty()) {
                String targetKey = canonicalEpisodeKey(episodeUrl);
                File[] children = root.listFiles();
                if (children != null) {
                    for (File child : children) {
                        if (!child.isDirectory()) continue;
                        File metaFile = new File(child, "meta.json");
                        if (!metaFile.isFile()) continue;
                        JSONObject meta = readJsonObject(metaFile);
                        if (meta == null || !"completed".equals(meta.optString("status", ""))) continue;
                        if (targetKey.equals(canonicalEpisodeKey(meta.optString("canonicalUrl", "")))
                            || targetKey.equals(canonicalEpisodeKey(meta.optString("episodeUrl", "")))) {
                            String mf = meta.optString("mediaFile", "");
                            if (!mf.isEmpty() && new File(child, mf).isFile()) {
                                matchedDir = child;
                                matchedMeta = meta;
                                break;
                            }
                        }
                    }
                }
            }

            if (matchedDir != null && matchedMeta != null) {
                JSObject record = buildClientRecord(matchedDir, matchedMeta);
                if (record != null) {
                    ret.put("available", true);
                    ret.put("playbackUrl", record.optString("playbackUrl", ""));
                    ret.put("format", record.optString("format", "mp4"));
                    ret.put("record", record);
                }
            }
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void getEngineInfo(PluginCall call) {
        Context appCtx = getContext() != null ? getContext().getApplicationContext() : null;
        ioExecutor.execute(() -> {
            DownloadEngineManager.EngineInfo info = DownloadEngineManager.getEngineInfo(appCtx);
            JSObject ret = new JSObject();
            ret.put("aria2Available", info.aria2Available);
            ret.put("aria2Version", info.aria2Version);
            ret.put("ytdlpAvailable", info.ytdlpAvailable);
            ret.put("ytdlpVersion", info.ytdlpVersion);
            ret.put("maxConnectionsPerServer", info.maxConnectionsPerServer);
            ret.put("maxSplits", info.maxSplits);
            ret.put("maxConcurrentSegments", info.maxConcurrentSegments);
            ret.put("aria2Repo", DownloadEngineManager.ARIA2_REPO_URL);
            ret.put("ytdlpRepo", DownloadEngineManager.YTDLP_REPO_URL);
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void updateYtDlp(PluginCall call) {
        Context appCtx = getContext() != null ? getContext().getApplicationContext() : null;
        if (appCtx == null) {
            call.reject("Contexto Android indisponível.");
            return;
        }
        ioExecutor.execute(() -> {
            try {
                DownloadEngineManager.YtDlpUpdateResult res =
                    DownloadEngineManager.updateYtDlpStable(appCtx, true);
                JSObject ret = new JSObject();
                ret.put("updated", res.updated);
                ret.put("previousVersion", res.previousVersion);
                ret.put("currentVersion", res.currentVersion);
                ret.put("message", res.message);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : "Falha ao atualizar yt-dlp.");
            }
        });
    }

    @PluginMethod
    public void resolveEmbedWithYtDlp(PluginCall call) {
        String embedUrl = call.getString("embedUrl", "").trim();
        String referer = call.getString("referer", "https://topanimes.net/").trim();
        Context appCtx = getContext() != null ? getContext().getApplicationContext() : null;
        if (appCtx == null || !LocalProxyPlugin.isSafeHttpUrl(embedUrl)) {
            JSObject fail = new JSObject();
            fail.put("ok", false);
            fail.put("errorMessage", "URL de embed inválida.");
            call.resolve(fail);
            return;
        }
        ioExecutor.execute(() -> {
            DownloadEngineManager.YtDlpExtractedMedia media =
                DownloadEngineManager.extractStreamsWithYtDlp(appCtx, embedUrl, referer);
            JSObject ret = new JSObject();
            ret.put("ok", media.ok);
            ret.put("referer", media.referer);
            ret.put("title", media.title);
            ret.put("errorMessage", media.errorMessage);
            JSArray streamsArr = new JSArray();
            for (DownloadEngineManager.ExtractedStream s : media.streams) {
                JSObject o = new JSObject();
                o.put("label", s.label);
                o.put("height", s.height);
                o.put("url", s.url);
                o.put("format", s.format);
                streamsArr.put(o);
            }
            ret.put("streams", streamsArr);
            JSArray subsArr = new JSArray();
            for (DownloadEngineManager.ExtractedSubtitle sub : media.subtitles) {
                JSObject o = new JSObject();
                o.put("label", sub.label);
                o.put("url", sub.url);
                o.put("isDefault", sub.isDefault);
                subsArr.put(o);
            }
            ret.put("subtitles", subsArr);
            call.resolve(ret);
        });
    }

    private void runDownloadTask(Context ctx, DownloadRequest req, ActiveDownloadTask task) {
        File root = LocalProxyPlugin.getOfflineMediaRootDir(ctx);
        if (root == null) {
            emitError(req, "Armazenamento local indisponível.");
            activeTasks.remove(req.id, task);
            return;
        }
        File itemDir = new File(root, req.id);
        if (!itemDir.exists() && !itemDir.mkdirs()) {
            emitError(req, "Não foi possível criar a pasta de download.");
            activeTasks.remove(req.id, task);
            return;
        }

        ProgressEmitter progress = new ProgressEmitter(this, ctx, req);
        try {
            writeMetaFile(itemDir, buildMetaJson(req, "downloading", "", req.format, 0L, new JSONArray()));
            progress.emit(0, 0L, 0L, 0, 0, true);

            boolean likelyHls = "hls".equalsIgnoreCase(req.format)
                || req.streamUrl.toLowerCase(Locale.ROOT).contains(".m3u8");

            DownloadOutcome outcome;
            if (likelyHls) {
                outcome = downloadHlsStream(ctx, itemDir, req, task, progress);
            } else {
                outcome = downloadMp4OrAutoHls(ctx, itemDir, req, task, progress);
            }

            if (task.cancelled.get()) {
                throw new CancellationException("Download cancelado.");
            }

            JSONArray savedSubtitles = downloadSubtitlesBestEffort(itemDir, req, task);
            if (task.cancelled.get()) {
                throw new CancellationException("Download cancelado.");
            }

            long totalSizeBytes = computeDirSizeBytes(itemDir, "meta.json");
            if (totalSizeBytes <= 0L) {
                totalSizeBytes = outcome.bytesWritten;
            }

            JSONObject completedMeta = buildMetaJson(
                req,
                "completed",
                outcome.mediaFile,
                outcome.format,
                totalSizeBytes,
                savedSubtitles
            );
            writeMetaFile(itemDir, completedMeta);

            LocalProxyPlugin.ensureSharedProxyBaseUrl();
            JSObject record = buildClientRecord(itemDir, completedMeta);
            JSObject doneEvt = new JSObject();
            doneEvt.put("id", req.id);
            doneEvt.put("episodeUrl", req.episodeUrl);
            doneEvt.put("status", "completed");
            doneEvt.put("progress", 100);
            doneEvt.put("downloadedBytes", totalSizeBytes);
            doneEvt.put("totalBytes", totalSizeBytes);
            doneEvt.put("sizeBytes", totalSizeBytes);
            if (record != null) {
                doneEvt.put("playbackUrl", record.optString("playbackUrl", ""));
                doneEvt.put("format", record.optString("format", "mp4"));
                doneEvt.put("mediaFile", outcome.mediaFile);
                doneEvt.put("record", record);
            }
            emitProgressEvent(doneEvt);
            postDownloadNotification(ctx, req, 100, totalSizeBytes, totalSizeBytes, 0L, true);
        } catch (CancellationException cancelled) {
            deleteRecursively(itemDir);
            cancelDownloadNotification(ctx, req.id);
            JSObject cancelEvt = new JSObject();
            cancelEvt.put("id", req.id);
            cancelEvt.put("episodeUrl", req.episodeUrl);
            cancelEvt.put("status", "cancelled");
            emitProgressEvent(cancelEvt);
        } catch (Exception e) {
            Log.w(TAG, "Offline download failed for " + req.episodeUrl + ": " + e.getMessage(), e);
            deleteRecursively(itemDir);
            cancelDownloadNotification(ctx, req.id);
            String msg = e.getMessage();
            if (msg == null || msg.trim().isEmpty()) {
                msg = "Falha ao baixar vídeo para reprodução offline.";
            }
            emitError(req, msg);
        } finally {
            activeTasks.remove(req.id, task);
        }
    }

    private static final class StreamProbeInfo {
        final String finalUrl;
        final boolean isHls;
        final boolean acceptsRanges;
        final long totalBytes;

        StreamProbeInfo(String finalUrl, boolean isHls, boolean acceptsRanges, long totalBytes) {
            this.finalUrl = finalUrl;
            this.isHls = isHls;
            this.acceptsRanges = acceptsRanges;
            this.totalBytes = totalBytes;
        }
    }

    private StreamProbeInfo probeStreamForDownload(
        String streamUrl,
        String referer,
        ActiveDownloadTask task
    ) {
        HttpURLConnection conn = null;
        try {
            LocalProxyPlugin.RedirectResult res = LocalProxyPlugin.openWithRedirects(
                streamUrl,
                referer,
                "*/*",
                "bytes=0-4095",
                20000
            );
            conn = res.connection;
            task.registerConnection(conn);
            int status = conn.getResponseCode();
            String finalUrl = res.finalUrl != null && !res.finalUrl.isEmpty() ? res.finalUrl : streamUrl;
            if (status < 200 || status >= 300) {
                return new StreamProbeInfo(finalUrl, false, false, 0L);
            }
            String contentType = conn.getContentType();
            boolean looksHlsCt = contentType != null && (
                contentType.toLowerCase(Locale.ROOT).contains("mpegurl")
                    || contentType.toLowerCase(Locale.ROOT).contains("m3u8")
            );
            if (looksHlsCt) {
                return new StreamProbeInfo(finalUrl, true, false, 0L);
            }
            long totalBytes = resolveTotalBytes(status, conn, 0L);
            String acceptRangesHdr = conn.getHeaderField("Accept-Ranges");
            boolean acceptsRanges = status == 206
                || (acceptRangesHdr != null && acceptRangesHdr.toLowerCase(Locale.ROOT).contains("bytes"));
            try (InputStream in = conn.getInputStream()) {
                byte[] sniff = new byte[1024];
                int n = LocalProxyPlugin.readUpTo(in, sniff);
                if (n > 0 && LocalProxyPlugin.looksLikeM3u8Manifest(sniff, n)) {
                    return new StreamProbeInfo(finalUrl, true, false, 0L);
                }
            }
            return new StreamProbeInfo(finalUrl, false, acceptsRanges, totalBytes);
        } catch (Exception ignored) {
            return new StreamProbeInfo(streamUrl, false, false, 0L);
        } finally {
            task.unregisterConnection(conn);
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    private DownloadOutcome downloadMp4OrAutoHls(
        Context ctx,
        File itemDir,
        DownloadRequest req,
        ActiveDownloadTask task,
        ProgressEmitter progress
    ) throws IOException {
        StreamProbeInfo probe = probeStreamForDownload(req.streamUrl, req.referer, task);
        if (task.cancelled.get()) {
            throw new CancellationException("Download cancelado.");
        }
        if (probe.isHls) {
            return downloadHlsStream(ctx, itemDir, req, task, progress);
        }

        // 1. Primary ultra-fast engine: native aria2c (-x 16 -s 32 -k 1M, unlimited speed)
        if (DownloadEngineManager.isAria2Available(ctx)) {
            try {
                return downloadMp4WithAria2(
                    ctx,
                    itemDir,
                    probe.finalUrl,
                    req.referer,
                    probe.totalBytes,
                    task,
                    progress
                );
            } catch (CancellationException ce) {
                throw ce;
            } catch (Exception ariaErr) {
                Log.w(TAG, "aria2c MP4 download fallback to parallel Java: " + ariaErr.getMessage());
                deleteIfExists(new File(itemDir, "video.mp4"));
                deleteIfExists(new File(itemDir, "video.mp4.aria2"));
            }
        }

        // 2. Fallback #1: 8-connection parallel Java HTTP Range downloader
        IOException directError = null;
        if (probe.acceptsRanges && probe.totalBytes >= 2L * 1024L * 1024L) {
            try {
                return downloadMp4ParallelJava(
                    itemDir,
                    probe.finalUrl,
                    req.referer,
                    probe.totalBytes,
                    task,
                    progress
                );
            } catch (CancellationException ce) {
                throw ce;
            } catch (IOException parallelErr) {
                Log.w(TAG, "Parallel Java MP4 fallback to resumable stream: " + parallelErr.getMessage());
                deleteIfExists(new File(itemDir, "video.mp4.parallel.part"));
            }
        }

        // 3. Fallback #2: single-connection resumable Java stream
        try {
            return downloadMp4SingleStreamJava(ctx, itemDir, req, task, progress);
        } catch (CancellationException ce) {
            throw ce;
        } catch (IOException ioe) {
            directError = ioe;
        }

        // 4. Fallback #3: embedded yt-dlp + aria2c (for complex/expiring/embed URLs)
        if (DownloadEngineManager.isPythonRuntimeAvailable(ctx) && !task.cancelled.get()) {
            try {
                return downloadWithYtDlpFallback(ctx, itemDir, req, task, progress);
            } catch (CancellationException ce) {
                throw ce;
            } catch (Exception ytErr) {
                Log.w(TAG, "yt-dlp fallback failed: " + ytErr.getMessage());
            }
        }
        throw directError != null ? directError : new IOException("Falha ao baixar vídeo MP4.");
    }

    private DownloadOutcome downloadMp4WithAria2(
        Context ctx,
        File itemDir,
        String targetUrl,
        String referer,
        long knownTotalBytes,
        ActiveDownloadTask task,
        ProgressEmitter progress
    ) throws IOException {
        File finalFile = new File(itemDir, "video.mp4");
        File ctrlFile = new File(itemDir, "video.mp4.aria2");
        deleteIfExists(finalFile);
        deleteIfExists(ctrlFile);

        List<String> cmd = DownloadEngineManager.buildAria2SingleFileCommand(
            ctx,
            targetUrl,
            referer,
            itemDir,
            "video.mp4"
        );
        if (cmd.isEmpty()) {
            throw new IOException("Binário aria2c indisponível.");
        }

        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.directory(itemDir);
        pb.redirectErrorStream(true);
        Process proc = pb.start();
        task.activeProcess = proc;

        AtomicInteger parsedPct = new AtomicInteger(0);
        AtomicLong parsedSpeedBps = new AtomicLong(-1L);
        StringBuilder errorTail = new StringBuilder();

        Thread logReader = new Thread(() -> {
            try (BufferedReader br = new BufferedReader(
                new InputStreamReader(proc.getInputStream(), StandardCharsets.UTF_8)
            )) {
                String line;
                while ((line = br.readLine()) != null) {
                    Matcher pm = ARIA2_PERCENT_PATTERN.matcher(line);
                    if (pm.find()) {
                        try {
                            int p = Integer.parseInt(pm.group(1));
                            if (p >= 0 && p <= 100) parsedPct.set(Math.min(99, p));
                        } catch (NumberFormatException ignored) {
                        }
                    }
                    Matcher sm = ARIA2_SPEED_PATTERN.matcher(line);
                    if (sm.find()) {
                        long bps = parseAria2SpeedToBps(sm.group(1), sm.group(2));
                        if (bps >= 0L) parsedSpeedBps.set(bps);
                    }
                    if (line.contains("ERROR") || line.contains("errorCode=")) {
                        if (errorTail.length() < 600) {
                            errorTail.append(line).append('\n');
                        }
                    }
                }
            } catch (Exception ignored) {
            }
        }, "AnisyncAria2Mp4Log");
        logReader.setDaemon(true);
        logReader.start();

        try {
            while (proc.isAlive()) {
                if (task.cancelled.get()) {
                    proc.destroyForcibly();
                    throw new CancellationException("Download cancelado.");
                }
                long currentBytes = finalFile.isFile() ? finalFile.length() : 0L;
                int pct = parsedPct.get();
                if (pct <= 0 && knownTotalBytes > 0L && currentBytes > 0L) {
                    pct = (int) Math.min(99L, (currentBytes * 99L) / knownTotalBytes);
                }
                long estimatedDownloaded = currentBytes;
                if (knownTotalBytes > 0L && pct > 0 && estimatedDownloaded > knownTotalBytes) {
                    estimatedDownloaded = (knownTotalBytes * pct) / 100L;
                }
                progress.emitWithMeta(
                    pct,
                    estimatedDownloaded,
                    knownTotalBytes,
                    0,
                    0,
                    parsedSpeedBps.get(),
                    "aria2c",
                    false
                );
                sleepQuietly(350L);
            }

            int exitCode = proc.waitFor();
            try {
                logReader.join(1000L);
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
            }

            if (task.cancelled.get()) {
                throw new CancellationException("Download cancelado.");
            }
            if (exitCode != 0 || !finalFile.isFile() || finalFile.length() <= 0L) {
                throw new IOException(
                    "aria2c falhou (código " + exitCode + "): " + errorTail.toString().trim()
                );
            }
            deleteIfExists(ctrlFile);
            return new DownloadOutcome("video.mp4", "mp4", finalFile.length());
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
            proc.destroyForcibly();
            throw new CancellationException("Download interrompido.");
        } finally {
            if (task.activeProcess == proc) {
                task.activeProcess = null;
            }
            if (proc.isAlive()) {
                proc.destroyForcibly();
            }
        }
    }

    private DownloadOutcome downloadMp4ParallelJava(
        File itemDir,
        String targetUrl,
        String referer,
        long totalBytes,
        ActiveDownloadTask task,
        ProgressEmitter progress
    ) throws IOException {
        File partFile = new File(itemDir, "video.mp4.parallel.part");
        File finalFile = new File(itemDir, "video.mp4");
        deleteIfExists(partFile);

        try (RandomAccessFile initRaf = new RandomAccessFile(partFile, "rw")) {
            initRaf.setLength(totalBytes);
        }

        int workers = totalBytes >= 16L * 1024L * 1024L
            ? JAVA_MP4_PARALLEL_CHUNKS
            : Math.max(2, Math.min(4, JAVA_MP4_PARALLEL_CHUNKS));
        long chunkSize = (totalBytes + workers - 1L) / workers;
        AtomicLong downloadedAtomic = new AtomicLong(0L);
        ExecutorService pool = Executors.newFixedThreadPool(workers);
        List<Future<?>> futures = new ArrayList<>();

        try {
            for (int i = 0; i < workers; i++) {
                final long start = i * chunkSize;
                if (start >= totalBytes) break;
                final long end = Math.min(totalBytes - 1L, start + chunkSize - 1L);
                futures.add(pool.submit(() -> {
                    downloadRangeChunkWithRetries(
                        targetUrl,
                        referer,
                        partFile,
                        start,
                        end,
                        totalBytes,
                        downloadedAtomic,
                        task,
                        progress
                    );
                    return null;
                }));
            }

            for (Future<?> f : futures) {
                try {
                    f.get();
                } catch (ExecutionException ee) {
                    Throwable cause = ee.getCause();
                    if (cause instanceof CancellationException) {
                        throw (CancellationException) cause;
                    }
                    if (cause instanceof IOException) {
                        throw (IOException) cause;
                    }
                    throw new IOException(
                        cause != null && cause.getMessage() != null
                            ? cause.getMessage()
                            : "Falha em conexão paralela de download."
                    );
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    throw new CancellationException("Download cancelado.");
                }
            }
        } finally {
            pool.shutdownNow();
        }

        if (task.cancelled.get()) {
            deleteIfExists(partFile);
            throw new CancellationException("Download cancelado.");
        }
        if (finalFile.exists()) {
            //noinspection ResultOfMethodCallIgnored
            finalFile.delete();
        }
        if (!partFile.renameTo(finalFile)) {
            throw new IOException("Falha ao finalizar vídeo MP4 paralelo.");
        }
        return new DownloadOutcome("video.mp4", "mp4", finalFile.length());
    }

    private void downloadRangeChunkWithRetries(
        String url,
        String referer,
        File partFile,
        long startByte,
        long endByte,
        long totalBytes,
        AtomicLong downloadedAtomic,
        ActiveDownloadTask task,
        ProgressEmitter progress
    ) throws IOException {
        long cursor = startByte;
        IOException lastErr = null;
        for (int attempt = 1; attempt <= MP4_MAX_ATTEMPTS; attempt++) {
            if (task.cancelled.get()) {
                throw new CancellationException("Download cancelado.");
            }
            HttpURLConnection conn = null;
            try {
                LocalProxyPlugin.RedirectResult res = LocalProxyPlugin.openWithRedirects(
                    url,
                    referer,
                    "*/*",
                    "bytes=" + cursor + "-" + endByte,
                    30000
                );
                conn = res.connection;
                task.registerConnection(conn);
                int status = conn.getResponseCode();
                if (status != 206) {
                    throw new IOException("Servidor não retornou HTTP 206 para download paralelo (HTTP " + status + ").");
                }
                try (InputStream in = conn.getInputStream();
                     RandomAccessFile raf = new RandomAccessFile(partFile, "rw")) {
                    raf.seek(cursor);
                    byte[] buf = new byte[65536];
                    int n;
                    while (cursor <= endByte && (n = in.read(buf)) != -1) {
                        if (task.cancelled.get()) {
                            throw new CancellationException("Download cancelado.");
                        }
                        int toWrite = (int) Math.min(n, (endByte - cursor) + 1L);
                        raf.write(buf, 0, toWrite);
                        cursor += toWrite;
                        long done = downloadedAtomic.addAndGet(toWrite);
                        int pct = totalBytes > 0L
                            ? (int) Math.min(99L, (done * 99L) / totalBytes)
                            : 0;
                        progress.emitWithMeta(pct, done, totalBytes, 0, 0, -1L, "native-parallel", false);
                    }
                }
                if (cursor > endByte) {
                    return;
                }
                throw new IOException("Trecho interrompido antes do fim.");
            } catch (CancellationException ce) {
                throw ce;
            } catch (IOException ioe) {
                lastErr = ioe;
                if (attempt < MP4_MAX_ATTEMPTS && !task.cancelled.get()) {
                    sleepQuietly(attempt * 800L);
                    continue;
                }
                throw ioe;
            } finally {
                task.unregisterConnection(conn);
                if (conn != null) conn.disconnect();
            }
        }
        throw lastErr != null ? lastErr : new IOException("Falha ao baixar trecho MP4.");
    }

    private DownloadOutcome downloadWithYtDlpFallback(
        Context ctx,
        File itemDir,
        DownloadRequest req,
        ActiveDownloadTask task,
        ProgressEmitter progress
    ) throws Exception {
        File outFile = new File(itemDir, "video.mp4");
        deleteIfExists(outFile);
        String procId = "ytdlp_" + req.id + "_" + SystemClock.elapsedRealtime();
        task.activeYtDlpProcessId = procId;
        try {
            File saved = DownloadEngineManager.downloadWithYtDlpAndAria2(
                ctx,
                req.streamUrl,
                req.referer,
                outFile,
                procId,
                (float pct, long etaSeconds, String line) -> {
                    int clamped = Math.max(0, Math.min(99, Math.round(pct)));
                    long curBytes = outFile.isFile() ? outFile.length() : 0L;
                    progress.emitWithMeta(clamped, curBytes, 0L, 0, 0, -1L, "yt-dlp+aria2c", false);
                }
            );
            return new DownloadOutcome("video.mp4", "mp4", saved.length());
        } finally {
            task.activeYtDlpProcessId = null;
        }
    }

    private DownloadOutcome downloadMp4SingleStreamJava(
        Context ctx,
        File itemDir,
        DownloadRequest req,
        ActiveDownloadTask task,
        ProgressEmitter progress
    ) throws IOException {
        File finalFile = new File(itemDir, "video.mp4");
        File partFile = new File(itemDir, "video.mp4.part");
        IOException lastError = null;

        for (int attempt = 1; attempt <= MP4_MAX_ATTEMPTS; attempt++) {
            if (task.cancelled.get()) {
                throw new CancellationException("Download cancelado.");
            }
            long existingBytes = partFile.exists() ? partFile.length() : 0L;
            String rangeHeader = existingBytes > 0L ? ("bytes=" + existingBytes + "-") : null;
            HttpURLConnection conn = null;
            try {
                LocalProxyPlugin.RedirectResult res = LocalProxyPlugin.openWithRedirects(
                    req.streamUrl,
                    req.referer,
                    "*/*",
                    rangeHeader,
                    30000
                );
                conn = res.connection;
                task.registerConnection(conn);

                int status = conn.getResponseCode();
                if (status == 416 && existingBytes > 0L) {
                    //noinspection ResultOfMethodCallIgnored
                    partFile.delete();
                    continue;
                }
                if (status < 200 || status >= 300) {
                    throw new IOException("Servidor retornou HTTP " + status + " ao baixar vídeo.");
                }

                String contentType = conn.getContentType();
                boolean looksHlsCt = contentType != null && (
                    contentType.toLowerCase(Locale.ROOT).contains("mpegurl")
                        || contentType.toLowerCase(Locale.ROOT).contains("m3u8")
                );
                if (looksHlsCt) {
                    conn.disconnect();
                    task.unregisterConnection(conn);
                    //noinspection ResultOfMethodCallIgnored
                    partFile.delete();
                    return downloadHlsStream(ctx, itemDir, req, task, progress);
                }

                boolean append = status == 206 && existingBytes > 0L;
                if (!append) {
                    existingBytes = 0L;
                }

                long totalBytes = resolveTotalBytes(status, conn, existingBytes);
                long downloaded = existingBytes;

                try (InputStream in = conn.getInputStream()) {
                    byte[] firstBuf = new byte[8192];
                    int firstRead = in.read(firstBuf);
                    if (firstRead == -1) {
                        if (existingBytes > 0L && (totalBytes <= 0L || existingBytes >= totalBytes)) {
                            if (finalFile.exists()) {
                                //noinspection ResultOfMethodCallIgnored
                                finalFile.delete();
                            }
                            if (!partFile.renameTo(finalFile)) {
                                throw new IOException("Falha ao finalizar arquivo de vídeo.");
                            }
                            return new DownloadOutcome("video.mp4", "mp4", existingBytes);
                        }
                        throw new IOException("Resposta de vídeo vazia.");
                    }

                    if (!append && LocalProxyPlugin.looksLikeM3u8Manifest(firstBuf, firstRead)) {
                        conn.disconnect();
                        task.unregisterConnection(conn);
                        //noinspection ResultOfMethodCallIgnored
                        partFile.delete();
                        return downloadHlsStream(ctx, itemDir, req, task, progress);
                    }

                    try (FileOutputStream fos = new FileOutputStream(partFile, append)) {
                        fos.write(firstBuf, 0, firstRead);
                        downloaded += firstRead;
                        int pct = totalBytes > 0L
                            ? (int) Math.min(99L, (downloaded * 99L) / totalBytes)
                            : 0;
                        progress.emit(pct, downloaded, totalBytes, 0, 0, false);

                        byte[] buf = new byte[65536];
                        int n;
                        while ((n = in.read(buf)) != -1) {
                            if (task.cancelled.get()) {
                                throw new CancellationException("Download cancelado.");
                            }
                            fos.write(buf, 0, n);
                            downloaded += n;
                            int nextPct = totalBytes > 0L
                                ? (int) Math.min(99L, (downloaded * 99L) / totalBytes)
                                : 0;
                            progress.emit(nextPct, downloaded, totalBytes, 0, 0, false);
                        }
                        fos.flush();
                    }
                }

                if (totalBytes > 0L && downloaded < totalBytes) {
                    throw new IOException("Conexão interrompida antes de concluir o vídeo.");
                }
                if (downloaded <= 0L) {
                    throw new IOException("Nenhum dado de vídeo recebido.");
                }
                if (finalFile.exists()) {
                    //noinspection ResultOfMethodCallIgnored
                    finalFile.delete();
                }
                if (!partFile.renameTo(finalFile)) {
                    throw new IOException("Falha ao salvar o arquivo de vídeo final.");
                }
                return new DownloadOutcome("video.mp4", "mp4", downloaded);
            } catch (CancellationException ce) {
                throw ce;
            } catch (IOException ioe) {
                lastError = ioe;
                if (attempt < MP4_MAX_ATTEMPTS && !task.cancelled.get()) {
                    sleepQuietly(attempt * 1000L);
                    continue;
                }
                throw ioe;
            } finally {
                task.unregisterConnection(conn);
                if (conn != null) {
                    conn.disconnect();
                }
            }
        }
        throw lastError != null ? lastError : new IOException("Falha ao baixar vídeo MP4.");
    }

    private static final class HlsAssetItem {
        final String url;
        final String fileName;
        final boolean stripDisguisedTs;
        final boolean isSegment;

        HlsAssetItem(String url, String fileName, boolean stripDisguisedTs, boolean isSegment) {
            this.url = url;
            this.fileName = fileName;
            this.stripDisguisedTs = stripDisguisedTs;
            this.isSegment = isSegment;
        }
    }

    private DownloadOutcome downloadHlsStream(
        Context ctx,
        File itemDir,
        DownloadRequest req,
        ActiveDownloadTask task,
        ProgressEmitter progress
    ) throws IOException {
        String manifestUrl = req.streamUrl;
        String manifestBody = null;
        String finalManifestUrl = manifestUrl;

        for (int depth = 0; depth < 3; depth++) {
            if (task.cancelled.get()) {
                throw new CancellationException("Download cancelado.");
            }
            HttpURLConnection conn = null;
            try {
                LocalProxyPlugin.RedirectResult res = LocalProxyPlugin.openWithRedirects(
                    manifestUrl,
                    req.referer,
                    "*/*",
                    null,
                    25000
                );
                conn = res.connection;
                task.registerConnection(conn);
                int status = conn.getResponseCode();
                if (status < 200 || status >= 300) {
                    throw new IOException("Playlist HLS retornou HTTP " + status + ".");
                }
                finalManifestUrl = res.finalUrl;
                manifestBody = LocalProxyPlugin.readStreamAsString(conn.getInputStream());
            } finally {
                task.unregisterConnection(conn);
                if (conn != null) {
                    conn.disconnect();
                }
            }

            if (manifestBody == null || !manifestBody.contains("#EXTM3U")) {
                throw new IOException("Manifesto HLS inválido.");
            }

            String bestVariant = pickHighestBandwidthVariantUrl(manifestBody, finalManifestUrl);
            if (bestVariant != null && !bestVariant.isEmpty()) {
                manifestUrl = bestVariant;
                continue;
            }
            break;
        }

        if (manifestBody == null || !manifestBody.contains("#EXTM3U")) {
            throw new IOException("Não foi possível ler os segmentos do vídeo HLS.");
        }

        String[] lines = manifestBody.split("\\r?\\n");
        boolean hasInitMap = manifestBody.contains("#EXT-X-MAP:");

        Map<String, String> keyFileMap = new HashMap<>();
        Map<String, String> mapFileMap = new HashMap<>();
        List<HlsAssetItem> assets = new ArrayList<>();
        StringBuilder rewritten = new StringBuilder(manifestBody.length());
        int segmentIndex = 0;
        int keyIndex = 0;
        int mapIndex = 0;

        for (int i = 0; i < lines.length; i++) {
            String line = lines[i];
            String trimmed = line.trim();
            if (trimmed.isEmpty()) {
                rewritten.append('\n');
                continue;
            }

            if (trimmed.startsWith("#")) {
                boolean isKeyTag = trimmed.toUpperCase(Locale.ROOT).startsWith("#EXT-X-KEY:");
                boolean isMapTag = trimmed.toUpperCase(Locale.ROOT).startsWith("#EXT-X-MAP:");
                if ((isKeyTag && !trimmed.toUpperCase(Locale.ROOT).contains("METHOD=NONE")) || isMapTag) {
                    Matcher m = URI_ATTR_PATTERN.matcher(line);
                    StringBuffer sb = new StringBuffer();
                    while (m.find()) {
                        String rawUri = m.group(1);
                        String absUrl = resolveAbsoluteUrl(finalManifestUrl, rawUri);
                        if (absUrl != null && LocalProxyPlugin.isSafeHttpUrl(absUrl)) {
                            String localName;
                            if (isKeyTag) {
                                localName = keyFileMap.get(absUrl);
                                if (localName == null) {
                                    localName = "key_" + (keyIndex++) + ".bin";
                                    keyFileMap.put(absUrl, localName);
                                    assets.add(new HlsAssetItem(absUrl, localName, false, false));
                                }
                            } else {
                                localName = mapFileMap.get(absUrl);
                                if (localName == null) {
                                    localName = "init_" + (mapIndex++) + ".mp4";
                                    mapFileMap.put(absUrl, localName);
                                    assets.add(new HlsAssetItem(absUrl, localName, false, false));
                                }
                            }
                            m.appendReplacement(sb, Matcher.quoteReplacement("URI=\"" + localName + "\""));
                        } else {
                            m.appendReplacement(sb, Matcher.quoteReplacement(m.group(0)));
                        }
                    }
                    m.appendTail(sb);
                    rewritten.append(sb).append('\n');
                } else {
                    rewritten.append(line).append('\n');
                }
                continue;
            }

            String segAbsUrl = resolveAbsoluteUrl(finalManifestUrl, trimmed);
            if (segAbsUrl == null || !LocalProxyPlugin.isSafeHttpUrl(segAbsUrl)) {
                throw new IOException("Segmento HLS com URL inválida.");
            }

            String segLower = segAbsUrl.toLowerCase(Locale.ROOT);
            boolean isFmp4Seg = hasInitMap || segLower.contains(".m4s") || segLower.contains(".mp4");
            String segExt = isFmp4Seg ? ".m4s" : ".ts";
            String segFileName = String.format(Locale.US, "seg_%05d%s", segmentIndex, segExt);
            assets.add(new HlsAssetItem(segAbsUrl, segFileName, !isFmp4Seg, true));
            segmentIndex++;
            rewritten.append(segFileName).append('\n');
        }

        final int totalSegments = segmentIndex;
        if (totalSegments == 0) {
            throw new IOException("Playlist HLS não contém segmentos reproduzíveis.");
        }

        progress.emitWithMeta(1, 0L, 0L, 0, totalSegments, -1L, DownloadEngineManager.isAria2Available(ctx) ? "aria2c" : "native-parallel", true);

        boolean downloadedByAria2 = false;
        if (DownloadEngineManager.isAria2Available(ctx)) {
            try {
                downloadHlsBatchWithAria2(ctx, itemDir, req.referer, assets, totalSegments, task, progress);
                downloadedByAria2 = true;
            } catch (CancellationException ce) {
                throw ce;
            } catch (Exception ariaErr) {
                Log.w(TAG, "aria2c HLS batch fallback to parallel Java pool: " + ariaErr.getMessage());
            }
        }

        if (!downloadedByAria2) {
            downloadHlsAssetsParallelJava(itemDir, req.referer, assets, totalSegments, task, progress);
        } else {
            // Retry any single segment that aria2c skipped and unmask disguised PNG/JPEG TS headers in-place
            List<HlsAssetItem> missing = new ArrayList<>();
            for (HlsAssetItem item : assets) {
                File f = new File(itemDir, item.fileName);
                File ctrl = new File(itemDir, item.fileName + ".aria2");
                if (!f.isFile() || f.length() <= 0L || ctrl.exists()) {
                    deleteIfExists(ctrl);
                    missing.add(item);
                }
            }
            if (!missing.isEmpty()) {
                downloadHlsAssetsParallelJava(itemDir, req.referer, missing, totalSegments, task, progress);
            }
            for (HlsAssetItem item : assets) {
                if (task.cancelled.get()) {
                    throw new CancellationException("Download cancelado.");
                }
                if (item.stripDisguisedTs) {
                    stripDisguisedTsHeaderInPlaceIfNeeded(new File(itemDir, item.fileName));
                }
            }
        }

        long totalBytesWritten = 0L;
        for (HlsAssetItem item : assets) {
            File f = new File(itemDir, item.fileName);
            if (!f.isFile() || f.length() <= 0L) {
                throw new IOException("Segmento HLS incompleto: " + item.fileName);
            }
            totalBytesWritten += f.length();
        }

        File playlistFile = new File(itemDir, "playlist.m3u8");
        File playlistTmp = new File(itemDir, "playlist.m3u8.tmp");
        try (FileOutputStream fos = new FileOutputStream(playlistTmp)) {
            fos.write(rewritten.toString().getBytes(StandardCharsets.UTF_8));
            fos.flush();
        }
        if (playlistFile.exists()) {
            //noinspection ResultOfMethodCallIgnored
            playlistFile.delete();
        }
        if (!playlistTmp.renameTo(playlistFile)) {
            throw new IOException("Falha ao gravar playlist offline.");
        }

        return new DownloadOutcome("playlist.m3u8", "hls", totalBytesWritten);
    }

    private void downloadHlsBatchWithAria2(
        Context ctx,
        File itemDir,
        String referer,
        List<HlsAssetItem> assets,
        int totalSegments,
        ActiveDownloadTask task,
        ProgressEmitter progress
    ) throws IOException {
        File inputFile = new File(itemDir, "aria2_segments.txt");
        try (FileOutputStream fos = new FileOutputStream(inputFile, false)) {
            StringBuilder sb = new StringBuilder(assets.size() * 128);
            for (HlsAssetItem item : assets) {
                sb.append(item.url).append('\n');
                sb.append("  out=").append(item.fileName).append('\n');
                if (referer != null && !referer.isEmpty()) {
                    sb.append("  referer=").append(referer).append('\n');
                }
            }
            fos.write(sb.toString().getBytes(StandardCharsets.UTF_8));
            fos.flush();
        }

        List<String> cmd = DownloadEngineManager.buildAria2BatchInputCommand(ctx, inputFile, itemDir);
        if (cmd.isEmpty()) {
            deleteIfExists(inputFile);
            throw new IOException("Binário aria2c indisponível.");
        }

        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.directory(itemDir);
        pb.redirectErrorStream(true);
        Process proc = pb.start();
        task.activeProcess = proc;

        AtomicLong parsedSpeedBps = new AtomicLong(-1L);
        Thread logReader = new Thread(() -> {
            try (BufferedReader br = new BufferedReader(
                new InputStreamReader(proc.getInputStream(), StandardCharsets.UTF_8)
            )) {
                String line;
                while ((line = br.readLine()) != null) {
                    Matcher sm = ARIA2_SPEED_PATTERN.matcher(line);
                    if (sm.find()) {
                        long bps = parseAria2SpeedToBps(sm.group(1), sm.group(2));
                        if (bps >= 0L) parsedSpeedBps.set(bps);
                    }
                }
            } catch (Exception ignored) {
            }
        }, "AnisyncAria2HlsLog");
        logReader.setDaemon(true);
        logReader.start();

        try {
            while (proc.isAlive()) {
                if (task.cancelled.get()) {
                    proc.destroyForcibly();
                    throw new CancellationException("Download cancelado.");
                }
                int completedSegs = 0;
                long bytesNow = 0L;
                for (HlsAssetItem item : assets) {
                    File f = new File(itemDir, item.fileName);
                    if (!f.isFile()) continue;
                    long len = f.length();
                    bytesNow += len;
                    if (item.isSegment && len > 0L && !new File(itemDir, item.fileName + ".aria2").exists()) {
                        completedSegs++;
                    }
                }
                int pct = totalSegments > 0
                    ? (int) Math.min(99L, Math.max(1L, Math.round((completedSegs * 99.0) / totalSegments)))
                    : 1;
                long estTotal = completedSegs > 0 ? (bytesNow * totalSegments) / completedSegs : 0L;
                progress.emitWithMeta(
                    pct,
                    bytesNow,
                    estTotal,
                    completedSegs,
                    totalSegments,
                    parsedSpeedBps.get(),
                    "aria2c",
                    false
                );
                sleepQuietly(350L);
            }

            int exitCode = proc.waitFor();
            try {
                logReader.join(1000L);
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
            }
            if (task.cancelled.get()) {
                throw new CancellationException("Download cancelado.");
            }
            if (exitCode != 0) {
                Log.w(TAG, "aria2c HLS batch exited with code " + exitCode + ", checking completed segments");
            }
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
            proc.destroyForcibly();
            throw new CancellationException("Download interrompido.");
        } finally {
            if (task.activeProcess == proc) {
                task.activeProcess = null;
            }
            if (proc.isAlive()) {
                proc.destroyForcibly();
            }
            deleteIfExists(inputFile);
        }
    }

    private void downloadHlsAssetsParallelJava(
        File itemDir,
        String referer,
        List<HlsAssetItem> assets,
        int totalSegments,
        ActiveDownloadTask task,
        ProgressEmitter progress
    ) throws IOException {
        int threads = Math.max(2, Math.min(JAVA_HLS_PARALLEL_THREADS, assets.size()));
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        AtomicInteger completedSegments = new AtomicInteger(0);
        AtomicLong bytesWritten = new AtomicLong(0L);
        List<Future<?>> futures = new ArrayList<>();

        try {
            for (HlsAssetItem item : assets) {
                futures.add(pool.submit(() -> {
                    if (task.cancelled.get()) {
                        throw new CancellationException("Download cancelado.");
                    }
                    long written = downloadBinaryAssetWithRetries(
                        item.url,
                        referer,
                        new File(itemDir, item.fileName),
                        item.stripDisguisedTs,
                        task
                    );
                    long totalBytesNow = bytesWritten.addAndGet(written);
                    if (item.isSegment) {
                        int doneSegs = completedSegments.incrementAndGet();
                        int pct = (int) Math.min(99L, Math.round((doneSegs * 99.0) / Math.max(1, totalSegments)));
                        long estTotal = doneSegs > 0 ? (totalBytesNow * totalSegments) / doneSegs : 0L;
                        progress.emitWithMeta(
                            pct,
                            totalBytesNow,
                            estTotal,
                            doneSegs,
                            totalSegments,
                            -1L,
                            "native-parallel",
                            false
                        );
                    }
                    return null;
                }));
            }

            for (Future<?> f : futures) {
                try {
                    f.get();
                } catch (ExecutionException ee) {
                    Throwable cause = ee.getCause();
                    if (cause instanceof CancellationException) {
                        throw (CancellationException) cause;
                    }
                    if (cause instanceof IOException) {
                        throw (IOException) cause;
                    }
                    throw new IOException(
                        cause != null && cause.getMessage() != null
                            ? cause.getMessage()
                            : "Falha ao baixar segmento HLS."
                    );
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    throw new CancellationException("Download cancelado.");
                }
            }
        } finally {
            pool.shutdownNow();
        }
    }

    private static void stripDisguisedTsHeaderInPlaceIfNeeded(File segFile) throws IOException {
        if (segFile == null || !segFile.isFile() || segFile.length() < 188L) return;
        byte[] probeBuf = new byte[TS_PROBE_BUFFER_SIZE];
        int probeLen;
        try (FileInputStream fis = new FileInputStream(segFile)) {
            probeLen = LocalProxyPlugin.readUpTo(fis, probeBuf);
        }
        if (probeLen <= 0 || (probeBuf[0] & 0xFF) == 0x47) {
            return;
        }
        boolean reachedEof = probeLen >= segFile.length();
        int tsOffset = LocalProxyPlugin.findMpegTsSyncOffset(probeBuf, probeLen, reachedEof);
        if (tsOffset <= 0) return;

        File tmp = new File(segFile.getParentFile(), segFile.getName() + ".unmask.tmp");
        try (FileInputStream fis = new FileInputStream(segFile);
             FileOutputStream fos = new FileOutputStream(tmp, false)) {
            long skipped = 0L;
            while (skipped < tsOffset) {
                long s = fis.skip(tsOffset - skipped);
                if (s <= 0L) break;
                skipped += s;
            }
            byte[] buf = new byte[65536];
            int n;
            while ((n = fis.read(buf)) != -1) {
                fos.write(buf, 0, n);
            }
            fos.flush();
        }
        if (tmp.length() > 0L) {
            if (segFile.exists()) {
                //noinspection ResultOfMethodCallIgnored
                segFile.delete();
            }
            if (!tmp.renameTo(segFile)) {
                deleteIfExists(tmp);
            }
        } else {
            deleteIfExists(tmp);
        }
    }

    private static long parseAria2SpeedToBps(String numRaw, String unitRaw) {
        try {
            double val = Double.parseDouble(numRaw);
            String u = unitRaw.toLowerCase(Locale.ROOT);
            if ("gib".equals(u)) return Math.round(val * 1024.0 * 1024.0 * 1024.0);
            if ("mib".equals(u)) return Math.round(val * 1024.0 * 1024.0);
            if ("kib".equals(u)) return Math.round(val * 1024.0);
            return Math.round(val);
        } catch (Exception ignored) {
            return -1L;
        }
    }

    private static void deleteIfExists(File f) {
        if (f != null && f.exists()) {
            //noinspection ResultOfMethodCallIgnored
            f.delete();
        }
    }

    private long downloadBinaryAssetWithRetries(
        String url,
        String referer,
        File targetFile,
        boolean stripDisguisedTsHeader,
        ActiveDownloadTask task
    ) throws IOException {
        if (targetFile.isFile() && targetFile.length() > 0L) {
            return targetFile.length();
        }
        File partFile = new File(targetFile.getParentFile(), targetFile.getName() + ".part");
        IOException lastErr = null;
        for (int attempt = 1; attempt <= SEGMENT_MAX_ATTEMPTS; attempt++) {
            if (task.cancelled.get()) {
                throw new CancellationException("Download cancelado.");
            }
            HttpURLConnection conn = null;
            try {
                LocalProxyPlugin.RedirectResult res = LocalProxyPlugin.openWithRedirects(
                    url,
                    referer,
                    "*/*",
                    null,
                    25000
                );
                conn = res.connection;
                task.registerConnection(conn);
                int status = conn.getResponseCode();
                if (status < 200 || status >= 300) {
                    throw new IOException("HTTP " + status + " ao baixar segmento.");
                }
                String ct = conn.getContentType();
                long written = 0L;
                try (InputStream in = conn.getInputStream();
                     FileOutputStream fos = new FileOutputStream(partFile, false)) {
                    if (stripDisguisedTsHeader || LocalProxyPlugin.isDisguisedContentType(ct)) {
                        byte[] probeBuf = new byte[TS_PROBE_BUFFER_SIZE];
                        int probeLen = LocalProxyPlugin.readUpTo(in, probeBuf);
                        boolean reachedEof = probeLen < probeBuf.length;
                        int tsOffset = LocalProxyPlugin.findMpegTsSyncOffset(probeBuf, probeLen, reachedEof);
                        int startOff = tsOffset > 0 ? tsOffset : 0;
                        if (probeLen > startOff) {
                            int firstLen = probeLen - startOff;
                            fos.write(probeBuf, startOff, firstLen);
                            written += firstLen;
                        }
                        if (!reachedEof) {
                            byte[] buf = new byte[65536];
                            int n;
                            while ((n = in.read(buf)) != -1) {
                                if (task.cancelled.get()) {
                                    throw new CancellationException("Download cancelado.");
                                }
                                fos.write(buf, 0, n);
                                written += n;
                            }
                        }
                    } else {
                        byte[] buf = new byte[65536];
                        int n;
                        while ((n = in.read(buf)) != -1) {
                            if (task.cancelled.get()) {
                                throw new CancellationException("Download cancelado.");
                            }
                            fos.write(buf, 0, n);
                            written += n;
                        }
                    }
                    fos.flush();
                }

                if (written <= 0L) {
                    throw new IOException("Segmento vazio.");
                }
                if (targetFile.exists()) {
                    //noinspection ResultOfMethodCallIgnored
                    targetFile.delete();
                }
                if (!partFile.renameTo(targetFile)) {
                    throw new IOException("Falha ao gravar segmento offline.");
                }
                return written;
            } catch (CancellationException ce) {
                throw ce;
            } catch (IOException ioe) {
                lastErr = ioe;
                if (attempt < SEGMENT_MAX_ATTEMPTS && !task.cancelled.get()) {
                    sleepQuietly(attempt * 500L);
                    continue;
                }
                throw ioe;
            } finally {
                task.unregisterConnection(conn);
                if (conn != null) {
                    conn.disconnect();
                }
            }
        }
        throw lastErr != null ? lastErr : new IOException("Falha ao baixar segmento HLS.");
    }

    private JSONArray downloadSubtitlesBestEffort(
        File itemDir,
        DownloadRequest req,
        ActiveDownloadTask task
    ) {
        JSONArray saved = new JSONArray();
        if (req.subtitles.isEmpty()) return saved;
        int idx = 0;
        for (SubtitleRequest sub : req.subtitles) {
            if (task.cancelled.get()) break;
            HttpURLConnection conn = null;
            try {
                LocalProxyPlugin.RedirectResult res = LocalProxyPlugin.openWithRedirects(
                    sub.url,
                    req.referer,
                    "*/*",
                    null,
                    15000
                );
                conn = res.connection;
                task.registerConnection(conn);
                int status = conn.getResponseCode();
                if (status < 200 || status >= 300) continue;

                String lower = res.finalUrl.toLowerCase(Locale.ROOT);
                String ext = lower.contains(".ass") ? ".ass"
                    : lower.contains(".ssa") ? ".ssa"
                    : lower.contains(".srt") ? ".srt"
                    : ".vtt";
                String fileName = "sub_" + idx + ext;
                File subFile = new File(itemDir, fileName);
                long written = 0L;
                try (InputStream in = conn.getInputStream();
                     FileOutputStream fos = new FileOutputStream(subFile, false)) {
                    byte[] buf = new byte[16384];
                    int n;
                    while ((n = in.read(buf)) != -1) {
                        if (task.cancelled.get()) {
                            throw new CancellationException("Download cancelado.");
                        }
                        fos.write(buf, 0, n);
                        written += n;
                    }
                    fos.flush();
                }
                if (written > 0L) {
                    JSONObject obj = new JSONObject();
                    obj.put("label", sub.label);
                    obj.put("fileName", fileName);
                    obj.put("isDefault", sub.isDefault);
                    saved.put(obj);
                    idx++;
                } else {
                    //noinspection ResultOfMethodCallIgnored
                    subFile.delete();
                }
            } catch (CancellationException ce) {
                throw ce;
            } catch (Exception ignored) {
            } finally {
                task.unregisterConnection(conn);
                if (conn != null) {
                    conn.disconnect();
                }
            }
        }
        return saved;
    }

    private static String pickHighestBandwidthVariantUrl(String manifest, String baseUrl) {
        if (!manifest.contains("#EXT-X-STREAM-INF")) {
            return null;
        }
        String[] lines = manifest.split("\\r?\\n");
        long bestScore = -1L;
        String bestUrl = null;

        for (int i = 0; i < lines.length; i++) {
            String trimmed = lines[i].trim();
            if (!trimmed.toUpperCase(Locale.ROOT).startsWith("#EXT-X-STREAM-INF:")) {
                continue;
            }
            long score = 0L;
            Matcher resMatch = RESOLUTION_ATTR_PATTERN.matcher(trimmed);
            if (resMatch.find()) {
                try {
                    long height = Long.parseLong(resMatch.group(1));
                    score += height * 10000000L;
                } catch (NumberFormatException ignored) {
                }
            }
            Matcher bwMatch = BANDWIDTH_ATTR_PATTERN.matcher(trimmed);
            if (bwMatch.find()) {
                try {
                    score += Long.parseLong(bwMatch.group(1));
                } catch (NumberFormatException ignored) {
                }
            }

            for (int j = i + 1; j < lines.length; j++) {
                String candidate = lines[j].trim();
                if (candidate.isEmpty()) continue;
                if (candidate.startsWith("#")) continue;
                String abs = resolveAbsoluteUrl(baseUrl, candidate);
                if (abs != null && LocalProxyPlugin.isSafeHttpUrl(abs) && score >= bestScore) {
                    bestScore = score;
                    bestUrl = abs;
                }
                break;
            }
        }
        return bestUrl;
    }

    private static String resolveAbsoluteUrl(String baseUrl, String rawUri) {
        try {
            return new URL(new URL(baseUrl), rawUri).toString();
        } catch (Exception e) {
            return null;
        }
    }

    private static long resolveTotalBytes(int status, HttpURLConnection conn, long existingBytes) {
        String contentRange = conn.getHeaderField("Content-Range");
        if (contentRange != null && !contentRange.trim().isEmpty()) {
            Matcher m = CONTENT_RANGE_TOTAL_PATTERN.matcher(contentRange.trim());
            if (m.matches()) {
                try {
                    return Long.parseLong(m.group(1));
                } catch (NumberFormatException ignored) {
                }
            }
        }
        try {
            String cl = conn.getHeaderField("Content-Length");
            if (cl != null && !cl.trim().isEmpty()) {
                long parsed = Long.parseLong(cl.trim());
                if (parsed > 0L) {
                    return status == 206 ? (existingBytes + parsed) : parsed;
                }
            }
        } catch (NumberFormatException ignored) {
        }
        return 0L;
    }

    private static JSONObject buildMetaJson(
        DownloadRequest req,
        String status,
        String mediaFile,
        String format,
        long sizeBytes,
        JSONArray subtitles
    ) {
        JSONObject obj = new JSONObject();
        try {
            obj.put("id", req.id);
            obj.put("episodeUrl", req.episodeUrl);
            obj.put("canonicalUrl", req.canonicalUrl);
            obj.put("title", req.title);
            obj.put("seriesTitle", req.seriesTitle);
            obj.put("seriesUrl", req.seriesUrl);
            obj.put("episodeLabel", req.episodeLabel);
            obj.put("poster", req.poster);
            obj.put("qualityLabel", req.qualityLabel);
            obj.put("serverLabel", req.serverLabel);
            obj.put("isMovie", req.isMovie);
            if (req.seasonNumber > 0) obj.put("seasonNumber", req.seasonNumber);
            if (req.episodeNumber > 0) obj.put("episodeNumber", req.episodeNumber);
            if (!req.prevUrl.isEmpty()) obj.put("prevUrl", req.prevUrl);
            if (!req.nextUrl.isEmpty()) obj.put("nextUrl", req.nextUrl);
            obj.put("status", status);
            obj.put("mediaFile", mediaFile);
            obj.put("format", format);
            obj.put("sizeBytes", sizeBytes);
            obj.put("subtitles", subtitles != null ? subtitles : new JSONArray());
            obj.put("savedAt", System.currentTimeMillis());
        } catch (Exception ignored) {
        }
        return obj;
    }

    private static JSObject buildClientRecord(File itemDir, JSONObject meta) {
        String id = meta.optString("id", itemDir.getName());
        String mediaFile = meta.optString("mediaFile", "");
        String playbackUrl = LocalProxyPlugin.buildOfflineMediaUrl(id, mediaFile);
        if (playbackUrl.isEmpty()) return null;

        JSObject rec = new JSObject();
        rec.put("id", id);
        rec.put("episodeUrl", meta.optString("episodeUrl", ""));
        rec.put("canonicalUrl", meta.optString("canonicalUrl", ""));
        rec.put("title", meta.optString("title", "Episódio"));
        rec.put("seriesTitle", meta.optString("seriesTitle", ""));
        rec.put("seriesUrl", meta.optString("seriesUrl", ""));
        rec.put("episodeLabel", meta.optString("episodeLabel", ""));
        rec.put("poster", meta.optString("poster", ""));
        rec.put("qualityLabel", meta.optString("qualityLabel", ""));
        rec.put("serverLabel", meta.optString("serverLabel", ""));
        rec.put("isMovie", meta.optBoolean("isMovie", false));
        if (meta.has("seasonNumber")) rec.put("seasonNumber", meta.optInt("seasonNumber", 0));
        if (meta.has("episodeNumber")) rec.put("episodeNumber", meta.optInt("episodeNumber", 0));
        if (meta.has("prevUrl")) rec.put("prevUrl", meta.optString("prevUrl", ""));
        if (meta.has("nextUrl")) rec.put("nextUrl", meta.optString("nextUrl", ""));
        rec.put("status", "completed");
        rec.put("progress", 100);
        long sizeBytes = meta.optLong("sizeBytes", 0L);
        rec.put("downloadedBytes", sizeBytes);
        rec.put("totalBytes", sizeBytes);
        rec.put("sizeBytes", sizeBytes);
        rec.put("format", meta.optString("format", "mp4"));
        rec.put("mediaFile", mediaFile);
        rec.put("storageKind", "native");
        rec.put("playbackUrl", playbackUrl);
        rec.put("savedAt", meta.optLong("savedAt", System.currentTimeMillis()));

        JSArray subsOut = new JSArray();
        JSONArray subsMeta = meta.optJSONArray("subtitles");
        if (subsMeta != null) {
            for (int i = 0; i < subsMeta.length(); i++) {
                JSONObject s = subsMeta.optJSONObject(i);
                if (s == null) continue;
                String fn = s.optString("fileName", "");
                if (fn.isEmpty() || !new File(itemDir, fn).isFile()) continue;
                String subUrl = LocalProxyPlugin.buildOfflineMediaUrl(id, fn);
                if (subUrl.isEmpty()) continue;
                JSObject subJs = new JSObject();
                subJs.put("label", s.optString("label", "Legenda " + (i + 1)));
                subJs.put("fileName", fn);
                subJs.put("url", subUrl);
                subJs.put("isDefault", s.optBoolean("isDefault", i == 0));
                subsOut.put(subJs);
            }
        }
        rec.put("subtitles", subsOut);
        return rec;
    }

    private void emitProgressEvent(JSObject payload) {
        try {
            notifyListeners("offlineDownloadProgress", payload);
        } catch (Exception ignored) {
        }
    }

    private void emitError(DownloadRequest req, String message) {
        JSObject err = new JSObject();
        err.put("id", req.id);
        err.put("episodeUrl", req.episodeUrl);
        err.put("status", "error");
        err.put("progress", 0);
        err.put("errorMessage", message);
        emitProgressEvent(err);
    }

    private static void writeMetaFile(File itemDir, JSONObject meta) throws IOException {
        File tmp = new File(itemDir, "meta.json.tmp");
        File target = new File(itemDir, "meta.json");
        try (FileOutputStream fos = new FileOutputStream(tmp, false)) {
            fos.write(meta.toString().getBytes(StandardCharsets.UTF_8));
            fos.flush();
        }
        if (target.exists()) {
            //noinspection ResultOfMethodCallIgnored
            target.delete();
        }
        if (!tmp.renameTo(target)) {
            throw new IOException("Falha ao salvar metadados offline.");
        }
    }

    private static JSONObject readJsonObject(File file) {
        try (FileInputStream fis = new FileInputStream(file)) {
            String raw = LocalProxyPlugin.readStreamAsString(fis);
            return new JSONObject(raw);
        } catch (Exception e) {
            return null;
        }
    }

    private static long computeDirSizeBytes(File dir, String excludeName) {
        if (dir == null || !dir.exists()) return 0L;
        if (dir.isFile()) return dir.length();
        long sum = 0L;
        File[] files = dir.listFiles();
        if (files != null) {
            for (File f : files) {
                if (excludeName != null && excludeName.equals(f.getName())) continue;
                sum += f.isDirectory() ? computeDirSizeBytes(f, null) : f.length();
            }
        }
        return sum;
    }

    private static void deleteRecursively(File target) {
        if (target == null || !target.exists()) return;
        if (target.isDirectory()) {
            File[] children = target.listFiles();
            if (children != null) {
                for (File child : children) {
                    deleteRecursively(child);
                }
            }
        }
        //noinspection ResultOfMethodCallIgnored
        target.delete();
    }

    private static void sleepQuietly(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
        }
    }

    private static int notificationIdFor(String id) {
        return NOTIFICATION_ID_BASE + Math.abs(id.hashCode() % 900);
    }

    private static void ensureDownloadChannel(Context ctx) {
        if (ctx == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel ch = new NotificationChannel(
            CHANNEL_OFFLINE_DOWNLOADS_ID,
            "Downloads de Episódios",
            NotificationManager.IMPORTANCE_LOW
        );
        ch.setDescription("Progresso e conclusão dos vídeos baixados para assistir offline.");
        manager.createNotificationChannel(ch);
    }

    private static boolean canPostNotification(Context ctx) {
        if (ctx == null) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
        }
        return NotificationManagerCompat.from(ctx).areNotificationsEnabled();
    }

    private static void postDownloadNotification(
        Context ctx,
        DownloadRequest req,
        int percent,
        long downloadedBytes,
        long totalBytes,
        long speedBytesPerSec,
        boolean finished
    ) {
        if (!canPostNotification(ctx)) return;
        try {
            ensureDownloadChannel(ctx);
            int notifId = notificationIdFor(req.id);
            Intent openIntent = new Intent(ctx, MainActivity.class);
            openIntent.setAction(Intent.ACTION_MAIN);
            openIntent.addCategory(Intent.CATEGORY_LAUNCHER);
            openIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            openIntent.putExtra(MainActivity.EXTRA_NOTIFICATION_URL, req.episodeUrl);
            openIntent.putExtra(MainActivity.EXTRA_NOTIFICATION_KIND, "episode");
            PendingIntent pendingIntent = PendingIntentCompat.getActivity(
                ctx,
                notifId,
                openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT,
                false
            );

            String displayTitle = req.seriesTitle.isEmpty()
                ? req.title
                : (req.episodeLabel.isEmpty() ? req.seriesTitle : req.seriesTitle + " · " + req.episodeLabel);

            NotificationCompat.Builder builder = new NotificationCompat.Builder(ctx, CHANNEL_OFFLINE_DOWNLOADS_ID)
                .setSmallIcon(R.drawable.ic_stat_anisync)
                .setColor(0xFFF97316)
                .setOnlyAlertOnce(true)
                .setContentTitle(finished ? "Download concluído" : ("Baixando " + displayTitle));

            if (pendingIntent != null) {
                builder.setContentIntent(pendingIntent);
            }

            if (finished) {
                builder.setContentText(displayTitle + " pronto para assistir offline.")
                    .setOngoing(false)
                    .setAutoCancel(true)
                    .setProgress(0, 0, false);
            } else {
                String sizeText = downloadedBytes > 0L
                    ? formatShortMb(downloadedBytes)
                        + (totalBytes > 0L ? " / " + formatShortMb(totalBytes) : "")
                    : "Preparando download...";
                String speedText = speedBytesPerSec > 0L
                    ? (" · " + formatShortSpeed(speedBytesPerSec))
                    : "";
                builder.setContentText(percent > 0 ? (percent + "% · " + sizeText + speedText) : (sizeText + speedText))
                    .setOngoing(true)
                    .setAutoCancel(false)
                    .setProgress(100, percent, percent <= 0);
            }

            NotificationManagerCompat.from(ctx).notify(notifId, builder.build());
        } catch (Exception e) {
            Log.d(TAG, "Offline download notification skipped: " + e.getMessage());
        }
    }

    private static String formatShortSpeed(long bytesPerSec) {
        double mbps = bytesPerSec / (1024.0 * 1024.0);
        if (mbps >= 1.0) {
            return String.format(Locale.US, "%.1f MB/s", mbps);
        }
        return Math.max(1L, bytesPerSec / 1024L) + " KB/s";
    }

    private static void cancelDownloadNotification(Context ctx, String id) {
        if (ctx == null || id == null || id.isEmpty()) return;
        try {
            NotificationManagerCompat.from(ctx).cancel(notificationIdFor(id));
        } catch (Exception ignored) {
        }
    }

    private static String formatShortMb(long bytes) {
        double mb = bytes / (1024.0 * 1024.0);
        if (mb >= 1024.0) {
            return String.format(Locale.US, "%.2f GB", mb / 1024.0);
        }
        return String.format(Locale.US, "%.1f MB", mb);
    }
}
