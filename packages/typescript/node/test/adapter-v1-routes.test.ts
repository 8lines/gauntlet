import assert from "node:assert/strict";
import test from "node:test";
import { AdapterCatalogError } from "@8lines/gauntlet-typescript-core";
import { computeRevision, type JsonObject } from "@8lines/gauntlet-protocol";
import { createAdapterFetchHandler } from "../src/index.js";
import {
  boundary,
  createFixtureCatalog,
  fixtureManifest,
  fixtureOperation,
  queuedRun,
  terminalRun,
} from "./support/fixture-catalog.js";

function jsonBoundary(method: string, target: string, value: unknown) {
  return boundary(method, target, JSON.stringify(value), { "content-type": "application/json" });
}

const hostileResponseSentinel = "HOSTILE_RESPONSE_SENTINEL";

async function assertInternalResponse(response: Response): Promise<void> {
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("content-type"), "application/problem+json; charset=utf-8");
  const text = await response.text();
  assert.doesNotMatch(text, new RegExp(hostileResponseSentinel));
  const document = JSON.parse(text) as Record<string, unknown>;
  assert.equal(document.type, "urn:gauntlet:problem:adapter-internal-error");
  assert.equal(document.status, 500);
  assert.equal(typeof document.correlationId, "string");
}

test("mandatory routes preserve statuses, ETags, replay, and safe IDs", async () => {
  const fixture = createFixtureCatalog();
  const handler = createAdapterFetchHandler({ enabled: true, catalog: fixture.catalog });

  assert.equal((await handler(boundary("GET", "/_gauntlet/v1/health"))).status, 200);
  const manifest = await handler(boundary("GET", "/_gauntlet/v1/manifest"));
  assert.equal(manifest.status, 200);
  assert.equal(manifest.headers.get("etag"), `"${fixtureManifest.manifestRevision}"`);
  const manifest304 = await handler(boundary("GET", "/_gauntlet/v1/manifest", undefined, {
    "if-none-match": manifest.headers.get("etag")!,
  }));
  assert.equal(manifest304.status, 304);
  assert.equal(manifest304.headers.get("content-type"), null);
  assert.equal(await manifest304.text(), "");

  const operation = await handler(boundary("GET", `/_gauntlet/v1/operations/${fixtureOperation.id}`));
  assert.equal(operation.status, 200);
  assert.equal(operation.headers.get("etag"), `"${fixtureOperation.revision}"`);
  assert.equal((await handler(boundary("GET", "/_gauntlet/v1/operations/missing"))).status, 404);

  const request = {
    operationRevision: fixtureOperation.revision,
    input: {},
    dryRun: false,
    idempotencyKey: "route-test-1",
  };
  const created = await handler(jsonBoundary("POST", `/_gauntlet/v1/operations/${fixtureOperation.id}/runs`, request));
  assert.equal(created.status, 202);
  const polled = await handler(boundary("GET", "/_gauntlet/v1/runs/run-1"));
  assert.equal(polled.status, 200);
  assert.deepEqual(await polled.json(), terminalRun);
  const replay = await handler(jsonBoundary("POST", `/_gauntlet/v1/operations/${fixtureOperation.id}/runs`, request));
  assert.equal(replay.status, 201);
  assert.equal((await replay.json()).id, "run-1");

  const query = await handler(jsonBoundary("POST", "/_gauntlet/v1/data-sources/applications/query", {
    search: "Brown",
    limit: 2,
  }));
  assert.equal(query.status, 200);
  const resolve = await handler(jsonBoundary("POST", "/_gauntlet/v1/data-sources/applications/resolve", {
    values: ["app-1", "missing"],
  }));
  assert.equal(resolve.status, 200);
  assert.deepEqual((await resolve.json()).results, [
    { value: "app-1", item: { value: "app-1", label: "Application 1" } },
    { value: "missing", item: null },
  ]);
  assert.equal((await handler(boundary("GET", "/_gauntlet/v1/runs/missing"))).status, 404);
  assert.equal((await handler(jsonBoundary("POST", "/_gauntlet/v1/data-sources/missing/query", {}))).status, 404);
});

