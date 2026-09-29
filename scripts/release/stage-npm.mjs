import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  utimesSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify, types as utilTypes } from "node:util";
import { crc32, inflateRawSync } from "node:zlib";

import { parseDocument } from "yaml";

import { RELEASE_ARTIFACTS, readReleaseVersion } from "./release-model.mjs";

const execFileAsync = promisify(execFile);
const PNPM_VERSION = "11.24.0";
const NORMALIZED_DATE = new Date("2000-01-01T00:00:00.000Z");
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_TAR_BYTES = 160 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 4_096;
const NPM_TAR_MTIME_SECONDS = 499_162_500;
const INTERNAL_NAMES = new Set(RELEASE_ARTIFACTS.npm.map(({ name }) => name));
const EXACT_STABLE_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

const CONTRACTS = Object.freeze({
  "@8lines/gauntlet-protocol": Object.freeze({
    files: Object.freeze(["dist", "schemas", "openapi", "fixtures", "README.md", "LICENSE"]),
    roots: Object.freeze(["dist", "schemas", "openapi", "fixtures"]),
    exports: Object.freeze({
      ".": Object.freeze({ types: "./dist/index.d.ts", import: "./dist/index.js" }),
      "./schemas/v1/*": "./schemas/v1/*",
      "./fixtures/v1/*": "./fixtures/v1/*",
      "./openapi/*": "./openapi/*",
    }),
    dependencies: Object.freeze({ ajv: "8.20.0", "ajv-formats": "3.0.1", canonicalize: "4.0.0" }),
    devDependencies: Object.freeze({ yaml: "2.8.3" }),
  }),
  "@8lines/gauntlet-dashboard-client": Object.freeze({
    files: Object.freeze(["dist", "README.md", "LICENSE"]),
    roots: Object.freeze(["dist"]),
    exports: Object.freeze({
      ".": Object.freeze({ types: "./dist/index.d.ts", import: "./dist/index.js" }),
    }),
    dependencies: Object.freeze({
      "@8lines/gauntlet-protocol": "workspace:*",
      ajv: "8.20.0",
      "ajv-formats": "3.0.1",
    }),
  }),
  "@8lines/gauntlet-typescript-core": Object.freeze({
    files: Object.freeze(["dist", "README.md", "LICENSE"]),
    roots: Object.freeze(["dist"]),
    exports: Object.freeze({
      ".": Object.freeze({ types: "./dist/index.d.ts", import: "./dist/index.js" }),
    }),
    dependencies: Object.freeze({
      "@8lines/gauntlet-protocol": "workspace:*",
      ajv: "8.20.0",
      "ajv-formats": "3.0.1",
    }),
  }),
  "@8lines/gauntlet-typescript-node": Object.freeze({
    files: Object.freeze(["dist", "README.md", "LICENSE"]),
    roots: Object.freeze(["dist"]),
    exports: Object.freeze({
      ".": Object.freeze({ types: "./dist/index.d.ts", import: "./dist/index.js" }),
    }),
    dependencies: Object.freeze({
      "@8lines/gauntlet-protocol": "workspace:*",
      "@8lines/gauntlet-typescript-core": "workspace:*",
    }),
  }),
  "@8lines/gauntlet-next-adapter": Object.freeze({
    files: Object.freeze(["dist", "README.md", "LICENSE"]),
    roots: Object.freeze(["dist"]),
    exports: Object.freeze({
      ".": Object.freeze({ types: "./dist/index.d.ts", import: "./dist/index.js" }),
    }),
    dependencies: Object.freeze({ "@8lines/gauntlet-typescript-node": "workspace:*" }),
  }),
  "@8lines/gauntlet-conformance-runner": Object.freeze({
    files: Object.freeze(["dist", "README.md", "LICENSE"]),
    roots: Object.freeze(["dist"]),
    exports: Object.freeze({
      ".": Object.freeze({ types: "./dist/index.d.ts", import: "./dist/index.js" }),
    }),
    bin: Object.freeze({
      "gauntlet-conformance": "./dist/cli.js",
      "gauntlet-conformance-extended": "./dist/extended-cli.js",
      "gauntlet-conformance-fixture": "./dist/fixture-adapter.js",
    }),
    dependencies: Object.freeze({
      "@8lines/gauntlet-protocol": "workspace:*",
      ajv: "8.20.0",
      "ajv-formats": "3.0.1",
    }),
  }),
  "@8lines/gauntlet-widget": Object.freeze({
    files: Object.freeze(["dist", "README.md", "LICENSE"]),
    roots: Object.freeze(["dist"]),
    exports: Object.freeze({
      ".": Object.freeze({ types: "./dist/index.d.ts", import: "./dist/index.js" }),
    }),
  }),
});

