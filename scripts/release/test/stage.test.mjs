import assert from "node:assert/strict";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { RELEASE_ARTIFACTS } from "../release-model.mjs";
import { packageCanonicalTree } from "../tree-archive.mjs";
import {
  RELEASE_STAGE_PHASES,
  executeReleaseStage,
  parseStageArguments,
  stageRelease,
} from "../stage.mjs";
import * as stageModule from "../stage.mjs";
import { COMPOSER_UNIT_IDS } from "../stage-composer.mjs";
import { MAVEN_UNIT_IDS } from "../stage-maven.mjs";
import { NPM_UNIT_IDS } from "../stage-npm.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const VERSION = "0.1.0";

function sandbox(t) {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), "gauntlet-release-stage-test-")));
  chmodSync(root, 0o700);
  const repository = resolve(root, "repository");
  const work = resolve(root, "work");
  for (const directory of [repository, work]) {
    mkdirSync(directory, { mode: 0o700 });
    chmodSync(directory, 0o700);
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { repository, root, work };
}

function write(path, bytes = "artifact\n") {
  mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, bytes, { mode: 0o600 });
}

function regularFiles(root) {
  const result = [];
  const visit = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path, relativePath);
      else if (entry.isFile()) result.push(relativePath);
      else assert.fail(`unexpected staged entry: ${relativePath}`);
    }
  };
  visit(root, "");
  return result.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

