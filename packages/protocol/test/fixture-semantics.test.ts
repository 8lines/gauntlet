import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { computeRevision } from "../src/revision.js";
import { assertTcSchemaCore } from "../src/schema-profile.js";
import type { JsonObject } from "../src/types.js";

const OPERATION_REVISION = "sha256:2e301a636fb48d2bec64fc7e91b62d8a45e47af3a28f665b6b809f6a4b19d9e8";
const MANIFEST_REVISION = "sha256:bd7df155fca5ce7504431416bdd0c7562255fcc238af5aade4eb0d557cf2a9cd";
const MINOR_FORWARD_MANIFEST_REVISION =
  "sha256:33f8e78bd95af05e886a747771876584eb3fe1080377e7fe4397524d628f25b6";

interface OperationFixture extends JsonObject {
  readonly revision: string;
  readonly contextSchema: JsonObject;
}

interface OperationSummaryFixture extends JsonObject {
  readonly revision: string;
}

interface DataSourceFixture extends JsonObject {
  readonly dependencySchema: JsonObject;
  readonly contextSchema: JsonObject;
}

interface ManifestFixture extends JsonObject {
  readonly manifestRevision: string;
  readonly operations: readonly [OperationSummaryFixture, ...OperationSummaryFixture[]];
  readonly dataSources: readonly [DataSourceFixture, ...DataSourceFixture[]];
}

interface ContextFixture extends JsonObject {
  readonly context: JsonObject;
}

interface DataSourceRequestFixture extends ContextFixture {
  readonly dependencies: JsonObject;
}

interface CreateRunRequestFixture extends ContextFixture {
  readonly operationRevision: string;
  readonly confirmation: JsonObject;
}

interface RunFixture extends JsonObject {
  readonly operationRevision: string;
}

interface RunEventFixture extends JsonObject {
  readonly run: RunFixture;
}

async function fixture<T extends JsonObject>(name: string): Promise<T> {
  return JSON.parse(await readFile(new URL(`../fixtures/v1/${name}`, import.meta.url), "utf8")) as T;
}

function compileObjectSchema(schema: JsonObject): ValidateFunction {
  assertTcSchemaCore(schema, { requireObjectRoot: true });
  return new Ajv2020({ strict: true, validateFormats: false }).compile(schema);
}

const [
  operation,
  manifest,
  minorForwardManifest,
  createRunRequest,
  queuedRun,
  succeededRun,
  failedRun,
  runEvent,
  dataSourceQuery,
  dataSourceResolve,
] = await Promise.all([
  fixture<OperationFixture>("operation.valid.json"),
  fixture<ManifestFixture>("manifest.valid.json"),
  fixture<ManifestFixture>("manifest.minor-forward.valid.json"),
  fixture<CreateRunRequestFixture>("create-run-request.valid.json"),
  fixture<RunFixture>("run.queued.valid.json"),
  fixture<RunFixture>("run.succeeded.valid.json"),
  fixture<RunFixture>("run.failed.valid.json"),
  fixture<RunEventFixture>("run-event.valid.json"),
  fixture<DataSourceRequestFixture>("data-source-query.valid.json"),
  fixture<DataSourceRequestFixture>("data-source-resolve-request.valid.json"),
]);

const completeContext = {
  requestId: "request-01",
  locale: "en-GB",
  timeZone: "Europe/Warsaw",
  actor: { id: "operator-01", displayName: "Operator" },
  target: { id: "acme-portal", environment: "development" },
  extensions: { "urn:fixture:tenant": { id: 42 } },
};

test("operation context schema consumes a complete raw InvocationContext", () => {
  const validate = compileObjectSchema(operation.contextSchema as JsonObject);

  assert.equal(validate(createRunRequest.context), true);
  assert.equal(validate(completeContext), true);
  assert.equal(validate({ targetId: "acme-portal" }), false);

  const invalidContexts: ReadonlyArray<readonly [string, unknown]> = [
    ["missing target", { requestId: "request-01" }],
    ["unsafe request ID", { ...completeContext, requestId: " unsafe" }],
    ["unsafe actor ID", { ...completeContext, actor: { id: "operator 01" } }],
    ["unsafe target ID", { ...completeContext, target: { id: "acme portal" } }],
    ["extra root member", { ...completeContext, tenant: "fixture" }],
    ["extra actor member", { ...completeContext, actor: { id: "operator-01", role: "admin" } }],
    ["extra target member", { ...completeContext, target: { id: "acme-portal", region: "eu" } }],
    ["non-namespaced extension", { ...completeContext, extensions: { tenant: 42 } }],
  ];

  for (const [name, context] of invalidContexts) {
    assert.equal(validate(context), false, name);
  }
});

test("both data-source context schemas consume the raw query and resolve contexts", () => {
  for (const currentManifest of [manifest, minorForwardManifest]) {
    const validate = compileObjectSchema(currentManifest.dataSources[0].contextSchema as JsonObject);

    assert.equal(validate(dataSourceQuery.context), true);
    assert.equal(validate(dataSourceResolve.context), true);
    assert.equal(validate({ targetId: "acme-portal" }), false);
    assert.equal(validate({ requestId: "request-01" }), false);
  }
});

test("both data-source dependency schemas consume pointer-keyed maps", () => {
  for (const currentManifest of [manifest, minorForwardManifest]) {
    const validate = compileObjectSchema(currentManifest.dataSources[0].dependencySchema as JsonObject);

    assert.equal(validate(dataSourceQuery.dependencies), true);
    assert.equal(validate(dataSourceResolve.dependencies), true);

    const invalidDependencies = [
      { includeInactive: false },
      {},
      { "/options/includeInactive": "false" },
      { "/options/includeInactive": false, "/options/mode": "preview" },
    ];
    for (const dependencies of invalidDependencies) {
      assert.equal(validate(dependencies), false);
    }
  }
});

test("fixture revisions are recomputed and propagated to every reference", () => {
  assert.equal(operation.revision, OPERATION_REVISION);
  assert.equal(computeRevision(operation as JsonObject), OPERATION_REVISION);

  assert.equal(manifest.manifestRevision, MANIFEST_REVISION);
  assert.equal(computeRevision(manifest as JsonObject, "manifestRevision"), MANIFEST_REVISION);
  assert.equal(minorForwardManifest.manifestRevision, MINOR_FORWARD_MANIFEST_REVISION);
  assert.equal(
    computeRevision(minorForwardManifest as JsonObject, "manifestRevision"),
    MINOR_FORWARD_MANIFEST_REVISION,
  );

  const operationRevisionReferences: ReadonlyArray<readonly [string, unknown]> = [
    ["manifest summary", manifest.operations[0].revision],
    ["minor-forward manifest summary", minorForwardManifest.operations[0].revision],
    ["create-run request", createRunRequest.operationRevision],
    ["queued Run", queuedRun.operationRevision],
    ["succeeded Run", succeededRun.operationRevision],
    ["failed Run", failedRun.operationRevision],
    ["RunEvent Run", runEvent.run.operationRevision],
  ];

  for (const [name, revision] of operationRevisionReferences) {
    assert.equal(revision, OPERATION_REVISION, name);
  }
});

test("the valid create-run fixture confirms the exact write operation", () => {
  assert.deepEqual(createRunRequest.confirmation, {
    operationId: "application-access-review",
    operationRevision: OPERATION_REVISION,
    impact: "write",
  });
});
