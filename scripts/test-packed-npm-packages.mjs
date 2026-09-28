import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { RELEASE_ARTIFACTS, readReleaseVersion } from "./release/release-model.mjs";
import { stageNpmPackages } from "./release/stage-npm.mjs";

const ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const VERSION = readReleaseVersion(ROOT);
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_FIXTURE_FILE_BYTES = 512 * 1024;
const MAX_FIXTURE_FILES = 1_000;
const MAX_FIXTURE_TOTAL_BYTES = 8 * 1024 * 1024;
const PACKAGE_NAMES = RELEASE_ARTIFACTS.npm.map(({ name }) => name);
const OFFLINE_PACKAGES = Object.freeze([
  Object.freeze({
    name: "ajv", version: "8.20.0", development: false,
    directory: "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv",
    files: 466, bytes: 1_033_496, sha256: "5a0a6ef30f45de190f1832a192e6d7d0bb7f6ed83037b42c45699d94f0a0ab57",
  }),
  Object.freeze({
    name: "ajv-formats", version: "3.0.1", development: false,
    directory: "node_modules/.pnpm/ajv-formats@3.0.1_ajv@8.20.0/node_modules/ajv-formats",
    files: 15, bytes: 56_763, sha256: "4ddb0131283ae956abf298cd903fe58d14b7acf951e9f095d0543cd26cedc609",
  }),
  Object.freeze({
    name: "canonicalize", version: "4.0.0", development: false,
    directory: "node_modules/.pnpm/canonicalize@4.0.0/node_modules/canonicalize",
    files: 6, bytes: 16_897, sha256: "5157bf6ace847f42379a5fe0e77284d22ef28207a2d72b12b38a8b944029af6c",
  }),
  Object.freeze({
    name: "fast-deep-equal", version: "3.1.3", development: false,
    directory: "node_modules/.pnpm/fast-deep-equal@3.1.3/node_modules/fast-deep-equal",
    files: 11, bytes: 12_966, sha256: "2a31ff19e65fb33a11105548fc5b61eb045f9e49c2888edf653e0557a7a0eaf2",
  }),
  Object.freeze({
    name: "fast-uri", version: "3.1.6", development: false,
    directory: "node_modules/.pnpm/fast-uri@3.1.6/node_modules/fast-uri",
    files: 44, bytes: 215_561, sha256: "5017bb2bb25ad4fc45aa88d101d7a5839113311ae25836461bc26ec205675df5",
  }),
  Object.freeze({
    name: "json-schema-traverse", version: "1.0.0", development: false,
    directory: "node_modules/.pnpm/json-schema-traverse@1.0.0/node_modules/json-schema-traverse",
    files: 12, bytes: 22_220, sha256: "e9f9208ae9151ae9035e841a378e2cf03c85a24c12061a9ada2bb183ce75c76b",
  }),
  Object.freeze({
    name: "require-from-string", version: "2.0.2", development: false,
    directory: "node_modules/.pnpm/require-from-string@2.0.2/node_modules/require-from-string",
    files: 4, bytes: 3_422, sha256: "9512cc991b9e64ebacd8bd642d46a467fbd59e9510d10d806d01eba524e4fa69",
  }),
  Object.freeze({
    name: "@types/node", version: "24.13.3", development: true,
    directory: "node_modules/.pnpm/@types+node@24.13.3/node_modules/@types/node",
    files: 75, bytes: 2_543_416, sha256: "95dc11bae078f292bd548fa08528580efe4b0f095f6eb50b655339216dcae51e",
  }),
  Object.freeze({
    name: "undici-types", version: "7.18.2", development: true,
    directory: "node_modules/.pnpm/undici-types@7.18.2/node_modules/undici-types",
    files: 46, bytes: 113_515, sha256: "391fce47ef0e98054d4e6c291a25af2dd096ddd6c0f4cfa132705a1a32465e8f",
  }),
]);

function binaryCompare(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.size === right.size && left.mtimeNs === right.mtimeNs;
}

