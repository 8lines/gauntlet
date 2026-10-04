import {
  assertNonProductionEnvironment,
  isProtocolId,
  type EnvironmentDescriptor,
  type ProtocolId,
} from "@8lines/gauntlet-protocol";
import { readFile } from "node:fs/promises";
import { isAlias, parseAllDocuments, visit } from "yaml";
import { authConfiguration, type AuthConfiguration } from "./auth/config.js";
import { validateStaticTargets, type StaticTargetConfig } from "./static-target-provider.js";

export const DEFAULT_CONFIG_FILE = "/etc/gauntlet/config.yaml";
export const MAX_CONFIG_BYTES = 1024 * 1024;

export type ConfigurationErrorCode =
  | "source-conflict"
  | "file-unreadable"
  | "file-too-large"
  | "unsupported-extension"
  | "invalid-syntax"
  | "invalid-document"
  | "legacy-environment-missing";

const LEGACY_ENVIRONMENT_KEYS = [
  "GAUNTLET_TARGETS_JSON",
  "GAUNTLET_INSTANCE_NAME",
  "GAUNTLET_ENVIRONMENT_NAME",
  "GAUNTLET_ENVIRONMENT_KIND",
] as const;

type LegacyEnvironmentKey = typeof LEGACY_ENVIRONMENT_KEYS[number];

interface ConfigurationFileSource {
  readonly path: string;
  readonly explicit: boolean;
}

interface LegacyEnvironmentSource {
  readonly present: boolean;
  readonly values: Readonly<Record<LegacyEnvironmentKey, string | undefined>>;
}

let legacyWarningEmitted = false;

export class GauntletConfigurationError extends TypeError {
  constructor(readonly code: ConfigurationErrorCode) {
    super(`Invalid Gauntlet configuration (${code})`);
    this.name = "GauntletConfigurationError";
  }
}

export interface GauntletInstanceConfiguration {
  readonly name: ProtocolId;
  readonly environment: EnvironmentDescriptor;
}

export interface WidgetConfiguration {
  readonly enabled: boolean;
}

export interface ServerConfiguration {
  readonly version: 1;
  readonly instance: GauntletInstanceConfiguration;
  readonly widget: WidgetConfiguration;
  readonly auth: AuthConfiguration;
  readonly targets: readonly StaticTargetConfig[];
}

const DISABLED_WIDGET: WidgetConfiguration = Object.freeze({ enabled: false });

function widgetConfiguration(value: unknown): WidgetConfiguration {
  const record = ownDataRecord(value);
  if (Object.keys(record).some((key) => key !== "enabled")) throw configurationError("invalid-document");
  if (!Object.hasOwn(record, "enabled")) return DISABLED_WIDGET;
  if (typeof record.enabled !== "boolean") throw configurationError("invalid-document");
  return Object.freeze({ enabled: record.enabled });
}

function configurationError(code: ConfigurationErrorCode): GauntletConfigurationError {
  return new GauntletConfigurationError(code);
}

function configurationFileSource(
  environment: Readonly<Record<string, string | undefined>>,
): ConfigurationFileSource {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(environment, "GAUNTLET_CONFIG_FILE");
    if (descriptor === undefined) return { path: DEFAULT_CONFIG_FILE, explicit: false };
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw configurationError("file-unreadable");
    }
    if (descriptor.value === undefined) return { path: DEFAULT_CONFIG_FILE, explicit: false };
    if (typeof descriptor.value !== "string" || descriptor.value.length === 0) {
      throw configurationError("file-unreadable");
    }
    return { path: descriptor.value, explicit: true };
  } catch {
    throw configurationError("file-unreadable");
  }
}

function legacyEnvironmentSource(
  environment: Readonly<Record<string, string | undefined>>,
): LegacyEnvironmentSource {
  try {
    let present = false;
    const values: Record<LegacyEnvironmentKey, string | undefined> = {
      GAUNTLET_TARGETS_JSON: undefined,
      GAUNTLET_INSTANCE_NAME: undefined,
      GAUNTLET_ENVIRONMENT_NAME: undefined,
      GAUNTLET_ENVIRONMENT_KIND: undefined,
    };
    for (const key of LEGACY_ENVIRONMENT_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(environment, key);
      if (descriptor === undefined) continue;
      present = true;
      if (!descriptor.enumerable || !("value" in descriptor) || typeof descriptor.value !== "string") {
        throw configurationError("legacy-environment-missing");
      }
      values[key] = descriptor.value;
    }
    return Object.freeze({ present, values: Object.freeze(values) });
  } catch {
    throw configurationError("legacy-environment-missing");
  }
}

function ownDataRecord(value: unknown): Readonly<Record<string, unknown>> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw configurationError("invalid-document");
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw configurationError("invalid-document");
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) {
      throw configurationError("invalid-document");
    }
    const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw configurationError("invalid-document");
      }
      record[key] = descriptor.value;
    }
    return record;
  } catch {
    throw configurationError("invalid-document");
  }
}

function exactKeys(record: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(record, key));
}