test("known routes reject wrong methods and safe unknown routes remain 404", async () => {
  const handler = createAdapterFetchHandler({ enabled: true, catalog: createFixtureCatalog().catalog });
  for (const [method, target] of [
    ["POST", "/_gauntlet/v1/health"],
    ["POST", "/_gauntlet/v1/manifest"],
    ["DELETE", `/_gauntlet/v1/operations/${fixtureOperation.id}`],
    ["GET", `/_gauntlet/v1/operations/${fixtureOperation.id}/runs`],
    ["POST", "/_gauntlet/v1/runs/run-1"],
    ["GET", "/_gauntlet/v1/data-sources/applications/query"],
  ] as const) {
    const response = await handler(boundary(method, target));
    assert.equal(response.status, 405, `${method} ${target}`);
    assert.equal((await response.json()).type, "urn:gauntlet:problem:method-not-allowed");
  }
  const unknown = await handler(boundary("GET", "/_gauntlet/v1/future"));
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).type, "urn:gauntlet:problem:route-not-found");
});

test("HEAD keeps the typed status and headers but never exposes a response body", async () => {
  const handler = createAdapterFetchHandler({ enabled: true, catalog: createFixtureCatalog().catalog });
  const response = await handler(boundary("HEAD", "/_gauntlet/v1/health"));
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("content-type"), "application/problem+json; charset=utf-8");
  assert.equal(await response.text(), "");
});

