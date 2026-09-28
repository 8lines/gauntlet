import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  AdapterV1HttpClient,
  ConformanceFailure,
  serializeJsonRequest,
} from "../../src/http-client.js";
import { loadAdapterV1Scenario } from "../../src/scenario.js";
import {
  startFixtureAdapter,
  type FixtureMode,
} from "../../src/fixture-adapter.js";
import {
  assertEndpointDocument,
  validateManifest,
  validateOperation,
  validateResolve,
} from "../../src/schema-validator.js";
import type { OperationDefinition } from "@8lines/gauntlet-protocol";

const scenarioUrl = new URL("../../../scenarios/adapter-v1.json", import.meta.url);

function createDocument(
  definition: OperationDefinition,
  revision: string,
  input: Record<string, unknown>,
  requestId: string,
  idempotencyKey: string,
  dryRun = false,
): Record<string, unknown> {
  return {
    operationRevision: revision,
    input,
    context: {
      requestId,
      target: { id: "conformance-target", environment: "test" },
    },
    dryRun,
    idempotencyKey,
    confirmation: {
      operationId: definition.id,
      operationRevision: revision,
      impact: definition.execution.impact,
    },
  };
}

function staleRevision(revision: string): string {
  const final = revision.at(-1)!;
  return `${revision.slice(0, -1)}${final === "0" ? "1" : "0"}`;
}

async function expectGenericValidationFailure(
  baseUrl: string,
  path: string,
  document: unknown,
): Promise<void> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(document),
  });
  assert.equal(response.status, 422);
  assert.match(response.headers.get("content-type") ?? "", /^application\/problem\+json(?:;|$)/);
  const problem = await response.json() as Record<string, unknown>;
  assert.equal(problem.type, "urn:gauntlet:problem:validation-failed");
  assert.equal(problem.status, 422);
  assert.equal(Object.hasOwn(problem, "errors"), false);
}

test("the default fixture is loopback-only, revision-correct, conditional, and finitely closeable", async (t) => {
  const scenario = await loadAdapterV1Scenario(scenarioUrl);
  const fixture = await startFixtureAdapter({ scenario });
  t.after(() => fixture.close());
  assert.match(fixture.baseUrl, /^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/);

  const client = new AdapterV1HttpClient({ baseUrl: fixture.baseUrl, secretSentinels: ["731904"] });
  const health = await client.getHealth((value) => assertEndpointDocument<Record<string, unknown>>("health", value));
  const manifestResult = await client.getManifest(validateManifest);
  assert.equal(manifestResult.notModified, false);
  if (manifestResult.notModified) throw new Error("unreachable");
  assert.equal(health.protocolVersion, manifestResult.document.protocolVersion);
  assert.deepEqual(manifestResult.document.application.environment, {
    name: "conformance-fixture-test",
    kind: "test",
  });
  assert.equal((await client.getManifest(validateManifest, manifestResult.etag)).notModified, true);

  const operationResult = await client.getOperation(scenario.operationId, validateOperation);
  assert.equal(operationResult.notModified, false);
  if (operationResult.notModified) throw new Error("unreachable");
  assert.equal((await client.getOperation(scenario.operationId, validateOperation, operationResult.etag)).notModified, true);
  assert.equal(operationResult.document.revision, manifestResult.document.operations[0]?.revision);

  await Promise.race([
    fixture.close(),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("fixture close timed out")), 2_500)),
  ]);
  await fixture.close();
});

