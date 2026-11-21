package com.topanimes.player;

import android.content.Intent;
import android.net.Uri;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.net.URL;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

@CapacitorPlugin(name = "LocalProxy")
public class LocalProxyPlugin extends Plugin {
    private static final String TAG = "TopAnimesLocalProxy";
    private static final String DEFAULT_UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
    private static final Pattern DIRECT_HOSTS_PATTERN = Pattern.compile(
        "(?:^|\\.)(?:tiktokcdn\\.com|booonceivu\\.shop|123flmsfree\\.com|321moviesfree\\.com)$",
        Pattern.CASE_INSENSITIVE
    );
    private static final Pattern URI_ATTR_PATTERN = Pattern.compile("URI=\"([^\"]+)\"", Pattern.CASE_INSENSITIVE);
    private static final Pattern M3U8_EXT_PATTERN = Pattern.compile("\\.m3u8(?:$|\\?)", Pattern.CASE_INSENSITIVE);

    public static volatile String sharedProxyBaseUrl = "";

    public static String buildSharedProxyUrl(String targetUrl, String referer) {
        String base = sharedProxyBaseUrl;
        if (base == null || base.isEmpty() || targetUrl == null || targetUrl.isEmpty()) {
            return targetUrl;
        }
        try {
            String safeReferer = (referer != null && isSafeHttpUrl(referer)) ? referer : "https://topanimes.net/";
            return base + "/stream-proxy?url="
                + URLEncoder.encode(targetUrl, "UTF-8")
                + "&referer=" + URLEncoder.encode(safeReferer, "UTF-8");
        } catch (Exception e) {
            return targetUrl;
        }
    }

    private ServerSocket serverSocket;
    private volatile int proxyPort = -1;
    private volatile boolean running = false;
    private ExecutorService executor;

    @Override
    public void load() {
        super.load();
        startProxyServer();
    }

    @Override
    protected void handleOnDestroy() {
        running = false;
        if (serverSocket != null) {
            try {
                serverSocket.close();
            } catch (IOException ignored) {
            }
        }
        if (executor != null) {
            executor.shutdownNow();
        }
        super.handleOnDestroy();
    }

    private synchronized void startProxyServer() {
        if (running && proxyPort > 0) return;
        try {
            executor = Executors.newCachedThreadPool();
            serverSocket = new ServerSocket(0, 64, InetAddress.getByName("127.0.0.1"));
            proxyPort = serverSocket.getLocalPort();
            sharedProxyBaseUrl = "http://127.0.0.1:" + proxyPort;
            running = true;

            Thread acceptThread = new Thread(() -> {
                while (running && !serverSocket.isClosed()) {
                    try {
                        Socket client = serverSocket.accept();
                        executor.execute(() -> handleSocket(client));
                    } catch (IOException e) {
                        if (running) {
                            Log.w(TAG, "Accept error: " + e.getMessage());
                        }
                    }
                }
            }, "TopAnimesProxyAccept");
            acceptThread.setDaemon(true);
            acceptThread.start();
            Log.i(TAG, "Local proxy started on 127.0.0.1:" + proxyPort);
        } catch (IOException e) {
            Log.e(TAG, "Failed to start local proxy", e);
        }
    }

    @PluginMethod
    public void getProxyBaseUrl(PluginCall call) {
        if (!running || proxyPort <= 0) {
            startProxyServer();
        }
        JSObject ret = new JSObject();
        ret.put("baseUrl", proxyPort > 0 ? ("http://127.0.0.1:" + proxyPort) : "");
        call.resolve(ret);
    }

