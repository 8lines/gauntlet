import { Buffer } from "node:buffer";
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { relative, resolve, sep } from "node:path";
import { TextDecoder, types as utilTypes } from "node:util";

import { isScalar, parseDocument } from "yaml";

import { RELEASE_UNITS, unitById } from "./units.mjs";

const VERSION_ERROR = "Release version must be an exact stable ASCII semantic version followed by one LF";
const STABLE_VERSION_BYTES = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\n$/;
const MAX_VERSION_BYTES = 64;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function deeplyFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deeplyFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const releaseArtifacts = {
  npm: [
    { name: "@8lines/gauntlet-protocol", directory: "packages/protocol", registry: "https://registry.npmjs.org/" },
    { name: "@8lines/gauntlet-dashboard-client", directory: "packages/dashboard-client", registry: "https://registry.npmjs.org/" },
    { name: "@8lines/gauntlet-typescript-core", directory: "packages/typescript/core", registry: "https://registry.npmjs.org/" },
    { name: "@8lines/gauntlet-typescript-node", directory: "packages/typescript/node", registry: "https://registry.npmjs.org/" },
    { name: "@8lines/gauntlet-next-adapter", directory: "packages/typescript/next", registry: "https://registry.npmjs.org/" },
    { name: "@8lines/gauntlet-conformance-runner", directory: "conformance/runner", registry: "https://registry.npmjs.org/" },
    { name: "@8lines/gauntlet-widget", directory: "packages/widget", registry: "https://registry.npmjs.org/" },
  ],
  composer: [
    {
      name: "8lines/gauntlet-php-core",
      directory: "packages/php/core",
      repository: "8lines/gauntlet-php-core",
      repositoryUrl: "https://github.com/8lines/gauntlet-php-core.git",
    },
    {
      name: "8lines/gauntlet-symfony-bundle",
      directory: "packages/php/symfony-bundle",
      repository: "8lines/gauntlet-symfony-bundle",
      repositoryUrl: "https://github.com/8lines/gauntlet-symfony-bundle.git",
    },
  ],
  maven: [
    {
      name: "dev.eightlines.gauntlet:core",
      directory: "packages/java/core",
      project: ":core",
      repository: "https://maven.pkg.github.com/8lines/gauntlet",
    },
    {
      name: "dev.eightlines.gauntlet:spring-boot-starter",
      directory: "packages/java/spring-boot-starter",
      project: ":spring-boot-starter",
      repository: "https://maven.pkg.github.com/8lines/gauntlet",
    },
  ],
  image: {
    name: "ghcr.io/8lines/gauntlet",
    context: ".",
    runtimeTarget: "runtime",
  },
  compose: {
    name: "gauntlet-compose",
    directory: "deploy/compose",
  },
  chart: {
    name: "gauntlet",
    directory: "deploy/helm/gauntlet",
    repository: "oci://ghcr.io/8lines/charts",
  },
  skills: {
    name: "gauntlet-skills",
    directory: "skills",
  },
};

function assertFixedRelativePath(value, { allowDot = false } = {}) {
  if (typeof value !== "string" || value === "" || value.startsWith("/") || value.includes("\\")) {
    throw new Error("Release catalog contains an invalid relative path");
  }
  if (value === ".") {
    if (allowDot) return;
    throw new Error("Release catalog contains an invalid relative path");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("Release catalog contains an invalid relative path");
  }
}

function assertReleaseCatalog(catalog) {
  const expectedKeys = ["npm", "composer", "maven", "image", "compose", "chart", "skills"];
  if (Object.keys(catalog).join("\0") !== expectedKeys.join("\0")) {
    throw new Error("Release catalog has an invalid shape");
  }
  const records = [
    ...catalog.npm,
    ...catalog.composer,
    ...catalog.maven,
    catalog.image,
    catalog.compose,
    catalog.chart,
    catalog.skills,
  ];
  if (catalog.npm.length !== 7 || catalog.composer.length !== 2 || catalog.maven.length !== 2 || records.length !== 15) {
    throw new Error("Release catalog must contain exactly fifteen artifacts");
  }
  if (new Set(records.map(({ name }) => name)).size !== records.length) {
    throw new Error("Release catalog contains a duplicate artifact identity");
  }
  const exactKeySets = [
    ...catalog.npm.map((record) => [record, ["name", "directory", "registry"]]),
    ...catalog.composer.map((record) => [record, ["name", "directory", "repository", "repositoryUrl"]]),
    ...catalog.maven.map((record) => [record, ["name", "directory", "project", "repository"]]),
    [catalog.image, ["name", "context", "runtimeTarget"]],
    [catalog.compose, ["name", "directory"]],
    [catalog.chart, ["name", "directory", "repository"]],
    [catalog.skills, ["name", "directory"]],
  ];
  for (const [record, keys] of exactKeySets) {
    if (Object.keys(record).join("\0") !== keys.join("\0")) throw new Error("Release catalog record has an invalid shape");
  }
  for (const record of [...catalog.npm, ...catalog.composer, ...catalog.maven, catalog.compose, catalog.chart, catalog.skills]) {
    assertFixedRelativePath(record.directory);
  }
  assertFixedRelativePath(catalog.image.context, { allowDot: true });
  const paths = [
    ...catalog.npm.map(({ directory }) => directory),
    ...catalog.composer.map(({ directory }) => directory),
    ...catalog.maven.map(({ directory }) => directory),
    catalog.image.context,
    catalog.compose.directory,
    catalog.chart.directory,
    catalog.skills.directory,
  ];
  if (new Set(paths).size !== paths.length) throw new Error("Release catalog contains a duplicate artifact path");
  if (new Set(catalog.composer.map(({ repository }) => repository)).size !== catalog.composer.length) {
    throw new Error("Release catalog contains a duplicate Composer destination");
  }
  if (new Set(catalog.maven.map(({ name }) => name)).size !== catalog.maven.length) {
    throw new Error("Release catalog contains a duplicate Maven coordinate");
  }
}

assertReleaseCatalog(releaseArtifacts);
export const RELEASE_ARTIFACTS = deeplyFreeze(releaseArtifacts);
export const RELEASE_STAGE_ARTIFACT_COUNT = 19;

export function parseReleaseVersion(raw) {
  let bytes;
  if (typeof raw === "string") bytes = Buffer.from(raw, "utf8");
  else if (Buffer.isBuffer(raw)) bytes = raw;
  else throw new Error(VERSION_ERROR);

  if (
    bytes.length === 0 ||
    bytes.length > MAX_VERSION_BYTES ||
    bytes.some((byte) => byte > 0x7f) ||
    !STABLE_VERSION_BYTES.test(bytes.toString("ascii"))
  ) {
    throw new Error(VERSION_ERROR);
  }
  return bytes.subarray(0, -1).toString("ascii");
}

