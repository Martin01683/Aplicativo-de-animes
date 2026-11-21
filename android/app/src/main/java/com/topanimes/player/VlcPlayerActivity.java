package com.topanimes.player;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.RelativeLayout;
import android.widget.SeekBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AlertDialog;
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
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

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
    public static final String EXTRA_STREAMS_JSON = "streamsJson";
    public static final String EXTRA_SUBTITLES_JSON = "subtitlesJson";
    public static final String EXTRA_REFERER = "referer";
    public static final String EXTRA_PREFER_DIRECT = "preferDirect";
    public static final String EXTRA_START_POSITION_MS = "startPositionMs";
    public static final String EXTRA_STREAM_INDEX = "streamIndex";
    public static final String EXTRA_HAS_PREV = "hasPrev";
    public static final String EXTRA_HAS_NEXT = "hasNext";
    public static final String EXTRA_PROXY_BASE_URL = "proxyBaseUrl";

    public static final String RESULT_ACTION = "action";
    public static final String RESULT_POSITION_MS = "positionMs";
    public static final String RESULT_DURATION_MS = "durationMs";
    public static final String RESULT_STREAM_INDEX = "streamIndex";

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
    private ProgressBar bufferingSpinner;
    private LinearLayout errorOverlay;
    private TextView errorText;
    private TextView titleView;
    private TextView btnQuality;
    private TextView btnSpeed;
    private TextView btnScale;
    private ImageButton btnPlayCenter;
    private SeekBar seekBar;
    private TextView timeCurrentView;
    private TextView timeDurationView;
    private TextView seekBadge;
    private TextView holdSpeedBadge;

    private final Handler uiHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService bgExecutor = Executors.newCachedThreadPool();

    private final List<StreamItem> streams = new ArrayList<>();
    private final List<SubtitleItem> subtitles = new ArrayList<>();
    private final List<File> cachedSubFiles = new ArrayList<>();

    private String episodeTitle = "Episódio";
    private String referer = "https://topanimes.net/";
    private String proxyBaseUrl = "";
    private boolean preferDirect = false;
    private boolean useProxyForAttempt = false;
    private int currentStreamIdx = 0;
    private long pendingSeekMs = 0L;
    private long lastKnownPositionMs = 0L;
    private long lastKnownDurationMs = 0L;

    private float currentSpeed = 1.0f;
    private int currentScaleIdx = 0;
    private boolean controlsVisible = true;
    private boolean userScrubbing = false;
    private boolean playbackFailed = false;
    private boolean subtitlesAttached = false;

    private boolean holdSpeedActive = false;
    private float preHoldSpeed = 1.0f;
    private long lastTapTimeMs = 0L;
    private int lastTapSide = 0; // -1 left, 0 center, 1 right

    private AudioManager audioManager;
    private AudioFocusRequest audioFocusRequest;

    private final Runnable hideControlsRunnable = () -> setControlsVisible(false);
    private final Runnable hideSeekBadgeRunnable = () -> {
        if (seekBadge != null) seekBadge.setVisibility(View.GONE);
    };
    private final Runnable holdSpeedRunnable = () -> {
        if (mediaPlayer != null && !playbackFailed) {
            holdSpeedActive = true;
            preHoldSpeed = currentSpeed;
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
        prepareAndPlayCurrentStream();
    }

    private void bindViews() {
        videoLayout = findViewById(R.id.vlc_video_layout);
        controlsOverlay = findViewById(R.id.vlc_controls_overlay);
        bufferingSpinner = findViewById(R.id.vlc_buffering);
        errorOverlay = findViewById(R.id.vlc_error_overlay);
        errorText = findViewById(R.id.vlc_error_text);
        titleView = findViewById(R.id.vlc_title);
        btnQuality = findViewById(R.id.vlc_btn_quality);
        btnSpeed = findViewById(R.id.vlc_btn_speed);
        btnScale = findViewById(R.id.vlc_btn_scale);
        btnPlayCenter = findViewById(R.id.vlc_btn_play_center);
        seekBar = findViewById(R.id.vlc_seekbar);
        timeCurrentView = findViewById(R.id.vlc_time_current);
        timeDurationView = findViewById(R.id.vlc_time_duration);
        seekBadge = findViewById(R.id.vlc_seek_badge);
        holdSpeedBadge = findViewById(R.id.vlc_hold_speed_badge);
    }

    private void parseIntentExtras(Intent intent) {
        if (intent == null) return;
        episodeTitle = intent.getStringExtra(EXTRA_TITLE);
        if (episodeTitle == null || episodeTitle.trim().isEmpty()) {
            episodeTitle = "Episódio";
        }
        titleView.setText(episodeTitle);

        String ref = intent.getStringExtra(EXTRA_REFERER);
        if (ref != null && !ref.trim().isEmpty()) {
            referer = ref.trim();
        }
        String proxy = intent.getStringExtra(EXTRA_PROXY_BASE_URL);
        if (proxy != null && !proxy.trim().isEmpty()) {
            proxyBaseUrl = proxy.trim();
        } else if (LocalProxyPlugin.sharedProxyBaseUrl != null) {
            proxyBaseUrl = LocalProxyPlugin.sharedProxyBaseUrl;
        }

        preferDirect = intent.getBooleanExtra(EXTRA_PREFER_DIRECT, false);
        useProxyForAttempt = !preferDirect && !proxyBaseUrl.isEmpty();
        pendingSeekMs = Math.max(0L, intent.getLongExtra(EXTRA_START_POSITION_MS, 0L));
        lastKnownPositionMs = pendingSeekMs;

        try {
            String rawStreams = intent.getStringExtra(EXTRA_STREAMS_JSON);
            if (rawStreams != null) {
                JSONArray arr = new JSONArray(rawStreams);
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject obj = arr.optJSONObject(i);
                    if (obj == null) continue;
                    String url = obj.optString("url", "").trim();
                    String label = obj.optString("label", "Auto").trim();
                    if (!url.isEmpty()) {
                        streams.add(new StreamItem(label.isEmpty() ? "Auto" : label, url));
                    }
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed parsing streams JSON", e);
        }

        int reqIdx = intent.getIntExtra(EXTRA_STREAM_INDEX, 0);
        if (reqIdx >= 0 && reqIdx < streams.size()) {
            currentStreamIdx = reqIdx;
        }

        try {
            String rawSubs = intent.getStringExtra(EXTRA_SUBTITLES_JSON);
            if (rawSubs != null) {
                JSONArray arr = new JSONArray(rawSubs);
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
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed parsing subtitles JSON", e);
        }

        boolean hasPrev = intent.getBooleanExtra(EXTRA_HAS_PREV, false);
        boolean hasNext = intent.getBooleanExtra(EXTRA_HAS_NEXT, false);
        findViewById(R.id.vlc_btn_prev_ep).setVisibility(hasPrev ? View.VISIBLE : View.GONE);
        findViewById(R.id.vlc_btn_next_ep).setVisibility(hasNext ? View.VISIBLE : View.GONE);

        updateQualityLabel();
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
                        bufferingSpinner.setVisibility(View.VISIBLE);
                        errorOverlay.setVisibility(View.GONE);
                    });
                    break;
                case MediaPlayer.Event.Buffering:
                    float pct = event.getBuffering();
                    uiHandler.post(() -> {
                        if (pct >= 100f) {
                            bufferingSpinner.setVisibility(View.GONE);
                        } else if (!mediaPlayer.isPlaying()) {
                            bufferingSpinner.setVisibility(View.VISIBLE);
                        }
                    });
                    break;
                case MediaPlayer.Event.Playing:
                    uiHandler.post(() -> {
                        playbackFailed = false;
                        bufferingSpinner.setVisibility(View.GONE);
                        errorOverlay.setVisibility(View.GONE);
                        btnPlayCenter.setImageResource(android.R.drawable.ic_media_pause);
                        if (pendingSeekMs > 0L && mediaPlayer != null && mediaPlayer.isSeekable()) {
                            long target = pendingSeekMs;
                            pendingSeekMs = 0L;
                            mediaPlayer.setTime(target);
                        }
                        if (mediaPlayer != null) {
                            mediaPlayer.setRate(holdSpeedActive ? 2.0f : currentSpeed);
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
                        btnPlayCenter.setImageResource(android.R.drawable.ic_media_play);
                        setControlsVisible(true);
                    });
                    break;
                case MediaPlayer.Event.LengthChanged:
                    long len = event.getLengthChanged();
                    if (len > 0) {
                        lastKnownDurationMs = len;
                        uiHandler.post(() -> {
                            seekBar.setMax((int) Math.min(Integer.MAX_VALUE, len));
                            timeDurationView.setText(formatMs(len));
                        });
                    }
                    break;
                case MediaPlayer.Event.TimeChanged:
                    long timeMs = event.getTimeChanged();
                    lastKnownPositionMs = timeMs;
                    uiHandler.post(() -> {
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
                        btnPlayCenter.setImageResource(android.R.drawable.ic_media_play);
                        setControlsVisible(true);
                    });
                    break;
                case MediaPlayer.Event.EncounteredError:
                    uiHandler.post(this::handlePlaybackError);
                    break;
                default:
                    break;
            }
        });
    }

    private void prepareAndPlayCurrentStream() {
        if (streams.isEmpty()) {
            playbackFailed = true;
            bufferingSpinner.setVisibility(View.GONE);
            errorText.setText("Nenhum stream disponível para reprodução.");
            errorOverlay.setVisibility(View.VISIBLE);
            return;
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
        bufferingSpinner.setVisibility(View.VISIBLE);

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
        // Automatic fallback between direct LibVLC HTTP and LocalProxy loopback
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
        bufferingSpinner.setVisibility(View.GONE);
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
        findViewById(R.id.vlc_btn_close_error).setOnClickListener(v -> finishWithAction("closed"));
        findViewById(R.id.vlc_btn_retry).setOnClickListener(v -> {
            useProxyForAttempt = !preferDirect && !proxyBaseUrl.isEmpty();
            pendingSeekMs = Math.max(pendingSeekMs, lastKnownPositionMs);
            prepareAndPlayCurrentStream();
        });

        btnPlayCenter.setOnClickListener(v -> togglePlayPause());
        findViewById(R.id.vlc_btn_rew5).setOnClickListener(v -> seekByMs(-5000L, "-5s"));
        findViewById(R.id.vlc_btn_fwd5).setOnClickListener(v -> seekByMs(5000L, "+5s"));
        findViewById(R.id.vlc_btn_skip85).setOnClickListener(v -> seekByMs(85000L, "+85s Abertura"));

        findViewById(R.id.vlc_btn_prev_ep).setOnClickListener(v -> finishWithAction("prev"));
        findViewById(R.id.vlc_btn_next_ep).setOnClickListener(v -> finishWithAction("next"));

        findViewById(R.id.vlc_btn_rotate).setOnClickListener(v -> toggleOrientation());
        btnQuality.setOnClickListener(v -> showQualityDialog());
        findViewById(R.id.vlc_btn_tracks).setOnClickListener(v -> showTracksDialog());
        btnSpeed.setOnClickListener(v -> showSpeedDialog());
        btnScale.setOnClickListener(v -> cycleScaleType());

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

        // Mobile touch gestures only (NO desktop keyboard shortcuts)
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
        if (visible) {
            scheduleControlsAutoHide();
        } else {
            uiHandler.removeCallbacks(hideControlsRunnable);
        }
    }

    private void scheduleControlsAutoHide() {
        uiHandler.removeCallbacks(hideControlsRunnable);
        if (mediaPlayer != null && mediaPlayer.isPlaying() && !userScrubbing) {
            uiHandler.postDelayed(hideControlsRunnable, 3200L);
        }
    }

    private void updateQualityLabel() {
        if (btnQuality == null) return;
        if (streams.isEmpty()) {
            btnQuality.setText("Auto");
            return;
        }
        btnQuality.setText(streams.get(currentStreamIdx).label);
    }

    private void showQualityDialog() {
        if (streams.isEmpty()) return;
        String[] items = new String[streams.size()];
        for (int i = 0; i < streams.size(); i++) {
            items[i] = streams.get(i).label;
        }
        new AlertDialog.Builder(this)
            .setTitle("Qualidade do Stream")
            .setSingleChoiceItems(items, currentStreamIdx, (dialog, which) -> {
                if (which != currentStreamIdx) {
                    currentStreamIdx = which;
                    pendingSeekMs = Math.max(0L, lastKnownPositionMs);
                    useProxyForAttempt = !preferDirect && !proxyBaseUrl.isEmpty();
                    prepareAndPlayCurrentStream();
                }
                dialog.dismiss();
            })
            .setNegativeButton("Fechar", null)
            .show();
    }

    private void showSpeedDialog() {
        String[] labels = new String[SPEED_OPTIONS.length];
        int checked = 2;
        for (int i = 0; i < SPEED_OPTIONS.length; i++) {
            float sp = SPEED_OPTIONS[i];
            labels[i] = sp == 1.0f ? "Normal (1×)" : (sp + "×");
            if (Math.abs(sp - currentSpeed) < 0.01f) checked = i;
        }
        new AlertDialog.Builder(this)
            .setTitle("Velocidade de Reprodução")
            .setSingleChoiceItems(labels, checked, (dialog, which) -> {
                currentSpeed = SPEED_OPTIONS[which];
                if (mediaPlayer != null) {
                    mediaPlayer.setRate(currentSpeed);
                }
                btnSpeed.setText(currentSpeed == 1.0f ? "1×" : (currentSpeed + "×"));
                dialog.dismiss();
            })
            .setNegativeButton("Fechar", null)
            .show();
    }

    private void showTracksDialog() {
        if (mediaPlayer == null) return;
        String[] options = new String[] {
            "Selecionar Legenda",
            "Selecionar Faixa de Áudio",
            "Carregar legenda local (.srt / .vtt / .ass)"
        };
        new AlertDialog.Builder(this)
            .setTitle("Áudio e Legendas (LibVLC)")
            .setItems(options, (dialog, which) -> {
                if (which == 0) {
                    showSpuTracksDialog();
                } else if (which == 1) {
                    showAudioTracksDialog();
                } else {
                    subtitleFilePicker.launch(new String[] { "*/*" });
                }
            })
            .setNegativeButton("Fechar", null)
            .show();
    }

    private void showSpuTracksDialog() {
        if (mediaPlayer == null) return;
        MediaPlayer.TrackDescription[] tracks = mediaPlayer.getSpuTracks();
        if (tracks == null || tracks.length == 0) {
            Toast.makeText(this, "Nenhuma faixa de legenda carregada ainda.", Toast.LENGTH_SHORT).show();
            return;
        }
        int currentId = mediaPlayer.getSpuTrack();
        String[] names = new String[tracks.length];
        int checked = 0;
        for (int i = 0; i < tracks.length; i++) {
            names[i] = tracks[i].name != null ? tracks[i].name : ("Faixa " + (i + 1));
            if (tracks[i].id == currentId) checked = i;
        }
        new AlertDialog.Builder(this)
            .setTitle("Legendas")
            .setSingleChoiceItems(names, checked, (dialog, which) -> {
                mediaPlayer.setSpuTrack(tracks[which].id);
                dialog.dismiss();
            })
            .setNegativeButton("Fechar", null)
            .show();
    }

    private void showAudioTracksDialog() {
        if (mediaPlayer == null) return;
        MediaPlayer.TrackDescription[] tracks = mediaPlayer.getAudioTracks();
        if (tracks == null || tracks.length == 0) {
            Toast.makeText(this, "Nenhuma faixa de áudio adicional disponível.", Toast.LENGTH_SHORT).show();
            return;
        }
        int currentId = mediaPlayer.getAudioTrack();
        String[] names = new String[tracks.length];
        int checked = 0;
        for (int i = 0; i < tracks.length; i++) {
            names[i] = tracks[i].name != null ? tracks[i].name : ("Áudio " + (i + 1));
            if (tracks[i].id == currentId) checked = i;
        }
        new AlertDialog.Builder(this)
            .setTitle("Faixas de Áudio")
            .setSingleChoiceItems(names, checked, (dialog, which) -> {
                mediaPlayer.setAudioTrack(tracks[which].id);
                dialog.dismiss();
            })
            .setNegativeButton("Fechar", null)
            .show();
    }

    private void cycleScaleType() {
        currentScaleIdx = (currentScaleIdx + 1) % SCALE_OPTIONS.length;
        if (mediaPlayer != null) {
            mediaPlayer.setVideoScale(SCALE_OPTIONS[currentScaleIdx]);
        }
        Toast.makeText(this, SCALE_LABELS[currentScaleIdx], Toast.LENGTH_SHORT).show();
    }

    private void toggleOrientation() {
        int current = getResources().getConfiguration().orientation;
        if (current == Configuration.ORIENTATION_LANDSCAPE) {
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
        result.putExtra(RESULT_POSITION_MS, lastKnownPositionMs);
        result.putExtra(RESULT_DURATION_MS, lastKnownDurationMs);
        result.putExtra(RESULT_STREAM_INDEX, currentStreamIdx);
        setResult(Activity.RESULT_OK, result);
        finish();
    }

    @Override
    public void onBackPressed() {
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
