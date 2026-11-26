package com.topanimes.player;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Queue;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Unified LAN discovery for:
 * - Chromecast / Google TV / Android TV via Android NsdManager (_googlecast._tcp.)
 * - Smart TVs (Samsung, LG, Sony, TCL, Roku, Xbox, Kodi, etc.) via UPnP / DLNA SSDP M-SEARCH
 */
public final class TvCastDiscovery {
    private static final String TAG = "AnisyncTvDiscovery";
    private static final String GOOGLE_CAST_SERVICE_TYPE = "_googlecast._tcp.";
    private static final String MDNS_ADDRESS = "224.0.0.251";
    private static final int MDNS_PORT = 5353;
    private static final String SSDP_ADDRESS = "239.255.255.250";
    private static final int SSDP_PORT = 1900;

    public interface Listener {
        void onDevicesChanged(List<TvCastProtocol.CastDevice> devices);
        void onDiscoveryFinished(List<TvCastProtocol.CastDevice> devices);
    }

    private final Context appContext;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService executor = Executors.newCachedThreadPool();
    private final Object lock = new Object();
    private final Map<String, TvCastProtocol.CastDevice> discoveredById = new LinkedHashMap<>();
    private final Set<String> seenLocations = new HashSet<>();
    private final Queue<NsdServiceInfo> pendingNsdResolves = new ArrayDeque<>();
    private final AtomicBoolean running = new AtomicBoolean(false);

    private NsdManager nsdManager;
    private NsdManager.DiscoveryListener nsdDiscoveryListener;
    private boolean nsdResolveInFlight = false;
    private WifiManager.MulticastLock multicastLock;
    private volatile DatagramSocket activeMdnsSocket;
    private volatile DatagramSocket activeSsdpSocket;
    private volatile Listener activeListener;
    private Runnable timeoutRunnable;

    public TvCastDiscovery(Context context) {
        this.appContext = context.getApplicationContext();
    }

    public void startDiscovery(long timeoutMs, Listener listener) {
        stopDiscovery();

        long clampedTimeout = Math.max(2000L, Math.min(12000L, timeoutMs));
        synchronized (lock) {
            discoveredById.clear();
            seenLocations.clear();
            pendingNsdResolves.clear();
            nsdResolveInFlight = false;
        }
        activeListener = listener;
        running.set(true);

        acquireMulticastLock();
        startNsdDiscovery();
        startRawMdnsDiscovery(clampedTimeout);
        startSsdpDiscovery(clampedTimeout);

        timeoutRunnable = () -> {
            List<TvCastProtocol.CastDevice> snapshot = getDiscoveredDevices();
            Listener cb = activeListener;
            stopDiscovery();
            if (cb != null) {
                cb.onDiscoveryFinished(snapshot);
            }
        };
        mainHandler.postDelayed(timeoutRunnable, clampedTimeout);
    }

    public void stopDiscovery() {
        running.set(false);
        if (timeoutRunnable != null) {
            mainHandler.removeCallbacks(timeoutRunnable);
            timeoutRunnable = null;
        }
        stopNsdDiscovery();
        DatagramSocket mdnsSock = activeMdnsSocket;
        activeMdnsSocket = null;
        if (mdnsSock != null) {
            try {
                mdnsSock.close();
            } catch (Exception ignored) {
            }
        }
        DatagramSocket sock = activeSsdpSocket;
        activeSsdpSocket = null;
        if (sock != null) {
            try {
                sock.close();
            } catch (Exception ignored) {
            }
        }
        releaseMulticastLock();
        activeListener = null;
    }

    public void shutdown() {
        stopDiscovery();
        executor.shutdownNow();
    }

    public List<TvCastProtocol.CastDevice> getDiscoveredDevices() {
        synchronized (lock) {
            return new ArrayList<>(discoveredById.values());
        }
    }

