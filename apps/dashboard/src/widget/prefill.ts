/**
 * Placement bindings: mapping a matched page subject's values onto an
 * operation's input, on top of schema defaults and the selected preset (the
 * caller supplies `base` already merged in that order — see
 * docs/superpowers/specs/2026-09-25-embeddable-widget-design.md, "Prefill
 * order"). Bindings never overwrite locked pointers (a preset's
 * `lockedPointers`); those are reported back as `skipped` for the caller to
 * render a note. Coercion mirrors the phase-1 placement validation rules:
 * only scalar leaves are ever bound (see packages/protocol/src/placements.ts),
 * so walking `properties` without `$ref`/combinator resolution is enough to
 * find the leaf's declared type.
 */

import type { JsonPointer } from "@8lines/gauntlet-protocol";
import type { PageSubject } from "@8lines/gauntlet-widget-channel";
import { writePointer } from "../json-pointer.ts";

export interface BindingValue {
  readonly pointer: JsonPointer;
  readonly value: string | number | boolean;
}

export interface PrefillResult {
  readonly values: Record<string, unknown>;
  readonly skipped: readonly JsonPointer[];
}

/** Maps placement bindings (pointer → subject value key) to concrete values, dropping keys absent from the subject. */
export function bindingValues(
  placementBindings: Readonly<Record<string, string>> | undefined,
  subject: PageSubject,
): readonly BindingValue[] {
  if (placementBindings === undefined) return [];
  const result: BindingValue[] = [];
  for (const [pointer, key] of Object.entries(placementBindings)) {
    // `subject.values` is a plain object keyed by arbitrary subject value names; a key
    // named "constructor" or similar must not resolve to Object.prototype's own property.
    if (!Object.hasOwn(subject.values, key)) continue;
    const value = subject.values[key];
    if (value !== undefined) result.push({ pointer: pointer as JsonPointer, value });
  }
  return result;
}

function pointerSegments(pointer: JsonPointer): readonly string[] {
  if (pointer === "") return [];
  return pointer.slice(1).split("/").map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

/** Walks `properties` along the pointer to find the leaf schema's declared `type`. No `$ref`/combinator support — see module doc. */
function leafType(inputSchema: unknown, pointer: JsonPointer): string | undefined {
  let node: unknown = inputSchema;
  for (const segment of pointerSegments(pointer)) {
    if (typeof node !== "object" || node === null) return undefined;
    const properties = (node as { properties?: unknown }).properties;
    if (typeof properties !== "object" || properties === null) return undefined;
    node = (properties as Record<string, unknown>)[segment];
  }
  if (typeof node !== "object" || node === null) return undefined;
  const type = (node as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

const NUMERIC_LITERAL = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;

/**
 * Coerces a bound value against the leaf's declared type: a number or boolean
 * subject value becomes its string form for a `string` leaf; exact numeric
 * literals become numbers for `integer`/`number` leaves (an `integer` leaf
 * rejects a fractional literal and keeps it as a string); `"true"`/`"false"`
 * become booleans for `boolean` leaves. Anything else is passed through —
 * adapter validation reports mismatches through the standard form errors.
 */
function coerceLeaf(value: string | number | boolean, type: string | undefined): string | number | boolean {
  if (typeof value !== "string") return type === "string" ? String(value) : value;
  if ((type === "integer" || type === "number") && NUMERIC_LITERAL.test(value)) {
    if (type === "number" || !value.includes(".")) return Number(value);
    return value;
  }
  if (type === "boolean" && (value === "true" || value === "false")) return value === "true";
  return value;
}

/** Applies bindings on top of `base` (schema defaults + preset input), skipping locked pointers. Never mutates `base`. */
export function applyBindings(
  base: Record<string, unknown>,
  inputSchema: unknown,
  bindings: readonly BindingValue[],
  locked: readonly JsonPointer[],
): PrefillResult {
  const lockedPointers = new Set<JsonPointer>(locked);
  let values: Record<string, unknown> = base;
  const skipped: JsonPointer[] = [];
  for (const binding of bindings) {
    if (lockedPointers.has(binding.pointer)) {
      skipped.push(binding.pointer);
      continue;
    }
    const coerced = coerceLeaf(binding.value, leafType(inputSchema, binding.pointer));
    values = writePointer(values, binding.pointer, coerced);
  }
  return { values, skipped };
}

/** The parts of an operation preset that shape the prefill. */
export interface PrefillPreset {
  readonly input: Readonly<Record<string, unknown>>;
  readonly lockedPointers?: readonly JsonPointer[] | undefined;
}

/**
 * The whole prefill for one preset choice, recomputed from scratch each time so switching
 * presets back and forth never carries a previous preset's values or locks: `defaults`
 * (schema defaults, or the dashboard's initial input), then the preset's input, then the
 * page bindings — skipping the preset's locked pointers. `bindings` is `undefined` when the
 * operation was not opened from a page subject.
 */
export function prefillForPreset(
  inputSchema: unknown,
  defaults: Record<string, unknown>,
  preset: PrefillPreset | undefined,
  bindings: readonly BindingValue[] | undefined,
): PrefillResult {
  const base = preset === undefined ? defaults : { ...defaults, ...preset.input };
  if (bindings === undefined) return { values: base, skipped: [] };
  return applyBindings(base, inputSchema, bindings, preset?.lockedPointers ?? []);
}

/**
 * After unlocking (choosing "Empty form"), writes the page values back into the
 * pointers a preset lock had skipped. Every other field keeps what the user sees, including
 * their own edits. Returns `values` itself when there is nothing to restore.
 */
export function restoreSkippedBindings(
  values: Record<string, unknown>,
  inputSchema: unknown,
  bindings: readonly BindingValue[] | undefined,
  skipped: readonly JsonPointer[],
): Record<string, unknown> {
  if (bindings === undefined || skipped.length === 0) return values;
  const restore = new Set<JsonPointer>(skipped);
  return applyBindings(values, inputSchema, bindings.filter((binding) => restore.has(binding.pointer)), []).values;
}
