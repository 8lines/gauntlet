import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import filesystem from "node:fs";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { types as utilTypes } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";

const FAILURE = "Canonical tree packaging failed closed";
const NORMALIZED_MTIME_SECONDS = 946_684_800;
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_RELATIVE_PATH_BYTES = 220;
const MAX_TAR_BYTES = MAX_TOTAL_BYTES + MAX_FILES * 1024 + 1024;
const MAX_ARCHIVE_BYTES = MAX_TAR_BYTES + 1024 * 1024;
const SUPPORTED_PLATFORMS = new Set(["darwin", "linux"]);

function failClosed() {
  throw new Error(FAILURE);
}

function trustedLsPath() {
  const candidates = process.platform === "darwin"
    ? ["/bin/ls"]
    : ["/usr/bin/ls", "/bin/ls", "/run/current-system/sw/bin/ls", "/nix/var/nix/profiles/default/bin/ls"];
  for (const candidate of candidates) {
    try {
      const path = realpathSync(candidate);
      const stat = lstatSync(path, { bigint: true });
      if (stat.isFile() && !stat.isSymbolicLink() && stat.uid === 0n && (stat.mode & 0o022n) === 0n) {
        assertAclAwareLs(path);
        return path;
      }
    } catch {
      // Try the next fixed, root-owned system location.
    }
  }
  failClosed();
}

function assertAclAwareLs(path) {
  if (process.platform !== "linux") return;
  const result = spawnSync(path, ["--version"], {
    encoding: "utf8",
    env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
    maxBuffer: 16 * 1024,
    shell: false,
    timeout: 2_000,
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0 || result.signal !== null
      || result.stderr !== "" || typeof result.stdout !== "string"
      || !/^ls \(GNU coreutils\) [1-9][0-9]*(?:\.[0-9]+)*[^\r\n]*\n/u.test(result.stdout)) failClosed();
}

function assertNoExtendedAcl(path) {
  try {
    if (!SUPPORTED_PLATFORMS.has(process.platform) || typeof path !== "string"
        || /[\0-\x1f\x7f]/u.test(path)) failClosed();
    const ls = trustedLsPath();
    const args = process.platform === "darwin" ? ["-lde", "--", path] : ["-ld", "--", path];
    const result = spawnSync(ls, args, {
      encoding: "utf8",
      env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
      maxBuffer: 16 * 1024,
      shell: false,
      timeout: 2_000,
      windowsHide: true,
    });
    if (result.error !== undefined || result.status !== 0 || result.signal !== null
        || result.stderr !== "" || typeof result.stdout !== "string" || !result.stdout.endsWith("\n")) failClosed();
    const lines = result.stdout.slice(0, -1).split("\n");
    const mode = lines.length === 1 ? /^[^\s]+/u.exec(lines[0])?.[0] : undefined;
    if (mode === undefined || mode.includes("+")
        || !/^[bcdlps-][rwxStTs-]{9}(?:[.@])?$/u.test(mode)) failClosed();
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  }
}

function compare(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function optionsOf(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)
      || utilTypes.isProxy(options) || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) failClosed();
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const expected = ["archivePrefix", "filename", "outputDirectory", "sourceDirectory"];
  const keys = Reflect.ownKeys(descriptors).sort(compare);
  if (keys.length !== expected.length || keys.some((key, index) => typeof key !== "string" || key !== expected[index])) failClosed();
  const values = Object.create(null);
  for (const key of expected) {
    const descriptor = descriptors[key];
    if (descriptor.get !== undefined || descriptor.set !== undefined || !("value" in descriptor)
        || descriptor.enumerable !== true) failClosed();
    values[key] = descriptor.value;
  }
  return values;
}

function materializeOptionsOf(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)
      || utilTypes.isProxy(options) || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) failClosed();
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const expected = ["archivePath", "expectedPrefix", "expectedSha256", "outputDirectory"];
  const keys = Reflect.ownKeys(descriptors).sort(compare);
  if (keys.length !== expected.length
      || keys.some((key, index) => typeof key !== "string" || key !== expected[index])) failClosed();
  const values = Object.create(null);
  for (const key of expected) {
    const descriptor = descriptors[key];
    if (descriptor.get !== undefined || descriptor.set !== undefined || !("value" in descriptor)
        || descriptor.enumerable !== true) failClosed();
    values[key] = descriptor.value;
  }
  return values;
}

