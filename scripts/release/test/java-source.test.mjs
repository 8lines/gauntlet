import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  createJavaSourcePlan,
  createWorkspace,
  parseLocalDockerEndpoint,
  removeWorkspace,
  runJavaSourceCheck,
  runJavaSourceCli,
} from "../test-java-source.mjs";

const IMAGE =
  "docker.io/library/gradle:9.2.1-jdk21@sha256:f1d5be114f4f16e780eee51a942449eaa98808887dddd5da4a5b608971c90aa4";
const TOKEN = "0123456789abcdef0123456789abcdef";

function result(stdout = "", overrides = {}) {
  return {
    status: 0,
    signal: null,
    stdout,
    stderr: "",
    ...overrides,
  };
}

function sourceFixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gauntlet-java-source-test-")));
  const root = resolve(base, "repository");
  const temporaryDirectory = resolve(base, "workspaces");
  for (const directory of [
    root,
    temporaryDirectory,
    resolve(root, "packages/java/core/src/main/java/example"),
    resolve(root, "packages/java/core/build"),
    resolve(root, "packages/java/.gradle"),
    resolve(root, "packages/protocol/fixtures/v1"),
    resolve(root, ".git"),
  ]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const write = (relativePath, contents, mode = 0o644) => {
    const path = resolve(root, relativePath);
    mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(path, contents, { mode });
    chmodSync(path, mode);
    return path;
  };
  write("LICENSE", "License fixture\n");
  write("NOTICE", "Notice fixture\n");
  write("VERSION", "0.1.0\n");
  write("packages/java/settings.gradle.kts", 'rootProject.name = "fixture"\n');
  write("packages/java/build.gradle.kts", "plugins {}\n");
  write("packages/java/gradlew", "#!/bin/sh\nexit 99\n", 0o755);
  write("packages/java/core/src/main/java/example/Dirty.java", "class Dirty {}\n");
  write("packages/java/core/build/stale-secret.txt", "must-not-be-mounted\n");
  write("packages/java/.gradle/host-cache.bin", "must-not-be-mounted\n");
  write("packages/protocol/fixtures/v1/manifest.valid.json", "{}\n");
  write(".env", "HOST_SECRET=must-not-be-mounted\n");
  write(".git/config", "must-not-be-mounted\n");
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, root, temporaryDirectory, write };
}

function localContext() {
  return result('"unix:///var/run/docker.sock"\n');
}

function absentContainer(name) {
  return result("\n", { status: 1, stderr: `Error: No such object: ${name}\n` });
}

test("plans an isolated pinned-Docker Java working-tree check", () => {
  const plan = createJavaSourcePlan({
    root: "/private/repository",
    sandbox: "/private/tc-java-source-123",
    version: "0.1.0",
    uid: 501,
    gid: 20,
    token: TOKEN,
    dockerHost: "unix:///var/run/docker.sock",
    executablePath: "/safe/bin",
  });

  assert.equal(plan.image, IMAGE);
  assert.equal(plan.containerName, "gauntlet-java-source-0123456789abcdef01234567");
  assert.equal(plan.ownerLabel, "dev.8lines.gauntlet.java-source-owner");
  assert.deepEqual(plan.tasks, [
    ":core:check",
    ":spring-boot-starter:check",
    ":spring-example:bootJar",
    ":starter-api-consumer-test:check",
  ]);
  assert.equal(plan.run.command, "docker");
  assert.deepEqual(plan.run.args.slice(0, 14), [
    "run", "--rm", "--name", plan.containerName,
    "--label", `${plan.ownerLabel}=${TOKEN}`,
    "--platform", "linux/amd64",
    "--user", "501:20",
    "--network", "bridge",
    "--read-only", "--cap-drop",
  ]);
  assert.equal(plan.run.args.includes("ALL"), true);
  assert.equal(plan.run.args.includes("no-new-privileges"), true);
  assert.equal(plan.run.args.includes("--dependency-verification=strict"), true);
  assert.equal(plan.run.args.includes("type=bind,src=/private/tc-java-source-123/source,dst=/workspace"), true);
  assert.equal(plan.run.args.some((argument) => argument.includes("/private/repository")), false);
  assert.equal(plan.run.args.some((argument) => /docker\.sock|DOCKER_HOST/u.test(argument)), false);
  assert.deepEqual(plan.run.args.slice(-plan.tasks.length), plan.tasks);
  assert.deepEqual(plan.environment, {
    PATH: "/safe/bin",
    HOME: "/private/tc-java-source-123/host-home",
    DOCKER_CONFIG: "/private/tc-java-source-123/docker-config",
    DOCKER_HOST: "unix:///var/run/docker.sock",
    TMPDIR: "/private/tc-java-source-123/host-tmp",
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    NO_COLOR: "1",
  });
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.run.args), true);
});

