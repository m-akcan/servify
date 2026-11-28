#!/usr/bin/env node
/**
 * servify CLI
 *   servify start              start the platform (dashboard, router, engine)
 *   servify mcp                MCP stdio bridge → a running Servify (SERVIFY_URL, SERVIFY_TOKEN)
 *   servify token <name> [--scope read|deploy|write] [--project <id or slug>]…   create an API token directly in the
 *                              local database (default: write, all projects; --read = --scope read; --project repeats
 *                              or takes a comma list, and limits the token to those projects and their environments)
 *   servify service install | uninstall | status | print   run in the background, start at login/boot
 *   servify agent --join <url> --token <t> --fingerprint <fp>   let a Servify run services on this machine
 *   servify cert import <host> <fullchain.pem> <privkey.pem>   take over an existing certificate
 *   servify selftest           load the server without starting it (the updater runs this on a new release)
 *   servify auth reset [--keep-password] [--password-stdin] [--remove-passkeys] [--sign-out-devices]
 *                              locked out? On the Servify machine (needs the data folder): set a new owner password,
 *                              allow password sign-in everywhere again and end every dashboard session
 *   servify auth status        the password policy, passkeys, sessions and signed-in phones (local)
 *   servify reclaim [--dry-run] [--yes] [--skip-safety-backup]   on the Servify machine: list what Servify left behind
 *                              here that nothing uses (volumes of deleted services, their images, stopped containers,
 *                              networks of deleted projects) and delete it after a confirmation; --dry-run only lists
 *
 * From your own machine, against a Servify here or on a server (SERVIFY_URL + SERVIFY_TOKEN, or `servify login`):
 *   servify login [url] [--token t] · logout      save (or forget) the URL and an API token
 *   servify link [project] [service] · unlink    remember which project/service this folder deploys to
 *   servify up [--service name] [--replace]      upload this folder, build and deploy it, follow the build
 *   servify deploy [--tag t] [--skip-safety-backup]   redeploy the service (--tag: switch an image service's tag)
 *   servify restart [--skip-safety-backup]       restart it with the image it runs
 *   servify rollback [deployment] [--skip-safety-backup]   back to the previous live image (or that deployment)
 *   servify deployments [--limit n]              recent deployments (ids for rollback)
 *   servify logs [-f] [--build] [--tail n]       runtime logs, or the latest build log
 *   servify variables [list] [--reveal] · get NAME · set NAME=value… [--from-file .env] · unset NAME…
 *                              the service's variables (--shared: the project's; --deploy: redeploy now; alias: vars)
 *   servify backup [create] [--destination d] [--no-wait] · backup list · backup test <id> · backup download <id> [-o f]
 *   servify restore <backup id> [--yes]          replace the service's data with a backup, follow it
 *   servify run [--] <command…>                  a local command with the service's variables
 *   servify exec [--] <command…>                 a command inside the running service (its exit code is passed on)
 *   servify status · open                        the project's services · open the service's URL
 * Commands that act on a project or service take --project/-p and --service/-s (or SERVIFY_PROJECT / SERVIFY_SERVICE,
 * names or ids); otherwise the folder's link decides.
 * `servify help <command>` (or `servify <command> --help`) shows the details.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const [cmd = 'start', ...rest] = process.argv.slice(2);

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(`servify needs Node.js 22.18+ (for native TypeScript). You have ${process.versions.node}.`);
  process.exit(1);
}

const CLIENT = ['login', 'logout', 'link', 'unlink', 'up', 'deploy', 'restart', 'rollback', 'deployments', 'logs', 'variables', 'vars', 'backup', 'restore', 'run', 'exec', 'status', 'open'];

if (CLIENT.includes(cmd) || (cmd === 'help' && CLIENT.includes(rest[0]))) {
  const { main } = await import(pathToFileURL(join(here, '../src/cli.ts')).href);
  await main(cmd, rest);
} else if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
  const { readFileSync } = await import('node:fs');
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*\n/, '').replace(/^ \* ?/gm, ''));
} else if (cmd === 'start') {
  // Right after an update: count this start, and roll back if the new version keeps failing (see update-guard.mjs).
  const { guardStart } = await import(pathToFileURL(join(here, 'update-guard.mjs')).href);
  guardStart(here);
  await import(pathToFileURL(join(here, '../src/main.ts')).href);
} else if (cmd === 'selftest') {
  // Used by the updater on a freshly unpacked release: load every part of the server without starting it.
  if (!process.env.SERVIFY_DATA_DIR) {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    process.env.SERVIFY_DATA_DIR = mkdtempSync(join(tmpdir(), 'servify-selftest-'));
  }
  for (const m of ['config.ts', 'db.ts', 'api.ts', 'mcp.ts', 'engine.ts', 'deployer.ts', 'proxy.ts', 'nodes.ts', 'mesh.ts', 'sleep.ts', 'backups.ts', 'updater.ts']) {
    await import(pathToFileURL(join(here, '../src', m)).href);
  }
  const { config } = await import(pathToFileURL(join(here, '../src/config.ts')).href);
  console.log(`selftest ok ${config.version}`);
  process.exit(0);
} else if (cmd === 'mcp') {
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const url = new URL((process.env.SERVIFY_URL ?? 'http://localhost:7700').replace(/\/$/, '') + '/mcp');
  const token = process.env.SERVIFY_TOKEN;
  if (!token) {
    console.error('Set SERVIFY_TOKEN (create one in Servify → Agents, or `servify token <name>`).');
    process.exit(1);
  }
  // A transparent pipe: stdio JSON-RPC in, Streamable HTTP out.
  const stdio = new StdioServerTransport();
  const http = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  stdio.onmessage = (m) => http.send(m).catch((e) => console.error('[servify-mcp]', e.message));
  http.onmessage = (m) => stdio.send(m);
  http.onerror = (e) => console.error('[servify-mcp]', e.message);
  stdio.onclose = () => http.close();
  await http.start();
  await stdio.start();
} else if (cmd === 'token') {
  let name = null;
  let scope = null;
  const projects = [];
  const usage = 'usage: servify token <name> [--scope read|deploy|write] [--project <id or slug>]…';
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const value = (flag) => {
      if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
      const v = rest[++i];
      if (v === undefined || v.startsWith('--')) {
        console.error(`${flag} needs a value — ${usage}`);
        process.exit(1);
      }
      return v;
    };
    if (a === '--read') scope = scope && scope !== 'read' ? 'conflict' : 'read';
    else if (a === '--scope' || a.startsWith('--scope=')) {
      const v = value('--scope');
      scope = scope && scope !== v ? 'conflict' : v;
    } else if (a === '--project' || a.startsWith('--project=')) projects.push(...value('--project').split(',').map((x) => x.trim()).filter(Boolean));
    else if (a.startsWith('-')) {
      console.error(`unknown option ${a} — ${usage}`);
      process.exit(1);
    } else if (name === null) name = a;
    else {
      console.error(`one name only — ${usage}`);
      process.exit(1);
    }
  }
  if (scope === 'conflict' || (scope && !['read', 'deploy', 'write'].includes(scope))) {
    console.error(`--scope must be one of read, deploy, write — ${usage}`);
    process.exit(1);
  }
  const { createToken, normalizeTokenProjects } = await import(pathToFileURL(join(here, '../src/auth.ts')).href);
  try {
    const ids = projects.length ? normalizeTokenProjects(projects) : null;
    const { token, record } = createToken(name ?? 'agent', scope ?? 'write', 'agent', ids);
    const where = ids ? ` for ${ids.length} project${ids.length === 1 ? '' : 's'} (${projects.join(', ')}) and their environments` : '';
    console.log(`Created ${record.scope} token "${record.name}"${where}:\n\n  ${token}\n\nIt won't be shown again.`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
} else if (cmd === 'cert' && rest[0] === 'import') {
  const [, host, chainFile, keyFile] = rest;
  if (!host || !chainFile || !keyFile) {
    console.error('usage: servify cert import <host> <fullchain.pem> <privkey.pem>');
    process.exit(1);
  }
  const { readFileSync } = await import('node:fs');
  const { importCertificate } = await import(pathToFileURL(join(here, '../src/certs.ts')).href);
  try {
    const r = importCertificate(host, readFileSync(chainFile, 'utf8'), readFileSync(keyFile, 'utf8'));
    console.log(`imported ${r.host} (${r.issuer}), valid until ${new Date(r.expiresAt).toISOString().slice(0, 10)} — restart Servify to serve it`);
  } catch (e) {
    console.error(`${host}: ${e.message}`);
    process.exit(1);
  }
} else if (cmd === 'auth') {
  await authCommand(rest);
} else if (cmd === 'reclaim') {
  await reclaimCommand(rest);
} else if (cmd === 'agent') {
  await import(pathToFileURL(join(here, 'agent.mjs')).href);
} else if (cmd === 'service') {
  const { serviceCommand } = await import(pathToFileURL(join(here, 'service.mjs')).href);
  await serviceCommand(rest[0] ?? 'status', fileURLToPath(import.meta.url));
} else {
  console.log('usage: servify <command> — run `servify help` for the list');
  process.exit(cmd === 'help' || cmd === '--help' ? 0 : 1);
}

/**
 * `servify reclaim [--dry-run] [--yes] [--skip-safety-backup]`: on the Servify machine (needs the data folder), list
 * what Servify left behind on this machine that nothing uses any more, then delete it after a confirmation. Same
 * rules as Settings → Reclaim space (which also covers added servers); every item is checked again before deleting.
 */