function canonicalDirectory(path, { privateDirectory = false } = {}) {
  try {
    if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path || path === sep
        || /[\u0000-\u001f\u007f,]/u.test(path)) throw new Error();
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) throw new Error();
    if (privateDirectory) {
      const effectiveUid = typeof process.geteuid === "function" ? BigInt(process.geteuid()) : stat.uid;
      if (stat.uid !== effectiveUid || (stat.mode & 0o077n) !== 0n) throw new Error();
    }
    assertNoExtendedAcl(path);
    return stat;
  } catch {
    failClosed();
  }
}

function safeSegment(value) {
  return typeof value === "string" && value !== "" && value !== "." && value !== ".."
    && Buffer.byteLength(value) <= 96 && /^[A-Za-z0-9@._+-]+$/.test(value);
}

function safePrefix(value) {
  return typeof value === "string" && value.length <= 96
    && value.split("/").every(safeSegment);
}

function safeFilename(value) {
  return safeSegment(value) && (value.endsWith(".tar.gz") || value.endsWith(".tgz"));
}

function sameRegularFile(left, right) {
  return left.isFile() && right.isFile() && !left.isSymbolicLink() && !right.isSymbolicLink()
    && left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.uid === right.uid && left.gid === right.gid && left.nlink === 1n && right.nlink === 1n
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function sameDirectoryIdentity(left, right) {
  return left.isDirectory() && right.isDirectory() && !left.isSymbolicLink() && !right.isSymbolicLink()
    && left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.uid === right.uid && left.gid === right.gid;
}

function readStable(path, maximumBytes = MAX_FILE_BYTES) {
  let descriptor;
  try {
    if (realpathSync(path) !== path) failClosed();
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
        || before.size < 0n || before.size > BigInt(maximumBytes)) failClosed();
    assertNoExtendedAcl(path);
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!sameRegularFile(before, opened)) failClosed();
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) failClosed();
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    const pathname = lstatSync(path, { bigint: true });
    if (!sameRegularFile(opened, after) || !sameRegularFile(after, pathname)) failClosed();
    return Object.freeze({ bytes, stat: before });
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function captureTree(sourceDirectory) {
  const records = [];
  let totalBytes = 0;
  const visit = (directory, prefix, depth) => {
    if (depth > 32) failClosed();
    const directoryStat = canonicalDirectory(directory);
    for (const name of readdirSync(directory).sort(compare)) {
      if (!safeSegment(name)) failClosed();
      const path = join(directory, name);
      const relativePath = prefix === "" ? name : `${prefix}/${name}`;
      if (Buffer.byteLength(relativePath) > MAX_RELATIVE_PATH_BYTES) failClosed();
      const stat = lstatSync(path, { bigint: true });
      if (stat.isSymbolicLink()) failClosed();
      if (stat.isDirectory()) {
        records.push(Object.freeze({ path: `${relativePath}/`, type: "directory", stat }));
        visit(path, relativePath, depth + 1);
      } else if (stat.isFile() && stat.nlink === 1n) {
        const record = readStable(path);
        totalBytes += record.bytes.length;
        records.push(Object.freeze({ bytes: record.bytes, path: relativePath, type: "file", stat: record.stat }));
      } else {
        failClosed();
      }
      if (records.length > MAX_FILES || totalBytes > MAX_TOTAL_BYTES) failClosed();
    }
    const after = lstatSync(directory, { bigint: true });
    if (after.dev !== directoryStat.dev || after.ino !== directoryStat.ino || after.mode !== directoryStat.mode
        || after.uid !== directoryStat.uid || after.gid !== directoryStat.gid
        || after.mtimeNs !== directoryStat.mtimeNs || after.ctimeNs !== directoryStat.ctimeNs) failClosed();
  };
  visit(sourceDirectory, "", 0);
  if (records.length === 0) failClosed();
  return Object.freeze(records);
}

function sameCapture(left, right) {
  if (left.length !== right.length) failClosed();
  for (let index = 0; index < left.length; index += 1) {
    const before = left[index];
    const after = right[index];
    if (before.path !== after.path || before.type !== after.type
        || before.stat.dev !== after.stat.dev || before.stat.ino !== after.stat.ino
        || before.stat.mode !== after.stat.mode || before.stat.uid !== after.stat.uid
        || before.stat.gid !== after.stat.gid || before.stat.mtimeNs !== after.stat.mtimeNs
        || before.stat.ctimeNs !== after.stat.ctimeNs
        || (before.bytes !== undefined && !before.bytes.equals(after.bytes))) failClosed();
  }
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

function splitTarPath(path) {
  if (Buffer.byteLength(path) < 100) return { name: path, prefix: "" };
  for (let index = path.endsWith("/") ? path.length - 2 : path.length - 1; index > 0; index -= 1) {
    if (path[index] !== "/") continue;
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(prefix) < 155 && Buffer.byteLength(name) < 100) return { name, prefix };
  }
  failClosed();
}

