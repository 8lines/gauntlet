import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify, types as utilTypes } from "node:util";

import { RELEASE_ARTIFACTS, parseReleaseVersion } from "./release-model.mjs";
import { INSPECTOR_FILENAME, writeJdkInspector } from "./inspect-jdk.mjs";
import { dependencyOrder } from "./units.mjs";

export const MAVEN_UNIT_IDS = Object.freeze(["java-core", "spring-boot-starter"]);
const MAVEN_PROJECTS = Object.freeze({
  "java-core": Object.freeze({
    artifactId: "core",
    versionPath: "core/VERSION",
    task: ":core:publishCorePublicationToGauntletLocalRepository",
  }),
  "spring-boot-starter": Object.freeze({
    artifactId: "spring-boot-starter",
    versionPath: "spring-boot-starter/VERSION",
    task: ":spring-boot-starter:publishSpringBootStarterPublicationToGauntletLocalRepository",
  }),
});

const execFileAsync = promisify(execFile);
const GRADLE_IMAGE = "docker.io/library/gradle:9.2.1-jdk21@sha256:f1d5be114f4f16e780eee51a942449eaa98808887dddd5da4a5b608971c90aa4";
const GRADLE_PLATFORM = "linux/amd64";
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_BYTES = 192 * 1024 * 1024;
const MAX_SOURCE_FILES = 20_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const PRIMARY_ROLES = Object.freeze([
  Object.freeze({ role: "binary", suffix: ".jar" }),
  Object.freeze({ role: "sources", suffix: "-sources.jar" }),
  Object.freeze({ role: "javadoc", suffix: "-javadoc.jar" }),
  Object.freeze({ role: "pom", suffix: ".pom" }),
  Object.freeze({ role: "module", suffix: ".module" }),
]);
const RAW_HASHES = Object.freeze([
  Object.freeze({ extension: ".md5", algorithm: "md5", length: 32 }),
  Object.freeze({ extension: ".sha1", algorithm: "sha1", length: 40 }),
  Object.freeze({ extension: ".sha256", algorithm: "sha256", length: 64 }),
  Object.freeze({ extension: ".sha512", algorithm: "sha512", length: 128 }),
]);
const SOURCE_ROOT_ENTRIES = Object.freeze([
  "README.md",
  "build.gradle.kts",
  "core",
  "gradle",
  "gradlew",
  "gradlew.bat",
  "settings.gradle.kts",
  "spring-boot-starter",
  "spring-example",
  "starter-api-consumer-test",
]);

function binaryCompare(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function fixedFailure(phase) {
  const error = new Error("Maven package staging failed closed");
  if (phase !== undefined) {
    Object.defineProperty(error, "phase", {
      value: phase,
      configurable: false,
      enumerable: false,
      writable: false,
    });
  }
  throw error;
}

function validateClosedOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)
      || utilTypes.isProxy(options)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) {
    throw new TypeError("Maven staging options must be a closed data object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const keys = Reflect.ownKeys(descriptors);
  const names = ["root", "outputDirectory", "versions", "include"];
  if (keys.length !== names.length
      || keys.some((key) => typeof key !== "string"
        || !names.includes(key)
        || descriptors[key].enumerable !== true
        || !("value" in descriptors[key]))) {
    throw new TypeError("Maven staging options must be a closed data object");
  }
  return Object.freeze({
    root: descriptors.root.value,
    outputDirectory: descriptors.outputDirectory.value,
    versions: validateUnitVersions(descriptors.versions.value),
    include: validateInclude(descriptors.include.value),
  });
}

function validateUnitVersions(versions) {
  try {
    if (versions === null || typeof versions !== "object" || Array.isArray(versions)
        || utilTypes.isProxy(versions)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(versions))) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(versions);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== MAVEN_UNIT_IDS.length
        || keys.some((key) => typeof key !== "string" || !MAVEN_UNIT_IDS.includes(key)
          || descriptors[key].enumerable !== true || !("value" in descriptors[key])
          || typeof descriptors[key].value !== "string"
          || parseReleaseVersion(`${descriptors[key].value}\n`) !== descriptors[key].value)) throw new Error();
    return Object.freeze(Object.fromEntries(MAVEN_UNIT_IDS.map((id) => [id, descriptors[id].value])));
  } catch {
    return fixedFailure();
  }
}

