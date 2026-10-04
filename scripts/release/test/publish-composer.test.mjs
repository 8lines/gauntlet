import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";

import {
  COMPOSER_SSH_DESTINATIONS,
  createComposerPublicationPlan,
  createDeployKeySshCommand,
  GITHUB_SSH_KNOWN_HOSTS,
  publishComposerPackage,
  publishComposerRepositories,
  readDeployKey,
  withDeployKeyFiles,
} from "../publish-composer.mjs";
import { createReleaseManifest, writeReleaseInventory } from "../inventory.mjs";
import { RELEASE_ARTIFACTS } from "../release-model.mjs";
import { packageCanonicalTree } from "../tree-archive.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
// GitHub's published SSH host key fingerprints (https://api.github.com/meta, `ssh_key_fingerprints`).
const GITHUB_SSH_FINGERPRINTS = {
  "ssh-ed25519": "+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU",
  "ecdsa-sha2-nistp256": "p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM",
  "ssh-rsa": "uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s",
};
// A syntactically valid OpenSSH private-key envelope; it is never used to authenticate. The label is
// assembled from parts so the release credential scanner does not read the fixture as a key.
const OPENSSH_KEY_LABEL = ["OPENSSH", "PRIVATE", "KEY"].join(" ");
const FIXTURE_DEPLOY_KEY = [
  `-----BEGIN ${OPENSSH_KEY_LABEL}-----`,
  ...Array.from({ length: 4 }, (_, index) => `${String(index).repeat(70)}`),
  `-----END ${OPENSSH_KEY_LABEL}-----`,
  "",
].join("\n");
const WRONG_COMMIT = "f".repeat(40);
const VERSION = "0.1.0";
const SET = "release-2026-10-03.1";
const COMPOSER_PLAN = Object.freeze([
  Object.freeze({ id: "php-core", version: "0.1.0", artifact: RELEASE_ARTIFACTS.composer[0] }),
  Object.freeze({ id: "symfony-bundle", version: "0.1.1", artifact: RELEASE_ARTIFACTS.composer[1] }),
]);

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      LANG: "C",
      LC_ALL: "C",
      TZ: "UTC",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function write(root, relativePath, bytes) {
  const path = resolve(root, relativePath);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, bytes, { mode: 0o644 });
}

function fixture(t) {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), "gauntlet-composer-publish-test-")));
  chmodSync(root, 0o700);
  const source = resolve(root, "source");
  const changedSource = resolve(root, "changed-source");
  const remote = resolve(root, "remote.git");
  mkdirSync(source, { mode: 0o700 });
  mkdirSync(changedSource, { mode: 0o700 });
  git(root, ["init", "--bare", "--initial-branch=main", remote]);
  for (const directory of [source, changedSource]) {
    write(directory, "composer.json", '{"name":"8lines/gauntlet-php-core","version":"0.1.0"}\n');
    write(directory, ".gauntlet-source.json", `${JSON.stringify({
      repository: "8lines/gauntlet",
      commit: COMMIT,
      path: "packages/php/core",
      version: "0.1.0",
    })}\n`);
  }
  write(source, "src/Core.php", "<?php\nfinal class Core {}\n");
  write(changedSource, "src/Core.php", "<?php\nfinal class ChangedCore {}\n");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { changedSource, remote, root, source };
}

function writeComposerSource(source, artifact, version, commit) {
  write(source, "composer.json", `${JSON.stringify({ name: artifact.name, version })}\n`);
  write(source, ".gauntlet-source.json", `${JSON.stringify({
    repository: "8lines/gauntlet",
    commit,
    path: artifact.directory,
    version,
  })}\n`);
  write(source, "src/Fixture.php", `<?php\n// ${artifact.name}\n`);
}