test("the async fixture classifies 409, 422, fresh 202, poll, and terminal 201 replay without retaining bodies", async (t) => {
  const scenario = await loadAdapterV1Scenario(scenarioUrl);
  const fixture = await startFixtureAdapter({ scenario, mode: "async-success" });
  t.after(() => fixture.close());
  const client = new AdapterV1HttpClient({ baseUrl: fixture.baseUrl, secretSentinels: ["731904"] });
  const operation = await client.getOperation(scenario.operationId, validateOperation);
  if (operation.notModified) throw new Error("unreachable");

  const stale = serializeJsonRequest("createRunRequest", createDocument(
    operation.document,
    staleRevision(operation.document.revision),
    scenario.input,
    "conformance-stale-01",
    "conformance-finalize-01-stale",
  ));
  await client.expectCreateProblem(
    scenario.operationId,
    stale,
    409,
    "urn:gauntlet:problem:stale-operation-revision",
  );

  const invalid = serializeJsonRequest("createRunRequest", createDocument(
    operation.document,
    operation.document.revision,
    scenario.invalidInput,
    "conformance-invalid-01",
    "conformance-finalize-01-invalid",
  ));
  const invalidProblem = await client.expectCreateProblem(
    scenario.operationId,
    invalid,
    422,
    "urn:gauntlet:problem:validation-failed",
  );
  assert.ok((invalidProblem.errors as readonly Record<string, unknown>[]).some(
    ({ instancePath }) => instancePath === "/applicationId",
  ));

  const dryRun = serializeJsonRequest("createRunRequest", createDocument(
    operation.document,
    operation.document.revision,
    scenario.input,
    "conformance-dry-run-01",
    "conformance-finalize-01-dry-run",
    true,
  ));
  const dryRunProblem = await client.expectCreateProblem(
    scenario.operationId,
    dryRun,
    422,
    "urn:gauntlet:problem:validation-failed",
  );
  assert.ok((dryRunProblem.errors as readonly Record<string, unknown>[]).some(
    ({ instancePath }) => instancePath === "/dryRun",
  ));

  const fresh = serializeJsonRequest("createRunRequest", createDocument(
    operation.document,
    operation.document.revision,
    scenario.input,
    "conformance-run-01",
    scenario.idempotencyKey,
  ));
  const created = await client.createRun(
    scenario.operationId,
    fresh,
    (value) => assertEndpointDocument<Record<string, unknown>>("run", value),
  );
  assert.equal(created.status, 202);
  assert.ok(created.document.state === "queued" || created.document.state === "running");
  const terminal = await client.getRun(
    String(created.document.id),
    (value) => assertEndpointDocument<Record<string, unknown>>("run", value),
  );
  assert.equal(terminal.state, "succeeded");
  const replay = await client.createRun(
    scenario.operationId,
    fresh,
    (value) => assertEndpointDocument<Record<string, unknown>>("run", value),
  );
  assert.equal(replay.status, 201);
  assert.deepEqual(replay.document, terminal);

  assert.deepEqual(
    fixture.requests.filter(({ bodyClass }) => bodyClass !== "none").map(({ bodyClass }) => bodyClass),
    ["stale-create", "invalid-create", "dry-run-create", "fresh-create", "replay-create"],
  );
  assert.ok(fixture.requests.every(({ bodyBytes }) => Number.isInteger(bodyBytes) && bodyBytes >= 0));
  assert.doesNotMatch(JSON.stringify(fixture.requests), /731904/);
});

test("query and resolve use raw pointer-keyed dependencies and full contexts", async (t) => {
  const scenario = await loadAdapterV1Scenario(scenarioUrl);
  const fixture = await startFixtureAdapter({ scenario });
  t.after(() => fixture.close());
  const client = new AdapterV1HttpClient({ baseUrl: fixture.baseUrl });

  const queryBody = serializeJsonRequest("dataSourceQuery", scenario.dataSourceQuery);
  const page = await client.queryDataSource(
    scenario.dataSourceId,
    queryBody,
    (value) => assertEndpointDocument<Record<string, unknown>>("dataSourcePage", value),
  );
  assert.equal((page.items as readonly unknown[]).length, 2);

  const resolveBody = serializeJsonRequest("dataSourceResolveRequest", scenario.dataSourceResolveRequest);
  const resolved = await client.resolveDataSource(
    scenario.dataSourceId,
    resolveBody,
    (value) => validateResolve(scenario.dataSourceResolveRequest, value),
  );
  assert.equal(resolved.results.length, scenario.dataSourceResolveRequest.values.length);
  assert.deepEqual(fixture.requests.slice(-2).map(({ bodyClass }) => bodyClass), [
    "data-source-query",
    "data-source-resolve",
  ]);
});

const queryRequestMutations: ReadonlyArray<readonly [
  string,
  (document: Record<string, unknown>) => void,
]> = [
  ["omitted search", (document) => { delete document.search; }],
  ["changed search", (document) => { document.search = "Green"; }],
  ["omitted limit", (document) => { delete document.limit; }],
  ["changed limit", (document) => { document.limit = 1; }],
  ["omitted dependencies", (document) => { delete document.dependencies; }],
  ["changed dependencies", (document) => { document.dependencies = { "/workflowState": "approved" }; }],
  ["omitted context", (document) => { delete document.context; }],
  ["changed context", (document) => {
    document.context = {
      ...(document.context as Record<string, unknown>),
      requestId: "conformance-query-changed",
    };
  }],
  ["context missing requestId", (document) => {
    const context = document.context as Record<string, unknown>;
    document.context = { target: context.target };
  }],
  ["context missing target", (document) => {
    const context = document.context as Record<string, unknown>;
    document.context = { requestId: context.requestId };
  }],
  ["incomplete target", (document) => {
    document.context = {
      ...(document.context as Record<string, unknown>),
      target: {},
    };
  }],
];

for (const [name, mutate] of queryRequestMutations) {
  test(`the fixture rejects a query with ${name}`, async (t) => {
    const scenario = await loadAdapterV1Scenario(scenarioUrl);
    const fixture = await startFixtureAdapter({ scenario });
    t.after(() => fixture.close());
    const document = structuredClone(scenario.dataSourceQuery) as Record<string, unknown>;
    mutate(document);
    await expectGenericValidationFailure(
      fixture.baseUrl,
      `/_gauntlet/v1/data-sources/${scenario.dataSourceId}/query`,
      document,
    );
  });
}

