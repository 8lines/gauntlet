#!/usr/bin/env node

import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { parseDocument } from "yaml";

import { CHANGE_FILE_NAME } from "./plan.mjs";
import { parseReleaseVersion } from "./release-model.mjs";
import { RELEASE_UNITS, dependencyOrder, dependentsOf, unitById } from "./units.mjs";

export const CHANGES_DIRECTORY = ".changes";
export const CHANGE_TYPES = Object.freeze(["added", "changed", "fixed", "removed", "security"]);
export const BUMPS = Object.freeze(["none", "patch", "minor", "major"]);
const RANK = Object.freeze({ none: 0, patch: 1, minor: 2, major: 3 });
const FRONT_MATTER = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u;
const MAX_CHANGE_BYTES = 16 * 1024;
const UNIT_IDS = new Set(RELEASE_UNITS.map(({ id }) => id));

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
  const document = parseDocument(match[1], { prettyErrors: false, strict: true, uniqueKeys: true });
  if (document.errors.length > 0 || document.warnings.length > 0) fail("front matter is not valid YAML");
  const data = document.toJS({ maxAliasCount: 0 });
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
    files.push(parseChangeFile(entry.name, readFileSync(path, "utf8")));
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
