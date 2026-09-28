import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  assertTcSchemaCore,
  canonicalizeForRevision,
  manifestSemanticsAreValid,
  operationSemanticsAreValid,
  resolveSemanticsAreValid,
  type AdapterManifest,
  type DataSourceResolveRequest,
  type JsonObject,
  type OperationDefinition,
} from "@8lines/gauntlet-protocol";
import commonSchema from "@8lines/gauntlet-protocol/schemas/v1/common.schema.json" with { type: "json" };
import createRunRequestSchema from "@8lines/gauntlet-protocol/schemas/v1/create-run-request.schema.json" with { type: "json" };
import dataSourcePageSchema from "@8lines/gauntlet-protocol/schemas/v1/data-source-page.schema.json" with { type: "json" };
import dataSourceQuerySchema from "@8lines/gauntlet-protocol/schemas/v1/data-source-query.schema.json" with { type: "json" };
import dataSourceResolveRequestSchema from "@8lines/gauntlet-protocol/schemas/v1/data-source-resolve-request.schema.json" with { type: "json" };
import dataSourceResolveResponseSchema from "@8lines/gauntlet-protocol/schemas/v1/data-source-resolve-response.schema.json" with { type: "json" };
import healthSchema from "@8lines/gauntlet-protocol/schemas/v1/health.schema.json" with { type: "json" };
import manifestSchema from "@8lines/gauntlet-protocol/schemas/v1/manifest.schema.json" with { type: "json" };
import operationDefinitionSchema from "@8lines/gauntlet-protocol/schemas/v1/operation-definition.schema.json" with { type: "json" };
import problemSchema from "@8lines/gauntlet-protocol/schemas/v1/problem.schema.json" with { type: "json" };
import runSchema from "@8lines/gauntlet-protocol/schemas/v1/run.schema.json" with { type: "json" };
import sessionLaunchSchema from "@8lines/gauntlet-protocol/schemas/v1/session-launch.schema.json" with { type: "json" };

export type EndpointDocument =
  | "health"
  | "manifest"
  | "operation"
  | "createRunRequest"
  | "run"
  | "dataSourceQuery"
  | "dataSourcePage"
  | "dataSourceResolveRequest"
  | "dataSourceResolveResponse"
  | "sessionLaunch"
  | "problem";

type SchemaAsset = Readonly<Record<string, unknown>> & { readonly $id: string };

const applyFormats = addFormats as unknown as (instance: Ajv2020) => Ajv2020;
const ajv = new Ajv2020({ allErrors: true, strict: true });
applyFormats(ajv);
ajv.addSchema(commonSchema);

function compile(schema: SchemaAsset): ValidateFunction {
  return ajv.compile(schema);
}

const assets: Readonly<Record<EndpointDocument, SchemaAsset>> = {
  health: healthSchema,
  manifest: manifestSchema,
  operation: operationDefinitionSchema,
  createRunRequest: createRunRequestSchema,
  run: runSchema,
  dataSourceQuery: dataSourceQuerySchema,
  dataSourcePage: dataSourcePageSchema,
  dataSourceResolveRequest: dataSourceResolveRequestSchema,
  dataSourceResolveResponse: dataSourceResolveResponseSchema,
  sessionLaunch: sessionLaunchSchema,
  problem: problemSchema,
};

const validators: Readonly<Record<EndpointDocument, ValidateFunction>> = {
  health: compile(healthSchema),
  manifest: compile(manifestSchema),
  operation: compile(operationDefinitionSchema),
  createRunRequest: compile(createRunRequestSchema),
  run: compile(runSchema),
  dataSourceQuery: compile(dataSourceQuerySchema),
  dataSourcePage: compile(dataSourcePageSchema),
  dataSourceResolveRequest: compile(dataSourceResolveRequestSchema),
  dataSourceResolveResponse: compile(dataSourceResolveResponseSchema),
  sessionLaunch: compile(sessionLaunchSchema),
  problem: compile(problemSchema),
};

