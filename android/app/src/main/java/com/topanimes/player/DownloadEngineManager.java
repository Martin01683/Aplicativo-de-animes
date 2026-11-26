package com.topanimes.player;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;
import android.util.Log;

import com.yausername.youtubedl_android.YoutubeDL;
import com.yausername.youtubedl_android.YoutubeDLRequest;
import com.yausername.youtubedl_android.YoutubeDLResponse;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;

import kotlin.Unit;

/**
 * Manages the bundled native aria2c binary (cross-compiled from the latest stable
 * release of https://github.com/aria2/aria2.git) and embedded yt-dlp engine
 * (updated from https://github.com/yt-dlp/yt-dlp.git with SHA-256 verification).
 */
public final class DownloadEngineManager {
    private static final String TAG = "AnisyncDlEngines";
    public static final String ARIA2_REPO_URL = "https://github.com/aria2/aria2.git";
    public static final String YTDLP_REPO_URL = "https://github.com/yt-dlp/yt-dlp.git";
    private static final String YTDLP_LATEST_RELEASE_URL = "https://github.com/yt-dlp/yt-dlp/releases/latest";
    private static final String YTDLP_DOWNLOAD_BASE = "https://github.com/yt-dlp/yt-dlp/releases/download/";

    public static final int ARIA2_MAX_CONNECTIONS_PER_SERVER = 16;
    public static final int ARIA2_MAX_SPLITS = 32;
    public static final int ARIA2_MAX_CONCURRENT_SEGMENTS = 16;
    public static final String ARIA2_MIN_SPLIT_SIZE = "1M";

    private static final String PREFS_NAME = "anisync_download_engines";
    private static final String KEY_YTDLP_VERSION = "ytdlp_installed_version";
    private static final String KEY_YTDLP_BUNDLED_VERSION = "ytdlp_bundled_version";
    private static final String KEY_YTDLP_LAST_CHECK_MS = "ytdlp_last_check_ms";
    private static final long AUTO_UPDATE_INTERVAL_MS = 24L * 60L * 60L * 1000L;

    private static final String DEFAULT_UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

    private static final Pattern RELEASE_TAG_PATTERN =
        Pattern.compile("/releases/tag/([^/?#]+)", Pattern.CASE_INSENSITIVE);
    private static final Pattern SHA256_LINE_PATTERN =
        Pattern.compile("^([a-f0-9]{64})\\s+\\*?(.+)$", Pattern.CASE_INSENSITIVE);

    private static volatile File cachedCaBundleFile = null;
    private static volatile boolean ytDlpInitialized = false;
    private static final Object YTDLP_LOCK = new Object();

    private DownloadEngineManager() {
    }

    public static final class EngineInfo {
        public final boolean aria2Available;
        public final String aria2Version;
        public final String aria2Path;
        public final boolean ytdlpAvailable;
        public final String ytdlpVersion;
        public final int maxConnectionsPerServer;
        public final int maxSplits;
        public final int maxConcurrentSegments;

        public EngineInfo(
            boolean aria2Available,
            String aria2Version,
            String aria2Path,
            boolean ytdlpAvailable,
            String ytdlpVersion,
            int maxConnectionsPerServer,
            int maxSplits,
            int maxConcurrentSegments
        ) {
            this.aria2Available = aria2Available;
            this.aria2Version = aria2Version;
            this.aria2Path = aria2Path;
            this.ytdlpAvailable = ytdlpAvailable;
            this.ytdlpVersion = ytdlpVersion;
            this.maxConnectionsPerServer = maxConnectionsPerServer;
            this.maxSplits = maxSplits;
            this.maxConcurrentSegments = maxConcurrentSegments;
        }
    }

    public static final class YtDlpUpdateResult {
        public final boolean updated;
        public final String previousVersion;
        public final String currentVersion;
        public final String message;

        public YtDlpUpdateResult(boolean updated, String previousVersion, String currentVersion, String message) {
            this.updated = updated;
            this.previousVersion = previousVersion;
            this.currentVersion = currentVersion;
            this.message = message;
        }
    }

    public static final class ExtractedStream {
        public final String label;
        public final int height;
        public final String url;
        public final String format;

        public ExtractedStream(String label, int height, String url, String format) {
            this.label = label;
            this.height = height;
            this.url = url;
            this.format = format;
        }
    }

    public static final class ExtractedSubtitle {
        public final String label;
        public final String url;
        public final boolean isDefault;

        public ExtractedSubtitle(String label, String url, boolean isDefault) {
            this.label = label;
            this.url = url;
            this.isDefault = isDefault;
        }
    }