function tarHeader(path, size, mode, type) {
  const header = Buffer.alloc(512);
  const { name, prefix } = splitTarPath(path);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, NORMALIZED_MTIME_SECONDS);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  Buffer.from("ustar\0", "ascii").copy(header, 257);
  Buffer.from("00", "ascii").copy(header, 263);
  if (prefix !== "") writeString(header, 345, 155, prefix);
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  const digits = checksum.toString(8).padStart(6, "0");
  if (digits.length !== 6) failClosed();
  header.write(digits, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function archiveBytes(prefix, records) {
  const chunks = [];
  for (const record of records) {
    const name = `${prefix}/${record.path}`;
    if (record.type === "directory") {
      chunks.push(tarHeader(name, 0, 0o755, "5"));
      continue;
    }
    chunks.push(tarHeader(name, record.bytes.length, 0o644, "0"), record.bytes);
    const padding = Math.ceil(record.bytes.length / 512) * 512 - record.bytes.length;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  const archive = gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
  if (!archive.subarray(0, 9).equals(Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0x02]))) failClosed();
  archive[9] = 0x03;
  return archive;
}

function tarString(header, offset, length) {
  const field = header.subarray(offset, offset + length);
  const terminator = field.indexOf(0);
  if (terminator < 0 || field.subarray(terminator).some((byte) => byte !== 0)) failClosed();
  const value = field.subarray(0, terminator);
  if (value.some((byte) => byte < 0x20 || byte > 0x7e)) failClosed();
  return value.toString("ascii");
}

function tarSize(header) {
  const field = header.subarray(124, 136);
  if (!/^[0-7]{11}\0$/u.test(field.toString("ascii"))) failClosed();
  const size = Number.parseInt(field.subarray(0, 11).toString("ascii"), 8);
  if (!Number.isSafeInteger(size) || size < 0) failClosed();
  return size;
}

function recordPath(header, expectedPrefix, type) {
  const leaf = tarString(header, 0, 100);
  const prefix = tarString(header, 345, 155);
  const path = prefix === "" ? leaf : `${prefix}/${leaf}`;
  const root = `${expectedPrefix}/`;
  if (!path.startsWith(root)) failClosed();
  const relativePath = path.slice(root.length);
  const directory = type === "5";
  if (relativePath === "" || directory !== relativePath.endsWith("/")) failClosed();
  const normalized = directory ? relativePath.slice(0, -1) : relativePath;
  if (normalized === "" || Buffer.byteLength(normalized) > MAX_RELATIVE_PATH_BYTES
      || !normalized.split("/").every(safeSegment)) failClosed();
  return relativePath;
}

function assertCanonicalRecordOrder(records) {
  const byPath = new Map();
  const children = new Map();
  for (const record of records) {
    const normalized = record.type === "directory" ? record.path.slice(0, -1) : record.path;
    if (byPath.has(normalized)) failClosed();
    byPath.set(normalized, record);
  }
  for (const [normalized, record] of byPath) {
    const separator = normalized.lastIndexOf("/");
    const parent = separator < 0 ? "" : normalized.slice(0, separator);
    if (parent !== "" && byPath.get(parent)?.type !== "directory") failClosed();
    const siblings = children.get(parent) ?? [];
    siblings.push(record);
    children.set(parent, siblings);
  }
  const expected = [];
  const visit = (parent, depth) => {
    if (depth > 32) failClosed();
    const siblings = children.get(parent) ?? [];
    siblings.sort((left, right) => {
      const leftPath = left.type === "directory" ? left.path.slice(0, -1) : left.path;
      const rightPath = right.type === "directory" ? right.path.slice(0, -1) : right.path;
      return compare(leftPath.slice(leftPath.lastIndexOf("/") + 1), rightPath.slice(rightPath.lastIndexOf("/") + 1));
    });
    for (const record of siblings) {
      expected.push(record);
      if (record.type === "directory") visit(record.path.slice(0, -1), depth + 1);
    }
  };
  visit("", 0);
  if (expected.length !== records.length
      || expected.some((record, index) => record !== records[index])) failClosed();
}

