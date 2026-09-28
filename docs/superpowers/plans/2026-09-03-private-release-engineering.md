# Private Release Engineering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a reproducible, private `0.1.0` release of every supported Gauntlet package, OCI image, and Helm chart, with one local dry-run command and tag-gated GitHub Actions publication.

**Architecture:** A root `VERSION` file and a typed artifact catalog are the release source of truth. Release staging builds the exact npm tarballs, Composer split trees, Maven repository, Helm archive, OCI image metadata, SPDX SBOM, checksums, and inventory that later publication consumes; publishing never rebuilds a package from a different source tree. GitHub Packages and GHCR use the repository `GITHUB_TOKEN`, while a repository-restricted GitHub App writes the two Composer split repositories.

**Tech Stack:** Node.js 24–26, pnpm 11.24, PHP 8.3–8.5, Symfony 7.2–7.4, Composer 2, Java 21, Gradle 9.2.1, GitHub Actions, GitHub Packages, GHCR, Docker Buildx/BuildKit, Helm OCI, Trivy, SPDX

## Spec

Implement the approved design in `docs/superpowers/specs/2026-09-02-release-standalone-safety-skills-design.md`. If implementation evidence conflicts with this plan, stop and reconcile the plan with that design before changing release behavior.

## Global Constraints

- The canonical source repository is private `8lines/gauntlet`; `main` is the integration branch.
- All v0.1 product artifacts use version `0.1.0`; Adapter protocol compatibility remains independently declared as v1.
- Publishable npm packages support Node.js `>=24 <27` and publish only to `https://npm.pkg.github.com` under `@8lines`.
- PHP packages support PHP `>=8.3`; the Symfony bundle supports Symfony `^7.2`. CI proves PHP 8.3, 8.4, and 8.5 against Symfony 7.2, 7.3, and 7.4.
- Java artifacts use Java 21 and release versions without `-SNAPSHOT`.
- The image and Helm chart publish only to private GHCR. Deployment examples use a semantic version or digest and never `latest`.
- The image contains the dashboard and Fastify control plane; release engineering consumes that image contract and does not create a second UI or server artifact.
- Docker Compose and the Helm chart are the supported deployment paths; target discovery remains explicit and receives no Docker or Kubernetes discovery privileges.
- Production is unsupported. There is no production environment kind and no override switch.
- Authentication remains deferred, so release examples preserve the private-network boundary and never publish adapter routes.
- The control plane remains a one-replica, in-memory process for v0.1; release metadata must not imply high availability or durable history.
- The repository and artifacts are proprietary. npm uses `UNLICENSED`, Composer uses `proprietary`, Maven and OCI use `LicenseRef-Proprietary`, and every distributable contains the project license notice.
- Publication must not start from a dirty checkout, an untagged commit, a tag that differs from `VERSION`, or a tag whose commit is not reachable from `origin/main`.
- Existing uncommitted dashboard and Fastify static-serving work is user-owned input. Incorporate it through its own implementation plan before enforcing the clean-release gate; never discard it.
- GitHub Artifact Attestations are unavailable for a private repository on the current 8lines GitHub Free plan. Use BuildKit SLSA provenance `mode=max,version=v1` and SPDX SBOM attestations attached to the private GHCR image.

---

### Task 1: Define the release artifact and version model

**Files:**
- Create: `VERSION`
- Create: `scripts/release/release-model.mjs`
- Create: `scripts/release/version.mjs`
- Create: `scripts/release/test/release-model.test.mjs`
- Modify: `package.json`
- Test: `scripts/release/test/release-model.test.mjs`

**Interfaces:**
- Consumes: repository root, optional exact Git tag string, and the version-bearing manifests listed by `RELEASE_ARTIFACTS`.
- Produces: `RELEASE_ARTIFACTS`, `parseReleaseVersion(raw)`, `readReleaseVersion(root)`, `collectVersionMismatches(root, expectedTag)`, and CLI commands `node scripts/release/version.mjs --check [--tag v0.1.0]` and `node scripts/release/version.mjs --set 0.1.1`.
- Synchronizes: Helm `Chart.yaml` `version`/`appVersion` and `values.yaml` `image.tag` to the same root `VERSION`.

- [ ] **Step 1: Write failing tests for the strict release version**

```javascript
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseReleaseVersion,
  RELEASE_ARTIFACTS,
} from "../release-model.mjs";

test("accepts the exact stable release version", () => {
  assert.equal(parseReleaseVersion("0.1.0\n"), "0.1.0");
});

test("rejects snapshots, prereleases, and a v-prefixed VERSION file", () => {
  for (const value of ["0.1.0-SNAPSHOT", "0.1.0-rc.1", "v0.1.0"])
    assert.throws(() => parseReleaseVersion(value), /stable semantic version/);
});

test("catalog names every private release artifact exactly once", () => {
  assert.deepEqual(RELEASE_ARTIFACTS.npm.map(({ name }) => name), [
    "@8lines/gauntlet-protocol",
    "@8lines/gauntlet-dashboard-client",
    "@8lines/gauntlet-typescript-core",
    "@8lines/gauntlet-typescript-node",
    "@8lines/gauntlet-next-adapter",
    "@8lines/gauntlet-conformance-runner",
  ]);
  assert.deepEqual(RELEASE_ARTIFACTS.composer.map(({ name }) => name), [
    "8lines/gauntlet-php-core",
    "8lines/gauntlet-symfony-bundle",
  ]);
  assert.deepEqual(RELEASE_ARTIFACTS.maven.map(({ name }) => name), [
    "dev.eightlines.gauntlet:core",
    "dev.eightlines.gauntlet:spring-boot-starter",
  ]);
});
```

- [ ] **Step 2: Run the tests and confirm the release model is absent**

Run: `node --test scripts/release/test/release-model.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/release/release-model.mjs`.

- [ ] **Step 3: Implement the artifact catalog and strict parser**

```javascript
export const RELEASE_ARTIFACTS = Object.freeze({
  npm: Object.freeze([
    { name: "@8lines/gauntlet-protocol", directory: "packages/protocol" },
    { name: "@8lines/gauntlet-dashboard-client", directory: "packages/dashboard-client" },
    { name: "@8lines/gauntlet-typescript-core", directory: "packages/typescript/core" },
    { name: "@8lines/gauntlet-typescript-node", directory: "packages/typescript/node" },
    { name: "@8lines/gauntlet-next-adapter", directory: "packages/typescript/next" },
    { name: "@8lines/gauntlet-conformance-runner", directory: "conformance/runner" },
  ]),
  composer: Object.freeze([
    { name: "8lines/gauntlet-php-core", directory: "packages/php/core", repository: "gauntlet-php-core" },
    { name: "8lines/gauntlet-symfony-bundle", directory: "packages/php/symfony-bundle", repository: "gauntlet-symfony-bundle" },
  ]),
  maven: Object.freeze([
    { name: "dev.eightlines.gauntlet:core", project: ":core" },
    { name: "dev.eightlines.gauntlet:spring-boot-starter", project: ":spring-boot-starter" },
  ]),
  image: Object.freeze({ name: "ghcr.io/8lines/gauntlet" }),
  chart: Object.freeze({ name: "gauntlet", repository: "oci://ghcr.io/8lines/charts" }),
});

export function parseReleaseVersion(raw) {
  const version = raw.trim();
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
    throw new Error(`Release version must be a stable semantic version, received ${JSON.stringify(version)}`);
  return version;
}
```

