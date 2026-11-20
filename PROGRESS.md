# Servify — build log

## Decisions
- Stack: Node ≥22.18 (native TS type-stripping, `node:sqlite`), Hono, raw Docker Engine API over unix socket (socket resolved via DOCKER_HOST → `docker context` → known paths).
- Engine = desired-state reconciler. All containers labelled `servify.*`; restarts re-adopt.
- Replicas publish to 127.0.0.1:<ephemeral>; proxy routes there (container IPs when Servify runs in Docker).
- Builds: `docker build` CLI (BuildKit) against the same socket; Engine API legacy builder as fallback. Zero-config detection in `detect.ts`.
- Stateful (volume) services: single replica, recreate strategy. Stateless: surge (blue/green) + drain.
- Auth: owner password (scrypt) + session cookie; agents use `svf_` bearer tokens (read/write). Host/Origin checks vs DNS rebinding. `SERVIFY_AUTH=none` opt-out.
- MCP: official SDK, stateless Streamable HTTP at /mcp; tools call the same `ops.ts` service layer as REST.
- Ports: dashboard 7700, proxy 8080 (auto-increments if busy), TCP proxies from 15400.

## Verified
- [x] scripts/acceptance.mjs: deploy, LB across 3 replicas, scale 3→5→1, zero-downtime redeploy under load (0 failures / 18.7k req), self-heal, redis via TCP proxy, cross-service variable refs.
- [x] Servify restart re-adopts running containers (no duplicates).
- [x] Instance scoping: `servify.instance` label; legacy containers adopted; 2 instances verified isolated.
- [x] CSRF: Origin must equal Host on writes (api + /mcp).
- [x] UI verified in browser: canvas, particles (need visible pane), panel tabs, scaling, template create, ref edges, pending-changes deploy.
- [x] Builds: local folder (node, zero-config) + GitHub repo without Dockerfile, both via BuildKit.

## Punch list (from advisor review)
- [x] Fresh clone: install/build/start, password setup, token via UI + CLI, acceptance with token (all pass), 401 unauth.
- [x] Acceptance additions (25 checks): failed deploys (stateless+volume), redis persistence, rollback, stop/start, kill, autoscale up, git auto-deploy, project delete.
- [x] All templates deployed (ollama skipped); WebSocket upgrade verified (uptime-kuma socket.io).
- [x] UI: drag/snap, wheel/pinch perf (27 nodes: median 8.3ms, p95 11ms), context menus, ⌘K, light theme, token flow, activity, drag-to-connect.
- [x] In-container mode (Dockerfile + compose) verified with a 2-replica LB.
- [x] README, LICENSE.
- [x] Final: fresh clone of HEAD with password auth — acceptance (all pass), HTTP + stdio MCP smokes; docker compose verified; machine cleaned (no servify containers/volumes/networks/images left).

- [x] Independent code review (9 findings) — all fixed: deployed-volume replica cap, reconcile/deploy races (converging set + fresh per-service reads), stop during deploy, proxy counter leaks + upstream timeout, SSE abort ordering, read-only resolved vars, WS counting, TCP listener retry, per-service try/catch.
- [x] Cron jobs (scheduler + one-off runner + UI + MCP), volume download, export/import, multi-select, drag-to-connect, semantic zoom.

- [x] Zero-config builders verified end-to-end: Node, Python/FastAPI, static, Go, Deno, PHP, Ruby/Rack, Vite SPA, Rust (Next.js detection untested).
- [x] UI flows clicked: Load demo stack, Import modal, Duplicate service/project, cron Run now.
- [x] Schedules staged until deploy (acceptance check), job max runtime, stdio MCP bridge smoke test.

## Fixed bugs worth remembering
- Node ≥19 global http agent: 5s idle timeout aborted Docker pulls/events → dedicated agents in docker.ts.
- Edge layer subscribed after nodes registered → sync on subscribe.
- SSE through Vite proxy can go silently stale on server restart → client watchdog (staleMs).
- Never `lsof -ti tcp:PORT | xargs kill` — also kills clients (Vite). Use `-sTCP:LISTEN`.

