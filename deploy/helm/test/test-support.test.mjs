import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relative } from "node:path";
import { test } from "node:test";

let support = {};
try {
  support = await import("../test-support.mjs");
} catch {
  // RED is expressed by the contract assertions below, not by a loader error.
}

const repositoryRoot = "/workspace/gauntlet";

test("the Helm boundary is a pinned, offline, read-only, unprivileged container", () => {
  assert.equal(typeof support.buildHelmDockerArgs, "function");
  assert.deepEqual(
    support.buildHelmDockerArgs(["lint", "deploy/helm/gauntlet"], { repositoryRoot }),
    [
      "run",
      "--rm",
      "--pull=never",
      "--network=none",
      "--read-only",
      "--user", "65534:65534",
      "--cap-drop=ALL",
      "--security-opt", "no-new-privileges",
      "--memory=256m",
      "--memory-swap=256m",
      "--cpus=1",
      "--pids-limit=128",
      "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777,uid=65534,gid=65534",
      "--tmpfs", "/helm-cache:rw,noexec,nosuid,nodev,size=16m,mode=0700,uid=65534,gid=65534",
      "--tmpfs", "/helm-config:rw,noexec,nosuid,nodev,size=1m,mode=0700,uid=65534,gid=65534",
      "--tmpfs", "/helm-data:rw,noexec,nosuid,nodev,size=16m,mode=0700,uid=65534,gid=65534",
      "--env", "HOME=/tmp",
      "--env", "HELM_CACHE_HOME=/helm-cache",
      "--env", "HELM_CONFIG_HOME=/helm-config",
      "--env", "HELM_DATA_HOME=/helm-data",
      "--mount", `type=bind,src=${repositoryRoot},dst=/workspace,readonly`,
      "--workdir", "/workspace",
      "alpine/helm:4.0.4@sha256:adb87b125214fd356ecc1a24a1e86e4afed0ee03de5d4391de4925777de7fd42",
      "lint", "deploy/helm/gauntlet",
    ],
  );
});

