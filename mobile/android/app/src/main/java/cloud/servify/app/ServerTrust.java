package cloud.servify.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.http.SslCertificate;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;

import java.io.ByteArrayInputStream;
import java.net.InetAddress;
import java.net.URI;
import java.security.MessageDigest;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Per-server trust for certificates that no public CA issued, such as the ones from Servify's own local CA.
 *
 * The user pins one CA certificate for one origin (host + port) after comparing its SHA-256 fingerprint with
 * the dashboard. A certificate the system doesn't trust is then accepted for that origin only when it is
 * signed directly by the pinned CA, is within its validity period, is meant for TLS servers and names the
 * host the app connects to. Nothing else is ever accepted: there is no "trust all" path, and a pin never
 * applies to another host or port.
 */
final class ServerTrust {
    private static final String PREFS = "servify_trust";
    private static final String SERVER_AUTH = "1.3.6.1.5.5.7.3.1";
    private static final String ANY_EKU = "2.5.29.37.0";

    private ServerTrust() {}

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** "host:port" for an https:// URL, or null for anything else. The host is lower-cased, IPv6 keeps its brackets. */
    static String origin(String url) {
        try {
            URI u = new URI(url);
            if (!"https".equalsIgnoreCase(u.getScheme()) || u.getHost() == null) return null;
            int port = u.getPort() == -1 ? 443 : u.getPort();
            return u.getHost().toLowerCase(Locale.ROOT) + ":" + port;
        } catch (Exception e) {
            return null;
        }
    }

    /** The host part of an https:// URL, without IPv6 brackets. */
    static String host(String url) {
        try {
            String h = new URI(url).getHost();
            if (h == null) return null;
            h = h.toLowerCase(Locale.ROOT);
            return h.startsWith("[") && h.endsWith("]") ? h.substring(1, h.length() - 1) : h;
        } catch (Exception e) {
            return null;
        }
    }

    static int port(String url) {
        try {
            int p = new URI(url).getPort();
            return p == -1 ? 443 : p;
        } catch (Exception e) {
            return 443;
        }
    }

    // ───────────── pins ─────────────

    static X509Certificate pinned(Context ctx, String origin) {
        if (origin == null) return null;
        String b64 = prefs(ctx).getString("pin:" + origin, null);
        if (b64 == null) return null;
        try {
            return parse(Base64.decode(b64, Base64.NO_WRAP));
        } catch (Exception e) {
            return null;
        }
    }

    static void pin(Context ctx, String origin, X509Certificate ca) throws Exception {
        prefs(ctx).edit().putString("pin:" + origin, Base64.encodeToString(ca.getEncoded(), Base64.NO_WRAP)).commit();
    }

    static boolean unpin(Context ctx, String origin) {
        if (origin == null || !prefs(ctx).contains("pin:" + origin)) return false;
        prefs(ctx).edit().remove("pin:" + origin).commit();
        return true;
    }

    /** origin → fingerprint of every pin. */
    static Map<String, String> all(Context ctx) {
        Map<String, String> out = new HashMap<>();
        for (String k : prefs(ctx).getAll().keySet()) {
            if (!k.startsWith("pin:")) continue;
            String origin = k.substring(4);
            X509Certificate c = pinned(ctx, origin);
            if (c != null) out.put(origin, fingerprint(c));
        }
        return out;
    }

    // ───────────── certificates ─────────────

    static X509Certificate parse(byte[] der) throws Exception {
        return (X509Certificate) CertificateFactory.getInstance("X.509").generateCertificate(new ByteArrayInputStream(der));
    }

