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
- **HTTPS.** Automatic Let's Encrypt certificates for custom domains (HTTP-01, renewal, backoff, HTTP→HTTPS redirect), plus a private local CA so every app is also served at `https://<service>.<project>.localhost:8443`.
- **Deploy on push.** Signed GitHub, GitLab and Gitea/Forgejo webhooks deploy the moment you push; per-service deploy hook URLs for CI.
- **Notifications.** Slack, Discord, Telegram, ntfy, email (SMTP) and signed webhooks for failed deploys, services going down/recovering, failed cron jobs, backups and certificates.
- **Backups & restore.** Scheduled or one-click backups — consistent dumps for Postgres, MySQL/MariaDB and MongoDB, volume archives for everything else — to this machine, a folder or any S3-compatible bucket (AWS, R2, B2, MinIO…). Restores take a safety backup first.
- **Environments & PR previews.** Copy a project into `staging` (own URLs, fresh data, optional branch), and get a `pr-<n>` environment for every same-repo pull request, deleted when it closes.
- **Docker Compose import.** Paste a `docker-compose.yml`; services, variables (`.env` interpolation), volumes, replicas and limits carry over, compose hostnames keep working, and unsafe settings are refused with a warning.
- **History.** Runtime logs and metrics are kept for 7 days in SQLite — they survive redeploys and restarts, and can be searched, filtered by deployment and charted up to a week back.
- **PostgreSQL clusters.** A primary and streaming standbys, each on its own volume, with synchronous replication, automatic fenced failover, one-click switchover, and separate write (`DATABASE_URL`) and read (`DATABASE_READ_URL`) addresses.
- **Per-replica volumes.** Give each replica its own volume so software that replicates itself can scale; deploys roll one replica at a time.
- **Runs in the background.** `servify service install` starts it at login (launchd) or with your session/boot (systemd).
- **Volumes you can move.** Volumes are first-class: create them, attach them to a service, detach them (the data stays, as a card on the canvas), drag them onto another service, rename and delete them. Sizes are shown live.
- **Secrets encrypted at rest** (AES-256-GCM) with a master key you control.
- **A command line.** `servify up` uploads the folder you're in, builds and deploys it and follows the build; `link`, `deploy`, `logs -f`, `run` (a local command with the service's variables), `exec`, `status`, `open`.
- **Database browser.** A Data tab on Postgres and MySQL/MariaDB services: databases, tables, rows (sorted, paged, NULLs shown as such) and a SQL box that is read-only until you allow writes — using the client inside the container, nothing to install or expose.
- **Pre-deploy commands, build arguments and targets.** Run migrations in a one-off container before the new version starts (a failure keeps the old one); pass `--build-arg`s and pick a Dockerfile stage.
- **Shared variables** per project (and per environment), referenced as `${{ shared.NAME }}`, with secrets masked.
- **Watch paths** for monorepos: a push only deploys the services whose folders it touched.
- **Image updates.** Registry images are checked for a newer image under the same tag and for newer tags (the same major and the next one), with one-click updates and opt-in automatic ones. Uses manifest HEAD requests, which don't count against Docker Hub's pull limit.
- **App sleeping.** An HTTP service can stop after a while without requests and wake on the next one (about a second for a small app).
- **Usage alerts** when a server's disk, memory or CPU stays high, and again when it's back to normal.
- **Agent access.** Scoped API tokens, a REST API and an MCP server (Streamable HTTP + stdio) with 48 tools. Everything an agent does is attributed to its token.

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

### The command line

From any machine that can reach your Servify (needs Node 22.18+ and this repository, or `npm i -g ./server`):

```bash
servify login http://your-server:7700   # asks for an API token (Agents → API tokens)
cd my-app
servify up --project shop --service web  # creates the service on first use, uploads, builds, deploys
servify logs -f
servify run -- npm run migrate           # a local command with the service's variables
```

`up` honours `.gitignore` in a git repository (and always skips `.git` and `node_modules`); Docker still applies `.dockerignore` during the build. Links are remembered per folder; `SERVIFY_URL`, `SERVIFY_TOKEN`, `SERVIFY_PROJECT` and `SERVIFY_SERVICE` override everything for CI. Note that `run` gets the variables as the service sees them, so private hostnames like `postgres` only resolve inside Servify.

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

