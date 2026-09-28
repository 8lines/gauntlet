# Widget Phase 3: Channel Protocol, Host Loader and `@8lines/gauntlet-widget`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A host application can load `loader.js` (built as one dependency-free IIFE) or use the typed `@8lines/gauntlet-widget` package. The loader derives page subjects from URL rules and `setSubject`, shows a floating button, preloads the panel iframe, and talks to the panel over the versioned channel-1 `postMessage`/`MessagePort` handshake with origin and source checks.

**Architecture:** Three new workspace packages.
- `packages/widget-channel` (`@8lines/gauntlet-widget-channel`, private): channel-1 message types, `PageContext`, and strict validators. It has no dependencies and is bundled into the loader (this phase) and the panel (phase 4).
- `packages/widget` (`@8lines/gauntlet-widget`, published): host-facing types and typed command functions that push to the `window.Gauntlet` queue, plus `loadGauntletWidget(url)`. No runtime dependencies, SSR-safe.
- `packages/widget-loader` (`@8lines/gauntlet-widget-loader`, private): pure core modules (route matching, subject overlay, option validation, command processing, handshake predicates) unit-tested in Node, and a thin DOM runtime bundled by Vite library mode into `dist/loader.js`. The runtime is tested in Chromium with Playwright against a two-origin fixture server and a fake panel.

Phase 2 already serves `GET /widget/loader.js`, `GET /widget/` (panel) and `GET /widget/config.json` from `GAUNTLET_WIDGET_DIR`. Phase 4 builds the real panel and assembles `loader.js` into that directory.

**Tech Stack:** TypeScript 7 (ES2024, strict, `exactOptionalPropertyTypes`), `node:test` via `tsx`, Vite 8 library mode (IIFE), Playwright 1.55.1 (Chromium), pnpm workspace, release scripts in `scripts/release`.

**Spec:** `docs/superpowers/specs/2026-09-25-embeddable-widget-design.md` (sections *Loader and host API*, *Channel protocol*, *Error handling*, *Testing* → widget-channel/Loader).

## Global Constraints

- Product name is **Gauntlet**. Globals, attributes and messages use `Gauntlet`/`gauntlet` only.
- Portable ID pattern (duplicated, not imported, so channel and widget stay dependency-free): `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`.
- Channel version is the number `1`. Every message is a plain object with `channel: 1` and a `type` string starting with `gauntlet:`.
  | Direction | Transport | Message |
  | --- | --- | --- |
  | panel → host | `window.parent.postMessage(msg, "*")` | `{ channel: 1, type: "gauntlet:ready" }` |
  | host → panel | `iframe.contentWindow.postMessage(msg, gauntletOrigin, [port2])` | `{ channel: 1, type: "gauntlet:connect", target }` |
  | panel → host | `window.parent.postMessage(msg, "*")` | `{ channel: 1, type: "gauntlet:rejected" }` |
  | host → panel | port | `{ channel: 1, type: "gauntlet:context", context: PageContext }` |
  | host → panel | port | `{ channel: 1, type: "gauntlet:open" }` |
  | panel → host | port | `{ channel: 1, type: "gauntlet:state", contextualCount, globalCount }` (non-negative safe integers) |
  | panel → host | port | `{ channel: 1, type: "gauntlet:close" }` |
  | panel → host | port | `{ channel: 1, type: "gauntlet:resize", expanded: boolean }` |
  `gauntlet:forms` and `gauntlet:fill-form` are reserved for v2 and parse as unknown.
- Parse outcomes: `invalid` for anything that is not a channel-1 `gauntlet:*` object, or a known type with a malformed payload (silently ignored by callers). `unknown` for a well-formed `gauntlet:*` type this version does not know (callers `console.debug` it). `message` for valid known messages. Extra keys on known messages are tolerated and stripped from the returned copy.
- `PageContext = { target: PortableId, subjects: PageSubject[] }`, `PageSubject = { type: PortableId, values: Record<PortableId, string | number | boolean> }`. Limits: at most 16 subjects with unique types, at most 16 values per subject, strings at most 512 UTF-16 code units, numbers finite.
- Host API (`window.Gauntlet(command, ...args)`): `boot(options)`, `setSubject(type, values)`, `removeSubject(type)`, `open()`, `close()`, `shutdown()`. Stub: `window.Gauntlet ||= function () { (Gauntlet.q ||= []).push(arguments); };`. The loader replays `Gauntlet.q` in order.
- `BootOptions = { target: PortableId; routes?: RouteRule[]; position?: "bottom-right" | "bottom-left" }`, where `position` defaults to `"bottom-right"`. Unknown option keys are ignored with one `console.warn`. An invalid `target` or `routes` makes `boot` fail with a `console.warn`.
- `RouteRule = { pattern, subject } | { pattern, subjects: Record<PortableId, paramName[]> }`. Patterns start with `/`. Segments are literals, `:name` (name `^[A-Za-z][A-Za-z0-9_]{0,63}$`, unique within the pattern), or a final `*` that matches zero or more remaining segments and captures nothing. Matching is case-sensitive against `location.pathname`, one decoded segment per `:name`. A single trailing `/` is ignored, and an empty inner segment never matches. The first matching rule wins. A segment that fails `decodeURIComponent`, or a capture longer than 512 characters, makes that rule not match. `subject: T` puts every captured parameter into subject `T`. `subjects` maps each type to the parameters it receives, and every listed parameter must exist in the pattern.
- Effective page context: URL-derived subjects (rule order) overlaid by explicit `setSubject` subjects by type. Explicit-only types follow in insertion order. The loader sends `gauntlet:context` only when the result differs from the last sent context (deep, order-sensitive).
- Command semantics: `boot` a second time → `console.warn("Gauntlet widget: boot was already called; ignoring")`. `setSubject` and `removeSubject` before `boot` are remembered and apply at boot. `open`/`close` before `boot` → `console.warn`. `shutdown` removes the button, iframe, listeners and remembered subjects, restores the history methods if they are still the loader's wrappers, and allows a later `boot`. Unknown commands → `console.warn`.
- Gauntlet origin = `new URL(document.currentScript.src).origin`, falling back to the first `script[src$="/widget/loader.js"]`. If neither exists, `console.error` and do nothing. A second copy of the loader on the page does nothing.
- Panel URL = `${gauntletOrigin}/widget/`. The iframe is created hidden on `requestIdleCallback` (fallback `setTimeout(…, 1500)`), or immediately on the first `open`. If no accepted `gauntlet:ready` arrives within 10 000 ms of iframe creation, the widget becomes unavailable: the button is disabled with `title="Cannot reach Gauntlet"` (a `gauntlet:rejected` instead gives `title="Gauntlet rejected this page (origin or target) — see the browser console"`).
- Handshake acceptance (loader): `event.origin === gauntletOrigin && event.source === iframe.contentWindow` and the data parses as `gauntlet:ready` or `gauntlet:rejected`. On `ready`: close any previous port, create a `MessageChannel`, post `gauntlet:connect` with `port2` to `gauntletOrigin`, then send the current context and a pending `gauntlet:open`. On `rejected`: `console.warn` naming `location.origin` and the target and telling the developer to add the origin to `targets[].widget.origins`, then become unavailable.
- Loader never sends `location.href`, query, fragment or any URL to the panel.
- DOM contract (tests and phase 4 rely on it):
  - The host element `<div data-gauntlet-widget>` is appended to `document.body`. Its closed shadow root contains the button. The element carries `data-gauntlet-state` = `connecting` | `ready` | `unavailable` and `data-gauntlet-count` = the last `contextualCount`, or is absent before the first state message. While unavailable it also carries `data-gauntlet-reason` = `rejected` (the panel sent `gauntlet:rejected`: unknown target or unlisted origin) | `unreachable` (no accepted `gauntlet:ready` within 10 000 ms); the attribute is absent in every other state.
  - The panel `<iframe data-gauntlet-panel title="Gauntlet">` is appended to `document.body`. It is `hidden` while closed. It is visible while open: fixed, full viewport height, `width: 400px` (expanded: `min(960px, 100vw)`), on the button's side.
  - Clicking the button toggles open/close. `gauntlet:close` from the panel closes it.
