import assert from "node:assert/strict";
import { test } from "node:test";
import { assertNonProductionEnvironment } from "../src/index.js";

const kinds = [
  "development", "test", "qa", "staging", "uat", "preview", "sandbox",
] as const;

test("owns and freezes every supported non-production environment", () => {
  for (const kind of kinds) {
    const source = { name: `client-${kind}`, kind };
    const result = assertNonProductionEnvironment(source);
    assert.deepEqual(result, source);
    assert.notEqual(result, source);
    assert.equal(Object.isFrozen(result), true);
  }
});

test("rejects production aliases as separated tokens", () => {
  for (const name of [
    "prod", "PRODUCTION", "live", "pp-prod", "prod-eu", "client.production",
    "live_eu", "sandbox:prod:blue", "non-production",
  ]) {
    assert.throws(
      () => assertNonProductionEnvironment({ name, kind: "staging" }),
      new TypeError("Invalid non-production environment descriptor"),
      name,
    );
  }
  assert.equal(assertNonProductionEnvironment({ name: "product-demo", kind: "preview" }).name, "product-demo");
  assert.equal(assertNonProductionEnvironment({ name: "lively", kind: "test" }).name, "lively");
});

test("rejects closed-shape and hostile values without invoking accessors", () => {
  const invalid: unknown[] = [
    null,
    [],
    {},
    { name: "dev" },
    { kind: "test" },
    { name: "dev", kind: "production" },
    { name: "dev", kind: "test", extra: true },
    Object.create({ name: "dev", kind: "test" }),
  ];
  for (const value of invalid) {
    assert.throws(() => assertNonProductionEnvironment(value), TypeError);
  }

  let getterCalled = false;
  const accessor = { name: "dev" } as Record<string, unknown>;
  Object.defineProperty(accessor, "kind", {
    enumerable: true,
    get() {
      getterCalled = true;
      return "test";
    },
  });
  assert.throws(() => assertNonProductionEnvironment(accessor), TypeError);
  assert.equal(getterCalled, false);
});
