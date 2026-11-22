#!/usr/bin/env node
/**
 * servify CLI
 *   servify start              start the platform (dashboard, router, engine)
 *   servify mcp                MCP stdio bridge → a running Servify (SERVIFY_URL, SERVIFY_TOKEN)
 *   servify token <name> [--read]   create an API token directly in the local database
 *   servify service install | uninstall | status | print   run in the background, start at login/boot
 *   servify agent --join <url> --token <t> --fingerprint <fp>   let a Servify run services on this machine
 *   servify cert import <host> <fullchain.pem> <privkey.pem>   take over an existing certificate
 *
 * From your own machine, against a Servify here or on a server (see src/cli.ts):
 *   servify login [url] · link [project] [service] · up [--service name] · deploy · logs [-f] [--build]
 *   servify run <command…> · exec <command…> · status · open
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

const CLIENT = ['login', 'logout', 'link', 'unlink', 'up', 'deploy', 'logs', 'run', 'exec', 'status', 'open'];

if (CLIENT.includes(cmd)) {
  const { main } = await import(pathToFileURL(join(here, '../src/cli.ts')).href);
  await main(cmd, rest);
} else if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
  const { readFileSync } = await import('node:fs');
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*\n/, '').replace(/^ \* ?/gm, ''));
} else if (cmd === 'start') {
  await import(pathToFileURL(join(here, '../src/main.ts')).href);
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
  const name = rest.find((a) => !a.startsWith('--')) ?? 'agent';
  const { createToken } = await import(pathToFileURL(join(here, '../src/auth.ts')).href);
  const { token, record } = createToken(name, rest.includes('--read') ? 'read' : 'write');
  console.log(`Created ${record.scope} token "${record.name}":\n\n  ${token}\n\nIt won't be shown again.`);
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
} else if (cmd === 'agent') {
  await import(pathToFileURL(join(here, 'agent.mjs')).href);
} else if (cmd === 'service') {
  const { serviceCommand } = await import(pathToFileURL(join(here, 'service.mjs')).href);
  await serviceCommand(rest[0] ?? 'status', fileURLToPath(import.meta.url));
} else {
  console.log('usage: servify <command> — run `servify help` for the list');
  process.exit(cmd === 'help' || cmd === '--help' ? 0 : 1);
}