test("every successful response family is validated again before serialization", async () => {
  const cases: readonly {
    readonly name: string;
    readonly capabilities?: readonly (
      | "tc-run-cancellation@1"
      | "tc-uploads@1"
      | "tc-session-launch@1"
    )[];
    readonly replace: (catalog: ReturnType<typeof createFixtureCatalog>["catalog"]) => void;
    readonly request: () => ReturnType<typeof boundary>;
  }[] = [
    {
      name: "health",
      replace: (catalog) => {
        catalog.health = () => ({
          status: "ok",
          protocolVersion: "1.0",
          hostile: hostileResponseSentinel,
        } as never);
      },
      request: () => boundary("GET", "/_gauntlet/v1/health"),
    },
    {
      name: "manifest",
      replace: (catalog) => {
        const valid = catalog.manifest();
        let calls = 0;
        catalog.manifest = () => {
          calls += 1;
          return calls === 1
            ? valid
            : ({ ...valid, hostile: hostileResponseSentinel } as never);
        };
      },
      request: () => boundary("GET", "/_gauntlet/v1/manifest"),
    },
    {
      name: "manifest nested Problem",
      replace: (catalog) => {
        const valid = catalog.manifest();
        const base = {
          ...valid,
          operations: valid.operations.map((operation) => ({
            ...operation,
            availability: {
              state: "unavailable" as const,
              problem: {
                type: "urn:gauntlet:problem:adapter-unavailable" as const,
                title: "Operation unavailable",
                status: 503,
                detail: hostileResponseSentinel,
              },
            },
          })),
        };
        const { manifestRevision: _manifestRevision, ...revisionBase } = base;
        const invalid = {
          ...revisionBase,
          manifestRevision: computeRevision(
            revisionBase as unknown as JsonObject,
            "manifestRevision",
          ),
        };
        let calls = 0;
        catalog.manifest = () => {
          calls += 1;
          return calls === 1 ? valid : invalid;
        };
      },
      request: () => boundary("GET", "/_gauntlet/v1/manifest"),
    },
    {
      name: "operation definition",
      replace: (catalog) => {
        const valid = catalog.operation(fixtureOperation.id)!;
        catalog.operation = () => ({ ...valid, hostile: hostileResponseSentinel } as never);
      },
      request: () => boundary("GET", `/_gauntlet/v1/operations/${fixtureOperation.id}`),
    },
    {
      name: "created run",
      replace: (catalog) => {
        catalog.createRun = async () => ({
          ok: true,
          run: { ...terminalRun, hostile: hostileResponseSentinel },
        } as never);
      },
      request: () => jsonBoundary("POST", `/_gauntlet/v1/operations/${fixtureOperation.id}/runs`, {}),
    },
    {
      name: "polled run",
      replace: (catalog) => {
        catalog.run = async () => ({ ...terminalRun, hostile: hostileResponseSentinel } as never);
      },
      request: () => boundary("GET", "/_gauntlet/v1/runs/run-1"),
    },
    {
      name: "data-source page",
      replace: (catalog) => {
        catalog.queryDataSource = async () => ({
          items: [],
          hostile: hostileResponseSentinel,
        } as never);
      },
      request: () => jsonBoundary("POST", "/_gauntlet/v1/data-sources/applications/query", {}),
    },
    {
      name: "data-source resolve response",
      replace: (catalog) => {
        catalog.resolveDataSource = async () => ({
          results: [],
          hostile: hostileResponseSentinel,
        } as never);
      },
      request: () => jsonBoundary("POST", "/_gauntlet/v1/data-sources/applications/resolve", { values: [] }),
    },
    {
      name: "cancelled run",
      capabilities: ["tc-run-cancellation@1"],
      replace: (catalog) => {
        catalog.cancelRun = async () => ({
          ok: true,
          value: { ...terminalRun, hostile: hostileResponseSentinel },
        } as never);
      },
      request: () => boundary("POST", "/_gauntlet/v1/runs/run-1/cancel"),
    },
    {
      name: "upload response",
      capabilities: ["tc-uploads@1"],
      replace: (catalog) => {
        catalog.createUpload = async () => ({
          ok: true,
          value: {
            file: {
              kind: "file",
              uploadId: "upload-1",
              name: "fixture.txt",
              mediaType: "text/plain",
              sizeBytes: 7,
              expiresAt: "2026-08-29T13:00:00Z",
            },
            hostile: hostileResponseSentinel,
          },
        } as never);
      },
      request: () => {
        const form = new FormData();
        form.set("file", new File(["fixture"], "fixture.txt", { type: "text/plain" }));
        return boundary("POST", "/_gauntlet/v1/uploads", form);
      },
    },
    {
      name: "session-launch response",
      capabilities: ["tc-session-launch@1"],
      replace: (catalog) => {
        catalog.launchSession = async () => ({
          ok: true,
          value: {
            url: "https://portal.example.test/session/one",
            expiresAt: "2026-08-29T12:15:00Z",
            singleUse: true,
            hostile: hostileResponseSentinel,
          },
        } as never);
      },
      request: () => boundary(
        "POST",
        "/_gauntlet/v1/runs/run-1/artifacts/artifact-1/launch",
      ),
    },
  ];

  for (const current of cases) {
    const fixture = createFixtureCatalog({ capabilities: current.capabilities });
    current.replace(fixture.catalog);
    const response = await createAdapterFetchHandler({
      enabled: true,
      catalog: fixture.catalog,
      now: () => "2026-08-29T12:00:00Z",
    })(current.request());
    await assertInternalResponse(response).catch((error: unknown) => {
      throw new Error(`${current.name}: ${String(error)}`);
    });
  }
});