function validateInclude(include) {
  try {
    if (!Array.isArray(include) || utilTypes.isProxy(include) || include.length === 0
        || Object.getPrototypeOf(include) !== Array.prototype
        || Reflect.ownKeys(include).length !== include.length + 1) throw new Error();
    const ids = [];
    for (let index = 0; index < include.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(include, String(index));
      if (descriptor === undefined || !("value" in descriptor) || !MAVEN_UNIT_IDS.includes(descriptor.value)) throw new Error();
      ids.push(descriptor.value);
    }
    if (new Set(ids).size !== ids.length
        || JSON.stringify(dependencyOrder(ids)) !== JSON.stringify(ids)) throw new Error();
    return Object.freeze(ids);
  } catch {
    return fixedFailure();
  }
}

// The included Maven projects in dependency order, each with its own artifact and version.
function selectedProjects({ versions, include }) {
  return include.map((id) => {
    const { artifactId } = MAVEN_PROJECTS[id];
    const artifact = RELEASE_ARTIFACTS.maven.find(({ name }) => name === `dev.eightlines.gauntlet:${artifactId}`);
    if (artifact === undefined) fixedFailure();
    return Object.freeze({ id, artifactId, artifact, version: versions[id] });
  });
}

function validateCanonicalDirectory(path, label, privateDirectory = false) {
  try {
    if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path || path === sep
        || path.includes(",") || /[\u0000-\u001f\u007f]/u.test(path)) throw new Error();
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) throw new Error();
    if (privateDirectory) {
      const uid = typeof process.geteuid === "function" ? BigInt(process.geteuid()) : stat.uid;
      if (stat.uid !== uid || (stat.mode & 0o077n) !== 0n) throw new Error();
    }
    return stat;
  } catch {
    throw new TypeError(`${label} must be a safe canonical directory`);
  }
}

function sameFile(left, right) {
  return left.isFile() && right.isFile() && !left.isSymbolicLink() && !right.isSymbolicLink()
    && left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.uid === right.uid && left.gid === right.gid && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs && left.nlink === right.nlink;
}

function safeRead(path, maximumBytes = MAX_FILE_BYTES) {
  let descriptor;
  try {
    if (realpathSync(path) !== path) throw new Error();
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
        || before.size < 0n || before.size > BigInt(maximumBytes)) throw new Error();
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!sameFile(before, opened)) throw new Error();
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new Error();
      offset += count;
    }
    const afterDescriptor = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(path, { bigint: true });
    if (!sameFile(before, afterDescriptor) || !sameFile(before, afterPath)) throw new Error();
    return Object.freeze({ bytes, stat: before });
  } catch {
    fixedFailure();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value)) === JSON.stringify(keys);
}

function ensureDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function captureJavaTree(root) {
  const javaRoot = join(root, "packages/java");
  if (realpathSync(javaRoot) !== javaRoot) fixedFailure();
  const visibleRootEntries = readdirSync(javaRoot)
    .filter((name) => ![".gradle", ".gradle-user", "build"].includes(name))
    .sort(binaryCompare);
  if (JSON.stringify(visibleRootEntries) !== JSON.stringify(SOURCE_ROOT_ENTRIES)) fixedFailure();
  const records = [];
  let totalBytes = 0;
  const visit = (directory, prefix) => {
    const stat = lstatSync(directory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory) fixedFailure();
    for (const name of readdirSync(directory).sort(binaryCompare)) {
      if (name === "build" || (prefix === "" && [".gradle", ".gradle-user"].includes(name))) continue;
      if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\\")
          || /[\u0000-\u001f\u007f]/u.test(name)) fixedFailure();
      const path = join(directory, name);
      const relativePath = prefix === "" ? name : `${prefix}/${name}`;
      const entry = lstatSync(path, { bigint: true });
      if (entry.isSymbolicLink()) fixedFailure();
      if (entry.isDirectory()) {
        visit(path, relativePath);
      } else if (entry.isFile() && entry.nlink === 1n) {
        const record = safeRead(path);
        const mode = Number(record.stat.mode & 0o777n);
        if (![0o644, 0o755].includes(mode)) fixedFailure();
        totalBytes += record.bytes.length;
        if (records.length >= MAX_SOURCE_FILES || totalBytes > MAX_SOURCE_BYTES) fixedFailure();
        records.push(Object.freeze({ relativePath, mode, bytes: record.bytes, stat: record.stat }));
      } else {
        fixedFailure();
      }
    }
  };
  visit(javaRoot, "");
  return Object.freeze({ javaRoot, records: Object.freeze(records), totalBytes });
}

