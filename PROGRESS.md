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