function fakeDependencies(calls, failurePhase) {
  const fail = (phase) => {
    calls.push(phase);
    if (failurePhase === phase) throw new Error(`${phase} failed`);
  };
  return {
    packageCanonicalTree,
    async stageNpmPackages({ outputDirectory, versions, include }) {
      fail("npm");
      assert.deepEqual(include, NPM_UNIT_IDS);
      assert.deepEqual(Object.keys(versions), NPM_UNIT_IDS);
      for (const id of NPM_UNIT_IDS) assert.equal(versions[id], VERSION);
      return RELEASE_ARTIFACTS.npm.map((artifact, index) => {
        const path = resolve(outputDirectory, `package-${index}-${VERSION}.tgz`);
        write(path, artifact.name);
        return { kind: "npm", name: artifact.name, path, sha256: "a".repeat(64), version: VERSION };
      });
    },
    async stageComposerPackages({ outputDirectory, sourceCommit, versions, include }) {
      fail("composer");
      assert.deepEqual(include, COMPOSER_UNIT_IDS);
      assert.deepEqual(Object.keys(versions), COMPOSER_UNIT_IDS);
      for (const id of COMPOSER_UNIT_IDS) assert.equal(versions[id], VERSION);
      assert.equal(sourceCommit, COMMIT);
      return RELEASE_ARTIFACTS.composer.map((artifact) => {
        const path = resolve(outputDirectory, artifact.repository);
        mkdirSync(path, { recursive: true, mode: 0o700 });
        write(resolve(path, "composer.json"), `${artifact.name}\n`);
        return {
          kind: "composer",
          name: artifact.name,
          path,
          repository: artifact.repository,
          repositoryUrl: artifact.repositoryUrl,
          sha256: "b".repeat(64),
          sourceCommit,
          version: VERSION,
        };
      });
    },
    async publishMavenLocally({ outputDirectory, versions, include }) {
      fail("maven");
      assert.deepEqual(include, MAVEN_UNIT_IDS);
      assert.deepEqual(Object.keys(versions), MAVEN_UNIT_IDS);
      for (const id of MAVEN_UNIT_IDS) assert.equal(versions[id], VERSION);
      return RELEASE_ARTIFACTS.maven.map((artifact) => {
        const artifactId = artifact.name.split(":")[1];
        const path = resolve(outputDirectory, "dev/eightlines/gauntlet", artifactId, VERSION);
        mkdirSync(path, { recursive: true, mode: 0o700 });
        write(resolve(path, `${artifactId}-${VERSION}.jar`), artifact.name);
        return { kind: "maven", name: artifact.name, path, treeSha256: "c".repeat(64), version: VERSION, files: [] };
      });
    },
    async stageSkills({ root, outputDirectory, version }) {
      fail("skills");
      assert.equal(root, resolve(outputDirectory, "../../repository"));
      assert.equal(version, VERSION);
      const path = resolve(outputDirectory, `gauntlet-skills-${VERSION}.tgz`);
      write(path, "skills");
      return { kind: "skills", name: RELEASE_ARTIFACTS.skills.name, path, sha256: "5".repeat(64), version: VERSION };
    },
    packageComposeBundle({ outputDirectory }) {
      fail("compose");
      const path = resolve(outputDirectory, `gauntlet-compose-${VERSION}.tar.gz`);
      write(path, "compose");
      return { kind: "compose", name: RELEASE_ARTIFACTS.compose.name, path, sha256: "d".repeat(64), version: VERSION };
    },
    packageHelmChart({ outputDirectory }) {
      fail("helm");
      const path = resolve(outputDirectory, `gauntlet-${VERSION}.tgz`);
      write(path, "helm");
      return { kind: "helm", name: RELEASE_ARTIFACTS.chart.name, path, sha256: "e".repeat(64), version: VERSION };
    },
    async exportImageAndAttestations({ outputDirectory }) {
      fail("image");
      const dockerPath = resolve(outputDirectory, `gauntlet-${VERSION}.docker.tar`);
      const ociPath = resolve(outputDirectory, `gauntlet-${VERSION}.oci.tar`);
      const provenancePath = resolve(outputDirectory, `gauntlet-${VERSION}.provenance.json`);
      write(dockerPath, "docker");
      write(ociPath, "oci");
      write(provenancePath, '{"classification":"buildkit-unsigned-provenance"}\n');
      return {
        artifacts: [
          { kind: "docker", name: "gauntlet.local/gauntlet", path: dockerPath, sha256: "f".repeat(64), version: VERSION },
          { kind: "oci", name: RELEASE_ARTIFACTS.image.name, path: ociPath, sha256: "1".repeat(64), version: VERSION },
          {
            kind: "provenance",
            name: `${RELEASE_ARTIFACTS.image.name}@buildkit-unsigned`,
            path: provenancePath,
            sha256: "4".repeat(64),
            version: VERSION,
          },
        ],
        hostPlatform: "linux/arm64",
        inspection: {
          platforms: [
            { platform: "linux/amd64", imageDigest: `sha256:${"1".repeat(64)}`, spdxDocument: {} },
            { platform: "linux/arm64", imageDigest: `sha256:${"2".repeat(64)}`, spdxDocument: {} },
          ],
        },
      };
    },
    generateSpdxSbom({ outputPath, platform }) {
      calls.push(`sbom:${platform}`);
      if (failurePhase === "sbom") throw new Error("sbom failed");
      write(outputPath, '{"spdxVersion":"SPDX-2.3"}\n');
      return {
        kind: "sbom",
        name: `${RELEASE_ARTIFACTS.image.name}@${platform}`,
        path: outputPath,
        platform,
        sha256: "2".repeat(64),
        version: VERSION,
      };
    },
    async writeReleaseInventory(options) {
      fail("inventory");
      for (const artifact of options.artifacts) {
        assert.equal(lstatSync(resolve(options.outputDirectory, artifact.path)).isFile(), true, artifact.path);
      }
      const manifest = {
        schemaVersion: 1,
        version: options.version,
        sourceTag: `v${options.version}`,
        sourceCommit: options.sourceCommit,
        artifacts: options.artifacts.map((artifact) => ({ ...artifact, sha256: "3".repeat(64) })),
      };
      write(resolve(options.outputDirectory, "release-manifest.json"), `${JSON.stringify(manifest)}\n`);
      write(resolve(options.outputDirectory, "SHA256SUMS"), "checksums\n");
      return manifest;
    },
  };
}

