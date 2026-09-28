import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { stageComposerPackages } from "../stage-composer.mjs";

const NOTICE = readFileSync(resolve(import.meta.dirname, "../../../LICENSE"));

function runGit(root, args) {
  const result = spawnSync("git", args, {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Gauntlet",
      GIT_AUTHOR_EMAIL: "gauntlet@example.invalid",
      GIT_COMMITTER_NAME: "Gauntlet",
      GIT_COMMITTER_EMAIL: "gauntlet@example.invalid",
      LC_ALL: "C",
      TZ: "UTC",
    },
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, "Git fixture command failed");
  return result.stdout.trim();
}

function write(root, relativePath, bytes) {
  const path = resolve(root, relativePath);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, bytes, { mode: 0o644 });
}

function manifest(name, type, require_, extra = {}, version = "0.1.0") {
  return `${JSON.stringify({
    name,
    description: `${name} fixture`,
    version,
    type,
    license: "Apache-2.0",
    homepage: "https://github.com/8lines/gauntlet",
    support: {
      issues: "https://github.com/8lines/gauntlet/issues",
      source: "https://github.com/8lines/gauntlet",
    },
    ...extra,
    require: require_,
    autoload: { "psr-4": { "Fixture\\": "src/" } },
    config: { "allow-plugins": false },
  }, null, 2)}\n`;
}

function createFixture(version = "0.1.0") {
  const sandbox = realpathSync(mkdtempSync(resolve(tmpdir(), "gauntlet-composer-stage-test-")));
  const root = resolve(sandbox, "source");
  mkdirSync(root, { mode: 0o700 });
  write(root, "VERSION", `${version}\n`);
  write(root, "LICENSE", NOTICE);
  write(root, "packages/php/core/LICENSE", NOTICE);
  write(root, "packages/php/core/README.md", "# Core\n");
  write(root, "packages/php/core/phpunit.xml.dist", "<phpunit/>\n");
  write(root, "packages/php/core/src/CoreValue.php", "<?php\nnamespace Fixture; final class CoreValue {}\n");
  write(root, "packages/php/core/tests/CoreValueTest.php", "<?php\n");
  write(root, "packages/php/core/composer.lock", "FOREIGN LOCK\n");
  write(root, "packages/php/core/composer.json", manifest(
    "8lines/gauntlet-php-core",
    "library",
    { php: ">=8.3", "ext-json": "*" },
    {},
    version,
  ));
  write(root, "packages/php/symfony-bundle/LICENSE", NOTICE);
  write(root, "packages/php/symfony-bundle/README.md", "# Bundle\n");
  write(root, "packages/php/symfony-bundle/phpunit.xml.dist", "<phpunit/>\n");
  write(root, "packages/php/symfony-bundle/config/routes.php", "<?php\nreturn static function (): void {};\n");
  write(root, "packages/php/symfony-bundle/config/services.php", "<?php\nreturn static function (): void {};\n");
  write(root, "packages/php/symfony-bundle/src/GauntletBundle.php", "<?php\nnamespace Fixture; final class GauntletBundle {}\n");
  write(root, "packages/php/symfony-bundle/tests/BundleTest.php", "<?php\n");
  write(root, "packages/php/symfony-bundle/composer.lock", "FOREIGN LOCK\n");
  write(root, "packages/php/symfony-bundle/composer.json", manifest(
    "8lines/gauntlet-symfony-bundle",
    "symfony-bundle",
    {
      php: ">=8.3",
      "8lines/gauntlet-php-core": `^${version}`,
      "symfony/framework-bundle": "^7.4 || ^8.0",
    },
    { repositories: [{ type: "path", url: "../core", options: { symlink: false } }] },
    version,
  ));
  runGit(root, ["init", "--initial-branch=main"]);
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-m", "fixture"]);
  const commit = runGit(root, ["rev-parse", "HEAD"]);
  const output = resolve(sandbox, "output");
  mkdirSync(output, { mode: 0o700 });
  chmodSync(output, 0o700);
  return {
    sandbox,
    root,
    commit,
    output,
    cleanup() { rmSync(sandbox, { recursive: true, force: true }); },
  };
}

test("stages Composer packages after a release bump to 0.1.1", async () => {
  const fixture = createFixture("0.1.1");
  try {
    const artifacts = await stageComposerPackages({
      root: fixture.root,
      outputDirectory: fixture.output,
      sourceCommit: fixture.commit,
    });
    assert.deepEqual(artifacts.map(({ version }) => version), ["0.1.1", "0.1.1"]);
    assert.equal(
      JSON.parse(readFileSync(resolve(artifacts[1].path, "composer.json"), "utf8"))
        .require["8lines/gauntlet-php-core"],
      "^0.1.1",
    );
  } finally {
    fixture.cleanup();
  }
});

function snapshot(path) {
  const records = [];
  const visit = (current, relativePath) => {
    const stat = lstatSync(current, { bigint: true });
    if (stat.isDirectory()) {
      records.push([relativePath, "directory", stat.dev, stat.ino, stat.mode, stat.mtimeNs]);
      for (const name of readdirSync(current).sort()) visit(join(current, name), relativePath ? `${relativePath}/${name}` : name);
      return;
    }
    assert.equal(stat.isFile(), true);
    records.push([
      relativePath,
      "file",
      stat.dev,
      stat.ino,
      stat.mode,
      stat.mtimeNs,
      createHash("sha256").update(readFileSync(current)).digest("hex"),
    ]);
  };
  visit(path, "");
  return records;
}

