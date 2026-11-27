package cloud.servify.app;

import android.util.Log;
import android.webkit.WebView;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;

import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.security.KeyStore;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.Collections;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

import javax.net.ssl.SNIHostName;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;

/**
 * Lets the app pin a server's own CA (see ServerTrust). `inspect` looks at the certificate a server presents
 * without sending it anything: the handshake is always aborted by the recording trust manager below, so no
 * request, password or token can go over a connection that isn't trusted. `pin` only pins a certificate that
 * the last inspection of that same origin returned, by the fingerprint the user was shown.
 */
@CapacitorPlugin(name = "ServerTrust")
public class ServerTrustPlugin extends Plugin {
    private static final String TAG = "ServerTrust";
    private final Map<String, X509Certificate> inspected = new ConcurrentHashMap<>();

    /** Records the chain, asks the system whether it trusts it, then always fails the handshake. */
    private static final class RecordingTrustManager implements X509TrustManager {
        private final X509TrustManager system;
        X509Certificate[] chain;
        boolean systemTrusted;

        RecordingTrustManager(X509TrustManager system) {
            this.system = system;
        }

        @Override
        public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            this.chain = chain;
            try {
                system.checkServerTrusted(chain, authType);
                systemTrusted = true;
            } catch (CertificateException e) {
                systemTrusted = false;
            }
            throw new CertificateException("inspection only");
        }

