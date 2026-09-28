# Widget Phase 4: Panel, Product Image, End-to-End Tests and Documentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The widget works end to end. The panel UI runs in the Gauntlet-served iframe and lists contextual and global operations, catalog search and recent runs. It prefills inputs from page subjects and runs operations through the existing dashboard form and run views. The product image ships the loader and panel. A Playwright suite proves the whole flow across two origins, and users get an integration guide.

**Architecture:**
- The panel is a second Vite build in `apps/dashboard` (`vite.widget.config.ts`, root `apps/dashboard/widget/`, `base: "/widget/"`). It outputs `apps/dashboard/dist-widget/` with `index.html` and `assets/`, and a build plugin copies `packages/widget-loader/dist/loader.js` in as `loader.js`. That directory is exactly the `GAUNTLET_WIDGET_DIR` layout phase 2 serves.
- Panel logic that can be tested without a DOM lives in `apps/dashboard/src/widget/*.ts`: placement matching, search, prefill, recent-run storage, and the panel side of the handshake. It has Node tests. React components live in `apps/dashboard/src/widget/*.tsx` and reuse `WidokOperacji`, `Formularz`, `Przebieg` and `api.ts`.
- `WidokOperacji` gains two optional props, `bindings` and `onRunCreated`. The dashboard does not pass them, so its behaviour is unchanged.
- The image build assembles `/app/widget` and sets `GAUNTLET_WIDGET_DIR=/app/widget`. The widget stays disabled until the configuration enables it.

**Tech Stack:** React 19, Vite 8, Tailwind 4, TypeScript 7, `node:test` via `tsx`, Playwright 1.55.1, Fastify server from `apps/server/dist`, example adapter from `examples/node-adapter/dist`, Docker.

**Spec:** `docs/superpowers/specs/2026-09-25-embeddable-widget-design.md` (sections *Panel UI*, *Prefill order*, *Error handling*, *Server → Routes*, *Testing* → Panel/End to end/Local demo, *Documentation*).

## Global Constraints

- Product name is **Gauntlet**. Panel UI copy is Polish, matching the dashboard (existing components already are). The loader's host-page texts from phase 3 stay as they are.
- Channel: use `@8lines/gauntlet-widget-channel` for every message (`parseHandshakeMessage`, `parseHostMessage`, the `PanelMessage` shape). The panel posts `{ channel: 1, type: "gauntlet:ready" }` to `window.parent` with `"*"` after loading `/widget/config.json`.
  - It accepts `gauntlet:connect` only when `event.source === window.parent`, `event.origin` is listed in `config.targets[data.target]`, and `event.ports.length === 1`.
  - Otherwise it posts `{ channel: 1, type: "gauntlet:rejected" }` to `window.parent` with `"*"` and ignores all later window messages.
  - After a connect it uses only the port.
- `config.json` shape (phase 2): `{ targets: { [targetId]: string[] } }`.
- Placement matching: an operation summary is contextual when one of its `placements` is `{ kind: "subject", subjectType }` and the page context has a subject of that type. Global: it has `{ kind: "global" }`. An operation can be both; it is listed under contextual only. Operations whose `availability.state !== "available"` are listed but visibly disabled (same as the dashboard search).
- Search: case-insensitive (`toLocaleLowerCase("pl")`) substring match on `label`, `description` and `tags` over the target's whole catalog. A non-empty query replaces both lists.
- Prefill order: schema defaults (`wartosciPoczatkowe`), then the selected preset's `input`, then placement bindings of the matched subject.
  - Bindings never overwrite `lockedPointers`. A skipped binding produces a note: "Pole {pointer} jest zablokowane przez zestaw — pominięto wartość ze strony."
  - A binding whose value key is missing from the subject leaves the field unchanged.
  - Bound values stay editable.
  - When a preset is (re)applied, bindings are re-applied on top.
- Coercion: when the bound leaf schema has `type: "integer"` or `type: "number"` and the value is a string that parses exactly (`/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/`, and integer-only for `integer`), the value becomes a number. When the leaf has `type: "boolean"` and the value is `"true"` or `"false"`, it becomes a boolean. Otherwise the value is used as is, and adapter validation reports mismatches through the standard form errors.
- Recent runs:
  - storage: `localStorage` key `gauntlet.widget.recent.v1`, at most 20 entries, newest first, de-duplicated by `targetId`+`runId`;
  - entry shape: `{ targetId, operationId, label, runId, startedAt }` (ISO string);
  - malformed storage content is treated as empty and overwritten on the next write;
  - a recent run whose `GET …/runs/{id}` returns 404 shows "Niedostępne po restarcie Gauntlet".
