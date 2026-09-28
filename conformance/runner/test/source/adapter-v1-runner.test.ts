import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeRevision,
  PAGE_PLACEMENTS_PROFILE,
  type AdapterManifest,
  type CreateRunRequest,
  type JsonObject,
  type OperationDefinition,
} from "@8lines/gauntlet-protocol";
import {
  runAdapterV1Conformance,
  type AdapterV1ConformanceOptions,
} from "../../src/index.js";
import { validateCrossDocumentContract } from "../../src/adapter-v1-runner.js";
import { startFixtureAdapter, type FixtureMode } from "../../src/fixture-adapter.js";
import {
  loadAdapterV1Scenario,
  validateAdapterV1Scenario,
  type AdapterV1Scenario,
} from "../../src/scenario.js";
import {
  assertEndpointDocument,
  validateManifest,
  validateOperation,
} from "../../src/schema-validator.js";

const scenarioUrl = new URL("../../../scenarios/adapter-v1.json", import.meta.url);

interface FetchCall {
  readonly method: string;
  readonly path: string;
  readonly body?: Uint8Array;
  readonly ifNoneMatch?: string;
}

interface ContractDocuments {
  readonly manifest: Record<string, unknown>;
  readonly operation: Record<string, unknown>;
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

function jsonReplacement(
  response: Response,
  document: unknown,
  status = response.status,
  headers?: Headers,
): Response {
  const resultHeaders = headers ?? new Headers(response.headers);
  resultHeaders.delete("content-length");
  return new Response(JSON.stringify(document), { status, headers: resultHeaders });
}

function captureFetch(
  mutate?: (call: FetchCall, response: Response) => Promise<Response>,
): { readonly fetch: typeof globalThis.fetch; readonly calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const wrapped: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body === undefined
      ? undefined
      : new Uint8Array(await new Response(init.body).arrayBuffer());
    const headers = new Headers(init?.headers);
    const ifNoneMatch = headers.get("if-none-match");
    const call: FetchCall = {
      method,
      path: url.pathname,
      ...(body === undefined ? {} : { body }),
      ...(ifNoneMatch === null ? {} : { ifNoneMatch }),
    };
    calls.push(call);
    const response = await globalThis.fetch(input, init);
    return mutate === undefined ? response : await mutate(call, response);
  };
  return { fetch: wrapped, calls };
}

async function readContractDocuments(
  baseUrl: string,
  operationId: string,
): Promise<ContractDocuments> {
  const [manifestResponse, operationResponse] = await Promise.all([
    fetch(`${baseUrl}/_gauntlet/v1/manifest`),
    fetch(`${baseUrl}/_gauntlet/v1/operations/${operationId}`),
  ]);
  return {
    manifest: await responseJson(manifestResponse),
    operation: await responseJson(operationResponse),
  };
}

function manifestSummary(documents: ContractDocuments): Record<string, unknown> {
  return (documents.manifest.operations as Record<string, unknown>[])[0]!;
}

function manifestDataSource(documents: ContractDocuments): Record<string, unknown> {
  return (documents.manifest.dataSources as Record<string, unknown>[])[0]!;
}

function operationDataSource(documents: ContractDocuments): Record<string, unknown> {
  return (documents.operation.dataSources as Record<string, unknown>[])[0]!;
}

function refreshManifestRevision(documents: ContractDocuments): void {
  documents.manifest.manifestRevision = computeRevision(
    documents.manifest as JsonObject,
    "manifestRevision",
  );
}

function synchronizeOperationRevision(documents: ContractDocuments): void {
  documents.operation.revision = computeRevision(documents.operation as JsonObject);
  manifestSummary(documents).revision = documents.operation.revision;
  refreshManifestRevision(documents);
}

function jsonResponse(
  status: number,
  document: unknown,
  mediaType = "application/json",
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(document), {
    status,
    headers: { "content-type": mediaType, ...headers },
  });
}

const expectedSequence = [
  "GET /_gauntlet/v1/health",
  "GET /_gauntlet/v1/manifest",
  "GET /_gauntlet/v1/manifest",
  "GET /_gauntlet/v1/operations/agency-applications.finalize",
  "GET /_gauntlet/v1/operations/agency-applications.finalize",
  "POST /_gauntlet/v1/operations/agency-applications.finalize/runs",
  "POST /_gauntlet/v1/operations/agency-applications.finalize/runs",
  "POST /_gauntlet/v1/operations/agency-applications.finalize/runs",
  "POST /_gauntlet/v1/operations/agency-applications.finalize/runs",
  "GET /_gauntlet/v1/runs/conformance-run-01",
  "POST /_gauntlet/v1/operations/agency-applications.finalize/runs",
  "POST /_gauntlet/v1/data-sources/pending-applications/query",
  "POST /_gauntlet/v1/data-sources/pending-applications/resolve",
  "GET /_gauntlet/v1/operations/conformance-missing-operation",
  "POST /_gauntlet/v1/data-sources/conformance-missing-data-source/query",
  "GET /_gauntlet/v1/runs/conformance-missing-run",
  "GET /_gauntlet/v1/operations/unsafe!id",
  "POST /_gauntlet/v1/runs/conformance-run-01/cancel",
  "GET /_gauntlet/v1/runs/conformance-run-01/events",
  "POST /_gauntlet/v1/uploads",
  "POST /_gauntlet/v1/runs/conformance-run-01/artifacts/conformance-browser-session/launch",
] as const;

