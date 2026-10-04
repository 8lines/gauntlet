import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { unitIdForArtifact } from "../plan.mjs";
import {
  RELEASE_ARTIFACTS,
  readUnitVersion,
} from "../release-model.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CANONICAL_ROOT = realpathSync(REPOSITORY_ROOT);
// The unmodified Apache License 2.0 text as published at
// https://www.apache.org/licenses/LICENSE-2.0.txt.
const LICENSE_BYTES = 11_358;
const LICENSE_SHA256 = "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30";
const NOTICE = Buffer.from("Gauntlet\nCopyright 2026 8lines\n", "ascii");
const NPM_REGISTRY = "https://registry.npmjs.org/";
const SOURCE_REPOSITORY = "https://github.com/8lines/gauntlet.git";
const PROJECT_HOMEPAGE = "https://github.com/8lines/gauntlet";
const PHP_IMAGE =
  "php:8.3.33-cli-bookworm@sha256:177529735599a8244b2c903522f029839dce1c2ac4be122fdc00ada4b45a20e4";
const COMPOSER_IMAGE =
  "composer:2.10.3@sha256:4d045ea9f71d5d111a95e608400da61d187e487adf9eaf2dfe068998a8d4f584";
const NPM_DESCRIPTIONS = new Map([
  [
    "@8lines/gauntlet-protocol",
    "Language-neutral Adapter v1 contracts, JSON Schemas, OpenAPI definitions, semantic validators, and conformance fixtures for Gauntlet.",
  ],
  [
    "@8lines/gauntlet-dashboard-client",
    "Validated Adapter v1 HTTP client, protocol response validation, and run event streaming for the Gauntlet control plane.",
  ],
  [
    "@8lines/gauntlet-typescript-core",
    "Framework-neutral registries, validation, execution coordination, run management, and capability catalog for TypeScript Gauntlet adapters.",
  ],
  [
    "@8lines/gauntlet-typescript-node",
    "Node.js Web Request and Response transport for exposing an explicitly registered Gauntlet adapter catalog.",
  ],
  [
    "@8lines/gauntlet-next-adapter",
    "Next.js App Router bridge for exposing an explicitly registered Gauntlet adapter catalog through normalized Web Requests.",
  ],
  [
    "@8lines/gauntlet-conformance-runner",
    "Scenario-driven Adapter v1 conformance libraries, CLI runners, and fixture adapter for Gauntlet implementations.",
  ],
  [
    "@8lines/gauntlet-widget",
    "Typed, SSR-safe commands and page-subject types for embedding the Gauntlet widget in a web application.",
  ],
]);

