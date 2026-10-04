#!/usr/bin/env node

import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { readUnitVersion } from "../release/release-model.mjs";
import { RELEASE_UNITS } from "../release/units.mjs";

const FAILURE = "Documentation manifest is invalid";
const MANIFEST = "docs/documentation-manifest.json";
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const SAFE_RELATIVE = /^(?!\/)(?!.*\\)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\u0000-\u001f\u007f]+$/u;
const JAVA_CONSUMER_GUIDES = new Set([
  "packages/java/README.md",
  "packages/java/spring-boot-starter/README.md",
]);
const JAVA_GUIDE_COORDINATES = Object.freeze({
  "packages/java/README.md": Object.freeze([
    "dev.eightlines.gauntlet:core",
    "dev.eightlines.gauntlet:spring-boot-starter",
  ]),
  "packages/java/spring-boot-starter/README.md": Object.freeze([
    "dev.eightlines.gauntlet:spring-boot-starter",
  ]),
});
const SYMFONY_CONSUMER_GUIDE = "packages/php/symfony-bundle/README.md";
const SYMFONY_GUIDE_COORDINATES = Object.freeze([
  "8lines/gauntlet-php-core",
  "8lines/gauntlet-symfony-bundle",
]);

// Every published coordinate name (npm package, Composer package, Maven coordinate, image) maps to its unit.
const UNIT_BY_COORDINATE = new Map(RELEASE_UNITS.flatMap((unit) => unit.artifacts.map((name) => [name, unit.id])));
const APPLICATION_IMAGE = "ghcr.io/8lines/gauntlet";

function failManifest() {
  throw new Error(FAILURE);
}

function compare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonicalRoot(value) {
  try {
    if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value === sep) throw new Error();
    const stat = lstatSync(value);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(value) !== value) throw new Error();
    return value;
  } catch {
    failManifest();
  }
}

function readRegular(root, path, maximumBytes = MAX_TEXT_BYTES) {
  try {
    if (typeof path !== "string" || !SAFE_RELATIVE.test(path)) throw new Error();
    const absolute = resolve(root, ...path.split("/"));
    if (absolute === root || !absolute.startsWith(`${root}${sep}`) || realpathSync(absolute) !== absolute) throw new Error();
    const stat = lstatSync(absolute, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size < 1n
        || stat.size > BigInt(maximumBytes)) throw new Error();
    const bytes = readFileSync(absolute);
    if (bytes.includes(0) || bytes.includes(13)) throw new Error();
    return bytes.toString("utf8");
  } catch {
    throw new Error(`missing or unsafe documentation file ${path}`);
  }
}

function stringList(value, { nonEmpty = false, paths = false } = {}) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0) || value.length > 512
      || value.some((item) => typeof item !== "string" || item.length === 0 || item.length > 1024
        || /[\u0000-\u001f\u007f]/u.test(item) || (paths && !SAFE_RELATIVE.test(item)))
      || new Set(value).size !== value.length) failManifest();
  return [...value];
}

function loadManifest(root) {
  let parsed;
  try {
    parsed = JSON.parse(readRegular(root, MANIFEST, 1024 * 1024));
  } catch {
    failManifest();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
      || Object.getPrototypeOf(parsed) !== Object.prototype
      || JSON.stringify(Object.keys(parsed).sort(compare))
        !== JSON.stringify(["forbiddenPhrases", "requiredFiles", "requiredPhrases", "schemaVersion"].sort(compare))
      || parsed.schemaVersion !== 1) failManifest();
  return Object.freeze({
    requiredFiles: Object.freeze(stringList(parsed.requiredFiles, { nonEmpty: true, paths: true })),
    forbiddenPhrases: Object.freeze(stringList(parsed.forbiddenPhrases)),
    requiredPhrases: Object.freeze(stringList(parsed.requiredPhrases)),
  });
}

function markdownTargets(source) {
  return [...source.matchAll(/!?\[[^\]\n]*\]\((<[^>\n]+>|[^)\s]+)(?:\s+["'][^"'\n]*["'])?\)/gu)]
    .map((match) => match[1].startsWith("<") ? match[1].slice(1, -1) : match[1]);
}