test("the Helm boundary adds only one explicit writable package-output mount", () => {
  assert.equal(typeof support.buildHelmDockerArgs, "function");
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "gauntlet-helm-output-test-")));
  const outputDirectory = join(fixture, "output");
  const file = join(fixture, "file");
  const link = join(fixture, "link");
  const realParent = join(fixture, "real-parent");
  const parentLink = join(fixture, "parent-link");
  mkdirSync(outputDirectory);
  mkdirSync(realParent);
  mkdirSync(join(realParent, "nested"));
  writeFileSync(file, "not a directory\n");
  symlinkSync(outputDirectory, link);
  symlinkSync(realParent, parentLink);

  try {
    const args = support.buildHelmDockerArgs(
      ["package", "deploy/helm/gauntlet", "--destination", "/output"],
      { repositoryRoot, outputDirectory },
    );
    const mounts = args.filter((_value, index) => args[index - 1] === "--mount");
    assert.deepEqual(mounts, [
      `type=bind,src=${repositoryRoot},dst=/workspace,readonly`,
      `type=bind,src=${outputDirectory},dst=/output`,
    ]);
    assert.equal(mounts.filter((mount) => !mount.endsWith(",readonly")).length, 1);

    for (const unsafe of [
      "relative",
      "/",
      `${fixture}/bad,option`,
      file,
      link,
      join(parentLink, "nested"),
    ]) {
      assert.throws(
        () => support.buildHelmDockerArgs(["package", "chart"], {
          repositoryRoot,
          outputDirectory: unsafe,
        }),
        /output directory/,
      );
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("the Helm runner carries its validated package-output mount to Docker", () => {
  assert.equal(typeof support.createHelmRunner, "function");
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "gauntlet-helm-runner-output-test-")));
  const outputDirectory = join(fixture, "output");
  mkdirSync(outputDirectory);
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return args[0] === "context"
      ? { status: 0, signal: null, stdout: '"unix:///var/run/docker.sock"\n', stderr: "" }
      : { status: 0, signal: null, stdout: "saved\n", stderr: "" };
  };

  try {
    const helm = support.createHelmRunner({
      environment: { PATH: "/safe/bin" },
      mountedRepositoryRoot: repositoryRoot,
      outputDirectory,
      spawn,
    });
    assert.equal(
      helm(["package", "deploy/helm/gauntlet", "--destination", "/output"]),
      "saved\n",
    );
    assert.equal(
      calls[1].args.includes(`type=bind,src=${outputDirectory},dst=/output`),
      true,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("write-capable Helm options accept only enumerable data properties on plain objects", () => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "gauntlet-helm-option-test-")));
  const sentinel = "mount-option-trap-sentinel-583920";
  try {
    const nullPrototype = Object.assign(Object.create(null), {
      repositoryRoot,
      outputDirectory: fixture,
    });
    assert.equal(
      support.buildHelmDockerArgs(["package", "chart"], nullPrototype)
        .includes(`type=bind,src=${fixture},dst=/output`),
      true,
    );

    const accessor = { repositoryRoot };
    Object.defineProperty(accessor, "outputDirectory", {
      enumerable: true,
      get() { throw new Error(sentinel); },
    });
    const nonEnumerable = { repositoryRoot };
    Object.defineProperty(nonEnumerable, "outputDirectory", {
      enumerable: false,
      value: fixture,
    });
    const symbolKey = { repositoryRoot, outputDirectory: fixture };
    symbolKey[Symbol("hidden-mount")] = fixture;
    const proxy = new Proxy(
      { repositoryRoot, outputDirectory: fixture },
      {
        getPrototypeOf() { throw new Error(sentinel); },
        ownKeys() { throw new Error(sentinel); },
      },
    );

    for (const options of [accessor, nonEnumerable, symbolKey, proxy]) {
      assert.throws(
        () => support.buildHelmDockerArgs(["package", "chart"], options),
        (error) => {
          assert.match(error.message, /Helm Docker options/);
          assert.equal(error.message.includes(sentinel), false);
          return true;
        },
      );
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("the Helm boundary rejects unsafe command and repository inputs", () => {
  assert.equal(typeof support.buildHelmDockerArgs, "function");
  for (const repositoryRoot of ["relative", "/", "/workspace/new\nline"])
    assert.throws(
      () => support.buildHelmDockerArgs(["lint", "chart"], { repositoryRoot }),
      /repository root/,
    );
  for (const args of [[], [""], ["lint\0chart"], ["lint", 7]])
    assert.throws(
      () => support.buildHelmDockerArgs(args, { repositoryRoot: "/workspace/gauntlet" }),
      /Helm arguments/,
    );
});

test("the helper admits only a local Unix Docker endpoint", () => {
  assert.equal(typeof support.parseLocalDockerEndpoint, "function");
  assert.equal(
    support.parseLocalDockerEndpoint('"unix:///var/run/docker.sock"\n'),
    "unix:///var/run/docker.sock",
  );
  for (const output of [
    '"tcp://127.0.0.1:2375"\n',
    '"ssh://builder.example"\n',
    '"unix://"\n',
    '"unix:///tmp/unsafe socket"\n',
    "not-json\n",
  ]) assert.throws(() => support.parseLocalDockerEndpoint(output), /local Docker daemon/);
});

test("the helper strips Docker overrides, Kubernetes state, proxies, and credentials", () => {
  assert.equal(typeof support.sanitizedHelmEnvironment, "function");
  assert.deepEqual(support.sanitizedHelmEnvironment({
    PATH: "/safe/bin",
    HOME: "/safe/home",
    LANG: "C.UTF-8",
    DOCKER_HOST: "tcp://remote.invalid:2375",
    DOCKER_CONTEXT: "remote",
    DOCKER_CONFIG: "/secret",
    DOCKER_AUTH_CONFIG: "secret",
    HELM_CONFIG_HOME: "/hostile",
    KUBECONFIG: "/secret",
    HTTPS_PROXY: "http://user:secret@example.invalid",
    GH_TOKEN: "secret",
    GITHUB_TOKEN: "secret",
    GAUNTLET_SECRET: "secret",
    AWS_SECRET_ACCESS_KEY: "secret",
  }), {
    PATH: "/safe/bin",
    HOME: "/safe/home",
    LANG: "C.UTF-8",
  });
});

test("the Helm runner pipes stdin without placing it in arguments or diagnostics", () => {
  assert.equal(typeof support.createHelmRunner, "function");
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === "context") {
      return { status: 0, signal: null, stdout: '"unix:///var/run/docker.sock"\n', stderr: "" };
    }
    return { status: 0, signal: null, stdout: "rendered\n", stderr: "" };
  };
  const helm = support.createHelmRunner({
    environment: {
      PATH: "/safe/bin",
      HOME: "/safe/home",
      GH_TOKEN: "must-not-cross-boundary",
      KUBECONFIG: "/must-not-cross-boundary",
    },
    mountedRepositoryRoot: "/workspace/gauntlet",
    spawn,
  });
  const input = "sentinel-must-remain-on-stdin";

  assert.equal(helm(["template", "fixture", "-f", "-"], 0, { input }), "rendered\n");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].command, "docker");
  assert.equal(calls[1].args.includes("--interactive"), true);
  assert.equal(calls[1].args.includes(input), false);
  assert.equal(calls[1].options.input, input);
  assert.equal(calls[1].options.env.DOCKER_HOST, "unix:///var/run/docker.sock");
  assert.equal(Object.hasOwn(calls[1].options.env, "GH_TOKEN"), false);
  assert.equal(Object.hasOwn(calls[1].options.env, "KUBECONFIG"), false);
  assert.equal(calls[1].options.timeout, 60_000);
  assert.equal(calls[1].options.killSignal, "SIGKILL");
});

