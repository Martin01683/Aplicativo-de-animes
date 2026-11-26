package com.topanimes.player;

import android.content.Intent;
import android.os.Bundle;
import android.os.SystemClock;
import android.webkit.WebView;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

import org.json.JSONObject;

public class MainActivity extends BridgeActivity {
    public static final String EXTRA_NOTIFICATION_URL = "anisync_notification_url";
    public static final String EXTRA_NOTIFICATION_KIND = "anisync_notification_kind";

    private static final long DOUBLE_BACK_EXIT_WINDOW_MS = 2000L;
    private static final Object PENDING_LOCK = new Object();
    private static String pendingNotificationUrl = null;
    private static String pendingNotificationKind = null;
    private static volatile boolean inForeground = false;
    private long lastRootBackPressMs = 0L;

    public static boolean isInForeground() {
        return inForeground;
    }

    public static String[] consumePendingNotificationTarget() {
        synchronized (PENDING_LOCK) {
            if (pendingNotificationUrl == null || pendingNotificationUrl.isEmpty()) {
                return null;
            }
            String[] result = new String[] { pendingNotificationUrl, pendingNotificationKind };
            pendingNotificationUrl = null;
            pendingNotificationKind = null;
            return result;
        }
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LocalProxyPlugin.class);
        registerPlugin(NativeVlcPlayerPlugin.class);
        registerPlugin(TvCastPlugin.class);
        super.onCreate(savedInstanceState);

        captureNotificationIntent(getIntent(), false);
        configureWebViewTouchBehavior();

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = getBridge() != null ? getBridge().getWebView() : null;
                if (webView == null) {
                    handleRootBackPress();
                    return;
                }

                webView.evaluateJavascript(
                    "(function(){try{return !!(window.__topAnimesHandleAndroidBack&&window.__topAnimesHandleAndroidBack());}catch(e){return false;}})()",
                    value -> {
                        if ("true".equals(value)) {
                            lastRootBackPressMs = 0L;
                        } else {
                            handleRootBackPress();
                        }
                    }
                );
            }
        });
    }

    private void configureWebViewTouchBehavior() {
        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView == null) return;
        webView.setHapticFeedbackEnabled(false);
        webView.setOnLongClickListener(v -> {
            WebView.HitTestResult hit = webView.getHitTestResult();
            return hit == null || hit.getType() != WebView.HitTestResult.EDIT_TEXT_TYPE;
        });
        webView.setLongClickable(false);
    }

    @Override
    public void onResume() {
        super.onResume();
        inForeground = true;
        LocalProxyPlugin.flushPendingInstallConfirmation(this);
    }

    @Override
    public void onPause() {
        inForeground = false;
        super.onPause();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        captureNotificationIntent(intent, true);
    }

    private void captureNotificationIntent(Intent intent, boolean dispatchImmediately) {
        if (intent == null) return;
        String targetUrl = intent.getStringExtra(EXTRA_NOTIFICATION_URL);
        if (targetUrl == null || targetUrl.trim().isEmpty()) return;
        String targetKind = intent.getStringExtra(EXTRA_NOTIFICATION_KIND);
        if (targetKind == null || targetKind.trim().isEmpty()) {
            targetKind = "episode";
        }
        intent.removeExtra(EXTRA_NOTIFICATION_URL);
        intent.removeExtra(EXTRA_NOTIFICATION_KIND);

        synchronized (PENDING_LOCK) {
            pendingNotificationUrl = targetUrl.trim();
            pendingNotificationKind = targetKind.trim();
        }

        if (dispatchImmediately) {
            dispatchPendingNotificationToWebView();
        }
    }

    private void dispatchPendingNotificationToWebView() {
        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView == null) return;
        String[] target = consumePendingNotificationTarget();
        if (target == null) return;
        final String urlLiteral = JSONObject.quote(target[0]);
        final String kindLiteral = JSONObject.quote(target[1] != null ? target[1] : "episode");
        webView.post(() -> webView.evaluateJavascript(
            "(function(){try{if(window.__anisyncOpenNotificationTarget){window.__anisyncOpenNotificationTarget("
                + urlLiteral + "," + kindLiteral + ");return true;}}catch(e){}return false;})()",
            null
        ));
    }

    private void handleRootBackPress() {
        long now = SystemClock.elapsedRealtime();
        if (lastRootBackPressMs > 0L && (now - lastRootBackPressMs) <= DOUBLE_BACK_EXIT_WINDOW_MS) {
            lastRootBackPressMs = 0L;
            finish();
        } else {
            lastRootBackPressMs = now;
            Toast.makeText(this, "Pressione voltar novamente para sair", Toast.LENGTH_SHORT).show();
        }
    }
}
