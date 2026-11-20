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
- [ ] Fresh clone: pnpm install && pnpm build && pnpm start; password setup/logout/login; SSE under cookie; acceptance with token.
- [ ] Acceptance additions: failing deploy keeps old version (stateless + volume), rollback, stop/start, docker kill, redis data persists, autoscale up/down, git auto-deploy via local bare repo, project delete leaves nothing.
- [ ] Templates each once (skip ollama); uptime-kuma websocket via browser.
- [ ] UI: drag/snap, wheel/pinch, minimap, context menus, ⌘K, light theme, agents token flow, activity, perf with ~25 nodes.
- [ ] In-container mode: join project networks or don't document.
- [ ] README, LICENSE. Kill dev servers/curl loops before final run.
