import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { createApp, type AuthOptions } from "../src/app.js";
import { authConfiguration } from "../src/auth/config.js";
import { hashPassword } from "../src/auth/passwords.js";
import { registerPinRoutes } from "../src/pin-routes.js";
import { PIN_LIMIT, type PinStore } from "../src/pin-store.js";
import { configureProblemResponses } from "../src/problem-response.js";
import { createTargetRegistry } from "../src/target-registry.js";
import { createStaticTargetProvider } from "../src/static-target-provider.js";
import { apiToken, authSecret, passwordAuth, passwords, sessionToken } from "./support/auth.js";
import { serverEnvironment } from "./support/environment.js";
import { createFakeAdapter, fakeTarget } from "./support/fake-adapter.js";

type App = Awaited<ReturnType<typeof createApp>>;
type Headers = Record<string, string>;

const secondTarget = Object.freeze({ ...fakeTarget, id: "billing", label: "Billing", adapterUrl: "http://billing.internal" });
const benPassword = "ben-password";
const twoUsers: AuthOptions = {
  configuration: authConfiguration({
    mode: "password",
    publicUrl: "http://gauntlet.test",
    password: {
      users: [
        { username: "anna", hash: await hashPassword(passwords.anna) },
        { username: "ben", hash: await hashPassword(benPassword) },
      ],
    },
  }),
  secret: authSecret,
};

const start = Date.now();
let tick = 0;
/** Each reading is one second after the previous one, so pin order is observable; sessions stay valid. */
const clock = (): Date => new Date(start + 1_000 * tick++);

async function usingApp<T>(auth: AuthOptions | undefined, action: (app: App) => Promise<T>): Promise<T> {
  const fake = createFakeAdapter();
  const app = await createApp({
    environment: serverEnvironment,
    targets: [fakeTarget, secondTarget],
    fetch: fake.fetch,
    clock,
    ...(auth === undefined ? {} : { auth }),
  });
  try {
    const result = await action(app);
    assert.equal(fake.calls.length, 0, "pins never ask the adapter");
    return result;
  } finally {
    await app.close();
  }
}

async function login(app: App, username: string, password: string): Promise<Headers> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username, password, surface: "dashboard" },
  });
  assert.equal(response.statusCode, 200, response.body);
  return { authorization: `Bearer ${response.json().token as string}` };
}

const pinsUrl = (targetId: string, operationId?: string): string =>
  `/api/v1/targets/${targetId}/pins${operationId === undefined ? "" : `/${operationId}`}`;

async function listPins(app: App, headers: Headers = {}, targetId = "acme"): Promise<string[]> {
  const response = await app.inject({ method: "GET", url: pinsUrl(targetId), headers });
  assert.equal(response.statusCode, 200, response.body);
  return (response.json() as { pins: Array<{ operationId: string }> }).pins.map(({ operationId }) => operationId);
}

async function pin(app: App, operationId: string, headers: Headers = {}, targetId = "acme") {
  return await app.inject({ method: "PUT", url: pinsUrl(targetId, operationId), headers });
}

async function unpin(app: App, operationId: string, headers: Headers = {}, targetId = "acme") {
  return await app.inject({ method: "DELETE", url: pinsUrl(targetId, operationId), headers });
}

function assertProblem(
  response: Awaited<ReturnType<App["inject"]>>,
  status: number,
  type: string,
  title?: string,
): void {
  assert.equal(response.statusCode, status, response.body);
  assert.match(String(response.headers["content-type"]), /^application\/problem\+json/);
  assert.equal(response.json().type, type);
  if (title !== undefined) assert.equal(response.json().title, title);
}

