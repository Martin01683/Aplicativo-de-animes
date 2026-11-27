package com.topanimes.player;

import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Pure-Java protocol helpers for background TV casting:
 * - Google Cast V2 protobuf framing (Chromecast, Google TV, Android TV, Chromecast Built-in)
 * - DLNA / UPnP SSDP discovery, device XML parsing, DIDL-Lite metadata, and AVTransport/RenderingControl SOAP
 * - LAN HLS (.m3u8) playlist rewriting (never pointing to 127.0.0.1) and SRT -> WebVTT conversion
 *
 * Intentionally free of android.* and org.json.* dependencies so all protocol logic is directly
 * covered by JVM JUnit tests.
 */
public final class TvCastProtocol {
    public static final String PROTOCOL_CHROMECAST = "chromecast";
    public static final String PROTOCOL_DLNA = "dlna";

    public static final String CHROMECAST_DEFAULT_MEDIA_RECEIVER_APP_ID = "CC1AD845";
    public static final int CHROMECAST_DEFAULT_PORT = 8009;

    public static final String CAST_NS_CONNECTION = "urn:x-cast:com.google.cast.tp.connection";
    public static final String CAST_NS_HEARTBEAT = "urn:x-cast:com.google.cast.tp.heartbeat";
    public static final String CAST_NS_RECEIVER = "urn:x-cast:com.google.cast.receiver";
    public static final String CAST_NS_MEDIA = "urn:x-cast:com.google.cast.media";

    public static final String UPNP_AV_TRANSPORT_SERVICE = "urn:schemas-upnp-org:service:AVTransport:1";
    public static final String UPNP_RENDERING_CONTROL_SERVICE = "urn:schemas-upnp-org:service:RenderingControl:1";
    public static final String UPNP_MEDIA_RENDERER_DEVICE = "urn:schemas-upnp-org:device:MediaRenderer:1";
    public static final String SSDP_ALL_TARGET = "ssdp:all";
    public static final String MDNS_GOOGLECAST_QUERY = "_googlecast._tcp.local";

    private static final int MAX_CAST_FRAME_BYTES = 2 * 1024 * 1024;
    private static final Pattern M3U8_EXT_PATTERN = Pattern.compile("\\.m3u8(?:$|\\?)", Pattern.CASE_INSENSITIVE);
    private static final Pattern URI_ATTR_PATTERN = Pattern.compile("URI=\"([^\"]+)\"", Pattern.CASE_INSENSITIVE);
    private static final Pattern SRT_TIMESTAMP_LINE = Pattern.compile(
        "(\\d{1,2}:\\d{2}:\\d{2}),(\\d{1,3})(\\s*-->\\s*)(\\d{1,2}:\\d{2}:\\d{2}),(\\d{1,3})"
    );
    private static final Pattern VTT_TIMESTAMP_LINE = Pattern.compile(
        "(?:(\\d{1,2}):)?(\\d{2}):(\\d{2})\\.(\\d{1,3})(\\s*-->\\s*)(?:(\\d{1,2}):)?(\\d{2}):(\\d{2})\\.(\\d{1,3})([^\\n]*)"
    );
    private static final Pattern OFFLINE_ID_PATTERN = Pattern.compile("^[a-zA-Z0-9_-]{4,64}$");
    private static final Pattern OFFLINE_FILE_PATTERN = Pattern.compile("^[a-zA-Z0-9._-]{1,80}$");
    private static final Pattern UPNP_SERVICE_BLOCK = Pattern.compile(
        "<(?:[\\w-]+:)?service\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?service>",
        Pattern.CASE_INSENSITIVE
    );

    private TvCastProtocol() {
    }

    public static final class LocalOfflineAsset {
        public final String downloadId;
        public final String fileName;

        public LocalOfflineAsset(String downloadId, String fileName) {
            this.downloadId = safeStr(downloadId);
            this.fileName = safeStr(fileName);
        }
    }

    public static final class CastDevice {
        public final String id;
        public final String name;
        public final String manufacturer;
        public final String model;
        public final String host;
        public final int port;
        public final String protocol;
        public final String avTransportControlUrl;
        public final String renderingControlUrl;
        public final String locationUrl;

        public CastDevice(
            String id,
            String name,
            String manufacturer,
            String model,
            String host,
            int port,
            String protocol,
            String avTransportControlUrl,
            String renderingControlUrl,
            String locationUrl
        ) {
            this.id = safeStr(id);
            this.name = safeStr(name).isEmpty() ? safeStr(host) : safeStr(name);
            this.manufacturer = safeStr(manufacturer);
            this.model = safeStr(model);
            this.host = safeStr(host);
            this.port = port > 0 ? port : (PROTOCOL_CHROMECAST.equals(protocol) ? CHROMECAST_DEFAULT_PORT : 80);
            this.protocol = PROTOCOL_DLNA.equalsIgnoreCase(protocol)
                ? PROTOCOL_DLNA
                : "lan".equalsIgnoreCase(protocol)
                    ? "lan"
                    : PROTOCOL_CHROMECAST;
            this.avTransportControlUrl = safeStr(avTransportControlUrl);
            this.renderingControlUrl = safeStr(renderingControlUrl);
            this.locationUrl = safeStr(locationUrl);
        }
    }

    public static final class CastPacket {
        public final int protocolVersion;
        public final String sourceId;
        public final String destinationId;
        public final String namespace;
        public final int payloadType;
        public final String payloadUtf8;

        public CastPacket(
            int protocolVersion,
            String sourceId,
            String destinationId,
            String namespace,
            int payloadType,
            String payloadUtf8
        ) {
            this.protocolVersion = protocolVersion;
            this.sourceId = sourceId != null ? sourceId : "";
            this.destinationId = destinationId != null ? destinationId : "";
            this.namespace = namespace != null ? namespace : "";
            this.payloadType = payloadType;
            this.payloadUtf8 = payloadUtf8 != null ? payloadUtf8 : "";
        }
    }

    // -------------------------------------------------------------------------
    // Google Cast V2 Protobuf Framing
    // -------------------------------------------------------------------------

