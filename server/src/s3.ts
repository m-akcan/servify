/**
 * Minimal S3-compatible client (AWS S3, Cloudflare R2, MinIO, Backblaze B2, Wasabi…): PUT / GET / DELETE
 * with AWS Signature V4. Bodies are streamed from disk with a known length; payloads are UNSIGNED-PAYLOAD.
 */
import { createHash, createHmac } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { createReadStream, statSync } from 'node:fs';
import type { Readable } from 'node:stream';
import type { Destination } from './settings.ts';

const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
const sha256hex = (data: string) => createHash('sha256').update(data).digest('hex');
const encodeKey = (key: string) => key.split('/').map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');

function target(d: Destination, key: string): URL {
  const region = d.region || 'us-east-1';
  const endpoint = (d.endpoint || `https://s3.${region}.amazonaws.com`).replace(/\/+$/, '');
  const pathStyle = d.forcePathStyle ?? !!d.endpoint;
  const u = new URL(endpoint);
  if (pathStyle) u.pathname = `${u.pathname.replace(/\/+$/, '')}/${d.bucket}/${encodeKey(key)}`;
  else {
    u.hostname = `${d.bucket}.${u.hostname}`;
    u.pathname = `/${encodeKey(key)}`;
  }
  return u;
}

function sign(d: Destination, method: string, u: URL, extra: Record<string, string> = {}): Record<string, string> {
  const region = d.region || 'us-east-1';
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = { host: u.host, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'x-amz-date': amzDate, ...extra };
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const canonicalHeaders = names.map((n) => `${n}:${String(headers[Object.keys(headers).find((k) => k.toLowerCase() === n)!]).trim()}\n`).join('');
  const signed = names.join(';');
  const query = [...u.searchParams.entries()].sort().map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const canonical = [method, u.pathname, query, canonicalHeaders, signed, 'UNSIGNED-PAYLOAD'].join('\n');
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const kDate = hmac(`AWS4${d.secretAccessKey}`, day);
  const kSigning = hmac(hmac(hmac(kDate, region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${d.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}` };
}

function request(d: Destination, method: string, key: string, body?: { path: string } | Buffer, extra: Record<string, string> = {}): Promise<http.IncomingMessage> {
  const u = target(d, key);
  const len = body ? (Buffer.isBuffer(body) ? body.length : statSync(body.path).size) : 0;
  const headers = sign(d, method, u, { ...extra, ...(body ? { 'content-length': String(len) } : {}) });
  const mod = u.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = mod.request(u, { method, headers, timeout: 60_000 }, resolve);
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('S3 request timed out')));
    if (!body) req.end();
    else if (Buffer.isBuffer(body)) req.end(body);
    else createReadStream(body.path).on('error', (e) => req.destroy(e)).pipe(req);
  });
}

async function check(res: http.IncomingMessage, what: string) {
  if ((res.statusCode ?? 500) < 300) return;
  let text = '';
  for await (const c of res) text += c;
  const code = text.match(/<Code>([^<]+)<\/Code>/)?.[1];
  const msg = text.match(/<Message>([^<]+)<\/Message>/)?.[1];
  throw new Error(`${what} failed: HTTP ${res.statusCode}${code ? ` ${code}` : ''}${msg ? ` — ${msg}` : ''}`);
}

export async function s3Put(d: Destination, key: string, filePath: string) {
  const res = await request(d, 'PUT', key, { path: filePath }, { 'content-type': 'application/octet-stream' });
  await check(res, `upload of ${key}`);
  res.resume();
}

export async function s3Get(d: Destination, key: string): Promise<Readable> {
  const res = await request(d, 'GET', key);
  await check(res, `download of ${key}`);
  return res;
}

export async function s3Delete(d: Destination, key: string) {
  const res = await request(d, 'DELETE', key);
  if (res.statusCode === 404) return res.resume();
  await check(res, `delete of ${key}`);
  res.resume();
}

/** Write, read back and delete a tiny object to prove the credentials and bucket work. */
export async function s3Test(d: Destination) {
  const key = `${(d.prefix ?? '').replace(/^\/+|\/+$/g, '')}${d.prefix ? '/' : ''}.servify-connection-test`;
  const res = await request(d, 'PUT', key, Buffer.from('ok'), { 'content-type': 'text/plain' });
  await check(res, 'test upload');
  res.resume();
  const back = await s3Get(d, key);
  let text = '';
  for await (const c of back) text += c;
  if (text !== 'ok') throw new Error('read-back mismatch');
  await s3Delete(d, key);
}