test("pins are listed oldest first, pinning and unpinning are idempotent and return 204", async () => {
  await usingApp(undefined, async (app) => {
    assert.deepEqual((await app.inject({ method: "GET", url: pinsUrl("acme") })).json(), { pins: [] });
    const first = await pin(app, "reset-password");
    assert.equal(first.statusCode, 204);
    assert.equal(first.body, "");
    assert.equal((await pin(app, "seed-orders")).statusCode, 204);
    assert.equal((await pin(app, "reset-password")).statusCode, 204);

    const listed = await app.inject({ method: "GET", url: pinsUrl("acme") });
    assert.equal(listed.statusCode, 200);
    assert.match(String(listed.headers["content-type"]), /^application\/json/);
    const pins = listed.json().pins as Array<{ operationId: string; pinnedAt: string }>;
    assert.deepEqual(pins.map(({ operationId }) => operationId), ["reset-password", "seed-orders"]);
    assert.deepEqual(Object.keys(pins[0]!).sort(), ["operationId", "pinnedAt"]);
    assert.ok(Date.parse(pins[0]!.pinnedAt) < Date.parse(pins[1]!.pinnedAt));

    assert.equal((await unpin(app, "reset-password")).statusCode, 204);
    assert.equal((await unpin(app, "reset-password")).statusCode, 204);
    assert.equal((await unpin(app, "never-pinned")).statusCode, 204);
    assert.deepEqual(await listPins(app), ["seed-orders"]);
    assert.deepEqual(await listPins(app, {}, "billing"), []);
  });
});

test("with authentication disabled everyone shares the anonymous pins", async () => {
  await usingApp(undefined, async (app) => {
    assert.equal((await pin(app, "reset-password")).statusCode, 204);
    assert.deepEqual(await listPins(app, { authorization: "Bearer ignored" }), ["reset-password"]);
    assert.deepEqual(await listPins(app, { cookie: "gauntlet_session=ignored" }), ["reset-password"]);
  });
});

test("two users see only their own pins, on each target separately", async () => {
  await usingApp(twoUsers, async (app) => {
    const anna = await login(app, "anna", passwords.anna);
    const ben = await login(app, "ben", benPassword);
    assert.equal((await pin(app, "reset-password", anna)).statusCode, 204);
    assert.equal((await pin(app, "seed-orders", ben)).statusCode, 204);
    assert.equal((await pin(app, "seed-orders", anna, "billing")).statusCode, 204);

    assert.deepEqual(await listPins(app, anna), ["reset-password"]);
    assert.deepEqual(await listPins(app, ben), ["seed-orders"]);
    assert.deepEqual(await listPins(app, anna, "billing"), ["seed-orders"]);
    assert.deepEqual(await listPins(app, ben, "billing"), []);

    assert.equal((await unpin(app, "seed-orders", anna)).statusCode, 204);
    assert.deepEqual(await listPins(app, ben), ["seed-orders"]);
  });
});

test("everyone signed in with the shared password shares pins, API tokens have their own", async () => {
  const auth = passwordAuth();
  await usingApp(auth, async (app) => {
    const first = { authorization: `Bearer ${await sessionToken(auth)}` };
    const signedIn = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { password: passwords.shared, surface: "widget" },
    });
    assert.equal(signedIn.statusCode, 200, signedIn.body);
    const second = { authorization: `Bearer ${signedIn.json().token as string}` };
    const token = { authorization: `Bearer ${apiToken.token}` };

    assert.equal((await pin(app, "reset-password", first)).statusCode, 204);
    assert.deepEqual(await listPins(app, second), ["reset-password"]);
    assert.deepEqual(await listPins(app, token), []);
    assert.equal((await pin(app, "seed-orders", token)).statusCode, 204);
    assert.deepEqual(await listPins(app, first), ["reset-password"]);
    assert.deepEqual(await listPins(app, token), ["seed-orders"]);
  });
});

test("unauthenticated requests are rejected when authentication is enabled", async () => {
  await usingApp(passwordAuth(), async (app) => {
    for (const method of ["GET", "PUT", "DELETE"] as const) {
      const url = method === "GET" ? pinsUrl("acme") : pinsUrl("acme", "reset-password");
      const response = await app.inject({ method, url });
      assertProblem(response, 401, "urn:gauntlet:problem:unauthenticated");
      assert.equal(response.headers["www-authenticate"], "Bearer");
      const invalid = await app.inject({ method, url, headers: { authorization: "Bearer g1.s.forged" } });
      assertProblem(invalid, 401, "urn:gauntlet:problem:unauthenticated");
    }
  });
});

