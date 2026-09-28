# TypeScript extension for Node.js or Next.js

Use the already-integrated exact `@8lines/gauntlet-protocol` and
`@8lines/gauntlet-typescript-core` versions. Put this module in application
server code and register it in the existing catalog. In Next.js, keep it out of
client bundles and do not add an App Router route; the verified adapter bridge
already owns transport.

## Fixed operation

```ts
import type { JsonObject } from "@8lines/gauntlet-protocol";
import {
  defineOperation,
  type RegisteredOperation,
} from "@8lines/gauntlet-typescript-core";

type Input = JsonObject & { readonly userId: string };
type Delivery = {
  readonly deliveryId: string;
  readonly status: "queued" | "already-queued";
};

interface Dependencies {
  authorize(input: {
    actorId: string;
    targetId: string;
    userId: string;
  }): Promise<{ readonly tenantId: string }>;
  resendWelcomeEmail(input: {
    tenantId: string;
    userId: string;
  }): Promise<Delivery>;
}

const dialect = "https://json-schema.org/draft/2020-12/schema" as const;
const uuid = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

export function resendWelcomeEmail(
  dependencies: Dependencies,
): RegisteredOperation<Input> {
  return defineOperation<Input>({
    id: "notifications.resend-welcome-email",
    featureId: "notifications",
    label: "Resend welcome email",
    description: "Queues one welcome email for an authorized synthetic user.",
    order: 10,
    tags: ["notifications", "email"],
    inputSchema: {
      $schema: dialect,
      type: "object",
      required: ["userId"],
      properties: { userId: { type: "string", format: "uuid" } },
      additionalProperties: false,
    },
    contextSchema: {
      $schema: dialect,
      type: "object",
      required: ["requestId", "actor", "target"],
      properties: {
        requestId: { type: "string", minLength: 1, maxLength: 128 },
        actor: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", minLength: 1, maxLength: 128 },
            displayName: { type: "string", maxLength: 256 },
          },
          additionalProperties: false,
        },
        target: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", minLength: 1, maxLength: 128 },
            environment: { type: "string", maxLength: 128 },
          },
          additionalProperties: false,
        },
        locale: { type: "string", maxLength: 128 },
        timeZone: { type: "string", maxLength: 128 },
      },
      additionalProperties: false,
    },
    dataSources: [],
    presets: [],
    execution: {
      impact: "write",
      confirmationRequired: true,
      dryRunSupported: false,
      idempotency: "required",
      cancellationSupported: false,
      timeoutSeconds: 30,
      concurrency: "allow",
    },
    output: {
      schema: {
        $schema: dialect,
        type: "object",
        required: ["deliveryId", "status"],
        properties: {
          deliveryId: { type: "string", format: "uuid" },
          status: { type: "string", enum: ["queued", "already-queued"] },
        },
        additionalProperties: false,
      },
    },
  }, async (input, context) => {
    const actorId = context.invocationContext?.actor?.id;
    const targetId = context.invocationContext?.target?.id;
    if (!actorId || !targetId) throw new Error("domain access denied");
    const scope = await dependencies.authorize({ actorId, targetId, userId: input.userId });
    const delivery = await dependencies.resendWelcomeEmail({
      tenantId: scope.tenantId,
      userId: input.userId,
    });
    if (!new RegExp(uuid, "i").test(delivery.deliveryId)
        || !["queued", "already-queued"].includes(delivery.status)
        || Object.keys(delivery).length !== 2) {
      throw new Error("invalid application output");
    }
    return { output: { deliveryId: delivery.deliveryId, status: delivery.status } };
  });
}
```

Register feature `notifications` once, then register the returned operation in
the application's existing `OperationRegistry`. `defineOperation` validates
portable schemas, shared semantics, preset safety, and derives the canonical
revision.

## Focused tests

Use `node:test` against the returned operation before catalog/transport tests:

```ts
test("authorizes before calling the fixed service", async () => {
  const calls: unknown[] = [];
  const operation = resendWelcomeEmail({
    authorize: async (value) => ({ tenantId: (calls.push(["auth", value]), "tenant-blue") }),
    resendWelcomeEmail: async (value) => {
      calls.push(["resend", value]);
      return { deliveryId: "11111111-1111-4111-8111-111111111111", status: "queued" };
    },
  });
  const result = await operation.handler(
    { userId: "22222222-2222-4222-8222-222222222222" },
    runContext({ actorId: "tester", targetId: "tenant-blue" }),
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(result.output, {
    deliveryId: "11111111-1111-4111-8111-111111111111",
    status: "queued",
  });
});
```

`runContext` is a test-only real value implementing `RunContext`; give it an
`AbortController().signal` and no-op report/artifact/action/log/warn methods.
Add a denial case proving zero service calls. Then exercise the registered
operation through `RunManager` and the existing Node or Next transport for
schema rejection; acknowledgement bound to operation ID, revision, and impact;
same-key original-Run replay after changed valid input/request ID with one
service mutation; runtime invalid-output rejection; and leak behavior. Pass
`idempotencyKey` to `RunManager.create`; never substitute `requestId`.
