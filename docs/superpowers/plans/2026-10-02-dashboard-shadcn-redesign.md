# Dashboard redesign on shadcn/ui Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Gauntlet dashboard and widget panel on stock shadcn/ui following the approved design rules, add the catalog table, run URLs and recent runs, and prepare release 0.1.8.

**Architecture:** Logic modules without JSX stay at `apps/dashboard/src/*.ts` and keep their unit tests; new pure logic is added there test-first. Presentation is rewritten into `src/components/ui` (shadcn CLI output), `src/components/gauntlet` (our composites), `src/app` (shell) and `src/screens`. The old presentation files are deleted at the end. Each screen task also rewrites the Playwright spec for its area.

**Tech Stack:** React 19, Vite 8, Tailwind CSS 4, shadcn/ui (new-york, Radix), lucide-react, cmdk, Geist via Fontsource, node:test via tsx, Playwright 1.55, @axe-core/playwright.

**Spec:** `docs/superpowers/specs/2026-10-02-dashboard-shadcn-redesign-design.md`. Visual reference: `docs/mockups/dashboard-shadcn.html` (open it in a browser; the grey toolbar switches screens, `#operation` etc. open one directly; `&dark` forces dark).

## Global Constraints

- Work on branch `feat/dashboard-shadcn` (already exists, based on `origin/main` at v0.1.7). Commit after every task. Commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Code, comments, file names and identifiers in English.
- Package manager: pnpm. All dashboard commands run from `apps/dashboard` unless stated.
- Unit tests: `pnpm --filter @8lines/gauntlet-dashboard test` (tsx + node:test, no DOM). Logic modules imported by unit tests must not import `@/…` paths, React components, or CSS.
- Imports in existing code use explicit `.ts`/`.tsx` extensions; keep that in our own files. shadcn-generated files keep their extensionless `@/` imports.
- Fonts: Geist and Geist Mono only, self-hosted through `@fontsource-variable/geist` and `@fontsource-variable/geist-mono`. Mono only for identifiers and machine text.
- Type roles only: 24/32 600, 20/28 600, 16/24 600, 14/20 400 (body, table cells), 14/20 500 (labels, row labels, headers), 13/18 400 (compact), 12/16 400 (metadata, never sentences). Tailwind classes: `text-2xl/8 font-semibold`, `text-xl/7 font-semibold`, `text-base/6 font-semibold`, `text-sm/5`, `text-sm/5 font-medium`, `text-[13px]/[18px]`, `text-xs/4`.
- Colour only for state, always with a word and, for impact, a mark: ○ read only, ◐ changes data, ● deletes data. No tinted fills; warning/error callouts use a 1 px state border. Only the destructive action button is red.
- No cards except the operation form and dialogs; no cards inside cards; badges only for state (impact, run state, unavailable); no icon per nav item/row; stats as one strip.
- No em dash (`—`) in any user-facing string. No all-caps or tracked labels. No `→` on buttons; `↗` only on external links.
- Radius 6 px controls (`rounded-md` with `--radius: 0.5rem` gives `rounded-md` = 6 px), 8 px containers (`rounded-lg`). Shadows only on overlays.
- One `h1` per screen; visible 2 px focus ring; WCAG AA; reduce motion disables transitions.
- Keep unchanged: `api.ts`, `json-pointer.ts`, `create-run-request.ts`, widget `handshake.ts`, `placements.ts`, `prefill.ts`, `search.ts`, `view.ts`, `usePanelChannel.ts`, `usePanelTarget.ts`, `usePanelCatalog.ts`.
- No protocol, adapter or server changes.

## Review Focus

1. Reloading a run URL while the run is still running: the run view appears and keeps polling until a terminal state; a run that 404s shows "This run is no longer available" with a way back to the form. (Task 6 e2e)
2. A follow-up "invoke-operation" targeting the operation that is currently showing a run on its run URL: the form reopens with the follow-up input and no stale run. (Task 6 e2e)
3. Blocked or corrupted `localStorage` (`gauntlet.recent-runs.v1` holding invalid JSON): overview and widget still render, recent runs list is empty. (Task 2 unit + Task 9 e2e)
4. Catalog filter with no matches, mixed case, or matching only the operation id; unavailable operations stay listed and not clickable. (Task 2 unit + Task 9 e2e)
5. Theme "system": the dark class is applied before first paint and follows an OS change live, in both the dashboard and the widget panel. (Task 1 unit + Task 8 e2e)

---

### Task 1: Foundation: shadcn, tokens, fonts, theme

**Files:**
- Modify: `apps/dashboard/package.json`, `apps/dashboard/tsconfig.json`, `apps/dashboard/vite.config.ts`, `apps/dashboard/vite.widget.config.ts`, `apps/dashboard/src/preferences.ts`
- Create: `apps/dashboard/components.json`, `apps/dashboard/src/lib/utils.ts`, `apps/dashboard/src/components/ui/*`, `apps/dashboard/src/legacy.css` (moved from `index.css`)
- Rewrite: `apps/dashboard/src/index.css`
- Test: `apps/dashboard/test/preferences.test.ts`

**Interfaces:**
- Produces: `cn(...classes)` from `@/lib/utils`; shadcn components under `@/components/ui/<name>`; `resolveTheme(theme: Theme, systemDark: boolean): "light" | "dark"` from `src/preferences.ts`; Tailwind colour utilities `bg-ok`, `text-ok`, `border-ok`, `text-warn`, `border-warn`, `text-err`, `border-err`, `ring-focus`, `text-focus`.

- [ ] **Step 1: Record the bundle baseline**

Run from `apps/dashboard`:

```bash
pnpm --filter @8lines/gauntlet-widget-loader build && pnpm build
du -k dist-widget/assets/*.js dist-widget/assets/*.css dist/assets/*.js dist/assets/*.css | sort -n
```

Write the numbers into the task report; Task 11 compares against them.

- [ ] **Step 2: Write the failing theme test**

Create `apps/dashboard/test/preferences.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveTheme } from "../src/preferences.ts";

test("explicit themes ignore the system preference", () => {
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
});

test("system theme follows the operating system", () => {
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @8lines/gauntlet-dashboard test`
Expected: FAIL, `resolveTheme` is not exported.

- [ ] **Step 4: Implement `resolveTheme` and switch to the `.dark` class**

In `src/preferences.ts` replace `applyPreferences` with:

```ts
export function resolveTheme(theme: Theme, systemDark: boolean): "light" | "dark" {
  return theme === "system" ? (systemDark ? "dark" : "light") : theme;
}

export function applyPreferences(preferences: Preferences): void {
  const root = document.documentElement;
  const theme = resolveTheme(
    preferences.theme,
    globalThis.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
  root.dataset.motion = preferences.reducedMotion ? "reduce" : "system";
}
```

Remove the `dataset.theme` write. Run the tests: PASS.

- [ ] **Step 5: Add the path alias**

`tsconfig.json` `compilerOptions` gains `"baseUrl": "."` and `"paths": { "@/*": ["./src/*"] }`. Both Vite configs gain:

```ts
import { fileURLToPath } from "node:url";
// …
resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
```

- [ ] **Step 6: Initialise shadcn and add components**

From `apps/dashboard`:

```bash
pnpm dlx shadcn@latest init
```

Answer: style New York, base colour Neutral, CSS variables yes, CSS file `src/index.css`, components alias `@/components`, utils `@/lib/utils`, icon library lucide. If the CLI rewrites `src/index.css`, that is fine; Step 7 replaces it. Then:

```bash
pnpm dlx shadcn@latest add sidebar button badge card input textarea label select checkbox switch tabs table dialog alert-dialog command sheet dropdown-menu popover tooltip progress separator skeleton collapsible scroll-area alert radio-group breadcrumb
pnpm add @fontsource-variable/geist @fontsource-variable/geist-mono
pnpm remove @fontsource-variable/manrope @fontsource-variable/jetbrains-mono
```

Check `components.json` has `"style": "new-york"`, `"tailwind": { "css": "src/index.css", "baseColor": "neutral", "cssVariables": true }`, `"aliases": { "components": "@/components", "utils": "@/lib/utils", "ui": "@/components/ui", "lib": "@/lib", "hooks": "@/hooks" }`. Pin every new dependency to an exact version in `package.json` (the repo pins exact versions; remove `^`).

- [ ] **Step 7: Write the token stylesheet**

`git mv src/index.css src/legacy.css`. In `legacy.css` delete the three `@import` lines at the top and, inside `@theme`, delete these tokens (now owned by the new file): `--color-background`, `--color-foreground`, `--color-muted`, `--color-muted-foreground`, `--color-border`, `--color-input`, `--color-accent`, `--color-primary`, `--color-primary-foreground`, `--color-ring`, `--color-destructive`, `--font-sans`, `--font-mono`; delete the same names from its `:root[data-theme="dark"]` block and change that selector to `:root.dark`. Create `src/index.css`:

