import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  constants as fsConstants,
  cpSync,
  accessSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";

import { readReleaseVersion, RELEASE_ARTIFACTS } from "../release-model.mjs";
import { stageNpmPackages } from "../stage-npm.mjs";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");
const RELEASE_VERSION = readReleaseVersion(REPOSITORY_ROOT);
const FIXTURE_ROOTS = new Map([
  ["@8lines/gauntlet-protocol", ["dist", "schemas", "openapi", "fixtures"]],
  ["@8lines/gauntlet-dashboard-client", ["dist"]],
  ["@8lines/gauntlet-typescript-core", ["dist"]],
  ["@8lines/gauntlet-typescript-node", ["dist"]],
  ["@8lines/gauntlet-next-adapter", ["dist"]],
  ["@8lines/gauntlet-conformance-runner", ["dist"]],
  ["@8lines/gauntlet-widget", ["dist"]],
]);
const EXACT_FILES = new Map([
  ["@8lines/gauntlet-protocol", ["dist", "schemas", "openapi", "fixtures", "README.md", "LICENSE"]],
  ["@8lines/gauntlet-dashboard-client", ["dist", "README.md", "LICENSE"]],
  ["@8lines/gauntlet-typescript-core", ["dist", "README.md", "LICENSE"]],
  ["@8lines/gauntlet-typescript-node", ["dist", "README.md", "LICENSE"]],
  ["@8lines/gauntlet-next-adapter", ["dist", "README.md", "LICENSE"]],
  ["@8lines/gauntlet-conformance-runner", ["dist", "README.md", "LICENSE"]],
  ["@8lines/gauntlet-widget", ["dist", "README.md", "LICENSE"]],
]);

function tarField(header, offset, length) {
  const bytes = header.subarray(offset, offset + length);
  const nul = bytes.indexOf(0);
  return bytes.subarray(0, nul === -1 ? bytes.length : nul).toString("utf8");
}

function readArchive(archivePath) {
  const tar = gunzipSync(readFileSync(archivePath));
  const entries = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarField(header, 0, 100);
    const prefix = tarField(header, 345, 155);
    const fullName = prefix === "" ? name : `${prefix}/${name}`;
    const size = Number.parseInt(tarField(header, 124, 12).trim(), 8);
    const mode = Number.parseInt(tarField(header, 100, 8).trim(), 8);
    const payloadOffset = offset + 512;
    assert.equal(entries.has(fullName), false);
    entries.set(fullName, Object.freeze({ mode, payload: tar.subarray(payloadOffset, payloadOffset + size) }));
    offset = payloadOffset + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function createOutput(parent, name) {
  const output = resolve(parent, name);
  mkdirSync(output, { mode: 0o700 });
  chmodSync(output, 0o700);
  return output;
}

function createFixture() {
  const sandbox = realpathSync(mkdtempSync(resolve(tmpdir(), "gauntlet-stage-npm-fixture-")));
  const root = resolve(sandbox, "source");
  mkdirSync(root, { mode: 0o700 });
  writeFileSync(resolve(root, "VERSION"), readFileSync(resolve(REPOSITORY_ROOT, "VERSION")), { mode: 0o644 });
  writeFileSync(resolve(root, "LICENSE"), readFileSync(resolve(REPOSITORY_ROOT, "LICENSE")), { mode: 0o644 });
  writeFileSync(resolve(root, ".pnpmfile.cjs"), 'throw new Error("source pnpmfile executed");\n', { mode: 0o644 });
  for (const { name, directory } of RELEASE_ARTIFACTS.npm) {
    const source = resolve(REPOSITORY_ROOT, directory);
    const destination = resolve(root, directory);
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    const manifest = JSON.parse(readFileSync(resolve(source, "package.json"), "utf8"));
    manifest.scripts.prepack = "node should-never-run.mjs";
    writeFileSync(resolve(destination, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
    for (const filename of ["README.md", "LICENSE"]) {
      cpSync(resolve(source, filename), resolve(destination, filename));
    }
    for (const rootName of FIXTURE_ROOTS.get(name)) {
      cpSync(resolve(source, rootName), resolve(destination, rootName), { recursive: true });
    }
  }
  return Object.freeze({
    sandbox,
    root,
    output(name = "output") {
      return createOutput(sandbox, name);
    },
    cleanup() {
      rmSync(sandbox, { recursive: true, force: true });
    },
  });
}

function snapshotTree(root) {
  const records = [];
  const visit = (path, relativePath) => {
    const stat = lstatSync(path, { bigint: true });
    if (stat.isDirectory()) {
      records.push([relativePath, "directory", stat.mode, stat.dev, stat.ino, stat.mtimeNs]);
      for (const name of readdirSync(path).sort()) {
        visit(resolve(path, name), relativePath === "" ? name : `${relativePath}/${name}`);
      }
      return;
    }
    assert.equal(stat.isFile(), true);
    const bytes = readFileSync(path);
    records.push([
      relativePath,
      "file",
      stat.mode,
      stat.dev,
      stat.ino,
      stat.mtimeNs,
      createHash("sha256").update(bytes).digest("hex"),
    ]);
  };
  visit(root, "");
  return records;
}

function findPnpm() {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory === "") continue;
    const candidate = resolve(directory, "pnpm");
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue through the fixed PATH list.
    }
  }
  throw new Error("pnpm executable is unavailable");
}

