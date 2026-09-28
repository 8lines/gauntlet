# Dashboard and All-in-One Product Image Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing uncommitted dashboard into a tested mobile and desktop product UI and ship it together with the Fastify control plane in one immutable, non-root OCI image.

**Architecture:** The React dashboard remains a schema-driven client of same-origin `/api/v1` routes and never calls an adapter directly. Fastify serves compiled static files at `/` while preserving RFC 9457 behavior for API and health routes; a multi-stage Docker build copies only production server dependencies, compiled server output, and compiled dashboard assets into the final image.

**Tech Stack:** Node.js 24 LTS baseline, pnpm 11.24.0, TypeScript 7.0.2, React 19.2.8, Vite 8.2.2, Tailwind CSS 4.3.3, Fastify 5.12.1, `@fastify/static` 10.1.3, Playwright Chromium, native `node:test` through tsx 4.23.12, Docker BuildKit Dockerfile syntax 1.7.

**Spec:** `docs/superpowers/specs/2026-09-02-release-standalone-safety-skills-design.md`

## Global Constraints

- Existing uncommitted dashboard and static-serving work is reviewed and incorporated or replaced intentionally; it is never silently discarded.
- The browser talks only to same-origin Gauntlet `/api/v1` routes and never receives or calls an internal adapter URL.
- The product image always contains both dashboard and API; an explicitly configured missing dashboard directory is a startup error.
- The reusable `createApp` library remains usable headlessly when `dashboardDir` is omitted.
- SPA fallback applies only to browser `GET` navigation outside exact `/api`, `/api/**`, `/health`, and `/ready`; unknown API routes remain RFC 9457 Problems.
- `EnvironmentDescriptor` and confirmation types come from the safety implementation in `@8lines/gauntlet-protocol`; this plan does not redefine them.
- Whenever `operation.execution.confirmationRequired === true`, every create-run request includes `confirmation` bound to operation ID, exact revision, and declared impact, including requests with `dryRun: true`.
- File uploads and session launches always pass through the control plane.
- Mobile and desktop core workflows work without document-level horizontal scrolling at 390×844 and 1440×900 viewports.
- Generated `apps/dashboard/dist` assets remain ignored and are never committed.
- Runtime support remains Node.js `>=24 <27`; all dependency versions remain exact in package manifests.
- Authentication remains outside v0.1; deployment documentation must keep the product behind a trusted private network boundary.

---

### Task 1: Adopt and Characterize the Existing Dashboard

**Files:**
- Add existing: `apps/dashboard/index.html`
- Add existing: `apps/dashboard/package.json`
- Add existing: `apps/dashboard/tsconfig.json`
- Add existing: `apps/dashboard/vite.config.ts`
- Add existing: `apps/dashboard/src/App.tsx`
- Add existing: `apps/dashboard/src/Formularz.tsx`
- Add existing: `apps/dashboard/src/Przebieg.tsx`
- Add existing: `apps/dashboard/src/WidokOperacji.tsx`
- Add existing: `apps/dashboard/src/api.ts`
- Add existing: `apps/dashboard/src/index.css`
- Add existing: `apps/dashboard/src/main.tsx`
- Add existing: `apps/dashboard/src/trasa.ts`
- Add existing: `apps/dashboard/src/tresc.ts`
- Add existing: `apps/dashboard/src/ui.tsx`
- Add existing: `apps/dashboard/src/vite-env.d.ts`
- Add existing: `apps/dashboard/src/wskazniki.ts`
- Add existing: `apps/dashboard/test/wskazniki.test.ts`
- Add existing: `apps/dashboard/scripts/lokalny-stos.mjs`
- Add existing: `apps/dashboard/README.md`
- Add existing: `docs/mockups/panel.html`
- Create: `docs/mockups/README.md`
- Include dirty existing: `apps/server/package.json`
- Include dirty existing: `apps/server/src/app.ts`
- Include dirty existing: `apps/server/src/main.ts`
- Include dirty existing: `apps/server/src/problem-response.ts`
- Include dirty existing: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `AdapterManifest`, `OperationDefinition`, `Run`, `Problem`, and rich form/result profile types from `@8lines/gauntlet-protocol`.
- Consumes: the existing uncommitted static-dashboard seam: `@fastify/static`, `CreateAppOptions.dashboardDir?: string`, `GAUNTLET_DASHBOARD_DIR` forwarding in `main`, and optional SPA fallback in `configureProblemResponses`.
- Produces: `App`, `Formularz`, `WidokOperacji`, `Przebieg`, the `api` same-origin client, route helpers, human-readable copy helpers, and JSON Pointer helpers.
- Produces: a committed design-reference explanation for `docs/mockups/panel.html`; the mockup is not a runtime asset.
- Produces: one clean, characterized dashboard/static-serving baseline commit that owns all five pre-existing dirty server/lockfile changes; Task 5 adds focused filesystem coverage and corrects fallback and missing-directory behavior.

