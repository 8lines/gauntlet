# Gauntlet Embeddable Widget Design

Date: 2026-09-25  
Status: draft, awaiting review

## Purpose

Testers, developers and product owners switch between the application under
test and the Gauntlet dashboard to run the operation that fits the page they are
looking at. The embeddable widget removes that switch. An application adds one
script tag and gets a floating Gauntlet button, similar to Intercom, ybug or
jam.dev. The panel lists operations that match the current page, with inputs
prefilled from the page, and global operations available on every page.

The widget is another presentation of the same operation catalog. It does not
add a second execution path: it reads operation definitions and creates runs
through the existing `/api/v1` routes, exactly like the dashboard.

## Success criteria

- An application enables the widget with one `<script>` tag and a `boot` call,
  or with the typed `@8lines/gauntlet-widget` package.
- On a page such as `/orders/123`, the panel shows operations placed on the
  `order` subject, and opening one prefills `orderId` with `123`.
- Global operations and a search over the whole target catalog are available
  on every page.
- A run started from the widget shows the same confirmation, progress and
  results as the dashboard, and remains reachable from the panel's recent-run
  list after a page reload.
- The widget is unusable from origins that are not explicitly configured for
  the target, and the dashboard can no longer be framed by any page.

## Decisions

- **Page context is hybrid.** URL rules declared at `boot` derive subjects by
  default. The application can add or override subjects at runtime with
  `setSubject`. An explicit subject wins over a URL-derived subject of the same
  type.
- **Operations declare placements in the protocol.** `placements` is a first-class,
  schema-validated field of the operation summary and the operation definition,
  guarded by a new profile `gauntlet-page-placements@1`. All three SDKs,
  semantic fixtures, conformance and MCP are updated.
- **The name "page context" is distinct from invocation context.** The protocol
  already uses `contextSchema`, `contextPointers` and `invocationContext` for
  request metadata. The new concept is called *page context* in prose and
  `placements` on the wire. Page context itself never enters the adapter
  protocol.
- **The panel runs in an iframe served by Gauntlet.** The panel is same-origin
  with `/api/v1`, so the API gains no CORS surface. The host page talks to the
  panel through a versioned `postMessage` channel over a private
  `MessagePort`.
- **Distribution is a server-hosted loader plus a thin npm package.** The loader
  is always served by the Gauntlet instance, so it always matches the server
  version. The npm package holds only types and a command queue stub, with no
  UI.
- **The panel is a second Vite entry point in `apps/dashboard`.** It reuses the
  existing form, run-progress and API modules. Extracting a shared UI package
  is deferred.
- **Allowed origins are configured per target.** A page may open the widget only
  for a target that lists the page's exact origin.
- **Testers can reach Gauntlet from their browsers** whenever they use the
  environment. The widget complements Gauntlet network access; it does not
  replace it.

## Scope

### In scope for v1

1. Contextual operations matched by page subjects, with input prefill.
2. Global operations.
3. Search across the target catalog.
4. Recent runs started from the widget.
5. Protocol, SDK, conformance, server, MCP, documentation and local-demo
   changes needed for the above.

### Out of scope for v1

- Operations from other targets than the one named at `boot`.
- Bug reporting (screenshots, console or network capture, issue export).
- Recording which page started a run.
- Authentication. The v0.1 private-boundary requirement is unchanged.
- Filling host-page forms. It is planned as v2 (see *Future work*); v1 only
  reserves the channel for it.

## Architecture

```
Application under test (https://shop.dev.example)     Gauntlet (https://gauntlet.internal)
┌─────────────────────────────────────────┐            ┌──────────────────────────────────┐
│ <script src=".../widget/loader.js">     │   loads    │ apps/server                      │
│                                         │◄───────────│  GET /widget/loader.js           │
│ loader (vanilla TS, single IIFE):       │            │  GET /widget/  (panel SPA)       │
│  • floating button in Shadow DOM        │            │  GET /widget/config.json         │
│  • hidden iframe, preloaded on idle     │            │  CSP frame-ancestors per config  │
│  • URL rules + setSubject → subjects    │            │  /api/v1 unchanged               │
│  • window.Gauntlet command queue        │ MessagePort│                                  │
│  • origin/source checks                 │◄──────────►│ apps/dashboard (widget entry):   │
│                                         │  channel 1 │  • contextual / global / search  │
│ @8lines/gauntlet-widget (npm):          │            │  • form + run progress (reused)  │
│  • typed commands, queue stub, no UI    │            │  • recent runs (localStorage)    │
└─────────────────────────────────────────┘            └──────────────────────────────────┘
```