test("declares the complete fail-fast staging phase order", () => {
  assert.deepEqual(RELEASE_STAGE_PHASES, [
    "npm",
    "composer",
    "maven",
    "skills",
    "compose",
    "helm",
    "image",
    "sbom",
    "inventory",
  ]);
  assert.equal(Object.isFrozen(RELEASE_STAGE_PHASES), true);
});

test("archives Composer and Maven support trees without leaving untracked release inputs", async (t) => {
  const files = sandbox(t);
  const calls = [];
  const manifest = await executeReleaseStage({
    root: files.repository,
    sourceCommit: COMMIT,
    version: VERSION,
    workDirectory: files.work,
  }, fakeDependencies(calls));

  assert.deepEqual(calls, [
    "npm",
    "composer",
    "maven",
    "skills",
    "compose",
    "helm",
    "image",
    "sbom:linux/amd64",
    "sbom:linux/arm64",
    "inventory",
  ]);
  assert.equal(manifest.artifacts.length, 19);
  assert.deepEqual(
    manifest.artifacts.filter(({ kind }) => kind === "skills").map(({ name, path }) => ({ name, path })),
    [{ name: "gauntlet-skills", path: "skills/gauntlet-skills-0.1.0.tgz" }],
  );
  assert.deepEqual(
    manifest.artifacts.filter(({ kind }) => kind === "sbom").map(({ name }) => name).sort(),
    [
      `${RELEASE_ARTIFACTS.image.name}@linux/amd64`,
      `${RELEASE_ARTIFACTS.image.name}@linux/arm64`,
    ],
  );
  assert.deepEqual(
    manifest.artifacts.filter(({ kind }) => kind === "sbom").map(({ path }) => path).sort(),
    ["sbom/gauntlet-linux-amd64.spdx.json", "sbom/gauntlet-linux-arm64.spdx.json"],
  );
  assert.deepEqual(
    manifest.artifacts.filter(({ kind }) => kind === "provenance").map(({ name }) => name),
    [`${RELEASE_ARTIFACTS.image.name}@buildkit-unsigned`],
  );
  assert.deepEqual(
    manifest.artifacts.filter(({ kind }) => kind === "composer").map(({ name }) => name).sort(),
    RELEASE_ARTIFACTS.composer.map(({ name }) => name).sort(),
  );
  assert.deepEqual(
    manifest.artifacts.filter(({ kind }) => kind === "maven").map(({ name }) => name).sort(),
    RELEASE_ARTIFACTS.maven.map(({ name }) => name).sort(),
  );
  for (const artifact of manifest.artifacts) {
    assert.equal(artifact.path.startsWith("/"), false);
    assert.equal(artifact.path.includes(".."), false);
    assert.equal(lstatSync(resolve(files.work, artifact.path)).isFile(), true);
  }
  assert.deepEqual(
    regularFiles(files.work),
    ["SHA256SUMS", "release-manifest.json", ...manifest.artifacts.map(({ path }) => path)]
      .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))),
  );
  assert.throws(
    () => lstatSync(resolve(files.work, "composer/repositories")),
    { code: "ENOENT" },
  );
  assert.throws(
    () => lstatSync(resolve(files.work, "maven/repository")),
    { code: "ENOENT" },
  );
  assert.deepEqual(
    readFileSync(resolve(files.work, "composer/artifacts/gauntlet-php-core-0.1.0.tar.gz")).subarray(0, 2),
    Buffer.from([0x1f, 0x8b]),
  );
});