test("the missing-data-source probe does not bypass exact query validation", async (t) => {
  const scenario = await loadAdapterV1Scenario(scenarioUrl);
  const fixture = await startFixtureAdapter({ scenario });
  t.after(() => fixture.close());
  const document = structuredClone(scenario.dataSourceQuery) as Record<string, unknown>;
  document.search = "Green";
  await expectGenericValidationFailure(
    fixture.baseUrl,
    "/_gauntlet/v1/data-sources/conformance-missing-data-source/query",
    document,
  );
});

const resolveRequestMutations: ReadonlyArray<readonly [
  string,
  (document: Record<string, unknown>) => void,
]> = [
  ["omitted values", (document) => { delete document.values; }],
  ["changed values", (document) => {
    document.values = ["33333333-3333-4333-8333-333333333333"];
  }],
  ["omitted dependencies", (document) => { delete document.dependencies; }],
  ["changed dependencies", (document) => { document.dependencies = { "/workflowState": "approved" }; }],
  ["omitted context", (document) => { delete document.context; }],
  ["changed context", (document) => {
    document.context = {
      ...(document.context as Record<string, unknown>),
      requestId: "conformance-resolve-changed",
    };
  }],
  ["context missing requestId", (document) => {
    const context = document.context as Record<string, unknown>;
    document.context = { target: context.target };
  }],
  ["context missing target", (document) => {
    const context = document.context as Record<string, unknown>;
    document.context = { requestId: context.requestId };
  }],
  ["incomplete target", (document) => {
    document.context = {
      ...(document.context as Record<string, unknown>),
      target: {},
    };
  }],
];

for (const [name, mutate] of resolveRequestMutations) {
  test(`the fixture rejects a resolve request with ${name}`, async (t) => {
    const scenario = await loadAdapterV1Scenario(scenarioUrl);
    const fixture = await startFixtureAdapter({ scenario });
    t.after(() => fixture.close());
    const document = structuredClone(scenario.dataSourceResolveRequest) as Record<string, unknown>;
    mutate(document);
    await expectGenericValidationFailure(
      fixture.baseUrl,
      `/_gauntlet/v1/data-sources/${scenario.dataSourceId}/resolve`,
      document,
    );
  });
}

const invalidCreateMutations: ReadonlyArray<readonly [
  string,
  (document: Record<string, unknown>) => void,
]> = [
  ["request ID", (document) => {
    document.context = {
      ...(document.context as Record<string, unknown>),
      requestId: "conformance-invalid-changed",
    };
  }],
  ["idempotency key", (document) => { document.idempotencyKey = "conformance-invalid-changed"; }],
  ["target", (document) => {
    document.context = {
      ...(document.context as Record<string, unknown>),
      target: { id: "wrong-target", environment: "test" },
    };
  }],
  ["secret", (document) => {
    document.input = {
      ...(document.input as Record<string, unknown>),
      confirmationCode: "731905",
    };
  }],
];

for (const [name, mutate] of invalidCreateMutations) {
  test(`the fixture does not accept the invalid vector with a wrong ${name}`, async (t) => {
    const scenario = await loadAdapterV1Scenario(scenarioUrl);
    const fixture = await startFixtureAdapter({ scenario });
    t.after(() => fixture.close());
    const client = new AdapterV1HttpClient({ baseUrl: fixture.baseUrl });
    const operation = await client.getOperation(scenario.operationId, validateOperation);
    if (operation.notModified) throw new Error("unreachable");
    const document = createDocument(
      operation.document,
      operation.document.revision,
      scenario.invalidInput,
      "conformance-invalid-01",
      "conformance-finalize-01-invalid",
    );
    mutate(document);
    await expectGenericValidationFailure(
      fixture.baseUrl,
      `/_gauntlet/v1/operations/${scenario.operationId}/runs`,
      document,
    );
  });
}

