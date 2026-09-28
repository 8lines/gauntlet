import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const sourceDirectory = fileURLToPath(new URL("../", import.meta.url));
const sourceWrapper = join(sourceDirectory, "gauntlet");
const MAX_OUTPUT = 256 * 1024;

const fakeDocker = `#!/bin/sh
set -eu
{
  printf '%s\\0' __CALL__
  for argument do printf '%s\\0' "$argument"; done
  printf '%s\\0' __END__ __ENV__ \
    "COMPOSE_FILE=\${COMPOSE_FILE-unset}" \
    "COMPOSE_PROJECT_NAME=\${COMPOSE_PROJECT_NAME-unset}" \
    "COMPOSE_PROFILES=\${COMPOSE_PROFILES-unset}" \
    "COMPOSE_ENV_FILES=\${COMPOSE_ENV_FILES-unset}" \
    "GAUNTLET_IMAGE=\${GAUNTLET_IMAGE-unset}" \
    "GAUNTLET_BIND=\${GAUNTLET_BIND-unset}" \
    "GAUNTLET_PORT=\${GAUNTLET_PORT-unset}" \
    "GAUNTLET_CONFIG_PATH=\${GAUNTLET_CONFIG_PATH-unset}" \
    "GAUNTLET_MCP_ENABLED=\${GAUNTLET_MCP_ENABLED-unset}" \
    "GAUNTLET_MCP_ALLOWED_ORIGINS_JSON=\${GAUNTLET_MCP_ALLOWED_ORIGINS_JSON-unset}" \
    __ENV_END__
} >> "$FAKE_DOCKER_RECEIPT"

if [ "\${1-}" = network ] && [ "\${2-}" = inspect ]; then
  case "\${FAKE_DOCKER_NETWORK_MODE-}" in
    exists) exit 0 ;;
    absent)
      [ -f "$FAKE_DOCKER_STATE/created" ] && exit 0
      exit 1
      ;;
    race)
      [ -f "$FAKE_DOCKER_STATE/inspected" ] && exit 0
      : > "$FAKE_DOCKER_STATE/inspected"
      exit 1
      ;;
    *) exit 1 ;;
  esac
fi

if [ "\${1-}" = network ] && [ "\${2-}" = create ]; then
  case "\${FAKE_DOCKER_NETWORK_MODE-}" in
    absent) : > "$FAKE_DOCKER_STATE/created"; exit 0 ;;
    race) exit 1 ;;
    *) exit 1 ;;
  esac
fi

if [ "\${FAKE_DOCKER_SELF_SIGNAL-}" = TERM ]; then
  kill -TERM "$$"
fi
exit "\${FAKE_DOCKER_COMPOSE_STATUS-0}"
`;

async function fixture({ initialized = true, config = true } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gauntlet-wrapper-")));
  const distribution = join(root, "distribution with spaces");
  const bin = join(root, "fake bin");
  const state = join(root, "state");
  const receipt = join(root, "docker.receipt");
  await Promise.all([mkdir(distribution), mkdir(bin), mkdir(state)]);
  await Promise.all([
    copyFile(join(sourceDirectory, "compose.yaml"), join(distribution, "compose.yaml")),
    copyFile(join(sourceDirectory, ".env.example"), join(distribution, ".env.example")),
    copyFile(join(sourceDirectory, "config.example.yaml"), join(distribution, "config.example.yaml")),
    copyFile(sourceWrapper, join(distribution, "gauntlet")),
    writeFile(join(bin, "docker"), fakeDocker, { mode: 0o700 }),
    writeFile(receipt, ""),
  ]);
  await chmod(join(distribution, "gauntlet"), 0o755);
  if (initialized) {
    await copyFile(join(distribution, ".env.example"), join(distribution, ".env"));
    await chmod(join(distribution, ".env"), 0o600);
    if (config) {
      await copyFile(join(distribution, "config.example.yaml"), join(distribution, "config.yaml"));
      await chmod(join(distribution, "config.yaml"), 0o644);
    }
  }
  return {
    root,
    distribution,
    wrapper: join(distribution, "gauntlet"),
    receipt,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOME: root,
      FAKE_DOCKER_RECEIPT: receipt,
      FAKE_DOCKER_STATE: state,
    },
  };
}

function run(instance, args, overrides = {}) {
  return spawnSync(instance.wrapper, args, {
    cwd: dirname(instance.root),
    encoding: "utf8",
    env: { ...instance.env, ...overrides },
    maxBuffer: MAX_OUTPUT,
    stdio: "pipe",
  });
}

async function calls(receipt) {
  const fields = (await readFile(receipt)).toString("utf8").split("\0");
  const result = [];
  let current = null;
  for (const field of fields) {
    if (field === "__CALL__") {
      current = { args: [], env: [] };
      result.push(current);
    } else if (field === "__END__") {
      current = null;
    } else if (field === "__ENV__") {
      current = result.at(-1) ?? null;
    } else if (field === "__ENV_END__") {
      current = null;
    } else if (field !== "" && current !== null) {
      if (field.includes("=") && current.args.length > 0 && field.match(/^(?:COMPOSE_|GAUNTLET_)/)) {
        current.env.push(field);
      } else {
        current.args.push(field);
      }
    }
  }
  return result;
}

