import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { gzipSync, gunzipSync } from "node:zlib";

let packager = {};
try {
  packager = await import("./package-chart.mjs");
} catch {
  // RED is expressed by the contract assertions below, not by a loader error.
}

const repositoryRoot = realpathSync(new URL("../..", import.meta.url));
const chartRoot = join(repositoryRoot, "deploy", "helm", "gauntlet");
const normalizedMtimeMs = Date.UTC(2000, 0, 1, 0, 0, 0);
const sourcePaths = [
  ".helmignore",
  "Chart.yaml",
  "templates/NOTES.txt",
  "templates/_configuration.tpl",
  "templates/_helpers.tpl",
  "templates/configmap.yaml",
  "templates/deployment.yaml",
  "templates/ingress.yaml",
  "templates/networkpolicy.yaml",
  "templates/service.yaml",
  "values.schema.json",
  "values.yaml",
];
if (existsSync(join(chartRoot, "LICENSE"))) sourcePaths.push("LICENSE");
sourcePaths.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));

const archivePaths = [
  "gauntlet/Chart.yaml",
  "gauntlet/values.yaml",
  "gauntlet/values.schema.json",
  "gauntlet/templates/NOTES.txt",
  "gauntlet/templates/_configuration.tpl",
  "gauntlet/templates/_helpers.tpl",
  "gauntlet/templates/configmap.yaml",
  "gauntlet/templates/deployment.yaml",
  "gauntlet/templates/ingress.yaml",
  "gauntlet/templates/networkpolicy.yaml",
  "gauntlet/templates/service.yaml",
];
if (sourcePaths.includes("LICENSE")) archivePaths.push("gauntlet/LICENSE");
const canonicalChartPayload = Buffer.from([
  "annotations:",
  "  artifacthub.io/license: Apache-2.0",
  "apiVersion: v2",
  "appVersion: 0.1.7",
  "description: Private non-production Gauntlet control plane and dashboard",
  "kubeVersion: '>=1.33.0-0'",
  "name: gauntlet",
  "type: application",
  "version: 0.1.7",
  "",
].join("\n"));

function makeTemporaryDirectory(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function copyChartFixture() {
  const root = makeTemporaryDirectory("gauntlet-package-source-test-");
  const destination = join(root, "deploy", "helm", "gauntlet");
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(chartRoot, destination, { recursive: true, verbatimSymlinks: true });
  return root;
}

function walkTree(root) {
  const directories = [""];
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = lstatSync(join(root, path));
      assert.equal(stat.isSymbolicLink(), false, path);
      if (stat.isDirectory()) {
        directories.push(path);
        visit(path);
      } else {
        assert.equal(stat.isFile(), true, path);
        files.push(path);
      }
    }
  };
  visit("");
  return {
    directories: directories.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))),
    files: files.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))),
  };
}

function removeGeneratedTree(root) {
  const unlockDirectories = (path) => {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    chmodSync(path, 0o700);
    for (const entry of readdirSync(path)) unlockDirectories(join(path, entry));
  };
  unlockDirectories(root);
  rmSync(root, { recursive: true, force: true });
}

function tarText(block, offset, length) {
  return block.subarray(offset, offset + length).toString("utf8").replace(/\0.*$/s, "");
}

function tarOctal(block, offset, length) {
  const value = tarText(block, offset, length).trim();
  assert.match(value, /^[0-7]+$/);
  return Number.parseInt(value, 8);
}

