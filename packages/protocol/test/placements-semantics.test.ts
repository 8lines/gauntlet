import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PAGE_PLACEMENTS_PROFILE,
  manifestSemanticsAreValid,
  operationPlacementsAreValid,
  operationSemanticsAreValid,
  placementSchemaPointer,
  type AdapterManifest,
  type JsonObject,
  type OperationDefinition,
  type OperationPlacement,
} from "../src/index.js";
import { computeRevision } from "../src/revision.js";
import { validManifest, validOperation } from "./support/semantic-fixtures.js";

const inputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    orderId: { type: "string" },
    count: { type: "integer" },
    flag: { type: "boolean" },
    mode: { enum: ["a", "b"] },
    fixed: { const: 3 },
    "a/b": { type: "string" },
    "a~b": { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    nested: { type: "object", properties: { id: { type: "number" } } },
    either: { type: ["string", "null"] },
    token: { type: "string" },
    attachment: { type: "object", properties: { name: { type: "string" } } },
    referenced: { $ref: "#/$defs/id" },
    leafCombinator: { type: "string", anyOf: [{ type: "string" }] },
    branchCombinator: {
      type: "object",
      oneOf: [{ required: ["id"] }],
      properties: { id: { type: "string" } },
    },
  },
  $defs: { id: { type: "string" } },
} as const;
const rootCombinatorSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  allOf: [{ required: ["orderId"] }],
  properties: { orderId: { type: "string" } },
} as const;
const inputHandling = {
  rules: [
    { kind: "secret" as const, schemaPointer: "/properties/token", retention: "none" as const },
    { kind: "file" as const, schemaPointer: "/properties/attachment", multiple: false },
  ],
};
const check = (placements: readonly OperationPlacement[]) =>
  operationPlacementsAreValid({ inputSchema: inputSchema as never, inputHandling, placements });
const bind = (pointer: string): OperationPlacement[] =>
  [{ kind: "subject", subjectType: "order", bindings: { [pointer]: "orderId" } }];

test("placementSchemaPointer maps input pointers through properties", () => {
  assert.equal(placementSchemaPointer("/orderId"), "/properties/orderId");
  assert.equal(placementSchemaPointer("/nested/id"), "/properties/nested/properties/id");
  assert.equal(placementSchemaPointer("/a~1b"), "/properties/a~1b");
  assert.equal(placementSchemaPointer(""), undefined);
  assert.equal(placementSchemaPointer("/a~2b"), undefined);
});

test("bindings must target scalar properties reachable through properties", () => {
  for (const pointer of ["/orderId", "/count", "/flag", "/mode", "/fixed", "/a~1b", "/a~0b", "/nested/id"]) {
    assert.equal(check(bind(pointer)), true, pointer);
  }
  for (const pointer of ["/tags", "/nested", "/either", "/missing", "/referenced", "/tags/0"]) {
    assert.equal(check(bind(pointer)), false, pointer);
  }
});

test("bindings must not target secret or file fields or their children", () => {
  assert.equal(check(bind("/token")), false);
  assert.equal(check(bind("/attachment/name")), false);
});

test("bindings must not traverse or terminate at a node with a combinator or $ref keyword", () => {
  // (a) leaf carries type: string alongside anyOf.
  assert.equal(check(bind("/leafCombinator")), false);
  // (b) intermediate object node carries properties alongside oneOf.
  assert.equal(check(bind("/branchCombinator/id")), false);
  // (c) root inputSchema carries allOf alongside properties.
  assert.equal(
    operationPlacementsAreValid({
      inputSchema: rootCombinatorSchema as never,
      inputHandling,
      placements: bind("/orderId"),
    }),
    false,
  );
});

test("placement kinds are unique per operation", () => {
  assert.equal(check([{ kind: "global" }, { kind: "subject", subjectType: "order" }]), true);
  assert.equal(check([{ kind: "global" }, { kind: "global" }]), false);
  assert.equal(check([{ kind: "subject", subjectType: "order" }, { kind: "subject", subjectType: "order" }]), false);
  assert.equal(check([]), false);
});

test("operation semantics include placement rules", () => {
  const withPlacements = (placements: readonly OperationPlacement[]): OperationDefinition => {
    const draft = { ...validOperation, placements } as OperationDefinition;
    return { ...draft, revision: computeRevision(draft as unknown as JsonObject) };
  };
  assert.equal(operationSemanticsAreValid(withPlacements([{ kind: "subject", subjectType: "application", bindings: { "/applicationId": "applicationId" } }])), true);
  assert.equal(operationSemanticsAreValid(withPlacements([{ kind: "subject", subjectType: "application", bindings: { "/apiToken": "token" } }])), false);
});

test("manifests with placements must declare the placements profile", () => {
  const manifest = (profiles: readonly string[]): AdapterManifest => {
    const draft = {
      ...validManifest,
      profiles,
      operations: validManifest.operations.map((summary, index) =>
        index === 0 ? { ...summary, placements: [{ kind: "global" as const }] } : summary),
    } as AdapterManifest;
    return { ...draft, manifestRevision: computeRevision(draft as unknown as JsonObject, "manifestRevision") };
  };
  assert.equal(manifestSemanticsAreValid(manifest(validManifest.profiles)), false);
  assert.equal(manifestSemanticsAreValid(manifest([...validManifest.profiles, PAGE_PLACEMENTS_PROFILE])), true);
});