    public static final class YtDlpExtractedMedia {
        public final boolean ok;
        public final List<ExtractedStream> streams;
        public final List<ExtractedSubtitle> subtitles;
        public final String referer;
        public final String title;
        public final String errorMessage;

        public YtDlpExtractedMedia(
            boolean ok,
            List<ExtractedStream> streams,
            List<ExtractedSubtitle> subtitles,
            String referer,
            String title,
            String errorMessage
        ) {
            this.ok = ok;
            this.streams = streams;
            this.subtitles = subtitles;
            this.referer = referer;
            this.title = title;
            this.errorMessage = errorMessage;
        }
    }

    public interface YtDlpProgressCallback {
        void onProgress(float percent, long etaSeconds, String line);
    }

    public static File getAria2Binary(Context ctx) {
        if (ctx == null || ctx.getApplicationInfo() == null) return null;
        String nativeLibDir = ctx.getApplicationInfo().nativeLibraryDir;
        if (nativeLibDir == null || nativeLibDir.isEmpty()) return null;
        File bin = new File(nativeLibDir, "libaria2c.so");
        if (bin.isFile() && bin.length() > 0L) {
            return bin;
        }
        return null;
    }

    public static boolean isAria2Available(Context ctx) {
        return getAria2Binary(ctx) != null;
    }

    public static boolean isPythonRuntimeAvailable(Context ctx) {
        if (ctx == null || ctx.getApplicationInfo() == null) return false;
        String nativeLibDir = ctx.getApplicationInfo().nativeLibraryDir;
        if (nativeLibDir == null || nativeLibDir.isEmpty()) return false;
        File pyBin = new File(nativeLibDir, "libpython.so");
        File pyZip = new File(nativeLibDir, "libpython.zip.so");
        return pyBin.isFile() && pyZip.isFile();
    }

    public static JSONObject readBundledEngineMeta(Context ctx) {
        if (ctx == null) return new JSONObject();
        try (InputStream is = ctx.getAssets().open("download-engines.json")) {
            String raw = LocalProxyPlugin.readStreamAsString(is);
            return new JSONObject(raw);
        } catch (Exception ignored) {
            return new JSONObject();
        }
    }

    public static EngineInfo getEngineInfo(Context ctx) {
        File aria2Bin = getAria2Binary(ctx);
        JSONObject meta = readBundledEngineMeta(ctx);
        String aria2Ver = meta.optString("aria2Version", "");
        if (aria2Ver.isEmpty()) {
            aria2Ver = meta.optString("aria2Tag", "").replaceFirst("^release-", "");
        }
        SharedPreferences prefs = ctx != null
            ? ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            : null;
        String installedYtDlp = prefs != null ? prefs.getString(KEY_YTDLP_VERSION, "") : "";
        String bundledYtDlp = meta.optString("ytdlpVersion", meta.optString("ytdlpTag", ""));
        String activeYtDlp = !installedYtDlp.isEmpty() ? installedYtDlp : bundledYtDlp;

        return new EngineInfo(
            aria2Bin != null,
            aria2Ver,
            aria2Bin != null ? aria2Bin.getAbsolutePath() : "",
            isPythonRuntimeAvailable(ctx),
            activeYtDlp,
            ARIA2_MAX_CONNECTIONS_PER_SERVER,
            ARIA2_MAX_SPLITS,
            ARIA2_MAX_CONCURRENT_SEGMENTS
        );
    }