- Dashboard links: every operation and run offers "Otwórz w Gauntlet" (`target="_blank" rel="noopener"`) pointing to `sciezka({ targetId, operacjaId })` from `apps/dashboard/src/trasa.ts`. The dashboard has no run route, so run links point to their operation.
- Panel → host messages:
  - `gauntlet:state { contextualCount, globalCount }` whenever the catalog or context changes;
  - `gauntlet:close` from the panel's close button;
  - `gauntlet:resize { expanded: true }` while a run result is shown, `false` otherwise.
- Closing: the open panel iframe sits above the loader's launcher button (phase 3 layering), so the panel header must always render a close button (`aria-label="Zamknij"`) and handle `Escape`, both posting `gauntlet:close`. This is the only way to close the drawer while it is open.
- States:
  - panel opened outside an iframe or before connect → "Otwórz Gauntlet przez widget w aplikacji";
  - unknown target (not in `GET /api/v1/targets`) → configuration error "Nieznany target {id}";
  - target offline or stale → operations visible, and invocation is blocked exactly as in the dashboard (reuse `WidokOperacji`, which already surfaces problems).
- Panel HTML is served only at `/widget/`. Vite must not put any `.html` into `dist-widget/assets/`.
- Commit after each task with a Conventional Commit message ending with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

- A binding targeting a field that the chosen preset locks must keep the preset value after switching presets back and forth. Pinned in Task 1 (pure) and Task 5 (browser).
- A `gauntlet:connect` arriving from a window other than `window.parent` (for example a sibling frame) must be ignored without sending `rejected`, and must not stop the real parent from connecting. Pinned in Task 1.
- A corrupted or foreign `localStorage` value under the recent-runs key must not crash the panel. Pinned in Task 1.
- The dashboard's operation view must behave exactly as before when `bindings`/`onRunCreated` are absent (existing dashboard e2e stays green). Pinned in Task 2.
- The image must still start with the widget disabled and no origins configured (the default Compose/Helm configuration). Pinned in Task 3.

---

### Task 1: Panel logic modules (pure, Node-tested)

**Files:**
- Modify: `apps/dashboard/package.json` (dependency `"@8lines/gauntlet-widget-channel": "workspace:*"`), `pnpm-lock.yaml`
- Create: `apps/dashboard/src/widget/placements.ts`, `src/widget/search.ts`, `src/widget/prefill.ts`, `src/widget/recent-runs.ts`, `src/widget/handshake.ts`
- Test: `apps/dashboard/test/widget-placements.test.ts`, `widget-search.test.ts`, `widget-prefill.test.ts`, `widget-recent-runs.test.ts`, `widget-handshake.test.ts`

**Interfaces:**
- Consumes: `OperationSummary`, `OperationPlacement`, `OperationDefinition`, `JsonPointer` from `@8lines/gauntlet-protocol`; `PageContext`, `PageSubject`, `parseHandshakeMessage` from `@8lines/gauntlet-widget-channel`; `odczytaj`/`zapisz` from `apps/dashboard/src/wskazniki.ts`.
- Produces:
  ```ts
  // placements.ts
  export interface ContextualOperation { readonly operation: OperationSummary; readonly subject: PageSubject }
  export interface PanelLists { readonly contextual: readonly ContextualOperation[]; readonly global: readonly OperationSummary[] }
  export function panelLists(operations: readonly OperationSummary[], context: PageContext | undefined): PanelLists;
  export function subjectChip(subject: PageSubject): string; // e.g. "order 123" → values joined by ", " after the type
  // search.ts
  export function searchOperations(operations: readonly OperationSummary[], query: string): readonly OperationSummary[];
  // prefill.ts
  export interface BindingValue { readonly pointer: JsonPointer; readonly value: string | number | boolean }
  export function bindingValues(placementBindings: Readonly<Record<string, string>> | undefined, subject: PageSubject): readonly BindingValue[];
  export interface PrefillResult { readonly values: Record<string, unknown>; readonly skipped: readonly JsonPointer[] }
  export function applyBindings(
    base: Record<string, unknown>, inputSchema: unknown, bindings: readonly BindingValue[], locked: readonly JsonPointer[],
  ): PrefillResult;
  // recent-runs.ts
  export interface RecentRun { readonly targetId: string; readonly operationId: string; readonly label: string; readonly runId: string; readonly startedAt: string }
  export const RECENT_RUNS_KEY = "gauntlet.widget.recent.v1";
  export const MAX_RECENT_RUNS = 20;
  export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }
  export function readRecentRuns(storage: StorageLike): readonly RecentRun[];
  export function rememberRun(storage: StorageLike, run: RecentRun): readonly RecentRun[];
  // handshake.ts (panel side)
  export interface WidgetConfig { readonly targets: Readonly<Record<string, readonly string[]>> }
  export function parseWidgetConfig(value: unknown): WidgetConfig | undefined;
  export interface ConnectEventLike { readonly origin: string; readonly source: unknown; readonly data: unknown; readonly ports: readonly unknown[] }
  export type ConnectDecision =
    | { readonly kind: "connect"; readonly target: string; readonly port: unknown }
    | { readonly kind: "reject" }
    | { readonly kind: "ignore" };
  export function decideConnect(event: ConnectEventLike, parent: unknown, config: WidgetConfig): ConnectDecision;
  ```
  Rules for `decideConnect`:
  - `ignore` when `event.source !== parent` or the data does not parse as `gauntlet:connect`.
  - `reject` when the target is not in the config, the origin is not listed for it, or `ports.length !== 1`.
  - Otherwise `connect`.

