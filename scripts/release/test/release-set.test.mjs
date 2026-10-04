import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { writePublicationReceipt } from "../check-published.mjs";
import { createReleasePlan, serializeReleasePlan } from "../plan.mjs";
import {
  changelogPath, changelogSection, planOutputs, preflightOutputs, releaseNotes, requireUnitState, runReleaseSetCli, unitField,
  unitTitle,
} from "../release-set.mjs";
import { releaseFixture, SET } from "./release-fixture.mjs";

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
    "skills=true",
    "npm=typescript-core",
    "composer=php-core",
    "maven=",
    "packages=typescript-core php-core",
    "",
  ].join("\n"));
  assert.throws(() => preflightOutputs({ ...result, units: [{ id: "protocol", kind: "npm", state: "partial" }] }));
});

test("preflight packages list every clean npm, Maven and Composer unit in dependency order", () => {
  const units = [
    { id: "protocol", kind: "npm", state: "clean" },
    { id: "dashboard-client", kind: "npm", state: "clean" },
    { id: "gauntlet", kind: "application", state: "clean" },
    { id: "typescript-core", kind: "npm", state: "already-identical" },
    { id: "typescript-node", kind: "npm", state: "clean" },
    { id: "php-core", kind: "composer", state: "clean" },
    { id: "symfony-bundle", kind: "composer", state: "clean" },
    { id: "java-core", kind: "maven", state: "clean" },
    { id: "spring-boot-starter", kind: "maven", state: "clean" },
    { id: "skills", kind: "skills", state: "clean" },
  ];
  const packages = (list) => preflightOutputs({ command: "check", units: list }).split("\n").find((line) => line.startsWith("packages="));
  assert.equal(packages(units), "packages=protocol dashboard-client typescript-node php-core symfony-bundle java-core spring-boot-starter");
  // A dependent listed before its dependency is still published after it.
  assert.equal(packages([units[4], units[0]]), "packages=protocol typescript-node");
  assert.equal(packages([units[2], units[9]]), "packages=");
  const flags = (list) => preflightOutputs({ command: "check", units: list }).split("\n").filter((line) => /^(?:gauntlet|skills)=/u.test(line));
  assert.deepEqual(flags([units[0]]), ["gauntlet=false", "skills=false"]);
  assert.deepEqual(flags([{ ...units[2], state: "already-identical" }, units[9]]), ["gauntlet=false", "skills=true"]);
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

function finalizedFixture(t, units) {
  const fixture = releaseFixture(t, units);
  for (const { id } of units) {
    const digest = id === "gauntlet" ? fixture.digest : null;
    writePublicationReceipt({ releaseDirectory: fixture.root, unit: id, imageDigest: digest, chartDigest: digest });
  }
  return fixture;
}

function scratchDirectory(t) {
  const directory = realpathSync(mkdtempSync(resolve(tmpdir(), "gauntlet-release-set-test-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("assets list the finalized skills files and skills has no registry artifact", (t) => {
  const { root } = finalizedFixture(t, [{ id: "skills", version: "0.1.0" }]);
  const assets = runReleaseSetCli(["assets", "--release-directory", root, "--unit", "skills"]);
  assert.equal(assets.exitCode, 0, assets.stderr);
  assert.deepEqual(assets.stdout.split("\n"), [
    resolve(root, "skills/gauntlet-skills-0.1.0.tgz"),
    resolve(root, "units/skills/release-manifest.json"),
    resolve(root, "units/skills/publication-receipt.json"),
    resolve(root, "units/skills/SHA256SUMS"),
    "",
  ]);
  const artifact = runReleaseSetCli(["artifact", "--release-directory", root, "--unit", "skills"]);
  assert.equal(artifact.exitCode, 1);
  assert.equal(artifact.stdout, "");
  assert.equal(JSON.parse(artifact.stderr).ok, false);
});

test("assets fail before finalization and artifact resolves the single registry archive", (t) => {
  const { root } = releaseFixture(t, [{ id: "protocol", version: "0.1.0" }, { id: "skills", version: "0.1.0" }]);
  assert.equal(runReleaseSetCli(["assets", "--release-directory", root, "--unit", "skills"]).exitCode, 1);
  const artifact = runReleaseSetCli(["artifact", "--release-directory", root, "--unit", "protocol"]);
  assert.deepEqual([artifact.exitCode, artifact.stdout], [0, `${resolve(root, "npm/8lines-gauntlet-protocol-0.1.0.tgz")}\n`]);
  assert.equal(runReleaseSetCli(["artifact", "--release-directory", root, "--unit", "gauntlet"]).exitCode, 1);
});

test("previous-tag names the unit tag the plan starts from, or nothing for a first release", (t) => {
  const { root } = releaseFixture(t, [{ id: "protocol", version: "0.2.0" }, { id: "skills", version: "0.1.0" }]);
  const repository = scratchDirectory(t);
  const run = (unit) => runReleaseSetCli(["field", "--release-directory", root, "--unit", unit, "--field", "previous-tag"], { root: repository });
  assert.equal(JSON.parse(run("protocol").stderr).error.message, "Release plan is missing or unsafe");
  mkdirSync(resolve(repository, ".release"));
  const writePlan = (units) => writeFileSync(resolve(repository, ".release/plan.json"), serializeReleasePlan(createReleasePlan(units)));
  writePlan([{ id: "protocol", from: "0.1.8", to: "0.2.0" }, { id: "skills", from: null, to: "0.1.0" }]);
  assert.deepEqual([run("protocol").exitCode, run("protocol").stdout], [0, "protocol-v0.1.8\n"]);
  assert.deepEqual([run("skills").exitCode, run("skills").stdout], [0, "\n"]);

  writePlan([{ id: "protocol", from: "0.1.8", to: "0.2.1" }, { id: "skills", from: null, to: "0.1.0" }]);
  assert.deepEqual([run("protocol").exitCode, JSON.parse(run("protocol").stderr).error.message],
    [1, "Release unit protocol is not planned at its staged version"]);
  writePlan([{ id: "skills", from: null, to: "0.1.0" }]);
  assert.equal(run("protocol").exitCode, 1);

  rmSync(resolve(repository, ".release/plan.json"));
  symlinkSync(resolve(repository, "elsewhere.json"), resolve(repository, ".release/plan.json"));
  assert.equal(run("skills").exitCode, 1);
});

test("artifact refuses a staged archive whose bytes no longer match the manifest", (t) => {
  const { root } = releaseFixture(t, [{ id: "protocol", version: "0.1.0" }]);
  const path = resolve(root, "npm/8lines-gauntlet-protocol-0.1.0.tgz");
  assert.equal(runReleaseSetCli(["artifact", "--release-directory", root, "--unit", "protocol"]).exitCode, 0);
  writeFileSync(path, "tampered\n");
  const result = runReleaseSetCli(["artifact", "--release-directory", root, "--unit", "protocol"]);
  assert.deepEqual([result.exitCode, result.stdout], [1, ""]);
  assert.equal(JSON.parse(result.stderr).error.message, "Staged release file npm/8lines-gauntlet-protocol-0.1.0.tgz does not match its manifest hash");
});

test("field prints one manifest value", (t) => {
  const { root } = releaseFixture(t, [{ id: "gauntlet", version: "0.1.0" }, { id: "skills", version: "0.1.0" }]);
  for (const [field, expected] of [["version", "0.1.0"], ["tag", "v0.1.0"], ["title", "Gauntlet v0.1.0"]]) {
    const result = runReleaseSetCli(["field", "--release-directory", root, "--unit", "gauntlet", "--field", field]);
    assert.deepEqual([result.exitCode, result.stdout], [0, `${expected}\n`]);
  }
  assert.equal(runReleaseSetCli(["field", "--release-directory", root, "--unit", "protocol", "--field", "tag"]).exitCode, 1);
});

test("notes fall back to generated mode, use a unit changelog section and refuse an existing output", (t) => {
  const { root } = releaseFixture(t, [{ id: "skills", version: "0.1.0" }]);
  const repository = scratchDirectory(t);
  const output = resolve(repository, "notes.md");
  const run = (path) => runReleaseSetCli(["notes", "--release-directory", root, "--unit", "skills", "--output", path], { root: repository });
  assert.deepEqual([run(output).exitCode, run(resolve(repository, "other.md")).stdout], [0, "generated\n"]);
  assert.equal(readFileSync(output, "utf8"), `Release set \`${SET}\`.\n`);
  assert.equal(run(output).exitCode, 1);

  mkdirSync(resolve(repository, "skills"));
  writeFileSync(resolve(repository, "skills/CHANGELOG.md"), "# Changelog\n\n## [0.1.0] - 2026-10-03\n\n- First.\n");
  const second = resolve(repository, "second.md");
  assert.deepEqual([run(second).exitCode, run(resolve(repository, "third.md")).stdout], [0, "changelog\n"]);
  assert.equal(readFileSync(second, "utf8"), `- First.\n\nRelease set \`${SET}\`.\n`);

  writeFileSync(resolve(repository, "skills/CHANGELOG.md"), "# Changelog\n\n## [0.0.9]\n\n- Old.\n");
  assert.equal(run(resolve(repository, "fourth.md")).stdout, "generated\n");
});

test("notes refuse a symbolic-link changelog and never write through a symbolic-link output", (t) => {
  const { root } = releaseFixture(t, [{ id: "skills", version: "0.1.0" }]);
  const repository = scratchDirectory(t);
  mkdirSync(resolve(repository, "skills"));
  writeFileSync(resolve(repository, "target.md"), "## [0.1.0]\n\n- Linked.\n");
  symlinkSync(resolve(repository, "target.md"), resolve(repository, "skills/CHANGELOG.md"));
  const result = runReleaseSetCli(["notes", "--release-directory", root, "--unit", "skills", "--output", resolve(repository, "out.md")], { root: repository });
  assert.equal(result.exitCode, 1);
  assert.equal(existsSync(resolve(repository, "out.md")), false);
  rmSync(resolve(repository, "skills/CHANGELOG.md"));
  symlinkSync(resolve(repository, "missing.md"), resolve(repository, "out.md"));
  const linked = runReleaseSetCli(["notes", "--release-directory", root, "--unit", "skills", "--output", resolve(repository, "out.md")], { root: repository });
  assert.equal(linked.exitCode, 1);
  assert.equal(existsSync(resolve(repository, "missing.md")), false);
});

test("state commands read JSON files and refuse invalid input", (t) => {
  const directory = scratchDirectory(t);
  const write = (name, value) => {
    const path = resolve(directory, name);
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
    return path;
  };
  const plan = write("plan.json", { command: "check", ok: true, order: ["skills"], gates: ["skills"] });
  assert.deepEqual(Object.values(runReleaseSetCli(["outputs", "--plan-result", plan])).slice(0, 2), [0, 'gates=["skills"]\nunits=["skills"]\n']);
  const failed = write("failed.json", { command: "check", ok: false, order: [], gates: [] });
  assert.equal(runReleaseSetCli(["outputs", "--plan-result", failed]).exitCode, 1);
  assert.equal(runReleaseSetCli(["outputs", "--plan-result", write("bad.json", "{")]).exitCode, 1);
  assert.equal(runReleaseSetCli(["outputs", "--plan-result", resolve(directory, "absent.json")]).exitCode, 1);

  const state = write("state.json", { command: "check", units: [{ id: "skills", kind: "skills", state: "clean" }] });
  assert.equal(runReleaseSetCli(["preflight-outputs", "--state-file", state]).stdout.split("\n")[0], 'clean=["skills"]');
  assert.equal(runReleaseSetCli(["require-state", "--state-file", state, "--unit", "skills", "--state", "clean"]).exitCode, 0);
  assert.equal(runReleaseSetCli(["require-state", "--state-file", state, "--unit", "skills", "--state", "already-identical"]).exitCode, 1);

  symlinkSync(state, resolve(directory, "link.json"));
  assert.equal(runReleaseSetCli(["preflight-outputs", "--state-file", resolve(directory, "link.json")]).exitCode, 1);
});

test("invalid arguments exit 2 with a usage error", () => {
  for (const argv of [
    [], ["unknown"], ["outputs"], ["outputs", "--plan-result", "relative.json"], ["outputs", "--plan-result", "/a", "--plan-result", "/b"],
    ["field", "--release-directory", "/a", "--unit", "skills", "--field", "nope"],
    ["field", "--release-directory", "/a", "--unit", "skills", "--field", "previous"],
    ["field", "--release-directory", "/a", "--unit", "nope", "--field", "tag"],
    ["artifact", "--release-directory", "/a", "--unit", "skills", "--extra", "x"],
    ["require-state", "--state-file", "/a", "--unit", "skills", "--state", "Clean!"],
    ["notes", "--release-directory", "/a", "--unit", "skills"],
  ]) {
    const result = runReleaseSetCli(argv);
    assert.equal(result.exitCode, 2, JSON.stringify(argv));
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error.code, "INVALID_ARGUMENTS");
  }
});

test("plan outputs validate unit ids, dependency order and gates against the catalog", () => {
  const base = { command: "check", ok: true, order: ["protocol", "typescript-core"], gates: ["node"] };
  assert.doesNotThrow(() => planOutputs(base));
  for (const mutation of [
    { order: ["typescript-core", "protocol"] }, { order: ["protocol", "protocol"] }, { order: ["nope"] }, { order: ["__proto__"] },
    { order: [] }, { order: "protocol" }, { gates: ["node", "node"] }, { gates: ["nope"] }, { gates: "node" }, { gates: [1] },
  ]) assert.throws(() => planOutputs({ ...base, ...mutation }), undefined, JSON.stringify(mutation));
});

test("preflight outputs validate unit ids and kinds against the catalog", () => {
  const unit = { id: "protocol", kind: "npm", state: "clean" };
  const result = (units) => ({ command: "check", units });
  assert.doesNotThrow(() => preflightOutputs(result([unit])));
  for (const units of [
    [unit, unit], [{ ...unit, id: "nope" }], [{ ...unit, id: "__proto__" }], [{ ...unit, kind: "maven" }], [{ id: "protocol", state: "clean" }],
    [null],
  ]) assert.throws(() => preflightOutputs(result(units)), undefined, JSON.stringify(units));
});

test("staged paths must stay canonical inside the release directory", (t) => {
  const { root, temporaryRoot } = finalizedFixture(t, [{ id: "protocol", version: "0.1.0" }, { id: "skills", version: "0.1.0" }]);
  const outside = resolve(temporaryRoot, "outside");
  cpSync(resolve(root, "npm"), outside, { recursive: true });
  rmSync(resolve(root, "npm"), { recursive: true });
  symlinkSync(outside, resolve(root, "npm"));
  const artifact = runReleaseSetCli(["artifact", "--release-directory", root, "--unit", "protocol"]);
  assert.deepEqual([artifact.exitCode, artifact.stdout], [1, ""]);

  const units = resolve(root, "units");
  const movedUnits = resolve(temporaryRoot, "units-outside");
  renameSync(units, movedUnits);
  symlinkSync(movedUnits, units);
  const assets = runReleaseSetCli(["assets", "--release-directory", root, "--unit", "skills"]);
  assert.deepEqual([assets.exitCode, assets.stdout], [1, ""]);
});

test("a symbolic-link release directory is refused", (t) => {
  const { root, temporaryRoot } = finalizedFixture(t, [{ id: "skills", version: "0.1.0" }]);
  const link = resolve(temporaryRoot, "link");
  symlinkSync(root, link);
  assert.equal(runReleaseSetCli(["assets", "--release-directory", link, "--unit", "skills"]).exitCode, 1);
});

test("require-state accepts only the states check-published emits", () => {
  for (const state of ["clean", "already-identical", "published-artifacts-identical", "draft-identical"]) {
    assert.equal(runReleaseSetCli(["require-state", "--state-file", "/missing.json", "--unit", "skills", "--state", state]).exitCode, 1);
  }
  for (const state of ["partial", "published", "Clean"]) {
    assert.equal(runReleaseSetCli(["require-state", "--state-file", "/missing.json", "--unit", "skills", "--state", state]).exitCode, 2);
  }
});

test("a directory named CHANGELOG.md counts as an absent changelog", (t) => {
  const { root } = releaseFixture(t, [{ id: "skills", version: "0.1.0" }]);
  const repository = scratchDirectory(t);
  mkdirSync(resolve(repository, "skills/CHANGELOG.md"), { recursive: true });
  const result = runReleaseSetCli(["notes", "--release-directory", root, "--unit", "skills", "--output", resolve(repository, "n.md")], { root: repository });
  assert.deepEqual([result.exitCode, result.stdout], [0, "generated\n"]);
});