for (const mode of ["async-success", "sync-success"] as const) {
  test(`${mode} follows the exact interaction and byte-identical fresh/replay contract`, async (t) => {
    const scenario = await loadAdapterV1Scenario(scenarioUrl);
    const fixture = await startFixtureAdapter({ scenario, mode });
    t.after(() => fixture.close());
    const capture = captureFetch();
    await runAdapterV1Conformance({
      baseUrl: fixture.baseUrl,
      scenario,
      fetch: capture.fetch,
      requestTimeoutMs: 1_000,
      pollTimeoutMs: 1_000,
      pollIntervalMs: 1,
    });

    assert.deepEqual(
      fixture.requests.map(({ method, rawPath }) => `${method} ${rawPath}`),
      expectedSequence,
    );
    const validCreates = capture.calls.filter(({ method, path, body }) =>
      method === "POST"
      && path.endsWith("/runs")
      && body !== undefined
      && new TextDecoder().decode(body).includes('"idempotencyKey":"conformance-finalize-01"'));
    assert.equal(validCreates.length, 2);
    assert.deepEqual(validCreates[0]!.body, validCreates[1]!.body);
    const definition = (await readContractDocuments(fixture.baseUrl, scenario.operationId))
      .operation as unknown as OperationDefinition;
    const createDocuments = capture.calls
      .filter(({ method, path, body }) => method === "POST" && path.endsWith("/runs") && body !== undefined)
      .map(({ body }) => JSON.parse(new TextDecoder().decode(body)) as CreateRunRequest);
    assert.equal(createDocuments.length, 5);
    const expectedConfirmation = {
      operationId: definition.id,
      operationRevision: definition.revision,
      impact: definition.execution.impact,
    };
    const stale = createDocuments.find(({ idempotencyKey }) => idempotencyKey === "conformance-finalize-01-stale");
    assert.ok(stale);
    assert.notEqual(stale.operationRevision, definition.revision);
    assert.deepEqual(stale.confirmation, {
      ...expectedConfirmation,
      operationRevision: stale.operationRevision,
    });
    const current = createDocuments.filter(({ idempotencyKey }) =>
      idempotencyKey !== "conformance-finalize-01-stale");
    assert.equal(current.length, 4);
    for (const request of current) {
      assert.equal(request.operationRevision, definition.revision);
      assert.deepEqual(request.confirmation, expectedConfirmation);
    }
    const dryRun = createDocuments.find(
      ({ idempotencyKey }) => idempotencyKey === "conformance-finalize-01-dry-run",
    );
    assert.ok(dryRun);
    assert.equal(dryRun.dryRun, true);
    assert.equal(fixture.requests.filter(({ bodyClass }) => bodyClass === "fresh-create").length, 1);
    assert.equal(fixture.requests.filter(({ bodyClass }) => bodyClass === "replay-create").length, 1);
  });
}

test("direct scenarios and every numeric option are validated before Fetch", async () => {
  const scenario = await loadAdapterV1Scenario(scenarioUrl);
  const invalidScenarios: unknown[] = [
    { ...scenario, extra: true },
    { ...scenario, input: { applicationId: scenario.input.applicationId } },
    { ...scenario, expectedTerminalState: "running" },
  ];
  const invalidOptions: Array<Partial<AdapterV1ConformanceOptions>> = [
    { requestTimeoutMs: 0 },
    { requestTimeoutMs: 2_147_483_648 },
    { pollTimeoutMs: 1.5 },
    { pollIntervalMs: 11, pollTimeoutMs: 10 },
    { maxResponseBytes: 4_194_305 },
  ];
  let calls = 0;
  const fetchDouble: typeof fetch = async () => {
    calls += 1;
    throw new Error("must not fetch");
  };
  for (const invalid of invalidScenarios) {
    await assert.rejects(runAdapterV1Conformance({
      baseUrl: "http://example.test",
      scenario: invalid as AdapterV1Scenario,
      fetch: fetchDouble,
    }), /scenario/i);
  }
  for (const invalid of invalidOptions) {
    await assert.rejects(runAdapterV1Conformance({
      baseUrl: "http://example.test",
      scenario,
      fetch: fetchDouble,
      ...invalid,
    }), /invalid/i);
  }
  assert.equal(calls, 0);
});

