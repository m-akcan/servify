/**
 * Live usage of this machine (CPU, load, memory, disk, uptime) and of the Servify process itself, sampled
 * every 10 s. Remote servers report the same numbers through their agent (see agent.mjs `stats`).
 */
import os from 'node:os';
import { readFileSync, statfsSync } from 'node:fs';
import { config } from './config.ts';
import type { HostStats } from './types.ts';

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  return { idle, total };
}

/** MemAvailable counts reclaimable cache as free, like `free -h`; os.freemem() does not on Linux. */
function memAvailable(): number {
  try {
    const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(readFileSync('/proc/meminfo', 'utf8'));
    if (m) return Number(m[1]) * 1024;
  } catch {}
  return os.freemem();
}

function disk(path: string): { total: number; free: number } | null {
  try {
    const s = statfsSync(path);
    return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch {
    return null;
  }
}

let prevCpu = cpuTimes();
let prevProc = { usage: process.cpuUsage(), at: process.hrtime.bigint() };
let host: HostStats | null = null;
let proc = { cpuPct: 0, rssBytes: process.memoryUsage().rss };

function sample() {
  const cpu = cpuTimes();
  const dTotal = cpu.total - prevCpu.total;
  const cpuPct = dTotal > 0 ? Math.round((1 - (cpu.idle - prevCpu.idle) / dTotal) * 1000) / 10 : null;
  prevCpu = cpu;
  const d = disk('/') ?? disk(config.dataDir);
  host = {
    cpuPct,
    load: os.loadavg().map((n) => Math.round(n * 100) / 100) as [number, number, number],
    memTotal: os.totalmem(),
    memAvailable: memAvailable(),
    diskTotal: d?.total ?? null,
    diskFree: d?.free ?? null,
    uptimeSec: Math.round(os.uptime()),
    at: Date.now(),
  };
  const now = process.hrtime.bigint();
  const usage = process.cpuUsage(prevProc.usage);
  const elapsedUs = Number(now - prevProc.at) / 1000;
  proc = { cpuPct: elapsedUs > 0 ? Math.round(((usage.user + usage.system) / elapsedUs) * 1000) / 10 : 0, rssBytes: process.memoryUsage().rss };
  prevProc = { usage: process.cpuUsage(), at: now };
}

export function startHostStats() {
  setTimeout(sample, 1000); // the first CPU figure needs two samples
  setInterval(sample, 10_000).unref();
}

export const localHostStats = () => host;
export const servifyProcessStats = () => ({ ...proc, uptimeSec: Math.round(process.uptime()), version: config.version });

/** Static facts about this machine, in the shape agents report for theirs. */
export const localInfo = () => ({ hostname: os.hostname(), os: `${os.type()} ${os.release()}`, arch: os.arch(), cpus: os.cpus().length, memBytes: os.totalmem() });
