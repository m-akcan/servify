/**
 * Runs before Servify starts, right after an update switched the install folder (see src/updater.ts). Plain
 * JavaScript with no dependencies on purpose: it must work even when the new version's code doesn't.
 *
 * Each start of the new version counts as an attempt and gets a deadline; the new version confirms itself once it
 * serves the dashboard and reaches Docker. A start that crashes or misses the deadline exits with an error so the
 * service manager starts it again; after three failed attempts the previous folder and the database snapshot taken
 * before the switch are put back, and the old version starts instead.
 */
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const ATTEMPTS = 3;
const DEADLINE_MS = Number(process.env.SERVIFY_UPDATE_DEADLINE_MS) || 120_000;

export function guardStart(here) {
  const dataDir = resolve(process.env.SERVIFY_DATA_DIR ?? join(homedir(), '.servify'));
  const file = join(dataDir, 'update.json');
  let m;
  try {
    m = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return;
  }
  if (m?.state !== 'switched') return;
  let version = null;
  try {
    version = JSON.parse(readFileSync(join(here, '../../package.json'), 'utf8')).version;
  } catch {}
  if (version !== m.to) return; // not the version being tried (already rolled back, or started from elsewhere)
  const save = () => writeFileSync(file, JSON.stringify(m, null, 2));
  m.attempts = (m.attempts ?? 0) + 1;
  if (m.attempts > ATTEMPTS) {
    try {
      rollBack(m, dataDir);
      m.state = 'rolled-back';
      m.error = `${m.to} didn't start properly ${ATTEMPTS} times; went back to ${m.from}`;
    } catch (e) {
      m.state = 'failed';
      m.error = `${m.to} didn't start properly and going back to ${m.from} failed: ${e.message}`;
    }
    m.finishedAt = Date.now();
    save();
    console.error(`\n  ✗ Update: ${m.error}\n`);
    process.exit(1); // the service manager starts the previous version
  }
  save();
  console.log(`  [update] starting ${m.to} (attempt ${m.attempts} of ${ATTEMPTS})`);
  setTimeout(() => {
    let now;
    try {
      now = JSON.parse(readFileSync(file, 'utf8'));
    } catch {}
    if (now?.state === 'switched' && now.to === m.to) {
      console.error(`  ✗ Update: ${m.to} wasn't healthy within ${Math.round(DEADLINE_MS / 1000)}s — restarting (attempt ${m.attempts} of ${ATTEMPTS})`);
      process.exit(1);
    }
  }, DEADLINE_MS).unref();
}

function rollBack(m, dataDir) {
  if (!existsSync(m.prevDir)) throw new Error(`the previous version isn't at ${m.prevDir} any more`);
  const failed = `${m.installDir}.failed`;
  rmSync(failed, { recursive: true, force: true });
  renameSync(m.installDir, failed);
  renameSync(m.prevDir, m.installDir);
  m.failedDir = failed;
  if (m.dbBackup && existsSync(m.dbBackup)) {
    const db = join(dataDir, 'servify.db');
    for (const f of [`${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
    copyFileSync(m.dbBackup, db);
    m.dbRestored = true;
  }
}
