import assert from "node:assert/strict";
import test from "node:test";
import {
  AdapterCatalogError, CapabilityRegistry, DataSourceRegistry, OperationRegistry, createAdapterCatalog, defineOperation,
  createAjvSchemaValidator,
} from "../src/index.js";

function catalog(
  requirements: { capabilities?: readonly `${string}@${number}`[] } = {},
  configure?: (capabilities: CapabilityRegistry, revision: string) => void,
  runsOverride?: object,
) {
  const operations = new OperationRegistry();
  operations.registerFeature({ id: "fixture", label: "Fixture" });
  const operation = defineOperation({ id: "fixture.run", label: "Run", featureId: "fixture", order: 1, tags: [], requirements,
    inputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" }, dataSources: [], presets: [],
    execution: { impact: "read", confirmationRequired: false, dryRunSupported: false, idempotency: "none", cancellationSupported: false },
    output: { schema: { $schema: "https://json-schema.org/draft/2020-12/schema" } }, }, () => ({ output: null }));
  operations.register(operation);
  let creates = 0;
  const runs = runsOverride ?? {
    create: async () => { creates += 1; return { ok: true as const, run: {} }; },
    get: async () => undefined,
  };
  const capabilities = new CapabilityRegistry();
  configure?.(capabilities, operation.definition.revision);
  const value = createAdapterCatalog({ application: { id: "fixture", label: "Fixture", environment: { name: "fixture-test", kind: "test" } }, profiles: ["tc-schema-core@1"], capabilities, operations, dataSources: new DataSourceRegistry(), runs: runs as never, schemaValidator: createAjvSchemaValidator() });
  return { value, capabilities, creates: () => creates };
}

test("unavailable summary stops create before the run manager", async () => {
  const fixture = catalog({ capabilities: ["tc-uploads@1"] });
  const summary = fixture.value.manifest().operations[0]!;
  const result = await fixture.value.createRun("fixture.run", {} as never);
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.problem, summary.availability.state === "unavailable" ? summary.availability.problem : undefined);
  assert.equal(fixture.creates(), 0);
});

test("profile and Core SPI availability is authoritative and exact", async () => {
  const missingProfile = catalog({ profiles: ["tc-rich-forms@1"] } as never);
  assert.equal(missingProfile.value.manifest().operations[0]?.availability.state, "unavailable");

  const missingUpload = catalog({ capabilities: ["tc-uploads@1"] });
  const summary = missingUpload.value.manifest().operations[0]!;
  assert.equal(summary.availability.state, "unavailable");
  const rejected = await missingUpload.value.createRun("fixture.run", {} as never);
  assert.equal(rejected.ok, false);
  if (!rejected.ok && summary.availability.state === "unavailable") {
    assert.strictEqual(rejected.problem, summary.availability.problem);
  }

  const available = catalog({ capabilities: ["tc-uploads@1"] }, (capabilities) => {
    capabilities.registerUploads({
      create: () => ({
        file: {
          kind: "file",
          uploadId: "upload-1",
          name: "fixture.txt",
          mediaType: "text/plain",
          sizeBytes: 1,
          expiresAt: "2026-08-29T01:00:00Z",
        },
      }),
    });
  });
  assert.equal(available.value.manifest().operations[0]?.availability.state, "available");
  await available.value.createRun("fixture.run", {} as never);
  assert.equal(available.creates(), 1);
});

test("catalog omits an operation with an unregistered data-source binding", () => {
  const operations = new OperationRegistry();
  operations.registerFeature({ id: "fixture", label: "Fixture" });
  operations.register(defineOperation({
    id: "fixture.run",
    label: "Run",
    featureId: "fixture",
    order: 1,
    tags: [],
    inputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" },
    dataSources: [{
      id: "missing-source",
      inputPointer: "/applicationId",
      dependencyPointers: [],
    }],
    presets: [],
    execution: {
      impact: "read",
      confirmationRequired: false,
      dryRunSupported: false,
      idempotency: "none",
      cancellationSupported: false,
    },
    output: { schema: { $schema: "https://json-schema.org/draft/2020-12/schema" } },
  }, () => ({ output: null })));
  const value = createAdapterCatalog({
    application: { id: "fixture", label: "Fixture", environment: { name: "fixture-test", kind: "test" } },
    profiles: ["tc-schema-core@1"],
    capabilities: new CapabilityRegistry(),
    operations,
    dataSources: new DataSourceRegistry(),
    runs: { create: async () => { throw new Error("unreachable"); }, get: async () => undefined } as never,
    schemaValidator: createAjvSchemaValidator(),
  });
  assert.deepEqual(value.manifest().operations, []);
  assert.deepEqual(value.manifest().diagnostics, [{
    severity: "error",
    code: "invalid-operation-binding",
    message: "The operation binding is invalid and was omitted.",
    operationId: "fixture.run",
  }]);
  assert.equal(value.operation("fixture.run"), undefined);
});

