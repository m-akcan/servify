/**
 * This app's version, and which Servify servers may be told about it.
 *
 * The version comes from mobile/package.json at build time; the versionCode is derived the same way as in
 * android/app/build.gradle (major·10000 + minor·100 + patch), so it is what Android compares.
 *
 * Every API request carries `X-Servify-App: <versionName>/<versionCode>` (recorded on the device token, shown in the
 * dashboard) — but only to a server whose /auth/status lists the 'app-version-header' feature: older ones answer
 * CORS preflights without that header, which would make every request fail.
 */
declare const __APP_VERSION__: string;

export const APP_VERSION: string = __APP_VERSION__;
export const APP_VERSION_CODE: number = (() => {
  const [a, b, c] = APP_VERSION.split('.').map((x) => Number.parseInt(x, 10) || 0);
  return a * 10000 + b * 100 + c;
})();
export const APP_HEADER = `${APP_VERSION}/${APP_VERSION_CODE}`;

/** Features each server announced in /auth/status, by base URL (for this run of the app). */
const features = new Map<string, Set<string>>();

export function noteFeatures(base: string, list: unknown) {
  features.set(base, new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []));
}
/** undefined: not known yet (no /auth/status answer from this server so far). */
export function serverHas(base: string, feature: string): boolean | undefined {
  const f = features.get(base);
  return f ? f.has(feature) : undefined;
}
/** Headers that identify the app to this server, when it understands them. */
export function appHeaders(base: string): Record<string, string> {
  return serverHas(base, 'app-version-header') ? { 'x-servify-app': APP_HEADER } : {};
}
