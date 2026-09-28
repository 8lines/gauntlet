#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const LOCK_STALE_NANOSECONDS = 5n * 60n * 1_000_000_000n;
const FAILURE = "Skill archive installation failed closed";
const SUPPORTED_PLATFORMS = new Set(["darwin", "linux"]);

function fail() {
  throw new Error(FAILURE);
}

function compare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function exactRecord(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) fail();
  const actual = Object.keys(value).sort(compare);
  const expected = [...keys].sort(compare);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail();
  return value;
}

function sameFile(left, right) {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino
    && left.mode === right.mode && left.nlink === right.nlink && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function sameFileIdentity(left, right) {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino
    && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid && left.size === right.size;
}

function sameDirectoryIdentity(left, right) {
  return left.isDirectory() && right.isDirectory() && left.dev === right.dev && left.ino === right.ino
    && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid;
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
  fail();
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
      || !/^ls \(GNU coreutils\) [1-9][0-9]*(?:\.[0-9]+)*[^\r\n]*\n/u.test(result.stdout)) fail();
}

function assertNoExtendedAcl(path) {
  try {
    if (!SUPPORTED_PLATFORMS.has(process.platform) || typeof path !== "string"
        || /[\0-\x1f\x7f]/u.test(path)) fail();
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
        || result.stderr !== "" || typeof result.stdout !== "string") fail();
    if (!result.stdout.endsWith("\n")) fail();
    const lines = result.stdout.slice(0, -1).split("\n");
    if (lines.length !== 1) fail();
    const mode = /^[^\s]+/u.exec(lines[0])?.[0];
    if (mode === undefined || mode.includes("+")
        || !/^[bcdlps-][rwxStTs-]{9}(?:[.@])?$/u.test(mode)) fail();
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    fail();
  }
}

function safeDirectory(path, privateDirectory = false) {
  let stat;
  try {
    stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path
        || (stat.mode & 0o022n) !== 0n
        || (typeof process.geteuid === "function" && stat.uid !== BigInt(process.geteuid()))
        || (privateDirectory && (stat.mode & 0o077n) !== 0n)) fail();
    assertNoExtendedAcl(path);
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    fail();
  }
  return stat;
}

function readStable(path, maximumBytes = MAX_FILE_BYTES, allowedLinks = [1n]) {
  let descriptor;
  try {
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || !allowedLinks.includes(before.nlink) || before.size < 1n
        || before.size > BigInt(maximumBytes) || (before.mode & 0o022n) !== 0n
        || (typeof process.geteuid === "function" && before.uid !== BigInt(process.geteuid()))) fail();
    assertNoExtendedAcl(path);
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_CLOEXEC);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!sameFile(before, opened)) fail();
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) fail();
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    const pathname = lstatSync(path, { bigint: true });
    if (!sameFile(opened, after) || !sameFile(after, pathname)) fail();
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    fail();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function walkReferences(root, directory, records) {
  safeDirectory(directory);
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => compare(left.name, right.name));
  if (entries.length === 0) fail();
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) fail();
    if (entry.isDirectory()) {
      walkReferences(root, path, records);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) fail();
    readStable(path);
    const relativePath = relative(root, path).split(sep).join("/");
    if (!relativePath.startsWith("references/") || relativePath.split("/").some((segment) => segment === "..")) fail();
    records.push(relativePath);
  }
}

function listSkillFiles(skillDirectory) {
  safeDirectory(skillDirectory);
  const rootEntries = readdirSync(skillDirectory).sort(compare);
  if (rootEntries.join("\0") !== ["SKILL.md", "agents", "references"].sort(compare).join("\0")) fail();
  readStable(resolve(skillDirectory, "SKILL.md"));
  const agents = resolve(skillDirectory, "agents");
  safeDirectory(agents);
  if (readdirSync(agents).join("\0") !== "openai.yaml") fail();
  readStable(resolve(agents, "openai.yaml"));
  const records = ["SKILL.md", "agents/openai.yaml"];
  walkReferences(skillDirectory, resolve(skillDirectory, "references"), records);
  return records.sort(compare);
}

function hashSkill(skillDirectory, files) {
  const hash = createHash("sha256");
  let total = 0;
  for (const relativePath of files) {
    const bytes = readStable(resolve(skillDirectory, ...relativePath.split("/")));
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) fail();
    hash.update(relativePath, "utf8");
    hash.update(Buffer.from([0]));
    hash.update(bytes);
    hash.update(Buffer.from([0]));
  }
  return hash.digest("hex");
}

