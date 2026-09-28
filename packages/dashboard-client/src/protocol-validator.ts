import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  assertRuntimeJsonData,
  manifestSemanticsAreValid,
  operationInputHandlingIsValid,
  operationSemanticsAreValid,
  runSemanticsAreValid,
  type AdapterHealth,
  type AdapterManifest,
  type CreateRunRequest,
  type DataSourcePage,
  type DataSourceQuery,
  type DataSourceResolveRequest,
  type DataSourceResolveResponse,
  type FileReference,
  type JsonObject,
  type OperationDefinition,
  type Problem,
  type Run,
  type RunEvent,
  type SessionLaunchResponse,
  type UploadResponse,
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
import runEventSchema from "@8lines/gauntlet-protocol/schemas/v1/run-event.schema.json" with { type: "json" };
import sessionLaunchSchema from "@8lines/gauntlet-protocol/schemas/v1/session-launch.schema.json" with { type: "json" };
import uploadSchema from "@8lines/gauntlet-protocol/schemas/v1/upload.schema.json" with { type: "json" };

function compile<T>(ajv: Ajv2020, schema: object): ValidateFunction<T> {
  return ajv.compile<T>(schema);
}

const applyFormats = addFormats as unknown as (instance: Ajv2020) => Ajv2020;
const ajv = new Ajv2020({ allErrors: true, strict: true });
applyFormats(ajv);
ajv.addSchema(commonSchema);
const fileReferenceSchema = {
  $ref: "https://schemas.8lines.dev/gauntlet/v1/common.schema.json#/$defs/fileReference",
};

export const protocolValidators = {
  health: compile<AdapterHealth>(ajv, healthSchema),
  manifest: compile<AdapterManifest>(ajv, manifestSchema),
  operation: compile<OperationDefinition>(ajv, operationDefinitionSchema),
  createRunRequest: compile<CreateRunRequest>(ajv, createRunRequestSchema),
  run: compile<Run>(ajv, runSchema),
  runEvent: compile<RunEvent>(ajv, runEventSchema),
  dataSourceQuery: compile<DataSourceQuery>(ajv, dataSourceQuerySchema),
  dataSourcePage: compile<DataSourcePage>(ajv, dataSourcePageSchema),
  dataSourceResolveRequest: compile<DataSourceResolveRequest>(ajv, dataSourceResolveRequestSchema),
  dataSourceResolveResponse: compile<DataSourceResolveResponse>(ajv, dataSourceResolveResponseSchema),
  sessionLaunch: compile<SessionLaunchResponse>(ajv, sessionLaunchSchema),
  upload: compile<UploadResponse>(ajv, uploadSchema),
  fileReference: compile<FileReference>(ajv, fileReferenceSchema),
  problem: compile<Problem>(ajv, problemSchema),
} as const;

export function operationActionInputIsValid(
  input: JsonObject | undefined,
  operation: OperationDefinition,
  now: Date = new Date(),
): boolean {
  try {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())
      || !validates(protocolValidators.operation, operation)
      || !operationSemanticsAreValid(operation)) return false;
    const ownedInput = input ?? {};
    const inputValidator = compile<JsonObject>(ajv, operation.inputSchema);
    if (!validates(inputValidator, ownedInput)) return false;
    return operationInputHandlingIsValid(operation, ownedInput, (candidate, rule) => {
      if (!validates(protocolValidators.fileReference, candidate)) return false;
      const expiry = Date.parse(candidate.expiresAt);
      return Number.isFinite(expiry)
        && expiry > now.getTime()
        && (rule.mediaTypes === undefined || rule.mediaTypes.includes(candidate.mediaType))
        && (rule.maxBytes === undefined || candidate.sizeBytes <= rule.maxBytes);
    });
  } catch {
    return false;
  }
}

export function validates<T>(validator: ValidateFunction<T>, value: unknown): value is T {
  try {
    assertRuntimeJsonData(value);
    return validator(value);
  } catch {
    return false;
  }
}

export function canonicalRunIsValid(value: unknown): value is Run {
  try {
    return validates(protocolValidators.run, value)
      && runSemanticsAreValid(value);
  } catch {
    return false;
  }
}

export function operationRunIsValid(
  run: Run,
  operation: OperationDefinition,
  manifest: AdapterManifest,
): boolean {
  try {
    if (!canonicalRunIsValid(run)
      || !validates(protocolValidators.operation, operation)
      || !validates(protocolValidators.manifest, manifest)
      || !operationSemanticsAreValid(operation)
      || !manifestSemanticsAreValid(manifest)) {
      return false;
    }
    const outputValidator = compile(ajv, operation.output.schema);
    return runSemanticsAreValid(run, {
      operationId: operation.id,
      operationRevision: operation.revision,
      operationIds: manifest.operations.map(({ id }) => id),
      outputIsValid: (output) => validates(outputValidator, output),
    });
  } catch {
    return false;
  }
}
