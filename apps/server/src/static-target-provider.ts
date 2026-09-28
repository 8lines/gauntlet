import {
  assertNonProductionEnvironment,
  assertRuntimeJsonData,
  isProtocolId,
  type EnvironmentDescriptor,
  type ProtocolId,
} from "@8lines/gauntlet-protocol";
import type { TargetProvider } from "./target-provider.js";

const TARGET_KEYS = new Set([
  "id", "label", "adapterUrl", "publicUrl", "expectedEnvironment", "tags", "widget",
]);

export interface StaticTargetWidgetConfig {
  readonly origins: readonly string[];
}

export interface StaticTargetConfig {
  readonly id: ProtocolId;
  readonly label: string;
  readonly adapterUrl: string;
  readonly publicUrl?: string;
  readonly expectedEnvironment: EnvironmentDescriptor;
  readonly tags?: readonly string[];
  readonly widget?: StaticTargetWidgetConfig;
}

function invalidStaticTarget(): TypeError {
  return new TypeError("Invalid static target configuration");
}

function assertRuntimeString(value: string): void {
  try {
    assertRuntimeJsonData(value);
  } catch {
    throw invalidStaticTarget();
  }
}

function ownDataRecord(value: unknown): Readonly<Record<string, unknown>> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw invalidStaticTarget();
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw invalidStaticTarget();
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) {
      throw invalidStaticTarget();
    }
    const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw invalidStaticTarget();
      }
      record[key] = descriptor.value;
    }
    return record;
  } catch {
    throw invalidStaticTarget();
  }
}

function ownArray(value: unknown): readonly unknown[] {
  try {
    if (!Array.isArray(value)) {
      throw invalidStaticTarget();
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (lengthDescriptor === undefined
      || !("value" in lengthDescriptor)
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0) {
      throw invalidStaticTarget();
    }
    const length = lengthDescriptor.value as number;
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw invalidStaticTarget();
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw invalidStaticTarget();
      }
      result.push(descriptor.value);
    }
    const extraKeys = Reflect.ownKeys(value).filter((key) =>
      key !== "length" && !(typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < length));
    if (extraKeys.length > 0) {
      throw invalidStaticTarget();
    }
    return result;
  } catch {
    throw invalidStaticTarget();
  }
}

function origin(value: unknown): string {
  if (typeof value !== "string") {
    throw invalidStaticTarget();
  }
  assertRuntimeString(value);
  if (/[\u0000-\u0020\u007f]/.test(value)
    || /[\\?#@]/.test(value)) {
    throw invalidStaticTarget();
  }
  const scheme = /^https?:\/\//i.exec(value);
  if (scheme === null) {
    throw invalidStaticTarget();
  }
  const remainder = value.slice(scheme[0].length);
  const pathIndex = remainder.indexOf("/");
  const authority = pathIndex === -1 ? remainder : remainder.slice(0, pathIndex);
  const rawPath = pathIndex === -1 ? "" : remainder.slice(pathIndex);
  if (authority.length === 0 || (rawPath !== "" && rawPath !== "/")) {
    throw invalidStaticTarget();
  }
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
      || parsed.username !== ""
      || parsed.password !== ""
      || parsed.pathname !== "/"
      || parsed.search !== ""
      || parsed.hash !== "") {
      throw invalidStaticTarget();
    }
    return parsed.origin;
  } catch {
    throw invalidStaticTarget();
  }
}

const CANONICAL_HOSTNAME = /^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])$/;

/**
 * Exact `scheme://host[:port]` as produced by `URL.origin`; the MCP origin rule.
 * WHATWG hosts otherwise permit characters such as `;`, `,`, `'`, and `_`
 * that would land verbatim in a `Content-Security-Policy` header, so the
 * hostname is also constrained to the characters a canonical HTTP(S) host
 * can contain. That constraint also excludes `*`, so a wildcard pattern is
 * never mistaken for one concrete origin.
 */
export function isCanonicalWebOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:")
      && url.origin === value
      && CANONICAL_HOSTNAME.test(url.hostname);
  } catch {
    return false;
  }
}

function targetWidget(value: unknown): StaticTargetWidgetConfig {
  const record = ownDataRecord(value);
  if (Object.keys(record).length !== 1 || !Object.hasOwn(record, "origins")) {
    throw invalidStaticTarget();
  }
  const origins = ownArray(record.origins);
  if (origins.length === 0) throw invalidStaticTarget();
  const unique = new Set<string>();
  for (const candidate of origins) {
    if (!isCanonicalWebOrigin(candidate) || unique.has(candidate)) throw invalidStaticTarget();
    assertRuntimeString(candidate);
    unique.add(candidate);
  }
  return Object.freeze({ origins: Object.freeze([...unique]) });
}

function nonEmptyString(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidStaticTarget();
  }
  assertRuntimeString(value);
  return value;
}

function nonProductionEnvironment(value: unknown): EnvironmentDescriptor {
  try {
    return assertNonProductionEnvironment(value);
  } catch {
    throw invalidStaticTarget();
  }
}

function ownTags(value: unknown): readonly string[] {
  const tags = ownArray(value);
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    const owned = nonEmptyString(tag);
    if (!seen.has(owned)) {
      seen.add(owned);
      unique.push(owned);
    }
  }
  return Object.freeze(unique);
}

function validateTarget(value: unknown): StaticTargetConfig {
  const record = ownDataRecord(value);
  if (Object.keys(record).some((key) => !TARGET_KEYS.has(key))
    || !Object.hasOwn(record, "id")
    || !Object.hasOwn(record, "label")
    || !Object.hasOwn(record, "adapterUrl")
    || !Object.hasOwn(record, "expectedEnvironment")) {
    throw invalidStaticTarget();
  }
  if (!isProtocolId(record.id)) {
    throw invalidStaticTarget();
  }

  const tags = Object.hasOwn(record, "tags") ? ownTags(record.tags) : undefined;
  const publicUrl = Object.hasOwn(record, "publicUrl") ? origin(record.publicUrl) : undefined;
  const widget = Object.hasOwn(record, "widget") ? targetWidget(record.widget) : undefined;
  return Object.freeze({
    id: record.id,
    label: nonEmptyString(record.label),
    adapterUrl: origin(record.adapterUrl),
    ...(publicUrl === undefined ? {} : { publicUrl }),
    expectedEnvironment: nonProductionEnvironment(record.expectedEnvironment),
    ...(tags === undefined ? {} : { tags }),
    ...(widget === undefined ? {} : { widget }),
  });
}

export function validateStaticTargets(value: unknown): readonly StaticTargetConfig[] {
  const targets = ownArray(value).map(validateTarget);
  return Object.freeze(targets);
}

export function createStaticTargetProvider(value: unknown): TargetProvider {
  const ownedTargets = validateStaticTargets(value);
  return Object.freeze({
    targets(): readonly StaticTargetConfig[] {
      return ownedTargets;
    },
  });
}
