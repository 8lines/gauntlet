import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { composerUpdateArguments, pathRepositoryReference, repinComposerLocks } from "../composer-locks.mjs";
import { COMPOSER_IMAGE } from "../test-php-compatibility.mjs";

const ROOT = resolve(import.meta.dirname, "../../..");
const CORE = "8lines/gauntlet-php-core";
const BUNDLE = "8lines/gauntlet-symfony-bundle";
const THIRD_PARTY = Object.freeze({ name: "opis/json-schema", version: "2.6.0", dist: { type: "zip", url: "https://example.invalid/opis.zip", reference: "abc" } });
const json = (value) => `${JSON.stringify(value, null, 4)}\n`;

function lockFile(contentHash, packages) {
  return json({
    _readme: ["generated"], "content-hash": contentHash, packages, "packages-dev": [], aliases: [],
    "minimum-stability": "stable", "stability-flags": {}, "prefer-stable": false, "prefer-lowest": false,
    platform: { php: ">=8.3" }, "platform-dev": {}, "plugin-api-version": "2.6.0",
  });
}

function pathEntry(name, version, url, manifest, require = {}) {
  return { name, version, dist: { type: "path", url, reference: pathRepositoryReference(manifest) }, require, "transport-options": { symlink: false, relative: true } };
}

function writeManifests(root, version) {
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write("packages/php/core/composer.json", json({ name: CORE, version }));
  write("packages/php/symfony-bundle/composer.json", json({ name: BUNDLE, version, require: { [CORE]: `^${version}` } }));
  write("examples/symfony/composer.json", json({ name: "8lines/gauntlet-symfony-example", require: { [CORE]: `^${version}`, [BUNDLE]: `^${version}` } }));
  return write;
}

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gauntlet-composer-locks-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = writeManifests(root, "0.1.8");
  const core = readFileSync(join(root, "packages/php/core/composer.json"));
  const bundle = readFileSync(join(root, "packages/php/symfony-bundle/composer.json"));
  write("packages/php/core/composer.lock", lockFile("0".repeat(32), [THIRD_PARTY]));
  write("packages/php/symfony-bundle/composer.lock", lockFile("1".repeat(32), [pathEntry(CORE, "0.1.8", "../core", core), THIRD_PARTY]));
  write("examples/symfony/composer.lock", lockFile("2".repeat(32), [
    pathEntry(CORE, "0.1.8", "../../packages/php/core", core),
    pathEntry(BUNDLE, "0.1.8", "../../packages/php/symfony-bundle", bundle, { [CORE]: "^0.1.8" }),
    THIRD_PARTY,
  ]));
  writeManifests(root, "0.1.9");
  return root;
}

