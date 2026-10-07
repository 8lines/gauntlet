import {
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  realpathSync,
  rmSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { types as utilTypes } from "node:util";

import { packageCanonicalTree } from "../release/tree-archive.mjs";
import { hashSkill } from "./skill-content.mjs";
import { validateSkill } from "./validate.mjs";

const SKILLS = Object.freeze(["gauntlet-app-integration", "gauntlet-extension-authoring", "gauntlet-upgrade"]);
const STABLE_VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const FAILURE = "Skill artifact staging failed closed";
const INPUT_FAILURE = "Skill artifact staging input is invalid";
const ARCHIVE_INSTALLER = fileURLToPath(new URL("archive-install.mjs", import.meta.url));

function fail() {
  throw new Error(FAILURE);
}

function optionsOf(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(INPUT_FAILURE);
  const expected = ["root", "outputDirectory", "version"];
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))
      || keys.some((key) => typeof key !== "string" || !expected.includes(key)
        || descriptors[key].enumerable !== true || !("value" in descriptors[key]))) throw new Error(INPUT_FAILURE);
  const result = Object.fromEntries(expected.map((key) => [key, descriptors[key].value]));
  if (typeof result.root !== "string" || !isAbsolute(result.root) || resolve(result.root) !== result.root
      || result.root === sep || typeof result.outputDirectory !== "string" || !isAbsolute(result.outputDirectory)
      || resolve(result.outputDirectory) !== result.outputDirectory || result.outputDirectory === sep
      || typeof result.version !== "string" || !STABLE_VERSION.test(result.version)) throw new Error(INPUT_FAILURE);
  return result;
}

function safeDirectory(path, privateDirectory = false) {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path
        || (privateDirectory && ((stat.mode & 0o077n) !== 0n
          || (typeof process.geteuid === "function" && stat.uid !== BigInt(process.geteuid()))))) fail();
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    fail();
  }
}

function copyExclusive(source, target) {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  copyFileSync(source, target, constants.COPYFILE_EXCL);
  chmodSync(target, 0o600);
}

function writeExclusive(path, bytes) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) fail();
      offset += count;
    }
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    fail();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export async function stageSkills(options) {
  const { root, outputDirectory, version } = optionsOf(options);
  safeDirectory(root);
  safeDirectory(outputDirectory, true);
  if (root === outputDirectory || root.startsWith(`${outputDirectory}${sep}`)
      || outputDirectory.startsWith(`${root}${sep}`)) fail();

  const validations = [];
  for (const name of SKILLS) {
    const validation = await validateSkill({ root, name });
    if (validation.errors.length !== 0) fail();
    validations.push(validation);
  }

  const stageRoot = realpathSync(mkdtempSync(join(tmpdir(), "gauntlet-skills-stage-")));
  chmodSync(stageRoot, 0o700);
  try {
    const entries = [];
    for (const validation of validations) {
      const source = resolve(root, "skills", validation.name);
      const target = resolve(stageRoot, "skills", validation.name);
      for (const relativePath of validation.files) {
        const archivePath = `skills/${validation.name}/${relativePath}`;
        copyExclusive(resolve(source, ...relativePath.split("/")), resolve(stageRoot, ...archivePath.split("/")));
        entries.push(archivePath);
      }
      if (await hashSkill(target) !== validation.sha256) fail();
    }
    copyExclusive(ARCHIVE_INSTALLER, resolve(stageRoot, "scripts/skills/install.mjs"));
    entries.push("scripts/skills/install.mjs");
    const manifest = {
      schemaVersion: 1,
      name: "gauntlet-skills",
      version,
      skills: validations.map(({ name, sha256, files }) => ({ name, sha256, files: [...files] })),
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    writeExclusive(resolve(stageRoot, "skills-manifest.json"), manifestBytes);
    entries.push("skills-manifest.json");
    entries.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));

    const filename = `gauntlet-skills-${version}.tgz`;
    const archive = packageCanonicalTree({
      archivePrefix: filename.slice(0, -4),
      filename,
      outputDirectory,
      sourceDirectory: stageRoot,
    });
    return Object.freeze({
      kind: "skills",
      name: "gauntlet-skills",
      version,
      path: archive.path,
      sha256: archive.sha256,
      entries: Object.freeze(entries),
    });
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    fail();
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}