```css
@import "tailwindcss";
@import "tw-animate-css";
@import "@fontsource-variable/geist";
@import "@fontsource-variable/geist-mono";
@import "./legacy.css";

@custom-variant dark (&:is(.dark *));

:root {
  --radius: 0.5rem;
  --background: #ffffff;
  --foreground: #171717;
  --card: #ffffff;
  --card-foreground: #171717;
  --popover: #ffffff;
  --popover-foreground: #171717;
  --primary: #171717;
  --primary-foreground: #ffffff;
  --secondary: #f5f5f5;
  --secondary-foreground: #171717;
  --muted: #fafafa;
  --muted-foreground: #666666;
  --accent: #f5f5f5;
  --accent-foreground: #171717;
  --destructive: #cb2a2f;
  --border: #ebebeb;
  --input: #d4d4d4;
  --ring: #0a72ef;
  --ok: #107d32;
  --warn: #a35200;
  --err: #cb2a2f;
  --focus: #0a72ef;
  --sidebar: #fafafa;
  --sidebar-foreground: #171717;
  --sidebar-primary: #171717;
  --sidebar-primary-foreground: #ffffff;
  --sidebar-accent: #ebebeb;
  --sidebar-accent-foreground: #171717;
  --sidebar-border: #ebebeb;
  --sidebar-ring: #0a72ef;
}

.dark {
  --background: #0a0a0a;
  --foreground: #ededed;
  --card: #0a0a0a;
  --card-foreground: #ededed;
  --popover: #111111;
  --popover-foreground: #ededed;
  --primary: #ededed;
  --primary-foreground: #0a0a0a;
  --secondary: #1a1a1a;
  --secondary-foreground: #ededed;
  --muted: #111111;
  --muted-foreground: #a1a1a1;
  --accent: #1a1a1a;
  --accent-foreground: #ededed;
  --destructive: #ff6166;
  --border: #242424;
  --input: #3d3d3d;
  --ring: #3b9eff;
  --ok: #4cc274;
  --warn: #f0a23b;
  --err: #ff6166;
  --focus: #3b9eff;
  --sidebar: #111111;
  --sidebar-foreground: #ededed;
  --sidebar-primary: #ededed;
  --sidebar-primary-foreground: #0a0a0a;
  --sidebar-accent: #242424;
  --sidebar-accent-foreground: #ededed;
  --sidebar-border: #242424;
  --sidebar-ring: #3b9eff;
}

@theme inline {
  --font-sans: "Geist Variable", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "Geist Mono Variable", ui-monospace, SFMono-Regular, monospace;
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-ok: var(--ok);
  --color-warn: var(--warn);
  --color-err: var(--err);
  --color-focus: var(--focus);
  --color-sidebar: var(--sidebar);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar-primary: var(--sidebar-primary);
  --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
  --color-sidebar-accent: var(--sidebar-accent);
  --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
  --color-sidebar-border: var(--sidebar-border);
  --color-sidebar-ring: var(--sidebar-ring);
}

@layer base {
  * { @apply border-border outline-ring/50; }
  html, body, #root { height: 100%; }
  body { @apply bg-background text-foreground font-sans text-sm/5 antialiased; font-variant-numeric: tabular-nums; }
  :focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  html[data-motion="reduce"] *, html[data-motion="reduce"] *::before, html[data-motion="reduce"] *::after {
    animation-duration: 0s !important; transition-duration: 0s !important;
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; }
  }
}
```

If `tw-animate-css` was not installed by `init`, run `pnpm add tw-animate-css` (exact version). `src/widget/widget.css` keeps `@import "../index.css";` and `@source "..";`.

- [ ] **Step 8: Verify**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: all pass. Open `pnpm dev` against the local stack (`docs/local-development.md`) and confirm the app still renders (old screens, new colours and Geist). Mixed styling is expected until the screen tasks land.

- [ ] **Step 9: Commit**

```bash
git add -A apps/dashboard pnpm-lock.yaml
git commit -m "feat(dashboard): add shadcn/ui foundation with Geist and design tokens"
```

---

### Task 2: Logic modules for the new UI

**Files:**
- Create: `src/run-actions.ts` (moved from `RunDetails.tsx`), `src/form-upload.ts` (moved from `OperationForm.tsx`), `src/operation-errors.ts`, `src/catalog.ts`, `src/recent-runs.ts` (moved from `src/widget/recent-runs.ts`), `src/browser-storage.ts` (moved from `src/widget/storage.ts`)
- Modify: `src/route.ts`, `src/copy.ts`, `src/useOperationDetails.ts`, `src/RunDetails.tsx`, `src/OperationForm.tsx`, `src/OperationScreen.tsx`, `src/widget/Panel.tsx`, `src/widget/RecentRunView.tsx`, `src/widget/OperationLists.tsx` (import paths only)
- Test: `test/follow-up-action.test.ts`, `test/file-input.test.ts`, `test/widget-recent-runs.test.ts` (import paths, key), new `test/route.test.ts`, `test/operation-errors.test.ts`, `test/catalog.test.ts`, `test/copy.test.ts`

**Interfaces:**
- Produces:
  - `route.ts`: `Route` gains `readonly runId?: string`; `parseRoute("/t/a/o/b/r/c")` → `{ targetId: "a", operationId: "b", runId: "c" }`; `routePath` emits `/t/a/o/b/r/c`.
  - `run-actions.ts`: `followUpPath`, `executeFollowUp`, `beginBrowserLaunch`, types `FollowUpEffects`, `BrowserPopup`, `BrowserLaunchDependencies`, `BrowserLaunchAttempt` (unchanged signatures).
  - `form-upload.ts`: `uploadFiles`, `UploadProblem`, `fileRuleForPointer`, `fieldValueUpdater`, types `FileFieldState`, `FormValues`, `FormValuesUpdater` (unchanged signatures).
  - `operation-errors.ts`: `attachToFields(errors: readonly ValidationError[]): readonly ValidationError[]`, `generalErrors(errors: readonly ValidationError[]): readonly string[]`.
  - `catalog.ts`: `type Impact = "read" | "write" | "destructive"`; `policySummary(definition: OperationDefinition): string`; `impactCounts(definitions: readonly OperationDefinition[]): Readonly<Record<Impact, number>>`; `impactBreakdown(counts: Readonly<Record<Impact, number>>): string`; `filterOperations(operations: readonly OperationSummary[], query: string): readonly OperationSummary[]`.
  - `copy.ts`: `impactLabel(impact: Impact): string` ("read only" | "changes data" | "deletes data"); `IMPACT_MARK: Readonly<Record<Impact, "○" | "◐" | "●">>`; `runButtonLabel(definition)` returns `definition.label`; `RUN_STATES` labels become sentence case words ("Queued", "Running", "Done", "Failed", "Partial", "Cancelled", "Timed out", "Expired").
  - `recent-runs.ts`: `RECENT_RUNS_KEY = "gauntlet.recent-runs.v1"`, rest unchanged. `browser-storage.ts`: `browserStorage: StorageLike` (was `panelStorage`).
  - `useOperationDetails.ts`: each detail gains `readonly definition?: OperationDefinition` (set when the revision matches).

- [ ] **Step 1: Move code without behaviour change**

Move the named exports listed above into their new files verbatim (keep their doc comments), re-export nothing from the old files, and update every importer (source and tests) to the new paths. `widget/storage.ts` becomes `src/browser-storage.ts` with the export renamed to `browserStorage`. Run `pnpm typecheck && pnpm test`: PASS.

- [ ] **Step 2: Write failing tests for the new logic**

`test/route.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRoute, routePath } from "../src/route.ts";

test("run URLs round-trip", () => {
  const route = { targetId: "shop staging", operationId: "customers.create", runId: "run_01J9" };
  assert.equal(routePath(route), "/t/shop%20staging/o/customers.create/r/run_01J9");
  assert.deepEqual(parseRoute(routePath(route)), route);
});

test("an operation URL has no run", () => {
  assert.deepEqual(parseRoute("/t/a/o/b"), { targetId: "a", operationId: "b" });
});

test("a run segment without an id is ignored", () => {
  assert.deepEqual(parseRoute("/t/a/o/b/r"), { targetId: "a", operationId: "b" });
});
```

`test/operation-errors.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ValidationError } from "@8lines/gauntlet-protocol";
import { attachToFields, generalErrors } from "../src/operation-errors.ts";

const missing = { instancePath: "", keyword: "required", params: { missingProperty: "email" }, message: "must have required property 'email'" } as unknown as ValidationError;
const general = { instancePath: "", keyword: "anyOf", message: "must match a schema in anyOf" } as unknown as ValidationError;

test("a missing required field is attached to that field", () => {
  assert.equal(attachToFields([missing])[0]!.instancePath, "/email");
});

test("errors without a field stay general and are de-duplicated", () => {
  assert.deepEqual(generalErrors(attachToFields([missing, general, general])), ["must match a schema in anyOf"]);
});
```