Tools: `overview`, `create_project`, `get_project`, `delete_project`, `list_templates`, `create_service`, `get_service`, `update_service`, `deploy_service`, `wait_for_deployment`, `scale_service`, `restart_service`, `stop_service`, `start_service`, `delete_service`, `rollback_service`, `set_variables`, `delete_variable`, `list_deployments`, `get_deployment_logs`, `get_service_logs`, `get_metrics`, `exec_command`, `get_activity`, `export_project`, `import_project`, `import_compose`, `load_test`, `run_job`, `list_runs`, `backup_service`, `list_backups`, `restore_backup`, `list_environments`, `create_environment`, `set_previews`, `list_certificates`, `list_volumes`, `create_volume`, `attach_volume`, `detach_volume`, `delete_volume`, `cluster_status`, `switchover`.

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

Main routes: `/api/projects`, `/api/projects/import`, `/api/projects/import-compose`, `/api/projects/:id/environments`, `/api/projects/:id/previews`, `/api/services/:id/backups`, `/api/backups/:id/{restore,download}`, `/api/projects/:id/volumes`, `/api/volumes/:id/{attach,detach}`, `/api/certs`, `/api/settings` (owner only for writes), `/api/hooks/git`, `/api/projects/:id/export`, `/api/projects/:id/services`, `/api/services/:id` (`GET`/`PATCH`/`DELETE`), `/api/services/:id/{deploy,restart,stop,start,scale,rollback,exec,duplicate,loadtest,run}`, `/api/services/:id/runs`, `/api/services/:id/volumes/:name/download`, `/api/services/:id/variables`, `/api/services/:id/{logs,metrics,deployments}`, `/api/deployments/:id/logs`, `/api/events` (SSE), `/api/activity`, `/api/templates`.

## HTTPS and custom domains

Add a domain to an HTTP service (Settings → Networking), point its DNS at this machine, and turn on **Settings → HTTPS**. Servify answers the HTTP-01 challenge on its router, stores the certificate (private key encrypted), renews it 30 days before expiry and redirects HTTP to HTTPS. Before asking the CA it checks that the domain really reaches this Servify, and failures back off (5 min → 24 h) so you never hit Let's Encrypt rate limits.

For public certificates the router must be reachable on ports 80 and 443:

```bash
SERVIFY_PROXY_HOST=0.0.0.0 SERVIFY_PROXY_PORT=80 SERVIFY_HTTPS_PORT=443 pnpm start
```

(macOS lets non-root processes bind those ports; on Linux grant `CAP_NET_BIND_SERVICE` or forward the ports.) Set `SERVIFY_BASE_DOMAIN` to a wildcard domain (`*.apps.example.com → this machine`) and every generated hostname gets a certificate too. Staging and custom ACME CAs (ZeroSSL, step-ca…) are one switch away.

Everything else — `*.localhost` — is served over HTTPS on `:8443` with certificates from a private Servify CA. Download it in Settings → HTTPS and trust it once for a green lock.

## Deploy on push

Settings → Git webhooks shows the payload URL (`/_servify/hooks/git` on the router, any hostname — so it works through a tunnel too) and the secret. Add it to your repository (GitHub, GitLab, Gitea/Forgejo; content type JSON; push + pull request events). Every git service with auto-deploy whose repository and branch match deploys immediately; the once-a-minute check stays as a fallback. Each service also has a **deploy hook** URL (Settings tab) for CI: `curl -X POST <url>`.

## Notifications

Settings → Notifications: add Slack, Discord, Telegram, ntfy, email or webhook channels and pick events (deploy failed/succeeded, service down/recovered, cron job failed, backup failed/succeeded, certificate failed, preview ready). "Down" alerts are de-duplicated (one per service per 10 minutes, and "recovered" only answers a "down" that was sent). Webhook payloads are signed: `X-Servify-Signature: sha256=<HMAC of the body>`.

## Volumes

A volume belongs to a project and is attached to at most one service. It shows as a tab under its service on the canvas (name and size). From its menu you can **detach** it — the service restarts without it and the volume stays on the canvas as a detached card, data intact — and then drag it onto any service in the project to **attach** it at a mount path. "Attach volume…" on a service (or "New volume here" on the canvas) creates a fresh one. Deleting a service keeps its volumes as detached volumes unless you ask otherwise; deleting a volume is the only thing that removes its data. Attach and detach redeploy the service immediately, so a volume is never mounted by two services at once, and a rollback never mounts a volume that has moved away. A service with a volume runs as a single replica.

### Bringing existing data and setups along

For moving existing Docker setups onto Servify (all owner-only — agent tokens are refused):