function fixedPath(root, relativePath) {
  if (typeof root !== "string" || root.length === 0) throw new Error("Repository root is invalid");
  assertFixedRelativePath(relativePath);
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(absoluteRoot, relativePath);
  if (!absolutePath.startsWith(`${absoluteRoot}${sep}`)) throw new Error("Release path escapes the repository root");
  return absolutePath;
}

function readManifest(root, relativePath) {
  const absolutePath = fixedPath(root, relativePath);
  const stat = lstatSync(absolutePath, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > BigInt(MAX_MANIFEST_BYTES)) {
    const error = new Error("Manifest is missing or unsafe");
    error.code = "UNSAFE_MANIFEST";
    throw error;
  }
  const bytes = readFileSync(absolutePath);
  if (bytes.includes(0x0d) || bytes.includes(0x00)) throw new Error("Manifest is malformed");
  return { absolutePath, bytes, source: UTF8_DECODER.decode(bytes), stat };
}

function malformedJson() {
  return new Error("Manifest JSON is malformed");
}

function parseJsonSyntax(source) {
  let offset = 0;

  function skipWhitespace() {
    while (offset < source.length && /[\x20\x09\x0a]/.test(source[offset])) offset += 1;
  }

  function parseStringNode() {
    const start = offset;
    if (source[offset] !== '"') throw malformedJson();
    offset += 1;
    while (offset < source.length) {
      const character = source[offset];
      if (character === '"') {
        offset += 1;
        const token = source.slice(start, offset);
        let value;
        try {
          value = JSON.parse(token);
        } catch {
          throw malformedJson();
        }
        return { type: "string", value, start, end: offset };
      }
      if (character === "\\") {
        offset += 1;
        if (offset >= source.length) throw malformedJson();
        if (source[offset] === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(source.slice(offset + 1, offset + 5))) throw malformedJson();
          offset += 5;
          continue;
        }
        if (!'["\\/bfnrt]'.includes(source[offset])) throw malformedJson();
        offset += 1;
        continue;
      }
      if (character.charCodeAt(0) < 0x20) throw malformedJson();
      offset += 1;
    }
    throw malformedJson();
  }

  function parseValue(depth = 0) {
    if (depth > 64) throw malformedJson();
    skipWhitespace();
    const start = offset;
    if (source[offset] === '"') return parseStringNode();
    if (source[offset] === "{") {
      offset += 1;
      const properties = new Map();
      skipWhitespace();
      if (source[offset] === "}") {
        offset += 1;
        return { type: "object", properties, start, end: offset };
      }
      while (offset < source.length) {
        skipWhitespace();
        const key = parseStringNode();
        if (properties.has(key.value)) throw malformedJson();
        skipWhitespace();
        if (source[offset] !== ":") throw malformedJson();
        offset += 1;
        const value = parseValue(depth + 1);
        properties.set(key.value, value);
        skipWhitespace();
        if (source[offset] === "}") {
          offset += 1;
          return { type: "object", properties, start, end: offset };
        }
        if (source[offset] !== ",") throw malformedJson();
        offset += 1;
      }
      throw malformedJson();
    }
    if (source[offset] === "[") {
      offset += 1;
      const items = [];
      skipWhitespace();
      if (source[offset] === "]") {
        offset += 1;
        return { type: "array", items, start, end: offset };
      }
      while (offset < source.length) {
        items.push(parseValue(depth + 1));
        skipWhitespace();
        if (source[offset] === "]") {
          offset += 1;
          return { type: "array", items, start, end: offset };
        }
        if (source[offset] !== ",") throw malformedJson();
        offset += 1;
      }
      throw malformedJson();
    }

    const remainder = source.slice(offset);
    const token = /^(?:-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null)/.exec(remainder)?.[0];
    if (token === undefined) throw malformedJson();
    offset += token.length;
    let value;
    try {
      value = JSON.parse(token);
    } catch {
      throw malformedJson();
    }
    return { type: value === null ? "null" : typeof value, value, start, end: offset };
  }

  const root = parseValue();
  skipWhitespace();
  if (offset !== source.length) throw malformedJson();
  return root;
}

function jsonNodeAt(root, keyPath) {
  let node = root;
  for (const key of keyPath) {
    if (node.type !== "object" || !node.properties.has(key)) return undefined;
    node = node.properties.get(key);
  }
  return node;
}

function parseJsonManifest(root, relativePath) {
  const manifest = readManifest(root, relativePath);
  const document = parseJsonSyntax(manifest.source);
  if (document.type !== "object") throw malformedJson();
  return { ...manifest, document };
}

function parseYamlManifest(root, relativePath) {
  const manifest = readManifest(root, relativePath);
  const document = parseDocument(manifest.source, {
    keepSourceTokens: true,
    maxAliasCount: 0,
    prettyErrors: false,
    uniqueKeys: true,
  });
  if (document.errors.length > 0 || document.contents === null) throw new Error("Manifest YAML is malformed");
  return { ...manifest, document };
}

function yamlScalarAt(document, keyPath) {
  const node = document.getIn(keyPath, true);
  if (!isScalar(node)) return { type: "missing", value: undefined, node };
  return { type: typeof node.value, value: node.value, node };
}

function parseComposeEnvironment(root) {
  const manifest = readManifest(root, "deploy/compose/.env.example");
  const assignments = [];
  for (const line of manifest.source.split("\n")) {
    if (line.startsWith("GAUNTLET_IMAGE=")) assignments.push(line.slice("GAUNTLET_IMAGE=".length));
  }
  if (assignments.length !== 1) throw new Error("Compose environment is malformed");
  return { ...manifest, image: assignments[0] };
}

function hasGradleVersionContract(source) {
  const requiredFragments = [
    "fun projectReleaseVersion(",
    "versionFile.readBytes()",
    "bytes.size in 6..64",
    "bytes.all { it.toInt() in 0..127 }",
    "StandardCharsets.US_ASCII",
    '"""^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\n$"""',
    'record.removeSuffix("\\n")',
    'group = "dev.eightlines.gauntlet"',
    'projectReleaseVersion(project.file("VERSION"))',
  ];
  return requiredFragments.every((fragment) => source.includes(fragment)) && !source.includes("SNAPSHOT") && !/version\s*=\s*"/.test(source);
}