function escapePointer(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function normalizedPointer(error: ErrorObject): string {
  if (error.keyword === "required") {
    const missing = (error.params as { readonly missingProperty?: unknown }).missingProperty;
    if (typeof missing === "string") return `${error.instancePath}/${escapePointer(missing)}`;
  }
  return error.instancePath;
}

function selectedError(errors: readonly ErrorObject[] | null | undefined): ErrorObject | undefined {
  return [...(errors ?? [])].sort((left, right) => {
    const leftPointer = normalizedPointer(left);
    const rightPointer = normalizedPointer(right);
    const leftSummary = (left.keyword === "oneOf" || left.keyword === "anyOf") ? 1 : 0;
    const rightSummary = (right.keyword === "oneOf" || right.keyword === "anyOf") ? 1 : 0;
    return leftSummary - rightSummary
      || Number(leftPointer === "") - Number(rightPointer === "")
      || leftPointer.localeCompare(rightPointer)
      || left.keyword.localeCompare(right.keyword)
      || left.schemaPath.localeCompare(right.schemaPath);
  })[0];
}

export class SchemaValidationError extends Error {
  readonly schemaId: string;
  readonly instancePath: string;

  constructor(schemaId: string, instancePath: string) {
    const pointer = instancePath === "" ? "/" : instancePath;
    super(`Schema ${schemaId} rejected ${pointer}`);
    this.name = "SchemaValidationError";
    this.schemaId = schemaId;
    this.instancePath = pointer;
  }
}

export function assertCanonicalJson(value: unknown, message = "Response is not canonical JSON"): void {
  try {
    canonicalizeForRevision(value as Parameters<typeof canonicalizeForRevision>[0]);
  } catch {
    throw new TypeError(message);
  }
}

export function assertEndpointDocument<T = unknown>(endpoint: EndpointDocument, value: unknown): T {
  assertCanonicalJson(value);
  const validator = validators[endpoint];
  if (!validator(value)) {
    if (endpoint === "run"
      && value !== null
      && typeof value === "object"
      && !Array.isArray(value)
      && ["failed", "partial", "cancelled", "timed_out", "expired"].includes(
        String((value as Record<string, unknown>).state),
      )
      && !Object.hasOwn(value, "problem")) {
      throw new SchemaValidationError(assets.run.$id, "/problem");
    }
    const error = selectedError(validator.errors);
    throw new SchemaValidationError(assets[endpoint].$id, error === undefined ? "/" : normalizedPointer(error));
  }
  return value as T;
}

export function validateManifest(value: unknown): AdapterManifest {
  const manifest = assertEndpointDocument<AdapterManifest>("manifest", value);
  if (!manifestSemanticsAreValid(manifest)) throw new TypeError("Manifest semantics are invalid");
  return manifest;
}

export function validateOperation(value: unknown): OperationDefinition {
  const operation = assertEndpointDocument<OperationDefinition>("operation", value);
  if (!operationSemanticsAreValid(operation)) throw new TypeError("Operation semantics are invalid");
  return operation;
}

export function validateResolve(
  requestValue: unknown,
  responseValue: unknown,
): Parameters<typeof resolveSemanticsAreValid>[1] {
  const request = assertEndpointDocument<DataSourceResolveRequest>("dataSourceResolveRequest", requestValue);
  const response = assertEndpointDocument<Parameters<typeof resolveSemanticsAreValid>[1]>(
    "dataSourceResolveResponse",
    responseValue,
  );
  if (!resolveSemanticsAreValid(request, response)) throw new TypeError("Resolve semantics are invalid");
  return response;
}

export type DeclaredSchemaKind = "dependency" | "context" | "input" | "output";

export function compileDeclaredSchema(
  schema: JsonObject,
  kind: DeclaredSchemaKind,
): (value: unknown) => void {
  assertCanonicalJson(schema, "Declared schema document is not canonical JSON");
  try {
    assertTcSchemaCore(schema, { requireObjectRoot: kind !== "output" });
  } catch {
    throw new TypeError(`Declared ${kind} schema is invalid`);
  }

  let validator: ValidateFunction;
  try {
    validator = ajv.compile(schema);
  } catch {
    throw new TypeError(`Declared ${kind} schema is invalid`);
  }
  return (value: unknown): void => {
    assertCanonicalJson(value, "Declared schema candidate is not canonical JSON");
    if (!validator(value)) {
      const error = selectedError(validator.errors);
      const pointer = error === undefined ? "/" : (normalizedPointer(error) || "/");
      throw new TypeError(`Declared ${kind} schema rejected ${pointer}`);
    }
  };
}
