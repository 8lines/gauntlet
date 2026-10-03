# Release units, phase 1: unit model and per-unit versions

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce the release unit catalog and give every unit its own version source and version slots, while publication still runs in lockstep (all units at the same version), so nothing about publishing changes yet.

**Architecture:** A new `scripts/release/units.mjs` holds the 13 units (ids, version sources, dependencies, owned paths, tag prefixes, artifacts, contracts, gates). `release-model.mjs` binds every version location and text slot to a unit and checks it against that unit's version. A temporary lockstep guard keeps all units equal to `VERSION` until phase 2 switches publication to plans. Hard-coded versions in Helm tests, docs checks and skill fixtures are replaced by reads from the unit catalog.

**Tech Stack:** Node.js ESM scripts (`node:test`), Gradle Kotlin DSL, YAML (`yaml` package), existing release tooling under `scripts/release`.

**Spec:** `docs/superpowers/specs/2026-10-03-independent-release-units-design.md`

**Roadmap:** phase 1 (this plan) unit model; phase 2 plan-driven publishing (`.release/plan.json`, release-set tag, per-unit staging, inventory, preflight, publish and GitHub Releases); phase 3 change files, `release:prepare`, changelogs, compatibility doc and documentation. Phases 2 and 3 get their own plans after this one lands.

## Global Constraints

- Branch `feat/independent-release-units`, based on `main` after v0.1.8. Commit after every task; messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Never stage the untracked `design/` or `.playwright-mcp/` directories.
- Code, comments and file names in English. Node scripts are ESM `.mjs`, tested with `node --test`; follow the existing style in `scripts/release` (frozen data, fixed error messages, no symlink-following reads).
- Unit ids and tags exactly as the spec table: `gauntlet` (tag `vX.Y.Z`), `protocol`, `dashboard-client`, `typescript-core`, `typescript-node`, `next-adapter`, `conformance-runner`, `widget`, `php-core`, `symfony-bundle`, `java-core`, `spring-boot-starter`, `skills` (tags `<id>-vX.Y.Z`).
- All units start at 0.1.8. Phase 1 must keep every unit version equal to `VERSION` (lockstep guard); phase 2 removes the guard.
- Version sources: `gauntlet` → `VERSION`; npm units → their `package.json` `version`; `php-core`, `symfony-bundle` → their `composer.json` `version`; `java-core` → `packages/java/core/VERSION`; `spring-boot-starter` → `packages/java/spring-boot-starter/VERSION`; `skills` → `skills/VERSION`. Every `VERSION` file holds one stable semver followed by one LF.
- Chart `version`/`appVersion`, `values.yaml` `image.tag` and the Compose image follow `gauntlet`.
- Nothing is published, tagged remotely or pushed by any task; baseline tags are created locally only (Task 6).
- Verification commands: `pnpm release:test`, `node scripts/release/version.mjs --check`, `node scripts/docs/check-docs.mjs`, `pnpm test:helm`, `node --test skill-evals/*/test/*.test.mjs`, `pnpm --filter ./scripts/skills test` if present (check `package.json` scripts), and `pnpm check` at the end.

## Review Focus

1. A dependency cycle or an unknown dependency id in the unit catalog must be rejected at module load, not discovered at release time. (Task 1)
2. A version slot that belongs to one unit must not be satisfied by another unit's version, e.g. the Symfony guide pinning `php-core` to the `symfony-bundle` version once they diverge. (Task 3, test with diverged versions while lockstep guard is disabled in the test)
3. A `VERSION` file with CRLF, a pre-release (`0.1.9-rc.1`) or trailing spaces in `packages/java/*/VERSION` or `skills/VERSION` must fail the same way the root `VERSION` does. (Task 2)
4. Helm and skill fixture tests must still pass after a version bump without editing them (bump all units to 0.1.9 in a temporary copy and run them). (Task 5)
5. Baseline tags must point at the v0.1.8 release commit and must not be created twice or moved if they already exist. (Task 6)

---

### Task 1: Unit catalog

**Files:**
- Create: `scripts/release/units.mjs`
- Test: `scripts/release/test/units.test.mjs`
- Modify: root `package.json` only if `release:test` does not already glob `scripts/release/test/*.test.mjs` (check first)

