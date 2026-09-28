import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { computeRevision, PAGE_PLACEMENTS_PROFILE, type AdapterManifest, type JsonObject } from "@8lines/gauntlet-protocol";
import { createApp, type CreateAppOptions } from "../src/app.js";
import { mcpConfiguration } from "../src/main.js";
import {
  createFakeAdapter, createHappyManifest, createHappyOperation, createManifestWithEnvironment,
  fakeTarget, validCreateRunRequest,
} from "./support/fake-adapter.js";
import { serverEnvironment } from "./support/environment.js";

function manifestWithPlacements(): AdapterManifest {
  const manifest = createHappyManifest();
  const mutable = manifest as unknown as JsonObject & {
    manifestRevision: string;
    profiles: string[];
    operations: Array<Record<string, unknown>>;
  };
  const [operation] = mutable.operations;
  mutable.profiles = [...mutable.profiles, PAGE_PLACEMENTS_PROFILE];
  mutable.operations = [
    { ...operation, id: "operation-placed", placements: [{ kind: "subject", subjectType: "order" }] },
    { ...operation, id: "operation-unplaced" },
  ];
  mutable.manifestRevision = computeRevision(mutable, "manifestRevision");
  return manifest;
}

async function setup(t: TestContext,
  fake = createFakeAdapter(), options: Partial<CreateAppOptions> = {}, mode: "legacy" | "auto" = "legacy") {
  const app = await createApp({
    environment: serverEnvironment, targets: [fakeTarget], fetch: fake.fetch,
    mcp: { enabled: true }, clock: () => new Date("2026-08-29T12:00:00Z"), ...options,
  });
  t.after(() => app.close());
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = new Client({ name: "gauntlet-integration-test", version: "1.0.0" }, { versionNegotiation: { mode } });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp`)));
  if (mode === "auto") assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
  else assert.match(client.getNegotiatedProtocolVersion()!, /^2025-/);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await client.callTool({ name: `gauntlet_${name}`, arguments: args });
    const structured = response.structuredContent as { data: any };
    assert.ok(structured, JSON.stringify(response));
    assert.deepEqual(JSON.parse((response.content[0] as { text: string }).text), structured);
    return { error: response.isError === true, data: structured.data };
  };
  return { app, fake, client, call, address };
}

const operationArgs = { targetId: fakeTarget.id, operationId: createHappyOperation().id };
const runArgs = { targetId: fakeTarget.id, runId: "run-1" };

for (const mode of ["legacy", "auto"] as const) {
  test(`MCP ${mode} client discovers tools and executes, polls and cancels through shared services`, async (t) => {
    const { app, client, call, fake } = await setup(t, undefined, {}, mode);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 9);
    assert.equal(fake.calls.length, 0, "listing tools must not probe applications");
    assert.equal(tools.tools.find(({ name }) => name === "gauntlet_create_run")?.annotations?.destructiveHint, true);
    const targets = await call("list_targets");
    assert.equal(targets.data.targets[0].state, "online");
    assert.equal(JSON.stringify(targets).includes("acme.internal"), false);
    const definition = await call("get_operation", operationArgs);
    assert.equal(definition.data.revision, validCreateRunRequest.operationRevision);
    const created = await call("create_run", { ...operationArgs, request: validCreateRunRequest });
    assert.equal(created.error, false);
    assert.equal(created.data.state, "queued");
    assert.deepEqual(fake.calls.find(({ method, pathname }) => method === "POST" && pathname.endsWith("/runs"))?.body, validCreateRunRequest);
    assert.equal((await call("get_run", runArgs)).data.id, "run-1");
    const restRun = await app.inject({ method: "GET", url: "/api/v1/targets/acme/runs/run-1" });
    assert.equal(restRun.statusCode, 200, "MCP and REST must share projections");
    const cancelled = await call("cancel_run", runArgs);
    assert.equal(cancelled.error, false);
    assert.equal(cancelled.data.state, "cancelled");
  });
}

test("MCP reads runs created by the dashboard, queries data sources, uploads and launches sessions", async (t) => {
  const { app, call, fake } = await setup(t);
  const response = await app.inject({ method: "POST", url: `/api/v1/targets/acme/operations/${operationArgs.operationId}/runs`, payload: validCreateRunRequest });
  assert.equal(response.statusCode, 202);
  assert.equal((await call("get_run", runArgs)).data.id, "run-1");
  const query = await call("query_data_source", { targetId: "acme", dataSourceId: "application-catalog", request: { search: "abc", limit: 10 } });
  assert.equal(query.error, false);
  assert.ok(Array.isArray(query.data.items));
  const resolved = await call("resolve_data_source", { targetId: "acme", dataSourceId: "application-catalog", request: { values: ["app-42", "missing-app"] } });
  assert.equal(resolved.error, false);
  assert.ok(Array.isArray(resolved.data.results));
  const upload = await call("create_upload", { targetId: "acme", name: "fixture.txt", mediaType: "text/plain", base64: Buffer.from("fixture").toString("base64") });
  assert.equal(upload.error, false);
  assert.equal(upload.data.file.uploadId, "upload-1");
  const form = fake.calls.find(({ pathname }) => pathname.endsWith("/uploads"))?.body as FormData;
  assert.equal(await (form.get("file") as Blob).text(), "fixture");
  const launch = await call("create_session_launch", { ...runArgs, artifactId: "launch-1" });
  assert.equal(launch.error, false);
  assert.equal(launch.data.singleUse, true);
  assert.ok(launch.data.url.startsWith("https://app.example.test/"));
});

test("MCP preserves confirmation and stale revision checks without invoking the adapter", async (t) => {
  const { call, fake } = await setup(t);
  const { confirmation: _confirmation, ...unconfirmed } = validCreateRunRequest;
  const requests = [
    unconfirmed,
    { ...validCreateRunRequest, operationRevision: `sha256:${"0".repeat(64)}` },
    { ...validCreateRunRequest, confirmation: { ...validCreateRunRequest.confirmation, impact: "read" } },
    { ...validCreateRunRequest, context: { requestId: "request-1", target: { id: "another-target" } } },
  ];
  for (const request of requests) {
    const response = await call("create_run", { ...operationArgs, request });
    assert.equal(response.error, true);
    assert.ok([409, 422].includes(response.data.problem.status));
  }
  assert.equal(fake.calls.some(({ method }) => method === "POST"), false);
});

test("MCP rejects invalid arguments, unknown tools and IDs without upstream requests", async (t) => {
  const { client, call, fake } = await setup(t);
  for (const args of [{ ...operationArgs, targetId: "../escape" }, { ...operationArgs, url: "http://attacker.invalid" }]) {
    const response = await client.callTool({ name: "gauntlet_get_operation", arguments: args });
    assert.equal(response.isError, true);
  }
  await assert.rejects(client.callTool({ name: "arbitrary_sql", arguments: {} }), /not found/);
  assert.equal((await call("get_operation", { ...operationArgs, targetId: "unknown" })).data.problem.status, 404);
  assert.equal(fake.calls.length, 0);
});

test("MCP blocks undeclared operations, data sources, and unknown runs", async (t) => {
  const { call, fake } = await setup(t);
  for (const [tool, args] of [
    ["get_operation", { ...operationArgs, operationId: "unregistered" }],
    ["query_data_source", { targetId: "acme", dataSourceId: "unregistered", request: {} }],
    ["get_run", runArgs],
  ] as const) {
    const response = await call(tool, args);
    assert.equal(response.error, true);
    assert.equal(response.data.problem.status, 404);
  }
  assert.equal(fake.calls.every(({ pathname }) => /\/(health|manifest)$/.test(pathname)), true);
});

test("MCP isolates environment mismatch and unsupported capabilities", async (t) => {
  const mismatch = createFakeAdapter({ manifest: createManifestWithEnvironment({ name: "other-staging", kind: "staging" }) });
  const first = await setup(t, mismatch);
  assert.equal((await first.call("create_run", { ...operationArgs, request: validCreateRunRequest })).data.problem.type, "urn:gauntlet:problem:target-environment-mismatch");
  assert.equal(mismatch.calls.some(({ method }) => method === "POST"), false);
  const second = await setup(t, createFakeAdapter(), { supportedCapabilities: [] });
  const cancelled = await second.call("cancel_run", runArgs);
  assert.equal(cancelled.error, true);
  assert.equal(cancelled.data.problem.type, "urn:gauntlet:problem:unsupported-capability");
});

test("MCP list_targets filters operations by subjectType placement", async (t) => {
  const fake = createFakeAdapter({ manifest: manifestWithPlacements() });
  const { call } = await setup(t, fake);
  const all = await call("list_targets");
  assert.equal(all.data.targets[0].manifest.operations.length, 2);
  const filtered = await call("list_targets", { subjectType: "order" });
  assert.deepEqual(filtered.data.targets[0].manifest.operations.map(({ id }: { id: string }) => id), ["operation-placed"]);
  const none = await call("list_targets", { subjectType: "invoice" });
  assert.equal(none.data.targets.length, all.data.targets.length);
  assert.deepEqual(none.data.targets[0].manifest.operations, []);
});

test("MCP sanitizes upstream errors and rejects malformed upload bytes", async (t) => {
  const secret = "private-token-at-http://internal.invalid";
  const fake = createFakeAdapter({ responseFor: ({ pathname }) => pathname.endsWith("/query")
    ? Response.json({ type: "urn:gauntlet:problem:handler-failed", title: secret, detail: secret, status: 500 }, { status: 500, headers: { "content-type": "application/problem+json" } })
    : undefined });
  const { call } = await setup(t, fake);
  const response = await call("query_data_source", { targetId: "acme", dataSourceId: "application-catalog", request: {} });
  assert.equal(response.error, true);
  assert.equal(JSON.stringify(response).includes(secret), false);
  const upload = await call("create_upload", { targetId: "acme", name: "fixture.txt", mediaType: "text/plain", base64: "not base64!" });
  assert.equal(upload.error, true);
  assert.equal(fake.calls.some(({ pathname }) => pathname.endsWith("/uploads")), false);
});

test("MCP HTTP transport enforces opt-in, origins, bounded bodies and protocol framing", async (t) => {
  const disabled = await createApp({ environment: serverEnvironment, targets: [] });
  t.after(() => disabled.close());
  assert.equal((await disabled.inject({ method: "GET", url: "/mcp", headers: { accept: "text/html" } })).statusCode, 404);
  const { app, address, fake } = await setup(t, undefined, { bodyLimit: 2048, mcp: { enabled: true, allowedOrigins: ["https://trusted.example"] } });
  for (const method of ["GET", "POST", "DELETE", "OPTIONS"] as const) {
    const denied = await app.inject({ method, url: "/mcp", headers: { origin: "https://evil.example" } });
    assert.equal(denied.statusCode, 403);
  }
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", origin: "https://trusted.example" };
  const allowed = await fetch(`${address}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal(allowed.status, 200);
  await allowed.text();
  assert.equal((await app.inject({ method: "GET", url: "/mcp" })).statusCode, 405);
  assert.equal((await app.inject({ method: "DELETE", url: "/mcp" })).statusCode, 405);
  const large = await app.inject({ method: "POST", url: "/mcp", headers, payload: { padding: "x".repeat(3000) } });
  assert.equal(large.statusCode, 413);
  const malformed = await app.inject({ method: "POST", url: "/mcp", headers, payload: "{" });
  assert.equal(malformed.statusCode, 400);
  assert.equal(fake.calls.length, 0);
});

