import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  access,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { generateExternalInputsManifest, hashExternalInputs } from "../external-inputs.mjs";

const SHA256 = "0".repeat(64);
const compare = (left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const resolveRepositoryRoot = () => fileURLToPath(new URL("../../..", import.meta.url));

async function treeDigest(root, excludedTopLevel = []) {
  const files = [];
  const excluded = new Set(excludedTopLevel);
  async function visit(directory, depth = 0) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => compare(left.name, right.name))) {
      if (depth === 0 && excluded.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path, depth + 1);
      else if (entry.isFile()) files.push(path);
    }
  }
  await visit(root);
  const orderedFiles = files.sort(compare);
  const length = (value) => {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64BE(BigInt(value));
    return bytes;
  };
  const framed = (hash, tag, value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
    hash.update(Buffer.from([tag]));
    hash.update(length(bytes.length));
    hash.update(bytes);
  };
  const hash = createHash("sha256");
  hash.update("gauntlet-external-input-tree-v2\0", "ascii");
  hash.update(Buffer.from([0x01]));
  hash.update(length(orderedFiles.length));
  for (const path of orderedFiles) {
    hash.update(Buffer.from([0x02]));
    framed(hash, 0x03, relative(root, path).split("\\").join("/"));
    framed(hash, 0x04, await readFile(path));
  }
  return hash.digest("hex");
}

async function writeManifest(evaluationRoot, manifest) {
  await writeFile(
    join(evaluationRoot, "external-inputs.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gauntlet-external-inputs-"));
  const evaluationRoot = join(root, "skill-evals", "safe-integration");
  const sourceTree = join(root, "packages", "sdk");
  const runtimeTree = join(root, "node_modules", ".pnpm", "runtime@1.0.0", "node_modules", "runtime");
  const sourceFile = join(root, "tooling", "version.txt");
  await mkdir(join(sourceTree, "src"), { recursive: true, mode: 0o700 });
  await mkdir(join(sourceTree, "node_modules"), { recursive: true, mode: 0o700 });
  await mkdir(runtimeTree, { recursive: true, mode: 0o700 });
  await mkdir(dirname(sourceFile), { recursive: true, mode: 0o700 });
  await mkdir(evaluationRoot, { recursive: true, mode: 0o700 });
  await writeFile(join(sourceTree, "package.json"), "{\"name\":\"sdk\"}\n", { mode: 0o600 });
  await writeFile(join(sourceTree, "src", "index.js"), "export const value = 1;\n", { mode: 0o600 });
  await writeFile(join(sourceTree, "node_modules", "ignored.txt"), "ignored\n", { mode: 0o600 });
  await writeFile(join(runtimeTree, "index.js"), "export const runtime = 1;\n", { mode: 0o600 });
  await writeFile(sourceFile, "v1\n", { mode: 0o600 });
  const manifest = {
    schemaVersion: 1,
    sourceFiles: [{ path: "tooling/version.txt", sha256: digest(await readFile(sourceFile)) }],
    sourceTrees: [{
      path: "packages/sdk",
      excludedTopLevel: ["node_modules", "vendor"],
      sha256: await treeDigest(sourceTree, ["node_modules", "vendor"]),
    }],
    linkedRuntimeTrees: [{
      path: "node_modules/.pnpm/runtime@1.0.0/node_modules/runtime",
      sha256: await treeDigest(runtimeTree),
    }],
  };
  await writeManifest(evaluationRoot, manifest);
  return { evaluationRoot, manifest, root, runtimeTree, sourceFile, sourceTree };
}

test("generates canonical content from a closed declaration and verifies its own output", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.root, { recursive: true, force: true }));
  const manifestPath = join(current.evaluationRoot, "external-inputs.json");
  await rm(manifestPath);

  const generatedHash = generateExternalInputsManifest({
    root: current.root,
    evaluationRoot: current.evaluationRoot,
    sourceFiles: ["tooling/version.txt"],
    sourceTrees: [{ path: "packages/sdk", excludedTopLevel: ["node_modules", "vendor"] }],
    linkedRuntimeTrees: ["node_modules/.pnpm/runtime@1.0.0/node_modules/runtime"],
  });
  assert.equal(generatedHash, hashExternalInputs({ root: current.root, evaluationRoot: current.evaluationRoot }));
  assert.equal(await readFile(manifestPath, "utf8"), `${JSON.stringify(current.manifest, null, 2)}\n`);
});

