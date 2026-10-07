import assert from "node:assert/strict";
import test from "node:test";

import { renderUpgradeGuide, upgradeAction, upgradeGuidePath, upgradeGuideUrl } from "../upgrade-guide.mjs";

test("each unit's guides live under docs/upgrades and link at the unit's release tag", () => {
  assert.equal(upgradeGuidePath("gauntlet", "0.2.1"), "docs/upgrades/gauntlet/0.2.1.md");
  assert.equal(upgradeGuideUrl("gauntlet", "0.2.1"), "https://github.com/8lines/gauntlet/blob/v0.2.1/docs/upgrades/gauntlet/0.2.1.md");
  assert.equal(upgradeGuideUrl("skills", "0.1.12"), "https://github.com/8lines/gauntlet/blob/skills-v0.1.12/docs/upgrades/skills/0.1.12.md");
});

test("the action is the strongest step: required, then optional, then none", () => {
  assert.equal(upgradeAction([]), "none");
  assert.equal(upgradeAction([{ action: "optional" }]), "optional");
  assert.equal(upgradeAction([{ action: "optional" }, { action: "required" }, { action: "optional" }]), "required");
});

test("renders a guide with front matter, changes, required steps first and the verification", () => {
  assert.equal(renderUpgradeGuide({
    unit: "gauntlet", from: "0.2.0", to: "0.2.1", date: "2026-10-07",
    entries: [{ type: "changed", text: "Faster catalog." }, { type: "added", text: "Pinned operations." }],
    upgrades: [
      { name: "pinned-operations.md", action: "optional", text: "Set `GAUNTLET_DATA_DIR`." },
      { name: "renamed-port.md", action: "required", text: "Rename `GAUNTLET_LISTEN` to `GAUNTLET_PORT`." },
    ],
  }), [
    "---",
    "unit: gauntlet",
    "from: 0.2.0",
    "to: 0.2.1",
    "date: 2026-10-07",
    "action: required",
    "---",
    "",
    "# Upgrade `gauntlet` from 0.2.0 to 0.2.1",
    "",
    "What changed in `gauntlet` 0.2.1 and what an operator must or may change when upgrading from 0.2.0.",
    "Apply every guide between the deployed version and the target, oldest first, as described in",
    "[upgrade guides](../README.md).",
    "",
    "## Changes",
    "",
    "- Added: Pinned operations.",
    "- Changed: Faster catalog.",
    "",
    "## Steps",
    "",
    "### Renamed port (required)",
    "",
    "Rename `GAUNTLET_LISTEN` to `GAUNTLET_PORT`.",
    "",
    "### Pinned operations (optional)",
    "",
    "Set `GAUNTLET_DATA_DIR`.",
    "",
    "## Verify",
    "",
    "Follow the verification in the [upgrade runbook](../../releases/upgrading.md#verify).",
    "",
  ].join("\n"));
});

test("a version without steps says no action is required, and package units verify with their consumers", () => {
  const guide = renderUpgradeGuide({
    unit: "typescript-core", from: "0.1.8", to: "0.1.9", date: "2026-10-07",
    entries: [{ type: "changed", text: "Updated `protocol` to 0.2.0." }], upgrades: [],
  });
  assert.match(guide, /^action: none$/mu);
  assert.match(guide, /## Steps\n\nNo action is required\.\n/u);
  assert.match(guide, /\[installing packages\]\(\.\.\/\.\.\/releases\/installing-packages\.md\)/u);
  assert.match(renderUpgradeGuide({
    unit: "skills", from: "0.1.11", to: "0.1.12", date: "2026-10-07", entries: [{ type: "added", text: "A skill." }], upgrades: [],
  }), /\[AI skills\]\(\.\.\/\.\.\/ai-skills\.md\)/u);
});

test("refuses an invalid guide", () => {
  const valid = { unit: "gauntlet", from: "0.2.0", to: "0.2.1", date: "2026-10-07", entries: [{ type: "fixed", text: "X." }], upgrades: [] };
  for (const invalid of [
    { ...valid, date: "07.10.2026" },
    { ...valid, entries: [] },
    { ...valid, upgrades: [{ name: "a.md", action: "none", text: "X." }] },
    { ...valid, upgrades: [{ name: "a.md", action: "optional", text: "" }] },
  ]) assert.throws(() => renderUpgradeGuide(invalid), /Upgrade guide is invalid/u);
  assert.throws(() => renderUpgradeGuide({ ...valid, unit: "nope" }), /nope/u);
});