test("a cookie may only pin or unpin from Gauntlet's own origin", async () => {
  const auth = passwordAuth();
  await usingApp(auth, async (app) => {
    const cookie = `gauntlet_session=${await sessionToken(auth)}`;
    for (const request of [
      { method: "PUT" as const, headers: { cookie } },
      { method: "PUT" as const, headers: { cookie, origin: "http://evil.test" } },
      { method: "DELETE" as const, headers: { cookie, origin: "http://evil.test" } },
    ]) {
      const response = await app.inject({ ...request, url: pinsUrl("acme", "reset-password") });
      assertProblem(response, 403, "urn:gauntlet:problem:cross-site-request");
    }
    assert.deepEqual(await listPins(app, { cookie }), []);
    const own = { cookie, origin: "http://gauntlet.test" };
    assert.equal((await pin(app, "reset-password", own)).statusCode, 204);
    assert.deepEqual(await listPins(app, { cookie }), ["reset-password"]);
    assert.equal((await unpin(app, "reset-password", own)).statusCode, 204);
    assert.deepEqual(await listPins(app, { cookie }), []);
  });
});

test("invalid path ids get the invalid-path problem", async () => {
  await usingApp(undefined, async (app) => {
    for (const [method, url] of [
      ["GET", pinsUrl("-acme")],
      ["GET", pinsUrl("ac~me")],
      ["PUT", pinsUrl("acme", "-reset")],
      ["PUT", pinsUrl("ac!me", "reset-password")],
      ["DELETE", pinsUrl("acme", "reset~password")],
      ["DELETE", pinsUrl("acme", "reset%20password")],
    ] as const) {
      assertProblem(await app.inject({ method, url }), 400, "urn:gauntlet:problem:invalid-path", "Invalid path");
    }
    assert.deepEqual(await listPins(app), []);
  });
});

test("an unknown target gets the target-not-found problem", async () => {
  await usingApp(undefined, async (app) => {
    for (const [method, url] of [
      ["GET", pinsUrl("unknown")],
      ["PUT", pinsUrl("unknown", "reset-password")],
      ["DELETE", pinsUrl("unknown", "reset-password")],
    ] as const) {
      assertProblem(await app.inject({ method, url }), 404, "urn:gauntlet:problem:target-not-found", "Target not found");
    }
  });
});

test("unsupported methods on the pin routes get 405 with an Allow header", async () => {
  await usingApp(undefined, async (app) => {
    const collection = await app.inject({ method: "POST", url: pinsUrl("acme") });
    assertProblem(collection, 405, "urn:gauntlet:problem:method-not-allowed");
    assert.equal(collection.headers.allow, "GET");
    const item = await app.inject({ method: "GET", url: pinsUrl("acme", "reset-password") });
    assertProblem(item, 405, "urn:gauntlet:problem:method-not-allowed");
    assert.equal(item.headers.allow, "PUT, DELETE");
  });
});

test("the 101st pin gets the pin-limit problem", async () => {
  await usingApp(undefined, async (app) => {
    for (let index = 0; index < PIN_LIMIT; index += 1) {
      assert.equal((await pin(app, `operation-${index}`)).statusCode, 204);
    }
    assertProblem(await pin(app, "one-too-many"), 409, "urn:gauntlet:problem:pin-limit", "Too many pinned operations");
    assert.equal((await pin(app, "operation-0")).statusCode, 204);
    assert.equal((await pin(app, "one-too-many", {}, "billing")).statusCode, 204);
    assert.equal((await listPins(app)).length, PIN_LIMIT);
  });
});

test("a database error gets the pins-unavailable problem without details", async () => {
  const failing: PinStore = {
    list: () => { throw new Error("SQLITE_IOERR /private/data/gauntlet.sqlite"); },
    pin: () => { throw new Error("SQLITE_FULL /private/data/gauntlet.sqlite"); },
    unpin: () => { throw new Error("SQLITE_READONLY /private/data/gauntlet.sqlite"); },
  };
  const app = Fastify({ logger: false });
  configureProblemResponses(app);
  registerPinRoutes(app, {
    pins: failing,
    registry: createTargetRegistry([createStaticTargetProvider([fakeTarget])]),
    clock,
  });
  try {
    for (const [method, url] of [
      ["GET", pinsUrl("acme")],
      ["PUT", pinsUrl("acme", "reset-password")],
      ["DELETE", pinsUrl("acme", "reset-password")],
    ] as const) {
      const response = await app.inject({ method, url });
      assertProblem(response, 500, "urn:gauntlet:problem:pins-unavailable", "Pinned operations are unavailable");
      assert.doesNotMatch(response.body, /SQLITE|private/);
    }
  } finally {
    await app.close();
  }
});
