#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseDocument } from "yaml";

import { CHANGE_FILE_NAME, RELEASE_PLAN_PATH, readReleasePlan } from "./plan.mjs";
import { parseReleaseVersion } from "./release-model.mjs";
import { RELEASE_UNITS, dependencyOrder, dependentsOf, unitById } from "./units.mjs";

export const CHANGES_DIRECTORY = ".changes";
export const CHANGE_TYPES = Object.freeze(["added", "changed", "fixed", "removed", "security"]);
export const BUMPS = Object.freeze(["none", "patch", "minor", "major"]);
const RANK = Object.freeze({ none: 0, patch: 1, minor: 2, major: 3 });
const FRONT_MATTER = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u;
const MAX_CHANGE_BYTES = 16 * 1024;
const UNIT_IDS = new Set(RELEASE_UNITS.map(({ id }) => id));

const UTF8 = new TextDecoder("utf-8", { fatal: true });

export function readChangeSource(name, path) {
  try {
    return UTF8.decode(readFileSync(path));
  } catch (error) {
    if (error instanceof TypeError) throw new Error(`Change file ${name}: must be LF-only UTF-8 text`);
    throw error;
  }
}

export function parseChangeFile(name, source) {
  if (typeof name !== "string" || !CHANGE_FILE_NAME.test(name)) {
    throw new Error(`Change file name ${String(name)} must match ${CHANGE_FILE_NAME.source}`);
  }
  const fail = (reason) => {
    throw new Error(`Change file ${name}: ${reason}`);
  };
  if (typeof source !== "string" || source.includes("\r") || source.includes("\0")) fail("must be LF-only UTF-8 text");
  const match = FRONT_MATTER.exec(source);
  if (match === null) fail("must start with --- front matter");
  let data;
  try {
    const document = parseDocument(match[1], { prettyErrors: false, strict: true, uniqueKeys: true });
    if (document.errors.length > 0 || document.warnings.length > 0) throw new Error("invalid YAML");
    data = document.toJS({ maxAliasCount: 0 });
  } catch {
    fail("front matter is not valid YAML");
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)
      || Object.keys(data).sort().join(",") !== "type,units") fail("front matter must contain exactly type and units");
  if (!CHANGE_TYPES.includes(data.type)) fail(`type must be one of ${CHANGE_TYPES.join(", ")}`);
  const { units } = data;
  if (units === null || typeof units !== "object" || Array.isArray(units) || Object.keys(units).length === 0) {
    fail("units must map at least one release unit to a bump");
  }
  for (const [id, bump] of Object.entries(units)) {
    if (!UNIT_IDS.has(id)) fail(`unknown release unit ${id}`);
    if (!BUMPS.includes(bump)) fail(`unit ${id} bump must be one of ${BUMPS.join(", ")}`);
  }
  const body = match[2].trim();
  if (body === "") fail("the body must hold the changelog sentence");
  if (/\n\s*\n/u.test(body)) fail("the body must be one paragraph");
  if (body.includes("—")) fail("the body must not contain an em dash");
  if (!/^[A-Z`]/u.test(body)) fail("the body must start in sentence case");
  if (body.length > 1000) fail("the body is longer than 1000 characters");
  return Object.freeze({
    name,
    type: data.type,
    units: Object.freeze(Object.fromEntries(RELEASE_UNITS.filter(({ id }) => Object.hasOwn(units, id)).map(({ id }) => [id, units[id]]))),
    body: body.split("\n").map((line) => line.trim()).join(" "),
  });
}

export function readChangeFiles(root) {
  const directory = resolve(root, CHANGES_DIRECTORY);
  let entries;
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${CHANGES_DIRECTORY} must be a directory`);
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze([]);
    throw error;
  }
  const files = [];
  for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
    const label = `${CHANGES_DIRECTORY}/${entry.name}`;
    if (!entry.isFile() || !CHANGE_FILE_NAME.test(entry.name)) {
      throw new Error(`${label} is not a change file (a regular lowercase-name.md file)`);
    }
    const path = resolve(directory, entry.name);
    const stat = lstatSync(path);
    if (stat.nlink !== 1 || stat.size > MAX_CHANGE_BYTES) throw new Error(`${label} is not a change file (a regular lowercase-name.md file)`);
    files.push(parseChangeFile(entry.name, readChangeSource(entry.name, path)));
  }
  return Object.freeze(files);
}

