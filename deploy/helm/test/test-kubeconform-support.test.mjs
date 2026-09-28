import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { test } from "node:test";
import {
  KUBECONFORM_IMAGE,
  buildKubeconformDockerArgs,
  createKubeconformRunner,
  parseKubeconformOutput,
  schemaRoot,
} from "../kubeconform-support.mjs";

const validOutput = JSON.stringify({
  resources: [{
    filename: "stdin",
    kind: "ConfigMap",
    name: "settings",
    version: "v1",
    status: "statusValid",
    msg: "",
  }],
  summary: { valid: 1, invalid: 0, errors: 0, skipped: 0 },
});

function successfulSpawn(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === "context") {
      return {
        status: 0,
        signal: null,
        stdout: '"unix:///var/run/docker.sock"\n',
        stderr: "",
      };
    }
    assert.equal(readFileSync(`${options.env.DOCKER_CONFIG}/config.json`, "utf8"), "{}\n");
    assert.equal(statSync(`${options.env.DOCKER_CONFIG}/config.json`).mode & 0o777, 0o600);
    return { status: 0, signal: null, stdout: validOutput, stderr: "" };
  };
}

test("the kubeconform command has one pinned offline strict stdin boundary", () => {
  assert.equal(
    KUBECONFORM_IMAGE,
    "ghcr.io/yannh/kubeconform:v0.8.0@sha256:faffaf43f95aa6425306e1ab8d6fcad72acb9049158f38e574c085ea1ec0f64e",
  );
  const args = buildKubeconformDockerArgs("1.35.0");
  assert.deepEqual(args, [
    "run",
    "--rm",
    "--interactive",
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
    "--mount", `type=bind,src=${schemaRoot},dst=/schemas,readonly`,
    KUBECONFORM_IMAGE,
    "-strict",
    "-summary",
    "-verbose",
    "-n", "1",
    "-output", "json",
    "-kubernetes-version", "1.35.0",
    "-schema-location",
    "/schemas/{{.NormalizedKubernetesVersion}}-standalone-strict/{{.ResourceKind}}{{.KindSuffix}}.json",
    "-",
  ]);
  const serialized = JSON.stringify(args);
  for (const forbidden of [
    "ignore-missing-schemas",
    "insecure-skip-tls-verify",
    "schema-location default",
    "http://",
    "https://",
    "kubectl",
  ]) assert.equal(serialized.includes(forbidden), false);
});

test("the runner uses only a local Docker socket, sanitized environment, and stdin", () => {
  const calls = [];
  const validate = createKubeconformRunner({
    environment: {
      HOME: "/safe-home",
      LANG: "C.UTF-8",
      PATH: "/usr/bin:/bin",
    },
    spawn: successfulSpawn(calls),
  });
  const manifest = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: settings\n";
  assert.deepEqual(validate(manifest, { kubeVersion: "1.35.0" }), JSON.parse(validOutput));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, [
    "context", "inspect", "--format", "{{json .Endpoints.docker.Host}}",
  ]);
  assert.deepEqual(calls[0].options.env, {
    HOME: "/safe-home",
    LANG: "C.UTF-8",
    PATH: "/usr/bin:/bin",
  });
  assert.equal(calls[1].options.input, manifest);
  assert.equal(calls[1].options.env.DOCKER_HOST, "unix:///var/run/docker.sock");
  assert.equal(Object.hasOwn(calls[1].options.env, "AWS_SECRET_ACCESS_KEY"), false);
  assert.equal(Object.hasOwn(calls[1].options.env, "DOCKER_AUTH_CONFIG"), false);
  assert.match(calls[1].options.env.DOCKER_CONFIG, /gauntlet-kubeconform-docker-/);
});

