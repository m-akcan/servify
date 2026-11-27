package cloud.servify.app;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.ref.WeakReference;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLHandshakeException;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;

import org.json.JSONObject;

/**
 * Updates the app from the user's own Servify, which mirrors the APK from its signed release.
 *
 * download: fetches /api/mobile/app.apk with the device token into the app's private cache. TLS is decided exactly
 * like the WebView's: the system's trust first, and only if that fails the CA pinned for exactly that host and port
 * (ServerTrust.verify) — never "trust all". Redirects aren't followed (the token must not go anywhere else). The file
 * must have the size and SHA-256 the server announced, be this app (same package name), have a higher versionCode
 * than the installed app, and be signed with the same certificate(s) as the installed app. Anything else is deleted
 * and refused before Android's installer is ever opened.
 *
 * install: hands the checked file to PackageInstaller (hashing it again on the way in) and Android asks the user to
 * confirm. Android itself also refuses an update signed with a different key.
 *
 * Nothing works while the app lock is locked.
 */
@CapacitorPlugin(name = "AppUpdate")
public class AppUpdatePlugin extends Plugin {
    private static final String TAG = "AppUpdate";
    private static final String DIR = "updates";
    private static final String FILE = "servify-update.apk";
    private static final long MAX_BYTES = 256L * 1024 * 1024;

    private static WeakReference<AppUpdatePlugin> instance = new WeakReference<>(null);

    /** The checked download, if any: install() only installs this, with this hash. */
    private volatile String verifiedSha256;
    private volatile boolean downloading;

    @Override
    public void load() {
        instance = new WeakReference<>(this);
    }

    /** From InstallStatusReceiver. */
    static void report(String status, String message) {
        AppUpdatePlugin p = instance.get();
        if (p == null) return;
        JSObject o = new JSObject();
        o.put("status", status);
        if (message != null) o.put("message", message);
        p.notifyListeners("installStatus", o);
    }