- [ ] **Step 1: Record the current dashboard source inventory**

Run: `git status --short -- apps/dashboard docs/mockups apps/server/package.json apps/server/src/app.ts apps/server/src/main.ts apps/server/src/problem-response.ts pnpm-lock.yaml`

Expected: `apps/dashboard/` and `docs/mockups/` are untracked; the four named server files and `pnpm-lock.yaml` are modified; `apps/dashboard/dist` is absent because `dist/` is ignored. Review `git diff --` for the five tracked files and confirm every hunk belongs to the existing static-dashboard integration before proceeding.

- [ ] **Step 2: Run the current characterization tests**

Run: `pnpm --filter @8lines/gauntlet-dashboard test`

Expected: PASS with the existing 10 JSON Pointer, condition, and default-value tests.

- [ ] **Step 3: Run a production build before changing behavior**

Run: `pnpm --filter @8lines/gauntlet-dashboard build`

Expected: PASS and generation of `apps/dashboard/dist/index.html` plus hashed local JS, CSS, and font assets.

- [ ] **Step 4: Run focused server static-boundary and Problem characterization**

Run: `pnpm exec tsx --test apps/server/test/routes.integration.test.ts apps/server/test/safe-problem.test.ts`

Expected: PASS; headless server routing, fixed route-not-found/method Problems, invalid paths, and sanitized adapter Problems remain unchanged with the optional static integration present. Filesystem-backed dashboard and fallback edge cases are intentionally added and corrected in Task 5.

- [ ] **Step 5: Run the complete workspace baseline gate**

Run: `pnpm check`

Expected: PASS for workspace build, typecheck, unit tests, and packed npm consumer verification before any dirty baseline file is committed.

- [ ] **Step 6: Document the mockup boundary**

```md
<!-- docs/mockups/README.md -->
# Dashboard mockups

`panel.html` is the design reference that preceded the React implementation in
`apps/dashboard`. It is kept to explain visual intent and is not copied into the
runtime image. The shipping dashboard is built only from `apps/dashboard/src`.
```

- [ ] **Step 7: Verify generated assets are not staged**

Run: `git check-ignore apps/dashboard/dist/index.html`

Expected: output is `apps/dashboard/dist/index.html`.

- [ ] **Step 8: Commit the complete characterized baseline**

```bash
git add apps/dashboard docs/mockups apps/server/package.json apps/server/src/app.ts \
  apps/server/src/main.ts apps/server/src/problem-response.ts pnpm-lock.yaml
git commit -m "feat(dashboard): adopt dashboard and static server baseline"
```

### Task 2: Reliable Same-Origin API Client and Create-Run Payload Builder

**Files:**
- Modify: `apps/dashboard/src/api.ts`
- Create: `apps/dashboard/src/create-run-request.ts`
- Create: `apps/dashboard/test/api.test.ts`
- Create: `apps/dashboard/test/create-run-request.test.ts`

**Interfaces:**
- Consumes: `CreateRunRequest`, `FileReference`, `OperationDefinition`, `SessionLaunchResponse`, and `UploadResponse` from `@8lines/gauntlet-protocol`.
- Produces: `buildCreateRunRequest(definition, input, context, dryRun, idempotencyKey?): CreateRunRequest`.
- Produces: `api.wyslijPlik(targetId, file): Promise<Wynik<UploadResponse>>`.
- Produces: `api.uruchomWejscie(targetId, runId, artifactId): Promise<Wynik<SessionLaunchResponse>>`.
- Preserves: all existing target, operation, run, cancel, and data-source client methods.

- [ ] **Step 1: Write failing tests for response safety and multipart transport**

