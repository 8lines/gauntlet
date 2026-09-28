# TypeScript Node, Next, and Java SDK Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver framework-neutral Node and Java adapter foundations, a Next.js Route Handler bridge, and complete v1 HTTP transports that expose only explicitly registered Gauntlet operations and data sources.

**Architecture:** The TypeScript core extends the accepted runtime with schema-validated data sources, shared protocol semantics, and a capability/SPI-aware catalog. The Node package turns that catalog into a WHATWG `Request` → `Response` handler with a highest-priority raw-target gate; the Next package is a very thin catch-all Route Handler bridge. Java is implemented last: a pure Java 21 core ports the already-proven contract, and a Spring Boot starter adapts annotated beans to it without changing wire behavior.

**Tech Stack:** Existing pnpm TypeScript workspace, Node.js `>=24 <27`, TypeScript 7.0.2, Ajv 8.20.0, native Fetch API and `node:test`; Next.js 16.3.3 with React/React DOM 19.2.8 only in the live fixture; Java 21, Gradle Wrapper 9.2.1, Spring Boot 4.1.1, Jackson 3, `com.networknt:json-schema-validator:3.0.4`, Jakarta Validation, Boot-managed JUnit, and Docker image `gradle:9.2.1-jdk21`. Java has no JCS Maven dependency: Task 6 vendors the exact receipt-checked Apache-2.0 `DoubleCoreSerializer.java` and `NumberToJSON.java` reference sources pinned below.

**Spec:** `docs/superpowers/specs/2026-08-29-gauntlet-backend-adapter-architecture-design.md`

## Global Constraints

- The prerequisite order is frozen: accepted shared predicate export
  `6acfafc` and unavailable-operation policy `a0385c3`; accepted semantic
  remediation `1d48d19`; accepted runtime-scalar authority `943dacb`; accepted
  ephemeral invocation-context lease `a658a97`/`0bb090a`
  (`feat(ts-core): expose ephemeral invocation context`); accepted M1 semantic
  vectors `e4cfb4f`/`b2e6212` from
  `.superpowers/sdd/2026-08-29-upstream-remediation/semantic-vectors-brief.md`;
  accepted protocol-control-plane Task 6 using
  `task-6-implementation-brief-v2.md`; accepted PHP Core/Symfony fixture and
  example portal consumer slice; TypeScript Core/native Node/constrained Next and
  both live fixtures; then Java Task 6 source receipt, Java Core, and Spring.
- This plan consumes the public shared predicates
  `manifestSemanticsAreValid`, `operationSemanticsAreValid`, and
  `resolveSemanticsAreValid`, the portable pattern/JCS fixtures, and the one
  unchanged P0 scenario. PHP and Java consume exact
  `adapter-semantic-vectors.json` plus its companion schema and the closed
  generated workload recipes; they do not translate TypeScript tests or fork
  expected matrices.
- Packages are named `@8lines/gauntlet-typescript-node`, `@8lines/gauntlet-next-adapter`, `dev.eightlines.gauntlet:core`, and `dev.eightlines.gauntlet:spring-boot-starter`.
- TypeScript package source is ESM-only and internal imports include `.js` extensions.
- The framework-neutral Node handler accepts WHATWG `Request`/`Response` plus
  an explicit request-target boundary. Native hosts narrow
  `IncomingMessage.url` to a string and pass that untouched origin-form target
  as kind `raw` before constructing a WHATWG URL; absent URL receives a fixed,
  empty generic 400 without dispatch. Parser-rejected request lines are owned
  by a bounded, value-free `clientError` boundary. Frameworks such as Next use
  only kind `trusted-normalized` after a mandatory trusted ingress has enforced
  the original target. The package does not import Fastify, Express, Next,
  Node `http`, or UI code.
- Every adapter route begins with `/_gauntlet/v1`; every dynamic segment first passes the canonical `isProtocolId`/`ProtocolId` check `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`. Percent signs, whitespace, query text, and fragments are rejected rather than decoded into IDs.
- The adapter is disabled by default. Disabled requests return `503 application/problem+json` with type `urn:gauntlet:problem:adapter-disabled`; no operation handler or data-source code is invoked.
- Only registered features, operations, and data sources are addressable. Request data never selects a class, command, SQL statement, route, URL, or arbitrary service.
- JSON payload schemas remain Draft 2020-12 with explicit `$schema`; no remote `$ref` is accepted or resolved.
- Every language exposes a framework-neutral `SchemaValidator` SPI and ships a
  local Draft 2020-12 implementation. It validates envelopes, raw operation
  input/context before binding, pointer-keyed data-source dependencies,
  data-source context, handler output, and data-source responses. Remote and
  relative resource retrieval is disabled; only fragment `$ref` is resolved.
- A manifest declares the exact requirements of every valid operation even
  when unavailable. Invalid bindings are omitted and diagnosed; a diagnostic
  whose operation identity was not safely established omits `operationId`.
- Profiles/capabilities describe implemented adapter behavior. A generic future
  versioned capability is retained only from a registered `CapabilityProvider`;
  a core capability appears only when the exact endpoint SPI is installed. No
  configuration string advertises a capability. Otherwise its fixed route
  returns the exact typed 501 before parsing or run/artifact lookup.
- JSON Problems conform to RFC 9457 and never contain stack traces, exception messages, SQL, credentials, or secret values. Input validation errors use JSON Pointer `instancePath` values.
- `GET /manifest` and `GET /operations/{operationId}` set quoted ETags from RFC 8785/SHA-256 content-derived revisions and honor a matching `If-None-Match` with `304` and no body.
- Mandatory v1 routes are implemented completely: health, manifest, standalone operation definition, create/get run, data-source query, and endpoint-specific data-source resolve. Cancel, events, uploads, and session launch have their canonical fixed routes and return a typed 501 naming `tc-run-cancellation@1`, `tc-run-sse@1`, `tc-uploads@1`, or `tc-session-launch@1` while the implementation does not advertise that capability.
- Polling is mandatory. The accepted TypeScript scheduler makes a fresh create
  active, so it returns 202 and must be polled at least once. A terminal
  idempotent replay returns 201. Java may return 201 when its synchronous
  manager has already reached terminal state, or 202 only while active.
- Java and every durable store mirror the accepted idempotency contract:
  `HMAC-SHA256(secret, "tc-idempotency:v1\0" + operationId + "\0" + key)`
  fingerprints only, stable configured secret,
  atomic queued create plus duplicate reread, exact-sequence compare/update,
  validated reads, and concurrent same-key tests. Raw keys never reach storage
  or logs.
- Every runtime ports the deep secret/file/output/action/store guards and the
  short-lived `invocationContext` lease. Lone surrogates, invalid owned JSON,
  expired/wrong-owner files, target-secret actions, malformed data-source
  responses, and invalid stored Runs fail closed without echoing hostile values.
- Disabled/raw-path enforcement is the first adapter-prefix gate for native
  Node, Symfony, and Spring, before routing and body/multipart parsing. Native
  disabled 503 wins for every confidently classified prefix request, including
  parser-rejected literal whitespace through `clientError`; hostile raw `%`,
  whitespace, query, fragment, extra/trailing segments, and unsafe IDs are
  rejected consistently. A thin Next Route Handler has a deliberately narrower
  contract: mandatory trusted ingress rejects malformed original targets with
  fixed 400 in enabled and disabled upstream modes, while canonical disabled
  requests reaching Next return 503. Host application routes are untouched.
- Java source/production bytecode target is 21. The host has no JDK: every Gradle command in this plan runs through `gradle:9.2.1-jdk21`.
- Spring Boot is exactly `4.1.1`; Gradle Wrapper is exactly `9.2.1`; Java group and package prefix are exactly `dev.eightlines.gauntlet`.
- The Next adapter has no React component, client bundle, CSS, or dashboard dependency.

The HTTP status contract is fixed: health/manifest/definition/poll/query/resolve
are 200; matching strong ETag is a bodyless 304; terminal create is 201 and
active create is 202; cancel accepted is 202; upload/session launch creation is
201; malformed JSON/invalid raw path is 400; safe unknown resource is 404;
known wrong method is 405; stale revision is 409; protocol-invalid JSON is 422;
unadvertised optional capability is 501; disabled prefix is 503. Success uses
`application/json`; Problems use `application/problem+json` with matching HTTP
and body status.

---

### Task 1: Extend the TypeScript Core with Data Sources and an Adapter Catalog

**Files:**
- Modify: `packages/typescript/core/package.json`
- Create: `packages/typescript/core/src/data-source.ts`
- Create: `packages/typescript/core/src/data-source-registry.ts`
- Create: `packages/typescript/core/src/adapter-catalog.ts`
- Create: `packages/typescript/core/src/schema-validator.ts`
- Create: `packages/typescript/core/src/ajv-schema-validator.ts`
- Create: `packages/typescript/core/src/capability-endpoints.ts`
- Create: `packages/typescript/core/src/capability-registry.ts`
- Modify: `packages/typescript/core/src/index.ts`
- Test: `packages/typescript/core/test/data-source-registry.test.ts`
- Test: `packages/typescript/core/test/adapter-catalog.test.ts`
- Test: `packages/typescript/core/test/schema-validator-spi.test.ts`
- Test: `packages/typescript/core/test/capability-registry.test.ts`
- Test: `packages/typescript/core/test/public-consumer.test.ts`
- Test support: `packages/typescript/core/test/support/fixture-catalog.ts`
- Create: `packages/typescript/core/scripts/test-packed-consumer.mjs`

**Interfaces:**
- Consumes without modifying or redefining: canonical protocol wire types,
  `isProtocolId`, `computeRevision`, all three shared semantic predicates,
  `assertTcSchemaCore`, `RunManager`, and `OperationRegistry`.
- Produces: TypeScript-core `SchemaValidator`, `DataSource`,
  `DataSourceRegistry`, `CapabilityProvider`, the four optional endpoint SPIs,
  `CapabilityRegistry`, `AdapterCatalog`, and `createAdapterCatalog`.

- [ ] **Step 1: Write failing data-source registry and catalog tests**

```ts
// packages/typescript/core/test/data-source-registry.test.ts
test("registry keeps the first source when an ID is registered twice", () => {
  const registry = new DataSourceRegistry();
  registry.register(source("applications", "First"));
  assert.throws(() => registry.register(source("applications", "Second")), /duplicate data source id/i);
  assert.equal(registry.require("applications").definition.label, "First");
});

// packages/typescript/core/test/adapter-catalog.test.ts
test("catalog emits stable manifest and definition revisions without handlers", () => {
  const first = createFixtureCatalog().manifest();
  const second = createFixtureCatalog().manifest();
  assert.equal(first.manifestRevision, second.manifestRevision);
  assert.equal(first.operations[0]?.id, "applications.finalize");
  assert.deepEqual(first.dataSources.map(({ id }) => id), ["applications"]);
  assert.equal(first.operations[0]?.availability.state, "unavailable");
  assert.deepEqual(createFixtureCatalog().operation("applications.finalize")?.requirements, {
    profiles: ["tc-schema-core@1", "tc-rich-forms@1", "tc-rich-results@1"],
    capabilities: ["tc-uploads@1", "tc-session-launch@1"],
  });
  assert.deepEqual(createFixtureCatalog().operation("applications.finalize")?.extensions, {
    "urn:fixture:optional": { source: "sdk-foundation" },
  });
  assert.ok(createFixtureCatalog().operation("applications.finalize")?.inputHandling);
  assert.ok(createFixtureCatalog().operation("applications.finalize")?.uiSchema);
  assert.equal(createFixtureCatalog().operation("applications.finalize")?.presets.length, 1);
  assert.equal(createFixtureCatalog().operation("applications.finalize")?.execution.idempotency, "optional");
});

test("resolve delegates only to a registered data source", async () => {
  const catalog = createFixtureCatalog();
  const result = await catalog.resolveDataSource("applications", {
    values: ["app-1", "missing"],
    dependencies: { "/region": "pl" },
    context: { requestId: "request-1" },
  });
  assert.deepEqual(result.results, [
    { value: "app-1", item: { value: "app-1", label: "Application 1" } },
    { value: "missing", item: null },
  ]);
  await assert.rejects(
    () => catalog.resolveDataSource("unknown", { values: [] }),
    /unknown data source/i,
  );
});
```

`test/support/fixture-catalog.ts` is test-only and exports `source(id, label)`,
`createFixtureCatalog()`, and the fixed `applications.finalize` operation used
by both test files. Its standalone operation reproduces the canonical rich
shape: requirements, Draft 2020-12 input/context/output schemas,
`inputHandling`, conditional `uiSchema`, one pointer-bound data source, one
secret-free preset, full execution policy with `idempotency: "optional"`, and
rich-result presentation. Its manifest has the registered data-source
definition. Production exports never include these helpers.

- [ ] **Step 2: Run the new tests and verify the expected missing-export failure**

Run: `pnpm --filter @8lines/gauntlet-typescript-core exec tsx --test test/data-source-registry.test.ts test/adapter-catalog.test.ts`

Expected: FAIL because `DataSourceRegistry` and `createAdapterCatalog` do not exist; canonical protocol request/response types already compile.

- [ ] **Step 3: Add only the pure-core contracts**

