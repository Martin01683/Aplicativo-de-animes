package com.topanimes.player;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.util.Log;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.util.List;
import java.util.Locale;

@CapacitorPlugin(name = "TvCast")
public class TvCastPlugin extends Plugin {
    private static final String TAG = "AnisyncTvCastPlugin";

    private TvCastDiscovery discovery;
    private volatile PluginCall pendingDiscoveryCall = null;
    private final TvCastService.StateListener stateListener = stateSnapshot -> {
        try {
            JSObject payload = JSObject.fromJSONObject(stateSnapshot);
            notifyListeners("castStateChanged", payload);
        } catch (Exception e) {
            Log.d(TAG, "Failed forwarding cast state: " + e.getMessage());
        }
    };

    @Override
    public void load() {
        super.load();
        discovery = new TvCastDiscovery(getContext());
        TvCastService.addStateListener(stateListener);
    }

    @Override
    protected void handleOnDestroy() {
        TvCastService.removeStateListener(stateListener);
        if (discovery != null) {
            discovery.shutdown();
            discovery = null;
        }
        super.handleOnDestroy();
    }

    @PluginMethod
    public void discoverDevices(PluginCall call) {
        if (discovery == null) {
            discovery = new TvCastDiscovery(getContext());
        }
        resolvePendingDiscoveryCall(discovery.getDiscoveredDevices());
        pendingDiscoveryCall = call;

        long timeoutMs = readLongParam(call, "timeoutMs", 5500L);
        discovery.startDiscovery(timeoutMs, new TvCastDiscovery.Listener() {
            @Override
            public void onDevicesChanged(List<TvCastProtocol.CastDevice> devices) {
                JSObject ev = new JSObject();
                ev.put("devices", devicesToJsArray(devices));
                ev.put("scanning", true);
                notifyListeners("castDevicesUpdated", ev);
            }

            @Override
            public void onDiscoveryFinished(List<TvCastProtocol.CastDevice> devices) {
                JSArray arr = devicesToJsArray(devices);
                JSObject ev = new JSObject();
                ev.put("devices", arr);
                ev.put("scanning", false);
                notifyListeners("castDevicesUpdated", ev);

                if (pendingDiscoveryCall == call) {
                    pendingDiscoveryCall = null;
                    JSObject ret = new JSObject();
                    ret.put("devices", arr);
                    call.resolve(ret);
                }
            }
        });
    }

    @PluginMethod
    public void stopDiscovery(PluginCall call) {
        if (discovery != null) {
            List<TvCastProtocol.CastDevice> current = discovery.getDiscoveredDevices();
            discovery.stopDiscovery();
            resolvePendingDiscoveryCall(current);
        }
        call.resolve();
    }

    private void resolvePendingDiscoveryCall(List<TvCastProtocol.CastDevice> devices) {
        PluginCall prev = pendingDiscoveryCall;
        pendingDiscoveryCall = null;
        if (prev != null) {
            JSObject ret = new JSObject();
            ret.put("devices", devicesToJsArray(devices));
            prev.resolve(ret);
        }
    }

    @PluginMethod
    public void addManualDevice(PluginCall call) {
        String host = call.getString("host", "").trim();
        if (host.isEmpty()) {
            call.reject("Informe o endereço IP da TV na rede Wi-Fi.");
            return;
        }
        String protocol = call.getString("protocol", TvCastProtocol.PROTOCOL_CHROMECAST).trim().toLowerCase(Locale.ROOT);
        int defaultPort = TvCastProtocol.PROTOCOL_DLNA.equals(protocol)
            ? 80
            : TvCastProtocol.CHROMECAST_DEFAULT_PORT;
        int port = call.getInt("port", defaultPort);
        String name = call.getString("name", "").trim();
        String controlUrl = call.getString("avTransportControlUrl", "").trim();

        if (TvCastProtocol.PROTOCOL_DLNA.equals(protocol) && controlUrl.isEmpty()) {
            call.reject("Para adicionar manualmente sem URL DLNA, selecione Chromecast / Android TV ou use a busca automática.");
            return;
        }

        TvCastProtocol.CastDevice device = new TvCastProtocol.CastDevice(
            "manual:" + protocol + ":" + host + ":" + port,
            name.isEmpty() ? ("TV (" + host + ")") : name,
            "Manual",
            TvCastProtocol.PROTOCOL_DLNA.equals(protocol) ? "Smart TV (DLNA)" : "Chromecast / Android TV",
            host,
            port,
            protocol,
            controlUrl,
            "",
            ""
        );

        JSObject ret = new JSObject();
        ret.put("device", deviceToJsObject(device));
        call.resolve(ret);
    }

