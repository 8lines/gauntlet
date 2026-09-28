import { isProtocolId } from "@8lines/gauntlet-protocol";

const root = "/_gauntlet/v1";
const prefix = `${root}/`;

function hasAdapterPrefix(value: string): boolean {
  return value === root || value.startsWith(prefix);
}

function lexicalPath(target: string): string | undefined {
  if (target.startsWith("/")) return target;
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(target);
  if (scheme === null) return undefined;
  let authorityStart = scheme[0].length;
  while (target[authorityStart] === "/" || target[authorityStart] === "\\") {
    authorityStart += 1;
  }
  const delimiter = target.slice(authorityStart).search(/[\\/?#]/);
  if (delimiter === -1) return "/";
  const index = authorityStart + delimiter;
  return target[index] === "/" ? target.slice(index) : `/${target.slice(index)}`;
}

function decodeAsciiEscapes(value: string): string {
  const decoded: string[] = [];
  for (const character of value) {
    decoded.push(character);
    while (decoded.length >= 3 && decoded.at(-3) === "%") {
      const high = decoded.at(-2)!;
      const low = decoded.at(-1)!;
      if (!/^[0-9A-Fa-f]$/.test(high) || !/^[0-9A-Fa-f]$/.test(low)) break;
      const byte = Number.parseInt(`${high}${low}`, 16);
      if (byte > 0x7f) break;
      decoded.length -= 3;
      decoded.push(String.fromCharCode(byte));
    }
  }
  return decoded.join("");
}

function normalizedLexicalPath(value: string): string {
  const slashNormalized = decodeAsciiEscapes(value).replaceAll("\\", "/");
  const segments: string[] = [];
  for (const segment of slashNormalized.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
}
export function parseAdapterPath(pathname: string): readonly string[] | undefined {
  if (!pathname.startsWith(prefix) || pathname.includes("%") || /[\\\s]/.test(pathname) || pathname.includes("//") || pathname.endsWith("/")) return undefined;
  const parts = pathname.slice(prefix.length).split("/");
  const id = (value: string) => isProtocolId(value);
  if (parts.length === 1 && ["health", "manifest", "uploads"].includes(parts[0]!)) return parts;
  if (parts.length === 2 && parts[0] === "operations" && id(parts[1]!)) return parts;
  if (parts.length === 3 && parts[0] === "operations" && id(parts[1]!) && parts[2] === "runs") return parts;
  if (parts.length === 2 && parts[0] === "runs" && id(parts[1]!)) return parts;
  if (parts.length === 3 && parts[0] === "runs" && id(parts[1]!) && ["cancel", "events"].includes(parts[2]!)) return parts;
  if (parts.length === 5 && parts[0] === "runs" && id(parts[1]!) && parts[2] === "artifacts" && id(parts[3]!) && parts[4] === "launch") return parts;
  if (parts.length === 3 && parts[0] === "data-sources" && id(parts[1]!) && ["query", "resolve"].includes(parts[2]!)) return parts;
  return undefined;
}

export function isAdapterTarget(target: string): boolean {
  const path = lexicalPath(target)?.split(/[?#]/, 1)[0];
  if (path === undefined) return false;
  const decoded = decodeAsciiEscapes(path).replaceAll("\\", "/");
  const collapsed = `/${decoded.split("/").filter((segment) => segment !== "").join("/")}`;
  return hasAdapterPrefix(path)
    || hasAdapterPrefix(decoded)
    || hasAdapterPrefix(collapsed)
    || hasAdapterPrefix(normalizedLexicalPath(path));
}