    private void addOrUpdateDevice(TvCastProtocol.CastDevice device) {
        if (device == null || device.host.isEmpty()) return;
        List<TvCastProtocol.CastDevice> snapshot;
        synchronized (lock) {
            String key = device.id.isEmpty()
                ? (device.protocol + ":" + device.host + ":" + device.port)
                : device.id;
            discoveredById.put(key, device);
            snapshot = new ArrayList<>(discoveredById.values());
        }
        Listener cb = activeListener;
        if (cb != null && running.get()) {
            mainHandler.post(() -> cb.onDevicesChanged(snapshot));
        }
    }

    private void acquireMulticastLock() {
        try {
            WifiManager wifi = (WifiManager) appContext.getSystemService(Context.WIFI_SERVICE);
            if (wifi != null) {
                WifiManager.MulticastLock mLock = wifi.createMulticastLock("anisync_tv_cast_discovery");
                mLock.setReferenceCounted(false);
                mLock.acquire();
                multicastLock = mLock;
            }
        } catch (Exception e) {
            Log.w(TAG, "Unable to acquire MulticastLock: " + e.getMessage());
        }
    }

    private void releaseMulticastLock() {
        WifiManager.MulticastLock mLock = multicastLock;
        multicastLock = null;
        if (mLock != null) {
            try {
                if (mLock.isHeld()) {
                    mLock.release();
                }
            } catch (Exception ignored) {
            }
        }
    }

    private void startNsdDiscovery() {
        try {
            nsdManager = (NsdManager) appContext.getSystemService(Context.NSD_SERVICE);
            if (nsdManager == null) return;

            nsdDiscoveryListener = new NsdManager.DiscoveryListener() {
                @Override
                public void onStartDiscoveryFailed(String serviceType, int errorCode) {
                    Log.w(TAG, "NSD start failed: " + errorCode);
                }

                @Override
                public void onStopDiscoveryFailed(String serviceType, int errorCode) {
                    Log.w(TAG, "NSD stop failed: " + errorCode);
                }

                @Override
                public void onDiscoveryStarted(String serviceType) {
                    Log.d(TAG, "NSD Chromecast discovery started");
                }

                @Override
                public void onDiscoveryStopped(String serviceType) {
                    Log.d(TAG, "NSD Chromecast discovery stopped");
                }

                @Override
                public void onServiceFound(NsdServiceInfo serviceInfo) {
                    if (!running.get() || serviceInfo == null) return;
                    synchronized (lock) {
                        pendingNsdResolves.add(serviceInfo);
                    }
                    drainNextNsdResolve();
                }

                @Override
                public void onServiceLost(NsdServiceInfo serviceInfo) {
                    // Keep previously found entries for current scan window
                }
            };

            nsdManager.discoverServices(
                GOOGLE_CAST_SERVICE_TYPE,
                NsdManager.PROTOCOL_DNS_SD,
                nsdDiscoveryListener
            );
        } catch (Exception e) {
            Log.w(TAG, "Failed starting NSD Chromecast discovery: " + e.getMessage());
        }
    }

    @SuppressWarnings("deprecation")
    private void drainNextNsdResolve() {
        NsdServiceInfo next;
        NsdManager mgr;
        synchronized (lock) {
            if (!running.get() || nsdResolveInFlight || pendingNsdResolves.isEmpty() || nsdManager == null) {
                return;
            }
            next = pendingNsdResolves.poll();
            mgr = nsdManager;
            nsdResolveInFlight = true;
        }
        if (next == null) return;

        try {
            mgr.resolveService(next, new NsdManager.ResolveListener() {
                @Override
                public void onResolveFailed(NsdServiceInfo serviceInfo, int errorCode) {
                    synchronized (lock) {
                        nsdResolveInFlight = false;
                    }
                    drainNextNsdResolve();
                }

                @Override
                public void onServiceResolved(NsdServiceInfo resolved) {
                    try {
                        handleResolvedCastService(resolved);
                    } finally {
                        synchronized (lock) {
                            nsdResolveInFlight = false;
                        }
                        drainNextNsdResolve();
                    }
                }
            });
        } catch (Exception e) {
            synchronized (lock) {
                nsdResolveInFlight = false;
            }
            drainNextNsdResolve();
        }
    }

