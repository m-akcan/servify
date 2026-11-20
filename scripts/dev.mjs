#!/usr/bin/env node
// Dev: run the API server (with --watch) and the Vite dev server together.
import { spawn } from 'node:child_process';

const procs = [
  spawn('node', ['--watch', 'server/src/main.ts'], { stdio: 'inherit', env: { ...process.env, SERVIFY_DATA_DIR: process.env.SERVIFY_DATA_DIR ?? '.data' } }),
  spawn('pnpm', ['--filter', '@servify/web', 'dev'], { stdio: 'inherit' }),
];
const stop = () => {
  for (const p of procs) p.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => code && stop());