```ts
// apps/dashboard/test/api.test.ts
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { api } from "../src/api.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("multipart upload lets fetch generate the boundary", async () => {
  globalThis.fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.has("content-type"), false);
    assert.ok(init?.body instanceof FormData);
    return Response.json({
      file: {
        kind: "file",
        uploadId: "upload-1",
        name: "fixture.txt",
        mediaType: "text/plain",
        sizeBytes: 7,
        expiresAt: "2026-09-03T12:00:00Z"
      }
    });
  };
  const result = await api.wyslijPlik("portal", new File(["fixture"], "fixture.txt"));
  assert.equal(result.ok, true);
});

test("invalid non-JSON responses become a bounded unexpected-response Problem", async () => {
  globalThis.fetch = async () => new Response("<html>proxy failure secret</html>", {
    status: 502,
    headers: { "content-type": "text/html" },
  });
  const result = await api.targety();
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.problem.type, "urn:gauntlet:problem:unexpected-response");
    assert.equal(JSON.stringify(result).includes("secret"), false);
  }
});
```

- [ ] **Step 2: Write failing tests for confirmation in normal and dry-run requests**

```ts
// apps/dashboard/test/create-run-request.test.ts
test("confirmation-required definitions bind acknowledgement in both execution modes", () => {
  for (const dryRun of [false, true]) {
    const request = buildCreateRunRequest(
      destructiveDefinition,
      { userId: "user-1" },
      { requestId: "dashboard-request-1", target: { id: "portal" } },
      dryRun,
      "dashboard-idempotency-1",
    );
    assert.deepEqual(request.confirmation, {
      operationId: destructiveDefinition.id,
      operationRevision: destructiveDefinition.revision,
      impact: destructiveDefinition.execution.impact,
    });
    assert.equal(request.dryRun, dryRun);
  }
});

test("confirmation is absent only when the definition does not require it", () => {
  assert.equal(
    "confirmation" in buildCreateRunRequest(readDefinition, {}, context, true),
    false,
  );
});
```

- [ ] **Step 3: Run the new unit tests and confirm RED**

Run: `pnpm exec tsx --test apps/dashboard/test/api.test.ts apps/dashboard/test/create-run-request.test.ts`

Expected: FAIL because upload, launch, and request-builder exports do not exist and non-JSON parsing currently throws.

- [ ] **Step 4: Implement content-type-aware request handling**

Construct a `Headers` object, always set `accept: application/json`, and set `content-type: application/json` only when the body is a JSON string. Parse response text inside `try/catch`; never expose response text in the fallback Problem.

```ts
const headers = new Headers(init?.headers);
headers.set("accept", "application/json");
if (typeof init?.body === "string" && !headers.has("content-type")) {
  headers.set("content-type", "application/json");
}
```

Implement upload and launch with encoded path IDs:

```ts
wyslijPlik: (targetId: string, file: File): Promise<Wynik<UploadResponse>> => {
  const form = new FormData();
  form.append("file", file, file.name);
  return zapytaj(`/api/v1/targets/${encodeURIComponent(targetId)}/uploads`, {
    method: "POST",
    body: form,
  });
},

uruchomWejscie: (
  targetId: string,
  runId: string,
  artifactId: string,
): Promise<Wynik<SessionLaunchResponse>> => zapytaj(
  `/api/v1/targets/${encodeURIComponent(targetId)}/runs/${encodeURIComponent(runId)}`
    + `/artifacts/${encodeURIComponent(artifactId)}/launch`,
  { method: "POST" },
),
```

- [ ] **Step 5: Implement one canonical create-run payload builder**

```ts
export function buildCreateRunRequest(
  definition: OperationDefinition,
  input: JsonObject,
  context: InvocationContext,
  dryRun: boolean,
  idempotencyKey?: string,
): CreateRunRequest {
  return {
    operationRevision: definition.revision,
    input,
    context,
    dryRun,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    ...(definition.execution.confirmationRequired ? {
      confirmation: {
        operationId: definition.id,
        operationRevision: definition.revision,
        impact: definition.execution.impact,
      },
    } : {}),
  };
}
```

- [ ] **Step 6: Run unit tests and typecheck to confirm GREEN**

Run: `pnpm exec tsx --test apps/dashboard/test/api.test.ts apps/dashboard/test/create-run-request.test.ts`

Expected: PASS.

Run: `pnpm --filter @8lines/gauntlet-dashboard typecheck`

Expected: PASS.

- [ ] **Step 7: Commit the client boundary**