    /**
     * Exports Android's live system + user trusted CA certificates into a PEM file
     * so OpenSSL-linked aria2c validates HTTPS cleanly on Android 8 through Android 17+.
     */
    public static File ensureCaCertificateBundle(Context ctx) {
        File existing = cachedCaBundleFile;
        if (existing != null && existing.isFile() && existing.length() > 1024L) {
            return existing;
        }
        if (ctx == null) return null;
        synchronized (DownloadEngineManager.class) {
            if (cachedCaBundleFile != null && cachedCaBundleFile.isFile() && cachedCaBundleFile.length() > 1024L) {
                return cachedCaBundleFile;
            }
            try {
                File dir = new File(ctx.getNoBackupFilesDir(), "anisync-download-engines");
                if (!dir.exists()) {
                    //noinspection ResultOfMethodCallIgnored
                    dir.mkdirs();
                }
                File target = new File(dir, "ca-bundle.pem");
                File tmp = new File(dir, "ca-bundle.pem.tmp");

                TrustManagerFactory tmf = TrustManagerFactory.getInstance(
                    TrustManagerFactory.getDefaultAlgorithm()
                );
                tmf.init((KeyStore) null);
                int count = 0;
                try (FileOutputStream fos = new FileOutputStream(tmp, false)) {
                    for (TrustManager tm : tmf.getTrustManagers()) {
                        if (!(tm instanceof X509TrustManager)) continue;
                        X509Certificate[] issuers = ((X509TrustManager) tm).getAcceptedIssuers();
                        if (issuers == null) continue;
                        for (X509Certificate cert : issuers) {
                            if (cert == null) continue;
                            byte[] der = cert.getEncoded();
                            String b64 = Base64.encodeToString(der, Base64.NO_WRAP);
                            fos.write("-----BEGIN CERTIFICATE-----\n".getBytes(StandardCharsets.US_ASCII));
                            for (int i = 0; i < b64.length(); i += 64) {
                                int end = Math.min(b64.length(), i + 64);
                                fos.write(b64.substring(i, end).getBytes(StandardCharsets.US_ASCII));
                                fos.write('\n');
                            }
                            fos.write("-----END CERTIFICATE-----\n".getBytes(StandardCharsets.US_ASCII));
                            count++;
                        }
                    }
                    fos.flush();
                }
                if (count > 0 && tmp.length() > 1024L) {
                    if (target.exists()) {
                        //noinspection ResultOfMethodCallIgnored
                        target.delete();
                    }
                    if (tmp.renameTo(target)) {
                        cachedCaBundleFile = target;
                        return target;
                    }
                }
            } catch (Exception e) {
                Log.w(TAG, "Failed to export Android CA bundle for aria2c: " + e.getMessage());
            }
            // Fallback to youtubedl-android's cert.pem if present
            File fallback = new File(
                ctx.getNoBackupFilesDir(),
                "youtubedl-android/packages/python/usr/etc/tls/cert.pem"
            );
            if (fallback.isFile() && fallback.length() > 1024L) {
                cachedCaBundleFile = fallback;
                return fallback;
            }
            return null;
        }
    }

    public static List<String> buildAria2SingleFileCommand(
        Context ctx,
        String url,
        String referer,
        File outDir,
        String outFileName
    ) {
        File aria2Bin = getAria2Binary(ctx);
        if (aria2Bin == null) return Collections.emptyList();

        List<String> cmd = new ArrayList<>();
        cmd.add(aria2Bin.getAbsolutePath());
        cmd.add("--max-connection-per-server=" + ARIA2_MAX_CONNECTIONS_PER_SERVER);
        cmd.add("--split=" + ARIA2_MAX_SPLITS);
        cmd.add("--min-split-size=" + ARIA2_MIN_SPLIT_SIZE);
        cmd.add("--max-concurrent-downloads=" + ARIA2_MAX_CONCURRENT_SEGMENTS);
        cmd.add("--file-allocation=none");
        cmd.add("--disk-cache=32M");
        cmd.add("--max-overall-download-limit=0");
        cmd.add("--max-download-limit=0");
        cmd.add("--lowest-speed-limit=0");
        cmd.add("--enable-http-pipelining=true");
        cmd.add("--optimize-concurrent-downloads=true");
        cmd.add("--http-accept-gzip=false");
        cmd.add("--continue=true");
        cmd.add("--allow-overwrite=true");
        cmd.add("--auto-file-renaming=false");
        cmd.add("--max-tries=5");
        cmd.add("--retry-wait=1");
        cmd.add("--timeout=30");
        cmd.add("--connect-timeout=15");
        cmd.add("--summary-interval=1");
        cmd.add("--console-log-level=notice");
        cmd.add("--user-agent=" + DEFAULT_UA);
        if (referer != null && !referer.trim().isEmpty()) {
            cmd.add("--referer=" + referer.trim());
        }
        File caBundle = ensureCaCertificateBundle(ctx);
        if (caBundle != null && caBundle.isFile()) {
            cmd.add("--ca-certificate=" + caBundle.getAbsolutePath());
        }
        cmd.add("--dir=" + outDir.getAbsolutePath());
        cmd.add("--out=" + outFileName);
        cmd.add(url);
        return cmd;
    }