function createPnpmWrapper(fixture, behavior) {
  const wrapperDirectory = resolve(fixture.sandbox, `wrapper-${behavior}`);
  mkdirSync(wrapperDirectory, { mode: 0o700 });
  const wrapper = resolve(wrapperDirectory, "pnpm");
  const log = resolve(fixture.sandbox, `pnpm-${behavior}.jsonl`);
  const counter = resolve(fixture.sandbox, `pnpm-${behavior}.count`);
  const mutationTarget = resolve(fixture.root, "packages/dashboard-client/dist/index.js");
  const source = `#!/usr/bin/env node
const { appendFileSync, readFileSync, readdirSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");
const { gzipSync, gunzipSync } = require("node:zlib");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, cwd: process.cwd(), env: process.env }) + "\\n");
const isPack = args.includes("pack");
let count = 0;
if (isPack) {
  try { count = Number(readFileSync(${JSON.stringify(counter)}, "utf8")); } catch {}
  count += 1;
  writeFileSync(${JSON.stringify(counter)}, String(count));
}
if (${JSON.stringify(behavior)} === "fail-sixth" && isPack && count === 6) process.exit(73);
const result = spawnSync(${JSON.stringify(findPnpm())}, args, { cwd: process.cwd(), env: process.env, encoding: "utf8" });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.status !== 0) process.exit(result.status ?? 74);
if (${JSON.stringify(behavior)} === "mutate-sixth" && isPack && count === 6) {
  const bytes = readFileSync(${JSON.stringify(mutationTarget)});
  bytes[0] ^= 1;
  writeFileSync(${JSON.stringify(mutationTarget)}, bytes);
}
if (["hostile-first", "hostile-mtime-first", "hostile-unused-header-first", "hostile-padding-first"].includes(${JSON.stringify(behavior)}) && isPack && count === 1) {
  const output = args[args.indexOf("--pack-destination") + 1];
  const archivePath = join(output, readdirSync(output).find((name) => name.endsWith(".tgz")));
  const original = readFileSync(archivePath);
  const tar = gunzipSync(original);
  if (${JSON.stringify(behavior)} === "hostile-first") tar[156] = 0x32;
  else if (${JSON.stringify(behavior)} === "hostile-mtime-first") tar.write("00000000001\\0", 136, 12, "ascii");
  else if (${JSON.stringify(behavior)} === "hostile-unused-header-first") tar[329] = 0x31;
  else {
    const size = Number.parseInt(tar.subarray(124, 136).toString("ascii").replace(/\\0.*$/, "").trim(), 8);
    if (size % 512 === 0) process.exit(75);
    tar[512 + size] = 0x7f;
  }
  if (${JSON.stringify(behavior)} !== "hostile-padding-first") {
    tar.fill(0x20, 148, 156);
    let checksum = 0;
    for (let index = 0; index < 512; index += 1) checksum += tar[index];
    tar.write(checksum.toString(8).padStart(6, "0") + " \\0", 148, 8, "ascii");
  }
  const replacement = gzipSync(tar, { level: 9, mtime: 0 });
  original.copy(replacement, 0, 0, 10);
  writeFileSync(archivePath, replacement);
}
if (${JSON.stringify(behavior)} === "hostile-concatenated-gzip-first" && isPack && count === 1) {
  const output = args[args.indexOf("--pack-destination") + 1];
  const archivePath = join(output, readdirSync(output).find((name) => name.endsWith(".tgz")));
  const second = gzipSync(Buffer.alloc(1024), { level: 9, mtime: 0 });
  const namedSecond = Buffer.concat([
    second.subarray(0, 3),
    Buffer.from([0x08]),
    second.subarray(4, 10),
    Buffer.from("SECRET-FILENAME\\0", "ascii"),
    second.subarray(10),
  ]);
  appendFileSync(archivePath, namedSecond);
}
if (${JSON.stringify(behavior)} === "hostile-missing-tar-eof-first" && isPack && count === 1) {
  const output = args[args.indexOf("--pack-destination") + 1];
  const archivePath = join(output, readdirSync(output).find((name) => name.endsWith(".tgz")));
  const original = readFileSync(archivePath);
  const tar = gunzipSync(original);
  if (tar.length < 1024 || !tar.subarray(tar.length - 1024).every((byte) => byte === 0)) process.exit(76);
  const replacement = gzipSync(tar.subarray(0, tar.length - 1024), { level: 9, mtime: 0 });
  original.copy(replacement, 0, 0, 10);
  writeFileSync(archivePath, replacement);
}
`;
  writeFileSync(wrapper, source, { mode: 0o700 });
  chmodSync(wrapper, 0o700);
  return Object.freeze({
    log,
    path: `${wrapperDirectory}${delimiter}${process.env.PATH}`,
    records() {
      return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    },
  });
}

