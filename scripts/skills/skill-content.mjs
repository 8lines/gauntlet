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

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const LAYOUT_FAILURE = "Skill content must use the closed regular-file layout";

function compare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function failLayout() {
  throw new Error(LAYOUT_FAILURE);
}

function safeDirectory(path) {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022n) !== 0n) failLayout();
}

function safeFile(path) {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size < 1n
      || stat.size > BigInt(MAX_FILE_BYTES) || (stat.mode & 0o022n) !== 0n) failLayout();
  return stat;
}

function walkReferences(root, directory, records) {
  safeDirectory(directory);
  const entries = readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => compare(left.name, right.name));
  if (entries.length === 0) failLayout();
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) failLayout();
    if (entry.isDirectory()) {
      walkReferences(root, path, records);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) failLayout();
    safeFile(path);
    const relativePath = relative(root, path).split(sep).join("/");
    if (!relativePath.startsWith("references/") || relativePath.split("/").some((segment) => segment === "..")) failLayout();
    records.push(relativePath);
  }
}

export async function listSkillFiles(skillDirectory) {
  try {
    if (typeof skillDirectory !== "string" || !isAbsolute(skillDirectory) || resolve(skillDirectory) !== skillDirectory
        || skillDirectory === "/" || skillDirectory.includes("\0")) failLayout();
    safeDirectory(skillDirectory);
    const rootEntries = readdirSync(skillDirectory).sort(compare);
    if (rootEntries.join("\0") !== ["SKILL.md", "agents", "references"].sort(compare).join("\0")) failLayout();
    safeFile(resolve(skillDirectory, "SKILL.md"));
    const agents = resolve(skillDirectory, "agents");
    safeDirectory(agents);
    if (readdirSync(agents).join("\0") !== "openai.yaml") failLayout();
    safeFile(resolve(agents, "openai.yaml"));
    const records = ["SKILL.md", "agents/openai.yaml"];
    walkReferences(skillDirectory, resolve(skillDirectory, "references"), records);
    return Object.freeze(records.sort(compare));
  } catch (error) {
    if (error instanceof Error && error.message === LAYOUT_FAILURE) throw error;
    failLayout();
  }
}

function sameFile(left, right) {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino
    && left.mode === right.mode && left.nlink === right.nlink && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function readStable(path) {
  let descriptor;
  try {
    const pathBefore = safeFile(path);
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_CLOEXEC);
    const descriptorBefore = fstatSync(descriptor, { bigint: true });
    if (!sameFile(pathBefore, descriptorBefore)) failLayout();
    const size = Number(descriptorBefore.size);
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(descriptor, bytes, offset, size - offset, offset);
      if (count <= 0) failLayout();
      offset += count;
    }
    const descriptorAfter = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(path, { bigint: true });
    if (!sameFile(descriptorBefore, descriptorAfter) || !sameFile(descriptorAfter, pathAfter)) failLayout();
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.message === LAYOUT_FAILURE) throw error;
    failLayout();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export async function hashSkill(skillDirectory) {
  const files = await listSkillFiles(skillDirectory);
  const hash = createHash("sha256");
  let total = 0;
  for (const relativePath of files) {
    const bytes = readStable(resolve(skillDirectory, ...relativePath.split("/")));
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) failLayout();
    hash.update(relativePath, "utf8");
    hash.update(Buffer.from([0]));
    hash.update(bytes);
    hash.update(Buffer.from([0]));
  }
  return hash.digest("hex");
}
