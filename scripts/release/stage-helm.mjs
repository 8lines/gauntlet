import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { types as utilTypes } from "node:util";

import { packageChart } from "../../deploy/helm/package-chart.mjs";
import { readReleaseVersion, RELEASE_ARTIFACTS } from "./release-model.mjs";

const FAILURE = "Helm chart staging failed closed";
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;

function failClosed() {
  throw new Error(FAILURE);
}
function optionsOf(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options) || utilTypes.isProxy(options)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) {
    throw new TypeError("Helm staging options must be a closed data object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== 2 || !keys.includes("root") || !keys.includes("outputDirectory")
      || keys.some((key) => typeof key !== "string" || !["root", "outputDirectory"].includes(key)
        || descriptors[key].enumerable !== true || !("value" in descriptors[key]))) {
    throw new TypeError("Helm staging options must be a closed data object");
  }
  return Object.freeze({ root: descriptors.root.value, outputDirectory: descriptors.outputDirectory.value });
}

function canonicalDirectory(path, label, privateDirectory = false) {
  try {
    if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path || path === sep
        || /[\u0000-\u001f\u007f,]/u.test(path)) throw new Error();
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) throw new Error();
    if (privateDirectory) {
      const uid = typeof process.geteuid === "function" ? BigInt(process.geteuid()) : stat.uid;
      if (stat.uid !== uid || (stat.mode & 0o077n) !== 0n) throw new Error();
    }
  } catch {
    throw new TypeError(`${label} must be a safe canonical directory`);
  }
}

function sameFile(left, right) {
  return left.isFile() && right.isFile() && !left.isSymbolicLink() && !right.isSymbolicLink()
    && left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.uid === right.uid && left.gid === right.gid && left.nlink === 1n && right.nlink === 1n
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function hashArchive(path) {
  let descriptor;
  try {
    if (realpathSync(path) !== path) failClosed();
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(descriptor, { bigint: true });
    const pathname = lstatSync(path, { bigint: true });
    if (!sameFile(before, pathname) || before.size <= 0n || before.size > BigInt(MAX_ARCHIVE_BYTES)) failClosed();
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < Number(before.size)) {
      const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, Number(before.size) - offset), offset);
      if (count <= 0) failClosed();
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(path, { bigint: true });
    if (!sameFile(before, after) || !sameFile(after, afterPath)) failClosed();
    return hash.digest("hex");
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function packageHelmChart(options, testing = {}) {
  const { root, outputDirectory } = optionsOf(options);
  canonicalDirectory(root, "Helm staging root");
  canonicalDirectory(outputDirectory, "Helm staging output", true);
  if (outputDirectory.startsWith(`${root}${sep}`) || root.startsWith(`${outputDirectory}${sep}`)
      || readdirSync(outputDirectory).length !== 0) failClosed();
  const packager = testing.packageChart ?? packageChart;
  if (typeof packager !== "function" || Object.keys(testing).some((key) => key !== "packageChart")) {
    throw new TypeError("Helm staging testing hooks are invalid");
  }
  const version = readReleaseVersion(root);
  const expectedPath = join(outputDirectory, `${RELEASE_ARTIFACTS.chart.name}-${version}.tgz`);
  const receipt = packager({ destinationDirectory: outputDirectory, sourceRepositoryRoot: root });
  if (receipt === null || typeof receipt !== "object" || receipt.version !== version
      || receipt.archivePath !== expectedPath || !Array.isArray(receipt.cleanupPending)
      || receipt.cleanupPending.length !== 0 || readdirSync(outputDirectory).length !== 1
      || readdirSync(outputDirectory)[0] !== `${RELEASE_ARTIFACTS.chart.name}-${version}.tgz`) failClosed();
  return Object.freeze({
    kind: "helm",
    name: RELEASE_ARTIFACTS.chart.name,
    path: expectedPath,
    sha256: hashArchive(expectedPath),
    version,
  });
}