const PACKAGE_LICENSE_PATHS = [
  ...RELEASE_ARTIFACTS.npm.map(({ directory }) => `${directory}/LICENSE`),
  ...RELEASE_ARTIFACTS.composer.map(({ directory }) => `${directory}/LICENSE`),
  "deploy/helm/gauntlet/LICENSE",
  "deploy/compose/LICENSE",
];
const OWNED_METADATA_PATHS = [
  ".npmrc",
  "NOTICE",
  ...RELEASE_ARTIFACTS.npm.map(({ directory }) => `${directory}/package.json`),
  ...RELEASE_ARTIFACTS.composer.map(({ directory }) => `${directory}/composer.json`),
  "LICENSE",
  ...PACKAGE_LICENSE_PATHS,
];
const FORBIDDEN_CREDENTIAL_PATTERNS = [
  /_auth(?:token)?[\t ]*=/i,
  /always-auth[\t ]*=/i,
  /\b(?:authorization|user(?:name)?|password|passwd|token|secret|api[-_]?key|private[-_]?key)[\t ]*[:=]/i,
  /\b(?:bearer|basic)[\t ]+[a-z0-9+/._~=-]+/i,
  /\b(?:https?|git\+https):\/\/[^\s/?#]+@/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\$\{|\{\{|\$\(/,
];
const FORBIDDEN_CREDENTIAL_KEYS = new Set([
  "auth",
  "authentication",
  "authorization",
  "credential",
  "credentials",
  "user",
  "username",
]);
const FORBIDDEN_CREDENTIAL_KEY_SUFFIXES = ["apikey", "password", "passwd", "privatekey", "secret", "token"];
const FORBIDDEN_NPM_TOP_LEVEL_FIELDS = [
  "access",
  "auth",
  "_auth",
  "_authToken",
  "authorization",
  "token",
  "secret",
  "apiKey",
  "username",
  "password",
];
const CREDENTIAL_MUTATIONS = [
  ["nested JSON password key", '{"configuration":{"password":"SECRET"}}'],
  ["array-nested JSON username key", '{"configuration":[{"username":"admin"}]}'],
  ["JSON authorization key", '{"authorization":"Basic SECRET"}'],
  ["generic JSON token key", '{"token":"SECRET"}'],
  ["generic JSON secret key", '{"secret":"SECRET"}'],
  ["hyphenated JSON API key", '{"api-key":"SECRET"}'],
  ["Bearer authorization value", '{"header":"Bearer SECRET"}'],
  ["Basic authorization value", '{"header":"Basic SECRET"}'],
  ["npm auth token assignment", "//registry.npmjs.org/:_authToken=SECRET"],
  ["npm legacy auth assignment", "_auth=SECRET"],
  ["npm always-auth assignment", "always-auth=true"],
  ["URL user information", "https://admin:SECRET@example.invalid/package"],
  ["shell parameter interpolation", "${TOKEN}"],
  ["template interpolation", "{{ TOKEN }}"],
  ["command interpolation", "$(credential-helper)"],
  ["PEM private key", "-----BEGIN PRIVATE KEY-----"],
];

function absolutePath(relativePath) {
  return resolve(REPOSITORY_ROOT, relativePath);
}

function isForbiddenCredentialKey(key) {
  const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
  return (
    FORBIDDEN_CREDENTIAL_KEYS.has(normalized) ||
    FORBIDDEN_CREDENTIAL_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  );
}

function hasForbiddenCredentialKey(value) {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    for (const [key, child] of Object.entries(current)) {
      if (isForbiddenCredentialKey(key)) return true;
      pending.push(child);
    }
  }
  return false;
}

function containsCredentialMaterial(source) {
  if (FORBIDDEN_CREDENTIAL_PATTERNS.some((pattern) => pattern.test(source))) return true;
  const trimmed = source.trimStart();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try {
    return hasForbiddenCredentialKey(JSON.parse(source));
  } catch {
    return true;
  }
}

function assertCredentialFree(source) {
  assert.equal(containsCredentialMaterial(source), false, "Release metadata contains forbidden credential material");
}

function readJson(relativePath) {
  const source = readFileSync(absolutePath(relativePath), "utf8");
  assertCredentialFree(source);
  return JSON.parse(source);
}

function assertClosedRegularFile(relativePath) {
  const path = absolutePath(relativePath);
  const stat = lstatSync(path);
  assert.equal(stat.isFile(), true, `Expected a regular file at ${relativePath}`);
  assert.equal(stat.isSymbolicLink(), false, `Expected no symbolic link at ${relativePath}`);
  assert.equal(stat.nlink, 1, `Expected no hard link at ${relativePath}`);
  assert.equal(stat.mode & 0o777, 0o644, `Expected mode 0644 at ${relativePath}`);
  assert.equal(realpathSync(path), resolve(CANONICAL_ROOT, relativePath), `Expected no linked path at ${relativePath}`);
}

