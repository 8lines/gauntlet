import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  createJavaReleasePlan,
  requireCommittedJavaReleaseInputs,
  validateJavaConsumerFixture,
} from "../test-java-release.mjs";

const ROOT = resolve(import.meta.dirname, "../../..");
const IMAGE =
  "docker.io/library/gradle:9.2.1-jdk21@sha256:f1d5be114f4f16e780eee51a942449eaa98808887dddd5da4a5b608971c90aa4";
const MAVEN_CENTRAL = "https://repo.maven.apache.org/maven2";
const CHECK_TASKS = [
  ":core:check",
  ":spring-boot-starter:check",
  ":spring-example:bootJar",
  ":starter-api-consumer-test:check",
];

test("plans pinned source checks, Maven staging, and isolated online-to-offline consumers", () => {
  const plan = createJavaReleasePlan({
    sandbox: "/private/gauntlet-java-release",
    version: "0.1.0",
    uid: 501,
    gid: 20,
  });

  assert.equal(plan.version, "0.1.0");
  assert.equal(plan.image, IMAGE);
  assert.equal(plan.platform, "linux/amd64");
  assert.equal(plan.repository, "/private/gauntlet-java-release/repository");
  assert.deepEqual(plan.allowedRemoteRepositories, [MAVEN_CENTRAL]);
  assert.deepEqual(plan.relevantInputs, [
    "LICENSE",
    "NOTICE",
    "VERSION",
    "packages/java",
    "packages/protocol/fixtures/v1",
    "tests/consumers/java",
    "scripts/release/inspect-jdk.mjs",
    "scripts/release/release-model.mjs",
    "scripts/release/stage-maven.mjs",
    "scripts/release/test-java-release.mjs",
  ]);
  assert.deepEqual(plan.steps.map(({ name }) => name), [
    "source-check",
    "stage-maven",
    "gradle-online-bootstrap",
    "gradle-offline-build",
    "gradle-offline-runtime",
    "pom-online-bootstrap",
    "pom-offline-build",
    "pom-offline-runtime",
  ]);

  const source = plan.steps[0];
  assert.equal(source.kind, "docker");
  assert.equal(source.network, "bridge");
  assert.equal(source.project, "/private/gauntlet-java-release/source");
  assert.equal(source.gradleHome, "/private/gauntlet-java-release/gradle-homes/source");
  assert.equal(
    source.invocation.args.includes("type=bind,src=/private/gauntlet-java-release/source,dst=/workspace"),
    true,
  );
  assert.deepEqual(
    source.invocation.args.slice(source.invocation.args.indexOf("--workdir"), source.invocation.args.indexOf("--workdir") + 2),
    ["--workdir", "/workspace/packages/java"],
  );
  assert.deepEqual(source.invocation.args.slice(-CHECK_TASKS.length), CHECK_TASKS);
  assert.equal(source.invocation.args.includes("-DgauntletProtocolFixtures=/workspace/packages/protocol/fixtures/v1"), true);
  assert.equal(source.invocation.args.includes("--warning-mode=fail"), true);
  assert.equal(source.invocation.args.includes("--offline"), false);
  const stage = plan.steps[1];
  assert.equal(stage.kind, "stage");
  assert.equal(stage.root, "/private/gauntlet-java-release/stage-source");
  assert.notEqual(stage.root, source.project);
  assert.equal(stage.outputDirectory, plan.repository);

  for (const metadataMode of ["gradle", "pom"]) {
    const phases = plan.steps.filter(({ mode }) => mode === metadataMode);
    assert.deepEqual(phases.map(({ name }) => name), [
      `${metadataMode}-online-bootstrap`,
      `${metadataMode}-offline-build`,
      `${metadataMode}-offline-runtime`,
    ]);
    const [online, offline, runtime] = phases;
    assert.equal(online.network, "bridge");
    assert.equal(offline.network, "none");
    assert.equal(runtime.network, "none");
    assert.equal(online.gradleHome, offline.gradleHome);
    assert.notEqual(online.gradleHome, plan.steps.find(({ mode }) => mode !== undefined && mode !== metadataMode).gradleHome);
    assert.equal(online.invocation.args.includes("--offline"), false);
    assert.equal(offline.invocation.args.includes("--offline"), true);
    for (const phase of [online, offline]) {
      assert.equal(phase.invocation.args.includes(`-PgauntletMetadataMode=${metadataMode}`), true);
      assert.equal(phase.invocation.args.includes("-PgauntletRepository=file:///repository"), true);
      assert.deepEqual(phase.invocation.args.slice(-2), ["clean", "installDist"]);
    }
    assert.equal(
      runtime.invocation.args.at(-1),
      "/workspace/build/install/gauntlet-published-java-consumer/bin/gauntlet-published-java-consumer",
    );
  }

  for (const step of plan.steps.filter(({ kind }) => kind === "docker")) {
    assert.equal(step.invocation.command, "docker");
    assert.equal(step.invocation.args.includes("--read-only"), true);
    assert.deepEqual(
      step.invocation.args.slice(0, 10),
      ["run", "--rm", "--platform", "linux/amd64", "--user", "501:20", "--network", step.network, "--read-only", "--env"],
    );
    assert.doesNotMatch(
      JSON.stringify(step.invocation),
      /(?:GITHUB_|password|credentials?|authorization|bearer|private[_-]?key|secret|token|username)/iu,
    );
  }
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(plan.steps.every(Object.isFrozen), true);
});

