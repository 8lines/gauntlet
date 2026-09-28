import assert from "node:assert/strict";
import { test } from "node:test";
import type { InvocationContext, OperationDefinition } from "@8lines/gauntlet-protocol";
import operationDocument from "@8lines/gauntlet-protocol/fixtures/v1/operation.valid.json" with { type: "json" };
import { buildCreateRunRequest } from "../src/create-run-request.ts";

const destructiveDefinition = {
  ...operationDocument,
  execution: {
    ...operationDocument.execution,
    impact: "destructive",
    confirmationRequired: true,
  },
} as OperationDefinition;

const readDefinition = {
  ...operationDocument,
  execution: {
    ...operationDocument.execution,
    impact: "read",
    confirmationRequired: false,
  },
} as OperationDefinition;

const context: InvocationContext = {
  requestId: "dashboard-request-1",
  target: { id: "portal" },
};

test("confirmation-required definitions bind acknowledgement in both execution modes", () => {
  for (const dryRun of [false, true]) {
    const request = buildCreateRunRequest(
      destructiveDefinition,
      { userId: "user-1" },
      context,
      dryRun,
      "dashboard-idempotency-1",
    );
    assert.deepEqual(request.confirmation, {
      operationId: destructiveDefinition.id,
      operationRevision: destructiveDefinition.revision,
      impact: destructiveDefinition.execution.impact,
    });
    assert.equal(request.dryRun, dryRun);
  }
});

test("confirmation is absent only when the definition does not require it", () => {
  assert.equal(
    "confirmation" in buildCreateRunRequest(readDefinition, {}, context, true),
    false,
  );
});
