# Protocol and Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the language-neutral protocol packages, TypeScript runtime, validated adapter client, and headless Fastify control plane that can discover and invoke configured targets.

**Architecture:** A pnpm ESM monorepo owns canonical JSON Schema/OpenAPI artifacts. Framework-neutral TypeScript packages implement adapter runtime and client validation, while Fastify exposes a target-oriented control-plane API and isolates unhealthy adapters.

**Tech Stack:** Node.js 24 LTS baseline, pnpm 11.24.0, TypeScript 7.0.2, Fastify 5.12.1, Ajv 8.20.0, ajv-formats 3.0.1, native `node:test` through tsx 4.23.12.

**Spec:** `docs/superpowers/specs/2026-08-29-gauntlet-backend-adapter-architecture-design.md`

## Global Constraints

- No graphical UI is created in this plan.
- JSON payload schemas use JSON Schema Draft 2020-12 with explicit `$schema`.
- OpenAPI uses version 3.2.0.
- Adapter-supplied schemas implement the portable `tc-schema-core@1` subset: Draft 2020-12, explicit `$schema`, fragment-only `$ref`, the documented keyword/format set, RFC 3339 UTC timestamps, and JavaScript-safe JSON integers.
- Canonical protocol schemas may use bundled relative `$ref` values; adapter-supplied schemas reject every non-fragment `$ref`, so validation never performs network I/O.
- Protocol-owned objects are closed with `additionalProperties: false`; forward-compatible optional data lives only in a namespaced `extensions` bag, and new required behavior is declared through versioned profiles/capabilities.
- Protocol `1.x` minor versions are accepted when their required profiles and capabilities are supported; a major mismatch is incompatible.
- IDs used in path segments match `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`; slash, percent, whitespace, query, and fragment characters are invalid rather than transport-encoded.
- Content-derived revisions use RFC 8785 JSON Canonicalization Scheme plus SHA-256 and exclude only their root self-referential `revision` or `manifestRevision` field.
- Adapter payloads are validated before entering control-plane services.
- A broken target never prevents healthy targets from being returned.
- Runtime support is Node.js `>=24 <27`; deployment uses Node 24 LTS.
- Package names use the `@8lines/gauntlet-*` workspace scope.

---

### Task 1: Workspace and Canonical Protocol Artifacts

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `.npmrc`
- Create: `.node-version`
- Create: `packages/protocol/package.json`
- Create: `packages/protocol/tsconfig.json`
- Create: `packages/protocol/src/index.ts`
- Create: `packages/protocol/src/types.ts`
- Create: `packages/protocol/src/identifiers.ts`
- Create: `packages/protocol/src/schema-profile.ts`
- Create: `packages/protocol/src/revision.ts`
- Create: `packages/protocol/schemas/v1/common.schema.json`
- Create: `packages/protocol/schemas/v1/health.schema.json`
- Create: `packages/protocol/schemas/v1/manifest.schema.json`
- Create: `packages/protocol/schemas/v1/operation-definition.schema.json`
- Create: `packages/protocol/schemas/v1/create-run-request.schema.json`
- Create: `packages/protocol/schemas/v1/run.schema.json`
- Create: `packages/protocol/schemas/v1/run-event.schema.json`
- Create: `packages/protocol/schemas/v1/data-source-query.schema.json`
- Create: `packages/protocol/schemas/v1/data-source-page.schema.json`
- Create: `packages/protocol/schemas/v1/data-source-resolve-request.schema.json`
- Create: `packages/protocol/schemas/v1/data-source-resolve-response.schema.json`
- Create: `packages/protocol/schemas/v1/upload.schema.json`
- Create: `packages/protocol/schemas/v1/session-launch.schema.json`
- Create: `packages/protocol/schemas/v1/problem.schema.json`
- Create: `packages/protocol/openapi/adapter-v1.yaml`
- Create: `packages/protocol/fixtures/v1/manifest.valid.json`
- Create: `packages/protocol/fixtures/v1/manifest.minor-forward.valid.json`
- Create: `packages/protocol/fixtures/v1/health.valid.json`
- Create: `packages/protocol/fixtures/v1/operation.valid.json`
- Create: `packages/protocol/fixtures/v1/create-run-request.valid.json`
- Create: `packages/protocol/fixtures/v1/run.queued.valid.json`
- Create: `packages/protocol/fixtures/v1/run.succeeded.valid.json`
- Create: `packages/protocol/fixtures/v1/run.failed.valid.json`
- Create: `packages/protocol/fixtures/v1/run-event.valid.json`
- Create: `packages/protocol/fixtures/v1/data-source-query.valid.json`
- Create: `packages/protocol/fixtures/v1/data-source-page.valid.json`
- Create: `packages/protocol/fixtures/v1/data-source-resolve-request.valid.json`
- Create: `packages/protocol/fixtures/v1/data-source-resolve-response.valid.json`
- Create: `packages/protocol/fixtures/v1/upload-response.valid.json`
- Create: `packages/protocol/fixtures/v1/session-launch.valid.json`
- Create: `packages/protocol/fixtures/v1/problem.valid.json`
- Create: `packages/protocol/fixtures/v1/problem.validation.valid.json`
- Create: `packages/protocol/fixtures/v1/problem.unsupported-capability.valid.json`
- Create: `packages/protocol/fixtures/v1/operation.invalid-remote-ref.json`
- Create: `packages/protocol/fixtures/v1/operation.invalid-unsafe-id.json`
- Create: `packages/protocol/fixtures/v1/operation.invalid-schema-profile.json`
- Create: `packages/protocol/fixtures/v1/manifest.invalid-unknown-property.json`
- Create: `packages/protocol/fixtures/v1/manifest.invalid-major-version.json`
- Create: `packages/protocol/fixtures/v1/run.invalid-active-problem.json`
- Create: `packages/protocol/fixtures/v1/run.invalid-terminal-without-problem.json`
- Test: `packages/protocol/test/schema-files.test.ts`
- Test: `packages/protocol/test/schema-profile.test.ts`
- Test: `packages/protocol/test/revision.test.ts`

**Interfaces:**
- Produces: `AdapterManifest`, standalone `OperationSummary` and `OperationDefinition`, `ProtocolVersion`, `ProtocolRequirements`, `ProtocolExtensions`, `ExecutionPolicy`, `OperationOutput`, `OperationUiSchema`, `OperationPreset`, `InputHandling`, `FileReference`, `Artifact`, `FollowUpAction`, `DataSourceDefinition`, `DataSourceReference`, `CreateRunRequest`, discriminated `Run`, `RunEvent`, the four endpoint-specific data-source request/response types, `UploadResponse`, `SessionLaunchResponse`, `Problem`, `AdapterHealth`, `JsonObject`, and `JsonValue` from `@8lines/gauntlet-protocol`.
- Produces: `PROTOCOL_ID_PATTERN`, `isProtocolId(value)`, `assertTcSchemaCore(schema, options)`, `canonicalizeForRevision(value)`, and `computeRevision(value)` from the same public entrypoint.
- Produces: canonical schema IDs rooted at `https://schemas.8lines.dev/gauntlet/v1/`.
- Consumes: no earlier task.

- [ ] **Step 1: Add workspace metadata and a failing protocol test**

```json
{
  "name": "@8lines/gauntlet-workspace",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.24.0",
  "engines": { "node": ">=24 <27" },
  "scripts": {
    "build": "pnpm -r build",
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test",
    "check": "pnpm typecheck && pnpm test && pnpm build"
  },
  "devDependencies": {
    "@types/node": "24.13.3",
    "tsx": "4.23.12",
    "typescript": "7.0.2"
  }
}
```

```yaml
# pnpm-workspace.yaml
packages:
  - apps/*
  - packages/protocol
  - packages/dashboard-client
  - packages/typescript/*
  - conformance/*
```

```json
// packages/protocol/package.json
{
  "name": "@8lines/gauntlet-protocol",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./schemas/v1/*": "./schemas/v1/*",
    "./fixtures/v1/*": "./fixtures/v1/*",
    "./openapi/*": "./openapi/*"
  },
  "files": ["dist", "schemas", "openapi", "fixtures"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "tsx --test test/**/*.test.ts"
  },
  "dependencies": {
    "ajv": "8.20.0",
    "ajv-formats": "3.0.1",
    "canonicalize": "4.0.0"
  }
}
```