`test/catalog.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { OperationDefinition, OperationSummary } from "@8lines/gauntlet-protocol";
import { filterOperations, impactBreakdown, impactCounts, policySummary } from "../src/catalog.ts";

function definition(execution: Partial<OperationDefinition["execution"]>, presets = 0): OperationDefinition {
  return {
    execution: {
      impact: "write", dryRunSupported: false, cancellationSupported: false,
      confirmationRequired: false, concurrency: "allow", idempotency: "none", ...execution,
    },
    presets: Array.from({ length: presets }, (_, i) => ({ id: `p${i}`, label: `P${i}` })),
  } as unknown as OperationDefinition;
}

test("policy summary lists what matters before a run, in a fixed order", () => {
  assert.equal(
    policySummary(definition({ dryRunSupported: true, cancellationSupported: true }, 2)),
    "Dry run, can cancel, 2 presets",
  );
  assert.equal(
    policySummary(definition({ impact: "destructive", confirmationRequired: true })),
    "Asks you to confirm, cannot be cancelled",
  );
  assert.equal(
    policySummary(definition({ concurrency: "queue", cancellationSupported: true }, 1)),
    "Waits in a queue, can cancel, 1 preset",
  );
});

test("impact counts and their sentence", () => {
  const counts = impactCounts([
    definition({ impact: "read" }), definition({ impact: "read" }),
    definition({ impact: "write" }), definition({ impact: "destructive" }),
  ]);
  assert.deepEqual(counts, { read: 2, write: 1, destructive: 1 });
  assert.equal(impactBreakdown(counts), "2 read only, 1 changes data, 1 deletes data");
  assert.equal(impactBreakdown({ read: 0, write: 3, destructive: 2 }), "3 change data, 2 delete data");
  assert.equal(impactBreakdown({ read: 0, write: 0, destructive: 0 }), "");
});

test("filter matches label or id, ignoring case and surrounding spaces", () => {
  const operations = [
    { id: "customers.create", label: "Create test customer" },
    { id: "search.reset", label: "Reset search index" },
  ] as unknown as OperationSummary[];
  assert.deepEqual(filterOperations(operations, "  CUSTOMER ").map((o) => o.id), ["customers.create"]);
  assert.deepEqual(filterOperations(operations, "search.").map((o) => o.id), ["search.reset"]);
  assert.deepEqual(filterOperations(operations, "nothing"), []);
  assert.equal(filterOperations(operations, "").length, 2);
});
```

`test/copy.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExecutionPolicy, Problem, RunState } from "@8lines/gauntlet-protocol";
import { describeProblem, impactLabel, policyEffects, runStateLabel } from "../src/copy.ts";

const policies: ExecutionPolicy[] = (["read", "write", "destructive"] as const).flatMap((impact) =>
  [true, false].map((flag) => ({
    impact, dryRunSupported: flag, cancellationSupported: flag, confirmationRequired: flag,
    concurrency: flag ? "queue" : "forbid", idempotency: flag ? "required" : "none", timeoutSeconds: 120,
  }) as unknown as ExecutionPolicy),
);
const states: RunState[] = ["queued", "running", "succeeded", "failed", "partial", "cancelled", "timed_out", "expired"];
const problemTypes = [
  "validation-failed", "unsupported-capability", "target-not-found",
  "adapter-protocol-incompatible", "network-unreachable", "unknown",
].map((name) => ({ type: `urn:gauntlet:problem:${name}`, title: "Title", status: 400 }) as Problem);

test("user-facing copy contains no em dash", () => {
  const strings = [
    ...policies.flatMap((p) => policyEffects(p).map((e) => e.text)),
    ...states.map((s) => runStateLabel(s).label),
    ...problemTypes.flatMap((p) => Object.values(describeProblem(p))),
    ...(["read", "write", "destructive"] as const).map(impactLabel),
  ];
  for (const text of strings) assert.ok(!text.includes("—"), text);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @8lines/gauntlet-dashboard test`
Expected: FAIL for route (runId), catalog/operation-errors (missing modules), copy (`impactLabel` missing, em dashes present).

- [ ] **Step 4: Implement**

`route.ts` `parseRoute`: after the operation branch add `if (parts[4] === "r" && parts[5] !== undefined) return { targetId, operationId, runId: decodeURIComponent(parts[5]) };` (compute `targetId`/`operationId` first). `routePath`: append `/r/${encodeURIComponent(route.runId)}` when `operationId` and `runId` are defined.

`operation-errors.ts`: move `attachToFields` and `generalErrors` from `OperationScreen.tsx` (export them, import them back in `OperationScreen.tsx`).

`catalog.ts`:

```ts
import type { OperationDefinition, OperationSummary } from "@8lines/gauntlet-protocol";

export type Impact = OperationDefinition["execution"]["impact"];

/** A short line about what to expect before running, used in the catalog table. */
export function policySummary(definition: OperationDefinition): string {
  const { execution } = definition;
  const parts: string[] = [];
  if (execution.confirmationRequired) parts.push("asks you to confirm");
  if (execution.dryRunSupported) parts.push("dry run");
  if (execution.concurrency === "queue") parts.push("waits in a queue");
  parts.push(execution.cancellationSupported ? "can cancel" : "cannot be cancelled");
  const presets = definition.presets?.length ?? 0;
  if (presets > 0) parts.push(presets === 1 ? "1 preset" : `${presets} presets`);
  const sentence = parts.join(", ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

export function impactCounts(definitions: readonly OperationDefinition[]): Readonly<Record<Impact, number>> {
  const counts: Record<Impact, number> = { read: 0, write: 0, destructive: 0 };
  for (const definition of definitions) counts[definition.execution.impact] += 1;
  return counts;
}

export function impactBreakdown(counts: Readonly<Record<Impact, number>>): string {
  const parts: string[] = [];
  if (counts.read > 0) parts.push(`${counts.read} read only`);
  if (counts.write > 0) parts.push(`${counts.write} ${counts.write === 1 ? "changes" : "change"} data`);
  if (counts.destructive > 0) parts.push(`${counts.destructive} ${counts.destructive === 1 ? "deletes" : "delete"} data`);
  return parts.join(", ");
}

export function filterOperations(operations: readonly OperationSummary[], query: string): readonly OperationSummary[] {
  const needle = query.trim().toLocaleLowerCase("en");
  if (needle === "") return operations;
  return operations.filter((o) => `${o.label} ${o.id}`.toLocaleLowerCase("en").includes(needle));
}
```

`copy.ts`: add

```ts
import type { Impact } from "./catalog.ts";

const IMPACT_LABELS: Readonly<Record<Impact, string>> = { read: "read only", write: "changes data", destructive: "deletes data" };
export const IMPACT_MARK: Readonly<Record<Impact, "○" | "◐" | "●">> = { read: "○", write: "◐", destructive: "●" };
export const impactLabel = (impact: Impact) => IMPACT_LABELS[impact];
```

Rewrite the strings: "You can do a dry run first. You will see the result, but nothing will change."; "Repeating with the same key is safe. It will not duplicate the effect."; `runButtonLabel` returns `definition.label`; run state labels as listed in Interfaces; any other `—` in a returned string is rewritten as two sentences or with a comma. Comments may keep their wording.

`useOperationDetails.ts`: in the success branch add `definition: result.data` to `detail`; extend `OperationDetails` with `readonly definition?: OperationDefinition`.

`recent-runs.ts`: change `RECENT_RUNS_KEY` to `"gauntlet.recent-runs.v1"`; update the test's expectations that reference the key value, if any.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm typecheck && pnpm --filter @8lines/gauntlet-dashboard test`
Expected: PASS (all old and new tests).

- [ ] **Step 6: Commit**

```bash
git add -A apps/dashboard
git commit -m "refactor(dashboard): extract UI-free logic and add catalog, run route and copy rules"
```

---

### Task 3: Gauntlet composites

**Files:**
- Create in `src/components/gauntlet/`: `StateMark.tsx`, `ImpactBadge.tsx`, `RunStateBadge.tsx`, `PolicyList.tsx`, `StatStrip.tsx`, `ProblemAlert.tsx`, `EmptyState.tsx`, `GauntletMark.tsx`

**Interfaces:**
- Consumes: `IMPACT_MARK`, `impactLabel`, `runStateLabel`, `describeProblem`, `type Tone`, `type PolicyEffect` from `src/copy.ts`; `Badge`, `Alert` from shadcn.
- Produces:
  - `StateMark({ tone: Tone; shape?: "○" | "◐" | "●" | "▲" | "✓" | "✕" | "!"; className? })`: an `aria-hidden` glyph coloured by tone (`ok`→`text-ok`, `wait`→`text-warn`, `stop`→`text-err`, `info`→`text-focus`, `sub`→`text-muted-foreground`).
  - `ImpactBadge({ impact: Impact })`: outline Badge "◐ changes data".
  - `RunStateBadge({ state: RunState })`: outline Badge with mark + label (`succeeded` ✓, `failed` ✕, `partial`/`timed_out` !, `queued`/`running` ◐, `cancelled`/`expired` ○).
  - `PolicyList({ effects: readonly PolicyEffect[] })`: `<ul>` of effects, each with a StateMark (`ok` ✓, `wait` ▲, `stop` ✕, `sub` •) and the text.
  - `StatStrip({ items: readonly { label: string; value: string | number; detail?: string }[] })`.
  - `ProblemAlert({ problem: Problem; title?: string; correlationId?: string })`: 1 px `border-err` Alert with title, advice, optional correlation id in mono.
  - `EmptyState({ title: string; description: string; action?: ReactNode })`.
  - `GauntletMark({ className? })`: the monochrome Gauntlet mark (reuse the `logo` paths from `Icon.tsx`, `currentColor`).