    @SuppressWarnings("deprecation")
    private void handleResolvedCastService(NsdServiceInfo resolved) {
        if (resolved == null) return;
        InetAddress hostAddr = resolved.getHost();
        if (hostAddr == null) return;
        String host = hostAddr.getHostAddress();
        if (host == null || host.isEmpty()) return;
        int port = resolved.getPort() > 0 ? resolved.getPort() : TvCastProtocol.CHROMECAST_DEFAULT_PORT;

        Map<String, byte[]> attrs = resolved.getAttributes();
        String fn = readTxtAttr(attrs, "fn");
        String md = readTxtAttr(attrs, "md");
        String idAttr = readTxtAttr(attrs, "id");
        String ca = readTxtAttr(attrs, "ca");

        if (!TvCastProtocol.isChromecastVideoCapable(ca)) {
            // Skip audio-only Google Home speakers without video display
            return;
        }

        String displayName = !fn.isEmpty() ? fn : resolved.getServiceName();
        String deviceId = !idAttr.isEmpty()
            ? ("cast:" + idAttr)
            : ("cast:" + host + ":" + port);

        TvCastProtocol.CastDevice device = new TvCastProtocol.CastDevice(
            deviceId,
            displayName,
            "Google Cast",
            md.isEmpty() ? "Chromecast / Android TV" : md,
            host,
            port,
            TvCastProtocol.PROTOCOL_CHROMECAST,
            "",
            "",
            ""
        );
        addOrUpdateDevice(device);
    }

    private static String readTxtAttr(Map<String, byte[]> attrs, String key) {
        if (attrs == null || key == null) return "";
        byte[] raw = attrs.get(key);
        if (raw == null || raw.length == 0) return "";
        return new String(raw, StandardCharsets.UTF_8).trim();
    }

    private void stopNsdDiscovery() {
        NsdManager mgr = nsdManager;
        NsdManager.DiscoveryListener listener = nsdDiscoveryListener;
        nsdDiscoveryListener = null;
        if (mgr != null && listener != null) {
            try {
                mgr.stopServiceDiscovery(listener);
            } catch (Exception ignored) {
            }
        }
    }

    private void startRawMdnsDiscovery(long timeoutMs) {
        executor.execute(() -> {
            DatagramSocket socket = null;
            try {
                socket = new DatagramSocket();
                socket.setReuseAddress(true);
                socket.setSoTimeout(700);
                activeMdnsSocket = socket;

                InetAddress group = InetAddress.getByName(MDNS_ADDRESS);
                byte[] queryQu = TvCastProtocol.buildMdnsPtrQuery(
                    TvCastProtocol.MDNS_GOOGLECAST_QUERY,
                    true
                );
                byte[] queryQm = TvCastProtocol.buildMdnsPtrQuery(
                    TvCastProtocol.MDNS_GOOGLECAST_QUERY,
                    false
                );
                socket.send(new DatagramPacket(queryQu, queryQu.length, group, MDNS_PORT));

                TvCastProtocol.MdnsRecordSummary merged = new TvCastProtocol.MdnsRecordSummary();
                long startMs = System.currentTimeMillis();
                boolean sentSecondBurst = false;
                byte[] rxBuf = new byte[4096];

                while (running.get() && (System.currentTimeMillis() - startMs) < timeoutMs) {
                    if (!sentSecondBurst && (System.currentTimeMillis() - startMs) >= 650L) {
                        sentSecondBurst = true;
                        try {
                            socket.send(new DatagramPacket(queryQu, queryQu.length, group, MDNS_PORT));
                            socket.send(new DatagramPacket(queryQm, queryQm.length, group, MDNS_PORT));
                        } catch (Exception ignored) {
                        }
                    }

                    DatagramPacket packet = new DatagramPacket(rxBuf, rxBuf.length);
                    try {
                        socket.receive(packet);
                        TvCastProtocol.MdnsRecordSummary parsed = TvCastProtocol.parseMdnsResponsePacket(
                            packet.getData(),
                            packet.getLength()
                        );
                        merged.mergeFrom(parsed);
                        for (TvCastProtocol.CastDevice dev : TvCastProtocol.extractChromecastDevicesFromMdns(merged)) {
                            addOrUpdateDevice(dev);
                        }
                    } catch (SocketTimeoutException ignored) {
                        // Continue waiting until discovery window closes
                    }
                }
            } catch (Exception e) {
                if (running.get()) {
                    Log.d(TAG, "Raw mDNS discovery ended: " + e.getMessage());
                }
            } finally {
                if (socket != null) {
                    try {
                        socket.close();
                    } catch (Exception ignored) {
                    }
                }
                if (activeMdnsSocket == socket) {
                    activeMdnsSocket = null;
                }
            }
        });
    }