Write `0.1.0` plus one trailing newline to `VERSION`. Add root scripts:

```json
{
  "scripts": {
    "release:version": "node scripts/release/version.mjs",
    "release:test": "node --test scripts/release/test/*.test.mjs"
  }
}
```

- [ ] **Step 4: Add mismatch tests before implementing repository validation**

Create fixture manifests inside a temporary directory and assert that `collectVersionMismatches()` reports:

```javascript
assert.deepEqual(collectVersionMismatches(root, "v0.1.0"), []);
assert.match(collectVersionMismatches(root, "v0.1.1").join("\n"), /tag v0\.1\.1.*VERSION 0\.1\.0/);
assert.match(collectVersionMismatches(rootWithSnapshot, "v0.1.0").join("\n"), /0\.1\.0-SNAPSHOT/);
assert.match(
  collectVersionMismatches(rootWithHelmImageTag("0.1.1"), "v0.1.0").join("\n"),
  /deploy\/helm\/gauntlet\/values\.yaml.*image\.tag.*0\.1\.1.*0\.1\.0/,
);
```

- [ ] **Step 5: Run the mismatch tests and confirm they fail for missing validation**

Run: `node --test scripts/release/test/release-model.test.mjs`

Expected: FAIL because `collectVersionMismatches` is not exported.

- [ ] **Step 6: Implement version collection and the check/set CLI**

The implementation must read and update these exact locations:

```javascript
export const VERSION_LOCATIONS = Object.freeze([
  ...RELEASE_ARTIFACTS.npm.map(({ directory }) => ({ type: "json", path: `${directory}/package.json`, key: "version" })),
  ...RELEASE_ARTIFACTS.composer.map(({ directory }) => ({ type: "json", path: `${directory}/composer.json`, key: "version" })),
  { type: "gradle-root", path: "packages/java/build.gradle.kts" },
  { type: "helm", path: "deploy/helm/gauntlet/Chart.yaml", key: "version" },
  { type: "helm", path: "deploy/helm/gauntlet/Chart.yaml", key: "appVersion" },
  { type: "helm", path: "deploy/helm/gauntlet/values.yaml", key: "image.tag" },
]);
```

The Helm reader/writer treats `image.tag` as a dot-separated YAML property path and preserves the surrounding mapping and scalar style. `--set` updates only those fields and exact internal dependency constraints. It must fail before writing when the requested version is not accepted by `parseReleaseVersion`.

- [ ] **Step 7: Verify version checks are green**

Run: `node --test scripts/release/test/release-model.test.mjs && node scripts/release/version.mjs --check`

Expected: PASS and `release version 0.1.0 is consistent`.

- [ ] **Step 8: Commit the release version contract**

```bash
git add VERSION package.json scripts/release/release-model.mjs scripts/release/version.mjs scripts/release/test/release-model.test.mjs
git commit -m "build: define unified release version"
```

### Task 2: Add proprietary license and package metadata

**Files:**
- Create: `LICENSE`
- Create: `packages/protocol/LICENSE`
- Create: `packages/dashboard-client/LICENSE`
- Create: `packages/typescript/core/LICENSE`
- Create: `packages/typescript/node/LICENSE`
- Create: `packages/typescript/next/LICENSE`
- Create: `conformance/runner/LICENSE`
- Create: `packages/php/core/LICENSE`
- Create: `packages/php/symfony-bundle/LICENSE`
- Create: `scripts/release/test/package-metadata.test.mjs`
- Modify: `.npmrc`
- Modify: `packages/protocol/package.json`
- Modify: `packages/dashboard-client/package.json`
- Modify: `packages/typescript/core/package.json`
- Modify: `packages/typescript/node/package.json`
- Modify: `packages/typescript/next/package.json`
- Modify: `conformance/runner/package.json`
- Modify: `packages/php/core/composer.json`
- Modify: `packages/php/symfony-bundle/composer.json`
- Modify: `packages/java/build.gradle.kts`
- Modify: `packages/java/core/build.gradle.kts`
- Modify: `packages/java/spring-boot-starter/build.gradle.kts`
- Test: `scripts/release/test/package-metadata.test.mjs`

**Interfaces:**
- Consumes: `RELEASE_ARTIFACTS` and `VERSION` from Task 1.
- Produces: registry-linked npm and Composer manifests, byte-identical package license files, and Java POM license/repository metadata.

- [ ] **Step 1: Write failing metadata tests**

```javascript
for (const { name, directory } of RELEASE_ARTIFACTS.npm) {
  const manifest = readJson(`${directory}/package.json`);
  assert.equal(manifest.name, name);
  assert.equal(manifest.version, version);
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.license, "UNLICENSED");
  assert.equal(manifest.engines.node, ">=24 <27");
  assert.equal(manifest.publishConfig.registry, "https://npm.pkg.github.com");
  assert.equal(manifest.repository.url, "https://github.com/8lines/gauntlet.git");
  assert.equal(manifest.repository.directory, directory);
  assert.equal(readFile(`${directory}/LICENSE`), readFile("LICENSE"));
}

for (const path of ["packages/php/core/composer.json", "packages/php/symfony-bundle/composer.json"]) {
  const manifest = readJson(path);
  assert.equal(manifest.license, "proprietary");
  assert.equal(manifest.homepage, "https://github.com/8lines/gauntlet");
  assert.equal(manifest.support.issues, "https://github.com/8lines/gauntlet/issues");
  assert.equal(manifest.support.source, "https://github.com/8lines/gauntlet");
}
```

Also assert `.npmrc` maps `@8lines` without `_authToken`, every package license is byte-identical to root `LICENSE`, and the Gradle POM configuration for Core and the Spring Boot starter contains `LicenseRef-Proprietary` plus the canonical source/SCM URLs. Do not assert PHP or Symfony version constraints in this task.

- [ ] **Step 2: Run the test and observe missing metadata**

Run: `node --test scripts/release/test/package-metadata.test.mjs`

Expected: FAIL on the first missing npm `license` field.

- [ ] **Step 3: Add the proprietary license notice and npm metadata**

Use this project notice in root and package copies:

```text
Copyright (c) 2026 8lines. All rights reserved.

This software and its documentation are proprietary and confidential to 8lines.
No permission is granted to use, copy, modify, distribute, sublicense, or disclose
them except under a separate written agreement with 8lines.
```

Each npm manifest receives this exact shape, with its own directory and description:

```json
{
  "license": "UNLICENSED",
  "repository": {
    "type": "git",
    "url": "https://github.com/8lines/gauntlet.git",
    "directory": "packages/protocol"
  },
  "publishConfig": {
    "registry": "https://npm.pkg.github.com"
  }
}
```

