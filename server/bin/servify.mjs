#!/usr/bin/env node
/**
 * servify CLI
 *   servify start              start the platform (dashboard, router, engine)
 *   servify mcp                MCP stdio bridge → a running Servify (SERVIFY_URL, SERVIFY_TOKEN)
 *   servify token <name> [--read]   create an API token directly in the local database
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

if (cmd === 'start') {
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
} else {
  console.log('usage: servify [start | mcp | token <name> [--read]]');
  process.exit(cmd === 'help' || cmd === '--help' ? 0 : 1);
}
