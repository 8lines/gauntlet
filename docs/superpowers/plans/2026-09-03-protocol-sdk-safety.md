# Protocol and SDK Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Adapter v1 and every official runtime fail closed outside an explicitly named non-production environment, enforce revision-bound confirmation before execution, and propagate truthful dry-run state to application handlers.

**Architecture:** The protocol package owns the canonical environment parser, wire types, JSON Schemas, semantic rules, and cross-language fixtures. The control plane independently validates its own environment and each target's expected environment, while TypeScript, PHP/Symfony, and Java/Spring enforce the same adapter-startup and execution rules at their runtime boundaries. Confirmation is defense in depth in both the control plane and SDK runtimes; dry-run is an immutable handler-context value rather than UI-only metadata.

**Tech Stack:** TypeScript 5.x, Node.js 24-26, Fastify, JSON Schema Draft 2020-12, RFC 8785/JCS revisions, PHP 8.3+, Symfony 7.2+, Java 21, Spring Boot, PHPUnit, Gradle/JUnit, Node test runner, pnpm.

**Spec:** `docs/superpowers/specs/2026-09-02-release-standalone-safety-skills-design.md`

## Global Constraints

- All v0.1 artifacts share version `0.1.0`; Adapter protocol compatibility remains independently declared as v1.
- Supported consumer baselines are Node.js 24-26, PHP 8.3+ with Symfony 7.2+, and Java 21 with the documented Spring Boot line.
- Environment `kind` is exactly one of `development`, `test`, `qa`, `staging`, `uat`, `preview`, or `sandbox`; no production kind exists.
- The production-name guard is case-insensitive and identical in every language: `(^|[._:-])(prod|production|live)($|[._:-])`.
- There is no environment variable, API option, feature flag, or break-glass path that bypasses the non-production guard.
- Adapters remain disabled by default; enabled adapters require application ID, label, structured environment, and a stable idempotency secret.
- The control plane requires its own structured environment and every target requires `expectedEnvironment`; target-to-manifest comparison is exact for both `name` and `kind`.
- `InvocationContext.target.environment` remains an optional string and is non-authoritative metadata. Do not change its type or use it for environment admission.
- A typed confirmation acknowledgement is bound to operation ID, exact operation revision, and declared impact.
- Confirmation is required whenever `confirmationRequired` is true, including dry-run requests.
- Destructive operations require both `confirmationRequired: true` and `idempotency: "required"`.
- Confirmation is checked after the request's stale-revision check and before validation work, idempotency lookup/replay, admission, persistence, scheduling, or handler execution.
- Dry-run is rejected when unsupported and reaches application code as an immutable/read-only handler-context value when supported.
- Confirmation prevents accidental execution; it is not authentication and does not bypass application-domain authorization.
- Invalid configuration and public Problems use bounded diagnostics that never echo secrets or supplied environment values.
- Existing allow-listing, fixed routes, closed schemas, canonical revisions, secret non-retention, response validation, bounded uploads/data sources, and capability negotiation remain intact.
- Existing dirty changes in `apps/server/src/app.ts`, `apps/server/src/main.ts`, `apps/server/src/problem-response.ts`, `apps/server/package.json`, `pnpm-lock.yaml`, and `apps/dashboard/` belong to the current release work. Inspect and merge them additively; never reset, replace, or stage unrelated hunks.

## Dependencies and Execution Order

- Execute Tasks 1-5 in this plan before the configuration work so `EnvironmentDescriptor` and `assertNonProductionEnvironment(value): EnvironmentDescriptor` exist as canonical protocol exports.
- After Tasks 1-4 establish the wire contract, Tasks 2-3 in `docs/superpowers/plans/2026-09-03-dashboard-product-image.md` exclusively own dashboard API typing, create-run request construction/tests, and confirmation UI integration. They may proceed independently of the SDK work but must finish before Task 19; Task 18 here must not edit dashboard files.
- Next execute Tasks 1-3 in `docs/superpowers/plans/2026-09-03-control-plane-configuration.md`; those tasks exclusively own the configuration schema/loader, `ServerConfiguration`, `StaticTargetConfig.expectedEnvironment`, and their tests.
- Then execute Task 6 in this plan. Immediately follow it with Tasks 4-5 in `docs/superpowers/plans/2026-09-03-control-plane-configuration.md`, whose `apps/server/src/main.ts` composition consumes the required `CreateAppOptions.environment` contract. Treat this handoff as one integration checkpoint before repository-wide typechecking.
- Continue with Tasks 7-18 in this plan after configured composition is integrated. Task 7 consumes, but does not redefine, the target expectation produced by the configuration plan.
- After Task 14, execute Task 4 in `docs/superpowers/plans/2026-09-03-private-release-engineering.md`. That release task is the sole owner of PHP/Composer/Symfony compatibility constraints, locks, Docker test images, and the PHP 8.3-Symfony 7.2 compatibility matrix; complete it before Task 19 here.

---

## File and Interface Map

### Protocol-owned contracts

- `packages/protocol/src/types.ts` owns `EnvironmentKind`, `EnvironmentDescriptor`, `OperationImpact`, `ConfirmationAcknowledgement`, and their placement in manifest/create-run types.
- `packages/protocol/src/environment.ts` owns the hostile-input-safe `assertNonProductionEnvironment(value)` runtime boundary.
- `packages/protocol/schemas/v1/*.schema.json` own the language-neutral wire contract.
- `packages/protocol/src/semantic-validation.ts` owns manifest and operation semantic rules that cannot be expressed locally in endpoint schemas.
- `packages/protocol/fixtures/v1/*` and `adapter-semantic-vectors.json` are the shared source of truth consumed by TypeScript, PHP, and Java tests.

### Control-plane boundaries

- `apps/server/src/app.ts` owns the final startup guard through required `CreateAppOptions.environment`.
- Tasks 1-3 in `docs/superpowers/plans/2026-09-03-control-plane-configuration.md` own `ServerConfiguration`, `loadServerConfiguration`, and defensive parsing of required `StaticTargetConfig.expectedEnvironment`; this plan consumes those contracts.
- Task 4 in `docs/superpowers/plans/2026-09-03-control-plane-configuration.md` owns configured `apps/server/src/main.ts` composition and passes the loaded instance environment into `createApp`.
- `apps/server/src/manifest-service.ts` owns exact target-to-manifest matching and the unavailable snapshot.
- `apps/server/src/run-proxy-service.ts` owns pre-proxy confirmation validation.

### SDK boundaries

- TypeScript Core owns catalog metadata validation, stable idempotency-secret enforcement, run admission, and `RunContext.dryRun`.
- TypeScript Node validates enabled custom catalogs synchronously; Next delegates to that boundary.
- PHP Core owns value objects, semantic rules, and runtime admission; Symfony owns configuration/startup and HTTP envelope mapping.
- Java Core owns records/enums, semantic rules, and runtime admission; Spring owns configuration/startup and HTTP envelope mapping.

### Canonical interfaces produced by this plan

```ts
export type EnvironmentKind =
  | "development"
  | "test"
  | "qa"
  | "staging"
  | "uat"
  | "preview"
  | "sandbox";

export interface EnvironmentDescriptor {
  readonly name: ProtocolId;
  readonly kind: EnvironmentKind;
}

export function assertNonProductionEnvironment(
  value: unknown,
): EnvironmentDescriptor;

export type OperationImpact = "read" | "write" | "destructive";

export interface ConfirmationAcknowledgement extends Extensible {
  readonly operationId: ProtocolId;
  readonly operationRevision: Sha256Revision;
  readonly impact: OperationImpact;
}
```

```ts
export interface CreateAppOptions {
  readonly environment: EnvironmentDescriptor;
  readonly targets: unknown;
}
```

`StaticTargetConfig`, `ServerConfiguration`, and `loadServerConfiguration` are intentionally not redeclared here. Their exact definitions and tests are produced by Tasks 1-3 in `docs/superpowers/plans/2026-09-03-control-plane-configuration.md`.

### Task 1: Canonical non-production environment value

**Files:**

- Create: `packages/protocol/src/environment.ts`
- Create: `packages/protocol/test/environment.test.ts`
- Modify: `packages/protocol/src/types.ts`
- Modify: `packages/protocol/src/index.ts`

**Interfaces:**

- Consumes: `isProtocolId(value: unknown): value is ProtocolId` and `assertRuntimeJsonData(value: unknown): asserts value is JsonValue`.
- Produces: `EnvironmentKind`, `EnvironmentDescriptor`, and `assertNonProductionEnvironment(value: unknown): EnvironmentDescriptor` for every later task.

- [ ] **Step 1: Add failing happy-path and immutability tests**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertNonProductionEnvironment } from "../src/index.js";

const kinds = [
  "development", "test", "qa", "staging", "uat", "preview", "sandbox",
] as const;

test("owns and freezes every supported non-production environment", () => {
  for (const kind of kinds) {
    const source = { name: `client-${kind}`, kind };
    const result = assertNonProductionEnvironment(source);
    assert.deepEqual(result, source);
    assert.notEqual(result, source);
    assert.equal(Object.isFrozen(result), true);
  }
});
```

- [ ] **Step 2: Add failing rejection and hostile-object tests**

```ts
test("rejects production aliases as separated tokens", () => {
  for (const name of [
    "prod", "PRODUCTION", "live", "pp-prod", "prod-eu", "client.production",
    "live_eu", "sandbox:prod:blue", "non-production",
  ]) {
    assert.throws(
      () => assertNonProductionEnvironment({ name, kind: "staging" }),
      new TypeError("Invalid non-production environment descriptor"),
      name,
    );
  }
  assert.equal(assertNonProductionEnvironment({ name: "product-demo", kind: "preview" }).name, "product-demo");
  assert.equal(assertNonProductionEnvironment({ name: "lively", kind: "test" }).name, "lively");
});

test("rejects closed-shape and hostile values without invoking accessors", () => {
  const invalid: unknown[] = [
    null,
    [],
    {},
    { name: "dev" },
    { kind: "test" },
    { name: "dev", kind: "production" },
    { name: "dev", kind: "test", extra: true },
    Object.create({ name: "dev", kind: "test" }),
  ];
  for (const value of invalid) {
    assert.throws(() => assertNonProductionEnvironment(value), TypeError);
  }

  let getterCalled = false;
  const accessor = { name: "dev" } as Record<string, unknown>;
  Object.defineProperty(accessor, "kind", {
    enumerable: true,
    get() {
      getterCalled = true;
      return "test";
    },
  });
  assert.throws(() => assertNonProductionEnvironment(accessor), TypeError);
  assert.equal(getterCalled, false);
});
```

- [ ] **Step 3: Run the focused test and observe the missing export**

Run: `pnpm --filter @8lines/gauntlet-protocol exec tsx --test test/environment.test.ts`

Expected: FAIL because `assertNonProductionEnvironment` is not exported.

- [ ] **Step 4: Add the protocol types and runtime guard**

Add to `types.ts`:

```ts
export type EnvironmentKind =
  | "development" | "test" | "qa" | "staging" | "uat" | "preview" | "sandbox";

export interface EnvironmentDescriptor {
  readonly name: ProtocolId;
  readonly kind: EnvironmentKind;
}
```

Implement `environment.ts`:

```ts
import { isProtocolId } from "./identifiers.js";
import { assertRuntimeJsonData } from "./revision.js";
import type { EnvironmentDescriptor, EnvironmentKind } from "./types.js";

const KINDS = new Set<EnvironmentKind>([
  "development", "test", "qa", "staging", "uat", "preview", "sandbox",
]);
const PRODUCTION_TOKEN = /(^|[._:-])(prod|production|live)($|[._:-])/i;

function invalidEnvironment(): TypeError {
  return new TypeError("Invalid non-production environment descriptor");
}

export function assertNonProductionEnvironment(value: unknown): EnvironmentDescriptor {
  try {
    assertRuntimeJsonData(value);
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalidEnvironment();
    const keys = Object.keys(value);
    if (keys.length !== 2 || !Object.hasOwn(value, "name") || !Object.hasOwn(value, "kind")) {
      throw invalidEnvironment();
    }
    const record = value as Readonly<Record<string, unknown>>;
    if (!isProtocolId(record.name)
      || PRODUCTION_TOKEN.test(record.name)
      || typeof record.kind !== "string"
      || !KINDS.has(record.kind as EnvironmentKind)) {
      throw invalidEnvironment();
    }
    return Object.freeze({ name: record.name, kind: record.kind as EnvironmentKind });
  } catch {
    throw invalidEnvironment();
  }
}
```

Export the helper from `index.ts`:

```ts
export * from "./environment.js";
```

- [ ] **Step 5: Run focused tests and typecheck**

Run: `pnpm --filter @8lines/gauntlet-protocol exec tsx --test test/environment.test.ts`

Expected: PASS.

Run: `pnpm --filter @8lines/gauntlet-protocol typecheck`

Expected: PASS.

- [ ] **Step 6: Commit the environment primitive**

```bash
git add packages/protocol/src/environment.ts packages/protocol/src/types.ts packages/protocol/src/index.ts packages/protocol/test/environment.test.ts
git commit -m "feat(protocol): add non-production environment descriptor"
```

### Task 2: Wire schemas for environment and confirmation

**Files:**

- Modify: `packages/protocol/src/types.ts`
- Modify: `packages/protocol/schemas/v1/common.schema.json`
- Modify: `packages/protocol/schemas/v1/manifest.schema.json`
- Modify: `packages/protocol/schemas/v1/operation-definition.schema.json`
- Modify: `packages/protocol/schemas/v1/create-run-request.schema.json`
- Modify: `packages/protocol/test/schema-files.test.ts`
- Modify: `packages/protocol/test/openapi.test.ts`

**Interfaces:**

- Consumes: `EnvironmentDescriptor` from Task 1 and existing `ProtocolId`, `Sha256Revision`, and `Extensible`.
- Produces: required `ApplicationMetadata.environment`, `OperationImpact`, `ConfirmationAcknowledgement`, and optional `CreateRunRequest.confirmation`.

- [ ] **Step 1: Add failing schema assertions**

Add endpoint-schema cases proving these exact outcomes:

```ts
assert.equal(validateManifest({ ...manifest, application: { id: "app", label: "App" } }), false);
assert.equal(validateManifest({
  ...manifest,
  application: { id: "app", label: "App", environment: "staging" },
}), false);
assert.equal(validateManifest({
  ...manifest,
  application: { id: "app", label: "App", environment: { name: "app-dev", kind: "staging" } },
}), true);