test("generator refuses overwrite and invalid declarations without changing output", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.root, { recursive: true, force: true }));
  const manifestPath = join(current.evaluationRoot, "external-inputs.json");
  const before = await readFile(manifestPath);
  assert.throws(() => generateExternalInputsManifest({
    root: current.root,
    evaluationRoot: current.evaluationRoot,
    sourceFiles: ["tooling/version.txt"],
    sourceTrees: [],
    linkedRuntimeTrees: [],
  }), /closed content-bound layout/u);
  assert.deepEqual(await readFile(manifestPath), before);

  await rm(manifestPath);
  assert.throws(() => generateExternalInputsManifest({
    root: current.root,
    evaluationRoot: current.evaluationRoot,
    sourceFiles: ["tooling/version.txt"],
    sourceTrees: [{ path: "packages/sdk", excludedTopLevel: ["coverage"] }],
    linkedRuntimeTrees: [],
  }), /closed content-bound layout/u);
  await assert.rejects(access(manifestPath), { code: "ENOENT" });
});

test("hashes a closed manifest and binds the exclusion declaration", async (t) => {
  const first = await fixture();
  const second = await fixture();
  t.after(() => Promise.all([first.root, second.root].map((path) => rm(path, { recursive: true, force: true }))));

  const firstHash = hashExternalInputs({ root: first.root, evaluationRoot: first.evaluationRoot });
  assert.match(firstHash, /^[a-f0-9]{64}$/u);
  assert.equal(firstHash, hashExternalInputs({ root: first.root, evaluationRoot: first.evaluationRoot }));
  assert.equal(firstHash, hashExternalInputs({ root: second.root, evaluationRoot: second.evaluationRoot }));

  second.manifest.sourceTrees[0].excludedTopLevel = ["node_modules"];
  second.manifest.sourceTrees[0].sha256 = await treeDigest(second.sourceTree, ["node_modules"]);
  await writeManifest(second.evaluationRoot, second.manifest);
  assert.notEqual(firstHash, hashExternalInputs({ root: second.root, evaluationRoot: second.evaluationRoot }));
});

test("tree and bound-manifest hashes distinguish NUL-delimited layout ambiguity", async (t) => {
  async function collisionFixture(files) {
    const root = await mkdtemp(join(tmpdir(), "gauntlet-external-framing-"));
    const evaluationRoot = join(root, "skill-evals", "safe-integration");
    const sourceTree = join(root, "packages", "sdk");
    await mkdir(evaluationRoot, { recursive: true, mode: 0o700 });
    await mkdir(sourceTree, { recursive: true, mode: 0o700 });
    for (const [name, bytes] of Object.entries(files)) {
      await writeFile(join(sourceTree, name), bytes, { mode: 0o600 });
    }
    return { root, evaluationRoot };
  }

  const combined = await collisionFixture({ a: Buffer.from("X\0b\0Y") });
  const split = await collisionFixture({ a: Buffer.from("X"), b: Buffer.from("Y") });
  t.after(() => Promise.all([combined.root, split.root].map((path) => rm(path, { recursive: true, force: true }))));
  const declaration = {
    sourceFiles: [],
    sourceTrees: [{ path: "packages/sdk", excludedTopLevel: [] }],
    linkedRuntimeTrees: [],
  };

  const combinedBoundManifestSha256 = generateExternalInputsManifest({
    root: combined.root,
    evaluationRoot: combined.evaluationRoot,
    ...declaration,
  });
  const splitBoundManifestSha256 = generateExternalInputsManifest({
    root: split.root,
    evaluationRoot: split.evaluationRoot,
    ...declaration,
  });
  const combinedManifest = JSON.parse(await readFile(join(combined.evaluationRoot, "external-inputs.json"), "utf8"));
  const splitManifest = JSON.parse(await readFile(join(split.evaluationRoot, "external-inputs.json"), "utf8"));

  assert.notEqual(combinedManifest.sourceTrees[0].sha256, splitManifest.sourceTrees[0].sha256);
  assert.notEqual(combinedBoundManifestSha256, splitBoundManifestSha256);
  assert.equal(combinedBoundManifestSha256, hashExternalInputs(combined));
  assert.equal(splitBoundManifestSha256, hashExternalInputs(split));
});

