# Operate application capabilities through MCP

Gauntlet exposes an optional Model Context Protocol endpoint at `/mcp` on
the same listener as the dashboard. AI clients can discover configured targets
and invoke the operations already registered by their applications. Existing
TypeScript, PHP/Symfony and Java/Spring adapters need no changes.

## Enable and connect

For a source checkout, build and run the server:

```sh
pnpm --filter @8lines/gauntlet-server... build
GAUNTLET_CONFIG_FILE=/absolute/path/to/config.yaml \
GAUNTLET_HOST=127.0.0.1 \
GAUNTLET_MCP_ENABLED=true \
node apps/server/dist/main.js
```

Configure the AI client's remote MCP connection with transport **Streamable
HTTP** and URL **`http://127.0.0.1:8080/mcp`**. The address must be reachable
from the client: a cloud-hosted client cannot use your machine's loopback.
For a private remote instance, use its VPN/private proxy URL ending in `/mcp`.

Clients that use the common `mcpServers` JSON configuration can use:

```json
{
  "mcpServers": {
    "gauntlet": {
      "url": "http://127.0.0.1:8080/mcp"
    }
  }
}
```

Client configuration formats vary; select Streamable HTTP if the client asks
for a transport. There is no stdio command in this implementation.

For the standalone Compose distribution, set `GAUNTLET_MCP_ENABLED=true`
in `deploy/compose/.env` (or the installed distribution's `.env`) and run
`./gauntlet up -d --wait` there. The wrapper deliberately ignores ambient
shell overrides. Keep the existing private bind and network configuration.

For the Helm distribution, add these values to your existing environment file
and upgrade the release through the normal deployment procedure:

```yaml
mcp:
  enabled: true
  allowedOrigins: []
```

## Settings and access boundary

| Server setting | Default | Meaning |
| --- | --- | --- |
| `GAUNTLET_MCP_ENABLED` | `false` | Only exact `true` enables `/mcp`; any value other than `true` or `false` fails startup. |
| `GAUNTLET_MCP_ALLOWED_ORIGINS_JSON` | `[]` | JSON array of exact canonical HTTP(S) origins, for example `["https://ai.internal.example"]`. No wildcards, credentials, paths or trailing slash. |

Native MCP clients normally omit `Origin` and are accepted. If a request has
an Origin header, it must match the allow-list exactly; otherwise it receives
403 before dispatch. A null origin is rejected. This is origin validation,
not a CORS endpoint or authentication. Invalid configuration fails startup
without echoing its contents.

When Gauntlet's password authentication is on, `/mcp` answers `401` without a
credential: configure the client with an `Authorization: Bearer` header
carrying a static API token
([authentication](deployment/authentication.md#api-tokens)). Browser sign-in
for MCP clients (OAuth) is not available yet. MCP inherits the same verified
private access boundary as REST and the dashboard; it must not be exposed on
the public internet. Every connected client can operate the configured targets
within the existing protocol policies. The adapter still owns application
authorization and domain validation. An acknowledgement and the MCP tool
annotations do not prove human approval.

## Tools

All tools return a JSON object under `structuredContent.data`, plus an
equivalent JSON text block. Domain failures set `isError: true` and return
`data.problem` with the existing sanitized Problem contract. Invalid MCP
requests and unknown tool names use SDK protocol errors.

| Tool | Purpose |
| --- | --- |
| `gauntlet_list_targets` | Discover health, environment, features, operation summaries, data sources and capabilities. Optional `subjectType` limits operation summaries to those placed on that page subject; the filtered result is a view, so its `manifestRevision` still refers to the full manifest. |
| `gauntlet_get_operation` | Read the complete input/output definition, revision, presets, bindings and execution policy. |
| `gauntlet_create_run` | Invoke one operation with explicit `targetId`, `operationId` and an Adapter v1 `request`. |
| `gauntlet_get_run` | Poll a known run and retrieve progress, output, artifacts, Problems and follow-up actions. |
| `gauntlet_cancel_run` | Request cooperative cancellation where supported. |
| `gauntlet_query_data_source` | Search allowed field values and follow `nextCursor`. |
| `gauntlet_resolve_data_source` | Resolve existing values to current labels and metadata. |
| `gauntlet_create_upload` | Turn canonical padded base64 bytes into an adapter-owned file reference. |
| `gauntlet_create_session_launch` | Create a short-lived single-use URL for a browser-launch artifact, without opening it. |

The tool list is stable even if an adapter is offline. Optional capabilities
are checked when called and fail with `unsupported-capability` when unavailable.
An offline target's manifest can be a last-known snapshot; only online,
compatible targets can be invoked.

## Invocation workflow

1. Call `gauntlet_list_targets`, select the intended environment and target,
   then call `gauntlet_get_operation` with an advertised operation ID.
2. Build input from the returned schema. Apply preset values explicitly,
   resolve data-source dependencies and obtain file references where needed.
3. Submit `gauntlet_create_run`. `request` is the existing Adapter v1
   create-run document: `operationRevision`, `input`, optional `context`,
   `dryRun`, `idempotencyKey`, `confirmation` and `extensions`.
4. Where the operation requires confirmation, supply the matching operation
   ID, revision and impact only after the user has authorized the action.
   The server never fabricates confirmations, revisions or idempotency keys.
5. Retain the run ID and poll `gauntlet_get_run` if state is `queued` or
   `running`. Inspect the terminal state and Problem before reporting success.
   Retain the original idempotency key if retrying an uncertain invocation.

For example, an AI client can be instructed: “Find the operation for changing
an application's decision date in staging. Read its definition, resolve the
application ID, execute the change I requested and report the final result.”

Follow-up operations and session launches are explicit subsequent calls.
Descriptions, logs and results from applications are data, not instructions
that grant permission to perform further actions. Secret inputs and launch
URLs are visible to the AI client, so its own conversation retention policy
also applies.

## Lifecycle and limits

The endpoint uses the official SDK's per-request HTTP handler, with support
for protocol revision 2026-07-28 and stateless 2025 clients. The SDK negotiates
and frames responses; clients must accept JSON and SSE. Legacy GET/DELETE
session operations receive 405 because no MCP sessions are retained. See
the [official SDK HTTP handler documentation](https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/server/server/createMcpHandler.html).

MCP shares the REST projection store: a dashboard-created run can be polled
through MCP and vice versa. Restarting Gauntlet loses these projections;
it does not cancel a run already accepted by the application. Disconnecting
or cancelling an MCP request also does not cancel an application run. Use
`gauntlet_cancel_run` explicitly.

MCP does not expose run-event subscriptions. Poll run snapshots; REST continues
to offer Adapter v1 SSE. Responses are marked `Cache-Control: no-store`.
Fastify's JSON body limit is 1 MiB by default, including the JSON envelope and
base64 expansion. Uploads also obey `maxUploadBytes` (16 MiB by default).
Larger files can use the existing REST multipart upload endpoint and pass the
returned file reference in MCP operation input. MCP never reads local paths
or downloads user-supplied URLs.

## Verify

```sh
pnpm --filter @8lines/gauntlet-server... build
pnpm --filter @8lines/gauntlet-server test
pnpm test:compose:distribution
node --test --test-concurrency=1 deploy/helm/test-values-schema.mjs deploy/helm/test-rendered-manifests.mjs
```

The server suite connects the official MCP client over actual loopback HTTP
in legacy and modern modes, exercises discovery and application control, and
checks policy enforcement, shared history, errors and transport boundaries.