### Units

| Unit | Responsibility | Depends on |
| --- | --- | --- |
| `packages/widget-channel` (`@8lines/gauntlet-widget-channel`) | Versioned `postMessage` message types and validators shared by loader and panel. | nothing |
| `packages/widget-loader` | The injected loader: button, iframe, URL matcher, subject merging, command queue, handshake. Builds to one dependency-free IIFE file. | widget-channel |
| `packages/widget` (`@8lines/gauntlet-widget`) | Public npm package: `PageSubject` and `RouteRule` types, typed command functions over `window.Gauntlet`, SSR-safe no-ops. | widget-channel types |
| `apps/dashboard` widget entry | Panel UI in the iframe. Reuses `Formularz`, `Przebieg` and `api.ts`. | protocol, `/api/v1` |
| `packages/protocol` | `placements` schema, profile, semantic rules and fixtures. | — |
| TypeScript, PHP and Java SDKs | Placement declaration in operation builders; summary/definition emission; profile advertisement. | protocol |
| `conformance` | Language-neutral placement cases over HTTP. | protocol fixtures |
| `apps/server` | `/widget/*` routes, widget configuration, framing headers, `placements` pass-through, MCP filter. | protocol, dashboard build |

## Protocol: placements

### Page context (loader ↔ panel only)

```ts
type PageContext = {
  target: string;
  subjects: ReadonlyArray<{
    type: string;                                      // portable ID, e.g. "order"
    values: Readonly<Record<string, string | number | boolean>>;
  }>;
};
```

Subject types are unique within a page context. Page context is not sent to the
control plane or to adapters.

### `placements` field

`placements` is an optional array on `operationSummary` (manifest) and on
`operationDefinition`. It participates in the definition revision.

```json
"placements": [
  { "kind": "global" },
  {
    "kind": "subject",
    "subjectType": "order",
    "bindings": { "/orderId": "orderId", "/customer/id": "customerId" }
  }
]
```

- `kind: "global"`: the operation is listed on every page.
- `kind: "subject"`: the operation is listed when the page context contains a
  subject of `subjectType`.
- `bindings`: optional map from an input JSON Pointer to a key of that subject's
  `values`.
- An operation without `placements` is reachable through search only. This is
  the behavior of every existing operation.

The field is allowed only when the adapter manifest declares the
`gauntlet-page-placements@1` profile. SDKs that predate the profile never emit
it. The CHANGELOG states the minimum control-plane version for SDKs that emit
placements.

### Semantic rules

1. Every `bindings` pointer resolves to a property of `inputSchema` whose type is
   string, number, integer, boolean, or a scalar enum.
2. A binding must not target a field handled as a secret or a file.
3. An operation has at most one `global` placement, and each `subjectType`
   appears at most once.
4. The summary's `placements` equal the definition's `placements`.
5. `subjectType` and binding value keys are portable IDs.

Each rule gets positive and negative fixtures in `packages/protocol/fixtures/v1`
and cases in the conformance suite.

### SDK surface

TypeScript example; PHP and Java expose equivalent builder methods in their
existing idiom:

```ts
defineOperation({
  id: "mark-order-paid",
  placements: [
    subjectPlacement("order", { "/orderId": "orderId" }),
  ],
  // ...
});
```

Registering any placement makes the SDK declare `gauntlet-page-placements@1` in
the manifest. Registration-time validation applies rules 1–5 so errors surface at
application startup, not at discovery.

### MCP

`placements` appears in operation summaries returned by `gauntlet_list_targets`.
The tool accepts an optional `subjectType` filter that limits returned
operations to those placed on that subject. No new tool is added.

## Loader and host API

### Script integration

```html
<script>
  window.Gauntlet ||= function () { (Gauntlet.q ||= []).push(arguments); };
  Gauntlet("boot", {
    target: "shop",
    routes: [
      { pattern: "/orders/:orderId", subject: "order" },
      {
        pattern: "/customers/:customerId/orders/:orderId",
        subjects: { customer: ["customerId"], order: ["orderId"] },
      },
    ],
  });
</script>
<script src="https://gauntlet.internal/widget/loader.js" async></script>
```

The application inserts both tags only in non-production builds, using its own
environment flag, just as it enables its adapter independently.

### Commands

| Command | Effect |
| --- | --- |
| `boot(options)` | Target ID, route rules, optional button position. Required once before other commands take effect. |
| `setSubject(type, values)` | Adds or replaces an explicit subject of `type`. |
| `removeSubject(type)` | Removes the explicit subject of `type`; a URL-derived subject of that type, if any, becomes visible again. |
| `open()` / `close()` | Opens or closes the panel. |
| `shutdown()` | Removes the button, iframe and listeners. |

