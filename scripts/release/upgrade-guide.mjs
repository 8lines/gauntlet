import { CHANGE_SECTION_TITLES } from "./changelog.mjs";
import { unitById, unitTag } from "./units.mjs";

export const UPGRADE_GUIDES_DIRECTORY = "docs/upgrades";
const REPOSITORY = "https://github.com/8lines/gauntlet";
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const ACTION_RANK = Object.freeze({ none: 0, optional: 1, required: 2 });
// Keep a Changelog order, the same as the changelog sections.
const ENTRY_ORDER = Object.freeze(["added", "changed", "removed", "fixed", "security"]);

export function upgradeGuidePath(unitId, version) {
  return `${UPGRADE_GUIDES_DIRECTORY}/${unitById(unitId).id}/${version}.md`;
}

export function upgradeGuideUrl(unitId, version) {
  return `${REPOSITORY}/blob/${unitTag(unitById(unitId), version)}/${upgradeGuidePath(unitId, version)}`;
}

/** The strongest action of a version's upgrade steps: required, then optional, then none. */
export function upgradeAction(upgrades) {
  return upgrades.reduce((strongest, { action }) => (ACTION_RANK[action] > ACTION_RANK[strongest] ? action : strongest), "none");
}

function stepTitle(name) {
  const words = name.replace(/\.md$/u, "").split("-");
  return [words[0].charAt(0).toUpperCase() + words[0].slice(1), ...words.slice(1)].join(" ");
}

function verification(unitId) {
  if (unitId === "gauntlet") return "Follow the verification in the [upgrade runbook](../../releases/upgrading.md#verify).";
  if (unitId === "skills") return "Install the skills archive of this version as described in [AI skills](../../ai-skills.md).";
  return [
    "Install the exact version as described in [installing packages](../../releases/installing-packages.md), then run the",
    "application's framework tests and live conformance before upgrading the control plane.",
  ].join("\n");
}

export function renderUpgradeGuide({ unit, from, to, date, entries, upgrades }) {
  if (typeof from !== "string" || typeof to !== "string" || typeof date !== "string" || !DATE.test(date)
      || !Array.isArray(entries) || entries.length === 0 || !Array.isArray(upgrades)
      || entries.some(({ type, text }) => !ENTRY_ORDER.includes(type) || typeof text !== "string" || text === "")
      || upgrades.some(({ name, action, text }) => typeof name !== "string" || !Object.hasOwn(ACTION_RANK, action)
        || action === "none" || typeof text !== "string" || text === "")) {
    throw new Error("Upgrade guide is invalid");
  }
  const id = unitById(unit).id;
  const action = upgradeAction(upgrades);
  const changes = ENTRY_ORDER.flatMap((type) => entries.filter((entry) => entry.type === type)
    .map(({ text }) => `- ${CHANGE_SECTION_TITLES[type]}: ${text}`));
  const steps = upgrades.length === 0
    ? ["No action is required."]
    : [...upgrades]
      .sort((left, right) => ACTION_RANK[right.action] - ACTION_RANK[left.action] || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
      .flatMap(({ name, action: stepAction, text }, index) => [...(index === 0 ? [] : [""]), `### ${stepTitle(name)} (${stepAction})`, "", text]);
  return [
    "---",
    `unit: ${id}`,
    `from: ${from}`,
    `to: ${to}`,
    `date: ${date}`,
    `action: ${action}`,
    "---",
    "",
    `# Upgrade \`${id}\` from ${from} to ${to}`,
    "",
    `What changed in \`${id}\` ${to} and what an operator must or may change when upgrading from ${from}.`,
    "Apply every guide between the deployed version and the target, oldest first, as described in",
    "[upgrade guides](../README.md).",
    "",
    "## Changes",
    "",
    ...changes,
    "",
    "## Steps",
    "",
    ...steps,
    "",
    "## Verify",
    "",
    verification(id),
    "",
  ].join("\n");
}