    @PluginMethod
    public void startCast(PluginCall call) {
        JSObject deviceObj = call.getObject("device");
        JSObject mediaObj = call.getObject("media");
        if (deviceObj == null || mediaObj == null) {
            call.reject("Dispositivo de TV e dados da mídia são obrigatórios.");
            return;
        }
        String deliveryMode = call.getString("deliveryMode", "auto");

        Intent intent = new Intent(getContext(), TvCastService.class);
        intent.setAction(TvCastService.ACTION_START_CAST);
        intent.putExtra(TvCastService.EXTRA_DEVICE_JSON, deviceObj.toString());
        intent.putExtra(TvCastService.EXTRA_MEDIA_JSON, mediaObj.toString());
        intent.putExtra(TvCastService.EXTRA_DELIVERY_MODE, deliveryMode);
        ContextCompat.startForegroundService(getContext(), intent);

        JSObject ret = new JSObject();
        ret.put("started", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void prepareExternalCast(PluginCall call) {
        JSObject mediaObj = call.getObject("media");
        if (mediaObj == null) {
            call.reject("Dados da mídia são obrigatórios.");
            return;
        }
        boolean openExternalApp = Boolean.TRUE.equals(call.getBoolean("openExternalApp", false));
        String title = mediaObj.optString("title", "Anisync");
        String streamUrl = mediaObj.optString("streamUrl", "");
        String streamFormat = mediaObj.optString("streamFormat", "mp4");
        boolean preserveActiveController = !openExternalApp || TvCastService.hasActiveRemoteController();

        TvCastService.clearPreparedLanStreamUrl();
        Context ctx = getContext();
        Intent serviceIntent = new Intent(ctx, TvCastService.class);
        serviceIntent.setAction(TvCastService.ACTION_PREPARE_LAN_ONLY);
        serviceIntent.putExtra(TvCastService.EXTRA_MEDIA_JSON, mediaObj.toString());
        serviceIntent.putExtra(TvCastService.EXTRA_PRESERVE_ACTIVE_CONTROLLER, preserveActiveController);
        ContextCompat.startForegroundService(ctx, serviceIntent);

        // Wait briefly (up to 1.5s) for the foreground service LAN server to expose the token-gated URL
        new Thread(() -> {
            String lanUrl = "";
            long deadline = System.currentTimeMillis() + 1500L;
            while (System.currentTimeMillis() < deadline) {
                lanUrl = TvCastService.getPreparedLanStreamUrl();
                if (lanUrl != null && !lanUrl.isEmpty()) break;
                try {
                    Thread.sleep(60L);
                } catch (InterruptedException ignored) {
                    break;
                }
            }

            String finalUrl = (lanUrl != null && !lanUrl.isEmpty()) ? lanUrl : streamUrl;
            boolean opened = false;
            if (openExternalApp && finalUrl != null && !finalUrl.isEmpty()) {
                try {
                    Intent viewIntent = new Intent(Intent.ACTION_VIEW);
                    String mime = TvCastProtocol.isHlsStreamUrl(finalUrl, streamFormat)
                        ? "application/x-mpegurl"
                        : "video/*";
                    viewIntent.setDataAndType(Uri.parse(finalUrl), mime);
                    viewIntent.putExtra("title", title);
                    viewIntent.putExtra("name", title);
                    Intent chooser = Intent.createChooser(viewIntent, "Transmitir ou abrir com...");
                    chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    ctx.startActivity(chooser);
                    opened = true;
                } catch (Exception e) {
                    Log.w(TAG, "Failed launching external TV/video chooser: " + e.getMessage());
                }
            }

            JSObject ret = new JSObject();
            ret.put("streamUrl", finalUrl != null ? finalUrl : "");
            ret.put("lanStreamUrl", lanUrl != null ? lanUrl : "");
            ret.put("directUrl", streamUrl != null ? streamUrl : "");
            ret.put("opened", opened);
            call.resolve(ret);
        }, "AnisyncExternalCastPrep").start();
    }

    @PluginMethod
    public void play(PluginCall call) {
        sendSimpleControlAction(TvCastService.ACTION_PLAY);
        call.resolve();
    }

    @PluginMethod
    public void pause(PluginCall call) {
        sendSimpleControlAction(TvCastService.ACTION_PAUSE);
        call.resolve();
    }

    @PluginMethod
    public void togglePlayPause(PluginCall call) {
        sendSimpleControlAction(TvCastService.ACTION_TOGGLE_PLAY_PAUSE);
        call.resolve();
    }

    @PluginMethod
    public void seek(PluginCall call) {
        long positionMs = Math.max(0L, readLongParam(call, "positionMs", 0L));
        Intent intent = new Intent(getContext(), TvCastService.class);
        intent.setAction(TvCastService.ACTION_SEEK_TO);
        intent.putExtra(TvCastService.EXTRA_POSITION_MS, positionMs);
        ContextCompat.startForegroundService(getContext(), intent);
        call.resolve();
    }

    @PluginMethod
    public void seekBy(PluginCall call) {
        long deltaMs = readLongParam(call, "deltaMs", 0L);
        Intent intent = new Intent(getContext(), TvCastService.class);
        intent.setAction(TvCastService.ACTION_SEEK_BY);
        intent.putExtra(TvCastService.EXTRA_DELTA_MS, deltaMs);
        ContextCompat.startForegroundService(getContext(), intent);
        call.resolve();
    }

    /**
     * Capacitor's PluginCall.getLong() only checks `value instanceof Long` and returns the
     * default (0L!) for JSON numbers deserialized by org.json.JSONObject as Integer (< 2^31)
     * or Double. Reading via Number handles Integer, Long, Double, Float, and numeric Strings.
     */
    private static long readLongParam(PluginCall call, String key, long defaultValue) {
        if (call == null || call.getData() == null) return defaultValue;
        Object raw = call.getData().opt(key);
        if (raw instanceof Number) {
            return Math.round(((Number) raw).doubleValue());
        }
        if (raw instanceof String) {
            try {
                return Math.round(Double.parseDouble(((String) raw).trim()));
            } catch (NumberFormatException ignored) {
            }
        }
        return defaultValue;
    }

    @PluginMethod
    public void setVolume(PluginCall call) {
        double vol = call.getDouble("volume", 1.0);
        Intent intent = new Intent(getContext(), TvCastService.class);
        intent.setAction(TvCastService.ACTION_SET_VOLUME);
        intent.putExtra(TvCastService.EXTRA_VOLUME, vol);
        ContextCompat.startForegroundService(getContext(), intent);
        call.resolve();
    }

    @PluginMethod
    public void setTracks(PluginCall call) {
        if (!TvCastService.isCastActive()) {
            call.resolve();
            return;
        }
        JSObject data = call.getData();
        Intent intent = new Intent(getContext(), TvCastService.class);
        intent.setAction(TvCastService.ACTION_SET_TRACKS);
        intent.putExtra(TvCastService.EXTRA_TRACKS_JSON, data != null ? data.toString() : "{}");
        ContextCompat.startForegroundService(getContext(), intent);
        call.resolve();
    }

    @PluginMethod
    public void nextEpisode(PluginCall call) {
        sendSimpleControlAction(TvCastService.ACTION_NEXT_EPISODE);
        call.resolve();
    }

    @PluginMethod
    public void prevEpisode(PluginCall call) {
        sendSimpleControlAction(TvCastService.ACTION_PREV_EPISODE);
        call.resolve();
    }

    @PluginMethod
    public void stopCast(PluginCall call) {
        Intent intent = new Intent(getContext(), TvCastService.class);
        intent.setAction(TvCastService.ACTION_STOP_CAST);
        try {
            getContext().startService(intent);
        } catch (Exception ignored) {
        }
        call.resolve();
    }

    @PluginMethod
    public void getCastState(PluginCall call) {
        try {
            JSONObject snap = TvCastService.getCurrentStateJson();
            call.resolve(JSObject.fromJSONObject(snap));
        } catch (Exception e) {
            JSObject fallback = new JSObject();
            fallback.put("active", false);
            fallback.put("status", "idle");
            call.resolve(fallback);
        }
    }

    private void sendSimpleControlAction(String action) {
        if (!TvCastService.isCastActive()) return;
        Intent intent = new Intent(getContext(), TvCastService.class);
        intent.setAction(action);
        ContextCompat.startForegroundService(getContext(), intent);
    }

    public static JSObject deviceToJsObject(TvCastProtocol.CastDevice device) {
        JSObject obj = new JSObject();
        obj.put("id", device.id);
        obj.put("name", device.name);
        obj.put("manufacturer", device.manufacturer);
        obj.put("model", device.model);
        obj.put("host", device.host);
        obj.put("port", device.port);
        obj.put("protocol", device.protocol);
        obj.put("avTransportControlUrl", device.avTransportControlUrl);
        obj.put("renderingControlUrl", device.renderingControlUrl);
        obj.put("locationUrl", device.locationUrl);
        return obj;
    }

    public static JSArray devicesToJsArray(List<TvCastProtocol.CastDevice> devices) {
        JSArray arr = new JSArray();
        if (devices != null) {
            for (TvCastProtocol.CastDevice d : devices) {
                arr.put(deviceToJsObject(d));
            }
        }
        return arr;
    }
}
