import type { Problem } from "@8lines/gauntlet-protocol";
import { problem } from "./problems.js";

const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

type MultipartResult =
  | { readonly ok: true; readonly file: Blob }
  | { readonly ok: false; readonly problem: Problem };

function failure(status: number, slug: string, title: string): MultipartResult {
  return {
    ok: false,
    problem: problem(`urn:gauntlet:problem:${slug}`, title, status),
  };
}

function contentLength(request: Request): number | undefined {
  const header = request.headers.get("content-length");
  if (header === null) return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(header)) return Number.NaN;
  return Number(header);
}

async function readBody(request: Request): Promise<Uint8Array | undefined> {
  const declared = contentLength(request);
  if (declared !== undefined
    && (!Number.isSafeInteger(declared) || declared > MAX_UPLOAD_BYTES)) {
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
      if (size > MAX_UPLOAD_BYTES) {
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

export async function readMultipartFile(request: Request): Promise<MultipartResult> {
  const contentType = request.headers.get("content-type");
  if (contentType === null || !/^multipart\/form-data\s*;/i.test(contentType)) {
    return failure(415, "unsupported-media-type", "Unsupported media type");
  }
  const bytes = await readBody(request);
  if (bytes === undefined) return failure(413, "payload-too-large", "Payload too large");

  let form: FormData;
  try {
    const ownedBytes = new Uint8Array(bytes.byteLength);
    ownedBytes.set(bytes);
    form = await new Request("http://adapter.invalid", {
      method: "POST",
      headers: { "content-type": contentType },
      body: ownedBytes.buffer,
    }).formData();
  } catch {
    return failure(400, "invalid-multipart", "Invalid multipart request");
  }
  const entries = [...form.entries()];
  if (entries.length !== 1 || entries[0]?.[0] !== "file" || !(entries[0][1] instanceof Blob)) {
    return failure(422, "validation-failed", "Validation failed");
  }
  if (entries[0][1].size > MAX_UPLOAD_BYTES) {
    return failure(413, "payload-too-large", "Payload too large");
  }
  return { ok: true, file: entries[0][1] };
}