test("invalid catalog Problems fail closed without echoing provider data", async () => {
  const cases: readonly {
    readonly name: string;
    readonly capabilities?: readonly "tc-run-cancellation@1"[];
    readonly replace: (catalog: ReturnType<typeof createFixtureCatalog>["catalog"]) => void;
    readonly request: () => ReturnType<typeof boundary>;
  }[] = [
    {
      name: "create result",
      replace: (catalog) => {
        catalog.createRun = async () => ({
          ok: false,
          problem: {
            type: "urn:gauntlet:problem:validation-failed",
            title: "Validation failed",
            status: 422,
            hostile: hostileResponseSentinel,
          },
        } as never);
      },
      request: () => jsonBoundary("POST", `/_gauntlet/v1/operations/${fixtureOperation.id}/runs`, {}),
    },
    {
      name: "capability preflight",
      replace: (catalog) => {
        catalog.capabilityAvailability = () => ({
          supported: false,
          problem: {
            type: "urn:gauntlet:problem:unsupported-capability",
            title: "Unsupported capability",
            status: 501,
            capability: "tc-run-cancellation@1",
            hostile: hostileResponseSentinel,
          },
        } as never);
      },
      request: () => boundary("POST", "/_gauntlet/v1/runs/run-1/cancel"),
    },
    {
      name: "capability dispatch",
      capabilities: ["tc-run-cancellation@1"],
      replace: (catalog) => {
        catalog.cancelRun = async () => ({
          ok: false,
          problem: {
            type: "urn:gauntlet:problem:unsupported-capability",
            title: "Unsupported capability",
            status: 501,
            capability: "tc-run-cancellation@1",
            hostile: hostileResponseSentinel,
          },
        } as never);
      },
      request: () => boundary("POST", "/_gauntlet/v1/runs/run-1/cancel"),
    },
  ];

  for (const current of cases) {
    const fixture = createFixtureCatalog({ capabilities: current.capabilities });
    current.replace(fixture.catalog);
    const response = await createAdapterFetchHandler({ enabled: true, catalog: fixture.catalog })(
      current.request(),
    );
    await assertInternalResponse(response).catch((error: unknown) => {
      throw new Error(`${current.name}: ${String(error)}`);
    });
  }
});

test("schema-valid catalog Problems are normalized before they cross HTTP", async () => {
  const fixture = createFixtureCatalog();
  fixture.catalog.createRun = async () => ({
    ok: false,
    problem: {
      type: "urn:gauntlet:problem:validation-failed",
      title: hostileResponseSentinel,
      status: 422,
      detail: hostileResponseSentinel,
      instance: `/${hostileResponseSentinel}`,
      errors: [{
        instancePath: "/input/email",
        schemaPath: "#/properties/email/format",
        keyword: "format",
        message: hostileResponseSentinel,
        params: { leaked: hostileResponseSentinel },
      }],
    },
  } as never);

  const response = await createAdapterFetchHandler({ enabled: true, catalog: fixture.catalog })(
    jsonBoundary("POST", `/_gauntlet/v1/operations/${fixtureOperation.id}/runs`, {}),
  );
  assert.equal(response.status, 422);
  const text = await response.text();
  assert.doesNotMatch(text, new RegExp(hostileResponseSentinel));
  assert.deepEqual(JSON.parse(text), {
    type: "urn:gauntlet:problem:validation-failed",
    title: "Validation failed",
    status: 422,
    errors: [{
      instancePath: "/input/email",
      schemaPath: "#/properties/email/format",
      keyword: "format",
      message: "value does not satisfy schema",
      params: {},
    }],
  });
});

test("cancellation policy conflicts cross HTTP as fixed 409 Problems", async () => {
  const fixture = createFixtureCatalog({ capabilities: ["tc-run-cancellation@1"] });
  fixture.catalog.cancelRun = async () => ({
    ok: false,
    problem: {
      type: "urn:gauntlet:problem:run-not-cancellable",
      title: hostileResponseSentinel,
      status: 409,
      detail: hostileResponseSentinel,
    },
  } as never);

  const response = await createAdapterFetchHandler({ enabled: true, catalog: fixture.catalog })(
    boundary("POST", "/_gauntlet/v1/runs/run-1/cancel"),
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    type: "urn:gauntlet:problem:run-not-cancellable",
    title: "Run is not cancellable",
    status: 409,
  });
});