    public static List<String> buildAria2BatchInputCommand(
        Context ctx,
        File inputFile,
        File outDir
    ) {
        File aria2Bin = getAria2Binary(ctx);
        if (aria2Bin == null) return Collections.emptyList();

        List<String> cmd = new ArrayList<>();
        cmd.add(aria2Bin.getAbsolutePath());
        cmd.add("--input-file=" + inputFile.getAbsolutePath());
        cmd.add("--max-concurrent-downloads=" + ARIA2_MAX_CONCURRENT_SEGMENTS);
        cmd.add("--max-connection-per-server=" + ARIA2_MAX_CONNECTIONS_PER_SERVER);
        cmd.add("--split=16");
        cmd.add("--min-split-size=" + ARIA2_MIN_SPLIT_SIZE);
        cmd.add("--file-allocation=none");
        cmd.add("--disk-cache=32M");
        cmd.add("--max-overall-download-limit=0");
        cmd.add("--max-download-limit=0");
        cmd.add("--lowest-speed-limit=0");
        cmd.add("--enable-http-pipelining=true");
        cmd.add("--optimize-concurrent-downloads=true");
        cmd.add("--http-accept-gzip=false");
        cmd.add("--continue=true");
        cmd.add("--allow-overwrite=true");
        cmd.add("--auto-file-renaming=false");
        cmd.add("--max-tries=5");
        cmd.add("--retry-wait=1");
        cmd.add("--timeout=25");
        cmd.add("--connect-timeout=12");
        cmd.add("--summary-interval=1");
        cmd.add("--console-log-level=notice");
        cmd.add("--user-agent=" + DEFAULT_UA);
        File caBundle = ensureCaCertificateBundle(ctx);
        if (caBundle != null && caBundle.isFile()) {
            cmd.add("--ca-certificate=" + caBundle.getAbsolutePath());
        }
        cmd.add("--dir=" + outDir.getAbsolutePath());
        return cmd;
    }

    private static File getInstalledYtDlpBinary(Context ctx) {
        File baseDir = new File(ctx.getNoBackupFilesDir(), YoutubeDL.baseName);
        File ytdlpDir = new File(baseDir, YoutubeDL.ytdlpDirName);
        return new File(ytdlpDir, YoutubeDL.ytdlpBin);
    }

    public static boolean ensureYtDlpInitialized(Context ctx) {
        if (ctx == null || !isPythonRuntimeAvailable(ctx)) return false;
        Context appCtx = ctx.getApplicationContext();
        synchronized (YTDLP_LOCK) {
            if (!ytDlpInitialized) {
                try {
                    YoutubeDL.getInstance().init(appCtx);
                    syncBundledYtDlpIfNewer(appCtx);
                    ytDlpInitialized = true;
                } catch (Exception e) {
                    Log.w(TAG, "Failed to initialize embedded yt-dlp: " + e.getMessage());
                    return false;
                }
            }
            return true;
        }
    }

    /**
     * When a newer APK release bundles an updated res/raw/ytdlp from
     * https://github.com/yt-dlp/yt-dlp.git, refresh the extracted yt-dlp zipapp
     * if the bundled version is newer than the previously extracted one.
     */
    private static void syncBundledYtDlpIfNewer(Context appCtx) {
        try {
            JSONObject meta = readBundledEngineMeta(appCtx);
            String bundledVer = meta.optString("ytdlpVersion", meta.optString("ytdlpTag", "")).trim();
            if (bundledVer.isEmpty()) return;

            SharedPreferences prefs = appCtx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String lastBundled = prefs.getString(KEY_YTDLP_BUNDLED_VERSION, "");
            String currentInstalled = prefs.getString(KEY_YTDLP_VERSION, "");
            boolean shouldCopy = !bundledVer.equals(lastBundled)
                && (currentInstalled.isEmpty() || compareDotVersions(bundledVer, currentInstalled) > 0);
            if (!shouldCopy) return;

            int rawId = appCtx.getResources().getIdentifier("ytdlp", "raw", appCtx.getPackageName());
            if (rawId == 0) return;

            File target = getInstalledYtDlpBinary(appCtx);
            File parent = target.getParentFile();
            if (parent != null && !parent.exists()) {
                //noinspection ResultOfMethodCallIgnored
                parent.mkdirs();
            }
            File tmp = new File(parent, "yt-dlp.bundled.tmp");
            try (InputStream in = appCtx.getResources().openRawResource(rawId);
                 FileOutputStream fos = new FileOutputStream(tmp, false)) {
                byte[] buf = new byte[32768];
                int n;
                while ((n = in.read(buf)) != -1) {
                    fos.write(buf, 0, n);
                }
                fos.flush();
            }
            if (tmp.length() > 100_000L) {
                if (target.exists()) {
                    //noinspection ResultOfMethodCallIgnored
                    target.delete();
                }
                if (tmp.renameTo(target)) {
                    prefs.edit()
                        .putString(KEY_YTDLP_BUNDLED_VERSION, bundledVer)
                        .putString(KEY_YTDLP_VERSION, bundledVer)
                        .apply();
                }
            }
        } catch (Exception e) {
            Log.d(TAG, "Bundled yt-dlp sync skipped: " + e.getMessage());
        }
    }

