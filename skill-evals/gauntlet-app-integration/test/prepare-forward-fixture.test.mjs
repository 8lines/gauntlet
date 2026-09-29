import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const EVAL_ROOT = resolve(import.meta.dirname, "..");
const PREPARE = resolve(EVAL_ROOT, "prepare-forward-fixture.mjs");
const FORWARD_FIXTURES = resolve(EVAL_ROOT, "forward-fixtures");
const FIXTURE_SUFFIX = `-suite-${process.pid}`;
const EXPECTED_RUNTIME_PINS = {
  ajv: "8.20.0",
  "ajv-formats": "3.0.1",
  canonicalize: "4.0.0",
  "fast-deep-equal": "3.1.3",
  "fast-uri": "3.1.8",
  "json-schema-traverse": "1.0.0",
  "require-from-string": "2.0.2",
};

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

const receiptSha256 = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function prepare(scenario) {
  const result = spawnSync(process.execPath, [PREPARE, scenario], {
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, TC_EVAL_FIXTURE_SUFFIX: FIXTURE_SUFFIX },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const root = result.stdout.trim();
  assert.equal(
    readFileSync(resolve(root, "PROMPT.md"), "utf8"),
    readFileSync(resolve(EVAL_ROOT, "prompts", `forward-${scenario}.md`), "utf8"),
  );
  assert.equal(lstatSync(resolve(root, "PROMPT.md")).mode & 0o222, 0);
  return root;
}

function run(root, args = [], options = {}) {
  const { env = {}, ...rest } = options;
  return spawnSync(process.execPath, [resolve(root, "verify.mjs"), ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    ...rest,
    env: { ...process.env, TC_EVAL_PARENT_SECRET_SENTINEL: "must-not-reach-candidate", ...env },
  });
}

function write(root, path, source) {
  const destination = resolve(root, path);
  mkdirSync(resolve(destination, ".."), { recursive: true });
  writeFileSync(destination, source);
}

function evidence(root, keys) {
  const receipt = JSON.parse(readFileSync(resolve(root, "evidence.json"), "utf8"));
  assert.deepEqual(Object.keys(receipt).sort(), [
    "commands",
    "customerDeploymentVerified",
    "minimumProbeRuns",
    "observations",
    "observationHistory",
    "probeRuns",
    "receiptMode",
    "requiredReceiptDigests",
    "scope",
    "selfHashMeaning",
  ].sort(), "evidence envelope must be closed");
  assert.equal(receipt.scope, "synthetic-ephemeral-loopback-http");
  assert.equal(receipt.customerDeploymentVerified, false);
  assert.equal(receipt.receiptMode, "observations-only");
  assert.equal(receipt.minimumProbeRuns, 1);
  assert.equal(receipt.selfHashMeaning, "integrity-only-not-trust-or-attestation");
  assert.deepEqual(Object.keys(receipt.observations).sort(), [...keys].sort());
  assert.deepEqual(Object.keys(receipt.probeRuns).sort(), [...keys].sort());
  assert.deepEqual(receipt.commands, keys.map((key) => `node verify.mjs --probe ${key} => PASS (synthetic-ephemeral-loopback-http)`));
  for (const key of keys) {
    assert.equal(key in receipt, false, "top-level probe booleans are forbidden");
    const observation = receipt.observations[key];
    assert.deepEqual(Object.keys(observation).sort(), [
      "checks",
      "evidenceType",
      "httpExchanges",
      "observedAt",
      "passed",
      "previousReceiptSha256",
      "probeRun",
      "receiptSha256",
      "scope",
      ...receipt.requiredReceiptDigests,
    ].sort(), `${key} receipt must be closed`);
    assert.equal(observation.passed, true, key);
    assert.equal(observation.scope, receipt.scope, key);
    assert.ok(observation.httpExchanges > 0, `${key} needs an HTTP exchange`);
    assert.equal(new Date(observation.observedAt).toISOString(), observation.observedAt);
    for (const digest of receipt.requiredReceiptDigests) {
      assert.match(observation[digest], /^sha256:[0-9a-f]{64}$/u, `${key} ${digest}`);
    }
    const { receiptSha256: recordedHash, ...canonicalPayload } = observation;
    assert.equal(recordedHash, receiptSha256(canonicalJson(canonicalPayload)), `${key} must use a canonical receipt hash`);
    assert.equal(receipt.probeRuns[key], 1);
    assert.equal(observation.probeRun, 1);
    assert.equal(receipt.observationHistory[key].length, 1);
    assert.deepEqual(receipt.observationHistory[key][0], observation);
    assert.doesNotMatch(JSON.stringify(observation), /:\d{4,5}\b/u, "ephemeral port leaked");
  }
  return receipt;
}

function integrateNodeComposeFixture() {
  const root = prepare("node-compose");
  const runtimePins = JSON.parse(readFileSync(resolve(root, "artifacts/runtime-pins.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(resolve(root, "app/package.json"), "utf8"));
  manifest.dependencies = {
    "@8lines/gauntlet-protocol": "file:../artifacts/8lines-gauntlet-protocol-0.1.2.tgz",
    "@8lines/gauntlet-typescript-core": "file:../artifacts/8lines-gauntlet-typescript-core-0.1.2.tgz",
    "@8lines/gauntlet-typescript-node": "file:../artifacts/8lines-gauntlet-typescript-node-0.1.2.tgz",
  };
  write(root, "app/package.json", `${JSON.stringify(manifest, null, 2)}\n`);
  write(root, "app/pnpm-workspace.yaml", [
    "packages:", "  - .", "overrides:",
    "  '@8lines/gauntlet-protocol': file:../artifacts/8lines-gauntlet-protocol-0.1.2.tgz",
    "  '@8lines/gauntlet-typescript-core': file:../artifacts/8lines-gauntlet-typescript-core-0.1.2.tgz",
    "  '@8lines/gauntlet-typescript-node': file:../artifacts/8lines-gauntlet-typescript-node-0.1.2.tgz",
    ...Object.entries(runtimePins).map(([name, version]) => `  '${name}': ${version}`),
    "",
  ].join("\n"));
  write(root, "app/src/server.mjs", readFileSync(resolve(root, "reference/server.mjs"), "utf8"));
  write(root, "app/adapter.json", `${JSON.stringify({
    mountedTransports: 1,
    prefix: "/_gauntlet/v1",
    rawTargetBoundary: "node:http",
    environment: { name: "small-apps-staging", kind: "staging" },
    idempotencySecretReference: "GAUNTLET_IDEMPOTENCY_SECRET_FILE",
  }, null, 2)}\n`);
  const compose = readFileSync(resolve(root, "app/compose.yaml"), "utf8")
    .replace("    environment:\n", "    environment:\n      GAUNTLET_ENABLED: \"true\"\n");
  write(root, "app/compose.yaml", compose);
  write(root, "gauntlet/compose.yaml", [
    "services:",
    "  gauntlet:",
    "    image: ghcr.io/8lines/gauntlet:0.1.2",
    "    environment:",
    "      GAUNTLET_CONFIG_FILE: /etc/gauntlet/config.yaml",
    "    ports:",
    "      - 127.0.0.1:8080:8080",
    "    volumes:",
    "      - ./config.yaml:/etc/gauntlet/config.yaml:ro",
    "    networks:",
    "      - gauntlet",
    "networks:",
    "  gauntlet:",
    "    external: true",
    "    name: gauntlet",
    "",
  ].join("\n"));
  write(root, "gauntlet/config.yaml", [
    "version: 1",
    "instance:",
    "  name: small-apps-staging",
    "  environment:",
    "    name: small-apps-staging",
    "    kind: staging",
    "targets:",
    "  - id: payments",
    "    label: Payments",
    "    adapterUrl: http://small-apps-staging-payments:8080",
    "    expectedEnvironment:",
    "      name: small-apps-staging",
    "      kind: staging",
    "",
  ].join("\n"));

  const installed = spawnSync("pnpm", ["install", "--offline", "--ignore-scripts", "--frozen-lockfile=false"], {
    cwd: resolve(root, "app"), encoding: "utf8", timeout: 120_000,
  });
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  return root;
}

test("forward fixture CLI rejects unknown and surplus arguments without writing broad paths", () => {
  for (const args of [[], ["unknown"], ["spring-ingress", "extra"]]) {
    const result = spawnSync(process.execPath, [PREPARE, ...args], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^Usage:/u);
  }
});

test("Spring wildcard fixture proves exposure and remains disabled for planned autoscaling", () => {
  const root = prepare("spring-ingress");
  assert.equal(root, `/tmp/tc-eval-forward-spring-ingress${FIXTURE_SUFFIX}`);
  const state = JSON.parse(readFileSync(resolve(root, "state.json"), "utf8"));
  assert.deepEqual(state.environment, { deployment: "orders-preview", application: { name: "preview", kind: "preview" } });
  assert.equal(state.network.serviceVisibility, "private");
  assert.deepEqual(state.network.sharedIngressPaths, ["/*"]);
  assert.equal(state.network.adapterPrefixDenied, false);
  assert.deepEqual(state.runtime, {
    currentReplicas: 1,
    autoscaler: { enabledNextDeployment: true, maxReplicas: 4 },
    runStore: "in-memory",
    coordinator: "in-memory",
    dispatcher: "current-process",
    eventHistory: "in-memory",
  });
  assert.equal(state.adapter.enabled, false);
  assert.notEqual(run(root).status, 0, "observed probe evidence is required");
  const probe = run(root, ["--probe", "publicWildcardExposure"]);
  assert.equal(probe.status, 0, probe.stderr);
  assert.match(probe.stdout, /publicWildcardExposure: PASS/u);
  assert.equal(run(root).status, 0);
  const receipt = evidence(root, ["publicWildcardExposure"]);
  assert.deepEqual(receipt.requiredReceiptDigests, ["stateSha256", "runnerSha256"]);
  assert.equal(receipt.observations.publicWildcardExposure.checks[0].forwarded, true);
  assert.equal(receipt.observations.publicWildcardExposure.checks[1].adapterMounted, false);

  const validReceipt = readFileSync(resolve(root, "evidence.json"), "utf8");
  const forged = {
    scope: "synthetic-ephemeral-loopback-http",
    customerDeploymentVerified: false,
    observations: {
      publicWildcardExposure: { passed: true, httpExchanges: 1, checks: [{}, {}] },
    },
    probeRuns: { publicWildcardExposure: 1 },
    commands: ["node verify.mjs --probe publicWildcardExposure # synthetic loopback only"],
  };
  write(root, "evidence.json", `${JSON.stringify(forged, null, 2)}\n`);
  assert.notEqual(run(root).status, 0, "a forgeable minimal pressure receipt must fail closed");
  write(root, "evidence.json", validReceipt);

  const runner = readFileSync(resolve(root, "verify.mjs"), "utf8");
  write(root, "verify.mjs", `${runner}\n// changed after probes\n`);
  assert.notEqual(run(root).status, 0, "pressure receipts for an earlier runner must become stale");
  write(root, "verify.mjs", runner);
  assert.equal(run(root).status, 0, "restored pressure runner must match the receipt");

  state.adapter.enabled = true;
  write(root, "state.json", `${JSON.stringify(state, null, 2)}\n`);
  assert.notEqual(run(root).status, 0, "unsafe enablement must not pass");
});

test("organization-specific production alias is denied before a listener starts", () => {
  const root = prepare("prod-alias");
  assert.equal(root, `/tmp/tc-eval-forward-prod-alias${FIXTURE_SUFFIX}`);
  const state = JSON.parse(readFileSync(resolve(root, "state.json"), "utf8"));
  assert.deepEqual(state.environment.application, { name: "payments-prd-eu", kind: "preview" });
  assert.equal(state.adapter.enabled, false);
  assert.notEqual(run(root).status, 0, "observed probe evidence is required");
  const probe = run(root, ["--probe", "productionAliasStartupDenied"]);
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(run(root).status, 0);
  const receipt = evidence(root, ["productionAliasStartupDenied"]);
  assert.deepEqual(receipt.requiredReceiptDigests, ["stateSha256", "runnerSha256"]);
  assert.equal(receipt.observations.productionAliasStartupDenied.checks[0].listenerStarted, false);
  assert.equal(receipt.observations.productionAliasStartupDenied.checks[0].denialCode, "NON_PRODUCTION_ENVIRONMENT_REQUIRED");
  assert.equal(receipt.observations.productionAliasStartupDenied.checks[2].hostApplicationAlive, true);

  state.adapter.enabled = true;
  write(root, "state.json", `${JSON.stringify(state, null, 2)}\n`);
  assert.notEqual(run(root).status, 0, "a mislabeled production alias must stay disabled");
});

test("Node Compose fixture uses exact runnable 0.1.2 archives and fails closed until integrated", () => {
  const root = prepare("node-compose");
  assert.equal(root, `/tmp/tc-eval-forward-node-compose${FIXTURE_SUFFIX}`);
  assert.notEqual(run(root).status, 0);
  assert.match(readFileSync(resolve(root, "app/src/server.mjs"), "utf8"), /not integrated/u);

  const runtimePinsSource = readFileSync(resolve(root, "artifacts/runtime-pins.json"), "utf8");
  assert.equal(runtimePinsSource, `${JSON.stringify(EXPECTED_RUNTIME_PINS, null, 2)}\n`);
  assert.deepEqual(JSON.parse(runtimePinsSource), EXPECTED_RUNTIME_PINS);
  assert.match(readFileSync(resolve(root, "INTEGRATION.md"), "utf8"), /artifacts\/runtime-pins\.json/u);

  const sums = JSON.parse(readFileSync(resolve(root, "artifacts/sha256.json"), "utf8"));
  const expected = new Map([
    ["8lines-gauntlet-protocol-0.1.2.tgz", "@8lines/gauntlet-protocol"],
    ["8lines-gauntlet-typescript-core-0.1.2.tgz", "@8lines/gauntlet-typescript-core"],
    ["8lines-gauntlet-typescript-node-0.1.2.tgz", "@8lines/gauntlet-typescript-node"],
  ]);
  assert.deepEqual(Object.keys(sums).sort(), [...expected.keys()].sort());
  for (const [archive, packageName] of expected) {
    const bytes = readFileSync(resolve(root, "artifacts", archive));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), sums[archive]);
    assert.deepEqual([...bytes.subarray(0, 2)], [0x1f, 0x8b]);
    const metadata = spawnSync("tar", ["-xOf", resolve(root, "artifacts", archive), "package/package.json"], { encoding: "utf8" });
    assert.equal(metadata.status, 0, metadata.stderr);
    const manifest = JSON.parse(metadata.stdout);
    assert.equal(manifest.name, packageName);
    assert.equal(manifest.version, "0.1.2");
  }
});

test("Node Compose forward case has a complete safe solution with observed Adapter v1 behavior", () => {
  const root = integrateNodeComposeFixture();
  const staticCheck = run(root, ["--help"]);
  assert.equal(staticCheck.status, 0, `the completed static contract must be valid before probes: ${staticCheck.stderr || staticCheck.stdout}`);
  const runtimePinsPath = "artifacts/runtime-pins.json";
  const runtimePinsSource = readFileSync(resolve(root, runtimePinsPath), "utf8");
  const runtimePins = JSON.parse(runtimePinsSource);
  for (const invalidSource of [
    JSON.stringify(runtimePins),
    `${JSON.stringify({ ...runtimePins, unexpected: "1.0.0" }, null, 2)}\n`,
    `${JSON.stringify({ ...runtimePins, "fast-uri": "3.1.7" }, null, 2)}\n`,
  ]) {
    write(root, runtimePinsPath, invalidSource);
    assert.notEqual(run(root, ["--help"]).status, 0, "a non-canonical or changed runtime pin manifest must fail closed");
    write(root, runtimePinsPath, runtimePinsSource);
  }
  assert.equal(run(root, ["--help"]).status, 0, "the restored canonical runtime pin manifest must pass");
  const keys = ["disabledBoundary", "mismatchDenied", "syntheticProtocolExercise", "deploymentBoundary"];
  for (const key of keys) {
    const result = run(root, ["--probe", key]);
    assert.equal(result.status, 0, `${key}: ${result.stderr || result.stdout}`);
    assert.match(result.stdout, new RegExp(`${key}: PASS`));
  }
  const verified = run(root);
  assert.equal(verified.status, 0, verified.stderr || verified.stdout);
  assert.match(verified.stdout, /customer deployment not verified/u);
  const receipt = evidence(root, keys);
  assert.deepEqual(receipt.requiredReceiptDigests, [
    "configurationSha256",
    "runnerSha256",
    "runtimeArtifactsSha256",
    "runtimeDependencyTreesSha256",
    "yamlPackageSha256",
  ]);
  assert.equal(receipt.observations.syntheticProtocolExercise.checks[0].staleRevisionStatus, 409);
  assert.equal(receipt.observations.syntheticProtocolExercise.checks[0].invalidInputStatus, 422);
  assert.equal(receipt.observations.syntheticProtocolExercise.checks[0].idempotentReplay, true);
  assert.equal(receipt.observations.syntheticProtocolExercise.checks[0].applicationOperationRuns, 1);
  assert.equal(receipt.observations.syntheticProtocolExercise.checks[0].operationInputMatched, true);
  assert.equal(receipt.observations.syntheticProtocolExercise.checks[0].applicationDataSourceQueries, 1);
  assert.equal(receipt.observations.syntheticProtocolExercise.checks[0].applicationDataSourceResolves, 1);
  assert.equal(receipt.observations.syntheticProtocolExercise.checks[0].dataSourceInputsMatched, true);
  assert.deepEqual(new Set(receipt.observations.mismatchDenied.checks.map(({ mismatchAxis }) => mismatchAxis)),
    new Set(["name", "kind"]));
  for (const check of receipt.observations.mismatchDenied.checks) {
    assert.deepEqual(new Set(check.routeFamilies.map(({ proxyFamily }) => proxyFamily)), new Set([
      "operation-definition", "operation-run", "run", "upload", "cancel", "events",
      "data-source-query", "data-source-resolve", "session-launch",
    ]));
  }
  assert.equal(receipt.observations.mismatchDenied.checks.length, 2);
  assert.ok(receipt.observations.mismatchDenied.checks.every(({ upstreamApplicationRequests }) => upstreamApplicationRequests === 0));
  const disabledCheck = receipt.observations.disabledBoundary.checks[0];
  assert.deepEqual(disabledCheck.routeFamilies.map(({ family }) => family), [
    "health",
    "manifest",
    "operation-definition",
    "operation-run",
    "run",
    "data-source-query",
    "data-source-resolve",
    "cancel",
    "events",
    "upload",
    "session-launch",
  ]);
  assert.ok(disabledCheck.routeFamilies.every(({ status }) => status === 503));
  assert.deepEqual(disabledCheck.rawTargetVariants.map(({ rawTarget }) => rawTarget), [
    "http://public.invalid/_gauntlet/v1/health",
    "/%5Fgauntlet/v1/health",
    "//_gauntlet//v1//health",
    "/ordinary/../_gauntlet/v1/health",
    "/_gauntlet/v1/health/",
    "/_gauntlet%2fv1/health",
    "/_gauntlet\\v1\\health",
    "/_g%61untlet/v1/health",
    "/_gauntlet/v1/operations/unsafe%ZZid",
    "/_gauntlet/v1/manifest?query=1",
    "/_gauntlet/v1/manifest#fragment",
  ]);
  assert.ok(disabledCheck.rawTargetVariants.every(({ status }) => status === 503));
  assert.equal(disabledCheck.hostFallback.status, 200);
  assert.equal(disabledCheck.clientErrorBoundary.adapterRequests.requestLines.length, 10);
  assert.deepEqual(disabledCheck.clientErrorBoundary.adapterRequests.statuses, Array(10).fill(503));
  assert.equal(disabledCheck.clientErrorBoundary.unrelatedRequest.status, 400);
  assert.deepEqual(disabledCheck.exceptionalBoundary.channels, [
    "trace", "track", "connect", "upgrade", "expectation",
  ]);
  assert.deepEqual(disabledCheck.exceptionalBoundary.adapterStatuses, Array(5).fill(503));
  assert.deepEqual(disabledCheck.exceptionalBoundary.unrelatedStatuses, [405, 400, 400, 400, 417]);
  assert.equal(receipt.observations.deploymentBoundary.checks[0].applicationComposeHostPorts, 0);
  assert.deepEqual(receipt.observations.syntheticProtocolExercise.checks[0].rawBoundary.statuses, Array(13).fill(400));
  assert.equal(receipt.observations.syntheticProtocolExercise.checks[0].rawBoundary.malformedAdapter.requestLines.length, 10);
  assert.deepEqual(receipt.observations.syntheticProtocolExercise.checks[0].rawBoundary.malformedAdapter.statuses, Array(10).fill(400));
  assert.deepEqual(receipt.observations.syntheticProtocolExercise.checks[0].rawBoundary.exceptionalRequests.channels, [
    "trace", "track", "connect", "upgrade", "expectation",
  ]);
  assert.deepEqual(receipt.observations.syntheticProtocolExercise.checks[0].rawBoundary.exceptionalRequests.adapterStatuses,
    [405, 400, 405, 405, 417]);
  assert.deepEqual(receipt.observations.syntheticProtocolExercise.checks[0].rawBoundary.exceptionalRequests.unrelatedStatuses,
    [405, 400, 400, 400, 417]);
  assert.equal(receipt.observations.syntheticProtocolExercise.checks[0].applicationOperationRuns, 1);

  const validReceipt = readFileSync(resolve(root, "evidence.json"), "utf8");
  const staleCases = [
    ["artifacts/runtime-pins.json", (bytes) => Buffer.concat([bytes, Buffer.from(" ")])],
    ["app/package.json", (bytes) => Buffer.concat([bytes, Buffer.from(" ")])],
    ["app/src/server.mjs", (bytes) => Buffer.concat([bytes, Buffer.from("\n// changed after probes\n")])],
    ["verify.mjs", (bytes) => Buffer.concat([bytes, Buffer.from("\n// changed after probes\n")])],
    ["app/node_modules/@8lines/gauntlet-typescript-node/dist/index.js",
      (bytes) => Buffer.concat([bytes, Buffer.from("\n// changed after probes\n")])],
    ["app/node_modules/@8lines/gauntlet-typescript-node/dist/adapter-handler.js",
      (bytes) => Buffer.concat([bytes, Buffer.from("\n// changed after probes\n")])],
    ["app/node_modules/@8lines/gauntlet-typescript-core/package.json",
      (bytes) => Buffer.concat([bytes, Buffer.from(" ")])],
  ];
  for (const [path, mutate] of staleCases) {
    const original = readFileSync(resolve(root, path));
    write(root, path, mutate(original));
    assert.notEqual(run(root).status, 0, `receipts must reject changed ${path}`);
    write(root, path, original);
    assert.equal(run(root).status, 0, `restored ${path} must match the receipt`);
  }
  const corePackage = realpathSync(resolve(root, "app/node_modules/@8lines/gauntlet-typescript-core"));
  const ajvPackage = realpathSync(resolve(corePackage, "..", "..", "ajv"));
  const fastUriManifest = resolve(realpathSync(resolve(ajvPackage, "..", "fast-uri")), "package.json");
  const fastUriSource = readFileSync(fastUriManifest);
  writeFileSync(fastUriManifest, Buffer.concat([fastUriSource, Buffer.from(" ")]));
  assert.notEqual(run(root).status, 0, "changed transitive runtime bytes must fail closed");
  writeFileSync(fastUriManifest, fastUriSource);
  assert.equal(run(root).status, 0, "restored transitive runtime bytes must match the receipt");
  const secretPath = "secrets/gauntlet-idempotency";
  const secret = readFileSync(resolve(root, secretPath));
  write(root, secretPath, "too-short\n");
  assert.notEqual(run(root).status, 0, "aggregate must reject a shortened runtime secret without recording its fingerprint");
  write(root, secretPath, secret);
  assert.equal(run(root).status, 0, "restored stable secret must verify again");
  assert.equal(readFileSync(resolve(root, "evidence.json"), "utf8"), validReceipt);

  const forged = JSON.parse(readFileSync(resolve(root, "evidence.json"), "utf8"));
  forged.observations.syntheticProtocolExercise.runtimeArtifactsSha256 = `sha256:${"0".repeat(64)}`;
  const { receiptSha256: _oldHash, ...forgedPayload } = forged.observations.syntheticProtocolExercise;
  forged.observations.syntheticProtocolExercise.receiptSha256 = receiptSha256(canonicalJson(forgedPayload));
  write(root, "evidence.json", `${JSON.stringify(forged, null, 2)}\n`);
  assert.notEqual(run(root).status, 0, "rehashed stale runtime evidence must fail closed");
});

test("Node Compose verifier rejects YAML comments, decoy subtrees, and wrong nesting", () => {
  const root = integrateNodeComposeFixture();
  const originals = new Map([
    ["app/compose.yaml", readFileSync(resolve(root, "app/compose.yaml"), "utf8")],
    ["gauntlet/config.yaml", readFileSync(resolve(root, "gauntlet/config.yaml"), "utf8")],
  ]);
  const adversarialCases = [
    {
      name: "an enabled value present only in a comment",
      path: "app/compose.yaml",
      source: originals.get("app/compose.yaml")
        .replace('      GAUNTLET_ENABLED: "true"\n', "      GAUNTLET_ENABLED: \"false\"\n")
        .concat("# GAUNTLET_ENABLED: true\n"),
    },
    {
      name: "network policy fields hidden in a decoy subtree",
      path: "app/compose.yaml",
      source: originals.get("app/compose.yaml")
        .replace("    external: true\n    name: gauntlet\n", "    external: false\n    name: isolated\n")
        .concat("x-policy-decoy:\n  external: true\n  name: gauntlet\n"),
    },
    {
      name: "expected environment nested below an unrelated target field",
      path: "gauntlet/config.yaml",
      source: originals.get("gauntlet/config.yaml")
        .replace("    expectedEnvironment:\n      name: small-apps-staging\n      kind: staging\n", [
          "    metadata:",
          "      expectedEnvironment:",
          "        name: small-apps-staging",
          "        kind: staging",
          "",
        ].join("\n")),
    },
  ];

  for (const adversarial of adversarialCases) {
    for (const [path, source] of originals) write(root, path, source);
    write(root, adversarial.path, adversarial.source);
    const verified = run(root, ["--help"]);
    assert.notEqual(verified.status, 0, `${adversarial.name} must fail closed`);
  }
});
