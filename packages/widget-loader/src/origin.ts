/**
 * Derives the Gauntlet origin from the loader's own script URL(s). An opaque
 * origin (`"null"`, for example a `file:` or `data:` URL) cannot address the
 * panel or be checked against `postMessage` origins, so it is an error.
 */

export type OriginResult = { readonly ok: true; readonly origin: string } | { readonly ok: false; readonly reason: string };

export function deriveGauntletOrigin(sources: readonly string[]): OriginResult {
  for (const src of sources) {
    if (!src) continue;
    let origin: string;
    try {
      origin = new URL(src).origin;
    } catch {
      continue; // try the next candidate
    }
    if (origin === "null") {
      return { ok: false, reason: `the loader script ${src} has an opaque origin; serve it from the Gauntlet server over http(s)` };
    }
    return { ok: true, origin };
  }
  return { ok: false, reason: "cannot determine the Gauntlet origin from the loader script" };
}