function materializeJavaTree(destination, capture) {
  ensureDirectory(destination);
  for (const record of capture.records) {
    const path = join(destination, ...record.relativePath.split("/"));
    ensureDirectory(dirname(path));
    let descriptor;
    try {
      descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, record.mode);
      let offset = 0;
      while (offset < record.bytes.length) {
        const count = writeSync(descriptor, record.bytes, offset, record.bytes.length - offset, offset);
        if (count <= 0) fixedFailure();
        offset += count;
      }
      fsyncSync(descriptor);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    chmodSync(path, record.mode);
  }
}

function assertJavaTreeUnchanged(capture) {
  const current = captureJavaTree(dirname(dirname(capture.javaRoot)));
  if (current.records.length !== capture.records.length || current.totalBytes !== capture.totalBytes) fixedFailure();
  for (let index = 0; index < capture.records.length; index += 1) {
    const before = capture.records[index];
    const after = current.records[index];
    if (before.relativePath !== after.relativePath || before.mode !== after.mode
        || !before.bytes.equals(after.bytes) || !sameFile(before.stat, after.stat)) fixedFailure();
  }
}

function dockerEnvironment(scratch) {
  const path = process.env.PATH;
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) fixedFailure();
  const home = join(scratch, "docker-home");
  const config = join(scratch, "docker-config");
  const temporary = join(scratch, "tmp");
  for (const directory of [home, config, temporary]) ensureDirectory(directory);
  const environment = {
    PATH: path,
    HOME: home,
    DOCKER_CONFIG: config,
    TMPDIR: temporary,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    NO_COLOR: "1",
  };
  if (process.platform === "darwin" && typeof process.env.__CF_USER_TEXT_ENCODING === "string") {
    environment.__CF_USER_TEXT_ENCODING = process.env.__CF_USER_TEXT_ENCODING;
  }
  return Object.freeze(environment);
}

async function runDocker(arguments_, cwd, environment, timeout = 12 * 60_000) {
  try {
    return await execFileAsync("docker", arguments_, {
      cwd,
      env: environment,
      encoding: "utf8",
      timeout,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
    });
  } catch {
    fixedFailure();
  }
}

async function toolchainPresent(cwd, environment) {
  try {
    const { stdout } = await execFileAsync("docker", [
      "image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", GRADLE_IMAGE,
    ], { cwd, env: environment, encoding: "utf8", timeout: 60_000, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true });
    return stdout === `${GRADLE_PLATFORM}\n`;
  } catch {
    return false;
  }
}

// `docker run` would otherwise pull a missing image implicitly and report progress on stderr, which the
// closed publication and inspection runs reject. Prepare the exact platform explicitly, then run with
// --pull=never so every container starts from the verified local toolchain.
async function prepareToolchain(cwd, environment) {
  if (await toolchainPresent(cwd, environment)) return;
  await runDocker(["image", "pull", "--platform", GRADLE_PLATFORM, "--quiet", GRADLE_IMAGE], cwd, environment);
  if (!(await toolchainPresent(cwd, environment))) fixedFailure();
}

function mount(source, destination, readOnly = false) {
  return `type=bind,src=${source},dst=${destination}${readOnly ? ",readonly" : ""}`;
}

async function publishRun({ root, scratch, runName, offline, environment }) {
  const runRoot = join(scratch, runName);
  const javaCopy = join(runRoot, "java");
  const repository = join(runRoot, "repository");
  const projectCache = join(runRoot, "project-cache");
  for (const directory of [runRoot, repository, projectCache]) ensureDirectory(directory);
  return Object.freeze({ runRoot, javaCopy, repository, projectCache, offline, environment, root, scratch, runName });
}

