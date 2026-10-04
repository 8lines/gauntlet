import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  collectUnitVersionMismatches,
  collectVersionMismatches,
  LOCKSTEP_RELEASES,
  readReleaseVersion,
  readUnitVersion,
  RELEASE_ARTIFACTS,
  VERSION_LOCATIONS,
  parseReleaseVersion,
  setReleaseVersion,
  setUnitVersions,
} from "../release-model.mjs";
import { createReleasePlan, serializeReleasePlan } from "../plan.mjs";
import { RELEASE_UNITS } from "../units.mjs";
import { parseVersionCommand, runVersionCli } from "../version.mjs";

const EXPECTED_ARTIFACTS = {
  npm: [
    ["@8lines/gauntlet-protocol", "packages/protocol", "https://registry.npmjs.org/"],
    ["@8lines/gauntlet-dashboard-client", "packages/dashboard-client", "https://registry.npmjs.org/"],
    ["@8lines/gauntlet-typescript-core", "packages/typescript/core", "https://registry.npmjs.org/"],
    ["@8lines/gauntlet-typescript-node", "packages/typescript/node", "https://registry.npmjs.org/"],
    ["@8lines/gauntlet-next-adapter", "packages/typescript/next", "https://registry.npmjs.org/"],
    ["@8lines/gauntlet-conformance-runner", "conformance/runner", "https://registry.npmjs.org/"],
    ["@8lines/gauntlet-widget", "packages/widget", "https://registry.npmjs.org/"],
  ],
  composer: [
    [
      "8lines/gauntlet-php-core",
      "packages/php/core",
      "8lines/gauntlet-php-core",
      "https://github.com/8lines/gauntlet-php-core.git",
    ],
    [
      "8lines/gauntlet-symfony-bundle",
      "packages/php/symfony-bundle",
      "8lines/gauntlet-symfony-bundle",
      "https://github.com/8lines/gauntlet-symfony-bundle.git",
    ],
  ],
  maven: [
    ["dev.eightlines.gauntlet:core", "packages/java/core", ":core", "https://maven.pkg.github.com/8lines/gauntlet"],
    [
      "dev.eightlines.gauntlet:spring-boot-starter",
      "packages/java/spring-boot-starter",
      ":spring-boot-starter",
      "https://maven.pkg.github.com/8lines/gauntlet",
    ],
  ],
  image: ["ghcr.io/8lines/gauntlet", ".", "runtime"],
  compose: ["gauntlet-compose", "deploy/compose"],
  chart: ["gauntlet", "deploy/helm/gauntlet", "oci://ghcr.io/8lines/charts"],
  skills: ["gauntlet-skills", "skills"],
};

function assertDeeplyFrozen(value) {
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === "object") {
      assertDeeplyFrozen(child);
    }
  }
}

const PACKAGE_IDENTITIES = [
  ["packages/protocol/package.json", "@8lines/gauntlet-protocol"],
  ["packages/dashboard-client/package.json", "@8lines/gauntlet-dashboard-client"],
  ["packages/typescript/core/package.json", "@8lines/gauntlet-typescript-core"],
  ["packages/typescript/node/package.json", "@8lines/gauntlet-typescript-node"],
  ["packages/typescript/next/package.json", "@8lines/gauntlet-next-adapter"],
  ["conformance/runner/package.json", "@8lines/gauntlet-conformance-runner"],
  ["packages/widget/package.json", "@8lines/gauntlet-widget"],
  ["apps/dashboard/package.json", "@8lines/gauntlet-dashboard"],
  ["apps/server/package.json", "@8lines/gauntlet-server"],
];

const RELEASE_TEXT_PATHS = [
  "tests/consumers/java/build.gradle.kts",
  "tests/consumers/java/gradle.lockfile",
  "skills/gauntlet-app-integration/references/node.md",
  "skills/gauntlet-app-integration/references/nextjs.md",
  "skills/gauntlet-app-integration/references/symfony.md",
  "skills/gauntlet-app-integration/references/spring.md",
  "skills/gauntlet-app-integration/references/deployment.md",
  "skills/gauntlet-app-integration/references/safety-gates.md",
  "docs/ai-skills.md",
];

// Each release-text file with the units whose slots it holds, in slot order, and the slot count per unit.
const RELEASE_TEXT_UNITS = [
  ["tests/consumers/java/build.gradle.kts", [["spring-boot-starter", 1]]],
  ["tests/consumers/java/gradle.lockfile", [["java-core", 1], ["spring-boot-starter", 1]]],
  ["skills/gauntlet-app-integration/references/node.md", [["protocol", 1], ["typescript-core", 1], ["typescript-node", 1]]],
  ["skills/gauntlet-app-integration/references/nextjs.md", [["protocol", 1], ["typescript-core", 1], ["next-adapter", 1]]],
  ["skills/gauntlet-app-integration/references/symfony.md", [["php-core", 1], ["symfony-bundle", 1]]],
  ["skills/gauntlet-app-integration/references/spring.md", [["spring-boot-starter", 3]]],
  ["skills/gauntlet-app-integration/references/deployment.md", [["gauntlet", 3]]],
  ["skills/gauntlet-app-integration/references/safety-gates.md", [["gauntlet", 1]]],
  ["docs/ai-skills.md", [["skills", 3]]],
];

const EXPECTED_UPDATE_PATHS = [
  "packages/protocol/package.json",
  "packages/dashboard-client/package.json",
  "packages/typescript/core/package.json",
  "packages/typescript/node/package.json",
  "packages/typescript/next/package.json",
  "conformance/runner/package.json",
  "packages/widget/package.json",
  "apps/dashboard/package.json",
  "apps/server/package.json",
  "packages/php/core/composer.json",
  "packages/php/symfony-bundle/composer.json",
  "deploy/helm/gauntlet/Chart.yaml",
  "deploy/helm/gauntlet/values.yaml",
  "deploy/compose/.env.example",
  "tests/consumers/php-core/composer.json",
  "tests/consumers/php-symfony/composer.json",
  ...RELEASE_TEXT_PATHS,
  "packages/java/core/VERSION",
  "packages/java/spring-boot-starter/VERSION",
  "skills/VERSION",
  "VERSION",
];

const UNIT_VERSION_FILES = [
  "packages/java/core/VERSION",
  "packages/java/spring-boot-starter/VERSION",
  "skills/VERSION",
];

const GRADLE_VERSION_DERIVATION = `import java.nio.charset.StandardCharsets

fun projectReleaseVersion(versionFile: java.io.File): String {
    val bytes = versionFile.readBytes()
    require(bytes.size in 6..64)
    require(bytes.all { it.toInt() in 0..127 })
    val record = bytes.toString(StandardCharsets.US_ASCII)
    require(Regex("""^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\n$""").matches(record))
    return record.removeSuffix("\\n")
}

allprojects {
    group = "dev.eightlines.gauntlet"
    version = projectReleaseVersion(project.file("VERSION"))
}
`;

function writeFixtureFile(root, relativePath, contents, mode = 0o644) {
  const path = join(root, relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents, { mode });
}

function releaseTextFixtures(version) {
  return new Map([
    [
      "tests/consumers/java/build.gradle.kts",
      `dependencies {\n    implementation("dev.eightlines.gauntlet:spring-boot-starter:${version}")\n}\n`,
    ],
    [
      "tests/consumers/java/gradle.lockfile",
      `dev.eightlines.gauntlet:core:${version}=compileClasspath,runtimeClasspath\ndev.eightlines.gauntlet:spring-boot-starter:${version}=compileClasspath,runtimeClasspath\nempty=annotationProcessor\n`,
    ],
    [
      "skills/gauntlet-app-integration/references/node.md",
      `Support Node.js 24–26.\npnpm add @8lines/gauntlet-protocol@${version} \\\n  @8lines/gauntlet-typescript-core@${version} \\\n  @8lines/gauntlet-typescript-node@${version}\n`,
    ],
    [
      "skills/gauntlet-app-integration/references/nextjs.md",
      `Support Next.js on Node.js 24–26.\npnpm add @8lines/gauntlet-protocol@${version} \\\n  @8lines/gauntlet-typescript-core@${version} \\\n  @8lines/gauntlet-next-adapter@${version}\n`,
    ],
    [
      "skills/gauntlet-app-integration/references/symfony.md",
      `Support PHP 8.3+ and Symfony 7.4. Declare repositories and install exact release \`${version}\` of \`8lines/gauntlet-php-core\` and exact release \`${version}\` of \`8lines/gauntlet-symfony-bundle\`.\n`,
    ],
    [
      "skills/gauntlet-app-integration/references/spring.md",
      `Support Java 21 and Spring Boot 4.1.\nimplementation("dev.eightlines.gauntlet:spring-boot-starter:${version}")\nPrefer released \`${version}\` metadata; reject \`${version}-SNAPSHOT\` coordinates.\n`,
    ],
    [
      "skills/gauntlet-app-integration/references/deployment.md",
      `Use exact image \`ghcr.io/8lines/gauntlet:${version}\` or an approved digest. Bind to \`127.0.0.1\`.\nUse exact chart \`oci://ghcr.io/8lines/charts/gauntlet\` version \`${version}\` and exact image \`${version}\` or a reviewed digest. Require Kubernetes \`>=1.35\` and Helm \`4.0.4\`.\n`,
    ],
    [
      "skills/gauntlet-app-integration/references/safety-gates.md",
      `Confirmation is not authentication. Version \`${version}\` has no built-in Gauntlet authentication.\n`,
    ],
    [
      "docs/ai-skills.md",
      `The GitHub release contains \`gauntlet-skills-${version}.tgz\` and records its digest.\ntar -xzf gauntlet-skills-${version}.tgz -C "$skills_unpack"\nskills_archive_root="$skills_unpack/gauntlet-skills-${version}"\n`,
    ],
  ]);
}

