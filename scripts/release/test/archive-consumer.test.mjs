import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import * as archiveConsumer from "../archive-consumer.mjs";

function sandbox(t) {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), "gauntlet-owned-workspace-test-")));
  chmodSync(root, 0o700);
  const temporaryDirectory = resolve(root, "tmp");
  mkdirSync(temporaryDirectory, { mode: 0o700 });
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = temporaryDirectory;
  t.after(() => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return { root, temporaryDirectory };
}

test("owned temporary workspaces are removed without recursive cleanup", async (t) => {
  const files = sandbox(t);
  assert.equal(typeof archiveConsumer.withOwnedTemporaryWorkspace, "function");
  const value = await archiveConsumer.withOwnedTemporaryWorkspace({
    prefix: "gauntlet-owned-test-",
  }, async (workspace) => {
    mkdirSync(resolve(workspace, "nested"), { mode: 0o700 });
    writeFileSync(resolve(workspace, "nested/owned.txt"), "owned\n", { mode: 0o600 });
    return "complete";
  });
  assert.equal(value, "complete");
  assert.deepEqual(readdirSync(files.temporaryDirectory), []);
});

test("owned temporary cleanup preserves a file replaced after its journal snapshot", async (t) => {
  const files = sandbox(t);
  assert.equal(typeof archiveConsumer.withOwnedTemporaryWorkspace, "function");
  const displaced = resolve(files.root, "displaced-owned-file");
  let replacement;
  await assert.rejects(archiveConsumer.withOwnedTemporaryWorkspace({
    prefix: "gauntlet-owned-test-",
  }, async (workspace) => {
    writeFileSync(resolve(workspace, "owned.txt"), "owned\n", { mode: 0o600 });
  }, {
    quarantineToken: "a".repeat(32),
    beforeRemoval({ path }) {
      renameSync(resolve(path, "owned.txt"), displaced);
      replacement = resolve(path, "owned.txt");
      writeFileSync(replacement, "foreign\n", { mode: 0o600 });
    },
  }), /cleanup failed closed/u);
  assert.equal(readFileSync(replacement, "utf8"), "foreign\n");
  assert.equal(readFileSync(displaced, "utf8"), "owned\n");
  assert.equal(existsSync(replacement), true);
});