function readManifest(root) {
  let value;
  try {
    value = JSON.parse(readStable(resolve(root, "skills-manifest.json"), MAX_MANIFEST_BYTES).toString("utf8"));
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    fail();
  }
  const manifest = exactRecord(value, ["schemaVersion", "name", "version", "skills"]);
  if (manifest.schemaVersion !== 1 || manifest.name !== "gauntlet-skills"
      || typeof manifest.version !== "string" || !VERSION.test(manifest.version)
      || !Array.isArray(manifest.skills) || manifest.skills.length < 1 || manifest.skills.length > 16) fail();
  const names = new Set();
  let previous = "";
  const skills = manifest.skills.map((candidate) => {
    const record = exactRecord(candidate, ["name", "sha256", "files"]);
    if (typeof record.name !== "string" || !NAME.test(record.name) || names.has(record.name)
        || (previous !== "" && compare(previous, record.name) >= 0)
        || typeof record.sha256 !== "string" || !SHA256.test(record.sha256)
        || !Array.isArray(record.files) || record.files.length < 3 || record.files.length > 256
        || record.files.some((path) => typeof path !== "string" || path.length < 1 || path.includes("\\")
          || path.split("/").some((segment) => segment === "" || segment === "." || segment === ".."))) fail();
    names.add(record.name);
    previous = record.name;
    const source = resolve(root, "skills", record.name);
    const files = listSkillFiles(source);
    if (JSON.stringify(files) !== JSON.stringify(record.files) || hashSkill(source, files) !== record.sha256) fail();
    return Object.freeze({ name: record.name, sha256: record.sha256, files: Object.freeze([...files]) });
  });
  return Object.freeze({ version: manifest.version, skills: Object.freeze(skills) });
}

function parseArguments(args, manifest) {
  if (!Array.isArray(args) || args.length !== 3 || args[0] !== "--destination"
      || typeof args[1] !== "string" || !isAbsolute(args[1]) || resolve(args[1]) !== args[1]) fail();
  const name = args[2];
  if (typeof name !== "string" || !NAME.test(name)
      || !manifest.skills.some((entry) => entry.name === name)) fail();
  return { destination: args[1], name };
}

function missing(path) {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    fail();
  }
}

function destinationRoot(path) {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022n) !== 0n
        || (typeof process.geteuid === "function" && stat.uid !== BigInt(process.geteuid()))) fail();
    assertNoExtendedAcl(path);
    const canonicalPath = realpathSync(path);
    const canonicalStat = lstatSync(canonicalPath, { bigint: true });
    if (!sameDirectoryIdentity(stat, canonicalStat)) fail();
    const parentPath = realpathSync(dirname(canonicalPath));
    const parentStat = lstatSync(parentPath, { bigint: true });
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || dirname(canonicalPath) !== parentPath
        || (parentStat.mode & 0o022n) !== 0n
        || (typeof process.geteuid === "function" && parentStat.uid !== BigInt(process.geteuid()))) fail();
    assertNoExtendedAcl(parentPath);
    return Object.freeze({
      path: canonicalPath,
      stat: canonicalStat,
      parent: Object.freeze({ path: parentPath, stat: parentStat }),
    });
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    fail();
  }
}

function assertParent(parent) {
  try {
    const current = lstatSync(parent.path, { bigint: true });
    if (!sameDirectoryIdentity(parent.stat, current) || current.isSymbolicLink()
        || realpathSync(parent.path) !== parent.path || (current.mode & 0o022n) !== 0n
        || (typeof process.geteuid === "function" && current.uid !== BigInt(process.geteuid()))) fail();
    assertNoExtendedAcl(parent.path);
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    fail();
  }
}

function assertDestination(destination) {
  try {
    assertParent(destination.parent);
    const current = lstatSync(destination.path, { bigint: true });
    if (!sameDirectoryIdentity(destination.stat, current) || current.isSymbolicLink()
        || realpathSync(destination.path) !== destination.path
        || (current.mode & 0o022n) !== 0n
        || (typeof process.geteuid === "function" && current.uid !== BigInt(process.geteuid()))) fail();
    assertNoExtendedAcl(destination.path);
    return current;
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    fail();
  }
}

