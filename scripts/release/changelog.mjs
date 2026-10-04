import { posix } from "node:path";

import { unitById } from "./units.mjs";

const UNRELEASED = "## Unreleased";
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
export const CHANGE_SECTION_TITLES = Object.freeze({
  added: "Added", changed: "Changed", removed: "Removed", fixed: "Fixed", security: "Security",
});
// Keep a Changelog order (Deprecated is not a change type).
const SECTION_ORDER = Object.freeze(["added", "changed", "removed", "fixed", "security"]);

export function changelogPath(unitId) {
  const unit = unitById(unitId);
  return unit.id === "gauntlet" ? "CHANGELOG.md" : `${posix.dirname(unit.version.path)}/CHANGELOG.md`;
}

export function changelogSection(source, version) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line === `## [${version}]` || line.startsWith(`## [${version}] `));
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  const body = lines.slice(start + 1, end < 0 ? lines.length : end).join("\n").trim();
  return body === "" ? null : body;
}

export function renderChangelogSection({ version, date, entries }) {
  if (typeof version !== "string" || typeof date !== "string" || !DATE.test(date) || !Array.isArray(entries)
      || entries.length === 0 || entries.some(({ type, text }) => !SECTION_ORDER.includes(type) || typeof text !== "string" || text === "")) {
    throw new Error("Changelog section is invalid");
  }
  const lines = [`## [${version}] - ${date}`];
  for (const type of SECTION_ORDER) {
    const texts = entries.filter((entry) => entry.type === type).map(({ text }) => text);
    if (texts.length > 0) lines.push("", `### ${CHANGE_SECTION_TITLES[type]}`, "", ...texts.map((text) => `- ${text}`));
  }
  return `${lines.join("\n")}\n`;
}

export function insertChangelogSection(source, section) {
  const lines = source.split("\n");
  const index = lines.indexOf(UNRELEASED);
  if (index < 0) throw new Error("Changelog has no ## Unreleased heading");
  const next = lines.findIndex((line, position) => position > index && line.startsWith("## "));
  if (lines.slice(index + 1, next < 0 ? lines.length : next).join("\n").trim() !== "") {
    throw new Error("Changelog has entries under ## Unreleased; move them into change files");
  }
  const version = /^## \[([^\]]+)\]/u.exec(section)?.[1];
  if (version === undefined) throw new Error("Changelog section is invalid");
  if (lines.some((line) => line === `## [${version}]` || line.startsWith(`## [${version}] `))) {
    throw new Error(`Changelog already has a section for ${version}`);
  }
  const head = lines.slice(0, index + 1).join("\n");
  const tail = next < 0 ? "" : lines.slice(next).join("\n");
  return `${head}\n\n${section}${tail === "" ? "" : `\n${tail}`}`;
}

export function newUnitChangelog(unitId) {
  const unit = unitById(unitId);
  if (unit.id === "gauntlet") throw new Error("The gauntlet changelog is the root CHANGELOG.md");
  const path = changelogPath(unit.id);
  return [
    `# Changelog: \`${unit.id}\``,
    "",
    `All notable changes to ${unit.artifacts.map((name) => `\`${name}\``).join(", ")} are recorded here in the`,
    "[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. Versions follow",
    "[Semantic Versioning](https://semver.org/spec/v2.0.0.html); before 1.0 a breaking change is a minor",
    "release. Released versions are immutable; a correction is a new version.",
    "",
    "Releases up to 0.1.8 were published together with the application and are recorded in the",
    `[root changelog](${posix.relative(posix.dirname(path), "CHANGELOG.md")}).`,
    "",
    UNRELEASED,
    "",
  ].join("\n");
}