```ts
// packages/protocol/test/schema-files.test.ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const schemaNames = [
  "common", "health", "manifest", "operation-definition", "create-run-request", "run", "run-event",
  "data-source-query", "data-source-page", "data-source-resolve-request", "data-source-resolve-response",
  "upload", "session-launch", "problem",
] as const;

async function validator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  for (const name of schemaNames) {
    const schema = JSON.parse(await readFile(new URL(`../schemas/v1/${name}.schema.json`, import.meta.url), "utf8"));
    ajv.addSchema(schema);
  }
  return ajv;
}

test("every endpoint fixture validates against its own Draft 2020-12 schema", async () => {
  const ajv = await validator();
  const fixtures = [
    ["health", "health"],
    ["manifest", "manifest"],
    ["manifest", "manifest.minor-forward"],
    ["operation-definition", "operation"],
    ["create-run-request", "create-run-request"],
    ["run", "run.queued"],
    ["run", "run.succeeded"],
    ["run", "run.failed"],
    ["run-event", "run-event"],
    ["data-source-query", "data-source-query"],
    ["data-source-page", "data-source-page"],
    ["data-source-resolve-request", "data-source-resolve-request"],
    ["data-source-resolve-response", "data-source-resolve-response"],
    ["upload", "upload-response"],
    ["session-launch", "session-launch"],
    ["problem", "problem"],
    ["problem", "problem.validation"],
    ["problem", "problem.unsupported-capability"],
  ] as const;
  for (const [schemaName, fixtureName] of fixtures) {
    const schema = ajv.getSchema(`https://schemas.8lines.dev/gauntlet/v1/${schemaName}.schema.json`);
    const fixture = JSON.parse(await readFile(new URL(`../fixtures/v1/${fixtureName}.valid.json`, import.meta.url), "utf8"));
    assert.ok(schema, `missing compiled schema ${schemaName}`);
    assert.equal(schema(fixture), true, `${schemaName}: ${JSON.stringify(schema.errors)}`);
  }
});

test("closed core objects reject unsafe IDs, major versions, unknown properties, and invalid run states", async () => {
  const ajv = await validator();
  const invalidFixtures = [
    ["operation-definition", "operation.invalid-unsafe-id"],
    ["manifest", "manifest.invalid-unknown-property"],
    ["manifest", "manifest.invalid-major-version"],
    ["run", "run.invalid-active-problem"],
    ["run", "run.invalid-terminal-without-problem"],
  ] as const;
  for (const [schemaName, fixtureName] of invalidFixtures) {
    const validate = ajv.getSchema(`https://schemas.8lines.dev/gauntlet/v1/${schemaName}.schema.json`);
    const fixture = JSON.parse(await readFile(new URL(`../fixtures/v1/${fixtureName}.json`, import.meta.url), "utf8"));
    assert.ok(validate, `missing compiled schema ${schemaName}`);
    assert.equal(validate(fixture), false, `${fixtureName} unexpectedly passed`);
  }
});

