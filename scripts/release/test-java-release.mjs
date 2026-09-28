#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { types as utilTypes } from "node:util";

import { parseReleaseVersion } from "./release-model.mjs";
import { MAVEN_TOOLCHAIN, publishMavenLocally } from "./stage-maven.mjs";

const ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
const FAILURE = "Java release verification failed safely";
const COMMITTED_INPUT_FAILURE = "Java release requires committed release inputs";
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_GIT_FILES = 20_000;
const MAX_GIT_FILE_BYTES = 64 * 1024 * 1024;
const MAX_GIT_TOTAL_BYTES = 256 * 1024 * 1024;
const MAVEN_CENTRAL = "https://repo.maven.apache.org/maven2";
const RELEVANT_INPUTS = Object.freeze([
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
const SOURCE_INPUTS = Object.freeze(RELEVANT_INPUTS.slice(0, 5));
const CONSUMER_PREFIX = "tests/consumers/java/";
const CONSUMER_FILES = Object.freeze([
  "build.gradle.kts",
  "gradle.lockfile",
  "settings.gradle.kts",
  "src/main/java/dev/eightlines/gauntlet/consumer/PublishedConsumer.java",
]);
const SOURCE_TASKS = Object.freeze([
  ":core:check",
  ":spring-boot-starter:check",
  ":spring-example:bootJar",
  ":starter-api-consumer-test:check",
]);
const EXPECTED_ARTIFACTS = Object.freeze([
  "dev.eightlines.gauntlet:core",
  "dev.eightlines.gauntlet:spring-boot-starter",
]);
const DISTRIBUTION_NAME = "gauntlet-published-java-consumer";
const PRIVATE_MODE = 0o700;

function fail() {
  throw new Error(FAILURE);
}

function invalidPlan() {
  throw new TypeError("Java release plan is invalid");
}

function closedPlanOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)
      || utilTypes.isProxy(options)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) invalidPlan();
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const keys = Reflect.ownKeys(descriptors);
  const expected = ["sandbox", "version", "uid", "gid"];
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))
      || keys.some((key) => typeof key !== "string" || !expected.includes(key)
        || descriptors[key].enumerable !== true || !("value" in descriptors[key]))) invalidPlan();
  return Object.fromEntries(expected.map((key) => [key, descriptors[key].value]));
}

function frozenInvocation(args) {
  return Object.freeze({ command: "docker", args: Object.freeze(args) });
}

function dockerPrefix({ uid, gid, network }) {
  return [
    "run", "--rm", "--platform", MAVEN_TOOLCHAIN.platform,
    "--user", `${uid}:${gid}`, "--network", network, "--read-only",
  ];
}

function gradleInvocation({
  uid,
  gid,
  network,
  project,
  gradleHome,
  projectCache,
  containerHome,
  repository,
  workingDirectory = "/workspace",
  arguments: gradleArguments,
}) {
  return frozenInvocation([
    ...dockerPrefix({ uid, gid, network }),
    "--env", "GRADLE_USER_HOME=/gradle-home",
    "--env", "HOME=/container-home",
    "--env", "LANG=C.UTF-8",
    "--env", "LC_ALL=C.UTF-8",
    "--env", "TZ=UTC",
    "--env", "CI=1",
    "--env", "SOURCE_DATE_EPOCH=946684800",
    "--mount", `type=bind,src=${project},dst=/workspace`,
    "--mount", `type=bind,src=${gradleHome},dst=/gradle-home`,
    "--mount", `type=bind,src=${projectCache},dst=/project-cache`,
    "--mount", `type=bind,src=${containerHome},dst=/container-home`,
    ...(repository === undefined
      ? [] : ["--mount", `type=bind,src=${repository},dst=/repository,readonly`]),
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=268435456",
    "--workdir", workingDirectory,
    MAVEN_TOOLCHAIN.image,
    "gradle", "--no-daemon", "--console=plain", "--quiet", "--warning-mode=fail",
    "--project-cache-dir", "/project-cache",
    ...gradleArguments,
  ]);
}