function safeFixtureRead(path) {
  let descriptor;
  try {
    const pathnameBefore = lstatSync(path, { bigint: true });
    assert.equal(pathnameBefore.isSymbolicLink(), false);
    assert.equal(pathnameBefore.isFile(), true);
    assert.equal(pathnameBefore.nlink, 1n);
    assert.equal(pathnameBefore.size <= BigInt(MAX_FIXTURE_FILE_BYTES), true);
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const descriptorBefore = fstatSync(descriptor, { bigint: true });
    assert.equal(sameFile(pathnameBefore, descriptorBefore), true);
    const bytes = Buffer.alloc(Number(descriptorBefore.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      assert.equal(count > 0, true);
      offset += count;
    }
    const descriptorAfter = fstatSync(descriptor, { bigint: true });
    const pathnameAfter = lstatSync(path, { bigint: true });
    assert.equal(sameFile(descriptorBefore, descriptorAfter), true);
    assert.equal(sameFile(descriptorAfter, pathnameAfter), true);
    return Object.freeze({ bytes, stat: descriptorAfter });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function treeHash(records) {
  const hash = createHash("sha256").update("gauntlet-offline-package-v1\0");
  for (const record of records) {
    const path = Buffer.from(record.path);
    const pathLength = Buffer.alloc(4);
    pathLength.writeUInt32BE(path.length);
    const mode = Buffer.alloc(4);
    mode.writeUInt32BE(record.mode);
    const byteLength = Buffer.alloc(8);
    byteLength.writeBigUInt64BE(BigInt(record.bytes.length));
    hash.update(pathLength).update(path).update(mode).update(byteLength).update(record.bytes);
  }
  return hash.digest("hex");
}

function captureOfflinePackage(contract, source = resolve(ROOT, contract.directory)) {
  assert.equal(realpathSync(source), source);
  const sourceStat = lstatSync(source, { bigint: true });
  assert.equal(sourceStat.isDirectory(), true);
  assert.equal(sourceStat.isSymbolicLink(), false);
  const records = [];
  let totalBytes = 0;
  const visit = (directory, prefix) => {
    const names = readdirSync(directory).sort(binaryCompare);
    assert.equal(names.length > 0, true, "Offline package contains an empty directory");
    for (const name of names) {
      assert.equal(name !== "." && name !== ".." && !/[\\/\0-\x1f\x7f]/u.test(name), true);
      const path = join(directory, name);
      const relativePath = prefix === "" ? name : `${prefix}/${name}`;
      const stat = lstatSync(path, { bigint: true });
      assert.equal(stat.isSymbolicLink(), false);
      if (stat.isDirectory()) {
        visit(path, relativePath);
        continue;
      }
      assert.equal(stat.isFile(), true);
      const captured = safeFixtureRead(path);
      const mode = Number(captured.stat.mode & 0o777n);
      assert.equal(mode === 0o644 || mode === 0o755, true);
      totalBytes += captured.bytes.length;
      assert.equal(records.length < MAX_FIXTURE_FILES && totalBytes <= MAX_FIXTURE_TOTAL_BYTES, true);
      records.push(Object.freeze({ path: relativePath, mode, bytes: captured.bytes }));
    }
  };
  visit(source, "");
  records.sort((left, right) => binaryCompare(left.path, right.path));
  assert.equal(records.length, contract.files, `Offline package ${contract.name} file count changed`);
  assert.equal(totalBytes, contract.bytes, `Offline package ${contract.name} byte count changed`);
  assert.equal(treeHash(records), contract.sha256, `Offline package ${contract.name} tree changed`);
  const manifestRecord = records.find(({ path }) => path === "package.json");
  assert.notEqual(manifestRecord, undefined);
  const manifest = JSON.parse(manifestRecord.bytes.toString("utf8"));
  assert.equal(manifest.name, contract.name);
  assert.equal(manifest.version, contract.version);
  return Object.freeze({ contract, source, records: Object.freeze(records) });
}

function materializeOfflinePackage(parent, capture, index) {
  const destination = join(parent, String(index).padStart(2, "0"));
  mkdirSync(destination, { mode: 0o700 });
  chmodSync(destination, 0o700);
  const createdDirectories = new Set([""]);
  for (const record of capture.records) {
    const segments = record.path.split("/");
    for (let length = 1; length < segments.length; length += 1) {
      const relativeDirectory = segments.slice(0, length).join("/");
      if (createdDirectories.has(relativeDirectory)) continue;
      const directory = join(destination, ...segments.slice(0, length));
      mkdirSync(directory, { mode: 0o700 });
      chmodSync(directory, 0o700);
      createdDirectories.add(relativeDirectory);
    }
    const path = join(destination, ...segments);
    writeFileSync(path, record.bytes, { flag: "wx", mode: record.mode });
    chmodSync(path, record.mode);
  }
  const copied = captureOfflinePackage(capture.contract, destination);
  assert.equal(copied.source, destination);
  return destination;
}

function run(cwd, command, args, environment) {
  const result = spawnSync(command, args, {
    cwd,
    env: environment,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: MAX_OUTPUT_BYTES,
    windowsHide: true,
  });
  assert.equal(result.error, undefined, "Packed consumer command failed to start");
  assert.equal(result.signal, null, "Packed consumer command was terminated");
  assert.equal(result.status, 0, "Packed consumer command failed");
  return result;
}

function consumerEnvironment(sandbox) {
  const path = process.env.PATH;
  assert.equal(typeof path, "string");
  const home = join(sandbox, "home");
  const temporary = join(sandbox, "tmp");
  const cache = join(sandbox, "cache");
  const configuration = join(sandbox, "config");
  const data = join(sandbox, "data");
  const state = join(sandbox, "state");
  const pnpmHome = join(sandbox, "pnpm-home");
  const storeDirectory = join(sandbox, "pnpm-store");
  for (const directory of [home, temporary, cache, configuration, data, state, pnpmHome, storeDirectory]) {
    mkdirSync(directory, { mode: 0o700 });
    chmodSync(directory, 0o700);
    assert.equal(realpathSync(directory).startsWith(`${sandbox}${sep}`), true);
  }
  const userconfig = join(configuration, "user.npmrc");
  const globalconfig = join(configuration, "global.npmrc");
  writeFileSync(userconfig, "", { mode: 0o600 });
  writeFileSync(globalconfig, "", { mode: 0o600 });
  const environment = Object.freeze({
    PATH: path,
    HOME: home,
    XDG_CONFIG_HOME: configuration,
    XDG_CACHE_HOME: cache,
    XDG_DATA_HOME: data,
    XDG_STATE_HOME: state,
    TMPDIR: temporary,
    PNPM_HOME: pnpmHome,
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    CI: "true",
    NO_COLOR: "1",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    npm_config_userconfig: userconfig,
    npm_config_globalconfig: globalconfig,
    npm_config_cache: cache,
    npm_config_ignore_scripts: "true",
    npm_config_ignore_pnpmfile: "true",
    npm_config_offline: "true",
    npm_config_registry: "http://127.0.0.1:9",
    npm_config_store_dir: storeDirectory,
    npm_config_update_notifier: "false",
  });
  assert.deepEqual(Object.keys(environment).sort(binaryCompare), [
    "CI", "COREPACK_ENABLE_DOWNLOAD_PROMPT", "HOME", "LANG", "LC_ALL", "NO_COLOR", "PATH", "PNPM_HOME",
    "TMPDIR", "TZ", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
    "npm_config_cache", "npm_config_globalconfig", "npm_config_ignore_pnpmfile", "npm_config_ignore_scripts",
    "npm_config_offline", "npm_config_registry", "npm_config_store_dir", "npm_config_update_notifier",
    "npm_config_userconfig",
  ].sort(binaryCompare));
  return Object.freeze({ environment, storeDirectory });
}

function snapshotInputs() {
  const records = [];
  const visit = (path) => {
    const stat = lstatSync(path, { bigint: true });
    assert.equal(stat.isSymbolicLink(), false);
    if (stat.isDirectory()) {
      records.push([path, "directory", stat.dev, stat.ino, stat.mode, stat.mtimeNs]);
      for (const name of readdirSync(path).sort(binaryCompare)) visit(join(path, name));
      return;
    }
    assert.equal(stat.isFile(), true);
    const bytes = readFileSync(path);
    records.push([
      path,
      stat.dev,
      stat.ino,
      stat.mode,
      stat.size,
      stat.mtimeNs,
      createHash("sha256").update(bytes).digest("hex"),
    ]);
  };
  for (const { directory } of RELEASE_ARTIFACTS.npm) {
    for (const name of ["package.json", "README.md", "LICENSE", "dist"]) visit(join(ROOT, directory, name));
  }
  for (const name of ["schemas", "openapi", "fixtures"]) visit(join(ROOT, "packages/protocol", name));
  for (const { directory } of OFFLINE_PACKAGES) visit(resolve(ROOT, directory));
  return records;
}

const before = snapshotInputs();
const sandbox = realpathSync(mkdtempSync(resolve(tmpdir(), "gauntlet-packed-consumer-")));
try {
  const stagingDirectory = join(sandbox, "staged");
  mkdirSync(stagingDirectory, { mode: 0o700 });
  chmodSync(stagingDirectory, 0o700);
  const artifacts = await stageNpmPackages({ root: ROOT, outputDirectory: stagingDirectory });
  assert.deepEqual(artifacts.map(({ name }) => name), [...PACKAGE_NAMES].sort(binaryCompare));
  assert.equal(artifacts.length, 7);
  for (const artifact of artifacts) {
    assert.equal(artifact.kind, "npm");
    assert.equal(artifact.version, VERSION);
    assert.equal(realpathSync(artifact.path), artifact.path);
    assert.equal(statSync(artifact.path).size < 50 * 1024 * 1024, true);
    assert.equal(statSync(artifact.path).mode & 0o777, 0o600);
    assert.equal(createHash("sha256").update(readFileSync(artifact.path)).digest("hex"), artifact.sha256);
  }

  const fixtureParent = join(sandbox, "fixture-deps");
  mkdirSync(fixtureParent, { mode: 0o700 });
  chmodSync(fixtureParent, 0o700);
  const fixtureEntries = OFFLINE_PACKAGES.map((contract, index) => {
    const capture = captureOfflinePackage(contract);
    const path = materializeOfflinePackage(fixtureParent, capture, index);
    return Object.freeze({ contract, path });
  });

  const consumer = join(sandbox, "consumer");
  mkdirSync(consumer, { mode: 0o700 });
  const dependencyEntries = Object.fromEntries(artifacts.map(({ name, path }) => [name, `file:${path}`]));
  const runtimeFixtureEntries = Object.fromEntries(fixtureEntries
    .filter(({ contract }) => !contract.development)
    .map(({ contract, path }) => [contract.name, `file:${path}`]));
  const developmentFixtureEntries = Object.fromEntries(fixtureEntries
    .filter(({ contract }) => contract.development)
    .map(({ contract, path }) => [contract.name, `file:${path}`]));
  const overrideEntries = { ...dependencyEntries, ...runtimeFixtureEntries, ...developmentFixtureEntries };
  writeFileSync(join(consumer, "package.json"), `${JSON.stringify({
    private: true,
    type: "module",
    packageManager: "pnpm@11.24.0",
    engines: { node: ">=24 <27" },
    dependencies: { ...dependencyEntries, ...runtimeFixtureEntries },
    devDependencies: developmentFixtureEntries,
  }, null, 2)}\n`);
  writeFileSync(join(consumer, "pnpm-workspace.yaml"), [
    "overrides:",
    ...Object.entries(overrideEntries).map(([name, path]) => `  ${JSON.stringify(name)}: ${JSON.stringify(path)}`),
    "",
  ].join("\n"));
  const { environment, storeDirectory } = consumerEnvironment(sandbox);
  assert.equal(readdirSync(storeDirectory).length, 0);
  run(consumer, "pnpm", [
    "--config.offline=true",
    "--config.ignore-scripts=true",
    "--config.ignore-pnpmfile=true",
    "install",
    "--lockfile=false",
    "--store-dir",
    storeDirectory,
  ], environment);
  assert.equal(realpathSync(storeDirectory).startsWith(`${sandbox}${sep}`), true);
  assert.equal(readdirSync(storeDirectory).length > 0, true);
  assert.equal(existsSync(join(consumer, "pnpm-lock.yaml")), false);

  writeFileSync(join(consumer, "check.mjs"), `import assert from "node:assert/strict";
import { realpathSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as protocol from "@8lines/gauntlet-protocol";
import * as core from "@8lines/gauntlet-typescript-core";
import * as nodeAdapter from "@8lines/gauntlet-typescript-node";
import * as nextAdapter from "@8lines/gauntlet-next-adapter";
import * as dashboard from "@8lines/gauntlet-dashboard-client";
import * as conformance from "@8lines/gauntlet-conformance-runner";
import * as widget from "@8lines/gauntlet-widget";
assert.equal(protocol.isProtocolId("packed-consumer"), true);
assert.equal(typeof protocol.assertRuntimeJsonData, "function");
assert.equal(typeof core.OperationRegistry, "function");
assert.equal(typeof nodeAdapter.createAdapterFetchHandler, "function");
assert.equal(typeof nextAdapter.createGauntletRouteHandler, "function");
assert.equal(typeof dashboard.createAdapterClient, "function");
assert.equal(typeof conformance.runAdapterV1Conformance, "function");
assert.equal(typeof widget.boot, "function");
assert.equal(typeof widget.setSubject, "function");
assert.equal(typeof widget.removeSubject, "function");
assert.equal(typeof widget.open, "function");
assert.equal(typeof widget.close, "function");
assert.equal(typeof widget.shutdown, "function");
assert.equal(typeof widget.loadGauntletWidget, "function");
const consumerModules = realpathSync("node_modules") + ${JSON.stringify(sep)};
for (const name of ${JSON.stringify(PACKAGE_NAMES)}) {
  const entrypoint = realpathSync(fileURLToPath(import.meta.resolve(name)));
  assert.equal(entrypoint.startsWith(consumerModules), true);
  await assert.rejects(import(\`\${name}/dist/index.js\`), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
}
for (const name of ${JSON.stringify(OFFLINE_PACKAGES.filter(({ development }) => !development).map(({ name }) => name))}) {
  const entrypoint = realpathSync(fileURLToPath(import.meta.resolve(name)));
  assert.equal(entrypoint.startsWith(consumerModules), true);
}
for (const specifier of [
  "@8lines/gauntlet-protocol/schemas/v1/common.schema.json",
  "@8lines/gauntlet-protocol/fixtures/v1/manifest.valid.json",
  "@8lines/gauntlet-protocol/openapi/adapter-v1.yaml",
]) {
  const path = realpathSync(fileURLToPath(import.meta.resolve(specifier)));
  assert.equal(path.startsWith(consumerModules), true);
  assert.equal(readFileSync(path).length > 0, true);
}
`);
  run(consumer, process.execPath, ["check.mjs"], environment);

  writeFileSync(join(consumer, "check.ts"), `import type { ProtocolId } from "@8lines/gauntlet-protocol";
import type { AdapterCatalog } from "@8lines/gauntlet-typescript-core";
import type { AdapterFetchHandler } from "@8lines/gauntlet-typescript-node";
import type { NextGauntletRouteHandler } from "@8lines/gauntlet-next-adapter";
import type { AdapterClient } from "@8lines/gauntlet-dashboard-client";
import type { AdapterV1Scenario } from "@8lines/gauntlet-conformance-runner";
import type { BootOptions, PageSubject } from "@8lines/gauntlet-widget";
declare const values: [ProtocolId, AdapterCatalog, AdapterFetchHandler, NextGauntletRouteHandler, AdapterClient, AdapterV1Scenario];
void values;
const bootOptions: BootOptions = { target: "shop" };
void bootOptions;
const pageSubject: PageSubject = { type: "order", values: { orderId: "123", paid: true, total: 42 } };
void pageSubject;
`);
  writeFileSync(join(consumer, "tsconfig.json"), `${JSON.stringify({
    compilerOptions: {
      target: "ES2024",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      types: ["node"],
    },
    include: ["check.ts"],
  }, null, 2)}\n`);
  run(consumer, resolve(ROOT, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"], environment);

  const binCases = [
    ["gauntlet-conformance", "Usage: gauntlet-conformance --base-url ABSOLUTE_HTTP_ORIGIN --scenario PATH\n"],
    [
      "gauntlet-conformance-extended",
      "Usage: gauntlet-conformance-extended --enabled-base-url ABSOLUTE_HTTP_ORIGIN --disabled-base-url ABSOLUTE_HTTP_ORIGIN --scenario PATH\n",
    ],
    ["gauntlet-conformance-fixture", "Fixture configuration failed\n"],
  ];
  for (const [binary, expectedError] of binCases) {
    const path = join(consumer, "node_modules", ".bin", binary);
    assert.equal(existsSync(path), true);
    assert.equal(realpathSync(path).startsWith(realpathSync(join(consumer, "node_modules")) + sep), true);
    const result = spawnSync(path, [], {
      cwd: consumer,
      env: environment,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, expectedError);
  }

  assert.deepEqual(snapshotInputs(), before);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