function parseCanonicalArchive(bytes, expectedPrefix) {
  let tar;
  try {
    tar = gunzipSync(bytes, { maxOutputLength: MAX_TAR_BYTES });
  } catch {
    failClosed();
  }
  if (tar.length < 1536 || tar.length > MAX_TAR_BYTES || tar.length % 512 !== 0) failClosed();
  const records = [];
  const normalizedPaths = new Set();
  let offset = 0;
  let totalBytes = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (records.length === 0 || tar.length - offset !== 1024
          || !tar.subarray(offset).every((byte) => byte === 0)) failClosed();
      break;
    }
    const type = String.fromCharCode(header[156]);
    if (type !== "0" && type !== "5") failClosed();
    const size = tarSize(header);
    if ((type === "5" && size !== 0) || size > MAX_FILE_BYTES) failClosed();
    totalBytes += size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_BYTES) failClosed();
    const path = recordPath(header, expectedPrefix, type);
    const normalized = type === "5" ? path.slice(0, -1) : path;
    if (normalizedPaths.has(normalized)) failClosed();
    normalizedPaths.add(normalized);
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    const next = bodyStart + Math.ceil(size / 512) * 512;
    if (!Number.isSafeInteger(next) || bodyEnd > tar.length || next > tar.length
        || !tar.subarray(bodyEnd, next).every((byte) => byte === 0)) failClosed();
    records.push(Object.freeze(type === "5"
      ? { path, type: "directory" }
      : { bytes: tar.subarray(bodyStart, bodyEnd), path, type: "file" }));
    if (records.length > MAX_FILES) failClosed();
    offset = next;
  }
  if (offset + 1024 !== tar.length) failClosed();
  assertCanonicalRecordOrder(records);
  if (!archiveBytes(expectedPrefix, records).equals(bytes)) failClosed();
  return Object.freeze(records);
}

function privateDirectory(path) {
  const stat = canonicalDirectory(path, { privateDirectory: true });
  if ((stat.mode & 0o777n) !== 0o700n) failClosed();
  return stat;
}

function freshPrivateDirectory(path) {
  try {
    const before = privateDirectory(path);
    if (readdirSync(path).length !== 0) failClosed();
    const after = privateDirectory(path);
    if (!sameDirectoryIdentity(before, after)) failClosed();
    return before;
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  }
}

function createdIdentity(stat, type) {
  return Object.freeze({
    dev: stat.dev,
    gid: stat.gid,
    ino: stat.ino,
    type,
    uid: stat.uid,
  });
}

function sameCreatedIdentity(stat, identity) {
  return !stat.isSymbolicLink() && stat.dev === identity.dev && stat.ino === identity.ino
    && stat.uid === identity.uid && stat.gid === identity.gid
    && (identity.type === "file" ? stat.isFile() && stat.nlink === 1n : stat.isDirectory());
}

function createPrivateDirectory(path, journal) {
  try {
    mkdirSync(path, { mode: 0o700 });
    const created = lstatSync(path, { bigint: true });
    if (!created.isDirectory() || created.isSymbolicLink()) failClosed();
    journal.push(Object.freeze({ identity: createdIdentity(created, "directory"), path, type: "directory" }));
    const stat = privateDirectory(path);
    if (!sameDirectoryIdentity(created, stat)) failClosed();
    return stat;
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  }
}

function writeMaterializedFile(path, bytes, journal) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
      | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    const created = fstatSync(descriptor, { bigint: true });
    if (!created.isFile() || created.isSymbolicLink() || created.nlink !== 1n) failClosed();
    journal.push(Object.freeze({ identity: createdIdentity(created, "file"), path, type: "file" }));
    const pathnameCreated = lstatSync(path, { bigint: true });
    if (!sameRegularFile(created, pathnameCreated)) failClosed();
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) failClosed();
      offset += count;
    }
    fchmodSync(descriptor, 0o600);
    filesystem.fsyncSync(descriptor);
    const stat = fstatSync(descriptor, { bigint: true });
    const pathname = lstatSync(path, { bigint: true });
    if (!sameRegularFile(stat, pathname) || stat.size !== BigInt(bytes.length)
        || (stat.mode & 0o777n) !== 0o600n || (stat.mode & 0o111n) !== 0n) failClosed();
    assertNoExtendedAcl(path);
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  if (!readStable(path).bytes.equals(bytes)) failClosed();
}

function sameMaterializedRecords(expected, actual) {
  if (expected.length !== actual.length) failClosed();
  for (let index = 0; index < expected.length; index += 1) {
    const left = expected[index];
    const right = actual[index];
    if (left.path !== right.path || left.type !== right.type
        || (left.type === "directory" && (right.stat.mode & 0o777n) !== 0o700n)
        || (left.type === "file" && (!left.bytes.equals(right.bytes)
          || (right.stat.mode & 0o777n) !== 0o600n || (right.stat.mode & 0o111n) !== 0n))) failClosed();
  }
}

