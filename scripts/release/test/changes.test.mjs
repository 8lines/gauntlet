import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { computeRelease, isOwnedBy, nextVersion, parseChangeFile, readChangeFiles, runChangesCli } from "../changes.mjs";
import { createReleasePlan, serializeReleasePlan } from "../plan.mjs";
import { RELEASE_TEXT_FILES } from "../release-model.mjs";
import { RELEASE_UNITS, unitById } from "../units.mjs";

const SPEC_EXAMPLE = "---\ntype: added            # added | changed | fixed | removed | security\nunits:\n  protocol: minor\n  gauntlet: patch\n---\nRun requests accept an optional deadline.\n";
const BASE = new Map(RELEASE_UNITS.map(({ id }) => [id, "0.1.8"]));

function change(name, type, units, body = "A user-facing sentence.") {
  const lines = Object.entries(units).map(([id, bump]) => `  ${id}: ${bump}`);
  return parseChangeFile(name, `---\ntype: ${type}\nunits:\n${lines.join("\n")}\n---\n${body}\n`);
}

test("parses the documented change file format", () => {
  assert.deepEqual(parseChangeFile("deadline.md", SPEC_EXAMPLE), {
    name: "deadline.md", type: "added", units: { gauntlet: "patch", protocol: "minor" },
    body: "Run requests accept an optional deadline.",
  });
  assert.equal(
    parseChangeFile("wrapped.md", "---\ntype: fixed\nunits:\n  widget: patch\n---\nA sentence that\nwraps lines.\n").body,
    "A sentence that wraps lines.",
  );
});

test("rejects every malformed change file with the file name and the reason", () => {
  const body = (front, text = "Body.") => `---\n${front}\n---\n${text}\n`;
  const cases = [
    ["Deadline.md", SPEC_EXAMPLE, /Change file name Deadline\.md/u],
    ["a.md", SPEC_EXAMPLE.replaceAll("\n", "\r\n"), /LF-only/u],
    ["a.md", "type: added\n", /front matter/u],
    ["a.md", body("type: added\nunits:\n  protocol: minor\nextra: 1"), /exactly type and units/u],
    ["a.md", body("type: improved\nunits:\n  protocol: minor"), /type must be one of/u],
    ["a.md", body("type: added\nunits: {}"), /at least one release unit/u],
    ["a.md", body("type: added\nunits:\n  nope: minor"), /unknown release unit nope/u],
    ["a.md", body("type: added\nunits:\n  protocol: huge"), /protocol bump must be one of/u],
    ["a.md", body("type: added\nunits:\n  protocol: minor\n  protocol: patch"), /not valid YAML/u],
    ["a.md", body("type: added\nunits: &shared\n  protocol: minor\nextra: *shared"), /Change file a\.md: front matter is not valid YAML/u],
    ["a.md", body("type: added\nunits:\n  protocol: &bump minor\n  widget: *bump"), /Change file a\.md: front matter is not valid YAML/u],
    ["a.md", "---\ntype: added\nunits:\n  protocol: minor\n---\n\n", /changelog sentence/u],
    ["a.md", body("type: added\nunits:\n  protocol: minor", "One.\n\nTwo."), /one paragraph/u],
    ["a.md", body("type: added\nunits:\n  protocol: minor", "Deadlines — optional."), /em dash/u],
    ["a.md", body("type: added\nunits:\n  protocol: minor", "lower case."), /sentence case/u],
  ];
  for (const [name, source, pattern] of cases) {
    assert.throws(() => parseChangeFile(name, source), pattern, `${name}: ${JSON.stringify(source)}`);
  }
});

test("reads change files in name order and refuses anything else in .changes", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gauntlet-changes-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(readChangeFiles(root), []);
  mkdirSync(join(root, ".changes"));
  writeFileSync(join(root, ".changes/b-second.md"), SPEC_EXAMPLE);
  writeFileSync(join(root, ".changes/a-first.md"), SPEC_EXAMPLE);
  assert.deepEqual(readChangeFiles(root).map(({ name }) => name), ["a-first.md", "b-second.md"]);
  writeFileSync(join(root, ".changes/notes.txt"), "x\n");
  assert.throws(() => readChangeFiles(root), /\.changes\/notes\.txt is not a change file/u);
  rmSync(join(root, ".changes/notes.txt"));
  symlinkSync(join(root, ".changes/a-first.md"), join(root, ".changes/c-link.md"));
  assert.throws(() => readChangeFiles(root), /\.changes\/c-link\.md is not a change file/u);
});

