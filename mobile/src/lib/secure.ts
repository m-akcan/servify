import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export type LockStatus = {
  /** The app lock is on: tokens are encrypted with a key that needs a fresh unlock. */
  enabled: boolean;
  /** On and not unlocked yet in this run (or locked again after the background timeout). */
  locked: boolean;
  /** The phone has a screen lock (PIN, pattern or password), which the app lock needs. */
  available: boolean;
  /** A fingerprint or secure face unlock is enrolled. */
  biometrics: boolean;
  /** How long the app may stay in the background before it locks again (0 = right away). */
  timeoutMs: number;
  /** The lock was turned off because the screen lock was removed; the saved sign-ins are gone. Reported once. */
  wasReset: boolean;
};

/** Native secret store and app lock (Android Keystore + BiometricPrompt, see SecureStorePlugin.java). */
interface SecureStorePlugin {
  get(o: { key: string }): Promise<{ value: string | null }>;
  set(o: { key: string; value: string }): Promise<void>;
  remove(o: { key: string }): Promise<void>;
  lockStatus(): Promise<LockStatus>;
  unlock(): Promise<void>;
  lockScreenShown(): Promise<void>;
  enableLock(): Promise<void>;
  disableLock(): Promise<void>;
  setLockTimeout(o: { ms: number }): Promise<void>;
  openSecuritySettings(): Promise<void>;
  addListener(event: 'locked', fn: () => void): Promise<PluginListenerHandle>;
}

const native = registerPlugin<SecureStorePlugin>('SecureStore');
const isNative = Capacitor.isNativePlatform();

/** Sign-in tokens. On a phone they're encrypted by the Keystore; in a desktop browser (development only) sessionStorage. */
export const secure = {
  async get(key: string): Promise<string | null> {
    if (isNative) return (await native.get({ key })).value;
    try {
      return sessionStorage.getItem(`secure:${key}`);
    } catch {
      return null;
    }
  },
  async set(key: string, value: string): Promise<void> {
    if (isNative) return native.set({ key, value });
    try {
      sessionStorage.setItem(`secure:${key}`, value);
    } catch {
      /* development only */
    }
  },
  async remove(key: string): Promise<void> {
    if (isNative) return native.remove({ key });
    try {
      sessionStorage.removeItem(`secure:${key}`);
    } catch {
      /* development only */
    }
  },
};

const NO_LOCK: LockStatus = { enabled: false, locked: false, available: false, biometrics: false, timeoutMs: 60_000, wasReset: false };

/** Error codes the native side rejects with. */
export type LockError = 'cancelled' | 'lockout' | 'no_screen_lock' | 'lock_reset' | 'locked' | 'failed';
export const lockErrorCode = (e: unknown): LockError | undefined => (e as { code?: LockError })?.code;

export const appLock = {
  status: (): Promise<LockStatus> => (isNative ? native.lockStatus() : Promise.resolve(NO_LOCK)),
  unlock: () => (isNative ? native.unlock() : Promise.resolve()),
  shown: () => (isNative ? native.lockScreenShown().catch(() => {}) : Promise.resolve()),
  enable: () => (isNative ? native.enableLock() : Promise.reject(new Error('The app lock needs the Android app.'))),
  disable: () => (isNative ? native.disableLock() : Promise.resolve()),
  setTimeout: (ms: number) => (isNative ? native.setLockTimeout({ ms }) : Promise.resolve()),
  openSecuritySettings: () => (isNative ? native.openSecuritySettings() : Promise.resolve()),
  /** The app locked itself after being in the background. */
  onLocked(fn: () => void): () => void {
    if (!isNative) return () => {};
    const h = native.addListener('locked', fn);
    return () => void h.then((x) => x.remove());
  },
};
