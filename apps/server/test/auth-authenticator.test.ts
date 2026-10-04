import assert from "node:assert/strict";
import { test } from "node:test";
import { createApiToken } from "../src/auth/api-tokens.js";
import { createAuthenticator } from "../src/auth/authenticator.js";
import { authConfiguration, type PasswordAuthConfiguration } from "../src/auth/config.js";
import { hashPassword } from "../src/auth/passwords.js";
import { decodeAuthSecret } from "../src/auth/secret.js";

const secret = decodeAuthSecret("c".repeat(64));
const now = new Date("2026-10-04T12:00:00Z");
const apiToken = createApiToken();
const annaHash = await hashPassword("anna-password");
const benHash = await hashPassword("ben-password");
const sharedHash = await hashPassword("shared-password");

function configuration(password: unknown): PasswordAuthConfiguration {
  return authConfiguration({
    mode: "password",
    publicUrl: "https://gauntlet.qa.internal",
    sessionTtl: "1h",
    password,
    tokens: [{ name: "ci-nightly", hash: apiToken.hash }],
  }) as PasswordAuthConfiguration;
}

const users = () => configuration({ users: [{ username: "anna", hash: annaHash }, { username: "ben", hash: benHash }] });

test("the shared password signs in as the shared principal", async () => {
  const authenticator = createAuthenticator(configuration({ shared: { hash: sharedHash } }), secret);
  assert.equal(await authenticator.login(undefined, "wrong", now), undefined);
  const session = await authenticator.login(undefined, "shared-password", now);
  assert.ok(session);
  assert.deepEqual(session.principal, { kind: "shared", id: "shared", displayName: "Shared password" });
  assert.equal(session.expiresAt.toISOString(), "2026-10-04T13:00:00.000Z");
  const resolved = authenticator.authenticate({ authorization: `Bearer ${session.token}` }, now);
  assert.equal(resolved?.principal.id, "shared");
  assert.equal(resolved?.via, "bearer");
});

test("users sign in with their own password and unknown users fail", async () => {
  const authenticator = createAuthenticator(users(), secret);
  assert.equal(await authenticator.login("anna", "ben-password", now), undefined);
  assert.equal(await authenticator.login("carol", "anna-password", now), undefined);
  assert.equal(await authenticator.login(undefined, "anna-password", now), undefined);
  const session = await authenticator.login("anna", "anna-password", now);
  assert.deepEqual(session?.principal, { kind: "user", id: "user:anna", displayName: "anna" });
});

test("a session cookie authenticates and reports its expiry", async () => {
  const authenticator = createAuthenticator(users(), secret);
  const session = (await authenticator.login("anna", "anna-password", now))!;
  const resolved = authenticator.authenticate({ cookie: `theme=dark; gauntlet_session=${session.token}` }, now);
  assert.equal(resolved?.principal.id, "user:anna");
  assert.equal(resolved?.via, "cookie");
  assert.equal(resolved?.expiresAt?.toISOString(), session.expiresAt.toISOString());
  assert.equal(authenticator.authenticate({ cookie: `gauntlet_session=${session.token}` }, new Date("2026-10-04T13:00:00Z")), undefined);
});

test("a session stops working when the user's password changes or the user is removed", async () => {
  const session = (await createAuthenticator(users(), secret).login("anna", "anna-password", now))!;
  const changed = createAuthenticator(configuration({ users: [{ username: "anna", hash: benHash }] }), secret);
  assert.equal(changed.authenticate({ authorization: `Bearer ${session.token}` }, now), undefined);
  const removed = createAuthenticator(configuration({ users: [{ username: "ben", hash: benHash }] }), secret);
  assert.equal(removed.authenticate({ authorization: `Bearer ${session.token}` }, now), undefined);
  const unchanged = createAuthenticator(users(), secret);
  assert.equal(unchanged.authenticate({ authorization: `Bearer ${session.token}` }, now)?.principal.id, "user:anna");
});

test("a shared session does not survive a switch to user passwords", async () => {
  const session = (await createAuthenticator(configuration({ shared: { hash: sharedHash } }), secret).login(undefined, "shared-password", now))!;
  assert.equal(createAuthenticator(users(), secret).authenticate({ authorization: `Bearer ${session.token}` }, now), undefined);
});

test("a static API token authenticates as its configured name", () => {
  const authenticator = createAuthenticator(users(), secret);
  const resolved = authenticator.authenticate({ authorization: `Bearer ${apiToken.token}` }, now);
  assert.deepEqual(resolved?.principal, { kind: "token", id: "token:ci-nightly", displayName: "ci-nightly" });
  assert.equal(resolved?.via, "bearer");
  assert.equal(authenticator.authenticate({ authorization: `Bearer ${createApiToken().token}` }, now), undefined);
});

test("an invalid bearer credential never falls back to the cookie", async () => {
  const authenticator = createAuthenticator(users(), secret);
  const session = (await authenticator.login("anna", "anna-password", now))!;
  for (const authorization of ["Bearer nonsense", "Basic YW5uYTphbm5h", "Bearer", `Bearer ${session.token.replace("g1.s.", "g1.r.")}`]) {
    assert.equal(authenticator.authenticate({ authorization, cookie: `gauntlet_session=${session.token}` }, now), undefined, authorization);
  }
});

test("a token signed with another secret is rejected", async () => {
  const session = (await createAuthenticator(users(), decodeAuthSecret("d".repeat(64))).login("anna", "anna-password", now))!;
  assert.equal(createAuthenticator(users(), secret).authenticate({ authorization: `Bearer ${session.token}` }, now), undefined);
});