test("bumps apply literally under semver", () => {
  assert.equal(nextVersion("0.1.8", "patch"), "0.1.9");
  assert.equal(nextVersion("0.1.9", "patch"), "0.1.10");
  assert.equal(nextVersion("0.1.8", "minor"), "0.2.0");
  assert.equal(nextVersion("0.9.3", "major"), "1.0.0");
  assert.equal(nextVersion("1.2.3", "minor"), "1.3.0");
  assert.throws(() => nextVersion("0.1.8", "none"), /Unknown bump none/u);
});

test("a dashboard-only change releases the application and the skills archive", () => {
  const release = computeRelease({ versions: BASE, changes: [change("sidebar.md", "fixed", { gauntlet: "patch" }, "Sidebar keeps its width.")] });
  assert.deepEqual(release.units, [
    { id: "gauntlet", from: "0.1.8", to: "0.1.9", bump: "patch", cascaded: false, entries: [{ type: "fixed", text: "Sidebar keeps its width." }] },
    { id: "skills", from: "0.1.8", to: "0.1.9", bump: "patch", cascaded: true, entries: [{ type: "changed", text: "Updated `gauntlet` to 0.1.9." }] },
  ]);
  assert.deepEqual(release.consumed, ["sidebar.md"]);
});

test("a protocol minor release cascades a patch to every dependent with update entries", () => {
  const release = computeRelease({
    versions: BASE, changes: [change("deadline.md", "added", { protocol: "minor" }, "Run requests accept an optional deadline.")],
  });
  assert.deepEqual(release.units.map(({ id, to, bump, cascaded }) => [id, to, bump, cascaded]), [
    ["protocol", "0.2.0", "minor", false],
    ["dashboard-client", "0.1.9", "patch", true],
    ["gauntlet", "0.1.9", "patch", true],
    ["typescript-core", "0.1.9", "patch", true],
    ["typescript-node", "0.1.9", "patch", true],
    ["next-adapter", "0.1.9", "patch", true],
    ["conformance-runner", "0.1.9", "patch", true],
    ["skills", "0.1.9", "patch", true],
  ]);
  const texts = Object.fromEntries(release.units.map(({ id, entries }) => [id, entries.map(({ text }) => text)]));
  assert.deepEqual(texts.protocol, ["Run requests accept an optional deadline."]);
  assert.deepEqual(texts.gauntlet, ["Updated `protocol` to 0.2.0.", "Updated `dashboard-client` to 0.1.9."]);
  assert.deepEqual(texts["typescript-node"], ["Updated `protocol` to 0.2.0.", "Updated `typescript-core` to 0.1.9."]);
  assert.deepEqual(texts["next-adapter"], ["Updated `typescript-node` to 0.1.9."]);
  assert.deepEqual(texts.skills, [
    "Updated `protocol` to 0.2.0.", "Updated `gauntlet` to 0.1.9.", "Updated `typescript-core` to 0.1.9.",
    "Updated `typescript-node` to 0.1.9.", "Updated `next-adapter` to 0.1.9.",
  ]);
});

test("a php-core patch also releases symfony-bundle, whose constraint follows php-core, and the skills", () => {
  const release = computeRelease({ versions: BASE, changes: [change("php.md", "fixed", { "php-core": "patch" })] });
  assert.deepEqual(release.units.map(({ id, to, cascaded }) => [id, to, cascaded]), [
    ["php-core", "0.1.9", false], ["symfony-bundle", "0.1.9", true], ["skills", "0.1.9", true],
  ]);
  assert.deepEqual(release.units[1].entries, [{ type: "changed", text: "Updated `php-core` to 0.1.9." }]);
});

test("the highest bump wins across change files, none never releases, and none alone releases nothing", () => {
  const release = computeRelease({ versions: BASE, changes: [
    change("a.md", "fixed", { widget: "patch" }, "Fixed the button."),
    change("b.md", "added", { widget: "minor", protocol: "none" }, "Added a command."),
    change("c.md", "changed", { widget: "none" }, "Reformatted sources."),
  ] });
  assert.deepEqual(release.units, [{
    id: "widget", from: "0.1.8", to: "0.2.0", bump: "minor", cascaded: false,
    entries: [{ type: "fixed", text: "Fixed the button." }, { type: "added", text: "Added a command." }],
  }]);
  assert.deepEqual(release.consumed, ["a.md", "b.md", "c.md"]);
  assert.throws(
    () => computeRelease({ versions: BASE, changes: [change("c.md", "changed", { widget: "none" }, "Reformatted sources.")] }),
    /no change file that releases a unit/u,
  );
  assert.throws(() => computeRelease({ versions: BASE, changes: [] }), /found no change files/u);
});

test("every unit pinned by skill text cascades into the skills archive", () => {
  const dependencies = new Set(unitById("skills").dependsOn);
  for (const { path, slots } of RELEASE_TEXT_FILES.filter(({ path: file }) => file.startsWith("skills/"))) {
    for (const { unit } of slots) assert.equal(unit === "skills" || dependencies.has(unit), true, `${path} pins ${unit}`);
  }
});