async function releaseFixture(t, plan = COMPOSER_PLAN) {
  const files = fixture(t);
  const releaseDirectory = resolve(files.root, SET);
  const sourceRoot = resolve(files.root, "archive-sources");
  const archiveDirectory = resolve(releaseDirectory, "composer/artifacts");
  for (const directory of [releaseDirectory, sourceRoot, archiveDirectory]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }
  const artifacts = [];
  for (const { id, version, artifact } of plan) {
    const source = resolve(sourceRoot, artifact.repository);
    mkdirSync(source, { recursive: true, mode: 0o700 });
    writeComposerSource(source, artifact, version, COMMIT);
    const filename = `${artifact.repository.split("/").at(-1)}-${version}.tar.gz`;
    packageCanonicalTree({
      sourceDirectory: realpathSync(source),
      outputDirectory: realpathSync(archiveDirectory),
      filename,
      archivePrefix: filename.slice(0, -7),
    });
    artifacts.push({ unit: id, kind: "composer", name: artifact.name, path: `composer/artifacts/${filename}` });
  }
  rmSync(sourceRoot, { recursive: true, force: false });
  await writeReleaseInventory({
    outputDirectory: releaseDirectory,
    releaseSet: SET,
    sourceCommit: COMMIT,
    units: plan.map(({ id, version }) => ({ id, version })),
    artifacts,
  });
  return { ...files, releaseDirectory };
}