## Round 2 — platform features (worktree `features-v2`)
- [x] Secrets at rest: AES-256-GCM via `crypto.ts`; services/deployments sealed by a db codec (env, git token, resolvedEnv); settings sealed in kv; boot migration + VACUUM; wrong key stops boot. Verified: canary gone from db + WAL, key file 0600.
- [x] Settings store (`settings.ts`), owner-only writes, credentials write-only (masked on read).
- [x] Notifications (`notify.ts`): Slack, Discord, Telegram, ntfy, SMTP, signed webhook; deploy/crash/recover/job/backup/cert/preview events; flap-safe crash alerts. Verified against local HTTP + SMTP stand-ins (not real Slack/Discord).
- [x] Git webhooks (`hooks.ts`): GitHub/Gitea HMAC, GitLab token, constant-time, 2 MB cap; on the router (`/_servify/hooks/git`, any host) and `/api/hooks/git`; per-service deploy hooks. Verified with signed payloads + local bare repo (not GitHub delivering to a public URL).
- [x] HTTPS (`certs.ts` + proxy): ACME HTTP-01 via acme-client with self-check + exponential backoff, renewals, SNI, HTTP→HTTPS redirect (challenge + hook paths exempt), local CA for *.localhost. Verified end-to-end against Pebble (Let's Encrypt's test CA) with real HTTP-01 validation — not against real Let's Encrypt / ports 80+443.
- [x] Backups (`backups.ts`, `s3.ts`): pg_dumpall / mysqldump / mongodump / volume tar.gz; local, folder, S3 (SigV4, own client); restore = safety backup → wipe → re-init → replay; retention only deletes recorded keys. Round-tripped Postgres, MySQL (to MinIO), MongoDB, Redis volume — not AWS S3 itself.
- [x] History: `logstore.ts` (one follower per replica, batched SQLite writes, resume via `since`, 7d / 200k lines) and 10s metric buckets (7d). Verified across redeploy + restart with no gaps.
- [x] Compose import (`compose.ts`): interpolation, env_file inside base folder only, aliases for compose names, refuses bind mounts/privileged/host net/docker.sock with warnings. Verified hostname reachability + evil service unprivileged.
- [x] Environments + PR previews (`envs.ts`): linked projects, branch override, cascade delete, same-repo PRs only, close deletes only its own preview.
- [x] Health probes: TCP probe must stay open 300 ms (docker-proxy accepted connections for still-initialising databases).
- [x] Brand logos for services (simple-icons, CC0) generated into `web/src/components/brandIcons.ts`; language icon after first build.
- [x] MCP: 37 tools. Original acceptance suite: 29/29. New `scripts/acceptance-features.mjs`: 27/27.
- [x] Review fixes: MCP `import_compose` dry run requires a write token (it reads files under base_path); environments/previews keep private-repo git tokens; Compose `command`/`entrypoint` map to Docker-style `cmd`/`entrypoint` overrides (image entrypoint kept — verified minio `server /data`, mysql flag-only command) and never adopt templates (plain redis stays password-less); port-less compose services import as workers; restore start/end and certificate changes push `service.updated` (UI banner clears — verified through the UI); unknown ACME challenge paths are routed to the app, just never redirected.
- [x] Scheduled backups verified firing (`* * * * *`), added to the feature suite.
- [x] Container mode rebuilt and booted on spare ports: deploy, backup (docker CLI in the image), HTTP + HTTPS routing, log history. Compose publishes 8443.
- [x] pnpm 12's minimumReleaseAge rejected two day-old transitive packages (`@peculiar/asn1-pkcs8`, `@peculiar/asn1-x509` 3.1.0) → pinned to 3.0.0 via `overrides` in pnpm-workspace.yaml.

## Round 3 — first-class volumes
- [x] `volumes.ts`: VolumeRecord (own Docker volume name), create / attach / detach / rename / move / delete, live sizes (`/system/df`), free-spot placement. Existing volumes migrate at boot keeping their Docker volume (verified: data intact).
- [x] Mounts resolve through records: a replica only mounts volumes attached to its own service (rollback after a move verified not to mount it); rollbacks/restarts always use the service's current volumes.
- [x] Detach marks the record first, takes the service over, drains, then redeploys; attach checks the volume isn't mounted anywhere and queues a redeploy.
- [x] Service delete keeps volumes as detached by default in the UI; project delete removes its detached volumes.
- [x] UI: volume tabs under service cards, detached volume cards (drag onto a service to attach), Attach / New / Rename / Detach / Delete dialogs, settings section. MCP: 42 tools.

