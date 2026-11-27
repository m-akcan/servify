package cloud.servify.app;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Build;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;

import androidx.biometric.BiometricManager;

/**
 * App lock state. The lock itself is SecureStorePlugin's: with the lock on, tokens are encrypted with a Keystore
 * key that only works for a short while after the user authenticates. This class keeps track of whether the
 * app is unlocked and of how long it has been in the background (measured natively, because JS timers stop
 * while the app is in the background), and covers the screen so the app's content never shows in the
 * recent-apps view or for a moment when it comes back locked.
 */
final class AppLock {
    static final String PREFS = "servify_lock";
    static final long DEFAULT_TIMEOUT_MS = 60_000;

    /** Unlocked for this process. Starts false, so a cold start with the lock on always asks. */
    static volatile boolean unlocked = false;
    /** A prompt (or the system's PIN/pattern screen) is showing; leaving the app for it doesn't count. */
    static volatile boolean authInProgress = false;
    private static long backgroundSince = -1;
    private static View cover;

    private AppLock() {}

    static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static boolean enabled(Context ctx) {
        return prefs(ctx).getBoolean("enabled", false);
    }

    static long timeoutMs(Context ctx) {
        return prefs(ctx).getLong("timeoutMs", DEFAULT_TIMEOUT_MS);
    }

    static boolean deviceSecure(Context ctx) {
        KeyguardManager km = (KeyguardManager) ctx.getSystemService(Context.KEYGUARD_SERVICE);
        return km != null && km.isDeviceSecure();
    }

    /** What the prompt accepts: strong biometrics (fingerprint, secure face unlock) or the screen lock. */
    static int authenticators() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            return BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL;
        }
        // Android 9–10 don't support STRONG together with the screen lock in one prompt.
        return BiometricManager.Authenticators.BIOMETRIC_WEAK | BiometricManager.Authenticators.DEVICE_CREDENTIAL;
    }

    static boolean biometricEnrolled(Context ctx) {
        int strength = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R ? BiometricManager.Authenticators.BIOMETRIC_STRONG : BiometricManager.Authenticators.BIOMETRIC_WEAK;
        return BiometricManager.from(ctx).canAuthenticate(strength) == BiometricManager.BIOMETRIC_SUCCESS;
    }

    static boolean locked(Context ctx) {
        return enabled(ctx) && !unlocked;
    }

    static void markUnlocked() {
        unlocked = true;
        backgroundSince = -1;
    }

    // ───────────── activity lifecycle (MainActivity) ─────────────

    static void onPause(Activity a) {
        if (enabled(a) && unlocked && !authInProgress) showCover(a);
    }

    static void onStop(Activity a) {
        if (enabled(a) && unlocked && !authInProgress) backgroundSince = SystemClock.elapsedRealtime();
    }

    /** Back in the foreground. Returns true when the app has just locked itself. */
    static boolean onStart(Activity a) {
        if (!enabled(a) || authInProgress) return false;
        if (unlocked && backgroundSince >= 0 && SystemClock.elapsedRealtime() - backgroundSince >= timeoutMs(a)) {
            unlocked = false;
            backgroundSince = -1;
            showCover(a);
            return true;
        }
        backgroundSince = -1;
        return false;
    }

    static void onResume(Activity a) {
        if (!locked(a)) hideCover(a);
    }

    static void showCover(Activity a) {
        if (cover != null) return;
        FrameLayout v = new FrameLayout(a);
        v.setBackgroundColor(Color.parseColor("#0b0c0a"));
        v.setClickable(true); // swallow touches meant for the content underneath
        a.addContentView(v, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        cover = v;
    }

    static void hideCover(Activity a) {
        if (cover == null) return;
        ViewGroup parent = (ViewGroup) cover.getParent();
        if (parent != null) parent.removeView(cover);
        cover = null;
    }

    /** Keep the app's content out of the recent-apps thumbnail while the lock is on (Android 13+). */
    static void applyRecentsPolicy(Activity a) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) a.setRecentsScreenshotEnabled(!enabled(a));
    }
}