- [ ] **Step 1: Implement the composites**

```tsx
// StateMark.tsx
import type { Tone } from "../../copy.ts";
import { cn } from "@/lib/utils";

const TONE_CLASS: Readonly<Record<Tone, string>> = {
  ok: "text-ok", wait: "text-warn", stop: "text-err", info: "text-focus", sub: "text-muted-foreground",
};

export function StateMark({ tone, shape = "●", className }: { tone: Tone; shape?: string; className?: string }) {
  return <span aria-hidden="true" className={cn("inline-block w-3 text-center leading-none", TONE_CLASS[tone], className)}>{shape}</span>;
}
```

```tsx
// ImpactBadge.tsx
import { Badge } from "@/components/ui/badge";
import type { Impact } from "../../catalog.ts";
import { IMPACT_MARK, impactLabel } from "../../copy.ts";
import { StateMark } from "./StateMark.tsx";

const IMPACT_TONE = { read: "ok", write: "wait", destructive: "stop" } as const;

export function ImpactBadge({ impact }: { impact: Impact }) {
  return (
    <Badge variant="outline" className="gap-1.5 font-normal">
      <StateMark tone={IMPACT_TONE[impact]} shape={IMPACT_MARK[impact]} />
      {impactLabel(impact)}
    </Badge>
  );
}
```

```tsx
// RunStateBadge.tsx
import type { RunState } from "@8lines/gauntlet-protocol";
import { Badge } from "@/components/ui/badge";
import { runStateLabel } from "../../copy.ts";
import { StateMark } from "./StateMark.tsx";

const SHAPE: Readonly<Record<RunState, string>> = {
  queued: "◐", running: "◐", succeeded: "✓", failed: "✕", partial: "!", timed_out: "!", cancelled: "○", expired: "○",
};

export function RunStateBadge({ state }: { state: RunState }) {
  const { label, tone } = runStateLabel(state);
  return (
    <Badge variant="outline" className="gap-1.5 font-normal">
      <StateMark tone={tone} shape={SHAPE[state]} />
      {label}
    </Badge>
  );
}
```

```tsx
// PolicyList.tsx
import type { PolicyEffect } from "../../copy.ts";
import { StateMark } from "./StateMark.tsx";

const SHAPE = { ok: "✓", wait: "▲", stop: "✕", info: "•", sub: "•" } as const;

export function PolicyList({ effects }: { effects: readonly PolicyEffect[] }) {
  return (
    <ul className="space-y-2">
      {effects.map((effect) => (
        <li key={effect.text} className="flex gap-2 text-sm/5">
          <StateMark tone={effect.tone} shape={SHAPE[effect.tone]} className="mt-0.5" />
          <span className={effect.tone === "sub" ? "text-muted-foreground" : undefined}>{effect.text}</span>
        </li>
      ))}
    </ul>
  );
}
```

```tsx
// StatStrip.tsx
export function StatStrip({ items }: { items: readonly { label: string; value: string | number; detail?: string }[] }) {
  return (
    <dl className="grid gap-6 border-y py-4 sm:grid-cols-3">
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="text-[13px]/[18px] text-muted-foreground">{item.label}</dt>
          <dd className="mt-1 text-xl/7 font-semibold tabular-nums">{item.value}</dd>
          {item.detail !== undefined && <dd className="mt-1 text-[13px]/[18px] text-muted-foreground">{item.detail}</dd>}
        </div>
      ))}
    </dl>
  );
}
```

```tsx
// ProblemAlert.tsx
import type { Problem } from "@8lines/gauntlet-protocol";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { describeProblem } from "../../copy.ts";
import { StateMark } from "./StateMark.tsx";

export function ProblemAlert({ problem, title, correlationId }: { problem: Problem; title?: string; correlationId?: string }) {
  const described = describeProblem(problem);
  return (
    <Alert className="border-err" role="alert">
      <StateMark tone="stop" shape="✕" />
      <AlertTitle>{title ?? described.title}</AlertTitle>
      <AlertDescription>
        <p>{title === undefined ? described.advice : `${described.title}. ${described.advice}`}</p>
        {correlationId !== undefined && <p className="font-mono text-xs/4">Correlation ID {correlationId}</p>}
      </AlertDescription>
    </Alert>
  );
}
```

```tsx
// EmptyState.tsx
import type { ReactNode } from "react";

export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed px-6 py-8 text-center">
      <p className="text-sm/5 font-medium">{title}</p>
      <p className="mx-auto mt-1 max-w-[52ch] text-[13px]/[18px] text-muted-foreground">{description}</p>
      {action !== undefined && <div className="mt-4">{action}</div>}
    </div>
  );
}
```

`GauntletMark.tsx`: an `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">` containing the two `logo` paths from `Icon.tsx`.

Where the run's correlation id lives: read `run.problem` fields used by the current `RunDetails.tsx` (it prints a correlation line under the problem); pass that value as `correlationId`.

- [ ] **Step 2: Verify**

Run: `pnpm typecheck && pnpm build`
Expected: PASS. (These render inside screens from Task 4 onward, where e2e covers them.)

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/components/gauntlet
git commit -m "feat(dashboard): add Gauntlet state, policy and problem composites"
```

---

### Task 4: Operation form on shadcn controls

**Files:**
- Create: `src/components/gauntlet/operation-form/OperationForm.tsx`, `Field.tsx`, `Choice.tsx`, `Autocomplete.tsx`, `FileInput.tsx`
- Delete: `src/OperationForm.tsx` (after moving)
- Modify: importers of `OperationForm` (`src/OperationScreen.tsx`)

**Interfaces:**
- Consumes: `form-upload.ts` exports; `json-pointer.ts`; `api.uploadFile`, `api.queryDataSource`.
- Produces: `OperationForm(props: OperationFormProps)` with the same props as today (`definition`, `targetId`, `values`, `errors`, `lockedPointers`, `fileStates`, `onChange`, `onFileState`); `layoutFromSchema` and `widgetFromSchema` keep their behaviour.

- [ ] **Step 1: Port the renderer**

Copy the current `OperationForm.tsx` logic into the new folder, split by component, and replace only the markup:

| Today | New |
|---|---|
| `fieldset` group with legend | `fieldset` with `legend className="text-sm/5 font-medium"`, bordered only when it has a label (`rounded-lg border p-4`) |
| `columns` | `grid gap-4 sm:grid-cols-2` |
| custom tabs | shadcn `Tabs` / `TabsList` / `TabsTrigger` / `TabsContent`; a tab whose fields hold an error shows "1 error" in `text-err` next to its label |
| label + "set by the preset" pill | shadcn `Label` (`htmlFor`), required `*` in `text-err` with `aria-hidden`, locked fields show a lucide `Lock` icon and the text "Locked by preset" in `text-xs/4 text-muted-foreground` |
| help text | `p` `text-[13px]/[18px] text-muted-foreground`, linked with `aria-describedby` |
| inputs, number, date, password | shadcn `Input`, `aria-invalid` set on error (shadcn styles `aria-invalid` with the destructive ring) |
| textarea, json, code | shadcn `Textarea` (json/code add `font-mono text-xs/4`) |
| toggle | shadcn `Switch` with `id`, `checked`, `onCheckedChange`, keeping `aria-label` from the field label |
| select | shadcn `Select` (`SelectTrigger id={fieldId}`, `SelectValue placeholder="Select a value"`, items from `allowedValues`) |
| multi-select | `div role="group" aria-labelledby={labelId}` of shadcn `Checkbox` + `Label` pairs (keeps the e2e `getByRole("group", { name })`) |
| autocomplete | shadcn `Popover` + `Command` (`CommandInput`, `CommandList`, `CommandEmpty`, `CommandItem`), same debounce, dependency and "Waiting for a selection above" logic |
| file | native `input type="file"` styled with shadcn `Input`; uploading shows "Uploading 2 files" with shadcn `Progress` indeterminate (`value={undefined}`); upload problem uses `ProblemAlert` |
| field error | `p` `text-[13px]/[18px] text-err` with `id` referenced by `aria-describedby` |

- [ ] **Step 2: Verify the form against the fixture**

Run: `pnpm typecheck && pnpm test && pnpm build`, then `pnpm exec playwright test e2e/dashboard.spec.ts --project=desktop`. Tests that exercise form filling (upload, role group, validation) must still pass; failures caused only by changed labels or layout outside the form are fixed in Task 6.

- [ ] **Step 3: Commit**

```bash
git add -A apps/dashboard/src
git commit -m "feat(dashboard): render operation forms with shadcn controls"
```

---

### Task 5: Run view and artifacts

**Files:**
- Create: `src/components/gauntlet/RunView.tsx`, `ArtifactView.tsx`, `FollowUpList.tsx`, `LaunchButton.tsx`, `src/useRun.ts`
- Delete: `src/RunDetails.tsx`
- Modify: `src/OperationScreen.tsx`, `src/widget/RecentRunView.tsx` (use `RunView`)

**Interfaces:**
- Consumes: `run-actions.ts`, `RunStateBadge`, `ProblemAlert`, `api.run`, `isRunFinished`.
- Produces:
  - `useRun(targetId: string, runId: string | undefined): { run?: Run; missing: boolean; problem?: Problem }`: loads `GET run`, polls every 1500 ms while unfinished, `missing` true on 404.
  - `RunView({ targetId: string; run: Run; onCancel?: () => void; onRunAgain: () => void })`.
  - `ArtifactView({ targetId: string; runId: string; artifact: Artifact })`.

- [ ] **Step 1: Implement `useRun`**

```ts
import { useEffect, useState } from "react";
import type { Problem, Run } from "@8lines/gauntlet-protocol";
import { api, isRunFinished } from "./api.ts";