```ts
// packages/typescript/core/src/data-source.ts
export interface DataSource {
  readonly definition: DataSourceDefinition;
  query(request: DataSourceQuery): DataSourcePage | Promise<DataSourcePage>;
  resolve(request: DataSourceResolveRequest):
    | DataSourceResolveResponse
    | Promise<DataSourceResolveResponse>;
}

export interface SchemaValidator {
  validate(schema: JsonObject, instance: JsonValue):
    readonly ValidationError[] | Promise<readonly ValidationError[]>;
}

export interface CapabilityProvider {
  readonly id: CapabilityId;
}

export interface RunCancellationEndpoint {
  cancel(runId: ProtocolId): Run | Promise<Run>;
}
export interface RunEventsEndpoint {
  events(runId: ProtocolId, lastEventId?: string): AsyncIterable<RunEvent>;
}
export interface UploadEndpoint {
  create(file: Blob): UploadResponse | Promise<UploadResponse>;
}
export interface SessionLaunchEndpoint {
  create(runId: ProtocolId, artifactId: ProtocolId):
    SessionLaunchResponse | Promise<SessionLaunchResponse>;
}

export type CapabilityDispatch<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problem: Problem };

export type CapabilityAvailability =
  | { readonly supported: true }
  | { readonly supported: false; readonly problem: Problem };

export interface AdapterCatalog {
  health(): AdapterHealth;
  manifest(): AdapterManifest;
  operation(operationId: string): OperationDefinition | undefined;
  createRun(operationId: string, request: CreateRunRequest): ReturnType<RunManager["create"]>;
  run(runId: string): Promise<Run | undefined>;
  queryDataSource(dataSourceId: string, request: DataSourceQuery): Promise<DataSourcePage>;
  resolveDataSource(
    dataSourceId: string,
    request: DataSourceResolveRequest,
  ): Promise<DataSourceResolveResponse>;
  capabilityAvailability(capability: CoreCapabilityId): CapabilityAvailability;
  cancelRun(runId: ProtocolId): Promise<CapabilityDispatch<Run>>;
  runEvents(runId: ProtocolId, lastEventId?: string):
    Promise<CapabilityDispatch<AsyncIterable<RunEvent>>>;
  createUpload(file: Blob): Promise<CapabilityDispatch<UploadResponse>>;
  launchSession(runId: ProtocolId, artifactId: ProtocolId):
    Promise<CapabilityDispatch<SessionLaunchResponse>>;
}

export function createAdapterCatalog(options: {
  readonly application: ApplicationMetadata;
  readonly profiles: readonly ProfileId[];
  readonly capabilities: CapabilityRegistry;
  readonly operations: OperationRegistry;
  readonly dataSources: DataSourceRegistry;
  readonly runs: RunManager;
  readonly schemaValidator: SchemaValidator;
  readonly now?: () => string;
}): AdapterCatalog;

export class AjvSchemaValidator implements SchemaValidator {
  validate(schema: JsonObject, instance: JsonValue):
    readonly ValidationError[] | Promise<readonly ValidationError[]>;
}

export function createAjvSchemaValidator(): SchemaValidator;
```

`DataSourceRegistry` uses a `Map<ProtocolId, DataSource>`, accepts only IDs for
which `isProtocolId` returns true, rejects duplicates, and returns ID-sorted
definitions. `CapabilityRegistry` accepts at most one implementation of each
exact SPI and derives the four core capability IDs from those implementations.
A future non-core ID requires exactly one registered `CapabilityProvider`; a
generic provider cannot claim a core ID, and no bare string registration API
exists. `capability-registry.test.ts` covers absent/duplicate endpoint SPIs,
generic-provider core-ID rejection, and one retained future non-core ID.

The four public dispatch methods are the only optional-SPI invocation path.
`capabilityAvailability` is the public read-only preflight before multipart
parsing or run/artifact lookup; every dispatch independently rechecks support.
Tests cover installed and absent forms of all four with no hidden catalog cast.
`AjvSchemaValidator` is exported from Core, first applies
`assertTcSchemaCore`, uses Ajv Draft 2020-12 with frozen formats and no
`loadSchema`, coercion, defaults, mutation, or remote retrieval, and returns
deeply owned safe normalized errors.

`createAdapterCatalog` takes no HTTP objects and computes one deeply frozen
operation-summary index used by both `manifest()` and `createRun()`. An unknown
ID retains the operation-not-found result; an unavailable summary returns its
exact Problem before schema/file validation, scheduler, store, or handler; an
available summary delegates to `RunManager.create()`. Missing-profile,
missing-core-SPI, and available counter-tests prove the gate and exact Problem
identity. It creates standalone summaries
without transport fields, includes all valid `DataSourceDefinition` values in
`manifest.dataSources`, and projects an operation with unmet
profile/capability requirements as unavailable while preserving all declared
requirements. A malformed binding is omitted with a safe diagnostic; when its
ID cannot be trusted the diagnostic has no `operationId`. It reuses the
revision already owned by `defineOperation` and computes only
`manifestRevision` with protocol `computeRevision`; it never recomputes an
operation revision from a second representation. Both definition and final
manifest pass the shared semantic predicates.

Before invoking a data source the catalog deep-owns and validates the canonical
query/resolve envelope, complete pointer-keyed dependencies and raw context
against declared schemas. Returned pages and resolve responses are closed,
secret-safe canonical values; resolve also passes `resolveSemanticsAreValid`,
including empty values, empty-string values, exact length/order, echoed value,
and nullable item. `SchemaValidator` never retrieves a remote or relative ref.
This task does not edit protocol types, schemas, OpenAPI, or fixtures.

- [ ] **Step 4: Run core, protocol, and packed-consumer checks**

Run: `pnpm --filter @8lines/gauntlet-protocol test && pnpm --filter @8lines/gauntlet-typescript-core test && pnpm --filter @8lines/gauntlet-typescript-core typecheck && pnpm --filter @8lines/gauntlet-typescript-core test:package`

Expected: all commands exit 0; the catalog never exposes handlers or arbitrary URLs in its serialized manifest.

`test:package` removes only exact Protocol/Core `dist` directories, rebuilds
both, packs exactly one tarball each, verifies shipped public JS/declarations,
installs the exact tarballs into a unique temporary ESM consumer with
`pnpm --offline --ignore-scripts`, imports Core only by package name from that
consumer's `node_modules`, exercises validation and manifest creation, and
cleans up on success/failure. A stale worktree `dist`, relative import, or
workspace symlink cannot make this external-consumer gate pass.

- [ ] **Step 5: Commit the core catalog extension**

```bash
git add packages/typescript/core pnpm-lock.yaml
git commit -m "feat(ts-core): add data sources and adapter catalog"
```

### Task 2: Add the Framework-Neutral TypeScript Node HTTP Adapter

**Files:**
- Create: `packages/typescript/node/package.json`
- Create: `packages/typescript/node/tsconfig.json`
- Create: `packages/typescript/node/src/index.ts`
- Create: `packages/typescript/node/src/adapter-handler.ts`
- Create: `packages/typescript/node/src/path.ts`
- Create: `packages/typescript/node/src/json.ts`
- Create: `packages/typescript/node/src/problems.ts`
- Test: `packages/typescript/node/test/path.test.ts`
- Test: `packages/typescript/node/test/adapter-handler.test.ts`
- Test support: `packages/typescript/node/test/support/fixture-catalog.ts`

**Interfaces:**
- Consumes: `AdapterCatalog` from Task 1 and protocol types/Problems.
- Produces: a framework-free `AdapterFetchHandler` and `createAdapterFetchHandler()`.

- [ ] **Step 1: Add package metadata and write failing boundary tests**

```json
{
  "name": "@8lines/gauntlet-typescript-node",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "files": ["dist", "README.md"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "tsx --test test/**/*.test.ts"
  },
  "dependencies": {
    "@8lines/gauntlet-protocol": "workspace:*",
    "@8lines/gauntlet-typescript-core": "workspace:*"
  }
}
```

```ts
// packages/typescript/node/test/path.test.ts
test("accepts safe protocol IDs and rejects non-protocol dynamic IDs", () => {
  assert.deepEqual(parseAdapterPath("/_gauntlet/v1/operations/applications.finalize/runs"),
    ["operations", "applications.finalize", "runs"]);
  assert.equal(parseAdapterPath("/_gauntlet/v1/operations/bad$id/runs"), undefined);
  assert.equal(parseAdapterPath("/_gauntlet/v1/operations/a/b/runs"), undefined);
});

// packages/typescript/node/test/adapter-handler.test.ts
test("disabled adapter returns a typed 503 without reading the catalog", async () => {
  const response = await createAdapterFetchHandler({ enabled: false, catalog: throwingCatalog })(
    request("GET", "/_gauntlet/v1/manifest"),
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("content-type"), "application/problem+json; charset=utf-8");
  assert.equal((await response.json()).type, "urn:gauntlet:problem:adapter-disabled");
});

test("disabled prefix wins over hostile raw target and malformed body", async () => {
  const handler = createAdapterFetchHandler({ enabled: false, catalog: throwingCatalog });
  for (const request of [
    boundary("GET", "/_gauntlet/v1/operations/unsafe%21id"),
    boundary("POST", "/_gauntlet/v1/uploads?bad=1", "{bad"),
  ]) {
    const response = await handler(request);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).type, "urn:gauntlet:problem:adapter-disabled");
  }
});

test("manifest emits a quoted ETag and returns 304 for its exact validator", async () => {
  const handler = createAdapterFetchHandler({ enabled: true, catalog: fixtureCatalog });
  const first = await handler(request("GET", "/_gauntlet/v1/manifest"));
  const etag = first.headers.get("etag");
  const second = await handler(boundary("GET", "/_gauntlet/v1/manifest", undefined, {
    headers: { "if-none-match": etag! },
  }));
  assert.equal(first.status, 200);
  assert.equal(second.status, 304);
  assert.equal(await second.text(), "");
  assert.equal(second.headers.get("content-type"), null);
  assert.equal(second.headers.get("etag"), etag);
});
```

`test/support/fixture-catalog.ts` exports only test fixtures: `fixtureCatalog`,
`throwingCatalog`, `fixtureRevision`,
`boundary(method, rawTarget, body?, init?)`, and its `request(...)` raw-boundary
alias. This
HTTP fixture is deliberately executable: its `applications.finalize`
operation requires only `tc-schema-core@1`, the catalog advertises that
profile, and neither side advertises or requires an optional capability. It
therefore differs from Task 1's deliberately unavailable rich compatibility
fixture while retaining a multi-field object schema, ordered resolve results,
rich terminal Run, and `idempotency: "optional"`. The helper creates a WHATWG
`Request` under `http://adapter` with `application/json` when a body is given,
then returns `{ kind: "raw", request, rawTarget }` without deriving the target
back from the normalized URL.

- [ ] **Step 2: Install workspace links and confirm red tests**

Run: `pnpm install && pnpm --filter @8lines/gauntlet-typescript-node test`

Expected: FAIL because the Node package exports and route parser are absent.

- [ ] **Step 3: Implement parsing, JSON boundaries, Problems, and the handler contract**

```ts
// packages/typescript/node/src/adapter-handler.ts
export type AdapterRequestBoundary =
  | { readonly kind: "raw"; readonly request: Request; readonly rawTarget: string }
  | {
      readonly kind: "trusted-normalized";
      readonly request: Request;
      readonly normalizedTarget: string;
    };

export type AdapterFetchHandler =
  (boundary: AdapterRequestBoundary) => Promise<Response>;

export interface AdapterFetchHandlerOptions {
  readonly enabled?: boolean;
  readonly catalog: AdapterCatalog;
  readonly schemaValidator?: SchemaValidator;
  readonly now?: () => string;
}

export function createAdapterFetchHandler(
  options: AdapterFetchHandlerOptions,
): AdapterFetchHandler;

// packages/typescript/node/src/index.ts
export { createAdapterFetchHandler } from "./adapter-handler.js";
export type {
  AdapterFetchHandler,
  AdapterFetchHandlerOptions,
  AdapterRequestBoundary,
} from "./adapter-handler.js";

// packages/typescript/node/src/path.ts
export function parseAdapterPath(pathname: string): readonly string[] | undefined;

// packages/typescript/node/src/json.ts
export async function readJsonObject(request: Request): Promise<
  | { readonly ok: true; readonly value: JsonObject }
  | { readonly ok: false; readonly problem: Problem }
>;
```

Before constructing `URL` or parsing a body, the `raw` branch checks the
untouched origin-form `rawTarget` supplied by the native host. For the prefix
it first applies the disabled gate, then rejects raw `%`, whitespace,
query/fragment, empty/trailing/extra segments, and unsafe IDs.
`parseAdapterPath` recognizes only fixed v1 route
grammars; literal words match exactly and every dynamic segment passes
`isProtocolId`. It never calls `decodeURIComponent`. A known path with a wrong
method is typed 405; another safe prefix path is typed 404. Integrations mount
the handler only on `/_gauntlet/v1/*`; the Node README and real fixtures
prove a host route bypasses it unchanged. A `trusted-normalized` boundary is
used only after a framework/proxy has normalized the target; it checks what is
still observable but cannot claim recovery of dot segments, slash/backslash
normalization, or other lost syntax. A test makes `request.url` look canonical
while `rawTarget` contains a dot segment and requires the raw target to win.
The raw matrix covers dot segments, backslash, repeated slash, encoded
separator/percent, query, whitespace, trailing/extra segments, unsafe IDs, and
disabled precedence.

`readJsonObject` bounds the body, requires `application/json` or
`application/*+json`, decodes UTF-8 fatally, deep-owns a closed object, returns
415 for another media type, 400 `invalid-json` for fatal UTF-8/JSON syntax,
and 422 `validation-failed` for valid `[]`, `null`, strings, and other scalar
roots; it never inserts parser text in `detail`. Node consumes Core's public
`createAjvSchemaValidator`. `problems.ts` exports
`jsonResponse(value, status, headers?)` and `problemResponse(problem)` with
exact media types. The top-level handler catches unexpected errors and returns
a generic 500 `adapter-internal-error` with a generated correlation ID.

