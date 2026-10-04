import assert from "node:assert/strict";
import { test } from "node:test";
import { runAuthCli } from "../src/auth-cli.js";
import { hashApiToken } from "../src/auth/api-tokens.js";
import { parsePasswordHash, verifyPassword } from "../src/auth/passwords.js";
import { decodeAuthSecret } from "../src/auth/secret.js";

async function run(argv: readonly string[], stdin = "") {
  let stdout = "";
  let stderr = "";
  const code = await runAuthCli(argv, {
    readStdin: async () => stdin,
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
  });
  return { code, stdout, stderr };
}

test("hash-password hashes stdin without its trailing newline", async () => {
  const result = await run(["hash-password"], "correct horse\r\n");
  assert.equal(result.code, 0);
  const hash = parsePasswordHash(result.stdout.trim());
  assert.ok(hash);
  assert.equal(await verifyPassword("correct horse", hash), true);
  assert.equal(result.stdout.includes("correct horse"), false);
});

test("hash-password refuses an empty password", async () => {
  const result = await run(["hash-password"], "\n");
  assert.equal(result.code, 64);
  assert.equal(result.stdout, "");
});

test("create-token prints the token once with its configuration entry", async () => {
  const result = await run(["create-token", "ci-nightly"]);
  assert.equal(result.code, 0);
  const token = /^token: (gat_[A-Za-z0-9_-]{43})$/m.exec(result.stdout)?.[1];
  assert.ok(token);
  assert.match(result.stdout, new RegExp(`- name: ci-nightly\\n\\s+hash: "${hashApiToken(token).replace("$", "\\$")}"`));
  assert.equal((await run(["create-token", "not valid"])).code, 64);
  assert.equal((await run(["create-token"])).code, 64);
});

test("generate-secret prints a usable signing secret", async () => {
  const result = await run(["generate-secret"]);
  assert.equal(result.code, 0);
  assert.equal(decodeAuthSecret(result.stdout.trim()).byteLength, 32);
  assert.notEqual(result.stdout, (await run(["generate-secret"])).stdout);
});

test("unknown commands print usage and exit 64", async () => {
  for (const argv of [[], ["help-me"], ["generate-secret", "extra"]]) {
    const result = await run(argv);
    assert.equal(result.code, 64, argv.join(" "));
    assert.match(result.stderr, /Usage: node dist\/auth-cli\.js/);
  }
});