function processIsAbsent(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

function parseLockRecord(path, before, expectedNonce) {
  const record = exactRecord(JSON.parse(readStable(path, 4096, [1n, 2n]).toString("utf8")), [
    "schemaVersion", "pid", "createdAt", "nonce", "skillName",
  ]);
  if (record.schemaVersion !== 1 || !Number.isSafeInteger(record.pid) || record.pid < 1
      || typeof record.createdAt !== "string" || Number.isNaN(Date.parse(record.createdAt))
      || new Date(record.createdAt).toISOString() !== record.createdAt
      || typeof record.nonce !== "string" || !/^[0-9a-f]{32}$/u.test(record.nonce)
      || (expectedNonce !== undefined && record.nonce !== expectedNonce)
      || typeof record.skillName !== "string" || !NAME.test(record.skillName)) return undefined;
  return record;
}

function staleLockRecord(path, before, expectedNonce) {
  const now = BigInt(Date.now()) * 1_000_000n;
  if (!before.isFile() || before.isSymbolicLink() || ![1n, 2n].includes(before.nlink) || before.size < 1n
      || before.size > 4096n || (before.mode & 0o077n) !== 0n || now < before.mtimeNs
      || now - before.mtimeNs < LOCK_STALE_NANOSECONDS
      || (typeof process.geteuid === "function" && before.uid !== BigInt(process.geteuid()))) return undefined;
  const record = parseLockRecord(path, before, expectedNonce);
  return record !== undefined && processIsAbsent(record.pid) ? record : undefined;
}

function staleUnlinkedOwner(before) {
  const now = BigInt(Date.now()) * 1_000_000n;
  return before.isFile() && !before.isSymbolicLink() && before.nlink === 1n
    && before.size <= 4096n && (before.mode & 0o077n) === 0n && now >= before.mtimeNs
    && now - before.mtimeNs >= LOCK_STALE_NANOSECONDS
    && (typeof process.geteuid !== "function" || before.uid === BigInt(process.geteuid()));
}

function recoverStaleLock(destination, path) {
  try {
    assertParent(destination.parent);
    const before = lstatSync(path, { bigint: true });
    const record = staleLockRecord(path, before);
    if (record === undefined) return false;
    assertParent(destination.parent);
    const after = lstatSync(path, { bigint: true });
    if (!sameFile(before, after)) return false;

    const scratch = resolve(
      destination.parent.path,
      `.gauntlet-skill-${record.skillName}-${record.nonce}`,
    );
    if (!missing(scratch)) {
      const scratchStat = safeDirectory(scratch, true);
      const quarantine = resolve(
        destination.parent.path,
        `.gauntlet-retired-scratch-${randomBytes(16).toString("hex")}`,
      );
      renameSync(scratch, quarantine);
      const movedScratch = lstatSync(quarantine, { bigint: true });
      if (!sameDirectoryIdentity(scratchStat, movedScratch)) {
        if (missing(scratch)) renameSync(quarantine, scratch);
        return false;
      }
      rmSync(quarantine, { recursive: true, force: false });
    }

    if (!retireKnownFile(destination, path, after, "stale-lock")) return false;
    return true;
  } catch {
    return false;
  }
}

function recoverStaleOwners(destination, lockId) {
  try {
    assertParent(destination.parent);
    const prefix = `.gauntlet-lock-owner-${lockId}-`;
    const candidates = readdirSync(destination.parent.path, { withFileTypes: true })
      .filter((entry) => entry.name.startsWith(prefix));
    let unrecovered = 0;
    for (const entry of candidates) {
      const nonce = entry.name.slice(prefix.length);
      if (!/^[0-9a-f]{32}$/u.test(nonce) || !entry.isFile() || entry.isSymbolicLink()) {
        unrecovered += 1;
        continue;
      }
      const path = resolve(destination.parent.path, entry.name);
      let removed = false;
      try {
        const before = lstatSync(path, { bigint: true });
        let parsedRecord;
        try {
          if (before.size > 0n) parsedRecord = parseLockRecord(path, before, nonce);
        } catch {
          // A stale, private, unlinked short write in the reserved owner namespace is recoverable.
        }
        const recoverable = parsedRecord === undefined
          ? staleUnlinkedOwner(before)
          : staleLockRecord(path, before, nonce) !== undefined;
        if (recoverable) {
          const after = lstatSync(path, { bigint: true });
          if (sameFile(before, after)) removed = retireKnownFile(destination, path, after, "orphan-owner");
        }
      } catch {
        // A malformed or concurrently changing owner is never removed.
      }
      if (!removed) unrecovered += 1;
    }
    if (unrecovered > 256) fail();
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    fail();
  }
}

function retireKnownFile(destination, path, expected, label) {
  let quarantine;
  try {
    assertParent(destination.parent);
    const current = lstatSync(path, { bigint: true });
    if (!sameFileIdentity(expected, current)) return false;
    quarantine = resolve(
      destination.parent.path,
      `.gauntlet-retired-${label}-${randomBytes(16).toString("hex")}`,
    );
    renameSync(path, quarantine);
    const moved = lstatSync(quarantine, { bigint: true });
    if (!sameFileIdentity(current, moved)) {
      if (missing(path)) renameSync(quarantine, path);
      return false;
    }
    unlinkSync(quarantine);
    return true;
  } catch {
    if (quarantine !== undefined && !missing(quarantine) && missing(path)) {
      try {
        renameSync(quarantine, path);
      } catch {
        // Preserve an unverified pathname instead of deleting it.
      }
    }
    return false;
  }
}

function writeAll(descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (count <= 0) fail();
    offset += count;
  }
}

