# Release units, phase 2: plan-driven publishing

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a release set described by a committed `.release/plan.json`. One annotated `release-YYYY-MM-DD.N` tag starts one workflow run that runs only the gates the planned units declare, stages and inventories only the planned units, preflights each unit separately, publishes in dependency order, and gives every unit its own tag, GitHub Release and evidence. The last task turns the lockstep guard off.

**Architecture:** New `scripts/release/plan.mjs` (plan model, release-set ids, tag validation, gates, `release:plan`), `scripts/release/release-tag.mjs` (`release:tag`) and `scripts/release/release-set.mjs` (small queries the workflow needs: outputs, unit fields, assets, notes). Existing tooling becomes unit-aware: stagers take explicit versions; `stage.mjs` stages plan units into `.artifacts/release/<set-id>`; `inventory.mjs` writes manifest schema 2 with per-unit artifact identity; `check-published.mjs` derives evidence, state, receipts and GitHub Release checks per unit; `publish-composer.mjs` publishes one unit; `verify.mjs` and `dry-run.mjs` run only the phases the plan needs. `release.yml` triggers on `release-*`, a `plan` job computes the gates, gate jobs run conditionally, and `publish` loops the planned units.

**Tech Stack:** Node.js 24 ESM scripts tested with `node:test`, GitHub Actions YAML (policy tests parse it with the `yaml` package), git, `gh`, Docker (Gradle, Composer, registry, skopeo, trivy).

**Spec:** `docs/superpowers/specs/2026-10-03-independent-release-units-design.md` (sections Release units, Publishing, Migration; the Compatibility section is phase 3).

**Roadmap:** phase 1 (merged) unit catalog and per-unit versions; phase 2 (this plan) plan-driven publishing; phase 3 change files, `release:prepare` with cascade, changelogs, compatibility document and the documentation rewrite.

## Global Constraints

- Work on a branch from current `main` (at or after `6662d44`). Commit after every task with the exact message given; every message ends with the line `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Never stage the untracked `design/` or `.playwright-mcp/` directories (always `git add` explicit paths).
- Nothing is published, pushed or tagged remotely by any task. `release:tag` creates local tags only and is exercised only against fakes and temporary repositories.
- Code, comments and file names in English. Node scripts are ESM `.mjs` in the existing `scripts/release` style: frozen data, closed option objects, fixed error messages, no symlink-following reads, one-line JSON CLI output.
- Unit ids (catalog order): `gauntlet`, `protocol`, `dashboard-client`, `typescript-core`, `typescript-node`, `next-adapter`, `conformance-runner`, `widget`, `php-core`, `symfony-bundle`, `java-core`, `spring-boot-starter`, `skills`. Unit tags: `v<version>` for `gauntlet`, `<id>-v<version>` for every other unit (`unitTag` in `scripts/release/units.mjs`). Composer split repositories keep tags `v<that package's version>`.
- Plan file `.release/plan.json`, canonical bytes `JSON.stringify(plan, null, 2) + "\n"`: `{ "schemaVersion": 1, "units": [{ "id", "from", "to" }], "order": [ids] }`; `units` listed in `order`; `order` equals `dependencyOrder(ids)`; `from` is the latest tagged version of that unit or `null` when the unit has no tag; `to` is the manifest version and is greater than `from`.
- Release-set id: a release tag name `release-YYYY-MM-DD.N` (valid UTC calendar date, `N` from 1 to 999) or `local-<first 12 hex characters of the source commit>`. Staging root: `.artifacts/release/<set-id>/` with today's per-kind subdirectories (`npm/`, `composer/artifacts/`, `maven/artifacts/`, `skills/`, `compose/`, `helm/`, `image/`, `sbom/`).
- Release manifest schema 2: `{ schemaVersion: 2, releaseSet, sourceCommit, units: [{ id, version, tag }], artifacts: [{ unit, kind, name, path, sha256 }] }`, units in dependency order, artifacts sorted by kind, name, path. Per-unit artifact identity: one archive for an npm, Composer, Maven or skills unit; seven for `gauntlet` (compose, helm, docker, oci, provenance, two SBOMs).
- Per-unit evidence after finalization: `.artifacts/release/<set-id>/units/<unit>/{release-manifest.json,publication-receipt.json,SHA256SUMS}`. Receipt: `{ schemaVersion: 2, releaseSet, unit, version, sourceCommit, manifestSha256, imageDigest, chartDigest }`, the last two only for `gauntlet`.
- Trigger: `.github/workflows/release.yml` runs only on pushed tags `release-*`; tags `v*.*.*` trigger nothing. The workflow itself creates unit tags. Only the `gauntlet` GitHub Release uses `--latest`; every other release uses `--latest=false`.
- Gate job ids: `node`, `php`, `java`, `conformance`, `dashboard`, `widget`, `widget-panel`, `deployment`, `skills`, `security` (the `gates` arrays in `units.mjs`). `release-metadata` (the dry run) always runs.
- PHP and Java run through Docker as the repository already does (`composer:2`, the pinned Gradle image); never require host PHP or a host JDK.
- `scripts/release/release-model.mjs`, `scripts/release/stage-composer.mjs`, `scripts/release/units.mjs`, root `VERSION`, root `package.json` and `skill-evals/gauntlet-app-integration/prepare-fixture.mjs` are bound skill-evaluation inputs: a task that changes any of them re-binds the receipts in the same commit (the step is spelled out in those tasks). `units.mjs` is not changed by this plan.
- Verification commands: `pnpm release:test`, `node --test scripts/docs/test/*.test.mjs`, `node scripts/docs/check-docs.mjs`, `pnpm skills:validate`, `pnpm skills:test-evals` (needs Docker), `pnpm test:helm`, `pnpm check` at the end.

## Review Focus

1. A staged npm tarball pinning an internal dependency to the wrong version once versions diverge (for example `typescript-node` 0.1.9 depending on its own version or on root `VERSION` instead of `protocol` 0.2.0). Pinned by Task 4 (diverged `stageNpmPackages` test) and Task 6 (protocol cascade staging test).
2. A unit that is partially public (registry artifact present but GitHub Release absent, or the reverse) being treated as clean or identical, or being masked by other units in the set. Pinned by Task 7 (`evaluateUnitState` and `evaluateReleaseSetState` partial cases).
3. A plan that releases a unit whose exact internal dependency is neither planned nor tagged, or that omits a unit whose manifest version moved, passing `plan.mjs --check` or `release:tag`. Pinned by Task 1 (`validatePlanAgainstTags`) and Task 2 (`prepareReleaseTag` refusals).
4. A gate a planned unit needs being skipped, or `publish` running after a needed gate failed or was skipped. Pinned by Task 11 (workflow policy test that derives the exact `publish.if` expression from `RELEASE_GATES`).
5. An inventory or discard that accepts artifacts of an unplanned unit, misses one of the seven application artifacts, or follows a release root whose directory name differs from the manifest's release set. Pinned by Task 6 (inventory identity and discard tests).

---

### Task 1: Release plan model and plan CLI

**Files:**
- Create: `scripts/release/plan.mjs`
- Test: `scripts/release/test/plan.test.mjs`

**Interfaces:**
- Consumes: `parseReleaseVersion`, `readUnitVersions` from `scripts/release/release-model.mjs`; `RELEASE_UNITS`, `dependencyOrder`, `unitById`, `unitTag` from `scripts/release/units.mjs`.
- Produces (all exported from `plan.mjs`):
  - `RELEASE_PLAN_PATH = ".release/plan.json"`; `RELEASE_GATES: readonly string[]` = `["node","php","java","conformance","dashboard","widget","widget-panel","deployment","skills","security"]`.
  - `compareVersions(left: string, right: string): -1 | 0 | 1`.
  - `unitIdForArtifact(name: string): string` (throws `Artifact <name> has no release unit`).
  - `isReleaseTagName(value): boolean`; `localReleaseSetId(sourceCommit: string): string`; `parseReleaseSetId(value, sourceCommit?: string): string` (throws `TypeError` starting `Release set id must be`).
  - `ReleasePlan = Readonly<{ schemaVersion: 1; units: readonly Readonly<{ id: string; from: string | null; to: string }>[]; order: readonly string[] }>`.
  - `createReleasePlan(entries: Iterable<{ id, from, to }>): ReleasePlan`; `serializeReleasePlan(plan): string`; `parseReleasePlan(source: string): ReleasePlan`; `allUnitsPlan(versions: ReadonlyMap<string,string>): ReleasePlan` (every unit, `from: null`). Invalid input throws `Release plan is invalid`.
  - `parseTagListing(output: string): Map<string, string>` (tag name to peeled commit); `readRepositoryTags(root: string): Map<string, string>`.
  - `latestUnitVersion(id: string, tags: ReadonlyMap<string,string>, options?: { excludeTag?: string }): string | null`.
  - `buildReleasePlan(versions, tags): ReleasePlan`.
  - `validatePlanAgainstManifests(plan, versions): string[]`; `validatePlanAgainstTags(plan, { versions, tags, commit? }): string[]` (exact messages in the tests).
  - `planGates(plan): string[]` (subset of `RELEASE_GATES`, in `RELEASE_GATES` order).
  - `readReleasePlan(root, path = RELEASE_PLAN_PATH): ReleasePlan`; `resolveReleasePlan(root, path = null, { readVersions = readUnitVersions } = {}): Readonly<{ plan: ReleasePlan; path: string | null }>` (`path: null` means the in-memory all-units plan); `writeReleasePlan(root, plan): string`.
  - `parsePlanArguments(argv)`, `runPlanCli(argv, { root, readVersions, readTags } = {}): { exitCode, stdout, stderr }`. CLI: `plan.mjs [--write]` writes the plan; `plan.mjs --check [--release-set release-YYYY-MM-DD.N] [--commit SHA]` validates the committed plan. Output is one JSON line; exit 2 for invalid arguments, 1 for problems.

- [ ] **Step 1: Write the failing tests** in `scripts/release/test/plan.test.mjs`:

```js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/release/test/plan.test.mjs`
Expected: FAIL, `Cannot find module '../plan.mjs'`.

- [ ] **Step 3: Implement `scripts/release/plan.mjs`**

```js
#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { parseReleaseVersion, readUnitVersions } from "./release-model.mjs";
import { RELEASE_UNITS, dependencyOrder, unitById, unitTag } from "./units.mjs";

const REPOSITORY_ROOT = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const PLAN_FAILURE = "Release plan is invalid";
const PLAN_MISSING = "Release plan is missing or unsafe";
const PLAN_PATH_FAILURE = "Release plan path must stay inside the repository";
const SET_FAILURE = "Release set id must be release-YYYY-MM-DD.N or local-<12 hex> of the source commit";
const TAGS_FAILURE = "Repository tags are unreadable";
const USAGE = "Usage: plan.mjs [--write] | --check [--release-set release-YYYY-MM-DD.N] [--commit SHA]";
const MAX_PLAN_BYTES = 64 * 1024;
const COMMIT = /^[0-9a-f]{40}$/u;
const RELEASE_TAG = /^release-([0-9]{4})-([0-9]{2})-([0-9]{2})\.([1-9][0-9]{0,2})$/u;
const LOCAL_SET = /^local-[0-9a-f]{12}$/u;
const ARTIFACT_UNIT = new Map(RELEASE_UNITS.flatMap(({ id, artifacts }) => artifacts.map((name) => [name, id])));

export const RELEASE_PLAN_PATH = ".release/plan.json";
export const RELEASE_GATES = Object.freeze([
  "node", "php", "java", "conformance", "dashboard", "widget", "widget-panel", "deployment", "skills", "security",
]);

function stable(value) {
  if (typeof value !== "string") throw new Error(PLAN_FAILURE);
  try {
    return parseReleaseVersion(`${value}\n`);
  } catch {
    throw new Error(PLAN_FAILURE);
  }
}

export function compareVersions(left, right) {
  const a = stable(left).split(".").map(BigInt);
  const b = stable(right).split(".").map(BigInt);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function unitIdForArtifact(name) {
  const id = ARTIFACT_UNIT.get(name);
  if (id === undefined) throw new Error(`Artifact ${name} has no release unit`);
  return id;
}

export function isReleaseTagName(value) {
  const match = typeof value === "string" ? RELEASE_TAG.exec(value) : null;
  if (match === null) return false;
  const [year, month, day] = match.slice(1, 4).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function localReleaseSetId(sourceCommit) {
  if (typeof sourceCommit !== "string" || !COMMIT.test(sourceCommit)) throw new TypeError(SET_FAILURE);
  return `local-${sourceCommit.slice(0, 12)}`;
}

export function parseReleaseSetId(value, sourceCommit) {
  if (isReleaseTagName(value)) return value;
  if (typeof value === "string" && LOCAL_SET.test(value)
      && (sourceCommit === undefined || localReleaseSetId(sourceCommit) === value)) return value;
  throw new TypeError(SET_FAILURE);
}

function planEntry(entry) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error(PLAN_FAILURE);
  const keys = Object.keys(entry);
  if (keys.length !== 3 || !["id", "from", "to"].every((key) => keys.includes(key))) throw new Error(PLAN_FAILURE);
  let unit;
  try {
    unit = unitById(entry.id);
  } catch {
    throw new Error(PLAN_FAILURE);
  }
  const to = stable(entry.to);
  if (entry.from !== null && compareVersions(stable(entry.from), to) >= 0) throw new Error(PLAN_FAILURE);
  return Object.freeze({ id: unit.id, from: entry.from, to });
}

export function createReleasePlan(entries) {
  const list = [...entries].map(planEntry);
  const byId = new Map(list.map((entry) => [entry.id, entry]));
  if (byId.size !== list.length) throw new Error(PLAN_FAILURE);
  const order = dependencyOrder([...byId.keys()]);
  return Object.freeze({
    schemaVersion: 1,
    units: Object.freeze(order.map((id) => byId.get(id))),
    order: Object.freeze([...order]),
  });
}

export function serializeReleasePlan(plan) {
  return `${JSON.stringify({
    schemaVersion: 1,
    units: plan.units.map(({ id, from, to }) => ({ id, from, to })),
    order: [...plan.order],
  }, null, 2)}\n`;
}

export function parseReleasePlan(source) {
  if (typeof source !== "string" || Buffer.byteLength(source) > MAX_PLAN_BYTES) throw new Error(PLAN_FAILURE);
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(PLAN_FAILURE);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1
      || !Array.isArray(value.units) || !Array.isArray(value.order)) throw new Error(PLAN_FAILURE);
  const plan = createReleasePlan(value.units);
  if (serializeReleasePlan(plan) !== source) throw new Error(PLAN_FAILURE);
  return plan;
}

function versionOf(versions, id) {
  const version = versions.get(id);
  if (typeof version !== "string") throw new Error(`Release unit ${id} has no version`);
  return version;
}

export function allUnitsPlan(versions) {
  return createReleasePlan(RELEASE_UNITS.map(({ id }) => ({ id, from: null, to: versionOf(versions, id) })));
}

export function parseTagListing(output) {
  if (typeof output !== "string") throw new Error(TAGS_FAILURE);
  const tags = new Map();
  for (const line of output.split("\n")) {
    if (line === "") continue;
    const fields = line.split("\0");
    if (fields.length !== 3 || fields[0] === "" || tags.has(fields[0])) throw new Error(TAGS_FAILURE);
    const commit = fields[2] === "" ? fields[1] : fields[2];
    if (!COMMIT.test(commit)) throw new Error(TAGS_FAILURE);
    tags.set(fields[0], commit);
  }
  return tags;
}

export function readRepositoryTags(root) {
  let output;
  try {
    output = execFileSync("git", [
      "-C", root, "for-each-ref", "--format=%(refname:strip=2)%00%(objectname)%00%(*objectname)", "refs/tags",
    ], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60_000,
      env: {
        PATH: process.env.PATH, HOME: "/dev/null", LANG: "C", LC_ALL: "C",
        GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      },
    });
  } catch {
    throw new Error(TAGS_FAILURE);
  }
  return parseTagListing(output);
}

export function latestUnitVersion(id, tags, { excludeTag } = {}) {
  const { tagPrefix } = unitById(id);
  let latest = null;
  for (const name of tags.keys()) {
    if (name === excludeTag || !name.startsWith(tagPrefix)) continue;
    const candidate = name.slice(tagPrefix.length);
    let version;
    try {
      version = parseReleaseVersion(`${candidate}\n`);
    } catch {
      continue;
    }
    if (latest === null || compareVersions(version, latest) > 0) latest = version;
  }
  return latest;
}

export function buildReleasePlan(versions, tags) {
  const entries = [];
  for (const { id } of RELEASE_UNITS) {
    const current = versionOf(versions, id);
    const latest = latestUnitVersion(id, tags);
    if (latest !== current) entries.push({ id, from: latest, to: current });
  }
  return createReleasePlan(entries);
}

export function validatePlanAgainstManifests(plan, versions) {
  return plan.units
    .filter(({ id, to }) => versions.get(id) !== to)
    .map(({ id, to }) => `${id}: plan version ${to} does not equal manifest version ${versions.get(id) ?? "missing"}`);
}

export function validatePlanAgainstTags(plan, { versions, tags, commit = null }) {
  const problems = [];
  const planned = new Map(plan.units.map((entry) => [entry.id, entry]));
  for (const entry of plan.units) {
    const unit = unitById(entry.id);
    const toTag = unitTag(unit, entry.to);
    if (tags.has(toTag) && tags.get(toTag) !== commit) problems.push(`${entry.id}: tag ${toTag} already exists at another commit`);
    const latest = latestUnitVersion(entry.id, tags, { excludeTag: toTag });
    if (latest !== entry.from) {
      problems.push(`${entry.id}: plan starts from ${entry.from ?? "nothing"} but the latest tag is ${latest ?? "absent"}`);
    }
    for (const dependency of unit.dependsOn) {
      const version = versionOf(versions, dependency);
      if (planned.get(dependency)?.to === version) continue;
      if (!tags.has(unitTag(unitById(dependency), version))) {
        problems.push(`${entry.id}: dependency ${dependency} ${version} is neither planned nor tagged`);
      }
    }
  }
  for (const unit of RELEASE_UNITS) {
    if (planned.has(unit.id)) continue;
    const version = versionOf(versions, unit.id);
    if (!tags.has(unitTag(unit, version))) problems.push(`${unit.id}: version ${version} is neither planned nor tagged`);
  }
  return problems;
}

export function planGates(plan) {
  const wanted = new Set(plan.units.flatMap(({ id }) => unitById(id).gates));
  return RELEASE_GATES.filter((gate) => wanted.has(gate));
}

function planLocation(root, path) {
  if (typeof path !== "string" || path === "" || path.includes("\0") || path.includes("\\")) throw new TypeError(PLAN_PATH_FAILURE);
  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const relativePath = relative(root, absolute);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new TypeError(PLAN_PATH_FAILURE);
  }
  return Object.freeze({ absolute, relativePath: relativePath.split(sep).join("/") });
}

export function readReleasePlan(root, path = RELEASE_PLAN_PATH) {
  const { absolute } = planLocation(root, path);
  let bytes;
  try {
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_PLAN_BYTES) throw new Error();
    bytes = readFileSync(absolute);
  } catch {
    throw new Error(PLAN_MISSING);
  }
  return parseReleasePlan(bytes.toString("utf8"));
}

function defaultPlanExists(root) {
  try {
    lstatSync(resolve(root, RELEASE_PLAN_PATH));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw new Error(PLAN_MISSING);
  }
}

export function resolveReleasePlan(root, path = null, { readVersions = readUnitVersions } = {}) {
  if (path !== null) {
    return Object.freeze({ plan: readReleasePlan(root, path), path: planLocation(root, path).relativePath });
  }
  if (defaultPlanExists(root)) return Object.freeze({ plan: readReleasePlan(root), path: RELEASE_PLAN_PATH });
  return Object.freeze({ plan: allUnitsPlan(readVersions(root)), path: null });
}

export function writeReleasePlan(root, plan) {
  const directory = resolve(root, ".release");
  mkdirSync(directory, { recursive: true, mode: 0o755 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(PLAN_MISSING);
  const scratch = join(directory, `.plan-${randomBytes(8).toString("hex")}.json`);
  writeFileSync(scratch, serializeReleasePlan(plan), { flag: "wx", mode: 0o644 });
  renameSync(scratch, resolve(root, RELEASE_PLAN_PATH));
  return RELEASE_PLAN_PATH;
}

export function parsePlanArguments(argv) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== "string")) throw new TypeError(USAGE);
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "--write")) return Object.freeze({ command: "write" });
  if (argv[0] !== "--check" || argv.length % 2 !== 1) throw new TypeError(USAGE);
  let releaseSet = null;
  let commit = null;
  for (let index = 1; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (flag === "--release-set" && releaseSet === null && isReleaseTagName(value)) releaseSet = value;
    else if (flag === "--commit" && commit === null && COMMIT.test(value)) commit = value;
    else throw new TypeError(USAGE);
  }
  return Object.freeze({ command: "check", releaseSet, commit });
}

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

export function runPlanCli(argv, { root = REPOSITORY_ROOT, readVersions = readUnitVersions, readTags = readRepositoryTags } = {}) {
  let command;
  try {
    command = parsePlanArguments(argv);
  } catch {
    return { exitCode: 2, stdout: "", stderr: jsonLine({ error: { code: "INVALID_ARGUMENTS", message: USAGE }, ok: false }) };
  }
  try {
    const versions = readVersions(root);
    const tags = readTags(root);
    if (command.command === "write") {
      const plan = buildReleasePlan(versions, tags);
      const path = writeReleasePlan(root, plan);
      return {
        exitCode: 0,
        stdout: jsonLine({ command: "write", path, units: plan.units, order: plan.order, gates: planGates(plan) }),
        stderr: "",
      };
    }
    const plan = readReleasePlan(root);
    const problems = [
      ...(plan.units.length === 0 ? ["release plan has no units"] : []),
      ...validatePlanAgainstManifests(plan, versions),
      ...validatePlanAgainstTags(plan, { versions, tags, commit: command.commit }),
    ];
    return {
      exitCode: problems.length === 0 ? 0 : 1,
      stdout: jsonLine({
        command: "check", ok: problems.length === 0, releaseSet: command.releaseSet, units: plan.units,
        order: plan.order, gates: planGates(plan), problems,
      }),
      stderr: "",
    };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: jsonLine({ error: { code: "PLAN_FAILED", message: error instanceof Error ? error.message : PLAN_FAILURE }, ok: false }),
    };
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runPlanCli(process.argv.slice(2));
  if (result.stdout !== "") process.stdout.write(result.stdout);
  if (result.stderr !== "") process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
```

- [ ] **Step 4: Run tests and a read-only check against the repository**

Run: `node --test scripts/release/test/plan.test.mjs && pnpm release:test && node -e 'import("./scripts/release/plan.mjs").then(async (m) => { const { readUnitVersions } = await import("./scripts/release/release-model.mjs"); const p = m.buildReleasePlan(readUnitVersions(process.cwd()), m.readRepositoryTags(process.cwd())); console.log(JSON.stringify(p)); })'`
Expected: tests PASS; the last command prints `{"schemaVersion":1,"units":[],"order":[]}` (every unit equals its baseline tag). Do not run `--write`; nothing under `.release/` is committed in this task.

- [ ] **Step 5: Commit**