function pushJsonChecks(mismatches, root, { path, name, unit, version, constraint }) {
  let manifest;
  try {
    manifest = parseJsonManifest(root, path);
  } catch (error) {
    mismatches.push(`${path}: ${error?.code === "ENOENT" || error?.code === "UNSAFE_MANIFEST" ? "manifest is missing or unsafe" : "manifest is malformed"}`);
    return;
  }
  const nameNode = jsonNodeAt(manifest.document, ["name"]);
  if (nameNode?.type !== "string" || nameNode.value !== name) mismatches.push(`${path}: name must equal ${name}`);
  const versionNode = jsonNodeAt(manifest.document, ["version"]);
  if (versionNode?.type !== "string") mismatches.push(`${path}: version must be a string`);
  else if (version !== undefined && versionNode.value !== version) mismatches.push(`${path}: version must equal ${unit} ${version}`);
  else if (version === undefined && unitById(unit).version.path === path) {
    mismatches.push(`${path}: version must be a stable release version`);
  }
  if (constraint !== undefined) {
    const constraintNode = jsonNodeAt(manifest.document, ["require", "8lines/gauntlet-php-core"]);
    if (constraintNode?.type !== "string" || constraintNode.value !== `^${constraint}`) {
      mismatches.push(`${path}: require.8lines/gauntlet-php-core must equal ^${constraint}`);
    }
  }
}

// Every JSON manifest that carries its own version, bound to the release unit that owns it.
const ARTIFACT_UNIT = new Map(RELEASE_UNITS.flatMap(({ id, artifacts }) => artifacts.map((artifact) => [artifact, id])));

function unitForArtifact(name) {
  const id = ARTIFACT_UNIT.get(name);
  if (id === undefined) throw new Error("Release artifact has no release unit");
  return id;
}

const RELEASE_JSON_MANIFESTS = deeplyFreeze([
  ...RELEASE_ARTIFACTS.npm.map(({ name, directory }) => ({ path: `${directory}/package.json`, name, unit: unitForArtifact(name) })),
  { path: "apps/dashboard/package.json", name: "@8lines/gauntlet-dashboard", unit: "gauntlet" },
  { path: "apps/server/package.json", name: "@8lines/gauntlet-server", unit: "gauntlet" },
  { path: "packages/php/core/composer.json", name: "8lines/gauntlet-php-core", unit: "php-core" },
  {
    path: "packages/php/symfony-bundle/composer.json",
    name: "8lines/gauntlet-symfony-bundle",
    unit: "symfony-bundle",
    constraintUnit: "php-core",
  },
]);

const RELEASE_CONSUMER_JSON_FILES = deeplyFreeze([
  {
    path: "tests/consumers/php-core/composer.json",
    keyPaths: [{ keyPath: ["require", "8lines/gauntlet-php-core"], unit: "php-core" }],
  },
  {
    path: "tests/consumers/php-symfony/composer.json",
    keyPaths: [
      { keyPath: ["require", "8lines/gauntlet-php-core"], unit: "php-core" },
      { keyPath: ["require", "8lines/gauntlet-symfony-bundle"], unit: "symfony-bundle" },
    ],
  },
]);

function pushConsumerJsonChecks(mismatches, root, { path, keyPaths }, versions) {
  let manifest;
  try {
    manifest = parseJsonManifest(root, path);
  } catch {
    mismatches.push(`${path}: release references are missing or malformed`);
    return;
  }
  for (const { keyPath, unit } of keyPaths) {
    const version = versions.get(unit);
    if (version === undefined) continue;
    const node = jsonNodeAt(manifest.document, keyPath);
    if (node?.type !== "string" || node.value !== version) {
      mismatches.push(`${path}: ${keyPath.join(".")} must equal ${unit} ${version}`);
    }
  }
}

const RELEASE_TEXT_FILES = deeplyFreeze([
  {
    path: "tests/consumers/java/build.gradle.kts",
    slots: [{ unit: "spring-boot-starter", prefix: "implementation(\"dev.eightlines.gauntlet:spring-boot-starter:", suffix: "\")" }],
  },
  {
    path: "tests/consumers/java/gradle.lockfile",
    slots: [
      { unit: "java-core", prefix: "dev.eightlines.gauntlet:core:", suffix: "=" },
      { unit: "spring-boot-starter", prefix: "dev.eightlines.gauntlet:spring-boot-starter:", suffix: "=" },
    ],
  },
  {
    path: "skills/gauntlet-app-integration/SKILL.md",
    slots: [{ unit: "skills", prefix: "Consume exact `", suffix: "` artifacts;" }],
  },
  {
    path: "skills/gauntlet-app-integration/references/node.md",
    slots: [
      { unit: "protocol", prefix: "@8lines/gauntlet-protocol@", suffix: " \\\n" },
      { unit: "typescript-core", prefix: "@8lines/gauntlet-typescript-core@", suffix: " \\\n" },
      { unit: "typescript-node", prefix: "@8lines/gauntlet-typescript-node@", suffix: "\n" },
    ],
  },
  {
    path: "skills/gauntlet-app-integration/references/nextjs.md",
    slots: [
      { unit: "protocol", prefix: "@8lines/gauntlet-protocol@", suffix: " \\\n" },
      { unit: "typescript-core", prefix: "@8lines/gauntlet-typescript-core@", suffix: " \\\n" },
      { unit: "next-adapter", prefix: "@8lines/gauntlet-next-adapter@", suffix: "\n" },
    ],
  },
  {
    path: "skills/gauntlet-app-integration/references/symfony.md",
    slots: [{ unit: "php-core", prefix: "install exact release `", suffix: "` of `8lines/gauntlet-php-core`" }],
  },
  {
    path: "skills/gauntlet-app-integration/references/spring.md",
    slots: [
      { unit: "spring-boot-starter", prefix: "implementation(\"dev.eightlines.gauntlet:spring-boot-starter:", suffix: "\")" },
      { unit: "spring-boot-starter", prefix: "Prefer released `", suffix: "` metadata" },
      { unit: "spring-boot-starter", prefix: "reject `", suffix: "-SNAPSHOT` coordinates" },
    ],
  },
  {
    path: "skills/gauntlet-app-integration/references/deployment.md",
    slots: [
      { unit: "gauntlet", prefix: "Use exact image `ghcr.io/8lines/gauntlet:", suffix: "` or an approved digest." },
      {
        unit: "gauntlet",
        prefix: "Use exact chart `oci://ghcr.io/8lines/charts/gauntlet` version `",
        suffix: "` and exact image",
      },
      { unit: "gauntlet", prefix: "and exact image `", suffix: "` or a reviewed digest." },
    ],
  },
  {
    path: "skills/gauntlet-app-integration/references/safety-gates.md",
    slots: [{ unit: "gauntlet", prefix: "Version `", suffix: "` has no built-in Gauntlet authentication" }],
  },
  {
    path: "docs/ai-skills.md",
    slots: [
      { unit: "skills", prefix: "contains `gauntlet-skills-", suffix: ".tgz` and records" },
      { unit: "skills", prefix: "tar -xzf gauntlet-skills-", suffix: ".tgz -C" },
      { unit: "skills", prefix: "skills_archive_root=\"$skills_unpack/gauntlet-skills-", suffix: "\"" },
    ],
  },
]);

