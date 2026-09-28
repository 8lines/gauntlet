import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
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
import runEventSchema from "@8lines/gauntlet-protocol/schemas/v1/run-event.schema.json" with { type: "json" };
import sessionLaunchSchema from "@8lines/gauntlet-protocol/schemas/v1/session-launch.schema.json" with { type: "json" };
import uploadSchema from "@8lines/gauntlet-protocol/schemas/v1/upload.schema.json" with { type: "json" };
import type {
  AdapterHealth,
  AdapterManifest,
  CreateRunRequest,
  DataSourcePage,
  DataSourceQuery,
  DataSourceResolveRequest,
  DataSourceResolveResponse,
  FileReference,
  JsonSchema,
  JsonValue,
  OperationDefinition,
  Problem,
  Run,
  RunEvent,
  SessionLaunchResponse,
  UploadResponse,
  ValidationError,
} from "@8lines/gauntlet-protocol";
import {
  manifestSemanticsAreValid,
  operationSemanticsAreValid,
} from "@8lines/gauntlet-protocol";
import { assertCanonicalJsonValue, cloneAndDeepFreeze } from "./operation-internals.js";

const applyFormats = addFormats as unknown as (ajv: Ajv2020) => Ajv2020;

const protocolAjv = new Ajv2020({ allErrors: true, strict: true });
applyFormats(protocolAjv);
protocolAjv.addSchema(commonSchema);
protocolAjv.addSchema(createRunRequestSchema);
protocolAjv.addSchema(dataSourcePageSchema);
protocolAjv.addSchema(dataSourceQuerySchema);
protocolAjv.addSchema(dataSourceResolveRequestSchema);
protocolAjv.addSchema(dataSourceResolveResponseSchema);
protocolAjv.addSchema(healthSchema);
protocolAjv.addSchema(manifestSchema);
protocolAjv.addSchema(operationDefinitionSchema);
protocolAjv.addSchema(problemSchema);
protocolAjv.addSchema(runSchema);
protocolAjv.addSchema(runEventSchema);
protocolAjv.addSchema(sessionLaunchSchema);
protocolAjv.addSchema(uploadSchema);
const validateCreateRunRequest = protocolAjv.getSchema(
  "https://schemas.8lines.dev/gauntlet/v1/create-run-request.schema.json",
)!;
const validateAdapterHealth = protocolAjv.getSchema(
  "https://schemas.8lines.dev/gauntlet/v1/health.schema.json",
)!;
const validateAdapterManifest = protocolAjv.getSchema(
  "https://schemas.8lines.dev/gauntlet/v1/manifest.schema.json",
)!;
const validateOperationDefinition = protocolAjv.getSchema(
  "https://schemas.8lines.dev/gauntlet/v1/operation-definition.schema.json",
)!;
const validateProblem = protocolAjv.getSchema(
  "https://schemas.8lines.dev/gauntlet/v1/problem.schema.json",
)!;
const validateRun = protocolAjv.getSchema(
  "https://schemas.8lines.dev/gauntlet/v1/run.schema.json",
)!;
const validateDataSourceQuery = protocolAjv.getSchema(
  "https://schemas.8lines.dev/gauntlet/v1/data-source-query.schema.json",
)!;
const validateDataSourceResolveRequest = protocolAjv.getSchema(
  "https://schemas.8lines.dev/gauntlet/v1/data-source-resolve-request.schema.json",
)!;
const validateDataSourcePage = protocolAjv.getSchema(
  "https://schemas.8lines.dev/gauntlet/v1/data-source-page.schema.json",
)!;
const validateDataSourceResolveResponse = protocolAjv.getSchema(
  "https://schemas.8lines.dev/gauntlet/v1/data-source-resolve-response.schema.json",
)!;
const validateRunEvent = protocolAjv.getSchema(
  "https://schemas.8lines.dev/gauntlet/v1/run-event.schema.json",
)!;
const validateUploadResponse = protocolAjv.getSchema(
  "https://schemas.8lines.dev/gauntlet/v1/upload.schema.json",
)!;
const validateSessionLaunchResponse = protocolAjv.getSchema(
  "https://schemas.8lines.dev/gauntlet/v1/session-launch.schema.json",
)!;
const validateFileReference = protocolAjv.getSchema(
  "https://schemas.8lines.dev/gauntlet/v1/common.schema.json#/$defs/fileReference",
)!;

