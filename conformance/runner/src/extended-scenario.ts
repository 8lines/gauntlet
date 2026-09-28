import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalizeForRevision,
  isProtocolId,
  type DataSourceQuery,
  type InvocationContext,
  type JsonObject,
  type JsonValue,
} from "@8lines/gauntlet-protocol";
import { assertEndpointDocument } from "./schema-validator.js";

const MAX_SCENARIO_BYTES = 4 * 1024 * 1024;
const FORMAT = "tc-adapter-v1-extended@1";
const REVISION_PLACEHOLDER = `sha256:${"0".repeat(64)}`;

interface InvocationCase {
  readonly operationId: string;
  readonly input: JsonObject;
  readonly context: InvocationContext;
  readonly idempotencyKey: string;
}

export interface AdapterV1ExtendedScenario {
  readonly format: typeof FORMAT;
  readonly secretSentinels: readonly string[];
  readonly handlerFailure: InvocationCase;
  readonly pagination: {
    readonly dataSourceId: string;
    readonly query: DataSourceQuery;
    readonly minimumDistinctItems: number;
    readonly maximumPages: number;
  };
  readonly customBinding: InvocationCase & {
    readonly expectedOutput: JsonValue;
    readonly expectedArtifactId: string;
  };
}

function invalidScenario(): TypeError {
  return new TypeError("Invalid adapter-v1 extended scenario");
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === required.length
    && required.every((key) => Object.hasOwn(value, key));
}

function invocationIsValid(value: unknown, extraKeys: readonly string[] = []): boolean {
  if (!record(value)
    || !exactKeys(value, ["operationId", "input", "context", "idempotencyKey", ...extraKeys])
    || !isProtocolId(value.operationId)
    || !record(value.input)
    || !record(value.context)
    || typeof value.idempotencyKey !== "string"
    || value.idempotencyKey.length === 0) {
    return false;
  }
  try {
    assertEndpointDocument("createRunRequest", {
      operationRevision: REVISION_PLACEHOLDER,
      input: value.input,
      context: value.context,
      idempotencyKey: value.idempotencyKey,
    });
    return true;
  } catch {
    return false;
  }
}

function containsString(root: unknown, expected: string): boolean {
  const pending = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string" && value.includes(expected)) return true;
    if (Array.isArray(value)) pending.push(...value);
    else if (record(value)) pending.push(...Object.values(value));
  }
  return false;
}

export function validateAdapterV1ExtendedScenario(value: unknown): AdapterV1ExtendedScenario {
  try {
    canonicalizeForRevision(value as Parameters<typeof canonicalizeForRevision>[0]);
  } catch {
    throw invalidScenario();
  }
  if (!record(value)
    || !exactKeys(value, ["format", "secretSentinels", "handlerFailure", "pagination", "customBinding"])
    || value.format !== FORMAT
    || !Array.isArray(value.secretSentinels)
    || value.secretSentinels.length === 0
    || !value.secretSentinels.every((sentinel) => typeof sentinel === "string" && sentinel.length > 0)
    || new Set(value.secretSentinels).size !== value.secretSentinels.length
    || !invocationIsValid(value.handlerFailure)
    || !invocationIsValid(value.customBinding, ["expectedOutput", "expectedArtifactId"])
    || !record(value.pagination)
    || !exactKeys(value.pagination, ["dataSourceId", "query", "minimumDistinctItems", "maximumPages"])
    || !isProtocolId(value.pagination.dataSourceId)
    || !Number.isSafeInteger(value.pagination.minimumDistinctItems)
    || (value.pagination.minimumDistinctItems as number) < 2
    || !Number.isSafeInteger(value.pagination.maximumPages)
    || (value.pagination.maximumPages as number) < (value.pagination.minimumDistinctItems as number)
    || (value.pagination.maximumPages as number) > 64) {
    throw invalidScenario();
  }

  const customBinding = value.customBinding as Record<string, unknown>;
  const handlerFailure = value.handlerFailure as Record<string, unknown>;
  if (handlerFailure.operationId === customBinding.operationId
    || !isProtocolId(customBinding.expectedArtifactId)
    || !record(value.pagination.query)
    || !record(value.pagination.query.dependencies)
    || !record(value.pagination.query.context)
    || Object.hasOwn(value.pagination.query, "cursor")
    || value.pagination.query.limit !== 1) {
    throw invalidScenario();
  }
  try {
    assertEndpointDocument("dataSourceQuery", value.pagination.query);
  } catch {
    throw invalidScenario();
  }
  if (!(value.secretSentinels as readonly string[]).every((sentinel) =>
    containsString(handlerFailure.input, sentinel)
    || containsString(customBinding.input, sentinel))) {
    throw invalidScenario();
  }

  return value as unknown as AdapterV1ExtendedScenario;
}

function localPath(path: string | URL): string {
  if (typeof path === "string") return resolve(process.cwd(), path);
  if (path.protocol !== "file:") throw invalidScenario();
  return fileURLToPath(path);
}

async function readBounded(path: string): Promise<Uint8Array> {
  let metadata;
  try {
    metadata = await stat(path);
  } catch {
    throw invalidScenario();
  }
  if (!metadata.isFile() || metadata.size > MAX_SCENARIO_BYTES) throw invalidScenario();

  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of createReadStream(path)) {
      const bytes = chunk as Buffer;
      size += bytes.byteLength;
      if (size > MAX_SCENARIO_BYTES) throw invalidScenario();
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof TypeError && error.message === "Invalid adapter-v1 extended scenario") throw error;
    throw invalidScenario();
  }
  return Buffer.concat(chunks, size);
}

export async function loadAdapterV1ExtendedScenario(
  path: string | URL,
): Promise<AdapterV1ExtendedScenario> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(await readBounded(localPath(path)));
  } catch (error) {
    if (error instanceof TypeError && error.message === "Invalid adapter-v1 extended scenario") throw error;
    throw invalidScenario();
  }
  try {
    return validateAdapterV1ExtendedScenario(JSON.parse(text) as unknown);
  } catch {
    throw invalidScenario();
  }
}