function writeReleaseTextFixtures(root, version) {
  for (const [path, contents] of releaseTextFixtures(version)) writeFixtureFile(root, path, contents);
}

function writeConsumerJsonFixtures(root, version) {
  writeFixtureFile(root, "tests/consumers/php-core/composer.json", `${JSON.stringify({
    name: "8lines/gauntlet-php-core-consumer",
    require: { "8lines/gauntlet-php-core": version },
  }, null, 2)}\n`);
  writeFixtureFile(root, "tests/consumers/php-symfony/composer.json", `${JSON.stringify({
    name: "8lines/gauntlet-symfony-consumer",
    require: {
      "8lines/gauntlet-php-core": version,
      "8lines/gauntlet-symfony-bundle": version,
    },
  }, null, 2)}\n`);
}

function createVersionFixture(version = "0.1.0") {
  const root = mkdtempSync(join(tmpdir(), "gauntlet-release-model-"));
  for (const path of ["VERSION", ...UNIT_VERSION_FILES]) writeFixtureFile(root, path, `${version}\n`);
  for (const [path, name] of PACKAGE_IDENTITIES) {
    writeFixtureFile(root, path, `${JSON.stringify({ name, version }, null, 2)}\n`);
  }
  writeFixtureFile(
    root,
    "packages/php/core/composer.json",
    `${JSON.stringify({ name: "8lines/gauntlet-php-core", version, require: { php: ">=8.5" } }, null, 2)}\n`,
  );
  writeFixtureFile(
    root,
    "packages/php/symfony-bundle/composer.json",
    `${JSON.stringify(
      {
        name: "8lines/gauntlet-symfony-bundle",
        version,
        require: { "8lines/gauntlet-php-core": `^${version}` },
      },
      null,
      2,
    )}\n`,
  );
  writeFixtureFile(root, "packages/java/build.gradle.kts", GRADLE_VERSION_DERIVATION);
  writeFixtureFile(
    root,
    "deploy/helm/gauntlet/Chart.yaml",
    `apiVersion: v2\nname: gauntlet\nversion: ${version} # chart\nappVersion: "${version}" # app\n`,
  );
  writeFixtureFile(
    root,
    "deploy/helm/gauntlet/values.yaml",
    `image:\n  repository: ghcr.io/8lines/gauntlet\n  tag: '${version}' # runtime\n  digest: ""\n`,
  );
  writeFixtureFile(
    root,
    "deploy/compose/.env.example",
    `GAUNTLET_IMAGE=ghcr.io/8lines/gauntlet:${version}\nGAUNTLET_BIND=127.0.0.1\n`,
  );
  writeConsumerJsonFixtures(root, version);
  writeReleaseTextFixtures(root, version);
  return root;
}

function withVersionFixture(callback) {
  const root = createVersionFixture();
  try {
    return callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function fixtureSnapshot(root) {
  return new Map(
    EXPECTED_UPDATE_PATHS.map((path) => {
      const stat = statSync(join(root, path), { bigint: true });
      return [path, { bytes: readFileSync(join(root, path)), ino: stat.ino, mode: stat.mode, mtimeNs: stat.mtimeNs }];
    }),
  );
}

function findUpdaterScratch(root) {
  const found = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.includes(".gauntlet-version-")) found.push(path);
    }
  }
  visit(root);
  return found;
}

function testingOptions(boundary) {
  return { testingHooks: { boundary } };
}

test("accepts only an exact stable ASCII SemVer VERSION record", () => {
  assert.equal(parseReleaseVersion("0.1.0\n"), "0.1.0");
  assert.equal(parseReleaseVersion(Buffer.from("12.34.56\n", "ascii")), "12.34.56");

  for (const invalid of [
    "0.1.0",
    "0.1.0\r\n",
    "0.1.0\n\n",
    " 0.1.0\n",
    "0.1.0 \n",
    "v0.1.0\n",
    "01.1.0\n",
    "0.01.0\n",
    "0.1.00\n",
    "0.1.0-SNAPSHOT\n",
    "0.1.0-rc.1\n",
    "0.1.0+build\n",
    "0.1.0\0\n",
    "０.1.0\n",
    `${"9".repeat(64)}.1.0\n`,
    100,
    null,
  ]) {
    assert.throws(
      () => parseReleaseVersion(invalid),
      (error) => {
        assert.equal(error.message, "Release version must be an exact stable ASCII semantic version followed by one LF");
        assert.doesNotMatch(error.message, /SNAPSHOT|rc\.1|build|repeat/);
        return true;
      },
    );
  }
});

test("freezes the fifteen fixed release artifact identities and destinations", () => {
  assert.deepEqual(
    RELEASE_ARTIFACTS.npm.map(({ name, directory, registry }) => [name, directory, registry]),
    EXPECTED_ARTIFACTS.npm,
  );
  assert.deepEqual(
    RELEASE_ARTIFACTS.composer.map(({ name, directory, repository, repositoryUrl }) => [name, directory, repository, repositoryUrl]),
    EXPECTED_ARTIFACTS.composer,
  );
  assert.deepEqual(
    RELEASE_ARTIFACTS.maven.map(({ name, directory, project, repository }) => [name, directory, project, repository]),
    EXPECTED_ARTIFACTS.maven,
  );
  assert.deepEqual(
    [RELEASE_ARTIFACTS.image.name, RELEASE_ARTIFACTS.image.context, RELEASE_ARTIFACTS.image.runtimeTarget],
    EXPECTED_ARTIFACTS.image,
  );
  assert.deepEqual(
    [RELEASE_ARTIFACTS.compose.name, RELEASE_ARTIFACTS.compose.directory],
    EXPECTED_ARTIFACTS.compose,
  );
  assert.deepEqual(
    [RELEASE_ARTIFACTS.chart.name, RELEASE_ARTIFACTS.chart.directory, RELEASE_ARTIFACTS.chart.repository],
    EXPECTED_ARTIFACTS.chart,
  );
  assert.deepEqual(
    [RELEASE_ARTIFACTS.skills.name, RELEASE_ARTIFACTS.skills.directory],
    EXPECTED_ARTIFACTS.skills,
  );

  const records = [
    ...RELEASE_ARTIFACTS.npm,
    ...RELEASE_ARTIFACTS.composer,
    ...RELEASE_ARTIFACTS.maven,
    RELEASE_ARTIFACTS.image,
    RELEASE_ARTIFACTS.compose,
    RELEASE_ARTIFACTS.chart,
    RELEASE_ARTIFACTS.skills,
  ];
  assert.equal(records.length, 15);
  assert.equal(new Set(records.map(({ name }) => name)).size, 15);
  assert.deepEqual(RELEASE_ARTIFACTS.npm.map((record) => Object.keys(record)), Array(7).fill(["name", "directory", "registry"]));
  assert.deepEqual(
    RELEASE_ARTIFACTS.composer.map((record) => Object.keys(record)),
    Array(2).fill(["name", "directory", "repository", "repositoryUrl"]),
  );
  assert.deepEqual(
    RELEASE_ARTIFACTS.maven.map((record) => Object.keys(record)),
    Array(2).fill(["name", "directory", "project", "repository"]),
  );
  assert.deepEqual(Object.keys(RELEASE_ARTIFACTS.image), ["name", "context", "runtimeTarget"]);
  assert.deepEqual(Object.keys(RELEASE_ARTIFACTS.compose), ["name", "directory"]);
  assert.deepEqual(Object.keys(RELEASE_ARTIFACTS.chart), ["name", "directory", "repository"]);
  assert.deepEqual(Object.keys(RELEASE_ARTIFACTS.skills), ["name", "directory"]);
  const paths = [
    ...RELEASE_ARTIFACTS.npm.map(({ directory }) => directory),
    ...RELEASE_ARTIFACTS.composer.map(({ directory }) => directory),
    ...RELEASE_ARTIFACTS.maven.map(({ directory }) => directory),
    RELEASE_ARTIFACTS.image.context,
    RELEASE_ARTIFACTS.compose.directory,
    RELEASE_ARTIFACTS.chart.directory,
    RELEASE_ARTIFACTS.skills.directory,
  ];
  assert.equal(new Set(paths).size, 15);
  assert.deepEqual([...paths].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))), [
    ".",
    "conformance/runner",
    "deploy/compose",
    "deploy/helm/gauntlet",
    "packages/dashboard-client",
    "packages/java/core",
    "packages/java/spring-boot-starter",
    "packages/php/core",
    "packages/php/symfony-bundle",
    "packages/protocol",
    "packages/typescript/core",
    "packages/typescript/next",
    "packages/typescript/node",
    "packages/widget",
    "skills",
  ]);
  assertDeeplyFrozen(RELEASE_ARTIFACTS);
  assert.throws(() => {
    RELEASE_ARTIFACTS.npm[0].directory = "../elsewhere";
  }, TypeError);
});