test("nested runner environment rejects accessors and proxies without executing attacker code", () => {
  const sentinel = "nested-environment-secret-714209";
  const noSpawn = () => assert.fail("invalid environment must fail before process creation");
  const expectInvalid = (environment) => {
    assert.throws(
      () => createKubeconformRunner({ environment, spawn: noSpawn }),
      (error) => {
        assert.equal(error.message, "Kubeconform runner dependencies are invalid");
        assert.equal(error.message.includes(sentinel), false);
        return true;
      },
    );
  };

  let getterCalled = false;
  const accessorEnvironment = {};
  Object.defineProperty(accessorEnvironment, "HOME", {
    enumerable: true,
    get() {
      getterCalled = true;
      throw new Error(sentinel);
    },
  });
  expectInvalid(accessorEnvironment);
  assert.equal(getterCalled, false);

  let forbiddenGetterCalled = false;
  const forbiddenEnvironment = { PATH: "/usr/bin:/bin" };
  Object.defineProperty(forbiddenEnvironment, "AWS_SECRET_ACCESS_KEY", {
    enumerable: true,
    get() {
      forbiddenGetterCalled = true;
      throw new Error(sentinel);
    },
  });
  expectInvalid(forbiddenEnvironment);
  assert.equal(forbiddenGetterCalled, false);

  let proxyTrapCalled = false;
  const proxyEnvironment = new Proxy({}, {
    getPrototypeOf() {
      proxyTrapCalled = true;
      throw new Error(sentinel);
    },
    ownKeys() {
      proxyTrapCalled = true;
      throw new Error(sentinel);
    },
  });
  expectInvalid(proxyEnvironment);
  assert.equal(proxyTrapCalled, false);
});

test("nested runner environment is a closed string data record", () => {
  const noSpawn = () => assert.fail("invalid environment must fail before process creation");
  const invalidEnvironments = [
    undefined,
    [],
    { PATH: 123 },
    { PATH: "/usr/bin:/bin", DOCKER_HOST: "unix:///attacker.sock" },
    { [Symbol("PATH")]: "/usr/bin:/bin" },
    Object.defineProperty({}, "PATH", { value: "/usr/bin:/bin" }),
  ];
  for (const environment of invalidEnvironments) {
    assert.throws(
      () => createKubeconformRunner({ environment, spawn: noSpawn }),
      (error) => {
        assert.equal(error.message, "Kubeconform runner dependencies are invalid");
        return true;
      },
    );
  }

  const nullPrototypeEnvironment = Object.create(null);
  nullPrototypeEnvironment.HOME = "/safe-home";
  nullPrototypeEnvironment.LANG = "C.UTF-8";
  nullPrototypeEnvironment.PATH = "/usr/bin:/bin";
  assert.equal(
    typeof createKubeconformRunner({
      environment: nullPrototypeEnvironment,
      spawn: successfulSpawn([]),
    }),
    "function",
  );
});

test("the runner rejects open options, unsupported versions, oversized input, and remote Docker", () => {
  const noSpawn = () => assert.fail("invalid input must fail before process creation");
  const validate = createKubeconformRunner({ environment: {}, spawn: noSpawn });
  assert.throws(() => validate("manifest", {}), /Kubernetes version/);
  assert.throws(
    () => validate("manifest", { kubeVersion: "1.34.9" }),
    /Kubernetes version/,
  );
  assert.throws(
    () => validate("manifest", { kubeVersion: "1.35.0", unknown: true }),
    /closed object/,
  );
  assert.throws(
    () => validate("x".repeat(8 * 1024 * 1024 + 1), { kubeVersion: "1.35.0" }),
    /input is invalid/,
  );
  assert.throws(() => createKubeconformRunner({ environment: {}, extra: true }), /closed object/);

  const remote = createKubeconformRunner({
    environment: {},
    spawn: () => ({
      status: 0,
      signal: null,
      stdout: '"tcp://remote.invalid:2375"\n',
      stderr: "",
    }),
  });
  assert.throws(
    () => remote("manifest", { kubeVersion: "1.35.0" }),
    /local Docker daemon/,
  );
});

