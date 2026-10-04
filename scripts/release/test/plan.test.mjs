import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RELEASE_GATES, allUnitsPlan, buildReleasePlan, compareVersions, createReleasePlan, isReleaseTagName,
  latestUnitVersion, localReleaseSetId, parseReleasePlan, parseReleaseSetId, parseTagListing, planGates,
  readReleasePlan, resolveReleasePlan, runPlanCli, serializeReleasePlan, unitIdForArtifact,
  validatePlanAgainstManifests, validatePlanAgainstTags,
} from "../plan.mjs";
import { RELEASE_UNITS, unitTag } from "../units.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "f".repeat(40);
const BASE = "e".repeat(40);
const DASHBOARD = Object.freeze({ gauntlet: "0.1.9", skills: "0.1.9" });
const CASCADE = Object.freeze({
  protocol: "0.2.0", "dashboard-client": "0.1.9", "typescript-core": "0.1.9", "typescript-node": "0.1.9",
  "next-adapter": "0.1.9", "conformance-runner": "0.1.9", gauntlet: "0.1.9", skills: "0.1.9",
});
const DASHBOARD_GATES = ["node", "dashboard", "widget", "widget-panel", "deployment", "skills", "security"];

function versionsAt(version, overrides = {}) {
  return new Map(RELEASE_UNITS.map(({ id }) => [id, overrides[id] ?? version]));
}

function baselineTags(version = "0.1.8") {
  return new Map(RELEASE_UNITS.map((unit) => [unitTag(unit, version), BASE]));
}

test("plans exactly the units whose manifest version moved past their latest tag", () => {
  const plan = buildReleasePlan(versionsAt("0.1.8", DASHBOARD), baselineTags());
  assert.deepEqual(plan, {
    schemaVersion: 1,
    units: [{ id: "gauntlet", from: "0.1.8", to: "0.1.9" }, { id: "skills", from: "0.1.8", to: "0.1.9" }],
    order: ["gauntlet", "skills"],
  });
  assert.equal(Object.isFrozen(plan.units[0]), true);
  assert.deepEqual(buildReleasePlan(versionsAt("0.1.8"), baselineTags()).units, []);
});

test("orders a protocol cascade dependencies first", () => {
  const plan = buildReleasePlan(versionsAt("0.1.8", CASCADE), baselineTags());
  assert.deepEqual(plan.order, [
    "protocol", "dashboard-client", "gauntlet", "typescript-core", "typescript-node", "next-adapter",
    "conformance-runner", "skills",
  ]);
  assert.deepEqual(plan.units.map(({ id }) => id), plan.order);
  assert.deepEqual(plan.units[0], { id: "protocol", from: "0.1.8", to: "0.2.0" });
});

