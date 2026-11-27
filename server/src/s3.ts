/**
 * Minimal S3-compatible client (AWS S3, Cloudflare R2, MinIO, Backblaze B2, Wasabi…) with AWS Signature V4 and
 * UNSIGNED-PAYLOAD bodies. Backups stream through it: an upload buffers one part at a time in memory (a single PUT when
 * the whole archive fits in the first part, else a multipart upload), a download resumes with a Range request when the
 * connection drops. Nothing is staged on disk.
 */
import { createHash, createHmac } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { Readable, Writable } from 'node:stream';
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

function request(d: Destination, method: string, key: string, body?: Buffer, extra: Record<string, string> = {}, query: Record<string, string> = {}): Promise<http.IncomingMessage> {
  const u = target(d, key);
  // Written exactly as it is signed (URLSearchParams would encode "~" and leave "*", unlike SigV4).
  const q = Object.entries(query).sort().map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`).join('&');
  if (q) u.search = `?${q}`;
  const headers = sign(d, method, u, { ...extra, ...(body ? { 'content-length': String(body.length) } : {}) });
  const mod = u.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = mod.request(u, { method, headers, timeout: 60_000 }, resolve);
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('S3 request timed out')));
    req.end(body);
  });
}

/** An answer of the storage (not a network failure): retrying a 4xx other than a stray 403 won't help. */
class S3Error extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function check(res: http.IncomingMessage, what: string) {
  if ((res.statusCode ?? 500) < 300) return;
  let text = '';
  for await (const c of res) text += c;
  const code = text.match(/<Code>([^<]+)<\/Code>/)?.[1];
  const msg = text.match(/<Message>([^<]+)<\/Message>/)?.[1];
  throw new S3Error(res.statusCode ?? 500, `${what} failed: HTTP ${res.statusCode}${code ? ` ${code}` : ''}${msg ? ` — ${msg}` : ''}`);
}

/** Object stores refuse the odd request (seen on Hetzner: one 403 AccessDenied between successful uploads with the
 * same key), and connections drop. Every body is in memory, so try again before failing a backup. */
async function retried<T>(fn: () => Promise<T>, attempts = 3, stopped: () => boolean = () => false): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= attempts || stopped()) throw e;
      await sleep(attempt * 3000);
      if (stopped()) throw e;
    }
  }
}

async function text(res: http.IncomingMessage): Promise<string> {
  let out = '';
  for await (const c of res) out += c;
  return out;
}

const MB = 1024 * 1024;
/** S3's limits: parts of 5 MiB to 5 GiB (the last one may be smaller), at most 10,000 of them. */
const MIN_PART = 5 * MB;
const MAX_PART = 5 * 1024 * MB;
const MAX_PARTS = 10_000;
/** The part size an upload starts with (SERVIFY_S3_PART_MB, default 64; at least 5). */
export const PART_SIZE = Math.min(MAX_PART, Math.max(MIN_PART, (Number(process.env.SERVIFY_S3_PART_MB) || 64) * MB));
/** Parts double in size every this many, so an upload of unknown length still fits in 10,000 parts. */
const GROW_EVERY = 2000;

/**
 * The size of part `n` (1-based). It starts at `base` and doubles every 2,000 parts: at the default 64 MiB that is
 * 125 GiB in the first 2,000 parts and about 3.9 TiB in 10,000 (the last ones 1 GiB each). Never over 5 GiB.
 */
export function partSize(base: number, n: number) {
  return Math.min(MAX_PART, base * 2 ** Math.floor((n - 1) / GROW_EVERY));
}

/** The starting part size for an archive expected to be about `hint` bytes: twice that fits in 9,000 parts. */
export function basePartSize(hint?: number | null) {
  const want = hint && hint > 0 ? Math.ceil((hint * 2) / 9000 / MB) * MB : 0;
  return Math.min(MAX_PART, Math.max(PART_SIZE, want));
}

const unescapeXml = (v: string) => v.replace(/&quot;/g, '"').replace(/&amp;/g, '&');

export type S3Upload = {
  /** Write the archive here. Each full part is uploaded before the write returns, so at most one part is in memory. */
  stream: Writable;
  /** After everything was written (and checked): upload the rest and complete. Then the object exists. */
  commit(): Promise<void>;
  /** Remove whatever this upload left at the destination (the multipart upload and its parts, or the object). */
  abort(): Promise<void>;
};

/**
 * A streaming upload of an archive of unknown length. `onUploadId` is told the multipart upload id as soon as there is
 * one, so a crash can still abort it later (see s3AbortUpload).
 */
export function s3Upload(d: Destination, key: string, opts: { sizeHint?: number | null; onUploadId?: (uploadId: string) => void } = {}): S3Upload {
  const base = basePartSize(opts.sizeHint);
  let buf = Buffer.allocUnsafe(Math.min(base, MB));
  let filled = 0;
  let part = 1; // the part being filled
  let uploadId: string | null = null;
  const etags: string[] = [];
  let published = false; // a PUT or a complete was sent: the object may exist
  let aborted = false;
  let writing: Promise<void> = Promise.resolve(); // the write in progress (a part may be uploading)

  async function start() {
    const started = await retried(async () => {
      if (aborted) throw new Error(`upload of ${key} aborted`);
      const res = await request(d, 'POST', key, undefined, { 'content-type': 'application/octet-stream' }, { uploads: '' });
      await check(res, `upload of ${key} (start)`);
      return text(res);
    });
    const found = started.match(/<UploadId>([^<]+)<\/UploadId>/)?.[1];
    if (!found) throw new Error(`upload of ${key} failed: the storage did not start a multipart upload`);
    uploadId = unescapeXml(found);
    opts.onUploadId?.(uploadId);
  }
  async function flushPart() {
    if (!uploadId) await start();
    if (part > MAX_PARTS) throw new Error(`upload of ${key} failed: more than ${MAX_PARTS} parts`);
    const body = buf.subarray(0, filled);
    const n = part;
    const etag = await retried(async () => {
      if (aborted) throw new Error(`upload of ${key} aborted`);
      const res = await request(d, 'PUT', key, body, {}, { partNumber: String(n), uploadId: uploadId! });
      await check(res, `upload of ${key} (part ${n})`);
      res.resume();
      const tag = res.headers.etag;
      if (!tag) throw new Error(`upload of ${key} failed: part ${n} came back without an ETag`);
      return tag;
    }, 4, () => aborted);
    etags.push(etag);
    part++;
    filled = 0;
  }

  const stream = new Writable({
    highWaterMark: MB,
    write(chunk: Buffer, _enc, cb) {
      if (aborted) return cb(new Error(`upload of ${key} aborted`));
      writing = (async () => {
        let off = 0;
        while (off < chunk.length) {
          const want = partSize(base, part);
          const take = Math.min(chunk.length - off, want - filled);
          if (filled + take > buf.length) {
            // Grow the buffer towards the part size (small archives never allocate a whole part).
            const next = Buffer.allocUnsafe(Math.min(want, Math.max(buf.length * 2, filled + take)));
            buf.copy(next, 0, 0, filled);
            buf = next;
          }
          chunk.copy(buf, filled, off, off + take);
          filled += take;
          off += take;
          if (filled === want) await flushPart();
        }
      })();
      writing.then(() => cb(), cb);
    },
  });

  return {
    stream,
    async commit() {
      if (!uploadId) {
        // Everything fit in the first part: one plain PUT.
        const body = buf.subarray(0, filled);
        published = true;
        await retried(async () => {
          const res = await request(d, 'PUT', key, body, { 'content-type': 'application/octet-stream' });
          await check(res, `upload of ${key}`);
          res.resume();
        });
        return;
      }
      if (filled > 0) await flushPart();
      const xml = `<CompleteMultipartUpload>${etags.map((t, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${t.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
      published = true;
      // Not retried blindly: a second "complete" after one that got through answers NoSuchUpload.
      const res = await request(d, 'POST', key, Buffer.from(xml), { 'content-type': 'application/xml' }, { uploadId });
      await check(res, `upload of ${key} (complete)`);
      const done = await text(res);
      // S3 may answer 200 and still report an error in the body.
      if (/<Error>/.test(done)) throw new Error(`upload of ${key} failed: ${done.match(/<Code>([^<]+)<\/Code>/)?.[1] ?? 'error'}${done.match(/<Message>([^<]+)<\/Message>/) ? ` — ${done.match(/<Message>([^<]+)<\/Message>/)![1]}` : ''}`);
      buf = Buffer.alloc(0);
    },
    async abort() {
      // A part still uploading would land after the abort (S3 says so): stop its retries and let it finish first.
      aborted = true;
      await writing.catch(() => {});
      buf = Buffer.alloc(0);
      if (uploadId) await s3AbortUpload(d, key, uploadId);
      // A PUT or complete whose answer got lost may still have created the object (the key is this backup's own).
      if (published) await retried(() => s3Delete(d, key), 2);
    },
  };
}

/** Abort a multipart upload: its parts are deleted (and no longer billed). Gone already counts as done. */
export async function s3AbortUpload(d: Destination, key: string, uploadId: string) {
  await retried(async () => {
    const res = await request(d, 'DELETE', key, undefined, {}, { uploadId });
    if (res.statusCode === 404) return void res.resume(); // NoSuchUpload: completed or aborted already
    await check(res, `abort of the upload of ${key}`);
    res.resume();
  }, 2);
}

/** Size of an object, or null when it doesn't exist. Retried: a stray failure here must not fail (and delete) a finished backup. */
export async function s3Size(d: Destination, key: string): Promise<number | null> {
  return retried(async () => {
    const res = await request(d, 'HEAD', key);
    res.resume();
    if (res.statusCode === 404) return null;
    if ((res.statusCode ?? 500) >= 300) throw new S3Error(res.statusCode ?? 500, `size of ${key} failed: HTTP ${res.statusCode}`);
    return Number(res.headers['content-length'] ?? NaN);
  });
}

/**
 * Download an object as a stream. A connection that drops (or idles out while the reader is slow, e.g. a restore
 * building indexes) is picked up again with a Range request from where it stopped, a few times; a response shorter
 * than announced is an error, never a silent end.
 */
export function s3Get(d: Destination, key: string): Readable {
  async function* chunks() {
    let offset = 0;
    let total: number | null = null;
    let failures = 0;
    for (;;) {
      if (total !== null && Number.isFinite(total) && offset >= total) return; // dropped right after the last byte
      let res: http.IncomingMessage;
      try {
        res = await request(d, 'GET', key, undefined, offset ? { range: `bytes=${offset}-` } : {});
        await check(res, `download of ${key}`);
        if (offset && res.statusCode !== 206) {
          res.resume();
          throw new S3Error(500, `download of ${key} failed: the storage ignored the range request`);
        }
        if (total === null) total = Number(res.headers['content-length'] ?? NaN);
        for await (const c of res) {
          offset += (c as Buffer).length;
          failures = 0;
          yield c as Buffer;
        }
        if (Number.isFinite(total) && offset < total!) throw new Error(`download of ${key} ended early (${offset} of ${total} bytes)`);
        return;
      } catch (e) {
        // The storage's own answers (missing object, no access) don't get better by asking again.
        if (e instanceof S3Error && e.status !== 403 && e.status < 500) throw e;
        if (++failures > 4) throw e;
        await sleep(failures * 2000);
      }
    }
  }
  return Readable.from(chunks(), { objectMode: false });
}

export async function s3Delete(d: Destination, key: string) {
  const res = await request(d, 'DELETE', key);
  if (res.statusCode === 404) return void res.resume();
  await check(res, `delete of ${key}`);
  res.resume();
}

/** Write, read back and delete a tiny object to prove the credentials and bucket work. */
export async function s3Test(d: Destination) {
  const key = `${(d.prefix ?? '').replace(/^\/+|\/+$/g, '')}${d.prefix ? '/' : ''}.servify-connection-test`;
  const res = await request(d, 'PUT', key, Buffer.from('ok'), { 'content-type': 'text/plain' });
  await check(res, 'test upload');
  res.resume();
  let text = '';
  for await (const c of s3Get(d, key)) text += c;
  if (text !== 'ok') throw new Error('read-back mismatch');
  await s3Delete(d, key);
}