Write `.npmrc` as:

```ini
engine-strict=true
strict-peer-dependencies=true
@8lines:registry=https://npm.pkg.github.com
```

- [ ] **Step 4: Add Composer license and repository metadata**

Both manifests receive:

```json
{
  "license": "proprietary",
  "homepage": "https://github.com/8lines/gauntlet",
  "support": {
    "issues": "https://github.com/8lines/gauntlet/issues",
    "source": "https://github.com/8lines/gauntlet"
  }
}
```

- [ ] **Step 5: Configure Java publication metadata without credentials**

Define common POM metadata in `packages/java/build.gradle.kts` and apply it only to `:core` and `:spring-boot-starter`:

```kotlin
fun MavenPom.gauntletMetadata(displayName: String, summary: String) {
    name.set(displayName)
    description.set(summary)
    url.set("https://github.com/8lines/gauntlet")
    licenses {
        license {
            name.set("LicenseRef-Proprietary")
            distribution.set("repository")
        }
    }
    scm {
        connection.set("scm:git:https://github.com/8lines/gauntlet.git")
        url.set("https://github.com/8lines/gauntlet")
    }
}
```

No token, password, username, or private key may be written to Gradle source or properties.

- [ ] **Step 6: Run metadata tests**

Run: `node --test scripts/release/test/package-metadata.test.mjs`

Expected: PASS without credentials in output and without reading or changing PHP/Symfony compatibility constraints, `packages/php/Dockerfile`, or Composer lockfiles.

- [ ] **Step 7: Commit package metadata**

```bash
git add LICENSE .npmrc packages/protocol/LICENSE packages/protocol/package.json packages/dashboard-client/LICENSE packages/dashboard-client/package.json packages/typescript/core/LICENSE packages/typescript/core/package.json packages/typescript/node/LICENSE packages/typescript/node/package.json packages/typescript/next/LICENSE packages/typescript/next/package.json conformance/runner/LICENSE conformance/runner/package.json packages/php/core/LICENSE packages/php/core/composer.json packages/php/symfony-bundle/LICENSE packages/php/symfony-bundle/composer.json packages/java/build.gradle.kts packages/java/core/build.gradle.kts packages/java/spring-boot-starter/build.gradle.kts scripts/release/test/package-metadata.test.mjs
git commit -m "build: prepare proprietary package metadata"
```

### Task 3: Stage and verify npm tarballs

**Files:**
- Create: `scripts/release/stage-npm.mjs`
- Create: `scripts/release/test/stage-npm.test.mjs`
- Create: `packages/dashboard-client/README.md`
- Create: `conformance/runner/README.md`
- Modify: `scripts/test-packed-npm-packages.mjs`
- Modify: `package.json`
- Test: `scripts/release/test/stage-npm.test.mjs`
- Test: `scripts/test-packed-npm-packages.mjs`

**Interfaces:**
- Consumes: `RELEASE_ARTIFACTS.npm`, version `readReleaseVersion(root)`, built package `dist` directories, and an explicit staging directory.
- Produces: `stageNpmPackages({ root, outputDirectory }) -> Promise<StagedArtifact[]>`, where every artifact has `{ kind: "npm", name, version, path, sha256 }`.

- [ ] **Step 1: Add failing archive-contract assertions**

Extend `scripts/test-packed-npm-packages.mjs` to assert each tarball contains:

```javascript
for (const required of ["package/package.json", "package/README.md", "package/LICENSE"])
  assert.ok(shipped.has(required), `${current.name} is missing ${required}`);

assert.equal(manifest.version, "0.1.0");
assert.equal(manifest.license, "UNLICENSED");
assert.equal(manifest.publishConfig.registry, "https://npm.pkg.github.com");
assert.ok(statSync(archive).size < 50 * 1024 * 1024, `${current.name} archive exceeds 50 MiB`);
for (const value of Object.values(manifest.dependencies ?? {}))
  assert.equal(String(value).startsWith("workspace:"), false, `${current.name} leaked workspace:`);
```

- [ ] **Step 2: Run the packed-consumer test and confirm missing README/LICENSE failures**

Run: `pnpm test:packages`

Expected: FAIL for at least `@8lines/gauntlet-dashboard-client` missing `package/README.md`.

- [ ] **Step 3: Add package-specific README files and archive contents**

The dashboard-client README documents that it is a server-to-adapter validated client, not browser code. The conformance-runner README documents these exact commands:

```bash
pnpm dlx @8lines/gauntlet-conformance-runner@0.1.0 http://127.0.0.1:8081
pnpm dlx @8lines/gauntlet-conformance-runner@0.1.0 gauntlet-conformance-extended http://127.0.0.1:8081
```

Ensure each manifest `files` array includes `README.md` and `LICENSE` alongside runtime output.

- [ ] **Step 4: Write the failing staging test**

```javascript
const artifacts = await stageNpmPackages({ root, outputDirectory });
assert.equal(artifacts.length, 6);
assert.deepEqual(artifacts.map(({ kind }) => kind), Array(6).fill("npm"));
for (const artifact of artifacts) {
  assert.equal(artifact.version, "0.1.0");
  assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
  assert.ok(existsSync(artifact.path));
}
```

- [ ] **Step 5: Run the staging test and confirm the module is absent**

Run: `node --test scripts/release/test/stage-npm.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `stage-npm.mjs`.

- [ ] **Step 6: Implement tarball staging from package directories**

Use `execFile`/`spawn` argument arrays, never interpolated shell commands. For each catalog entry run:

```javascript
await run("pnpm", ["pack", "--pack-destination", outputDirectory], { cwd: directory });
```

Read the packed `package/package.json`, reject a name/version mismatch or any `workspace:` value, calculate SHA-256, and return artifacts sorted by package name. Do not publish from this function.

- [ ] **Step 7: Verify archives on Node 24 and Node 26**

Run on each supported Node boundary:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test:packages
node --test scripts/release/test/stage-npm.test.mjs
```

Expected: PASS on Node 24 and Node 26.

- [ ] **Step 8: Commit npm staging**

```bash
git add package.json scripts/test-packed-npm-packages.mjs scripts/release/stage-npm.mjs scripts/release/test/stage-npm.test.mjs packages/dashboard-client/README.md conformance/runner/README.md packages/*/package.json packages/typescript/*/package.json
git commit -m "build(npm): stage private package tarballs"
```

### Task 4: Prove PHP 8.3 and Symfony 7.2 compatibility and stage Composer VCS packages

