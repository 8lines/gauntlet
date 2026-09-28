import { assertRuntimeJsonData } from "@8lines/gauntlet-protocol";

function invalidOwnedValue(): TypeError {
  return new TypeError("Value is not canonical JSON data");
}

export function ownFrozenJson<T>(value: T): T {
  try {
    assertRuntimeJsonData(value);
  } catch {
    throw invalidOwnedValue();
  }
  const ancestors = new Set<object>();

  const visit = (candidate: unknown): unknown => {
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") {
      return candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate) || (Number.isInteger(candidate) && !Number.isSafeInteger(candidate))) {
        throw invalidOwnedValue();
      }
      return candidate;
    }
    if (typeof candidate !== "object") {
      throw invalidOwnedValue();
    }
    if (ancestors.has(candidate)) {
      throw invalidOwnedValue();
    }
    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        const lengthDescriptor = Object.getOwnPropertyDescriptor(candidate, "length");
        if (lengthDescriptor === undefined
          || !("value" in lengthDescriptor)
          || !Number.isSafeInteger(lengthDescriptor.value)
          || lengthDescriptor.value < 0) {
          throw invalidOwnedValue();
        }
        const length = lengthDescriptor.value as number;
        const result: unknown[] = [];
        for (let index = 0; index < length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
          if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
            throw invalidOwnedValue();
          }
          result.push(visit(descriptor.value));
        }
        const keys = Reflect.ownKeys(candidate).filter((key) =>
          key !== "length" && !(typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < length));
        if (keys.length > 0) {
          throw invalidOwnedValue();
        }
        return Object.freeze(result);
      }

      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        throw invalidOwnedValue();
      }
      const result: Record<string, unknown> = {};
      for (const key of Reflect.ownKeys(candidate)) {
        if (typeof key !== "string") {
          throw invalidOwnedValue();
        }
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          throw invalidOwnedValue();
        }
        Object.defineProperty(result, key, {
          enumerable: true,
          configurable: false,
          writable: false,
          value: visit(descriptor.value),
        });
      }
      return Object.freeze(result);
    } catch (error) {
      if (error instanceof TypeError && error.message === "Value is not canonical JSON data") {
        throw error;
      }
      throw invalidOwnedValue();
    } finally {
      ancestors.delete(candidate);
    }
  };

  return visit(value) as T;
}