```bash
git add scripts/release/plan.mjs scripts/release/test/plan.test.mjs
git commit -m "feat(release): add the release plan model and plan CLI

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Release-set tag command and release scripts

**Files:**
- Create: `scripts/release/release-tag.mjs`
- Test: `scripts/release/test/release-tag.test.mjs`
- Modify: root `package.json` (`scripts`), `scripts/release/test/workflow-policy.test.mjs` (test "every workflow-facing gate resolves to one exact local root script", the `expected` object near line 290)
- Re-bind: `skill-evals/gauntlet-app-integration/{external-inputs.json,verification.json,results/*.jsonl}`, `skill-evals/gauntlet-extension-authoring/{external-inputs.json,verification.json,results/*.jsonl}` (root `package.json` is a bound input of both evaluations)

**Interfaces:**
- Consumes (Task 1): `RELEASE_PLAN_PATH`, `readReleasePlan`, `readRepositoryTags`, `validatePlanAgainstManifests`, `validatePlanAgainstTags` from `plan.mjs`; `readUnitVersions` from `release-model.mjs`.
- Produces:
  - `nextReleaseTag(now: Date, tags: ReadonlyMap<string,string>): string` (UTC date, next free `N`).
  - `releaseTagMessage(tag: string, plan): string` (`"Release set <tag>\n\n<id> <from|none> -> <to>\n..."`).
  - `prepareReleaseTag({ root, now, git, readVersions, readTags }): Readonly<{ tag, commit, plan, message }>` where `git(args: string[]) => { status: number, stdout: string, stderr: string }` runs in `root`.
  - `runReleaseTagCli(argv, { root, now, git, readVersions, readTags } = {})`: `release-tag.mjs` creates the local annotated tag; `release-tag.mjs --dry-run` only reports. stdout `{"command":"tag","created":true|false,"tag":"release-…","commit":"…","units":[…],"push":"git push origin refs/tags/release-…"}`. Never pushes.
  - Root scripts `"release:plan": "node scripts/release/plan.mjs --write"` and `"release:tag": "node scripts/release/release-tag.mjs"`.

- [ ] **Step 1: Write the failing tests** in `scripts/release/test/release-tag.test.mjs`:

```js
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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
  const result = runReleaseTagCli([], { root, now: NOW, git, readVersions: () => versionsAt("0.1.8", DASHBOARD), readTags: () => tags });
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
  const result = runReleaseTagCli(["--dry-run"], { root, now: NOW, git, readVersions: () => versionsAt("0.1.8", DASHBOARD), readTags: baselineTags });
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
    const result = runReleaseTagCli([], { root, now: NOW, git, readVersions: versions, readTags: tags });
    assert.equal(result.exitCode, 1);
    assert.match(JSON.parse(result.stderr).error.message, message);
    assert.equal(created.size, 0);
  }
  assert.equal(runReleaseTagCli(["--push"], { root: fixture(t), now: NOW }).exitCode, 2);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/release/test/release-tag.test.mjs`
Expected: FAIL, `Cannot find module '../release-tag.mjs'`.

- [ ] **Step 3: Implement `scripts/release/release-tag.mjs`**

```js
#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RELEASE_PLAN_PATH, readReleasePlan, readRepositoryTags, validatePlanAgainstManifests, validatePlanAgainstTags,
} from "./plan.mjs";
import { readUnitVersions } from "./release-model.mjs";

const REPOSITORY_ROOT = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const USAGE = "Usage: release-tag.mjs [--dry-run]";
const COMMIT = /^[0-9a-f]{40}$/u;
const SET_TAG = /^release-([0-9]{4}-[0-9]{2}-[0-9]{2})\.([1-9][0-9]{0,2})$/u;

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

export function nextReleaseTag(now, tags) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError("Release tag date is invalid");
  const date = now.toISOString().slice(0, 10);
  let highest = 0;
  for (const name of tags.keys()) {
    const match = SET_TAG.exec(name);
    if (match !== null && match[1] === date) highest = Math.max(highest, Number(match[2]));
  }
  if (highest >= 999) throw new Error("No release-set tag number is left for today");
  return `release-${date}.${highest + 1}`;
}

export function releaseTagMessage(tag, plan) {
  const lines = plan.units.map(({ id, from, to }) => `${id} ${from ?? "none"} -> ${to}`);
  return `Release set ${tag}\n\n${lines.join("\n")}\n`;
}

function defaultGit(root) {
  return (args) => {
    const result = spawnSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME ?? "/dev/null", LANG: "C", LC_ALL: "C" },
    });
    return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
}

export function prepareReleaseTag({ root, now, git, readVersions, readTags }) {
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.status !== 0 || status.stdout !== "") throw new Error("Working tree is not clean");
  const head = git(["rev-parse", "--verify", "HEAD^{commit}"]);
  const commit = head.stdout.trim();
  if (head.status !== 0 || !COMMIT.test(commit)) throw new Error("HEAD is not a commit");
  if (git(["merge-base", "--is-ancestor", commit, "origin/main"]).status !== 0) {
    throw new Error("HEAD is not contained in origin/main");
  }
  const plan = readReleasePlan(root, RELEASE_PLAN_PATH);
  if (plan.units.length === 0) throw new Error("Release plan has no units");
  const versions = readVersions(root);
  const tags = readTags(root);
  const problems = [...validatePlanAgainstManifests(plan, versions), ...validatePlanAgainstTags(plan, { versions, tags })];
  if (problems.length > 0) throw new Error(`Release plan is not releasable: ${problems.join("; ")}`);
  const tag = nextReleaseTag(now, tags);
  return Object.freeze({ tag, commit, plan, message: releaseTagMessage(tag, plan) });
}

export function runReleaseTagCli(argv, {
  root = REPOSITORY_ROOT,
  now = new Date(),
  git = defaultGit(root),
  readVersions = readUnitVersions,
  readTags = readRepositoryTags,
} = {}) {
  if (!Array.isArray(argv) || !(argv.length === 0 || (argv.length === 1 && argv[0] === "--dry-run"))) {
    return { exitCode: 2, stdout: "", stderr: jsonLine({ error: { code: "INVALID_ARGUMENTS", message: USAGE }, ok: false }) };
  }
  try {
    const prepared = prepareReleaseTag({ root, now, git, readVersions, readTags });
    const dryRun = argv.length === 1;
    if (!dryRun) {
      const created = git(["tag", "--annotate", prepared.tag, "--message", prepared.message, prepared.commit]);
      const peeled = git(["rev-parse", "--verify", `refs/tags/${prepared.tag}^{commit}`]);
      const type = git(["cat-file", "-t", `refs/tags/${prepared.tag}`]);
      if (created.status !== 0 || peeled.stdout.trim() !== prepared.commit || type.stdout.trim() !== "tag") {
        throw new Error("Release-set tag creation failed");
      }
    }
    return {
      exitCode: 0,
      stdout: jsonLine({
        command: "tag", created: !dryRun, tag: prepared.tag, commit: prepared.commit, units: prepared.plan.units,
        push: `git push origin refs/tags/${prepared.tag}`,
      }),
      stderr: "",
    };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: jsonLine({ error: { code: "RELEASE_TAG_FAILED", message: error instanceof Error ? error.message : "Release-set tag failed" }, ok: false }),
    };
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runReleaseTagCli(process.argv.slice(2));
  if (result.stdout !== "") process.stdout.write(result.stdout);
  if (result.stderr !== "") process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
```

- [ ] **Step 4: Add the root scripts.** In root `package.json` `scripts`, after `"release:baseline-tags"`, add `"release:plan": "node scripts/release/plan.mjs --write"` and `"release:tag": "node scripts/release/release-tag.mjs"`. In `workflow-policy.test.mjs`, add both entries to the `expected` object of "every workflow-facing gate resolves to one exact local root script".

- [ ] **Step 5: Re-bind the skill-evaluation receipts** (root `package.json` changed). Follow commit `e0d2138`'s procedure (`git show e0d2138 --stat` and its diff of `verification.json` and one `results/*.jsonl`): for each of `skill-evals/gauntlet-app-integration` and `skill-evals/gauntlet-extension-authoring`, regenerate `external-inputs.json` with `generateExternalInputsManifest` from `scripts/skills/external-inputs.mjs` (or its CLI `node scripts/skills/external-inputs.mjs generate --root <abs repo> --evaluation-root <abs eval dir> --declaration-json '<compact JSON>'`) using exactly the paths already listed in that file (`sourceFiles` as path strings, `sourceTrees` as `{ path, excludedTopLevel }`, `linkedRuntimeTrees` as path strings; move the old file aside first if the writer refuses to overwrite, and delete it afterwards). Replace the old `externalInputsSha256` value with the new one in `verification.json` and in every line of `results/*.jsonl` (literal string replacement of the old hash), then set each phase's `transcriptSha256` in `verification.json` to the SHA-256 of its rewritten results file. Change nothing else (no prompts, responses, reviews or timestamps). Confirm with `git diff --stat skill-evals` that only those files changed.

- [ ] **Step 6: Run**

Run: `node --test scripts/release/test/release-tag.test.mjs && pnpm release:test && pnpm skills:validate && pnpm release:tag --dry-run; echo "exit $?"`
Expected: tests PASS; `skills:validate` reports success; the real dry run exits 1 with `Release plan .release/plan.json is missing or unsafe` (no plan is committed), proving it refuses without creating a tag (`git tag --list 'release-*'` prints nothing).

- [ ] **Step 7: Commit**

```bash
git add scripts/release/release-tag.mjs scripts/release/test/release-tag.test.mjs scripts/release/test/workflow-policy.test.mjs package.json skill-evals/gauntlet-app-integration skill-evals/gauntlet-extension-authoring
git commit -m "feat(release): add release:plan and the release-set tag command

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Per-unit version setter

**Files:**
- Modify: `scripts/release/release-model.mjs` (`prepareJsonFile` 847-868, `prepareYamlFile` 870-896, `prepareComposeFile` 898-913, `prepareReleaseTextFile` 915-926, `prepareVersionFile` 928-932, `prepareReleaseUpdate` 934-987, `setReleaseVersion` 1174-1229), `scripts/release/version.mjs` (`USAGE`, `parseVersionCommand`, `runVersionCli`)
- Test: `scripts/release/test/release-model.test.mjs`
- Re-bind: skill-evaluation receipts (`release-model.mjs` is bound)

**Interfaces:**
- Consumes: `readUnitVersions`, `collectUnitVersionMismatches`, `collectVersionMismatches`, `unitById`, `RELEASE_UNITS` (phase 1).
- Produces:
  - `setUnitVersions(root: string, requested: ReadonlyMap<string,string> | Record<string,string>, options?: { testingHook? }): Readonly<{ versions: Record<string,string>; changedPaths: string[] }>`: rewrites every version location and slot bound to a requested unit, from that unit's current version to the requested one, all-or-nothing with today's descriptor transaction and rollback. No cascade. Precondition `collectUnitVersionMismatches(root)` is empty; failures throw `Release version update preflight failed`. `changedPaths` follow `UPDATE_PATHS` order.
  - `setReleaseVersion(root, version, options?)`: unchanged contract (all units; precondition still `collectVersionMismatches(root)`), now implemented with the same preparation and commit code.
  - `version.mjs --set-unit <id> X.Y.Z` → stdout `{"changedPaths":[...],"command":"set-unit","ok":true,"unit":"<id>","version":"X.Y.Z"}`; `USAGE = "Usage: version.mjs --check [--tag vX.Y.Z] | --set X.Y.Z | --set-unit UNIT X.Y.Z"`.

- [ ] **Step 1: Write the failing tests** at the end of `release-model.test.mjs` (`createVersionFixture`, `writeFixtureFile` already exist; add `setUnitVersions` and `readUnitVersion` to the import from `../release-model.mjs`, and `runVersionCli` is already imported for the CLI tests near line 1313; check and add if missing):

```js
test("setUnitVersions moves one unit and every slot bound to it, and nothing else", () => {
  const root = createVersionFixture("0.1.8");
  try {
    const result = setUnitVersions(root, new Map([["php-core", "0.2.0"]]));
    assert.deepEqual(result, {
      versions: { "php-core": "0.2.0" },
      changedPaths: [
        "packages/php/core/composer.json",
        "packages/php/symfony-bundle/composer.json",
        "tests/consumers/php-core/composer.json",
        "tests/consumers/php-symfony/composer.json",
        "skills/gauntlet-app-integration/references/symfony.md",
      ],
    });
    assert.deepEqual(collectUnitVersionMismatches(root), []);
    assert.equal(readUnitVersion(root, "php-core"), "0.2.0");
    assert.equal(readUnitVersion(root, "symfony-bundle"), "0.1.8");
    const bundle = JSON.parse(readFileSync(join(root, "packages/php/symfony-bundle/composer.json"), "utf8"));
    assert.equal(bundle.version, "0.1.8");
    assert.equal(bundle.require["8lines/gauntlet-php-core"], "^0.2.0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setUnitVersions moves the application and the skills archive slots independently", () => {
  const root = createVersionFixture("0.1.8");
  try {
    assert.deepEqual(setUnitVersions(root, { gauntlet: "0.1.9" }).changedPaths, [
      "apps/dashboard/package.json",
      "apps/server/package.json",
      "deploy/helm/gauntlet/Chart.yaml",
      "deploy/helm/gauntlet/values.yaml",
      "deploy/compose/.env.example",
      "skills/gauntlet-app-integration/references/deployment.md",
      "skills/gauntlet-app-integration/references/safety-gates.md",
      "VERSION",
    ]);
    assert.deepEqual(setUnitVersions(root, { skills: "0.1.9" }).changedPaths, [
      "skills/gauntlet-app-integration/SKILL.md",
      "docs/ai-skills.md",
      "skills/VERSION",
    ]);
    assert.deepEqual(collectUnitVersionMismatches(root), []);
    assert.equal(readUnitVersion(root, "protocol"), "0.1.8");
    assert.equal(readUnitVersion(root, "gauntlet"), "0.1.9");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setUnitVersions rejects unknown units, invalid versions and inconsistent repositories before writing", () => {
  const root = createVersionFixture("0.1.8");
  try {
    const before = fixtureSnapshot(root);
    for (const requested of [new Map(), { nope: "0.1.9" }, { widget: "0.1.9-rc.1" }, [["widget", "0.1.9"]]]) {
      assert.throws(() => setUnitVersions(root, requested));
    }
    writeFixtureFile(root, "skills/gauntlet-app-integration/references/symfony.md",
      readFileSync(join(root, "skills/gauntlet-app-integration/references/symfony.md"), "utf8").replace("`0.1.8`", "`0.1.7`"));
    assert.throws(() => setUnitVersions(root, { widget: "0.1.9" }), /preflight failed/u);
    assert.equal(readUnitVersion(root, "widget"), "0.1.8");
    assert.notDeepEqual(fixtureSnapshot(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the version CLI sets one unit", () => {
  const root = createVersionFixture("0.1.8");
  try {
    const result = runVersionCli(["--set-unit", "widget", "0.2.0"], { root });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      changedPaths: ["packages/widget/package.json"], command: "set-unit", ok: true, unit: "widget", version: "0.2.0",
    });
    for (const argv of [["--set-unit", "nope", "0.2.0"], ["--set-unit", "widget"], ["--set-unit", "widget", "v0.2.0"]]) {
      assert.equal(runVersionCli(argv, { root }).exitCode, 2, argv.join(" "));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

The symfony.md fixture text comes from `releaseTextFixtures(version)` (line ~176); if its slot is not the literal `` `0.1.8` ``, adapt the `replace` to the exact slot text written by that helper so the file becomes inconsistent. Also extend the existing "accepts only the three closed version CLI command shapes" test (line ~1313) so the parser accepts `["--set-unit", "php-core", "0.2.0"]` and rejects an unknown unit; rename it to "accepts only the closed version CLI command shapes".

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/release/test/release-model.test.mjs`
Expected: FAIL, `setUnitVersions` is not exported.

- [ ] **Step 3: Implement in `release-model.mjs`**

1. `prepareJsonFile(root, path, edits)` where `edits` is `[{ keyPath, current, next, constraint = false }]`: for each edit, the node at `keyPath` must equal `current` (or `^current` when `constraint`), replaced by `JSON.stringify(next)` (or `^next`); then the existing re-parse validation per edit. With `edits = []` it returns the file unchanged (`nextBytes` equal to the original bytes).
2. Add `function prepareUnchangedFile(root, path) { const manifest = readManifest(root, path); return { ...manifest, path, nextBytes: manifest.bytes }; }`.
3. `prepareReleaseTextFile(root, { path, slots }, currentVersions, nextVersions)`: every span's `value` must equal `currentVersions.get(span.unit)`; replace only spans whose `unit` is in `nextVersions`; validate the rewritten spans the same way.
4. Replace `prepareReleaseUpdate(root, currentVersion, nextVersion)` with `prepareReleaseUpdate(root, currentVersions, nextVersions)` (both `Map<unitId, version>`):

```js
const has = (unit) => nextVersions.has(unit);
const edit = (keyPath, unit, constraint = false) => ({
  keyPath, current: currentVersions.get(unit), next: nextVersions.get(unit), constraint,
});
const prepared = [
  ...RELEASE_JSON_MANIFESTS.map(({ path, unit, constraintUnit }) => prepareJsonFile(root, path, [
    ...(has(unit) ? [edit(["version"], unit)] : []),
    ...(constraintUnit !== undefined && has(constraintUnit)
      ? [edit(["require", "8lines/gauntlet-php-core"], constraintUnit, true)]
      : []),
  ])),
  has("gauntlet")
    ? prepareYamlFile(root, "deploy/helm/gauntlet/Chart.yaml", currentVersions.get("gauntlet"), nextVersions.get("gauntlet"), [["version"], ["appVersion"]])
    : prepareUnchangedFile(root, "deploy/helm/gauntlet/Chart.yaml"),
  has("gauntlet")
    ? prepareYamlFile(root, "deploy/helm/gauntlet/values.yaml", currentVersions.get("gauntlet"), nextVersions.get("gauntlet"), [["image", "tag"]])
    : prepareUnchangedFile(root, "deploy/helm/gauntlet/values.yaml"),
  has("gauntlet")
    ? prepareComposeFile(root, currentVersions.get("gauntlet"), nextVersions.get("gauntlet"))
    : prepareUnchangedFile(root, "deploy/compose/.env.example"),
  ...RELEASE_CONSUMER_JSON_FILES.map(({ path, keyPaths }) => prepareJsonFile(
    root, path, keyPaths.filter(({ unit }) => has(unit)).map(({ keyPath, unit }) => edit(keyPath, unit)),
  )),
  ...RELEASE_TEXT_FILES.map((file) => prepareReleaseTextFile(root, file, currentVersions, nextVersions)),
  ...UNIT_VERSION_FILE_PATHS.map((path) => {
    const unit = RELEASE_UNITS.find(({ version }) => version.type === "file" && version.path === path).id;
    return has(unit) ? prepareVersionFile(root, path, currentVersions.get(unit), nextVersions.get(unit)) : prepareUnchangedFile(root, path);
  }),
  has("gauntlet")
    ? prepareVersionFile(root, "VERSION", currentVersions.get("gauntlet"), nextVersions.get("gauntlet"))
    : prepareUnchangedFile(root, "VERSION"),
];
```

Keep the rest of `prepareReleaseUpdate` (path inventory check against `UPDATE_PATHS`, LF/size bounds, the second `assertSafeReleaseFile` race check) unchanged.
5. Move the body of `setReleaseVersion` from `const changed = prepared.filter(...)` to its final `return` into `function commitPreparedUpdate(root, prepared, testingHook)` that returns `changedPaths` (`[]` when nothing changed; keep every error message).
6. Add:

```js
function requestedUnitVersions(requested) {
  let entries;
  if (requested instanceof Map) entries = [...requested];
  else if (requested !== null && typeof requested === "object" && !Array.isArray(requested)
      && Object.getPrototypeOf(requested) === Object.prototype) entries = Object.entries(requested);
  if (entries === undefined || entries.length === 0) throw new TypeError("Release unit versions must name at least one unit");
  const result = new Map();
  for (const [id, version] of entries) {
    unitById(id);
    if (result.has(id) || typeof version !== "string") throw new TypeError("Release unit versions are invalid");
    result.set(id, parseReleaseVersion(`${version}\n`));
  }
  return result;
}

export function setUnitVersions(root, requested, options = {}) {
  const nextVersions = requestedUnitVersions(requested);
  const testingHook = captureTestingHook(options);
  let prepared;
  try {
    if (collectUnitVersionMismatches(root).length > 0) throw new Error("Repository version state is inconsistent");
    prepared = prepareReleaseUpdate(root, readUnitVersions(root), nextVersions);
  } catch {
    throw new Error("Release version update preflight failed");
  }
  const changedPaths = commitPreparedUpdate(root, prepared, testingHook);
  return Object.freeze({ versions: Object.freeze(Object.fromEntries(nextVersions)), changedPaths });
}
```

7. `setReleaseVersion` keeps its argument validation and `collectVersionMismatches(root)` precondition, then calls `prepareReleaseUpdate(root, readUnitVersions(root), new Map(RELEASE_UNITS.map(({ id }) => [id, nextVersion])))` and `commitPreparedUpdate`, returning `{ version: nextVersion, changedPaths }`.

In `version.mjs`: import `setUnitVersions` and `unitById`; `parseVersionCommand` accepts `["--set-unit", id, version]` when `unitById(id)` succeeds and the version parses (otherwise `invalidArguments()`), returning `{ command: "set-unit", unit, version }`; `runVersionCli` calls `setUnitVersions(root, { [unit]: version })` and prints `{ changedPaths, command: "set-unit", ok: true, unit, version }`. Update `USAGE` as in Interfaces.

- [ ] **Step 4: Run**

Run: `node --test scripts/release/test/release-model.test.mjs && pnpm release:test && node scripts/release/version.mjs --check`
Expected: PASS; the check prints `"ok":true`.

- [ ] **Step 5: Re-bind the skill-evaluation receipts** (`release-model.mjs` changed): same procedure as in commit `e0d2138`. For each of `skill-evals/gauntlet-app-integration` and `skill-evals/gauntlet-extension-authoring`, regenerate `external-inputs.json` with `generateExternalInputsManifest` (`scripts/skills/external-inputs.mjs`) from the paths already listed in it; replace the old `externalInputsSha256` in `verification.json` and every `results/*.jsonl` line; recompute each phase's `transcriptSha256`; change nothing else. Run `pnpm skills:validate` until it reports success.

- [ ] **Step 6: Commit**

```bash
git add scripts/release/release-model.mjs scripts/release/version.mjs scripts/release/test/release-model.test.mjs skill-evals/gauntlet-app-integration skill-evals/gauntlet-extension-authoring
git commit -m "feat(release): set one unit's version with version.mjs --set-unit

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: npm and Composer stagers take explicit unit versions

**Files:**
- Modify: `scripts/release/stage-npm.mjs` (`validateClosedOptions` 134-150, `validateManifest` 302-344, `projectedManifest` 346-366, `capturePackage` 411-446, `stageNpmPackages` 793-914), `scripts/release/stage-composer.mjs` (`validateOptions` 56-70, `validateManifest` 247-267, `projectManifest` 269-274, `capturePackage` 327-360, `stageComposerPackages` 362-448), `scripts/release/stage.mjs` (`executeReleaseStage` npm and Composer calls, 492-516), `scripts/test-packed-npm-packages.mjs` (line 30 and the staging block near 300-315), `scripts/release/test-composer-consumer.mjs` (`createComposerConsumerPlan` 50-95, `createBareRepository` 232-255, `validateConsumerLock` 300-318, `runComposerConsumer` 320-375), `skill-evals/gauntlet-app-integration/prepare-fixture.mjs` (`stageComposerPackages` call near 1031)
- Test: `scripts/release/test/stage-npm.test.mjs`, `scripts/release/test/stage-composer.test.mjs`, `scripts/release/test/stage.test.mjs` (fakes), `scripts/release/test/composer-consumer.test.mjs`, `scripts/release/test/package-metadata.test.mjs` (tests near 207-270), `skill-evals/gauntlet-app-integration/test/*.test.mjs` if they call `stageComposerPackages`
- Re-bind: skill-evaluation receipts (`stage-composer.mjs` and `prepare-fixture.mjs` are bound)

**Interfaces:**
- Consumes: `RELEASE_UNITS`, `dependencyOrder`, `unitById` (`units.mjs`); `unitIdForArtifact` (Task 1); `readUnitVersion`, `readUnitVersions` (`release-model.mjs`).
- Produces:
  - `NPM_UNIT_IDS` (exported from `stage-npm.mjs`) = `["protocol","dashboard-client","typescript-core","typescript-node","next-adapter","conformance-runner","widget"]`.
  - `stageNpmPackages({ root, outputDirectory, versions, include })`: `versions` is a closed plain object with exactly the seven npm unit ids, each a stable version; `include` is a non-empty array of distinct npm unit ids in dependency order. Stages only `include`; each manifest version must equal `versions[id]`; every `workspace:*` internal dependency is projected to `versions[<dependency unit>]`. Returns records sorted by name `{ kind: "npm", name, version: versions[id], path, sha256 }`.
  - `COMPOSER_UNIT_IDS` (exported from `stage-composer.mjs`) = `["php-core","symfony-bundle"]`.
  - `stageComposerPackages({ root, outputDirectory, sourceCommit, versions, include })`: `versions` has exactly the two Composer unit ids; each package's `composer.json` at `sourceCommit` must have `version === versions[id]`; the bundle must require `^${versions["php-core"]}`; `.gauntlet-source.json` records each package's own version; records carry their own `version`. The root `VERSION` blob is no longer read.
  - `createComposerConsumerPlan({ versions, taskIdentifier, sandbox, imageTag, uid, gid })` with `versions = { "php-core", "symfony-bundle" }`; each repository record gains `version` and `tag: v<its version>`; the plan exposes `versions` instead of `version`; `runComposerConsumer` returns `{ versions, packages, consumers }`.

- [ ] **Step 1: Write the failing tests**

In `stage-npm.test.mjs`, replace `const RELEASE_VERSION = readReleaseVersion(REPOSITORY_ROOT);` with per-unit versions and add the diverged test:

```js
import { NPM_UNIT_IDS, stageNpmPackages } from "../stage-npm.mjs";
import { readUnitVersions } from "../release-model.mjs";

const UNIT_VERSIONS = readUnitVersions(REPOSITORY_ROOT);
const NPM_VERSIONS = Object.freeze(Object.fromEntries(NPM_UNIT_IDS.map((id) => [id, UNIT_VERSIONS.get(id)])));

function stageAll(root, outputDirectory) {
  return stageNpmPackages({ root, outputDirectory, versions: NPM_VERSIONS, include: NPM_UNIT_IDS });
}

test("stages only included packages and pins each internal dependency to its own unit version", async () => {
  const fixture = createFixture();
  try {
    const versions = { ...NPM_VERSIONS, protocol: "0.2.0", "typescript-node": "0.1.9" };
    for (const [id, directory] of [["protocol", "packages/protocol"], ["typescript-node", "packages/typescript/node"]]) {
      const path = resolve(fixture.root, directory, "package.json");
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      manifest.version = versions[id];
      writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    const outputDirectory = fixture.output();
    const artifacts = await stageNpmPackages({
      root: fixture.root, outputDirectory, versions, include: ["protocol", "typescript-node"],
    });
    assert.deepEqual(artifacts.map(({ name, version }) => [name, version]), [
      ["@8lines/gauntlet-protocol", "0.2.0"],
      ["@8lines/gauntlet-typescript-node", "0.1.9"],
    ]);
    assert.deepEqual(readdirSync(outputDirectory).sort(), [
      "8lines-gauntlet-protocol-0.2.0.tgz",
      "8lines-gauntlet-typescript-node-0.1.9.tgz",
    ]);
    const node = artifacts.find(({ name }) => name === "@8lines/gauntlet-typescript-node");
    const packed = JSON.parse(readArchive(node.path).get("package/package.json").payload.toString("utf8"));
    assert.equal(packed.version, "0.1.9");
    assert.equal(packed.dependencies["@8lines/gauntlet-protocol"], "0.2.0");
    assert.equal(packed.dependencies["@8lines/gauntlet-typescript-core"], versions["typescript-core"]);
  } finally {
    fixture.cleanup();
  }
});

test("rejects version maps and include lists that do not describe the npm units exactly", async () => {
  const fixture = createFixture();
  try {
    const { protocol: _omitted, ...missing } = NPM_VERSIONS;
    for (const [versions, include] of [
      [missing, ["widget"]],
      [{ ...NPM_VERSIONS, gauntlet: "0.1.9" }, ["widget"]],
      [NPM_VERSIONS, []],
      [NPM_VERSIONS, ["typescript-node", "protocol"]],
      [NPM_VERSIONS, ["php-core"]],
      [{ ...NPM_VERSIONS, widget: "9.9.9" }, ["widget"]],
    ]) {
      await assert.rejects(stageNpmPackages({ root: fixture.root, outputDirectory: fixture.output(`o-${Math.random().toString(16).slice(2)}`), versions, include }));
    }
  } finally {
    fixture.cleanup();
  }
});
```

Change every other `stageNpmPackages({ root, outputDirectory })` call in this file to `stageAll(root, outputDirectory)`, and every `RELEASE_VERSION` expectation to the package's own version (`NPM_VERSIONS[unitIdForArtifact(name)]`, importing `unitIdForArtifact` from `../plan.mjs`).

In `stage-composer.test.mjs`, extend `createFixture(version = "0.1.0", { bundleVersion = version } = {})` so the bundle manifest uses `bundleVersion` while requiring `^${version}`, drop the fixture's root `VERSION` write, pass `versions` and `include` to every existing `stageComposerPackages` call, and add:

```js
test("stages one Composer package at its own version without reading the root VERSION", async () => {
  const fixture = createFixture("0.2.0", { bundleVersion: "0.1.9" });
  try {
    const versions = { "php-core": "0.2.0", "symfony-bundle": "0.1.9" };
    const core = await stageComposerPackages({
      root: fixture.root, outputDirectory: fixture.output, sourceCommit: fixture.commit, versions, include: ["php-core"],
    });
    assert.deepEqual(core.map(({ name, version }) => [name, version]), [["8lines/gauntlet-php-core", "0.2.0"]]);
    assert.deepEqual(readdirSync(resolve(fixture.output, "8lines")), ["gauntlet-php-core"]);
    const source = JSON.parse(readFileSync(resolve(fixture.output, "8lines/gauntlet-php-core/.gauntlet-source.json"), "utf8"));
    assert.equal(source.version, "0.2.0");
  } finally {
    rmSync(fixture.sandbox, { recursive: true, force: true });
  }
});

test("binds the bundle to its own version and the core constraint to php-core", async () => {
  const fixture = createFixture("0.2.0", { bundleVersion: "0.1.9" });
  try {
    const both = await stageComposerPackages({
      root: fixture.root, outputDirectory: fixture.output, sourceCommit: fixture.commit,
      versions: { "php-core": "0.2.0", "symfony-bundle": "0.1.9" }, include: ["php-core", "symfony-bundle"],
    });
    assert.deepEqual(both.map(({ version }) => version), ["0.2.0", "0.1.9"]);
    const bundle = JSON.parse(readFileSync(resolve(fixture.output, "8lines/gauntlet-symfony-bundle/composer.json"), "utf8"));
    assert.equal(bundle.require["8lines/gauntlet-php-core"], "^0.2.0");
  } finally {
    rmSync(fixture.sandbox, { recursive: true, force: true });
  }
  const mismatched = createFixture("0.2.0", { bundleVersion: "0.1.9" });
  try {
    await assert.rejects(stageComposerPackages({
      root: mismatched.root, outputDirectory: mismatched.output, sourceCommit: mismatched.commit,
      versions: { "php-core": "0.2.0", "symfony-bundle": "0.2.0" }, include: ["symfony-bundle"],
    }));
    assert.deepEqual(readdirSync(mismatched.output), []);
  } finally {
    rmSync(mismatched.sandbox, { recursive: true, force: true });
  }
});
```

Use the fixture's real field names (`sandbox`, `root`, `commit`, `output`; read the `return` of `createFixture` near line 118 and adapt if they differ). In `stage.test.mjs` `fakeDependencies`, assert the new option shapes: `stageNpmPackages({ outputDirectory, versions, include })` with `include` equal to `NPM_UNIT_IDS` and `versions[id] === VERSION`; `stageComposerPackages` with `include` equal to `COMPOSER_UNIT_IDS`. In `composer-consumer.test.mjs`, build plans with `versions: { "php-core": "0.1.0", "symfony-bundle": "0.1.1" }` and assert repository tags `v0.1.0` and `v0.1.1`. In `package-metadata.test.mjs`, compare each npm manifest version with `readUnitVersion(REPOSITORY_ROOT, unitIdForArtifact(name))`, each Composer manifest with its own unit, and the bundle constraint with `^${readUnitVersion(CANONICAL_ROOT, "php-core")}`.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm build && node --test scripts/release/test/stage-npm.test.mjs scripts/release/test/stage-composer.test.mjs`
Expected: FAIL on the option shapes (closed-option validation rejects `versions`/`include`) and missing `NPM_UNIT_IDS`/`COMPOSER_UNIT_IDS`.

- [ ] **Step 3: Implement**

`stage-npm.mjs`:
- Import `RELEASE_UNITS`, `dependencyOrder` from `./units.mjs` and `unitIdForArtifact` from `./plan.mjs`; remove the `readReleaseVersion` import. Export `NPM_UNIT_IDS = Object.freeze(RELEASE_UNITS.filter(({ kind }) => kind === "npm").map(({ id }) => id))`.
- `validateClosedOptions` accepts exactly `root`, `outputDirectory`, `versions`, `include`; add `validateUnitVersions(versions)` (plain object or null prototype, own enumerable data properties, keys exactly `NPM_UNIT_IDS`, each value `parseReleaseVersion(`${v}\n`) === v`) and `validateInclude(include)` (array, non-empty, every id in `NPM_UNIT_IDS`, no duplicates, `JSON.stringify(dependencyOrder(include)) === JSON.stringify(include)`); any failure calls `fixedFailure()` after the `TypeError` for non-closed objects, matching today's style.
- `validateManifest(manifest, artifact, version, contract)` is unchanged but receives the package's own version.
- `projectedManifest(manifest, version, versions)`: internal dependency names map to `versions[unitIdForArtifact(name)]` instead of the single version.
- `capturePackage(root, artifact, version, rootLicense, versions)` passes `versions` to `projectedManifest`.
- `stageNpmPackages`: `const artifacts = include.map((id) => RELEASE_ARTIFACTS.npm.find(({ name }) => unitIdForArtifact(name) === id))`; capture each with `versions[id]`; `archiveName(name, ownVersion)`, the pack report check and `validateArchive(..., ownVersion)` use the package's own version; result records use `version: versions[unitIdForArtifact(archive.name)]`.

`stage-composer.mjs`:
- Export `COMPOSER_UNIT_IDS`; `validateOptions` wants `root`, `outputDirectory`, `sourceCommit`, `versions`, `include` (same closed checks; `versions` keys exactly `COMPOSER_UNIT_IDS`; `include` non-empty, dependency-ordered subset).
- Delete the `ls-tree … VERSION` block in `stageComposerPackages` (lines ~390-395).
- `validateManifest(manifest, artifact, version, coreVersion)`: `manifest.version === version`; for the bundle `manifest.require["8lines/gauntlet-php-core"] === `^${coreVersion}``.
- `capturePackage(root, artifact, version, coreVersion, commit, …)`; `.gauntlet-source.json` gets `version` (the package's own).
- Iterate only `include` (map ids to `RELEASE_ARTIFACTS.composer` by `unitIdForArtifact`); result records carry the package's own version.

`stage.mjs` (temporary until Task 6, repository still lockstep): in `executeReleaseStage`, call `stageNpmPackages({ root, outputDirectory: npmDirectory, versions: Object.fromEntries(NPM_UNIT_IDS.map((id) => [id, version])), include: NPM_UNIT_IDS })` and `stageComposerPackages({ root, outputDirectory: composerRepositories, sourceCommit, versions: Object.fromEntries(COMPOSER_UNIT_IDS.map((id) => [id, version])), include: COMPOSER_UNIT_IDS })`.

`scripts/test-packed-npm-packages.mjs`: replace `const VERSION = readReleaseVersion(ROOT)` with `const UNIT_VERSIONS = readUnitVersions(ROOT)`; stage with `versions: Object.fromEntries(NPM_UNIT_IDS.map((id) => [id, UNIT_VERSIONS.get(id)]))` and `include: NPM_UNIT_IDS`; assert `artifact.version === UNIT_VERSIONS.get(unitIdForArtifact(artifact.name))`.

`scripts/release/test-composer-consumer.mjs`: `createComposerConsumerPlan` validates `versions` (exact two keys, stable values) and gives each repository `version` and `tag: `v${version}``; `createBareRepository(repository, environment)` uses `repository.version` in its messages; `validateConsumerLock` compares each internal dependency with its repository's `version` (both the per-package check and the trailing `INTERNAL_PACKAGES` check); `runComposerConsumer` builds `versions` from `readUnitVersion(root, "php-core")` and `readUnitVersion(root, "symfony-bundle")`, passes `versions` and `include: COMPOSER_UNIT_IDS` to `stageComposerPackages`, re-checks both versions where it re-read `readReleaseVersion(root)`, and returns `{ versions, packages, consumers }`.

`prepare-fixture.mjs` (near 1031): pass `versions: { "php-core": readVersion(REPOSITORY_ROOT, "php-core"), "symfony-bundle": readVersion(REPOSITORY_ROOT, "symfony-bundle") }, include: ["php-core", "symfony-bundle"]` using the preparer's injected `readVersion` (thread it from `prepareFixture`'s options to the Symfony preparer if it is not already in scope; do not change prompts or recorded outputs).

- [ ] **Step 4: Run**

Run: `pnpm build && pnpm release:test && pnpm test:packages && node --test skill-evals/gauntlet-app-integration/test/*.test.mjs && pnpm test:composer:consumer`
Expected: PASS (`test:composer:consumer` and the Symfony fixture tests use Docker `composer:2`/PHP images as today).

- [ ] **Step 5: Re-bind the skill-evaluation receipts** (`stage-composer.mjs` and `prepare-fixture.mjs` changed). Same procedure as commit `e0d2138`: regenerate `external-inputs.json` for both evaluations with `generateExternalInputsManifest` from the paths already listed; because `prepare-fixture.mjs` is an evaluation input of `gauntlet-app-integration`, also replace that evaluation's old `evaluationSha256` with `hashEvaluationInputs(<abs eval dir>)` (`scripts/skills/evaluation-content.mjs`) in `verification.json` and every `results/*.jsonl` line; replace old `externalInputsSha256` values the same way; recompute each phase's `transcriptSha256`. Change nothing else. `pnpm skills:validate` must report success.

- [ ] **Step 6: Commit**

```bash
git add scripts/release/stage-npm.mjs scripts/release/stage-composer.mjs scripts/release/stage.mjs scripts/test-packed-npm-packages.mjs scripts/release/test-composer-consumer.mjs scripts/release/test skill-evals/gauntlet-app-integration skill-evals/gauntlet-extension-authoring
git commit -m "feat(release): stage npm and Composer packages at their own unit versions

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Maven staging and Java checks use per-project versions

**Files:**
- Modify: `scripts/release/stage-maven.mjs` (`validateClosedOptions` 78-94, `executePublication` 299-322, `expectedRawFiles` 324-340, `validateRawRepository` 363-383, `validateModuleMetadata` 385-433, `inspectRepository` 435-451, `validateCaptures` 453-461, `materializeStage` 508-538, `resultRecords` 566-583, `javaCaptureVersion`/`readMavenStageVersion` 585-596, `publishMavenLocally` 598-678), `scripts/release/inspect-jdk.mjs` (`main`, `inspectModule`, `inspectPom`, `inspectModuleMetadata` in `JDK_INSPECTOR_SOURCE`), `scripts/release/stage.mjs` (Maven call 525-541), `scripts/release/test-java-release.mjs` (`validateJavaConsumerFixture` 177-232, `createJavaReleasePlan` 235+, `assertConsumerRecords` 477-495, `assertDistribution` 509-529, `validateStagedArtifacts` 531-548, `runJavaRelease` 544-600), `scripts/release/test-java-source.mjs` (`closedPlanOptions` ~78, `createJavaSourcePlan` 374-380, `runJavaSource` ~500-545)
- Test: `scripts/release/test/stage-maven.test.mjs`, `scripts/release/test/java-release.test.mjs`, `scripts/release/test/java-source.test.mjs`, `scripts/release/test/stage.test.mjs` (Maven fake)

**Interfaces:**
- Consumes: `parseReleaseVersion` (`release-model.mjs`), `dependencyOrder` (`units.mjs`).
- Produces:
  - `MAVEN_UNIT_IDS = ["java-core","spring-boot-starter"]` (exported from `stage-maven.mjs`).
  - `readMavenStageVersions(root): Readonly<{ "java-core": string; "spring-boot-starter": string }>` from the captured `packages/java/{core,spring-boot-starter}/VERSION` (strict parser; diverged versions are valid; a missing or invalid file throws the `parseReleaseVersion` error). Replaces `readMavenStageVersion`.
  - `publishMavenLocally({ root, outputDirectory, versions, include })`: `versions` has exactly the two Maven unit ids and must equal `readMavenStageVersions` of the captured tree; Gradle runs only the publication tasks of `include` (`:core:publishCorePublicationToGauntletLocalRepository`, `:spring-boot-starter:publishSpringBootStarterPublicationToGauntletLocalRepository`); raw tree, module metadata, inspector and staged tree cover only `include`; each record carries its own version.
  - JDK inspector arguments: `<repository> <license> <coreVersion> <starterVersion> <module>...` (modules `core` and/or `spring-boot-starter`); the starter POM must depend on `dev.eightlines.gauntlet:core:<coreVersion>:compile`.
  - `validateJavaConsumerFixture({ settings, build, lock, source, versions })` and `createJavaReleasePlan({ sandbox, versions, uid, gid })` with `versions = { "java-core", "spring-boot-starter" }`; `runJavaRelease` returns `{ versions, artifacts, consumers, sourceChecks }`; `createJavaSourcePlan({ …, versions })`, source report `{ ok, versions, sourceChecks }`. `javaLockstepVersion` is no longer imported anywhere (its export is deleted in Task 12).

- [ ] **Step 1: Write the failing tests**

In `stage-maven.test.mjs`, replace the two `readMavenStageVersion` tests (lines ~181-215) with:

```js
test("reads each Java unit version from its own VERSION file, including diverged versions", () => {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "gauntlet-stage-maven-version-")));
  try {
    const root = createJavaFixtureRoot(sandbox, { core: "7.8.9\n", starter: "7.8.10\n" });
    assert.equal(readdirSync(root).includes("VERSION"), false);
    assert.deepEqual(readMavenStageVersions(root), { "java-core": "7.8.9", "spring-boot-starter": "7.8.10" });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("rejects missing or invalid Java unit versions for Maven staging", () => {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "gauntlet-stage-maven-version-")));
  try {
    [{ core: "7.8.9\n" }, { starter: "7.8.9\n" }, { core: "7.8.9\n", starter: "not-a-version\n" }].forEach((versions, index) => {
      const root = createJavaFixtureRoot(join(sandbox, String(index)), versions);
      assert.throws(() => readMavenStageVersions(root), {
        message: "Release version must be an exact stable ASCII semantic version followed by one LF",
      });
    });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("rejects version maps and include lists that do not match the Java units before running Docker", async () => {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "gauntlet-stage-maven-options-")));
  try {
    const versions = readMavenStageVersions(ROOT);
    for (const [candidate, include] of [
      [{ ...versions, "java-core": "9.9.9" }, ["java-core"]],
      [{ "java-core": versions["java-core"] }, ["java-core"]],
      [versions, []],
      [versions, ["spring-boot-starter", "java-core"]],
      [versions, ["protocol"]],
    ]) {
      await assert.rejects(publishMavenLocally({ root: ROOT, outputDirectory: createOutput(sandbox, `o-${include.length}-${Math.random().toString(16).slice(2)}`), versions: candidate, include }));
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
```

Replace `RELEASE_VERSION` in the Docker-backed test "publishes two closed reproducible Maven version trees" with `const VERSIONS = readMavenStageVersions(ROOT)` and pass `versions: VERSIONS, include: MAVEN_UNIT_IDS`; expect each coordinate at its own version. Add a Docker-backed case staging only `["spring-boot-starter"]` and asserting exactly one record (`dev.eightlines.gauntlet:spring-boot-starter`) and no `dev/eightlines/gauntlet/core` directory in the output. In `java-release.test.mjs` and `java-source.test.mjs`, replace `version` options with `versions` and add a fixture case with core `0.1.9` and starter `0.1.10` that validates (the consumer build pins the starter `0.1.10`, the lockfile pins core `0.1.9` and starter `0.1.10`), plus a case where the lockfile pins core at the starter version and is rejected. In `stage.test.mjs`, the Maven fake asserts `include` equals `MAVEN_UNIT_IDS`.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/release/test/stage-maven.test.mjs scripts/release/test/java-release.test.mjs scripts/release/test/java-source.test.mjs`
Expected: FAIL, `readMavenStageVersions` is not exported and the `versions` options are rejected.

- [ ] **Step 3: Implement**

`stage-maven.mjs`:
- Replace `javaCaptureVersion` and `readMavenStageVersion` with:

```js
export const MAVEN_UNIT_IDS = Object.freeze(["java-core", "spring-boot-starter"]);
const MAVEN_PROJECTS = Object.freeze({
  "java-core": Object.freeze({ artifactId: "core", versionPath: "core/VERSION", task: ":core:publishCorePublicationToGauntletLocalRepository" }),
  "spring-boot-starter": Object.freeze({
    artifactId: "spring-boot-starter", versionPath: "spring-boot-starter/VERSION",
    task: ":spring-boot-starter:publishSpringBootStarterPublicationToGauntletLocalRepository",
  }),
});

function captureVersions(capture) {
  return Object.freeze(Object.fromEntries(MAVEN_UNIT_IDS.map((id) => {
    const record = capture.records.find(({ relativePath }) => relativePath === MAVEN_PROJECTS[id].versionPath);
    return [id, parseReleaseVersion(record === undefined ? Buffer.alloc(0) : record.bytes)];
  })));
}

export function readMavenStageVersions(root) {
  return captureVersions(captureJavaTree(root));
}
```

- `validateClosedOptions` accepts `root`, `outputDirectory`, `versions`, `include` (closed checks; `versions` keys exactly `MAVEN_UNIT_IDS`; `include` non-empty, distinct, dependency-ordered subset of `MAVEN_UNIT_IDS`).
- In `publishMavenLocally`, after `captureJavaTree(root)`: `const captured = captureVersions(javaCapture); if (MAVEN_UNIT_IDS.some((id) => captured[id] !== versions[id])) fixedFailure();`.
- Thread `{ versions, include }` (call it `selection`) through `executePublication(run, capture, selection)` (Gradle arguments list only `MAVEN_PROJECTS[id].task` for included ids), `expectedRawFiles(selection)` (iterate included ids with each id's own version), `validateRawRepository(repository, selection)`, `validateCaptures(captures, selection)`, `validateModuleMetadata(bytes, artifactId, version, captures, coreVersion)` (the starter must contain `"requires":"${coreVersion}"`), `inspectRepository(root, repository, scratch, selection, environment)` (inspector arguments `"/publication", "/workspace/LICENSE", versions["java-core"], versions["spring-boot-starter"], ...include.map((id) => MAVEN_PROJECTS[id].artifactId)`), `materializeStage(ready, captures, selection)` and `resultRecords(outputDirectory, staged)` (each staged entry stores its own `version`).
- Remove the `javaLockstepVersion` import.

`inspect-jdk.mjs` (`JDK_INSPECTOR_SOURCE`): `main` requires `args.length >= 5 && args.length <= 6`, parses `coreVersion = args[2]` and `starterVersion = args[3]` with the existing regex, and requires the remaining arguments to be distinct names of `MODULES` in catalog order; it inspects only those modules, each with its own version (`core` with `coreVersion`, `spring-boot-starter` with `starterVersion`). `inspectModule` and `inspectPom` take `coreVersion` in addition to the module's own version, and the starter dependency list expects `"dev.eightlines.gauntlet:core:" + coreVersion + ":compile"`.

`stage.mjs` (temporary until Task 6): `publishMavenLocally({ root, outputDirectory: mavenRepository, versions: Object.fromEntries(MAVEN_UNIT_IDS.map((id) => [id, version])), include: MAVEN_UNIT_IDS })`.

`test-java-release.mjs`: replace `javaLockstepVersion(sourceRecords)` with `readMavenStageVersions(plan.steps[1].root)` after materializing the source records (or an equivalent local helper over `sourceRecords` for `packages/java/core/VERSION` and `packages/java/spring-boot-starter/VERSION` using `parseReleaseVersion`); thread `versions` through `createJavaReleasePlan`, `validateJavaConsumerFixture` (build pins `spring-boot-starter:${versions["spring-boot-starter"]}`; lock `core` equals `versions["java-core"]`, `spring-boot-starter` equals `versions["spring-boot-starter"]`, any other `dev.eightlines.gauntlet:` coordinate is rejected), `assertDistribution` (each jar path at its own version) and `validateStagedArtifacts` (each artifact's `version` equals its unit's version); call `publishMavenLocally({ root, outputDirectory, versions, include: MAVEN_UNIT_IDS })`.

`test-java-source.mjs`: replace `javaLockstepVersion(capture.records)` with the same per-unit reading over `capture.records`; `closedPlanOptions` expects `versions` instead of `version`; `createJavaSourcePlan` validates both values with `STABLE_VERSION`; the report is `{ ok: true, versions, sourceChecks }`.

- [ ] **Step 4: Run**

Run: `pnpm release:test && pnpm test:java:release && node scripts/release/test-java-source.mjs`
Expected: PASS (Gradle runs in the pinned Docker image; no host JDK).

- [ ] **Step 5: Commit**

```bash
git add scripts/release/stage-maven.mjs scripts/release/inspect-jdk.mjs scripts/release/stage.mjs scripts/release/test-java-release.mjs scripts/release/test-java-source.mjs scripts/release/test
git commit -m "feat(release): stage and check Java projects at their own unit versions

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Plan-driven staging, manifest schema 2 and per-unit inventory

**Files:**
- Modify: `scripts/release/inventory.mjs` (`createReleaseManifest` 133-149, `expectedReleaseArtifactIdentity` 224-265, `verifyStagedReleaseInventory` 324-338, `verifyReleaseInventory` 340-408, `writeReleaseInventory` 461-505, `parseArtifacts` 105-126), `scripts/release/release-manifest.schema.json`, `scripts/release/stage.mjs` (`validateVersionedRecord` 412-428, `validateRecordArray` 430-437, `archiveTrees` 447-462, `executeReleaseStage` 475-638, `stageLifecycle` 690-707, `stageRelease` 763-790, `parseStageArguments` 792-802, CLI 811-826), `scripts/release/verify-inventory.mjs`, `scripts/release/discard-staged.mjs`, `scripts/release/publish-composer.mjs` (`parseCli` 441-451, `publishComposerRepositories` 453-487, `withMaterializedComposerSources` 489-501, `readComposerReleaseManifest` 518-548, `createComposerPublicationPlan` 562-595, CLI 597-606), `scripts/release/security.mjs` (`validateStagedImageArchive` 812-827, `parseSecurityArguments` 1528-1539), `scripts/docs/verify-documented-commands.mjs` (`planDocumentedCommandChecks` 64-140, `validateInventoryReport` 232-245, `parseDocumentedCommandArguments` ~405-421), `scripts/release/dry-run.mjs` (`createLocalRegistryPlan` 88-100, `validateStageOutput` 451-458, `validateInventoryOutput` 491-525, `validateDocumentationOutput` 527-532, `runDryRun` 860-1000 paths)
- Test: `scripts/release/test/{inventory,stage,verify-inventory,discard-staged,publish-composer,security,dry-run}.test.mjs`, `scripts/docs/test/documented-commands.test.mjs`

**Interfaces:**
- Consumes: `parseReleaseSetId`, `localReleaseSetId`, `resolveReleasePlan`, `validatePlanAgainstManifests`, `unitIdForArtifact` (Task 1); `NPM_UNIT_IDS` (Task 4), `COMPOSER_UNIT_IDS` (Task 4), `MAVEN_UNIT_IDS` (Task 5); `RELEASE_UNITS`, `dependencyOrder`, `unitById`, `unitTag`.
- Produces:
  - `inventory.mjs`: `expectedUnitArtifacts(unitId, version): readonly { unit, kind, name, path }[]`; `expectedReleaseArtifacts(units: { id, version }[]): readonly {…}[]` (sorted by kind, name, path); `createReleaseManifest({ releaseSet, sourceCommit, units, artifacts })` → schema 2 (units `{ id, version, tag }` in dependency order; each artifact `{ unit, kind, name, path, sha256 }` with `unit` in `units`); `writeReleaseInventory({ outputDirectory, releaseSet, sourceCommit, units, artifacts })`; `verifyReleaseInventory({ outputDirectory, releaseSet, sourceCommit })` → `{ schemaVersion: 2, ok: true, releaseSet, sourceCommit, units, artifacts: <count>, manifestSha256, checksumsSha256, nativeImage, multiPlatformOci, helmChart }` (the last three `null` without `gauntlet`); `verifyStagedReleaseInventory(outputDirectory)` additionally requires `basename(outputDirectory) === manifest.releaseSet`; `readReleaseManifest(outputDirectory): Readonly<{ manifest, bytes }>` (canonical-bytes check only; no closed-tree or hash check; used after finalization). `RELEASE_INVENTORY_ARTIFACTS` is removed.
  - `stage.mjs`: `executeReleaseStage({ root, sourceCommit, releaseSet, units, versions, workDirectory }, dependencies)` (`units: { id, version }[]` in dependency order; `versions`: plain object of all 13 unit versions, consistent with `units`); `stageRelease({ root, outputDirectory, sourceCommit, releaseSet, planPath }, lifecycle)` with lifecycle keys `executeReleaseStage`, `verifySource`, `resolvePlan`, `readVersions`; `parseStageArguments(argv) → { outputDirectory, planPath: string | null, releaseSet: string | null }` (`--output PATH` first, then optional `--plan PATH` and `--release-set ID` in any order, each once). CLI stdout `{"artifacts":N,"outputDirectory":"…","releaseSet":"…","sourceCommit":"…","units":[{"id","version"}]}`; default release set `localReleaseSetId(HEAD)`; default plan per `resolveReleasePlan`.
  - `discard-staged.mjs`: `--release-root .artifacts/release/<set-id> --source-commit SHA`; verifier called with `{ outputDirectory, releaseSet, sourceCommit }`; report `{ schemaVersion: 2, ok: true, removed: ".artifacts/release/<set-id>", releaseSet, sourceCommit }`.
  - `publish-composer.mjs`: `createComposerPublicationPlan({ releaseDirectory, sourceCommit, unit })` → one frozen entry `{ name, version, archivePath, expectedPrefix, expectedSha256, expectedSourceCommit, remote }`; `publishComposerRepositories({ releaseDirectory, sourceCommit, unit }, dependencies)` → `[{ name, status }]`; CLI `--release-directory ABS --source-commit SHA --unit php-core|symfony-bundle`, stdout `{"results":[…],"unit":"…","version":"…"}`. Split-repo tag stays `v<that package's version>`.
  - `security.mjs`: `--image-archive` accepts `.artifacts/release/<version-or-set-id>/image/gauntlet-<gauntlet version>.docker.tar` (the version form is removed in Task 11).
  - `verify-documented-commands.mjs`: `--release-root .artifacts/release/<set-id>`; reads the gauntlet version from the staged manifest; fails when `gauntlet` is not staged.
  - `dry-run.mjs` (minimal; plan scoping is Task 9): release root `.artifacts/release/<localReleaseSetId(sourceCommit)>`; passes `--release-set` to stage; parses the new stage and inventory outputs; `createLocalRegistryPlan` accepts any `.artifacts/release/<set-id>` root with `version` = gauntlet version; report gains `releaseSet`.

- [ ] **Step 1: Write the failing tests**

In `inventory.test.mjs` (keep the `Ajv2020` schema validation and update existing fixtures to schema 2: `RELEASE_ARTIFACT_FIXTURES` gains a leading unit column, `createReleaseManifest`/`writeReleaseInventory`/`verifyReleaseInventory` calls pass `releaseSet: "release-2026-10-03.1"` and `units`), add:

```js
import { RELEASE_UNITS } from "../units.mjs";
import { expectedReleaseArtifacts, expectedUnitArtifacts } from "../inventory.mjs";

const SET = "release-2026-10-03.1";

function stageFiles(root, units) {
  return expectedReleaseArtifacts(units).map(({ unit, kind, name, path }, index) => {
    mkdirSync(resolve(root, path, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(resolve(root, path), `artifact-${index}\n`, { mode: 0o600 });
    return { unit, kind, name, path };
  });
}

test("expected artifacts are one archive per package unit and seven for the application", () => {
  assert.deepEqual(expectedUnitArtifacts("protocol", "0.2.0"), [
    { unit: "protocol", kind: "npm", name: "@8lines/gauntlet-protocol", path: "npm/8lines-gauntlet-protocol-0.2.0.tgz" },
  ]);
  assert.deepEqual(expectedUnitArtifacts("symfony-bundle", "0.1.9"), [{
    unit: "symfony-bundle", kind: "composer", name: "8lines/gauntlet-symfony-bundle",
    path: "composer/artifacts/gauntlet-symfony-bundle-0.1.9.tar.gz",
  }]);
  assert.deepEqual(expectedUnitArtifacts("spring-boot-starter", "0.1.9").map(({ path }) => path), [
    "maven/artifacts/gauntlet-spring-boot-starter-0.1.9.tar.gz",
  ]);
  assert.deepEqual(expectedUnitArtifacts("skills", "0.1.9").map(({ path }) => path), ["skills/gauntlet-skills-0.1.9.tgz"]);
  assert.deepEqual(expectedUnitArtifacts("gauntlet", "0.1.9").map(({ kind }) => kind), [
    "compose", "docker", "helm", "oci", "provenance", "sbom", "sbom",
  ]);
  assert.equal(expectedReleaseArtifacts(RELEASE_UNITS.map(({ id }) => ({ id, version: "0.1.8" }))).length, 19);
});

test("a schema 2 inventory verifies only the planned units' closed artifact set", async () => {
  const root = sandbox();
  try {
    const units = [{ id: "gauntlet", version: "0.1.9" }, { id: "skills", version: "0.1.9" }];
    const manifest = await writeReleaseInventory({ outputDirectory: root, releaseSet: SET, sourceCommit: COMMIT, units, artifacts: stageFiles(root, units) });
    assert.deepEqual(manifest.units, [{ id: "gauntlet", version: "0.1.9", tag: "v0.1.9" }, { id: "skills", version: "0.1.9", tag: "skills-v0.1.9" }]);
    const report = verifyReleaseInventory({ outputDirectory: root, releaseSet: SET, sourceCommit: COMMIT });
    assert.equal(report.schemaVersion, 2);
    assert.equal(report.artifacts, 8);
    assert.equal(report.helmChart.path, "helm/gauntlet-0.1.9.tgz");
    assert.throws(() => verifyReleaseInventory({ outputDirectory: root, releaseSet: "release-2026-10-03.2", sourceCommit: COMMIT }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inventory rejects an artifact of an unplanned unit and a missing application artifact", async () => {
  const unplanned = sandbox();
  const missing = sandbox();
  try {
    const php = [{ id: "php-core", version: "0.1.9" }];
    const extra = { unit: "protocol", kind: "npm", name: "@8lines/gauntlet-protocol", path: "npm/8lines-gauntlet-protocol-0.1.9.tgz" };
    mkdirSync(resolve(unplanned, "npm"), { mode: 0o700 });
    writeFileSync(resolve(unplanned, extra.path), "extra\n", { mode: 0o600 });
    await assert.rejects(writeReleaseInventory({
      outputDirectory: unplanned, releaseSet: SET, sourceCommit: COMMIT, units: php, artifacts: [...stageFiles(unplanned, php), extra],
    }), /input is invalid/u);

    const units = [{ id: "gauntlet", version: "0.1.9" }];
    const artifacts = stageFiles(missing, units).filter(({ name }) => !name.endsWith("@linux/arm64"));
    rmSync(resolve(missing, "sbom/gauntlet-linux-arm64.spdx.json"));
    await writeReleaseInventory({ outputDirectory: missing, releaseSet: SET, sourceCommit: COMMIT, units, artifacts });
    assert.throws(() => verifyReleaseInventory({ outputDirectory: missing, releaseSet: SET, sourceCommit: COMMIT }), /failed closed/u);
  } finally {
    rmSync(unplanned, { recursive: true, force: true });
    rmSync(missing, { recursive: true, force: true });
  }
});

test("manifests reject unknown units, wrong order and malformed release sets", () => {
  const artifacts = [{ unit: "skills", kind: "skills", name: "gauntlet-skills", path: "skills/gauntlet-skills-0.1.9.tgz", sha256: SHA_A }];
  for (const options of [
    { releaseSet: SET, sourceCommit: COMMIT, units: [{ id: "nope", version: "0.1.9" }], artifacts },
    { releaseSet: SET, sourceCommit: COMMIT, units: [{ id: "skills", version: "0.1.9" }, { id: "gauntlet", version: "0.1.9" }], artifacts },
    { releaseSet: "0.1.9", sourceCommit: COMMIT, units: [{ id: "skills", version: "0.1.9" }], artifacts },
    { releaseSet: SET, sourceCommit: COMMIT, units: [], artifacts },
  ]) assert.throws(() => createReleaseManifest(options), /input is invalid/u);
});
```

`writeReleaseInventory` rejects artifacts whose `unit` is not in `units` with the existing `Release inventory input is invalid`; identity completeness is checked by verification (and by staging before inventory). In `stage.test.mjs`, add a `planDependencies(calls, gauntletVersion)` factory that returns fakes producing files at the exact staged names for the requested `include`/`version` (npm `npm/<flat name>-<v>.tgz`, Composer trees under `outputDirectory/<repository>` archived by the real `packageCanonicalTree`, Maven trees under `dev/eightlines/gauntlet/<artifactId>/<v>`, skills `gauntlet-skills-<v>.tgz`, compose `gauntlet-compose-<v>.tar.gz`, helm `gauntlet-<v>.tgz`, image `gauntlet-<v>.{docker.tar,oci.tar,provenance.json}` with the existing image record shape and `inspection`, SBOMs at the given `outputPath`), records `[phase, …]` calls, and uses the real `writeReleaseInventory`. Then add the three integration tests:

```js
import { verifyReleaseInventory, writeReleaseInventory } from "../inventory.mjs";
import { RELEASE_UNITS, dependencyOrder } from "../units.mjs";

const SET = "release-2026-10-03.1";
const BASE_VERSIONS = Object.freeze(Object.fromEntries(RELEASE_UNITS.map(({ id }) => [id, "0.1.8"])));

async function stagePlan(t, overrides, unitIds) {
  const { repository, work } = sandbox(t);
  const versions = { ...BASE_VERSIONS, ...overrides };
  const units = dependencyOrder(unitIds).map((id) => ({ id, version: versions[id] }));
  const calls = [];
  const manifest = await executeReleaseStage(
    { root: repository, sourceCommit: COMMIT, releaseSet: SET, units, versions, workDirectory: work },
    planDependencies(calls, versions.gauntlet),
  );
  const report = verifyReleaseInventory({ outputDirectory: work, releaseSet: SET, sourceCommit: COMMIT });
  return { calls, manifest, report, work };
}

const identities = (manifest) => manifest.artifacts.map(({ unit, kind, name, path }) => [unit, kind, name, path]);
const APPLICATION = (version) => [
  ["gauntlet", "compose", "gauntlet-compose", `compose/gauntlet-compose-${version}.tar.gz`],
  ["gauntlet", "docker", "gauntlet.local/gauntlet", `image/gauntlet-${version}.docker.tar`],
  ["gauntlet", "helm", "gauntlet", `helm/gauntlet-${version}.tgz`],
];
const IMAGE_EVIDENCE = (version) => [
  ["gauntlet", "oci", "ghcr.io/8lines/gauntlet", `image/gauntlet-${version}.oci.tar`],
  ["gauntlet", "provenance", "ghcr.io/8lines/gauntlet@buildkit-unsigned", `image/gauntlet-${version}.provenance.json`],
  ["gauntlet", "sbom", "ghcr.io/8lines/gauntlet@linux/amd64", "sbom/gauntlet-linux-amd64.spdx.json"],
  ["gauntlet", "sbom", "ghcr.io/8lines/gauntlet@linux/arm64", "sbom/gauntlet-linux-arm64.spdx.json"],
];

test("a dashboard-only plan stages the application and the skills archive and nothing else", async (t) => {
  const { calls, manifest, report, work } = await stagePlan(t, { gauntlet: "0.1.9", skills: "0.1.9" }, ["gauntlet", "skills"]);
  assert.deepEqual(manifest.units, [{ id: "gauntlet", version: "0.1.9", tag: "v0.1.9" }, { id: "skills", version: "0.1.9", tag: "skills-v0.1.9" }]);
  assert.deepEqual(identities(manifest), [
    ...APPLICATION("0.1.9"), ...IMAGE_EVIDENCE("0.1.9"),
    ["skills", "skills", "gauntlet-skills", "skills/gauntlet-skills-0.1.9.tgz"],
  ]);
  assert.deepEqual(calls.map(([phase]) => phase), ["skills", "compose", "helm", "image", "sbom", "sbom"]);
  assert.equal(report.artifacts, 8);
  assert.deepEqual(readdirSync(work).sort(), ["SHA256SUMS", "compose", "helm", "image", "release-manifest.json", "sbom", "skills"]);
});

test("a protocol cascade stages its npm units at their own versions with the application and skills", async (t) => {
  const cascade = {
    protocol: "0.2.0", "dashboard-client": "0.1.9", "typescript-core": "0.1.9", "typescript-node": "0.1.9",
    "next-adapter": "0.1.9", "conformance-runner": "0.1.9", gauntlet: "0.1.9", skills: "0.1.9",
  };
  const { calls, manifest, report } = await stagePlan(t, cascade, Object.keys(cascade));
  assert.deepEqual(manifest.units.map(({ id }) => id), [
    "protocol", "dashboard-client", "gauntlet", "typescript-core", "typescript-node", "next-adapter", "conformance-runner", "skills",
  ]);
  assert.deepEqual(identities(manifest), [
    ...APPLICATION("0.1.9"),
    ["conformance-runner", "npm", "@8lines/gauntlet-conformance-runner", "npm/8lines-gauntlet-conformance-runner-0.1.9.tgz"],
    ["dashboard-client", "npm", "@8lines/gauntlet-dashboard-client", "npm/8lines-gauntlet-dashboard-client-0.1.9.tgz"],
    ["next-adapter", "npm", "@8lines/gauntlet-next-adapter", "npm/8lines-gauntlet-next-adapter-0.1.9.tgz"],
    ["protocol", "npm", "@8lines/gauntlet-protocol", "npm/8lines-gauntlet-protocol-0.2.0.tgz"],
    ["typescript-core", "npm", "@8lines/gauntlet-typescript-core", "npm/8lines-gauntlet-typescript-core-0.1.9.tgz"],
    ["typescript-node", "npm", "@8lines/gauntlet-typescript-node", "npm/8lines-gauntlet-typescript-node-0.1.9.tgz"],
    ...IMAGE_EVIDENCE("0.1.9"),
    ["skills", "skills", "gauntlet-skills", "skills/gauntlet-skills-0.1.9.tgz"],
  ]);
  const npmCall = calls.find(([phase]) => phase === "npm");
  assert.deepEqual(npmCall[1], ["protocol", "dashboard-client", "typescript-core", "typescript-node", "next-adapter", "conformance-runner"]);
  assert.equal(npmCall[2].protocol, "0.2.0");
  assert.equal(npmCall[2].widget, "0.1.8");
  assert.equal(report.artifacts, 14);
});

test("a php-core plan stages exactly one Composer archive", async (t) => {
  const { calls, manifest, report, work } = await stagePlan(t, { "php-core": "0.1.9" }, ["php-core"]);
  assert.deepEqual(identities(manifest), [
    ["php-core", "composer", "8lines/gauntlet-php-core", "composer/artifacts/gauntlet-php-core-0.1.9.tar.gz"],
  ]);
  assert.deepEqual(calls, [["composer", ["php-core"], { "php-core": "0.1.9", "symfony-bundle": "0.1.8" }]]);
  assert.equal(report.artifacts, 1);
  assert.equal(report.nativeImage, null);
  assert.deepEqual(readdirSync(work).sort(), ["SHA256SUMS", "composer", "release-manifest.json"]);
});

test("staging rejects units out of dependency order, inconsistent versions and unplanned records", async (t) => {
  const { repository, work } = sandbox(t);
  const versions = { ...BASE_VERSIONS, gauntlet: "0.1.9", skills: "0.1.9" };
  const base = { root: repository, sourceCommit: COMMIT, releaseSet: SET, versions, workDirectory: work };
  await assert.rejects(executeReleaseStage({ ...base, units: [{ id: "skills", version: "0.1.9" }, { id: "gauntlet", version: "0.1.9" }] }, planDependencies([], "0.1.9")));
  await assert.rejects(executeReleaseStage({ ...base, units: [{ id: "gauntlet", version: "0.2.0" }] }, planDependencies([], "0.2.0")));
  await assert.rejects(executeReleaseStage({ ...base, releaseSet: "local-ffffffffffff", units: [{ id: "skills", version: "0.1.9" }] }, planDependencies([], "0.1.9")));
});
```

Adapt the `calls` records to exactly what `planDependencies` pushes (`["npm", include, versions]`, `["composer", include, versions]`, `["maven", include, versions]`, `["skills", version]`, `["compose"]`, `["helm"]`, `["image"]`, `["sbom", platform]`). Also add a `stageRelease` lifecycle test: with fakes `resolvePlan` (returns a dashboard plan), `readVersions`, `verifySource` and a capturing `executeReleaseStage`, it passes `units` from the plan, `versions` as a plain object of all 13 units and the release set; it rejects an empty plan (`Release plan has no units`) and a plan disagreeing with `readVersions` before creating any directory. Update the existing `stageRelease`/`executeReleaseStage`/`parseStageArguments` tests to the new option keys.

In `discard-staged.test.mjs`, use `.artifacts/release/release-2026-10-03.1` (and a `local-111111111111` case where `COMMIT = "1".repeat(40)`), a verifier asserting `{ outputDirectory, releaseSet, sourceCommit }`, and add: a root whose name is a version (`.artifacts/release/0.1.0`) is rejected by the parser; a `local-` root that does not match the source commit is rejected. In `verify-inventory.test.mjs`, use set-id roots. In `publish-composer.test.mjs`, build the release fixture with `writeReleaseInventory` (schema 2) for a `[php-core, symfony-bundle]` plan at different versions (`0.1.0`, `0.1.1`) and assert `createComposerPublicationPlan({ releaseDirectory, sourceCommit, unit: "symfony-bundle" })` returns version `0.1.1`, prefix `gauntlet-symfony-bundle-0.1.1` and the bundle remote; a unit not staged or not Composer is rejected. In `security.test.mjs`, add an accepted `.artifacts/release/local-0123456789ab/image/gauntlet-0.1.0.docker.tar` case. In `documented-commands.test.mjs`, the fixture writes a schema 2 `release-manifest.json` containing a `gauntlet` unit under `.artifacts/release/release-2026-10-03.1`, the inventory report fake is schema 2, and a manifest without `gauntlet` is rejected. In `dry-run.test.mjs`, replace every `.artifacts/release/${VERSION}` with `.artifacts/release/local-111111111111`, make the stage fake print `{ artifacts: 19, outputDirectory, releaseSet: "local-111111111111", sourceCommit: COMMIT, units: <13 units at VERSION> }`, the inventory fake print the schema 2 report, and expect the stage invocation `[stage.mjs, "--output", releaseRoot, "--release-set", "local-111111111111"]`.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/release/test/inventory.test.mjs scripts/release/test/stage.test.mjs`
Expected: FAIL (`expectedUnitArtifacts` is not exported; schema 1 manifests are produced).

- [ ] **Step 3: Implement `inventory.mjs`**

Replace `expectedReleaseArtifactIdentity` and the manifest functions:

```js
import { parseReleaseSetId } from "./plan.mjs";
import { dependencyOrder, unitById, unitTag } from "./units.mjs";

const npmArchive = (name, version) => `npm/${name.replace(/^@/u, "").replaceAll("/", "-")}-${version}.tgz`;

export function expectedUnitArtifacts(unitId, rawVersion) {
  const unit = unitById(unitId);
  const version = stableVersion(rawVersion);
  const name = unit.artifacts[0];
  let records;
  if (unit.kind === "npm") records = [{ kind: "npm", name, path: npmArchive(name, version) }];
  else if (unit.kind === "composer") {
    const { repository } = RELEASE_ARTIFACTS.composer.find((artifact) => artifact.name === name);
    records = [{ kind: "composer", name, path: `composer/artifacts/${repository.split("/").at(-1)}-${version}.tar.gz` }];
  } else if (unit.kind === "maven") {
    records = [{ kind: "maven", name, path: `maven/artifacts/gauntlet-${name.split(":")[1]}-${version}.tar.gz` }];
  } else if (unit.kind === "skills") {
    records = [{ kind: "skills", name: RELEASE_ARTIFACTS.skills.name, path: `skills/gauntlet-skills-${version}.tgz` }];
  } else {
    const image = RELEASE_ARTIFACTS.image.name;
    records = [
      { kind: "compose", name: RELEASE_ARTIFACTS.compose.name, path: `compose/gauntlet-compose-${version}.tar.gz` },
      { kind: "helm", name: RELEASE_ARTIFACTS.chart.name, path: `helm/gauntlet-${version}.tgz` },
      { kind: "docker", name: "gauntlet.local/gauntlet", path: `image/gauntlet-${version}.docker.tar` },
      { kind: "oci", name: image, path: `image/gauntlet-${version}.oci.tar` },
      { kind: "provenance", name: `${image}@buildkit-unsigned`, path: `image/gauntlet-${version}.provenance.json` },
      { kind: "sbom", name: `${image}@linux/amd64`, path: "sbom/gauntlet-linux-amd64.spdx.json" },
      { kind: "sbom", name: `${image}@linux/arm64`, path: "sbom/gauntlet-linux-arm64.spdx.json" },
    ];
  }
  return Object.freeze(records.map((record) => Object.freeze({ unit: unit.id, ...record })).sort(compareArtifacts));
}

export function expectedReleaseArtifacts(units) {
  return Object.freeze(units.flatMap(({ id, version }) => expectedUnitArtifacts(id, version)).sort(compareArtifacts));
}

function parseUnits(value) {
  const entries = ownArray(value).map((candidate) => {
    const keys = Object.keys(candidate ?? {});
    const record = ownData(candidate, keys.includes("tag") ? ["id", "version", "tag"] : ["id", "version"]);
    let unit;
    try { unit = unitById(record.id); } catch { inputFailure(); }
    const version = stableVersion(record.version);
    const tag = unitTag(unit, version);
    if (record.tag !== undefined && record.tag !== tag) inputFailure();
    return Object.freeze({ id: unit.id, version, tag });
  });
  const ids = entries.map(({ id }) => id);
  if (new Set(ids).size !== ids.length || JSON.stringify(dependencyOrder(ids)) !== JSON.stringify(ids)) inputFailure();
  return Object.freeze(entries);
}
```

- `parseArtifacts(value, requireHash, unitIds)`: records have keys `unit, kind, name, path` (+ `sha256`), `unit` must be in `unitIds`; the returned objects are `{ unit, kind, name, path, sha256? }`.
- `createReleaseManifest(options)`: `ownData(options, ["releaseSet", "sourceCommit", "units", "artifacts"])`; `releaseSet` via `parseReleaseSetId` (any failure is `inputFailure()`); commit check; `units = parseUnits(values.units)`; returns frozen `{ schemaVersion: 2, releaseSet, sourceCommit, units, artifacts: parseArtifacts(values.artifacts, true, units.map(({ id }) => id)) }`.
- `writeReleaseInventory`: keys `outputDirectory, releaseSet, sourceCommit, units, artifacts`; unchanged hashing and file creation.
- `verifyReleaseInventory({ outputDirectory, releaseSet, sourceCommit })`: the manifest's own keys must be exactly the schema 2 keys with `schemaVersion === 2`, `releaseSet` and `sourceCommit` equal to the options; rebuild with `createReleaseManifest` and require byte equality; `expected = expectedReleaseArtifacts(manifest.units)` compared with the manifest identities (`unit, kind, name, path`); keep checksum, hash, closed-tree and root identity checks; `const hasApplication = manifest.units.some(({ id }) => id === "gauntlet")`; `nativeImage`, `multiPlatformOci`, `helmChart` are computed as today when `hasApplication`, else `null`; return `{ schemaVersion: 2, ok: true, releaseSet, sourceCommit, units: manifest.units, artifacts: manifest.artifacts.length, manifestSha256, checksumsSha256, nativeImage, multiPlatformOci, helmChart }`.
- `verifyStagedReleaseInventory(outputDirectory)`: read `releaseSet` and `sourceCommit` from the manifest, require `basename(root) === releaseSet`, then call `verifyReleaseInventory`.
- `readReleaseManifest(outputDirectory)`: read `release-manifest.json` with `readRegularFile`, parse, rebuild with `createReleaseManifest` and require canonical byte equality; return `{ manifest, bytes }`.

`release-manifest.schema.json`: `"required": ["schemaVersion", "releaseSet", "sourceCommit", "units", "artifacts"]`; `"schemaVersion": { "const": 2 }`; `"releaseSet": { "type": "string", "pattern": "^(?:release-[0-9]{4}-[0-9]{2}-[0-9]{2}\\.[1-9][0-9]{0,2}|local-[0-9a-f]{12})$" }`; `"units": { "type": "array", "minItems": 1, "maxItems": 13, "items": { "$ref": "#/$defs/unit" } }`; `$defs.unit` = closed object `{ id: { "enum": [13 ids] }, version: <existing version pattern>, tag: { "type": "string", "pattern": "^(?:v|[a-z]+(?:-[a-z]+)*-v)(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$" } }`; `$defs.artifact` requires `unit` (same enum) before `kind`. Remove `version` and `sourceTag`.

- [ ] **Step 4: Implement `stage.mjs`**

- `validateRecordArray(records, kind, expected, versionOf, directory, expectedParent)` where `versionOf(name)` returns that artifact's version; `validateVersionedRecord` unchanged.
- `archiveTrees(workDirectory, kind, records, outputDirectory, packager)` uses `record.version` per record.
- Replace `executeReleaseStage`:

```js
function stageUnits(value) {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError("Release staging units must be a non-empty array");
  const units = value.map((entry) => {
    const record = exactDataObject(entry, ["id", "version"], "Release staging unit");
    unitById(record.id);
    return Object.freeze({ id: record.id, version: stableVersion(record.version) });
  });
  const ids = units.map(({ id }) => id);
  if (new Set(ids).size !== ids.length || JSON.stringify(dependencyOrder(ids)) !== JSON.stringify(ids)) {
    throw new TypeError("Release staging units must be distinct and in dependency order");
  }
  return Object.freeze(units);
}

function stageVersions(value, units) {
  const record = exactDataObject(value, RELEASE_UNITS.map(({ id }) => id), "Release staging unit versions");
  const versions = Object.freeze(Object.fromEntries(Object.entries(record).map(([id, version]) => [id, stableVersion(version)])));
  if (units.some(({ id, version }) => versions[id] !== version)) failClosed();
  return versions;
}

const pick = (versions, ids) => Object.freeze(Object.fromEntries(ids.map((id) => [id, versions[id]])));

export async function executeReleaseStage(options, dependencyOverrides) {
  const values = exactDataObject(
    options,
    ["root", "sourceCommit", "releaseSet", "units", "versions", "workDirectory"],
    "Release staging execution options",
  );
  const root = values.root;
  const workDirectory = values.workDirectory;
  canonicalDirectory(root, "Release staging root");
  canonicalDirectory(workDirectory, "Release staging work directory", true);
  if (workDirectory.startsWith(`${root}${sep}`) || root.startsWith(`${workDirectory}${sep}`)
      || readdirSync(workDirectory).length !== 0) failClosed();
  const sourceCommit = fullCommit(values.sourceCommit);
  let releaseSet;
  try { releaseSet = parseReleaseSetId(values.releaseSet, sourceCommit); } catch { throw new TypeError("Release staging release set is invalid"); }
  const units = stageUnits(values.units);
  const versions = stageVersions(values.versions, units);
  const planned = new Set(units.map(({ id }) => id));
  const included = (ids) => ids.filter((id) => planned.has(id));
  const catalogFor = (records, ids) => ids.map((id) => records.find(({ name }) => unitIdForArtifact(name) === id));
  const versionOfName = (name) => versions[unitIdForArtifact(name)];
  const dependencies = dependencySet(dependencyOverrides);
  const descriptors = [];
  const add = (record) => descriptors.push(Object.freeze({
    unit: unitIdForArtifact(record.kind === "docker" || record.kind === "provenance" || record.kind === "sbom" ? RELEASE_ARTIFACTS.image.name : record.name),
    ...artifactDescriptor(workDirectory, record),
  }));

  const npmUnits = included(NPM_UNIT_IDS);
  if (npmUnits.length > 0) {
    const npmDirectory = makePrivateDirectory(join(workDirectory, "npm"));
    const npm = validateRecordArray(
      await dependencies.stageNpmPackages({ root, outputDirectory: npmDirectory, versions: pick(versions, NPM_UNIT_IDS), include: npmUnits }),
      "npm", catalogFor(RELEASE_ARTIFACTS.npm, npmUnits), versionOfName, false, npmDirectory,
    );
    npm.forEach(add);
  }

  const composerUnits = included(COMPOSER_UNIT_IDS);
  if (composerUnits.length > 0) {
    // Same body as today's Composer block (lines 503-523) with the expected catalog
    // `catalogFor(RELEASE_ARTIFACTS.composer, composerUnits)`, `versionOfName`, the stager called with
    // `{ root, outputDirectory: composerRepositories, sourceCommit, versions: pick(versions, COMPOSER_UNIT_IDS), include: composerUnits }`,
    // the repository/repositoryUrl/sourceCommit loop over that expected catalog, and `archiveTrees(...).forEach(add)`.
  }

  const mavenUnits = included(MAVEN_UNIT_IDS);
  if (mavenUnits.length > 0) {
    // Same body as today's Maven block (lines 525-541) with `catalogFor(RELEASE_ARTIFACTS.maven, mavenUnits)`,
    // `versionOfName`, and the stager called with `{ root, outputDirectory: mavenRepository, versions: pick(versions, MAVEN_UNIT_IDS), include: mavenUnits }`.
  }

  if (planned.has("skills")) {
    // Today's skills block (lines 543-552) with `version: versions.skills` in the stager options and validation.
  }

  if (planned.has("gauntlet")) {
    const version = versions.gauntlet;
    // Today's compose, helm, image and SBOM blocks (lines 554-624) unchanged except that every `version`
    // is `versions.gauntlet` and each validated record is passed to `add`.
  }

  const expected = expectedReleaseArtifacts(units);
  const actual = [...descriptors].sort((left, right) => Buffer.compare(Buffer.from(`${left.kind}\0${left.name}\0${left.path}`), Buffer.from(`${right.kind}\0${right.name}\0${right.path}`)))
    .map(({ unit, kind, name, path }) => ({ unit, kind, name, path }));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) failClosed();
  assertDistinctDescriptors(descriptors);
  const manifest = await dependencies.writeReleaseInventory({
    outputDirectory: workDirectory, releaseSet, sourceCommit, units, artifacts: descriptors,
  });
  if (manifest === null || typeof manifest !== "object" || manifest.schemaVersion !== 2 || manifest.releaseSet !== releaseSet
      || manifest.sourceCommit !== sourceCommit || !Array.isArray(manifest.units)
      || JSON.stringify(manifest.units.map(({ id, version }) => ({ id, version }))) !== JSON.stringify(units)
      || !Array.isArray(manifest.artifacts) || manifest.artifacts.length !== descriptors.length) failClosed();
  return manifest;
}
```

The four commented blocks are mechanical moves of the existing code named by line range; keep every existing validation (support-tree removal, image record count and kinds, SBOM naming). Use the same byte comparison as `inventory.mjs` `compareArtifacts` (kind, then name, then path) for `actual`; export `compareArtifacts` from `inventory.mjs` and import it rather than re-implementing it if simpler. Map docker, provenance and SBOM descriptors to `gauntlet` exactly as `add` does.
- `stageLifecycle` keys: `executeReleaseStage`, `verifySource`, `resolvePlan` (default `(root, path) => resolveReleasePlan(root, path)`), `readVersions` (default `readUnitVersions`).
- `stageRelease(options, lifecycle)`: keys `root, outputDirectory, sourceCommit, releaseSet, planPath`; after the first `verifySource`: `const { plan } = lifecycle.resolvePlan(root, planPath)`; empty plan throws `Release plan has no units`; `const versions = lifecycle.readVersions(root)`; `validatePlanAgainstManifests(plan, versions)` non-empty throws `Release plan disagrees with manifests: <first problem>`; `releaseSet` is `parseReleaseSetId(values.releaseSet ?? localReleaseSetId(sourceCommit), sourceCommit)`; call `executeReleaseStage({ root, sourceCommit, releaseSet, units: plan.units.map(({ id, to }) => ({ id, version: to })), versions: Object.fromEntries(versions), workDirectory })`. All of this happens before `ensureOutputParent` creates anything.
- `parseStageArguments` per Interfaces (unknown flags, duplicates, a missing value or a relative path with `..` segments throw `USAGE = "Usage: stage.mjs --output PATH [--plan PATH] [--release-set ID]"`).
- CLI prints `{ artifacts: manifest.artifacts.length, outputDirectory, releaseSet: manifest.releaseSet, sourceCommit: manifest.sourceCommit, units: manifest.units.map(({ id, version }) => ({ id, version })) }`.
- Remove the `RELEASE_STAGE_ARTIFACT_COUNT` import.

- [ ] **Step 5: Implement the consumers**

- `verify-inventory.mjs`: `USAGE = "Usage: verify-inventory.mjs --release-root ABSOLUTE_PATH/.artifacts/release/<set-id>"`; `parseVerifyInventoryArguments` additionally requires `parseReleaseSetId(basename(argv[1]))` to succeed.
- `discard-staged.mjs`: `USAGE = "Usage: discard-staged.mjs --release-root .artifacts/release/<set-id> --source-commit FULL_SHA"`; the parser matches `^\.artifacts\/release\/([A-Za-z0-9.-]+)$` and requires `parseReleaseSetId(match[1], sourceCommit)`; `discardStagedRelease` derives `releaseSet = basename(releaseRoot)` (same commit-bound validation), checks `releaseRoot === resolve(root, ".artifacts", "release", releaseSet)`, calls the verifier with `{ outputDirectory, releaseSet, sourceCommit }` both times and requires `schemaVersion === 2`, `ok === true`, `releaseSet`, `sourceCommit` and `Number.isInteger(artifacts) && artifacts > 0`; quarantine name `${releaseSet}-${sourceCommit.slice(0, 12)}-${token}`; report per Interfaces. Remove `parseReleaseVersion` and `RELEASE_STAGE_ARTIFACT_COUNT` imports.
- `publish-composer.mjs`: `readComposerReleaseManifest(releaseDirectory, commit)` calls `verifyReleaseInventory({ outputDirectory: releaseDirectory, releaseSet: basename(releaseDirectory), sourceCommit: commit })`, re-reads the manifest bytes and requires the hash match and canonical bytes (schema 2 via `createReleaseManifest`); `createComposerPublicationPlan({ releaseDirectory, sourceCommit, unit })` requires `unit` in `COMPOSER_UNIT_IDS` and in `manifest.units`, takes its `version` from `manifest.units`, and builds one entry with `filename = `${leaf}-${version}.tar.gz`` (record must have that exact path); `publishComposerRepositories({ releaseDirectory, sourceCommit, unit }, deps)` materializes that one archive, validates its contract with the unit's version and publishes with `version` = the unit's version (tag `v<version>` unchanged in `publishComposerPackage`); `parseCli` expects exactly `--release-directory ABS --source-commit SHA --unit ID`.
- `security.mjs`: `parseSecurityArguments` accepts `^\.artifacts\/release\/([A-Za-z0-9.-]+)\/image\/gauntlet-((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))\.docker\.tar$` where group 1 is either equal to group 2 or a valid `parseReleaseSetId` value; `validateStagedImageArchive(root, imageArchive)` requires the version in the file name to equal `readReleaseVersion(root)` and the directory to be the version or a valid set id; `relativePath` is the path actually used.
- `verify-documented-commands.mjs`: `parseDocumentedCommandArguments` requires `.artifacts/release/<set-id>`; `planDocumentedCommandChecks` reads the manifest with `readReleaseManifest(releaseRoot)`, takes `version` from the `gauntlet` unit (missing → fail closed), requires `releaseRoot === resolve(root, ".artifacts/release", manifest.releaseSet)`; `validateInventoryReport` expects the schema 2 report (`releaseSet`, `units`, integer `artifacts`, non-null image and chart evidence with the gauntlet version). Remove the `RELEASE_STAGE_ARTIFACT_COUNT` and `readReleaseVersion` imports.
- `dry-run.mjs`: compute `releaseSet = localReleaseSetId(state.sourceCommit)` after the first source observation; `releaseRoot = resolve(root, ".artifacts", "release", releaseSet)`; stage arguments add `"--release-set", releaseSet`; `validateStageOutput(result, root, releaseRoot, releaseSet, sourceCommit)` checks the new keys, non-empty dependency-ordered `units` containing `gauntlet` at `state.version` (no plan scoping yet) and `artifacts === expectedReleaseArtifacts(units).length`; `validateInventoryOutput(result, releaseSet, sourceCommit, units)` checks the schema 2 report and the image/chart paths with the gauntlet version; the security archive and documentation release root use `.artifacts/release/${releaseSet}`; `createLocalRegistryPlan` requires `releaseRoot === resolve(root, ".artifacts", "release", basename(releaseRoot))` with a valid set id; the report adds `releaseSet`. Remove the `RELEASE_STAGE_ARTIFACT_COUNT` import.

- [ ] **Step 6: Run**

Run: `node --test scripts/release/test/*.test.mjs scripts/docs/test/*.test.mjs && pnpm release:test`
Expected: PASS. Then rehearse staging only (no publication): `pnpm build && node scripts/release/stage.mjs --output "$PWD/.artifacts/release/local-$(git rev-parse HEAD | cut -c1-12)"` followed by `node scripts/release/verify-inventory.mjs --release-root "$PWD/.artifacts/release/local-$(git rev-parse HEAD | cut -c1-12)"`; expected 19 artifacts and a schema 2 report; then remove it with `pnpm release:discard-staged --release-root ".artifacts/release/local-$(git rev-parse HEAD | cut -c1-12)" --source-commit "$(git rev-parse HEAD)"`. (Staging needs Docker and takes several minutes; skip only if Docker is unavailable and say so in the report.)

- [ ] **Step 7: Commit**

```bash
git add scripts/release/inventory.mjs scripts/release/release-manifest.schema.json scripts/release/stage.mjs scripts/release/verify-inventory.mjs scripts/release/discard-staged.mjs scripts/release/publish-composer.mjs scripts/release/security.mjs scripts/release/dry-run.mjs scripts/docs/verify-documented-commands.mjs scripts/release/test scripts/docs/test
git commit -m "feat(release): stage plan units into release-set roots with per-unit inventory

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Per-unit preflight state

**Files:**
- Modify: `scripts/release/check-published.mjs` (add new exports after `PUBLISHED_DESTINATIONS`, line ~145; the old fixed-catalog functions stay until Task 8)
- Test: `scripts/release/test/check-published-units.test.mjs` (new file)

**Interfaces:**
- Consumes: `RELEASE_ARTIFACTS` (`release-model.mjs`), `unitById`, `unitTag` (`units.mjs`).
- Produces:
  - `unitDestinations(unitId): readonly { id, kind, target }[]` without the GitHub Release: npm `npm:<package leaf>`; Composer `composer:<php-core|symfony-bundle>` (target = split repository URL); Maven `maven:<core|spring-boot-starter>`; `gauntlet` `image:semantic`, `image:commit`, `chart:semantic`; `skills` none.
  - `createUnitCheckPlan({ unit, version, sourceCommit, evidence }): readonly UnitCheck[]` with `UnitCheck = Readonly<{ id, unit, kind, destination, expectedEvidence, version, tag }>`; destinations are `unitDestinations(unit)` followed by `{ id: "github:<tag>", kind: "release" }`; `evidence` must name exactly those ids with the existing per-kind formats; release destination URL `https://github.com/8lines/gauntlet/releases/tag/<tag>`; npm/Maven/image/chart/Composer URLs as `destinationUrl` builds today (Composer `#v<version>`).
  - `evaluateUnitState(checks, observations): "clean" | "already-identical"`; mixed presence throws `Release unit <id> is partially published`; different evidence throws `Remote destination <id> has different evidence`; incomplete or unknown observations throw `Remote probes did not return a complete observation set`.
  - `evaluateReleaseSetState(plans: readonly (readonly UnitCheck[])[], observations): readonly Readonly<{ id, state }>[]` in plan order; any unit failure fails the whole set.
  - `checkUnitDestinations({ plans, probe }): Promise<readonly { id, state }[]>`: probes every check of every unit (all settled) before evaluating.

- [ ] **Step 1: Write the failing tests** in `scripts/release/test/check-published-units.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

import {
  checkUnitDestinations, createUnitCheckPlan, evaluateReleaseSetState, evaluateUnitState, unitDestinations,
} from "../check-published.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

function evidenceFor(unit, tag) {
  const ids = [...unitDestinations(unit).map(({ id, kind }) => [id, kind]), [`github:${tag}`, "release"]];
  return Object.fromEntries(ids.map(([id, kind], index) => [id,
    kind === "npm" ? `sha512-${Buffer.alloc(64, index + 1).toString("base64")}`
      : kind === "image" ? `sha256:${String(index + 1).repeat(64).slice(0, 64)}`
        : kind === "composer" ? String(index + 1).repeat(40).slice(0, 40)
          : String(index + 1).repeat(64).slice(0, 64)]));
}

function plan(unit, version, tag) {
  return createUnitCheckPlan({ unit, version, sourceCommit: COMMIT, evidence: evidenceFor(unit, tag) });
}

const absent = (checks) => checks.map(({ id }) => ({ id, state: "absent" }));
const identical = (checks) => checks.map(({ id, expectedEvidence }) => ({ id, state: "present", evidence: expectedEvidence }));

test("every unit has its own destinations and its own GitHub Release", () => {
  assert.deepEqual(plan("gauntlet", "0.1.9", "v0.1.9").map(({ id }) => id), ["image:semantic", "image:commit", "chart:semantic", "github:v0.1.9"]);
  assert.deepEqual(plan("skills", "0.1.9", "skills-v0.1.9").map(({ id }) => id), ["github:skills-v0.1.9"]);
  assert.deepEqual(plan("protocol", "0.2.0", "protocol-v0.2.0").map(({ id }) => id), ["npm:protocol", "github:protocol-v0.2.0"]);
  assert.deepEqual(plan("php-core", "0.1.9", "php-core-v0.1.9").map(({ id, destination }) => [id, destination]), [
    ["composer:php-core", "https://github.com/8lines/gauntlet-php-core.git#v0.1.9"],
    ["github:php-core-v0.1.9", "https://github.com/8lines/gauntlet/releases/tag/php-core-v0.1.9"],
  ]);
  assert.deepEqual(plan("spring-boot-starter", "0.1.9", "spring-boot-starter-v0.1.9").map(({ id }) => id), [
    "maven:spring-boot-starter", "github:spring-boot-starter-v0.1.9",
  ]);
  assert.throws(() => createUnitCheckPlan({ unit: "skills", version: "0.1.9", sourceCommit: COMMIT, evidence: {} }));
  assert.throws(() => createUnitCheckPlan({ unit: "skills", version: "0.1.9", sourceCommit: COMMIT, evidence: evidenceFor("skills", "skills-v0.1.8") }));
});

test("a unit is clean or identical as a whole and fails closed when partially published", () => {
  const checks = plan("protocol", "0.2.0", "protocol-v0.2.0");
  assert.equal(evaluateUnitState(checks, absent(checks)), "clean");
  assert.equal(evaluateUnitState(checks, identical(checks)), "already-identical");
  const registryOnly = [identical(checks)[0], absent(checks)[1]];
  assert.throws(() => evaluateUnitState(checks, registryOnly), /Release unit protocol is partially published/u);
  const releaseOnly = [absent(checks)[0], identical(checks)[1]];
  assert.throws(() => evaluateUnitState(checks, releaseOnly), /partially published/u);
  const different = identical(checks).map((observation, index) => index === 0 ? { ...observation, evidence: `sha512-${Buffer.alloc(64, 9).toString("base64")}` } : observation);
  assert.throws(() => evaluateUnitState(checks, different), /Remote destination npm:protocol has different evidence/u);
  assert.throws(() => evaluateUnitState(checks, absent(checks).slice(1)), /complete observation set/u);
});

test("a release set may mix clean and identical units but one partial unit fails the set", () => {
  const plans = [plan("protocol", "0.2.0", "protocol-v0.2.0"), plan("gauntlet", "0.1.9", "v0.1.9"), plan("skills", "0.1.9", "skills-v0.1.9")];
  assert.deepEqual(evaluateReleaseSetState(plans, [...identical(plans[0]), ...absent(plans[1]), ...absent(plans[2])]), [
    { id: "protocol", state: "already-identical" },
    { id: "gauntlet", state: "clean" },
    { id: "skills", state: "clean" },
  ]);
  const partialGauntlet = [...identical(plans[0]), ...identical(plans[1]).slice(0, 3), ...absent(plans[1]).slice(3), ...absent(plans[2])];
  assert.throws(() => evaluateReleaseSetState(plans, partialGauntlet), /Release unit gauntlet is partially published/u);
  assert.throws(() => evaluateReleaseSetState(plans, [...absent(plans[0]), ...absent(plans[1])]), /complete observation set/u);
});

test("every probe of every unit runs before the set is evaluated", async () => {
  const plans = [plan("protocol", "0.2.0", "protocol-v0.2.0"), plan("skills", "0.1.9", "skills-v0.1.9")];
  const calls = [];
  assert.deepEqual(await checkUnitDestinations({ plans, probe: async (check) => { calls.push(check.id); return { id: check.id, state: "absent" }; } }), [
    { id: "protocol", state: "clean" }, { id: "skills", state: "clean" },
  ]);
  assert.deepEqual(calls, ["npm:protocol", "github:protocol-v0.2.0", "github:skills-v0.1.9"]);
  const failing = [];
  await assert.rejects(checkUnitDestinations({ plans, probe: async (check) => {
    failing.push(check.id);
    if (check.id === "npm:protocol") throw new Error("registry unavailable");
    return { id: check.id, state: "absent" };
  } }), /registry unavailable/u);
  assert.equal(failing.length, 3);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/release/test/check-published-units.test.mjs`
Expected: FAIL, the new exports do not exist.

- [ ] **Step 3: Implement** in `check-published.mjs` (import `unitById`, `unitTag` from `./units.mjs`):

```js
const GITHUB_RELEASES = "https://github.com/8lines/gauntlet/releases/tag";

export function unitDestinations(unitId) {
  const unit = unitById(unitId);
  const name = unit.artifacts[0];
  const records = unit.kind === "npm" ? [{ id: `npm:${name.slice("@8lines/gauntlet-".length)}`, kind: "npm", target: name }]
    : unit.kind === "composer" ? [{
      id: `composer:${name.slice("8lines/gauntlet-".length)}`,
      kind: "composer",
      target: RELEASE_ARTIFACTS.composer.find((artifact) => artifact.name === name).repositoryUrl,
    }]
      : unit.kind === "maven" ? [{ id: `maven:${name.split(":")[1]}`, kind: "maven", target: name }]
        : unit.kind === "application" ? [
          { id: "image:semantic", kind: "image", target: RELEASE_ARTIFACTS.image.name },
          { id: "image:commit", kind: "image", target: RELEASE_ARTIFACTS.image.name },
          { id: "chart:semantic", kind: "chart", target: RELEASE_ARTIFACTS.chart.repository },
        ]
          : [];
  return Object.freeze(records.map((record) => Object.freeze(record)));
}

function unitTemplates(unitId, tag) {
  return [...unitDestinations(unitId), Object.freeze({ id: `github:${tag}`, kind: "release", target: GITHUB_RELEASES })];
}

function unitDestinationUrl(template, version, commit, tag) {
  return template.kind === "release" ? `${template.target}/${tag}` : destinationUrl(template, version, commit);
}

function evidencePattern(kind) {
  return kind === "npm" ? NPM_INTEGRITY : kind === "image" ? OCI_DIGEST : kind === "composer" ? COMMIT : SHA256;
}

export function createUnitCheckPlan(options) {
  const values = ownData(options, ["unit", "version", "sourceCommit", "evidence"], "Unit check plan options");
  const unit = unitById(values.unit);
  const version = stableVersion(values.version);
  const commit = sourceCommit(values.sourceCommit);
  const tag = unitTag(unit, version);
  const templates = unitTemplates(unit.id, tag);
  const evidence = ownData(values.evidence, templates.map(({ id }) => id), "Unit evidence");
  return Object.freeze(templates.map((template) => {
    const expectedEvidence = evidence[template.id];
    if (typeof expectedEvidence !== "string" || !evidencePattern(template.kind).test(expectedEvidence)) {
      throw new TypeError(`Published evidence for ${template.id} is invalid`);
    }
    return Object.freeze({
      id: template.id, unit: unit.id, kind: template.kind,
      destination: unitDestinationUrl(template, version, commit, tag), expectedEvidence, version, tag,
    });
  }));
}

function assertUnitChecks(checks) {
  if (!Array.isArray(checks) || checks.length === 0 || checks.some((check) => !Object.isFrozen(check)
      || typeof check.id !== "string" || check.unit !== checks[0].unit || typeof check.expectedEvidence !== "string")) {
    throw new TypeError("Published unit check plan is invalid");
  }
  return checks;
}

export function evaluateUnitState(checks, observations) {
  assertUnitChecks(checks);
  if (!Array.isArray(observations) || utilTypes.isProxy(observations) || observations.length !== checks.length) {
    throw new Error("Remote probes did not return a complete observation set");
  }
  const byId = new Map();
  for (const candidate of observations) {
    const expected = checks.find((check) => check.id === candidate?.id);
    if (expected === undefined || byId.has(expected.id)) throw new Error("Remote probes did not return a complete observation set");
    byId.set(expected.id, observationValue(candidate, expected));
  }
  const ordered = checks.map(({ id }) => byId.get(id));
  const present = ordered.filter(({ state }) => state === "present");
  if (present.length === 0) return "clean";
  for (const [index, observation] of ordered.entries()) {
    if (observation.state === "present" && observation.evidence !== checks[index].expectedEvidence) {
      throw new Error(`Remote destination ${observation.id} has different evidence`);
    }
  }
  if (present.length !== checks.length) throw new Error(`Release unit ${checks[0].unit} is partially published`);
  return "already-identical";
}

export function evaluateReleaseSetState(plans, observations) {
  if (!Array.isArray(plans) || plans.length === 0 || !Array.isArray(observations)
      || observations.length !== plans.reduce((total, checks) => total + assertUnitChecks(checks).length, 0)) {
    throw new Error("Remote probes did not return a complete observation set");
  }
  return Object.freeze(plans.map((checks) => {
    const ids = new Set(checks.map(({ id }) => id));
    const state = evaluateUnitState(checks, observations.filter((observation) => ids.has(observation?.id)));
    return Object.freeze({ id: checks[0].unit, state });
  }));
}

export async function checkUnitDestinations(options) {
  const values = ownData(options, ["plans", "probe"], "Published unit check options");
  if (typeof values.probe !== "function") throw new TypeError("Published destination probe must be a function");
  const checks = values.plans.flatMap((plan) => assertUnitChecks(plan));
  const settled = await Promise.allSettled(checks.map((check) => Promise.resolve().then(() => values.probe(check))));
  const failure = settled.find(({ status }) => status === "rejected");
  if (failure !== undefined) throw failure.reason;
  return evaluateReleaseSetState(values.plans, settled.map(({ value }) => value));
}
```

Note: the different-evidence check runs before the partial check, so a mismatched present destination reports the precise destination.

- [ ] **Step 4: Run**

Run: `node --test scripts/release/test/check-published-units.test.mjs && pnpm release:test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/release/check-published.mjs scripts/release/test/check-published-units.test.mjs
git commit -m "feat(release): evaluate published state per release unit

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Per-unit evidence, receipts and GitHub Release verification

**Files:**
- Modify: `scripts/release/check-published.mjs`: remove `githubReleaseAssetCatalog(releaseVersion)` 49-63, `stagedArtifactCatalog` 65-113, `PUBLISHED_DESTINATIONS` 123-145, `exactEvidence` 178-204, `createPublishedCheckPlan` 316-329, `assertPlan` 331-341, `evaluatePublishedState` 365-390, `checkPublishedDestinations` 392-400; rewrite `publicationReceiptBytes` 237-240, `parsePublicationReceipt` 242-266, `parseReleaseAssets` 268-293, `evaluatePublishedArtifactsBeforeRelease` 409-426, `verifyPublishedArtifactsWithRetry` 464-492, `checkReleasePublication` 494-512, `checkDraftReleasePublication` 514-543, `writePublicationReceipt` 627-690, `validateStagedManifest` 758-786, `readStagedManifest` 788-792, `finalizedChecksumsBytes` 800-808, `releaseAssetHashes` 810-858, `githubReleaseEvidence` 860-870, `localPublication` 872-888, `localGithubReleaseEvidence` 890-919, `collectReleaseEvidence` 994-1091, `githubDraftByTag` 1133-1144, `publishedReceipt` 1226-1248, `probeGithubRelease` 1402-1424, `probeRemoteDestination` 1434-1463, `parsePublishedArguments` 1467-1508 and the CLI 1510-1537
- Test: `scripts/release/test/check-published.test.mjs` (convert), `scripts/release/test/check-published-units.test.mjs` (extend)

**Interfaces:**
- Consumes: Task 7 functions; `expectedReleaseArtifacts`, `createReleaseManifest` (Task 6); `unitById`, `unitTag`; `parseReleaseSetId`.
- Produces:
  - `unitReleaseManifest(manifest, unitId)` → frozen `{ schemaVersion: 2, releaseSet, sourceCommit, units: [<that unit>], artifacts: [<that unit's artifacts>] }`; its bytes are `JSON.stringify(value, null, 2) + "\n"`.
  - `githubReleaseAssetCatalog(unitId, version)` → frozen `[{ name, maximumBytes }]`: the unit's attached artifacts (every staged kind except `docker` and `oci`), named by path basename, then `release-manifest.json` (1 MiB), `publication-receipt.json` (64 KiB), `SHA256SUMS` (1 MiB). Limits: npm 64 MiB, composer 64 MiB, maven 512 MiB, skills 64 MiB, compose 512 MiB, helm 64 MiB, provenance 16 MiB, sbom 128 MiB.
  - `unitReleaseAssets(manifest, unitId)` → frozen `[{ name, maximumBytes, path }]` (`path` relative to the release root: the artifact path, or `units/<unit>/<file>` for the three generated files), same order as the catalog.
  - Receipt bytes: keys in order `schemaVersion, releaseSet, unit, version, sourceCommit, manifestSha256`, plus `imageDigest, chartDigest` for `gauntlet`; `parsePublicationReceipt(source, { releaseSet, unit, version, sourceCommit, manifestSha256 })`.
  - Unit `SHA256SUMS`: `<sha256>  <path>\n` lines sorted bytewise by path over `release-manifest.json`, `publication-receipt.json` and every artifact path of the unit (including the docker and OCI archives for `gauntlet`).
  - GitHub Release evidence: `sha256(JSON.stringify({ schemaVersion: 2, unit, tag, sourceCommit, assets: [{ name, sha256 }] }))` in catalog order.
  - `collectReleaseEvidence({ releaseDirectory, sourceCommit })` → frozen `{ releaseSet, units: [{ id, version, tag, evidence }] }` in plan order.
  - `checkReleasePublication({ releaseDirectory, sourceCommit, requireIdentical, unit }, dependencies)` (`unit: string | null`) → frozen `{ releaseSet, units: [{ id, kind, version, tag, state }] }`; states `clean`, `already-identical`, and with `requireIdentical` `published-artifacts-identical` (registry identical, release absent).
  - `checkDraftReleasePublication({ releaseDirectory, sourceCommit, unit })` → `"draft-identical"`.
  - `writePublicationReceipt({ releaseDirectory, unit, imageDigest, chartDigest })` (digests are strings for `gauntlet`, `null` otherwise) writes `units/<unit>/{release-manifest.json,publication-receipt.json,SHA256SUMS}` and returns `{ unit, files }` (`files` = number of `SHA256SUMS` lines).
  - CLI: `--release-directory ABS --source-commit SHA [--unit ID] [--require-identical | --require-draft-identical]` (`--require-draft-identical` requires `--unit`) printing `{"command":"check","releaseSet":…,"units":[…]}` or `{"command":"verify-draft","unit":…,"tag":…,"assets":N,"state":"draft-identical"}`; `--finalize ABS --unit ID [--image-digest sha256:… --chart-digest sha256:…]` (digests exactly when the unit is `gauntlet`) printing `{"command":"finalize","unit":…,"files":N}`. `--version` is gone.

- [ ] **Step 1: Write the failing tests**

Convert `check-published.test.mjs`:
- `releaseFixture(t, units = <13 units at "0.1.0">)` writes, for `expectedReleaseArtifacts(units)`, the same file kinds as today (npm bytes, canonical Composer and Maven trees, the OCI layout tar, plain files for the rest) and a canonical schema 2 manifest `${JSON.stringify(createReleaseManifest({ releaseSet: SET, sourceCommit: COMMIT, units, artifacts }), null, 2)}\n` into a directory named `SET = "release-2026-10-03.1"` inside the temporary root; return `{ digest, root: releaseDirectory }`.
- Replace `createPublishedCheckPlan`/`evaluatePublishedState`/`checkPublishedDestinations` usages with Task 7's functions; replace the nine-asset expectations with per-unit catalogs; call `checkReleasePublication`/`checkDraftReleasePublication`/`writePublicationReceipt` with the new option keys; the GitHub fetch fakes key on unit tags (`/releases/tags/v0.1.0`, `/releases/tags/skills-v0.1.0`).
- Delete tests that only pin the removed fixed catalog ("builds an immutable check plan only for the fixed release catalog destinations", "accepts only wholly absent or wholly byte-identical remote state", "runs every read-only injected probe before evaluating global state"); Task 7 covers them per unit.

Add to `check-published-units.test.mjs`:

```js
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  collectReleaseEvidence, checkReleasePublication, githubReleaseAssetCatalog, parsePublishedArguments,
  unitReleaseManifest, writePublicationReceipt,
} from "../check-published.mjs";

test("release asset catalogs are per unit and never attach image archives", () => {
  assert.deepEqual(githubReleaseAssetCatalog("gauntlet", "0.1.9").map(({ name }) => name), [
    "gauntlet-compose-0.1.9.tar.gz", "gauntlet-0.1.9.tgz", "gauntlet-0.1.9.provenance.json",
    "gauntlet-linux-amd64.spdx.json", "gauntlet-linux-arm64.spdx.json",
    "release-manifest.json", "publication-receipt.json", "SHA256SUMS",
  ]);
  assert.deepEqual(githubReleaseAssetCatalog("skills", "0.1.9").map(({ name }) => name), [
    "gauntlet-skills-0.1.9.tgz", "release-manifest.json", "publication-receipt.json", "SHA256SUMS",
  ]);
  assert.deepEqual(githubReleaseAssetCatalog("protocol", "0.2.0").map(({ name }) => name)[0], "8lines-gauntlet-protocol-0.2.0.tgz");
  assert.deepEqual(githubReleaseAssetCatalog("php-core", "0.1.9").map(({ name }) => name)[0], "gauntlet-php-core-0.1.9.tar.gz");
  assert.deepEqual(githubReleaseAssetCatalog("java-core", "0.1.9").map(({ name }) => name)[0], "gauntlet-core-0.1.9.tar.gz");
});
```

(The gauntlet order follows the staged artifact order: compose, helm, provenance, sbom amd64, sbom arm64. Write the expected order from `expectedUnitArtifacts("gauntlet", "0.1.9")` filtered to attached kinds if it differs.)

Add, using the converted `releaseFixture` (export it from a small shared helper `scripts/release/test/release-fixture.mjs` so both test files use one builder):

```js
test("finalization writes one manifest, receipt and checksum file per unit", async (t) => {
  const units = [{ id: "gauntlet", version: "0.1.0" }, { id: "skills", version: "0.1.0" }];
  const { root, digest } = releaseFixture(t, units);
  assert.throws(() => writePublicationReceipt({ releaseDirectory: root, unit: "skills", imageDigest: digest, chartDigest: digest }));
  assert.deepEqual(writePublicationReceipt({ releaseDirectory: root, unit: "skills", imageDigest: null, chartDigest: null }), { unit: "skills", files: 3 });
  const manifest = JSON.parse(readFileSync(resolve(root, "release-manifest.json"), "utf8"));
  const unitManifestBytes = readFileSync(resolve(root, "units/skills/release-manifest.json"));
  assert.equal(unitManifestBytes.toString("utf8"), `${JSON.stringify(unitReleaseManifest(manifest, "skills"), null, 2)}\n`);
  const receipt = JSON.parse(readFileSync(resolve(root, "units/skills/publication-receipt.json"), "utf8"));
  assert.deepEqual(Object.keys(receipt), ["schemaVersion", "releaseSet", "unit", "version", "sourceCommit", "manifestSha256"]);
  assert.equal(receipt.manifestSha256, createHash("sha256").update(unitManifestBytes).digest("hex"));
  assert.deepEqual(readFileSync(resolve(root, "units/skills/SHA256SUMS"), "utf8").trimEnd().split("\n").map((line) => line.split("  ")[1]), [
    "publication-receipt.json", "release-manifest.json", "skills/gauntlet-skills-0.1.0.tgz",
  ]);
  assert.throws(() => writePublicationReceipt({ releaseDirectory: root, unit: "gauntlet", imageDigest: null, chartDigest: null }));
  assert.equal(writePublicationReceipt({ releaseDirectory: root, unit: "gauntlet", imageDigest: digest, chartDigest: digest }).files, 9);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(resolve(root, "units/gauntlet/publication-receipt.json"), "utf8"))).slice(-2), ["imageDigest", "chartDigest"]);
});

test("evidence and preflight are per unit and allow a mix of identical and clean units", async (t) => {
  const units = [{ id: "protocol", version: "0.1.0" }, { id: "skills", version: "0.1.0" }];
  const { root } = releaseFixture(t, units);
  const evidence = await collectReleaseEvidence({ releaseDirectory: root, sourceCommit: COMMIT });
  assert.deepEqual(evidence.units.map(({ id, tag, evidence: values }) => [id, tag, Object.keys(values)]), [
    ["protocol", "protocol-v0.1.0", ["npm:protocol", "github:protocol-v0.1.0"]],
    ["skills", "skills-v0.1.0", ["github:skills-v0.1.0"]],
  ]);
  const probe = async (check) => check.unit === "protocol"
    ? { id: check.id, state: "present", evidence: check.expectedEvidence }
    : { id: check.id, state: "absent" };
  const result = await checkReleasePublication(
    { releaseDirectory: root, sourceCommit: COMMIT, requireIdentical: false, unit: null },
    { collectEvidence: collectReleaseEvidence, probe },
  );
  assert.deepEqual(result.units.map(({ id, kind, state }) => [id, kind, state]), [
    ["protocol", "npm", "already-identical"], ["skills", "skills", "clean"],
  ]);
  const one = await checkReleasePublication(
    { releaseDirectory: root, sourceCommit: COMMIT, requireIdentical: false, unit: "skills" },
    { collectEvidence: collectReleaseEvidence, probe },
  );
  assert.deepEqual(one.units.map(({ id }) => id), ["skills"]);
});

test("the CLI accepts only per-unit preflight, verification and finalization shapes", () => {
  const directory = "/workspace/.artifacts/release/release-2026-10-03.1";
  assert.deepEqual(parsePublishedArguments(["--release-directory", directory, "--source-commit", COMMIT]),
    { command: "check", releaseDirectory: directory, sourceCommit: COMMIT, unit: null, requireIdentical: false });
  assert.deepEqual(parsePublishedArguments(["--release-directory", directory, "--source-commit", COMMIT, "--unit", "skills", "--require-draft-identical"]),
    { command: "verify-draft", releaseDirectory: directory, sourceCommit: COMMIT, unit: "skills" });
  assert.deepEqual(parsePublishedArguments(["--finalize", directory, "--unit", "skills"]),
    { command: "finalize", releaseDirectory: directory, unit: "skills", imageDigest: null, chartDigest: null });
  for (const argv of [
    ["--release-directory", directory, "--source-commit", COMMIT, "--require-draft-identical"],
    ["--release-directory", directory, "--version", "0.1.0", "--source-commit", COMMIT],
    ["--finalize", directory, "--unit", "gauntlet"],
    ["--finalize", directory, "--unit", "skills", "--image-digest", `sha256:${"a".repeat(64)}`, "--chart-digest", `sha256:${"a".repeat(64)}`],
    ["--release-directory", directory, "--source-commit", COMMIT, "--unit", "nope"],
  ]) assert.throws(() => parsePublishedArguments(argv), /Usage: check-published\.mjs/u);
});
```

`collectReleaseEvidence` on a fixture containing an npm unit hashes the staged tarball (`sha512-…`); on a Composer unit it materializes the archive into a temporary bare repository exactly as today; both run offline.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/release/test/check-published-units.test.mjs scripts/release/test/check-published.test.mjs`
Expected: FAIL (new exports missing, old fixed-catalog behaviour).

- [ ] **Step 3: Implement**

- Staged manifest: `readStagedManifest(releaseDirectory, commit)` reads `release-manifest.json`, rebuilds it with `createReleaseManifest` and requires canonical byte equality, `sourceCommit === commit`, `releaseSet === basename(releaseDirectory)` and identities equal to `expectedReleaseArtifacts(manifest.units)`; every artifact file is checked with `releaseArtifactPath` (hash).
- `unitReleaseManifest(manifest, unitId)` per Interfaces; `unitManifestBytes(manifest, unitId)` returns its canonical bytes.
- Catalog: a `RELEASE_ASSET_LIMITS` map from kind to maximum bytes (Interfaces), `GENERATED_ASSETS` with the three generated files, `githubReleaseAssetCatalog(unitId, version)` built from `expectedUnitArtifacts(unitId, version)` filtered to kinds in `RELEASE_ASSET_LIMITS`, named `path.split("/").at(-1)`, followed by `GENERATED_ASSETS`; `unitReleaseAssets(manifest, unitId)` builds the same list from the staged manifest with `path`; names must be unique.
- `publicationReceiptBytes(receipt)` and `parsePublicationReceipt(source, expected)` per Interfaces (`schemaVersion === 2`, exact keys for the unit kind, digests match `OCI_DIGEST` for `gauntlet`, canonical bytes).
- `finalizedUnitChecksums(unitManifest, manifestBytes, receiptBytes)` per Interfaces.
- `localUnitPublication(releaseDirectory, manifest, unitId)` reads `units/<unit>/publication-receipt.json` when it exists (absent → `undefined`) and parses it against the unit manifest's SHA-256.
- `publishedUnitReceipt(manifest, unitId)` (only when `GAUNTLET_USE_REMOTE_RECEIPT === "true"`): fetch `/repos/8lines/gauntlet/releases/tags/<tag>`; absent → `undefined`; otherwise require `tag_name === tag`, `draft === false`, `prerelease === false`, `immutable === true`, parse assets with `parseReleaseAssets(assets, unitId, version)`, download and parse `publication-receipt.json`.
- `collectReleaseEvidence({ releaseDirectory, sourceCommit })`: for each manifest unit, build `evidence` keyed by `createUnitCheckPlan` ids: npm `sha512-` integrity of the staged tarball; Maven the binary jar SHA-256 inside the materialized tree (today's code with the unit's version); Composer `composerTreeEvidence(source, unit.version, commit)`; `gauntlet` `image:semantic`/`image:commit` = OCI index digest (with today's `GAUNTLET_EXPECTED_IMAGE_DIGEST` and receipt cross-checks; treat an empty-string environment value as unset), `chart:semantic` = chart file SHA-256 (with today's `GAUNTLET_EXPECTED_CHART_DIGEST` cross-check, empty string = unset); `github:<tag>` = the GitHub evidence over `unitReleaseAssets` hashes where the generated assets come from the local finalized files when present (and must equal the computed ones), else the remote receipt, else the predicted receipt `{ schemaVersion: 2, releaseSet, unit, version, sourceCommit, manifestSha256 }` plus, for `gauntlet`, `imageDigest` = the OCI digest and `chartDigest` = `GAUNTLET_EXPECTED_CHART_DIGEST` or `sha256:<chart file sha256>` (today's fallback); the unit manifest bytes come from `unitManifestBytes`; `SHA256SUMS` from `finalizedUnitChecksums` (and must equal the local file when finalized).
- `evaluatePublishedArtifactsBeforeRelease` and `verifyPublishedArtifactsWithRetry` work on one unit's checks (unchanged logic; `evaluatePublishedState` calls become `evaluateUnitState`).
- `checkReleasePublication(options, dependencies)`: keys `releaseDirectory, sourceCommit, requireIdentical, unit`; collect evidence; select all units or the named one (unknown → `TypeError`); build `createUnitCheckPlan` per unit; without `requireIdentical` return `checkUnitDestinations({ plans, probe })` states; with it, run `verifyPublishedArtifactsWithRetry` per unit in plan order; map to `{ id, kind: unitById(id).kind, version, tag, state }`.
- `checkDraftReleasePublication({ releaseDirectory, sourceCommit, unit })`: requires the unit's finalized files, computes the local GitHub evidence for that unit, probes with `probeDraftRelease` and compares.
- `writePublicationReceipt({ releaseDirectory, unit, imageDigest, chartDigest })`: validate the staged manifest; the unit must be in it; digests are valid strings exactly for `gauntlet` (else both `null`); create `units/` and `units/<unit>/` with mode `0o700` (an existing non-directory or symlink fails closed); create `release-manifest.json` with `atomicCreate` or require identical bytes; create or require the identical receipt (today's logic); replace `SHA256SUMS` atomically with `finalizedUnitChecksums`; return `{ unit, files }`.
- Probes: `probeRemoteDestination` validates checks with keys `id, unit, kind, destination, expectedEvidence, version, tag` against `unitTemplates(unit, tag)` and `unitDestinationUrl` (image `:sha-<12 hex>` regex unchanged); `githubDraftByTag(tag, token)` and `probeGithubRelease(check, expectedDraft)` use `check.tag` for the release lookup, `parseReleaseAssets(assets, check.unit, check.version)`, `githubReleaseAssetCatalog(check.unit, check.version)` for downloads, `githubTagCommit("gauntlet", check.tag)` for the commit, and the per-unit evidence function.
- CLI per Interfaces.

- [ ] **Step 4: Run**

Run: `node --test scripts/release/test/check-published-units.test.mjs scripts/release/test/check-published.test.mjs && pnpm release:test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/release/check-published.mjs scripts/release/test/check-published.test.mjs scripts/release/test/check-published-units.test.mjs scripts/release/test/release-fixture.mjs
git commit -m "feat(release): verify and finalize publication evidence per release unit

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Plan-scoped verify and dry run

**Files:**
- Modify: `scripts/release/verify.mjs` (`PHASE_TIMEOUTS` 33-48, `phaseCommands` 63-142, `commandsForPhase` 155-159, `parseVerifyArguments` 161-164, `report` 174-188, `runOptions` 258-271, `runPhases` 273-355, `validateVersionOutput` 220-225 unchanged, CLI 450-516), `scripts/release/dry-run.mjs` (`parseDryRunArguments` 216-219, `optionsValues` 266-279, `freshRecords`/`dryReport` 298-326, `execute`/`executeRaw` 357-381, `validateDevelopmentReport` 429-449, `runDryRun` 860-1000, `runDryRunCli` 1002-1028)
- Test: `scripts/release/test/verify.test.mjs`, `scripts/release/test/dry-run.test.mjs`

**Interfaces:**
- Consumes: `resolveReleasePlan`, `parseReleaseSetId`, `localReleaseSetId` (Task 1); `unitById`; `expectedReleaseArtifacts` (Task 6).
- Produces:
  - `verify.mjs`: `phasesForUnits(ids: readonly string[]): string[]` (in `PHASES` order): always `source`, `inventory` and `documentation`; per unit gate `node`→`node`, `php`→`php`, `java`→`java`, `conformance`→`conformance`, `skills`→`skills`, `dashboard`→`dashboard`, `deployment`→`image`, `compose`, `helm`, `security`→`security`, `widget`/`widget-panel`→none; `packages` when any planned unit is npm. `parseVerifyArguments(argv) → { planPath: string | null }` (`[]` or `["--plan", PATH]`). `runPhases({ root, runner, plan })`: phases outside `phasesForUnits(plan.order)` get `{ name, status: "skipped", reason: "not-in-release-plan", commands: 0 }`; the report adds `units: plan.order`. `commandsForPhase(phase, { releaseSet, version })`: release-scope paths use `.artifacts/release/<releaseSet>` and the image file `gauntlet-<version>.docker.tar`. Timeouts raised: `helm`, `packages`, `documentation` to 60 minutes; others unchanged (`security` 90).
  - `dry-run.mjs`: `parseDryRunArguments(argv) → { planPath: string | null, releaseSet: string | null }` (`--plan PATH`, `--release-set release-YYYY-MM-DD.N|local-…`, each optional, any order); `runDryRun({ root, runner, workspace, archiveInspector, planPath, releaseSet, readPlan })` (`readPlan(root, planPath)` defaults to `resolveReleasePlan`); `DRY_RUN_PHASE_TIMEOUT_MS` exported: `source` 180, `php` 90, `java` 90, `packages` 60, `security` 90, `inventory` 30, `documentation` 60, `image` 60, `helm` 60 minutes. Children receive `--plan <path>` when the resolved plan came from a file (`resolveReleasePlan(...).path !== null`), and stage receives `--release-set`. Release-only work by plan: Composer consumer when a Composer unit is planned; Java release consumer when a Maven unit is planned; release security, documented commands and the local registry rehearsal when `gauntlet` is planned. Records for unneeded phases are `{ name, status: "skipped", reason: "not-in-release-plan" }`; `documentation` without `gauntlet` is `passed` after the development `docs:check`. `releaseReady` is true when every record is `passed` or `skipped`. The report has `releaseSet` and `units` (the plan units) and keeps `version` = the `gauntlet` manifest version.

- [ ] **Step 1: Write the failing tests**

In `verify.test.mjs`:

```js
import { createReleasePlan } from "../plan.mjs";
import { phasesForUnits, runPhases } from "../verify.mjs";

test("a plan selects only the phases its units need", () => {
  assert.deepEqual(phasesForUnits(["gauntlet", "skills"]), [
    "source", "node", "skills", "dashboard", "image", "compose", "helm", "security", "inventory", "documentation",
  ]);
  assert.deepEqual(phasesForUnits(["php-core"]), ["source", "php", "conformance", "inventory", "documentation"]);
  assert.deepEqual(phasesForUnits(["protocol"]), ["source", "node", "conformance", "packages", "inventory", "documentation"]);
});

test("unneeded phases are skipped and never invoked", async () => {
  const calls = [];
  const plan = createReleasePlan([{ id: "php-core", from: "0.1.8", to: "0.1.9" }]);
  const report = await runPhases({ root: "/workspace/gauntlet", plan, runner: async (invocation) => {
    calls.push(invocation.phase);
    return { status: 0, signal: null, stderr: "", stdout: invocation.args[0] === "scripts/release/version.mjs"
      ? `${JSON.stringify({ command: "check", mismatches: [], ok: true, tag: null, version: "0.1.8" })}\n` : "" };
  } });
  assert.deepEqual([...new Set(calls)], ["source", "php", "conformance", "documentation"]);
  assert.deepEqual(report.units, ["php-core"]);
  assert.deepEqual(report.phases.find(({ name }) => name === "dashboard"), { name: "dashboard", status: "skipped", reason: "not-in-release-plan", commands: 0 });
});
```

Update the existing `commandsForPhase` assertions to `{ releaseSet: "release-2026-10-03.1", version: "0.1.0" }` and paths under `.artifacts/release/release-2026-10-03.1`; existing `runPhases` tests pass `plan: allUnitsPlan(<13 units at 0.1.0>)` and expect `units`.

In `dry-run.test.mjs` (helpers from Task 6), add:

```js
import { createReleasePlan } from "../plan.mjs";

const PHP_PLAN = createReleasePlan([{ id: "php-core", from: "0.1.0", to: "0.1.1" }]);

test("a php-core plan runs only its release work and skips the application rehearsal", async () => {
  const calls = [];
  const runner = createSuccessfulRunner(calls, { override: (invocation) => {
    const [script] = invocation.args;
    if (invocation.command === process.execPath && script?.endsWith("/verify.mjs")) return commandResult(developmentReport(VERSION, { units: ["php-core"] }));
    if (invocation.command === process.execPath && script?.endsWith("/stage.mjs")) {
      return commandResult(jsonLine({
        artifacts: 1, outputDirectory: `${ROOT}/.artifacts/release/local-111111111111`, releaseSet: "local-111111111111",
        sourceCommit: COMMIT, units: [{ id: "php-core", version: "0.1.1" }],
      }));
    }
    if (invocation.command === process.execPath && script?.endsWith("/verify-inventory.mjs")) {
      return commandResult(inventoryReport({ units: [{ id: "php-core", version: "0.1.1", tag: "php-core-v0.1.1" }], artifacts: 1, nativeImage: null, multiPlatformOci: null, helmChart: null }));
    }
    return undefined;
  } });
  const report = await runDryRun({
    root: ROOT, runner, workspace: fakeWorkspace(), archiveInspector, planPath: ".release/plan.json",
    readPlan: () => ({ plan: PHP_PLAN, path: ".release/plan.json" }),
  });
  assert.equal(report.releaseReady, true);
  assert.deepEqual(report.units, [{ id: "php-core", from: "0.1.0", to: "0.1.1" }]);
  const commands = calls.map(({ command, args }) => `${command} ${args.join(" ")}`);
  assert.ok(commands.some((line) => line === "pnpm test:composer:consumer"));
  for (const absent of ["test:java:release", "security.mjs", "docs:verify-commands", "docker", "helm"]) {
    assert.ok(!commands.some((line) => line.includes(absent)), absent);
  }
  assert.ok(calls.find(({ args }) => args[0]?.endsWith("/stage.mjs")).args.includes("--plan"));
  assert.ok(calls.find(({ args }) => args[0]?.endsWith("/verify.mjs")).args.join(" ").endsWith("--plan .release/plan.json"));
  for (const name of ["java", "image", "helm", "security", "dashboard"]) {
    assert.equal(report.phases.find((phase) => phase.name === name).status, "skipped", name);
  }
});

test("every dry-run phase runs with its raised timeout", async () => {
  const calls = [];
  await runDryRun({ root: ROOT, runner: createSuccessfulRunner(calls), workspace: fakeWorkspace(), archiveInspector, readPlan: () => ({ plan: ALL_UNITS_PLAN, path: null }) });
  const timeouts = new Map(calls.map(({ phase, timeoutMs }) => [phase, timeoutMs]));
  assert.equal(timeouts.get("source"), 180 * 60_000);
  assert.equal(timeouts.get("packages"), 60 * 60_000);
  assert.equal(timeouts.get("documentation"), 60 * 60_000);
  assert.equal(timeouts.get("helm"), 60 * 60_000);
  assert.equal(timeouts.get("security"), 90 * 60_000);
});
```

`developmentReport(version, { units })` and `inventoryReport(overrides)` are the Task 6 helpers extended so `developmentReport` marks phases outside `phasesForUnits(units)` as skipped and includes `units`; `ALL_UNITS_PLAN = allUnitsPlan(new Map(RELEASE_UNITS.map(({ id }) => [id, VERSION])))`. The existing complete dry-run test passes `readPlan: () => ({ plan: ALL_UNITS_PLAN, path: null })` and still expects every command it expects today (no `--plan` argument since `path` is `null`). Extend the CLI test: `parseDryRunArguments(["--plan", ".release/plan.json", "--release-set", "release-2026-10-03.1"])` returns both values; duplicate flags, an invalid release set or an extra argument exit 2.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/release/test/verify.test.mjs scripts/release/test/dry-run.test.mjs`
Expected: FAIL (`phasesForUnits` missing; dry-run ignores plans).

- [ ] **Step 3: Implement**

`verify.mjs`:
- Import `unitById` and `resolveReleasePlan`. Add `GATE_PHASES` per Interfaces and `phasesForUnits`.
- `runOptions` accepts `plan` (a frozen plan object; default resolved by the CLI); `runPhases` computes `needed = new Set(phasesForUnits(plan.order))` and records skipped phases before running anything else.
- `parseVerifyArguments` and `runVerifyCli`: resolve the plan with `resolveReleasePlan(root, planPath)`; an empty plan is `INVALID_ARGUMENTS`-style failure `Release plan has no units`.
- `phaseCommands(releaseSet, version, root)` builds the release-scope commands under `.artifacts/release/<releaseSet>`; `commandsForPhase(phase, { releaseSet, version })` validates both (`parseReleaseSetId`, stable version).
- Raise timeouts per Interfaces.

`dry-run.mjs`:
- Export `DRY_RUN_PHASE_TIMEOUT_MS`; `execute` and `executeRaw` and `cleanupCommand` use `DRY_RUN_PHASE_TIMEOUT_MS[phase]`.
- `optionsValues` accepts `planPath`, `releaseSet`, `readPlan`.
- `runDryRun`: after the first source observation, `const { plan, path } = readPlan(root, planPath)`; empty plan fails `OUTPUT_INVALID` at `source`; `releaseSet = releaseSet ?? localReleaseSetId(sourceCommit)` validated with `parseReleaseSetId(value, sourceCommit)` for `local-` ids and `isReleaseTagName` otherwise; `const planArgs = path === null ? [] : ["--plan", path]`; verify invocation `[verify.mjs, ...planArgs]`; `validateDevelopmentReport(result, version, plan)` derives the expected statuses (today's map for needed phases, `skipped` otherwise) and checks `units`; skip the Composer consumer unless a Composer unit is planned (record `php` skipped when the development report skipped it, else passed); skip the Java consumer unless a Maven unit is planned; stage invocation `[stage.mjs, "--output", releaseRoot, ...planArgs, "--release-set", releaseSet]` and `validateStageOutput` compares `units` with the plan (`{ id, version: to }`); run release security, documented commands, the archive inspection and `rehearseRegistry` only when `gauntlet` is planned; otherwise set `security`, `image`, `helm` to skipped and `documentation` to passed; inventory always runs and its report `units` must equal the stage units.
- `dryReport` adds `releaseSet` and `units`; `releaseReady` per Interfaces; the final completeness check accepts `passed` or `skipped`.
- `runDryRunCli(argv, options)` passes the parsed `planPath` and `releaseSet` into `runDryRun`.

- [ ] **Step 4: Run**

Run: `pnpm release:test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/release/verify.mjs scripts/release/dry-run.mjs scripts/release/test/verify.test.mjs scripts/release/test/dry-run.test.mjs
git commit -m "feat(release): scope verification and the dry run to the release plan

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Release-set workflow queries

**Files:**
- Create: `scripts/release/release-set.mjs`
- Test: `scripts/release/test/release-set.test.mjs`

**Interfaces:**
- Consumes: `readReleaseManifest` (Task 6), `unitReleaseAssets` (Task 8), `unitById`, `unitTag`.
- Produces:
  - `planOutputs(result) → string`: from a `plan.mjs --check` JSON result with `ok: true`: `gates=<JSON array>\nunits=<JSON array>\n`.
  - `preflightOutputs(result) → string`: from a `check-published.mjs` check result: `clean=<JSON array of clean ids in plan order>\nclean_units=<space-separated>\ngauntlet=true|false\nnpm=<ids>\ncomposer=<ids>\nmaven=<ids>\n` (the last four only over clean units; every unit state must be `clean` or `already-identical`).
  - `unitTitle(unitId, version)`: `gauntlet` → `Gauntlet v<version>`; `skills` → `Gauntlet skills <version>`; others → `<published name> <version>`.
  - `unitField(manifest, unitId, field)` for `version`, `tag`, `title`.
  - `unitArtifactPath(releaseDirectory, manifest, unitId)`: absolute path of the single staged archive of an npm, Composer or Maven unit.
  - `unitAssetPaths(releaseDirectory, manifest, unitId)`: absolute paths of `unitReleaseAssets(manifest, unitId)` (finalized files must exist).
  - `changelogPath(unitId)`: `CHANGELOG.md` for `gauntlet`; `<directory of the unit's version source>/CHANGELOG.md` otherwise.
  - `changelogSection(source, version) → string | null`: the body under `## [<version>]` (heading line excluded, up to the next `## ` heading, trimmed).
  - `releaseNotes({ changelog, releaseSet }) → { mode: "changelog" | "generated", text }`: text is the section (if any) followed by a blank line and ``Release set `<releaseSet>`.`` and a trailing LF.
  - `requireUnitState(result, unitId, state)`: throws unless the result lists that unit with that state.
  - CLI `release-set.mjs <command>`: `outputs --plan-result FILE`; `preflight-outputs --state-file FILE`; `field --release-directory DIR --unit ID --field version|tag|title`; `artifact --release-directory DIR --unit ID`; `assets --release-directory DIR --unit ID` (one path per line); `notes --release-directory DIR --unit ID --output FILE` (writes notes, prints the mode); `require-state --state-file FILE --unit ID --state STATE`. Exit 2 for invalid arguments, 1 for failures.

- [ ] **Step 1: Write the failing tests** in `scripts/release/test/release-set.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

import {
  changelogPath, changelogSection, planOutputs, preflightOutputs, releaseNotes, requireUnitState, unitField, unitTitle,
} from "../release-set.mjs";

const MANIFEST = Object.freeze({
  schemaVersion: 2, releaseSet: "release-2026-10-03.1", sourceCommit: "1".repeat(40),
  units: [{ id: "protocol", version: "0.2.0", tag: "protocol-v0.2.0" }, { id: "gauntlet", version: "0.1.9", tag: "v0.1.9" }],
  artifacts: [],
});

test("plan outputs expose gates and units for job conditions", () => {
  assert.equal(planOutputs({ command: "check", ok: true, order: ["gauntlet", "skills"], gates: ["node", "skills"] }),
    'gates=["node","skills"]\nunits=["gauntlet","skills"]\n');
  assert.throws(() => planOutputs({ command: "check", ok: false, order: [], gates: [] }));
});

test("preflight outputs list only clean units per ecosystem", () => {
  const result = { command: "check", releaseSet: "release-2026-10-03.1", units: [
    { id: "protocol", kind: "npm", state: "already-identical" },
    { id: "typescript-core", kind: "npm", state: "clean" },
    { id: "php-core", kind: "composer", state: "clean" },
    { id: "gauntlet", kind: "application", state: "clean" },
    { id: "skills", kind: "skills", state: "clean" },
  ] };
  assert.equal(preflightOutputs(result), [
    'clean=["typescript-core","php-core","gauntlet","skills"]',
    "clean_units=typescript-core php-core gauntlet skills",
    "gauntlet=true",
    "npm=typescript-core",
    "composer=php-core",
    "maven=",
    "",
  ].join("\n"));
  assert.throws(() => preflightOutputs({ ...result, units: [{ id: "protocol", kind: "npm", state: "partial" }] }));
});

test("unit fields, titles and changelog locations", () => {
  assert.equal(unitField(MANIFEST, "protocol", "tag"), "protocol-v0.2.0");
  assert.equal(unitField(MANIFEST, "gauntlet", "title"), "Gauntlet v0.1.9");
  assert.equal(unitTitle("skills", "0.1.9"), "Gauntlet skills 0.1.9");
  assert.equal(unitTitle("php-core", "0.1.9"), "8lines/gauntlet-php-core 0.1.9");
  assert.throws(() => unitField(MANIFEST, "skills", "tag"));
  assert.equal(changelogPath("gauntlet"), "CHANGELOG.md");
  assert.equal(changelogPath("protocol"), "packages/protocol/CHANGELOG.md");
  assert.equal(changelogPath("java-core"), "packages/java/core/CHANGELOG.md");
  assert.equal(changelogPath("skills"), "skills/CHANGELOG.md");
});

test("notes use the unit changelog section when present and name the release set", () => {
  const source = "# Changelog\n\n## [0.1.9] - 2026-10-03\n\n### Fixed\n\n- A thing.\n\n## [0.1.8] - 2026-10-02\n\n- Old.\n";
  assert.equal(changelogSection(source, "0.1.9"), "### Fixed\n\n- A thing.");
  assert.equal(changelogSection(source, "0.1.10"), null);
  assert.deepEqual(releaseNotes({ changelog: "### Fixed\n\n- A thing.", releaseSet: "release-2026-10-03.1" }), {
    mode: "changelog", text: "### Fixed\n\n- A thing.\n\nRelease set `release-2026-10-03.1`.\n",
  });
  assert.deepEqual(releaseNotes({ changelog: null, releaseSet: "release-2026-10-03.1" }), {
    mode: "generated", text: "Release set `release-2026-10-03.1`.\n",
  });
});

test("the post-publication state must name the unit with the required state", () => {
  const result = { command: "check", units: [{ id: "skills", state: "already-identical" }] };
  assert.doesNotThrow(() => requireUnitState(result, "skills", "already-identical"));
  assert.throws(() => requireUnitState(result, "skills", "clean"));
  assert.throws(() => requireUnitState(result, "gauntlet", "already-identical"));
});
```

Also add a filesystem test that builds a finalized `skills`-only release directory with `releaseFixture` (Task 8 helper) and `writePublicationReceipt`, then asserts `runReleaseSetCli(["assets", "--release-directory", dir, "--unit", "skills"])` prints the four absolute asset paths in catalog order and `["artifact", …, "--unit", "skills"]` exits 1 (skills has no registry artifact).

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/release/test/release-set.test.mjs`
Expected: FAIL, `Cannot find module '../release-set.mjs'`.

- [ ] **Step 3: Implement `scripts/release/release-set.mjs`** with the exports above. Key code:

```js
import { readFileSync, writeFileSync, lstatSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { unitReleaseAssets } from "./check-published.mjs";
import { readReleaseManifest } from "./inventory.mjs";
import { unitById } from "./units.mjs";

const ROOT = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const STATES = new Set(["clean", "already-identical"]);

export function planOutputs(result) {
  if (result?.command !== "check" || result.ok !== true || !Array.isArray(result.order) || result.order.length === 0
      || !Array.isArray(result.gates)) throw new Error("Release plan check did not pass");
  return `gates=${JSON.stringify(result.gates)}\nunits=${JSON.stringify(result.order)}\n`;
}

export function preflightOutputs(result) {
  if (result?.command !== "check" || !Array.isArray(result.units) || result.units.length === 0
      || result.units.some(({ state }) => !STATES.has(state))) throw new Error("Release preflight state is not publishable");
  const clean = result.units.filter(({ state }) => state === "clean");
  const ofKind = (kind) => clean.filter((unit) => unit.kind === kind).map(({ id }) => id).join(" ");
  return [
    `clean=${JSON.stringify(clean.map(({ id }) => id))}`,
    `clean_units=${clean.map(({ id }) => id).join(" ")}`,
    `gauntlet=${clean.some(({ id }) => id === "gauntlet")}`,
    `npm=${ofKind("npm")}`,
    `composer=${ofKind("composer")}`,
    `maven=${ofKind("maven")}`,
    "",
  ].join("\n");
}

export function unitTitle(unitId, version) {
  const unit = unitById(unitId);
  if (unit.id === "gauntlet") return `Gauntlet v${version}`;
  if (unit.id === "skills") return `Gauntlet skills ${version}`;
  return `${unit.artifacts[0]} ${version}`;
}

function manifestUnit(manifest, unitId) {
  const unit = manifest.units.find(({ id }) => id === unitId);
  if (unit === undefined) throw new Error(`Release unit ${unitId} is not in this release set`);
  return unit;
}

export function unitField(manifest, unitId, field) {
  const unit = manifestUnit(manifest, unitId);
  if (field === "version") return unit.version;
  if (field === "tag") return unit.tag;
  if (field === "title") return unitTitle(unit.id, unit.version);
  throw new TypeError("Unknown release unit field");
}

export function changelogPath(unitId) {
  const unit = unitById(unitId);
  return unit.id === "gauntlet" ? "CHANGELOG.md" : `${dirname(unit.version.path)}/CHANGELOG.md`;
}

export function changelogSection(source, version) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line === `## [${version}]` || line.startsWith(`## [${version}] `));
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  const body = lines.slice(start + 1, end < 0 ? lines.length : end).join("\n").trim();
  return body === "" ? null : body;
}

export function releaseNotes({ changelog, releaseSet }) {
  const line = `Release set \`${releaseSet}\`.`;
  return changelog === null
    ? Object.freeze({ mode: "generated", text: `${line}\n` })
    : Object.freeze({ mode: "changelog", text: `${changelog}\n\n${line}\n` });
}

export function requireUnitState(result, unitId, state) {
  const unit = Array.isArray(result?.units) ? result.units.find(({ id }) => id === unitId) : undefined;
  if (unit?.state !== state) throw new Error(`Release unit ${unitId} is not ${state}`);
}
```

`unitArtifactPath` requires the unit kind to be `npm`, `composer` or `maven` and exactly one manifest artifact for it; `unitAssetPaths` maps `unitReleaseAssets` to absolute paths and requires each to be a regular file (`lstatSync`). The `notes` command reads `changelogPath` under the repository root when it is a regular file (else `null`), writes `releaseNotes(...).text` to `--output` (refusing an existing path) and prints the mode. `runReleaseSetCli(argv, { root = ROOT } = {})` parses exactly the shapes in Interfaces, reads release directories with `readReleaseManifest`, prints outputs without extra lines, and reports failures as one JSON line on stderr.

- [ ] **Step 4: Run**

Run: `node --test scripts/release/test/release-set.test.mjs && pnpm release:test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/release/release-set.mjs scripts/release/test/release-set.test.mjs
git commit -m "feat(release): add release-set queries for the publishing workflow

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Release-set workflow

**Files:**
- Modify: `.github/workflows/release.yml` (whole file), `.github/workflows/ci.yml` (security job 287-346), `scripts/release/security.mjs` (`parseSecurityArguments`, `validateStagedImageArchive`: drop the version-directory form), `docs/releases/releasing.md` (sections "Release units" lines 34-56, "Local rehearsal" 98-138, "Trigger" 140-176, "Failure handling" 192-210)
- Test: `scripts/release/test/publish-policy.test.mjs`, `scripts/release/test/workflow-policy.test.mjs`, `scripts/release/test/security.test.mjs`

**Interfaces:**
- Consumes: `plan.mjs --check` (Task 1), `stage.mjs --plan/--release-set` (Task 6), `release:dry-run --plan/--release-set` (Task 9), `check-published.mjs` per-unit CLI (Task 8), `publish-composer.mjs --unit` (Task 6), `release-set.mjs` (Task 10), `RELEASE_GATES` (Task 1).
- Produces: `release.yml` with `on.push.tags: ["release-*"]`; jobs `plan`, the ten gates, `release-metadata`, `publish`; job outputs `needs.plan.outputs.gates` and `needs.plan.outputs.units`; publish step outputs `steps.preflight.outputs.{clean,clean_units,gauntlet,npm,composer,maven}`.

- [ ] **Step 1: Write the failing policy tests.** In `publish-policy.test.mjs` replace `VERIFICATION_GATES` and the first two tests:

```js
import { RELEASE_GATES } from "../plan.mjs";

const GATE_JOBS = RELEASE_GATES;
const ALL_JOBS = ["plan", ...GATE_JOBS, "release-metadata", "publish"];

function publishCondition() {
  const clause = (gate) => `((contains(fromJSON(needs.plan.outputs.gates), '${gate}') && needs.${gate}.result == 'success')`
    + ` || (!contains(fromJSON(needs.plan.outputs.gates), '${gate}') && needs.${gate}.result == 'skipped'))`;
  return ["${{ !cancelled()", "needs.plan.result == 'success'", "needs.release-metadata.result == 'success'",
    ...GATE_JOBS.map(clause)].join(" && ") + " }}";
}

test("publication runs only for release-set tags with bounded permissions", () => {
  const { source, workflow } = releaseWorkflow();
  assert.equal(workflow.name, "release");
  assert.deepEqual(workflow.on, { push: { tags: ["release-*"] } });
  assert.doesNotMatch(source, /v\*\.\*\.\*/u);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.doesNotMatch(source, /pull_request|pull_request_target/u);
  assert.doesNotMatch(source, /:latest\b/u);
  assert.deepEqual(Object.keys(workflow.jobs).sort(), [...ALL_JOBS].sort());
  const publish = workflow.jobs.publish;
  assert.deepEqual([...publish.needs].sort(), ["plan", ...GATE_JOBS, "release-metadata"].sort());
  assert.equal(publish.if.replace(/\s+/gu, " ").trim(), publishCondition());
  assert.equal(publish.environment, "release");
  assert.deepEqual(publish.permissions, { contents: "write", packages: "write" });
  for (const gate of GATE_JOBS) {
    assert.equal(workflow.jobs[gate].needs, "plan", `${gate} needs plan`);
    assert.equal(workflow.jobs[gate].if, `contains(fromJSON(needs.plan.outputs.gates), '${gate}')`, `${gate} condition`);
  }
  assert.equal(workflow.jobs["release-metadata"].needs, "plan");
  assert.equal(workflow.jobs["release-metadata"].if, undefined);
  assert.deepEqual(workflow.jobs.plan.outputs, {
    gates: "${{ steps.plan.outputs.gates }}",
    units: "${{ steps.plan.outputs.units }}",
  });
  const planRun = workflow.jobs.plan.steps.find(({ id }) => id === "plan").run;
  for (const pattern of [
    /git merge-base --is-ancestor "\$GITHUB_SHA" origin\/main/u,
    /gh api "repos\/\$GITHUB_REPOSITORY\/git\/ref\/tags\/\$GITHUB_REF_NAME" --jq \.object\.type/u,
    /node scripts\/release\/plan\.mjs --check --release-set "\$GITHUB_REF_NAME" --commit "\$GITHUB_SHA"/u,
    /node scripts\/release\/release-set\.mjs outputs --plan-result/u,
  ]) assert.match(planRun, pattern);
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    if (jobName !== "publish") assert.equal(job.permissions?.["id-token"], undefined, `${jobName} OIDC token`);
    const skills = jobName === "skills";
    assert.equal(job["runs-on"], skills ? "${{ matrix.os }}" : LINUX_RUNNER, `${jobName} runner`);
    assert.equal(Number.isInteger(job["timeout-minutes"]) && job["timeout-minutes"] > 0 && job["timeout-minutes"] <= 90, true, `${jobName} timeout`);
    const checkouts = job.steps.filter(({ uses }) => typeof uses === "string" && /^[^@]+\/checkout@/u.test(uses));
    assert.equal(checkouts.length, 1, `${jobName} single checkout`);
    assert.match(checkouts[0].uses, skills ? /^actions\/checkout@[0-9a-f]{40}$/u : BLACKSMITH_CHECKOUT, `${jobName} checkout action`);
    assert.equal(checkouts[0].with?.["persist-credentials"], false, `${jobName} checkout credentials`);
    for (const step of job.steps) if (step.uses !== undefined) assert.match(step.uses, ACTION_SHA, `${jobName}: ${step.uses}`);
  }
  for (const jobName of ["java", "publish"]) {
    const java = workflow.jobs[jobName].steps.find(({ uses }) => uses?.startsWith("actions/setup-java@"));
    assert.notEqual(java, undefined, `${jobName} Java toolchain`);
  }
});

