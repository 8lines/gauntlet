import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  assertTcSchemaCore,
  canonicalizeForRevision,
  type JsonObject,
  type JsonValue,
  type ValidationError,
} from "@8lines/gauntlet-protocol";
import { cloneAndDeepFreeze } from "./operation-internals.js";
import type { SchemaValidator } from "./schema-validator.js";

const applyFormats = addFormats as unknown as (ajv: Ajv2020) => Ajv2020;

function errors(errors: readonly ErrorObject[] | null | undefined): readonly ValidationError[] {
  return cloneAndDeepFreeze((errors ?? []).map((error) => ({
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    keyword: error.keyword,
    message: "value does not satisfy schema",
    params: {},
  })));
}

function isDeeplyFrozenJson(value: unknown, visited = new Set<object>()): boolean {
  if (value === null || typeof value !== "object") return true;
  if (visited.has(value)) return true;
  if (!Object.isFrozen(value)) return false;
  visited.add(value);
  try {
    return Reflect.ownKeys(value).every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return typeof key === "string"
        && descriptor !== undefined
        && "value" in descriptor
        && isDeeplyFrozenJson(descriptor.value, visited);
    });
  } catch {
    return false;
  }
}

const MAX_COMPILED_SCHEMAS = 256;

export class AjvSchemaValidator implements SchemaValidator {
  readonly #ajv: Ajv2020;
  readonly #compiledByIdentity = new WeakMap<object, ValidateFunction>();
  readonly #compiledByCanonicalSchema = new Map<string, ValidateFunction>();

  constructor() {
    this.#ajv = new Ajv2020({ allErrors: true, strict: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
    applyFormats(this.#ajv);
  }
  validate(schema: JsonObject, instance: JsonValue): readonly ValidationError[] {
    const ownedInstance = cloneAndDeepFreeze(instance);
    let validate = this.#compiledByIdentity.get(schema);
    if (validate === undefined) {
      const ownedSchema = cloneAndDeepFreeze(schema);
      assertTcSchemaCore(ownedSchema);
      const key = canonicalizeForRevision(ownedSchema);
      validate = this.#compiledByCanonicalSchema.get(key);
      if (validate === undefined) {
        validate = this.#ajv.compile(ownedSchema);
        if (this.#compiledByCanonicalSchema.size >= MAX_COMPILED_SCHEMAS) {
          const oldest = this.#compiledByCanonicalSchema.keys().next().value as string | undefined;
          if (oldest !== undefined) this.#compiledByCanonicalSchema.delete(oldest);
        }
        this.#compiledByCanonicalSchema.set(key, validate);
      } else {
        this.#compiledByCanonicalSchema.delete(key);
        this.#compiledByCanonicalSchema.set(key, validate);
      }
      if (isDeeplyFrozenJson(schema)) this.#compiledByIdentity.set(schema, validate);
    }
    return validate(ownedInstance) ? Object.freeze([]) : errors(validate.errors);
  }
}

export function createAjvSchemaValidator(): SchemaValidator { return new AjvSchemaValidator(); }
