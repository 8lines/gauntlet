import type { JsonPointer, OperationDefinition } from "./types.js";

export const PAGE_PLACEMENTS_PROFILE = "gauntlet-page-placements@1";

const SCALAR_TYPES = new Set(["string", "number", "integer", "boolean"]);

function decodeSegments(pointer: string): readonly string[] | undefined {
  if (pointer === "" || !pointer.startsWith("/")) return undefined;
  const segments: string[] = [];
  for (const raw of pointer.slice(1).split("/")) {
    if (/~(?![01])/.test(raw)) return undefined;
    segments.push(raw.replaceAll("~1", "/").replaceAll("~0", "~"));
  }
  return segments;
}

function encodeSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

export function placementSchemaPointer(inputPointer: JsonPointer): JsonPointer | undefined {
  const segments = decodeSegments(inputPointer);
  return segments === undefined
    ? undefined
    : segments.map((segment) => `/properties/${encodeSegment(segment)}`).join("") as JsonPointer;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isScalar(value: unknown): boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

const NON_TRAVERSABLE_KEYWORDS = [
  "$ref",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
] as const;

function hasNonTraversableKeyword(schema: Record<string, unknown>): boolean {
  return NON_TRAVERSABLE_KEYWORDS.some((keyword) => Object.hasOwn(schema, keyword));
}

function scalarLeaf(schema: Record<string, unknown>): boolean {
  if (hasNonTraversableKeyword(schema)) return false;
  if (Object.hasOwn(schema, "enum")) {
    const values = schema.enum;
    return Array.isArray(values) && values.length > 0 && values.every(isScalar);
  }
  if (Object.hasOwn(schema, "const")) return isScalar(schema.const);
  return typeof schema.type === "string" && SCALAR_TYPES.has(schema.type);
}

function bindingTargetIsScalar(inputSchema: unknown, pointer: string): boolean {
  const segments = decodeSegments(pointer);
  if (segments === undefined) return false;
  let node = record(inputSchema);
  if (node === undefined || hasNonTraversableKeyword(node)) return false;
  for (const segment of segments) {
    const properties = record(node.properties);
    if (properties === undefined || !Object.hasOwn(properties, segment)) return false;
    node = record(properties[segment]);
    if (node === undefined || hasNonTraversableKeyword(node)) return false;
  }
  return scalarLeaf(node);
}

export function operationPlacementsAreValid(
  operation: Pick<OperationDefinition, "inputSchema" | "inputHandling" | "placements">,
): boolean {
  const placements = operation.placements;
  if (placements === undefined) return true;
  if (placements.length === 0) return false;
  const guarded = operation.inputHandling?.rules.map(({ schemaPointer }) => schemaPointer) ?? [];
  let globals = 0;
  const subjectTypes = new Set<string>();
  for (const placement of placements) {
    if (placement.kind === "global") {
      globals += 1;
      continue;
    }
    if (subjectTypes.has(placement.subjectType)) return false;
    subjectTypes.add(placement.subjectType);
    for (const pointer of Object.keys(placement.bindings ?? {})) {
      const schemaPointer = placementSchemaPointer(pointer as JsonPointer);
      if (schemaPointer === undefined || !bindingTargetIsScalar(operation.inputSchema, pointer)) return false;
      if (guarded.some((rule) => schemaPointer === rule || schemaPointer.startsWith(`${rule}/`))) return false;
    }
  }
  return globals <= 1;
}
