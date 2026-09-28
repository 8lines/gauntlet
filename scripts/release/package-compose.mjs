import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { types as utilTypes } from "node:util";
import { gzipSync } from "node:zlib";

import { parseReleaseVersion, RELEASE_ARTIFACTS } from "./release-model.mjs";

const NORMALIZED_MTIME_SECONDS = 946_684_800;
const RELEASE_FILES = Object.freeze([
  ".env.example",
  "LICENSE",
  "README.md",
  "compose.yaml",
  "config.example.yaml",
  "gauntlet",
  "gauntlet-config-v1.schema.json",
]);
const SOURCE_ENTRIES = Object.freeze([
  ...RELEASE_FILES,
  "compose.build.yaml",
  "test",
].sort(binaryCompare));
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_IGNORED_ENTRIES = 256;
const MAX_PATH_BYTES = 4_096;
const FAILURE = "Compose bundle packaging failed closed";

function binaryCompare(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function failClosed() {
  throw new Error(FAILURE);
}

function optionValues(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)
      || utilTypes.isProxy(options)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) {
    throw new TypeError("Compose bundle options must be a closed data object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== 2 || !keys.includes("root") || !keys.includes("outputDirectory")
      || keys.some((key) => typeof key !== "string"
        || !["root", "outputDirectory"].includes(key)
        || descriptors[key].enumerable !== true
        || !("value" in descriptors[key]))) {
    throw new TypeError("Compose bundle options must be a closed data object");
  }
  return Object.freeze({
    root: descriptors.root.value,
    outputDirectory: descriptors.outputDirectory.value,
  });
}

function canonicalDirectory(path, label, { privateDirectory = false } = {}) {
  try {
    if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path
        || path === sep || Buffer.byteLength(path) > MAX_PATH_BYTES
        || /[\u0000-\u001f\u007f]/.test(path)) throw new Error();
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) throw new Error();
    if (privateDirectory) {
      const effectiveUid = typeof process.geteuid === "function" ? BigInt(process.geteuid()) : stat.uid;
      if (stat.uid !== effectiveUid || (stat.mode & 0o077n) !== 0n) throw new Error();
    }
    return stat;
  } catch {
    throw new TypeError(label);
  }
}