- `loader.js` is one IIFE file with no `import`/`export`, at most 24 KiB unminified-size budget measured on the built file.
- Commit after each task with a Conventional Commit message ending with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

- A hostile page script posting `{ channel: 1, type: "gauntlet:ready" }` to the host window from another frame or origin must never receive a `MessagePort`. Pinned in Task 4 (predicate tests) and Task 5 (browser test with a foreign iframe).
- The panel iframe reloading, and therefore sending a second `gauntlet:ready`, must get a fresh port while the old one is closed, not two live channels. Pinned in Task 5.
- `pushState` to the same URL, or navigation that does not change the matched subjects, must not resend `gauntlet:context`. Pinned in Tasks 4 and 5.
- A percent-encoded route segment (`/orders/a%2Fb`) must capture `a/b`, and a malformed one (`/orders/%E0%A4%A`) must not throw or match. Pinned in Task 4.
- Calling a command before the loader script arrives (stub queue), and loading the loader twice, must neither lose nor double-apply commands. Pinned in Tasks 4 and 5.

---

### Task 1: `@8lines/gauntlet-widget-channel`

**Files:**
- Modify: `pnpm-workspace.yaml` (add `packages/widget-channel`)
- Create: `packages/widget-channel/package.json`, `tsconfig.json`, `src/index.ts`, `test/channel.test.ts`, `README.md`

**Interfaces:**
- Produces (exported from `@8lines/gauntlet-widget-channel`):
  ```ts
  export const WIDGET_CHANNEL_VERSION: 1;
  export const MAX_SUBJECTS = 16, MAX_SUBJECT_VALUES = 16, MAX_STRING_LENGTH = 512;
  export type SubjectValue = string | number | boolean;
  export interface PageSubject { readonly type: string; readonly values: Readonly<Record<string, SubjectValue>> }
  export interface PageContext { readonly target: string; readonly subjects: readonly PageSubject[] }
  export type HandshakeMessage =
    | { readonly channel: 1; readonly type: "gauntlet:ready" }
    | { readonly channel: 1; readonly type: "gauntlet:connect"; readonly target: string }
    | { readonly channel: 1; readonly type: "gauntlet:rejected" };
  export type HostMessage =
    | { readonly channel: 1; readonly type: "gauntlet:context"; readonly context: PageContext }
    | { readonly channel: 1; readonly type: "gauntlet:open" };
  export type PanelMessage =
    | { readonly channel: 1; readonly type: "gauntlet:state"; readonly contextualCount: number; readonly globalCount: number }
    | { readonly channel: 1; readonly type: "gauntlet:close" }
    | { readonly channel: 1; readonly type: "gauntlet:resize"; readonly expanded: boolean };
  export type ParseResult<T> =
    | { readonly kind: "message"; readonly message: T }
    | { readonly kind: "unknown"; readonly type: string }
    | { readonly kind: "invalid" };
  export function isPortableId(value: unknown): value is string;
  export function isSubjectValues(value: unknown): value is Readonly<Record<string, SubjectValue>>;
  export function isPageContext(value: unknown): value is PageContext;
  export function parseHandshakeMessage(data: unknown): ParseResult<HandshakeMessage>;
  export function parseHostMessage(data: unknown): ParseResult<HostMessage>;
  export function parsePanelMessage(data: unknown): ParseResult<PanelMessage>;
  ```
  Each parser only knows its own type set: `parseHostMessage` returns `unknown` for `gauntlet:state`.

- [ ] **Step 1: Scaffold the package**

`packages/widget-channel/package.json`:

```json
{
  "name": "@8lines/gauntlet-widget-channel",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "tsx --test test/**/*.test.ts"
  }
}
```

`tsconfig.json` is a copy of `packages/dashboard-client/tsconfig.json` without `resolveJsonModule`, plus `"lib": ["ES2024"]` and `"types": []`, so the channel compiles for browsers and Node alike. Add `  - packages/widget-channel` to `pnpm-workspace.yaml` after `packages/dashboard-client`, then run `pnpm install` so the lockfile records the importer. `README.md`: three sentences saying what the package is, that it is private and bundled into the loader and panel, and a link to the spec.

- [ ] **Step 2: Write failing tests**