    private boolean canInstall() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true; // the "unknown sources" setting is global there
        return getContext().getPackageManager().canRequestPackageInstalls();
    }

    @SuppressWarnings("deprecation")
    private PackageInfo self(int flags) throws PackageManager.NameNotFoundException {
        return getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), flags);
    }

    @SuppressWarnings("deprecation")
    private static long versionCodeOf(PackageInfo pi) {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? pi.getLongVersionCode() : pi.versionCode;
    }

    @PluginMethod
    public void status(PluginCall call) {
        try {
            PackageInfo pi = self(0);
            JSObject ret = new JSObject();
            ret.put("canInstall", canInstall());
            ret.put("versionName", pi.versionName);
            ret.put("versionCode", versionCodeOf(pi));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage(), "failed");
        }
    }

    /** Android's "Install unknown apps" page for this app. */
    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        try {
            Intent i = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    ? new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()))
                    : new Intent(Settings.ACTION_SECURITY_SETTINGS);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("Couldn't open Android settings: " + e.getMessage(), "failed");
        }
    }

    // ───────────── downloading ─────────────

    /** System trust first; if that fails, only the CA pinned for this origin (the WebView's rule, see PinningWebViewClient). */
    private static final class PinnedTrustManager implements X509TrustManager {
        private final X509TrustManager system;
        private final X509Certificate pinned;
        private final String host;

        PinnedTrustManager(X509TrustManager system, X509Certificate pinned, String host) {
            this.system = system;
            this.pinned = pinned;
            this.host = host;
        }

        @Override
        public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            try {
                system.checkServerTrusted(chain, authType);
            } catch (CertificateException e) {
                if (pinned == null) throw e;
                String why = ServerTrust.verify(chain == null || chain.length == 0 ? null : chain[0], pinned, host);
                if (why != null) throw new CertificateException(why);
            }
        }

        @Override
        public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            throw new CertificateException("not a server");
        }

        @Override
        public X509Certificate[] getAcceptedIssuers() {
            return system.getAcceptedIssuers();
        }
    }

    private static X509TrustManager systemTrustManager() throws Exception {
        TrustManagerFactory f = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        f.init((KeyStore) null);
        for (TrustManager tm : f.getTrustManagers()) if (tm instanceof X509TrustManager) return (X509TrustManager) tm;
        throw new IllegalStateException("no system trust manager");
    }

    private static String hex(byte[] d) {
        StringBuilder sb = new StringBuilder();
        for (byte b : d) sb.append(String.format(Locale.ROOT, "%02x", b & 0xff));
        return sb.toString();
    }

    private static String errorOf(HttpURLConnection c) {
        try (InputStream in = c.getErrorStream()) {
            if (in == null) return null;
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0 && out.size() < 8192) out.write(buf, 0, n);
            return new JSONObject(out.toString(StandardCharsets.UTF_8.name())).optString("error", null);
        } catch (Exception e) {
            return null;
        }
    }

    private static final class Refused extends Exception {
        final String code;

        Refused(String code, String message) {
            super(message);
            this.code = code;
        }
    }

    private static Long longOf(PluginCall call, String name) {
        Object v = call.getData().opt(name);
        if (!(v instanceof Number)) return null;
        double d = ((Number) v).doubleValue();
        return d == Math.rint(d) && d >= 0 && d < 9e15 ? (long) d : null;
    }

    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url");
        String token = call.getString("token");
        String sha256 = call.getString("sha256", "");
        // JS numbers arrive as Integer, Long or Double (PluginCall.getLong only accepts Long).
        Long size = longOf(call, "size");
        Long versionCode = longOf(call, "versionCode");
        if (AppLock.locked(getContext())) {
            call.reject("Unlock the app first.", "locked");
            return;
        }
        if (url == null || token == null || size == null || versionCode == null || !sha256.matches("^[0-9a-f]{64}$") || size <= 0 || size > MAX_BYTES) {
            call.reject("Incomplete update details from the server.", "failed");
            return;
        }
        if (downloading) {
            call.reject("An update is already downloading.", "failed");
            return;
        }
        downloading = true;
        verifiedSha256 = null;
        final long want = size;
        new Thread(() -> {
            File dir = new File(getContext().getCacheDir(), DIR);
            File part = new File(dir, FILE + ".part");
            File done = new File(dir, FILE);
            try {
                done.delete();
                part.delete();
                if (!dir.isDirectory() && !dir.mkdirs()) throw new Refused("failed", "Couldn't create the download folder.");
                fetch(url, token, sha256, want, part);
                if (!part.renameTo(done)) throw new Refused("failed", "Couldn't store the download.");
                JSObject info = checkArchive(done, versionCode);
                verifiedSha256 = sha256;
                call.resolve(info);
            } catch (Refused r) {
                part.delete();
                done.delete();
                Log.w(TAG, "update refused: " + r.getMessage());
                call.reject(r.getMessage(), r.code);
            } catch (Exception e) {
                part.delete();
                done.delete();
                Log.w(TAG, "update download failed", e);
                call.reject("The download failed: " + e.getMessage(), "failed");
            } finally {
                downloading = false;
            }
        }).start();
    }

    private void fetch(String url, String token, String sha256, long want, File out) throws Exception {
        URL u;
        try {
            u = new URL(url);
        } catch (Exception e) {
            throw new Refused("failed", "Bad server address.");
        }
        String scheme = u.getProtocol().toLowerCase(Locale.ROOT);
        if (!(scheme.equals("https") || scheme.equals("http")) || !u.getPath().endsWith("/api/mobile/app.apk")) throw new Refused("failed", "Bad update address.");
        HttpURLConnection c = (HttpURLConnection) u.openConnection();
        try {
            if (c instanceof HttpsURLConnection) {
                X509Certificate pinned = ServerTrust.pinned(getContext(), ServerTrust.origin(url));
                SSLContext ctx = SSLContext.getInstance("TLS");
                ctx.init(null, new TrustManager[] { new PinnedTrustManager(systemTrustManager(), pinned, ServerTrust.host(url)) }, null);
                ((HttpsURLConnection) c).setSSLSocketFactory(ctx.getSocketFactory());
            }
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(15_000);
            c.setReadTimeout(30_000);
            c.setUseCaches(false);
            c.setRequestProperty("Authorization", "Bearer " + token);
            c.setRequestProperty("Accept", "application/vnd.android.package-archive");
            try {
                PackageInfo pi = self(0);
                c.setRequestProperty("X-Servify-App", pi.versionName + "/" + versionCodeOf(pi));
            } catch (Exception ignored) {
            }
            int status;
            try {
                status = c.getResponseCode();
            } catch (SSLHandshakeException e) {
                throw new Refused("tls", "The server's certificate isn't trusted for " + u.getHost() + " (" + e.getMessage() + ").");
            } catch (java.io.IOException e) {
                throw new Refused("network", "Can't reach " + u.getHost() + ": " + e.getMessage());
            }
            if (status != 200) {
                String msg = errorOf(c);
                if (status == 401) throw new Refused("http", "This phone was signed out of Servify. Sign in again.");
                throw new Refused("http", msg != null ? msg : "The server answered " + status + ".");
            }
            long len = c.getContentLengthLong();
            if (len >= 0 && len != want) throw new Refused("size", "The server sends " + len + " bytes, but announced " + want + ". Not installed.");
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            long got = 0;
            long lastReport = 0;
            try (InputStream in = c.getInputStream(); OutputStream os = new FileOutputStream(out)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) {
                    got += n;
                    if (got > want) throw new Refused("size", "The download is larger than the server announced. Not installed.");
                    md.update(buf, 0, n);
                    os.write(buf, 0, n);
                    long now = System.currentTimeMillis();
                    if (now - lastReport > 200) {
                        lastReport = now;
                        progress(got, want);
                    }
                }
            }
            progress(got, want);
            if (got != want) throw new Refused("size", "The download ended after " + got + " of " + want + " bytes. Try again.");
            if (!hex(md.digest()).equals(sha256)) throw new Refused("hash", "The download doesn't match the SHA-256 your Servify announced, so it was deleted. Not installed.");
        } finally {
            c.disconnect();
        }
    }

    private void progress(long received, long total) {
        JSObject o = new JSObject();
        o.put("received", received);
        o.put("total", total);
        notifyListeners("progress", o);
    }

    // ───────────── checking ─────────────

    private static Set<String> digests(Signature[] sigs) throws Exception {
        Set<String> out = new HashSet<>();
        if (sigs == null) return out;
        for (Signature s : sigs) out.add(hex(MessageDigest.getInstance("SHA-256").digest(s.toByteArray())));
        return out;
    }

    /** SHA-256 of the signing certificates of an installed package or an archive; empty when Android can't tell. */
    @SuppressWarnings("deprecation")
    private static Set<String> signers(PackageInfo pi) throws Exception {
        if (pi == null) return new HashSet<>();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && pi.signingInfo != null) {
            SigningInfo si = pi.signingInfo;
            return digests(si.hasMultipleSigners() ? si.getApkContentsSigners() : si.getSigningCertificateHistory());
        }
        return digests(pi.signatures);
    }

    @SuppressWarnings("deprecation")
    private Set<String> archiveSigners(PackageManager pm, String path) throws Exception {
        Set<String> s = new HashSet<>();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) s = signers(pm.getPackageArchiveInfo(path, PackageManager.GET_SIGNING_CERTIFICATES));
        if (s.isEmpty()) s = signers(pm.getPackageArchiveInfo(path, PackageManager.GET_SIGNATURES));
        return s;
    }

    @SuppressWarnings("deprecation")
    private Set<String> ownSigners() throws Exception {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) return signers(self(PackageManager.GET_SIGNING_CERTIFICATES));
        return signers(self(PackageManager.GET_SIGNATURES));
    }

    /** The downloaded file is this app, newer, and signed like this app. Throws Refused otherwise. */
    private JSObject checkArchive(File apk, long expectedVersionCode) throws Exception {
        PackageManager pm = getContext().getPackageManager();
        PackageInfo info = pm.getPackageArchiveInfo(apk.getAbsolutePath(), 0);
        if (info == null) throw new Refused("unreadable", "The download isn't an Android app. Not installed.");
        if (!getContext().getPackageName().equals(info.packageName)) throw new Refused("package", "The download is another app (" + info.packageName + "). Not installed.");
        long own = versionCodeOf(self(0));
        long theirs = versionCodeOf(info);
        if (theirs <= own) throw new Refused("version", "The download (" + info.versionName + ") isn't newer than this app. Not installed.");
        if (theirs != expectedVersionCode) throw new Refused("version", "The download is version " + theirs + ", not the " + expectedVersionCode + " your Servify announced. Not installed.");
        Set<String> mine = ownSigners();
        Set<String> got = archiveSigners(pm, apk.getAbsolutePath());
        if (mine.isEmpty() || got.isEmpty()) throw new Refused("signer", "Couldn't read who signed the update, so it was not installed.");
        if (!mine.equals(got)) {
            Log.w(TAG, "signer mismatch: app " + mine + ", download " + got);
            throw new Refused("signer", "The download isn't signed with the same key as this app, so it was not installed.");
        }
        JSObject ret = new JSObject();
        ret.put("versionName", info.versionName);
        ret.put("versionCode", theirs);
        return ret;
    }

    // ───────────── installing ─────────────

    @PluginMethod
    public void install(PluginCall call) {
        if (AppLock.locked(getContext())) {
            call.reject("Unlock the app first.", "locked");
            return;
        }
        String sha = verifiedSha256;
        File apk = new File(new File(getContext().getCacheDir(), DIR), FILE);
        if (sha == null || !apk.isFile()) {
            call.reject("Download the update first.", "no_download");
            return;
        }
        if (!canInstall()) {
            call.reject("Allow Servify to install apps in Android settings first.", "not_allowed");
            return;
        }
        new Thread(() -> {
            PackageInstaller pi = getContext().getPackageManager().getPackageInstaller();
            int id = -1;
            try {
                PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                params.setAppPackageName(getContext().getPackageName());
                params.setSize(apk.length());
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) params.setInstallReason(PackageManager.INSTALL_REASON_USER);
                id = pi.createSession(params);
                try (PackageInstaller.Session s = pi.openSession(id)) {
                    MessageDigest md = MessageDigest.getInstance("SHA-256");
                    try (InputStream in = new FileInputStream(apk); OutputStream out = s.openWrite("base.apk", 0, apk.length())) {
                        byte[] buf = new byte[64 * 1024];
                        int n;
                        while ((n = in.read(buf)) > 0) {
                            md.update(buf, 0, n);
                            out.write(buf, 0, n);
                        }
                        s.fsync(out);
                    }
                    // Exactly the bytes that were checked, or nothing.
                    if (!hex(md.digest()).equals(sha)) {
                        s.abandon();
                        call.reject("The downloaded file changed after it was checked. Not installed.", "hash");
                        return;
                    }
                    Intent result = new Intent(getContext(), InstallStatusReceiver.class).setAction(InstallStatusReceiver.ACTION);
                    int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0);
                    PendingIntent pending = PendingIntent.getBroadcast(getContext(), id, result, flags);
                    s.commit(pending.getIntentSender());
                }
                call.resolve();
            } catch (Exception e) {
                Log.w(TAG, "install failed", e);
                if (id != -1) {
                    try {
                        pi.abandonSession(id);
                    } catch (Exception ignored) {
                    }
                }
                call.reject("Couldn't hand the update to Android: " + e.getMessage(), "install");
            }
        }).start();
    }
}
