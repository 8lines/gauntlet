import {
  computeRevision,
  type AdapterManifest,
  type JsonObject,
  type Problem,
  type Run,
  type ValidationError,
} from "@8lines/gauntlet-protocol";
import { ownFrozenJson } from "./ownership.js";

const SAFE_TYPE = /^urn:gauntlet:problem:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_CAPABILITY = /^[A-Za-z0-9][A-Za-z0-9._:-]*@[0-9]+$/;
const JSON_POINTER = /^(?:\/(?:[^~/]|~[01])*)*$/;
const SAFE_VALIDATION_KEYWORDS = new Set([
  "additionalProperties",
  "const",
  "enum",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "multipleOf",
  "oneOf",
  "pattern",
  "required",
  "type",
  "uniqueItems",
  "validation",
]);

const TITLES: Readonly<Record<string, string>> = Object.freeze({
  "urn:gauntlet:problem:adapter-disabled": "Adapter unavailable",
  "urn:gauntlet:problem:adapter-invalid-response": "Invalid adapter response",
  "urn:gauntlet:problem:adapter-protocol-incompatible": "Incompatible adapter protocol",
  "urn:gauntlet:problem:adapter-unavailable": "Adapter unavailable",
  "urn:gauntlet:problem:artifact-not-found": "Artifact not found",
  "urn:gauntlet:problem:cross-site-request": "Cross-site request rejected",
  "urn:gauntlet:problem:data-source-not-found": "Data source not found",
  "urn:gauntlet:problem:invalid-credentials": "Invalid credentials",
  "urn:gauntlet:problem:invalid-json": "Invalid JSON",
  "urn:gauntlet:problem:invalid-path": "Invalid path",
  "urn:gauntlet:problem:invalid-request": "Invalid request",
  "urn:gauntlet:problem:method-not-allowed": "Method not allowed",
  "urn:gauntlet:problem:operation-not-found": "Operation not found",
  "urn:gauntlet:problem:rate-limited": "Too many attempts",
  "urn:gauntlet:problem:payload-too-large": "Payload too large",
  "urn:gauntlet:problem:route-not-found": "Route not found",
  "urn:gauntlet:problem:run-not-found": "Run not found",
  "urn:gauntlet:problem:session-launch-unavailable": "Session launch unavailable",
  "urn:gauntlet:problem:stale-operation-revision": "Stale operation revision",
  "urn:gauntlet:problem:target-environment-mismatch": "Target environment mismatch",
  "urn:gauntlet:problem:target-not-found": "Target not found",
  "urn:gauntlet:problem:unauthenticated": "Authentication required",
  "urn:gauntlet:problem:unsupported-capability": "Unsupported capability",
  "urn:gauntlet:problem:unsupported-media-type": "Unsupported media type",
  "urn:gauntlet:problem:validation-failed": "Request validation failed",
});

const FIXED_EXECUTION_PROBLEMS: Readonly<Record<string, {
  readonly title: string;
  readonly status: number;
}>> = Object.freeze({
  "urn:gauntlet:problem:operation-busy": { title: "Operation busy", status: 409 },
  "urn:gauntlet:problem:run-not-cancellable": { title: "Run is not cancellable", status: 409 },
  "urn:gauntlet:problem:run-cancelled": { title: "Run cancelled", status: 409 },
  "urn:gauntlet:problem:run-timed-out": { title: "Run timed out", status: 504 },
  "urn:gauntlet:problem:target-environment-mismatch": { title: "Target environment mismatch", status: 503 },
});

function safeStatus(value: number): number {
  return Number.isInteger(value) && value >= 400 && value <= 599 ? value : 500;
}

function safeType(value: string): `urn:gauntlet:problem:${string}` {
  return SAFE_TYPE.test(value)
    ? value as `urn:gauntlet:problem:${string}`
    : "urn:gauntlet:problem:adapter-error";
}

function genericTitle(status: number): string {
  if (status === 400) return "Bad request";
  if (status === 404) return "Resource not found";
  if (status === 409) return "Request conflict";
  if (status === 413) return "Payload too large";
  if (status === 415) return "Unsupported media type";
  if (status === 422) return "Request validation failed";
  if (status === 501) return "Unsupported capability";
  if (status >= 500) return "Adapter request failed";
  return "Request failed";
}

function hasOnlyUnicodeScalars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function safeValidationError(value: unknown): ValidationError | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<ValidationError>;
  if (typeof candidate.instancePath !== "string"
    || candidate.instancePath.length > 1_024
    || !JSON_POINTER.test(candidate.instancePath)
    || !hasOnlyUnicodeScalars(candidate.instancePath)) {
    return undefined;
  }
  const keyword = typeof candidate.keyword === "string" && SAFE_VALIDATION_KEYWORDS.has(candidate.keyword)
    ? candidate.keyword
    : "validation";
  return Object.freeze({
    instancePath: candidate.instancePath,
    schemaPath: "#",
    keyword,
    message: keyword === "required"
      ? "Required value is missing"
      : keyword === "additionalProperties"
        ? "Unexpected field"
        : "Invalid value",
    params: Object.freeze({}),
  });
}

export function safeProblem(problem: Problem): Problem {
  const type = safeType(problem.type);
  const fixed = FIXED_EXECUTION_PROBLEMS[type];
  const status = fixed?.status ?? safeStatus(problem.status);
  const capability = problem.capability !== undefined && SAFE_CAPABILITY.test(problem.capability)
    ? problem.capability
    : undefined;
  const errors = problem.type === "urn:gauntlet:problem:validation-failed" && Array.isArray(problem.errors)
    ? problem.errors.map(safeValidationError).filter((error): error is ValidationError => error !== undefined)
    : [];
  return Object.freeze({
    type,
    title: fixed?.title ?? TITLES[type] ?? genericTitle(status),
    status,
    ...(capability === undefined ? {} : { capability }),
    ...(errors.length === 0 ? {} : { errors: Object.freeze(errors) }),
  });
}

export function safeManifestProjection(manifest: AdapterManifest): AdapterManifest {
  const operations = manifest.operations.map((operation) => operation.availability.state === "available"
    ? operation
    : {
        ...operation,
        availability: {
          state: "unavailable" as const,
          problem: safeProblem(operation.availability.problem),
        },
      });
  const projected = { ...manifest, operations };
  return ownFrozenJson({
    ...projected,
    manifestRevision: computeRevision(projected as unknown as JsonObject, "manifestRevision"),
  }) as AdapterManifest;
}

export function safeRunProjection(run: Run): Run {
  if (run.problem === undefined) {
    return ownFrozenJson(run);
  }
  return ownFrozenJson({ ...run, problem: safeProblem(run.problem) }) as Run;
}