test("unexpected Helm failures expose no values, output, or arguments", () => {
  assert.equal(typeof support.createHelmRunner, "function");
  const sentinel = "secret-sentinel-731904";
  const helm = support.createHelmRunner({
    environment: { PATH: "/safe/bin", HOME: "/safe/home" },
    mountedRepositoryRoot: "/workspace/gauntlet",
    spawn: (_command, args) => args[0] === "context"
      ? { status: 0, signal: null, stdout: '"unix:///var/run/docker.sock"\n', stderr: "" }
      : { status: 17, signal: null, stdout: sentinel, stderr: sentinel },
  });

  assert.throws(
    () => helm(["template", `release-${sentinel}`, "-f", "-"], 0, { input: sentinel }),
    (error) => {
      assert.equal(error.message, "Pinned Helm command failed with unexpected status 17 (expected 0)");
      assert.equal(error.message.includes(sentinel), false);
      return true;
    },
  );
});

test("the manifest parser accepts only strict Kubernetes resource documents", () => {
  assert.equal(typeof support.parseHelmDocuments, "function");
  assert.deepEqual(
    support.parseHelmDocuments([
      "---",
      "apiVersion: v1",
      "kind: ConfigMap",
      "metadata:",
      "  name: first",
      "---",
      "",
      "---",
      "apiVersion: apps/v1",
      "kind: Deployment",
      "metadata:",
      "  name: second",
      "",
    ].join("\n")),
    [
      { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "first" } },
      { apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "second" } },
    ],
  );

  const sentinel = "parser-secret-sentinel-441992";
  for (const input of [
    `apiVersion: v1\nkind: ConfigMap\nkind: ${sentinel}\nmetadata:\n  name: bad\n`,
    `- ${sentinel}\n`,
    `apiVersion: v1\nkind: ConfigMap\nmetadata: ${sentinel}\n`,
    `apiVersion: v1\nkind: [${sentinel}\n`,
    `apiVersion: v1\nkind: ConfigMap\nmetadata: &metadata\n  name: bad\ncopy: *metadata\nsentinel: ${sentinel}\n`,
  ]) {
    assert.throws(
      () => support.parseHelmDocuments(input),
      (error) => {
        assert.equal(error.message, "Pinned Helm output is not a strict Kubernetes manifest");
        assert.equal(error.message.includes(sentinel), false);
        return true;
      },
    );
  }
});

test("all Helm helper option objects are closed", () => {
  assert.throws(
    () => support.buildHelmDockerArgs(["lint", "chart"], {
      repositoryRoot: "/workspace/gauntlet",
      network: "host",
    }),
    /Helm Docker options/,
  );
  const inheritedOptions = Object.create({ repositoryRoot: "/" });
  assert.throws(
    () => support.buildHelmDockerArgs(["lint", "chart"], inheritedOptions),
    /Helm Docker options/,
  );
  assert.throws(
    () => support.buildHelmDockerArgs(["lint", "chart"], {
      repositoryRoot: "/workspace/gauntlet",
      interactive: "yes",
    }),
    /Helm Docker options/,
  );
  assert.throws(
    () => support.createHelmRunner({
      mountedRepositoryRoot: "/workspace/gauntlet",
      environment: {},
      spawn: () => ({ status: 0, signal: null, stdout: "", stderr: "" }),
      timeout: 0,
    }),
    /Helm runner options/,
  );
  assert.throws(
    () => support.createHelmRunner({
      mountedRepositoryRoot: "/workspace/gauntlet",
      environment: null,
    }),
    /Helm runner options/,
  );

  const helm = support.createHelmRunner({
    environment: {},
    mountedRepositoryRoot: "/workspace/gauntlet",
    spawn: () => {
      throw new Error("closed options must fail before process discovery");
    },
  });
  for (const options of [null, [], { input: "", environment: { KUBECONFIG: "/secret" } }]) {
    assert.throws(
      () => helm(["template", "fixture"], 0, options),
      /Helm invocation options/,
    );
  }
});