test("accepts only one exact local Unix Docker endpoint record", () => {
  assert.equal(
    parseLocalDockerEndpoint(result('"unix:///Users/test/.docker/run/docker.sock"\n')),
    "unix:///Users/test/.docker/run/docker.sock",
  );

  for (const invalid of [
    result('"tcp://builder.example:2376"\n'),
    result('"ssh://builder.example"\n'),
    result('"npipe:////./pipe/docker_engine"\n'),
    result('"unix:///var/run/docker.sock"\nextra\n'),
    result('"unix:///var/run/docker.sock"\r\n'),
    result("not-json\n"),
    result('"unix:///var/run/docker.sock"\n', { stderr: "warning\n" }),
    result('"unix:///var/run/docker.sock"\n', { status: 1 }),
  ]) {
    assert.throws(() => parseLocalDockerEndpoint(invalid), /local Docker daemon/u);
  }
});

const WORKSPACE_MARKER = ".gauntlet-workspace-owner";

function ownedWorkspace(t, prefix) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const workspace = createWorkspace(base);
  writeFileSync(resolve(workspace.root, "entry"), "owned\n", { mode: 0o600 });
  return workspace;
}

function simulatedRace(message) {
  const error = new Error(message);
  error.code = "ENOTEMPTY";
  return error;
}

function emptyInPlace(root) {
  for (const entry of readdirSync(root)) rmSync(resolve(root, entry), { recursive: true, force: true });
}

test("workspace creation records a private owner marker alongside the directory identity", (t) => {
  const workspace = ownedWorkspace(t, "gauntlet-java-cleanup-marker-");
  const marker = lstatSync(resolve(workspace.root, WORKSPACE_MARKER));
  assert.equal(Object.isFrozen(workspace), true);
  assert.equal(marker.isFile(), true);
  assert.equal(marker.mode & 0o777, 0o600);
  assert.match(readFileSync(resolve(workspace.root, WORKSPACE_MARKER), "utf8"), /^[0-9a-f]{64}\n$/u);
  const other = createWorkspace(resolve(workspace.root, ".."));
  assert.notEqual(
    readFileSync(resolve(other.root, WORKSPACE_MARKER), "utf8"),
    readFileSync(resolve(workspace.root, WORKSPACE_MARKER), "utf8"),
  );
});

test("workspace cleanup retries ENOTEMPTY only while the owned identity remains", async (t) => {
  const workspace = ownedWorkspace(t, "gauntlet-java-cleanup-retry-");
  let attempts = 0;

  assert.equal(await removeWorkspace(workspace, (path, options) => {
    attempts += 1;
    if (attempts === 1) throw simulatedRace("simulated APFS cleanup race");
    rmSync(path, options);
  }), true);
  assert.equal(attempts, 2);
  assert.equal(existsSync(workspace.root), false);
});

test("workspace cleanup preserves a replacement after an ENOTEMPTY race", async (t) => {
  const workspace = ownedWorkspace(t, "gauntlet-java-cleanup-replacement-");
  let attempts = 0;

  assert.equal(await removeWorkspace(workspace, () => {
    attempts += 1;
    rmSync(workspace.root, { recursive: true, force: false });
    mkdirSync(workspace.root, { mode: 0o700 });
    writeFileSync(resolve(workspace.root, "foreign"), "preserve\n", { mode: 0o600 });
    throw simulatedRace("simulated replacement race");
  }), false);
  assert.equal(attempts, 1);
  assert.equal(readFileSync(resolve(workspace.root, "foreign"), "utf8"), "preserve\n");
});

