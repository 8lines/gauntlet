/**
 * Parses and validates `BootOptions` (see `@8lines/gauntlet-widget`) into a
 * `LoaderConfig` with compiled routes, tracking ignored keys for a single
 * caller-issued warning.
 */

import { isPortableId } from "@8lines/gauntlet-widget-channel";
import type { ButtonPosition } from "@8lines/gauntlet-widget";
import { compileRoutes, type CompiledRoute } from "./routes.js";

export interface LoaderConfig {
  readonly target: string;
  readonly routes: readonly CompiledRoute[];
  readonly position: ButtonPosition;
}

export type OptionsResult =
  | { readonly ok: true; readonly config: LoaderConfig; readonly ignoredKeys: readonly string[] }
  | { readonly ok: false; readonly reason: string };

const KNOWN_KEYS = new Set(["target", "routes", "position"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseBootOptions(value: unknown): OptionsResult {
  if (!isPlainObject(value)) {
    return { ok: false, reason: "boot options must be an object" };
  }
  const target = value["target"];
  if (!isPortableId(target)) {
    return { ok: false, reason: "boot options target must be a valid identifier" };
  }
  const routes = compileRoutes(value["routes"]);
  if (routes === undefined) {
    return { ok: false, reason: "boot options routes are invalid" };
  }
  let position: ButtonPosition = "bottom-right";
  if ("position" in value) {
    const rawPosition = value["position"];
    if (rawPosition !== "bottom-right" && rawPosition !== "bottom-left") {
      return { ok: false, reason: 'boot options position must be "bottom-right" or "bottom-left"' };
    }
    position = rawPosition;
  }
  const ignoredKeys = Object.keys(value).filter((key) => !KNOWN_KEYS.has(key));
  return { ok: true, config: { target, routes, position }, ignoredKeys };
}
