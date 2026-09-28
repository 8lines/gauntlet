import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import * as protocol from "../src/index.js";
import {
  manifestSemanticsAreValid,
  operationInputHandlingIsValid,
  operationSemanticsAreValid,
  resolveSemanticsAreValid,
  runSemanticsAreValid,
  runTransitionIsValid,
  validateRunSemantics,
  validateRunTransition,
  type AdapterManifest,
  type DataSourceResolveRequest,
  type DataSourceResolveResponse,
  type JsonObject,
  type OperationDefinition,
  type Run,
} from "../src/index.js";
import { computeRevision } from "../src/revision.js";
import {
  loadSemanticVectors,
  materializeDocumentVector,
} from "./support/semantic-vector-loader.js";
import {
  operationWithSecretRules,
  validManifest,
  validOperation,
} from "./support/semantic-fixtures.js";

function manifestWithValidRevision(manifest: AdapterManifest): AdapterManifest {
  return {
    ...manifest,
    manifestRevision: computeRevision(manifest as unknown as JsonObject, "manifestRevision"),
  };
}

function operationWithValidRevision(operation: OperationDefinition): OperationDefinition {
  return {
    ...operation,
    revision: computeRevision(operation as unknown as JsonObject),
  };
}

test("all shared manifest, operation, and resolve vectors satisfy their semantic outcomes", async () => {
  const loaded = await loadSemanticVectors();
  for (const vector of loaded.artifact.documentVectors) {
    const materialized = materializeDocumentVector(loaded, vector);
    const actual = materialized.predicate === "manifest"
      ? manifestSemanticsAreValid(materialized.document as unknown as AdapterManifest)
      : materialized.predicate === "operation"
        ? operationSemanticsAreValid(materialized.document as unknown as OperationDefinition)
        : resolveSemanticsAreValid(
          materialized.request as unknown as DataSourceResolveRequest,
          materialized.response as unknown as DataSourceResolveResponse,
        );
    assert.equal(actual, vector.expected, vector.id);
  }
});

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

test("destructive operations reject a truthy non-boolean confirmation value", () => {
  const rawOperation = structuredClone(operationWithValidRevision({
    ...validOperation,
    execution: {
      ...validOperation.execution,
      impact: "destructive",
      confirmationRequired: true,
      idempotency: "required",
    },
  })) as unknown as Record<string, unknown>;
  (rawOperation.execution as Record<string, unknown>).confirmationRequired = "yes";
  rawOperation.revision = computeRevision(rawOperation as JsonObject);

  assert.equal(operationSemanticsAreValid(rawOperation as unknown as OperationDefinition), false);
});

test("protocol publishes the semantic predicates across a one-way dependency boundary", async () => {
  for (const name of [
    "manifestSemanticsAreValid",
    "operationInputHandlingIsValid",
    "operationSemanticsAreValid",
    "resolveSemanticsAreValid",
    "runSemanticsAreValid",
    "runTransitionIsValid",
    "validateRunSemantics",
    "validateRunTransition",
  ] as const) {
    assert.equal(typeof protocol[name], "function", name);
  }
  assert.equal("operationPresetsOmitSecrets" in protocol, false);

  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { exports: Record<string, unknown> };
  assert.equal(Object.hasOwn(packageJson.exports, "./preset-secrets"), false);

  const sourceNames = (await readdir(new URL("../src", import.meta.url)))
    .filter((name) => name.endsWith(".ts"));
  for (const sourceName of sourceNames) {
    const source = await readFile(new URL(`../src/${sourceName}`, import.meta.url), "utf8");
    assert.doesNotMatch(
      source,
      /@8lines\/gauntlet-dashboard-client|packages\/dashboard-client|packages\/typescript|apps\/server/,
      sourceName,
    );
  }
});