    private void startSsdpDiscovery(long timeoutMs) {
        executor.execute(() -> {
            DatagramSocket socket = null;
            try {
                socket = new DatagramSocket();
                socket.setReuseAddress(true);
                socket.setSoTimeout(700);
                activeSsdpSocket = socket;

                InetAddress group = InetAddress.getByName(SSDP_ADDRESS);
                byte[] avSearch = TvCastProtocol.buildSsdpSearchPacket(
                    TvCastProtocol.UPNP_AV_TRANSPORT_SERVICE
                ).getBytes(StandardCharsets.UTF_8);
                byte[] rendererSearch = TvCastProtocol.buildSsdpSearchPacket(
                    TvCastProtocol.UPNP_MEDIA_RENDERER_DEVICE
                ).getBytes(StandardCharsets.UTF_8);
                byte[] allSearch = TvCastProtocol.buildSsdpSearchPacket(
                    TvCastProtocol.SSDP_ALL_TARGET
                ).getBytes(StandardCharsets.UTF_8);

                socket.send(new DatagramPacket(avSearch, avSearch.length, group, SSDP_PORT));
                socket.send(new DatagramPacket(rendererSearch, rendererSearch.length, group, SSDP_PORT));
                socket.send(new DatagramPacket(allSearch, allSearch.length, group, SSDP_PORT));

                long startMs = System.currentTimeMillis();
                boolean sentSecondBurst = false;
                byte[] rxBuf = new byte[4096];

                while (running.get() && (System.currentTimeMillis() - startMs) < timeoutMs) {
                    if (!sentSecondBurst && (System.currentTimeMillis() - startMs) >= 650L) {
                        sentSecondBurst = true;
                        try {
                            socket.send(new DatagramPacket(avSearch, avSearch.length, group, SSDP_PORT));
                            socket.send(new DatagramPacket(rendererSearch, rendererSearch.length, group, SSDP_PORT));
                            socket.send(new DatagramPacket(allSearch, allSearch.length, group, SSDP_PORT));
                        } catch (Exception ignored) {
                        }
                    }

                    DatagramPacket packet = new DatagramPacket(rxBuf, rxBuf.length);
                    try {
                        socket.receive(packet);
                        String raw = new String(
                            packet.getData(),
                            packet.getOffset(),
                            packet.getLength(),
                            StandardCharsets.UTF_8
                        );
                        Map<String, String> headers = TvCastProtocol.parseSsdpResponseHeaders(raw);
                        String location = headers.get("location");
                        if (location != null && !location.isEmpty()) {
                            boolean isNew;
                            synchronized (lock) {
                                isNew = seenLocations.add(location);
                            }
                            if (isNew) {
                                final String locUrl = location;
                                executor.execute(() -> fetchUpnpDeviceXml(locUrl));
                            }
                        }
                    } catch (SocketTimeoutException ignored) {
                        // Continue listening until discovery window closes
                    }
                }
            } catch (Exception e) {
                if (running.get()) {
                    Log.d(TAG, "SSDP discovery loop ended: " + e.getMessage());
                }
            } finally {
                if (socket != null) {
                    try {
                        socket.close();
                    } catch (Exception ignored) {
                    }
                }
                if (activeSsdpSocket == socket) {
                    activeSsdpSocket = null;
                }
            }
        });
    }