test("workspace cleanup preserves a replacement that reuses the directory inode without the owner marker", async (t) => {
  // ext4 reuses a deleted directory's inode number immediately; emptying the directory in place
  // reproduces that identical dev/ino/uid replacement deterministically on every filesystem.
  const workspace = ownedWorkspace(t, "gauntlet-java-cleanup-inode-reuse-");
  const before = lstatSync(workspace.root, { bigint: true });
  let attempts = 0;

  assert.equal(await removeWorkspace(workspace, () => {
    attempts += 1;
    emptyInPlace(workspace.root);
    writeFileSync(resolve(workspace.root, "foreign"), "preserve\n", { mode: 0o600 });
    throw simulatedRace("simulated inode reuse race");
  }), false);
  const after = lstatSync(workspace.root, { bigint: true });
  assert.equal(after.dev === before.dev && after.ino === before.ino && after.uid === before.uid, true);
  assert.equal(attempts, 1);
  assert.equal(readFileSync(resolve(workspace.root, "foreign"), "utf8"), "preserve\n");
});

test("workspace cleanup preserves a same-inode replacement that carries a different owner marker", async (t) => {
  const workspace = ownedWorkspace(t, "gauntlet-java-cleanup-foreign-marker-");
  let attempts = 0;

  assert.equal(await removeWorkspace(workspace, () => {
    attempts += 1;
    emptyInPlace(workspace.root);
    writeFileSync(resolve(workspace.root, WORKSPACE_MARKER), `${"f".repeat(64)}\n`, { mode: 0o600 });
    writeFileSync(resolve(workspace.root, "foreign"), "preserve\n", { mode: 0o600 });
    throw simulatedRace("simulated foreign workspace race");
  }), false);
  assert.equal(attempts, 1);
  assert.equal(readFileSync(resolve(workspace.root, "foreign"), "utf8"), "preserve\n");
});

test("workspace cleanup refuses a workspace whose owner marker is missing before the first attempt", async (t) => {
  const workspace = ownedWorkspace(t, "gauntlet-java-cleanup-no-marker-");
  rmSync(resolve(workspace.root, WORKSPACE_MARKER));
  let attempts = 0;

  assert.equal(await removeWorkspace(workspace, () => {
    attempts += 1;
  }), false);
  assert.equal(attempts, 0);
  assert.equal(readFileSync(resolve(workspace.root, "entry"), "utf8"), "owned\n");
});

test("rejects Docker endpoint result accessors without evaluating them", () => {
  let accessed = false;
  const endpoint = {
    get status() {
      accessed = true;
      return 0;
    },
    signal: null,
    stdout: '"unix:///var/run/docker.sock"\n',
    stderr: "",
  };
  assert.throws(() => parseLocalDockerEndpoint(endpoint), /local Docker daemon/u);
  assert.equal(accessed, false);
});

test("rejects unsafe plan inputs before constructing Docker arguments", () => {
  const base = {
    root: "/private/repository",
    sandbox: "/private/tc-java-source-123",
    version: "0.1.0",
    uid: 501,
    gid: 20,
    token: TOKEN,
    dockerHost: "unix:///var/run/docker.sock",
    executablePath: "/safe/bin",
  };
  for (const change of [
    { root: "relative" },
    { sandbox: "/private/../escape" },
    { sandbox: "/private/with,comma" },
    { version: "0.1.0-SNAPSHOT" },
    { uid: -1 },
    { gid: 1.5 },
    { token: "short" },
    { dockerHost: "tcp://builder.example:2376" },
  ]) {
    assert.throws(() => createJavaSourcePlan({ ...base, ...change }), {
      name: "TypeError",
      message: "Java source plan is invalid",
    });
  }
  assert.throws(() => createJavaSourcePlan({ ...base, extra: true }), {
    name: "TypeError",
    message: "Java source plan is invalid",
  });
});

