import { isProtocolId } from "./identifiers.js";
import { assertRuntimeJsonData } from "./revision.js";
import type { EnvironmentDescriptor, EnvironmentKind } from "./types.js";

const KINDS = new Set<EnvironmentKind>([
  "development", "test", "qa", "staging", "uat", "preview", "sandbox",
]);
const PRODUCTION_TOKEN = /(^|[._:-])(prod|production|live)($|[._:-])/i;

function invalidEnvironment(): TypeError {
  return new TypeError("Invalid non-production environment descriptor");
}

export function assertNonProductionEnvironment(value: unknown): EnvironmentDescriptor {
  try {
    assertRuntimeJsonData(value);
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalidEnvironment();
    const keys = Object.keys(value);
    if (keys.length !== 2 || !Object.hasOwn(value, "name") || !Object.hasOwn(value, "kind")) {
      throw invalidEnvironment();
    }
    const record = value as Readonly<Record<string, unknown>>;
    if (!isProtocolId(record.name)
      || PRODUCTION_TOKEN.test(record.name)
      || typeof record.kind !== "string"
      || !KINDS.has(record.kind as EnvironmentKind)) {
      throw invalidEnvironment();
    }
    return Object.freeze({ name: record.name, kind: record.kind as EnvironmentKind });
  } catch {
    throw invalidEnvironment();
  }
}
