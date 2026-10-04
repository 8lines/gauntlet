import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

import { RELEASE_TEXT_FILES, VERSION_LOCATIONS, readReleaseTextSpans } from "./release-model.mjs";

const VERSION = String.raw`(\d+\.\d+\.\d+)`;
const MAX_SCANNED_BYTES = 4 * 1024 * 1024;

// Every form in which a released Gauntlet coordinate is pinned to an exact version.
export const PIN_PATTERNS = Object.freeze([
  String.raw`@8lines/gauntlet-[a-z0-9-]+@${VERSION}`,
  String.raw`8lines/gauntlet-(?:php-core|symfony-bundle)(?::|"\s*:\s*"\^?)${VERSION}`,
  String.raw`dev\.eightlines\.gauntlet:(?:core|spring-boot-starter):${VERSION}`,
  String.raw`ghcr\.io/8lines/gauntlet:${VERSION}`,
  String.raw`charts/gauntlet --version ${VERSION}`,
  String.raw`(?<![\w-])gauntlet-${VERSION}\.tgz`,
  String.raw`gauntlet-skills-${VERSION}`,
  String.raw`8lines-gauntlet-[a-z0-9-]+-${VERSION}\.tgz`,
]);

// Release history, frozen evaluation records, change prose, tests and lockfiles keep historical versions.
const UNSCANNED = Object.freeze([
  /(?:^|\/)CHANGELOG\.md$/u,
  /^docs\/superpowers\//u,
  /^skill-evals\//u,
  /^\.changes\//u,
  /(?:^|\/)(?:test|tests|__tests__)\//u,
  /\.test\.[cm]?[jt]sx?$/u,
  /(?:^|\/)(?:pnpm-lock\.yaml|composer\.lock|gradle\.lockfile)$/u,
]);
// Structured manifests are validated value by value by version.mjs --check. This includes
// examples/symfony/composer.json: its constraints on the released PHP packages are slots, while its
// own top-level "version" is not a released coordinate (the example is a never-published
// `type: project`, and Composer folds that field into the lock content-hash, so no unit may drive it).
const STRUCTURED = new Set(VERSION_LOCATIONS.filter(({ type }) => type !== "release-text").map(({ path }) => path));
const TEXT_FILES = new Set(RELEASE_TEXT_FILES.map(({ path }) => path));

export function isScannedPath(path) {
  return typeof path === "string" && !STRUCTURED.has(path) && !UNSCANNED.some((pattern) => pattern.test(path));
}

function readText(root, path) {
  const absolute = resolve(root, ...path.split("/"));
  if (!absolute.startsWith(`${root}${sep}`)) return null;
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > MAX_SCANNED_BYTES) return null;
  const bytes = readFileSync(absolute);
  return bytes.includes(0) ? null : bytes.toString("utf8");
}

export function findUnboundPins(root, paths) {
  const problems = [];
  for (const path of [...paths].sort()) {
    if (!isScannedPath(path)) continue;
    const source = readText(root, path);
    if (source === null) continue;
    let slots = [];
    if (TEXT_FILES.has(path)) {
      try {
        slots = readReleaseTextSpans(root, path);
      } catch {
        problems.push(`${path}: release references are missing or malformed`);
        continue;
      }
    }
    for (const pattern of PIN_PATTERNS) {
      for (const match of source.matchAll(new RegExp(pattern, "dgu"))) {
        const [start, end] = match.indices[1];
        if (slots.some((slot) => slot.start === start && slot.end === end)) continue;
        problems.push(`${path}:${source.slice(0, start).split("\n").length}: ${match[0]} is not a release version slot`);
      }
    }
  }
  return Object.freeze(problems);
}

export function listTrackedFiles(root) {
  const output = execFileSync("git", ["-C", root, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
    env: {
      PATH: process.env.PATH, HOME: "/dev/null", LANG: "C", LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
  return Object.freeze(output.split("\0").filter((path) => path !== ""));
}
