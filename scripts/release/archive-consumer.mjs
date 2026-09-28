import { randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { types as utilTypes } from "node:util";

import { materializeCanonicalTreeArchive } from "./tree-archive.mjs";

const FAILURE = "Release archive consumer failed closed";
const CLEANUP_FAILURE = "Release archive consumer cleanup failed closed";
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_PREFIX = /^[A-Za-z0-9@._+-]{1,96}$/u;
const SAFE_WORKSPACE_PREFIX = /^[a-z0-9][a-z0-9-]{0,63}-$/u;
const QUARANTINE_TOKEN = /^[0-9a-f]{32}$/u;
const MAX_JOURNAL_ENTRIES = 20_004;
const MAX_JOURNAL_DEPTH = 35;

function failClosed() {
  throw new Error(FAILURE);
}

function exactOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options) || utilTypes.isProxy(options)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) failClosed();
  const expected = ["archivePath", "expectedPrefix", "expectedSha256"];
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))
      || keys.some((key) => typeof key !== "string" || !expected.includes(key)
        || descriptors[key].enumerable !== true || !("value" in descriptors[key]))) failClosed();
  const values = Object.fromEntries(expected.map((key) => [key, descriptors[key].value]));
  if (typeof values.archivePath !== "string" || !isAbsolute(values.archivePath)
      || resolve(values.archivePath) !== values.archivePath || values.archivePath === sep
      || /[\u0000-\u001f\u007f]/u.test(values.archivePath)
      || typeof values.expectedPrefix !== "string" || !SAFE_PREFIX.test(values.expectedPrefix)
      || typeof values.expectedSha256 !== "string" || !SHA256.test(values.expectedSha256)) failClosed();
  return Object.freeze(values);
}

function canonicalTemporaryBase() {
  try {
    const candidate = process.env.TMPDIR ?? tmpdir();
    if (typeof candidate !== "string" || !isAbsolute(candidate) || /[\u0000-\u001f\u007f]/u.test(candidate)) failClosed();
    const path = realpathSync(candidate);
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || path === sep) failClosed();
    return Object.freeze({ path, dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode });
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  }
}

function createWorkspace(prefix = "gauntlet-release-consumer-") {
  let root;
  try {
    if (typeof prefix !== "string" || !SAFE_WORKSPACE_PREFIX.test(prefix)) failClosed();
    const base = canonicalTemporaryBase();
    root = realpathSync(mkdtempSync(join(base.path, prefix)));
    chmodSync(root, 0o700);
    const stat = lstatSync(root, { bigint: true });
    const uid = typeof process.geteuid === "function" ? BigInt(process.geteuid()) : stat.uid;
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || realpathSync(root) !== root
        || (stat.mode & 0o077n) !== 0n) failClosed();
    return Object.freeze({ root, dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode, base });
  } catch (error) {
    if (root !== undefined) {
      try {
        const stat = lstatSync(root, { bigint: true });
        if (stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(root) === root
            && readdirSync(root).length === 0) rmdirSync(root);
      } catch {
        // A non-empty, replaced, or ambiguous workspace is preserved.
      }
    }
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  }
}

function sameIdentity(stat, record) {
  return stat.dev === record.dev && stat.ino === record.ino && stat.uid === record.uid && stat.mode === record.mode;
}

function captureWorkspace(workspace) {
  const records = [];
  const visit = (path, depth) => {
    if (depth > MAX_JOURNAL_DEPTH || records.length >= MAX_JOURNAL_ENTRIES) failClosed();
    const stat = lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink()) failClosed();
    const type = stat.isDirectory() ? "directory" : stat.isFile() && stat.nlink === 1n ? "file" : undefined;
    if (type === undefined || (type === "directory" && realpathSync(path) !== path)) failClosed();
    records.push(Object.freeze({
      path,
      type,
      dev: stat.dev,
      ino: stat.ino,
      uid: stat.uid,
      mode: stat.mode,
    }));
    if (type === "directory") {
      for (const name of readdirSync(path).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))) {
        if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\\")
            || /[\u0000-\u001f\u007f]/u.test(name)) failClosed();
        visit(resolve(path, name), depth + 1);
      }
    }
  };
  visit(workspace.root, 0);
  const root = records[0];
  if (root.type !== "directory" || !sameIdentity(workspace, root)) failClosed();
  return Object.freeze(records);
}

function sameJournal(left, right) {
  if (left.length !== right.length) return false;
  return left.every((record, index) => {
    const current = right[index];
    return current.path === record.path && current.type === record.type && sameIdentity(current, record);
  });
}