export function nextVersion(version, bump) {
  const [major, minor, patch] = parseReleaseVersion(`${version}\n`).split(".").map(BigInt);
  if (bump === "patch") return `${major}.${minor}.${patch + 1n}`;
  if (bump === "minor") return `${major}.${minor + 1n}.0`;
  if (bump === "major") return `${major + 1n}.0.0`;
  throw new Error(`Unknown bump ${bump}`);
}

export function computeRelease({ versions, changes }) {
  if (changes.length === 0) throw new Error("Release preparation found no change files in .changes");
  const bumps = new Map();
  const own = new Map();
  for (const change of changes) {
    for (const [id, bump] of Object.entries(change.units)) {
      if (bump === "none") continue;
      if (RANK[bump] > RANK[bumps.get(id) ?? "none"]) bumps.set(id, bump);
      own.set(id, [...(own.get(id) ?? []), Object.freeze({ type: change.type, text: change.body })]);
    }
  }
  if (bumps.size === 0) {
    throw new Error("Release preparation found no change file that releases a unit (every change file says none)");
  }
  for (const id of [...bumps.keys()]) {
    for (const dependent of dependentsOf(id)) if (!bumps.has(dependent)) bumps.set(dependent, "patch");
  }
  const targets = new Map([...bumps].map(([id, bump]) => {
    const from = versions.get(id);
    if (typeof from !== "string") throw new Error(`Release unit ${id} has no version`);
    return [id, nextVersion(from, bump)];
  }));
  const units = dependencyOrder([...bumps.keys()]).map((id) => {
    const updates = dependencyOrder(unitById(id).dependsOn.filter((dependency) => targets.has(dependency)))
      .map((dependency) => Object.freeze({ type: "changed", text: `Updated \`${dependency}\` to ${targets.get(dependency)}.` }));
    return Object.freeze({
      id,
      from: versions.get(id),
      to: targets.get(id),
      bump: bumps.get(id),
      cascaded: !own.has(id),
      entries: Object.freeze([...(own.get(id) ?? []), ...updates]),
    });
  });
  return Object.freeze({ units: Object.freeze(units), consumed: Object.freeze(changes.map(({ name }) => name).sort()) });
}

const ROOT = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const USAGE = "Usage: changes.mjs --check [--base REV]";
const REVISION = /^(?!-)[A-Za-z0-9._/^~-]{1,200}$/u;
const UNRELEASED_PATHS = Object.freeze([
  /(?:^|\/)(?:README|CHANGELOG)\.md$/u,
  /(?:^|\/)(?:test|tests|__tests__)\//u,
  /\.(?:test|spec)\.[cm]?[jt]sx?$/u,
]);

export function isOwnedBy(unit, path) {
  if (UNRELEASED_PATHS.some((pattern) => pattern.test(path))) return false;
  return unit.ownedPaths.some((owned) => (owned.endsWith("/**") ? path.startsWith(owned.slice(0, -2)) : path === owned));
}

export function parseNameStatus(output) {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 2 !== 0) throw new Error("git diff output is malformed");
  const changes = [];
  for (let index = 0; index < fields.length; index += 2) {
    if (!/^[ADMT]$/u.test(fields[index])) throw new Error(`Unsupported change status ${fields[index]}`);
    changes.push(Object.freeze({ status: fields[index], path: fields[index + 1] }));
  }
  return Object.freeze(changes);
}