export function useRun(targetId: string, runId: string | undefined) {
  const [state, setState] = useState<{ run?: Run; missing: boolean; problem?: Problem }>({ missing: false });
  useEffect(() => {
    setState({ missing: false });
    if (runId === undefined) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const result = await api.run(targetId, runId);
      if (!active) return;
      if (!result.ok) {
        setState(result.problem.status === 404 ? { missing: true } : { missing: false, problem: result.problem });
        return;
      }
      setState({ run: result.data, missing: false });
      if (!isRunFinished(result.data)) timer = setTimeout(() => void load(), 1500);
    };
    void load();
    return () => { active = false; if (timer !== undefined) clearTimeout(timer); };
  }, [targetId, runId]);
  return state;
}
```

- [ ] **Step 2: Implement `RunView`, `ArtifactView`, `FollowUpList`, `LaunchButton`**

`RunView` layout (top to bottom, no outer card):
- Header row: `RunStateBadge`, run id in `font-mono text-xs/4 text-muted-foreground`, relative start time (`formatRelativeTime`), "dry run" as plain text when `run.dryRun`.
- Summary title `text-base/6 font-semibold` and message `text-sm/5 text-muted-foreground`.
- Progress while active: phase in mono, "3 of 8" right-aligned, shadcn `Progress value={percent}`; without totals `Progress` indeterminate.
- Actions: `Button variant="outline"` "Cancel" when `onCancel` and the run is active; otherwise, while active, the sentence "This application does not allow cancelling an operation once it has started."
- Failure: `ProblemAlert` with the correlation id.
- Artifacts: each `ArtifactView` under a `h3` `text-base/6 font-semibold` title, separated by `space-y-6`; no card.
- "What next": `FollowUpList`.
- Footer: `Button` "Run again" calling `onRunAgain`.

`ArtifactView` per kind, keeping today's data handling from `RunDetails.tsx`:
- notice: `PolicyList` with one effect (tone from level).
- metrics: `StatStrip` (value with unit in the label: "Latency p95 · ms" becomes label "Latency p95", value "182 ms").
- key-value: `<dl>` grid `sm:grid-cols-[minmax(0,180px)_minmax(0,1fr)]`, values in mono, each with a copy `Button size="icon" variant="ghost"` (lucide `Copy`, `aria-label="Copy {label}"`).
- table: shadcn `Table` inside `overflow-x-auto`; numeric columns (all values numbers) right-aligned in header and cells; `TableCell` `align-baseline`.
- markdown: `whitespace-pre-wrap text-sm/5` with `max-w-[68ch]`.
- diff: `pre` on `bg-muted rounded-lg p-4 font-mono text-xs/4`; added lines `text-ok` prefixed "+", removed `text-err` prefixed "−" (text cue already in the line).
- timeline: `<ol>` rows with timestamp in mono and title.
- log: `pre`-like block on `bg-muted`, columns timestamp (mono), level word coloured (`warn`→`text-warn`, `error`→`text-err`), message; `max-h-72 overflow-y-auto`.
- download: file name in mono, size, `Button variant="outline" asChild` wrapping `<a download>` "Download".
- link: external link with "↗".
- browser-launch: label, "One-time entry. Opening it uses up the link.", `LaunchButton`.
- json: `pre` on `bg-muted`.
- unknown kind: the sentence "This adapter sent an artifact outside the profile ({kind})." and its JSON.

`FollowUpList`: `<ul>` of rows (label, description, action button "Open" / link "Open ↗" / `LaunchButton`) using `executeFollowUp`.

`LaunchButton`: same behaviour as today's (uses `beginBrowserLaunch`), `Button variant="outline"` "Open test session" text from the artifact label, problem via `ProblemAlert`.

In `OperationScreen.tsx` replace `RunDetails` with `RunView` (prop `onRetry` becomes `onRunAgain`). In `widget/RecentRunView.tsx` replace its own polling with `useRun(entry.targetId, entry.runId)` and render `RunView`; when `missing`, show `EmptyState` "This run is no longer available".

- [ ] **Step 3: Verify**

Run: `pnpm typecheck && pnpm test && pnpm build && pnpm exec playwright test e2e/dashboard.spec.ts --project=desktop -g "rich results"`
Expected: PASS, or failures only from changed visible strings, which Task 6 updates.

- [ ] **Step 4: Commit**

```bash
git add -A apps/dashboard/src
git commit -m "feat(dashboard): add run view with shadcn artifact rendering"
```

---

### Task 6: Operation screen and run URL

**Files:**
- Create: `src/screens/OperationScreen.tsx`, `src/screens/useOperationRun.ts`
- Delete: `src/OperationScreen.tsx`
- Modify: `src/App.tsx` (keying and run route only), `src/widget/Panel.tsx` (import path)
- Test: rewrite `e2e/dashboard.spec.ts` operation cases

**Interfaces:**
- Consumes: `OperationForm`, `RunView`, `useRun`, `PolicyList`, `ImpactBadge`, `ProblemAlert`, `operation-errors.ts`, `prefill.ts`, `create-run-request.ts`, `recent-runs.ts`, `browser-storage.ts`.
- Produces:
  - `useOperationRun(options: { targetId: string; operationId: string; runId?: string; initialInput?: JsonObject; onInitialInputConsumed?: () => void; bindings?: readonly BindingValue[]; onRunCreated?: (run: Run) => void; onRunCleared?: () => void })` returning `{ definition?, problem?, values, setValues, presetId, applyPreset, locked, skipped, errors, run?, runMissing: boolean, submitting, uploadPending, fileStates, setFileState, attempt(dryRun: boolean), confirm(), awaitingConfirmation, cancelConfirmation(), cancelRun(), runAgain() }`.
  - `OperationScreen` props: today's props plus `runId?: string`.

- [ ] **Step 1: Extract `useOperationRun`**

Move all state and effects from the current `OperationScreen.tsx` into `useOperationRun.ts` unchanged, then add run-URL behaviour:

```ts
// inside useOperationRun, after the definition-loading effect
const urlRun = useRun(targetId, runId !== undefined && runId !== run?.id ? runId : undefined);
useEffect(() => { if (urlRun.run !== undefined) setRun(urlRun.run); }, [urlRun.run]);
const previousRunId = useRef(runId);
useEffect(() => {
  // Leaving a run URL (browser back, "Run again") returns to the form; the widget never passes runId.
  if (previousRunId.current !== undefined && runId === undefined) setRun(undefined);
  previousRunId.current = runId;
}, [runId]);
const runMissing = urlRun.missing;
```

`runAgain()` does `setRun(undefined); onRunCleared?.()`. The existing 1500 ms polling of the in-screen run stays.

- [ ] **Step 2: Build the screen**

Layout (desktop `xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.8fr)]`, one scroll container, sticky action bar at the bottom):
- Header: `h1` `text-2xl/8 font-semibold` label, `ImpactBadge`, id in `font-mono text-xs/4 text-muted-foreground` with the revision as `title`, description `max-w-[68ch] text-sm/5 text-muted-foreground`. On the right (stacks under on narrow widths), when presets exist: "Start from a preset" `Label` + shadcn `Select` (first item "Empty form"), preset description, and when locked "This preset locks 2 fields." with a lucide `Lock` icon and "To unlock them, choose the empty form."
- Left column: when errors exist, `Alert` with `border-err`, title "Fix the input", text "Nothing was sent to the application. The form is filled in just as you left it.", general errors as a list, and when present "The application did not say which fields these errors refer to. Check the fields marked as required." Then shadcn `Card` with `CardHeader` ("Input", "Fields marked * are required.") and `CardContent` holding `OperationForm`. Skipped page values: one compact line per pointer "Field {pointer} is set by the preset. The value from the page was skipped."
- Right column (`xl:sticky xl:top-6 self-start`): section "What this operation does" (`h2` `text-base/6 font-semibold` + `PolicyList`), then "Result": `EmptyState` "Nothing has run yet" / "The result will appear here when the run finishes. Your input stays in place, so fixing it and running again takes one click." or `RunView`, or when `runMissing` an `EmptyState` "This run is no longer available" with `Button variant="outline"` "Back to the form" (navigates to the operation URL).
- Action bar: `footer role="region" aria-label="Operation actions"` with `border-t bg-background`, the operation label and "in {environment}" on the left, and on the right `Button variant="outline"` "Dry run" (lucide `FlaskConical`) when supported, and the main `Button` (`variant="destructive"` when impact is destructive, otherwise default) labelled `runButtonLabel(definition)`, or "Sending" while submitting.
- Confirmation: shadcn `AlertDialog` open while `awaitingConfirmation`: title "Run {label}?", description "The application marked this operation as requiring confirmation. Before it starts:", `PolicyList`, `AlertDialogCancel` "Cancel", `AlertDialogAction` labelled `runButtonLabel(definition)` with destructive styling for destructive operations.
- Loading: `Skeleton` blocks; definition problem: `ProblemAlert` titled "Could not open this operation".

- [ ] **Step 3: Wire the run URL in `App.tsx`**

- Pass `runId={route.runId}` to `OperationScreen`.
- `onRunCreated(run)`: `rememberRun(browserStorage, { targetId, operationId, label, runId: run.id, startedAt: run.startedAt ?? run.createdAt })` then `navigate({ targetId, operationId, runId: run.id }, { replace: true })`.
- `onRunCleared()`: `navigate({ targetId, operationId }, { replace: true })`.
- Change the remount key so URL changes without new input do not reset the form: increment `navigationInput.key` in the `popstate` handler only when `gauntletInput(event.state) !== undefined`; the key stays `${targetId}:${operationId}:${navigationInput.key}`.

- [ ] **Step 4: Rewrite the operation e2e cases**

In `e2e/dashboard.spec.ts` keep every existing scenario and update selectors to the new UI (button names now equal the operation label; `getByRole("button", { name: /delete$/ })` becomes `getByRole("button", { name: destructiveOperation.label, exact: true })`). Add:

```ts
test("a run URL survives reload and keeps polling", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  // Arrange the fixture so the run stays "running" for two polls, then "succeeded".
  // Start the run from the form, then:
  await expect(page).toHaveURL(/\/r\/[^/]+$/);
  await page.reload();
  await expect(page.getByText("Running", { exact: true })).toBeVisible();
  await expect(page.getByText("Done", { exact: true })).toBeVisible({ timeout: 10_000 });
});