test("fails before inventory and preserves a replacement support tree", async (t) => {
  const files = sandbox(t);
  const calls = [];
  const dependencies = fakeDependencies(calls);
  const packageTree = dependencies.packageCanonicalTree;
  const writeInventory = dependencies.writeReleaseInventory;
  const support = resolve(files.work, "composer/repositories");
  const retired = resolve(files.root, "retired-composer-repositories");
  let composerArchives = 0;
  let inventoryCalled = false;
  dependencies.packageCanonicalTree = (options) => {
    const receipt = packageTree(options);
    if (options.sourceDirectory.startsWith(`${support}/`) && ++composerArchives === RELEASE_ARTIFACTS.composer.length) {
      renameSync(support, retired);
      mkdirSync(support, { mode: 0o700 });
      write(resolve(support, "foreign.txt"), "preserve\n");
    }
    return receipt;
  };
  dependencies.writeReleaseInventory = async (options) => {
    inventoryCalled = true;
    return writeInventory(options);
  };

  await assert.rejects(
    executeReleaseStage({
      root: files.repository,
      sourceCommit: COMMIT,
      version: VERSION,
      workDirectory: files.work,
    }, dependencies),
    /failed closed/u,
  );
  assert.equal(inventoryCalled, false);
  assert.equal(readFileSync(resolve(support, "foreign.txt"), "utf8"), "preserve\n");
});

test("fails before inventory without following a replacement support-tree symlink", async (t) => {
  const files = sandbox(t);
  const calls = [];
  const dependencies = fakeDependencies(calls);
  const packageTree = dependencies.packageCanonicalTree;
  const writeInventory = dependencies.writeReleaseInventory;
  const support = resolve(files.work, "composer/repositories");
  const retired = resolve(files.root, "retired-symlinked-composer-repositories");
  const outside = resolve(files.root, "outside");
  mkdirSync(outside, { mode: 0o700 });
  write(resolve(outside, "foreign.txt"), "preserve\n");
  let composerArchives = 0;
  let inventoryCalled = false;
  dependencies.packageCanonicalTree = (options) => {
    const receipt = packageTree(options);
    if (options.sourceDirectory.startsWith(`${support}/`) && ++composerArchives === RELEASE_ARTIFACTS.composer.length) {
      renameSync(support, retired);
      symlinkSync(outside, support);
    }
    return receipt;
  };
  dependencies.writeReleaseInventory = async (options) => {
    inventoryCalled = true;
    return writeInventory(options);
  };

  await assert.rejects(
    executeReleaseStage({
      root: files.repository,
      sourceCommit: COMMIT,
      version: VERSION,
      workDirectory: files.work,
    }, dependencies),
    /failed closed/u,
  );
  assert.equal(inventoryCalled, false);
  assert.equal(lstatSync(support).isSymbolicLink(), true);
  assert.equal(readFileSync(resolve(outside, "foreign.txt"), "utf8"), "preserve\n");
});

test("support-tree cleanup retries ENOTEMPTY only while the quarantined identity remains owned", async (t) => {
  const files = sandbox(t);
  const support = resolve(files.work, "composer/repositories");
  mkdirSync(support, { recursive: true, mode: 0o700 });
  write(resolve(support, "owned.txt"), "owned\n");
  const workStat = lstatSync(files.work, { bigint: true });
  const stat = lstatSync(support, { bigint: true });
  const cleanup = stageModule.removeOwnedSupportTree;
  assert.equal(typeof cleanup, "function");
  let attempts = 0;

  await cleanup(
    {
      workDirectory: files.work,
      path: support,
      workDev: workStat.dev,
      workIno: workStat.ino,
      workUid: workStat.uid,
      dev: stat.dev,
      ino: stat.ino,
      uid: stat.uid,
    },
    {
      quarantineToken: "a".repeat(32),
      moveTree: renameSync,
      wait: async () => {},
      removeDirectory(path) {
        if (path.endsWith("/tree")) attempts += 1;
        if (path.endsWith("/tree") && attempts === 1) {
          const error = new Error("simulated APFS cleanup race");
          error.code = "ENOTEMPTY";
          throw error;
        }
        rmdirSync(path);
      },
    },
  );

  assert.equal(attempts, 2);
  assert.throws(() => lstatSync(support), { code: "ENOENT" });
  assert.throws(
    () => lstatSync(resolve(files.work, `.gauntlet-retired-support-${"a".repeat(32)}`)),
    { code: "ENOENT" },
  );
});

