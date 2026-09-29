import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPOSER_IMAGE,
  createPackageCommands,
  createDockerBuildInvocation,
  createDockerRunInvocation,
  createPhpCompatibilityPlan,
  PHP_IMAGES,
  runtimePlatformForArchitecture,
  SYMFONY_CONSTRAINT,
  SYMFONY_MINIMUM_PHP,
  SYMFONY_MINORS,
  verifySymfonyDependencyLine,
} from "../test-php-compatibility.mjs";

const EXPECTED_IMAGES = Object.freeze({
  "8.3": "php:8.3.33-cli-bookworm@sha256:177529735599a8244b2c903522f029839dce1c2ac4be122fdc00ada4b45a20e4",
  "8.4": "php:8.4.24-cli-bookworm@sha256:6003a0607eea6dc61d04723d3e60347c8481ffb2f09dbf85bf427b9ce0c25629",
  "8.5": "php:8.5.10-cli-bookworm@sha256:b80dfc7d2bc0fc97755620a0dfb3d5e8e9cbf70a2970ea2d5c9dc64154b31422",
});
const EXPECTED_PLATFORM = runtimePlatformForArchitecture(process.arch);

test("selects only the native supported Linux architecture", () => {
  assert.equal(runtimePlatformForArchitecture("arm64"), "linux/arm64");
  assert.equal(runtimePlatformForArchitecture("x64"), "linux/amd64");
  for (const architecture of ["ia32", "s390x", "", null]) {
    assert.throws(() => runtimePlatformForArchitecture(architecture), {
      message: "PHP compatibility host architecture is unsupported",
    });
  }
});

test("freezes the exact PHP, Composer, architecture, and compatibility matrix", () => {
  assert.deepEqual(PHP_IMAGES, EXPECTED_IMAGES);
  assert.equal(COMPOSER_IMAGE, "composer:2.10.3@sha256:4d045ea9f71d5d111a95e608400da61d187e487adf9eaf2dfe068998a8d4f584");
  assert.deepEqual(SYMFONY_MINORS, ["7.4", "8.1"]);
  assert.deepEqual(SYMFONY_MINIMUM_PHP, { "7.4": "8.3", "8.1": "8.4" });
  assert.equal(SYMFONY_CONSTRAINT, "^7.4 || ^8.0");
  assert.equal(Object.isFrozen(PHP_IMAGES), true);
  assert.equal(Object.isFrozen(SYMFONY_MINORS), true);
  assert.equal(Object.isFrozen(SYMFONY_MINIMUM_PHP), true);

  const plan = createPhpCompatibilityPlan("task-owned");
  assert.deepEqual(plan.builds.map(({ php, platform, image, tag }) => [php, platform, image, tag]), [
    ["8.3", EXPECTED_PLATFORM, EXPECTED_IMAGES["8.3"], "gauntlet-php-compatibility:task-owned-php83"],
    ["8.4", EXPECTED_PLATFORM, EXPECTED_IMAGES["8.4"], "gauntlet-php-compatibility:task-owned-php84"],
    ["8.5", EXPECTED_PLATFORM, EXPECTED_IMAGES["8.5"], "gauntlet-php-compatibility:task-owned-php85"],
  ]);
  assert.deepEqual(plan.core.map(({ php, suite }) => [php, suite]), [
    ["8.3", "unit"], ["8.4", "unit"], ["8.5", "unit"],
  ]);
  assert.deepEqual(plan.symfony.map(({ php, symfony, packages }) => [php, symfony, packages]), [
    ["8.3", "7.4", ["bundle", "example"]],
    ["8.4", "7.4", ["bundle", "example"]],
    ["8.4", "8.1", ["bundle", "example"]],
    ["8.5", "7.4", ["bundle", "example"]],
    ["8.5", "8.1", ["bundle", "example"]],
  ]);
  assert.equal(plan.symfony.length, 5);
  assert.equal(Object.isFrozen(plan), true);
});

