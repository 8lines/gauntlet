import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderUnitVersionTable } from "../release-model.mjs";
import { RELEASE_UNITS } from "../units.mjs";

export const RELEASE_TEXT_PATHS = [
  "tests/consumers/java/build.gradle.kts",
  "tests/consumers/java/gradle.lockfile",
  "skills/gauntlet-app-integration/references/node.md",
  "skills/gauntlet-app-integration/references/nextjs.md",
  "skills/gauntlet-app-integration/references/symfony.md",
  "skills/gauntlet-app-integration/references/spring.md",
  "skills/gauntlet-app-integration/references/deployment.md",
  "skills/gauntlet-app-integration/references/safety-gates.md",
  "docs/ai-skills.md",
  "deploy/helm/README.md",
  "docs/releases/installing-packages.md",
  "docs/integrations/index.md",
  "docs/integrations/widget.md",
  "conformance/runner/README.md",
  "packages/java/README.md",
  "packages/java/core/README.md",
  "packages/java/spring-boot-starter/README.md",
  "packages/php/symfony-bundle/README.md",
  "packages/typescript/core/README.md",
];

// Each release-text file with the units whose slots it holds, in first-appearance order, and the slot count per unit.
export const RELEASE_TEXT_UNITS = [
  ["tests/consumers/java/build.gradle.kts", [["spring-boot-starter", 1]]],
  ["tests/consumers/java/gradle.lockfile", [["java-core", 1], ["spring-boot-starter", 1]]],
  ["skills/gauntlet-app-integration/references/node.md", [["protocol", 1], ["typescript-core", 1], ["typescript-node", 1]]],
  ["skills/gauntlet-app-integration/references/nextjs.md", [["protocol", 1], ["typescript-core", 1], ["next-adapter", 1]]],
  ["skills/gauntlet-app-integration/references/symfony.md", [["php-core", 1], ["symfony-bundle", 1]]],
  ["skills/gauntlet-app-integration/references/spring.md", [["spring-boot-starter", 3]]],
  ["skills/gauntlet-app-integration/references/deployment.md", [["gauntlet", 3]]],
  ["skills/gauntlet-app-integration/references/safety-gates.md", [["gauntlet", 1]]],
  ["docs/ai-skills.md", [["skills", 3]]],
  ["deploy/helm/README.md", [["gauntlet", 9]]],
  ["docs/releases/installing-packages.md", [
    ["protocol", 2], ["typescript-core", 2], ["typescript-node", 2], ["symfony-bundle", 2], ["php-core", 2],
    ["java-core", 2], ["spring-boot-starter", 2], ["gauntlet", 4], ["dashboard-client", 1], ["next-adapter", 1],
    ["conformance-runner", 1], ["widget", 1], ["skills", 1],
  ]],
  ["docs/integrations/index.md", [
    ["typescript-core", 2], ["typescript-node", 1], ["next-adapter", 1], ["php-core", 1], ["symfony-bundle", 1],
    ["java-core", 1], ["spring-boot-starter", 1],
  ]],
  ["docs/integrations/widget.md", [["widget", 1]]],
  ["conformance/runner/README.md", [["conformance-runner", 3]]],
  ["packages/java/README.md", [["java-core", 1], ["spring-boot-starter", 2]]],
  ["packages/java/core/README.md", [["java-core", 2]]],
  ["packages/java/spring-boot-starter/README.md", [["spring-boot-starter", 2]]],
  ["packages/php/symfony-bundle/README.md", [["php-core", 1], ["symfony-bundle", 1]]],
  ["packages/typescript/core/README.md", [["protocol", 3], ["typescript-core", 2]]],
];

export const EXPECTED_UPDATE_PATHS = [
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
  "examples/symfony/composer.json",
  ...RELEASE_TEXT_PATHS,
  "packages/java/core/VERSION",
  "packages/java/spring-boot-starter/VERSION",
  "skills/VERSION",
  "VERSION",
];