test("input handling follows schema references and validates every routed file value", () => {
  const operation = operationWithSecretRules({
    type: "object",
    properties: {
      credentials: { $ref: "#/$defs/credentials" },
      attachments: {
        type: "array",
        items: { $ref: "#/$defs/file" },
      },
    },
    $defs: {
      credentials: {
        type: "object",
        properties: {
          username: { type: "string" },
          token: { type: "string" },
        },
      },
      file: {
        type: "object",
        properties: { uploadId: { type: "string" } },
      },
    },
  }, ["/$defs/credentials/properties/token"], []);
  (operation as unknown as { inputHandling: { rules: unknown[] } }).inputHandling.rules.push({
    kind: "file",
    schemaPointer: "/properties/attachments",
    multiple: true,
  });

  const acceptedUploads: string[] = [];
  const validateFile = (value: unknown): boolean => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const uploadId = (value as { uploadId?: unknown }).uploadId;
    if (typeof uploadId !== "string" || uploadId === "rejected") return false;
    acceptedUploads.push(uploadId);
    return true;
  };

  assert.equal(operationInputHandlingIsValid(operation, {
    credentials: { username: "tester" },
    attachments: [{ uploadId: "one" }, { uploadId: "two" }],
  }, validateFile), true);
  assert.deepEqual(acceptedUploads, ["one", "two"]);
  assert.equal(operationInputHandlingIsValid(operation, {
    credentials: { username: "tester", token: "must-not-leave-adapter" },
    attachments: [],
  }, validateFile), false);
  assert.equal(operationInputHandlingIsValid(operation, {
    attachments: [{ uploadId: "one" }, { uploadId: "rejected" }],
  }, validateFile), false);
  assert.equal(operationInputHandlingIsValid(operation, {
    attachments: { uploadId: "one" },
  }, validateFile), false);
});

async function succeededRun(): Promise<Run> {
  return JSON.parse(
    await readFile(new URL("../fixtures/v1/run.succeeded.valid.json", import.meta.url), "utf8"),
  ) as Run;
}

async function cancelledRun(): Promise<Run> {
  return JSON.parse(
    await readFile(new URL("../fixtures/v1/run.cancelled.valid.json", import.meta.url), "utf8"),
  ) as Run;
}

async function timedOutRun(): Promise<Run> {
  return JSON.parse(
    await readFile(new URL("../fixtures/v1/run.timed-out.valid.json", import.meta.url), "utf8"),
  ) as Run;
}

test("Run semantics accept equivalent RFC 3339 offsets and validate the operation output", async () => {
  const run = structuredClone(await succeededRun()) as Run & {
    updatedAt: string;
    completedAt: string;
    progress: { updatedAt: string };
  };
  run.updatedAt = "2026-08-29T14:00:03+02:00";
  run.completedAt = "2026-08-29T07:00:03-05:00";
  run.progress.updatedAt = "2026-08-29T12:00:03+00:00";

  assert.equal(runSemanticsAreValid(run, {
    operationId: run.operationId,
    operationRevision: run.operationRevision,
    operationIds: [run.operationId],
    outputIsValid: (output) => (output as { reviewed?: unknown }).reviewed === 12,
  }), true);
});

test("Run semantics report chronology, relationship, identity, and output violations", async () => {
  const base = await succeededRun();
  const cancelled = await cancelledRun();
  const timedOut = await timedOutRun();
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly run: Run;
    readonly context?: Parameters<typeof validateRunSemantics>[1];
    readonly code: string;
    readonly pointer: string;
  }> = [
    {
      name: "timestamp inversion",
      run: { ...base, updatedAt: "2026-08-29T11:59:59Z" },
      code: "timestamp-order",
      pointer: "/updatedAt",
    },
    {
      name: "progress inversion",
      run: { ...base, progress: { ...base.progress!, current: 13, total: 12 } },
      code: "progress-bounds",
      pointer: "/progress/current",
    },
    {
      name: "duplicate artifact",
      run: { ...base, artifacts: [...base.artifacts, structuredClone(base.artifacts[0]!)] },
      code: "duplicate-artifact-id",
      pointer: `/artifacts/${base.artifacts.length}/id`,
    },
    {
      name: "dangling browser action",
      run: {
        ...base,
        actions: [...base.actions, { kind: "browser-launch", label: "Missing", artifactId: "missing" }],
      },
      code: "missing-browser-artifact",
      pointer: `/actions/${base.actions.length}/artifactId`,
    },
    {
      name: "unknown operation action",
      run: {
        ...base,
        actions: [{ kind: "invoke-operation", label: "Unknown", operationId: "unknown" }],
      },
      context: { operationIds: [base.operationId] },
      code: "unknown-operation-reference",
      pointer: "/actions/0/operationId",
    },
    {
      name: "operation identity drift",
      run: base,
      context: { operationId: "different-operation" },
      code: "operation-identity",
      pointer: "/operationId",
    },
    {
      name: "invalid output",
      run: base,
      context: { outputIsValid: () => false },
      code: "output-invalid",
      pointer: "/output",
    },
    {
      name: "cancelled run with a non-cancellation Problem",
      run: {
        ...cancelled,
        problem: {
          type: "urn:gauntlet:problem:handler-failed",
          title: "Operation failed",
          status: 500,
        },
      },
      code: "terminal-problem",
      pointer: "/problem/type",
    },
    {
      name: "cancelled run with a non-canonical status",
      run: { ...cancelled, problem: { ...cancelled.problem!, status: 500 } },
      code: "terminal-problem",
      pointer: "/problem/status",
    },
    {
      name: "timed-out run with a non-canonical title",
      run: { ...timedOut, problem: { ...timedOut.problem!, title: "Timeout" } },
      code: "terminal-problem",
      pointer: "/problem/title",
    },
  ];

  for (const vector of cases) {
    assert.deepEqual(validateRunSemantics(vector.run, vector.context), {
      code: vector.code,
      instancePath: vector.pointer,
    }, vector.name);
    assert.equal(runSemanticsAreValid(vector.run, vector.context), false, vector.name);
  }
});