- **Take over a Docker volume** ("An existing Docker volume…" when attaching, or `docker compose` import with *Take over the existing Docker volumes*): the Servify volume points at the same Docker volume, nothing is copied. It's refused while any container outside Servify — running or stopped — still references the volume, so stop the old setup first (`docker compose down`, without `-v`). Adopted volumes are never deleted implicitly (deleting their service or project only forgets them); **Forget (keep the data)** hands any volume back.
- **Host folders** ("Host folder" in a service's volumes): a folder of the server mounted live, for media libraries or files you edit in place. Off until you start Servify with `SERVIFY_HOST_MOUNTS=/srv/media,/home/me/game` — only folders under those paths, never system folders, the Docker socket or Servify's own data. The folder must exist (Docker would silently create a missing one), symlinks are resolved before checking, and it can be read-only. On SELinux machines (Fedora, RHEL) pick a relabel (`z` shared, `Z` private) only if the container gets "permission denied" — relabelling a folder other programs use can break them. Host folders are never backed up, wiped by a restore or deleted.
- **Read-only shares** ("Share read-only with…" on a volume): another service of the project reads the volume — say a backup container reading a game server's world. It can't write, doesn't own it, and its backups, restores and deletes never touch it; the volume can't be deleted while it's shared.

## Published ports

Some things aren't HTTP and don't fit the TCP proxy: game servers, voice chat (UDP), anything that wants a fixed port. **Published ports** in a service's settings open a container port straight on the server (`0.0.0.0:25565 → 25565`, TCP or UDP). Owner only. A service with published ports runs as one replica and is redeployed stop-first (two containers can't hold one port). Servify refuses ports another service publishes, its own ports, and ports already busy on this machine. Anyone who can reach the server can reach them — check your firewall. Environment copies never get them.

## External routes

**New → Another machine** routes a domain (with automatic HTTPS) or a TCP proxy port to an address Servify doesn't run — a NAS, a VM, another box on your network (`http://192.168.1.20:8080`). Nothing is deployed: Servify health-checks the address, shows it on the canvas, alerts when it stops answering and serves "unavailable" meanwhile. The original `Host` header and WebSockets pass through. A TCP route can also **forward UDP** on the same proxy port (game servers, voice chat). Owner only (the router can reach whatever this machine can); plain HTTP targets only, since Servify terminates HTTPS.

## Redirects

**New → Redirect** makes a service whose domains only redirect — an old name to the new one, a bare domain to `www`. It keeps the path by default (`/blog?page=2` lands on the same path), answers `308` (permanent; `301`, `307` and `302` are available), gets HTTPS like any domain, and runs nothing.

## Behind another proxy

When something else terminates HTTPS in front of Servify (Nginx Proxy Manager, a cloud load balancer), set `SERVIFY_TRUSTED_PROXIES` to its address or network (e.g. `172.28.0.0/16`): requests from there keep their `X-Forwarded-Proto: https`, so apps build `https://` links and sign-in callbacks. From anywhere else the header is replaced with what Servify actually saw. The router has no overall request deadline, so long uploads and downloads finish.

## PostgreSQL clusters

Create a service from the **PostgreSQL cluster** template: three replicas, each with its own volume. Replica 0 initialises as the primary; the others clone it with `pg_basebackup` and stream from it. Apps write through `${{ db.DATABASE_URL }}` (the service name points at the primary only) and can read through `${{ db.DATABASE_READ_URL }}` (`<name>-read`, the standbys). The TCP proxy also routes to the primary.

- **Synchronous replication** (on by default): every commit waits for at least one standby (`ANY 1`), so a failover loses no acknowledged write. If no standby is streaming, Servify switches to asynchronous and alerts you rather than blocking writes.
- **Automatic failover:** if the primary is unreachable for 15 seconds (configurable, or off), Servify fences it — removes its container and keeps the reconciler from restarting it — promotes the most up-to-date standby, records it as the primary, moves the service name to it, re-points the other standbys, and then rebuilds the old primary as a standby. A member that claims to be a primary but isn't the primary of record is fenced on sight; when the situation is ambiguous nothing is wiped and you get an alert.
- **Switchover** ("Make primary" on a standby, or the `switchover` tool) hands over gracefully before maintenance. **Rebuild** re-clones a standby that fell behind.
- Deploys roll standbys first and the primary last; backups dump from the primary; restores re-initialise the whole cluster.

All members run on one server, so this protects against a crashed or hung database, not against losing that machine.

Volumes in general can be **per replica** ("One volume per replica" when creating one): each replica mounts its own volume, created on demand, and scaling down keeps the volumes for when you scale back up.

## Servers

Run services on other machines. **Servers → Add server** gives you one command to run on the new machine; it needs only Docker:

```bash
docker run -d --name servify-agent --restart unless-stopped --network host \
  -v /var/run/docker.sock:/var/run/docker.sock node:22-alpine sh -c '…'
```

