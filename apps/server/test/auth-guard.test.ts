import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { apiToken, passwordAuth, sessionToken } from "./support/auth.js";
import { serverEnvironment } from "./support/environment.js";
import { createFakeAdapter, createHappyOperation, fakeTarget, validCreateRunRequest } from "./support/fake-adapter.js";

async function usingApp<T>(
  auth: ReturnType<typeof passwordAuth> | undefined,
  action: (app: Awaited<ReturnType<typeof createApp>>, fake: ReturnType<typeof createFakeAdapter>) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "gauntlet-auth-guard-"));
  await writeFile(join(dir, "index.html"), "<!doctype html><title>Gauntlet</title>");
  await writeFile(join(dir, "loader.js"), "void 0;");
  const fake = createFakeAdapter();
  const app = await createApp({
    environment: serverEnvironment,
    targets: [{ ...fakeTarget, widget: { origins: ["http://shop.test"] } }],
    fetch: fake.fetch,
    dashboardDir: dir,
    widget: { enabled: true, dir },
    mcp: { enabled: true },
    ...(auth === undefined ? {} : { auth }),
  });
  try {
    return await action(app, fake);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const runsUrl = `/api/v1/targets/${fakeTarget.id}/operations/${createHappyOperation().id}/runs`;
const mcpInitialize = {
  method: "POST" as const,
  url: "/mcp",
  headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
  payload: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
};

test("public paths stay reachable without credentials", async () => {
  await usingApp(passwordAuth(), async (app) => {
    for (const url of ["/health", "/ready", "/", "/t/shop", "/widget/", "/widget/config.json", "/widget/loader.js"]) {
      const response = await app.inject({ method: "GET", url, headers: { accept: "text/html" } });
      assert.notEqual(response.statusCode, 401, url);
    }
  });
});

test("the API and MCP need credentials when authentication is on", async () => {
  await usingApp(passwordAuth(), async (app) => {
    for (const url of ["/api/v1/targets", `/api/v1/targets/${fakeTarget.id}/runs/run-1`, "/api/v2/anything", "/api"]) {
      const response = await app.inject({ method: "GET", url });
      assert.equal(response.statusCode, 401, url);
      assert.equal(response.json().type, "urn:gauntlet:problem:unauthenticated");
      assert.equal(response.json().title, "Authentication required");
      assert.equal(response.headers["www-authenticate"], "Bearer");
    }
    const mcp = await app.inject(mcpInitialize);
    assert.equal(mcp.statusCode, 401);
    assert.equal(mcp.headers["www-authenticate"], "Bearer");
    assert.deepEqual(mcp.json(), { jsonrpc: "2.0", error: { code: -32001, message: "Authentication required" } });
  });
});

test("a session, cookie or API token unlocks the API and MCP", async () => {
  const auth = passwordAuth();
  const token = await sessionToken(auth);
  await usingApp(auth, async (app) => {
    for (const headers of [
      { authorization: `Bearer ${token}` },
      { cookie: `gauntlet_session=${token}` },
      { authorization: `Bearer ${apiToken.token}` },
    ]) {
      assert.equal((await app.inject({ method: "GET", url: "/api/v1/targets", headers })).statusCode, 200, JSON.stringify(headers));
    }
    const mcp = await app.inject({ ...mcpInitialize, headers: { ...mcpInitialize.headers, authorization: `Bearer ${apiToken.token}` } });
    assert.equal(mcp.statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/targets", headers: { authorization: "Bearer nope" } })).statusCode, 401);
  });
});

test("cookie-authenticated mutations must come from the Gauntlet origin", async () => {
  const auth = passwordAuth();
  const token = await sessionToken(auth);
  await usingApp(auth, async (app) => {
    const create = (headers: Record<string, string>) => app.inject({ method: "POST", url: runsUrl, headers, payload: validCreateRunRequest });
    for (const origin of [undefined, "http://evil.test", "http://gauntlet.test.evil.test", "null"]) {
      const response = await create({ cookie: `gauntlet_session=${token}`, ...(origin === undefined ? {} : { origin }) });
      assert.equal(response.statusCode, 403, String(origin));
      assert.equal(response.json().type, "urn:gauntlet:problem:cross-site-request");
    }
    assert.notEqual((await create({ cookie: `gauntlet_session=${token}`, origin: "http://gauntlet.test" })).statusCode, 403);
    assert.notEqual((await create({ authorization: `Bearer ${token}`, origin: "http://evil.test" })).statusCode, 403);
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/targets", headers: { cookie: `gauntlet_session=${token}`, origin: "http://evil.test" } })).statusCode, 200);
  });
});

test("runs record the signed-in user as their actor over REST and MCP", async () => {
  const auth = passwordAuth({ variant: "users" });
  const token = await sessionToken(auth, "anna");
  await usingApp(auth, async (app, fake) => {
    const created = await app.inject({ method: "POST", url: runsUrl, headers: { authorization: `Bearer ${token}` }, payload: validCreateRunRequest });
    assert.ok(created.statusCode < 300, created.body);
    const forwarded = fake.calls.filter((call) => call.method === "POST" && call.pathname.endsWith("/runs"));
    assert.deepEqual((forwarded.at(-1)?.body as { context: { actor: unknown } }).context.actor, { id: "user:anna", displayName: "anna" });

    const headers = { ...mcpInitialize.headers, authorization: `Bearer ${apiToken.token}` };
    const call = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { ...headers, "mcp-protocol-version": "2025-06-18" },
      payload: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "gauntlet_create_run", arguments: { targetId: fakeTarget.id, operationId: createHappyOperation().id, request: validCreateRunRequest } },
      },
    });
    assert.equal(call.statusCode, 200, call.body);
    const viaMcp = fake.calls.filter((entry) => entry.method === "POST" && entry.pathname.endsWith("/runs"));
    assert.equal(viaMcp.length, 2, call.body);
    assert.deepEqual((viaMcp.at(-1)?.body as { context: { actor: unknown } }).context.actor, { id: "token:ci-nightly", displayName: "ci-nightly" });
  });
});

test("without authentication nothing changes", async () => {
  await usingApp(undefined, async (app, fake) => {
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/targets" })).statusCode, 200);
    const created = await app.inject({ method: "POST", url: runsUrl, payload: validCreateRunRequest });
    assert.ok(created.statusCode < 300);
    const forwarded = fake.calls.filter((call) => call.method === "POST" && call.pathname.endsWith("/runs"));
    assert.deepEqual((forwarded.at(-1)?.body as { context: unknown }).context, validCreateRunRequest.context);
  });
});

async function rawRequest(port: number, request: string): Promise<string> {
  const { connect } = await import("node:net");
  return await new Promise<string>((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    socket.setTimeout(2_000, () => socket.destroy(new Error("raw HTTP request timed out")));
    socket.on("connect", () => socket.end(request));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.on("error", reject);
  });
}

test("an absolute-form request target cannot slip past the guard", async () => {
  await usingApp(passwordAuth(), async (app) => {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    assert.ok(address !== null && typeof address === "object");
    for (const target of ["http://gauntlet.test/api/v1/targets", "https://x/api/v1/targets", "http://x/mcp", "*"]) {
      const response = await rawRequest(address.port, `GET ${target} HTTP/1.1\r\nHost: gauntlet.test\r\nConnection: close\r\n\r\n`);
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(response)?.[1]);
      assert.ok(status === 400 || status === 401, `${target}: ${response.split("\r\n")[0]}`);
      assert.equal(response.includes("\"targets\""), false, target);
    }
  });
});
