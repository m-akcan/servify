/**
 * `servify service install | uninstall | status | print` — the command-line side of Settings → General →
 * "Start Servify at login" (same files, see server/src/autostart.ts).
 *
 *  macOS: a launchd agent (~/Library/LaunchAgents/dev.servify.plist) — starts at login, restarts on crash.
 *  Linux: a systemd user unit (~/.config/systemd/user/servify.service) — `loginctl enable-linger` makes it
 *         start at boot without a login.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export async function serviceCommand(action) {
  const { autostartSpec, autostartTarget, autostartStatus, enableAutostart, disableAutostart, serviceState } = await import(pathToFileURL(join(here, '../src/autostart.ts')).href);
  const s = autostartSpec();
  const t = autostartTarget(s);
  if (!t.kind) {
    console.error('Starting at login is supported on macOS (launchd) and Linux (systemd). On Windows, use Docker Compose with restart: unless-stopped.');
    process.exit(1);
  }
  if (action === 'print') {
    console.log(`# ${t.file}\n${t.content}`);
    return;
  }
  if (action === 'install') {
    const port = s.env.SERVIFY_PORT ?? '7700';
    let busy = '';
    try {
      busy = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {}
    try {
      // Servify is already running: starting a second copy would fail; it takes over at the next login instead.
      enableAutostart({ startNow: !busy });
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
    console.log(`Installed ${t.file}`);
    console.log(busy ? `Servify is already running on port ${port}; from your next login it starts on its own.` : `Servify now runs in the background and starts ${t.kind === 'launchd' ? 'when you log in' : 'with your user session'}.`);
    if (t.kind === 'systemd') console.log(`To start it at boot without logging in:  sudo loginctl enable-linger ${userInfo().username}`);
    console.log(`Logs: ${s.logFile}\nRemove it with:  servify service uninstall  (or Settings → General in the dashboard)`);
    return;
  }
  if (action === 'uninstall') {
    disableAutostart({ stopNow: true });
    console.log(`Removed ${t.file}. Your services keep running in Docker; start Servify again with \`pnpm start\`.`);
    return;
  }
  if (action === 'status') {
    const st = autostartStatus();
    if (!st.enabled) {
      console.log('Not set to start at login. Turn it on in Settings → General, or:  servify service install');
      return;
    }
    console.log(`Installed: ${st.file}\nState: ${serviceState()}${st.stale ? '\nNote: written with different settings than this shell has — run install again to update it.' : ''}\nLogs: ${st.logFile}`);
    if (existsSync(st.logFile)) console.log(`\n${readFileSync(st.logFile, 'utf8').split('\n').slice(-6).join('\n')}`);
    return;
  }
  console.log('usage: servify service [install | uninstall | status | print]');
  process.exit(1);
}