test("permits only the fixed PHPUnit cache-file exclusion and still validates its metadata", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.root, { recursive: true, force: true }));
  const cachePath = join(current.sourceTree, ".phpunit.result.cache");
  await writeFile(cachePath, "first ignored cache value\n", { mode: 0o600 });
  current.manifest.sourceTrees[0].excludedTopLevel = [
    ".phpunit.result.cache",
    "node_modules",
    "vendor",
  ];
  current.manifest.sourceTrees[0].sha256 = await treeDigest(
    current.sourceTree,
    current.manifest.sourceTrees[0].excludedTopLevel,
  );
  await writeManifest(current.evaluationRoot, current.manifest);
  const first = hashExternalInputs({ root: current.root, evaluationRoot: current.evaluationRoot });

  await writeFile(cachePath, "second ignored cache value\n", { mode: 0o600 });
  assert.equal(hashExternalInputs({ root: current.root, evaluationRoot: current.evaluationRoot }), first);

  await chmod(cachePath, 0o620);
  assert.throws(
    () => hashExternalInputs({ root: current.root, evaluationRoot: current.evaluationRoot }),
    /closed content-bound layout/u,
  );

  const linked = await fixture();
  t.after(() => rm(linked.root, { recursive: true, force: true }));
  const linkedCache = join(linked.sourceTree, ".phpunit.result.cache");
  await symlink("package.json", linkedCache);
  linked.manifest.sourceTrees[0].excludedTopLevel = [
    ".phpunit.result.cache",
    "node_modules",
    "vendor",
  ];
  await writeManifest(linked.evaluationRoot, linked.manifest);
  assert.throws(
    () => hashExternalInputs({ root: linked.root, evaluationRoot: linked.evaluationRoot }),
    /closed content-bound layout/u,
  );
});

test("permits a top-level generated dist tree without binding evaluation evidence to build output", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.root, { recursive: true, force: true }));
  const distPath = join(current.sourceTree, "dist");
  await mkdir(distPath, { mode: 0o700 });
  await writeFile(join(distPath, "index.js"), "export const generated = 1;\n", { mode: 0o600 });
  current.manifest.sourceTrees[0].excludedTopLevel = ["dist", "node_modules", "vendor"];
  current.manifest.sourceTrees[0].sha256 = await treeDigest(
    current.sourceTree,
    current.manifest.sourceTrees[0].excludedTopLevel,
  );
  await writeManifest(current.evaluationRoot, current.manifest);
  const before = hashExternalInputs({ root: current.root, evaluationRoot: current.evaluationRoot });

  await writeFile(join(distPath, "index.js"), "export const generated = 2;\n", { mode: 0o600 });
  assert.equal(hashExternalInputs({ root: current.root, evaluationRoot: current.evaluationRoot }), before);
});