test("every gate job mirrors its CI job", () => {
  const ci = parseDocument(readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8"), { uniqueKeys: true })
    .toJS({ maxAliasCount: 0 });
  const { workflow } = releaseWorkflow();
  for (const gate of ["dashboard", "widget", "widget-panel", "skills"]) {
    const strip = ({ needs, if: condition, ...job }) => job;
    assert.deepEqual(strip(workflow.jobs[gate]), strip(ci.jobs[gate]), gate);
  }
});

test("publication is scoped to clean units and creates each unit's tag and release in order", () => {
  const { source, workflow } = releaseWorkflow();
  const steps = workflow.jobs.publish.steps;
  const names = steps.map(({ name }) => name);
  const ordered = [
    "Reproduce and verify staged release",
    "Check every remote destination",
    "Publish commit-tagged image with attestations",
    "Verify pushed image and attestations",
    "Publish staged npm packages",
    "Publish staged Maven packages",
    "Publish Composer split repositories",
    "Promote image digest to the semantic tag",
    "Publish Helm chart",
    "Verify every published artifact",
    "Tag and release each unit",
  ];
  assert.deepEqual(names.filter((name) => ordered.includes(name)), ordered);
  assert.equal(names.at(-1), "Tag and release each unit");
  const step = (name) => steps.find((candidate) => candidate.name === name);
  assert.match(step("Reproduce and verify staged release").run, /pnpm release:dry-run --plan \.release\/plan\.json --release-set "\$GITHUB_REF_NAME"/u);
  assert.equal(step("Check every remote destination").id, "preflight");
  assert.match(step("Check every remote destination").run, /release-set\.mjs preflight-outputs --state-file "\$RESULT" >> "\$GITHUB_OUTPUT"/u);
  for (const name of ["Publish commit-tagged image with attestations", "Verify pushed image and attestations", "Promote image digest to the semantic tag", "Publish Helm chart"]) {
    assert.equal(step(name).if, "steps.preflight.outputs.gauntlet == 'true'", name);
  }
  assert.equal(step("Publish staged npm packages").if, "steps.preflight.outputs.npm != ''");
  assert.equal(step("Publish staged Maven packages").if, "steps.preflight.outputs.maven != ''");
  assert.equal(step("Publish Composer split repositories").if, "steps.preflight.outputs.composer != ''");
  for (const name of ["Verify every published artifact", "Tag and release each unit"]) {
    assert.equal(step(name).if, "steps.preflight.outputs.clean != '[]'", name);
  }
  assert.match(step("Publish staged npm packages").run, /for UNIT in \$NPM_UNITS; do[\s\S]*release-set\.mjs artifact[\s\S]*npm publish "\$PACKAGE" --registry=https:\/\/registry\.npmjs\.org\/ --access public/u);
  assert.match(step("Publish staged Maven packages").run, /java-core\) TASKS\+=\(":core:publish"\)/u);
  assert.match(step("Publish staged Maven packages").run, /spring-boot-starter\) TASKS\+=\(":spring-boot-starter:publish"\)/u);
  assert.match(step("Publish Composer split repositories").run, /for UNIT in \$COMPOSER_UNITS; do[\s\S]*publish-composer\.mjs[\s\S]*--source-commit "\$GITHUB_SHA"[\s\S]*--unit "\$UNIT"/u);
  const loop = step("Tag and release each unit").run;
  const sequence = [
    /for UNIT in \$CLEAN_UNITS; do/u,
    /check-published\.mjs --finalize "\$RELEASE_DIRECTORY" --unit "\$UNIT"/u,
    /gh api "repos\/\$GITHUB_REPOSITORY\/git\/tags"/u,
    /gh api "repos\/\$GITHUB_REPOSITORY\/git\/refs"/u,
    /gh release create "\$TAG" --draft --verify-tag --title "\$TITLE" "\$LATEST"/u,
    /--unit "\$UNIT" --require-draft-identical/u,
    /gh release edit "\$TAG" --draft=false/u,
    /GAUNTLET_USE_REMOTE_RECEIPT=true[\s\S]*--unit "\$UNIT" --require-identical/u,
    /release-set\.mjs require-state --state-file "\$RUNNER_TEMP\/released-\$UNIT\.json" --unit "\$UNIT" --state already-identical/u,
  ];
  let cursor = 0;
  for (const pattern of sequence) {
    const match = pattern.exec(loop.slice(cursor));
    assert.notEqual(match, null, String(pattern));
    cursor += match.index + match[0].length;
  }
  assert.match(loop, /LATEST="--latest=false"/u);
  assert.match(loop, /if \[ "\$UNIT" = "gauntlet" \]; then[\s\S]*LATEST="--latest"/u);
  assert.equal((source.match(/--latest\b(?!=)/gu) ?? []).length, 1);
  assert.doesNotMatch(loop, /git push/u);
});
```

Keep and adapt the remaining tests: "a failed draft asset upload cannot reach the public release mutation" now checks inside the loop that `gh release create … --draft` precedes `--require-draft-identical` and `gh release edit … --draft=false`; "release security scans the staged image" expects `release:stage --output "$PWD/.artifacts/release/$GITHUB_REF_NAME" --plan .release/plan.json --release-set "$GITHUB_REF_NAME"` and `release:security --image-archive ".artifacts/release/$GITHUB_REF_NAME/image/gauntlet-$VERSION.docker.tar"`; the npm token test checks `env.NODE_AUTH_TOKEN` (the step may also have `NPM_UNITS`) and the trailing `npm publish` line; the Composer key test checks the two deploy keys in that step's env (plus `COMPOSER_UNITS`). In `workflow-policy.test.mjs`: the ci.yml security assertion expects `pnpm release:stage --output "$PWD/.artifacts/release/$SET" --release-set "$SET"` and `pnpm release:security --image-archive ".artifacts/release/$SET/image/gauntlet-$VERSION.docker.tar"`; `MULTI_PLATFORM_JOBS[".github/workflows/release.yml"]` stays `["security", "release-metadata", "publish"]`; the install-coverage test now counts every release job including `plan`. In `security.test.mjs`, the version-directory form `.artifacts/release/0.1.0/image/gauntlet-0.1.0.docker.tar` is rejected and the set-id form accepted.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/release/test/publish-policy.test.mjs scripts/release/test/workflow-policy.test.mjs`
Expected: FAIL (trigger `v*.*.*`, no `plan` job).

