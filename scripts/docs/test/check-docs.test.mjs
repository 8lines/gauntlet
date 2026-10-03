import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";

import { checkDocumentation } from "../check-docs.mjs";
import { fixture } from "./support.mjs";

test("reports missing files, broken local links, stale claims, and unsafe coordinates", async (t) => {
  const root = await fixture({
    "README.md": [
      "# Gauntlet",
      "[missing](docs/missing.md)",
      "[escape](../outside.md)",
      "Future dashboard",
      "image: latest",
      "npm add @8lines/gauntlet-protocol",
      "",
    ].join("\n"),
    "docs/documentation-manifest.json": `${JSON.stringify({
      schemaVersion: 1,
      requiredFiles: ["README.md", "SECURITY.md"],
      forbiddenPhrases: ["Future dashboard", "image: latest"],
      requiredPhrases: ["authentication is deferred"],
    })}\n`,
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const { errors } = await checkDocumentation({ root });
  assert.deepEqual(errors, [
    "README.md contains forbidden phrase: Future dashboard",
    "README.md contains forbidden phrase: image: latest",
    "README.md contains unversioned Gauntlet package install",
    "README.md links outside the repository: ../outside.md",
    "README.md links to missing docs/missing.md",
    "missing required file SECURITY.md",
    "required phrase is absent: authentication is deferred",
  ]);
});

test("accepts anchors, external links, encoded local paths, and exact release versions", async (t) => {
  const root = await fixture({
    "README.md": [
      "# Gauntlet",
      "authentication is deferred",
      "[guide](docs/Guide%20One.md#start)",
      "[web](https://example.invalid/test)",
      "`pnpm add @8lines/gauntlet-protocol@0.1.0`",
      "`ghcr.io/8lines/gauntlet:0.1.0`",
      "",
    ].join("\n"),
    "docs/Guide One.md": "# Start\n",
    "docs/documentation-manifest.json": `${JSON.stringify({
      schemaVersion: 1,
      requiredFiles: ["README.md", "docs/Guide One.md"],
      forbiddenPhrases: ["future dashboard"],
      requiredPhrases: ["authentication is deferred"],
    })}\n`,
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.deepEqual(await checkDocumentation({ root }), { errors: [] });
});

test("rejects malformed and open documentation manifests", async (t) => {
  for (const manifest of [
    {},
    { schemaVersion: 1, requiredFiles: [], forbiddenPhrases: [], requiredPhrases: [], extra: true },
    { schemaVersion: 2, requiredFiles: ["README.md"], forbiddenPhrases: [], requiredPhrases: [] },
  ]) {
    const root = await fixture({
      "README.md": "# Test\n",
      "docs/documentation-manifest.json": `${JSON.stringify(manifest)}\n`,
    });
    t.after(() => rm(root, { recursive: true, force: true }));
    await assert.rejects(checkDocumentation({ root }), { message: "Documentation manifest is invalid" });
  }
});

test("rejects snapshot, ranged, and scalar released SDK examples", async (t) => {
  const root = await fixture({
    VERSION: "0.1.0\n",
    "packages/java/README.md": [
      "`dev.eightlines.gauntlet:core:0.1.0-SNAPSHOT`",
      "`dev.eightlines.gauntlet:spring-boot-starter:0.1.0`",
      "gauntlet:",
      "  application:",
      "    environment: staging",
      "",
    ].join("\n"),
    "packages/java/spring-boot-starter/README.md": [
      "`dev.eightlines.gauntlet:spring-boot-starter:0.1.0-SNAPSHOT`",
      "gauntlet:",
      "  application:",
      "    environment: staging",
      "",
    ].join("\n"),
    "packages/php/symfony-bundle/README.md": [
      "\"8lines/gauntlet-php-core\": \"^0.1.0\"",
      "\"8lines/gauntlet-symfony-bundle\": \"^0.1.0\"",
      "composer require 8lines/gauntlet-php-core:^0.1.0 8lines/gauntlet-symfony-bundle:^0.1.0",
      "gauntlet:",
      "  application:",
      "    environment: '%kernel.environment%'",
      "",
    ].join("\n"),
    "docs/documentation-manifest.json": `${JSON.stringify({
      schemaVersion: 1,
      requiredFiles: [
        "packages/java/README.md",
        "packages/java/spring-boot-starter/README.md",
        "packages/php/symfony-bundle/README.md",
      ],
      forbiddenPhrases: [],
      requiredPhrases: [],
    })}\n`,
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.deepEqual((await checkDocumentation({ root })).errors, [
    "packages/java/README.md contains a snapshot Java consumer coordinate",
    "packages/java/README.md must document application.environment with name and kind",
    "packages/java/spring-boot-starter/README.md contains a snapshot Java consumer coordinate",
    "packages/java/spring-boot-starter/README.md must document application.environment with name and kind",
    "packages/php/symfony-bundle/README.md contains a non-exact Composer consumer coordinate",
    "packages/php/symfony-bundle/README.md must document application.environment with name and kind",
  ]);
});

test("accepts exact released SDK coordinates and structured environments", async (t) => {
  const root = await fixture({
    VERSION: "0.1.0\n",
    "packages/java/README.md": [
      "`dev.eightlines.gauntlet:core:0.1.0`",
      "`dev.eightlines.gauntlet:spring-boot-starter:0.1.0`",
      "gauntlet:",
      "  application:",
      "    environment:",
      "      name: fixture-staging",
      "      kind: staging",
      "",
    ].join("\n"),
    "packages/java/spring-boot-starter/README.md": [
      "implementation(\"dev.eightlines.gauntlet:spring-boot-starter:0.1.0\")",
      "gauntlet:",
      "  application:",
      "    environment:",
      "      name: fixture-test",
      "      kind: test",
      "",
    ].join("\n"),
    "packages/php/symfony-bundle/README.md": [
      "\"8lines/gauntlet-php-core\": \"0.1.0\"",
      "\"8lines/gauntlet-symfony-bundle\": \"0.1.0\"",
      "composer require 8lines/gauntlet-php-core:0.1.0 8lines/gauntlet-symfony-bundle:0.1.0",
      "gauntlet:",
      "  application:",
      "    environment:",
      "      name: fixture-uat",
      "      kind: uat",
      "",
    ].join("\n"),
    "docs/documentation-manifest.json": `${JSON.stringify({
      schemaVersion: 1,
      requiredFiles: [
        "packages/java/README.md",
        "packages/java/spring-boot-starter/README.md",
        "packages/php/symfony-bundle/README.md",
      ],
      forbiddenPhrases: [],
      requiredPhrases: [],
    })}\n`,
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.deepEqual(await checkDocumentation({ root }), { errors: [] });
});

test("rejects released SDK guides with required consumer coordinates removed", async (t) => {
  const structuredEnvironment = [
    "gauntlet:",
    "  application:",
    "    environment:",
    "      name: fixture-staging",
    "      kind: staging",
    "",
  ].join("\n");
  const root = await fixture({
    VERSION: "0.1.0\n",
    "packages/java/README.md": structuredEnvironment,
    "packages/java/spring-boot-starter/README.md": structuredEnvironment,
    "packages/php/symfony-bundle/README.md": structuredEnvironment,
    "docs/documentation-manifest.json": `${JSON.stringify({
      schemaVersion: 1,
      requiredFiles: [
        "packages/java/README.md",
        "packages/java/spring-boot-starter/README.md",
        "packages/php/symfony-bundle/README.md",
      ],
      forbiddenPhrases: [],
      requiredPhrases: [],
    })}\n`,
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.deepEqual((await checkDocumentation({ root })).errors, [
    "packages/java/README.md is missing Java consumer coordinate dev.eightlines.gauntlet:core:0.1.0",
    "packages/java/README.md is missing Java consumer coordinate dev.eightlines.gauntlet:spring-boot-starter:0.1.0",
    "packages/java/spring-boot-starter/README.md is missing Java consumer coordinate dev.eightlines.gauntlet:spring-boot-starter:0.1.0",
    "packages/php/symfony-bundle/README.md is missing Composer consumer coordinate 8lines/gauntlet-php-core:0.1.0",
    "packages/php/symfony-bundle/README.md is missing Composer consumer coordinate 8lines/gauntlet-symfony-bundle:0.1.0",
  ]);
});

const UNIT_VERSION_FILES = Object.freeze({
  "VERSION": "0.1.0\n",
  "packages/java/core/VERSION": "0.1.0\n",
  "packages/java/spring-boot-starter/VERSION": "0.1.0\n",
  ...Object.fromEntries([
    "packages/protocol",
    "packages/dashboard-client",
    "packages/typescript/core",
    "packages/typescript/node",
    "packages/typescript/next",
    "conformance/runner",
    "packages/widget",
    "packages/php/core",
    "packages/php/symfony-bundle",
  ].map((directory) => [
    `${directory}/${directory.startsWith("packages/php/") ? "composer" : "package"}.json`,
    `${JSON.stringify({ name: "fixture", version: "0.1.0" })}\n`,
  ])),
});

function unitFixture(files, overrides = {}) {
  return fixture({
    ...UNIT_VERSION_FILES,
    ...overrides,
    ...files,
    "docs/documentation-manifest.json": `${JSON.stringify({
      schemaVersion: 1,
      requiredFiles: Object.keys(files),
      forbiddenPhrases: [],
      requiredPhrases: [],
    })}\n`,
  });
}

const PROTOCOL_AHEAD = {
  "packages/protocol/package.json": `${JSON.stringify({ name: "fixture", version: "0.1.1" })}\n`,
};

test("compares each documented npm package with its own release unit", async (t) => {
  const root = await unitFixture({
    "README.md": "`pnpm add @8lines/gauntlet-protocol@0.1.1 @8lines/gauntlet-typescript-core@0.1.0`\n",
  }, PROTOCOL_AHEAD);
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.deepEqual(await checkDocumentation({ root }), { errors: [] });
});

test("rejects a package version that belongs to a different release unit", async (t) => {
  const root = await unitFixture({
    "README.md": "`pnpm add @8lines/gauntlet-protocol@0.1.0 @8lines/gauntlet-typescript-core@0.1.1`\n",
  }, PROTOCOL_AHEAD);
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.deepEqual((await checkDocumentation({ root })).errors, [
    "README.md contains mismatched Gauntlet package version: 0.1.0",
    "README.md contains mismatched Gauntlet package version: 0.1.1",
  ]);
});

test("compares the application image with the gauntlet unit and rejects unknown packages", async (t) => {
  const root = await unitFixture({
    "README.md": [
      "`ghcr.io/8lines/gauntlet:0.1.1`",
      "`pnpm add @8lines/gauntlet-nonexistent@0.1.0`",
      "",
    ].join("\n"),
  }, PROTOCOL_AHEAD);
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.deepEqual((await checkDocumentation({ root })).errors, [
    "README.md contains mismatched Gauntlet image version: 0.1.1",
    "README.md contains unknown Gauntlet package: @8lines/gauntlet-nonexistent",
  ]);
});

test("compares Maven and Composer coordinates with their own release units", async (t) => {
  const environment = [
    "gauntlet:",
    "  application:",
    "    environment:",
    "      name: fixture-staging",
    "      kind: staging",
    "",
  ].join("\n");
  const files = (javaCore, bundle) => ({
    "packages/java/README.md": [
      `\`dev.eightlines.gauntlet:core:${javaCore}\``,
      "`dev.eightlines.gauntlet:spring-boot-starter:0.1.2`",
      environment,
    ].join("\n"),
    "packages/php/symfony-bundle/README.md": [
      "\"8lines/gauntlet-php-core\": \"0.1.0\"",
      `"8lines/gauntlet-symfony-bundle": "${bundle}"`,
      environment,
    ].join("\n"),
  });
  const overrides = {
    "packages/java/spring-boot-starter/VERSION": "0.1.2\n",
    "packages/php/symfony-bundle/composer.json": `${JSON.stringify({ name: "fixture", version: "0.1.3" })}\n`,
  };

  const accepted = await unitFixture(files("0.1.0", "0.1.3"), overrides);
  t.after(() => rm(accepted, { recursive: true, force: true }));
  assert.deepEqual(await checkDocumentation({ root: accepted }), { errors: [] });

  const rejected = await unitFixture(files("0.1.1", "0.1.0"), overrides);
  t.after(() => rm(rejected, { recursive: true, force: true }));
  assert.deepEqual((await checkDocumentation({ root: rejected })).errors, [
    "packages/java/README.md contains a non-exact Java consumer coordinate",
    "packages/php/symfony-bundle/README.md contains a non-exact Composer consumer coordinate",
  ]);
});
