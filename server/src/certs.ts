/**
 * TLS certificates for the HTTPS router.
 *
 *  • ACME (Let's Encrypt or any ACME CA) for real domains, via HTTP-01 on the HTTP router. Only hosts in the
 *    routing table are ever requested; failures back off exponentially so we never hammer rate limits.
 *  • A local certificate authority for everything else (*.localhost …), minted on demand. Trust its root
 *    (Settings → HTTPS → Download) to get a green lock locally.
 */
import 'reflect-metadata';
import * as x509 from '@peculiar/x509';
import acme from 'acme-client';
import tls from 'node:tls';
import http from 'node:http';
import { webcrypto, X509Certificate, randomBytes } from 'node:crypto';
import { certsTable, kv, services as servicesTable, projects as projectsTable } from './db.ts';
import { seal, open, sealJson, openJson } from './crypto.ts';
import { getSettings } from './settings.ts';
import { config } from './config.ts';
import { bus } from './events.ts';
import { notify } from './notify.ts';
import type { CertRecord, PublicCert } from './types.ts';

x509.cryptoProvider.set(webcrypto as any);
const ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;

const LETSENCRYPT = 'https://acme-v02.api.letsencrypt.org/directory';
const LETSENCRYPT_STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory';
const RENEW_BEFORE_MS = 30 * 86400_000;

// ───────────────────────────── local CA ─────────────────────────────

type CaMaterial = { certPem: string; keyPem: string };
let caPromise: Promise<CaMaterial> | null = null;

function pem(label: string, der: ArrayBuffer) {
  const b64 = Buffer.from(der).toString('base64').match(/.{1,64}/g)!.join('\n');
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

async function importPkcs8(keyPem: string) {
  const der = Buffer.from(keyPem.replace(/-----[^-]+-----|\s/g, ''), 'base64');
  return webcrypto.subtle.importKey('pkcs8', der, ALG, true, ['sign']);
}

function localCa(): Promise<CaMaterial> {
  if (caPromise) return caPromise;
  caPromise = (async () => {
    const stored = kv.get('local_ca');
    if (stored) return openJson<CaMaterial>(stored);
    const keys = await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: randomBytes(8).toString('hex'),
      name: `CN=Servify Local CA (${config.dataDir.split('/').slice(-2).join('/')}), O=Servify`,
      notBefore: new Date(Date.now() - 3600_000),
      notAfter: new Date(Date.now() + 10 * 365 * 86400_000),
      keys: keys as any,
      signingAlgorithm: ALG,
      extensions: [new x509.BasicConstraintsExtension(true, 0, true), new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true)],
    });
    const mat = { certPem: cert.toString('pem').trim() + '\n', keyPem: pem('PRIVATE KEY', await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)) };
    kv.set('local_ca', sealJson(mat));
    return mat;
  })();
  return caPromise;
}

export async function localCaPem(): Promise<string> {
  return (await localCa()).certPem;
}

const localLeaves = new Map<string, Promise<tls.SecureContext>>();

function localLeaf(host: string): Promise<tls.SecureContext> {
  const hit = localLeaves.get(host);
  if (hit) return hit;
  const p = (async () => {
    const ca = await localCa();
    const caKey = await importPkcs8(ca.keyPem);
    const keys = await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
    const names: x509.JsonGeneralName[] = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? [{ type: 'ip', value: host }] : [{ type: 'dns', value: host }];
    const cert = await x509.X509CertificateGenerator.create({
      serialNumber: randomBytes(8).toString('hex'),
      subject: `CN=${host}`,
      issuer: new x509.X509Certificate(ca.certPem).subject,
      notBefore: new Date(Date.now() - 3600_000),
      notAfter: new Date(Date.now() + 397 * 86400_000),
      publicKey: keys.publicKey as any,
      signingKey: caKey as any,
      signingAlgorithm: ALG,
      extensions: [new x509.SubjectAlternativeNameExtension(names), new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]), new x509.BasicConstraintsExtension(false)],
    });
    return tls.createSecureContext({ key: pem('PRIVATE KEY', await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)), cert: cert.toString('pem').trim() + '\n' + ca.certPem.trim() + '\n' });
  })();
  localLeaves.set(host, p);
  p.catch(() => localLeaves.delete(host));
  if (localLeaves.size > 500) localLeaves.delete(localLeaves.keys().next().value!);
  return p;
}

// ───────────────────────────── which hosts need public certificates ─────────────────────────────

/** Hostnames that can never get a public certificate. */
export function isLocalHost(host: string): boolean {
  return host === 'localhost' || /\.(localhost|local|test|internal|lan|home\.arpa)$/.test(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host) || !host.includes('.');
}

