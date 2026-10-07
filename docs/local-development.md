# Local development

Run commands from the repository root unless a section says otherwise.
This page is for working on Gauntlet itself. To connect your own application,
use [application integration](integrations/index.md).

## Requirements and build

Use Node.js 24–26 (`.node-version` selects Node 24) and the repository's pinned
pnpm 11.24.0. Corepack can provide the package-manager version when installed.
Docker is needed for container, PHP and Java verification, but not for the
local TypeScript demo below.
Helm checks and chart packaging use Helm 4.0.4; cluster operations also need
`kubectl`. See the [Helm runbook](../deploy/helm/README.md) for that toolchain.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

If your Node distribution does not include Corepack, install the pinned pnpm
version through your normal development-tool setup. Workspace commands and
their exact versions are declared in [package.json](../package.json).

## Run the local demo

After the build, run the following in a terminal at the repository root. It
starts the real Node adapter with an in-memory conformance catalog, serves the
built dashboard on loopback port 8080 and enables MCP for this local instance.
It does not connect to your applications or require a configuration file.

```sh
node --input-type=module <<'JS'
import { startServer } from './examples/node-adapter/dist/server.js';
import { createApp } from './apps/server/dist/app.js';

const environment = { name: 'typescript-fixture-test', kind: 'test' };
const adapter = await startServer();
let app;
try {
  app = await createApp({
    environment,
    targets: [{
      id: 'example', label: 'Example application', adapterUrl: adapter.url,
      expectedEnvironment: environment,
    }],
    dashboardDir: 'apps/dashboard/dist',
    mcp: { enabled: true },
  });
  await app.listen({ host: '127.0.0.1', port: 8080 });
} catch (error) {
  await app?.close();
  await adapter.close();
  throw error;
}
console.log('Dashboard: http://127.0.0.1:8080');
console.log('MCP: http://127.0.0.1:8080/mcp');
const close = async () => { await app.close(); await adapter.close(); };
process.once('SIGINT', close);
process.once('SIGTERM', close);
JS
```

Open **http://127.0.0.1:8080** and choose **Example application**. The sample
catalog includes **Finalize agency application** and a deliberate failure
operation. For the finalize operation, enter
`11111111-1111-4111-8111-111111111111` as `applicationId` and `123456` as
`confirmationCode`, then confirm and run. These are fixture values, not real credentials.
The follow-up link uses an example domain; it is not a deployed application. Stop the process with Ctrl+C
when finished. Restarting resets the fixture and control-plane history.

The demo uses explicit `environment` and `expectedEnvironment` descriptors,
as required by the current server API. It is single-process development
infrastructure, not a durable deployment configuration.

### Widget demo

To try the [embeddable widget](integrations/widget.md) across two origins,
run the widget demo after the build instead of the demo above (both use
port 8080):

```sh
node apps/dashboard/scripts/local-stack.mjs
```

It starts the same sample adapter, a widget-enabled control plane on
**http://127.0.0.1:8080**, and a host page on port 5180 that embeds the
widget. Open the printed host URL
(**http://127.0.0.1:5180/applications/11111111-1111-4111-8111-111111111111**), then
the widget button: **Finalize agency application** is listed for the
application on the page, with `applicationId` prefilled. The host page's links
switch applications through `pushState`. Stop it with Ctrl+C.

## Edit the dashboard with live reload

Leave the local demo running as the backend and use another terminal:

```sh
pnpm --filter @8lines/gauntlet-dashboard dev --host 127.0.0.1
```

Open **http://127.0.0.1:5273**. Vite proxies `/api` and `/health` to port 8080.
Set `GAUNTLET_API` before the command to use a different private control-plane
origin. MCP clients connect directly to port 8080, not the Vite development port.

## Run the server against your own adapter

Create a valid file using the [configuration reference](../config/README.md).
Choose an adapter origin reachable from the local server process and matching
environment metadata. Then run:

```sh
GAUNTLET_CONFIG_FILE=/absolute/path/to/config.yaml \
GAUNTLET_HOST=127.0.0.1 \
GAUNTLET_DASHBOARD_DIR=apps/dashboard/dist \
node apps/server/dist/main.js
```

Omit `GAUNTLET_DASHBOARD_DIR` for API-only mode. Add
`GAUNTLET_MCP_ENABLED=true` to enable MCP. Add `GAUNTLET_DATA_DIR` with an
existing, writable directory to keep pinned operations across restarts;
without it they are kept in memory. Stop the demo first if it already
occupies port 8080, or choose another `GAUNTLET_PORT`.

New setups use `GAUNTLET_CONFIG_FILE`; the deprecated
`GAUNTLET_TARGETS_JSON` input needs additional environment fields and is
documented only for migration in the configuration reference.

## Verification commands

Choose checks that match your change. The full TypeScript workspace gate is:

```sh
pnpm check
```

It builds packages, typechecks, runs workspace tests and checks clean consumers
of packed npm artifacts. Use focused commands while developing:

| Change | Check |
| --- | --- |
| Server or MCP | `pnpm --filter @8lines/gauntlet-server test` |
| Dashboard logic | `pnpm --filter @8lines/gauntlet-dashboard test` |
| Dashboard browser behavior | Build the dashboard, then `pnpm dashboard:test:e2e` for mobile and desktop. A Playwright-compatible browser must be installed. |
| Documentation | `pnpm docs:check` |
| Compose distribution | `pnpm test:compose:distribution` |
| Helm distribution | `pnpm test:helm` with the documented Helm toolchain. |
| Helm package | `node --test deploy/helm/test-chart-package.mjs` |
| Helm runbook commands | `node --test deploy/helm/test-documentation.mjs` |
| Adapter interoperability | Follow [conformance](../conformance/README.md) with separate enabled and disabled adapter origins. |
| PHP / Symfony | [PHP Core checks](../packages/php/core/README.md#verify) and [Symfony checks](../packages/php/symfony-bundle/README.md#package-tests). |
| Java / Spring | [Java verification](../packages/java/README.md#reproducible-verification). |

The Compose smoke test builds the dashboard/server image and fixture adapters,
runs a private temporary topology and removes its own resources afterward:

```sh
pnpm smoke:compose
```

This is an automated check, not a persistent demo. It refuses remote Docker
endpoints and does not use the standalone installation's shared adapter network.

Release maintainers follow the separate [release runbook](releases/releasing.md)
and [contribution requirements](../CONTRIBUTING.md).

[Documentation index](README.md) · [Repository guide](reference/repository.md) · [Architecture](architecture.md)
