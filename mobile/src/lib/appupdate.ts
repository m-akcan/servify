/**
 * Updating the app from the user's own Servify. Each Servify mirrors the Android app from its signed release
 * (GET /api/mobile/app); when that one is newer than this app, a banner offers it.
 *
 * Downloading, checking and installing happen natively (AppUpdatePlugin.java): the APK is fetched with the device
 * token over the same per-server certificate trust as the WebView, its SHA-256 and size must match the server's
 * answer, and it must be signed with the same certificate as this app (and be this app, with a higher versionCode)
 * before Android's installer is opened. Android shows its own confirmation, and refuses an update signed by anyone
 * else anyway.
 */
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { Client } from './client.ts';
import { APP_VERSION_CODE, serverHas } from './appversion.ts';

/** GET /api/mobile/app */
export type MobileApp = {
  available: boolean;
  versionName: string | null;
  versionCode: number | null;
  sha256: string | null;
  size: number | null;
  signerSha256: string | null;
  reason?: string;
};

/** A newer app the server offers. */
export type AppUpdate = { versionName: string; versionCode: number; sha256: string; size: number };

export type UpdateErrorCode = 'locked' | 'network' | 'tls' | 'http' | 'size' | 'hash' | 'signer' | 'package' | 'version' | 'unreadable' | 'not_allowed' | 'no_download' | 'install' | 'failed';
export const updateErrorCode = (e: unknown): UpdateErrorCode | undefined => (e as { code?: UpdateErrorCode })?.code;

interface AppUpdatePlugin {
  /** Whether Android lets this app install updates ("Install unknown apps"), and the installed version. */
  status(): Promise<{ canInstall: boolean; versionName: string; versionCode: number }>;
  openInstallSettings(): Promise<void>;
  download(o: { url: string; token: string; sha256: string; size: number; versionCode: number }): Promise<{ versionName: string; versionCode: number }>;
  install(): Promise<void>;
  addListener(event: 'progress', fn: (p: { received: number; total: number }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'installStatus', fn: (s: { status: 'pending_user_action' | 'success' | 'failed'; message?: string }) => void): Promise<PluginListenerHandle>;
}

const native = registerPlugin<AppUpdatePlugin>('AppUpdate');
const isNative = Capacitor.isNativePlatform();

const CHECK_EVERY = 6 * 3600_000;
const cacheKey = (serverId: string) => `servify.appUpdate:${serverId}`;
const DISMISSED_KEY = 'servify.appUpdate.dismissed';

function readCache(serverId: string): { at: number; update: AppUpdate | null } | null {
  try {
    const v = localStorage.getItem(cacheKey(serverId));
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
}
function writeCache(serverId: string, update: AppUpdate | null) {
  try {
    localStorage.setItem(cacheKey(serverId), JSON.stringify({ at: Date.now(), update }));
  } catch {
    /* checked again next time */
  }
}
export function dismissedCode(): number {
  try {
    return Number(localStorage.getItem(DISMISSED_KEY)) || 0;
  } catch {
    return 0;
  }
}
export function dismiss(versionCode: number) {
  try {
    localStorage.setItem(DISMISSED_KEY, String(versionCode));
  } catch {
    /* shown again next time */
  }
}

// The update on offer for the server in use, shared by the banner and Settings.
let offered: AppUpdate | null = null;
const listeners = new Set<(u: AppUpdate | null) => void>();
function setOffered(u: AppUpdate | null) {
  offered = u && u.versionCode > APP_VERSION_CODE ? u : null;
  listeners.forEach((f) => f(offered));
}
export const currentOffer = () => offered;
export function onOffer(fn: (u: AppUpdate | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Ask the server which app it offers. At most every 6 hours per server unless `force` (Settings → Check for
 * updates). Resolves with the newer app, or null. A Servify without the mirror (older ones) offers nothing.
 */
export async function checkForAppUpdate(serverId: string, api: Client, opts: { force?: boolean } = {}): Promise<AppUpdate | null> {
  const cached = readCache(serverId);
  if (!opts.force && cached && Date.now() - cached.at < CHECK_EVERY) {
    setOffered(cached.update);
    return offered;
  }
  if (serverHas(api.base, 'mobile-app') === undefined) await api.get('/auth/status').catch(() => null);
  if (!serverHas(api.base, 'mobile-app')) {
    writeCache(serverId, null);
    setOffered(null);
    return null;
  }
  const info = await api.get<MobileApp>('/mobile/app');
  const update: AppUpdate | null =
    info.available && info.versionName && info.versionCode && info.sha256 && info.size && info.versionCode > APP_VERSION_CODE
      ? { versionName: info.versionName, versionCode: info.versionCode, sha256: info.sha256, size: info.size }
      : null;
  writeCache(serverId, update);
  setOffered(update);
  return update;
}

/** Forget the cached answers (another server, or signed out). */
export function resetOffer() {
  setOffered(null);
}

export const appUpdate = {
  available: isNative,
  status: () => (isNative ? native.status() : Promise.resolve({ canInstall: false, versionName: '', versionCode: APP_VERSION_CODE })),
  openInstallSettings: () => (isNative ? native.openInstallSettings() : Promise.resolve()),
  download: (base: string, token: string, u: AppUpdate) => native.download({ url: `${base}/api/mobile/app.apk`, token, sha256: u.sha256, size: u.size, versionCode: u.versionCode }),
  install: () => native.install(),
  onProgress(fn: (p: { received: number; total: number }) => void): () => void {
    if (!isNative) return () => {};
    const h = native.addListener('progress', fn);
    return () => void h.then((x) => x.remove());
  },
  onInstallStatus(fn: (s: { status: 'pending_user_action' | 'success' | 'failed'; message?: string }) => void): () => void {
    if (!isNative) return () => {};
    const h = native.addListener('installStatus', fn);
    return () => void h.then((x) => x.remove());
  },
};