**Files:**
- Create: `scripts/release/stage-composer.mjs`
- Create: `scripts/release/test/stage-composer.test.mjs`
- Create: `scripts/release/test-composer-consumer.mjs`
- Create: `tests/consumers/php-core/composer.json`
- Create: `tests/consumers/php-core/check.php`
- Create: `tests/consumers/php-symfony/composer.json`
- Create: `tests/consumers/php-symfony/check.php`
- Modify: `packages/php/Dockerfile`
- Modify: `packages/php/core/composer.json`
- Modify: `packages/php/symfony-bundle/composer.json`
- Modify: `packages/php/core/composer.lock`
- Modify: `packages/php/symfony-bundle/composer.lock`
- Modify: `examples/symfony/composer.json`
- Modify: `examples/symfony/composer.lock`
- Modify: `scripts/release/test/package-metadata.test.mjs`
- Modify: `package.json`
- Test: `scripts/release/test/package-metadata.test.mjs`
- Test: `scripts/release/test/stage-composer.test.mjs`
- Test: `scripts/release/test-composer-consumer.mjs`

**Interfaces:**
- Consumes: `RELEASE_ARTIFACTS.composer`, `VERSION`, an exact source commit, and explicit staging directory.
- Produces: `stageComposerPackages({ root, outputDirectory, sourceCommit }) -> Promise<StagedArtifact[]>` and two self-contained Git trees that can be committed and tagged as private VCS packages.

- [ ] **Step 1: Write failing minimum-compatibility assertions**

Extend `scripts/release/test/package-metadata.test.mjs` in this task, not Task 2:

```javascript
assert.equal(readJson("packages/php/core/composer.json").require.php, ">=8.3");
assert.equal(readJson("packages/php/symfony-bundle/composer.json").require.php, ">=8.3");
assert.equal(readJson("packages/php/symfony-bundle/composer.json").require["8lines/gauntlet-php-core"], "^0.1.0");
for (const [dependency, constraint] of Object.entries(readJson("packages/php/symfony-bundle/composer.json").require)) {
  if (dependency.startsWith("symfony/")) assert.equal(constraint, "^7.2", dependency);
}
```

- [ ] **Step 2: Run the compatibility assertions and observe the old minimums**

Run: `node --test scripts/release/test/package-metadata.test.mjs`

Expected: FAIL because the current manifests require PHP `>=8.5`, Symfony `^7.4`, and Core `^0.1`.

- [ ] **Step 3: Lower the supported PHP and Symfony minimums**

Set PHP to `>=8.3` in both Composer manifests, every Symfony component to `^7.2`, and the bundle's Core dependency to `^0.1.0`. Do not add an upper PHP bound, broaden to Symfony 8, or support PHP 8.2. Do not update lockfiles until Step 11.

Run: `node --test scripts/release/test/package-metadata.test.mjs`

Expected: PASS.

- [ ] **Step 4: Make the PHP test image version-selectable**

Change its first line to:

```dockerfile
ARG PHP_VERSION=8.3
FROM php:${PHP_VERSION}-cli
```

Keep Composer 2 and the same required extensions. Do not silently install an extension absent from the package manifests.

- [ ] **Step 5: Write failing split-content tests**

```javascript
const artifacts = await stageComposerPackages({ root, outputDirectory, sourceCommit: "a".repeat(40) });
assert.equal(artifacts.length, 2);
for (const artifact of artifacts) {
  const manifest = readJson(resolve(artifact.path, "composer.json"));
  assert.equal(manifest.version, "0.1.0");
  assert.equal(manifest.license, "proprietary");
  assert.equal(manifest.require.php, ">=8.3");
  assert.equal(existsSync(resolve(artifact.path, "LICENSE")), true);
  assert.equal(existsSync(resolve(artifact.path, "vendor")), false);
  assert.equal(existsSync(resolve(artifact.path, "composer.lock")), false);
}
assert.equal("repositories" in readJson(resolve(bundle.path, "composer.json")), false);
```

- [ ] **Step 6: Run the split test and observe the missing module**

Run: `node --test scripts/release/test/stage-composer.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `stage-composer.mjs`.

- [ ] **Step 7: Implement deterministic Composer staging**

Copy only tracked files from each package directory into its staging path, then remove `composer.lock`, `vendor`, and the bundle's monorepo-only `repositories` key. Add `.gauntlet-source.json` with this exact schema:

```json
{
  "repository": "8lines/gauntlet",
  "commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "path": "packages/php/core",
  "version": "0.1.0"
}
```

Reject any source commit that is not 40 lowercase hexadecimal characters. Never copy `.env`, auth files, SSH material, or Git metadata.

- [ ] **Step 8: Write the failing private-VCS consumer test**

The test creates two temporary Git repositories from staged trees, commits them, tags both `v0.1.0`, and installs from these exact root repository declarations:

```json
{
  "repositories": [
    { "type": "vcs", "url": "file:///tmp/gauntlet-php-core.git" },
    { "type": "vcs", "url": "file:///tmp/gauntlet-symfony-bundle.git" }
  ],
  "require": {
    "8lines/gauntlet-php-core": "0.1.0",
    "8lines/gauntlet-symfony-bundle": "0.1.0"
  }
}
```

The implementation substitutes only the temporary absolute URLs at runtime; package names and versions remain exact.

- [ ] **Step 9: Run the consumer test and confirm it fails before repository orchestration exists**

Run: `node scripts/release/test-composer-consumer.mjs`

Expected: non-zero exit with `staged Composer package directory does not exist`.

- [ ] **Step 10: Implement local VCS repository and consumer orchestration**

Use temporary directories, `git init --bare`, an isolated worktree, annotated tags, and `composer install --no-interaction --prefer-dist`. Run `check.php` to instantiate one public Core value and boot the Symfony test kernel. Always clean the temporary root in `finally`.

- [ ] **Step 11: Run the complete compatibility matrix and regenerate locks**

First, under PHP 8.3, generate the canonical tracked lockfiles for Core, the bundle constrained to Symfony 7.2, and the Symfony example constrained to Symfony 7.2. Review their diffs and retain those minimum-version locks. Run the remaining matrix cells in temporary copies so they cannot rewrite the three tracked lockfiles.

For every Cartesian pair below, build/select that PHP image, constrain all Symfony components to the selected `7.x.*`, update dependencies, and execute the bundle plus Symfony example tests:

```text
PHP 8.3 × Symfony 7.2, 7.3, 7.4
PHP 8.4 × Symfony 7.2, 7.3, 7.4
PHP 8.5 × Symfony 7.2, 7.3, 7.4
```

Each matrix cell runs:

```bash
composer validate --strict
composer update --no-interaction --prefer-dist --with-all-dependencies
vendor/bin/phpunit --testsuite all --do-not-cache-result
composer check-platform-reqs
composer audit --locked --no-interaction
```

Expected: all nine bundle/example cells and all three Core PHP versions PASS. Confirm resolved `symfony/framework-bundle` begins with the selected minor rather than relying only on the constraint.

- [ ] **Step 12: Re-run staged VCS consumers**

Run: `node --test scripts/release/test/stage-composer.test.mjs && node scripts/release/test-composer-consumer.mjs`

Expected: PASS with both packages loaded from temporary VCS tags, never a path repository.

- [ ] **Step 13: Commit Composer compatibility and staging**

```bash
git add package.json packages/php examples/symfony scripts/release/stage-composer.mjs scripts/release/test/stage-composer.test.mjs scripts/release/test-composer-consumer.mjs tests/consumers/php-core tests/consumers/php-symfony
git commit -m "build(composer): stage PHP 8.3 Symfony 7.2 packages"
```

### Task 5: Publish reproducible Java 21 Maven artifacts

**Files:**
- Create: `packages/java/core/README.md`
- Create: `packages/java/spring-boot-starter/README.md`
- Create: `tests/consumers/java/settings.gradle.kts`
- Create: `tests/consumers/java/build.gradle.kts`
- Create: `tests/consumers/java/src/main/java/dev/eightlines/gauntlet/consumer/PublishedConsumer.java`
- Create: `scripts/release/test-maven-consumer.sh`
- Modify: `packages/java/build.gradle.kts`
- Modify: `packages/java/core/build.gradle.kts`
- Modify: `packages/java/spring-boot-starter/build.gradle.kts`
- Modify: `packages/java/settings.gradle.kts`
- Modify: `packages/java/gradle/verification-metadata.xml`
- Create: `packages/java/core/gradle.lockfile`
- Create: `packages/java/spring-boot-starter/gradle.lockfile`
- Test: `scripts/release/test-maven-consumer.sh`

**Interfaces:**
- Consumes: root `VERSION`, Java 21 toolchain, protocol fixtures, and optional Gradle property `gauntletPublishingRepository`.
- Produces: publications `core` and `springBootStarter`, local Maven repository output, GitHub Packages repository output, sources/Javadoc JARs, reproducible archives, and a standalone consumer compile.

- [ ] **Step 1: Write the standalone consumer before publication exists**

Use this dependency surface in `tests/consumers/java/build.gradle.kts`:

```kotlin
plugins { java }