assert.equal(validateCreateRun({
  operationRevision: revision,
  input: {},
  confirmation: { operationId: "op", operationRevision: revision, impact: "write" },
}), true);
assert.equal(validateCreateRun({
  operationRevision: revision,
  input: {},
  confirmation: { operationId: "op", operationRevision: revision, impact: "write", extra: true },
}), false);
```

- [ ] **Step 2: Run schema tests and observe failures**

Run: `pnpm --filter @8lines/gauntlet-protocol exec tsx --test test/schema-files.test.ts test/openapi.test.ts`

Expected: FAIL because manifest environment is still optional/string and confirmation is unknown.

- [ ] **Step 3: Add exact TypeScript wire contracts**

```ts
export type OperationImpact = "read" | "write" | "destructive";

export interface ConfirmationAcknowledgement extends Extensible {
  readonly operationId: ProtocolId;
  readonly operationRevision: Sha256Revision;
  readonly impact: OperationImpact;
}

export interface ApplicationMetadata extends Extensible {
  readonly id: ProtocolId;
  readonly label: string;
  readonly environment: EnvironmentDescriptor;
}

export interface ExecutionPolicy extends Extensible {
  readonly impact: OperationImpact;
  readonly confirmationRequired: boolean;
  readonly dryRunSupported: boolean;
  readonly idempotency: "none" | "optional" | "required";
  readonly cancellationSupported: boolean;
  readonly timeoutSeconds?: number;
  readonly concurrency?: "allow" | "forbid" | "queue";
}

export interface CreateRunRequest extends Extensible {
  readonly operationRevision: Sha256Revision;
  readonly input: JsonObject;
  readonly context?: InvocationContext;
  readonly dryRun?: boolean;
  readonly idempotencyKey?: string;
  readonly confirmation?: ConfirmationAcknowledgement;
}
```

Leave this existing field unchanged:

```ts
readonly target?: { readonly id: ProtocolId; readonly environment?: string };
```

- [ ] **Step 4: Add common closed JSON Schema definitions**

```json
"environmentKind": {
  "enum": ["development", "test", "qa", "staging", "uat", "preview", "sandbox"]
},
"environmentDescriptor": {
  "type": "object",
  "required": ["name", "kind"],
  "properties": {
    "name": { "$ref": "#/$defs/portableId" },
    "kind": { "$ref": "#/$defs/environmentKind" }
  },
  "additionalProperties": false
},
"operationImpact": {
  "enum": ["read", "write", "destructive"]
},
"confirmationAcknowledgement": {
  "type": "object",
  "required": ["operationId", "operationRevision", "impact"],
  "properties": {
    "operationId": { "$ref": "#/$defs/portableId" },
    "operationRevision": { "$ref": "#/$defs/sha256Revision" },
    "impact": { "$ref": "#/$defs/operationImpact" },
    "extensions": { "$ref": "#/$defs/extensions" }
  },
  "additionalProperties": false
}
```

In the manifest schema require and reference environment:

```json
"required": ["id", "label", "environment"],
"environment": { "$ref": "./common.schema.json#/$defs/environmentDescriptor" }
```

In create-run add:

```json
"confirmation": { "$ref": "./common.schema.json#/$defs/confirmationAcknowledgement" }
```

In operation-definition replace the inline impact enum with:

```json
"impact": { "$ref": "./common.schema.json#/$defs/operationImpact" }
```

- [ ] **Step 5: Run protocol schema tests**

Run: `pnpm --filter @8lines/gauntlet-protocol exec tsx --test test/schema-files.test.ts test/openapi.test.ts`

Expected: schema structure tests pass; fixture-driven tests may still fail until Task 4 updates fixtures.

- [ ] **Step 6: Commit wire contracts**

```bash
git add packages/protocol/src/types.ts packages/protocol/schemas/v1/common.schema.json packages/protocol/schemas/v1/manifest.schema.json packages/protocol/schemas/v1/operation-definition.schema.json packages/protocol/schemas/v1/create-run-request.schema.json packages/protocol/test/schema-files.test.ts packages/protocol/test/openapi.test.ts
git commit -m "feat(protocol): bind environment and run confirmation on the wire"
```

### Task 3: Protocol semantic safety rules

**Files:**

- Modify: `packages/protocol/src/semantic-validation.ts`
- Modify: `packages/protocol/test/semantic-validation.test.ts`

**Interfaces:**

- Consumes: `assertNonProductionEnvironment`, `AdapterManifest.application.environment`, and `OperationDefinition.execution`.
- Produces: language-reference semantic decisions later mirrored by PHP and Java and exercised through shared vectors.

- [ ] **Step 1: Add failing semantic tests**

```ts
test("manifest semantics reject a production-like environment name", () => {
  const manifest = manifestWithValidRevision({
    ...validManifest,
    application: {
      ...validManifest.application,
      environment: { name: "portal-prod-eu", kind: "staging" },
    },
  });
  assert.equal(manifestSemanticsAreValid(manifest), false);
});

test("destructive operations require confirmation and required idempotency", () => {
  const valid = operationWithValidRevision({
    ...validOperation,
    execution: {
      ...validOperation.execution,
      impact: "destructive",
      confirmationRequired: true,
      idempotency: "required",
    },
  });
  assert.equal(operationSemanticsAreValid(valid), true);
  assert.equal(operationSemanticsAreValid(operationWithValidRevision({
    ...valid,
    execution: { ...valid.execution, confirmationRequired: false },
  })), false);
  assert.equal(operationSemanticsAreValid(operationWithValidRevision({
    ...valid,
    execution: { ...valid.execution, idempotency: "optional" },
  })), false);
});
```

- [ ] **Step 2: Run the semantic test and observe unsafe acceptance**

Run: `pnpm --filter @8lines/gauntlet-protocol exec tsx --test test/semantic-validation.test.ts`

Expected: FAIL because production aliases and destructive combinations are accepted.

- [ ] **Step 3: Add minimal semantic checks**

```ts
import { assertNonProductionEnvironment } from "./environment.js";

export function manifestSemanticsAreValid(manifest: AdapterManifest): boolean {
  try {
    assertNonProductionEnvironment(manifest.application.environment);
    if (computeRevision(manifest as unknown as JsonObject, "manifestRevision") !== manifest.manifestRevision) {
      return false;
    }
  } catch {
    return false;
  }
}

export function operationSemanticsAreValid(operation: OperationDefinition): boolean {
  try {
    if (operation.execution.impact === "destructive"
      && (!operation.execution.confirmationRequired
        || operation.execution.idempotency !== "required")) {
      return false;
    }
  } catch {
    return false;
  }
}
```

Insert the environment statement before the current revision comparison. Insert the destructive branch before the current operation revision/schema checks; keep every existing semantic check after these additions.

- [ ] **Step 4: Run the focused semantic tests**

Run: `pnpm --filter @8lines/gauntlet-protocol exec tsx --test test/semantic-validation.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit semantic rules**

```bash
git add packages/protocol/src/semantic-validation.ts packages/protocol/test/semantic-validation.test.ts
git commit -m "feat(protocol): enforce environment and destructive semantics"
```

### Task 4: Shared fixtures, revisions, and cross-language vectors

**Files:**

- Modify: `packages/protocol/fixtures/v1/manifest.valid.json`
- Modify: `packages/protocol/fixtures/v1/manifest.minor-forward.valid.json`
- Modify: `packages/protocol/fixtures/v1/manifest.invalid-major-version.json`
- Modify: `packages/protocol/fixtures/v1/manifest.invalid-unknown-property.json`
- Modify: `packages/protocol/fixtures/v1/create-run-request.valid.json`
- Modify: `packages/protocol/fixtures/v1/adapter-semantic-vectors.json`
- Modify: `packages/protocol/test/fixture-semantics.test.ts`
- Modify: `packages/protocol/test/semantic-vectors.test.ts`
- Modify: `packages/protocol/test/support/semantic-vector-loader.ts`
- Modify: `packages/php/core/tests/Unit/Schema/ProtocolSemanticsTest.php`
- Modify: `packages/java/core/src/test/java/dev/eightlines/gauntlet/core/ProtocolSemanticsTest.java`
- Modify: `packages/java/core/src/test/java/dev/eightlines/gauntlet/core/SemanticVectorLoader.java`

**Interfaces:**

- Consumes: schema and semantic contracts from Tasks 1-3.
- Produces: structured manifest fixtures, revision-bound create-run fixture, 39 semantic document vectors, and 100 unique shared outcome IDs.

- [ ] **Step 1: Run fixture tests to record the expected red state**

Run: `pnpm --filter @8lines/gauntlet-protocol exec tsx --test test/fixture-semantics.test.ts test/semantic-vectors.test.ts`

Expected: FAIL because old manifests expose a string environment and the valid create-run fixture lacks confirmation.

- [ ] **Step 2: Convert every manifest fixture to a structured environment**

Use this exact application fragment in `manifest.valid.json` and invalid fixtures whose intended failure is unrelated to environment:

```json
"application": {
  "id": "acme-portal",
  "label": "Acme Portal",
  "environment": {
    "name": "development",
    "kind": "development"
  }
}
```

Preserve the minor-forward fixture's extension data while replacing only its environment string with the same descriptor.

- [ ] **Step 3: Bind the valid create-run fixture to the valid operation**

Add after `idempotencyKey` or before `extensions`, respecting the fixture's current field order:

```json
"confirmation": {
  "operationId": "application-access-review",
  "operationRevision": "sha256:2e301a636fb48d2bec64fc7e91b62d8a45e47af3a28f665b6b809f6a4b19d9e8",
  "impact": "write"
}
```

Do not modify `InvocationContext.target.environment` in this fixture.

- [ ] **Step 4: Add four exact semantic vectors**

Add one manifest vector that replaces `/application/environment/name` with `acme-prod-eu`, recomputes `manifestRevision`, and expects `false`.

Add three operation vectors based on `operation.valid.json`:

```json
{
  "id": "operation.destructive.valid",
  "predicate": "operation",
  "precondition": "envelope-valid",
  "document": {
    "source": "operation",
    "patches": [
      { "op": "replace", "path": "/execution/impact", "value": "destructive" }
    ],
    "revision": { "mode": "set", "value": "sha256:3778704efe86593ea446e03cea0b1d1da3537f5d1b9305a77dcb590acef5a6df", "expect": "match" }
  },
  "expected": true
}
```

The second vector additionally replaces `/execution/confirmationRequired` with `false`, uses revision `sha256:978cff358ea5a0868b3975189f3d34b497b8d5cf6d16e10fb58af3d30c2711d6`, and expects `false`. The third additionally replaces `/execution/idempotency` with `optional`, uses revision `sha256:701c7e2036deeee178687969bead02dca1f16f32be87d8f414a028da4bb7e98c`, and expects `false`.

The manifest production-name vector uses revision `sha256:0a7c63eb0f7401834b349fb9063087e372b681e1c5f735baa3d2c731e960a575`. The structured manifest fixtures use these exact receipts when serialized with the repository's two-space indentation and terminal newline:

```text
manifest.valid.json revision: sha256:bd7df155fca5ce7504431416bdd0c7562255fcc238af5aade4eb0d557cf2a9cd
manifest.valid.json file SHA: sha256:1bca35d1dcd17847fd5e97a74e6803adbc7dad62a5ea2681f65ffcaca56d0fb5
manifest.minor-forward.valid.json revision: sha256:33f8e78bd95af05e886a747771876584eb3fe1080377e7fe4397524d628f25b6
manifest.minor-forward.valid.json file SHA: sha256:c4402691a18ea68fe8eb75aa0f37354d8e470c75a58bd15ca49d923fad09f201
```

Replace the existing manifest-vector revisions with this exact map:

```text
manifest.feature.duplicate-id sha256:95ffd2eea592347adb49a319e52d00385a681bd63e7144905debb60e06dcec80
manifest.feature.missing-parent sha256:552d9c85d660d38ca8562aaa6cc178b92bb800d779a739a3e0eeaf6845b8af5d
manifest.feature.cycle sha256:7fd8a0523415c8c019a686a929703b6949f911f8c60dbde887947b351e410786
manifest.operation.duplicate-id sha256:7f2e81f3416b4c6002fa782c19b0cf7d42ac6a61e7c6402117714a4adfe79f4b
manifest.data-source.duplicate-id sha256:18e60b2391a0386010876a9e3ae52886d7beaacb9751a33872db48d19ffdc6b2
manifest.unavailable.missing-profile sha256:42dab5ccf1fa02551c62961e047cfd8b193e23aee0aa42b6c7d873186460784b
manifest.unavailable.missing-capability sha256:e53f0399fd78a7c111e133f71265eb57d0047e17561c8d9da1c7db65177d6852
manifest.unavailable.missing-mixed sha256:b4bc13e8dd0ac23884f6141a45bb8df49e2e84c4976edb27c766de5cec7fa42a
manifest.available.missing-profile sha256:4c029f4d0ca6ed83603ce82d1f310a615bfc01f668ed4220f7b639ec9d3a3a17
manifest.available.missing-capability sha256:5c289ffa6123cc648792f731b086e58d9c419ef28e0276eb6693d9b9561c0b22
manifest.available.missing-mixed sha256:302170623f9ad09186eb36e69447d0bfd93446ce10a4891303bffdc12a6ebf77
manifest.diagnostic.omitted-operation-id sha256:2b70e0c6bd8a66bdaad52e43bd5f97823b856af175fb638123b4d8e042daa6b7
manifest.operation.unknown-feature sha256:ac6397a253d57b56551ee4dd22d19391f50b440ddc7cca6b807347e96d56369f
manifest.data-source.invalid-limits sha256:ec6be3a20f3a3b125b27b4c8d6145a1a3cb084e9a3f15ab098a0e3e83237df29
manifest.data-source.remote-dependency-schema sha256:9d46087c9ed39e02905ba972c339caaf19b242b95fc0e19f4492bfd49c62cdf1
manifest.data-source.non-object-context-schema sha256:20b5a36923330b2f49a598bb65466e32348e3dc63e95870320b4a1ddec3d77ae
```

