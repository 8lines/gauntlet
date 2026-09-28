import type { ProtocolId } from "./types.js";

export const PROTOCOL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function isProtocolId(value: unknown): value is ProtocolId {
  return typeof value === "string" && PROTOCOL_ID_PATTERN.test(value);
}