test("checked-in source-tree declarations do not bind ignored build or local files", async () => {
  const root = resolveRepositoryRoot();
  for (const evaluation of ["gauntlet-app-integration", "gauntlet-extension-authoring"]) {
    const manifest = JSON.parse(await readFile(
      resolve(root, "skill-evals", evaluation, "external-inputs.json"),
      "utf8",
    ));
    for (const tree of manifest.sourceTrees) {
      const listed = spawnSync(
        "git",
        ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", tree.path],
        { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
      );
      assert.equal(listed.status, 0, listed.stderr);
      const prefix = `${tree.path}/`;
      const unexpected = listed.stdout.split("\0").filter(Boolean).filter((path) => {
        const relativePath = path.slice(prefix.length);
        return !tree.excludedTopLevel.some((excluded) => (
          relativePath === excluded || relativePath.startsWith(`${excluded}/`)
        ));
      });
      assert.deepEqual(unexpected, [], `${evaluation}:${tree.path} binds ignored files`);
    }
  }
});

test("checked-in evaluation manifests retain their audited closed declarations", async () => {
  const root = resolveRepositoryRoot();
  const readDeclaration = async (evaluation) => {
    const manifest = JSON.parse(await readFile(
      resolve(root, "skill-evals", evaluation, "external-inputs.json"),
      "utf8",
    ));
    return {
      sourceFiles: manifest.sourceFiles.map(({ path }) => path),
      sourceTrees: manifest.sourceTrees.map(({ path, excludedTopLevel }) => ({ path, excludedTopLevel })),
    };
  };

  assert.deepEqual(await readDeclaration("gauntlet-app-integration"), {
    sourceFiles: [
      ".npmrc",
      "LICENSE",
      "VERSION",
      "examples/symfony/composer.json",
      "examples/symfony/composer.lock",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "scripts/release/release-model.mjs",
      "scripts/release/stage-composer.mjs",
      "tsconfig.base.json",
    ],
    sourceTrees: [
      { path: "packages/dashboard-client", excludedTopLevel: ["dist", "node_modules"] },
      { path: "packages/php/core", excludedTopLevel: [".phpunit.result.cache", "vendor"] },
      { path: "packages/php/symfony-bundle", excludedTopLevel: [".phpunit.result.cache", "vendor"] },
      { path: "packages/protocol", excludedTopLevel: ["dist", "node_modules"] },
      { path: "packages/typescript/core", excludedTopLevel: ["dist", "node_modules"] },
      { path: "packages/typescript/node", excludedTopLevel: ["dist", "node_modules"] },
    ],
  });
  assert.deepEqual(await readDeclaration("gauntlet-extension-authoring"), {
    sourceFiles: [
      ".npmrc",
      "package.json",
      "packages/protocol/package.json",
      "packages/typescript/core/package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
    ],
    sourceTrees: [
      { path: "packages/protocol/schemas/v1", excludedTopLevel: [] },
      { path: "packages/protocol/src", excludedTopLevel: [] },
      { path: "packages/typescript/core/src", excludedTopLevel: [] },
    ],
  });
});

test("CLI accepts one canonical closed declaration, verifies output, and refuses overwrite", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.root, { recursive: true, force: true }));
  const manifestPath = join(current.evaluationRoot, "external-inputs.json");
  await rm(manifestPath);
  const declaration = JSON.stringify({
    schemaVersion: 1,
    sourceFiles: ["tooling/version.txt"],
    sourceTrees: [{ path: "packages/sdk", excludedTopLevel: ["node_modules", "vendor"] }],
    linkedRuntimeTrees: ["node_modules/.pnpm/runtime@1.0.0/node_modules/runtime"],
  });
  const args = [
    "scripts/skills/external-inputs.mjs",
    "generate",
    "--root",
    current.root,
    "--evaluation-root",
    current.evaluationRoot,
    "--declaration-json",
    declaration,
  ];
  const generated = spawnSync(process.execPath, args, { cwd: resolveRepositoryRoot(), encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  assert.equal(generated.stderr, "");
  const output = JSON.parse(generated.stdout);
  assert.deepEqual(Object.keys(output), ["externalInputsSha256"]);
  assert.equal(
    output.externalInputsSha256,
    hashExternalInputs({ root: current.root, evaluationRoot: current.evaluationRoot }),
  );
  assert.equal(generated.stdout, `${JSON.stringify(output)}\n`);
  const before = await readFile(manifestPath);

  const repeated = spawnSync(process.execPath, args, { cwd: resolveRepositoryRoot(), encoding: "utf8" });
  assert.notEqual(repeated.status, 0);
  assert.equal(repeated.stdout, "");
  assert.match(repeated.stderr, /closed content-bound layout/u);
  assert.deepEqual(await readFile(manifestPath), before);
});

test("CLI rejects non-canonical or open declarations before creating a manifest", async (t) => {
  const inputs = [
    '{"schemaVersion":1, "sourceFiles":["tooling/version.txt"],"sourceTrees":[],"linkedRuntimeTrees":[]}',
    JSON.stringify({
      schemaVersion: 1,
      sourceFiles: ["tooling/version.txt"],
      sourceTrees: [],
      linkedRuntimeTrees: [],
      overwrite: true,
    }),
  ];
  for (const declaration of inputs) {
    const current = await fixture();
    t.after(() => rm(current.root, { recursive: true, force: true }));
    const manifestPath = join(current.evaluationRoot, "external-inputs.json");
    await rm(manifestPath);
    const generated = spawnSync(process.execPath, [
      "scripts/skills/external-inputs.mjs",
      "generate",
      "--root",
      current.root,
      "--evaluation-root",
      current.evaluationRoot,
      "--declaration-json",
      declaration,
    ], { cwd: resolveRepositoryRoot(), encoding: "utf8" });
    assert.notEqual(generated.status, 0);
    assert.equal(generated.stdout, "");
    assert.match(generated.stderr, /closed content-bound layout/u);
    await assert.rejects(access(manifestPath), { code: "ENOENT" });
  }
});

