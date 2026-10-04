import assert from "node:assert/strict";
import { test } from "node:test";
import { DUMMY_PASSWORD_HASH, hashPassword, parsePasswordHash, verifyPassword } from "../src/auth/passwords.js";

test("a hashed password verifies and a wrong one does not", async () => {
  const encoded = await hashPassword("correct horse");
  assert.match(encoded, /^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
  const hash = parsePasswordHash(encoded);
  assert.ok(hash);
  assert.equal(await verifyPassword("correct horse", hash), true);
  assert.equal(await verifyPassword("correct horsf", hash), false);
  assert.equal(await verifyPassword("", hash), false);
});

test("the same password with a new salt produces a different hash", async () => {
  assert.notEqual(await hashPassword("secret"), await hashPassword("secret"));
});

test("password hashes with unsafe or malformed parameters are rejected", () => {
  const salt = Buffer.alloc(16, 1).toString("base64url");
  const key = Buffer.alloc(32, 2).toString("base64url");
  assert.ok(parsePasswordHash(`scrypt$16384$8$1$${salt}$${key}`));
  for (const candidate of [
    `scrypt$1024$8$1$${salt}$${key}`,
    `scrypt$20000$8$1$${salt}$${key}`,
    `scrypt$2097152$8$1$${salt}$${key}`,
    `scrypt$16384$0$1$${salt}$${key}`,
    `scrypt$16384$33$1$${salt}$${key}`,
    `scrypt$16384$8$17$${salt}$${key}`,
    `scrypt$16384$8$1$${salt}`,
    `scrypt$16384$8$1$$${key}`,
    `bcrypt$16384$8$1$${salt}$${key}`,
    `scrypt$16384$8$1$${salt}$${Buffer.alloc(8).toString("base64url")}`,
    "plain-password",
  ]) {
    assert.equal(parsePasswordHash(candidate), undefined, candidate);
  }
});

test("the dummy hash never verifies", async () => {
  assert.equal(await verifyPassword("", DUMMY_PASSWORD_HASH), false);
  assert.equal(await verifyPassword("password", DUMMY_PASSWORD_HASH), false);
});