test("the Apache License 2.0 text has exact pinned bytes and eleven identical distributable copies", () => {
  assertClosedRegularFile("LICENSE");
  const rootLicense = readFileSync(absolutePath("LICENSE"));
  assertCredentialFree(rootLicense.toString("utf8"));
  assert.equal(rootLicense.length, LICENSE_BYTES);
  assert.equal(createHash("sha256").update(rootLicense).digest("hex"), LICENSE_SHA256);
  assert.equal(rootLicense.includes(0x0d), false);
  assert.match(rootLicense.toString("ascii"), /^\n {33}Apache License\n {27}Version 2\.0, January 2004\n/u);
  assert.equal(PACKAGE_LICENSE_PATHS.length, 11);

  for (const relativePath of PACKAGE_LICENSE_PATHS) {
    assertClosedRegularFile(relativePath);
    const copy = readFileSync(absolutePath(relativePath));
    assertCredentialFree(copy.toString("utf8"));
    assert.deepEqual(copy, rootLicense, `License differs at ${relativePath}`);
  }
});

test("the root NOTICE names the project and its copyright holder", () => {
  assertClosedRegularFile("NOTICE");
  const notice = readFileSync(absolutePath("NOTICE"));
  assertCredentialFree(notice.toString("utf8"));
  assert.deepEqual(notice, NOTICE);
});

test("seven npm artifacts expose exact Apache-2.0 public release metadata", () => {
  assert.equal(RELEASE_ARTIFACTS.npm.length, 7);
  assert.equal(NPM_DESCRIPTIONS.size, 7);

  for (const { name, directory, registry } of RELEASE_ARTIFACTS.npm) {
    const manifest = readJson(`${directory}/package.json`);
    assert.equal(manifest.name, name);
    assert.equal(manifest.version, readUnitVersion(REPOSITORY_ROOT, unitIdForArtifact(name)));
    assert.equal(manifest.description, NPM_DESCRIPTIONS.get(name));
    assert.equal(manifest.private, undefined);
    assert.equal(
      FORBIDDEN_NPM_TOP_LEVEL_FIELDS.some((field) => Object.hasOwn(manifest, field)),
      false,
      "NPM manifest contains forbidden authentication or access metadata",
    );
    assert.equal(manifest.license, "Apache-2.0");
    assert.deepEqual(manifest.engines, { node: ">=24 <27" });
    assert.equal(registry, NPM_REGISTRY);
    assert.deepEqual(manifest.repository, {
      type: "git",
      url: SOURCE_REPOSITORY,
      directory,
    });
    assert.deepEqual(manifest.publishConfig, {
      access: "public",
      registry: NPM_REGISTRY,
    });
  }
});

test("two Composer artifacts expose exact Apache-2.0 project and support metadata", () => {
  assert.equal(RELEASE_ARTIFACTS.composer.length, 2);

  for (const { name, directory } of RELEASE_ARTIFACTS.composer) {
    const manifest = readJson(`${directory}/composer.json`);
    assert.equal(manifest.name, name);
    assert.equal(manifest.version, readUnitVersion(REPOSITORY_ROOT, unitIdForArtifact(name)));
    assert.equal(manifest.license, "Apache-2.0");
    assert.equal(manifest.homepage, PROJECT_HOMEPAGE);
    assert.deepEqual(manifest.support, {
      issues: `${PROJECT_HOMEPAGE}/issues`,
      source: PROJECT_HOMEPAGE,
    });
  }
});