    public static byte[] encodeCastMessage(
        String sourceId,
        String destinationId,
        String namespace,
        String payloadUtf8
    ) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(256);
        // field 1: protocol_version = 0 (CASTV2_1_0)
        writeTag(out, 1, 0);
        writeVarint(out, 0);
        // field 2: source_id
        writeLengthDelimitedString(out, 2, sourceId != null ? sourceId : "");
        // field 3: destination_id
        writeLengthDelimitedString(out, 3, destinationId != null ? destinationId : "");
        // field 4: namespace
        writeLengthDelimitedString(out, 4, namespace != null ? namespace : "");
        // field 5: payload_type = 0 (STRING)
        writeTag(out, 5, 0);
        writeVarint(out, 0);
        // field 6: payload_utf8
        writeLengthDelimitedString(out, 6, payloadUtf8 != null ? payloadUtf8 : "");
        return out.toByteArray();
    }

    public static CastPacket decodeCastMessage(byte[] data) throws IOException {
        if (data == null) {
            throw new IOException("Empty CastMessage payload");
        }
        int protocolVersion = 0;
        String sourceId = "";
        String destinationId = "";
        String namespace = "";
        int payloadType = 0;
        String payloadUtf8 = "";

        int pos = 0;
        while (pos < data.length) {
            long[] tagRes = readVarint(data, pos);
            long tag = tagRes[0];
            pos = (int) tagRes[1];
            int fieldNumber = (int) (tag >>> 3);
            int wireType = (int) (tag & 0x07);

            if (wireType == 0) {
                long[] valRes = readVarint(data, pos);
                long val = valRes[0];
                pos = (int) valRes[1];
                if (fieldNumber == 1) {
                    protocolVersion = (int) val;
                } else if (fieldNumber == 5) {
                    payloadType = (int) val;
                }
            } else if (wireType == 2) {
                long[] lenRes = readVarint(data, pos);
                int len = (int) lenRes[0];
                pos = (int) lenRes[1];
                if (len < 0 || pos + len > data.length) {
                    throw new IOException("Truncated CastMessage length-delimited field");
                }
                if (fieldNumber == 2) {
                    sourceId = new String(data, pos, len, StandardCharsets.UTF_8);
                } else if (fieldNumber == 3) {
                    destinationId = new String(data, pos, len, StandardCharsets.UTF_8);
                } else if (fieldNumber == 4) {
                    namespace = new String(data, pos, len, StandardCharsets.UTF_8);
                } else if (fieldNumber == 6) {
                    payloadUtf8 = new String(data, pos, len, StandardCharsets.UTF_8);
                }
                pos += len;
            } else if (wireType == 1) {
                if (pos + 8 > data.length) throw new IOException("Truncated 64-bit field");
                pos += 8;
            } else if (wireType == 5) {
                if (pos + 4 > data.length) throw new IOException("Truncated 32-bit field");
                pos += 4;
            } else {
                throw new IOException("Unsupported protobuf wire type: " + wireType);
            }
        }

        return new CastPacket(protocolVersion, sourceId, destinationId, namespace, payloadType, payloadUtf8);
    }

    public static void writeFramedCastMessage(
        OutputStream out,
        String sourceId,
        String destinationId,
        String namespace,
        String payloadUtf8
    ) throws IOException {
        byte[] encoded = encodeCastMessage(sourceId, destinationId, namespace, payloadUtf8);
        DataOutputStream dos = new DataOutputStream(out);
        dos.writeInt(encoded.length);
        dos.write(encoded);
        dos.flush();
    }

    public static CastPacket readFramedCastMessage(InputStream in) throws IOException {
        DataInputStream dis = new DataInputStream(in);
        int length;
        try {
            length = dis.readInt();
        } catch (EOFException eof) {
            return null;
        }
        if (length <= 0 || length > MAX_CAST_FRAME_BYTES) {
            throw new IOException("Invalid CastMessage frame length: " + length);
        }
        byte[] buf = new byte[length];
        dis.readFully(buf);
        return decodeCastMessage(buf);
    }

    private static void writeTag(ByteArrayOutputStream out, int fieldNumber, int wireType) {
        writeVarint(out, ((long) fieldNumber << 3) | (wireType & 0x07));
    }

    private static void writeVarint(ByteArrayOutputStream out, long value) {
        long v = value;
        while ((v & ~0x7FL) != 0L) {
            out.write((int) ((v & 0x7FL) | 0x80L));
            v >>>= 7;
        }
        out.write((int) (v & 0x7FL));
    }

    private static void writeLengthDelimitedString(ByteArrayOutputStream out, int fieldNumber, String value) {
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        writeTag(out, fieldNumber, 2);
        writeVarint(out, bytes.length);
        out.write(bytes, 0, bytes.length);
    }

    private static long[] readVarint(byte[] data, int startPos) throws IOException {
        long result = 0L;
        int shift = 0;
        int pos = startPos;
        while (pos < data.length && shift < 64) {
            int b = data[pos++] & 0xFF;
            result |= (long) (b & 0x7F) << shift;
            if ((b & 0x80) == 0) {
                return new long[] { result, pos };
            }
            shift += 7;
        }
        throw new IOException("Malformed protobuf varint");
    }

    // -------------------------------------------------------------------------
    // DLNA / UPnP SSDP + Device XML + SOAP Helpers
    // -------------------------------------------------------------------------

    public static String buildSsdpSearchPacket(String searchTarget) {
        String st = safeStr(searchTarget).isEmpty() ? UPNP_AV_TRANSPORT_SERVICE : searchTarget.trim();
        return "M-SEARCH * HTTP/1.1\r\n"
            + "HOST: 239.255.255.250:1900\r\n"
            + "MAN: \"ssdp:discover\"\r\n"
            + "MX: 2\r\n"
            + "ST: " + st + "\r\n"
            + "USER-AGENT: Android/Anisync UPnP/1.1\r\n"
            + "\r\n";
    }

    public static Map<String, String> parseSsdpResponseHeaders(String rawPacket) {
        Map<String, String> headers = new HashMap<>();
        if (rawPacket == null || rawPacket.isEmpty()) return headers;
        String[] lines = rawPacket.split("\\r?\\n");
        for (int i = 1; i < lines.length; i++) {
            String line = lines[i].trim();
            if (line.isEmpty()) continue;
            int colon = line.indexOf(':');
            if (colon > 0) {
                String key = line.substring(0, colon).trim().toLowerCase(Locale.ROOT);
                String val = line.substring(colon + 1).trim();
                headers.put(key, val);
            }
        }
        return headers;
    }

    public static CastDevice parseUpnpDeviceDescription(String xml, String locationUrl) {
        if (xml == null || xml.trim().isEmpty() || locationUrl == null || locationUrl.trim().isEmpty()) {
            return null;
        }
        String urlBase = extractXmlTagValue(xml, "URLBase");
        String resolveBase = !urlBase.isEmpty() ? urlBase : locationUrl.trim();

        String avControl = "";
        String rcControl = "";

        Matcher svcMatcher = UPNP_SERVICE_BLOCK.matcher(xml);
        while (svcMatcher.find()) {
            String block = svcMatcher.group(1);
            String serviceType = extractXmlTagValue(block, "serviceType");
            String controlUrl = extractXmlTagValue(block, "controlURL");
            if (serviceType.isEmpty() || controlUrl.isEmpty()) continue;
            String lowerType = serviceType.toLowerCase(Locale.ROOT);
            if (avControl.isEmpty() && lowerType.contains("avtransport")) {
                avControl = resolveUpnpUrl(resolveBase, controlUrl);
            } else if (rcControl.isEmpty() && lowerType.contains("renderingcontrol")) {
                rcControl = resolveUpnpUrl(resolveBase, controlUrl);
            }
        }

        if (avControl.isEmpty()) {
            return null;
        }

        String friendlyName = unescapeXml(extractXmlTagValue(xml, "friendlyName"));
        String manufacturer = unescapeXml(extractXmlTagValue(xml, "manufacturer"));
        String modelName = unescapeXml(extractXmlTagValue(xml, "modelName"));
        String udn = extractXmlTagValue(xml, "UDN");

        String host = "";
        int port = 80;
        try {
            URL loc = new URL(locationUrl.trim());
            host = loc.getHost() != null ? loc.getHost() : "";
            port = loc.getPort() > 0 ? loc.getPort() : 80;
        } catch (Exception ignored) {
        }

        String id = !udn.isEmpty()
            ? ("dlna:" + udn)
            : ("dlna:" + host + ":" + port + ":" + avControl.hashCode());

        if (friendlyName.isEmpty()) {
            friendlyName = !modelName.isEmpty() ? modelName : ("Smart TV (" + host + ")");
        }

        return new CastDevice(
            id,
            friendlyName,
            manufacturer,
            modelName,
            host,
            port,
            PROTOCOL_DLNA,
            avControl,
            rcControl,
            locationUrl.trim()
        );
    }

    public static String resolveUpnpUrl(String baseUrl, String relativeOrAbsolute) {
        if (relativeOrAbsolute == null || relativeOrAbsolute.trim().isEmpty()) return "";
        try {
            return new URL(new URL(baseUrl.trim()), relativeOrAbsolute.trim()).toString();
        } catch (Exception e) {
            return relativeOrAbsolute.trim();
        }
    }

    public static String extractXmlTagValue(String xml, String localTagName) {
        if (xml == null || xml.isEmpty() || localTagName == null || localTagName.isEmpty()) return "";
        Pattern p = Pattern.compile(
            "<(?:[\\w-]+:)?" + Pattern.quote(localTagName) + "(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?"
                + Pattern.quote(localTagName) + ">",
            Pattern.CASE_INSENSITIVE
        );
        Matcher m = p.matcher(xml);
        if (m.find()) {
            return m.group(1) != null ? m.group(1).trim() : "";
        }
        return "";
    }

    public static String buildDidlLiteMetadata(
        String title,
        String seriesTitle,
        String posterUrl,
        String mediaUrl,
        String mimeType
    ) {
        return buildDidlLiteMetadata(title, seriesTitle, posterUrl, mediaUrl, mimeType, "", 0L, false);
    }

    public static String buildDidlLiteMetadata(
        String title,
        String seriesTitle,
        String posterUrl,
        String mediaUrl,
        String mimeType,
        String subtitleUrl
    ) {
        return buildDidlLiteMetadata(title, seriesTitle, posterUrl, mediaUrl, mimeType, subtitleUrl, 0L, false);
    }

    public static String buildDidlLiteMetadata(
        String title,
        String seriesTitle,
        String posterUrl,
        String mediaUrl,
        String mimeType,
        String subtitleUrl,
        long durationMs,
        boolean continuousRelay
    ) {
        String safeTitle = escapeXml(safeStr(title).isEmpty() ? "Anisync" : title.trim());
        String safeSeries = escapeXml(safeStr(seriesTitle));
        String safeMime = safeStr(mimeType).isEmpty() ? "video/mp4" : mimeType.trim();
        String safeUrl = escapeXml(safeStr(mediaUrl));
        String safeSubUrl = escapeXml(safeStr(subtitleUrl));
        StringBuilder sb = new StringBuilder(512);
        sb.append("<DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" ")
            .append("xmlns:dc=\"http://purl.org/dc/elements/1.1/\" ")
            .append("xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\"");
        if (!safeSubUrl.isEmpty()) {
            sb.append(" xmlns:sec=\"http://www.sec.co.kr/\"");
        }
        sb.append("><item id=\"0\" parentID=\"-1\" restricted=\"1\">")
            .append("<dc:title>").append(safeTitle).append("</dc:title>");
        if (!safeSeries.isEmpty()) {
            sb.append("<upnp:seriesTitle>").append(safeSeries).append("</upnp:seriesTitle>");
        }
        if (posterUrl != null && !posterUrl.trim().isEmpty()) {
            sb.append("<upnp:albumArtURI>").append(escapeXml(posterUrl.trim())).append("</upnp:albumArtURI>");
        }
        String dlnaOp = continuousRelay
            ? (durationMs > 0L ? "10" : "00")
            : (safeMime.toLowerCase(Locale.ROOT).contains("mpegurl") ? "10" : "01");
        String dlnaCi = continuousRelay ? "1" : "0";
        sb.append("<upnp:class>object.item.videoItem.movie</upnp:class>")
            .append("<res protocolInfo=\"http-get:*:").append(escapeXml(safeMime))
            .append(":DLNA.ORG_OP=").append(dlnaOp)
            .append(";DLNA.ORG_CI=").append(dlnaCi)
            .append(";DLNA.ORG_FLAGS=01700000000000000000000000000000\"");
        if (durationMs > 0L) {
            sb.append(" duration=\"").append(formatDlnaTime(durationMs)).append('"');
        }
        sb.append('>').append(safeUrl).append("</res>");
        if (!safeSubUrl.isEmpty()) {
            String subMime = safeSubUrl.toLowerCase(Locale.ROOT).endsWith(".vtt") ? "text/vtt" : "text/srt";
            String secType = "text/vtt".equals(subMime) ? "vtt" : "srt";
            sb.append("<res protocolInfo=\"http-get:*:").append(subMime).append(":*\">")
                .append(safeSubUrl).append("</res>")
                .append("<sec:CaptionInfoEx sec:type=\"").append(secType).append("\">")
                .append(safeSubUrl).append("</sec:CaptionInfoEx>")
                .append("<sec:CaptionInfo sec:type=\"").append(secType).append("\">")
                .append(safeSubUrl).append("</sec:CaptionInfo>");
        }
        sb.append("</item></DIDL-Lite>");
        return sb.toString();
    }

    /**
     * Minimal UPnP DIDL-Lite metadata without strict DLNA.ORG_* flags or vendor extensions,
     * used as a fallback when a Smart TV rejects full DLNA flags on SetAVTransportURI.
     */
    public static String buildMinimalDidlLiteMetadata(
        String title,
        String mediaUrl,
        String mimeType,
        long durationMs
    ) {
        String safeTitle = escapeXml(safeStr(title).isEmpty() ? "Anisync" : title.trim());
        String safeMime = safeStr(mimeType).isEmpty() ? "video/mp4" : mimeType.trim();
        String safeUrl = escapeXml(safeStr(mediaUrl));
        StringBuilder sb = new StringBuilder(320);
        sb.append("<DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" ")
            .append("xmlns:dc=\"http://purl.org/dc/elements/1.1/\" ")
            .append("xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\">")
            .append("<item id=\"0\" parentID=\"-1\" restricted=\"1\">")
            .append("<dc:title>").append(safeTitle).append("</dc:title>")
            .append("<upnp:class>object.item.videoItem</upnp:class>")
            .append("<res protocolInfo=\"http-get:*:").append(escapeXml(safeMime)).append(":*\"");
        if (durationMs > 0L) {
            sb.append(" duration=\"").append(formatDlnaTime(durationMs)).append('"');
        }
        sb.append('>').append(safeUrl).append("</res>")
            .append("</item></DIDL-Lite>");
        return sb.toString();
    }

    /**
     * Extracts UPnP SOAP fault details (e.g. "714: Illegal MIME-type") from a TV HTTP 500 error body.
     */
    public static String extractUpnpSoapFaultDetail(String responseXml) {
        if (responseXml == null || responseXml.trim().isEmpty()) return "";
        String code = extractXmlTagValue(responseXml, "errorCode");
        String desc = unescapeXml(extractXmlTagValue(responseXml, "errorDescription"));
        if (!code.isEmpty() && !desc.isEmpty()) {
            return code + ": " + desc;
        }
        if (!code.isEmpty()) return "UPnP " + code;
        if (!desc.isEmpty()) return desc;
        return "";
    }

    /**
     * Smart TV built-in DLNA MediaRenderers (notably LG webOS, Samsung Tizen, Sony BRAVIA,
     * Philips, and Panasonic) reject HLS (.m3u8 / application/x-mpegurl) in SetAVTransportURI
     * with HTTP 500 / UPnP 714 (Illegal MIME-type), while natively playing MPEG-TS (video/mp2t)
     * and MP4 (video/mp4).
     */
    public static boolean isLikelyHlsUnsupportedDlnaDevice(CastDevice device) {
        if (device == null || !PROTOCOL_DLNA.equalsIgnoreCase(device.protocol)) return false;
        String combined = (safeStr(device.name) + " " + safeStr(device.manufacturer) + " " + safeStr(device.model))
            .toLowerCase(Locale.ROOT);
        return combined.contains("lg")
            || combined.contains("webos")
            || combined.contains("netcast")
            || combined.contains("samsung")
            || combined.contains("tizen")
            || combined.contains("bravia")
            || combined.contains("sony")
            || combined.contains("philips")
            || combined.contains("panasonic")
            || combined.contains("vizio")
            || combined.contains("hisense")
            || combined.contains("vidaa");
    }

    public static String buildSoapEnvelope(
        String serviceType,
        String actionName,
        Map<String, String> args
    ) {
        StringBuilder sb = new StringBuilder(512);
        sb.append("<?xml version=\"1.0\" encoding=\"utf-8\"?>")
            .append("<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" ")
            .append("s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">")
            .append("<s:Body>")
            .append("<u:").append(actionName).append(" xmlns:u=\"").append(serviceType).append("\">");
        if (args != null) {
            for (Map.Entry<String, String> entry : args.entrySet()) {
                sb.append('<').append(entry.getKey()).append('>')
                    .append(escapeXml(entry.getValue() != null ? entry.getValue() : ""))
                    .append("</").append(entry.getKey()).append('>');
            }
        }
        sb.append("</u:").append(actionName).append("></s:Body></s:Envelope>");
        return sb.toString();
    }

    public static String formatDlnaTime(long positionMs) {
        long totalSec = Math.max(0L, positionMs) / 1000L;
        long h = totalSec / 3600L;
        long m = (totalSec % 3600L) / 60L;
        long s = totalSec % 60L;
        return String.format(Locale.ROOT, "%02d:%02d:%02d", h, m, s);
    }

    public static long parseDlnaTimeMs(String raw) {
        if (raw == null) return -1L;
        String clean = raw.trim();
        if (clean.isEmpty() || "NOT_IMPLEMENTED".equalsIgnoreCase(clean)) return -1L;
        String[] parts = clean.split(":");
        if (parts.length != 3) return -1L;
        try {
            long h = Long.parseLong(parts[0].trim());
            long m = Long.parseLong(parts[1].trim());
            double s = Double.parseDouble(parts[2].trim());
            if (h < 0L || m < 0L || s < 0.0) return -1L;
            return Math.round(((h * 3600L) + (m * 60L) + s) * 1000.0);
        } catch (NumberFormatException e) {
            return -1L;
        }
    }

    public static double parseDlnaVolumeLevel(String xml) {
        if (xml == null || xml.isEmpty()) return -1.0;
        String raw = extractXmlTagValue(xml, "CurrentVolume").trim();
        if (raw.isEmpty()) return -1.0;
        try {
            double pct = Double.parseDouble(raw);
            if (!Double.isFinite(pct) || pct < 0.0) return -1.0;
            return Math.max(0.0, Math.min(1.0, pct / 100.0));
        } catch (NumberFormatException e) {
            return -1.0;
        }
    }

    public static Boolean parseDlnaMuteState(String xml) {
        if (xml == null || xml.isEmpty()) return null;
        String raw = extractXmlTagValue(xml, "CurrentMute").trim().toLowerCase(Locale.ROOT);
        if ("1".equals(raw) || "true".equals(raw)) return Boolean.TRUE;
        if ("0".equals(raw) || "false".equals(raw)) return Boolean.FALSE;
        return null;
    }

    public static String escapeXml(String raw) {
        if (raw == null || raw.isEmpty()) return "";
        StringBuilder sb = new StringBuilder(raw.length() + 16);
        for (int i = 0; i < raw.length(); i++) {
            char c = raw.charAt(i);
            switch (c) {
                case '&':
                    sb.append("&amp;");
                    break;
                case '<':
                    sb.append("&lt;");
                    break;
                case '>':
                    sb.append("&gt;");
                    break;
                case '"':
                    sb.append("&quot;");
                    break;
                case '\'':
                    sb.append("&apos;");
                    break;
                default:
                    sb.append(c);
                    break;
            }
        }
        return sb.toString();
    }

    public static String unescapeXml(String raw) {
        if (raw == null || raw.isEmpty()) return "";
        return raw
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&apos;", "'");
    }

    // -------------------------------------------------------------------------
    // Stream Type, LAN M3U8 Rewriting & Subtitle SRT -> VTT Conversion
    // -------------------------------------------------------------------------

    public static boolean isHlsStreamUrl(String url, String format) {
        if (format != null && "hls".equalsIgnoreCase(format.trim())) return true;
        return url != null && M3U8_EXT_PATTERN.matcher(url).find();
    }

    public static String inferStreamMimeType(String url, String format) {
        if (isHlsStreamUrl(url, format)) {
            return "application/x-mpegurl";
        }
        String lowerUrl = safeStr(url).toLowerCase(Locale.ROOT);
        int q = lowerUrl.indexOf('?');
        String path = q >= 0 ? lowerUrl.substring(0, q) : lowerUrl;
        if (path.endsWith(".ts") || path.endsWith(".m2ts")) return "video/mp2t";
        if (path.endsWith(".mkv")) return "video/x-matroska";
        if (path.endsWith(".webm")) return "video/webm";
        return "video/mp4";
    }

    /**
     * Normalizes upstream HTTP Content-Type headers so DLNA Smart TVs (such as LG webOS)
     * never reject a valid video stream due to generic/disguised MIME types like
     * application/octet-stream, binary/octet-stream, text/plain, or image/*.
     */
    public static String normalizeDlnaVideoMimeType(String rawContentType, String url, String format) {
        if (rawContentType != null && !rawContentType.trim().isEmpty()) {
            String base = rawContentType.trim().toLowerCase(Locale.ROOT);
            int semi = base.indexOf(';');
            if (semi >= 0) {
                base = base.substring(0, semi).trim();
            }
            if (base.startsWith("video/") && !"video/unknown".equals(base)) {
                return base;
            }
        }
        String inferred = inferStreamMimeType(url, format);
        if ("application/x-mpegurl".equalsIgnoreCase(inferred)) {
            return "video/mp2t";
        }
        return inferred;
    }

    public static final class HlsSegmentEntry {
        public final String url;
        public final long startMs;
        public final long durationMs;
        public final long mediaSequence;
        public final String keyMethod;
        public final String keyUri;
        public final String keyIvHex;

        public HlsSegmentEntry(
            String url,
            long startMs,
            long durationMs,
            long mediaSequence,
            String keyMethod,
            String keyUri,
            String keyIvHex
        ) {
            this.url = safeStr(url);
            this.startMs = Math.max(0L, startMs);
            this.durationMs = Math.max(0L, durationMs);
            this.mediaSequence = Math.max(0L, mediaSequence);
            this.keyMethod = safeStr(keyMethod);
            this.keyUri = safeStr(keyUri);
            this.keyIvHex = safeStr(keyIvHex);
        }
    }

    public static final class HlsPlaylistInfo {
        public final boolean isMaster;
        public final String bestVariantUrl;
        public final String initMapUrl;
        public final long totalDurationMs;
        public final List<HlsSegmentEntry> segments;

        public HlsPlaylistInfo(
            boolean isMaster,
            String bestVariantUrl,
            String initMapUrl,
            long totalDurationMs,
            List<HlsSegmentEntry> segments
        ) {
            this.isMaster = isMaster;
            this.bestVariantUrl = safeStr(bestVariantUrl);
            this.initMapUrl = safeStr(initMapUrl);
            this.totalDurationMs = Math.max(0L, totalDurationMs);
            this.segments = segments != null ? segments : new ArrayList<>();
        }
    }

    /**
     * Parses an HLS master or media playlist into either its best variant URL (master)
     * or ordered segment timeline with #EXTINF durations, #EXT-X-KEY metadata, and optional
     * #EXT-X-MAP init segment so DLNA TVs without native .m3u8 support can play it as a
     * continuous MPEG-TS (video/mp2t) or fragmented MP4 (video/mp4) stream.
     */
    public static HlsPlaylistInfo parseHlsPlaylistForDlna(String manifest, String baseUrl) {
        List<HlsSegmentEntry> segments = new ArrayList<>();
        if (manifest == null || manifest.trim().isEmpty()) {
            return new HlsPlaylistInfo(false, "", "", 0L, segments);
        }
        String[] lines = manifest.split("\\r?\\n");
        if (manifest.contains("#EXT-X-STREAM-INF")) {
            String bestUrl = "";
            long bestScore = -1L;
            for (int i = 0; i < lines.length; i++) {
                String line = lines[i].trim();
                if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;
                long bw = 0L;
                long height = 0L;
                Matcher bwM = Pattern.compile("BANDWIDTH=\\s*(\\d+)", Pattern.CASE_INSENSITIVE).matcher(line);
                if (bwM.find()) {
                    try {
                        bw = Long.parseLong(bwM.group(1));
                    } catch (NumberFormatException ignored) {
                    }
                }
                Matcher resM = Pattern.compile("RESOLUTION=\\s*\\d+x(\\d+)", Pattern.CASE_INSENSITIVE).matcher(line);
                if (resM.find()) {
                    try {
                        height = Long.parseLong(resM.group(1));
                    } catch (NumberFormatException ignored) {
                    }
                }
                String nextUri = "";
                for (int j = i + 1; j < lines.length; j++) {
                    String cand = lines[j].trim();
                    if (cand.isEmpty()) continue;
                    if (cand.startsWith("#")) {
                        if (cand.startsWith("#EXT-X-STREAM-INF:")) break;
                        continue;
                    }
                    nextUri = cand;
                    i = j;
                    break;
                }
                if (nextUri.isEmpty()) continue;
                String abs = resolvePlaylistUri(baseUrl, nextUri);
                if (abs.isEmpty()) continue;
                long score = (height * 100_000_000L) + bw;
                if (bestUrl.isEmpty() || score > bestScore) {
                    bestUrl = abs;
                    bestScore = score;
                }
            }
            return new HlsPlaylistInfo(true, bestUrl, "", 0L, segments);
        }

        long mediaSeq = 0L;
        long cursorMs = 0L;
        long pendingDurMs = 0L;
        String currentKeyMethod = "";
        String currentKeyUri = "";
        String currentKeyIv = "";
        String initMapUrl = "";

        for (String rawLine : lines) {
            String line = rawLine.trim();
            if (line.isEmpty()) continue;
            if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
                String num = line.substring("#EXT-X-MEDIA-SEQUENCE:".length()).trim();
                try {
                    mediaSeq = Math.max(0L, Long.parseLong(num));
                } catch (NumberFormatException ignored) {
                }
            } else if (line.startsWith("#EXT-X-MAP:")) {
                Matcher uriM = URI_ATTR_PATTERN.matcher(line);
                if (uriM.find() && initMapUrl.isEmpty()) {
                    initMapUrl = resolvePlaylistUri(baseUrl, uriM.group(1));
                }
            } else if (line.startsWith("#EXT-X-KEY:")) {
                Matcher methodM = Pattern.compile("METHOD=([^,\\s]+)", Pattern.CASE_INSENSITIVE).matcher(line);
                String method = methodM.find() ? methodM.group(1).trim().toUpperCase(Locale.ROOT) : "";
                if ("NONE".equals(method) || method.isEmpty()) {
                    currentKeyMethod = "";
                    currentKeyUri = "";
                    currentKeyIv = "";
                } else {
                    currentKeyMethod = method;
                    Matcher uriM = URI_ATTR_PATTERN.matcher(line);
                    currentKeyUri = uriM.find() ? resolvePlaylistUri(baseUrl, uriM.group(1)) : "";
                    Matcher ivM = Pattern.compile("IV=0x([0-9a-fA-F]+)", Pattern.CASE_INSENSITIVE).matcher(line);
                    currentKeyIv = ivM.find() ? ivM.group(1).trim() : "";
                }
            } else if (line.startsWith("#EXTINF:")) {
                String rest = line.substring("#EXTINF:".length()).trim();
                int comma = rest.indexOf(',');
                if (comma >= 0) rest = rest.substring(0, comma).trim();
                try {
                    double sec = Double.parseDouble(rest);
                    if (Double.isFinite(sec) && sec > 0.0) {
                        pendingDurMs = Math.round(sec * 1000.0);
                    }
                } catch (NumberFormatException ignored) {
                }
            } else if (!line.startsWith("#")) {
                String segUrl = resolvePlaylistUri(baseUrl, line);
                if (!segUrl.isEmpty()) {
                    long seq = mediaSeq + segments.size();
                    long dur = pendingDurMs > 0L ? pendingDurMs : 4000L;
                    segments.add(new HlsSegmentEntry(
                        segUrl,
                        cursorMs,
                        dur,
                        seq,
                        currentKeyMethod,
                        currentKeyUri,
                        currentKeyIv
                    ));
                    cursorMs += dur;
                    pendingDurMs = 0L;
                }
            }
        }

        return new HlsPlaylistInfo(false, "", initMapUrl, cursorMs, segments);
    }

    private static String resolvePlaylistUri(String baseUrl, String rawUri) {
        String clean = safeStr(rawUri);
        if (clean.isEmpty()) return "";
        if (isSupportedCastSourceUrl(clean)) return clean;
        try {
            String abs = new URL(new URL(baseUrl), clean).toString();
            return isSupportedCastSourceUrl(abs) ? abs : "";
        } catch (Exception e) {
            return "";
        }
    }

    public static int findHlsSegmentIndexForTimeMs(List<HlsSegmentEntry> segments, long targetMs) {
        if (segments == null || segments.isEmpty() || targetMs <= 0L) return 0;
        for (int i = 0; i < segments.size(); i++) {
            HlsSegmentEntry seg = segments.get(i);
            if (targetMs < seg.startMs + seg.durationMs) {
                return i;
            }
        }
        return segments.size() - 1;
    }

    /**
     * Direction-aware HLS segment index lookup for DLNA continuous relay seeking.
     * Prevents small forward skips (+5s) inside a 6-10s segment from flooring back
     * to the start of the current segment (or jumping all the way back to 0:00).
     */
    public static int findHlsSegmentIndexForSeek(
        List<HlsSegmentEntry> segments,
        long currentPosMs,
        long targetMs
    ) {
        if (segments == null || segments.isEmpty() || targetMs <= 1500L) return 0;
        int lastIdx = segments.size() - 1;
        int baseIdx = findHlsSegmentIndexForTimeMs(segments, targetMs);
        long safeCur = Math.max(0L, currentPosMs);
        int curIdx = findHlsSegmentIndexForTimeMs(segments, safeCur);
        long deltaMs = targetMs - safeCur;

        if (deltaMs > 0L && deltaMs <= 20_000L) {
            // Forward skip (+5s / +10s / +15s): always advance to a segment AFTER currentPosMs when possible
            int candidate = baseIdx;
            if (candidate <= curIdx && curIdx < lastIdx) {
                candidate = curIdx + 1;
            }
            while (candidate < lastIdx && segments.get(candidate).startMs < safeCur) {
                candidate++;
            }
            return Math.min(lastIdx, Math.max(0, candidate));
        }

        if (deltaMs < 0L && -deltaMs <= 20_000L) {
            // Backward skip (-5s / -10s / -15s): step to an earlier segment when floored start isn't actually earlier
            int candidate = baseIdx;
            if (candidate >= curIdx && curIdx > 0 && segments.get(candidate).startMs >= safeCur - 1500L) {
                candidate = curIdx - 1;
            }
            return Math.min(lastIdx, Math.max(0, candidate));
        }

        // Scrub / large jump (+85s or slider drag): pick the nearest segment boundary
        if (baseIdx < lastIdx) {
            long distCurr = Math.abs(targetMs - segments.get(baseIdx).startMs);
            long distNext = Math.abs(segments.get(baseIdx + 1).startMs - targetMs);
            if (distNext < distCurr) {
                return baseIdx + 1;
            }
        }
        return Math.min(lastIdx, Math.max(0, baseIdx));
    }

    /**
     * Computes real playback position for a continuous HLS -> MPEG-TS/fMP4 DLNA relay across all TV quirks:
     * 1. TVs reporting original MPEG-TS PTS (e.g. 00:05:02 after seeking to 00:05:00):
     *    `baseOffsetMs + (rawTvPosMs - firstRawTvPosMs)` avoids double-counting baseOffsetMs.
     * 2. TVs reporting relative stream time (00:00:00, 00:00:01, ...):
     *    `firstRawTvPosMs` is ~0, so `baseOffsetMs + (rawTvPosMs - firstRawTvPosMs)` equals `baseOffsetMs + rawTvPosMs`.
     * 3. TVs reporting 00:00:00 or NOT_IMPLEMENTED on chunked TS streams:
     *    falls back smoothly to our synchronized wall clock while PLAYING and freezes on PAUSED/BUFFERING.
     */
    public static long resolveHlsRelayPositionMs(
        long baseOffsetMs,
        long rawTvPosMs,
        long firstRawTvPosMs,
        boolean rawPosAdvancing,
        long anchorPosMs,
        long anchorWallMs,
        long nowMs,
        long totalDurationMs,
        boolean isPlaying
    ) {
        long safeBase = Math.max(0L, baseOffsetMs);
        long computed;
        if (rawPosAdvancing && rawTvPosMs >= 0L && firstRawTvPosMs >= 0L) {
            long delta = Math.max(0L, rawTvPosMs - firstRawTvPosMs);
            computed = safeBase + delta;
        } else if (isPlaying && anchorWallMs > 0L && nowMs >= anchorWallMs) {
            computed = Math.max(safeBase, anchorPosMs) + (nowMs - anchorWallMs);
        } else {
            computed = Math.max(safeBase, anchorPosMs);
        }
        if (totalDurationMs > 0L && computed > totalDurationMs) {
            return totalDurationMs;
        }
        return Math.max(0L, computed);
    }

    /**
     * Parses a single HTTP `Range: bytes=start-end` header against a known total length.
     * Returns `{ start, end }` inclusive, or `null` if absent/invalid.
     */
    public static long[] parseHttpByteRangeHeader(String rangeHeader, long totalLength) {
        if (rangeHeader == null || totalLength <= 0L) return null;
        String clean = rangeHeader.trim();
        if (!clean.toLowerCase(Locale.ROOT).startsWith("bytes=")) return null;
        String spec = clean.substring(6).trim();
        int comma = spec.indexOf(',');
        if (comma > 0) spec = spec.substring(0, comma).trim();
        int dash = spec.indexOf('-');
        if (dash < 0) return null;
        String startPart = spec.substring(0, dash).trim();
        String endPart = spec.substring(dash + 1).trim();
        try {
            long start;
            long end;
            if (!startPart.isEmpty()) {
                start = Long.parseLong(startPart);
                end = !endPart.isEmpty()
                    ? Math.min(Long.parseLong(endPart), totalLength - 1L)
                    : (totalLength - 1L);
            } else if (!endPart.isEmpty()) {
                long suffix = Long.parseLong(endPart);
                if (suffix <= 0L) return null;
                start = Math.max(0L, totalLength - suffix);
                end = totalLength - 1L;
            } else {
                return null;
            }
            if (start < 0L || start >= totalLength || start > end) return null;
            return new long[] { start, end };
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /**
     * Parses a DLNA `TimeSeekRange.dlna.org` request header (e.g. `npt=557.000-`,
     * `npt=00:09:17.000-00:26:01.000`, `npt=0-`) and returns the requested start time in milliseconds,
     * or `-1L` if absent or invalid.
     */
    public static long parseDlnaTimeSeekRangeStartMs(String headerValue) {
        if (headerValue == null || headerValue.trim().isEmpty()) return -1L;
        String clean = headerValue.trim();
        int eq = clean.toLowerCase(Locale.ROOT).indexOf("npt=");
        if (eq < 0) return -1L;
        String spec = clean.substring(eq + 4).trim();
        int space = spec.indexOf(' ');
        if (space > 0) spec = spec.substring(0, space).trim();
        int slash = spec.indexOf('/');
        if (slash > 0) spec = spec.substring(0, slash).trim();
        int dash = spec.indexOf('-');
        String startToken = (dash >= 0 ? spec.substring(0, dash) : spec).trim();
        if (startToken.isEmpty()) return -1L;
        if (startToken.contains(":")) {
            return parseDlnaTimeMs(startToken);
        }
        try {
            double seconds = Double.parseDouble(startToken);
            if (!Double.isFinite(seconds) || seconds < 0.0) return -1L;
            return Math.round(seconds * 1000.0);
        } catch (NumberFormatException e) {
            return -1L;
        }
    }

    /**
     * Formats a DLNA Guidelines §7.5.4.3.2 `TimeSeekRange.dlna.org` response header
     * (`npt=557.000-1561.000/1561.000` or `npt=00:09:17.000-00:26:01.000/00:26:01.000`)
     * so Smart TVs (notably LG webOS) display the exact real playback timestamp on their HUD.
     */
    public static String formatDlnaTimeSeekRangeHeader(
        long startMs,
        long totalDurationMs,
        boolean useClockFormat
    ) {
        if (totalDurationMs <= 0L) return "";
        long safeStart = Math.max(0L, Math.min(startMs, totalDurationMs));
        long safeTotal = Math.max(safeStart, totalDurationMs);
        if (useClockFormat) {
            String startStr = formatDlnaNptClock(safeStart);
            String totalStr = formatDlnaNptClock(safeTotal);
            return "npt=" + startStr + "-" + totalStr + "/" + totalStr;
        }
        String startStr = String.format(Locale.ROOT, "%.3f", safeStart / 1000.0);
        String totalStr = String.format(Locale.ROOT, "%.3f", safeTotal / 1000.0);
        return "npt=" + startStr + "-" + totalStr + "/" + totalStr;
    }

    private static String formatDlnaNptClock(long ms) {
        long clamped = Math.max(0L, ms);
        long totalSec = clamped / 1000L;
        long millis = clamped % 1000L;
        long hours = totalSec / 3600L;
        long minutes = (totalSec % 3600L) / 60L;
        long seconds = totalSec % 60L;
        return String.format(Locale.ROOT, "%02d:%02d:%02d.%03d", hours, minutes, seconds, millis);
    }

    /**
     * Builds the primary notification/MediaSession title showing the anime and episode cleanly
     * without duplicating the series name when already embedded in episodeTitle.
     */
    public static String buildNotificationTitle(String episodeTitle, String seriesTitle) {
        String ep = safeStr(episodeTitle);
        String series = safeStr(seriesTitle);
        if (ep.isEmpty() && series.isEmpty()) return "Transmitindo para TV";
        if (ep.isEmpty()) return series;
        if (series.isEmpty()) return ep;
        if (ep.toLowerCase(Locale.ROOT).contains(series.toLowerCase(Locale.ROOT))) {
            return ep;
        }
        return series + " · " + ep;
    }

    /**
     * Builds a concise YouTube-style metadata subtitle showing anime info (quality, audio, TV name).
     */
    public static String buildNotificationSubtitle(
        String seriesTitle,
        String episodeTitle,
        String qualityLabel,
        String audioLabel,
        String deviceName
    ) {
        List<String> parts = new ArrayList<>();
        String ep = safeStr(episodeTitle);
        String series = safeStr(seriesTitle);
        if (!series.isEmpty() && !ep.isEmpty() && ep.toLowerCase(Locale.ROOT).equals(series.toLowerCase(Locale.ROOT))) {
            // already exact title, skip redundant series
        }
        String q = safeStr(qualityLabel);
        if (!q.isEmpty()) {
            parts.add(q);
        }
        String a = safeStr(audioLabel);
        if (!a.isEmpty()) {
            String lowerA = a.toLowerCase(Locale.ROOT);
            if (lowerA.contains("dublad")) {
                parts.add("DUB");
            } else if (lowerA.contains("legendad")) {
                parts.add("LEG");
            } else {
                parts.add(a);
            }
        }
        String dev = safeStr(deviceName);
        if (!dev.isEmpty()) {
            parts.add(dev);
        } else {
            parts.add("TV");
        }
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < parts.size(); i++) {
            if (i > 0) sb.append(" · ");
            sb.append(parts.get(i));
        }
        return sb.toString();
    }

    public static byte[] buildAes128IvBytes(String keyIvHex, long mediaSequence) {
        byte[] iv = new byte[16];
        String hex = safeStr(keyIvHex);
        if (!hex.isEmpty()) {
            if (hex.startsWith("0x") || hex.startsWith("0X")) {
                hex = hex.substring(2);
            }
            if (hex.length() > 32) {
                hex = hex.substring(hex.length() - 32);
            }
            while (hex.length() < 32) {
                hex = "0" + hex;
            }
            try {
                for (int i = 0; i < 16; i++) {
                    iv[i] = (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
                }
                return iv;
            } catch (NumberFormatException ignored) {
            }
        }
        long seq = Math.max(0L, mediaSequence);
        for (int i = 15; i >= 8; i--) {
            iv[i] = (byte) (seq & 0xFFL);
            seq >>>= 8;
        }
        return iv;
    }

    public static boolean isSafeExternalHttpUrl(String rawUrl) {
        if (rawUrl == null || rawUrl.trim().isEmpty()) return false;
        String trimmed = rawUrl.trim();
        try {
            URI uri = URI.create(trimmed);
            String scheme = uri.getScheme() != null ? uri.getScheme().toLowerCase(Locale.ROOT) : "";
            if (!"http".equals(scheme) && !"https".equals(scheme)) return false;
            String host = uri.getHost() != null ? uri.getHost().toLowerCase(Locale.ROOT) : "";
            if (!host.isEmpty()) {
                return !host.equals("localhost") && !host.equals("127.0.0.1") && !host.equals("::1");
            }
        } catch (Exception ignored) {
        }
        try {
            URL url = new URL(trimmed);
            String scheme = url.getProtocol() != null ? url.getProtocol().toLowerCase(Locale.ROOT) : "";
            if (!"http".equals(scheme) && !"https".equals(scheme)) return false;
            String host = url.getHost() != null ? url.getHost().toLowerCase(Locale.ROOT) : "";
            if (host.isEmpty()) return false;
            return !host.equals("localhost") && !host.equals("127.0.0.1") && !host.equals("::1");
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Presigned S3 / Cloudflare R2 GET URLs (such as Hinata Soul's R2 streams) are signed
     * specifically for the GET verb and reject HEAD with HTTP 403 SignatureDoesNotMatch.
     * DLNA Smart TVs (notably LG webOS) issue HEAD before playback, so the LAN proxy should
     * satisfy HEAD via a 1-byte GET Range probe instead of forwarding HEAD upstream.
     */
    public static boolean shouldAvoidUpstreamHead(String rawUrl) {
        if (rawUrl == null || rawUrl.trim().isEmpty()) return false;
        String lower = rawUrl.trim().toLowerCase(Locale.ROOT);
        return lower.contains("r2.cloudflarestorage.com")
            || lower.contains("x-amz-signature=")
            || lower.contains("x-amz-credential=")
            || lower.contains("awsaccesskeyid=")
            || lower.contains("googleaccessid=");
    }

    /**
     * Extracts the total byte length from an HTTP Content-Range header (e.g. "bytes 0-0/314572800" -> 314572800).
     */
    public static long parseTotalLengthFromContentRange(String contentRange) {
        if (contentRange == null || contentRange.trim().isEmpty()) return -1L;
        int slash = contentRange.lastIndexOf('/');
        if (slash < 0 || slash + 1 >= contentRange.length()) return -1L;
        String totalPart = contentRange.substring(slash + 1).trim();
        if (totalPart.isEmpty() || "*".equals(totalPart)) return -1L;
        try {
            long val = Long.parseLong(totalPart);
            return val >= 0L ? val : -1L;
        } catch (NumberFormatException e) {
            return -1L;
        }
    }

    /**
     * Parses a local offline media URL served by LocalProxyPlugin (e.g.
     * http://127.0.0.1:<port>/offline/<downloadId>/<fileName>) with strict path validation
     * so TvCastService can serve downloaded episodes directly to TVs over the LAN proxy.
     */
    public static LocalOfflineAsset parseLocalOfflineAsset(String rawUrl) {
        if (rawUrl == null || rawUrl.trim().isEmpty()) return null;
        try {
            URI uri = URI.create(rawUrl.trim());
            String scheme = uri.getScheme() != null ? uri.getScheme().toLowerCase(Locale.ROOT) : "";
            if (!"http".equals(scheme)) return null;
            String host = uri.getHost() != null ? uri.getHost().toLowerCase(Locale.ROOT) : "";
            if (!"127.0.0.1".equals(host) && !"localhost".equals(host)) return null;
            String path = uri.getPath();
            if (path == null || !path.startsWith("/offline/")) return null;
            String rel = path.substring("/offline/".length());
            int slash = rel.indexOf('/');
            if (slash <= 0 || slash >= rel.length() - 1) return null;
            String downloadId = rel.substring(0, slash);
            String fileName = rel.substring(slash + 1);
            if (!isSafeOfflineAssetName(downloadId, fileName)) return null;
            return new LocalOfflineAsset(downloadId, fileName);
        } catch (Exception e) {
            return null;
        }
    }

    public static boolean isSafeOfflineAssetName(String downloadId, String fileName) {
        if (downloadId == null || fileName == null) return false;
        return OFFLINE_ID_PATTERN.matcher(downloadId).matches()
            && OFFLINE_FILE_PATTERN.matcher(fileName).matches()
            && !fileName.contains("..")
            && !fileName.startsWith(".");
    }

    public static boolean isSupportedCastSourceUrl(String rawUrl) {
        return isSafeExternalHttpUrl(rawUrl) || parseLocalOfflineAsset(rawUrl) != null;
    }

    public static String buildLanOfflineAssetUrl(
        String lanBaseUrl,
        String castToken,
        String downloadId,
        String fileName
    ) {
        String cleanBase = safeStr(lanBaseUrl).replaceAll("/+$", "");
        if (cleanBase.isEmpty() || safeStr(castToken).isEmpty() || !isSafeOfflineAssetName(downloadId, fileName)) {
            return "";
        }
        return cleanBase + "/cast/" + castToken + "/offline/" + downloadId + "/" + fileName;
    }

    public static String rewriteOfflineM3u8ForLanProxy(
        String manifest,
        String lanBaseUrl,
        String castToken,
        String downloadId
    ) {
        if (manifest == null || manifest.isEmpty()) return "";
        String cleanBase = safeStr(lanBaseUrl).replaceAll("/+$", "");
        String[] lines = manifest.split("\\r?\\n");
        StringBuilder sb = new StringBuilder(manifest.length() + 512);

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
                    String cleanName = rawUri != null ? rawUri.trim() : "";
                    if (isSafeOfflineAssetName(downloadId, cleanName)) {
                        replacement = "URI=\""
                            + buildLanOfflineAssetUrl(cleanBase, castToken, downloadId, cleanName)
                            + "\"";
                    }
                    m.appendReplacement(replaced, Matcher.quoteReplacement(replacement));
                }
                m.appendTail(replaced);
                sb.append(replaced);
            } else if (isSafeOfflineAssetName(downloadId, trimmed)) {
                sb.append(buildLanOfflineAssetUrl(cleanBase, castToken, downloadId, trimmed));
            } else {
                sb.append(line);
            }
            if (i < lines.length - 1) {
                sb.append('\n');
            }
        }
        return sb.toString();
    }

    public static String guessOfflineMimeType(String fileName) {
        String lower = safeStr(fileName).toLowerCase(Locale.ROOT);
        if (lower.endsWith(".m3u8")) return "application/vnd.apple.mpegurl; charset=utf-8";
        if (lower.endsWith(".ts")) return "video/mp2t";
        if (lower.endsWith(".m4s")) return "video/iso.segment";
        if (lower.endsWith(".vtt")) return "text/vtt; charset=utf-8";
        if (lower.endsWith(".srt")) return "text/srt; charset=utf-8";
        if (lower.endsWith(".ass") || lower.endsWith(".ssa")) return "text/plain; charset=utf-8";
        if (lower.endsWith(".bin") || lower.endsWith(".key")) return "application/octet-stream";
        return "video/mp4";
    }

    /**
     * Remote playback controls (play/pause, seekbar, volume) must remain available whenever
     * connected to a real TV protocol (DLNA or Chromecast), even if deliveryMode is transitional.
     */
    public static boolean hasRemotePlaybackControls(String deviceProtocol, String deliveryMode) {
        if (PROTOCOL_DLNA.equalsIgnoreCase(safeStr(deviceProtocol))
            || PROTOCOL_CHROMECAST.equalsIgnoreCase(safeStr(deviceProtocol))) {
            return true;
        }
        return !"lan-link".equalsIgnoreCase(safeStr(deliveryMode));
    }

    /**
     * Prevents transient DLNA STOPPED polls or short initial HLS segment durations from prematurely
     * terminating an active TV cast session.
     */
    public static boolean isGenuineDlnaCompletion(
        boolean sawPlaying,
        long positionMs,
        long durationMs,
        int consecutiveStoppedPolls
    ) {
        if (!sawPlaying || consecutiveStoppedPolls < 3) return false;
        if (durationMs < 30_000L || positionMs < 10_000L) return false;
        long nearEndThresholdMs = Math.max(durationMs - 20_000L, Math.round(durationMs * 0.90));
        return positionMs >= nearEndThresholdMs;
    }

    /**
     * Rewrites all nested playlist/segment/key URIs in an HLS manifest so a TV on the LAN fetches
     * them through the background foreground-service LAN proxy instead of 127.0.0.1.
     */
    public static String rewriteM3u8ForLanProxy(
        String manifest,
        String baseManifestUrl,
        String lanBaseUrl,
        String castToken,
        String referer
    ) {
        if (manifest == null || manifest.isEmpty()) return "";
        String cleanBase = safeStr(lanBaseUrl).replaceAll("/+$", "");
        String safeRef = isSafeExternalHttpUrl(referer) ? referer.trim() : "https://topanimes.net/";
        String[] lines = manifest.split("\\r?\\n");
        StringBuilder sb = new StringBuilder(manifest.length() + 512);

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
                        if (isSafeExternalHttpUrl(abs)) {
                            boolean isNestedPlaylist = M3U8_EXT_PATTERN.matcher(abs).find();
                            replacement = "URI=\""
                                + buildLanProxyUrl(cleanBase, castToken, abs, safeRef, false, isNestedPlaylist)
                                + "\"";
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
                    if (isSafeExternalHttpUrl(abs)) {
                        boolean isNestedPlaylist = M3U8_EXT_PATTERN.matcher(abs).find();
                        sb.append(buildLanProxyUrl(cleanBase, castToken, abs, safeRef, !isNestedPlaylist, isNestedPlaylist));
                    } else {
                        sb.append(line);
                    }
                } catch (Exception e) {
                    sb.append(line);
                }
            }
            if (i < lines.length - 1) {
                sb.append('\n');
            }
        }
        return sb.toString();
    }

    public static String buildLanProxyUrl(
        String lanBaseUrl,
        String castToken,
        String targetUrl,
        String referer,
        boolean isHlsSegment,
        boolean isPlaylistUrl
    ) {
        try {
            String cleanBase = safeStr(lanBaseUrl).replaceAll("/+$", "");
            String safeRef = isSafeExternalHttpUrl(referer) ? referer.trim() : "https://topanimes.net/";
            String suffix = isPlaylistUrl
                ? "playlist.m3u8"
                : (isHlsSegment ? "segment.ts" : "stream.mp4");
            StringBuilder sb = new StringBuilder();
            sb.append(cleanBase).append("/cast/").append(castToken).append('/').append(suffix)
                .append("?url=").append(URLEncoder.encode(targetUrl, "UTF-8"))
                .append("&referer=").append(URLEncoder.encode(safeRef, "UTF-8"));
            if (isHlsSegment) {
                sb.append("&hls_seg=1");
            }
            return sb.toString();
        } catch (Exception e) {
            return targetUrl;
        }
    }

    public static String convertSrtToVtt(String rawContent) {
        if (rawContent == null) return "WEBVTT\n\n";
        String text = rawContent;
        if (text.startsWith("\uFEFF")) {
            text = text.substring(1);
        }
        text = text.replace("\r\n", "\n").replace('\r', '\n').trim();
        if (text.startsWith("WEBVTT")) {
            return text + "\n";
        }
        String converted = SRT_TIMESTAMP_LINE.matcher(text).replaceAll("$1.$2$3$4.$5");
        return "WEBVTT\n\n" + converted + "\n";
    }

    public static String convertVttToSrt(String rawContent) {
        if (rawContent == null) return "";
        String text = rawContent;
        if (text.startsWith("\uFEFF")) {
            text = text.substring(1);
        }
        text = text.replace("\r\n", "\n").replace('\r', '\n').trim();
        if (text.isEmpty()) return "";
        if (!text.startsWith("WEBVTT")) {
            return text + "\n";
        }

        String[] blocks = text.split("\\n\\n+");
        StringBuilder out = new StringBuilder(text.length());
        int cueIdx = 1;
        for (String block : blocks) {
            String trimmed = block.trim();
            if (trimmed.isEmpty() || trimmed.startsWith("WEBVTT") || trimmed.startsWith("NOTE")
                || trimmed.startsWith("STYLE") || trimmed.startsWith("REGION")) {
                continue;
            }
            String[] lines = trimmed.split("\\n");
            int timeLineIdx = -1;
            for (int i = 0; i < lines.length; i++) {
                if (lines[i].contains("-->")) {
                    timeLineIdx = i;
                    break;
                }
            }
            if (timeLineIdx < 0) continue;

            Matcher m = VTT_TIMESTAMP_LINE.matcher(lines[timeLineIdx].trim());
            if (!m.find()) continue;
            String h1 = padTwoDigits(m.group(1));
            String m1 = m.group(2);
            String s1 = m.group(3);
            String ms1 = padThreeDigits(m.group(4));
            String h2 = padTwoDigits(m.group(6));
            String m2 = m.group(7);
            String s2 = m.group(8);
            String ms2 = padThreeDigits(m.group(9));

            StringBuilder cueText = new StringBuilder();
            for (int i = timeLineIdx + 1; i < lines.length; i++) {
                if (cueText.length() > 0) cueText.append('\n');
                cueText.append(lines[i].replaceAll("<[^>]+>", ""));
            }
            if (cueText.length() == 0) continue;

            out.append(cueIdx++).append('\n')
                .append(h1).append(':').append(m1).append(':').append(s1).append(',').append(ms1)
                .append(" --> ")
                .append(h2).append(':').append(m2).append(':').append(s2).append(',').append(ms2)
                .append('\n')
                .append(cueText)
                .append("\n\n");
        }
        return out.toString();
    }

    private static String padTwoDigits(String raw) {
        if (raw == null || raw.isEmpty()) return "00";
        return raw.length() == 1 ? ("0" + raw) : raw;
    }

    private static String padThreeDigits(String raw) {
        if (raw == null || raw.isEmpty()) return "000";
        if (raw.length() == 1) return raw + "00";
        if (raw.length() == 2) return raw + "0";
        return raw.substring(0, 3);
    }

    public static boolean isChromecastVideoCapable(String capabilitiesRaw) {
        if (capabilitiesRaw == null || capabilitiesRaw.trim().isEmpty()) {
            return true;
        }
        try {
            int ca = Integer.parseInt(capabilitiesRaw.trim());
            // Bit 0 (0x01) = VIDEO_OUT on Google Cast mDNS TXT record
            return (ca & 1) != 0;
        } catch (NumberFormatException e) {
            return true;
        }
    }

    public static final class MdnsSrvRecord {
        public final int port;
        public final String target;

        public MdnsSrvRecord(int port, String target) {
            this.port = port;
            this.target = safeStr(target);
        }
    }

    public static final class MdnsRecordSummary {
        public final List<String> ptrTargets = new ArrayList<>();
        public final Map<String, MdnsSrvRecord> srvsByName = new LinkedHashMap<>();
        public final Map<String, Map<String, String>> txtsByName = new LinkedHashMap<>();
        public final Map<String, String> ipv4ByHost = new LinkedHashMap<>();

        public void mergeFrom(MdnsRecordSummary other) {
            if (other == null) return;
            for (String target : other.ptrTargets) {
                if (!ptrTargets.contains(target)) {
                    ptrTargets.add(target);
                }
            }
            srvsByName.putAll(other.srvsByName);
            for (Map.Entry<String, Map<String, String>> entry : other.txtsByName.entrySet()) {
                Map<String, String> existing = txtsByName.get(entry.getKey());
                if (existing == null) {
                    txtsByName.put(entry.getKey(), new LinkedHashMap<>(entry.getValue()));
                } else {
                    existing.putAll(entry.getValue());
                }
            }
            ipv4ByHost.putAll(other.ipv4ByHost);
        }
    }

    /**
     * Builds an RFC 6762 mDNS PTR query packet (e.g. for "_googlecast._tcp.local") with optional
     * QU (unicast-response) bit so responses return directly to the querying socket.
     */
    public static byte[] buildMdnsPtrQuery(String serviceName, boolean unicastResponse) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(64);
        // Header: ID=0, Flags=0, QDCOUNT=1, ANCOUNT=0, NSCOUNT=0, ARCOUNT=0
        out.write(0); out.write(0);
        out.write(0); out.write(0);
        out.write(0); out.write(1);
        out.write(0); out.write(0);
        out.write(0); out.write(0);
        out.write(0); out.write(0);

        String clean = safeStr(serviceName).replaceAll("\\.+$", "");
        if (!clean.isEmpty()) {
            String[] labels = clean.split("\\.");
            for (String label : labels) {
                if (label.isEmpty()) continue;
                byte[] b = label.getBytes(StandardCharsets.UTF_8);
                if (b.length > 63) continue;
                out.write(b.length);
                out.write(b, 0, b.length);
            }
        }
        out.write(0);

        // QTYPE = PTR (12)
        out.write(0);
        out.write(12);
        // QCLASS = IN (1) | optional QU bit (0x8000)
        out.write(unicastResponse ? 0x80 : 0x00);
        out.write(0x01);
        return out.toByteArray();
    }

    private static int readUint16BE(byte[] buf, int offset) {
        return ((buf[offset] & 0xFF) << 8) | (buf[offset + 1] & 0xFF);
    }

    private static final class DnsNameResult {
        final String name;
        final int nextOffset;

        DnsNameResult(String name, int nextOffset) {
            this.name = name;
            this.nextOffset = nextOffset;
        }
    }

    private static DnsNameResult readDnsName(byte[] buf, int length, int startOffset) {
        StringBuilder sb = new StringBuilder();
        int offset = startOffset;
        int endOffset = startOffset;
        boolean jumped = false;
        int guard = 0;

        while (offset < length && guard < 64) {
            guard++;
            int len = buf[offset] & 0xFF;
            if (len == 0) {
                if (!jumped) endOffset = offset + 1;
                break;
            }
            if ((len & 0xC0) == 0xC0) {
                if (offset + 1 >= length) break;
                int ptr = ((len & 0x3F) << 8) | (buf[offset + 1] & 0xFF);
                if (!jumped) endOffset = offset + 2;
                offset = ptr;
                jumped = true;
                continue;
            }
            offset++;
            if (offset + len > length) break;
            if (sb.length() > 0) sb.append('.');
            sb.append(new String(buf, offset, len, StandardCharsets.UTF_8));
            offset += len;
            if (!jumped) endOffset = offset;
        }

        return new DnsNameResult(sb.toString(), endOffset);
    }

    private static String normalizeDnsKey(String name) {
        if (name == null) return "";
        return name.trim().replaceAll("\\.+$", "").toLowerCase(Locale.ROOT);
    }

    public static MdnsRecordSummary parseMdnsResponsePacket(byte[] data, int length) {
        MdnsRecordSummary out = new MdnsRecordSummary();
        if (data == null || length < 12) return out;
        int len = Math.min(data.length, length);

        int qdCount = readUint16BE(data, 4);
        int anCount = readUint16BE(data, 6);
        int nsCount = readUint16BE(data, 8);
        int arCount = readUint16BE(data, 10);

        int offset = 12;
        for (int i = 0; i < qdCount && offset < len; i++) {
            DnsNameResult q = readDnsName(data, len, offset);
            offset = q.nextOffset + 4;
        }

        int totalRr = anCount + nsCount + arCount;
        for (int i = 0; i < totalRr && offset + 10 <= len; i++) {
            DnsNameResult rrName = readDnsName(data, len, offset);
            offset = rrName.nextOffset;
            if (offset + 10 > len) break;

            int rtype = readUint16BE(data, offset);
            int rdlength = readUint16BE(data, offset + 8);
            int rdataStart = offset + 10;
            int rdataEnd = rdataStart + rdlength;
            if (rdataEnd > len) break;

            String key = normalizeDnsKey(rrName.name);
            if (rtype == 12) {
                // PTR
                String target = readDnsName(data, len, rdataStart).name;
                if (!target.isEmpty() && key.contains("_googlecast._tcp")) {
                    out.ptrTargets.add(target);
                }
            } else if (rtype == 33 && rdlength >= 6) {
                // SRV
                int port = readUint16BE(data, rdataStart + 4);
                String target = readDnsName(data, len, rdataStart + 6).name;
                if (!target.isEmpty() && !key.isEmpty()) {
                    out.srvsByName.put(key, new MdnsSrvRecord(port, target));
                }
            } else if (rtype == 16 && !key.isEmpty()) {
                // TXT
                Map<String, String> attrs = out.txtsByName.get(key);
                if (attrs == null) {
                    attrs = new LinkedHashMap<>();
                    out.txtsByName.put(key, attrs);
                }
                int p = rdataStart;
                while (p < rdataEnd) {
                    int entryLen = data[p++] & 0xFF;
                    if (entryLen == 0 || p + entryLen > rdataEnd) break;
                    String entry = new String(data, p, entryLen, StandardCharsets.UTF_8);
                    p += entryLen;
                    int eq = entry.indexOf('=');
                    if (eq > 0) {
                        attrs.put(entry.substring(0, eq).trim(), entry.substring(eq + 1).trim());
                    }
                }
            } else if (rtype == 1 && rdlength == 4 && !key.isEmpty()) {
                // A (IPv4)
                String ip = (data[rdataStart] & 0xFF) + "."
                    + (data[rdataStart + 1] & 0xFF) + "."
                    + (data[rdataStart + 2] & 0xFF) + "."
                    + (data[rdataStart + 3] & 0xFF);
                out.ipv4ByHost.put(key, ip);
            }

            offset = rdataEnd;
        }
        return out;
    }

    public static List<CastDevice> extractChromecastDevicesFromMdns(MdnsRecordSummary summary) {
        List<CastDevice> out = new ArrayList<>();
        if (summary == null) return out;

        List<String> instanceNames = new ArrayList<>(summary.ptrTargets);
        for (String srvKey : summary.srvsByName.keySet()) {
            if (srvKey.contains("_googlecast._tcp")) {
                boolean exists = false;
                for (String existing : instanceNames) {
                    if (normalizeDnsKey(existing).equals(srvKey)) {
                        exists = true;
                        break;
                    }
                }
                if (!exists) {
                    instanceNames.add(srvKey);
                }
            }
        }

        for (String instanceName : instanceNames) {
            String instKey = normalizeDnsKey(instanceName);
            MdnsSrvRecord srv = summary.srvsByName.get(instKey);
            if (srv == null) continue;
            String host = summary.ipv4ByHost.get(normalizeDnsKey(srv.target));
            if (host == null || host.isEmpty()) continue;

            Map<String, String> attrs = summary.txtsByName.get(instKey);
            String fn = attrs != null ? safeStr(attrs.get("fn")) : "";
            String md = attrs != null ? safeStr(attrs.get("md")) : "";
            String idAttr = attrs != null ? safeStr(attrs.get("id")) : "";
            String ca = attrs != null ? safeStr(attrs.get("ca")) : "";
            if (!isChromecastVideoCapable(ca)) continue;

            int port = srv.port > 0 ? srv.port : CHROMECAST_DEFAULT_PORT;
            String fallbackName = instanceName.replaceAll("\\._googlecast\\._tcp.*$", "");
            String displayName = !fn.isEmpty() ? fn : (!fallbackName.isEmpty() ? fallbackName : host);
            String deviceId = !idAttr.isEmpty() ? ("cast:" + idAttr) : ("cast:" + host + ":" + port);

            out.add(new CastDevice(
                deviceId,
                displayName,
                "Google Cast",
                md.isEmpty() ? "Chromecast / Android TV" : md,
                host,
                port,
                PROTOCOL_CHROMECAST,
                "",
                "",
                ""
            ));
        }
        return out;
    }

    private static String safeStr(String s) {
        return s != null ? s.trim() : "";
    }
}