test("all optional public dispatches return their installed endpoint values", async () => {
  const fixture = catalog({}, (capabilities, revision) => {
    const run = {
      id: "run-1",
      operationId: "fixture.run",
      operationRevision: revision,
      sequence: 0,
      state: "queued",
      createdAt: "2026-08-29T00:00:00Z",
      updatedAt: "2026-08-29T00:00:00Z",
      artifacts: [],
      actions: [],
    } as never;
    capabilities.registerCancellation({ cancel: () => run });
    capabilities.registerEvents({
      events: async function* () {
        yield {
          id: "event-1",
          sequence: 0,
          occurredAt: "2026-08-29T00:00:00Z",
          type: "run.updated",
          run,
        } as never;
      },
    });
    capabilities.registerUploads({
      create: async () => ({
        file: {
          kind: "file",
          uploadId: "upload-1",
          name: "fixture.txt",
          mediaType: "text/plain",
          sizeBytes: 7,
          expiresAt: "2026-08-29T01:00:00Z",
        },
      }),
    });
    capabilities.registerSessionLaunch({
      create: () => ({
        url: "https://example.test/session",
        expiresAt: "2026-08-29T01:00:00Z",
        singleUse: true,
      }),
    });
  });
  for (const capability of [
    "tc-run-cancellation@1",
    "tc-run-sse@1",
    "tc-uploads@1",
    "tc-session-launch@1",
  ] as const) assert.deepEqual(fixture.value.capabilityAvailability(capability), { supported: true });
  assert.equal((await fixture.value.cancelRun("run-1")).ok, true);
  const events = await fixture.value.runEvents("run-1");
  assert.equal(events.ok, true);
  if (events.ok) {
    const values = [];
    for await (const event of events.value) values.push(event);
    assert.equal(values.length, 1);
  }
  assert.equal((await fixture.value.createUpload(new Blob())).ok, true);
  assert.equal((await fixture.value.launchSession("run-1", "artifact-1")).ok, true);
});

test("catalog bridges an advertised cancellation route to RunManager Problems", async () => {
  let fallbackCalls = 0;
  const fixture = catalog({}, (capabilities, revision) => {
    capabilities.registerCancellation({
      cancel: () => {
        fallbackCalls += 1;
        return {
          id: "fallback-run",
          operationId: "fixture.run",
          operationRevision: revision,
          sequence: 0,
          state: "queued",
          createdAt: "2026-08-29T00:00:00Z",
          updatedAt: "2026-08-29T00:00:00Z",
          artifacts: [],
          actions: [],
        };
      },
    });
  }, {
    create: async () => { throw new Error("unreachable"); },
    get: async () => undefined,
    cancel: async () => ({
      type: "urn:gauntlet:problem:run-not-cancellable",
      title: "Run is not cancellable",
      status: 409,
    }),
  });

  assert.deepEqual(await fixture.value.cancelRun("run-1"), {
    ok: false,
    problem: {
      type: "urn:gauntlet:problem:run-not-cancellable",
      title: "Run is not cancellable",
      status: 409,
    },
  });
  assert.equal(fallbackCalls, 0);
});

test("catalog advertises managed cancellation without a dummy capability endpoint", async () => {
  const fixture = catalog({}, undefined, {
    create: async () => { throw new Error("unreachable"); },
    get: async () => undefined,
    cancel: async () => ({
      type: "urn:gauntlet:problem:run-not-cancellable",
      title: "Run is not cancellable",
      status: 409,
    }),
  });

  assert.equal(fixture.value.manifest().capabilities.includes("tc-run-cancellation@1"), true);
  assert.deepEqual(fixture.value.capabilityAvailability("tc-run-cancellation@1"), {
    supported: true,
  });
  assert.deepEqual(await fixture.value.cancelRun("run-1"), {
    ok: false,
    problem: {
      type: "urn:gauntlet:problem:run-not-cancellable",
      title: "Run is not cancellable",
      status: 409,
    },
  });
});

