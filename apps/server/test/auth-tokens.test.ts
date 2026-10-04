import assert from "node:assert/strict";
import { test } from "node:test";
import { createApiToken, hashApiToken, isApiTokenHash } from "../src/auth/api-tokens.js";
import { decodeAuthSecret, deriveTokenKeys } from "../src/auth/secret.js";
import { signToken, verifyToken } from "../src/auth/tokens.js";

const keys = deriveTokenKeys(decodeAuthSecret("a".repeat(64)));
const otherKeys = deriveTokenKeys(decodeAuthSecret("b".repeat(64)));
const now = new Date(2_000_000_000);
const payload = { sub: "user:anna", iat: 1_000, exp: 4_000_000 };

test("a signed token verifies with the same kind and secret", () => {
  const token = signToken(keys, "s", payload);
  assert.match(token, /^g1\.s\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(verifyToken(keys, "s", token, now), payload);
});

test("a session token never verifies as a refresh token", () => {
  const token = signToken(keys, "s", payload);
  assert.equal(verifyToken(keys, "r", token, now), undefined);
  assert.equal(verifyToken(keys, "r", token.replace("g1.s.", "g1.r."), now), undefined);
});

test("a token signed with another secret is rejected", () => {
  assert.equal(verifyToken(keys, "s", signToken(otherKeys, "s", payload), now), undefined);
});

test("a tampered payload or signature is rejected", () => {
  const token = signToken(keys, "s", payload);
  const [prefix, kind, body, signature] = token.split(".") as [string, string, string, string];
  const forged = Buffer.from(JSON.stringify({ ...payload, sub: "user:root" })).toString("base64url");
  assert.equal(verifyToken(keys, "s", [prefix, kind, forged, signature].join("."), now), undefined);
  const flipped = signature.slice(0, -1) + (signature.endsWith("A") ? "B" : "A");
  assert.equal(verifyToken(keys, "s", [prefix, kind, body, flipped].join("."), now), undefined);
});

test("a token expires at exactly exp", () => {
  const token = signToken(keys, "s", payload);
  assert.equal(verifyToken(keys, "s", token, new Date(payload.exp * 1000)), undefined);
  assert.ok(verifyToken(keys, "s", token, new Date(payload.exp * 1000 - 1)));
});

test("malformed tokens are rejected", () => {
  const signature = signToken(keys, "s", payload).split(".")[3];
  for (const candidate of [
    "",
    "g1.s",
    "g2.s.e30.x",
    `g1.s.${Buffer.from("[]").toString("base64url")}.${signature}`,
    `g1.s.${Buffer.from("{}").toString("base64url")}.${signature}`,
    "g1.s." + "A".repeat(5000) + ".x",
  ]) {
    assert.equal(verifyToken(keys, "s", candidate, now), undefined, candidate.slice(0, 20));
  }
  const missingSub = signToken(keys, "s", { iat: 1, exp: 4_000_000 } as never);
  assert.equal(verifyToken(keys, "s", missingSub, now), undefined);
});

test("the secret must decode to at least 32 bytes", () => {
  assert.equal(decodeAuthSecret("ab".repeat(32)).byteLength, 32);
  assert.equal(decodeAuthSecret(Buffer.alloc(32, 7).toString("base64url")).byteLength, 32);
  assert.throws(() => decodeAuthSecret("ab".repeat(31)), /Invalid authentication secret/);
  assert.throws(() => decodeAuthSecret(Buffer.alloc(31, 7).toString("base64url")), /Invalid authentication secret/);
  assert.throws(() => decodeAuthSecret("not a secret!"), /Invalid authentication secret/);
});

test("an API token hashes to its configuration entry", () => {
  const { token, hash } = createApiToken();
  assert.match(token, /^gat_[A-Za-z0-9_-]{43}$/);
  assert.equal(hashApiToken(token), hash);
  assert.ok(isApiTokenHash(hash));
  assert.equal(isApiTokenHash("sha256$short"), false);
  assert.notEqual(createApiToken().token, token);
});
