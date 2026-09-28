import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { hashSkill } from "../skill-content.mjs";
import { installSkills, parseInstallArguments, runInstallCli } from "../install.mjs";
import { cleanup, exists, validFixture } from "./support.mjs";

const execFileAsync = promisify(execFile);
const staleTime = new Date(0);

async function destinationFixture(t, mode = 0o700) {
  const parent = await mkdtemp(join(tmpdir(), "gauntlet-skills-parent-"));
  await chmod(parent, mode);
  const destination = join(await realpath(parent), "skills");
  await mkdir(destination, { mode: 0o755 });
  t.after(() => cleanup(parent));
  return { destination, parent: await realpath(parent) };
}

async function installerOwnerFixture(destination, {
  pid,
  nonce,
  names = ["safe-integration"],
  empty = false,
  linked = true,
}) {
  const owner = join(destination, `.gauntlet-skills-install-owner-${pid}-${nonce}`);
  const lock = join(destination, ".gauntlet-skills-install.lock");
  const bytes = empty ? "" : `${JSON.stringify({
    schemaVersion: 1,
    pid,
    createdAt: staleTime.toISOString(),
    nonce,
    names,
  })}\n`;
  await writeFile(owner, bytes, { flag: "wx", mode: 0o600 });
  if (linked) await link(owner, lock);
  await utimes(owner, staleTime, staleTime);
  return { lock, owner };
}

test("installs only validated bytes into an explicit absolute destination", async (t) => {
  const root = await validFixture();
  const { destination } = await destinationFixture(t);
  t.after(() => cleanup(root));
  const receipt = await installSkills({ root, destination, names: ["safe-integration"] });
  assert.deepEqual(receipt.installed, ["safe-integration"]);
  assert.equal(await exists(join(destination, "safe-integration/SKILL.md")), true);
  assert.equal(await exists(join(destination, "safe-integration/references/safety.md")), true);
  assert.equal(
    await hashSkill(join(destination, "safe-integration")),
    await hashSkill(join(root, "skills/safe-integration")),
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(root, "skill-evals/safe-integration/verification.json"), "utf8")).skillSha256,
    await hashSkill(join(destination, "safe-integration")),
  );
});

test("preflights all skills and refuses overwrite without partial installation", async (t) => {
  const root = await validFixture("first-skill");
  const second = await validFixture("second-skill");
  const secondSource = join(second, "skills/second-skill");
  const secondEval = join(second, "skill-evals/second-skill");
  const { cp, mkdir } = await import("node:fs/promises");
  await cp(secondSource, join(root, "skills/second-skill"), { recursive: true, errorOnExist: true, force: false });
  await mkdir(join(root, "skill-evals"), { recursive: true });
  await cp(secondEval, join(root, "skill-evals/second-skill"), { recursive: true, errorOnExist: true, force: false });
  const { destination } = await destinationFixture(t);
  await mkdir(join(destination, "second-skill"), { mode: 0o700 });
  await writeFile(join(destination, "second-skill/SKILL.md"), "occupied\n", { mode: 0o600 });
  t.after(() => cleanup(root, second));
  await assert.rejects(
    installSkills({ root, destination, names: ["first-skill", "second-skill"] }),
    /already exists; remove or move it explicitly/,
  );
  assert.equal(await exists(join(destination, "first-skill")), false);
  assert.equal(await readFile(join(destination, "second-skill/SKILL.md"), "utf8"), "occupied\n");
});

test("refuses invalid skills, relative destinations and unsafe CLI shapes", async (t) => {
  const root = await validFixture();
  const { destination } = await destinationFixture(t);
  t.after(() => cleanup(root));
  await writeFile(join(root, "skills/safe-integration/SKILL.md"), "changed\n");
  await assert.rejects(installSkills({ root, destination, names: ["safe-integration"] }), /did not validate/);
  await assert.rejects(installSkills({ root, destination: "relative", names: ["safe-integration"] }), {
    message: "Skill installation input is invalid",
  });
  assert.deepEqual(parseInstallArguments(["--destination", resolve(destination), "safe-integration"]), {
    destination: resolve(destination),
    names: ["safe-integration"],
  });
  for (const args of [[], ["safe-integration"], ["--destination", "relative", "safe-integration"], ["--destination", resolve(destination)]]) {
    assert.throws(() => parseInstallArguments(args), { message: "Invalid skill installer arguments" });
  }
});

test("installer CLI normalizes its URL-derived repository root", async (t) => {
  const root = await validFixture();
  const { destination } = await destinationFixture(t);
  t.after(() => cleanup(root));
  const receipt = await runInstallCli(
    ["--destination", resolve(destination), "safe-integration"],
    `${root}/`,
  );
  assert.deepEqual(receipt.installed, ["safe-integration"]);
  assert.equal(await exists(join(destination, "safe-integration/SKILL.md")), true);
});

test("installer CLI invoked through a symlink never exits successfully without running", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "gauntlet-skills-cli-link-"));
  const entrypoint = join(parent, "install.mjs");
  await symlink(resolve(import.meta.dirname, "../install.mjs"), entrypoint);
  t.after(() => cleanup(parent));

  await assert.rejects(
    execFileAsync(process.execPath, [entrypoint]),
    (error) => error?.code === 1 && /Invalid skill installer arguments/u.test(error.stderr),
  );
});