- [ ] **Step 4: Run handler boundary tests and package checks**

Run: `pnpm --filter @8lines/gauntlet-typescript-node test && pnpm --filter @8lines/gauntlet-typescript-node typecheck && pnpm --filter @8lines/gauntlet-typescript-node build`

Expected: all commands exit 0 and importing the built package requires neither a running server nor a framework package.

- [ ] **Step 5: Commit the framework-free transport shell**

```bash
git add packages/typescript/node pnpm-lock.yaml
git commit -m "feat(ts-node): add web request adapter handler"
```

### Task 3: Complete Every TypeScript Node v1 Route and Capability Response

**Files:**
- Modify: `packages/typescript/node/src/adapter-handler.ts`
- Modify: `packages/typescript/node/src/json.ts`
- Modify: `packages/typescript/node/src/problems.ts`
- Modify: `packages/typescript/node/test/adapter-handler.test.ts`
- Create: `packages/typescript/node/test/adapter-v1-routes.test.ts`

**Interfaces:**
- Consumes: Task 2 handler utilities and Task 1 `AdapterCatalog` methods.
- Produces: all seven mandatory paths plus the four canonical optional capability paths, with deterministic status, headers, and Problem mapping.

- [ ] **Step 1: Write the complete failing v1 transport tests**

```ts
// packages/typescript/node/test/adapter-v1-routes.test.ts
async function pollTerminal(handler: AdapterFetchHandler, runId: string): Promise<Run> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await handler(request("GET", `/_gauntlet/v1/runs/${runId}`));
    assert.equal(response.status, 200);
    const run = await response.json() as Run;
    if (!["queued", "running"].includes(run.state)) return run;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("fixture run did not become terminal");
}

test("definition, create-run, polling, query, and resolve use only safe catalog IDs", async () => {
  const handler = createAdapterFetchHandler({ enabled: true, catalog: fixtureCatalog });
  assert.equal((await handler(request("GET", "/_gauntlet/v1/health"))).status, 200);
  assert.equal((await handler(request("GET", "/_gauntlet/v1/operations/applications.finalize"))).status, 200);

  const created = await handler(request("POST", "/_gauntlet/v1/operations/applications.finalize/runs", {
    operationRevision: fixtureRevision,
    input: { applicationId: "app-1" },
    context: { requestId: "request-1" },
    dryRun: false,
    idempotencyKey: "node-route-create-1",
  }));
  assert.equal(created.status, 202);
  const run = await created.json();
  assert.ok(run.state === "queued" || run.state === "running");
  const terminal = await pollTerminal(handler, run.id);
  assert.equal(terminal.state, "succeeded");
  const replay = await handler(request("POST", "/_gauntlet/v1/operations/applications.finalize/runs", {
    operationRevision: fixtureRevision,
    input: { applicationId: "app-1" },
    context: { requestId: "request-1" },
    dryRun: false,
    idempotencyKey: "node-route-create-1",
  }));
  assert.equal(replay.status, 201);
  assert.equal((await replay.json()).id, run.id);

  assert.equal((await handler(request("POST", "/_gauntlet/v1/data-sources/applications/query", {
    search: "Brown", limit: 20,
    dependencies: { "/region": "pl" },
    context: { requestId: "request-2" },
  }))).status, 200);
  const resolved = await handler(request("POST", "/_gauntlet/v1/data-sources/applications/resolve", {
    values: ["app-1", "missing"],
    dependencies: { "/region": "pl" },
    context: { requestId: "request-3" },
  }));
  assert.equal(resolved.status, 200);
  assert.deepEqual((await resolved.json()).results, [
    { value: "app-1", item: { value: "app-1", label: "Application 1" } },
    { value: "missing", item: null },
  ]);
});

test("unknown identifiers and stale revisions return safe typed problems", async () => {
  const handler = createAdapterFetchHandler({ enabled: true, catalog: fixtureCatalog });
  const unknown = await handler(request("GET", "/_gauntlet/v1/operations/nope"));
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).type, "urn:gauntlet:problem:operation-not-found");

  const stale = await handler(request("POST", "/_gauntlet/v1/operations/applications.finalize/runs", {
    operationRevision: `sha256:${"f".repeat(64)}`, input: {}, dryRun: false,
  }));
  assert.equal(stale.status, 409);

  const unsafe = await handler(request("GET", "/_gauntlet/v1/operations/bad$id"));
  assert.equal(unsafe.status, 400);
  assert.equal((await unsafe.json()).type, "urn:gauntlet:problem:invalid-path");
});

for (const { method, url, capability } of [
  { method: "POST", url: "/_gauntlet/v1/runs/run-1/cancel", capability: "tc-run-cancellation@1" },
  { method: "GET", url: "/_gauntlet/v1/runs/run-1/events", capability: "tc-run-sse@1" },
  { method: "POST", url: "/_gauntlet/v1/uploads", capability: "tc-uploads@1" },
  { method: "POST", url: "/_gauntlet/v1/runs/run-1/artifacts/launch-1/launch", capability: "tc-session-launch@1" },
] as const) test(`${method} ${url} is a typed unsupported capability`, async () => {
  const response = await createAdapterFetchHandler({ enabled: true, catalog: fixtureCatalog })(request(method, url));
  assert.equal(response.status, 501);
  const problem = await response.json();
  assert.equal(problem.type, "urn:gauntlet:problem:unsupported-capability");
  assert.equal(problem.capability, capability);
});
```

- [ ] **Step 2: Run the route test suite and verify it is red**

Run: `pnpm --filter @8lines/gauntlet-typescript-node exec tsx --test test/adapter-v1-routes.test.ts`

Expected: FAIL because only the transport shell exists and none of the required dispatch paths return their protocol responses.

- [ ] **Step 3: Implement exact route dispatch and response mapping**

```text
GET  /_gauntlet/v1/health
GET  /_gauntlet/v1/manifest
GET  /_gauntlet/v1/operations/:operationId
POST /_gauntlet/v1/operations/:operationId/runs
GET  /_gauntlet/v1/runs/:runId
POST /_gauntlet/v1/data-sources/:dataSourceId/query
POST /_gauntlet/v1/data-sources/:dataSourceId/resolve
POST /_gauntlet/v1/runs/:runId/cancel
GET  /_gauntlet/v1/runs/:runId/events
POST /_gauntlet/v1/uploads
POST /_gauntlet/v1/runs/:runId/artifacts/:artifactId/launch
```

```ts
function unsupportedCapability(capability: CoreCapabilityId): Response {
  return problemResponse({
    type: "urn:gauntlet:problem:unsupported-capability",
    title: "Unsupported capability",
    status: 501,
    detail: "The adapter does not advertise or implement this capability.",
    capability,
  });
}

function statusForCreatedRun(run: Run): 201 | 202 {
  return ["succeeded", "failed", "partial", "cancelled", "timed_out", "expired"].includes(run.state)
    ? 201
    : 202;
}
```

`GET /health` returns the catalog health document. Manifest and definition use `"${revision}"` ETags. An absent operation, run, or data source returns respectively `operation-not-found`, `run-not-found`, or `data-source-not-found` with 404. `RunManager.create()` Problems retain their protocol status: stale revision is 409 and input validation is 422 with normalized errors. `POST /runs` accepts only canonical `CreateRunRequest`; query accepts `DataSourceQuery`; resolve accepts `DataSourceResolveRequest` and emits `DataSourceResolveResponse.results` with string values, identical length/order, echoed values, and nullable items. The optional routes return 501 with the exact canonical capability ID when that capability is not advertised and implemented; session launch never follows or proxies a browser URL. Unsupported endpoint methods return a typed 405 `method-not-allowed` and all unmatched paths return typed 404 `route-not-found`.

A fresh TypeScript create must return the queued/running snapshot as 202 even
if the microtask finishes immediately afterwards; route tests always poll at
least once. A later terminal replay of the identical operation ID, revision,
input, complete context, dry-run value, and HMAC-fingerprinted idempotency key
returns 201 with the same run ID. A handler throw is a sanitized failed Run,
never an HTTP 500 create response.

The handler calls public `AdapterCatalog.capabilityAvailability` before each
optional route and then only its matching public dispatch method. It maps an
unsupported preflight or `CapabilityDispatch.ok: false` directly to that exact
Problem and never casts to registry internals. Preflight occurs before upload
multipart parsing and before cancel/events/session run or artifact lookup. An
installed SPI yields: cancel 202, event stream 200 with complete Run snapshots,
upload 201, and session launch 201; tests cover installed and absent behavior
only through the public catalog. Session launch validates single-use
expiry/origin data but never fetches its URL.

Create-run calls `catalog.createRun`; Node does not repeat the authoritative
operation-availability decision. An envelope-valid request with input that
would fail the adapter schema proves an unavailable catalog entry prevents the
schema validator, file validator, scheduler, store, and handler from running.
Accepted H3 Core guards producer/store boundaries before persistence. Node
validates serialized responses again as defense in depth and maps failure
safely, but it is never the first scalar/secret/file/action guard for
handler-produced values.

- [ ] **Step 4: Run all Node adapter checks**

Run: `pnpm --filter @8lines/gauntlet-typescript-node test && pnpm --filter @8lines/gauntlet-typescript-node typecheck && pnpm --filter @8lines/gauntlet-typescript-node build`

Expected: all tests pass, including the exact 501 paths; every returned error body is `application/problem+json` and contains no thrown error text.

- [ ] **Step 5: Commit complete Node v1 transport**

```bash
git add packages/typescript/node
git commit -m "feat(ts-node): expose complete adapter v1 routes"
```

### Task 4: Package the Next.js Catch-All Route Handler Bridge

**Files:**
- Create: `packages/typescript/next/package.json`
- Create: `packages/typescript/next/tsconfig.json`
- Create: `packages/typescript/next/src/index.ts`
- Create: `packages/typescript/next/src/route-handler.ts`
- Create: `packages/typescript/next/README.md`
- Test: `packages/typescript/next/test/route-handler.test.ts`
- Test support: `packages/typescript/next/test/support/fixture-catalog.ts`

**Interfaces:**
- Consumes: `AdapterFetchHandler`, `AdapterFetchHandlerOptions`, and `createAdapterFetchHandler` from Task 2.
- Produces: `createGauntletRouteHandler()` for App Router catch-all files.

- [ ] **Step 1: Add a failing Next-wrapper test and package metadata**

```json
{
  "name": "@8lines/gauntlet-next-adapter",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "files": ["dist", "README.md"],
  "dependencies": { "@8lines/gauntlet-typescript-node": "workspace:*" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "tsx --test test/**/*.test.ts"
  }
}
```

```ts
test("wrapper forwards the original Web Request and preserves a 304 response", async () => {
  const route = createGauntletRouteHandler({ enabled: true, catalog: fixtureCatalog });
  const initial = await route(new Request("http://next/_gauntlet/v1/manifest"));
  const repeat = await route(new Request("http://next/_gauntlet/v1/manifest", {
    headers: { "if-none-match": initial.headers.get("etag")! },
  }));
  assert.equal(repeat.status, 304);
  assert.equal(await repeat.text(), "");
});
```

`test/support/fixture-catalog.ts` creates the same in-memory `AdapterCatalog`
through the public TypeScript core API; it is not imported by the published
Next package.

- [ ] **Step 2: Run the wrapper test and verify failure**

Run: `pnpm --filter @8lines/gauntlet-next-adapter test`

Expected: FAIL because the Next package and `createGauntletRouteHandler` export do not exist.

- [ ] **Step 3: Implement a dependency-free bridge and document exact consumer wiring**

```ts
// packages/typescript/next/src/route-handler.ts
export type NextGauntletRouteHandler = (request: Request) => Promise<Response>;

export function createGauntletRouteHandler(
  options: AdapterFetchHandlerOptions,
): NextGauntletRouteHandler {
  const handler = createAdapterFetchHandler(options);

  return (request) => {
    const url = new URL(request.url);
    return handler({
      kind: "trusted-normalized",
      request,
      normalizedTarget: `${url.pathname}${url.search}`,
    });
  };
}
```

```ts
// consumer app/_gauntlet/v1/[...gauntlet]/route.ts
import { createGauntletRouteHandler } from "@8lines/gauntlet-next-adapter";
import { catalog } from "@/gauntlet/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const handler = createGauntletRouteHandler({
  enabled: process.env.GAUNTLET_ENABLED === "true",
  catalog,
});

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
export const HEAD = handler;
```

The package imports no symbol from `next` and declares no Next version dependency; its only contract is the stable Web `Request`/`Response` boundary used by App Router Route Handlers. It constructs only the explicit `trusted-normalized` boundary and never labels a reconstructed pathname as raw. The bridge preserves headers, status, streaming/body semantics, and safe-prefix disabled gating. `README.md` contains the exact route module above, says to deny `/_gauntlet/*` at public ingress, and states that absent or non-`"true"` `GAUNTLET_ENABLED` remains disabled.
Exporting all seven methods is required so a wrong method reaches the common raw
gate and becomes the protocol's typed 405 instead of a framework-generated HTML
response. The bridge test exercises all exports and verifies HEAD has no body,
OPTIONS/PATCH/PUT/DELETE use the same Problem media type, and a normal host route
outside this catch-all remains owned by the Next application.
The README requires a trusted ingress/proxy that alone receives untrusted
traffic, observes the undecoded origin-form target, rejects the complete lossy
malformed matrix, strips client-supplied internal forwarding headers, and
forwards only canonical targets. Parser-rejected adapter-prefix request lines
receive the ingress's fixed value-free 400 in both enabled and disabled
upstream modes; canonical disabled requests reaching Next remain 503. The App
Route alone does not promise complete raw-target or disabled-over-malformed
precedence. `skipTrailingSlashRedirect` and `skipProxyUrlNormalize` remain
hardening only: Next 16.3.3 may still emit its own 308 and WHATWG URL parsing
already removes dot segments. Use native Node integration when the package
itself must own the full raw-target contract.