function releaseTextSpans(source, slots) {
  const spans = [];
  for (const { unit, prefix, suffix } of slots) {
    const matches = [];
    let searchFrom = 0;
    while (searchFrom < source.length) {
      const prefixStart = source.indexOf(prefix, searchFrom);
      if (prefixStart < 0) break;
      const start = prefixStart + prefix.length;
      const end = source.indexOf(suffix, start);
      if (end < start) throw new Error("Release text reference is malformed");
      const value = source.slice(start, end);
      try {
        if (parseReleaseVersion(`${value}\n`) !== value) throw new Error("Release text reference is malformed");
      } catch {
        throw new Error("Release text reference is malformed");
      }
      matches.push({ start, end, value, unit });
      searchFrom = end + suffix.length;
    }
    if (matches.length !== 1) throw new Error("Release text reference is missing or duplicated");
    spans.push(matches[0]);
  }

  const ordered = [...spans].sort((left, right) => left.start - right.start);
  if (ordered.some((span, index) => index > 0 && span.start < ordered[index - 1].end)) {
    throw new Error("Release text reference overlaps another reference");
  }
  return spans;
}

function pushReleaseTextChecks(mismatches, root, { path, slots }, versions) {
  let spans;
  try {
    const manifest = readManifest(root, path);
    spans = releaseTextSpans(manifest.source, slots);
  } catch {
    mismatches.push(`${path}: release references are missing or malformed`);
    return;
  }
  const reported = new Set();
  for (const { unit, value } of spans) {
    const version = versions.get(unit);
    if (version !== undefined && value !== version && !reported.has(unit)) {
      reported.add(unit);
      mismatches.push(`${path}: release references must equal ${unit} ${version}`);
    }
  }
}

export function readVersionFile(root, path) {
  const { bytes } = readManifest(root, path);
  if (bytes.length > MAX_VERSION_BYTES) throw new Error("VERSION is too large");
  return parseReleaseVersion(bytes);
}

export function readJsonVersion(root, path, keyPath) {
  const node = jsonNodeAt(parseJsonManifest(root, path).document, keyPath);
  if (node?.type !== "string") throw new Error("Manifest version must be a string");
  return parseReleaseVersion(Buffer.from(`${node.value}\n`, "utf8"));
}

export function readReleaseVersion(root) {
  try {
    return readVersionFile(root, "VERSION");
  } catch {
    throw new Error("The canonical VERSION file is invalid");
  }
}

export function readUnitVersion(root, id) {
  const unit = unitById(id);
  try {
    return unit.version.type === "file"
      ? readVersionFile(root, unit.version.path)
      : readJsonVersion(root, unit.version.path, unit.version.keyPath);
  } catch {
    throw new Error(`Release unit ${id} version is invalid`);
  }
}

// The Java source and release checks build both artifacts from one captured tree, so both
// unit VERSION records must be present and agree until the checks learn per-artifact versions.
export function javaLockstepVersion(records) {
  const versions = ["packages/java/core/VERSION", "packages/java/spring-boot-starter/VERSION"].map((path) => {
    const record = records.find(({ relativePath }) => relativePath === path);
    if (record === undefined) throw new Error(VERSION_ERROR);
    return parseReleaseVersion(record.bytes);
  });
  if (versions[0] !== versions[1]) throw new Error(VERSION_ERROR);
  return versions[0];
}

export function readUnitVersions(root) {
  return new Map(RELEASE_UNITS.map(({ id }) => [id, readUnitVersion(root, id)]));
}

// Until plan-driven publishing exists, every unit is still released at the application version.
export const LOCKSTEP_RELEASES = true;

function readableUnitVersions(root) {
  const versions = new Map();
  for (const { id } of RELEASE_UNITS) {
    try {
      versions.set(id, readUnitVersion(root, id));
    } catch {
      // An unreadable unit is simply absent; inspectUnitVersions reports file-sourced ones once.
    }
  }
  return versions;
}

function inspectUnitVersions(root) {
  const mismatches = [];
  const versions = readableUnitVersions(root);
  for (const { id, version } of RELEASE_UNITS) {
    if (version.type === "file" && !versions.has(id)) {
      mismatches.push(`${version.path}: canonical release version is missing or invalid`);
    }
  }
  const imageVersion = versions.get("gauntlet");

  for (const { path, name, unit, constraintUnit } of RELEASE_JSON_MANIFESTS) {
    pushJsonChecks(mismatches, root, {
      path,
      name,
      unit,
      version: versions.get(unit),
      constraint: constraintUnit === undefined ? undefined : versions.get(constraintUnit),
    });
  }

  try {
    const gradle = readManifest(root, "packages/java/build.gradle.kts");
    if (!hasGradleVersionContract(gradle.source)) {
      mismatches.push("packages/java/build.gradle.kts: project group/version must derive from the canonical VERSION contract");
    }
  } catch {
    mismatches.push("packages/java/build.gradle.kts: project group/version must derive from the canonical VERSION contract");
  }

  try {
    const chart = parseYamlManifest(root, "deploy/helm/gauntlet/Chart.yaml");
    const name = yamlScalarAt(chart.document, ["name"]);
    const chartVersion = yamlScalarAt(chart.document, ["version"]);
    const appVersion = yamlScalarAt(chart.document, ["appVersion"]);
    if (name.type !== "string" || name.value !== RELEASE_ARTIFACTS.chart.name) {
      mismatches.push("deploy/helm/gauntlet/Chart.yaml: name must equal gauntlet");
    }
    if (chartVersion.type !== "string") mismatches.push("deploy/helm/gauntlet/Chart.yaml: version must be a string");
    else if (imageVersion !== undefined && chartVersion.value !== imageVersion) {
      mismatches.push(`deploy/helm/gauntlet/Chart.yaml: version must equal gauntlet ${imageVersion}`);
    }
    if (appVersion.type !== "string") mismatches.push("deploy/helm/gauntlet/Chart.yaml: appVersion must be a string");
    else if (imageVersion !== undefined && appVersion.value !== imageVersion) {
      mismatches.push(`deploy/helm/gauntlet/Chart.yaml: appVersion must equal gauntlet ${imageVersion}`);
    }
  } catch {
    mismatches.push("deploy/helm/gauntlet/Chart.yaml: manifest is malformed");
  }

  try {
    const values = parseYamlManifest(root, "deploy/helm/gauntlet/values.yaml");
    const repository = yamlScalarAt(values.document, ["image", "repository"]);
    const tag = yamlScalarAt(values.document, ["image", "tag"]);
    if (repository.type !== "string" || repository.value !== RELEASE_ARTIFACTS.image.name) {
      mismatches.push("deploy/helm/gauntlet/values.yaml: image.repository must equal ghcr.io/8lines/gauntlet");
    }
    if (tag.type !== "string") mismatches.push("deploy/helm/gauntlet/values.yaml: image.tag must be a string");
    else if (imageVersion !== undefined && tag.value !== imageVersion) {
      mismatches.push(`deploy/helm/gauntlet/values.yaml: image.tag must equal gauntlet ${imageVersion}`);
    }
  } catch {
    mismatches.push("deploy/helm/gauntlet/values.yaml: manifest is malformed");
  }

  try {
    const compose = parseComposeEnvironment(root);
    const expectedImage = imageVersion === undefined ? undefined : `${RELEASE_ARTIFACTS.image.name}:${imageVersion}`;
    if (expectedImage !== undefined && compose.image !== expectedImage) {
      mismatches.push(`deploy/compose/.env.example: GAUNTLET_IMAGE must equal ${expectedImage}`);
    }
  } catch {
    mismatches.push("deploy/compose/.env.example: manifest is malformed");
  }

  for (const file of RELEASE_CONSUMER_JSON_FILES) pushConsumerJsonChecks(mismatches, root, file, versions);
  for (const file of RELEASE_TEXT_FILES) pushReleaseTextChecks(mismatches, root, file, versions);

  return { mismatches, versions };
}