**Interfaces:**
- Produces:
  - `RELEASE_UNITS: readonly ReleaseUnit[]` (frozen), where `ReleaseUnit = { id: string; kind: "application" | "npm" | "composer" | "maven" | "skills"; version: { type: "file"; path: string } | { type: "json"; path: string; keyPath: ["version"] }; dependsOn: readonly string[]; ownedPaths: readonly string[]; tagPrefix: string; artifacts: readonly string[]; contracts: { implements?: Record<string, number>; supports?: Record<string, readonly number[]> }; gates: readonly string[] }`.
  - `unitById(id: string): ReleaseUnit` (throws `Unknown release unit` for unknown ids).
  - `unitTag(unit: ReleaseUnit, version: string): string` (`v0.1.8` for `gauntlet`, `protocol-v0.1.8` otherwise).
  - `dependencyOrder(ids?: readonly string[]): readonly string[]` (topological, dependencies first, ties by catalog order).
  - `dependentsOf(id: string): readonly string[]` (transitive, in dependency order).

- [ ] **Step 1: Write the failing tests**

```js
import assert from "node:assert/strict";
import { test } from "node:test";

import { RELEASE_ARTIFACTS } from "../release-model.mjs";
import { RELEASE_UNITS, dependencyOrder, dependentsOf, unitById, unitTag, validateUnits } from "../units.mjs";

const IDS = [
  "gauntlet", "protocol", "dashboard-client", "typescript-core", "typescript-node", "next-adapter",
  "conformance-runner", "widget", "php-core", "symfony-bundle", "java-core", "spring-boot-starter", "skills",
];

test("the catalog holds the thirteen spec units in a fixed order", () => {
  assert.deepEqual(RELEASE_UNITS.map(({ id }) => id), IDS);
  assert.equal(Object.isFrozen(RELEASE_UNITS), true);
  assert.equal(Object.isFrozen(RELEASE_UNITS[0].dependsOn), true);
});

test("tags use v for the application and <id>-v for every other unit", () => {
  assert.equal(unitTag(unitById("gauntlet"), "0.1.8"), "v0.1.8");
  assert.equal(unitTag(unitById("protocol"), "0.2.0"), "protocol-v0.2.0");
  assert.throws(() => unitById("nope"), /Unknown release unit/);
});

test("every published artifact belongs to exactly one unit", () => {
  const published = [
    ...RELEASE_ARTIFACTS.npm.map(({ name }) => name),
    ...RELEASE_ARTIFACTS.composer.map(({ name }) => name),
    ...RELEASE_ARTIFACTS.maven.map(({ name }) => name),
    RELEASE_ARTIFACTS.image.name, RELEASE_ARTIFACTS.compose.name, RELEASE_ARTIFACTS.chart.name, RELEASE_ARTIFACTS.skills.name,
  ];
  const owned = RELEASE_UNITS.flatMap(({ artifacts }) => artifacts);
  assert.deepEqual([...owned].sort(), [...published].sort());
});

test("dependency order puts dependencies first", () => {
  const order = dependencyOrder();
  for (const unit of RELEASE_UNITS) {
    for (const dependency of unit.dependsOn) assert.ok(order.indexOf(dependency) < order.indexOf(unit.id), `${dependency} before ${unit.id}`);
  }
  assert.deepEqual(dependencyOrder(["next-adapter", "protocol"]), ["protocol", "next-adapter"]);
});

test("a protocol change reaches every dependent and nothing else", () => {
  const fromProtocol = new Set(dependentsOf("protocol"));
  for (const id of ["dashboard-client", "typescript-core", "typescript-node", "next-adapter", "conformance-runner", "gauntlet", "skills"]) {
    assert.ok(fromProtocol.has(id), id);
  }
  assert.equal(fromProtocol.size, 7);
  assert.ok(!fromProtocol.has("php-core"));
  assert.deepEqual(dependentsOf("gauntlet"), ["skills"]);
  assert.deepEqual(dependentsOf("widget"), []);
  assert.deepEqual(dependentsOf("skills"), []);
});

test("validation rejects cycles, unknown dependencies and duplicate ids", () => {
  const base = RELEASE_UNITS.map((unit) => ({ ...unit, dependsOn: [...unit.dependsOn] }));
  const cyclic = base.map((unit) => (unit.id === "protocol" ? { ...unit, dependsOn: ["next-adapter"] } : unit));
  assert.throws(() => validateUnits(cyclic), /cycle/);
  const unknown = base.map((unit) => (unit.id === "widget" ? { ...unit, dependsOn: ["missing"] } : unit));
  assert.throws(() => validateUnits(unknown), /unknown dependency/);
  assert.throws(() => validateUnits([...base, base[1]]), /duplicate/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/release/test/units.test.mjs`
Expected: FAIL, `Cannot find module '../units.mjs'`.

- [ ] **Step 3: Implement `scripts/release/units.mjs`**