test("rejects unsafe Java release plan inputs before constructing mounts", () => {
  const base = {
    sandbox: "/private/gauntlet-java-release",
    version: "0.1.0",
    uid: 501,
    gid: 20,
  };
  for (const change of [
    { sandbox: "relative" },
    { sandbox: "/private/../escape" },
    { sandbox: "/private/with,comma" },
    { version: "0.1.0-SNAPSHOT" },
    { uid: -1 },
    { gid: 1.5 },
  ]) {
    assert.throws(() => createJavaReleasePlan({ ...base, ...change }), {
      name: "TypeError",
      message: "Java release plan is invalid",
    });
  }
  assert.throws(() => createJavaReleasePlan({ ...base, extra: true }), {
    name: "TypeError",
    message: "Java release plan is invalid",
  });
});

test("accepts an exact Git HEAD and rejects tracked or untracked release input changes", () => {
  const repository = realpathSync(mkdtempSync(join(tmpdir(), "gauntlet-java-release-git-")));
  const environment = {
    PATH: process.env.PATH,
    HOME: repository,
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Release Test",
    GIT_AUTHOR_EMAIL: "release-test@example.invalid",
    GIT_COMMITTER_NAME: "Release Test",
    GIT_COMMITTER_EMAIL: "release-test@example.invalid",
  };
  const git = (...args) => {
    const result = spawnSync("git", args, {
      cwd: repository,
      env: environment,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };

  try {
    git("init", "--quiet", "--initial-branch=main");
    writeFileSync(resolve(repository, "VERSION"), "0.1.0\n");
    git("add", "VERSION");
    git("commit", "--quiet", "--message", "fixture");
    const commit = git("rev-parse", "HEAD").trimEnd();
    assert.equal(requireCommittedJavaReleaseInputs(repository), commit);

    writeFileSync(resolve(repository, "VERSION"), "0.1.1\n");
    assert.throws(() => requireCommittedJavaReleaseInputs(repository), {
      message: "Java release requires committed release inputs",
    });

    writeFileSync(resolve(repository, "VERSION"), "0.1.0\n");
    mkdirSync(resolve(repository, "tests/consumers/java"), { recursive: true });
    writeFileSync(resolve(repository, "tests/consumers/java/untracked"), "unsafe\n");
    assert.throws(() => requireCommittedJavaReleaseInputs(repository), {
      message: "Java release requires committed release inputs",
    });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("the committed consumer closes Gauntlet resolution to the staged repository and pins transitives", () => {
  const directory = resolve(ROOT, "tests/consumers/java");
  const expectedFiles = [
    "build.gradle.kts",
    "gradle.lockfile",
    "settings.gradle.kts",
    "src/main/java/dev/eightlines/gauntlet/consumer/PublishedConsumer.java",
  ];
  for (const relativePath of expectedFiles) assert.equal(existsSync(resolve(directory, relativePath)), true);

  const settings = readFileSync(resolve(directory, "settings.gradle.kts"), "utf8");
  const build = readFileSync(resolve(directory, "build.gradle.kts"), "utf8");
  const lock = readFileSync(resolve(directory, "gradle.lockfile"), "utf8");
  const source = readFileSync(resolve(directory, expectedFiles[3]), "utf8");
  const executableInputs = `${settings}\n${build}\n${lock}`;
  const urls = [...new Set(executableInputs.match(/https?:\/\/[^\s"')]+/gu) ?? [])];

  assert.deepEqual(urls, [MAVEN_CENTRAL]);
  assert.match(settings, /RepositoriesMode\.FAIL_ON_PROJECT_REPOS/);
  assert.match(settings, /exclusiveContent/);
  assert.match(settings, /includeGroup\("dev\.eightlines\.gauntlet"\)/);
  assert.match(settings, /excludeGroup\("dev\.eightlines\.gauntlet"\)/);
  assert.doesNotMatch(build, /repositories\s*\{/);
  assert.match(build, /lockMode\.set\(LockMode\.STRICT\)/);
  assert.match(build, /dev\.eightlines\.gauntlet:spring-boot-starter:0\.1\.0/);
  assert.doesNotMatch(executableInputs, /(?:SNAPSHOT|project\s*\(|includeBuild|mavenLocal)/u);
  assert.doesNotMatch(
    executableInputs,
    /(?:GITHUB_|password|credentials?|authorization|bearer|private[_-]?key|secret|token|username)/iu,
  );

  const locked = lock.split("\n")
    .filter((line) => line !== "" && !line.startsWith("#"));
  assert.equal(locked.length > 20, true);
  const coveredConfigurations = new Set();
  for (const line of locked) {
    assert.match(
      line,
      /^(?:[a-zA-Z0-9_.-]+:[a-zA-Z0-9_.-]+:[0-9][^=\s]*|empty)=[a-zA-Z][a-zA-Z0-9]*(?:,[a-zA-Z][a-zA-Z0-9]*)*$/u,
    );
    for (const configuration of line.slice(line.indexOf("=") + 1).split(",")) {
      coveredConfigurations.add(configuration);
    }
  }
  assert.deepEqual([...coveredConfigurations].sort(), [
    "annotationProcessor",
    "compileClasspath",
    "runtimeClasspath",
    "testAnnotationProcessor",
    "testCompileClasspath",
    "testRuntimeClasspath",
  ]);
  assert.equal(locked.some((line) => line.startsWith("dev.eightlines.gauntlet:core:0.1.0=")), true);
  assert.equal(locked.some((line) => line.startsWith("dev.eightlines.gauntlet:spring-boot-starter:0.1.0=")), true);
  assert.doesNotMatch(
    lock,
    /(?:https?:|file:|SNAPSHOT|\bLATEST\b|\bRELEASE\b|\[[^\]]*\]|\([^)]*\)|\+|GITHUB_|password|credentials?|authorization|bearer|private[_-]?key|secret|token|username)/iu,
  );

  const validation = validateJavaConsumerFixture({ settings, build, lock, source, version: "0.1.0" });
  assert.deepEqual(validation, { dependencies: 60, configurations: 6 });
  assert.equal(Object.isFrozen(validation), true);
  for (const change of [
    { settings: settings.replace(MAVEN_CENTRAL, "https://maven.pkg.github.com/8lines/gauntlet") },
    { settings: `${settings}\ncredentials { username = "leak" }\n` },
    { build: build.replace(":0.1.0", ":0.1.+") },
    { lock: lock.replace("dev.eightlines.gauntlet:core:0.1.0", "dev.eightlines.gauntlet:core:0.1.0-SNAPSHOT") },
  ]) {
    assert.throws(
      () => validateJavaConsumerFixture({ settings, build, lock, source, version: "0.1.0", ...change }),
      { message: "Java consumer fixture is invalid" },
    );
  }
});

test("every source-check project uses strict locking with a closed generated lock", () => {
  const javaRoot = resolve(ROOT, "packages/java");
  const build = readFileSync(resolve(javaRoot, "build.gradle.kts"), "utf8");
  const lockingOffset = build.indexOf("dependencyLocking {");
  const publishingOffset = build.indexOf("if (path in publishableProjects) {");
  assert.notEqual(lockingOffset, -1);
  assert.notEqual(publishingOffset, -1);
  assert.equal(lockingOffset < publishingOffset, true, "locking must apply before the publication-only branch");
  assert.equal(build.match(/dependencyLocking\s*\{/gu)?.length, 1);
  assert.match(build, /lockAllConfigurations\(\)/u);
  assert.match(build, /lockMode\.set\(LockMode\.STRICT\)/u);
  assert.match(build, /path\.toRealPath\(\) == path/u);

  const projectConfigurations = new Map([
    ["core", [
      "annotationProcessor", "compileClasspath", "runtimeClasspath", "testAnnotationProcessor",
      "testCompileClasspath", "testRuntimeClasspath",
    ]],
    ["spring-boot-starter", [
      "annotationProcessor", "compileClasspath", "runtimeClasspath", "testAnnotationProcessor",
      "testCompileClasspath", "testRuntimeClasspath",
    ]],
    ["spring-example", [
      "annotationProcessor", "compileClasspath", "developmentOnly", "productionRuntimeClasspath",
      "runtimeClasspath", "testAndDevelopmentOnly", "testAnnotationProcessor", "testCompileClasspath",
      "testRuntimeClasspath",
    ]],
    ["starter-api-consumer-test", [
      "annotationProcessor", "compileClasspath", "runtimeClasspath", "testAnnotationProcessor",
      "testCompileClasspath", "testRuntimeClasspath",
    ]],
  ]);

  for (const [project, expectedConfigurations] of projectConfigurations) {
    assert.equal(existsSync(resolve(javaRoot, project, "README.md")), true, `${project} README`);
    const lockPath = resolve(javaRoot, project, "gradle.lockfile");
    assert.equal(existsSync(lockPath), true, `${project} lockfile`);
    const lock = readFileSync(lockPath, "utf8");
    assert.equal(lock.endsWith("\n"), true);
    assert.doesNotMatch(
      lock,
      /(?:https?:|file:|SNAPSHOT|\bLATEST\b|\bRELEASE\b|\[[^\]]*\]|\([^)]*\)|\+|GITHUB_|password|credentials?|authorization|bearer|private[_-]?key|secret|token|username)/iu,
    );
    const lines = lock.split("\n").filter((line) => line !== "" && !line.startsWith("#"));
    assert.equal(lines.length > 5, true, `${project} dependency locks`);
    const configurations = new Set();
    for (const line of lines) {
      assert.match(
        line,
        /^(?:[a-zA-Z0-9_.-]+:[a-zA-Z0-9_.-]+:[0-9][a-zA-Z0-9_.-]*|empty)=[a-zA-Z][a-zA-Z0-9]*(?:,[a-zA-Z][a-zA-Z0-9]*)*$/u,
      );
      for (const configuration of line.slice(line.indexOf("=") + 1).split(",")) configurations.add(configuration);
    }
    assert.deepEqual([...configurations].sort(), [...expectedConfigurations].sort(), `${project} configurations`);
  }
});
