import { createHmac, randomUUID } from "node:crypto";
import {
  type Artifact,
  type CreateRunRequest,
  type FileReference,
  type FollowUpAction,
  type InputHandlingRule,
  type InvocationContext,
  type JsonObject,
  type JsonValue,
  type ObjectJsonSchema,
  type OperationDefinition,
  type Problem,
  type Rfc3339Timestamp,
  type Run,
  type ValidationError,
  runSemanticsAreValid,
} from "@8lines/gauntlet-protocol";
import { OperationRegistry } from "./operation-registry.js";
import { cloneAndDeepFreeze } from "./operation-internals.js";
import {
  type OperationResult,
  type RegisteredOperation,
  type StructuredLogEntry,
} from "./operation.js";
import {
  adapterInternalErrorProblem,
  handlerFailedProblem,
  operationBusyProblem,
  operationNotFoundProblem,
  runCancelledProblem,
  runNotCancellableProblem,
  runNotFoundProblem,
  runTimedOutProblem,
  staleOperationRevisionProblem,
  validationFailedProblem,
} from "./problems.js";
import type { RunContext } from "./run-context.js";
import {
  RunStoreConflictError,
  type RunStore,
} from "./run-store.js";
import {
  InMemoryExecutionCoordinator,
  type ExecutionCoordinator,
  type ExecutionLease,
} from "./execution-coordinator.js";
import {
  assertCanonicalOutput,
  assertCanonicalRun,
  isCanonicalFileReference,
  validateCanonicalCreateRunRequest,
} from "./runtime-validation.js";

type MaybePromise<T> = T | Promise<T>;
type FileRule = Extract<InputHandlingRule, { kind: "file" }>;

export interface SchemaValidationRequest {
  readonly schema: ObjectJsonSchema;
  readonly value: JsonObject;
  readonly subject: "input" | "context";
}

export interface FileReferenceValidationRequest {
  readonly reference: FileReference;
  readonly rule: FileRule;
  readonly instancePath: string;
  readonly operationId: string;
  readonly operationRevision: string;
  readonly validatedAt: Rfc3339Timestamp;
}

export interface RunManagerOptions {
  readonly validateSchema: (
    request: SchemaValidationRequest,
  ) => MaybePromise<readonly ValidationError[]>;
  readonly validateFileReference: (
    request: FileReferenceValidationRequest,
  ) => MaybePromise<readonly ValidationError[]>;
  readonly now?: () => Rfc3339Timestamp;
  readonly createId?: () => string;
  /** Accepts a process-local one-shot callback. It must never serialize the callback or its closure. */
  readonly schedule?: (task: () => Promise<void>) => void;
  /** Defaults to process-local coordination. Inject a shared implementation for multi-replica adapters. */
  readonly executionCoordinator?: ExecutionCoordinator;
  /** At least 32 stable high-entropy bytes used to fingerprint idempotency keys. */
  readonly idempotencySecret: Uint8Array;
}

export type CreateRunResult =
  | { readonly ok: true; readonly run: Run }
  | { readonly ok: false; readonly problem: Problem };

export type CancelRunResult = Run | Problem;

interface SecretRedactor {
  contains(value: unknown): boolean;
  assertSafePayload(value: unknown): void;
  sanitizeValidationErrors(errors: readonly ValidationError[]): readonly ValidationError[];
}

type ActiveRun = Extract<Run, { readonly state: "queued" | "running" }>;

interface ManagedExecution {
  readonly run: Run;
  readonly dryRun: boolean;
  readonly executionLease: ExecutionLease;
  readonly signal: AbortSignal;
  readonly terminationController: AbortController;
  readonly releaseLease: () => Promise<void>;
  readonly invocationContextLease: InvocationContextLease;
  executionTask?: RevocableExecutionTask;
  closeContext?: () => void;
  cancelTimeout?: () => void;
  terminateActive?: (state: "cancelled" | "timed_out", problem: Problem) => Promise<CancelRunResult>;
  terminalizing?: Promise<CancelRunResult>;
}

class RevocableExecutionTask {
  #execute: (() => Promise<void>) | undefined;
  #started = false;

  constructor(execute: () => Promise<void>) {
    this.#execute = execute;
  }

