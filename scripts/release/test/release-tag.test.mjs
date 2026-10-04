import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { catalogEntries } from "../compatibility.mjs";
import { buildReleasePlan, createReleasePlan, serializeReleasePlan } from "../plan.mjs";
import { nextReleaseTag, releaseTagMessage, runReleaseTagCli } from "../release-tag.mjs";
import { RELEASE_UNITS, unitTag } from "../units.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const NOW = new Date("2026-10-03T23:30:00Z");

function versionsAt(version, overrides = {}) {
  return new Map(RELEASE_UNITS.map(({ id }) => [id, overrides[id] ?? version]));
}

function baselineTags() {
  return new Map(RELEASE_UNITS.map((unit) => [unitTag(unit, "0.1.8"), "e".repeat(40)]));
}

function fixture(t, plan) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gauntlet-release-tag-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (plan !== undefined) {
    mkdirSync(join(root, ".release"));
    writeFileSync(join(root, ".release/plan.json"), serializeReleasePlan(plan));
  }
  return root;
}

function fakeGit({ dirty = false, inMain = true } = {}) {
  const calls = [];
  const created = new Map();
  const git = (args) => {
    calls.push(args);
    const key = args.join(" ");
    if (key === "status --porcelain=v1 --untracked-files=all") return { status: 0, stdout: dirty ? " M VERSION\n" : "", stderr: "" };
    if (key === "rev-parse --verify HEAD^{commit}") return { status: 0, stdout: `${COMMIT}\n`, stderr: "" };
    if (key === `merge-base --is-ancestor ${COMMIT} origin/main`) return { status: inMain ? 0 : 1, stdout: "", stderr: "" };
    if (args[0] === "tag" && args[1] === "--annotate") {
      created.set(args[2], args[5]);
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "rev-parse" && args[2]?.startsWith("refs/tags/")) {
      return { status: 0, stdout: `${created.get(args[2].slice(10, -9))}\n`, stderr: "" };
    }
    if (args[0] === "cat-file" && args[1] === "-t") return { status: 0, stdout: "tag\n", stderr: "" };
    throw new Error(`unexpected git ${key}`);
  };
  return { calls, created, git };
}

const DASHBOARD = { gauntlet: "0.1.9", skills: "0.1.9" };
const dashboardPlan = () => buildReleasePlan(versionsAt("0.1.8", DASHBOARD), baselineTags());
// The ledger as version.mjs --set-unit leaves it: every unit recorded at its manifest version.
const dashboardLedger = () => catalogEntries(versionsAt("0.1.8", DASHBOARD));

test("numbers release-set tags per UTC day", () => {
  const tags = new Map([["release-2026-10-03.1", COMMIT], ["release-2026-10-03.2", COMMIT], ["release-2026-10-02.7", COMMIT]]);
  assert.equal(nextReleaseTag(NOW, tags), "release-2026-10-03.3");
  assert.equal(nextReleaseTag(new Date("2026-10-04T00:00:01Z"), tags), "release-2026-10-04.1");
  assert.equal(releaseTagMessage("release-2026-10-03.1", dashboardPlan()),
    "Release set release-2026-10-03.1\n\ngauntlet 0.1.8 -> 0.1.9\nskills 0.1.8 -> 0.1.9\n");
});

test("creates one local annotated tag on a clean main commit for a releasable plan", (t) => {
  const root = fixture(t, dashboardPlan());
  const { calls, created, git } = fakeGit();
  const tags = baselineTags().set("release-2026-10-03.1", COMMIT);
  const result = runReleaseTagCli([], {
    root, now: NOW, git, readVersions: () => versionsAt("0.1.8", DASHBOARD), readTags: () => tags, readCompatibility: dashboardLedger,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    command: "tag", created: true, tag: "release-2026-10-03.2", commit: COMMIT,
    units: [{ id: "gauntlet", from: "0.1.8", to: "0.1.9" }, { id: "skills", from: "0.1.8", to: "0.1.9" }],
    push: "git push origin refs/tags/release-2026-10-03.2",
  });
  assert.deepEqual([...created], [["release-2026-10-03.2", COMMIT]]);
  assert.ok(!calls.some((args) => args[0] === "push" || args[0] === "fetch"));
});

test("dry run reports without creating a tag", (t) => {
  const root = fixture(t, dashboardPlan());
  const { created, git } = fakeGit();
  const result = runReleaseTagCli(["--dry-run"], {
    root, now: NOW, git, readVersions: () => versionsAt("0.1.8", DASHBOARD), readTags: baselineTags, readCompatibility: dashboardLedger,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).created, false);
  assert.equal(created.size, 0);
});

test("refuses dirty trees, commits outside main, missing or empty plans, drift and existing unit tags", (t) => {
  const readVersions = () => versionsAt("0.1.8", DASHBOARD);
  const cases = [
    [fixture(t, dashboardPlan()), fakeGit({ dirty: true }), readVersions, baselineTags, /Working tree is not clean/u],
    [fixture(t, dashboardPlan()), fakeGit({ inMain: false }), readVersions, baselineTags, /not contained in origin\/main/u],
    [fixture(t), fakeGit(), readVersions, baselineTags, /Release plan is missing/u],
    [fixture(t, createReleasePlan([])), fakeGit(), () => versionsAt("0.1.8"), baselineTags, /Release plan has no units/u],
    [fixture(t, dashboardPlan()), fakeGit(), () => versionsAt("0.1.8", { gauntlet: "0.1.10", skills: "0.1.9" }), baselineTags,
      /gauntlet: plan version 0.1.9 does not equal manifest version 0.1.10/u],
    [fixture(t, dashboardPlan()), fakeGit(), readVersions, () => baselineTags().set("skills-v0.1.9", "f".repeat(40)),
      /skills: tag skills-v0.1.9 already exists/u],
  ];
  for (const [root, { created, git }, versions, tags, message] of cases) {
    const result = runReleaseTagCli([], { root, now: NOW, git, readVersions: versions, readTags: tags, readCompatibility: dashboardLedger });
    assert.equal(result.exitCode, 1);
    assert.match(JSON.parse(result.stderr).error.message, message);
    assert.equal(created.size, 0);
  }
  assert.equal(runReleaseTagCli(["--push"], { root: fixture(t), now: NOW }).exitCode, 2);
});

test("refuses a plan whose compatibility ledger is stale or missing before creating a tag", (t) => {
  const readVersions = () => versionsAt("0.1.8", DASHBOARD);
  const stale = () => catalogEntries(versionsAt("0.1.8", { skills: "0.1.9" }));
  for (const [readCompatibility, message] of [
    [stale, /^Release plan is not releasable: docs\/reference\/compatibility\.md: gauntlet is recorded at 0\.1\.8 but its manifest version is 0\.1\.9$/u],
    [undefined, /^Release plan is not releasable: docs\/reference\/compatibility\.md is missing or unsafe$/u],
  ]) {
    const { created, git } = fakeGit();
    const result = runReleaseTagCli([], { root: fixture(t, dashboardPlan()), now: NOW, git, readVersions, readTags: baselineTags, readCompatibility });
    assert.equal(result.exitCode, 1);
    assert.match(JSON.parse(result.stderr).error.message, message);
    assert.equal(created.size, 0);
  }
});
