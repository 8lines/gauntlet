import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { COMPOSER_IMAGE } from "./test-php-compatibility.mjs";

const CORE = "8lines/gauntlet-php-core";
const BUNDLE = "8lines/gauntlet-symfony-bundle";
// PHP serialization of Composer's path-repository options { symlink: false, relative: true }.
const PATH_OPTIONS = 'a:2:{s:7:"symlink";b:0;s:8:"relative";b:1;}';
const LOCK_CHANGED = "Composer changed the lock beyond the Gauntlet path packages";
const DIRECTORY = /^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/u;

export const COMPOSER_LOCKS = Object.freeze([
  Object.freeze({ directory: "packages/php/core", units: Object.freeze(["php-core"]), packages: Object.freeze([]) }),
  Object.freeze({ directory: "packages/php/symfony-bundle", units: Object.freeze(["php-core", "symfony-bundle"]), packages: Object.freeze([CORE]) }),
  Object.freeze({ directory: "examples/symfony", units: Object.freeze(["php-core", "symfony-bundle"]), packages: Object.freeze([CORE, BUNDLE]) }),
]);
const SOURCES = Object.freeze({
  [CORE]: Object.freeze({ unit: "php-core", manifest: "packages/php/core/composer.json" }),
  [BUNDLE]: Object.freeze({ unit: "symfony-bundle", manifest: "packages/php/symfony-bundle/composer.json" }),
});

export function pathRepositoryReference(manifestBytes) {
  return createHash("sha1").update(manifestBytes).update(PATH_OPTIONS, "latin1").digest("hex");
}

export function composerUpdateArguments({ root, directory, packages, uid, gid }) {
  if (typeof root !== "string" || !isAbsolute(root) || root.includes(",") || root.includes("\0")
      || typeof directory !== "string" || !DIRECTORY.test(directory)
      || !Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) {
    throw new Error("Composer lock target is invalid");
  }
  return [
    "run", "--rm", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--network", "bridge", "--user", `${uid}:${gid}`,
    "--env", "HOME=/tmp/home", "--env", "COMPOSER_HOME=/tmp/composer",
    "--env", "COMPOSER_CACHE_DIR=/tmp/composer-cache", "--env", "COMPOSER_NO_INTERACTION=1",
    "--mount", `type=bind,src=${root},dst=/workspace`,
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=268435456,mode=1777",
    "--workdir", `/workspace/${directory}`,
    COMPOSER_IMAGE,
    "composer", "update", ...(packages.length === 0 ? ["--lock"] : packages),
    "--no-install", "--no-scripts", "--no-plugins", "--no-audit", "--no-progress", "--ignore-platform-reqs",
  ];
}

export function verifyComposerLockUpdate({ before, after, expected }) {
  let left;
  let right;
  try {
    left = JSON.parse(before);
    right = JSON.parse(after);
  } catch {
    throw new Error(LOCK_CHANGED);
  }
  if (JSON.stringify(Object.keys(left)) !== JSON.stringify(Object.keys(right))) throw new Error(LOCK_CHANGED);
  for (const key of Object.keys(left)) {
    if (key === "content-hash") {
      if (typeof right[key] !== "string" || !/^[0-9a-f]{32}$/u.test(right[key])) throw new Error(LOCK_CHANGED);
    } else if (key !== "packages" && key !== "packages-dev" && !isDeepStrictEqual(left[key], right[key])) {
      throw new Error(LOCK_CHANGED);
    }
  }
  for (const list of ["packages", "packages-dev"]) {
    const previous = left[list] ?? [];
    const next = right[list] ?? [];
    if (previous.length !== next.length) throw new Error(LOCK_CHANGED);
    previous.forEach((entry, index) => {
      if (entry?.name !== next[index]?.name) throw new Error(LOCK_CHANGED);
      const want = expected.get(entry.name);
      const projected = want === undefined ? entry : {
        ...entry,
        version: want.version,
        dist: { ...entry.dist, reference: want.reference },
        ...(want.require === undefined ? {} : { require: { ...entry.require, ...want.require } }),
      };
      if (!isDeepStrictEqual(projected, next[index])) throw new Error(LOCK_CHANGED);
    });
  }
  for (const name of expected.keys()) {
    if (!(left.packages ?? []).some((entry) => entry.name === name)) throw new Error(LOCK_CHANGED);
  }
}

function expectedPackages(root, versions, names) {
  return new Map(names.map((name) => {
    const { unit, manifest } = SOURCES[name];
    return [name, {
      version: versions.get(unit),
      reference: pathRepositoryReference(readFileSync(resolve(root, manifest))),
      ...(name === BUNDLE ? { require: { [CORE]: `^${versions.get("php-core")}` } } : {}),
    }];
  }));
}

function runDocker(args) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10 * 60_000,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME ?? "/dev/null",
      ...(process.env.DOCKER_HOST === undefined ? {} : { DOCKER_HOST: process.env.DOCKER_HOST }),
    },
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export function repinComposerLocks({ root, versions, moved, run = runDocker }) {
  const released = new Set(moved);
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const gid = typeof process.getgid === "function" ? process.getgid() : 0;
  const changed = [];
  for (const target of COMPOSER_LOCKS.filter(({ units }) => units.some((unit) => released.has(unit)))) {
    const path = `${target.directory}/composer.lock`;
    const before = readFileSync(resolve(root, path), "utf8");
    const result = run(composerUpdateArguments({ root, directory: target.directory, packages: target.packages, uid, gid }));
    if (result.status !== 0) throw new Error(`Composer could not re-pin ${path}`);
    const after = readFileSync(resolve(root, path), "utf8");
    verifyComposerLockUpdate({ before, after, expected: expectedPackages(root, versions, target.packages) });
    if (after !== before) changed.push(path);
  }
  return changed;
}
