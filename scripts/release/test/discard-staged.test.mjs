import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  discardStagedRelease,
  parseDiscardStagedArguments,
  runDiscardStagedCli,
} from "../discard-staged.mjs";

const SET = "release-2026-10-03.1";
const COMMIT = "1".repeat(40);
const LOCAL_SET = "local-111111111111";

function sandbox() {
  return realpathSync(mkdtempSync(resolve(tmpdir(), "gauntlet-discard-test-")));
}

function staged(root, releaseSet = SET) {
  const releaseRoot = resolve(root, ".artifacts/release", releaseSet);
  mkdirSync(releaseRoot, { recursive: true, mode: 0o700 });
  writeFileSync(resolve(releaseRoot, "evidence"), "release evidence\n");
  return releaseRoot;
}

function verifierFor(releaseSet, calls = []) {
  return (options) => {
    calls.push(options);
    assert.deepEqual(options, { outputDirectory: options.outputDirectory, releaseSet, sourceCommit: COMMIT });
    return Object.freeze({ schemaVersion: 2, ok: true, releaseSet, sourceCommit: COMMIT, artifacts: 8 });
  };
}

test("discard CLI parser accepts only one exact in-repository release-set root and commit", () => {
  const root = "/workspace/gauntlet";
  assert.deepEqual(parseDiscardStagedArguments([
    "--release-root", `.artifacts/release/${SET}`, "--source-commit", COMMIT,
  ], root), {
    releaseRoot: `/workspace/gauntlet/.artifacts/release/${SET}`,
    sourceCommit: COMMIT,
  });
  assert.deepEqual(parseDiscardStagedArguments([
    "--release-root", `.artifacts/release/${LOCAL_SET}`, "--source-commit", COMMIT,
  ], root), {
    releaseRoot: `/workspace/gauntlet/.artifacts/release/${LOCAL_SET}`,
    sourceCommit: COMMIT,
  });
  for (const argv of [
    [],
    ["--release-root", "/tmp/other", "--source-commit", COMMIT],
    ["--release-root", ".artifacts/release/../secret", "--source-commit", COMMIT],
    ["--release-root", ".artifacts/release/0.1.0", "--source-commit", COMMIT],
    ["--release-root", ".artifacts/release/local-222222222222", "--source-commit", COMMIT],
    ["--release-root", ".artifacts/release/release-2026-02-30.1", "--source-commit", COMMIT],
    ["--release-root", `.artifacts/release/${SET}`, "--source-commit", "short"],
    ["--source-commit", COMMIT, "--release-root", `.artifacts/release/${SET}`],
  ]) assert.throws(() => parseDiscardStagedArguments(argv, root), /Usage: discard-staged\.mjs --release-root \.artifacts\/release\/<set-id>/u);
});

test("discard removes only a verified exact staged root and leaves siblings untouched", async () => {
  for (const releaseSet of [SET, LOCAL_SET]) {
    const root = sandbox();
    try {
      const releaseRoot = staged(root, releaseSet);
      const sibling = resolve(root, ".artifacts/release/release-2026-10-03.2");
      mkdirSync(sibling, { recursive: true });
      writeFileSync(resolve(sibling, "keep"), "keep\n");
      const calls = [];
      const report = await discardStagedRelease({
        root,
        releaseRoot,
        sourceCommit: COMMIT,
        verifier: verifierFor(releaseSet, calls),
        tokenFactory: () => "a".repeat(32),
      });
      assert.deepEqual(report, {
        schemaVersion: 2,
        ok: true,
        removed: `.artifacts/release/${releaseSet}`,
        releaseSet,
        sourceCommit: COMMIT,
      });
      assert.deepEqual(calls.map(({ outputDirectory }) => outputDirectory), [
        releaseRoot,
        resolve(root, ".artifacts/.release-discard", `${releaseSet}-${COMMIT.slice(0, 12)}-${"a".repeat(32)}`),
      ]);
      assert.throws(() => realpathSync(releaseRoot));
      assert.equal(realpathSync(sibling), sibling);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("discard rejects a local root of another commit and a verifier report for another set", async () => {
  const root = sandbox();
  try {
    const foreign = staged(root, "local-222222222222");
    await assert.rejects(discardStagedRelease({
      root,
      releaseRoot: foreign,
      sourceCommit: COMMIT,
      verifier: verifierFor("local-222222222222"),
      tokenFactory: () => "d".repeat(32),
    }), /Staged release discard failed safely/u);
    assert.equal(realpathSync(foreign), foreign);

    const releaseRoot = staged(root);
    for (const report of [
      { schemaVersion: 2, ok: true, releaseSet: "release-2026-10-03.2", sourceCommit: COMMIT, artifacts: 8 },
      { schemaVersion: 1, ok: true, releaseSet: SET, sourceCommit: COMMIT, artifacts: 19 },
      { schemaVersion: 2, ok: true, releaseSet: SET, sourceCommit: COMMIT, artifacts: 0 },
    ]) {
      await assert.rejects(discardStagedRelease({
        root,
        releaseRoot,
        sourceCommit: COMMIT,
        verifier: () => report,
        tokenFactory: () => "e".repeat(32),
      }), /Staged release discard failed safely/u);
      assert.equal(realpathSync(releaseRoot), releaseRoot);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discard rejects symlinks and verifier failures without removing evidence", async () => {
  const root = sandbox();
  const outside = sandbox();
  try {
    const releaseParent = resolve(root, ".artifacts/release");
    mkdirSync(releaseParent, { recursive: true });
    symlinkSync(outside, resolve(releaseParent, SET));
    await assert.rejects(discardStagedRelease({
      root,
      releaseRoot: resolve(releaseParent, SET),
      sourceCommit: COMMIT,
      verifier: verifierFor(SET),
      tokenFactory: () => "b".repeat(32),
    }), /Staged release discard failed safely/u);
    assert.equal(realpathSync(outside), outside);

    rmSync(resolve(releaseParent, SET));
    const releaseRoot = staged(root);
    await assert.rejects(discardStagedRelease({
      root,
      releaseRoot,
      sourceCommit: COMMIT,
      verifier: () => { throw new Error("private mismatch"); },
      tokenFactory: () => "c".repeat(32),
    }), /Staged release discard failed safely/u);
    assert.equal(realpathSync(releaseRoot), releaseRoot);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("discard CLI sanitizes all failures", async () => {
  const failed = await runDiscardStagedCli([
    "--release-root", `.artifacts/release/${SET}`, "--source-commit", COMMIT,
  ], {
    root: "/workspace/gauntlet",
    discard: async () => { throw new Error("private retained data"); },
  });
  assert.deepEqual(failed, {
    exitCode: 1,
    stdout: "",
    stderr: '{"error":{"code":"DISCARD_FAILED","message":"Staged release discard failed safely"},"ok":false}\n',
  });
  const invalid = await runDiscardStagedCli([
    "--release-root", ".artifacts/release/0.1.0", "--source-commit", COMMIT,
  ], { root: "/workspace/gauntlet", discard: async () => assert.fail("must not discard") });
  assert.equal(invalid.exitCode, 2);
});
