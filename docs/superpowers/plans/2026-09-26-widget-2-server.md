# Widget Phase 2: Server Configuration, `/widget/*` Routes and Framing Headers

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The control plane reads an optional `widget` configuration (global switch plus per-target allowed origins), serves the widget loader, panel HTML, panel assets and `config.json` under `/widget/*` with the framing and caching headers from the spec, returns 404 for every `/widget/*` path when the widget is disabled, and forbids framing the dashboard.

**Architecture:** Configuration is parsed in `apps/server/src/config.ts` (top-level `widget`) and `apps/server/src/static-target-provider.ts` (per-target `widget.origins`), mirrored in the shared JSON Schema, its Compose copy and the Helm values schema. A new module `apps/server/src/widget.ts` registers the widget routes from a prebuilt widget directory (`GAUNTLET_WIDGET_DIR`) whose layout is fixed: `index.html`, `loader.js`, optional `assets/`. Phases 3 and 4 produce that directory; this phase only defines and serves it. `/widget` becomes a reserved prefix next to `/api`, `/mcp`, `/health`, `/ready`.

**Tech Stack:** TypeScript (Node 24, `node:test` via `tsx`), Fastify 5, `@fastify/static` 10, Ajv 2020 (schema tests), Helm 4 (via Docker in `deploy/helm` tests), pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-09-25-embeddable-widget-design.md` (section *Server*; *Success criteria* last bullet; *Testing* → Server).

## Global Constraints

- Product name is **Gauntlet**. New identifiers use `gauntlet`/`widget` naming; never `tc-` or "Test Center".
- Configuration shape (schema v1, both keys optional):
  ```yaml
  widget:
    enabled: true          # boolean, defaults to false
  targets:
    - id: shop
      # ...existing target keys...
      widget:
        origins: [https://shop.dev.example]
  ```
- `widget` (top level) has only the optional key `enabled` (boolean). Target `widget` has only the required key `origins`: a non-empty array of unique exact canonical HTTP(S) origins. Canonical means `new URL(value).origin === value` and protocol `http:`/`https:` — no wildcards, credentials, path, query, fragment, trailing slash, uppercase host or default port. This is the same rule as `validateMcpOptions` in `apps/server/src/mcp.ts`.
- Any invalid `widget` value fails startup with `GauntletConfigurationError` code `invalid-document` (the existing generic code) and never echoes the value.
- `ServerConfiguration` always contains `widget: { enabled: boolean }` (frozen; `{ enabled: false }` when omitted).
- Widget directory: environment variable `GAUNTLET_WIDGET_DIR`; layout `index.html` (regular file), `loader.js` (regular file), `assets/` (optional directory). When `widget.enabled` is `true` and the directory is missing or lacks either file, startup fails with `TypeError("Widget files are missing")` (no path in the message). When the widget is disabled the directory is never read.
- Routes (only registered when `widget.enabled === true`; `GET` only):
  | Route | Headers |
  | --- | --- |
  | `GET /widget/loader.js` | `content-type: text/javascript; charset=utf-8`, `cross-origin-resource-policy: cross-origin`, `cache-control: no-cache`, `x-content-type-options: nosniff`, strong `etag`; `304` on matching `if-none-match` |
  | `GET /widget/` | `content-type: text/html; charset=utf-8`, `content-security-policy: frame-ancestors <origins>`, `cache-control: no-cache`, strong `etag`; `304` on matching `if-none-match` |
  | `GET /widget/config.json` | `application/json; charset=utf-8`, `cache-control: no-cache`, body `{ "targets": { "<targetId>": ["<origin>", …] } }` for targets with origins, in configuration order |
  | `GET /widget/assets/*` | Files from `<dir>/assets`. `public, max-age=31536000, immutable` for Vite-hashed names (same regex as the dashboard), `no-cache` otherwise |
- `<origins>` in the panel CSP is the space-separated, sorted, de-duplicated union of all configured target origins, or `'none'` when there are none.
- Dashboard HTML (every `.html` served by the dashboard static handler and the SPA fallback) gets `content-security-policy: frame-ancestors 'none'`, whether or not the widget is enabled.
- When the widget is disabled, every `/widget` and `/widget/*` request returns the existing `route-not-found` problem (404), never the SPA or a dashboard file. `/widget` is excluded from the dashboard static handler and from the SPA fallback in both modes.
- `/api/v1` and `/mcp` responses are unchanged; no CORS headers are added anywhere.
- `index.html` and `loader.js` are read once at startup (replacing them needs a restart, like the dashboard image).
- Commit after each task with a Conventional Commit message ending with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

- An origin written with a trailing slash, uppercase host or default port (`https://shop.dev.example/`, `https://Shop.dev.example`, `https://shop.dev.example:443`) must fail startup, not be silently normalized into a different CSP entry — pinned in Task 1.
- A dashboard build directory that happens to contain `widget/…` files must never serve them, with the widget enabled or disabled — pinned in Task 2.
- `POST /widget/loader.js` and other non-GET methods on enabled widget routes must return a problem 404/405 and never the SPA — pinned in Task 3.
- A conditional request with a stale or malformed `if-none-match` must return the full `200` body, and only an exact ETag match returns `304` — pinned in Task 3.
- Two targets listing the same origin must produce that origin once in the panel CSP while `config.json` keeps it under both targets — pinned in Task 3.

---

### Task 1: Widget configuration contract

**Files:**
- Modify: `apps/server/src/config.ts` (parse top-level `widget`; `ServerConfiguration.widget`)
- Modify: `apps/server/src/static-target-provider.ts` (`TARGET_KEYS`, `StaticTargetConfig.widget`, origin validation)
- Modify: `config/gauntlet-config-v1.schema.json` and `deploy/compose/gauntlet-config-v1.schema.json` (must stay byte-identical)
- Modify: `config/fixtures/config.valid.yaml`, `config/fixtures/config.valid.json` (add widget)
- Create: `config/fixtures/config.widget-origin.invalid.yaml`
- Modify: `deploy/helm/gauntlet/values.schema.json` (`config.widget`, `definitions.target.widget`, new definitions)
- Modify: `deploy/helm/test-values-schema.mjs` (parity list + widget cases)
- Modify: `config/README.md`, `deploy/helm/README.md` (document `widget`)
- Test: `apps/server/test/config.test.ts`, `apps/server/test/config-schema.test.ts`, `apps/server/test/static-target-provider.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // apps/server/src/config.ts
  export interface WidgetConfiguration { readonly enabled: boolean }
  export interface ServerConfiguration {
    readonly version: 1;
    readonly instance: GauntletInstanceConfiguration;
    readonly widget: WidgetConfiguration;          // new, always present, frozen
    readonly targets: readonly StaticTargetConfig[];
  }
  // apps/server/src/static-target-provider.ts
  export interface StaticTargetWidgetConfig { readonly origins: readonly string[] }   // frozen
  export interface StaticTargetConfig { /* existing */ readonly widget?: StaticTargetWidgetConfig }
  export function isCanonicalWebOrigin(value: unknown): value is string;
  ```

- [ ] **Step 1: Write failing runtime tests**

In `apps/server/test/static-target-provider.test.ts` add:

```ts
test("target widget origins are exact canonical HTTP(S) origins", () => {
  const base = {
    id: "shop",
    label: "Shop",
    adapterUrl: "http://shop:8080",
    expectedEnvironment: { name: "dev", kind: "development" },
  };
  const [target] = validateStaticTargets([{
    ...base,
    widget: { origins: ["https://shop.dev.example", "http://localhost:5173", "http://[fd00::12]:8080"] },
  }]);
  assert.deepEqual(target?.widget, {
    origins: ["https://shop.dev.example", "http://localhost:5173", "http://[fd00::12]:8080"],
  });
  assert.equal(Object.isFrozen(target?.widget), true);
  assert.equal(Object.isFrozen(target?.widget?.origins), true);

  for (const widget of [
    {},
    { origins: [] },
    { origins: "https://shop.dev.example" },
    { origins: ["https://shop.dev.example/"] },
    { origins: ["https://Shop.dev.example"] },
    { origins: ["https://shop.dev.example:443"] },
    { origins: ["https://*.dev.example"] },
    { origins: ["https://user:pw@shop.dev.example"] },
    { origins: ["https://shop.dev.example/path"] },
    { origins: ["ftp://shop.dev.example"] },
    { origins: ["null"] },
    { origins: ["https://shop.dev.example", "https://shop.dev.example"] },
    { origins: ["https://shop.dev.example"], extra: true },
  ]) {
    assert.throws(() => validateStaticTargets([{ ...base, widget }]), TypeError, JSON.stringify(widget));
  }
});