- [ ] **Step 1: Write failing tests** (one file per module). Minimum cases:
  - placements:
    - a subject-placed operation matches only when the context has that subject type;
    - a global-only operation lands in `global`;
    - an operation with both global and subject placements, on a matching page, is contextual only; on a non-matching page it is global;
    - operations without placements are in neither list;
    - an undefined context yields no contextual entries;
    - `subjectChip({ type: "order", values: { orderId: "123" } }) === "order 123"`.
  - search: label, description and tag matches; case-insensitive with Polish letters (`"ŁÓDŹ"` matches `"łódź"`); an empty or whitespace query returns `[]`.
  - prefill:
    - `bindingValues` maps pointer → subject value and drops missing keys;
    - `applyBindings` writes nested pointers (`/customer/id`) without clobbering sibling fields;
    - it skips locked pointers and reports them in `skipped`;
    - it coerces `"123"` → `123` for an integer leaf, keeps `"12.5"` as a string for an integer leaf, coerces `"12.5"` → `12.5` for a number leaf, `"true"` → `true` for a boolean leaf, and keeps `"abc"` as a string for an integer leaf;
    - it does not mutate `base`.
  - recent runs:
    - newest first;
    - duplicate `targetId`+`runId` moves to the top;
    - trimmed to 20;
    - malformed JSON, a non-array, and arrays with bad entries read as `[]` (bad entries dropped, good kept);
    - `setItem` throwing (quota) does not throw out of `rememberRun`.
  - handshake:
    - `parseWidgetConfig` accepts the phase-2 shape and rejects anything else;
    - `decideConnect` returns connect for a listed origin from the parent with one port;
    - it returns reject for an unlisted origin, an unknown target, and zero or two ports;
    - it returns ignore for another source, foreign data, and `gauntlet:ready`.

- [ ] **Step 2: Run to verify failure**, `pnpm --filter @8lines/gauntlet-dashboard test`.
- [ ] **Step 3: Implement** following the Global Constraints. The leaf schema for coercion is found by walking `properties` along the pointer segments (unescape `~1` → `/`, `~0` → `~`). No `$ref` resolution is needed: phase 1 placement rules forbid combinators and `$ref` along binding paths.
- [ ] **Step 4: Run tests and `pnpm --filter @8lines/gauntlet-dashboard typecheck`.** Expected: PASS.
- [ ] **Step 5: Commit**, `feat(dashboard): add widget panel placement, prefill, search and recent-run logic`.

---

### Task 2: Panel app, widget build and `WidokOperacji` extension

**Files:**
- Modify: `apps/dashboard/src/WidokOperacji.tsx` (optional props `bindings?: readonly BindingValue[]`, `onRunCreated?: (run: Run) => void`, note for skipped bindings)
- Create: `apps/dashboard/widget/index.html`, `apps/dashboard/vite.widget.config.ts`, `apps/dashboard/src/widget/main.tsx`, `src/widget/Panel.tsx`, `src/widget/usePanelChannel.ts`, other small components under `src/widget/` as needed
- Modify: `apps/dashboard/package.json` (`build` script builds both apps; devDependency `"@8lines/gauntlet-widget-loader": "workspace:*"` so the loader builds first; `dev:widget` script), `apps/dashboard/tsconfig.json` if `widget/` or the new config must be included, `.gitignore` (`apps/dashboard/dist-widget/` if `dist/` is ignored by a pattern that does not cover it)