The agent (`server/bin/agent.mjs`, no dependencies) connects **out** to this Servify, so the server needs no open ports. Before it sends its token it checks this Servify's certificate fingerprint (part of the command); the script itself is fetched from this Servify and checked against a hash in the command, then kept, so restarts reuse the verified copy (re-run the command to upgrade). From a Servify checkout you can also run `servify agent --join https://<host>:7701 --token … --fingerprint …`.

- **Placement:** pick the server when you create a service (or `server` in `create_service`). **Move** in a service's settings (or `move_service`) redeploys the same version on the other server — pulling it, or copying a built image across exactly rather than rebuilding — switches traffic once it is healthy, then removes the old replicas. Old images stay on the previous server until image cleanup removes them. Environments and project exports keep each service's server.
- **Everything runs where the service runs:** builds, image pulls, cron jobs, backups and `exec`; logs, metrics and backup files travel back. The router here reaches remote replicas through the agent's connection.
- **Volumes stay on their server.** A service with volumes can't move (back it up and restore it into a service on the other server), and a volume can't be attached to a service on another server. PostgreSQL clusters run all members on one server.
- **A private network across servers.** `db`, `${{ db.HOST }}` and friends work wherever the services run. When a project spans servers, each server gets a small relay container per service that lives elsewhere, answering on its names and main port; connections travel over TLS through this machine (the agents' pinned certificate, a per-project token) to a healthy replica. No ports open between servers. Only the main port is relayed, and the detour adds latency, so keep chatty pairs (an app and its database) on one server.
- **Offline is not down.** If a server stops answering, its services keep running there; Servify shows them as unreachable, does nothing to them (no restarts, no failovers, no deletes) and re-adopts them when the agent reconnects. You get a notification after a minute.

The agent endpoint listens on `0.0.0.0:7701` only once you add a server (`SERVIFY_AGENT_HOST`, `SERVIFY_AGENT_PORT`). The join command uses your first LAN address; set `SERVIFY_AGENT_PUBLIC_HOST` if servers reach this machine under another name (a VPN or public address). Treat an agent token like a password: whoever holds it can pose as that server.

## Start at login

**Settings → General → Start Servify at login.** Servify then starts in the background when you log in (a launchd agent on macOS, a systemd user service on Linux) and restarts if it crashes. Turning it on while Servify is running takes effect at your next login; turning it off never stops the running Servify. Logs go to `~/.servify/logs/servify.log`. The same from a terminal:

```bash
pnpm service install     # starts it now if Servify isn't running, otherwise from the next login
pnpm service status
pnpm service uninstall   # also stops it
pnpm service print       # show the file without installing anything
```

The login service runs with the `SERVIFY_*` and `DOCKER_HOST` settings Servify had when you turned it on. Each data directory gets its own agent, and only one Servify runs per data directory: a second copy exits right away. On Linux, `sudo loginctl enable-linger $USER` makes it start at boot without logging in.

## Backups

Services with data get a **Backups** tab: back up now, a schedule (cron), how many to keep, and where (this machine, any folder, or S3-compatible storage configured in Settings → Backup storage). Postgres, MySQL/MariaDB and MongoDB are dumped while they keep serving; other services' volumes are archived. **Restore** takes a safety backup, then rebuilds the data: dumps are replayed into a freshly initialised database, archives replace the volume contents. Backups can be downloaded as `.gz` files.

## Environments and pull-request previews

The **production ▾** menu next to the project name creates environments: a full copy of the project (services, variables, settings — fresh volumes, no custom domains) at `<service>.<project>-<env>.localhost`, optionally building git services from another branch. Turn on **pull-request previews** and each same-repository PR gets a `pr-<n>` environment on its branch, redeployed on every push and deleted when the PR closes (needs the git webhook with pull-request events). PRs from forks never get previews.

## Docker Compose

**Import → Docker Compose**: paste the file (and optionally the folder it lives in, for `build:` contexts, `env_file` and `.env`). Preview shows exactly what each service becomes. Images and builds, ports, `environment`/`env_file`/`${VAR:-default}` interpolation, named volumes, `command`/`entrypoint`, `deploy.replicas`, resource limits, HTTP healthchecks and `depends_on` (layout) carry over; services stay reachable by their compose names. Host folders are kept only when the owner imports and `SERVIFY_HOST_MOUNTS` allows them (with `:ro` / `:z` / `:Z`), UDP ports become published ports, and named volumes can be taken over in place. `privileged`, host networking/PID, extra capabilities, devices and the Docker socket are never honoured — each produces a warning instead.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `SERVIFY_DATA_DIR` | `~/.servify` | Database, logs, build scratch |
| `SERVIFY_HOST` / `SERVIFY_PORT` | `127.0.0.1` / `7700` | Dashboard, API, MCP |
| `SERVIFY_PROXY_HOST` / `SERVIFY_PROXY_PORT` | `127.0.0.1` / `8080` | Edge router (tries the next port if busy). Use `0.0.0.0` to serve your LAN. |
| `SERVIFY_HTTPS_PORT` | `8443` | HTTPS router (same host as the edge router) |
| `SERVIFY_MASTER_KEY` | | Encryption key for stored secrets (any string). Default: a generated `master.key` in the data dir |
| `SERVIFY_BASE_DOMAIN` | `localhost` | Generated URLs: `<service>.<project>.<base>` |
| `SERVIFY_TCP_PORT_START` | `15400` | First port for auto-assigned TCP proxies |
| `SERVIFY_ALLOWED_HOSTS` | | Extra hostnames allowed to reach the dashboard |
| `SERVIFY_AGENT_HOST` / `SERVIFY_AGENT_PORT` | `0.0.0.0` / `7701` | Where servers' agents connect (TLS). Only started once a server is added |
| `SERVIFY_AGENT_PUBLIC_HOST` | first LAN IPv4 | Address shown in the join command |
| `SERVIFY_TRUSTED_PROXIES` | | Proxies in front of Servify (IPs / IPv4 CIDRs) whose `X-Forwarded-Proto` is kept |
| `SERVIFY_HOST_MOUNTS` | | Folders services may mount from the host (comma-separated). Empty = host folders off |
| `SERVIFY_AUTH` | `password` | `none` disables the dashboard password (single-user machines only) |
| `SERVIFY_LOG_RETENTION_DAYS` / `SERVIFY_LOG_MAX_LINES` | `7` / `200000` | Runtime log history per service |
| `SERVIFY_METRICS_RETENTION_DAYS` | `7` | Metrics history |
| `SERVIFY_JOB_MAX_SECONDS` | `3600` | Cron runs are killed after this |
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
node scripts/acceptance.mjs           # end-to-end test against a running instance (real Docker)
node scripts/acceptance-features.mjs  # HTTPS, webhooks, notifications, backups, history, compose, environments
node web/scripts/gen-brand-icons.mjs  # refresh the service logos (simple-icons, CC0)
```

`scripts/acceptance-hosting.mjs` checks host folders, read-only shares, adopted volumes, published TCP/UDP ports, external routes, the Compose import that uses them, the owner-only gates and that restores and deletes never touch data a service doesn't own (see its header).

`scripts/acceptance-servers.mjs` starts a second Docker daemon (docker-in-docker), joins it with the real agent command and checks deploys, routing, builds, exec, backups, an agent outage, moves and a PostgreSQL cluster on it (see its header for the instance settings it needs).

The acceptance script deploys, load-balances, scales, redeploys under load (asserting zero failed requests), kills replicas, checks the TCP proxy and variable references, then cleans up. Set `SERVIFY_TOKEN` when auth is on. The feature suite needs owner access (`SERVIFY_COOKIE` or `SERVIFY_AUTH=none`); `SERVIFY_DATA_DIR` adds the "no plaintext secrets on disk" check. Both default to `http://localhost:7700` — point `SERVIFY_URL` at a test instance.

## Security notes

- Servify controls your Docker daemon, which is root-equivalent. Keep it bound to localhost unless you know what you're doing.
- The dashboard uses an scrypt-hashed owner password and an HttpOnly, SameSite=Strict session cookie. Writes must come from Servify's own origin (hosted apps live on `*.localhost` too, so this matters). Host headers are checked to block DNS rebinding.
- API tokens are stored as SHA-256 hashes and can be read-only. Secrets are masked for read-only tokens; instance settings can only be changed by the owner (not by agent tokens).
- Service variables, git tokens, resolved environments, notification credentials, storage keys, ACME account keys and certificate keys are encrypted at rest (AES-256-GCM). Back up `master.key` (or use `SERVIFY_MASTER_KEY`): without it the secrets are gone, and Servify refuses to start with the wrong key rather than overwrite them. Not encrypted: what Docker itself stores (a running container's environment), build logs, cron job output and runtime logs — keep secrets out of your log output.
- Git webhooks are verified with HMAC-SHA256 (GitHub, Gitea) or the secret token (GitLab) in constant time; payloads are capped at 2 MB.
- Compose imports never mount the Docker socket and never grant privileges. Host folders, published ports, external routes and taking over Docker volumes are owner-only (agent tokens get 403), checked again when containers are created, and left out of environment copies. Host folders must be under `SERVIFY_HOST_MOUNTS`.

## License

MIT
