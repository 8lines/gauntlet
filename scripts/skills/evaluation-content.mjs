import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 1024;
const LAYOUT_FAILURE = "Evaluation inputs must use a closed regular-file layout";
const excludedRootEntries = new Set(["results", "verification.json"]);
const HASH_DOMAIN = Buffer.from("8lines.gauntlet/evaluation-inputs/sha256/v1", "ascii");

const compare = (left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
const fail = () => { throw new Error(LAYOUT_FAILURE); };

function lengthFrame(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail();
  const frame = Buffer.alloc(8);
  frame.writeBigUInt64BE(BigInt(value));
  return frame;
}

function safeDirectory(path) {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022n) !== 0n) fail();
}

function safeFile(path) {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size < 1n
      || stat.size > BigInt(MAX_FILE_BYTES) || (stat.mode & 0o022n) !== 0n) fail();
  return stat;
}

function sameFile(left, right) {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino
    && left.mode === right.mode && left.nlink === right.nlink && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function readStable(path) {
  let descriptor;
  try {
    const before = safeFile(path);
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_CLOEXEC);
    const descriptorBefore = fstatSync(descriptor, { bigint: true });
    if (!sameFile(before, descriptorBefore)) fail();
    const bytes = Buffer.alloc(Number(descriptorBefore.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) fail();
      offset += count;
    }
    const descriptorAfter = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(path, { bigint: true });
    if (!sameFile(descriptorBefore, descriptorAfter) || !sameFile(descriptorAfter, pathAfter)) fail();
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.message === LAYOUT_FAILURE) throw error;
    fail();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function listEvaluationInputFiles(evaluationRoot) {
  try {
    if (typeof evaluationRoot !== "string" || !isAbsolute(evaluationRoot) || resolve(evaluationRoot) !== evaluationRoot
        || evaluationRoot === "/" || evaluationRoot.includes("\0")) fail();
    const files = [];
    const visit = (directory) => {
      safeDirectory(directory);
      for (const entry of readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => compare(left.name, right.name))) {
        const path = resolve(directory, entry.name);
        const relativePath = relative(evaluationRoot, path).split(sep).join("/");
        if (!relativePath.includes("/") && (excludedRootEntries.has(entry.name) || entry.name.endsWith("-findings.md"))) {
          if (entry.isSymbolicLink()) fail();
          if (entry.name === "results") safeDirectory(path);
          else safeFile(path);
          continue;
        }
        if (entry.isSymbolicLink()) fail();
        if (entry.isDirectory()) visit(path);
        else if (entry.isFile()) {
          safeFile(path);
          files.push(relativePath);
          if (files.length > MAX_FILES) fail();
        } else fail();
      }
    };
    visit(evaluationRoot);
    if (files.length === 0) fail();
    return Object.freeze(files.sort(compare));
  } catch (error) {
    if (error instanceof Error && error.message === LAYOUT_FAILURE) throw error;
    fail();
  }
}

export function hashEvaluationInputs(evaluationRoot) {
  const hash = createHash("sha256");
  const files = listEvaluationInputFiles(evaluationRoot);
  hash.update(lengthFrame(HASH_DOMAIN.length));
  hash.update(HASH_DOMAIN);
  hash.update(lengthFrame(files.length));
  let total = 0;
  for (const relativePath of files) {
    const pathBytes = Buffer.from(relativePath, "utf8");
    const bytes = readStable(resolve(evaluationRoot, ...relativePath.split("/")));
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) fail();
    hash.update(lengthFrame(pathBytes.length));
    hash.update(pathBytes);
    hash.update(lengthFrame(bytes.length));
    hash.update(bytes);
  }
  return hash.digest("hex");
}
