# Gauntlet dashboard

The browser interface for Gauntlet: select an application, fill an operation
form and inspect its run. Forms and results come from the application's
registered definitions.

For everyday use, see the [user guide](../../docs/user-guide.md). This page
covers frontend development; system responsibilities are described in
[architecture](../../docs/architecture.md).

## Run locally

From the repository root, install and build the workspace, then start the
[local demo backend](../../docs/local-development.md#run-the-local-demo).
It provides a real Node adapter and control plane on port 8080.

In a second terminal:

```sh
pnpm --filter @8lines/gauntlet-dashboard dev --host 127.0.0.1
```

Open **http://127.0.0.1:5273**. To use another private control-plane origin:

```sh
GAUNTLET_API=http://127.0.0.1:9090 \
pnpm --filter @8lines/gauntlet-dashboard dev --host 127.0.0.1
```

The Vite proxy handles `/api` and `/health`. MCP connects directly to the
control-plane listener, not to the Vite port.

## Build and serve

```sh
pnpm --filter @8lines/gauntlet-dashboard build
```

This also builds the [embeddable widget](../../docs/integrations/widget.md)
panel entry (`apps/dashboard/src/widget`) into `apps/dashboard/dist-widget`,
alongside the built loader copied in from `@8lines/gauntlet-widget-loader`.
The widget build (`vite.widget.config.ts`) uses `apps/dashboard/widget/` as
its Vite root; its `index.html` loads the entry `../src/widget/main.tsx`.

The dashboard output is `apps/dashboard/dist`. Set `GAUNTLET_DASHBOARD_DIR` to
that directory, and `GAUNTLET_WIDGET_DIR` to `apps/dashboard/dist-widget` if
the widget is enabled, when starting a configured server; see the
[complete server command](../../docs/local-development.md#run-the-server-against-your-own-adapter).
A configuration file and matching adapter environment are still required.
The packaged container already includes both built directories.

SPA fallback is limited to HTML navigation outside reserved API, MCP, health,
readiness and asset paths. See the
[HTTP reference](../../docs/reference/control-plane-api.md#mcp-and-static-dashboard).

### Widget panel development

```sh
pnpm --filter @8lines/gauntlet-dashboard dev:widget
```

Serves the panel entry alone with its own Vite dev server, proxying `/api`,
`/health` and `/widget/config.json` to a running control plane (`GAUNTLET_API`,
default `http://127.0.0.1:8080`). Build the loader
(`pnpm --filter @8lines/gauntlet-widget-loader build`) first if
`dist-widget/loader.js` is missing.

## Verify changes

```sh
pnpm --filter @8lines/gauntlet-dashboard test
pnpm --filter @8lines/gauntlet-dashboard build
pnpm dashboard:test:e2e
pnpm widget:test:e2e:panel
```

The browser suite exercises mobile and desktop layouts and requires a
Playwright-compatible browser. Its preview server is separate from the local
development backend. `widget:test:e2e:panel` runs the panel's own Playwright
suite (`apps/dashboard/playwright.widget.config.ts`) against a host page
embedding the widget from a second origin; the loader's own end-to-end suite
is `pnpm widget:test:e2e`.

[Source map](../../docs/reference/repository.md#dashboard-source-map) · [Documentation index](../../docs/README.md)