async function withPath(path, operation) {
  const original = process.env.PATH;
  process.env.PATH = path;
  try {
    return await operation();
  } finally {
    if (original === undefined) delete process.env.PATH;
    else process.env.PATH = original;
  }
}

async function startPromotionReplacementWatcher(fixture, outputDirectory) {
  const watcherPath = resolve(fixture.sandbox, "promotion-replacement-watcher.mjs");
  const capturedPath = resolve(fixture.sandbox, "captured-archive.tgz");
  writeFileSync(watcherPath, `import {
  chmodSync,
  readdirSync,
  renameSync,
  watch,
  writeFileSync,
} from "node:fs";
const [outputDirectory, capturedPath] = process.argv.slice(2);
let replaced = false;
const replace = () => {
  if (replaced) return;
  const filename = readdirSync(outputDirectory).find((name) => name.endsWith(".tgz"));
  if (filename === undefined) return;
  replaced = true;
  const target = outputDirectory + "/" + filename;
  renameSync(target, capturedPath);
  writeFileSync(target, "FOREIGN-BYTES", { flag: "wx", mode: 0o640 });
  chmodSync(target, 0o640);
  process.stdout.write("REPLACED:" + filename + "\\n");
  watcher.close();
};
const watcher = watch(outputDirectory, replace);
const interval = setInterval(replace, 1);
process.stdout.write("READY\\n");
setTimeout(() => process.exit(76), 15_000);
process.on("exit", () => clearInterval(interval));
`, { mode: 0o600 });
  const child = spawn(process.execPath, [watcherPath, outputDirectory, capturedPath], {
    cwd: fixture.sandbox,
    env: {
      PATH: process.env.PATH,
      HOME: fixture.sandbox,
      TMPDIR: fixture.sandbox,
      LANG: "C",
      LC_ALL: "C",
      TZ: "UTC",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errorOutput = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { errorOutput += chunk; });
  const waitFor = async (marker) => {
    const deadline = Date.now() + 15_000;
    while (!output.includes(marker)) {
      if (child.exitCode !== null) throw new Error(`promotion watcher exited ${child.exitCode}: ${errorOutput}`);
      if (Date.now() >= deadline) throw new Error("promotion watcher timed out");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
  };
  await waitFor("READY\n");
  return Object.freeze({
    capturedPath,
    child,
    async replacement() {
      await waitFor("REPLACED:");
      return output.match(/REPLACED:([^\n]+)\n/)?.[1];
    },
  });
}

test("stages the seven catalogued npm artifacts without mutating their built sources", async () => {
  const temporaryRoot = realpathSync(mkdtempSync(resolve(tmpdir(), "gauntlet-stage-npm-test-")));
  const outputDirectory = resolve(temporaryRoot, "output");
  mkdirSync(outputDirectory, { mode: 0o700 });
  const sourceBytes = new Map(
    RELEASE_ARTIFACTS.npm.map(({ directory }) => [
      directory,
      readFileSync(resolve(REPOSITORY_ROOT, directory, "dist/index.js")),
    ]),
  );

  try {
    const artifacts = await stageNpmPackages({ root: REPOSITORY_ROOT, outputDirectory });
    assert.equal(artifacts.length, 7);
    assert.deepEqual(artifacts.map(({ kind }) => kind), Array(7).fill("npm"));
    assert.deepEqual(
      artifacts.map(({ name }) => name),
      [...RELEASE_ARTIFACTS.npm.map(({ name }) => name)].sort(),
    );
    for (const artifact of artifacts) {
      assert.equal(artifact.version, RELEASE_VERSION);
      assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
      assert.equal(resolve(artifact.path), artifact.path);
      assert.equal(statSync(artifact.path).mode & 0o777, 0o600);
      assert.equal(statSync(artifact.path).size < 50 * 1024 * 1024, true);
      assert.equal(createHash("sha256").update(readFileSync(artifact.path)).digest("hex"), artifact.sha256);
      assert.deepEqual(Object.keys(artifact), ["kind", "name", "version", "path", "sha256"]);
      assert.equal(Object.isFrozen(artifact), true);

      const archive = readArchive(artifact.path);
      const manifestEntry = archive.get("package/package.json");
      const readmeEntry = archive.get("package/README.md");
      const licenseEntry = archive.get("package/LICENSE");
      assert.ok(manifestEntry);
      assert.ok(readmeEntry);
      assert.ok(licenseEntry);
      assert.equal(manifestEntry.mode, 0o644);
      assert.equal(readmeEntry.mode, 0o644);
      assert.equal(licenseEntry.mode, 0o644);
      assert.deepEqual(licenseEntry.payload, readFileSync(resolve(REPOSITORY_ROOT, "LICENSE")));
      const manifest = JSON.parse(manifestEntry.payload.toString("utf8"));
      assert.equal(manifest.name, artifact.name);
      assert.equal(manifest.version, RELEASE_VERSION);
      assert.equal(manifest.license, "Apache-2.0");
      assert.deepEqual(manifest.files, EXACT_FILES.get(artifact.name));
      assert.deepEqual(manifest.publishConfig, {
        access: "public",
        registry: "https://registry.npmjs.org/",
      });
      assert.equal(manifest.scripts, undefined);
      assert.equal(manifest.devDependencies, undefined);
      for (const value of Object.values(manifest.dependencies ?? {})) {
        assert.equal(String(value).startsWith("workspace:"), false);
      }
      for (const name of archive.keys()) {
        assert.doesNotMatch(name, /(?:^|\/)(?:src|test|tests|node_modules)(?:\/|$)/);
        assert.doesNotMatch(name, /(?:\.env|pnpm-lock\.yaml|tsconfig\.json|\.npmrc|\.pnpmfile\.cjs)$/);
      }
    }
    assert.equal(Object.isFrozen(artifacts), true);
    for (const [directory, bytes] of sourceBytes) {
      assert.deepEqual(readFileSync(resolve(REPOSITORY_ROOT, directory, "dist/index.js")), bytes);
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("rejects a credential-bearing dependency before producing any archive", async () => {
  const fixture = createFixture();
  const outputDirectory = fixture.output();
  try {
    const manifestPath = resolve(fixture.root, "packages/protocol/package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.dependencies["credential-bearing-fixture"] = "https://admin:SECRET@example.invalid/archive.tgz";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(
      stageNpmPackages({ root: fixture.root, outputDirectory }),
      { message: "NPM package staging failed closed" },
    );
    assert.deepEqual(readdirSync(outputDirectory), []);
  } finally {
    fixture.cleanup();
  }
});

test("rejects an undeclared stable dependency instead of trusting the source manifest", async () => {
  const fixture = createFixture();
  const outputDirectory = fixture.output();
  try {
    const manifestPath = resolve(fixture.root, "packages/protocol/package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.dependencies["undeclared-fixture"] = "1.2.3";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(
      stageNpmPackages({ root: fixture.root, outputDirectory }),
      { message: "NPM package staging failed closed" },
    );
    assert.deepEqual(readdirSync(outputDirectory), []);
  } finally {
    fixture.cleanup();
  }
});

test("is deterministic, mutation-sensitive, and never executes source lifecycle or pnpmfile code", async () => {
  const fixture = createFixture();
  try {
    const before = snapshotTree(fixture.root);
    const first = await stageNpmPackages({ root: fixture.root, outputDirectory: fixture.output("first") });
    assert.deepEqual(snapshotTree(fixture.root), before);
    const second = await stageNpmPackages({ root: fixture.root, outputDirectory: fixture.output("second") });
    assert.deepEqual(snapshotTree(fixture.root), before);
    assert.deepEqual(
      second.map(({ name, sha256 }) => [name, sha256]),
      first.map(({ name, sha256 }) => [name, sha256]),
    );

    const changedSource = resolve(fixture.root, "packages/dashboard-client/dist/index.js");
    writeFileSync(changedSource, Buffer.concat([readFileSync(changedSource), Buffer.from("\n")]), { mode: 0o644 });
    const third = await stageNpmPackages({ root: fixture.root, outputDirectory: fixture.output("third") });
    const firstHashes = new Map(first.map(({ name, sha256 }) => [name, sha256]));
    for (const { name, sha256 } of third) {
      assert.equal(
        sha256 === firstHashes.get(name),
        name !== "@8lines/gauntlet-dashboard-client",
      );
    }
  } finally {
    fixture.cleanup();
  }
});

test("rejects a control-character payload path before packaging", async () => {
  const fixture = createFixture();
  const outputDirectory = fixture.output();
  try {
    writeFileSync(
      resolve(fixture.root, "packages/dashboard-client/dist/hostile\nname.js"),
      "export {};\n",
      { mode: 0o644 },
    );
    await assert.rejects(
      stageNpmPackages({ root: fixture.root, outputDirectory }),
      { message: "NPM package staging failed closed" },
    );
    assert.deepEqual(readdirSync(outputDirectory), []);
  } finally {
    fixture.cleanup();
  }
});

test("the staging interface rejects exotic objects without invoking accessors", async () => {
  const temporaryRoot = realpathSync(mkdtempSync(resolve(tmpdir(), "gauntlet-stage-npm-options-")));
  const outputDirectory = createOutput(temporaryRoot, "output");
  let getterCalls = 0;
  const getterOptions = { outputDirectory };
  Object.defineProperty(getterOptions, "root", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return REPOSITORY_ROOT;
    },
  });
  const symbolOptions = { root: REPOSITORY_ROOT, outputDirectory };
  symbolOptions[Symbol("hostile")] = true;
  const cases = [
    null,
    [],
    { root: REPOSITORY_ROOT },
    { root: REPOSITORY_ROOT, outputDirectory, extra: true },
    getterOptions,
    symbolOptions,
    new Proxy({ root: REPOSITORY_ROOT, outputDirectory }, {}),
  ];
  try {
    for (const options of cases) {
      await assert.rejects(
        stageNpmPackages(options),
        { name: "TypeError", message: "NPM staging options must be a closed data object" },
      );
    }
    assert.equal(getterCalls, 0);
    assert.deepEqual(readdirSync(outputDirectory), []);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("refuses non-private, linked, and non-empty outputs without clobbering foreign bytes", async () => {
  const fixture = createFixture();
  try {
    const permissive = fixture.output("permissive");
    chmodSync(permissive, 0o755);
    await assert.rejects(stageNpmPackages({ root: fixture.root, outputDirectory: permissive }), {
      name: "TypeError",
      message: "NPM staging output must be a safe canonical directory",
    });

    const realOutput = fixture.output("real-output");
    const linkedOutput = resolve(fixture.sandbox, "linked-output");
    symlinkSync(realOutput, linkedOutput, "dir");
    await assert.rejects(stageNpmPackages({ root: fixture.root, outputDirectory: linkedOutput }), {
      name: "TypeError",
      message: "NPM staging output must be a safe canonical directory",
    });

    const occupied = fixture.output("occupied");
    const foreign = resolve(occupied, "8lines-gauntlet-protocol-0.1.0.tgz");
    const sentinel = Buffer.from("foreign archive\n");
    writeFileSync(foreign, sentinel, { mode: 0o600 });
    await assert.rejects(
      stageNpmPackages({ root: fixture.root, outputDirectory: occupied }),
      { message: "NPM package staging failed closed" },
    );
    assert.deepEqual(readFileSync(foreign), sentinel);
    assert.deepEqual(readdirSync(occupied), ["8lines-gauntlet-protocol-0.1.0.tgz"]);
  } finally {
    fixture.cleanup();
  }
});

test("rejects linked, undeclared, and manifest-expanded package sources before packaging", async () => {
  const mutateCases = [
    (fixture) => {
      writeFileSync(resolve(fixture.root, "packages/dashboard-client/dist/.env"), "SECRET=value\n");
    },
    (fixture) => {
      const readme = resolve(fixture.root, "packages/dashboard-client/README.md");
      const outside = resolve(fixture.sandbox, "outside.md");
      writeFileSync(outside, "foreign\n");
      unlinkSync(readme);
      symlinkSync(outside, readme);
    },
    (fixture) => {
      const manifestPath = resolve(fixture.root, "packages/dashboard-client/package.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.files.push("src");
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    },
  ];
  for (const mutate of mutateCases) {
    const fixture = createFixture();
    const outputDirectory = fixture.output();
    try {
      mutate(fixture);
      await assert.rejects(
        stageNpmPackages({ root: fixture.root, outputDirectory }),
        { message: "NPM package staging failed closed" },
      );
      assert.deepEqual(readdirSync(outputDirectory), []);
    } finally {
      fixture.cleanup();
    }
  }
});

test("invokes only pinned offline pnpm packing with a positive credential-free environment", async () => {
  const fixture = createFixture();
  const outputDirectory = fixture.output();
  const wrapper = createPnpmWrapper(fixture, "pass");
  try {
    await withPath(wrapper.path, () => stageNpmPackages({ root: fixture.root, outputDirectory }));
    const records = wrapper.records();
    assert.equal(records.length, 8);
    assert.deepEqual(records[0].args, ["--version"]);
    const environmentKeys = [
      "CI",
      "COREPACK_ENABLE_DOWNLOAD_PROMPT",
      "HOME",
      "LANG",
      "LC_ALL",
      "NO_COLOR",
      "PATH",
      "TMPDIR",
      "TZ",
      "npm_config_cache",
      "npm_config_ignore_scripts",
      "npm_config_registry",
      "npm_config_update_notifier",
      "npm_config_userconfig",
    ];
    if (process.platform === "darwin") environmentKeys.push("__CF_USER_TEXT_ENCODING");
    environmentKeys.sort();
    for (const [index, record] of records.entries()) {
      assert.deepEqual(Object.keys(record.env).sort(), environmentKeys);
      assert.equal(record.env.npm_config_ignore_scripts, "true");
      assert.equal(record.env.npm_config_registry, "http://127.0.0.1:9");
      assert.doesNotMatch(JSON.stringify(record.env), /(?:auth|password|secret|token)/i);
      if (index === 0) continue;
      assert.deepEqual(record.args.slice(0, 5), [
        "--config.ignore-scripts=true",
        "--config.ignore-pnpmfile=true",
        "--config.offline=true",
        "pack",
        "--json",
      ]);
      assert.deepEqual(record.args.slice(5, 7), ["--pack-destination", record.args[6]]);
      assert.equal(record.args.length, 7);
    }
  } finally {
    fixture.cleanup();
  }
});

test("rejects a promoted archive replaced by a same-UID watcher without touching foreign bytes", async () => {
  const fixture = createFixture();
  const outputDirectory = fixture.output();
  let watcher;
  try {
    watcher = await startPromotionReplacementWatcher(fixture, outputDirectory);
    const staging = stageNpmPackages({ root: fixture.root, outputDirectory });
    const [filename] = await Promise.all([
      watcher.replacement(),
      assert.rejects(staging, { message: "NPM package staging failed closed" }),
    ]);
    assert.equal(typeof filename, "string");
    const foreignPath = resolve(outputDirectory, filename);
    assert.equal(readFileSync(foreignPath, "utf8"), "FOREIGN-BYTES");
    assert.equal(statSync(foreignPath).mode & 0o777, 0o640);
    assert.equal(readFileSync(watcher.capturedPath).length > 0, true);
  } finally {
    if (watcher?.child.exitCode === null) watcher.child.kill("SIGKILL");
    fixture.cleanup();
  }
});

test("packed consumer owns its HOME, configuration, cache, and offline store", () => {
  const sandbox = realpathSync(mkdtempSync(resolve(tmpdir(), "gauntlet-packed-home-test-")));
  const callerHome = resolve(sandbox, "caller-home");
  const callerConfig = resolve(sandbox, "caller-config");
  mkdirSync(callerHome, { mode: 0o700 });
  mkdirSync(callerConfig, { mode: 0o700 });
  writeFileSync(resolve(callerHome, ".npmrc"), "store-dir=./caller-store\n", { mode: 0o600 });
  writeFileSync(resolve(callerConfig, "sentinel"), "CALLER-CONFIG\n", { mode: 0o600 });
  const before = snapshotTree(sandbox);
  try {
    const result = spawnSync(process.execPath, [resolve(REPOSITORY_ROOT, "scripts/test-packed-npm-packages.mjs")], {
      cwd: REPOSITORY_ROOT,
      env: {
        PATH: process.env.PATH,
        HOME: callerHome,
        XDG_CONFIG_HOME: callerConfig,
        TMPDIR: tmpdir(),
        LANG: "C",
        LC_ALL: "C",
        TZ: "UTC",
        CI: "true",
        NO_COLOR: "1",
        COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
      },
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 64 * 1024,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.deepEqual(snapshotTree(sandbox), before);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("late pack failure, source race, and hostile archives leave the output empty", async (t) => {
  for (const behavior of [
    "fail-sixth",
    "mutate-sixth",
    "hostile-first",
    "hostile-mtime-first",
    "hostile-concatenated-gzip-first",
    "hostile-missing-tar-eof-first",
    "hostile-unused-header-first",
    "hostile-padding-first",
  ]) {
    await t.test(behavior, async () => {
      const fixture = createFixture();
      const outputDirectory = fixture.output();
      const wrapper = createPnpmWrapper(fixture, behavior);
      try {
        await assert.rejects(
          withPath(wrapper.path, () => stageNpmPackages({ root: fixture.root, outputDirectory })),
          { message: "NPM package staging failed closed" },
        );
        assert.deepEqual(readdirSync(outputDirectory), []);
      } finally {
        fixture.cleanup();
      }
    });
  }
});