function runtimeInvocation({ uid, gid, network, project }) {
  return frozenInvocation([
    ...dockerPrefix({ uid, gid, network }),
    "--env", "HOME=/tmp",
    "--env", "LANG=C.UTF-8",
    "--env", "LC_ALL=C.UTF-8",
    "--env", "TZ=UTC",
    "--mount", `type=bind,src=${project},dst=/workspace,readonly`,
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=67108864",
    "--workdir", "/workspace",
    MAVEN_TOOLCHAIN.image,
    `/workspace/build/install/${DISTRIBUTION_NAME}/bin/${DISTRIBUTION_NAME}`,
  ]);
}

function freezeStep(step) {
  return Object.freeze(step);
}

function validReleaseVersion(value) {
  if (typeof value !== "string") return false;
  try {
    return parseReleaseVersion(`${value}\n`) === value;
  } catch {
    return false;
  }
}

function invalidFixture() {
  throw new Error("Java consumer fixture is invalid");
}

function closedFixtureOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)
      || utilTypes.isProxy(options)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) invalidFixture();
  const expected = ["settings", "build", "lock", "source", "version"];
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))
      || keys.some((key) => typeof key !== "string" || !expected.includes(key)
        || descriptors[key].enumerable !== true || !("value" in descriptors[key]))) invalidFixture();
  return Object.fromEntries(expected.map((key) => [key, descriptors[key].value]));
}

