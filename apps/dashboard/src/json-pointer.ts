import type { JsonPointer, JsonValue, UiCondition } from "@8lines/gauntlet-protocol";

/** Reads the value at a JSON pointer (RFC 6901) — without throwing on missing branches. */
export function readPointer(data: unknown, pointer: JsonPointer): unknown {
  if (pointer === "") return data;
  let current: unknown = data;
  for (const token of pointer.slice(1).split("/")) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Writes a value at a pointer — returns a new structure and leaves the input untouched. */
export function writePointer<T>(data: T, pointer: JsonPointer, value: unknown): T {
  if (pointer === "") return value as T;
  const tokens = pointer.slice(1).split("/").map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
  const copy = (current: unknown, depth: number): unknown => {
    const key = tokens[depth]!;
    const source = (typeof current === "object" && current !== null ? current : {}) as Record<string, unknown>;
    return {
      ...source,
      [key]: depth === tokens.length - 1 ? value : copy(source[key], depth + 1),
    };
  };
  return copy(data, 0) as T;
}

/** Evaluates a `visibleWhen` / `enabledWhen` condition from the tc-rich-forms@1 profile. */
export function conditionHolds(condition: UiCondition | undefined, data: unknown): boolean {
  if (condition === undefined) return true;
  switch (condition.op) {
    case "present": {
      const value = readPointer(data, condition.pointer);
      return value !== undefined && value !== null && value !== "";
    }
    case "equals":
      return valuesEqual(readPointer(data, condition.pointer), condition.value);
    case "in":
      return condition.values.some((v) => valuesEqual(readPointer(data, condition.pointer), v));
    case "all":
      return condition.conditions.every((c) => conditionHolds(c, data));
    case "any":
      return condition.conditions.some((c) => conditionHolds(c, data));
    case "not":
      return !conditionHolds(condition.condition, data);
  }
}

function valuesEqual(a: unknown, b: JsonValue): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || a === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Initial values derived from the input schema (`default` fields). */
export function initialValues(schema: unknown): Record<string, unknown> {
  if (typeof schema !== "object" || schema === null) return {};
  const properties = (schema as { properties?: Record<string, unknown> }).properties;
  if (properties === undefined) return {};
  const result: Record<string, unknown> = {};
  for (const [key, property] of Object.entries(properties)) {
    if (typeof property !== "object" || property === null) continue;
    const description = property as { default?: unknown; type?: string; properties?: unknown };
    if (description.default !== undefined) result[key] = description.default;
    else if (description.type === "object" && description.properties !== undefined) {
      const nested = initialValues(property);
      if (Object.keys(nested).length > 0) result[key] = nested;
    }
  }
  return result;
}
