package com.topanimes.player;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.util.Log;

import androidx.core.content.IntentCompat;

public class ApkInstallReceiver extends BroadcastReceiver {
    private static final String TAG = "TopAnimesApkInstall";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;

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

            if (confirmIntent != null) {
                confirmIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try {
                    context.startActivity(confirmIntent);
                } catch (Exception e) {
                    Log.e(TAG, "Failed launching system installer confirmation", e);
                    LocalProxyPlugin.notifyInstallStage(
                        "error",
                        0,
                        "Não foi possível abrir a confirmação de instalação do sistema."
                    );
                }
            }
            return;
        }

        if (status == PackageInstaller.STATUS_SUCCESS) {
            LocalProxyPlugin.notifyInstallStage("installed", 100, null);
            return;
        }

        if (status == PackageInstaller.STATUS_FAILURE_ABORTED) {
            LocalProxyPlugin.notifyInstallStage("cancelled", 0, "Instalação cancelada pelo usuário.");
            return;
        }

        Log.w(TAG, "PackageInstaller status=" + status + " message=" + message);
        LocalProxyPlugin.notifyInstallStage(
            "error",
            0,
            (message != null && !message.isEmpty())
                ? ("Falha ao instalar atualização: " + message)
                : "Falha ao instalar atualização no sistema."
        );
    }
}
