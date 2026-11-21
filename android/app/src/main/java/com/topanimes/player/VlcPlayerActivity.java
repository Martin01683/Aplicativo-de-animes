package com.topanimes.player;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Typeface;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.RelativeLayout;
import android.widget.ScrollView;
import android.widget.SeekBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import org.json.JSONArray;
import org.json.JSONObject;
import org.videolan.libvlc.LibVLC;
import org.videolan.libvlc.Media;
import org.videolan.libvlc.MediaPlayer;
import org.videolan.libvlc.interfaces.IMedia;
import org.videolan.libvlc.util.VLCVideoLayout;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

public class VlcPlayerActivity extends AppCompatActivity {
    private static final String TAG = "TopAnimesLibVLC";
    private static final String DEFAULT_UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
    private static final float[] SPEED_OPTIONS = new float[] { 0.5f, 0.75f, 1.0f, 1.25f, 1.5f, 2.0f };
    private static final MediaPlayer.ScaleType[] SCALE_OPTIONS = new MediaPlayer.ScaleType[] {
        MediaPlayer.ScaleType.SURFACE_BEST_FIT,
        MediaPlayer.ScaleType.SURFACE_FIT_SCREEN,
        MediaPlayer.ScaleType.SURFACE_FILL,
        MediaPlayer.ScaleType.SURFACE_16_9,
        MediaPlayer.ScaleType.SURFACE_ORIGINAL
    };
    private static final String[] SCALE_LABELS = new String[] {
        "Ajustar (Padrão)",
        "Ajustar à tela",
        "Preencher",
        "16:9",
        "Original"
    };

    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_EPISODE_URL = "episodeUrl";
    public static final String EXTRA_SERIES_URL = "seriesUrl";
    public static final String EXTRA_SERIES_TITLE = "seriesTitle";
    public static final String EXTRA_STREAMS_JSON = "streamsJson";
    public static final String EXTRA_SUBTITLES_JSON = "subtitlesJson";
    public static final String EXTRA_EPISODES_JSON = "episodesJson";
    public static final String EXTRA_WATCHED_URLS_JSON = "watchedUrlsJson";
    public static final String EXTRA_OPTIONS_JSON = "optionsJson";
    public static final String EXTRA_SELECTED_SERVER_NUME = "selectedServerNume";
    public static final String EXTRA_REFERER = "referer";
    public static final String EXTRA_PREFER_DIRECT = "preferDirect";
    public static final String EXTRA_START_POSITION_MS = "startPositionMs";
    public static final String EXTRA_STREAM_INDEX = "streamIndex";
    public static final String EXTRA_HAS_PREV = "hasPrev";
    public static final String EXTRA_HAS_NEXT = "hasNext";
    public static final String EXTRA_PREV_URL = "prevUrl";
    public static final String EXTRA_NEXT_URL = "nextUrl";
    public static final String EXTRA_SKIP_INTRO_SECONDS = "skipIntroSeconds";
    public static final String EXTRA_AUTO_PLAY_NEXT = "autoPlayNextEpisode";
    public static final String EXTRA_PROXY_BASE_URL = "proxyBaseUrl";

    public static final String RESULT_ACTION = "action";
    public static final String RESULT_EPISODE_URL = "episodeUrl";
    public static final String RESULT_POSITION_MS = "positionMs";
    public static final String RESULT_DURATION_MS = "durationMs";
    public static final String RESULT_STREAM_INDEX = "streamIndex";
    public static final String RESULT_VISITED_EPISODES_JSON = "visitedEpisodesJson";

    private static class StreamItem {
        final String label;
        final String url;

        StreamItem(String label, String url) {
            this.label = label;
            this.url = url;
        }
    }

    private static class SubtitleItem {
        final String label;
        final String url;
        final boolean isDefault;

        SubtitleItem(String label, String url, boolean isDefault) {
            this.label = label;
            this.url = url;
            this.isDefault = isDefault;
        }
    }

    private LibVLC libVlc;
    private MediaPlayer mediaPlayer;
    private VLCVideoLayout videoLayout;

    private RelativeLayout controlsOverlay;
    private LinearLayout loadingContainer;
    private TextView loadingLabel;
    private LinearLayout errorOverlay;
    private TextView errorText;
    private TextView titleView;
    private TextView seriesTitleView;
    private LinearLayout btnTopEpisodes;
    private TextView topEpisodesText;
    private ImageButton btnPlayCenter;
    private ImageButton btnPlayBottom;
    private ImageButton btnMute;
    private SeekBar seekBar;
    private TextView timeCurrentView;
    private TextView timeDurationView;
    private View btnRew5;
    private View btnFwd5;
    private TextView btnSkipIntro;
    private ImageButton btnPrevEp;
    private View btnEpisodes;
    private TextView btnEpisodesLabel;
    private ImageButton btnNextEp;
    private TextView btnQuality;
    private ImageButton btnTracks;
    private ImageButton btnSettings;
    private ImageButton btnFullscreen;
    private TextView seekBadge;
    private TextView holdSpeedBadge;

    private FrameLayout settingsOverlay;
    private LinearLayout settingsHeader;
    private TextView settingsHeaderTitle;
    private View settingsHeaderDivider;
    private LinearLayout settingsItems;

    private FrameLayout episodesOverlay;
    private LinearLayout episodesDrawer;
    private TextView episodesSeriesTitle;
    private TextView episodesEmpty;
    private ScrollView episodesScroll;
    private LinearLayout episodesList;

    private final Handler uiHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService bgExecutor = Executors.newCachedThreadPool();
    private final AtomicInteger episodeLoadGen = new AtomicInteger(0);

    private final List<StreamItem> streams = new ArrayList<>();
    private final List<SubtitleItem> subtitles = new ArrayList<>();
    private final List<TopAnimesEpisodeResolver.EpisodeLink> seriesEpisodes = new ArrayList<>();
    private final List<TopAnimesEpisodeResolver.ServerOption> serverOptions = new ArrayList<>();
    private final Set<String> watchedUrls = new HashSet<>();
    private final Map<String, String> visitedEpisodes = new LinkedHashMap<>();
    private final List<File> cachedSubFiles = new ArrayList<>();

    private String episodeTitle = "Episódio";
    private String episodeUrl = "";
    private String seriesUrl = "";
    private String seriesTitle = "";
    private String selectedServerNume = "";
    private String prevUrl = "";
    private String nextUrl = "";
    private boolean hasPrevFlag = false;
    private boolean hasNextFlag = false;
    private String referer = "https://topanimes.net/";
    private String proxyBaseUrl = "";
    private boolean preferDirect = false;
    private boolean useProxyForAttempt = false;
    private int currentStreamIdx = 0;
    private long pendingSeekMs = 0L;
    private long lastKnownPositionMs = 0L;
    private long lastKnownDurationMs = 0L;
    private int skipIntroSeconds = 85;
    private boolean autoPlayNextEpisode = false;

    private float currentSpeed = 1.0f;
    private int currentScaleIdx = 0;
    private boolean muted = false;
    private boolean controlsVisible = true;
    private boolean userScrubbing = false;
    private boolean playbackFailed = false;
    private boolean loadingEpisode = false;
    private boolean subtitlesAttached = false;
    private String settingsTab = "main";

    private boolean holdSpeedActive = false;
    private long lastTapTimeMs = 0L;
    private int lastTapSide = 0;

    private AudioManager audioManager;
    private AudioFocusRequest audioFocusRequest;

    private final Runnable hideControlsRunnable = () -> setControlsVisible(false);
    private final Runnable hideSeekBadgeRunnable = () -> {
        if (seekBadge != null) seekBadge.setVisibility(View.GONE);
    };
    private final Runnable holdSpeedRunnable = () -> {
        if (mediaPlayer != null && !playbackFailed && !loadingEpisode) {
            holdSpeedActive = true;
            mediaPlayer.setRate(2.0f);
            if (holdSpeedBadge != null) holdSpeedBadge.setVisibility(View.VISIBLE);
        }
    };