test("rejects unsafe task identifiers before constructing image tags", () => {
  for (const value of ["", "Upper", "../escape", "a".repeat(65), null, new String("boxed")]) {
    assert.throws(() => createPhpCompatibilityPlan(value), {
      name: "TypeError",
      message: "Compatibility task identifier must be safe ASCII",
    });
  }
});

test("constructs closed Docker build and run invocations without host configuration or suppression flags", () => {
  const plan = createPhpCompatibilityPlan("unit");
  const environment = Object.freeze({
    PATH: "/fixed/bin",
    HOME: "/private/task/home",
    DOCKER_CONFIG: "/private/task/docker",
    TMPDIR: "/private/task/tmp",
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    NO_COLOR: "1",
  });
  const build = createDockerBuildInvocation({
    build: plan.builds[0],
    composerImage: COMPOSER_IMAGE,
    root: "/repository",
    environment,
  });
  assert.equal(build.command, "docker");
  assert.deepEqual(build.args, [
    "build", "--pull", "--platform", EXPECTED_PLATFORM,
    "--file", "/repository/packages/php/Dockerfile",
    "--build-arg", `PHP_IMAGE=${EXPECTED_IMAGES["8.3"]}`,
    "--build-arg", `COMPOSER_IMAGE=${COMPOSER_IMAGE}`,
    "--tag", "gauntlet-php-compatibility:unit-php83",
    "/repository",
  ]);
  assert.deepEqual(build.environment, environment);

  const run = createDockerRunInvocation({
    tag: plan.builds[0].tag,
    workspace: "/private/task/cell",
    cache: "/private/task/cache",
    workingDirectory: "/workspace/packages/php/core",
    command: ["composer", "audit", "--locked", "--no-interaction"],
    environment,
    uid: 501,
    gid: 20,
  });
  assert.deepEqual(run.args, [
    "run", "--rm", "--platform", EXPECTED_PLATFORM, "--user", "501:20",
    "--env", "HOME=/tmp/home", "--env", "COMPOSER_HOME=/tmp/composer",
    "--env", "COMPOSER_CACHE_DIR=/composer-cache", "--env", "COMPOSER_NO_INTERACTION=1",
    "--env", "COMPOSER_PROCESS_TIMEOUT=300", "--env", "CI=1",
    "--mount", "type=bind,src=/private/task/cell,dst=/workspace",
    "--mount", "type=bind,src=/private/task/cache,dst=/composer-cache",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=268435456",
    "--workdir", "/workspace/packages/php/core",
    "gauntlet-php-compatibility:unit-php83",
    "composer", "audit", "--locked", "--no-interaction",
  ]);
  assert.deepEqual(run.environment, environment);
  assert.doesNotMatch(JSON.stringify([build, run]), /(?:password|secret|token|auth|ignore-platform|prefer-lowest|no-audit)/i);
});

test("rejects unbounded or non-canonical Docker invocation inputs", () => {
  const environment = Object.freeze({ PATH: "/fixed/bin" });
  const plan = createPhpCompatibilityPlan("unit");
  for (const change of [
    { root: "relative" },
    { root: "/repository/../escape" },
    { composerImage: "composer:latest" },
  ]) {
    assert.throws(() => createDockerBuildInvocation({
      build: plan.builds[0], composerImage: COMPOSER_IMAGE, root: "/repository", environment, ...change,
    }), { message: "PHP compatibility invocation is invalid" });
  }
});

