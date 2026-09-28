import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertCanonicalJsonValue,
  cloneAndDeepFreeze,
} from "../src/operation-internals.js";

const LONE_HIGH = "\ud800";
const LONE_LOW = "\udc00";
const PAIRED = "\ud83d\ude00";
const UNSAFE_NON_EXPONENTIAL = 9_007_199_254_740_992;

function loneKey(key: string, value: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  Object.defineProperty(result, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return result;
}

function assertDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) {
      assertDeepFrozen(descriptor.value, seen);
    }
  }
}

const scalarRejections: readonly [string, unknown][] = [
  ["lone high surrogate string", LONE_HIGH],
  ["lone low surrogate string", LONE_LOW],
  ["nested lone surrogate object value", { nested: LONE_HIGH }],
  ["nested lone surrogate dense array value", { nested: [LONE_LOW] }],
  ["lone surrogate object property name", loneKey(LONE_HIGH, "value")],
  ["unsafe positive non-exponential integer", UNSAFE_NON_EXPONENTIAL],
  ["unsafe negative non-exponential integer", -UNSAFE_NON_EXPONENTIAL],
  ["unsafe integer rendered without exponent", 1e20],
];

for (const [name, value] of scalarRejections) {
  test(`canonical ownership rejects ${name}`, () => {
    assert.throws(() => assertCanonicalJsonValue(value), /canonical plain JSON/i);
    assert.throws(() => cloneAndDeepFreeze(value), /canonical plain JSON/i);
  });
}

test("canonical ownership retains every existing structural rejection without invoking accessors", () => {
  let getterCalls = 0;
  const accessor: Record<string, unknown> = {};
  Object.defineProperty(accessor, "value", {
    enumerable: true,
    get: () => {
      getterCalls += 1;
      return "not-readable";
    },
  });
  const withSymbol = { value: "visible" } as Record<PropertyKey, unknown>;
  withSymbol[Symbol("hidden")] = "hidden";
  const sparse = new Array(1);
  const withExtra = ["item"] as unknown[] & Record<string, unknown>;
  withExtra.extra = "not-an-index";
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const customPrototype = Object.assign(Object.create({ inherited: true }), { value: "own" });

  const invalid: readonly unknown[] = [
    -0,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    undefined,
    () => undefined,
    1n,
    Symbol("value"),
    new Date("2026-08-29T12:00:00Z"),
    new Map([["key", "value"]]),
    new Set(["value"]),
    /value/u,
    new Uint8Array([1, 2]),
    customPrototype,
    accessor,
    withSymbol,
    sparse,
    withExtra,
    cycle,
  ];

  for (const value of invalid) {
    assert.throws(() => cloneAndDeepFreeze(value), /canonical plain JSON/i);
  }
  assert.equal(getterCalls, 0);
});

test("canonical ownership accepts the portable scalar boundary", () => {
  const accepted: readonly unknown[] = [
    "",
    "ordinary",
    PAIRED,
    Number.MAX_SAFE_INTEGER,
    Number.MIN_SAFE_INTEGER,
    1.5,
    Number.MIN_VALUE,
    1e21,
    -1e21,
    true,
    false,
    null,
  ];

  for (const value of accepted) {
    assert.doesNotThrow(() => assertCanonicalJsonValue(value));
    assert.equal(cloneAndDeepFreeze(value), value);
  }
});

test("canonical ownership preserves aliases, prototypes, __proto__ data, and paired scalars", () => {
  const shared = { value: PAIRED };
  const protoData = loneKey("__proto__", { polluted: false });
  const nullPrototype = Object.create(null) as Record<string, unknown>;
  nullPrototype.value = PAIRED;
  const source: Record<string, unknown> = {
    dense: [1, PAIRED, null],
    first: shared,
    second: shared,
    protoData,
    nullPrototype,
  };
  Object.defineProperty(source, PAIRED, {
    value: PAIRED,
    enumerable: true,
    configurable: true,
    writable: true,
  });

  const owned = cloneAndDeepFreeze(source);

  assert.notEqual(owned, source);
  assert.notEqual(owned.first, shared);
  assert.equal(owned.first, owned.second);
  assert.equal(Object.getPrototypeOf(owned), Object.prototype);
  assert.equal(Object.getPrototypeOf(owned.nullPrototype), null);
  assert.equal(Object.hasOwn(owned.protoData as object, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(owned.protoData), Object.prototype);
  assert.deepEqual((owned.protoData as Record<string, unknown>).__proto__, { polluted: false });
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
  assert.equal(owned[PAIRED], PAIRED);
  assertDeepFrozen(owned);
});
