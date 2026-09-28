#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
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
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { types as utilTypes } from "node:util";

import { hashSkill } from "./skill-content.mjs";
import { validateSkill } from "./validate.mjs";

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const INPUT_FAILURE = "Skill installation input is invalid";
const SUPPORTED_PLATFORMS = new Set(["darwin", "linux"]);
const INSTALL_LOCK = ".gauntlet-skills-install.lock";
const OWNER_PREFIX = ".gauntlet-skills-install-owner-";
const LOCK_STALE_NANOSECONDS = 5n * 60n * 1_000_000_000n;
const MAX_LOCK_BYTES = 4096;

function invalidInput() {
  throw new Error(INPUT_FAILURE);
}

function sameDirectory(left, right) {
  return left.isDirectory() && right.isDirectory() && left.dev === right.dev && left.ino === right.ino
    && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid;
}

function sameFile(left, right) {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino
    && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid
    && left.nlink === right.nlink && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function sameFileIdentity(left, right) {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino
    && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid && left.size === right.size;
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
  invalidInput();
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
      || !/^ls \(GNU coreutils\) [1-9][0-9]*(?:\.[0-9]+)*[^\r\n]*\n/u.test(result.stdout)) invalidInput();
}

function assertNoExtendedAcl(path) {
  try {
    if (!SUPPORTED_PLATFORMS.has(process.platform) || typeof path !== "string"
        || /[\0-\x1f\x7f]/u.test(path)) invalidInput();
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
        || result.stderr !== "" || typeof result.stdout !== "string" || !result.stdout.endsWith("\n")) invalidInput();
    const lines = result.stdout.slice(0, -1).split("\n");
    const mode = lines.length === 1 ? /^[^\s]+/u.exec(lines[0])?.[0] : undefined;
    if (mode === undefined || mode.includes("+")
        || !/^[bcdlps-][rwxStTs-]{9}(?:[.@])?$/u.test(mode)) invalidInput();
  } catch (error) {
    if (error instanceof Error && error.message === INPUT_FAILURE) throw error;
    invalidInput();
  }
}

function safeOwnedDirectory(path, privateDirectory = false) {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path
        || (stat.mode & 0o022n) !== 0n
        || (privateDirectory && (stat.mode & 0o077n) !== 0n)
        || (typeof process.geteuid === "function" && stat.uid !== BigInt(process.geteuid()))) invalidInput();
    assertNoExtendedAcl(path);
    return stat;
  } catch (error) {
    if (error instanceof Error && error.message === INPUT_FAILURE) throw error;
    invalidInput();
  }
}

function destinationGuard(path) {
  const supplied = safeOwnedDirectory(path);
  const canonical = realpathSync(path);
  const current = safeOwnedDirectory(canonical);
  if (!sameDirectory(supplied, current)) invalidInput();
  const parentPath = realpathSync(dirname(canonical));
  if (dirname(canonical) !== parentPath) invalidInput();
  const parent = safeOwnedDirectory(parentPath);
  return Object.freeze({ path: canonical, stat: current, parent: Object.freeze({ path: parentPath, stat: parent }) });
}

function assertDestination(guard) {
  const parent = safeOwnedDirectory(guard.parent.path);
  const destination = safeOwnedDirectory(guard.path);
  if (!sameDirectory(guard.parent.stat, parent) || !sameDirectory(guard.stat, destination)) invalidInput();
}

function syncDestination(guard) {
  let descriptor;
  try {
    assertDestination(guard);
    descriptor = openSync(
      guard.path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_CLOEXEC,
    );
    if (!sameDirectory(guard.stat, fstatSync(descriptor, { bigint: true }))) invalidInput();
    fsyncSync(descriptor);
  } catch (error) {
    if (error instanceof Error && error.message === INPUT_FAILURE) throw error;
    invalidInput();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertOwnedFile(path) {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || (stat.mode & 0o022n) !== 0n
        || (typeof process.geteuid === "function" && stat.uid !== BigInt(process.geteuid()))) invalidInput();
    assertNoExtendedAcl(path);
  } catch (error) {
    if (error instanceof Error && error.message === INPUT_FAILURE) throw error;
    invalidInput();
  }
}