test("uses the highest semantic version tag per unit and ignores non-release tags", () => {
  const tags = baselineTags();
  for (const name of ["protocol-v0.1.10", "protocol-v0.1.9", "protocol-v0.1.9-rc.1", "v0.1.10"]) tags.set(name, OTHER);
  assert.equal(latestUnitVersion("protocol", tags), "0.1.10");
  assert.equal(latestUnitVersion("gauntlet", tags), "0.1.10");
  assert.equal(latestUnitVersion("gauntlet", tags, { excludeTag: "v0.1.10" }), "0.1.8");
  assert.equal(latestUnitVersion("widget", new Map()), null);
  assert.equal(compareVersions("0.1.10", "0.1.9"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("0.9.9", "1.0.0"), -1);
});

test("a manifest behind its latest tag cannot be planned", () => {
  assert.throws(() => buildReleasePlan(versionsAt("0.1.8", { widget: "0.1.7" }), baselineTags()), /Release plan is invalid/u);
});

test("plan files round-trip only in canonical form", () => {
  const plan = createReleasePlan([{ id: "skills", from: "0.1.8", to: "0.1.9" }, { id: "gauntlet", from: "0.1.8", to: "0.1.9" }]);
  const source = serializeReleasePlan(plan);
  assert.equal(source, `${JSON.stringify({ schemaVersion: 1, units: plan.units, order: ["gauntlet", "skills"] }, null, 2)}\n`);
  assert.deepEqual(parseReleasePlan(source), plan);
  const canonical = (value) => `${JSON.stringify(value, null, 2)}\n`;
  for (const bad of [
    source.slice(0, -1),
    source.replace('"schemaVersion": 1', '"schemaVersion": 2'),
    canonical({ schemaVersion: 1, units: plan.units, order: ["skills", "gauntlet"] }),
    canonical({ schemaVersion: 1, units: [...plan.units].reverse(), order: plan.order }),
    canonical({ schemaVersion: 1, units: [{ id: "gauntlet", from: "0.1.8", to: "0.1.9-rc.1" }], order: ["gauntlet"] }),
    canonical({ schemaVersion: 1, units: [{ id: "nope", from: null, to: "1.0.0" }], order: ["nope"] }),
    canonical({ schemaVersion: 1, units: [{ id: "widget", from: "0.2.0", to: "0.1.9" }], order: ["widget"] }),
    canonical({ schemaVersion: 1, units: [{ id: "widget", from: null, to: "0.1.9", extra: true }], order: ["widget"] }),
    canonical({ schemaVersion: 1, units: [], order: [], extra: true }),
  ]) assert.throws(() => parseReleasePlan(bad), /Release plan is invalid/u);
});

test("the all-units plan covers the whole catalog at current versions", () => {
  const plan = allUnitsPlan(versionsAt("0.1.8"));
  assert.equal(plan.units.length, 13);
  assert.ok(plan.units.every(({ from, to }) => from === null && to === "0.1.8"));
});

test("plan versions must equal manifest versions", () => {
  const plan = buildReleasePlan(versionsAt("0.1.8", DASHBOARD), baselineTags());
  assert.deepEqual(validatePlanAgainstManifests(plan, versionsAt("0.1.8", DASHBOARD)), []);
  assert.deepEqual(validatePlanAgainstManifests(plan, versionsAt("0.1.8", { gauntlet: "0.1.10", skills: "0.1.9" })), [
    "gauntlet: plan version 0.1.9 does not equal manifest version 0.1.10",
  ]);
});

test("tag validation rejects untagged dependencies, unplanned moves, stale starts and foreign tags", () => {
  const tags = baselineTags();
  const cascadeVersions = versionsAt("0.1.8", CASCADE);
  assert.deepEqual(validatePlanAgainstTags(buildReleasePlan(cascadeVersions, tags), { versions: cascadeVersions, tags }), []);

  const partial = createReleasePlan([{ id: "typescript-node", from: "0.1.8", to: "0.1.9" }]);
  assert.deepEqual(validatePlanAgainstTags(partial, {
    versions: versionsAt("0.1.8", { protocol: "0.2.0", "typescript-node": "0.1.9" }),
    tags,
  }), [
    "typescript-node: dependency protocol 0.2.0 is neither planned nor tagged",
    "protocol: version 0.2.0 is neither planned nor tagged",
  ]);

  const dashboardVersions = versionsAt("0.1.8", DASHBOARD);
  const stale = createReleasePlan([{ id: "gauntlet", from: "0.1.7", to: "0.1.9" }, { id: "skills", from: "0.1.8", to: "0.1.9" }]);
  assert.deepEqual(validatePlanAgainstTags(stale, { versions: dashboardVersions, tags }), [
    "gauntlet: plan starts from 0.1.7 but the latest tag is 0.1.8",
  ]);

  const dashboard = buildReleasePlan(dashboardVersions, tags);
  const foreign = new Map(tags).set("skills-v0.1.9", OTHER);
  assert.deepEqual(validatePlanAgainstTags(dashboard, { versions: dashboardVersions, tags: foreign, commit: COMMIT }), [
    "skills: tag skills-v0.1.9 already exists at another commit",
  ]);
  const rerun = new Map(tags).set("v0.1.9", COMMIT).set("skills-v0.1.9", COMMIT);
  assert.deepEqual(validatePlanAgainstTags(dashboard, { versions: dashboardVersions, tags: rerun, commit: COMMIT }), []);
  assert.deepEqual(validatePlanAgainstTags(dashboard, { versions: dashboardVersions, tags: rerun }), [
    "gauntlet: tag v0.1.9 already exists at another commit",
    "skills: tag skills-v0.1.9 already exists at another commit",
  ]);
});

test("gates are the union of the planned units' gates in workflow order", () => {
  assert.deepEqual(planGates(buildReleasePlan(versionsAt("0.1.8", DASHBOARD), baselineTags())), DASHBOARD_GATES);
  assert.deepEqual(planGates(createReleasePlan([{ id: "php-core", from: "0.1.8", to: "0.1.9" }])), ["php", "conformance"]);
  for (const unit of RELEASE_UNITS) {
    for (const gate of unit.gates) assert.ok(RELEASE_GATES.includes(gate), `${unit.id} ${gate}`);
  }
});

test("release set ids are release tags with a real date or the local commit prefix", () => {
  assert.equal(isReleaseTagName("release-2026-10-03.1"), true);
  for (const bad of [
    "release-2026-02-30.1", "release-2026-10-03.0", "release-2026-10-03", "release-2026-10-3.1",
    "release-2026-10-03.1000", "v0.1.8",
  ]) assert.equal(isReleaseTagName(bad), false, bad);
  assert.equal(localReleaseSetId(COMMIT), "local-0123456789ab");
  assert.equal(parseReleaseSetId("local-0123456789ab", COMMIT), "local-0123456789ab");
  assert.equal(parseReleaseSetId("release-2026-10-03.2", COMMIT), "release-2026-10-03.2");
  assert.throws(() => parseReleaseSetId("local-ffffffffffff", COMMIT), /Release set id must be/u);
  assert.throws(() => parseReleaseSetId("../x"), /Release set id must be/u);
});

test("peeled tag listings resolve annotated and lightweight tags to commits", () => {
  const listing = `v0.1.8\0${"a".repeat(40)}\0${COMMIT}\nprotocol-v0.1.8\0${COMMIT}\0\n`;
  assert.deepEqual([...parseTagListing(listing)], [["v0.1.8", COMMIT], ["protocol-v0.1.8", COMMIT]]);
  assert.throws(() => parseTagListing("broken\n"), /tags are unreadable/u);
});

test("maps every published artifact name to its unit", () => {
  assert.equal(unitIdForArtifact("@8lines/gauntlet-typescript-node"), "typescript-node");
  assert.equal(unitIdForArtifact("ghcr.io/8lines/gauntlet"), "gauntlet");
  assert.equal(unitIdForArtifact("dev.eightlines.gauntlet:core"), "java-core");
  assert.throws(() => unitIdForArtifact("left-pad"), /no release unit/u);
});

test("plan files are regular in-repository files and an absent default plan means all units", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gauntlet-plan-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const readVersions = () => versionsAt("0.1.8", DASHBOARD);
  const fallback = resolveReleasePlan(root, null, { readVersions });
  assert.equal(fallback.path, null);
  assert.equal(fallback.plan.units.length, 13);
  assert.throws(() => resolveReleasePlan(root, ".release/plan.json", { readVersions }), /Release plan is missing/u);
  mkdirSync(join(root, ".release"));
  const plan = buildReleasePlan(readVersions(), baselineTags());
  writeFileSync(join(root, ".release/plan.json"), serializeReleasePlan(plan));
  assert.deepEqual(resolveReleasePlan(root, null, { readVersions }), { plan, path: ".release/plan.json" });
  assert.deepEqual(readReleasePlan(root), plan);
  symlinkSync(join(root, ".release/plan.json"), join(root, "linked.json"));
  assert.throws(() => readReleasePlan(root, "linked.json"), /Release plan is missing/u);
  assert.throws(() => readReleasePlan(root, "../plan.json"), /Release plan path/u);
});

