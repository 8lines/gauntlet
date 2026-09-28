import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalizeForRevision,
  isProtocolId,
  type CapabilityId,
  type DataSourceQuery,
  type DataSourceResolveRequest,
  type JsonObject,
  type ProfileId,
  type RunState,
} from "@8lines/gauntlet-protocol";

const MAX_SCENARIO_BYTES = 4 * 1024 * 1024;
const JSON_POINTER = /^(?:\/(?:[^~/]|~[01])*)*$/;
const REQUIREMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*@[1-9][0-9]*$/;
const TERMINAL_STATES = new Set<RunState>([
  "succeeded",
  "failed",
  "partial",
  "cancelled",
  "timed_out",
  "expired",
]);

const TOP_LEVEL_KEYS = [
  "operationId",
  "dataSourceId",
  "input",
  "invalidInput",
  "expectedValidationPointer",
  "dataSourceQuery",
  "dataSourceResolveRequest",
  "idempotencyKey",
  "expectedTerminalState",
  "requiredProfiles",
  "requiredCapabilities",
] as const;

export interface AdapterV1Scenario {
  readonly operationId: string;
  readonly dataSourceId: string;
  readonly input: JsonObject;
  readonly invalidInput: JsonObject;
  readonly expectedValidationPointer: string;
  readonly dataSourceQuery: DataSourceQuery;
  readonly dataSourceResolveRequest: DataSourceResolveRequest;
  readonly idempotencyKey: string;
  readonly expectedTerminalState: Exclude<RunState, "queued" | "running">;
  readonly requiredProfiles: readonly ProfileId[];
  readonly requiredCapabilities: readonly CapabilityId[];
  readonly browserLaunch?: {
    readonly artifactId: string;
    readonly expectedPublicOrigin: string;
  };
}

function invalidScenario(): TypeError {
  return new TypeError("Invalid adapter-v1 scenario");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactly(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => required.includes(key) || optional.includes(key))
    && keys.length === required.length + keys.filter((key) => optional.includes(key)).length;
}

function hasUniqueStrings(value: unknown, pattern: RegExp): value is readonly string[] {
  return Array.isArray(value)
    && value.every((item) => typeof item === "string" && pattern.test(item))
    && new Set(value).size === value.length;
}

function validJsonObject(value: unknown): value is JsonObject {
  return isObject(value);
}

function validPointerMap(value: unknown): boolean {
  return isObject(value)
    && Object.keys(value).length > 0
    && Object.keys(value).every((key) => JSON_POINTER.test(key) && key.startsWith("/"));
}

function validTarget(value: unknown): boolean {
  return isObject(value)
    && hasExactly(value, ["id"], ["environment"])
    && isProtocolId(value.id)
    && (value.environment === undefined || typeof value.environment === "string");
}

function validContext(value: unknown): boolean {
  if (!isObject(value)
    || !hasExactly(value, ["requestId", "target"], ["locale", "timeZone", "actor", "extensions"])
    || !isProtocolId(value.requestId)
    || !validTarget(value.target)) {
    return false;
  }
  if (value.locale !== undefined && typeof value.locale !== "string") return false;
  if (value.timeZone !== undefined && typeof value.timeZone !== "string") return false;
  if (value.actor !== undefined) {
    if (!isObject(value.actor)
      || !hasExactly(value.actor, ["id"], ["displayName"])
      || !isProtocolId(value.actor.id)
      || (value.actor.displayName !== undefined && typeof value.actor.displayName !== "string")) {
      return false;
    }
  }
  return value.extensions === undefined || isObject(value.extensions);
}

function validQuery(value: unknown): value is DataSourceQuery {
  if (!isObject(value)
    || !hasExactly(value, [], ["search", "cursor", "limit", "dependencies", "context", "extensions"])
    || !validPointerMap(value.dependencies)
    || !validContext(value.context)) {
    return false;
  }
  if (value.search !== undefined && typeof value.search !== "string") return false;
  if (value.cursor !== undefined && typeof value.cursor !== "string") return false;
  if (value.limit !== undefined && (!Number.isSafeInteger(value.limit) || (value.limit as number) <= 0)) return false;
  return value.extensions === undefined || isObject(value.extensions);
}

