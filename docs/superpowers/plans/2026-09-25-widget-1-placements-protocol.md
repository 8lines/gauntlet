# Widget Phase 1: Operation Placements in Protocol, SDKs, Conformance and MCP

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Operations can declare `placements` (global or bound to a page subject); the field is schema-validated, semantically checked identically in TypeScript, PHP and Java, emitted by all three SDKs with automatic `gauntlet-page-placements@1` profile advertisement, verified by conformance, and filterable through MCP.

**Architecture:** `placements` is an optional array on `operationSummary` (manifest) and `operationDefinition`. The canonical rules live in `packages/protocol` (JSON Schema + `operationSemanticsAreValid` / `manifestSemanticsAreValid`) and are mirrored by PHP and Java `ProtocolSemantics`; shared document vectors in `packages/protocol/fixtures/v1/adapter-semantic-vectors.json` pin all three implementations to the same outcomes. Each SDK derives the profile from registered operations and copies placements into summaries. The control plane needs no mapping code: it validates manifests with the protocol schema and passes summaries through verbatim.

**Tech Stack:** TypeScript (Node 24, `node:test` via `tsx`, Ajv 2020), PHP 8.3 (PHPUnit 11), Java 21 (JUnit 5, Gradle), Zod (MCP input), pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-09-25-embeddable-widget-design.md` (sections *Protocol: placements*, *MCP*).

## Global Constraints

- Product name is **Gauntlet**. New identifiers use the `gauntlet` prefix; the new profile ID is exactly `gauntlet-page-placements@1`.
- Placement shape: `{ "kind": "global" }` or `{ "kind": "subject", "subjectType": <portableId>, "bindings"?: { <non-empty JSON Pointer>: <portableId> } }`. No other keys.
- `portableId` pattern: `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`.
- Semantic rules (all three languages, identical outcomes):
  1. every binding pointer resolves through `properties` only (no `$ref`, combinators or arrays) to a schema whose `enum` is a non-empty list of strings/numbers/booleans, or whose `const` is a string/number/boolean, or whose `type` is exactly one of `string`, `number`, `integer`, `boolean`;
  2. a binding's schema pointer (`/properties/a/properties/b` for input pointer `/a/b`) must not equal, or be nested under, any `inputHandling.rules[].schemaPointer` (secret or file);
  3. at most one `global` placement; each `subjectType` at most once;
  4. `placements`, when present, has at least one item;
  5. a manifest in which any operation summary has `placements` must list `gauntlet-page-placements@1` in `profiles`.
- Summary `placements` must deep-equal definition `placements` (checked by conformance).
- Existing public constructors in PHP and Java stay source-compatible (new parameters are appended with defaults / added as overloads).
- Do not edit `tc-*` profile IDs.
- Commit after each task with a Conventional Commit message ending with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

- A binding pointer containing escaped segments (`/a~1b`, `/a~0b`) must resolve to property `a/b` / `a~b`, not fail or match the wrong property — pinned in Task 2 vectors and Task 4/5 unit tests.
- A binding to a field nested inside a file object (`/attachment/name` when `/properties/attachment` is a file rule) must be rejected, not only exact matches — pinned in Task 2 vectors.
- An operation with `placements: []` must be rejected by the schema, not silently treated as "no placements" — pinned in Task 1 schema test.
- An adapter declaring placements while its application passes an explicit profile list that already contains `gauntlet-page-placements@1` must not duplicate the profile — pinned in Tasks 3, 4, 5.
- MCP `subjectType` filtering must not drop targets or operations without placements when the filter is absent, and must keep offline targets in the list (with an empty filtered operations array) when present — pinned in Task 7.

---

### Task 1: Protocol schema and wire types

**Files:**
- Modify: `packages/protocol/schemas/v1/common.schema.json` (add `$defs.operationPlacement`, `$defs.operationPlacements`)
- Modify: `packages/protocol/schemas/v1/manifest.schema.json` (`$defs.operationSummary.properties`)
- Modify: `packages/protocol/schemas/v1/operation-definition.schema.json` (root `properties`)
- Modify: `packages/protocol/src/types.ts` (new types; `OperationSummary`, `OperationDefinition`)
- Test: `packages/protocol/test/placements-schema.test.ts` (new)

**Interfaces:**
- Produces (TS, exported from `@8lines/gauntlet-protocol`):
  ```ts
  export type OperationPlacement =
    | { readonly kind: "global" }
    | { readonly kind: "subject"; readonly subjectType: ProtocolId; readonly bindings?: Readonly<Record<JsonPointer, ProtocolId>> };
  // OperationSummary.placements?: readonly OperationPlacement[]
  // OperationDefinition.placements?: readonly OperationPlacement[]
  ```

- [ ] **Step 1: Write the failing schema test**

Create `packages/protocol/test/placements-schema.test.ts`:

```ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const schemasUrl = new URL("../schemas/v1/", import.meta.url);
const fixturesUrl = new URL("../fixtures/v1/", import.meta.url);
const json = async (url: URL) => JSON.parse(await readFile(url, "utf8"));

async function validators() {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats.default(ajv);
  for (const name of ["common", "problem", "manifest", "operation-definition"]) {
    ajv.addSchema(await json(new URL(`${name}.schema.json`, schemasUrl)));
  }
  return {
    operation: ajv.getSchema("https://schemas.8lines.dev/gauntlet/v1/operation-definition.schema.json")!,
    manifest: ajv.getSchema("https://schemas.8lines.dev/gauntlet/v1/manifest.schema.json")!,
  };
}

const valid = [
  [{ kind: "global" }],
  [{ kind: "subject", subjectType: "order" }],
  [{ kind: "global" }, { kind: "subject", subjectType: "order", bindings: { "/applicationId": "orderId", "/a~1b": "k" } }],
];
const invalid = [
  [],
  [{ kind: "page" }],
  [{ kind: "global", subjectType: "order" }],
  [{ kind: "subject" }],
  [{ kind: "subject", subjectType: "bad id" }],
  [{ kind: "subject", subjectType: "order", bindings: { "": "orderId" } }],
  [{ kind: "subject", subjectType: "order", bindings: { "applicationId": "orderId" } }],
  [{ kind: "subject", subjectType: "order", bindings: { "/applicationId": "bad key" } }],
  [{ kind: "subject", subjectType: "order", extra: true }],
];

test("operation definitions accept only well-formed placements", async () => {
  const { operation } = await validators();
  const base = await json(new URL("operation.valid.json", fixturesUrl));
  for (const placements of valid) assert.equal(operation({ ...base, placements }), true, JSON.stringify(placements));
  for (const placements of invalid) assert.equal(operation({ ...base, placements }), false, JSON.stringify(placements));
});