- [ ] **Step 5: Print authoritative fixture hashes and vector revisions without writing files**

Use the existing loader and revision implementation from the repository:

```bash
pnpm --filter @8lines/gauntlet-protocol exec tsx --eval '
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { computeRevision } from "./src/index.ts";
const fixtureRoot = new URL("./fixtures/v1/", import.meta.url);
for (const file of ["manifest.valid.json", "manifest.minor-forward.valid.json"]) {
  const bytes = await readFile(new URL(file, fixtureRoot));
  const value = JSON.parse(bytes.toString("utf8"));
  console.log(file, computeRevision(value, "manifestRevision"), `sha256:${createHash("sha256").update(bytes).digest("hex")}`);
}
'
```

Expected: the two revision/SHA pairs printed by the command exactly match the four fixture receipts listed in Step 4. `semantic-vectors.test.ts` must assert the explicit manifest-vector revision map from Step 4.

- [ ] **Step 6: Update pinned vector cardinalities and receipts**

Change exact cardinalities:

```ts
artifact.documentVectors.length === 39;
new Set(ids).size === 100;
```

```php
self::assertCount(39, $artifact->documentVectors);
self::assertCount(100, $ids);
self::assertCount(100, array_unique($ids));
```

```java
assertEquals(39, outcomes);
```

Update the loader guards from `35/96` to `39/100`. Recompute the PHP `ARTIFACT_SHA256` only after the final JSON bytes are stable:

```bash
shasum -a 256 packages/protocol/fixtures/v1/adapter-semantic-vectors.json
```

- [ ] **Step 7: Run all protocol fixture and vector tests**

Run: `pnpm --filter @8lines/gauntlet-protocol test`

Expected: PASS with 39 document vectors and 100 unique outcomes.

- [ ] **Step 8: Commit fixtures and receipts**

```bash
git add packages/protocol/fixtures/v1 packages/protocol/test/fixture-semantics.test.ts packages/protocol/test/semantic-vectors.test.ts packages/protocol/test/support/semantic-vector-loader.ts packages/php/core/tests/Unit/Schema/ProtocolSemanticsTest.php packages/java/core/src/test/java/dev/eightlines/gauntlet/core/ProtocolSemanticsTest.java packages/java/core/src/test/java/dev/eightlines/gauntlet/core/SemanticVectorLoader.java
git commit -m "test(protocol): publish shared safety vectors"
```

### Task 5: Dashboard client accepts and defends the new wire contract

**Files:**

- Modify: `packages/dashboard-client/test/support/fixtures.ts`
- Modify: `packages/dashboard-client/test/protocol-validator.test.ts`
- Modify: `packages/dashboard-client/test/adapter-client.test.ts`

**Interfaces:**

- Consumes: generated protocol types/schemas and `manifestSemanticsAreValid` from Tasks 1-4.
- Produces: canonical client-side ownership of `confirmation` and rejection of production-like adapter manifests.

- [ ] **Step 1: Add failing client validation cases**

```ts
test("owns a revision-bound confirmation acknowledgement", () => {
  const source = structuredClone(validCreateRunRequest);
  const result = validateCreateRunRequest(source);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.confirmation, {
    operationId: validOperation.id,
    operationRevision: validOperation.revision,
    impact: validOperation.execution.impact,
  });
  assert.notEqual(result.value.confirmation, source.confirmation);
});

test("rejects a schema-valid manifest with a production-like name", async () => {
  const manifest = structuredClone(validManifest);
  manifest.application.environment.name = "client-prod";
  manifest.manifestRevision = computeRevision(manifest, "manifestRevision");
  const result = await clientReturningManifest(manifest).getManifest(target);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.failureKind, "invalid-response");
});
```

- [ ] **Step 2: Run dashboard-client tests**

Run: `pnpm --filter @8lines/gauntlet-dashboard-client test`

Expected: FAIL until fixture imports and expected request bodies reflect confirmation and structured environment.

- [ ] **Step 3: Update owned fixture expectations without adding client-specific safety logic**

Keep `protocol-validator.ts` delegating manifest semantics to the protocol package. Update request/body assertions to include the exact fixture acknowledgement:

```ts
assert.deepEqual(sentRequest?.confirmation, {
  operationId: validOperation.id,
  operationRevision: validOperation.revision,
  impact: validOperation.execution.impact,
});
```

- [ ] **Step 4: Run and commit dashboard-client changes**

Run: `pnpm --filter @8lines/gauntlet-dashboard-client test`

Expected: PASS.

```bash
git add packages/dashboard-client/test/support/fixtures.ts packages/dashboard-client/test/protocol-validator.test.ts packages/dashboard-client/test/adapter-client.test.ts
git commit -m "test(client): enforce safety wire contracts"
```

### Task 6: Independent control-plane application environment gate

**Files:**

- Modify: `apps/server/src/app.ts`
- Create: `apps/server/test/support/environment.ts`
- Modify: `apps/server/test/support/fake-adapter.ts`
- Modify: `apps/server/test/public-api.test.ts`
- Modify: `apps/server/test/routes.integration.test.ts`
- Modify: `apps/server/test/manifest-service.test.ts`

**Interfaces:**

- Consumes: `EnvironmentDescriptor` and `assertNonProductionEnvironment(value): EnvironmentDescriptor` from Task 1.
- Consumes from Tasks 1-3 in `docs/superpowers/plans/2026-09-03-control-plane-configuration.md`: `StaticTargetConfig.expectedEnvironment`, `ServerConfiguration`, and the already implemented `loadServerConfiguration(environment, read?)`. This task does not edit their source files or tests.
- Produces: required `CreateAppOptions.environment: EnvironmentDescriptor`, an independent `createApp` guard that runs before collaborator construction, a shared server-environment fixture, and updated server test call sites/fake fixtures.
- Downstream consumer: Task 4 in the configuration plan owns `apps/server/src/main.ts`; it must consume its existing `loadServerConfiguration` result and pass `configuration.instance.environment` to `createApp`. This task does not edit or stage `main.ts`.

- [ ] **Step 1: Snapshot existing dirty server changes before editing**

Run:

```bash
git diff -- apps/server/src/app.ts apps/server/src/main.ts apps/server/src/problem-response.ts apps/server/package.json pnpm-lock.yaml
```

Expected: the existing dashboard/static-serving changes are visible. Record their hunks mentally and retain them during the additive `app.ts` edit; do not edit `main.ts`, `problem-response.ts`, package metadata, the lockfile, or dashboard files in this task.

- [ ] **Step 2: Add failing app-boundary tests for missing and unsafe environments**

Extend `apps/server/test/public-api.test.ts` with the existing `fakeTarget` fixture and these cases:

```ts
test("refuses to construct a control plane without an environment", async () => {
  await assert.rejects(
    () => createApp({ targets: [fakeTarget] } as never),
    new TypeError("Invalid non-production environment descriptor"),
  );
});

test("refuses unsafe control-plane environments before constructing collaborators", async () => {
  for (const environment of [
    { name: "gauntlet-prod", kind: "staging" },
    { name: "gauntlet-dev", kind: "production" },
  ]) {
    await assert.rejects(
      () => createApp({ environment, targets: [fakeTarget] } as never),
      new TypeError("Invalid non-production environment descriptor"),
    );
  }
});
```

- [ ] **Step 3: Run the app-boundary tests and confirm RED**

Run: `pnpm --filter @8lines/gauntlet-server exec tsx --test test/public-api.test.ts`

Expected: FAIL because `createApp` currently accepts a missing environment and ignores unsafe environment input.

- [ ] **Step 4: Add the required option and make the app boundary independently fail closed**

Merge the new protocol imports into the existing import block, add only the required property to the current options interface, and invoke the shared guard as the first statement in `createApp`:

```ts
import {
  assertNonProductionEnvironment,
  type EnvironmentDescriptor,
} from "@8lines/gauntlet-protocol";

export interface CreateAppOptions {
  readonly environment: EnvironmentDescriptor;
  readonly targets: unknown;
  readonly fetch?: AdapterClientOptions["fetch"];
  readonly clock?: () => Date;
  readonly supportedProfiles?: readonly ProfileId[];
  readonly supportedCapabilities?: readonly CapabilityId[];
  readonly bodyLimit?: number;
  readonly maxUploadBytes?: number;
  readonly dashboardDir?: string;
}

export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
  assertNonProductionEnvironment(options.environment);
  const maxUploadBytes = options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
```

The excerpt ends at the first retained statement of the existing function. Do not trust loader typing alone: the runtime assertion must execute before upload-limit validation, target registry construction, stores, adapter clients, routes, dashboard registration, or `app.ready()`.

- [ ] **Step 5: Add shared environments and update every in-repository server test call site**

Create `apps/server/test/support/environment.ts`:

```ts
import type { EnvironmentDescriptor } from "@8lines/gauntlet-protocol";

export const serverEnvironment: EnvironmentDescriptor = Object.freeze({
  name: "gauntlet-dev",
  kind: "development",
});

export const adapterEnvironment: EnvironmentDescriptor = Object.freeze({
  name: "development",
  kind: "development",
});
```

The configuration plan already made `StaticTargetConfig.expectedEnvironment` required. Consume that contract in `apps/server/test/support/fake-adapter.ts` without changing its definition or parser:

```ts
import { adapterEnvironment } from "./environment.js";

export const fakeTarget: StaticTargetConfig = Object.freeze({
  id: "acme",
  label: "Acme",
  adapterUrl: "http://acme.internal",
  publicUrl: "https://app.example.test",
  expectedEnvironment: adapterEnvironment,
  tags: Object.freeze(["symfony"]),
});
```

Import `serverEnvironment` and pass `environment: serverEnvironment` in both direct `createApp` calls and the `usingApp` helper in `routes.integration.test.ts`, plus the route-level `createApp` call in `manifest-service.test.ts`. Exclude the defaulted field from the helper override type:

```ts
options: Omit<Parameters<typeof createApp>[0], "environment" | "targets" | "fetch"> = {},
const app = await createApp({
  environment: serverEnvironment,
  targets: [fakeTarget],
  fetch: fake.fetch,
  ...options,
});
```

Do not add an environment fallback to `createApp`, test helpers, `parseStaticTargetsJson`, or any production entrypoint.

- [ ] **Step 6: Run the affected server tests and confirm GREEN**

Run:

```bash
pnpm --filter @8lines/gauntlet-server exec tsx --test \
  test/public-api.test.ts \
  test/routes.integration.test.ts \
  test/manifest-service.test.ts
```

Expected: PASS; missing, unsupported, and production-like control-plane descriptors fail at `createApp`, while every valid test app uses the shared descriptor.

The repository-wide server typecheck is deferred only until the immediate configuration-plan Task 4 handoff updates its externally owned `main.ts` call site. That task must use the already implemented loader, without deriving an environment from a hostname, namespace, URL, or default:

```ts
const configuration = await loadServerConfiguration(
  environment,
  dependencies.readConfig ?? readFile,
);
return await createApp({
  environment: configuration.instance.environment,
  targets: configuration.targets,
  ...(environment.GAUNTLET_DASHBOARD_DIR === undefined
    ? {}
    : { dashboardDir: environment.GAUNTLET_DASHBOARD_DIR }),
});
```

- [ ] **Step 7: Inspect and selectively stage only Task 6 changes**

Run: `git diff -- apps/server/src/app.ts apps/server/src/main.ts apps/server/test`

Expected: the pre-existing dashboard/static-serving work remains present, `main.ts` is unchanged by this task, and no configuration-loader/static-target-parser changes are mixed into this commit.

```bash
git add apps/server/test/support/environment.ts \
  apps/server/test/support/fake-adapter.ts \
  apps/server/test/public-api.test.ts \
  apps/server/test/routes.integration.test.ts \
  apps/server/test/manifest-service.test.ts \
  apps/server/src/app.ts
git commit -m "feat(server): require a non-production control-plane environment"
```

### Task 7: Exact target-to-manifest gate

**Files:**

- Modify: `apps/server/src/manifest-service.ts`
- Modify: `apps/server/src/safe-problem.ts`
- Modify: `apps/server/test/manifest-service.test.ts`
- Modify: `apps/server/test/safe-problem.test.ts`
- Modify: `apps/server/test/routes.integration.test.ts`
- Modify: `apps/server/test/support/fake-adapter.ts`

**Interfaces:**

- Consumes: `StaticTargetConfig.expectedEnvironment` produced by Tasks 1-3 in `docs/superpowers/plans/2026-09-03-control-plane-configuration.md`, plus `AdapterManifest.application.environment` produced by this plan.
- Produces: a sanitized incompatible snapshot and guarantees that `requireCompatibleTarget` blocks every proxy path on mismatch.

- [ ] **Step 1: Add failing manifest-service mismatch tests**