`test/channel.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isPageContext,
  isPortableId,
  parseHandshakeMessage,
  parseHostMessage,
  parsePanelMessage,
  WIDGET_CHANNEL_VERSION,
} from "../src/index.js";

const context = { target: "shop", subjects: [{ type: "order", values: { orderId: "123", paid: false, total: 12.5 } }] };

test("channel version is 1", () => {
  assert.equal(WIDGET_CHANNEL_VERSION, 1);
});

test("portable IDs follow the protocol pattern", () => {
  for (const id of ["shop", "a", "A1._:-", "x".repeat(128)]) assert.equal(isPortableId(id), true, id);
  for (const id of ["", "-a", ".a", "x".repeat(129), "a b", "a/b", 1, null]) assert.equal(isPortableId(id), false, String(id));
});

test("every v1 message parses and extra keys are stripped", () => {
  assert.deepEqual(parseHandshakeMessage({ channel: 1, type: "gauntlet:ready", extra: 1 }),
    { kind: "message", message: { channel: 1, type: "gauntlet:ready" } });
  assert.deepEqual(parseHandshakeMessage({ channel: 1, type: "gauntlet:connect", target: "shop" }),
    { kind: "message", message: { channel: 1, type: "gauntlet:connect", target: "shop" } });
  assert.deepEqual(parseHandshakeMessage({ channel: 1, type: "gauntlet:rejected" }),
    { kind: "message", message: { channel: 1, type: "gauntlet:rejected" } });
  assert.deepEqual(parseHostMessage({ channel: 1, type: "gauntlet:context", context }),
    { kind: "message", message: { channel: 1, type: "gauntlet:context", context } });
  assert.deepEqual(parseHostMessage({ channel: 1, type: "gauntlet:open" }),
    { kind: "message", message: { channel: 1, type: "gauntlet:open" } });
  assert.deepEqual(parsePanelMessage({ channel: 1, type: "gauntlet:state", contextualCount: 2, globalCount: 0 }),
    { kind: "message", message: { channel: 1, type: "gauntlet:state", contextualCount: 2, globalCount: 0 } });
  assert.deepEqual(parsePanelMessage({ channel: 1, type: "gauntlet:close" }),
    { kind: "message", message: { channel: 1, type: "gauntlet:close" } });
  assert.deepEqual(parsePanelMessage({ channel: 1, type: "gauntlet:resize", expanded: true }),
    { kind: "message", message: { channel: 1, type: "gauntlet:resize", expanded: true } });
});

test("returned messages are copies, not the posted object", () => {
  const posted = { channel: 1, type: "gauntlet:context", context: structuredClone(context) };
  const result = parseHostMessage(posted);
  assert.equal(result.kind, "message");
  posted.context.subjects[0]!.values.orderId = "changed";
  assert.equal((result as { message: { context: typeof context } }).message.context.subjects[0]!.values.orderId, "123");
});

test("foreign and malformed data is invalid", () => {
  for (const data of [
    null, "gauntlet:ready", 1, [], { type: "gauntlet:ready" }, { channel: 2, type: "gauntlet:ready" },
    { channel: "1", type: "gauntlet:ready" }, { channel: 1, type: "ready" }, { channel: 1, type: 5 },
    { channel: 1, type: "gauntlet:connect" }, { channel: 1, type: "gauntlet:connect", target: "bad id" },
    Object.assign(Object.create({ channel: 1 }), { type: "gauntlet:ready" }),
  ]) {
    assert.equal(parseHandshakeMessage(data).kind, "invalid", JSON.stringify(data));
  }
  for (const data of [
    { channel: 1, type: "gauntlet:state", contextualCount: -1, globalCount: 0 },
    { channel: 1, type: "gauntlet:state", contextualCount: 1.5, globalCount: 0 },
    { channel: 1, type: "gauntlet:state", contextualCount: 1 },
    { channel: 1, type: "gauntlet:resize", expanded: "yes" },
  ]) {
    assert.equal(parsePanelMessage(data).kind, "invalid", JSON.stringify(data));
  }
});

test("well-formed unknown and reserved types are unknown, per direction", () => {
  assert.deepEqual(parseHostMessage({ channel: 1, type: "gauntlet:fill-form" }), { kind: "unknown", type: "gauntlet:fill-form" });
  assert.deepEqual(parsePanelMessage({ channel: 1, type: "gauntlet:forms" }), { kind: "unknown", type: "gauntlet:forms" });
  assert.deepEqual(parseHostMessage({ channel: 1, type: "gauntlet:state", contextualCount: 1, globalCount: 1 }),
    { kind: "unknown", type: "gauntlet:state" });
  assert.deepEqual(parsePanelMessage({ channel: 1, type: "gauntlet:future-thing", anything: [1] }),
    { kind: "unknown", type: "gauntlet:future-thing" });
});

test("page context enforces IDs, scalar values, uniqueness and limits", () => {
  assert.equal(isPageContext(context), true);
  assert.equal(isPageContext({ target: "shop", subjects: [] }), true);
  const subject = (values: unknown, type: unknown = "order") => ({ target: "shop", subjects: [{ type, values }] });
  for (const bad of [
    { target: "bad id", subjects: [] },
    { target: "shop" },
    subject({ orderId: "1" }, "bad type"),
    subject({ "bad key": "1" }),
    subject({ orderId: null }),
    subject({ orderId: { nested: 1 } }),
    subject({ orderId: Number.NaN }),
    subject({ orderId: Number.POSITIVE_INFINITY }),
    subject({ orderId: "x".repeat(513) }),
    subject(Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, i]))),
    { target: "shop", subjects: [{ type: "order", values: {} }, { type: "order", values: {} }] },
    { target: "shop", subjects: Array.from({ length: 17 }, (_, i) => ({ type: `t${i}`, values: {} })) },
  ]) {
    assert.equal(isPageContext(bad), false, JSON.stringify(bad));
  }
  assert.equal(isPageContext(subject({ orderId: "x".repeat(512) })), true);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @8lines/gauntlet-widget-channel test`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement `src/index.ts`**

