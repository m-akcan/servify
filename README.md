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
- **Replicas + load balancing.** Turn the replica stepper and Servify starts more containers and balances across them — round-robin, least-connections, IP-hash or random — with active health checks, transparent retries, WebSocket support and an L4 TCP proxy for databases. A replica that fails its health check is taken out of rotation; one that keeps running but stays stuck (deadlocked, out of connections, answering 500 forever) is **restarted** once it has failed for 2 minutes after its startup grace (for a service with data that hasn't passed a check since it started, at least `SERVIFY_UPGRADE_GRACE_SECONDS`: migrations, WAL replay) — at most 3 times an hour, each further restart waiting longer (2 more minutes of failing before the second, 4 before the third …), then Servify stops, marks the service as needing attention and notifies once (the *Service down* notification). Counting starts over once it has been healthy for 10 minutes, or with a deploy. Each restart is in the activity log, the service's logs and a notification. Never restarted this way: services being deployed, backed up or restored, asleep or just woken, cron jobs, workers, and PostgreSQL cluster members (the cluster fails over from an unreachable primary itself; a stuck standby is shown in the cluster panel to rebuild). Replicas on another server count only while it is connected and answering — an unreachable server is never a hung replica. On by default; per service under **Settings → Health checks** (`healthcheck.autoRestart` / `restartAfterSec` in the API and MCP `update_service`).
- **Zero-downtime deploys.** New replicas start alongside the old ones, must pass health checks, then traffic switches and old replicas drain. A failed deploy never touches what's running — except for services that can't run two versions side by side (a shared volume, published ports, one volume per replica): there the old replica stops first, and if the new one fails Servify starts the old version again and says so in the notification. Before a new image starts on such a service's data, Servify makes sure a recent backup exists (see [Safety backups](#safety-backups)), and the first start after an image change may take up to 10 minutes before it counts as unhealthy (data migrations; `SERVIFY_UPGRADE_GRACE_SECONDS`, 0 = only the service's own startup grace). One-click rollback to any previous image.
- **Registry images are pulled, or the deploy fails.** A deploy pulls a registry image when it is `:latest` or not on the server yet (an image update always pulls). If that pull fails — no credentials, not found, registry unreachable — the deployment fails with a short reason (`pull failed: unauthorized — no credentials for ghcr.io`), the running version stays and the failed-deploy notification fires; it never quietly deploys an older copy. For private registries add a login under **Settings → Registry logins** (registry host, username, token; see [Deploy from GHCR](#deploy-from-github-container-registry-ghcr)). The token is encrypted at rest and never returned by the API (`GET/POST /api/settings/registries`, `DELETE /api/settings/registries/:id`, `POST /api/settings/registries/:id/test`, owner only). It is used for pulls on this machine and on remote servers, where it goes to that server's Docker for each pull only (in the pull request through the agent tunnel; nothing is stored there), and for image update checks. Servify also reads a `docker login` made on this machine by the user it runs as, the way the docker CLI does (`~/.docker/config.json` or `$DOCKER_CONFIG`: `credHelpers`, `credsStore`, `auths`). That one is used for pulls on this machine and for update checks only, never sent to a remote server by Servify. A dashboard login wins over a docker one for the same registry. Logins are never written to logs or messages. To deploy the copy already on the server while a registry is down, use **Deploy cached image** on the failed deployment (`POST /api/services/:id/deploy {"useCachedImage": true}`, or `useCachedImage` on `deploy_service`). Restarts, rollbacks, crash recovery and scaling reuse the image on the server and never need the registry; images that only exist on the server (built there, or tagged locally under a plain name like `myapp:latest`) are used as they are. On Docker's containerd image store Servify can only tell a local-only `:latest` image from a registry one by asking Docker Hub, which works for plain names like `myapp` but not for `owner/name` (it looks like a private repository) or while Docker Hub is unreachable — give such images a fixed tag.
- **Self-healing.** A desired-state reconciler re-creates crashed or deleted replicas, backs off on crash loops, and re-adopts everything after a restart.
- **Wire services visually.** Drag from a service's ⊕ port onto another ("this one uses that one") to add the right reference — `DATABASE_URL=${{ postgres.DATABASE_URL }}`, `AMQP_URL` for RabbitMQ, `REDIS_URL` — and deploy in one click. Drop it on empty canvas instead: from an app, add a database, cache, queue or storage it uses (created there, connected, and the app redeployed once it's up); from a database or queue, start a new service that uses it. Dashed edges show every dependency.
- **Built-in test traffic.** Fire 10–150 req/s through the load balancer from the dashboard (or the `load_test` MCP tool) and watch it spread across replicas or trigger autoscaling.
- **Cron jobs.** Give a service a schedule (`*/15 * * * *`, `@daily`, …) and it runs as a one-off container on time, with run history, exit codes, output and a "Run now" button. Schedules are read in the server's local time, or in a time zone you give the job (`Europe/Berlin`, `UTC`). When clocks change, a job set for a fixed time runs once: not twice in the repeated hour, and right after the skipped hour if its time fell inside it.
  - **Missed runs.** A start missed while Servify wasn't running (stopped, updating, the machine asleep), or while the job's server was offline, can run once, late, after Servify is back. It runs only while that is within half the time to the next run, at most 24 h: a daily job catches up for 12 h, an hourly one for 30 min, and an every-minute job never. Several missed starts still give one run, and never a run when the regular one is due that minute anyway. A start that did happen never runs again, across restarts and clock changes. This is off by default, because a job may not be safe to run late or twice (mails, billing). Turn it on per job under **Settings → Schedule → Catch up missed runs** (`scheduleCatchUp` in the API and MCP `update_service`). Catch-up runs are marked *catch-up* in the run history (`catchUp: { dueAt, missed }`).
  - **Skipped runs** are in the history too, with the reason and the time (status `skipped`, `reason`): the previous run still going, the server offline, or runs missed while Servify wasn't running and not caught up. Several skips in a row for the same reason share one record (`skipCount`, first and last time).
  - **Failures** notify on the first failed run, then stay quiet while the job keeps failing. A reminder goes out every 24 h (Settings → Notifications → *Jobs and backups that keep failing*; `alerts.failureRemindHours`, 0 = never), and one *recovered* notice when a run succeeds again. Every run is still recorded. The job shows *failing since …* (`cron.failing` on the service), and that state survives a restart, so a restart doesn't notify again.
- **Backups.** Download any service's volume as a tarball in one click.
- **Console.** Run one-off commands (migrations, diagnostics) inside any replica.
- **Infrastructure as code.** Export a project as `servify.json`, import it anywhere — or let an agent write one and create a whole stack in a single call.
- **Autoscaling** on requests/s or CPU, **variable references** (`${{ postgres.DATABASE_URL }}`), persistent **volumes**, **custom domains**, resource limits, **git auto-deploy**, live **logs** across replicas, **metrics**, an **activity** audit trail.
- **HTTPS.** Automatic Let's Encrypt certificates for custom domains (HTTP-01, renewal, backoff, HTTP→HTTPS redirect), plus a private local CA so every app is also served at `https://<service>.<project>.localhost:8443`.
- **Deploy on push.** Signed GitHub, GitLab and Gitea/Forgejo webhooks deploy the moment you push; per-service deploy hook URLs for CI.
- **Notifications.** Slack, Discord, Telegram, ntfy, email (SMTP) and signed webhooks for failed deploys, services going down/recovering, failed cron jobs, backups and certificates. A cron job, scheduled backup or test restore that keeps failing notifies once, reminds every 24 h, and says when it recovers.
- **Backups & restore.** Scheduled or one-click backups — consistent dumps for Postgres, MySQL/MariaDB and MongoDB, volume archives for everything else — to this machine, a folder or any S3-compatible bucket (AWS, R2, B2, MinIO…). Restores take a safety backup first; so do new images on a service's data and deleting volumes, reusing the nightly backup when there is one.
- **Environments & PR previews.** Copy a project into `staging` (own URLs, fresh data, optional branch), and get a `pr-<n>` environment for every same-repo pull request, deleted when it closes.
- **Docker Compose import.** Paste a `docker-compose.yml`; services, variables (`.env` interpolation), volumes, replicas and limits carry over, compose hostnames keep working, and unsafe settings are refused with a warning.
- **History.** Runtime logs and metrics are kept for 7 days in SQLite — they survive redeploys and restarts, and can be searched, filtered by deployment and charted up to a week back.
- **PostgreSQL clusters.** A primary and streaming standbys, each on its own volume, with synchronous replication, automatic fenced failover, one-click switchover, and separate write (`DATABASE_URL`) and read (`DATABASE_READ_URL`) addresses.
- **Per-replica volumes.** Give each replica its own volume so software that replicates itself can scale; deploys roll one replica at a time.
- **Runs in the background.** `servify service install` starts it at login (launchd) or with your session/boot (systemd).
- **Updates itself.** Settings → General → Check for updates installs a new release and restarts; if the new version can't start, it goes back to the previous one, database included.
- **Volumes you can move.** Volumes are first-class: create them, attach them to a service, detach them (the data stays, as a card on the canvas), drag them onto another service, rename and delete them. Sizes are shown live.
- **Secrets encrypted at rest** (AES-256-GCM) with a master key you control.
- **A command line.** `servify up` uploads the folder you're in, builds and deploys it and follows the build; `link`, `deploy`, `logs -f`, `run` (a local command with the service's variables), `exec`, `status`, `open`.
- **Database browser.** A Data tab on Postgres and MySQL/MariaDB services: databases, tables, rows (sorted, paged, NULLs shown as such) and a SQL box that is read-only until you allow writes (a guard against accidents, not a permission boundary — anyone with write access can switch it) — using the client inside the container, nothing to install or expose.
- **Pre-deploy commands, build arguments and targets.** Run migrations in a one-off container before the new version starts (a failure keeps the old one); pass `--build-arg`s and pick a Dockerfile stage.
- **Shared variables** per project (and per environment), referenced as `${{ shared.NAME }}`, with secrets masked.
- **Watch paths** for monorepos: a push only deploys the services whose folders it touched.
- **Image updates.** Registry images are checked for a newer image under the same tag and for newer tags (the same major and the next one), with one-click updates and opt-in automatic ones. Uses manifest HEAD requests, which don't count against Docker Hub's pull limit. A service running a pinned local copy can be pointed back at its registry image without a restart (`POST /api/services/:id/track-image`), but only when the registry tag is byte-identical to what runs.
  Builds (git, local folder, upload) are checked the same way for the **base image** of their Dockerfile: the `FROM` of the last stage (or of the build target), following `FROM <earlier stage>` back to an image, with `ARG` defaults before the first `FROM` and the service's build arguments filled in (`ARG NEXTCLOUD_TAG=35.0.3` + `FROM nextcloud:${NEXTCLOUD_TAG}` → `nextcloud:35.0.3`). The ref and the digest the build used are recorded on the deployment when it builds. The service then reports newer tags (same major and next major) and a newer image published under the same tag, notified once (`image.update`, e.g. "Base image nextcloud:35.0.3 → 35.0.4, 36.0.1 (next major) available"). That digest comes from BuildKit's log, or from the local base image for the classic builder. `FROM scratch`, digest-pinned refs, tags that depend on unset variables (`TARGETARCH`) and generated (zero-config) Dockerfiles aren't checked. Builds never update by themselves. **Update** (`POST /api/services/:id/update-image`) pulls the base into the server's image store, so later plain builds use it too, then rebuilds with `--pull`. A plain build reuses the base already on the server. A failed pull fails the update, and the running version stays. With a `tag` it first sets the build argument the whole tag comes from (`BASE_TAG=1.1`, backing up a service with data first). A tag written into the Dockerfile itself has to be changed there. A build deployed before this existed has no recorded base until it is deployed once more.
