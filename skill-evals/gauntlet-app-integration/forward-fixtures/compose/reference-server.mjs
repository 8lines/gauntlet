import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { assertNonProductionEnvironment } from "@8lines/gauntlet-protocol";
import {
  AjvSchemaValidator, CapabilityRegistry, DataSourceRegistry, InMemoryRunStore,
  OperationRegistry, RunManager, createAdapterCatalog, defineOperation,
} from "@8lines/gauntlet-typescript-core";
import { createAdapterFetchHandler, isAdapterTarget } from "@8lines/gauntlet-typescript-node";

const prefix = "/_gauntlet/v1";
const environment = assertNonProductionEnvironment({
  name: process.env.GAUNTLET_ENVIRONMENT_NAME,
  kind: process.env.GAUNTLET_ENVIRONMENT_KIND,
});
const secretPath = process.env.GAUNTLET_IDEMPOTENCY_SECRET_FILE;
if (typeof secretPath !== "string" || secretPath.length === 0) throw new Error("secret-file reference required");
const idempotencySecret = readFileSync(secretPath);
if (idempotencySecret.byteLength < 32) throw new Error("stable idempotency secret must contain 32 bytes");
const application = {
  id: process.env.GAUNTLET_APPLICATION_ID,
  label: process.env.GAUNTLET_APPLICATION_LABEL,
  environment,
};
if (typeof application.id !== "string" || typeof application.label !== "string") throw new Error("application metadata required");

const operations = new OperationRegistry();
operations.registerFeature({ id: "fixture", label: "Fixture", order: 0 });
let operationRuns = 0;
let lastOperationInput = null;
let dataSourceQueries = 0;
let dataSourceResolves = 0;
let lastDataSourceQuery = null;
let lastDataSourceResolve = null;
operations.register(defineOperation({
  id: "fixture.safe", featureId: "fixture", label: "Synthetic safe operation", order: 0, tags: [],
  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema", type: "object",
    required: ["value"], properties: { value: { type: "string", minLength: 1 } }, additionalProperties: false,
  },
  dataSources: [], presets: [],
  execution: {
    impact: "write", confirmationRequired: true, dryRunSupported: true,
    idempotency: "required", cancellationSupported: false,
  },
  output: { schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema", type: "object",
    required: ["accepted"], properties: { accepted: { type: "boolean" } }, additionalProperties: false,
  } },
}, async (input) => {
  operationRuns += 1;
  lastOperationInput = input;
  return { summary: { title: "Synthetic run completed", tone: "success" }, output: { accepted: true } };
}));

const dataSources = new DataSourceRegistry();
dataSources.register({
  definition: {
    id: "fixture.items", label: "Synthetic items",
    capabilities: { search: true, pagination: "cursor", resolve: true, defaultLimit: 10, maxLimit: 25 },
  },
  query: (input) => {
    dataSourceQueries += 1;
    lastDataSourceQuery = input;
    return { items: [{ value: "item-1", label: "Synthetic item" }] };
  },
  resolve: (input) => {
    dataSourceResolves += 1;
    lastDataSourceResolve = input;
    return { results: input.values.map((value) => ({
      value, item: value === "item-1" ? { value, label: "Synthetic item" } : null,
    })) };
  },
});

const schemaValidator = new AjvSchemaValidator();
const runs = new RunManager(operations, new InMemoryRunStore(), {
  validateSchema: ({ schema, value }) => schemaValidator.validate(schema, value),
  validateFileReference: () => [],
  idempotencySecret,
});
const catalog = createAdapterCatalog({
  application, profiles: ["tc-schema-core@1", "tc-rich-forms@1", "tc-rich-results@1"],
  capabilities: new CapabilityRegistry(), operations, dataSources, runs, schemaValidator,
});
const enabled = process.env.GAUNTLET_ENABLED === "true";
const adapter = createAdapterFetchHandler({ enabled, catalog, schemaValidator });

async function sendWebResponse(response, outgoing, method) {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body === null || method === "HEAD") return outgoing.end();
  await pipeline(Readable.fromWeb(response.body), outgoing);
}

const server = createServer(async (incoming, outgoing) => {
  try {
    const rawTarget = incoming.url;
    if (typeof rawTarget !== "string") return outgoing.writeHead(400, { "content-length": "0" }).end();
    if (["CONNECT", "TRACE", "TRACK"].includes(incoming.method ?? "")) {
      return handleExceptionalResponse(incoming, outgoing, enabled, 405, "urn:gauntlet:problem:unsupported-method", "Unsupported method");
    }
    const requestTarget = rawTarget.startsWith("/") ? rawTarget : "/";
    const request = new Request(`http://adapter${requestTarget}`, {
      method: incoming.method, headers: incoming.headers,
      body: ["GET", "HEAD"].includes(incoming.method ?? "") ? undefined : incoming, duplex: "half",
    });
    const response = await adapter({ kind: "raw", request, rawTarget });
    const canonicalMount = rawTarget === prefix || rawTarget.startsWith(`${prefix}/`);
    if (!canonicalMount && rawTarget.startsWith("/") && response.status === 404) {
      await response.body?.cancel();
      if (incoming.method === "GET" && rawTarget === "/__fixture/counters") {
        outgoing.writeHead(200, { "content-type": "application/json" });
        return outgoing.end(`${JSON.stringify({
          operationRuns, lastOperationInput, dataSourceQueries, dataSourceResolves, lastDataSourceQuery, lastDataSourceResolve,
        })}\n`);
      }
      return outgoing.writeHead(404, { "content-type": "text/plain" }).end("Not Found\n");
    }
    await sendWebResponse(response, outgoing, incoming.method);
  } catch {
    if (!outgoing.headersSent) outgoing.writeHead(500, { "content-length": "0" });
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
  if (!adapterPacket) return socket.end(generic400);
  socket.end(enabled
    ? fixedProblem(400, "urn:gauntlet:problem:invalid-path", "Invalid path")
    : fixedProblem(503, "urn:gauntlet:problem:adapter-disabled", "Adapter disabled"));
}
server.on("clientError", (error, socket) => handleClientError(socket, error.rawPacket, enabled));
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
  if (address === null || typeof address === "string") throw new Error("listener unavailable");
  process.stdout.write(`${JSON.stringify({ ready: true, port: address.port })}\n`);
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