    /** The server certificate behind a WebView SSL error. WebView only hands over the leaf, never the chain. */
    static X509Certificate leafOf(SslCertificate cert) {
        if (cert == null) return null;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) return cert.getX509Certificate();
            Bundle b = SslCertificate.saveState(cert);
            byte[] der = b == null ? null : b.getByteArray("x509-certificate");
            return der == null ? null : parse(der);
        } catch (Exception e) {
            return null;
        }
    }

    /** SHA-256 of the DER encoding as "AB:CD:…", the format Node's fingerprint256 and openssl use. */
    static String fingerprint(X509Certificate c) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(c.getEncoded());
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < d.length; i++) {
                if (i > 0) sb.append(':');
                sb.append(String.format(Locale.ROOT, "%02X", d[i] & 0xff));
            }
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    static boolean selfSigned(X509Certificate c) {
        if (!c.getSubjectX500Principal().equals(c.getIssuerX500Principal())) return false;
        try {
            c.verify(c.getPublicKey());
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /** DNS names and IP addresses the certificate is for (subjectAltName only, as browsers do). */
    static List<String> names(X509Certificate c) {
        List<String> out = new ArrayList<>();
        try {
            Collection<List<?>> sans = c.getSubjectAlternativeNames();
            if (sans == null) return out;
            for (List<?> san : sans) {
                if (san.size() < 2) continue;
                Object type = san.get(0);
                if (Integer.valueOf(2).equals(type) || Integer.valueOf(7).equals(type)) out.add(String.valueOf(san.get(1)));
            }
        } catch (Exception ignored) {
        }
        return out;
    }

    private static boolean isIpLiteral(String host) {
        return host.indexOf(':') >= 0 || host.matches("^\\d{1,3}(\\.\\d{1,3}){3}$");
    }

    /** RFC 6125 style: IP literals against IP SANs, names against DNS SANs (one leftmost "*." wildcard label). */
    static boolean hostMatches(X509Certificate c, String host) {
        if (host == null || host.isEmpty()) return false;
        host = host.toLowerCase(Locale.ROOT);
        boolean ip = isIpLiteral(host);
        try {
            Collection<List<?>> sans = c.getSubjectAlternativeNames();
            if (sans == null) return false;
            InetAddress want = ip ? InetAddress.getByName(host) : null; // a literal: no DNS lookup
            for (List<?> san : sans) {
                if (san.size() < 2) continue;
                Object type = san.get(0);
                String v = String.valueOf(san.get(1)).toLowerCase(Locale.ROOT);
                if (ip && Integer.valueOf(7).equals(type)) {
                    try {
                        if (InetAddress.getByName(v).equals(want)) return true;
                    } catch (Exception ignored) {
                    }
                } else if (!ip && Integer.valueOf(2).equals(type) && dnsMatches(v, host)) {
                    return true;
                }
            }
        } catch (Exception ignored) {
        }
        return false;
    }

    private static boolean dnsMatches(String pattern, String host) {
        if (pattern.endsWith(".")) pattern = pattern.substring(0, pattern.length() - 1);
        if (host.endsWith(".")) host = host.substring(0, host.length() - 1);
        if (!pattern.startsWith("*.")) return pattern.equals(host);
        String suffix = pattern.substring(1); // ".example.lan"
        if (suffix.indexOf('*') >= 0 || suffix.split("\\.").length < 3) return false; // no "*.lan"
        if (!host.endsWith(suffix)) return false;
        String label = host.substring(0, host.length() - suffix.length());
        return !label.isEmpty() && label.indexOf('.') < 0;
    }

    /**
     * Whether a server certificate is acceptable for {@code host} under the pinned CA. Returns null when it is,
     * otherwise a short reason (for logs and the app's messages).
     */
    static String verify(X509Certificate leaf, X509Certificate ca, String host) {
        if (leaf == null) return "no certificate";
        if (ca == null) return "no pinned certificate";
        try {
            ca.checkValidity();
        } catch (Exception e) {
            return "the pinned certificate has expired";
        }
        try {
            leaf.checkValidity();
        } catch (Exception e) {
            return "the server certificate has expired or is not valid yet";
        }
        boolean same;
        try {
            same = Arrays.equals(leaf.getEncoded(), ca.getEncoded());
        } catch (Exception e) {
            return "unreadable certificate";
        }
        if (!same) {
            // Signed directly by the pinned CA (Servify's leaves are; chains with intermediates aren't supported).
            if (!leaf.getIssuerX500Principal().equals(ca.getSubjectX500Principal())) return "not issued by the pinned certificate";
            try {
                leaf.verify(ca.getPublicKey());
            } catch (Exception e) {
                return "not signed by the pinned certificate";
            }
            if (leaf.getBasicConstraints() != -1) return "the server certificate is a CA certificate";
        }
        try {
            List<String> eku = leaf.getExtendedKeyUsage();
            if (eku != null && !eku.contains(SERVER_AUTH) && !eku.contains(ANY_EKU)) return "the certificate is not for TLS servers";
        } catch (Exception e) {
            return "unreadable certificate";
        }
        if (!hostMatches(leaf, host)) return "the certificate is not for " + host;
        return null;
    }
}
