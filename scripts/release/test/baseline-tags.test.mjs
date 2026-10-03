import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { applyBaselineTags, planBaselineTags, runBaselineTagsCli } from "../baseline-tags.mjs";
import { RELEASE_UNITS } from "../units.mjs";

function git(root, ...args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function write(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function commit(root, message) {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

// First commit: lockstep 0.1.8 with only the root VERSION and the protocol manifest present, so the
// remaining units must fall back to the root VERSION. Second commit moves VERSION on.
function repository(t) {
  const root = mkdtempSync(join(tmpdir(), "gauntlet-baseline-tags-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "tag.gpgsign", "false");
  write(root, "VERSION", "0.1.8\n");
  write(root, "packages/protocol/package.json", `${JSON.stringify({ name: "p", version: "0.1.8" }, null, 2)}\n`);
  const first = commit(root, "first");
  git(root, "tag", "-a", "v0.1.8", "-m", "v0.1.8", first);
  write(root, "VERSION", "0.1.9\n");
  const second = commit(root, "second");
  return { root, first, second };
}

test("the plan creates a tag for every unit except the one whose tag already exists", (t) => {
  const { root, first } = repository(t);
  const plan = planBaselineTags({ root, commit: first });
  assert.equal(plan.create.length, RELEASE_UNITS.length - 1);
  assert.deepEqual(plan.existing, [{ tag: "v0.1.8", target: first }]);
  assert.equal(plan.create.some(({ tag }) => tag === "v0.1.8"), false);
  assert.deepEqual(plan.create.find(({ unit }) => unit === "protocol"), {
    tag: "protocol-v0.1.8", unit: "protocol", version: "0.1.8",
  });
  // Units whose version file did not exist at the commit take the root VERSION at that commit.
  assert.deepEqual(plan.create.find(({ unit }) => unit === "skills"), {
    tag: "skills-v0.1.8", unit: "skills", version: "0.1.8",
  });
  assert.deepEqual(plan.create.find(({ unit }) => unit === "java-core"), {
    tag: "java-core-v0.1.8", unit: "java-core", version: "0.1.8",
  });
});

test("versions come from the baseline commit, not the working tree or later commits", (t) => {
  const { root, first } = repository(t);
  write(root, "packages/protocol/package.json", `${JSON.stringify({ name: "p", version: "0.5.0" })}\n`);
  assert.equal(
    planBaselineTags({ root, commit: first }).create.find(({ unit }) => unit === "protocol").tag,
    "protocol-v0.1.8",
  );
  const later = commit(root, "bump protocol");
  assert.equal(
    planBaselineTags({ root, commit: later }).create.find(({ unit }) => unit === "protocol").tag,
    "protocol-v0.5.0",
  );
});

test("an existing tag that points at another commit is an error", (t) => {
  const { root, first, second } = repository(t);
  git(root, "tag", "-a", "protocol-v0.1.8", "-m", "elsewhere", second);
  assert.throws(
    () => planBaselineTags({ root, commit: first }),
    new Error(`baseline tag protocol-v0.1.8 already points at ${second}`),
  );
  assert.throws(() => applyBaselineTags({ root, commit: first }), /already points at/);
  assert.equal(git(root, "tag", "--list", "skills-v*"), "");
});

test("applying creates annotated local tags once and is a no-op the second time", (t) => {
  const { root, first } = repository(t);
  const created = applyBaselineTags({ root, commit: first });
  assert.equal(created.create.length, RELEASE_UNITS.length - 1);
  assert.equal(git(root, "cat-file", "-t", "protocol-v0.1.8"), "tag");
  assert.equal(git(root, "tag", "-l", "--format=%(contents:subject)", "protocol-v0.1.8"), "protocol 0.1.8 baseline");
  assert.equal(git(root, "rev-parse", "protocol-v0.1.8^{commit}"), first);
  assert.equal(git(root, "rev-parse", "skills-v0.1.8^{commit}"), first);
  const again = applyBaselineTags({ root, commit: first });
  assert.deepEqual(again.create, []);
  assert.equal(again.existing.length, RELEASE_UNITS.length);
  assert.equal(git(root, "tag", "--list").split("\n").length, RELEASE_UNITS.length);
});

test("a malformed version at the commit is rejected", (t) => {
  const { root } = repository(t);
  write(root, "packages/protocol/package.json", `${JSON.stringify({ name: "p", version: "v1" })}\n`);
  assert.throws(() => planBaselineTags({ root, commit: commit(root, "bad") }), /version/i);
  write(root, "packages/protocol/package.json", `${JSON.stringify({ name: "p", version: 1 })}\n`);
  assert.throws(() => planBaselineTags({ root, commit: commit(root, "worse") }), /version/i);
});

test("an unknown commit is rejected", (t) => {
  const { root } = repository(t);
  assert.throws(() => planBaselineTags({ root, commit: "0".repeat(40) }), /commit/i);
  assert.throws(() => planBaselineTags({ root, commit: "--all" }), /commit/i);
});

test("the CLI prints the plan without --apply and creates tags only with it", (t) => {
  const { root, first } = repository(t);
  const dry = runBaselineTagsCli(["--commit", first], { root });
  assert.equal(dry.exitCode, 0);
  assert.match(dry.stdout, /create protocol-v0\.1\.8 /);
  assert.match(dry.stdout, /exists v0\.1\.8 /);
  assert.equal(git(root, "tag", "--list", "protocol-v*"), "");

  const applied = runBaselineTagsCli(["--commit", first, "--apply"], { root });
  assert.equal(applied.exitCode, 0);
  assert.equal(git(root, "rev-parse", "protocol-v0.1.8^{commit}"), first);

  assert.equal(runBaselineTagsCli([], { root }).exitCode, 2);
  assert.equal(runBaselineTagsCli(["--commit"], { root }).exitCode, 2);
  assert.equal(runBaselineTagsCli(["--commit", first, "--push"], { root }).exitCode, 2);
  const failed = runBaselineTagsCli(["--commit", "0".repeat(40)], { root });
  assert.equal(failed.exitCode, 1);
  assert.match(failed.stderr, /commit/i);
});