- [ ] **Step 3: Rewrite `.github/workflows/release.yml`**

- `on: push: tags: ["release-*"]`; keep `permissions`, `concurrency`.
- Add the `plan` job first:

```yaml
  plan:
    runs-on: blacksmith-4vcpu-ubuntu-2404
    timeout-minutes: 15
    outputs:
      gates: ${{ steps.plan.outputs.gates }}
      units: ${{ steps.plan.outputs.units }}
    steps:
      - uses: useblacksmith/checkout@25227e61ff9dafe400e22fa487b673eac4e4409a # v1.8.1
        with:
          persist-credentials: false
          fetch-depth: 0
      - uses: pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v6.0.10
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7
        with:
          node-version: "24.20.0"
          cache: pnpm
      - run: pnpm install --frozen-lockfile --package-import-method=copy
      - name: Verify the release-set tag and plan
        id: plan
        shell: bash
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          set -euo pipefail
          test "$(git rev-parse HEAD)" = "$GITHUB_SHA"
          test "$(gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/$GITHUB_REF_NAME" --jq .object.type)" = "tag"
          git merge-base --is-ancestor "$GITHUB_SHA" origin/main
          test -z "$(git status --porcelain=v1 --untracked-files=all)"
          node scripts/release/version.mjs --check
          RESULT="$RUNNER_TEMP/gauntlet-release-plan.json"
          node scripts/release/plan.mjs --check --release-set "$GITHUB_REF_NAME" --commit "$GITHUB_SHA" > "$RESULT"
          node scripts/release/release-set.mjs outputs --plan-result "$RESULT" >> "$GITHUB_OUTPUT"
```