const outputAjv = new Ajv2020({ allErrors: true, strict: true });
applyFormats(outputAjv);
const outputValidators = new WeakMap<object, ValidateFunction>();

export class InvalidProducedValueError extends TypeError {
  constructor() {
    super("Operation produced a noncanonical value");
    this.name = "InvalidProducedValueError";
  }
}

function normalizedErrors(validate: ValidateFunction): readonly ValidationError[] {
  return cloneAndDeepFreeze((validate.errors ?? []).map((error) => ({
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    keyword: error.keyword,
    message: "value does not satisfy schema",
    params: {},
  })));
}

function validateRequest<T>(
  value: unknown,
  validate: ValidateFunction,
): { readonly value?: T; readonly errors: readonly ValidationError[] } {
  const owned = cloneAndDeepFreeze(value);
  if (validate(owned)) return { value: owned as T, errors: Object.freeze([]) };
  return { errors: normalizedErrors(validate) };
}

function ownProduced<T>(value: T, validate: ValidateFunction): T {
  const owned = cloneAndDeepFreeze(value);
  if (!validate(owned)) throw new InvalidProducedValueError();
  return owned;
}

export function validateCanonicalCreateRunRequest(
  value: unknown,
): { readonly request?: CreateRunRequest; readonly errors: readonly ValidationError[] } {
  if (validateCreateRunRequest(value)) {
    return { request: value as CreateRunRequest, errors: [] };
  }
  return {
    errors: [{
      instancePath: "",
      schemaPath: "#",
      keyword: "validation",
      message: "request does not satisfy schema",
      params: {},
    }],
  };
}

export function assertCanonicalRun(run: Run): void {
  assertCanonicalJsonValue(run);
  if (!validateRun(run)) throw new InvalidProducedValueError();
}

export function validateCanonicalDataSourceQuery(
  value: unknown,
): { readonly value?: DataSourceQuery; readonly errors: readonly ValidationError[] } {
  return validateRequest<DataSourceQuery>(value, validateDataSourceQuery);
}

export function validateCanonicalDataSourceResolveRequest(
  value: unknown,
): { readonly value?: DataSourceResolveRequest; readonly errors: readonly ValidationError[] } {
  return validateRequest<DataSourceResolveRequest>(value, validateDataSourceResolveRequest);
}

export function ownCanonicalDataSourcePage(value: DataSourcePage): DataSourcePage {
  return ownProduced(value, validateDataSourcePage);
}

export function ownCanonicalAdapterHealth(value: AdapterHealth): AdapterHealth {
  return ownProduced(value, validateAdapterHealth);
}

export function ownCanonicalAdapterManifest(value: AdapterManifest): AdapterManifest {
  const manifest = ownProduced(value, validateAdapterManifest);
  if (!manifestSemanticsAreValid(manifest)) throw new InvalidProducedValueError();
  return manifest;
}

export function ownCanonicalOperationDefinition(value: OperationDefinition): OperationDefinition {
  const operation = ownProduced(value, validateOperationDefinition);
  if (!operationSemanticsAreValid(operation)) throw new InvalidProducedValueError();
  return operation;
}

export function ownCanonicalProblem(value: Problem): Problem {
  return ownProduced(value, validateProblem);
}

export function ownCanonicalDataSourceResolveResponse(
  value: DataSourceResolveResponse,
): DataSourceResolveResponse {
  return ownProduced(value, validateDataSourceResolveResponse);
}

export function ownCanonicalRun(value: Run): Run {
  return ownProduced(value, validateRun);
}

export function ownCanonicalRunEvent(value: RunEvent): RunEvent {
  return ownProduced(value, validateRunEvent);
}

export function ownCanonicalUploadResponse(value: UploadResponse): UploadResponse {
  return ownProduced(value, validateUploadResponse);
}

export function ownCanonicalSessionLaunchResponse(
  value: SessionLaunchResponse,
): SessionLaunchResponse {
  return ownProduced(value, validateSessionLaunchResponse);
}

export function isCanonicalFileReference(value: unknown): value is FileReference {
  try {
    assertCanonicalJsonValue(value);
    return validateFileReference(value) === true;
  } catch {
    return false;
  }
}

export function assertCanonicalOutput(schema: JsonSchema, output: JsonValue): void {
  assertCanonicalJsonValue(output);
  let validate = outputValidators.get(schema);
  if (validate === undefined) {
    validate = outputAjv.compile(schema);
    outputValidators.set(schema, validate);
  }
  if (!validate(output)) throw new InvalidProducedValueError();
}