async function reclaimCommand(args) {
  const flags = new Set(args);
  const known = ['--dry-run', '--yes', '--skip-safety-backup'];
  if ([...flags].some((f) => !known.includes(f))) {
    console.error('usage: servify reclaim [--dry-run] [--yes] [--skip-safety-backup]');
    process.exit(1);
  }
  const { existsSync } = await import('node:fs');
  const { config } = await import(pathToFileURL(join(here, '../src/config.ts')).href);
  if (!existsSync(config.dbPath)) {
    console.error(`No Servify data in ${config.dataDir} (set SERVIFY_DATA_DIR to the folder Servify runs with).`);
    process.exit(1);
  }
  const { scanReclaimable, reclaimItems } = await import(pathToFileURL(join(here, '../src/reclaim.ts')).href);
  const size = (n) => (n == null ? '?' : n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${(n / 1e3).toFixed(0)} kB` : `${n} B`);
  const report = await scanReclaimable({ localOnly: true });
  const items = report.machines[0]?.items ?? [];
  if (report.machines[0]?.error) {
    console.error(`Could not scan this machine: ${report.machines[0].error}`);
    process.exit(1);
  }
  console.log(`data ${config.dataDir} · instance ${report.instanceId} · this machine only (added servers: use the dashboard)`);
  if (!items.length) {
    console.log('Nothing to reclaim.');
    process.exit(0);
  }
  for (const i of items) {
    const from = [i.project && `project ${i.project}`, i.service && `service ${i.service}`].filter(Boolean).join(', ');
    console.log(`  ${i.kind.padEnd(9)} ${i.name.padEnd(48)} ${size(i.sizeBytes).padStart(9)}  ${i.note}${from ? ` (${from})` : ''}`);
  }
  console.log(`${items.length} item(s), ${size(report.totalBytes)} reclaimable`);
  if (flags.has('--dry-run')) process.exit(0);
  if (!flags.has('--yes')) {
    if (!process.stdin.isTTY) {
      console.error('Not a terminal: pass --yes to delete these, or --dry-run to only list them.');
      process.exit(1);
    }
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`Delete all ${items.length}? Volume data is deleted for good${flags.has('--skip-safety-backup') ? ', without a safety backup' : ' (after a safety backup)'}; this can't be undone. Type "delete" to go ahead: `);
    rl.close();
    if (answer.trim() !== 'delete') {
      console.log('Nothing deleted.');
      process.exit(0);
    }
  }
  const r = await reclaimItems({ type: 'user', name: 'owner (command line)' }, items.map((i) => i.key), { skipSafetyBackup: flags.has('--skip-safety-backup') });
  for (const x of r.results) console.log(`  ${x.ok ? 'deleted' : 'kept   '} ${x.name ?? x.key}${x.ok ? '' : `: ${x.error}`}`);
  console.log(`Freed about ${size(r.freedBytes)}.`);
  process.exit(r.results.every((x) => x.ok) ? 0 : 1);
}