## Round 4 — per-replica volumes, PostgreSQL clusters, start on boot
- [x] Per-replica volume sets (members created on demand, kept on scale-down), rolling per-index deploys; shared volumes still force 1 replica. Gate: distinct data ×3, 3→2→3 reuse, rolling redeploy; suites 34/29.
- [x] Experiments first (plain Docker): replication pg_hba line at init, clone ownership, standby re-point via ALTER SYSTEM + reload, quorum sync, an unpaused old primary is writable (→ fencing required). Image ships gosu, not su-exec.
- [x] `pgcluster.ts`: role polling, primary-only routing (service name + TCP proxy), `<name>-read`, sync policy with async fallback, fenced failover, split-brain guard, switchover, rebuild, rolling order (primary first when not running), restore/backup via the primary.
- [x] Verified: hung primary under writes → failover in ~20s, 0/156 acknowledged writes lost, old primary rebuilt; switchover (API + UI); rolling redeploy; backup/restore; Servify restart keeps the primary of record; killed primary restarts without failover.
- [x] `servify service install|uninstall|status|print` (launchd plist validated with plutil; systemd unit generated, untested on Linux). Not installed on this machine.

## Round 5 — multi-server
- [x] Design change from the proposal: instead of a WireGuard/Tailscale mesh, servers tunnel through this Servify. `servify agent` dials out (TLS, pinned fingerprint, bearer token); Servify asks it to open streams, each its own connection, only to its Docker socket or a 127.0.0.1 port.
- [x] `nodes.ts`: server registry, agent listener (started once a server exists), per-server Docker API as a 0600 unix socket (so the docker CLI works: pulls, builds, backups), 127.0.0.1 forwarders for remote replica ports (router + probes unchanged), offline notifications after 60s.
- [x] `docker.ts` is now a per-endpoint factory; engine, deployer, builder, volumes, cron, backups, logs, metrics and the cluster manager use the service's or container's server. Offline servers: no probes, no status changes, no converge, no failover, deletes refused; reconnect re-adopts.
- [x] Placement (`server` on create, `move_service` / Move), volumes pinned to their server, cross-server variable references warned about.
- [x] Fixed along the way: docker CLI hijacked streams need half-open sockets (exec without stdin lost its output); the control connection must not be half-open (agent never noticed Servify restarting); the join one-liner re-downloaded on restart and failed its pinned hash after an upgrade (now verifies once, keeps the copy); a 20-byte (empty gzip) backup counted as success; a failed `main()` left a half-started process.
- [x] Verified against docker-in-docker: deploy/route/exec/logs/stats, a folder build on the server, postgres + volume, backups through the tunnel, agent outage without churn, reconnect, wrong token, move both ways via API and UI, a 3-member cluster with failover (20s) and rebuild on the server. MCP: 46 tools.
- [ ] Not built: private networking between servers, spreading one service's replicas across servers, moving volume data between servers, a highly available control plane.

## Round 6 — start at login
- [x] Settings → General switch (launchd agent / systemd user unit, per-data-dir label), `servify service` shares the code; one Servify per data directory (pid + start-time lock).

## Round 7 — hosting existing workloads (from inspecting a real server: 40 containers, 21 compose projects, NPM)
- [x] Host folders (allowlist `SERVIFY_HOST_MOUNTS`, deny list, must exist, realpath re-check, opt-in SELinux `z`/`Z`, read-only), re-validated at container create.
- [x] Read-only shares of another service's volume (same project + server, no sets).
- [x] Adopt existing Docker volumes (refused while any outside container references them, any state); forget-keep-data; adopted never deleted implicitly; deleting a volume never removes foreign containers.
- [x] Published ports TCP/UDP (one replica, stop-first, clash/busy/own-port checks); external routes (separate probe table, Host + WebSocket pass-through, refuse deploy-shaped ops).
- [x] Data-safety audit: backups/restores/deletes only touch owned volumes; environments strip host folders, shares, ports and external routes; owner-only gates in the service layer (REST, MCP, imports).
- [x] Compose import: host folders (owner + allowlist, `:ro`/`:z`), UDP → published ports, `adoptVolumes`.
- [x] `scripts/acceptance-hosting.mjs`: 51/51. MCP: 48 tools.
- [ ] SELinux relabel untested (no Fedora host here); not yet tried on the real server.

## Round 8 — replacing Nginx Proxy Manager
- [x] Redirect services (308/301/307/302, keep path), UDP forwarding on external TCP routes (per-client relay, idle timeout), no router request deadline (Node's default 5 min cut long uploads), `SERVIFY_TRUSTED_PROXIES` for X-Forwarded-Proto behind NPM.
