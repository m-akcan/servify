// Smoke-test the stdio bridge: SERVIFY_TOKEN=... node server/scripts/stdio-smoke.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/servify.mjs', import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath, args: [bin, 'mcp'], env: { ...process.env } });
const client = new Client({ name: 'stdio-smoke', version: '1.0.0' });
await client.connect(transport);
const { tools } = await client.listTools();
const r = await client.callTool({ name: 'overview', arguments: {} });
console.log(`stdio OK: ${tools.length} tools; overview → ${JSON.parse(r.content[0].text).map((p) => p.name).join(', ')}`);
await client.close();