export function wantedHosts(): string[] {
  const hosts = new Set<string>();
  const projects = new Map(projectsTable.all().map((p) => [p.id, p]));
  for (const s of servicesTable.all()) {
    if (s.protocol !== 'http') continue;
    for (const d of s.domains) if (!isLocalHost(d)) hosts.add(d.toLowerCase());
    const p = projects.get(s.projectId);
    if (p && s.publicHttp && !isLocalHost(config.baseDomain)) hosts.add(`${s.slug}.${p.slug}.${config.baseDomain}`.toLowerCase());
  }
  return [...hosts].sort();
}

// ───────────────────────────── ACME ─────────────────────────────

/** HTTP-01 challenge responses, served by the HTTP router at /.well-known/acme-challenge/<token>. */
const challenges = new Map<string, string>();
export function challengeResponse(token: string): string | null {
  return challenges.get(token) ?? null;
}

function directoryUrl(): string {
  const h = getSettings().https;
  return h.directoryUrl || (h.staging ? LETSENCRYPT_STAGING : LETSENCRYPT);
}

async function accountKey(dir: string): Promise<Buffer> {
  const k = `acme_account:${dir}`;
  const stored = kv.get(k);
  if (stored) return Buffer.from(open(stored));
  const key = await acme.crypto.createPrivateEcdsaKey();
  kv.set(k, seal(key.toString()));
  return key;
}

function publicCert(r: CertRecord): PublicCert {
  const { certPem, keySealed, ...rest } = r;
  return rest;
}

function save(r: CertRecord) {
  if (certsTable.get(r.id)) certsTable.put(r);
  else certsTable.insert(r);
  bus.publish({ type: 'cert.updated', cert: publicCert(r) });
  issuedContexts.delete(r.id);
  // Service views carry per-domain TLS status and https URLs: refresh the ones using this host.
  const projects = new Map(projectsTable.all().map((p) => [p.id, p]));
  for (const s of servicesTable.all()) {
    const p = projects.get(s.projectId);
    if (s.domains.includes(r.host) || (p && `${s.slug}.${p.slug}.${config.baseDomain}` === r.host)) bus.publish({ type: 'service.updated', service: s });
  }
}

/** Before spending a CA attempt, check that port 80 for this name actually reaches us. */
async function selfCheck(host: string): Promise<string | null> {
  const token = `servify-probe-${randomBytes(8).toString('hex')}`;
  challenges.set(token, token);
  try {
    const body = await new Promise<string>((resolve, reject) => {
      const req = http.get({ host, port: 80, path: `/.well-known/acme-challenge/${token}`, timeout: 8000 }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve(b));
      });
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', reject);
    });
    return body.trim() === token ? null : `http://${host}/ answered, but not from this Servify — check the DNS record`;
  } catch (e) {
    return `could not reach http://${host}/ (${(e as Error).message}). Point the domain's DNS at this machine and forward port 80 to the Servify router`;
  } finally {
    challenges.delete(token);
  }
}

const inflight = new Set<string>();

async function issue(host: string, opts: { skipCheck?: boolean } = {}) {
  if (inflight.has(host)) return;
  inflight.add(host);
  const prev = certsTable.get(host);
  const now = Date.now();
  const rec: CertRecord = prev ?? {
    id: host,
    host,
    status: 'pending',
    issuer: 'acme',
    expiresAt: null,
    issuedAt: null,
    lastAttemptAt: null,
    nextAttemptAt: null,
    attempts: 0,
    error: null,
    createdAt: now,
  };
  rec.lastAttemptAt = now;
  rec.attempts++;
  if (rec.status !== 'issued') rec.status = 'pending';
  rec.error = null;
  save(rec);
  try {
    const s = getSettings().https;
    const dir = directoryUrl();
    if (!opts.skipCheck && !s.directoryUrl) {
      const problem = await selfCheck(host);
      if (problem) throw new Error(problem);
    }
    const client = new acme.Client({ directoryUrl: dir, accountKey: await accountKey(dir) });
    const [key, csr] = await acme.crypto.createCsr({ commonName: host, altNames: [host] }, await acme.crypto.createPrivateEcdsaKey());
    const chain = await client.auto({
      csr,
      email: s.email,
      termsOfServiceAgreed: true,
      challengePriority: ['http-01'],
      // Our own selfCheck() already proved reachability; the library's check would hang on NAT/hairpin setups.
      skipChallengeVerification: true,
      challengeCreateFn: async (_authz, challenge, keyAuthorization) => {
        challenges.set(challenge.token, keyAuthorization);
      },
      challengeRemoveFn: async (_authz, challenge) => {
        challenges.delete(challenge.token);
      },
    });
    const leaf = new X509Certificate(chain);
    rec.status = 'issued';
    rec.issuedAt = Date.now();
    rec.expiresAt = Date.parse(leaf.validTo);
    rec.certPem = chain;
    rec.keySealed = seal(key.toString());
    rec.attempts = 0;
    rec.nextAttemptAt = null;
    rec.error = null;
    save(rec);
    console.log(`[certs] issued ${host} (expires ${leaf.validTo})`);
  } catch (e) {
    const msg = (e as Error).message || String(e);
    rec.error = msg.slice(0, 500);
    // Keep serving a still-valid certificate if this was a renewal.
    if (!(rec.certPem && rec.expiresAt && rec.expiresAt > Date.now())) rec.status = 'failed';
    rec.nextAttemptAt = Date.now() + Math.min(24 * 3600_000, 5 * 60_000 * 2 ** Math.min(8, rec.attempts - 1));
    save(rec);
    console.error(`[certs] ${host}: ${msg}`);
    notify({ event: 'cert.failed', level: 'error', title: `Certificate for ${host} failed`, message: msg.slice(0, 400), dedupeKey: `cert:${host}`, dedupeMs: 6 * 3600_000 });
  } finally {
    inflight.delete(host);
  }
}