    public static void syncYtDlpIfDue(Context ctx) {
        if (ctx == null || !isPythonRuntimeAvailable(ctx)) return;
        Context appCtx = ctx.getApplicationContext();
        SharedPreferences prefs = appCtx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        long lastCheck = prefs.getLong(KEY_YTDLP_LAST_CHECK_MS, 0L);
        if (System.currentTimeMillis() - lastCheck < AUTO_UPDATE_INTERVAL_MS) {
            return;
        }
        try {
            updateYtDlpStable(appCtx, false);
        } catch (Exception e) {
            Log.d(TAG, "Background yt-dlp check skipped: " + e.getMessage());
        }
    }

    /**
     * Checks https://github.com/yt-dlp/yt-dlp/releases/latest via HTTP redirect
     * (avoiding GitHub REST API 403 rate limits), verifies SHA-256 against official
     * SHA2-256SUMS, and atomically updates the embedded yt-dlp zipapp.
     */
    public static YtDlpUpdateResult updateYtDlpStable(Context ctx, boolean force) throws IOException {
        if (ctx == null || !isPythonRuntimeAvailable(ctx)) {
            return new YtDlpUpdateResult(false, "", "", "Motor yt-dlp indisponível neste build.");
        }
        Context appCtx = ctx.getApplicationContext();
        if (!ensureYtDlpInitialized(appCtx)) {
            return new YtDlpUpdateResult(false, "", "", "Falha ao inicializar o ambiente Python do yt-dlp.");
        }

        SharedPreferences prefs = appCtx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String previousVersion = prefs.getString(KEY_YTDLP_VERSION, "");
        if (previousVersion.isEmpty()) {
            JSONObject meta = readBundledEngineMeta(appCtx);
            previousVersion = meta.optString("ytdlpVersion", meta.optString("ytdlpTag", ""));
        }

        String latestTag = resolveLatestYtDlpTagNoApi();
        prefs.edit().putLong(KEY_YTDLP_LAST_CHECK_MS, System.currentTimeMillis()).apply();
        if (latestTag.isEmpty()) {
            throw new IOException("Não foi possível consultar a última versão estável do yt-dlp.");
        }

        if (!force && !previousVersion.isEmpty() && compareDotVersions(latestTag, previousVersion) <= 0) {
            return new YtDlpUpdateResult(
                false,
                previousVersion,
                previousVersion,
                "yt-dlp já está na versão estável mais recente (" + previousVersion + ")."
            );
        }
        if (!previousVersion.isEmpty() && latestTag.equals(previousVersion)) {
            return new YtDlpUpdateResult(
                false,
                previousVersion,
                previousVersion,
                "yt-dlp já está atualizado (" + previousVersion + ")."
            );
        }

        String binUrl = YTDLP_DOWNLOAD_BASE + latestTag + "/yt-dlp";
        String shaUrl = YTDLP_DOWNLOAD_BASE + latestTag + "/SHA2-256SUMS";

        String shaText = fetchSmallText(shaUrl, 15000);
        String expectedSha = parseSha256Entry(shaText, "yt-dlp");
        if (expectedSha.isEmpty()) {
            throw new IOException("Não foi possível obter o checksum SHA-256 oficial do yt-dlp " + latestTag + ".");
        }

        File target = getInstalledYtDlpBinary(appCtx);
        File parent = target.getParentFile();
        if (parent != null && !parent.exists()) {
            //noinspection ResultOfMethodCallIgnored
            parent.mkdirs();
        }
        File tmp = new File(parent, "yt-dlp.update.tmp");
        try {
            downloadFileToPath(binUrl, tmp, 45000);
            String actualSha = computeFileSha256(tmp);
            if (!expectedSha.equalsIgnoreCase(actualSha)) {
                throw new IOException("Verificação SHA-256 do yt-dlp falhou.");
            }
            synchronized (YTDLP_LOCK) {
                if (target.exists()) {
                    //noinspection ResultOfMethodCallIgnored
                    target.delete();
                }
                if (!tmp.renameTo(target)) {
                    throw new IOException("Falha ao substituir o binário yt-dlp atualizado.");
                }
            }
            prefs.edit()
                .putString(KEY_YTDLP_VERSION, latestTag)
                .putLong(KEY_YTDLP_LAST_CHECK_MS, System.currentTimeMillis())
                .apply();
            return new YtDlpUpdateResult(
                true,
                previousVersion,
                latestTag,
                "yt-dlp atualizado para " + latestTag + " (SHA-256 verificado)."
            );
        } finally {
            if (tmp.exists()) {
                //noinspection ResultOfMethodCallIgnored
                tmp.delete();
            }
        }
    }