function parseStrictTar(archive) {
  assert.equal(archive[0], 0x1f);
  assert.equal(archive[1], 0x8b);
  assert.equal(archive.readUInt32LE(4), 0, "gzip header timestamp must be zero");
  const tar = gunzipSync(archive);
  assert.equal(tar.length % 512, 0);
  const entries = [];
  let offset = 0;
  let zeroBlocks = 0;
  while (offset < tar.length) {
    const header = tar.subarray(offset, offset + 512);
    assert.equal(header.length, 512);
    if (header.every((byte) => byte === 0)) {
      zeroBlocks += 1;
      offset += 512;
      continue;
    }
    assert.equal(zeroBlocks, 0, "non-zero data after tar terminator");
    const storedChecksum = tarOctal(header, 148, 8);
    let computedChecksum = 0;
    for (let index = 0; index < header.length; index += 1) {
      computedChecksum += index >= 148 && index < 156 ? 0x20 : header[index];
    }
    assert.equal(storedChecksum, computedChecksum, "tar header checksum");
    assert.equal(tarText(header, 257, 6), "ustar");
    assert.equal(tarText(header, 263, 2), "00");
    const name = tarText(header, 0, 100);
    const prefix = tarText(header, 345, 155);
    const size = tarOctal(header, 124, 12);
    const typeByte = header[156];
    const payloadOffset = offset + 512;
    const payloadEnd = payloadOffset + size;
    assert.ok(payloadEnd <= tar.length, "tar payload is bounded");
    entries.push({
      name: prefix.length === 0 ? name : `${prefix}/${name}`,
      mode: tarOctal(header, 100, 8),
      uid: tarOctal(header, 108, 8),
      gid: tarOctal(header, 116, 8),
      size,
      mtime: tarOctal(header, 136, 12),
      type: typeByte === 0 ? "0" : String.fromCharCode(typeByte),
      linkname: tarText(header, 157, 100),
      uname: tarText(header, 265, 32),
      gname: tarText(header, 297, 32),
      payload: tar.subarray(payloadOffset, payloadEnd),
    });
    offset = payloadOffset + Math.ceil(size / 512) * 512;
  }
  assert.ok(zeroBlocks >= 2, "tar terminator must contain at least two zero blocks");
  return entries;
}

test("the package projection is a closed, normalized regular-file chart", () => {
  assert.equal(typeof packager.createChartPackageProjection, "function");
  const projection = packager.createChartPackageProjection({ sourceRepositoryRoot: repositoryRoot });
  try {
    const tree = walkTree(projection.chartDirectory);
    assert.deepEqual(tree.files, sourcePaths);
    assert.deepEqual(tree.directories, ["", "templates"]);
    for (const directory of [
      projection.repositoryRoot,
      join(projection.repositoryRoot, "deploy"),
      join(projection.repositoryRoot, "deploy", "helm"),
      projection.chartDirectory,
      join(projection.chartDirectory, "templates"),
    ]) {
      const stat = lstatSync(directory);
      assert.equal(stat.mode & 0o777, 0o555, directory);
      assert.equal(stat.mtimeMs, normalizedMtimeMs, directory);
    }
    for (const path of sourcePaths) {
      const projectedPath = join(projection.chartDirectory, path);
      const stat = lstatSync(projectedPath);
      assert.equal(stat.mode & 0o777, 0o444, path);
      assert.equal(stat.mtimeMs, normalizedMtimeMs, path);
      assert.deepEqual(readFileSync(projectedPath), readFileSync(join(chartRoot, path)), path);
    }
    assert.equal(projection.version, "0.1.7");
  } finally {
    projection.dispose();
  }
  assert.equal(existsSync(projection.repositoryRoot), false);
});