let syncing = false;
export async function syncCertificates() {
  if (syncing) return;
  syncing = true;
  try {
    const s = getSettings().https;
    const wanted = new Set(s.enabled ? wantedHosts() : []);
    // Forget certificates for hosts that are no longer routed.
    for (const r of certsTable.all()) {
      if (!wanted.has(r.id) && r.issuer === 'acme' && Date.now() - (r.lastAttemptAt ?? 0) > 60_000) {
        certsTable.delete(r.id);
        issuedContexts.delete(r.id);
      }
    }
    if (!s.enabled) return;
    for (const host of wanted) {
      const r = certsTable.get(host);
      const due =
        !r ||
        (r.status === 'issued' && (r.expiresAt ?? 0) - Date.now() < RENEW_BEFORE_MS && (r.nextAttemptAt ?? 0) <= Date.now()) ||
        (r.status !== 'issued' && (r.nextAttemptAt ?? 0) <= Date.now());
      if (due) await issue(host); // one at a time
    }
  } finally {
    syncing = false;
  }
}

export async function retryCertificate(host: string) {
  const r = certsTable.get(host);
  if (r) {
    r.nextAttemptAt = null;
    r.attempts = 0;
    save(r);
  }
  void issue(host, { skipCheck: true });
}

export function listCertificates(): PublicCert[] {
  const wanted = new Set(wantedHosts());
  return certsTable
    .all()
    .map(publicCert)
    .concat([...wanted].filter((h) => !certsTable.get(h)).map((h) => ({ id: h, host: h, status: 'pending' as const, issuer: 'acme' as const, expiresAt: null, issuedAt: null, lastAttemptAt: null, nextAttemptAt: null, attempts: 0, error: null, createdAt: Date.now() })))
    .sort((a, b) => a.host.localeCompare(b.host));
}

/** True when the HTTPS router holds a trusted certificate for this host. */
export function hasPublicCert(host: string): boolean {
  if (!getSettings().https.enabled) return false;
  const r = certsTable.get(host.toLowerCase());
  return !!r && !!r.certPem && (r.expiresAt ?? 0) > Date.now();
}

// ───────────────────────────── SNI ─────────────────────────────

const issuedContexts = new Map<string, tls.SecureContext>();

export function sniCallback(servername: string, cb: (err: Error | null, ctx?: tls.SecureContext) => void) {
  const host = (servername || 'localhost').toLowerCase();
  const rec = hasPublicCert(host) ? certsTable.get(host) : null;
  if (rec?.certPem && rec.keySealed) {
    let ctx = issuedContexts.get(host);
    if (!ctx) {
      try {
        ctx = tls.createSecureContext({ cert: rec.certPem, key: open(rec.keySealed) });
        issuedContexts.set(host, ctx);
      } catch (e) {
        return cb(e as Error);
      }
    }
    return cb(null, ctx);
  }
  localLeaf(host).then((ctx) => cb(null, ctx), (e) => cb(e));
}

export async function defaultContextOptions(): Promise<{ key: string; cert: string }> {
  const ca = await localCa();
  // A throwaway self-signed default for clients that send no SNI at all.
  const keys = await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
  const caKey = await importPkcs8(ca.keyPem);
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: randomBytes(8).toString('hex'),
    subject: 'CN=localhost',
    issuer: new x509.X509Certificate(ca.certPem).subject,
    notBefore: new Date(Date.now() - 3600_000),
    notAfter: new Date(Date.now() + 397 * 86400_000),
    publicKey: keys.publicKey as any,
    signingKey: caKey as any,
    signingAlgorithm: ALG,
    extensions: [new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: 'localhost' }, { type: 'ip', value: '127.0.0.1' }])],
  });
  return { key: pem('PRIVATE KEY', await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)), cert: cert.toString('pem').trim() + '\n' + ca.certPem.trim() + '\n' };
}

export function startCertificates() {
  let timer: NodeJS.Timeout | null = null;
  const soon = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void syncCertificates().catch((e) => console.error('[certs]', e)), 5000);
  };
  bus.subscribe((ev) => {
    if (ev.type === 'service.updated' || ev.type === 'service.deleted' || ev.type === 'settings.updated' || ev.type === 'project.updated') soon();
  });
  soon();
  setInterval(() => void syncCertificates().catch(() => {}), 10 * 60_000);
}
