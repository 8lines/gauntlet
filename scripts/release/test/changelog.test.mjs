import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  changelogPath, changelogSection, insertChangelogSection, newUnitChangelog, renderChangelogSection,
} from "../changelog.mjs";
import { RELEASE_UNITS } from "../units.mjs";

const ROOT = resolve(import.meta.dirname, "../../..");

test("each unit has its own changelog path; the application keeps the root changelog", () => {
  assert.equal(changelogPath("gauntlet"), "CHANGELOG.md");
  assert.equal(changelogPath("typescript-core"), "packages/typescript/core/CHANGELOG.md");
  assert.equal(changelogPath("conformance-runner"), "conformance/runner/CHANGELOG.md");
  assert.equal(changelogPath("spring-boot-starter"), "packages/java/spring-boot-starter/CHANGELOG.md");
  assert.equal(changelogPath("skills"), "skills/CHANGELOG.md");
});

test("renders a Keep a Changelog section with types in the conventional order", () => {
  assert.equal(renderChangelogSection({ version: "0.2.0", date: "2026-10-04", entries: [
    { type: "fixed", text: "Fixed a thing." }, { type: "added", text: "Added a thing." },
    { type: "changed", text: "Updated `protocol` to 0.2.0." },
  ] }), "## [0.2.0] - 2026-10-04\n\n### Added\n\n- Added a thing.\n\n### Changed\n\n- Updated `protocol` to 0.2.0.\n\n### Fixed\n\n- Fixed a thing.\n");
  assert.throws(() => renderChangelogSection({ version: "0.2.0", date: "2026-10-04", entries: [] }), /Changelog section is invalid/u);
  assert.throws(() => renderChangelogSection({ version: "0.2.0", date: "04.10.2026", entries: [{ type: "fixed", text: "X." }] }), /Changelog section is invalid/u);
});

test("inserts the new section right below an empty Unreleased heading", () => {
  const section = renderChangelogSection({ version: "0.1.9", date: "2026-10-04", entries: [{ type: "fixed", text: "Fixed a thing." }] });
  const root = "# Changelog\n\nIntro.\n\n## Unreleased\n\n## [0.1.8] - 2026-10-03\n\n### Added\n\n- Old.\n";
  const next = insertChangelogSection(root, section);
  assert.equal(next, "# Changelog\n\nIntro.\n\n## Unreleased\n\n## [0.1.9] - 2026-10-04\n\n### Fixed\n\n- Fixed a thing.\n\n## [0.1.8] - 2026-10-03\n\n### Added\n\n- Old.\n");
  assert.equal(changelogSection(next, "0.1.9"), "### Fixed\n\n- Fixed a thing.");
  const fresh = newUnitChangelog("protocol");
  assert.equal(insertChangelogSection(fresh, section), `${fresh}\n${section}`);
});

test("refuses hand-written Unreleased entries, a missing Unreleased heading and an existing version section", () => {
  const section = renderChangelogSection({ version: "0.1.8", date: "2026-10-04", entries: [{ type: "fixed", text: "Fixed." }] });
  assert.throws(() => insertChangelogSection("# Changelog\n\n## Unreleased\n\n- Pending.\n", section), /entries under ## Unreleased; move them into change files/u);
  assert.throws(() => insertChangelogSection("# Changelog\n", section), /no ## Unreleased heading/u);
  assert.throws(() => insertChangelogSection("# Changelog\n\n## Unreleased\n\n## [0.1.8] - 2026-10-03\n\n- Old.\n", section), /already has a section for 0\.1\.8/u);
});

test("a new unit changelog names its artifacts and links the shared history", () => {
  assert.equal(newUnitChangelog("typescript-core"), [
    "# Changelog: `typescript-core`",
    "",
    "All notable changes to `@8lines/gauntlet-typescript-core` are recorded here in the",
    "[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. Versions follow",
    "[Semantic Versioning](https://semver.org/spec/v2.0.0.html); before 1.0 a breaking change is a minor",
    "release. Released versions are immutable; a correction is a new version.",
    "",
    "Releases up to 0.1.8 were published together with the application and are recorded in the",
    "[root changelog](../../../CHANGELOG.md).",
    "",
    "## Unreleased",
    "",
  ].join("\n"));
  assert.throws(() => newUnitChangelog("gauntlet"), /root CHANGELOG\.md/u);
});

test("every unit changelog exists with an Unreleased heading and is linked from the root changelog", () => {
  const root = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
  assert.match(root, /^## Unreleased$/mu);
  for (const { id } of RELEASE_UNITS.filter(({ id: unit }) => unit !== "gauntlet")) {
    const path = changelogPath(id);
    const source = readFileSync(join(ROOT, path), "utf8");
    assert.equal(source.startsWith(newUnitChangelog(id).split("## Unreleased")[0]), true, path);
    assert.match(source, /^## Unreleased$/mu, path);
    assert.equal(root.includes(`[\`${id}\`](${path})`), true, `root changelog links ${path}`);
  }
});