**Interfaces:**
- Consumes: Task 1 modules; `api` (`api.targety`, `api.operacja`, `api.przebieg`), `WidokOperacji`, `Przebieg`, `sciezka`; `@8lines/gauntlet-widget-channel`.
- Produces: `apps/dashboard/dist-widget/{index.html, assets/*, loader.js}` from `pnpm --filter @8lines/gauntlet-dashboard build`; `WidokOperacji` props above.

- [ ] **Step 1: `WidokOperacji` bindings**
  - On definition load, when `bindings` is present: values = `applyBindings(initialInput ?? wartosciPoczatkowe(schema), schema, bindings, [])`.
  - In `zastosujPreset`: values = `applyBindings({ ...defaults, ...preset.input }, schema, bindings, preset.lockedPointers ?? [])`, and store `skipped`.
  - Render one muted note per skipped pointer inside the "Dane wejściowe" card.
  - Call `onRunCreated?.(run)` after a successful `api.uruchom`.
  - With neither prop the rendered output and behaviour are unchanged. Run `pnpm dashboard:test:e2e` to prove it.
- [ ] **Step 2: Widget build**

  `vite.widget.config.ts`:
  - `root` is the absolute path of `apps/dashboard/widget`, `base: "/widget/"`, and `plugins: [react(), tailwindcss(), copyLoader()]`;
  - `build: { outDir: <abs apps/dashboard/dist-widget>, emptyOutDir: true }`;
  - `server.port: 5274` with the same `/api` proxy as the dashboard config.

  `copyLoader()` is a local plugin whose `closeBundle` copies `packages/widget-loader/dist/loader.js` into the outDir as `loader.js`. It throws a clear error when the source is missing: "Build @8lines/gauntlet-widget-loader first".

  `widget/index.html` mirrors `apps/dashboard/index.html` (`lang="pl"`, robots noindex, title "Gauntlet") and loads `../src/widget/main.tsx`. `main.tsx` imports `../index.css` and applies the stored dashboard settings, exactly like `src/main.tsx`.

  Verify that Tailwind picks up classes used only in `src/widget/*.tsx`: after building, grep the emitted CSS for one panel-only class. If it is missing, add an `@source` directive in a widget CSS entry.

  `package.json` `build`: `tsc -p tsconfig.json --noEmit && vite build && vite build -c vite.widget.config.ts`.
- [ ] **Step 3: Panel components**
  - `usePanelChannel()`:
    1. fetches `/widget/config.json`;
    2. if `window.parent === window`, returns state `standalone`;
    3. installs a window `message` listener using `decideConnect(event, window.parent, config)`, then posts `ready`;
    4. on `connect`, stores the port and target and parses port messages with `parseHostMessage`: `context` sets the page context, `open` focuses the search field, `unknown` goes to `console.debug`;
    5. on `reject`, posts `rejected` and sets state `rejected`;
    6. exposes `sendState(counts)`, `close()` and `setExpanded(boolean)`.
  - `Panel`:
    - Header: target label from `api.targety()`, the environment badge from the manifest environment (name and kind), the search input, and a close button (`aria-label="Zamknij"`).
    - Body, in order: "Na tej stronie" (contextual, each with a subject chip), "Globalne", "Ostatnie" (recent runs), or search results while a query is non-empty. Each row has the operation label, description, and an "Otwórz w Gauntlet" link.
    - Operation view: back button plus `<WidokOperacji targetId operacjaId bindings onRunCreated>`. `onRunCreated` calls `rememberRun`, then calls `setExpanded(true)` so the run shows full-width.
    - Recent-run view: fetches `api.przebieg`, renders `<Przebieg>` or the 404 message.
    - `sendState` after every change of lists or context.
    - The states from Global Constraints.
  - Keep each component file focused. `Panel.tsx` owns layout and navigation state only.
- [ ] **Step 4: Verify**: `pnpm --filter @8lines/gauntlet-widget-loader build && pnpm --filter @8lines/gauntlet-dashboard build`, then:
  - `dist-widget/index.html` references only `/widget/assets/*-<hash>.{js,css}`;
  - `dist-widget/loader.js` exists;
  - no `.html` under `dist-widget/assets/`;
  - `pnpm --filter @8lines/gauntlet-dashboard test` and `typecheck` pass;
  - `pnpm dashboard:test:e2e` is green.

  Also start the server locally against the built directory and load `/widget/` in a browser to check it renders the standalone state; use `apps/dashboard/scripts/lokalny-stos.mjs` once Task 3 fixes it, or a throwaway command.