export function evaluateChangeCoverage({ diff, changeFiles, plan = null }) {
  const touched = new Map();
  for (const unit of RELEASE_UNITS) {
    const owned = diff.find(({ path }) => isOwnedBy(unit, path));
    if (owned !== undefined) touched.set(unit.id, owned.path);
  }
  const covered = new Set(changeFiles.flatMap(({ units }) => Object.keys(units)));
  for (const { id } of plan?.units ?? []) covered.add(id);
  const problems = [...touched].filter(([id]) => !covered.has(id)).map(([id, path]) =>
    `${id}: ${path} changed without a change file naming ${id}; add .changes/<name>.md (use "none" when no release is needed)`);
  return Object.freeze({
    touched: Object.freeze([...touched.keys()]),
    covered: Object.freeze([...dependencyOrder([...covered])]),
    problems: Object.freeze(problems),
  });
}

export function parseChangesArguments(argv) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== "string")) throw new TypeError(USAGE);
  if (argv.length === 1 && argv[0] === "--check") return Object.freeze({ base: "origin/main" });
  if (argv.length === 3 && argv[0] === "--check" && argv[1] === "--base" && REVISION.test(argv[2])) {
    return Object.freeze({ base: argv[2] });
  }
  throw new TypeError(USAGE);
}

function defaultGit(root) {
  return (args) => {
    const result = spawnSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 60_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME ?? "/dev/null", LANG: "C", LC_ALL: "C" },
    });
    return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
}

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

export function runChangesCli(argv, { root = ROOT, git = defaultGit(root) } = {}) {
  let options;
  try {
    options = parseChangesArguments(argv);
  } catch {
    return { exitCode: 2, stdout: "", stderr: jsonLine({ error: { code: "INVALID_ARGUMENTS", message: USAGE }, ok: false }) };
  }
  try {
    const mergeBase = git(["merge-base", options.base, "HEAD"]);
    const base = mergeBase.stdout.trim();
    if (mergeBase.status !== 0 || !/^[0-9a-f]{40}$/u.test(base)) {
      throw new Error(`Cannot find the merge base of ${options.base} and HEAD; fetch the base branch first`);
    }
    const listing = git(["diff", "--name-status", "-z", "--no-renames", base, "HEAD"]);
    if (listing.status !== 0) throw new Error("git diff failed");
    const diff = parseNameStatus(listing.stdout);
    const problems = [];
    try {
      readChangeFiles(root);
    } catch (error) {
      problems.push(error.message);
    }
    const changeFiles = [];
    for (const { status, path } of diff) {
      if (status === "D" || !path.startsWith(`${CHANGES_DIRECTORY}/`) || path.slice(CHANGES_DIRECTORY.length + 1).includes("/")) continue;
      const name = path.slice(CHANGES_DIRECTORY.length + 1);
      try {
        changeFiles.push(parseChangeFile(name, readChangeSource(name, resolve(root, CHANGES_DIRECTORY, name))));
      } catch (error) {
        if (!problems.includes(error.message)) problems.push(error.message);
      }
    }
    const planChanged = diff.some(({ status, path }) => path === RELEASE_PLAN_PATH && status !== "D");
    const coverage = evaluateChangeCoverage({ diff, changeFiles, plan: planChanged ? readReleasePlan(root) : null });
    problems.push(...coverage.problems);
    const ok = problems.length === 0;
    return {
      exitCode: ok ? 0 : 1,
      stdout: jsonLine({ base, command: "check", covered: coverage.covered, ok, problems, touched: coverage.touched }),
      stderr: "",
    };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: jsonLine({ error: { code: "CHANGES_CHECK_FAILED", message: error instanceof Error ? error.message : String(error) }, ok: false }),
    };
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runChangesCli(process.argv.slice(2));
  if (result.stdout !== "") process.stdout.write(result.stdout);
  if (result.stderr !== "") process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