test("publishes every release-text file in the frozen version-location inventory", () => {
  const releaseTextLocations = VERSION_LOCATIONS.filter(({ type }) => type === "release-text");
  assert.deepEqual(
    releaseTextLocations.map(({ path, unit, occurrences }) => [path, unit, occurrences]),
    RELEASE_TEXT_UNITS.flatMap(([path, units]) => units.map(([unit, occurrences]) => [path, unit, occurrences])),
  );
  assert.deepEqual(RELEASE_TEXT_UNITS.map(([path]) => path), RELEASE_TEXT_PATHS);
  assertDeeplyFrozen(VERSION_LOCATIONS);
});

test("binds every version location to a release unit", () => {
  const unitIds = new Set(RELEASE_UNITS.map(({ id }) => id));
  for (const location of VERSION_LOCATIONS) {
    assert.equal(typeof location.unit, "string", location.path);
    assert.equal(unitIds.has(location.unit), true, `${location.path} names ${location.unit}`);
  }
  const owner = (path, keyPath) =>
    VERSION_LOCATIONS.find((location) => location.path === path && JSON.stringify(location.keyPath) === JSON.stringify(keyPath))?.unit;
  assert.equal(owner("packages/protocol/package.json", ["version"]), "protocol");
  assert.equal(owner("apps/server/package.json", ["version"]), "gauntlet");
  assert.equal(owner("packages/php/symfony-bundle/composer.json", ["version"]), "symfony-bundle");
  assert.equal(owner("packages/php/symfony-bundle/composer.json", ["require", "8lines/gauntlet-php-core"]), "php-core");
  assert.equal(owner("tests/consumers/php-symfony/composer.json", ["require", "8lines/gauntlet-php-core"]), "php-core");
  assert.equal(owner("tests/consumers/php-symfony/composer.json", ["require", "8lines/gauntlet-symfony-bundle"]), "symfony-bundle");
  assert.deepEqual(
    VERSION_LOCATIONS.filter(({ type }) => type === "file").map(({ path, unit }) => [path, unit]),
    [
      ["VERSION", "gauntlet"],
      ["packages/java/core/VERSION", "java-core"],
      ["packages/java/spring-boot-starter/VERSION", "spring-boot-starter"],
      ["skills/VERSION", "skills"],
    ],
  );
});

test("reads the canonical VERSION bytes without trimming or fallback", () => {
  withVersionFixture((root) => {
    assert.equal(readReleaseVersion(root), "0.1.0");
    writeFileSync(join(root, "VERSION"), "0.1.0\r\n");
    assert.throws(() => readReleaseVersion(root), /canonical VERSION file is invalid/);
    rmSync(join(root, "VERSION"));
    assert.throws(() => readReleaseVersion(root), /canonical VERSION file is invalid/);
  });
});

test("accepts a consistent fixture", () => {
  withVersionFixture((root) => {
    assert.deepEqual(collectVersionMismatches(root), []);
  });
});

test("reports stale and additional versions only in fixed release-text positions", () => {
  withVersionFixture((root) => {
    writeReleaseTextFixtures(root, "0.1.1");

    assert.deepEqual(collectVersionMismatches(root), RELEASE_TEXT_UNITS.flatMap(([path, units]) =>
      units.map(([unit]) => `${path}: release references must equal ${unit} 0.1.0`),
    ));
  });

  withVersionFixture((root) => {
    const nodePath = "skills/gauntlet-app-integration/references/node.md";
    const existing = readFileSync(join(root, nodePath), "utf8");
    writeFixtureFile(root, nodePath, `${existing}pnpm add @8lines/gauntlet-protocol@9.9.9\n`);

    const mismatches = collectVersionMismatches(root);
    assert.deepEqual(mismatches, [`${nodePath}: release references are missing or malformed`]);
    assert.doesNotMatch(mismatches.join("\n"), /9\.9\.9/);
  });

  withVersionFixture((root) => {
    const nodePath = "skills/gauntlet-app-integration/references/node.md";
    const existing = readFileSync(join(root, nodePath), "utf8");
    const oversized = `${"9".repeat(65)}.1.1`;
    writeFixtureFile(root, nodePath, existing.replace("@8lines/gauntlet-protocol@0.1.0", `@8lines/gauntlet-protocol@${oversized}`));

    const mismatches = collectVersionMismatches(root);
    assert.deepEqual(mismatches, [`${nodePath}: release references are missing or malformed`]);
    assert.doesNotMatch(mismatches.join("\n"), /999999/);
  });
});

test("reports every drifting slot against its own unit in fixed order", () => {
  withVersionFixture((root) => {
    for (const [path, name] of PACKAGE_IDENTITIES) {
      writeFixtureFile(root, path, `${JSON.stringify({ name, version: "0.1.1" })}\n`);
    }
    writeFixtureFile(
      root,
      "packages/php/core/composer.json",
      `${JSON.stringify({ name: "8lines/gauntlet-php-core", version: "0.1.1", require: {} })}\n`,
    );
    writeFixtureFile(
      root,
      "packages/php/symfony-bundle/composer.json",
      `${JSON.stringify({
        name: "8lines/gauntlet-symfony-bundle",
        version: "0.1.1",
        require: { "8lines/gauntlet-php-core": "^0.1.1" },
      })}\n`,
    );
    writeFixtureFile(
      root,
      "deploy/helm/gauntlet/Chart.yaml",
      "apiVersion: v2\nname: gauntlet\nversion: 0.1.1\nappVersion: \"0.1.1\"\n",
    );
    writeFixtureFile(
      root,
      "deploy/helm/gauntlet/values.yaml",
      "image:\n  repository: ghcr.io/8lines/gauntlet\n  tag: \"0.1.1\"\n  digest: \"\"\n",
    );
    writeFixtureFile(
      root,
      "deploy/compose/.env.example",
      "GAUNTLET_IMAGE=ghcr.io/8lines/gauntlet:0.1.1\nGAUNTLET_BIND=127.0.0.1\n",
    );
    writeConsumerJsonFixtures(root, "0.1.1");
    writeReleaseTextFixtures(root, "0.1.1");

    // Everything the fixture rewrote to 0.1.1 is a self-consistent unit. The gauntlet,
    // java-core, spring-boot-starter and skills units still say 0.1.0 in their own version files.
    assert.deepEqual(collectVersionMismatches(root), [
      "apps/dashboard/package.json: version must equal gauntlet 0.1.0",
      "apps/server/package.json: version must equal gauntlet 0.1.0",
      "deploy/helm/gauntlet/Chart.yaml: version must equal gauntlet 0.1.0",
      "deploy/helm/gauntlet/Chart.yaml: appVersion must equal gauntlet 0.1.0",
      "deploy/helm/gauntlet/values.yaml: image.tag must equal gauntlet 0.1.0",
      "deploy/compose/.env.example: GAUNTLET_IMAGE must equal ghcr.io/8lines/gauntlet:0.1.0",
      "tests/consumers/java/build.gradle.kts: release references must equal spring-boot-starter 0.1.0",
      "tests/consumers/java/gradle.lockfile: release references must equal java-core 0.1.0",
      "tests/consumers/java/gradle.lockfile: release references must equal spring-boot-starter 0.1.0",
      "skills/gauntlet-app-integration/references/spring.md: release references must equal spring-boot-starter 0.1.0",
      "skills/gauntlet-app-integration/references/deployment.md: release references must equal gauntlet 0.1.0",
      "skills/gauntlet-app-integration/references/safety-gates.md: release references must equal gauntlet 0.1.0",
      "docs/ai-skills.md: release references must equal skills 0.1.0",
    ]);
  });
});

