/**
 * The URL path prefix Gauntlet is served under, such as `/tester`, or `""` at the root.
 *
 * The dashboard and the widget panel are built once with relative asset URLs; the server tells a
 * page where it is served by injecting `<meta name="gauntlet-base-path" content="/tester">` (and,
 * for the dashboard, `<base href="/tester/">`) into its `index.html`. Every API request, the
 * widget configuration, the MCP URL and client-side routes are prefixed with it.
 */

const BASE_PATH = /^(?:\/[A-Za-z0-9][A-Za-z0-9._~-]*)+$/;

/** The base path a page declares; a missing or malformed declaration means the root. */
export function readBasePath(document: Pick<Document, "querySelector"> | undefined = globalThis.document): string {
  let content: string | null | undefined;
  try {
    content = document?.querySelector('meta[name="gauntlet-base-path"]')?.getAttribute("content");
  } catch {
    return "";
  }
  return typeof content === "string" && content.length <= 256 && BASE_PATH.test(content) ? content : "";
}

let current: string | undefined;

/** Replaces the detected base path, for tests and embedders that know it. */
export function configureBasePath(basePath: string): void {
  current = basePath === "" || BASE_PATH.test(basePath) ? basePath : "";
}

export function basePath(): string {
  current ??= readBasePath();
  return current;
}

/** `path` (absolute, from the Gauntlet root, such as `/api/v1/targets`) below the base path. */
export function withBasePath(path: string): string {
  return `${basePath()}${path}`;
}

/** A browser pathname relative to the Gauntlet root; a pathname outside the base path is returned unchanged. */
export function withoutBasePath(pathname: string): string {
  const base = basePath();
  if (base === "") return pathname;
  if (pathname === base) return "/";
  return pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : pathname;
}
