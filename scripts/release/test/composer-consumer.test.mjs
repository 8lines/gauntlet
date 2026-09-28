import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  COMPOSER_CONSUMER_COMMITTED_INPUTS,
  composerLockSourceFor,
  createComposerConsumerPlan,
  validateComposerLockPackageVersions,
} from "../test-composer-consumer.mjs";

const ROOT = resolve(import.meta.dirname, "../../..");

test("defines closed Core and disabled Symfony consumers with no path repositories", () => {
  for (const name of ["php-core", "php-symfony"]) {
    const directory = resolve(ROOT, "tests/consumers", name);
    assert.equal(existsSync(resolve(directory, "composer.json")), true);
    assert.equal(existsSync(resolve(directory, "check.php")), true);
    const manifest = JSON.parse(readFileSync(resolve(directory, "composer.json"), "utf8"));
    assert.deepEqual(manifest.repositories, []);
    assert.equal(manifest.license, "Apache-2.0");
    assert.equal(Object.values(manifest.require).some((value) => String(value).startsWith("dev-")), false);
    assert.equal(JSON.stringify(manifest).includes("path"), false);
    assert.equal(readFileSync(resolve(directory, "check.php"), "utf8").includes("vendor/autoload.php"), true);
  }
  const symfony = readFileSync(resolve(ROOT, "tests/consumers/php-symfony/check.php"), "utf8");
  const symfonyManifest = JSON.parse(readFileSync(resolve(ROOT, "tests/consumers/php-symfony/composer.json"), "utf8"));
  assert.equal(symfonyManifest.require["symfony/framework-bundle"], "^7.4 || ^8.0");
  assert.match(symfony, /new GauntletBundle\(\)/);
  assert.match(symfony, /'enabled' => false/);
  assert.doesNotMatch(symfony, /idempotency_secret|production|prod/);
});

test("plans deterministic VCS tags, online install, checks, and a network-disabled offline reinstall", () => {
  const plan = createComposerConsumerPlan({
    version: "0.1.0",
    taskIdentifier: "unit",
    sandbox: "/private/consumer",
    imageTag: "gauntlet-php-compatibility:unit-php83",
    uid: 501,
    gid: 20,
  });
  assert.equal(plan.version, "0.1.0");
  assert.deepEqual(plan.repositories.map(({ name, tag }) => [name, tag]), [
    ["8lines/gauntlet-php-core", "v0.1.0"],
    ["8lines/gauntlet-symfony-bundle", "v0.1.0"],
  ]);
  assert.deepEqual(plan.repositories.map(({ staged }) => staged), [
    "/private/consumer/staged/8lines/gauntlet-php-core",
    "/private/consumer/staged/8lines/gauntlet-symfony-bundle",
  ]);
  assert.equal(composerLockSourceFor(plan.repositories[0]), "/task/repositories/gauntlet-php-core.git");
  assert.deepEqual(plan.consumers.map(({ name }) => name), ["php-core", "php-symfony"]);
  for (const consumer of plan.consumers) {
    assert.deepEqual(consumer.validate, [
      "composer", "validate", "--strict", "--no-check-all", "--no-interaction",
    ]);
    assert.deepEqual(consumer.online, ["composer", "install", "--no-interaction", "--prefer-dist"]);
    assert.deepEqual(consumer.check, ["php", "check.php"]);
    assert.deepEqual(consumer.offline, ["composer", "install", "--no-interaction", "--prefer-dist"]);
    assert.equal(consumer.offlineNetwork, "none");
    assert.deepEqual(consumer.environment, {});
    assert.equal(consumer.offlinePath, `/private/consumer/offline-consumers/${consumer.name}`);
  }
  assert.equal(Object.isFrozen(plan), true);
});

test("plans Composer repositories and lock expectations for release 0.1.1", () => {
  const plan = createComposerConsumerPlan({
    version: "0.1.1",
    taskIdentifier: "next-release",
    sandbox: "/private/consumer-next",
    imageTag: "gauntlet-php-compatibility:next-release-php83",
    uid: 501,
    gid: 20,
  });

  assert.equal(plan.version, "0.1.1");
  assert.deepEqual(plan.repositories.map(({ tag }) => tag), ["v0.1.1", "v0.1.1"]);
});

test("consumer planning rejects unsafe identifiers, paths, image tags, and identities", () => {
  const base = {
    version: "0.1.0",
    taskIdentifier: "unit",
    sandbox: "/private/consumer",
    imageTag: "gauntlet-php-compatibility:unit-php83",
    uid: 501,
    gid: 20,
  };
  for (const change of [
    { taskIdentifier: "../bad" },
    { sandbox: "relative" },
    { imageTag: "php:latest" },
    { version: "0.1.0-SNAPSHOT" },
    { uid: -1 },
    { gid: 1.5 },
  ]) {
    assert.throws(() => createComposerConsumerPlan({ ...base, ...change }), {
      message: "Composer consumer plan is invalid",
    });
  }
});

test("the consumer gate binds every staged or executed release input to HEAD", () => {
  assert.deepEqual(COMPOSER_CONSUMER_COMMITTED_INPUTS, [
    "LICENSE",
    "VERSION",
    "packages/php/Dockerfile",
    "packages/php/core",
    "packages/php/symfony-bundle",
    "tests/consumers/php-core",
    "tests/consumers/php-symfony",
  ]);
  assert.equal(Object.isFrozen(COMPOSER_CONSUMER_COMMITTED_INPUTS), true);
});

test("stable package versions pass even when harmless metadata contains dev aliases", () => {
  const lock = {
    packages: [{
      name: "opis/json-schema",
      version: "2.6.0",
      extra: { "branch-alias": { "dev-master": "2.x-dev" } },
    }],
    "packages-dev": [{ name: "symfony/framework-bundle", version: "v7.4.6" }],
  };
  assert.doesNotThrow(() => validateComposerLockPackageVersions(lock));
  assert.throws(
    () => validateComposerLockPackageVersions({ packages: [{ name: "unsafe/package", version: "dev-main" }] }),
    { message: "Composer consumer lock is not release-stable" },
  );
  assert.throws(
    () => validateComposerLockPackageVersions({ packages: [{ name: "unsafe/package", version: "1.0.x-dev" }] }),
    { message: "Composer consumer lock is not release-stable" },
  );
});
