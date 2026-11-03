/**
 * Derives the Gauntlet origin and base URL from the loader's own script URL(s).
 * The base URL is everything before `/widget/loader.js`, so a Gauntlet served
 * under a base path (`https://host/tester/widget/loader.js`) gives
 * `https://host/tester`, and one at the root gives the origin. An opaque
 * origin (`"null"`, for example a `file:` or `data:` URL) cannot address the
 * panel or be checked against `postMessage` origins, so it is an error.
 */

export type OriginResult =
  | {
      readonly ok: true;
      /** Checked against `postMessage` events and used as their target origin. */
      readonly origin: string;
      /** Origin plus base path, without a trailing slash; the panel is `${baseUrl}/widget/`. */
      readonly baseUrl: string;
    }
  | { readonly ok: false; readonly reason: string };

const LOADER_PATH = "/widget/loader.js";

function basePath(pathname: string): string {
  if (!pathname.endsWith(LOADER_PATH)) return "";
  const base = pathname.slice(0, -LOADER_PATH.length);
  // Only a canonical path prefix; anything else (`//`, dot segments) falls back to the root.
  return base === "" || /^(?:\/[A-Za-z0-9][A-Za-z0-9._~-]*)+$/.test(base) ? base : "";
}

export function deriveGauntletOrigin(sources: readonly string[]): OriginResult {
  for (const src of sources) {
    if (!src) continue;
    let url: URL;
    try {
      url = new URL(src);
    } catch {
      continue; // try the next candidate
    }
    const origin = url.origin;
    if (origin === "null") {
      return { ok: false, reason: `the loader script ${src} has an opaque origin; serve it from the Gauntlet server over http(s)` };
    }
    return { ok: true, origin, baseUrl: `${origin}${basePath(url.pathname)}` };
  }
  return { ok: false, reason: "cannot determine the Gauntlet origin from the loader script" };
}