```bash
git add apps/dashboard/src/api.ts apps/dashboard/src/create-run-request.ts \
  apps/dashboard/test/api.test.ts apps/dashboard/test/create-run-request.test.ts
git commit -m "feat(dashboard): harden API requests and execution payloads"
```

### Task 3: Complete File Uploads and Result Actions

**Files:**
- Modify: `apps/dashboard/src/Formularz.tsx`
- Modify: `apps/dashboard/src/WidokOperacji.tsx`
- Modify: `apps/dashboard/src/Przebieg.tsx`
- Modify: `apps/dashboard/src/trasa.ts`
- Create: `apps/dashboard/test/file-input.test.ts`
- Create: `apps/dashboard/test/follow-up-action.test.ts`

**Interfaces:**
- Consumes: `api.wyslijPlik`, `api.uruchomWejscie`, and `buildCreateRunRequest` from Task 2.
- Produces: `FileFieldState = { readonly pending: number; readonly problem?: Problem }` and `onFileState(pointer, state)` between `Formularz` and `WidokOperacji`.
- Produces: `executeFollowUp(action, targetId)` for deterministic invoke-operation and open-link behavior.
- Produces: interactive `browser-launch` artifacts and follow-up actions that receive `targetId` and `run.id` from `Przebieg`.
- Extends: `Trasa` with optional `input?: JsonObject`; `idz(trasa, { replace?, state? })` writes that input to `history.state`, and the destination `WidokOperacji` consumes it exactly once as its initial form value.

- [ ] **Step 1: Write failing file-state and action tests**

```ts
test("an uploaded file stores only the returned FileReference", async () => {
  const reference = await uploadFiles([new File(["x"], "x.txt")], false, async () => ({
    ok: true,
    dane: { file: validFileReference },
  }));
  assert.deepEqual(reference, validFileReference);
});

test("multiple file mode preserves selected order", async () => {
  const files = [new File(["a"], "a.txt"), new File(["b"], "b.txt")];
  const result = await uploadFiles(files, true, async (file) => ({
    ok: true,
    dane: { file: { ...validFileReference, uploadId: file.name, name: file.name } },
  }));
  assert.deepEqual((result as readonly FileReference[]).map(({ name }) => name), ["a.txt", "b.txt"]);
});

test("invoke-operation follow-up creates an internal Gauntlet route", () => {
  assert.equal(followUpPath({
    kind: "invoke-operation",
    label: "Open reset",
    operationId: "reset-user",
  }, "portal"), "/t/portal/o/reset-user");
});
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `pnpm exec tsx --test apps/dashboard/test/file-input.test.ts apps/dashboard/test/follow-up-action.test.ts`

Expected: FAIL because the pure upload and action helpers do not exist.

- [ ] **Step 3: Implement the file widget against `InputHandlingRule`**

For the field pointer, find the matching `kind: "file"` rule. Set `accept` from `mediaTypes`, set `multiple`, upload files sequentially to preserve order, and call `onFileState(pointer, { pending })` around every request. Store a single `FileReference` or an array according to the rule. A failed upload leaves the previous input value unchanged and displays the sanitized Problem.

```tsx
<input
  id={idPola}
  type="file"
  accept={rule.mediaTypes?.join(",")}
  multiple={rule.multiple}
  disabled={wylaczone || state.pending > 0}
  onChange={(event) => void wybierzPliki([...event.currentTarget.files ?? []])}
/>
```

`WidokOperacji` keeps a `ReadonlyMap<JsonPointer, FileFieldState>` and disables both execution buttons while any `pending > 0`.

- [ ] **Step 4: Use the canonical request builder in `WidokOperacji`**

Replace the inline request object with `buildCreateRunRequest`. Keep the visible confirmation dialog for non-dry execution. A confirmation-required dry-run may skip the destructive visual dialog because it does not mutate, but its payload still includes the acknowledgement required by the runtime contract.

- [ ] **Step 5: Implement all three follow-up action kinds and session launch**

- `invoke-operation`: use `idz({ targetId, operacjaId: action.operationId })`; preserve `action.input` as route navigation state owned by `trasa.ts` and initialize the destination form from it.
- `open-link`: render an anchor with `target="_blank"` and `rel="noreferrer noopener"`.
- `browser-launch`: render a button that calls `api.uruchomWejscie(targetId, run.id, artifactId)` and opens only `result.dane.url`; show the returned Problem if launch fails.

Pass `targetId` into `Przebieg` explicitly:

```tsx
<Przebieg
  targetId={targetId}
  run={run}
  onPrzerwij={onPrzerwij}
  onPonow={onPonow}
