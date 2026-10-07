import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, link, mkdtemp, mkdir, readFile, readdir, realpath, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { stageSkills } from "../release-artifact.mjs";
import { hashSkill } from "../skill-content.mjs";
import { cleanup, exists, validFixture } from "./support.mjs";

const execFileAsync = promisify(execFile);
const VERSION = "0.1.0";

async function skillsFixture(t) {
  const root = await validFixture("gauntlet-app-integration");
  const others = [];
  for (const name of ["gauntlet-extension-authoring", "gauntlet-upgrade"]) {
    const other = await validFixture(name);
    others.push(other);
    for (const directory of ["skills", "skill-evals"]) {
      await cp(join(other, directory, name), join(root, directory, name), { recursive: true, errorOnExist: true, force: false });
    }
  }
  const output = await mkdtemp(join(tmpdir(), "gauntlet-skills-artifact-"));
  const secondOutput = await mkdtemp(join(tmpdir(), "gauntlet-skills-artifact-repeat-"));
  await Promise.all([chmod(output, 0o700), chmod(secondOutput, 0o700)]);
  t.after(() => cleanup(root, ...others, output, secondOutput));
  return {
    output: await realpath(output),
    root: await realpath(root),
    secondOutput: await realpath(secondOutput),
  };
}

test("stages a deterministic, self-installing archive containing only validated skills", async (t) => {
  const { output, root, secondOutput } = await skillsFixture(t);
  const options = { root, outputDirectory: output, version: VERSION };
  const first = await stageSkills(options);
  const second = await stageSkills({ root, outputDirectory: secondOutput, version: VERSION });

  assert.deepEqual(
    { kind: first.kind, name: first.name, version: first.version, filename: basename(first.path) },
    { kind: "skills", name: "gauntlet-skills", version: VERSION, filename: "gauntlet-skills-0.1.0.tgz" },
  );
  assert.equal(first.sha256, second.sha256);
  assert.deepEqual(await readFile(first.path), await readFile(second.path));
  for (const name of ["gauntlet-app-integration", "gauntlet-extension-authoring", "gauntlet-upgrade"]) {
    assert.equal(first.entries.includes(`skills/${name}/SKILL.md`), true);
    assert.equal(first.entries.includes(`skills/${name}/agents/openai.yaml`), true);
    assert.equal(first.entries.some((entry) => entry.startsWith(`skills/${name}/references/`)), true);
  }
  assert.equal(first.entries.includes("scripts/skills/install.mjs"), true);
  assert.equal(first.entries.includes("skills-manifest.json"), true);
  assert.equal(first.entries.some((entry) => entry.includes("skill-evals") || entry.includes("results/")), false);

  const extracted = await mkdtemp(join(tmpdir(), "gauntlet-skills-extracted-"));
  const destinationParent = await mkdtemp(join(tmpdir(), "gauntlet-skills-installed-parent-"));
  await Promise.all([chmod(extracted, 0o700), chmod(destinationParent, 0o700)]);
  const destination = join(await realpath(destinationParent), "skills");
  await mkdir(destination, { mode: 0o755 });
  t.after(() => cleanup(extracted, destinationParent));
  await execFileAsync("tar", ["-xzf", first.path, "-C", extracted]);
  const archiveRoot = join(extracted, `gauntlet-skills-${VERSION}`);
  const installerSource = await readFile(join(archiveRoot, "scripts/skills/install.mjs"), "utf8");
  assert.match(installerSource, /\/run\/current-system\/sw\/bin\/ls/u);
  assert.match(installerSource, /\/nix\/var\/nix\/profiles\/default\/bin\/ls/u);
  assert.doesNotMatch(installerSource, /spawnSync\("\/bin\/ls"/u);
  const manifest = JSON.parse(await readFile(join(archiveRoot, "skills-manifest.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest), ["schemaVersion", "name", "version", "skills"]);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.name, "gauntlet-skills");
  assert.equal(manifest.version, VERSION);
  assert.deepEqual(manifest.skills.map(({ name }) => name), [
    "gauntlet-app-integration",
    "gauntlet-extension-authoring",
    "gauntlet-upgrade",
  ]);

  const appResult = await execFileAsync(process.execPath, [
    join(archiveRoot, "scripts/skills/install.mjs"),
    "--destination",
    destination,
    "gauntlet-app-integration",
  ]);
  const extensionResult = await execFileAsync(process.execPath, [
    join(archiveRoot, "scripts/skills/install.mjs"),
    "--destination",
    destination,
    "gauntlet-extension-authoring",
  ]);
  const upgradeResult = await execFileAsync(process.execPath, [
    join(archiveRoot, "scripts/skills/install.mjs"),
    "--destination",
    destination,
    "gauntlet-upgrade",
  ]);
  assert.equal(appResult.stderr, "");
  assert.equal(extensionResult.stderr, "");
  assert.equal(upgradeResult.stderr, "");
  assert.deepEqual(JSON.parse(appResult.stdout).installed, ["gauntlet-app-integration"]);
  assert.deepEqual(JSON.parse(extensionResult.stdout).installed, ["gauntlet-extension-authoring"]);
  assert.deepEqual(JSON.parse(upgradeResult.stdout).installed, ["gauntlet-upgrade"]);
  for (const entry of manifest.skills) {
    assert.deepEqual(Object.keys(entry), ["name", "sha256", "files"]);
    assert.equal(await hashSkill(join(destination, entry.name)), entry.sha256);
  }

  await assert.rejects(execFileAsync(process.execPath, [
    join(archiveRoot, "scripts/skills/install.mjs"),
    "--destination",
    destination,
    "gauntlet-app-integration",
  ]), /Skill archive installation failed closed/u);

  const multiDestination = await mkdtemp(join(tmpdir(), "gauntlet-skills-multi-install-"));
  await chmod(multiDestination, 0o700);
  t.after(() => cleanup(multiDestination));
  await assert.rejects(execFileAsync(process.execPath, [
    join(archiveRoot, "scripts/skills/install.mjs"),
    "--destination",
    multiDestination,
    "gauntlet-app-integration",
    "gauntlet-extension-authoring",
  ]), /Skill archive installation failed closed/u);
  assert.deepEqual(await readdir(multiDestination), []);

  const lockedParent = await mkdtemp(join(tmpdir(), "gauntlet-skills-locked-parent-"));
  await chmod(lockedParent, 0o700);
  const lockedDestination = join(await realpath(lockedParent), "skills");
  await mkdir(lockedDestination, { mode: 0o700 });
  const lockId = createHash("sha256").update(lockedDestination, "utf8").digest("hex").slice(0, 24);
  const lockPath = join(await realpath(lockedParent), `.gauntlet-skills-install-${lockId}.lock`);
  await writeFile(lockPath, "held\n", { mode: 0o600 });
  t.after(() => cleanup(lockedParent));
  await assert.rejects(execFileAsync(process.execPath, [
    join(archiveRoot, "scripts/skills/install.mjs"),
    "--destination",
    lockedDestination,
    "gauntlet-app-integration",
  ]), /Skill archive installation failed closed/u);
  assert.equal(await readFile(lockPath, "utf8"), "held\n");
  assert.equal(await exists(join(lockedDestination, "gauntlet-app-integration")), false);

  const staleParent = await mkdtemp(join(tmpdir(), "gauntlet-skills-stale-parent-"));
  await chmod(staleParent, 0o700);
  const staleDestination = join(await realpath(staleParent), "skills");
  await mkdir(staleDestination, { mode: 0o700 });
  const staleId = createHash("sha256").update(staleDestination, "utf8").digest("hex").slice(0, 24);
  const stalePath = join(await realpath(staleParent), `.gauntlet-skills-install-${staleId}.lock`);
  const staleNonce = "a".repeat(32);
  const staleScratch = join(
    await realpath(staleParent),
    `.gauntlet-skill-gauntlet-app-integration-${staleNonce}`,
  );
  await mkdir(staleScratch, { mode: 0o700 });
  await writeFile(join(staleScratch, "partial"), "interrupted\n", { mode: 0o600 });
  await writeFile(stalePath, `${JSON.stringify({
    schemaVersion: 1,
    pid: 2_147_483_647,
    createdAt: "2000-01-01T00:00:00.000Z",
    nonce: staleNonce,
    skillName: "gauntlet-app-integration",
  })}\n`, { mode: 0o600 });
  const staleOwner = join(
    await realpath(staleParent),
    `.gauntlet-lock-owner-${staleId}-${staleNonce}`,
  );
  await link(stalePath, staleOwner);
  await utimes(stalePath, new Date(0), new Date(0));
  t.after(() => cleanup(staleParent));
  const recovered = await execFileAsync(process.execPath, [
    join(archiveRoot, "scripts/skills/install.mjs"),
    "--destination",
    staleDestination,
    "gauntlet-app-integration",
  ]);
  assert.deepEqual(JSON.parse(recovered.stdout).installed, ["gauntlet-app-integration"]);
  assert.equal(await exists(stalePath), false);
  assert.equal(await exists(staleOwner), false);
  assert.equal(await exists(staleScratch), false);
  assert.deepEqual(
    (await readdir(await realpath(staleParent))).filter((entry) => entry.startsWith(".gauntlet-retired-")),
    [],
  );

  const orphanParent = await mkdtemp(join(tmpdir(), "gauntlet-skills-orphan-parent-"));
  await chmod(orphanParent, 0o700);
  const orphanDestination = join(await realpath(orphanParent), "skills");
  await mkdir(orphanDestination, { mode: 0o700 });
  const orphanId = createHash("sha256").update(orphanDestination, "utf8").digest("hex").slice(0, 24);
  const orphanNonce = "b".repeat(32);
  const orphanPath = join(
    await realpath(orphanParent),
    `.gauntlet-lock-owner-${orphanId}-${orphanNonce}`,
  );
  await writeFile(orphanPath, `${JSON.stringify({
    schemaVersion: 1,
    pid: 2_147_483_647,
    createdAt: "2000-01-01T00:00:00.000Z",
    nonce: orphanNonce,
    skillName: "gauntlet-app-integration",
  })}\n`, { mode: 0o600 });
  await utimes(orphanPath, new Date(0), new Date(0));
  t.after(() => cleanup(orphanParent));
  const afterOrphan = await execFileAsync(process.execPath, [
    join(archiveRoot, "scripts/skills/install.mjs"),
    "--destination",
    orphanDestination,
    "gauntlet-app-integration",
  ]);
  assert.deepEqual(JSON.parse(afterOrphan.stdout).installed, ["gauntlet-app-integration"]);
  assert.equal(await exists(orphanPath), false);

  const emptyOwnerParent = await mkdtemp(join(tmpdir(), "gauntlet-skills-empty-owner-parent-"));
  await chmod(emptyOwnerParent, 0o700);
  const emptyOwnerDestination = join(await realpath(emptyOwnerParent), "skills");
  await mkdir(emptyOwnerDestination, { mode: 0o700 });
  const emptyOwnerId = createHash("sha256").update(emptyOwnerDestination, "utf8").digest("hex").slice(0, 24);
  const emptyOwnerPaths = Array.from({ length: 257 }, (_, index) => join(
    emptyOwnerParent,
    `.gauntlet-lock-owner-${emptyOwnerId}-${index.toString(16).padStart(32, "0")}`,
  ));
  for (const emptyOwnerPath of emptyOwnerPaths) {
    await writeFile(emptyOwnerPath, "", { mode: 0o600 });
    await utimes(emptyOwnerPath, new Date(0), new Date(0));
  }
  t.after(() => cleanup(emptyOwnerParent));
  const afterEmptyOwners = await execFileAsync(process.execPath, [
    join(archiveRoot, "scripts/skills/install.mjs"),
    "--destination",
    emptyOwnerDestination,
    "gauntlet-app-integration",
  ]);
  assert.deepEqual(JSON.parse(afterEmptyOwners.stdout).installed, ["gauntlet-app-integration"]);
  assert.equal((await Promise.all(emptyOwnerPaths.map((emptyOwnerPath) => exists(emptyOwnerPath)))).some(Boolean), false);

  const partialOwnerParent = await mkdtemp(join(tmpdir(), "gauntlet-skills-partial-owner-parent-"));
  await chmod(partialOwnerParent, 0o700);
  const partialOwnerDestination = join(await realpath(partialOwnerParent), "skills");
  await mkdir(partialOwnerDestination, { mode: 0o700 });
  const partialOwnerId = createHash("sha256").update(partialOwnerDestination, "utf8").digest("hex").slice(0, 24);
  const partialOwnerPaths = Array.from({ length: 257 }, (_, index) => join(
    partialOwnerParent,
    `.gauntlet-lock-owner-${partialOwnerId}-${(index + 257).toString(16).padStart(32, "0")}`,
  ));
  for (const partialOwnerPath of partialOwnerPaths) {
    await writeFile(partialOwnerPath, "{", { mode: 0o600 });
    await utimes(partialOwnerPath, new Date(0), new Date(0));
  }
  t.after(() => cleanup(partialOwnerParent));
  const afterPartialOwners = await execFileAsync(process.execPath, [
    join(archiveRoot, "scripts/skills/install.mjs"),
    "--destination",
    partialOwnerDestination,
    "gauntlet-app-integration",
  ]);
  assert.deepEqual(JSON.parse(afterPartialOwners.stdout).installed, ["gauntlet-app-integration"]);
  assert.equal((await Promise.all(partialOwnerPaths.map((partialOwnerPath) => exists(partialOwnerPath)))).some(Boolean), false);

  if (process.platform === "darwin") {
    const aclParent = await mkdtemp(join(tmpdir(), "gauntlet-skills-acl-parent-"));
    await chmod(aclParent, 0o755);
    const aclDestination = join(await realpath(aclParent), "skills");
    await mkdir(aclDestination, { mode: 0o755 });
    await execFileAsync("chmod", [
      "+a",
      "everyone allow add_file,delete_child,add_subdirectory,file_inherit,directory_inherit",
      aclParent,
    ]);
    t.after(() => cleanup(aclParent));
    await assert.rejects(execFileAsync(process.execPath, [
      join(archiveRoot, "scripts/skills/install.mjs"),
      "--destination",
      aclDestination,
      "gauntlet-app-integration",
    ]), /Skill archive installation failed closed/u);
    assert.equal(await exists(join(aclDestination, "gauntlet-app-integration")), false);
  }

  const tamperedDestination = await mkdtemp(join(tmpdir(), "gauntlet-skills-tampered-install-"));
  await chmod(tamperedDestination, 0o700);
  t.after(() => cleanup(tamperedDestination));
  await writeFile(join(archiveRoot, "skills/gauntlet-app-integration/SKILL.md"), "tampered\n");
  await assert.rejects(execFileAsync(process.execPath, [
    join(archiveRoot, "scripts/skills/install.mjs"),
    "--destination",
    tamperedDestination,
    "gauntlet-app-integration",
  ]), /Skill archive installation failed closed/u);
  assert.equal(await exists(join(tamperedDestination, "gauntlet-app-integration")), false);
  assert.equal(await exists(join(tamperedDestination, "gauntlet-extension-authoring")), false);
});

test("refuses unsafe staging arguments before writing an archive", async (t) => {
  const { output, root } = await skillsFixture(t);
  await assert.rejects(
    stageSkills({ root, outputDirectory: output, version: "latest" }),
    /Skill artifact staging input is invalid/u,
  );
  await mkdir(join(output, `gauntlet-skills-${VERSION}.tgz`));
  await assert.rejects(
    stageSkills({ root, outputDirectory: output, version: VERSION }),
    /Skill artifact staging failed closed/u,
  );

  if (["darwin", "linux"].includes(process.platform)) {
    const aclOutput = await mkdtemp(join(tmpdir(), "gauntlet-skills-acl-output-"));
    await chmod(aclOutput, 0o700);
    if (process.platform === "darwin") {
      await execFileAsync("chmod", [
        "+a",
        "everyone allow add_file,delete_child,add_subdirectory,file_inherit,directory_inherit",
        aclOutput,
      ]);
    } else {
      await execFileAsync("setfacl", ["-m", "u:65534:rwx,d:u:65534:rwx", aclOutput]);
    }
    t.after(() => cleanup(aclOutput));
    await assert.rejects(
      stageSkills({ root, outputDirectory: await realpath(aclOutput), version: VERSION }),
      /Skill artifact staging failed closed/u,
    );
    assert.deepEqual(await readdir(aclOutput), []);
  }
});