- **Access log.** The router records every HTTP request to a service (WebSocket upgrades and redirects too): time, host, method, path and query, status, bytes, duration, referrer, user agent and replica — without IP addresses. Visitors are told apart by a key hashed from the IP, the user agent and a random salt that changes every UTC day and is only ever kept in memory (never in the database or its backups), so they can be counted per day, and once the day is over its keys can't be traced back to an address. A restart starts a new salt, so someone who visits before and after one counts twice that day. A daily summary gives requests and unique visitors with crawlers and AI bots (GPTBot, ClaudeBot, PerplexityBot…) apart from people, plus top pages, referrers, UTM sources and user agents. Kept for 7 days, on by default, switchable per service; readable with a read-only token.
- **Traffic board.** One page (Traffic in the top bar) shows Servify's router with a string to every project that's reachable from outside. Strings thicken and fill with moving dots as requests flow, turn red on server errors, and run dashed for TCP-only routes. Each project shows its domains, live requests per second, a one-minute sparkline and the last 24 hours (requests, people, errors), busiest first. Beside it, a live feed lists requests across all projects as they arrive: status, host and path, the project, where the visitor came from, and bot names.
- **App sleeping.** An HTTP service can stop after a while without requests and wake on the next one (about a second for a small app).
- **Usage alerts** when a server's disk, memory or CPU stays high, and again when it's back to normal.
- **Agent access.** Scoped API tokens, a REST API and an MCP server (Streamable HTTP + stdio) with 52 tools. Everything an agent does is attributed to its token.

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
servify deploy --tag 1.4.2               # an image service: switch to that tag of its image and deploy
```

The everyday commands (each acts on the folder's linked service, or `--project`/`--service`):

```bash
servify variables                        # names, values masked (--reveal shows them; read-only tokens still see secrets masked)
servify variables get DATABASE_URL       # just the value, for scripts
servify variables set LOG_LEVEL=debug FEATURE_X=on --deploy   # --deploy redeploys now; otherwise it says a redeploy is needed
servify variables set STRIPE_KEY < key.txt                    # a name alone reads its value from stdin (a hidden prompt on a terminal)
servify variables set --from-file .env.production             # a .env file (or - for stdin): no secrets in your shell history
servify variables unset FEATURE_X
servify vars set --shared REGION=eu-1    # the project's shared variables (${{shared.REGION}}); vars = variables
servify backup                           # back up now and wait (--destination, --no-wait)
servify backup list                      # id, size, sha256 (short), test result
servify backup test bak_…                # restore it into a scratch copy, without touching the service
servify backup download bak_… -o db.sql.gz   # streams it and checks its sha256 (a mismatch exits 1, nothing kept)
servify restore bak_…                    # asks first (--yes in scripts), shows each step, exits 1 if it fails
servify rollback                         # back to the previous live image (or `rollback dep_…`; `servify deployments` lists them)
servify restart --skip-safety-backup     # rollback and restart take --skip-safety-backup too, like deploy
servify exec -- sh -c 'echo "$HOSTNAME"' # arguments reach the container as they are; the exit code is passed on
```

`servify help <command>` (or `servify <command> --help`) shows every option. `exec` passes several words as the argv itself (`POST /api/services/:id/exec` takes `{"command": ["sh", "-c", "…"]}` as well as a string); a single argument with shell syntax in it, like `servify exec 'ls | wc -l'`, still runs through `/bin/sh -c`. Variables with SECRET, PASSWORD, TOKEN or KEY in a new name are marked secret (masked for read-only and deploy tokens); `--secret` marks any.

`up` refuses to replace a service's image, git or folder source unless you confirm (or pass `--replace`). It honours `.gitignore` in a git repository (and always skips `.git` and `node_modules`); Docker still applies `.dockerignore` during the build. Links are remembered per folder; `SERVIFY_URL`, `SERVIFY_TOKEN`, `SERVIFY_PROJECT` and `SERVIFY_SERVICE` override everything for CI. Note that `run` gets the variables as the service sees them, so private hostnames like `postgres` only resolve inside Servify.

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

Create a token under **Agents** (full access, deploy only or read-only; for all projects or only some — see [Token scopes](#token-scopes)), then:

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

Tools: `overview`, `create_project`, `get_project`, `delete_project`, `list_templates`, `create_service`, `get_service`, `update_service`, `deploy_service`, `wait_for_deployment`, `scale_service`, `restart_service`, `stop_service`, `start_service`, `delete_service`, `rollback_service`, `set_variables`, `delete_variable`, `list_deployments`, `get_deployment_logs`, `get_service_logs`, `get_access_log`, `get_access_summary`, `get_metrics`, `exec_command`, `update_image`, `get_activity`, `export_project`, `import_project`, `import_compose`, `load_test`, `run_job`, `list_runs`, `backup_service`, `list_backups`, `restore_backup`, `list_environments`, `create_environment`, `set_previews`, `list_certificates`, `list_volumes`, `create_volume`, `attach_volume`, `detach_volume`, `delete_volume`, `cluster_status`, `switchover`.

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

A token can also be created from the terminal: `pnpm token my-agent` (full access to every project), with `--scope read|deploy|write` (`--read` still works) and `--project <id or slug>` (repeat it, or give a comma list), e.g. `pnpm token ci --scope deploy --project shop`.

### Token scopes

A token has a **scope** and, optionally, a **project list**:

| Scope | May | May not |
| --- | --- | --- |
| `read` | read projects, services, deployments, logs, metrics, backups, volumes, activity and events; secrets are masked | change anything |
| `deploy` | everything `read` may, plus deploy, restart, roll back, update an image (`POST /api/services/:id/update-image {"tag": "1.4.2"}`, the MCP tool `update_image`, `servify deploy --tag 1.4.2`), cancel a queued deploy, check for image updates, and `servify up` to a service whose source already is an upload | change settings, variables, volumes or domains; stop, scale, exec or run jobs; delete anything; read secrets (resolved variables, deploy hook URLs, downloads, database contents, secret exports); skip the safety backup |
| `write` | everything an agent can do | owner-only actions |

**Project list.** Left out, the token reaches every project, including new ones (every token created before scopes existed is such a token, and keeps working exactly as before). Given, the token reaches only those projects and their environments and pull-request previews, by REST, MCP and the event stream alike: project lists, the activity feed, the traffic board and `/api/events` return only what is in reach, anything else reads as not found (404), and instance-wide routes (`/api/system`, `/api/servers`, `/api/overview`, `/api/settings`, `/api/certs`) are refused (403). Such a token can't create projects — not directly, by importing a spec or a compose file — because a new project would be outside its list; it can create environments of its projects, which are in reach automatically. Pick base projects: an environment can't be listed on its own (it reads its base project's shared variables). Moving a service to another project, attaching or sharing a volume, and rolling back to a deployment need both ends in reach. Variable references never reach outside a project (and its base project) anyway.

Deploy tokens and project-limited tokens start with `svs_` instead of `svf_`. Servify 0.2.3 and older only accept `svf_`, so if an update is rolled back to such a version, these tokens stop working rather than acting as full-access tokens.

**Owner-only** actions stay owner-only for every token whatever its scope: servers, instance settings, notifications and delivery logs, tokens and devices, HTTPS settings and certificate retries, Servify updates, host folders and local-path builds, published ports, external routes and taking over Docker volumes. The dashboard, a signed-in phone and `SERVIFY_AUTH=none` are the owner.

**Deploy tokens vs. deploy hooks.** A deploy hook (`/_servify/hooks/deploy/<service>/<secret>`, under a service's Settings) redeploys one service as configured and says nothing back. A deploy token covers several services or projects, can ship a specific image tag, restart or roll back, and can follow the deploy and read its logs, so CI can wait for the result and fail the build:

```bash
SERVIFY_URL=https://servify.example.com SERVIFY_TOKEN=$DEPLOY_TOKEN SERVIFY_PROJECT=shop SERVIFY_SERVICE=api \
  servify deploy --tag "$GIT_SHA"     # exits non-zero if the deploy fails