export function collectUnitVersionMismatches(root) {
  return inspectUnitVersions(root).mismatches;
}

export function collectVersionMismatches(root, expectedTag) {
  const { mismatches, versions } = inspectUnitVersions(root);
  const applicationVersion = versions.get("gauntlet");

  if (expectedTag !== undefined && expectedTag !== `v${applicationVersion ?? ""}`) {
    mismatches.push(`tag: must equal ${applicationVersion === undefined ? "vVERSION" : `v${applicationVersion}`}`);
  }

  if (LOCKSTEP_RELEASES && applicationVersion !== undefined) {
    for (const [id, version] of versions) {
      if (version !== applicationVersion) {
        mismatches.push(`${id}: version ${version} must equal VERSION ${applicationVersion} until plan-driven publishing`);
      }
    }
  }

  return mismatches;
}

export const VERSION_LOCATIONS = deeplyFreeze([
  ...RELEASE_UNITS.filter(({ version }) => version.type === "file").map(({ id, version }) => ({
    type: "file",
    path: version.path,
    unit: id,
  })),
  ...RELEASE_JSON_MANIFESTS.map(({ path, unit }) => ({ type: "json", path, keyPath: ["version"], unit })),
  {
    type: "json-constraint",
    path: "packages/php/symfony-bundle/composer.json",
    keyPath: ["require", "8lines/gauntlet-php-core"],
    unit: "php-core",
  },
  { type: "yaml", path: "deploy/helm/gauntlet/Chart.yaml", keyPath: ["version"], unit: "gauntlet" },
  { type: "yaml", path: "deploy/helm/gauntlet/Chart.yaml", keyPath: ["appVersion"], unit: "gauntlet" },
  { type: "yaml", path: "deploy/helm/gauntlet/values.yaml", keyPath: ["image", "tag"], unit: "gauntlet" },
  { type: "dotenv-image", path: "deploy/compose/.env.example", keyPath: ["GAUNTLET_IMAGE"], unit: "gauntlet" },
  ...RELEASE_CONSUMER_JSON_FILES.flatMap(({ path, keyPaths }) =>
    keyPaths.map(({ keyPath, unit }) => ({ type: "json", path, keyPath, unit }))),
  // A text file can mention several units, so it is listed once per unit it mentions.
  ...RELEASE_TEXT_FILES.flatMap(({ path, slots }) =>
    [...new Set(slots.map(({ unit }) => unit))].map((unit) => ({
      type: "release-text",
      path,
      unit,
      occurrences: slots.filter((slot) => slot.unit === unit).length,
    }))),
]);

// Version files owned by units other than the application; VERSION itself is promoted last.
const UNIT_VERSION_FILE_PATHS = RELEASE_UNITS
  .filter(({ version }) => version.type === "file" && version.path !== "VERSION")
  .map(({ version }) => version.path);

const UPDATE_PATHS = [
  ...RELEASE_JSON_MANIFESTS.map(({ path }) => path),
  "deploy/helm/gauntlet/Chart.yaml",
  "deploy/helm/gauntlet/values.yaml",
  "deploy/compose/.env.example",
  ...RELEASE_CONSUMER_JSON_FILES.map(({ path }) => path),
  ...RELEASE_TEXT_FILES.map(({ path }) => path),
  ...UNIT_VERSION_FILE_PATHS,
  "VERSION",
];