- [ ] **Step 4: Run Next package checks**

Run: `pnpm --filter @8lines/gauntlet-next-adapter test && pnpm --filter @8lines/gauntlet-next-adapter typecheck && pnpm --filter @8lines/gauntlet-next-adapter build`

Expected: all commands exit 0 without installing Next; future Next versions remain consumer concerns because the bridge has no direct Next runtime or type dependency.

- [ ] **Step 5: Commit the Next bridge**

```bash
git add packages/typescript/next pnpm-lock.yaml
git commit -m "feat(next): add gauntlet route handler bridge"
```

### Task 5: Prove Node and a Real Next Application over Live P0 HTTP

**Files:**
- Modify: `pnpm-workspace.yaml`
- Create: `examples/typescript-fixture/package.json`
- Create: `examples/typescript-fixture/tsconfig.json`
- Create: `examples/typescript-fixture/src/catalog.ts`
- Create: `examples/node-adapter/package.json`
- Create: `examples/node-adapter/tsconfig.json`
- Create: `examples/node-adapter/src/server.ts`
- Create: `examples/node-adapter/src/client-error.ts`
- Create: `examples/node-adapter/test/live-conformance.test.ts`
- Create: `examples/node-adapter/test/raw-socket-boundary.test.ts`
- Create: `examples/next/package.json`
- Create: `examples/next/tsconfig.json`
- Create: `examples/next/next.config.ts`
- Create: `examples/next/app/layout.tsx`
- Create: `examples/next/app/host-health/route.ts`
- Create: `examples/next/app/_gauntlet/v1/[...gauntlet]/route.ts`
- Create: `examples/next/test/live-conformance.test.ts`
- Create: `examples/next/test/support/trusted-ingress.ts`
- Consume unchanged: `conformance/scenarios/adapter-v1.json`

**Interfaces:**
- Consumes: Tasks 1–4 and the built P0 runner from protocol-control-plane Task
  6.
- Produces: one native Node HTTP adapter and one actual Next 16.3.3 App Router
  process that both pass the unchanged live scenario.

- [ ] **Step 1: Add the shared executable catalog and RED live tests**

Add `examples/*` to `pnpm-workspace.yaml`. `examples/typescript-fixture` exports
only `createConformanceCatalog(options)` through its package entrypoint. It
registers exact operation ID `agency-applications.finalize` and data source ID
`pending-applications`; no golden unit-fixture ID is reused. The operation
requires UUID `applicationId`, a six-digit `confirmationCode`, marks
`/properties/confirmationCode` as secret retention `none`, uses required idempotency,
declares the three scenario profiles, binds `/applicationId` to the data
source, and has a rich output schema. It omits `contextSchema` because it has no
extra restriction. The data source validates the complete pointer-keyed
`/workflowState` dependencies object and complete canonical context, supports
cursor pagination, empty-string values, empty resolve arrays, and exact ordered
resolve results. The handler emits progress, output, artifact/action data with
unrelated safe values and never persists raw context or `confirmationCode`.

Both RED tests spawn a source server on loopback, register teardown immediately,
wait for readiness, and call the programmatic P0 runner with the committed
scenario. They also call a non-adapter host health route and assert 200. Before
the server/route files exist, each test fails with its missing entrypoint.

- [ ] **Step 2: Implement and pass the native Node fixture**

`examples/node-adapter/src/server.ts` is the only published-fixture host that
imports `node:http`. It binds `127.0.0.1:0`, narrows
`IncomingMessage.url` before URL construction, returns a fixed empty generic
400 when absent, and passes `{ kind: "raw", request, rawTarget }` to the Node
handler without decoding/rebuilding that target. `/host-health` remains a
native route. It bounds headers/bodies and
timeouts, force-closes idle connections during teardown, and prints no input or
secret data.

Run:

```sh
pnpm --filter @8lines/gauntlet-typescript-fixture build
pnpm --filter @8lines/gauntlet-node-example test
```

Expected: PASS. The request log proves the exact P0 sequence; fresh create is
202, polling reaches `succeeded`, terminal replay is 201 with the same ID, and
the secret sentinel appears in no captured response or test diagnostic.

The native server installs one bounded `clientError` owner. It inspects at most
8192 bytes of `error.rawPacket` without logging/retaining/rendering them, classifies only
a bounded ASCII method + SP + exact adapter prefix boundary, and writes one
precomputed sub-1024-byte value-free response: 503 `adapter-disabled` when the
native adapter is disabled, otherwise 400 `invalid-path`. Ambiguous/non-adapter
input receives fixed empty generic 400 or close. Responses have exact Problem
media, length, `Connection: close`, no attacker/parser text, one-write guards,
and deterministic socket teardown. Bounded raw TCP tests send literal SP and
HTAB rows in enabled/disabled modes and prove exact 400/503 respectively.

- [ ] **Step 3: Implement and pass the real Next fixture**

`examples/next/package.json` pins `next: 16.3.3`, `react: 19.2.8`, and
`react-dom: 19.2.8`. A real loopback `trusted-ingress.ts` sits in front of the
Next process and owns the original target. It rejects lossy malformed paths,
strips spoofable internal headers, forwards only canonical targets, and maps
parser-rejected adapter packets to fixed 400 regardless of upstream enabled
state. P0 and hostile probes target the proxy origin; direct Next probes only
document dot-segment normalization/framework 308 and are not treated as raw
enforcement. The catch-all route creates the same catalog and exports
`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, and `HEAD` to the one common
handler. `runtime = "nodejs"`, `dynamic = "force-dynamic"`, and `revalidate = 0`
are fixed. `/host-health` is a separate Next Route Handler proving adapter
integration does not consume host routes. The test runs `next build`, spawns
`next start --hostname 127.0.0.1 --port 0`, parses its bounded readiness output,
registers teardown, then runs the unchanged P0 scenario against the real HTTP
proxy origin. `next.config.ts` keeps the two hardening flags, but tests do not
claim they prevent every framework 3xx/normalization. Literal SP/HTAB through
the ingress is fixed 400 in all four enabled/disabled rows; a separate
canonical disabled request reaches Next and returns 503. It does not mock a
Route Handler or call the adapter function directly.

Run:

```sh
pnpm --filter @8lines/gauntlet-next-example build
pnpm --filter @8lines/gauntlet-next-example test
```

Expected: PASS, including raw unsafe path, wrong methods through all exports,
strong ETags/304, fresh 202 plus polling, data-source query/resolve, secret
redaction, exact absent-capability 501s, and `/host-health` 200.

- [ ] **Step 4: Gate both package surfaces and commit**

```sh
pnpm --filter @8lines/gauntlet-typescript-core test
pnpm --filter @8lines/gauntlet-typescript-node test
pnpm --filter @8lines/gauntlet-next-adapter test
pnpm --filter @8lines/gauntlet-node-example test
pnpm --filter @8lines/gauntlet-next-example build
pnpm --filter @8lines/gauntlet-next-example test
pnpm check
git diff --check
```

```bash
git add pnpm-workspace.yaml pnpm-lock.yaml examples/typescript-fixture examples/node-adapter examples/next
git commit -m "test(ts-sdk): add live Node and Next conformance fixtures"
```

### Task 6: Create a Self-Contained Java 21 Core Multi-Module Foundation

**Files:**
- Create: `packages/java/settings.gradle.kts`
- Create: `packages/java/build.gradle.kts`
- Create: `packages/java/gradle/wrapper/gradle-wrapper.properties`
- Create: `packages/java/gradle/wrapper/gradle-wrapper.jar`
- Create: `packages/java/gradle/verification-metadata.xml`
- Create: `packages/java/gradlew`
- Create: `packages/java/gradlew.bat`
- Create: `packages/java/core/build.gradle.kts`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/json/JsonValue.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/json/JsonObject.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/json/JsonList.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/json/JsonOwnership.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/json/Rfc8785Canonicalizer.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/json/CanonicalJson.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/json/internal/jcs/DoubleCoreSerializer.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/json/internal/jcs/NumberToJSON.java`
- Create: `packages/java/core/THIRD_PARTY_NOTICES.md`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/schema/SchemaValidator.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/schema/NetworkntSchemaValidator.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/schema/TcSchemaCore.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/schema/ProtocolSemantics.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/ProtocolId.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/ProtocolRequirements.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/Problem.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/ValidationError.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/FeatureDefinition.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/ApplicationMetadata.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/AdapterHealth.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/AdapterManifest.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/OperationDefinition.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/ExecutionPolicy.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/Idempotency.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/OperationImpact.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/OperationSummary.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/OperationOutput.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/OperationUiSchema.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/OperationPreset.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/InputHandling.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/DataSourceReference.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/DataSourceDefinition.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/DataSourceQuery.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/DataSourceResolveRequest.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/DataSourceResolveResponse.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/DataSourceItem.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/DataSourcePage.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/Run.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/RunState.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/InvocationContext.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/RunProgress.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/RunSummary.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/RunEvent.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/FollowUpAction.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/CreateRunRequest.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/RunCreationResult.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/OperationResult.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/Artifact.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/FileReference.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/AdapterDiagnostic.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/UploadResponse.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/model/SessionLaunchResponse.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/spi/OperationHandler.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/spi/DataSource.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/spi/CapabilityProvider.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/spi/RunContext.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/spi/RunStore.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/spi/RunStoreCreateResult.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/spi/FileReferenceValidator.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/registry/FeatureRegistry.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/registry/OperationRegistry.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/registry/DataSourceRegistry.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/run/InMemoryRunStore.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/run/IdempotencyFingerprint.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/run/InvocationContextLease.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/run/InputHandlingGuard.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/run/RuntimeGuard.java`
- Create: `packages/java/core/src/main/java/dev/eightlines/gauntlet/core/run/RunManager.java`
- Test: `packages/java/core/src/test/java/dev/eightlines/gauntlet/core/CanonicalJsonTest.java`
- Test: `packages/java/core/src/test/java/dev/eightlines/gauntlet/core/ProtocolModelTest.java`
- Test: `packages/java/core/src/test/java/dev/eightlines/gauntlet/core/RunManagerTest.java`
- Test: `packages/java/core/src/test/java/dev/eightlines/gauntlet/core/DataSourceRegistryTest.java`
- Test: `packages/java/core/src/test/java/dev/eightlines/gauntlet/core/SharedProtocolVectorsTest.java`
- Test: `packages/java/core/src/test/java/dev/eightlines/gauntlet/core/SchemaValidatorTest.java`
- Test: `packages/java/core/src/test/java/dev/eightlines/gauntlet/core/ProtocolSemanticsTest.java`
- Test: `packages/java/core/src/test/java/dev/eightlines/gauntlet/core/RunManagerConcurrencyTest.java`
- Test: `packages/java/core/src/test/java/dev/eightlines/gauntlet/core/Rfc8785NumberCorpusTest.java`
- Test support: `packages/java/core/src/test/java/dev/eightlines/gauntlet/core/SemanticVectorLoader.java`
- Test support: `packages/java/core/src/test/java/dev/eightlines/gauntlet/core/CoreTestFixtures.java`
- Create: `packages/java/core/src/test/resources/jcs/input/arrays.json`
- Create: `packages/java/core/src/test/resources/jcs/input/french.json`
- Create: `packages/java/core/src/test/resources/jcs/input/structures.json`
- Create: `packages/java/core/src/test/resources/jcs/input/unicode.json`
- Create: `packages/java/core/src/test/resources/jcs/input/values.json`
- Create: `packages/java/core/src/test/resources/jcs/input/weird.json`
- Create: `packages/java/core/src/test/resources/jcs/output/arrays.json`
- Create: `packages/java/core/src/test/resources/jcs/output/french.json`
- Create: `packages/java/core/src/test/resources/jcs/output/structures.json`
- Create: `packages/java/core/src/test/resources/jcs/output/unicode.json`
- Create: `packages/java/core/src/test/resources/jcs/output/values.json`
- Create: `packages/java/core/src/test/resources/jcs/output/weird.json`
- Create: `packages/java/core/src/test/resources/jcs/corpus-metadata.json`

**Interfaces:**
- Consumes: Java 21, the two exact receipt-checked Apache-2.0 JCS reference
  sources below, Jackson 3-compatible
  `com.networknt:json-schema-validator:3.0.4`, and mounted shared protocol
  fixtures. The module has no Spring, Servlet, or network access.
- Produces: owned immutable JSON values, `Rfc8785Canonicalizer`,
  `SchemaValidator`, shared semantics, serializable protocol maps,
  deterministic revisions, typed operation/data-source SPIs, registries, and
  an atomic in-memory synchronous run manager.

- [ ] **Step 1: Verify the pinned Java source receipt, generate the wrapper, and write failing Java tests**

Java has no JCS Maven dependency. Before production compilation, retrieve into
a disposable directory the exact Apache-2.0 reference sources from commit
`19d51d7fe467d4706a3ff08adf8a748f29fc21e0` and verify:

- `DoubleCoreSerializer.java` SHA-256
  `61246c838dbfdf372ca7955768695dffe3ffeabb09a8739dbb1bc2245a7561d7`;
- `NumberToJSON.java` SHA-256
  `b17555e45aa1c6fdf5924ef02df14b25d8fad1d9c7d81f1e33954e82a4f7a78a`;
- upstream `LICENSE` SHA-256
  `6821faaddedf2d78c95bb6d98b127e9e616097afd2f6bcc34389f000d13ab12d`.

Copy only the two sources with complete headers and the package/import
relocation required for unsupported internal package
`dev.eightlines.gauntlet.core.json.internal.jcs`; independently diff them
against the pristine blobs. `THIRD_PARTY_NOTICES.md` records both copyright
holders, source URLs, commit, hashes, relocation note, and full Apache-2.0
license. A changed receipt/header/body, missing notice, or any JCS Maven
coordinate is a STOP.

Titanium/Erdtman composition, output patching, snapshots/forks,
`Double.toString` rewriting, `DecimalFormat`, `BigDecimal` digit search,
reflection into `jdk.internal.*`, `--add-exports`, network/process/alternate
runtime bridges, literal special cases, and regex/decimal output repair are
forbidden.

```bash
docker run --rm --user "$(id -u):$(id -g)" -e GRADLE_USER_HOME=/tmp/gradle -v "$PWD/packages/java:/workspace" -w /workspace --entrypoint /bin/sh gradle:9.2.1-jdk21 \
  -c 'gradle wrapper --gradle-version 9.2.1 && chmod +x gradlew'