test("closed runner and invocation options reject hidden keys, accessors, and proxies without executing traps", () => {
  let runnerGetterCalled = false;
  const runnerAccessor = {};
  Object.defineProperty(runnerAccessor, "spawn", {
    enumerable: true,
    get() {
      runnerGetterCalled = true;
      return successfulSpawn([]);
    },
  });
  assert.throws(() => createKubeconformRunner(runnerAccessor), /closed object/);
  assert.equal(runnerGetterCalled, false);

  const hiddenRunnerOption = {};
  Object.defineProperty(hiddenRunnerOption, "unexpected", { value: true });
  assert.throws(() => createKubeconformRunner(hiddenRunnerOption), /closed object/);
  assert.throws(
    () => createKubeconformRunner({ [Symbol("unexpected")]: true }),
    /closed object/,
  );

  let proxyTrapCalled = false;
  const proxyOptions = new Proxy({}, {
    getPrototypeOf() {
      proxyTrapCalled = true;
      return Object.prototype;
    },
  });
  assert.throws(() => createKubeconformRunner(proxyOptions), /closed object/);
  assert.equal(proxyTrapCalled, false);

  const validate = createKubeconformRunner({ environment: {}, spawn: successfulSpawn([]) });
  let invocationGetterCalled = false;
  const invocationAccessor = {};
  Object.defineProperty(invocationAccessor, "kubeVersion", {
    enumerable: true,
    get() {
      invocationGetterCalled = true;
      return "1.35.0";
    },
  });
  assert.throws(() => validate("manifest", invocationAccessor), /closed object/);
  assert.equal(invocationGetterCalled, false);

  const nullPrototypeOptions = Object.create(null);
  nullPrototypeOptions.environment = {};
  nullPrototypeOptions.spawn = successfulSpawn([]);
  assert.equal(typeof createKubeconformRunner(nullPrototypeOptions), "function");
});

test("process failures stay bounded and never expose manifests or subprocess diagnostics", () => {
  const sentinel = "manifest-secret-812407";
  let invocation = 0;
  const validate = createKubeconformRunner({
    environment: {},
    spawn: () => {
      invocation += 1;
      if (invocation === 1) {
        return {
          status: 0,
          signal: null,
          stdout: '"unix:///var/run/docker.sock"\n',
          stderr: "",
        };
      }
      return {
        status: 2,
        signal: null,
        stdout: "",
        stderr: `host diagnostic ${sentinel}`,
      };
    },
  });
  assert.throws(
    () => validate(sentinel, { kubeVersion: "1.35.0" }),
    (error) => {
      assert.equal(error.message, "Pinned kubeconform failed with unexpected status 2 (expected 0)");
      assert.equal(error.message.includes(sentinel), false);
      return true;
    },
  );
});

test("kubeconform JSON output is closed, bounded, and structurally validated", () => {
  assert.deepEqual(parseKubeconformOutput(validOutput), JSON.parse(validOutput));
  for (const invalid of [
    "",
    "[]",
    '{"resources":[],"summary":{"valid":0,"invalid":0,"errors":0,"skipped":0},"extra":true}',
    '{"resources":[{"filename":"stdin","kind":"ConfigMap","name":"x","version":"v1","status":"unknown","msg":""}],"summary":{"valid":1,"invalid":0,"errors":0,"skipped":0}}',
    '{"resources":[],"summary":{"valid":-1,"invalid":0,"errors":0,"skipped":0}}',
  ]) assert.throws(() => parseKubeconformOutput(invalid), /not safe JSON/);
});

test("kubeconform JSON output rejects duplicate keys at every parsed object boundary", () => {
  const ambiguousOutputs = [
    '{"resources":[],"summary":{"valid":9,"invalid":0,"errors":0,"skipped":0},"summa\\u0072y":{"valid":0,"invalid":0,"errors":0,"skipped":0}}',
    '{"resources":[{"filename":"stdin","kind":"ConfigMap","name":"x","version":"v1","status":"statusInvalid","status":"statusValid","msg":""}],"summary":{"valid":1,"invalid":0,"errors":0,"skipped":0}}',
    '{"resources":[],"summary":{"valid":9,"valid":0,"invalid":0,"errors":0,"skipped":0}}',
    '{"resources":[{"filename":"stdin","kind":"ConfigMap","name":"x","version":"v1","status":"statusInvalid","msg":"bad","validationErrors":[{"path":"/safe","path":"/ambiguous","msg":"bad"}]}],"summary":{"valid":0,"invalid":1,"errors":0,"skipped":0}}',
  ];
  for (const output of ambiguousOutputs) {
    assert.throws(() => parseKubeconformOutput(output), /not safe JSON/);
  }
});