    @PluginMethod
    public void fetchPage(PluginCall call) {
        String rawUrl = call.getString("url", "");
        if (!isSafeHttpUrl(rawUrl)) {
            call.reject("URL inválida ou não permitida.");
            return;
        }
        String referer = call.getString("referer", "https://topanimes.net/");
        String accept = call.getString("accept", "text/html,application/xhtml+xml,application/json,*/*;q=0.9");
        int timeoutMs = call.getInt("timeoutMs", 12000);

        if (executor == null || executor.isShutdown()) {
            startProxyServer();
        }

        executor.execute(() -> {
            HttpURLConnection conn = null;
            try {
                RedirectResult res = openWithRedirects(rawUrl, referer, accept, null, timeoutMs);
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

    private void handleSocket(Socket client) {
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
                    String rewritten = rewriteM3u8Playlist(rawManifest, upstream.finalUrl, referer);
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
                    out.write(payload);
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

                InputStream bodyStream = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                if (bodyStream != null && !"HEAD".equals(method)) {
                    byte[] buf = new byte[65536];
                    int read;
                    while ((read = bodyStream.read(buf)) != -1) {
                        out.write(buf, 0, read);
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

    private RedirectResult openWithRedirects(
        String rawUrl,
        String referer,
        String accept,
        String rangeHeader,
        int timeoutMs
    ) throws IOException {
        String currentUrl = rawUrl;
        for (int hop = 0; hop <= 4; hop++) {
            if (!isSafeHttpUrl(currentUrl)) {
                throw new IOException("URL bloqueada por segurança.");
            }
            URL parsed = new URL(currentUrl);
            HttpURLConnection conn = (HttpURLConnection) parsed.openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(timeoutMs);
            conn.setReadTimeout(timeoutMs);
            conn.setRequestMethod("GET");
            conn.setRequestProperty("User-Agent", DEFAULT_UA);
            conn.setRequestProperty("Accept", accept != null ? accept : "*/*");
            conn.setRequestProperty("Accept-Language", "pt-BR,pt;q=0.9,en;q=0.8");

            String host = parsed.getHost() != null ? parsed.getHost().toLowerCase(Locale.ROOT) : "";
            boolean isFileVideo = host.contains("filevideo1.com");
            if (referer != null && isSafeHttpUrl(referer) && !(isFileVideo && referer.toLowerCase(Locale.ROOT).contains("csst.online"))) {
                conn.setRequestProperty("Referer", referer);
            }
            if (rangeHeader != null && !rangeHeader.isEmpty()) {
                conn.setRequestProperty("Range", rangeHeader);
            }

            int code = conn.getResponseCode();
            if (code >= 300 && code < 400) {
                String loc = conn.getHeaderField("Location");
                conn.disconnect();
                if (loc == null || loc.isEmpty()) {
                    throw new IOException("Redirecionamento sem destino.");
                }
                currentUrl = new URL(parsed, loc).toString();
                continue;
            }
            return new RedirectResult(conn, parsed.toString());
        }
        throw new IOException("Excesso de redirecionamentos.");
    }

    private String rewriteM3u8Playlist(String manifest, String baseManifestUrl, String referer) {
        String[] lines = manifest.split("\\r?\\n");
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < lines.length; i++) {
            String line = lines[i];
            String trimmed = line.trim();
            if (trimmed.isEmpty()) {
                sb.append(line);
            } else if (trimmed.startsWith("#")) {
                Matcher m = URI_ATTR_PATTERN.matcher(line);
                StringBuffer replaced = new StringBuffer();
                while (m.find()) {
                    String rawUri = m.group(1);
                    String replacement = m.group(0);
                    try {
                        String abs = new URL(new URL(baseManifestUrl), rawUri).toString();
                        if (isSafeHttpUrl(abs)) {
                            String host = new URL(abs).getHost();
                            if (host != null && DIRECT_HOSTS_PATTERN.matcher(host).find()) {
                                replacement = "URI=\"" + abs + "\"";
                            } else {
                                replacement = "URI=\"" + buildProxyUrl(abs, referer) + "\"";
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
                        String host = new URL(abs).getHost();
                        if (host != null && DIRECT_HOSTS_PATTERN.matcher(host).find()) {
                            sb.append(abs);
                        } else {
                            sb.append(buildProxyUrl(abs, referer));
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

    private String buildProxyUrl(String absUrl, String referer) {
        try {
            return "http://127.0.0.1:" + proxyPort + "/stream-proxy?url="
                + URLEncoder.encode(absUrl, "UTF-8")
                + "&referer=" + URLEncoder.encode(referer, "UTF-8");
        } catch (Exception e) {
            return absUrl;
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