    private final ActivityResultLauncher<String[]> subtitleFilePicker = registerForActivityResult(
        new ActivityResultContracts.OpenDocument(),
        uri -> {
            if (uri != null && mediaPlayer != null) {
                try {
                    getContentResolver().takePersistableUriPermission(
                        uri,
                        Intent.FLAG_GRANT_READ_URI_PERMISSION
                    );
                } catch (Exception ignored) {
                }
                mediaPlayer.addSlave(IMedia.Slave.Type.Subtitle, uri, true);
                Toast.makeText(this, "Legenda local carregada no LibVLC.", Toast.LENGTH_SHORT).show();
            }
        }
    );

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
        setContentView(R.layout.activity_vlc_player);
        enterImmersiveMode();

        bindViews();
        parseIntentExtras(getIntent());
        setupAudioFocus();
        initLibVlc();
        setupInteractions();
        adjustResponsiveHud();
        updateEpisodeNavButtons();
        maybeFetchSeriesEpisodesInBackground();
        prepareAndPlayCurrentStream();
    }

    private void bindViews() {
        videoLayout = findViewById(R.id.vlc_video_layout);
        controlsOverlay = findViewById(R.id.vlc_controls_overlay);
        loadingContainer = findViewById(R.id.vlc_loading_container);
        loadingLabel = findViewById(R.id.vlc_loading_label);
        errorOverlay = findViewById(R.id.vlc_error_overlay);
        errorText = findViewById(R.id.vlc_error_text);
        titleView = findViewById(R.id.vlc_title);
        seriesTitleView = findViewById(R.id.vlc_series_title);
        btnTopEpisodes = findViewById(R.id.vlc_btn_top_episodes);
        topEpisodesText = findViewById(R.id.vlc_top_episodes_text);
        btnPlayCenter = findViewById(R.id.vlc_btn_play_center);
        btnPlayBottom = findViewById(R.id.vlc_btn_play_bottom);
        btnMute = findViewById(R.id.vlc_btn_mute);
        seekBar = findViewById(R.id.vlc_seekbar);
        timeCurrentView = findViewById(R.id.vlc_time_current);
        timeDurationView = findViewById(R.id.vlc_time_duration);
        btnRew5 = findViewById(R.id.vlc_btn_rew5);
        btnFwd5 = findViewById(R.id.vlc_btn_fwd5);
        btnSkipIntro = findViewById(R.id.vlc_btn_skip_intro);
        btnPrevEp = findViewById(R.id.vlc_btn_prev_ep);
        btnEpisodes = findViewById(R.id.vlc_btn_episodes);
        btnEpisodesLabel = findViewById(R.id.vlc_btn_episodes_label);
        btnNextEp = findViewById(R.id.vlc_btn_next_ep);
        btnQuality = findViewById(R.id.vlc_btn_quality);
        btnTracks = findViewById(R.id.vlc_btn_tracks);
        btnSettings = findViewById(R.id.vlc_btn_settings);
        btnFullscreen = findViewById(R.id.vlc_btn_fullscreen);
        seekBadge = findViewById(R.id.vlc_seek_badge);
        holdSpeedBadge = findViewById(R.id.vlc_hold_speed_badge);

        settingsOverlay = findViewById(R.id.vlc_settings_overlay);
        settingsHeader = findViewById(R.id.vlc_settings_header);
        settingsHeaderTitle = findViewById(R.id.vlc_settings_header_title);
        settingsHeaderDivider = findViewById(R.id.vlc_settings_header_divider);
        settingsItems = findViewById(R.id.vlc_settings_items);

        episodesOverlay = findViewById(R.id.vlc_episodes_overlay);
        episodesDrawer = findViewById(R.id.vlc_episodes_drawer);
        episodesSeriesTitle = findViewById(R.id.vlc_episodes_series_title);
        episodesEmpty = findViewById(R.id.vlc_episodes_empty);
        episodesScroll = findViewById(R.id.vlc_episodes_scroll);
        episodesList = findViewById(R.id.vlc_episodes_list);
    }

    private void parseIntentExtras(Intent intent) {
        if (intent == null) return;
        episodeTitle = safeStr(intent.getStringExtra(EXTRA_TITLE));
        if (episodeTitle.isEmpty()) episodeTitle = "Episódio";
        episodeUrl = safeStr(intent.getStringExtra(EXTRA_EPISODE_URL));
        seriesUrl = safeStr(intent.getStringExtra(EXTRA_SERIES_URL));
        seriesTitle = safeStr(intent.getStringExtra(EXTRA_SERIES_TITLE));
        selectedServerNume = safeStr(intent.getStringExtra(EXTRA_SELECTED_SERVER_NUME));
        prevUrl = safeStr(intent.getStringExtra(EXTRA_PREV_URL));
        nextUrl = safeStr(intent.getStringExtra(EXTRA_NEXT_URL));
        hasPrevFlag = intent.getBooleanExtra(EXTRA_HAS_PREV, false);
        hasNextFlag = intent.getBooleanExtra(EXTRA_HAS_NEXT, false);

        skipIntroSeconds = Math.max(5, Math.min(300, intent.getIntExtra(EXTRA_SKIP_INTRO_SECONDS, 85)));
        autoPlayNextEpisode = intent.getBooleanExtra(EXTRA_AUTO_PLAY_NEXT, false);
        btnSkipIntro.setText("+" + skipIntroSeconds + "s");

        if (!episodeUrl.isEmpty()) {
            visitedEpisodes.put(normalizeUrlKey(episodeUrl), episodeTitle);
            watchedUrls.add(normalizeUrlKey(episodeUrl));
        }

        updateHeaderTitles();

        String ref = safeStr(intent.getStringExtra(EXTRA_REFERER));
        if (!ref.isEmpty()) referer = ref;

        String proxy = safeStr(intent.getStringExtra(EXTRA_PROXY_BASE_URL));
        if (!proxy.isEmpty()) {
            proxyBaseUrl = proxy;
        } else if (LocalProxyPlugin.sharedProxyBaseUrl != null) {
            proxyBaseUrl = LocalProxyPlugin.sharedProxyBaseUrl;
        }

        preferDirect = intent.getBooleanExtra(EXTRA_PREFER_DIRECT, false);
        useProxyForAttempt = !preferDirect && !proxyBaseUrl.isEmpty();
        pendingSeekMs = Math.max(0L, intent.getLongExtra(EXTRA_START_POSITION_MS, 0L));
        lastKnownPositionMs = pendingSeekMs;

        parseStreamsJson(intent.getStringExtra(EXTRA_STREAMS_JSON));
        int reqIdx = intent.getIntExtra(EXTRA_STREAM_INDEX, 0);
        if (reqIdx >= 0 && reqIdx < streams.size()) {
            currentStreamIdx = reqIdx;
        }
        parseSubtitlesJson(intent.getStringExtra(EXTRA_SUBTITLES_JSON));
        parseEpisodesJson(intent.getStringExtra(EXTRA_EPISODES_JSON));
        parseWatchedUrlsJson(intent.getStringExtra(EXTRA_WATCHED_URLS_JSON));
        parseOptionsJson(intent.getStringExtra(EXTRA_OPTIONS_JSON));

        syncPrevNextFromSeries();
        updateQualityLabel();
    }

    private void parseStreamsJson(String raw) {
        streams.clear();
        if (raw == null || raw.isEmpty()) return;
        try {
            JSONArray arr = new JSONArray(raw);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject obj = arr.optJSONObject(i);
                if (obj == null) continue;
                String url = obj.optString("url", "").trim();
                String label = obj.optString("label", "Auto").trim();
                if (!url.isEmpty()) {
                    streams.add(new StreamItem(label.isEmpty() ? "Auto" : label, url));
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed parsing streams JSON", e);
        }
    }

    private void parseSubtitlesJson(String raw) {
        subtitles.clear();
        if (raw == null || raw.isEmpty()) return;
        try {
            JSONArray arr = new JSONArray(raw);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject obj = arr.optJSONObject(i);
                if (obj == null) continue;
                String url = obj.optString("url", "").trim();
                String label = obj.optString("label", "Legenda " + (i + 1)).trim();
                boolean isDefault = obj.optBoolean("isDefault", i == 0);
                if (!url.isEmpty()) {
                    subtitles.add(new SubtitleItem(label, url, isDefault));
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed parsing subtitles JSON", e);
        }
    }

    private void parseEpisodesJson(String raw) {
        seriesEpisodes.clear();
        if (raw == null || raw.isEmpty()) return;
        try {
            JSONArray arr = new JSONArray(raw);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject obj = arr.optJSONObject(i);
                if (obj == null) continue;
                String url = obj.optString("url", "").trim();
                String title = obj.optString("title", "Episódio").trim();
                String numberLabel = obj.optString("numberLabel", "").trim();
                int epNum = obj.has("episodeNumber") && !obj.isNull("episodeNumber")
                    ? obj.optInt("episodeNumber", -1)
                    : -1;
                if (!url.isEmpty()) {
                    seriesEpisodes.add(new TopAnimesEpisodeResolver.EpisodeLink(numberLabel, epNum, title, url));
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed parsing episodes JSON", e);
        }
    }

    private void parseWatchedUrlsJson(String raw) {
        if (raw == null || raw.isEmpty()) return;
        try {
            JSONArray arr = new JSONArray(raw);
            for (int i = 0; i < arr.length(); i++) {
                String u = arr.optString(i, "").trim();
                if (!u.isEmpty()) watchedUrls.add(normalizeUrlKey(u));
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed parsing watchedUrls JSON", e);
        }
    }

    private void parseOptionsJson(String raw) {
        serverOptions.clear();
        if (raw == null || raw.isEmpty()) return;
        try {
            JSONArray arr = new JSONArray(raw);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject obj = arr.optJSONObject(i);
                if (obj == null) continue;
                String nume = obj.optString("nume", "").trim();
                String label = obj.optString("label", "Servidor " + nume).trim();
                String embedUrl = obj.optString("embedUrl", "").trim();
                String kind = obj.optString("providerKind", "other").trim();
                if (!nume.isEmpty() && !embedUrl.isEmpty()) {
                    serverOptions.add(new TopAnimesEpisodeResolver.ServerOption(nume, label, embedUrl, kind));
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed parsing options JSON", e);
        }
    }

    private void updateHeaderTitles() {
        titleView.setText(episodeTitle);
        if (!seriesTitle.isEmpty() && !seriesTitle.equalsIgnoreCase(episodeTitle)) {
            seriesTitleView.setText(seriesTitle);
            seriesTitleView.setVisibility(View.VISIBLE);
        } else {
            seriesTitleView.setVisibility(View.GONE);
        }
        if (!seriesTitle.isEmpty()) {
            episodesSeriesTitle.setText(seriesTitle);
            episodesSeriesTitle.setVisibility(View.VISIBLE);
        } else {
            episodesSeriesTitle.setVisibility(View.GONE);
        }
    }

    private void syncPrevNextFromSeries() {
        if (seriesEpisodes.isEmpty() || episodeUrl.isEmpty()) return;
        int currentIdx = -1;
        for (int i = 0; i < seriesEpisodes.size(); i++) {
            if (isSameEpisodeUrl(seriesEpisodes.get(i).url, episodeUrl)) {
                currentIdx = i;
                break;
            }
        }
        if (currentIdx < 0) return;

        boolean ascending = true;
        if (seriesEpisodes.size() >= 2) {
            int firstNum = seriesEpisodes.get(0).episodeNumber;
            int lastNum = seriesEpisodes.get(seriesEpisodes.size() - 1).episodeNumber;
            if (firstNum >= 0 && lastNum >= 0 && firstNum != lastNum) {
                ascending = lastNum > firstNum;
            }
        }

        int prevIdx = ascending ? currentIdx - 1 : currentIdx + 1;
        int nextIdx = ascending ? currentIdx + 1 : currentIdx - 1;

        if (prevUrl.isEmpty() && prevIdx >= 0 && prevIdx < seriesEpisodes.size()) {
            prevUrl = seriesEpisodes.get(prevIdx).url;
        }
        if (nextUrl.isEmpty() && nextIdx >= 0 && nextIdx < seriesEpisodes.size()) {
            nextUrl = seriesEpisodes.get(nextIdx).url;
        }
    }

    private void updateEpisodeNavButtons() {
        boolean canPrev = !prevUrl.isEmpty() || hasPrevFlag;
        boolean canNext = !nextUrl.isEmpty() || hasNextFlag;

        btnPrevEp.setVisibility(canPrev || !seriesEpisodes.isEmpty() ? View.VISIBLE : View.GONE);
        btnPrevEp.setEnabled(canPrev && !loadingEpisode);
        btnPrevEp.setAlpha(canPrev && !loadingEpisode ? 1.0f : 0.35f);

        btnNextEp.setVisibility(canNext || !seriesEpisodes.isEmpty() ? View.VISIBLE : View.GONE);
        btnNextEp.setEnabled(canNext && !loadingEpisode);
        btnNextEp.setAlpha(canNext && !loadingEpisode ? 1.0f : 0.35f);

        boolean hasEpisodes = !seriesEpisodes.isEmpty();
        btnEpisodes.setVisibility(hasEpisodes ? View.VISIBLE : View.GONE);
        btnTopEpisodes.setVisibility(hasEpisodes ? View.VISIBLE : View.GONE);
        if (hasEpisodes) {
            topEpisodesText.setText("Episódios (" + seriesEpisodes.size() + ")");
        }
    }

    private void maybeFetchSeriesEpisodesInBackground() {
        if (!seriesEpisodes.isEmpty() || seriesUrl.isEmpty()) return;
        final String targetSeries = seriesUrl;
        bgExecutor.execute(() -> {
            List<TopAnimesEpisodeResolver.EpisodeLink> fetched = TopAnimesEpisodeResolver.fetchSeriesEpisodes(targetSeries);
            if (fetched.isEmpty()) return;
            uiHandler.post(() -> {
                if (isFinishing() || isDestroyed()) return;
                if (seriesEpisodes.isEmpty()) {
                    seriesEpisodes.addAll(fetched);
                    syncPrevNextFromSeries();
                    updateEpisodeNavButtons();
                    if (episodesOverlay.getVisibility() == View.VISIBLE) {
                        populateEpisodesDrawer();
                    }
                }
            });
        });
    }

    private void initLibVlc() {
        ArrayList<String> options = new ArrayList<>();
        options.add("--no-drop-late-frames");
        options.add("--no-skip-frames");
        options.add("--network-caching=1500");
        options.add("--http-reconnect");
        libVlc = new LibVLC(this, options);
        libVlc.setUserAgent("TopAnimes", DEFAULT_UA);

        mediaPlayer = new MediaPlayer(libVlc);
        mediaPlayer.attachViews(videoLayout, null, true, false);
        mediaPlayer.setVideoScale(SCALE_OPTIONS[currentScaleIdx]);

        mediaPlayer.setEventListener(event -> {
            switch (event.type) {
                case MediaPlayer.Event.Opening:
                    uiHandler.post(() -> {
                        if (isFinishing() || isDestroyed()) return;
                        showLoading(loadingEpisode ? "Carregando episódio..." : null);
                        errorOverlay.setVisibility(View.GONE);
                    });
                    break;
                case MediaPlayer.Event.Buffering:
                    float pct = event.getBuffering();
                    uiHandler.post(() -> {
                        if (isFinishing() || isDestroyed()) return;
                        if (pct >= 100f && !loadingEpisode) {
                            hideLoading();
                        } else if (mediaPlayer != null && !mediaPlayer.isPlaying()) {
                            showLoading(loadingEpisode ? "Carregando episódio..." : null);
                        }
                    });
                    break;
                case MediaPlayer.Event.Playing:
                    uiHandler.post(() -> {
                        if (isFinishing() || isDestroyed()) return;
                        playbackFailed = false;
                        loadingEpisode = false;
                        hideLoading();
                        errorOverlay.setVisibility(View.GONE);
                        updatePlayPauseIcons(true);
                        updateEpisodeNavButtons();
                        if (pendingSeekMs > 0L && mediaPlayer != null && mediaPlayer.isSeekable()) {
                            long target = pendingSeekMs;
                            pendingSeekMs = 0L;
                            mediaPlayer.setTime(target);
                        }
                        if (mediaPlayer != null) {
                            mediaPlayer.setRate(holdSpeedActive ? 2.0f : currentSpeed);
                            mediaPlayer.setVolume(muted ? 0 : 100);
                        }
                        if (!subtitlesAttached) {
                            subtitlesAttached = true;
                            downloadAndAttachSubtitles();
                        }
                        scheduleControlsAutoHide();
                    });
                    break;
                case MediaPlayer.Event.Paused:
                    uiHandler.post(() -> {
                        if (isFinishing() || isDestroyed()) return;
                        updatePlayPauseIcons(false);
                        setControlsVisible(true);
                    });
                    break;
                case MediaPlayer.Event.LengthChanged:
                    long len = event.getLengthChanged();
                    if (len > 0) {
                        lastKnownDurationMs = len;
                        uiHandler.post(() -> {
                            if (isFinishing() || isDestroyed()) return;
                            seekBar.setMax((int) Math.min(Integer.MAX_VALUE, len));
                            timeDurationView.setText(formatMs(len));
                        });
                    }
                    break;
                case MediaPlayer.Event.TimeChanged:
                    long timeMs = event.getTimeChanged();
                    lastKnownPositionMs = timeMs;
                    uiHandler.post(() -> {
                        if (isFinishing() || isDestroyed()) return;
                        if (!userScrubbing) {
                            seekBar.setProgress((int) Math.min(Integer.MAX_VALUE, timeMs));
                            timeCurrentView.setText(formatMs(timeMs));
                        }
                        long totalLen = mediaPlayer != null ? mediaPlayer.getLength() : 0L;
                        if (totalLen > 0 && totalLen != lastKnownDurationMs) {
                            lastKnownDurationMs = totalLen;
                            seekBar.setMax((int) Math.min(Integer.MAX_VALUE, totalLen));
                            timeDurationView.setText(formatMs(totalLen));
                        }
                    });
                    break;
                case MediaPlayer.Event.EndReached:
                    uiHandler.post(() -> {
                        if (isFinishing() || isDestroyed()) return;
                        updatePlayPauseIcons(false);
                        if (autoPlayNextEpisode && !nextUrl.isEmpty()) {
                            loadEpisodeInFullscreen(nextUrl);
                        } else {
                            setControlsVisible(true);
                        }
                    });
                    break;
                case MediaPlayer.Event.EncounteredError:
                    uiHandler.post(() -> {
                        if (!loadingEpisode) {
                            handlePlaybackError();
                        }
                    });
                    break;
                default:
                    break;
            }
        });
    }

    private void showLoading(String labelText) {
        loadingContainer.setVisibility(View.VISIBLE);
        if (labelText != null && !labelText.isEmpty()) {
            loadingLabel.setText(labelText);
            loadingLabel.setVisibility(View.VISIBLE);
        } else {
            loadingLabel.setVisibility(View.GONE);
        }
        btnPlayCenter.setVisibility(View.GONE);
    }

    private void hideLoading() {
        loadingContainer.setVisibility(View.GONE);
        loadingLabel.setVisibility(View.GONE);
        if (!playbackFailed && controlsVisible) {
            btnPlayCenter.setVisibility(View.VISIBLE);
        }
    }

    private void updatePlayPauseIcons(boolean isPlaying) {
        int res = isPlaying ? R.drawable.ic_player_pause : R.drawable.ic_player_play;
        btnPlayCenter.setImageResource(res);
        btnPlayBottom.setImageResource(res);
    }

    private void prepareAndPlayCurrentStream() {
        if (streams.isEmpty()) {
            playbackFailed = true;
            loadingEpisode = false;
            hideLoading();
            errorText.setText("Nenhum stream disponível para reprodução.");
            errorOverlay.setVisibility(View.VISIBLE);
            setControlsVisible(true);
            return;
        }
        if (currentStreamIdx < 0 || currentStreamIdx >= streams.size()) {
            currentStreamIdx = 0;
        }
        StreamItem item = streams.get(currentStreamIdx);
        updateQualityLabel();

        String targetUrl = item.url;
        if (useProxyForAttempt && !proxyBaseUrl.isEmpty()) {
            targetUrl = LocalProxyPlugin.buildSharedProxyUrl(item.url, referer);
        }

        playbackFailed = false;
        subtitlesAttached = false;
        errorOverlay.setVisibility(View.GONE);
        showLoading(loadingEpisode ? "Carregando episódio..." : null);

        Media media = new Media(libVlc, Uri.parse(targetUrl));
        media.setHWDecoderEnabled(true, false);
        media.addOption(":http-user-agent=" + DEFAULT_UA);
        if (!useProxyForAttempt && referer != null && !referer.isEmpty()) {
            media.addOption(":http-referrer=" + referer);
        }
        media.addOption(":http-reconnect=true");
        media.addOption(":network-caching=1500");

        mediaPlayer.setMedia(media);
        media.release();
        mediaPlayer.play();
    }

    private void handlePlaybackError() {
        if (!useProxyForAttempt && !proxyBaseUrl.isEmpty()) {
            useProxyForAttempt = true;
            pendingSeekMs = Math.max(pendingSeekMs, lastKnownPositionMs);
            prepareAndPlayCurrentStream();
            return;
        }
        if (useProxyForAttempt && !preferDirect) {
            preferDirect = true;
            useProxyForAttempt = false;
            pendingSeekMs = Math.max(pendingSeekMs, lastKnownPositionMs);
            prepareAndPlayCurrentStream();
            return;
        }

        playbackFailed = true;
        loadingEpisode = false;
        hideLoading();
        errorText.setText("Não foi possível reproduzir este servidor no LibVLC. Tente novamente ou troque de servidor.");
        errorOverlay.setVisibility(View.VISIBLE);
        setControlsVisible(true);
    }

    private void downloadAndAttachSubtitles() {
        if (subtitles.isEmpty()) return;
        bgExecutor.execute(() -> {
            for (int i = 0; i < subtitles.size(); i++) {
                SubtitleItem sub = subtitles.get(i);
                try {
                    File downloaded = downloadSubtitleToCache(sub.url, i);
                    if (downloaded != null && mediaPlayer != null && !isFinishing() && !isDestroyed()) {
                        cachedSubFiles.add(downloaded);
                        final boolean selectDefault = sub.isDefault || (i == 0);
                        uiHandler.post(() -> {
                            if (mediaPlayer != null && !isFinishing() && !isDestroyed()) {
                                mediaPlayer.addSlave(
                                    IMedia.Slave.Type.Subtitle,
                                    Uri.fromFile(downloaded),
                                    selectDefault
                                );
                            }
                        });
                    }
                } catch (Exception e) {
                    Log.w(TAG, "Failed loading remote subtitle: " + sub.url, e);
                }
            }
        });
    }

    private File downloadSubtitleToCache(String rawUrl, int index) throws Exception {
        String currentUrl = rawUrl;
        HttpURLConnection conn = null;
        try {
            for (int hop = 0; hop <= 4; hop++) {
                URL parsed = new URL(currentUrl);
                conn = (HttpURLConnection) parsed.openConnection();
                conn.setInstanceFollowRedirects(false);
                conn.setConnectTimeout(10000);
                conn.setReadTimeout(10000);
                conn.setRequestProperty("User-Agent", DEFAULT_UA);
                if (referer != null && !referer.isEmpty()) {
                    conn.setRequestProperty("Referer", referer);
                }
                int code = conn.getResponseCode();
                if (code >= 300 && code < 400) {
                    String loc = conn.getHeaderField("Location");
                    conn.disconnect();
                    if (loc == null || loc.isEmpty()) return null;
                    currentUrl = new URL(parsed, loc).toString();
                    continue;
                }
                if (code < 200 || code >= 300) {
                    return null;
                }
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                try (InputStream in = conn.getInputStream()) {
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = in.read(buf)) != -1) {
                        out.write(buf, 0, n);
                    }
                }
                String lower = currentUrl.toLowerCase(Locale.ROOT);
                String ext = lower.contains(".ass") ? ".ass"
                    : lower.contains(".ssa") ? ".ssa"
                    : lower.contains(".srt") ? ".srt"
                    : ".vtt";
                File outFile = new File(getCacheDir(), "topanimes_sub_" + index + "_" + System.currentTimeMillis() + ext);
                try (FileOutputStream fos = new FileOutputStream(outFile)) {
                    fos.write(out.toByteArray());
                }
                return outFile;
            }
        } finally {
            if (conn != null) conn.disconnect();
        }
        return null;
    }

    private void setupInteractions() {
        findViewById(R.id.vlc_btn_back).setOnClickListener(v -> finishWithAction("closed"));
        btnFullscreen.setOnClickListener(v -> finishWithAction("closed"));
        findViewById(R.id.vlc_btn_close_error).setOnClickListener(v -> finishWithAction("closed"));
        findViewById(R.id.vlc_btn_retry).setOnClickListener(v -> {
            useProxyForAttempt = !preferDirect && !proxyBaseUrl.isEmpty();
            pendingSeekMs = Math.max(pendingSeekMs, lastKnownPositionMs);
            prepareAndPlayCurrentStream();
        });

        btnPlayCenter.setOnClickListener(v -> togglePlayPause());
        btnPlayBottom.setOnClickListener(v -> togglePlayPause());
        btnMute.setOnClickListener(v -> toggleMute());

        btnRew5.setOnClickListener(v -> seekByMs(-5000L, "-5s"));
        btnFwd5.setOnClickListener(v -> seekByMs(5000L, "+5s"));
        btnSkipIntro.setOnClickListener(v ->
            seekByMs(skipIntroSeconds * 1000L, "+" + skipIntroSeconds + "s Abertura")
        );

        btnPrevEp.setOnClickListener(v -> {
            if (!prevUrl.isEmpty()) {
                loadEpisodeInFullscreen(prevUrl);
            } else if (hasPrevFlag) {
                finishWithAction("prev");
            }
        });
        btnNextEp.setOnClickListener(v -> {
            if (!nextUrl.isEmpty()) {
                loadEpisodeInFullscreen(nextUrl);
            } else if (hasNextFlag) {
                finishWithAction("next");
            }
        });

        btnEpisodes.setOnClickListener(v -> openEpisodesDrawer());
        btnTopEpisodes.setOnClickListener(v -> openEpisodesDrawer());
        findViewById(R.id.vlc_btn_close_episodes).setOnClickListener(v -> closeEpisodesDrawer());
        episodesOverlay.setOnClickListener(v -> closeEpisodesDrawer());
        episodesDrawer.setOnClickListener(v -> {
            // Consume clicks inside drawer
        });

        btnQuality.setOnClickListener(v -> openSettingsMenu("quality"));
        btnTracks.setOnClickListener(v -> openSettingsMenu("subs"));
        btnSettings.setOnClickListener(v -> openSettingsMenu("main"));
        settingsOverlay.setOnClickListener(v -> closeSettingsMenu());
        findViewById(R.id.vlc_settings_card).setOnClickListener(v -> {
            // Consume clicks inside card
        });
        settingsHeader.setOnClickListener(v -> renderSettingsTab("main"));

        seekBar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar bar, int progress, boolean fromUser) {
                if (fromUser) {
                    timeCurrentView.setText(formatMs(progress));
                }
            }

            @Override
            public void onStartTrackingTouch(SeekBar bar) {
                userScrubbing = true;
                uiHandler.removeCallbacks(hideControlsRunnable);
            }

            @Override
            public void onStopTrackingTouch(SeekBar bar) {
                userScrubbing = false;
                if (mediaPlayer != null) {
                    long target = bar.getProgress();
                    mediaPlayer.setTime(target);
                    lastKnownPositionMs = target;
                }
                scheduleControlsAutoHide();
            }
        });

        View touchLayer = findViewById(R.id.vlc_touch_layer);
        touchLayer.setOnTouchListener((v, event) -> {
            int action = event.getActionMasked();
            if (action == MotionEvent.ACTION_DOWN) {
                holdSpeedActive = false;
                uiHandler.removeCallbacks(holdSpeedRunnable);
                uiHandler.postDelayed(holdSpeedRunnable, 450L);
                return true;
            }
            if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
                uiHandler.removeCallbacks(holdSpeedRunnable);
                if (holdSpeedActive) {
                    holdSpeedActive = false;
                    if (holdSpeedBadge != null) holdSpeedBadge.setVisibility(View.GONE);
                    if (mediaPlayer != null) mediaPlayer.setRate(currentSpeed);
                    return true;
                }
                if (action == MotionEvent.ACTION_UP) {
                    handleSingleOrDoubleTap(event.getX(), v.getWidth());
                }
                return true;
            }
            return false;
        });
    }

    private void handleSingleOrDoubleTap(float x, int width) {
        float rel = width > 0 ? (x / (float) width) : 0.5f;
        int side = rel < 0.3f ? -1 : (rel > 0.7f ? 1 : 0);
        long now = System.currentTimeMillis();

        if (side != 0 && side == lastTapSide && (now - lastTapTimeMs) < 320L) {
            seekByMs(side < 0 ? -5000L : 5000L, side < 0 ? "-5s" : "+5s");
            lastTapTimeMs = 0L;
            lastTapSide = 0;
            return;
        }

        lastTapTimeMs = now;
        lastTapSide = side;
        setControlsVisible(!controlsVisible);
    }

    private void togglePlayPause() {
        if (mediaPlayer == null) return;
        if (mediaPlayer.isPlaying()) {
            mediaPlayer.pause();
        } else {
            mediaPlayer.play();
            scheduleControlsAutoHide();
        }
    }

    private void toggleMute() {
        muted = !muted;
        if (mediaPlayer != null) {
            mediaPlayer.setVolume(muted ? 0 : 100);
        }
        btnMute.setImageResource(muted ? R.drawable.ic_player_volume_off : R.drawable.ic_player_volume_on);
        scheduleControlsAutoHide();
    }

    private void seekByMs(long deltaMs, String badgeText) {
        if (mediaPlayer == null) return;
        long total = mediaPlayer.getLength();
        long current = Math.max(0L, mediaPlayer.getTime());
        long target = current + deltaMs;
        if (target < 0L) target = 0L;
        if (total > 0L && target > total) target = total;
        mediaPlayer.setTime(target);
        lastKnownPositionMs = target;
        timeCurrentView.setText(formatMs(target));
        seekBar.setProgress((int) Math.min(Integer.MAX_VALUE, target));

        if (seekBadge != null) {
            seekBadge.setText(badgeText);
            seekBadge.setVisibility(View.VISIBLE);
            uiHandler.removeCallbacks(hideSeekBadgeRunnable);
            uiHandler.postDelayed(hideSeekBadgeRunnable, 700L);
        }
        scheduleControlsAutoHide();
    }

    private void setControlsVisible(boolean visible) {
        controlsVisible = visible;
        controlsOverlay.setVisibility(visible ? View.VISIBLE : View.GONE);
        if (visible && loadingContainer.getVisibility() != View.VISIBLE && !playbackFailed) {
            btnPlayCenter.setVisibility(View.VISIBLE);
        } else if (!visible) {
            btnPlayCenter.setVisibility(View.GONE);
        }
        if (visible) {
            scheduleControlsAutoHide();
        } else {
            uiHandler.removeCallbacks(hideControlsRunnable);
        }
    }

    private void scheduleControlsAutoHide() {
        uiHandler.removeCallbacks(hideControlsRunnable);
        if (settingsOverlay.getVisibility() == View.VISIBLE || episodesOverlay.getVisibility() == View.VISIBLE) {
            return;
        }
        if (mediaPlayer != null && mediaPlayer.isPlaying() && !userScrubbing && !loadingEpisode) {
            uiHandler.postDelayed(hideControlsRunnable, 3200L);
        }
    }

    private void updateQualityLabel() {
        if (btnQuality == null) return;
        if (streams.isEmpty() || currentStreamIdx < 0 || currentStreamIdx >= streams.size()) {
            btnQuality.setText("Auto");
            return;
        }
        btnQuality.setText(streams.get(currentStreamIdx).label);
    }

    // -------------------------------------------------------------------------
    // In-Fullscreen Episode Switching & Episode Drawer
    // -------------------------------------------------------------------------

    private void openEpisodesDrawer() {
        closeSettingsMenu();
        uiHandler.removeCallbacks(hideControlsRunnable);
        setControlsVisible(true);
        populateEpisodesDrawer();
        episodesOverlay.setVisibility(View.VISIBLE);
    }

    private void closeEpisodesDrawer() {
        episodesOverlay.setVisibility(View.GONE);
        scheduleControlsAutoHide();
    }

    private void populateEpisodesDrawer() {
        episodesList.removeAllViews();
        if (seriesEpisodes.isEmpty()) {
            episodesEmpty.setVisibility(View.VISIBLE);
            episodesScroll.setVisibility(View.GONE);
            return;
        }
        episodesEmpty.setVisibility(View.GONE);
        episodesScroll.setVisibility(View.VISIBLE);

        View activeRowToScroll = null;
        int padH = dp(12);
        int padV = dp(10);
        int marginBottom = dp(6);

        for (TopAnimesEpisodeResolver.EpisodeLink ep : seriesEpisodes) {
            boolean isCurrent = isSameEpisodeUrl(ep.url, episodeUrl);
            boolean isWatched = watchedUrls.contains(normalizeUrlKey(ep.url));

            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setPadding(padH, padV, padH, padV);
            row.setBackgroundResource(
                isCurrent ? R.drawable.bg_player_ep_row_active : R.drawable.bg_player_ep_row_normal
            );
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            );
            lp.bottomMargin = marginBottom;
            row.setLayoutParams(lp);

            LinearLayout textCol = new LinearLayout(this);
            textCol.setOrientation(LinearLayout.VERTICAL);
            textCol.setLayoutParams(new LinearLayout.LayoutParams(
                0,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                1f
            ));

            LinearLayout metaRow = new LinearLayout(this);
            metaRow.setOrientation(LinearLayout.HORIZONTAL);
            metaRow.setGravity(Gravity.CENTER_VERTICAL);

            TextView numView = new TextView(this);
            numView.setText(ep.numberLabel != null && !ep.numberLabel.isEmpty() ? ep.numberLabel : "EP");
            numView.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
            numView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
            numView.setTextColor(Color.parseColor(isCurrent ? "#FB923C" : "#94A3B8"));
            metaRow.addView(numView);

            if (isCurrent) {
                TextView badge = new TextView(this);
                badge.setText("Assistindo");
                badge.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10);
                badge.setTypeface(null, Typeface.BOLD);
                badge.setTextColor(Color.parseColor("#FB923C"));
                badge.setPadding(dp(6), dp(1), dp(6), dp(1));
                LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                );
                blp.leftMargin = dp(8);
                badge.setLayoutParams(blp);
                metaRow.addView(badge);
            } else if (isWatched) {
                TextView badge = new TextView(this);
                badge.setText("Visto");
                badge.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10);
                badge.setTypeface(null, Typeface.BOLD);
                badge.setTextColor(Color.parseColor("#34D399"));
                LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                );
                blp.leftMargin = dp(8);
                badge.setLayoutParams(blp);
                metaRow.addView(badge);
            }

            textCol.addView(metaRow);

            TextView epTitleView = new TextView(this);
            epTitleView.setText(ep.title != null && !ep.title.isEmpty() ? ep.title : "Episódio");
            epTitleView.setTextColor(Color.parseColor(isCurrent ? "#FFFFFF" : "#E2E8F0"));
            epTitleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
            epTitleView.setMaxLines(1);
            epTitleView.setEllipsize(TextUtils.TruncateAt.END);
            LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            );
            tlp.topMargin = dp(2);
            epTitleView.setLayoutParams(tlp);
            textCol.addView(epTitleView);

            row.addView(textCol);

            ImageView playIcon = new ImageView(this);
            playIcon.setImageResource(R.drawable.ic_player_play);
            playIcon.setColorFilter(Color.parseColor(isCurrent ? "#F97316" : "#94A3B8"));
            LinearLayout.LayoutParams ilp = new LinearLayout.LayoutParams(dp(14), dp(14));
            ilp.leftMargin = dp(8);
            playIcon.setLayoutParams(ilp);
            row.addView(playIcon);

            row.setOnClickListener(v -> {
                closeEpisodesDrawer();
                if (!isCurrent) {
                    loadEpisodeInFullscreen(ep.url);
                }
            });

            episodesList.addView(row);
            if (isCurrent) activeRowToScroll = row;
        }

        if (activeRowToScroll != null) {
            final View targetRow = activeRowToScroll;
            episodesScroll.post(() -> {
                int y = Math.max(0, targetRow.getTop() - (episodesScroll.getHeight() / 3));
                episodesScroll.smoothScrollTo(0, y);
            });
        }
    }

    private void loadEpisodeInFullscreen(String rawTargetUrl) {
        String normalizedTarget = TopAnimesEpisodeResolver.normalizeTopAnimesUrl(rawTargetUrl);
        if (normalizedTarget.isEmpty()) return;

        final int gen = episodeLoadGen.incrementAndGet();
        loadingEpisode = true;
        playbackFailed = false;
        pendingSeekMs = 0L;
        lastKnownPositionMs = 0L;
        lastKnownDurationMs = 0L;
        seekBar.setProgress(0);
        seekBar.setMax(100);
        timeCurrentView.setText("0:00");
        timeDurationView.setText("0:00");

        closeSettingsMenu();
        closeEpisodesDrawer();
        errorOverlay.setVisibility(View.GONE);
        showLoading("Carregando episódio...");
        setControlsVisible(true);
        updateEpisodeNavButtons();

        if (mediaPlayer != null) {
            try {
                mediaPlayer.stop();
            } catch (Exception ignored) {
            }
        }

        // Optimistically show matching episode title from series list while fetching streams
        for (TopAnimesEpisodeResolver.EpisodeLink ep : seriesEpisodes) {
            if (isSameEpisodeUrl(ep.url, normalizedTarget) && ep.title != null && !ep.title.isEmpty()) {
                episodeTitle = ep.title;
                break;
            }
        }
        episodeUrl = normalizedTarget;
        prevUrl = "";
        nextUrl = "";
        hasPrevFlag = false;
        hasNextFlag = false;
        syncPrevNextFromSeries();
        updateHeaderTitles();
        updateEpisodeNavButtons();

        final String preferredNume = selectedServerNume;
        bgExecutor.execute(() -> {
            try {
                TopAnimesEpisodeResolver.ResolvedEpisodeData resolved =
                    TopAnimesEpisodeResolver.resolveEpisode(normalizedTarget, preferredNume);

                if (seriesEpisodes.isEmpty() && resolved.seriesUrl != null && !resolved.seriesUrl.isEmpty()) {
                    List<TopAnimesEpisodeResolver.EpisodeLink> fetchedEps =
                        TopAnimesEpisodeResolver.fetchSeriesEpisodes(resolved.seriesUrl);
                    if (!fetchedEps.isEmpty()) {
                        uiHandler.post(() -> {
                            if (gen == episodeLoadGen.get() && seriesEpisodes.isEmpty()) {
                                seriesEpisodes.addAll(fetchedEps);
                            }
                        });
                    }
                }

                uiHandler.post(() -> {
                    if (isFinishing() || isDestroyed() || gen != episodeLoadGen.get()) return;

                    episodeUrl = resolved.episodeUrl;
                    if (!resolved.title.isEmpty()) episodeTitle = resolved.title;
                    if (!resolved.seriesUrl.isEmpty()) seriesUrl = resolved.seriesUrl;
                    if (!resolved.selectedServerNume.isEmpty()) selectedServerNume = resolved.selectedServerNume;
                    referer = resolved.referer;
                    preferDirect = resolved.preferDirect;
                    useProxyForAttempt = !preferDirect && !proxyBaseUrl.isEmpty();

                    prevUrl = resolved.prevUrl;
                    nextUrl = resolved.nextUrl;
                    syncPrevNextFromSeries();

                    serverOptions.clear();
                    serverOptions.addAll(resolved.options);

                    streams.clear();
                    for (TopAnimesEpisodeResolver.StreamCandidate sc : resolved.streams) {
                        streams.add(new StreamItem(sc.label, sc.url));
                    }
                    currentStreamIdx = 0;

                    subtitles.clear();
                    for (TopAnimesEpisodeResolver.SubtitleCandidate sub : resolved.subtitles) {
                        subtitles.add(new SubtitleItem(sub.label, sub.url, sub.isDefault));
                    }

                    visitedEpisodes.put(normalizeUrlKey(episodeUrl), episodeTitle);
                    watchedUrls.add(normalizeUrlKey(episodeUrl));

                    updateHeaderTitles();
                    updateQualityLabel();

                    if (streams.isEmpty()) {
                        loadingEpisode = false;
                        playbackFailed = true;
                        hideLoading();
                        errorText.setText(
                            !resolved.errorMessage.isEmpty()
                                ? resolved.errorMessage
                                : "Não foi possível carregar este episódio."
                        );
                        errorOverlay.setVisibility(View.VISIBLE);
                        updateEpisodeNavButtons();
                        return;
                    }

                    updateEpisodeNavButtons();
                    prepareAndPlayCurrentStream();
                });
            } catch (Exception e) {
                Log.e(TAG, "Failed loading episode in fullscreen: " + normalizedTarget, e);
                uiHandler.post(() -> {
                    if (isFinishing() || isDestroyed() || gen != episodeLoadGen.get()) return;
                    loadingEpisode = false;
                    playbackFailed = true;
                    hideLoading();
                    errorText.setText("Falha ao carregar episódio: " + (e.getMessage() != null ? e.getMessage() : "erro de rede"));
                    errorOverlay.setVisibility(View.VISIBLE);
                    updateEpisodeNavButtons();
                });
            }
        });
    }

    // -------------------------------------------------------------------------
    // In-Overlay Dark Settings Menu (matches Web Settings Popover)
    // -------------------------------------------------------------------------

    private void openSettingsMenu(String tab) {
        closeEpisodesDrawer();
        uiHandler.removeCallbacks(hideControlsRunnable);
        setControlsVisible(true);
        settingsOverlay.setVisibility(View.VISIBLE);
        renderSettingsTab(tab);
    }

    private void closeSettingsMenu() {
        settingsOverlay.setVisibility(View.GONE);
        scheduleControlsAutoHide();
    }

    private void renderSettingsTab(String tab) {
        settingsTab = tab;
        settingsItems.removeAllViews();

        if ("main".equals(tab)) {
            settingsHeader.setVisibility(View.GONE);
            settingsHeaderDivider.setVisibility(View.GONE);

            String qualityVal = (!streams.isEmpty() && currentStreamIdx < streams.size())
                ? streams.get(currentStreamIdx).label
                : "Auto";
            addSettingsRow("Qualidade", qualityVal, false, v -> renderSettingsTab("quality"));

            if (!serverOptions.isEmpty()) {
                String srvLabel = "Automático";
                for (TopAnimesEpisodeResolver.ServerOption o : serverOptions) {
                    if (o.nume.equals(selectedServerNume)) {
                        srvLabel = o.label;
                        break;
                    }
                }
                addSettingsRow("Servidor", srvLabel, false, v -> renderSettingsTab("servers"));
            }

            String speedLabel = currentSpeed == 1.0f ? "Normal" : (currentSpeed + "×");
            addSettingsRow("Velocidade", speedLabel, false, v -> renderSettingsTab("speed"));

            addSettingsRow("Legendas & Áudio", "Configurar", false, v -> renderSettingsTab("subs"));
            addSettingsRow("Escala de Tela", SCALE_LABELS[currentScaleIdx], false, v -> renderSettingsTab("scale"));

            View div = new View(this);
            LinearLayout.LayoutParams dlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(1)
            );
            dlp.topMargin = dp(4);
            dlp.bottomMargin = dp(4);
            div.setLayoutParams(dlp);
            div.setBackgroundColor(Color.parseColor("#1AFFFFFF"));
            settingsItems.addView(div);

            addSettingsRow("Girar Tela", isLandscape() ? "Paisagem" : "Retrato", false, v -> {
                toggleOrientation();
                closeSettingsMenu();
            });
            return;
        }

        settingsHeader.setVisibility(View.VISIBLE);
        settingsHeaderDivider.setVisibility(View.VISIBLE);

        if ("quality".equals(tab)) {
            settingsHeaderTitle.setText("Qualidade");
            for (int i = 0; i < streams.size(); i++) {
                final int idx = i;
                addSettingsRow(
                    streams.get(i).label,
                    idx == currentStreamIdx ? "✓" : "",
                    idx == currentStreamIdx,
                    v -> {
                        if (idx != currentStreamIdx) {
                            currentStreamIdx = idx;
                            pendingSeekMs = Math.max(0L, lastKnownPositionMs);
                            useProxyForAttempt = !preferDirect && !proxyBaseUrl.isEmpty();
                            prepareAndPlayCurrentStream();
                        }
                        closeSettingsMenu();
                    }
                );
            }
            return;
        }

        if ("servers".equals(tab)) {
            settingsHeaderTitle.setText("Servidores");
            for (TopAnimesEpisodeResolver.ServerOption opt : serverOptions) {
                boolean active = opt.nume.equals(selectedServerNume);
                addSettingsRow(opt.label, active ? "✓" : "", active, v -> {
                    closeSettingsMenu();
                    if (!active) {
                        switchServerInFullscreen(opt);
                    }
                });
            }
            return;
        }

        if ("speed".equals(tab)) {
            settingsHeaderTitle.setText("Velocidade");
            for (float sp : SPEED_OPTIONS) {
                boolean active = Math.abs(sp - currentSpeed) < 0.01f;
                String lbl = sp == 1.0f ? "Normal (1×)" : (sp + "×");
                addSettingsRow(lbl, active ? "✓" : "", active, v -> {
                    currentSpeed = sp;
                    if (mediaPlayer != null) {
                        mediaPlayer.setRate(currentSpeed);
                    }
                    closeSettingsMenu();
                });
            }
            return;
        }

        if ("scale".equals(tab)) {
            settingsHeaderTitle.setText("Escala de Tela");
            for (int i = 0; i < SCALE_OPTIONS.length; i++) {
                final int idx = i;
                boolean active = idx == currentScaleIdx;
                addSettingsRow(SCALE_LABELS[i], active ? "✓" : "", active, v -> {
                    currentScaleIdx = idx;
                    if (mediaPlayer != null) {
                        mediaPlayer.setVideoScale(SCALE_OPTIONS[currentScaleIdx]);
                    }
                    Toast.makeText(this, SCALE_LABELS[currentScaleIdx], Toast.LENGTH_SHORT).show();
                    closeSettingsMenu();
                });
            }
            return;
        }

        if ("subs".equals(tab)) {
            settingsHeaderTitle.setText("Legendas & Áudio");
            if (mediaPlayer != null) {
                MediaPlayer.TrackDescription[] spuTracks = mediaPlayer.getSpuTracks();
                if (spuTracks != null && spuTracks.length > 0) {
                    int activeSpu = mediaPlayer.getSpuTrack();
                    for (MediaPlayer.TrackDescription t : spuTracks) {
                        boolean active = t.id == activeSpu;
                        String name = t.name != null ? t.name : "Legenda";
                        addSettingsRow("Legenda: " + name, active ? "✓" : "", active, v -> {
                            if (mediaPlayer != null) mediaPlayer.setSpuTrack(t.id);
                            closeSettingsMenu();
                        });
                    }
                } else {
                    addSettingsRow("Nenhuma faixa de legenda", "", false, v -> {});
                }

                MediaPlayer.TrackDescription[] audioTracks = mediaPlayer.getAudioTracks();
                if (audioTracks != null && audioTracks.length > 1) {
                    int activeAudio = mediaPlayer.getAudioTrack();
                    for (MediaPlayer.TrackDescription t : audioTracks) {
                        boolean active = t.id == activeAudio;
                        String name = t.name != null ? t.name : "Áudio";
                        addSettingsRow("Áudio: " + name, active ? "✓" : "", active, v -> {
                            if (mediaPlayer != null) mediaPlayer.setAudioTrack(t.id);
                            closeSettingsMenu();
                        });
                    }
                }
            }
            addSettingsRow("Carregar legenda local (.srt / .vtt / .ass)", "", false, v -> {
                closeSettingsMenu();
                subtitleFilePicker.launch(new String[] { "*/*" });
            });
        }
    }

    private void switchServerInFullscreen(TopAnimesEpisodeResolver.ServerOption opt) {
        final int gen = episodeLoadGen.incrementAndGet();
        final long resumePos = Math.max(0L, lastKnownPositionMs);
        loadingEpisode = true;
        errorOverlay.setVisibility(View.GONE);
        showLoading("Trocando para " + opt.label + "...");
        if (mediaPlayer != null) {
            try {
                mediaPlayer.stop();
            } catch (Exception ignored) {
            }
        }
        bgExecutor.execute(() -> {
            TopAnimesEpisodeResolver.ResolvedEmbedData resolved = TopAnimesEpisodeResolver.resolveEmbed(opt.embedUrl);
            uiHandler.post(() -> {
                if (isFinishing() || isDestroyed() || gen != episodeLoadGen.get()) return;
                if (!resolved.ok || resolved.streams.isEmpty()) {
                    loadingEpisode = false;
                    playbackFailed = true;
                    hideLoading();
                    errorText.setText(
                        !resolved.errorMessage.isEmpty()
                            ? resolved.errorMessage
                            : "Servidor indisponível no momento."
                    );
                    errorOverlay.setVisibility(View.VISIBLE);
                    return;
                }
                selectedServerNume = opt.nume;
                referer = resolved.referer;
                preferDirect = resolved.preferDirect;
                useProxyForAttempt = !preferDirect && !proxyBaseUrl.isEmpty();
                pendingSeekMs = resumePos;
                streams.clear();
                for (TopAnimesEpisodeResolver.StreamCandidate sc : resolved.streams) {
                    streams.add(new StreamItem(sc.label, sc.url));
                }
                currentStreamIdx = 0;
                subtitles.clear();
                for (TopAnimesEpisodeResolver.SubtitleCandidate sub : resolved.subtitles) {
                    subtitles.add(new SubtitleItem(sub.label, sub.url, sub.isDefault));
                }
                updateQualityLabel();
                prepareAndPlayCurrentStream();
            });
        });
    }

    private void addSettingsRow(String title, String trailing, boolean active, View.OnClickListener listener) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(10), dp(9), dp(10), dp(9));
        row.setBackgroundResource(
            active ? R.drawable.bg_player_ep_row_active : R.drawable.bg_player_ep_row_normal
        );
        LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        rlp.bottomMargin = dp(4);
        row.setLayoutParams(rlp);

        TextView label = new TextView(this);
        label.setText(title);
        label.setTextColor(Color.parseColor(active ? "#FFFFFF" : "#E2E8F0"));
        label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        label.setMaxLines(1);
        label.setEllipsize(TextUtils.TruncateAt.END);
        label.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        row.addView(label);

        if (trailing != null && !trailing.isEmpty()) {
            TextView val = new TextView(this);
            val.setText(trailing);
            val.setTextColor(Color.parseColor(active ? "#FB923C" : "#94A3B8"));
            val.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
            val.setTypeface(null, active ? Typeface.BOLD : Typeface.NORMAL);
            LinearLayout.LayoutParams vlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            );
            vlp.leftMargin = dp(8);
            val.setLayoutParams(vlp);
            row.addView(val);
        }

        row.setOnClickListener(listener);
        settingsItems.addView(row);
    }

    // -------------------------------------------------------------------------
    // Responsive & Lifecycle Helpers
    // -------------------------------------------------------------------------

    private void adjustResponsiveHud() {
        Configuration cfg = getResources().getConfiguration();
        boolean compact = cfg.screenWidthDp < 540;
        boolean ultraNarrow = cfg.screenWidthDp < 430;
        btnRew5.setVisibility(compact ? View.GONE : View.VISIBLE);
        btnFwd5.setVisibility(compact ? View.GONE : View.VISIBLE);
        btnQuality.setVisibility(compact ? View.GONE : View.VISIBLE);
        btnEpisodesLabel.setVisibility(compact ? View.GONE : View.VISIBLE);
        btnTracks.setVisibility(ultraNarrow ? View.GONE : View.VISIBLE);
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        adjustResponsiveHud();
        enterImmersiveMode();
    }

    private boolean isLandscape() {
        return getResources().getConfiguration().orientation == Configuration.ORIENTATION_LANDSCAPE;
    }

    private void toggleOrientation() {
        if (isLandscape()) {
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT);
        } else {
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
        }
    }

    private void enterImmersiveMode() {
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (controller != null) {
            controller.setSystemBarsBehavior(
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            );
            controller.hide(WindowInsetsCompat.Type.systemBars());
        }
    }

    private void setupAudioFocus() {
        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        if (audioManager == null) return;
        AudioManager.OnAudioFocusChangeListener listener = focusChange -> {
            if (focusChange == AudioManager.AUDIOFOCUS_LOSS
                || focusChange == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
                if (mediaPlayer != null && mediaPlayer.isPlaying()) {
                    mediaPlayer.pause();
                }
            }
        };
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            audioFocusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(
                    new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MOVIE)
                        .build()
                )
                .setOnAudioFocusChangeListener(listener)
                .build();
            audioManager.requestAudioFocus(audioFocusRequest);
        } else {
            audioManager.requestAudioFocus(listener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
        }
    }

    private void finishWithAction(String action) {
        Intent result = new Intent();
        result.putExtra(RESULT_ACTION, action);
        result.putExtra(RESULT_EPISODE_URL, episodeUrl);
        result.putExtra(RESULT_POSITION_MS, lastKnownPositionMs);
        result.putExtra(RESULT_DURATION_MS, lastKnownDurationMs);
        result.putExtra(RESULT_STREAM_INDEX, currentStreamIdx);

        JSONArray visitedArr = new JSONArray();
        for (Map.Entry<String, String> entry : visitedEpisodes.entrySet()) {
            try {
                JSONObject o = new JSONObject();
                o.put("url", entry.getKey());
                o.put("title", entry.getValue());
                visitedArr.put(o);
            } catch (Exception ignored) {
            }
        }
        result.putExtra(RESULT_VISITED_EPISODES_JSON, visitedArr.toString());

        setResult(Activity.RESULT_OK, result);
        finish();
    }

    @Override
    public void onBackPressed() {
        if (episodesOverlay != null && episodesOverlay.getVisibility() == View.VISIBLE) {
            closeEpisodesDrawer();
            return;
        }
        if (settingsOverlay != null && settingsOverlay.getVisibility() == View.VISIBLE) {
            if (!"main".equals(settingsTab)) {
                renderSettingsTab("main");
            } else {
                closeSettingsMenu();
            }
            return;
        }
        finishWithAction("closed");
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (mediaPlayer != null && mediaPlayer.isPlaying()) {
            mediaPlayer.pause();
        }
    }

    @Override
    protected void onDestroy() {
        uiHandler.removeCallbacksAndMessages(null);
        bgExecutor.shutdownNow();
        if (mediaPlayer != null) {
            try {
                mediaPlayer.stop();
                mediaPlayer.detachViews();
                mediaPlayer.release();
            } catch (Exception ignored) {
            }
            mediaPlayer = null;
        }
        if (libVlc != null) {
            try {
                libVlc.release();
            } catch (Exception ignored) {
            }
            libVlc = null;
        }
        if (audioManager != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && audioFocusRequest != null) {
            try {
                audioManager.abandonAudioFocusRequest(audioFocusRequest);
            } catch (Exception ignored) {
            }
        }
        for (File f : cachedSubFiles) {
            try {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
            } catch (Exception ignored) {
            }
        }
        super.onDestroy();
    }

    private int dp(int value) {
        return Math.round(TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP,
            value,
            getResources().getDisplayMetrics()
        ));
    }

    private static String safeStr(String s) {
        return s != null ? s.trim() : "";
    }

    private static String normalizeUrlKey(String raw) {
        String n = TopAnimesEpisodeResolver.normalizeTopAnimesUrl(raw);
        if (!n.isEmpty()) return n;
        return safeStr(raw);
    }

    private static boolean isSameEpisodeUrl(String a, String b) {
        if (a == null || b == null || a.trim().isEmpty() || b.trim().isEmpty()) return false;
        String na = normalizeUrlKey(a)
            .replaceFirst("(?i)^https?://(?:www\\.)?", "")
            .replaceAll("/+$", "")
            .toLowerCase(Locale.ROOT);
        String nb = normalizeUrlKey(b)
            .replaceFirst("(?i)^https?://(?:www\\.)?", "")
            .replaceAll("/+$", "")
            .toLowerCase(Locale.ROOT);
        return na.equals(nb);
    }

    private static String formatMs(long ms) {
        if (ms <= 0L) return "0:00";
        long totalSec = ms / 1000L;
        long h = totalSec / 3600L;
        long m = (totalSec % 3600L) / 60L;
        long s = totalSec % 60L;
        if (h > 0L) {
            return String.format(Locale.ROOT, "%d:%02d:%02d", h, m, s);
        }
        return String.format(Locale.ROOT, "%d:%02d", m, s);
    }
}