test("operation definitions must match the complete manifest summary identity", async () => {
  const cases = [
    {
      name: "label",
      change: { label: "Different summary label" },
    },
    {
      name: "featureId",
      change: { featureId: "other-feature" },
      extraFeature: { id: "other-feature", label: "Other feature" },
    },
    {
      name: "requirements",
      change: { requirements: { profiles: ["tc-schema-core@1"] } },
    },
  ] as const;

  for (const current of cases) {
    const fixture = createFixtureCatalog();
    const manifestDraft = {
      protocolVersion: fixtureManifest.protocolVersion,
      schemaDialect: fixtureManifest.schemaDialect,
      profiles: fixtureManifest.profiles,
      capabilities: fixtureManifest.capabilities,
      application: fixtureManifest.application,
      features: current.extraFeature === undefined
        ? fixtureManifest.features
        : [...fixtureManifest.features, current.extraFeature],
      operations: [{ ...fixtureManifest.operations[0]!, ...current.change }],
      dataSources: fixtureManifest.dataSources,
    };
    fixture.catalog.manifest = () => ({
      ...manifestDraft,
      manifestRevision: computeRevision(manifestDraft as unknown as JsonObject),
    } as never);
    const response = await createAdapterFetchHandler({ enabled: true, catalog: fixture.catalog })(
      boundary("GET", `/_gauntlet/v1/operations/${fixtureOperation.id}`),
    );
    await assertInternalResponse(response).catch((error: unknown) => {
      throw new Error(`${current.name}: ${String(error)}`);
    });
  }
});

test("Run responses enforce output schemas and manifest action references", async () => {
  const invalidOutputValidator = {
    validate: async () => [{
      instancePath: "",
      schemaPath: "#/required",
      keyword: "required",
      message: "value does not satisfy schema",
      params: {},
    }],
  };
  const requests = [
    {
      name: "create",
      capabilities: [] as const,
      prepare: (catalog: ReturnType<typeof createFixtureCatalog>["catalog"]) => {
        catalog.createRun = async () => ({ ok: true, run: terminalRun });
      },
      request: () => jsonBoundary(
        "POST",
        `/_gauntlet/v1/operations/${fixtureOperation.id}/runs`,
        {},
      ),
      stream: false,
    },
    {
      name: "poll",
      capabilities: [] as const,
      prepare: () => {},
      request: () => boundary("GET", "/_gauntlet/v1/runs/run-1"),
      stream: false,
    },
    {
      name: "cancel",
      capabilities: ["tc-run-cancellation@1"] as const,
      prepare: () => {},
      request: () => boundary("POST", "/_gauntlet/v1/runs/run-1/cancel"),
      stream: false,
    },
    {
      name: "SSE",
      capabilities: ["tc-run-sse@1"] as const,
      prepare: () => {},
      request: () => boundary("GET", "/_gauntlet/v1/runs/run-1/events"),
      stream: true,
    },
  ];

  for (const current of requests) {
    const fixture = createFixtureCatalog({ capabilities: current.capabilities });
    current.prepare(fixture.catalog);
    const response = await createAdapterFetchHandler({
      enabled: true,
      catalog: fixture.catalog,
      schemaValidator: invalidOutputValidator,
    })(current.request());
    if (current.stream) {
      assert.equal(response.status, 200, current.name);
      await assert.rejects(() => response.text(), /run event stream failed/i);
    } else {
      await assertInternalResponse(response).catch((error: unknown) => {
        throw new Error(`${current.name}: ${String(error)}`);
      });
    }
  }

  for (const current of requests) {
    const fixture = createFixtureCatalog({ capabilities: current.capabilities });
    current.prepare(fixture.catalog);
    fixture.catalog.runProjectionIsValid = async () => false;
    const response = await createAdapterFetchHandler({
      enabled: true,
      catalog: fixture.catalog,
    })(current.request());
    if (current.stream) {
      assert.equal(response.status, 200, current.name);
      await assert.rejects(() => response.text(), /run event stream failed/i);
    } else {
      await assertInternalResponse(response).catch((error: unknown) => {
        throw new Error(`${current.name}: ${String(error)}`);
      });
    }
  }

  const fixture = createFixtureCatalog();
  fixture.catalog.run = async () => ({
    ...terminalRun,
    actions: [{
      kind: "invoke-operation",
      label: "Unknown",
      operationId: "unknown-operation",
    }],
  });
  await assertInternalResponse(await createAdapterFetchHandler({
    enabled: true,
    catalog: fixture.catalog,
  })(boundary("GET", "/_gauntlet/v1/runs/run-1")));
});