export const PACKAGE_IDENTITIES = [
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

export const UNIT_VERSION_FILES = [
  "packages/java/core/VERSION",
  "packages/java/spring-boot-starter/VERSION",
  "skills/VERSION",
];

export const GRADLE_VERSION_DERIVATION = `import java.nio.charset.StandardCharsets

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

export function writeFixtureFile(root, relativePath, contents, mode = 0o644) {
  const path = join(root, relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents, { mode });
}

export function releaseTextFixtures(version) {
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
    [
      "deploy/helm/README.md",
      `The example uses the exact \`${version}\` application tag: stable tags are versioned.\n\n`
        + `image:\n  repository: ghcr.io/8lines/gauntlet\n  tag: "${version}"\n\n`
        + `Pull the exact \`${version}\` chart to a local immutable input.\n\n`
        + `helm pull oci://ghcr.io/8lines/charts/gauntlet --version ${version} --destination .\n`
        + `helm template gauntlet ./gauntlet-${version}.tgz \\\n  -f values.yaml\n`
        + `helm upgrade --install gauntlet ./gauntlet-${version}.tgz \\\n  -f values.yaml\n`
        + `helm pull oci://ghcr.io/8lines/charts/gauntlet --version ${version} --destination .\n`
        + `helm template gauntlet ./gauntlet-${version}.tgz \\\n  -f values.yaml\n`
        + `helm upgrade gauntlet ./gauntlet-${version}.tgz \\\n  -f values.yaml\n`,
    ],
    [
      "docs/releases/installing-packages.md",
      `${renderUnitVersionTable(new Map(RELEASE_UNITS.map(({ id }) => [id, version])))}\n`
        + `pnpm add @8lines/gauntlet-protocol@${version} \\\n  @8lines/gauntlet-typescript-core@${version} \\\n  @8lines/gauntlet-typescript-node@${version}\n`
        + `composer require 8lines/gauntlet-symfony-bundle:${version}\n`
        + `For a framework-neutral integration, require \`8lines/gauntlet-php-core:${version}\` alone.\n`
        + `dev.eightlines.gauntlet:core:${version}\ndev.eightlines.gauntlet:spring-boot-starter:${version}\n`
        + `docker pull ghcr.io/8lines/gauntlet:${version}\nhelm pull oci://ghcr.io/8lines/charts/gauntlet --version ${version}\n`
        + `Pull the Helm chart at exact version \`${version}\`, render that local archive, and install the same bytes.\n`,
    ],
    [
      "docs/integrations/index.md",
      `| Native Node.js 24–26 | \`@8lines/gauntlet-typescript-core@${version}\` and \`@8lines/gauntlet-typescript-node@${version}\` | Node |\n`
        + `| Next.js App Router on Node.js 24–26 | \`@8lines/gauntlet-typescript-core@${version}\` and \`@8lines/gauntlet-next-adapter@${version}\` | Next.js |\n`
        + `| PHP 8.3+ | \`8lines/gauntlet-php-core\` at \`${version}\` | PHP |\n`
        + `| Symfony 7.4 | PHP Core and \`8lines/gauntlet-symfony-bundle\` at \`${version}\` | Symfony |\n`
        + `| Java 21 | \`dev.eightlines.gauntlet:core:${version}\` | Java |\n`
        + `| Spring Boot on Java 21 | Core and \`dev.eightlines.gauntlet:spring-boot-starter:${version}\` | Spring |\n`,
    ],
    ["docs/integrations/widget.md", `npm install @8lines/gauntlet-widget@${version}\n`],
    [
      "conformance/runner/README.md",
      ["", "-fixture", "-extended"]
        .map((suffix) => `pnpm dlx --package @8lines/gauntlet-conformance-runner@${version} gauntlet-conformance${suffix} \\\n  --target local\n`)
        .join(""),
    ],
    [
      "packages/java/README.md",
      `- \`dev.eightlines.gauntlet:core:${version}\` — Java 21 protocol models\n`
        + `- \`dev.eightlines.gauntlet:spring-boot-starter:${version}\` — Spring Boot auto-configuration\n`
        + `    implementation("dev.eightlines.gauntlet:spring-boot-starter:${version}")\n`,
    ],
    [
      "packages/java/core/README.md",
      `\`dev.eightlines.gauntlet:core:${version}\` is the framework-neutral Java 21 core.\n`
        + `    implementation("dev.eightlines.gauntlet:core:${version}")\n`,
    ],
    [
      "packages/java/spring-boot-starter/README.md",
      `\`dev.eightlines.gauntlet:spring-boot-starter:${version}\` is the Java 21 and Spring Boot starter.\n`
        + `    implementation("dev.eightlines.gauntlet:spring-boot-starter:${version}")\n`,
    ],
    [
      "packages/php/symfony-bundle/README.md",
      `composer require 8lines/gauntlet-php-core:${version} \\\n  8lines/gauntlet-symfony-bundle:${version}\n`,
    ],
    [
      "packages/typescript/core/README.md",
      `pnpm add @8lines/gauntlet-protocol@${version} \\\n  @8lines/gauntlet-typescript-core@${version}\n`
        + `"@8lines/gauntlet-protocol": "file:/tmp/gauntlet-packages/8lines-gauntlet-protocol-${version}.tgz",\n`
        + `"@8lines/gauntlet-typescript-core": "file:/tmp/gauntlet-packages/8lines-gauntlet-typescript-core-${version}.tgz"\n`
        + `'@8lines/gauntlet-protocol': 'file:/tmp/gauntlet-packages/8lines-gauntlet-protocol-${version}.tgz'\n`,
    ],
  ]);
}

export function writeReleaseTextFixtures(root, version) {
  for (const [path, contents] of releaseTextFixtures(version)) writeFixtureFile(root, path, contents);
}

export function writeConsumerJsonFixtures(root, version) {
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
  writeFixtureFile(root, "examples/symfony/composer.json", `${JSON.stringify({
    name: "8lines/gauntlet-symfony-example",
    require: {
      "8lines/gauntlet-php-core": `^${version}`,
      "8lines/gauntlet-symfony-bundle": `^${version}`,
    },
  }, null, 2)}\n`);
}

export function createVersionFixture(version = "0.1.0") {
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