```ts
test("marks exact environment-name mismatch unavailable without accepting its ETag", async () => {
  const manifest = structuredClone(happyManifest);
  manifest.application.environment = { name: "other-dev", kind: "development" };
  manifest.manifestRevision = computeRevision(manifest, "manifestRevision");
  const fixture = serviceWithManifest(manifest, fakeTarget);
  const snapshot = await fixture.service.refresh(fakeTarget.id);
  assert.equal(snapshot.state, "incompatible");
  assert.deepEqual(snapshot.problem, {
    type: "urn:gauntlet:problem:target-environment-mismatch",
    title: "Target environment mismatch",
    status: 503,
  });
  assert.equal(snapshot.manifest, undefined);
  assert.equal(fixture.requestedIfNoneMatch, undefined);
});

test("requires an exact environment-kind match", async () => {
  const manifest = manifestWithEnvironment({ name: "development", kind: "test" });
  const snapshot = await serviceWithManifest(manifest, fakeTarget).service.refresh(fakeTarget.id);
  assert.equal(snapshot.state, "incompatible");
});
```

- [ ] **Step 2: Run focused tests and observe online classification**

Run: `pnpm --filter @8lines/gauntlet-server exec tsx --test test/manifest-service.test.ts`

Expected: FAIL because a valid but different non-production manifest is classified `online`.

- [ ] **Step 3: Add the mismatch Problem and compare before LKG/ETag mutation**

```ts
const ENVIRONMENT_MISMATCH = problem(
  "urn:gauntlet:problem:target-environment-mismatch",
  "Target environment mismatch",
  503,
);

function environmentsMatch(target: StaticTargetConfig, manifest: AdapterManifest): boolean {
  return target.expectedEnvironment.name === manifest.application.environment.name
    && target.expectedEnvironment.kind === manifest.application.environment.kind;
}
```

Insert this before `lastKnownGood.set` and ETag writes:

```ts
const manifest = ownFrozenJson(result.value.manifest);
if (!environmentsMatch(target, manifest)) {
  return save(target, "incompatible", ENVIRONMENT_MISMATCH);
}
lastKnownGood.set(target.id, manifest);
```

Expose expectation on every snapshot:

```ts
export interface TargetSnapshot {
  readonly id: string;
  readonly label: string;
  readonly expectedEnvironment: EnvironmentDescriptor;
  readonly tags: readonly string[];
  readonly state: TargetState;
  readonly manifest?: AdapterManifest;
  readonly problem?: Problem;
  readonly refreshedAt: Rfc3339Timestamp;
}
```

Add the safe title mapping:

```ts
"urn:gauntlet:problem:target-environment-mismatch": "Target environment mismatch",
```

- [ ] **Step 4: Cover LKG recovery and target isolation**

Add tests proving:

```ts
assert.equal(firstMatching.state, "online");
assert.equal(nextMismatching.state, "incompatible");
assert.equal(nextMismatching.manifest?.manifestRevision, firstMatching.manifest?.manifestRevision);
assert.equal(recoveredMatching.state, "online");
assert.deepEqual((await service.listTargets()).map(({ id }) => id).sort(), ["healthy", "mismatch"]);
```

The mismatch response must not replace the matching LKG or its ETag. A later matching 304 may safely restore `online` because the retained LKG was already environment-matched.

- [ ] **Step 5: Add one all-proxy-path integration test**

Invoke these exact valid routes for a mismatched target:

```text
GET  /api/v1/targets/acme/operations/application-access-review
POST /api/v1/targets/acme/operations/application-access-review/runs
GET  /api/v1/targets/acme/runs/run-1
POST /api/v1/targets/acme/runs/run-1/cancel
GET  /api/v1/targets/acme/runs/run-1/events
POST /api/v1/targets/acme/uploads
POST /api/v1/targets/acme/data-sources/application-catalog/query
POST /api/v1/targets/acme/data-sources/application-catalog/resolve
POST /api/v1/targets/acme/runs/run-1/artifacts/launch-1/launch
```

For each response assert status/type `503/target-environment-mismatch`. After all requests assert:

```ts
assert.equal(fake.calls.every(({ pathname }) =>
  pathname === "/_gauntlet/v1/health"
  || pathname === "/_gauntlet/v1/manifest"), true);
```

- [ ] **Step 6: Run server tests and commit**

Run: `pnpm --filter @8lines/gauntlet-server test`

Expected: PASS; no proxy endpoint is reached on environment mismatch.

```bash
git add apps/server/src/manifest-service.ts apps/server/src/safe-problem.ts apps/server/test/manifest-service.test.ts apps/server/test/safe-problem.test.ts apps/server/test/routes.integration.test.ts apps/server/test/support/fake-adapter.ts
git commit -m "feat(server): block targets on environment mismatch"
```

### Task 8: Control-plane confirmation gate

**Files:**

- Modify: `apps/server/src/run-proxy-service.ts`
- Modify: `apps/server/test/run-proxy-service.test.ts`
- Modify: `apps/server/test/routes.integration.test.ts`
- Modify: `apps/server/test/support/fake-adapter.ts`

**Interfaces:**

- Consumes: `CreateRunRequest.confirmation` and resolved `OperationDefinition.execution`.
- Produces: pre-proxy confirmation rejection with fixed validation pointers.

- [ ] **Step 1: Add failing table-driven acknowledgement tests**

```ts
const invalidAcknowledgements = [
  ["missing", undefined, "/confirmation"],
  ["operation", { ...validConfirmation, operationId: "other-operation" }, "/confirmation/operationId"],
  ["revision", { ...validConfirmation, operationRevision: `sha256:${"0".repeat(64)}` }, "/confirmation/operationRevision"],
  ["impact", { ...validConfirmation, impact: "read" }, "/confirmation/impact"],
] as const;

for (const [name, confirmation, instancePath] of invalidAcknowledgements) {
  await t.test(name, async () => {
    const result = await service.create(fakeTarget.id, happyOperation.id, {
      ...validCreateRunRequest,
      ...(confirmation === undefined ? { confirmation: undefined } : { confirmation }),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.problem.status, 422);
    assert.equal(result.problem.errors?.[0]?.instancePath, instancePath);
    assert.equal(fake.calls.some(({ pathname }) => pathname.endsWith("/runs")), false);
  });
}
```

- [ ] **Step 2: Run the focused test and observe proxy calls**

Run: `pnpm --filter @8lines/gauntlet-server exec tsx --test test/run-proxy-service.test.ts`

Expected: FAIL because confirmation is not checked by the control plane.

- [ ] **Step 3: Add fixed validation failures and exact comparison**

```ts
function confirmationFailure(instancePath: string, keyword: "required" | "const"): Problem {
  return Object.freeze({
    ...VALIDATION_FAILED,
    errors: Object.freeze([{
      instancePath,
      schemaPath: "#",
      keyword,
      message: keyword === "required" ? "Required value is missing" : "Invalid value",
      params: Object.freeze({}),
    }]),
  });
}

function confirmationProblem(
  operationId: string,
  operation: OperationDefinition,
  request: CreateRunRequest,
): Problem | undefined {
  if (!operation.execution.confirmationRequired) return undefined;
  const confirmation = request.confirmation;
  if (confirmation === undefined) return confirmationFailure("/confirmation", "required");
  if (confirmation.operationId !== operationId) {
    return confirmationFailure("/confirmation/operationId", "const");
  }
  if (confirmation.operationRevision !== operation.revision) {
    return confirmationFailure("/confirmation/operationRevision", "const");
  }
  if (confirmation.impact !== operation.execution.impact) {
    return confirmationFailure("/confirmation/impact", "const");
  }
  return undefined;
}
```

Call it after the existing stale `operationRevision` branch and before context/proxy work:

```ts
const acknowledgementProblem = confirmationProblem(operationId, resolved.definition, ownedRequest);
if (acknowledgementProblem !== undefined) return failure(acknowledgementProblem);
```

- [ ] **Step 4: Prove dry-run still requires acknowledgement**

```ts
const result = await service.create(fakeTarget.id, happyOperation.id, {
  ...validCreateRunRequest,
  dryRun: true,
  confirmation: undefined,
});
assert.equal(result.ok, false);
if (!result.ok) assert.equal(result.problem.errors?.[0]?.instancePath, "/confirmation");
```

- [ ] **Step 5: Run server tests and commit**

Run: `pnpm --filter @8lines/gauntlet-server test`

Expected: PASS; valid acknowledgement is forwarded unchanged and invalid acknowledgement never reaches the adapter.

```bash
git add apps/server/src/run-proxy-service.ts apps/server/test/run-proxy-service.test.ts apps/server/test/routes.integration.test.ts apps/server/test/support/fake-adapter.ts
git commit -m "feat(server): enforce revision-bound run confirmation"
```

### Task 9: TypeScript Core stable secret and confirmation admission

**Files:**

- Modify: `packages/typescript/core/src/run-manager.ts`
- Modify: `packages/typescript/core/src/adapter-catalog.ts`
- Modify: `packages/typescript/core/test/run-manager.test.ts`
- Modify: `packages/typescript/core/test/adapter-catalog.test.ts`
- Modify: `packages/typescript/core/test/runtime-scalar-guard.test.ts`
- Modify: `packages/typescript/core/test/support/operation.ts`
- Modify: `packages/typescript/core/scripts/test-packed-consumer.mjs`
- Modify: `packages/typescript/core/README.md`

**Interfaces:**

- Consumes: protocol environment helper, confirmation acknowledgement, and semantic rules.
- Produces: required `RunManagerOptions.idempotencySecret`, catalog startup validation, and SDK-side confirmation defense before replay/admission.

- [ ] **Step 1: Add failing stable-secret and catalog-environment tests**

```ts
test("requires a stable idempotency secret", () => {
  assert.throws(
    () => new RunManager(registry, store, {
      validateSchema,
      validateFileReference,
    } as never),
    new TypeError("idempotencySecret must contain at least 32 bytes"),
  );
});

test("rejects an enabled catalog with production-like metadata", () => {
  assert.throws(() => createAdapterCatalog({
    ...catalogOptions,
    application: {
      id: "fixture",
      label: "Fixture",
      environment: { name: "fixture-prod", kind: "test" },
    },
  }), new TypeError("Invalid non-production environment descriptor"));
});
```

- [ ] **Step 2: Add failing confirmation ordering tests**

Use spies for schema validation, coordinator, store, scheduler, and handler. For missing and each mismatched member assert every count remains zero. Add an idempotent replay regression:

```ts
const first = await manager.create(operation.id, validRequest);
assert.equal(first.ok, true);
await drainScheduledTask();

const replayWithoutConfirmation = await manager.create(operation.id, {
  ...validRequest,
  confirmation: undefined,
});
assert.equal(replayWithoutConfirmation.ok, false);
if (!replayWithoutConfirmation.ok) {
  assert.equal(replayWithoutConfirmation.problem.errors?.[0]?.instancePath, "/confirmation");
}
```

- [ ] **Step 3: Run focused Core tests and observe failures**

Run: `pnpm --filter @8lines/gauntlet-typescript-core exec tsx --test test/run-manager.test.ts test/adapter-catalog.test.ts test/runtime-scalar-guard.test.ts`

Expected: FAIL because the secret defaults randomly, catalog environment is not explicitly guarded, and acknowledgement is not checked.

- [ ] **Step 4: Require the secret and validate catalog metadata**

```ts
export interface RunManagerOptions {
  readonly validateSchema: (
    request: SchemaValidationRequest,
  ) => MaybePromise<readonly ValidationError[]>;
  readonly validateFileReference: (
    request: FileReferenceValidationRequest,
  ) => MaybePromise<readonly ValidationError[]>;
  readonly idempotencySecret: Uint8Array;
  readonly now?: () => Rfc3339Timestamp;
  readonly createId?: () => string;
  readonly schedule?: (task: () => Promise<void>) => void;
  readonly executionCoordinator?: ExecutionCoordinator;
}
```

Preserve the existing callback signatures when naming the two callback aliases. Remove the `randomBytes` import and fallback. Validate defensively:

```ts
const idempotencySecret = options.idempotencySecret;
if (!(idempotencySecret instanceof Uint8Array) || idempotencySecret.byteLength < 32) {
  throw new TypeError("idempotencySecret must contain at least 32 bytes");
}
this.#idempotencySecret = Uint8Array.from(idempotencySecret);
```

At the first line of `createAdapterCatalog`:

```ts
const environment = assertNonProductionEnvironment(options.application.environment);
const application = cloneAndDeepFreeze({ ...options.application, environment });
```

- [ ] **Step 5: Add SDK-side confirmation checking in the required order**

```ts
function confirmationErrors(
  operationId: string,
  operation: OperationDefinition,
  request: CreateRunRequest,
): readonly ValidationError[] {
  if (!operation.execution.confirmationRequired) return [];
  if (request.confirmation === undefined) {
    return [validationError("/confirmation", "#/confirmation", "required", "confirmation acknowledgement is required")];
  }
  if (request.confirmation.operationId !== operationId) {
    return [validationError("/confirmation/operationId", "#/confirmation/operationId", "const", "confirmation operation does not match")];
  }
  if (request.confirmation.operationRevision !== operation.revision) {
    return [validationError("/confirmation/operationRevision", "#/confirmation/operationRevision", "const", "confirmation revision does not match")];
  }
  if (request.confirmation.impact !== operation.execution.impact) {
    return [validationError("/confirmation/impact", "#/confirmation/impact", "const", "confirmation impact does not match")];
  }
  return [];
}
```

Insert after the main request revision check and before the dry-run/idempotency branches:

```ts
const acknowledgementErrors = confirmationErrors(operationId, operation.definition, validatedRequest);
if (acknowledgementErrors.length > 0) {
  return { ok: false, problem: validationFailedProblem(acknowledgementErrors) };
}
```