function assertSafeReleaseFile(root, relativePath) {
  const absoluteRoot = resolve(root);
  const rootStat = lstatSync(absoluteRoot, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Unsafe repository root");

  const absolutePath = fixedPath(absoluteRoot, relativePath);
  const relativePathFromRoot = relative(absoluteRoot, absolutePath);
  const segments = relativePathFromRoot.split(sep);
  const ancestors = [{ path: absoluteRoot, stat: rootStat }];
  let current = absoluteRoot;
  for (const segment of segments.slice(0, -1)) {
    current = resolve(current, segment);
    const stat = lstatSync(current, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe release path ancestor");
    ancestors.push({ path: current, stat });
  }
  const stat = lstatSync(absolutePath, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > BigInt(MAX_MANIFEST_BYTES)) {
    throw new Error("Unsafe release target");
  }
  return { absolutePath, ancestors, stat };
}

function snapshotSignature(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

function inodeSignature(stat) {
  return [stat.dev, stat.ino, stat.mode].join(":");
}

function ancestorSignatures(ancestors) {
  return ancestors.map(({ stat }) => inodeSignature(stat));
}

function replacementForYamlScalar(node, version) {
  if (node.type === "QUOTE_DOUBLE") return JSON.stringify(version);
  if (node.type === "QUOTE_SINGLE") return `'${version}'`;
  if (node.type === "PLAIN") return version;
  throw new Error("Unsupported YAML scalar style");
}

function applySpans(source, spans) {
  const ordered = [...spans].sort((left, right) => right.start - left.start);
  let boundary = source.length + 1;
  let result = source;
  for (const span of ordered) {
    if (!Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < 0 || span.end <= span.start || span.end > source.length) {
      throw new Error("Invalid version scalar span");
    }
    if (span.end > boundary) throw new Error("Overlapping version scalar spans");
    result = `${result.slice(0, span.start)}${span.replacement}${result.slice(span.end)}`;
    boundary = span.start;
  }
  return result;
}

function prepareJsonFile(root, path, edits) {
  const manifest = parseJsonManifest(root, path);
  const spans = edits.map(({ keyPath, current, next, constraint = false }) => {
    const node = jsonNodeAt(manifest.document, keyPath);
    const expected = constraint ? `^${current}` : current;
    if (node?.type !== "string" || node.value !== expected) throw new Error("Unexpected JSON version scalar");
    return {
      start: node.start,
      end: node.end,
      replacement: JSON.stringify(constraint ? `^${next}` : next),
    };
  });
  if (spans.length === 0) return { ...manifest, path, nextBytes: manifest.bytes };
  const nextSource = applySpans(manifest.source, spans);
  const nextDocument = parseJsonSyntax(nextSource);
  for (const { keyPath, next, constraint = false } of edits) {
    const node = jsonNodeAt(nextDocument, keyPath);
    if (node?.type !== "string" || node.value !== (constraint ? `^${next}` : next)) {
      throw new Error("JSON version update validation failed");
    }
  }
  return { ...manifest, path, nextBytes: Buffer.from(nextSource, "utf8") };
}

function prepareUnchangedFile(root, path) {
  const manifest = readManifest(root, path);
  return { ...manifest, path, nextBytes: manifest.bytes };
}

function prepareYamlFile(root, path, currentVersion, nextVersion, keyPaths) {
  const manifest = parseYamlManifest(root, path);
  const spans = keyPaths.map((keyPath) => {
    const scalar = yamlScalarAt(manifest.document, keyPath);
    if (scalar.type !== "string" || scalar.value !== currentVersion || !Array.isArray(scalar.node.range)) {
      throw new Error("Unexpected YAML version scalar");
    }
    return {
      start: scalar.node.range[0],
      end: scalar.node.range[1],
      replacement: replacementForYamlScalar(scalar.node, nextVersion),
    };
  });
  const nextSource = applySpans(manifest.source, spans);
  const nextDocument = parseDocument(nextSource, {
    keepSourceTokens: true,
    maxAliasCount: 0,
    prettyErrors: false,
    uniqueKeys: true,
  });
  if (nextDocument.errors.length > 0) throw new Error("YAML version update validation failed");
  for (const keyPath of keyPaths) {
    const scalar = yamlScalarAt(nextDocument, keyPath);
    if (scalar.type !== "string" || scalar.value !== nextVersion) throw new Error("YAML version update validation failed");
  }
  return { ...manifest, path, nextBytes: Buffer.from(nextSource, "utf8") };
}

function prepareComposeFile(root, currentVersion, nextVersion) {
  const manifest = parseComposeEnvironment(root);
  const currentImage = `${RELEASE_ARTIFACTS.image.name}:${currentVersion}`;
  if (manifest.image !== currentImage) throw new Error("Unexpected Compose image scalar");
  const prefix = "GAUNTLET_IMAGE=";
  const start = manifest.source.indexOf(prefix) + prefix.length;
  const end = manifest.source.indexOf("\n", start);
  if (start < prefix.length || end < start) throw new Error("Unexpected Compose image scalar");
  const nextImage = `${RELEASE_ARTIFACTS.image.name}:${nextVersion}`;
  const nextSource = applySpans(manifest.source, [{ start, end, replacement: nextImage }]);
  const assignments = nextSource.split("\n").filter((line) => line.startsWith(prefix));
  if (assignments.length !== 1 || assignments[0] !== `${prefix}${nextImage}`) {
    throw new Error("Compose image update validation failed");
  }
  return { ...manifest, path: "deploy/compose/.env.example", nextBytes: Buffer.from(nextSource, "utf8") };
}

function prepareReleaseTextFile(root, { path, slots }, currentVersions, nextVersions) {
  const manifest = readManifest(root, path);
  const spans = releaseTextSpans(manifest.source, slots);
  if (spans.some(({ unit, value }) => value !== currentVersions.get(unit))) throw new Error("Unexpected release text version");
  const moving = spans.filter(({ unit }) => nextVersions.has(unit));
  if (moving.length === 0) return { ...manifest, path, nextBytes: manifest.bytes };
  const nextSource = applySpans(
    manifest.source,
    moving.map(({ start, end, unit }) => ({ start, end, replacement: nextVersions.get(unit) })),
  );
  const nextSpans = releaseTextSpans(nextSource, slots);
  if (nextSpans.some(({ unit, value }) => value !== (nextVersions.get(unit) ?? currentVersions.get(unit)))) {
    throw new Error("Release text update validation failed");
  }
  return { ...manifest, path, nextBytes: Buffer.from(nextSource, "utf8") };
}

function prepareVersionFile(root, path, currentVersion, nextVersion) {
  const manifest = readManifest(root, path);
  if (parseReleaseVersion(manifest.bytes) !== currentVersion) throw new Error("Unexpected VERSION scalar");
  return { ...manifest, path, nextBytes: Buffer.from(`${nextVersion}\n`, "ascii") };
}

function prepareReleaseUpdate(root, currentVersions, nextVersions) {
  const initialSafety = new Map(UPDATE_PATHS.map((path) => [path, assertSafeReleaseFile(root, path)]));

  const has = (unit) => nextVersions.has(unit);
  const edit = (keyPath, unit, constraint = false) => ({
    keyPath,
    current: currentVersions.get(unit),
    next: nextVersions.get(unit),
    constraint,
  });
  const prepared = [
    ...RELEASE_JSON_MANIFESTS.map(({ path, unit, constraintUnit }) =>
      prepareJsonFile(root, path, [
        ...(has(unit) ? [edit(["version"], unit)] : []),
        ...(constraintUnit !== undefined && has(constraintUnit)
          ? [edit(["require", "8lines/gauntlet-php-core"], constraintUnit, true)]
          : []),
      ]),
    ),
    has("gauntlet")
      ? prepareYamlFile(root, "deploy/helm/gauntlet/Chart.yaml", currentVersions.get("gauntlet"), nextVersions.get("gauntlet"), [["version"], ["appVersion"]])
      : prepareUnchangedFile(root, "deploy/helm/gauntlet/Chart.yaml"),
    has("gauntlet")
      ? prepareYamlFile(root, "deploy/helm/gauntlet/values.yaml", currentVersions.get("gauntlet"), nextVersions.get("gauntlet"), [["image", "tag"]])
      : prepareUnchangedFile(root, "deploy/helm/gauntlet/values.yaml"),
    has("gauntlet")
      ? prepareComposeFile(root, currentVersions.get("gauntlet"), nextVersions.get("gauntlet"))
      : prepareUnchangedFile(root, "deploy/compose/.env.example"),
    ...RELEASE_CONSUMER_JSON_FILES.map(({ path, keyPaths }) =>
      prepareJsonFile(
        root,
        path,
        keyPaths.filter(({ unit }) => has(unit)).map(({ keyPath, unit }) => edit(keyPath, unit)),
      ),
    ),
    ...RELEASE_TEXT_FILES.map((file) => prepareReleaseTextFile(root, file, currentVersions, nextVersions)),
    ...UNIT_VERSION_FILE_PATHS.map((path) => {
      const unit = RELEASE_UNITS.find(({ version }) => version.type === "file" && version.path === path).id;
      return has(unit)
        ? prepareVersionFile(root, path, currentVersions.get(unit), nextVersions.get(unit))
        : prepareUnchangedFile(root, path);
    }),
    has("gauntlet")
      ? prepareVersionFile(root, "VERSION", currentVersions.get("gauntlet"), nextVersions.get("gauntlet"))
      : prepareUnchangedFile(root, "VERSION"),
  ];

  if (prepared.map(({ path }) => path).join("\0") !== UPDATE_PATHS.join("\0")) {
    throw new Error("Release updater path inventory is invalid");
  }
  for (const file of prepared) {
    if (
      file.nextBytes.length === 0 ||
      file.nextBytes.length > MAX_MANIFEST_BYTES ||
      file.nextBytes.includes(0x0d) ||
      file.nextBytes.at(-1) !== 0x0a
    ) {
      throw new Error("Release update would violate manifest bounds or LF policy");
    }
    file.originalBytes = file.bytes;
    file.signature = snapshotSignature(file.stat);
    const initial = initialSafety.get(file.path);
    const safety = assertSafeReleaseFile(root, file.path);
    const currentBytes = readFileSync(safety.absolutePath);
    const initialAncestors = ancestorSignatures(initial.ancestors);
    const currentAncestors = ancestorSignatures(safety.ancestors);
    if (
      snapshotSignature(initial.stat) !== file.signature ||
      snapshotSignature(safety.stat) !== file.signature ||
      initialAncestors.length !== currentAncestors.length ||
      initialAncestors.some((signature, index) => signature !== currentAncestors[index]) ||
      !currentBytes.equals(file.originalBytes)
    ) {
      throw new Error("Release target changed during preflight");
    }
    file.absolutePath = safety.absolutePath;
    file.ancestorSignatures = ancestorSignatures(safety.ancestors);
  }
  return prepared;
}

function releaseRaceError() {
  const error = new Error("A release target changed after preflight");
  error.code = "RELEASE_TARGET_RACE";
  return error;
}

function descriptorSnapshot(descriptor) {
  const before = fstatSync(descriptor, { bigint: true });
  if (!before.isFile() || before.size < 0n || before.size > BigInt(MAX_MANIFEST_BYTES)) throw releaseRaceError();
  const bytes = Buffer.alloc(Number(before.size));
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (count <= 0) throw releaseRaceError();
    offset += count;
  }
  const after = fstatSync(descriptor, { bigint: true });
  if (snapshotSignature(before) !== snapshotSignature(after)) throw releaseRaceError();
  return { bytes, stat: after };
}

function hasExpectedAncestors(file, safety) {
  const current = ancestorSignatures(safety.ancestors);
  return current.length === file.ancestorSignatures.length && current.every((signature, index) => signature === file.ancestorSignatures[index]);
}

function assertBoundDescriptorState(root, transaction, expectedBytes, expectedSignature) {
  let before;
  let descriptor;
  let after;
  try {
    before = assertSafeReleaseFile(root, transaction.file.path);
    descriptor = descriptorSnapshot(transaction.descriptor);
    after = assertSafeReleaseFile(root, transaction.file.path);
  } catch {
    throw releaseRaceError();
  }
  if (
    !hasExpectedAncestors(transaction.file, before) ||
    !hasExpectedAncestors(transaction.file, after) ||
    inodeSignature(before.stat) !== transaction.inode ||
    inodeSignature(descriptor.stat) !== transaction.inode ||
    inodeSignature(after.stat) !== transaction.inode ||
    snapshotSignature(before.stat) !== snapshotSignature(descriptor.stat) ||
    snapshotSignature(after.stat) !== snapshotSignature(descriptor.stat) ||
    !descriptor.bytes.equals(expectedBytes) ||
    (expectedSignature !== undefined && snapshotSignature(descriptor.stat) !== expectedSignature)
  ) {
    throw releaseRaceError();
  }
}

function overwriteDescriptor(transaction, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(transaction.descriptor, bytes, offset, bytes.length - offset, offset);
    if (count <= 0) throw new Error("Release descriptor write failed");
    offset += count;
  }
  ftruncateSync(transaction.descriptor, bytes.length);
  const desiredMode = transaction.file.stat.mode & 0o7777n;
  const currentMode = fstatSync(transaction.descriptor, { bigint: true }).mode & 0o7777n;
  if (currentMode !== desiredMode) fchmodSync(transaction.descriptor, Number(desiredMode));
  fsyncSync(transaction.descriptor);
}

function assertPlainClosedRecord(value, allowedKeys) {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value) || Array.isArray(value)) {
    throw new Error("Release updater options are invalid");
  }
  const prototype = Object.getPrototypeOf(value);
  const keys = Reflect.ownKeys(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.some((key) => typeof key !== "string" || !allowedKeys.has(key))
  ) {
    throw new Error("Release updater options are invalid");
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true ||
      descriptor.configurable !== true ||
      descriptor.writable !== true
    ) {
      throw new Error("Release updater options are invalid");
    }
  }
  return value;
}

