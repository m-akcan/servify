package cloud.servify.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.os.Build;
import android.util.Log;

/**
 * PackageInstaller's answer to an update the app committed (AppUpdatePlugin.install). Not exported: only the
 * PendingIntent the app itself created reaches it. When Android needs the user's confirmation, its installer
 * screen is opened from here.
 */
public class InstallStatusReceiver extends BroadcastReceiver {
    static final String ACTION = "cloud.servify.app.INSTALL_STATUS";
    private static final String TAG = "AppUpdate";

    @Override
    @SuppressWarnings("deprecation")
    public void onReceive(Context ctx, Intent intent) {
        if (!ACTION.equals(intent.getAction())) return;
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        String message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
        switch (status) {
            case PackageInstaller.STATUS_PENDING_USER_ACTION: {
                Intent confirm = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                        ? intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent.class)
                        : (Intent) intent.getParcelableExtra(Intent.EXTRA_INTENT);
                if (confirm == null) {
                    AppUpdatePlugin.report("failed", "Android didn't open its installer.");
                    return;
                }
                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try {
                    ctx.startActivity(confirm);
                    AppUpdatePlugin.report("pending_user_action", null);
                } catch (Exception e) {
                    Log.w(TAG, "couldn't open the installer", e);
                    AppUpdatePlugin.report("failed", "Android didn't open its installer: " + e.getMessage());
                }
                return;
            }
            case PackageInstaller.STATUS_SUCCESS:
                AppUpdatePlugin.report("success", null);
                return;
            case PackageInstaller.STATUS_FAILURE_ABORTED:
                AppUpdatePlugin.report("failed", "the update was cancelled");
                return;
            default:
                Log.w(TAG, "install status " + status + ": " + message);
                AppUpdatePlugin.report("failed", message != null ? message : "status " + status);
        }
    }
}