Commands issued before the loader arrives are queued in `Gauntlet.q` and replayed
in order.

`@8lines/gauntlet-widget` exports the same commands as typed functions that push
to `window.Gauntlet`, installing the queue stub if needed. On the server (no
`window`) they are no-ops. The documentation shows a short React hook that calls
`setSubject` on mount and `removeSubject` on unmount; no framework package ships
in v1.

### Subject derivation

- Route patterns match `location.pathname` segment by segment. `:name` captures
  one decoded segment and `*` matches the rest. The first matching rule wins.
- `subject: "order"` puts all captured parameters into the `order` subject.
  `subjects` maps each subject type to the parameter names it receives.
- The effective page context is the URL-derived subjects overlaid with explicit
  subjects by type.
- The loader recomputes subjects on `popstate` and after wrapped
  `history.pushState` / `history.replaceState` calls, debounced, and sends a
  `context` message only when the result changes.
- The loader never sends the page URL, query string or fragment to the panel.

### Presentation

- The button renders inside a closed Shadow DOM root at a fixed corner and shows
  a badge with the contextual operation count. It sits beneath the open panel,
  which the panel's own close button (or Escape) dismisses.
- After `boot`, the loader creates the iframe hidden on `requestIdleCallback`
  (with a timeout fallback), so the badge works and opening is immediate.
  Panel assets are hashed and cached as immutable.
- The Gauntlet origin is derived from the loader's own `document.currentScript`
  URL; the application does not configure it separately.

## Channel protocol (`channel: 1`)

### Handshake

1. The panel loads, fetches `/widget/config.json` and posts
   `{ channel: 1, type: "gauntlet:ready" }` to `window.parent` with target origin
   `*`. The message carries no data.
2. The loader accepts it only if `event.origin` equals the Gauntlet origin and
   `event.source` is its iframe's `contentWindow`. It then posts
   `{ channel: 1, type: "gauntlet:connect", target }` with a transferred
   `MessagePort`, targeted at the Gauntlet origin.
3. The panel accepts `gauntlet:connect` only from `window.parent` when
   `event.origin` is listed for `target` in its configuration. Otherwise it posts
   a bare `{ channel: 1, type: "gauntlet:rejected" }` and ignores further
   messages.
4. All later messages use the private port.

### Messages

| Direction | Type | Payload |
| --- | --- | --- |
| host → panel | `gauntlet:context` | `PageContext` |
| host → panel | `gauntlet:open` | — |
| panel → host | `gauntlet:state` | `{ contextualCount, globalCount }` |
| panel → host | `gauntlet:close` | — |
| panel → host | `gauntlet:resize` | `{ expanded: boolean }` |
| reserved (v2) | `gauntlet:forms`, `gauntlet:fill-form` | — |

Every message carries `channel: 1` and is validated by `widget-channel`. Unknown
types are ignored with a `console.debug` note, so newer panels do not break
older loaders and vice versa.

## Server

### Configuration

The configuration file (schema v1) gains an optional top-level `widget` object
and an optional per-target `widget` object:

```yaml
widget:
  enabled: true
targets:
  - id: shop
    label: Shop
    adapterUrl: http://shop-dev:8080
    expectedEnvironment: { name: dev, kind: development }
    widget:
      origins: [https://shop.dev.example]
```

- `widget.enabled` defaults to `false`.
- `origins` entries are exact canonical HTTP(S) origins: no wildcards,
  credentials, paths or trailing slash. This matches the existing MCP origin
  rules.
- Invalid values fail startup with a configuration error code.
- The JSON Schema (`gauntlet-config-v1.schema.json`), Compose example and Helm
  values and schema are updated together.

### Routes and headers

| Route | Behavior |
| --- | --- |
| `GET /widget/loader.js` | Loader bundle. `Cross-Origin-Resource-Policy: cross-origin`, `Cache-Control: no-cache`, ETag. |
| `GET /widget/` | Panel HTML. `Content-Security-Policy: frame-ancestors <union of configured origins>`. |
| `GET /widget/config.json` | `{ targets: { [targetId]: string[] } }` for targets with origins. `no-cache`. |
| `GET /widget/assets/*` | Hashed panel assets, immutable caching. |
| Dashboard HTML (`/` and SPA fallback) | New: `Content-Security-Policy: frame-ancestors 'none'`. |
| `/api/v1`, `/mcp` | Unchanged. No CORS is added. |