test("canonical web origin predicate matches the MCP origin rule", () => {
  assert.equal(isCanonicalWebOrigin("https://shop.dev.example"), true);
  assert.equal(isCanonicalWebOrigin("http://127.0.0.1:8080"), true);
  for (const value of ["https://shop.dev.example/", "HTTPS://shop.dev.example", "https://shop.dev.example:443", "", 1, null]) {
    assert.equal(isCanonicalWebOrigin(value), false, String(value));
  }
});
```

In `apps/server/test/config.test.ts`:
- Extend the `rejects every invalid closed v1 document with generic diagnostics` case list with:
  ```ts
  { name: "unknown widget property", edit: (document) => { document.widget = { enabled: true, secret: sentinel }; } },
  { name: "non-boolean widget switch", edit: (document) => { document.widget = { enabled: "true" }; } },
  { name: "non-object widget", edit: (document) => { document.widget = true; } },
  { name: "target widget without origins", edit: (document) => { document.targets[0].widget = {}; } },
  { name: "target widget origin with path", edit: (document) => { document.targets[0].widget = { origins: [`https://app.example.test/${sentinel}`] }; } },
  ```
- Add:
  ```ts
  test("widget configuration defaults to disabled and is frozen when present", async () => {
    const omitted = await loadServerConfiguration(
      { GAUNTLET_CONFIG_FILE: "/config.json" },
      async () => jsonBytes(validDocument()),
    );
    assert.deepEqual(omitted.widget, { enabled: false });
    assert.equal(Object.isFrozen(omitted.widget), true);

    const empty = await loadServerConfiguration(
      { GAUNTLET_CONFIG_FILE: "/config.json" },
      async () => jsonBytes({ ...validDocument(), widget: {} }),
    );
    assert.deepEqual(empty.widget, { enabled: false });

    const document = validDocument() as Record<string, any>;
    document.widget = { enabled: true };
    document.targets[0].widget = { origins: ["https://billing.dev.example"] };
    const enabled = await loadServerConfiguration(
      { GAUNTLET_CONFIG_FILE: "/config.json" },
      async () => jsonBytes(document),
    );
    assert.deepEqual(enabled.widget, { enabled: true });
    assert.deepEqual(enabled.targets[0]?.widget, { origins: ["https://billing.dev.example"] });
  });
  ```
- In `loads equivalent deeply owned immutable YAML and JSON v1 documents`, also assert `Object.isFrozen(yaml.widget)` and `Object.isFrozen(yaml.targets[0]?.widget?.origins)`.
- Any existing `deepEqual` against a whole `ServerConfiguration` (legacy tests) must now include `widget: { enabled: false }`; update those expectations, do not weaken them.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/server && pnpm exec tsx --test test/static-target-provider.test.ts test/config.test.ts`
Expected: FAIL (`isCanonicalWebOrigin` is not exported; widget keys rejected as unknown).