test("catalog uses a custom cancellation endpoint only after managed run-not-found", async () => {
  let managedCalls = 0;
  let fallbackCalls = 0;
  const fixture = catalog({}, (capabilities, revision) => {
    capabilities.registerCancellation({
      cancel: () => {
        fallbackCalls += 1;
        return {
          id: "fallback-run",
          operationId: "fixture.run",
          operationRevision: revision,
          sequence: 0,
          state: "queued",
          createdAt: "2026-08-29T00:00:00Z",
          updatedAt: "2026-08-29T00:00:00Z",
          artifacts: [],
          actions: [],
        };
      },
    });
  }, {
    create: async () => { throw new Error("unreachable"); },
    get: async () => undefined,
    cancel: async () => {
      managedCalls += 1;
      return {
        type: "urn:gauntlet:problem:run-not-found",
        title: "Run not found",
        status: 404,
      };
    },
  });

  const result = await fixture.value.cancelRun("run-1");
  assert.equal(result.ok && result.value.id, "fallback-run");
  assert.equal(managedCalls, 1);
  assert.equal(fallbackCalls, 1);
});

test("managed run-not-found remains authoritative without a custom endpoint", async () => {
  const fixture = catalog({}, undefined, {
    create: async () => { throw new Error("unreachable"); },
    get: async () => undefined,
    cancel: async () => ({
      type: "urn:gauntlet:problem:run-not-found",
      title: "Run not found",
      status: 404,
    }),
  });

  assert.deepEqual(await fixture.value.cancelRun("run-1"), {
    ok: false,
    problem: {
      type: "urn:gauntlet:problem:run-not-found",
      title: "Run not found",
      status: 404,
    },
  });
});

test("catalog owns application metadata before any accessor can run", () => {
  const fixture = catalog();
  assert.equal(Object.isFrozen(fixture.value.manifest()), true);
  assert.equal(Object.isFrozen(fixture.value.manifest().application), true);
  assert.equal(Object.isFrozen(fixture.value.manifest().application.environment), true);

  let reads = 0;
  const application = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(application, "id", {
    enumerable: true,
    get() {
      reads += 1;
      return "fixture";
    },
  });
  Object.defineProperty(application, "label", {
    enumerable: true,
    value: "Fixture",
  });

  const operations = new OperationRegistry();
  const options = {
    application: application as never,
    profiles: ["tc-schema-core@1" as const],
    capabilities: new CapabilityRegistry(),
    operations,
    dataSources: new DataSourceRegistry(),
    runs: { create: async () => { throw new Error("unreachable"); }, get: async () => undefined } as never,
    schemaValidator: createAjvSchemaValidator(),
  };
  assert.throws(() => createAdapterCatalog(options), /canonical plain JSON/i);
  assert.equal(reads, 0);
});

test("catalog rejects production-like and unsupported environments before other catalog work", () => {
  const operations = new OperationRegistry();
  const common = {
    profiles: ["tc-schema-core@1" as const],
    capabilities: new CapabilityRegistry(),
    operations,
    dataSources: new DataSourceRegistry(),
    runs: { create: async () => { throw new Error("unreachable"); }, get: async () => undefined } as never,
    schemaValidator: createAjvSchemaValidator(),
  };

  for (const environment of [
    { name: "fixture-prod", kind: "test" },
    { name: "fixture-safe", kind: "production" },
  ]) {
    assert.throws(
      () => createAdapterCatalog({
        ...common,
        application: { id: "fixture", label: "Fixture", environment } as never,
      }),
      new TypeError("Invalid non-production environment descriptor"),
    );
  }

  let profileReads = 0;
  const hostileProfiles = new Proxy([], {
    ownKeys() {
      profileReads += 1;
      throw new Error("profiles must not be inspected after unsafe environment metadata");
    },
  });
  assert.throws(
    () => createAdapterCatalog({
      ...common,
      application: {
        id: "fixture",
        label: "Fixture",
        environment: { name: "fixture-live", kind: "test" },
      },
      profiles: hostileProfiles as never,
    }),
    new TypeError("Invalid non-production environment descriptor"),
  );
  assert.equal(profileReads, 0);
});

test("catalog rejects hostile data-source requests before invoking the source", async () => {
  const operations = new OperationRegistry();
  const dataSources = new DataSourceRegistry();
  let calls = 0;
  dataSources.register({
    definition: {
      id: "applications",
      label: "Applications",
      capabilities: {
        search: true,
        pagination: "cursor",
        resolve: true,
        defaultLimit: 10,
        maxLimit: 20,
      },
    },
    query: () => {
      calls += 1;
      return { items: [] };
    },
    resolve: ({ values }) => ({
      results: values.map((value) => ({ value, item: null })),
    }),
  });
  const value = createAdapterCatalog({
    application: { id: "fixture", label: "Fixture", environment: { name: "fixture-test", kind: "test" } },
    profiles: ["tc-schema-core@1"],
    capabilities: new CapabilityRegistry(),
    operations,
    dataSources,
    runs: { create: async () => { throw new Error("unreachable"); }, get: async () => undefined } as never,
    schemaValidator: createAjvSchemaValidator(),
  });
  let reads = 0;
  const request = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(request, "search", {
    enumerable: true,
    get() {
      reads += 1;
      return "Brown";
    },
  });

  await assert.rejects(() => value.queryDataSource("applications", request as never), /canonical plain JSON/i);
  assert.equal(reads, 0);
  assert.equal(calls, 0);
});

