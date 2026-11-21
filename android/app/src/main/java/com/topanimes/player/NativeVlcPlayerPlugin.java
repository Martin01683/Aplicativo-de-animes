package com.topanimes.player;

import android.app.Activity;
import android.content.Intent;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "NativeVlcPlayer")
public class NativeVlcPlayerPlugin extends Plugin {

    @PluginMethod
    public void play(PluginCall call) {
        JSArray streams = call.getArray("streams");
        if (streams == null || streams.length() == 0) {
            call.reject("Nenhum stream disponível.");
            return;
        }

        JSArray subtitles = call.getArray("subtitles");
        String title = call.getString("title", "Episódio");
        String referer = call.getString("referer", "https://topanimes.net/");
        boolean preferDirect = Boolean.TRUE.equals(call.getBoolean("preferDirect", false));
        long startPositionMs = call.getLong("startPositionMs", 0L);
        int streamIndex = call.getInt("streamIndex", 0);
        boolean hasPrev = Boolean.TRUE.equals(call.getBoolean("hasPrev", false));
        boolean hasNext = Boolean.TRUE.equals(call.getBoolean("hasNext", false));
        String proxyBaseUrl = call.getString("proxyBaseUrl", LocalProxyPlugin.sharedProxyBaseUrl);

        Intent intent = new Intent(getContext(), VlcPlayerActivity.class);
        intent.putExtra(VlcPlayerActivity.EXTRA_TITLE, title);
        intent.putExtra(VlcPlayerActivity.EXTRA_STREAMS_JSON, streams.toString());
        intent.putExtra(
            VlcPlayerActivity.EXTRA_SUBTITLES_JSON,
            subtitles != null ? subtitles.toString() : "[]"
        );
        intent.putExtra(VlcPlayerActivity.EXTRA_REFERER, referer);
        intent.putExtra(VlcPlayerActivity.EXTRA_PREFER_DIRECT, preferDirect);
        intent.putExtra(VlcPlayerActivity.EXTRA_START_POSITION_MS, startPositionMs);
        intent.putExtra(VlcPlayerActivity.EXTRA_STREAM_INDEX, streamIndex);
        intent.putExtra(VlcPlayerActivity.EXTRA_HAS_PREV, hasPrev);
        intent.putExtra(VlcPlayerActivity.EXTRA_HAS_NEXT, hasNext);
        intent.putExtra(VlcPlayerActivity.EXTRA_PROXY_BASE_URL, proxyBaseUrl);

        startActivityForResult(call, intent, "onPlayerResult");
    }

    @ActivityCallback
    private void onPlayerResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject ret = new JSObject();
        Intent data = result.getData();
        if (result.getResultCode() == Activity.RESULT_OK && data != null) {
            String action = data.getStringExtra(VlcPlayerActivity.RESULT_ACTION);
            ret.put("action", action != null ? action : "closed");
            ret.put("positionMs", data.getLongExtra(VlcPlayerActivity.RESULT_POSITION_MS, 0L));
            ret.put("durationMs", data.getLongExtra(VlcPlayerActivity.RESULT_DURATION_MS, 0L));
            ret.put("streamIndex", data.getIntExtra(VlcPlayerActivity.RESULT_STREAM_INDEX, 0));
        } else {
            ret.put("action", "closed");
            ret.put("positionMs", 0L);
            ret.put("durationMs", 0L);
            ret.put("streamIndex", 0);
        }
        call.resolve(ret);
    }
}