export function validateJavaConsumerFixture(options) {
  const { settings, build, lock, source, version } = closedFixtureOptions(options);
  if (![settings, build, lock, source].every((value) => typeof value === "string"
      && value.length > 0 && value.length <= 1024 * 1024 && value.endsWith("\n")
      && !value.includes("\0") && !value.includes("\r")) || !validReleaseVersion(version)) invalidFixture();
  const executableInputs = `${settings}\n${build}\n${lock}`;
  const remoteUrls = [...new Set(executableInputs.match(/[a-z][a-z0-9+.-]*:\/\/[^\s"')]+/giu) ?? [])];
  if (JSON.stringify(remoteUrls) !== JSON.stringify([MAVEN_CENTRAL])
      || /(?:GITHUB_|password|credentials?|authorization|bearer|private[_-]?key|secret|token|username)/iu.test(executableInputs)
      || /(?:SNAPSHOT|project\s*\(|includeBuild|mavenLocal|gradlePluginPortal|google\s*\(|ivy\s*\{|flatDir\s*\{)/u.test(executableInputs)
      || !/RepositoriesMode\.FAIL_ON_PROJECT_REPOS/u.test(settings)
      || !/exclusiveContent/u.test(settings)
      || !/includeGroup\("dev\.eightlines\.gauntlet"\)/u.test(settings)
      || !/excludeGroup\("dev\.eightlines\.gauntlet"\)/u.test(settings)
      || /repositories\s*\{/u.test(build)
      || !/lockAllConfigurations\(\)/u.test(build)
      || !/lockMode\.set\(LockMode\.STRICT\)/u.test(build)
      || !build.includes(`implementation("dev.eightlines.gauntlet:spring-boot-starter:${version}")`)
      || !source.includes("import dev.eightlines.gauntlet.core.model.ProtocolId;")
      || !source.includes("import dev.eightlines.gauntlet.spring.GauntletAutoConfiguration;")
      || !source.includes("import dev.eightlines.gauntlet.spring.GauntletProperties;")
      || !source.includes('System.out.println("PUBLISHED_JAVA_CONSUMER_OK");')) invalidFixture();

  const dataLines = lock.split("\n").filter((line) => line !== "" && !line.startsWith("#"));
  const configurations = new Set();
  const coordinates = new Map();
  let emptySeen = false;
  for (const line of dataLines) {
    if (line.startsWith("empty=")) {
      if (emptySeen) invalidFixture();
      emptySeen = true;
      for (const configuration of line.slice("empty=".length).split(",")) configurations.add(configuration);
      continue;
    }
    const match = /^([a-zA-Z0-9_.-]+):([a-zA-Z0-9_.-]+):([0-9][a-zA-Z0-9_.-]*)=([a-zA-Z][a-zA-Z0-9]*(?:,[a-zA-Z][a-zA-Z0-9]*)*)$/u.exec(line);
    if (match === null || /(?:SNAPSHOT|LATEST|RELEASE)/iu.test(match[3])) invalidFixture();
    const coordinate = `${match[1]}:${match[2]}`;
    if (coordinates.has(coordinate)) invalidFixture();
    coordinates.set(coordinate, match[3]);
    for (const configuration of match[4].split(",")) configurations.add(configuration);
  }
  const expectedConfigurations = [
    "annotationProcessor",
    "compileClasspath",
    "runtimeClasspath",
    "testAnnotationProcessor",
    "testCompileClasspath",
    "testRuntimeClasspath",
  ];
  if (!emptySeen || coordinates.size < 20
      || JSON.stringify([...configurations].sort()) !== JSON.stringify(expectedConfigurations)
      || coordinates.get("dev.eightlines.gauntlet:core") !== version
      || coordinates.get("dev.eightlines.gauntlet:spring-boot-starter") !== version
      || [...coordinates].some(([coordinate, lockedVersion]) => coordinate.startsWith("dev.eightlines.gauntlet:")
        && lockedVersion !== version)) invalidFixture();
  return Object.freeze({ dependencies: coordinates.size, configurations: configurations.size });
}

export function createJavaReleasePlan(options) {
  const { sandbox, version, uid, gid } = closedPlanOptions(options);
  if (typeof sandbox !== "string" || sandbox.length < 2 || sandbox.length > 4096
      || !isAbsolute(sandbox) || resolve(sandbox) !== sandbox || sandbox === sep
      || sandbox.includes(",") || /[\u0000-\u001f\u007f]/u.test(sandbox)
      || !validReleaseVersion(version)
      || !Number.isSafeInteger(uid) || uid < 0 || uid > 2_147_483_647
      || !Number.isSafeInteger(gid) || gid < 0 || gid > 2_147_483_647) invalidPlan();

  const repository = resolve(sandbox, "repository");
  const sourceProject = resolve(sandbox, "source");
  const stageSource = resolve(sandbox, "stage-source");
  const sourceGradleHome = resolve(sandbox, "gradle-homes/source");
  const sourceProjectCache = resolve(sandbox, "project-caches/source");
  const sourceContainerHome = resolve(sandbox, "container-homes/source");
  const sourceCheck = freezeStep({
    name: "source-check",
    kind: "docker",
    network: "bridge",
    project: sourceProject,
    gradleHome: sourceGradleHome,
    invocation: gradleInvocation({
      uid,
      gid,
      network: "bridge",
      project: sourceProject,
      gradleHome: sourceGradleHome,
      projectCache: sourceProjectCache,
      containerHome: sourceContainerHome,
      workingDirectory: "/workspace/packages/java",
      arguments: [
        "-DgauntletProtocolFixtures=/workspace/packages/protocol/fixtures/v1",
        ...SOURCE_TASKS,
      ],
    }),
  });
  const steps = [sourceCheck, freezeStep({
    name: "stage-maven",
    kind: "stage",
    root: stageSource,
    outputDirectory: repository,
  })];

  for (const mode of ["gradle", "pom"]) {
    const project = resolve(sandbox, `consumers/${mode}`);
    const gradleHome = resolve(sandbox, `gradle-homes/${mode}`);
    const projectCache = resolve(sandbox, `project-caches/${mode}`);
    const containerHome = resolve(sandbox, `container-homes/${mode}`);
    const arguments_ = [
      "-PgauntletRepository=file:///repository",
      `-PgauntletMetadataMode=${mode}`,
      "clean",
      "installDist",
    ];
    steps.push(
      freezeStep({
        name: `${mode}-online-bootstrap`,
        kind: "docker",
        mode,
        network: "bridge",
        project,
        gradleHome,
        invocation: gradleInvocation({
          uid, gid, network: "bridge", project, gradleHome, projectCache, containerHome,
          repository, arguments: arguments_,
        }),
      }),
      freezeStep({
        name: `${mode}-offline-build`,
        kind: "docker",
        mode,
        network: "none",
        project,
        gradleHome,
        invocation: gradleInvocation({
          uid, gid, network: "none", project, gradleHome, projectCache, containerHome,
          repository, arguments: ["--offline", ...arguments_],
        }),
      }),
      freezeStep({
        name: `${mode}-offline-runtime`,
        kind: "docker",
        mode,
        network: "none",
        project,
        gradleHome,
        invocation: runtimeInvocation({ uid, gid, network: "none", project }),
      }),
    );
  }

  return Object.freeze({
    version,
    image: MAVEN_TOOLCHAIN.image,
    platform: MAVEN_TOOLCHAIN.platform,
    sandbox,
    uid,
    gid,
    repository,
    allowedRemoteRepositories: Object.freeze([MAVEN_CENTRAL]),
    relevantInputs: RELEVANT_INPUTS,
    steps: Object.freeze(steps),
  });
}

function ensurePrivateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: PRIVATE_MODE });
  chmodSync(directory, PRIVATE_MODE);
}

function hostEnvironment(sandbox) {
  const executablePath = process.env.PATH;
  if (typeof executablePath !== "string" || executablePath === "" || executablePath.includes("\0")) fail();
  const home = resolve(sandbox, "host-home");
  const dockerConfig = resolve(sandbox, "docker-config");
  const temporary = resolve(sandbox, "host-tmp");
  for (const directory of [home, dockerConfig, temporary]) ensurePrivateDirectory(directory);
  return Object.freeze({
    PATH: executablePath,
    HOME: home,
    DOCKER_CONFIG: dockerConfig,
    TMPDIR: temporary,
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    NO_COLOR: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    ...(typeof process.env.DOCKER_HOST === "string" && process.env.DOCKER_HOST !== ""
      ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
  });
}

function execute(command, args, { cwd, environment, encoding = "utf8", timeout = 15 * 60_000 }) {
  const result = spawnSync(command, args, {
    cwd,
    env: environment,
    encoding,
    timeout,
    maxBuffer: MAX_OUTPUT_BYTES,
    windowsHide: true,
    shell: false,
  });
  if (result === null || typeof result !== "object" || result.error !== undefined
      || result.signal !== null || result.status !== 0) fail();
  return result;
}

function executeDocker(step, root, environment) {
  const result = execute(step.invocation.command, step.invocation.args, {
    cwd: root,
    environment,
    timeout: step.name === "source-check" ? 25 * 60_000 : 15 * 60_000,
  });
  if (step.name.endsWith("offline-runtime")
      && (result.stdout !== "PUBLISHED_JAVA_CONSUMER_OK\n" || result.stderr !== "")) fail();
}

function gitCommand(root, environment, args, encoding = "buffer") {
  return execute("git", ["-C", root, ...args], {
    cwd: root,
    environment,
    encoding,
    timeout: 60_000,
  });
}

function exactCommittedHead(root, environment) {
  const revision = gitCommand(root, environment, ["rev-parse", "--verify", "HEAD^{commit}"], "utf8").stdout;
  if (typeof revision !== "string" || !/^[0-9a-f]{40,64}\n$/u.test(revision)) fail();
  const status = gitCommand(root, environment, [
    "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...RELEVANT_INPUTS,
  ]).stdout;
  if (!Buffer.isBuffer(status) || status.length !== 0) throw new Error(COMMITTED_INPUT_FAILURE);
  return revision.trimEnd();
}

export function requireCommittedJavaReleaseInputs(root) {
  if (typeof root !== "string" || !isAbsolute(root) || realpathSync(root) !== root) {
    throw new TypeError("Java release root must be canonical");
  }
  const executablePath = process.env.PATH;
  if (typeof executablePath !== "string" || executablePath === "" || executablePath.includes("\0")) fail();
  return exactCommittedHead(root, Object.freeze({
    PATH: executablePath,
    HOME: root,
    TMPDIR: tmpdir(),
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  }));
}

function parseGitTree(bytes, allowedPrefixes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) fail();
  const records = [];
  for (const rawEntry of bytes.subarray(0, bytes.length - (bytes.at(-1) === 0 ? 1 : 0)).toString("utf8").split("\0")) {
    const match = /^(100644|100755) blob ([0-9a-f]{40,64})\t([^\0]+)$/u.exec(rawEntry);
    if (match === null) fail();
    const [, rawMode, oid, relativePath] = match;
    const segments = relativePath.split("/");
    if (!allowedPrefixes.some((prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}/`))
        || segments.some((segment) => segment === "" || segment === "." || segment === ".."
          || segment.includes("\\") || /[\u0000-\u001f\u007f]/u.test(segment))) fail();
    records.push(Object.freeze({ relativePath, oid, mode: rawMode === "100755" ? 0o755 : 0o644 }));
    if (records.length > MAX_GIT_FILES) fail();
  }
  if (records.length === 0) fail();
  return records;
}

function captureGitFiles(root, commit, pathspecs, environment) {
  const listing = gitCommand(root, environment, ["ls-tree", "-r", "-z", "--full-tree", commit, "--", ...pathspecs]).stdout;
  const records = parseGitTree(listing, pathspecs);
  let totalBytes = 0;
  return Object.freeze(records.map((record) => {
    const result = gitCommand(root, environment, ["cat-file", "blob", record.oid]);
    if (!Buffer.isBuffer(result.stdout) || !Buffer.isBuffer(result.stderr) || result.stderr.length !== 0
        || result.stdout.length > MAX_GIT_FILE_BYTES) fail();
    totalBytes += result.stdout.length;
    if (totalBytes > MAX_GIT_TOTAL_BYTES) fail();
    return Object.freeze({ ...record, bytes: result.stdout });
  }));
}

function materializeRecords(destination, records, prefix = "") {
  ensurePrivateDirectory(destination);
  for (const record of records) {
    if (prefix !== "" && !record.relativePath.startsWith(prefix)) fail();
    const relativePath = prefix === "" ? record.relativePath : record.relativePath.slice(prefix.length);
    const output = resolve(destination, ...relativePath.split("/"));
    if (!output.startsWith(`${destination}${sep}`)) fail();
    ensurePrivateDirectory(dirname(output));
    writeFileSync(output, record.bytes, { flag: "wx", mode: record.mode });
    chmodSync(output, record.mode);
  }
}

function assertConsumerRecords(records, version) {
  const actual = records.map(({ relativePath }) => relativePath.slice(CONSUMER_PREFIX.length)).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...CONSUMER_FILES].sort())) fail();
  const byPath = new Map(records.map((record) => [record.relativePath.slice(CONSUMER_PREFIX.length), record.bytes]));
  const values = {};
  for (const [key, relativePath] of [
    ["settings", "settings.gradle.kts"],
    ["build", "build.gradle.kts"],
    ["lock", "gradle.lockfile"],
    ["source", "src/main/java/dev/eightlines/gauntlet/consumer/PublishedConsumer.java"],
  ]) {
    const bytes = byPath.get(relativePath);
    if (bytes === undefined) fail();
    const value = bytes.toString("utf8");
    if (!Buffer.from(value, "utf8").equals(bytes)) fail();
    values[key] = value;
  }
  validateJavaConsumerFixture({ ...values, version });
}

function safeFileBytes(filename, maximum = MAX_GIT_FILE_BYTES) {
  try {
    const stat = lstatSync(filename, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n
        || stat.size < 0n || stat.size > BigInt(maximum) || realpathSync(filename) !== filename) fail();
    return readFileSync(filename);
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    fail();
  }
}

function assertDistribution(step, repository, version) {
  const library = resolve(step.project, `build/install/${DISTRIBUTION_NAME}/lib`);
  if (realpathSync(library) !== library) fail();
  const expected = ["core", "spring-boot-starter"];
  for (const artifactId of expected) {
    const filename = `${artifactId}-${version}.jar`;
    const installed = safeFileBytes(resolve(library, filename));
    const staged = safeFileBytes(resolve(
      repository,
      `dev/eightlines/gauntlet/${artifactId}/${version}/${filename}`,
    ));
    if (!installed.equals(staged)) fail();
  }
  if (readdirSync(library).some((filename) => /SNAPSHOT/iu.test(filename))) fail();
}

function removeConsumerBuild(project, sandbox) {
  const build = resolve(project, "build");
  if (!build.startsWith(`${resolve(sandbox, "consumers")}${sep}`) || relative(sandbox, build).startsWith("..")) fail();
  rmSync(build, { recursive: true, force: false });
}

function validateStagedArtifacts(artifacts, repository, version) {
  if (!Array.isArray(artifacts) || artifacts.length !== EXPECTED_ARTIFACTS.length
      || JSON.stringify(artifacts.map(({ name }) => name)) !== JSON.stringify(EXPECTED_ARTIFACTS)) fail();
  for (const artifact of artifacts) {
    if (artifact.version !== version || typeof artifact.path !== "string"
        || !artifact.path.startsWith(`${repository}${sep}`) || realpathSync(artifact.path) !== artifact.path) fail();
  }
}

function assertHeadStayedCommitted(root, commit, environment) {
  if (exactCommittedHead(root, environment) !== commit) throw new Error(COMMITTED_INPUT_FAILURE);
}

export async function runJavaRelease({ root = ROOT } = {}) {
  if (typeof root !== "string" || !isAbsolute(root) || realpathSync(root) !== root) {
    throw new TypeError("Java release root must be canonical");
  }
  const sandbox = realpathSync(mkdtempSync(resolve(tmpdir(), "gauntlet-java-release-")));
  chmodSync(sandbox, PRIVATE_MODE);
  const environment = hostEnvironment(sandbox);
  try {
    const commit = exactCommittedHead(root, environment);
    const sourceRecords = captureGitFiles(root, commit, SOURCE_INPUTS, environment);
    const versionRecord = sourceRecords.find(({ relativePath }) => relativePath === "VERSION");
    if (versionRecord === undefined) fail();
    const version = parseReleaseVersion(versionRecord.bytes);
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const gid = typeof process.getgid === "function" ? process.getgid() : 0;
    const plan = createJavaReleasePlan({ sandbox, version, uid, gid });
    const consumerRecords = captureGitFiles(root, commit, ["tests/consumers/java"], environment);
    assertConsumerRecords(consumerRecords, version);

    for (const directory of [
      resolve(sandbox, "source"),
      plan.steps[1].root,
      plan.repository,
      ...plan.steps.filter(({ kind }) => kind === "docker").flatMap((step) => [
        step.gradleHome,
        step.project === undefined ? undefined : step.project,
      ]).filter((value) => value !== undefined),
      ...["source", "gradle", "pom"].flatMap((name) => [
        resolve(sandbox, `project-caches/${name}`),
        resolve(sandbox, `container-homes/${name}`),
      ]),
    ]) ensurePrivateDirectory(directory);

    materializeRecords(resolve(sandbox, "source"), sourceRecords);
    materializeRecords(plan.steps[1].root, sourceRecords);
    for (const mode of ["gradle", "pom"]) {
      materializeRecords(resolve(sandbox, `consumers/${mode}`), consumerRecords, CONSUMER_PREFIX);
    }

    executeDocker(plan.steps[0], root, environment);
    const artifacts = await publishMavenLocally({ root: plan.steps[1].root, outputDirectory: plan.repository });
    validateStagedArtifacts(artifacts, plan.repository, version);

    for (const mode of ["gradle", "pom"]) {
      const [online, offline, runtime] = plan.steps.filter((step) => step.mode === mode);
      executeDocker(online, root, environment);
      assertDistribution(online, plan.repository, version);
      removeConsumerBuild(online.project, sandbox);
      executeDocker(offline, root, environment);
      assertDistribution(offline, plan.repository, version);
      executeDocker(runtime, root, environment);
    }
    assertHeadStayedCommitted(root, commit, environment);
    return Object.freeze({ version, artifacts: artifacts.length, consumers: 2, sourceChecks: SOURCE_TASKS.length });
  } catch (error) {
    if (error instanceof TypeError || error?.message === COMMITTED_INPUT_FAILURE) throw error;
    throw new Error(FAILURE);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

async function main() {
  await runJavaRelease();
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.length !== 2) {
    process.stderr.write(`${FAILURE}\n`);
    process.exitCode = 2;
  } else {
    main().catch(() => {
      process.stderr.write(`${FAILURE}\n`);
      process.exitCode = 1;
    });
  }
}
