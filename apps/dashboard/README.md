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

## Source layout

All code lives under `apps/dashboard/src`:

| Path | Contents |
| --- | --- |
| `components/ui/` | shadcn/ui primitives (Radix, `new-york` style) as emitted by the shadcn CLI. |
| `components/gauntlet/` | Gauntlet composites built on those primitives: the schema-driven `operation-form/`, `RunView`, `ArtifactView`, `RecentRunsList`, `ChunkErrorBoundary`, `OperationLoading` and similar. |
| `app/` | The shell: `App`, `AppSidebar`, `AppHeader`, `EnvironmentSwitcher`, `CommandSearch`, `SettingsDialog`, `McpConnection`, `PageStates` and `useReturnFocus`. |
| `screens/` | Routed screens: `OverviewScreen`, `CatalogTable`, `OperationScreen` (loaded on demand) and `useOperationRun`. |
| `widget/` | The embeddable widget panel, which reuses the same composites. |
| `*.ts` at the `src/` root | UI-free logic with unit tests (`api`, `catalog`, `copy`, `route`, `recent-runs`, `browser-storage`, `run-actions`, `form-upload`, `operation-errors`, `targets-state`, `recent-run-state`, `preferences`, `json-pointer`, `create-run-request`) and the data hooks (`useRun`, `useTargets`, `useRecentRunStates`, `useOperationDetails`). |

Run URLs have the form `/t/:targetId/o/:operationId/r/:runId`. Recent runs
are stored in `localStorage` under `gauntlet.recent-runs.v1`, shared by the
dashboard and the widget panel on the same origin.

### Add a shadcn component

From `apps/dashboard`:

```sh
pnpm dlx shadcn@latest add <name>
```

The generated file lands in `src/components/ui/`. Then:

1. If the CLI emitted `import { cn } from "cn"`, rewrite it to
   `import { cn } from "@/lib/utils"` and remove the stray `cn` package it
   may have installed (`pnpm remove cn`).
2. Apply the project's focus-ring substitution in the new file: replace
   `focus-visible:ring-[3px]` with
   `focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background`
   and `focus-visible:ring-ring/50` with `focus-visible:ring-ring`.
   Shadows such as `shadow-xs` and `shadow-sm` are neutralised by the design
   tokens and need no change.
3. Compose Gauntlet-specific behaviour in `components/gauntlet/`, not inside
   `components/ui/`.

The visual rules (typography, palette, state colour, focus, motion) are in the
[dashboard design spec](../../docs/superpowers/specs/2026-10-02-dashboard-shadcn-redesign-design.md).

## Verify changes

```sh
pnpm --filter @8lines/gauntlet-dashboard test
pnpm --filter @8lines/gauntlet-dashboard build
pnpm dashboard:test:e2e
pnpm widget:test:e2e:panel
```

The browser suite exercises mobile and desktop layouts, includes an axe
accessibility gate for the redesigned screens in light and dark themes
(`e2e/accessibility.spec.ts`), and requires a
Playwright-compatible browser. Its preview server is separate from the local
development backend. `widget:test:e2e:panel` runs the panel's own Playwright
suite (`apps/dashboard/playwright.widget.config.ts`) against a host page
embedding the widget from a second origin; the loader's own end-to-end suite
is `pnpm widget:test:e2e`.

[Source map](../../docs/reference/repository.md#dashboard-source-map) · [Documentation index](../../docs/README.md)
