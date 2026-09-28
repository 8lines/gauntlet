import type { JsonValue } from "@8lines/gauntlet-protocol";
import { cloneAndDeepFreeze } from "./operation-internals.js";

/**
 * Takes an immutable snapshot of plain canonical JSON without invoking
 * accessors, `toJSON`, proxies, or application callbacks.
 */
export function ownCanonicalJson<T extends JsonValue>(value: T): T {
  return cloneAndDeepFreeze(value);
}
