/**
 * Start Servify at login: a launchd agent on macOS, a systemd user unit on Linux.
 * Used by Settings → General ("Start Servify at login") and by `servify service …`.
 *
 * The SERVIFY_* / DOCKER_* variables Servify was started with are baked in, so the login service runs with the same
 * ports, data directory and Docker endpoint. Each data directory gets its own agent/unit (the default one is
 * `dev.servify` / `servify.service`), so a test instance can never replace your real one.
 */
import { homedir, platform, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const DEFAULT_DATA_DIR = resolve(join(homedir(), '.servify'));

export type AutostartSpec = { label: string; unit: string; node: string; bin: string; cwd: string; env: Record<string, string>; logFile: string; dataDir: string };

export function autostartSpec(env: NodeJS.ProcessEnv = process.env): AutostartSpec {
  const baked: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if ((k.startsWith('SERVIFY_') || k === 'DOCKER_HOST' || k === 'DOCKER_CONTEXT') && v) baked[k] = v;
  delete baked.SERVIFY_SUPERVISED;
  // The docker CLI (builds, private pulls, backups) and git must be found without a login shell.
  baked.PATH = env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
  baked.HOME = homedir();
  baked.SERVIFY_SUPERVISED = '1'; // lets the dashboard tell it runs as the login service
  const dataDir = resolve(baked.SERVIFY_DATA_DIR ?? DEFAULT_DATA_DIR);
  const suffix = dataDir === DEFAULT_DATA_DIR ? '' : `-${createHash('sha256').update(dataDir).digest('hex').slice(0, 8)}`;
  const bin = resolve(import.meta.dirname, '../bin/servify.mjs');
  return {
    label: `dev.servify${suffix.replace('-', '.')}`,
    unit: `servify${suffix}.service`,
    node: process.execPath,
    bin,
    cwd: resolve(dirname(bin), '../..'),
    env: baked,
    logFile: join(dataDir, 'logs', 'servify.log'),
    dataDir,
  };
}

const xml = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function launchdPlist(s: AutostartSpec) {
  const envXml = Object.entries(s.env)
    .map(([k, v]) => `      <key>${xml(k)}</key>\n      <string>${xml(v)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xml(s.label)}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xml(s.node)}</string>
      <string>--disable-warning=ExperimentalWarning</string>
      <string>${xml(s.bin)}</string>
      <string>start</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${xml(s.cwd)}</string>
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
    <string>${xml(s.logFile)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(s.logFile)}</string>
  </dict>
</plist>
`;
}

export function systemdUnit(s: AutostartSpec) {
  const q = (v: string) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
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

export function autostartTarget(s: AutostartSpec): { kind: 'launchd' | 'systemd' | null; file: string | null; content: string | null } {
  if (platform() === 'darwin') return { kind: 'launchd', file: join(homedir(), 'Library', 'LaunchAgents', `${s.label}.plist`), content: launchdPlist(s) };
  if (platform() === 'linux') return { kind: 'systemd', file: join(homedir(), '.config', 'systemd', 'user', s.unit), content: systemdUnit(s) };
  return { kind: null, file: null, content: null };
}

const run = (cmd: string, args: string[]) => {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 }).trim() };
  } catch (e: any) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || e.message };
  }
};

export type AutostartStatus = {
  supported: boolean;
  kind: 'launchd' | 'systemd' | null;
  /** Starts at login. */
  enabled: boolean;
  /** This process is the login service (vs started by hand). */
  supervised: boolean;
  file: string | null;
  logFile: string;
  /** The installed file differs from what Servify would write now (other ports, paths…). */
  stale: boolean;
};

export function autostartStatus(): AutostartStatus {
  const s = autostartSpec();
  const t = autostartTarget(s);
  const enabled = !!t.file && existsSync(t.file);
  return {
    supported: !!t.kind,
    kind: t.kind,
    enabled,
    supervised: process.env.SERVIFY_SUPERVISED === '1',
    file: t.file,
    logFile: s.logFile,
    stale: enabled && readFileSync(t.file!, 'utf8') !== t.content,
  };
}

/**
 * Turn starting at login on. `startNow` also starts the service immediately (the CLI, when nothing is running);
 * from the dashboard it only takes effect at the next login, so two copies never run at once.
 */
export function enableAutostart(opts: { startNow?: boolean } = {}) {
  const s = autostartSpec();
  const t = autostartTarget(s);
  if (!t.kind || !t.file || !t.content) throw new Error('starting at login is supported on macOS and Linux');
  mkdirSync(dirname(t.file), { recursive: true });
  mkdirSync(dirname(s.logFile), { recursive: true });
  writeFileSync(t.file, t.content);
  if (t.kind === 'launchd') {
    if (opts.startNow) {
      const uid = userInfo().uid;
      run('launchctl', ['bootout', `gui/${uid}/${s.label}`]);
      const r = run('launchctl', ['bootstrap', `gui/${uid}`, t.file]);
      if (!r.ok) throw new Error(`launchctl refused the agent: ${r.out}`);
    }
    // Otherwise launchd loads ~/Library/LaunchAgents/*.plist at the next login.
  } else {
    run('systemctl', ['--user', 'daemon-reload']);
    const r = run('systemctl', ['--user', 'enable', ...(opts.startNow ? ['--now'] : []), s.unit]);
    if (!r.ok) throw new Error(`systemctl failed: ${r.out}`);
  }
  return autostartStatus();
}

/** Turn it off. `stopNow` also stops a running login service (the CLI); the dashboard never stops itself. */
export function disableAutostart(opts: { stopNow?: boolean } = {}) {
  const s = autostartSpec();
  const t = autostartTarget(s);
  if (!t.kind || !t.file) throw new Error('starting at login is supported on macOS and Linux');
  if (t.kind === 'launchd') {
    if (opts.stopNow) run('launchctl', ['bootout', `gui/${userInfo().uid}/${s.label}`]);
  } else {
    run('systemctl', ['--user', 'disable', ...(opts.stopNow ? ['--now'] : []), s.unit]);
  }
  if (existsSync(t.file)) unlinkSync(t.file);
  if (t.kind === 'systemd') run('systemctl', ['--user', 'daemon-reload']);
  return autostartStatus();
}

/** launchd/systemd state of the installed service, for `servify service status`. */
export function serviceState(): string {
  const s = autostartSpec();
  const t = autostartTarget(s);
  if (t.kind === 'launchd') return run('launchctl', ['print', `gui/${userInfo().uid}/${s.label}`]).out.match(/state = (\w+)/)?.[1] ?? 'not loaded (starts at next login)';
  if (t.kind === 'systemd') return run('systemctl', ['--user', 'status', s.unit, '--no-pager']).out.match(/Active: (.+)/)?.[1] ?? 'unknown';
  return 'unsupported';
}