test("aggregates missing, malformed, duplicate, and wrongly typed version sources without leaking values", () => {
  withVersionFixture((root) => {
    rmSync(join(root, "packages/protocol/package.json"));
    writeFixtureFile(root, "packages/dashboard-client/package.json", "{not-json SECRET_VALUE}\n");
    writeFixtureFile(
      root,
      "packages/typescript/core/package.json",
      '{"name":"@8lines/gauntlet-typescript-core","version":"0.1.0","version":"9.9.9-SECRET"}\n',
    );
    writeFixtureFile(
      root,
      "packages/php/core/composer.json",
      `${JSON.stringify({ name: "8lines/gauntlet-php-core", version: 100, require: {} })}\n`,
    );
    writeFixtureFile(
      root,
      "deploy/helm/gauntlet/Chart.yaml",
      "apiVersion: v2\nname: gauntlet\nversion: 0.1.0\nversion: 9.9.9-SECRET\nappVersion: \"0.1.0\"\n",
    );
    writeFixtureFile(
      root,
      "deploy/compose/.env.example",
      "GAUNTLET_IMAGE=ghcr.io/8lines/gauntlet:0.1.0\nGAUNTLET_IMAGE=SECRET_VALUE\n",
    );

    const mismatches = collectVersionMismatches(root);
    assert.deepEqual(mismatches, [
      "packages/protocol/package.json: manifest is missing or unsafe",
      "packages/dashboard-client/package.json: manifest is malformed",
      "packages/typescript/core/package.json: manifest is malformed",
      "packages/php/core/composer.json: version must be a string",
      "deploy/helm/gauntlet/Chart.yaml: manifest is malformed",
      "deploy/compose/.env.example: manifest is malformed",
    ]);
    assert.doesNotMatch(mismatches.join("\n"), /SECRET_VALUE|9\.9\.9/);
  });
});

test("the Gradle contract accepts the per-project version derivation and rejects literal versions", () => {
  withVersionFixture((root) => {
    assert.deepEqual(collectVersionMismatches(root), []);
    for (const literal of [
      `${GRADLE_VERSION_DERIVATION}\nversion = "0.1.8"\n`,
      GRADLE_VERSION_DERIVATION.replace("project.file(\"VERSION\")", "rootProject.file(\"../../VERSION\")"),
      `${GRADLE_VERSION_DERIVATION}\n// 0.1.8-SNAPSHOT\n`,
    ]) {
      writeFixtureFile(root, "packages/java/build.gradle.kts", literal);
      assert.deepEqual(collectVersionMismatches(root), [
        "packages/java/build.gradle.kts: project group/version must derive from the canonical VERSION contract",
      ]);
    }
  });
});

test("checks fixed package, chart, image, and Gradle identities independently of versions", () => {
  withVersionFixture((root) => {
    writeFixtureFile(
      root,
      "packages/protocol/package.json",
      `${JSON.stringify({ name: "@hostile/wrong", version: "0.1.0" })}\n`,
    );
    writeFixtureFile(
      root,
      "deploy/helm/gauntlet/Chart.yaml",
      "apiVersion: v2\nname: hostile\nversion: 0.1.0\nappVersion: \"0.1.0\"\n",
    );
    writeFixtureFile(
      root,
      "deploy/helm/gauntlet/values.yaml",
      "image:\n  repository: docker.io/public/hostile\n  tag: \"0.1.0\"\n  digest: \"\"\n",
    );
    writeFixtureFile(root, "packages/java/build.gradle.kts", 'allprojects { group = "wrong"; version = "0.1.0-SNAPSHOT" }\n');

    assert.deepEqual(collectVersionMismatches(root), [
      "packages/protocol/package.json: name must equal @8lines/gauntlet-protocol",
      "packages/java/build.gradle.kts: project group/version must derive from the canonical VERSION contract",
      "deploy/helm/gauntlet/Chart.yaml: name must equal gauntlet",
      "deploy/helm/gauntlet/values.yaml: image.repository must equal ghcr.io/8lines/gauntlet",
    ]);
  });
});

test("sets every version span through bound descriptors while preserving surrounding bytes, modes, comments, and LF", () => {
  withVersionFixture((root) => {
    const protocolPath = join(root, "packages/protocol/package.json");
    writeFileSync(protocolPath, '{"name":"@8lines/gauntlet-protocol", "version" : "0.1.0", "note":"keep 0.1.0 in prose"}\n');
    chmodSync(protocolPath, 0o640);
    const gradleBefore = readFileSync(join(root, "packages/java/build.gradle.kts"));

    const result = setReleaseVersion(root, "0.1.1");

    assert.deepEqual(result, { version: "0.1.1", changedPaths: EXPECTED_UPDATE_PATHS });
    assert.equal(readReleaseVersion(root), "0.1.1");
    assert.deepEqual(collectVersionMismatches(root), []);
    assert.equal(
      readFileSync(protocolPath, "utf8"),
      '{"name":"@8lines/gauntlet-protocol", "version" : "0.1.1", "note":"keep 0.1.0 in prose"}\n',
    );
    assert.equal(statSync(protocolPath).mode & 0o777, 0o640);
    assert.equal(
      readFileSync(join(root, "deploy/helm/gauntlet/Chart.yaml"), "utf8"),
      'apiVersion: v2\nname: gauntlet\nversion: 0.1.1 # chart\nappVersion: "0.1.1" # app\n',
    );
    assert.equal(
      readFileSync(join(root, "deploy/helm/gauntlet/values.yaml"), "utf8"),
      "image:\n  repository: ghcr.io/8lines/gauntlet\n  tag: '0.1.1' # runtime\n  digest: \"\"\n",
    );
    for (const [path, expected] of releaseTextFixtures("0.1.1")) {
      assert.equal(readFileSync(join(root, path), "utf8"), expected, path);
    }
    assert.equal(
      JSON.parse(readFileSync(join(root, "tests/consumers/php-core/composer.json"), "utf8"))
        .require["8lines/gauntlet-php-core"],
      "0.1.1",
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(root, "tests/consumers/php-symfony/composer.json"), "utf8")).require,
      {
        "8lines/gauntlet-php-core": "0.1.1",
        "8lines/gauntlet-symfony-bundle": "0.1.1",
      },
    );
    assert.deepEqual(readFileSync(join(root, "packages/java/build.gradle.kts")), gradleBefore);
    for (const path of EXPECTED_UPDATE_PATHS) {
      const bytes = readFileSync(join(root, path));
      assert.equal(bytes.includes(0x0d), false, path);
      assert.equal(bytes.at(-1), 0x0a, path);
    }
    assert.deepEqual(findUpdaterScratch(root), []);
  });
});

test("same-version set is an inode-and-mtime preserving no-op", () => {
  withVersionFixture((root) => {
    const before = fixtureSnapshot(root);
    assert.deepEqual(setReleaseVersion(root, "0.1.0"), { version: "0.1.0", changedPaths: [] });
    const after = fixtureSnapshot(root);
    for (const path of EXPECTED_UPDATE_PATHS) {
      assert.deepEqual(after.get(path), before.get(path), path);
    }
    assert.deepEqual(findUpdaterScratch(root), []);
  });
});

test("descriptor writes preserve the exact mode even under a restrictive process umask", () => {
  withVersionFixture((root) => {
    const path = join(root, "packages/protocol/package.json");
    chmodSync(path, 0o666);
    const previousUmask = process.umask(0o077);
    try {
      setReleaseVersion(root, "0.1.1");
    } finally {
      process.umask(previousUmask);
    }
    assert.equal(statSync(path).mode & 0o777, 0o666);
  });
});