    public static YtDlpExtractedMedia extractStreamsWithYtDlp(
        Context ctx,
        String embedUrl,
        String referer
    ) {
        if (!LocalProxyPlugin.isSafeHttpUrl(embedUrl)) {
            return new YtDlpExtractedMedia(
                false,
                Collections.emptyList(),
                Collections.emptyList(),
                referer != null ? referer : "",
                "",
                "URL inválida para extração via yt-dlp."
            );
        }
        if (!ensureYtDlpInitialized(ctx)) {
            return new YtDlpExtractedMedia(
                false,
                Collections.emptyList(),
                Collections.emptyList(),
                referer != null ? referer : "",
                "",
                "Ambiente yt-dlp indisponível."
            );
        }

        try {
            YoutubeDLRequest req = new YoutubeDLRequest(embedUrl);
            req.addOption("--dump-single-json");
            req.addOption("--no-playlist");
            req.addOption("--no-warnings");
            req.addOption("--skip-download");
            req.addOption("--socket-timeout", 15);
            req.addOption("--user-agent", DEFAULT_UA);
            if (referer != null && LocalProxyPlugin.isSafeHttpUrl(referer)) {
                req.addOption("--referer", referer);
            }

            YoutubeDLResponse resp = YoutubeDL.getInstance().execute(req, null, null);
            String rawOut = resp != null && resp.getOut() != null ? resp.getOut().trim() : "";
            int jsonStart = rawOut.indexOf('{');
            if (jsonStart < 0) {
                return new YtDlpExtractedMedia(
                    false,
                    Collections.emptyList(),
                    Collections.emptyList(),
                    referer != null ? referer : "",
                    "",
                    "yt-dlp não retornou metadados de vídeo."
                );
            }
            JSONObject root = new JSONObject(rawOut.substring(jsonStart));
            String resolvedTitle = root.optString("title", "");
            String resolvedReferer = referer != null ? referer : "";
            JSONObject topHeaders = root.optJSONObject("http_headers");
            if (topHeaders != null) {
                String hdrRef = topHeaders.optString("Referer", "");
                if (LocalProxyPlugin.isSafeHttpUrl(hdrRef)) {
                    resolvedReferer = hdrRef;
                }
            }

            List<ExtractedStream> streams = new ArrayList<>();
            Set<String> seenUrls = new HashSet<>();

            JSONArray formats = root.optJSONArray("formats");
            if (formats != null) {
                for (int i = 0; i < formats.length(); i++) {
                    JSONObject f = formats.optJSONObject(i);
                    if (f == null) continue;
                    String fUrl = f.optString("url", "").trim();
                    if (!LocalProxyPlugin.isSafeHttpUrl(fUrl) || seenUrls.contains(fUrl)) continue;
                    String vcodec = f.optString("vcodec", "");
                    String acodec = f.optString("acodec", "");
                    if ("none".equalsIgnoreCase(vcodec)) continue;
                    // Prefer muxed streams (video+audio) or HLS/m3u8 manifests
                    String protocol = f.optString("protocol", "").toLowerCase(Locale.ROOT);
                    String ext = f.optString("ext", "").toLowerCase(Locale.ROOT);
                    boolean isHls = protocol.contains("m3u8")
                        || fUrl.toLowerCase(Locale.ROOT).contains(".m3u8");
                    if (!isHls && "none".equalsIgnoreCase(acodec)) continue;

                    seenUrls.add(fUrl);
                    int height = f.optInt("height", 0);
                    String label = height > 0
                        ? (height + "p")
                        : f.optString("format_note", isHls ? "HLS" : "MP4");
                    String fmt = isHls ? "hls" : ("mp4".equals(ext) ? "mp4" : "unknown");
                    streams.add(new ExtractedStream(label, height, fUrl, fmt));
                }
            }

            String directUrl = root.optString("url", "").trim();
            if (LocalProxyPlugin.isSafeHttpUrl(directUrl) && !seenUrls.contains(directUrl)) {
                boolean isHls = directUrl.toLowerCase(Locale.ROOT).contains(".m3u8");
                int height = root.optInt("height", 0);
                String label = height > 0 ? (height + "p") : (isHls ? "HLS" : "MP4");
                streams.add(new ExtractedStream(label, height, directUrl, isHls ? "hls" : "mp4"));
            }

            Collections.sort(streams, new Comparator<ExtractedStream>() {
                @Override
                public int compare(ExtractedStream a, ExtractedStream b) {
                    if (b.height != a.height) return Integer.compare(b.height, a.height);
                    int aScore = "mp4".equals(a.format) ? 2 : ("hls".equals(a.format) ? 1 : 0);
                    int bScore = "mp4".equals(b.format) ? 2 : ("hls".equals(b.format) ? 1 : 0);
                    return Integer.compare(bScore, aScore);
                }
            });

            List<ExtractedSubtitle> subs = new ArrayList<>();
            JSONObject subsObj = root.optJSONObject("subtitles");
            if (subsObj != null) {
                Iterator<String> keys = subsObj.keys();
                while (keys.hasNext()) {
                    String lang = keys.next();
                    JSONArray arr = subsObj.optJSONArray(lang);
                    if (arr == null) continue;
                    for (int i = 0; i < arr.length(); i++) {
                        JSONObject item = arr.optJSONObject(i);
                        if (item == null) continue;
                        String subUrl = item.optString("url", "").trim();
                        if (!LocalProxyPlugin.isSafeHttpUrl(subUrl)) continue;
                        String ext = item.optString("ext", "").toLowerCase(Locale.ROOT);
                        if (!"vtt".equals(ext) && !"srt".equals(ext) && !"ass".equals(ext)) continue;
                        boolean isPt = lang.toLowerCase(Locale.ROOT).startsWith("pt");
                        subs.add(new ExtractedSubtitle(
                            item.optString("name", lang),
                            subUrl,
                            isPt
                        ));
                        break;
                    }
                }
            }

            if (streams.isEmpty()) {
                return new YtDlpExtractedMedia(
                    false,
                    Collections.emptyList(),
                    subs,
                    resolvedReferer,
                    resolvedTitle,
                    "yt-dlp não encontrou nenhum stream reproduzível."
                );
            }

            return new YtDlpExtractedMedia(true, streams, subs, resolvedReferer, resolvedTitle, "");
        } catch (Exception e) {
            return new YtDlpExtractedMedia(
                false,
                Collections.emptyList(),
                Collections.emptyList(),
                referer != null ? referer : "",
                "",
                e.getMessage() != null ? e.getMessage() : "Falha na extração via yt-dlp."
            );
        }
    }

