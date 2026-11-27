/**
 * `servify up`: a folder uploaded from someone's machine as a gzipped tar, unpacked under the data directory and
 * built like a local folder. The last three uploads of each service are kept (the newest is what redeploys build).
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createGunzip } from 'node:zlib';
import type { Readable } from 'node:stream';
import { config } from './config.ts';
import { services as servicesTable } from './db.ts';
import { bus, recordActivity } from './events.ts';
import { queueDeployment } from './deployer.ts';
import { extractTar } from './tar.ts';
import { HttpError, id } from './util.ts';
import type { Service, SourceUpload } from './types.ts';
import type { Actor } from './events.ts';

const KEEP = 3;
export const uploadsRoot = (serviceId: string) => join(config.dataDir, 'uploads', serviceId);
export const uploadPath = (serviceId: string, uploadId: string) => join(uploadsRoot(serviceId), uploadId);

export async function receiveUpload(actor: Actor, svc: Service, body: Readable, meta: { label?: string | null; commitSha?: string | null; commitMessage?: string | null; deploy?: boolean }) {
  if (svc.source.type === 'external' || svc.source.type === 'redirect') throw new HttpError(400, `${svc.name} is a route, not something to build`);
  if (svc.cluster) throw new HttpError(400, 'clusters run their database image');
  const uploadId = id('upl');
  const dir = uploadPath(svc.id, uploadId);
  let stats;
  try {
    // An upload cut short (Ctrl-C, a dropped connection) errors the request body: pass that on, or it is an
    // unhandled stream error that takes the whole process down.
    const gunzip = createGunzip();
    body.on('error', (e) => gunzip.destroy(e));
    stats = await extractTar(body.pipe(gunzip), dir);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw new HttpError(400, `could not unpack the upload: ${(e as Error).message}`);
  }
  if (!stats.files) {
    rmSync(dir, { recursive: true, force: true });
    throw new HttpError(400, 'the upload was empty');
  }
  const fresh = servicesTable.get(svc.id)!;
  const prev = fresh.source.type === 'upload' ? fresh.source : null;
  const source: SourceUpload = {
    type: 'upload',
    uploadId,
    uploadedAt: Date.now(),
    files: stats.files,
    bytes: stats.bytes,
    label: meta.label?.slice(0, 200) || null,
    commitSha: meta.commitSha && /^[0-9a-f]{7,40}$/.test(meta.commitSha) ? meta.commitSha : null,
    commitMessage: meta.commitMessage?.slice(0, 300) || null,
    dockerfile: prev?.dockerfile,
    rootDir: prev?.rootDir,
  };
  fresh.source = source;
  if (fresh.stopped && meta.deploy !== false) fresh.stopped = false;
  fresh.updatedAt = Date.now();
  servicesTable.put(fresh);
  bus.publish({ type: 'service.updated', service: fresh });
  recordActivity(actor, 'service.updated', `Uploaded ${stats.files.toLocaleString()} files to ${fresh.name}${source.label ? ` (${source.label})` : ''}`, fresh.projectId, fresh.id);
  prune(fresh.id, uploadId);
  const deployment = meta.deploy === false ? null : queueDeployment(fresh, actor.type === 'agent' ? 'agent' : 'manual', actor);
  return { source, deployment, skipped: stats.skipped.slice(0, 20) };
}

function prune(serviceId: string, keepId: string) {
  const root = uploadsRoot(serviceId);
  if (!existsSync(root)) return;
  const dirs = readdirSync(root)
    .map((n) => ({ n, t: statSync(join(root, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const d of dirs.slice(KEEP)) if (d.n !== keepId) rmSync(join(root, d.n), { recursive: true, force: true });
}

export function removeUploads(serviceId: string) {
  rmSync(uploadsRoot(serviceId), { recursive: true, force: true });
}
