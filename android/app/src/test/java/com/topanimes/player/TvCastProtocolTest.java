package com.topanimes.player;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public class TvCastProtocolTest {

    @Test
    public void castV2ProtobufMessageRoundTripsAndFramesCleanly() throws Exception {
        String jsonPayload = "{\"type\":\"LAUNCH\",\"appId\":\"CC1AD845\",\"requestId\":1}";
        ByteArrayOutputStream framedOut = new ByteArrayOutputStream();
        TvCastProtocol.writeFramedCastMessage(
            framedOut,
            "sender-1",
            "receiver-0",
            TvCastProtocol.CAST_NS_RECEIVER,
            jsonPayload
        );

        TvCastProtocol.CastPacket decoded = TvCastProtocol.readFramedCastMessage(
            new ByteArrayInputStream(framedOut.toByteArray())
        );
        assertNotNull(decoded);
        assertEquals(0, decoded.protocolVersion);
        assertEquals("sender-1", decoded.sourceId);
        assertEquals("receiver-0", decoded.destinationId);
        assertEquals(TvCastProtocol.CAST_NS_RECEIVER, decoded.namespace);
        assertEquals(0, decoded.payloadType);
        assertEquals(jsonPayload, decoded.payloadUtf8);
    }

    @Test
    public void parsesSsdpHeadersAndUpnpMediaRendererDeviceDescription() {
        String ssdp = "HTTP/1.1 200 OK\r\n"
            + "LOCATION: http://192.168.1.42:9197/dmr\r\n"
            + "ST: urn:schemas-upnp-org:service:AVTransport:1\r\n"
            + "USN: uuid:tv-sala-123::urn:schemas-upnp-org:service:AVTransport:1\r\n\r\n";
        Map<String, String> headers = TvCastProtocol.parseSsdpResponseHeaders(ssdp);
        assertEquals("http://192.168.1.42:9197/dmr", headers.get("location"));

        String xml = "<?xml version=\"1.0\"?>"
            + "<root xmlns=\"urn:schemas-upnp-org:device-1-0\">"
            + "<device>"
            + "<friendlyName>Samsung QLED &amp; Sala</friendlyName>"
            + "<manufacturer>Samsung</manufacturer>"
            + "<modelName>QN55Q60</modelName>"
            + "<UDN>uuid:tv-sala-123</UDN>"
            + "<serviceList>"
            + "<service>"
            + "<serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>"
            + "<controlURL>/upnp/control/AVTransport1</controlURL>"
            + "</service>"
            + "<service>"
            + "<serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>"
            + "<controlURL>/upnp/control/RenderingControl1</controlURL>"
            + "</service>"
            + "</serviceList>"
            + "</device>"
            + "</root>";

        TvCastProtocol.CastDevice device = TvCastProtocol.parseUpnpDeviceDescription(
            xml,
            "http://192.168.1.42:9197/dmr"
        );
        assertNotNull(device);
        assertEquals("Samsung QLED & Sala", device.name);
        assertEquals("dlna", device.protocol);
        assertEquals("192.168.1.42", device.host);
        assertEquals(9197, device.port);
        assertEquals("http://192.168.1.42:9197/upnp/control/AVTransport1", device.avTransportControlUrl);
        assertEquals("http://192.168.1.42:9197/upnp/control/RenderingControl1", device.renderingControlUrl);
    }

    @Test
    public void buildsValidDidlLiteSoapAndParsesDlnaTimestamps() {
        String didl = TvCastProtocol.buildDidlLiteMetadata(
            "Frieren & Fern - EP 1",
            "Sousou no Frieren",
            "https://img.example.com/poster.jpg?a=1&b=2",
            "http://192.168.1.10:50000/cast/abc/stream.mp4?url=x&referer=y",
            "video/mp4"
        );
        assertTrue(didl.contains("Frieren &amp; Fern - EP 1"));
        assertTrue(didl.contains("http-get:*:video/mp4:DLNA.ORG_OP=01;DLNA.ORG_CI=0"));
        assertTrue(didl.contains("<upnp:albumArtURI>https://img.example.com/poster.jpg?a=1&amp;b=2</upnp:albumArtURI>"));

        Map<String, String> args = new LinkedHashMap<>();
        args.put("InstanceID", "0");
        args.put("Speed", "1");
        String soap = TvCastProtocol.buildSoapEnvelope(
            TvCastProtocol.UPNP_AV_TRANSPORT_SERVICE,
            "Play",
            args
        );
        assertTrue(soap.contains("<u:Play xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\">"));
        assertTrue(soap.contains("<Speed>1</Speed>"));

        assertEquals("01:02:05", TvCastProtocol.formatDlnaTime(3_725_000L));
        assertEquals(3_725_000L, TvCastProtocol.parseDlnaTimeMs("01:02:05"));
        assertEquals(75_500L, TvCastProtocol.parseDlnaTimeMs("00:01:15.500"));
        assertEquals(-1L, TvCastProtocol.parseDlnaTimeMs("NOT_IMPLEMENTED"));
    }

    @Test
    public void rewritesM3u8ManifestForLanProxyWithoutLoopbackAndConvertsSrtToVtt() {
        String manifest = "#EXTM3U\n"
            + "#EXT-X-VERSION:3\n"
            + "#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n"
            + "#EXTINF:6.0,\n"
            + "seg001.png\n"
            + "#EXTINF:6.0,\n"
            + "https://cdn.example.com/hls/seg002.ts\n";

        String rewritten = TvCastProtocol.rewriteM3u8ForLanProxy(
            manifest,
            "https://cdn.example.com/hls/index.m3u8",
            "http://192.168.1.50:49152",
            "secret123",
            "https://topanimes.net/"
        );

        assertFalse(rewritten.contains("127.0.0.1"));
        assertTrue(rewritten.contains("http://192.168.1.50:49152/cast/secret123/stream.mp4?url="));
        assertTrue(rewritten.contains("http://192.168.1.50:49152/cast/secret123/segment.ts?url="));
        assertTrue(rewritten.contains("&hls_seg=1"));

        String srt = "1\r\n00:00:01,250 --> 00:00:04,500\r\nOlá mundo!\r\n";
        String vtt = TvCastProtocol.convertSrtToVtt(srt);
        assertTrue(vtt.startsWith("WEBVTT\n\n"));
        assertTrue(vtt.contains("00:00:01.250 --> 00:00:04.500"));

        assertTrue(TvCastProtocol.isChromecastVideoCapable("4101"));
        assertFalse(TvCastProtocol.isChromecastVideoCapable("4100"));
        assertTrue(TvCastProtocol.isChromecastVideoCapable(""));
    }

    private static void writeDnsName(ByteArrayOutputStream out, String name) {
        for (String label : name.split("\\.")) {
            byte[] b = label.getBytes(StandardCharsets.UTF_8);
            out.write(b.length);
            out.write(b, 0, b.length);
        }
        out.write(0);
    }

    private static void writeUint16(ByteArrayOutputStream out, int v) {
        out.write((v >> 8) & 0xFF);
        out.write(v & 0xFF);
    }

    private static void writeUint32(ByteArrayOutputStream out, int v) {
        out.write((v >> 24) & 0xFF);
        out.write((v >> 16) & 0xFF);
        out.write((v >> 8) & 0xFF);
        out.write(v & 0xFF);
    }

    @Test
    public void buildsAndParsesMdnsChromecastDiscoveryPackets() {
        byte[] query = TvCastProtocol.buildMdnsPtrQuery(TvCastProtocol.MDNS_GOOGLECAST_QUERY, true);
        assertTrue(query.length > 16);
        assertEquals(1, ((query[4] & 0xFF) << 8) | (query[5] & 0xFF)); // QDCOUNT = 1
        assertEquals(0x80, query[query.length - 2] & 0xFF); // QU bit set
        assertEquals(0x01, query[query.length - 1] & 0xFF); // CLASS IN

        ByteArrayOutputStream pkt = new ByteArrayOutputStream();
        writeUint16(pkt, 0); // ID
        writeUint16(pkt, 0x8400); // Response
        writeUint16(pkt, 0); // QDCOUNT
        writeUint16(pkt, 4); // ANCOUNT (PTR, SRV, TXT, A)
        writeUint16(pkt, 0); // NSCOUNT
        writeUint16(pkt, 0); // ARCOUNT

        String instance = "Chromecast-TV._googlecast._tcp.local";
        String targetHost = "chromecast-tv.local";

        // 1. PTR
        ByteArrayOutputStream ptrData = new ByteArrayOutputStream();
        writeDnsName(ptrData, instance);
        writeDnsName(pkt, "_googlecast._tcp.local");
        writeUint16(pkt, 12);
        writeUint16(pkt, 1);
        writeUint32(pkt, 120);
        writeUint16(pkt, ptrData.size());
        pkt.write(ptrData.toByteArray(), 0, ptrData.size());

        // 2. SRV
        ByteArrayOutputStream srvData = new ByteArrayOutputStream();
        writeUint16(srvData, 0);
        writeUint16(srvData, 0);
        writeUint16(srvData, 8009);
        writeDnsName(srvData, targetHost);
        writeDnsName(pkt, instance);
        writeUint16(pkt, 33);
        writeUint16(pkt, 1);
        writeUint32(pkt, 120);
        writeUint16(pkt, srvData.size());
        pkt.write(srvData.toByteArray(), 0, srvData.size());

        // 3. TXT
        ByteArrayOutputStream txtData = new ByteArrayOutputStream();
        for (String kv : new String[]{"fn=TV da Sala", "md=Chromecast Ultra", "id=abc123", "ca=4101"}) {
            byte[] b = kv.getBytes(StandardCharsets.UTF_8);
            txtData.write(b.length);
            txtData.write(b, 0, b.length);
        }
        writeDnsName(pkt, instance);
        writeUint16(pkt, 16);
        writeUint16(pkt, 1);
        writeUint32(pkt, 120);
        writeUint16(pkt, txtData.size());
        pkt.write(txtData.toByteArray(), 0, txtData.size());

        // 4. A
        writeDnsName(pkt, targetHost);
        writeUint16(pkt, 1);
        writeUint16(pkt, 1);
        writeUint32(pkt, 120);
        writeUint16(pkt, 4);
        pkt.write(192); pkt.write(168); pkt.write(1); pkt.write(88);

        byte[] raw = pkt.toByteArray();
        TvCastProtocol.MdnsRecordSummary parsed = TvCastProtocol.parseMdnsResponsePacket(raw, raw.length);
        List<TvCastProtocol.CastDevice> devices = TvCastProtocol.extractChromecastDevicesFromMdns(parsed);

        assertEquals(1, devices.size());
        TvCastProtocol.CastDevice dev = devices.get(0);
        assertEquals("cast:abc123", dev.id);
        assertEquals("TV da Sala", dev.name);
        assertEquals("Chromecast Ultra", dev.model);
        assertEquals("192.168.1.88", dev.host);
        assertEquals(8009, dev.port);
        assertEquals("chromecast", dev.protocol);
    }

    @Test
    public void parsesLocalOfflineAssetsAndRewritesOfflineHlsForLanCast() {
        String offlineMp4 = "http://127.0.0.1:41234/offline/dl_1111_2222/video.mp4";
        TvCastProtocol.LocalOfflineAsset parsed = TvCastProtocol.parseLocalOfflineAsset(offlineMp4);
        assertNotNull(parsed);
        assertEquals("dl_1111_2222", parsed.downloadId);
        assertEquals("video.mp4", parsed.fileName);
        assertTrue(TvCastProtocol.isSupportedCastSourceUrl(offlineMp4));
        assertFalse(TvCastProtocol.isSupportedCastSourceUrl("http://127.0.0.1:41234/secret/admin"));
        assertFalse(TvCastProtocol.isSupportedCastSourceUrl("http://127.0.0.1:41234/offline/dl_1/../../etc/passwd"));

        String lanUrl = TvCastProtocol.buildLanOfflineAssetUrl(
            "http://192.168.1.50:49152",
            "tok123",
            "dl_1111_2222",
            "playlist.m3u8"
        );
        assertEquals("http://192.168.1.50:49152/cast/tok123/offline/dl_1111_2222/playlist.m3u8", lanUrl);

        String offlineM3u8 = "#EXTM3U\n"
            + "#EXT-X-VERSION:3\n"
            + "#EXT-X-KEY:METHOD=AES-128,URI=\"key_0.bin\"\n"
            + "#EXT-X-MAP:URI=\"init_0.mp4\"\n"
            + "#EXTINF:6.0,\n"
            + "seg_00000.ts\n"
            + "#EXTINF:6.0,\n"
            + "seg_00001.ts\n";
        String rewritten = TvCastProtocol.rewriteOfflineM3u8ForLanProxy(
            offlineM3u8,
            "http://192.168.1.50:49152",
            "tok123",
            "dl_1111_2222"
        );
        assertTrue(rewritten.contains("URI=\"http://192.168.1.50:49152/cast/tok123/offline/dl_1111_2222/key_0.bin\""));
        assertTrue(rewritten.contains("URI=\"http://192.168.1.50:49152/cast/tok123/offline/dl_1111_2222/init_0.mp4\""));
        assertTrue(rewritten.contains("\nhttp://192.168.1.50:49152/cast/tok123/offline/dl_1111_2222/seg_00000.ts\n"));
        assertFalse(rewritten.contains("127.0.0.1"));
    }

    @Test
    public void convertsVttToSrtAndEmitsDlnaSubtitleDidlLiteAndStabilityGuards() {
        String vtt = "WEBVTT\n\n"
            + "00:01.250 --> 00:04.500 align:center\n"
            + "<i>Olá</i> TV!\n\n"
            + "01:02:03.000 --> 01:02:06.500\n"
            + "Segunda linha\n";
        String srt = TvCastProtocol.convertVttToSrt(vtt);
        assertTrue(srt.contains("1\n00:00:01,250 --> 00:00:04,500\nOlá TV!"));
        assertTrue(srt.contains("2\n01:02:03,000 --> 01:02:06,500\nSegunda linha"));

        String didlWithSub = TvCastProtocol.buildDidlLiteMetadata(
            "Ep 1",
            "Anime",
            "",
            "http://192.168.1.10:5000/cast/tok/stream.mp4",
            "video/mp4",
            "http://192.168.1.10:5000/cast/tok/subtitle.srt"
        );
        assertTrue(didlWithSub.contains("protocolInfo=\"http-get:*:text/srt:*\""));
        assertTrue(didlWithSub.contains("<sec:CaptionInfoEx sec:type=\"srt\">http://192.168.1.10:5000/cast/tok/subtitle.srt</sec:CaptionInfoEx>"));
        assertTrue(didlWithSub.contains("<sec:CaptionInfo sec:type=\"srt\">http://192.168.1.10:5000/cast/tok/subtitle.srt</sec:CaptionInfo>"));

        // Bug #1 guard: Chromecast/DLNA always retain remote controls; pure lan-link does not
        assertTrue(TvCastProtocol.hasRemotePlaybackControls("dlna", "background-proxy"));
        assertTrue(TvCastProtocol.hasRemotePlaybackControls("chromecast", "direct"));
        assertTrue(TvCastProtocol.hasRemotePlaybackControls("dlna", "lan-link"));
        assertFalse(TvCastProtocol.hasRemotePlaybackControls("lan", "lan-link"));

        // Bug #3 guard: short HLS segment duration or transient STOPPED poll must NEVER kill DLNA cast
        assertFalse(TvCastProtocol.isGenuineDlnaCompletion(true, 0L, 15_000L, 5));
        assertFalse(TvCastProtocol.isGenuineDlnaCompletion(true, 1_435_000L, 1_440_000L, 1));
        assertFalse(TvCastProtocol.isGenuineDlnaCompletion(true, 1_435_000L, 1_440_000L, 2));
        assertFalse(TvCastProtocol.isGenuineDlnaCompletion(true, 600_000L, 1_440_000L, 5));
        assertTrue(TvCastProtocol.isGenuineDlnaCompletion(true, 1_432_000L, 1_440_000L, 3));
    }

    @Test
    public void detectsPresignedHeadAvoidanceAndParsesContentRangeLength() {
        String r2Url = "https://173fe263eae04670ecfcebf237fd6480.r2.cloudflarestorage.com/zful/ep1.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=deadbeef";
        assertTrue(TvCastProtocol.shouldAvoidUpstreamHead(r2Url));
        assertTrue(TvCastProtocol.isSafeExternalHttpUrl(r2Url));
        assertTrue(TvCastProtocol.isSafeExternalHttpUrl("https://cdn.example.com/anime [1080p]/ep 1.mp4"));
        assertFalse(TvCastProtocol.shouldAvoidUpstreamHead("https://cdn.example.com/ep1.mp4"));

        assertEquals(314572800L, TvCastProtocol.parseTotalLengthFromContentRange("bytes 0-0/314572800"));
        assertEquals(1024L, TvCastProtocol.parseTotalLengthFromContentRange("bytes 0-511/1024"));
        assertEquals(-1L, TvCastProtocol.parseTotalLengthFromContentRange("bytes 0-0/*"));
        assertEquals(-1L, TvCastProtocol.parseTotalLengthFromContentRange(""));
    }
}
