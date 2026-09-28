import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import type { JsonObject, JsonValue, Sha256Revision } from "./types.js";

function escapePointerSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function childPointer(pointer: string, segment: string): string {
  return `${pointer}/${escapePointerSegment(segment)}`;
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function assertPlainDataObject(value: object, pointer: string): asserts value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`Object at ${pointer || "/"} has a non-JSON prototype`);
  }

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new TypeError(`Symbol key at ${pointer || "/"} is non-JSON`);
    }
    if (hasLoneSurrogate(key)) {
      throw new TypeError(`Object key at ${pointer || "/"} contains a lone surrogate`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`Property at ${childPointer(pointer, key)} is not a JSON data property`);
    }
  }
}

function assertJsonValue(
  value: unknown,
  pointer: string,
  active: Set<object>,
  rejectNegativeZero: boolean,
): void {
  if (value === null || typeof value === "boolean") {
    return;
  }

  if (typeof value === "string") {
    if (hasLoneSurrogate(value)) {
      throw new TypeError(`String at ${pointer || "/"} contains a lone surrogate`);
    }
    return;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Number at ${pointer || "/"} must be finite`);
    }
    if (rejectNegativeZero && Object.is(value, -0)) {
      throw new TypeError(`Number at ${pointer || "/"} must not be negative zero`);
    }
    const serialized = JSON.stringify(value);
    if (Number.isInteger(value) && !Number.isSafeInteger(value) && !/[eE]/.test(serialized)) {
      throw new TypeError(`Integer at ${pointer || "/"} must be a safe integer`);
    }
    return;
  }

  if (value === undefined) {
    throw new TypeError(`undefined at ${pointer || "/"} is a non-JSON value`);
  }

  if (typeof value !== "object") {
    throw new TypeError(`${typeof value} at ${pointer || "/"} is a non-JSON value`);
  }

  if (active.has(value)) {
    throw new TypeError(`Object cycle detected at ${pointer || "/"}`);
  }
  active.add(value);

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new TypeError(`Sparse array is not JSON at ${childPointer(pointer, String(index))}`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new TypeError(`Array item at ${childPointer(pointer, String(index))} is not a JSON data property`);
      }
      assertJsonValue(
        descriptor.value,
        childPointer(pointer, String(index)),
        active,
        rejectNegativeZero,
      );
    }

    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") {
        continue;
      }
      if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
        throw new TypeError(`Array property ${String(key)} at ${pointer || "/"} is non-JSON`);
      }
    }
  } else {
    assertPlainDataObject(value, pointer);
    for (const [key, child] of Object.entries(value)) {
      assertJsonValue(child, childPointer(pointer, key), active, rejectNegativeZero);
    }
  }

  active.delete(value);
}

/**
 * Verifies the language-neutral JSON scalar and ownership boundary without
 * canonicalizing or mutating the supplied value.
 */
export function assertCanonicalJsonData(value: unknown): asserts value is JsonValue {
  assertJsonValue(value, "", new Set(), false);
}

/** Verifies the stricter runtime transport boundary, including negative zero. */
export function assertRuntimeJsonData(value: unknown): asserts value is JsonValue {
  assertJsonValue(value, "", new Set(), true);
}

export function canonicalizeForRevision(value: JsonValue | JsonObject): string {
  assertCanonicalJsonData(value);
  const result = canonicalize(value);
  if (result === undefined) {
    throw new TypeError("Value cannot be represented as canonical JSON");
  }
  return result;
}

export function computeRevision(
  value: JsonObject,
  revisionField: "revision" | "manifestRevision" = "revision",
): Sha256Revision {
  assertPlainDataObject(value, "");
  const document = Object.create(null) as Record<string, JsonValue>;
  for (const [key, child] of Object.entries(value)) {
    if (key !== revisionField) {
      document[key] = child;
    }
  }

  const canonical = canonicalizeForRevision(document);
  const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
  return `sha256:${digest}` as Sha256Revision;
}