function binaryCompare(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function fixedFailure() {
  throw new Error("NPM package staging failed closed");
}

function validateClosedOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)
      || utilTypes.isProxy(options)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) {
    throw new TypeError("NPM staging options must be a closed data object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== 2 || !keys.includes("root") || !keys.includes("outputDirectory")
      || keys.some((key) => typeof key !== "string"
        || !["root", "outputDirectory"].includes(key)
        || descriptors[key].enumerable !== true
        || !("value" in descriptors[key]))) {
    throw new TypeError("NPM staging options must be a closed data object");
  }
  return { root: descriptors.root.value, outputDirectory: descriptors.outputDirectory.value };
}

function validateCanonicalDirectory(path, label, { privateDirectory = false } = {}) {
  try {
    if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path
        || path === sep || /[\u0000-\u001f\u007f]/.test(path)) throw new Error();
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) throw new Error();
    if (privateDirectory) {
      const effectiveUid = typeof process.geteuid === "function" ? BigInt(process.geteuid()) : stat.uid;
      if (stat.uid !== effectiveUid || (stat.mode & 0o077n) !== 0n) throw new Error();
    }
    return stat;
  } catch {
    throw new TypeError(`${label} must be a safe canonical directory`);
  }
}

function directorySignature(path) {
  const stat = lstatSync(path, { bigint: true });
  return Object.freeze({ dev: stat.dev, ino: stat.ino, mode: stat.mode, uid: stat.uid });
}

function assertDirectoryUnchanged(path, signature) {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== signature.dev
        || stat.ino !== signature.ino || stat.mode !== signature.mode || stat.uid !== signature.uid
        || realpathSync(path) !== path) throw new Error();
  } catch {
    fixedFailure();
  }
}

function openDirectoryGuard(path) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
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
    fixedFailure();
  }
}

function assertDirectoryGuardAt(path, guard) {
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
    fixedFailure();
  }
}

