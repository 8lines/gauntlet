import { createServer } from "node:http";
import { Readable, type Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";

const ADAPTER_PREFIX = "/_gauntlet/v1";
const MAX_TARGET_LENGTH = 8192;

function response(status: 400 | 503, type: string, title: string): string {
  const body = JSON.stringify({ type, title, status });
  const reason = status === 400 ? "Bad Request" : "Service Unavailable";
  return `HTTP/1.1 ${status} ${reason}\r\nContent-Type: application/problem+json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;
}

const INVALID_RESPONSE = response(
  400,
  "urn:gauntlet:problem:invalid-path",
  "Invalid path",
);
const INVALID_BODY = JSON.stringify({
  type: "urn:gauntlet:problem:invalid-path",
  title: "Invalid path",
  status: 400,
});

function originFormTarget(target: string): string | undefined {
  if (target.length === 0 || target.length > MAX_TARGET_LENGTH) return undefined;
  return target.startsWith("/") ? target : undefined;
}

function lexicalTargetPath(target: string): string | undefined {
  if (target.length === 0 || target.length > MAX_TARGET_LENGTH) return undefined;
  if (target.startsWith("/")) return target;
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(target);
  if (scheme === null) return undefined;
  const authorityStart = scheme[0].length;
  const delimiter = target.slice(authorityStart).search(/[/?#]/);
  if (delimiter === -1) return "/";
  const index = authorityStart + delimiter;
  return target[index] === "/" ? target.slice(index) : `/${target.slice(index)}`;
}

function decodeAsciiEscapes(value: string): string {
  let decoded = value;
  for (let pass = 0; pass < 3; pass += 1) {
    const next = decoded.replace(/%([0-9A-Fa-f]{2})/g, (escape, hex: string) => {
      const byte = Number.parseInt(hex, 16);
      return byte <= 0x7f ? String.fromCharCode(byte) : escape;
    });
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

function hasAdapterPrefix(value: string): boolean {
  return value === ADAPTER_PREFIX || value.startsWith(`${ADAPTER_PREFIX}/`);
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

function couldAddressAdapter(target: string): boolean {
  const path = lexicalTargetPath(target)?.split(/[?#]/, 1)[0];
  if (path === undefined) return false;
  const decoded = decodeAsciiEscapes(path).replaceAll("\\", "/");
  const collapsed = `/${decoded.split("/").filter((segment) => segment !== "").join("/")}`;
  return hasAdapterPrefix(path)
    || hasAdapterPrefix(decoded)
    || hasAdapterPrefix(collapsed)
    || hasAdapterPrefix(normalizedLexicalPath(path));
}

function isUnsafeAdapterTarget(target: string): boolean {
  return target.includes("%")
    || /[\\\s]/.test(target)
    || target.includes("//")
    || target.includes("/./")
    || target.includes("/../")
    || target.includes("?")
    || target.includes("#")
    || target.endsWith("/.")
    || target.endsWith("/..")
    || target.endsWith("/");
}

function isAdapterPacket(packet: Buffer | undefined): boolean {
  const bounded = packet?.subarray(0, MAX_TARGET_LENGTH).toString("latin1") ?? "";
  const line = bounded.split("\r\n", 1)[0] ?? "";
  const match = /^[A-Z]{1,16} (.*) HTTP\/1\.[01]$/.exec(line);
  const target = match?.[1];
  return target !== undefined && couldAddressAdapter(target);
}

export function sanitizedIngressHeaders(input: HeadersInit): Headers {
  const headers = new Headers(input);
  for (const name of [...headers.keys()]) {
    if (name.startsWith("x-tc-") || name.startsWith("x-forwarded-")) {
      headers.delete(name);
    }
  }
  return headers;
}

export interface TrustedIngress {
  readonly url: string;
  forwardedHeaders(): Headers | undefined;
  close(): Promise<void>;
}

export async function startTrustedIngress(upstream: string): Promise<TrustedIngress> {
  let latestHeaders: Headers | undefined;
  const server = createServer(async (incoming, outgoing) => {
    const abort = new AbortController();
    const abortUpstream = () => {
      if (!outgoing.writableEnded) abort.abort();
    };
    outgoing.once("close", abortUpstream);
    try {
      const target = incoming.url;
      if (typeof target !== "string") {
        outgoing.writeHead(400, { "content-length": "0", connection: "close" });
        outgoing.end();
        return;
      }
      const originTarget = originFormTarget(target);
      if (originTarget === undefined) {
        if (couldAddressAdapter(target)) {
          outgoing.writeHead(400, {
            "content-type": "application/problem+json; charset=utf-8",
            "content-length": Buffer.byteLength(INVALID_BODY),
            connection: "close",
          });
          outgoing.end(INVALID_BODY);
        } else {
          outgoing.writeHead(400, { "content-length": "0", connection: "close" });
          outgoing.end();
        }
        return;
      }
      if (couldAddressAdapter(target) && (!hasAdapterPrefix(originTarget.split(/[?#]/, 1)[0]!)
        || isUnsafeAdapterTarget(originTarget))) {
        outgoing.writeHead(400, {
          "content-type": "application/problem+json; charset=utf-8",
          "content-length": Buffer.byteLength(INVALID_BODY),
          connection: "close",
        });
        outgoing.end(INVALID_BODY);
        return;
      }

      const headers = sanitizedIngressHeaders(incoming.headers as HeadersInit);
      headers.set("accept-encoding", "identity");
      latestHeaders = new Headers(headers);
      const request = new Request(`${upstream}${originTarget}`, {
        method: incoming.method,
        headers,
        body: ["GET", "HEAD"].includes(incoming.method ?? "") ? undefined : incoming as never,
        duplex: "half",
        signal: abort.signal,
      } as unknown as RequestInit);
      const result = await fetch(request);
      outgoing.writeHead(result.status, Object.fromEntries(result.headers));
      if (result.body === null || incoming.method === "HEAD") {
        outgoing.end();
        return;
      }
      await pipeline(
        Readable.fromWeb(result.body as never),
        outgoing,
        { signal: abort.signal },
      );
    } catch {
      if (!outgoing.headersSent && !outgoing.destroyed) {
        outgoing.writeHead(502, { "content-length": "0", connection: "close" });
        outgoing.end();
      } else if (!outgoing.destroyed) {
        outgoing.destroy();
      }
    } finally {
      outgoing.off("close", abortUpstream);
    }
  });
  server.on("clientError", (error: Error & { rawPacket?: Buffer }, socket: Duplex) => {
    if (socket.destroyed || socket.writableEnded) return;
    socket.end(isAdapterPacket(error.rawPacket)
      ? INVALID_RESPONSE
      : "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Ingress bind failure");

  return {
    url: `http://127.0.0.1:${address.port}`,
    forwardedHeaders: () => latestHeaders === undefined ? undefined : new Headers(latestHeaders),
    close: () => new Promise((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}