test("an unknown run shows that it is no longer available", async ({ page }) => {
  // Route the fixture so GET …/runs/run_missing returns a 404 problem.
  await page.goto(`/t/${encodeURIComponent(targetId)}/o/${encodeURIComponent(operationId)}/r/run_missing`);
  await expect(page.getByText("This run is no longer available")).toBeVisible();
  await page.getByRole("button", { name: "Back to the form" }).click();
  await expect(page).not.toHaveURL(/\/r\//);
});

test("a follow-up into the same operation reopens the form with its input", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  // Run an operation whose fixture follow-up invokes the same operation with input { "email": "next@acme.test" }.
  await page.getByRole("button", { name: "Open" }).first().click();
  await expect(page).not.toHaveURL(/\/r\//);
  await expect(page.getByLabel("Email")).toHaveValue("next@acme.test");
  await expect(page.getByText("Nothing has run yet")).toBeVisible();
});
```

Extend `e2e/api-fixture.ts` where needed: a run that is `running` for its first two `GET`s, a 404 for unknown run ids (problem body `{ type: "urn:gauntlet:problem:run-not-found", title: "Run not found", status: 404 }`), and a follow-up that targets the same operation. Use the fixture's existing request recording and helpers; read `e2e/api-fixture.ts` fully before editing.

- [ ] **Step 5: Verify**

Run: `pnpm typecheck && pnpm test && pnpm build && pnpm exec playwright test e2e/dashboard.spec.ts`
Expected: PASS on both projects.

- [ ] **Step 6: Commit**

```bash
git add -A apps/dashboard
git commit -m "feat(dashboard): rebuild the operation screen and add run URLs"
```

---

### Task 7: App shell

**Files:**
- Create: `src/app/App.tsx`, `src/app/AppSidebar.tsx`, `src/app/EnvironmentSwitcher.tsx`, `src/app/AppHeader.tsx`, `src/app/PageStates.tsx`, `src/useTargets.ts`
- Delete: `src/App.tsx`, `src/EnvironmentPicker.tsx` (move `stateColorClass`/`stateLabel` used by the widget into `src/app/EnvironmentSwitcher.tsx` as `targetStateTone(target): Tone` and `targetStateLabel(target): string`)
- Modify: `src/main.tsx`, `src/widget/PanelHeader.tsx` (imports)
- Test: rewrite `e2e/layout.spec.ts`, navigation cases in `e2e/dashboard.spec.ts`

**Interfaces:**
- Produces:
  - `useTargets(): { targets?: readonly TargetSnapshot[]; problem?: Problem; refreshing: boolean; refresh(): void }`.
  - `targetStateTone(target: TargetSnapshot): Tone` (`online`→`ok`, `degraded`→`wait`, else `stop`), `targetStateLabel(target): "Online" | "Degraded" | "Unavailable"`.
  - `AppHeader({ breadcrumb: readonly { label: string; route?: Route }[]; onSearch(): void })`.

- [ ] **Step 1: Build the shell**

- `SidebarProvider` controlled: `open={!preferences.sidebarCollapsed}`, `onOpenChange={(open) => updatePreferences({ sidebarCollapsed: !open })}`. `Sidebar collapsible="offcanvas"` (shadcn renders a `Sheet` on mobile automatically; keep `id="gauntlet-navigation"` on the `Sidebar` for the e2e suite).
- `SidebarHeader`: `GauntletMark` + "Gauntlet" (`text-base/6 font-semibold`), then `EnvironmentSwitcher`.
- `EnvironmentSwitcher`: `DropdownMenu` whose trigger is a `SidebarMenuButton size="lg"` with the environment label and a line "{StateMark} Online · staging". Menu: `DropdownMenuLabel` "Environments", one `DropdownMenuItem` per target (label, "{application}, {kind}, {state}", check icon for the current), separator, a row "Application {label}" and "Refreshed {relative time}". Selecting navigates to `{ targetId }`.
- `SidebarContent`: `SidebarGroup` with Overview (`SidebarMenuButton isActive` + `SidebarMenuBadge` count); one `SidebarGroup` + `SidebarGroupLabel` per feature (sorted by `order`), "Other" for ungrouped; items are `SidebarMenuButton` with the label only; unavailable items are disabled with `SidebarMenuBadge` "Unavailable". When the manifest is missing: "No operation catalog. The environment did not respond correctly."
- `SidebarFooter`: `SidebarMenuButton` "Settings" (lucide `Settings`) opening `SettingsDialog` (Task 8; until then a no-op), and "Gauntlet v{__GAUNTLET_VERSION__}" in `text-xs/4 text-muted-foreground`.
- `SidebarInset`: `AppHeader` = `SidebarTrigger` (aria-label "Toggle navigation"), `Separator orientation="vertical"`, shadcn `Breadcrumb` (environment / group / operation, last item `BreadcrumbPage`), and on the right an outline search `Button` with lucide `Search`, "Search", and `<kbd>` "⌘ K"; then `main#workspace` rendering the routed screen.
- `PageStates.tsx`: `LoadingState` (Skeletons, `role="status"` "Loading environments"), `NoEnvironments` (`EmptyState` "No environments configured" / "Add an environment to the Gauntlet configuration, then restart the server."), `LoadFailed` (`ProblemAlert` titled "Could not load environments" + `Button` "Try again" calling `refresh`).
- `useTargets`: loads `api.targets()` on mount; `refresh()` reloads and sets `refreshing` while in flight.

- [ ] **Step 2: Rewrite layout and navigation e2e**

Update `e2e/layout.spec.ts` and the navigation tests in `e2e/dashboard.spec.ts` ("application footer shows the build version", "mobile navigation removes the closed drawer…", "desktop sidebar collapses…") to the new structure: version visible in the sidebar footer on desktop and inside the opened mobile sheet; mobile sheet closes on Escape and returns focus to the trigger; desktop collapse persists across reload (preference). Keep "long operation labels keep both actions visible across workspace widths" and "short viewports keep dialog controls reachable in both themes".

- [ ] **Step 3: Verify**

Run: `pnpm typecheck && pnpm test && pnpm build && pnpm exec playwright test e2e/layout.spec.ts e2e/dashboard.spec.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A apps/dashboard
git commit -m "feat(dashboard): rebuild the app shell on the shadcn sidebar"
```

---

### Task 8: Command search and settings

**Files:**
- Create: `src/app/CommandSearch.tsx`, `src/app/SettingsDialog.tsx`, `src/app/McpConnection.tsx`
- Delete: `src/GlobalSearch.tsx`, `src/UserSettings.tsx`, `src/McpConnectionSettings.tsx`
- Test: rewrite `e2e/settings.spec.ts`, the search case in `e2e/dashboard.spec.ts`

**Interfaces:**
- Consumes: `readRecentRuns`, `browserStorage`, `usePreferences`, `resolveTheme`.
- Produces: `CommandSearch({ targets; open: boolean; onOpenChange(open: boolean): void })`, `SettingsDialog({ open; onOpenChange; preferences; onChange; saved })`.

- [ ] **Step 1: Command search**

shadcn `CommandDialog` (title "Search operations", description "Search environments, operations and recent runs"). ⌘K / Ctrl K toggles it unless another dialog is open (keep today's guard). `CommandInput` placeholder "Search environments and operations". Groups: "Environments" (each target, value `label`, `onSelect` navigates to overview), "Operations" (label + environment label as secondary text; unavailable items `disabled` with "unavailable"), "Recent runs" (up to 5 from `readRecentRuns(browserStorage)` for the current target, `onSelect` navigates to the run URL). `CommandEmpty` "No matching results". Footer line "↑ ↓ select, ↵ open, Esc close" in `text-xs/4 text-muted-foreground`. Focus returns to the search button on close (Radix default).

- [ ] **Step 2: Settings dialog**

shadcn `Dialog` titled "Settings", description "Appearance and connection settings for Gauntlet." `Tabs` "Appearance" / "MCP".
- Appearance: `RadioGroup` (aria-label "Theme") with three `RadioGroupItem`s "Light", "Dark", "System", each inside a bordered `Label` with a small preview; `Switch` rows "Reduce motion" and "Collapsed navigation" with descriptions; status line ("Preferences are saved automatically in this browser." or "Could not save preferences. Changes apply until you reload this tab." in `text-warn`); footer `Button variant="ghost"` "Restore defaults" and `Button` "Done".
- MCP (`McpConnection`): same logic as `McpConnectionSettings.tsx`; `Label` "MCP server URL" + `Input` (`aria-invalid`, error "Enter an HTTP or HTTPS URL ending in /mcp."), "Streamable HTTP" as plain text, "Client configuration" + `Button variant="outline"` "Copy configuration", the JSON in `pre` on `bg-muted`, copy status line, and `Collapsible` "Server setup" with Local / Compose / Helm paragraphs (copy unchanged apart from removing em dashes).
- Opened from the sidebar footer "Settings".

- [ ] **Step 3: Rewrite settings and search e2e**

Port all six cases of `e2e/settings.spec.ts` (button "Settings" instead of "User settings"; theme radios keep names "Light"/"Dark"/"System"; "MCP" is now a tab: `getByRole("tab", { name: "MCP" })`). Add the system-theme case:

```ts
test("system theme follows the operating system live", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("radio", { name: "System", exact: true }).check();
  await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
});
```

Port "search filters operations, supports keyboard navigation and restores focus" to the `CommandDialog` (`getByRole("dialog", { name: "Search operations" })`, `getByRole("combobox")` for the input, `getByRole("option")` for items).

- [ ] **Step 4: Verify**

Run: `pnpm typecheck && pnpm test && pnpm build && pnpm exec playwright test`
Expected: PASS except overview/environment cases rewritten in Task 9 (note which ones fail and why).

- [ ] **Step 5: Commit**

```bash
git add -A apps/dashboard
git commit -m "feat(dashboard): add command search and settings dialog on shadcn"
```

---

### Task 9: Overview screen

**Files:**
- Create: `src/screens/OverviewScreen.tsx`, `src/screens/CatalogTable.tsx`, `src/components/gauntlet/RecentRunsList.tsx`, `src/useRecentRunStates.ts`
- Delete: `src/EnvironmentOverview.tsx`
- Test: rewrite `e2e/environment.spec.ts`

**Interfaces:**
- Consumes: `useOperationDetails` (with `definition`), `catalog.ts`, `StatStrip`, `ImpactBadge`, `readRecentRuns`, `browserStorage`, `useTargets().refresh`.
- Produces: `useRecentRunStates(entries: readonly RecentRun[]): ReadonlyMap<string, { run?: Run; missing: boolean }>` keyed by `runId`; `RecentRunsList({ targetId: string; entries: readonly RecentRun[] })`.

- [ ] **Step 1: `useRecentRunStates`**

```ts
import { useEffect, useState } from "react";
import type { Run } from "@8lines/gauntlet-protocol";
import { api, isRunFinished } from "./api.ts";
import type { RecentRun } from "./recent-runs.ts";

type Entry = { readonly run?: Run; readonly missing: boolean };

export function useRecentRunStates(entries: readonly RecentRun[]): ReadonlyMap<string, Entry> {
  const [states, setStates] = useState<ReadonlyMap<string, Entry>>(new Map());
  const key = entries.map((e) => `${e.targetId}/${e.runId}`).join("|");
  useEffect(() => {
    let active = true;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const load = async (entry: RecentRun) => {
      const result = await api.run(entry.targetId, entry.runId);
      if (!active) return;
      const next: Entry = result.ok ? { run: result.data, missing: false } : { missing: result.problem.status === 404 };
      setStates((current) => new Map(current).set(entry.runId, next));
      if (result.ok && !isRunFinished(result.data)) timers.push(setTimeout(() => void load(entry), 3000));
    };
    for (const entry of entries) void load(entry);
    return () => { active = false; timers.forEach(clearTimeout); };
  }, [key]);
  return states;
}
```

- [ ] **Step 2: Build the overview**

- Header: `h1` environment label; below it one line: application, kind, StateMark + status word, "Refreshed 2 min ago" (as in the mockup); `Button variant="outline"` "Refresh" (lucide `RefreshCw`, disabled while `refreshing`). Sentence "9 operations in the catalog. Choose one to prepare a run."
- `StatStrip`: All operations (detail "In 4 feature groups"), Ready to run (detail `impactBreakdown(impactCounts(loaded definitions))` or "Loading details"), Need attention (detail "1 diagnostic, 1 unavailable operation" or "No reported problems").
- `target.problem`: `ProblemAlert` titled "This environment is unreachable".
- Two columns `xl:grid-cols-[minmax(0,1fr)_320px]`:
  - Left: `h2` "Operation catalog", sentence "Grouped by feature. Open an operation to see what it does before you run it.", shadcn `Input` (lucide `Search`, aria-label "Filter operations", placeholder "Filter operations") with a count "3 of 9" when filtering. `CatalogTable`: shadcn `Table`; header Operation / Impact / Before you run; a `TableRow` group label per feature (`th colSpan={3} scope="rowgroup"`); each row: `th scope="row"` with a link (`a href={routePath}` + client navigation, same modifier-key handling as today) to the operation and its id in mono below, `ImpactBadge` (or "Loading" in `text-muted-foreground`), `policySummary(definition)`; unavailable rows: label in `text-muted-foreground`, not a link, Impact cell outline Badge "Unavailable", summary cell the advice. Empty filter result: `EmptyState` "No operations match" / "Try a different name or operation id." Empty catalog: `EmptyState` "The catalog is empty" / "No operations have been made available in this environment yet."
  - Right: "Needs attention" list (diagnostics: message, severity word with StateMark ▲/✕, code in mono; unavailable operations: label + advice + Badge "Unavailable"), "Your recent runs" (`RecentRunsList` with entries `readRecentRuns(browserStorage).filter(e => e.targetId === target.id).slice(0, 10)`), the note "Details first, then action" with its sentence, and `Collapsible` "Adapter capabilities" ("{n} reported by {application}", capabilities as a two-column mono list).
- `RecentRunsList`: `<ul>`; each `<li>` is a link to the run URL: operation label, relative start time, `RunStateBadge` when known, "No longer available" when missing; empty: "Runs you start in this browser appear here."

- [ ] **Step 3: Rewrite environment e2e**

Port the three cases in `e2e/environment.spec.ts` to the new switcher and table. Add:

```ts
test("catalog filter matches labels and ids and explains an empty result", async ({ page }) => {
  await page.goto("/");
  const filter = page.getByRole("textbox", { name: "Filter operations" });
  await filter.fill("  DELETE ");
  await expect(page.getByRole("row", { name: /Delete test data/ })).toBeVisible();
  await filter.fill("browser-delete-fixture");
  await expect(page.getByRole("row", { name: /Delete test data/ })).toBeVisible();
  await filter.fill("no such operation");
  await expect(page.getByText("No operations match")).toBeVisible();
});

test("recent runs survive corrupted storage and list new runs", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("gauntlet.recent-runs.v1", "{not json"));
  await page.goto("/");
  await expect(page.getByText("Runs you start in this browser appear here.")).toBeVisible();
  // Start a run from the form (fixture operation), go back to the overview:
  await expect(page.getByRole("link", { name: /Done/ }).first()).toBeVisible();
});

test("refresh reloads the environments", async ({ page }) => {
  await page.goto("/");
  const before = await countTargetRequests(page);
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect.poll(() => countTargetRequests(page)).toBeGreaterThan(before);
});
```

Implement `countTargetRequests` with the fixture's recorded requests (`GET /api/v1/targets`).

- [ ] **Step 4: Verify**

Run: `pnpm typecheck && pnpm test && pnpm build && pnpm exec playwright test`
Expected: all dashboard e2e cases PASS.

- [ ] **Step 5: Commit**

```bash
git add -A apps/dashboard
git commit -m "feat(dashboard): rebuild the overview with catalog table and recent runs"
```

---

### Task 10: Widget panel

**Files:**
- Modify: `src/widget/Panel.tsx`, `PanelHeader.tsx`, `PanelNotice.tsx`, `BackBar.tsx`, `OperationLists.tsx`, `OperationRow.tsx`, `RecentRunView.tsx`
- Test: `e2e-widget/widget.spec.ts`

**Interfaces:**
- Consumes: shadcn `Button`, `Input`, `Badge`, `Alert`, `Separator`, `Skeleton`; `ProblemAlert`, `EmptyState`, `StateMark`, `RunStateBadge`, `RecentRunsList` row markup, `targetStateTone`, `targetStateLabel`, `GauntletMark`, `browserStorage`.

- [ ] **Step 1: Restyle without changing behaviour**

- `PanelHeader`: `GauntletMark` + target label (`text-sm/5 font-medium`), environment as "{StateMark} {name}, {kind}" plain text, close `Button variant="ghost" size="icon"` (lucide `X`, aria-label "Close"); search as shadcn `Input` with lucide `Search` (same props, same Escape handling, same disabled placeholder).
- Notices (`PanelNotice`, refresh problem, page-subject drift): `Alert` with `border-warn` or `border-err` and a StateMark; "Use values from the page" `Button variant="outline" size="sm"`.
- `OperationLists`/`OperationRow`: rows separated by `border-b`, label `text-sm/5 font-medium`, description `text-[13px]/[18px] text-muted-foreground`, subject chip as plain text "for {subject}" (no badge), unavailable "Unavailable. {reason}" in `text-muted-foreground`; loading line `Skeleton`; "Open in Gauntlet ↗" as a text link.
- Recent runs in the panel use the same row markup as `RecentRunsList` (extract a `RecentRunRow` component in `RecentRunsList.tsx` and reuse it).
- `BackBar`: `Button variant="ghost" size="sm"` with lucide `ChevronLeft` "Back" and the "Open in Gauntlet ↗" link.
- Replace every `panelStorage` with `browserStorage`.

- [ ] **Step 2: Verify**

Run: `pnpm typecheck && pnpm test && pnpm build && pnpm widget:test:e2e:panel` (from the repo root). Update selectors in `e2e-widget/widget.spec.ts` only where names changed.
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add -A apps/dashboard
git commit -m "feat(widget): restyle the panel on the shared shadcn components"
```

---

### Task 11: Remove the old presentation layer

**Files:**
- Delete: `src/ui.tsx`, `src/Icon.tsx`, `src/legacy.css`, any remaining file under `src/` not imported by `main.tsx` or `widget/main.tsx`
- Modify: `src/index.css` (drop `@import "./legacy.css"`)

- [ ] **Step 1: Delete and fix references**

Remove the files, then `rg -n "ui\.tsx|Icon\.tsx|legacy\.css|surface-card|rounded-control|rounded-card|bg-ok-bg|text-stop|text-wait|text-info|page-heading|action-bar" apps/dashboard/src` must return nothing; replace any leftover with the new components/tokens.

- [ ] **Step 2: Enforce the copy and style rules mechanically**

```bash
rg -n "—" apps/dashboard/src --glob '*.tsx' | rg -v '^\S+:\d+:\s*(//|\*|/\*)'
rg -n "uppercase|tracking-|bg-gradient|shadow-(sm|md|lg|xl)" apps/dashboard/src --glob '!components/ui/**'
```

Expected: no output (shadcn's own `components/ui` files are excluded). Fix any hit.

- [ ] **Step 3: Compare bundle size**

Run the Step 1 commands of Task 1 again and put both tables in the task report. If the widget panel's JS grew by more than 40%, stop and report before continuing.

- [ ] **Step 4: Verify and commit**

Run: `pnpm typecheck && pnpm test && pnpm build && pnpm exec playwright test && cd ../.. && pnpm widget:test:e2e:panel`
Expected: PASS.

```bash
git add -A apps/dashboard
git commit -m "refactor(dashboard): remove the previous presentation layer"
```

---

### Task 12: Accessibility gate and visual check

**Files:**
- Modify: `apps/dashboard/package.json` (dev dependency), create `apps/dashboard/e2e/accessibility.spec.ts`

- [ ] **Step 1: Add the axe scan**

`pnpm add -D @axe-core/playwright` (exact version). `e2e/accessibility.spec.ts`:

```ts
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { installApiFixture } from "./api-fixture.ts";

for (const theme of ["light", "dark"] as const) {
  test(`overview, operation, run, search and settings have no serious violations (${theme})`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript(() => localStorage.setItem("gauntlet.preferences.v1", JSON.stringify({ theme: "system" })));
    // installApiFixture: use the same helper the other specs use (check its exported name in api-fixture.ts).
    const scan = async () => {
      const result = await new AxeBuilder({ page }).analyze();
      const serious = result.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
    };
    await page.goto("/");
    await scan();
    // open an operation, scan; run it, scan the run view; open ⌘K, scan; open Settings, scan both tabs.
  });
}
```

Fill in the navigation steps with the same selectors the other specs use.

- [ ] **Step 2: Run and fix**

Run: `pnpm exec playwright test e2e/accessibility.spec.ts`
Expected: PASS. Fix violations in our components (never by disabling rules).

- [ ] **Step 3: Visual comparison**

Start the local stack (`docs/local-development.md`) and `pnpm dev`. Screenshot overview, operation, run result, ⌘K and settings at 1440×900 and 390×844 in light and dark, and compare each with `docs/mockups/dashboard-shadcn.html` (same screen). Fix differences in hierarchy, spacing roles and colour use; differences caused by real data are fine. Attach the screenshots' paths in the task report.

- [ ] **Step 4: Commit**

```bash
git add -A apps/dashboard pnpm-lock.yaml
git commit -m "test(dashboard): add axe accessibility gate for the redesigned screens"
```

---

### Task 13: Documentation and 0.1.8 preparation

**Files:**
- Modify: `apps/dashboard/README.md`, `docs/user-guide.md`, `docs/reference/repository.md`, `docs/integrations/widget.md`, `CHANGELOG.md`, versioned files via the release script

- [ ] **Step 1: Update docs**

- `apps/dashboard/README.md`: source layout (`components/ui` from the shadcn CLI, `components/gauntlet`, `app`, `screens`), how to add a shadcn component (`pnpm dlx shadcn@latest add <name>` from `apps/dashboard`), the design rules link (the spec).
- `docs/user-guide.md`: new navigation (sidebar, environment switcher, ⌘K), catalog filter and Refresh, run URLs and recent runs, settings location.
- `docs/reference/repository.md`: dashboard source map entries for the new folders.
- `docs/integrations/widget.md`: recent runs now stored under `gauntlet.recent-runs.v1`, shared with the dashboard on the same origin; the old key is ignored.
- Run `node scripts/docs/check-docs.mjs` from the repo root: `{"ok":true}`.

- [ ] **Step 2: Changelog and version**

Add to `CHANGELOG.md` under a new `## [0.1.8] - <release date>` section (keep `## Unreleased` above it, empty):

```markdown
### Added

- Run URLs: every run has its own address, so a result can be reloaded, shared and reopened.
- The dashboard lists your recent runs from this browser on the environment overview and in search.
- The operation catalog is a filterable table showing each operation's impact and what to expect before running it.

### Changed

- Rebuilt the dashboard and widget panel on shadcn/ui with Geist type, a monochrome palette and colour reserved for state.
- Recent runs are stored under `gauntlet.recent-runs.v1` and shared by the dashboard and widget; runs recorded by earlier widget versions are not carried over.
- Run buttons are named after their operation for every impact; destructive operations are marked by colour and a confirmation instead of a suffix.
```

Then from the repo root:

```bash
pnpm release:version --set 0.1.8
pnpm release:version --check
```

Fix any mismatch the check reports (compare with the files changed by commit `750c428`, "chore(release): prepare v0.1.7").

- [ ] **Step 3: Full verification**

From the repo root: `pnpm check`, `pnpm dashboard:test:e2e`, `pnpm widget:test:e2e:panel`, `pnpm release:dry-run`. Expected: all PASS. Do not tag, push or publish.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(release): prepare v0.1.8 with the redesigned dashboard"
```