- [ ] **Step 6: Update every RunManager construction with an explicit secret**

Use this deterministic test-only value:

```ts
idempotencySecret: new TextEncoder().encode("fixture-stable-idempotency-secret"),
```

The packed consumer demonstrates the same required option without logging or retaining the source string.

- [ ] **Step 7: Run Core tests and packed-consumer test**

Run: `pnpm --filter @8lines/gauntlet-typescript-core test`

Expected: PASS.

Run: `pnpm --filter @8lines/gauntlet-typescript-core test:package`

Expected: PASS with a clean external consumer using the required secret and structured environment.

- [ ] **Step 8: Commit TypeScript admission safety**

```bash
git add packages/typescript/core/src/run-manager.ts packages/typescript/core/src/adapter-catalog.ts packages/typescript/core/test/run-manager.test.ts packages/typescript/core/test/adapter-catalog.test.ts packages/typescript/core/test/runtime-scalar-guard.test.ts packages/typescript/core/test/support/operation.ts packages/typescript/core/scripts/test-packed-consumer.mjs packages/typescript/core/README.md
git commit -m "feat(typescript): fail closed before run admission"
```

### Task 10: TypeScript Core truthful dry-run context

**Files:**

- Modify: `packages/typescript/core/src/run-context.ts`
- Modify: `packages/typescript/core/src/run-manager.ts`
- Modify: `packages/typescript/core/test/execution-policy.test.ts`
- Modify: `packages/typescript/core/test/run-manager.test.ts`

**Interfaces:**

- Consumes: schema-validated `CreateRunRequest.dryRun`.
- Produces: handler-visible `RunContext.dryRun: boolean`, always `false` when omitted.

- [ ] **Step 1: Add a failing mutation-sentinel test**

```ts
test("propagates dry-run without calling the mutating dependency", async () => {
  let mutations = 0;
  const seen: boolean[] = [];
  const operation = operationFixture({
    dryRunSupported: true,
    handler: async (_input, context) => {
      seen.push(context.dryRun);
      if (!context.dryRun) mutations += 1;
      return { summary: { title: "done", tone: "success" }, artifacts: [], actions: [] };
    },
  });

  await executeToCompletion(operation, { ...validRequest, dryRun: true });
  assert.deepEqual(seen, [true]);
  assert.equal(mutations, 0);

  await executeToCompletion(operation, {
    ...validRequest,
    dryRun: false,
    idempotencyKey: "live-run",
  });
  assert.deepEqual(seen, [true, false]);
  assert.equal(mutations, 1);
});
```

- [ ] **Step 2: Run the test and observe missing context state**

Run: `pnpm --filter @8lines/gauntlet-typescript-core exec tsx --test test/execution-policy.test.ts`

Expected: FAIL because `RunContext` has no `dryRun` property.

- [ ] **Step 3: Carry the verified value into a frozen context**

```ts
export interface RunContext {
  readonly signal: AbortSignal;
  readonly dryRun: boolean;
  readonly invocationContext?: InvocationContext;
  reportProgress(progress: RunProgress): Promise<void>;
}
```

Add to the execution state:

```ts
interface ManagedExecution {
  readonly dryRun: boolean;
  // Preserve existing run, lease, signal, task, and termination fields.
}
```

Set it only from the canonical request:

```ts
dryRun: validatedRequest.dryRun === true,
```

Build and freeze the handler context after defining the leased invocation getter:

```ts
const context = {
  signal: execution.signal,
  dryRun: execution.dryRun,
  reportProgress,
} as RunContext;
Object.defineProperty(context, "invocationContext", {
  enumerable: true,
  get: () => execution.invocationContextLease.read(),
});
Object.freeze(context);
```

- [ ] **Step 4: Preserve unsupported-dry-run rejection and default false**

Add explicit assertions:

```ts
assert.equal(unsupportedResult.ok, false);
assert.equal(handlerCalls, 0);
assert.deepEqual(await captureContextFor({ ...validRequest, dryRun: undefined }), { dryRun: false });
```

- [ ] **Step 5: Run and commit dry-run propagation**

Run: `pnpm --filter @8lines/gauntlet-typescript-core test`

Expected: PASS, with the dry-run sentinel remaining zero.

```bash
git add packages/typescript/core/src/run-context.ts packages/typescript/core/src/run-manager.ts packages/typescript/core/test/execution-policy.test.ts packages/typescript/core/test/run-manager.test.ts
git commit -m "feat(typescript): propagate dry-run to handlers"
```

### Task 11: Node and Next enabled-adapter startup gate

**Files:**

- Modify: `packages/typescript/node/src/adapter-handler.ts`
- Modify: `packages/typescript/node/test/adapter-handler.test.ts`
- Modify: `packages/typescript/node/test/adapter-v1-routes.test.ts`
- Modify: `packages/typescript/node/test/support/fixture-catalog.ts`
- Modify: `packages/typescript/next/test/route-handler.test.ts`

**Interfaces:**

- Consumes: canonical manifest validation, including Task 3 environment semantics.
- Produces: synchronous construction failure for enabled custom catalogs; disabled handlers never inspect the catalog.

- [ ] **Step 1: Add failing construction-boundary tests**

```ts
test("enabled handler validates application environment during construction", () => {
  let calls = 0;
  const catalog = fixtureCatalog({
    manifest() {
      calls += 1;
      return manifestWithEnvironment({ name: "portal-prod", kind: "test" });
    },
  });
  assert.throws(() => createAdapterFetchHandler({ enabled: true, catalog }), TypeError);
  assert.equal(calls, 1);
});

test("disabled handler does not inspect a hostile catalog", async () => {
  const catalog = fixtureCatalog({
    manifest() {
      throw new Error("must not be called");
    },
  });
  const handler = createAdapterFetchHandler({ enabled: false, catalog });
  const response = await handler(adapterRequest("GET", "/_gauntlet/v1/manifest"));
  assert.equal(response.status, 503);
});
```

- [ ] **Step 2: Run Node tests and observe deferred validation**

Run: `pnpm --filter @8lines/gauntlet-typescript-node exec tsx --test test/adapter-handler.test.ts test/adapter-v1-routes.test.ts`

Expected: FAIL because enabled manifest validation currently happens only inside request dispatch.

- [ ] **Step 3: Validate once during construction and retain per-request defense**

```ts
export function createAdapterFetchHandler(options: AdapterFetchHandlerOptions): AdapterFetchHandler {
  if (options.enabled === true) ownSafeCatalogManifest(options.catalog.manifest());
  const now = options.now ?? (() => new Date().toISOString());
  const schemaValidator = options.schemaValidator ?? createAjvSchemaValidator();
}
```

Keep every current per-request `ownSafeCatalogManifest` call after this construction-time check. Do not inspect catalog metadata when `enabled !== true`.

- [ ] **Step 4: Add the equivalent Next wrapper assertion**

```ts
assert.throws(() => createGauntletRouteHandler({
  enabled: true,
  catalog: fixtureCatalogWithEnvironment({ name: "live-eu", kind: "preview" }),
}), TypeError);
```

- [ ] **Step 5: Run and commit Node/Next gates**

Run: `pnpm --filter @8lines/gauntlet-typescript-node test`

Expected: PASS.

Run: `pnpm --filter @8lines/gauntlet-next-adapter test`

Expected: PASS.

```bash
git add packages/typescript/node/src/adapter-handler.ts packages/typescript/node/test/adapter-handler.test.ts packages/typescript/node/test/adapter-v1-routes.test.ts packages/typescript/node/test/support/fixture-catalog.ts packages/typescript/next/test/route-handler.test.ts
git commit -m "feat(node): validate enabled adapter metadata at construction"
```

### Task 12: PHP Core environment and confirmation models

**Files:**

- Create: `packages/php/core/src/Protocol/EnvironmentKind.php`
- Create: `packages/php/core/src/Protocol/EnvironmentDescriptor.php`
- Create: `packages/php/core/src/Run/ConfirmationAcknowledgement.php`
- Create: `packages/php/core/tests/Unit/Protocol/EnvironmentDescriptorTest.php`
- Modify: `packages/php/core/src/Manifest/ManifestBuilder.php`
- Modify: `packages/php/core/src/Run/CreateRunRequest.php`
- Modify: `packages/php/core/src/Definition/ExecutionPolicy.php`
- Modify: `packages/php/core/src/Schema/ProtocolSemantics.php`
- Modify: `packages/php/core/tests/Unit/Manifest/ManifestBuilderTest.php`
- Modify: `packages/php/core/tests/Unit/Run/RunProtocolTest.php`

**Interfaces:**

- Consumes: protocol wire contract and alias expression from Tasks 1-4.
- Produces: immutable PHP environment/confirmation values and constructor-level destructive policy rejection.

- [ ] **Step 1: Add failing PHP environment model tests**

```php
public function testItOwnsEverySupportedEnvironmentKind(): void
{
    foreach (['development', 'test', 'qa', 'staging', 'uat', 'preview', 'sandbox'] as $kind) {
        $environment = EnvironmentDescriptor::fromProtocolValue([
            'name' => 'client-' . $kind,
            'kind' => $kind,
        ]);
        self::assertSame(['name' => 'client-' . $kind, 'kind' => $kind], $environment->toProtocolArray());
    }
}

public function testItRejectsProductionTokensAndClosedShapeViolations(): void
{
    foreach (['prod', 'client-prod', 'PRODUCTION', 'live_eu'] as $name) {
        try {
            EnvironmentDescriptor::fromProtocolValue(['name' => $name, 'kind' => 'test']);
            self::fail('Expected environment rejection');
        } catch (\InvalidArgumentException $exception) {
            self::assertSame('Invalid non-production environment descriptor', $exception->getMessage());
        }
    }
    $this->expectException(\InvalidArgumentException::class);
    EnvironmentDescriptor::fromProtocolValue(['name' => 'dev', 'kind' => 'test', 'extra' => true]);
}
```

- [ ] **Step 2: Add failing model/semantic tests**

```php
$acknowledgement = new ConfirmationAcknowledgement(
    operationId: 'application-access-review',
    operationRevision: $revision,
    impact: OperationImpact::WRITE,
);
self::assertSame([
    'operationId' => 'application-access-review',
    'operationRevision' => $revision,
    'impact' => 'write',
], $acknowledgement->toProtocolArray());

$this->expectException(\InvalidArgumentException::class);
new ExecutionPolicy(
    impact: OperationImpact::DESTRUCTIVE,
    confirmationRequired: false,
    dryRunSupported: false,
    idempotency: 'required',
    cancellationSupported: false,
);
```

- [ ] **Step 3: Run focused PHPUnit tests and observe missing classes**

Run from `packages/php/core`:

```bash
vendor/bin/phpunit -c phpunit.xml.dist tests/Unit/Protocol/EnvironmentDescriptorTest.php tests/Unit/Manifest/ManifestBuilderTest.php tests/Unit/Run/RunProtocolTest.php
```

Expected: FAIL because the value classes and constructor fields do not exist.

- [ ] **Step 4: Implement exact immutable PHP values**

```php
enum EnvironmentKind: string
{
    case Development = 'development';
    case Test = 'test';
    case Qa = 'qa';
    case Staging = 'staging';
    case Uat = 'uat';
    case Preview = 'preview';
    case Sandbox = 'sandbox';
}
```

```php
final readonly class EnvironmentDescriptor
{
    private const PRODUCTION_TOKEN = '/(^|[._:-])(prod|production|live)($|[._:-])/iD';

    public function __construct(public string $name, public EnvironmentKind $kind)
    {
        try {
            ProtocolId::assert($name);
        } catch (\Throwable) {
            throw new \InvalidArgumentException('Invalid non-production environment descriptor');
        }
        if (preg_match(self::PRODUCTION_TOKEN, $name) === 1) {
            throw new \InvalidArgumentException('Invalid non-production environment descriptor');
        }
    }

    public static function fromProtocolValue(mixed $value): self
    {
        if (!is_array($value)
            || count($value) !== 2
            || !array_key_exists('name', $value)
            || !array_key_exists('kind', $value)
            || !is_string($value['name'])
            || !is_string($value['kind'])) {
            throw new \InvalidArgumentException('Invalid non-production environment descriptor');
        }
        try {
            return new self($value['name'], EnvironmentKind::from($value['kind']));
        } catch (\Throwable) {
            throw new \InvalidArgumentException('Invalid non-production environment descriptor');
        }
    }

    public function toProtocolArray(): array
    {
        return ['name' => $this->name, 'kind' => $this->kind->value];
    }
}
```

```php
final readonly class ConfirmationAcknowledgement
{
    public function __construct(
        public string $operationId,
        public string $operationRevision,
        public OperationImpact $impact,
        public ?ProtocolExtensions $extensions = null,
    ) {
        ProtocolId::assert($operationId);
        ProtocolId::assertRevision($operationRevision);
    }

    /** @return array<string, mixed> */
    public function toProtocolArray(): array
    {
        $document = [
            'operationId' => $this->operationId,
            'operationRevision' => $this->operationRevision,
            'impact' => $this->impact->value,
        ];
        if ($this->extensions !== null) {
            $document['extensions'] = $this->extensions->toProtocolArray();
        }

        return $document;
    }
}
```

- [ ] **Step 5: Wire models into builders and semantics**

`ManifestBuilder` accepts a required `EnvironmentDescriptor` and emits:

```php
'application' => [
    'id' => $this->applicationId,
    'label' => $this->applicationLabel,
    'environment' => $this->environment->toProtocolArray(),
],
```

`CreateRunRequest` gains `public ?ConfirmationAcknowledgement $confirmation = null` and serializes it under `confirmation`. `ProtocolSemantics` calls `EnvironmentDescriptor::fromProtocolValue` and enforces:

```php
if ($execution['impact'] === 'destructive'
    && ($execution['confirmationRequired'] !== true || $execution['idempotency'] !== 'required')) {
    return false;
}
```

- [ ] **Step 6: Run and commit PHP model changes**

Run from `packages/php/core`:

```bash
vendor/bin/phpunit -c phpunit.xml.dist tests/Unit/Protocol/EnvironmentDescriptorTest.php tests/Unit/Manifest/ManifestBuilderTest.php tests/Unit/Run/RunProtocolTest.php tests/Unit/Schema/ProtocolSemanticsTest.php
```

Expected: PASS with all 39 shared document vectors.

```bash
git add packages/php/core/src/Protocol/EnvironmentKind.php packages/php/core/src/Protocol/EnvironmentDescriptor.php packages/php/core/src/Run/ConfirmationAcknowledgement.php packages/php/core/src/Manifest/ManifestBuilder.php packages/php/core/src/Run/CreateRunRequest.php packages/php/core/src/Definition/ExecutionPolicy.php packages/php/core/src/Schema/ProtocolSemantics.php packages/php/core/tests/Unit/Protocol/EnvironmentDescriptorTest.php packages/php/core/tests/Unit/Manifest/ManifestBuilderTest.php packages/php/core/tests/Unit/Run/RunProtocolTest.php
git commit -m "feat(php): model environment and run confirmation"
```

### Task 13: PHP Core confirmation and dry-run runtime

**Files:**

- Modify: `packages/php/core/src/Contract/RunContext.php`
- Modify: `packages/php/core/src/Run/DefaultRunContext.php`
- Modify: `packages/php/core/src/Run/RunManager.php`
- Modify: `packages/php/core/tests/Unit/Run/RunManagerExecutionPolicyTest.php`
- Modify: `packages/php/core/tests/Unit/Run/RunManagerTest.php`

**Interfaces:**

- Consumes: `CreateRunRequest.confirmation`, `ExecutionPolicy`, and verified request dry-run.
- Produces: `RunContext::isDryRun(): bool` and pre-admission confirmation enforcement.

- [ ] **Step 1: Add failing confirmation ordering tests**

For absent, operation-ID mismatch, revision mismatch, and impact mismatch, assert:

```php
self::assertFalse($result->isSuccess());
self::assertSame(422, $result->problem()?->status);
self::assertSame($expectedPointer, $result->problem()?->errors[0]->instancePath);
self::assertSame(0, $schemaValidator->calls);
self::assertSame(0, $coordinator->calls);
self::assertSame(0, $store->createCalls);
self::assertSame(0, $handler->calls);
```

Create one successful run first, then replay its idempotency key without acknowledgement and assert the replay is rejected rather than returned from the store.

- [ ] **Step 2: Add a failing PHP mutation-sentinel test**

```php
$mutations = 0;
$seen = [];
$handler = new PolicyHandler(
    new ExecutionPolicy(
        impact: OperationImpact::WRITE,
        confirmationRequired: false,
        dryRunSupported: true,
        idempotency: 'required',
        cancellationSupported: false,
    ),
    onExecute: static function (object $input, RunContext $context) use (&$mutations, &$seen): void {
        $seen[] = $context->isDryRun();
        if (!$context->isDryRun()) {
            ++$mutations;
        }
    },
);
$store = new InMemoryRunStore();
$dispatcher = new CapturingRunDispatcher();
$manager = self::manager($handler, $store, $dispatcher);

$dry = new CreateRunRequest(
    operationRevision: $handler->definition()->revision(),
    input: JsonOwnership::object(['message' => 'dry']),
    dryRun: true,
    idempotencyKey: 'dry-run',
);
$manager->create('test.policy', $dry);
$dispatcher->tasks[0]->run();
self::assertSame([true], $seen);
self::assertSame(0, $mutations);

$live = new CreateRunRequest(
    operationRevision: $handler->definition()->revision(),
    input: JsonOwnership::object(['message' => 'live']),
    dryRun: false,
    idempotencyKey: 'live-run',
);
$manager->create('test.policy', $live);
$dispatcher->tasks[1]->run();
self::assertSame([true, false], $seen);
self::assertSame(1, $mutations);
```

- [ ] **Step 3: Run focused runtime tests and observe failures**

Run from `packages/php/core`:

```bash
vendor/bin/phpunit -c phpunit.xml.dist tests/Unit/Run/RunManagerExecutionPolicyTest.php tests/Unit/Run/RunManagerTest.php
```

Expected: FAIL because acknowledgement is ignored and the context has no dry-run method.

- [ ] **Step 4: Extend and implement the context contract**

```php
public function isDryRun(): bool;
```

Add this method to the existing `RunContext` interface without changing its run ID, operation ID, invocation, cancellation, progress, artifact, action, log, or warning methods.

```php
public function __construct(
    private readonly string $runId,
    private readonly string $operationId,
    private readonly bool $dryRun,
    private readonly InvocationContextLease $lease,
    ?\Closure $cancellationRequested = null,
    private readonly ?int $deadlineNanoseconds = null,
) {
    $this->cancellationRequested = $cancellationRequested;
}

public function isDryRun(): bool
{
    return $this->dryRun;
}
```

Capture `$dryRun = $request->dryRun` in the execution task before request/input retention is released and pass it to `DefaultRunContext`.

- [ ] **Step 5: Enforce acknowledgement before any admission side effect**

Immediately after the request revision check:

```php
$confirmationError = $this->confirmationError($operationId, $operation, $request);
if ($confirmationError !== null) {
    return RunCreationResult::failure(Problem::validation([$confirmationError]));
}
```

`confirmationError` returns a `ValidationError` for `/confirmation`, `/confirmation/operationId`, `/confirmation/operationRevision`, or `/confirmation/impact`. It returns `null` for operations that do not require confirmation. This branch precedes secret traversal, schema validation, idempotency fingerprint lookup, coordinator admission, store writes, dispatch, and handler execution.

- [ ] **Step 6: Run Core PHP tests and commit**

Run from `packages/php/core`:

```bash
vendor/bin/phpunit -c phpunit.xml.dist
```

Expected: PASS; dry-run sentinel is zero and invalid acknowledgement produces no admission side effects.

```bash
git add packages/php/core/src/Contract/RunContext.php packages/php/core/src/Run/DefaultRunContext.php packages/php/core/src/Run/RunManager.php packages/php/core/tests/Unit/Run/RunManagerExecutionPolicyTest.php packages/php/core/tests/Unit/Run/RunManagerTest.php
git commit -m "feat(php): enforce confirmation and propagate dry-run"
```

### Task 14: Symfony startup and envelope safety

**Files:**

- Modify: `packages/php/symfony-bundle/src/DependencyInjection/Configuration.php`
- Modify: `packages/php/symfony-bundle/src/DependencyInjection/GauntletExtension.php`
- Modify: `packages/php/symfony-bundle/src/Support/AdapterConfiguration.php`
- Modify: `packages/php/symfony-bundle/src/Registry/SymfonyAdapterCatalog.php`
- Modify: `packages/php/symfony-bundle/src/Http/EnvelopeMapper.php`
- Modify: `packages/php/symfony-bundle/tests/Fixture/App/FixtureKernel.php`
- Modify: `packages/php/symfony-bundle/tests/Integration/DependencyInjectionTest.php`
- Modify: `packages/php/symfony-bundle/tests/Integration/AdapterHttpTest.php`

**Interfaces:**

- Consumes: PHP Core environment and confirmation values from Tasks 12-13.
- Ownership boundary: Task 4 in `docs/superpowers/plans/2026-09-03-private-release-engineering.md` later owns all PHP/Composer/Symfony compatibility constraints, lockfiles, Docker test images, and PHP 8.3-Symfony 7.2 matrix work. This task does not edit or regenerate them.
- Produces: fail-closed Symfony container construction, nested environment configuration, and HTTP acknowledgement mapping.

- [ ] **Step 1: Add failing DI configuration cases**

```php
yield 'missing environment' => [[
    'enabled' => true,
    'application' => ['id' => 'fixture-app', 'label' => 'Fixture App'],
    'idempotency_secret' => 'fixture-stable-idempotency-secret',
]];
yield 'unsupported kind' => [[
    'enabled' => true,
    'application' => [
        'id' => 'fixture-app',
        'label' => 'Fixture App',
        'environment' => ['name' => 'fixture-dev', 'kind' => 'production'],
    ],
    'idempotency_secret' => 'fixture-stable-idempotency-secret',
]];
yield 'production alias' => [[
    'enabled' => true,
    'application' => [
        'id' => 'fixture-app',
        'label' => 'Fixture App',
        'environment' => ['name' => 'fixture-prod', 'kind' => 'test'],
    ],
    'idempotency_secret' => 'fixture-stable-idempotency-secret',
]];
```

Also assert `['enabled' => false]` builds and every adapter-prefix route returns canonical disabled 503.

- [ ] **Step 2: Add failing HTTP acknowledgement cases**

Post a valid create-run body with confirmation removed and assert `422`, `/confirmation`, and zero `EchoOperation` calls. Repeat for the three mismatched members. Post a dry-run body without confirmation and assert the same rejection.

- [ ] **Step 3: Run bundle tests and observe failures**

Run from `packages/php/symfony-bundle`:

```bash
vendor/bin/phpunit -c phpunit.xml.dist tests/Integration/DependencyInjectionTest.php tests/Integration/AdapterHttpTest.php
```

Expected: FAIL because environment config is scalar/optional and the mapper rejects or drops confirmation.

- [ ] **Step 4: Define nested environment config and construct the value defensively**

```php
->arrayNode('environment')
    ->isRequired()
    ->children()
        ->scalarNode('name')->isRequired()->cannotBeEmpty()->end()
        ->enumNode('kind')
            ->values(['development', 'test', 'qa', 'staging', 'uat', 'preview', 'sandbox'])
            ->isRequired()
        ->end()
    ->end()
->end()
```

Pass scalar name/kind through compiled DI arguments and construct `EnvironmentDescriptor` inside `AdapterConfiguration`. This avoids embedding a runtime object in a dumped container definition while retaining Core validation. Enabled configuration must not inherit a default idempotency secret.

- [ ] **Step 5: Accept and map the closed acknowledgement object**

Extend `EnvelopeMapper`'s create-run allowed keys with `confirmation`. Parse exactly `operationId`, `operationRevision`, `impact`, and optional `extensions`, then construct:

```php
new ConfirmationAcknowledgement(
    operationId: $confirmation['operationId'],
    operationRevision: $confirmation['operationRevision'],
    impact: OperationImpact::from($confirmation['impact']),
    extensions: $confirmation['extensions'] ?? [],
)
```

- [ ] **Step 6: Run normal bundle tests and commit only Symfony safety changes**

Run from `packages/php/symfony-bundle`:

```bash
vendor/bin/phpunit -c phpunit.xml.dist
```

Expected: PASS with the dependency set already installed for development. Task 4 in the private-release plan separately proves the PHP 8.3/Symfony 7.2 compatibility floor and owns every dependency or image update.

```bash
git add packages/php/symfony-bundle/src/DependencyInjection/Configuration.php \
  packages/php/symfony-bundle/src/DependencyInjection/GauntletExtension.php \
  packages/php/symfony-bundle/src/Support/AdapterConfiguration.php \
  packages/php/symfony-bundle/src/Registry/SymfonyAdapterCatalog.php \
  packages/php/symfony-bundle/src/Http/EnvelopeMapper.php \
  packages/php/symfony-bundle/tests/Fixture/App/FixtureKernel.php \
  packages/php/symfony-bundle/tests/Integration/DependencyInjectionTest.php \
  packages/php/symfony-bundle/tests/Integration/AdapterHttpTest.php
git commit -m "feat(symfony): fail closed on unsafe adapter configuration"
```

### Task 15: Java Core environment, confirmation, and semantics

**Files:**

- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/EnvironmentKind.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/EnvironmentDescriptor.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/ConfirmationAcknowledgement.java`
- Modify: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/ApplicationMetadata.java`
- Modify: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/CreateRunRequest.java`
- Modify: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/ExecutionPolicy.java`
- Modify: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/schema/ProtocolSemantics.java`
- Modify: `packages/java/core/src/test/java/dev/eightlines/gauntlet/core/ProtocolModelTest.java`
- Modify: `packages/java/core/src/test/java/dev/eightlines/gauntlet/core/ProtocolSemanticsTest.java`
- Modify: `packages/java/core/src/test/java/dev/eightlines/gauntlet/core/CoreTestFixtures.java`

**Interfaces:**

- Consumes: shared wire and semantic vectors from Tasks 1-4.
- Produces: Java `EnvironmentDescriptor`, `EnvironmentKind`, `ConfirmationAcknowledgement`, and constructor-level destructive policy enforcement.

- [ ] **Step 1: Add failing Java model tests**

```java
@Test
void rejectsProductionLikeEnvironmentNames() {
  for (String name : List.of("prod", "portal-prod", "PRODUCTION", "live_eu")) {
    var error = assertThrows(
        IllegalArgumentException.class,
        () -> new EnvironmentDescriptor(name, EnvironmentKind.TEST));
    assertEquals("Invalid non-production environment descriptor", error.getMessage());
  }
}

@Test
void serializesRevisionBoundConfirmation() {
  var acknowledgement = new ConfirmationAcknowledgement(
      "application-access-review",
      REVISION,
      OperationImpact.WRITE,
      JsonOwnership.object(Map.of()));
  assertEquals("application-access-review", acknowledgement.toProtocolMap().values().get("operationId"));
  assertEquals(REVISION, acknowledgement.toProtocolMap().values().get("operationRevision"));
  assertEquals("write", acknowledgement.toProtocolMap().values().get("impact"));
}
```

- [ ] **Step 2: Add failing destructive-policy tests**

```java
assertThrows(IllegalArgumentException.class, () -> new ExecutionPolicy(
    OperationImpact.DESTRUCTIVE,
    false,
    false,
    Idempotency.REQUIRED,
    false,
    null,
    null,
    empty()));