function validResolveRequest(value: unknown): value is DataSourceResolveRequest {
  return isObject(value)
    && hasExactly(value, ["values"], ["dependencies", "context", "extensions"])
    && Array.isArray(value.values)
    && value.values.every((item) => typeof item === "string")
    && validPointerMap(value.dependencies)
    && validContext(value.context)
    && (value.extensions === undefined || isObject(value.extensions));
}

function validOrigin(value: unknown): boolean {
  if (typeof value !== "string" || value.trim() !== value) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:")
      && url.username === ""
      && url.password === ""
      && url.pathname === "/"
      && url.search === ""
      && url.hash === ""
      && url.origin === value;
  } catch {
    return false;
  }
}

function pointerSegments(pointer: string): readonly string[] {
  if (pointer === "") return [];
  return pointer.slice(1).split("/").map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function withoutPointer(value: JsonObject, pointer: string): JsonObject | undefined {
  const copy = structuredClone(value) as Record<string, unknown>;
  const segments = pointerSegments(pointer);
  if (segments.length === 0) return undefined;
  let parent: unknown = copy;
  for (const segment of segments.slice(0, -1)) {
    if (!isObject(parent) || !Object.hasOwn(parent, segment)) return undefined;
    parent = parent[segment];
  }
  const finalSegment = segments.at(-1)!;
  if (!isObject(parent) || !Object.hasOwn(parent, finalSegment)) return undefined;
  delete parent[finalSegment];
  return copy as JsonObject;
}

function inputsDifferOnlyAtExpectedPointer(
  input: JsonObject,
  invalidInput: JsonObject,
  pointer: string,
): boolean {
  const validRest = withoutPointer(input, pointer);
  const invalidRest = withoutPointer(invalidInput, pointer);
  if (validRest === undefined || invalidRest === undefined) return false;
  return canonicalizeForRevision(validRest) === canonicalizeForRevision(invalidRest)
    && canonicalizeForRevision(input) !== canonicalizeForRevision(invalidInput);
}

export function validateAdapterV1Scenario(value: unknown): AdapterV1Scenario {
  try {
    canonicalizeForRevision(value as Parameters<typeof canonicalizeForRevision>[0]);
  } catch {
    throw invalidScenario();
  }

  if (!isObject(value)
    || !hasExactly(value, TOP_LEVEL_KEYS, ["browserLaunch"])
    || !isProtocolId(value.operationId)
    || !isProtocolId(value.dataSourceId)
    || !validJsonObject(value.input)
    || !validJsonObject(value.invalidInput)
    || typeof value.expectedValidationPointer !== "string"
    || !JSON_POINTER.test(value.expectedValidationPointer)
    || !validQuery(value.dataSourceQuery)
    || !validResolveRequest(value.dataSourceResolveRequest)
    || typeof value.idempotencyKey !== "string"
    || value.idempotencyKey.length === 0
    || typeof value.expectedTerminalState !== "string"
    || !TERMINAL_STATES.has(value.expectedTerminalState as RunState)
    || !hasUniqueStrings(value.requiredProfiles, REQUIREMENT_ID)
    || !hasUniqueStrings(value.requiredCapabilities, REQUIREMENT_ID)) {
    throw invalidScenario();
  }

  if (!inputsDifferOnlyAtExpectedPointer(value.input, value.invalidInput, value.expectedValidationPointer)) {
    throw invalidScenario();
  }

  if (value.browserLaunch !== undefined
    && (!isObject(value.browserLaunch)
      || !hasExactly(value.browserLaunch, ["artifactId", "expectedPublicOrigin"])
      || !isProtocolId(value.browserLaunch.artifactId)
      || !validOrigin(value.browserLaunch.expectedPublicOrigin))) {
    throw invalidScenario();
  }

  return value as unknown as AdapterV1Scenario;
}

function scenarioPath(path: string | URL): string {
  if (typeof path === "string") return resolve(process.cwd(), path);
  if (path.protocol !== "file:") throw invalidScenario();
  return fileURLToPath(path);
}

async function readBoundedScenario(path: string): Promise<Uint8Array> {
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
    if (error instanceof TypeError && error.message === "Invalid adapter-v1 scenario") throw error;
    throw invalidScenario();
  }
  return Buffer.concat(chunks, size);
}

export async function loadAdapterV1Scenario(path: string | URL): Promise<AdapterV1Scenario> {
  const bytes = await readBoundedScenario(scenarioPath(path));
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalidScenario();
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw invalidScenario();
  }
  return validateAdapterV1Scenario(value);
}
