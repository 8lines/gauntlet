import { Ajv2020 } from "ajv/dist/2020.js";
import { assertPortablePattern } from "./portable-pattern.js";
import type { JsonObject } from "./types.js";

const DIALECT = "https://json-schema.org/draft/2020-12/schema";
const draft202012 = new Ajv2020({ allErrors: true, strict: true, validateFormats: false });

const ALLOWED_FORMATS = new Set([
  "date",
  "date-time",
  "email",
  "hostname",
  "ipv4",
  "ipv6",
  "uri",
  "uuid",
]);

const ALLOWED_KEYWORDS = new Set([
  "$schema",
  "$ref",
  "$defs",
  "$comment",
  "type",
  "enum",
  "const",
  "multipleOf",
  "maximum",
  "exclusiveMaximum",
  "minimum",
  "exclusiveMinimum",
  "maxLength",
  "minLength",
  "pattern",
  "format",
  "maxItems",
  "minItems",
  "uniqueItems",
  "maxContains",
  "minContains",
  "maxProperties",
  "minProperties",
  "required",
  "dependentRequired",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "dependentSchemas",
  "prefixItems",
  "items",
  "contains",
  "properties",
  "patternProperties",
  "additionalProperties",
  "propertyNames",
  "unevaluatedItems",
  "unevaluatedProperties",
  "title",
  "description",
  "default",
  "deprecated",
  "readOnly",
  "writeOnly",
  "examples",
  "contentEncoding",
  "contentMediaType",
  "contentSchema",
]);

const SCHEMA_MAP_KEYWORDS = ["$defs", "dependentSchemas", "properties", "patternProperties"] as const;
const SCHEMA_ARRAY_KEYWORDS = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;
const SCHEMA_KEYWORDS = [
  "not",
  "if",
  "then",
  "else",
  "items",
  "contains",
  "additionalProperties",
  "propertyNames",
  "unevaluatedItems",
  "unevaluatedProperties",
  "contentSchema",
] as const;
const SAME_INSTANCE_SCHEMA_KEYWORDS = new Set([
  "dependentSchemas",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
]);

function escapePointerSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function childPointer(pointer: string, segment: string): string {
  return `${pointer}/${escapePointerSegment(segment)}`;
}

function fail(pointer: string, message: string): never {
  throw new TypeError(`At ${pointer || "/"}: ${message}`);
}

function asSchemaRecord(value: unknown, pointer: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(pointer, "schema must be a boolean or object");
  }
  return value as Record<string, unknown>;
}

function validatePortablePattern(pattern: unknown, pointer: string): void {
  if (typeof pattern !== "string") {
    fail(pointer, "pattern must be a string");
  }
  try {
    assertPortablePattern(pattern);
  } catch {
    fail(pointer, "pattern is not in the tc-schema-core@1 portable profile");
  }
}

function resolveLocalReference(
  root: JsonObject,
  reference: string,
): { readonly schema: boolean | Record<string, unknown>; readonly pointer: string } | undefined {
  if (reference === "#") {
    return { schema: root, pointer: "" };
  }
  if (!reference.startsWith("#/")) {
    return undefined;
  }

  let fragment: string;
  try {
    fragment = decodeURIComponent(reference.slice(1));
  } catch {
    return undefined;
  }

  let current: unknown = root;
  let pointer = "";
  for (const encodedSegment of fragment.slice(1).split("/")) {
    if (/~(?:[^01]|$)/.test(encodedSegment)) {
      return undefined;
    }
    const segment = encodedSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
    pointer = childPointer(pointer, segment);
  }

  if (typeof current === "boolean") {
    return { schema: current, pointer };
  }
  if (current !== null && typeof current === "object" && !Array.isArray(current)) {
    return { schema: current as Record<string, unknown>, pointer };
  }
  return undefined;
}

function validateSchemaShape(schema: boolean | Record<string, unknown>, pointer: string): void {
  if (!draft202012.validateSchema(schema)) {
    const error = draft202012.errors?.[0];
    fail(`${pointer}${error?.instancePath ?? ""}`, `invalid Draft 2020-12 keyword value: ${error?.message ?? "unknown error"}`);
  }
}

