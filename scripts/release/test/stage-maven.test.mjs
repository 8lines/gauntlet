import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { MAVEN_TOOLCHAIN, MAVEN_UNIT_IDS, publishMavenLocally, readMavenStageVersions } from "../stage-maven.mjs";

const ROOT = realpathSync(resolve(import.meta.dirname, "../../.."));
const VERSIONS = readMavenStageVersions(ROOT);
const COORDINATE_UNITS = new Map([
  ["dev.eightlines.gauntlet:core", "java-core"],
  ["dev.eightlines.gauntlet:spring-boot-starter", "spring-boot-starter"],
]);
const COORDINATES = [
  "dev.eightlines.gauntlet:core",
  "dev.eightlines.gauntlet:spring-boot-starter",
];
const ROLES = ["binary", "sources", "javadoc", "pom", "module"];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function createOutput(parent, name = "maven") {
  const output = join(parent, name);
  mkdirSync(output, { mode: 0o700 });
  chmodSync(output, 0o700);
  return output;
}

test("publishes two closed reproducible Maven version trees from the pinned Java toolchain", async () => {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "gauntlet-stage-maven-test-")));
  const outputDirectory = createOutput(sandbox);
  try {
    const artifacts = await publishMavenLocally({ root: ROOT, outputDirectory, versions: VERSIONS, include: MAVEN_UNIT_IDS });
    assert.equal(Object.isFrozen(artifacts), true);
    assert.deepEqual(artifacts.map(({ name }) => name), COORDINATES);
    assert.equal(artifacts.length, 2);
    for (const artifact of artifacts) {
      assert.deepEqual(Object.keys(artifact), [
        "kind", "name", "version", "path", "treeSha256", "files",
      ]);
      assert.equal(artifact.kind, "maven");
      assert.equal(artifact.version, VERSIONS[COORDINATE_UNITS.get(artifact.name)]);
      assert.equal(realpathSync(artifact.path), artifact.path);
      assert.match(artifact.treeSha256, /^[a-f0-9]{64}$/u);
      assert.equal(Object.isFrozen(artifact), true);
      assert.equal(Object.isFrozen(artifact.files), true);
      assert.deepEqual(artifact.files.map(({ role }) => role), ROLES);
      assert.equal(artifact.files.length, 5);

      const expectedNames = [];
      for (const file of artifact.files) {
        assert.deepEqual(Object.keys(file), ["role", "path", "sha256", "sha512"]);
        assert.equal(realpathSync(file.path), file.path);
        assert.equal(lstatSync(file.path).isFile(), true);
        assert.equal(lstatSync(file.path).isSymbolicLink(), false);
        assert.equal(lstatSync(file.path).nlink, 1);
        assert.equal(lstatSync(file.path).mode & 0o777, 0o600);
        const bytes = readFileSync(file.path);
        assert.equal(sha256(bytes), file.sha256);
        assert.equal(createHash("sha512").update(bytes).digest("hex"), file.sha512);
        assert.equal(readFileSync(`${file.path}.sha256`, "utf8"), `${file.sha256}\n`);
        assert.equal(readFileSync(`${file.path}.sha512`, "utf8"), `${file.sha512}\n`);
        expectedNames.push(file.path.split("/").at(-1), `${file.path.split("/").at(-1)}.sha256`, `${file.path.split("/").at(-1)}.sha512`);
      }
      assert.deepEqual(readdirSync(artifact.path).sort(), expectedNames.sort());
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("prepares the pinned toolchain explicitly and never lets docker run pull implicitly", async (t) => {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "gauntlet-stage-maven-pull-")));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const bin = join(sandbox, "bin");
  mkdirSync(bin, { mode: 0o700 });
  const log = join(sandbox, "docker.log");
  const pulled = join(sandbox, "pulled");
  // A fake Docker CLI: the image is absent until an explicit pull; an implicit pull by `docker run`
  // writes the same stderr notice as the real CLI, which Maven staging must never see.
  writeFileSync(join(bin, "docker"), [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> '${log}'`,
    'case "$1 $2" in',
    `  "image inspect") [ -f '${pulled}' ] || exit 1; printf 'linux/amd64\\n'; exit 0 ;;`,
    `  "image pull") : > '${pulled}'; exit 0 ;;`,
    "esac",
    'if [ "$1" = run ]; then',
    '  case " $* " in *" --pull=never "*) exit 0 ;; esac',
    "  printf \"Unable to find image 'gradle' locally\\n\" >&2",
    "fi",
    "exit 0",
    "",
  ].join("\n"), { mode: 0o700 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;
  t.after(() => {
    process.env.PATH = originalPath;
  });

  await assert.rejects(publishMavenLocally({ root: ROOT, outputDirectory: createOutput(sandbox), versions: VERSIONS, include: MAVEN_UNIT_IDS }), {
    message: "Maven package staging failed closed",
  });
  const calls = readFileSync(log, "utf8").trimEnd().split("\n");
  const firstPull = calls.findIndex((call) => call.startsWith(`image pull --platform ${MAVEN_TOOLCHAIN.platform} `));
  const firstRun = calls.findIndex((call) => call.startsWith("run "));
  assert.equal(firstPull >= 0, true, "explicit toolchain pull");
  assert.equal(calls[firstPull].endsWith(` ${MAVEN_TOOLCHAIN.image}`), true);
  assert.equal(firstRun > firstPull, true, "toolchain is prepared before the first container");
  for (const call of calls.filter((entry) => entry.startsWith("run "))) {
    assert.match(call, / --pull=never /u, call);
    assert.match(call, / --platform linux\/amd64 /u, call);
  }
});

test("rejects unsafe outputs and closed-option violations before running Docker", async () => {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "gauntlet-stage-maven-options-")));
  const outputDirectory = createOutput(sandbox);
  let getterCalls = 0;
  const accessor = { outputDirectory, versions: VERSIONS, include: MAVEN_UNIT_IDS };
  Object.defineProperty(accessor, "root", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return ROOT;
    },
  });
  const cases = [
    null,
    [],
    { root: ROOT },
    { root: ROOT, outputDirectory },
    { root: ROOT, outputDirectory, versions: VERSIONS, include: MAVEN_UNIT_IDS, extra: true },
    accessor,
    new Proxy({ root: ROOT, outputDirectory, versions: VERSIONS, include: MAVEN_UNIT_IDS }, {}),
  ];
  try {
    for (const options of cases) {
      await assert.rejects(publishMavenLocally(options), {
        name: "TypeError",
        message: "Maven staging options must be a closed data object",
      });
    }
    assert.equal(getterCalls, 0);
    writeFileSync(join(outputDirectory, "foreign"), "FOREIGN\n", { mode: 0o600 });
    await assert.rejects(publishMavenLocally({ root: ROOT, outputDirectory, versions: VERSIONS, include: MAVEN_UNIT_IDS }), {
      message: "Maven package staging failed closed",
    });
    assert.equal(readFileSync(join(outputDirectory, "foreign"), "utf8"), "FOREIGN\n");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

function createJavaFixtureRoot(parent, { core, starter }) {
  const root = join(parent, "root");
  const javaRoot = join(root, "packages/java");
  mkdirSync(javaRoot, { recursive: true, mode: 0o755 });
  for (const file of ["README.md", "build.gradle.kts", "gradlew", "gradlew.bat", "settings.gradle.kts"]) {
    writeFileSync(join(javaRoot, file), "fixture\n", { mode: 0o644 });
  }
  for (const directory of ["core", "gradle", "spring-boot-starter", "spring-example", "starter-api-consumer-test"]) {
    mkdirSync(join(javaRoot, directory), { mode: 0o755 });
    writeFileSync(join(javaRoot, directory, "fixture.txt"), "fixture\n", { mode: 0o644 });
  }
  if (core !== undefined) writeFileSync(join(javaRoot, "core/VERSION"), core, { mode: 0o644 });
  if (starter !== undefined) writeFileSync(join(javaRoot, "spring-boot-starter/VERSION"), starter, { mode: 0o644 });
  return root;
}

test("reads each Java unit version from its own VERSION file, including diverged versions", () => {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "gauntlet-stage-maven-version-")));
  try {
    const root = createJavaFixtureRoot(sandbox, { core: "7.8.9\n", starter: "7.8.10\n" });
    assert.equal(readdirSync(root).includes("VERSION"), false);
    assert.deepEqual(readMavenStageVersions(root), { "java-core": "7.8.9", "spring-boot-starter": "7.8.10" });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("rejects missing or invalid Java unit versions for Maven staging", () => {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "gauntlet-stage-maven-version-")));
  try {
    [{ core: "7.8.9\n" }, { starter: "7.8.9\n" }, { core: "7.8.9\n", starter: "not-a-version\n" }].forEach((versions, index) => {
      const root = createJavaFixtureRoot(join(sandbox, String(index)), versions);
      assert.throws(() => readMavenStageVersions(root), {
        message: "Release version must be an exact stable ASCII semantic version followed by one LF",
      });
    });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("rejects version maps and include lists that do not match the Java units before running Docker", async () => {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "gauntlet-stage-maven-options-")));
  try {
    const versions = readMavenStageVersions(ROOT);
    let count = 0;
    for (const [candidate, include] of [
      [{ ...versions, "java-core": "9.9.9" }, ["java-core"]],
      [{ "java-core": versions["java-core"] }, ["java-core"]],
      [{ ...versions, protocol: "1.0.0" }, ["java-core"]],
      [versions, []],
      [versions, ["spring-boot-starter", "java-core"]],
      [versions, ["java-core", "java-core"]],
      [versions, ["protocol"]],
    ]) {
      count += 1;
      await assert.rejects(publishMavenLocally({
        root: ROOT, outputDirectory: createOutput(sandbox, `o-${count}`), versions: candidate, include,
      }), { message: "Maven package staging failed closed" });
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("stages only the included Java unit at its own version", async () => {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "gauntlet-stage-maven-subset-")));
  const outputDirectory = createOutput(sandbox);
  try {
    const artifacts = await publishMavenLocally({
      root: ROOT, outputDirectory, versions: VERSIONS, include: ["spring-boot-starter"],
    });
    assert.deepEqual(artifacts.map(({ name }) => name), ["dev.eightlines.gauntlet:spring-boot-starter"]);
    assert.equal(artifacts[0].version, VERSIONS["spring-boot-starter"]);
    assert.equal(existsSync(join(outputDirectory, "dev/eightlines/gauntlet/core")), false);
    assert.deepEqual(readdirSync(join(outputDirectory, "dev/eightlines/gauntlet")), ["spring-boot-starter"]);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
