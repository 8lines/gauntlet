import assert from "node:assert/strict";
import test from "node:test";
import { PAGE_PLACEMENTS_PROFILE } from "@8lines/gauntlet-protocol";
import {
  CapabilityRegistry, DataSourceRegistry, OperationRegistry, createAdapterCatalog, createAjvSchemaValidator,
  globalPlacement, subjectPlacement,
} from "../src/index.js";
import { feature, operation } from "./support/operation.js";

const inputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: { orderId: { type: "string" }, token: { type: "string" } },
} as const;

function catalogWith(operations: ReturnType<typeof operation>[], profiles: readonly `${string}@${number}`[] = ["tc-schema-core@1"]) {
  const registry = new OperationRegistry();
  registry.registerFeature(feature("orders"));
  for (const value of operations) registry.register(value);
  return createAdapterCatalog({
    application: { id: "fixture", label: "Fixture", environment: { name: "fixture-test", kind: "test" } },
    profiles, capabilities: new CapabilityRegistry(), operations: registry,
    dataSources: new DataSourceRegistry(), runs: { create: async () => ({ ok: true, run: {} }), get: async () => undefined } as never,
    schemaValidator: createAjvSchemaValidator(),
  });
}

test("placement helpers build protocol placements", () => {
  assert.deepEqual(globalPlacement(), { kind: "global" });
  assert.deepEqual(subjectPlacement("order"), { kind: "subject", subjectType: "order" });
  assert.deepEqual(subjectPlacement("order", { "/orderId": "orderId" }),
    { kind: "subject", subjectType: "order", bindings: { "/orderId": "orderId" } });
  const unbound = subjectPlacement("order", {});
  assert.deepEqual(unbound, { kind: "subject", subjectType: "order" });
  assert.equal(Object.hasOwn(unbound, "bindings"), false);
});

test("defineOperation rejects invalid placements at registration time", () => {
  assert.throws(() => operation("orders.pay", { inputSchema, placements: [subjectPlacement("order", { "/missing": "orderId" })] }), /shared protocol semantics/i);
  assert.throws(() => operation("orders.pay", {
    inputSchema, inputHandling: { rules: [{ kind: "secret", schemaPointer: "/properties/token", retention: "none" }] },
    placements: [subjectPlacement("order", { "/token": "token" })],
  }), /shared protocol semantics/i);
  assert.throws(() => operation("orders.pay", { inputSchema, placements: [globalPlacement(), globalPlacement()] }), /shared protocol semantics/i);
});

test("manifest summaries carry placements and advertise the profile once", () => {
  const placements = [subjectPlacement("order", { "/orderId": "orderId" })];
  const catalog = catalogWith([operation("orders.pay", { inputSchema, placements }), operation("orders.list", { inputSchema })]);
  const manifest = catalog.manifest();
  assert.deepEqual(manifest.operations.find(({ id }) => id === "orders.pay")?.placements, placements);
  assert.equal(manifest.operations.find(({ id }) => id === "orders.list")?.placements, undefined);
  assert.equal(manifest.profiles.filter((id) => id === PAGE_PLACEMENTS_PROFILE).length, 1);
  assert.deepEqual(catalog.operation("orders.pay")?.placements, placements);

  const explicit = catalogWith([operation("orders.pay", { inputSchema, placements })], ["tc-schema-core@1", PAGE_PLACEMENTS_PROFILE]);
  assert.equal(explicit.manifest().profiles.filter((id) => id === PAGE_PLACEMENTS_PROFILE).length, 1);
});

test("adapters without placements do not advertise the profile", () => {
  assert.equal(catalogWith([operation("orders.list", { inputSchema })]).manifest().profiles.includes(PAGE_PLACEMENTS_PROFILE), false);
});