Implementation rules, each checked by the tests above:
- A "plain record" is a non-null, non-array object whose prototype is `Object.prototype` or `null`. Read only own enumerable data properties. Values posted through `postMessage` are structured clones, so this is enough.
- `baseType(data)` returns the `type` string when `data` is a plain record with own `channel === 1` and an own string `type` starting with `"gauntlet:"`, and otherwise `undefined`, which yields `invalid`.
- Each parser switches on its known types, validates the payload, and returns a freshly built message object (deep copy for `context`). A known type with a bad payload yields `invalid`. Any other `gauntlet:*` type yields `unknown`.
- `isSubjectValues`: plain record, at most `MAX_SUBJECT_VALUES` keys, portable-ID keys, values that are strings of length ≤ `MAX_STRING_LENGTH`, finite numbers, or booleans.
- `isPageContext`: plain record with portable-ID `target` and an array `subjects` of at most `MAX_SUBJECTS` plain records `{ type: portableId, values: isSubjectValues }` with unique `type`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @8lines/gauntlet-widget-channel test && pnpm --filter @8lines/gauntlet-widget-channel typecheck && pnpm --filter @8lines/gauntlet-widget-channel build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add pnpm-workspace.yaml pnpm-lock.yaml packages/widget-channel
git commit -m "feat(widget-channel): add channel-1 message types and validators"
```

---

### Task 2: `@8lines/gauntlet-widget` package

**Files:**
- Modify: `pnpm-workspace.yaml` (add `packages/widget`)
- Create: `packages/widget/package.json`, `tsconfig.json`, `src/index.ts`, `test/widget.test.ts`, `README.md`, `LICENSE` (copy of `packages/dashboard-client/LICENSE`)

**Interfaces:**
- Produces (exported from `@8lines/gauntlet-widget`):
  ```ts
  export type SubjectValue = string | number | boolean;
  export type SubjectValues = Readonly<Record<string, SubjectValue>>;
  export type RouteRule =
    | { readonly pattern: string; readonly subject: string }
    | { readonly pattern: string; readonly subjects: Readonly<Record<string, readonly string[]>> };
  export type ButtonPosition = "bottom-right" | "bottom-left";
  export interface BootOptions { readonly target: string; readonly routes?: readonly RouteRule[]; readonly position?: ButtonPosition }
  export type GauntletCommandName = "boot" | "setSubject" | "removeSubject" | "open" | "close" | "shutdown";
  export interface GauntletFunction { (command: GauntletCommandName, ...args: unknown[]): void; q?: ArrayLike<unknown>[] }
  export function boot(options: BootOptions): void;
  export function setSubject(type: string, values: SubjectValues): void;
  export function removeSubject(type: string): void;
  export function open(): void;
  export function close(): void;
  export function shutdown(): void;
  /** Injects `<script async src="<origin>/widget/loader.js">` once. `gauntletUrl` is the Gauntlet base URL. */
  export function loadGauntletWidget(gauntletUrl: string): void;
  ```
  Consumed by Task 4, which imports these types with `import type`.

- [ ] **Step 1: Scaffold**

`package.json` follows `packages/dashboard-client/package.json`: same `version`, `type`, `license`, `engines`, `repository` (directory `packages/widget`), `publishConfig`, `exports`, `files: ["dist", "README.md", "LICENSE"]`, and scripts `build`, `prepack` (`pnpm --filter @8lines/gauntlet-widget... build`), `typecheck`, `test`. Set `"description": "Typed, SSR-safe commands and page-subject types for embedding the Gauntlet widget in a web application."`. Add no `dependencies`. `tsconfig.json` is like Task 1, but with `"lib": ["ES2024", "DOM"]`. Add `  - packages/widget` to `pnpm-workspace.yaml` and run `pnpm install`.

- [ ] **Step 2: Write failing tests**

`test/widget.test.ts` runs in Node. Each test installs a minimal fake `window`/`document` on `globalThis` and removes it in `finally`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { boot, close, loadGauntletWidget, open, removeSubject, setSubject, shutdown } from "../src/index.js";

type FakeScript = { src: string; async: boolean };

function withFakeBrowser(action: (win: Record<string, any>, scripts: FakeScript[]) => void): void {
  const scripts: FakeScript[] = [];
  const win: Record<string, any> = {};
  const document = {
    createElement: (tag: string) => { assert.equal(tag, "script"); return { src: "", async: false }; },
    head: { appendChild: (node: FakeScript) => { scripts.push(node); } },
    querySelectorAll: (selector: string) => { assert.equal(selector, "script[src]"); return scripts; },
  };
  Object.assign(globalThis, { window: win, document });
  try {
    action(win, scripts);
  } finally {
    delete (globalThis as Record<string, unknown>).window;
    delete (globalThis as Record<string, unknown>).document;
  }
}

test("commands are no-ops without a window (SSR)", () => {
  assert.equal(typeof (globalThis as Record<string, unknown>).window, "undefined");
  boot({ target: "shop" });
  setSubject("order", { orderId: "1" });
  loadGauntletWidget("https://gauntlet.internal");
});

test("commands install the queue stub and enqueue in call order", () => {
  withFakeBrowser((win) => {
    boot({ target: "shop", routes: [{ pattern: "/orders/:orderId", subject: "order" }] });
    setSubject("order", { orderId: "1" });
    removeSubject("order");
    open();
    close();
    shutdown();
    assert.equal(typeof win.Gauntlet, "function");
    assert.deepEqual(win.Gauntlet.q.map((entry: ArrayLike<unknown>) => Array.from(entry)), [
      ["boot", { target: "shop", routes: [{ pattern: "/orders/:orderId", subject: "order" }] }],
      ["setSubject", "order", { orderId: "1" }],
      ["removeSubject", "order"],
      ["open"],
      ["close"],
      ["shutdown"],
    ]);
  });
});

test("commands call an already loaded Gauntlet function instead of replacing it", () => {
  withFakeBrowser((win) => {
    const calls: unknown[][] = [];
    win.Gauntlet = (...args: unknown[]) => { calls.push(args); };
    open();
    assert.deepEqual(calls, [["open"]]);
  });
});

test("loadGauntletWidget injects one async loader script from the Gauntlet origin", () => {
  withFakeBrowser((_win, scripts) => {
    loadGauntletWidget("https://gauntlet.internal/some/path?x=1");
    loadGauntletWidget("https://gauntlet.internal");
    assert.deepEqual(scripts, [{ src: "https://gauntlet.internal/widget/loader.js", async: true }]);
    assert.throws(() => loadGauntletWidget("ftp://gauntlet.internal"), TypeError);
    assert.throws(() => loadGauntletWidget("not a url"), TypeError);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @8lines/gauntlet-widget test`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement `src/index.ts`**

```ts
function gauntlet(): GauntletFunction | undefined {
  if (typeof window === "undefined") return undefined;
  const host = window as unknown as { Gauntlet?: GauntletFunction };
  if (typeof host.Gauntlet !== "function") {
    const stub: GauntletFunction = function (this: unknown) {
      (stub.q ||= []).push(arguments);
    } as GauntletFunction;
    host.Gauntlet = stub;
  }
  return host.Gauntlet;
}

function command(name: GauntletCommandName, ...args: unknown[]): void {
  gauntlet()?.(name, ...args);
}

export function boot(options: BootOptions): void { command("boot", options); }
export function setSubject(type: string, values: SubjectValues): void { command("setSubject", type, values); }
export function removeSubject(type: string): void { command("removeSubject", type); }
export function open(): void { command("open"); }
export function close(): void { command("close"); }
export function shutdown(): void { command("shutdown"); }

export function loadGauntletWidget(gauntletUrl: string): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  let origin: string;
  try {
    const url = new URL(gauntletUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError();
    origin = url.origin;
  } catch {
    throw new TypeError("Gauntlet URL must be an http(s) URL");
  }
  const src = `${origin}/widget/loader.js`;
  for (const script of Array.from(document.querySelectorAll<HTMLScriptElement>("script[src]"))) {
    if (script.src === src) return;
  }
  const script = document.createElement("script");
  script.async = true;
  script.src = src;
  document.head.appendChild(script);
}
```

(Keep `arguments` so queued entries match the inline snippet exactly.)

- [ ] **Step 5: Run tests, typecheck, build**

Run: `pnpm --filter @8lines/gauntlet-widget test && pnpm --filter @8lines/gauntlet-widget typecheck && pnpm --filter @8lines/gauntlet-widget build`
Expected: PASS.

- [ ] **Step 6: README**

`packages/widget/README.md` covers:
- the inline snippet from the spec;
- the npm usage: `loadGauntletWidget(url)` then `boot({ target, routes })`;
- a short React hook example: `useEffect(() => { setSubject("order", { orderId }); return () => removeSubject("order"); }, [orderId])`;
- a production-gating note ("include only in non-production builds, gated by your own environment flag");
- the rule that the page origin must be listed in `targets[].widget.origins`.

Link back to the documentation index like the other package READMEs.

- [ ] **Step 7: Commit**

```bash
git add pnpm-workspace.yaml pnpm-lock.yaml packages/widget
git commit -m "feat(widget): add typed Gauntlet widget commands package"
```

---

### Task 3: Register `@8lines/gauntlet-widget` as a release artifact

**Files:** every release enumeration of npm packages. Find them with
`grep -rn "gauntlet-conformance-runner" scripts docs --include=*.mjs --include=*.md --include=*.json` and treat each hit as a place to consider. Known places:
- `scripts/release/release-model.mjs`: `RELEASE_ARTIFACTS.npm` gains `{ name: "@8lines/gauntlet-widget", directory: "packages/widget", registry: "https://npm.pkg.github.com" }`. `assertReleaseCatalog` changes the npm count 6 → 7 and the total 14 → 15, and the error text says "fifteen".
- `scripts/release/stage-npm.mjs`: `CONTRACTS["@8lines/gauntlet-widget"]` with files `["dist", "README.md", "LICENSE"]`, roots `["dist"]`, exports `{ ".": { types, import } }`, and no dependencies.
- `scripts/test-packed-npm-packages.mjs`: an import/type smoke for the packed package, following how the other packages are exercised. At minimum it imports every exported function and type-checks a `BootOptions` value.
- `scripts/release/test/*.test.mjs` (`release-model`, `stage-npm`, `inventory`, `package-metadata`): add the package to their expected lists (description text from Task 2).
- Release or distribution docs that list npm packages (for example `docs/releases/*`, `docs/reference/repository.md`) and `CHANGELOG.md` `## Unreleased → ### Added`: "`@8lines/gauntlet-widget` npm package with typed widget commands."

