import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  createAdapterFetchHandler,
  type AdapterFetchHandler,
} from "@8lines/gauntlet-typescript-node";
import { createConformanceCatalog } from "@8lines/gauntlet-typescript-fixture";
import {
  handleClientError,
  handleExceptionalResponse,
  handleExceptionalSocket,
} from "./client-error.js";

export async function startServer(
  enabled = true,
  adapterHandler?: AdapterFetchHandler,
): Promise<{ readonly url: string; close(): Promise<void> }> {
  const handler = adapterHandler
    ?? createAdapterFetchHandler({ enabled, catalog: createConformanceCatalog() });
  const server = createServer(async (incoming, outgoing) => {
    try {
      const rawTarget = incoming.url;
      if (typeof rawTarget !== "string") {
        outgoing.writeHead(400, { "content-length": "0", connection: "close" });
        outgoing.end();
        return;
      }
      if (["CONNECT", "TRACE", "TRACK"].includes(incoming.method ?? "")) {
        handleExceptionalResponse(
          incoming,
          outgoing,
          enabled,
          405,
          "urn:gauntlet:problem:unsupported-method",
          "Unsupported method",
        );
        return;
      }
      const init = {
        method: incoming.method,
        headers: incoming.headers as HeadersInit,
        body: ["GET", "HEAD"].includes(incoming.method ?? "") ? undefined : incoming as never,
        duplex: "half",
      };
      const requestTarget = rawTarget.startsWith("/") ? rawTarget : "/";
      const request = new Request(`http://adapter${requestTarget}`, init as unknown as RequestInit);
      const response = await handler({ kind: "raw", request, rawTarget });
      if (!rawTarget.startsWith("/") && response.status === 404) {
        await response.body?.cancel();
        outgoing.writeHead(400, { "content-length": "0", connection: "close" });
        outgoing.end();
        return;
      }
      const canonicalMount = rawTarget === "/_gauntlet/v1"
        || rawTarget.startsWith("/_gauntlet/v1/");
      if (!canonicalMount && rawTarget.startsWith("/") && response.status === 404) {
        await response.body?.cancel();
        if (incoming.method === "GET" && rawTarget === "/host-health") {
          outgoing.writeHead(200, { "content-type": "application/json" });
          outgoing.end("{}");
          return;
        }
        outgoing.writeHead(404).end();
        return;
      }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body === null || incoming.method === "HEAD") {
        outgoing.end();
        return;
      }
      await pipeline(Readable.fromWeb(response.body as never), outgoing);
    } catch {
      if (!outgoing.headersSent && !outgoing.destroyed) {
        outgoing.writeHead(500, { "content-length": "0", connection: "close" });
        outgoing.end();
      } else if (!outgoing.destroyed) {
        outgoing.destroy();
      }
    }
  });
  server.on("clientError", (error: Error & { rawPacket?: Buffer }, socket) => handleClientError(socket, error.rawPacket, enabled));
  server.on("connect", (incoming, socket) => handleExceptionalSocket(
    incoming, socket, enabled, 405, "urn:gauntlet:problem:unsupported-method", "Unsupported method",
  ));
  server.on("upgrade", (incoming, socket) => handleExceptionalSocket(
    incoming, socket, enabled, 405, "urn:gauntlet:problem:unsupported-method", "Unsupported method",
  ));
  server.on("checkExpectation", (incoming, outgoing) => handleExceptionalResponse(
    incoming, outgoing, enabled, 417, "urn:gauntlet:problem:expectation-failed", "Expectation failed",
  ));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise((resolve, reject) => { server.closeAllConnections(); server.close((error) => error ? reject(error) : resolve()); }) };
}