test("all canonical schemas declare Draft 2020-12 and use only bundled refs", async () => {
  for (const name of schemaNames) {
    const text = await readFile(new URL(`../schemas/v1/${name}.schema.json`, import.meta.url), "utf8");
    const schema = JSON.parse(text);
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(/\"\$ref\"\s*:\s*\"https?:\/\//.test(text), false, `${name} contains a network ref`);
  }
});
```

- [ ] **Step 2: Install dependencies and confirm the test fails because the manifest files are absent**

Run: `pnpm install && pnpm --filter @8lines/gauntlet-protocol test`

Expected: FAIL with `ENOENT` naming `packages/protocol/schemas/v1/common.schema.json`, the first file loaded by the test. The package manifest and test runner already exist, so a missing script or package is a plan error rather than the intended RED result.

- [ ] **Step 3: Implement protocol types, schemas, fixtures, and OpenAPI paths**

```ts
// packages/protocol/src/types.ts
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject { readonly [key: string]: JsonValue; }

export type ProtocolVersion = `1.${number}`;
export type ProfileId = `${string}@${number}`;
export type CapabilityId = `${string}@${number}`;
export type ExtensionKey = `urn:${string}`;
export type ProtocolExtensions = Readonly<Record<ExtensionKey, JsonValue>>;
export type ProtocolId = string;
export type JsonPointer = "" | `/${string}`;
export type JsonPointerMap = Readonly<Partial<Record<JsonPointer, JsonValue>>>;
export type Rfc3339Timestamp = string;
export type Sha256Revision = `sha256:${string}`;
export type SchemaDialect = "https://json-schema.org/draft/2020-12/schema";

export interface Extensible { readonly extensions?: ProtocolExtensions; }
export interface JsonSchema extends JsonObject { readonly $schema: SchemaDialect; }
export interface ObjectJsonSchema extends JsonSchema { readonly type: "object"; }

export type RunState = "queued" | "running" | "succeeded" | "failed" | "partial" | "cancelled" | "timed_out" | "expired";
export type TargetState = "online" | "offline" | "incompatible" | "degraded";
export type CoreCapabilityId =
  | "tc-uploads@1"
  | "tc-run-cancellation@1"
  | "tc-run-sse@1"
  | "tc-session-launch@1";

export interface ProtocolRequirements {
  readonly profiles?: readonly ProfileId[];
  readonly capabilities?: readonly CapabilityId[];
}

export interface Problem extends Extensible {
  readonly type: CoreProblemType | `urn:gauntlet:problem:${string}`;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly instance?: string;
  readonly correlationId?: string;
  readonly errors?: readonly ValidationError[];
  readonly capability?: CapabilityId;
}

export type CoreProblemType =
  | "urn:gauntlet:problem:adapter-disabled"
  | "urn:gauntlet:problem:unsupported-capability"
  | "urn:gauntlet:problem:operation-not-found"
  | "urn:gauntlet:problem:run-not-found"
  | "urn:gauntlet:problem:data-source-not-found"
  | "urn:gauntlet:problem:route-not-found"
  | "urn:gauntlet:problem:method-not-allowed"
  | "urn:gauntlet:problem:invalid-json"
  | "urn:gauntlet:problem:invalid-path"
  | "urn:gauntlet:problem:validation-failed"
  | "urn:gauntlet:problem:stale-operation-revision"
  | "urn:gauntlet:problem:handler-failed"
  | "urn:gauntlet:problem:adapter-invalid-response"
  | "urn:gauntlet:problem:adapter-unavailable"
  | "urn:gauntlet:problem:adapter-internal-error";

export interface ValidationError extends Extensible {
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly keyword: string;
  readonly message: string;
  readonly params: JsonObject;
}

export interface AdapterManifest extends Extensible {
  readonly protocolVersion: ProtocolVersion;
  readonly manifestRevision: Sha256Revision;
  readonly schemaDialect: SchemaDialect;
  readonly profiles: readonly ProfileId[];
  readonly capabilities: readonly CapabilityId[];
  readonly application: ApplicationMetadata;
  readonly features: readonly FeatureDefinition[];
  readonly operations: readonly OperationSummary[];
  readonly dataSources: readonly DataSourceDefinition[];
  readonly diagnostics?: readonly AdapterDiagnostic[];
}

export interface AdapterHealth extends Extensible {
  readonly status: "ok";
  readonly protocolVersion: ProtocolVersion;
}

export interface ApplicationMetadata extends Extensible {
  readonly id: ProtocolId;
  readonly label: string;
  readonly environment?: string;
}

export interface FeatureDefinition extends Extensible {
  readonly id: ProtocolId;
  readonly label: string;
  readonly parentId?: ProtocolId;
  readonly order?: number;
}

export interface OperationIdentity {
  readonly id: ProtocolId;
  readonly revision: Sha256Revision;
  readonly label: string;
  readonly featureId: ProtocolId;
}

export interface OperationSummary extends OperationIdentity, Extensible {
  readonly availability:
    | { readonly state: "available" }
    | { readonly state: "unavailable"; readonly problem: Problem };
  readonly requirements?: ProtocolRequirements;
}

export interface AdapterDiagnostic extends Extensible {
  readonly severity: "warning" | "error";
  readonly code: string;
  readonly message: string;
  readonly operationId?: ProtocolId;
}

export interface OperationDefinition extends OperationIdentity, Extensible {
  readonly description?: string;
  readonly icon?: string;
  readonly order: number;
  readonly tags: readonly string[];
  readonly requirements?: ProtocolRequirements;
  readonly inputSchema: ObjectJsonSchema;
  readonly inputHandling?: InputHandling;
  readonly contextSchema?: ObjectJsonSchema;
  readonly uiSchema?: OperationUiSchema;
  readonly dataSources: readonly DataSourceReference[];
  readonly presets: readonly OperationPreset[];
  readonly execution: ExecutionPolicy;
  readonly output: OperationOutput;
}

export interface DataSourceReference extends Extensible {
  readonly id: ProtocolId;
  readonly inputPointer: JsonPointer;
  readonly dependencyPointers: readonly JsonPointer[];
  readonly contextPointers?: readonly JsonPointer[];
  readonly required?: boolean;
}

export interface DataSourceDefinition extends Extensible {
  readonly id: ProtocolId;
  readonly label: string;
  readonly description?: string;
  readonly capabilities: {
    readonly search: boolean;
    readonly pagination: "cursor";
    readonly resolve: true;
    readonly defaultLimit: number;
    readonly maxLimit: number;
  };
  readonly dependencySchema?: ObjectJsonSchema;
  readonly contextSchema?: ObjectJsonSchema;
}

export type CoreWidget =
  | "text" | "textarea" | "integer" | "number" | "toggle"
  | "select" | "multi-select" | "autocomplete"
  | "date" | "date-time" | "duration"
  | "code" | "json" | "secret" | "file";

export type UiCondition =
  | { readonly op: "present"; readonly pointer: JsonPointer }
  | { readonly op: "equals"; readonly pointer: JsonPointer; readonly value: JsonValue }
  | { readonly op: "in"; readonly pointer: JsonPointer; readonly values: readonly JsonValue[] }
  | { readonly op: "all" | "any"; readonly conditions: readonly UiCondition[] }
  | { readonly op: "not"; readonly condition: UiCondition };

export type UiNode =
  | {
      readonly type: "field";
      readonly pointer: JsonPointer;
      readonly widget?: CoreWidget | `urn:${string}`;
      readonly dataSourceId?: ProtocolId;
      readonly label?: string;
      readonly help?: string;
      readonly options?: JsonObject;
      readonly visibleWhen?: UiCondition;
      readonly enabledWhen?: UiCondition;
    }
  | {
      readonly type: "group" | "columns";
      readonly label?: string;
      readonly children: readonly UiNode[];
      readonly visibleWhen?: UiCondition;
    }
  | {
      readonly type: "tabs";
      readonly tabs: readonly { readonly id: ProtocolId; readonly label: string; readonly children: readonly UiNode[] }[];
    };

export interface OperationUiSchema extends Extensible {
  readonly profile: "tc-rich-forms@1";
  readonly root: UiNode;
}

export interface OperationPreset extends Extensible {
  readonly id: ProtocolId;
  readonly label: string;
  readonly description?: string;
  readonly input: JsonObject;
  readonly lockedPointers?: readonly JsonPointer[];
}

export interface FileReference extends Extensible {
  readonly kind: "file";
  readonly uploadId: ProtocolId;
  readonly name: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly sha256?: Sha256Revision;
  readonly expiresAt: Rfc3339Timestamp;
}

export type InputHandlingRule =
  | { readonly kind: "secret"; readonly schemaPointer: JsonPointer; readonly retention: "none" }
  | {
      readonly kind: "file";
      readonly schemaPointer: JsonPointer;
      readonly multiple: boolean;
      readonly mediaTypes?: readonly string[];
      readonly maxBytes?: number;
    };

export interface InputHandling extends Extensible {
  readonly rules: readonly InputHandlingRule[];
}

export interface ExecutionPolicy extends Extensible {
  readonly impact: "read" | "write" | "destructive";
  readonly confirmationRequired: boolean;
  readonly dryRunSupported: boolean;
  readonly idempotency: "none" | "optional" | "required";
  readonly cancellationSupported: boolean;
  readonly timeoutSeconds?: number;
  readonly concurrency?: "allow" | "forbid" | "queue";
}

export interface OperationOutput extends Extensible {
  readonly schema: JsonSchema;
  readonly presentation?: {
    readonly profile: "tc-rich-results@1";
    readonly defaultView?: "summary" | "details" | "artifacts";
  };
}

export interface CreateRunRequest extends Extensible {
  readonly operationRevision: Sha256Revision;
  readonly input: JsonObject;
  readonly context?: InvocationContext;
  readonly dryRun?: boolean;
  readonly idempotencyKey?: string;
}

export interface InvocationContext extends Extensible {
  readonly requestId: ProtocolId;
  readonly locale?: string;
  readonly timeZone?: string;
  readonly actor?: { readonly id: ProtocolId; readonly displayName?: string };
  readonly target?: { readonly id: ProtocolId; readonly environment?: string };
}

export interface RunProgress extends Extensible {
  readonly current?: number;
  readonly total?: number;
  readonly phase?: string;
  readonly message?: string;
  readonly updatedAt: Rfc3339Timestamp;
}

export interface RunSummary extends Extensible {
  readonly title: string;
  readonly message?: string;
  readonly tone: "neutral" | "success" | "warning" | "error";
}

export type FollowUpAction =
  | { readonly kind: "invoke-operation"; readonly label: string; readonly operationId: ProtocolId; readonly input?: JsonObject }
  | { readonly kind: "open-link"; readonly label: string; readonly url: string }
  | { readonly kind: "browser-launch"; readonly label: string; readonly artifactId: ProtocolId };

export interface RunBase extends Extensible {
  readonly id: ProtocolId;
  readonly operationId: ProtocolId;
  readonly operationRevision: Sha256Revision;
  readonly sequence: number;
  readonly createdAt: Rfc3339Timestamp;
  readonly updatedAt: Rfc3339Timestamp;
  readonly startedAt?: Rfc3339Timestamp;
  readonly progress?: RunProgress;
  readonly summary?: RunSummary;
  readonly output?: JsonValue;
  readonly artifacts: readonly Artifact[];
  readonly actions: readonly FollowUpAction[];
}

export type Run =
  | (RunBase & { readonly state: "queued" | "running"; readonly problem?: never; readonly completedAt?: never })
  | (RunBase & { readonly state: "succeeded"; readonly completedAt: Rfc3339Timestamp; readonly problem?: never })
  | (RunBase & {
      readonly state: "failed" | "partial" | "cancelled" | "timed_out" | "expired";
      readonly completedAt: Rfc3339Timestamp;
      readonly problem: Problem;
    });

export interface ArtifactBase extends Extensible {
  readonly id: ProtocolId;
  readonly title?: string;
}

export type Artifact =
  | (ArtifactBase & { readonly kind: "notice"; readonly level: "info" | "success" | "warning" | "error"; readonly message: string })
  | (ArtifactBase & { readonly kind: "metrics"; readonly metrics: readonly { readonly name: string; readonly value: number; readonly unit?: string }[] })
  | (ArtifactBase & { readonly kind: "key-value"; readonly entries: readonly { readonly key: string; readonly label: string; readonly value: JsonValue }[] })
  | (ArtifactBase & { readonly kind: "table"; readonly columns: readonly { readonly key: string; readonly label: string }[]; readonly rows: readonly JsonObject[] })
  | (ArtifactBase & { readonly kind: "json"; readonly value: JsonValue })
  | (ArtifactBase & { readonly kind: "markdown"; readonly markdown: string })
  | (ArtifactBase & { readonly kind: "diff"; readonly format: "unified"; readonly content: string })
  | (ArtifactBase & { readonly kind: "timeline"; readonly items: readonly { readonly timestamp: Rfc3339Timestamp; readonly title: string; readonly description?: string }[] })
  | (ArtifactBase & { readonly kind: "log"; readonly entries: readonly { readonly timestamp?: Rfc3339Timestamp; readonly level: "debug" | "info" | "warning" | "error"; readonly message: string }[] })
  | (ArtifactBase & { readonly kind: "download"; readonly url: string; readonly name: string; readonly mediaType: string; readonly sizeBytes?: number })
  | (ArtifactBase & { readonly kind: "link"; readonly label: string; readonly url: string })
  | (ArtifactBase & { readonly kind: "browser-launch"; readonly label: string })
  | (ArtifactBase & { readonly kind: `urn:${string}`; readonly data: JsonValue });

export interface RunEvent extends Extensible {
  readonly id: ProtocolId;
  readonly sequence: number;
  readonly occurredAt: Rfc3339Timestamp;
  readonly type: "run.updated";
  readonly run: Run;
}

export type DataSourceValue = string;

export interface DataSourceQuery extends Extensible {
  readonly search?: string;
  readonly cursor?: string;
  readonly limit?: number;
  readonly dependencies?: JsonPointerMap;
  readonly context?: InvocationContext;
}

export interface DataSourceItem extends Extensible {
  readonly value: DataSourceValue;
  readonly label: string;
  readonly description?: string;
  readonly group?: string;
  readonly disabled?: boolean;
  readonly metadata?: JsonObject;
}

export interface DataSourcePage extends Extensible {
  readonly items: readonly DataSourceItem[];
  readonly nextCursor?: string;
}

export interface DataSourceResolveRequest extends Extensible {
  readonly values: readonly DataSourceValue[];
  readonly dependencies?: JsonPointerMap;
  readonly context?: InvocationContext;
}

export interface DataSourceResolveResponse extends Extensible {
  readonly results: readonly { readonly value: DataSourceValue; readonly item: DataSourceItem | null }[];
}

export interface UploadResponse extends Extensible {
  readonly file: FileReference;
}

export interface SessionLaunchResponse extends Extensible {
  readonly url: string;
  readonly expiresAt: Rfc3339Timestamp;
  readonly singleUse: true;
}
```

Every protocol-owned object uses `additionalProperties: false`, explicit required fields, and an optional `extensions` object whose property names match `^urn:[A-Za-z0-9][A-Za-z0-9:._/-]*$` and whose values are JSON. A minor release may add optional extension keys but must not add top-level fields or widen closed core enums; required behavior is carried by `requirements.profiles` and `requirements.capabilities`. Manifest and health schemas accept canonical `1.x` strings while the control plane compares the parsed major. Unknown supported capabilities are retained, unknown optional extensions are ignored, and an operation with an unknown requirement is projected as unsupported without changing the adapter-authored availability.

`common.schema.json` defines the portable ID pattern, lowercase `sha256:` digest, RFC 3339 timestamp, safe integer range `[-9007199254740991, 9007199254740991]`, JSON Pointer, extension bag, protocol requirements, and JSON value definitions. Operation schemas require explicit Draft 2020-12 `$schema`; input and context roots require `type: "object"`. `assertTcSchemaCore` recursively allows the `tc-schema-core@1` keyword and format set, accepts only fragment refs beginning with `#`, rejects executable/custom keywords and every absolute or relative external ref, and reports the schema JSON Pointer in its error. The v1 profile fixes `date`, `date-time`, `email`, `hostname`, `ipv4`, `ipv6`, `uri`, and `uuid` format behavior and ECMA-262 Unicode regular-expression semantics. Defaults remain annotations and never mutate input.

`operation-definition.schema.json` models `OperationDefinition` independently from `OperationSummary`; it has no `availability`, `definitionUrl`, or invocation path. It requires `dataSources`, `presets`, `execution`, and `output`; versioned rich-form UI and rich-result presentation remain optional fallbacks over their JSON Schemas. `inputHandling.rules` point to subschemas and give SDK runtime code an enforceable list of no-retention secret fields and opaque uploaded-file fields. Adapter presets containing a value at a secret rule are rejected by semantic validation.

An `invoke-operation` follow-up may carry prefilled input, but SDK semantic validation resolves the referenced local operation and rejects the action if that input contains any value under one of the target operation's secret pointers. Follow-up actions referencing unknown operations are rejected before a Run snapshot is stored.

`operation.valid.json` is intentionally a rich golden fixture rather than a trivial echo: it declares `requirements.profiles: ["tc-schema-core@1", "tc-rich-forms@1", "tc-rich-results@1"]` and upload/session capabilities; an object input with a searchable application ID, text, boolean, nested options, repeated values, one secret, and one `FileReference`; secret/file handling rules; conditional grouped UI; one data-source binding with dependency pointers; a secret-free preset; execution policy; and typed result schema/presentation. `manifest.valid.json` advertises those profiles/capabilities, embeds the referenced `DataSourceDefinition`, and summarizes the operation without a definition URL. `manifest.minor-forward.valid.json` changes only the protocol minor and adds an unknown `urn:fixture:optional` extension, proving that a 1.0 consumer can ignore optional 1.x data.

The four data-source schemas are endpoint-specific rather than a structurally ambiguous root `oneOf`. Resolve responses use `results`, have exactly the same length and order as requested `values`, echo each value, and use `item: null` for an unresolved value; the semantic equality/order check lives beside schema validation. Data-source values are opaque strings so PHP, Java, and JavaScript use identical equality and map-key semantics.

The Run schema is a state-discriminated union: active runs reject `problem` and `completedAt`, success requires `completedAt` and rejects `problem`, and every unsuccessful terminal state requires both. It includes progress, typed summary, schema-validated output, typed artifacts, follow-up actions, and a monotonic sequence. `run-event.schema.json` carries a full Run snapshot so SSE replay is idempotent. `upload.schema.json` defines the JSON response to adapter-owned multipart upload. `session-launch.schema.json` defines a single-use, expiring browser URL minted on demand by `POST /_gauntlet/v1/runs/{runId}/artifacts/{artifactId}/launch`; the dashboard client and control plane never fetch that browser URL.

`canonicalizeForRevision` implements RFC 8785 and rejects non-JSON values, unsafe integers, NaN, and infinities. `computeRevision` removes only the selected root self-referential field (`revision` or `manifestRevision`), canonicalizes the remaining document, hashes UTF-8 bytes with SHA-256, and returns lowercase `sha256:<64 hex>`. The manifest and operation fixtures use those computed values. OpenAPI describes every adapter endpoint from the spec plus session launch, uses the distinct data-source schemas, documents `multipart/form-data` for upload, and references only bundled schema files relatively.

- [ ] **Step 4: Add failing schema-profile and canonical-revision tests**

```ts
// packages/protocol/test/schema-profile.test.ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { assertTcSchemaCore } from "../src/schema-profile.js";

test("tc-schema-core accepts local refs and rejects remote or unsupported behavior", async () => {
  assert.doesNotThrow(() => assertTcSchemaCore({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    $defs: { id: { type: "string" } },
    properties: { id: { $ref: "#/$defs/id" } },
  }, { requireObjectRoot: true }));
  assert.throws(() => assertTcSchemaCore({ $schema: "https://json-schema.org/draft/2020-12/schema", $ref: "https://evil.invalid/schema" }), /non-fragment.*\$ref/i);
  assert.throws(() => assertTcSchemaCore({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", transform: ["trim"] }), /unsupported keyword.*transform/i);

  const remote = JSON.parse(await readFile(new URL("../fixtures/v1/operation.invalid-remote-ref.json", import.meta.url), "utf8"));
  const unsupported = JSON.parse(await readFile(new URL("../fixtures/v1/operation.invalid-schema-profile.json", import.meta.url), "utf8"));
  assert.throws(() => assertTcSchemaCore(remote.inputSchema, { requireObjectRoot: true }), /non-fragment.*\$ref/i);
  assert.throws(() => assertTcSchemaCore(unsupported.inputSchema, { requireObjectRoot: true }), /unsupported keyword/i);
});
```

```ts
// packages/protocol/test/revision.test.ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { canonicalizeForRevision, computeRevision } from "../src/revision.js";

test("RFC 8785 canonicalization is independent of object insertion order", () => {
  assert.equal(canonicalizeForRevision({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(computeRevision({}), "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
});

test("RFC 8785 uses ECMAScript number serialization", () => {
  assert.equal(
    canonicalizeForRevision({ numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 1e-27] }),
    '{"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27]}',
  );
});

test("revision excludes only the root revision and rejects non-portable numbers", () => {
  assert.equal(computeRevision({ revision: `sha256:${"0".repeat(64)}`, a: 1 }), computeRevision({ a: 1 }));
  assert.throws(() => computeRevision({ value: Number.MAX_SAFE_INTEGER + 1 }), /safe integer/i);
  assert.throws(() => computeRevision({ value: Number.NaN }), /finite/i);
});

test("golden operation and manifest revisions match their canonical content", async () => {
  const operation = JSON.parse(await readFile(new URL("../fixtures/v1/operation.valid.json", import.meta.url), "utf8"));
  const manifest = JSON.parse(await readFile(new URL("../fixtures/v1/manifest.valid.json", import.meta.url), "utf8"));
  assert.equal(operation.revision, computeRevision(operation));
  assert.equal(manifest.manifestRevision, computeRevision(manifest, "manifestRevision"));
});
```

Run: `pnpm --filter @8lines/gauntlet-protocol test`

Expected: the fixture/schema tests pass, then the suite fails with `ERR_MODULE_NOT_FOUND` for `src/schema-profile.ts` or `src/revision.ts`; a schema fixture failure at this point means Step 3 is incomplete.

- [ ] **Step 5: Implement the portable schema profile and RFC 8785 revision helpers**

`schema-profile.ts` exports `assertTcSchemaCore(schema: JsonObject, options?: { requireObjectRoot?: boolean }): void`. It walks boolean and object subschemas under every supported applicator, rejects cycles in the JavaScript object graph, checks the root dialect and optional object-root constraint, permits only the documented Draft 2020-12 validation/applicator/annotation keywords, rejects non-fragment `$ref`, and validates every declared `format` against the fixed profile set. Errors include the RFC 6901 pointer to the invalid schema keyword.

`revision.ts` exports these exact functions:

```ts
export function canonicalizeForRevision(value: JsonValue | JsonObject): string;
export function computeRevision(value: JsonObject, revisionField?: "revision" | "manifestRevision"): Sha256Revision;
```

`identifiers.ts` exports `PROTOCOL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/` and `isProtocolId(value: unknown): value is ProtocolId`; schemas and HTTP clients use the same pattern. `canonicalizeForRevision` first walks the value to reject `undefined`, sparse arrays, non-finite values, and integers outside the JavaScript-safe range, then delegates final byte-for-byte JCS serialization to pinned `canonicalize@4.0.0`, the RFC 8785 Appendix G JavaScript implementation. `computeRevision` shallow-copies the root without the selected self-referential field (`revision` by default), hashes the canonical UTF-8 bytes through `node:crypto`, and formats 64 lowercase hexadecimal digits. Step 5 updates the two golden fixtures with the resulting hashes, including `computeRevision(manifest, "manifestRevision")`. Export all three modules from `src/index.ts`.

- [ ] **Step 6: Run protocol tests, typecheck, and build**

Run: `pnpm --filter @8lines/gauntlet-protocol test && pnpm --filter @8lines/gauntlet-protocol typecheck && pnpm --filter @8lines/gauntlet-protocol build`

Expected: all commands exit 0; `packages/protocol/dist/index.js` and declaration files exist; and schemas, OpenAPI, and fixtures remain at the package root so `files` publishes the runtime-validation assets.

- [ ] **Step 7: Commit the protocol foundation**

```bash
git add package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json .npmrc .node-version packages/protocol
git commit -m "feat(protocol): define adapter protocol v1"
```

### Task 2: Framework-Neutral TypeScript Adapter Runtime

**Files:**
- Create: `packages/typescript/core/package.json`
- Create: `packages/typescript/core/tsconfig.json`
- Create: `packages/typescript/core/src/index.ts`
- Create: `packages/typescript/core/src/operation.ts`
- Create: `packages/typescript/core/src/operation-registry.ts`
- Create: `packages/typescript/core/src/run-context.ts`
- Create: `packages/typescript/core/src/run-store.ts`
- Create: `packages/typescript/core/src/in-memory-run-store.ts`
- Create: `packages/typescript/core/src/run-manager.ts`
- Create: `packages/typescript/core/src/problems.ts`
- Test: `packages/typescript/core/test/operation-registry.test.ts`
- Test: `packages/typescript/core/test/run-manager.test.ts`
- Test support: `packages/typescript/core/test/support/operation.ts`

**Interfaces:**
- Consumes: protocol types, `assertTcSchemaCore`, and `computeRevision` from Task 1.
- Produces: `OperationDefinitionDraft`, revision-owning `defineOperation<I>()`, `OperationResult`, `RunContext`, `OperationRegistry`, `InMemoryRunStore`, and `RunManager.create/get`.

- [ ] **Step 1: Create the package manifest and write failing registry tests**

```json
// packages/typescript/core/package.json
{
  "name": "@8lines/gauntlet-typescript-core",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "tsx --test test/**/*.test.ts"
  },
  "dependencies": { "@8lines/gauntlet-protocol": "workspace:*" }
}
```

```ts
import { feature, operation } from "./support/operation.js";

test("registry rejects duplicate operation IDs without replacing the original", () => {
  const registry = new OperationRegistry();
  registry.registerFeature(feature("agency"));
  registry.register(operation("agency.demote"));
  assert.throws(() => registry.register(operation("agency.demote")), /duplicate operation id/i);
  assert.equal(registry.require("agency.demote").definition.label, "First");
});

test("registry rejects an operation whose feature is not registered", () => {
  const registry = new OperationRegistry();
  assert.throws(() => registry.register(operation("agency.demote")), /unknown feature/i);
});

test("defineOperation derives the revision from definition content", () => {
  const first = operation("agency.demote");
  const second = operation("agency.demote", { label: "Changed" });
  assert.match(first.definition.revision, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(first.definition.revision, second.definition.revision);
});
```

`test/support/operation.ts` exports `feature(id: string): FeatureDefinition` and `operation(id: string, overrides?: Partial<OperationDefinitionDraft>): RegisteredOperation<JsonObject>`; `operation` derives `featureId` from the segment before the first `.` and uses the label `"First"`. It passes a revision-free standalone draft to `defineOperation`, without summary-only availability or any transport URL/path: `order: 0`, `tags: []`, explicit Draft 2020-12 object input/context schemas, no input handling or UI, `dataSources: []`, `presets: []`, execution `{ impact: "read", confirmationRequired: false, dryRunSupported: false, idempotency: "optional", cancellationSupported: false }`, and output `{ schema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" } }`. The handler result is `{ summary: { title: "ok", tone: "success" }, output: {}, artifacts: [], actions: [] }`.

- [ ] **Step 2: Run registry tests and verify the missing-module failure**

Run: `pnpm --filter @8lines/gauntlet-typescript-core test`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `packages/typescript/core/src/index.ts` (or its imported registry module). The package test script itself must start successfully.

- [ ] **Step 3: Implement feature and operation registration**

```ts
export type OperationHandler<I extends JsonObject> =
  (input: I, context: RunContext) => OperationResult | Promise<OperationResult>;

export type OperationDefinitionDraft = Omit<OperationDefinition, "revision">;

interface OperationResultPayload {
  readonly summary?: RunSummary;
  readonly output?: JsonValue;
  readonly artifacts?: readonly Artifact[];
  readonly actions?: readonly FollowUpAction[];
}

export type OperationResult =
  | (OperationResultPayload & { readonly outcome?: "succeeded"; readonly problem?: never })
  | (OperationResultPayload & { readonly outcome: "partial"; readonly problem: Problem });

export interface StructuredLogEntry {
  readonly timestamp?: Rfc3339Timestamp;
  readonly level: "debug" | "info" | "warning" | "error";
  readonly message: string;
  readonly fields?: JsonObject;
}

export interface RunContext {
  readonly runId: ProtocolId;
  readonly operationId: ProtocolId;
  readonly signal: AbortSignal;
  report(progress: Omit<RunProgress, "updatedAt">): void;
  addArtifact(artifact: Artifact): void;
  addAction(action: FollowUpAction): void;
  log(entry: StructuredLogEntry): void;
  warn(message: string): void;
  throwIfCancelled(): void;
}

export interface RegisteredOperation<I extends JsonObject = JsonObject> {
  readonly definition: OperationDefinition;
  readonly handler: OperationHandler<I>;
}

export function defineOperation<I extends JsonObject>(
  draft: OperationDefinitionDraft,
  handler: OperationHandler<I>,
): RegisteredOperation<I> {
  assertTcSchemaCore(draft.inputSchema, { requireObjectRoot: true });
  if (draft.contextSchema) assertTcSchemaCore(draft.contextSchema, { requireObjectRoot: true });
  const definition = Object.freeze({
    ...draft,
    revision: computeRevision(draft as unknown as JsonObject),
  });
  return Object.freeze({ definition, handler });
}
```

`defineOperation` owns revision creation; application authors cannot supply or override it. It validates the portable input/context schema profile, derives the RFC 8785 digest from the complete draft, and freezes the resulting definition. `OperationResult` represents either success or an explicit partial result; ordinary failures are thrown and sanitized by the manager. `RunContext.log` stores structured safe fields and never raw exceptions, while `warn` produces a notice without exposing input. The operation registry owns feature definitions, rejects duplicate feature and operation IDs, verifies parent references, and returns stable ID-sorted arrays for manifest generation. The data-source registry and HTTP-free adapter catalog are deliberately created only by Task 1 of `2026-08-29-sdk-foundations.md`, immediately after this task; they consume the canonical resolve request/response types already established here.

- [ ] **Step 4: Write failing run-manager tests**

```ts
test("create rejects a stale operation revision before creating a run", async () => {
  const result = await manager.create("agency.demote", {
    operationRevision: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    input: { applicationId: "a" },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.problem.status, 409);
  assert.equal((await store.all()).length, 0);
});

test("an idempotency key returns the original run", async () => {
  const request = { operationRevision: revision, input: {}, idempotencyKey: "same" };
  const first = await manager.create("test.echo", request);
  const second = await manager.create("test.echo", request);
  assert.equal(first.ok && second.ok && first.run.id, second.ok && second.run.id);
  assert.equal(executionCount, 1);
});

test("idempotency policy rejects forbidden and missing keys", async () => {
  const forbidden = await manager.create("test.none", requestFor("test.none", "not-allowed"));
  const required = await manager.create("test.required", requestFor("test.required"));
  assert.equal(forbidden.ok, false);
  if (!forbidden.ok) assert.equal(forbidden.problem.status, 422);
  assert.equal(required.ok, false);
  if (!required.ok) assert.equal(required.problem.status, 422);
});
```

- [ ] **Step 5: Run run-manager tests and verify failure**

Run: `pnpm --filter @8lines/gauntlet-typescript-core test`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for the run-manager export, after the registry implementation has made the earlier test pass.

- [ ] **Step 6: Implement validation and run lifecycle**

```ts
export interface RunStore {
  create(run: Run, idempotencyKey?: string): Promise<void>;
  get(runId: string): Promise<Run | undefined>;
  findByIdempotencyKey(operationId: string, key: string): Promise<Run | undefined>;
  update(run: Run): Promise<void>;
}

export interface RunManager {
  create(operationId: string, request: CreateRunRequest): Promise<
    | { ok: true; run: Run }
    | { ok: false; problem: Problem }
  >;
  get(runId: string): Promise<Run | undefined>;
}
```

`create` checks operation existence, revision, dry-run support, idempotency mode, the `tc-schema-core@1` input schema, uploaded-file references, and secret-handling rules through injected validators before it stores anything. `none` rejects a supplied key, `optional` accepts an absent key and replays the prior run for a supplied key, and `required` rejects a missing or blank key with a typed 422 Problem. It persists a `queued` Run with `sequence: 0`, `artifacts: []`, and `actions: []`, schedules execution with `queueMicrotask`, increments `sequence` for every immutable `running`, progress, artifact, and terminal snapshot, then stores `succeeded` or a sanitized `failed` Problem with `completedAt`. `RunContext` accepts structured progress, output, typed artifacts, and follow-up actions; secret values are removed before any snapshot, log, validation diagnostic, or idempotency record is persisted.

- [ ] **Step 7: Run the complete core package checks**

Run: `pnpm --filter @8lines/gauntlet-typescript-core test && pnpm --filter @8lines/gauntlet-typescript-core typecheck && pnpm --filter @8lines/gauntlet-typescript-core build`

Expected: all commands exit 0.

- [ ] **Step 8: Commit the TypeScript runtime**

```bash
git add packages/typescript/core pnpm-lock.yaml
git commit -m "feat(ts-sdk): add operation registry and run lifecycle"
```

### Task 3: Validating Backend Adapter Client

**Files:**
- Create: `packages/dashboard-client/package.json`
- Create: `packages/dashboard-client/tsconfig.json`
- Create: `packages/dashboard-client/src/index.ts`
- Create: `packages/dashboard-client/src/adapter-client.ts`
- Create: `packages/dashboard-client/src/protocol-validator.ts`
- Create: `packages/dashboard-client/src/problems.ts`
- Test: `packages/dashboard-client/test/adapter-client.test.ts`
- Test: `packages/dashboard-client/test/protocol-validator.test.ts`
- Test support: `packages/dashboard-client/test/support/fixtures.ts`

**Interfaces:**
- Consumes: Task 1 protocol types and bundled schemas.
- Produces: `createAdapterClient`, `AdapterClient`, `AdapterTarget`, `ClientResult<T>`, and `ManifestFetchResult`.

- [ ] **Step 1: Create the package manifest and write failing client boundary tests**

```json
// packages/dashboard-client/package.json
{
  "name": "@8lines/gauntlet-dashboard-client",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "tsx --test test/**/*.test.ts"
  },
  "dependencies": {
    "@8lines/gauntlet-protocol": "workspace:*",
    "ajv": "8.20.0",
    "ajv-formats": "3.0.1"
  }
}
```

```ts
import { target, validMinorForwardManifest, validOperation, validSessionLaunch } from "./support/fixtures.js";

test("unsafe path IDs are rejected before fetch", async () => {
  let calls = 0;
  const client = createAdapterClient({ fetch: async () => { calls += 1; return Response.json(validOperation); } });
  const result = await client.getOperation(target, "a/b ?c");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.problem.type, "urn:gauntlet:problem:invalid-path");
  assert.equal(calls, 0);
});

test("session launch uses the fixed run artifact route", async () => {
  let requested = "";
  const client = createAdapterClient({ fetch: async (input) => {
    requested = String(input);
    return Response.json(validSessionLaunch);
  }});
  const result = await client.createSessionLaunch(target, "run-1", "launch-1");
  assert.equal(result.ok, true);
  assert.equal(new URL(requested).pathname, "/_gauntlet/v1/runs/run-1/artifacts/launch-1/launch");
});

test("invalid adapter JSON becomes a safe 502 problem", async () => {
  const client = createAdapterClient({ fetch: async () => new Response("not-json") });
  const result = await client.getManifest(target);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.problem.type, "urn:gauntlet:problem:adapter-invalid-response");
});

test("a future 1.x manifest with an unknown optional extension remains valid", async () => {
  const client = createAdapterClient({ fetch: async () => Response.json(validMinorForwardManifest) });
  const result = await client.getManifest(target);
  assert.equal(result.ok, true);
});
```

`test/support/fixtures.ts` exports `target: AdapterTarget` with `id: "fixture-adapter"` and `adapterUrl: "http://adapter.internal"`; a standalone `validOperation: OperationDefinition` generated from the rich canonical fixture with no availability, `definitionUrl`, or invocation path; `validMinorForwardManifest` generated from `manifest.minor-forward.valid.json`; and `validSessionLaunch: SessionLaunchResponse` generated from `session-launch.valid.json`. The operation retains the fixture's explicit object schemas, input handling, versioned UI, data-source bindings, presets, requirements, execution policy, and output contract. It imports types and fixture asset paths from public package entrypoints; no test reaches into `src/` files.

- [ ] **Step 2: Run client tests and verify failure**

Run: `pnpm --filter @8lines/gauntlet-dashboard-client test`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for the dashboard-client entrypoint, not with an undefined fixture or missing test script.

- [ ] **Step 3: Implement schema compilation and the client**

```ts
export type ClientResult<T> =
  | { readonly ok: true; readonly value: T; readonly etag?: string }
  | { readonly ok: false; readonly problem: Problem };

export interface AdapterClient {
  health(target: AdapterTarget): Promise<ClientResult<AdapterHealth>>;
  getManifest(target: AdapterTarget, etag?: string): Promise<ClientResult<ManifestFetchResult>>;
  getOperation(target: AdapterTarget, operationId: string): Promise<ClientResult<OperationDefinition>>;
  createRun(target: AdapterTarget, operationId: string, request: CreateRunRequest): Promise<ClientResult<Run>>;
  getRun(target: AdapterTarget, runId: string): Promise<ClientResult<Run>>;
  queryDataSource(target: AdapterTarget, dataSourceId: string, request: DataSourceQuery): Promise<ClientResult<DataSourcePage>>;
  resolveDataSource(target: AdapterTarget, dataSourceId: string, request: DataSourceResolveRequest): Promise<ClientResult<DataSourceResolveResponse>>;
  createSessionLaunch(target: AdapterTarget, runId: string, artifactId: string): Promise<ClientResult<SessionLaunchResponse>>;
}
```

Ajv compiles only endpoint-specific schemas imported through the protocol package's exported `./schemas/v1/*` asset subpaths, so the client works both inside the workspace and after package publication. Before constructing a fixed adapter path, every target, operation, run, data-source, and artifact ID passes `isProtocolId`; invalid IDs become a safe `invalid-path` Problem without calling Fetch. Because the accepted alphabet is already path-segment-safe, the client appends the validated ID verbatim and never percent-encodes or decodes it; this keeps `:` valid while making every `%` form invalid consistently across proxies and frameworks. The client uses native `fetch`, `AbortSignal.timeout`, and `application/problem+json` parsing. `resolveDataSource` validates the canonical `{ results }` response and verifies equal request/result lengths, order, and echoed values while preserving dependencies and declared context. `createSessionLaunch` validates the response but never follows its browser URL. Network failure maps to 503; malformed, semantically inconsistent, or schema-invalid response maps to 502. No URL/path supplied inside a manifest or operation definition is followed.

- [ ] **Step 4: Run client tests and package checks**

Run: `pnpm --filter @8lines/gauntlet-dashboard-client test && pnpm --filter @8lines/gauntlet-dashboard-client typecheck && pnpm --filter @8lines/gauntlet-dashboard-client build`

Expected: all commands exit 0.

- [ ] **Step 5: Commit the validated client**

```bash
git add packages/dashboard-client pnpm-lock.yaml
git commit -m "feat(client): validate adapter protocol responses"
```

### Task 4: Headless Fastify Control Plane

**Files:**
- Create: `apps/server/package.json`
- Create: `apps/server/tsconfig.json`
- Create: `apps/server/src/main.ts`
- Create: `apps/server/src/app.ts`
- Create: `apps/server/src/config.ts`
- Create: `apps/server/src/problem-response.ts`
- Create: `apps/server/src/target-registry.ts`
- Create: `apps/server/src/target-provider.ts`
- Create: `apps/server/src/static-target-provider.ts`
- Create: `apps/server/src/manifest-service.ts`
- Create: `apps/server/src/run-proxy-service.ts`
- Create: `apps/server/src/gauntlet-store.ts`
- Create: `apps/server/src/in-memory-gauntlet-store.ts`
- Create: `apps/server/src/routes.ts`
- Test: `apps/server/test/static-target-provider.test.ts`
- Test: `apps/server/test/manifest-service.test.ts`
- Test: `apps/server/test/run-proxy-service.test.ts`
- Test: `apps/server/test/routes.integration.test.ts`
- Test support: `apps/server/test/support/fake-adapter.ts`

**Interfaces:**
- Consumes: Task 1 protocol and Task 3 adapter client.
- Produces: `createApp(options)`, `TargetRegistry`, `ManifestService`, and the `/api/v1` control-plane routes.

- [ ] **Step 1: Create the package manifest and write failing static-provider tests**

```json
// apps/server/package.json
{
  "name": "@8lines/gauntlet-server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "tsx --test test/**/*.test.ts"
  },
  "dependencies": {
    "@8lines/gauntlet-dashboard-client": "workspace:*",
    "@8lines/gauntlet-protocol": "workspace:*",
    "fastify": "5.12.1"
  }
}
```

```ts
test("target registry rejects duplicate IDs and normalizes adapter URLs", () => {
  assert.throws(() => createTargetRegistry([createStaticTargetProvider([
    { id: "acme", label: "Acme", adapterUrl: "http://acme:8080" },
    { id: "acme", label: "Again", adapterUrl: "http://other:8080" },
  ])]), /duplicate target id/i);

  const registry = createTargetRegistry([createStaticTargetProvider([
    { id: "acme", label: "Acme", adapterUrl: "http://acme:8080/" },
  ])]);
  assert.equal(registry.require("acme").adapterUrl, "http://acme:8080");
});
```

`test/support/fake-adapter.ts` exports `fakeTarget: StaticTargetConfig` with `publicUrl: "https://app.example.test"`, `validCreateRunRequest: CreateRunRequest`, and `fakeAdapter`, whose injected `fetch` serves valid health, manifest, standalone operation, queued run, endpoint-specific data-source query/resolve, and a session-launch response on the same configured public origin. The fake queued Run includes a `browser-launch` artifact with ID `launch-1`. All values use the Task 1 fixtures/types and public package entrypoints.

- [ ] **Step 2: Run registry tests and verify failure**

Run: `pnpm --filter @8lines/gauntlet-server test`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for the static target provider import. It must not fail because the package has no test script.

- [ ] **Step 3: Implement injected configuration and target registry**

```ts
export interface StaticTargetConfig {
  readonly id: ProtocolId;
  readonly label: string;
  readonly adapterUrl: string;
  readonly publicUrl?: string;
  readonly tags?: readonly string[];
}

export interface TargetRegistry {
  list(): readonly StaticTargetConfig[];
  get(id: string): StaticTargetConfig | undefined;
  require(id: string): StaticTargetConfig;
}

export interface TargetProvider {
  targets(): readonly StaticTargetConfig[];
}

export interface GauntletStore {
  getSnapshot(targetId: string): TargetSnapshot | undefined;
  saveSnapshot(snapshot: TargetSnapshot): void;
  getRun(targetId: string, runId: string): Run | undefined;
  saveRun(targetId: string, run: Run): void;
}

export interface RunProxyService {
  create(targetId: string, operationId: string, request: CreateRunRequest): Promise<ClientResult<Run>>;
  get(targetId: string, runId: string): Promise<ClientResult<Run>>;
  createSessionLaunch(targetId: string, runId: string, artifactId: string): Promise<ClientResult<SessionLaunchResponse>>;
}
```

`createStaticTargetProvider` parses `GAUNTLET_TARGETS_JSON` as an array, rejects unknown keys, unsafe IDs, and invalid absolute HTTP(S) URLs, and never reads dotenv files. `createTargetRegistry(providers)` merges providers in declaration order and rejects duplicate IDs. Tests inject parsed `StaticTargetConfig[]` directly.

- [ ] **Step 4: Write failing target-isolation and ETag-cache tests**

```ts
test("an offline target does not hide an online target", async () => {
  const snapshots = await service.listTargets();
  assert.deepEqual(snapshots.map(({ id, state }) => [id, state]), [
    ["offline", "offline"],
    ["online", "online"],
  ]);
});

test("304 preserves the last validated manifest snapshot", async () => {
  await service.refresh("acme");
  await service.refresh("acme");
  assert.equal(clientManifestCalls[1]?.etag, "\"manifest-1\"");
  assert.equal(service.snapshot("acme")?.manifest?.manifestRevision, validManifest.manifestRevision);
});

test("an unknown operation requirement does not invalidate its target", async () => {
  const snapshot = await service.refresh("future");
  assert.equal(snapshot.state, "online");
  const support = service.checkRequirements({ profiles: ["urn:future-ui@1"] });
  assert.equal(support.ok, false);
  if (!support.ok) assert.equal(support.problem.type, "urn:gauntlet:problem:unsupported-capability");
});
```

- [ ] **Step 5: Implement `ManifestService`**

```ts
export interface TargetSnapshot {
  readonly id: string;
  readonly label: string;
  readonly state: TargetState;
  readonly manifest?: AdapterManifest;
  readonly problem?: Problem;
  readonly refreshedAt: Rfc3339Timestamp;
}

export interface ManifestService {
  listTargets(): Promise<readonly TargetSnapshot[]>;
  checkRequirements(requirements?: ProtocolRequirements):
    | { ok: true }
    | { ok: false; problem: Problem };
  requireCompatibleTarget(id: string): Promise<
    | { ok: true; target: AdapterTarget; manifest: AdapterManifest }
    | { ok: false; problem: Problem }
  >;
}
```

Refreshes use `Promise.allSettled`, stable target order, cached ETag, and last-known-good manifests. A protocol major mismatch is `incompatible`; any `1.x` minor with valid optional extensions remains compatible; health success plus invalid manifest is `degraded`; transport failure is `offline`. `checkRequirements` compares versioned IDs against the control plane's explicit supported profile/capability sets. Unknown operation requirements return a typed unsupported-capability Problem but do not degrade or invalidate the target.

- [ ] **Step 6: Write failing Fastify integration tests**

```ts
test("control plane proxies definition, run creation, polling, and data-source query", async () => {
  const { fakeAdapter, fakeTarget, validCreateRunRequest } = await import("./support/fake-adapter.js");
  const app = await createApp({ targets: [fakeTarget], fetch: fakeAdapter.fetch });
  const targets = await app.inject({ method: "GET", url: "/api/v1/targets" });
  assert.equal(targets.statusCode, 200);

  const created = await app.inject({
    method: "POST",
    url: "/api/v1/targets/acme/operations/agency.finalize/runs",
    payload: validCreateRunRequest,
  });
  assert.equal(created.statusCode, 202);
  assert.equal(created.json().state, "queued");

  const launched = await app.inject({
    method: "POST",
    url: "/api/v1/targets/acme/runs/run-1/artifacts/launch-1/launch",
  });
  assert.equal(launched.statusCode, 200);
  assert.equal(launched.json().singleUse, true);
});
```

- [ ] **Step 7: Implement Fastify app and routes**

```text
GET  /health
GET  /api/v1/targets
GET  /api/v1/targets/:targetId/operations/:operationId
POST /api/v1/targets/:targetId/operations/:operationId/runs
GET  /api/v1/targets/:targetId/runs/:runId
POST /api/v1/targets/:targetId/data-sources/:dataSourceId/query
POST /api/v1/targets/:targetId/data-sources/:dataSourceId/resolve
POST /api/v1/targets/:targetId/runs/:runId/artifacts/:artifactId/launch
```

Every target route first validates every path ID with `isProtocolId` and calls `requireCompatibleTarget`. Definition/run routes also call `checkRequirements` on the summary and fetched definition before invocation; unknown requirements return 501 while other operations on the target remain usable. Run routes delegate to `RunProxyService`, which stores the adapter-owned run projection but never changes its lifecycle. Session launch delegates to the fixed adapter route, requires the referenced projected artifact to have `kind: "browser-launch"`, requires target `publicUrl`, rejects a returned URL whose origin differs from configured `publicUrl`, and returns the validated URL to the browser without fetching it. Adapter problems retain their safe status where appropriate; network and invalid-response problems use 503/502. Fastify error handling returns RFC 9457 and never leaks stack traces in response bodies.

- [ ] **Step 8: Run server tests and all TypeScript checks**

Run: `pnpm --filter @8lines/gauntlet-server test && pnpm check`

Expected: server tests and all workspace checks exit 0.

- [ ] **Step 9: Commit the headless control plane**

```bash
git add apps/server pnpm-lock.yaml package.json
git commit -m "feat(server): add environment target control plane"
```

### Task 5: Deployable Server Image and Black-Box Smoke Test

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `compose.example.yml`
- Create: `conformance/smoke/fake-adapter.mjs`
- Create: `conformance/smoke/control-plane.test.mjs`
- Modify: `package.json`
- Create: `README.md`

**Interfaces:**
- Consumes: built server from Task 4.
- Produces: one Node 24 container and a smoke-test command that exercises server-to-server discovery without a UI.

- [ ] **Step 1: Write the fake adapter, a failing black-box smoke test, and the README skeleton**

```js
// conformance/smoke/fake-adapter.mjs
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const root = new URL("../../", import.meta.url);
const health = await readFile(new URL("packages/protocol/fixtures/v1/health.valid.json", root));
const manifest = await readFile(new URL("packages/protocol/fixtures/v1/manifest.valid.json", root));
const server = createServer((request, response) => {
  const body = request.url === "/_gauntlet/v1/health" ? health
    : request.url === "/_gauntlet/v1/manifest" ? manifest
    : Buffer.from(JSON.stringify({ type: "urn:gauntlet:problem:not-found", title: "Not found", status: 404 }));
  response.writeHead(request.url === "/_gauntlet/v1/health" || request.url === "/_gauntlet/v1/manifest" ? 200 : 404, {
    "content-type": "application/json",
  });
  response.end(body);
});
server.listen(8081, "0.0.0.0");
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close(() => process.exit(0)));
```

```js
// conformance/smoke/control-plane.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

test("a configured environment target is discoverable", async () => {
  const response = await fetch(`${process.env.GAUNTLET_URL}/api/v1/targets`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.targets[0].id, "fixture-adapter");
  assert.equal(body.targets[0].state, "online");
});
```

Extend the root `package.json` scripts created in Task 1 with:

```json
{ "smoke": "node --test conformance/smoke/control-plane.test.mjs" }
```

````md
# Gauntlet

Gauntlet is a headless control plane for non-production application adapters. This repository intentionally contains no graphical dashboard.

## Configuration

Set `GAUNTLET_TARGETS_JSON` to a JSON array. Every item requires `id`, `label`, and an internal `adapterUrl`; `publicUrl` and `tags` are optional.

```sh
GAUNTLET_TARGETS_JSON='[{"id":"acme","label":"Acme Portal","adapterUrl":"http://acme:8080","tags":["symfony"]}]' \
node apps/server/dist/main.js
```

## Container smoke test

```sh
docker compose --project-name gauntlet-smoke -f compose.example.yml up -d --build --wait
GAUNTLET_URL=http://127.0.0.1:8080 pnpm smoke
docker compose --project-name gauntlet-smoke -f compose.example.yml down --volumes
```
````

- [ ] **Step 2: Run the smoke test before the container entrypoint exists**

Run: `GAUNTLET_URL=http://127.0.0.1:8080 pnpm smoke`

Expected: FAIL with `TypeError: fetch failed` whose cause is `ECONNREFUSED 127.0.0.1:8080`; the test has a valid URL and fails solely because the control-plane container is not running.

- [ ] **Step 3: Add the multi-stage Docker image and example Compose topology**

```dockerfile
FROM node:24.20.0-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/server ./apps/server
COPY conformance ./conformance
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @8lines/gauntlet-server... build
RUN pnpm --filter @8lines/gauntlet-server --prod deploy /out

FROM node:24.20.0-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
EXPOSE 8080
CMD ["node", "dist/main.js"]
```

Create `.dockerignore` with exactly these entries so Docker never sends host dependencies, Git state, generated output, or secrets to the build context:

```text
node_modules
**/node_modules
dist
**/dist
.git
.env
.env.*
coverage
```

```yaml
# compose.example.yml
services:
  gauntlet:
    build:
      context: .
      target: runtime
    environment:
      GAUNTLET_TARGETS_JSON: '[{"id":"fixture-adapter","label":"Fixture adapter","adapterUrl":"http://fake-adapter:8081"}]'
    ports: ["8080:8080"]
    networks: [adapter-network]
    depends_on:
      fake-adapter:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "node -e 'fetch(\"http://127.0.0.1:8080/health\").then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))'"]
      interval: 2s
      timeout: 2s
      retries: 15
  fake-adapter:
    build:
      context: .
      target: build
    command: ["node", "conformance/smoke/fake-adapter.mjs"]
    networks: [adapter-network]
    healthcheck:
      test: ["CMD-SHELL", "node -e 'fetch(\"http://127.0.0.1:8081/_gauntlet/v1/health\").then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))'"]
      interval: 2s
      timeout: 2s
      retries: 15
networks:
  adapter-network:
    internal: true
```

- [ ] **Step 4: Build and run the black-box smoke test**

Run: `docker compose --project-name gauntlet-smoke -f compose.example.yml up -d --build --wait && GAUNTLET_URL=http://127.0.0.1:8080 pnpm smoke`

Expected: PASS. Then run `docker compose --project-name gauntlet-smoke -f compose.example.yml down --volumes` to remove only this named example stack.

- [ ] **Step 5: Document headless configuration and commit**

```bash
git add Dockerfile .dockerignore compose.example.yml conformance/smoke README.md package.json
git commit -m "feat: ship deployable headless gauntlet"
```

### Task 6: Language-Neutral Adapter v1 Conformance Runner

**Files:**
- Create: `conformance/runner/package.json`
- Create: `conformance/runner/tsconfig.json`
- Create: `conformance/runner/src/index.ts`
- Create: `conformance/runner/src/cli.ts`
- Create: `conformance/runner/src/adapter-v1-runner.ts`
- Create: `conformance/runner/src/schema-validator.ts`
- Create: `conformance/runner/src/http-client.ts`
- Create: `conformance/runner/src/fixture-adapter.ts`
- Create: `conformance/runner/test/adapter-v1-runner.test.ts`
- Create: `conformance/scenarios/adapter-v1.json`

**Interfaces:**
- Consumes: only the canonical P0 protocol schemas and fixtures from Task 1.
- Produces: the framework- and language-neutral executable `gauntlet-conformance`, a native-HTTP `gauntlet-conformance-fixture` adapter used by its integration test, and the one shared scenario which PHP, Node, and Java SDK plans consume unchanged.

- [ ] **Step 1: Create the complete shared scenario and write failing runner tests against the native fixture adapter**

```json
// conformance/runner/package.json
{
  "name": "@8lines/gauntlet-conformance-runner",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "gauntlet-conformance": "./dist/cli.js",
    "gauntlet-conformance-fixture": "./dist/fixture-adapter.js"
  },
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "tsx --test test/**/*.test.ts"
  },
  "dependencies": {
    "@8lines/gauntlet-protocol": "workspace:*",
    "ajv": "8.20.0",
    "ajv-formats": "3.0.1"
  }
}
```

`conformance/scenarios/adapter-v1.json` is created in this task, not by any SDK plan. It contains exactly these top-level keys: `operationId`, `dataSourceId`, `input`, `invalidInput`, `expectedValidationPointer`, `dataSourceQuery`, `dataSourceResolveRequest`, `idempotencyKey`, `expectedTerminalState`, `requiredProfiles`, `requiredCapabilities`, and optional `browserLaunch`. Its fixed interoperable IDs are `operationId: "agency-applications.finalize"` and `dataSourceId: "pending-applications"`; every SDK reference adapter registers those exact IDs. `operationId`, `dataSourceId`, all run/artifact IDs, and `context.requestId` use the P0 restricted Protocol ID pattern. `dataSourceQuery.dependencies` and `dataSourceResolveRequest.dependencies` use JSON Pointer keys; both request contexts carry `requestId`. The runner uses the transport-safe but pattern-invalid literal `unsafe!id` for its invalid-path case instead of relying on encoded-slash behavior that differs across proxies and frameworks. `browserLaunch`, when present, contains `artifactId` and `expectedPublicOrigin`.

The test starts `gauntlet-conformance-fixture` through native Node HTTP and invokes the CLI with that server's ephemeral base URL and the committed scenario. The fixture returns the rich P0 Manifest, standalone OperationDefinition, endpoint-specific data-source query/resolve responses, and a Run with sequence, timestamps, progress, summary, output, artifacts, and actions. When the scenario contains `browserLaunch`, its created Run includes a `browser-launch` artifact whose restricted ID matches the scenario and its session endpoint returns a single-use URL on the configured public origin.

The initial red tests assert that the runner performs: health; manifest and definition ETag revalidation; requirements compatibility; stale and invalid create-run; idempotent valid create-run; polling; secret non-retention in create/poll/error documents; endpoint-specific query/resolve; unknown operation/data-source/run; an unsafe path ID; all unadvertised optional endpoints; and optional session launch. A second test makes the fixture return an invalid terminal Run and asserts the runner fails with the method, path, expected schema, and JSON Pointer of the violation.

- [ ] **Step 2: Run the isolated test and verify the runner package is absent**

Run: `pnpm --filter @8lines/gauntlet-conformance-runner test`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for the runner entrypoint imported by `adapter-v1-runner.test.ts`; the package manifest and test script from Step 1 already resolve.

- [ ] **Step 3: Implement the schema-validating CLI, fixture adapter, and P0 assertions**

The runner package depends only on `@8lines/gauntlet-protocol`, Ajv 8.20.0, and native Fetch; it imports no PHP, Spring, Next, Fastify, or application package. Its CLI accepts exactly `--base-url <absolute-http-url>` and `--scenario <path>` and rejects unknown flags. It compiles the bundled Draft 2020-12 schemas before making requests, validates every successful JSON document and every Problem document, validates IDs with `isProtocolId` before constructing a request, and redacts secret input values from error output.

The runner obtains the live operation revision from the definition endpoint; it does not hard-code a hash from the scenario. It validates that each manifest/definition requirement is in the scenario's required profile/capability allow-list before executing. It validates the rich Run invariants in addition to JSON Schema: `sequence` is non-negative; timestamps are ordered; a terminal run has `completedAt`; a non-success terminal run has a Problem; progress `current` does not exceed `total`; every artifact/action ID is restricted and unique; and a browser-launch action references a browser-launch artifact in that same Run.

For every target language, the runner asserts these exact interactions: 200 health; 200 manifest followed by 304 using its ETag; 200 definition followed by 304 using its ETag; 409 `stale-operation-revision` for a deliberately altered revision; 422 `validation-failed` containing the scenario pointer; two valid create requests with the same idempotency key yielding the same run ID; no secret value from scenario input in either create response, poll response, validation Problem, or runner failure text; polling to the scenario terminal state; 200 query and resolve documents with endpoint-specific data-source IDs; 404 `operation-not-found`, `data-source-not-found`, and `run-not-found`; 400 `invalid-path` for the transport-safe but pattern-invalid ID `unsafe!id`; and typed 501 `unsupported-capability` Problems for every optional endpoint whose capability is absent from the manifest. When `browserLaunch` is present and `tc-session-launch@1` is advertised, it additionally verifies the fixed session-launch endpoint, `singleUse: true`, and URL origin equal to `expectedPublicOrigin`, without fetching the URL. The runner reports each assertion as `<method> <path>: expected <status/type>, received <status/type>`.

- [ ] **Step 4: Run the full runner against its own fixture adapter**

Run: `pnpm --filter @8lines/gauntlet-conformance-runner test && pnpm --filter @8lines/gauntlet-conformance-runner typecheck && pnpm --filter @8lines/gauntlet-conformance-runner build`

Expected: PASS. The runner test starts and stops the fixture adapter itself, executes the packaged CLI against that fixture, and exercises every mandatory P0 HTTP assertion without PHP, Java, Docker, a framework server, or an SDK-specific test double.

- [ ] **Step 5: Add the workspace validation command and commit the runner**

Add `conformance:adapter-v1` to the root package scripts. It runs the runner with explicit `GAUNTLET_ADAPTER_URL` and `GAUNTLET_SCENARIO` environment variables and fails with a clear message when either is unset. The PHP, Node, and Java plans invoke this command only after their own adapter fixture is running; none of them creates or modifies the shared scenario. Run `pnpm --filter @8lines/gauntlet-conformance-runner typecheck && pnpm --filter @8lines/gauntlet-conformance-runner build && pnpm --filter @8lines/gauntlet-conformance-runner test` before committing.

```bash
git add package.json pnpm-lock.yaml pnpm-workspace.yaml conformance/runner conformance/scenarios/adapter-v1.json
git commit -m "test(conformance): add language-neutral adapter v1 runner"
```