```

```java
// packages/java/core/src/test/java/dev/eightlines/gauntlet/core/CanonicalJsonTest.java
@Test
void revisionIsStableAndDoesNotHashItsOwnRevisionField() {
    var first = CoreTestFixtures.fixtureDefinition("applications.finalize");
    var second = CoreTestFixtures.fixtureDefinition("applications.finalize");
    assertEquals(first.revision(), second.revision());
    assertTrue(first.revision().matches("sha256:[0-9a-f]{64}"));
    assertEquals(
        "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
        CanonicalJson.revision(JsonOwnership.object(Map.of()), "revision")
    );
    assertThrows(IllegalArgumentException.class,
        () -> CanonicalJson.encode(JsonOwnership.object(
            Map.of("unsafe", 9_007_199_254_740_992L))));
}

@Test
void canonicalizationMatchesTheRfc8785NumberAndStringVector() {
    var vector = new LinkedHashMap<String, Object>();
    vector.put("numbers", List.of(333333333.33333329d, 1e30d, 4.5d, 2e-3d, 1e-27d));
    vector.put("string", "€$\u000f\nA'B\"\\\\\"/");
    vector.put("literals", Arrays.asList(null, true, false));
    assertEquals(
        "{\"literals\":[null,true,false],\"numbers\":[333333333.3333333,1e+30,4.5,0.002,1e-27],\"string\":\"€$\\u000f\\nA'B\\\"\\\\\\\\\\\"/\"}",
        CanonicalJson.encode(vector)
    );
}

// packages/java/core/src/test/java/dev/eightlines/gauntlet/core/RunManagerTest.java
@Test
void staleRevisionReturnsConflictWithoutPersistingARun() {
    var fixture = CoreTestFixtures.runManager(Idempotency.OPTIONAL);
    var stale = "sha256:" + "f".repeat(64);
    var context = new InvocationContext(
        "request-1", null, null, null, null, JsonOwnership.object(Map.of()));
    var result = fixture.manager().create("applications.finalize", new CreateRunRequest(
        stale, JsonOwnership.object(Map.of()), context, false, null,
        JsonOwnership.object(Map.of())));
    assertEquals(409, result.problem().status());
    assertTrue(fixture.store().all().isEmpty());
}

// packages/java/core/src/test/java/dev/eightlines/gauntlet/core/ProtocolModelTest.java
@Test
void protocolIdsAndResolveResultsUseCanonicalPortableShapes() {
    assertThrows(IllegalArgumentException.class, () -> ProtocolId.of("a/b"));
    assertEquals("optional", Idempotency.OPTIONAL.wireValue());
    assertEquals(Idempotency.OPTIONAL, Idempotency.fromWireValue("optional"));
    var response = new DataSourceResolveResponse(List.of(
        new DataSourceResolveResponse.Result("app-1", new DataSourceItem(
            "app-1", "Application 1", null, null, false,
            JsonOwnership.object(Map.of()), JsonOwnership.object(Map.of()))),
        new DataSourceResolveResponse.Result("missing", null)
    ), JsonOwnership.object(Map.of()));
    assertEquals(List.of("app-1", "missing"), response.results().stream().map(DataSourceResolveResponse.Result::value).toList());
}
```

Before implementation, `RunManagerTest` also adds three policy cases against
the same registered successful handler: `NONE` plus a supplied key returns a
422 Problem and persists nothing; `OPTIONAL` plus the same non-blank key on two
otherwise identical requests returns the same run ID and executes the handler
once; and `REQUIRED` plus a missing key returns a 422 Problem and persists
nothing. Add a 32-way concurrent duplicate test that proves one HMAC
fingerprint reservation, one run, one handler execution, and no raw key in
store state. Add context-lease tests proving complete deeply owned context is
visible only during the handler and unavailable after success/failure. Golden
unit IDs remain separate from the later live P0 IDs.

- [ ] **Step 2: Run the tests through Docker and verify failure**

Run: `docker run --rm --user "$(id -u):$(id -g)" -e GRADLE_USER_HOME=/tmp/gradle -v "$PWD/packages/java:/workspace" -v "$PWD/packages/protocol:/protocol" -w /workspace gradle:9.2.1-jdk21 ./gradlew -DgauntletProtocolFixtures=/protocol/fixtures/v1 :core:test`

Expected: FAIL because the `core` module, models, and tests have not been implemented.

- [ ] **Step 3: Implement Gradle metadata and the pure Java contracts**

```kotlin
// packages/java/settings.gradle.kts
rootProject.name = "gauntlet-java"
include("core", "spring-boot-starter", "spring-example")

// packages/java/build.gradle.kts
import org.gradle.api.plugins.JavaPluginExtension
import org.gradle.api.tasks.compile.JavaCompile
import org.gradle.api.tasks.testing.Test

allprojects {
    group = "dev.eightlines.gauntlet"
    version = "0.1.0-SNAPSHOT"
}
subprojects {
    apply(plugin = "java-library")
    extensions.configure<JavaPluginExtension> {
        toolchain { languageVersion = JavaLanguageVersion.of(21) }
    }
    tasks.withType<JavaCompile>().configureEach { options.release = 21 }
    repositories { mavenCentral() }
    dependencies {
        add("testImplementation", platform("org.springframework.boot:spring-boot-dependencies:4.1.1"))
        add("testImplementation", "org.junit.jupiter:junit-jupiter")
        add("testRuntimeOnly", "org.junit.platform:junit-platform-launcher")
    }
    tasks.withType<Test>().configureEach { useJUnitPlatform() }
}

// packages/java/core/build.gradle.kts
dependencies {
    implementation("com.networknt:json-schema-validator:3.0.4")
}

val protocolFixtures = providers.systemProperty("gauntletProtocolFixtures")
sourceSets.named("test") { resources.srcDir(protocolFixtures) }
tasks.named("test") {
    doFirst {
        require(protocolFixtures.isPresent) {
            "-DgauntletProtocolFixtures must name the mounted protocol fixture directory"
        }
    }
}
```

No JCS dependency is added to `core/build.gradle.kts` or Gradle verification
metadata. The build must fail when `gauntletProtocolFixtures` is missing,
rather than falling back to copied or classpath-shadowed fixtures. Refresh and
review ordinary launcher/Networknt/Jackson dependency verification metadata;
vendored source is governed by its source receipt instead:

```bash
docker run --rm --user "$(id -u):$(id -g)" -e GRADLE_USER_HOME=/tmp/gradle \
  -v "$PWD/packages/java:/workspace" -v "$PWD/packages/protocol:/protocol" \
  -w /workspace gradle:9.2.1-jdk21 \
  ./gradlew -DgauntletProtocolFixtures=/protocol/fixtures/v1 \
  --write-verification-metadata sha256 :core:dependencies
git diff -- packages/java/gradle/verification-metadata.xml
```

```java
public interface CapabilityProvider {
    String capabilityId();
}

public interface OperationHandler<I> {
    OperationDefinition definition();
    OperationResult execute(I input, RunContext context) throws Exception;
}

public interface DataSource {
    DataSourceDefinition definition();
    DataSourcePage query(DataSourceQuery request) throws Exception;
    DataSourceResolveResponse resolve(DataSourceResolveRequest request) throws Exception;
}

public interface RunContext {
    String runId();
    String operationId();
    Optional<InvocationContext> invocationContext();
    void report(RunProgress progress);
    void addArtifact(Artifact artifact);
    void addAction(FollowUpAction action);
    void log(String level, String message, JsonObject fields);
    void warn(String message);
    boolean isCancellationRequested();
    void throwIfCancelled();
}

public interface RunStore {
    RunStoreCreateResult createQueued(Run run, Optional<String> idempotencyFingerprint);
    Optional<Run> get(String runId);
    Optional<Run> findByIdempotencyFingerprint(String operationId, String fingerprint);
    boolean updateExactSequence(Run run, long expectedPreviousSequence);
}

public record CreateRunRequest(
    String operationRevision,
    JsonObject input,
    InvocationContext context,
    boolean dryRun,
    String idempotencyKey,
    JsonObject extensions
) {}

public enum Idempotency {
    NONE("none"), OPTIONAL("optional"), REQUIRED("required");

    private final String wireValue;
    Idempotency(String wireValue) { this.wireValue = wireValue; }
    public String wireValue() { return wireValue; }
    public static Idempotency fromWireValue(String value) {
        return switch (value) {
            case "none" -> NONE;
            case "optional" -> OPTIONAL;
            case "required" -> REQUIRED;
            default -> throw new IllegalArgumentException("unsupported idempotency policy");
        };
    }
}

public record ExecutionPolicy(
    OperationImpact impact,
    boolean confirmationRequired,
    boolean dryRunSupported,
    Idempotency idempotency,
    boolean cancellationSupported,
    Integer timeoutSeconds,
    String concurrency,
    JsonObject extensions
) {
    public ExecutionPolicy {
        Objects.requireNonNull(impact, "impact");
        Objects.requireNonNull(idempotency, "idempotency");
        if (timeoutSeconds != null && timeoutSeconds <= 0) {
            throw new IllegalArgumentException("timeoutSeconds must be positive");
        }
        if (concurrency != null && !Set.of("allow", "forbid", "queue").contains(concurrency)) {
            throw new IllegalArgumentException("unsupported concurrency policy");
        }
        Objects.requireNonNull(extensions, "extensions");
    }
}
```

`ProtocolId.of` enforces the canonical safe-segment pattern and every Java
registry/controller uses it. `JsonOwnership.ownRuntime(Object)` and
`ownRevision(Object)` differ only for negative zero: runtime follows H3 and
rejects it; revision accepts and normalizes it to positive zero. Both parse
fractions/exponents as binary64, reject duplicate names before ownership,
deep-own closed immutable nodes, preserve aliases and `__proto__`, and reject
lone surrogates, non-finite values, unsupported POJOs/binary nodes, non-string
map keys, active ancestor cycles, `Float`, precision-losing `BigDecimal`, and
non-exponential unsafe integers.

`Rfc8785Canonicalizer` is iterative for validation, ownership, and
serialization, with no recursive Java call chain or JCS-specific depth cap. It
owns structural punctuation, exact escaping, UTF-16 `String.compareTo` key
ordering, array order, and one final UTF-8 encoding. Every finite binary64
number goes directly to the unchanged internal
`NumberToJSON.serializeNumber`. `CanonicalJson` removes only the selected root
revision field, canonicalizes through the owned reference port, and hashes the
returned bytes as lowercase `sha256:` hex; no post-processing exists.

The ordinary offline suite validates all 16 checked-in JCS rows, RFC 8785
Appendix B, unsupported/numeric/Unicode/alias/cycle/root-only/zero cases, a
4,097-level case under `-Xss256k`, and six receipt-checked upstream input/output
pairs (`arrays`, `french`, `structures`, `unicode`, `values`, `weird`) using the
exact hashes pinned by the approved amendment. `Rfc8785NumberCorpusTest` is an
explicit opt-in excluded from ordinary tests; `-PjcsCorpus` must name an
absolute local regular non-symlink gzip and absence/mismatch fails rather than
skips. Metadata pins compressed size `2081240993`, SHA-256
`545455ec9e74b68042c22a2607fb9d4a5f5fdb3c79f883ce864c75189a70705f`,
uncompressed size `4036326174`, SHA-256
`0f7dda6b0837dde083c5d6b896f7d62340c8a2415b0c7121d83145e08a755272`,
and exactly `100000000` streamed rows. It also pins source commit
`19d51d7fe467d4706a3ff08adf8a748f29fc21e0` and release URL
`https://github.com/cyberphone/json-canonicalization/releases/download/es6testfile/es6testfile100m.txt.gz`.
The test never retrieves a resource.
Maintaining the pinned 542-line reference port is an architecture/review cost;
every source-pin change reruns receipt, notices, 16 rows, six pairs, Appendix B,
and the full corpus.

The six source-pinned pair receipts are exact:

