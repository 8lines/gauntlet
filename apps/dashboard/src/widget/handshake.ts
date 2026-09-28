/**
 * Panel side of the channel-1 handshake: parsing `/widget/config.json`
 * (phase 2 shape) and deciding what to do with an incoming
 * `window.addEventListener("message", ...)` event once the panel has posted
 * `gauntlet:ready` to `window.parent`. See
 * docs/superpowers/specs/2026-09-25-embeddable-widget-design.md, "Handshake",
 * and the loader's mirror-image `panelHandshake` in
 * packages/widget-loader/src/handshake.ts.
 *
 * `gauntlet:connect` is accepted only when the message comes from
 * `window.parent`, the sender's origin is listed for the requested target in
 * `config.targets`, and exactly one `MessagePort` was transferred. Anything
 * else from the parent is a rejection; anything not from the parent, or that
 * doesn't parse as a channel-1 `gauntlet:connect` message, is ignored.
 */

import { parseHandshakeMessage } from "@8lines/gauntlet-widget-channel";

export interface WidgetConfig {
  readonly targets: Readonly<Record<string, readonly string[]>>;
}

/** Parses `/widget/config.json`'s `{ targets: { [targetId]: string[] } }` shape, rejecting anything else. */
export function parseWidgetConfig(value: unknown): WidgetConfig | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const targets = (value as { targets?: unknown }).targets;
  if (typeof targets !== "object" || targets === null || Array.isArray(targets)) return undefined;
  const entries: Record<string, readonly string[]> = {};
  for (const [targetId, origins] of Object.entries(targets as Record<string, unknown>)) {
    if (!Array.isArray(origins) || !origins.every((origin) => typeof origin === "string")) return undefined;
    entries[targetId] = origins;
  }
  return { targets: entries };
}

export interface ConnectEventLike {
  readonly origin: string;
  readonly source: unknown;
  readonly data: unknown;
  readonly ports: readonly unknown[];
}

export type ConnectDecision =
  | { readonly kind: "connect"; readonly target: string; readonly port: unknown }
  | { readonly kind: "reject" }
  | { readonly kind: "ignore" };

export function decideConnect(event: ConnectEventLike, parent: unknown, config: WidgetConfig): ConnectDecision {
  if (event.source !== parent) return { kind: "ignore" };
  const parsed = parseHandshakeMessage(event.data);
  if (parsed.kind !== "message" || parsed.message.type !== "gauntlet:connect") return { kind: "ignore" };

  const { target } = parsed.message;
  // `config.targets` is a plain object keyed by arbitrary target ids; a target named
  // "toString" or "constructor" must not fall through to Object.prototype's own
  // property of that name (which would either misbehave or throw on `.includes`).
  if (!Object.hasOwn(config.targets, target)) return { kind: "reject" };
  const origins = config.targets[target];
  if (origins === undefined) return { kind: "reject" };
  if (!origins.includes(event.origin)) return { kind: "reject" };
  if (event.ports.length !== 1) return { kind: "reject" };
  return { kind: "connect", target, port: event.ports[0] };
}