test("operation summaries accept only well-formed placements", async () => {
  const { manifest } = await validators();
  const base = await json(new URL("manifest.valid.json", fixturesUrl));
  const withPlacements = (placements: unknown) => ({
    ...base,
    operations: base.operations.map((summary: object, index: number) => index === 0 ? { ...summary, placements } : summary),
  });
  for (const placements of valid) assert.equal(manifest(withPlacements(placements)), true, JSON.stringify(placements));
  for (const placements of invalid) assert.equal(manifest(withPlacements(placements)), false, JSON.stringify(placements));
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm --filter @8lines/gauntlet-protocol exec tsx --test test/placements-schema.test.ts`
Expected: FAIL — valid placements rejected (`additionalProperties: false`).

- [ ] **Step 3: Add the schema definitions**

In `common.schema.json` `$defs`, after `jsonPointer`, add:

```json
"operationPlacement": {
  "oneOf": [
    {
      "type": "object",
      "required": ["kind"],
      "properties": { "kind": { "const": "global" } },
      "additionalProperties": false
    },
    {
      "type": "object",
      "required": ["kind", "subjectType"],
      "properties": {
        "kind": { "const": "subject" },
        "subjectType": { "$ref": "#/$defs/portableId" },
        "bindings": {
          "type": "object",
          "propertyNames": { "type": "string", "pattern": "^(?:/(?:[^~/]|~[01])*)+$" },
          "additionalProperties": { "$ref": "#/$defs/portableId" }
        }
      },
      "additionalProperties": false
    }
  ]
},
"operationPlacements": {
  "type": "array",
  "minItems": 1,
  "items": { "$ref": "#/$defs/operationPlacement" }
},
```

In `manifest.schema.json` `$defs.operationSummary.properties`, after `requirements`:

```json
"placements": { "$ref": "./common.schema.json#/$defs/operationPlacements" },
```

In `operation-definition.schema.json` root `properties`, after `requirements`:

```json
"placements": { "$ref": "./common.schema.json#/$defs/operationPlacements" },
```

- [ ] **Step 4: Add the TS types**

In `packages/protocol/src/types.ts`, above `OperationIdentity`:

```ts
export type OperationPlacement =
  | { readonly kind: "global" }
  | {
      readonly kind: "subject";
      readonly subjectType: ProtocolId;
      readonly bindings?: Readonly<Record<JsonPointer, ProtocolId>>;
    };
```

Add `readonly placements?: readonly OperationPlacement[];` to `OperationSummary` (after `requirements`) and to `OperationDefinition` (after `requirements`).

- [ ] **Step 5: Run the protocol suite**

Run: `pnpm --filter @8lines/gauntlet-protocol test && pnpm --filter @8lines/gauntlet-protocol typecheck`
Expected: PASS (existing fixtures have no placements; revisions unchanged).

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/schemas/v1 packages/protocol/src/types.ts packages/protocol/test/placements-schema.test.ts
git commit -m "feat(protocol): add operation placements to Adapter v1 schemas"
```

---

### Task 2: Canonical placement semantics and shared vectors

**Files:**
- Create: `packages/protocol/src/placements.ts`
- Modify: `packages/protocol/src/semantic-validation.ts` (`manifestSemanticsAreValid`, `operationSemanticsAreValid`)
- Modify: `packages/protocol/src/index.ts` (export `./placements.js`)
- Modify: `packages/protocol/test/support/semantic-vector-loader.ts` (export `computeVectorRevision`)
- Create: `packages/protocol/test/support/print-vector-revisions.ts`
- Modify: `packages/protocol/fixtures/v1/adapter-semantic-vectors.json` (append vectors)
- Test: `packages/protocol/test/placements-semantics.test.ts` (new); existing `semantic-validation.test.ts` runs the vectors

**Interfaces:**
- Consumes: `OperationPlacement`, `OperationDefinition`, `AdapterManifest` from Task 1.
- Produces:
  ```ts
  export const PAGE_PLACEMENTS_PROFILE = "gauntlet-page-placements@1";
  export function placementSchemaPointer(inputPointer: JsonPointer): JsonPointer | undefined;
  export function operationPlacementsAreValid(operation: Pick<OperationDefinition, "inputSchema" | "inputHandling" | "placements">): boolean;
  ```

- [ ] **Step 1: Write the failing unit test**

Create `packages/protocol/test/placements-semantics.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PAGE_PLACEMENTS_PROFILE,
  manifestSemanticsAreValid,
  operationPlacementsAreValid,
  operationSemanticsAreValid,
  placementSchemaPointer,
  type AdapterManifest,
  type JsonObject,
  type OperationDefinition,
  type OperationPlacement,
} from "../src/index.js";
import { computeRevision } from "../src/revision.js";
import { validManifest, validOperation } from "./support/semantic-fixtures.js";

const inputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    orderId: { type: "string" },
    count: { type: "integer" },
    flag: { type: "boolean" },
    mode: { enum: ["a", "b"] },
    fixed: { const: 3 },
    "a/b": { type: "string" },
    "a~b": { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    nested: { type: "object", properties: { id: { type: "number" } } },
    either: { type: ["string", "null"] },
    token: { type: "string" },
    attachment: { type: "object", properties: { name: { type: "string" } } },
    referenced: { $ref: "#/$defs/id" },
  },
  $defs: { id: { type: "string" } },
} as const;
const inputHandling = {
  rules: [
    { kind: "secret" as const, schemaPointer: "/properties/token", retention: "none" as const },
    { kind: "file" as const, schemaPointer: "/properties/attachment", multiple: false },
  ],
};
const check = (placements: readonly OperationPlacement[]) =>
  operationPlacementsAreValid({ inputSchema: inputSchema as never, inputHandling, placements });
const bind = (pointer: string): OperationPlacement[] =>
  [{ kind: "subject", subjectType: "order", bindings: { [pointer]: "orderId" } }];

test("placementSchemaPointer maps input pointers through properties", () => {
  assert.equal(placementSchemaPointer("/orderId"), "/properties/orderId");
  assert.equal(placementSchemaPointer("/nested/id"), "/properties/nested/properties/id");
  assert.equal(placementSchemaPointer("/a~1b"), "/properties/a~1b");
  assert.equal(placementSchemaPointer(""), undefined);
  assert.equal(placementSchemaPointer("/a~2b"), undefined);
});

test("bindings must target scalar properties reachable through properties", () => {
  for (const pointer of ["/orderId", "/count", "/flag", "/mode", "/fixed", "/a~1b", "/a~0b", "/nested/id"]) {
    assert.equal(check(bind(pointer)), true, pointer);
  }
  for (const pointer of ["/tags", "/nested", "/either", "/missing", "/referenced", "/tags/0"]) {
    assert.equal(check(bind(pointer)), false, pointer);
  }
});

test("bindings must not target secret or file fields or their children", () => {
  assert.equal(check(bind("/token")), false);
  assert.equal(check(bind("/attachment/name")), false);
});

test("placement kinds are unique per operation", () => {
  assert.equal(check([{ kind: "global" }, { kind: "subject", subjectType: "order" }]), true);
  assert.equal(check([{ kind: "global" }, { kind: "global" }]), false);
  assert.equal(check([{ kind: "subject", subjectType: "order" }, { kind: "subject", subjectType: "order" }]), false);
  assert.equal(check([]), false);
});

test("operation semantics include placement rules", () => {
  const withPlacements = (placements: readonly OperationPlacement[]): OperationDefinition => {
    const draft = { ...validOperation, placements } as OperationDefinition;
    return { ...draft, revision: computeRevision(draft as unknown as JsonObject) };
  };
  assert.equal(operationSemanticsAreValid(withPlacements([{ kind: "subject", subjectType: "application", bindings: { "/applicationId": "applicationId" } }])), true);
  assert.equal(operationSemanticsAreValid(withPlacements([{ kind: "subject", subjectType: "application", bindings: { "/apiToken": "token" } }])), false);
});

test("manifests with placements must declare the placements profile", () => {
  const manifest = (profiles: readonly string[]): AdapterManifest => {
    const draft = {
      ...validManifest,
      profiles,
      operations: validManifest.operations.map((summary, index) =>
        index === 0 ? { ...summary, placements: [{ kind: "global" as const }] } : summary),
    } as AdapterManifest;
    return { ...draft, manifestRevision: computeRevision(draft as unknown as JsonObject, "manifestRevision") };
  };
  assert.equal(manifestSemanticsAreValid(manifest(validManifest.profiles)), false);
  assert.equal(manifestSemanticsAreValid(manifest([...validManifest.profiles, PAGE_PLACEMENTS_PROFILE])), true);
});
```

Before running, confirm `validOperation.inputSchema` has `applicationId` (string) and `apiToken` (secret rule at `/properties/apiToken`) — both are in `fixtures/v1/operation.valid.json` — and that `validManifest` is exported from `test/support/semantic-fixtures.ts` with at least one operation summary.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm --filter @8lines/gauntlet-protocol exec tsx --test test/placements-semantics.test.ts`
Expected: FAIL — `operationPlacementsAreValid` is not exported.

- [ ] **Step 3: Implement `src/placements.ts`**

```ts
import type { JsonPointer, OperationDefinition } from "./types.js";

export const PAGE_PLACEMENTS_PROFILE = "gauntlet-page-placements@1";

const SCALAR_TYPES = new Set(["string", "number", "integer", "boolean"]);

function decodeSegments(pointer: string): readonly string[] | undefined {
  if (pointer === "" || !pointer.startsWith("/")) return undefined;
  const segments: string[] = [];
  for (const raw of pointer.slice(1).split("/")) {
    if (/~(?![01])/.test(raw)) return undefined;
    segments.push(raw.replaceAll("~1", "/").replaceAll("~0", "~"));
  }
  return segments;
}

function encodeSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

export function placementSchemaPointer(inputPointer: JsonPointer): JsonPointer | undefined {
  const segments = decodeSegments(inputPointer);
  return segments === undefined
    ? undefined
    : segments.map((segment) => `/properties/${encodeSegment(segment)}`).join("");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isScalar(value: unknown): boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function scalarLeaf(schema: Record<string, unknown>): boolean {
  if (Object.hasOwn(schema, "$ref")) return false;
  if (Object.hasOwn(schema, "enum")) {
    const values = schema.enum;
    return Array.isArray(values) && values.length > 0 && values.every(isScalar);
  }
  if (Object.hasOwn(schema, "const")) return isScalar(schema.const);
  return typeof schema.type === "string" && SCALAR_TYPES.has(schema.type);
}

function bindingTargetIsScalar(inputSchema: unknown, pointer: string): boolean {
  const segments = decodeSegments(pointer);
  if (segments === undefined) return false;
  let node = record(inputSchema);
  for (const segment of segments) {
    if (node === undefined || Object.hasOwn(node, "$ref")) return false;
    const properties = record(node.properties);
    if (properties === undefined || !Object.hasOwn(properties, segment)) return false;
    node = record(properties[segment]);
  }
  return node !== undefined && scalarLeaf(node);
}

export function operationPlacementsAreValid(
  operation: Pick<OperationDefinition, "inputSchema" | "inputHandling" | "placements">,
): boolean {
  const placements = operation.placements;
  if (placements === undefined) return true;
  if (placements.length === 0) return false;
  const guarded = operation.inputHandling?.rules.map(({ schemaPointer }) => schemaPointer) ?? [];
  let globals = 0;
  const subjectTypes = new Set<string>();
  for (const placement of placements) {
    if (placement.kind === "global") {
      globals += 1;
      continue;
    }
    if (subjectTypes.has(placement.subjectType)) return false;
    subjectTypes.add(placement.subjectType);
    for (const pointer of Object.keys(placement.bindings ?? {})) {
      const schemaPointer = placementSchemaPointer(pointer);
      if (schemaPointer === undefined || !bindingTargetIsScalar(operation.inputSchema, pointer)) return false;
      if (guarded.some((rule) => schemaPointer === rule || schemaPointer.startsWith(`${rule}/`))) return false;
    }
  }
  return globals <= 1;
}
```

- [ ] **Step 4: Wire into semantic validation and exports**

In `semantic-validation.ts`, import `{ PAGE_PLACEMENTS_PROFILE, operationPlacementsAreValid } from "./placements.js"`.

In `manifestSemanticsAreValid`, directly after `const capabilities = new Set(manifest.capabilities);` add:

```ts
    if (manifest.operations.some((operation) => operation.placements !== undefined)
      && !profiles.has(PAGE_PLACEMENTS_PROFILE)) {
      return false;
    }
```

In `operationSemanticsAreValid`, directly after the `operationPresetsOmitSecrets` check add:

```ts
    if (!operationPlacementsAreValid(operation)) {
      return false;
    }
```

In `src/index.ts` add `export * from "./placements.js";`.

- [ ] **Step 5: Run the unit test**

Run: `pnpm --filter @8lines/gauntlet-protocol exec tsx --test test/placements-semantics.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the vector revision helper**

In `test/support/semantic-vector-loader.ts`, add and export:

```ts
export function computeVectorRevision(
  loaded: LoadedSemanticVectors,
  vector: ManifestDocumentVector | OperationDocumentVector,
): string {
  const source = loaded.sources.get(vector.document.source);
  if (source === undefined) invalid(vector.id);
  const revisionField = vector.predicate === "manifest" ? "manifestRevision" : "revision";
  return computeRevision(applyPatches(source, vector.document.patches, vector.id, revisionField), revisionField);
}
```

Create `test/support/print-vector-revisions.ts`. It reads the raw artifact without the loader's revision checks, so it works while vectors still carry placeholder values:

```ts
import { readFile } from "node:fs/promises";
import { computeVectorRevision, loadSemanticVectors } from "./semantic-vector-loader.js";

// Usage: tsx test/support/print-vector-revisions.ts <vector-id-prefix>
const prefix = process.argv[2] ?? "";
const raw = JSON.parse(await readFile(new URL("../../fixtures/v1/adapter-semantic-vectors.json", import.meta.url), "utf8"));
const loaded = await loadSemanticVectors({ skipRevisionChecks: true });
for (const vector of raw.documentVectors) {
  if (vector.predicate === "resolve" || !vector.id.startsWith(prefix)) continue;
  console.log(`${vector.id} ${computeVectorRevision(loaded, vector)}`);
}
```

Add the `skipRevisionChecks` option to `loadSemanticVectors` (default `false`). When `true`, the loader must still load sources but must not materialize or verify document vectors. Read `loadSemanticVectors` (line ~570) and thread the flag to wherever it eagerly checks vectors. If it never checks vectors eagerly, accept and ignore the option.

- [ ] **Step 7: Append shared document vectors**

Append these vectors to `documentVectors` in `fixtures/v1/adapter-semantic-vectors.json`, with `"revision": { "mode": "set", "value": "sha256:0000000000000000000000000000000000000000000000000000000000000000", "expect": "match" }` placeholders:

| id | predicate | patches | expected |
|---|---|---|---|
| `operation.placements.valid` | operation | `add /placements [{"kind":"global"},{"kind":"subject","subjectType":"application","bindings":{"/applicationId":"applicationId","/options/mode":"mode"}}]` | true |
| `operation.placements.binding-secret` | operation | `add /placements [{"kind":"subject","subjectType":"application","bindings":{"/apiToken":"token"}}]` | false |
| `operation.placements.binding-file-child` | operation | `add /placements [{"kind":"subject","subjectType":"application","bindings":{"/attachment/name":"name"}}]` | false |
| `operation.placements.binding-array` | operation | `add /placements [{"kind":"subject","subjectType":"application","bindings":{"/roles":"roles"}}]` | false |
| `operation.placements.binding-object` | operation | `add /placements [{"kind":"subject","subjectType":"application","bindings":{"/options":"options"}}]` | false |
| `operation.placements.binding-missing` | operation | `add /placements [{"kind":"subject","subjectType":"application","bindings":{"/missing":"missing"}}]` | false |
| `operation.placements.duplicate-global` | operation | `add /placements [{"kind":"global"},{"kind":"global"}]` | false |
| `operation.placements.duplicate-subject` | operation | `add /placements [{"kind":"subject","subjectType":"application"},{"kind":"subject","subjectType":"application"}]` | false |
| `manifest.placements.profile-declared` | manifest | `add /operations/0/placements [{"kind":"global"}]`, `add /profiles/- "gauntlet-page-placements@1"` | true |
| `manifest.placements.profile-missing` | manifest | `add /operations/0/placements [{"kind":"global"}]` | false |

Check the patch profile (`rfc6902-test-subset@1`) accepts `/-` array appends. If it does not, replace the whole array with `replace /profiles [...existing..., "gauntlet-page-placements@1"]`, copying the existing values from `manifest.valid.json`. Also confirm `operation.valid.json` has `/options/mode` as an enum and `/attachment` as a file rule; both appear in the fixture shown in the plan context.

Run: `pnpm --filter @8lines/gauntlet-protocol exec tsx test/support/print-vector-revisions.ts operation.placements && pnpm --filter @8lines/gauntlet-protocol exec tsx test/support/print-vector-revisions.ts manifest.placements`

Replace each placeholder with the printed revision.

- [ ] **Step 8: Run the full protocol suite**

Run: `pnpm --filter @8lines/gauntlet-protocol test && pnpm --filter @8lines/gauntlet-protocol typecheck`
Expected: PASS, including `all shared manifest, operation, and resolve vectors satisfy their semantic outcomes`.

- [ ] **Step 9: Commit**

```bash
git add packages/protocol
git commit -m "feat(protocol): validate operation placements and pin shared vectors"
```

---

### Task 3: TypeScript SDK emits placements and the profile

**Files:**
- Create: `packages/typescript/core/src/placements.ts`
- Modify: `packages/typescript/core/src/index.ts` (export)
- Modify: `packages/typescript/core/src/adapter-catalog.ts:108-146` (profiles union, summary copy)
- Modify: `examples/typescript-fixture/src/index.ts` (`operationMetadata` adds a placement)
- Test: `packages/typescript/core/test/placements.test.ts` (new)

**Interfaces:**
- Consumes: `PAGE_PLACEMENTS_PROFILE`, `OperationPlacement` from `@8lines/gauntlet-protocol`.
- Produces:
  ```ts
  export function globalPlacement(): OperationPlacement;
  export function subjectPlacement(subjectType: string, bindings?: Readonly<Record<string, string>>): OperationPlacement;
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/typescript/core/test/placements.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { PAGE_PLACEMENTS_PROFILE } from "@8lines/gauntlet-protocol";
import {
  CapabilityRegistry, DataSourceRegistry, OperationRegistry, createAdapterCatalog, createAjvSchemaValidator,
  globalPlacement, subjectPlacement,
} from "../src/index.js";
import { feature, operation } from "./support/operation.js";

const inputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: { orderId: { type: "string" }, token: { type: "string" } },
} as const;

function catalogWith(operations: ReturnType<typeof operation>[], profiles: readonly `${string}@${number}`[] = ["tc-schema-core@1"]) {
  const registry = new OperationRegistry();
  registry.registerFeature(feature("orders"));
  for (const value of operations) registry.register(value);
  return createAdapterCatalog({
    application: { id: "fixture", label: "Fixture", environment: { name: "fixture-test", kind: "test" } },
    profiles, capabilities: new CapabilityRegistry(), operations: registry,
    dataSources: new DataSourceRegistry(), runs: { create: async () => ({ ok: true, run: {} }), get: async () => undefined } as never,
    schemaValidator: createAjvSchemaValidator(),
  });
}

test("placement helpers build protocol placements", () => {
  assert.deepEqual(globalPlacement(), { kind: "global" });
  assert.deepEqual(subjectPlacement("order"), { kind: "subject", subjectType: "order" });
  assert.deepEqual(subjectPlacement("order", { "/orderId": "orderId" }),
    { kind: "subject", subjectType: "order", bindings: { "/orderId": "orderId" } });
});

test("defineOperation rejects invalid placements at registration time", () => {
  assert.throws(() => operation("orders.pay", { inputSchema, placements: [subjectPlacement("order", { "/missing": "orderId" })] }), /shared protocol semantics/i);
  assert.throws(() => operation("orders.pay", {
    inputSchema, inputHandling: { rules: [{ kind: "secret", schemaPointer: "/properties/token", retention: "none" }] },
    placements: [subjectPlacement("order", { "/token": "token" })],
  }), /shared protocol semantics/i);
  assert.throws(() => operation("orders.pay", { inputSchema, placements: [globalPlacement(), globalPlacement()] }), /shared protocol semantics/i);
});

test("manifest summaries carry placements and advertise the profile once", () => {
  const placements = [subjectPlacement("order", { "/orderId": "orderId" })];
  const catalog = catalogWith([operation("orders.pay", { inputSchema, placements }), operation("orders.list", { inputSchema })]);
  const manifest = catalog.manifest();
  assert.deepEqual(manifest.operations.find(({ id }) => id === "orders.pay")?.placements, placements);
  assert.equal(manifest.operations.find(({ id }) => id === "orders.list")?.placements, undefined);
  assert.equal(manifest.profiles.filter((id) => id === PAGE_PLACEMENTS_PROFILE).length, 1);
  assert.deepEqual(catalog.operation("orders.pay")?.placements, placements);

  const explicit = catalogWith([operation("orders.pay", { inputSchema, placements })], ["tc-schema-core@1", PAGE_PLACEMENTS_PROFILE]);
  assert.equal(explicit.manifest().profiles.filter((id) => id === PAGE_PLACEMENTS_PROFILE).length, 1);
});

test("adapters without placements do not advertise the profile", () => {
  assert.equal(catalogWith([operation("orders.list", { inputSchema })]).manifest().profiles.includes(PAGE_PLACEMENTS_PROFILE), false);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @8lines/gauntlet-protocol build && pnpm --filter @8lines/gauntlet-typescript-core exec tsx --test test/placements.test.ts`
Expected: FAIL — `globalPlacement` is not exported.

- [ ] **Step 3: Implement helpers and catalog changes**

Create `packages/typescript/core/src/placements.ts`:

```ts
import type { OperationPlacement } from "@8lines/gauntlet-protocol";

export function globalPlacement(): OperationPlacement {
  return { kind: "global" };
}

export function subjectPlacement(
  subjectType: string,
  bindings?: Readonly<Record<string, string>>,
): OperationPlacement {
  return bindings === undefined
    ? { kind: "subject", subjectType }
    : { kind: "subject", subjectType, bindings };
}
```

Add `export * from "./placements.js";` to `src/index.ts`.

In `adapter-catalog.ts`, import `PAGE_PLACEMENTS_PROFILE` from `@8lines/gauntlet-protocol`, and replace the `profiles` computation (currently `const profiles = Object.freeze([...new Set(ownedProfiles)].sort()) as readonly ProfileId[];`) with:

```ts
  const usesPlacements = options.operations.operations()
    .some(({ definition }) => definition.placements !== undefined);
  const profiles = Object.freeze([
    ...new Set([...ownedProfiles, ...(usesPlacements ? [PAGE_PLACEMENTS_PROFILE as ProfileId] : [])]),
  ].sort()) as readonly ProfileId[];
```

In the summary construction, add after `...(requirements === undefined ? {} : { requirements }),`:

```ts
      ...(definition.placements === undefined ? {} : { placements: definition.placements }),
```

- [ ] **Step 4: Run the SDK suite**

Run: `pnpm --filter @8lines/gauntlet-typescript-core test && pnpm --filter @8lines/gauntlet-typescript-core typecheck`
Expected: PASS.

- [ ] **Step 5: Give the example operation a placement**

In `examples/typescript-fixture/src/index.ts`, import `subjectPlacement` from `@8lines/gauntlet-typescript-core`. In `operationMetadata`, add after `requirements`:

```ts
    placements: [subjectPlacement("agency-application", { "/applicationId": "applicationId" })],
```

Run: `pnpm --filter "./examples/**" build && pnpm verify:protocol-sdk --node-only`
Expected: PASS (node-adapter and next live conformance still green).

- [ ] **Step 6: Commit**

```bash
git add packages/typescript/core examples/typescript-fixture
git commit -m "feat(sdk-ts): emit operation placements and advertise the placements profile"
```

---

### Task 4: PHP SDK placements

**Files:**
- Create: `packages/php/core/src/Definition/OperationPlacement.php`
- Create: `packages/php/core/src/Schema/PlacementRules.php`
- Modify: `packages/php/core/src/Definition/OperationDefinition.php` (new trailing ctor param `array $placements = []`, validation, `toProtocolArray`)
- Modify: `packages/php/core/src/Manifest/OperationSummary.php` (carry and emit placements)
- Modify: `packages/php/core/src/Manifest/ManifestBuilder.php` (profile union in `build()`)
- Modify: `packages/php/core/src/Schema/ProtocolSemantics.php` (operation + manifest rules)
- Modify: `examples/symfony/src/Gauntlet/FinalizeAgencyApplicationOperation.php` (placement)
- Test: `packages/php/core/tests/Unit/Definition/OperationPlacementTest.php` (new); `tests/Unit/Schema/ProtocolSemanticsTest.php` already runs the shared vectors from Task 2

**Interfaces:**
- Consumes: shared vectors from Task 2; rule definitions from *Global Constraints*.
- Produces:
  ```php
  final readonly class OperationPlacement {
      public static function global(): self;
      /** @param array<string,string> $bindings */
      public static function subject(string $subjectType, array $bindings = []): self;
      /** @return array<string,mixed> */ public function toProtocolArray(): array;
  }
  final class PlacementRules {
      public const PROFILE = 'gauntlet-page-placements@1';
      /** @param list<string> $guardedSchemaPointers @param list<mixed> $placements */
      public static function areValid(mixed $inputSchema, array $guardedSchemaPointers, array $placements): bool;
  }
  // OperationDefinition::$placements : list<OperationPlacement>
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/php/core/tests/Unit/Definition/OperationPlacementTest.php`:

```php
<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Tests\Unit\Definition;

use EightLines\Gauntlet\Core\Definition\ExecutionPolicy;
use EightLines\Gauntlet\Core\Definition\InputHandling;
use EightLines\Gauntlet\Core\Definition\OperationDefinition;
use EightLines\Gauntlet\Core\Definition\OperationImpact;
use EightLines\Gauntlet\Core\Definition\OperationOutput;
use EightLines\Gauntlet\Core\Definition\OperationPlacement;
use EightLines\Gauntlet\Core\Definition\FeatureDefinition;
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Manifest\ManifestBuilder;
use EightLines\Gauntlet\Core\Protocol\EnvironmentDescriptor;
use EightLines\Gauntlet\Core\Schema\PlacementRules;
use EightLines\Gauntlet\Core\Schema\TcSchemaCore;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class OperationPlacementTest extends TestCase
{
    public function testPlacementsAreEmittedAndHashed(): void
    {
        $plain = self::operation([]);
        $placed = self::operation([OperationPlacement::subject('order', ['/orderId' => 'orderId'])]);
        self::assertArrayNotHasKey('placements', $plain->toProtocolArray());
        self::assertSame(
            [['kind' => 'subject', 'subjectType' => 'order', 'bindings' => ['/orderId' => 'orderId']]],
            $placed->toProtocolArray()['placements'],
        );
        self::assertSame(['kind' => 'global'], OperationPlacement::global()->toProtocolArray());
        self::assertNotSame($plain->revision(), $placed->revision());
    }

    /** @return iterable<string, array{list<OperationPlacement>}> */
    public static function invalidPlacements(): iterable
    {
        yield 'missing property' => [[OperationPlacement::subject('order', ['/missing' => 'orderId'])]];
        yield 'secret field' => [[OperationPlacement::subject('order', ['/token' => 'token'])]];
        yield 'array field' => [[OperationPlacement::subject('order', ['/tags' => 'tags'])]];
        yield 'duplicate global' => [[OperationPlacement::global(), OperationPlacement::global()]];
        yield 'duplicate subject' => [[OperationPlacement::subject('order'), OperationPlacement::subject('order')]];
    }

    /** @param list<OperationPlacement> $placements */
    #[DataProvider('invalidPlacements')]
    public function testInvalidPlacementsAreRejected(array $placements): void
    {
        $this->expectException(\InvalidArgumentException::class);
        self::operation($placements);
    }

    public function testEscapedPointersResolveToTheDecodedProperty(): void
    {
        $schema = json_decode('{"type":"object","properties":{"a/b":{"type":"string"}}}');
        self::assertTrue(PlacementRules::areValid($schema, [], [(object) ['kind' => 'subject', 'subjectType' => 's', 'bindings' => (object) ['/a~1b' => 'k']]]));
        self::assertFalse(PlacementRules::areValid($schema, [], [(object) ['kind' => 'subject', 'subjectType' => 's', 'bindings' => (object) ['/a/b' => 'k']]]));
    }

    public function testInvalidPortableIdsAreRejected(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        OperationPlacement::subject('bad id');
    }

    public function testManifestAdvertisesTheProfileOnceWhenPlacementsExist(): void
    {
        $environment = EnvironmentDescriptor::fromProtocolValue(['name' => 'fixture-test', 'kind' => 'test']);
        $features = [new FeatureDefinition('test', 'Test')];
        $placed = [self::operation([OperationPlacement::global()])];
        foreach ([['tc-schema-core@1'], ['tc-schema-core@1', PlacementRules::PROFILE]] as $profiles) {
            $manifest = (new ManifestBuilder('fixture', 'Fixture', $profiles, $environment))
                ->build($features, $placed, [])->toProtocolArray();
            self::assertSame(1, count(array_keys($manifest['profiles'], PlacementRules::PROFILE, true)));
            self::assertSame([['kind' => 'global']], $manifest['operations'][0]['placements']);
        }
        $plain = (new ManifestBuilder('fixture', 'Fixture', ['tc-schema-core@1'], $environment))
            ->build($features, [self::operation([])], [])->toProtocolArray();
        self::assertNotContains(PlacementRules::PROFILE, $plain['profiles']);
    }

    /** @param list<OperationPlacement> $placements */
    private static function operation(array $placements): OperationDefinition
    {
        return new OperationDefinition(
            id: 'test.pay',
            featureId: 'test',
            label: 'Pay',
            description: null,
            inputSchema: JsonOwnership::object([
                '$schema' => TcSchemaCore::DIALECT,
                'type' => 'object',
                'properties' => [
                    'orderId' => ['type' => 'string'],
                    'token' => ['type' => 'string'],
                    'tags' => ['type' => 'array', 'items' => ['type' => 'string']],
                ],
            ]),
            inputHandling: new InputHandling([
                ['kind' => 'secret', 'schemaPointer' => '/properties/token', 'retention' => 'none'],
            ]),
            contextSchema: null,
            uiSchema: null,
            dataSources: [],
            presets: [],
            execution: new ExecutionPolicy(OperationImpact::READ, false, false, 'optional', false),
            output: new OperationOutput(JsonOwnership::object(['$schema' => TcSchemaCore::DIALECT])),
            placements: $placements,
        );
    }
}
```

Before running, check the real `FeatureDefinition` constructor, the `EnvironmentDescriptor::fromProtocolValue` signature and whether `AdapterManifest::toProtocolArray()` exists. Adjust the calls to match, keeping the assertions unchanged.

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd packages/php/core && composer install && vendor/bin/phpunit --filter OperationPlacementTest`
Expected: FAIL — class `OperationPlacement` not found.

- [ ] **Step 3: Implement `PlacementRules`**

Create `packages/php/core/src/Schema/PlacementRules.php`. It works on decoded wire values (`\stdClass` objects), so the constructor and `ProtocolSemantics` share it:

```php
<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Schema;

use EightLines\Gauntlet\Core\Protocol\ProtocolId;

/** Canonical operation placement rules shared by definitions and wire semantics. */
final class PlacementRules
{
    public const PROFILE = 'gauntlet-page-placements@1';
    private const SCALAR_TYPES = ['string', 'number', 'integer', 'boolean'];

    /** @return list<string>|null */
    public static function decode(string $pointer): ?array
    {
        if ($pointer === '' || $pointer[0] !== '/') {
            return null;
        }
        $segments = [];
        foreach (explode('/', substr($pointer, 1)) as $raw) {
            if (preg_match('/~(?![01])/', $raw) === 1) {
                return null;
            }
            $segments[] = str_replace(['~1', '~0'], ['/', '~'], $raw);
        }

        return $segments;
    }

    public static function schemaPointer(string $inputPointer): ?string
    {
        $segments = self::decode($inputPointer);
        if ($segments === null) {
            return null;
        }

        return implode('', array_map(
            static fn (string $segment): string => '/properties/' . str_replace(['~', '/'], ['~0', '~1'], $segment),
            $segments,
        ));
    }

    /** @param list<string> $guardedSchemaPointers @param list<mixed> $placements */
    public static function areValid(mixed $inputSchema, array $guardedSchemaPointers, array $placements): bool
    {
        if ($placements === []) {
            return false;
        }
        $globals = 0;
        $subjectTypes = [];
        foreach ($placements as $placement) {
            if (!$placement instanceof \stdClass) {
                return false;
            }
            $kind = $placement->kind ?? null;
            if ($kind === 'global') {
                $globals++;
                continue;
            }
            $subjectType = $placement->subjectType ?? null;
            if ($kind !== 'subject' || !is_string($subjectType) || !ProtocolId::isValid($subjectType) || isset($subjectTypes[$subjectType])) {
                return false;
            }
            $subjectTypes[$subjectType] = true;
            $bindings = $placement->bindings ?? new \stdClass();
            if (!$bindings instanceof \stdClass) {
                return false;
            }
            foreach (get_object_vars($bindings) as $pointer => $key) {
                $pointer = (string) $pointer;
                $schemaPointer = self::schemaPointer($pointer);
                if (!is_string($key) || !ProtocolId::isValid($key) || $schemaPointer === null || !self::targetIsScalar($inputSchema, $pointer)) {
                    return false;
                }
                foreach ($guardedSchemaPointers as $guarded) {
                    if ($schemaPointer === $guarded || str_starts_with($schemaPointer, $guarded . '/')) {
                        return false;
                    }
                }
            }
        }

        return $globals <= 1;
    }

    private static function targetIsScalar(mixed $schema, string $pointer): bool
    {
        $node = $schema;
        foreach (self::decode($pointer) ?? [] as $segment) {
            if (!$node instanceof \stdClass || property_exists($node, '$ref')) {
                return false;
            }
            $properties = $node->properties ?? null;
            if (!$properties instanceof \stdClass || !property_exists($properties, $segment)) {
                return false;
            }
            $node = $properties->{$segment};
        }
        if (!$node instanceof \stdClass || property_exists($node, '$ref')) {
            return false;
        }
        if (property_exists($node, 'enum')) {
            return is_array($node->enum) && $node->enum !== [] && array_filter($node->enum, self::isScalar(...)) === $node->enum;
        }
        if (property_exists($node, 'const')) {
            return self::isScalar($node->const);
        }

        return is_string($node->type ?? null) && in_array($node->type, self::SCALAR_TYPES, true);
    }

    private static function isScalar(mixed $value): bool
    {
        return is_string($value) || is_int($value) || is_float($value) || is_bool($value);
    }
}
```

If `ProtocolId::isValid` does not exist, add it next to `ProtocolId::assert` in `src/Protocol/ProtocolId.php`. It returns `preg_match(self::PATTERN, $value) === 1`, reusing the existing pattern constant; have `assert` call it.

Note the empty-key edge case: `get_object_vars` returns property `""` for a JSON key `""`, and `decode('')` returns `null`, so such a binding is rejected.

- [ ] **Step 4: Implement `OperationPlacement` and wire it**

Create `packages/php/core/src/Definition/OperationPlacement.php`:

```php
<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Definition;

use EightLines\Gauntlet\Core\Protocol\ProtocolId;

final readonly class OperationPlacement
{
    /** @param array<string, string> $bindings */
    private function __construct(
        public string $kind,
        public ?string $subjectType,
        public array $bindings,
    ) {
    }

    public static function global(): self
    {
        return new self('global', null, []);
    }

    /** @param array<string, string> $bindings */
    public static function subject(string $subjectType, array $bindings = []): self
    {
        ProtocolId::assert($subjectType);
        foreach ($bindings as $key) {
            ProtocolId::assert($key);
        }

        return new self('subject', $subjectType, $bindings);
    }

    /** @return array<string, mixed> */
    public function toProtocolArray(): array
    {
        if ($this->kind === 'global') {
            return ['kind' => 'global'];
        }
        $document = ['kind' => 'subject', 'subjectType' => $this->subjectType];
        if ($this->bindings !== []) {
            $document['bindings'] = $this->bindings;
        }

        return $document;
    }
}
```

In `OperationDefinition`:
- Add the constructor parameter `public array $placements = [],` **after** `?string $inputClass = null`, with docblock `@param list<OperationPlacement> $placements`.
- At the end of the constructor body, add:

```php
        self::assertDefinitions($placements, OperationPlacement::class, 'operation placement');
        if ($placements !== [] && !PlacementRules::areValid(
            json_decode(json_encode($inputSchema, JSON_THROW_ON_ERROR)),
            array_map(static fn (array $rule): string => $rule['schemaPointer'], $inputHandling?->rules ?? []),
            json_decode(json_encode(array_map(
                static fn (OperationPlacement $placement): array => $placement->toProtocolArray(),
                $placements,
            ), JSON_THROW_ON_ERROR)),
        )) {
            throw new \InvalidArgumentException('Operation placements are invalid.');
        }
```

- In `toProtocolArray()`, after the `requirements` block, add:

```php
        if ($this->placements !== []) {
            $document['placements'] = array_map(
                static fn (OperationPlacement $placement): array => $placement->toProtocolArray(),
                $this->placements,
            );
        }
```

Import `PlacementRules` from `EightLines\Gauntlet\Core\Schema`.

Watch one encoding detail. A binding map must serialize as a JSON object, and `json_encode` of a PHP array with keys like `/orderId` already produces an object, so this is safe. Guard against an empty map by only emitting `bindings` when it is non-empty, which `toProtocolArray()` above does.

In `OperationSummary`:
- Add constructor property `public array $placements` (after `$requirements`).
- Pass `$operation->placements` in both `available()` and `unavailable()`.
- In `toProtocolArray()`, after `requirements`, add `if ($this->placements !== []) { $document['placements'] = array_map(static fn (OperationPlacement $p): array => $p->toProtocolArray(), $this->placements); }`.

In `ManifestBuilder::build()`, before `return new AdapterManifest(`, compute:

```php
        $profiles = $this->profiles;
        foreach ($operations as $operation) {
            if ($operation->placements !== [] && !in_array(PlacementRules::PROFILE, $profiles, true)) {
                $profiles[] = PlacementRules::PROFILE;
            }
        }
        sort($profiles);
```

Then pass `$profiles` instead of `$this->profiles`. Check whether `AdapterManifest` already sorts profiles; keep whichever ordering the existing `ManifestBuilderTest` expects.

- [ ] **Step 5: Mirror the rules in `ProtocolSemantics`**

In `operationSemanticsAreValid`, after the `presetsOmitSecrets` block, add:

```php
            if (property_exists($wire, 'placements')) {
                $guarded = [];
                foreach (($wire->inputHandling->rules ?? []) as $rule) {
                    if ($rule instanceof \stdClass && is_string($rule->schemaPointer ?? null)) {
                        $guarded[] = $rule->schemaPointer;
                    }
                }
                if (!is_array($wire->placements) || !PlacementRules::areValid($wire->inputSchema, $guarded, $wire->placements)) {
                    return false;
                }
            }
```

In `manifestSemanticsAreValid`, inside the `foreach ($wire->operations as $operation)` loop, after the feature check, add:

```php
                if (property_exists($operation, 'placements') && !isset($profiles[PlacementRules::PROFILE])) {
                    return false;
                }
```

`$profiles` is the set returned by `self::stringSet`. Verify that it is keyed by value; if it is a list, use `in_array`.

- [ ] **Step 6: Run the PHP suites**

Run: `cd packages/php/core && vendor/bin/phpunit`
Expected: PASS, including `ProtocolSemanticsTest`, which now executes the Task 2 vectors.

- [ ] **Step 7: Give the Symfony example operation a placement**

In `examples/symfony/src/Gauntlet/FinalizeAgencyApplicationOperation.php`, add the named argument `placements: [OperationPlacement::subject('agency-application', ['/applicationId' => 'applicationId'])],` to `new OperationDefinition(...)` and import the class. Then run the Symfony bundle suite:

Run: `cd packages/php/symfony-bundle && composer install && vendor/bin/phpunit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/php examples/symfony
git commit -m "feat(sdk-php): support operation placements"
```

---

### Task 5: Java SDK placements

**Files:**
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/OperationPlacement.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/schema/PlacementRules.java`
- Modify: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/OperationDefinition.java` (overload ctor with placements; `placements()`; `toProtocolMap`)
- Modify: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/OperationSummary.java`
- Modify: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/schema/ProtocolSemantics.java`
- Modify: `packages/java/spring-boot-starter/src/main/java/dev/eightlines/gauntlet/spring/catalog/SpringAdapterCatalog.java:153-187` (profile union; generated ops read annotation placements)
- Modify: `packages/java/spring-boot-starter/src/main/java/dev/eightlines/gauntlet/spring/catalog/ProtocolDocumentMapper.java` (accept `placements` key)
- Modify: `packages/java/spring-boot-starter/src/main/java/dev/eightlines/gauntlet/spring/annotation/GauntletOperation.java` (+ new `SubjectPlacement.java`, `PlacementBinding.java`)
- Modify: `packages/java/spring-example/src/main/resources/gauntlet/agency-applications.finalize.json` (placement + new revision)
- Test: `packages/java/core/src/test/java/dev/eightlines/gauntlet/core/OperationPlacementTest.java` (new); `ProtocolSemanticsTest` runs shared vectors

**Interfaces:**
- Produces:
  ```java
  public record OperationPlacement(String kind, String subjectType, Map<String, String> bindings) {
    public static OperationPlacement global();
    public static OperationPlacement subject(String subjectType, Map<String, String> bindings);
    public Map<String, Object> toProtocolMap();
  }
  public final class PlacementRules {
    public static final String PROFILE = "gauntlet-page-placements@1";
    public static boolean areValid(JsonObject inputSchema, List<String> guardedSchemaPointers, JsonList placements);
  }
  // OperationDefinition(... 17 existing args ..., List<OperationPlacement> placements)  — new overload
  // OperationDefinition.placements(): List<OperationPlacement>
  // @GauntletOperation.globalPlacement() default false; subjectPlacements() default {}
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/java/core/src/test/java/dev/eightlines/gauntlet/core/OperationPlacementTest.java`:

```java
package dev.eightlines.gauntlet.core;

import static org.junit.jupiter.api.Assertions.*;

import dev.eightlines.gauntlet.core.json.JsonOwnership;
import dev.eightlines.gauntlet.core.model.*;
import dev.eightlines.gauntlet.core.schema.PlacementRules;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class OperationPlacementTest {
  private static OperationDefinition operation(List<OperationPlacement> placements) {
    return new OperationDefinition(
        "test.pay", "test", "Pay", null,
        JsonOwnership.object(Map.of(
            "$schema", "https://json-schema.org/draft/2020-12/schema",
            "type", "object",
            "properties", Map.of(
                "orderId", Map.of("type", "string"),
                "token", Map.of("type", "string"),
                "tags", Map.of("type", "array", "items", Map.of("type", "string"))))),
        new InputHandling(List.of(Map.of("kind", "secret", "schemaPointer", "/properties/token", "retention", "none")), CoreTestFixtures.EMPTY),
        null, null, List.of(), List.of(),
        new ExecutionPolicy(OperationImpact.READ, false, false, Idempotency.OPTIONAL, false, null, null, CoreTestFixtures.EMPTY),
        new OperationOutput(JsonOwnership.object(Map.of("$schema", "https://json-schema.org/draft/2020-12/schema")), null, CoreTestFixtures.EMPTY),
        null, 0, List.of(), null, CoreTestFixtures.EMPTY,
        placements);
  }

  @Test
  void placementsAreEmittedAndHashed() {
    var plain = operation(List.of());
    var placed = operation(List.of(OperationPlacement.subject("order", Map.of("/orderId", "orderId"))));
    assertNull(plain.toProtocolMap().get("placements"));
    assertEquals(
        JsonOwnership.object(Map.of("p", List.of(Map.of("kind", "subject", "subjectType", "order", "bindings", Map.of("/orderId", "orderId"))))).get("p"),
        placed.toProtocolMap().get("placements"));
    assertNotEquals(plain.revision(), placed.revision());
    assertEquals(Map.of("kind", "global"), OperationPlacement.global().toProtocolMap());
  }

  @Test
  void invalidPlacementsAreRejected() {
    for (var placements : List.of(
        List.of(OperationPlacement.subject("order", Map.of("/missing", "orderId"))),
        List.of(OperationPlacement.subject("order", Map.of("/token", "token"))),
        List.of(OperationPlacement.subject("order", Map.of("/tags", "tags"))),
        List.of(OperationPlacement.global(), OperationPlacement.global()),
        List.of(OperationPlacement.subject("order", Map.of()), OperationPlacement.subject("order", Map.of())))) {
      assertThrows(IllegalArgumentException.class, () -> operation(placements), placements.toString());
    }
    assertThrows(IllegalArgumentException.class, () -> OperationPlacement.subject("bad id", Map.of()));
  }

  @Test
  void escapedPointersResolveToTheDecodedProperty() {
    var schema = JsonOwnership.object(Map.of("type", "object", "properties", Map.of("a/b", Map.of("type", "string"))));
    var escaped = JsonOwnership.list(List.of(Map.of("kind", "subject", "subjectType", "s", "bindings", Map.of("/a~1b", "k"))));
    var literal = JsonOwnership.list(List.of(Map.of("kind", "subject", "subjectType", "s", "bindings", Map.of("/a/b", "k"))));
    assertTrue(PlacementRules.areValid(schema, List.of(), escaped));
    assertFalse(PlacementRules.areValid(schema, List.of(), literal));
  }
}
```

Before running, check how the constructors of `InputHandling`, `ExecutionPolicy`, `OperationOutput` and `Idempotency` actually look (see `CoreTestFixtures.fixtureDefinition`), and whether `JsonOwnership.list` exists. Adapt the argument lists and conversions without changing the assertions. If `JsonOwnership.list` is missing, use `(JsonList) JsonOwnership.object(Map.of("v", list)).get("v")`.

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd packages/java && ./gradlew :core:test --tests '*OperationPlacementTest' -DgauntletProtocolFixtures=$(pwd)/../protocol/fixtures/v1`
Expected: FAIL to compile — `OperationPlacement` missing.

- [ ] **Step 3: Implement `PlacementRules`**

```java
package dev.eightlines.gauntlet.core.schema;

import dev.eightlines.gauntlet.core.json.JsonList;
import dev.eightlines.gauntlet.core.json.JsonObject;
import dev.eightlines.gauntlet.core.json.JsonValue;
import dev.eightlines.gauntlet.core.model.ProtocolId;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

/** Canonical operation placement rules shared by definitions and wire semantics. */
public final class PlacementRules {
  public static final String PROFILE = "gauntlet-page-placements@1";
  private static final Set<String> SCALAR_TYPES = Set.of("string", "number", "integer", "boolean");
  private static final Pattern INVALID_ESCAPE = Pattern.compile("~(?![01])");

  private PlacementRules() {}

  public static List<String> decode(String pointer) {
    if (pointer == null || pointer.isEmpty() || pointer.charAt(0) != '/') return null;
    var segments = new ArrayList<String>();
    for (String raw : pointer.substring(1).split("/", -1)) {
      if (INVALID_ESCAPE.matcher(raw).find()) return null;
      segments.add(raw.replace("~1", "/").replace("~0", "~"));
    }
    return segments;
  }

  public static String schemaPointer(String inputPointer) {
    List<String> segments = decode(inputPointer);
    if (segments == null) return null;
    var result = new StringBuilder();
    for (String segment : segments)
      result.append("/properties/").append(segment.replace("~", "~0").replace("/", "~1"));
    return result.toString();
  }

  public static boolean areValid(JsonObject inputSchema, List<String> guarded, JsonList placements) {
    if (placements.values().isEmpty()) return false;
    int globals = 0;
    var subjectTypes = new HashSet<String>();
    for (JsonValue value : placements.values()) {
      if (!(value instanceof JsonObject placement)) return false;
      String kind = string(placement.get("kind"));
      if ("global".equals(kind)) {
        globals++;
        continue;
      }
      String subjectType = string(placement.get("subjectType"));
      if (!"subject".equals(kind) || subjectType == null || !ProtocolId.isValid(subjectType)
          || !subjectTypes.add(subjectType)) return false;
      JsonValue bindingsValue = placement.get("bindings");
      if (bindingsValue == null) continue;
      if (!(bindingsValue instanceof JsonObject bindings)) return false;
      for (var entry : bindings.values().entrySet()) {
        String key = string(entry.getValue());
        String schemaPointer = schemaPointer(entry.getKey());
        if (key == null || !ProtocolId.isValid(key) || schemaPointer == null
            || !targetIsScalar(inputSchema, entry.getKey())) return false;
        for (String rule : guarded)
          if (schemaPointer.equals(rule) || schemaPointer.startsWith(rule + "/")) return false;
      }
    }
    return globals <= 1;
  }

  private static boolean targetIsScalar(JsonObject schema, String pointer) {
    JsonValue node = schema;
    for (String segment : decode(pointer)) {
      if (!(node instanceof JsonObject object) || object.get("$ref") != null) return false;
      if (!(object.get("properties") instanceof JsonObject properties)
          || !properties.values().containsKey(segment)) return false;
      node = properties.get(segment);
    }
    if (!(node instanceof JsonObject leaf) || leaf.get("$ref") != null) return false;
    if (leaf.values().containsKey("enum")) {
      return leaf.get("enum") instanceof JsonList values && !values.values().isEmpty()
          && values.values().stream().allMatch(PlacementRules::isScalar);
    }
    if (leaf.values().containsKey("const")) return isScalar(leaf.get("const"));
    String type = string(leaf.get("type"));
    return type != null && SCALAR_TYPES.contains(type);
  }

  private static boolean isScalar(JsonValue value) {
    Object raw = value == null ? null : value.unwrap();
    return raw instanceof String || raw instanceof Number || raw instanceof Boolean;
  }

  private static String string(JsonValue value) {
    return value != null && value.unwrap() instanceof String result ? result : null;
  }
}
```

If `ProtocolId.isValid(String)` does not exist, add it to `model/ProtocolId.java` next to `require` (same pattern) and make `require` call it.

- [ ] **Step 4: Implement the model changes**

`model/OperationPlacement.java`:

```java
package dev.eightlines.gauntlet.core.model;

import java.util.LinkedHashMap;
import java.util.Map;

public record OperationPlacement(String kind, String subjectType, Map<String, String> bindings) {
  public OperationPlacement {
    bindings = Map.copyOf(bindings == null ? Map.of() : bindings);
  }

  public static OperationPlacement global() {
    return new OperationPlacement("global", null, Map.of());
  }

  public static OperationPlacement subject(String subjectType, Map<String, String> bindings) {
    ProtocolId.require(subjectType);
    bindings.values().forEach(ProtocolId::require);
    return new OperationPlacement("subject", subjectType, bindings);
  }

  public Map<String, Object> toProtocolMap() {
    if ("global".equals(kind)) return Map.of("kind", "global");
    var values = new LinkedHashMap<String, Object>();
    values.put("kind", "subject");
    values.put("subjectType", subjectType);
    if (!bindings.isEmpty()) values.put("bindings", bindings);
    return values;
  }
}
```

`OperationDefinition`:
- Add the field `private final List<OperationPlacement> placements;`.
- Keep the existing 17-arg constructor, delegating with `this(..., extensions, List.of());`.
- Add the 18-arg constructor, which holds the current body plus `this.placements = List.copyOf(Objects.requireNonNull(placements, "placements"));` assigned **before** `this.revision = ...`.
- After `this.revision = ...`, add:

```java
    if (!this.placements.isEmpty()) {
      JsonObject wire = toProtocolMap(false);
      List<String> guarded = inputHandling == null ? List.of()
          : inputHandling.rules().stream().map(rule -> String.valueOf(rule.get("schemaPointer"))).toList();
      if (!PlacementRules.areValid(inputSchema, guarded, (JsonList) wire.get("placements")))
        throw new IllegalArgumentException("operation placements are invalid");
    }
```

  Check how `InputHandling` exposes its rules and adapt the `guarded` extraction to that accessor.
- Add `public List<OperationPlacement> placements() { return placements; }`.
- In `toProtocolMap(boolean)`, after `requirements`, add `if (!placements.isEmpty()) values.put("placements", placements.stream().map(OperationPlacement::toProtocolMap).toList());`.

`OperationSummary`:
- Add the field `private final List<OperationPlacement> placements;` and assign `operation.placements()` in the constructor.
- Add the accessor `placements()`.
- In `toProtocolMap()`, after `requirements`, emit the same line as `OperationDefinition`.

`ProtocolSemantics.operationMapIsValid`, after `PresetSecretAnalyzer.operationPresetsOmitSecrets` check:

```java
      JsonValue placements = operation.get("placements");
      if (placements != null) {
        var guarded = new ArrayList<String>();
        JsonObject handling = objectOrNull(operation.get("inputHandling"));
        if (handling != null)
          for (JsonObject rule : objects(handling.get("rules"))) guarded.add(requiredString(rule, "schemaPointer"));
        if (!(placements instanceof JsonList list)
            || !PlacementRules.areValid(object(operation.get("inputSchema")), guarded, list)) return false;
      }
```

`ProtocolSemantics.manifestMapIsValid`, inside the operations loop, after the feature check: `if (operation.get("placements") != null && !profiles.contains(PlacementRules.PROFILE)) return false;`

Add `import java.util.ArrayList;`.

- [ ] **Step 5: Run the core suite**

Run: `cd packages/java && ./gradlew :core:check -DgauntletProtocolFixtures=$(pwd)/../protocol/fixtures/v1`
Expected: PASS, including `ProtocolSemanticsTest` with the Task 2 vectors.

- [ ] **Step 6: Spring starter: annotation, mapper, profile union**

Create `spring/annotation/PlacementBinding.java`:

```java
package dev.eightlines.gauntlet.spring.annotation;

import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

@Retention(RetentionPolicy.RUNTIME)
@Target({})
public @interface PlacementBinding {
  String pointer();
  String key();
}
```

Create `spring/annotation/SubjectPlacement.java`:

```java
package dev.eightlines.gauntlet.spring.annotation;

import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

@Retention(RetentionPolicy.RUNTIME)
@Target({})
public @interface SubjectPlacement {
  String subjectType();
  PlacementBinding[] bindings() default {};
}
```

In `GauntletOperation.java`, add:

```java
  boolean globalPlacement() default false;
  SubjectPlacement[] subjectPlacements() default {};
```

In `SpringAdapterCatalog.generatedOperation`, replace the final `empty());` argument list tail by passing the 18-arg constructor with `placements(annotation)`, and add:

```java
  private static List<OperationPlacement> placements(GauntletOperation annotation) {
    var result = new ArrayList<OperationPlacement>();
    if (annotation.globalPlacement()) result.add(OperationPlacement.global());
    for (SubjectPlacement subject : annotation.subjectPlacements()) {
      var bindings = new LinkedHashMap<String, String>();
      for (PlacementBinding binding : subject.bindings()) bindings.put(binding.pointer(), binding.key());
      result.add(OperationPlacement.subject(subject.subjectType(), bindings));
    }
    return List.copyOf(result);
  }
```

In the manifest construction (`new AdapterManifest(properties.profiles(), ...)`), replace `properties.profiles()` with:

```java
            profilesWithPlacements(properties.profiles(), operationSummaries),
```

and add:

```java
  private static List<String> profilesWithPlacements(List<String> configured, List<OperationSummary> summaries) {
    var profiles = new java.util.TreeSet<>(configured);
    if (summaries.stream().anyMatch(summary -> !summary.placements().isEmpty())) profiles.add(PlacementRules.PROFILE);
    return List.copyOf(profiles);
  }
```

Check whether `AdapterManifest` expects the configured order rather than sorted order. If existing tests assert order, preserve `configured` order and append the profile only when absent.

In `ProtocolDocumentMapper` operation mapping:
- Add `"placements"` to the allowed key set.
- Pass `value.get("placements") == null ? List.of() : placements(value.get("placements"))` as the 18th constructor argument.
- Add a `placements(JsonValue)` mapper that reads `kind`, `subjectType` and `bindings` (a string map) and builds `OperationPlacement.global()` / `OperationPlacement.subject(...)`.

Rejecting unknown kinds with `IllegalArgumentException` matches the mapper's style.

- [ ] **Step 7: Spring example placement**

In `packages/java/spring-example/src/main/resources/gauntlet/agency-applications.finalize.json`, add after `requirements`:

```json
  "placements": [{ "kind": "subject", "subjectType": "agency-application", "bindings": { "/applicationId": "applicationId" } }],
```

Recompute its revision with the protocol package:

```bash
pnpm --filter @8lines/gauntlet-protocol build
node -e 'import("@8lines/gauntlet-protocol").then(async ({ computeRevision }) => { const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(computeRevision(d)); })' packages/java/spring-example/src/main/resources/gauntlet/agency-applications.finalize.json
```

(Run the command from a directory where `@8lines/gauntlet-protocol` resolves, e.g. `conformance/runner`. `computeRevision` ignores the existing `revision` field.) Put the printed value into the file's `revision`.

Run: `cd packages/java && ./gradlew :spring-boot-starter:check :spring-example:bootJar -DgauntletProtocolFixtures=$(pwd)/../protocol/fixtures/v1`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/java
git commit -m "feat(sdk-java): support operation placements"
```

---

### Task 6: Conformance checks placements across documents

**Files:**
- Modify: `conformance/runner/src/adapter-v1-runner.ts` (`validateCrossDocumentContract`)
- Modify: `conformance/runner/src/extended-runner.ts` (same comparison near line 125)
- Test: the runner's existing tests under `conformance/runner/test/` (add a case) and the live conformance of all four examples

**Interfaces:**
- Consumes: `canonicalizeForRevision` from `@8lines/gauntlet-protocol` (already exported from `revision.ts`).

- [ ] **Step 1: Write the failing runner test**

Find the existing test that calls `validateCrossDocumentContract` in `conformance/runner/test/` (`grep -rn validateCrossDocumentContract conformance/runner/test`). Next to it, add a case that copies its valid manifest/operation/scenario inputs and sets `placements: [{ kind: "global" }]` on the operation only (recomputing `operation.revision` with `computeRevision`). Assert that it throws `/does not match its manifest summary/`. Add a second case with identical placements on both documents (manifest `profiles` including `gauntlet-page-placements@1`, recomputed `manifestRevision`) and assert it does not throw.

- [ ] **Step 2: Run and confirm the mismatch case fails**

Run: `pnpm --filter @8lines/gauntlet-conformance-runner test`
Expected: FAIL — the mismatch is not detected.

- [ ] **Step 3: Implement the comparison**

In both runners, import `canonicalizeForRevision` and extend the summary/definition condition:

```ts
    || canonicalizeForRevision(operation.placements ?? null) !== canonicalizeForRevision(summary.placements ?? null)
```

Check the `canonicalizeForRevision` signature in `packages/protocol/src/revision.ts`. If it does not accept `null`, compare `JSON.stringify` of the canonicalized arrays, or `canonicalizeForRevision({ p: value ?? [] })`.

- [ ] **Step 4: Run runner and live conformance**

Run: `pnpm --filter @8lines/gauntlet-conformance-runner test && pnpm verify:protocol-sdk --node-only`
Expected: PASS. If Docker is available, also run `pnpm verify:official-adapters`, which covers Symfony and Spring. If Docker is unavailable, say so in the task report instead of claiming it passed.

- [ ] **Step 5: Commit**

```bash
git add conformance
git commit -m "test(conformance): require matching placements in summaries and definitions"
```

---

### Task 7: MCP `subjectType` filter and documentation

**Files:**
- Modify: `apps/server/src/mcp.ts:87-90`
- Test: `apps/server/test/mcp.integration.test.ts`
- Modify: `docs/mcp.md` (tool table, line ~83), `docs/extensions/authoring.md`, `docs/reference/protocol-model.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes: `OperationSummary.placements` (Task 1). Server `ManifestService.listTargets()` returns `TargetSnapshot[]` with optional `manifest: AdapterManifest`.

- [ ] **Step 1: Write the failing MCP test**

In `apps/server/test/mcp.integration.test.ts`, follow the existing `call(name, args)` pattern. Add a test whose fake adapter manifest has two operations, one with `placements: [{ kind: "subject", subjectType: "order" }]` and one without, and whose `profiles` include `gauntlet-page-placements@1` (reuse the file's manifest fixture helper and recompute `manifestRevision`). Then:

```ts
  const all = await call("list_targets");
  assert.equal(all.data.targets[0].manifest.operations.length, 2);
  const filtered = await call("list_targets", { subjectType: "order" });
  assert.deepEqual(filtered.data.targets[0].manifest.operations.map(({ id }: { id: string }) => id), ["<placed operation id>"]);
  const none = await call("list_targets", { subjectType: "invoice" });
  assert.equal(none.data.targets.length, all.data.targets.length);
  assert.deepEqual(none.data.targets[0].manifest.operations, []);
```

- [ ] **Step 2: Run and confirm it fails**

Run: `pnpm --filter @8lines/gauntlet-server exec tsx --test test/mcp.integration.test.ts`
Expected: FAIL — the strict input schema rejects `subjectType`.

- [ ] **Step 3: Implement the filter**

Replace the `gauntlet_list_targets` registration with:

```ts
  server.registerTool("gauntlet_list_targets", {
    description: "Discover configured applications, their health, environment, features and operation summaries. Pass subjectType to list only operations placed on that page subject.",
    inputSchema: z.strictObject({ subjectType: id.optional() }), annotations: readOnly,
  }, guard(async ({ subjectType }) => {
    const targets = await dependencies.manifests.listTargets();
    return result({ targets: subjectType === undefined ? targets : targets.map((target) => target.manifest === undefined ? target : {
      ...target,
      manifest: {
        ...target.manifest,
        operations: target.manifest.operations.filter((operation) =>
          operation.placements?.some((placement) => placement.kind === "subject" && placement.subjectType === subjectType) === true),
      },
    }) });
  }));
```

Keep the original description text and append the sentence. `id` is the existing shared Zod portable-ID fragment in `mcp.ts`. Confirm the `guard` helper forwards parsed arguments; adjust it if it currently takes no parameters.

- [ ] **Step 4: Run server tests**

Run: `pnpm --filter @8lines/gauntlet-server test && pnpm --filter @8lines/gauntlet-server typecheck`
Expected: PASS.

- [ ] **Step 5: Documentation**

- `docs/mcp.md`: in the `gauntlet_list_targets` row, append "Optional `subjectType` limits operation summaries to those placed on that page subject."
- `docs/extensions/authoring.md`: add a section **"Place an operation on application pages"**. Explain `placements`, the global vs subject kinds and bindings, and the rules from *Global Constraints*. Show one example each for TS (`subjectPlacement("order", { "/orderId": "orderId" })`), PHP (`OperationPlacement::subject('order', ['/orderId' => 'orderId'])`) and Spring (`@GauntletOperation(..., subjectPlacements = @SubjectPlacement(subjectType = "order", bindings = @PlacementBinding(pointer = "/orderId", key = "orderId")))`). State that the SDK advertises `gauntlet-page-placements@1` automatically.
- `docs/reference/protocol-model.md`: in the list of what a definition can describe, add "page placements used by the embeddable widget"; under *Profiles and capabilities*, name `gauntlet-page-placements@1`.
- `CHANGELOG.md`: under the unreleased section (create `## Unreleased` if missing), add: operation placements and the `gauntlet-page-placements@1` profile; the MCP `subjectType` filter; and a compatibility note that adapters emitting placements require a Gauntlet control plane from this release onward, because older control planes reject unknown manifest fields.

Run: `pnpm --filter @8lines/gauntlet-server test` (config-schema tests check some docs literals) and any docs test listed in `package.json` (`grep -n "docs" package.json`).

- [ ] **Step 6: Commit**

```bash
git add apps/server docs CHANGELOG.md
git commit -m "feat(mcp): filter operations by page subject and document placements"
```

---

## Final verification

- [ ] Run `pnpm check` from the repository root. Expected: PASS.
- [ ] Run `pnpm test:php:compatibility` and `pnpm test:java:release` if Docker is available. Report actual results; if skipped, say why.
