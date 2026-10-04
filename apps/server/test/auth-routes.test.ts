import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { createLoginRateLimiter } from "../src/auth/rate-limit.js";
import { passwordAuth, passwords } from "./support/auth.js";
import { serverEnvironment } from "./support/environment.js";
import { createFakeAdapter, fakeTarget } from "./support/fake-adapter.js";

type App = Awaited<ReturnType<typeof createApp>>;

async function usingApp<T>(auth: ReturnType<typeof passwordAuth> | undefined, action: (app: App) => Promise<T>): Promise<T> {
  const app = await createApp({
    environment: serverEnvironment,
    targets: [fakeTarget],
    fetch: createFakeAdapter().fetch,
    ...(auth === undefined ? {} : { auth }),
  });
  try {
    return await action(app);
  } finally {
    await app.close();
  }
}

const login = (app: App, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: "/api/v1/auth/login", payload: payload as Record<string, unknown>, headers });

function setCookie(response: { headers: Record<string, unknown> }): string {
  const value = response.headers["set-cookie"];
  return Array.isArray(value) ? value.join("\n") : String(value ?? "");
}

test("mode none reports no login and has no login route", async () => {
  await usingApp(undefined, async (app) => {
    const session = await app.inject({ method: "GET", url: "/api/v1/auth/session" });
    assert.equal(session.statusCode, 200);
    assert.deepEqual(session.json(), { mode: "none", loginFields: [], principal: null, expiresAt: null });
    const attempt = await login(app, { password: "x", surface: "dashboard" });
    assert.equal(attempt.statusCode, 404);
    assert.equal(attempt.json().type, "urn:gauntlet:problem:route-not-found");
  });
});

test("the session route tells the dashboard which form to show", async () => {
  await usingApp(passwordAuth(), async (app) => {
    const response = await app.inject({ method: "GET", url: "/api/v1/auth/session" });
    assert.deepEqual(response.json(), { mode: "password", loginFields: ["password"], principal: null, expiresAt: null });
    assert.equal(response.headers["cache-control"], "no-store");
  });
  await usingApp(passwordAuth({ variant: "users" }), async (app) => {
    assert.deepEqual((await app.inject({ method: "GET", url: "/api/v1/auth/session" })).json().loginFields, ["username", "password"]);
  });
});

test("a dashboard login over HTTP sets a Lax cookie without Secure", async () => {
  await usingApp(passwordAuth(), async (app) => {
    const response = await login(app, { password: passwords.shared, surface: "dashboard" });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.deepEqual(body.principal, { kind: "shared", id: "shared", displayName: "Shared password" });
    assert.match(body.token, /^g1\.s\./);
    assert.ok(Date.parse(body.expiresAt) > Date.now());
    assert.equal(response.headers["cache-control"], "no-store");
    const cookie = setCookie(response);
    assert.match(cookie, /^gauntlet_session=g1\.s\.[^;]+; Max-Age=43200; Path=\/; HttpOnly; SameSite=Lax$/);

    const session = await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: { cookie: `gauntlet_session=${body.token}` } });
    assert.equal(session.json().principal.id, "shared");
    assert.equal(session.json().expiresAt, body.expiresAt);
    const bearer = await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: { authorization: `Bearer ${body.token}` } });
    assert.equal(bearer.json().principal.id, "shared");
  });
});

test("HTTPS adds Secure, and a widget login uses a partitioned SameSite=None cookie", async () => {
  await usingApp(passwordAuth({ publicUrl: "https://gauntlet.test" }), async (app) => {
    assert.match(setCookie(await login(app, { password: passwords.shared, surface: "dashboard" })), /; HttpOnly; SameSite=Lax; Secure$/);
    assert.match(setCookie(await login(app, { password: passwords.shared, surface: "widget" })), /; HttpOnly; Secure; SameSite=None; Partitioned$/);
  });
});