/>
```

Use this exact navigation-state boundary so operation input never appears in a URL or browser log:

```ts
export interface Trasa {
  readonly targetId?: string;
  readonly operacjaId?: string;
  readonly input?: JsonObject;
}

export interface IdzOptions {
  readonly replace?: boolean;
}

export function idz(trasa: Trasa, options: IdzOptions = {}): void {
  const url = sciezka(trasa);
  const state = trasa.input === undefined ? null : { gauntletInput: trasa.input };
  history[options.replace ? "replaceState" : "pushState"](state, "", url);
  dispatchEvent(new PopStateEvent("popstate", { state }));
}
```

`App` reads `event.state?.gauntletInput`, passes it as `initialInput`, then immediately calls `history.replaceState(null, "", location.href)` after `WidokOperacji` has copied it into component state. The existing schema default builder supplies the initial value when navigation state is absent.

- [ ] **Step 6: Run unit tests and dashboard build to confirm GREEN**

Run: `pnpm --filter @8lines/gauntlet-dashboard test`

Expected: PASS including upload ordering and all follow-up action kinds.

Run: `pnpm --filter @8lines/gauntlet-dashboard build`

Expected: PASS without the current “file upload is not connected” copy in compiled output.

- [ ] **Step 7: Commit complete UI actions**

```bash
git add apps/dashboard/src/Formularz.tsx apps/dashboard/src/WidokOperacji.tsx \
  apps/dashboard/src/Przebieg.tsx apps/dashboard/src/trasa.ts \
  apps/dashboard/test/file-input.test.ts apps/dashboard/test/follow-up-action.test.ts