- [ ] **Step 3: Implement runtime parsing**

`static-target-provider.ts`:

```ts
const TARGET_KEYS = new Set([
  "id", "label", "adapterUrl", "publicUrl", "expectedEnvironment", "tags", "widget",
]);

export interface StaticTargetWidgetConfig {
  readonly origins: readonly string[];
}

/** Exact `scheme://host[:port]` as produced by `URL.origin`; the MCP origin rule. */
export function isCanonicalWebOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  } catch {
    return false;
  }
}

function targetWidget(value: unknown): StaticTargetWidgetConfig {
  const record = ownDataRecord(value);
  if (Object.keys(record).length !== 1 || !Object.hasOwn(record, "origins")) {
    throw invalidStaticTarget();
  }
  const origins = ownArray(record.origins);
  if (origins.length === 0) throw invalidStaticTarget();
  const unique = new Set<string>();
  for (const candidate of origins) {
    if (!isCanonicalWebOrigin(candidate) || unique.has(candidate)) throw invalidStaticTarget();
    assertRuntimeString(candidate);
    unique.add(candidate);
  }
  return Object.freeze({ origins: Object.freeze([...unique]) });
}
```

In `validateTarget`, add `const widget = Object.hasOwn(record, "widget") ? targetWidget(record.widget) : undefined;` and spread `...(widget === undefined ? {} : { widget })` after `tags`. Add `readonly widget?: StaticTargetWidgetConfig;` to `StaticTargetConfig`.

`config.ts`: add the `WidgetConfiguration` interface and the `widget` field. In `validateConfigurationV1` replace the exact-keys check with one that accepts the optional key:

```ts
const allowed = ["version", "instance", "targets", "widget"];
if (Object.keys(record).some((key) => !allowed.includes(key))
  || !["version", "instance", "targets"].every((key) => Object.hasOwn(record, key))
  || record.version !== 1) {
  throw configurationError("invalid-document");
}
// ...
const widget = Object.hasOwn(record, "widget") ? widgetConfiguration(record.widget) : DISABLED_WIDGET;
return Object.freeze({ version: 1, instance, widget, targets });
```

with

```ts
const DISABLED_WIDGET: WidgetConfiguration = Object.freeze({ enabled: false });

function widgetConfiguration(value: unknown): WidgetConfiguration {
  const record = ownDataRecord(value);
  if (Object.keys(record).some((key) => key !== "enabled")) throw configurationError("invalid-document");
  if (!Object.hasOwn(record, "enabled")) return DISABLED_WIDGET;
  if (typeof record.enabled !== "boolean") throw configurationError("invalid-document");
  return Object.freeze({ enabled: record.enabled });
}
```

The legacy environment path (`legacyDocument`) produces no `widget` key and therefore gets `{ enabled: false }`; per-target `widget` inside `GAUNTLET_TARGETS_JSON` is accepted because it uses the same target validator.

- [ ] **Step 4: Run runtime tests to verify they pass**

Run: `cd apps/server && pnpm exec tsx --test test/static-target-provider.test.ts test/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Extend the shared JSON Schema and fixtures (failing first)**

In `apps/server/test/config-schema.test.ts`, add `"config.widget-origin.invalid.yaml"` to the list in `the v1 schema rejects production, unknown fields, and empty targets`, and add:

```ts
test("the v1 schema accepts the widget switch and exact target origins only", async () => {
  const schema = JSON.parse(await readFile(schemaUrl, "utf8")) as object;
  const validate = new Ajv2020({ allErrors: true, strict: true, validateFormats: false }).compile(schema);
  const base = await document("config.valid.json") as Record<string, any>;
  const withWidget = (widget: unknown, targetWidget: unknown) => ({
    ...base,
    widget,
    targets: [{ ...base.targets[0], widget: targetWidget }],
  });
  assert.equal(validate(withWidget({ enabled: false }, { origins: ["https://shop.dev.example"] })), true);
  assert.equal(validate(withWidget({}, { origins: ["http://localhost:5173"] })), true);
  for (const [widget, targetWidget] of [
    [{ enabled: "yes" }, { origins: ["https://shop.dev.example"] }],
    [{ enabled: true, extra: 1 }, { origins: ["https://shop.dev.example"] }],
    [{ enabled: true }, {}],
    [{ enabled: true }, { origins: [] }],
    [{ enabled: true }, { origins: ["https://shop.dev.example/"] }],
    [{ enabled: true }, { origins: ["https://Shop.dev.example"] }],
    [{ enabled: true }, { origins: ["https://shop.dev.example", "https://shop.dev.example"] }],
  ] as const) {
    assert.equal(validate(withWidget(widget, targetWidget)), false, JSON.stringify([widget, targetWidget]));
  }
});

test("the Compose schema copy is identical to the canonical configuration schema", async () => {
  assert.equal(
    await readFile(new URL("deploy/compose/gauntlet-config-v1.schema.json", root), "utf8"),
    await readFile(schemaUrl, "utf8"),
  );
});
```

Create `config/fixtures/config.widget-origin.invalid.yaml` (a valid document except for the origin):