function localLinkError(root, owner, rawTarget) {
  if (rawTarget.startsWith("#") || /^(?:https?|mailto):/iu.test(rawTarget)) return undefined;
  let target;
  try {
    target = decodeURIComponent(rawTarget.split("#", 1)[0].split("?", 1)[0]);
  } catch {
    return `${owner} contains malformed local link: ${rawTarget}`;
  }
  if (target === "" || isAbsolute(target) || target.includes("\\") || /[\u0000-\u001f\u007f]/u.test(target)) {
    return `${owner} links outside the repository: ${target || rawTarget}`;
  }
  const absolute = resolve(root, dirname(owner), target);
  const relativePath = relative(root, absolute).split(sep).join("/");
  if (relativePath === ".." || relativePath.startsWith("../") || isAbsolute(relativePath)) {
    return `${owner} links outside the repository: ${target}`;
  }
  try {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error();
    const canonical = realpathSync(absolute);
    if (canonical !== root && !canonical.startsWith(`${root}${sep}`)) throw new Error();
  } catch {
    return `${owner} links to missing ${relativePath}`;
  }
  return undefined;
}

// Documented versions are compared with the unit that owns the coordinate. Without unit versions
// (synthetic fixtures) the comparison is skipped.
function expectedVersion(versions, name) {
  const unitId = UNIT_BY_COORDINATE.get(name);
  return versions === undefined || unitId === undefined ? undefined : versions.get(unitId);
}