// Simulates `composer update` in the container: it relocks the path packages from their manifests.
function fakeComposer(root, { tamper = false, status = 0 } = {}) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (status !== 0) return { status, stdout: "", stderr: "network unreachable" };
    const directory = args[args.indexOf("--workdir") + 1].slice("/workspace/".length);
    const lockPath = join(root, directory, "composer.lock");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    const manifest = (path) => readFileSync(join(root, path));
    const bundle = JSON.parse(manifest("packages/php/symfony-bundle/composer.json"));
    lock["content-hash"] = "f".repeat(32);
    for (const entry of lock.packages) {
      if (entry.name === CORE) {
        entry.version = JSON.parse(manifest("packages/php/core/composer.json")).version;
        entry.dist.reference = pathRepositoryReference(manifest("packages/php/core/composer.json"));
      }
      if (entry.name === BUNDLE) {
        entry.version = bundle.version;
        entry.dist.reference = pathRepositoryReference(manifest("packages/php/symfony-bundle/composer.json"));
        entry.require[CORE] = bundle.require[CORE];
      }
      if (tamper && entry.name === "opis/json-schema") entry.version = "2.7.0";
    }
    writeFileSync(lockPath, json(lock));
    return { status: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

const VERSIONS = new Map([["php-core", "0.1.9"], ["symfony-bundle", "0.1.9"]]);

test("the path-repository reference matches the one Composer recorded in the repository", () => {
  assert.equal(
    pathRepositoryReference(Buffer.from("{}\n")),
    createHash("sha1").update('{}\na:2:{s:7:"symlink";b:0;s:8:"relative";b:1;}').digest("hex"),
  );
  const lock = JSON.parse(readFileSync(join(ROOT, "packages/php/symfony-bundle/composer.lock"), "utf8"));
  assert.equal(
    lock.packages.find(({ name }) => name === CORE).dist.reference,
    pathRepositoryReference(readFileSync(join(ROOT, "packages/php/core/composer.json"))),
  );
});

test("Composer runs in the pinned image with a read-only root and writes only through the repository mount", () => {
  assert.deepEqual(composerUpdateArguments({ root: "/repo", directory: "examples/symfony", packages: [CORE, BUNDLE], uid: 501, gid: 20 }), [
    "run", "--rm", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--network", "bridge", "--user", "501:20",
    "--env", "HOME=/tmp/home", "--env", "COMPOSER_HOME=/tmp/composer",
    "--env", "COMPOSER_CACHE_DIR=/tmp/composer-cache", "--env", "COMPOSER_NO_INTERACTION=1",
    "--mount", "type=bind,src=/repo,dst=/workspace",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=268435456,mode=1777",
    "--workdir", "/workspace/examples/symfony",
    COMPOSER_IMAGE,
    "composer", "update", CORE, BUNDLE,
    "--no-install", "--no-scripts", "--no-plugins", "--no-audit", "--no-progress", "--ignore-platform-reqs",
  ]);
  assert.deepEqual(
    composerUpdateArguments({ root: "/repo", directory: "packages/php/core", packages: [], uid: 0, gid: 0 }).slice(-9, -6),
    ["composer", "update", "--lock"],
  );
  for (const bad of [{ root: "relative", directory: "x" }, { root: "/repo,x", directory: "x" }, { root: "/repo", directory: "../x" }]) {
    assert.throws(() => composerUpdateArguments({ ...bad, packages: [], uid: 0, gid: 0 }), /Composer lock target is invalid/u);
  }
});

test("a php-core release re-pins all three locks and verifies them", (t) => {
  const root = fixture(t);
  const composer = fakeComposer(root);
  assert.deepEqual(repinComposerLocks({ root, versions: VERSIONS, moved: ["php-core", "symfony-bundle", "skills"], run: composer.run }), [
    "packages/php/core/composer.lock", "packages/php/symfony-bundle/composer.lock", "examples/symfony/composer.lock",
  ]);
  assert.deepEqual(composer.calls.map((args) => args[args.indexOf("--workdir") + 1]), [
    "/workspace/packages/php/core", "/workspace/packages/php/symfony-bundle", "/workspace/examples/symfony",
  ]);
  const example = JSON.parse(readFileSync(join(root, "examples/symfony/composer.lock"), "utf8"));
  assert.deepEqual(example.packages.map(({ name, version }) => [name, version]), [[CORE, "0.1.9"], [BUNDLE, "0.1.9"], ["opis/json-schema", "2.6.0"]]);
});

test("a release without PHP units runs no Composer, and a bundle-only release skips the core lock", (t) => {
  const root = fixture(t);
  assert.deepEqual(repinComposerLocks({ root, versions: VERSIONS, moved: ["gauntlet", "skills"], run: () => assert.fail("Composer must not run") }), []);
  const composer = fakeComposer(root);
  repinComposerLocks({ root, versions: VERSIONS, moved: ["symfony-bundle", "skills"], run: composer.run });
  assert.deepEqual(composer.calls.map((args) => args[args.indexOf("--workdir") + 1]), [
    "/workspace/packages/php/symfony-bundle", "/workspace/examples/symfony",
  ]);
});

test("a lock change beyond the Gauntlet path packages or a failed Composer run aborts", (t) => {
  const tampered = fixture(t);
  assert.throws(
    () => repinComposerLocks({ root: tampered, versions: VERSIONS, moved: ["php-core"], run: fakeComposer(tampered, { tamper: true }).run }),
    /Composer changed the lock beyond the Gauntlet path packages/u,
  );
  const offline = fixture(t);
  assert.throws(
    () => repinComposerLocks({ root: offline, versions: VERSIONS, moved: ["php-core"], run: fakeComposer(offline, { status: 1 }).run }),
    /Composer could not re-pin packages\/php\/core\/composer\.lock/u,
  );
});
