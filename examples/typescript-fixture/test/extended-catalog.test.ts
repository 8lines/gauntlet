import assert from "node:assert/strict";
import { test } from "node:test";
import type { Run } from "@8lines/gauntlet-protocol";
import { createConformanceCatalog } from "../src/index.js";

async function terminalRun(catalog: ReturnType<typeof createConformanceCatalog>, run: Run): Promise<Run> {
  let current = run;
  for (let attempt = 0; attempt < 20 && ["queued", "running"].includes(current.state); attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const observed = await catalog.run(current.id);
    assert.ok(observed);
    current = observed;
  }
  assert.ok(!["queued", "running"].includes(current.state));
  return current;
}

test("shared TypeScript fixture implements every extended conformance branch", async () => {
  const catalog = createConformanceCatalog();
  const manifest = catalog.manifest();
  assert.deepEqual(
    manifest.operations.map(({ id }) => id).sort(),
    ["agency-applications.fail", "agency-applications.finalize"],
  );
  assert.deepEqual(manifest.application.environment, {
    name: "typescript-fixture-test",
    kind: "test",
  });

  const context = {
    requestId: "fixture-extended",
    target: { id: "conformance-target", environment: "test" },
  } as const;
  const query = {
    limit: 1,
    dependencies: { "/workflowState": "pending" },
    context,
  } as const;
  const first = await catalog.queryDataSource("pending-applications", query);
  assert.equal(first.items.length, 1);
  assert.ok(first.nextCursor);
  const second = await catalog.queryDataSource("pending-applications", {
    ...query,
    cursor: first.nextCursor,
  });
  assert.equal(second.items.length, 1);
  assert.notEqual(second.items[0]!.value, first.items[0]!.value);
  assert.equal(second.nextCursor, undefined);

  const finalize = catalog.operation("agency-applications.finalize");
  assert.ok(finalize);
  const finalizeCreated = await catalog.createRun(finalize.id, {
    operationRevision: finalize.revision,
    input: {
      applicationId: "11111111-1111-4111-8111-111111111111",
      confirmationCode: "731904",
    },
    context,
    idempotencyKey: "fixture-extended-finalize",
    confirmation: {
      operationId: finalize.id,
      operationRevision: finalize.revision,
      impact: finalize.execution.impact,
    },
  });
  assert.equal(finalizeCreated.ok, true);
  if (!finalizeCreated.ok) return;
  const finalized = await terminalRun(catalog, finalizeCreated.run);
  assert.equal(finalized.state, "succeeded");
  assert.deepEqual(finalized.output, { finalized: true });
  assert.equal(finalized.artifacts.some(({ id }) => id === "finalize-result"), true);
  assert.deepEqual(finalized.actions, [{
    kind: "open-link",
    label: "Review applications",
    url: "https://portal.example.test/applications",
  }]);

  const failure = catalog.operation("agency-applications.fail");
  assert.ok(failure);
  const failureCreated = await catalog.createRun(failure.id, {
    operationRevision: failure.revision,
    input: {
      applicationId: "11111111-1111-4111-8111-111111111111",
      confirmationCode: "731904",
    },
    context,
    idempotencyKey: "fixture-extended-failure",
    confirmation: {
      operationId: failure.id,
      operationRevision: failure.revision,
      impact: failure.execution.impact,
    },
  });
  assert.equal(failureCreated.ok, true);
  if (!failureCreated.ok) return;
  const failed = await terminalRun(catalog, failureCreated.run);
  assert.equal(failed.state, "failed");
  assert.equal(failed.problem?.type, "urn:gauntlet:problem:handler-failed");
  assert.doesNotMatch(JSON.stringify(failed), /731904/);
});
