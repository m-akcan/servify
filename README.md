<p align="center">
  <img src="web/public/favicon.svg" width="64" height="64" alt="" />
</p>

<h1 align="center">Servify</h1>

<p align="center">
  A private, local-first platform for running your services.<br/>
  Deploy from GitHub, Docker images, local folders or templates · scale behind a built-in load balancer · let agents drive it over MCP.
</p>

---

Servify is a self-hosted PaaS in the spirit of Railway and Coolify, built to be **simpler**, to run **entirely on your machine**, and to be **as usable by AI agents as by people**. You get a live canvas of your services with real traffic flowing between them, zero-downtime deploys, replicas behind a load balancer, and an MCP server so Claude (or any MCP client) can deploy, scale and debug for you.

- **Local-first & private.** Binds to `127.0.0.1`. SQLite in `~/.servify`. No telemetry, no accounts, no cloud. Fonts are bundled.
- **Any source.** Docker image · git repository (GitHub shorthand, private repos with a token, `/tree/branch/dir` links) · a folder on your disk · one-click templates (Postgres, Redis, MySQL, MongoDB, MinIO, n8n, Uptime Kuma, Ollama…).
- **Zero-config builds.** Uses your Dockerfile, or detects Node (npm/pnpm/yarn/bun, Next.js, static SPAs like Vite), Python (FastAPI/Flask/Django), Go, Rust, Deno, Ruby (Rack), PHP or plain static sites and generates one. Builds with BuildKit.
- **Replicas + load balancing.** Turn the replica stepper and Servify starts more containers and balances across them — round-robin, least-connections, IP-hash or random — with active health checks, transparent retries, WebSocket support and an L4 TCP proxy for databases.
- **Zero-downtime deploys.** New replicas start alongside the old ones, must pass health checks, then traffic switches and old replicas drain. A failed deploy never touches what's running. One-click rollback to any previous image.
- **Self-healing.** A desired-state reconciler re-creates crashed or deleted replicas, backs off on crash loops, and re-adopts everything after a restart.
- **Wire services visually.** Drag from a service's ⊕ port onto another to add a reference like `DATABASE_URL=${{ postgres.DATABASE_URL }}`; dashed edges show every dependency.
- **Built-in test traffic.** Fire 10–150 req/s through the load balancer from the dashboard (or the `load_test` MCP tool) and watch it spread across replicas or trigger autoscaling.
- **Cron jobs.** Give a service a schedule (`*/15 * * * *`, `@daily`, …) and it runs as a one-off container on time, with run history, exit codes, output and a "Run now" button.
- **Backups.** Download any service's volume as a tarball in one click.
- **Console.** Run one-off commands (migrations, diagnostics) inside any replica.
- **Infrastructure as code.** Export a project as `servify.json`, import it anywhere — or let an agent write one and create a whole stack in a single call.
- **Autoscaling** on requests/s or CPU, **variable references** (`${{ postgres.DATABASE_URL }}`), persistent **volumes**, **custom domains**, resource limits, **git auto-deploy**, live **logs** across replicas, **metrics**, an **activity** audit trail.
- **Agent access.** Scoped API tokens, a REST API and an MCP server (Streamable HTTP + stdio) with 29 tools. Everything an agent does is attributed to its token.

## Quick start

Requirements: **Node.js 22.18+** and a running **Docker** (Docker Desktop, OrbStack, Colima, Rancher Desktop or plain dockerd). Servify finds the socket via `DOCKER_HOST`, your current `docker context`, or the usual paths.

```bash
git clone <this repo> servify && cd servify
pnpm install
pnpm build
pnpm start
```

Open **http://localhost:7700**, choose an owner password, and hit **Try the demo** for a ready-made stack (load-balanced web tier, an API built from a local folder, Redis and Postgres) — or create a project and deploy your own. Apps are served at
`http://<service>.<project>.localhost:8080` — `*.localhost` resolves to your machine in every modern browser and in curl, so there's nothing to configure.

### Run it in Docker instead

```bash
docker compose up -d --build
```

The container mounts the Docker socket and runs your services as sibling containers. Ports are published on `127.0.0.1` only. (Local-folder sources must be paths visible inside the container — mount them if you need them. TCP proxy ports also need publishing.)

## The canvas

The dashboard is a hand-built infinite canvas (no diagram library):

| Gesture | Action |
| --- | --- |
| Drag empty space / two-finger scroll | Pan (with momentum) |
| Pinch / ⌘ + scroll | Zoom at the cursor |
| Drag a service | Move it (snaps to the grid, saved) |
| Double-click empty space / <kbd>N</kbd> | New service here |
| Right-click | Context menu |
| <kbd>F</kbd> · <kbd>0</kbd> · <kbd>+</kbd>/<kbd>−</kbd> | Fit · 100% · zoom |
| <kbd>Tab</kbd> / <kbd>⇧Tab</kbd> | Cycle through services |
| <kbd>⇧</kbd> + drag / <kbd>⇧</kbd> + click | Multi-select, then drag to move together |
| Drag a node's ⊕ port onto another | Connect: add a variable reference |
| Double-click a service | Focus and open it |
| <kbd>⌘Z</kbd> | Undo a move |
| <kbd>?</kbd> | All shortcuts |
| <kbd>⌘K</kbd> | Command palette |
| <kbd>Esc</kbd> · <kbd>⌫</kbd> | Close panel · delete selected service |

The **Edge** node is the built-in router. Glowing particles flow from it into each service at a rate driven by real requests per second; each replica's LED pip brightens with the share of traffic it receives. Dashed edges are variable references between services. Stacked cards behind a node show its replicas.