test("the plan CLI writes the computed plan and checks a committed one", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gauntlet-plan-cli-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const readVersions = () => versionsAt("0.1.8", DASHBOARD);
  const readTags = () => baselineTags();
  const units = [{ id: "gauntlet", from: "0.1.8", to: "0.1.9" }, { id: "skills", from: "0.1.8", to: "0.1.9" }];

  const written = runPlanCli(["--write"], { root, readVersions, readTags });
  assert.equal(written.exitCode, 0, written.stderr);
  assert.deepEqual(JSON.parse(written.stdout), {
    command: "write", path: ".release/plan.json", units, order: ["gauntlet", "skills"], gates: DASHBOARD_GATES,
  });
  assert.equal(readFileSync(join(root, ".release/plan.json"), "utf8"), serializeReleasePlan(buildReleasePlan(readVersions(), readTags())));

  const checked = runPlanCli(["--check", "--release-set", "release-2026-10-03.1", "--commit", COMMIT], { root, readVersions, readTags });
  assert.equal(checked.exitCode, 0, checked.stderr);
  assert.deepEqual(JSON.parse(checked.stdout), {
    command: "check", ok: true, releaseSet: "release-2026-10-03.1", units, order: ["gauntlet", "skills"],
    gates: DASHBOARD_GATES, problems: [],
  });

  const drifted = runPlanCli(["--check"], {
    root, readVersions: () => versionsAt("0.1.8", { gauntlet: "0.1.10", skills: "0.1.9" }), readTags,
  });
  assert.equal(drifted.exitCode, 1);
  assert.deepEqual(JSON.parse(drifted.stdout).problems, [
    "gauntlet: plan version 0.1.9 does not equal manifest version 0.1.10",
    "skills: dependency gauntlet 0.1.10 is neither planned nor tagged",
  ]);

  writeFileSync(join(root, ".release/plan.json"), serializeReleasePlan(createReleasePlan([])));
  const empty = runPlanCli(["--check"], { root, readVersions: () => versionsAt("0.1.8"), readTags });
  assert.equal(empty.exitCode, 1);
  assert.deepEqual(JSON.parse(empty.stdout).problems, ["release plan has no units"]);

  for (const argv of [["--check", "--release-set", "v0.1.9"], ["--check", "--commit", "short"], ["--bogus"]]) {
    assert.equal(runPlanCli(argv, { root, readVersions, readTags }).exitCode, 2, argv.join(" "));
  }
});