test("stages two deterministic Composer VCS trees from exact Git blobs", async () => {
  const fixture = createFixture();
  try {
    const sourceBefore = snapshot(fixture.root);
    write(fixture.root, "packages/php/core/src/CoreValue.php", "WORKTREE-ONLY\n");
    const artifacts = await stageComposerPackages({
      root: fixture.root,
      outputDirectory: fixture.output,
      sourceCommit: fixture.commit,
    });
    assert.deepEqual(artifacts.map(({ name }) => name), [
      "8lines/gauntlet-php-core",
      "8lines/gauntlet-symfony-bundle",
    ]);
    for (const artifact of artifacts) {
      assert.equal(artifact.kind, "composer");
      assert.equal(artifact.version, "0.1.0");
      assert.equal(artifact.sourceCommit, fixture.commit);
      assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
      assert.equal(realpathSync(artifact.path), artifact.path);
      assert.equal(existsSync(resolve(artifact.path, "composer.lock")), false);
      assert.equal(existsSync(resolve(artifact.path, "vendor")), false);
      const provenance = JSON.parse(readFileSync(resolve(artifact.path, ".gauntlet-source.json"), "utf8"));
      assert.deepEqual(provenance, {
        repository: "8lines/gauntlet",
        commit: fixture.commit,
        path: artifact.name.endsWith("php-core") ? "packages/php/core" : "packages/php/symfony-bundle",
        version: "0.1.0",
      });
    }
    const core = artifacts[0];
    const bundle = artifacts[1];
    assert.match(readFileSync(resolve(core.path, "src/CoreValue.php"), "utf8"), /final class CoreValue/);
    assert.equal("repositories" in JSON.parse(readFileSync(resolve(core.path, "composer.json"), "utf8")), false);
    assert.equal("repositories" in JSON.parse(readFileSync(resolve(bundle.path, "composer.json"), "utf8")), false);
    assert.notDeepEqual(snapshot(fixture.root), sourceBefore, "the worktree mutation is intentionally visible");

    const secondOutput = resolve(fixture.sandbox, "second-output");
    mkdirSync(secondOutput, { mode: 0o700 });
    chmodSync(secondOutput, 0o700);
    const second = await stageComposerPackages({ root: fixture.root, outputDirectory: secondOutput, sourceCommit: fixture.commit });
    assert.deepEqual(second.map(({ name, sha256 }) => [name, sha256]), artifacts.map(({ name, sha256 }) => [name, sha256]));
  } finally {
    fixture.cleanup();
  }
});

test("rejects malformed options, commits, outputs, and tracked unsafe content without clobbering", async () => {
  for (const mutate of [
    (fixture) => ({ root: fixture.root, outputDirectory: fixture.output, sourceCommit: "A".repeat(40) }),
    (fixture) => ({ root: fixture.root, outputDirectory: fixture.output, sourceCommit: fixture.commit, extra: true }),
    (fixture) => {
      write(fixture.output, "FOREIGN", "KEEP\n");
      return { root: fixture.root, outputDirectory: fixture.output, sourceCommit: fixture.commit };
    },
  ]) {
    const fixture = createFixture();
    try {
      const options = mutate(fixture);
      await assert.rejects(stageComposerPackages(options));
      if (existsSync(resolve(fixture.output, "FOREIGN"))) assert.equal(readFileSync(resolve(fixture.output, "FOREIGN"), "utf8"), "KEEP\n");
    } finally {
      fixture.cleanup();
    }
  }

  for (const hostilePath of ["packages/php/core/.env", "packages/php/core/auth.json"] ) {
    const fixture = createFixture();
    try {
      write(fixture.root, hostilePath, "SECRET\n");
      runGit(fixture.root, ["add", hostilePath]);
      runGit(fixture.root, ["commit", "-m", "hostile"]);
      const commit = runGit(fixture.root, ["rev-parse", "HEAD"]);
      await assert.rejects(
        stageComposerPackages({ root: fixture.root, outputDirectory: fixture.output, sourceCommit: commit }),
        { message: "Composer package staging failed closed" },
      );
      assert.deepEqual(readdirSync(fixture.output), []);
    } finally {
      fixture.cleanup();
    }
  }
});

test("rejects tracked links and executable package files", async () => {
  for (const behavior of ["link", "executable"]) {
    const fixture = createFixture();
    try {
      const target = resolve(fixture.root, "packages/php/core/src/Hostile.php");
      if (behavior === "link") symlinkSync("CoreValue.php", target);
      else writeFileSync(target, "<?php\n", { mode: 0o755 });
      runGit(fixture.root, ["add", "packages/php/core/src/Hostile.php"]);
      runGit(fixture.root, ["commit", "-m", behavior]);
      const commit = runGit(fixture.root, ["rev-parse", "HEAD"]);
      await assert.rejects(
        stageComposerPackages({ root: fixture.root, outputDirectory: fixture.output, sourceCommit: commit }),
        { message: "Composer package staging failed closed" },
      );
      assert.deepEqual(readdirSync(fixture.output), []);
    } finally {
      fixture.cleanup();
    }
  }
});