```yaml
version: 1
instance:
  name: small-apps-dev
  environment:
    name: dev
    kind: development
widget:
  enabled: true
targets:
  - id: billing
    label: Billing
    adapterUrl: http://billing:8080
    expectedEnvironment:
      name: dev
      kind: development
    widget:
      origins: [https://dev.billing.example/]
```

Update `config.valid.yaml` and `config.valid.json` identically: add top-level `widget: { enabled: true }` after `instance`, and on target `billing` add `widget: { origins: [https://dev.billing.example] }`.

Run: `cd apps/server && pnpm exec tsx --test test/config-schema.test.ts`
Expected: FAIL (schema has `additionalProperties: false` without `widget`).

- [ ] **Step 6: Update the JSON Schema (both copies)**

In `config/gauntlet-config-v1.schema.json`:
- root `properties`: `"widget": { "$ref": "#/$defs/widget" }` (not in `required`);
- `$defs.target.properties`: `"widget": { "$ref": "#/$defs/targetWidget" }`;
- new `$defs`:
  ```json
  "exactOrigin": {
    "type": "string",
    "pattern": "^https?://(?:\\[[0-9a-f:.]+\\]|[a-z0-9.-]+)(?::[0-9]{1,5})?$"
  },
  "widget": {
    "type": "object",
    "properties": { "enabled": { "type": "boolean" } },
    "additionalProperties": false
  },
  "targetWidget": {
    "type": "object",
    "required": ["origins"],
    "properties": {
      "origins": {
        "type": "array",
        "minItems": 1,
        "uniqueItems": true,
        "items": { "$ref": "#/$defs/exactOrigin" }
      }
    },
    "additionalProperties": false
  }
  ```
Copy the file byte-for-byte to `deploy/compose/gauntlet-config-v1.schema.json`.

Run: `cd apps/server && pnpm exec tsx --test test/config-schema.test.ts test/config.test.ts test/main.test.ts`
Expected: PASS (`main.test.ts` still boots from `config.valid.yaml`: the widget is enabled there but `createConfiguredApp` does not consume `widget` until Task 3).

- [ ] **Step 7: Mirror the schema into the Helm values schema**

`deploy/helm/gauntlet/values.schema.json` (draft-07, `definitions` instead of `$defs`):
- `properties.config.properties`: `"widget": { "$ref": "#/definitions/widget" }`;
- `definitions.target.properties`: `"widget": { "$ref": "#/definitions/targetWidget" }` so `definitions.target` stays equal to the normalized shared `$defs.target`;
- add `definitions.exactOrigin`, `definitions.widget`, `definitions.targetWidget` equal to the shared fragments with `#/$defs/` → `#/definitions/`.

`deploy/helm/test-values-schema.mjs`:
- extend the parity list in `the draft-07 values schema preserves all canonical configuration fragments` to `["id", "environment", "origin", "target", "exactOrigin", "widget", "targetWidget"]`;
- add a test that renders with widget values and rejects a bad origin, following the file's `helm(withStaging([...]), <exitCode>)` pattern:
  ```js
  test("widget configuration passes through the chart and invalid origins are rejected", () => {
    helm(withStaging([
      "--set-json", "config.widget={\"enabled\":true}",
      "--set-json", "config.targets[0].widget={\"origins\":[\"https://shop.staging.example\"]}",
    ]), 0);
    helm(withStaging([
      "--set-json", "config.targets[0].widget={\"origins\":[\"https://shop.staging.example/\"]}",
    ]), 1);
    helm(withStaging(["--set-json", "config.widget={\"enabled\":\"yes\"}"]), 1);
  });
  ```
  Check `helm`'s signature in `deploy/helm/test-support.mjs` and the non-zero exit code other rejection tests in the file expect; use the same value.

Run: `node --test --test-concurrency=1 deploy/helm/test-values-schema.mjs`
Expected: PASS (uses the pinned `alpine/helm` Docker image; Docker must be running).

- [ ] **Step 8: Document the contract**

- `config/README.md`: a "Widget" section with the YAML example from Global Constraints, the default (`false`), the exact-origin rule with one rejected example each for trailing slash and wildcard, and that invalid values fail startup with `invalid-document`. State that `GAUNTLET_WIDGET_DIR` must point at the widget build when enabled (served routes are documented in `apps/server/README.md`).
- `deploy/helm/README.md`: one paragraph noting `config.widget` and `config.targets[].widget.origins` pass through to the configuration file unchanged.