async function executePublication(run, capture, selection) {
  materializeJavaTree(run.javaCopy, capture);
  const user = typeof process.getuid === "function" && typeof process.getgid === "function"
    ? `${process.getuid()}:${process.getgid()}` : "1000:1000";
  const arguments_ = [
    "run", "--rm", "--pull=never", "--platform", GRADLE_PLATFORM, "--user", user,
    "-e", "GRADLE_USER_HOME=/task/gradle-home",
    "-e", "HOME=/task/container-home",
    "-e", "LANG=C.UTF-8", "-e", "LC_ALL=C.UTF-8", "-e", "TZ=UTC", "-e", "SOURCE_DATE_EPOCH=946684800",
    "--mount", mount(run.root, "/workspace", true),
    "--mount", mount(run.scratch, "/task"),
    "--mount", mount(run.javaCopy, "/workspace/packages/java"),
    "--workdir", "/workspace/packages/java",
    GRADLE_IMAGE,
    "gradle", "--no-daemon", "--console=plain", "--quiet", "--warning-mode=fail",
    "--project-cache-dir", `/task/${run.runName}/project-cache`,
    ...(run.offline ? ["--offline"] : []),
    "-PgauntletPublishingRepository=file:///task/" + run.runName + "/repository",
    ...selection.include.map((id) => MAVEN_PROJECTS[id].task),
  ];
  const result = await runDocker(arguments_, run.root, run.environment);
  if (result.stdout !== "" || result.stderr !== "") fixedFailure();
}

function expectedRawFiles(selection) {
  const expected = new Set();
  for (const { artifactId, version } of selectedProjects(selection)) {
    const prefix = `dev/eightlines/gauntlet/${artifactId}`;
    const base = `${artifactId}-${version}`;
    for (const { suffix } of PRIMARY_ROLES) {
      const primary = `${prefix}/${version}/${base}${suffix}`;
      expected.add(primary);
      for (const { extension } of RAW_HASHES) expected.add(`${primary}${extension}`);
    }
    const metadata = `${prefix}/maven-metadata.xml`;
    expected.add(metadata);
    for (const { extension } of RAW_HASHES) expected.add(`${metadata}${extension}`);
  }
  return expected;
}

function listRegularTree(root) {
  const files = [];
  const visit = (directory, prefix) => {
    const directoryStat = lstatSync(directory, { bigint: true });
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || realpathSync(directory) !== directory) fixedFailure();
    for (const name of readdirSync(directory).sort(binaryCompare)) {
      if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\\")
          || /[\u0000-\u001f\u007f]/u.test(name)) fixedFailure();
      const path = join(directory, name);
      const relativePath = prefix === "" ? name : `${prefix}/${name}`;
      const stat = lstatSync(path, { bigint: true });
      if (stat.isSymbolicLink()) fixedFailure();
      if (stat.isDirectory()) visit(path, relativePath);
      else if (stat.isFile() && stat.nlink === 1n) files.push(relativePath);
      else fixedFailure();
    }
  };
  visit(root, "");
  return files;
}

function validateRawRepository(repository, selection) {
  const actual = listRegularTree(repository);
  const expected = [...expectedRawFiles(selection)].sort(binaryCompare);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fixedFailure();
  const captures = new Map();
  for (const relativePath of actual) {
    const record = safeRead(join(repository, ...relativePath.split("/")));
    const filename = relativePath.split("/").at(-1);
    if (filename.includes("maven-metadata.xml") && record.bytes.length > 1024 * 1024) fixedFailure();
    const sidecar = RAW_HASHES.find(({ extension }) => relativePath.endsWith(extension));
    if (sidecar !== undefined) {
      const primaryPath = relativePath.slice(0, -sidecar.extension.length);
      const primary = safeRead(join(repository, ...primaryPath.split("/")));
      const digest = createHash(sidecar.algorithm).update(primary.bytes).digest("hex");
      if (record.bytes.length !== sidecar.length || record.bytes.toString("ascii") !== digest) fixedFailure();
      continue;
    }
    if (!filename.startsWith("maven-metadata.xml")) captures.set(relativePath, record.bytes);
  }
  return captures;
}

