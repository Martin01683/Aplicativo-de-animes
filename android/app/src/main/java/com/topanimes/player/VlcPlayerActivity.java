package com.topanimes.player;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Typeface;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.text.TextUtils;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
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

import androidx.activity.OnBackPressedCallback;
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
import org.videolan.libvlc.interfaces.IVLCVout;
import org.videolan.libvlc.util.VLCVideoLayout;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletionService;
import java.util.concurrent.ExecutorCompletionService;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
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
    private static final String[] SCALE_IDS = new String[] {
        "best-fit",
        "fit-screen",
        "fill",
        "16:9",
        "original"
    };

    private static final String PREFS_NAME = "topanimes_player_prefs";
    private static final String PREF_VIDEO_SCALE_IDX = "video_scale_idx";
    private static final String PREF_EPISODE_PROGRESS_JSON = "episode_progress_json";
    private static final String PREF_PENDING_SESSION_JSON = "pending_session_json";
    private static final String STATE_POSITION_MS = "state_position_ms";
    private static final String STATE_DURATION_MS = "state_duration_ms";
    private static final String STATE_STREAM_INDEX = "state_stream_index";
    private static final String STATE_EPISODE_URL = "state_episode_url";
    private static final String STATE_EPISODE_TITLE = "state_episode_title";
    private static final String STATE_SERIES_URL = "state_series_url";
    private static final String STATE_SERIES_TITLE = "state_series_title";
    private static final String STATE_POSTER = "state_poster";
    private static final String STATE_IS_MOVIE = "state_is_movie";
    private static final String STATE_SELECTED_SERVER_NUME = "state_selected_server_nume";
    private static final String STATE_REFERER = "state_referer";
    private static final String STATE_PREFER_DIRECT = "state_prefer_direct";
    private static final String STATE_PREV_URL = "state_prev_url";
    private static final String STATE_NEXT_URL = "state_next_url";
    private static final String STATE_HAS_PREV = "state_has_prev";
    private static final String STATE_HAS_NEXT = "state_has_next";
    private static final String STATE_STREAMS_JSON = "state_streams_json";
    private static final String STATE_SUBTITLES_JSON = "state_subtitles_json";
    private static final String STATE_EPISODES_JSON = "state_episodes_json";
    private static final String STATE_OPTIONS_JSON = "state_options_json";
    private static final String STATE_VISITED_EPISODES_JSON = "state_visited_episodes_json";
    private static final String STATE_PLAYBACK_ENDED = "state_playback_ended";
    private static final String STATE_USER_INITIATED_PAUSE = "state_user_initiated_pause";
    private static final long MIN_RESUME_MS = 2000L;

    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_EPISODE_URL = "episodeUrl";
    public static final String EXTRA_SERIES_URL = "seriesUrl";
    public static final String EXTRA_SERIES_TITLE = "seriesTitle";
    public static final String EXTRA_POSTER = "poster";
    public static final String EXTRA_IS_MOVIE = "isMovie";
    public static final String EXTRA_STREAMS_JSON = "streamsJson";
    public static final String EXTRA_SUBTITLES_JSON = "subtitlesJson";
    public static final String EXTRA_EPISODES_JSON = "episodesJson";
    public static final String EXTRA_WATCHED_URLS_JSON = "watchedUrlsJson";
    public static final String EXTRA_OPTIONS_JSON = "optionsJson";
    public static final String EXTRA_SELECTED_SERVER_NUME = "selectedServerNume";
    public static final String EXTRA_REFERER = "referer";
    public static final String EXTRA_PREFER_DIRECT = "preferDirect";
    public static final String EXTRA_START_POSITION_MS = "startPositionMs";
    public static final String EXTRA_FORCE_START_POSITION = "forceStartPosition";
    public static final String EXTRA_STREAM_INDEX = "streamIndex";
    public static final String EXTRA_VIDEO_SCALE = "videoScale";
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
    public static final String RESULT_COMPLETED = "completed";
    public static final String RESULT_STREAM_INDEX = "streamIndex";
    public static final String RESULT_VIDEO_SCALE = "videoScale";
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
    private View topBar;
    private View bottomBar;
    private View bottomControlsRow;
    private LinearLayout loadingContainer;
    private TextView loadingLabel;
    private LinearLayout errorOverlay;
    private TextView errorText;
    private TextView titleView;
    private TextView seriesTitleView;
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
    private TextView gestureBadge;

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
    private final Set<String> failedServerNumes = new HashSet<>();
    private final Map<String, TopAnimesEpisodeResolver.ResolvedEmbedData> embedProbeCache = new HashMap<>();
    private static class VisitedEpisodeState {
        String url;
        String title;
        String seriesTitle;
        String seriesUrl;
        String poster;
        boolean isMovie;
        long positionMs;
        long durationMs;
        boolean completed;
        long watchedAtMs;

        VisitedEpisodeState(
            String url,
            String title,
            String seriesTitle,
            String seriesUrl,
            String poster,
            boolean isMovie
        ) {
            this.url = url != null ? url : "";
            this.title = title != null && !title.isEmpty() ? title : "Episódio";
            this.seriesTitle = seriesTitle != null ? seriesTitle : "";
            this.seriesUrl = seriesUrl != null ? seriesUrl : "";
            this.poster = poster != null ? poster : "";
            this.isMovie = isMovie;
            this.watchedAtMs = System.currentTimeMillis();
        }
    }

    private final Map<String, VisitedEpisodeState> visitedEpisodes = new LinkedHashMap<>();
    private final List<File> cachedSubFiles = new ArrayList<>();
    private final Map<String, File> downloadedSubtitleFiles = new HashMap<>();
    private Uri localSubtitleUri = null;
    private boolean userDisabledSubtitles = false;
    private int preferredAudioTrackId = -1;

    private String episodeTitle = "Episódio";
    private String episodeUrl = "";
    private String seriesUrl = "";
    private String seriesTitle = "";
    private String posterUrl = "";
    private boolean isMovieFlag = false;
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
    private long activeSeekTargetMs = 0L;
    private long activeSeekIssuedElapsedMs = 0L;
    private long lastKnownPositionMs = 0L;
    private long lastKnownDurationMs = 0L;
    private long lastProgressSavedWallMs = 0L;
    private int skipIntroSeconds = 85;
    private boolean autoPlayNextEpisode = false;

    private static final int MAX_RETRIES_PER_SERVER = 1;
    private static final long LOAD_WATCHDOG_TIMEOUT_MS = 12000L;

    private volatile long activePlaybackSessionGen = 0L;
    private long sessionCounter = 0L;
    private long endReachedHandledSessionGen = -1L;
    private boolean hasPlaybackStartedForStream = false;
    private int playbackTimeAdvanceCount = 0;
    private long firstTimeChangedMs = -1L;
    private long streamPreparedWallMs = 0L;
    private boolean userSeekedInCurrentStream = false;
    private boolean userInitiatedPause = false;
    private boolean triedAlternateTransport = false;
    private boolean retriedFreshServerEmbeds = false;
    private int currentServerRetryCount = 0;

    private float currentSpeed = 1.0f;
    private int currentScaleIdx = 0;
    private boolean muted = false;
    private boolean controlsVisible = true;
    private boolean seekOnlyHudActive = false;
    private static final long DOUBLE_TAP_WINDOW_MS = 320L;
    private static final long SEEK_STREAK_TIMEOUT_MS = 850L;
    private static final long DIRECT_BUFFER_FALLBACK_WINDOW_MS = 15000L;
    private boolean userScrubbing = false;
    private boolean playbackFailed = false;
    private long bufferSessionCounter = 0L;
    private volatile long activeBufferSessionId = 0L;
    private long bufferedPositionMs = 0L;
    private long pendingBufferedRangeStart = -1L;
    private long pendingBufferedRangeEnd = -1L;
    private long pendingBufferedTotalBytes = -1L;
    private boolean hasProxyBufferTelemetry = false;
    private boolean playbackEnded = false;
    private boolean loadingEpisode = false;
    private boolean subtitlesAttached = false;
    // LibVLC exposes external subtitle slaves as "Track N" (no language/description). We keep the
    // scraper/user label of every slave we attach (FIFO, same order as addSlave) and bind it to the
    // SPU ES id reported by the next MediaPlayer.Event.ESAdded of type Text.
    private final java.util.ArrayDeque<String> pendingSlaveSubtitleLabels = new java.util.ArrayDeque<>();
    private final Map<Integer, String> slaveSubtitleLabelsById = new HashMap<>();
    private String settingsTab = "main";

    private boolean isActivityStarted = false;
    private boolean isActivityResumed = false;
    private boolean isStoppingOrDetaching = false;
    private boolean shouldStartPlaybackOnStart = false;
    private boolean resumePlayingAfterRestore = true;
    private boolean wasPlayingBeforePause = false;
    private boolean wasLoadingBeforePause = false;
    private boolean surfacesWereDestroyed = false;
    private boolean hasActiveVout = false;
    private boolean pauseAfterRestoreFrame = false;
    private boolean pauseAfterRestoreScheduled = false;
    private boolean restoreFrameTimeReached = false;
    private boolean pausedMidRestore = false;
    private long restoreFrameTargetMs = 0L;
    private long lastSurfaceRecoveryWallMs = 0L;

    private static final int GESTURE_NONE = 0;
    private static final int GESTURE_HOLD_2X = 1;
    private static final int GESTURE_BRIGHTNESS = 2;
    private static final int GESTURE_VOLUME = 3;

    private boolean holdSpeedActive = false;
    private int gestureMode = GESTURE_NONE;
    private float gestureDownX = 0f;
    private float gestureDownY = 0f;
    private float gestureStartBrightness = 0.5f;
    private float gestureStartVolumeFloat = 0f;
    private int gestureMaxVolume = 15;
    private long lastTapTimeMs = 0L;
    private int lastTapSide = 0;
    private int seekStreakCount = 0;
    private int seekStreakSide = 0;

    private static final long MEDIA_SESSION_ACTIONS =
        PlaybackState.ACTION_PLAY
            | PlaybackState.ACTION_PAUSE
            | PlaybackState.ACTION_PLAY_PAUSE
            | PlaybackState.ACTION_STOP
            | PlaybackState.ACTION_SEEK_TO
            | PlaybackState.ACTION_FAST_FORWARD
            | PlaybackState.ACTION_REWIND
            | PlaybackState.ACTION_SKIP_TO_NEXT
            | PlaybackState.ACTION_SKIP_TO_PREVIOUS;

    private AudioManager audioManager;
    private AudioManager.OnAudioFocusChangeListener audioFocusChangeListener;
    private AudioFocusRequest audioFocusRequest;
    private MediaSession mediaSession;
    private boolean becomingNoisyReceiverRegistered = false;
    private boolean pendingPauseFromNoisyAudio = false;
    private final BroadcastReceiver becomingNoisyReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (intent == null) return;
            if (AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(intent.getAction())) {
                uiHandler.post(() -> pausePlaybackForAudioRouteOrControl());
            }
        }
    };

    private final Runnable hideControlsRunnable = () -> setControlsVisible(false);
    private final Runnable hideSeekOnlyHudRunnable = () -> {
        seekOnlyHudActive = false;
        seekStreakCount = 0;
        seekStreakSide = 0;
        if (seekBadge != null) seekBadge.setVisibility(View.GONE);
        if (!controlsVisible) {
            applyHudVisibility();
        }
    };
    private final Runnable hideSeekBadgeRunnable = () -> {
        if (seekBadge != null) seekBadge.setVisibility(View.GONE);
    };
    private final Runnable hideGestureBadgeRunnable = () -> {
        if (gestureBadge != null) gestureBadge.setVisibility(View.GONE);
    };
    private final Runnable resetSeekStreakRunnable = () -> {
        seekStreakCount = 0;
        seekStreakSide = 0;
    };
    private final Runnable singleTapRunnable = () -> {
        if (gestureMode == GESTURE_NONE && !holdSpeedActive) {
            setControlsVisible(!controlsVisible);
        }
    };
    private final Runnable loadWatchdogRunnable = () -> {
        if (isFinishing() || isDestroyed() || loadingEpisode || playbackFailed || hasPlaybackStartedForStream) {
            return;
        }
        Log.w(TAG, "Stream load watchdog expired; triggering transport/server failover");
        handlePlaybackError();
    };
    private final Runnable holdSpeedRunnable = () -> {
        if (gestureMode == GESTURE_NONE && mediaPlayer != null && !playbackFailed && !loadingEpisode) {
            gestureMode = GESTURE_HOLD_2X;
            holdSpeedActive = true;
            uiHandler.removeCallbacks(singleTapRunnable);
            if (seekOnlyHudActive) {
                setControlsVisible(false);
            }
            mediaPlayer.setRate(2.0f);
            if (holdSpeedBadge != null) holdSpeedBadge.setVisibility(View.VISIBLE);
        }
    };
    private final Runnable pauseAfterRestoreRunnable = this::finishPauseAfterRestoreFrame;
    private final Runnable pauseAfterRestoreFallbackRunnable = this::finishPauseAfterRestoreFrame;

    private final IVLCVout.Callback voutCallback = new IVLCVout.Callback() {
        @Override
        public void onSurfacesCreated(IVLCVout vlcVout) {
            surfacesWereDestroyed = false;
            uiHandler.post(() -> {
                if (isFinishing() || isDestroyed() || mediaPlayer == null) return;
                mediaPlayer.setVideoScale(SCALE_OPTIONS[currentScaleIdx]);
                mediaPlayer.updateVideoSurfaces();
            });
        }

        @Override
        public void onSurfacesDestroyed(IVLCVout vlcVout) {
            hasActiveVout = false;
            if (isStoppingOrDetaching || isFinishing() || isDestroyed()) {
                return;
            }
            surfacesWereDestroyed = true;
            uiHandler.post(() -> {
                if (isFinishing() || isDestroyed() || isStoppingOrDetaching || !isActivityResumed) {
                    return;
                }
                scheduleForegroundSurfaceRecovery();
            });
        }
    };

    private final ActivityResultLauncher<String[]> subtitleFilePicker = registerForActivityResult(
        new ActivityResultContracts.OpenDocument(),
        uri -> {
            if (uri != null) {
                try {
                    getContentResolver().takePersistableUriPermission(
                        uri,
                        Intent.FLAG_GRANT_READ_URI_PERMISSION
                    );
                } catch (Exception ignored) {
                }
                localSubtitleUri = uri;
                userDisabledSubtitles = false;
                if (mediaPlayer != null && isActivityStarted && subtitlesAttached) {
                    attachSubtitleSlave(uri, true, "Legenda local");
                }
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
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
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
        });
        parseIntentExtras(getIntent());
        if (savedInstanceState != null) {
            restoreFromSavedInstanceState(savedInstanceState);
        }
        setVolumeControlStream(AudioManager.STREAM_MUSIC);
        setupAudioFocus();
        setupMediaSession();
        initLibVlc();
        setupInteractions();
        adjustResponsiveHud();
        updateEpisodeNavButtons();
        maybeFetchSeriesEpisodesInBackground();
        shouldStartPlaybackOnStart = true;
        resumePlayingAfterRestore = !userInitiatedPause;
    }

    private void bindViews() {
        videoLayout = findViewById(R.id.vlc_video_layout);
        controlsOverlay = findViewById(R.id.vlc_controls_overlay);
        topBar = findViewById(R.id.vlc_top_bar);
        bottomBar = findViewById(R.id.vlc_bottom_bar);
        bottomControlsRow = findViewById(R.id.vlc_bottom_controls_row);
        loadingContainer = findViewById(R.id.vlc_loading_container);
        loadingLabel = findViewById(R.id.vlc_loading_label);
        errorOverlay = findViewById(R.id.vlc_error_overlay);
        errorText = findViewById(R.id.vlc_error_text);
        titleView = findViewById(R.id.vlc_title);
        seriesTitleView = findViewById(R.id.vlc_series_title);
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
        gestureBadge = findViewById(R.id.vlc_gesture_badge);

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
        posterUrl = safeStr(intent.getStringExtra(EXTRA_POSTER));
        isMovieFlag = intent.getBooleanExtra(EXTRA_IS_MOVIE, false);
        episodeTitle = formatEpisodeTitleWithSeries(seriesTitle, episodeTitle);
        selectedServerNume = safeStr(intent.getStringExtra(EXTRA_SELECTED_SERVER_NUME));
        prevUrl = safeStr(intent.getStringExtra(EXTRA_PREV_URL));
        nextUrl = safeStr(intent.getStringExtra(EXTRA_NEXT_URL));
        hasPrevFlag = intent.getBooleanExtra(EXTRA_HAS_PREV, false);
        hasNextFlag = intent.getBooleanExtra(EXTRA_HAS_NEXT, false);

        skipIntroSeconds = Math.max(5, Math.min(300, intent.getIntExtra(EXTRA_SKIP_INTRO_SECONDS, 85)));
        autoPlayNextEpisode = intent.getBooleanExtra(EXTRA_AUTO_PLAY_NEXT, false);
        btnSkipIntro.setText("+" + skipIntroSeconds + "s");

        updateHeaderTitles();

        String ref = safeStr(intent.getStringExtra(EXTRA_REFERER));
        if (!ref.isEmpty()) referer = ref;

        String proxy = safeStr(intent.getStringExtra(EXTRA_PROXY_BASE_URL));
        if (!proxy.isEmpty()) {
            proxyBaseUrl = proxy;
        } else {
            String ensured = LocalProxyPlugin.ensureSharedProxyBaseUrl();
            if (ensured != null && !ensured.isEmpty()) {
                proxyBaseUrl = ensured;
            }
        }

        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        if (prefs.contains(PREF_VIDEO_SCALE_IDX)) {
            int savedScale = prefs.getInt(PREF_VIDEO_SCALE_IDX, 0);
            currentScaleIdx = (savedScale >= 0 && savedScale < SCALE_OPTIONS.length) ? savedScale : 0;
        } else {
            String extraScale = safeStr(intent.getStringExtra(EXTRA_VIDEO_SCALE));
            if (!extraScale.isEmpty()) {
                currentScaleIdx = scaleIdToIndex(extraScale);
                prefs.edit().putInt(PREF_VIDEO_SCALE_IDX, currentScaleIdx).apply();
            }
        }

        preferDirect = intent.getBooleanExtra(EXTRA_PREFER_DIRECT, false);
        triedAlternateTransport = false;
        retriedFreshServerEmbeds = false;
        useProxyForAttempt = !preferDirect && !proxyBaseUrl.isEmpty();

        boolean forceStart = intent.getBooleanExtra(EXTRA_FORCE_START_POSITION, false);
        long reqStartMs = Math.max(0L, intent.getLongExtra(EXTRA_START_POSITION_MS, 0L));
        if (forceStart && reqStartMs == 0L && !episodeUrl.isEmpty()) {
            saveEpisodeProgressPref(episodeUrl, episodeTitle, 0L, 0L, false, true);
            pendingSeekMs = 0L;
        } else if (reqStartMs >= MIN_RESUME_MS) {
            pendingSeekMs = reqStartMs;
        } else if (!forceStart && !episodeUrl.isEmpty()) {
            pendingSeekMs = getSavedResumePositionMs(episodeUrl);
        } else {
            pendingSeekMs = 0L;
        }
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

        if (!episodeUrl.isEmpty()) {
            boolean alreadyCompleted = isEpisodeCompletedInPref(episodeUrl);
            recordVisitedEpisode(episodeUrl, episodeTitle, pendingSeekMs, 0L, alreadyCompleted);
            persistPendingSessionPref("closed");
        }

        syncPrevNextFromSeries();
        updateQualityLabel();
    }

    private void restoreFromSavedInstanceState(Bundle state) {
        if (state == null) return;
        String savedEpUrl = safeStr(state.getString(STATE_EPISODE_URL));
        if (!savedEpUrl.isEmpty()) episodeUrl = savedEpUrl;
        String savedEpTitle = safeStr(state.getString(STATE_EPISODE_TITLE));
        if (!savedEpTitle.isEmpty()) episodeTitle = savedEpTitle;
        String savedSeriesUrl = safeStr(state.getString(STATE_SERIES_URL));
        if (!savedSeriesUrl.isEmpty()) seriesUrl = savedSeriesUrl;
        String savedSeriesTitle = safeStr(state.getString(STATE_SERIES_TITLE));
        if (!savedSeriesTitle.isEmpty()) seriesTitle = savedSeriesTitle;
        String savedPoster = safeStr(state.getString(STATE_POSTER));
        if (!savedPoster.isEmpty()) posterUrl = savedPoster;
        if (state.containsKey(STATE_IS_MOVIE)) {
            isMovieFlag = state.getBoolean(STATE_IS_MOVIE, isMovieFlag);
        }
        episodeTitle = formatEpisodeTitleWithSeries(seriesTitle, episodeTitle);
        String savedNume = safeStr(state.getString(STATE_SELECTED_SERVER_NUME));
        if (!savedNume.isEmpty()) selectedServerNume = savedNume;
        String savedRef = safeStr(state.getString(STATE_REFERER));
        if (!savedRef.isEmpty()) referer = savedRef;
        if (state.containsKey(STATE_PREFER_DIRECT)) {
            preferDirect = state.getBoolean(STATE_PREFER_DIRECT, preferDirect);
            useProxyForAttempt = !preferDirect && !proxyBaseUrl.isEmpty();
        }
        if (state.containsKey(STATE_PREV_URL)) prevUrl = safeStr(state.getString(STATE_PREV_URL));
        if (state.containsKey(STATE_NEXT_URL)) nextUrl = safeStr(state.getString(STATE_NEXT_URL));
        if (state.containsKey(STATE_HAS_PREV)) hasPrevFlag = state.getBoolean(STATE_HAS_PREV, hasPrevFlag);
        if (state.containsKey(STATE_HAS_NEXT)) hasNextFlag = state.getBoolean(STATE_HAS_NEXT, hasNextFlag);

        String savedStreams = state.getString(STATE_STREAMS_JSON);
        if (savedStreams != null && !savedStreams.isEmpty()) {
            parseStreamsJson(savedStreams);
        }
        String savedSubs = state.getString(STATE_SUBTITLES_JSON);
        if (savedSubs != null && !savedSubs.isEmpty()) {
            parseSubtitlesJson(savedSubs);
        }
        String savedEps = state.getString(STATE_EPISODES_JSON);
        if (savedEps != null && !savedEps.isEmpty()) {
            parseEpisodesJson(savedEps);
        }
        String savedOpts = state.getString(STATE_OPTIONS_JSON);
        if (savedOpts != null && !savedOpts.isEmpty()) {
            parseOptionsJson(savedOpts);
        }
        String savedVisited = state.getString(STATE_VISITED_EPISODES_JSON);
        if (savedVisited != null && !savedVisited.isEmpty()) {
            parseVisitedEpisodesJson(savedVisited);
        }

        long savedDur = state.getLong(STATE_DURATION_MS, -1L);
        if (savedDur > 0L) {
            lastKnownDurationMs = savedDur;
        }
        long savedPos = state.getLong(STATE_POSITION_MS, -1L);
        if (savedPos >= MIN_RESUME_MS) {
            pendingSeekMs = savedPos;
            lastKnownPositionMs = savedPos;
        }
        int savedStreamIdx = state.getInt(STATE_STREAM_INDEX, -1);
        if (savedStreamIdx >= 0 && savedStreamIdx < streams.size()) {
            currentStreamIdx = savedStreamIdx;
        }
        playbackEnded = state.getBoolean(STATE_PLAYBACK_ENDED, false);
        userInitiatedPause = state.getBoolean(STATE_USER_INITIATED_PAUSE, false);

        if (!episodeUrl.isEmpty()) {
            boolean alreadyCompleted = playbackEnded || isEpisodeCompletedInPref(episodeUrl);
            recordVisitedEpisode(episodeUrl, episodeTitle, lastKnownPositionMs, lastKnownDurationMs, alreadyCompleted);
            persistPendingSessionPref("closed");
        }
        syncPrevNextFromSeries();
        updateHeaderTitles();
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
                if (!u.isEmpty()) {
                    watchedUrls.add(normalizeUrlKey(u));
                    String canonical = canonicalProgressKey(u);
                    if (!canonical.isEmpty()) watchedUrls.add(canonical);
                }
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
        updateMediaSessionMetadata();
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
        options.add("--prefetch-buffer-size=32768");
        options.add("--http-reconnect");
        libVlc = new LibVLC(this, options);
        libVlc.setUserAgent("TopAnimes", DEFAULT_UA);

        mediaPlayer = new MediaPlayer(libVlc);
        mediaPlayer.getVLCVout().addCallback(voutCallback);

        mediaPlayer.setEventListener(event -> {
            final long eventSession = activePlaybackSessionGen;
            if (eventSession <= 0L) return;
            switch (event.type) {
                case MediaPlayer.Event.ESAdded:
                    final int esType = event.getEsChangedType();
                    final int esId = event.getEsChangedID();
                    uiHandler.post(() -> {
                        if (eventSession != activePlaybackSessionGen) return;
                        if (esType != IMedia.Track.Type.Text) return;
                        if (slaveSubtitleLabelsById.containsKey(esId)) return;
                        String label = pendingSlaveSubtitleLabels.pollFirst();
                        if (label != null) {
                            slaveSubtitleLabelsById.put(esId, label);
                        }
                    });
                    break;
                case MediaPlayer.Event.Opening:
                    uiHandler.post(() -> {
                        if (isFinishing() || isDestroyed() || eventSession != activePlaybackSessionGen) return;
                        showLoading(loadingEpisode ? "Carregando episódio..." : null);
                        errorOverlay.setVisibility(View.GONE);
                    });
                    break;
                case MediaPlayer.Event.Buffering:
                    float pct = event.getBuffering();
                    uiHandler.post(() -> {
                        if (isFinishing() || isDestroyed() || eventSession != activePlaybackSessionGen) return;
                        if (!hasProxyBufferTelemetry && lastKnownDurationMs > 0L) {
                            long currentPos = Math.max(0L, lastKnownPositionMs);
                            float clampedPct = Math.max(0f, Math.min(100f, pct));
                            long cachedAheadMs = Math.round((clampedPct / 100f) * DIRECT_BUFFER_FALLBACK_WINDOW_MS);
                            long fallbackBuffered = Math.min(lastKnownDurationMs, currentPos + cachedAheadMs);
                            if (fallbackBuffered > bufferedPositionMs) {
                                bufferedPositionMs = fallbackBuffered;
                                updateSeekBarBufferedProgress();
                            }
                        }
                        if (pct >= 100f && !loadingEpisode && (hasActiveVout || hasPlaybackStartedForStream)) {
                            hideLoading();
                        } else if (mediaPlayer != null && (!mediaPlayer.isPlaying() || !hasPlaybackStartedForStream)) {
                            showLoading(loadingEpisode ? "Carregando episódio..." : null);
                        }
                    });
                    break;
                case MediaPlayer.Event.Vout:
                    int voutCount = event.getVoutCount();
                    uiHandler.post(() -> {
                        if (isFinishing() || isDestroyed() || eventSession != activePlaybackSessionGen) return;
                        hasActiveVout = voutCount > 0;
                        if (hasActiveVout && mediaPlayer != null) {
                            mediaPlayer.setVideoScale(SCALE_OPTIONS[currentScaleIdx]);
                            if (!loadingEpisode) {
                                hideLoading();
                                if (!pauseAfterRestoreFrame && mediaPlayer.isPlaying()) {
                                    updatePlayPauseIcons(true);
                                    scheduleControlsAutoHide();
                                }
                            }
                            if (firstTimeChangedMs >= 0L
                                && !hasPlaybackStartedForStream
                                && (lastKnownPositionMs - firstTimeChangedMs) >= 500L) {
                                markPlaybackStartedForStream();
                            }
                            maybeSchedulePauseAfterRestoreFrame();
                        }
                    });
                    break;
                case MediaPlayer.Event.Playing:
                    uiHandler.post(() -> {
                        if (isFinishing() || isDestroyed() || eventSession != activePlaybackSessionGen) return;
                        if (pendingPauseFromNoisyAudio) {
                            pendingPauseFromNoisyAudio = false;
                            userInitiatedPause = true;
                            if (mediaPlayer != null && mediaPlayer.isPlaying()) {
                                mediaPlayer.pause();
                            }
                            hideLoading();
                            updatePlayPauseIcons(false);
                            setControlsVisible(true);
                            updateMediaSessionPlaybackState(PlaybackState.STATE_PAUSED);
                            return;
                        }
                        playbackFailed = false;
                        playbackEnded = false;
                        loadingEpisode = false;
                        userInitiatedPause = false;
                        errorOverlay.setVisibility(View.GONE);
                        updateEpisodeNavButtons();
                        if (hasActiveVout || hasPlaybackStartedForStream) {
                            hideLoading();
                        }
                        applyPendingSeekIfReady();
                        if (mediaPlayer != null) {
                            mediaPlayer.setRate(holdSpeedActive ? 2.0f : currentSpeed);
                            mediaPlayer.setVolume((muted || pauseAfterRestoreFrame) ? 0 : 100);
                            if (userDisabledSubtitles) {
                                mediaPlayer.setSpuTrack(-1);
                            }
                            if (preferredAudioTrackId >= 0) {
                                MediaPlayer.TrackDescription[] audioTracks = mediaPlayer.getAudioTracks();
                                if (audioTracks != null) {
                                    for (MediaPlayer.TrackDescription t : audioTracks) {
                                        if (t.id == preferredAudioTrackId) {
                                            mediaPlayer.setAudioTrack(preferredAudioTrackId);
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                        if (!subtitlesAttached) {
                            subtitlesAttached = true;
                            downloadAndAttachSubtitles(eventSession);
                        }
                        if (pauseAfterRestoreFrame) {
                            updatePlayPauseIcons(false);
                            setControlsVisible(true);
                            updateMediaSessionPlaybackState(PlaybackState.STATE_PAUSED);
                            uiHandler.removeCallbacks(pauseAfterRestoreFallbackRunnable);
                            uiHandler.postDelayed(pauseAfterRestoreFallbackRunnable, 4000L);
                        } else {
                            updateMediaSessionPlaybackState(PlaybackState.STATE_PLAYING);
                            if (hasActiveVout || hasPlaybackStartedForStream) {
                                updatePlayPauseIcons(true);
                                scheduleControlsAutoHide();
                            }
                        }
                    });
                    break;
                case MediaPlayer.Event.Paused:
                    uiHandler.post(() -> {
                        if (isFinishing() || isDestroyed() || eventSession != activePlaybackSessionGen) return;
                        if (hasPlaybackStartedForStream || userInitiatedPause || pauseAfterRestoreFrame) {
                            uiHandler.removeCallbacks(loadWatchdogRunnable);
                        }
                        updatePlayPauseIcons(false);
                        setControlsVisible(true);
                        updateMediaSessionPlaybackState(PlaybackState.STATE_PAUSED);
                        saveCurrentEpisodeProgress(false);
                    });
                    break;
                case MediaPlayer.Event.LengthChanged:
                    long len = event.getLengthChanged();
                    if (len > 0) {
                        uiHandler.post(() -> {
                            if (isFinishing() || isDestroyed() || eventSession != activePlaybackSessionGen) return;
                            lastKnownDurationMs = len;
                            seekBar.setMax((int) Math.min(Integer.MAX_VALUE, len));
                            timeDurationView.setText(formatMs(len));
                            flushPendingByteRangeBufferSample();
                            updateSeekBarBufferedProgress();
                            updateMediaSessionMetadata();
                            applyPendingSeekIfReady();
                        });
                    }
                    break;
                case MediaPlayer.Event.TimeChanged:
                    long timeMs = event.getTimeChanged();
                    uiHandler.post(() -> {
                        if (isFinishing() || isDestroyed() || eventSession != activePlaybackSessionGen) return;
                        if (pendingSeekMs > 0L) {
                            long targetBeforeApply = pendingSeekMs;
                            applyPendingSeekIfReady();
                            if (timeMs < Math.max(0L, targetBeforeApply - 3000L)) {
                                return;
                            }
                        }
                        if (activeSeekTargetMs > 3000L) {
                            long seekElapsed = SystemClock.elapsedRealtime() - activeSeekIssuedElapsedMs;
                            if (timeMs >= Math.max(0L, activeSeekTargetMs - 3000L) || seekElapsed > 2500L) {
                                activeSeekTargetMs = 0L;
                            } else {
                                return;
                            }
                        }
                        if (pauseAfterRestoreFrame
                            && restoreFrameTargetMs > 15000L
                            && timeMs < Math.max(0L, restoreFrameTargetMs - 12000L)) {
                            return;
                        }
                        lastKnownPositionMs = timeMs;
                        if (firstTimeChangedMs < 0L || timeMs < firstTimeChangedMs) {
                            firstTimeChangedMs = timeMs;
                        }
                        playbackTimeAdvanceCount++;
                        long forwardProgressMs = timeMs - firstTimeChangedMs;
                        if (!hasPlaybackStartedForStream) {
                            boolean confirmedWithVideo = hasActiveVout
                                && playbackTimeAdvanceCount >= 2
                                && forwardProgressMs >= 500L;
                            boolean confirmedTimeProgress = playbackTimeAdvanceCount >= 2
                                && timeMs >= 1500L
                                && forwardProgressMs >= 1000L;
                            if (confirmedWithVideo || confirmedTimeProgress) {
                                markPlaybackStartedForStream();
                            }
                        }
                        if (!userScrubbing) {
                            seekBar.setProgress((int) Math.min(Integer.MAX_VALUE, timeMs));
                            timeCurrentView.setText(formatMs(timeMs));
                        }
                        long totalLen = mediaPlayer != null ? mediaPlayer.getLength() : 0L;
                        if (totalLen > 0 && totalLen != lastKnownDurationMs) {
                            lastKnownDurationMs = totalLen;
                            seekBar.setMax((int) Math.min(Integer.MAX_VALUE, totalLen));
                            timeDurationView.setText(formatMs(totalLen));
                            flushPendingByteRangeBufferSample();
                        }
                        if (!hasProxyBufferTelemetry && hasPlaybackStartedForStream && lastKnownDurationMs > 0L) {
                            long minDirectBuffered = Math.min(lastKnownDurationMs, timeMs + 3000L);
                            if (minDirectBuffered > bufferedPositionMs) {
                                bufferedPositionMs = minDirectBuffered;
                            }
                        }
                        updateSeekBarBufferedProgress();
                        if (pauseAfterRestoreFrame) {
                            restoreFrameTimeReached = true;
                            maybeSchedulePauseAfterRestoreFrame();
                        }
                        long nowWall = System.currentTimeMillis();
                        if (nowWall - lastProgressSavedWallMs >= 5000L) {
                            saveCurrentEpisodeProgress(false);
                        }
                    });
                    break;
                case MediaPlayer.Event.EndReached:
                    uiHandler.post(() -> {
                        if (isFinishing() || isDestroyed() || eventSession != activePlaybackSessionGen) return;
                        uiHandler.removeCallbacks(loadWatchdogRunnable);
                        if (loadingEpisode || playbackFailed || endReachedHandledSessionGen == eventSession) return;
                        endReachedHandledSessionGen = eventSession;
                        updatePlayPauseIcons(false);
                        long reportedPosMs = mediaPlayer != null ? Math.max(0L, mediaPlayer.getTime()) : 0L;
                        long reportedDurMs = mediaPlayer != null ? Math.max(0L, mediaPlayer.getLength()) : 0L;
                        long posMs = Math.max(lastKnownPositionMs, reportedPosMs);
                        long durMs = Math.max(lastKnownDurationMs, reportedDurMs);
                        long wallElapsedMs = streamPreparedWallMs > 0L
                            ? (SystemClock.elapsedRealtime() - streamPreparedWallMs)
                            : 0L;
                        boolean enoughWatchTime = userSeekedInCurrentStream || wallElapsedMs >= 2500L;
                        if (!hasPlaybackStartedForStream
                            || !enoughWatchTime
                            || !isGenuinePlaybackEndMs(posMs, durMs)) {
                            Log.w(
                                TAG,
                                "Premature EndReached (started=" + hasPlaybackStartedForStream
                                    + ", posMs=" + posMs
                                    + ", durMs=" + durMs
                                    + ", elapsedMs=" + wallElapsedMs
                                    + "); running server failover instead of auto-advance"
                            );
                            handlePlaybackError();
                            return;
                        }
                        lastKnownPositionMs = Math.max(posMs, durMs);
                        lastKnownDurationMs = durMs;
                        saveCurrentEpisodeProgress(true);
                        if (autoPlayNextEpisode && !nextUrl.isEmpty() && !isSameEpisodeUrl(episodeUrl, nextUrl)) {
                            Toast.makeText(VlcPlayerActivity.this, "Carregando próximo episódio...", Toast.LENGTH_SHORT).show();
                            loadEpisodeInFullscreen(nextUrl, false);
                        } else if (autoPlayNextEpisode && hasNextFlag && nextUrl.isEmpty()) {
                            Toast.makeText(VlcPlayerActivity.this, "Carregando próximo episódio...", Toast.LENGTH_SHORT).show();
                            finishWithAction("next", false);
                        } else {
                            playbackEnded = true;
                            pauseAfterRestoreFrame = false;
                            pauseAfterRestoreScheduled = false;
                            restoreFrameTimeReached = false;
                            restoreFrameTargetMs = 0L;
                            uiHandler.removeCallbacks(pauseAfterRestoreRunnable);
                            uiHandler.removeCallbacks(pauseAfterRestoreFallbackRunnable);
                            setControlsVisible(true);
                            updateMediaSessionPlaybackState(PlaybackState.STATE_PAUSED);
                        }
                    });
                    break;
                case MediaPlayer.Event.EncounteredError:
                    uiHandler.post(() -> {
                        if (isFinishing() || isDestroyed() || eventSession != activePlaybackSessionGen) return;
                        uiHandler.removeCallbacks(loadWatchdogRunnable);
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

    private void attachVideoViewsIfNeeded() {
        if (mediaPlayer == null || videoLayout == null) return;
        if (!mediaPlayer.getVLCVout().areViewsAttached()) {
            // Release any stale VideoHelper left over after AWindow.onSurfaceDestroyed()
            isStoppingOrDetaching = true;
            try {
                mediaPlayer.detachViews();
            } catch (Exception ignored) {
            } finally {
                isStoppingOrDetaching = false;
            }
            mediaPlayer.attachViews(videoLayout, null, true, false);
            mediaPlayer.setVideoScale(SCALE_OPTIONS[currentScaleIdx]);
        }
    }

    private void maybeSchedulePauseAfterRestoreFrame() {
        if (!pauseAfterRestoreFrame || pauseAfterRestoreScheduled) return;
        if (!hasActiveVout || !restoreFrameTimeReached || pendingSeekMs > 0L) return;
        pauseAfterRestoreScheduled = true;
        uiHandler.removeCallbacks(pauseAfterRestoreRunnable);
        uiHandler.postDelayed(pauseAfterRestoreRunnable, 180L);
    }

    private void finishPauseAfterRestoreFrame() {
        pauseAfterRestoreScheduled = false;
        uiHandler.removeCallbacks(loadWatchdogRunnable);
        uiHandler.removeCallbacks(pauseAfterRestoreRunnable);
        uiHandler.removeCallbacks(pauseAfterRestoreFallbackRunnable);
        if (!pauseAfterRestoreFrame || isFinishing() || isDestroyed()) return;
        pauseAfterRestoreFrame = false;
        restoreFrameTimeReached = false;
        restoreFrameTargetMs = 0L;
        pausedMidRestore = false;
        if (mediaPlayer != null) {
            if (mediaPlayer.isPlaying()) {
                mediaPlayer.pause();
            }
            mediaPlayer.setVolume(muted ? 0 : 100);
        }
        hideLoading();
        updatePlayPauseIcons(false);
        setControlsVisible(true);
        updateMediaSessionPlaybackState(PlaybackState.STATE_PAUSED);
    }

    private void cancelPendingPauseAfterRestore(boolean resumePlayback) {
        uiHandler.removeCallbacks(pauseAfterRestoreRunnable);
        uiHandler.removeCallbacks(pauseAfterRestoreFallbackRunnable);
        pauseAfterRestoreFrame = false;
        pauseAfterRestoreScheduled = false;
        restoreFrameTimeReached = false;
        restoreFrameTargetMs = 0L;
        pausedMidRestore = false;
        if (mediaPlayer != null) {
            mediaPlayer.setVolume(muted ? 0 : 100);
            if (resumePlayback) {
                pendingPauseFromNoisyAudio = false;
                requestAudioFocus();
                if (!mediaPlayer.isPlaying()) {
                    mediaPlayer.play();
                }
                updatePlayPauseIcons(true);
                updateMediaSessionPlaybackState(PlaybackState.STATE_PLAYING);
                scheduleControlsAutoHide();
            }
        }
    }

    private long captureCurrentPositionMs() {
        long pos = lastKnownPositionMs;
        boolean waitingForSeekCompletion = activeSeekTargetMs > 3000L
            && (SystemClock.elapsedRealtime() - activeSeekIssuedElapsedMs) <= 2500L;
        if (mediaPlayer != null
            && hasPlaybackStartedForStream
            && pendingSeekMs <= 0L
            && !waitingForSeekCompletion
            && !pauseAfterRestoreFrame
            && !pausedMidRestore
            && !playbackEnded
            && activePlaybackSessionGen > 0L) {
            long current = mediaPlayer.getTime();
            if (current > 0L) {
                pos = current;
                lastKnownPositionMs = current;
            }
        }
        return Math.max(pendingSeekMs, pos);
    }

    private void restorePlaybackAfterForeground(boolean autoResume) {
        if (isFinishing() || isDestroyed() || loadingEpisode || playbackFailed || playbackEnded) {
            return;
        }
        pendingSeekMs = Math.max(pendingSeekMs, lastKnownPositionMs);
        prepareAndPlayCurrentStream(!autoResume);
    }

    private void scheduleForegroundSurfaceRecovery() {
        if (!isActivityResumed || isFinishing() || isDestroyed() || isStoppingOrDetaching) return;
        if (loadingEpisode || playbackFailed || playbackEnded || streams.isEmpty()) return;
        if (videoLayout == null || !videoLayout.isAttachedToWindow()) return;

        long now = SystemClock.elapsedRealtime();
        if (now - lastSurfaceRecoveryWallMs < 800L) return;
        lastSurfaceRecoveryWallMs = now;

        boolean shouldAutoResume = !pauseAfterRestoreFrame
            && ((mediaPlayer != null && mediaPlayer.isPlaying())
                || (!hasPlaybackStartedForStream && activePlaybackSessionGen > 0L));
        long resumePos = captureCurrentPositionMs();
        pendingSeekMs = Math.max(pendingSeekMs, resumePos);
        activePlaybackSessionGen = -1L;

        if (mediaPlayer != null) {
            isStoppingOrDetaching = true;
            try {
                mediaPlayer.stop();
                mediaPlayer.detachViews();
            } catch (Exception ignored) {
            } finally {
                isStoppingOrDetaching = false;
            }
        }

        final boolean autoResume = shouldAutoResume;
        videoLayout.post(() -> {
            if (!isActivityStarted || isFinishing() || isDestroyed()) return;
            surfacesWereDestroyed = false;
            attachVideoViewsIfNeeded();
            restorePlaybackAfterForeground(autoResume);
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
        if (!playbackFailed && controlsVisible && !seekOnlyHudActive) {
            btnPlayCenter.setVisibility(View.VISIBLE);
        }
    }

    private void updatePlayPauseIcons(boolean isPlaying) {
        int res = isPlaying ? R.drawable.ic_player_pause : R.drawable.ic_player_play;
        btnPlayCenter.setImageResource(res);
        btnPlayBottom.setImageResource(res);
    }

    private void markPlaybackStartedForStream() {
        if (hasPlaybackStartedForStream) return;
        hasPlaybackStartedForStream = true;
        retriedFreshServerEmbeds = false;
        playbackFailed = false;
        loadingEpisode = false;
        uiHandler.removeCallbacks(loadWatchdogRunnable);
        hideLoading();
        errorOverlay.setVisibility(View.GONE);
        updateEpisodeNavButtons();
        if (!pauseAfterRestoreFrame) {
            updatePlayPauseIcons(true);
            scheduleControlsAutoHide();
        }
    }

    private static boolean shouldSkipDirectFallbackForUrl(String rawUrl) {
        if (rawUrl == null || rawUrl.isEmpty()) return false;
        String lower = rawUrl.toLowerCase(Locale.ROOT);
        if (lower.contains(".m3u8")) {
            return lower.contains("b-cdn.net") || lower.contains("tiktokcdn.com");
        }
        return false;
    }

    private void prepareAndPlayCurrentStream() {
        prepareAndPlayCurrentStream(false);
    }

    private void prepareAndPlayCurrentStream(boolean pauseAfterFirstFrame) {
        uiHandler.removeCallbacks(loadWatchdogRunnable);
        uiHandler.removeCallbacks(pauseAfterRestoreRunnable);
        uiHandler.removeCallbacks(pauseAfterRestoreFallbackRunnable);
        pauseAfterRestoreFrame = pauseAfterFirstFrame;
        pauseAfterRestoreScheduled = false;
        restoreFrameTimeReached = false;
        pausedMidRestore = false;
        restoreFrameTargetMs = pauseAfterFirstFrame ? Math.max(0L, pendingSeekMs) : 0L;
        playbackEnded = false;
        hasActiveVout = false;

        if (streams.isEmpty()) {
            activePlaybackSessionGen = -1L;
            activeBufferSessionId = 0L;
            LocalProxyPlugin.clearBufferProgressListener(0L);
            hasProxyBufferTelemetry = false;
            resetBufferProgress(0L);
            pauseAfterRestoreFrame = false;
            playbackFailed = true;
            loadingEpisode = false;
            hideLoading();
            errorText.setText("Nenhum stream disponível para reprodução.");
            errorOverlay.setVisibility(View.VISIBLE);
            setControlsVisible(true);
            return;
        }
        if (!isActivityStarted) {
            shouldStartPlaybackOnStart = true;
            resumePlayingAfterRestore = !pauseAfterFirstFrame;
            return;
        }
        if (mediaPlayer == null || libVlc == null) {
            return;
        }

        String ensuredProxy = LocalProxyPlugin.ensureSharedProxyBaseUrl();
        if (ensuredProxy != null && !ensuredProxy.isEmpty()) {
            proxyBaseUrl = ensuredProxy;
            if (!preferDirect && !triedAlternateTransport) {
                useProxyForAttempt = true;
            }
        }

        attachVideoViewsIfNeeded();
        if (!pauseAfterFirstFrame) {
            requestAudioFocus();
        }

        if (currentStreamIdx < 0 || currentStreamIdx >= streams.size()) {
            currentStreamIdx = 0;
        }
        StreamItem item = streams.get(currentStreamIdx);
        updateQualityLabel();

        final long nextBufferSession = ++bufferSessionCounter;
        activeBufferSessionId = nextBufferSession;
        hasProxyBufferTelemetry = false;
        resetBufferProgress(pendingSeekMs);

        String targetUrl = item.url;
        if (useProxyForAttempt && !proxyBaseUrl.isEmpty()) {
            targetUrl = LocalProxyPlugin.buildSharedProxyUrl(item.url, referer, nextBufferSession);
            LocalProxyPlugin.setBufferProgressListener(nextBufferSession, new LocalProxyPlugin.BufferProgressListener() {
                @Override
                public void onByteRangeBuffered(long sid, long rangeStart, long rangeEnd, long totalBytes) {
                    uiHandler.post(() -> {
                        if (isFinishing() || isDestroyed() || sid != activeBufferSessionId) return;
                        applyByteRangeBufferSample(rangeStart, rangeEnd, totalBytes);
                    });
                }

                @Override
                public void onHlsTimeBuffered(long sid, long segStartMs, long segEndMs) {
                    uiHandler.post(() -> {
                        if (isFinishing() || isDestroyed() || sid != activeBufferSessionId) return;
                        applyHlsTimeBufferSample(segStartMs, segEndMs);
                    });
                }
            });
        } else {
            LocalProxyPlugin.clearBufferProgressListener(0L);
        }

        hasPlaybackStartedForStream = false;
        playbackTimeAdvanceCount = 0;
        firstTimeChangedMs = -1L;
        userSeekedInCurrentStream = false;
        streamPreparedWallMs = SystemClock.elapsedRealtime();
        userInitiatedPause = false;
        pendingPauseFromNoisyAudio = false;
        playbackFailed = false;
        loadingEpisode = false;
        subtitlesAttached = false;
        pendingSlaveSubtitleLabels.clear();
        slaveSubtitleLabelsById.clear();
        updateEpisodeNavButtons();
        updateMediaSessionMetadata();
        updateMediaSessionPlaybackState(
            pauseAfterFirstFrame ? PlaybackState.STATE_PAUSED : PlaybackState.STATE_BUFFERING
        );
        errorOverlay.setVisibility(View.GONE);
        showLoading(null);

        activePlaybackSessionGen = -1L;

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
        activePlaybackSessionGen = ++sessionCounter;
        mediaPlayer.play();
        uiHandler.postDelayed(loadWatchdogRunnable, LOAD_WATCHDOG_TIMEOUT_MS);
    }

    private void handlePlaybackError() {
        uiHandler.removeCallbacks(loadWatchdogRunnable);
        boolean keepPaused = pauseAfterRestoreFrame;

        if (proxyBaseUrl.isEmpty()) {
            String ensured = LocalProxyPlugin.ensureSharedProxyBaseUrl();
            if (ensured != null && !ensured.isEmpty()) {
                proxyBaseUrl = ensured;
            }
        }

        String currentUrl = (!streams.isEmpty() && currentStreamIdx >= 0 && currentStreamIdx < streams.size())
            ? streams.get(currentStreamIdx).url
            : "";

        if (!triedAlternateTransport) {
            if (!useProxyForAttempt && !proxyBaseUrl.isEmpty()) {
                triedAlternateTransport = true;
                useProxyForAttempt = true;
                pendingSeekMs = Math.max(pendingSeekMs, lastKnownPositionMs);
                prepareAndPlayCurrentStream(keepPaused);
                return;
            }
            if (useProxyForAttempt && !shouldSkipDirectFallbackForUrl(currentUrl)) {
                triedAlternateTransport = true;
                useProxyForAttempt = false;
                pendingSeekMs = Math.max(pendingSeekMs, lastKnownPositionMs);
                prepareAndPlayCurrentStream(keepPaused);
                return;
            }
        }

        if (currentServerRetryCount < MAX_RETRIES_PER_SERVER) {
            currentServerRetryCount++;
            triedAlternateTransport = false;
            useProxyForAttempt = !preferDirect && !proxyBaseUrl.isEmpty();
            pendingSeekMs = Math.max(pendingSeekMs, lastKnownPositionMs);
            prepareAndPlayCurrentStream(keepPaused);
            return;
        }

        if (!selectedServerNume.isEmpty()) {
            failedServerNumes.add(selectedServerNume);
        }

        List<TopAnimesEpisodeResolver.ServerOption> remaining = new ArrayList<>();
        for (TopAnimesEpisodeResolver.ServerOption opt : serverOptions) {
            if (!failedServerNumes.contains(opt.nume)) {
                remaining.add(opt);
            }
        }

        if (!remaining.isEmpty()) {
            triggerBestServerFailover(remaining, Math.max(pendingSeekMs, lastKnownPositionMs));
            return;
        }

        if (!retriedFreshServerEmbeds && !serverOptions.isEmpty()) {
            retriedFreshServerEmbeds = true;
            failedServerNumes.clear();
            synchronized (embedProbeCache) {
                embedProbeCache.clear();
            }
            triggerBestServerFailover(new ArrayList<>(serverOptions), Math.max(pendingSeekMs, lastKnownPositionMs));
            return;
        }

        activePlaybackSessionGen = -1L;
        pauseAfterRestoreFrame = false;
        pauseAfterRestoreScheduled = false;
        restoreFrameTimeReached = false;
        restoreFrameTargetMs = 0L;
        uiHandler.removeCallbacks(pauseAfterRestoreRunnable);
        uiHandler.removeCallbacks(pauseAfterRestoreFallbackRunnable);
        playbackFailed = true;
        loadingEpisode = false;
        hideLoading();
        errorText.setText("Não foi possível reproduzir este episódio em nenhum servidor. Tente novamente.");
        errorOverlay.setVisibility(View.VISIBLE);
        setControlsVisible(true);
    }

    private static final class ProbeOutcome {
        final TopAnimesEpisodeResolver.ServerOption option;
        final int orderIndex;
        final TopAnimesEpisodeResolver.ResolvedEmbedData resolved;

        ProbeOutcome(
            TopAnimesEpisodeResolver.ServerOption option,
            int orderIndex,
            TopAnimesEpisodeResolver.ResolvedEmbedData resolved
        ) {
            this.option = option;
            this.orderIndex = orderIndex;
            this.resolved = resolved;
        }
    }

    private void triggerBestServerFailover(
        List<TopAnimesEpisodeResolver.ServerOption> candidates,
        long resumePositionMs
    ) {
        final int gen = episodeLoadGen.incrementAndGet();
        activePlaybackSessionGen = -1L;
        uiHandler.removeCallbacks(pauseAfterRestoreRunnable);
        uiHandler.removeCallbacks(pauseAfterRestoreFallbackRunnable);
        pauseAfterRestoreFrame = false;
        pauseAfterRestoreScheduled = false;
        restoreFrameTimeReached = false;
        restoreFrameTargetMs = 0L;
        preferredAudioTrackId = -1;
        playbackEnded = false;
        loadingEpisode = true;
        playbackFailed = false;
        hasPlaybackStartedForStream = false;
        hasActiveVout = false;
        firstTimeChangedMs = -1L;
        playbackTimeAdvanceCount = 0;
        userSeekedInCurrentStream = false;
        streamPreparedWallMs = 0L;
        errorOverlay.setVisibility(View.GONE);
        showLoading("Buscando servidor com melhor qualidade...");
        updateEpisodeNavButtons();

        if (mediaPlayer != null) {
            try {
                mediaPlayer.stop();
            } catch (Exception ignored) {
            }
        }

        bgExecutor.execute(() -> {
            CompletionService<ProbeOutcome> ecs = new ExecutorCompletionService<>(bgExecutor);
            List<Future<ProbeOutcome>> futures = new ArrayList<>();
            for (int i = 0; i < candidates.size(); i++) {
                final int idx = i;
                final TopAnimesEpisodeResolver.ServerOption opt = candidates.get(i);
                futures.add(ecs.submit(() -> {
                    TopAnimesEpisodeResolver.ResolvedEmbedData cached;
                    synchronized (embedProbeCache) {
                        cached = embedProbeCache.get(opt.embedUrl);
                    }
                    if (cached == null) {
                        cached = TopAnimesEpisodeResolver.resolveEmbed(opt.embedUrl);
                        synchronized (embedProbeCache) {
                            embedProbeCache.put(opt.embedUrl, cached);
                        }
                    }
                    return new ProbeOutcome(opt, idx, cached);
                }));
            }

            ProbeOutcome best = null;
            int bestQ = -1;
            int bestP = -1;
            long deadlineNs = System.nanoTime() + TimeUnit.SECONDS.toNanos(9);

            for (int received = 0; received < futures.size(); received++) {
                long remainingMs = Math.max(100L, TimeUnit.NANOSECONDS.toMillis(deadlineNs - System.nanoTime()));
                if (System.nanoTime() >= deadlineNs) break;
                try {
                    Future<ProbeOutcome> done = ecs.poll(remainingMs, TimeUnit.MILLISECONDS);
                    if (done == null) break;
                    ProbeOutcome outcome = done.get();
                    if (outcome != null && outcome.resolved != null
                        && outcome.resolved.ok && !outcome.resolved.streams.isEmpty()) {
                        int q = TopAnimesEpisodeResolver.scoreEmbedQuality(outcome.resolved);
                        int p = TopAnimesEpisodeResolver.providerPriority(outcome.option.providerKind);
                        if (best == null || q > bestQ
                            || (q == bestQ && p > bestP)
                            || (q == bestQ && p == bestP && outcome.orderIndex < best.orderIndex)) {
                            best = outcome;
                            bestQ = q;
                            bestP = p;
                        }
                    }
                } catch (Exception ignored) {
                }
            }

            for (Future<ProbeOutcome> f : futures) {
                if (!f.isDone()) f.cancel(true);
            }

            final ProbeOutcome winner = best;
            uiHandler.post(() -> {
                if (isFinishing() || isDestroyed() || gen != episodeLoadGen.get()) return;
                if (winner == null) {
                    for (TopAnimesEpisodeResolver.ServerOption failedOpt : candidates) {
                        failedServerNumes.add(failedOpt.nume);
                    }
                    loadingEpisode = false;
                    playbackFailed = true;
                    hideLoading();
                    errorText.setText("Nenhum servidor disponível conseguiu reproduzir este episódio. Tente novamente.");
                    errorOverlay.setVisibility(View.VISIBLE);
                    updateEpisodeNavButtons();
                    setControlsVisible(true);
                    return;
                }

                loadingEpisode = false;
                currentServerRetryCount = 0;
                triedAlternateTransport = false;
                selectedServerNume = winner.option.nume;
                referer = winner.resolved.referer;
                preferDirect = winner.resolved.preferDirect;
                useProxyForAttempt = !preferDirect && !proxyBaseUrl.isEmpty();
                pendingSeekMs = resumePositionMs > 2000L ? resumePositionMs : 0L;

                streams.clear();
                for (TopAnimesEpisodeResolver.StreamCandidate sc : winner.resolved.streams) {
                    streams.add(new StreamItem(sc.label, sc.url));
                }
                currentStreamIdx = 0;

                subtitles.clear();
                for (TopAnimesEpisodeResolver.SubtitleCandidate sub : winner.resolved.subtitles) {
                    subtitles.add(new SubtitleItem(sub.label, sub.url, sub.isDefault));
                }

                updateQualityLabel();
                updateEpisodeNavButtons();

                String qLabel = TopAnimesEpisodeResolver.getBestQualityLabel(winner.resolved);
                Toast.makeText(
                    VlcPlayerActivity.this,
                    "Falha no servidor — trocado para " + winner.option.label
                        + (qLabel.isEmpty() ? "" : " (" + qLabel + ")"),
                    Toast.LENGTH_SHORT
                ).show();

                prepareAndPlayCurrentStream();
            });
        });
    }

    /**
     * Attaches an external subtitle file to LibVLC and remembers its human label so the track menu
     * can show it instead of LibVLC's generic "Track N" name.
     */
    private void attachSubtitleSlave(Uri uri, boolean select, String label) {
        if (mediaPlayer == null || uri == null) return;
        String cleanLabel = label != null ? label.trim() : "";
        pendingSlaveSubtitleLabels.addLast(cleanLabel.isEmpty() ? "Legenda externa" : cleanLabel);
        if (!mediaPlayer.addSlave(IMedia.Slave.Type.Subtitle, uri, select)) {
            pendingSlaveSubtitleLabels.pollLast();
        }
    }

    private static String subtitleItemLabel(SubtitleItem sub, int index) {
        String label = sub != null && sub.label != null ? sub.label.trim() : "";
        return label.isEmpty() ? "Legenda " + (index + 1) : label;
    }

    private void downloadAndAttachSubtitles(final long expectedSession) {
        if (localSubtitleUri != null && mediaPlayer != null && isActivityStarted) {
            attachSubtitleSlave(localSubtitleUri, !userDisabledSubtitles, "Legenda local");
        }
        if (subtitles.isEmpty()) return;

        final List<SubtitleItem> subsSnapshot = new ArrayList<>(subtitles);
        final boolean hasLocalSub = localSubtitleUri != null;
        final List<Integer> pendingIndices = new ArrayList<>();

        for (int i = 0; i < subsSnapshot.size(); i++) {
            SubtitleItem sub = subsSnapshot.get(i);
            File cached;
            synchronized (downloadedSubtitleFiles) {
                cached = downloadedSubtitleFiles.get(sub.url);
            }
            if (cached != null && cached.exists()) {
                if (mediaPlayer != null && isActivityStarted && expectedSession == activePlaybackSessionGen) {
                    boolean selectDefault = !userDisabledSubtitles && !hasLocalSub && (sub.isDefault || i == 0);
                    attachSubtitleSlave(Uri.fromFile(cached), selectDefault, subtitleItemLabel(sub, i));
                }
            } else {
                pendingIndices.add(i);
            }
        }

        if (pendingIndices.isEmpty()) return;
        bgExecutor.execute(() -> {
            for (int idx : pendingIndices) {
                if (expectedSession != activePlaybackSessionGen || isFinishing() || isDestroyed()) {
                    return;
                }
                SubtitleItem sub = subsSnapshot.get(idx);
                try {
                    File downloaded = downloadSubtitleToCache(sub.url, idx);
                    if (downloaded != null) {
                        synchronized (downloadedSubtitleFiles) {
                            downloadedSubtitleFiles.put(sub.url, downloaded);
                            cachedSubFiles.add(downloaded);
                        }
                        final boolean selectDefault = !userDisabledSubtitles && !hasLocalSub && (sub.isDefault || idx == 0);
                        final String subLabel = subtitleItemLabel(sub, idx);
                        uiHandler.post(() -> {
                            if (mediaPlayer != null && isActivityStarted
                                && expectedSession == activePlaybackSessionGen
                                && !isFinishing() && !isDestroyed()) {
                                attachSubtitleSlave(Uri.fromFile(downloaded), selectDefault, subLabel);
                            }
                        });
                    }
                } catch (Exception e) {
                    Log.w(TAG, "Failed loading remote subtitle: " + sub.url, e);
                }
            }
        });
    }

    private void clearCachedSubtitles() {
        List<File> toDelete;
        synchronized (downloadedSubtitleFiles) {
            toDelete = new ArrayList<>(cachedSubFiles);
            cachedSubFiles.clear();
            downloadedSubtitleFiles.clear();
        }
        for (File f : toDelete) {
            try {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
            } catch (Exception ignored) {
            }
        }
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
            failedServerNumes.clear();
            currentServerRetryCount = 0;
            triedAlternateTransport = false;
            synchronized (embedProbeCache) {
                embedProbeCache.clear();
            }
            if (streams.isEmpty() && !episodeUrl.isEmpty()) {
                loadEpisodeInFullscreen(episodeUrl);
                return;
            }
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
                if (seekOnlyHudActive) {
                    setControlsVisible(true);
                    uiHandler.removeCallbacks(hideControlsRunnable);
                }
            }

            @Override
            public void onStopTrackingTouch(SeekBar bar) {
                userScrubbing = false;
                if (pauseAfterRestoreFrame) {
                    cancelPendingPauseAfterRestore(false);
                }
                if (mediaPlayer != null) {
                    long target = bar.getProgress();
                    userSeekedInCurrentStream = true;
                    if (!hasPlaybackStartedForStream) {
                        firstTimeChangedMs = target;
                    }
                    long prevPos = lastKnownPositionMs;
                    mediaPlayer.setTime(target);
                    lastKnownPositionMs = target;
                    onSeekCommitted(prevPos, target);
                }
                scheduleControlsAutoHide();
            }
        });

        View touchLayer = findViewById(R.id.vlc_touch_layer);
        touchLayer.setOnTouchListener((v, event) -> {
            int action = event.getActionMasked();
            if (action == MotionEvent.ACTION_DOWN) {
                gestureMode = GESTURE_NONE;
                gestureDownX = event.getX();
                gestureDownY = event.getY();
                holdSpeedActive = false;
                uiHandler.removeCallbacks(holdSpeedRunnable);
                uiHandler.postDelayed(holdSpeedRunnable, 450L);
                return true;
            }
            if (action == MotionEvent.ACTION_POINTER_DOWN) {
                uiHandler.removeCallbacks(holdSpeedRunnable);
                uiHandler.removeCallbacks(singleTapRunnable);
                if (holdSpeedActive) {
                    holdSpeedActive = false;
                    if (holdSpeedBadge != null) holdSpeedBadge.setVisibility(View.GONE);
                    if (mediaPlayer != null) mediaPlayer.setRate(currentSpeed);
                }
                return true;
            }
            if (action == MotionEvent.ACTION_MOVE) {
                if (event.getPointerCount() > 1) {
                    return true;
                }
                if (holdSpeedActive || gestureMode == GESTURE_HOLD_2X) {
                    return true;
                }
                float dx = event.getX() - gestureDownX;
                float dy = event.getY() - gestureDownY;
                float touchSlop = Math.max(ViewConfiguration.get(this).getScaledTouchSlop(), dp(14));

                if (gestureMode == GESTURE_NONE) {
                    if (Math.hypot(dx, dy) > touchSlop) {
                        uiHandler.removeCallbacks(holdSpeedRunnable);
                        uiHandler.removeCallbacks(singleTapRunnable);
                        lastTapTimeMs = 0L;
                        lastTapSide = 0;

                        if (Math.abs(dy) >= Math.abs(dx)) {
                            boolean isLeftSide = gestureDownX < (v.getWidth() * 0.5f);
                            if (isLeftSide) {
                                gestureMode = GESTURE_BRIGHTNESS;
                                gestureStartBrightness = getCurrentWindowBrightness();
                            } else {
                                gestureMode = GESTURE_VOLUME;
                                initGestureVolumeState();
                            }
                        }
                    }
                }

                if (gestureMode == GESTURE_BRIGHTNESS) {
                    float range = Math.max(dp(180), v.getHeight() * 0.65f);
                    float delta = -dy / range;
                    float target = Math.max(0.01f, Math.min(1.0f, gestureStartBrightness + delta));
                    WindowManager.LayoutParams lp = getWindow().getAttributes();
                    if (lp != null) {
                        lp.screenBrightness = target;
                        getWindow().setAttributes(lp);
                    }
                    showGestureBadge("Brilho: " + Math.round(target * 100f) + "%", false);
                } else if (gestureMode == GESTURE_VOLUME) {
                    float range = Math.max(dp(180), v.getHeight() * 0.65f);
                    float delta = (-dy / range) * gestureMaxVolume;
                    float nextVolFloat = Math.max(0f, Math.min((float) gestureMaxVolume, gestureStartVolumeFloat + delta));
                    int targetVol = Math.round(nextVolFloat);
                    if (audioManager != null) {
                        audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, targetVol, 0);
                    }
                    if (targetVol == 0) {
                        muted = true;
                        if (mediaPlayer != null) mediaPlayer.setVolume(0);
                    } else if (muted) {
                        muted = false;
                        if (mediaPlayer != null) mediaPlayer.setVolume(pauseAfterRestoreFrame ? 0 : 100);
                    }
                    if (btnMute != null) {
                        btnMute.setImageResource(
                            muted ? R.drawable.ic_player_volume_off : R.drawable.ic_player_volume_on
                        );
                    }
                    int pct = gestureMaxVolume > 0
                        ? Math.round((targetVol * 100f) / gestureMaxVolume)
                        : 0;
                    showGestureBadge(targetVol == 0 ? "Volume: Mudo" : ("Volume: " + pct + "%"), false);
                }
                return true;
            }
            if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
                uiHandler.removeCallbacks(holdSpeedRunnable);
                if (holdSpeedActive || gestureMode == GESTURE_HOLD_2X) {
                    holdSpeedActive = false;
                    gestureMode = GESTURE_NONE;
                    if (holdSpeedBadge != null) holdSpeedBadge.setVisibility(View.GONE);
                    if (mediaPlayer != null) mediaPlayer.setRate(currentSpeed);
                    return true;
                }
                if (gestureMode == GESTURE_BRIGHTNESS || gestureMode == GESTURE_VOLUME) {
                    gestureMode = GESTURE_NONE;
                    uiHandler.removeCallbacks(hideGestureBadgeRunnable);
                    uiHandler.postDelayed(hideGestureBadgeRunnable, 700L);
                    return true;
                }
                gestureMode = GESTURE_NONE;
                if (action == MotionEvent.ACTION_UP) {
                    handleSingleOrDoubleTap(event.getX(), v.getWidth());
                }
                return true;
            }
            return false;
        });
    }

    private float getCurrentWindowBrightness() {
        WindowManager.LayoutParams lp = getWindow().getAttributes();
        if (lp != null && lp.screenBrightness >= 0f) {
            return Math.max(0.01f, Math.min(1.0f, lp.screenBrightness));
        }
        try {
            int sys = Settings.System.getInt(getContentResolver(), Settings.System.SCREEN_BRIGHTNESS, 128);
            return Math.max(0.02f, Math.min(1.0f, sys / 255f));
        } catch (Exception ignored) {
            return 0.5f;
        }
    }

    private void initGestureVolumeState() {
        if (audioManager == null) {
            audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        }
        if (audioManager != null) {
            gestureMaxVolume = Math.max(1, audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC));
            gestureStartVolumeFloat = (float) audioManager.getStreamVolume(AudioManager.STREAM_MUSIC);
        } else {
            gestureMaxVolume = 15;
            gestureStartVolumeFloat = 8f;
        }
    }

    private void showGestureBadge(String text, boolean autoHide) {
        if (seekOnlyHudActive) {
            setControlsVisible(false);
        }
        if (seekBadge != null) seekBadge.setVisibility(View.GONE);
        if (gestureBadge == null) return;
        gestureBadge.setText(text);
        gestureBadge.setVisibility(View.VISIBLE);
        uiHandler.removeCallbacks(hideGestureBadgeRunnable);
        if (autoHide) {
            uiHandler.postDelayed(hideGestureBadgeRunnable, 700L);
        }
    }

    private void handleSingleOrDoubleTap(float x, int width) {
        float rel = width > 0 ? (x / (float) width) : 0.5f;
        int side = rel < 0.38f ? -1 : (rel > 0.62f ? 1 : 0);
        long now = System.currentTimeMillis();

        boolean isContinuingSeekStreak =
            side != 0 && seekOnlyHudActive && seekStreakCount > 0 && side == seekStreakSide;
        boolean isDoubleTapOnSide =
            side != 0 && side == lastTapSide && (now - lastTapTimeMs) <= DOUBLE_TAP_WINDOW_MS;

        if (isContinuingSeekStreak || isDoubleTapOnSide) {
            uiHandler.removeCallbacks(singleTapRunnable);
            lastTapTimeMs = now;
            lastTapSide = side;
            if (seekStreakSide == side) {
                seekStreakCount++;
            } else {
                seekStreakSide = side;
                seekStreakCount = 1;
            }
            int totalSec = seekStreakCount * 5;
            String badgeLabel = (side < 0 ? "-" : "+") + totalSec + "s";
            seekByMs(side < 0 ? -5000L : 5000L, badgeLabel, false, true);
            return;
        }

        lastTapTimeMs = now;
        lastTapSide = side;
        uiHandler.removeCallbacks(singleTapRunnable);
        if (side == 0) {
            setControlsVisible(!controlsVisible);
        } else {
            uiHandler.postDelayed(singleTapRunnable, DOUBLE_TAP_WINDOW_MS);
        }
    }

    private void pausePlaybackForAudioRouteOrControl() {
        uiHandler.removeCallbacks(singleTapRunnable);
        if (isFinishing() || isDestroyed() || mediaPlayer == null || playbackFailed) return;
        if (pauseAfterRestoreFrame) {
            finishPauseAfterRestoreFrame();
            return;
        }
        if (mediaPlayer.isPlaying()) {
            pendingPauseFromNoisyAudio = false;
            userInitiatedPause = true;
            mediaPlayer.pause();
            updatePlayPauseIcons(false);
            uiHandler.removeCallbacks(hideControlsRunnable);
            setControlsVisible(true);
            updateMediaSessionPlaybackState(PlaybackState.STATE_PAUSED);
        } else if (!loadingEpisode && !playbackEnded && !hasPlaybackStartedForStream && activePlaybackSessionGen > 0L) {
            pendingPauseFromNoisyAudio = true;
            userInitiatedPause = true;
            updatePlayPauseIcons(false);
            uiHandler.removeCallbacks(hideControlsRunnable);
            setControlsVisible(true);
            updateMediaSessionPlaybackState(PlaybackState.STATE_PAUSED);
        } else {
            updateMediaSessionPlaybackState(PlaybackState.STATE_PAUSED);
        }
    }

    private void resumePlaybackFromMediaControl() {
        uiHandler.removeCallbacks(singleTapRunnable);
        pendingPauseFromNoisyAudio = false;
        if (isFinishing() || isDestroyed() || mediaPlayer == null || loadingEpisode || playbackFailed) {
            return;
        }
        if (pauseAfterRestoreFrame) {
            cancelPendingPauseAfterRestore(true);
            return;
        }
        if (mediaPlayer.isPlaying()) {
            updatePlayPauseIcons(true);
            updateMediaSessionPlaybackState(PlaybackState.STATE_PLAYING);
            return;
        }
        if (playbackEnded
            || !mediaPlayer.getVLCVout().areViewsAttached()
            || !mediaPlayer.hasMedia()
            || activePlaybackSessionGen <= 0L) {
            userInitiatedPause = false;
            if (playbackEnded) {
                playbackEnded = false;
                pendingSeekMs = 0L;
                lastKnownPositionMs = 0L;
            } else {
                pendingSeekMs = Math.max(pendingSeekMs, lastKnownPositionMs);
            }
            prepareAndPlayCurrentStream(false);
            return;
        }
        userInitiatedPause = false;
        requestAudioFocus();
        mediaPlayer.play();
        updatePlayPauseIcons(true);
        updateMediaSessionPlaybackState(PlaybackState.STATE_PLAYING);
        scheduleControlsAutoHide();
    }

    private static boolean isHandledMediaKey(int keyCode) {
        switch (keyCode) {
            case KeyEvent.KEYCODE_MEDIA_PLAY:
            case KeyEvent.KEYCODE_MEDIA_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_HEADSETHOOK:
            case KeyEvent.KEYCODE_MEDIA_STOP:
            case KeyEvent.KEYCODE_MEDIA_NEXT:
            case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
                return true;
            default:
                return false;
        }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (!isHandledMediaKey(keyCode)) {
            return super.onKeyDown(keyCode, event);
        }
        if (event != null && event.getRepeatCount() == 0) {
            switch (keyCode) {
                case KeyEvent.KEYCODE_MEDIA_PLAY:
                    resumePlaybackFromMediaControl();
                    break;
                case KeyEvent.KEYCODE_MEDIA_PAUSE:
                case KeyEvent.KEYCODE_MEDIA_STOP:
                    pausePlaybackForAudioRouteOrControl();
                    break;
                case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
                case KeyEvent.KEYCODE_HEADSETHOOK:
                    togglePlayPause();
                    break;
                case KeyEvent.KEYCODE_MEDIA_NEXT:
                    if (!loadingEpisode) {
                        if (!nextUrl.isEmpty()) {
                            loadEpisodeInFullscreen(nextUrl);
                        } else if (hasNextFlag) {
                            finishWithAction("next");
                        }
                    }
                    break;
                case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
                    if (!loadingEpisode) {
                        if (!prevUrl.isEmpty()) {
                            loadEpisodeInFullscreen(prevUrl);
                        } else if (hasPrevFlag) {
                            finishWithAction("prev");
                        }
                    }
                    break;
                default:
                    break;
            }
        }
        return true;
    }

    @Override
    public boolean onKeyUp(int keyCode, KeyEvent event) {
        if (isHandledMediaKey(keyCode)) {
            return true;
        }
        return super.onKeyUp(keyCode, event);
    }

    private void togglePlayPause() {
        uiHandler.removeCallbacks(singleTapRunnable);
        if (mediaPlayer == null || loadingEpisode || playbackFailed) return;
        if (pauseAfterRestoreFrame) {
            cancelPendingPauseAfterRestore(true);
            return;
        }
        if (mediaPlayer.isPlaying()) {
            pendingPauseFromNoisyAudio = false;
            userInitiatedPause = true;
            mediaPlayer.pause();
            updatePlayPauseIcons(false);
            uiHandler.removeCallbacks(hideControlsRunnable);
            updateMediaSessionPlaybackState(PlaybackState.STATE_PAUSED);
        } else if (playbackEnded
            || !mediaPlayer.getVLCVout().areViewsAttached()
            || !mediaPlayer.hasMedia()
            || activePlaybackSessionGen <= 0L) {
            pendingPauseFromNoisyAudio = false;
            userInitiatedPause = false;
            if (playbackEnded) {
                playbackEnded = false;
                pendingSeekMs = 0L;
                lastKnownPositionMs = 0L;
            } else {
                pendingSeekMs = Math.max(pendingSeekMs, lastKnownPositionMs);
            }
            prepareAndPlayCurrentStream(false);
        } else {
            pendingPauseFromNoisyAudio = false;
            userInitiatedPause = false;
            requestAudioFocus();
            mediaPlayer.play();
            updatePlayPauseIcons(true);
            updateMediaSessionPlaybackState(PlaybackState.STATE_PLAYING);
            scheduleControlsAutoHide();
        }
    }

    private void toggleMute() {
        muted = !muted;
        if (!muted && audioManager != null) {
            int cur = audioManager.getStreamVolume(AudioManager.STREAM_MUSIC);
            if (cur <= 0) {
                int max = Math.max(1, audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC));
                audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, Math.max(1, max / 5), 0);
            }
        }
        if (mediaPlayer != null) {
            mediaPlayer.setVolume((muted || pauseAfterRestoreFrame) ? 0 : 100);
        }
        btnMute.setImageResource(muted ? R.drawable.ic_player_volume_off : R.drawable.ic_player_volume_on);
        scheduleControlsAutoHide();
    }

    private void seekByMs(long deltaMs, String badgeText) {
        seekByMs(deltaMs, badgeText, true, false);
    }

    private void seekByMs(long deltaMs, String badgeText, boolean refreshAutoHide) {
        seekByMs(deltaMs, badgeText, refreshAutoHide, false);
    }

    private void seekByMs(long deltaMs, String badgeText, boolean refreshAutoHide, boolean seekOnlyHud) {
        if (mediaPlayer == null) return;
        if (pauseAfterRestoreFrame) {
            cancelPendingPauseAfterRestore(false);
        }
        long total = Math.max(lastKnownDurationMs, mediaPlayer.getLength());
        long rawCurrent = mediaPlayer.getTime();
        long current = rawCurrent >= 0L ? rawCurrent : Math.max(0L, lastKnownPositionMs);
        long target = current + deltaMs;
        if (target < 0L) target = 0L;
        if (total > 0L && target > total) target = total;
        userSeekedInCurrentStream = true;
        if (!hasPlaybackStartedForStream) {
            firstTimeChangedMs = target;
        }
        long prevPos = lastKnownPositionMs;
        mediaPlayer.setTime(target);
        lastKnownPositionMs = target;
        timeCurrentView.setText(formatMs(target));
        seekBar.setProgress((int) Math.min(Integer.MAX_VALUE, target));
        onSeekCommitted(prevPos, target);

        if (gestureBadge != null) gestureBadge.setVisibility(View.GONE);
        if (seekBadge != null) {
            seekBadge.setText(badgeText);
            seekBadge.setVisibility(View.VISIBLE);
        }
        if (seekOnlyHud) {
            uiHandler.removeCallbacks(hideSeekBadgeRunnable);
            uiHandler.removeCallbacks(resetSeekStreakRunnable);
            showSeekOnlyHud();
        } else {
            if (seekBadge != null) {
                uiHandler.removeCallbacks(hideSeekBadgeRunnable);
                uiHandler.postDelayed(hideSeekBadgeRunnable, 700L);
            }
            if (refreshAutoHide || controlsVisible) {
                scheduleControlsAutoHide();
            }
        }
    }

    private void showSeekOnlyHud() {
        uiHandler.removeCallbacks(hideControlsRunnable);
        uiHandler.removeCallbacks(hideSeekOnlyHudRunnable);
        controlsVisible = false;
        seekOnlyHudActive = true;
        applyHudVisibility();
        uiHandler.postDelayed(hideSeekOnlyHudRunnable, SEEK_STREAK_TIMEOUT_MS);
    }

    private void applyHudVisibility() {
        if (controlsVisible) {
            controlsOverlay.setVisibility(View.VISIBLE);
            if (topBar != null) topBar.setVisibility(View.VISIBLE);
            if (bottomBar != null) {
                bottomBar.setVisibility(View.VISIBLE);
                bottomBar.setClickable(true);
            }
            if (bottomControlsRow != null) bottomControlsRow.setVisibility(View.VISIBLE);
            if (loadingContainer.getVisibility() != View.VISIBLE && !playbackFailed) {
                btnPlayCenter.setVisibility(View.VISIBLE);
            } else {
                btnPlayCenter.setVisibility(View.GONE);
            }
        } else if (seekOnlyHudActive) {
            controlsOverlay.setVisibility(View.VISIBLE);
            if (topBar != null) topBar.setVisibility(View.GONE);
            if (bottomBar != null) {
                bottomBar.setVisibility(View.VISIBLE);
                bottomBar.setClickable(false);
            }
            if (bottomControlsRow != null) bottomControlsRow.setVisibility(View.GONE);
            btnPlayCenter.setVisibility(View.GONE);
        } else {
            controlsOverlay.setVisibility(View.GONE);
            btnPlayCenter.setVisibility(View.GONE);
            if (topBar != null) topBar.setVisibility(View.VISIBLE);
            if (bottomBar != null) {
                bottomBar.setVisibility(View.VISIBLE);
                bottomBar.setClickable(true);
            }
            if (bottomControlsRow != null) bottomControlsRow.setVisibility(View.VISIBLE);
        }
    }

    private void setControlsVisible(boolean visible) {
        controlsVisible = visible;
        seekOnlyHudActive = false;
        uiHandler.removeCallbacks(hideSeekOnlyHudRunnable);
        if (visible) {
            seekStreakCount = 0;
            seekStreakSide = 0;
            uiHandler.removeCallbacks(resetSeekStreakRunnable);
        }
        applyHudVisibility();
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
        if (mediaPlayer != null && mediaPlayer.isPlaying() && !pauseAfterRestoreFrame && !userScrubbing && !loadingEpisode) {
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
            boolean isWatched = watchedUrls.contains(normalizeUrlKey(ep.url))
                || watchedUrls.contains(canonicalProgressKey(ep.url));

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
        loadEpisodeInFullscreen(rawTargetUrl, true);
    }

    private void loadEpisodeInFullscreen(String rawTargetUrl, boolean saveOutgoingProgress) {
        if (rawTargetUrl != null && rawTargetUrl.trim().toLowerCase(Locale.ROOT).startsWith("anisync://")) {
            if (saveOutgoingProgress) {
                captureCurrentPositionMs();
                saveCurrentEpisodeProgress(playbackEnded);
            }
            episodeUrl = rawTargetUrl.trim();
            for (TopAnimesEpisodeResolver.EpisodeLink ep : seriesEpisodes) {
                if (isSameEpisodeUrl(ep.url, episodeUrl) && ep.title != null && !ep.title.isEmpty()) {
                    episodeTitle = formatEpisodeTitleWithSeries(seriesTitle, ep.title);
                    break;
                }
            }
            recordVisitedEpisode(episodeUrl, episodeTitle, 0L, 0L, isEpisodeCompletedInPref(episodeUrl));
            finishWithAction("select", false);
            return;
        }

        String normalizedTarget = TopAnimesEpisodeResolver.normalizeSupportedEpisodeUrl(rawTargetUrl);
        if (normalizedTarget.isEmpty()) return;

        // Flush progress of the outgoing episode before resetting state
        if (saveOutgoingProgress) {
            captureCurrentPositionMs();
            saveCurrentEpisodeProgress(playbackEnded);
        }

        final int gen = episodeLoadGen.incrementAndGet();
        activePlaybackSessionGen = -1L;
        endReachedHandledSessionGen = -1L;
        uiHandler.removeCallbacks(loadWatchdogRunnable);
        uiHandler.removeCallbacks(pauseAfterRestoreRunnable);
        uiHandler.removeCallbacks(pauseAfterRestoreFallbackRunnable);
        pauseAfterRestoreFrame = false;
        pauseAfterRestoreScheduled = false;
        restoreFrameTimeReached = false;
        restoreFrameTargetMs = 0L;
        playbackEnded = false;
        localSubtitleUri = null;
        userDisabledSubtitles = false;
        preferredAudioTrackId = -1;
        clearCachedSubtitles();
        failedServerNumes.clear();
        synchronized (embedProbeCache) {
            embedProbeCache.clear();
        }
        currentServerRetryCount = 0;
        retriedFreshServerEmbeds = false;
        hasPlaybackStartedForStream = false;
        hasActiveVout = false;
        firstTimeChangedMs = -1L;
        playbackTimeAdvanceCount = 0;
        userSeekedInCurrentStream = false;
        streamPreparedWallMs = 0L;
        loadingEpisode = true;
        playbackFailed = false;
        pendingSeekMs = getSavedResumePositionMs(normalizedTarget);
        lastKnownPositionMs = pendingSeekMs;
        lastKnownDurationMs = 0L;
        hasProxyBufferTelemetry = false;
        seekBar.setProgress(0);
        seekBar.setMax(100);
        resetBufferProgress(pendingSeekMs);
        timeCurrentView.setText(formatMs(pendingSeekMs));
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
        episodeTitle = formatEpisodeTitleWithSeries(seriesTitle, episodeTitle);
        episodeUrl = normalizedTarget;
        recordVisitedEpisode(episodeUrl, episodeTitle, pendingSeekMs, 0L, isEpisodeCompletedInPref(episodeUrl));
        persistPendingSessionPref("closed");
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
                    if (!resolved.title.isEmpty()) {
                        episodeTitle = formatEpisodeTitleWithSeries(seriesTitle, resolved.title);
                    }
                    if (!resolved.seriesUrl.isEmpty()) seriesUrl = resolved.seriesUrl;
                    if (!resolved.selectedServerNume.isEmpty()) selectedServerNume = resolved.selectedServerNume;
                    referer = resolved.referer;
                    preferDirect = resolved.preferDirect;
                    triedAlternateTransport = false;
                    retriedFreshServerEmbeds = false;
                    useProxyForAttempt = !preferDirect && !proxyBaseUrl.isEmpty();

                    long savedForResolved = getSavedResumePositionMs(episodeUrl);
                    if (savedForResolved > 0L) {
                        pendingSeekMs = savedForResolved;
                        lastKnownPositionMs = savedForResolved;
                    }

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

                    boolean alreadyCompleted = isEpisodeCompletedInPref(episodeUrl);
                    recordVisitedEpisode(episodeUrl, episodeTitle, pendingSeekMs, 0L, alreadyCompleted);
                    persistPendingSessionPref("closed");

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

            addSettingsRow("Legendas", getActiveSubtitleSummary(), false, v -> renderSettingsTab("subs"));
            addSettingsRow("Áudio", getActiveAudioSummary(), false, v -> renderSettingsTab("audio"));
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
                            triedAlternateTransport = false;
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
                    saveVideoScalePreference(this, scaleIndexToId(idx));
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
            settingsHeaderTitle.setText("Legendas");
            if (mediaPlayer != null) {
                MediaPlayer.TrackDescription[] spuTracks = mediaPlayer.getSpuTracks();
                if (spuTracks != null && spuTracks.length > 0) {
                    int activeSpu = mediaPlayer.getSpuTrack();
                    Map<Integer, String> spuLabels = buildTrackLabels(spuTracks, false);
                    for (MediaPlayer.TrackDescription t : spuTracks) {
                        boolean active = t.id == activeSpu;
                        String name = spuLabels.get(t.id);
                        addSettingsRow(name, active ? "✓" : "", active, v -> {
                            userDisabledSubtitles = (t.id == -1);
                            if (mediaPlayer != null) mediaPlayer.setSpuTrack(t.id);
                            closeSettingsMenu();
                        });
                    }
                } else {
                    addSettingsRow("Nenhuma faixa de legenda", "", false, v -> {});
                }
            } else {
                addSettingsRow("Nenhuma faixa de legenda", "", false, v -> {});
            }
            addSettingsRow("Carregar legenda local (.srt / .vtt / .ass)", "", false, v -> {
                closeSettingsMenu();
                subtitleFilePicker.launch(new String[] { "*/*" });
            });
            return;
        }

        if ("audio".equals(tab)) {
            settingsHeaderTitle.setText("Áudio");
            if (mediaPlayer != null) {
                MediaPlayer.TrackDescription[] audioTracks = mediaPlayer.getAudioTracks();
                if (audioTracks != null && audioTracks.length > 0) {
                    int activeAudio = mediaPlayer.getAudioTrack();
                    Map<Integer, String> audioLabels = buildTrackLabels(audioTracks, true);
                    for (MediaPlayer.TrackDescription t : audioTracks) {
                        boolean active = t.id == activeAudio;
                        String name = audioLabels.get(t.id);
                        addSettingsRow(name, active ? "✓" : "", active, v -> {
                            preferredAudioTrackId = t.id;
                            if (mediaPlayer != null) mediaPlayer.setAudioTrack(t.id);
                            closeSettingsMenu();
                        });
                    }
                } else {
                    addSettingsRow("Faixa padrão", "✓", true, v -> closeSettingsMenu());
                }
            } else {
                addSettingsRow("Nenhuma faixa de áudio", "", false, v -> {});
            }
        }
    }

    private String getActiveSubtitleSummary() {
        if (mediaPlayer == null) return "Desativada";
        int activeSpu = mediaPlayer.getSpuTrack();
        if (activeSpu == -1) return "Desativada";
        MediaPlayer.TrackDescription[] tracks = mediaPlayer.getSpuTracks();
        String name = buildTrackLabels(tracks, false).get(activeSpu);
        return name != null && !name.isEmpty() ? name : "Desativada";
    }

    private String getActiveAudioSummary() {
        if (mediaPlayer == null) return "Padrão";
        int activeAudio = mediaPlayer.getAudioTrack();
        if (activeAudio == -1) return "Mudo";
        MediaPlayer.TrackDescription[] tracks = mediaPlayer.getAudioTracks();
        String name = buildTrackLabels(tracks, true).get(activeAudio);
        return name != null && !name.isEmpty() ? name : "Padrão";
    }

    private static final Locale PT_BR = new Locale("pt", "BR");
    private static final java.util.regex.Pattern VLC_TRACK_NAME =
        java.util.regex.Pattern.compile("^(.*?)(?:\\s*-\\s*\\[([^\\]]+)\\])?$");
    private static final java.util.regex.Pattern VLC_GENERIC_TRACK =
        java.util.regex.Pattern.compile("^(?:track|faixa|pista)\\s*(\\d+)$", java.util.regex.Pattern.CASE_INSENSITIVE);
    private static final java.util.regex.Pattern LANG_CODE =
        java.util.regex.Pattern.compile("^[a-z]{2,3}(?:[-_][a-z0-9]{2,4})?$", java.util.regex.Pattern.CASE_INSENSITIVE);
    private static final Map<String, String> LANG_ALIASES = new HashMap<>();
    static {
        String[][] aliases = {
            // ISO 639-2 (B/T) -> ISO 639-1
            { "por", "pt" }, { "pob", "pt-BR" }, { "pt_br", "pt-BR" }, { "ptbr", "pt-BR" },
            { "eng", "en" }, { "jpn", "ja" }, { "jap", "ja" }, { "spa", "es" }, { "fre", "fr" },
            { "fra", "fr" }, { "ger", "de" }, { "deu", "de" }, { "ita", "it" }, { "rus", "ru" },
            { "chi", "zh" }, { "zho", "zh" }, { "kor", "ko" }, { "ara", "ar" }, { "hin", "hi" },
            { "tha", "th" }, { "vie", "vi" }, { "ind", "id" }, { "may", "ms" }, { "msa", "ms" },
            { "pol", "pl" }, { "tur", "tr" }, { "dut", "nl" }, { "nld", "nl" }, { "swe", "sv" },
            { "heb", "he" }, { "gre", "el" }, { "ell", "el" }, { "ukr", "uk" }, { "cze", "cs" },
            { "ces", "cs" }, { "hun", "hu" }, { "rum", "ro" }, { "ron", "ro" }, { "fin", "fi" },
            { "dan", "da" }, { "nor", "no" }, { "nob", "nb" }, { "cat", "ca" }, { "fil", "fil" },
            { "tgl", "tl" },
            // English names produced by LibVLC's LanguageGetName()
            { "portuguese", "pt" }, { "brazilian portuguese", "pt-BR" }, { "portuguese (brazil)", "pt-BR" },
            { "english", "en" }, { "japanese", "ja" }, { "spanish", "es" },
            { "spanish; castilian", "es" }, { "castilian", "es" }, { "french", "fr" }, { "german", "de" },
            { "italian", "it" }, { "russian", "ru" }, { "chinese", "zh" }, { "korean", "ko" },
            { "arabic", "ar" }, { "hindi", "hi" }, { "thai", "th" }, { "vietnamese", "vi" },
            { "indonesian", "id" }, { "malay", "ms" }, { "polish", "pl" }, { "turkish", "tr" },
            { "dutch", "nl" }, { "dutch; flemish", "nl" }, { "swedish", "sv" }, { "hebrew", "he" },
            { "greek", "el" }, { "greek, modern (1453-)", "el" }, { "ukrainian", "uk" },
            { "czech", "cs" }, { "hungarian", "hu" }, { "romanian", "ro" }, { "finnish", "fi" },
            { "danish", "da" }, { "norwegian", "no" }, { "catalan", "ca" }, { "filipino", "fil" },
            { "tagalog", "tl" },
        };
        for (String[] a : aliases) LANG_ALIASES.put(a[0], a[1]);
        for (String c : new String[] { "pt", "en", "ja", "es", "fr", "de", "it", "ru", "zh", "ko", "ar" }) {
            LANG_ALIASES.put(c, c);
        }
    }

    private static final java.util.regex.Pattern LANG_REGION_CODE =
        java.util.regex.Pattern.compile("^[a-z]{2,3}[-_](?:[a-z]{2}|\\d{3})$", java.util.regex.Pattern.CASE_INSENSITIVE);

    static String languageDisplayName(String raw) {
        return languageDisplayName(raw, false);
    }

    /**
     * Converts a language code ("por", "pt-BR", "jpn") or LibVLC English language name
     * ("Japanese") into a Portuguese display name ("Japonês", "Português (Brasil)").
     * Returns null when the value is empty, undetermined or not recognised as a language.
     * In strict mode (free text such as track titles / scraper labels) only well-known codes and
     * names are accepted, so strings like "SDH" or "CC" are not mistaken for languages.
     */
    static String languageDisplayName(String raw, boolean strict) {
        if (raw == null) return null;
        String value = raw.trim();
        if (value.isEmpty()) return null;
        String key = value.toLowerCase(Locale.ROOT);
        if (key.equals("und") || key.equals("unknown") || key.equals("mis") || key.equals("zxx")
            || key.equals("mul") || key.equals("qaa")) {
            return null;
        }
        String tag = LANG_ALIASES.get(key);
        if (tag == null) {
            if (!LANG_CODE.matcher(value).matches()) return null;
            String[] parts = key.split("[-_]");
            if (strict && (!LANG_REGION_CODE.matcher(value).matches() || !LANG_ALIASES.containsKey(parts[0]))) {
                return null;
            }
            String base = LANG_ALIASES.containsKey(parts[0]) ? LANG_ALIASES.get(parts[0]) : parts[0];
            tag = parts.length > 1 ? base + "-" + parts[1].toUpperCase(Locale.ROOT) : base;
        }
        Locale locale = Locale.forLanguageTag(tag);
        String lang = locale.getDisplayLanguage(PT_BR);
        if (lang == null || lang.isEmpty() || lang.equalsIgnoreCase(locale.getLanguage())) {
            return null;
        }
        String display = lang;
        String country = locale.getDisplayCountry(PT_BR);
        if (country != null && !country.isEmpty()) display += " (" + country + ")";
        return display.substring(0, 1).toUpperCase(PT_BR) + display.substring(1);
    }

    /** Builds user-facing labels (keyed by ES id) for every track in the list. */
    private Map<Integer, String> buildTrackLabels(MediaPlayer.TrackDescription[] tracks, boolean audio) {
        Map<Integer, String> labels = new LinkedHashMap<>();
        if (tracks == null) return labels;

        // LibVLC media tracks carry the raw language code/description for embedded streams.
        Map<Integer, IMedia.Track> mediaTracks = new HashMap<>();
        IMedia media = mediaPlayer != null ? mediaPlayer.getMedia() : null;
        if (media != null) {
            try {
                int count = media.getTrackCount();
                for (int i = 0; i < count; i++) {
                    IMedia.Track mt = media.getTrack(i);
                    if (mt != null) mediaTracks.put(mt.id, mt);
                }
            } catch (Exception e) {
                Log.w(TAG, "Failed reading media tracks", e);
            } finally {
                media.release();
            }
        }

        int position = 0;
        Map<String, Integer> seen = new HashMap<>();
        for (MediaPlayer.TrackDescription t : tracks) {
            if (t == null) continue;
            if (t.id == -1) {
                labels.put(t.id, audio ? "Desativado (Mudo)" : "Desativada");
                continue;
            }
            position++;
            String label = audio ? null : slaveSubtitleLabelsById.get(t.id);
            if (label != null) {
                String asLanguage = languageDisplayName(label, true);
                if (asLanguage != null) label = asLanguage;
            } else {
                label = describeEmbeddedTrack(t, mediaTracks.get(t.id), position, audio);
            }
            Integer dupCount = seen.get(label);
            if (dupCount != null) {
                seen.put(label, dupCount + 1);
                label = label + " (" + (dupCount + 1) + ")";
            } else {
                seen.put(label, 1);
            }
            labels.put(t.id, label);
        }
        return labels;
    }

    private static String describeEmbeddedTrack(
        MediaPlayer.TrackDescription track,
        IMedia.Track mediaTrack,
        int position,
        boolean audio
    ) {
        String rawName = track.name != null ? track.name.trim() : "";
        String description = "";
        String languageFromName = null;
        int trackNumber = position;
        java.util.regex.Matcher m = VLC_TRACK_NAME.matcher(rawName);
        if (m.matches()) {
            description = m.group(1) != null ? m.group(1).trim() : "";
            languageFromName = m.group(2);
        }
        java.util.regex.Matcher generic = VLC_GENERIC_TRACK.matcher(description);
        if (generic.matches()) {
            try {
                trackNumber = Integer.parseInt(generic.group(1));
            } catch (NumberFormatException ignored) {
            }
            description = "";
        }
        if ("disable".equalsIgnoreCase(description)) description = "";

        String language = null;
        if (mediaTrack != null) {
            language = languageDisplayName(mediaTrack.language);
            if (description.isEmpty() && mediaTrack.description != null) {
                description = mediaTrack.description.trim();
            }
        }
        if (language == null) language = languageDisplayName(languageFromName);
        if (language == null && !description.isEmpty()) {
            // Some muxers store the language only in the track title (e.g. "Portuguese", "jpn").
            String descAsLanguage = languageDisplayName(description, true);
            if (descAsLanguage != null) {
                language = descAsLanguage;
                description = "";
            }
        }

        if (language != null) {
            if (description.isEmpty() || description.equalsIgnoreCase(language)) return language;
            return language + " — " + description;
        }
        if (!description.isEmpty()) return description;
        return (audio ? "Faixa " : "Legenda ") + trackNumber + " · idioma não informado";
    }

    private void switchServerInFullscreen(TopAnimesEpisodeResolver.ServerOption opt) {
        final int gen = episodeLoadGen.incrementAndGet();
        final long resumePos = Math.max(0L, captureCurrentPositionMs());
        activePlaybackSessionGen = -1L;
        uiHandler.removeCallbacks(loadWatchdogRunnable);
        uiHandler.removeCallbacks(pauseAfterRestoreRunnable);
        uiHandler.removeCallbacks(pauseAfterRestoreFallbackRunnable);
        pauseAfterRestoreFrame = false;
        pauseAfterRestoreScheduled = false;
        restoreFrameTimeReached = false;
        restoreFrameTargetMs = 0L;
        preferredAudioTrackId = -1;
        playbackEnded = false;
        failedServerNumes.remove(opt.nume);
        currentServerRetryCount = 0;
        hasPlaybackStartedForStream = false;
        hasActiveVout = false;
        firstTimeChangedMs = -1L;
        playbackTimeAdvanceCount = 0;
        userSeekedInCurrentStream = false;
        streamPreparedWallMs = 0L;
        playbackFailed = false;
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
                triedAlternateTransport = false;
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
            val.setMaxLines(1);
            val.setEllipsize(TextUtils.TruncateAt.END);
            val.setMaxWidth(dp(120));
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
        if (mediaPlayer != null && mediaPlayer.getVLCVout().areViewsAttached()) {
            mediaPlayer.setVideoScale(SCALE_OPTIONS[currentScaleIdx]);
            mediaPlayer.updateVideoSurfaces();
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            enterImmersiveMode();
        }
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
        audioFocusChangeListener = focusChange -> {
            if (focusChange == AudioManager.AUDIOFOCUS_LOSS
                || focusChange == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
                uiHandler.post(() -> pausePlaybackForAudioRouteOrControl());
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
                .setOnAudioFocusChangeListener(audioFocusChangeListener)
                .build();
        }
        requestAudioFocus();
    }

    @SuppressWarnings("deprecation")
    private void setupMediaSession() {
        if (mediaSession != null) return;
        try {
            mediaSession = new MediaSession(this, TAG);
            mediaSession.setFlags(
                MediaSession.FLAG_HANDLES_MEDIA_BUTTONS
                    | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS
            );
            mediaSession.setCallback(new MediaSession.Callback() {
                @Override
                public void onPlay() {
                    uiHandler.post(() -> resumePlaybackFromMediaControl());
                }

                @Override
                public void onPause() {
                    uiHandler.post(() -> pausePlaybackForAudioRouteOrControl());
                }

                @Override
                public void onStop() {
                    uiHandler.post(() -> pausePlaybackForAudioRouteOrControl());
                }

                @Override
                public void onSeekTo(long pos) {
                    uiHandler.post(() -> {
                        if (mediaPlayer == null || loadingEpisode || playbackFailed) return;
                        long target = Math.max(0L, pos);
                        long total = Math.max(lastKnownDurationMs, mediaPlayer.getLength());
                        if (total > 0L && target > total) target = total;
                        if (pauseAfterRestoreFrame) {
                            cancelPendingPauseAfterRestore(false);
                        }
                        userSeekedInCurrentStream = true;
                        if (!hasPlaybackStartedForStream) {
                            firstTimeChangedMs = target;
                        }
                        long prevPos = lastKnownPositionMs;
                        mediaPlayer.setTime(target);
                        lastKnownPositionMs = target;
                        if (!userScrubbing) {
                            seekBar.setProgress((int) Math.min(Integer.MAX_VALUE, target));
                            timeCurrentView.setText(formatMs(target));
                        }
                        onSeekCommitted(prevPos, target);
                        updateMediaSessionPlaybackState(
                            mediaPlayer.isPlaying() ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED
                        );
                    });
                }

                @Override
                public void onFastForward() {
                    uiHandler.post(() -> seekByMs(5000L, "+5s"));
                }

                @Override
                public void onRewind() {
                    uiHandler.post(() -> seekByMs(-5000L, "-5s"));
                }

                @Override
                public void onSkipToNext() {
                    uiHandler.post(() -> {
                        if (loadingEpisode) return;
                        if (!nextUrl.isEmpty()) {
                            loadEpisodeInFullscreen(nextUrl);
                        } else if (hasNextFlag) {
                            finishWithAction("next");
                        }
                    });
                }

                @Override
                public void onSkipToPrevious() {
                    uiHandler.post(() -> {
                        if (loadingEpisode) return;
                        if (!prevUrl.isEmpty()) {
                            loadEpisodeInFullscreen(prevUrl);
                        } else if (hasPrevFlag) {
                            finishWithAction("prev");
                        }
                    });
                }
            }, uiHandler);
            updateMediaSessionMetadata();
            updateMediaSessionPlaybackState(PlaybackState.STATE_BUFFERING);
            mediaSession.setActive(true);
        } catch (Exception e) {
            Log.w(TAG, "Failed initializing MediaSession", e);
        }
    }

    private void updateMediaSessionPlaybackState(int state) {
        if (mediaSession == null) return;
        try {
            long pos = Math.max(0L, lastKnownPositionMs);
            if (mediaPlayer != null && hasPlaybackStartedForStream && !pauseAfterRestoreFrame) {
                long cur = mediaPlayer.getTime();
                if (cur >= 0L) pos = cur;
            }
            float speed = (state == PlaybackState.STATE_PLAYING)
                ? (holdSpeedActive ? 2.0f : currentSpeed)
                : 0f;
            PlaybackState playbackState = new PlaybackState.Builder()
                .setActions(MEDIA_SESSION_ACTIONS)
                .setState(state, pos, speed)
                .build();
            mediaSession.setPlaybackState(playbackState);
        } catch (Exception ignored) {
        }
    }

    private void updateMediaSessionMetadata() {
        if (mediaSession == null) return;
        try {
            MediaMetadata.Builder builder = new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, episodeTitle != null ? episodeTitle : "Episódio");
            if (seriesTitle != null && !seriesTitle.isEmpty()) {
                builder.putString(MediaMetadata.METADATA_KEY_ARTIST, seriesTitle);
            }
            if (lastKnownDurationMs > 0L) {
                builder.putLong(MediaMetadata.METADATA_KEY_DURATION, lastKnownDurationMs);
            }
            mediaSession.setMetadata(builder.build());
        } catch (Exception ignored) {
        }
    }

    private void releaseMediaSession() {
        if (mediaSession != null) {
            try {
                mediaSession.setActive(false);
                mediaSession.setCallback(null);
                mediaSession.release();
            } catch (Exception ignored) {
            }
            mediaSession = null;
        }
    }

    private void registerBecomingNoisyReceiver() {
        if (becomingNoisyReceiverRegistered) return;
        try {
            IntentFilter filter = new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                registerReceiver(becomingNoisyReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
            } else {
                registerReceiver(becomingNoisyReceiver, filter);
            }
            becomingNoisyReceiverRegistered = true;
        } catch (Exception e) {
            Log.w(TAG, "Failed registering becoming noisy receiver", e);
        }
    }

    private void unregisterBecomingNoisyReceiver() {
        if (!becomingNoisyReceiverRegistered) return;
        becomingNoisyReceiverRegistered = false;
        try {
            unregisterReceiver(becomingNoisyReceiver);
        } catch (Exception ignored) {
        }
    }

    private void requestAudioFocus() {
        if (audioManager == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (audioFocusRequest != null) {
                audioManager.requestAudioFocus(audioFocusRequest);
            }
        } else if (audioFocusChangeListener != null) {
            audioManager.requestAudioFocus(
                audioFocusChangeListener,
                AudioManager.STREAM_MUSIC,
                AudioManager.AUDIOFOCUS_GAIN
            );
        }
    }

    private void finishWithAction(String action) {
        finishWithAction(action, true);
    }

    private void finishWithAction(String action, boolean saveOutgoingProgress) {
        if (saveOutgoingProgress) {
            captureCurrentPositionMs();
            saveCurrentEpisodeProgress(playbackEnded);
        }
        persistPendingSessionPref(action);
        Intent result = buildResultIntent(action);
        setResult(Activity.RESULT_OK, result);
        finish();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        long pos = captureCurrentPositionMs();
        if (pos > 0L) {
            outState.putLong(STATE_POSITION_MS, pos);
        }
        if (lastKnownDurationMs > 0L) {
            outState.putLong(STATE_DURATION_MS, lastKnownDurationMs);
        }
        outState.putInt(STATE_STREAM_INDEX, currentStreamIdx);
        outState.putString(STATE_EPISODE_URL, episodeUrl);
        outState.putString(STATE_EPISODE_TITLE, episodeTitle);
        outState.putString(STATE_SERIES_URL, seriesUrl);
        outState.putString(STATE_SERIES_TITLE, seriesTitle);
        outState.putString(STATE_POSTER, posterUrl);
        outState.putBoolean(STATE_IS_MOVIE, isMovieFlag);
        outState.putString(STATE_SELECTED_SERVER_NUME, selectedServerNume);
        outState.putString(STATE_REFERER, referer);
        outState.putBoolean(STATE_PREFER_DIRECT, preferDirect);
        outState.putString(STATE_PREV_URL, prevUrl);
        outState.putString(STATE_NEXT_URL, nextUrl);
        outState.putBoolean(STATE_HAS_PREV, hasPrevFlag);
        outState.putBoolean(STATE_HAS_NEXT, hasNextFlag);
        outState.putString(STATE_STREAMS_JSON, serializeStreamsJson());
        outState.putString(STATE_SUBTITLES_JSON, serializeSubtitlesJson());
        outState.putString(STATE_EPISODES_JSON, serializeEpisodesJson());
        outState.putString(STATE_OPTIONS_JSON, serializeOptionsJson());
        outState.putString(STATE_VISITED_EPISODES_JSON, buildVisitedEpisodesJsonArray().toString());
        outState.putBoolean(STATE_PLAYBACK_ENDED, playbackEnded);
        outState.putBoolean(STATE_USER_INITIATED_PAUSE, userInitiatedPause);
    }

    @Override
    protected void onStart() {
        super.onStart();
        isActivityStarted = true;
        registerBecomingNoisyReceiver();
        if (mediaSession != null) {
            mediaSession.setActive(true);
        }
        attachVideoViewsIfNeeded();
        if (shouldStartPlaybackOnStart || surfacesWereDestroyed) {
            boolean autoResume = shouldStartPlaybackOnStart
                ? resumePlayingAfterRestore
                : (wasPlayingBeforePause || wasLoadingBeforePause);
            shouldStartPlaybackOnStart = false;
            surfacesWereDestroyed = false;
            wasPlayingBeforePause = false;
            wasLoadingBeforePause = false;
            restorePlaybackAfterForeground(autoResume);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        isActivityResumed = true;
        enterImmersiveMode();
        if (mediaSession != null) {
            mediaSession.setActive(true);
        }
        attachVideoViewsIfNeeded();

        if (surfacesWereDestroyed && !loadingEpisode && !playbackFailed && !playbackEnded) {
            boolean autoResume = wasPlayingBeforePause || wasLoadingBeforePause;
            surfacesWereDestroyed = false;
            wasPlayingBeforePause = false;
            wasLoadingBeforePause = false;
            pausedMidRestore = false;
            restorePlaybackAfterForeground(autoResume);
            return;
        }

        if (pausedMidRestore && !loadingEpisode && !playbackFailed && !playbackEnded) {
            pausedMidRestore = false;
            if (!hasActiveVout) {
                restorePlaybackAfterForeground(false);
                return;
            }
        }

        if (wasPlayingBeforePause && !loadingEpisode && !playbackFailed && !playbackEnded) {
            wasPlayingBeforePause = false;
            wasLoadingBeforePause = false;
            if (mediaPlayer != null) {
                if (!hasPlaybackStartedForStream && activePlaybackSessionGen > 0L) {
                    uiHandler.removeCallbacks(loadWatchdogRunnable);
                    uiHandler.postDelayed(loadWatchdogRunnable, LOAD_WATCHDOG_TIMEOUT_MS);
                }
                if (!mediaPlayer.isPlaying() && mediaPlayer.hasMedia() && activePlaybackSessionGen > 0L) {
                    requestAudioFocus();
                    mediaPlayer.play();
                    scheduleControlsAutoHide();
                }
            }
        } else if (wasLoadingBeforePause && !hasPlaybackStartedForStream && activePlaybackSessionGen > 0L
            && !loadingEpisode && !playbackFailed && !playbackEnded) {
            wasLoadingBeforePause = false;
            uiHandler.removeCallbacks(loadWatchdogRunnable);
            uiHandler.postDelayed(loadWatchdogRunnable, LOAD_WATCHDOG_TIMEOUT_MS);
        }
    }

    @Override
    protected void onPause() {
        isActivityResumed = false;
        uiHandler.removeCallbacks(loadWatchdogRunnable);
        uiHandler.removeCallbacks(holdSpeedRunnable);
        uiHandler.removeCallbacks(singleTapRunnable);
        uiHandler.removeCallbacks(hideSeekOnlyHudRunnable);
        uiHandler.removeCallbacks(pauseAfterRestoreRunnable);
        uiHandler.removeCallbacks(pauseAfterRestoreFallbackRunnable);

        if (seekOnlyHudActive) {
            seekOnlyHudActive = false;
            seekStreakCount = 0;
            seekStreakSide = 0;
            if (seekBadge != null) seekBadge.setVisibility(View.GONE);
            applyHudVisibility();
        }
        if (holdSpeedActive) {
            holdSpeedActive = false;
            if (holdSpeedBadge != null) holdSpeedBadge.setVisibility(View.GONE);
            if (mediaPlayer != null) {
                mediaPlayer.setRate(currentSpeed);
            }
        }
        gestureMode = GESTURE_NONE;

        boolean wasRestoringPausedFrame = pauseAfterRestoreFrame;
        boolean playingNow = !wasRestoringPausedFrame
            && ((mediaPlayer != null && mediaPlayer.isPlaying())
                || (!userInitiatedPause && hasPlaybackStartedForStream && !playbackEnded && !playbackFailed));
        boolean loadingNow = !wasRestoringPausedFrame
            && !hasPlaybackStartedForStream
            && activePlaybackSessionGen > 0L
            && !loadingEpisode
            && !playbackFailed
            && !playbackEnded;

        wasPlayingBeforePause = playingNow;
        wasLoadingBeforePause = loadingNow;

        captureCurrentPositionMs();
        saveCurrentEpisodeProgress(playbackEnded);
        persistPendingSessionPref("closed");

        pausedMidRestore = wasRestoringPausedFrame;
        pauseAfterRestoreFrame = false;
        pauseAfterRestoreScheduled = false;
        restoreFrameTimeReached = false;
        restoreFrameTargetMs = 0L;

        if (mediaPlayer != null && mediaPlayer.isPlaying()) {
            mediaPlayer.pause();
        }
        if (wasRestoringPausedFrame && mediaPlayer != null) {
            mediaPlayer.setVolume(muted ? 0 : 100);
        }
        updateMediaSessionPlaybackState(PlaybackState.STATE_PAUSED);
        super.onPause();
    }

    @Override
    protected void onStop() {
        isActivityStarted = false;
        isActivityResumed = false;
        unregisterBecomingNoisyReceiver();
        updateMediaSessionPlaybackState(PlaybackState.STATE_PAUSED);
        if (mediaSession != null) {
            mediaSession.setActive(false);
        }
        uiHandler.removeCallbacks(loadWatchdogRunnable);
        uiHandler.removeCallbacks(pauseAfterRestoreRunnable);
        uiHandler.removeCallbacks(pauseAfterRestoreFallbackRunnable);
        pauseAfterRestoreFrame = false;
        pauseAfterRestoreScheduled = false;
        restoreFrameTimeReached = false;
        restoreFrameTargetMs = 0L;

        captureCurrentPositionMs();
        saveCurrentEpisodeProgress(playbackEnded);
        persistPendingSessionPref("closed");

        if (!isFinishing() && !loadingEpisode && !playbackFailed && !playbackEnded && !streams.isEmpty()) {
            shouldStartPlaybackOnStart = true;
            resumePlayingAfterRestore = wasPlayingBeforePause
                || wasLoadingBeforePause
                || (resumePlayingAfterRestore && !userInitiatedPause);
        }

        activePlaybackSessionGen = -1L;
        hasActiveVout = false;

        if (mediaPlayer != null) {
            isStoppingOrDetaching = true;
            try {
                mediaPlayer.stop();
                mediaPlayer.detachViews();
            } catch (Exception ignored) {
            } finally {
                isStoppingOrDetaching = false;
            }
        }
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        LocalProxyPlugin.clearBufferProgressListener(activeBufferSessionId);
        activeBufferSessionId = 0L;
        isActivityStarted = false;
        isActivityResumed = false;
        unregisterBecomingNoisyReceiver();
        releaseMediaSession();
        uiHandler.removeCallbacksAndMessages(null);
        bgExecutor.shutdownNow();
        if (mediaPlayer != null) {
            isStoppingOrDetaching = true;
            try {
                mediaPlayer.getVLCVout().removeCallback(voutCallback);
                mediaPlayer.stop();
                mediaPlayer.detachViews();
                mediaPlayer.release();
            } catch (Exception ignored) {
            } finally {
                isStoppingOrDetaching = false;
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
        if (audioManager != null) {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && audioFocusRequest != null) {
                    audioManager.abandonAudioFocusRequest(audioFocusRequest);
                } else if (audioFocusChangeListener != null) {
                    audioManager.abandonAudioFocus(audioFocusChangeListener);
                }
            } catch (Exception ignored) {
            }
        }
        clearCachedSubtitles();
        super.onDestroy();
    }

    private void applyPendingSeekIfReady() {
        if (pendingSeekMs <= 0L || mediaPlayer == null || !mediaPlayer.isSeekable()) return;
        long target = pendingSeekMs;
        long total = Math.max(lastKnownDurationMs, mediaPlayer.getLength());
        if (total > 2000L && target > total - 1500L) {
            target = Math.max(0L, total - 1500L);
        }
        pendingSeekMs = 0L;
        activeSeekTargetMs = target;
        activeSeekIssuedElapsedMs = SystemClock.elapsedRealtime();
        long prevPos = lastKnownPositionMs;
        lastKnownPositionMs = target;
        mediaPlayer.setTime(target);
        if (!userScrubbing) {
            seekBar.setProgress((int) Math.min(Integer.MAX_VALUE, target));
            timeCurrentView.setText(formatMs(target));
        }
        onSeekCommitted(prevPos, target);
    }

    private void updateSeekBarBufferedProgress() {
        if (seekBar == null) return;
        long total = lastKnownDurationMs;
        if (total <= 0L && mediaPlayer != null) {
            long len = mediaPlayer.getLength();
            if (len > 0L) {
                total = len;
                lastKnownDurationMs = len;
                seekBar.setMax((int) Math.min(Integer.MAX_VALUE, len));
                if (timeDurationView != null) {
                    timeDurationView.setText(formatMs(len));
                }
            }
        }
        if (total <= 0L) {
            seekBar.setSecondaryProgress(0);
            return;
        }
        long currentPos = Math.max(0L, lastKnownPositionMs);
        long effectiveBuffered = Math.max(currentPos, Math.min(bufferedPositionMs, total));
        seekBar.setSecondaryProgress((int) Math.min(Integer.MAX_VALUE, effectiveBuffered));
    }

    private void resetBufferProgress(long anchorMs) {
        bufferedPositionMs = Math.max(0L, anchorMs);
        pendingBufferedRangeStart = -1L;
        pendingBufferedRangeEnd = -1L;
        pendingBufferedTotalBytes = -1L;
        updateSeekBarBufferedProgress();
    }

    private void onSeekCommitted(long previousPosMs, long targetMs) {
        long clampedTarget = Math.max(0L, targetMs);
        if (clampedTarget < previousPosMs || clampedTarget > bufferedPositionMs) {
            bufferedPositionMs = clampedTarget;
        }
        pendingBufferedRangeStart = -1L;
        pendingBufferedRangeEnd = -1L;
        pendingBufferedTotalBytes = -1L;
        updateSeekBarBufferedProgress();
    }

    private void flushPendingByteRangeBufferSample() {
        if (pendingBufferedTotalBytes > 0L && pendingBufferedRangeEnd > pendingBufferedRangeStart) {
            long start = pendingBufferedRangeStart;
            long end = pendingBufferedRangeEnd;
            long total = pendingBufferedTotalBytes;
            pendingBufferedRangeStart = -1L;
            pendingBufferedRangeEnd = -1L;
            pendingBufferedTotalBytes = -1L;
            applyByteRangeBufferSample(start, end, total);
        }
    }

    private void applyByteRangeBufferSample(long rangeStart, long rangeEnd, long totalBytes) {
        if (totalBytes <= 0L || rangeEnd <= rangeStart) return;
        long total = lastKnownDurationMs;
        if (total <= 0L && mediaPlayer != null) {
            long len = mediaPlayer.getLength();
            if (len > 0L) {
                total = len;
                lastKnownDurationMs = len;
                seekBar.setMax((int) Math.min(Integer.MAX_VALUE, len));
                if (timeDurationView != null) {
                    timeDurationView.setText(formatMs(len));
                }
            }
        }
        double startFrac = rangeStart / (double) totalBytes;
        double endFrac = Math.min(1.0, rangeEnd / (double) totalBytes);
        if (total <= 0L) {
            if (startFrac <= 0.15) {
                pendingBufferedRangeStart = rangeStart;
                pendingBufferedRangeEnd = rangeEnd;
                pendingBufferedTotalBytes = totalBytes;
            }
            return;
        }
        long currentPos = Math.max(0L, lastKnownPositionMs);
        double playFrac = Math.min(1.0, currentPos / (double) total);
        double bufferedFrac = Math.min(1.0, Math.max(0L, bufferedPositionMs) / (double) total);
        if (startFrac > Math.max(playFrac, bufferedFrac) + 0.15) {
            return;
        }
        hasProxyBufferTelemetry = true;
        long candidateMs = Math.round(endFrac * total);
        if (candidateMs > bufferedPositionMs) {
            bufferedPositionMs = Math.min(total, candidateMs);
            updateSeekBarBufferedProgress();
        }
    }

    private void applyHlsTimeBufferSample(long segStartMs, long segEndMs) {
        if (segEndMs <= 0L) return;
        long currentPos = Math.max(0L, lastKnownPositionMs);
        long frontier = Math.max(currentPos, bufferedPositionMs);
        if (segStartMs > frontier + 600000L) {
            return;
        }
        hasProxyBufferTelemetry = true;
        long clampedEnd = lastKnownDurationMs > 0L ? Math.min(lastKnownDurationMs, segEndMs) : segEndMs;
        if (clampedEnd > bufferedPositionMs) {
            bufferedPositionMs = clampedEnd;
            updateSeekBarBufferedProgress();
        }
    }

    private static String formatEpisodeTitleWithSeries(String rawSeriesTitle, String rawEpisodeTitle) {
        String sTitle = safeStr(rawSeriesTitle);
        String eTitle = safeStr(rawEpisodeTitle);
        if (eTitle.isEmpty()) eTitle = "Episódio";
        if (sTitle.isEmpty()) return eTitle;
        String sLower = sTitle.toLowerCase(Locale.ROOT);
        String eLower = eTitle.toLowerCase(Locale.ROOT);
        if (eLower.startsWith(sLower) || eLower.contains(sLower + " —") || eLower.contains(sLower + " -")) {
            return eTitle;
        }
        return sTitle + " — " + eTitle;
    }

    private void recordVisitedEpisode(
        String url,
        String title,
        long posMs,
        long durMs,
        boolean completed
    ) {
        String normalizedUrl = normalizeUrlKey(url);
        String canonicalKey = canonicalProgressKey(url);
        if (canonicalKey.isEmpty()) return;
        String formattedTitle = formatEpisodeTitleWithSeries(seriesTitle, title);
        VisitedEpisodeState state = visitedEpisodes.get(canonicalKey);
        if (state == null) {
            state = new VisitedEpisodeState(
                normalizedUrl,
                formattedTitle,
                seriesTitle,
                seriesUrl,
                posterUrl,
                isMovieFlag
            );
            visitedEpisodes.put(canonicalKey, state);
        } else {
            if (!normalizedUrl.isEmpty()) state.url = normalizedUrl;
            if (!formattedTitle.isEmpty()) state.title = formattedTitle;
            if (seriesTitle != null && !seriesTitle.isEmpty()) state.seriesTitle = seriesTitle;
            if (seriesUrl != null && !seriesUrl.isEmpty()) state.seriesUrl = seriesUrl;
            if (posterUrl != null && !posterUrl.isEmpty()) state.poster = posterUrl;
            state.isMovie = isMovieFlag;
        }
        state.positionMs = completed ? 0L : Math.max(0L, posMs);
        if (durMs > 0L) state.durationMs = durMs;
        state.completed = completed || state.completed;
        if (state.completed) {
            state.positionMs = 0L;
        }
        state.watchedAtMs = System.currentTimeMillis();
    }

    private void saveCurrentEpisodeProgress(boolean ended) {
        if (episodeUrl == null || episodeUrl.isEmpty()) return;
        boolean effectiveEnded = ended || playbackEnded;
        long posMs = Math.max(0L, Math.max(pendingSeekMs, lastKnownPositionMs));
        long durMs = Math.max(0L, lastKnownDurationMs);
        boolean alreadyCompleted = isEpisodeCompletedInPref(episodeUrl);
        recordVisitedEpisode(
            episodeUrl,
            episodeTitle,
            posMs,
            durMs,
            effectiveEnded || alreadyCompleted || isEpisodeCompletedMs(posMs, durMs, effectiveEnded)
        );
        if (!effectiveEnded && !hasPlaybackStartedForStream && posMs < MIN_RESUME_MS) {
            persistPendingSessionPref("closed");
            return;
        }
        saveEpisodeProgressPref(episodeUrl, episodeTitle, posMs, durMs, effectiveEnded, false);
        lastProgressSavedWallMs = System.currentTimeMillis();
        persistPendingSessionPref("closed");
    }

    private void saveEpisodeProgressPref(
        String url,
        String title,
        long posMs,
        long durMs,
        boolean ended,
        boolean forceReset
    ) {
        String canonicalKey = canonicalProgressKey(url);
        if (canonicalKey.isEmpty()) return;

        boolean completed = !forceReset && isEpisodeCompletedMs(posMs, durMs, ended);
        long storedPosMs = (forceReset || completed) ? 0L : Math.max(0L, posMs);

        if (!forceReset && !completed && storedPosMs < MIN_RESUME_MS) {
            return;
        }

        recordVisitedEpisode(url, title, storedPosMs, durMs, completed);
        if (completed) {
            watchedUrls.add(normalizeUrlKey(url));
            watchedUrls.add(canonicalKey);
        }

        try {
            SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
            String raw = prefs.getString(PREF_EPISODE_PROGRESS_JSON, "{}");
            JSONObject root = raw != null && !raw.isEmpty() ? new JSONObject(raw) : new JSONObject();

            JSONObject entry = new JSONObject();
            entry.put("url", normalizeUrlKey(url));
            entry.put("positionMs", storedPosMs);
            entry.put("durationMs", Math.max(0L, durMs));
            entry.put("completed", completed);
            entry.put("updatedAt", System.currentTimeMillis());
            root.put(canonicalKey, entry);

            if (root.length() > 200) {
                pruneProgressEntries(root, 200);
            }
            prefs.edit().putString(PREF_EPISODE_PROGRESS_JSON, root.toString()).apply();
        } catch (Exception e) {
            Log.w(TAG, "Failed saving episode progress", e);
        }
    }

    private boolean isEpisodeCompletedInPref(String url) {
        String canonicalKey = canonicalProgressKey(url);
        if (canonicalKey.isEmpty()) return false;
        try {
            SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
            String raw = prefs.getString(PREF_EPISODE_PROGRESS_JSON, "");
            if (raw == null || raw.isEmpty()) return false;
            JSONObject root = new JSONObject(raw);
            JSONObject entry = root.optJSONObject(canonicalKey);
            if (entry == null) return false;
            return entry.optBoolean("completed", false);
        } catch (Exception e) {
            return false;
        }
    }

    private JSONArray buildVisitedEpisodesJsonArray() {
        JSONArray visitedArr = new JSONArray();
        for (Map.Entry<String, VisitedEpisodeState> entry : visitedEpisodes.entrySet()) {
            try {
                VisitedEpisodeState st = entry.getValue();
                JSONObject o = new JSONObject();
                o.put("url", st.url != null && !st.url.isEmpty() ? st.url : entry.getKey());
                o.put("title", st.title);
                o.put("seriesTitle", st.seriesTitle != null ? st.seriesTitle : "");
                o.put("seriesUrl", st.seriesUrl != null ? st.seriesUrl : "");
                o.put("poster", st.poster != null ? st.poster : "");
                o.put("isMovie", st.isMovie);
                o.put("positionMs", st.positionMs);
                o.put("durationMs", st.durationMs);
                o.put("completed", st.completed);
                o.put("watchedAtMs", st.watchedAtMs);
                visitedArr.put(o);
            } catch (Exception ignored) {
            }
        }
        return visitedArr;
    }

    private void parseVisitedEpisodesJson(String raw) {
        if (raw == null || raw.isEmpty()) return;
        try {
            JSONArray arr = new JSONArray(raw);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                String u = safeStr(o.optString("url", ""));
                if (u.isEmpty()) continue;
                String key = canonicalProgressKey(u);
                if (key.isEmpty()) continue;
                VisitedEpisodeState st = new VisitedEpisodeState(
                    normalizeUrlKey(u),
                    o.optString("title", "Episódio"),
                    o.optString("seriesTitle", seriesTitle),
                    o.optString("seriesUrl", seriesUrl),
                    o.optString("poster", posterUrl),
                    o.optBoolean("isMovie", isMovieFlag)
                );
                st.positionMs = Math.max(0L, o.optLong("positionMs", 0L));
                st.durationMs = Math.max(0L, o.optLong("durationMs", 0L));
                st.completed = o.optBoolean("completed", false);
                st.watchedAtMs = o.optLong("watchedAtMs", System.currentTimeMillis());
                visitedEpisodes.put(key, st);
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed parsing visitedEpisodes JSON", e);
        }
    }

    private String serializeStreamsJson() {
        JSONArray arr = new JSONArray();
        for (StreamItem s : streams) {
            try {
                JSONObject o = new JSONObject();
                o.put("label", s.label);
                o.put("url", s.url);
                arr.put(o);
            } catch (Exception ignored) {
            }
        }
        return arr.toString();
    }

    private String serializeSubtitlesJson() {
        JSONArray arr = new JSONArray();
        for (SubtitleItem sub : subtitles) {
            try {
                JSONObject o = new JSONObject();
                o.put("label", sub.label);
                o.put("url", sub.url);
                o.put("isDefault", sub.isDefault);
                arr.put(o);
            } catch (Exception ignored) {
            }
        }
        return arr.toString();
    }

    private String serializeEpisodesJson() {
        JSONArray arr = new JSONArray();
        for (TopAnimesEpisodeResolver.EpisodeLink ep : seriesEpisodes) {
            try {
                JSONObject o = new JSONObject();
                o.put("numberLabel", ep.numberLabel != null ? ep.numberLabel : "");
                if (ep.episodeNumber >= 0) {
                    o.put("episodeNumber", ep.episodeNumber);
                }
                o.put("title", ep.title != null ? ep.title : "Episódio");
                o.put("url", ep.url != null ? ep.url : "");
                arr.put(o);
            } catch (Exception ignored) {
            }
        }
        return arr.toString();
    }

    private String serializeOptionsJson() {
        JSONArray arr = new JSONArray();
        for (TopAnimesEpisodeResolver.ServerOption opt : serverOptions) {
            try {
                JSONObject o = new JSONObject();
                o.put("nume", opt.nume != null ? opt.nume : "");
                o.put("label", opt.label != null ? opt.label : "");
                o.put("embedUrl", opt.embedUrl != null ? opt.embedUrl : "");
                o.put("providerKind", opt.providerKind != null ? opt.providerKind : "other");
                arr.put(o);
            } catch (Exception ignored) {
            }
        }
        return arr.toString();
    }

    private Intent buildResultIntent(String action) {
        long currentPos = Math.max(0L, Math.max(pendingSeekMs, lastKnownPositionMs));
        long currentDur = Math.max(0L, lastKnownDurationMs);
        boolean currentCompleted = playbackEnded
            || isEpisodeCompletedMs(currentPos, currentDur, playbackEnded)
            || isEpisodeCompletedInPref(episodeUrl);

        Intent result = new Intent();
        result.putExtra(RESULT_ACTION, action);
        result.putExtra(RESULT_EPISODE_URL, episodeUrl);
        result.putExtra(RESULT_POSITION_MS, currentCompleted ? 0L : currentPos);
        result.putExtra(RESULT_DURATION_MS, currentDur);
        result.putExtra(RESULT_COMPLETED, currentCompleted);
        result.putExtra(RESULT_STREAM_INDEX, currentStreamIdx);
        result.putExtra(RESULT_VIDEO_SCALE, scaleIndexToId(currentScaleIdx));
        result.putExtra(RESULT_VISITED_EPISODES_JSON, buildVisitedEpisodesJsonArray().toString());
        return result;
    }

    private void persistPendingSessionPref(String action) {
        try {
            long currentPos = Math.max(0L, Math.max(pendingSeekMs, lastKnownPositionMs));
            long currentDur = Math.max(0L, lastKnownDurationMs);
            boolean currentCompleted = playbackEnded
                || isEpisodeCompletedMs(currentPos, currentDur, playbackEnded)
                || isEpisodeCompletedInPref(episodeUrl);

            JSONObject session = new JSONObject();
            session.put("action", action != null && !action.isEmpty() ? action : "closed");
            session.put("episodeUrl", episodeUrl != null ? episodeUrl : "");
            session.put("positionMs", currentCompleted ? 0L : currentPos);
            session.put("durationMs", currentDur);
            session.put("completed", currentCompleted);
            session.put("streamIndex", currentStreamIdx);
            session.put("videoScale", scaleIndexToId(currentScaleIdx));
            session.put("visitedEpisodes", buildVisitedEpisodesJsonArray());
            session.put("updatedAt", System.currentTimeMillis());

            getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                .edit()
                .putString(PREF_PENDING_SESSION_JSON, session.toString())
                .apply();
        } catch (Exception e) {
            Log.w(TAG, "Failed persisting pending player session", e);
        }
    }

    public static String consumePendingSessionJson(Context ctx) {
        if (ctx == null) return "";
        try {
            SharedPreferences prefs = ctx.getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
            String raw = prefs.getString(PREF_PENDING_SESSION_JSON, "");
            if (raw != null && !raw.isEmpty()) {
                prefs.edit().remove(PREF_PENDING_SESSION_JSON).apply();
                return raw;
            }
        } catch (Exception ignored) {
        }
        return "";
    }

    public static void clearPendingSessionJson(Context ctx) {
        if (ctx == null) return;
        try {
            ctx.getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                .edit()
                .remove(PREF_PENDING_SESSION_JSON)
                .apply();
        } catch (Exception ignored) {
        }
    }

    private long getSavedResumePositionMs(String url) {
        String canonicalKey = canonicalProgressKey(url);
        if (canonicalKey.isEmpty()) return 0L;
        try {
            SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
            String raw = prefs.getString(PREF_EPISODE_PROGRESS_JSON, "");
            if (raw == null || raw.isEmpty()) return 0L;
            JSONObject root = new JSONObject(raw);
            JSONObject entry = root.optJSONObject(canonicalKey);
            if (entry == null) return 0L;
            boolean completed = entry.optBoolean("completed", false);
            if (completed) return 0L;
            long posMs = entry.optLong("positionMs", 0L);
            long durMs = entry.optLong("durationMs", 0L);
            if (posMs < MIN_RESUME_MS) return 0L;
            if (durMs > 0L && isEpisodeCompletedMs(posMs, durMs, false)) return 0L;
            return posMs;
        } catch (Exception e) {
            return 0L;
        }
    }

    private static void pruneProgressEntries(JSONObject root, int maxEntries) {
        try {
            List<String> keys = new ArrayList<>();
            java.util.Iterator<String> it = root.keys();
            while (it.hasNext()) {
                keys.add(it.next());
            }
            keys.sort((a, b) -> {
                long ta = root.optJSONObject(a) != null ? root.optJSONObject(a).optLong("updatedAt", 0L) : 0L;
                long tb = root.optJSONObject(b) != null ? root.optJSONObject(b).optLong("updatedAt", 0L) : 0L;
                return Long.compare(tb, ta);
            });
            for (int i = maxEntries; i < keys.size(); i++) {
                root.remove(keys.get(i));
            }
        } catch (Exception ignored) {
        }
    }

    private static boolean isEpisodeCompletedMs(long posMs, long durMs, boolean ended) {
        if (ended) return true;
        if (posMs <= 0L || durMs <= 0L) return false;
        long remainingMs = Math.max(0L, durMs - posMs);
        double ratio = (double) posMs / (double) durMs;
        if (durMs >= 120_000L) {
            return remainingMs <= 15_000L || ratio >= 0.97;
        }
        if (durMs >= 30_000L) {
            return remainingMs <= 5_000L || ratio >= 0.96;
        }
        return remainingMs <= 2_000L || ratio >= 0.95;
    }

    private static boolean isGenuinePlaybackEndMs(long posMs, long durMs) {
        if (durMs < 10_000L || posMs < 5_000L) return false;
        long remainingMs = Math.max(0L, durMs - posMs);
        double ratio = (double) posMs / (double) durMs;
        if (durMs >= 120_000L) {
            return remainingMs <= 20_000L || ratio >= 0.96;
        }
        if (durMs >= 30_000L) {
            return remainingMs <= 8_000L || ratio >= 0.94;
        }
        return remainingMs <= 3_000L || ratio >= 0.90;
    }

    public static int scaleIdToIndex(String id) {
        if (id != null) {
            String clean = id.trim().toLowerCase(Locale.ROOT);
            for (int i = 0; i < SCALE_IDS.length; i++) {
                if (SCALE_IDS[i].equals(clean)) return i;
            }
        }
        return 0;
    }

    public static String scaleIndexToId(int idx) {
        if (idx >= 0 && idx < SCALE_IDS.length) {
            return SCALE_IDS[idx];
        }
        return SCALE_IDS[0];
    }

    public static void saveVideoScalePreference(Context ctx, String scaleId) {
        if (ctx == null) return;
        int idx = scaleIdToIndex(scaleId);
        ctx.getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
            .edit()
            .putInt(PREF_VIDEO_SCALE_IDX, idx)
            .apply();
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
        String n = TopAnimesEpisodeResolver.normalizeSupportedEpisodeUrl(raw);
        if (!n.isEmpty()) return n;
        return safeStr(raw);
    }

    private static String canonicalProgressKey(String raw) {
        String n = normalizeUrlKey(raw);
        if (n.isEmpty()) return "";
        return n
            .replaceFirst("(?i)^https?://(?:www\\.)?", "")
            .replaceAll("/+$", "")
            .toLowerCase(Locale.ROOT);
    }

    private static boolean isSameEpisodeUrl(String a, String b) {
        if (a == null || b == null || a.trim().isEmpty() || b.trim().isEmpty()) return false;
        return canonicalProgressKey(a).equals(canonicalProgressKey(b));
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