function verifyPrefixDirectories(outputDirectory, expectedPrefix, identities) {
  let parent = outputDirectory;
  const segments = expectedPrefix.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    const names = readdirSync(parent);
    if (names.length !== 1 || names[0] !== segments[index]) failClosed();
    const path = resolve(parent, segments[index]);
    const stat = privateDirectory(path);
    if (!sameDirectoryIdentity(stat, identities[index])) failClosed();
    parent = path;
  }
  return parent;
}

function rollbackCreatedEntries(journal) {
  let complete = true;
  for (let index = journal.length - 1; index >= 0; index -= 1) {
    const entry = journal[index];
    try {
      const stat = filesystem.lstatSync(entry.path, { bigint: true });
      if (!sameCreatedIdentity(stat, entry.identity)) {
        complete = false;
        continue;
      }
      if (entry.type === "file") filesystem.unlinkSync(entry.path);
      else filesystem.rmdirSync(entry.path);
    } catch (error) {
      if (error?.code !== "ENOENT") complete = false;
    }
  }
  return complete;
}

function writeArchive(path, bytes) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) failClosed();
      offset += count;
    }
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    const stat = fstatSync(descriptor, { bigint: true });
    const pathname = lstatSync(path, { bigint: true });
    if (!sameRegularFile(stat, pathname) || stat.size !== BigInt(bytes.length)
        || (stat.mode & 0o777n) !== 0o600n) failClosed();
    assertNoExtendedAcl(path);
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function packageCanonicalTree(options) {
  const { archivePrefix, filename, outputDirectory, sourceDirectory } = optionsOf(options);
  if (!safePrefix(archivePrefix) || !safeFilename(filename)) failClosed();
  canonicalDirectory(sourceDirectory);
  canonicalDirectory(outputDirectory, { privateDirectory: true });
  if (sourceDirectory === outputDirectory || sourceDirectory.startsWith(`${outputDirectory}${sep}`)
      || outputDirectory.startsWith(`${sourceDirectory}${sep}`)) failClosed();
  const records = captureTree(sourceDirectory);
  const bytes = archiveBytes(archivePrefix, records);
  sameCapture(records, captureTree(sourceDirectory));
  const path = resolve(outputDirectory, filename);
  writeArchive(path, bytes);
  return Object.freeze({
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  });
}

export function materializeCanonicalTreeArchive(options) {
  const { archivePath, expectedPrefix, expectedSha256, outputDirectory } = materializeOptionsOf(options);
  if (!safePrefix(expectedPrefix) || typeof expectedSha256 !== "string"
      || !/^[0-9a-f]{64}$/u.test(expectedSha256)) failClosed();
  const archive = readStable(archivePath, MAX_ARCHIVE_BYTES);
  if (createHash("sha256").update(archive.bytes).digest("hex") !== expectedSha256) failClosed();
  const records = parseCanonicalArchive(archive.bytes, expectedPrefix);
  const outputIdentity = freshPrivateDirectory(outputDirectory);

  const prefixIdentities = [];
  const journal = [];
  const segments = expectedPrefix.split("/");
  let parent = outputDirectory;
  try {
    for (const segment of segments) {
      const path = resolve(parent, segment);
      const identity = createPrivateDirectory(path, journal);
      prefixIdentities.push(identity);
      parent = path;
    }
    const materializedRoot = parent;
    for (const record of records) {
      const path = resolve(materializedRoot, record.path);
      if (path === materializedRoot || !path.startsWith(`${materializedRoot}${sep}`)) failClosed();
      if (record.type === "directory") createPrivateDirectory(path, journal);
      else writeMaterializedFile(path, record.bytes, journal);
    }

    const captured = captureTree(materializedRoot);
    sameMaterializedRecords(records, captured);
    if (!archiveBytes(expectedPrefix, captured).equals(archive.bytes)) failClosed();
    if (verifyPrefixDirectories(outputDirectory, expectedPrefix, prefixIdentities) !== materializedRoot
        || !sameDirectoryIdentity(outputIdentity, privateDirectory(outputDirectory))) failClosed();
    const archiveAfter = readStable(archivePath, MAX_ARCHIVE_BYTES);
    if (!sameRegularFile(archive.stat, archiveAfter.stat) || !archive.bytes.equals(archiveAfter.bytes)) failClosed();
    return Object.freeze({ path: materializedRoot });
  } catch {
    rollbackCreatedEntries(journal);
    failClosed();
  }
}