test("the package projection rejects additions, links, and special files without leaking names", () => {
  assert.equal(typeof packager.createChartPackageProjection, "function");
  const sentinel = "package-source-sentinel-842175";
  const fixtures = [];
  try {
    const extra = copyChartFixture();
    fixtures.push(extra);
    writeFileSync(join(extra, "deploy", "helm", "gauntlet", sentinel), "extra\n");

    const linked = copyChartFixture();
    fixtures.push(linked);
    const linkedService = join(linked, "deploy", "helm", "gauntlet", "templates", "service.yaml");
    rmSync(linkedService);
    symlinkSync(join(chartRoot, "templates", "service.yaml"), linkedService);

    const special = copyChartFixture();
    fixtures.push(special);
    const specialService = join(special, "deploy", "helm", "gauntlet", "templates", "service.yaml");
    rmSync(specialService);
    const mkfifo = spawnSync("mkfifo", [specialService], { encoding: "utf8", stdio: "pipe" });
    assert.equal(mkfifo.status, 0, "mkfifo test prerequisite");

    for (const sourceRepositoryRoot of [extra, linked, special]) {
      assert.throws(
        () => packager.createChartPackageProjection({ sourceRepositoryRoot }),
        (error) => {
          assert.equal(error.message, "Chart package source must match the closed regular-file layout");
          assert.equal(error.message.includes(sentinel), false);
          return true;
        },
      );
    }
  } finally {
    for (const fixture of fixtures) rmSync(fixture, { recursive: true, force: true });
  }
});

test("source race checks reject FIFO swaps, ancestor swaps, and same-size mutations", () => {
  assert.equal(typeof packager.createChartPackageProjection, "function");
  const fixtures = [];
  const sentinel = "source-race-sentinel-249731";
  try {
    const fifoSource = copyChartFixture();
    fixtures.push(fifoSource);
    const fifoService = join(fifoSource, "deploy", "helm", "gauntlet", "templates", "service.yaml");
    let fifoDescriptor;
    assert.throws(
      () => packager.createChartPackageProjection({
        sourceRepositoryRoot: fifoSource,
        testingHooks: {
          beforeSourceOpen({ relativePath }) {
            if (relativePath !== "templates/service.yaml") return;
            rmSync(fifoService);
            assert.equal(spawnSync("mkfifo", [fifoService]).status, 0);
          },
          sourceDescriptorOpened({ descriptor, relativePath }) {
            if (relativePath === "templates/service.yaml") fifoDescriptor = descriptor;
          },
        },
      }),
      (error) => {
        assert.equal(error.message, "Chart package source must match the closed regular-file layout");
        return true;
      },
    );
    assert.equal(Number.isSafeInteger(fifoDescriptor), true);
    assert.throws(() => fstatSync(fifoDescriptor), /bad file descriptor/i);

    const ancestorSource = copyChartFixture();
    fixtures.push(ancestorSource);
    const templates = join(ancestorSource, "deploy", "helm", "gauntlet", "templates");
    const displacedTemplates = `${templates}-original`;
    const foreignTemplates = join(ancestorSource, "foreign-templates");
    mkdirSync(foreignTemplates);
    writeFileSync(join(foreignTemplates, "service.yaml"), `${sentinel}\n`);
    assert.throws(
      () => packager.createChartPackageProjection({
        sourceRepositoryRoot: ancestorSource,
        testingHooks: {
          beforeSourceOpen({ relativePath }) {
            if (relativePath !== "templates/service.yaml") return;
            renameSync(templates, displacedTemplates);
            symlinkSync(foreignTemplates, templates);
          },
        },
      }),
      (error) => {
        assert.equal(error.message, "Chart package source must match the closed regular-file layout");
        assert.equal(error.message.includes(sentinel), false);
        return true;
      },
    );

    const changingSource = copyChartFixture();
    fixtures.push(changingSource);
    const changingService = join(changingSource, "deploy", "helm", "gauntlet", "templates", "service.yaml");
    const original = readFileSync(changingService);
    const changed = Buffer.from(original);
    changed[0] ^= 1;
    assert.equal(changed.length, original.length);
    assert.throws(
      () => packager.createChartPackageProjection({
        sourceRepositoryRoot: changingSource,
        testingHooks: {
          betweenSourceReads({ relativePath }) {
            if (relativePath === "templates/service.yaml") writeFileSync(changingService, changed);
          },
        },
      }),
      /closed regular-file layout/,
    );
  } finally {
    for (const fixture of fixtures) rmSync(fixture, { recursive: true, force: true });
  }
});