test("Run responses validate invoke-operation input against the target definition", async () => {
  const fixture = createFixtureCatalog();
  const targetDraft = {
    id: "applications.required-target",
    label: "Required target",
    featureId: "applications",
    order: 20,
    tags: [],
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      required: ["applicationId"],
      properties: { applicationId: { type: "string" } },
      additionalProperties: false,
    },
    dataSources: [],
    presets: [],
    execution: {
      impact: "read",
      confirmationRequired: false,
      dryRunSupported: false,
      idempotency: "none",
      cancellationSupported: false,
    },
    output: { schema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" } },
  } as const;
  const target = {
    ...targetDraft,
    revision: computeRevision(targetDraft as unknown as JsonObject),
  };
  const manifestBase = {
    ...fixtureManifest,
    operations: [
      ...fixtureManifest.operations,
      {
        id: target.id,
        revision: target.revision,
        label: target.label,
        featureId: target.featureId,
        availability: { state: "available" as const },
      },
    ],
  };
  const { manifestRevision: _oldRevision, ...manifestWithoutRevision } = manifestBase;
  const manifest = {
    ...manifestWithoutRevision,
    manifestRevision: computeRevision(
      manifestWithoutRevision as unknown as JsonObject,
      "manifestRevision",
    ),
  };
  fixture.catalog.manifest = () => manifest;
  fixture.catalog.operation = (id) => id === fixtureOperation.id
    ? fixtureOperation
    : id === target.id ? target : undefined;
  fixture.catalog.run = async () => ({
    ...terminalRun,
    actions: [{
      kind: "invoke-operation",
      label: "Missing required input",
      operationId: target.id,
    }],
  });

  await assertInternalResponse(await createAdapterFetchHandler({
    enabled: true,
    catalog: fixture.catalog,
  })(boundary("GET", "/_gauntlet/v1/runs/run-1")));
});

test("an invalid SSE event aborts the stream without serializing provider data", async () => {
  const fixture = createFixtureCatalog({ capabilities: ["tc-run-sse@1"] });
  let producerClosed = false;
  fixture.catalog.runEvents = async () => ({
    ok: true,
    value: (async function* () {
      try {
        yield {
          id: "event-1",
          sequence: terminalRun.sequence,
          occurredAt: terminalRun.updatedAt,
          type: "run.updated",
          run: terminalRun,
          hostile: hostileResponseSentinel,
        } as never;
      } finally {
        producerClosed = true;
      }
    })(),
  });
  const response = await createAdapterFetchHandler({ enabled: true, catalog: fixture.catalog })(
    boundary("GET", "/_gauntlet/v1/runs/run-1/events"),
  );
  assert.equal(response.status, 200);
  await assert.rejects(
    () => response.text(),
    (error: unknown) => {
      assert.doesNotMatch(String(error), new RegExp(hostileResponseSentinel));
      assert.match(String(error), /run event stream failed/i);
      return true;
    },
  );
  assert.equal(producerClosed, true, "provider iterator must be closed after response defense fails");
});