function validateModuleMetadata(bytes, artifactId, version, captures, coreVersion) {
  let metadata;
  try {
    const source = bytes.toString("utf8");
    if (Buffer.byteLength(source) !== bytes.length || !source.endsWith("\n") || source.includes("\0")
        || /(?:SNAPSHOT|file:|password|username|token|secret|authorization)/iu.test(source)) throw new Error();
    metadata = JSON.parse(source);
  } catch {
    fixedFailure();
  }
  if (!exactKeys(metadata, ["formatVersion", "component", "createdBy", "variants"])
      || metadata.formatVersion !== "1.1"
      || !exactKeys(metadata.component, ["group", "module", "version", "attributes"])
      || metadata.component.group !== "dev.eightlines.gauntlet"
      || metadata.component.module !== artifactId || metadata.component.version !== version
      || metadata.createdBy?.gradle?.version !== "9.2.1" || !Array.isArray(metadata.variants)
      || metadata.variants.length < 4 || metadata.variants.length > 8) fixedFailure();
  const fileRecords = metadata.variants.flatMap((variant) => Array.isArray(variant.files) ? variant.files : []);
  const base = `${artifactId}-${version}`;
  for (const suffix of [".jar", "-sources.jar", "-javadoc.jar"]) {
    const name = `${base}${suffix}`;
    const path = `dev/eightlines/gauntlet/${artifactId}/${version}/${name}`;
    const bytes_ = captures.get(path);
    if (bytes_ === undefined || !fileRecords.some((record) => record?.name === name && record.url === name
      && record.size === bytes_.length
      && record.sha256 === createHash("sha256").update(bytes_).digest("hex")
      && record.sha512 === createHash("sha512").update(bytes_).digest("hex"))) fixedFailure();
  }
  const serialized = JSON.stringify(metadata);
  if (artifactId === "core") {
    if (!serialized.includes('"group":"com.networknt"') || !serialized.includes('"module":"json-schema-validator"')
        || !serialized.includes('"requires":"3.0.4"')
        || !serialized.includes('"group":"tools.jackson.core"')
        || !serialized.includes('"module":"jackson-core"')
        || !serialized.includes('"module":"jackson-databind"')
        || !serialized.includes('"requires":"3.1.7"')) fixedFailure();
  } else if (!serialized.includes('"group":"dev.eightlines.gauntlet"')
      || !serialized.includes('"module":"core"') || !serialized.includes(`"requires":"${coreVersion}"`)
      || !serialized.includes('"group":"org.apache.tomcat.embed"')
      || !serialized.includes('"module":"tomcat-embed-core"')
      || !serialized.includes('"module":"tomcat-embed-el"')
      || !serialized.includes('"module":"tomcat-embed-websocket"')
      || !serialized.includes('"requires":"11.0.25"')
      || !serialized.includes('"group":"tools.jackson"')
      || !serialized.includes('"module":"jackson-bom"')
      || !serialized.includes('"requires":"3.1.7"')
      || !serialized.includes('"module":"spring-boot-starter-webmvc"')
      || !serialized.includes('"module":"spring-boot-starter-validation"')) fixedFailure();
}

async function inspectRepository(root, repository, scratch, selection, environment) {
  const inspectorDirectory = realpathSync(mkdtempSync(join(scratch, ".gauntlet-inspector-")));
  chmodSync(inspectorDirectory, 0o700);
  writeJdkInspector(inspectorDirectory);
  const user = typeof process.getuid === "function" && typeof process.getgid === "function"
    ? `${process.getuid()}:${process.getgid()}` : "1000:1000";
  const result = await runDocker([
    "run", "--rm", "--pull=never", "--platform", GRADLE_PLATFORM, "--network", "none", "--user", user,
    "-e", "LANG=C.UTF-8", "-e", "LC_ALL=C.UTF-8", "-e", "TZ=UTC",
    "--mount", mount(root, "/workspace", true),
    "--mount", mount(repository, "/publication", true),
    "--mount", mount(inspectorDirectory, "/inspector", true),
    GRADLE_IMAGE,
    "java", `/inspector/${INSPECTOR_FILENAME}`, "/publication", "/workspace/LICENSE",
    selection.versions["java-core"], selection.versions["spring-boot-starter"],
    ...selection.include.map((id) => MAVEN_PROJECTS[id].artifactId),
  ], root, environment, 10 * 60_000);
  if (result.stdout !== "MAVEN_INSPECTION_OK\n" || result.stderr !== "") fixedFailure();
}

function validateCaptures(captures, selection) {
  for (const { artifactId, version } of selectedProjects(selection)) {
    const basePath = `dev/eightlines/gauntlet/${artifactId}/${version}/${artifactId}-${version}`;
    const moduleBytes = captures.get(`${basePath}.module`);
    if (moduleBytes === undefined) fixedFailure();
    validateModuleMetadata(moduleBytes, artifactId, version, captures, selection.versions["java-core"]);
  }
}

function assertReproducible(first, second) {
  if (first.size !== second.size) fixedFailure();
  for (const [path, bytes] of first) {
    const other = second.get(path);
    if (other === undefined || !bytes.equals(other)) fixedFailure();
  }
}

function digestRecord(bytes) {
  return Object.freeze({
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sha512: createHash("sha512").update(bytes).digest("hex"),
  });
}