test("PHP packages and the Symfony example expose the supported PHP 8.3 floor and Symfony 7.4 and 8.x lines", () => {
  const coreVersion = readUnitVersion(CANONICAL_ROOT, "php-core");
  const bundleVersion = readUnitVersion(CANONICAL_ROOT, "symfony-bundle");
  const core = readJson("packages/php/core/composer.json");
  const bundle = readJson("packages/php/symfony-bundle/composer.json");
  const example = readJson("examples/symfony/composer.json");

  assert.equal(core.require.php, ">=8.3");
  assert.equal(bundle.require.php, ">=8.3");
  assert.equal(example.require.php, ">=8.3");
  assert.equal(example.license, "Apache-2.0");

  assert.equal(bundle.require["8lines/gauntlet-php-core"], `^${coreVersion}`);
  assert.deepEqual(
    Object.fromEntries(
      [...Object.entries(bundle.require), ...Object.entries(bundle["require-dev"])]
        .filter(([name]) => name.startsWith("symfony/")),
    ),
    {
      "symfony/config": "^7.4 || ^8.0",
      "symfony/dependency-injection": "^7.4 || ^8.0",
      "symfony/framework-bundle": "^7.4 || ^8.0",
      "symfony/http-foundation": "^7.4 || ^8.0",
      "symfony/property-access": "^7.4 || ^8.0",
      "symfony/property-info": "^7.4 || ^8.0",
      "symfony/routing": "^7.4 || ^8.0",
      "symfony/serializer": "^7.4 || ^8.0",
      "symfony/validator": "^7.4 || ^8.0",
      "symfony/browser-kit": "^7.4 || ^8.0",
    },
  );

  assert.equal(example.require["8lines/gauntlet-php-core"], `^${coreVersion}`);
  assert.equal(example.require["8lines/gauntlet-symfony-bundle"], `^${bundleVersion}`);
  assert.deepEqual(
    Object.fromEntries(
      [...Object.entries(example.require), ...Object.entries(example["require-dev"])]
        .filter(([name]) => name.startsWith("symfony/")),
    ),
    {
      "symfony/framework-bundle": "^7.4 || ^8.0",
      "symfony/browser-kit": "^7.4 || ^8.0",
    },
  );
});

test("PHP Dockerfiles default to exact reproducible images and assert their required extension unions", () => {
  const dockerfiles = [
    [
      "packages/php/Dockerfile",
      ["curl", "dom", "hash", "json", "libxml", "mbstring"],
    ],
    [
      "examples/symfony/Dockerfile",
      ["curl", "dom", "hash", "json", "libxml", "mbstring", "pdo", "pdo_sqlite"],
    ],
  ];

  for (const [relativePath, extensions] of dockerfiles) {
    const source = readFileSync(absolutePath(relativePath), "utf8");
    assert.equal(source.split("\n").includes(`ARG PHP_IMAGE=${PHP_IMAGE}`), true);
    assert.match(source, /^FROM \$\{PHP_IMAGE\}$/m);
    assert.equal(source.split("\n").includes(`ARG COMPOSER_IMAGE=${COMPOSER_IMAGE}`), true);
    assert.match(source, /^FROM \$\{COMPOSER_IMAGE\} AS composer$/m);
    assert.match(source, /^COPY --from=composer \/usr\/bin\/composer \/usr\/(?:local\/)?bin\/composer$/m);
    assert.doesNotMatch(source, /^FROM --platform=/m);

    const extensionAssertion = source.match(/foreach \((\[[^\n]+\]) as \$extension\)/);
    assert.notEqual(extensionAssertion, null, `Missing extension assertion in ${relativePath}`);
    assert.deepEqual(JSON.parse(extensionAssertion[1]), extensions);
  }
});

test("the repository npm configuration uses the public registry without storing authentication", () => {
  const source = readFileSync(absolutePath(".npmrc"), "utf8");
  assertCredentialFree(source);
  assert.equal(source, "engine-strict=true\nstrict-peer-dependencies=true\n");
});

test("the credential scanner rejects every owned metadata mutation without exposing its value", async (t) => {
  for (const [label, source] of CREDENTIAL_MUTATIONS) {
    await t.test(label, () => {
      assert.equal(
        containsCredentialMaterial(source),
        true,
        "Credential marker was not rejected",
      );
    });
  }
});

test("the bounded release metadata set contains no credential material or interpolation", () => {
  assert.equal(OWNED_METADATA_PATHS.length, 23);

  for (const relativePath of OWNED_METADATA_PATHS) {
    const source = readFileSync(absolutePath(relativePath), "utf8");
    assertCredentialFree(source);
  }
});