repositories {
    maven { url = uri(requireNotNull(providers.gradleProperty("gauntletRepository").orNull)) }
    mavenCentral()
}

java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }

dependencies {
    implementation("dev.eightlines.gauntlet:spring-boot-starter:0.1.0")
}
```

`PublishedConsumer.java` imports `GauntletProperties`, `GauntletAutoConfiguration`, and one Core model type so both direct and transitive public surfaces compile.

- [ ] **Step 2: Run the consumer and confirm artifacts are unavailable**

Run: `scripts/release/test-maven-consumer.sh`

Expected: FAIL with `Could not find dev.eightlines.gauntlet:spring-boot-starter:0.1.0`.

- [ ] **Step 3: Configure release version, Maven publications, and repositories**

Read the version once in root Gradle:

```kotlin
val releaseVersion = rootProject.file("../../VERSION").readText().trim()
require(Regex("^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$").matches(releaseVersion))

allprojects {
    group = "dev.eightlines.gauntlet"
    version = releaseVersion
}
```

For the two publishable projects apply `maven-publish`, enable `withSourcesJar()` and `withJavadocJar()`, and define:

```kotlin
tasks.withType<AbstractArchiveTask>().configureEach {
    isPreserveFileTimestamps = false
    isReproducibleFileOrder = true
}
```

Use an explicit local repository when `gauntletPublishingRepository` is present. Otherwise the publishing repository is `https://maven.pkg.github.com/8lines/gauntlet` and reads `GITHUB_ACTOR`/`GITHUB_TOKEN` only at task execution time.

- [ ] **Step 4: Add strict dependency locking**

```kotlin
dependencyLocking {
    lockAllConfigurations()
    lockMode = LockMode.STRICT
}
```

Generate and review the two lockfiles with:

```bash
cd packages/java
./gradlew :core:dependencies :spring-boot-starter:dependencies --write-locks
```

Update `verification-metadata.xml` only for newly resolved, reviewed artifacts.

- [ ] **Step 5: Implement the local publication consumer script**

The script must create a temporary Maven directory, run both publication tasks with `-PgauntletPublishingRepository=file://$GAUNTLET_MAVEN_REPOSITORY`, assert these ten files exist, and compile the consumer:

```text
core-0.1.0.jar
core-0.1.0-sources.jar
core-0.1.0-javadoc.jar
core-0.1.0.pom
core-0.1.0.module
spring-boot-starter-0.1.0.jar
spring-boot-starter-0.1.0-sources.jar
spring-boot-starter-0.1.0-javadoc.jar
spring-boot-starter-0.1.0.pom
spring-boot-starter-0.1.0.module
```

Use `mktemp -d`, a quoted absolute path, and a trap that removes only that exact directory.

- [ ] **Step 6: Verify the generated POM and reproducibility**

Build and publish twice into different temporary repositories. Assert:

```bash
test "$(sha256sum first/core-0.1.0.jar | cut -d' ' -f1)" = "$(sha256sum second/core-0.1.0.jar | cut -d' ' -f1)"
test "$(sha256sum first/spring-boot-starter-0.1.0.jar | cut -d' ' -f1)" = "$(sha256sum second/spring-boot-starter-0.1.0.jar | cut -d' ' -f1)"
```

Parse POM XML and assert group, artifact, version, proprietary license, SCM, and the starter's dependency on Core `0.1.0`.

- [ ] **Step 7: Run Java checks and the external consumer**

Run:

```bash
cd packages/java
./gradlew -DgauntletProtocolFixtures=../../packages/protocol/fixtures/v1 clean check
cd ../..
scripts/release/test-maven-consumer.sh
```

Expected: PASS on Java 21; no `SNAPSHOT` text in staged Maven metadata.

- [ ] **Step 8: Commit Maven publication**

```bash
git add packages/java tests/consumers/java scripts/release/test-maven-consumer.sh
git commit -m "build(java): publish reproducible Maven artifacts"
```

### Task 6: Stage the complete release inventory and attest the image

**Files:**
- Create: `scripts/release/release-manifest.schema.json`
- Create: `scripts/release/inventory.mjs`
- Create: `scripts/release/stage.mjs`
- Create: `scripts/release/test/inventory.test.mjs`
- Create: `docker-bake.hcl`
- Modify: `.gitignore`
- Modify: `package.json`
- Modify: `Dockerfile`
- Test: `scripts/release/test/inventory.test.mjs`

**Interfaces:**
- Consumes: the npm and Composer staging functions, Gradle local publication, Helm chart, release image target, exact source SHA, and explicit output root.
- Produces: `stageRelease({ root, outputDirectory, sourceCommit }) -> Promise<ReleaseManifest>` plus `.artifacts/release/0.1.0/release-manifest.json` and `SHA256SUMS`.

- [ ] **Step 1: Write a failing manifest schema test**

The schema requires this shape:

```json
{
  "schemaVersion": 1,
  "version": "0.1.0",
  "sourceTag": "v0.1.0",
  "sourceCommit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "artifacts": [
    {
      "kind": "npm",
      "name": "@8lines/gauntlet-protocol",
      "path": "npm/8lines-gauntlet-protocol-0.1.0.tgz",
      "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  ]
}
```

Test closed objects, sorted artifact records, relative paths without `..`, and lowercase SHA-256.

