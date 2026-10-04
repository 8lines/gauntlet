import assert from "node:assert/strict";
import { test } from "node:test";
import { authConfiguration } from "../src/auth/config.js";
import { hashApiToken } from "../src/auth/api-tokens.js";
import { loadServerConfiguration } from "../src/config.js";

const salt = Buffer.alloc(16, 1).toString("base64url");
const hash = `scrypt$16384$8$1$${salt}$${Buffer.alloc(32, 2).toString("base64url")}`;
const otherHash = `scrypt$16384$8$1$${salt}$${Buffer.alloc(32, 3).toString("base64url")}`;
const tokenHash = hashApiToken(`gat_${"A".repeat(43)}`);

function shared(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { mode: "password", publicUrl: "https://gauntlet.qa.internal", password: { shared: { hash } }, ...extra };
}

test("authentication is off when the section is omitted or mode is none", () => {
  assert.deepEqual(authConfiguration(undefined), { mode: "none" });
  assert.deepEqual(authConfiguration({ mode: "none" }), { mode: "none" });
});

test("mode none accepts no other keys", () => {
  assert.throws(() => authConfiguration({ mode: "none", publicUrl: "https://gauntlet.qa.internal" }));
  assert.throws(() => authConfiguration({ mode: "oidc" }));
  assert.throws(() => authConfiguration({}));
});

test("shared password mode parses with defaults", () => {
  const configuration = authConfiguration(shared());
  assert.equal(configuration.mode, "password");
  if (configuration.mode !== "password") return;
  assert.equal(configuration.publicUrl.origin, "https://gauntlet.qa.internal");
  assert.equal(configuration.sessionTtlSeconds, 43_200);
  assert.equal(configuration.password.kind, "shared");
  assert.equal(configuration.tokens.size, 0);
});

test("users mode and tokens parse", () => {
  const configuration = authConfiguration(shared({
    sessionTtl: "30m",
    password: { users: [{ username: "anna", hash }, { username: "ben", hash: otherHash }] },
    tokens: [{ name: "ci-nightly", hash: tokenHash }],
  }));
  assert.equal(configuration.mode, "password");
  if (configuration.mode !== "password" || configuration.password.kind !== "users") return assert.fail();
  assert.equal(configuration.sessionTtlSeconds, 1_800);
  assert.deepEqual([...configuration.password.users.keys()], ["anna", "ben"]);
  assert.equal(configuration.tokens.get(tokenHash), "ci-nightly");
});

test("publicUrl must be an http(s) origin", () => {
  for (const publicUrl of [undefined, "gauntlet.qa", "ftp://gauntlet.qa", "https://gauntlet.qa/base", "https://gauntlet.qa/?x=1", "https://gauntlet.qa/#x", "https://user@gauntlet.qa"]) {
    assert.throws(() => authConfiguration(shared({ publicUrl })), String(publicUrl));
  }
  assert.doesNotThrow(() => authConfiguration(shared({ publicUrl: "http://localhost:8080/" })));
});

test("password variants are exclusive and validated", () => {
  assert.throws(() => authConfiguration(shared({ password: { shared: { hash }, users: [{ username: "anna", hash }] } })));
  assert.throws(() => authConfiguration(shared({ password: {} })));
  assert.throws(() => authConfiguration(shared({ password: undefined })));
  assert.throws(() => authConfiguration(shared({ password: { shared: { hash: "plain" } } })));
  assert.throws(() => authConfiguration(shared({ password: { users: [] } })));
  assert.throws(() => authConfiguration(shared({ password: { users: [{ username: "anna", hash }, { username: "anna", hash: otherHash }] } })));
  assert.throws(() => authConfiguration(shared({ password: { users: [{ username: "not valid", hash }] } })));
  assert.throws(() => authConfiguration(shared({ password: { users: [{ username: "anna", hash, role: "admin" }] } })));
});

test("session TTL is bounded between 5 minutes and 30 days", () => {
  for (const sessionTtl of ["4m", "31d", "721h", "12", "12s", "0h", 12]) {
    assert.throws(() => authConfiguration(shared({ sessionTtl })), String(sessionTtl));
  }
  for (const [sessionTtl, seconds] of [["5m", 300], ["12h", 43_200], ["30d", 2_592_000]] as const) {
    const configuration = authConfiguration(shared({ sessionTtl }));
    assert.equal(configuration.mode === "password" && configuration.sessionTtlSeconds, seconds);
  }
});

test("API tokens need unique names and hashes", () => {
  assert.throws(() => authConfiguration(shared({ tokens: [{ name: "ci", hash: tokenHash }, { name: "ci", hash: hashApiToken("x") }] })));
  assert.throws(() => authConfiguration(shared({ tokens: [{ name: "ci", hash: tokenHash }, { name: "cd", hash: tokenHash }] })));
  assert.throws(() => authConfiguration(shared({ tokens: [{ name: "ci", hash: "sha256$short" }] })));
  assert.throws(() => authConfiguration(shared({ tokens: [{ name: "ci" }] })));
  assert.throws(() => authConfiguration(shared({ tokens: {} })));
  assert.throws(() => authConfiguration(shared({ unknown: true })));
});

test("the configuration file carries the auth section", async () => {
  const document = {
    version: 1,
    instance: { name: "qa", environment: { name: "qa", kind: "qa" } },
    targets: [{ id: "shop", label: "Shop", adapterUrl: "http://shop:8080", expectedEnvironment: { name: "qa", kind: "qa" } }],
  };
  const read = (value: unknown) => async () => new TextEncoder().encode(JSON.stringify(value));
  const off = await loadServerConfiguration({ GAUNTLET_CONFIG_FILE: "/c.json" }, read(document));
  assert.deepEqual(off.auth, { mode: "none" });
  const on = await loadServerConfiguration({ GAUNTLET_CONFIG_FILE: "/c.json" }, read({ ...document, auth: shared() }));
  assert.equal(on.auth.mode, "password");
  await assert.rejects(
    loadServerConfiguration({ GAUNTLET_CONFIG_FILE: "/c.json" }, read({ ...document, auth: { mode: "password" } })),
    /invalid-document/,
  );
});