assertThrows(IllegalArgumentException.class, () -> new ExecutionPolicy(
    OperationImpact.DESTRUCTIVE,
    true,
    false,
    Idempotency.OPTIONAL,
    false,
    null,
    null,
    empty()));
```

- [ ] **Step 3: Run Core model tests and observe missing types**

Run from `packages/java`:

```bash
./gradlew -DgauntletProtocolFixtures=../protocol/fixtures/v1 :core:test --tests '*ProtocolModelTest' --tests '*ProtocolSemanticsTest'
```

Expected: FAIL because environment and acknowledgement models do not exist.

- [ ] **Step 4: Implement the exact Java values**

```java
public enum EnvironmentKind {
  DEVELOPMENT("development"), TEST("test"), QA("qa"), STAGING("staging"),
  UAT("uat"), PREVIEW("preview"), SANDBOX("sandbox");

  private final String wireValue;

  EnvironmentKind(String wireValue) { this.wireValue = wireValue; }

  public String wireValue() { return wireValue; }

  public static EnvironmentKind fromWireValue(String value) {
    return Arrays.stream(values())
        .filter(kind -> kind.wireValue.equals(value))
        .findFirst()
        .orElseThrow(() -> new IllegalArgumentException("Invalid non-production environment descriptor"));
  }
}
```

```java
public record EnvironmentDescriptor(String name, EnvironmentKind kind) {
  private static final Pattern PRODUCTION_TOKEN =
      Pattern.compile("(^|[._:-])(prod|production|live)($|[._:-])", Pattern.CASE_INSENSITIVE);

  public EnvironmentDescriptor {
    try {
      name = ProtocolId.require(name);
    } catch (RuntimeException exception) {
      throw new IllegalArgumentException("Invalid non-production environment descriptor");
    }
    if (kind == null) {
      throw new IllegalArgumentException("Invalid non-production environment descriptor");
    }
    if (PRODUCTION_TOKEN.matcher(name).find()) {
      throw new IllegalArgumentException("Invalid non-production environment descriptor");
    }
  }

  public JsonObject toProtocolMap() {
    return ProtocolMap.build(values -> {
      values.put("name", name);
      values.put("kind", kind.wireValue());
    });
  }

  public static EnvironmentDescriptor fromProtocolValue(JsonValue value) {
    if (!(value instanceof JsonObject object)
        || !object.values().keySet().equals(Set.of("name", "kind"))) {
      throw new IllegalArgumentException("Invalid non-production environment descriptor");
    }
    Object rawName = object.get("name").unwrap();
    Object rawKind = object.get("kind").unwrap();
    if (!(rawName instanceof String name) || !(rawKind instanceof String kind)) {
      throw new IllegalArgumentException("Invalid non-production environment descriptor");
    }
    return new EnvironmentDescriptor(name, EnvironmentKind.fromWireValue(kind));
  }
}
```

Implement `ConfirmationAcknowledgement` as a record with `operationId`, `operationRevision`, `OperationImpact`, and owned extensions, plus `toProtocolMap()` using the exact wire keys.

- [ ] **Step 5: Replace application string and extend create-run serialization**

```java
public record ApplicationMetadata(
    String id,
    String label,
    EnvironmentDescriptor environment,
    JsonObject extensions) {
  public ApplicationMetadata {
    id = ProtocolId.require(id);
    if (label == null || label.isEmpty()) throw new IllegalArgumentException("application label is blank");
    environment = Objects.requireNonNull(environment, "environment");
    extensions = ProtocolValidation.requireExtensions(extensions);
  }
}
```

Add `ConfirmationAcknowledgement confirmation` to `CreateRunRequest` before extensions and serialize it as `confirmation.toProtocolMap()` when non-null. Keep `InvocationContext` unchanged.

- [ ] **Step 6: Port semantic checks and run Core tests**

The raw manifest semantic path parses both descriptor fields and uses the exact alias expression. The operation semantic path rejects both unsafe destructive combinations.

Run:

```bash
./gradlew -DgauntletProtocolFixtures=../protocol/fixtures/v1 :core:test
```

Expected: PASS with all 39 shared document vectors.

- [ ] **Step 7: Commit Java models and semantics**

```bash
git add packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/EnvironmentKind.java packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/EnvironmentDescriptor.java packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/ConfirmationAcknowledgement.java packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/ApplicationMetadata.java packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/CreateRunRequest.java packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/ExecutionPolicy.java packages/java/core/src/main/java/dev/eightlines/gauntlet/core/schema/ProtocolSemantics.java packages/java/core/src/test/java/dev/eightlines/gauntlet/core/ProtocolModelTest.java packages/java/core/src/test/java/dev/eightlines/gauntlet/core/ProtocolSemanticsTest.java packages/java/core/src/test/java/dev/eightlines/gauntlet/core/CoreTestFixtures.java
git commit -m "feat(java): model environment and run confirmation"
```

### Task 16: Java Core confirmation and dry-run runtime

**Files:**

- Modify: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/spi/RunContext.java`
- Modify: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/run/RunManager.java`
- Modify: `packages/java/core/src/test/java/dev/eightlines/gauntlet/core/RunManagerExecutionPolicyTest.java`
- Modify: `packages/java/core/src/test/java/dev/eightlines/gauntlet/core/RunManagerSafetyTest.java`

**Interfaces:**

- Consumes: Java acknowledgement model and canonical create-run request.
- Produces: `RunContext.isDryRun()` and SDK-side confirmation checking before replay/admission.

- [ ] **Step 1: Add failing acknowledgement ordering tests**

For absent and each mismatched member assert:

```java
assertFalse(result.isSuccess());
assertEquals(422, result.problem().status());
assertEquals(expectedPointer, result.problem().errors().getFirst().instancePath());
assertEquals(0, schemaCalls.get());
assertEquals(0, coordinatorCalls.get());
assertEquals(0, storeCalls.get());
assertEquals(0, handlerCalls.get());
```

Add an idempotent replay test that first completes a valid request, then removes confirmation while retaining the key and expects `/confirmation`, not the stored run.

- [ ] **Step 2: Add a failing Java mutation-sentinel test**

```java
var mutations = new AtomicInteger();
var seen = new ArrayList<Boolean>();
var dryRunPolicy = new ExecutionPolicy(
    OperationImpact.WRITE,
    false,
    true,
    Idempotency.OPTIONAL,
    false,
    null,
    "allow",
    CoreTestFixtures.EMPTY);
try (var fixture = fixture(dryRunPolicy, (input, context) -> {
  seen.add(context.isDryRun());
  if (!context.isDryRun()) mutations.incrementAndGet();
  return OperationResult.succeeded(CoreTestFixtures.EMPTY);
})) {
  var dryRequest = new CreateRunRequest(
      fixture.definition.revision(),
      CoreTestFixtures.EMPTY,
      null,
      true,
      "dry-run",
      null,
      CoreTestFixtures.EMPTY);
  var dry = fixture.manager.create(fixture.definition.id(), dryRequest);
  assertEquals(RunState.SUCCEEDED, awaitTerminal(fixture.manager, dry.run().id()).state());
  assertEquals(List.of(true), seen);
  assertEquals(0, mutations.get());

  var liveRequest = new CreateRunRequest(
      fixture.definition.revision(),
      CoreTestFixtures.EMPTY,
      null,
      false,
      "live-run",
      null,
      CoreTestFixtures.EMPTY);
  var live = fixture.manager.create(fixture.definition.id(), liveRequest);
  assertEquals(RunState.SUCCEEDED, awaitTerminal(fixture.manager, live.run().id()).state());
  assertEquals(List.of(true, false), seen);
  assertEquals(1, mutations.get());
}
```

- [ ] **Step 3: Run runtime tests and observe failures**

Run from `packages/java`:

```bash
./gradlew -DgauntletProtocolFixtures=../protocol/fixtures/v1 :core:test --tests '*RunManagerExecutionPolicyTest' --tests '*RunManagerSafetyTest'
```

Expected: FAIL because confirmation is ignored and handler context lacks dry-run.

- [ ] **Step 4: Extend context and execution state**

```java
boolean isDryRun();
```

Add this method to the existing interface without changing its run ID, operation ID, optional invocation context, report, artifact, action, logging, warning, or cancellation methods.

Add `private final boolean dryRun` to the nested `DefaultRunContext`, accept it between `operationId` and `lease`, and implement:

```java
@Override
public boolean isDryRun() {
  return dryRun;
}
```

Add a final `boolean dryRun` to the execution control, initialize it only as `request.dryRun()` after envelope construction succeeds, and pass `control.dryRun` to `new DefaultRunContext(...)`.

- [ ] **Step 5: Add fixed acknowledgement validation before side effects**

After stale request revision and before SecretGuard/schema/idempotency/coordinator/store:

```java
ValidationError acknowledgementError = confirmationError(operationId, operation.definition(), request);
if (acknowledgementError != null) {
  return RunCreationResult.failure(validationProblem(List.of(acknowledgementError)));
}
```

The helper returns pointers `/confirmation`, `/confirmation/operationId`, `/confirmation/operationRevision`, or `/confirmation/impact`, and returns null when confirmation is not required.

- [ ] **Step 6: Run and commit Java runtime changes**

Run:

```bash
./gradlew -DgauntletProtocolFixtures=../protocol/fixtures/v1 :core:test
```

Expected: PASS; mutation sentinel stays zero for dry-run.

```bash
git add packages/java/core/src/main/java/dev/eightlines/gauntlet/core/spi/RunContext.java packages/java/core/src/main/java/dev/eightlines/gauntlet/core/run/RunManager.java packages/java/core/src/test/java/dev/eightlines/gauntlet/core/RunManagerExecutionPolicyTest.java packages/java/core/src/test/java/dev/eightlines/gauntlet/core/RunManagerSafetyTest.java
git commit -m "feat(java): enforce confirmation and propagate dry-run"
```

### Task 17: Spring Boot startup and HTTP envelope gate

**Files:**

- Create: `packages/java/spring-boot-starter/src/main/java/dev/eightlines/gauntlet/spring/GauntletEnvironmentProperties.java`
- Modify: `packages/java/spring-boot-starter/src/main/java/dev/eightlines/gauntlet/spring/GauntletApplicationProperties.java`
- Modify: `packages/java/spring-boot-starter/src/main/java/dev/eightlines/gauntlet/spring/GauntletProperties.java`
- Modify: `packages/java/spring-boot-starter/src/main/java/dev/eightlines/gauntlet/spring/catalog/SpringAdapterCatalog.java`
- Modify: `packages/java/spring-boot-starter/src/main/java/dev/eightlines/gauntlet/spring/http/RequestEnvelopeValidator.java`
- Modify: `packages/java/spring-boot-starter/src/main/resources/META-INF/additional-spring-configuration-metadata.json`
- Modify: `packages/java/spring-boot-starter/src/test/java/dev/eightlines/gauntlet/spring/GauntletPropertiesTest.java`
- Modify: `packages/java/spring-boot-starter/src/test/java/dev/eightlines/gauntlet/spring/ConfigurationMetadataTest.java`
- Modify: `packages/java/spring-boot-starter/src/test/java/dev/eightlines/gauntlet/spring/StableIdempotencySecretTest.java`
- Modify: `packages/java/spring-boot-starter/src/test/java/dev/eightlines/gauntlet/spring/AdapterV1HttpTest.java`
- Modify: `packages/java/spring-boot-starter/src/test/java/dev/eightlines/gauntlet/spring/RawAdapterPrefixFilterTest.java`
- Modify: `packages/java/spring-example/src/main/resources/application.yml`

**Interfaces:**

- Consumes: Java Core `EnvironmentDescriptor`, `EnvironmentKind`, and `ConfirmationAcknowledgement`.
- Produces: nested strict Spring configuration, disabled safe sentinel, and mapped acknowledgement.

- [ ] **Step 1: Add failing configuration binding tests**

```java
assertThatThrownBy(() -> bindEnabled(
    "gauntlet.application.id=fixture",
    "gauntlet.application.label=Fixture",
    "gauntlet.idempotency-secret=fixture-idempotency-secret-32-bytes-long"))
    .hasMessageContaining("environment");

assertThatThrownBy(() -> bindEnabled(
    "gauntlet.application.id=fixture",
    "gauntlet.application.label=Fixture",
    "gauntlet.application.environment.name=fixture-prod",
    "gauntlet.application.environment.kind=test",
    "gauntlet.idempotency-secret=fixture-idempotency-secret-32-bytes-long"))
    .hasMessageContaining("Invalid non-production environment descriptor");
