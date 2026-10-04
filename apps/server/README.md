# Gauntlet server

`@8lines/gauntlet-server` is the Fastify control plane. It loads one
non-production instance configuration, exposes the dashboard-facing API, and
calls only explicitly configured Adapter v1 origins. Its opt-in `/mcp` endpoint
lets AI clients use those same capabilities and run projections. See the
[MCP setup and tool reference](../../docs/mcp.md). Application-specific
handlers live behind adapters in the consuming applications, not in this
process.

## Build and run

From the repository root, install and build the server with:

```sh
pnpm install --frozen-lockfile
pnpm --filter @8lines/gauntlet-server... build
```

The workspace build places the executable in `apps/server/dist`. From
`apps/server`, run it as:

```sh
GAUNTLET_CONFIG_FILE=../../config/fixtures/config.valid.yaml \
GAUNTLET_HOST=127.0.0.1 \
GAUNTLET_PORT=8080 \
node dist/main.js
```

The fixture file above contains example private hostnames; it starts the server
but does not start those applications. For an online sample target and dashboard,
use the [local demo](../../docs/local-development.md#run-the-local-demo).

The process validates and owns the complete configuration before it constructs
the HTTP application. It then validates the listen address and opens the
listener. A configuration or listen failure therefore cannot leave a partially
configured listener running. Startup writes only a generic failure message to
stderr; configuration errors use bounded, code-only diagnostics.

## Runtime environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `GAUNTLET_CONFIG_FILE` | `/etc/gauntlet/config.yaml` | Lowercase `.yaml`, `.yml`, or `.json` v1 configuration file. See [`../../config/README.md`](../../config/README.md) for the full source and migration contract. |
| `GAUNTLET_HOST` | `0.0.0.0` | Listener host. Bind or publish it only on loopback, VPN, Tailscale, or another trusted private interface. |
| `GAUNTLET_PORT` | `8080` | Integer listener port from 1 through 65535. |
| `GAUNTLET_MCP_ENABLED` | `false` | Exact `true` enables Streamable HTTP at `/mcp`; invalid boolean strings fail startup. |
| `GAUNTLET_MCP_ALLOWED_ORIGINS_JSON` | `[]` | Exact HTTP(S) Origin allow-list. Requests without Origin are allowed; other origins receive 403. |
| `GAUNTLET_DASHBOARD_DIR` | unset | Directory containing a built, regular `index.html` file. Only an unset variable enables API-only mode; an explicit invalid directory fails startup. |
| `GAUNTLET_WIDGET_DIR` | unset | Directory containing a built, regular `index.html`, `loader.js` and optional `assets/`. Read at startup; required when `widget.enabled` is `true` in the v1 configuration, otherwise ignored. |
| `GAUNTLET_AUTH_SECRET` | unset | Signing secret for sessions and tokens, hex or base64url, at least 32 bytes. Required when `auth.mode` in the v1 configuration is not `none`, otherwise ignored. Generate one with `node dist/auth-cli.js generate-secret`; rotating it signs everyone out. |

Environment values are read as direct process-owned string values. Invalid or
hostile values fail with generic diagnostics and are not reflected back to the
caller. Configuration is not reloaded: change it and restart the process.

## Widget routes

When the v1 configuration's `widget.enabled` is `true`, `GAUNTLET_WIDGET_DIR`
must point at a directory with a regular `index.html` and `loader.js`
(`assets/` is optional); an invalid or missing directory fails startup with
"Widget files are missing". When the widget is disabled — the default —
every `/widget` path returns the `route-not-found` problem and the directory
is never read.

| Method | Route | Response | Cache | Notes |
| --- | --- | --- | --- | --- |
| `GET` | `/widget/loader.js` | `text/javascript; charset=utf-8` | `no-cache`, strong `ETag` | `Cross-Origin-Resource-Policy: cross-origin`, `X-Content-Type-Options: nosniff`; no CORS headers. |
| `GET` | `/widget/` | `text/html; charset=utf-8` | `no-cache`, strong `ETag` | `Content-Security-Policy: frame-ancestors <configured target origins>` (or `'none'` when no target declares `widget.origins`). |
| `GET` | `/widget/config.json` | `application/json; charset=utf-8` | `no-cache` | `{ "targets": { "<id>": ["<origin>", ...] } }`, one entry per target with `widget.origins`. |
| `GET` | `/widget/assets/<file>` | as served | `public, max-age=31536000, immutable` for content-hashed filenames (`name-<hash>.ext`), otherwise `no-cache` | 404 when `assets/` is absent or the file is missing. |

Only an exact `If-None-Match` match returns `304`; anything else, including a
weak comparator or a stale value, re-sends the full body. Unknown widget
paths and non-`GET` methods never reach the panel or the dashboard SPA
fallback. The dashboard's own HTML responses always send
`Content-Security-Policy: frame-ancestors 'none'`; only the widget panel may
be framed, and only by the origins its targets configure.

## Liveness and readiness

- `GET /health` returns `{ "status": "ok" }`. It is process liveness and does
  not call or probe any configured target.
- `GET /ready` returns `{ "status": "ready" }`. A reachable listener implies
  configuration validation and Fastify initialization (`app.ready()`) already
  completed. It does not assert that every target is currently healthy.

Target discovery and compatibility are reported per target. An unavailable,
malformed, or environment-mismatched adapter does not change `/health` or
`/ready` and does not restart the control plane.

## Deployment boundary

Run the release container as its non-root user and mount
`/etc/gauntlet/config.yaml` read-only. The dashboard and API have no built-in
authentication in v0.1, so the listener must remain behind a trusted
private network boundary. Configure `adapterUrl` values as private
server-to-server origins; do not publish adapter routes or their ports to the
public Internet.

The server does not discover containers, namespaces, services, routes, SQL,
commands, topics, or arbitrary URLs. It receives no Docker socket, Kubernetes
service-account token, RBAC, or cluster-discovery privileges.

[Documentation index](../../docs/README.md)