  readonly run = async (): Promise<void> => {
    if (this.#started) return;
    const execute = this.#execute;
    if (execute === undefined) return;
    this.#started = true;
    // The scheduler may retain `run`, but it no longer retains input/guard/context
    // after this point. The local reference lives only until execution settles.
    this.#execute = undefined;
    await execute();
  };

  revoke(): void {
    if (!this.#started) this.#execute = undefined;
  }
}

type StoreRunRead =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "valid"; readonly run: Run };

type CreateStoreRecovery =
  | { readonly kind: "candidate" }
  | { readonly kind: "winner"; readonly run: Run; readonly candidateDurable: boolean }
  | { readonly kind: "missing" }
  | { readonly kind: "invalid"; readonly candidateDurable: boolean };

export interface RunProjectionExpectation {
  readonly id?: string;
  readonly operationId?: string;
  readonly operationRevision?: string;
}

const CORE_PROBLEM_TYPES = new Set<string>([
  "urn:gauntlet:problem:adapter-disabled",
  "urn:gauntlet:problem:unsupported-capability",
  "urn:gauntlet:problem:operation-not-found",
  "urn:gauntlet:problem:run-not-found",
  "urn:gauntlet:problem:data-source-not-found",
  "urn:gauntlet:problem:route-not-found",
  "urn:gauntlet:problem:method-not-allowed",
  "urn:gauntlet:problem:invalid-json",
  "urn:gauntlet:problem:invalid-path",
  "urn:gauntlet:problem:validation-failed",
  "urn:gauntlet:problem:stale-operation-revision",
  "urn:gauntlet:problem:handler-failed",
  "urn:gauntlet:problem:adapter-invalid-response",
  "urn:gauntlet:problem:adapter-unavailable",
  "urn:gauntlet:problem:adapter-internal-error",
  "urn:gauntlet:problem:operation-busy",
  "urn:gauntlet:problem:run-not-cancellable",
  "urn:gauntlet:problem:run-cancelled",
  "urn:gauntlet:problem:run-timed-out",
]);

const CORE_ARTIFACT_KINDS = new Set<string>([
  "notice",
  "metrics",
  "key-value",
  "table",
  "json",
  "markdown",
  "diff",
  "timeline",
  "log",
  "download",
  "link",
  "browser-launch",
  "urn:gauntlet:artifact:structured-log",
]);

const OPERATION_RESULT_KEYS = new Set([
  "outcome",
  "problem",
  "summary",
  "output",
  "artifacts",
  "actions",
]);

function validationError(
  instancePath: string,
  schemaPath: string,
  keyword: string,
  message: string,
  params: JsonObject = {},
): ValidationError {
  return { instancePath, schemaPath, keyword, message, params };
}

function ownCanonicalStoreRun(
  value: Run | undefined,
  expected: RunProjectionExpectation,
): StoreRunRead {
  if (value === undefined) return { kind: "missing" };
  try {
    const run = cloneAndDeepFreeze(value);
    assertCanonicalRun(run);
    if ((expected.id !== undefined && run.id !== expected.id)
      || (expected.operationId !== undefined && run.operationId !== expected.operationId)
      || (expected.operationRevision !== undefined
        && run.operationRevision !== expected.operationRevision)) {
      return { kind: "invalid" };
    }
    return { kind: "valid", run };
  } catch {
    return { kind: "invalid" };
  }
}

function decodePointer(pointer: string): readonly string[] | undefined {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) return undefined;
  const segments: string[] = [];
  for (const encoded of pointer.slice(1).split("/")) {
    if (/~(?:[^01]|$)/.test(encoded)) return undefined;
    segments.push(encoded.replaceAll("~1", "/").replaceAll("~0", "~"));
  }
  return segments;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function assertOperationResultUnion(value: unknown): asserts value is OperationResult {
  const result = asRecord(value);
  if (result === undefined || Object.keys(result).some((key) => !OPERATION_RESULT_KEYS.has(key))) {
    throw new TypeError("Operation result must be a closed object");
  }

  const outcome = result.outcome;
  const hasProblem = Object.hasOwn(result, "problem");
  if (outcome === "partial") {
    if (!hasProblem) throw new TypeError("Partial result requires a Problem");
  } else if (outcome === undefined || outcome === "succeeded") {
    if (hasProblem) throw new TypeError("Successful result cannot contain a Problem");
  } else {
    throw new TypeError("Operation result has an invalid outcome");
  }

  if ((Object.hasOwn(result, "artifacts") && !Array.isArray(result.artifacts))
    || (Object.hasOwn(result, "actions") && !Array.isArray(result.actions))) {
    throw new TypeError("Operation result collections must be arrays");
  }
}

type SchemaNode = boolean | Record<string, unknown>;

interface ResolvedSchemaPointer {
  readonly pointer: string;
  readonly schema: SchemaNode;
}

function asSchemaNode(value: unknown): SchemaNode | undefined {
  if (typeof value === "boolean") return value;
  return asRecord(value);
}

function resolveSchemaPointer(
  rootSchema: ObjectJsonSchema,
  segments: readonly string[],
): ResolvedSchemaPointer | undefined {
  let current: unknown = rootSchema;
  for (const segment of segments) {
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  const schema = asSchemaNode(current);
  return schema === undefined ? undefined : { pointer: pointerFor(segments), schema };
}

function resolveLocalSchemaReference(
  rootSchema: ObjectJsonSchema,
  reference: string,
): ResolvedSchemaPointer | undefined {
  if (!reference.startsWith("#")) return undefined;
  let pointer: string;
  try {
    pointer = decodeURIComponent(reference.slice(1));
  } catch {
    return undefined;
  }
  const segments = decodePointer(pointer);
  return segments === undefined ? undefined : resolveSchemaPointer(rootSchema, segments);
}

interface ResolvedInputLocation {
  readonly value: JsonValue;
  readonly instancePath: string;
}

interface ResolvedRuleLocations {
  readonly locations: readonly ResolvedInputLocation[];
  readonly error?: string;
}

function resolveRuleInputLocations(
  rootSchema: ObjectJsonSchema,
  root: JsonObject,
  pointer: string,
): ResolvedRuleLocations {
  const schemaSegments = decodePointer(pointer);
  if (schemaSegments === undefined) return { locations: [], error: "schema pointer is malformed" };
  const target = resolveSchemaPointer(rootSchema, schemaSegments);
  if (target === undefined) return { locations: [], error: "schema pointer does not identify a schema" };

  const ABSENT = Symbol("absent-input");
  type TraversedValue = JsonValue | typeof ABSENT;
  interface TraversalState {
    readonly routeOrigin?: string;
    readonly structuralSinceOrigin: boolean;
    readonly activeSchemaPointers: ReadonlySet<string>;
    readonly addressabilityError?: string;
  }

  const locations = new Map<string, ResolvedInputLocation>();
  const targetOrigins = new Set<string>();
  const visited = new Map<string, Set<string>>();
  const absentVisited = new Set<string>();
  let reachedAddressably = false;
  let addressabilityError: string | undefined;

  const schemaChildPointer = (parent: string, segment: string): string =>
    `${parent}/${segment.replaceAll("~", "~0").replaceAll("/", "~1")}`;

  const childState = (state: TraversalState): TraversalState => ({
    ...state,
    structuralSinceOrigin: state.routeOrigin === undefined
      ? false
      : true,
  });

  const inputChild = (
    value: TraversedValue,
    property: string,
  ): TraversedValue => value !== ABSENT
    && value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.hasOwn(value, property)
    ? (value as JsonObject)[property]!
    : ABSENT;

  const visit = (
    schemaPointer: string,
    schema: SchemaNode,
    value: TraversedValue,
    instanceSegments: readonly string[],
    state: TraversalState,
  ): void => {
    const instancePointer = pointerFor(instanceSegments);
    if (schemaPointer === target.pointer) {
      if (state.addressabilityError !== undefined) {
        addressabilityError ??= state.addressabilityError;
      } else {
        reachedAddressably = true;
        if (schema !== false) {
          targetOrigins.add(state.routeOrigin ?? `direct:${target.pointer}`);
          if (value !== ABSENT) {
            locations.set(instancePointer, { value, instancePath: instancePointer });
          }
        }
      }
    }

    if (value === ABSENT) {
      if (absentVisited.has(schemaPointer)) return;
      absentVisited.add(schemaPointer);
    }

    const instancePointers = visited.get(schemaPointer) ?? new Set<string>();
    if (instancePointers.has(instancePointer)) return;
    instancePointers.add(instancePointer);
    visited.set(schemaPointer, instancePointers);
    if (typeof schema === "boolean") return;

    const activeSchemaPointers = new Set(state.activeSchemaPointers);
    activeSchemaPointers.add(schemaPointer);
    const activeState: TraversalState = { ...state, activeSchemaPointers };

    if (typeof schema.$ref === "string") {
      const referenced = resolveLocalSchemaReference(rootSchema, schema.$ref);
      if (referenced !== undefined) {
        const recursive = activeSchemaPointers.has(referenced.pointer);
        const needsOrigin = !recursive
          && (state.routeOrigin === undefined || state.structuralSinceOrigin);
        visit(
          referenced.pointer,
          referenced.schema,
          value,
          instanceSegments,
          {
            ...activeState,
            ...(needsOrigin
              ? { routeOrigin: schemaChildPointer(schemaPointer, "$ref") }
              : {}),
            structuralSinceOrigin: false,
          },
        );
      }
    }

    const properties = asRecord(schema.properties);
    if (properties !== undefined) {
      for (const [property, child] of Object.entries(properties)) {
        const childSchema = asSchemaNode(child);
        if (childSchema === undefined) continue;
        visit(
          schemaChildPointer(schemaChildPointer(schemaPointer, "properties"), property),
          childSchema,
          inputChild(value, property),
          [...instanceSegments, property],
          childState(activeState),
        );
      }
    }

    const dependentSchemas = asRecord(schema.dependentSchemas);
    if (dependentSchemas !== undefined) {
      for (const [property, child] of Object.entries(dependentSchemas)) {
        const childSchema = asSchemaNode(child);
        if (childSchema === undefined) continue;
        const applies = value !== ABSENT
          && value !== null
          && typeof value === "object"
          && !Array.isArray(value)
          && Object.hasOwn(value, property);
        visit(
          schemaChildPointer(schemaChildPointer(schemaPointer, "dependentSchemas"), property),
          childSchema,
          applies ? value : ABSENT,
          instanceSegments,
          activeState,
        );
      }
    }

    for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
      const children = schema[keyword];
      if (!Array.isArray(children)) continue;
      children.forEach((child, index) => {
        const childSchema = asSchemaNode(child);
        if (childSchema !== undefined) {
          visit(
            schemaChildPointer(schemaChildPointer(schemaPointer, keyword), String(index)),
            childSchema,
            value,
            instanceSegments,
            activeState,
          );
        }
      });
    }

    for (const keyword of ["not", "if", "then", "else"] as const) {
      if (!Object.hasOwn(schema, keyword)) continue;
      const childSchema = asSchemaNode(schema[keyword]);
      if (childSchema !== undefined) {
        visit(
          schemaChildPointer(schemaPointer, keyword),
          childSchema,
          value,
          instanceSegments,
          activeState,
        );
      }
    }

    const prefixItems = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
    prefixItems.forEach((child, index) => {
      const childSchema = asSchemaNode(child);
      if (childSchema === undefined) return;
      const childValue = Array.isArray(value) && index < value.length ? value[index]! : ABSENT;
      visit(
        schemaChildPointer(schemaChildPointer(schemaPointer, "prefixItems"), String(index)),
        childSchema,
        childValue,
        [...instanceSegments, String(index)],
        childState(activeState),
      );
    });

    if (Object.hasOwn(schema, "items")) {
      const childSchema = asSchemaNode(schema.items);
      if (childSchema !== undefined) {
        const firstTailIndex = prefixItems.length;
        const actualTailLength = Array.isArray(value)
          ? Math.max(0, value.length - firstTailIndex)
          : 0;
        const visitCount = Math.max(1, actualTailLength);
        for (let offset = 0; offset < visitCount; offset += 1) {
          const index = firstTailIndex + offset;
          visit(
            schemaChildPointer(schemaPointer, "items"),
            childSchema,
            Array.isArray(value) && index < value.length ? value[index]! : ABSENT,
            [...instanceSegments, String(index)],
            childState(activeState),
          );
        }
      }
    }

    const patternProperties = asRecord(schema.patternProperties);
    if (patternProperties !== undefined) {
      for (const [pattern, child] of Object.entries(patternProperties)) {
        const childSchema = asSchemaNode(child);
        if (childSchema !== undefined) {
          visit(
            schemaChildPointer(schemaChildPointer(schemaPointer, "patternProperties"), pattern),
            childSchema,
            value,
            instanceSegments,
            {
              ...activeState,
              addressabilityError: "patternProperties is ambiguous as an instance location",
            },
          );
        }
      }
    }

    for (const keyword of [
      "contains",
      "additionalProperties",
      "propertyNames",
      "unevaluatedItems",
      "unevaluatedProperties",
      "contentSchema",
    ] as const) {
      if (!Object.hasOwn(schema, keyword)) continue;
      const childSchema = asSchemaNode(schema[keyword]);
      if (childSchema !== undefined) {
        visit(
          schemaChildPointer(schemaPointer, keyword),
          childSchema,
          value,
          instanceSegments,
          {
            ...activeState,
            addressabilityError: `${keyword} does not identify a unique instance location`,
          },
        );
      }
    }
  };

  visit("", rootSchema, root, [], {
    structuralSinceOrigin: false,
    activeSchemaPointers: new Set(),
  });

  if (addressabilityError !== undefined) return { locations: [], error: addressabilityError };
  if (!reachedAddressably) {
    return { locations: [], error: "schema pointer has no instance-addressable reference" };
  }
  if (targetOrigins.size > 1) {
    return { locations: [], error: "schema pointer reference is ambiguous" };
  }
  return { locations: [...locations.values()] };
}

function requireActiveRun(run: Run): ActiveRun {
  if (run.state !== "queued" && run.state !== "running") {
    throw new TypeError("Run is already terminal");
  }
  return run;
}

function pointerFor(segments: readonly string[]): string {
  return segments.length === 0
    ? ""
    : `/${segments.map((segment) => segment.replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

function collectSecretAtoms(value: JsonValue, atoms: JsonValue[]): void {
  if (Array.isArray(value)) {
    for (const child of value) collectSecretAtoms(child, atoms);
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      atoms.push(key);
      collectSecretAtoms(child, atoms);
    }
  } else {
    atoms.push(value);
  }
}

function createSecretGuard(
  inputSchema: ObjectJsonSchema,
  input: JsonObject,
  rules: readonly InputHandlingRule[],
): { readonly guard: SecretRedactor; readonly errors: readonly ValidationError[] } {
  const secretAtoms: JsonValue[] = [];
  const errors: ValidationError[] = [];
  for (const rule of rules) {
    if (rule.kind !== "secret") continue;
    const resolved = resolveRuleInputLocations(inputSchema, input, rule.schemaPointer);
    if (resolved.error !== undefined) {
      errors.push(validationError(
        "",
        rule.schemaPointer,
        "schemaPointer",
        resolved.error,
      ));
      continue;
    }
    for (const { value } of resolved.locations) {
      collectSecretAtoms(value, secretAtoms);
    }
  }

  const contains = (value: unknown): boolean => {
    if (typeof value === "string") {
      return secretAtoms.some((secret) => typeof secret === "string"
        && (secret === "" ? value === "" : value.includes(secret)));
    }
    if (value === null || typeof value === "number" || typeof value === "boolean") {
      return secretAtoms.some((secret) => Object.is(secret, value));
    }
    if (Array.isArray(value)) return value.some(contains);
    if (typeof value === "object" && value !== null) {
      return Object.entries(value).some(([key, child]) => contains(key) || contains(child));
    }
    return false;
  };

  const safeDiagnosticString = (value: unknown, fallback: string): string =>
    typeof value === "string" && !contains(value) ? value : fallback;

  const guard: SecretRedactor = {
    contains,
    assertSafePayload: (value) => {
      if (contains(value)) throw new TypeError("Handler payload contains protected input");
    },
    sanitizeValidationErrors: (validationErrors) => {
      const ownedErrors = cloneAndDeepFreeze(validationErrors);
      return ownedErrors.map((error) => ({
        instancePath: safeDiagnosticString(error.instancePath, ""),
        schemaPath: safeDiagnosticString(error.schemaPath, "#"),
        keyword: safeDiagnosticString(error.keyword, "validation"),
        message: safeDiagnosticString(error.message, "value does not satisfy schema"),
        params: contains(error.params) ? {} : cloneAndDeepFreeze(error.params),
        ...(error.extensions === undefined || contains(error.extensions)
          ? {}
          : { extensions: cloneAndDeepFreeze(error.extensions) }),
      }));
    },
  };

  return {
    guard,
    errors,
  };
}

function assertSafeProblem(problem: Problem, guard: SecretRedactor): void {
  const { type, status: _status, ...payload } = problem;
  if (!CORE_PROBLEM_TYPES.has(type)) guard.assertSafePayload(type);
  guard.assertSafePayload(payload);
}

function assertSafeArtifact(artifact: Artifact, guard: SecretRedactor): void {
  if (!CORE_ARTIFACT_KINDS.has(artifact.kind)) guard.assertSafePayload(artifact.kind);
  if (artifact.kind === "notice") {
    const { kind: _kind, level: _level, ...noticePayload } = artifact;
    guard.assertSafePayload(noticePayload);
    return;
  }
  if (artifact.kind === "diff") {
    const { kind: _kind, format: _format, ...diffPayload } = artifact;
    guard.assertSafePayload(diffPayload);
    return;
  }
  if (artifact.kind === "log") {
    const { kind: _kind, entries, ...logPayload } = artifact;
    guard.assertSafePayload(logPayload);
    for (const { level: _level, timestamp: _timestamp, ...entryPayload } of entries) {
      guard.assertSafePayload(entryPayload);
    }
    return;
  }
  const { kind: _kind, ...payload } = artifact;
  guard.assertSafePayload(payload);
}

function assertSafeAction(action: FollowUpAction, guard: SecretRedactor): void {
  const { kind: _kind, ...payload } = action;
  guard.assertSafePayload(payload);
}

function assertSafeResultPayload(result: OperationResult, guard: SecretRedactor): void {
  if (result.summary !== undefined) {
    const { tone: _tone, ...summaryPayload } = result.summary;
    guard.assertSafePayload(summaryPayload);
  }
  if (result.output !== undefined) guard.assertSafePayload(result.output);
  if (result.outcome === "partial") assertSafeProblem(result.problem, guard);
}

function parseStrictRfc3339(value: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (match === null) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  const daysInMonth = month >= 1 && month <= 12
    ? new Date(Date.UTC(year, month, 0)).getUTCDate()
    : 0;
  if (day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59
    || offsetHour > 23 || offsetMinute > 59) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function asFileReference(value: JsonValue, instancePath: string, validatedAt: Rfc3339Timestamp):
  | { readonly reference: FileReference; readonly errors: readonly [] }
  | { readonly errors: readonly ValidationError[] } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { errors: [validationError(instancePath, "#/inputHandling", "file", "must be a file reference")] };
  }
  const candidate = value as JsonObject;
  const expiresAtMillis = typeof candidate.expiresAt === "string"
    ? parseStrictRfc3339(candidate.expiresAt)
    : undefined;
  const validationMillis = parseStrictRfc3339(validatedAt);
  const valid = isCanonicalFileReference(candidate)
    && expiresAtMillis !== undefined
    && validationMillis !== undefined
    && expiresAtMillis > validationMillis;
  if (!valid) {
    return { errors: [validationError(instancePath, "#/inputHandling", "file", "must be a valid file reference")] };
  }
  return { reference: candidate as unknown as FileReference, errors: [] };
}

function policyError(message: string): CreateRunResult {
  return {
    ok: false,
    problem: validationFailedProblem([
      validationError("/idempotencyKey", "#/idempotencyKey", "idempotency", message),
    ]),
  };
}

function confirmationErrors(
  operationId: string,
  operation: OperationDefinition,
  request: CreateRunRequest,
): readonly ValidationError[] {
  if (!operation.execution.confirmationRequired) return [];
  if (request.confirmation === undefined) {
    return [validationError(
      "/confirmation",
      "#/confirmation",
      "required",
      "confirmation acknowledgement is required",
    )];
  }
  if (request.confirmation.operationId !== operationId) {
    return [validationError(
      "/confirmation/operationId",
      "#/confirmation/operationId",
      "const",
      "confirmation operation does not match",
    )];
  }
  if (request.confirmation.operationRevision !== operation.revision) {
    return [validationError(
      "/confirmation/operationRevision",
      "#/confirmation/operationRevision",
      "const",
      "confirmation revision does not match",
    )];
  }
  if (request.confirmation.impact !== operation.execution.impact) {
    return [validationError(
      "/confirmation/impact",
      "#/confirmation/impact",
      "const",
      "confirmation impact does not match",
    )];
  }
  return [];
}

function idempotencyStorageKey(operationId: string, key: string, secret: Uint8Array): string {
  const fingerprint = createHmac("sha256", secret)
    .update("tc-idempotency:v1\0", "utf8")
    .update(operationId, "utf8")
    .update("\0", "utf8")
    .update(key, "utf8")
    .digest("hex");
  return `tc-idempotency:v1:${fingerprint}`;
}

class InvocationContextLease {
  #current: InvocationContext | undefined;

  constructor(current: InvocationContext | undefined) {
    this.#current = current;
  }

  read(): InvocationContext | undefined {
    return this.#current;
  }

  clear(): void {
    this.#current = undefined;
  }
}

const MAX_TIMER_DELAY_MILLISECONDS = 2_147_483_647n;

function monotonicTimestamp(
  candidate: Rfc3339Timestamp,
  lowerBound: Rfc3339Timestamp,
): Rfc3339Timestamp {
  return Date.parse(candidate) < Date.parse(lowerBound) ? lowerBound : candidate;
}

function scheduleBoundedTimeout(timeoutSeconds: number, task: () => void): () => void {
  let remaining = BigInt(timeoutSeconds) * 1_000n;
  let handle: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;

  const scheduleNext = (): void => {
    if (cancelled) return;
    const delay = remaining > MAX_TIMER_DELAY_MILLISECONDS
      ? MAX_TIMER_DELAY_MILLISECONDS
      : remaining;
    handle = setTimeout(() => {
      if (cancelled) return;
      remaining -= delay;
      if (remaining > 0n) scheduleNext();
      else task();
    }, Number(delay));
  };
  scheduleNext();

  return () => {
    if (cancelled) return;
    cancelled = true;
    if (handle !== undefined) clearTimeout(handle);
  };
}

export class RunManager {
  readonly #registry: OperationRegistry;
  readonly #store: RunStore;
  readonly #validateSchema: RunManagerOptions["validateSchema"];
  readonly #validateFileReference: RunManagerOptions["validateFileReference"];
  readonly #now: () => Rfc3339Timestamp;
  readonly #createId: () => string;
  readonly #schedule: (task: () => Promise<void>) => void;
  readonly #executionCoordinator: ExecutionCoordinator;
  readonly #idempotencySecret: Uint8Array;
  readonly #executions = new Map<string, ManagedExecution>();

  constructor(registry: OperationRegistry, store: RunStore, options: RunManagerOptions) {
    this.#registry = registry;
    this.#store = store;
    this.#validateSchema = options.validateSchema;
    this.#validateFileReference = options.validateFileReference;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#createId = options.createId ?? randomUUID;
    const idempotencySecret = options.idempotencySecret;
    if (!(idempotencySecret instanceof Uint8Array) || idempotencySecret.byteLength < 32) {
      throw new TypeError("idempotencySecret must contain at least 32 bytes");
    }
    this.#idempotencySecret = Uint8Array.from(idempotencySecret);
    this.#executionCoordinator = options.executionCoordinator ?? new InMemoryExecutionCoordinator();
    this.#schedule = options.schedule ?? ((task) => {
      queueMicrotask(() => {
        void task().catch(() => undefined);
      });
    });
  }

  async create(operationId: string, request: CreateRunRequest): Promise<CreateRunResult> {
    const operation = this.#registry.get(operationId);
    if (operation === undefined) {
      return { ok: false, problem: operationNotFoundProblem() };
    }

    let ownedRequest: unknown;
    try {
      ownedRequest = cloneAndDeepFreeze(request);
    } catch {
      return { ok: false, problem: validationFailedProblem([]) };
    }
    const envelope = validateCanonicalCreateRunRequest(ownedRequest);
    if (envelope.request === undefined) {
      return { ok: false, problem: validationFailedProblem(envelope.errors) };
    }
    const validatedRequest = envelope.request;

    if (validatedRequest.operationRevision !== operation.definition.revision) {
      return { ok: false, problem: staleOperationRevisionProblem() };
    }
    const acknowledgementErrors = confirmationErrors(
      operationId,
      operation.definition,
      validatedRequest,
    );
    if (acknowledgementErrors.length > 0) {
      return { ok: false, problem: validationFailedProblem(acknowledgementErrors) };
    }
    if (validatedRequest.dryRun === true && !operation.definition.execution.dryRunSupported) {
      return {
        ok: false,
        problem: validationFailedProblem([
          validationError("/dryRun", "#/dryRun", "dryRun", "operation does not support dry-run execution"),
        ]),
      };
    }

    const key = validatedRequest.idempotencyKey;
    const mode = operation.definition.execution.idempotency;
    if (mode === "none" && key !== undefined) {
      return policyError("operation does not accept an idempotency key");
    }
    if (mode === "required" && (key === undefined || key.trim() === "")) {
      return policyError("operation requires a non-blank idempotency key");
    }
    if (mode !== "none" && key !== undefined && key.trim() === "") {
      return policyError("idempotency key must not be blank");
    }

    const idempotencyFingerprint = key === undefined
      ? undefined
      : idempotencyStorageKey(operationId, key, this.#idempotencySecret);

    const rules = operation.definition.inputHandling?.rules ?? [];
    const { guard, errors: secretRuleErrors } = createSecretGuard(
      operation.definition.inputSchema,
      validatedRequest.input,
      rules,
    );

    try {
      const inputErrors = guard.sanitizeValidationErrors(await this.#validateSchema({
        schema: operation.definition.inputSchema,
        value: validatedRequest.input,
        subject: "input",
      }));
      if (inputErrors.length > 0) {
        return { ok: false, problem: validationFailedProblem(inputErrors) };
      }

      if (operation.definition.contextSchema !== undefined) {
        const contextErrors = guard.sanitizeValidationErrors(await this.#validateSchema({
          schema: operation.definition.contextSchema,
          value: (validatedRequest.context ?? {}) as unknown as JsonObject,
          subject: "context",
        }));
        if (contextErrors.length > 0) {
          return { ok: false, problem: validationFailedProblem(contextErrors) };
        }
      }

      const fileErrors = await this.#validateFiles(operation, validatedRequest.input, rules, guard);
      if (fileErrors.length > 0) {
        return { ok: false, problem: validationFailedProblem(fileErrors) };
      }
      if (secretRuleErrors.length > 0) {
        return {
          ok: false,
          problem: validationFailedProblem(guard.sanitizeValidationErrors(secretRuleErrors)),
        };
      }

      if (idempotencyFingerprint !== undefined) {
        const existing = await this.#readStoreRun(
          await this.#store.findByIdempotencyKey(operationId, idempotencyFingerprint),
          {
            operationId,
            operationRevision: operation.definition.revision,
          },
        );
        if (existing.kind === "invalid") {
          return { ok: false, problem: adapterInternalErrorProblem() };
        }
        if (existing.kind === "valid") return { ok: true, run: existing.run };
      }

      const timestamp = this.#now();
      const run = cloneAndDeepFreeze<Run>({
        id: this.#createId(),
        operationId,
        operationRevision: operation.definition.revision,
        state: "queued",
        sequence: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        artifacts: [],
        actions: [],
      });
      this.#assertCatalogRun(run);

      const invocationContextLease = new InvocationContextLease(validatedRequest.context);
      let executionLease: ExecutionLease | undefined;
      let managedExecution: ManagedExecution | undefined;
      let durableRunCreated = false;
      let releaseExecution!: (queued: Run | undefined) => void;
      try {
        for (;;) {
          const acquisition = await this.#executionCoordinator.acquire({
            operationId: operation.definition.id,
            runId: run.id,
            concurrency: operation.definition.execution.concurrency ?? "allow",
          });
          if (acquisition.kind === "acquired") {
            executionLease = acquisition;
            break;
          }

          const conflictCommitted = await acquisition.admissionSettled;
          if (idempotencyFingerprint !== undefined) {
            const existing = await this.#readStoreRun(
              await this.#store.findByIdempotencyKey(operationId, idempotencyFingerprint),
              {
                operationId,
                operationRevision: operation.definition.revision,
              },
            );
            if (existing.kind === "invalid") {
              invocationContextLease.clear();
              return { ok: false, problem: adapterInternalErrorProblem() };
            }
            if (existing.kind === "valid") {
              invocationContextLease.clear();
              return { ok: true, run: existing.run };
            }
          }
          if (!conflictCommitted) continue;
          invocationContextLease.clear();
          return { ok: false, problem: operationBusyProblem() };
        }
        const acquiredExecutionLease = executionLease;
        let leaseReleased = false;
        const terminationController = new AbortController();
        const activeExecution: ManagedExecution = {
          run,
          dryRun: validatedRequest.dryRun === true,
          executionLease: acquiredExecutionLease,
          signal: AbortSignal.any([acquiredExecutionLease.signal, terminationController.signal]),
          terminationController,
          releaseLease: async () => {
            if (leaseReleased) return;
            leaseReleased = true;
            await acquiredExecutionLease.release();
          },
          invocationContextLease,
        };
        managedExecution = activeExecution;
        const executionGate = new Promise<Run | undefined>((resolve) => {
          releaseExecution = resolve;
        });
        const executionTask = new RevocableExecutionTask(this.#createCandidateTask(
          operation,
          validatedRequest.input,
          guard,
          executionGate,
          activeExecution,
        ));
        managedExecution.executionTask = executionTask;

        try {
          this.#schedule(executionTask.run);
        } catch {
          releaseExecution(undefined);
          executionTask.revoke();
          invocationContextLease.clear();
          await activeExecution.releaseLease();
          return { ok: false, problem: adapterInternalErrorProblem() };
        }

        try {
          await this.#store.create(run, idempotencyFingerprint);
          durableRunCreated = true;
        } catch {
          const recovery = await this.#recoverCreateStoreError(
            run,
            operation,
            idempotencyFingerprint,
          );
          if (recovery.kind === "candidate") {
            durableRunCreated = true;
          } else {
            releaseExecution(undefined);
            executionTask.revoke();
            invocationContextLease.clear();
            if ((recovery.kind === "invalid" || recovery.kind === "winner")
              && recovery.candidateDurable) {
              await this.#terminalizeStoredRun(
                run,
                "failed",
                adapterInternalErrorProblem(),
              ).catch(() => undefined);
            }
            await activeExecution.releaseLease().catch(() => undefined);
            if (recovery.kind === "winner") {
              return { ok: true, run: recovery.run };
            }
            return { ok: false, problem: adapterInternalErrorProblem() };
          }
        }

        await acquiredExecutionLease.commitAdmission();
        this.#executions.set(run.id, activeExecution);
        let cancellationHandled = false;
        const handleCancellation = (): void => {
          if (cancellationHandled) return;
          cancellationHandled = true;
          acquiredExecutionLease.signal.removeEventListener("abort", handleCancellation);
          const timedOut = (acquiredExecutionLease.signal.reason as { type?: unknown } | undefined)?.type
            === "urn:gauntlet:problem:run-timed-out";
          void this.#requestTermination(
            activeExecution,
            timedOut ? "timed_out" : "cancelled",
            timedOut ? runTimedOutProblem() : runCancelledProblem(),
          ).catch(() => undefined);
        };
        acquiredExecutionLease.signal.addEventListener("abort", handleCancellation, { once: true });
        if (acquiredExecutionLease.signal.aborted) handleCancellation();
        releaseExecution(run);
        return { ok: true, run };
      } catch {
        releaseExecution?.(undefined);
        managedExecution?.executionTask?.revoke();
        invocationContextLease.clear();
        this.#executions.delete(run.id);
        if (durableRunCreated) {
          await this.#terminalizeStoredRun(
            run,
            "failed",
            adapterInternalErrorProblem(),
          ).catch(() => undefined);
        }
        await Promise.resolve()
          .then(() => managedExecution?.releaseLease() ?? executionLease?.release())
          .catch(() => undefined);
        return { ok: false, problem: adapterInternalErrorProblem() };
      }
    } catch {
      return { ok: false, problem: adapterInternalErrorProblem() };
    }
  }

  async get(runId: string): Promise<Run | undefined> {
    try {
      const stored = await this.#readStoreRun(await this.#store.get(runId), { id: runId });
      return stored.kind === "valid" ? stored.run : undefined;
    } catch {
      return undefined;
    }
  }

  async cancel(runId: string): Promise<CancelRunResult> {
    try {
      const stored = await this.#readStoreRun(await this.#store.get(runId), { id: runId });
      if (stored.kind === "missing") return runNotFoundProblem();
      if (stored.kind === "invalid") return adapterInternalErrorProblem();

      const operation = this.#registry.get(stored.run.operationId);
      if (operation === undefined
        || operation.definition.revision !== stored.run.operationRevision) {
        return adapterInternalErrorProblem();
      }
      if (!operation.definition.execution.cancellationSupported) {
        return runNotCancellableProblem();
      }
      if (stored.run.state !== "queued" && stored.run.state !== "running") return stored.run;

      const problem = runCancelledProblem();
      await this.#executionCoordinator.requestCancellation({
        operationId: stored.run.operationId,
        runId: stored.run.id,
        reason: cloneAndDeepFreeze(problem),
      });
      const managedExecution = this.#executions.get(runId);
      if (managedExecution !== undefined) {
        return await this.#requestTermination(
          managedExecution,
          "cancelled",
          problem,
        );
      }
      return await this.#terminalizeStoredRun(stored.run, "cancelled", problem);
    } catch {
      return adapterInternalErrorProblem();
    }
  }

  /** Applies the complete catalog-aware guard without reading or mutating the configured store. */
  async runProjectionIsValid(
    run: Run,
    expected: RunProjectionExpectation = {},
  ): Promise<boolean> {
    try {
      return (await this.#readStoreRun(run, expected)).kind === "valid";
    } catch {
      return false;
    }
  }

  async #validateFiles(
    operation: RegisteredOperation,
    input: JsonObject,
    rules: readonly InputHandlingRule[],
    guard: SecretRedactor,
  ): Promise<readonly ValidationError[]> {
    const errors: ValidationError[] = [];
    let validatedAt: Rfc3339Timestamp | undefined;
    for (const rule of rules) {
      if (rule.kind !== "file") continue;
      validatedAt ??= this.#now();
      const resolved = resolveRuleInputLocations(
        operation.definition.inputSchema,
        input,
        rule.schemaPointer,
      );
      if (resolved.error !== undefined) {
        errors.push(validationError(
          "",
          rule.schemaPointer,
          "schemaPointer",
          resolved.error,
        ));
        continue;
      }
      for (const location of resolved.locations) {
        const values = rule.multiple && Array.isArray(location.value) ? location.value : [location.value];
        if (rule.multiple && !Array.isArray(location.value)) {
          errors.push(validationError(
            location.instancePath,
            rule.schemaPointer,
            "file",
            "must be an array of file references",
          ));
          continue;
        }
        if (!rule.multiple && Array.isArray(location.value)) {
          errors.push(validationError(
            location.instancePath,
            rule.schemaPointer,
            "file",
            "must be one file reference",
          ));
          continue;
        }

        for (let index = 0; index < values.length; index += 1) {
          const itemPath = rule.multiple ? `${location.instancePath}/${index}` : location.instancePath;
          const parsed = asFileReference(values[index]!, itemPath, validatedAt);
          if (!("reference" in parsed)) {
            errors.push(...parsed.errors);
            continue;
          }
          if (rule.mediaTypes !== undefined && !rule.mediaTypes.includes(parsed.reference.mediaType)) {
            errors.push(validationError(itemPath, rule.schemaPointer, "mediaType", "file media type is not allowed"));
            continue;
          }
          if (rule.maxBytes !== undefined && parsed.reference.sizeBytes > rule.maxBytes) {
            errors.push(validationError(itemPath, rule.schemaPointer, "maxBytes", "file exceeds the maximum size"));
            continue;
          }
          errors.push(...guard.sanitizeValidationErrors(await this.#validateFileReference({
            reference: parsed.reference,
            rule,
            instancePath: itemPath,
            operationId: operation.definition.id,
            operationRevision: operation.definition.revision,
            validatedAt,
          })));
        }
      }
    }
    return errors;
  }

  async #recoverCreateStoreError(
    candidate: Run,
    operation: RegisteredOperation,
    idempotencyFingerprint: string | undefined,
  ): Promise<CreateStoreRecovery> {
    const expected = {
      operationId: operation.definition.id,
      operationRevision: operation.definition.revision,
    } as const;
    let byId: StoreRunRead = { kind: "missing" };
    let byIdLookupFailed = false;
    try {
      byId = await this.#readStoreRun(await this.#store.get(candidate.id), {
        ...expected,
        id: candidate.id,
      });
    } catch {
      // A lost create acknowledgement can coincide with a transient read-path
      // failure. The fingerprint reservation is an independent authoritative
      // recovery path, so consult it before deciding that no durable run exists.
      byIdLookupFailed = true;
    }
    if (idempotencyFingerprint !== undefined) {
      let byFingerprint: StoreRunRead;
      try {
        byFingerprint = await this.#readStoreRun(
          await this.#store.findByIdempotencyKey(
            candidate.operationId,
            idempotencyFingerprint,
          ),
          expected,
        );
      } catch {
        return { kind: "invalid", candidateDurable: byId.kind === "valid" };
      }
      if (byFingerprint.kind === "invalid") {
        return { kind: "invalid", candidateDurable: byId.kind === "valid" };
      }
      if (byFingerprint.kind === "valid") {
        if (byFingerprint.run.id !== candidate.id) {
          return {
            kind: "winner",
            run: byFingerprint.run,
            candidateDurable: byId.kind === "valid" || byIdLookupFailed,
          };
        }
        if (byId.kind === "invalid") {
          return { kind: "invalid", candidateDurable: true };
        }
        if (byFingerprint.run.state === "queued" && byFingerprint.run.sequence === 0) {
          if (byId.kind === "valid"
            && (byId.run.state !== "queued" || byId.run.sequence !== 0)) {
            return { kind: "invalid", candidateDurable: true };
          }
          return { kind: "candidate" };
        }
        if (byFingerprint.run.state !== "queued" && byFingerprint.run.state !== "running") {
          return { kind: "winner", run: byFingerprint.run, candidateDurable: false };
        }
        return { kind: "invalid", candidateDurable: true };
      } else if (byId.kind === "valid") {
        // The store exposed only half of the required atomic run/fingerprint reservation.
        return { kind: "invalid", candidateDurable: true };
      }
    }

    if (byIdLookupFailed) return { kind: "invalid", candidateDurable: false };
    if (byId.kind === "invalid") return { kind: "invalid", candidateDurable: false };
    if (byId.kind === "missing") return { kind: "missing" };
    if (byId.run.state === "queued" && byId.run.sequence === 0) {
      return { kind: "candidate" };
    }
    if (byId.run.state !== "queued" && byId.run.state !== "running") {
      return { kind: "winner", run: byId.run, candidateDurable: true };
    }
    return { kind: "invalid", candidateDurable: true };
  }

  #requestTermination(
    managedExecution: ManagedExecution,
    state: "cancelled" | "timed_out",
    problem: Problem,
  ): Promise<CancelRunResult> {
    if (managedExecution.terminalizing !== undefined) return managedExecution.terminalizing;

    managedExecution.executionTask?.revoke();
    if (!managedExecution.terminationController.signal.aborted) {
      managedExecution.terminationController.abort(cloneAndDeepFreeze(problem));
    }
    managedExecution.closeContext?.();
    managedExecution.cancelTimeout?.();
    if (managedExecution.terminateActive === undefined) {
      void Promise.resolve()
        .then(() => managedExecution.releaseLease())
        .catch(() => undefined);
    }

    const terminalizing = Promise.resolve().then(() => {
      const terminate = managedExecution.terminateActive;
      return terminate === undefined
        ? this.#terminalizeStoredRun(managedExecution.run, state, problem)
        : terminate(state, problem);
    }).finally(() => {
      if (this.#executions.get(managedExecution.run.id) === managedExecution) {
        this.#executions.delete(managedExecution.run.id);
      }
    });
    managedExecution.terminalizing = terminalizing;
    return terminalizing;
  }

  async #terminalizeStoredRun(
    expected: Run,
    state: "failed" | "cancelled" | "timed_out",
    problem: Problem,
  ): Promise<CancelRunResult> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const recovered = await this.#readStoreRun(await this.#store.get(expected.id), {
        id: expected.id,
        operationId: expected.operationId,
        operationRevision: expected.operationRevision,
      });
      if (recovered.kind === "missing") return runNotFoundProblem();
      if (recovered.kind === "invalid") return adapterInternalErrorProblem();
      const current = recovered.run;
      if (current.state !== "queued" && current.state !== "running") return current;

      try {
        const timestamp = monotonicTimestamp(this.#now(), current.updatedAt);
        const terminal: Run = {
          ...current,
          state,
          sequence: current.sequence + 1,
          updatedAt: timestamp,
          completedAt: timestamp,
          problem: cloneAndDeepFreeze(problem),
        };
        this.#assertCatalogRun(terminal);
        await this.#store.update(terminal, current.sequence);
        return terminal;
      } catch (error) {
        if (!(error instanceof RunStoreConflictError)) throw error;
      }
    }
    return adapterInternalErrorProblem();
  }

  #createCandidateTask(
    operation: RegisteredOperation,
    input: JsonObject,
    guard: SecretRedactor,
    executionGate: Promise<Run | undefined>,
    managedExecution: ManagedExecution,
  ): () => Promise<void> {
    return async () => {
      let queued: Run | undefined;
      try {
        queued = await executionGate;
        if (queued !== undefined
          && await managedExecution.executionLease.ready
          && !managedExecution.signal.aborted) {
          await this.#execute(operation, input, queued, guard, managedExecution);
        }
      } catch {
        if (queued !== undefined) {
          await this.#terminalizeStoredRun(
            queued,
            "failed",
            adapterInternalErrorProblem(),
          ).catch(() => undefined);
        }
      } finally {
        managedExecution.invocationContextLease.clear();
        await Promise.resolve()
          .then(() => managedExecution.releaseLease())
          .catch(() => undefined);
      }
    };
  }

  async #execute(
    operation: RegisteredOperation,
    input: JsonObject,
    queued: Run,
    guard: SecretRedactor,
    managedExecution: ManagedExecution,
  ): Promise<void> {
    const invocationContextLease = managedExecution.invocationContextLease;
    try {
      let current = queued;
      let pending = Promise.resolve();
      let contextOpen = true;
      let handlerSettled: Promise<OperationResult> | undefined;
      const signal = managedExecution.signal;
      const closeContext = (): void => {
        contextOpen = false;
        invocationContextLease.clear();
      };
      managedExecution.closeContext = closeContext;

      const persist = (create: (previous: Run, timestamp: Rfc3339Timestamp) => Run): void => {
        pending = pending.then(async () => {
          const next = create(current, monotonicTimestamp(this.#now(), current.updatedAt));
          this.#assertCatalogRun(next);
          await this.#store.update(next, current.sequence);
          current = next;
        });
      };
      const persistArtifact = (artifact: Artifact): void => {
        const safeArtifact = cloneAndDeepFreeze(artifact);
        assertSafeArtifact(safeArtifact, guard);
        persist((previous, timestamp) => {
          const active = requireActiveRun(previous);
          if (active.artifacts.some(({ id }) => id === safeArtifact.id)) {
            throw new TypeError("Run contains duplicate artifact IDs");
          }
          return {
            ...active,
            state: "running",
            sequence: active.sequence + 1,
            updatedAt: timestamp,
            artifacts: [...active.artifacts, safeArtifact],
          };
        });
      };
      const persistAction = (action: FollowUpAction): void => {
        const safeAction = cloneAndDeepFreeze(action);
        assertSafeAction(safeAction, guard);
        pending = pending.then(async () => {
          const active = requireActiveRun(current);
          await this.#assertActionIsValid(safeAction, active.artifacts);
          const next: ActiveRun = {
            ...active,
            state: "running",
            sequence: active.sequence + 1,
            updatedAt: monotonicTimestamp(this.#now(), current.updatedAt),
            actions: [...active.actions, safeAction],
          };
          this.#assertCatalogRun(next);
          await this.#store.update(next, current.sequence);
          current = next;
        });
      };

      const context: RunContext = {
        runId: queued.id,
        operationId: queued.operationId,
        dryRun: managedExecution.dryRun,
        signal,
        report: (progress) => {
          if (!contextOpen) return;
          const safeProgress = cloneAndDeepFreeze(progress);
          guard.assertSafePayload(safeProgress);
          persist((previous, timestamp) => {
            const active = requireActiveRun(previous);
            return {
              ...active,
              state: "running",
              sequence: active.sequence + 1,
              updatedAt: timestamp,
              progress: { ...safeProgress, updatedAt: timestamp },
            };
          });
        },
        addArtifact: (artifact) => {
          if (!contextOpen) return;
          persistArtifact(artifact);
        },
        addAction: (action) => {
          if (!contextOpen) return;
          persistAction(action);
        },
        log: (entry: StructuredLogEntry) => {
          if (!contextOpen) return;
          const safeEntry = cloneAndDeepFreeze(entry);
          const { level: _level, timestamp: _timestamp, ...entryPayload } = safeEntry;
          guard.assertSafePayload(entryPayload);
          persistArtifact({
            id: this.#createId(),
            kind: "urn:gauntlet:artifact:structured-log",
            data: safeEntry as unknown as JsonValue,
          });
        },
        warn: (message) => {
          if (!contextOpen) return;
          persistArtifact({
            id: this.#createId(),
            kind: "notice",
            level: "warning",
            message,
          });
        },
        throwIfCancelled: () => signal.throwIfAborted(),
      };
      Object.defineProperty(context, "invocationContext", {
        configurable: false,
        enumerable: false,
        get: invocationContextLease.read.bind(invocationContextLease),
      });
      Object.freeze(context);

      managedExecution.terminateActive = async (state, problem) => {
        closeContext();
        await pending.catch(() => undefined);
        return this.#terminalizeStoredRun(current, state, problem);
      };

      persist((previous, timestamp) => {
        const active = requireActiveRun(previous);
        return {
          ...active,
          state: "running",
          sequence: active.sequence + 1,
          updatedAt: timestamp,
          startedAt: timestamp,
        };
      });

      try {
        await pending;
        const timeoutSeconds = operation.definition.execution.timeoutSeconds;
        if (timeoutSeconds !== undefined) {
          managedExecution.cancelTimeout = scheduleBoundedTimeout(timeoutSeconds, () => {
            const problem = runTimedOutProblem();
            void this.#requestTermination(
              managedExecution,
              "timed_out",
              problem,
            ).catch(() => undefined);
            void Promise.resolve().then(() => this.#executionCoordinator.requestCancellation({
              operationId: queued.operationId,
              runId: queued.id,
              reason: cloneAndDeepFreeze(problem),
            })).catch(() => undefined);
          });
        }
        let result: OperationResult;
        try {
          let removeAbortListener = (): void => undefined;
          const aborted = new Promise<never>((_resolve, reject) => {
            if (signal.aborted) {
              reject(signal.reason);
              return;
            }
            const onAbort = (): void => reject(signal.reason);
            signal.addEventListener("abort", onAbort, { once: true });
            removeAbortListener = () => signal.removeEventListener("abort", onAbort);
          });
          handlerSettled = Promise.resolve().then(() => operation.handler(input, context));
          try {
            result = await Promise.race([handlerSettled, aborted]);
          } finally {
            removeAbortListener();
          }
        } finally {
          closeContext();
        }
        await pending;

        const safeResult = cloneAndDeepFreeze(result);
        assertOperationResultUnion(safeResult);
        const resultArtifacts = safeResult.artifacts ?? [];
        const resultActions = safeResult.actions ?? [];
        const activeBeforeResult = requireActiveRun(current);
        const preview: Run = safeResult.outcome === "partial"
          ? {
              ...activeBeforeResult,
              state: "partial",
              sequence: activeBeforeResult.sequence + resultArtifacts.length + resultActions.length + 1,
              updatedAt: activeBeforeResult.updatedAt,
              completedAt: activeBeforeResult.updatedAt,
              artifacts: [...activeBeforeResult.artifacts, ...resultArtifacts],
              actions: [...activeBeforeResult.actions, ...resultActions],
              problem: safeResult.problem,
              ...(safeResult.summary === undefined ? {} : { summary: safeResult.summary }),
              ...(safeResult.output === undefined ? {} : { output: safeResult.output }),
            }
          : {
              ...activeBeforeResult,
              state: "succeeded",
              sequence: activeBeforeResult.sequence + resultArtifacts.length + resultActions.length + 1,
              updatedAt: activeBeforeResult.updatedAt,
              completedAt: activeBeforeResult.updatedAt,
              artifacts: [...activeBeforeResult.artifacts, ...resultArtifacts],
              actions: [...activeBeforeResult.actions, ...resultActions],
              ...(safeResult.summary === undefined ? {} : { summary: safeResult.summary }),
              ...(safeResult.output === undefined ? {} : { output: safeResult.output }),
            };
        this.#assertCatalogRun(preview);
        assertSafeResultPayload(safeResult, guard);
        if (safeResult.output !== undefined) {
          assertCanonicalOutput(operation.definition.output.schema, safeResult.output);
        }
        for (const artifact of resultArtifacts) assertSafeArtifact(artifact, guard);
        for (const action of resultActions) {
          assertSafeAction(action, guard);
        }

        for (const artifact of resultArtifacts) persistArtifact(artifact);
        for (const action of resultActions) persistAction(action);
        await pending;

        if (safeResult.outcome === "partial") {
          const timestamp = monotonicTimestamp(this.#now(), current.updatedAt);
          const active = requireActiveRun(current);
          const terminal: Run = {
            ...active,
            state: "partial",
            sequence: active.sequence + 1,
            updatedAt: timestamp,
            completedAt: timestamp,
            problem: safeResult.problem,
            ...(safeResult.summary === undefined ? {} : { summary: safeResult.summary }),
            ...(safeResult.output === undefined ? {} : { output: safeResult.output }),
          };
          this.#assertCatalogRun(terminal);
          await this.#store.update(terminal, active.sequence);
        } else {
          const timestamp = monotonicTimestamp(this.#now(), current.updatedAt);
          const active = requireActiveRun(current);
          const terminal: Run = {
            ...active,
            state: "succeeded",
            sequence: active.sequence + 1,
            updatedAt: timestamp,
            completedAt: timestamp,
            ...(safeResult.summary === undefined ? {} : { summary: safeResult.summary }),
            ...(safeResult.output === undefined ? {} : { output: safeResult.output }),
          };
          this.#assertCatalogRun(terminal);
          await this.#store.update(terminal, active.sequence);
        }
      } catch {
        closeContext();
        const terminalizingAfterRecovery = Reflect.get(
          managedExecution,
          "terminalizing",
        ) as Promise<CancelRunResult> | undefined;
        if (terminalizingAfterRecovery !== undefined) {
          await terminalizingAfterRecovery.catch(() => undefined);
          await handlerSettled?.catch(() => undefined);
          return;
        }
        await pending.catch(() => undefined);
        const recovered = await this.#readStoreRun(await this.#store.get(queued.id), {
          id: queued.id,
          operationId: queued.operationId,
          operationRevision: queued.operationRevision,
        });
        if (recovered.kind !== "valid") return;
        const latest = recovered.run;
        if (latest.state !== "queued" && latest.state !== "running") return;
        const terminalizingAfterStoreRead = Reflect.get(
          managedExecution,
          "terminalizing",
        ) as Promise<CancelRunResult> | undefined;
        if (terminalizingAfterStoreRead !== undefined) {
          await terminalizingAfterStoreRead.catch(() => undefined);
          return;
        }
        const timestamp = monotonicTimestamp(this.#now(), latest.updatedAt);
        const failed: Run = {
          ...latest,
          state: "failed",
          sequence: latest.sequence + 1,
          updatedAt: timestamp,
          completedAt: timestamp,
          problem: handlerFailedProblem(),
        };
        this.#assertCatalogRun(failed);
        await this.#store.update(failed, latest.sequence);
      }
    } finally {
      managedExecution.cancelTimeout?.();
      invocationContextLease.clear();
      if (this.#executions.get(queued.id) === managedExecution) {
        this.#executions.delete(queued.id);
      }
    }
  }

  async #readStoreRun(
    value: Run | undefined,
    expected: RunProjectionExpectation,
  ): Promise<StoreRunRead> {
    const stored = ownCanonicalStoreRun(value, expected);
    if (stored.kind !== "valid") return stored;
    try {
      this.#assertCatalogRun(stored.run);

      const artifactsById = new Map<string, Artifact>();
      for (const artifact of stored.run.artifacts) {
        if (artifactsById.has(artifact.id)) return { kind: "invalid" };
        artifactsById.set(artifact.id, artifact);
      }
      for (const action of stored.run.actions) {
        await this.#assertActionIsValid(action, stored.run.artifacts);
      }
      return stored;
    } catch {
      return { kind: "invalid" };
    }
  }

  #assertCatalogRun(run: Run): void {
    assertCanonicalRun(run);
    const operation = this.#registry.get(run.operationId);
    if (operation === undefined
      || operation.definition.revision !== run.operationRevision) {
      throw new TypeError("Run references an unknown operation revision");
    }
    if (run.output !== undefined) {
      assertCanonicalOutput(operation.definition.output.schema, run.output);
    }
    if (!runSemanticsAreValid(run, {
      operationId: operation.definition.id,
      operationRevision: operation.definition.revision,
      operationIds: this.#registry.operations().map(({ definition }) => definition.id),
      outputIsValid: () => true,
    })) {
      throw new TypeError("Run violates catalog semantics");
    }
  }

  async #assertActionIsValid(
    action: FollowUpAction,
    artifacts: readonly Artifact[],
  ): Promise<void> {
    if (action.kind === "browser-launch") {
      const artifact = artifacts.find(({ id }) => id === action.artifactId);
      if (artifact?.kind !== "browser-launch") {
        throw new TypeError("Browser action references an invalid artifact");
      }
      return;
    }
    if (action.kind !== "invoke-operation") return;

    const target = this.#registry.get(action.operationId);
    if (target === undefined) throw new TypeError("Follow-up action references an unknown operation");
    const input = action.input ?? {};
    const validationErrors = cloneAndDeepFreeze(await this.#validateSchema({
      schema: target.definition.inputSchema,
      value: input,
      subject: "input",
    }));
    if (!Array.isArray(validationErrors) || validationErrors.length > 0) {
      throw new TypeError("Follow-up action input violates the target schema");
    }

    const rules = target.definition.inputHandling?.rules ?? [];
    const { guard, errors: secretRuleErrors } = createSecretGuard(
      target.definition.inputSchema,
      input,
      rules,
    );
    if (secretRuleErrors.length > 0) {
      throw new TypeError("Follow-up action contains an invalid secret rule");
    }
    for (const rule of rules) {
      if (rule.kind !== "secret") continue;
      const resolved = resolveRuleInputLocations(
        target.definition.inputSchema,
        input,
        rule.schemaPointer,
      );
      if (resolved.error !== undefined || resolved.locations.length > 0) {
        throw new TypeError("Follow-up action contains a secret input");
      }
    }
    if ((await this.#validateFiles(target, input, rules, guard)).length > 0) {
      throw new TypeError("Follow-up action contains an invalid file reference");
    }
  }
}
