/**
 * Validates the panel handshake message received by the loader via
 * `window.addEventListener("message", ...)`. See docs/superpowers/specs/
 * 2026-09-25-embeddable-widget-design.md, section "Handshake".
 */

import { parseHandshakeMessage } from "@8lines/gauntlet-widget-channel";

export interface MessageEventLike {
  readonly origin: string;
  readonly source: unknown;
  readonly data: unknown;
}

export function panelHandshake(event: MessageEventLike, gauntletOrigin: string, frame: unknown): "ready" | "rejected" | undefined {
  if (frame === undefined || frame === null) return undefined;
  if (event.origin !== gauntletOrigin) return undefined;
  if (event.source !== frame) return undefined;

  const parsed = parseHandshakeMessage(event.data);
  if (parsed.kind !== "message") return undefined;
  if (parsed.message.type === "gauntlet:ready") return "ready";
  if (parsed.message.type === "gauntlet:rejected") return "rejected";
  return undefined;
}