function staleCoordinateErrors(owner, source, versions) {
  const errors = [];
  const installLines = source.split("\n").filter((line) => /\b(?:npm|pnpm|yarn)\s+(?:add|install)\b/u.test(line));
  const coordinates = installLines.flatMap((line) => [
    ...line.matchAll(/(@8lines\/gauntlet-[a-z0-9-]+)(?:@([^\s`'"]+))?/gu),
  ]);
  if (coordinates.some((match) => match[2] === undefined
      || !/^(?:\d+\.\d+\.\d+|file:|workspace:)/u.test(match[2]))) {
    errors.push(`${owner} contains unversioned Gauntlet package install`);
  }
  for (const match of coordinates) {
    if (!UNIT_BY_COORDINATE.has(match[1])) errors.push(`${owner} contains unknown Gauntlet package: ${match[1]}`);
  }
  if (versions !== undefined) {
    for (const match of coordinates) {
      const expected = expectedVersion(versions, match[1]);
      const documented = /^\d+\.\d+\.\d+$/u.exec(match[2] ?? "")?.[0];
      if (expected !== undefined && documented !== undefined && documented !== expected) {
        errors.push(`${owner} contains mismatched Gauntlet package version: ${documented}`);
      }
    }
    const imageVersion = expectedVersion(versions, APPLICATION_IMAGE);
    for (const match of source.matchAll(/ghcr\.io\/8lines\/gauntlet:(\d+\.\d+\.\d+|latest)\b/gu)) {
      if (imageVersion !== undefined && match[1] !== imageVersion) {
        errors.push(`${owner} contains mismatched Gauntlet image version: ${match[1]}`);
      }
    }
  }
  return errors;
}

function indentation(line) {
  return /^ */u.exec(line)[0].length;
}

function hasStructuredApplicationEnvironment(source) {
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^ +application:\s*(?:#.*)?$/u.test(lines[index])) continue;
    const applicationIndent = indentation(lines[index]);
    for (let child = index + 1; child < lines.length; child += 1) {
      const line = lines[child];
      if (/^\s*(?:#.*)?$/u.test(line)) continue;
      const childIndent = indentation(line);
      if (childIndent <= applicationIndent) break;
      if (!/^ +environment:\s*(?:#.*)?$/u.test(line)) continue;
      const environmentIndent = childIndent;
      let hasName = false;
      let hasKind = false;
      for (let field = child + 1; field < lines.length; field += 1) {
        const fieldLine = lines[field];
        if (/^\s*(?:#.*)?$/u.test(fieldLine)) continue;
        if (indentation(fieldLine) <= environmentIndent) break;
        if (/^ +name:\s+\S.*$/u.test(fieldLine)) hasName = true;
        if (/^ +kind:\s+\S.*$/u.test(fieldLine)) hasKind = true;
      }
      if (hasName && hasKind) return true;
    }
  }
  return false;
}

function releasedSdkGuideErrors(owner, source, versions) {
  if (versions === undefined) return [];
  const errors = [];
  const wrongVersion = (coordinates) => coordinates.some((coordinate) => {
    const expected = expectedVersion(versions, coordinate.name);
    return expected !== undefined && coordinate.version !== expected;
  });
  if (JAVA_CONSUMER_GUIDES.has(owner)) {
    const coordinates = [...source.matchAll(
      /(dev\.eightlines\.gauntlet:(?:core|spring-boot-starter)):([^\s`'"()<>\],]+)/gu,
    )].map((match) => Object.freeze({ name: match[1], version: match[2] }));
    for (const name of JAVA_GUIDE_COORDINATES[owner]) {
      if (!coordinates.some((coordinate) => coordinate.name === name)) {
        errors.push(`${owner} is missing Java consumer coordinate ${name}:${expectedVersion(versions, name)}`);
      }
    }
    if (coordinates.some((coordinate) => /snapshot/iu.test(coordinate.version))) {
      errors.push(`${owner} contains a snapshot Java consumer coordinate`);
    } else if (wrongVersion(coordinates)) {
      errors.push(`${owner} contains a non-exact Java consumer coordinate`);
    }
    if (!hasStructuredApplicationEnvironment(source)) {
      errors.push(`${owner} must document application.environment with name and kind`);
    }
  }
  if (owner === SYMFONY_CONSUMER_GUIDE) {
    const coordinates = [
      ...source.matchAll(/"(8lines\/gauntlet-(?:php-core|symfony-bundle))"\s*:\s*"([^"]+)"/gu),
      ...source.matchAll(/(8lines\/gauntlet-(?:php-core|symfony-bundle)):([^\s`'"\\]+)/gu),
    ].map((match) => Object.freeze({ name: match[1], version: match[2] }));
    for (const name of SYMFONY_GUIDE_COORDINATES) {
      if (!coordinates.some((coordinate) => coordinate.name === name)) {
        errors.push(`${owner} is missing Composer consumer coordinate ${name}:${expectedVersion(versions, name)}`);
      }
    }
    if (wrongVersion(coordinates)) {
      errors.push(`${owner} contains a non-exact Composer consumer coordinate`);
    }
    if (!hasStructuredApplicationEnvironment(source)) {
      errors.push(`${owner} must document application.environment with name and kind`);
    }
  }
  return errors;
}

// Reads every release unit's own version; unreadable units are simply not compared.
function loadUnitVersions(root) {
  const versions = new Map();
  for (const { id } of RELEASE_UNITS) {
    try {
      versions.set(id, readUnitVersion(root, id));
    } catch {
      // A unit without a readable version file is not compared.
    }
  }
  if (versions.size === 0) return undefined;
  return versions;
}

export async function checkDocumentation({ root: rawRoot }) {
  const root = canonicalRoot(rawRoot);
  const manifest = loadManifest(root);
  const errors = [];
  const documents = new Map();
  for (const path of manifest.requiredFiles) {
    try {
      documents.set(path, readRegular(root, path));
    } catch {
      errors.push(`missing required file ${path}`);
    }
  }
  const versions = loadUnitVersions(root);
  const corpus = [...documents.values()].join("\n");
  for (const phrase of manifest.requiredPhrases) {
    if (!corpus.includes(phrase)) errors.push(`required phrase is absent: ${phrase}`);
  }
  for (const [owner, source] of documents) {
    for (const phrase of manifest.forbiddenPhrases) {
      if (source.includes(phrase)) errors.push(`${owner} contains forbidden phrase: ${phrase}`);
    }
    errors.push(...staleCoordinateErrors(owner, source, versions));
    errors.push(...releasedSdkGuideErrors(owner, source, versions));
    for (const target of markdownTargets(source)) {
      const error = localLinkError(root, owner, target);
      if (error !== undefined) errors.push(error);
    }
  }
  return Object.freeze({ errors: Object.freeze([...new Set(errors)].sort(compare)) });
}

async function main() {
  const root = realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
  const result = await checkDocumentation({ root });
  if (result.errors.length !== 0) {
    for (const error of result.errors) process.stderr.write(`${error}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('{"ok":true}\n');
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.length !== 2) {
    process.stderr.write("Usage: node scripts/docs/check-docs.mjs\n");
    process.exitCode = 2;
  } else {
    await main();
  }
}