function captureDirectoryChain(path, failure = FAILURE) {
  try {
    const paths = [];
    let current = path;
    while (true) {
      paths.push(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    paths.reverse();
    const records = paths.map((recordPath) => {
      const stat = lstatSync(recordPath, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
      return Object.freeze({
        path: recordPath,
        dev: stat.dev,
        ino: stat.ino,
        mode: stat.mode,
        uid: stat.uid,
        gid: stat.gid,
      });
    });
    if (realpathSync(path) !== path) throw new Error();
    return Object.freeze(records);
  } catch {
    throw new Error(failure);
  }
}

function assertDirectoryChain(records, failure = FAILURE) {
  try {
    for (const expected of records) {
      const stat = lstatSync(expected.path, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()
          || stat.dev !== expected.dev || stat.ino !== expected.ino
          || stat.mode !== expected.mode || stat.uid !== expected.uid || stat.gid !== expected.gid) {
        throw new Error();
      }
    }
    if (realpathSync(records.at(-1).path) !== records.at(-1).path) throw new Error();
  } catch {
    throw new Error(failure);
  }
}

function openDirectoryGuard(path) {
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const opened = fstatSync(descriptor, { bigint: true });
    const pathname = lstatSync(path, { bigint: true });
    if (!opened.isDirectory() || !pathname.isDirectory() || pathname.isSymbolicLink()
        || opened.dev !== pathname.dev || opened.ino !== pathname.ino
        || opened.mode !== pathname.mode || opened.uid !== pathname.uid || opened.gid !== pathname.gid
        || realpathSync(path) !== path) throw new Error();
    return Object.freeze({
      descriptor,
      signature: Object.freeze({
        dev: opened.dev,
        ino: opened.ino,
        mode: opened.mode,
        uid: opened.uid,
        gid: opened.gid,
      }),
    });
  } catch {
    if (descriptor !== undefined) closeSync(descriptor);
    failClosed();
  }
}

function assertDirectoryGuard(path, guard) {
  try {
    const opened = fstatSync(guard.descriptor, { bigint: true });
    const pathname = lstatSync(path, { bigint: true });
    const expected = guard.signature;
    if (!opened.isDirectory() || !pathname.isDirectory() || pathname.isSymbolicLink()
        || opened.dev !== expected.dev || opened.ino !== expected.ino
        || opened.mode !== expected.mode || opened.uid !== expected.uid || opened.gid !== expected.gid
        || pathname.dev !== expected.dev || pathname.ino !== expected.ino
        || pathname.mode !== expected.mode || pathname.uid !== expected.uid || pathname.gid !== expected.gid
        || realpathSync(path) !== path) throw new Error();
  } catch {
    failClosed();
  }
}

function sameRegularFile(left, right) {
  return left.isFile() && right.isFile() && !left.isSymbolicLink() && !right.isSymbolicLink()
    && left.dev === right.dev && left.ino === right.ino
    && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid
    && left.nlink === 1n && right.nlink === 1n
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function readExact(descriptor, size) {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(descriptor, bytes, offset, size - offset, offset);
    if (count <= 0) failClosed();
    offset += count;
  }
  const overflow = Buffer.alloc(1);
  if (readSync(descriptor, overflow, 0, 1, size) !== 0) failClosed();
  return bytes;
}

function safeRead(path, directoryChain, maximumBytes = MAX_FILE_BYTES) {
  let descriptor;
  try {
    assertDirectoryChain(directoryChain);
    if (realpathSync(path) !== path) throw new Error();
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
        || before.size < 0n || before.size > BigInt(maximumBytes)) throw new Error();
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const opened = fstatSync(descriptor, { bigint: true });
    if (!sameRegularFile(before, opened)) throw new Error();
    const first = readExact(descriptor, Number(before.size));
    const second = readExact(descriptor, Number(before.size));
    const afterDescriptor = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(path, { bigint: true });
    if (!first.equals(second) || !sameRegularFile(before, afterDescriptor)
        || !sameRegularFile(before, afterPath)) throw new Error();
    assertDirectoryChain(directoryChain);
    return Object.freeze({
      bytes: first,
      sha256: createHash("sha256").update(first).digest("hex"),
      stat: before,
    });
  } catch {
    failClosed();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function safeEntryName(name) {
  return typeof name === "string" && name.length > 0 && Buffer.byteLength(name) <= 240
    && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\")
    && !/[\u0000-\u001f\u007f]/.test(name);
}

function captureIgnoredTree(root) {
  const records = [];
  const visit = (directory, prefix, depth) => {
    if (depth > 16 || records.length > MAX_IGNORED_ENTRIES) failClosed();
    const chain = captureDirectoryChain(directory);
    const names = readdirSync(directory).sort(binaryCompare);
    for (const name of names) {
      if (!safeEntryName(name)) failClosed();
      const path = join(directory, name);
      const relativePath = prefix === "" ? name : `${prefix}/${name}`;
      const stat = lstatSync(path, { bigint: true });
      if (stat.isSymbolicLink()) failClosed();
      if (stat.isDirectory()) {
        if (realpathSync(path) !== path) failClosed();
        records.push(Object.freeze({ path: `${relativePath}/`, stat }));
        visit(path, relativePath, depth + 1);
      } else if (stat.isFile()) {
        const record = safeRead(path, chain);
        records.push(Object.freeze({ path: relativePath, stat: record.stat, sha256: record.sha256 }));
      } else {
        failClosed();
      }
      if (records.length > MAX_IGNORED_ENTRIES) failClosed();
    }
    assertDirectoryChain(chain);
  };
  visit(root, "", 0);
  return Object.freeze(records);
}

function exactNames(path, expected) {
  try {
    const actual = readdirSync(path).sort(binaryCompare);
    if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) failClosed();
  } catch {
    failClosed();
  }
}

function captureSource(root) {
  try {
    const rootChain = captureDirectoryChain(root);
    const versionRecord = safeRead(join(root, "VERSION"), rootChain, 64);
    const version = parseReleaseVersion(versionRecord.bytes);
    const composeDirectory = join(root, RELEASE_ARTIFACTS.compose.directory);
    canonicalDirectory(composeDirectory, FAILURE);
    const composeChain = captureDirectoryChain(composeDirectory);
    exactNames(composeDirectory, SOURCE_ENTRIES);

    const files = RELEASE_FILES.map((name) => Object.freeze({
      name,
      record: safeRead(join(composeDirectory, name), composeChain),
    }));
    const totalBytes = files.reduce((total, { record }) => total + record.bytes.length, 0);
    if (totalBytes > MAX_SOURCE_BYTES) failClosed();
    const wrapper = files.find(({ name }) => name === "gauntlet")?.record;
    if (wrapper === undefined || (wrapper.stat.mode & 0o111n) === 0n) failClosed();

    const ignoredBuild = safeRead(join(composeDirectory, "compose.build.yaml"), composeChain);
    const ignoredTestPath = join(composeDirectory, "test");
    const ignoredTestStat = lstatSync(ignoredTestPath, { bigint: true });
    if (!ignoredTestStat.isDirectory() || ignoredTestStat.isSymbolicLink()
        || realpathSync(ignoredTestPath) !== ignoredTestPath) failClosed();
    const ignoredTests = captureIgnoredTree(ignoredTestPath);
    assertDirectoryChain(rootChain);
    assertDirectoryChain(composeChain);
    exactNames(composeDirectory, SOURCE_ENTRIES);
    return Object.freeze({
      composeChain,
      files: Object.freeze(files),
      ignoredBuild,
      ignoredTestStat,
      ignoredTests,
      rootChain,
      version,
      versionRecord,
    });
  } catch {
    failClosed();
  }
}

function sameStat(left, right, { regular = true } = {}) {
  return left.dev === right.dev && left.ino === right.ino
    && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
    && (!regular || (left.nlink === 1n && right.nlink === 1n));
}

function assertSourceUnchanged(before, after) {
  if (before.version !== after.version
      || !before.versionRecord.bytes.equals(after.versionRecord.bytes)
      || !sameStat(before.versionRecord.stat, after.versionRecord.stat)
      || before.files.length !== after.files.length
      || before.ignoredTests.length !== after.ignoredTests.length
      || !before.ignoredBuild.bytes.equals(after.ignoredBuild.bytes)
      || !sameStat(before.ignoredBuild.stat, after.ignoredBuild.stat)
      || !sameStat(before.ignoredTestStat, after.ignoredTestStat, { regular: false })) failClosed();
  for (let index = 0; index < before.files.length; index += 1) {
    const left = before.files[index];
    const right = after.files[index];
    if (left.name !== right.name || !left.record.bytes.equals(right.record.bytes)
        || !sameStat(left.record.stat, right.record.stat)) failClosed();
  }
  for (let index = 0; index < before.ignoredTests.length; index += 1) {
    const left = before.ignoredTests[index];
    const right = after.ignoredTests[index];
    if (left.path !== right.path || left.sha256 !== right.sha256
        || !sameStat(left.stat, right.stat, { regular: left.sha256 !== undefined })) failClosed();
  }
  assertDirectoryChain(before.rootChain);
  assertDirectoryChain(before.composeChain);
}

function writeString(header, offset, length, value) {
  const bytes = Buffer.from(value, "ascii");
  if (bytes.length >= length || bytes.some((byte) => byte < 0x20 || byte > 0x7e)) failClosed();
  bytes.copy(header, offset);
}

function writeOctal(header, offset, length, value) {
  if (!Number.isSafeInteger(value) || value < 0) failClosed();
  const digits = value.toString(8).padStart(length - 1, "0");
  if (digits.length !== length - 1) failClosed();
  header.write(digits, offset, length - 1, "ascii");
  header[offset + length - 1] = 0;
}

function tarHeader(name, size, mode) {
  const header = Buffer.alloc(512);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, NORMALIZED_MTIME_SECONDS);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  Buffer.from("ustar\0", "ascii").copy(header, 257);
  Buffer.from("00", "ascii").copy(header, 263);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  const checksumDigits = checksum.toString(8).padStart(6, "0");
  if (checksumDigits.length !== 6) failClosed();
  header.write(checksumDigits, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function createArchive(source) {
  const records = [];
  for (const { name, record } of source.files) {
    const archiveName = `gauntlet/${name}`;
    const mode = name === "gauntlet" ? 0o755 : 0o644;
    records.push(tarHeader(archiveName, record.bytes.length, mode));
    records.push(record.bytes);
    const padding = Math.ceil(record.bytes.length / 512) * 512 - record.bytes.length;
    if (padding !== 0) records.push(Buffer.alloc(padding));
  }
  records.push(Buffer.alloc(1024));
  const tar = Buffer.concat(records);
  const archive = gzipSync(tar, { level: 9, mtime: 0 });
  if (!archive.subarray(0, 9).equals(Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x02]))) {
    failClosed();
  }
  archive[9] = 0x03;
  return archive;
}

function assertPrivateOutputAncestry(outputDirectory) {
  try {
    const effectiveUid = typeof process.geteuid === "function" ? BigInt(process.geteuid()) : undefined;
    if (effectiveUid === undefined) throw new Error();
    const allowedStickyRoots = new Set();
    for (const candidate of ["/tmp", "/var/tmp"]) {
      try { allowedStickyRoots.add(realpathSync(candidate)); } catch { /* Platform does not expose it. */ }
    }
    const chain = captureDirectoryChain(outputDirectory);
    for (const [index, record] of chain.entries()) {
      const isOutput = index === chain.length - 1;
      if (isOutput) {
        if (record.uid !== effectiveUid || (record.mode & 0o077n) !== 0n) throw new Error();
        continue;
      }
      const writableByOthers = (record.mode & 0o022n) !== 0n;
      if (!writableByOthers) {
        if (record.uid !== 0n && record.uid !== effectiveUid) throw new Error();
        continue;
      }
      if (!allowedStickyRoots.has(record.path) || record.uid !== 0n || (record.mode & 0o1000n) === 0n) {
        throw new Error();
      }
    }
  } catch {
    throw new TypeError("Compose bundle output must be a safe private canonical directory");
  }
}

function writeAll(descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (count <= 0) failClosed();
    offset += count;
  }
}

