# Gauntlet TypeScript Core

Framework-neutral registries and runtime for an application's explicitly
registered Gauntlet features, operations, data sources, runs, and optional
capabilities. This package does not expose HTTP routes or a dashboard and does
not discover arbitrary application handlers, commands, URLs, or database
queries.

Use it only in selected non-production environments. A Node or Next transport
can expose the resulting `AdapterCatalog` at `/_gauntlet/v1`.

## Install

Release consumers install matching exact versions from the public npm registry
(no registry configuration or token is needed; see
[installing packages](../../../docs/releases/installing-packages.md)):

```sh
pnpm add @8lines/gauntlet-protocol@0.1.1 \
  @8lines/gauntlet-typescript-core@0.1.1
```

Inside this repository, workspace packages use `workspace:*` dependencies and
run `pnpm install` from the repository root:

```json
{
  "dependencies": {
    "@8lines/gauntlet-protocol": "workspace:*",
    "@8lines/gauntlet-typescript-core": "workspace:*"
  }
}
```

For offline release verification, build and pack both packages:

```sh
mkdir -p /tmp/gauntlet-packages
pnpm --filter @8lines/gauntlet-protocol build
pnpm --filter @8lines/gauntlet-typescript-core build
pnpm --filter @8lines/gauntlet-protocol pack --pack-destination /tmp/gauntlet-packages
pnpm --filter @8lines/gauntlet-typescript-core pack --pack-destination /tmp/gauntlet-packages
```

Reference both tarballs from the consumer's `package.json`:

```json
{
  "dependencies": {
    "@8lines/gauntlet-protocol": "file:/tmp/gauntlet-packages/8lines-gauntlet-protocol-0.1.1.tgz",
    "@8lines/gauntlet-typescript-core": "file:/tmp/gauntlet-packages/8lines-gauntlet-typescript-core-0.1.1.tgz"
  }
}
```

Pin Core's transitive protocol dependency to the same tarball in an offline
consumer's `pnpm-workspace.yaml`:

```yaml
overrides:
  '@8lines/gauntlet-protocol': 'file:/tmp/gauntlet-packages/8lines-gauntlet-protocol-0.1.1.tgz'
```

Then run:

```sh
pnpm install
```

Add `@8lines/gauntlet-typescript-node` for a native Node host or
`@8lines/gauntlet-next-adapter` for an App Router bridge.

## Build a catalog

The complete, compile-checked reference is
[`catalog-example.ts`](../../../examples/typescript-fixture/src/catalog-example.ts).
It demonstrates the whole application-side composition in one file:

1. `OperationRegistry` owns feature groups and operations created only with
   `defineOperation()`.
2. `DataSourceRegistry` owns bounded query/resolve providers used by rich UI
   controls.
3. `RunManager` validates requests and persists immutable Run snapshots.
4. `CapabilityRegistry` advertises only endpoint SPIs that the application
   actually installs.
5. `createAdapterCatalog()` exposes the validated, framework-neutral API that
   an HTTP adapter consumes.

The important shape is:

```ts
const operations = new OperationRegistry();
operations.registerFeature({ id: "applications", label: "Applications" });
operations.register(defineOperation({
  id: "applications.change-state",
  label: "Change application state",
  featureId: "applications",
  order: 10,
  tags: ["applications", "workflow"],
  requirements: {
    profiles: ["tc-schema-core@1", "tc-rich-forms@1", "tc-rich-results@1"],
    capabilities: ["tc-run-cancellation@1"],
  },
  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    required: ["applicationId", "workflowState", "effectiveAt", "notify"],
    properties: {
      applicationId: { type: "string", minLength: 1 },
      workflowState: { type: "string", enum: ["pending", "approved", "blocked"] },
      effectiveAt: { type: "string", format: "date-time" },
      notify: { type: "boolean", default: false },
      reason: { type: "string", minLength: 3, maxLength: 500 },
    },
    additionalProperties: false,
  },
  uiSchema: {
    profile: "tc-rich-forms@1",
    root: {
      type: "group",
      label: "Workflow change",
      children: [
        {
          type: "columns",
          children: [
            {
              type: "field",
              pointer: "/applicationId",
              widget: "autocomplete",
              dataSourceId: "pending-applications",
            },
            { type: "field", pointer: "/workflowState", widget: "select" },
          ],
        },
        { type: "field", pointer: "/effectiveAt", widget: "date-time" },
        { type: "field", pointer: "/notify", widget: "toggle" },
        {
          type: "field",
          pointer: "/reason",
          widget: "textarea",
          visibleWhen: {
            op: "in",
            pointer: "/workflowState",
            values: ["approved", "blocked"],
          },
        },
      ],
    },
  },
  dataSources: [{
    id: "pending-applications",
    inputPointer: "/applicationId",
    dependencyPointers: ["/workflowState"],
    required: true,
  }],
  presets: [{
    id: "return-to-pending",
    label: "Return to pending",
    input: { workflowState: "pending", notify: false },
    lockedPointers: ["/workflowState"],
  }],
  execution: {
    impact: "write",
    confirmationRequired: true,
    dryRunSupported: false,
    idempotency: "required",
    cancellationSupported: true,
    timeoutSeconds: 120,
    concurrency: "queue",
  },
  output: {
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
    },
    presentation: { profile: "tc-rich-results@1", defaultView: "summary" },
  },
}, async (input, context) => {
  context.report({ phase: "changing-state", current: 0, total: 1 });
  // Call one explicit application service here.
  return { output: input };
}));
```

The linked source supplies the complete typed handler and output schema. It
also registers `pending-applications` with search, cursor limits, ordered
resolve behavior, and a dependency schema keyed by the JSON Pointer
`/workflowState`. The dashboard can therefore render and refresh the
autocomplete without knowing application-specific APIs.

Do not make a generic operation that accepts a class, command, route, SQL, or
URL name. Each operation handler and data source is an explicit allow-listed
application binding.

## Run storage and idempotency

Construct the manager with the same validator used by the catalog:

```ts
const schemaValidator = new AjvSchemaValidator();
const runs = new RunManager(operations, sharedRunStore, {
  validateSchema: ({ schema, value }) => schemaValidator.validate(schema, value),
  validateFileReference: () => [], // replace when file input rules are registered
  idempotencySecret,
});
```

`idempotencySecret` must contain at least 32 high-entropy bytes. Configure the
same stable value for every process, worker, pod, and restart that shares a
store. There is no generated or random fallback: construction fails when the
secret is missing, has the wrong runtime type, or is shorter than 32 bytes.
Load it from deployment-owned secret storage, decode it into a `Uint8Array`,
and discard the source string after construction. Never log the source string,
decoded bytes, or raw idempotency keys. `RunManager` defensively copies the
bytes and HMAC-fingerprints raw idempotency keys before calling the store; raw
keys must never be persisted or logged.

`InMemoryRunStore` is suitable only for tests and a genuinely single-process
development host. Multiple workers or pods require an application-owned
database/Redis implementation of `RunStore` shared by every replica. Its
`create(run, idempotencyFingerprint)` operation must atomically reserve both the queued
Run and the operation-scoped fingerprint, throwing
`DuplicateIdempotencyKeyError` on a uniqueness race. `get`,
`findByIdempotencyKey`, and `update` must return/persist complete canonical Run
snapshots. `update(next, expectedPreviousSequence)` is a required atomic
compare-and-set: throw `RunStoreConflictError` when the stored sequence differs
and never mutate the winner. Do not deploy replicas with independent in-memory
stores.

## Execution policy and coordination

`RunManager` enforces each operation's `execution` policy. Missing
`concurrency` and `"allow"` admit handlers independently. `"forbid"` returns
the fixed 409 `operation-busy` Problem while another run of that operation is
queued or running; a concurrent request with the same idempotency key still
replays its original run. `"queue"` admits runs in FIFO order and starts one
handler at a time. `timeoutSeconds` starts when the run enters `running`,
aborts `RunContext.signal`, and persists one `timed_out` terminal snapshot.