test("support-tree cleanup rejects hard-linked files before creating a quarantine", async (t) => {
  const files = sandbox(t);
  const support = resolve(files.work, "composer/repositories");
  mkdirSync(support, { recursive: true, mode: 0o700 });
  const owned = resolve(support, "owned.txt");
  const linked = resolve(support, "linked.txt");
  write(owned, "preserve\n");
  linkSync(owned, linked);
  const workStat = lstatSync(files.work, { bigint: true });
  const stat = lstatSync(support, { bigint: true });
  const token = "f".repeat(32);

  await assert.rejects(
    stageModule.removeOwnedSupportTree(
      {
        workDirectory: files.work,
        path: support,
        workDev: workStat.dev,
        workIno: workStat.ino,
        workUid: workStat.uid,
        dev: stat.dev,
        ino: stat.ino,
        uid: stat.uid,
      },
      {
        quarantineToken: token,
        moveTree: renameSync,
        wait: async () => {},
        removeDirectory: rmdirSync,
      },
    ),
    /failed closed/u,
  );

  assert.equal(readFileSync(owned, "utf8"), "preserve\n");
  assert.equal(readFileSync(linked, "utf8"), "preserve\n");
  assert.throws(
    () => lstatSync(resolve(files.work, `.gauntlet-retired-support-${token}`)),
    { code: "ENOENT" },
  );
});

test("support-tree cleanup preserves a file replaced immediately after quarantine", async (t) => {
  const files = sandbox(t);
  const support = resolve(files.work, "composer/repositories");
  mkdirSync(support, { recursive: true, mode: 0o700 });
  write(resolve(support, "owned.txt"), "owned\n");
  const workStat = lstatSync(files.work, { bigint: true });
  const stat = lstatSync(support, { bigint: true });
  const token = "c".repeat(32);
  const quarantine = resolve(files.work, `.gauntlet-retired-support-${token}/tree`);
  const displaced = resolve(files.root, "displaced-owned-file");

  await assert.rejects(
    stageModule.removeOwnedSupportTree(
      {
        workDirectory: files.work,
        path: support,
        workDev: workStat.dev,
        workIno: workStat.ino,
        workUid: workStat.uid,
        dev: stat.dev,
        ino: stat.ino,
        uid: stat.uid,
      },
      {
        quarantineToken: token,
        wait: async () => {},
        removeDirectory: rmdirSync,
        moveTree(source, destination) {
          renameSync(source, destination);
          renameSync(resolve(destination, "owned.txt"), displaced);
          write(resolve(destination, "owned.txt"), "foreign\n");
        },
      },
    ),
    /failed closed/u,
  );

  assert.equal(readFileSync(resolve(quarantine, "owned.txt"), "utf8"), "foreign\n");
  assert.equal(readFileSync(displaced, "utf8"), "owned\n");
});

test("support-tree cleanup preserves an unjournaled entry that makes an owned directory non-empty", async (t) => {
  const files = sandbox(t);
  const support = resolve(files.work, "maven/repository");
  mkdirSync(support, { recursive: true, mode: 0o700 });
  write(resolve(support, "owned.txt"), "owned\n");
  const workStat = lstatSync(files.work, { bigint: true });
  const stat = lstatSync(support, { bigint: true });
  const token = "d".repeat(32);
  const quarantinedTree = resolve(files.work, `.gauntlet-retired-support-${token}/tree`);
  let attempts = 0;

  await assert.rejects(
    stageModule.removeOwnedSupportTree(
      {
        workDirectory: files.work,
        path: support,
        workDev: workStat.dev,
        workIno: workStat.ino,
        workUid: workStat.uid,
        dev: stat.dev,
        ino: stat.ino,
        uid: stat.uid,
      },
      {
        quarantineToken: token,
        moveTree: renameSync,
        wait: async () => {},
        removeDirectory(path) {
          if (path === quarantinedTree) {
            attempts += 1;
            if (attempts === 1) write(resolve(path, "foreign.txt"), "preserve\n");
          }
          rmdirSync(path);
        },
      },
    ),
    /failed closed/u,
  );

  assert.equal(attempts, 5);
  assert.equal(readFileSync(resolve(quarantinedTree, "foreign.txt"), "utf8"), "preserve\n");
  assert.throws(() => lstatSync(support), { code: "ENOENT" });
});