export function assertTcSchemaCore(
  schema: JsonObject,
  options: { requireObjectRoot?: boolean } = {},
): void {
  if (schema.$schema !== DIALECT) {
    fail("/$schema", `root schema dialect must be ${DIALECT}`);
  }
  if (options.requireObjectRoot === true && schema.type !== "object") {
    fail("/type", 'root schema type must be "object"');
  }

  const active = new Set<object>();
  const visited = new Set<object>();
  const localReferences: {
    readonly reference: string;
    readonly pointer: string;
    readonly source: Record<string, unknown>;
  }[] = [];
  const sameInstanceEdges = new Map<Record<string, unknown>, Set<Record<string, unknown>>>();

  const addSameInstanceEdge = (source: Record<string, unknown>, target: unknown, pointer: string): void => {
    if (typeof target === "boolean") {
      return;
    }
    const targetSchema = asSchemaRecord(target, pointer);
    const targets = sameInstanceEdges.get(source) ?? new Set<Record<string, unknown>>();
    targets.add(targetSchema);
    sameInstanceEdges.set(source, targets);
  };

  const reachesSameInstance = (
    start: Record<string, unknown>,
    destination: Record<string, unknown>,
  ): boolean => {
    const pending = [start];
    const seen = new Set<Record<string, unknown>>();
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (current === destination) {
        return true;
      }
      if (seen.has(current)) {
        continue;
      }
      seen.add(current);
      pending.push(...(sameInstanceEdges.get(current) ?? []));
    }
    return false;
  };

  const visit = (value: unknown, pointer: string): void => {
    if (typeof value === "boolean") {
      return;
    }

    const current = asSchemaRecord(value, pointer);
    if (active.has(current)) {
      fail(pointer, "schema object graph contains a cycle");
    }
    if (visited.has(current)) {
      return;
    }
    active.add(current);

    for (const keyword of Object.keys(current)) {
      if (!ALLOWED_KEYWORDS.has(keyword)) {
        fail(childPointer(pointer, keyword), `unsupported keyword ${keyword}`);
      }
    }

    if (Object.hasOwn(current, "$ref")) {
      const refPointer = childPointer(pointer, "$ref");
      if (typeof current.$ref !== "string" || !current.$ref.startsWith("#")) {
        fail(refPointer, "non-fragment $ref is not supported");
      }
      localReferences.push({ reference: current.$ref, pointer: refPointer, source: current });
    }

    if (Object.hasOwn(current, "format")) {
      const formatPointer = childPointer(pointer, "format");
      if (typeof current.format !== "string" || !ALLOWED_FORMATS.has(current.format)) {
        fail(formatPointer, `unsupported format ${String(current.format)}`);
      }
    }

    if (Object.hasOwn(current, "pattern")) {
      validatePortablePattern(current.pattern, childPointer(pointer, "pattern"));
    }

    for (const keyword of SCHEMA_MAP_KEYWORDS) {
      if (!Object.hasOwn(current, keyword)) {
        continue;
      }
      const mapPointer = childPointer(pointer, keyword);
      const map = asSchemaRecord(current[keyword], mapPointer);
      for (const [key, child] of Object.entries(map)) {
        if (keyword === "patternProperties") {
          validatePortablePattern(key, childPointer(mapPointer, key));
        }
        const pointer = childPointer(mapPointer, key);
        if (SAME_INSTANCE_SCHEMA_KEYWORDS.has(keyword)) {
          addSameInstanceEdge(current, child, pointer);
        }
        visit(child, pointer);
      }
    }

    for (const keyword of SCHEMA_ARRAY_KEYWORDS) {
      if (!Object.hasOwn(current, keyword)) {
        continue;
      }
      const listPointer = childPointer(pointer, keyword);
      const children = current[keyword];
      if (!Array.isArray(children)) {
        fail(listPointer, `${keyword} must be an array of schemas`);
      }
      for (const [index, child] of children.entries()) {
        const pointer = childPointer(listPointer, String(index));
        if (SAME_INSTANCE_SCHEMA_KEYWORDS.has(keyword)) {
          addSameInstanceEdge(current, child, pointer);
        }
        visit(child, pointer);
      }
    }

    for (const keyword of SCHEMA_KEYWORDS) {
      if (Object.hasOwn(current, keyword)) {
        const child = current[keyword];
        const childSchemaPointer = childPointer(pointer, keyword);
        if (SAME_INSTANCE_SCHEMA_KEYWORDS.has(keyword)) {
          addSameInstanceEdge(current, child, childSchemaPointer);
        }
        visit(child, childSchemaPointer);
      }
    }

    active.delete(current);
    visited.add(current);
  };

  visit(schema, "");

  for (let index = 0; index < localReferences.length; index += 1) {
    const { reference, pointer, source } = localReferences[index]!;
    const target = resolveLocalReference(schema, reference);
    if (target === undefined) {
      fail(pointer, `unresolved local $ref ${reference}`);
    }
    visit(target.schema, target.pointer);
    if (typeof target.schema !== "boolean") {
      if (reachesSameInstance(target.schema, source)) {
        fail(pointer, "non-productive same-instance cycle");
      }
      addSameInstanceEdge(source, target.schema, target.pointer);
    }
    validateSchemaShape(target.schema, target.pointer);
  }

  validateSchemaShape(schema, "");
}
