package cloud.servify.app;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.provider.Settings;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.security.keystore.UserNotAuthenticatedException;
import android.util.Base64;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Small secret store for sign-in tokens, and the app lock that guards it.
 *
 * Values are encrypted with AES-256-GCM keys that live in the Android Keystore (in the device's secure hardware
 * where available) and the ciphertext is kept in the app's private preferences.
 *
 *  - Lock off: key "servify_secure_store", usable any time (entries "v1:<key>"), as in 0.1.x.
 *  - Lock on: key "servify_secure_store_locked", which the Keystore only lets the app use for
 *    LOCKED_VALIDITY_S seconds after the user authenticated with a strong biometric or the screen lock
 *    (entries "v2:<key>"). Without unlocking, the token can't be decrypted, even by the app itself. Removing
 *    the screen lock destroys that key, and with it the tokens: the app then turns the lock off and asks to
 *    sign in again.
 *
 * A value that can't be decrypted for good (for example after a restore onto another phone) reads as missing,
 * so the app asks to sign in again. "Not authenticated right now" never deletes anything.
 */
@CapacitorPlugin(name = "SecureStore")
public class SecureStorePlugin extends Plugin {
    private static final String TAG = "AppLock";
    private static final String KEY_ALIAS = "servify_secure_store";
    private static final String LOCKED_ALIAS = "servify_secure_store_locked";
    private static final String PREFS = "servify_secure_store";
    private static final String PLAIN = "v1:";
    private static final String LOCKED = "v2:";
    private static final int IV_BYTES = 12;
    private static final int LOCKED_VALIDITY_S = 30;

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static KeyStore keystore() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        return ks;
    }

    private SecretKey plainKey() throws Exception {
        KeyStore.Entry entry = keystore().getEntry(KEY_ALIAS, null);
        if (entry instanceof KeyStore.SecretKeyEntry) return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
        KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        gen.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return gen.generateKey();
    }

    private SecretKey lockedKey() throws Exception {
        KeyStore.Entry entry = keystore().getEntry(LOCKED_ALIAS, null);
        if (entry instanceof KeyStore.SecretKeyEntry) return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
        throw new KeyPermanentlyInvalidatedException("the app lock key is gone");
    }

    private static void newLockedKey() throws Exception {
        keystore().deleteEntry(LOCKED_ALIAS);
        KeyGenParameterSpec.Builder b = new KeyGenParameterSpec.Builder(LOCKED_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(true)
                .setInvalidatedByBiometricEnrollment(false); // adding a fingerprint must not sign the phone out
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            b.setUserAuthenticationParameters(LOCKED_VALIDITY_S, KeyProperties.AUTH_BIOMETRIC_STRONG | KeyProperties.AUTH_DEVICE_CREDENTIAL);
        } else {
            b.setUserAuthenticationValidityDurationSeconds(LOCKED_VALIDITY_S);
        }
        KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        gen.init(b.build());
        gen.generateKey();
    }

    private static String seal(SecretKey key, String value) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key);
        byte[] iv = cipher.getIV();
        byte[] sealed = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        ByteBuffer buf = ByteBuffer.allocate(iv.length + sealed.length);
        buf.put(iv).put(sealed);
        return Base64.encodeToString(buf.array(), Base64.NO_WRAP);
    }

    private static String open(SecretKey key, String stored) throws Exception {
        byte[] all = Base64.decode(stored, Base64.NO_WRAP);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, all, 0, IV_BYTES));
        return new String(cipher.doFinal(all, IV_BYTES, all.length - IV_BYTES), StandardCharsets.UTF_8);
    }

    private List<String> keysWith(String prefix) {
        List<String> out = new ArrayList<>();
        for (Map.Entry<String, ?> e : prefs().getAll().entrySet()) if (e.getKey().startsWith(prefix)) out.add(e.getKey().substring(prefix.length()));
        return out;
    }

    // ───────────── prompt ─────────────

    private interface Done {
        void ok();

        void fail(int code, String message);
    }

    private void authenticate(String title, String subtitle, Done done) {
        FragmentActivity activity = (FragmentActivity) getActivity();
        activity.runOnUiThread(() -> {
            AppLock.authInProgress = true;
            BiometricPrompt prompt = new BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                    AppLock.authInProgress = false;
                    done.ok();
                }

                @Override
                public void onAuthenticationError(int code, @NonNull CharSequence message) {
                    AppLock.authInProgress = false;
                    done.fail(code, message.toString());
                }
            });
            BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
                    .setTitle(title)
                    .setSubtitle(subtitle)
                    .setAllowedAuthenticators(AppLock.authenticators())
                    .setConfirmationRequired(false)
                    .build();
            try {
                prompt.authenticate(info);
            } catch (Exception e) {
                AppLock.authInProgress = false;
                done.fail(-1, e.getMessage() == null ? "can't show the unlock prompt" : e.getMessage());
            }
        });
    }

    private static String failCode(int code) {
        switch (code) {
            case BiometricPrompt.ERROR_USER_CANCELED:
            case BiometricPrompt.ERROR_NEGATIVE_BUTTON:
            case BiometricPrompt.ERROR_CANCELED:
                return "cancelled";
            case BiometricPrompt.ERROR_LOCKOUT:
            case BiometricPrompt.ERROR_LOCKOUT_PERMANENT:
                return "lockout";
            case BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL:
                return "no_screen_lock";
            default:
                return "failed";
        }
    }

    /** Run `op`; if the locked key needs a fresh authentication, ask once and run it again. */
    private interface Op {
        void run() throws Exception;
    }

    private void withLockedKey(PluginCall call, Op op) {
        try {
            op.run();
        } catch (UserNotAuthenticatedException e) {
            authenticate("Unlock Servify", "Confirm it's you to use your sign-in", new Done() {
                @Override
                public void ok() {
                    AppLock.markUnlocked();
                    try {
                        op.run();
                    } catch (KeyPermanentlyInvalidatedException e2) {
                        lockKeyLost();
                        call.reject("The app lock was reset. Sign in again.", "lock_reset");
                    } catch (Exception e2) {
                        call.reject("could not use the secure store: " + e2.getMessage(), "failed");
                    }
                }

                @Override
                public void fail(int code, String message) {
                    call.reject(message, failCode(code));
                }
            });
        } catch (KeyPermanentlyInvalidatedException e) {
            lockKeyLost();
            call.reject("The app lock was reset. Sign in again.", "lock_reset");
        } catch (Exception e) {
            call.reject("could not use the secure store: " + e.getMessage(), "failed");
        }
    }

    /**
     * The screen lock was removed (or the key is otherwise gone): the locked tokens can never be read again.
     * Forget them, turn the lock off and remember to tell the user why they have to sign in again.
     */
    private void lockKeyLost() {
        Log.w(TAG, "app lock key invalidated; tokens dropped, lock turned off");
        SharedPreferences.Editor ed = prefs().edit();
        for (String k : keysWith(LOCKED)) ed.remove(LOCKED + k);
        ed.commit();
        try {
            keystore().deleteEntry(LOCKED_ALIAS);
        } catch (Exception ignored) {
        }
        AppLock.prefs(getContext()).edit().putBoolean("enabled", false).putBoolean("wasReset", true).commit();
        AppLock.unlocked = true;
        getActivity().runOnUiThread(() -> {
            AppLock.applyRecentsPolicy(getActivity());
            AppLock.hideCover(getActivity());
        });
    }

    /** With the lock on: still usable? (Throws KeyPermanentlyInvalidatedException when not; never prompts.) */
    private void checkLockedKey() throws Exception {
        if (!AppLock.deviceSecure(getContext())) throw new KeyPermanentlyInvalidatedException("no screen lock");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        try {
            cipher.init(Cipher.ENCRYPT_MODE, lockedKey());
        } catch (UserNotAuthenticatedException fine) {
            // usable after unlocking
        }
    }

    // ───────────── secrets ─────────────

    @PluginMethod
    public void set(PluginCall call) {
        String key = call.getString("key");
        String value = call.getString("value");
        if (key == null || value == null) {
            call.reject("key and value are required");
            return;
        }
        if (AppLock.enabled(getContext())) {
            if (AppLock.locked(getContext())) {
                call.reject("Servify is locked", "locked");
                return;
            }
            withLockedKey(call, () -> {
                String sealed = seal(lockedKey(), value);
                prefs().edit().putString(LOCKED + key, sealed).remove(PLAIN + key).commit();
                call.resolve();
            });
            return;
        }
        try {
            prefs().edit().putString(PLAIN + key, seal(plainKey(), value)).commit();
            call.resolve();
        } catch (Exception e) {
            call.reject("could not store the secret: " + e.getMessage());
        }
    }

    @PluginMethod
    public void get(PluginCall call) {
        String key = call.getString("key");
        if (key == null) {
            call.reject("key is required");
            return;
        }
        if (AppLock.enabled(getContext())) {
            if (AppLock.locked(getContext())) {
                call.reject("Servify is locked", "locked");
                return;
            }
            String stored = prefs().getString(LOCKED + key, null);
            if (stored == null) {
                JSObject ret = new JSObject();
                ret.put("value", null);
                call.resolve(ret);
                return;
            }
            withLockedKey(call, () -> {
                JSObject ret = new JSObject();
                try {
                    ret.put("value", open(lockedKey(), stored));
                } catch (UserNotAuthenticatedException | KeyPermanentlyInvalidatedException e) {
                    throw e;
                } catch (javax.crypto.AEADBadTagException e) {
                    prefs().edit().remove(LOCKED + key).commit(); // corrupt for good
                    ret.put("value", null);
                }
                call.resolve(ret);
            });
            return;
        }
        JSObject ret = new JSObject();
        String stored = prefs().getString(PLAIN + key, null);
        if (stored == null) {
            ret.put("value", null);
            call.resolve(ret);
            return;
        }
        try {
            ret.put("value", open(plainKey(), stored));
        } catch (Exception e) {
            // This key never needs authentication, so a failure here is permanent (e.g. restored onto another phone).
            prefs().edit().remove(PLAIN + key).commit();
            ret.put("value", null);
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String key = call.getString("key");
        if (key != null) prefs().edit().remove(PLAIN + key).remove(LOCKED + key).commit();
        call.resolve();
    }

    // ───────────── app lock ─────────────

    @PluginMethod
    public void lockStatus(PluginCall call) {
        Context ctx = getContext();
        if (AppLock.enabled(ctx)) {
            try {
                checkLockedKey();
            } catch (KeyPermanentlyInvalidatedException e) {
                lockKeyLost();
            } catch (Exception e) {
                // A passing Keystore hiccup must never cost the user their sign-ins: leave everything as it is.
                Log.w(TAG, "could not check the app lock key: " + e);
            }
        }
        boolean wasReset = AppLock.prefs(ctx).getBoolean("wasReset", false);
        if (wasReset) AppLock.prefs(ctx).edit().remove("wasReset").commit();
        JSObject ret = new JSObject();
        ret.put("enabled", AppLock.enabled(ctx));
        ret.put("locked", AppLock.locked(ctx));
        ret.put("available", AppLock.deviceSecure(ctx));
        ret.put("biometrics", AppLock.biometricEnrolled(ctx));
        ret.put("timeoutMs", AppLock.timeoutMs(ctx));
        ret.put("wasReset", wasReset);
        call.resolve(ret);
    }

    @PluginMethod
    public void unlock(PluginCall call) {
        if (!AppLock.locked(getContext())) {
            call.resolve();
            return;
        }
        authenticate("Unlock Servify", "Use your fingerprint, face or screen lock", new Done() {
            @Override
            public void ok() {
                AppLock.markUnlocked();
                getActivity().runOnUiThread(() -> AppLock.hideCover(getActivity()));
                call.resolve();
            }

            @Override
            public void fail(int code, String message) {
                call.reject(message, failCode(code));
            }
        });
    }

    /** The JS lock screen is showing, so the native cover can go. */
    @PluginMethod
    public void lockScreenShown(PluginCall call) {
        getActivity().runOnUiThread(() -> AppLock.hideCover(getActivity()));
        call.resolve();
    }

    @PluginMethod
    public void enableLock(PluginCall call) {
        Context ctx = getContext();
        if (AppLock.enabled(ctx)) {
            call.resolve();
            return;
        }
        if (!AppLock.deviceSecure(ctx)) {
            call.reject("Set a screen lock (PIN, pattern or password) on this phone first.", "no_screen_lock");
            return;
        }
        try {
            newLockedKey();
        } catch (Exception e) {
            call.reject("could not create the lock key: " + e.getMessage(), "failed");
            return;
        }
        authenticate("Turn on app lock", "Confirm with your fingerprint, face or screen lock", new Done() {
            @Override
            public void ok() {
                try {
                    // Re-encrypt every token under the locked key; the new copies are written before the old go.
                    SecretKey plain = plainKey();
                    SecretKey locked = lockedKey();
                    SharedPreferences.Editor ed = prefs().edit();
                    List<String> moved = keysWith(PLAIN);
                    for (String k : moved) {
                        try {
                            ed.putString(LOCKED + k, seal(locked, open(plain, prefs().getString(PLAIN + k, ""))));
                        } catch (UserNotAuthenticatedException e) {
                            throw e;
                        } catch (Exception unreadable) {
                            // already lost (see get()); nothing to move
                        }
                    }
                    ed.commit();
                    AppLock.prefs(ctx).edit().putBoolean("enabled", true).commit();
                    SharedPreferences.Editor clean = prefs().edit();
                    for (String k : moved) clean.remove(PLAIN + k);
                    clean.commit();
                    AppLock.markUnlocked();
                    getActivity().runOnUiThread(() -> AppLock.applyRecentsPolicy(getActivity()));
                    call.resolve();
                } catch (Exception e) {
                    SharedPreferences.Editor undo = prefs().edit();
                    for (String k : keysWith(LOCKED)) undo.remove(LOCKED + k);
                    undo.commit();
                    AppLock.prefs(ctx).edit().putBoolean("enabled", false).commit();
                    try {
                        keystore().deleteEntry(LOCKED_ALIAS);
                    } catch (Exception ignored) {
                    }
                    call.reject("could not turn the lock on: " + e.getMessage(), "failed");
                }
            }

            @Override
            public void fail(int code, String message) {
                try {
                    keystore().deleteEntry(LOCKED_ALIAS);
                } catch (Exception ignored) {
                }
                call.reject(message, failCode(code));
            }
        });
    }

    @PluginMethod
    public void disableLock(PluginCall call) {
        Context ctx = getContext();
        if (!AppLock.enabled(ctx)) {
            call.resolve();
            return;
        }
        authenticate("Turn off app lock", "Confirm with your fingerprint, face or screen lock", new Done() {
            @Override
            public void ok() {
                try {
                    SecretKey plain = plainKey();
                    SecretKey locked = lockedKey();
                    List<String> moved = keysWith(LOCKED);
                    SharedPreferences.Editor ed = prefs().edit();
                    for (String k : moved) {
                        try {
                            ed.putString(PLAIN + k, seal(plain, open(locked, prefs().getString(LOCKED + k, ""))));
                        } catch (UserNotAuthenticatedException | KeyPermanentlyInvalidatedException e) {
                            throw e;
                        } catch (Exception unreadable) {
                            // corrupt; dropped below
                        }
                    }
                    ed.commit();
                    AppLock.prefs(ctx).edit().putBoolean("enabled", false).commit();
                    SharedPreferences.Editor clean = prefs().edit();
                    for (String k : moved) clean.remove(LOCKED + k);
                    clean.commit();
                    keystore().deleteEntry(LOCKED_ALIAS);
                    AppLock.markUnlocked();
                    getActivity().runOnUiThread(() -> AppLock.applyRecentsPolicy(getActivity()));
                    call.resolve();
                } catch (KeyPermanentlyInvalidatedException e) {
                    lockKeyLost();
                    call.reject("The app lock was reset. Sign in again.", "lock_reset");
                } catch (Exception e) {
                    SharedPreferences.Editor undo = prefs().edit();
                    for (String k : keysWith(PLAIN)) undo.remove(PLAIN + k);
                    undo.commit();
                    AppLock.prefs(ctx).edit().putBoolean("enabled", true).commit();
                    call.reject("could not turn the lock off: " + e.getMessage(), "failed");
                }
            }

            @Override
            public void fail(int code, String message) {
                call.reject(message, failCode(code));
            }
        });
    }

    @PluginMethod
    public void setLockTimeout(PluginCall call) {
        // A JS number arrives as Integer or Double, which getLong() doesn't accept.
        long ms = call.getData().has("ms") ? call.getData().optLong("ms", -1) : -1;
        if (ms < 0 || ms > 24L * 3600_000) {
            call.reject("ms must be between 0 and a day");
            return;
        }
        AppLock.prefs(getContext()).edit().putLong("timeoutMs", ms).commit();
        call.resolve();
    }

    @PluginMethod
    public void openSecuritySettings(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_SECURITY_SETTINGS);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("can't open the settings");
        }
    }

    /** Called by MainActivity when the app locked itself after being in the background. */
    void notifyLocked() {
        notifyListeners("locked", new JSObject());
    }
}