/**
 * `servify auth reset|status`: recovery on the Servify machine itself. Whoever can run this can read the data folder
 * (and the master key), so it needs no password. It writes the database directly, which a running Servify reads on
 * every sign-in, so no restart is needed.
 */
async function authCommand(args) {
  const sub = args[0];
  const flags = new Set(args.slice(1));
  const known = ['--keep-password', '--password-stdin', '--remove-passkeys', '--sign-out-devices'];
  const usage = 'usage: servify auth reset [--keep-password] [--password-stdin] [--remove-passkeys] [--sign-out-devices] · servify auth status';
  if ((sub !== 'reset' && sub !== 'status') || [...flags].some((f) => !known.includes(f)) || (sub === 'status' && flags.size)) {
    console.error(usage);
    process.exit(1);
  }
  const { existsSync } = await import('node:fs');
  const { config } = await import(pathToFileURL(join(here, '../src/config.ts')).href);
  if (!existsSync(config.dbPath)) {
    console.error(`No Servify data in ${config.dataDir} (set SERVIFY_DATA_DIR to the folder Servify runs with).`);
    process.exit(1);
  }
  const { kv, sessionsTable, tokensTable, passkeysTable } = await import(pathToFileURL(join(here, '../src/db.ts')).href);
  const { setPassword, PASSWORD_POLICY_KEY } = await import(pathToFileURL(join(here, '../src/auth.ts')).href);
  const devices = () => tokensTable.list().filter((t) => t.kind === 'device');
  if (sub === 'status') {
    const policy = kv.get(PASSWORD_POLICY_KEY) ?? 'everywhere';
    const keys = passkeysTable.all();
    console.log(`data          ${config.dataDir}`);
    console.log(`password      ${kv.get('password_hash') ? 'set' : 'not set yet'}; sign-in ${policy === 'private' ? 'from private networks only' : policy === 'off' ? 'off (passkeys only)' : 'allowed everywhere'}`);
    console.log(`passkeys      ${keys.length ? keys.map((k) => `${k.name} (${k.rpId})`).join(', ') : 'none'}`);
    console.log(`sessions      ${sessionsTable.count()} dashboard session(s), ${devices().length} signed-in phone(s)`);
    return;
  }
  if (config.authMode === 'none') console.log('Note: SERVIFY_AUTH=none is set in this shell; the reset still applies to the data folder.');
  if (!flags.has('--keep-password')) {
    let pw;
    if (flags.has('--password-stdin')) {
      const chunks = [];
      for await (const c of process.stdin) chunks.push(c);
      pw = Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0];
    } else {
      if (!process.stdin.isTTY) {
        console.error('No terminal to ask for the new password: use --password-stdin (or --keep-password).');
        process.exit(1);
      }
      pw = await askHidden('New owner password: ');
      const again = await askHidden('Again: ');
      if (pw !== again) {
        console.error('The passwords don’t match. Nothing changed.');
        process.exit(1);
      }
    }
    try {
      setPassword(pw);
    } catch (e) {
      console.error(`${e.message}. Nothing changed.`);
      process.exit(1);
    }
  }
  kv.set(PASSWORD_POLICY_KEY, 'everywhere');
  const ended = sessionsTable.deleteAll();
  let removedKeys = 0;
  if (flags.has('--remove-passkeys')) for (const k of passkeysTable.all()) passkeysTable.delete(k.id), removedKeys++;
  let removedDevices = 0;
  if (flags.has('--sign-out-devices')) for (const d of devices()) tokensTable.delete(d.id), removedDevices++;
  const { recordActivity } = await import(pathToFileURL(join(here, '../src/events.ts')).href);
  const what = [
    !flags.has('--keep-password') && 'new owner password',
    'password sign-in allowed everywhere',
    `${ended} dashboard session(s) ended`,
    removedKeys && `${removedKeys} passkey(s) removed`,
    removedDevices && `${removedDevices} phone(s) signed out`,
  ].filter(Boolean);
  recordActivity({ type: 'user', name: 'you' }, 'auth.reset', `Sign-in reset on the Servify machine: ${what.join(', ')}`);
  console.log(`Done: ${what.join(', ')}.`);
  console.log('Sign in again in the dashboard. If your address was locked out after failed attempts, that lasts at most 15 minutes (restarting Servify clears it at once).');
}

function askHidden(question) {
  return new Promise(async (done) => {
    const { createInterface } = await import('node:readline');
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = rl._writeToOutput?.bind(rl);
    rl._writeToOutput = (s) => (s.includes(question) ? write?.(s) : write?.(''));
    rl.question(question, (a) => {
      rl.close();
      process.stdout.write('\n');
      done(a);
    });
  });
}