function openAncestorGuards(path) {
  const guards = [];
  let current = path;
  try {
    while (true) {
      guards.push(Object.freeze({ path: current, guard: openDirectoryGuard(current) }));
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return Object.freeze(guards);
  } catch (error) {
    for (const { guard } of guards.reverse()) closeSync(guard.descriptor);
    throw error;
  }
}

function assertAncestorGuards(guards) {
  for (const { path, guard } of guards.toReversed()) assertDirectoryGuardAt(path, guard);
}

function closeAncestorGuards(guards) {
  for (const { guard } of guards) closeSync(guard.descriptor);
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
    const bytes = readFileSync(descriptor);
    const afterDescriptor = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(path, { bigint: true });
    if (bytes.length !== Number(before.size) || !sameFile(before, afterDescriptor)
        || !sameFile(before, afterPath)) throw new Error();
    return Object.freeze({
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      stat: before,
    });
  } catch {
    fixedFailure();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function parseJson(bytes) {
  try {
    const source = bytes.toString("utf8");
    if (Buffer.byteLength(source) !== bytes.length || source.includes("\r") || source.includes("\0")) throw new Error();
    const value = JSON.parse(source);
    const document = parseDocument(source, { json: true, prettyErrors: false, strict: true, uniqueKeys: true });
    if (document.errors.length !== 0 || value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    fixedFailure();
  }
}

function exactJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateManifest(manifest, artifact, version, contract) {
  try {
    if (manifest.name !== artifact.name || manifest.version !== version || manifest.type !== "module"
        || manifest.license !== "Apache-2.0" || manifest.private !== undefined
        || typeof manifest.description !== "string" || manifest.description.length === 0
        || !exactJson(manifest.engines, { node: ">=24 <27" })
        || !exactJson(manifest.repository, {
          type: "git",
          url: "https://github.com/8lines/gauntlet.git",
          directory: artifact.directory,
        })
        || !exactJson(manifest.publishConfig, { access: "public", registry: artifact.registry })
        || !exactJson(manifest.files, contract.files)
        || !exactJson(manifest.exports, contract.exports)
        || !exactJson(manifest.bin, contract.bin)
        || !exactJson(manifest.dependencies, contract.dependencies)
        || !exactJson(manifest.devDependencies, contract.devDependencies)
        || manifest.scripts === null || typeof manifest.scripts !== "object" || Array.isArray(manifest.scripts)) {
      throw new Error();
    }
    const allowedKeys = new Set([
      "name", "description", "version", "type", "license", "engines", "repository", "publishConfig",
      "exports", "files", "bin", "scripts", "dependencies", "devDependencies",
    ]);
    if (Object.keys(manifest).some((key) => !allowedKeys.has(key))) throw new Error();
    for (const section of ["dependencies", "devDependencies"]) {
      const dependencies = manifest[section];
      if (dependencies === undefined) continue;
      if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) throw new Error();
      for (const [name, value] of Object.entries(dependencies)) {
        if (typeof value !== "string" || value.length === 0
            || (INTERNAL_NAMES.has(name)
              ? value !== "workspace:*"
              : !EXACT_STABLE_VERSION.test(value))) throw new Error();
      }
    }
    for (const [name, value] of Object.entries(manifest.dependencies ?? {})) {
      if (INTERNAL_NAMES.has(name) && value !== "workspace:*") throw new Error();
    }
  } catch {
    fixedFailure();
  }
}

function projectedManifest(manifest, version) {
  const dependencies = Object.fromEntries(Object.entries(manifest.dependencies ?? {}).map(([name, value]) => [
    name,
    INTERNAL_NAMES.has(name) ? version : value,
  ]));
  const projected = {
    name: manifest.name,
    description: manifest.description,
    version,
    type: manifest.type,
    license: manifest.license,
    engines: manifest.engines,
    repository: manifest.repository,
    publishConfig: manifest.publishConfig,
    exports: manifest.exports,
    files: manifest.files,
    ...(manifest.bin === undefined ? {} : { bin: manifest.bin }),
    ...(Object.keys(dependencies).length === 0 ? {} : { dependencies }),
  };
  return Buffer.from(`${JSON.stringify(projected, null, 2)}\n`);
}

function validPayloadPath(relativePath, root) {
  if (relativePath.startsWith(".") || relativePath.includes("\\") || /[\u0000-\u001f\u007f]/.test(relativePath)
      || relativePath.split("/").some((part) => part === "" || part === "." || part === ".." || part.startsWith("."))) {
    return false;
  }
  if (root === "dist") {
    return /(?:\.js|\.js\.map|\.d\.ts|\.d\.ts\.map)$/.test(relativePath);
  }
  if (root === "schemas" || root === "fixtures") return relativePath.endsWith(".json");
  if (root === "openapi") return /\.ya?ml$/.test(relativePath);
  return false;
}

function walkClosedRoot(packageDirectory, rootName) {
  const rootPath = join(packageDirectory, rootName);
  const result = [];
  const visit = (directory, prefix) => {
    try {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory) throw new Error();
      const names = readdirSync(directory).sort(binaryCompare);
      if (names.length === 0) throw new Error();
      for (const name of names) {
        if (name === "" || name === "." || name === ".." || name.startsWith(".") || name.includes("/") || name.includes("\\")) {
          throw new Error();
        }
        const path = join(directory, name);
        const relativePath = prefix === "" ? name : `${prefix}/${name}`;
        const entry = lstatSync(path);
        if (entry.isSymbolicLink()) throw new Error();
        if (entry.isDirectory()) visit(path, relativePath);
        else if (entry.isFile() && entry.nlink === 1 && validPayloadPath(relativePath, rootName)) {
          result.push(`${rootName}/${relativePath}`);
        } else throw new Error();
      }
    } catch {
      fixedFailure();
    }
  };
  visit(rootPath, "");
  return result;
}

function capturePackage(root, artifact, version, rootLicense) {
  const contract = CONTRACTS[artifact.name];
  if (contract === undefined) fixedFailure();
  const packageDirectory = resolve(root, artifact.directory);
  if (relative(root, packageDirectory).startsWith("..") || realpathSync(packageDirectory) !== packageDirectory) fixedFailure();
  const manifestRecord = safeRead(join(packageDirectory, "package.json"), 1024 * 1024);
  const manifest = parseJson(manifestRecord.bytes);
  validateManifest(manifest, artifact, version, contract);
  const readmeRecord = safeRead(join(packageDirectory, "README.md"), 1024 * 1024);
  const licenseRecord = safeRead(join(packageDirectory, "LICENSE"), 1024 * 1024);
  if (readmeRecord.bytes.length === 0 || !licenseRecord.bytes.equals(rootLicense)) fixedFailure();
  const paths = contract.roots.flatMap((rootName) => walkClosedRoot(packageDirectory, rootName)).sort(binaryCompare);
  if (!paths.includes("dist/index.js") || !paths.includes("dist/index.d.ts")) fixedFailure();
  const records = new Map([
    ["README.md", readmeRecord],
    ["LICENSE", licenseRecord],
    ...paths.map((path) => [path, safeRead(join(packageDirectory, ...path.split("/")))]),
  ]);
  const binTargets = new Set(Object.values(contract.bin ?? {}).map((path) => path.replace(/^\.\//, "")));
  for (const target of binTargets) {
    if (!records.has(target) || (records.get(target).stat.mode & 0o111n) === 0n) fixedFailure();
  }
  let sourceBytes = manifestRecord.bytes.length;
  for (const record of records.values()) sourceBytes += record.bytes.length;
  if (records.size > MAX_ARCHIVE_ENTRIES || sourceBytes > MAX_SOURCE_BYTES) fixedFailure();
  const projectionManifest = projectedManifest(manifest, version);
  return Object.freeze({
    artifact,
    contract,
    packageDirectory,
    manifestRecord,
    projectedManifest: projectionManifest,
    records,
    sourcePaths: Object.freeze(["package.json", ...records.keys()].sort(binaryCompare)),
  });
}

function ensureDirectory(path) {
  mkdirSync(path, { mode: 0o700, recursive: true });
  chmodSync(path, 0o700);
}

function writeProjection(projectionRoot, captured) {
  ensureDirectory(projectionRoot);
  const binTargets = new Set(Object.values(captured.contract.bin ?? {}).map((path) => path.replace(/^\.\//, "")));
  const entries = new Map([["package.json", { bytes: captured.projectedManifest, mode: 0o644 }]]);
  for (const [path, record] of captured.records) {
    entries.set(path, { bytes: record.bytes, mode: binTargets.has(path) ? 0o755 : 0o644 });
  }
  for (const [relativePath, { bytes, mode }] of [...entries].sort(([left], [right]) => binaryCompare(left, right))) {
    const destination = join(projectionRoot, ...relativePath.split("/"));
    ensureDirectory(dirname(destination));
    const descriptor = openSync(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
    try {
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    chmodSync(destination, mode);
    utimesSync(destination, NORMALIZED_DATE, NORMALIZED_DATE);
  }
  return entries;
}

function tarText(block, offset, length) {
  const field = block.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  const end = nul === -1 ? field.length : nul;
  if (field.subarray(end).some((byte) => byte !== 0)
      || field.subarray(0, end).some((byte) => byte < 0x21 || byte > 0x7e)) throw new Error();
  return field.subarray(0, end).toString("ascii");
}

function exactTarField(block, offset, expected) {
  return block.subarray(offset, offset + expected.length).equals(Buffer.from(expected, "ascii"));
}

function tarOctal(block, offset, length, ending) {
  const field = block.subarray(offset, offset + length);
  const digits = field.subarray(0, length - ending.length).toString("ascii");
  if (!/^[0-7]+$/.test(digits) || !field.subarray(length - ending.length).equals(Buffer.from(ending, "ascii"))) {
    throw new Error();
  }
  return Number.parseInt(digits, 8);
}

function canonicalGzip(archive) {
  if (!Buffer.isBuffer(archive) || archive.length < 18 || archive.length > MAX_ARCHIVE_BYTES
      || !archive.subarray(0, 9).equals(Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x00]))
      || ![0x03, 0x13].includes(archive[9])) fixedFailure();
  let result;
  try {
    result = inflateRawSync(archive.subarray(10), { info: true, maxOutputLength: MAX_TAR_BYTES });
  } catch {
    fixedFailure();
  }
  const tar = result.buffer;
  const deflateBytes = result.engine.bytesWritten;
  const trailerOffset = 10 + deflateBytes;
  if (!Buffer.isBuffer(tar) || tar.length === 0 || tar.length > MAX_TAR_BYTES
      || !Number.isSafeInteger(deflateBytes) || deflateBytes <= 0
      || trailerOffset + 8 !== archive.length
      || archive.readUInt32LE(trailerOffset) !== (crc32(tar) >>> 0)
      || archive.readUInt32LE(trailerOffset + 4) !== (tar.length >>> 0)) fixedFailure();
  const normalized = Buffer.from(archive);
  normalized[9] = 0x03;
  return Object.freeze({ archive: normalized, tar });
}

function parseTarGzip(archive) {
  const canonical = canonicalGzip(archive);
  const { tar } = canonical;
  if (tar.length === 0 || tar.length % 512 !== 0) fixedFailure();
  const entries = [];
  const names = new Set();
  let offset = 0;
  let sawEndOfArchive = false;
  while (offset < tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (offset + 1024 !== tar.length || !tar.subarray(offset).every((byte) => byte === 0)) fixedFailure();
      sawEndOfArchive = true;
      offset = tar.length;
      break;
    }
    if (entries.length >= MAX_ARCHIVE_ENTRIES
        || !exactTarField(header, 257, "ustar\0") || !exactTarField(header, 263, "00")
        || !header.subarray(157, 257).every((byte) => byte === 0)
        || !header.subarray(265, 329).every((byte) => byte === 0)
        || !exactTarField(header, 329, "000000 \0") || !exactTarField(header, 337, "000000 \0")
        || !header.subarray(500, 512).every((byte) => byte === 0)) fixedFailure();
    let storedChecksum;
    let size;
    let mode;
    let mtime;
    try {
      storedChecksum = tarOctal(header, 148, 8, " \0");
      size = tarOctal(header, 124, 12, " ");
      mode = tarOctal(header, 100, 8, " \0");
      mtime = tarOctal(header, 136, 12, " ");
    } catch {
      fixedFailure();
    }
    let checksum = 0;
    for (let index = 0; index < 512; index += 1) checksum += index >= 148 && index < 156 ? 0x20 : header[index];
    const name = tarText(header, 0, 100);
    const prefix = tarText(header, 345, 155);
    const fullName = prefix === "" ? name : `${prefix}/${name}`;
    const parts = fullName.split("/");
    const payloadOffset = offset + 512;
    const payloadEnd = payloadOffset + size;
    const recordEnd = payloadOffset + Math.ceil(size / 512) * 512;
    if (checksum !== storedChecksum || names.has(fullName) || !fullName.startsWith("package/")
        || fullName.includes("\\") || /[\u0000-\u001f\u007f]/.test(fullName)
        || parts.some((part) => part === "" || part === "." || part === "..")
        || payloadEnd > tar.length || recordEnd > tar.length || header[156] !== 0x30
        || !exactTarField(header, 108, "000000 \0") || !exactTarField(header, 116, "000000 \0")
        || mtime !== NPM_TAR_MTIME_SECONDS
        || !tar.subarray(payloadEnd, recordEnd).every((byte) => byte === 0)) fixedFailure();
    names.add(fullName);
    entries.push(Object.freeze({ name: fullName, mode, payload: tar.subarray(payloadOffset, payloadEnd) }));
    offset = recordEnd;
  }
  if (entries.length === 0 || !sawEndOfArchive) fixedFailure();
  return Object.freeze({ archive: canonical.archive, entries });
}

function validateArchive(archive, captured, projectionEntries, version) {
  const parsed = parseTarGzip(archive);
  const { entries } = parsed;
  const expected = new Map([...projectionEntries].map(([path, record]) => [`package/${path}`, record]));
  if (entries.length !== expected.size) fixedFailure();
  for (const entry of entries) {
    const wanted = expected.get(entry.name);
    if (wanted === undefined || entry.mode !== wanted.mode
        || (entry.name !== "package/package.json" && !entry.payload.equals(wanted.bytes))) fixedFailure();
    expected.delete(entry.name);
  }
  if (expected.size !== 0) fixedFailure();
  const packedManifest = parseJson(entries.find(({ name }) => name === "package/package.json")?.payload ?? Buffer.alloc(0));
  if (!exactJson(packedManifest, JSON.parse(captured.projectedManifest.toString("utf8")))) fixedFailure();
  for (const value of Object.values(packedManifest.dependencies ?? {})) {
    if (String(value).startsWith("workspace:")) fixedFailure();
  }
  if (packedManifest.version !== version || packedManifest.scripts !== undefined
      || packedManifest.devDependencies !== undefined) fixedFailure();
  return parsed.archive;
}

function packageEnvironment(workspace) {
  const path = process.env.PATH;
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) fixedFailure();
  const home = join(workspace, "home");
  const temporary = join(workspace, "tmp");
  const cache = join(workspace, "cache");
  ensureDirectory(home);
  ensureDirectory(temporary);
  ensureDirectory(cache);
  const userconfig = join(workspace, "npmrc");
  writeFileSync(userconfig, "", { mode: 0o600, flag: "wx" });
  writeFileSync(
    join(workspace, "package.json"),
    '{"private":true,"packageManager":"pnpm@11.24.0"}\n',
    { mode: 0o600, flag: "wx" },
  );
  return Object.freeze({
    environment: Object.freeze({
      PATH: path,
      HOME: home,
      TMPDIR: temporary,
      LANG: "C",
      LC_ALL: "C",
      TZ: "UTC",
      CI: "true",
      NO_COLOR: "1",
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
      npm_config_userconfig: userconfig,
      npm_config_cache: cache,
      npm_config_ignore_scripts: "true",
      npm_config_registry: "http://127.0.0.1:9",
      npm_config_update_notifier: "false",
    }),
  });
}

async function runPnpm(arguments_, cwd, environment) {
  try {
    return await execFileAsync("pnpm", arguments_, {
      cwd,
      env: environment,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
  } catch {
    fixedFailure();
  }
}

function archiveName(name, version) {
  return `${name.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`;
}

function assertCapturedUnchanged(captured) {
  const currentManifest = safeRead(join(captured.packageDirectory, "package.json"), 1024 * 1024);
  if (!currentManifest.bytes.equals(captured.manifestRecord.bytes)
      || !sameFile(currentManifest.stat, captured.manifestRecord.stat)) fixedFailure();
  const current = new Map([
    ["README.md", safeRead(join(captured.packageDirectory, "README.md"), 1024 * 1024)],
    ["LICENSE", safeRead(join(captured.packageDirectory, "LICENSE"), 1024 * 1024)],
    ...captured.contract.roots.flatMap((rootName) => walkClosedRoot(captured.packageDirectory, rootName))
      .sort(binaryCompare)
      .map((path) => [path, safeRead(join(captured.packageDirectory, ...path.split("/")))]),
  ]);
  if (current.size !== captured.records.size) fixedFailure();
  for (const [path, expected] of captured.records) {
    const actual = current.get(path);
    if (actual === undefined || !actual.bytes.equals(expected.bytes) || !sameFile(actual.stat, expected.stat)) fixedFailure();
  }
}

function readDescriptor(descriptor, maximumBytes) {
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
        || before.size < 0n || before.size > BigInt(maximumBytes)) throw new Error();
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new Error();
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameFile(before, after)) throw new Error();
    return Object.freeze({ bytes, stat: before });
  } catch {
    fixedFailure();
  }
}

function assertPublishedFile(directory, published, expectedMode) {
  const path = join(directory, published.archive.filename);
  for (let pass = 0; pass < 2; pass += 1) {
    const pathname = safeRead(path, MAX_ARCHIVE_BYTES);
    const retained = readDescriptor(published.descriptor, MAX_ARCHIVE_BYTES);
    if (pathname.stat.dev !== retained.stat.dev || pathname.stat.ino !== retained.stat.ino
        || !pathname.bytes.equals(published.expectedBytes) || !retained.bytes.equals(published.expectedBytes)
        || createHash("sha256").update(pathname.bytes).digest("hex") !== published.expectedSha256
        || createHash("sha256").update(retained.bytes).digest("hex") !== published.expectedSha256
        || (expectedMode !== undefined
          && ((pathname.stat.mode & 0o777n) !== BigInt(expectedMode)
            || (retained.stat.mode & 0o777n) !== BigInt(expectedMode)))) fixedFailure();
  }
}

function assertPublicationDirectory(directory, directoryGuard, published, ancestorGuards, expectedMode) {
  assertAncestorGuards(ancestorGuards);
  assertDirectoryGuardAt(directory, directoryGuard);
  const expectedNames = published.map(({ archive }) => archive.filename).sort(binaryCompare);
  if (!exactJson(readdirSync(directory).sort(binaryCompare), expectedNames)) fixedFailure();
  for (const record of published) assertPublishedFile(directory, record, expectedMode);
  assertDirectoryGuardAt(directory, directoryGuard);
  assertAncestorGuards(ancestorGuards);
}

function assertEmptyOutput(outputDirectory, outputGuard, ancestorGuards) {
  assertAncestorGuards(ancestorGuards);
  assertDirectoryGuardAt(outputDirectory, outputGuard);
  if (readdirSync(outputDirectory).length !== 0) fixedFailure();
  assertDirectoryGuardAt(outputDirectory, outputGuard);
  assertAncestorGuards(ancestorGuards);
}

function writeDescriptor(descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (count <= 0) fixedFailure();
    offset += count;
  }
}

function closePublication(publication) {
  for (const { descriptor } of publication.published) closeSync(descriptor);
  closeSync(publication.directoryGuard.descriptor);
}

function promoteArchives(outputDirectory, archives, outputGuard, ancestorGuards) {
  const readyDirectory = mkdtempSync(join(dirname(outputDirectory), ".gauntlet-npm-ready-"));
  chmodSync(readyDirectory, 0o700);
  const directoryGuard = openDirectoryGuard(readyDirectory);
  const published = [];
  try {
    if (directoryGuard.signature.dev !== outputGuard.signature.dev) fixedFailure();
    assertEmptyOutput(outputDirectory, outputGuard, ancestorGuards);
    for (const archive of archives) {
      assertEmptyOutput(outputDirectory, outputGuard, ancestorGuards);
      assertPublicationDirectory(readyDirectory, directoryGuard, published, ancestorGuards, 0o600);
      const descriptor = openSync(
        join(readyDirectory, archive.filename),
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        0o600,
      );
      const record = {
        archive,
        descriptor,
        expectedBytes: Buffer.alloc(0),
        expectedSha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
      };
      published.push(record);
      assertPublicationDirectory(readyDirectory, directoryGuard, published, ancestorGuards, undefined);
      assertPublishedFile(readyDirectory, record, undefined);
      writeDescriptor(descriptor, archive.bytes);
      record.expectedBytes = archive.bytes;
      record.expectedSha256 = archive.sha256;
      assertPublicationDirectory(readyDirectory, directoryGuard, published, ancestorGuards, undefined);
      fchmodSync(descriptor, 0o600);
      assertPublicationDirectory(readyDirectory, directoryGuard, published, ancestorGuards, 0o600);
      fsyncSync(descriptor);
      assertPublicationDirectory(readyDirectory, directoryGuard, published, ancestorGuards, 0o600);
    }
    fsyncSync(directoryGuard.descriptor);
    assertPublicationDirectory(readyDirectory, directoryGuard, published, ancestorGuards, 0o600);
    assertEmptyOutput(outputDirectory, outputGuard, ancestorGuards);
    renameSync(readyDirectory, outputDirectory);
    assertPublicationDirectory(outputDirectory, directoryGuard, published, ancestorGuards, 0o600);
    fsyncSync(ancestorGuards[0].guard.descriptor);
    assertPublicationDirectory(outputDirectory, directoryGuard, published, ancestorGuards, 0o600);
    return Object.freeze({ directoryGuard, published: Object.freeze(published.map((record) => Object.freeze(record))) });
  } catch {
    for (const { descriptor } of published) closeSync(descriptor);
    closeSync(directoryGuard.descriptor);
    // Do not clean the ready path here. A same-UID actor can replace that pathname
    // after the retained guard is closed; pathname deletion could then remove foreign
    // bytes. Pre-promotion ambiguity therefore fails closed and leaves quarantine.
    fixedFailure();
  }
}

export async function stageNpmPackages(options) {
  const { root, outputDirectory } = validateClosedOptions(options);
  validateCanonicalDirectory(root, "NPM staging root");
  validateCanonicalDirectory(outputDirectory, "NPM staging output", { privateDirectory: true });
  const rootPrefix = `${root}${sep}`;
  const outputPrefix = `${outputDirectory}${sep}`;
  if (outputDirectory.startsWith(rootPrefix) || root.startsWith(outputPrefix)
      || readdirSync(outputDirectory).length !== 0) fixedFailure();
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 24 || nodeMajor > 26) fixedFailure();

  const ancestorGuards = openAncestorGuards(dirname(outputDirectory));
  let outputGuard;
  let workspace;
  let workspaceSignature;
  let publication;
  let version;
  let result;
  const archives = [];
  let primaryError;
  try {
    outputGuard = openDirectoryGuard(outputDirectory);
    assertEmptyOutput(outputDirectory, outputGuard, ancestorGuards);
    const rootLicense = safeRead(join(root, "LICENSE"), 1024 * 1024).bytes;
    version = readReleaseVersion(root);
    const captures = RELEASE_ARTIFACTS.npm.map((artifact) => capturePackage(root, artifact, version, rootLicense));
    workspace = mkdtempSync(join(dirname(outputDirectory), ".gauntlet-npm-stage-"));
    chmodSync(workspace, 0o700);
    workspaceSignature = directorySignature(workspace);
    const { environment } = packageEnvironment(workspace);
    const versionResult = await runPnpm(["--version"], workspace, environment);
    if (versionResult.stdout !== `${PNPM_VERSION}\n` || versionResult.stderr !== "") fixedFailure();

    for (const [index, captured] of captures.entries()) {
      const projection = join(workspace, `package-${index}`);
      const packOutput = join(workspace, `packed-${index}`);
      ensureDirectory(packOutput);
      const projectionEntries = writeProjection(projection, captured);
      const packResult = await runPnpm([
        "--config.ignore-scripts=true",
        "--config.ignore-pnpmfile=true",
        "--config.offline=true",
        "pack",
        "--json",
        "--pack-destination",
        packOutput,
      ], projection, environment);
      const entries = readdirSync(packOutput).sort(binaryCompare);
      const filename = archiveName(captured.artifact.name, version);
      if (entries.length !== 1 || entries[0] !== filename) fixedFailure();
      let packReport;
      try {
        packReport = JSON.parse(packResult.stdout);
      } catch {
        fixedFailure();
      }
      const expectedReportPaths = [...projectionEntries.keys()].sort(binaryCompare);
      if (packResult.stderr !== "" || packReport === null || typeof packReport !== "object"
          || Array.isArray(packReport)
          || !exactJson(Object.keys(packReport), ["name", "version", "filename", "files"])
          || packReport.name !== captured.artifact.name || packReport.version !== version
          || packReport.filename !== join(packOutput, filename) || !Array.isArray(packReport.files)
          || packReport.files.length !== expectedReportPaths.length
          || !exactJson(
            packReport.files.map((record) => {
              if (record === null || typeof record !== "object" || Array.isArray(record)
                  || !exactJson(Object.keys(record), ["path"]) || typeof record.path !== "string") fixedFailure();
              return record.path;
            }).sort(binaryCompare),
            expectedReportPaths,
          )) fixedFailure();
      const archive = validateArchive(
        safeRead(join(packOutput, filename), MAX_ARCHIVE_BYTES).bytes,
        captured,
        projectionEntries,
        version,
      );
      archives.push(Object.freeze({
        bytes: archive,
        filename,
        name: captured.artifact.name,
        sha256: createHash("sha256").update(archive).digest("hex"),
      }));
    }
    for (const captured of captures) assertCapturedUnchanged(captured);
    assertEmptyOutput(outputDirectory, outputGuard, ancestorGuards);
    publication = promoteArchives(outputDirectory, archives, outputGuard, ancestorGuards);
  } catch (error) {
    primaryError = error;
  } finally {
    if (workspace !== undefined) {
      try {
        assertDirectoryUnchanged(workspace, workspaceSignature);
        rmSync(workspace, { recursive: true, force: false });
      } catch {
        if (primaryError === undefined) primaryError = new Error("NPM staging scratch cleanup failed");
      }
    }
    if (primaryError === undefined && publication !== undefined) {
      try {
        assertPublicationDirectory(outputDirectory, publication.directoryGuard, publication.published, ancestorGuards, 0o600);
        result = Object.freeze([...archives]
          .sort((left, right) => binaryCompare(left.name, right.name))
          .map((archive) => Object.freeze({
            kind: "npm",
            name: archive.name,
            version,
            path: join(outputDirectory, archive.filename),
            sha256: archive.sha256,
          })));
        assertPublicationDirectory(outputDirectory, publication.directoryGuard, publication.published, ancestorGuards, 0o600);
      } catch (error) {
        primaryError = error;
      }
    }
    if (publication !== undefined) closePublication(publication);
    if (outputGuard !== undefined) closeSync(outputGuard.descriptor);
    closeAncestorGuards(ancestorGuards);
  }
  if (primaryError !== undefined) throw primaryError;
  return result;
}