test("MCP environment settings fail closed and do not echo configuration values", () => {
  assert.deepEqual(mcpConfiguration({}), { enabled: false, allowedOrigins: [] });
  assert.deepEqual(mcpConfiguration({ GAUNTLET_MCP_ENABLED: "true" }), { enabled: true, allowedOrigins: [] });
  for (const environment of [
    { GAUNTLET_MCP_ENABLED: "yes" },
    { GAUNTLET_MCP_ALLOWED_ORIGINS_JSON: "private-invalid-json" },
    { GAUNTLET_MCP_ALLOWED_ORIGINS_JSON: '["*"]' },
    { GAUNTLET_MCP_ALLOWED_ORIGINS_JSON: '["https://user:secret@example.test"]' },
    { GAUNTLET_MCP_ALLOWED_ORIGINS_JSON: '["https://example.test/path"]' },
    { GAUNTLET_MCP_ALLOWED_ORIGINS_JSON: '{}' },
    { GAUNTLET_MCP_ALLOWED_ORIGINS_JSON: 'null' },
  ]) assert.throws(() => mcpConfiguration(environment), /Invalid MCP configuration/);
  let accessed = false;
  const hostile = Object.defineProperty({}, "GAUNTLET_MCP_ENABLED", { enumerable: true, get() { accessed = true; return "true"; } });
  assert.throws(() => mcpConfiguration(hostile), /Invalid server environment configuration/);
  assert.equal(accessed, false);
});