function parseConfigurationText(path: string, bytes: Uint8Array): unknown {
  if (bytes.byteLength > MAX_CONFIG_BYTES) {
    throw configurationError("file-too-large");
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw configurationError("invalid-syntax");
  }

  try {
    if (path.endsWith(".json")) {
      const value = JSON.parse(text) as unknown;
      const documents = parseAllDocuments(text, {
        schema: "json",
        strict: true,
        uniqueKeys: true,
      });
      if (documents.length !== 1
        || documents[0] === undefined
        || documents[0].errors.length !== 0
        || documents[0].contents === null) {
        throw configurationError("invalid-syntax");
      }
      return value;
    }
    if (!path.endsWith(".yaml") && !path.endsWith(".yml")) {
      throw configurationError("unsupported-extension");
    }

    const documents = parseAllDocuments(text, {
      strict: true,
      uniqueKeys: true,
    });
    if (documents.length !== 1) {
      throw configurationError("invalid-syntax");
    }
    const [document] = documents;
    if (document === undefined || document.errors.length !== 0 || document.contents === null) {
      throw configurationError("invalid-syntax");
    }
    let containsAlias = false;
    visit(document, (_key, node) => {
      if (isAlias(node)) containsAlias = true;
    });
    if (containsAlias) {
      throw configurationError("invalid-syntax");
    }
    return document.toJS({ maxAliasCount: 0 }) as unknown;
  } catch (error) {
    if (error instanceof GauntletConfigurationError) throw error;
    throw configurationError("invalid-syntax");
  }
}

function validateConfigurationV1(value: unknown): ServerConfiguration {
  try {
    const record = ownDataRecord(value);
    const allowed = ["version", "instance", "targets", "widget", "auth"];
    if (Object.keys(record).some((key) => !allowed.includes(key))
      || !["version", "instance", "targets"].every((key) => Object.hasOwn(record, key))
      || record.version !== 1) {
      throw configurationError("invalid-document");
    }

    const instanceRecord = ownDataRecord(record.instance);
    if (!exactKeys(instanceRecord, ["name", "environment"])
      || !isProtocolId(instanceRecord.name)) {
      throw configurationError("invalid-document");
    }
    const instance = Object.freeze({
      name: instanceRecord.name,
      environment: assertNonProductionEnvironment(instanceRecord.environment),
    });

    const targets = validateStaticTargets(record.targets);
    if (targets.length === 0) {
      throw configurationError("invalid-document");
    }
    const targetIds = new Set<ProtocolId>();
    for (const target of targets) {
      if (targetIds.has(target.id)) {
        throw configurationError("invalid-document");
      }
      targetIds.add(target.id);
    }

    const widget = Object.hasOwn(record, "widget") ? widgetConfiguration(record.widget) : DISABLED_WIDGET;
    const auth = authConfiguration(record.auth);
    return Object.freeze({ version: 1, instance, widget, auth, targets });
  } catch {
    throw configurationError("invalid-document");
  }
}

export function parseStaticTargetsJson(value: string | undefined): readonly StaticTargetConfig[] {
  if (value === undefined) {
    return validateStaticTargets([]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new TypeError("GAUNTLET_TARGETS_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new TypeError("GAUNTLET_TARGETS_JSON must contain an array");
  }
  return validateStaticTargets(parsed);
}

function legacyDocument(source: LegacyEnvironmentSource): unknown {
  const {
    GAUNTLET_TARGETS_JSON: targetsJson,
    GAUNTLET_INSTANCE_NAME: instanceName,
    GAUNTLET_ENVIRONMENT_NAME: environmentName,
    GAUNTLET_ENVIRONMENT_KIND: environmentKind,
  } = source.values;
  if (targetsJson === undefined
    || instanceName === undefined
    || environmentName === undefined
    || environmentKind === undefined) {
    throw configurationError("legacy-environment-missing");
  }
  if (new TextEncoder().encode(targetsJson).byteLength > MAX_CONFIG_BYTES) {
    throw configurationError("file-too-large");
  }
  let targets: unknown;
  try {
    targets = JSON.parse(targetsJson) as unknown;
  } catch {
    throw configurationError("invalid-syntax");
  }
  return {
    version: 1,
    instance: {
      name: instanceName,
      environment: { name: environmentName, kind: environmentKind },
    },
    targets,
  };
}

function emitLegacyDeprecationWarning(): void {
  if (legacyWarningEmitted) return;
  legacyWarningEmitted = true;
  try {
    process.emitWarning("GAUNTLET_TARGETS_JSON is deprecated; configure GAUNTLET_CONFIG_FILE instead", {
      code: "GAUNTLET_TARGETS_JSON_DEPRECATED",
    });
  } catch {
    // A warning transport must not expose configuration input or change the selected source.
  }
}

export async function loadServerConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
  read: (path: string) => Promise<Uint8Array> = readFile,
): Promise<ServerConfiguration> {
  const fileSource = configurationFileSource(environment);
  const legacySource = legacyEnvironmentSource(environment);
  if (fileSource.explicit && legacySource.present) {
    throw configurationError("source-conflict");
  }
  if (legacySource.present) {
    const configuration = validateConfigurationV1(legacyDocument(legacySource));
    emitLegacyDeprecationWarning();
    return configuration;
  }
  let bytes: Uint8Array;
  try {
    bytes = await read(fileSource.path);
  } catch {
    throw configurationError("file-unreadable");
  }
  return validateConfigurationV1(parseConfigurationText(fileSource.path, bytes));
}
