import { Capacitor, registerPlugin } from '@capacitor/core';

/** Native secret store (Android Keystore, see SecureStorePlugin.java). */
interface SecureStorePlugin {
  get(o: { key: string }): Promise<{ value: string | null }>;
  set(o: { key: string; value: string }): Promise<void>;
  remove(o: { key: string }): Promise<void>;
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