- Gate jobs `node`, `php`, `java`, `conformance`, `deployment`, `security` keep today's bodies and gain `needs: plan` and `if: contains(fromJSON(needs.plan.outputs.gates), '<gate>')`. Add `dashboard`, `widget`, `widget-panel` and `skills` by copying their ci.yml jobs verbatim (ci.yml lines 117-205 and 248-285, including the skills macOS matrix and `actions/checkout`), each with the same `needs`/`if`.
- `security` job staging step:

```yaml
      - name: Stage the exact security input
        shell: bash
        run: |
          set -euo pipefail
          pnpm release:stage --output "$PWD/.artifacts/release/$GITHUB_REF_NAME" --plan .release/plan.json --release-set "$GITHUB_REF_NAME"
      - name: Run the full release security gate
        shell: bash
        run: |
          set -euo pipefail
          VERSION="$(tr -d '\n' < VERSION)"
          pnpm release:security --image-archive ".artifacts/release/$GITHUB_REF_NAME/image/gauntlet-$VERSION.docker.tar"
```

- `release-metadata`: `needs: plan`; its verify step drops `test "$GITHUB_REF_NAME" = "v$VERSION"` and `--tag`, runs `node scripts/release/version.mjs --check` and `node scripts/release/plan.mjs --check --release-set "$GITHUB_REF_NAME" --commit "$GITHUB_SHA"`; the dry run is `pnpm release:dry-run --plan .release/plan.json --release-set "$GITHUB_REF_NAME"` with `PLAYWRIGHT_BROWSER_CHANNEL: chromium`.
- `publish`: `needs: [plan, node, php, java, conformance, dashboard, widget, widget-panel, deployment, skills, security, release-metadata]` and `if: >-` followed by exactly the expression `publishCondition()` builds (write it out, one clause per line). Setup steps unchanged through "Build release package inputs". Then:

```yaml
      - name: Reproduce and verify staged release
        shell: bash
        env:
          PLAYWRIGHT_BROWSER_CHANNEL: chromium
        run: |
          set -euo pipefail
          test "$(git rev-parse HEAD)" = "$GITHUB_SHA"
          git merge-base --is-ancestor "$GITHUB_SHA" origin/main
          test -z "$(git status --porcelain=v1 --untracked-files=all)"
          node scripts/release/version.mjs --check
          node scripts/release/plan.mjs --check --release-set "$GITHUB_REF_NAME" --commit "$GITHUB_SHA"
          pnpm release:dry-run --plan .release/plan.json --release-set "$GITHUB_REF_NAME"
      - name: Authenticate GitHub container registry pushes
        # unchanged
      - name: Check every remote destination
        id: preflight
        shell: bash
        env:
          GH_TOKEN: ${{ github.token }}
          GAUNTLET_USE_REMOTE_RECEIPT: "true"
        run: |
          set -euo pipefail
          RESULT="$RUNNER_TEMP/gauntlet-published-state.json"
          node scripts/release/check-published.mjs \
            --release-directory "$PWD/.artifacts/release/$GITHUB_REF_NAME" \
            --source-commit "$GITHUB_SHA" > "$RESULT"
          node scripts/release/release-set.mjs preflight-outputs --state-file "$RESULT" >> "$GITHUB_OUTPUT"
```

  The image steps keep their bodies (skopeo with `--preserve-digests` and `--digestfile`, trivy for both platforms, `id: image-copy`, `id: image`) with `if: steps.preflight.outputs.gauntlet == 'true'`, `RELEASE_DIRECTORY="$PWD/.artifacts/release/$GITHUB_REF_NAME"` and `VERSION="$(node scripts/release/release-set.mjs field --release-directory "$RELEASE_DIRECTORY" --unit gauntlet --field version)"`. Then, in this order:

```yaml
      - name: Publish staged npm packages
        if: steps.preflight.outputs.npm != ''
        shell: bash
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
          NPM_UNITS: ${{ steps.preflight.outputs.npm }}
        run: |
          set -euo pipefail
          RELEASE_DIRECTORY="$PWD/.artifacts/release/$GITHUB_REF_NAME"
          for UNIT in $NPM_UNITS; do
            PACKAGE="$(node scripts/release/release-set.mjs artifact --release-directory "$RELEASE_DIRECTORY" --unit "$UNIT")"
            npm publish "$PACKAGE" --registry=https://registry.npmjs.org/ --access public
          done
      - name: Publish staged Maven packages
        if: steps.preflight.outputs.maven != ''
        shell: bash
        env:
          ORG_GRADLE_PROJECT_gauntletRemotePublishing: "true"
          ORG_GRADLE_PROJECT_gauntletRemoteUsername: ${{ github.actor }}
          ORG_GRADLE_PROJECT_gauntletRemotePassword: ${{ github.token }}
          MAVEN_UNITS: ${{ steps.preflight.outputs.maven }}
        run: |
          set -euo pipefail
          TASKS=()
          for UNIT in $MAVEN_UNITS; do
            case "$UNIT" in
              java-core) TASKS+=(":core:publish") ;;
              spring-boot-starter) TASKS+=(":spring-boot-starter:publish") ;;
              *) exit 1 ;;
            esac
          done
          packages/java/gradlew --no-daemon --no-configuration-cache --console=plain \
            -p packages/java "${TASKS[@]}"
      - name: Publish Composer split repositories
        if: steps.preflight.outputs.composer != ''
        shell: bash
        env:
          COMPOSER_SPLIT_CORE_DEPLOY_KEY: ${{ secrets.COMPOSER_SPLIT_CORE_DEPLOY_KEY }}
          COMPOSER_SPLIT_BUNDLE_DEPLOY_KEY: ${{ secrets.COMPOSER_SPLIT_BUNDLE_DEPLOY_KEY }}
          COMPOSER_UNITS: ${{ steps.preflight.outputs.composer }}
        run: |
          set -euo pipefail
          for UNIT in $COMPOSER_UNITS; do
            node scripts/release/publish-composer.mjs \
              --release-directory "$PWD/.artifacts/release/$GITHUB_REF_NAME" \
              --source-commit "$GITHUB_SHA" \
              --unit "$UNIT"
          done
```

  Then "Promote image digest to the semantic tag" and "Publish Helm chart" (`id: chart`) with their current bodies, `if: steps.preflight.outputs.gauntlet == 'true'`, the gauntlet version from `release-set.mjs field` and the chart path `.artifacts/release/$GITHUB_REF_NAME/helm/gauntlet-$VERSION.tgz`. Then:

```yaml
      - name: Verify every published artifact
        if: steps.preflight.outputs.clean != '[]'
        shell: bash
        env:
          GH_TOKEN: ${{ github.token }}
          GAUNTLET_EXPECTED_IMAGE_DIGEST: ${{ steps.image.outputs.digest }}
        run: |
          set -euo pipefail
          node scripts/release/check-published.mjs \
            --release-directory "$PWD/.artifacts/release/$GITHUB_REF_NAME" \
            --source-commit "$GITHUB_SHA" \
            --require-identical
      - name: Tag and release each unit
        if: steps.preflight.outputs.clean != '[]'
        shell: bash
        env:
          GH_TOKEN: ${{ github.token }}
          CLEAN_UNITS: ${{ steps.preflight.outputs.clean_units }}
          IMAGE_DIGEST: ${{ steps.image.outputs.digest }}
          CHART_DIGEST: ${{ steps.chart.outputs.digest }}
        run: |
          set -euo pipefail
          RELEASE_DIRECTORY="$PWD/.artifacts/release/$GITHUB_REF_NAME"
          for UNIT in $CLEAN_UNITS; do
            TAG="$(node scripts/release/release-set.mjs field --release-directory "$RELEASE_DIRECTORY" --unit "$UNIT" --field tag)"
            TITLE="$(node scripts/release/release-set.mjs field --release-directory "$RELEASE_DIRECTORY" --unit "$UNIT" --field title)"
            LATEST="--latest=false"
            if [ "$UNIT" = "gauntlet" ]; then
              node scripts/release/check-published.mjs --finalize "$RELEASE_DIRECTORY" --unit "$UNIT" \
                --image-digest "$IMAGE_DIGEST" --chart-digest "$CHART_DIGEST"
              LATEST="--latest"
            else
              node scripts/release/check-published.mjs --finalize "$RELEASE_DIRECTORY" --unit "$UNIT"
            fi
            if git rev-parse -q --verify "refs/tags/$TAG" > /dev/null; then
              test "$(git rev-parse "refs/tags/$TAG^{commit}")" = "$GITHUB_SHA"
            else
              TAG_OBJECT="$(gh api "repos/$GITHUB_REPOSITORY/git/tags" -f tag="$TAG" -f message="$TITLE" -f object="$GITHUB_SHA" -f type=commit --jq .sha)"
              gh api "repos/$GITHUB_REPOSITORY/git/refs" -f ref="refs/tags/$TAG" -f sha="$TAG_OBJECT" > /dev/null
            fi
            NOTES="$RUNNER_TEMP/release-notes-$UNIT.md"
            NOTES_MODE="$(node scripts/release/release-set.mjs notes --release-directory "$RELEASE_DIRECTORY" --unit "$UNIT" --output "$NOTES")"
            NOTES_ARGS=(--notes-file "$NOTES")
            if [ "$NOTES_MODE" = "generated" ]; then NOTES_ARGS+=(--generate-notes); fi
            node scripts/release/release-set.mjs assets --release-directory "$RELEASE_DIRECTORY" --unit "$UNIT" > "$RUNNER_TEMP/assets-$UNIT.txt"
            mapfile -t ASSETS < "$RUNNER_TEMP/assets-$UNIT.txt"
            test "${#ASSETS[@]}" -ge 4
            gh release create "$TAG" --draft --verify-tag --title "$TITLE" "$LATEST" "${NOTES_ARGS[@]}" "${ASSETS[@]}"
            node scripts/release/check-published.mjs --release-directory "$RELEASE_DIRECTORY" \
              --source-commit "$GITHUB_SHA" --unit "$UNIT" --require-draft-identical
            gh release edit "$TAG" --draft=false
            GAUNTLET_EXPECTED_IMAGE_DIGEST="$IMAGE_DIGEST" GAUNTLET_EXPECTED_CHART_DIGEST="$CHART_DIGEST" GAUNTLET_USE_REMOTE_RECEIPT=true \
              node scripts/release/check-published.mjs --release-directory "$RELEASE_DIRECTORY" \
              --source-commit "$GITHUB_SHA" --unit "$UNIT" --require-identical > "$RUNNER_TEMP/released-$UNIT.json"
            node scripts/release/release-set.mjs require-state --state-file "$RUNNER_TEMP/released-$UNIT.json" --unit "$UNIT" --state already-identical
          done
```

  Order rationale (comment it in the workflow): the commit-tagged image push and its trivy scan run first because they are not public releases; public destinations then follow dependency order (npm, Maven, Composer, then the semantic image tag and chart that depend on `protocol`/`dashboard-client`), and units are tagged and released in plan order. Tags created through the API with `GITHUB_TOKEN` do not start workflows.
- `ci.yml` security job:

```yaml
      - name: Stage and scan the exact release image
        shell: bash
        run: |
          set -euo pipefail
          SET="local-$(git rev-parse HEAD | cut -c1-12)"
          VERSION="$(tr -d '\n' < VERSION)"
          pnpm release:stage --output "$PWD/.artifacts/release/$SET" --release-set "$SET"
          pnpm release:security --image-archive ".artifacts/release/$SET/image/gauntlet-$VERSION.docker.tar"
```

- `security.mjs`: accept only `.artifacts/release/<set-id>/image/gauntlet-<gauntlet version>.docker.tar`.
- `docs/releases/releasing.md`: in "Release units", replace "Unit tags such as `protocol-v0.1.8` do not match the release trigger `v*.*.*`, so pushing them does not start a release." with "Only `release-*` tags start the release workflow; unit tags never do."; in "Local rehearsal", show `pnpm release:dry-run [--plan .release/plan.json]`, the root `.artifacts/release/local-<first 12 characters of HEAD>`, and the matching `verify-inventory` command; rewrite "Trigger" as: `pnpm release:plan` writes `.release/plan.json` (commit it with the version changes), after merge `git fetch --tags origin && pnpm release:tag` creates `release-YYYY-MM-DD.N` on the merge commit, `git push origin refs/tags/release-YYYY-MM-DD.N` starts one run; the run checks the plan, runs only the planned units' gates, preflights each unit (clean or already identical; a partially published unit fails), publishes in dependency order, then creates each unit's tag and GitHub Release (draft, byte verification, publish, immutable verification), with only the application release marked Latest; each release carries its unit's assets, `release-manifest.json`, `publication-receipt.json` and `SHA256SUMS`; in "Failure handling", the discard command uses `--release-root .artifacts/release/<set-id>` and the text says the helper verifies the closed per-plan inventory instead of "19-artifact". Run `pnpm docs:check` and fix what it reports.

- [ ] **Step 4: Run**

Run: `pnpm release:test && pnpm docs:check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/release.yml .github/workflows/ci.yml scripts/release/security.mjs scripts/release/test docs/releases/releasing.md
git commit -m "feat(release): publish release sets from release-* tags with per-unit tags and releases

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: End lockstep releases

**Files:**
- Modify: `skills/gauntlet-app-integration/SKILL.md` (line 20), `scripts/release/release-model.mjs` (`RELEASE_TEXT_FILES` SKILL.md entry ~477-480, `RELEASE_STAGE_ARTIFACT_COUNT` 164, `javaLockstepVersion` 611-621, `LOCKSTEP_RELEASES` 627-628, `collectVersionMismatches` 726-743, `setReleaseVersion` precondition), `scripts/release/version.mjs`, `scripts/release/verify.mjs` (`validateVersionOutput` 220-225), `scripts/release/dry-run.mjs` (`parseVersionOutput` 384-389), `scripts/docs/check-docs.mjs` (`loadUnitVersions` 246-262), `skill-evals/gauntlet-app-integration/EVALUATING.md`, `skill-evals/gauntlet-extension-authoring/EVALUATING.md`, `docs/releases/releasing.md` ("Release units" paragraph lines 34-36)
- Test: `scripts/release/test/release-model.test.mjs`, `scripts/release/test/units.test.mjs` (line ~69), `scripts/release/test/verify.test.mjs`, `scripts/release/test/dry-run.test.mjs`, `scripts/docs/test/check-docs.test.mjs` (fixtures near lines 81, 131, 188, 214), any test grepped below
- Re-bind: skill-evaluation receipts (skill text, `EVALUATING.md` and `release-model.mjs` changed)

**Interfaces:**
- Consumes: `readReleasePlan`, `validatePlanAgainstManifests` (Task 1).
- Produces:
  - `LOCKSTEP_RELEASES = false`; `collectVersionMismatches(root)` equals `collectUnitVersionMismatches(root)` (no tag parameter, no lockstep guard). `javaLockstepVersion` and `RELEASE_STAGE_ARTIFACT_COUNT` are no longer exported.
  - `setReleaseVersion(root, version)` moves every unit from its own current version (diverged repositories are accepted).
  - `version.mjs --check [--plan PATH]` (no `--tag`): stdout `{ command: "check", mismatches, ok, plan: <path or null>, units, version }`; with `--plan`, plan problems are appended as `plan: <problem>`. `USAGE = "Usage: version.mjs --check [--plan PATH] | --set X.Y.Z | --set-unit UNIT X.Y.Z"`.
  - The skill text slot catalog no longer contains a `skills`-unit slot in `SKILL.md`.

- [ ] **Step 1: Reword the skill instruction and drop its slot.** Replace in `skills/gauntlet-app-integration/SKILL.md` line 20 the sentence fragment "Consume exact `0.1.8` artifacts; never copy package source from this monorepo into the target application." with "Consume the exact released version each reference names for its package, image, or chart; never copy package source from this monorepo into the target application." Remove the `skills/gauntlet-app-integration/SKILL.md` entry from `RELEASE_TEXT_FILES`. Update `release-model.test.mjs`: `RELEASE_TEXT_PATHS`, `RELEASE_TEXT_UNITS`, `EXPECTED_UPDATE_PATHS` and `releaseTextFixtures` no longer list SKILL.md; "a unit that moves alone…" now expects only `docs/ai-skills.md` for `skills`; Task 3's skills `changedPaths` expectation becomes `["docs/ai-skills.md", "skills/VERSION"]`. Run `grep -rn "Consume exact" scripts skill-evals skills docs` and update any test or fixture that quotes the old sentence (do not edit recorded prompts or responses under `skill-evals/*/results` or `prompts`).

- [ ] **Step 2: Fix the evaluation wording.** In both `skill-evals/*/EVALUATING.md`, replace the paragraph "The release unit model (2026-10-03) changed bound inputs without changing prompts, scenarios, scorecards or verifiers; hashes were re-bound to current bytes without generating new model samples. This confirms content integrity, not behaviour." with:

"The release unit model (2026-10-03) changed bound inputs without changing prompts, scenarios or scorecards. The verifier text changed only because it embeds the fixture contracts, whose versions are now read from each unit's manifest. Hashes were re-bound to current bytes without generating new model samples. This confirms content integrity, not behaviour.

Plan-driven publishing (2026-10-03) changed bound release tooling and the skill's version wording (each reference now names its own exact version) without changing prompts, scenarios, scorecards or verifiers. Hashes were re-bound to current bytes without generating new model samples. This confirms content integrity, not behaviour."

In `skill-evals/gauntlet-app-integration/EVALUATING.md`, delete the sentence "The standard fixture preparers and verifier self-tests exercise the current 0.1.8 candidate packages." and replace "Passing self-tests do not establish that the recorded model samples ran on 0.1.8." with "Passing self-tests do not establish that the recorded model samples ran on the current package versions."

- [ ] **Step 3: Write the failing lockstep tests** in `release-model.test.mjs` (replace "the lockstep guard rejects diverged units until plan-driven publishing", "setReleaseVersion refuses a repository whose units have diverged" and the `javaLockstepVersion` test; remove the `RELEASE_STAGE_ARTIFACT_COUNT` assertion near line 354):

```js
test("diverged units are consistent once lockstep releases end", () => {
  assert.equal(LOCKSTEP_RELEASES, false);
  const root = createVersionFixture("0.1.8");
  try {
    setUnitVersions(root, { skills: "0.1.9", "php-core": "0.2.0" });
    assert.deepEqual(collectVersionMismatches(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setReleaseVersion moves every unit from its own version", () => {
  const root = createVersionFixture("0.1.8");
  try {
    setUnitVersions(root, { "java-core": "0.1.9" });
    setReleaseVersion(root, "0.1.10");
    assert.deepEqual(collectVersionMismatches(root), []);
    for (const id of ["gauntlet", "java-core", "spring-boot-starter", "skills"]) assert.equal(readUnitVersion(root, id), "0.1.10", id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the version check validates a plan instead of a tag", () => {
  const root = createVersionFixture("0.1.8");
  try {
    setUnitVersions(root, { widget: "0.1.9" });
    mkdirSync(join(root, ".release"));
    writeFileSync(join(root, ".release/plan.json"), serializeReleasePlan(createReleasePlan([{ id: "widget", from: "0.1.8", to: "0.1.9" }])));
    const ok = JSON.parse(runVersionCli(["--check", "--plan", ".release/plan.json"], { root }).stdout);
    assert.deepEqual([ok.ok, ok.plan, ok.mismatches], [true, ".release/plan.json", []]);
    writeFileSync(join(root, ".release/plan.json"), serializeReleasePlan(createReleasePlan([{ id: "widget", from: "0.1.8", to: "0.2.0" }])));
    const drifted = runVersionCli(["--check", "--plan", ".release/plan.json"], { root });
    assert.equal(drifted.exitCode, 1);
    assert.deepEqual(JSON.parse(drifted.stdout).mismatches, ["plan: widget: plan version 0.2.0 does not equal manifest version 0.1.9"]);
    assert.equal(runVersionCli(["--check", "--tag", "v0.1.8"], { root }).exitCode, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

(import `createReleasePlan`, `serializeReleasePlan` from `../plan.mjs`; `mkdirSync`, `writeFileSync` from `node:fs`.) In `units.test.mjs`, replace "every unit reads the lockstep release version from the repository" with "every unit reads a stable version from the repository" (13 entries, each matching `/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/`). In `verify.test.mjs` and `dry-run.test.mjs`, the fake version report becomes `{ command: "check", mismatches: [], ok: true, plan: null, units: [], version }`.

- [ ] **Step 4: Run to verify it fails**

Run: `node --test scripts/release/test/release-model.test.mjs scripts/release/test/units.test.mjs`
Expected: FAIL (`LOCKSTEP_RELEASES` is `true`; `--plan` is unknown).

- [ ] **Step 5: Implement**
- `release-model.mjs`: `export const LOCKSTEP_RELEASES = false;` with the comment "Units are versioned and released independently; plan-driven publishing replaced the lockstep guard."; `collectVersionMismatches(root)` returns `collectUnitVersionMismatches(root)`; delete `javaLockstepVersion` and `RELEASE_STAGE_ARTIFACT_COUNT` (first `grep -rn "javaLockstepVersion\|RELEASE_STAGE_ARTIFACT_COUNT" scripts skill-evals deploy` must show no remaining users); `setReleaseVersion`'s precondition stays `collectVersionMismatches(root).length === 0`.
- `version.mjs`: `parseVersionCommand` accepts `["--check"]`, `["--check", "--plan", PATH]` (PATH a non-empty string), `--set`, `--set-unit`; for `--plan`, `readReleasePlan(root, path)` and `validatePlanAgainstManifests(plan, readUnitVersions(root))` problems are appended as `plan: <problem>` (an unreadable plan is the mismatch `plan: Release plan is missing or unsafe`); output per Interfaces.
- `verify.mjs` `validateVersionOutput` and `dry-run.mjs` `parseVersionOutput`: require `value.plan === null` instead of `value.tag === null`.
- `check-docs.mjs` `loadUnitVersions`: delete the lockstep fallback (`if (versions.size === 1 && versions.has("gauntlet")) …`) and its comment; unreadable units are simply not compared. In `check-docs.test.mjs`, move `UNIT_VERSION_FILES` above the first fixture and spread it into the fixtures near lines 81, 131 and 188 (instead of a lone `VERSION`) so their unit versions are explicit.
- `docs/releases/releasing.md` "Release units": replace the paragraph "Until plan-driven publishing lands, the release workflow still publishes one lockstep release, so every unit version must equal the root `VERSION`. The lockstep guard (`pnpm release:version --check`) fails otherwise." with "Units are versioned and released independently. `pnpm release:version --check` validates every slot against its own unit, and `--plan .release/plan.json` also checks the plan against the manifests. `node scripts/release/version.mjs --set-unit <unit> X.Y.Z` moves one unit and every slot bound to it."

- [ ] **Step 6: Re-bind the skill-evaluation receipts** (SKILL.md, both `EVALUATING.md` files and `release-model.mjs` changed; do this after every other edit in this task). Same procedure as commit `e0d2138`: regenerate `external-inputs.json` for both evaluations with `generateExternalInputsManifest` from the paths already listed; replace the old `externalInputsSha256`, `evaluationSha256` (`hashEvaluationInputs(<abs eval dir>)` from `scripts/skills/evaluation-content.mjs`) and, for `gauntlet-app-integration`, `skillSha256` (`await hashSkill(<abs skills/gauntlet-app-integration>)` from `scripts/skills/skill-content.mjs`) in `verification.json` and every `results/*.jsonl` line (literal replacement of the old hash strings; baseline lines whose `skillSha256` is `null` stay `null`); recompute each phase's `transcriptSha256`. Only hash fields change.

- [ ] **Step 7: Run the full verification**

Run: `pnpm release:test && node --test scripts/docs/test/*.test.mjs && node scripts/docs/check-docs.mjs && node scripts/release/version.mjs --check && pnpm skills:validate && pnpm skills:test-install && pnpm skills:test-evals && pnpm test:helm && pnpm check`
Expected: PASS; `version.mjs --check` prints `"ok":true,"plan":null` and 13 unit lines.

- [ ] **Step 8: Manual verification: dashboard-only plan rehearsal** (needs Docker; nothing is committed to the branch or pushed):

```bash
REHEARSAL="$(mktemp -d /tmp/gauntlet-dashboard-plan.XXXXXX)"
git worktree add --detach "$REHEARSAL" HEAD
cd "$REHEARSAL"
pnpm install --frozen-lockfile --package-import-method=copy
node scripts/release/version.mjs --set-unit gauntlet 0.1.9
node scripts/release/version.mjs --set-unit skills 0.1.9
pnpm release:plan
```

Expected plan: `{"command":"write","path":".release/plan.json","units":[{"id":"gauntlet","from":"0.1.8","to":"0.1.9"},{"id":"skills","from":"0.1.8","to":"0.1.9"}],"order":["gauntlet","skills"],"gates":["node","dashboard","widget","widget-panel","deployment","skills","security"]}`. Then in the worktree only: run `node scripts/docs/check-docs.mjs` and fix every reported application-version pin in docs (this is what phase 3's `release:prepare` automates), re-bind the skill receipts exactly as in Step 6 (root `VERSION` and `package.json`-adjacent inputs changed), run `pnpm skills:validate`, `node scripts/release/plan.mjs --check` (expected `"ok":true`), `pnpm build`, then `git add -A && git commit -m "rehearsal: dashboard-only plan"` (detached worktree commit, never pushed), and:

```bash
PLAYWRIGHT_BROWSER_CHANNEL=chromium pnpm release:dry-run --plan .release/plan.json
```

Expected: one JSON line with `"ok":true,"releaseReady":true`, `"units":[{"id":"gauntlet",…},{"id":"skills",…}]`, `php`, `java` and `conformance` records `skipped`, inventory `artifacts` 8, and a local registry rehearsal for image `0.1.9` and chart `0.1.9`. Record in the task report: the dry-run summary, the duration of each phase if visible, every file the docs check and re-binding touched in the worktree, and any phase that came within 15 minutes of its timeout. Clean up: `cd - && git worktree remove --force "$REHEARSAL"`. If Docker is unavailable, state that the manual rehearsal was not run.

- [ ] **Step 9: Commit**

```bash
git add skills/gauntlet-app-integration/SKILL.md scripts/release scripts/docs skill-evals/gauntlet-app-integration skill-evals/gauntlet-extension-authoring docs/releases/releasing.md
git commit -m "feat(release): end lockstep releases and check versions per unit

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
