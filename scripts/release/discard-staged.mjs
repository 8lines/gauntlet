#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
} from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { types as utilTypes } from "node:util";

import { verifyReleaseInventory } from "./inventory.mjs";
import { parseReleaseVersion, RELEASE_STAGE_ARTIFACT_COUNT } from "./release-model.mjs";

const ROOT = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const USAGE = "Usage: discard-staged.mjs --release-root .artifacts/release/VERSION --source-commit FULL_SHA";
const FAILURE = "Staged release discard failed safely";
const COMMIT = /^[0-9a-f]{40}$/u;
const TOKEN = /^[0-9a-f]{32}$/u;

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

function stableVersion(value) {
  try { return parseReleaseVersion(`${value}\n`); } catch { throw new TypeError(USAGE); }
}

export function parseDiscardStagedArguments(argv, root = ROOT) {
  if (!Array.isArray(argv) || argv.length !== 4 || argv[0] !== "--release-root"
      || argv[2] !== "--source-commit" || typeof argv[1] !== "string" || typeof argv[3] !== "string"
      || typeof root !== "string" || !isAbsolute(root) || resolve(root) !== root || root === sep
      || !COMMIT.test(argv[3])) throw new TypeError(USAGE);
  const match = /^\.artifacts\/release\/((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))$/u.exec(argv[1]);
  if (match === null || stableVersion(match[1]) !== match[1]) throw new TypeError(USAGE);
  return { releaseRoot: resolve(root, ...argv[1].split("/")), sourceCommit: argv[3] };
}

function closedOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options) || utilTypes.isProxy(options)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) throw new TypeError();
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const keys = Reflect.ownKeys(descriptors);
  const allowed = ["root", "releaseRoot", "sourceCommit", "verifier", "tokenFactory"];
  if (keys.some((key) => typeof key !== "string" || !allowed.includes(key)
      || descriptors[key].enumerable !== true || !("value" in descriptors[key]))) throw new TypeError();
  const result = Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
  if (!["root", "releaseRoot", "sourceCommit"].every((key) => Object.hasOwn(result, key))) throw new TypeError();
  result.verifier ??= verifyReleaseInventory;
  result.tokenFactory ??= () => randomBytes(16).toString("hex");
  if (typeof result.verifier !== "function" || typeof result.tokenFactory !== "function") throw new TypeError();
  return result;
}

function ownedCanonicalDirectory(path) {
  const stat = lstatSync(path, { bigint: true });
  const uid = typeof process.geteuid === "function" ? BigInt(process.geteuid()) : stat.uid;
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || realpathSync(path) !== path) throw new Error();
  return stat;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid;
}

export async function discardStagedRelease(options) {
  let values;
  try { values = closedOptions(options); } catch { throw new Error(FAILURE); }
  const { verifier, tokenFactory, sourceCommit } = values;
  let releaseRoot;
  let quarantine;
  let destination;
  let before;
  let moved = false;
  try {
    const root = realpathSync(values.root);
    if (root !== values.root || root === sep || !COMMIT.test(sourceCommit)) throw new Error();
    releaseRoot = values.releaseRoot;
    if (typeof releaseRoot !== "string" || !isAbsolute(releaseRoot) || resolve(releaseRoot) !== releaseRoot) throw new Error();
    const version = stableVersion(basename(releaseRoot));
    if (releaseRoot !== resolve(root, ".artifacts", "release", version)) throw new Error();
    before = ownedCanonicalDirectory(releaseRoot);
    const verified = await verifier({ outputDirectory: releaseRoot, version, sourceCommit });
    if (verified?.schemaVersion !== 1 || verified?.ok !== true
        || verified?.artifacts !== RELEASE_STAGE_ARTIFACT_COUNT
        || verified?.version !== version || verified?.sourceCommit !== sourceCommit) throw new Error();
    const confirmed = ownedCanonicalDirectory(releaseRoot);
    if (!sameIdentity(before, confirmed)) throw new Error();

    const artifacts = resolve(root, ".artifacts");
    ownedCanonicalDirectory(artifacts);
    quarantine = resolve(artifacts, ".release-discard");
    try {
      mkdirSync(quarantine, { mode: 0o700 });
      chmodSync(quarantine, 0o700);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const quarantineStat = ownedCanonicalDirectory(quarantine);
    if ((quarantineStat.mode & 0o077n) !== 0n) throw new Error();
    const token = tokenFactory();
    if (typeof token !== "string" || !TOKEN.test(token)) throw new Error();
    destination = resolve(quarantine, `${version}-${sourceCommit.slice(0, 12)}-${token}`);
    renameSync(releaseRoot, destination);
    moved = true;
    const movedStat = ownedCanonicalDirectory(destination);
    if (!sameIdentity(before, movedStat) || relative(quarantine, destination).startsWith("..")) throw new Error();
    const reverified = await verifier({ outputDirectory: destination, version, sourceCommit });
    if (reverified?.schemaVersion !== 1 || reverified?.ok !== true
        || reverified?.artifacts !== RELEASE_STAGE_ARTIFACT_COUNT
        || reverified?.version !== version || reverified?.sourceCommit !== sourceCommit
        || !sameIdentity(before, ownedCanonicalDirectory(destination))) throw new Error();
    rmSync(destination, { recursive: true, force: false });
    moved = false;
    try {
      lstatSync(destination);
      throw new Error();
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    try { rmdirSync(quarantine); } catch { /* The empty private quarantine parent may be reused. */ }
    return Object.freeze({
      schemaVersion: 1,
      ok: true,
      removed: `.artifacts/release/${version}`,
      version,
      sourceCommit,
    });
  } catch {
    if (moved && destination !== undefined && releaseRoot !== undefined) {
      try {
        const current = ownedCanonicalDirectory(destination);
        if (before !== undefined && sameIdentity(before, current)) renameSync(destination, releaseRoot);
      } catch { /* Evidence remains quarantined if recovery itself is no longer provably safe. */ }
    }
    throw new Error(FAILURE);
  }
}

function cliOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options) || utilTypes.isProxy(options)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) throw new TypeError();
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string" || !["root", "discard"].includes(key)
      || descriptors[key].enumerable !== true || !("value" in descriptors[key]))) throw new TypeError();
  const root = descriptors.root?.value ?? ROOT;
  const discard = descriptors.discard?.value ?? discardStagedRelease;
  if (typeof root !== "string" || typeof discard !== "function") throw new TypeError();
  return { root, discard };
}

export async function runDiscardStagedCli(argv, options = {}) {
  let parsed;
  let values;
  try {
    values = cliOptions(options);
    parsed = parseDiscardStagedArguments(argv, values.root);
  } catch {
    return { exitCode: 2, stdout: "", stderr: jsonLine({ error: { code: "INVALID_ARGUMENTS", message: USAGE }, ok: false }) };
  }
  try {
    const report = await values.discard({ root: values.root, ...parsed });
    return { exitCode: 0, stdout: jsonLine(report), stderr: "" };
  } catch {
    return { exitCode: 1, stdout: "", stderr: jsonLine({ error: { code: "DISCARD_FAILED", message: FAILURE }, ok: false }) };
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runDiscardStagedCli(process.argv.slice(2));
  if (result.stdout !== "") process.stdout.write(result.stdout);
  if (result.stderr !== "") process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