async function cleanup(instance) {
  await rm(instance.root, { recursive: true, force: true });
}

test("ships an executable POSIX wrapper with LF line endings", async () => {
  await access(sourceWrapper, constants.X_OK);
  const [metadata, contents] = await Promise.all([stat(sourceWrapper), readFile(sourceWrapper)]);
  assert.equal(metadata.isFile(), true);
  assert.equal(metadata.mode & 0o111, 0o111);
  assert.equal(contents.subarray(0, 10).toString("utf8"), "#!/bin/sh\n");
  assert.equal(contents.includes(0x0d), false);
});

test("init creates exact private operator files once", async () => {
  const instance = await fixture({ initialized: false });
  try {
    const result = run(instance, ["init"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "Created .env and config.yaml; review them before running up.\n");
    assert.equal(result.stderr, "");
    for (const [destination, source, mode] of [
      [".env", ".env.example", 0o600],
      ["config.yaml", "config.example.yaml", 0o644],
    ]) {
      assert.deepEqual(
        await readFile(join(instance.distribution, destination)),
        await readFile(join(instance.distribution, source)),
      );
      assert.equal((await stat(join(instance.distribution, destination))).mode & 0o777, mode);
    }
    assert.deepEqual(await calls(instance.receipt), []);
    assert.equal((await lstat(instance.distribution)).isDirectory(), true);
  } finally {
    await cleanup(instance);
  }
});

test("init refuses existing and dangling destinations without partial writes", async () => {
  for (const occupied of [".env", "config.yaml"]) {
    for (const dangling of [false, true]) {
      const instance = await fixture({ initialized: false });
      try {
        const destination = join(instance.distribution, occupied);
        if (dangling) await symlink("missing-operator-file", destination);
        else await writeFile(destination, "operator-owned\n", { mode: 0o600 });
        const result = run(instance, ["init"]);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /^Gauntlet initialization refused:/);
        const other = occupied === ".env" ? "config.yaml" : ".env";
        await assert.rejects(lstat(join(instance.distribution, other)), { code: "ENOENT" });
        if (dangling) assert.equal((await lstat(destination)).isSymbolicLink(), true);
        else assert.equal(await readFile(destination, "utf8"), "operator-owned\n");
      } finally {
        await cleanup(instance);
      }
    }
  }
});

test("exactly one concurrent init succeeds and leaves no lock or partial file", async () => {
  const instance = await fixture({ initialized: false });
  try {
    const options = { cwd: dirname(instance.root), env: instance.env, encoding: "utf8" };
    const children = [
      spawn(instance.wrapper, ["init"], options),
      spawn(instance.wrapper, ["init"], options),
    ];
    const results = await Promise.all(children.map((child) => new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
    })));
    assert.deepEqual(results.map(({ status }) => status).sort(), [0, 73]);
    assert.deepEqual(
      await readFile(join(instance.distribution, ".env")),
      await readFile(join(instance.distribution, ".env.example")),
    );
    assert.deepEqual(
      await readFile(join(instance.distribution, "config.yaml")),
      await readFile(join(instance.distribution, "config.example.yaml")),
    );
    await assert.rejects(lstat(join(instance.distribution, ".gauntlet-init.lock")), { code: "ENOENT" });
  } finally {
    await cleanup(instance);
  }
});

test("help and invalid grammar never invoke Docker", async () => {
  const instance = await fixture();
  try {
    const help = run(instance, ["help"]);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /^Usage:/);
    for (const args of [[], ["--project-name", "hostile"], ["-f", "hostile.yaml"], ["unknown"]]) {
      const result = run(instance, args);
      assert.equal(result.status, 64, args.join(" "));
      assert.match(result.stderr, /^Usage:/);
    }
    assert.deepEqual(await calls(instance.receipt), []);
  } finally {
    await cleanup(instance);
  }
});