test("a widget login over HTTP sets no cookie but returns the token", async () => {
  await usingApp(passwordAuth(), async (app) => {
    const response = await login(app, { password: passwords.shared, surface: "widget" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["set-cookie"], undefined);
    assert.match(response.json().token, /^g1\.s\./);
  });
});

test("unknown users and wrong passwords get the same answer", async () => {
  await usingApp(passwordAuth({ variant: "users" }), async (app) => {
    const unknown = await login(app, { username: "carol", password: passwords.anna, surface: "dashboard" });
    const wrong = await login(app, { username: "anna", password: "nope", surface: "dashboard" });
    assert.equal(unknown.statusCode, 401);
    assert.equal(unknown.body, wrong.body);
    assert.equal(unknown.json().type, "urn:gauntlet:problem:invalid-credentials");
    assert.equal(unknown.headers["set-cookie"], undefined);
    const ok = await login(app, { username: "anna", password: passwords.anna, surface: "dashboard" });
    assert.equal(ok.json().principal.id, "user:anna");
  });
});

test("login bodies are validated strictly", async () => {
  await usingApp(passwordAuth({ variant: "users" }), async (app) => {
    for (const payload of [
      {},
      { password: passwords.anna, surface: "dashboard" },
      { username: "anna", password: passwords.anna },
      { username: "anna", password: passwords.anna, surface: "mobile" },
      { username: "anna", password: "", surface: "dashboard" },
      { username: "anna", password: "x".repeat(257), surface: "dashboard" },
      { username: "anna", password: passwords.anna, surface: "dashboard", remember: true },
      { username: 7, password: passwords.anna, surface: "dashboard" },
    ]) {
      const response = await login(app, payload);
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
      assert.equal(response.json().type, "urn:gauntlet:problem:invalid-request");
    }
  });
  await usingApp(passwordAuth(), async (app) => {
    assert.equal((await login(app, { username: "anna", password: passwords.shared, surface: "dashboard" })).statusCode, 400);
  });
});

test("repeated failures are rate limited", async () => {
  await usingApp(passwordAuth({ variant: "users" }), async (app) => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      assert.equal((await login(app, { username: "anna", password: "nope", surface: "dashboard" })).statusCode, 401);
    }
    const blocked = await login(app, { username: "anna", password: passwords.anna, surface: "dashboard" });
    assert.equal(blocked.statusCode, 429);
    assert.equal(blocked.json().type, "urn:gauntlet:problem:rate-limited");
    assert.ok(Number(blocked.headers["retry-after"]) > 0);
  });
});

test("logout clears the cookie and needs the Gauntlet origin when sent with a cookie", async () => {
  await usingApp(passwordAuth(), async (app) => {
    const token = (await login(app, { password: passwords.shared, surface: "dashboard" })).json().token as string;
    const foreign = await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie: `gauntlet_session=${token}`, origin: "http://evil.test" } });
    assert.equal(foreign.statusCode, 403);
    const response = await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie: `gauntlet_session=${token}`, origin: "http://gauntlet.test" } });
    assert.equal(response.statusCode, 204);
    const cookie = setCookie(response);
    assert.match(cookie, /gauntlet_session=; Max-Age=0; Path=\/; HttpOnly; SameSite=Lax/);
    const anonymous = await app.inject({ method: "POST", url: "/api/v1/auth/logout" });
    assert.equal(anonymous.statusCode, 204);
  });
});

test("failures from one address do not lock out the same login from another address", async () => {
  await usingApp(passwordAuth(), async (app) => {
    const attempt = (password: string, remoteAddress: string) => app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { password, surface: "dashboard" },
      remoteAddress,
    });
    for (let index = 0; index < 10; index += 1) assert.equal((await attempt("nope", "10.0.0.1")).statusCode, 401);
    assert.equal((await attempt(passwords.shared, "10.0.0.1")).statusCode, 429);
    assert.equal((await attempt(passwords.shared, "10.0.0.2")).statusCode, 200);
  });
});

test("the rate limiter counts per key within its window and forgets old keys", () => {
  const limiter = createLoginRateLimiter({ limit: 2, windowMs: 1_000, maxKeys: 2 });
  const start = new Date(0);
  limiter.fail(["ip:a", "user:anna"], start);
  assert.equal(limiter.blocked(["ip:a"], start), undefined);
  limiter.fail(["ip:a"], start);
  assert.equal(limiter.blocked(["ip:a"], new Date(500)), 1);
  assert.equal(limiter.blocked(["ip:a"], new Date(1_000)), undefined);
  limiter.reset(["user:anna"]);
  limiter.fail(["ip:b"], start);
  limiter.fail(["ip:c"], start);
  limiter.fail(["ip:c"], start);
  assert.equal(limiter.blocked(["ip:c"], start), 1);
});