When `widget.enabled` is not `true`, every `/widget/*` route returns 404. The
`/widget` prefix joins `/api`, `/mcp`, `/health` and `/ready` as a reserved path
excluded from the dashboard SPA fallback.

The product image build emits the loader and panel alongside the dashboard.

## Panel UI

A right-hand drawer about 400 px wide and full viewport height, expanding to a
wider layout for rich results.

- **Header:** target label, environment badge and search field, and a close
  button (and Escape) that sends `gauntlet:close`; the open panel covers the
  launcher button, so this is the only way to close it.
- **On this page:** operations whose subject placements match the page context,
  with chips showing the subject values used (for example `Order 123`).
- **Global:** operations with a global placement.
- **Search results:** replace both lists while a query is entered; match label,
  description and tags across the target catalog.
- **Operation view:** the dashboard form with prefill, then confirmation, then
  run progress and results. Browser-launch artifacts open in a new tab.
- **Recent:** up to 20 runs started from the widget, stored in the iframe's
  `localStorage` (partitioned per top-level site by modern browsers, so each
  application keeps its own list). Each entry holds target, operation, label,
  run ID and start time.
- Every operation and run links to the same view in the full dashboard.

### Prefill order

1. Schema defaults.
2. Selected preset initial values.
3. Placement bindings from the page context.

Locked preset pointers are never overwritten. When a binding targets a locked
pointer, it is skipped and the form shows a short note. A value whose key is
missing from the subject leaves the field unchanged. Bound values remain
editable.

## Error handling

| Situation | Behavior |
| --- | --- |
| Gauntlet unreachable | No `gauntlet:ready` within 10 s: the button is greyed out with the tooltip "Cannot reach Gauntlet"; the host element carries `data-gauntlet-reason="unreachable"`. |
| Origin not configured for target, or unknown `target` at `boot` | Panel sends `gauntlet:rejected` (the panel's origin policy lists only configured targets that declare origins); the loader logs a `console.warn` naming the origin and target to add to the configuration and greys out the button with the tooltip "Gauntlet rejected this page (origin or target) — see the browser console"; the host element carries `data-gauntlet-reason="rejected"`. The panel keeps a defensive configuration error state for an unknown target it was connected to. |
| Target offline or stale manifest | Same as the dashboard: operations visible, invocation blocked. |
| Bound value fails input validation | The standard form validation error is shown; no run is created. |
| Run projection missing after restart | The recent-run entry shows "Unavailable after Gauntlet restart". |
| `boot` called twice | The second call is ignored with a `console.warn`. |

## Testing

- **Protocol:** schema and semantic fixtures for every placement rule, including
  revision changes when placements change.
- **SDKs:** registration validation and manifest/definition emission in
  TypeScript, PHP and Java; conformance cases over HTTP.
- **widget-channel:** validators accept every v1 message and reject malformed or
  foreign ones.
- **Loader:** route matching, subject overlay and removal, change-only context
  emission, command queue replay, handshake origin/source checks.
- **Panel:** matching of placements to page context, prefill order with locked
  presets, recent-run storage.
- **Server:** configuration parsing and errors, 404 when disabled, framing
  headers on `/widget/` and dashboard HTML, `config.json` content, reserved
  paths, MCP `subjectType` filter.
- **End to end (Playwright):** a host page served from a second origin embeds
  the loader. It verifies a contextual operation with prefill, a completed run,
  context updates on SPA navigation, the recent-run list after reload, and
  rejection from an unlisted origin.
- **Local demo:** gains a host page with the widget enabled.

## Documentation

- New guide `docs/integrations/widget.md`: script and npm integration, route
  rules, `setSubject`, production gating, troubleshooting.
- `docs/extensions/authoring.md`: declaring placements.
- `docs/reference/control-plane-api.md`, `docs/architecture.md`, `docs/mcp.md`,
  server and deployment configuration references.
- CHANGELOG: new profile, minimum versions, and the new dashboard
  `frame-ancestors 'none'` header.

## Future work

- **v2: host-page form fill.** Applications register forms through the npm
  package (`registerForm(id, { fields, fill })`). An operation result carries a
  typed `form-fill` artifact naming a form ID and values; the panel offers
  "Fill form", and the loader calls the application's `fill` handler, falling
  back to filling DOM inputs by `name` when no handler is given. Registered
  forms also become page subjects. It gets its own specification.
- Operations from other targets.
- Recording the originating page in `invocationContext.extensions` for audit.
- Aligning existing `tc-*` profile IDs with the `gauntlet-*` prefix.
