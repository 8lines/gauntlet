import type { JsonObject, JsonValue, ValidationError } from "@8lines/gauntlet-protocol";

export interface SchemaValidator {
  validate(schema: JsonObject, instance: JsonValue): readonly ValidationError[] | Promise<readonly ValidationError[]>;
}