**Interfaces:** none new. The package name, directory and description are those of Task 2.

- [ ] **Step 1: Update the expected lists in the release tests first**

Run: `pnpm release:test`
Expected: FAIL (the catalog does not contain the widget package).

- [ ] **Step 2: Register the artifact in the release model, stager, packed-package test and docs**

- [ ] **Step 3: Verify**

Run: `pnpm release:test && pnpm test:packages && pnpm docs:check`
Expected: PASS. If `test:packages` needs network or Docker that is unavailable, report the exact error instead of skipping.

- [ ] **Step 4: Commit**

```bash
git add scripts docs CHANGELOG.md
git commit -m "build(release): publish @8lines/gauntlet-widget with the npm artifacts"
```

---

### Task 4: Loader core (pure, Node-tested)

**Files:**
- Modify: `pnpm-workspace.yaml` (add `packages/widget-loader`)
- Create: `packages/widget-loader/package.json`, `tsconfig.json`, `src/routes.ts`, `src/subjects.ts`, `src/options.ts`, `src/commands.ts`, `src/handshake.ts`
- Test: `packages/widget-loader/test/routes.test.ts`, `subjects.test.ts`, `options.test.ts`, `commands.test.ts`, `handshake.test.ts`

**Interfaces:**
- Consumes: `@8lines/gauntlet-widget-channel` (Task 1: `PageSubject`, `PageContext`, `isPortableId`, `isSubjectValues`, `parseHandshakeMessage`, limits); `@8lines/gauntlet-widget` types (Task 2: `BootOptions`, `RouteRule`, `SubjectValues`, `ButtonPosition`) via `import type`.
- Produces:
  ```ts
  // routes.ts
  export interface CompiledRoute { readonly pattern: string /* opaque internals allowed */ }
  export function compileRoutes(rules: unknown): readonly CompiledRoute[] | undefined; // undefined = invalid
  export function subjectsForPath(routes: readonly CompiledRoute[], pathname: string): PageSubject[];
  // subjects.ts
  export function mergeSubjects(fromUrl: readonly PageSubject[], explicit: ReadonlyMap<string, SubjectValues>): PageSubject[];
  export function sameContext(a: PageContext | undefined, b: PageContext): boolean;
  // options.ts
  export interface LoaderConfig { readonly target: string; readonly routes: readonly CompiledRoute[]; readonly position: ButtonPosition }
  export type OptionsResult = { readonly ok: true; readonly config: LoaderConfig; readonly ignoredKeys: readonly string[] } | { readonly ok: false; readonly reason: string };
  export function parseBootOptions(value: unknown): OptionsResult;
  // commands.ts
  export interface LoaderRuntime {
    start(config: LoaderConfig): void;
    refresh(): void;          // explicit subjects changed
    open(): void;
    close(): void;
    stop(): void;
  }
  export interface CommandLog { warn(message: string): void }
  export interface CommandProcessor {
    dispatch(name: unknown, args: readonly unknown[]): void;
    explicitSubjects(): ReadonlyMap<string, SubjectValues>;
  }
  export function createCommandProcessor(runtime: LoaderRuntime, log: CommandLog): CommandProcessor;
  export const LOADER_MARK: "__gauntletLoader";
  export function installGlobal(host: { Gauntlet?: unknown }, processor: CommandProcessor): boolean; // false = another loader already installed
  // handshake.ts
  export interface MessageEventLike { readonly origin: string; readonly source: unknown; readonly data: unknown }
  export function panelHandshake(event: MessageEventLike, gauntletOrigin: string, frame: unknown): "ready" | "rejected" | undefined;
  ```

- [ ] **Step 1: Scaffold**

`package.json`: name `@8lines/gauntlet-widget-loader`, `private: true`, `type: module`, dependencies `"@8lines/gauntlet-widget-channel": "workspace:*"`, devDependencies `"@8lines/gauntlet-widget": "workspace:*"`, and scripts `typecheck` and `test` (`tsx --test test/**/*.test.ts`). The build script arrives in Task 5. `tsconfig.json`: extends base, `noEmit: true`, `"lib": ["ES2024", "DOM", "DOM.Iterable"]`, `"types": ["node"]` (tests run in Node), include `src` and `test`. Add `  - packages/widget-loader` to the workspace and run `pnpm install`.

- [ ] **Step 2: Write failing tests**

`test/routes.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { compileRoutes, subjectsForPath } from "../src/routes.js";

const routes = compileRoutes([
  { pattern: "/customers/:customerId/orders/:orderId", subjects: { customer: ["customerId"], order: ["orderId"] } },
  { pattern: "/orders/:orderId", subject: "order" },
  { pattern: "/admin/*", subject: "admin" },
])!;

test("first matching rule wins and captures decoded segments", () => {
  assert.deepEqual(subjectsForPath(routes, "/orders/123"), [{ type: "order", values: { orderId: "123" } }]);
  assert.deepEqual(subjectsForPath(routes, "/orders/123/"), [{ type: "order", values: { orderId: "123" } }]);
  assert.deepEqual(subjectsForPath(routes, "/orders/a%2Fb"), [{ type: "order", values: { orderId: "a/b" } }]);
  assert.deepEqual(subjectsForPath(routes, "/customers/7/orders/9"), [
    { type: "customer", values: { customerId: "7" } },
    { type: "order", values: { orderId: "9" } },
  ]);
  assert.deepEqual(subjectsForPath(routes, "/admin"), [{ type: "admin", values: {} }]);
  assert.deepEqual(subjectsForPath(routes, "/admin/a/b"), [{ type: "admin", values: {} }]);
});

test("non-matching, case-different, empty-segment and malformed paths yield no subjects", () => {
  for (const path of ["/", "/orders", "/Orders/1", "/orders//", "/orders/1/extra", "//orders/1", "/orders/%E0%A4%A", `/orders/${"x".repeat(513)}`]) {
    assert.deepEqual(subjectsForPath(routes, path), [], path);
  }
});

test("a later rule matches when an earlier rule fails to decode", () => {
  const fallback = compileRoutes([
    { pattern: "/orders/:orderId", subject: "order" },
    { pattern: "/orders/*", subject: "orders" },
  ])!;
  assert.deepEqual(subjectsForPath(fallback, "/orders/%E0%A4%A"), [{ type: "orders", values: {} }]);
});

test("invalid rule sets are rejected as a whole", () => {
  for (const rules of [
    "nope",
    [{ pattern: "orders/:id", subject: "order" }],
    [{ pattern: "/orders/:id", subject: "bad type" }],
    [{ pattern: "/orders/:id/:id", subject: "order" }],
    [{ pattern: "/orders/:1id", subject: "order" }],
    [{ pattern: "/a/*/b", subject: "a" }],
    [{ pattern: "/orders/:id", subjects: { order: ["missing"] } }],
    [{ pattern: "/orders/:id", subject: "order", subjects: { order: ["id"] } }],
    [{ pattern: "/orders/:id" }],
    [{ pattern: "/orders/:id", subjects: {} }],
  ]) {
    assert.equal(compileRoutes(rules), undefined, JSON.stringify(rules));
  }
  assert.deepEqual(compileRoutes([]), []);
  assert.deepEqual(compileRoutes(undefined), []);
});
```