test("the Helm output workspace is private, minimally writable, and disposable", () => {
  assert.equal(typeof packager.createPrivatePackageOutput, "function");
  const output = packager.createPrivatePackageOutput();
  try {
    const parent = lstatSync(output.workspaceRoot);
    const directory = lstatSync(output.directory);
    assert.equal(parent.mode & 0o777, 0o700);
    assert.equal(directory.mode & 0o777, 0o733);
    assert.equal(directory.mode & 0o044, 0, "the writable mount is not world-readable");
    if (typeof process.getuid === "function") assert.equal(directory.uid, process.getuid());
    if (typeof process.getgid === "function") assert.equal(directory.gid, process.getgid());
  } finally {
    output.dispose();
  }
  assert.equal(existsSync(output.workspaceRoot), false);
});

test("projection and output disposal remain retryable after bounded cleanup failures", () => {
  let projectionAttempts = 0;
  const projection = packager.createChartPackageProjection({
    sourceRepositoryRoot: repositoryRoot,
    testingHooks: {
      beforeProjectionDispose() {
        projectionAttempts += 1;
        if (projectionAttempts === 1) throw new Error("cleanup-trap-sentinel-671208");
      },
    },
  });
  assert.throws(
    () => projection.dispose(),
    (error) => {
      assert.equal(error.message, "Chart package projection cleanup could not complete");
      assert.equal(error.message.includes("cleanup-trap-sentinel-671208"), false);
      return true;
    },
  );
  assert.equal(existsSync(projection.repositoryRoot), true);
  projection.dispose();
  assert.equal(existsSync(projection.repositoryRoot), false);

  let outputAttempts = 0;
  const output = packager.createPrivatePackageOutput({
    testingHooks: {
      beforeOutputDispose() {
        outputAttempts += 1;
        if (outputAttempts === 1) throw new Error("cleanup-trap-sentinel-671208");
      },
    },
  });
  assert.throws(
    () => output.dispose(),
    (error) => {
      assert.equal(error.message, "Private chart package output cleanup could not complete");
      assert.equal(error.message.includes("cleanup-trap-sentinel-671208"), false);
      return true;
    },
  );
  assert.equal(existsSync(output.workspaceRoot), true);
  output.dispose();
  assert.equal(existsSync(output.workspaceRoot), false);
});

test("disposal revalidates nonce workspaces at the exact unlock and remove boundaries", () => {
  const fixture = makeTemporaryDirectory("gauntlet-package-dispose-race-");
  const foreign = join(fixture, "foreign");
  const foreignSentinel = join(foreign, "sentinel");
  mkdirSync(foreign);
  writeFileSync(foreignSentinel, "foreign-must-survive\n");
  let projectionSwapCount = 0;
  let projectionWorkspace;
  const projection = packager.createChartPackageProjection({
    sourceRepositoryRoot: repositoryRoot,
    testingHooks: {
      beforeProjectionRemove({ workspaceRoot }) {
        projectionWorkspace = workspaceRoot;
        if (projectionSwapCount > 0) return;
        projectionSwapCount += 1;
        renameSync(workspaceRoot, `${workspaceRoot}-owned`);
        symlinkSync(foreign, workspaceRoot);
      },
    },
  });
  assert.throws(() => projection.dispose(), /projection cleanup could not complete/);
  assert.equal(readFileSync(foreignSentinel, "utf8"), "foreign-must-survive\n");
  rmSync(projectionWorkspace);
  renameSync(`${projectionWorkspace}-owned`, projectionWorkspace);
  projection.dispose();

  let outputSwapCount = 0;
  const output = packager.createPrivatePackageOutput({
    testingHooks: {
      beforeOutputRemove({ workspaceRoot }) {
        if (outputSwapCount > 0) return;
        outputSwapCount += 1;
        renameSync(workspaceRoot, `${workspaceRoot}-owned`);
        symlinkSync(foreign, workspaceRoot);
      },
    },
  });
  assert.throws(() => output.dispose(), /output cleanup could not complete/);
  assert.equal(readFileSync(foreignSentinel, "utf8"), "foreign-must-survive\n");
  rmSync(output.workspaceRoot);
  renameSync(`${output.workspaceRoot}-owned`, output.workspaceRoot);
  output.dispose();
  rmSync(fixture, { recursive: true, force: true });
});