    private void fetchUpnpDeviceXml(String locationUrl) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(locationUrl);
            String scheme = url.getProtocol() != null ? url.getProtocol().toLowerCase(Locale.ROOT) : "";
            if (!"http".equals(scheme) && !"https".equals(scheme)) return;

            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(2500);
            conn.setReadTimeout(2500);
            conn.setRequestMethod("GET");
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) return;

            String xml;
            try (InputStream in = conn.getInputStream()) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[4096];
                int n;
                int total = 0;
                while ((n = in.read(buf)) != -1 && total < 256 * 1024) {
                    out.write(buf, 0, n);
                    total += n;
                }
                xml = out.toString(StandardCharsets.UTF_8.name());
            }

            TvCastProtocol.CastDevice device = TvCastProtocol.parseUpnpDeviceDescription(xml, locationUrl);
            if (device != null) {
                addOrUpdateDevice(device);
            }
        } catch (Exception e) {
            Log.d(TAG, "Skipping UPnP device XML " + locationUrl + ": " + e.getMessage());
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    /**
     * Resolves the phone's local Wi-Fi/Ethernet IPv4 address so TVs on the LAN can reach the
     * background Foreground Service proxy (never 127.0.0.1).
     */
    public static String getLocalLanIpv4Address(Context ctx) {
        if (ctx != null) {
            try {
                ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
                if (cm != null) {
                    Network active = cm.getActiveNetwork();
                    if (active != null) {
                        NetworkCapabilities caps = cm.getNetworkCapabilities(active);
                        boolean isLan = caps != null && (
                            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                                || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
                        );
                        if (isLan) {
                            LinkProperties lp = cm.getLinkProperties(active);
                            if (lp != null) {
                                for (LinkAddress la : lp.getLinkAddresses()) {
                                    InetAddress addr = la.getAddress();
                                    if (addr instanceof Inet4Address && !addr.isLoopbackAddress() && addr.isSiteLocalAddress()) {
                                        String host = addr.getHostAddress();
                                        if (host != null && !host.isEmpty()) {
                                            return host;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            } catch (Exception e) {
                Log.d(TAG, "LinkProperties IPv4 lookup fallback: " + e.getMessage());
            }
        }

        String fallback = "";
        try {
            Enumeration<NetworkInterface> ifaces = NetworkInterface.getNetworkInterfaces();
            if (ifaces != null) {
                for (NetworkInterface nif : Collections.list(ifaces)) {
                    if (!nif.isUp() || nif.isLoopback() || nif.isVirtual()) continue;
                    String ifaceName = nif.getName() != null ? nif.getName().toLowerCase(Locale.ROOT) : "";
                    boolean preferredWifi = ifaceName.startsWith("wlan") || ifaceName.startsWith("eth") || ifaceName.startsWith("ap");
                    for (InetAddress addr : Collections.list(nif.getInetAddresses())) {
                        if (!(addr instanceof Inet4Address) || addr.isLoopbackAddress()) continue;
                        String ip = addr.getHostAddress();
                        if (ip == null || ip.isEmpty()) continue;
                        if (preferredWifi && addr.isSiteLocalAddress()) {
                            return ip;
                        }
                        if (fallback.isEmpty() && addr.isSiteLocalAddress()) {
                            fallback = ip;
                        }
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return fallback;
    }
}