test("allows a runtime tree link only after entering node_modules", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.root, { recursive: true, force: true }));
  await symlink(current.runtimeTree, join(current.root, "node_modules", "runtime-link"));
  current.manifest.linkedRuntimeTrees = [{
    path: "node_modules/runtime-link",
    sha256: await treeDigest(current.runtimeTree),
  }];
  await writeManifest(current.evaluationRoot, current.manifest);
  assert.match(
    hashExternalInputs({ root: current.root, evaluationRoot: current.evaluationRoot }),
    /^[a-f0-9]{64}$/u,
  );
});

test("rejects a false manifest digest and every bound content mutation", async (t) => {
  const roots = [];
  t.after(() => Promise.all(roots.map((path) => rm(path, { recursive: true, force: true }))));
  const cases = [
    async ({ evaluationRoot, manifest }) => {
      manifest.sourceFiles[0].sha256 = SHA256;
      await writeManifest(evaluationRoot, manifest);
    },
    async ({ sourceFile }) => writeFile(sourceFile, "v2\n", { mode: 0o600 }),
    async ({ sourceTree }) => writeFile(join(sourceTree, "extra.js"), "extra\n", { mode: 0o600 }),
    async ({ runtimeTree }) => writeFile(join(runtimeTree, "index.js"), "changed\n", { mode: 0o600 }),
  ];
  for (const mutate of cases) {
    const current = await fixture();
    roots.push(current.root);
    await mutate(current);
    assert.throws(
      () => hashExternalInputs({ root: current.root, evaluationRoot: current.evaluationRoot }),
      /closed content-bound layout/u,
    );
  }
});

test("rejects symlinks, hardlinks, special files, and writable source metadata", async (t) => {
  const roots = [];
  t.after(() => Promise.all(roots.map((path) => rm(path, { recursive: true, force: true }))));

  const linkedSource = await fixture();
  roots.push(linkedSource.root);
  await symlink("index.js", join(linkedSource.sourceTree, "src", "alias.js"));
  assert.throws(() => hashExternalInputs({ root: linkedSource.root, evaluationRoot: linkedSource.evaluationRoot }), /closed content-bound layout/u);

  const hardlinkedSource = await fixture();
  roots.push(hardlinkedSource.root);
  await link(
    join(hardlinkedSource.sourceTree, "src", "index.js"),
    join(hardlinkedSource.sourceTree, "src", "copy.js"),
  );
  hardlinkedSource.manifest.sourceTrees[0].sha256 = await treeDigest(
    hardlinkedSource.sourceTree,
    hardlinkedSource.manifest.sourceTrees[0].excludedTopLevel,
  );
  await writeManifest(hardlinkedSource.evaluationRoot, hardlinkedSource.manifest);
  assert.throws(() => hashExternalInputs({ root: hardlinkedSource.root, evaluationRoot: hardlinkedSource.evaluationRoot }), /closed content-bound layout/u);

  const writableSource = await fixture();
  roots.push(writableSource.root);
  await chmod(join(writableSource.sourceTree, "src", "index.js"), 0o620);
  assert.throws(() => hashExternalInputs({ root: writableSource.root, evaluationRoot: writableSource.evaluationRoot }), /closed content-bound layout/u);

  const specialSource = await fixture();
  roots.push(specialSource.root);
  const fifo = join(specialSource.sourceTree, "src", "pipe");
  const created = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  assert.equal((await lstat(fifo)).isFIFO(), true);
  assert.throws(() => hashExternalInputs({ root: specialSource.root, evaluationRoot: specialSource.evaluationRoot }), /closed content-bound layout/u);
});

test("does not let exclusions conceal an unsafe top-level entry", async (t) => {
  const current = await fixture();
  t.after(() => rm(current.root, { recursive: true, force: true }));
  await rm(join(current.sourceTree, "node_modules"), { recursive: true });
  await symlink(current.runtimeTree, join(current.sourceTree, "node_modules"));
  assert.throws(
    () => hashExternalInputs({ root: current.root, evaluationRoot: current.evaluationRoot }),
    /closed content-bound layout/u,
  );
});

