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