test("runs strict update, retires vendor inside the install container, then checks tests and platform", () => {
  assert.deepEqual(createPackageCommands("core"), [
    ["composer", "validate", "--strict", "--no-check-version", "--no-check-all", "--no-interaction"],
    ["composer", "update", "--no-interaction", "--prefer-dist", "--with-all-dependencies"],
    ["sh", "-ec", "test ! -e .gauntlet-vendor-after-update && test ! -L .gauntlet-vendor-after-update && mv vendor .gauntlet-vendor-after-update && test ! -e vendor && test ! -L vendor && exec composer install --no-interaction --prefer-dist"],
    ["vendor/bin/phpunit", "--testsuite", "unit", "--do-not-cache-result"],
    ["composer", "check-platform-reqs"],
    ["composer", "audit", "--locked", "--no-interaction"],
  ]);
  for (const kind of ["bundle", "example"]) {
    for (const minor of ["7.4", "8.1"]) {
      const commands = createPackageCommands(kind, minor);
      assert.deepEqual(commands[0], [
        "composer", "validate", "--strict", "--no-check-version", "--no-check-all", "--no-interaction",
      ]);
      assert.deepEqual(commands[1], [
        "composer", "update", `symfony/*:${minor}.*`, "--no-interaction", "--prefer-dist", "--with-all-dependencies",
      ]);
      assert.deepEqual(commands[2], [
        "sh", "-ec", "test ! -e .gauntlet-vendor-after-update && test ! -L .gauntlet-vendor-after-update && mv vendor .gauntlet-vendor-after-update && test ! -e vendor && test ! -L vendor && exec composer install --no-interaction --prefer-dist",
      ]);
      assert.deepEqual(commands[3], ["vendor/bin/phpunit", "--testsuite", "all", "--do-not-cache-result"]);
      assert.doesNotMatch(JSON.stringify(commands), /(?:prefer-lowest|ignore-platform|no-audit|no-blocking)/i);
    }
  }
  assert.throws(() => createPackageCommands("bundle", "7.2"), {
    message: "PHP compatibility package command is invalid",
  });
  assert.throws(() => createPackageCommands("bundle", "8.0"), {
    message: "PHP compatibility package command is invalid",
  });
  assert.throws(() => createPackageCommands("bundle", "8.2"), {
    message: "PHP compatibility package command is invalid",
  });
});

test("checks every selected Symfony line for direct package requirements without rejecting compatible transitive components", () => {
  const manifest = {
    require: {
      php: ">=8.3",
      "symfony/framework-bundle": "^7.4 || ^8.0",
      "symfony/http-foundation": "^7.4 || ^8.0",
    },
    "require-dev": {
      "symfony/browser-kit": "^7.4 || ^8.0",
    },
  };
  const lock = {
    packages: [
      { name: "symfony/framework-bundle", version: "v7.4.6" },
      { name: "symfony/http-foundation", version: "v7.4.6" },
      { name: "symfony/cache", version: "v8.1.6" },
    ],
    "packages-dev": [
      { name: "symfony/browser-kit", version: "v7.4.6" },
    ],
  };
  const lockOn = (version) => ({
    packages: lock.packages.map((entry) => entry.name === "symfony/cache" ? entry : { ...entry, version }),
    "packages-dev": lock["packages-dev"].map((entry) => ({ ...entry, version })),
  });

  assert.doesNotThrow(() => verifySymfonyDependencyLine(manifest, lock, "7.4"));
  assert.doesNotThrow(() => verifySymfonyDependencyLine(manifest, lockOn("v8.1.7"), "8.1"));
  assert.throws(
    () => verifySymfonyDependencyLine(manifest, {
      ...lock,
      packages: lock.packages.map((entry) => entry.name === "symfony/http-foundation"
        ? { ...entry, version: "v8.1.6" }
        : entry),
    }, "7.4"),
    /Resolved direct Symfony dependency does not match 7\.4/,
  );
  assert.throws(
    () => verifySymfonyDependencyLine(manifest, lock, "8.1"),
    /Resolved direct Symfony dependency does not match 8\.1/,
  );
  assert.throws(
    () => verifySymfonyDependencyLine({
      ...manifest,
      require: { ...manifest.require, "symfony/http-foundation": "^7.4" },
    }, lock, "7.4"),
    /Direct Symfony dependency constraints do not match \^7\.4 \|\| \^8\.0/,
  );
  assert.throws(() => verifySymfonyDependencyLine(manifest, lock, "8.0"), {
    message: "Symfony dependency verification failed safely",
  });
});
