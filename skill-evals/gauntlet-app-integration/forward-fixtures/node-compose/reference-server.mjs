import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { assertNonProductionEnvironment } from "@8lines/gauntlet-protocol";
import { createAdapterFetchHandler, isAdapterTarget } from "@8lines/gauntlet-typescript-node";
import { createCatalog } from "./catalog.mjs";

const prefix = "/_gauntlet/v1";
if (process.env.TC_EVAL_PARENT_SECRET_SENTINEL !== undefined) {
  throw new Error("verifier parent environment leaked into the fixture process");
}

function startupConfiguration() {
  const enabled = process.env.GAUNTLET_ENABLED === "true";
  const application = {
    id: process.env.GAUNTLET_APPLICATION_ID,
    label: process.env.GAUNTLET_APPLICATION_LABEL,
    environment: {
      name: process.env.GAUNTLET_ENVIRONMENT_NAME,
      kind: process.env.GAUNTLET_ENVIRONMENT_KIND,
    },
  };
  if (!application.id || !application.label) throw new Error("application identity required");
  assertNonProductionEnvironment(application.environment);
  const secretPath = process.env.GAUNTLET_IDEMPOTENCY_SECRET_FILE;
  if (!secretPath) throw new Error("stable idempotency secret file required");
  const idempotencySecret = readFileSync(secretPath);
  if (idempotencySecret.byteLength < 32) throw new Error("idempotency secret too short");
  return { enabled, application, idempotencySecret };
}

function serveApplication(request, response) {
  if (request.url === "/host-health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"status":"ok"}\n');
    return;
  }
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not Found\n");
}

const { enabled, application, idempotencySecret } = startupConfiguration();
const runtime = createCatalog({ application, idempotencySecret });
const handler = createAdapterFetchHandler({ enabled, catalog: runtime.catalog });
const server = createServer(async (incoming, outgoing) => {
  try {
    const rawTarget = incoming.url;
    if (typeof rawTarget !== "string") {
      outgoing.writeHead(400, { "content-length": "0", connection: "close" });
      outgoing.end();
      return;
    }
    if (["CONNECT", "TRACE", "TRACK"].includes(incoming.method ?? "")) {
      handleExceptionalResponse(incoming, outgoing, enabled, 405, "urn:gauntlet:problem:unsupported-method", "Unsupported method");
      return;
    }
    const requestTarget = rawTarget.startsWith("/") ? rawTarget : "/";
    const request = new Request(`http://adapter${requestTarget}`, {
      method: incoming.method,
      headers: incoming.headers,
      body: ["GET", "HEAD"].includes(incoming.method ?? "") ? undefined : incoming,
      duplex: "half",
    });
    const adapterResponse = await handler({ kind: "raw", request, rawTarget });
    const canonicalMount = rawTarget === prefix || rawTarget.startsWith(`${prefix}/`);
    if (rawTarget.startsWith("/") && !canonicalMount && adapterResponse.status === 404) {
      await adapterResponse.body?.cancel();
      if (incoming.method === "GET" && rawTarget === "/__fixture/counters") {
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(`${JSON.stringify(runtime.counters())}\n`);
        return;
      }
      serveApplication(incoming, outgoing);
      return;
    }
    if (!rawTarget.startsWith("/") && adapterResponse.status === 404) {
      await adapterResponse.body?.cancel();
      outgoing.writeHead(400, { "content-length": "0", connection: "close" });
      outgoing.end();
      return;
    }
    outgoing.writeHead(adapterResponse.status, Object.fromEntries(adapterResponse.headers));
    if (adapterResponse.body === null || incoming.method === "HEAD") {
      outgoing.end();
      return;
    }
    await pipeline(Readable.fromWeb(adapterResponse.body), outgoing);
  } catch {
    if (!outgoing.headersSent) outgoing.writeHead(500, { "content-length": "0", connection: "close" });
    outgoing.end();
  }
});

const generic400 = "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
function fixedProblem(status, type, title) {
  const body = JSON.stringify({ type, title, status });
  const reason = { 400: "Bad Request", 405: "Method Not Allowed", 417: "Expectation Failed", 503: "Service Unavailable" }[status];
  return `HTTP/1.1 ${status} ${reason}\r\nContent-Type: application/problem+json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;
}
function exceptionalProblem(enabled, status, type, title) {
  return enabled
    ? { status, type, title }
    : { status: 503, type: "urn:gauntlet:problem:adapter-disabled", title: "Adapter disabled" };
}
function handleExceptionalResponse(incoming, outgoing, enabled, status, type, title) {
  const rawTarget = incoming.url;
  if (typeof rawTarget !== "string" || !isAdapterTarget(rawTarget)) {
    outgoing.writeHead(status, { "content-length": "0", connection: "close" });
    outgoing.end();
    return;
  }
  const problem = exceptionalProblem(enabled, status, type, title);
  const body = JSON.stringify(problem);
  outgoing.writeHead(problem.status, {
    "content-type": "application/problem+json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    connection: "close",
  });
  outgoing.end(body);
}
function handleExceptionalSocket(incoming, socket, enabled, status, type, title) {
  if (socket.destroyed || socket.writableEnded) return;
  const rawTarget = incoming.url;
  if (typeof rawTarget !== "string" || !isAdapterTarget(rawTarget)) return socket.end(generic400);
  const problem = exceptionalProblem(enabled, status, type, title);
  socket.end(fixedProblem(problem.status, problem.type, problem.title));
}
function handleClientError(socket, packet, enabled) {
  if (socket.destroyed || socket.writableEnded) return;
  const bounded = packet?.subarray(0, 8192).toString("latin1") ?? "";
  const requestTarget = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+ ([^ \t\r\n]{1,8192})(?:[ \t]|$)/u.exec(bounded)?.[1];
  const adapterPacket = requestTarget !== undefined && isAdapterTarget(requestTarget);
  if (!adapterPacket) {
    socket.end(generic400);
    return;
  }
  socket.end(enabled
    ? fixedProblem(400, "urn:gauntlet:problem:invalid-path", "Invalid path")
    : fixedProblem(503, "urn:gauntlet:problem:adapter-disabled", "Adapter disabled"));
}
server.on("clientError", (error, socket) => {
  handleClientError(socket, error.rawPacket, enabled);
});
server.on("connect", (incoming, socket) => {
  handleExceptionalSocket(incoming, socket, enabled, 405, "urn:gauntlet:problem:unsupported-method", "Unsupported method");
});
server.on("upgrade", (incoming, socket) => {
  handleExceptionalSocket(incoming, socket, enabled, 405, "urn:gauntlet:problem:unsupported-method", "Unsupported method");
});
server.on("checkExpectation", (incoming, outgoing) => {
  handleExceptionalResponse(incoming, outgoing, enabled, 417, "urn:gauntlet:problem:expectation-failed", "Expectation failed");
});

server.listen(Number(process.env.PORT ?? 8080), process.env.HOST ?? "127.0.0.1", () => {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("listener address unavailable");
  process.stdout.write(`${JSON.stringify({
    scope: "synthetic-ephemeral-loopback-http",
    customerDeploymentVerified: false,
    address: address.address,
    port: address.port,
  })}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