test("accepts only closed plain or null-prototype testing-hook records without invoking accessors or Proxy traps", () => {
  withVersionFixture((root) => {
    let getterCalled = false;
    const accessorOptions = {};
    Object.defineProperty(accessorOptions, "testingHooks", {
      enumerable: true,
      get() {
        getterCalled = true;
        return { boundary() {} };
      },
    });
    assert.throws(() => setReleaseVersion(root, "0.1.0", accessorOptions), /options are invalid/);
    assert.equal(getterCalled, false);

    assert.throws(() => setReleaseVersion(root, "0.1.0", Object.create({ testingHooks: {} })), /options are invalid/);
    assert.throws(() => setReleaseVersion(root, "0.1.0", []), /options are invalid/);

    let outerProxyTrapCalled = false;
    const proxyOptions = new Proxy(
      {},
      {
        ownKeys() {
          outerProxyTrapCalled = true;
          return [];
        },
      },
    );
    assert.throws(() => setReleaseVersion(root, "0.1.0", proxyOptions), /options are invalid/);
    assert.equal(outerProxyTrapCalled, false);

    const hidden = {};
    Object.defineProperty(hidden, "testingHooks", { value: { boundary() {} } });
    assert.throws(() => setReleaseVersion(root, "0.1.0", hidden), /options are invalid/);

    const symbolOptions = { testingHooks: { boundary() {} } };
    symbolOptions[Symbol("hidden")] = true;
    assert.throws(() => setReleaseVersion(root, "0.1.0", symbolOptions), /options are invalid/);

    let nestedGetterCalled = false;
    const accessorHooks = {};
    Object.defineProperty(accessorHooks, "boundary", {
      enumerable: true,
      get() {
        nestedGetterCalled = true;
        return () => {};
      },
    });
    assert.throws(
      () => setReleaseVersion(root, "0.1.0", { testingHooks: accessorHooks }),
      /options are invalid/,
    );
    assert.equal(nestedGetterCalled, false);

    let proxyTrapCalled = false;
    const proxyHooks = new Proxy(
      {},
      {
        ownKeys() {
          proxyTrapCalled = true;
          return [];
        },
      },
    );
    assert.throws(
      () => setReleaseVersion(root, "0.1.0", { testingHooks: proxyHooks }),
      /options are invalid/,
    );
    assert.equal(proxyTrapCalled, false);

    let applyTrapCalled = false;
    const proxyBoundary = new Proxy(
      () => {},
      {
        apply() {
          applyTrapCalled = true;
        },
      },
    );
    assert.throws(
      () => setReleaseVersion(root, "0.1.0", { testingHooks: { boundary: proxyBoundary } }),
      /options are invalid/,
    );
    assert.equal(applyTrapCalled, false);

    assert.throws(() => setReleaseVersion(root, "0.1.0", { testingHooks: {} }), /options are invalid/);
    assert.throws(
      () => setReleaseVersion(root, "0.1.0", { testingHooks: { boundary: "not-a-function" } }),
      /options are invalid/,
    );

    const nullPrototypeHooks = Object.create(null);
    nullPrototypeHooks.boundary = () => {};
    const nullPrototypeOptions = Object.create(null);
    nullPrototypeOptions.testingHooks = nullPrototypeHooks;
    assert.deepEqual(setReleaseVersion(root, "0.1.0", nullPrototypeOptions), {
      version: "0.1.0",
      changedPaths: [],
    });
  });
});

test("rejects an invalid requested version before reading or writing the repository", () => {
  assert.throws(
    () => setReleaseVersion("/definitely/not/a/repository", "0.1.0-SNAPSHOT"),
    /exact stable ASCII semantic version/,
  );
});