test("a change file that is not valid UTF-8 is refused instead of decoded with replacement characters", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gauntlet-changes-utf8-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".changes"));
  writeFileSync(join(root, ".changes/bad.md"), Buffer.concat([
    Buffer.from("---\ntype: fixed\nunits:\n  widget: patch\n---\nBroken "),
    Buffer.from([0xff, 0xfe]),
    Buffer.from(" bytes.\n"),
  ]));
  assert.throws(() => readChangeFiles(root), /Change file bad\.md: must be LF-only UTF-8 text/u);
});

function git(root, ...args) {
  const result = spawnSync("git", [
    "-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function write(root, path, contents) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), contents);
}

function changeSource(units, type = "fixed") {
  return `---\ntype: ${type}\nunits:\n${Object.entries(units).map(([id, bump]) => `  ${id}: ${bump}`).join("\n")}\n---\nA user-facing sentence.\n`;
}

function repository(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gauntlet-changes-check-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "--initial-branch=main");
  write(root, "packages/protocol/src/index.ts", "export const a = 1;\n");
  write(root, "apps/server/package.json", "{}\n");
  write(root, "VERSION", "0.1.8\n");
  write(root, "skills/VERSION", "0.1.8\n");
  write(root, ".changes/old.md", changeSource({ widget: "patch" }));
  git(root, "add", "-A");
  git(root, "commit", "-m", "base");
  git(root, "switch", "-c", "topic");
  return root;
}

function commit(root) {
  git(root, "add", "-A");
  git(root, "commit", "-m", "change");
}

function check(root) {
  const result = runChangesCli(["--check", "--base", "main"], { root });
  return { exitCode: result.exitCode, ...JSON.parse(result.stdout === "" ? result.stderr : result.stdout) };
}

test("ownership follows each unit's released paths and ignores READMEs, changelogs and tests", () => {
  const owners = (path) => RELEASE_UNITS.filter((unit) => isOwnedBy(unit, path)).map(({ id }) => id);
  assert.deepEqual(owners("packages/protocol/schemas/v1/run.json"), ["protocol"]);
  assert.deepEqual(owners("packages/typescript/core/src/index.ts"), ["typescript-core"]);
  assert.deepEqual(owners("packages/typescript/core/src/index.test.ts"), []);
  assert.deepEqual(owners("packages/java/core/src/test/java/X.java"), []);
  assert.deepEqual(owners("deploy/helm/gauntlet/values.yaml"), ["gauntlet"]);
  assert.deepEqual(owners("deploy/compose/test/wrapper.test.mjs"), []);
  assert.deepEqual(owners("deploy/compose/README.md"), []);
  assert.deepEqual(owners("skills/gauntlet-app-integration/references/node.md"), ["skills"]);
  assert.deepEqual(owners("skills/CHANGELOG.md"), []);
  assert.deepEqual(owners("skill-evals/gauntlet-app-integration/EVALUATING.md"), []);
  assert.deepEqual(owners("packages/protocol/srcx/a.ts"), []);
});

test("a pull request touching released paths needs a change file naming each touched unit", (t) => {
  const root = repository(t);
  write(root, "packages/protocol/src/index.ts", "export const a = 2;\n");
  commit(root);
  assert.deepEqual(check(root), {
    exitCode: 1, base: git(root, "rev-parse", "main"), command: "check", covered: [], ok: false, touched: ["protocol"],
    problems: ['protocol: packages/protocol/src/index.ts changed without a change file naming protocol; add .changes/<name>.md (use "none" when no release is needed)'],
  });
  write(root, ".changes/deadline.md", changeSource({ protocol: "minor" }, "added"));
  commit(root);
  const covered = check(root);
  assert.deepEqual([covered.exitCode, covered.covered, covered.problems], [0, ["protocol"], []]);
});

test("none covers a touched unit, and READMEs, changelogs and tests need no change file", (t) => {
  const root = repository(t);
  write(root, "packages/protocol/README.md", "# Protocol\n");
  write(root, "packages/protocol/CHANGELOG.md", "# Changelog\n");
  write(root, "packages/protocol/src/index.test.ts", "test\n");
  commit(root);
  assert.deepEqual([check(root).exitCode, check(root).touched], [0, []]);
  write(root, "packages/protocol/src/index.ts", "export const a = 3;\n");
  write(root, ".changes/refactor.md", changeSource({ protocol: "none" }, "changed"));
  commit(root);
  assert.equal(check(root).exitCode, 0);
});

test("a release pull request covers only its planned units, and deleting a change file covers nothing", (t) => {
  const deleting = repository(t);
  write(deleting, "packages/protocol/src/index.ts", "export const a = 4;\n");
  rmSync(join(deleting, ".changes/old.md"));
  commit(deleting);
  assert.deepEqual(check(deleting).touched, ["protocol"]);
  assert.equal(check(deleting).exitCode, 1);

  const release = repository(t);
  write(release, ".release/plan.json", serializeReleasePlan(createReleasePlan(
    [{ id: "gauntlet", from: "0.1.8", to: "0.1.9" }, { id: "skills", from: "0.1.8", to: "0.1.9" }],
    { changes: ["old.md"] },
  )));
  write(release, "apps/server/package.json", '{"version":"0.1.9"}\n');
  write(release, "VERSION", "0.1.9\n");
  write(release, "skills/VERSION", "0.1.9\n");
  rmSync(join(release, ".changes/old.md"));
  commit(release);
  assert.deepEqual([check(release).exitCode, check(release).covered], [0, ["gauntlet", "skills"]]);
  write(release, "packages/protocol/src/index.ts", "export const a = 5;\n");
  commit(release);
  const loophole = check(release);
  assert.equal(loophole.exitCode, 1);
  assert.deepEqual(loophole.problems.map((problem) => problem.split(":")[0]), ["protocol"]);
});

test("an invalid change file fails the check and arguments are closed", (t) => {
  const root = repository(t);
  write(root, ".changes/bad.md", "nonsense\n");
  commit(root);
  const result = check(root);
  assert.equal(result.exitCode, 1);
  assert.equal(result.problems.some((problem) => /Change file bad\.md/u.test(problem)), true);
  for (const argv of [[], ["--check", "--base"], ["--check", "--base", "-x"], ["--write"]]) {
    assert.equal(runChangesCli(argv, { root }).exitCode, 2, JSON.stringify(argv));
  }
  const missing = runChangesCli(["--check", "--base", "no-such-branch"], { root });
  assert.equal(missing.exitCode, 1);
  assert.match(JSON.parse(missing.stderr).error.message, /Cannot find the merge base of no-such-branch and HEAD/u);
});

function planSource(units, changes = ["old.md"]) {
  return serializeReleasePlan(createReleasePlan(units.map(([id, from, to]) => ({ id, from, to })), { changes }));
}

test("a release plan covers only the units whose versions it moves in the same diff", (t) => {
  const everything = repository(t);
  write(everything, "packages/protocol/src/index.ts", "export const a = 6;\n");
  write(everything, ".release/plan.json", planSource(RELEASE_UNITS.map(({ id }) => [id, null, "0.1.8"]), []));
  commit(everything);
  const unmoved = check(everything);
  assert.equal(unmoved.exitCode, 1);
  assert.deepEqual([unmoved.covered, unmoved.touched], [[], ["protocol"]]);

  const wrongTarget = repository(t);
  write(wrongTarget, "apps/server/package.json", '{"version":"0.1.9"}\n');
  write(wrongTarget, "VERSION", "0.1.9\n");
  write(wrongTarget, ".release/plan.json", planSource([["gauntlet", "0.1.8", "0.1.10"]]));
  commit(wrongTarget);
  assert.deepEqual([check(wrongTarget).exitCode, check(wrongTarget).covered], [1, []]);

  const planOnly = repository(t);
  write(planOnly, "apps/server/package.json", '{"version":"0.1.9"}\n');
  write(planOnly, ".release/plan.json", planSource([["gauntlet", "0.1.8", "0.1.9"]]));
  commit(planOnly);
  assert.deepEqual([check(planOnly).exitCode, check(planOnly).covered], [1, []]);

  const malformed = repository(t);
  write(malformed, "apps/server/package.json", '{"version":"0.1.9"}\n');
  write(malformed, "VERSION", "not a version\n");
  write(malformed, ".release/plan.json", planSource([["gauntlet", "0.1.8", "0.1.9"]]));
  commit(malformed);
  const broken = check(malformed);
  assert.deepEqual([broken.exitCode, broken.covered], [1, []]);
  assert.equal(JSON.stringify(broken).includes(malformed), false);
});

test("a symlinked change file is refused without being read, and a BOM-prefixed one is not parsed", (t) => {
  const linked = repository(t);
  symlinkSync("/dev/zero", join(linked, ".changes/zero.md"));
  commit(linked);
  const refused = check(linked);
  assert.equal(refused.exitCode, 1);
  assert.deepEqual(refused.problems, [".changes/zero.md is not a change file (a regular lowercase-name.md file)"]);

  const bom = repository(t);
  write(bom, ".changes/bom.md", `\uFEFF${changeSource({ protocol: "patch" })}`);
  commit(bom);
  const result = check(bom);
  assert.equal(result.exitCode, 1);
  assert.equal(result.problems.some((problem) => /Change file bom\.md: must start with --- front matter/u.test(problem)), true);
  assert.equal(JSON.stringify(result.problems).includes(bom), false);
});