function rewriteInventory(releaseDirectory, mutation) {
  const current = JSON.parse(readFileSync(resolve(releaseDirectory, "release-manifest.json"), "utf8"));
  mutation(current);
  const manifest = createReleaseManifest({
    releaseSet: current.releaseSet,
    sourceCommit: current.sourceCommit,
    units: current.units,
    artifacts: current.artifacts,
  });
  for (const name of ["release-manifest.json", "SHA256SUMS"]) rmSync(resolve(releaseDirectory, name));
  writeFileSync(resolve(releaseDirectory, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(resolve(releaseDirectory, "SHA256SUMS"), [...manifest.artifacts]
    .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
    .map(({ path, sha256 }) => `${sha256}  ${path}\n`).join(""));
}

function replaceComposerArchiveCommit(files, unitId, commit) {
  const { version, artifact } = COMPOSER_PLAN.find(({ id }) => id === unitId);
  const leaf = artifact.repository.split("/").at(-1);
  const filename = `${leaf}-${version}.tar.gz`;
  const archivePath = resolve(files.releaseDirectory, "composer/artifacts", filename);
  const source = resolve(files.root, `repacked-${leaf}`);
  mkdirSync(source, { mode: 0o700 });
  writeComposerSource(source, artifact, version, commit);
  rmSync(archivePath);
  const receipt = packageCanonicalTree({
    sourceDirectory: realpathSync(source),
    outputDirectory: realpathSync(resolve(archivePath, "..")),
    filename,
    archivePrefix: filename.slice(0, -7),
  });
  rmSync(source, { recursive: true, force: false });
  rewriteInventory(files.releaseDirectory, (manifest) => {
    const record = manifest.artifacts.find(({ kind, name }) => kind === "composer" && name === artifact.name);
    assert.notEqual(record, undefined);
    record.sha256 = receipt.sha256;
  });
}

function withTemporaryDirectory(root, callback) {
  const temporaryDirectory = resolve(root, "consumer-tmp");
  mkdirSync(temporaryDirectory, { mode: 0o700 });
  chmodSync(temporaryDirectory, 0o700);
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = temporaryDirectory;
  return Promise.resolve()
    .then(() => callback(temporaryDirectory))
    .finally(() => {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    });
}

test("publishes one immutable annotated Composer tag and makes an identical rerun a no-op", async (t) => {
  const files = fixture(t);
  assert.equal(await publishComposerPackage({
    source: files.source,
    remote: files.remote,
    version: "0.1.0",
    sourceCommit: COMMIT,
    dryRun: false,
  }), "published");
  assert.equal(await publishComposerPackage({
    source: files.source,
    remote: files.remote,
    version: "0.1.0",
    sourceCommit: COMMIT,
    dryRun: false,
  }), "already-identical");

  assert.equal(git(files.remote, ["show-ref", "--verify", "refs/heads/main"]).length > 0, true);
  assert.equal(git(files.remote, ["cat-file", "-t", "refs/tags/v0.1.0"]), "tag");
  const provenance = git(files.remote, ["show", "v0.1.0:.gauntlet-source.json"]);
  assert.equal(`${provenance}\n`, readFileSync(resolve(files.source, ".gauntlet-source.json"), "utf8"));
});

test("rejects an existing version tag whose Git tree differs", async (t) => {
  const files = fixture(t);
  assert.equal(await publishComposerPackage({
    source: files.source,
    remote: files.remote,
    version: "0.1.0",
    sourceCommit: COMMIT,
    dryRun: false,
  }), "published");
  await assert.rejects(
    publishComposerPackage({
      source: files.changedSource,
      remote: files.remote,
      version: "0.1.0",
      sourceCommit: COMMIT,
      dryRun: false,
    }),
    /existing tag v0\.1\.0 has different content/u,
  );
});

test("dry-run computes the decision without mutating the remote", async (t) => {
  const files = fixture(t);
  assert.equal(await publishComposerPackage({
    source: files.source,
    remote: files.remote,
    version: "0.1.0",
    sourceCommit: COMMIT,
    dryRun: true,
  }), "would-publish");
  const refs = spawnSync("git", ["show-ref"], { cwd: files.remote, encoding: "utf8" });
  assert.equal(refs.status, 1);
  assert.equal(refs.stdout, "");
});

test("rejects malformed versions, unsafe sources, and arbitrary network destinations", async (t) => {
  const files = fixture(t);
  for (const options of [
    { source: files.source, remote: files.remote, version: "v0.1.0", sourceCommit: COMMIT, dryRun: false },
    { source: files.source, remote: "https://example.invalid/foreign.git", version: "0.1.0", sourceCommit: COMMIT, dryRun: false },
    { source: files.source, remote: files.remote, version: "0.1.0", sourceCommit: "short", dryRun: false },
    { source: files.source, remote: files.remote, version: "0.1.0", sourceCommit: COMMIT, dryRun: false, extra: true },
  ]) await assert.rejects(publishComposerPackage(options));

  const duplicated = fixture(t);
  writeFileSync(
    resolve(duplicated.source, "composer.json"),
    '{"name":"8lines/gauntlet-php-core","name":"8lines/gauntlet-php-core","version":"0.1.0"}\n',
  );
  await assert.rejects(
    publishComposerPackage({
      source: duplicated.source,
      remote: duplicated.remote,
      version: "0.1.0",
      sourceCommit: COMMIT,
      dryRun: true,
    }),
    /failed closed/u,
  );
});

test("CLI publication planning resolves one staged Composer unit to its archive, version and fixed remote", async (t) => {
  const files = await releaseFixture(t);
  for (const { id, version, artifact } of COMPOSER_PLAN) {
    const plan = createComposerPublicationPlan({ releaseDirectory: files.releaseDirectory, sourceCommit: COMMIT, unit: id });
    const filename = `${artifact.repository.split("/").at(-1)}-${version}.tar.gz`;
    const archivePath = resolve(files.releaseDirectory, "composer/artifacts", filename);
    assert.deepEqual(plan, {
      name: artifact.name,
      version,
      archivePath,
      expectedPrefix: filename.slice(0, -7),
      expectedSha256: createHash("sha256").update(readFileSync(archivePath)).digest("hex"),
      expectedSourceCommit: COMMIT,
      remote: artifact.repositoryUrl,
    });
    assert.equal(Object.isFrozen(plan), true);
  }
  const bundle = createComposerPublicationPlan({ releaseDirectory: files.releaseDirectory, sourceCommit: COMMIT, unit: "symfony-bundle" });
  assert.equal(bundle.version, "0.1.1");
  assert.equal(bundle.expectedPrefix, "gauntlet-symfony-bundle-0.1.1");
  assert.equal(bundle.remote, "https://github.com/8lines/gauntlet-symfony-bundle.git");
  assert.equal(existsSync(resolve(files.releaseDirectory, "composer/repositories")), false);
});

test("CLI publication planning rejects a unit that is not staged or not a Composer package", async (t) => {
  const files = await releaseFixture(t, COMPOSER_PLAN.slice(0, 1));
  for (const unit of ["symfony-bundle", "protocol", "gauntlet", "nope", undefined]) {
    assert.throws(
      () => createComposerPublicationPlan({ releaseDirectory: files.releaseDirectory, sourceCommit: COMMIT, unit }),
      unit === "symfony-bundle" ? /failed closed/u : /Composer publication unit/u,
      String(unit),
    );
  }
  assert.throws(
    () => createComposerPublicationPlan({ releaseDirectory: files.releaseDirectory, sourceCommit: WRONG_COMMIT, unit: "php-core" }),
    /failed closed/u,
  );
  assert.throws(
    () => createComposerPublicationPlan({ releaseDirectory: files.releaseDirectory, version: VERSION, sourceCommit: COMMIT }),
    /closed data object/u,
  );
});

test("CLI publication planning rejects a release tree outside the closed inventory or its release set", async (t) => {
  const files = await releaseFixture(t);
  write(files.releaseDirectory, "unexpected.txt", "foreign\n");
  assert.throws(
    () => createComposerPublicationPlan({ releaseDirectory: files.releaseDirectory, sourceCommit: COMMIT, unit: "php-core" }),
    /failed closed/u,
  );
  const renamed = await releaseFixture(t);
  const moved = resolve(renamed.root, "release-2026-10-03.2");
  renameSync(renamed.releaseDirectory, moved);
  assert.throws(
    () => createComposerPublicationPlan({ releaseDirectory: moved, sourceCommit: COMMIT, unit: "php-core" }),
    /failed closed/u,
  );
});

test("CLI publication materializes the unit archive into a private temporary tree and removes it", async (t) => {
  const files = await releaseFixture(t);
  await withTemporaryDirectory(files.root, async (temporaryDirectory) => {
    const observed = [];
    const result = await publishComposerRepositories({
      releaseDirectory: files.releaseDirectory,
      sourceCommit: COMMIT,
      unit: "symfony-bundle",
    }, {
      publishPackage: async ({ source, remote, version, sourceCommit, dryRun }) => {
        observed.push({
          name: JSON.parse(readFileSync(resolve(source, "composer.json"), "utf8")).name,
          remote,
          version,
          sourceCommit,
          dryRun,
          insideTemporaryDirectory: source.startsWith(`${temporaryDirectory}/`),
        });
        return "published";
      },
    });
    assert.deepEqual(result, [{ name: "8lines/gauntlet-symfony-bundle", status: "published" }]);
    assert.deepEqual(observed, [{
      name: "8lines/gauntlet-symfony-bundle",
      remote: "https://github.com/8lines/gauntlet-symfony-bundle.git",
      version: "0.1.1",
      sourceCommit: COMMIT,
      dryRun: false,
      insideTemporaryDirectory: true,
    }]);
    assert.deepEqual(readdirSync(temporaryDirectory), []);
  });
});

test("CLI publication validates the unit archive before invoking the publisher", async (t) => {
  const files = await releaseFixture(t);
  const archive = resolve(files.releaseDirectory, "composer/artifacts/gauntlet-symfony-bundle-0.1.1.tar.gz");
  writeFileSync(archive, "mutated archive\n");
  await withTemporaryDirectory(files.root, async (temporaryDirectory) => {
    let calls = 0;
    await assert.rejects(publishComposerRepositories({
      releaseDirectory: files.releaseDirectory,
      sourceCommit: COMMIT,
      unit: "symfony-bundle",
    }, {
      publishPackage: async () => { calls += 1; return "published"; },
    }), /failed closed/u);
    assert.equal(calls, 0);
    assert.deepEqual(readdirSync(temporaryDirectory), []);
  });
});

test("CLI publication rejects a rehashed archive whose provenance commit differs before publishing", async (t) => {
  const files = await releaseFixture(t);
  replaceComposerArchiveCommit(files, "symfony-bundle", WRONG_COMMIT);
  let calls = 0;
  await assert.rejects(publishComposerRepositories({
    releaseDirectory: files.releaseDirectory,
    sourceCommit: COMMIT,
    unit: "symfony-bundle",
  }, {
    publishPackage: async () => { calls += 1; return "published"; },
  }), /failed closed/u);
  assert.equal(calls, 0);
});

test("CLI publication preserves a replacement temporary path and fails cleanup safely", async (t) => {
  const files = await releaseFixture(t);
  await withTemporaryDirectory(files.root, async (temporaryDirectory) => {
    await assert.rejects(publishComposerRepositories({
      releaseDirectory: files.releaseDirectory,
      sourceCommit: COMMIT,
      unit: "php-core",
    }, {
      publishPackage: async () => {
        const [workspaceName] = readdirSync(temporaryDirectory);
        const workspace = resolve(temporaryDirectory, workspaceName);
        renameSync(workspace, `${workspace}-original`);
        mkdirSync(workspace, { mode: 0o700 });
        writeFileSync(resolve(workspace, "replacement.txt"), "do not remove\n", { mode: 0o600 });
        return "published";
      },
    }), /cleanup failed closed/u);
    const replacement = readdirSync(temporaryDirectory)
      .map((name) => resolve(temporaryDirectory, name, "replacement.txt"))
      .find((path) => existsSync(path));
    assert.notEqual(replacement, undefined);
    assert.equal(readFileSync(replacement, "utf8"), "do not remove\n");
  });
});

test("CLI publication never recursively removes a replacement inside its materialized tree", async (t) => {
  const files = await releaseFixture(t);
  await withTemporaryDirectory(files.root, async () => {
    let replacement;
    await assert.rejects(publishComposerRepositories({
      releaseDirectory: files.releaseDirectory,
      sourceCommit: COMMIT,
      unit: "php-core",
    }, {
      publishPackage: async ({ source }) => {
        renameSync(source, `${source}-original`);
        mkdirSync(source, { mode: 0o700 });
        replacement = resolve(source, "replacement.txt");
        writeFileSync(replacement, "do not remove recursively\n", { mode: 0o600 });
        return "published";
      },
    }), /cleanup failed closed/u);
    assert.notEqual(replacement, undefined);
    assert.equal(readFileSync(replacement, "utf8"), "do not remove recursively\n");
  });
});

test("pins exactly GitHub's published SSH host keys", () => {
  assert.equal(GITHUB_SSH_KNOWN_HOSTS.length, 3);
  const observed = {};
  for (const line of GITHUB_SSH_KNOWN_HOSTS) {
    const [host, type, key, ...rest] = line.split(" ");
    assert.equal(host, "github.com");
    assert.deepEqual(rest, []);
    const blob = Buffer.from(key, "base64");
    assert.equal(blob.toString("base64"), key);
    assert.equal(blob.subarray(4, 4 + blob.readUInt32BE(0)).toString("ascii"), type);
    observed[type] = createHash("sha256").update(blob).digest("base64").replace(/=+$/u, "");
  }
  assert.deepEqual(observed, GITHUB_SSH_FINGERPRINTS);
});

test("maps each catalog split repository to its own SSH push URL and deploy key", () => {
  assert.deepEqual(COMPOSER_SSH_DESTINATIONS, {
    "https://github.com/8lines/gauntlet-php-core.git": {
      pushUrl: "git@github.com:8lines/gauntlet-php-core.git",
      deployKeyVariable: "COMPOSER_SPLIT_CORE_DEPLOY_KEY",
    },
    "https://github.com/8lines/gauntlet-symfony-bundle.git": {
      pushUrl: "git@github.com:8lines/gauntlet-symfony-bundle.git",
      deployKeyVariable: "COMPOSER_SPLIT_BUNDLE_DEPLOY_KEY",
    },
  });
  assert.deepEqual(
    Object.keys(COMPOSER_SSH_DESTINATIONS),
    RELEASE_ARTIFACTS.composer.map(({ repositoryUrl }) => repositoryUrl),
  );
  assert.equal(Object.isFrozen(COMPOSER_SSH_DESTINATIONS), true);
});

test("reads only a well-formed OpenSSH deploy key and never echoes rejected key material", () => {
  const variable = "COMPOSER_SPLIT_CORE_DEPLOY_KEY";
  assert.equal(readDeployKey(variable, { [variable]: FIXTURE_DEPLOY_KEY }), FIXTURE_DEPLOY_KEY);
  assert.equal(readDeployKey(variable, { [variable]: FIXTURE_DEPLOY_KEY.replaceAll("\n", "\r\n").trimEnd() }), FIXTURE_DEPLOY_KEY);
  assert.throws(() => readDeployKey(variable, {}), /requires the COMPOSER_SPLIT_CORE_DEPLOY_KEY deploy key/u);
  assert.throws(() => readDeployKey("GAUNTLET_OTHER_KEY", { GAUNTLET_OTHER_KEY: FIXTURE_DEPLOY_KEY }), /variable is invalid/u);
  for (const value of [
    "not-a-key-SENTINEL",
    FIXTURE_DEPLOY_KEY.replace(OPENSSH_KEY_LABEL, ["RSA", "PRIVATE", "KEY"].join(" ")),
    FIXTURE_DEPLOY_KEY.replace("0000", "00 SENTINEL 00"),
    `${FIXTURE_DEPLOY_KEY}${FIXTURE_DEPLOY_KEY}`,
  ]) {
    assert.throws(() => readDeployKey(variable, { [variable]: value }), (error) => {
      assert.match(error.message, /must contain one OpenSSH private key/u);
      assert.doesNotMatch(error.message, /SENTINEL|0000/u);
      return true;
    });
  }
});

test("builds one prompt-free SSH invocation bound to the key and the pinned known hosts", () => {
  assert.equal(
    createDeployKeySshCommand("/private/workspace/ssh-0/deploy-key", "/private/workspace/ssh-0/known_hosts"),
    "ssh -F /dev/null -i '/private/workspace/ssh-0/deploy-key' -o IdentitiesOnly=yes -o IdentityAgent=none"
      + " -o BatchMode=yes -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no"
      + " -o StrictHostKeyChecking=yes -o UserKnownHostsFile='/private/workspace/ssh-0/known_hosts'"
      + " -o GlobalKnownHostsFile=/dev/null -o UpdateHostKeys=no -o CheckHostIP=no -o ForwardAgent=no"
      + " -o ClearAllForwardings=yes -o ControlMaster=no -o ControlPath=none",
  );
  for (const unsafe of ["relative/key", "/private/it's", "/private/a b", "/private/$(id)", "/private/../key"]) {
    assert.throws(() => createDeployKeySshCommand(unsafe, "/private/known_hosts"), /failed closed/u);
  }
});

test("materializes the deploy key and known hosts as private files only for the push", async (t) => {
  const workspace = realpathSync(mkdtempSync(resolve(tmpdir(), "gauntlet-composer-ssh-test-")));
  chmodSync(workspace, 0o700);
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  let observed;
  const result = await withDeployKeyFiles(workspace, FIXTURE_DEPLOY_KEY, async (sshCommand) => {
    const [directoryName] = readdirSync(workspace);
    const directory = resolve(workspace, directoryName);
    const keyPath = resolve(directory, "deploy-key");
    const knownHostsPath = resolve(directory, "known_hosts");
    observed = {
      directoryMode: statSync(directory).mode & 0o777,
      keyMode: statSync(keyPath).mode & 0o777,
      knownHostsMode: statSync(knownHostsPath).mode & 0o777,
      key: readFileSync(keyPath, "utf8"),
      knownHosts: readFileSync(knownHostsPath, "utf8"),
      command: sshCommand,
      expectedCommand: createDeployKeySshCommand(keyPath, knownHostsPath),
    };
    return "pushed";
  });
  assert.equal(result, "pushed");
  assert.equal(observed.directoryMode, 0o700);
  assert.equal(observed.keyMode, 0o600);
  assert.equal(observed.knownHostsMode, 0o600);
  assert.equal(observed.key, FIXTURE_DEPLOY_KEY);
  assert.equal(observed.knownHosts, `${GITHUB_SSH_KNOWN_HOSTS.join("\n")}\n`);
  assert.equal(observed.command, observed.expectedCommand);
  assert.deepEqual(readdirSync(workspace), []);

  await assert.rejects(
    withDeployKeyFiles(workspace, FIXTURE_DEPLOY_KEY, async () => { throw new Error("push rejected"); }),
    /push rejected/u,
  );
  assert.deepEqual(readdirSync(workspace), []);
});

test("a catalog publication without its deploy key fails before any network access", async (t) => {
  const files = fixture(t);
  const previous = process.env.COMPOSER_SPLIT_CORE_DEPLOY_KEY;
  delete process.env.COMPOSER_SPLIT_CORE_DEPLOY_KEY;
  try {
    await assert.rejects(publishComposerPackage({
      source: files.source,
      remote: "https://github.com/8lines/gauntlet-php-core.git",
      version: VERSION,
      sourceCommit: COMMIT,
      dryRun: false,
    }), /requires the COMPOSER_SPLIT_CORE_DEPLOY_KEY deploy key/u);
    process.env.COMPOSER_SPLIT_CORE_DEPLOY_KEY = "not-a-key";
    await assert.rejects(publishComposerPackage({
      source: files.source,
      remote: "https://github.com/8lines/gauntlet-php-core.git",
      version: VERSION,
      sourceCommit: COMMIT,
      dryRun: false,
    }), /must contain one OpenSSH private key/u);
  } finally {
    if (previous === undefined) delete process.env.COMPOSER_SPLIT_CORE_DEPLOY_KEY;
    else process.env.COMPOSER_SPLIT_CORE_DEPLOY_KEY = previous;
  }
});