```

Whatever is deployed runs with the service's variables, so code shipped with a deploy token (an image tag, an upload) can read them: give deploy tokens to pipelines you trust with the service, and keep secrets out of logs. Every route and MCP tool is classified in [`server/src/policy.ts`](server/src/policy.ts), enforced in one place for REST (`server/src/api.ts`) and MCP (`server/src/mcp.ts`); a route missing from it answers the owner only, and the acceptance suite (`ONLY=tokens`) fails when one is missing.

### REST API

Same capabilities, same tokens:

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:7700/api/projects
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"image":"nginx:alpine","replicas":3}' http://localhost:7700/api/projects/<project>/services
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"replicas":5}' http://localhost:7700/api/services/<service>/scale
```

Main routes: `/api/projects`, `/api/projects/import`, `/api/projects/import-compose`, `/api/projects/:id/environments`, `/api/projects/:id/previews`, `/api/services/:id/backups` (`POST {"wait": false}` answers 202 once it has started), `/api/backups/:id` (the record: checksum, last test, and `restore` — the last restore's step and outcome), `/api/backups/:id/{restore,test,download}`, `/api/projects/:id/volumes`, `/api/volumes/:id/{attach,detach}`, `/api/certs`, `/api/settings` (owner only for writes), `/api/hooks/git`, `/api/projects/:id/export`, `/api/projects/:id/services`, `/api/services/:id` (`GET`/`PATCH`/`DELETE`), `/api/services/:id/{deploy,restart,stop,start,scale,rollback,exec,duplicate,loadtest,run}`, `/api/services/:id/runs`, `/api/services/:id/volumes/:name/download`, `/api/services/:id/variables`, `/api/services/:id/{logs,metrics,deployments}`, `/api/services/:id/access-log` (`?since=&until=&path=&status=&q=&bot=&limit=&before=`) and `/api/services/:id/access-log/summary?day=YYYY-MM-DD`, `/api/access-log/recent?after=&limit=` and `/api/access-log/totals?hours=24` (across all services, for the traffic board), `/api/deployments/:id/logs`, `/api/events` (SSE), `/api/activity`, `/api/templates`, `/api/tokens` (owner: `{"name", "scope": "read"|"deploy"|"write", "projects": [ids or slugs]}`).

## HTTPS and custom domains

Add a domain to an HTTP service (Settings → Networking), point its DNS at this machine, and turn on **Settings → HTTPS**. Servify answers the HTTP-01 challenge on its router, stores the certificate (private key encrypted), renews it 30 days before expiry and redirects HTTP to HTTPS. Before asking the CA it checks that the domain really reaches this Servify, and failures back off (5 min → 24 h) so you never hit Let's Encrypt rate limits.

For public certificates the router must be reachable on ports 80 and 443:

```bash
SERVIFY_PROXY_HOST=0.0.0.0 SERVIFY_PROXY_PORT=80 SERVIFY_HTTPS_PORT=443 pnpm start
```

(macOS lets non-root processes bind those ports; on Linux grant `CAP_NET_BIND_SERVICE` or forward the ports.) Set `SERVIFY_BASE_DOMAIN` to a wildcard domain (`*.apps.example.com → this machine`) and every generated hostname gets a certificate too. Staging and custom ACME CAs (ZeroSSL, step-ca…) are one switch away.

Everything else — `*.localhost` — is served over HTTPS on `:8443` with certificates from a private Servify CA. Download it in Settings → HTTPS and trust it once for a green lock. Settings → HTTPS also shows the CA's SHA-256 fingerprint (`GET /api/certs/local-ca` returns `{ pem, fingerprint256 }`); the Android app shows the same value before it pins the CA, so you can compare the two. Clients that connect by IP address send no server name: they get a local-CA certificate that names `localhost`, `127.0.0.1`, `::1` and the machine's own private LAN and VPN addresses at startup (RFC 1918, 100.64.0.0/10, IPv6 ULA; never public addresses or Docker bridges). Anyone who connects by IP can read that list.

### The dashboard on its own domain

**Settings → HTTPS → Dashboard domain** (owner only) makes the router serve the dashboard, `/api` and `/mcp` for one host name over HTTPS — for example `servify.home.arpa` for the phone app. Names ending in `.lan`, `.local`, `.home.arpa`, `.internal` or `.localhost` (or an IPv4 address of the machine) use the local CA; a public domain gets a Let's Encrypt certificate like any custom domain when automatic HTTPS is on. Plain HTTP for that host is redirected to HTTPS, the name is allowed by the host check automatically (no `SERVIFY_ALLOWED_HOSTS` needed), and cookies, the Origin check, server-sent events, MCP and Bearer tokens work as on the dashboard port.

Setting a domain never puts the dashboard on the internet by accident: it starts **private networks only** (the same preset as below), and the owner can change the list. Behind a reverse proxy that isn't in `SERVIFY_TRUSTED_PROXIES`, requests for the dashboard domain that carry `X-Forwarded-For` are refused (every visitor would look like the proxy) and Settings → HTTPS says so. It can't be set while `SERVIFY_AUTH=none`. The router must listen where your devices can reach it (`SERVIFY_PROXY_HOST=0.0.0.0`).

## Deploy on push

Settings → Git webhooks shows the payload URL (`/_servify/hooks/git` on the router, any hostname — so it works through a tunnel too) and the secret. Add it to your repository (GitHub, GitLab, Gitea/Forgejo; content type JSON; push + pull request events). Every git service with auto-deploy whose repository and branch match deploys immediately; the once-a-minute check stays as a fallback. Each service also has a **deploy hook** URL (Settings tab) for CI: `curl -X POST <url>`.

### Deploy from GitHub Container Registry (GHCR)

CI builds and pushes the image, then calls the service's deploy hook. Nothing has to run on the server.

1. On GitHub create a personal access token (classic) with only the `read:packages` scope. In Servify open **Settings → Registry logins → Add login**: registry `ghcr.io`, your GitHub user name, the token. **Test** signs in to check it.
2. Add an image service for `ghcr.io/<owner>/<app>:latest` (or a moving tag such as `:main`). For a tag other than `:latest`, turn on **Pull before every deploy** in the service's Settings tab (`PATCH /api/services/:id {"pullOnDeploy": true}`). `:latest` is always pulled.
3. Copy the service's **Deploy hook** URL from the same tab and store it as a secret in the repository (`SERVIFY_DEPLOY_HOOK`).
4. In the workflow, after pushing:

```yaml
- uses: docker/login-action@v3
  with:
    registry: ghcr.io
    username: ${{ github.actor }}
    password: ${{ secrets.GITHUB_TOKEN }}
- uses: docker/build-push-action@v6
  with:
    push: true
    tags: ghcr.io/${{ github.repository }}:latest
- run: curl -fsS -X POST "$SERVIFY_DEPLOY_HOOK"
  env:
    SERVIFY_DEPLOY_HOOK: ${{ secrets.SERVIFY_DEPLOY_HOOK }}
```

The hook answers `{"ok": true, "deploymentId": "…", "pull": true}`. The deploy pulls the new image with the saved login, also on a remote server, and does a normal zero-downtime switch. If the pull fails (token expired, image missing), the deployment fails, the running version stays and the failed-deploy notification fires. To wait for the result in CI, use a deploy token instead (see [Token scopes](#token-scopes)).

## Notifications

Settings → Notifications: add Slack, Discord, Telegram, ntfy, email or webhook channels and pick events (deploy failed/succeeded, service down/recovered, cron job failed, backup failed/succeeded, certificate failed, preview ready). "Down" alerts are de-duplicated (one per service per 10 minutes, and "recovered" only answers a "down" that was sent). Cron jobs, scheduled backups and scheduled test restores notify on the first failure of a streak only. A reminder follows every *n* hours while they keep failing (**Jobs and backups that keep failing**, default 24, 0 = never; `PATCH /api/settings/alerts {"failureRemindHours": n}`). A success afterwards sends one *recovered* notice on the same event (level success). The streak is kept in the database, so a restart doesn't repeat the notice. Manual backups and test restores you start yourself notify every failure. Webhook payloads are signed: `X-Servify-Signature: sha256=<HMAC of the body>`.

**When a channel doesn't deliver**, Settings → Notifications shows it on the channel in red: the problem in plain words and what to do, e.g. *This chat ID is the bot itself … Message your bot, then use your own chat ID* (Telegram 403), *start a chat with the bot first* (400 chat not found), a rejected bot token (401), a deleted Discord or Slack webhook (404/401), a protected or rate-limited ntfy topic (403/429), an SMTP login refused or a connection refused — otherwise the HTTP status and a short excerpt of the answer, never the channel's token, URL or password. **Send test** checks a channel end to end. Saving a Telegram channel refuses a chat ID that is the bot's own ID and a token Telegram rejects. After 3 failures in a row the channel is marked *failing* (a dot on the settings button and a banner in Notifications) and every other enabled channel that still works is told once. `GET /api/settings/notifications/health` returns the last result per channel (`failing`, `failures`; the problem and fix for the owner).

## Volumes

A volume belongs to a project and is attached to at most one service. It shows as a tab under its service on the canvas (name and size). From its menu you can **detach** it — the service restarts without it and the volume stays on the canvas as a detached card, data intact — and then drag it onto any service in the project to **attach** it at a mount path. "Attach volume…" on a service (or "New volume here" on the canvas) creates a fresh one. Deleting a service keeps its volumes as detached volumes — in the dashboard, through the API and for agents — unless you ask otherwise (`DELETE /api/services/:id?deleteVolumes=1`, `deleteVolumes` on `delete_service`). Apart from that, only deleting a volume or its whole project removes its data. Deleting a volume's data (a volume, or a service with `deleteVolumes`) first needs a recent backup of it, or takes one ([Safety backups](#safety-backups)); deleting a whole project doesn't. Attach and detach redeploy the service immediately, so a volume is never mounted by two services at once, and a rollback never mounts a volume that has moved away. A service with a volume runs as a single replica.

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

## Access control

A service's **Settings → Access control** (and `update_service` / `PATCH /api/services/:id` with `access`) decides who may reach it through the router. Everything is off for existing and new services.

- **Who can connect:** an allowlist of IP addresses and CIDRs, IPv4 or IPv6 (`192.168.1.0/24`, `2001:db8::/32`). The **private networks only** preset (`"private"`) admits RFC 1918 (`10/8`, `172.16/12`, `192.168/16`), loopback, link-local, IPv6 ULA (`fc00::/7`) and CGNAT `100.64.0.0/10` (Tailscale) — for LAN- or VPN-only apps. A denylist is checked first. Refused visitors get a small 403 page.
- **Password protection:** HTTP basic auth (401 with `WWW-Authenticate`). The password is stored scrypt-hashed and sealed, apart from the service record; the API only ever shows a mask. Optional exempt path prefixes (e.g. `/api/webhooks`) skip it. Wrong passwords are limited per client and service (10 per 5 minutes, then 429).
- **Rate limit:** requests per client address per window (a token bucket: bursts up to the limit, refilled evenly), 429 with `Retry-After` beyond it.

Rules apply immediately on every path through the router: HTTP, HTTPS, WebSocket upgrades, external routes and redirects. ACME HTTP-01 requests (`/.well-known/acme-challenge/`) always pass. On a TCP proxy port and a UDP relay only the IP lists apply, when a connection opens (or per new UDP client); basic auth and rate limits can't — the service settings warn when an HTTP service with a password also has a TCP proxy port. **Published ports** bypass the router entirely, so none of this applies to them: use a firewall. Health checks go straight to replicas and Servify's load test carries an internal key, so neither is blocked. Environment copies, previews, duplicates and imported specs keep the rules (an export without secrets carries no password hash: the copy stays locked until you set one).

Deploy hooks and git webhooks (`/_servify/hooks/…` on the router and `/api/hooks/…` on the dashboard port) are rate-limited by default: 120 requests per minute per client, and after 20 failed ones (bad token or signature) in 10 minutes that client waits.

Every limit and list goes by the client address the access log uses — see the next section. Behind a reverse proxy that isn't trusted, every visitor looks like the proxy: an allowlist admits or blocks everyone at once and a rate limit throttles all visitors as one. When a private address that isn't in `SERVIFY_TRUSTED_PROXIES` sends `X-Forwarded-For` to a service with address rules, the service settings (and `accessWarnings` in the API) say so.

## Behind another proxy

When something else terminates HTTPS in front of Servify (Nginx Proxy Manager, a cloud load balancer, a tunnel), set `SERVIFY_TRUSTED_PROXIES` to its address or network (e.g. `172.28.0.0/16`, IPv4 or IPv6): requests from there keep their `X-Forwarded-Proto: https`, so apps build `https://` links and sign-in callbacks. From anywhere else the header is replaced with what Servify actually saw. The visitor's address is read from `X-Forwarded-For` the same way — only from trusted proxies, nearest untrusted hop first, never from anyone else — for the access log (hashed into the visitor key, never stored), access control and rate limits. Without it, every visitor behind that proxy shares the proxy's address; the dashboard warns when it sees this. The router has no overall request deadline, so long uploads and downloads finish.

## PostgreSQL clusters

Create a service from the **PostgreSQL cluster** template: three replicas, each with its own volume. Replica 0 initialises as the primary; the others clone it with `pg_basebackup` and stream from it. Apps write through `${{ db.DATABASE_URL }}` (the service name points at the primary only) and can read through `${{ db.DATABASE_READ_URL }}` (`<name>-read`, the standbys). The TCP proxy also routes to the primary.

- **Synchronous replication** (on by default): every commit waits for at least one standby (`ANY 1`), so a failover loses no acknowledged write. If no standby is streaming, Servify switches to asynchronous and alerts you rather than blocking writes.
- **Automatic failover:** if the primary is unreachable for 15 seconds (configurable, or off), Servify fences it — removes its container and keeps the reconciler from restarting it — promotes the most up-to-date standby, records it as the primary, moves the service name to it, re-points the other standbys, and then rebuilds the old primary as a standby. A member that claims to be a primary but isn't the primary of record is fenced on sight; when the situation is ambiguous nothing is wiped and you get an alert.
- **Switchover** ("Make primary" on a standby, or the `switchover` tool) hands over gracefully before maintenance: the primary is shut down cleanly, the standby must have caught up with it, and if it hasn't within a minute the switchover is cancelled and the old primary starts again. **Rebuild** re-clones a standby that fell behind.
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
- **A private network across servers.** `db`, `${{ db.HOST }}` and friends work wherever the services run. When a project spans servers, each server gets a small relay container per service that lives elsewhere, answering on its names and main port; connections travel over TLS through this machine (the agents' pinned certificate, a per-project token) to a healthy replica. No ports open between servers. Only the main port is relayed, and the detour adds latency, so keep chatty pairs (an app and its database) on one server. Relayed connections pass through the Servify process, so restarting Servify drops them (clients reconnect).
- **Offline is not down.** If a server stops answering, its services keep running there; Servify shows them as unreachable, does nothing to them (no restarts, no failovers, no deletes) and re-adopts them when the agent reconnects. You get a notification after a minute.

The agent endpoint listens on `0.0.0.0:7701` only once you add a server (`SERVIFY_AGENT_HOST`, `SERVIFY_AGENT_PORT`). The join command uses your first LAN address; set `SERVIFY_AGENT_PUBLIC_HOST` if servers reach this machine under another name (a VPN or public address). Treat an agent token like a password: whoever holds it can pose as that server.

### Signing in from the internet: passkeys, password policy, throttling

To reach the dashboard from the internet, set a public dashboard domain, open its address list to everyone, and protect sign-in with **passkeys** (Settings → Security):

- **Passkeys** (WebAuthn, discoverable — no user name to type) can live in your password manager (Bitwarden/Vaultwarden, 1Password …) or on a device. User verification is required when a passkey is added and when it signs in. A passkey belongs to the exact host name it was added on — `localhost`, the dashboard domain or a name in `SERVIFY_ALLOWED_HOSTS`; never an IP address or a plain-HTTP address (the login page hides the button there and says why). Add one per host you use. Adding or removing passkeys and changing the policy need a sign-in or confirmation (password or passkey) from the last 5 minutes, in a browser session — not with an API token or the phone app.
- **Password sign-in policy:** *everywhere* (the default, as before), *private networks only* (home, office, VPN and this machine; the visitor's real address is used — through the dashboard domain the router passes it on, and `X-Forwarded-For` counts only from `SERVIFY_TRUSTED_PROXIES`; behind an untrusted proxy the password is refused), or *off* (passkeys only; needs a passkey on a host Servify answers on). After your first passkey the dashboard offers *private networks only*; nothing changes until you choose. The policy applies to the phone app's password sign-in too.
- **Throttling:** per client address (IPv6 by /64), five failed password attempts in a row are free, then the address is locked for 1 s, 2 s, 4 s … up to 15 minutes, and at most 50 failures a day; a success resets it. Locked addresses get 429 before any password is checked. Above 30 failures a minute across all addresses each password check is slowed (up to 5 s) but never refused, so you can always get in from a fresh address — and passkey sign-in is counted separately and never slowed. Failures land in the activity log in batches, with one notification per burst (event *Repeated failed sign-ins*).
- **Sessions:** HttpOnly, SameSite=Strict, and `Secure` when the request came over HTTPS (directly or through the dashboard domain). They end after 7 days unused and 30 days at most. **Sign out everywhere** (Settings → Security) ends every dashboard session, optionally every signed-in phone too.

**Locked out?** On the Servify machine (it needs access to the data folder):

```sh
servify auth reset                    # asks for a new owner password, allows the password everywhere again, ends all sessions
servify auth reset --keep-password    # only allow the password everywhere again (and end all sessions)
servify auth reset --password-stdin   # read the new password from stdin (scripts); add --remove-passkeys / --sign-out-devices if needed
servify auth status                   # policy, passkeys, sessions and phones
```

It takes effect at once, also while Servify runs. An address locked out after failed attempts stays locked for at most 15 minutes (a restart clears it).

### Approving a phone from the dashboard (pairing API)

When the password is limited or off, the app can ask to be approved instead. No credentials; per client address.

- `POST /api/auth/pair/start` with `{"name": "Pixel 9"}` (optional, at most 60 characters) → **201** `{"pairingId": "<43-character secret>", "code": "K7QFM2XD", "expiresAt": <ms epoch>}`. The code is 8 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`; show it as `K7QF M2XD`. A pairing lasts 5 minutes. Limits: 5 starts per address per 10 minutes, 2 waiting per address, 10 waiting in all → **429** `{"error", "code": "throttled", "retryAfter": <s>}` with `Retry-After`. Allowed from the app's WebView origins.
- `GET /api/auth/pair/<pairingId>` (poll every 2–3 s; at most 120 a minute per address) → **200** `{"status": "pending", "expiresAt"}` · `{"status": "approved", "token": "svf_…", "device": {…}}` — **exactly once**, then the pairing is gone · `{"status": "denied"}` · `{"status": "expired"}`; unknown or already-claimed ids → **404** `{"status": "expired"}`.
- The owner sees waiting requests under Settings → Security (code, device name, address, time, plus a toast), and approves after comparing the code, or denies (or denies all). The token is a normal device token: listed under signed-in devices, sent as `Authorization: Bearer`, revocable, `DELETE /api/auth/device` signs it out.
- `GET /api/auth/status` lists the features `pairing`, `password-policy` and `passkeys`, and says `passwordSignIn: {allowed, code?, reason?}` for the asking client — the app can offer pairing when it is `false`. A refused password sign-in (`POST /api/auth/device`) answers **403** with `code` `password_off` or `password_private_only`.

## Android app

The Servify app for Android (in [`mobile/`](mobile/README.md)) signs in like a password manager's self-hosted mode: enter your Servify's address, then the owner password, or, when password sign-in is off or limited, tap **Approve from dashboard** and approve the code it shows under Settings → Security on a signed-in device. The phone gets its own token, listed under **Settings → Security → Signed-in devices**, where you can sign it out. The app shows your projects and services live, with metrics, deployments and logs, and can restart, redeploy, stop, start and run scheduled jobs.

Reach Servify from your phone through your home network or a VPN (Tailscale, WireGuard); there's no need to put the dashboard on the internet. Plain `http://` is only accepted for local and VPN addresses. Servify always answers on bare IP addresses; add any hostname you use (for example a Tailscale MagicDNS name) to `SERVIFY_ALLOWED_HOSTS`. For `https://`, set a [dashboard domain](#the-dashboard-on-its-own-domain): the app pins Servify's local CA after you compare its fingerprint with the one in Settings → HTTPS.

### App updates from your own Servify

There is no separate download site: **each Servify mirrors the Android app from its own signed release and serves it to its phones**, so they update over your network or VPN.

- **Which app.** The app in the release of the version that is running (tag `v<version>`, not the newest release), so a phone always gets the app built for the server it talks to. The release's manifest must be signed by a pinned release key, like an update of Servify itself (see [Signed releases](#signed-releases)). When its `android` entry has a higher versionCode than the app Servify already has, the APK is downloaded, stopping at the size the manifest gives, and checked against the manifest's SHA-256 and size. It's then moved into `~/.servify/mobile/`, next to the manifest and signature that vouch for it. The current and the previous app are kept.
- **Fail closed.** If the running version's release isn't signed, or its signature or manifest is invalid (another key, changed bytes, a manifest for another version), **no app is served at all**, not even the one mirrored before, until a check verifies again. The reason shows in the dashboard. A cached app is checked again when Servify starts. A release without an app (`--no-apk`), a development build without a release, or a feed that can't be reached leave the cached app in place.
- **When.** Two minutes after start, so also after every update, then daily, and on **Check now**. Not while the data disk is in low-space protection. **`SERVIFY_MOBILE_MIRROR=0`** turns it off: Servify then never asks the release feed for it and serves no app.
- **API.** `GET /api/mobile/app` answers `{ available, versionName, versionCode, sha256, size, signerSha256, reason?, status, release, … }`. `GET /api/mobile/app.apk` sends the file (`application/vnd.android.package-archive`, `Content-Length`, `Range` requests), or 409 with the reason when there's none. Both need sign-in or a token: read tokens for all projects may use them, project-limited ones may not. `POST /api/mobile/app/check` checks now (owner only).
- **Dashboard.** **Settings → Security → Phone app** shows the mirrored version, its SHA-256 and signer, the mirror's status, and a download link for sideloading. **Signed-in devices** shows each phone's app version (the app reports it in an `X-Servify-App: <versionName>/<versionCode>` header) and marks phones that are behind with *update available*.
- **On the phone.** The app asks its Servify when it opens and when it comes back (at most every 6 hours; **Settings → Check for updates** asks right away). It shows *Update available: X.Y.Z* when the offered versionCode is higher than its own; the banner can be dismissed per version. **Update** downloads the APK natively, with the device token and the same per-server certificate trust as the rest of the app. It checks the SHA-256 and size against the server's answer, and checks that the file is this app, is newer, and **is signed with the same certificate as the installed app**. Only then does it open Android's installer. The first time, Android asks you to allow Servify to install apps.

## Start at login

**Settings → General → Start Servify at login.** Servify then starts in the background when you log in (a launchd agent on macOS, a systemd user service on Linux) and restarts if it crashes. Turning it on while Servify is running takes effect at your next login; turning it off never stops the running Servify. Logs go to `~/.servify/logs/servify.log` (kept to about 20 MB; the older part moves to `servify.log.1`). The same from a terminal:

```bash
pnpm service install     # starts it now if Servify isn't running, otherwise from the next login
pnpm service status
pnpm service uninstall   # also stops it
pnpm service print       # show the file without installing anything
```

The login service runs with the `SERVIFY_*` and `DOCKER_HOST` settings Servify had when you turned it on. Each data directory gets its own agent, and only one Servify runs per data directory: a second copy exits right away. On Linux, `sudo loginctl enable-linger $USER` makes it start at boot without logging in.

## Updating Servify

**Settings → General → Updates.** Servify only looks for a new release when you click **Check for updates**; no newer release is fetched in the background. (The phone app mirror does ask the release feed for the release of the running version, daily, see [App updates from your own Servify](#app-updates-from-your-own-servify); `SERVIFY_MOBILE_MIRROR=0` turns that off.) **Update and restart** then:

1. downloads the release's signed manifest and checks its signature, then downloads the package and checks its size and SHA-256 against the manifest, before anything is unpacked (see *Signed releases* below);
2. unpacks it next to the install folder (`<install>.next`) and runs the new version's self-test (`servify selftest`);
3. saves a copy of the database (`VACUUM INTO`, in `~/.servify/updates/`);
4. swaps the folders (the old one stays as `<install>.prev`) and exits, so the service manager starts the new version.

The new version has two minutes to serve the dashboard and reach Docker. If it crashes or misses that three times in a row, Servify puts the previous folder and the database copy back and starts the old version (a start that fails only because Docker isn't running doesn't count) (the new one is kept as `<install>.failed` for a look). Either way you get a notification (`servify.update`).

It needs **Start at login** to be on (something has to start Servify again) and an install from a release package or a plain copy — not a git checkout (`git pull && pnpm build`) and not the Docker image (pull or rebuild it). The same through the API: `GET /api/system/update`, `POST /api/system/update/check`, `POST /api/system/update` (owner only).

### Signed releases

Every release since 0.3.0 carries `servify-v<version>.manifest.json` and `servify-v<version>.manifest.json.sig`: a detached Ed25519 signature over the exact bytes of the manifest. The manifest names the version and tag and, for every file of the release, its SHA-256 and size:

```json
{
  "format": 1,
  "product": "servify",
  "version": "0.3.0",
  "tag": "v0.3.0",
  "commit": "<the tagged commit>",
  "createdAt": "2026-11-27T12:00:00.000Z",
  "assets": { "servify-v0.3.0.tar.gz": { "sha256": "<hex>", "size": 6683865 } },
  "android": { "file": "servify-android-0.3.0.apk", "versionName": "0.3.0", "versionCode": 300, "sha256": "<hex>", "size": 12345678, "signerSha256": "<hex of the APK signing certificate>" }
}
```

`android` is the Android app built for this release, and is optional: a release without an app change has none. When it's there, its file (`servify-android-<versionName>.apk`) is also listed in `assets` with the same hash and size, and `signerSha256` is the release signing certificate pinned in `server/src/releasekey.ts` (`ANDROID_SIGNER_SHA256`). Every Servify on that version mirrors it for its phones. A manifest with an unknown `format` is refused.

The signing key never touches GitHub. It lives only on the maintainer's machine, and the public key is pinned in the source (`server/src/releasekey.ts`, which also describes key rotation). So a compromised GitHub account, workflow or token can change a release but can't make one that installs. **Check for updates** only offers a newer release that passes all of these checks:
- its manifest is signed by a pinned key;
- the manifest's version and tag are exactly the release's, so an older signed manifest can't be replayed for a newer tag;
- it lists the package.

Otherwise the card says why, for example *release v0.3.1 is not signed* or *signature invalid*. The API answers with `blocked` on `POST /api/system/update/check`, and the install is refused with that reason. The package's size and hash are checked against the manifest while it downloads, and nothing is unpacked unless both match. Releases up to 0.2.3 aren't signed and don't check signatures. Their updater still finds and installs 0.3.0 by its package and `.sha256`, and the checks apply from 0.3.0 on.

For your own builds:
- **`SERVIFY_UPDATE_KEYS=<base64>[,<base64>…]`** trusts these Ed25519 public keys instead of the built-in ones. Use it together with `SERVIFY_UPDATE_FEED` (a GitHub-style `releases/latest` URL) or `SERVIFY_UPDATE_REPO`. Sign your releases with `scripts/publish-release.mjs --key <your key>`.
- **`SERVIFY_UPDATE_ALLOW_UNSIGNED=1`** installs releases that have no manifest or signature, checked against their `.sha256` only, as before. It's logged loudly at every check and recorded in the activity log on install. A release whose signature is present but wrong is still refused.

To check a release by hand:

```bash
base64 -d < servify-v0.3.0.manifest.json.sig > sig.bin
# "MCowBQYDK2VwAyEA" is the DER header of an Ed25519 public key; the pinned key follows it (OpenSSL 3+)
echo 'MCowBQYDK2VwAyEA<the pinned publicKey from server/src/releasekey.ts>' | base64 -d | openssl pkey -pubin -inform DER -out release.pub
openssl pkeyutl -verify -pubin -inkey release.pub -rawin -in servify-v0.3.0.manifest.json -sigfile sig.bin
shasum -a 256 servify-v0.3.0.tar.gz   # = assets["servify-v0.3.0.tar.gz"].sha256
```

### Making a release

1. Bump the version in `package.json`, `server/package.json` and `web/package.json`, commit "Servify X.Y.Z", create the annotated tag `vX.Y.Z` and push both.
2. GitHub Actions (`.github/workflows/release.yml`) checks that the tag matches the version. It typechecks, runs the signing tests (`scripts/test-release-signing.mjs`, with a throwaway key), builds and packages (`scripts/release.mjs`) and self-tests the package. Then it creates a **draft** release with `servify-vX.Y.Z.tar.gz` and its `.sha256`. CI has no signing key and needs none. Drafts are invisible to `releases/latest`, so no install sees the release yet.
3. If the app changed, raise `mobile/package.json`'s version and build the release-signed APK on the Mac (`cd mobile && npm run apk`).
4. On the maintainer's Mac, run `node scripts/publish-release.mjs vX.Y.Z --apk mobile/android/app/build/outputs/apk/release/app-release.apk --wait`, or `--no-apk` for a release without an app change (one of the two is required). With `--apk` it first reads the APK's versionName and versionCode (`aapt2`) and its signing certificate (`apksigner`, build-tools 36). It refuses an APK that isn't `cloud.servify.app`, isn't signed by exactly the pinned release certificate, or whose versionCode isn't higher than the app in the previous release's manifest. The APK goes into the manifest and is uploaded as `servify-android-<versionName>.apk`. Then the script checks that the local tag and GitHub's point at the same commit, and waits for the draft. It downloads CI's package, rebuilds the tag from a clean clone (pnpm 11.0.9, frozen lockfile) and compares the two by content: paths, types, link targets, exec bits and every file's SHA-256. Any difference aborts. It checks that the key is pinned in the tag and in the previous release. Then it writes and signs the manifest over CI's package, checks it with the updater's own verifier, uploads the manifest, the `.sig` and the app, and publishes the draft as the latest release. `--dry-run` does everything except uploading and publishing.

`scripts/release.mjs` is reproducible:
- entries are sorted and every timestamp is the commit's time (`SOURCE_DATE_EPOCH` overrides it);
- owners are 0, modes are 755/644, and the gzip header has no timestamp;
- pnpm's machine-specific bookkeeping (bin shims, `.modules.yaml`, links back into the checkout) is left out.

Two builds of one commit with the same Node.js are byte-identical. Different Node.js versions can compress differently, which is why the publish step compares contents. Every push is typechecked, built and packaged by `.github/workflows/ci.yml`.

The private key is `~/.servify-release/release-key.pem`, created once with `node scripts/release-key.mjs keygen`. That command refuses to overwrite it and prints only the public key; `node scripts/release-key.mjs pubkey` prints it again. Keep the folder at mode 700 and the file at 600, or `publish-release` refuses it. **Back it up offline**, like the Android signing key. Without it, existing installs can't be updated automatically any more and have to install the next version by hand.

## Backups

Services with data get a **Backups** tab: back up now, a schedule (cron), how many to keep, and where (this machine, any folder, or S3-compatible storage configured in Settings → Backup storage). Postgres, MySQL/MariaDB and MongoDB are dumped while they keep serving; other services' volumes are archived. **Restore** checks the backup, takes a safety backup, then rebuilds the data: dumps are replayed into a freshly initialised database, archives replace the volume contents. Backups can be downloaded as `.gz` files.

- **Streamed, never staged.** A backup goes straight from the dump or the volume archive to its destination; nothing is written to Servify's data disk on the way, so a 207 GB volume needs no 207 GB free there. A folder gets the file under a temporary `….part` name, renamed once it is complete. S3 gets a single PUT when the archive fits in one part, else a multipart upload that holds one part in memory at a time (64 MiB to start, `SERVIFY_S3_PART_MB`, at least 5). Each part is retried on its own. Parts double in size every 2,000, so an archive of unknown length still fits S3's 10,000 parts: about 3.9 TiB at the default, with the last parts 1 GiB each. Data of services on other servers streams through this machine the same way. A failed backup is listed as failed and leaves nothing that looks like a backup: the partial file is deleted, the multipart upload aborted. If the destination can't be reached at that moment (or Servify was restarted mid-backup), the cleanup is retried every minute until it succeeds.
- **Checksums.** The SHA-256 of the stored bytes is computed while they stream and kept with the size on the backup (`sha256` and `sizeBytes` in `GET /api/services/:id/backups`, and in the Backups tab: click it to copy). It matches `sha256sum` of the downloaded file. After upload, the stored size is read back and compared.
- **Verified restores.** A restore first reads the whole backup: its size and checksum, the gzip stream to its end, and for volume archives every tar header up to the end-of-archive marker. Only then does it take the safety backup and touch the data, so a damaged or cut-off backup is refused with the live data unchanged. The restore itself streams the backup a second time and hashes it again. For a folder, that second read is cheap; for S3, it is a second download, traded for needing no disk on this machine. If something fails after the data was reset (the connection, say), the restore is reported as failed and the safety backup from just before is in the list to go back to. S3 downloads resume with a range request when the connection drops. Backups made before checksums existed are marked **not verified**: they are restored after the size, gzip and tar checks, without a checksum to compare.
- **Test restore.** *Test* on a backup, `POST /api/backups/:id/test` (add `?wait=1` for the result), or the `test_restore` MCP tool proves a backup restores without touching the service. It reads the archive end to end, then restores it into a scratch Docker volume and counts its files against the archive. A dump is loaded into a throwaway container of the same database image (`--network none`, no log), followed by a trivial query (databases and tables). Everything it created is removed afterwards. The result (time, passed or failed, details) is kept on the backup, shown in the tab, and a failure is notified (*backup.failed*). A volume that unpacks to more than the Docker disk can hold is recorded as *archive checked* instead of being restored. **Test restores** in the schedule settings test the newest backup weekly (`testSchedule`, a cron expression, in a service's `backup`).
- **Missed backups.** A scheduled backup missed while Servify wasn't running (or its server was offline) runs once when Servify is back, within half the time to the next one (at most 24 h). It waits for a database to be running first, and is marked *catch-up* in the history (`catchUp` on the backup). Scheduled test restores catch up the same way, after any backup that is running. This is on by default, since a backup is safe to take late and a missed nightly one is a day of data at risk. Turn it off with **Catch up missed backups** (`backup.catchUp: false`). Skipped scheduled backups (the previous one still running, the server offline, low disk space) are in the activity log. A scheduled backup that wasn't taken at all, because its server was offline or it was missed and not caught up, counts as a failed one for notifications. Scheduled backups and test restores that keep failing notify once, remind every 24 h and say when they recover (see Notifications). The Backups tab shows *failing since …*.
- **Deleting** a backup deletes its file or object at the destination. Retention keeps the newest *n* scheduled and manual backups per destination, plus the last two safety backups and the last two backups taken before restores.

### Safety backups

A rollback can bring back an old image, but not old data: if a new version migrates the data and then fails, there's nothing to go back to. So before the operations nothing can undo, Servify makes sure a **recent successful backup** of the data exists — and if there isn't one, takes one first. If that isn't possible, the operation is refused with the reason and nothing changes.

- **What's guarded:** a new image starting on a service's data (a deploy, rollback, image update or automatic update of a service with volumes or a database of its own — the image is compared by id, so restarts, variable changes and volume moves aren't affected), switching an image service to another tag (or a build to another base image tag), deleting a service with `deleteVolumes`, and deleting a volume. PostgreSQL clusters and scheduled jobs are left out for new images (clusters roll standbys first and stop at the first one that fails); deleting their volumes is guarded like any other.
- **Recent** means a successful backup of the service's current method and volumes, at a destination that still exists, at most 24 hours old by default — so last night's scheduled backup usually covers a day's deploys, and a second deploy reuses the first one's backup. A new backup to a folder is only started after checking that it fits on that folder's disk: Servify estimates its size from the volumes (or 1.5× the last dump) and refuses — "a backup of up to 207 GB doesn't fit on the data disk: 120 GB free…" — rather than fill the disk. It keeps 5% of the disk free, at least 2 GB and at most 20 GB (`SERVIFY_BACKUP_RESERVE_GB`). Backups to S3 need no space here (they stream), so they are never refused for it; the same check guards the safety backup a restore takes. A stopped database is archived as a volume instead of dumped. The last two safety backups are kept per destination, apart from the scheduled ones' retention.
- **Per service** (Settings → Safety backups, or `safetyBackup` in `PATCH /api/services/:id`): *reuse a recent backup, else take one* (`auto`), *reuse a recent backup, else refuse* (`require`, never starts a backup — for very large volumes that are backed up nightly anyway), or *off*; and how old a backup may be (1 hour to 7 days, or always a fresh one).
- **Defaults:** for new images, `auto` with 24 hours when the service has scheduled backups (they say where backups go and that they fit), and **off when it has none** — Servify won't choose a destination and start a backup of unknown size in the middle of a git-push deploy or an automatic update; the deploy log notes that there was no backup. Switching tags (or a build's base image tag) and deleting volumes always need a recent backup — up to 24 hours old, else a new one — unless the service's setting is *off*; a tag switch used to take a fresh backup every time, however large.
- **Going ahead anyway:** people and agents can skip it for one operation — *Deploy without backup* on the refused deployment, `{"skipSafetyBackup": true}` on `POST /api/services/:id/{deploy,restart,rollback,update-image}`, `?skipSafetyBackup=1` on `DELETE /api/services/:id?deleteVolumes=1` and `DELETE /api/volumes/:id`, `skipSafetyBackup` / `skip_safety_backup` on the MCP tools, `servify deploy|restart|rollback --skip-safety-backup`. It's recorded in the activity log. Refusals answer `409` with `"code": "safety_backup"`.
- **Unattended operations never skip it.** Git pushes and deploy hooks may take a backup (in the background, as part of the deploy) but can't go without one. **Automatic image updates** don't even take one: without a recent backup the update is held back, you're notified once (*Auto-update of … skipped*, a failed-deploy notification), and it's tried again at every check — after the next scheduled backup it goes through.
- A safety backup runs under the service's backup lock: it waits for a backup or restore already running and then looks again, and while it runs inside a deploy, restores of that service are refused (as for any deploy).
- Deleting a detached volume reuses any recent backup that holds it, or one taken after it was detached; otherwise it archives just that volume, listed under the volume's id (`GET /api/services/<volume id>/backups`) and downloadable — restoring it means extracting the archive by hand. Backups made before safety backups existed don’t record which volumes they hold, so they don't count for detached volumes.

## Low disk space

A full disk breaks SQLite, Docker and every service on it, so Servify watches the disks it writes to and backs off before they fill up: its **data disk** (`SERVIFY_DATA_DIR`), **Docker's disk** on this machine (`docker info` → DockerRootDir; when Docker runs in a VM — Docker Desktop, OrbStack, Colima — a throwaway `alpine` helper reads its `df` once a minute), and the Docker disk of every connected **server** (from the usage its agent reports). When the data and Docker directories share a disk it is one entry.

- **Two lines per disk**, each the smaller of a share and a size, so neither a 4 TB disk nor a 32 GB one is treated oddly: *warn* below 10% or 10 GB free, *protect* below 5% or 3 GB. Set only one of a line's two numbers and that one is used alone. Change them in Settings → Notifications → Low disk space, `PATCH /api/settings/disk` (`warnPct`, `warnGb`, `protectPct`, `protectGb`; `null` = the env value or the default) or the `SERVIFY_DISK_*` variables.
- **Below the warn line** you're notified (event *server.usage*, the channels that get "Server disk, memory or CPU high"). The usage alert for the same disk stays quiet meanwhile, so there is one message, not two.
- **Below the protection line on the data disk**, Servify stops storing container logs, metric samples and access-log rows (the live log tail stays in memory, so the Logs tab and `servify logs` still show new lines, and they are written once there is room), and refuses builds, uploads and backups to folders on that disk. Backups to S3 go on: they stream and need no space here.
- **Below the protection line on a Docker disk**, builds, image pulls (and copies of images from other servers) and test restores are refused for that server. Restarts, rollbacks and moves that bring back an image already there go on. A deploy that would pull fails before it downloads anything, and the running version stays.
- Refusals answer `507` with `"code": "low_disk"` and say which disk, how much is free and where the line is: *Low disk space: the data disk (/home/me/.servify) has 2.1 GB free, below its 3.0 GB protection line — builds are refused until it is back above 10.0 GB.* Git auto-deploys and automatic image updates wait instead of failing over and over.
- **Never refused:** deleting projects, services, volumes and backups, stopping services, and Servify's own clean-ups. Restores are allowed too (the safety backup a restore takes first is held to the usual room check rather than refused), but one whose backup clearly can't fit on the Docker disk — more than its free space plus what wiping the current data frees — is refused with nothing changed. That fit check applies at any time, not only in protect mode. Deleting a volume that has no recent backup still asks for its safety backup, which can't go to a protected data disk: delete it with *without a safety backup* (`?skipSafetyBackup=1`) if you're sure.
- **Clean-up:** when a disk enters protect mode, Servify once removes built images beyond the five kept per service for rollbacks, leftover build checkouts, and log/metric/access-log rows past their retention (turn it off with the switch in the settings card, or `SERVIFY_DISK_AUTO_CLEAN=0`). It never deletes volumes or backups, and it doesn't prune Docker's build cache or anything Servify didn't create.
- **Resume:** once the disk is back above the warn line, everything resumes on its own and you're notified once.
- **Where it shows:** a banner on every dashboard page while a disk is protected (what is paused, which disk, how to free space), `disk` in `GET /api/system` and `GET /api/overview`, a disk list per server in the `list_servers` MCP tool, a note after the project list in the `overview` tool, and `servify status`.

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
| `SERVIFY_ALLOWED_HOSTS` | | Extra hostnames allowed to reach the dashboard (bare IP addresses always work) |
| `SERVIFY_AGENT_HOST` / `SERVIFY_AGENT_PORT` | `0.0.0.0` / `7701` | Where servers' agents connect (TLS). Only started once a server is added |
| `SERVIFY_AGENT_PUBLIC_HOST` | first LAN IPv4 | Address shown in the join command |
| `SERVIFY_TRUSTED_PROXIES` | | Proxies in front of Servify (IPs / CIDRs, IPv4 or IPv6) whose `X-Forwarded-Proto` and `X-Forwarded-For` are believed: the visitor's address for the access log, access control and rate limits. Set it whenever another reverse proxy sits in front |
| `SERVIFY_HOOK_RATE_LIMIT` | `120` | Deploy hook / git webhook requests per minute per client (`0` = off) |
| `SERVIFY_HOOK_FAIL_LIMIT` | `20` | Failed hook requests per client per 10 minutes before it has to wait (`0` = off) |
| `SERVIFY_AUTH_FAIL_LIMIT` | `10` | Wrong basic-auth passwords per client and service per 5 minutes before it has to wait (`0` = off) |
| `SERVIFY_HOST_MOUNTS` | | Folders services may mount from the host (comma-separated). Empty = host folders off |
| `SERVIFY_AUTH` | `password` | `none` disables the dashboard password (single-user machines only) |
| `SERVIFY_LOG_RETENTION_DAYS` / `SERVIFY_LOG_MAX_LINES` | `7` / `200000` | Runtime log history per service |
| `SERVIFY_ACCESS_LOG_RETENTION_DAYS` / `SERVIFY_ACCESS_LOG_MAX_ROWS` | `7` / `1000000` | HTTP access log history per service |
| `SERVIFY_METRICS_RETENTION_DAYS` | `7` | Metrics history |
| `SERVIFY_JOB_MAX_SECONDS` | `3600` | Cron runs are killed after this |
| `SERVIFY_CATCHUP_WINDOW_MINUTES` | half the interval, max. 24 h | Replaces the catch-up window of every schedule (jobs with catch-up on, scheduled backups and test restores): how late a missed start may still run |
| `SERVIFY_CATCHUP_GRACE_SECONDS` | `20` | A catch-up waits this long after Servify starts (services adopted, servers reconnected) |
| `SERVIFY_UPGRADE_GRACE_SECONDS` | `600` | How long the first start after an image change of a service with data may take to become healthy, when its own startup grace is shorter |
| `SERVIFY_AUTO_RESTART` | `1` | Restart hung replicas for services that don't set it themselves (`0` = off by default) |
| `SERVIFY_RESTART_AFTER_SECONDS` | `120` | How long a running replica must keep failing its health check (after its startup grace) before it is restarted, unless the service sets its own |
| `SERVIFY_RESTART_MAX` / `SERVIFY_RESTART_WINDOW_SECONDS` | `3` / `3600` | Automatic restarts of a replica per window before Servify gives up and asks for attention |
| `SERVIFY_RESTART_BACKOFF_SECONDS` | `120` | Backoff: after n automatic restarts, a replica must fail this · 2^(n−1) longer than the threshold before the next one |
| `SERVIFY_RESTART_RESET_SECONDS` | `600` | Healthy this long and the restart count (and "needs attention") starts over |
| `SERVIFY_BACKUP_RESERVE_GB` | 5% of the disk (2–20 GB) | Free space a backup to a folder (a safety backup, or the one a restore takes first) must leave on that folder's disk |
| `SERVIFY_DISK_WARN_PCT` / `SERVIFY_DISK_WARN_GB` | `10` / `10` | Low disk space: warn below the smaller of the two (set one: only that one counts). Instance settings win over these |
| `SERVIFY_DISK_PROTECT_PCT` / `SERVIFY_DISK_PROTECT_GB` | `5` / `3` | Low disk space: protect mode below the smaller of the two — pause logs/metrics/access log, refuse builds, pulls and folder backups |
| `SERVIFY_DISK_AUTO_CLEAN` | `1` | `0`: no automatic clean-up of old built images and expired rows when a disk enters protect mode |
| `SERVIFY_DISK_INTERVAL_MS` / `SERVIFY_DISK_DOCKER_INTERVAL_MS` | `30000` / `60000` | How often the disks are checked; how often Docker's disk is measured when it needs the helper container |
| `SERVIFY_LOG_MEMORY_LINES` | `2000` | Log lines per service kept in memory while log storage is paused |
| `SERVIFY_S3_PART_MB` | `64` | First part size of S3 uploads (min. 5; parts double every 2,000). One part is held in memory per running upload |
| `SERVIFY_MOBILE_MIRROR` | `1` | `0`: don't mirror the Android app from the running version's release, and serve none to phones |
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
pnpm build && node scripts/release.mjs  # the release package (dist/servify-v<version>.tar.gz + .sha256)
```

`scripts/acceptance-hosting.mjs` checks host folders, read-only shares, adopted volumes, published TCP/UDP ports, external routes, the Compose import that uses them, the owner-only gates and that restores and deletes never touch data a service doesn't own (see its header).

`scripts/acceptance-servers.mjs` starts a second Docker daemon (docker-in-docker), joins it with the real agent command and checks deploys, routing, builds, exec, backups, an agent outage, moves and a PostgreSQL cluster on it (see its header for the instance settings it needs).

The acceptance script deploys, load-balances, scales, redeploys under load (asserting zero failed requests), kills replicas, checks the TCP proxy and variable references, then cleans up. Set `SERVIFY_TOKEN` when auth is on. The feature suite needs owner access (`SERVIFY_COOKIE` or `SERVIFY_AUTH=none`); `SERVIFY_DATA_DIR` adds the "no plaintext secrets on disk" check. Both default to `http://localhost:7700` — point `SERVIFY_URL` at a test instance.

## Security notes

- Servify controls your Docker daemon, which is root-equivalent. Keep it bound to localhost unless you know what you're doing.
- The dashboard uses an scrypt-hashed owner password (checked off the main thread) and/or passkeys, and an HttpOnly, SameSite=Strict session cookie (Secure over HTTPS) that ends after 7 idle days or 30 days ([sign-in](#signing-in-from-the-internet-passkeys-password-policy-throttling)). Writes must come from Servify's own origin (hosted apps live on `*.localhost` too, so this matters). Host headers are checked to block DNS rebinding.
- The Android app signs in with the owner password and gets a device token that acts as the owner; it is revocable under Settings → Security, shares the per-address sign-in limit and obeys the password policy (or is approved from the dashboard instead), and sits in the Android Keystore on the phone. The API answers CORS only for the app's own WebView origins, never with credentials, and a request that carries a Bearer token skips the Origin check (no site can attach someone else's token).
- API tokens and session ids are stored as SHA-256 hashes; tokens can be read-only, deploy-only and limited to some projects ([Token scopes](#token-scopes)), and are only accepted in the `Authorization` header, never in a URL. Secrets are masked for read-only and deploy tokens; instance settings can only be changed by the owner (not by agent tokens), and so can servers (adding, renaming, new agent tokens, removing). Agent tokens don't see where notification channels point (ntfy topics, chat ids) or the delivery logs.
- Building from a folder of this machine (`path`) is the owner's to set up: any folder could become a build context. An agent token can still redeploy such a service and change its other settings, just not its folder or Dockerfile.
- Credentials typed into a git URL (`https://user:token@host/repo`) are taken out of the URL and stored as the encrypted token.
- Service variables, git tokens, resolved environments, notification credentials, storage keys, ACME account keys and certificate keys are encrypted at rest (AES-256-GCM). Back up `master.key` (or use `SERVIFY_MASTER_KEY`): without it the secrets are gone, and Servify refuses to start with the wrong key rather than overwrite them. Not encrypted: what Docker itself stores (a running container's environment), build logs, cron job output and runtime logs — keep secrets out of your log output.
- Git webhooks are verified with HMAC-SHA256 (GitHub, Gitea) or the secret token (GitLab) in constant time; payloads are capped at 2 MB; hook requests are rate-limited per client, failed ones more strictly.
- Router access control ([Access control](#access-control)): basic-auth passwords are scrypt-hashed and sealed outside the service record, checked off the main thread, and wrong guesses are limited per client; `X-Forwarded-For` is only believed from `SERVIFY_TRUSTED_PROXIES`. The dashboard domain starts private-networks-only and fails closed behind an untrusted proxy.
- Compose imports never mount the Docker socket and never grant privileges. Host folders, published ports, external routes and taking over Docker volumes are owner-only (agent tokens get 403), checked again when containers are created, and left out of environment copies. Host folders must be under `SERVIFY_HOST_MOUNTS`.

## License

MIT
