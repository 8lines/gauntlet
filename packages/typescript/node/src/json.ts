import type { JsonObject, Problem } from "@8lines/gauntlet-protocol";
import { ownCanonicalJson } from "@8lines/gauntlet-typescript-core";
import { problem } from "./problems.js";

const MAX_JSON_BYTES = 4 * 1024 * 1024;

function invalidJson(status: 400 | 415): Problem {
  return problem(
    status === 415
      ? "urn:gauntlet:problem:unsupported-media-type"
      : "urn:gauntlet:problem:invalid-json",
    status === 415 ? "Unsupported media type" : "Invalid JSON",
    status,
  );
}

function declaredLength(request: Request): number | undefined {
  const value = request.headers.get("content-length");
  if (value === null) return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return Number.NaN;
  return Number(value);
}

async function readBoundedBytes(request: Request): Promise<Uint8Array | undefined> {
  const length = declaredLength(request);
  if (length !== undefined && (!Number.isSafeInteger(length) || length > MAX_JSON_BYTES)) {
    return undefined;
  }
  if (request.body === null) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readJsonObject(request: Request): Promise<{ readonly ok: true; readonly value: JsonObject } | { readonly ok: false; readonly problem: Problem }> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase();
  if (contentType !== "application/json" && !/^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(contentType ?? "")) {
    return { ok: false, problem: invalidJson(415) };
  }
  try {
    const bytes = await readBoundedBytes(request);
    if (bytes === undefined) return { ok: false, problem: invalidJson(400) };
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    if (value === null || Array.isArray(value) || typeof value !== "object") return { ok: false, problem: problem("urn:gauntlet:problem:validation-failed", "Validation failed", 422) };
    return { ok: true, value: ownCanonicalJson(value as JsonObject) };
  } catch {
    return { ok: false, problem: invalidJson(400) };
  }
}