- [ ] **Step 2: Run the manifest test and confirm schema/inventory are absent**

Run: `node --test scripts/release/test/inventory.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `inventory.mjs`.

- [ ] **Step 3: Implement deterministic inventory and checksums**

Export:

```javascript
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const compareArtifacts = (left, right) =>
  left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name);

export function createReleaseManifest({ version, sourceCommit, artifacts }) {
  return {
    schemaVersion: 1,
    version,
    sourceTag: `v${version}`,
    sourceCommit,
    artifacts: artifacts.map((artifact) => ({ ...artifact })).sort(compareArtifacts),
  };
}

export async function writeReleaseInventory({ outputDirectory, manifest }) {
  const root = resolve(outputDirectory);
  const artifacts = [];

  for (const artifact of manifest.artifacts.toSorted(compareArtifacts)) {
    if (isAbsolute(artifact.path)) throw new Error(`absolute artifact path: ${artifact.path}`);
    const absolutePath = resolve(root, artifact.path);
    const relativePath = relative(root, absolutePath);
    if (relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
      throw new Error(`artifact outside output directory: ${artifact.path}`);
    }
    const bytes = await readFile(absolutePath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    artifacts.push({ ...artifact, path: relativePath.split(sep).join("/"), sha256 });
  }

  const verifiedManifest = { ...manifest, artifacts };
  await writeFile(
    resolve(root, "release-manifest.json"),
    `${JSON.stringify(verifiedManifest, null, 2)}\n`,
  );
  await writeFile(
    resolve(root, "SHA256SUMS"),
    `${artifacts
      .toSorted((left, right) => left.path.localeCompare(right.path))
      .map(({ path, sha256 }) => `${sha256}  ${path}`)
      .join("\n")}\n`,
  );
  return verifiedManifest;
}
```

`writeReleaseInventory` sorts by `kind` then `name`, writes stable two-space JSON with a trailing newline, and writes `SHA256SUMS` sorted by relative path. It rejects files outside the output directory and re-hashes every file rather than trusting a caller-provided digest.

- [ ] **Step 4: Add OCI labels and immutable chart/image versions**

The image build receives only non-secret release metadata:

```dockerfile
ARG GAUNTLET_VERSION
ARG GAUNTLET_REVISION
LABEL org.opencontainers.image.source="https://github.com/8lines/gauntlet" \
      org.opencontainers.image.version="$GAUNTLET_VERSION" \
      org.opencontainers.image.revision="$GAUNTLET_REVISION" \
      org.opencontainers.image.licenses="LicenseRef-Proprietary"
```

The chart already uses `version: 0.1.0`, `appVersion: "0.1.0"`, image repository `ghcr.io/8lines/gauntlet`, and tag `0.1.0`. Before packaging, staging invokes `node scripts/release/version.mjs --check`; it verifies these three version fields against `VERSION` and never rewrites a blank/default tag during staging.

- [ ] **Step 5: Configure BuildKit provenance and SBOM**

The checked-in `docker-bake.hcl` release target must include:

```hcl
attest = [
  "type=provenance,mode=max,version=v1",
  "type=sbom"
]
platforms = ["linux/amd64", "linux/arm64"]
```

Never pass package tokens, Composer credentials, idempotency secrets, or deployment secrets as build arguments.

- [ ] **Step 6: Implement complete staging without publication**

`stage.mjs` builds to an explicit output root and calls, in order:

```javascript
await stageNpmPackages({ root, outputDirectory: resolve(out, "npm") });
await stageComposerPackages({ root, outputDirectory: resolve(out, "composer"), sourceCommit });
await publishMavenLocally({ root, outputDirectory: resolve(out, "maven") });
await packageHelmChart({ root, outputDirectory: resolve(out, "helm") });
await exportImageAndAttestations({ root, outputDirectory: resolve(out, "image"), sourceCommit });
await generateSpdxSbom({ root, outputPath: resolve(out, "sbom/gauntlet.spdx.json") });
```

`exportImageAndAttestations()` writes both `image/gauntlet-0.1.0.oci.tar` for the multi-platform release index/attestations and a host-platform Docker archive `image/gauntlet-0.1.0.docker.tar` whose embedded local tag is exactly `gauntlet.local/gauntlet:0.1.0`. `packageHelmChart()` writes `helm/gauntlet-0.1.0.tgz`. Both archives are checksummed release-manifest entries; the local Docker tag is a verification alias and is never published.

Each helper invokes a fixed executable with an argument array. None may execute `npm publish`, `helm push`, `docker push`, `git push`, or GitHub API mutations.

- [ ] **Step 7: Scan staged content**

Run Trivy with pinned tooling against the repository, Java lockfiles, release filesystem, and exported image. Fail on fixable HIGH or CRITICAL vulnerabilities and on verified secrets. A suppression may be added only with a vulnerability identifier, justification, owner, and expiry date.

- [ ] **Step 8: Verify staging output**

Run:

```bash
pnpm release:stage
node --test scripts/release/test/inventory.test.mjs
sha256sum --check .artifacts/release/0.1.0/SHA256SUMS
```

Expected: every catalog artifact appears exactly once and every checksum passes.

- [ ] **Step 9: Commit release staging**

```bash
git add .gitignore package.json Dockerfile docker-bake.hcl scripts/release
git commit -m "build(release): stage immutable release artifacts"
```

### Task 7: Add the pull-request and main-branch verification workflow

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/dependabot.yml`
- Create: `scripts/release/test/workflow-policy.test.mjs`
- Test: `scripts/release/test/workflow-policy.test.mjs`

**Interfaces:**
- Consumes: all root verification scripts, PHP compatibility matrix, Java wrapper, image/Compose tests, Helm tests, Trivy, and documentation/skill checks added by their plans.
- Produces: required GitHub status jobs `node`, `php`, `java`, `conformance`, `deployment`, `security`, and `release-metadata` for pull requests and `main`.

- [ ] **Step 1: Write failing workflow policy tests**

Parse the workflow YAML and assert:

```javascript
assert.deepEqual(workflow.on.pull_request.branches, ["main"]);
assert.deepEqual(workflow.on.push.branches, ["main"]);
assert.equal(workflow.permissions.contents, "read");
assert.deepEqual(workflow.jobs.node.strategy.matrix.node, [24, 26]);
assert.deepEqual(workflow.jobs.php.strategy.matrix.php, ["8.3", "8.4", "8.5"]);
assert.deepEqual(workflow.jobs.php.strategy.matrix.symfony, ["7.2", "7.3", "7.4"]);
assert.equal(workflow.jobs.java.strategy.matrix.java, 21);
```

Also assert every `uses:` value contains a 40-character commit SHA and no pull-request job references `COMPOSER_SPLIT_APP_PRIVATE_KEY`.

- [ ] **Step 2: Run the policy test and confirm the workflow is absent**

Run: `node --test scripts/release/test/workflow-policy.test.mjs`

Expected: FAIL because `.github/workflows/ci.yml` does not exist.

- [ ] **Step 3: Implement the CI triggers, permissions, and concurrency**

Use top-level read-only permissions and branch-scoped concurrency:

```yaml
name: ci
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]
permissions:
  contents: read
concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

Use `persist-credentials: false` for checkout. Pin every third-party action to a reviewed full commit SHA and keep its human-readable release in a trailing comment.

- [ ] **Step 4: Add the exact verification jobs**

Configure:

- `node`: Node 24 and 26; frozen install, build, typecheck, unit tests, packed consumers.
- `php`: full PHP 8.3–8.5 × Symfony 7.2–7.4 Cartesian matrix with `fail-fast: false`.
- `java`: Temurin 21, Gradle dependency verification, `clean check`, local Maven publication, external consumer.
- `conformance`: black-box TypeScript, Symfony, Spring, Node, and Next Adapter v1 suites.
- `deployment`: image build, mobile/dashboard checks, two-target Compose smoke, Helm lint/schema/render/kubeconform.
- `security`: `pnpm audit --prod`, Composer audit, Trivy filesystem/secret/misconfiguration scan, staged image scan.
- `release-metadata`: version, package metadata, staging inventory, documentation, and skill-evaluation hash checks.

Upload plain scan reports as workflow artifacts. Do not require private-repository SARIF or GitHub Advanced Security features on the current GitHub Free plan.

- [ ] **Step 5: Configure dependency update coverage**

Dependabot must cover these package ecosystems and directories:

```text
npm: /
composer: /packages/php/core
composer: /packages/php/symfony-bundle
composer: /examples/symfony
gradle: /packages/java
docker: /
docker: /packages/php
github-actions: /
```

Use weekly grouped updates and a limit that prevents an unbounded queue. Do not configure automatic merge.

- [ ] **Step 6: Verify workflow policy locally**

Run: `node --test scripts/release/test/workflow-policy.test.mjs`

Expected: PASS, including the full action-SHA and no-release-secret-on-PR assertions.

- [ ] **Step 7: Commit CI**

```bash
git add .github scripts/release/test/workflow-policy.test.mjs
git commit -m "ci: verify every release artifact"
```

### Task 8: Add idempotent tag-based private publication

**Files:**
- Create: `.github/workflows/release.yml`
- Create: `scripts/release/publish-composer.mjs`
- Create: `scripts/release/check-published.mjs`
- Create: `scripts/release/test/publish-policy.test.mjs`
- Create: `scripts/release/test/publish-composer.test.mjs`
- Modify: `package.json`
- Test: `scripts/release/test/publish-policy.test.mjs`
- Test: `scripts/release/test/publish-composer.test.mjs`

**Interfaces:**
- Consumes: a clean `v0.1.0` checkout reachable from `origin/main`, staged release artifacts, automatic `GITHUB_TOKEN`, `vars.COMPOSER_SPLIT_APP_ID`, and `secrets.COMPOSER_SPLIT_APP_PRIVATE_KEY`.
- Produces: private npm/Maven/GHCR/Helm versions, immutable Composer split tags, final remote digests, and GitHub Release assets. A rerun treats an already-present artifact as success only after byte/digest/tree equality.

- [ ] **Step 1: Write failing tag and permission policy tests**

Assert release YAML has:

```javascript
assert.deepEqual(release.on.push.tags, ["v*.*.*"]);
assert.equal(release.permissions.contents, "read");
assert.equal(release.jobs.publish.permissions.contents, "write");
assert.equal(release.jobs.publish.permissions.packages, "write");
assert.equal(release.jobs.publish.environment, "release");
assert.equal(JSON.stringify(release).includes("latest"), false);
assert.equal(JSON.stringify(release).includes("pull_request"), false);
```

Assert the publish job depends on every verification gate and that GitHub Release creation is the last publication step.

- [ ] **Step 2: Run the policy test and confirm release workflow is absent**

Run: `node --test scripts/release/test/publish-policy.test.mjs`

Expected: FAIL because `.github/workflows/release.yml` does not exist.

- [ ] **Step 3: Implement immutable Composer repository synchronization tests**

Use temporary bare repositories and assert:

```javascript
assert.equal(await publishComposerPackage({ source, remote, version: "0.1.0", dryRun: false }), "published");
assert.equal(await publishComposerPackage({ source, remote, version: "0.1.0", dryRun: false }), "already-identical");
await assert.rejects(
  publishComposerPackage({ source: changedSource, remote, version: "0.1.0", dryRun: false }),
  /existing tag v0\.1\.0 has different content/,
);
```

- [ ] **Step 4: Run the Composer publishing test and confirm the function is absent**

Run: `node --test scripts/release/test/publish-composer.test.mjs`

Expected: FAIL because `publishComposerPackage` is not exported.

- [ ] **Step 5: Implement safe split repository publishing**

Clone the exact destination repository, copy one staged package, commit with source SHA, update `main` without force, and create annotated `v0.1.0`. Validate the existing tag's tree before considering a rerun successful. URLs are fixed from `RELEASE_ARTIFACTS`; no CLI argument may supply an arbitrary owner or repository.

- [ ] **Step 6: Implement remote collision checking**

`check-published.mjs` checks all destinations before the first mutation:

```text
GitHub npm: six package versions
GitHub Maven: two coordinates
GHCR image: semantic and commit tags
GHCR Helm: semantic chart tag
GitHub VCS: two Composer tags
GitHub Release: v0.1.0
```

On a clean first release every destination must be absent. On a rerun every present destination must match the staged SHA, OCI digest, Maven checksum, or Git tree. Mixed or differing state stops without deletion.

- [ ] **Step 7: Implement one gated sequential publish job**

Use this order after a complete clean `release:dry-run` in CI:

```text
1. Derive `SHORT_SHA=${GITHUB_SHA:0:12}` and push image tag `sha-$SHORT_SHA` with BuildKit provenance and SBOM.
2. Scan the pushed image by digest and inspect both attestations.
3. Promote the same image index digest to 0.1.0.
4. Push gauntlet-0.1.0.tgz to oci://ghcr.io/8lines/charts.
5. Publish the six staged npm tarballs.
6. Publish the two Maven publications.
7. Generate a short-lived GitHub App token and publish both Composer split tags.
8. Pull/install every remote artifact in clean consumers.
9. Add remote digests to release-manifest.json and regenerate SHA256SUMS.
10. Create GitHub Release v0.1.0 with changelog, manifest, checksums, chart, and SBOM.
```

The image has `0.1.0` and `sha-*` tags only. The Helm basename is `gauntlet` under `ghcr.io/8lines/charts`.

- [ ] **Step 8: Generate the short-lived cross-repository token**

Use the GitHub App with only these two destination repositories:

```yaml
- id: composer-token
  uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3
  with:
    app-id: ${{ vars.COMPOSER_SPLIT_APP_ID }}
    private-key: ${{ secrets.COMPOSER_SPLIT_APP_PRIVATE_KEY }}
    owner: 8lines
    repositories: gauntlet-php-core,gauntlet-symfony-bundle
```

Do not expose this token to npm, Maven, Docker, Helm, pull requests, logs, or uploaded artifacts.

- [ ] **Step 9: Verify policy and local publish behavior**

Run:

```bash
node --test scripts/release/test/publish-policy.test.mjs
node --test scripts/release/test/publish-composer.test.mjs
```

Expected: PASS without network access or real repository mutation.

- [ ] **Step 10: Commit release automation**

```bash
git add package.json .github/workflows/release.yml scripts/release
git commit -m "ci: publish private tagged releases"
```

### Task 9: Provide the complete local release dry-run

**Files:**
- Create: `scripts/release/verify.mjs`
- Create: `scripts/release/dry-run.mjs`
- Create: `scripts/release/test/dry-run.test.mjs`
- Modify: `package.json`
- Test: `scripts/release/test/dry-run.test.mjs`

**Interfaces:**
- Consumes: every repository test command, release staging, Docker Buildx, a pinned local OCI registry image, Helm, Trivy, and a clean Git worktree.
- Produces: `pnpm release:verify` for development and non-mutating `pnpm release:dry-run` for a clean release rehearsal. The dry-run creates only `.artifacts/release/0.1.0` and uniquely named temporary local containers/directories.

- [ ] **Step 1: Write orchestration tests using injected command runners**

Test exact phase order and failure behavior:

```javascript
assert.deepEqual(await plannedReleasePhases(), [
  "source",
  "node",
  "php",
  "java",
  "conformance",
  "dashboard",
  "image",
  "compose",
  "helm",
  "security",
  "packages",
  "inventory",
]);
await assert.rejects(runPhases({ runner: failingAt("java") }), /java phase failed/);
assert.deepEqual(executedPhases, ["source", "node", "php", "java"]);
```

This is the base phase order while the documentation and skills do not yet exist. AI-skills Task 6 must add `skills` immediately after `conformance`; release-documentation Task 9 must add final `documentation` immediately after `inventory`, with a new failing order test written only after the documentation corpus and its command verifier exist.

Assert dry-run rejects dirty Git state and never plans `npm publish`, `helm push` to GHCR, `docker push` to GHCR, `git push`, `gh api --method`, or `gh release create`.

- [ ] **Step 2: Run the test and confirm orchestration is absent**

Run: `node --test scripts/release/test/dry-run.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `dry-run.mjs`.

- [ ] **Step 3: Implement development verification**

`verify.mjs` invokes fixed root/package scripts for all phases and works on a dirty development tree. It prints one bounded section per phase and stops at the first failure while preserving the failing command's exit code.

- [ ] **Step 4: Implement clean dry-run and ephemeral OCI verification**

`dry-run.mjs` first requires `git status --porcelain=v1` to be empty and `node scripts/release/version.mjs --check` to pass. It then:

1. runs `release:verify`;
2. creates a unique `mkdtemp` root;
3. starts a uniquely named loopback-only local OCI registry;
4. pushes the image and chart only to that registry;
5. pulls both by digest;
6. inspects SLSA provenance and SPDX SBOM;
7. runs remote-shaped npm, Composer, and Maven consumers against staged local artifacts;
8. writes `.artifacts/release/0.1.0/release-manifest.json` and `SHA256SUMS`;
9. removes only the registry container and temporary root it created.

Use `try/finally`; validate the generated container name before removal.

- [ ] **Step 5: Add exact root commands**

```json
{
  "scripts": {
    "release:verify": "node scripts/release/verify.mjs",
    "release:stage": "node scripts/release/stage.mjs --output .artifacts/release/0.1.0",
    "release:dry-run": "node scripts/release/dry-run.mjs"
  }
}
```

- [ ] **Step 6: Verify the orchestration unit tests**

Run: `node --test scripts/release/test/dry-run.test.mjs`

Expected: PASS; this step does not execute the full release rehearsal.

- [ ] **Step 7: Commit the locally verified release rehearsal**

```bash
git add package.json scripts/release/verify.mjs scripts/release/dry-run.mjs scripts/release/test/dry-run.test.mjs
git commit -m "build: add local release dry run"
```

- [ ] **Step 8: Run the complete dry-run from the now-clean checkout**

Run:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm release:dry-run
```

Expected: exit 0, no GitHub mutations, and both inventory files beneath `.artifacts/release/0.1.0`.

### Task 10: Bootstrap private repositories and rehearse the workflow without publishing v0.1.0

**Files:**
- Modify: no repository files in this task
- Test: GitHub repository state, Actions variables/secrets presence, protected release environment, and a manual non-publishing workflow run

**Interfaces:**
- Consumes: clean local `main`, authenticated `gh`, organization ownership, reviewed CI/release workflows, and the GitHub App described below.
- Produces: private `origin`, two private Composer split repositories, release environment, and configured short-lived split-token generation. It does not create the `v0.1.0` tag.

- [ ] **Step 1: Prove the local repository is clean and release-ready**

Run:

```bash
git status --short
git branch --show-current
pnpm release:dry-run
```

Expected: empty status, branch `main`, and successful dry-run.

- [ ] **Step 2: Confirm destination repositories are absent before creation**

Run:

```bash
gh repo view 8lines/gauntlet
gh repo view 8lines/gauntlet-php-core
gh repo view 8lines/gauntlet-symfony-bundle
```

Expected before bootstrap: each command reports repository not found. If any exists, inspect visibility and contents rather than recreating it.

- [ ] **Step 3: Create only the three approved private repositories**

Run:

```bash
gh repo create 8lines/gauntlet --private --source=. --remote=origin
gh repo create 8lines/gauntlet-php-core --private
gh repo create 8lines/gauntlet-symfony-bundle --private
git push --set-upstream origin main
```

Expected: all repositories report `PRIVATE`; no tag is pushed.

- [ ] **Step 4: Configure the repository-restricted GitHub App**

Create an organization GitHub App named `gauntlet-composer-split`, grant only Metadata read and Contents read/write, and install it only on `gauntlet-php-core` and `gauntlet-symfony-bundle`. Add its numeric App ID as Actions variable `COMPOSER_SPLIT_APP_ID` and its private key as encrypted Actions secret `COMPOSER_SPLIT_APP_PRIVATE_KEY` in `8lines/gauntlet`.

- [ ] **Step 5: Configure package inheritance and release environment**

Create an environment named `release`. Keep repository Actions workflow permissions read-only by default and allow job-level `contents: write`/`packages: write`. After first package creation, verify npm and container packages inherit access from private `8lines/gauntlet`; Maven packages are repository-scoped by GitHub.

- [ ] **Step 6: Exercise non-publishing CI on remote main**

Run:

```bash
gh run list --repo 8lines/gauntlet --workflow ci.yml --limit 1
gh run watch --repo 8lines/gauntlet --exit-status
```

Expected: `node`, `php`, `java`, `conformance`, `deployment`, `security`, and `release-metadata` all succeed. Do not create `v0.1.0` until the documentation and both AI-skill plans are complete and their checks are part of `release:dry-run`.