- [ ] **Step 5: Commit**, `feat(dashboard): add widget panel entry built into dist-widget`.

---

### Task 3: Product image and local demo

**Files:**
- Modify: `Dockerfile`, `.dockerignore`, `scripts/verify-product-image.mjs`, `docker-bake.hcl` only if it lists build inputs, `apps/dashboard/scripts/lokalny-stos.mjs`
- Create: `apps/dashboard/scripts/strona-demo.html` (host page for the local demo)

**Interfaces:**
- Consumes: `dist-widget/` from Task 2; phase 2 `GAUNTLET_WIDGET_DIR`; `createApp({ environment, targets, widget, dashboardDir })`.
- Produces: an image with `/app/widget/{index.html, loader.js, assets/}` and `ENV GAUNTLET_WIDGET_DIR=/app/widget`.

- [ ] **Step 1: Failing verification first.** Extend `scripts/verify-product-image.mjs`:
  - the image env includes `GAUNTLET_WIDGET_DIR=/app/widget`;
  - `/app/widget/index.html` and `/app/widget/loader.js` are regular files;
  - the panel HTML references `/widget/assets/<hashed>.{js,css}` that exist under `/app/widget/assets`;
  - no source maps;
  - the build-context allowlist includes the new package paths;
  - a container started with the default smoke configuration (widget disabled) answers `/ready` and returns 404 for `/widget/loader.js`;
  - a container started with a configuration enabling the widget and one origin serves `/widget/loader.js` with `cross-origin-resource-policy: cross-origin`.

  Follow the script's existing container-start helpers.
- [ ] **Step 2: Dockerfile**
  - Copy `packages/widget-channel` and `packages/widget-loader` (package.json early for the install layer, sources later); the install and build filters already follow the dashboard's workspace dependencies.
  - Copy `apps/dashboard/widget` and `apps/dashboard/vite.widget.config.ts`.
  - Extend the in-build verification heredoc to check `dist-widget` like `dist`.
  - `chmod` it, `COPY --from=build /app/apps/dashboard/dist-widget ./widget`, and `ENV GAUNTLET_WIDGET_DIR=/app/widget`.
  - Update `.dockerignore` allowlist entries to match.