(`compileRoutes(undefined)` returns `[]` because `routes` is optional.)

`test/subjects.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeSubjects, sameContext } from "../src/subjects.js";

test("explicit subjects override URL subjects by type and append new types in insertion order", () => {
  const url = [{ type: "customer", values: { customerId: "7" } }, { type: "order", values: { orderId: "9" } }];
  const explicit = new Map([["cart", { cartId: "c" }], ["order", { orderId: "42", paid: true }]]);
  assert.deepEqual(mergeSubjects(url, explicit), [
    { type: "customer", values: { customerId: "7" } },
    { type: "order", values: { orderId: "42", paid: true } },
    { type: "cart", values: { cartId: "c" } },
  ]);
  assert.deepEqual(mergeSubjects(url, new Map()), url);
});

test("context equality is deep and order-sensitive", () => {
  const a = { target: "shop", subjects: [{ type: "order", values: { orderId: "1" } }] };
  assert.equal(sameContext(undefined, a), false);
  assert.equal(sameContext(a, structuredClone(a)), true);
  assert.equal(sameContext(a, { target: "shop", subjects: [{ type: "order", values: { orderId: 1 } }] }), false);
  assert.equal(sameContext(a, { target: "other", subjects: a.subjects }), false);
  const two = { target: "shop", subjects: [{ type: "a", values: {} }, { type: "b", values: {} }] };
  assert.equal(sameContext(two, { target: "shop", subjects: [two.subjects[1]!, two.subjects[0]!] }), false);
});
```

`test/options.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBootOptions } from "../src/options.js";

test("valid options default the position and report ignored keys", () => {
  const result = parseBootOptions({ target: "shop", routes: [{ pattern: "/o/:id", subject: "order" }], colour: "red" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.config.target, "shop");
  assert.equal(result.config.position, "bottom-right");
  assert.equal(result.config.routes.length, 1);
  assert.deepEqual(result.ignoredKeys, ["colour"]);
  const left = parseBootOptions({ target: "shop", position: "bottom-left" });
  assert.equal(left.ok && left.config.position, "bottom-left");
});

test("invalid target, routes or position fail with a reason", () => {
  for (const value of [undefined, null, "shop", {}, { target: "bad id" }, { target: "shop", routes: "x" }, { target: "shop", position: "top" }]) {
    const result = parseBootOptions(value);
    assert.equal(result.ok, false, JSON.stringify(value));
    if (!result.ok) assert.ok(result.reason.length > 0);
  }
});
```

`test/commands.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCommandProcessor, installGlobal, LOADER_MARK, type LoaderRuntime } from "../src/commands.js";

function harness() {
  const calls: string[] = [];
  const warnings: string[] = [];
  const runtime: LoaderRuntime = {
    start: (config) => calls.push(`start:${config.target}`),
    refresh: () => calls.push("refresh"),
    open: () => calls.push("open"),
    close: () => calls.push("close"),
    stop: () => calls.push("stop"),
  };
  const processor = createCommandProcessor(runtime, { warn: (message) => warnings.push(message) });
  return { calls, warnings, processor };
}

test("subjects set before boot are remembered and refresh only after boot", () => {
  const { calls, processor } = harness();
  processor.dispatch("setSubject", ["order", { orderId: "1" }]);
  assert.deepEqual(calls, []);
  processor.dispatch("boot", [{ target: "shop" }]);
  processor.dispatch("setSubject", ["cart", { cartId: "c" }]);
  processor.dispatch("removeSubject", ["order"]);
  assert.deepEqual(calls, ["start:shop", "refresh", "refresh"]);
  assert.deepEqual([...processor.explicitSubjects()], [["cart", { cartId: "c" }]]);
});

test("boot twice, pre-boot open/close, invalid input and unknown commands warn without side effects", () => {
  const { calls, warnings, processor } = harness();
  processor.dispatch("open", []);
  processor.dispatch("close", []);
  processor.dispatch("boot", [{ target: "bad id" }]);
  processor.dispatch("boot", [{ target: "shop" }]);
  processor.dispatch("boot", [{ target: "shop" }]);
  processor.dispatch("setSubject", ["bad type", {}]);
  processor.dispatch("setSubject", ["order", { orderId: { nested: true } }]);
  processor.dispatch("launchMissiles", []);
  assert.deepEqual(calls, ["start:shop"]);
  assert.equal(warnings.length, 7);
  assert.ok(warnings.includes("Gauntlet widget: boot was already called; ignoring"));
});

test("boot warns once about ignored option keys", () => {
  const { warnings, processor } = harness();
  processor.dispatch("boot", [{ target: "shop", colour: "red" }]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /colour/);
});

test("shutdown stops, forgets subjects and allows a new boot", () => {
  const { calls, processor } = harness();
  processor.dispatch("boot", [{ target: "shop" }]);
  processor.dispatch("setSubject", ["order", { orderId: "1" }]);
  processor.dispatch("open", []);
  processor.dispatch("shutdown", []);
  assert.equal(processor.explicitSubjects().size, 0);
  processor.dispatch("boot", [{ target: "admin" }]);
  assert.deepEqual(calls, ["start:shop", "refresh", "open", "stop", "start:admin"]);
});

test("installGlobal replays the stub queue in order and refuses a second loader", () => {
  const { calls, processor } = harness();
  const host: { Gauntlet?: any } = {};
  const stub: any = function () { (stub.q ||= []).push(arguments); };
  host.Gauntlet = stub;
  host.Gauntlet("setSubject", "order", { orderId: "1" });
  host.Gauntlet("boot", { target: "shop" });
  assert.equal(installGlobal(host, processor), true);
  host.Gauntlet("open");
  assert.deepEqual(calls, ["start:shop", "open"]);
  assert.equal(host.Gauntlet[LOADER_MARK], true);

  const second = harness();
  assert.equal(installGlobal(host, second.processor), false);
  host.Gauntlet("close");
  assert.deepEqual(second.calls, []);
  assert.deepEqual(calls, ["start:shop", "open", "close"]);
});
```

`test/handshake.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { panelHandshake } from "../src/handshake.js";

const frame = {};
const origin = "https://gauntlet.internal";

test("ready and rejected are accepted only from the panel frame at the Gauntlet origin", () => {
  assert.equal(panelHandshake({ origin, source: frame, data: { channel: 1, type: "gauntlet:ready" } }, origin, frame), "ready");
  assert.equal(panelHandshake({ origin, source: frame, data: { channel: 1, type: "gauntlet:rejected" } }, origin, frame), "rejected");
  for (const event of [
    { origin: "https://evil.example", source: frame, data: { channel: 1, type: "gauntlet:ready" } },
    { origin, source: {}, data: { channel: 1, type: "gauntlet:ready" } },
    { origin, source: null, data: { channel: 1, type: "gauntlet:ready" } },
    { origin, source: frame, data: { channel: 1, type: "gauntlet:connect", target: "shop" } },
    { origin, source: frame, data: { channel: 2, type: "gauntlet:ready" } },
    { origin, source: frame, data: "gauntlet:ready" },
  ]) {
    assert.equal(panelHandshake(event, origin, frame), undefined, JSON.stringify(event.data));
  }
  assert.equal(panelHandshake({ origin, source: frame, data: { channel: 1, type: "gauntlet:ready" } }, origin, undefined), undefined);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @8lines/gauntlet-widget-loader test`