| Pair | input SHA-256 | output SHA-256 |
| --- | --- | --- |
| `arrays.json` | `e503b6d71d1afa595b1c74b1016445c944cd89f90418066b23de1aeda7d17563` | `099601b171cafed97c333f8878d68e7f8c8f795412adb34b2fdcf0e7c7beac42` |
| `french.json` | `03676a951cd8753ac62589f72eb2105cc782c33425418cfe1d517c111f6e5d5a` | `d99d0ebdcb0033cb858cfa830ae46bc0fb3309413b271f1da828c89901a27ed5` |
| `structures.json` | `d66893805be1784116af50af3110d08766c70a6b4aad93374723f72346e7aaa6` | `605f65004ec2db7692522a0852c22f1c989e036d547e88963d1a3143cf3195d5` |
| `unicode.json` | `4621864e014d4a805a563f55b9ea20aba4a2d2dc09c7394f625496998c00702c` | `0d99aad92a125196ff887876643fd3206786a84ddce2cee52ba4ad256d2381d3` |
| `values.json` | `c4a041b503d6bc236036ef44db4dac499272f60fc22c40dc3b7a54870ba6f1c3` | `2d5e01a318d0f0879ab568c4be289c8b1f64ef8921a53c6277d5e069978baacb` |
| `weird.json` | `a3a905266bd4a49a969274ea69baa14ee0c4af0ead926d6fa2b7612b4af75387` | `6af595a9aa80110b964b4de3f82a05fa6ae7423005019bacfa2620dddc4e94d1` |

`TcSchemaCore` ports the accepted profile and `ProtocolSemantics` ports the
three shared predicates. `SemanticVectorLoader` independently loads
`adapter-semantic-vectors.json` and its companion schema as local regular
files, with bounded non-empty sub-256-KiB raw reads, fatal UTF-8, no BOM/CR,
exactly one final LF before parsing, and ASCII-only for the artifact. It parses
and compiles the local Draft 2020-12 companion first with only local
`#/$defs/...` references and external retrieval disabled, validates the
artifact, asserts 35 document rows, 54 ordinary presets, seven workloads, 96
outcomes, unique IDs and fixed profiles, then verifies safe sibling basenames,
non-symlink files, 4-MiB caps, raw SHA-256, patches, revisions, directives, and
generated canonical UTF-8 byte-count and revision fingerprints before semantic
outcomes. Only
the four closed workload kinds may materialize; the 900,000-item value exists
only in memory.
`NetworkntSchemaValidator` uses Jackson 3 and the exact Draft 2020-12 dialect,
has no URI/network retrieval callback, resolves only local fragments, enables
the frozen format assertions, and returns safe normalized JSON Pointer errors.
It validates raw input/context, pointer-keyed dependencies/context, output, and
data-source results. `CoreTestFixtures` exports `fixtureDefinition(id)` and
`runManager(Idempotency)`; the latter returns a `RunManagerFixture` containing
the configured manager and inspectable store. `OperationDefinition` exactly
carries requirements/extensions, object input/context schemas, optional input
handling/UI, data-source pointer bindings, presets, execution, and output;
`OperationSummary` retains requirements for both availability states and has no
transport fields. `AdapterManifest` includes all valid data-source definitions,
all valid operation summaries, and safe diagnostics for omitted invalid
bindings.

`Run` is a constructor-validated state union with sequence/timestamps, optional
progress/summary/output, typed artifacts/actions, extensions, and terminal
problem/completion invariants; `RunEvent` contains a full immutable snapshot.
`DataSourceResolveRequest` accepts string values including `""` and an empty
list; the response has same length/order/value identity and nullable items.
`FileReference`, uploads, and session launch use opaque/expiry/single-use
shapes. Registries reject duplicate IDs and absent feature references. Core
protocol maps serialize wire strings rather than Java enum names.

`RunManager` validates the complete request and definitions, deep secret/file
rules, and delegates file expiry/cardinality/media/size/operation/revision
ownership to the framework-neutral `FileReferenceValidator` SPI. A file rule is
non-executable without that validator; Spring separately requires an installed
upload endpoint SPI before advertising `tc-uploads@1`. The manager validates
handler output, artifacts/actions, target-operation secret inputs, and every
store read.
It converts a raw key immediately to domain-separated HMAC-SHA256, passes only
the fingerprint into atomic `createQueued`, rereads the winning duplicate, and
uses `updateExactSequence` for transitions. Its stable secret is mandatory for
a durable/shared store. `InvocationContextLease` is cleared in `finally` before
terminal persistence; retained `RunContext.invocationContext()` then returns
empty. A handler exception becomes exactly
`urn:gauntlet:problem:handler-failed`, status 500, title `Operation failed`,
safe correlation ID, and no exception or secret text.

- [ ] **Step 4: Run Java core tests and build**

Run: `docker run --rm --user "$(id -u):$(id -g)" -e GRADLE_USER_HOME=/tmp/gradle -v "$PWD/packages/java:/workspace" -v "$PWD/packages/protocol:/protocol" -w /workspace gradle:9.2.1-jdk21 ./gradlew -DgauntletProtocolFixtures=/protocol/fixtures/v1 :core:test :core:jar`

Expected: PASS; `core/build/libs/core-0.1.0-SNAPSHOT.jar` has no Spring or
Servlet dependency, uses Jackson 3 only through the validator boundary, and
passes every shared pattern/JCS/semantic vector.

- [ ] **Step 5: Commit Java core**

```bash
git add packages/java
git commit -m "feat(java-core): add protocol definitions registries and runs"
```

### Task 7: Add Spring Boot 4.1.1 Annotations, Catalog, and Typed Bean Bindings

**Files:**
- Modify: `packages/java/gradle/verification-metadata.xml`
- Create: `packages/java/spring-boot-starter/build.gradle.kts`
- Create: `packages/java/spring-boot-starter/src/main/resources/META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports`
- Create: `packages/java/spring-boot-starter/src/main/java/dev/eightlines/gauntlet/spring/GauntletAutoConfiguration.java`
- Create: `packages/java/spring-boot-starter/src/main/java/dev/eightlines/gauntlet/spring/GauntletProperties.java`
- Create: `packages/java/spring-boot-starter/src/main/java/dev/eightlines/gauntlet/spring/GauntletApplicationProperties.java`
- Create: `packages/java/spring-boot-starter/src/main/java/dev/eightlines/gauntlet/spring/annotation/GauntletFeature.java`
- Create: `packages/java/spring-boot-starter/src/main/java/dev/eightlines/gauntlet/spring/annotation/GauntletOperation.java`
- Create: `packages/java/spring-boot-starter/src/main/java/dev/eightlines/gauntlet/spring/annotation/GauntletDataSource.java`
- Create: `packages/java/spring-boot-starter/src/main/java/dev/eightlines/gauntlet/spring/catalog/SpringAdapterCatalog.java`
- Create: `packages/java/spring-boot-starter/src/main/java/dev/eightlines/gauntlet/spring/catalog/RecordSchemaFactory.java`
- Create: `packages/java/spring-boot-starter/src/main/java/dev/eightlines/gauntlet/spring/catalog/SpringOperationBinding.java`
- Create: `packages/java/spring-boot-starter/src/main/java/dev/eightlines/gauntlet/spring/catalog/SpringDataSourceBinding.java`
- Create: `packages/java/spring-boot-starter/src/main/java/dev/eightlines/gauntlet/spring/http/AdapterEnabledGate.java`
- Create: `packages/java/spring-boot-starter/src/main/java/dev/eightlines/gauntlet/spring/capability/SpringCapabilityRegistry.java`
- Create: `packages/java/spring-boot-starter/src/main/java/dev/eightlines/gauntlet/spring/capability/CancelRunEndpoint.java`
- Create: `packages/java/spring-boot-starter/src/main/java/dev/eightlines/gauntlet/spring/capability/RunEventsEndpoint.java`
- Create: `packages/java/spring-boot-starter/src/main/java/dev/eightlines/gauntlet/spring/capability/UploadEndpoint.java`
- Create: `packages/java/spring-boot-starter/src/main/java/dev/eightlines/gauntlet/spring/capability/SessionLaunchEndpoint.java`
- Create: `packages/java/spring-boot-starter/src/main/java/dev/eightlines/gauntlet/spring/spi/TypedOperationHandler.java`
- Create: `packages/java/spring-boot-starter/src/main/java/dev/eightlines/gauntlet/spring/spi/TypedDataSource.java`
- Test: `packages/java/spring-boot-starter/src/test/java/dev/eightlines/gauntlet/spring/SpringAdapterCatalogTest.java`
- Test: `packages/java/spring-boot-starter/src/test/java/dev/eightlines/gauntlet/spring/RecordSchemaFactoryTest.java`
- Test fixture: `packages/java/spring-boot-starter/src/test/java/dev/eightlines/gauntlet/spring/fixture/FixtureApplication.java`
- Test fixture: `packages/java/spring-boot-starter/src/test/java/dev/eightlines/gauntlet/spring/fixture/ApplicationsFeature.java`
- Test fixture: `packages/java/spring-boot-starter/src/test/java/dev/eightlines/gauntlet/spring/fixture/FinalizeInput.java`
- Test fixture: `packages/java/spring-boot-starter/src/test/java/dev/eightlines/gauntlet/spring/fixture/FinalizeOperation.java`
- Test fixture: `packages/java/spring-boot-starter/src/test/java/dev/eightlines/gauntlet/spring/fixture/ApplicationsDataSource.java`

**Interfaces:**
- Consumes: Task 6 Java core SPI, validator/semantic services, and protocol maps.
- Produces: explicit bean annotations, default-disabled binding properties, generated record schemas, and a catalog that is safe to serialize and invoke.

- [ ] **Step 1: Write failing annotation/catalog and default-disabled tests**

```java
@SpringBootTest(
    classes = FixtureApplication.class,
    properties = {
        "gauntlet.application.id=fixture-app",
        "gauntlet.application.label=Fixture application"
    }
)
class SpringAdapterCatalogTest {
    @Autowired GauntletProperties properties;
    @Autowired SpringAdapterCatalog catalog;

    @Test void adapterIsDisabledUnlessTheExactPropertyIsTrue() {
        assertThat(properties.enabled()).isFalse();
        assertThat(catalog.manifest().operations().stream().map(OperationSummary::id))
            .containsExactly("applications.finalize");
    }
}

@Test
void recordSchemaUsesRequiredAndNullableProtocolShapes() {
    var schema = factory.schemaFor(FinalizeInput.class);
    assertThat(schema.get("type")).isEqualTo("object");
    assertThat((List<?>) schema.get("required")).containsExactly("applicationId");
    assertThat(schema.toString()).contains("applicationId").contains("reason");
}
```

A second catalog context registers a valid operation requiring absent
`tc-uploads@1`; the RED test asserts its manifest summary remains present with
`availability.state: unavailable` and the exact declared profiles/capabilities,
while a malformed operation is omitted and diagnosed without `operationId`
when its identity is unsafe.

The fixture also covers missing profile, missing core endpoint SPI, and an
available counter-case. `SpringAdapterCatalog` exposes one public lookup/gate
backed by the same immutable summary index serialized by `manifest()`, and its
final create method rechecks it. For both unavailable cases the returned
Problem equals the manifest summary Problem and request validator, typed
mapper, file validator, store, scheduler, and handler spies all remain zero.

- [ ] **Step 2: Run starter tests through Docker and verify failure**

Run: `docker run --rm --user "$(id -u):$(id -g)" -e GRADLE_USER_HOME=/tmp/gradle -v "$PWD/packages/java:/workspace" -w /workspace gradle:9.2.1-jdk21 ./gradlew :spring-boot-starter:test`

Expected: FAIL because the Spring starter module, annotations, and auto-configuration are absent.

- [ ] **Step 3: Implement exact Spring metadata, annotations, and typed bindings**

```kotlin
// packages/java/spring-boot-starter/build.gradle.kts
dependencies {
    api(project(":core"))
    implementation(platform("org.springframework.boot:spring-boot-dependencies:4.1.1"))
    implementation("org.springframework.boot:spring-boot-starter-webmvc")
    implementation("org.springframework.boot:spring-boot-starter-validation")
    annotationProcessor(platform("org.springframework.boot:spring-boot-dependencies:4.1.1"))
    annotationProcessor("org.springframework.boot:spring-boot-configuration-processor")
    testImplementation(platform("org.springframework.boot:spring-boot-dependencies:4.1.1"))
    testImplementation("org.springframework.boot:spring-boot-starter-test")
    testImplementation("org.springframework.boot:spring-boot-starter-webmvc-test")
}
```

```java
@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
public @interface GauntletFeature {
    String id();
    String label();
    String parentId() default "";
    int order() default 0;
}

@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
public @interface GauntletOperation {
    String id();
    String featureId();
    String label();
    Class<?> input();
    String description() default "";
    String[] tags() default {};
    int order() default 0;
    OperationImpact impact() default OperationImpact.READ;
    boolean confirmationRequired() default false;
    boolean dryRunSupported() default false;
    Idempotency idempotency() default Idempotency.NONE;
    boolean cancellationSupported() default false;
    int timeoutSeconds() default -1;
    String concurrency() default "";
    String[] requiredProfiles() default { "tc-schema-core@1" };
    String[] requiredCapabilities() default {};
    String inputSchemaResource() default "";
    String definitionResource() default "";
}

@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
public @interface GauntletDataSource {
    String id();
    String label();
    String description() default "";
    boolean search() default true;
    int defaultLimit() default 20;
    int maxLimit() default 100;
    String dependencySchemaResource() default "";
    String contextSchemaResource() default "";
    String definitionResource() default "";
}

public interface TypedOperationHandler<I> {
    OperationResult execute(I input, RunContext context) throws Exception;
}

public interface TypedDataSource {
    DataSourcePage query(DataSourceQuery request) throws Exception;
    DataSourceResolveResponse resolve(DataSourceResolveRequest request) throws Exception;
}
```