function captureTestingHook(options) {
  assertPlainClosedRecord(options, new Set(["testingHooks"]));
  const optionsDescriptor = Object.getOwnPropertyDescriptor(options, "testingHooks");
  if (optionsDescriptor === undefined) return undefined;
  const hooks = assertPlainClosedRecord(optionsDescriptor.value, new Set(["boundary"]));
  const boundaryDescriptor = Object.getOwnPropertyDescriptor(hooks, "boundary");
  if (
    boundaryDescriptor === undefined ||
    typeof boundaryDescriptor.value !== "function" ||
    utilTypes.isProxy(boundaryDescriptor.value)
  ) {
    throw new Error("Release updater options are invalid");
  }
  return boundaryDescriptor.value;
}

function invokeTestingHook(hook, phase, boundary, index) {
  if (hook === undefined) return;
  const metadata = Object.create(null);
  metadata.phase = phase;
  metadata.boundary = boundary;
  metadata.index = index;
  Object.freeze(metadata);
  try {
    if (hook(metadata) !== undefined) throw new Error("Invalid testing hook result");
  } catch {
    throw new Error("Release updater testing hook failed");
  }
}

function closeTransactions(transactions) {
  let closed = true;
  for (const transaction of [...transactions].reverse()) {
    if (transaction.descriptor === undefined) continue;
    try {
      closeSync(transaction.descriptor);
    } catch {
      closed = false;
    }
    transaction.descriptor = undefined;
  }
  return closed;
}