interface CrossDocumentMutation {
  readonly name: string;
  readonly expected: RegExp | string;
  readonly manifestEnvelopeOnly?: boolean;
  mutate(documents: ContractDocuments, scenario: AdapterV1Scenario): void;
}

const projectedDependencySchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["workflowState"],
  properties: { workflowState: { const: "pending" } },
  additionalProperties: false,
};

const projectedContextSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["requestId"],
  properties: { requestId: { type: "string" } },
  additionalProperties: false,
};

const crossDocumentMutations: readonly CrossDocumentMutation[] = [
  {
    name: "selected operation summary is missing",
    expected: "Selected operation summary is missing or duplicated",
    mutate(documents) {
      documents.manifest.operations = [];
      refreshManifestRevision(documents);
    },
  },
  {
    name: "selected operation is unavailable",
    expected: /Selected operation is unavailable/,
    mutate(documents) {
      manifestSummary(documents).availability = {
        state: "unavailable",
        problem: {
          type: "urn:gauntlet:problem:unsupported-capability",
          title: "Operation is unavailable",
          status: 501,
        },
      };
      refreshManifestRevision(documents);
    },
  },
  {
    name: "selected manifest data source is missing",
    expected: "Selected data source is missing or duplicated",
    mutate(documents) {
      documents.manifest.dataSources = [];
      refreshManifestRevision(documents);
    },
  },
  {
    name: "operation ID differs from its summary",
    expected: /Operation definition does not match its manifest summary/,
    mutate(documents) {
      documents.operation.id = "different-operation";
      synchronizeOperationRevision(documents);
    },
  },
  {
    name: "operation revision differs from its summary",
    expected: /Operation definition does not match its manifest summary/,
    mutate(documents) {
      manifestSummary(documents).revision = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      refreshManifestRevision(documents);
    },
  },
  {
    name: "operation feature differs from its summary",
    expected: /Operation definition does not match its manifest summary/,
    mutate(documents) {
      documents.operation.featureId = "different-feature";
      synchronizeOperationRevision(documents);
    },
  },
  {
    name: "summary and definition requirements differ from the scenario",
    expected: /Scenario requirements do not match the manifest/,
    mutate(documents) {
      const requirements = { profiles: [], capabilities: [] };
      documents.operation.requirements = structuredClone(requirements);
      manifestSummary(documents).requirements = structuredClone(requirements);
      synchronizeOperationRevision(documents);
    },
  },
  {
    name: "definition requirements differ from its summary",
    expected: /Operation definition does not match its manifest summary/,
    mutate(documents) {
      documents.operation.requirements = { profiles: [], capabilities: [] };
      synchronizeOperationRevision(documents);
    },
  },
  {
    name: "definition placements differ from its summary",
    expected: /Operation definition does not match its manifest summary/,
    mutate(documents) {
      documents.operation.placements = [{ kind: "global" }];
      synchronizeOperationRevision(documents);
    },
  },
  {
    name: "selected operation has one extra fully advertised required capability",
    expected: "Scenario requirements do not match the manifest",
    mutate(documents, scenario) {
      const capability = "tc-extra-capability@1";
      const requirements = {
        profiles: [...scenario.requiredProfiles],
        capabilities: [capability],
      };
      documents.operation.requirements = structuredClone(requirements);
      manifestSummary(documents).requirements = structuredClone(requirements);
      documents.manifest.capabilities = [
        ...(documents.manifest.capabilities as string[]),
        capability,
      ];
      synchronizeOperationRevision(documents);
    },
  },
  {
    name: "manifest does not advertise an exact scenario requirement",
    expected: /Scenario requirements do not match the manifest/,
    manifestEnvelopeOnly: true,
    mutate(documents) {
      documents.manifest.profiles = (documents.manifest.profiles as string[]).filter(
        (profile) => profile !== "tc-rich-forms@1",
      );
      refreshManifestRevision(documents);
    },
  },
  {
    name: "selected data source does not support search",
    expected: /Selected data source capabilities do not satisfy the scenario/,
    mutate(documents) {
      const capabilities = manifestDataSource(documents).capabilities as Record<string, unknown>;
      capabilities.search = false;
      refreshManifestRevision(documents);
    },
  },
  {
    name: "frozen query omits limit",
    expected: "Selected data source capabilities do not satisfy the scenario",
    mutate(_documents, scenario) {
      delete (scenario.dataSourceQuery as unknown as Record<string, unknown>).limit;
    },
  },
  {
    name: "scenario limit exceeds the selected data-source maximum",
    expected: /Selected data source capabilities do not satisfy the scenario/,
    mutate(_documents, scenario) {
      (scenario.dataSourceQuery as { limit: number }).limit = 21;
    },
  },
  {
    name: "selected definition data-source reference is missing",
    expected: "Selected data source reference is missing or duplicated",
    mutate(documents) {
      documents.operation.dataSources = [];
      synchronizeOperationRevision(documents);
    },
  },
  {
    name: "selected reference omits the required dependency pointer",
    expected: /Selected data source capabilities do not satisfy the scenario/,
    mutate(documents) {
      operationDataSource(documents).dependencyPointers = [];
      synchronizeOperationRevision(documents);
    },
  },
  {
    name: "selected data source omits dependencySchema",
    expected: /must declare dependency and context schemas/,
    mutate(documents) {
      delete manifestDataSource(documents).dependencySchema;
      refreshManifestRevision(documents);
    },
  },
  {
    name: "selected data source omits contextSchema",
    expected: /must declare dependency and context schemas/,
    mutate(documents) {
      delete manifestDataSource(documents).contextSchema;
      refreshManifestRevision(documents);
    },
  },
  {
    name: "dependency schema expects a leaf-name projection",
    expected: /Declared dependency schema rejected/,
    mutate(documents) {
      manifestDataSource(documents).dependencySchema = projectedDependencySchema;
      refreshManifestRevision(documents);
    },
  },
  {
    name: "context schema expects a requestId-only projection",
    expected: /Declared context schema rejected/,
    mutate(documents) {
      manifestDataSource(documents).contextSchema = projectedContextSchema;
      refreshManifestRevision(documents);
    },
  },
  {
    name: "input contract omits required applicationId",
    expected: /exact P0 input contract/,
    mutate(documents) {
      const input = documents.operation.inputSchema as Record<string, unknown>;
      input.required = (input.required as string[]).filter((name) => name !== "applicationId");
      synchronizeOperationRevision(documents);
    },
  },
  {
    name: "input contract omits required confirmationCode",
    expected: /exact P0 input contract/,
    mutate(documents) {
      const input = documents.operation.inputSchema as Record<string, unknown>;
      input.required = (input.required as string[]).filter((name) => name !== "confirmationCode");
      synchronizeOperationRevision(documents);
    },
  },
  {
    name: "input contract allows additional properties",
    expected: /exact P0 input contract/,
    mutate(documents) {
      (documents.operation.inputSchema as Record<string, unknown>).additionalProperties = true;
      synchronizeOperationRevision(documents);
    },
  },
  {
    name: "applicationId input type is not string",
    expected: /exact P0 input contract/,
    mutate(documents) {
      const properties = (documents.operation.inputSchema as Record<string, unknown>).properties as Record<string, Record<string, unknown>>;
      properties.applicationId!.type = "number";
      synchronizeOperationRevision(documents);
    },
  },
  {
    name: "applicationId input omits UUID format",
    expected: /exact P0 input contract/,
    mutate(documents) {
      const properties = (documents.operation.inputSchema as Record<string, unknown>).properties as Record<string, Record<string, unknown>>;
      delete properties.applicationId!.format;
      synchronizeOperationRevision(documents);
    },
  },
  {
    name: "confirmationCode input type is not string",
    expected: /exact P0 input contract/,
    mutate(documents) {
      const properties = (documents.operation.inputSchema as Record<string, unknown>).properties as Record<string, Record<string, unknown>>;
      properties.confirmationCode!.type = "number";
      synchronizeOperationRevision(documents);
    },
  },
  {
    name: "confirmationCode input pattern is not six digits",
    expected: /exact P0 input contract/,
    mutate(documents) {
      const properties = (documents.operation.inputSchema as Record<string, unknown>).properties as Record<string, Record<string, unknown>>;
      properties.confirmationCode!.pattern = "^[0-9]{5}$";
      synchronizeOperationRevision(documents);
    },
  },
  {
    name: "execution does not require idempotency",
    expected: /exact P0 input contract/,
    mutate(documents) {
      (documents.operation.execution as Record<string, unknown>).idempotency = "optional";
      synchronizeOperationRevision(documents);
    },
  },
  {
    name: "confirmationCode secret rule is absent",
    expected: /exact P0 input contract/,
    mutate(documents) {
      (documents.operation.inputHandling as Record<string, unknown>).rules = [];
      synchronizeOperationRevision(documents);
    },
  },
  {
    name: "live input schema rejects the exact valid scenario input",
    expected: "Declared input schema rejected /applicationId",
    mutate(documents) {
      const properties = (documents.operation.inputSchema as Record<string, unknown>).properties as Record<
        string,
        Record<string, unknown>
      >;
      properties.applicationId!.const = "22222222-2222-4222-8222-222222222222";
      synchronizeOperationRevision(documents);
    },
  },
  {
    name: "invalid scenario input is schema-valid at the expected pointer",
    expected: "Invalid input does not fail at the expected validation pointer",
    mutate(_documents, scenario) {
      (scenario.invalidInput as Record<string, unknown>).applicationId =
        "22222222-2222-4222-8222-222222222222";
    },
  },
];