test("declared data-source schemas require complete dependencies and context", async () => {
  const dataSources = new DataSourceRegistry();
  let queries = 0;
  let resolves = 0;
  dataSources.register({
    definition: {
      id: "applications",
      label: "Applications",
      capabilities: {
        search: true,
        pagination: "cursor",
        resolve: true,
        defaultLimit: 10,
        maxLimit: 20,
      },
      dependencySchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        required: ["/region"],
        properties: { "/region": { type: "string" } },
        additionalProperties: false,
      },
      contextSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        required: ["requestId"],
        properties: { requestId: { type: "string" } },
        additionalProperties: false,
      },
    },
    query: () => {
      queries += 1;
      return { items: [] };
    },
    resolve: ({ values }) => {
      resolves += 1;
      return { results: values.map((value) => ({ value, item: null })) };
    },
  });
  const value = createAdapterCatalog({
    application: { id: "fixture", label: "Fixture", environment: { name: "fixture-test", kind: "test" } },
    profiles: ["tc-schema-core@1"],
    capabilities: new CapabilityRegistry(),
    operations: new OperationRegistry(),
    dataSources,
    runs: { create: async () => { throw new Error("unreachable"); }, get: async () => undefined } as never,
    schemaValidator: createAjvSchemaValidator(),
  });

  await assert.rejects(
    () => value.queryDataSource("applications", {}),
    (error: unknown) => error instanceof AdapterCatalogError
      && error.problem.status === 422
      && error.problem.errors?.[0]?.instancePath === "/dependencies",
  );
  await assert.rejects(
    () => value.resolveDataSource("applications", { values: [] }),
    (error: unknown) => error instanceof AdapterCatalogError
      && error.problem.status === 422
      && error.problem.errors?.[0]?.instancePath === "/dependencies",
  );
  await assert.rejects(
    () => value.queryDataSource("applications", { dependencies: { "/region": "pl" } }),
    (error: unknown) => error instanceof AdapterCatalogError
      && error.problem.status === 422
      && error.problem.errors?.[0]?.instancePath === "/context",
  );
  assert.equal(queries, 0);
  assert.equal(resolves, 0);

  await value.queryDataSource("applications", {
    dependencies: { "/region": "pl" },
    context: { requestId: "request-1" },
  });
  await value.resolveDataSource("applications", {
    values: [],
    dependencies: { "/region": "pl" },
    context: { requestId: "request-2" },
  });
  assert.equal(queries, 1);
  assert.equal(resolves, 1);
});

test("catalog fails closed before publishing a schema-invalid manifest", () => {
  const invalidOptions = [
    { application: { id: "unsafe!id", label: "Fixture", environment: { name: "fixture-test", kind: "test" } }, profiles: ["tc-schema-core@1"] },
    { application: { id: "fixture", label: "", environment: { name: "fixture-test", kind: "test" } }, profiles: ["tc-schema-core@1"] },
    { application: { id: "fixture", label: "Fixture", environment: { name: "fixture-test", kind: "test" } }, profiles: ["not-versioned"] },
  ] as const;

  for (const candidate of invalidOptions) {
    assert.throws(() => createAdapterCatalog({
      application: candidate.application,
      profiles: candidate.profiles as never,
      capabilities: new CapabilityRegistry(),
      operations: new OperationRegistry(),
      dataSources: new DataSourceRegistry(),
      runs: { create: async () => { throw new Error("unreachable"); }, get: async () => undefined } as never,
      schemaValidator: createAjvSchemaValidator(),
    }), /noncanonical|produced/i);
  }

  const capabilities = new CapabilityRegistry();
  capabilities.registerProvider({ id: "not-versioned" as never });
  assert.throws(() => createAdapterCatalog({
    application: { id: "fixture", label: "Fixture", environment: { name: "fixture-test", kind: "test" } },
    profiles: ["tc-schema-core@1"],
    capabilities,
    operations: new OperationRegistry(),
    dataSources: new DataSourceRegistry(),
    runs: { create: async () => { throw new Error("unreachable"); }, get: async () => undefined } as never,
    schemaValidator: createAjvSchemaValidator(),
  }), /noncanonical|produced/i);
});
