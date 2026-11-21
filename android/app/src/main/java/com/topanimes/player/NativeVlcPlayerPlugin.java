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

import org.json.JSONArray;

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
        JSArray episodes = call.getArray("episodes");
        JSArray watchedUrls = call.getArray("watchedUrls");
        JSArray options = call.getArray("options");

        String title = call.getString("title", "Episódio");
        String episodeUrl = call.getString("episodeUrl", "");
        String seriesUrl = call.getString("seriesUrl", "");
        String seriesTitle = call.getString("seriesTitle", "");
        String selectedServerNume = call.getString("selectedServerNume", "");
        String referer = call.getString("referer", "https://topanimes.net/");
        boolean preferDirect = Boolean.TRUE.equals(call.getBoolean("preferDirect", false));
        long startPositionMs = call.getLong("startPositionMs", 0L);
        int streamIndex = call.getInt("streamIndex", 0);
        boolean hasPrev = Boolean.TRUE.equals(call.getBoolean("hasPrev", false));
        boolean hasNext = Boolean.TRUE.equals(call.getBoolean("hasNext", false));
        String prevUrl = call.getString("prevUrl", "");
        String nextUrl = call.getString("nextUrl", "");
        int skipIntroSeconds = call.getInt("skipIntroSeconds", 85);
        boolean autoPlayNextEpisode = Boolean.TRUE.equals(call.getBoolean("autoPlayNextEpisode", false));
        String proxyBaseUrl = call.getString("proxyBaseUrl", LocalProxyPlugin.sharedProxyBaseUrl);

        Intent intent = new Intent(getContext(), VlcPlayerActivity.class);
        intent.putExtra(VlcPlayerActivity.EXTRA_TITLE, title);
        intent.putExtra(VlcPlayerActivity.EXTRA_EPISODE_URL, episodeUrl);
        intent.putExtra(VlcPlayerActivity.EXTRA_SERIES_URL, seriesUrl);
        intent.putExtra(VlcPlayerActivity.EXTRA_SERIES_TITLE, seriesTitle);
        intent.putExtra(VlcPlayerActivity.EXTRA_STREAMS_JSON, streams.toString());
        intent.putExtra(
            VlcPlayerActivity.EXTRA_SUBTITLES_JSON,
            subtitles != null ? subtitles.toString() : "[]"
        );
        intent.putExtra(
            VlcPlayerActivity.EXTRA_EPISODES_JSON,
            episodes != null ? episodes.toString() : "[]"
        );
        intent.putExtra(
            VlcPlayerActivity.EXTRA_WATCHED_URLS_JSON,
            watchedUrls != null ? watchedUrls.toString() : "[]"
        );
        intent.putExtra(
            VlcPlayerActivity.EXTRA_OPTIONS_JSON,
            options != null ? options.toString() : "[]"
        );
        intent.putExtra(VlcPlayerActivity.EXTRA_SELECTED_SERVER_NUME, selectedServerNume);
        intent.putExtra(VlcPlayerActivity.EXTRA_REFERER, referer);
        intent.putExtra(VlcPlayerActivity.EXTRA_PREFER_DIRECT, preferDirect);
        intent.putExtra(VlcPlayerActivity.EXTRA_START_POSITION_MS, startPositionMs);
        intent.putExtra(VlcPlayerActivity.EXTRA_STREAM_INDEX, streamIndex);
        intent.putExtra(VlcPlayerActivity.EXTRA_HAS_PREV, hasPrev);
        intent.putExtra(VlcPlayerActivity.EXTRA_HAS_NEXT, hasNext);
        intent.putExtra(VlcPlayerActivity.EXTRA_PREV_URL, prevUrl);
        intent.putExtra(VlcPlayerActivity.EXTRA_NEXT_URL, nextUrl);
        intent.putExtra(VlcPlayerActivity.EXTRA_SKIP_INTRO_SECONDS, skipIntroSeconds);
        intent.putExtra(VlcPlayerActivity.EXTRA_AUTO_PLAY_NEXT, autoPlayNextEpisode);
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
            ret.put("episodeUrl", data.getStringExtra(VlcPlayerActivity.RESULT_EPISODE_URL));
            ret.put("positionMs", data.getLongExtra(VlcPlayerActivity.RESULT_POSITION_MS, 0L));
            ret.put("durationMs", data.getLongExtra(VlcPlayerActivity.RESULT_DURATION_MS, 0L));
            ret.put("streamIndex", data.getIntExtra(VlcPlayerActivity.RESULT_STREAM_INDEX, 0));

            String visitedRaw = data.getStringExtra(VlcPlayerActivity.RESULT_VISITED_EPISODES_JSON);
            if (visitedRaw != null && !visitedRaw.isEmpty()) {
                try {
                    ret.put("visitedEpisodes", new JSONArray(visitedRaw));
                } catch (Exception ignored) {
                }
            }
        } else {
            ret.put("action", "closed");
            ret.put("positionMs", 0L);
            ret.put("durationMs", 0L);
            ret.put("streamIndex", 0);
        }
        call.resolve(ret);
    }
}