```js
// Pure catalog: this module imports nothing, so release-model.mjs can import it without a cycle.
function deeplyFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deeplyFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const npm = (id, directory, name, dependsOn, gates, implementsProtocol = true) => ({
  id,
  kind: "npm",
  version: { type: "json", path: `${directory}/package.json`, keyPath: ["version"] },
  dependsOn,
  ownedPaths: [`${directory}/src/**`, `${directory}/package.json`, ...(id === "protocol" ? [`${directory}/schemas/**`] : [])],
  tagPrefix: `${id}-v`,
  artifacts: [name],
  contracts: implementsProtocol ? { implements: { protocol: 1 } } : {},
  gates,
});

const units = [
  {
    id: "gauntlet",
    kind: "application",
    version: { type: "file", path: "VERSION" },
    dependsOn: ["protocol", "dashboard-client"],
    ownedPaths: [
      "apps/server/src/**", "apps/server/package.json", "apps/dashboard/src/**", "apps/dashboard/index.html",
      "apps/dashboard/widget/**", "apps/dashboard/package.json", "packages/widget-loader/src/**",
      "packages/widget-channel/src/**", "Dockerfile", "deploy/helm/gauntlet/**", "deploy/compose/**",
    ],
    tagPrefix: "v",
    artifacts: ["ghcr.io/8lines/gauntlet", "gauntlet", "gauntlet-compose"],
    contracts: { supports: { protocol: [1], widgetChannel: [1] } },
    gates: ["node", "dashboard", "widget", "widget-panel", "deployment", "security"],
  },
  npm("protocol", "packages/protocol", "@8lines/gauntlet-protocol", [], ["node", "conformance"]),
  npm("dashboard-client", "packages/dashboard-client", "@8lines/gauntlet-dashboard-client", ["protocol"], ["node"]),
  npm("typescript-core", "packages/typescript/core", "@8lines/gauntlet-typescript-core", ["protocol"], ["node", "conformance"]),
  npm("typescript-node", "packages/typescript/node", "@8lines/gauntlet-typescript-node", ["protocol", "typescript-core"], ["node", "conformance"]),
  npm("next-adapter", "packages/typescript/next", "@8lines/gauntlet-next-adapter", ["typescript-node"], ["node", "conformance"]),
  npm("conformance-runner", "conformance/runner", "@8lines/gauntlet-conformance-runner", ["protocol"], ["node", "conformance"]),
  npm("widget", "packages/widget", "@8lines/gauntlet-widget", [], ["node", "widget"], false),
  {
    id: "php-core",
    kind: "composer",
    version: { type: "json", path: "packages/php/core/composer.json", keyPath: ["version"] },
    dependsOn: [],
    ownedPaths: ["packages/php/core/src/**", "packages/php/core/composer.json"],
    tagPrefix: "php-core-v",
    artifacts: ["8lines/gauntlet-php-core"],
    contracts: { implements: { protocol: 1 } },
    gates: ["php", "conformance"],
  },
  {
    id: "symfony-bundle",
    kind: "composer",
    version: { type: "json", path: "packages/php/symfony-bundle/composer.json", keyPath: ["version"] },
    dependsOn: ["php-core"],
    ownedPaths: ["packages/php/symfony-bundle/src/**", "packages/php/symfony-bundle/config/**", "packages/php/symfony-bundle/composer.json"],
    tagPrefix: "symfony-bundle-v",
    artifacts: ["8lines/gauntlet-symfony-bundle"],
    contracts: { implements: { protocol: 1 } },
    gates: ["php", "conformance"],
  },
  {
    id: "java-core",
    kind: "maven",
    version: { type: "file", path: "packages/java/core/VERSION" },
    dependsOn: [],
    ownedPaths: ["packages/java/core/src/main/**", "packages/java/core/build.gradle.kts", "packages/java/core/VERSION"],
    tagPrefix: "java-core-v",
    artifacts: ["dev.eightlines.gauntlet:core"],
    contracts: { implements: { protocol: 1 } },
    gates: ["java", "conformance"],
  },
  {
    id: "spring-boot-starter",
    kind: "maven",
    version: { type: "file", path: "packages/java/spring-boot-starter/VERSION" },
    dependsOn: ["java-core"],
    ownedPaths: [
      "packages/java/spring-boot-starter/src/main/**", "packages/java/spring-boot-starter/build.gradle.kts",
      "packages/java/spring-boot-starter/VERSION",
    ],
    tagPrefix: "spring-boot-starter-v",
    artifacts: ["dev.eightlines.gauntlet:spring-boot-starter"],
    contracts: { implements: { protocol: 1 } },
    gates: ["java", "conformance"],
  },
  {
    id: "skills",
    kind: "skills",
    version: { type: "file", path: "skills/VERSION" },
    dependsOn: [
      "gauntlet", "protocol", "typescript-core", "typescript-node", "next-adapter", "php-core", "symfony-bundle",
      "java-core", "spring-boot-starter",
    ],
    ownedPaths: ["skills/**", "skill-evals/**"],
    tagPrefix: "skills-v",
    artifacts: ["gauntlet-skills"],
    contracts: {},
    gates: ["skills"],
  },
];

export function validateUnits(candidate) {
  const ids = candidate.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new Error("Release unit catalog contains a duplicate id");
  const known = new Set(ids);
  for (const unit of candidate) {
    for (const dependency of unit.dependsOn) {
      if (!known.has(dependency)) throw new Error(`Release unit ${unit.id} has an unknown dependency ${dependency}`);
    }
  }
  const visiting = new Set();
  const done = new Set();
  const byId = new Map(candidate.map((unit) => [unit.id, unit]));
  const visit = (id) => {
    if (done.has(id)) return;
    if (visiting.has(id)) throw new Error(`Release unit catalog contains a dependency cycle at ${id}`);
    visiting.add(id);
    for (const dependency of byId.get(id).dependsOn) visit(dependency);
    visiting.delete(id);
    done.add(id);
  };
  for (const id of ids) visit(id);
  const prefixes = candidate.map(({ tagPrefix }) => tagPrefix);
  if (new Set(prefixes).size !== prefixes.length) throw new Error("Release unit catalog contains a duplicate tag prefix");
  const artifacts = candidate.flatMap(({ artifacts }) => artifacts);
  if (new Set(artifacts).size !== artifacts.length) throw new Error("Release unit catalog assigns an artifact twice");
}

validateUnits(units);
export const RELEASE_UNITS = deeplyFreeze(units);
const BY_ID = new Map(RELEASE_UNITS.map((unit) => [unit.id, unit]));

export function unitById(id) {
  const unit = BY_ID.get(id);
  if (unit === undefined) throw new Error(`Unknown release unit ${id}`);
  return unit;
}

export function unitTag(unit, version) {
  return `${unit.tagPrefix}${version}`;
}

export function dependencyOrder(ids = RELEASE_UNITS.map(({ id }) => id)) {
  const wanted = new Set(ids.map((id) => unitById(id).id));
  const ordered = [];
  const placed = new Set();
  const place = (id) => {
    if (placed.has(id)) return;
    for (const dependency of unitById(id).dependsOn) place(dependency);
    placed.add(id);
    if (wanted.has(id)) ordered.push(id);
  };
  for (const unit of RELEASE_UNITS) if (wanted.has(unit.id)) place(unit.id);
  return Object.freeze(ordered);
}

export function dependentsOf(id) {
  unitById(id);
  const reached = new Set();
  let frontier = [id];
  while (frontier.length > 0) {
    const next = [];
    for (const unit of RELEASE_UNITS) {
      if (!reached.has(unit.id) && unit.dependsOn.some((dependency) => frontier.includes(dependency))) {
        reached.add(unit.id);
        next.push(unit.id);
      }
    }
    frontier = next;
  }
  return dependencyOrder([...reached]);
}
```

Gate ids must equal the CI job ids in `.github/workflows/ci.yml` and `release.yml`; read both files and correct the `gates` arrays if a name differs (for example a matrix job reported as `node`). Owned paths must exist; adjust globs to real directories (check `packages/php/symfony-bundle` layout and `packages/java/*` layout) and record any change in the report.

- [ ] **Step 4: Run tests**

Run: `node --test scripts/release/test/units.test.mjs && pnpm release:test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/release/units.mjs scripts/release/test/units.test.mjs
git commit -m "feat(release): add the release unit catalog"
```

---

### Task 2: Per-unit version sources

**Files:**
- Create: `skills/VERSION`, `packages/java/core/VERSION`, `packages/java/spring-boot-starter/VERSION` (each `0.1.8\n`)
- Modify: `scripts/release/release-model.mjs` (version readers), `packages/java/build.gradle.kts` (per-project version contract), `scripts/release/release-model.mjs` (`hasGradleVersionContract`), `scripts/release/test-java-release.mjs` and `scripts/release/test-java-source.mjs` (input lists), their tests
- Test: `scripts/release/test/units.test.mjs`, `scripts/release/test/release-model.test.mjs`, `scripts/release/test/java-release.test.mjs`, `scripts/release/test/java-source.test.mjs`

**Interfaces:**
- Consumes: `RELEASE_UNITS`, `unitById` (Task 1); `parseReleaseVersion` from `release-model.mjs`.
- Produces: `readUnitVersion(root: string, id: string): string` and `readUnitVersions(root: string): ReadonlyMap<string, string>` exported from `release-model.mjs` (which imports `units.mjs`; `units.mjs` imports nothing, so there is no import cycle). File sources use the same strict rules as the root `VERSION` (`parseReleaseVersion`, max 64 bytes, regular file, no symlink). JSON sources read the string at `keyPath` with the existing safe JSON manifest reader in `release-model.mjs` (export it as `readJsonVersion(root, path, keyPath)` if it is not exported).

- [ ] **Step 1: Write failing tests** in `units.test.mjs`:

```js
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUnitVersion, readUnitVersions } from "../release-model.mjs";

const ROOT = new URL("../../..", import.meta.url).pathname;

test("every unit reads 0.1.8 from the repository", () => {
  const versions = readUnitVersions(ROOT);
  assert.equal(versions.size, 13);
  for (const [id, version] of versions) assert.equal(version, "0.1.8", id);
});

for (const bad of ["0.1.9\r\n", "0.1.9-rc.1\n", "0.1.9 \n", "0.1.9", ""]) {
  test(`a malformed unit VERSION file is rejected: ${JSON.stringify(bad)}`, () => {
    const root = mkdtempSync(join(tmpdir(), "units-"));
    mkdirSync(join(root, "skills"));
    writeFileSync(join(root, "skills", "VERSION"), bad);
    assert.throws(() => readUnitVersion(root, "skills"), /skills version is invalid/);
  });
}
```

Add to `release-model.test.mjs` a case that the Gradle contract check accepts the new per-project contract (fixture text from Step 3) and rejects a literal `version = "0.1.8"`.

- [ ] **Step 2: Run** `node --test scripts/release/test/units.test.mjs` — Expected: FAIL (`readUnitVersion` missing).

- [ ] **Step 3: Implement**

In `release-model.mjs` (add `import { RELEASE_UNITS, unitById } from "./units.mjs";` at the top):

```js
export function readUnitVersion(root, id) {
  const unit = unitById(id);
  try {
    return unit.version.type === "file"
      ? readVersionFile(root, unit.version.path)
      : readJsonVersion(root, unit.version.path, unit.version.keyPath);
  } catch {
    throw new Error(`Release unit ${id} version is invalid`);
  }
}

export function readUnitVersions(root) {
  return new Map(RELEASE_UNITS.map(({ id }) => [id, readUnitVersion(root, id)]));
}
```

Also in `release-model.mjs` extract the body of `readReleaseVersion` into `export function readVersionFile(root, path)` (same checks: `readManifest`, max 64 bytes, `parseReleaseVersion`) and make `readReleaseVersion(root)` call `readVersionFile(root, "VERSION")`. Export `readJsonVersion(root, path, keyPath)` built on `parseJsonManifest` + `jsonNodeAt`, throwing if the node is not a string or not a stable version.

The test regex `/skills version is invalid/` must match the message `Release unit skills version is invalid`.

`packages/java/build.gradle.kts`: replace the root `../../VERSION` block with a function applied per publishable project:

```kotlin
fun projectReleaseVersion(versionFile: java.io.File): String {
    val bytes = versionFile.readBytes()
    require(bytes.size in 6..64) { "${versionFile.name} must contain one bounded stable semantic version record" }
    require(bytes.all { it.toInt() in 0..127 }) { "${versionFile.name} must contain ASCII bytes only" }
    val record = bytes.toString(StandardCharsets.US_ASCII)
    require(Regex("""^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\n$""").matches(record)) {
        "${versionFile.name} must contain an exact stable semantic version followed by one LF"
    }
    return record.removeSuffix("\n")
}
```

and, where the build sets `group`/`version` for publishable projects today, set `version = projectReleaseVersion(project.file("VERSION"))` for `:core` and `:spring-boot-starter` (non-publishable projects keep no release version or use `java-core`'s, matching current behaviour; read the file to see what they do today). Update `hasGradleVersionContract` fragments to the new text (`fun projectReleaseVersion(`, `project.file("VERSION")`, the regex literal, `StandardCharsets.US_ASCII`, `group = "dev.eightlines.gauntlet"`) and keep rejecting `SNAPSHOT` and literal `version = "…"`.

`test-java-release.mjs` and `test-java-source.mjs`: Java no longer reads the root `VERSION`; remove `"VERSION"` from their source input lists (the per-project files live under `packages/java` which is already listed) and update the tests that assert those lists or write a root `VERSION` for Java fixtures (`java-release.test.mjs` lines ~41, 183-207; `java-source.test.mjs` ~65) to write `packages/java/core/VERSION` and `packages/java/spring-boot-starter/VERSION` instead.

`release-model.mjs` now imports `units.mjs`, so every input list that names `scripts/release/release-model.mjs` as a committed input must also name `scripts/release/units.mjs`: `grep -rn "scripts/release/release-model.mjs" scripts skill-evals` and add it next to each hit (Java release inputs, Composer consumer inputs, skill `external-inputs.json` lists handled in Task 5), updating the tests that assert those lists.

- [ ] **Step 4: Run** `pnpm release:test && node scripts/release/version.mjs --check` and the Java source check that does not need a published registry: `node scripts/release/test-java-source.mjs` (needs Java; if no JDK is installed locally, run it through Docker as the repository's docs describe for PHP/Java, e.g. `docker run --rm -v "$PWD":/work -w /work eclipse-temurin:21 ...`; record the exact command). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/VERSION packages/java/core/VERSION packages/java/spring-boot-starter/VERSION packages/java/build.gradle.kts scripts/release
git commit -m "feat(release): give every unit its own version source"
```

---

### Task 3: Version slots bound to units

**Files:**
- Modify: `scripts/release/release-model.mjs` (`VERSION_LOCATIONS`, `RELEASE_CONSUMER_JSON_FILES`, `RELEASE_TEXT_FILES`, `collectVersionMismatches`, `prepareReleaseUpdate`/`setReleaseVersion`), `scripts/release/version.mjs` (output)
- Test: `scripts/release/test/release-model.test.mjs`

**Interfaces:**
- Consumes: `readUnitVersions`, `unitById` (Tasks 1-2).
- Produces:
  - Every version location and text slot carries `unit: string`.
  - `collectUnitVersionMismatches(root: string): string[]` checks each location and slot against its own unit's version (message `"<path>: release references must equal <unit> <version>"`).
  - `collectVersionMismatches(root, expectedTag)` = `collectUnitVersionMismatches(root)` + tag check (`v` + `gauntlet` version) + lockstep guard (message `"<unit>: version <x> must equal VERSION <y> until plan-driven publishing"`), exported constant `LOCKSTEP_RELEASES = true`.
  - `setReleaseVersion(root, version)` keeps setting every unit (lockstep) and also writes the three new `VERSION` files.

Slot ownership (exact):

| Location | Unit |
|---|---|
| npm `package.json` `version` | its npm unit |
| `apps/dashboard/package.json`, `apps/server/package.json`, `VERSION`, Chart `version`/`appVersion`, `values.yaml` `image.tag`, Compose `GAUNTLET_IMAGE` | `gauntlet` |
| `packages/php/core/composer.json` `version`; `tests/consumers/php-core/composer.json` php-core; `tests/consumers/php-symfony/composer.json` php-core | `php-core` |
| `packages/php/symfony-bundle/composer.json` `version`; `tests/consumers/php-symfony/composer.json` bundle | `symfony-bundle` |
| `packages/php/symfony-bundle/composer.json` `require.8lines/gauntlet-php-core` (`^x.y.z`) | `php-core` |
| `tests/consumers/java/build.gradle.kts` starter; lockfile starter | `spring-boot-starter` |
| `tests/consumers/java/gradle.lockfile` core | `java-core` |
| `skills/.../SKILL.md` "Consume exact `…` artifacts" | `skills` |
| `references/node.md`, `nextjs.md` protocol / typescript-core / typescript-node / next-adapter slots | their npm unit |
| `references/symfony.md` php-core slot | `php-core` |
| `references/spring.md` starter coordinate, "Prefer released", "-SNAPSHOT" | `spring-boot-starter` |
| `references/deployment.md` image, chart, "and exact image" | `gauntlet` |
| `references/safety-gates.md` "Version `…` has no built-in" | `gauntlet` |
| `docs/ai-skills.md` `gauntlet-skills-…` slots | `skills` |

- [ ] **Step 1: Failing tests** in `release-model.test.mjs`: build a fixture repository (the file already has helpers that write a full fixture, e.g. `writeFixtureFile` near line 214) with all units at 0.1.8, then:

```js
test("a slot is checked against its own unit", () => {
  const root = fixtureRepository("0.1.8");
  writeFixtureFile(root, "packages/php/core/composer.json", phpCoreManifest("0.1.9"));
  const mismatches = collectUnitVersionMismatches(root);
  assert.ok(mismatches.some((line) => line.startsWith("tests/consumers/php-core/composer.json") && line.includes("php-core 0.1.9")));
  assert.ok(!mismatches.some((line) => line.includes("symfony-bundle 0.1.9")));
});

test("the lockstep guard rejects diverged units until plan-driven publishing", () => {
  const root = fixtureRepository("0.1.8");
  writeFixtureFile(root, "skills/VERSION", "0.1.9\n");
  assert.ok(collectVersionMismatches(root).some((line) => line.startsWith("skills: version 0.1.9 must equal VERSION 0.1.8")));
});

test("setReleaseVersion moves every unit and the new VERSION files together", () => {
  const root = fixtureRepository("0.1.8");
  setReleaseVersion(root, "0.1.9");
  assert.deepEqual(collectVersionMismatches(root, "v0.1.9"), []);
});
```

Use the existing fixture helpers' real names (read the top 260 lines of the test file); add `skills/VERSION` and the two Java `VERSION` files to the fixture writer, and adapt `phpCoreManifest` to the helper that already writes that manifest.

- [ ] **Step 2: Run** `node --test scripts/release/test/release-model.test.mjs` — Expected: FAIL.

- [ ] **Step 3: Implement** the `unit` field on every location/slot (table above), `collectUnitVersionMismatches`, the lockstep guard, `setReleaseVersion` covering the new files, and change `version.mjs --check` output to print one line per unit (`<unit> <version>`) on success. Keep all existing safety properties (span-preserving rewrites, rollback, symlink and hard-link rejection).

- [ ] **Step 4: Run** `pnpm release:test && node scripts/release/version.mjs --check` — Expected: PASS, 13 unit lines printed.

- [ ] **Step 5: Commit**

```bash
git add scripts/release
git commit -m "feat(release): bind every version slot to its release unit"
```

---

### Task 4: Docs check per unit

**Files:**
- Modify: `scripts/docs/check-docs.mjs` (`staleCoordinateErrors`, `releasedSdkGuideErrors`, `checkDocumentation`)
- Test: `scripts/docs/test/check-docs.test.mjs`

**Interfaces:**
- Consumes: `readUnitVersions` (from `release-model.mjs`), `RELEASE_UNITS` (from `units.mjs`, to map an npm package name, Composer name or Maven coordinate to its unit).
- Produces: each documented coordinate is compared with its own unit's version: `@8lines/gauntlet-<x>@v` with the npm unit owning that package; `ghcr.io/8lines/gauntlet:v` with `gauntlet`; `dev.eightlines.gauntlet:core:v` with `java-core`; `…:spring-boot-starter:v` with `spring-boot-starter`; `8lines/gauntlet-php-core` with `php-core`; `8lines/gauntlet-symfony-bundle` with `symfony-bundle`. A coordinate for a package with no unit is an error (`unknown Gauntlet package`). When unit versions cannot be read (synthetic fixtures), behave as today (skip version comparisons).

- [ ] **Step 1: Failing test** in `check-docs.test.mjs` using the existing fixture style (versions at 0.1.0): write unit version files so `protocol` is 0.1.1 and everything else 0.1.0, a doc with `pnpm add @8lines/gauntlet-protocol@0.1.1 @8lines/gauntlet-typescript-core@0.1.0` → no errors; a doc with `@8lines/gauntlet-protocol@0.1.0` → error `contains mismatched Gauntlet package version: 0.1.0`; a doc with `dev.eightlines.gauntlet:core:0.1.1` while `java-core` is 0.1.0 → `non-exact Java consumer coordinate`.

- [ ] **Step 2: Run** `node --test scripts/docs/test/check-docs.test.mjs` — Expected: FAIL.
- [ ] **Step 3: Implement** with a `versionFor(coordinateKind, name)` helper built from `RELEASE_UNITS` and `readUnitVersions(root)` (wrapped in try/catch for synthetic fixtures).
- [ ] **Step 4: Run** `node --test scripts/docs/test/*.test.mjs && node scripts/docs/check-docs.mjs` — Expected: PASS and `{"ok":true}`.
- [ ] **Step 5: Commit** `git add scripts/docs && git commit -m "feat(docs): check documented coordinates against their release unit"`

---

### Task 5: Remove hard-coded versions from Helm tests and skill fixtures

**Files:**
- Modify: `deploy/helm/test-chart-package.mjs`, `deploy/helm/test-rendered-manifests.mjs`, `deploy/helm/test-documentation.mjs`, `skill-evals/gauntlet-app-integration/prepare-fixture.mjs`, `skill-evals/gauntlet-app-integration/test/prepare-fixture.test.mjs`, `skill-evals/gauntlet-app-integration/test/valid-symfony-fixture.test.mjs`, and evaluation receipts (`skill-evals/*/external-inputs.json`, `results/*.jsonl`, `verification.json`, `EVALUATING.md`) re-bound once
- Test: the same files

**Interfaces:**
- Consumes: `readUnitVersion` from `scripts/release/release-model.mjs` (Task 2).
- Produces: Helm tests read the chart version from `deploy/helm/gauntlet/Chart.yaml` (`version` and `appVersion`) at test start (`const CHART_VERSION = …` via the `yaml` package) and use it everywhere `"0.1.8"` appears today (lines listed by `grep -n 0.1.8 deploy/helm/test-*.mjs`). `prepare-fixture.mjs` reads `php-core`, `symfony-bundle`, `protocol`, `typescript-core`, `typescript-node` and `gauntlet` versions with `readUnitVersion(repositoryRoot, id)` and interpolates them into every place that hard-codes `0.1.8` today (lines ~1213-1214, 1263, 1668-1669, 1826-1828, 2012-2014, 2029-2040, 2138). Its tests compute expectations from the same reader. The forward Node Compose fixture stays pinned to the version named in its frozen prompt (`prepare-forward-fixture.mjs`, do not change).

- [ ] **Step 1: Failing test (version-independence)**: add `deploy/helm/test-version-independence.mjs` (registered in the `test:helm` script list in root `package.json`) that copies `deploy/helm/gauntlet` to a temp dir, rewrites `version`/`appVersion` and `values.yaml` `image.tag` to `0.1.9`, and runs the chart packaging projection used by `test-chart-package.mjs` against it, asserting `version === "0.1.9"`. Add to `prepare-fixture.test.mjs` a case that stubs `readUnitVersion` (inject the reader as an optional parameter of the exported preparer) returning `0.1.9` for every unit and asserts the generated Symfony `composer.json` requires `0.1.9` for both packages and the compose file pins `ghcr.io/8lines/gauntlet:0.1.9`.
- [ ] **Step 2: Run** `pnpm test:helm && node --test skill-evals/*/test/*.test.mjs` — Expected: the new cases FAIL.
- [ ] **Step 3: Implement** the reads and interpolation; do not change recorded prompts, responses, reviews or timestamps.
- [ ] **Step 4: Re-bind evaluation receipts** because `prepare-fixture.mjs`, `scripts/release/release-model.mjs` and new `VERSION` inputs changed bound bytes: follow exactly the procedure of commit `e0d2138` (`git show e0d2138 --stat` and its message; it used the repository's `scripts/skills` tooling), and append to each affected `EVALUATING.md` a paragraph in the same style: "The release unit model (2026-10-03) changed bound inputs without changing prompts, scenarios, scorecards or verifiers; hashes were re-bound to current bytes without generating new model samples. This confirms content integrity, not behaviour."
- [ ] **Step 5: Run** `pnpm test:helm && node --test skill-evals/*/test/*.test.mjs && pnpm release:test` and the skills validation command used in CI (`grep -n skills .github/workflows/ci.yml` to find it). Expected: PASS.
- [ ] **Step 6: Commit** `git add deploy/helm skill-evals package.json && git commit -m "test(release): read versions from manifests instead of hard-coding them"`

---

### Task 6: Baseline unit tags and lockstep note

**Files:**
- Create: `scripts/release/baseline-tags.mjs`, `scripts/release/test/baseline-tags.test.mjs`
- Modify: root `package.json` (`"release:baseline-tags": "node scripts/release/baseline-tags.mjs"`), `docs/releases/releasing.md` (short "Release units" section)

**Interfaces:**
- Consumes: `RELEASE_UNITS`, `unitTag` (from `units.mjs`); `parseReleaseVersion` (from `release-model.mjs`).
- Produces: `planBaselineTags({ root, commit }): { create: { tag, unit, version }[]; existing: { tag, target }[] }` and a CLI `node scripts/release/baseline-tags.mjs --commit <sha> [--apply]`. Without `--apply` it prints the plan; with `--apply` it creates annotated tags `"<unit> <version> baseline"` locally for every unit except those whose tag already exists. An existing tag pointing at a different commit is an error (`baseline tag <tag> already points at <sha>`). It never pushes.

- [ ] **Step 1: Failing tests**: in a temp git repo with two commits, `planBaselineTags` on the first commit lists 12 tags to create (all but `v0.1.8` when `v0.1.8` exists on that commit); with `protocol-v0.1.8` already on the second commit it throws; applying twice is a no-op the second time.
- [ ] **Step 2: Run** `node --test scripts/release/test/baseline-tags.test.mjs` — Expected: FAIL.
- [ ] **Step 3: Implement** with `git` via `spawnSync` (`git rev-parse <tag>^{commit}`, `git tag -a <tag> -m <msg> <commit>`), reading versions at the given commit with `git show <commit>:<path>` so the baseline uses the released manifests.
- [ ] **Step 4: Run** the tests, then in the real repository `node scripts/release/baseline-tags.mjs --commit e3f80e5` (dry run, no `--apply`) and paste the plan into the report. Do not apply or push; the controller asks the user.
- [ ] **Step 5: Docs**: add to `docs/releases/releasing.md` a section "Release units" stating the 13 units, that versions are per unit, that until plan-driven publishing lands every unit must still equal `VERSION` (lockstep guard), and the baseline tag command. Run `node scripts/docs/check-docs.mjs`.
- [ ] **Step 6: Final verification**: `pnpm check` from the repo root. Expected: PASS.
- [ ] **Step 7: Commit** `git add scripts/release package.json docs/releases/releasing.md && git commit -m "feat(release): add baseline unit tags and document release units"`