Expected: FAIL (modules not found).

- [ ] **Step 4: Implement the five modules**

Follow the Global Constraints exactly. Notes:
- `routes.ts`: compile each pattern into a segment list (`{ literal }`, `{ param }`, `{ rest }`). `subjectsForPath` splits `pathname` on `/` after the leading slash, drops one trailing empty segment, and returns the first rule's subjects. Each segment is decoded with `decodeURIComponent` inside `try`.
- `options.ts` uses `compileRoutes`. `ignoredKeys` lists own keys other than `target`, `routes` and `position`, in insertion order.
- `commands.ts`: the warning texts are free-form, except for the exact `boot` duplicate text. Every warning starts with `"Gauntlet widget: "`. `setSubject` validates the type with `isPortableId` and the values with `isSubjectValues`, and stores a shallow copy. `installGlobal` checks `host.Gauntlet?.[LOADER_MARK] === true` and returns `false`. Otherwise it captures the stub's `q` (array-likes), installs a function with the mark set to `true`, and replays each entry as `dispatch(entry[0], Array.from(entry).slice(1))`.
- `handshake.ts` returns `undefined` when `frame` is `undefined`/`null`, and compares `event.source === frame`.

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm --filter @8lines/gauntlet-widget-loader test && pnpm --filter @8lines/gauntlet-widget-loader typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add pnpm-workspace.yaml pnpm-lock.yaml packages/widget-loader
git commit -m "feat(widget-loader): add route matching, subject overlay and command processing"
```

---

### Task 5: Loader DOM runtime, IIFE build and browser tests

**Files:**
- Create: `packages/widget-loader/src/runtime.ts` (DOM runtime implementing `LoaderRuntime`), `src/index.ts` (entry: origin discovery, `installGlobal`), `vite.config.ts`
- Create: `packages/widget-loader/e2e/fixture-server.mjs`, `e2e/loader.spec.ts`, `playwright.config.ts`, `test/build.test.ts`
- Modify: `packages/widget-loader/package.json` (build and e2e scripts, devDependencies `vite` `8.2.2`, `@playwright/test` `1.55.1`, `typescript` matching the workspace), root `package.json` (script `"widget:test:e2e": "pnpm --filter @8lines/gauntlet-widget-loader exec playwright test --reporter=line"`)

**Interfaces:**
- Consumes: Task 4 modules; Task 1 `parsePanelMessage`, `PageContext`.
- Produces: `packages/widget-loader/dist/loader.js` (built by `pnpm --filter @8lines/gauntlet-widget-loader build`), which phase 4 copies into the widget directory, and the DOM contract from Global Constraints.

- [ ] **Step 1: Vite library build and build test (failing first)**

`vite.config.ts`:

```ts
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    minify: true,
    sourcemap: false,
    lib: { entry: "src/index.ts", formats: ["iife"], name: "GauntletWidgetLoader", fileName: () => "loader.js" },
  },
});
```

`package.json` scripts: `"build": "tsc -p tsconfig.json && vite build"`, `"test": "tsx --test test/**/*.test.ts"`, `"test:e2e": "playwright test"`.

`test/build.test.ts` checks the built file and is skipped with a clear message when `dist/loader.js` is missing, because `pnpm check` builds before it tests:

```ts
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

const dist = new URL("../dist/", import.meta.url);
const loader = new URL("loader.js", dist);

test("the loader builds to one dependency-free IIFE within budget", { skip: !existsSync(loader) && "run the build first" }, () => {
  assert.deepEqual(readdirSync(dist), ["loader.js"]);
  const source = readFileSync(loader, "utf8");
  assert.ok(Buffer.byteLength(source) <= 24 * 1024, `loader.js is ${Buffer.byteLength(source)} bytes`);
  assert.doesNotMatch(source, /^\s*(?:import|export)\s/m);
  assert.doesNotMatch(source, /sourceMappingURL/);
});
```

- [ ] **Step 2: Implement `runtime.ts` and `index.ts`**

`index.ts` (entry, top-level side effects only here):

```ts
import { createCommandProcessor, installGlobal } from "./commands.js";
import { createDomRuntime } from "./runtime.js";