Run: `pnpm docs:check`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/config.ts apps/server/src/static-target-provider.ts apps/server/test/config.test.ts apps/server/test/config-schema.test.ts apps/server/test/static-target-provider.test.ts config deploy/compose/gauntlet-config-v1.schema.json deploy/helm/gauntlet/values.schema.json deploy/helm/test-values-schema.mjs deploy/helm/README.md
git commit -m "feat(server): add widget configuration with exact per-target origins"
```

---

### Task 2: Reserve `/widget` and forbid framing the dashboard

**Files:**
- Modify: `apps/server/src/app.ts` (`registerDashboard`: `globIgnore`, `isControlPlaneStaticPath`, CSP in `setHeaders`; SPA fallback CSP)
- Modify: `apps/server/src/problem-response.ts` (`isReservedPath`)
- Test: `apps/server/test/dashboard-static.test.ts`

**Interfaces:**
- Produces: `export const DASHBOARD_FRAME_POLICY = "frame-ancestors 'none'";` in `apps/server/src/app.ts` (used by tests; Task 3 builds its own panel policy).
- `/widget` and `/widget/*` are reserved paths (no SPA fallback, never served by the dashboard static handler).

- [ ] **Step 1: Write failing tests**

In `dashboard-static.test.ts`:
- In `serves root, hashed assets, and extensionless browser routes`, assert `root.headers["content-security-policy"] === "frame-ancestors 'none'"` and the same for the extensionless SPA route response.
- Add:
  ```ts
  test("hashed assets and problem documents do not carry the dashboard frame policy", async () => {
    await usingDashboardDirectory(async (dashboardDir) => {
      await usingDashboardApp(dashboardDir, async (app) => {
        const asset = await app.inject({ method: "GET", url: "/assets/app-abc12345.js" });
        assert.equal(asset.statusCode, 200);
        assert.equal(asset.headers["content-security-policy"], undefined);
        const api = await app.inject({ method: "GET", url: "/api/v1/targets" });
        assert.equal(api.headers["content-security-policy"], undefined);
        assert.equal(api.headers["access-control-allow-origin"], undefined);
      });
    });
  });
  ```
- In `reserved namespaces and unsupported methods never fall through to static files or the SPA`, add to the first request list:
  ```ts
  { method: "GET", url: "/widget", headers: { accept: "text/html" } },
  { method: "GET", url: "/widget/", headers: { accept: "text/html" } },
  { method: "GET", url: "/widget/loader.js", headers: { accept: "text/html" } },
  { method: "GET", url: "/widget/config.json", headers: { accept: "*/*" } },
  ```
  add `widget: sentinel` to its extra files, and to the second block add `"/widget/sentinel"` with extra file `"widget/sentinel": sentinel`. Also add `"widget/index.html": sentinel` and `"widget/loader.js": sentinel` to the second block's extra files so a dashboard build containing widget files is proven inert.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/server && pnpm exec tsx --test test/dashboard-static.test.ts`
Expected: FAIL (no CSP header; `/widget/…` served by the SPA fallback or static handler).

- [ ] **Step 3: Implement**