test("preflights every target, ancestor, and single-link identity before any write", () => {
  withVersionFixture((root) => {
    const before = fixtureSnapshot(root);
    writeFixtureFile(root, "deploy/compose/.env.example", "GAUNTLET_IMAGE=SECRET_VALUE\n");
    const malformedBefore = readFileSync(join(root, "deploy/compose/.env.example"));

    assert.throws(() => setReleaseVersion(root, "0.1.1"), /preflight failed/);
    for (const path of EXPECTED_UPDATE_PATHS.filter((path) => path !== "deploy/compose/.env.example")) {
      assert.deepEqual(readFileSync(join(root, path)), before.get(path).bytes, path);
    }
    assert.deepEqual(readFileSync(join(root, "deploy/compose/.env.example")), malformedBefore);
    assert.deepEqual(findUpdaterScratch(root), []);
  });

  withVersionFixture((root) => {
    const outside = join(root, "outside-package.json");
    writeFileSync(outside, '{"name":"@8lines/gauntlet-protocol","version":"0.1.0"}\n');
    const target = join(root, "packages/protocol/package.json");
    rmSync(target);
    symlinkSync(outside, target);
    assert.equal(lstatSync(target).isSymbolicLink(), true);
    assert.throws(() => setReleaseVersion(root, "0.1.1"), /preflight failed/);
    assert.equal(readReleaseVersion(root), "0.1.0");
    assert.equal(readFileSync(outside, "utf8"), '{"name":"@8lines/gauntlet-protocol","version":"0.1.0"}\n');
    assert.deepEqual(findUpdaterScratch(root), []);
  });

  withVersionFixture((root) => {
    const outsideRoot = mkdtempSync(join(tmpdir(), "gauntlet-release-hardlink-"));
    const outside = join(outsideRoot, "package.json");
    const target = join(root, "packages/protocol/package.json");
    const original = readFileSync(target);
    try {
      writeFileSync(outside, original);
      rmSync(target);
      linkSync(outside, target);
      assert.throws(() => setReleaseVersion(root, "0.1.1"), /preflight failed/);
      assert.deepEqual(readFileSync(outside), original);
      assert.equal(readReleaseVersion(root), "0.1.0");
      assert.deepEqual(findUpdaterScratch(root), []);
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });
});

test("exposes only frozen value-free metadata at descriptor test boundaries", () => {
  withVersionFixture((root) => {
    const observed = [];
    const result = setReleaseVersion(
      root,
      "0.1.1",
      testingOptions((metadata) => {
        assert.equal(Object.getPrototypeOf(metadata), null);
        assert.equal(Object.isFrozen(metadata), true);
        assert.deepEqual(Reflect.ownKeys(metadata), ["phase", "boundary", "index"]);
        for (const key of Reflect.ownKeys(metadata)) {
          const descriptor = Object.getOwnPropertyDescriptor(metadata, key);
          assert.equal("value" in descriptor, true);
          assert.equal(descriptor.enumerable, true);
          assert.equal(descriptor.configurable, false);
          assert.equal(descriptor.writable, false);
        }
        assert.equal("path" in metadata, false);
        assert.equal("bytes" in metadata, false);
        assert.deepEqual(findUpdaterScratch(root), []);
        observed.push([metadata.phase, metadata.boundary, metadata.index]);
      }),
    );

    assert.deepEqual(result, { version: "0.1.1", changedPaths: EXPECTED_UPDATE_PATHS });
    assert.deepEqual(
      observed,
      EXPECTED_UPDATE_PATHS.flatMap((_path, index) => [
        ["promote", "before-write", index],
        ["promote", "after-write", index],
      ]),
    );
    assert.equal(observed.at(-1)[2], EXPECTED_UPDATE_PATHS.length - 1);
  });
});

test("rejects legacy pathname-operation callbacks before they can mutate promote, rollback, or scratch paths", () => {
  for (const operationName of ["renameFile", "linkFile", "unlinkFile"]) {
    withVersionFixture((root) => {
      const before = fixtureSnapshot(root);
      let invoked = false;
      const unsafeOperation = (path) => {
        invoked = true;
        const displaced = path + ".owned";
        renameSync(path, displaced);
        writeFileSync(path, "FOREIGN_CALLBACK_SENTINEL\n");
        unlinkSync(path);
      };

      assert.throws(
        () => setReleaseVersion(root, "0.1.1", { [operationName]: unsafeOperation }),
        /options are invalid/,
      );
      assert.equal(invoked, false, operationName);
      for (const path of EXPECTED_UPDATE_PATHS) {
        assert.deepEqual(readFileSync(join(root, path)), before.get(path).bytes, operationName + ":" + path);
      }
      assert.deepEqual(findUpdaterScratch(root), []);
    });
  }
});

test("has no pathname promotion or cleanup primitive in the descriptor transaction", () => {
  const source = readFileSync(new URL("../release-model.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\b(?:renameSync|linkSync|unlinkSync)\b/);
});

test("does not expose failures thrown by the closed testing hook", () => {
  withVersionFixture((root) => {
    assert.throws(
      () =>
        setReleaseVersion(
          root,
          "0.1.1",
          testingOptions(() => {
            throw new Error("TESTING_HOOK_SECRET_SENTINEL");
          }),
        ),
      (error) => {
        assert.equal(error.message, "release version update failed");
        assert.doesNotMatch(error.message, /TESTING_HOOK_SECRET_SENTINEL/);
        return true;
      },
    );
    assert.equal(readReleaseVersion(root), "0.1.0");
  });
});

test("does not write through an ancestor swapped after the target guard", () => {
  withVersionFixture((root) => {
    const protocolDirectory = join(root, "packages/protocol");
    const outsideRoot = mkdtempSync(join(tmpdir(), "gauntlet-release-outside-"));
    const movedDirectory = join(outsideRoot, "protocol");
    const originalBytes = readFileSync(join(protocolDirectory, "package.json"));
    let swapped = false;

    try {
      assert.throws(
        () =>
          setReleaseVersion(
            root,
            "0.1.1",
            testingOptions((metadata) => {
              if (metadata.phase === "promote" && metadata.boundary === "before-write" && metadata.index === 0) {
                renameSync(protocolDirectory, movedDirectory);
                symlinkSync(movedDirectory, protocolDirectory, "dir");
                swapped = true;
              }
            }),
          ),
        /changed after preflight/,
      );

      assert.equal(swapped, true);
      assert.deepEqual(readFileSync(join(movedDirectory, "package.json")), originalBytes);
      assert.equal(readReleaseVersion(root), "0.1.0");
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });
});

test("does not write through an ancestor swapped before descriptor rollback", () => {
  withVersionFixture((root) => {
    const protocolDirectory = join(root, "packages/protocol");
    const outsideRoot = mkdtempSync(join(tmpdir(), "gauntlet-release-rollback-outside-"));
    const movedDirectory = join(outsideRoot, "protocol");
    let nextBytes;
    let swapped = false;

    try {
      assert.throws(
        () =>
          setReleaseVersion(
            root,
            "0.1.1",
            testingOptions((metadata) => {
              if (metadata.phase === "promote" && metadata.boundary === "after-write" && metadata.index === 0) {
                nextBytes = readFileSync(join(protocolDirectory, "package.json"));
              }
              if (
                metadata.phase === "promote" &&
                metadata.boundary === "after-write" &&
                metadata.index === EXPECTED_UPDATE_PATHS.length - 1
              ) {
                throw new Error("trigger rollback");
              }
              if (metadata.phase === "rollback" && metadata.boundary === "before-write" && metadata.index === 0) {
                renameSync(protocolDirectory, movedDirectory);
                symlinkSync(movedDirectory, protocolDirectory, "dir");
                swapped = true;
              }
            }),
          ),
        /repository version state is inconsistent/,
      );

      assert.equal(swapped, true);
      assert.deepEqual(readFileSync(join(movedDirectory, "package.json")), nextBytes);
      assert.equal(readReleaseVersion(root), "0.1.0");
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });
});

test("preserves a foreign target swapped in before a descriptor write", () => {
  withVersionFixture((root) => {
    const target = join(root, EXPECTED_UPDATE_PATHS[0]);
    const retained = target + ".owned";
    const originalBytes = readFileSync(target);
    const sentinel = "FOREIGN_TARGET_REPLACEMENT_SENTINEL\n";
    let swapped = false;

    assert.throws(
      () =>
        setReleaseVersion(
          root,
          "0.1.1",
          testingOptions((metadata) => {
            if (metadata.phase === "promote" && metadata.boundary === "before-write" && metadata.index === 0) {
              renameSync(target, retained);
              writeFileSync(target, sentinel);
              swapped = true;
            }
          }),
        ),
      (error) => {
        assert.doesNotMatch(error.message, /FOREIGN_TARGET_REPLACEMENT_SENTINEL/);
        return /changed after preflight/.test(error.message);
      },
    );

    assert.equal(swapped, true);
    assert.equal(readFileSync(target, "utf8"), sentinel);
    assert.deepEqual(readFileSync(retained), originalBytes);
    assert.equal(readReleaseVersion(root), "0.1.0");
    assert.deepEqual(findUpdaterScratch(root), []);
  });
});

test("preserves concurrent bytes written before and after promotion descriptor writes", () => {
  for (const boundary of ["before-write", "after-write"]) {
    withVersionFixture((root) => {
      const racedIndex = boundary === "before-write" ? 1 : 0;
      const racedPath = join(root, EXPECTED_UPDATE_PATHS[racedIndex]);
      const sentinel = "FOREIGN_DESCRIPTOR_RACE_SENTINEL_" + boundary + "\n";
      let raced = false;

      assert.throws(
        () =>
          setReleaseVersion(
            root,
            "0.1.1",
            testingOptions((metadata) => {
              if (metadata.phase === "promote" && metadata.boundary === boundary && metadata.index === racedIndex) {
                writeFileSync(racedPath, sentinel);
                raced = true;
              }
            }),
          ),
        (error) => {
          assert.doesNotMatch(error.message, /FOREIGN_DESCRIPTOR_RACE_SENTINEL/);
          return boundary === "before-write"
            ? /changed after preflight/.test(error.message)
            : /repository version state is inconsistent/.test(error.message);
        },
      );

      assert.equal(raced, true);
      assert.equal(readFileSync(racedPath, "utf8"), sentinel);
      assert.equal(readReleaseVersion(root), "0.1.0");
      assert.deepEqual(findUpdaterScratch(root), []);
    });
  }
});

test("preserves a foreign target and retained owned inode swapped in before rollback", () => {
  withVersionFixture((root) => {
    const racedIndex = 0;
    const racedPath = join(root, EXPECTED_UPDATE_PATHS[racedIndex]);
    const retainedPath = racedPath + ".owned";
    const sentinel = "FOREIGN_ROLLBACK_TARGET_SENTINEL\n";
    let retainedNextBytes;
    let swapped = false;

    assert.throws(
      () =>
        setReleaseVersion(
          root,
          "0.1.1",
          testingOptions((metadata) => {
            if (metadata.phase === "promote" && metadata.boundary === "after-write" && metadata.index === racedIndex) {
              retainedNextBytes = readFileSync(racedPath);
            }
            if (
              metadata.phase === "promote" &&
              metadata.boundary === "after-write" &&
              metadata.index === EXPECTED_UPDATE_PATHS.length - 1
            ) {
              throw new Error("trigger rollback");
            }
            if (metadata.phase === "rollback" && metadata.boundary === "before-write" && metadata.index === racedIndex) {
              renameSync(racedPath, retainedPath);
              writeFileSync(racedPath, sentinel);
              swapped = true;
            }
          }),
        ),
      (error) => {
        assert.doesNotMatch(error.message, /FOREIGN_ROLLBACK_TARGET_SENTINEL/);
        return /repository version state is inconsistent/.test(error.message);
      },
    );

    assert.equal(swapped, true);
    assert.equal(readFileSync(racedPath, "utf8"), sentinel);
    assert.deepEqual(readFileSync(retainedPath), retainedNextBytes);
    assert.equal(readReleaseVersion(root), "0.1.0");
    assert.deepEqual(findUpdaterScratch(root), []);
  });
});

test("rolls back after a failure at every descriptor promotion boundary and promotes VERSION last", () => {
  for (const boundary of ["before-write", "after-write"]) {
    for (let failureIndex = 0; failureIndex < EXPECTED_UPDATE_PATHS.length; failureIndex += 1) {
      withVersionFixture((root) => {
        const before = fixtureSnapshot(root);
        const promotions = [];
        const rollbacks = [];
        let injected = false;

        assert.throws(
          () =>
            setReleaseVersion(
              root,
              "0.1.1",
              testingOptions((metadata) => {
                if (metadata.phase === "rollback") {
                  rollbacks.push([metadata.boundary, metadata.index]);
                  return;
                }
                promotions.push([metadata.boundary, metadata.index]);
                if (metadata.boundary === boundary && metadata.index === failureIndex) {
                  injected = true;
                  throw new Error("injected promotion boundary failure");
                }
              }),
            ),
          /release version update failed/,
        );

        assert.equal(injected, true, boundary + ":" + failureIndex);
        assert.equal(
          promotions.some(([, index]) => index === EXPECTED_UPDATE_PATHS.length - 1),
          failureIndex === EXPECTED_UPDATE_PATHS.length - 1,
          boundary + ":" + failureIndex + ":VERSION",
        );
        const highestDirtyIndex = boundary === "before-write" ? failureIndex - 1 : failureIndex;
        const expectedRollbacks = [];
        for (let index = highestDirtyIndex; index >= 0; index -= 1) {
          expectedRollbacks.push(["before-write", index], ["after-write", index]);
        }
        assert.deepEqual(rollbacks, expectedRollbacks, boundary + ":" + failureIndex + ":rollback-order");
        for (const path of EXPECTED_UPDATE_PATHS) {
          assert.deepEqual(readFileSync(join(root, path)), before.get(path).bytes, boundary + ":" + failureIndex + ":" + path);
        }
        assert.deepEqual(findUpdaterScratch(root), []);
      });
    }
  }
});

test("reports an inconsistent state after a failure at every descriptor rollback boundary", () => {
  const lastIndex = EXPECTED_UPDATE_PATHS.length - 1;
  for (const boundary of ["before-write", "after-write"]) {
    for (let failureIndex = 0; failureIndex < EXPECTED_UPDATE_PATHS.length; failureIndex += 1) {
      withVersionFixture((root) => {
        let promotionFailureInjected = false;
        let rollbackFailureInjected = false;
        const contents = () => EXPECTED_UPDATE_PATHS.map((path) => readFileSync(join(root, path), "utf8"));
        const original = contents();

        assert.throws(
          () =>
            setReleaseVersion(
              root,
              "0.1.1",
              testingOptions((metadata) => {
                if (
                  metadata.phase === "promote" &&
                  metadata.boundary === "after-write" &&
                  metadata.index === lastIndex
                ) {
                  promotionFailureInjected = true;
                  throw new Error("trigger rollback");
                }
                if (
                  metadata.phase === "rollback" &&
                  metadata.boundary === boundary &&
                  metadata.index === failureIndex
                ) {
                  rollbackFailureInjected = true;
                  throw new Error("injected rollback boundary failure");
                }
              }),
            ),
          /repository version state is inconsistent/,
        );

        assert.equal(promotionFailureInjected, true, boundary + ":" + failureIndex + ":promote");
        assert.equal(rollbackFailureInjected, true, boundary + ":" + failureIndex + ":rollback");
        // A rollback that fails before its write leaves exactly that file at the new version. With
        // independent units that state can be per-unit consistent, so compare bytes, not mismatches.
        const changed = contents().filter((text, index) => text !== original[index]);
        if (boundary === "before-write") {
          assert.equal(changed.length, 1, boundary + ":" + failureIndex + ":changed");
        } else {
          assert.deepEqual(changed, []);
          assert.deepEqual(collectVersionMismatches(root), []);
        }
        assert.deepEqual(findUpdaterScratch(root), []);
      });
    }
  }
});

test("never removes foreign scratch-like entries on commit or rollback", () => {
  withVersionFixture((root) => {
    const foreignPath = join(root, "packages/protocol/.package.json.gauntlet-version-foreign");
    const sentinel = "FOREIGN_SCRATCH_SENTINEL_COMMIT\n";
    writeFileSync(foreignPath, sentinel);

    setReleaseVersion(root, "0.1.1");

    assert.equal(readFileSync(foreignPath, "utf8"), sentinel);
  });

  withVersionFixture((root) => {
    const foreignPath = join(root, "packages/protocol/.package.json.gauntlet-version-foreign");
    const sentinel = "FOREIGN_SCRATCH_SENTINEL_ROLLBACK\n";
    writeFileSync(foreignPath, sentinel);

    assert.throws(
      () =>
        setReleaseVersion(
          root,
          "0.1.1",
          testingOptions((metadata) => {
            if (metadata.phase === "promote" && metadata.boundary === "after-write" && metadata.index === 3) {
              throw new Error("trigger rollback");
            }
          }),
        ),
      /release version update failed/,
    );

    assert.equal(readFileSync(foreignPath, "utf8"), sentinel);
    assert.equal(readReleaseVersion(root), "0.1.0");
  });
});

test("accepts only the closed version CLI command shapes", () => {
  assert.deepEqual(parseVersionCommand(["--check"]), { command: "check" });
  assert.deepEqual(parseVersionCommand(["--check", "--plan", ".release/plan.json"]), {
    command: "check",
    plan: ".release/plan.json",
  });
  assert.deepEqual(parseVersionCommand(["--set", "0.1.1"]), { command: "set", version: "0.1.1" });
  assert.deepEqual(parseVersionCommand(["--set-unit", "php-core", "0.2.0"]), {
    command: "set-unit",
    unit: "php-core",
    version: "0.2.0",
  });

  for (const invalid of [
    [],
    ["--help"],
    ["--check", "--tag", "v0.1.0"],
    ["--check", "--plan"],
    ["--check", "--plan", ""],
    ["--plan", ".release/plan.json", "--check"],
    ["--check", "--plan", ".release/plan.json", "extra"],
    ["--set"],
    ["--set", "v0.1.1"],
    ["--set", "0.1.1", "extra"],
    ["--set-unit", "nope", "0.2.0"],
    ["--set-unit", "php-core"],
    ["--set-unit", "php-core", "v0.2.0"],
    ["--set-unit", "php-core", "0.2.0", "extra"],
    ["--root", "/tmp/SECRET_ROOT"],
  ]) {
    assert.throws(
      () => parseVersionCommand(invalid),
      (error) => {
        assert.equal(error.message, "Usage: version.mjs --check [--plan PATH] | --set X.Y.Z | --set-unit UNIT X.Y.Z");
        assert.doesNotMatch(error.message, /SECRET_ROOT/);
        return true;
      },
    );
  }
});

test("returns bounded one-line JSON for checks, mismatches, sets, and invalid CLI input", () => {
  withVersionFixture((root) => {
    const checked = runVersionCli(["--check"], { root });
    assert.equal(checked.exitCode, 0);
    assert.equal(checked.stderr, "");
    assert.equal(checked.stdout.endsWith("\n"), true);
    assert.equal(checked.stdout.split("\n").length, 2);
    assert.deepEqual(JSON.parse(checked.stdout), {
      command: "check",
      mismatches: [],
      ok: true,
      plan: null,
      units: RELEASE_UNITS.map(({ id }) => `${id} 0.1.0`),
      version: "0.1.0",
    });
    assert.equal(JSON.parse(checked.stdout).units.length, 13);

    writeFixtureFile(
      root,
      "apps/server/package.json",
      `${JSON.stringify({ name: "@8lines/gauntlet-server", version: "0.1.1" })}\n`,
    );
    const mismatched = runVersionCli(["--check"], { root });
    assert.equal(mismatched.exitCode, 1);
    assert.equal(mismatched.stderr, "");
    assert.deepEqual(JSON.parse(mismatched.stdout), {
      command: "check",
      mismatches: ["apps/server/package.json: version must equal gauntlet 0.1.0"],
      ok: false,
      plan: null,
      units: [],
      version: "0.1.0",
    });

    writeFixtureFile(
      root,
      "apps/server/package.json",
      `${JSON.stringify({ name: "@8lines/gauntlet-server", version: "0.1.0" })}\n`,
    );
    const set = runVersionCli(["--set", "0.1.1"], { root });
    assert.equal(set.exitCode, 0);
    assert.equal(set.stderr, "");
    assert.deepEqual(JSON.parse(set.stdout), {
      changedPaths: EXPECTED_UPDATE_PATHS,
      command: "set",
      ok: true,
      version: "0.1.1",
    });
    assert.deepEqual(collectVersionMismatches(root), []);
  });

  const invalid = runVersionCli(["--root", "/tmp/SECRET_ROOT"], { root: "/does/not/exist" });
  assert.equal(invalid.exitCode, 2);
  assert.equal(invalid.stdout, "");
  assert.deepEqual(JSON.parse(invalid.stderr), {
    error: { code: "INVALID_ARGUMENTS", message: "Usage: version.mjs --check [--plan PATH] | --set X.Y.Z | --set-unit UNIT X.Y.Z" },
    ok: false,
  });
  assert.doesNotMatch(invalid.stderr, /SECRET_ROOT/);
  assert.equal(invalid.stderr.split("\n").length, 2);
});

test("a slot is checked against its own unit", () => {
  const root = createVersionFixture("0.1.8");
  try {
    writeFixtureFile(
      root,
      "packages/php/core/composer.json",
      `${JSON.stringify({ name: "8lines/gauntlet-php-core", version: "0.1.9", require: { php: ">=8.5" } }, null, 2)}\n`,
    );
    // Only php-core moved: its three consumers follow it, while the symfony-bundle key in the
    // php-symfony consumer and the starter/core Java slots stay with their own unit.
    assert.deepEqual(collectUnitVersionMismatches(root), [
      "packages/php/symfony-bundle/composer.json: require.8lines/gauntlet-php-core must equal ^0.1.9",
      "tests/consumers/php-core/composer.json: require.8lines/gauntlet-php-core must equal php-core 0.1.9",
      "tests/consumers/php-symfony/composer.json: require.8lines/gauntlet-php-core must equal php-core 0.1.9",
      "skills/gauntlet-app-integration/references/symfony.md: release references must equal php-core 0.1.9",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the Symfony reference names each PHP package's own exact version", () => {
  const root = createVersionFixture("0.1.8");
  try {
    const result = setUnitVersions(root, { "symfony-bundle": "0.2.0" });
    assert.deepEqual(result.changedPaths, [
      "packages/php/symfony-bundle/composer.json",
      "tests/consumers/php-symfony/composer.json",
      "skills/gauntlet-app-integration/references/symfony.md",
    ]);
    assert.deepEqual(collectUnitVersionMismatches(root), []);
    assert.match(
      readFileSync(join(root, "skills/gauntlet-app-integration/references/symfony.md"), "utf8"),
      /install exact release `0\.1\.8` of `8lines\/gauntlet-php-core` and exact release `0\.2\.0` of `8lines\/gauntlet-symfony-bundle`/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Java core move changes only the lockfile core slot, never the starter slots", () => {
  const root = createVersionFixture("0.1.8");
  try {
    writeFixtureFile(root, "packages/java/core/VERSION", "0.1.9\n");
    // The starter slots in build.gradle.kts, gradle.lockfile and spring.md stay bound to spring-boot-starter.
    assert.deepEqual(collectUnitVersionMismatches(root), [
      "tests/consumers/java/gradle.lockfile: release references must equal java-core 0.1.9",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a unit that moves alone reports only its own slots", () => {
  const root = createVersionFixture("0.1.8");
  try {
    writeFixtureFile(root, "skills/VERSION", "0.1.9\n");
    assert.deepEqual(collectUnitVersionMismatches(root), [
      "docs/ai-skills.md: release references must equal skills 0.1.9",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("diverged units are consistent once lockstep releases end", () => {
  assert.equal(LOCKSTEP_RELEASES, false);
  const root = createVersionFixture("0.1.8");
  try {
    setUnitVersions(root, { skills: "0.1.9", "php-core": "0.2.0" });
    assert.deepEqual(collectVersionMismatches(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable unit version file is reported once and does not cascade", () => {
  const root = createVersionFixture("0.1.8");
  try {
    rmSync(join(root, "packages/java/core/VERSION"));
    assert.deepEqual(collectVersionMismatches(root), [
      "packages/java/core/VERSION: canonical release version is missing or invalid",
    ]);
    writeFixtureFile(root, "packages/java/core/VERSION", "0.1.8\n");
    writeFixtureFile(root, "packages/protocol/package.json", `${JSON.stringify({ name: "@8lines/gauntlet-protocol", version: "1.0" })}\n`);
    assert.deepEqual(collectVersionMismatches(root), [
      "packages/protocol/package.json: version must be a stable release version",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setReleaseVersion moves every unit and the new VERSION files together", () => {
  const root = createVersionFixture("0.1.8");
  try {
    const result = setReleaseVersion(root, "0.1.9");
    assert.deepEqual(result.changedPaths, EXPECTED_UPDATE_PATHS);
    assert.deepEqual(collectVersionMismatches(root), []);
    for (const path of ["VERSION", ...UNIT_VERSION_FILES]) {
      assert.equal(readFileSync(join(root, path), "utf8"), "0.1.9\n", path);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setReleaseVersion moves every unit from its own version", () => {
  const root = createVersionFixture("0.1.8");
  try {
    setUnitVersions(root, { "java-core": "0.1.9" });
    setReleaseVersion(root, "0.1.10");
    assert.deepEqual(collectVersionMismatches(root), []);
    for (const id of ["gauntlet", "java-core", "spring-boot-starter", "skills"]) assert.equal(readUnitVersion(root, id), "0.1.10", id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the version check validates a plan instead of a tag", () => {
  const root = createVersionFixture("0.1.8");
  try {
    setUnitVersions(root, { widget: "0.1.9" });
    mkdirSync(join(root, ".release"));
    writeFileSync(join(root, ".release/plan.json"), serializeReleasePlan(createReleasePlan([{ id: "widget", from: "0.1.8", to: "0.1.9" }])));
    const ok = JSON.parse(runVersionCli(["--check", "--plan", ".release/plan.json"], { root }).stdout);
    assert.deepEqual([ok.ok, ok.plan, ok.mismatches], [true, ".release/plan.json", []]);
    writeFileSync(join(root, ".release/plan.json"), serializeReleasePlan(createReleasePlan([{ id: "widget", from: "0.1.8", to: "0.2.0" }])));
    const drifted = runVersionCli(["--check", "--plan", ".release/plan.json"], { root });
    assert.equal(drifted.exitCode, 1);
    assert.deepEqual(JSON.parse(drifted.stdout).mismatches, ["plan: widget: plan version 0.2.0 does not equal manifest version 0.1.9"]);
    assert.equal(runVersionCli(["--check", "--tag", "v0.1.8"], { root }).exitCode, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable plan is a version check mismatch", () => {
  const root = createVersionFixture("0.1.8");
  try {
    const missing = runVersionCli(["--check", "--plan", ".release/plan.json"], { root });
    assert.equal(missing.exitCode, 1);
    assert.equal(missing.stderr, "");
    assert.deepEqual(JSON.parse(missing.stdout), {
      command: "check",
      mismatches: ["plan: Release plan is missing or unsafe"],
      ok: false,
      plan: ".release/plan.json",
      units: [],
      version: "0.1.8",
    });
    const outside = runVersionCli(["--check", "--plan", "../SECRET_PLAN.json"], { root });
    assert.equal(outside.exitCode, 1);
    assert.deepEqual(JSON.parse(outside.stdout).mismatches, ["plan: Release plan path must stay inside the repository"]);
    mkdirSync(join(root, ".release"));
    writeFileSync(join(root, ".release/plan.json"), '{"schemaVersion":1,"units":"SECRET_VALUE","order":[]}\n');
    const invalid = runVersionCli(["--check", "--plan", ".release/plan.json"], { root });
    assert.equal(invalid.exitCode, 1);
    assert.deepEqual(JSON.parse(invalid.stdout).mismatches, ["plan: Release plan is invalid"]);
    assert.doesNotMatch(invalid.stdout, /SECRET_VALUE/);
    writeFileSync(join(root, ".release/plan.json"), serializeReleasePlan(createReleasePlan([{ id: "widget", from: "0.1.8", to: "0.1.9" }])));
    rmSync(join(root, "skills/VERSION"));
    const unreadableUnit = runVersionCli(["--check", "--plan", ".release/plan.json"], { root });
    assert.equal(unreadableUnit.exitCode, 1);
    assert.equal(unreadableUnit.stderr, "");
    assert.deepEqual(JSON.parse(unreadableUnit.stdout).mismatches, ["skills/VERSION: canonical release version is missing or invalid"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setUnitVersions moves one unit and every slot bound to it, and nothing else", () => {
  const root = createVersionFixture("0.1.8");
  try {
    const result = setUnitVersions(root, new Map([["php-core", "0.2.0"]]));
    assert.deepEqual(result, {
      versions: { "php-core": "0.2.0" },
      changedPaths: [
        "packages/php/core/composer.json",
        "packages/php/symfony-bundle/composer.json",
        "tests/consumers/php-core/composer.json",
        "tests/consumers/php-symfony/composer.json",
        "skills/gauntlet-app-integration/references/symfony.md",
      ],
    });
    assert.deepEqual(collectUnitVersionMismatches(root), []);
    assert.equal(readUnitVersion(root, "php-core"), "0.2.0");
    assert.equal(readUnitVersion(root, "symfony-bundle"), "0.1.8");
    const bundle = JSON.parse(readFileSync(join(root, "packages/php/symfony-bundle/composer.json"), "utf8"));
    assert.equal(bundle.version, "0.1.8");
    assert.equal(bundle.require["8lines/gauntlet-php-core"], "^0.2.0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setUnitVersions moves the application and the skills archive slots independently", () => {
  const root = createVersionFixture("0.1.8");
  try {
    assert.deepEqual(setUnitVersions(root, { gauntlet: "0.1.9" }).changedPaths, [
      "apps/dashboard/package.json",
      "apps/server/package.json",
      "deploy/helm/gauntlet/Chart.yaml",
      "deploy/helm/gauntlet/values.yaml",
      "deploy/compose/.env.example",
      "skills/gauntlet-app-integration/references/deployment.md",
      "skills/gauntlet-app-integration/references/safety-gates.md",
      "VERSION",
    ]);
    assert.deepEqual(setUnitVersions(root, { skills: "0.1.9" }).changedPaths, [
      "docs/ai-skills.md",
      "skills/VERSION",
    ]);
    assert.deepEqual(collectUnitVersionMismatches(root), []);
    assert.equal(readUnitVersion(root, "protocol"), "0.1.8");
    assert.equal(readUnitVersion(root, "gauntlet"), "0.1.9");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setUnitVersions rejects unknown units, invalid versions and inconsistent repositories before writing", () => {
  const root = createVersionFixture("0.1.8");
  try {
    const before = fixtureSnapshot(root);
    for (const requested of [new Map(), { nope: "0.1.9" }, { widget: "0.1.9-rc.1" }, [["widget", "0.1.9"]]]) {
      assert.throws(() => setUnitVersions(root, requested));
    }
    assert.deepEqual(fixtureSnapshot(root), before);
    writeFixtureFile(root, "skills/gauntlet-app-integration/references/symfony.md",
      readFileSync(join(root, "skills/gauntlet-app-integration/references/symfony.md"), "utf8").replace("`0.1.8`", "`0.1.7`"));
    const inconsistent = fixtureSnapshot(root);
    assert.throws(() => setUnitVersions(root, { widget: "0.1.9" }), /preflight failed/u);
    assert.equal(readUnitVersion(root, "widget"), "0.1.8");
    assert.deepEqual(fixtureSnapshot(root), inconsistent);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the version CLI sets one unit", () => {
  const root = createVersionFixture("0.1.8");
  try {
    const result = runVersionCli(["--set-unit", "widget", "0.2.0"], { root });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      changedPaths: ["packages/widget/package.json"], command: "set-unit", ok: true, unit: "widget", version: "0.2.0",
    });
    for (const argv of [["--set-unit", "nope", "0.2.0"], ["--set-unit", "widget"], ["--set-unit", "widget", "v0.2.0"]]) {
      assert.equal(runVersionCli(argv, { root }).exitCode, 2, argv.join(" "));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