test("each cross-document and raw-schema invariant has an isolated schema-valid mutation", async (t) => {
  const frozenScenario = await loadAdapterV1Scenario(scenarioUrl);
  const fixture = await startFixtureAdapter({ scenario: frozenScenario });
  const baseline = await readContractDocuments(fixture.baseUrl, frozenScenario.operationId);
  await fixture.close();

  for (const mutation of crossDocumentMutations) {
    await t.test(mutation.name, () => {
      const documents = structuredClone(baseline);
      const scenario = structuredClone(frozenScenario) as AdapterV1Scenario;
      mutation.mutate(documents, scenario);
      const validatedScenario = validateAdapterV1Scenario(scenario);
      assertEndpointDocument("dataSourceQuery", validatedScenario.dataSourceQuery);
      assertEndpointDocument("dataSourceResolveRequest", validatedScenario.dataSourceResolveRequest);
      const manifestEnvelope = assertEndpointDocument<AdapterManifest>("manifest", documents.manifest);
      const operationEnvelope = assertEndpointDocument<OperationDefinition>("operation", documents.operation);
      const manifest = mutation.manifestEnvelopeOnly
        ? manifestEnvelope
        : validateManifest(manifestEnvelope);
      const operation = validateOperation(operationEnvelope);
      const validateContract = (): void => {
        validateCrossDocumentContract(manifest, operation, validatedScenario);
      };
      if (typeof mutation.expected === "string") {
        assert.throws(validateContract, (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.message, mutation.expected);
          return true;
        });
      } else {
        assert.throws(validateContract, mutation.expected);
      }
    });
  }
});