- `problem-response.ts` `isReservedPath`: add `|| pathname === "/widget" || pathname.startsWith("/widget/")`.
- `app.ts` `registerDashboard`: add `"widget"`, `"widget/**"` to `globIgnore`; add the same two conditions to `isControlPlaneStaticPath`; in `setHeaders` add `if (normalized.toLowerCase().endsWith(".html")) reply.header("content-security-policy", DASHBOARD_FRAME_POLICY);`.
- `createApp`: the SPA fallback becomes
  ```ts
  spaFallback: (_request, reply) => reply.header("content-security-policy", DASHBOARD_FRAME_POLICY).sendFile("index.html")
  ```
  (setting it explicitly keeps the header even if `@fastify/static` does not run `setHeaders` for `sendFile`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/server && pnpm test`
Expected: PASS (whole server suite; nothing else may regress).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/app.ts apps/server/src/problem-response.ts apps/server/test/dashboard-static.test.ts
git commit -m "feat(server): reserve /widget and forbid framing the dashboard"
```

---

### Task 3: Serve the widget routes

**Files:**
- Create: `apps/server/src/widget.ts`
- Modify: `apps/server/src/app.ts` (`CreateAppOptions.widget`, keep the static provider in a variable, call `registerWidget`)
- Modify: `apps/server/src/main.ts` (`GAUNTLET_WIDGET_DIR`, pass `configuration.widget`)
- Modify: `apps/server/README.md`, `docs/reference/control-plane-api.md`, `CHANGELOG.md`
- Modify: `apps/server/test/config-schema.test.ts` (`mainRuntimeKeys` gains `"GAUNTLET_WIDGET_DIR"`)
- Test: `apps/server/test/widget.test.ts` (new), `apps/server/test/main.test.ts`

**Interfaces:**
- Consumes: `StaticTargetConfig.widget?.origins` and `isCanonicalWebOrigin` (Task 1); `ServerConfiguration.widget` (Task 1); reserved `/widget` prefix (Task 2).
- Produces:
  ```ts
  // apps/server/src/widget.ts
  export interface WidgetOptions {
    readonly enabled: boolean;
    /** Directory containing index.html, loader.js and optional assets/. Required when enabled. */
    readonly dir?: string;
  }
  export interface WidgetConfigDocument { readonly targets: Readonly<Record<string, readonly string[]>> }
  export function widgetConfigDocument(targets: readonly StaticTargetConfig[]): WidgetConfigDocument;
  export function widgetFramePolicy(targets: readonly StaticTargetConfig[]): string; // "frame-ancestors …"
  export async function registerWidget(
    app: FastifyInstance,
    options: WidgetOptions,
    targets: readonly StaticTargetConfig[],
  ): Promise<void>;
  // apps/server/src/app.ts
  // CreateAppOptions.widget?: WidgetOptions   (omitted ⇒ disabled)
  ```
- HTTP contract used by phases 3–4: `GET /widget/loader.js`, `GET /widget/`, `GET /widget/config.json` → `{ targets: { [id]: string[] } }`, `GET /widget/assets/<file>`.

- [ ] **Step 1: Write failing tests**

Create `apps/server/test/widget.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { widgetConfigDocument, widgetFramePolicy } from "../src/widget.js";
import { fakeTarget } from "./support/fake-adapter.js";
import { serverEnvironment } from "./support/environment.js";

const PANEL = "<!doctype html><html><body>widget panel fixture</body></html>";
const LOADER = "globalThis.gauntletLoaderFixture = true;";

const shop = {
  ...fakeTarget,
  id: "shop",
  widget: { origins: ["https://shop.dev.example", "http://localhost:5173"] },
};
const admin = {
  ...fakeTarget,
  id: "admin",
  widget: { origins: ["https://shop.dev.example"] },
};
const plain = { ...fakeTarget, id: "plain" };

async function writeFixture(root: string, path: string, contents: string): Promise<void> {
  const destination = join(root, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, contents, "utf8");
}

async function usingWidgetDirectory<T>(
  action: (dir: string) => Promise<T>,
  files: Readonly<Record<string, string>> = {
    "index.html": PANEL,
    "loader.js": LOADER,
    "assets/panel-abc12345.js": "globalThis.panel = true;",
    "assets/plain.js": "globalThis.plain = true;",
  },
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "gauntlet-widget-"));
  try {
    for (const [path, contents] of Object.entries(files)) await writeFixture(root, path, contents);
    return await action(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function usingApp<T>(
  options: Partial<Parameters<typeof createApp>[0]>,
  action: (app: Awaited<ReturnType<typeof createApp>>) => Promise<T>,
): Promise<T> {
  const app = await createApp({ environment: serverEnvironment, targets: [shop, admin, plain], ...options });
  try {
    return await action(app);
  } finally {
    await app.close();
  }
}

function assertNotFound(response: { statusCode: number; json(): unknown }, label: string): void {
  assert.equal(response.statusCode, 404, label);
  assert.equal((response.json() as { type: string }).type, "urn:gauntlet:problem:route-not-found", label);
}

test("config document lists targets with origins in configuration order", () => {
  assert.deepEqual(widgetConfigDocument([shop, admin, plain] as never), {
    targets: {
      shop: ["https://shop.dev.example", "http://localhost:5173"],
      admin: ["https://shop.dev.example"],
    },
  });
});

test("panel frame policy is the sorted de-duplicated origin union or 'none'", () => {
  assert.equal(
    widgetFramePolicy([shop, admin, plain] as never),
    "frame-ancestors http://localhost:5173 https://shop.dev.example",
  );
  assert.equal(widgetFramePolicy([plain] as never), "frame-ancestors 'none'");
});

test("an enabled widget serves loader, panel, config and assets with the specified headers", async () => {
  await usingWidgetDirectory(async (dir) => {
    await usingApp({ widget: { enabled: true, dir } }, async (app) => {
      const loader = await app.inject({ method: "GET", url: "/widget/loader.js" });
      assert.equal(loader.statusCode, 200);
      assert.equal(loader.body, LOADER);
      assert.match(String(loader.headers["content-type"]), /^text\/javascript; charset=utf-8$/);
      assert.equal(loader.headers["cross-origin-resource-policy"], "cross-origin");
      assert.equal(loader.headers["cache-control"], "no-cache");
      assert.equal(loader.headers["x-content-type-options"], "nosniff");
      assert.match(String(loader.headers.etag), /^"[A-Za-z0-9_-]{16,}"$/);
      assert.equal(loader.headers["access-control-allow-origin"], undefined);

      const panel = await app.inject({ method: "GET", url: "/widget/", headers: { accept: "text/html" } });
      assert.equal(panel.statusCode, 200);
      assert.equal(panel.body, PANEL);
      assert.match(String(panel.headers["content-type"]), /^text\/html; charset=utf-8$/);
      assert.equal(
        panel.headers["content-security-policy"],
        "frame-ancestors http://localhost:5173 https://shop.dev.example",
      );
      assert.equal(panel.headers["cache-control"], "no-cache");
      assert.match(String(panel.headers.etag), /^"[A-Za-z0-9_-]{16,}"$/);

      const config = await app.inject({ method: "GET", url: "/widget/config.json" });
      assert.equal(config.statusCode, 200);
      assert.match(String(config.headers["content-type"]), /^application\/json; charset=utf-8$/);
      assert.equal(config.headers["cache-control"], "no-cache");
      assert.deepEqual(config.json(), {
        targets: {
          shop: ["https://shop.dev.example", "http://localhost:5173"],
          admin: ["https://shop.dev.example"],
        },
      });

      const hashed = await app.inject({ method: "GET", url: "/widget/assets/panel-abc12345.js" });
      assert.equal(hashed.statusCode, 200);
      assert.equal(hashed.headers["cache-control"], "public, max-age=31536000, immutable");
      const unhashed = await app.inject({ method: "GET", url: "/widget/assets/plain.js" });
      assert.equal(unhashed.statusCode, 200);
      assert.equal(unhashed.headers["cache-control"], "no-cache");
    });
  });
});

test("only an exact ETag match returns 304", async () => {
  await usingWidgetDirectory(async (dir) => {
    await usingApp({ widget: { enabled: true, dir } }, async (app) => {
      for (const url of ["/widget/loader.js", "/widget/"]) {
        const first = await app.inject({ method: "GET", url });
        const etag = String(first.headers.etag);
        const cached = await app.inject({ method: "GET", url, headers: { "if-none-match": etag } });
        assert.equal(cached.statusCode, 304, url);
        assert.equal(cached.body, "", url);
        assert.equal(cached.headers.etag, etag, url);
        for (const stale of ["\"stale\"", "garbage", `W/${etag}`, ""]) {
          const fresh = await app.inject({ method: "GET", url, headers: { "if-none-match": stale } });
          assert.equal(fresh.statusCode, 200, `${url} ${stale}`);
          assert.equal(fresh.body, first.body, `${url} ${stale}`);
        }
      }
    });
  });
});

test("unknown widget paths and non-GET methods never reach the panel or the SPA", async () => {
  await usingWidgetDirectory(async (dir) => {
    await usingApp({ widget: { enabled: true, dir } }, async (app) => {
      for (const request of [
        { method: "GET", url: "/widget", headers: { accept: "text/html" } },
        { method: "GET", url: "/widget/other", headers: { accept: "text/html" } },
        { method: "GET", url: "/widget/index.html", headers: { accept: "text/html" } },
        { method: "GET", url: "/widget/assets/missing.js" },
        { method: "POST", url: "/widget/loader.js" },
        { method: "POST", url: "/widget/config.json" },
      ] as const) {
        const response = await app.inject(request);
        assert.ok([404, 405].includes(response.statusCode), `${request.method} ${request.url}`);
        assert.match(String(response.headers["content-type"]), /^application\/problem\+json/);
        assert.equal(response.body.includes("widget panel fixture"), false);
      }
    });
  });
});

test("a disabled widget returns 404 for every widget path and never reads the directory", async () => {
  for (const options of [{}, { widget: { enabled: false } }, { widget: { enabled: false, dir: "/nonexistent" } }]) {
    await usingApp(options, async (app) => {
      for (const url of ["/widget", "/widget/", "/widget/loader.js", "/widget/config.json", "/widget/assets/x.js"]) {
        assertNotFound(await app.inject({ method: "GET", url, headers: { accept: "text/html" } }), url);
      }
    });
  }
});

test("an enabled widget requires a directory with regular index.html and loader.js", async () => {
  await usingWidgetDirectory(async (root) => {
    await mkdir(join(root, "only-index"));
    await writeFile(join(root, "only-index", "index.html"), PANEL);
    await mkdir(join(root, "loader-dir", "loader.js"), { recursive: true });
    await writeFile(join(root, "loader-dir", "index.html"), PANEL);
    for (const widget of [
      { enabled: true },
      { enabled: true, dir: join(root, "missing") },
      { enabled: true, dir: join(root, "only-index") },
      { enabled: true, dir: join(root, "loader-dir") },
    ]) {
      await assert.rejects(
        createApp({ environment: serverEnvironment, targets: [shop], widget }),
        (error: unknown) => {
          assert.ok(error instanceof TypeError);
          assert.equal(error.message, "Widget files are missing");
          assert.equal(error.message.includes(root), false);
          return true;
        },
      );
    }
  }, {});
});

test("an enabled widget without assets directory still serves loader and panel", async () => {
  await usingWidgetDirectory(async (dir) => {
    await usingApp({ widget: { enabled: true, dir } }, async (app) => {
      assert.equal((await app.inject({ method: "GET", url: "/widget/loader.js" })).statusCode, 200);
      assertNotFound(await app.inject({ method: "GET", url: "/widget/assets/panel-abc12345.js" }), "no assets");
    });
  }, { "index.html": PANEL, "loader.js": LOADER });
});
```

In `apps/server/test/main.test.ts` add:

```ts
test("configured composition serves the widget from GAUNTLET_WIDGET_DIR only when enabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gauntlet-main-widget-"));
  try {
    await writeFile(join(dir, "index.html"), "<!doctype html><title>panel</title>");
    await writeFile(join(dir, "loader.js"), "void 0;");
    const app = await createConfiguredApp(
      { GAUNTLET_CONFIG_FILE: "/config.yaml", GAUNTLET_WIDGET_DIR: dir },
      { readConfig: async () => await fixture("config.valid.yaml") },
    );
    try {
      const config = await app.inject({ method: "GET", url: "/widget/config.json" });
      assert.deepEqual(config.json(), { targets: { billing: ["https://dev.billing.example"] } });
    } finally {
      await app.close();
    }
    await assert.rejects(
      createConfiguredApp(
        { GAUNTLET_CONFIG_FILE: "/config.yaml" },
        { readConfig: async () => await fixture("config.valid.yaml") },
      ),
      /Widget files are missing/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

(add the `mkdtemp`, `rm`, `writeFile`, `tmpdir`, `join` imports). The existing `main.test.ts` tests boot from `config.valid.yaml`, which now enables the widget: give them a `GAUNTLET_WIDGET_DIR` fixture directory via a shared helper, or boot them from a JSON document without `widget` — pick one approach and apply it consistently; do not remove `widget` from the fixture.

In `config-schema.test.ts`, add `"GAUNTLET_WIDGET_DIR"` to `mainRuntimeKeys`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/server && pnpm exec tsx --test test/widget.test.ts test/main.test.ts test/config-schema.test.ts`
Expected: FAIL (`../src/widget.js` does not exist; `GAUNTLET_WIDGET_DIR` undocumented).

- [ ] **Step 3: Implement `apps/server/src/widget.ts`**

```ts
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { StaticTargetConfig } from "./static-target-provider.js";

export interface WidgetOptions {
  readonly enabled: boolean;
  /** Directory containing index.html, loader.js and optional assets/. Required when enabled. */
  readonly dir?: string;
}

export interface WidgetConfigDocument {
  readonly targets: Readonly<Record<string, readonly string[]>>;
}

const HASHED_ASSET = /^.+-[A-Za-z0-9_-]{8,}\.([A-Za-z0-9]+)$/;

function widgetFilesMissing(): TypeError {
  return new TypeError("Widget files are missing");
}

export function widgetConfigDocument(targets: readonly StaticTargetConfig[]): WidgetConfigDocument {
  const entries: Record<string, readonly string[]> = {};
  for (const target of targets) {
    if (target.widget !== undefined) entries[target.id] = target.widget.origins;
  }
  return Object.freeze({ targets: Object.freeze(entries) });
}

export function widgetFramePolicy(targets: readonly StaticTargetConfig[]): string {
  const origins = [...new Set(targets.flatMap((target) => target.widget?.origins ?? []))].sort();
  return `frame-ancestors ${origins.length === 0 ? "'none'" : origins.join(" ")}`;
}

interface CachedFile {
  readonly body: Buffer;
  readonly etag: string;
}

async function regularFile(path: string): Promise<CachedFile> {
  if (!(await lstat(path)).isFile()) throw widgetFilesMissing();
  const body = await readFile(path);
  return { body, etag: `"${createHash("sha256").update(body).digest("base64url")}"` };
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

function sendCached(
  request: FastifyRequest,
  reply: FastifyReply,
  file: CachedFile,
  headers: Readonly<Record<string, string>>,
): FastifyReply {
  reply.headers({ ...headers, "cache-control": "no-cache", etag: file.etag });
  if (request.headers["if-none-match"] === file.etag) return reply.code(304).send();
  return reply.send(file.body);
}

export async function registerWidget(
  app: FastifyInstance,
  options: WidgetOptions,
  targets: readonly StaticTargetConfig[],
): Promise<void> {
  if (!options.enabled) return;
  if (options.dir === undefined) throw widgetFilesMissing();
  let root: string;
  let panel: CachedFile;
  let loader: CachedFile;
  try {
    root = resolve(options.dir);
    panel = await regularFile(resolve(root, "index.html"));
    loader = await regularFile(resolve(root, "loader.js"));
  } catch {
    throw widgetFilesMissing();
  }

  const framePolicy = widgetFramePolicy(targets);
  const config = JSON.stringify(widgetConfigDocument(targets));

  app.get("/widget/loader.js", (request, reply) => sendCached(request, reply, loader, {
    "content-type": "text/javascript; charset=utf-8",
    "cross-origin-resource-policy": "cross-origin",
    "x-content-type-options": "nosniff",
  }));
  app.get("/widget/", (request, reply) => sendCached(request, reply, panel, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": framePolicy,
  }));
  app.get("/widget/config.json", (_request, reply) => reply
    .header("cache-control", "no-cache")
    .type("application/json; charset=utf-8")
    .send(config));

  const assets = resolve(root, "assets");
  if (await isDirectory(assets)) {
    await app.register(fastifyStatic, {
      root: assets,
      prefix: "/widget/assets/",
      decorateReply: false,
      wildcard: false,
      index: false,
      cacheControl: false,
      setHeaders: (reply, path) => {
        const name = relative(assets, path).split(sep).join("/");
        const hashed = HASHED_ASSET.exec(name);
        reply.header(
          "cache-control",
          hashed !== null && hashed[1]!.toLowerCase() !== "html"
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        );
      },
    });
  }
}
```

Adjust types to the installed Fastify/`@fastify/static` versions if the compiler asks (for example `reply.raw` headers), but keep the behavior above.

- [ ] **Step 4: Wire it into `createApp` and `main`**

`app.ts`:
- import `registerWidget, type WidgetOptions` from `./widget.js`; add `readonly widget?: WidgetOptions;` to `CreateAppOptions` with doc comment `/** Embeddable widget; omitted ⇒ disabled and every /widget path is 404. */`;
- replace the inline provider with `const targetProvider = createStaticTargetProvider(options.targets);` and `createTargetRegistry([targetProvider])`;
- after `registerDashboard` and before `configureProblemResponses`: `await registerWidget(app, options.widget ?? { enabled: false }, targetProvider.targets());`
- re-export `export type { WidgetOptions } from "./widget.js";`.

`main.ts` `createConfiguredApp`:

```ts
const widgetDir = ownEnvironmentString(environment, "GAUNTLET_WIDGET_DIR");
return await createApp({
  environment: configuration.instance.environment,
  targets: configuration.targets,
  mcp: mcpConfiguration(environment),
  widget: {
    enabled: configuration.widget.enabled,
    ...(widgetDir === undefined ? {} : { dir: widgetDir }),
  },
  ...(dashboardDir === undefined ? {} : { dashboardDir }),
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/server && pnpm exec tsx --test test/widget.test.ts test/main.test.ts && pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 6: Document**

- `apps/server/README.md`: add `GAUNTLET_WIDGET_DIR` to the environment table (directory with `index.html`, `loader.js`, `assets/`; required when `widget.enabled` is true; read at startup) and a "Widget routes" subsection with the route/header table from Global Constraints, the 404-when-disabled rule, and the dashboard's `frame-ancestors 'none'`.
- `docs/reference/control-plane-api.md`: a "Widget" section listing the four routes, the `config.json` shape, and that `/api/v1` gains no CORS.
- `CHANGELOG.md` under `## Unreleased`:
  - `### Added`: "Embeddable widget server support: optional `widget.enabled` switch and per-target `widget.origins` in the v1 configuration, and `/widget/loader.js`, `/widget/`, `/widget/config.json` and `/widget/assets/*` served from `GAUNTLET_WIDGET_DIR` when enabled."
  - `### Security` (new heading if missing): "Dashboard HTML responses now send `Content-Security-Policy: frame-ancestors 'none'`; the widget panel may only be framed by configured target origins."

Run: `pnpm docs:check && cd apps/server && pnpm exec tsx --test test/config-schema.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/widget.ts apps/server/src/app.ts apps/server/src/main.ts apps/server/test/widget.test.ts apps/server/test/main.test.ts apps/server/test/config-schema.test.ts apps/server/README.md docs/reference/control-plane-api.md CHANGELOG.md
git commit -m "feat(server): serve widget loader, panel, config and assets under /widget"
```

---

## Out of scope for this phase

- Building `loader.js` (phase 3) and the panel (phase 4); the Dockerfile, product-image verification and `GAUNTLET_WIDGET_DIR` default in the image land in phase 4 together with the build output.
- Compose example and Helm defaults stay with the widget disabled (`config.example.yaml` unchanged).