git commit -m "feat(dashboard): complete uploads and result actions"
```

### Task 4: Mobile and Desktop Browser Verification

**Files:**
- Modify: `apps/dashboard/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/dashboard/playwright.config.ts`
- Create: `apps/dashboard/e2e/api-fixture.ts`
- Create: `apps/dashboard/e2e/dashboard.spec.ts`
- Modify: `apps/dashboard/src/App.tsx`
- Modify: `apps/dashboard/src/Formularz.tsx`
- Modify: `apps/dashboard/src/Przebieg.tsx`
- Modify: `apps/dashboard/src/WidokOperacji.tsx`
- Modify: `apps/dashboard/src/ui.tsx`
- Modify: `apps/dashboard/src/index.css`

**Interfaces:**
- Consumes: compiled Vite dashboard and same-origin routes mocked by `api-fixture.ts` with protocol-valid documents.
- Produces: `test:e2e` package script and Playwright projects `mobile` at 390×844 and `desktop` at 1440×900.
- Produces: browser evidence for target navigation, form execution, confirmation in normal and dry-run modes, upload, progress, result actions, cancellation, and local overflow containment.

- [ ] **Step 1: Add Playwright and a deterministic production-preview config**

```json
// apps/dashboard/package.json merged values
{
  "scripts": {
    "test:e2e": "playwright test"
  },
  "dependencies": {
    "@fontsource-variable/figtree": "5.3.0",
    "@fontsource-variable/jetbrains-mono": "5.3.0",
    "react": "19.2.8",
    "react-dom": "19.2.8"
  },
  "devDependencies": {
    "@playwright/test": "1.55.0",
    "@tailwindcss/vite": "4.3.3",
    "@types/react": "19.2.14",
    "@types/react-dom": "19.2.3",
    "@vitejs/plugin-react": "6.1.1",
    "tailwindcss": "4.3.3",
    "typescript": "7.0.2",
    "vite": "8.2.2"
  }
}
```

```ts
// apps/dashboard/playwright.config.ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  webServer: {
    command: "pnpm exec vite preview --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173/",
    reuseExistingServer: false,
  },
  use: { baseURL: "http://127.0.0.1:4173" },
  projects: [
    { name: "mobile", use: { viewport: { width: 390, height: 844 } } },
    { name: "desktop", use: { viewport: { width: 1440, height: 900 } } },
  ],
});
```

Run: `pnpm install --lockfile-only`

Expected: lockfile records Playwright and replaces every external dashboard dependency range with its exact currently resolved version; `workspace:*` remains the internal workspace link convention.

- [ ] **Step 2: Write failing end-to-end workflows**

The API fixture intercepts only `/api/v1/**`, returns protocol-valid target, operation, upload, run, poll, cancel, and launch responses, and records request bodies in page-visible test state.

```ts
test("mobile execution stays inside the viewport and confirms both modes", async ({ page }) => {
  await installApiFixture(page, { operation: destructiveDryRunOperation });
  await page.goto("/");
  await page.getByRole("button", { name: "☰" }).click();
  await page.getByRole("button", { name: destructiveDryRunOperation.label }).click();

  await page.getByRole("button", { name: "Uruchom próbnie" }).click();
  await expect.poll(() => recordedRuns(page)).toMatchObject([{
    dryRun: true,
    confirmation: {
      operationId: destructiveDryRunOperation.id,
      operationRevision: destructiveDryRunOperation.revision,
      impact: "destructive",
    },
  }]);

  await page.getByRole("button", { name: /usuń$/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: /usuń$/ }).click();
  await expect.poll(() => recordedRuns(page)).toMatchObject([
    { dryRun: true },
    {
      dryRun: false,
      confirmation: {
        operationId: destructiveDryRunOperation.id,
        operationRevision: destructiveDryRunOperation.revision,
        impact: "destructive",
      },
    },
  ]);

  const widths = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(widths.document).toBe(widths.viewport);
});
```

Add a desktop workflow for file upload, polling, cancellation, wide table containment, internal operation follow-up, external link attributes, and session launch. Add a reduced-motion test asserting `.kursor` has `animation-name: none` under `reducedMotion: "reduce"`.

- [ ] **Step 3: Build and run E2E to confirm RED**

Run: `pnpm --filter @8lines/gauntlet-dashboard build`

Expected: PASS and production assets exist for the preview server.

Run: `pnpm --filter @8lines/gauntlet-dashboard test:e2e`

Expected: FAIL on mobile document overflow, dialog containment, incomplete action behavior, or confirmation fixture assertions.

- [ ] **Step 4: Apply targeted responsive and semantic corrections**

- Change the shell from `h-screen` to `h-dvh`.
- Give `<main>` `min-w-0 overflow-x-hidden`.
- Make the operation action group `w-full flex-col sm:w-auto sm:flex-row`, with full-width buttons below `sm`.
- Give interactive controls at least `min-h-11` on touch layouts.
- Make the dialog align to the viewport bottom below `sm`, cap it at `max-h-[calc(100dvh-2rem)]`, and make only its content region vertically scrollable.
- Make tabs and wide artifacts scroll within their cards.
- Change timeline timestamp width to `w-24 sm:w-40` and allow the content to wrap.
- Change key-value output to one column below `sm` and the two-column definition list at `sm` and above.
- Remove the invalid nested `<p>` in the current validation-error card.
- Render structured environment text as `environment.name` plus `environment.kind`, never `[object Object]`.

- [ ] **Step 5: Run both viewport projects and confirm GREEN**

Run: `pnpm --filter @8lines/gauntlet-dashboard build`

Expected: PASS.

Run: `pnpm --filter @8lines/gauntlet-dashboard test:e2e -- --project=mobile`

Expected: PASS with no document-level horizontal overflow.

Run: `pnpm --filter @8lines/gauntlet-dashboard test:e2e -- --project=desktop`

Expected: PASS with upload, result, cancellation, and launch workflows.

- [ ] **Step 6: Commit browser coverage and responsive fixes**

```bash
git add apps/dashboard/package.json apps/dashboard/playwright.config.ts \
  apps/dashboard/e2e apps/dashboard/src pnpm-lock.yaml
git commit -m "test(dashboard): verify mobile and desktop workflows"
```

### Task 5: Static Dashboard Serving Without API Masking

**Files:**
- Modify: `apps/server/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/problem-response.ts`
- Create: `apps/server/test/dashboard-static.test.ts`
- Modify: `apps/server/test/routes.integration.test.ts`

**Interfaces:**
- Consumes: `CreateAppOptions.dashboardDir?: string` from the current uncommitted static-serving work and `serverEnvironment` from the safety plan's `apps/server/test/support/environment.ts`.
- Produces: `registerDashboard(app, dashboardDir): Promise<void>` that treats omission as headless and an explicit invalid directory as a startup error.
- Produces: `isSpaNavigation(request): boolean`, requiring `GET`, HTML acceptance, and a non-reserved path.
- Pins: external runtime dependency `@fastify/static` to exact version `10.1.3`.
- Preserves: fixed RFC 9457 Problems, invalid raw path handling, 405 `allow` behavior, and static asset 404 behavior.

- [ ] **Step 1: Write failing filesystem-backed static-serving tests**

```ts
test("serves root, hashed assets, and extensionless browser routes", async () => {
  await usingDashboardDirectory(async (dashboardDir, index) => {
    const app = await createApp({ environment: serverEnvironment, targets, dashboardDir });
    try {
      const root = await app.inject({ method: "GET", url: "/", headers: { accept: "text/html" } });
      assert.equal(root.statusCode, 200);
      assert.equal(root.body, index);

      const route = await app.inject({
        method: "GET",
        url: "/t/portal/o/change-date",
        headers: { accept: "text/html,application/xhtml+xml" },
      });
      assert.equal(route.statusCode, 200);
      assert.equal(route.body, index);

      const asset = await app.inject({ method: "GET", url: "/assets/app-abc123.js" });
      assert.equal(asset.statusCode, 200);
      assert.match(String(asset.headers["content-type"]), /^text\/javascript|application\/javascript/);
    } finally {
      await app.close();
    }
  });
});

test("reserved and non-navigation routes never fall through to the SPA", async () => {
  for (const request of [
    { method: "GET", url: "/api", headers: { accept: "text/html" } },
    { method: "GET", url: "/api/v1/missing", headers: { accept: "text/html" } },
    { method: "POST", url: "/t/portal/o/change-date" },
    { method: "GET", url: "/assets/missing.js", headers: { accept: "*/*" } },
  ]) {
    const response = await app.inject(request);
    assert.equal(response.statusCode, 404);
    assert.match(String(response.headers["content-type"]), /^application\/problem\+json/);
  }
});
```

- [ ] **Step 2: Add a failing missing-directory test**

```ts
test("an explicit dashboard directory without index.html fails startup", async () => {
  await assert.rejects(
    createApp({
      environment: serverEnvironment,
      targets,
      dashboardDir: "/definitely-missing-gauntlet-dashboard",
    }),
    /dashboard index is missing/i,
  );
  const headless = await createApp({ environment: serverEnvironment, targets });
  await headless.close();
});
```

- [ ] **Step 3: Run focused server tests and confirm RED**

Run: `pnpm exec tsx --test apps/server/test/dashboard-static.test.ts`

Expected: FAIL because the current code silently accepts a missing directory and falls back too broadly.

- [ ] **Step 4: Narrow the static registration and fallback predicates**

Pin `@fastify/static` from `^10.1.3` to `10.1.3` and refresh only the lockfile metadata with `pnpm install --lockfile-only`. Resolve the dashboard root, require a regular `index.html` file when the option is present, register `@fastify/static` with `wildcard: false`, and serve the fallback only when this predicate is true:

```ts
function isSpaNavigation(request: FastifyRequest): boolean {
  const pathname = rawPathname(request);
  const accept = request.headers.accept ?? "";
  return request.method === "GET"
    && accept.split(",").some((entry) => entry.trim().startsWith("text/html"))
    && pathname !== "/api"
    && !pathname.startsWith("/api/")
    && pathname !== "/health"
    && pathname !== "/ready"
    && !pathname.startsWith("/assets/");
}
```

Keep percent-containing raw paths at 400 before this predicate. Set `Cache-Control: no-cache` for `index.html` and `Cache-Control: public, max-age=31536000, immutable` only for Vite-hashed assets matching `/assets/.+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+`.

- [ ] **Step 5: Run static and routing tests to confirm GREEN**

Run: `pnpm exec tsx --test apps/server/test/dashboard-static.test.ts apps/server/test/routes.integration.test.ts`

Expected: PASS; API Problems and methods remain unchanged.

Run: `pnpm --filter @8lines/gauntlet-server typecheck`

Expected: PASS.

- [ ] **Step 6: Commit static serving**

```bash
git add apps/server/package.json apps/server/src/app.ts apps/server/src/problem-response.ts \
  apps/server/test/dashboard-static.test.ts apps/server/test/routes.integration.test.ts pnpm-lock.yaml