function treeHash(records) {
  const hash = createHash("sha256").update("gauntlet-maven-tree-v1\0");
  for (const record of [...records].sort((left, right) => binaryCompare(left.path, right.path))) {
    const path = Buffer.from(record.path);
    const pathLength = Buffer.alloc(4);
    pathLength.writeUInt32BE(path.length);
    const bytesLength = Buffer.alloc(8);
    bytesLength.writeBigUInt64BE(BigInt(record.bytes.length));
    hash.update(pathLength).update(path).update(bytesLength).update(record.bytes);
  }
  return hash.digest("hex");
}

function writeExclusive(path, bytes) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) fixedFailure();
      offset += count;
    }
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  chmodSync(path, 0o600);
}

function materializeStage(ready, captures, selection) {
  const staged = [];
  for (const { artifact, artifactId, version } of selectedProjects(selection)) {
    const relativeDirectory = `dev/eightlines/gauntlet/${artifactId}/${version}`;
    const directory = join(ready, ...relativeDirectory.split("/"));
    ensureDirectory(directory);
    const files = [];
    const treeRecords = [];
    for (const { role, suffix } of PRIMARY_ROLES) {
      const filename = `${artifactId}-${version}${suffix}`;
      const sourcePath = `${relativeDirectory}/${filename}`;
      const bytes = captures.get(sourcePath);
      if (bytes === undefined) fixedFailure();
      const digests = digestRecord(bytes);
      writeExclusive(join(directory, filename), bytes);
      const sha256Bytes = Buffer.from(`${digests.sha256}\n`);
      const sha512Bytes = Buffer.from(`${digests.sha512}\n`);
      writeExclusive(join(directory, `${filename}.sha256`), sha256Bytes);
      writeExclusive(join(directory, `${filename}.sha512`), sha512Bytes);
      treeRecords.push(
        { path: filename, bytes },
        { path: `${filename}.sha256`, bytes: sha256Bytes },
        { path: `${filename}.sha512`, bytes: sha512Bytes },
      );
      files.push(Object.freeze({ role, filename, ...digests }));
    }
    staged.push(Object.freeze({ artifact, version, relativeDirectory, treeSha256: treeHash(treeRecords), files: Object.freeze(files) }));
  }
  return Object.freeze(staged);
}

function validateStagedTree(outputDirectory, staged) {
  const expected = [];
  for (const record of staged) {
    const directory = join(outputDirectory, ...record.relativeDirectory.split("/"));
    if (realpathSync(directory) !== directory) fixedFailure();
    for (const file of record.files) {
      const path = join(directory, file.filename);
      const primary = safeRead(path);
      if ((primary.stat.mode & 0o777n) !== 0o600n
          || createHash("sha256").update(primary.bytes).digest("hex") !== file.sha256
          || createHash("sha512").update(primary.bytes).digest("hex") !== file.sha512) fixedFailure();
      for (const algorithm of ["sha256", "sha512"]) {
        const sidecar = safeRead(`${path}.${algorithm}`, 1024);
        if ((sidecar.stat.mode & 0o777n) !== 0o600n
            || sidecar.bytes.toString("ascii") !== `${file[algorithm]}\n`) fixedFailure();
      }
      expected.push(
        `${record.relativeDirectory}/${file.filename}`,
        `${record.relativeDirectory}/${file.filename}.sha256`,
        `${record.relativeDirectory}/${file.filename}.sha512`,
      );
    }
  }
  if (JSON.stringify(listRegularTree(outputDirectory)) !== JSON.stringify(expected.sort(binaryCompare))) fixedFailure();
}

function resultRecords(outputDirectory, staged) {
  return Object.freeze(staged.map((record) => {
    const path = join(outputDirectory, ...record.relativeDirectory.split("/"));
    return Object.freeze({
      kind: "maven",
      name: record.artifact.name,
      version: record.version,
      path,
      treeSha256: record.treeSha256,
      files: Object.freeze(record.files.map((file) => Object.freeze({
        role: file.role,
        path: join(path, file.filename),
        sha256: file.sha256,
        sha512: file.sha512,
      }))),
    });
  }));
}

// Maven publishes only the Java units, so each version comes from that unit's own VERSION file,
// never the root VERSION. The versions may diverge.
function captureVersions(capture) {
  return Object.freeze(Object.fromEntries(MAVEN_UNIT_IDS.map((id) => {
    const record = capture.records.find(({ relativePath }) => relativePath === MAVEN_PROJECTS[id].versionPath);
    return [id, parseReleaseVersion(record === undefined ? Buffer.alloc(0) : record.bytes)];
  })));
}