```

Add a disabled context without application/secret and assert canonical 503 for the raw adapter prefix.

- [ ] **Step 2: Add failing HTTP confirmation cases**

For missing and mismatched acknowledgement POST bodies, assert status 422, the exact pointer, and zero fixture-operation mutations. Include `"dryRun": true` in the missing-confirmation case.

- [ ] **Step 3: Run starter tests and observe failures**

Run from `packages/java`:

```bash
./gradlew -DgauntletProtocolFixtures=../protocol/fixtures/v1 :spring-boot-starter:test
```

Expected: FAIL because environment is scalar and confirmation is outside the envelope allow-list.

- [ ] **Step 4: Add exact nested Spring property records**

```java
public record GauntletEnvironmentProperties(String name, String kind) {
  public EnvironmentDescriptor toDescriptor() {
    return new EnvironmentDescriptor(name, EnvironmentKind.fromWireValue(kind));
  }
}
```

```java
public record GauntletApplicationProperties(
    String id,
    String label,
    @NestedConfigurationProperty GauntletEnvironmentProperties environment) {
  public ApplicationMetadata toMetadata() {
    if (environment == null) {
      throw new IllegalArgumentException("enabled adapter requires application environment");
    }
    return new ApplicationMetadata(id, label, environment.toDescriptor(), JsonOwnership.object(Map.of()));
  }
}
```

Keep `kind` as a string until `EnvironmentKind.fromWireValue` so configuration uses the same exact lowercase wire values instead of Spring's permissive enum conversion.

- [ ] **Step 5: Give disabled catalog construction a non-exposed safe sentinel**

```java
private static ApplicationMetadata application(GauntletProperties properties) {
  GauntletApplicationProperties configured = properties.application();
  if (configured != null) return configured.toMetadata();
  if (properties.enabled()) {
    throw new IllegalArgumentException("enabled adapter requires application metadata");
  }
  return new ApplicationMetadata(
      "disabled-adapter",
      "Disabled adapter",
      new EnvironmentDescriptor("disabled-adapter", EnvironmentKind.DEVELOPMENT),
      empty());
}
```

The existing highest-precedence prefix gate must continue returning 503 before any controller can expose this internal manifest.

- [ ] **Step 6: Extend the HTTP envelope validator**

Add `confirmation` to the closed root key set and map it with exact closed member validation:

```java
ConfirmationAcknowledgement confirmation = optionalConfirmation(envelope.get("confirmation"));
return new CreateRunRequest(
    revision,
    input,
    context,
    dryRun,
    idempotencyKey,
    confirmation,
    extensions(envelope, ""));
```

`optionalConfirmation` uses `ProtocolId.require`, exact SHA-256 validation, `OperationImpact.fromWireValue`, and owned extensions.

- [ ] **Step 7: Update configuration metadata and example YAML**

Publish these property names:

```text
gauntlet.application.environment.name
gauntlet.application.environment.kind
```

Use this example:

```yaml
gauntlet:
  enabled: true
  idempotency-secret: spring-example-stable-idempotency-secret
  application:
    id: spring-example
    label: Spring example
    environment:
      name: spring-example-test
      kind: test
```

Ensure `StableIdempotencySecretTest` supplies a valid environment in every enabled case so a missing-secret assertion reaches the intended gate.

- [ ] **Step 8: Run and commit Spring changes**

Run:

```bash
./gradlew -DgauntletProtocolFixtures=../protocol/fixtures/v1 :spring-boot-starter:test :spring-example:bootJar
```

Expected: PASS.

```bash
git add packages/java/spring-boot-starter packages/java/spring-example/src/main/resources/application.yml
git commit -m "feat(spring): fail closed on unsafe adapter configuration"
```

### Task 18: Conformance and example runtime request fixtures

**Files:**

- Modify: `conformance/runner/src/adapter-v1-runner.ts`
- Modify: `conformance/runner/src/fixture-adapter.ts`
- Modify: `conformance/runner/src/extended-runner.ts`
- Modify: `conformance/runner/src/extended-fixture-adapter.ts`
- Modify: `conformance/runner/test/source/adapter-v1-runner.test.ts`
- Modify: `conformance/runner/test/source/fixture-adapter.test.ts`
- Modify: `conformance/runner/test/source/extended-conformance.test.ts`
- Modify: `examples/typescript-fixture/src/index.ts`
- Modify: `examples/typescript-fixture/src/catalog-example.ts`
- Modify: `examples/typescript-fixture/test/extended-catalog.test.ts`
- Modify: `examples/symfony/src/Kernel.php`
- Modify: `examples/symfony/tests/AdapterConformanceTest.php`
- Modify: `examples/symfony/config/reference.php`

**Interfaces:**

- Consumes: structured environments, current operation definitions, and `CreateRunRequest.confirmation` from Tasks 1-4.
- Produces: revision-bound acknowledgement construction in standard and extended conformance requests, including dry-run requests, plus matching fixture-adapter expectations.
- Produces: structured application environments and confirmation-bearing runtime request fixtures in the TypeScript and Symfony examples.
- Ownership boundary: Tasks 2-3 in `docs/superpowers/plans/2026-09-03-dashboard-product-image.md` are the sole owners of `apps/dashboard/src/api.ts`, `apps/dashboard/src/create-run-request.ts`, `apps/dashboard/src/WidokOperacji.tsx`, their tests, and confirmation UI behavior. This task neither edits nor stages `apps/dashboard/`.

- [ ] **Step 1: Add failing conformance request assertions**

```ts
const sentCreateRequest = JSON.parse(new TextDecoder().decode(createCall.body)) as CreateRunRequest;
assert.deepEqual(sentCreateRequest.confirmation, {
  operationId: definition.id,
  operationRevision: definition.revision,
  impact: definition.execution.impact,
});
```

Add equivalent assertions to the standard and extended runner tests. For the stale-revision request, assert that both `operationRevision` and `confirmation.operationRevision` contain the same deliberately stale value, so the adapter retains the required stale-revision `409` ordering. Add one request-construction case with `dryRun: true` and assert it carries the same acknowledgement.

- [ ] **Step 2: Run focused conformance tests and confirm RED**

Run:

```bash
pnpm --filter @8lines/gauntlet-conformance-runner exec tsx --test \
  test/source/adapter-v1-runner.test.ts \
  test/source/fixture-adapter.test.ts \
  test/source/extended-conformance.test.ts
```

Expected: FAIL because create-run requests and fixture expectations omit `confirmation`.

- [ ] **Step 3: Build conformance acknowledgement from the fetched definition**

```ts
function createRequest(
  definition: OperationDefinition,
  operationRevision: string,
  input: JsonObject,
  requestId: string,
  idempotencyKey: string,
  dryRun = false,
): CreateRunRequest {
  const confirmation = definition.execution.confirmationRequired
  ? {
      operationId: definition.id,
      operationRevision,
      impact: definition.execution.impact,
    }
  : undefined;

  return {
    operationRevision,
    input,
    context: {
      requestId,
      target: { id: "conformance-target", environment: "test" },
    },
    dryRun,
    idempotencyKey,
    ...(confirmation === undefined ? {} : { confirmation }),
  };
}
```

Use this shape in `adapter-v1-runner.ts` and the equivalent definition-derived construction in `extended-runner.ts`. Pass the stale revision explicitly for the stale request and the current revision for invalid, fresh, replay, and dry-run requests. Update `fixture-adapter.ts` and `extended-fixture-adapter.ts` to expect the same closed acknowledgement object; do not weaken schema validation to tolerate omitted or extra confirmation members.

- [ ] **Step 4: Update conformance manifests and fixture tests**

Replace scalar application environments in both fixture adapters and their test-owned documents with explicit descriptors:

```ts
application: {
  id: "conformance-adapter",
  label: "Conformance fixture",
  environment: { name: "conformance-fixture-test", kind: "test" },
},
```

Recompute manifest revisions after changing the owned documents. Extend direct fixture test helpers so every otherwise-valid create request supplies definition ID, the exact request revision, and definition impact in `confirmation`. Keep dedicated negative confirmation cases in their SDK-owning tasks rather than adding an acceptance bypass to a fixture.

- [ ] **Step 5: Update TypeScript and Symfony example metadata and requests**

Use explicit environment descriptors:

```ts
application: {
  id: "typescript-fixture",
  label: "TypeScript fixture",
  environment: { name: "typescript-fixture-test", kind: "test" },
}
```

```php
'environment' => ['name' => 'symfony-example-test', 'kind' => 'test'],
```

The Spring example YAML is already updated by Task 17. Regenerate `examples/symfony/config/reference.php` so its generated array shape exposes nested `environment.name` and `environment.kind`.

Update every confirmation-required request fixture in `examples/typescript-fixture/test/extended-catalog.test.ts` and `examples/symfony/tests/AdapterConformanceTest.php`, including invalid-input, failure, replay, and independent-kernel cases. Build each acknowledgement from the same fetched definition used for the request:

```ts
confirmation: {
  operationId: finalize.id,
  operationRevision: finalize.revision,
  impact: finalize.execution.impact,
},
```

```php
'confirmation' => [
    'operationId' => $definition['id'],
    'operationRevision' => $definition['revision'],
    'impact' => $definition['execution']['impact'],
],
```

- [ ] **Step 6: Run conformance and example tests**

Run:

```bash
pnpm --filter @8lines/gauntlet-conformance-runner test
pnpm --filter @8lines/gauntlet-typescript-fixture test
pnpm --filter @8lines/gauntlet-node-example test
pnpm --filter @8lines/gauntlet-next-example test
(cd examples/symfony && vendor/bin/phpunit)
```

Expected: PASS; every confirmation-required conformance/example request, including dry-run, carries current operation identity, request revision, and impact. No dashboard command belongs to this task.

- [ ] **Step 7: Stage only conformance and example changes, then commit**

```bash
git add conformance/runner/src/adapter-v1-runner.ts \
  conformance/runner/src/fixture-adapter.ts \
  conformance/runner/src/extended-runner.ts \
  conformance/runner/src/extended-fixture-adapter.ts \
  conformance/runner/test/source/adapter-v1-runner.test.ts \
  conformance/runner/test/source/fixture-adapter.test.ts \
  conformance/runner/test/source/extended-conformance.test.ts \
  examples/typescript-fixture/src/index.ts \
  examples/typescript-fixture/src/catalog-example.ts \
  examples/typescript-fixture/test/extended-catalog.test.ts \
  examples/symfony/src/Kernel.php \
  examples/symfony/tests/AdapterConformanceTest.php \
  examples/symfony/config/reference.php
git commit -m "test(conformance): send revision-bound confirmations"
```

### Task 19: Cross-language release verification

**Files:**

- Modify only when a command identifies a concrete integration regression; keep the fixing change in the owning task's files.

**Interfaces:**

- Consumes: all preceding tasks, Tasks 1-5 in `docs/superpowers/plans/2026-09-03-control-plane-configuration.md`, dashboard request/UI work from Tasks 2-3 in `docs/superpowers/plans/2026-09-03-dashboard-product-image.md`, and the completed PHP compatibility/matrix work from Task 4 in `docs/superpowers/plans/2026-09-03-private-release-engineering.md`.
- Produces: evidence for acceptance criteria 6-9 and package-consumer compatibility.

- [ ] **Step 1: Run the complete Node workspace verification**

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm test:packages
```

Expected: all commands exit 0.

- [ ] **Step 2: Run the SDK validation entrypoint**

```bash
pnpm validate:sdk
```

Expected: TypeScript package tests and Java Core/Starter/example verification exit 0.

- [ ] **Step 3: Run PHP 8.3 Core and Symfony suites**

After private-release Task 4 has produced the compatibility constraints, locks, and version-selectable image, run inside the repository's PHP 8.3 container/tooling:

```bash
cd packages/php/core
composer install --no-interaction
vendor/bin/phpunit -c phpunit.xml.dist
cd ../symfony-bundle
composer install --no-interaction
vendor/bin/phpunit -c phpunit.xml.dist
cd ../../../examples/symfony
composer install --no-interaction
vendor/bin/phpunit
```

Expected: every command exits 0 on PHP 8.3 with Symfony 7.2-compatible locks.

- [ ] **Step 4: Run Java directly with shared fixtures**

```bash
cd packages/java
./gradlew -DgauntletProtocolFixtures=../protocol/fixtures/v1 :core:check :spring-boot-starter:check :spring-example:bootJar
```

Expected: BUILD SUCCESSFUL on Java 21.

- [ ] **Step 5: Run adapter conformance against all official examples**

Use the repository's example launch commands and then:

```bash
pnpm conformance:adapter-v1
```

Expected: TypeScript Node/Next, Symfony, and Spring adapters pass manifest discovery, definition fetch, confirmed create-run, dry-run propagation, run polling, and supported capability scenarios.

- [ ] **Step 6: Verify the four safety acceptance criteria explicitly**

Record evidence from named tests:

```text
Acceptance 6: server and every SDK reject missing, unsupported, and production-like environment configuration.
Acceptance 7: routes.integration mismatch test proves zero operation/data-source/capability proxy calls.
Acceptance 8: shared destructive vectors plus server/TS/PHP/Java acknowledgement ordering tests pass.
Acceptance 9: TypeScript/PHP/Java mutation-sentinel tests observe dry-run and keep mutation count at zero.
```

- [ ] **Step 7: Inspect repository state before the final verification commit**

```bash
git status --short
git diff --check
```

Expected: no whitespace errors; dirty entries, if any, are understood existing release work rather than silently overwritten files.

- [ ] **Step 8: Commit only concrete fixes produced by verification**

If verification required code changes, stage each owning file explicitly and use:

```bash
git commit -m "fix: close cross-sdk safety regressions"
```

If verification required no changes, do not create an empty commit.

## Completion Conditions

- Protocol manifests cannot represent a missing, unsupported, or production environment.
- The shared helper is exported exactly as `assertNonProductionEnvironment(value): EnvironmentDescriptor`.
- `InvocationContext.target.environment` remains an optional string and is never consulted by a gate.
- Control-plane construction fails without its own safe descriptor.
- Every target contains `expectedEnvironment`, and exact name/kind mismatch blocks every proxy path.
- Every enabled official adapter fails during construction/startup for invalid environment metadata or missing stable secret.
- Destructive semantic rules agree across TypeScript, PHP, and Java through 39 shared document vectors and 100 unique outcomes.
- Confirmation is bound to route operation ID, current revision, and current impact and is checked before admission and replay.
- Confirmation-required dry-run requests require acknowledgement.
- TypeScript, PHP, and Java handlers receive immutable/read-only dry-run state and their mutation sentinels remain at zero.
- Through Task 4 in the private-release plan, PHP packages install and test on PHP 8.3 with Symfony 7.2-compatible dependency resolution.
- Existing dirty server/dashboard work remains present and is merged through selective staging rather than reset or replacement.