`GauntletProperties` is a `@ConfigurationProperties("gauntlet")` record
with `boolean enabled`, application metadata, and generic additional profile
IDs. It defaults to disabled and profile `tc-schema-core@1`; when enabled it
requires a valid application ID and non-blank label. Free-form configuration
cannot advertise any capability. `SpringCapabilityRegistry` retains a future
non-core versioned ID only from exactly one core `CapabilityProvider` bean and
derives each
core ID from exactly one matching SPI bean; zero beans means exact 501 and
duplicates mean safe diagnostic plus no advertisement. Future non-core
versioned capability IDs cannot be claimed by an endpoint-less string, and a
generic provider cannot claim one of the four core IDs.
The catalog tests cover duplicate providers, a generic provider claiming a core
ID, and removal of a future ID when its provider bean is absent.

`GauntletAutoConfiguration` is listed only in
`META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports`,
enables properties, and never component-scans. It obtains only existing
application beans bearing the Gauntlet annotations. `SpringAdapterCatalog`
sorts beans by stable ID, converts them to core bindings, includes all valid
data sources and all valid operation summaries with complete requirements, and
records safe diagnostics for duplicate IDs, missing features,
annotation/interface mismatch, unsupported input, or unreadable classpath
resource. A diagnostic omits `operationId` until identity is safely validated.
Its immutable public operation-summary lookup is the one availability decision
used by both manifest serialization and invocation. It gates request
validation, record binding, file validation, `RunManager`, store, scheduler,
and handler, and the final create method rechecks it so no controller can
bypass the decision.
Resources resolve only from the application classpath; absolute paths, URLs,
and filesystem fallback are rejected. `GauntletDataSource` emits cursor
pagination/resolve and complete raw dependency/context schemas. Advanced
definitions may use a local classpath resource plus fragment pointer whose
identity must equal the annotation. Invalid bindings are non-executable.

The Task 7 fixture contains a `@SpringBootApplication` named
`FixtureApplication`; a `@Component` `ApplicationsFeature` annotated with
`@GauntletFeature(id = "applications", label = "Applications")`; a
`FinalizeOperation` bean implementing `TypedOperationHandler<FinalizeInput>`
and annotated with `@GauntletOperation(id = "applications.finalize",
featureId = "applications", label = "Finalize application",
input = FinalizeInput.class, idempotency = Idempotency.OPTIONAL)`; and an `ApplicationsDataSource` bean
implementing `TypedDataSource` and annotated with
`@GauntletDataSource(id = "applications", label = "Applications")`.

`RecordSchemaFactory` supports Java records whose components are `String`,
primitive/wrapper numbers/booleans, `BigDecimal`, `UUID`, enums, and scalar
`List<T>`. Required/nullability and Jakarta constraints map to portable JSON
Schema. `@Pattern` is emitted only when it passes the shared deterministic
pattern profile. Generated definitions emit all canonical fields. Explicit
input or complete definition resources are classpath-only, closed, identity
checked, and pass `tc-schema-core@1`, `operationSemanticsAreValid`, and the
accepted JCS revision. The core `SchemaValidator` validates instances before
Jackson record binding; production imports use Jackson 3 `tools.jackson.*`
types only. Unsupported records or inconsistent resources become safe
diagnostics, never executable bindings.

- [ ] **Step 4: Refresh verified dependency metadata, then run catalog/schema tests and package build**

Run:

```sh
docker run --rm --user "$(id -u):$(id -g)" -e GRADLE_USER_HOME=/tmp/gradle \
  -v "$PWD/packages/java:/workspace" -v "$PWD/packages/protocol:/protocol" \
  -w /workspace gradle:9.2.1-jdk21 \
  ./gradlew -DgauntletProtocolFixtures=/protocol/fixtures/v1 \
  --write-verification-metadata sha256 :spring-boot-starter:dependencies
docker run --rm --user "$(id -u):$(id -g)" -e GRADLE_USER_HOME=/tmp/gradle \
  -v "$PWD/packages/java:/workspace" -v "$PWD/packages/protocol:/protocol" \
  -w /workspace gradle:9.2.1-jdk21 \
  ./gradlew -DgauntletProtocolFixtures=/protocol/fixtures/v1 \
  :spring-boot-starter:test :spring-boot-starter:jar
```

Expected: PASS; absent `gauntlet.enabled` leaves the gate false, but catalog inspection itself remains safe and testable.

- [ ] **Step 5: Commit annotations and catalog**

```bash
git add packages/java/spring-boot-starter packages/java/build.gradle.kts packages/java/settings.gradle.kts packages/java/gradle/verification-metadata.xml
git commit -m "feat(java-spring): add annotated adapter catalog"
```

### Task 8: Implement Complete Spring Boot v1 HTTP Transport and Live P0 Conformance

**Files:**
- Modify: `packages/java/gradle/verification-metadata.xml`
- Modify: `packages/java/spring-boot-starter/build.gradle.kts`
- Modify: `packages/java/spring-boot-starter/src/main/java/dev/eightlines/gauntlet/spring/GauntletAutoConfiguration.java`
- Modify: `packages/java/spring-boot-starter/src/test/java/dev/eightlines/gauntlet/spring/fixture/FixtureApplication.java`
- Modify: `packages/java/spring-boot-starter/src/test/java/dev/eightlines/gauntlet/spring/fixture/FinalizeOperation.java`
- Modify: `packages/java/spring-boot-starter/src/test/java/dev/eightlines/gauntlet/spring/fixture/ApplicationsDataSource.java`
- Create: `packages/java/spring-boot-starter/src/main/java/dev/eightlines/gauntlet/spring/http/AdapterV1Controller.java`
- Create: `packages/java/spring-boot-starter/src/main/java/dev/eightlines/gauntlet/spring/http/ProblemResponseFactory.java`
- Create: `packages/java/spring-boot-starter/src/main/java/dev/eightlines/gauntlet/spring/http/RequestEnvelopeValidator.java`
- Create: `packages/java/spring-boot-starter/src/main/java/dev/eightlines/gauntlet/spring/http/ProtocolExceptionHandler.java`
- Create: `packages/java/spring-boot-starter/src/main/java/dev/eightlines/gauntlet/spring/http/RawAdapterPrefixFilter.java`
- Create: `packages/java/spring-boot-starter/src/main/java/dev/eightlines/gauntlet/spring/http/CapabilityController.java`
- Create: `packages/java/spring-boot-starter/src/test/java/dev/eightlines/gauntlet/spring/AdapterV1HttpTest.java`
- Create: `packages/java/spring-boot-starter/src/test/java/dev/eightlines/gauntlet/spring/AdapterDisabledHttpTest.java`
- Create: `packages/java/spring-boot-starter/src/test/resources/application.yml`
- Create: `packages/java/spring-example/build.gradle.kts`
- Create: `packages/java/spring-example/src/main/java/dev/eightlines/gauntlet/example/FixtureApplication.java`
- Create: `packages/java/spring-example/src/main/java/dev/eightlines/gauntlet/example/AgencyApplicationsFeature.java`
- Create: `packages/java/spring-example/src/main/java/dev/eightlines/gauntlet/example/FinalizeInput.java`
- Create: `packages/java/spring-example/src/main/java/dev/eightlines/gauntlet/example/FinalizeOperation.java`
- Create: `packages/java/spring-example/src/main/java/dev/eightlines/gauntlet/example/PendingApplicationsDataSource.java`
- Create: `packages/java/spring-example/src/main/resources/application.yml`

**Interfaces:**
- Consumes: Task 6 core runtime, Task 7 Spring catalog/properties/capability
  registry, and unchanged P0 runner/scenario.
- Produces: all mandatory adapter endpoints, SPI-backed optional endpoints,
  pre-routing raw/disabled enforcement, Spring MVC error mapping, and an
  executable live Spring fixture for the external runner.

- [ ] **Step 1: Write failing MVC tests for gating, discovery, runs, and data sources**

```java
@SpringBootTest(classes = FixtureApplication.class, webEnvironment = SpringBootTest.WebEnvironment.MOCK)
@AutoConfigureMockMvc
@TestPropertySource(properties = "gauntlet.enabled=true")
class AdapterV1HttpTest {
    @Autowired MockMvc mvc;
    @Autowired tools.jackson.databind.ObjectMapper objectMapper;

    @Test void manifestUsesEtagAndListsExplicitFeatureAndOperation() throws Exception {
        var first = mvc.perform(get("/_gauntlet/v1/manifest"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.features[0].id").value("applications"))
            .andExpect(jsonPath("$.operations[0].id").value("applications.finalize"))
            .andExpect(jsonPath("$.dataSources[0].id").value("applications"))
            .andReturn();
        mvc.perform(get("/_gauntlet/v1/manifest").header("If-None-Match", first.getResponse().getHeader("ETag")))
            .andExpect(status().isNotModified())
            .andExpect(header().string("ETag", first.getResponse().getHeader("ETag")))
            .andExpect(header().doesNotExist("Content-Type"))
            .andExpect(content().string(""));
    }

    @Test void staleRevisionDoesNotInvokeHandlerAndInvalidInputUsesJsonPointer() throws Exception {
        mvc.perform(post("/_gauntlet/v1/operations/applications.finalize/runs")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"operationRevision\":\"sha256:" + "f".repeat(64) + "\",\"input\":{},\"context\":{\"requestId\":\"request-1\"},\"dryRun\":false}"))
            .andExpect(status().isConflict());
        mvc.perform(post("/_gauntlet/v1/operations/applications.finalize/runs")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"operationRevision\":\"" + fixtureRevision() + "\",\"input\":{},\"context\":{\"requestId\":\"request-2\"},\"dryRun\":false}"))
            .andExpect(status().isUnprocessableEntity())
            .andExpect(jsonPath("$.errors[0].instancePath").value("/applicationId"));
    }

    @Test void resolveReturnsOneOrderedResultForEveryStringValue() throws Exception {
        mvc.perform(post("/_gauntlet/v1/data-sources/applications/resolve")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"values\":[\"app-1\",\"missing\"],\"dependencies\":{\"/region\":\"pl\"},\"context\":{\"requestId\":\"request-3\"}}"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.results.length()").value(2))
            .andExpect(jsonPath("$.results[0].value").value("app-1"))
            .andExpect(jsonPath("$.results[0].item.value").value("app-1"))
            .andExpect(jsonPath("$.results[1].value").value("missing"))
            .andExpect(jsonPath("$.results[1].item").value(nullValue()));
    }

    @Test void optionalRoutesAreTyped501Problems() throws Exception {
        mvc.perform(post("/_gauntlet/v1/runs/run-1/cancel")).andExpect(status().isNotImplemented())
            .andExpect(content().contentTypeCompatibleWith("application/problem+json"))
            .andExpect(jsonPath("$.capability").value("tc-run-cancellation@1"));
        mvc.perform(get("/_gauntlet/v1/runs/run-1/events")).andExpect(status().isNotImplemented())
            .andExpect(jsonPath("$.capability").value("tc-run-sse@1"));
        mvc.perform(post("/_gauntlet/v1/uploads")).andExpect(status().isNotImplemented())
            .andExpect(jsonPath("$.capability").value("tc-uploads@1"));
        mvc.perform(post("/_gauntlet/v1/runs/run-1/artifacts/launch-1/launch"))
            .andExpect(status().isNotImplemented())
            .andExpect(jsonPath("$.capability").value("tc-session-launch@1"));
    }

    private String fixtureRevision() throws Exception {
        var body = mvc.perform(get("/_gauntlet/v1/operations/applications.finalize"))
            .andExpect(status().isOk()).andReturn().getResponse().getContentAsByteArray();
        return objectMapper.readTree(body).required("revision").asText();
    }
}
```

The same Spring RED step adds the remaining boundary cases with exact
assertions: `GET /health` is 200 and schema-shaped; a safe unknown operation is
its typed 404; two valid create requests carrying the same key for the
fixture's `OPTIONAL` policy return the same run ID, execute once, and polling
exposes sequence/timestamps, progress, summary, output, artifacts, and actions;
query returns a canonical `DataSourcePage`; `unsafe!id` is 400 `invalid-path`;
and an input that makes the fixture handler throw produces a 201 failed Run
whose nested Problem is sanitized
`urn:gauntlet:problem:handler-failed`. A separate
`AdapterDisabledHttpTest` uses the same
`FixtureApplication` with `gauntlet.enabled=false`, calls `/manifest`, and
asserts typed 503 before the catalog is touched.

The MockMvc suite is package-level boundary coverage, not conformance. It also
proves a disabled prefix wins over an unsafe raw target, malformed JSON, wrong
method, and bodyless upload before any catalog, controller, or multipart code;
every raw dynamic position is exercised. A second context installs one SPI at
a time and proves the manifest advertises exactly that capability and the route
returns cancel 202, event stream 200, upload 201, or session launch 201. All
controller/filter/exception-handler classes imported by auto-configuration are
`public`; package-private Spring components are forbidden.

A parameterized application-context/MVC matrix starts all 16 installed-SPI
bitmasks without ambiguous mappings. For every mask, the one
`CapabilityController` owns all four canonical paths exactly once; each bit
returns 202/200/201/201 when installed and the exact early 501 when absent,
while the manifest capability set equals the mask.

The separate `spring-example` is the only live conformance fixture. It applies
Spring Boot 4.1.1, depends on the local starter, and registers exact IDs
`agency-applications.finalize` and `pending-applications` from the unchanged
scenario. Its operation requires UUID `applicationId`, secret six-digit
`confirmationCode`, required idempotency, the three required profiles, and rich output;
its data source validates complete `/workflowState` dependencies/context,
implements pagination and ordered resolve, and accepts empty-string/empty-list
values. The fixture does not copy `operation.valid.json` or
`manifest.valid.json`; golden unit fixtures intentionally have different IDs.
It emits complete protocol models through production serializers and is tested
only through live HTTP by the shared P0 runner.

