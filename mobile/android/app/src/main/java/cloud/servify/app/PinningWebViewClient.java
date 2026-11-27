package cloud.servify.app;

import android.net.http.SslError;
import android.util.Log;
import android.webkit.SslErrorHandler;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

import java.security.cert.X509Certificate;

/**
 * Every request of the app (fetch() for the API and for the live event stream) goes through the WebView, so
 * this is the one place where certificates are decided. The system's own checks run first; only when they
 * fail does the WebView ask here, and the connection proceeds only if the server's certificate verifies
 * against the CA the user pinned for exactly that host and port (ServerTrust.verify). Everything else is
 * cancelled, as the default WebViewClient does.
 */
public class PinningWebViewClient extends BridgeWebViewClient {
    private static final String TAG = "ServerTrust";
    private final Bridge bridge;

    public PinningWebViewClient(Bridge bridge) {
        super(bridge);
        this.bridge = bridge;
    }

    @Override
    public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
        String url = error.getUrl();
        String origin = ServerTrust.origin(url);
        X509Certificate ca = ServerTrust.pinned(bridge.getContext(), origin);
        if (ca == null) {
            Log.w(TAG, "certificate not trusted for " + origin + " (no pinned CA)");
            handler.cancel();
            return;
        }
        X509Certificate leaf = ServerTrust.leafOf(error.getCertificate());
        String why = ServerTrust.verify(leaf, ca, ServerTrust.host(url));
        if (why == null) {
            handler.proceed();
        } else {
            Log.w(TAG, "certificate rejected for " + origin + ": " + why);
            handler.cancel();
        }
    }
}