test("the staging renderer has a closed fixed-chart interface", () => {
  assert.equal(typeof support.render, "function");
  for (const invoke of [
    () => support.render("deploy/helm/ci/staging-values.yaml"),
    () => support.render(["/tmp/values.yaml"]),
    () => support.render(["deploy/helm/../secret.yaml"]),
    () => support.render(["deploy/helm//ci/staging-values.yaml"]),
    () => support.render(undefined, ["--namespace", "production"]),
    () => support.render(undefined, ["--output", "json"]),
    () => support.render(undefined, ["--set", "config.instance.name=staging"], { output: "json" }),
    () => support.render(["deploy/helm/ci/staging-values.yaml", "-"], [], {}),
    () => support.render(undefined, [], { input: "config: {}\n" }),
    () => support.render(undefined, [], { kubeVersion: "1.38.0" }),
  ]) assert.throws(invoke, /Helm render/);
});

test("the Helm 4 install parser exposes only nonempty NOTES", () => {
  assert.equal(typeof support.parseHelmInstallNotes, "function");
  assert.equal(
    support.parseHelmInstallNotes(JSON.stringify({
      name: "gauntlet",
      manifest: "adapter-secret-must-not-be-returned",
      info: { notes: "private NOTES only" },
    })),
    "private NOTES only",
  );
  const sentinel = "notes-parser-secret-890155";
  for (const output of [
    sentinel,
    JSON.stringify({ info: { notes: "" }, manifest: sentinel }),
    JSON.stringify({ info: { notes: 7 }, manifest: sentinel }),
    JSON.stringify({ notes: sentinel }),
  ]) {
    assert.throws(
      () => support.parseHelmInstallNotes(output),
      (error) => {
        assert.equal(error.message, "Pinned Helm install did not return safe NOTES");
        assert.equal(error.message.includes(sentinel), false);
        return true;
      },
    );
  }
});

test("the NOTES renderer has the same fixed chart and closed options", () => {
  assert.equal(typeof support.renderNotes, "function");
  assert.throws(() => support.renderNotes("anything"), /Helm NOTES/);
});

test("the NOTES projection is a read-only chart copy with one proved compatibility byte", () => {
  assert.equal(typeof support.createHelmNotesProjection, "function");
  assert.throws(() => support.createHelmNotesProjection({ root: "/" }), /Helm NOTES projection/);
  const projection = support.createHelmNotesProjection();
  const sourceRoot = support.repositoryRoot;

  function filesUnder(root, readOnly = false) {
    const files = [];
    const visit = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = `${directory}/${entry.name}`;
        const stat = lstatSync(path);
        assert.equal(stat.isSymbolicLink(), false);
        if (stat.isDirectory()) {
          if (readOnly) assert.equal(stat.mode & 0o777, 0o555);
          visit(path);
        } else {
          assert.equal(stat.isFile(), true);
          if (readOnly) assert.equal(stat.mode & 0o777, 0o444);
          files.push(relative(root, path));
        }
      }
    };
    if (readOnly) assert.equal(lstatSync(root).mode & 0o777, 0o555);
    visit(root);
    return files.sort();
  }

  try {
    const projectedFiles = filesUnder(projection.root, true);
    const sourceFiles = [
      ...filesUnder(`${sourceRoot}/deploy/helm/gauntlet`)
        .map((path) => `deploy/helm/gauntlet/${path}`),
      "deploy/helm/ci/staging-values.yaml",
    ].sort();
    assert.deepEqual(projectedFiles, sourceFiles);

    for (const path of projectedFiles) {
      const source = readFileSync(`${sourceRoot}/${path}`);
      const projected = readFileSync(`${projection.root}/${path}`);
      if (path !== "deploy/helm/gauntlet/Chart.yaml") {
        assert.deepEqual(projected, source, path);
        continue;
      }
      assert.equal(projected.length, source.length);
      const changed = [];
      for (let index = 0; index < source.length; index += 1) {
        if (source[index] !== projected[index]) changed.push(index);
      }
      assert.equal(changed.length, 1);
      assert.equal(String.fromCharCode(source[changed[0]]), "3");
      assert.equal(String.fromCharCode(projected[changed[0]]), "2");
      assert.match(projected.toString("utf8"), /^kubeVersion: ">=1\.32\.0-0"$/m);
    }
  } finally {
    projection.dispose();
  }
  assert.equal(existsSync(projection.root), false);
});
