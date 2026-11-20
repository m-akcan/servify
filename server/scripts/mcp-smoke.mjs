// Smoke-test the MCP endpoint with the official SDK client.
//   SERVIFY_TOKEN=svf_... node server/scripts/mcp-smoke.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = new URL((process.env.SERVIFY_URL ?? 'http://localhost:7700') + '/mcp');
const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${process.env.SERVIFY_TOKEN}` } } });
const client = new Client({ name: 'servify-smoke', version: '1.0.0' });
await client.connect(transport);
const { tools } = await client.listTools();
console.log(`${tools.length} tools:`, tools.map((t) => t.name).join(', '));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? '';
  if (r.isError) throw new Error(`${name}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
};
const proj = await call('create_project', { name: 'mcp-smoke' });
const created = await call('create_service', { project: proj.slug, templateId: 'whoami', name: 'echo' });
const done = await call('wait_for_deployment', { deployment: created.deployment.id, timeoutSec: 120 });
console.log('deploy:', done.status);
console.log('scale:', JSON.stringify(await call('scale_service', { service: `${proj.slug}/echo`, replicas: 3 })));
await new Promise((r) => setTimeout(r, 4000));
console.log('metrics replicas:', (await call('get_metrics', { service: `${proj.slug}/echo` })).replicas.length);
console.log('exec:', JSON.stringify(await call('exec_command', { service: `${proj.slug}/echo`, command: 'echo hello-from-$HOSTNAME' }).catch((e) => e.message)));
console.log('logs:', String(await call('get_service_logs', { service: `${proj.slug}/echo`, tail: 3 })).slice(0, 200));
console.log('activity:', (await call('get_activity', { project: proj.slug, limit: 3 })).map((a) => a.actor + ' ' + a.summary));
await call('delete_project', { project: proj.slug });
await client.close();
console.log('OK');