    public static File downloadWithYtDlpAndAria2(
        Context ctx,
        String url,
        String referer,
        File targetMp4File,
        String processId,
        YtDlpProgressCallback callback
    ) throws Exception {
        if (!ensureYtDlpInitialized(ctx)) {
            throw new IOException("Motor yt-dlp não está disponível neste dispositivo.");
        }
        YoutubeDLRequest req = new YoutubeDLRequest(url);
        req.addOption("--no-playlist");
        req.addOption("--no-part");
        req.addOption("--no-warnings");
        req.addOption("--concurrent-fragments", ARIA2_MAX_CONCURRENT_SEGMENTS);
        req.addOption("--format", "best[ext=mp4]/best[vcodec!=none][acodec!=none]/best");
        req.addOption("--retries", 5);
        req.addOption("--fragment-retries", 5);
        req.addOption("--user-agent", DEFAULT_UA);
        if (referer != null && LocalProxyPlugin.isSafeHttpUrl(referer)) {
            req.addOption("--referer", referer);
        }
        if (isAria2Available(ctx)) {
            String aria2Flags = "-x " + ARIA2_MAX_CONNECTIONS_PER_SERVER
                + " -s " + ARIA2_MAX_SPLITS
                + " -k " + ARIA2_MIN_SPLIT_SIZE
                + " -j " + ARIA2_MAX_CONCURRENT_SEGMENTS
                + " --file-allocation=none"
                + " --disk-cache=32M"
                + " --max-overall-download-limit=0"
                + " --max-download-limit=0"
                + " --enable-http-pipelining=true"
                + " --optimize-concurrent-downloads=true"
                + " --continue=true"
                + " --max-tries=5"
                + " --retry-wait=1";
            req.addOption("--downloader", "libaria2c.so");
            req.addOption("--downloader-args", "aria2c:" + aria2Flags);
        }
        req.addOption("-o", targetMp4File.getAbsolutePath());

        YoutubeDL.getInstance().execute(
            req,
            processId,
            (Float progress, Long etaInSeconds, String line) -> {
                if (callback != null) {
                    callback.onProgress(
                        progress != null ? progress : 0f,
                        etaInSeconds != null ? etaInSeconds : 0L,
                        line != null ? line : ""
                    );
                }
                return Unit.INSTANCE;
            }
        );

        if (!targetMp4File.isFile() || targetMp4File.length() <= 0L) {
            throw new IOException("yt-dlp concluiu sem gerar arquivo de vídeo.");
        }
        return targetMp4File;
    }