test("delegation pins absolute Compose inputs, preserves arguments and scrubs model environment", async () => {
  const instance = await fixture({ config: false });
  try {
    const result = run(instance, ["logs", "service with spaces", "quote'and\"double", "--tail", "20"], {
      COMPOSE_FILE: "/tmp/hostile.yaml",
      COMPOSE_PROJECT_NAME: "hostile",
      COMPOSE_PROFILES: "unsafe",
      COMPOSE_ENV_FILES: "/tmp/hostile.env",
      GAUNTLET_IMAGE: "evil.invalid/latest",
      GAUNTLET_BIND: "0.0.0.0",
      GAUNTLET_PORT: "80",
      GAUNTLET_CONFIG_PATH: "/tmp/hostile-config",
      GAUNTLET_MCP_ENABLED: "true",
      GAUNTLET_MCP_ALLOWED_ORIGINS_JSON: '["https://hostile.example"]',
    });
    assert.equal(result.status, 0, result.stderr);
    const recorded = await calls(instance.receipt);
    assert.equal(recorded.length, 1);
    assert.deepEqual(recorded[0].args, [
      "compose",
      "--project-name", "gauntlet",
      "--project-directory", instance.distribution,
      "--env-file", join(instance.distribution, ".env"),
      "-f", join(instance.distribution, "compose.yaml"),
      "logs", "service with spaces", "quote'and\"double", "--tail", "20",
    ]);
    assert.deepEqual(recorded[0].env, [
      "COMPOSE_FILE=unset",
      "COMPOSE_PROJECT_NAME=unset",
      "COMPOSE_PROFILES=unset",
      "COMPOSE_ENV_FILES=unset",
      "GAUNTLET_IMAGE=unset",
      "GAUNTLET_BIND=unset",
      "GAUNTLET_PORT=unset",
      "GAUNTLET_CONFIG_PATH=unset",
      "GAUNTLET_MCP_ENABLED=unset",
      "GAUNTLET_MCP_ALLOWED_ORIGINS_JSON=unset",
    ]);
  } finally {
    await cleanup(instance);
  }
});

test("only container-creating commands ensure the shared network", async () => {
  for (const command of ["up", "create", "run", "scale", "watch"]) {
    const instance = await fixture();
    try {
      const result = run(instance, [command, "--example"], { FAKE_DOCKER_NETWORK_MODE: "absent" });
      assert.equal(result.status, 0, `${command}: ${result.stderr}`);
      const recorded = await calls(instance.receipt);
      assert.deepEqual(recorded.slice(0, 2).map(({ args }) => args), [
        ["network", "inspect", "gauntlet"],
        ["network", "create", "gauntlet"],
      ]);
      assert.equal(recorded[2]?.args[0], "compose");
      assert.equal(recorded[2]?.args.at(-2), command);
    } finally {
      await cleanup(instance);
    }
  }

  for (const command of ["down", "logs", "config", "pull", "restart", "ps", "stop", "start", "build"] ) {
    const instance = await fixture();
    try {
      const result = run(instance, [command]);
      assert.equal(result.status, 0, command);
      const recorded = await calls(instance.receipt);
      assert.equal(recorded.length, 1, command);
      assert.equal(recorded[0]?.args[0], "compose");
    } finally {
      await cleanup(instance);
    }
  }
});

test("network creation handles an existing network and a concurrent creator", async () => {
  for (const [mode, expected] of [
    ["exists", [["network", "inspect", "gauntlet"]]],
    ["race", [
      ["network", "inspect", "gauntlet"],
      ["network", "create", "gauntlet"],
      ["network", "inspect", "gauntlet"],
    ]],
  ]) {
    const instance = await fixture();
    try {
      const result = run(instance, ["up", "-d", "--wait"], { FAKE_DOCKER_NETWORK_MODE: mode });
      assert.equal(result.status, 0, `${mode}: ${result.stderr}`);
      const recorded = await calls(instance.receipt);
      assert.deepEqual(recorded.slice(0, -1).map(({ args }) => args), expected);
      assert.deepEqual(recorded.at(-1)?.args.slice(-3), ["up", "-d", "--wait"]);
    } finally {
      await cleanup(instance);
    }
  }
});

test("network failure blocks Compose with a fixed diagnostic", async () => {
  const instance = await fixture();
  try {
    const result = run(instance, ["up"], { FAKE_DOCKER_NETWORK_MODE: "fail" });
    assert.equal(result.status, 69);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Gauntlet could not ensure the shared adapter network.\n");
    const recorded = await calls(instance.receipt);
    assert.deepEqual(recorded.map(({ args }) => args), [
      ["network", "inspect", "gauntlet"],
      ["network", "create", "gauntlet"],
      ["network", "inspect", "gauntlet"],
    ]);
  } finally {
    await cleanup(instance);
  }
});

test("Compose exit status and signal are preserved by exec", async () => {
  const statusInstance = await fixture();
  try {
    const result = run(statusInstance, ["ps"], { FAKE_DOCKER_COMPOSE_STATUS: "42" });
    assert.equal(result.status, 42);
  } finally {
    await cleanup(statusInstance);
  }

  const signalInstance = await fixture();
  try {
    const result = run(signalInstance, ["ps"], { FAKE_DOCKER_SELF_SIGNAL: "TERM" });
    assert.equal(result.signal, "SIGTERM");
  } finally {
    await cleanup(signalInstance);
  }
});

test("ordinary delegation requires the fixed env and base files but not config.yaml", async () => {
  for (const missing of [".env", "compose.yaml"]) {
    const instance = await fixture({ config: false });
    try {
      await rm(join(instance.distribution, missing));
      const result = run(instance, ["ps"]);
      assert.equal(result.status, 66);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /^Gauntlet distribution is incomplete:/);
      assert.deepEqual(await calls(instance.receipt), []);
    } finally {
      await cleanup(instance);
    }
  }
});