function pathAbsent(path) {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

function assertWorkspace(workspace) {
  const stat = lstatSync(workspace.root, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(workspace.root) !== workspace.root
      || !sameIdentity(stat, workspace)) failClosed();
}

function assertWorkspaceBase(workspace) {
  const stat = lstatSync(workspace.base.path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(workspace.base.path) !== workspace.base.path
      || !sameIdentity(stat, workspace.base)) failClosed();
}

function removeWorkspace(workspace, journal, assertContext = () => {}) {
  try {
    assertContext();
    if (!sameJournal(journal, captureWorkspace(workspace))) return false;
  } catch {
    return false;
  }
  const files = journal.filter(({ type }) => type === "file").toReversed();
  const directories = journal.filter(({ type }) => type === "directory").toReversed();
  for (const record of files) {
    try {
      assertContext();
      const stat = lstatSync(record.path, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || !sameIdentity(stat, record)) return false;
      unlinkSync(record.path);
      if (!pathAbsent(record.path)) return false;
    } catch {
      return false;
    }
  }
  for (const record of directories) {
    try {
      assertContext();
      const stat = lstatSync(record.path, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(record.path) !== record.path
          || !sameIdentity(stat, record)) return false;
      rmdirSync(record.path);
      if (!pathAbsent(record.path)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function workspaceOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options) || utilTypes.isProxy(options)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) failClosed();
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== 1 || keys[0] !== "prefix" || descriptors.prefix.enumerable !== true
      || !("value" in descriptors.prefix) || typeof descriptors.prefix.value !== "string"
      || !SAFE_WORKSPACE_PREFIX.test(descriptors.prefix.value)) failClosed();
  return Object.freeze({ prefix: descriptors.prefix.value });
}

function cleanupOptions(overrides) {
  if (overrides === undefined) return Object.freeze({
    quarantineToken: randomBytes(16).toString("hex"),
    beforeRemoval: () => undefined,
  });
  if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides) || utilTypes.isProxy(overrides)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(overrides))) failClosed();
  const descriptors = Object.getOwnPropertyDescriptors(overrides);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== 2 || !keys.includes("quarantineToken") || !keys.includes("beforeRemoval")
      || keys.some((key) => typeof key !== "string" || !["quarantineToken", "beforeRemoval"].includes(key)
        || descriptors[key].enumerable !== true || !("value" in descriptors[key]))
      || typeof descriptors.quarantineToken.value !== "string"
      || !QUARANTINE_TOKEN.test(descriptors.quarantineToken.value)
      || typeof descriptors.beforeRemoval.value !== "function") failClosed();
  return Object.freeze({
    quarantineToken: descriptors.quarantineToken.value,
    beforeRemoval: descriptors.beforeRemoval.value,
  });
}

function cleanOwnedWorkspace(workspace, overrides) {
  const values = cleanupOptions(overrides);
  const quarantinePath = join(workspace.base.path, `.gauntlet-retired-workspace-${values.quarantineToken}`);
  let quarantined;
  try {
    assertWorkspaceBase(workspace);
    assertWorkspace(workspace);
    if (!pathAbsent(quarantinePath)) failClosed();
    renameSync(workspace.root, quarantinePath);
    quarantined = Object.freeze({ ...workspace, root: quarantinePath });
    assertWorkspace(quarantined);
    if (!pathAbsent(workspace.root)) failClosed();
    const journal = captureWorkspace(quarantined);
    const hookResult = values.beforeRemoval(Object.freeze({ path: quarantinePath }));
    if (hookResult !== undefined) failClosed();
    const assertContext = () => {
      assertWorkspaceBase(workspace);
      assertWorkspace(quarantined);
      if (!pathAbsent(workspace.root)) failClosed();
    };
    if (!removeWorkspace(quarantined, journal, assertContext)) failClosed();
    if (!pathAbsent(quarantinePath) || !pathAbsent(workspace.root)) failClosed();
  } catch {
    throw new Error(CLEANUP_FAILURE);
  }
}

export async function withOwnedTemporaryWorkspace(options, consumer, cleanupOverrides) {
  const values = workspaceOptions(options);
  if (typeof consumer !== "function") failClosed();
  const workspace = createWorkspace(values.prefix);
  try {
    return await consumer(workspace.root);
  } finally {
    cleanOwnedWorkspace(workspace, cleanupOverrides);
  }
}

function materializedPath(receipt, outputDirectory, expectedPrefix) {
  try {
    if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt) || utilTypes.isProxy(receipt)
        || !Object.isFrozen(receipt) || ![Object.prototype, null].includes(Object.getPrototypeOf(receipt))) failClosed();
    const descriptors = Object.getOwnPropertyDescriptors(receipt);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== 1 || keys[0] !== "path" || descriptors.path.enumerable !== true
        || !("value" in descriptors.path)) failClosed();
    const expectedPath = resolve(outputDirectory, expectedPrefix);
    const path = descriptors.path.value;
    const stat = lstatSync(path, { bigint: true });
    if (path !== expectedPath || realpathSync(path) !== path || !stat.isDirectory() || stat.isSymbolicLink()) failClosed();
    return path;
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  }
}

export async function withMaterializedCanonicalTree(options, consumer) {
  const values = exactOptions(options);
  if (typeof consumer !== "function") failClosed();
  const workspace = createWorkspace();
  let journal;
  try {
    const outputDirectory = resolve(workspace.root, "tree");
    mkdirSync(outputDirectory, { mode: 0o700 });
    chmodSync(outputDirectory, 0o700);
    journal = captureWorkspace(workspace);
    const receipt = materializeCanonicalTreeArchive({
      archivePath: values.archivePath,
      expectedPrefix: values.expectedPrefix,
      expectedSha256: values.expectedSha256,
      outputDirectory,
    });
    const path = materializedPath(receipt, outputDirectory, values.expectedPrefix);
    journal = captureWorkspace(workspace);
    return await consumer(path);
  } finally {
    if (journal === undefined || !removeWorkspace(workspace, journal)) throw new Error(CLEANUP_FAILURE);
  }
}
