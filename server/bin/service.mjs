/**
 * `servify service install | uninstall | status | print` — run Servify in the background and start it at login/boot.
 *
 *  macOS: a launchd agent (~/Library/LaunchAgents/dev.servify.plist) — starts at login, restarts on crash.
 *  Linux: a systemd user unit (~/.config/systemd/user/servify.service) — `loginctl enable-linger` makes it
 *         start at boot without a login.
 *
 * The SERVIFY_* / DOCKER_HOST variables of the installing shell are baked in, so the service runs with the same
 * ports, data directory and Docker endpoint as `pnpm start` did.
 */
import { homedir, platform, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const LABEL = 'dev.servify';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function settings(binPath) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if ((k.startsWith('SERVIFY_') || k === 'DOCKER_HOST' || k === 'DOCKER_CONTEXT') && v) env[k] = v;
  // The docker CLI (builds, private pulls, backups) and git must be found without a login shell.
  env.PATH = process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
  env.HOME = homedir();
  const dataDir = resolve(env.SERVIFY_DATA_DIR ?? join(homedir(), '.servify'));
  return { node: process.execPath, bin: binPath, cwd: resolve(dirname(binPath), '../..'), env, logFile: join(dataDir, 'logs', 'servify.log') };
}

export function launchdPlist(s) {
  const envXml = Object.entries(s.env)
    .map(([k, v]) => `      <key>${esc(k)}</key>\n      <string>${esc(v)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${esc(s.node)}</string>
      <string>--disable-warning=ExperimentalWarning</string>
      <string>${esc(s.bin)}</string>
      <string>start</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${esc(s.cwd)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${esc(s.logFile)}</string>
    <key>StandardErrorPath</key>
    <string>${esc(s.logFile)}</string>
  </dict>
</plist>
`;
}

export function systemdUnit(s) {
  const q = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return `[Unit]
Description=Servify — local-first platform for your services
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${s.cwd}
ExecStart=${q(s.node)} --disable-warning=ExperimentalWarning ${q(s.bin)} start
${Object.entries(s.env)
  .map(([k, v]) => `Environment=${q(`${k}=${v}`)}`)
  .join('\n')}
Restart=on-failure
RestartSec=5
StandardOutput=append:${s.logFile}
StandardError=append:${s.logFile}

[Install]
WantedBy=default.target
`;
}

function paths() {
  if (platform() === 'darwin') return { kind: 'launchd', file: join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`) };
  if (platform() === 'linux') return { kind: 'systemd', file: join(homedir(), '.config', 'systemd', 'user', 'servify.service') };
  return { kind: null, file: null };
}

const run = (cmd, args, opts = {}) => {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim() };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || e.message };
  }
};

export async function serviceCommand(action, binPath) {
  const { kind, file } = paths();
  if (!kind) {
    console.error('Starting at boot is supported on macOS (launchd) and Linux (systemd). On Windows, use Docker Compose with restart: unless-stopped.');
    process.exit(1);
  }
  const s = settings(binPath);
  const content = kind === 'launchd' ? launchdPlist(s) : systemdUnit(s);
  const uid = userInfo().uid;

  if (action === 'print') {
    console.log(`# ${file}\n${content}`);
    return;
  }
  if (action === 'install') {
    const busy = run('lsof', ['-nP', `-iTCP:${s.env.SERVIFY_PORT ?? 7700}`, '-sTCP:LISTEN', '-t']);
    if (busy.ok && busy.out) {
      console.error(`Port ${s.env.SERVIFY_PORT ?? 7700} is in use — stop the Servify you started by hand first (Ctrl-C), then run this again.`);
      process.exit(1);
    }
    mkdirSync(dirname(file), { recursive: true });
    mkdirSync(dirname(s.logFile), { recursive: true });
    writeFileSync(file, content);
    if (kind === 'launchd') {
      run('launchctl', ['bootout', `gui/${uid}/${LABEL}`]);
      const r = run('launchctl', ['bootstrap', `gui/${uid}`, file]);
      if (!r.ok) {
        console.error(`launchctl refused the agent: ${r.out}`);
        process.exit(1);
      }
    } else {
      run('systemctl', ['--user', 'daemon-reload']);
      const r = run('systemctl', ['--user', 'enable', '--now', 'servify.service']);
      if (!r.ok) {
        console.error(`systemctl failed: ${r.out}`);
        process.exit(1);
      }
    }
    console.log(`Installed ${file}\nServify now runs in the background and starts ${kind === 'launchd' ? 'when you log in' : 'with your user session'}.`);
    if (kind === 'systemd') console.log(`To start it at boot without logging in:  sudo loginctl enable-linger ${userInfo().username}`);
    console.log(`Logs: ${s.logFile}\nRemove it with:  servify service uninstall`);
    return;
  }
  if (action === 'uninstall') {
    if (kind === 'launchd') run('launchctl', ['bootout', `gui/${uid}/${LABEL}`]);
    else {
      run('systemctl', ['--user', 'disable', '--now', 'servify.service']);
      run('systemctl', ['--user', 'daemon-reload']);
    }
    if (existsSync(file)) unlinkSync(file);
    console.log(`Removed ${file}. Your services keep running in Docker; start Servify again with \`pnpm start\`.`);
    return;
  }
  if (action === 'status') {
    if (!existsSync(file)) {
      console.log('Not installed. Install with:  servify service install');
      return;
    }
    const r = kind === 'launchd' ? run('launchctl', ['print', `gui/${uid}/${LABEL}`]) : run('systemctl', ['--user', 'status', 'servify.service', '--no-pager']);
    const state = kind === 'launchd' ? (r.out.match(/state = (\w+)/)?.[1] ?? 'not loaded') : (r.out.match(/Active: (.+)/)?.[1] ?? 'unknown');
    console.log(`Installed: ${file}\nState: ${state}\nLogs: ${s.logFile}`);
    if (existsSync(s.logFile)) console.log(`\n${readFileSync(s.logFile, 'utf8').split('\n').slice(-6).join('\n')}`);
    return;
  }
  console.log('usage: servify service [install | uninstall | status | print]');
  process.exit(1);
}