test("synchronous, invalid-terminal, disabled-session, and secret-echo modes are isolated", async (t) => {
  const scenario = await loadAdapterV1Scenario(scenarioUrl);
  const modes: readonly FixtureMode[] = ["sync-success", "invalid-terminal", "session-disabled", "secret-echo"];
  for (const mode of modes) {
    const fixture = await startFixtureAdapter({ scenario, mode });
    t.after(() => fixture.close());
    const client = new AdapterV1HttpClient({
      baseUrl: fixture.baseUrl,
      secretSentinels: ["731904"],
    });
    const operation = await client.getOperation(scenario.operationId, validateOperation);
    if (operation.notModified) throw new Error("unreachable");
    const body = serializeJsonRequest("createRunRequest", createDocument(
      operation.document,
      operation.document.revision,
      scenario.input,
      "conformance-run-01",
      scenario.idempotencyKey,
    ));

    if (mode === "secret-echo") {
      await assert.rejects(
        client.createRun(scenario.operationId, body, (value) => assertEndpointDocument("run", value)),
        (error: unknown) => error instanceof ConformanceFailure && !error.message.includes("731904"),
      );
      continue;
    }
    const created = await client.createRun(
      scenario.operationId,
      body,
      (value) => assertEndpointDocument<Record<string, unknown>>("run", value),
    );
    if (mode === "sync-success") {
      assert.equal(created.status, 201);
      assert.equal(created.document.state, "succeeded");
    } else if (mode === "invalid-terminal") {
      assert.equal(created.status, 202);
      await assert.rejects(
        client.getRun(String(created.document.id), (value) => assertEndpointDocument("run", value)),
        /run\.schema\.json.*\/problem/,
      );
    } else {
      assert.equal(created.status, 202);
      await client.expectLaunchProblem(
        String(created.document.id),
        scenario.browserLaunch!.artifactId,
        501,
        "urn:gauntlet:problem:unsupported-capability",
        "tc-session-launch@1",
      );
    }
  }
});

test("the default fixture exposes exact missing, unsafe, absent-capability, and advertised-session branches", async (t) => {
  const scenario = await loadAdapterV1Scenario(scenarioUrl);
  const fixture = await startFixtureAdapter({ scenario });
  t.after(() => fixture.close());
  const client = new AdapterV1HttpClient({ baseUrl: fixture.baseUrl });
  await client.expectOperationProblem("conformance-missing-operation", 404, "urn:gauntlet:problem:operation-not-found");
  await client.expectDataSourceProblem(
    "conformance-missing-data-source",
    serializeJsonRequest("dataSourceQuery", scenario.dataSourceQuery),
    404,
    "urn:gauntlet:problem:data-source-not-found",
  );
  await client.expectRunProblem("conformance-missing-run", 404, "urn:gauntlet:problem:run-not-found");
  await client.expectUnsafeOperationProblem();
  await client.expectCancelProblem("conformance-run-01", 501, "urn:gauntlet:problem:unsupported-capability", "tc-run-cancellation@1");
  await client.expectEventsProblem("conformance-run-01", 501, "urn:gauntlet:problem:unsupported-capability", "tc-run-sse@1");
  await client.expectUploadsProblem(501, "urn:gauntlet:problem:unsupported-capability", "tc-uploads@1");
  const launch = await client.launchSession(
    "conformance-run-01",
    scenario.browserLaunch!.artifactId,
    (value) => assertEndpointDocument<Record<string, unknown>>("sessionLaunch", value),
  );
  assert.equal(launch.singleUse, true);
  assert.equal(new URL(String(launch.url)).origin, scenario.browserLaunch!.expectedPublicOrigin);
  const expiry = Date.parse(String(launch.expiresAt));
  assert.ok(expiry > Date.now() + 4 * 60_000);
  assert.ok(expiry <= Date.now() + 6 * 60_000);
});

test("the fixture redacts retained header sentinels and rejects a wrong fresh-create key", async (t) => {
  const scenario = await loadAdapterV1Scenario(scenarioUrl);
  const fixture = await startFixtureAdapter({ scenario });
  t.after(() => fixture.close());
  const client = new AdapterV1HttpClient({ baseUrl: fixture.baseUrl });
  const operation = await client.getOperation(scenario.operationId, validateOperation);
  if (operation.notModified) throw new Error("unreachable");
  const wrong = createDocument(
    operation.document,
    operation.document.revision,
    scenario.input,
    "conformance-run-01",
    "wrong-key",
  );
  const wrongBody = serializeJsonRequest("createRunRequest", wrong);
  await client.expectCreateProblem(
    scenario.operationId,
    wrongBody,
    422,
    "urn:gauntlet:problem:validation-failed",
  );

  const response = await fetch(`${fixture.baseUrl}/_gauntlet/v1/operations/${scenario.operationId}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json; marker=731904" },
    body: JSON.stringify(wrong),
  });
  await response.arrayBuffer();
  assert.doesNotMatch(JSON.stringify(fixture.requests), /731904/);
});

test("the fixture bin rejects fault-injection flags as usage errors", () => {
  const child = spawnSync(process.execPath, [
    "--import",
    "tsx",
    "src/fixture-adapter.ts",
    "--scenario",
    new URL(scenarioUrl).pathname,
    "--mode",
    "secret-echo",
  ], { cwd: process.cwd(), encoding: "utf8", timeout: 5_000 });
  assert.equal(child.status, 2);
  assert.equal(child.stdout, "");
  assert.doesNotMatch(child.stderr, /secret-echo/);
});