Cancellation and timeout close the context immediately, so late progress,
artifacts, actions, logs, warnings, and results are ignored. JavaScript cannot
forcibly stop arbitrary application code: a handler that ignores its
`AbortSignal` keeps the queue/forbid execution lease until its Promise actually
settles. Handlers should observe `context.signal` or call
`context.throwIfCancelled()` around application-service boundaries.

The optional `schedule` hook receives a process-local, revocable, one-shot
function. It may retain that function only for local deferred execution; it
must never serialize it, place it on a durable/general-purpose queue, or report
acceptance and then drop it. Invoke it at least once after acceptance; repeated
or concurrent calls are safe no-ops. The runtime releases captured input,
secret guards, and invocation context when the task starts or is revoked by a
failed/cancelled reservation, even if the scheduler keeps its function object.
Throw synchronously from `schedule` when ownership cannot be accepted.

The default `InMemoryExecutionCoordinator` coordinates only one JavaScript
process. It is suitable for tests and a single-process development host. A
multi-worker or multi-pod adapter must inject one shared
`ExecutionCoordinator` that provides distributed admission/FIFO leases and
cancellation publication (for example through database locks plus pub/sub):

```ts
const runs = new RunManager(operations, sharedRunStore, {
  validateSchema: ({ schema, value }) => schemaValidator.validate(schema, value),
  validateFileReference: validateUploadReference,
  idempotencySecret,
  executionCoordinator: sharedExecutionCoordinator,
});
```

The coordinator's `commitAdmission()` boundary follows the durable
`RunStore.create`; admission conflicts wait for that decision before returning
busy or replaying an idempotent run. Coordinator cancellation must reach the
lease's `signal` in every replica. This SPI is deliberately separate from
`RunStore`, so a deployment can use the same database for both without making
the in-memory default look globally safe. A local timeout closes and
terminalizes its run without waiting for cancellation publication; coordinator
publication is best-effort for notifying other replicas and must not be used as
the local timeout acknowledgement.

## Optional capability SPIs

Uploads, SSE, and session launch are advertised only when their typed endpoint
is registered. A real `RunManager` automatically advertises managed
`tc-run-cancellation@1`; an optional cancellation endpoint remains a fallback
for run IDs owned outside that manager:

```ts
const capabilities = new CapabilityRegistry();
capabilities.registerCancellation(externalCancellationFallback); // optional
capabilities.registerEvents(runEventsEndpoint);
capabilities.registerUploads(uploadEndpoint);
capabilities.registerSessionLaunch(sessionLaunchEndpoint);
```

The matching capabilities are `tc-run-cancellation@1`, `tc-run-sse@1`,
`tc-uploads@1`, and `tc-session-launch@1`. An absent optional SPI stays
unadvertised and the transport returns the protocol's fixed 501 response.
Endpoint results are treated as untrusted and validated before crossing the
adapter boundary.
`registerProvider()` may advertise a non-core capability requirement, but it
does not create a custom HTTP executor.

## Expose the catalog

Pass the completed catalog to exactly one transport. The native Node example
preserves the raw request target; the Next bridge requires a trusted ingress
because Next normalizes the request before the route handler sees it.

- [Node adapter integration](../node/README.md)
- [Next.js App Router integration](../next/README.md)
- [live conformance catalog](../../../examples/typescript-fixture/src/index.ts)

## Verify

From the repository root:

```sh
pnpm --filter @8lines/gauntlet-typescript-core typecheck
pnpm --filter @8lines/gauntlet-typescript-core test
pnpm --filter @8lines/gauntlet-typescript-core build
pnpm --filter @8lines/gauntlet-typescript-core test:package
pnpm --filter @8lines/gauntlet-typescript-fixture typecheck
```

[Documentation index](../../../docs/README.md)
