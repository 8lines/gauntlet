import { types as utilTypes } from "node:util";
import { assertRuntimeJsonData } from "@8lines/gauntlet-protocol";

function failOwnership(): never {
  throw new TypeError("Value must be canonical plain JSON");
}

function assertCanonicalScalar(value: string | number): void {
  try {
    assertRuntimeJsonData(value);
  } catch {
    failOwnership();
  }
}

function ownValue(
  value: unknown,
  active: Set<object>,
  clones: Map<object, unknown>,
): unknown {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    assertCanonicalScalar(value);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) failOwnership();
    assertCanonicalScalar(value);
    return value;
  }
  if (typeof value !== "object" || utilTypes.isProxy(value)) {
    return failOwnership();
  }
  if (active.has(value)) {
    return failOwnership();
  }
  const existing = clones.get(value);
  if (existing !== undefined) {
    return existing;
  }

  active.add(value);
  try {
    if (Array.isArray(value)) {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Array.prototype && prototype !== null) failOwnership();
      const keys = Reflect.ownKeys(value);
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (lengthDescriptor === undefined || !("value" in lengthDescriptor)
        || !Number.isSafeInteger(lengthDescriptor.value)
        || lengthDescriptor.value < 0
        || keys.length !== lengthDescriptor.value + 1) {
        return failOwnership();
      }

      const clone: unknown[] = new Array(lengthDescriptor.value);
      Object.setPrototypeOf(clone, null);
      clones.set(value, clone);
      for (let index = 0; index < lengthDescriptor.value; index += 1) {
        const key = String(index);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          return failOwnership();
        }
        Object.defineProperty(clone, key, {
          value: ownValue(descriptor.value, active, clones),
          enumerable: true,
          configurable: false,
          writable: false,
        });
      }
      for (const key of keys) {
        if (typeof key !== "string"
          || (key !== "length" && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= lengthDescriptor.value))) {
          return failOwnership();
        }
      }
      return Object.freeze(clone);
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) failOwnership();
    const clone = Object.create(null) as Record<string, unknown>;
    clones.set(value, clone);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") failOwnership();
      assertCanonicalScalar(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        return failOwnership();
      }
      Object.defineProperty(clone, key, {
        value: ownValue(descriptor.value, active, clones),
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return Object.freeze(clone);
  } finally {
    active.delete(value);
  }
}

export function ownCanonicalJson<T>(value: T): T {
  return ownValue(value, new Set(), new Map()) as T;
}