function descriptorBytes(descriptor, size) {
  return readExact(descriptor, size);
}

function assertPublishedFile(path, descriptor, expectedBytes) {
  try {
    const descriptorStat = fstatSync(descriptor, { bigint: true });
    const pathStat = lstatSync(path, { bigint: true });
    if (!sameRegularFile(descriptorStat, pathStat)
        || descriptorStat.size !== BigInt(expectedBytes.length)
        || (descriptorStat.mode & 0o777n) !== 0o600n
        || !descriptorBytes(descriptor, expectedBytes.length).equals(expectedBytes)) failClosed();
  } catch {
    failClosed();
  }
}

function assertEmptyOutput(outputDirectory, guard, chain) {
  assertDirectoryChain(chain);
  assertDirectoryGuard(outputDirectory, guard);
  if (readdirSync(outputDirectory).length !== 0) failClosed();
  assertDirectoryGuard(outputDirectory, guard);
  assertDirectoryChain(chain);
}

export function packageComposeBundle(options) {
  const { root, outputDirectory } = optionValues(options);
  canonicalDirectory(root, "Compose bundle root must be a safe canonical directory");
  canonicalDirectory(outputDirectory, "Compose bundle output must be a safe private canonical directory", {
    privateDirectory: true,
  });
  assertPrivateOutputAncestry(outputDirectory);
  if (outputDirectory.startsWith(`${root}${sep}`) || root.startsWith(`${outputDirectory}${sep}`)) failClosed();

  const outputParent = dirname(outputDirectory);
  const outputParentChain = captureDirectoryChain(outputParent);
  let outputGuard;
  let readyGuard;
  let archiveDescriptor;
  let readyDirectory;
  let promoted = false;
  try {
    outputGuard = openDirectoryGuard(outputDirectory);
    assertEmptyOutput(outputDirectory, outputGuard, outputParentChain);
    const source = captureSource(root);
    const archive = createArchive(source);
    const filename = `${RELEASE_ARTIFACTS.compose.name}-${source.version}.tar.gz`;
    const sha256 = createHash("sha256").update(archive).digest("hex");

    readyDirectory = mkdtempSync(join(outputParent, ".gauntlet-compose-ready-"));
    chmodSync(readyDirectory, 0o700);
    readyGuard = openDirectoryGuard(readyDirectory);
    if (readyGuard.signature.dev !== outputGuard.signature.dev) failClosed();
    const readyPath = join(readyDirectory, filename);
    archiveDescriptor = openSync(
      readyPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
    writeAll(archiveDescriptor, archive);
    fchmodSync(archiveDescriptor, 0o600);
    fsyncSync(archiveDescriptor);
    assertDirectoryGuard(readyDirectory, readyGuard);
    if (readdirSync(readyDirectory).length !== 1 || readdirSync(readyDirectory)[0] !== filename) failClosed();
    assertPublishedFile(readyPath, archiveDescriptor, archive);
    fsyncSync(readyGuard.descriptor);
    assertDirectoryGuard(readyDirectory, readyGuard);

    const finalSource = captureSource(root);
    assertSourceUnchanged(source, finalSource);
    assertEmptyOutput(outputDirectory, outputGuard, outputParentChain);
    assertDirectoryGuard(readyDirectory, readyGuard);
    renameSync(readyDirectory, outputDirectory);
    promoted = true;
    assertDirectoryGuard(outputDirectory, readyGuard);
    if (readdirSync(outputDirectory).length !== 1 || readdirSync(outputDirectory)[0] !== filename) failClosed();
    const publishedPath = join(outputDirectory, filename);
    assertPublishedFile(publishedPath, archiveDescriptor, archive);
    fsyncParentDirectory(outputParent);
    assertDirectoryGuard(outputDirectory, readyGuard);
    assertPublishedFile(publishedPath, archiveDescriptor, archive);
    return Object.freeze({
      kind: "compose",
      name: RELEASE_ARTIFACTS.compose.name,
      version: source.version,
      path: publishedPath,
      sha256,
    });
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith("Compose bundle ")) throw error;
    failClosed();
  } finally {
    if (archiveDescriptor !== undefined) closeSync(archiveDescriptor);
    if (readyGuard !== undefined) closeSync(readyGuard.descriptor);
    if (outputGuard !== undefined) closeSync(outputGuard.descriptor);
    if (!promoted && readyDirectory !== undefined) {
      // The pathname may have been exchanged by a same-UID process. Quarantine it instead of deleting unknown bytes.
    }
  }
}

function fsyncParentDirectory(path) {
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = fstatSync(descriptor, { bigint: true });
    if (!stat.isDirectory()) throw new Error();
    fsyncSync(descriptor);
  } catch {
    failClosed();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