test("archive validation rejects a high-ratio gzip before unbounded tar inflation", () => {
  assert.equal(typeof packager.validateChartPackageArchive, "function");
  const projection = packager.createChartPackageProjection({ sourceRepositoryRoot: repositoryRoot });
  try {
    const compressedBomb = gzipSync(Buffer.alloc(10 * 1024 * 1024));
    assert.ok(compressedBomb.length < 16 * 1024);
    assert.throws(
      () => packager.validateChartPackageArchive(compressedBomb, projection),
      (error) => {
        assert.equal(error.message, "Pinned Helm produced an invalid chart package");
        return true;
      },
    );
  } finally {
    projection.dispose();
  }
});

test("the package interface rejects unsafe destinations and exotic option objects", () => {
  assert.equal(typeof packager.parsePackageArguments, "function");
  assert.equal(typeof packager.packageChart, "function");
  const fixture = makeTemporaryDirectory("gauntlet-package-options-test-");
  const destination = join(fixture, "destination");
  const file = join(fixture, "file");
  const link = join(fixture, "link");
  mkdirSync(destination);
  writeFileSync(file, "file\n");
  symlinkSync(destination, link);
  try {
    assert.deepEqual(
      packager.parsePackageArguments(["--destination", destination]),
      { destinationDirectory: destination },
    );
    for (const args of [[], ["--destination"], ["--destination", "relative"], ["--output", destination], ["--destination", destination, "extra"]]) {
      assert.throws(() => packager.parsePackageArguments(args), /package arguments/);
    }
    for (const destinationDirectory of ["relative", "/", file, link]) {
      assert.throws(
        () => packager.packageChart({ destinationDirectory }),
        /package destination/,
      );
    }
    chmodSync(destination, 0o777);
    assert.throws(
      () => packager.packageChart({ destinationDirectory: destination }),
      /package destination/,
    );
    chmodSync(destination, 0o755);

    const accessor = {};
    Object.defineProperty(accessor, "destinationDirectory", {
      enumerable: true,
      get() { throw new Error("package-option-trap-sentinel-197634"); },
    });
    const proxy = new Proxy({ destinationDirectory: destination }, {
      ownKeys() { throw new Error("package-option-trap-sentinel-197634"); },
    });
    const hidden = {};
    Object.defineProperty(hidden, "destinationDirectory", {
      enumerable: false,
      value: destination,
    });
    const symbol = { destinationDirectory: destination };
    symbol[Symbol("hidden")] = destination;
    for (const options of [accessor, hidden, symbol, proxy]) {
      assert.throws(() => packager.packageChart(options), /package options/);
    }

    const validNullPrototype = Object.assign(Object.create(null), {
      sourceRepositoryRoot: repositoryRoot,
    });
    const projection = packager.createChartPackageProjection(validNullPrototype);
    projection.dispose();

    const nestedAccessor = {};
    Object.defineProperty(nestedAccessor, "beforeDestinationOpen", {
      enumerable: true,
      get() { throw new Error("package-option-trap-sentinel-197634"); },
    });
    const nestedHidden = {};
    Object.defineProperty(nestedHidden, "beforeDestinationOpen", {
      enumerable: false,
      value() {},
    });
    const nestedSymbol = { beforeDestinationOpen() {} };
    nestedSymbol[Symbol("hidden")] = () => {};
    const nestedProxy = new Proxy({ beforeDestinationOpen() {} }, {
      getPrototypeOf() { throw new Error("package-option-trap-sentinel-197634"); },
    });
    for (const testingHooks of [nestedAccessor, nestedHidden, nestedSymbol, nestedProxy]) {
      assert.throws(
        () => packager.packageChart({ destinationDirectory: destination, testingHooks }),
        /testing hooks/,
      );
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("destination ancestry accepts only trusted owners and exact system sticky roots", () => {
  assert.equal(typeof packager.validatePackageDestinationPermissions, "function");
  const currentUid = typeof process.geteuid === "function" ? BigInt(process.geteuid()) : 501n;
  const foreignUid = currentUid === 12345n ? 12346n : 12345n;
  const safeLeaf = { path: "/tmp/release", uid: currentUid, mode: 0o40700n };
  const root = { path: "/", uid: 0n, mode: 0o40755n };
  const exactStickyRoots = new Set(["/tmp"]);

  assert.doesNotThrow(() => packager.validatePackageDestinationPermissions([
    root,
    { path: "/tmp", uid: 0n, mode: 0o41777n },
    safeLeaf,
  ], currentUid, exactStickyRoots));
  assert.doesNotThrow(() => packager.validatePackageDestinationPermissions([
    root,
    { path: "/owned", uid: currentUid, mode: 0o40755n },
    { ...safeLeaf, path: "/owned/release" },
  ], currentUid, exactStickyRoots));

  for (const unsafeAncestor of [
    { path: "/foreign", uid: foreignUid, mode: 0o40755n },
    { path: "/foreign-readonly", uid: foreignUid, mode: 0o40555n },
    { path: "/shared", uid: 0n, mode: 0o41777n },
    { path: "/tmp", uid: foreignUid, mode: 0o41777n },
  ]) {
    assert.throws(
      () => packager.validatePackageDestinationPermissions([
        root,
        unsafeAncestor,
        safeLeaf,
      ], currentUid, exactStickyRoots),
      /destination is unsafe/,
    );
  }
  assert.throws(
    () => packager.validatePackageDestinationPermissions([
      root,
      { path: "/owned", uid: currentUid, mode: 0o40755n },
      { ...safeLeaf, uid: foreignUid },
    ], currentUid, exactStickyRoots),
    /destination is unsafe/,
  );
});

test("destination race checks never publish or clean exchanged paths", { timeout: 180_000 }, () => {
  assert.equal(typeof packager.packageChart, "function");
  const fixture = makeTemporaryDirectory("gauntlet-package-destination-race-");
  const destination = join(fixture, "destination");
  const displaced = join(fixture, "destination-original");
  const foreign = join(fixture, "foreign");
  const foreignArchive = join(foreign, "gauntlet-0.1.7.tgz");
  const temporarySwapDestination = join(fixture, "temporary-swap");
  const finalSwapDestination = join(fixture, "final-swap");
  const sentinel = "destination-race-sentinel-915702";
  mkdirSync(destination);
  mkdirSync(foreign);
  mkdirSync(temporarySwapDestination);
  mkdirSync(finalSwapDestination);
  writeFileSync(foreignArchive, sentinel, { mode: 0o600 });
  try {
    assert.throws(
      () => packager.packageChart({
        destinationDirectory: destination,
        testingHooks: {
          beforeDestinationOpen() {
            renameSync(destination, displaced);
            symlinkSync(foreign, destination);
          },
        },
      }),
      (error) => {
        assert.equal(error.message, "Chart package destination changed during packaging");
        assert.equal(error.message.includes(sentinel), false);
        return true;
      },
    );
    assert.equal(readFileSync(foreignArchive, "utf8"), sentinel);
    assert.equal(
      readdirSync(foreign).some((name) => name.startsWith(".gauntlet-chart-")),
      false,
    );

    let exchangedDestinationPath;
    assert.throws(
      () => packager.packageChart({
        destinationDirectory: temporarySwapDestination,
        testingHooks: {
          destinationDescriptorOpened({ destinationPath }) {
            exchangedDestinationPath = destinationPath;
            rmSync(destinationPath);
            writeFileSync(destinationPath, sentinel, { mode: 0o600 });
          },
        },
      }),
      /destination changed during packaging/,
    );
    assert.equal(readFileSync(exchangedDestinationPath, "utf8"), sentinel);

    const exchangedFinalPath = join(finalSwapDestination, "gauntlet-0.1.7.tgz");
    assert.throws(
      () => packager.packageChart({
        destinationDirectory: finalSwapDestination,
        testingHooks: {
          afterDestinationWrite({ destinationPath }) {
            rmSync(destinationPath);
            writeFileSync(destinationPath, sentinel, { mode: 0o600 });
          },
        },
      }),
      /destination changed during packaging/,
    );
    assert.equal(readFileSync(exchangedFinalPath, "utf8"), sentinel);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("package cleanup is independent, preserves primary errors, and cannot undo publication", { timeout: 180_000 }, () => {
  const fixture = makeTemporaryDirectory("gauntlet-package-cleanup-policy-");
  const successfulDestination = join(fixture, "successful");
  const failedDestination = join(fixture, "failed");
  mkdirSync(successfulDestination);
  mkdirSync(failedDestination);
  let leakedOutput;
  let removedProjection;
  let outputCleanupCalls = 0;
  try {
    const receipt = packager.packageChart({
      destinationDirectory: successfulDestination,
      testingHooks: {
        beforeOutputDispose({ workspaceRoot }) {
          leakedOutput = workspaceRoot;
          outputCleanupCalls += 1;
          throw new Error("cleanup-trap-sentinel-508214");
        },
        beforeProjectionDispose({ workspaceRoot }) {
          removedProjection = workspaceRoot;
        },
      },
    });
    assert.equal(receipt.archivePath, join(successfulDestination, "gauntlet-0.1.7.tgz"));
    assert.deepEqual(receipt.cleanupPending, ["helm-output"]);
    assert.equal(existsSync(receipt.archivePath), true);
    assert.equal(outputCleanupCalls, 1);
    assert.equal(existsSync(leakedOutput), true);
    assert.equal(existsSync(removedProjection), false);
    removeGeneratedTree(leakedOutput);

    const cleanupRoots = [];
    assert.throws(
      () => packager.packageChart({
        destinationDirectory: failedDestination,
        testingHooks: {
          beforeDestinationOpen() {
            throw new Error("primary-trap-sentinel-774031");
          },
          beforeOutputDispose({ workspaceRoot }) {
            cleanupRoots.push(workspaceRoot);
            throw new Error("cleanup-trap-sentinel-508214");
          },
          beforeProjectionDispose({ workspaceRoot }) {
            cleanupRoots.push(workspaceRoot);
            throw new Error("cleanup-trap-sentinel-508214");
          },
        },
      }),
      (error) => {
        assert.equal(error.message, "Chart package could not be promoted");
        assert.equal(error.message.includes("trap-sentinel"), false);
        return true;
      },
    );
    assert.equal(cleanupRoots.length, 2);
    assert.equal(existsSync(join(failedDestination, "gauntlet-0.1.7.tgz")), false);
    for (const root of cleanupRoots) {
      assert.equal(existsSync(root), true);
      removeGeneratedTree(root);
    }
  } finally {
    if (leakedOutput !== undefined && existsSync(leakedOutput)) {
      removeGeneratedTree(leakedOutput);
    }
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("the pinned Helm package is exact, deterministic, mutation-sensitive, and no-clobber", { timeout: 180_000 }, () => {
  assert.equal(typeof packager.packageChart, "function");
  const fixture = makeTemporaryDirectory("gauntlet-package-integration-test-");
  const firstDestination = join(fixture, "first");
  const secondDestination = join(fixture, "second");
  const changedDestination = join(fixture, "changed");
  mkdirSync(firstDestination);
  mkdirSync(secondDestination);
  mkdirSync(changedDestination);
  const tempRoot = realpathSync(tmpdir());
  const temporaryNamesBefore = new Set(
    readdirSync(tempRoot).filter((name) => name.startsWith("gauntlet-helm-package-")),
  );
  let mutatedSource;
  try {
    const first = packager.packageChart({ destinationDirectory: firstDestination });
    const second = packager.packageChart({ destinationDirectory: secondDestination });
    assert.deepEqual(first, {
      archivePath: join(firstDestination, "gauntlet-0.1.7.tgz"),
      cleanupPending: [],
      sha256: createHash("sha256").update(readFileSync(first.archivePath)).digest("hex"),
      size: lstatSync(first.archivePath).size,
      version: "0.1.7",
    });
    const firstArchive = readFileSync(first.archivePath);
    const secondArchive = readFileSync(second.archivePath);
    assert.deepEqual(secondArchive, firstArchive, "two normalized builds must be byte-identical");
    assert.equal(lstatSync(first.archivePath).mode & 0o777, 0o600);

    const entries = parseStrictTar(firstArchive);
    assert.equal(entries.length, 11 + (sourcePaths.includes("LICENSE") ? 1 : 0));
    assert.deepEqual(entries.map((entry) => entry.name), archivePaths);
    assert.equal(entries.some((entry) => entry.name.endsWith("/.helmignore")), false);
    for (const entry of entries) {
      assert.deepEqual(
        {
          mode: entry.mode,
          uid: entry.uid,
          gid: entry.gid,
          mtime: entry.mtime,
          type: entry.type,
          linkname: entry.linkname,
          uname: entry.uname,
          gname: entry.gname,
        },
        {
          mode: 0o644,
          uid: 0,
          gid: 0,
          mtime: normalizedMtimeMs / 1000,
          type: "0",
          linkname: "",
          uname: "",
          gname: "",
        },
        entry.name,
      );
      const sourcePath = entry.name.slice("gauntlet/".length);
      const expectedPayload = sourcePath === "Chart.yaml"
        ? canonicalChartPayload
        : readFileSync(join(chartRoot, sourcePath));
      assert.equal(entry.size, expectedPayload.length, entry.name);
      assert.deepEqual(entry.payload, expectedPayload, entry.name);
    }
    const nonCanonicalTar = gunzipSync(firstArchive);
    const canonicalScalar = Buffer.from("kubeVersion: '>=1.33.0-0'");
    const scalarOffset = nonCanonicalTar.indexOf(canonicalScalar);
    assert.ok(scalarOffset > 0);
    nonCanonicalTar[scalarOffset + "kubeVersion: ".length] = '"'.charCodeAt(0);
    nonCanonicalTar[scalarOffset + canonicalScalar.length - 1] = '"'.charCodeAt(0);
    const projection = packager.createChartPackageProjection({ sourceRepositoryRoot: repositoryRoot });
    try {
      assert.throws(
        () => packager.validateChartPackageArchive(gzipSync(nonCanonicalTar), projection),
        /invalid chart package/,
      );
    } finally {
      projection.dispose();
    }

    assert.throws(
      () => packager.packageChart({ destinationDirectory: firstDestination }),
      /already exists/,
    );
    assert.deepEqual(readFileSync(first.archivePath), firstArchive, "no-clobber preserves the record");

    mutatedSource = copyChartFixture();
    appendFileSync(
      join(mutatedSource, "deploy", "helm", "gauntlet", "templates", "NOTES.txt"),
      "\nPackage mutation fixture.\n",
    );
    const changed = packager.packageChart({
      destinationDirectory: changedDestination,
      sourceRepositoryRoot: mutatedSource,
    });
    assert.notDeepEqual(readFileSync(changed.archivePath), firstArchive);
    assert.notEqual(changed.sha256, first.sha256);
  } finally {
    if (mutatedSource !== undefined) rmSync(mutatedSource, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
  const temporaryNamesAfter = readdirSync(tempRoot)
    .filter((name) => name.startsWith("gauntlet-helm-package-"))
    .filter((name) => !temporaryNamesBefore.has(name));
  assert.deepEqual(temporaryNamesAfter, [], "private package workspaces must be removed");
});