function createLockOwner(destination, lockId, skillName) {
  const nonce = randomBytes(16).toString("hex");
  const path = resolve(destination.parent.path, `.gauntlet-lock-owner-${lockId}-${nonce}`);
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_CLOEXEC,
      0o600,
    );
    writeAll(descriptor, Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      createdAt: new Date().toISOString(),
      nonce,
      skillName,
    })}\n`, "utf8"));
    fsyncSync(descriptor);
    const stat = fstatSync(descriptor, { bigint: true });
    const pathname = lstatSync(path, { bigint: true });
    if (!sameFile(stat, pathname)) fail();
    const owner = { descriptor, nonce, path, stat };
    descriptor = undefined;
    return owner;
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    fail();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function removeKnownOwner(destination, owner) {
  try {
    assertParent(destination.parent);
    const pathname = lstatSync(owner.path, { bigint: true });
    if (pathname.dev !== owner.stat.dev || pathname.ino !== owner.stat.ino || !pathname.isFile()
        || pathname.isSymbolicLink()) return false;
    unlinkSync(owner.path);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(destination, skillName) {
  const lockId = createHash("sha256").update(destination.path, "utf8").digest("hex").slice(0, 24);
  const path = resolve(destination.parent.path, `.gauntlet-skills-install-${lockId}.lock`);
  let descriptor;
  let owner;
  let linked = false;
  try {
    assertDestination(destination);
    recoverStaleOwners(destination, lockId);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      owner = createLockOwner(destination, lockId, skillName);
      descriptor = owner.descriptor;
      try {
        linkSync(owner.path, path);
        linked = true;
        break;
      } catch (error) {
        closeSync(descriptor);
        descriptor = undefined;
        removeKnownOwner(destination, owner);
        owner = undefined;
        if (attempt !== 0 || error?.code !== "EEXIST" || !recoverStaleLock(destination, path)) throw error;
      }
    }
    if (!linked || owner === undefined) fail();
    const linkedStat = fstatSync(descriptor, { bigint: true });
    const ownerStat = lstatSync(owner.path, { bigint: true });
    const pathStat = lstatSync(path, { bigint: true });
    const nonce = owner.nonce;
    if (linkedStat.nlink !== 2n || !sameFile(linkedStat, ownerStat) || !sameFile(ownerStat, pathStat)) fail();
    if (!removeKnownOwner(destination, { path: owner.path, stat: ownerStat })) fail();
    owner = undefined;
    const opened = fstatSync(descriptor, { bigint: true });
    const pathname = lstatSync(path, { bigint: true });
    if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1n || (opened.mode & 0o077n) !== 0n
        || (typeof process.geteuid === "function" && opened.uid !== BigInt(process.geteuid()))
        || !sameFile(opened, pathname)) fail();
    const lock = { descriptor, nonce, path, stat: opened };
    assertDestination(destination);
    descriptor = undefined;
    return lock;
  } catch (error) {
    if (descriptor !== undefined) {
      if (linked) {
        try {
          const opened = fstatSync(descriptor, { bigint: true });
          assertParent(destination.parent);
          const pathname = lstatSync(path, { bigint: true });
          if (sameFile(opened, pathname)) retireKnownFile(destination, path, pathname, "failed-lock");
        } catch {
          // Never unlink a pathname whose parent and inode cannot be revalidated.
        }
      }
      closeSync(descriptor);
    }
    if (owner !== undefined) removeKnownOwner(destination, owner);
    if (error instanceof Error && error.message === FAILURE) throw error;
    fail();
  }
}

function assertLock(destination, lock) {
  try {
    assertParent(destination.parent);
    const opened = fstatSync(lock.descriptor, { bigint: true });
    const pathname = lstatSync(lock.path, { bigint: true });
    if (!sameFile(lock.stat, opened) || !sameFile(opened, pathname)) fail();
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    fail();
  }
}

function releaseLock(destination, lock) {
  try {
    assertLock(destination, lock);
    if (!retireKnownFile(destination, lock.path, lock.stat, "released-lock")) fail();
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    fail();
  } finally {
    closeSync(lock.descriptor);
  }
}

function knownDirectory(path, expected) {
  try {
    const current = lstatSync(path, { bigint: true });
    if (!sameDirectoryIdentity(expected, current) || current.isSymbolicLink() || realpathSync(path) !== path) return false;
    assertNoExtendedAcl(path);
    return true;
  } catch {
    return false;
  }
}

function install(root, manifest, { destination, name }) {
  const canonicalDestination = destinationRoot(destination);
  const entry = manifest.skills.find((candidate) => candidate.name === name);
  const target = resolve(canonicalDestination.path, name);
  let scratch;
  let lock;
  let scratchStat;
  let promoted = false;
  let completed = false;
  try {
    lock = acquireLock(canonicalDestination, name);
    scratch = resolve(canonicalDestination.parent.path, `.gauntlet-skill-${name}-${lock.nonce}`);
    assertLock(canonicalDestination, lock);
    assertDestination(canonicalDestination);
    if (!missing(target) || !missing(scratch)) fail();

    mkdirSync(scratch, { mode: 0o700 });
    scratchStat = safeDirectory(scratch, true);
    assertLock(canonicalDestination, lock);

    const source = resolve(root, "skills", name);
    for (const relativePath of entry.files) {
      assertLock(canonicalDestination, lock);
      if (!knownDirectory(scratch, scratchStat)) fail();
      const copied = resolve(scratch, ...relativePath.split("/"));
      mkdirSync(dirname(copied), { recursive: true, mode: 0o700 });
      copyFileSync(resolve(source, ...relativePath.split("/")), copied, constants.COPYFILE_EXCL);
    }
    assertLock(canonicalDestination, lock);
    if (!knownDirectory(scratch, scratchStat)) fail();
    const copiedFiles = listSkillFiles(scratch);
    if (JSON.stringify(copiedFiles) !== JSON.stringify(entry.files)
        || hashSkill(scratch, copiedFiles) !== entry.sha256) fail();

    assertLock(canonicalDestination, lock);
    assertDestination(canonicalDestination);
    if (!missing(target) || !knownDirectory(scratch, scratchStat)) fail();
    renameSync(scratch, target);
    promoted = true;
    completed = true;
  } catch (error) {
    if (lock !== undefined) {
      try {
        assertLock(canonicalDestination, lock);
        if (promoted && knownDirectory(target, scratchStat) && missing(scratch)) {
          renameSync(target, scratch);
          promoted = false;
        }
        if (!promoted && scratchStat !== undefined && knownDirectory(scratch, scratchStat)) {
          rmSync(scratch, { recursive: true, force: true });
        }
      } catch {
        // Fail closed; never remove a pathname whose identity cannot be proven.
      }
    }
    throw error;
  } finally {
    if (lock !== undefined) releaseLock(canonicalDestination, lock);
  }
  if (!completed) fail();
  return Object.freeze({ destination: canonicalDestination.path, installed: Object.freeze([name]) });
}

export function runArchiveInstall(args, root = realpathSync(fileURLToPath(new URL("../..", import.meta.url)))) {
  try {
    if (typeof root !== "string" || !isAbsolute(root) || resolve(root) !== root || root === sep) fail();
    safeDirectory(root);
    const manifest = readManifest(root);
    return install(root, manifest, parseArguments(args, manifest));
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    fail();
  }
}

let invokedDirectly = false;
try {
  invokedDirectly = realpathSync(resolve(process.argv[1] ?? "")) === realpathSync(fileURLToPath(import.meta.url));
} catch {
  invokedDirectly = false;
}

if (invokedDirectly) {
  try {
    process.stdout.write(`${JSON.stringify(runArchiveInstall(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
