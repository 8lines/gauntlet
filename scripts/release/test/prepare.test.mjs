import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { changelogPath, newUnitChangelog } from "../changelog.mjs";
import { COMPATIBILITY_PATH, catalogEntries, renderCompatibilityDocument } from "../compatibility.mjs";
import { parseReleasePlan } from "../plan.mjs";
import { prepareRelease, runPrepareCli } from "../prepare.mjs";
import { readUnitVersion } from "../release-model.mjs";
import { RELEASE_UNITS, unitTag } from "../units.mjs";
import { createVersionFixture } from "./version-fixture.mjs";

const NOW = new Date("2026-10-04T12:00:00.000Z");
const TAGGED = "e".repeat(40);

function git(root, ...args) {
  const result = spawnSync("git", [
    "-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function baselineTags(version = "0.1.8", skip = []) {
  return new Map(RELEASE_UNITS.filter(({ id }) => !skip.includes(id)).map((unit) => [unitTag(unit, version), TAGGED]));
}

function change(units, type = "fixed", body = "Sidebar keeps its width.") {
  return `---\ntype: ${type}\nunits:\n${Object.entries(units).map(([id, bump]) => `  ${id}: ${bump}`).join("\n")}\n---\n${body}\n`;
}

function repository(t, changes) {
  const root = createVersionFixture("0.1.8");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n\n## Unreleased\n\n## [0.1.8] - 2026-10-03\n\n### Fixed\n\n- Baseline.\n");
  for (const { id } of RELEASE_UNITS) if (id !== "gauntlet") writeFileSync(join(root, changelogPath(id)), newUnitChangelog(id));
  mkdirSync(join(root, "docs/reference"), { recursive: true });
  writeFileSync(join(root, COMPATIBILITY_PATH), renderCompatibilityDocument(catalogEntries(new Map(RELEASE_UNITS.map(({ id }) => [id, "0.1.8"])))));
  mkdirSync(join(root, ".changes"));
  for (const [name, source] of Object.entries(changes)) writeFileSync(join(root, ".changes", name), source);
  git(root, "init", "--initial-branch=main");
  git(root, "add", "-A");
  git(root, "commit", "-m", "baseline");
  git(root, "switch", "-c", "release/next");
  return root;
}

function recorder() {
  const calls = { repin: [], rebind: [] };
  return {
    calls,
    repinComposer: ({ moved, versions }) => {
      calls.repin.push({ moved: [...moved], versions: Object.fromEntries(versions) });
      return [];
    },
    rebind: async ({ reason, date }) => {
      calls.rebind.push({ reason, date });
      return { skills: [] };
    },
  };
}

function status(root) {
  return git(root, "status", "--porcelain=v1", "--untracked-files=all");
}

test("a dashboard-only change prepares the application and the skills archive with no hand edits", async (t) => {
  const root = repository(t, { "sidebar.md": change({ gauntlet: "patch" }) });
  const { calls, repinComposer, rebind } = recorder();
  const summary = await prepareRelease({ root, now: NOW, readTags: () => baselineTags(), repinComposer, rebind });
  assert.deepEqual(summary, {
    command: "prepare", ok: true, date: "2026-10-04",
    units: [
      { id: "gauntlet", from: "0.1.8", to: "0.1.9", bump: "patch", cascaded: false },
      { id: "skills", from: "0.1.8", to: "0.1.9", bump: "patch", cascaded: true },
    ],
    order: ["gauntlet", "skills"], changes: ["sidebar.md"], composerLocks: [],
  });
  assert.equal(readUnitVersion(root, "gauntlet"), "0.1.9");
  assert.equal(readUnitVersion(root, "skills"), "0.1.9");
  assert.equal(readUnitVersion(root, "protocol"), "0.1.8");
  assert.match(readFileSync(join(root, "deploy/helm/README.md"), "utf8"), /--version 0\.1\.9 --destination/u);
  assert.match(readFileSync(join(root, "CHANGELOG.md"), "utf8"),
    /## Unreleased\n\n## \[0\.1\.9\] - 2026-10-04\n\n### Fixed\n\n- Sidebar keeps its width\.\n\n## \[0\.1\.8\]/u);
  assert.match(readFileSync(join(root, "skills/CHANGELOG.md"), "utf8"),
    /## \[0\.1\.9\] - 2026-10-04\n\n### Changed\n\n- Updated `gauntlet` to 0\.1\.9\.\n$/u);
  assert.equal(existsSync(join(root, ".changes/sidebar.md")), false);
  assert.deepEqual(parseReleasePlan(readFileSync(join(root, ".release/plan.json"), "utf8")), {
    schemaVersion: 1,
    units: [{ id: "gauntlet", from: "0.1.8", to: "0.1.9" }, { id: "skills", from: "0.1.8", to: "0.1.9" }],
    order: ["gauntlet", "skills"],
    changes: ["sidebar.md"],
  });
  assert.match(readFileSync(join(root, COMPATIBILITY_PATH), "utf8"), /^\| `gauntlet` \| 0\.1\.9 \|/mu);
  assert.deepEqual(calls.repin.map(({ moved }) => moved), [["gauntlet", "skills"]]);
  assert.deepEqual(calls.rebind, [{ reason: "Release preparation moved gauntlet to 0.1.9, skills to 0.1.9.", date: "2026-10-04" }]);
});

test("a protocol minor release cascades through every dependent in one prepared plan", async (t) => {
  const root = repository(t, { "deadline.md": change({ protocol: "minor" }, "added", "Run requests accept an optional deadline.") });
  const { repinComposer, rebind } = recorder();
  const summary = await prepareRelease({ root, now: NOW, readTags: () => baselineTags(), repinComposer, rebind });
  assert.deepEqual(summary.units.map(({ id, to }) => [id, to]), [
    ["protocol", "0.2.0"], ["dashboard-client", "0.1.9"], ["gauntlet", "0.1.9"], ["typescript-core", "0.1.9"],
    ["typescript-node", "0.1.9"], ["next-adapter", "0.1.9"], ["conformance-runner", "0.1.9"], ["skills", "0.1.9"],
  ]);
  assert.match(readFileSync(join(root, "CHANGELOG.md"), "utf8"),
    /### Changed\n\n- Updated `protocol` to 0\.2\.0\.\n- Updated `dashboard-client` to 0\.1\.9\.\n/u);
  assert.match(readFileSync(join(root, "packages/protocol/CHANGELOG.md"), "utf8"),
    /## \[0\.2\.0\] - 2026-10-04\n\n### Added\n\n- Run requests accept an optional deadline\.\n/u);
  assert.match(readFileSync(join(root, "docs/releases/installing-packages.md"), "utf8"), /pnpm add @8lines\/gauntlet-protocol@0\.2\.0 /u);
  assert.equal(readUnitVersion(root, "php-core"), "0.1.8");
});

test("a php-core release re-pins Composer and moves the bundle and its constraint", async (t) => {
  const root = repository(t, { "timeouts.md": change({ "php-core": "patch" }, "fixed", "PHP Core reports adapter timeouts with the request id.") });
  const { calls, repinComposer, rebind } = recorder();
  const summary = await prepareRelease({ root, now: NOW, readTags: () => baselineTags(), repinComposer, rebind });
  assert.deepEqual(summary.order, ["php-core", "symfony-bundle", "skills"]);
  assert.deepEqual(calls.repin.map(({ moved }) => moved), [["php-core", "symfony-bundle", "skills"]]);
  assert.equal(calls.repin[0].versions["php-core"], "0.1.9");
  const bundle = JSON.parse(readFileSync(join(root, "packages/php/symfony-bundle/composer.json"), "utf8"));
  assert.deepEqual([bundle.version, bundle.require["8lines/gauntlet-php-core"]], ["0.1.9", "^0.1.9"]);
  assert.deepEqual(JSON.parse(readFileSync(join(root, "examples/symfony/composer.json"), "utf8")).require, {
    "8lines/gauntlet-php-core": "^0.1.9", "8lines/gauntlet-symfony-bundle": "^0.1.9",
  });
});

test("refuses unsafe starting points and leaves the tree untouched", async (t) => {
  const { repinComposer, rebind } = recorder();
  const prepare = (root, readTags = () => baselineTags()) => prepareRelease({ root, now: NOW, readTags, repinComposer, rebind });

  const empty = repository(t, {});
  await assert.rejects(prepare(empty), /found no change files in \.changes/u);
  assert.equal(status(empty), "");

  const noneOnly = repository(t, { "refactor.md": change({ protocol: "none" }, "changed", "Reformatted sources.") });
  await assert.rejects(prepare(noneOnly), /no change file that releases a unit/u);
  assert.equal(existsSync(join(noneOnly, ".changes/refactor.md")), true);

  const stale = repository(t, { "sidebar.md": change({ gauntlet: "patch" }) });
  await assert.rejects(prepare(stale, () => baselineTags("0.1.8", ["protocol"])), /run git fetch --tags origin.*protocol has no release tag/u);
  const behind = new Map([...baselineTags("0.1.8", ["gauntlet"]), ["v0.1.7", TAGGED]]);
  await assert.rejects(prepare(stale, () => behind), /gauntlet is at 0\.1\.8 but its latest tag is 0\.1\.7/u);
  assert.equal(status(stale), "");

  const dirty = repository(t, { "sidebar.md": change({ gauntlet: "patch" }) });
  writeFileSync(join(dirty, "deploy/helm/README.md"), "local edit\n");
  await assert.rejects(prepare(dirty), /Tracked files have local modifications/u);
  assert.equal(readFileSync(join(dirty, "deploy/helm/README.md"), "utf8"), "local edit\n");

  const uncommitted = repository(t, { "sidebar.md": change({ gauntlet: "patch" }) });
  writeFileSync(join(uncommitted, ".changes/late.md"), change({ widget: "patch" }));
  await assert.rejects(prepare(uncommitted), /Commit every change file/u);

  const onMain = repository(t, { "sidebar.md": change({ gauntlet: "patch" }) });
  git(onMain, "switch", "main");
  await assert.rejects(prepare(onMain), /on a branch from main/u);
});

test("a failure after the first write restores every tracked file and keeps the change files", async (t) => {
  const root = repository(t, { "sidebar.md": change({ gauntlet: "patch" }) });
  await assert.rejects(prepareRelease({
    root, now: NOW, readTags: () => baselineTags(), repinComposer: () => [],
    rebind: async () => {
      throw new Error("Evaluation receipts could not be re-bound: injected");
    },
  }), /injected/u);
  assert.equal(status(root), "");
  assert.equal(existsSync(join(root, ".changes/sidebar.md")), true);
  assert.equal(existsSync(join(root, ".release")), false);
  assert.equal(readUnitVersion(root, "gauntlet"), "0.1.8");
});

test("a Composer failure after the versions moved restores the tree and removes every file it created", async (t) => {
  const root = repository(t, { "timeouts.md": change({ "php-core": "patch" }, "fixed", "PHP Core reports adapter timeouts.") });
  let seen = null;
  await assert.rejects(prepareRelease({
    root, now: NOW, readTags: () => baselineTags(), rebind: recorder().rebind,
    repinComposer: ({ versions }) => {
      seen = versions.get("php-core");
      writeFileSync(join(root, "packages/php/core/composer.lock"), "{}\n");
      mkdirSync(join(root, "packages/php/core/vendor-scratch"));
      writeFileSync(join(root, "packages/php/core/vendor-scratch/partial.json"), "{}\n");
      throw new Error("Composer could not re-pin packages/php/core/composer.lock");
    },
  }), /Composer could not re-pin/u);
  assert.equal(seen, "0.1.9");
  assert.equal(status(root), "");
  assert.equal(existsSync(join(root, ".changes/timeouts.md")), true);
  assert.equal(existsSync(join(root, "packages/php/core/vendor-scratch")), false);
  assert.equal(readUnitVersion(root, "php-core"), "0.1.8");
});

test("a failure restores a previously released plan instead of deleting it", async (t) => {
  const root = repository(t, { "sidebar.md": change({ gauntlet: "patch" }) });
  const released = "{\n  \"schemaVersion\": 1,\n  \"units\": [\n    {\n      \"id\": \"widget\",\n      \"from\": \"0.1.7\",\n      \"to\": \"0.1.8\"\n    }\n  ],\n  \"order\": [\n    \"widget\"\n  ]\n}\n";
  mkdirSync(join(root, ".release"));
  writeFileSync(join(root, ".release/plan.json"), released);
  git(root, "add", ".release/plan.json");
  git(root, "commit", "-m", "released plan");
  await assert.rejects(prepareRelease({
    root, now: NOW, readTags: () => baselineTags(), repinComposer: () => [],
    rebind: async () => {
      assert.match(readFileSync(join(root, ".release/plan.json"), "utf8"), /"to": "0\.1\.9"/u);
      throw new Error("Evaluation receipts could not be re-bound: injected");
    },
  }), /injected/u);
  assert.equal(status(root), "");
  assert.equal(readFileSync(join(root, ".release/plan.json"), "utf8"), released);
});

test("an unreleased prepared plan is refused before anything is written", async (t) => {
  const root = repository(t, { "sidebar.md": change({ gauntlet: "patch" }) });
  const { calls, repinComposer, rebind } = recorder();
  const previous = new Map([...baselineTags("0.1.8", ["php-core"]), ["php-core-v0.1.7", TAGGED]]);
  await assert.rejects(prepareRelease({ root, now: NOW, readTags: () => previous, repinComposer, rebind }),
    /^Error: Release preparation needs every unit at its latest tag; run git fetch --tags origin, and release an already prepared plan first: php-core is at 0\.1\.8 but its latest tag is 0\.1\.7$/u);
  assert.equal(status(root), "");
  assert.deepEqual(calls, { repin: [], rebind: [] });
});

test("a staged but uncommitted change file is refused", async (t) => {
  const root = repository(t, {});
  writeFileSync(join(root, ".changes/sidebar.md"), change({ gauntlet: "patch" }));
  git(root, "add", ".changes/sidebar.md");
  const { repinComposer, rebind } = recorder();
  await assert.rejects(prepareRelease({ root, now: NOW, readTags: () => baselineTags(), repinComposer, rebind }),
    /Tracked files have local modifications|Commit every change file/u);
  assert.equal(readUnitVersion(root, "gauntlet"), "0.1.8");
});

test("the CLI takes no arguments and prints one JSON summary", async (t) => {
  const root = repository(t, { "sidebar.md": change({ widget: "patch" }, "fixed", "The widget button keeps focus.") });
  const { repinComposer, rebind } = recorder();
  assert.equal((await runPrepareCli(["--dry-run"])).exitCode, 2);
  const result = await runPrepareCli([], { root, now: NOW, readTags: () => baselineTags(), repinComposer, rebind });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout.split("\n").length, 2);
  assert.deepEqual(JSON.parse(result.stdout).order, ["widget"]);
  const again = await runPrepareCli([], { root, now: NOW, readTags: () => baselineTags(), repinComposer, rebind });
  assert.equal(again.exitCode, 1);
  assert.equal(again.stdout, "");
  assert.deepEqual(JSON.parse(again.stderr), {
    error: { code: "PREPARE_FAILED", message: "Tracked files have local modifications; commit or stash them before preparing a release" },
    ok: false,
  });
});
