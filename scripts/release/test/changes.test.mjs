import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { computeRelease, nextVersion, parseChangeFile, readChangeFiles } from "../changes.mjs";
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