test("installer resolves the ACL probe from fixed root-owned system candidates", async () => {
  const source = await readFile(resolve(import.meta.dirname, "../install.mjs"), "utf8");
  assert.doesNotMatch(source, /spawnSync\("\/bin\/ls"/u);
  for (const candidate of [
    "/usr/bin/ls",
    "/bin/ls",
    "/run/current-system/sw/bin/ls",
    "/nix/var/nix/profiles/default/bin/ls",
  ]) {
    assert.match(source, new RegExp(candidate.replaceAll("/", "\\/"), "u"));
  }
  assert.match(source, /stat\.uid === 0n/u);
  assert.match(source, /\(stat\.mode & 0o022n\) === 0n/u);
  for (const relativePath of [
    "../install.mjs",
    "../archive-install.mjs",
    "../../release/tree-archive.mjs",
  ]) {
    const aclSource = await readFile(resolve(import.meta.dirname, relativePath), "utf8");
    assert.match(aclSource, /\["--version"\]/u, relativePath);
    assert.match(aclSource, /GNU coreutils/u, relativePath);
    assert.match(aclSource, /process\.platform !== "linux"/u, relativePath);
    assert.match(
      aclSource,
      /for \(const candidate of candidates\)[\s\S]*?assertAclAwareLs\(path\);\s*return path;[\s\S]*?Try the next fixed, root-owned system location/u,
      `${relativePath} must validate GNU ACL support before selecting a candidate`,
    );
  }
});

test("installer recovers scratch and linked owner left by a dead process", async (t) => {
  const root = await validFixture();
  const { destination } = await destinationFixture(t);
  const nonce = "a".repeat(32);
  const { lock, owner } = await installerOwnerFixture(destination, {
    pid: 2_147_483_647,
    nonce,
  });
  const scratch = join(destination, `.gauntlet-skill-safe-integration-${nonce}`);
  await mkdir(scratch, { mode: 0o700 });
  await writeFile(join(scratch, "partial"), "interrupted\n", { mode: 0o600 });
  t.after(() => cleanup(root));

  const receipt = await installSkills({ root, destination, names: ["safe-integration"] });
  assert.deepEqual(receipt.installed, ["safe-integration"]);
  assert.equal(await exists(scratch), false);
  assert.equal(await exists(lock), false);
  assert.equal(await exists(owner), false);
  assert.equal(await exists(join(destination, "safe-integration/SKILL.md")), true);
});

test("installer preserves an old scratch while its owner process is alive", async (t) => {
  const root = await validFixture("other-integration");
  const { destination } = await destinationFixture(t);
  const nonce = "b".repeat(32);
  const { lock, owner } = await installerOwnerFixture(destination, {
    pid: process.pid,
    nonce,
  });
  const scratch = join(destination, `.gauntlet-skill-safe-integration-${nonce}`);
  await mkdir(scratch, { mode: 0o700 });
  await writeFile(join(scratch, "partial"), "still active\n", { mode: 0o600 });
  await utimes(scratch, staleTime, staleTime);
  t.after(() => cleanup(root));

  await assert.rejects(
    installSkills({ root, destination, names: ["other-integration"] }),
    /Skill installation input is invalid/u,
  );
  assert.equal(await exists(lock), true);
  assert.equal(await exists(owner), true);
  assert.equal(await readFile(join(scratch, "partial"), "utf8"), "still active\n");
  assert.equal(await exists(join(destination, "other-integration")), false);
});

test("installer recovers an empty dead owner left before lock publication", async (t) => {
  const root = await validFixture();
  const { destination } = await destinationFixture(t);
  const { owner } = await installerOwnerFixture(destination, {
    pid: 2_147_483_647,
    nonce: "c".repeat(32),
    empty: true,
    linked: false,
  });
  t.after(() => cleanup(root));

  const receipt = await installSkills({ root, destination, names: ["safe-integration"] });
  assert.deepEqual(receipt.installed, ["safe-integration"]);
  assert.equal(await exists(owner), false);
  assert.equal(await exists(join(destination, "safe-integration/SKILL.md")), true);
});

test("refuses writable or ACL-controlled destination parents before staging", async (t) => {
  const root = await validFixture();
  t.after(() => cleanup(root));

  const writable = await destinationFixture(t, 0o777);
  await assert.rejects(
    installSkills({ root, destination: writable.destination, names: ["safe-integration"] }),
    /Skill installation input is invalid/u,
  );
  assert.equal(await exists(join(writable.destination, "safe-integration")), false);

  if (["darwin", "linux"].includes(process.platform)) {
    const acl = await destinationFixture(t, 0o755);
    if (process.platform === "darwin") {
      await execFileAsync("chmod", [
        "+a",
        "everyone allow add_file,delete_child,add_subdirectory,file_inherit,directory_inherit",
        acl.parent,
      ]);
    } else {
      await execFileAsync("setfacl", ["-m", "u:65534:rwx,d:u:65534:rwx", acl.parent]);
    }
    await assert.rejects(
      installSkills({ root, destination: acl.destination, names: ["safe-integration"] }),
      /Skill installation input is invalid/u,
    );
    assert.equal(await exists(join(acl.destination, "safe-integration")), false);
  }
});
