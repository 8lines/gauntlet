import type { JsonPointer, ValidationError } from "@8lines/gauntlet-protocol";

/**
 * JSON Schema validators report a missing required field as an error anchored
 * on the parent object (`instancePath: ""`) and give the field name in
 * `params.missingProperty`. We move such an error onto the specific field so it
 * can be highlighted. When the adapter gives no name, the error stays general — we do not guess.
 */
export function attachToFields(errors: readonly ValidationError[]): readonly ValidationError[] {
  return errors.map((e) => {
    const missing = (e.params as { missingProperty?: unknown } | undefined)?.missingProperty;
    if (e.keyword !== "required" || typeof missing !== "string") return e;
    return { ...e, instancePath: `${e.instancePath}/${missing}` as JsonPointer };
  });
}

/** Errors that cannot be attached to any visible field. */
export function generalErrors(errors: readonly ValidationError[]): readonly string[] {
  const messages = errors.filter((e) => e.instancePath === "").map((e) => e.message ?? "Invalid value");
  return [...new Set(messages)];
}