test("SSE rejects regressing snapshots and closes the provider", async () => {
  const fixture = createFixtureCatalog({ capabilities: ["tc-run-sse@1"] });
  let producerClosed = false;
  fixture.catalog.runEvents = async () => ({
    ok: true,
    value: (async function* () {
      try {
        yield {
          id: "event-2",
          sequence: terminalRun.sequence,
          occurredAt: terminalRun.updatedAt,
          type: "run.updated",
          run: terminalRun,
        } as const;
        yield {
          id: "event-0",
          sequence: queuedRun.sequence,
          occurredAt: queuedRun.updatedAt,
          type: "run.updated",
          run: queuedRun,
        } as const;
      } finally {
        producerClosed = true;
      }
    })(),
  });
  const response = await createAdapterFetchHandler({ enabled: true, catalog: fixture.catalog })(
    boundary("GET", "/_gauntlet/v1/runs/run-1/events"),
  );
  await assert.rejects(() => response.text(), /run event stream failed/i);
  assert.equal(producerClosed, true);
});

test("failed Run problem sanitization is deterministic for immutable snapshot replay", async () => {
  const fixture = createFixtureCatalog();
  fixture.catalog.run = async () => ({
    ...queuedRun,
    sequence: 2,
    state: "failed",
    startedAt: queuedRun.createdAt,
    completedAt: "2026-08-29T12:00:01Z",
    updatedAt: "2026-08-29T12:00:01Z",
    problem: {
      type: "urn:gauntlet:problem:adapter-internal-error",
      title: hostileResponseSentinel,
      status: 500,
      correlationId: hostileResponseSentinel,
    },
  } as never);
  const handler = createAdapterFetchHandler({ enabled: true, catalog: fixture.catalog });
  const first = await (await handler(boundary("GET", "/_gauntlet/v1/runs/run-1"))).text();
  const second = await (await handler(boundary("GET", "/_gauntlet/v1/runs/run-1"))).text();
  assert.equal(first, second);
  assert.doesNotMatch(first, new RegExp(hostileResponseSentinel));
  assert.deepEqual((JSON.parse(first) as { problem: unknown }).problem, {
    type: "urn:gauntlet:problem:adapter-internal-error",
    title: "Adapter internal error",
    status: 500,
  });
});

test("session launch rejects an otherwise valid response beyond the 15 minute TTL", async () => {
  const fixture = createFixtureCatalog({ capabilities: ["tc-session-launch@1"] });
  fixture.catalog.launchSession = async () => ({
    ok: true,
    value: {
      url: "https://portal.example.test/session/too-long",
      expiresAt: "2026-08-29T12:15:01Z",
      singleUse: true,
    },
  });
  const response = await createAdapterFetchHandler({
    enabled: true,
    catalog: fixture.catalog,
    now: () => "2026-08-29T12:00:00Z",
  })(boundary("POST", "/_gauntlet/v1/runs/run-1/artifacts/artifact-1/launch"));
  await assertInternalResponse(response);
});