test("Run transition semantics reject state, sequence, and epoch regressions", async () => {
  const terminal = await succeededRun();
  const queued = JSON.parse(JSON.stringify({
    ...terminal,
    sequence: 0,
    state: "queued",
    updatedAt: terminal.createdAt,
    startedAt: undefined,
    completedAt: undefined,
    progress: undefined,
    summary: undefined,
    output: undefined,
    artifacts: [],
    actions: [],
  })) as Run;
  const running = {
    ...queued,
    sequence: 1,
    state: "running",
    updatedAt: "2026-08-29T14:00:01+02:00",
    startedAt: "2026-08-29T07:00:01-05:00",
    progress: { current: 1, total: 2, updatedAt: "2026-08-29T13:00:01+01:00" },
  } as Run;
  assert.equal(runTransitionIsValid(queued, running), true);

  const cases: ReadonlyArray<{
    readonly name: string;
    readonly previous: Run;
    readonly next: Run;
    readonly code: string;
    readonly pointer: string;
  }> = [
    {
      name: "sequence regression",
      previous: running,
      next: { ...running, sequence: 0 },
      code: "sequence-regression",
      pointer: "/sequence",
    },
    {
      name: "same sequence mutation",
      previous: running,
      next: { ...running, summary: { title: "Changed", tone: "neutral" } },
      code: "sequence-conflict",
      pointer: "/sequence",
    },
    {
      name: "running to queued",
      previous: running,
      next: { ...running, sequence: 2, state: "queued" },
      code: "state-regression",
      pointer: "/state",
    },
    {
      name: "updatedAt regression expressed with offsets",
      previous: running,
      next: { ...running, sequence: 2, updatedAt: "2026-08-29T13:00:00+01:00" },
      code: "timestamp-regression",
      pointer: "/updatedAt",
    },
    {
      name: "startedAt mutation",
      previous: running,
      next: { ...running, sequence: 2, updatedAt: "2026-08-29T12:00:02Z", startedAt: "2026-08-29T12:00:00Z" },
      code: "immutable-field",
      pointer: "/startedAt",
    },
    {
      name: "progress timestamp regression",
      previous: running,
      next: {
        ...running,
        sequence: 2,
        updatedAt: "2026-08-29T12:00:02Z",
        progress: { current: 1, total: 2, updatedAt: "2026-08-29T12:00:00Z" },
      },
      code: "timestamp-regression",
      pointer: "/progress/updatedAt",
    },
    {
      name: "terminal mutation",
      previous: terminal,
      next: { ...terminal, sequence: terminal.sequence + 1 },
      code: "terminal-mutation",
      pointer: "",
    },
  ];

  for (const vector of cases) {
    assert.deepEqual(validateRunTransition(vector.previous, vector.next), {
      code: vector.code,
      instancePath: vector.pointer,
    }, vector.name);
    assert.equal(runTransitionIsValid(vector.previous, vector.next), false, vector.name);
  }
});
