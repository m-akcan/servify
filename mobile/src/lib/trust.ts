import { Capacitor, registerPlugin } from '@capacitor/core';

/** What a server's TLS certificate looks like to this phone (ServerTrustPlugin.inspect). Nothing is sent to it. */
export type Inspection = {
  origin: string;
  reachable: boolean;
  error?: string;
  /** It answered with a TLS certificate at all. */
  tls?: boolean;
  /** A public CA (one Android trusts) issued it. */
  systemTrusted?: boolean;
  /** The certificate names the host the app connects to. */
  hostMatches?: boolean;
  names?: string[];
  leafSubject?: string;
  /** The CA that could be pinned, when there is one. */
  ca?: { subject: string; fingerprint: string; notAfter: number; isLeaf: boolean };
  /** Why no CA can be offered. */
  caProblem?: string;
  /** Fingerprint of the CA pinned for this server, if any. */
  pinned: string | null;
  /** The certificate verifies against that pin. */
  pinMatches?: boolean;
};

interface ServerTrustPlugin {
  inspect(o: { url: string }): Promise<Inspection>;
  pin(o: { url: string; fingerprint: string }): Promise<void>;
  unpin(o: { url: string }): Promise<void>;
  pinned(o: { url: string }): Promise<{ fingerprint: string | null }>;
  prune(o: { keep: string[] }): Promise<void>;
}

const native = registerPlugin<ServerTrustPlugin>('ServerTrust');
const isNative = Capacitor.isNativePlatform();
const isHttps = (url: string) => url.startsWith('https://');

/** Per-server trust for Servify's own CA (see ServerTrust.java). A no-op in a desktop browser. */
export const trust = {
  available: isNative,
  inspect: (url: string): Promise<Inspection | null> => (isNative && isHttps(url) ? native.inspect({ url }) : Promise.resolve(null)),
  pin: (url: string, fingerprint: string) => native.pin({ url, fingerprint }),
  unpin: (url: string) => (isNative && isHttps(url) ? native.unpin({ url }) : Promise.resolve()),
  pinned: async (url: string): Promise<string | null> => (isNative && isHttps(url) ? (await native.pinned({ url })).fingerprint : null),
  /** Forget pins for servers that aren't saved (e.g. trusted, then never signed in). */
  prune: (keep: string[]) => (isNative ? native.prune({ keep }).catch(() => {}) : Promise.resolve()),
};

/** "AB:CD:EF:…" in rows of 8 bytes, which is easier to compare by eye. */
export function fingerprintRows(fp: string): string[] {
  const parts = fp.split(':');
  const rows: string[] = [];
  for (let i = 0; i < parts.length; i += 8) rows.push(parts.slice(i, i + 8).join(':'));
  return rows;
}

/** The CN of an X.500 name ("CN=Servify Local CA (…),O=Servify" → "Servify Local CA (…)"). */
export function commonName(dn: string | undefined): string {
  const m = dn?.match(/(?:^|,)\s*CN=((?:\\,|[^,])+)/);
  return m ? m[1].replace(/\\,/g, ',') : (dn ?? '');
}