    public static void destroyYtDlpProcess(String processId) {
        if (processId == null || processId.isEmpty() || !ytDlpInitialized) return;
        try {
            YoutubeDL.getInstance().destroyProcessById(processId);
        } catch (Exception ignored) {
        }
    }

    private static String resolveLatestYtDlpTagNoApi() {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(YTDLP_LATEST_RELEASE_URL).openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setRequestMethod("HEAD");
            conn.setConnectTimeout(12000);
            conn.setReadTimeout(12000);
            conn.setRequestProperty("User-Agent", DEFAULT_UA);
            int code = conn.getResponseCode();
            if (code >= 300 && code < 400) {
                String loc = conn.getHeaderField("Location");
                if (loc != null) {
                    Matcher m = RELEASE_TAG_PATTERN.matcher(loc);
                    if (m.find()) {
                        return URLDecoder.decode(m.group(1), "UTF-8").trim();
                    }
                }
            }
        } catch (Exception e) {
            Log.d(TAG, "yt-dlp HEAD redirect lookup failed: " + e.getMessage());
        } finally {
            if (conn != null) conn.disconnect();
        }
        return "";
    }

    private static String fetchSmallText(String url, int timeoutMs) throws IOException {
        HttpURLConnection conn = null;
        try {
            LocalProxyPlugin.RedirectResult res = LocalProxyPlugin.openWithRedirects(
                url,
                "https://github.com/yt-dlp/yt-dlp",
                "text/plain,*/*",
                null,
                timeoutMs
            );
            conn = res.connection;
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) {
                throw new IOException("HTTP " + code + " ao baixar " + url);
            }
            return LocalProxyPlugin.readStreamAsString(conn.getInputStream());
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static void downloadFileToPath(String url, File target, int timeoutMs) throws IOException {
        HttpURLConnection conn = null;
        try {
            LocalProxyPlugin.RedirectResult res = LocalProxyPlugin.openWithRedirects(
                url,
                "https://github.com/yt-dlp/yt-dlp",
                "*/*",
                null,
                timeoutMs
            );
            conn = res.connection;
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) {
                throw new IOException("HTTP " + code + " ao baixar yt-dlp.");
            }
            try (InputStream in = conn.getInputStream();
                 FileOutputStream fos = new FileOutputStream(target, false)) {
                byte[] buf = new byte[32768];
                int n;
                while ((n = in.read(buf)) != -1) {
                    fos.write(buf, 0, n);
                }
                fos.flush();
            }
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static String parseSha256Entry(String shaText, String fileName) {
        if (shaText == null || fileName == null) return "";
        String[] lines = shaText.split("\\r?\\n");
        for (String rawLine : lines) {
            Matcher m = SHA256_LINE_PATTERN.matcher(rawLine.trim());
            if (!m.matches()) continue;
            String candidate = m.group(2).trim().replaceFirst("^\\./", "");
            if (fileName.equals(candidate)) {
                return m.group(1).toLowerCase(Locale.ROOT);
            }
        }
        return "";
    }

    private static String computeFileSha256(File file) throws IOException {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (FileInputStream fis = new FileInputStream(file)) {
                byte[] buf = new byte[32768];
                int n;
                while ((n = fis.read(buf)) != -1) {
                    digest.update(buf, 0, n);
                }
            }
            byte[] hash = digest.digest();
            StringBuilder hex = new StringBuilder(hash.length * 2);
            for (byte b : hash) {
                hex.append(String.format(Locale.US, "%02x", b & 0xff));
            }
            return hex.toString();
        } catch (Exception e) {
            throw new IOException("Erro ao calcular SHA-256.", e);
        }
    }

    private static int compareDotVersions(String a, String b) {
        String[] pa = (a != null ? a : "").split("\\.");
        String[] pb = (b != null ? b : "").split("\\.");
        int len = Math.max(pa.length, pb.length);
        for (int i = 0; i < len; i++) {
            int va = i < pa.length ? parseIntSafe(pa[i]) : 0;
            int vb = i < pb.length ? parseIntSafe(pb[i]) : 0;
            if (va != vb) return Integer.compare(va, vb);
        }
        return 0;
    }

    private static int parseIntSafe(String raw) {
        try {
            return Integer.parseInt(raw.replaceAll("[^0-9]", ""));
        } catch (Exception ignored) {
            return 0;
        }
    }
}