## Agents & MCP

Create a token under **Agents** (full access or read-only), then:

**Claude Code**
```bash
claude mcp add --transport http servify http://localhost:7700/mcp --header "Authorization: Bearer svf_…"
```

**Any MCP client (Streamable HTTP)**
```json
{ "mcpServers": { "servify": { "type": "http", "url": "http://localhost:7700/mcp", "headers": { "Authorization": "Bearer svf_…" } } } }
```

**stdio-only clients**
```json
{ "mcpServers": { "servify": { "command": "node", "args": ["/path/to/servify/server/bin/servify.mjs", "mcp"], "env": { "SERVIFY_URL": "http://localhost:7700", "SERVIFY_TOKEN": "svf_…" } } } }
```

Tools: `overview`, `create_project`, `get_project`, `delete_project`, `list_templates`, `create_service`, `get_service`, `update_service`, `deploy_service`, `wait_for_deployment`, `scale_service`, `restart_service`, `stop_service`, `start_service`, `delete_service`, `rollback_service`, `set_variables`, `delete_variable`, `list_deployments`, `get_deployment_logs`, `get_service_logs`, `get_metrics`, `exec_command`, `get_activity`, `export_project`, `import_project`, `load_test`, `run_job`, `list_runs`.

Example — an agent can create a full stack in one call with `import_project`:

```json
{
  "servify": 1,
  "name": "shop",
  "services": [
    { "name": "db", "templateId": "postgres", "source": { "type": "image", "image": "postgres:17-alpine" } },
    { "name": "api", "source": { "type": "git", "repo": "acme/shop-api" }, "replicas": 3,
      "env": { "DATABASE_URL": "${{ db.DATABASE_URL }}" } }
  ]
}
```

A token can also be created from the terminal: `pnpm token my-agent` (add `--read` for read-only).

### REST API

Same capabilities, same tokens:

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:7700/api/projects
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"image":"nginx:alpine","replicas":3}' http://localhost:7700/api/projects/<project>/services
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"replicas":5}' http://localhost:7700/api/services/<service>/scale
```

Main routes: `/api/projects`, `/api/projects/import`, `/api/projects/:id/export`, `/api/projects/:id/services`, `/api/services/:id` (`GET`/`PATCH`/`DELETE`), `/api/services/:id/{deploy,restart,stop,start,scale,rollback,exec,duplicate,loadtest,run}`, `/api/services/:id/runs`, `/api/services/:id/volumes/:name/download`, `/api/services/:id/variables`, `/api/services/:id/{logs,metrics,deployments}`, `/api/deployments/:id/logs`, `/api/events` (SSE), `/api/activity`, `/api/templates`.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `SERVIFY_DATA_DIR` | `~/.servify` | Database, logs, build scratch |
| `SERVIFY_HOST` / `SERVIFY_PORT` | `127.0.0.1` / `7700` | Dashboard, API, MCP |
| `SERVIFY_PROXY_HOST` / `SERVIFY_PROXY_PORT` | `127.0.0.1` / `8080` | Edge router (tries the next port if busy). Use `0.0.0.0` to serve your LAN. |
| `SERVIFY_BASE_DOMAIN` | `localhost` | Generated URLs: `<service>.<project>.<base>` |
| `SERVIFY_TCP_PORT_START` | `15400` | First port for auto-assigned TCP proxies |
| `SERVIFY_ALLOWED_HOSTS` | | Extra hostnames allowed to reach the dashboard |
| `SERVIFY_AUTH` | `password` | `none` disables the dashboard password (single-user machines only) |
| `DOCKER_HOST` | auto | Docker endpoint |

## How it works

```
 browser / agent ──► :7700  Hono API · SSE · MCP ──► ops.ts (one service layer)
                                                       │
                     engine.ts  desired-state reconciler ◄─┤─► deployer.ts  build → start → health → switch → drain
                         │                                 └─► builder.ts   git clone / local dir → detect → BuildKit
                         ▼
                 Docker Engine API (unix socket, labelled servify.*)
                         ▲
 clients ──► :8080  proxy.ts  Host routing · LB · retries · WS ──► replicas on 127.0.0.1:<ephemeral>
             :154xx TCP proxies ───────────────────────────────►
```

- **server/** — Node 22+ running TypeScript natively, `node:sqlite`, Hono, the official MCP SDK. No Docker SDK: a small, explicit Engine API client (`docker.ts`).
- **web/** — React + Vite. The canvas, spring-physics motion engine, charts, and every component are hand-written. Design system "Basalt" lives in `web/src/styles/tokens.css`.

Every container, network and volume Servify creates carries `servify.*` labels, including a per-installation instance id, so multiple installations never interfere and a restart simply re-adopts what's running.

## Development

```bash
pnpm dev                     # API on :7700 (watch) + Vite on :5173
pnpm typecheck
node scripts/acceptance.mjs  # end-to-end test against a running instance (real Docker)
```

The acceptance script deploys, load-balances, scales, redeploys under load (asserting zero failed requests), kills replicas, checks the TCP proxy and variable references, then cleans up. Set `SERVIFY_TOKEN` when auth is on.

## Security notes

- Servify controls your Docker daemon, which is root-equivalent. Keep it bound to localhost unless you know what you're doing.
- The dashboard uses an scrypt-hashed owner password and an HttpOnly, SameSite=Strict session cookie. Writes must come from Servify's own origin (hosted apps live on `*.localhost` too, so this matters). Host headers are checked to block DNS rebinding.
- API tokens are stored as SHA-256 hashes and can be read-only. Secrets are masked for read-only tokens.

## License

MIT
