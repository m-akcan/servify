/**
 * One Servify per data directory. Two copies would both reconcile the same containers (and the login service could
 * start while a hand-started copy runs), so the second one exits — with code 0, so launchd/systemd don't retry it.
 * The lock records the process id and its start time, so a stale file (or a reused pid) never blocks a start.
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { config } from './config.ts';

const file = join(config.dataDir, 'servify.pid');

function startedAt(pid: number): string {
  try {
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** The other running Servify's pid, or null after taking the lock. */
export function acquireLock(): number | null {
  if (existsSync(file)) {
    try {
      const { pid, started } = JSON.parse(readFileSync(file, 'utf8'));
      if (pid !== process.pid && started && startedAt(pid) === started) return pid;
    } catch {}
  }
  writeFileSync(file, JSON.stringify({ pid: process.pid, started: startedAt(process.pid) }));
  const release = () => {
    try {
      if (JSON.parse(readFileSync(file, 'utf8')).pid === process.pid) unlinkSync(file);
    } catch {}
  };
  process.on('exit', release);
  return null;
}