git commit -m "feat(server): serve dashboard without masking API errors"
```

### Task 6: Minimal All-in-One Runtime Image

**Files:**
- Modify: `Dockerfile`
- Modify: `.dockerignore`
- Create: `scripts/verify-product-image.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: compiled `apps/server/dist`, server production dependencies, and compiled `apps/dashboard/dist`.
- Produces: Docker target `runtime` containing `/app/dist/main.js`, `/app/node_modules`, and `/app/dashboard/index.html`.
- Produces: default `GAUNTLET_CONFIG_FILE=/etc/gauntlet/config.yaml` and `GAUNTLET_DASHBOARD_DIR=/app/dashboard`.
- Produces: root script `test:image` invoking `node scripts/verify-product-image.mjs`.

- [ ] **Step 1: Write a failing image-layout verifier**

```js
// scripts/verify-product-image.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function run(command, args, expected = 0) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: "pipe" });
  assert.equal(result.status, expected, `${command}: ${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

run("docker", ["build", "--target", "runtime", "-t", "gauntlet:product-test", "."]);
run("docker", [
  "run", "--rm", "--entrypoint", "node", "gauntlet:product-test", "-e",
  `const assert=require("node:assert/strict"); const fs=require("node:fs");
   for (const path of ["/app/dist/main.js","/app/dashboard/index.html"]) assert(fs.existsSync(path), path);
   for (const path of ["/app/src","/app/test","/app/apps","/app/packages","/app/node_modules/typescript","/app/node_modules/vite"])
     assert(!fs.existsSync(path), path);`,
]);
const config = JSON.parse(run("docker", ["image", "inspect", "gauntlet:product-test"]))[0].Config;
const user = config.User;
assert.notEqual(user, "");
assert.notEqual(user, "0");
assert.notEqual(user, "root");
assert.equal(config.Env.includes("GAUNTLET_CONFIG_FILE=/etc/gauntlet/config.yaml"), true);
assert.equal(config.Env.includes("GAUNTLET_DASHBOARD_DIR=/app/dashboard"), true);
```

- [ ] **Step 2: Run the image verifier and confirm RED**

Run: `node scripts/verify-product-image.mjs`

Expected: FAIL because the current runtime image has no `/app/dashboard/index.html`.

- [ ] **Step 3: Extend the build stage for dashboard dependencies and output**

Copy `apps/dashboard/package.json` before the frozen install. Include both `@8lines/gauntlet-server...` and `@8lines/gauntlet-dashboard...` filters. Copy dashboard source after dependency installation, build the dashboard and server dependency closures, deploy only server production dependencies to `/out`, and separately preserve `apps/dashboard/dist` for the runtime copy.

```dockerfile
COPY apps/dashboard/package.json ./apps/dashboard/
RUN --mount=type=cache,id=gauntlet-pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm --filter @8lines/gauntlet-server... \
         --filter @8lines/gauntlet-dashboard... \
         install --frozen-lockfile
COPY apps/dashboard ./apps/dashboard
RUN pnpm --filter @8lines/gauntlet-dashboard... build
RUN pnpm --filter @8lines/gauntlet-server... build
```

- [ ] **Step 4: Copy only runtime server and dashboard artifacts**

```dockerfile
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
ENV GAUNTLET_CONFIG_FILE=/etc/gauntlet/config.yaml
ENV GAUNTLET_DASHBOARD_DIR=/app/dashboard
WORKDIR /app
COPY --chown=node:node --from=build /out/ ./
COPY --chown=node:node --from=build /app/apps/dashboard/dist ./dashboard
USER node
EXPOSE 8080
STOPSIGNAL SIGTERM
CMD ["node", "dist/main.js"]
```

Retain server source maps emitted under `/app/dist` because they are compiled release artifacts useful for stack traces. The verifier still rejects `/app/src`, `/app/test`, dashboard source, TypeScript, and Vite so the runtime image contains no editable source tree or build toolchain.

- [ ] **Step 5: Add the root verification command**

```json
{
  "scripts": {
    "test:image": "node scripts/verify-product-image.mjs"
  }
}
```

- [ ] **Step 6: Run image and workspace verification to confirm GREEN**

Run: `pnpm test:image`

Expected: PASS; the image contains UI and API artifacts and uses the non-root `node` user.

Run: `pnpm build`

Expected: PASS.

Run: `pnpm typecheck`

Expected: PASS.

Run: `pnpm test`

Expected: PASS.

- [ ] **Step 7: Commit the product image**

```bash
git add Dockerfile .dockerignore scripts/verify-product-image.mjs package.json
git commit -m "build: package dashboard and API in one image"
```