test("checks the live dirty Java tree from an isolated snapshot without host tools or secrets", async (t) => {
  const fixture = sourceFixture(t);
  const calls = [];
  const runner = async (invocation) => {
    calls.push(invocation);
    if (invocation.args[0] === "context") return localContext();
    if (invocation.args[0] === "run") {
      const mount = invocation.args.find((argument) => argument.startsWith("type=bind,src=") && argument.endsWith(",dst=/workspace"));
      const source = mount.slice("type=bind,src=".length, -",dst=/workspace".length);
      assert.equal(readFileSync(resolve(source, "packages/java/core/src/main/java/example/Dirty.java"), "utf8"), "class Dirty {}\n");
      assert.equal(existsSync(resolve(source, "packages/java/core/build/stale-secret.txt")), false);
      assert.equal(existsSync(resolve(source, "packages/java/.gradle/host-cache.bin")), false);
      assert.equal(existsSync(resolve(source, ".env")), false);
      assert.equal(existsSync(resolve(source, ".git")), false);
      assert.equal(Object.hasOwn(invocation.environment, "DOCKER_CONTEXT"), false);
      assert.equal(Object.hasOwn(invocation.environment, "DOCKER_TLS_VERIFY"), false);
      assert.equal(Object.hasOwn(invocation.environment, "GITHUB_TOKEN"), false);
      assert.equal(invocation.environment.DOCKER_HOST, "unix:///var/run/docker.sock");
      return result();
    }
    if (invocation.args[0] === "container" && invocation.args[1] === "inspect") {
      return absentContainer(`gauntlet-java-source-${TOKEN.slice(0, 24)}`);
    }
    assert.fail(`unexpected invocation: ${JSON.stringify(invocation)}`);
  };

  const report = await runJavaSourceCheck({
    root: fixture.root,
    temporaryDirectory: fixture.temporaryDirectory,
    token: TOKEN,
    environment: {
      PATH: "/safe/bin",
      HOME: "/host/home",
      DOCKER_CONFIG: "/host/docker-config",
      DOCKER_CONTEXT: "selected-context",
      DOCKER_HOST: "tcp://hostile.example:2376",
      DOCKER_CERT_PATH: "/host/certificates",
      DOCKER_TLS_VERIFY: "1",
      GITHUB_TOKEN: "never-forward",
    },
    runner,
  });

  assert.deepEqual(report, { ok: true, version: "0.1.0", sourceChecks: 4 });
  assert.equal(Object.isFrozen(report), true);
  assert.deepEqual(calls.map(({ command, args }) => [command, args.slice(0, 2)]), [
    ["docker", ["context", "inspect"]],
    ["docker", ["run", "--rm"]],
    ["docker", ["container", "inspect"]],
  ]);
  assert.equal(calls.some(({ command }) => ["git", "java", "gradle", "id"].includes(command)), false);
  assert.equal(calls[0].environment.DOCKER_CONTEXT, "selected-context");
  assert.equal(calls[0].environment.DOCKER_HOST, "tcp://hostile.example:2376");
  assert.deepEqual(readdirSync(fixture.temporaryDirectory), []);
});

test("refuses a remote effective Docker endpoint before starting a container", async (t) => {
  const fixture = sourceFixture(t);
  const calls = [];
  await assert.rejects(
    runJavaSourceCheck({
      root: fixture.root,
      temporaryDirectory: fixture.temporaryDirectory,
      token: TOKEN,
      environment: { PATH: "/safe/bin", HOME: "/host/home" },
      runner: async (invocation) => {
        calls.push(invocation);
        return result('"ssh://builder.example"\n');
      },
    }),
    { message: "Java source verification failed safely" },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0], "context");
  assert.deepEqual(readdirSync(fixture.temporaryDirectory), []);
});

test("removes an interrupted container only after proving its owner label", async (t) => {
  const fixture = sourceFixture(t);
  const calls = [];
  const containerId = "a".repeat(64);
  const name = `gauntlet-java-source-${TOKEN.slice(0, 24)}`;
  await assert.rejects(
    runJavaSourceCheck({
      root: fixture.root,
      temporaryDirectory: fixture.temporaryDirectory,
      token: TOKEN,
      environment: { PATH: "/safe/bin", HOME: "/host/home" },
      runner: async (invocation) => {
        calls.push(invocation);
        if (invocation.args[0] === "context") return localContext();
        if (invocation.args[0] === "run") return result("", { status: 17, stderr: "private Gradle failure\n" });
        if (invocation.args[0] === "container") {
          return result(`${containerId}\t/${name}\t${TOKEN}\n`);
        }
        if (invocation.args[0] === "rm") return result(`${name}\n`);
        assert.fail(`unexpected invocation: ${JSON.stringify(invocation)}`);
      },
    }),
    { message: "Java source verification failed safely" },
  );
  const removal = calls.find(({ args }) => args[0] === "rm");
  assert.deepEqual(removal.args, ["rm", "--force", containerId]);
  assert.deepEqual(readdirSync(fixture.temporaryDirectory), []);
});

