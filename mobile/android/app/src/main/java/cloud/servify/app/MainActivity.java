package cloud.servify.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.PluginHandle;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SecureStorePlugin.class);
        registerPlugin(ServerTrustPlugin.class);
        registerPlugin(AppUpdatePlugin.class);
        super.onCreate(savedInstanceState);
        // Certificates the system doesn't trust are accepted only for servers with a pinned CA (ServerTrust).
        bridge.setWebViewClient(new PinningWebViewClient(bridge));
        AppLock.applyRecentsPolicy(this);
    }

    @Override
    public void onStart() {
        super.onStart();
        if (AppLock.onStart(this)) {
            PluginHandle h = bridge == null ? null : bridge.getPlugin("SecureStore");
            if (h != null && h.getInstance() instanceof SecureStorePlugin) ((SecureStorePlugin) h.getInstance()).notifyLocked();
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        AppLock.onResume(this);
    }

    @Override
    public void onPause() {
        AppLock.onPause(this);
        super.onPause();
    }

    @Override
    public void onStop() {
        AppLock.onStop(this);
        super.onStop();
    }

    @Override
    public void onDestroy() {
        AppLock.hideCover(this);
        super.onDestroy();
    }
}