test("support-tree cleanup preserves an empty replacement of the quarantine root", async (t) => {
  const files = sandbox(t);
  const support = resolve(files.work, "composer/repositories");
  mkdirSync(support, { recursive: true, mode: 0o700 });
  const workStat = lstatSync(files.work, { bigint: true });
  const stat = lstatSync(support, { bigint: true });
  const token = "e".repeat(32);
  const quarantineRoot = resolve(files.work, `.gauntlet-retired-support-${token}`);
  const quarantinedTree = resolve(quarantineRoot, "tree");
  const displaced = resolve(files.root, "displaced-quarantine-root");

  await assert.rejects(
    stageModule.removeOwnedSupportTree(
      {
        workDirectory: files.work,
        path: support,
        workDev: workStat.dev,
        workIno: workStat.ino,
        workUid: workStat.uid,
        dev: stat.dev,
        ino: stat.ino,
        uid: stat.uid,
      },
      {
        quarantineToken: token,
        moveTree: renameSync,
        wait: async () => {},
        removeDirectory(path) {
          rmdirSync(path);
          if (path === quarantinedTree) {
            renameSync(quarantineRoot, displaced);
            mkdirSync(quarantineRoot, { mode: 0o700 });
          }
        },
      },
    ),
    /failed closed/u,
  );

  assert.equal(lstatSync(quarantineRoot).isDirectory(), true);
  assert.equal(lstatSync(displaced).isDirectory(), true);
});

test("support-tree cleanup never recursively deletes a quarantine replacement", async (t) => {
  const files = sandbox(t);
  const support = resolve(files.work, "maven/repository");
  mkdirSync(support, { recursive: true, mode: 0o700 });
  write(resolve(support, "owned.txt"), "owned\n");
  const workStat = lstatSync(files.work, { bigint: true });
  const stat = lstatSync(support, { bigint: true });
  const cleanup = stageModule.removeOwnedSupportTree;
  assert.equal(typeof cleanup, "function");
  const token = "b".repeat(32);
  const quarantine = resolve(files.work, `.gauntlet-retired-support-${token}`);
  const displaced = resolve(files.root, "displaced-owned-support-tree");
  let attempts = 0;

  await assert.rejects(
    cleanup(
      {
        workDirectory: files.work,
        path: support,
        workDev: workStat.dev,
        workIno: workStat.ino,
        workUid: workStat.uid,
        dev: stat.dev,
        ino: stat.ino,
        uid: stat.uid,
      },
      {
        quarantineToken: token,
        moveTree: renameSync,
        wait: async () => {},
        removeDirectory(path, options) {
          attempts += 1;
          renameSync(path, displaced);
          mkdirSync(path, { mode: 0o700 });
          write(resolve(path, "foreign.txt"), "preserve\n");
          rmSync(path, options);
        },
      },
    ),
    /failed closed/u,
  );

  assert.equal(attempts, 1);
  assert.equal(readFileSync(resolve(quarantine, "tree/foreign.txt"), "utf8"), "preserve\n");
});

test("stops at the first failed dependency and never writes inventory", async (t) => {
  const files = sandbox(t);
  const calls = [];
  await assert.rejects(
    executeReleaseStage({
      root: files.repository,
      sourceCommit: COMMIT,
      version: VERSION,
      workDirectory: files.work,
    }, fakeDependencies(calls, "maven")),
    /maven failed/,
  );
  assert.deepEqual(calls, ["npm", "composer", "maven"]);
});