export function readMavenStageVersions(root) {
  return captureVersions(captureJavaTree(root));
}

export async function publishMavenLocally(options) {
  const { root, outputDirectory, versions, include } = validateClosedOptions(options);
  const selection = Object.freeze({ versions, include });
  validateCanonicalDirectory(root, "Maven staging root");
  validateCanonicalDirectory(outputDirectory, "Maven staging output", true);
  const rootPrefix = `${root}${sep}`;
  const outputPrefix = `${outputDirectory}${sep}`;
  if (outputDirectory.startsWith(rootPrefix) || root.startsWith(outputPrefix)
      || readdirSync(outputDirectory).length !== 0) fixedFailure();
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 24 || nodeMajor > 26) fixedFailure();
  if (RELEASE_ARTIFACTS.maven.length !== 2
      || JSON.stringify(RELEASE_ARTIFACTS.maven.map(({ name }) => name)) !== JSON.stringify([
        "dev.eightlines.gauntlet:core", "dev.eightlines.gauntlet:spring-boot-starter",
      ])) fixedFailure();

  const rootLicense = safeRead(join(root, "LICENSE"), 1024 * 1024);
  if (rootLicense.bytes.length === 0) fixedFailure();
  const javaCapture = captureJavaTree(root);
  const captured = captureVersions(javaCapture);
  if (MAVEN_UNIT_IDS.some((id) => captured[id] !== versions[id])) fixedFailure();
  const scratch = realpathSync(mkdtempSync(join(dirname(outputDirectory), ".gauntlet-maven-stage-")));
  chmodSync(scratch, 0o700);
  const ready = realpathSync(mkdtempSync(join(dirname(outputDirectory), ".gauntlet-maven-ready-")));
  chmodSync(ready, 0o700);
  let promoted = false;
  let phase = "prepare";
  try {
    for (const directory of [join(scratch, "gradle-home"), join(scratch, "container-home")]) ensureDirectory(directory);
    const environment = dockerEnvironment(scratch);
    const firstRun = await publishRun({ root, scratch, runName: "first", offline: false, environment });
    const secondRun = await publishRun({ root, scratch, runName: "second", offline: true, environment });
    phase = "toolchain";
    await prepareToolchain(root, environment);
    phase = "first-publication";
    await executePublication(firstRun, javaCapture, selection);
    phase = "first-validation";
    const first = validateRawRepository(firstRun.repository, selection);
    validateCaptures(first, selection);
    phase = "first-inspection";
    await inspectRepository(root, firstRun.repository, scratch, selection, environment);
    phase = "second-publication";
    await executePublication(secondRun, javaCapture, selection);
    phase = "second-validation";
    const second = validateRawRepository(secondRun.repository, selection);
    validateCaptures(second, selection);
    phase = "second-inspection";
    await inspectRepository(root, secondRun.repository, scratch, selection, environment);
    phase = "reproducibility";
    assertReproducible(first, second);
    phase = "source-integrity";
    assertJavaTreeUnchanged(javaCapture);
    const licenseAfter = safeRead(join(root, "LICENSE"), 1024 * 1024);
    if (!rootLicense.bytes.equals(licenseAfter.bytes) || !sameFile(rootLicense.stat, licenseAfter.stat)) fixedFailure();
    phase = "staging";
    const staged = materializeStage(ready, first, selection);
    validateStagedTree(ready, staged);
    if (readdirSync(outputDirectory).length !== 0) fixedFailure();
    phase = "promotion";
    renameSync(ready, outputDirectory);
    promoted = true;
    phase = "final-validation";
    validateStagedTree(outputDirectory, staged);
    const result = resultRecords(outputDirectory, staged);
    validateStagedTree(outputDirectory, staged);
    return result;
  } catch {
    fixedFailure(phase);
  } finally {
    try {
      rmSync(scratch, { recursive: true, force: false });
    } catch {
      // The primary operation remains fail-closed; scratch cleanup is task-owned and best effort.
    }
    if (!promoted) {
      try {
        rmSync(ready, { recursive: true, force: false });
      } catch {
        // Never broaden cleanup beyond the uniquely created staging directory.
      }
    }
  }
}

export const MAVEN_TOOLCHAIN = Object.freeze({ image: GRADLE_IMAGE, platform: GRADLE_PLATFORM });