test("identical placements on the summary and definition satisfy the cross-document contract", async () => {
  const scenario = await loadAdapterV1Scenario(scenarioUrl);
  const fixture = await startFixtureAdapter({ scenario });
  const documents = await readContractDocuments(fixture.baseUrl, scenario.operationId);
  await fixture.close();

  const placements = [{ kind: "global" }];
  documents.operation.placements = structuredClone(placements);
  manifestSummary(documents).placements = structuredClone(placements);
  documents.manifest.profiles = [
    ...(documents.manifest.profiles as string[]),
    PAGE_PLACEMENTS_PROFILE,
  ];
  synchronizeOperationRevision(documents);

  const manifest = validateManifest(assertEndpointDocument<AdapterManifest>("manifest", documents.manifest));
  const operation = validateOperation(assertEndpointDocument<OperationDefinition>("operation", documents.operation));
  assert.doesNotThrow(() => {
    validateCrossDocumentContract(manifest, operation, scenario);
  });
});

test("advertised operation context validation advances one canonical create envelope at a time", async (t) => {
  const scenario = await loadAdapterV1Scenario(scenarioUrl);
  const fixture = await startFixtureAdapter({ scenario });
  t.after(() => fixture.close());
  const documents = await readContractDocuments(fixture.baseUrl, scenario.operationId);
  documents.operation.contextSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    required: ["requestId", "target"],
    properties: {
      requestId: { const: "conformance-stale-01" },
      target: {
        type: "object",
        required: ["id", "environment"],
        properties: {
          id: { const: "conformance-target" },
          environment: { const: "test" },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  };
  synchronizeOperationRevision(documents);
  const manifestTag = `"${String(documents.manifest.manifestRevision)}"`;
  const operationTag = `"${String(documents.operation.revision)}"`;
  const capture = captureFetch(async (call, response) => {
    if (call.path.endsWith("/manifest")) {
      return call.ifNoneMatch === manifestTag
        ? new Response(null, { status: 304, headers: { etag: manifestTag } })
        : jsonResponse(200, documents.manifest, "application/json", { etag: manifestTag });
    }
    if (call.path.endsWith(`/operations/${scenario.operationId}`)) {
      return call.ifNoneMatch === operationTag
        ? new Response(null, { status: 304, headers: { etag: operationTag } })
        : jsonResponse(200, documents.operation, "application/json", { etag: operationTag });
    }
    if (call.method === "POST" && call.path.endsWith("/runs")) {
      return jsonResponse(409, {
        type: "urn:gauntlet:problem:stale-operation-revision",
        title: "Stale operation revision",
        status: 409,
      }, "application/problem+json");
    }
    return response;
  });

  await assert.rejects(runAdapterV1Conformance({
    baseUrl: fixture.baseUrl,
    scenario,
    fetch: capture.fetch,
    pollIntervalMs: 1,
  }), /Declared context schema rejected \/requestId/);
  assert.equal(capture.calls.filter(({ method, path }) => method === "POST" && path.endsWith("/runs")).length, 1);
});

type RunMutation = (
  call: FetchCall,
  document: Record<string, unknown>,
  phase: { validCreate: number; poll: number },
) => { readonly document: Record<string, unknown>; readonly status?: number } | undefined;

const runMutations: ReadonlyArray<readonly [string, RunMutation]> = [
  ["201-active inversion", (call, document, phase) =>
    call.path.endsWith("/runs") && phase.validCreate === 1 && document.state === "queued"
      ? { document, status: 201 }
      : undefined],
  ["run ID drift", (call, document, phase) => phase.poll === 1 ? { document: { ...document, id: "drifted-run" } } : undefined],
  ["operation ID drift", (_call, document, phase) => phase.poll === 1 ? {
    document: { ...document, operationId: "different-operation" },
  } : undefined],
  ["revision drift", (call, document, phase) => phase.poll === 1 ? {
    document: { ...document, operationRevision: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
  } : undefined],
  ["createdAt drift", (call, document, phase) => phase.poll === 1 ? {
    document: { ...document, createdAt: "2026-08-29T11:59:59Z" },
  } : undefined],
  ["sequence regression", (call, document, phase) => {
    if (call.path.endsWith("/runs") && phase.validCreate === 1 && document.state === "queued") {
      return { document: { ...document, sequence: 2 } };
    }
    return undefined;
  }],
  ["changed same-sequence snapshot", (_call, document, phase) => phase.poll === 1 ? {
    document: { ...document, sequence: 0 },
  } : undefined],
  ["illegal running-to-queued transition", (call, document, phase) => {
    if (call.path.endsWith("/runs") && phase.validCreate === 1 && document.state === "queued") {
      return { document: { ...document, state: "running" } };
    }
    if (phase.poll === 1) {
      const { completedAt: _completedAt, ...rest } = document;
      return { document: { ...rest, sequence: 1, state: "queued", artifacts: [], actions: [] } };
    }
    return undefined;
  }],
  ["timestamp inversion", (_call, document, phase) => phase.poll === 1 ? {
    document: { ...document, updatedAt: "2026-08-29T11:59:59Z" },
  } : undefined],
  ["once-present startedAt changes", (call, document, phase) =>
    call.path.endsWith("/runs") && phase.validCreate === 1 && document.state === "queued"
      ? { document: { ...document, startedAt: "2026-08-29T12:00:00Z" } }
      : undefined],
  ["progress timestamp regression", (call, document, phase) => {
    if (call.path.endsWith("/runs") && phase.validCreate === 1 && document.state === "queued") {
      return {
        document: {
          ...document,
          updatedAt: "2026-08-29T12:00:01Z",
          progress: { ...(document.progress as object), updatedAt: "2026-08-29T12:00:01Z" },
        },
      };
    }
    if (phase.poll === 1) {
      return {
        document: {
          ...document,
          progress: { ...(document.progress as object), updatedAt: "2026-08-29T12:00:00Z" },
        },
      };
    }
    return undefined;
  }],
  ["negative progress", (_call, document, phase) => phase.poll === 1 ? {
    document: { ...document, progress: { ...(document.progress as object), current: -1 } },
  } : undefined],
  ["inverted progress", (_call, document, phase) => phase.poll === 1 ? {
    document: { ...document, progress: { ...(document.progress as object), current: 2, total: 1 } },
  } : undefined],
  ["invalid output", (_call, document, phase) => phase.poll === 1 ? {
    document: { ...document, output: { finalized: "yes" } },
  } : undefined],
  ["missing succeeded terminal data", (_call, document, phase) => {
    if (phase.poll !== 1) return undefined;
    const { summary: _summary, ...withoutSummary } = document;
    return { document: withoutSummary };
  }],
  ["duplicate artifact ID", (_call, document, phase) => phase.poll === 1 ? {
    document: { ...document, artifacts: [
      ...(document.artifacts as readonly unknown[]),
      structuredClone((document.artifacts as readonly unknown[])[0]),
    ] },
  } : undefined],
  ["dangling browser action", (_call, document, phase) => phase.poll === 1 ? {
    document: { ...document, actions: [
      ...(document.actions as readonly unknown[]),
      { kind: "browser-launch", label: "Dangling", artifactId: "missing-artifact" },
    ] },
  } : undefined],
  ["unknown invoke-operation target", (_call, document, phase) => phase.poll === 1 ? {
    document: {
      ...document,
      actions: (document.actions as readonly Record<string, unknown>[]).map((action, index) =>
        index === 0 ? { ...action, operationId: "unknown-operation" } : action),
    },
  } : undefined],
  ["wrong terminal state", (_call, document, phase) => phase.poll === 1 ? {
    document: {
      ...document,
      state: "failed",
      problem: {
        type: "urn:gauntlet:problem:handler-failed",
        title: "Injected terminal failure",
        status: 500,
      },
    },
  } : undefined],
  ["changed terminal replay", (call, document, phase) =>
    call.path.endsWith("/runs") && phase.validCreate === 2
      ? { document: { ...document, sequence: 2 } }
      : undefined],
  ["different replay run", (call, document, phase) =>
    call.path.endsWith("/runs") && phase.validCreate === 2
      ? { document: { ...document, id: "second-run" } }
      : undefined],
  ["terminal 202 replay", (call, document, phase) =>
    call.path.endsWith("/runs") && phase.validCreate === 2
      ? { document, status: 202 }
      : undefined],
];

test("Run chronology accepts equivalent RFC 3339 offset timestamps", async (t) => {
  const scenario = await loadAdapterV1Scenario(scenarioUrl);
  const fixture = await startFixtureAdapter({ scenario });
  t.after(() => fixture.close());
  const capture = captureFetch(async (call, response) => {
    if (response.headers.get("content-type")?.startsWith("application/json") !== true
      || (!call.path.endsWith("/runs") && !call.path.includes("/runs/conformance-run-01"))) {
      return response;
    }
    const document = await responseJson(response);
    if (document.state !== "succeeded") return jsonReplacement(response, document);
    return jsonReplacement(response, {
      ...document,
      updatedAt: "2026-08-29T14:00:02+02:00",
      startedAt: "2026-08-29T07:00:01-05:00",
      completedAt: "2026-08-29T12:00:02+00:00",
      progress: {
        ...(document.progress as Record<string, unknown>),
        updatedAt: "2026-08-29T13:00:02+01:00",
      },
    });
  });

  await runAdapterV1Conformance({
    baseUrl: fixture.baseUrl,
    scenario,
    fetch: capture.fetch,
    pollIntervalMs: 1,
  });
});

test("a schema- and P0-valid terminal create with 202 fails only the status/state pairing", async (t) => {
  const scenario = await loadAdapterV1Scenario(scenarioUrl);
  const fixture = await startFixtureAdapter({ scenario, mode: "sync-success" });
  t.after(() => fixture.close());
  let replaced = false;
  const capture = captureFetch(async (call, response) => {
    if (!replaced && call.method === "POST" && call.path.endsWith("/runs") && response.status === 201) {
      replaced = true;
      return jsonReplacement(response, await responseJson(response), 202);
    }
    return response;
  });
  await assert.rejects(runAdapterV1Conformance({
    baseUrl: fixture.baseUrl,
    scenario,
    fetch: capture.fetch,
    pollIntervalMs: 1,
  }), /Fresh create status and Run state are inconsistent/);
  assert.equal(replaced, true);
});

test("Run, transition, progress, artifact, and replay mutations are each rejected", async () => {
  const scenario = await loadAdapterV1Scenario(scenarioUrl);
  await Promise.all(runMutations.map(async ([name, mutation]) => {
    const fixture = await startFixtureAdapter({ scenario });
    const phase = { validCreate: 0, poll: 0 };
    const capture = captureFetch(async (call, response) => {
      const isRunJson = response.headers.get("content-type")?.startsWith("application/json") === true
        && (call.path.endsWith("/runs") || call.path.includes("/runs/conformance-run-01"));
      if (!isRunJson) return response;
      const document = await responseJson(response);
      if (call.method === "POST" && call.path.endsWith("/runs")
        && (document.state === "queued" || document.state === "succeeded")) {
        phase.validCreate += 1;
      }
      if (call.method === "GET" && call.path === "/_gauntlet/v1/runs/conformance-run-01") phase.poll += 1;
      const replacement = mutation(call, document, phase);
      return replacement === undefined
        ? jsonReplacement(response, document)
        : jsonReplacement(response, replacement.document, replacement.status);
    });
    try {
      await assert.rejects(
        runAdapterV1Conformance({
          baseUrl: fixture.baseUrl,
          scenario,
          fetch: capture.fetch,
          requestTimeoutMs: 500,
          pollTimeoutMs: 100,
          pollIntervalMs: 1,
        }),
        undefined,
        name,
      );
    } finally {
      await fixture.close();
    }
  }));
});

test("endless active polling expires within the configured monotonic deadline", async (t) => {
  const scenario = await loadAdapterV1Scenario(scenarioUrl);
  const fixture = await startFixtureAdapter({ scenario });
  t.after(() => fixture.close());
  let active: Record<string, unknown> | undefined;
  const capture = captureFetch(async (call, response) => {
    if (call.method === "POST" && call.path.endsWith("/runs") && response.status === 202) {
      active = await responseJson(response);
      return jsonReplacement(response, active);
    }
    if (call.method === "GET" && call.path === "/_gauntlet/v1/runs/conformance-run-01" && active !== undefined) {
      return jsonReplacement(response, active);
    }
    return response;
  });
  const before = performance.now();
  await assert.rejects(runAdapterV1Conformance({
    baseUrl: fixture.baseUrl,
    scenario,
    fetch: capture.fetch,
    requestTimeoutMs: 100,
    pollTimeoutMs: 20,
    pollIntervalMs: 2,
  }), /poll/i);
  assert.ok(performance.now() - before < 250);
  assert.ok(capture.calls.filter(({ path }) => path === "/_gauntlet/v1/runs/conformance-run-01").length >= 1);
});

test("resolve response ordering and exact item identity use the shared predicate", async (t) => {
  const scenario = await loadAdapterV1Scenario(scenarioUrl);
  const fixture = await startFixtureAdapter({ scenario });
  t.after(() => fixture.close());
  const capture = captureFetch(async (call, response) => {
    if (call.path.endsWith("/resolve") && response.status === 200) {
      const document = await responseJson(response);
      document.results = [...(document.results as readonly unknown[])].reverse();
      return jsonReplacement(response, document);
    }
    return response;
  });
  await assert.rejects(runAdapterV1Conformance({
    baseUrl: fixture.baseUrl,
    scenario,
    fetch: capture.fetch,
    pollIntervalMs: 1,
  }), /resolve/i);
});

test("an inexact validation pointer and a wrong advertised-session origin are rejected", async () => {
  const scenario = await loadAdapterV1Scenario(scenarioUrl);
  const cases = [
    async (call: FetchCall, response: Response): Promise<Response> => {
      if (call.path.endsWith("/runs") && response.status === 422) {
        const document = await responseJson(response);
        const errors = document.errors as Record<string, unknown>[];
        errors[0] = { ...errors[0], instancePath: "/applicationId/child" };
        return jsonReplacement(response, document);
      }
      return response;
    },
    async (call: FetchCall, response: Response): Promise<Response> => {
      if (call.path.endsWith("/launch") && response.status === 201) {
        const document = await responseJson(response);
        document.url = "https://wrong-origin.example.test/session";
        return jsonReplacement(response, document);
      }
      return response;
    },
  ];
  await Promise.all(cases.map(async (mutation) => {
    const fixture = await startFixtureAdapter({ scenario });
    const capture = captureFetch(mutation);
    try {
      await assert.rejects(runAdapterV1Conformance({
        baseUrl: fixture.baseUrl,
        scenario,
        fetch: capture.fetch,
        pollIntervalMs: 1,
      }));
    } finally {
      await fixture.close();
    }
  }));
});

test("advertised session launch must expire shortly after the injected wall clock", async () => {
  const scenario = await loadAdapterV1Scenario(scenarioUrl);
  const now = Date.parse("2026-08-29T12:00:00Z");
  const expiries = [
    new Date(now).toISOString(),
    new Date(now + 24 * 60 * 60_000).toISOString(),
  ];
  await Promise.all(expiries.map(async (expiresAt) => {
    const fixture = await startFixtureAdapter({ scenario });
    const capture = captureFetch(async (call, response) => {
      if (call.path.endsWith("/launch") && response.status === 201) {
        return jsonReplacement(response, { ...await responseJson(response), expiresAt });
      }
      return response;
    });
    try {
      await assert.rejects(runAdapterV1Conformance({
        baseUrl: fixture.baseUrl,
        scenario,
        fetch: capture.fetch,
        clock: () => now,
        pollIntervalMs: 1,
      }), /expire/i);
    } finally {
      await fixture.close();
    }
  }));
});

test("the absent-session fixture executes exact 501 before artifact lookup", async (t) => {
  const scenario = await loadAdapterV1Scenario(scenarioUrl);
  const fixture = await startFixtureAdapter({ scenario, mode: "session-disabled" });
  t.after(() => fixture.close());
  await runAdapterV1Conformance({
    baseUrl: fixture.baseUrl,
    scenario,
    pollIntervalMs: 1,
  });
  assert.equal(fixture.requests.at(-1)?.rawPath,
    "/_gauntlet/v1/runs/conformance-run-01/artifacts/conformance-browser-session/launch");
});