test("optional preflight wins before body parsing and installed endpoints use canonical media", async () => {
  const absentFixture = createFixtureCatalog();
  const absent = createAdapterFetchHandler({ enabled: true, catalog: absentFixture.catalog });
  for (const [method, target, capability] of [
    ["POST", "/_gauntlet/v1/runs/run-1/cancel", "tc-run-cancellation@1"],
    ["GET", "/_gauntlet/v1/runs/run-1/events", "tc-run-sse@1"],
    ["POST", "/_gauntlet/v1/uploads", "tc-uploads@1"],
    ["POST", "/_gauntlet/v1/runs/run-1/artifacts/artifact-1/launch", "tc-session-launch@1"],
  ] as const) {
    const response = await absent(boundary(method, target, method === "GET" ? undefined : "not multipart"));
    assert.equal(response.status, 501);
    assert.equal(response.headers.get("content-type"), "application/problem+json; charset=utf-8");
    assert.equal((await response.json()).capability, capability);
  }
  assert.equal(absentFixture.state.uploads, 0);

  const fixture = createFixtureCatalog({
    capabilities: [
      "tc-run-cancellation@1",
      "tc-run-sse@1",
      "tc-uploads@1",
      "tc-session-launch@1",
    ],
  });
  const handler = createAdapterFetchHandler({
    enabled: true,
    catalog: fixture.catalog,
    now: () => "2026-08-29T12:00:00Z",
  });
  assert.equal((await handler(boundary("POST", "/_gauntlet/v1/runs/run-1/cancel"))).status, 202);

  const events = await handler(boundary("GET", "/_gauntlet/v1/runs/run-1/events", undefined, {
    "last-event-id": "event-0",
  }));
  assert.equal(events.status, 200);
  assert.equal(events.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const eventBody = await events.text();
  assert.match(eventBody, /^id: event-1\nevent: run\.updated\ndata: /);
  assert.match(eventBody, /"state":"succeeded"/);

  const form = new FormData();
  form.set("file", new File(["fixture"], "fixture.txt", { type: "text/plain" }));
  assert.equal((await handler(boundary("POST", "/_gauntlet/v1/uploads", form))).status, 201);
  assert.equal(fixture.state.uploads, 1);

  const launch = await handler(boundary("POST", "/_gauntlet/v1/runs/run-1/artifacts/artifact-1/launch"));
  assert.equal(launch.status, 201);
  assert.equal((await launch.json()).singleUse, true);
});

test("SSE rejects an invalid Last-Event-ID before provider dispatch", async () => {
  const fixture = createFixtureCatalog({ capabilities: ["tc-run-sse@1"] });
  let dispatches = 0;
  fixture.catalog.runEvents = async () => {
    dispatches += 1;
    throw new Error("provider must not receive an invalid cursor");
  };

  const response = await createAdapterFetchHandler({
    enabled: true,
    catalog: fixture.catalog,
  })(boundary("GET", "/_gauntlet/v1/runs/run-1/events", undefined, {
    "last-event-id": "unsafe/id",
  }));

  assert.equal(response.status, 422);
  assert.equal(response.headers.get("content-type"), "application/problem+json; charset=utf-8");
  assert.deepEqual(await response.json(), {
    type: "urn:gauntlet:problem:validation-failed",
    title: "Validation failed",
    status: 422,
    errors: [{
      instancePath: "/headers/Last-Event-ID",
      schemaPath: "#/$defs/portableId/pattern",
      keyword: "pattern",
      message: "value does not satisfy schema",
      params: {},
    }],
  });
  assert.equal(dispatches, 0);
});

test("catalog validation Problems survive while unexpected errors are redacted", async () => {
  const validationCatalog = createFixtureCatalog().catalog;
  validationCatalog.queryDataSource = async () => {
    throw new AdapterCatalogError({
      type: "urn:gauntlet:problem:validation-failed",
      title: "Validation failed",
      status: 422,
      errors: [{
        instancePath: "/limit",
        schemaPath: "#/properties/limit",
        keyword: "maximum",
        message: "value does not satisfy schema",
        params: {},
      }],
    });
  };
  const validation = await createAdapterFetchHandler({ enabled: true, catalog: validationCatalog })(
    jsonBoundary("POST", "/_gauntlet/v1/data-sources/applications/query", { limit: 999 }),
  );
  assert.equal(validation.status, 422);
  assert.equal((await validation.json()).errors[0].instancePath, "/limit");

  const failed = createFixtureCatalog({ throwOnQuery: true });
  const internal = await createAdapterFetchHandler({ enabled: true, catalog: failed.catalog })(
    jsonBoundary("POST", "/_gauntlet/v1/data-sources/applications/query", {}),
  );
  assert.equal(internal.status, 500);
  const problem = await internal.text();
  assert.doesNotMatch(problem, /private query failure/);
  assert.match(problem, /correlationId/);
});
