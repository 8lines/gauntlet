import assert from "node:assert/strict";
import test from "node:test";

import { createRegisteredOperationRuntime } from "../fixtures/runtime-harness.mjs";

const dialect = "https://json-schema.org/draft/2020-12/schema";

function schema(properties) {
  return {
    $schema: dialect,
    type: "object",
    required: Object.keys(properties),
    properties,
    additionalProperties: false,
  };
}

function definition() {
  return {
    id: "notifications.resend-welcome-email",
    featureId: "notifications",
    inputSchema: schema({ userId: { type: "string", format: "uuid" } }),
    output: {
      schema: schema({
        deliveryId: { type: "string", format: "uuid" },
        status: { type: "string", enum: ["queued", "already-queued"] },
      }),
    },
    execution: {
      impact: "write",
      confirmationRequired: true,
      dryRunSupported: false,
      idempotency: "required",
      cancellationSupported: false,
    },
  };
}

const firstInput = { userId: "22222222-2222-4222-8222-222222222222" };
const secondInput = { userId: "33333333-3333-4333-8333-333333333333" };

test("registered runtime binds confirmation before invoking the handler", async () => {
  let calls = 0;
  const runtime = await createRegisteredOperationRuntime({
    definition: definition(),
    application: {},
    handler: () => {
      calls += 1;
      return {
        deliveryId: "11111111-1111-4111-8111-111111111111",
        status: "queued",
      };
    },
  });

  for (const confirmation of [
    undefined,
    runtime.confirmation({ operationId: "notifications.other" }),
    runtime.confirmation({ operationRevision: `sha256:${"f".repeat(64)}` }),
    runtime.confirmation({ impact: "destructive" }),
  ]) {
    const rejected = await runtime.create({
      input: firstInput,
      idempotencyKey: "confirmation-key",
      ...(confirmation === undefined ? {} : { confirmation }),
    });
    assert.equal(rejected.ok, false);
  }
  assert.equal(calls, 0);

  const accepted = await runtime.create({
    input: firstInput,
    idempotencyKey: "confirmation-key",
    confirmation: runtime.confirmation(),
  });
  assert.equal(accepted.ok, true);
  await runtime.settle();
  assert.equal(calls, 1);
});

test("idempotency key reaches create-run storage and mismatched input replays the original run", async () => {
  let mutations = 0;
  const runtime = await createRegisteredOperationRuntime({
    definition: definition(),
    application: {},
    handler: (_input, context) => {
      assert.match(context.runId, /^extension-eval-run-/u);
      assert.equal(context.operationId, "notifications.resend-welcome-email");
      mutations += 1;
      return {
        deliveryId: "11111111-1111-4111-8111-111111111111",
        status: "queued",
      };
    },
  });

  const original = await runtime.create({
    input: firstInput,
    idempotencyKey: "stable-key",
    requestId: "correlation-one",
    confirmation: runtime.confirmation(),
  });
  assert.equal(original.ok, true);
  await runtime.settle();

  const replay = await runtime.create({
    input: secondInput,
    idempotencyKey: "stable-key",
    requestId: "correlation-two",
    confirmation: runtime.confirmation(),
  });
  assert.equal(replay.ok, true);
  assert.equal(original.ok && replay.ok && replay.run.id, original.ok && original.run.id);
  await runtime.settle();
  assert.equal(mutations, 1);
});

test("invalid handler output fails inside the registered runtime", async () => {
  const runtime = await createRegisteredOperationRuntime({
    definition: definition(),
    application: {},
    handler: () => ({ status: "unknown", secret: "must-not-appear" }),
  });
  const created = await runtime.create({
    input: firstInput,
    idempotencyKey: "invalid-output-key",
    confirmation: runtime.confirmation(),
  });
  assert.equal(created.ok, true);
  await runtime.settle();
  const stored = created.ok ? await runtime.get(created.run.id) : undefined;
  assert.equal(stored?.state, "failed");
  assert.doesNotMatch(JSON.stringify(stored), /must-not-appear/u);
});
