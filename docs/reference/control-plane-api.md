# Control-plane HTTP API

[`apps/server`](../../apps/server) is the environment-level Gauntlet process. It
has three main responsibilities:

1. own the explicit target registry for the current environment;
2. validate discovery and every adapter request/response at the public
   boundary;
3. expose a shared execution boundary to the dashboard and MCP clients.

The current public routes are:

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Process liveness. |
| `GET` | `/ready` | Validated local startup; does not probe adapters. |
| `GET` | `/api/v1/targets` | Discover configured targets and their validated adapter state. |
| `GET` | `/api/v1/targets/{targetId}/operations/{operationId}` | Read one complete operation definition. |
| `POST` | `/api/v1/targets/{targetId}/operations/{operationId}/runs` | Validate and create a run. |
| `GET` | `/api/v1/targets/{targetId}/runs/{runId}` | Read the latest validated run projection. |
| `POST` | `/api/v1/targets/{targetId}/uploads` | Proxy a bounded upload when advertised. |
| `POST` | `/api/v1/targets/{targetId}/runs/{runId}/cancel` | Request cancellation when advertised. |
| `GET` | `/api/v1/targets/{targetId}/runs/{runId}/events` | Proxy validated resumable SSE when advertised. |
| `POST` | `/api/v1/targets/{targetId}/data-sources/{dataSourceId}/query` | Query one declared data source. |
| `POST` | `/api/v1/targets/{targetId}/data-sources/{dataSourceId}/resolve` | Resolve stored values in request order. |
| `POST` | `/api/v1/targets/{targetId}/runs/{runId}/artifacts/{artifactId}/launch` | Mint a validated browser-session URL. |
| `GET` | `/api/v1/targets/{targetId}/pins` | List the caller's pinned operations on a target. |
| `PUT` | `/api/v1/targets/{targetId}/pins/{operationId}` | Pin an operation. |
| `DELETE` | `/api/v1/targets/{targetId}/pins/{operationId}` | Unpin an operation. |

There is intentionally no “fetch any adapter URL”, “execute command”, or
“proxy arbitrary endpoint” route.

Discovery and operation reads reuse a target's last online snapshot (adapter
health and manifest) for up to five seconds instead of asking the adapter on
every request; a target that is not online is always asked again. An operation
definition is read from the adapter once per revision, because the revision is
the hash of the definition. When an adapter returns a definition newer than
the reused manifest, Gauntlet reads the manifest again before answering.

## Addressing and request bodies

All target, operation, run, data-source and artifact IDs are protocol-safe IDs
from configuration or validated responses. Target origins cannot be supplied
by the caller. Discovery returns `{ "targets": [...] }`; internal adapter
origins are not exposed in that response.

Create-run requests use the Adapter v1 document described in
[run lifecycle](run-lifecycle.md#create-a-run). Operation definitions and runs
are returned directly. `POST` create returns 202 for `queued`/`running`, or 201
for a terminal run. A 201 status does not imply business success: inspect the
run's `state` and optional `problem`.

Data-source query accepts search, cursor, limit, dependencies and invocation
context; resolve accepts values and optional dependencies/context. Both use
[Adapter v1 schemas](../../packages/protocol/schemas/v1).
Uploads require one `multipart/form-data` field named `file` and return a file
reference. The default file limit is 16 MiB; the default JSON body limit is
1 MiB. Capability checks and request/response validation apply before data is
returned to a caller.

## Errors and events

REST failures return `application/problem+json` with a sanitized Problem.
Internal exception details, upstream credentials and raw response bodies are
not included. Unknown routes return 404 and unsupported methods on known
routes return 405 with an `Allow` header.

The run-event route requires `tc-run-sse@1`. It accepts an optional
`Last-Event-ID`, emits validated `run.updated` snapshots and closes its upstream
stream when the downstream client disconnects. Cancellation requires
`tc-run-cancellation@1` and does not undo domain effects.

Session launch requires a known `browser-launch` artifact, advertised
`tc-session-launch@1` and a configured `publicUrl`. The server validates the
returned URL's origin and expiry and returns it without fetching it.

## Pinned operations

Pins belong to the calling principal and one target: each user and API token
has its own pins, everyone signed in with the shared password shares one set,
and with authentication disabled everyone shares the `anonymous` set. A pin on
one target never applies to an operation with the same ID on another target.

`GET` returns `{ "pins": [{ "operationId": "...", "pinnedAt": "..." }] }`,
oldest first, with `pinnedAt` as an ISO 8601 time. `PUT` and `DELETE` take no
body and return 204. Both are idempotent: pinning an operation again keeps its
original `pinnedAt`, and unpinning an operation that is not pinned succeeds.
An unknown target returns `target-not-found`; the operation ID is not checked
against the manifest, so a pin stays stored while its operation is missing.
A principal can pin at most 100 operations per target; the next `PUT` returns
409 `urn:gauntlet:problem:pin-limit`. A database failure returns 500
`urn:gauntlet:problem:pins-unavailable`. With authentication enabled, a
cookie-authenticated `PUT` or `DELETE` must come from Gauntlet's own origin.

Pins are stored in `gauntlet.sqlite` under `GAUNTLET_DATA_DIR`; without it the
database is in memory and pins are lost on restart. See
[server configuration](../../apps/server/README.md#runtime-environment).

## MCP and static dashboard

The optional `/mcp` endpoint uses Streamable HTTP and the same services and
projection store. It has its own MCP framing, tools and Origin checks; it is
not part of `/api/v1`. See the [MCP reference](../mcp.md).

When configured, static dashboard files are served from `/`. HTML navigation
may use the SPA fallback, but `/api`, `/mcp`, `/health`, `/ready`, `/assets`
and `/widget` are reserved, including their child paths. An explicit invalid
dashboard directory fails startup; omitting it selects API-only mode.

## Widget

When enabled, the embeddable widget is served from `GAUNTLET_WIDGET_DIR`
under `/widget`; `/api/v1` gains no CORS from this. The routes are:

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/widget/loader.js` | The widget's bootstrap script; no-cache, strongly `ETag`'d, cross-origin readable. |
| `GET` | `/widget/` | The widget panel HTML; framed only by the configured target origins via `Content-Security-Policy`. |
| `GET` | `/widget/config.json` | `{ "targets": { "<id>": ["<origin>", ...] } }`, one entry per target that declares `widget.origins`. |
| `GET` | `/widget/assets/<file>` | Optional built assets; content-hashed filenames are cached immutably, others are not. |

Disabling the widget — the default — returns the `route-not-found` problem
for every `/widget` path and never reads the directory. See
[server configuration](../../apps/server/README.md#widget-routes) for headers
and cache semantics.

[Server configuration](../../apps/server/README.md) · [Architecture](../architecture.md) · [Documentation index](../README.md)