function openTransactions(root, changed) {
  const transactions = [];
  try {
    for (const [index, file] of changed.entries()) {
      const safety = assertSafeReleaseFile(root, file.path);
      if (
        !hasExpectedAncestors(file, safety) ||
        snapshotSignature(safety.stat) !== file.signature ||
        typeof fsConstants.O_NOFOLLOW !== "number"
      ) {
        throw releaseRaceError();
      }
      const descriptor = openSync(file.absolutePath, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
      const transaction = { descriptor, dirty: false, file, index, inode: inodeSignature(file.stat) };
      transactions.push(transaction);
      assertBoundDescriptorState(root, transaction, file.originalBytes, file.signature);
    }
    for (const transaction of transactions) {
      assertBoundDescriptorState(root, transaction, transaction.file.originalBytes, transaction.file.signature);
    }
    return transactions;
  } catch {
    closeTransactions(transactions);
    throw new Error("release version update failed before promotion");
  }
}

function rollbackTransaction(root, transaction, testingHook) {
  try {
    assertBoundDescriptorState(root, transaction, transaction.file.originalBytes);
    transaction.dirty = false;
    return true;
  } catch {}

  try {
    assertBoundDescriptorState(root, transaction, transaction.file.nextBytes);
    invokeTestingHook(testingHook, "rollback", "before-write", transaction.index);
    assertBoundDescriptorState(root, transaction, transaction.file.nextBytes);
    overwriteDescriptor(transaction, transaction.file.originalBytes);
    invokeTestingHook(testingHook, "rollback", "after-write", transaction.index);
    assertBoundDescriptorState(root, transaction, transaction.file.originalBytes);
    transaction.dirty = false;
    return true;
  } catch {
    return false;
  }
}

function commitPreparedUpdate(root, prepared, testingHook) {
  const changed = prepared.filter(({ originalBytes, nextBytes }) => !originalBytes.equals(nextBytes));
  if (changed.length === 0) return [];

  const transactions = openTransactions(root, changed);
  let primaryError;
  try {
    for (const transaction of transactions) {
      invokeTestingHook(testingHook, "promote", "before-write", transaction.index);
      assertBoundDescriptorState(root, transaction, transaction.file.originalBytes, transaction.file.signature);
      transaction.dirty = true;
      overwriteDescriptor(transaction, transaction.file.nextBytes);
      invokeTestingHook(testingHook, "promote", "after-write", transaction.index);
      assertBoundDescriptorState(root, transaction, transaction.file.nextBytes);
    }

    for (const transaction of transactions) {
      assertBoundDescriptorState(root, transaction, transaction.file.nextBytes);
    }
  } catch (error) {
    primaryError = error;
    let rollbackFailed = false;
    for (const transaction of [...transactions].reverse().filter(({ dirty }) => dirty)) {
      try {
        if (!rollbackTransaction(root, transaction, testingHook)) rollbackFailed = true;
      } catch {
        rollbackFailed = true;
      }
    }
    const closed = closeTransactions(transactions);
    if (!closed) rollbackFailed = true;
    if (rollbackFailed) throw new Error("release version update failed; repository version state is inconsistent");
    if (primaryError?.code === "RELEASE_TARGET_RACE") throw new Error("A release target changed after preflight");
    throw new Error("release version update failed");
  }

  if (!closeTransactions(transactions)) {
    throw new Error("release version update failed; repository version state is inconsistent");
  }
  return changed.map(({ path }) => path);
}

function requestedUnitVersions(requested) {
  let entries;
  if (requested instanceof Map) entries = [...requested];
  else if (
    requested !== null &&
    typeof requested === "object" &&
    !Array.isArray(requested) &&
    Object.getPrototypeOf(requested) === Object.prototype
  ) entries = Object.entries(requested);
  if (entries === undefined || entries.length === 0) throw new TypeError("Release unit versions must name at least one unit");
  const result = new Map();
  for (const [id, version] of entries) {
    unitById(id);
    if (result.has(id) || typeof version !== "string") throw new TypeError("Release unit versions are invalid");
    result.set(id, parseReleaseVersion(`${version}\n`));
  }
  return result;
}

export function setUnitVersions(root, requested, options = {}) {
  const nextVersions = requestedUnitVersions(requested);
  const testingHook = captureTestingHook(options);
  let prepared;
  try {
    if (collectUnitVersionMismatches(root).length > 0) throw new Error("Repository version state is inconsistent");
    prepared = prepareReleaseUpdate(root, readUnitVersions(root), nextVersions);
  } catch {
    throw new Error("Release version update preflight failed");
  }
  const changedPaths = commitPreparedUpdate(root, prepared, testingHook);
  return Object.freeze({ versions: Object.freeze(Object.fromEntries(nextVersions)), changedPaths });
}

export function setReleaseVersion(root, requestedVersion, options = {}) {
  const nextVersion = parseReleaseVersion(
    typeof requestedVersion === "string" ? `${requestedVersion}\n` : requestedVersion,
  );
  const testingHook = captureTestingHook(options);

  let prepared;
  try {
    if (collectVersionMismatches(root).length > 0) throw new Error("Repository version state is inconsistent");
    prepared = prepareReleaseUpdate(
      root,
      readUnitVersions(root),
      new Map(RELEASE_UNITS.map(({ id }) => [id, nextVersion])),
    );
  } catch {
    throw new Error("Release version update preflight failed");
  }

  return { version: nextVersion, changedPaths: commitPreparedUpdate(root, prepared, testingHook) };
}