- [ ] **Step 3: Local demo**

  Fix `apps/dashboard/scripts/lokalny-stos.mjs` so it runs again. `createApp` requires `environment`, and targets require `expectedEnvironment`; the example adapter's environment is `{ name: "typescript-fixture-test", kind: "test" }`. The script:
  - starts the example adapter;
  - starts the control plane on `127.0.0.1:8080` with `dashboardDir: apps/dashboard/dist`, `widget: { enabled: true, dir: apps/dashboard/dist-widget }` and target `przyklad` with `widget.origins: ["http://127.0.0.1:5180"]`;
  - serves `strona-demo.html` on `127.0.0.1:5180` for every path.

  The demo page contains:
  - the stub snippet;
  - `Gauntlet("boot", { target: "przyklad", routes: [{ pattern: "/wnioski/:applicationId", subject: "agency-application" }] })`;
  - links that `pushState` between `/wnioski/11111111-1111-4111-8111-111111111111` and `/wnioski/22222222-2222-4222-8222-222222222222` (the example fixture's `applications`);
  - `<script src="http://127.0.0.1:8080/widget/loader.js" async>`.

  Print both URLs. Keep the script's Polish comments style.
- [ ] **Step 4: Verify**: `pnpm test:image` (Docker). Run the demo manually once: `pnpm build && node apps/dashboard/scripts/lokalny-stos.mjs`, open the demo page, and confirm the badge appears. Report what you saw.
- [ ] **Step 5: Commit**, `build(image): ship the widget loader and panel; add local widget demo`.

---

### Task 4: End-to-end widget suite

**Files:**
- Create: `apps/dashboard/e2e-widget/stack.mjs`, `apps/dashboard/e2e-widget/widget.spec.ts`, `apps/dashboard/playwright.widget.config.ts`
- Modify: root `package.json` (`"widget:test:e2e:panel": "pnpm --filter @8lines/gauntlet-dashboard exec playwright test -c playwright.widget.config.ts --reporter=line"`)

**Interfaces:**
- Consumes: built `apps/server/dist`, `examples/node-adapter/dist`, `apps/dashboard/dist-widget`; example operation `agency-applications.finalize`, placed on subject `agency-application` with binding `/applicationId → applicationId`. It is `confirmationRequired: true`, has a secret `confirmationCode` matching `^[0-9]{6}$`, and its data source `pending-applications` has the fixture's `applications`.

- [ ] **Step 1: Stack.** `stack.mjs` starts:
  - the example adapter;
  - the control plane on `localhost:4411` (`environment` equal to the adapter's), with target `shop` (`widget.origins: ["http://127.0.0.1:4410"]`) and the widget enabled from `dist-widget`;
  - a host server on `127.0.0.1:4410`;
  - the same host page on `127.0.0.1:4412` (unlisted).

  The host page boots `target: "shop"` with route `/applications/:applicationId` → subject `agency-application` and loads `http://localhost:4411/widget/loader.js`. `playwright.widget.config.ts` uses it as `webServer` (url `http://localhost:4411/ready`), with a single Chromium project and `outputDir` under `node_modules/.cache/gauntlet-dashboard/playwright-widget`.
- [ ] **Step 2: Scenarios** (`widget.spec.ts`). Use `page.frameLocator("iframe[data-gauntlet-panel]")` for the panel.
  1. On `/applications/11111111-1111-4111-8111-111111111111`, the badge (`[data-gauntlet-widget][data-gauntlet-count="2"]`; both `agency-applications.finalize` and `.fail` are placed on the subject) appears. Opening the panel (click the host element's centre) shows "Finalize agency application" under "Na tej stronie" with the chip `agency-application 11111111-1111-4111-8111-111111111111`.
  2. Opening that operation shows `applicationId` prefilled with `11111111-1111-4111-8111-111111111111`. Entering `confirmationCode` `123456`, running and confirming completes the run with the success result.
  3. `history.pushState` to `/applications/22222222-2222-4222-8222-222222222222` (triggered in the host page) updates the chip to the other ID without reloading the panel.
  4. After `page.reload()` and reopening, "Ostatnie" lists the run. Opening it shows the completed result.
  5. The same page on `127.0.0.1:4412` ends with `data-gauntlet-state="unavailable"`, and the panel never lists operations.
  6. Loading `http://localhost:4411/widget/` in a top-level page shows the standalone message. Fetching it with `page.request` returns `content-security-policy: frame-ancestors http://127.0.0.1:4410`, and `/` returns `frame-ancestors 'none'`.
- [ ] **Step 3: Run**: `pnpm build && pnpm widget:test:e2e:panel`. Expected: PASS twice in a row (flakiness check).
- [ ] **Step 4: Commit**, `test(dashboard): cover the widget end to end across two origins`.

---

### Task 5: Documentation

**Files:**
- Create: `docs/integrations/widget.md`
- Modify: `docs/integrations/index.md`, `docs/architecture.md`, `docs/documentation-manifest.json` (if the docs checker requires registering new pages), `docs/extensions/authoring.md` (link from the placements section to the guide), `apps/dashboard/README.md` (panel build, `dist-widget`, `dev:widget`, e2e command), `CHANGELOG.md` (`### Added`: the panel in the image and the local demo)

- [ ] **Step 1: Guide `docs/integrations/widget.md`**
  1. What the widget is.
  2. Enabling it in the Gauntlet configuration (`widget.enabled`, `targets[].widget.origins`, exact-origin rules, image default `GAUNTLET_WIDGET_DIR`).
  3. Script integration: snippet, route rules with both forms, `setSubject`/`removeSubject`, `open`/`close`/`shutdown`, position.
  4. npm integration: `loadGauntletWidget`, typed commands, React hook example.
  5. Declaring placements (short, link to authoring).
  6. Production gating.
  7. Troubleshooting table: "Cannot reach Gauntlet", rejected origin warning, unknown target, operation not listed (missing placement or subject type mismatch), bound value rejected.
  8. Security notes: framing policy, no URL is sent, no CORS, private network boundary unchanged.
- [ ] **Step 2: Other docs** as listed. `docs/architecture.md` gets a short "Embeddable widget" subsection with the unit table from the spec, adapted to what was built.
- [ ] **Step 3: Verify**: `pnpm docs:check && pnpm docs:verify-commands`. Expected: PASS.
- [ ] **Step 4: Commit**, `docs: add the embeddable widget integration guide`.

---

## Out of scope for this phase

- v2 host-page form fill (`registerForm`, `form-fill` artifact): it needs its own spec.
- Operations from other targets, audit of the originating page.