test("rejects linked runtime paths that escape or traverse a symlink before node_modules", async (t) => {
  const roots = [];
  t.after(() => Promise.all(roots.map((path) => rm(path, { recursive: true, force: true }))));

  const escaped = await fixture();
  roots.push(escaped.root);
  const outside = await mkdtemp(join(tmpdir(), "gauntlet-runtime-outside-"));
  roots.push(outside);
  await writeFile(join(outside, "index.js"), "outside\n", { mode: 0o600 });
  await symlink(outside, join(escaped.root, "node_modules", "escape"));
  escaped.manifest.linkedRuntimeTrees = [{ path: "node_modules/escape", sha256: await treeDigest(outside) }];
  await writeManifest(escaped.evaluationRoot, escaped.manifest);
  assert.throws(() => hashExternalInputs({ root: escaped.root, evaluationRoot: escaped.evaluationRoot }), /closed content-bound layout/u);

  const earlyLink = await fixture();
  roots.push(earlyLink.root);
  const container = join(earlyLink.root, "node_modules", ".pnpm", "container");
  const nestedRuntime = join(container, "node_modules", "runtime");
  await mkdir(nestedRuntime, { recursive: true, mode: 0o700 });
  await writeFile(join(nestedRuntime, "index.js"), "nested\n", { mode: 0o600 });
  await symlink(container, join(earlyLink.root, "alias"));
  earlyLink.manifest.linkedRuntimeTrees = [{
    path: "alias/node_modules/runtime",
    sha256: await treeDigest(nestedRuntime),
  }];
  await writeManifest(earlyLink.evaluationRoot, earlyLink.manifest);
  assert.throws(() => hashExternalInputs({ root: earlyLink.root, evaluationRoot: earlyLink.evaluationRoot }), /closed content-bound layout/u);
});

test("rejects malformed, unsorted, overlapping, or unbounded declarations", async (t) => {
  const roots = [];
  t.after(() => Promise.all(roots.map((path) => rm(path, { recursive: true, force: true }))));
  const manifests = [];

  const empty = await fixture();
  roots.push(empty.root);
  manifests.push([empty, { schemaVersion: 1, sourceFiles: [], sourceTrees: [], linkedRuntimeTrees: [] }]);

  const overlap = await fixture();
  roots.push(overlap.root);
  manifests.push([overlap, {
    ...overlap.manifest,
    sourceFiles: [{
      path: "packages/sdk/package.json",
      sha256: digest(await readFile(join(overlap.sourceTree, "package.json"))),
    }],
  }]);

  const unsorted = await fixture();
  roots.push(unsorted.root);
  await writeFile(join(unsorted.root, "tooling", "aaa.txt"), "a\n", { mode: 0o600 });
  manifests.push([unsorted, {
    ...unsorted.manifest,
    sourceFiles: [
      unsorted.manifest.sourceFiles[0],
      { path: "tooling/aaa.txt", sha256: digest("a\n") },
    ],
  }]);

  const unsafeExclusion = await fixture();
  roots.push(unsafeExclusion.root);
  manifests.push([unsafeExclusion, {
    ...unsafeExclusion.manifest,
    sourceTrees: [{ ...unsafeExclusion.manifest.sourceTrees[0], excludedTopLevel: ["coverage"] }],
  }]);

  const extraProperty = await fixture();
  roots.push(extraProperty.root);
  manifests.push([extraProperty, { ...extraProperty.manifest, extra: true }]);

  const tooMany = await fixture();
  roots.push(tooMany.root);
  manifests.push([tooMany, {
    schemaVersion: 1,
    sourceFiles: Array.from({ length: 257 }, (_, index) => ({
      path: `inputs/${String(index).padStart(3, "0")}.txt`,
      sha256: SHA256,
    })),
    sourceTrees: [],
    linkedRuntimeTrees: [],
  }]);

  for (const [current, manifest] of manifests) {
    await writeManifest(current.evaluationRoot, manifest);
    assert.throws(
      () => hashExternalInputs({ root: current.root, evaluationRoot: current.evaluationRoot }),
      /closed content-bound layout/u,
    );
  }
});
