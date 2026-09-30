import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "../../..");

function manifest(path) {
  return JSON.parse(readFileSync(resolve(ROOT, path), "utf8"));
}

test("direct dependencies pin the first patched Playwright and YAML releases", () => {
  assert.equal(manifest("apps/dashboard/package.json").devDependencies["@playwright/test"], "1.55.1");
  assert.equal(manifest("package.json").devDependencies.yaml, "2.8.3");
  assert.equal(manifest("apps/server/package.json").dependencies.yaml, "2.8.3");
  assert.equal(manifest("packages/protocol/package.json").devDependencies.yaml, "2.8.3");
  assert.match(readFileSync(resolve(ROOT, "scripts/release/stage-npm.mjs"), "utf8"), /yaml: "2\.8\.3"/u);
});

test("the pnpm lock contains no vulnerable Playwright or YAML versions", () => {
  const lock = readFileSync(resolve(ROOT, "pnpm-lock.yaml"), "utf8");
  assert.doesNotMatch(lock, /(?:playwright(?:-core)?|@playwright\/test)@1\.55\.0/gu);
  assert.doesNotMatch(lock, /yaml@2\.8\.1/gu);
  assert.match(lock, /@playwright\/test@1\.55\.1/u);
  assert.match(lock, /yaml@2\.8\.3/u);
});

test("Java dependency constraints and locks use the first Trivy-patched releases", () => {
  const coreBuild = readFileSync(resolve(ROOT, "packages/java/core/build.gradle.kts"), "utf8");
  assert.match(coreBuild, /implementation\("tools\.jackson\.core:jackson-core:3\.1\.7"\)/u);
  assert.match(coreBuild, /implementation\("tools\.jackson\.core:jackson-databind:3\.1\.7"\)/u);

  const starterBuild = readFileSync(resolve(ROOT, "packages/java/spring-boot-starter/build.gradle.kts"), "utf8");
  for (const module of ["core", "el", "websocket"]) {
    assert.match(starterBuild, new RegExp(`api\\("org\\.apache\\.tomcat\\.embed:tomcat-embed-${module}:11\\.0\\.25"\\)`, "u"));
  }
  assert.match(starterBuild, /api\(platform\("tools\.jackson:jackson-bom:3\.1\.7"\)\)/u);

  const mavenStager = readFileSync(resolve(ROOT, "scripts/release/stage-maven.mjs"), "utf8");
  assert.equal((mavenStager.match(/"requires":"3\.1\.7"/gu) ?? []).length, 2);
  assert.doesNotMatch(mavenStager, /"requires":"3\.1\.6"/u);

  const mavenInspector = readFileSync(resolve(ROOT, "scripts/release/inspect-jdk.mjs"), "utf8");
  assert.equal((mavenInspector.match(/jackson-(?:core|databind|bom):3\.1\.7/gu) ?? []).length, 3);
  assert.doesNotMatch(mavenInspector, /jackson-(?:core|databind|bom):3\.1\.6/u);

  for (const path of [
    "packages/java/core/gradle.lockfile",
    "packages/java/spring-boot-starter/gradle.lockfile",
    "packages/java/spring-example/gradle.lockfile",
    "packages/java/starter-api-consumer-test/gradle.lockfile",
    "tests/consumers/java/gradle.lockfile",
  ]) {
    const lock = readFileSync(resolve(ROOT, path), "utf8");
    for (const module of ["core:jackson-core", "core:jackson-databind"]) {
      assert.match(lock, new RegExp(`^tools\\.jackson\\.${module}:3\\.1\\.7=`, "mu"), path);
    }
    assert.doesNotMatch(lock, /^tools\.jackson(?:\.[a-z]+)?:jackson-[a-z-]+:3\.1\.[0-6]=/mu, path);
    if (path === "packages/java/core/gradle.lockfile") continue;
    for (const module of ["core", "el", "websocket"]) {
      assert.match(lock, new RegExp(`^org\\.apache\\.tomcat\\.embed:tomcat-embed-${module}:11\\.0\\.25=`, "mu"), path);
      assert.doesNotMatch(lock, new RegExp(`^org\\.apache\\.tomcat\\.embed:tomcat-embed-${module}:11\\.0\\.24=`, "mu"), path);
    }
  }
});

test("both PHP images declare an owned non-root runtime", () => {
  const expectations = [
    ["examples/symfony/Dockerfile", "/tmp/gauntlet-symfony-example"],
    ["packages/php/Dockerfile", "/workspace"],
  ];
  for (const [path, writableDirectory] of expectations) {
    const dockerfile = readFileSync(resolve(ROOT, path), "utf8");
    assert.match(dockerfile, new RegExp(`(?:chown|install)[^\\n]*www-data[^\\n]*${writableDirectory.replaceAll("/", "\\/")}`, "u"), path);
    assert.match(dockerfile, /^USER www-data:www-data$/mu, path);
    assert.equal(dockerfile.lastIndexOf("USER www-data:www-data") > dockerfile.lastIndexOf("RUN "), true, path);
  }
});