test("the plan CLI writes an all-units plan only below the ignored artifacts tree", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gauntlet-plan-all-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".release"));
  const committed = serializeReleasePlan(buildReleasePlan(versionsAt("0.1.8", DASHBOARD), baselineTags()));
  writeFileSync(join(root, ".release/plan.json"), committed);
  const readVersions = () => versionsAt("0.1.8", DASHBOARD);
  const readTags = () => { throw new Error("tags are not needed for an all-units plan"); };
  const path = ".artifacts/ci/all-units-plan.json";

  const written = runPlanCli(["--write-all-units", path], { root, readVersions, readTags });
  assert.equal(written.exitCode, 0, written.stderr);
  const plan = allUnitsPlan(readVersions());
  assert.deepEqual(JSON.parse(written.stdout), {
    command: "write-all-units", path, units: plan.units, order: plan.order, gates: planGates(plan),
  });
  assert.equal(readFileSync(join(root, path), "utf8"), serializeReleasePlan(plan));
  assert.deepEqual(readReleasePlan(root, path), plan);
  assert.equal(plan.order.includes("gauntlet"), true);
  assert.equal(readFileSync(join(root, ".release/plan.json"), "utf8"), committed);

  const rewritten = runPlanCli(["--write-all-units", path], { root, readVersions, readTags });
  assert.equal(rewritten.exitCode, 0, rewritten.stderr);

  for (const argv of [
    ["--write-all-units"],
    ["--write-all-units", ".release/plan.json"],
    ["--write-all-units", "plan.json"],
    ["--write-all-units", ".artifacts/ci/plan.txt"],
    ["--write-all-units", ".artifacts/../plan.json"],
    ["--write-all-units", `${root}/.artifacts/ci/plan.json`],
    ["--write-all-units", ".artifacts/ci/plan.json", "--check"],
  ]) {
    assert.equal(runPlanCli(argv, { root, readVersions, readTags }).exitCode, 2, argv.join(" "));
  }

  symlinkSync(join(root, ".release"), join(root, ".artifacts/linked"));
  const linked = runPlanCli(["--write-all-units", ".artifacts/linked/plan.json"], { root, readVersions, readTags });
  assert.equal(linked.exitCode, 1);
  assert.equal(readFileSync(join(root, ".release/plan.json"), "utf8"), committed);
});
