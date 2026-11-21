package com.topanimes.player;

import android.os.Bundle;
import android.os.SystemClock;
import android.webkit.WebView;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final long DOUBLE_BACK_EXIT_WINDOW_MS = 2000L;
    private long lastRootBackPressMs = 0L;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LocalProxyPlugin.class);
        registerPlugin(NativeVlcPlayerPlugin.class);
        super.onCreate(savedInstanceState);

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
