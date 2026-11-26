package com.topanimes.player;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.util.Log;

import androidx.core.content.IntentCompat;

/**
 * Receives Android PackageInstaller session broadcasts for Anisync self-updates.
 *
 * Resilient session-install lifecycle:
 * - Handles background confirmation hand-off (posts notification + re-prompts on foreground resume
 *   instead of silently failing when Android blocks background activity starts).
 * - Detects OEM silent-update refusal (aborted before any confirmation UI was shown) and retries
 *   automatically with USER_ACTION_REQUIRED.
 * - Falls back to ACTION_INSTALL_PACKAGE when a system component kills the PackageInstaller session.
 */
public class ApkInstallReceiver extends BroadcastReceiver {
    private static final String TAG = "TopAnimesApkInstall";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;

        int sessionId = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1);
        int status = intent.getIntExtra(
            PackageInstaller.EXTRA_STATUS,
            PackageInstaller.STATUS_FAILURE
        );
        String message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);

        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirmIntent = IntentCompat.getParcelableExtra(
                intent,
                Intent.EXTRA_INTENT,
                Intent.class
            );
            LocalProxyPlugin.onInstallUserActionRequired(context, sessionId, confirmIntent);
            return;
        }

        if (status == PackageInstaller.STATUS_SUCCESS) {
            LocalProxyPlugin.onInstallSucceeded(context, sessionId);
            return;
        }

        if (status == PackageInstaller.STATUS_FAILURE_ABORTED) {
            LocalProxyPlugin.onInstallAborted(context, sessionId, message);
            return;
        }

        Log.w(TAG, "PackageInstaller sessionId=" + sessionId + " status=" + status + " message=" + message);
        LocalProxyPlugin.onInstallFailed(context, sessionId, status, message);
    }
}