test("rejects a staging dependency object that omits the required skills stager before any phase runs", async (t) => {
  const files = sandbox(t);
  const calls = [];
  const dependencies = fakeDependencies(calls);
  delete dependencies.stageSkills;
  await assert.rejects(
    executeReleaseStage({
      root: files.repository,
      sourceCommit: COMMIT,
      version: VERSION,
      workDirectory: files.work,
    }, dependencies),
    /closed data object/u,
  );
  assert.deepEqual(calls, []);
});

test("stageRelease preserves a fail-closed support-cleanup sentinel in its private work tree", async (t) => {
  const files = sandbox(t);
  writeFileSync(resolve(files.repository, "VERSION"), `${VERSION}\n`, { mode: 0o600 });
  const outputDirectory = resolve(files.root, "release-output");
  let sentinel;

  await assert.rejects(stageRelease({
    root: files.repository,
    outputDirectory,
    sourceCommit: COMMIT,
  }, {
    async executeReleaseStage({ workDirectory }) {
      sentinel = resolve(workDirectory, `.gauntlet-retired-support-${"a".repeat(32)}/tree/foreign.txt`);
      write(sentinel, "preserve\n");
      throw new Error("Release staging failed closed");
    },
    async verifySource() {},
  }), /failed closed/u);

  assert.equal(readFileSync(sentinel, "utf8"), "preserve\n");
  assert.throws(() => lstatSync(outputDirectory), { code: "ENOENT" });
});

test("does not promote a completed staging tree when the source snapshot changes", async (t) => {
  const files = sandbox(t);
  writeFileSync(resolve(files.repository, "VERSION"), `${VERSION}\n`, { mode: 0o600 });
  const outputDirectory = resolve(files.root, "release-output");
  const calls = [];
  await assert.rejects(stageRelease({
    root: files.repository,
    outputDirectory,
    sourceCommit: COMMIT,
  }, {
    async executeReleaseStage({ workDirectory }) {
      calls.push("execute");
      write(resolve(workDirectory, "artifact.bin"));
      return { version: VERSION, sourceCommit: COMMIT, sourceTag: `v${VERSION}`, artifacts: [] };
    },
    async verifySource() {
      calls.push("verify");
      if (calls.filter((entry) => entry === "verify").length === 2) throw new Error("source changed");
    },
  }), /source changed/);
  assert.deepEqual(calls, ["verify", "execute", "verify"]);
  assert.throws(() => lstatSync(outputDirectory), { code: "ENOENT" });
});

test("parses only one explicit safe output argument relative to the repository or as an absolute path", () => {
  assert.deepEqual(parseStageArguments(["--output", "/tmp/gauntlet-release"]), {
    outputDirectory: "/tmp/gauntlet-release",
  });
  assert.deepEqual(parseStageArguments(["--output", ".artifacts/release/0.1.0"]), {
    outputDirectory: resolve(import.meta.dirname, "../../../.artifacts/release/0.1.0"),
  });
  for (const args of [
    [],
    ["--output"],
    ["--output", "../outside"],
    ["--output", "nested/../outside"],
    ["--output", "/tmp/a", "extra"],
    ["--publish", "/tmp/a"],
  ]) {
    assert.throws(() => parseStageArguments(args), /Usage:/);
  }
});

test("the staging implementation contains no registry, GitHub, or Git publication command", () => {
  for (const relativePath of [
    "scripts/release/stage.mjs",
    "scripts/release/stage-image.mjs",
    "scripts/release/stage-helm.mjs",
    "scripts/release/stage-sbom.mjs",
    "docker-bake.hcl",
  ]) {
    const source = readFileSync(resolve(import.meta.dirname, `../../../${relativePath}`), "utf8");
    for (const forbidden of [
      /npm\s+publish/u,
      /helm\s+push/u,
      /docker\s+push/u,
      /git\s+push/u,
      /gh\s+api\s+--method/u,
      /gh\s+release\s+create/u,
      /type=registry/u,
    ]) assert.doesNotMatch(source, forbidden, `${relativePath}: ${forbidden}`);
  }
});
