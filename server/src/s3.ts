/**
 * Minimal S3-compatible client (AWS S3, Cloudflare R2, MinIO, Backblaze B2, Wasabi…): PUT / GET / DELETE
 * with AWS Signature V4. Bodies are streamed from disk with a known length; payloads are UNSIGNED-PAYLOAD.
 * Big files go up as a multipart upload (one PUT is limited to 5 GB), part by part from disk.
 */
import { createHash, createHmac } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { createReadStream, statSync } from 'node:fs';
import type { Readable } from 'node:stream';
import type { Destination } from './settings.ts';
import { sleep } from './util.ts';

const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
const sha256hex = (data: string) => createHash('sha256').update(data).digest('hex');
/** Percent-encoding as SigV4 wants it: everything but A-Z a-z 0-9 - _ . ~ */
const rfc3986 = (v: string) => encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
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
  const query = [...u.searchParams.entries()].sort().map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`).join('&');
  const canonical = [method, u.pathname, query, canonicalHeaders, signed, 'UNSIGNED-PAYLOAD'].join('\n');
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const kDate = hmac(`AWS4${d.secretAccessKey}`, day);
  const kSigning = hmac(hmac(hmac(kDate, region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${d.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}` };
}

/** A file, or the bytes `start`…`end` (inclusive) of it. */
type FileBody = { path: string; start?: number; end?: number };

function request(d: Destination, method: string, key: string, body?: FileBody | Buffer, extra: Record<string, string> = {}, query: Record<string, string> = {}): Promise<http.IncomingMessage> {
  const u = target(d, key);
  // Written exactly as it is signed (URLSearchParams would encode "~" and leave "*", unlike SigV4).
  const q = Object.entries(query).sort().map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`).join('&');
  if (q) u.search = `?${q}`;
  const len = body ? (Buffer.isBuffer(body) ? body.length : body.end !== undefined ? body.end - (body.start ?? 0) + 1 : statSync(body.path).size) : 0;
  const headers = sign(d, method, u, { ...extra, ...(body ? { 'content-length': String(len) } : {}) });
  const mod = u.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = mod.request(u, { method, headers, timeout: 60_000 }, resolve);
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('S3 request timed out')));
    if (!body) req.end();
    else if (Buffer.isBuffer(body)) req.end(body);
    else createReadStream(body.path, body.end !== undefined ? { start: body.start ?? 0, end: body.end } : {}).on('error', (e) => req.destroy(e)).pipe(req);
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

/** Object stores refuse the odd request (seen on Hetzner: one 403 AccessDenied between successful uploads
 * with the same key). The file is still on disk, so try again before failing a backup. */
async function retried<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= 3) throw e;
      await sleep(attempt * 3000);
    }
  }
}

async function text(res: http.IncomingMessage): Promise<string> {
  let out = '';
  for await (const c of res) out += c;
  return out;
}

const MB = 1024 * 1024;
/**
 * Files from this size on are uploaded in parts: only what a single PUT can't carry (it stops at 5 GB on AWS and
 * most compatible stores). Everything smaller goes up exactly as before.
 */
const MULTIPART_FROM = (Number(process.env.SERVIFY_S3_MULTIPART_MB) || 4608) * MB;
const PART_SIZE = (Number(process.env.SERVIFY_S3_PART_MB) || 64) * MB;

export async function s3Put(d: Destination, key: string, filePath: string) {
  const size = statSync(filePath).size;
  if (size >= MULTIPART_FROM) return s3PutMultipart(d, key, filePath, size);
  await retried(async () => {
    const res = await request(d, 'PUT', key, { path: filePath }, { 'content-type': 'application/octet-stream' });
    await check(res, `upload of ${key}`);
    res.resume();
  });
}

/**
 * Multipart upload with plain S3 calls: start, one PUT per part (each retried on its own, read straight from the
 * file), complete. A failure aborts the upload, so no invisible parts stay behind (and get billed) in the bucket.
 */
async function s3PutMultipart(d: Destination, key: string, filePath: string, size: number) {
  // At most 10,000 parts: grow the part size for very large files (640 GB and up at the default).
  const partSize = Math.max(PART_SIZE, Math.ceil(size / 9000 / MB) * MB);
  const started = await retried(async () => {
    const res = await request(d, 'POST', key, undefined, { 'content-type': 'application/octet-stream' }, { uploads: '' });
    await check(res, `upload of ${key} (start)`);
    return text(res);
  });
  const uploadId = started.match(/<UploadId>([^<]+)<\/UploadId>/)?.[1];
  if (!uploadId) throw new Error(`upload of ${key} failed: the storage did not start a multipart upload`);
  const unescape = (v: string) => v.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  try {
    const etags: string[] = [];
    for (let n = 1, start = 0; start < size; n++, start += partSize) {
      const end = Math.min(start + partSize, size) - 1;
      const etag = await retried(async () => {
        const res = await request(d, 'PUT', key, { path: filePath, start, end }, {}, { partNumber: String(n), uploadId: unescape(uploadId) });
        await check(res, `upload of ${key} (part ${n})`);
        res.resume();
        const tag = res.headers.etag;
        if (!tag) throw new Error(`upload of ${key} failed: part ${n} came back without an ETag`);
        return tag;
      });
      etags.push(etag);
    }
    const xml = `<CompleteMultipartUpload>${etags.map((t, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${t.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
    // Not retried blindly: a second "complete" after one that got through answers NoSuchUpload.
    const res = await request(d, 'POST', key, Buffer.from(xml), { 'content-type': 'application/xml' }, { uploadId: unescape(uploadId) });
    await check(res, `upload of ${key} (complete)`);
    const done = await text(res);
    // S3 may answer 200 and still report an error in the body.
    if (/<Error>/.test(done)) throw new Error(`upload of ${key} failed: ${done.match(/<Code>([^<]+)<\/Code>/)?.[1] ?? 'error'}${done.match(/<Message>([^<]+)<\/Message>/) ? ` — ${done.match(/<Message>([^<]+)<\/Message>/)![1]}` : ''}`);
  } catch (e) {
    await request(d, 'DELETE', key, undefined, {}, { uploadId: unescape(uploadId) }).then((r) => r.resume(), () => {});
    throw e;
  }
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