        @Override
        public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            throw new CertificateException("not a server");
        }

        @Override
        public X509Certificate[] getAcceptedIssuers() {
            return new X509Certificate[0];
        }
    }

    private static X509TrustManager systemTrustManager() throws Exception {
        TrustManagerFactory f = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        f.init((KeyStore) null);
        for (TrustManager tm : f.getTrustManagers()) if (tm instanceof X509TrustManager) return (X509TrustManager) tm;
        throw new IllegalStateException("no system trust manager");
    }

    /** Like the WebView (Chromium), "localhost" and "*.localhost" always mean this device. */
    private static InetAddress resolve(String host) throws Exception {
        if (host.equals("localhost") || host.endsWith(".localhost")) return InetAddress.getByName("127.0.0.1");
        return InetAddress.getByName(host);
    }

    @PluginMethod
    public void inspect(PluginCall call) {
        String url = call.getString("url");
        String origin = url == null ? null : ServerTrust.origin(url);
        if (origin == null) {
            call.reject("an https:// address is required");
            return;
        }
        String host = ServerTrust.host(url);
        int port = ServerTrust.port(url);
        new Thread(() -> {
            JSObject ret = new JSObject();
            ret.put("origin", origin);
            X509Certificate pinned = ServerTrust.pinned(getContext(), origin);
            ret.put("pinned", pinned == null ? null : ServerTrust.fingerprint(pinned));
            RecordingTrustManager rtm;
            try {
                rtm = new RecordingTrustManager(systemTrustManager());
                SSLContext ctx = SSLContext.getInstance("TLS");
                ctx.init(null, new TrustManager[] { rtm }, null);
                Socket plain = new Socket();
                plain.connect(new InetSocketAddress(resolve(host), port), 8000);
                plain.setSoTimeout(8000);
                try (SSLSocket s = (SSLSocket) ctx.getSocketFactory().createSocket(plain, host, port, true)) {
                    if (!host.contains(":") && !host.matches("^[0-9.]+$")) {
                        SSLParameters p = s.getSSLParameters();
                        p.setServerNames(Collections.singletonList(new SNIHostName(host)));
                        s.setSSLParameters(p);
                    }
                    s.startHandshake(); // never completes: RecordingTrustManager always throws
                } catch (Exception expected) {
                    // the handshake was aborted on purpose, or the server isn't speaking TLS
                }
            } catch (Exception e) {
                ret.put("reachable", false);
                ret.put("error", e.getClass().getSimpleName() + (e.getMessage() != null ? ": " + e.getMessage() : ""));
                call.resolve(ret);
                return;
            }
            X509Certificate[] chain = rtm.chain;
            if (chain == null || chain.length == 0) {
                ret.put("reachable", true);
                ret.put("tls", false);
                ret.put("error", "no TLS certificate (is this an http:// address?)");
                call.resolve(ret);
                return;
            }
            X509Certificate leaf = chain[0];
            ret.put("reachable", true);
            ret.put("tls", true);
            ret.put("systemTrusted", rtm.systemTrusted);
            ret.put("hostMatches", ServerTrust.hostMatches(leaf, host));
            ret.put("names", new JSArray(ServerTrust.names(leaf)));
            ret.put("leafSubject", leaf.getSubjectX500Principal().getName());
            ret.put("leafNotAfter", leaf.getNotAfter().getTime());

            // The CA to offer: the self-signed root at the end of the chain, which must have signed the leaf
            // directly (Servify sends leaf + CA). A lone self-signed certificate is its own root.
            X509Certificate root = chain[chain.length - 1];
            String problem = null;
            if (!ServerTrust.selfSigned(root)) problem = "The server didn't send its CA certificate, so it can't be checked here.";
            else if (chain.length > 2) problem = "This certificate comes from an intermediate CA. Only certificates issued directly by the CA (like Servify's) can be trusted here.";
            else if (chain.length == 2 && root.getBasicConstraints() < 0) problem = "The certificate that signed this one is not a CA certificate.";
            if (problem == null) {
                String why = ServerTrust.verify(leaf, root, host);
                if (why != null && ServerTrust.hostMatches(leaf, host)) problem = "The certificate can't be trusted: " + why + ".";
            }
            if (problem != null) {
                ret.put("caProblem", problem);
            } else {
                JSObject ca = new JSObject();
                ca.put("subject", root.getSubjectX500Principal().getName());
                ca.put("fingerprint", ServerTrust.fingerprint(root));
                ca.put("notAfter", root.getNotAfter().getTime());
                ca.put("isLeaf", chain.length == 1);
                ret.put("ca", ca);
                inspected.put(origin, root);
            }
            ret.put("pinMatches", pinned != null && ServerTrust.verify(leaf, pinned, host) == null);
            call.resolve(ret);
        }).start();
    }

    @PluginMethod
    public void pin(PluginCall call) {
        String url = call.getString("url");
        String fp = call.getString("fingerprint");
        String origin = url == null ? null : ServerTrust.origin(url);
        X509Certificate c = origin == null ? null : inspected.get(origin);
        if (c == null || fp == null || !ServerTrust.fingerprint(c).equalsIgnoreCase(fp)) {
            call.reject("check the certificate again first");
            return;
        }
        try {
            ServerTrust.pin(getContext(), origin, c);
            inspected.remove(origin);
            clearWebViewDecisions();
            Log.i(TAG, "pinned " + fp + " for " + origin);
            call.resolve();
        } catch (Exception e) {
            call.reject("could not save the certificate: " + e.getMessage());
        }
    }

    @PluginMethod
    public void unpin(PluginCall call) {
        String url = call.getString("url");
        if (ServerTrust.unpin(getContext(), url == null ? null : ServerTrust.origin(url))) clearWebViewDecisions();
        call.resolve();
    }

    @PluginMethod
    public void pinned(PluginCall call) {
        String url = call.getString("url");
        X509Certificate c = url == null ? null : ServerTrust.pinned(getContext(), ServerTrust.origin(url));
        JSObject ret = new JSObject();
        ret.put("fingerprint", c == null ? null : ServerTrust.fingerprint(c));
        call.resolve(ret);
    }

    /** Drop every pin whose origin isn't among `keep` (the app's saved servers). */
    @PluginMethod
    public void prune(PluginCall call) {
        Set<String> keep = new HashSet<>();
        JSArray urls = call.getArray("keep");
        if (urls != null) {
            JSONArray a = urls;
            for (int i = 0; i < a.length(); i++) {
                String o = ServerTrust.origin(a.optString(i, ""));
                if (o != null) keep.add(o.toLowerCase(Locale.ROOT));
            }
        }
        boolean changed = false;
        for (String origin : ServerTrust.all(getContext()).keySet()) {
            if (!keep.contains(origin)) changed |= ServerTrust.unpin(getContext(), origin);
        }
        if (changed) clearWebViewDecisions();
        call.resolve();
    }

    /** Chromium remembers that it was allowed to proceed past a certificate error; forget that when pins change. */
    private void clearWebViewDecisions() {
        getActivity().runOnUiThread(() -> {
            WebView wv = getBridge().getWebView();
            if (wv != null) wv.clearSslPreferences();
        });
    }
}
