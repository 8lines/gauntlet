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

const VERSION = "0.1.0";
const COMMIT = "1".repeat(40);

function sandbox() {
  return realpathSync(mkdtempSync(resolve(tmpdir(), "gauntlet-discard-test-")));
}

function staged(root) {
  const releaseRoot = resolve(root, ".artifacts/release", VERSION);
  mkdirSync(releaseRoot, { recursive: true, mode: 0o700 });
  writeFileSync(resolve(releaseRoot, "evidence"), "release evidence\n");
  return releaseRoot;
}

function verifier(options) {
  assert.deepEqual(options, { outputDirectory: options.outputDirectory, version: VERSION, sourceCommit: COMMIT });
  return Object.freeze({ schemaVersion: 1, ok: true, artifacts: 19, version: VERSION, sourceCommit: COMMIT });
}

test("discard CLI parser accepts only one exact in-repository stage and commit", () => {
  const root = "/workspace/gauntlet";
  assert.deepEqual(parseDiscardStagedArguments([
    "--release-root", ".artifacts/release/0.1.0", "--source-commit", COMMIT,
  ], root), {
    releaseRoot: "/workspace/gauntlet/.artifacts/release/0.1.0",
    sourceCommit: COMMIT,
  });
  for (const argv of [
    [],
    ["--release-root", "/tmp/other", "--source-commit", COMMIT],
    ["--release-root", ".artifacts/release/../secret", "--source-commit", COMMIT],
    ["--release-root", ".artifacts/release/0.1.0", "--source-commit", "short"],
    ["--source-commit", COMMIT, "--release-root", ".artifacts/release/0.1.0"],
  ]) assert.throws(() => parseDiscardStagedArguments(argv, root), /Usage: discard-staged\.mjs/u);
});

test("discard removes only a verified exact staged root and leaves siblings untouched", async () => {
  const root = sandbox();
  try {
    const releaseRoot = staged(root);
    const sibling = resolve(root, ".artifacts/release/0.2.0");
    mkdirSync(sibling, { recursive: true });
    writeFileSync(resolve(sibling, "keep"), "keep\n");
    const report = await discardStagedRelease({
      root,
      releaseRoot,
      sourceCommit: COMMIT,
      verifier,
      tokenFactory: () => "a".repeat(32),
    });
    assert.deepEqual(report, {
      schemaVersion: 1,
      ok: true,
      removed: `.artifacts/release/${VERSION}`,
      version: VERSION,
      sourceCommit: COMMIT,
    });
    assert.throws(() => realpathSync(releaseRoot));
    assert.equal(realpathSync(sibling), sibling);
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
    symlinkSync(outside, resolve(releaseParent, VERSION));
    await assert.rejects(discardStagedRelease({
      root,
      releaseRoot: resolve(releaseParent, VERSION),
      sourceCommit: COMMIT,
      verifier,
      tokenFactory: () => "b".repeat(32),
    }), /Staged release discard failed safely/u);
    assert.equal(realpathSync(outside), outside);

    rmSync(resolve(releaseParent, VERSION));
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
    "--release-root", ".artifacts/release/0.1.0", "--source-commit", COMMIT,
  ], {
    root: "/workspace/gauntlet",
    discard: async () => { throw new Error("private retained data"); },
  });
  assert.deepEqual(failed, {
    exitCode: 1,
    stdout: "",
    stderr: '{"error":{"code":"DISCARD_FAILED","message":"Staged release discard failed safely"},"ok":false}\n',
  });
});