function gauntletOrigin(): string | undefined {
  const current = document.currentScript;
  const candidates = [
    current instanceof HTMLScriptElement ? current.src : "",
    ...Array.from(document.querySelectorAll<HTMLScriptElement>('script[src$="/widget/loader.js"]'), (s) => s.src),
  ];
  for (const src of candidates) {
    try {
      if (src) return new URL(src).origin;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

const origin = gauntletOrigin();
if (origin === undefined) {
  console.error("Gauntlet widget: cannot determine the Gauntlet origin from the loader script");
} else {
  let processor: ReturnType<typeof createCommandProcessor>;
  const runtime = createDomRuntime({ gauntletOrigin: origin, explicitSubjects: () => processor.explicitSubjects() });
  processor = createCommandProcessor(runtime, { warn: (message) => console.warn(message) });
  installGlobal(window as unknown as { Gauntlet?: unknown }, processor);
}
```

`runtime.ts` exports `createDomRuntime(options: { gauntletOrigin: string; explicitSubjects(): ReadonlyMap<string, SubjectValues> }): LoaderRuntime`. The DOM contract and timing in Global Constraints are its requirements. Implementation outline:
- `start(config)`: create the host element and closed shadow root with a styled `<button type="button" aria-label="Open Gauntlet" aria-expanded="false">` and a badge `<span>` hidden until `contextualCount > 0`. Position it fixed at 20px from the bottom and the chosen side, with `z-index: 2147483000`. Set `data-gauntlet-state="connecting"`. Add the window `message` listener. Wrap `history.pushState`/`replaceState` (call the original, then schedule recompute), listen to `popstate`, and schedule iframe creation on idle. Compute and store the initial context.
- `ensureFrame()`: create the `<iframe data-gauntlet-panel title="Gauntlet" hidden src="${gauntletOrigin}/widget/">` with fixed styles (`top:0; height:100vh; border:0; z-index:2147483001; width:400px; box-shadow`) on the configured side. Start the 10 000 ms ready timer.
- Window message handler: `panelHandshake(event, gauntletOrigin, frame?.contentWindow)`.
  - `ready`: clear the timer, close the old port, create a `MessageChannel`, set `port1.onmessage`, post `{ channel: 1, type: "gauntlet:connect", target }` with `[port2]` to `gauntletOrigin`, set the state to `ready`, send the context unconditionally (reset the last-sent context first), and send `gauntlet:open` if an open is pending.
  - `rejected`: `console.warn` (see Global Constraints), then become unavailable.
- Port handler: `parsePanelMessage`.
  - `state`: update the badge and `data-gauntlet-count`.
  - `close`: call `close()`.
  - `resize`: set the width.
  - `unknown`: `console.debug("Gauntlet widget: ignoring unknown message", type)`.
  - `invalid`: ignore.
- Unavailable: `data-gauntlet-state="unavailable"`, button `disabled`, iframe hidden. After the 10 s timeout: `data-gauntlet-reason="unreachable"` and `title="Cannot reach Gauntlet"`; after `gauntlet:rejected`: `data-gauntlet-reason="rejected"` and `title="Gauntlet rejected this page (origin or target) — see the browser console"`.
- Recompute: debounce 50 ms. Context = `{ target, subjects: mergeSubjects(subjectsForPath(routes, location.pathname), explicitSubjects()) }`. When connected and `!sameContext(last, next)`, post `gauntlet:context` and store it. Before connection, only store it.
- `refresh()`: recompute immediately (no debounce).
- `open()`: `ensureFrame()`, show the iframe, `aria-expanded="true"`, and post `gauntlet:open` if connected (otherwise mark it pending). `close()`: hide the iframe and set `aria-expanded="false"`. The button click toggles between them.
- `stop()`: remove the host and iframe, remove the listeners, close the port, clear the timers, and restore the history methods only if `history.pushState` is still the wrapper.

- [ ] **Step 3: Fixture server and fake panel**

`e2e/fixture-server.mjs` starts two HTTP servers:
- the host on `127.0.0.1:4390`;
- Gauntlet on `localhost:4391`, which has a different origin because the host name differs;
- plus a third, `127.0.0.1:4392`, as an unlisted "other" host.

Gauntlet (`localhost:4391`) serves:
- `/widget/loader.js`: `packages/widget-loader/dist/loader.js`;
- `/widget/`: a fake panel page, described below;
- `/widget/config.json`: `{ "targets": { "shop": ["http://127.0.0.1:4390"] } }`;
- `/silent/widget/loader.js`: the same loader;
- `/silent/widget/`: a page that never posts `ready`.

The fake panel page:
1. fetches `config.json`, then posts `{ channel: 1, type: "gauntlet:ready" }` to `parent` with `"*"`;
2. on `gauntlet:connect` from `parent`, checks that `event.origin` is listed for `data.target`, or else posts `gauntlet:rejected`;
3. stores the port and pushes every received port message into `window.received`;
4. replies `{ channel: 1, type: "gauntlet:state", contextualCount: <number of subjects>, globalCount: 1 }` after each context;
5. exposes `window.panelSend(msg)`, which posts on the port, so tests can send `close` and `resize`.

The host servers serve `/host.html?…` pages that render the stub snippet, then a configurable inline script, then `<script src="http://localhost:4391/widget/loader.js" async>`. The simplest design is a page whose query parameter `scenario` selects one of a few inline scripts that are hard-coded in the fixture. Every host path under `/orders/*`, `/customers/*` and `/plain` returns the same host page, so `pushState` targets exist on reload.

`playwright.config.ts`: `testDir: "./e2e"`, `webServer: { command: "node e2e/fixture-server.mjs", url: "http://localhost:4391/widget/config.json", reuseExistingServer: false }`, `use.channel` as in `apps/dashboard/playwright.config.ts`, a single `chromium` project, and `outputDir: "../../node_modules/.cache/gauntlet-widget-loader/playwright"`.

- [ ] **Step 4: Browser tests**

`e2e/loader.spec.ts` covers these cases:
1. **Contextual subject:** open `http://127.0.0.1:4390/orders/123?secret=x#frag` with a `boot({ target: "shop", routes: [{ pattern: "/orders/:orderId", subject: "order" }] })` scenario.
   - The panel frame (find it with `page.frames()` by URL `http://localhost:4391/widget/`) eventually has `received` containing a `gauntlet:context` whose `context` deep-equals `{ target: "shop", subjects: [{ type: "order", values: { orderId: "123" } }] }`.
   - No received message contains `secret`, `frag` or `127.0.0.1`.
   - The host element reaches `data-gauntlet-state="ready"` and `data-gauntlet-count="1"`.
2. **SPA navigation:** `history.pushState({}, "", "/orders/456")` produces a second context with `orderId: "456"`. `pushState` to `/orders/456?x=1` then `replaceState` to `/orders/456` produce no third context (count the context messages after waiting 300 ms).
3. **Explicit override:** `Gauntlet("setSubject", "order", { orderId: "999" })` → context with `999`. `Gauntlet("removeSubject", "order")` → context back to the URL value.
4. **Queued commands:** a scenario calls `Gauntlet("setSubject", "cart", { cartId: "c1" })` before `boot` and before the loader tag. The first context contains both `order` and `cart`.
5. **Open/close:**
   - Clicking the centre of `[data-gauntlet-widget]`'s bounding box makes `iframe[data-gauntlet-panel]` visible, and the panel receives `gauntlet:open`.
   - `panelSend({ channel: 1, type: "gauntlet:resize", expanded: true })` widens the iframe beyond 400 px.
   - `panelSend({ channel: 1, type: "gauntlet:close" })` hides it.
6. **Rejected origin:** the same page on `127.0.0.1:4392` (unlisted) reaches `data-gauntlet-state="unavailable"`, and a `console.warn` mentions `http://127.0.0.1:4392` and `shop`.
7. **Unreachable:** a scenario loading `/silent/widget/loader.js` with `page.clock.install()` before navigation, then `page.clock.runFor(11_000)` → `data-gauntlet-state="unavailable"`.
8. **Foreign ready:** a scenario adds a second iframe from `http://127.0.0.1:4392/evil.html` that posts `{ channel: 1, type: "gauntlet:ready" }` to its parent. The evil frame never receives a `MessagePort`: it records `event.ports.length` of anything it receives into `window.gotPort`, which stays `false`. The real panel still connects exactly once.
9. **Panel reload:** reloading the panel frame (`frame.evaluate(() => location.reload())`) leads to a second `connect`. A `panelSend` on the new port works, and the old port no longer delivers: the fake panel keeps the old port as `window.oldPort`, and messages posted on it after the reconnect do not change the host state.
10. **Double loader and shutdown:**
    - A scenario that includes the loader tag twice ends with exactly one `[data-gauntlet-widget]` and one `iframe[data-gauntlet-panel]`.
    - `Gauntlet("shutdown")` removes both.
    - After `history.pushState`, the panel receives nothing and `history.pushState.toString()` no longer shows the wrapper; comparing against a saved reference is fine.

- [ ] **Step 5: Run everything**

Run:

```bash
pnpm --filter @8lines/gauntlet-widget-loader build
pnpm --filter @8lines/gauntlet-widget-loader test
pnpm widget:test:e2e
pnpm check
```

Expected: all PASS. If Chromium is missing locally, run `pnpm --filter @8lines/gauntlet-widget-loader exec playwright install chromium` once.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml packages/widget-loader
git commit -m "feat(widget-loader): add DOM runtime, IIFE build and browser tests"
```

---

## Out of scope for this phase

- The real panel (phase 4) and copying `loader.js` into `GAUNTLET_WIDGET_DIR`, the Dockerfile and product-image checks (phase 4).
- `docs/integrations/widget.md` (phase 4, once the panel exists). This phase documents the package in its README only.