- [ ] **Step 2: Run the HTTP boundary tests and verify they fail before controllers exist**

Run: `docker run --rm --user "$(id -u):$(id -g)" -e GRADLE_USER_HOME=/tmp/gradle -v "$PWD/packages/java:/workspace" -v "$PWD/packages/protocol:/protocol" -w /workspace gradle:9.2.1-jdk21 ./gradlew -DgauntletProtocolFixtures=/protocol/fixtures/v1 :spring-boot-starter:test --tests dev.eightlines.gauntlet.spring.AdapterV1HttpTest --tests dev.eightlines.gauntlet.spring.AdapterDisabledHttpTest`

Expected: FAIL with 404 routes, missing controller classes, or missing protocol-shaped catalog output.

- [ ] **Step 3: Implement all controllers, envelope validation, and sanitized error responses**

```kotlin
// append to packages/java/spring-boot-starter/build.gradle.kts
val protocolFixtures = providers.systemProperty("gauntletProtocolFixtures")
sourceSets.named("test") {
    resources.srcDir(protocolFixtures)
}
tasks.named("test") {
    doFirst {
        require(protocolFixtures.isPresent) {
            "-DgauntletProtocolFixtures must name the mounted protocol fixture directory"
        }
    }
}
```

Every Task 8+ Gradle command supplies this property and mounts that exact
directory, so a missing mount fails resource processing rather than silently
falling back to a forked fixture.

```java
@RestController
@RequestMapping("/_gauntlet/v1")
public final class AdapterV1Controller {
    @GetMapping("/health") public ResponseEntity<JsonObject> health();
    @GetMapping("/manifest") public ResponseEntity<?> manifest(@RequestHeader(name = "If-None-Match", required = false) String etag);
    @GetMapping("/operations/{operationId}") public ResponseEntity<?> definition(@PathVariable String operationId,
        @RequestHeader(name = "If-None-Match", required = false) String etag);
    @PostMapping("/operations/{operationId}/runs") public ResponseEntity<?> createRun(
        @PathVariable String operationId, @RequestBody tools.jackson.databind.JsonNode body);
    @GetMapping("/runs/{runId}") public ResponseEntity<?> run(@PathVariable String runId);
    @PostMapping("/data-sources/{dataSourceId}/query") public ResponseEntity<?> query(
        @PathVariable String dataSourceId, @RequestBody tools.jackson.databind.JsonNode body);
    @PostMapping("/data-sources/{dataSourceId}/resolve") public ResponseEntity<?> resolve(
        @PathVariable String dataSourceId, @RequestBody tools.jackson.databind.JsonNode body);
}
```

`GauntletAutoConfiguration` imports `AdapterV1Controller`,
`CapabilityController`,
`ProtocolExceptionHandler`, and `RawAdapterPrefixFilter` explicitly after the
Task 8 classes exist; it still performs no component scan. The filter is a
highest-precedence `FilterRegistrationBean`, reads the undecoded request URI
and query string, and for every adapter-prefix request applies disabled 503
first, then raw path/method validation. `RawAdapterPrefixFilter` consults
`SpringCapabilityRegistry` and completes an absent capability with the exact
early 501 before multipart resolution or run/artifact lookup; when present it
continues to the single controller mapping and matching SPI. Controllers never
duplicate or weaken that gate.

`RequestEnvelopeValidator` converts Jackson 3 `JsonNode` into owned core JSON,
accepts only exact closed envelope fields, applies canonical endpoint schemas,
then the injected `SchemaValidator` to raw operation input/context and complete
data-source dependencies/context before record binding. Jackson 3 is configured
with unknown-property failure and no coercion/default mutation. Jakarta
violations become normalized JSON Pointers and never echo values.

The controller uses only `SpringAdapterCatalog` methods and fixed paths. No
request field names a Java bean. Create consults the catalog's authoritative
summary availability before `RequestEnvelopeValidator`, record binding, core
`RunManager`, store, or handler; the final catalog create rechecks it. Missing
profile/SPI tests assert the exact manifest Problem and zero validator/mapper/
file-validator/store/scheduler/handler calls. Create returns 201 only for a terminal Run and
202 while active; a handler exception is a sanitized failed Run. Before
serialization, output and data-source responses pass schema/shared semantics
plus secret/file/action/store guards. Strong ETags are exact quoted revisions;
304 is bodyless with no content type. `ProblemResponseFactory` emits only safe
RFC 9457 extensions. `ProtocolExceptionHandler` maps invalid JSON/path/media,
safe missing resources, and unexpected errors without exception or secret text;
production Jackson imports are exclusively `tools.jackson.*`.

```kotlin
// packages/java/spring-example/build.gradle.kts
plugins { id("org.springframework.boot") version "4.1.1" }

dependencies {
    implementation(project(":spring-boot-starter"))
    implementation(platform("org.springframework.boot:spring-boot-dependencies:4.1.1"))
    implementation("org.springframework.boot:spring-boot-starter-webmvc")
    implementation("org.springframework.boot:spring-boot-starter-validation")
}

springBoot { mainClass = "dev.eightlines.gauntlet.example.FixtureApplication" }
```

The live application's configuration binds `0.0.0.0:8080`, explicitly enables
the adapter, and sets valid application ID/label/environment plus only the
three implemented profiles. It does not configure core capability strings;
the example intentionally installs no optional SPI so the runner exercises all
four early 501 responses. A separate starter integration context installs each
SPI to cover advertised success.


- [ ] **Step 4: Run package tests and the live Spring P0 runner**

```sh
docker run --rm --user "$(id -u):$(id -g)" -e GRADLE_USER_HOME=/tmp/gradle \
  -v "$PWD/packages/java:/workspace" -v "$PWD/packages/protocol:/protocol" \
  -w /workspace gradle:9.2.1-jdk21 \
  ./gradlew -DgauntletProtocolFixtures=/protocol/fixtures/v1 \
  --write-verification-metadata sha256 :spring-example:dependencies
docker run --rm --user "$(id -u):$(id -g)" -e GRADLE_USER_HOME=/tmp/gradle \
  -v "$PWD/packages/java:/workspace" -v "$PWD/packages/protocol:/protocol" \
  -w /workspace gradle:9.2.1-jdk21 \
  ./gradlew -DgauntletProtocolFixtures=/protocol/fixtures/v1 \
  :core:test :spring-boot-starter:test :spring-example:bootJar

container_name="gauntlet-spring-conformance-$$"
cleanup_spring() { docker rm -f "$container_name" >/dev/null 2>&1 || true; }
trap cleanup_spring EXIT INT TERM
docker run -d --name "$container_name" -p 127.0.0.1::8080 \
  -v "$PWD/packages/java:/workspace:ro" gradle:9.2.1-jdk21 \
  java -jar /workspace/spring-example/build/libs/spring-example-0.1.0-SNAPSHOT.jar
host_port="$(docker port "$container_name" 8080/tcp | sed -n 's/.*://p' | tail -1)"
test -n "$host_port"
ready=''
for attempt in $(seq 1 60); do
  if node -e 'fetch(process.argv[1]).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))' \
    "http://127.0.0.1:${host_port}/_gauntlet/v1/health"; then ready=1; break; fi
  sleep 1
done
test "$ready" = 1
GAUNTLET_ADAPTER_URL="http://127.0.0.1:${host_port}" \
  GAUNTLET_SCENARIO=conformance/scenarios/adapter-v1.json \
  pnpm conformance:adapter-v1
```

Expected: PASS. The Java packages consume mounted shared vectors without
copying them, and the external runner validates a real Spring HTTP process with
the exact P0 IDs. Package acceptance additionally covers disabled/raw-prefix
precedence, sanitized handler failure, pagination, installed optional SPI
success, absent-capability early 501s, custom bean binding only through the
normalized route, context lease closure, concurrent HMAC idempotency, and no
secret in captured responses.

- [ ] **Step 5: Commit Spring transport and conformance tests**

```bash
git add packages/java
git commit -m "feat(java-spring): expose complete gauntlet adapter v1"
```

### Task 9: Run Cross-SDK Validation Commands and Record Consumer Entry Points

**Files:**
- Create: `packages/typescript/node/README.md`
- Create: `packages/typescript/node/test/package-surface.test.ts`
- Modify: `packages/typescript/next/README.md`
- Create: `packages/java/README.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: accepted Node/Next live fixtures and, only after the JCS gate,
  completed Java/Spring packages/live fixture.
- Produces: reproducible validation commands and concise, non-UI consumer integration instructions.

- [ ] **Step 1: Add the package-surface regression check**

```ts
// packages/typescript/node/test/package-surface.test.ts
test("public Node package exports only the Web handler API", async () => {
  const exported = Object.keys(await import("../src/index.js")).sort();
  assert.deepEqual(exported, ["createAdapterFetchHandler"]);
});
```

The runtime export remains exactly `createAdapterFetchHandler`; a compile-time
surface test separately imports `AdapterRequestBoundary`,
`AdapterFetchHandler`, and `AdapterFetchHandlerOptions` with `import type`.
Core—not Node—owns the concrete Ajv validator export.

- [ ] **Step 2: Run the focused public-surface regression check**

Run: `pnpm --filter @8lines/gauntlet-typescript-node exec tsx --test test/package-surface.test.ts`

Expected: PASS because Task 2 already established the single public runtime export; this locks that boundary before documentation and aggregate scripts are added.

- [ ] **Step 3: Finalize package entry points, validation scripts, and documentation**

```json
{
  "scripts": {
    "validate:sdk": "pnpm --filter @8lines/gauntlet-typescript-core test && pnpm --filter @8lines/gauntlet-typescript-node test && pnpm --filter @8lines/gauntlet-next-adapter test && pnpm --filter @8lines/gauntlet-node-example test && pnpm --filter @8lines/gauntlet-next-example build && pnpm --filter @8lines/gauntlet-next-example test && docker run --rm --user \"$(id -u):$(id -g)\" -e GRADLE_USER_HOME=/tmp/gradle -v \"$PWD/packages/java:/workspace\" -v \"$PWD/packages/protocol:/protocol\" -w /workspace gradle:9.2.1-jdk21 ./gradlew -DgauntletProtocolFixtures=/protocol/fixtures/v1 :core:check :spring-boot-starter:check :spring-example:bootJar"
  }
}
```

The Node README shows `createAdapterFetchHandler({ enabled:
process.env.GAUNTLET_ENABLED === "true", catalog })` mounted only on the
adapter prefix, the native `request`/untouched `rawTarget` wiring, mandatory
bounded `clientError` integration, and Core's public local Ajv validator. The
Next README retains all seven method exports, mandates trusted ingress, and
states fixed ingress 400 for parser errors even when the upstream is disabled;
it never claims native raw-target equivalence. The Java README gives
coordinates, annotations, required enabled application metadata, local schema
resources, stable idempotency secret requirements, launcher/runtime test setup,
the exact semantic-vector integrity gate, the pinned Apache-2.0 source receipt,
and Docker commands. No JCS Maven artifact is documented.
All SDK docs state internal-only ingress, explicit enablement, no dashboard UI,
and the implementation order PHP/Symfony → Node/Next → Java/Spring.

- [ ] **Step 4: Run the full TypeScript and Java validation suite**

Run:

```bash
pnpm check
pnpm validate:sdk
docker run --rm --user "$(id -u):$(id -g)" -e GRADLE_USER_HOME=/tmp/gradle -v "$PWD/packages/java:/workspace" -v "$PWD/packages/protocol:/protocol" -w /workspace gradle:9.2.1-jdk21 ./gradlew -DgauntletProtocolFixtures=/protocol/fixtures/v1 :core:check :spring-boot-starter:check
```

Expected: PASS. This runs all workspace TypeScript tests/builds, both live
TypeScript fixtures, then Java core/starter/example checks in Docker and
confirms the public Node entry point remains framework-neutral.

- [ ] **Step 5: Commit validation and package documentation**

```bash
git add package.json packages/typescript/node/README.md packages/typescript/node/test/package-surface.test.ts packages/typescript/next/README.md packages/java/README.md
git commit -m "docs(sdk): add adapter validation and integration guides"
```

## Plan Self-Review

- **Spec coverage:** Tasks 1–3 implement shared semantics/schema validation,
  complete Node v1 paths, raw/disabled gating, exact statuses, HMAC-backed runs,
  data sources, and SPI-derived capabilities. Task 4 provides the UI-free Next
  bridge with all method exports. Task 5 proves native Node and a real Next
  process through live P0 HTTP. Tasks 6–8, only after the JCS gate, port the
  already-proven contract to Java/Spring and run the same P0 scenario against a
  real Spring process. Task 9 locks validation and consumer instructions.
- **Deliberate deferrals retained from the approved spec:** no dashboard,
  authorization, production enablement, bundled production implementations of
  upload/cancel/SSE SPIs, Kubernetes discovery, persistent run store, arbitrary
  schema-to-Java binding, SQL/editor/command dispatch, or automatic
  application-route exposure.
- **Consistency checks:** Node and Spring use the same route/status/media table;
  optional capability IDs are exact and derived only from matching SPIs; every
  unadvertised optional endpoint returns early typed 501; both adapters own
  runs, validate raw input/context/data-source/output, preserve strong
  ETags/revisions and Problem media, and pass exact shared semantics/vectors.
- **Explicit JCS maintenance gate:** Java carries no JCS Maven dependency. Its
  exact two-file Apache-2.0 source receipt, notices, 16 checked-in rows, six
  upstream pairs, Appendix B, iterative 4,097-level check, and opt-in
  100,000,000-row corpus are release gates. A source-pin change is an
  architecture review event; no output formatter or patch is authorized.