test("never removes a same-name container with a different owner", async (t) => {
  const fixture = sourceFixture(t);
  const calls = [];
  const name = `gauntlet-java-source-${TOKEN.slice(0, 24)}`;
  await assert.rejects(
    runJavaSourceCheck({
      root: fixture.root,
      temporaryDirectory: fixture.temporaryDirectory,
      token: TOKEN,
      environment: { PATH: "/safe/bin", HOME: "/host/home" },
      runner: async (invocation) => {
        calls.push(invocation);
        if (invocation.args[0] === "context") return localContext();
        if (invocation.args[0] === "run") return result("", { status: 17 });
        if (invocation.args[0] === "container") {
          return result(`${"b".repeat(64)}\t/${name}\t${"f".repeat(32)}\n`);
        }
        assert.fail("foreign resources must not be removed");
      },
    }),
    { message: "Java source verification failed safely" },
  );
  assert.equal(calls.some(({ args }) => args[0] === "rm"), false);
});

test("fails closed when the source changes during the container run", async (t) => {
  const fixture = sourceFixture(t);
  await assert.rejects(
    runJavaSourceCheck({
      root: fixture.root,
      temporaryDirectory: fixture.temporaryDirectory,
      token: TOKEN,
      environment: { PATH: "/safe/bin", HOME: "/host/home" },
      runner: async (invocation) => {
        if (invocation.args[0] === "context") return localContext();
        if (invocation.args[0] === "run") {
          fixture.write("packages/java/core/src/main/java/example/Dirty.java", "class Changed {}\n");
          return result();
        }
        return absentContainer(`gauntlet-java-source-${TOKEN.slice(0, 24)}`);
      },
    }),
    { message: "Java source verification failed safely" },
  );
});

test("rejects linked source entries before Docker context discovery", async (t) => {
  for (const kind of ["symbolic", "hard"]) {
    await t.test(kind, async (t) => {
      const fixture = sourceFixture(t);
      const target = resolve(fixture.root, "packages/java/settings.gradle.kts");
      const linked = resolve(fixture.root, `packages/java/${kind}.gradle.kts`);
      if (kind === "symbolic") symlinkSync(target, linked);
      else linkSync(target, linked);
      let called = false;
      await assert.rejects(
        runJavaSourceCheck({
          root: fixture.root,
          temporaryDirectory: fixture.temporaryDirectory,
          token: TOKEN,
          environment: { PATH: "/safe/bin", HOME: "/host/home" },
          runner: async () => {
            called = true;
            return localContext();
          },
        }),
        { message: "Java source verification failed safely" },
      );
      assert.equal(called, false);
    });
  }
});

test("the source-only CLI rejects arguments without touching Docker", async () => {
  let called = false;
  const result = await runJavaSourceCli(["--source-only"], {
    runner: async () => {
      called = true;
      return localContext();
    },
  });
  assert.equal(called, false);
  assert.deepEqual(result, {
    exitCode: 2,
    stdout: "",
    stderr: "Java source verification failed safely\n",
  });
});

test("rejects environment accessors without evaluating or reaching Docker", async (t) => {
  const fixture = sourceFixture(t);
  let accessed = false;
  let called = false;
  const environment = {
    get PATH() {
      accessed = true;
      return "/safe/bin";
    },
  };
  await assert.rejects(
    runJavaSourceCheck({
      root: fixture.root,
      temporaryDirectory: fixture.temporaryDirectory,
      token: TOKEN,
      environment,
      runner: async () => {
        called = true;
        return localContext();
      },
    }),
    { message: "Java source verification failed safely" },
  );
  assert.equal(accessed, false);
  assert.equal(called, false);
});