function knownOwnedDirectory(path, expected) {
  try {
    return sameDirectory(expected, safeOwnedDirectory(path, true));
  } catch {
    return false;
  }
}

function closedInput(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = ["root", "destination", "names"];
  if (Object.keys(descriptors).length !== keys.length || keys.some((key) => !Object.hasOwn(descriptors, key))) return undefined;
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined || descriptor.enumerable !== true) return undefined;
    result[key] = descriptor.value;
  }
  return result;
}

function namesArray(value) {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype
      || value.length < 1 || value.length > 16 || new Set(value).size !== value.length
      || value.some((name) => typeof name !== "string" || !NAME.test(name))) return undefined;
  return [...value];
}

function missing(path) {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

function isStale(stat) {
  const now = BigInt(Date.now()) * 1_000_000n;
  return now >= stat.mtimeNs && now - stat.mtimeNs >= LOCK_STALE_NANOSECONDS;
}

function processIsAbsent(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

function exactRecord(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
    ? value
    : undefined;
}

function parseLockRecord(bytes, expectedPid, expectedNonce) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
  const record = exactRecord(value, ["schemaVersion", "pid", "createdAt", "nonce", "names"]);
  const names = record === undefined ? undefined : namesArray(record.names);
  if (record === undefined || record.schemaVersion !== 1
      || !Number.isSafeInteger(record.pid) || record.pid < 1
      || (expectedPid !== undefined && record.pid !== expectedPid)
      || typeof record.createdAt !== "string" || Number.isNaN(Date.parse(record.createdAt))
      || new Date(record.createdAt).toISOString() !== record.createdAt
      || typeof record.nonce !== "string" || !/^[0-9a-f]{32}$/u.test(record.nonce)
      || (expectedNonce !== undefined && record.nonce !== expectedNonce)
      || names === undefined) return undefined;
  return Object.freeze({ ...record, names: Object.freeze(names) });
}

function readPrivateFile(path, allowedLinks, allowEmpty = false) {
  let descriptor;
  try {
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || !allowedLinks.includes(before.nlink)
        || before.size > BigInt(MAX_LOCK_BYTES) || (!allowEmpty && before.size < 1n)
        || (before.mode & 0o077n) !== 0n
        || (typeof process.geteuid === "function" && before.uid !== BigInt(process.geteuid()))) invalidInput();
    assertNoExtendedAcl(path);
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_CLOEXEC);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!sameFile(before, opened)) invalidInput();
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) invalidInput();
      offset += count;
    }
    if (!sameFile(opened, fstatSync(descriptor, { bigint: true }))
        || !sameFile(opened, lstatSync(path, { bigint: true }))) invalidInput();
    return Object.freeze({ bytes, stat: opened });
  } catch (error) {
    if (error instanceof Error && error.message === INPUT_FAILURE) throw error;
    invalidInput();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function retireKnownFile(destination, path, expected, label) {
  let quarantine;
  try {
    assertDestination(destination);
    const current = lstatSync(path, { bigint: true });
    if (!sameFile(expected, current)) return false;
    quarantine = resolve(destination.path, `.gauntlet-retired-${label}-${randomBytes(16).toString("hex")}`);
    renameSync(path, quarantine);
    const moved = lstatSync(quarantine, { bigint: true });
    if (!sameFileIdentity(current, moved)) {
      if (missing(path)) renameSync(quarantine, path);
      return false;
    }
    unlinkSync(quarantine);
    syncDestination(destination);
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

function retireKnownDirectory(destination, path, expected) {
  let quarantine;
  try {
    assertDestination(destination);
    const current = lstatSync(path, { bigint: true });
    if (!sameDirectory(expected, current)) return false;
    quarantine = resolve(destination.path, `.gauntlet-retired-scratch-${randomBytes(16).toString("hex")}`);
    renameSync(path, quarantine);
    const moved = safeOwnedDirectory(quarantine, true);
    if (!sameDirectory(current, moved)) {
      if (missing(path)) renameSync(quarantine, path);
      return false;
    }
    rmSync(quarantine, { recursive: true, force: false });
    syncDestination(destination);
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

function ownerPath(destination, pid, nonce) {
  return resolve(destination.path, `${OWNER_PREFIX}${pid}-${nonce}`);
}

function recoverStaleOwners(destination) {
  const candidates = readdirSync(destination.path, { withFileTypes: true })
    .filter((entry) => entry.name.startsWith(OWNER_PREFIX));
  for (const entry of candidates) {
    const match = /^\.gauntlet-skills-install-owner-([1-9][0-9]*)-([0-9a-f]{32})$/u.exec(entry.name);
    if (match === null || !entry.isFile() || entry.isSymbolicLink()) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || !processIsAbsent(pid)) continue;
    const path = resolve(destination.path, entry.name);
    try {
      const { stat } = readPrivateFile(path, [1n], true);
      if (!isStale(stat) || !processIsAbsent(pid)) continue;
      // The PID embedded in the O_EXCL pathname makes even a zero-byte crash window attributable.
      retireKnownFile(destination, path, stat, "orphan-owner");
    } catch {
      // Never remove a malformed, linked, or concurrently changing owner.
    }
  }
}

function staleLock(path) {
  try {
    const { bytes, stat } = readPrivateFile(path, [1n, 2n]);
    const record = parseLockRecord(bytes);
    if (record === undefined || !isStale(stat) || !processIsAbsent(record.pid)) return undefined;
    return Object.freeze({ record, stat });
  } catch {
    return undefined;
  }
}

function recoverStaleLock(destination, path) {
  try {
    assertDestination(destination);
    const stale = staleLock(path);
    if (stale === undefined) return false;
    for (const name of stale.record.names) {
      const scratch = resolve(destination.path, `.gauntlet-skill-${name}-${stale.record.nonce}`);
      if (missing(scratch)) continue;
      const scratchStat = safeOwnedDirectory(scratch, true);
      if (!retireKnownDirectory(destination, scratch, scratchStat)) return false;
    }
    assertDestination(destination);
    const current = lstatSync(path, { bigint: true });
    if (!sameFile(stale.stat, current)) return false;
    const linkedOwner = ownerPath(destination, stale.record.pid, stale.record.nonce);
    let ownerIdentity;
    if (!missing(linkedOwner)) {
      ownerIdentity = lstatSync(linkedOwner, { bigint: true });
      if (!sameFile(stale.stat, ownerIdentity)) return false;
    } else if (current.nlink !== 1n) {
      return false;
    }
    if (!retireKnownFile(destination, path, current, "stale-lock")) return false;
    if (ownerIdentity !== undefined && !missing(linkedOwner)) {
      const ownerCurrent = lstatSync(linkedOwner, { bigint: true });
      if (!sameFileIdentity(ownerIdentity, ownerCurrent)
          || !retireKnownFile(destination, linkedOwner, ownerCurrent, "stale-owner")) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function writeAll(descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (count <= 0) invalidInput();
    offset += count;
  }
}

function createLockOwner(destination, names) {
  const nonce = randomBytes(16).toString("hex");
  const path = ownerPath(destination, process.pid, nonce);
  let descriptor;
  try {
    assertDestination(destination);
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
      names,
    })}\n`, "utf8"));
    fsyncSync(descriptor);
    const stat = fstatSync(descriptor, { bigint: true });
    if (!sameFile(stat, lstatSync(path, { bigint: true }))) invalidInput();
    syncDestination(destination);
    const owner = Object.freeze({ descriptor, nonce, path, stat });
    descriptor = undefined;
    return owner;
  } catch (error) {
    if (error instanceof Error && error.message === INPUT_FAILURE) throw error;
    invalidInput();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function removeKnownOwner(destination, owner) {
  try {
    assertDestination(destination);
    const current = lstatSync(owner.path, { bigint: true });
    if (!sameFileIdentity(owner.stat, current)) return false;
    unlinkSync(owner.path);
    syncDestination(destination);
    return true;
  } catch {
    return false;
  }
}

function acquireInstallLock(destination, names) {
  const path = resolve(destination.path, INSTALL_LOCK);
  let descriptor;
  let owner;
  let linked = false;
  try {
    assertDestination(destination);
    recoverStaleOwners(destination);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      owner = createLockOwner(destination, names);
      descriptor = owner.descriptor;
      try {
        linkSync(owner.path, path);
        linked = true;
        syncDestination(destination);
        break;
      } catch (error) {
        closeSync(descriptor);
        descriptor = undefined;
        removeKnownOwner(destination, owner);
        owner = undefined;
        if (attempt !== 0 || error?.code !== "EEXIST" || !recoverStaleLock(destination, path)) invalidInput();
      }
    }
    if (!linked || owner === undefined || descriptor === undefined) invalidInput();
    const opened = fstatSync(descriptor, { bigint: true });
    const pathname = lstatSync(path, { bigint: true });
    const ownerStat = lstatSync(owner.path, { bigint: true });
    if (opened.nlink !== 2n || !sameFile(opened, pathname) || !sameFile(opened, ownerStat)) invalidInput();
    if (!removeKnownOwner(destination, { path: owner.path, stat: ownerStat })) invalidInput();
    owner = undefined;
    const locked = fstatSync(descriptor, { bigint: true });
    if (locked.nlink !== 1n || !sameFile(locked, lstatSync(path, { bigint: true }))) invalidInput();
    const lock = Object.freeze({ descriptor, nonce: parseLockRecord(
      readPrivateFile(path, [1n]).bytes,
    )?.nonce, path, stat: locked });
    if (lock.nonce === undefined) invalidInput();
    descriptor = undefined;
    return lock;
  } catch (error) {
    if (descriptor !== undefined) {
      if (linked) {
        try {
          const opened = fstatSync(descriptor, { bigint: true });
          const pathname = lstatSync(path, { bigint: true });
          if (sameFile(opened, pathname)) retireKnownFile(destination, path, pathname, "failed-lock");
        } catch {
          // Never unlink a pathname whose identity cannot be revalidated.
        }
      }
      closeSync(descriptor);
    }
    if (owner !== undefined) removeKnownOwner(destination, owner);
    if (error instanceof Error && error.message === INPUT_FAILURE) throw error;
    invalidInput();
  }
}

function assertInstallLock(destination, lock) {
  try {
    assertDestination(destination);
    const opened = fstatSync(lock.descriptor, { bigint: true });
    const pathname = lstatSync(lock.path, { bigint: true });
    if (!sameFile(lock.stat, opened) || !sameFile(opened, pathname)) invalidInput();
  } catch (error) {
    if (error instanceof Error && error.message === INPUT_FAILURE) throw error;
    invalidInput();
  }
}

function releaseInstallLock(destination, lock) {
  try {
    assertInstallLock(destination, lock);
    if (!retireKnownFile(destination, lock.path, lock.stat, "released-lock")) invalidInput();
  } finally {
    closeSync(lock.descriptor);
  }
}

export async function installSkills(options) {
  const values = closedInput(options);
  const names = values === undefined ? undefined : namesArray(values.names);
  if (values === undefined || names === undefined || typeof values.root !== "string" || !isAbsolute(values.root)
      || resolve(values.root) !== values.root || typeof values.destination !== "string" || !isAbsolute(values.destination)
      || resolve(values.destination) !== values.destination || values.destination === "/") throw new Error(INPUT_FAILURE);
  const destination = destinationGuard(values.destination);
  const destinationRoot = destination.path;

  const validations = [];
  for (const name of names) {
    assertDestination(destination);
    const validation = await validateSkill({ root: values.root, name });
    if (validation.errors.length !== 0) throw new Error(`Skill ${name} did not validate`);
    validations.push(validation);
  }
  let lock;
  const staged = [];
  try {
    lock = acquireInstallLock(destination, names);
    assertInstallLock(destination, lock);
    for (const name of names) {
      if (!missing(resolve(destinationRoot, name))) {
        throw new Error(`Skill ${name} already exists; remove or move it explicitly`);
      }
    }
    for (const validation of validations) {
      assertInstallLock(destination, lock);
      assertDestination(destination);
      const scratch = resolve(destinationRoot, `.gauntlet-skill-${validation.name}-${lock.nonce}`);
      if (!missing(scratch)) invalidInput();
      mkdirSync(scratch, { mode: 0o700 });
      const scratchStat = safeOwnedDirectory(scratch, true);
      staged.push({
        name: validation.name,
        scratch,
        scratchStat,
        target: resolve(destinationRoot, validation.name),
        promoted: false,
      });
      const sourceRoot = resolve(values.root, "skills", validation.name);
      for (const relativePath of validation.files) {
        assertInstallLock(destination, lock);
        assertDestination(destination);
        const target = resolve(scratch, ...relativePath.split("/"));
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        copyFileSync(resolve(sourceRoot, ...relativePath.split("/")), target, constants.COPYFILE_EXCL);
        assertOwnedFile(target);
      }
      assertDestination(destination);
      if (!sameDirectory(scratchStat, safeOwnedDirectory(scratch, true))) invalidInput();
      if (await hashSkill(scratch) !== validation.sha256) throw new Error(`Skill ${validation.name} changed while installing`);
    }
    assertInstallLock(destination, lock);
    for (const record of staged) {
      if (!missing(record.target)) {
        throw new Error(`Skill ${record.name} already exists; remove or move it explicitly`);
      }
    }
    for (const record of staged) {
      assertInstallLock(destination, lock);
      assertDestination(destination);
      if (!missing(record.target)) throw new Error(`Skill ${record.name} already exists; remove or move it explicitly`);
      if (!sameDirectory(record.scratchStat, safeOwnedDirectory(record.scratch, true))) invalidInput();
      renameSync(record.scratch, record.target);
      record.promoted = true;
    }
  } catch (error) {
    if (lock !== undefined) {
      try {
        assertInstallLock(destination, lock);
        for (const record of [...staged].reverse()) {
          if (record.promoted && missing(record.scratch)
              && knownOwnedDirectory(record.target, record.scratchStat)) {
            renameSync(record.target, record.scratch);
            record.promoted = false;
          }
        }
        for (const record of staged) {
          if (!record.promoted && knownOwnedDirectory(record.scratch, record.scratchStat)) {
            retireKnownDirectory(destination, record.scratch, record.scratchStat);
          }
        }
      } catch {
        // Never remove or roll back a pathname whose identity cannot be revalidated.
      }
    }
    throw error;
  } finally {
    if (lock !== undefined) releaseInstallLock(destination, lock);
  }
  return Object.freeze({ destination: destinationRoot, installed: Object.freeze([...names]) });
}

export function parseInstallArguments(args) {
  if (!Array.isArray(args) || args.length < 3 || args[0] !== "--destination" || typeof args[1] !== "string"
      || !isAbsolute(args[1]) || resolve(args[1]) !== args[1]) throw new Error("Invalid skill installer arguments");
  const names = namesArray(args.slice(2));
  if (names === undefined) throw new Error("Invalid skill installer arguments");
  return { destination: args[1], names };
}

export async function runInstallCli(
  args,
  root = fileURLToPath(new URL("../..", import.meta.url)),
) {
  const parsed = parseInstallArguments(args);
  const repositoryRoot = typeof root === "string" && isAbsolute(root) ? resolve(root) : root;
  return installSkills({ root: repositoryRoot, ...parsed });
}

function isDirectExecution(path) {
  if (typeof path !== "string" || path.length === 0) return false;
  try {
    return realpathSync(resolve(path)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectExecution(process.argv[1])) {
  runInstallCli(process.argv.slice(2))
    .then((receipt) => process.stdout.write(`${JSON.stringify(receipt)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
