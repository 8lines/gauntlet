import { readFileSync } from "node:fs";
import { computeRevision } from "../../src/revision.js";
import type {
  AdapterManifest,
  DataSourceResolveRequest,
  DataSourceResolveResponse,
  JsonObject,
  OperationDefinition,
} from "../../src/types.js";

function fixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(new URL(`../../fixtures/v1/${name}`, import.meta.url), "utf8"),
  ) as T;
}

export const validManifest = fixture<AdapterManifest>("manifest.valid.json");
export const validOperation = fixture<OperationDefinition>("operation.valid.json");
export const validResolveRequest = fixture<DataSourceResolveRequest>(
  "data-source-resolve-request.valid.json",
);
export const validResolveResponse = fixture<DataSourceResolveResponse>(
  "data-source-resolve-response.valid.json",
);

export function operationWithSecretRules(
  inputSchema: JsonObject,
  schemaPointers: readonly string[],
  presetInputs: readonly JsonObject[],
): OperationDefinition {
  const operation = structuredClone(validOperation) as unknown as Record<string, unknown>;
  operation.inputSchema = inputSchema;
  operation.inputHandling = {
    rules: schemaPointers.map((schemaPointer) => ({
      kind: "secret",
      schemaPointer,
      retention: "none",
    })),
  };
  operation.dataSources = [];
  delete operation.uiSchema;
  operation.presets = presetInputs.map((input, index) => ({
    id: `preset-${index}`,
    label: `Preset ${index}`,
    input,
  }));
  operation.revision = computeRevision(operation as JsonObject);
  return operation as unknown as OperationDefinition;
}
