import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const EVAL_ROOT = resolve(import.meta.dirname, "..");
const PREPARE = resolve(EVAL_ROOT, "prepare-fixture.mjs");
const FIXTURE_SUFFIX = `-focused-${process.pid}`;
const ROOT = `/tmp/tc-eval-valid-symfony${FIXTURE_SUFFIX}`;
const PROBES = [
  "disabled",
  "startupDenied",
  "mismatchDenied",
  "syntheticProtocolExercise",
  "publicRouteDenied",
];

function write(path, source) {
  const target = resolve(ROOT, path);
  mkdirSync(resolve(target, ".."), { recursive: true });
  writeFileSync(target, source);
}

function run(...args) {
  return spawnSync(process.execPath, [resolve(ROOT, "verify.mjs"), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 180_000,
  });
}

function prepareValidSymfony() {
  const prepared = spawnSync(process.execPath, [PREPARE, "valid-symfony"], {
    encoding: "utf8",
    env: { ...process.env, TC_EVAL_FIXTURE_SUFFIX: FIXTURE_SUFFIX },
  });
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.equal(prepared.stdout.trim(), ROOT);
  const composer = JSON.parse(readFileSync(resolve(ROOT, "composer.json"), "utf8"));
  composer.require["8lines/gauntlet-php-core"] = "0.1.1";
  composer.require["8lines/gauntlet-symfony-bundle"] = "0.1.1";
  write("composer.json", `${JSON.stringify(composer, null, 2)}\n`);
  write("config/bundles.php", [
    "<?php",
    "",
    "use EightLines\\Gauntlet\\SymfonyBundle\\GauntletBundle;",
    "",
    "return [",
    "    GauntletBundle::class => ['staging' => true],",
    "];",
    "",
  ].join("\n"));
  write("config/packages/staging/gauntlet.yaml", [
    "gauntlet:",
    "  enabled: true",
    "  application:",
    "    id: portal",
    "    label: Portal",
    "    environment:",
    "      name: staging",
    "      kind: staging",
    "  idempotency_secret: '%env(GAUNTLET_IDEMPOTENCY_SECRET)%'",
    "",
  ].join("\n"));
  write("config/routes/staging/gauntlet.yaml", [
    "gauntlet:",
    "  resource: '@GauntletBundle/config/routes.php'",
    "  type: php",
    "",
  ].join("\n"));
  write("gauntlet/config.yaml", [
    "version: 1",
    "instance:",
    "  name: portal-staging",
    "  environment:",
    "    name: staging",
    "    kind: staging",
    "targets:",
    "  - id: portal",
    "    label: Portal",
    "    adapterUrl: http://portal.staging.svc.cluster.local:8080",
    "    expectedEnvironment:",
    "      name: staging",
    "      kind: staging",
    "",
  ].join("\n"));
  write("deployment/values.yaml", [
    "namespace: staging",
    "replicas: 1",
    "publicIngress:",
    "  adapterPrefixDenied: true",
    "privateAccess:",
    "  transport: tailscale-internal-alb",
    "runtime:",
    "  processModel: single-process",
    "  phpWorkers: 1",
    "  idempotencySecretReference: GAUNTLET_IDEMPOTENCY_SECRET",
    "  runStore: in-memory",
    "  coordinator: in-memory",
    "  dispatcher: current-process",
    "  eventHistory: in-memory",
    "",
  ].join("\n"));

  for (const [directory, name] of [
    ["gauntlet-php-core", "8lines/gauntlet-php-core"],
    ["gauntlet-symfony-bundle", "8lines/gauntlet-symfony-bundle"],
  ]) {
    const artifact = JSON.parse(readFileSync(resolve(ROOT, `artifacts/composer/8lines/${directory}/composer.json`), "utf8"));
    assert.equal(artifact.name, name);
    assert.equal(artifact.version, "0.1.1");
  }
  assert.equal(existsSync(resolve(ROOT, "runtime/examples/symfony/composer.lock")), true);
  assert.equal(existsSync(resolve(ROOT, "runtime/examples/symfony/src/Kernel.php")), true);
  assert.equal(existsSync(resolve(ROOT, "runtime/examples/symfony/probe.php")), true);
  assert.equal(existsSync(resolve(ROOT, "runtime/examples/symfony/vendor/autoload.php")), true);
  const verifier = readFileSync(resolve(ROOT, "verify.mjs"), "utf8");
  assert.match(verifier, /expectedSymfonyVendorHash = "sha256:[0-9a-f]{64}"/u);
  assert.match(verifier, /php:8\.3\.33-cli-bookworm@sha256:[0-9a-f]{64}/u);
  assert.doesNotMatch(verifier, /composer install/u);
  assert.doesNotMatch(verifier, /composer update/u);
}

test("Symfony verifier proves only a replayed single-process synthetic contract", () => {
  prepareValidSymfony();

  const help = run("--help");
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /syntheticProtocolExercise/u);
  assert.doesNotMatch(help.stdout, /liveConformance/u);
  assert.match(help.stdout, /run every probe twice/iu);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    for (const probe of PROBES) {
      const result = run("--probe", probe);
      assert.equal(result.status, 0, `${probe}: ${result.stderr}`);
      assert.match(result.stdout, new RegExp(`${probe}: PASS`, "u"));
    }
  }

  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /synthetic fixture contract verified; customer deployment not verified/u);

  const evidence = JSON.parse(readFileSync(resolve(ROOT, "evidence.json"), "utf8"));
  assert.equal(evidence.customerDeploymentVerified, false);
  assert.equal(evidence.selfHashMeaning, "integrity-only-not-trust-or-attestation");
  assert.deepEqual(evidence.requiredReceiptDigests, [
    "configurationSha256",
    "runnerSha256",
    "phpCoreArtifactSha256",
    "symfonyBundleArtifactSha256",
    "symfonyRuntimeSha256",
    "symfonyVendorSha256",
    "dashboardClientTreeSha256",
    "protocolTreeSha256",
    "ajvTreeSha256",
    "ajvFormatsTreeSha256",
    "canonicalizeTreeSha256",
    "fastDeepEqualTreeSha256",
    "fastUriTreeSha256",
    "jsonSchemaTraverseTreeSha256",
    "requireFromStringTreeSha256",
    "yamlPackageSha256",
  ]);
  assert.deepEqual(Object.keys(evidence.observations).sort(), [...PROBES].sort());
  assert.deepEqual(Object.keys(evidence.observationHistory).sort(), [...PROBES].sort());
  for (const probe of PROBES) {
    assert.equal(probe in evidence, false, "receipts must not be synthesized from top-level booleans");
    assert.equal(evidence.probeRuns[probe], 2);
    assert.equal(evidence.observations[probe].probeRun, 2);
    assert.equal(evidence.observationHistory[probe].length, 2);
    assert.deepEqual(evidence.observationHistory[probe].map(({ probeRun }) => probeRun), [1, 2]);
    assert.equal(evidence.observationHistory[probe][0].previousReceiptSha256, null);
    assert.equal(evidence.observationHistory[probe][1].previousReceiptSha256,
      evidence.observationHistory[probe][0].receiptSha256);
    assert.match(evidence.observations[probe].observedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
    assert.match(evidence.observations[probe].configurationSha256, /^sha256:[0-9a-f]{64}$/u);
    assert.match(evidence.observations[probe].runnerSha256, /^sha256:[0-9a-f]{64}$/u);
    assert.match(evidence.observations[probe].receiptSha256, /^sha256:[0-9a-f]{64}$/u);
  }
  assert.deepEqual(evidence.observations.syntheticProtocolExercise.checks.at(-1), {
    runtimeScope: "genuinely-single-process-synthetic",
    replicas: 1,
    phpWorkers: 1,
    runStore: "in-memory",
    coordinator: "in-memory",
    dispatcher: "current-process",
    eventHistory: "in-memory",
  });
  const realSymfony = evidence.observations.syntheticProtocolExercise.checks.find(
    ({ runtime }) => runtime === "composer-installed-symfony-kernel",
  );
  assert.deepEqual(realSymfony, {
    runtime: "composer-installed-symfony-kernel",
    kernelRequest: true,
    healthStatus: 200,
    manifestStatus: 200,
    environment: { name: "staging", kind: "staging" },
    phpVersion: "8.3.33",
    phpCoreVersion: "0.1.1",
    symfonyBundleVersion: "0.1.1",
  });
});

test("Symfony startup probe denies every missing identity and secret boundary before listening", () => {
  prepareValidSymfony();
  const result = run("--probe", "startupDenied");
  assert.equal(result.status, 0, result.stderr);

  const checks = JSON.parse(readFileSync(resolve(ROOT, "evidence.json"), "utf8"))
    .observations.startupDenied.checks;
  assert.equal(checks[0].runtime, "synthetic-js-startup-guard");
  assert.equal(checks[0].listenerStarts, 0);
  assert.deepEqual(checks[0].configurationCases, [
    "missing-id", "missing-label", "missing-environment", "missing-environment-name",
    "missing-environment-kind", "missing-secret", "short-secret",
    "production-name-colon-alias", "production-kind",
  ]);
  assert.deepEqual(checks[0].denialCodes, [
    "APPLICATION_ID_REQUIRED", "APPLICATION_LABEL_REQUIRED", "ENVIRONMENT_REQUIRED",
    "ENVIRONMENT_NAME_REQUIRED", "ENVIRONMENT_KIND_REQUIRED", "IDEMPOTENCY_SECRET_REQUIRED",
    "IDEMPOTENCY_SECRET_TOO_SHORT", "NON_PRODUCTION_ENVIRONMENT_REQUIRED",
    "NON_PRODUCTION_ENVIRONMENT_REQUIRED",
  ]);
  assert.deepEqual(checks.slice(1, 3).map(({ status }) => status), [404, 200]);
  assert.equal(checks[3].runtime, "composer-installed-symfony-kernel");
  assert.deepEqual(checks[3].configurationCases, [
    "missing-id",
    "missing-label",
    "missing-environment",
    "missing-environment-name",
    "missing-environment-kind",
    "missing-secret",
    "short-secret",
    "production-name",
    "production-kind",
  ]);
  assert.equal(checks[3].startupDenials, 9);
  assert.equal(checks[3].listenerStarts, 0);
  assert.ok(checks[3].errorClasses.length > 0);
});

test("Symfony target mismatch probe denies every proxy family for name-only and kind-only mismatches", () => {
  prepareValidSymfony();
  const result = run("--probe", "mismatchDenied");
  assert.equal(result.status, 0, result.stderr);

  const checks = JSON.parse(readFileSync(resolve(ROOT, "evidence.json"), "utf8"))
    .observations.mismatchDenied.checks;
  const proxyFamilies = [
    "operation-definition", "operation-run", "run", "upload", "cancel", "events",
    "data-source-query", "data-source-resolve", "session-launch",
  ];
  assert.equal(checks.length, 2);
  assert.deepEqual(checks.find(({ mismatch }) => mismatch === "name-only").routeFamilies.map(({ proxyFamily }) => proxyFamily), proxyFamilies);
  assert.deepEqual(checks.find(({ mismatch }) => mismatch === "kind-only").routeFamilies.map(({ proxyFamily }) => proxyFamily), proxyFamilies);
  assert.ok(checks.every(({ status, upstreamApplicationRequests }) => status === 503 && upstreamApplicationRequests === 0));
});

test("Symfony disabled and public gates cover every Adapter v1 transport family", () => {
  prepareValidSymfony();
  for (const probe of ["disabled", "publicRouteDenied"]) {
    const result = run("--probe", probe);
    assert.equal(result.status, 0, result.stderr);
  }

  const observations = JSON.parse(readFileSync(resolve(ROOT, "evidence.json"), "utf8")).observations;
  const expectedRequests = [
    "GET /_gauntlet/v1/health",
    "GET /_gauntlet/v1/manifest",
    "GET /_gauntlet/v1/operations/fixture.safe",
    "POST /_gauntlet/v1/operations/fixture.safe/runs",
    "GET /_gauntlet/v1/runs/synthetic-run",
    "POST /_gauntlet/v1/data-sources/fixture.items/query",
    "POST /_gauntlet/v1/data-sources/fixture.items/resolve",
    "POST /_gauntlet/v1/runs/synthetic-run/cancel",
    "GET /_gauntlet/v1/runs/synthetic-run/events",
    "POST /_gauntlet/v1/uploads",
    "POST /_gauntlet/v1/runs/synthetic-run/artifacts/synthetic-artifact/launch",
  ];
  const disabledRoutes = observations.disabled.checks.find(({ matrix }) => matrix === "adapter-route-families");
  const publicRoutes = observations.publicRouteDenied.checks.find(({ matrix }) => matrix === "adapter-route-families");
  assert.deepEqual(disabledRoutes.requests, expectedRequests);
  assert.deepEqual(disabledRoutes.statuses, Array(expectedRequests.length).fill(503));
  assert.deepEqual(publicRoutes.requests, expectedRequests);
  assert.deepEqual(publicRoutes.statuses, Array(expectedRequests.length).fill(404));
  assert.equal(publicRoutes.forwarded, false);
  const expectedDisabledVariants = [
    "GET /_gauntlet/v1/health",
    "GET /_gauntlet/v1/health/",
    "GET /_gauntlet//v1/health",
    "GET //_gauntlet/v1/health",
    "GET /_gauntlet%2fv1/health",
    "GET /%5Fgauntlet/v1/health",
    "GET /safe/../_gauntlet/v1/health",
    "GET /_gauntlet\\v1\\health",
    "GET http://public.invalid/_gauntlet/v1/health",
    "GET /_gauntlet/v1/operations/unsafe%ZZid",
  ];
  for (const probe of ["disabled", "publicRouteDenied"]) {
    const matrix = observations[probe].checks.find(({ matrix: name }) => name === "raw-target-variants");
    assert.ok(matrix, `${probe} must record a raw-target variant matrix`);
    const expectedVariants = probe === "disabled"
      ? expectedDisabledVariants
      : [...expectedDisabledVariants, "GET /_GAUNTLET/v1/health"];
    assert.deepEqual(matrix.requests, expectedVariants);
    assert.equal(matrix.forwarded, false);
    assert.deepEqual(matrix.statuses, Array(expectedVariants.length).fill(probe === "disabled" ? 503 : 404));
  }
});

test("Symfony verifier rejects unsupported consuming PHP and framework constraints", () => {
  for (const [dependency, version] of [["php", ">=9.0"], ["symfony/framework-bundle", "^8.0"]]) {
    prepareValidSymfony();
    const composer = JSON.parse(readFileSync(resolve(ROOT, "composer.json"), "utf8"));
    composer.require[dependency] = version;
    write("composer.json", `${JSON.stringify(composer, null, 2)}\n`);
    const rejected = run("--probe", "disabled");
    assert.notEqual(rejected.status, 0, `${dependency}=${version} must not satisfy the PHP 8.3/Symfony 7.4 fixture`);
  }
});

test("Symfony verifier rejects lexical decoys and structurally wrong YAML", () => {
  const cases = [
    ["comment-only bundle registration", "config/bundles.php", [
      "<?php",
      "// EightLines\\Gauntlet\\SymfonyBundle\\GauntletBundle",
      "// GauntletBundle::class => ['staging' => true]",
      "return [];",
      "",
    ].join("\n")],
    ["application metadata under a shadow node", "config/packages/staging/gauntlet.yaml", [
      "gauntlet:",
      "  enabled: true",
      "  application:",
      "  shadow:",
      "    id: portal",
      "    label: Portal",
      "    environment:",
      "      name: staging",
      "      kind: staging",
      "  idempotency_secret: '%env(GAUNTLET_IDEMPOTENCY_SECRET)%'",
      "",
    ].join("\n")],
    ["route fields under the wrong route", "config/routes/staging/gauntlet.yaml", [
      "not_gauntlet:",
      "  resource: '@GauntletBundle/config/routes.php'",
      "  type: php",
      "",
    ].join("\n")],
    ["an unapproved second control-plane target", "gauntlet/config.yaml", [
      "version: 1",
      "instance:",
      "  name: portal-staging",
      "  environment:",
      "    name: staging",
      "    kind: staging",
      "targets:",
      "  - id: portal",
      "    label: Portal",
      "    adapterUrl: http://portal.staging.svc.cluster.local:8080",
      "    expectedEnvironment:",
      "      name: staging",
      "      kind: staging",
      "  - id: shadow",
      "    label: Shadow",
      "    adapterUrl: https://public.example.invalid",
      "    expectedEnvironment:",
      "      name: staging",
      "      kind: staging",
      "",
    ].join("\n")],
    ["deployment values hidden below a decoy node", "deployment/values.yaml", [
      "decoy:",
      "  namespace: staging",
      "  replicas: 1",
      "  adapterPrefixDenied: true",
      "  transport: tailscale-internal-alb",
      "  processModel: single-process",
      "  phpWorkers: 1",
      "  idempotencySecretReference: GAUNTLET_IDEMPOTENCY_SECRET",
      "  runStore: in-memory",
      "  coordinator: in-memory",
      "  dispatcher: current-process",
      "  eventHistory: in-memory",
      "",
    ].join("\n")],
  ];

  const accepted = [];
  for (const [label, path, source] of cases) {
    prepareValidSymfony();
    write(path, source);
    if (run("--probe", "disabled").status === 0) accepted.push(label);
  }
  assert.deepEqual(accepted, [], `unsafe decoys accepted: ${accepted.join(", ")}`);
});

test("Symfony receipts become stale when a verified configuration changes", () => {
  prepareValidSymfony();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    for (const probe of PROBES) assert.equal(run("--probe", probe).status, 0);
  }
  const path = resolve(ROOT, "config/packages/staging/gauntlet.yaml");
  write("config/packages/staging/gauntlet.yaml", `${readFileSync(path, "utf8")}\n`);
  const stale = run();
  assert.notEqual(stale.status, 0, "receipts for prior configuration bytes must not verify");
  assert.match(stale.stderr, /stale receipt digest configurationSha256/u);

  write("config/packages/staging/gauntlet.yaml", readFileSync(path, "utf8").replace(/\n\n$/u, "\n"));
  assert.equal(run().status, 0, "restored configuration must match the receipt again");
  const vendorPath = "runtime/examples/symfony/vendor/8lines/gauntlet-symfony-bundle/src/Controller/V1/HealthAction.php";
  const vendorSource = readFileSync(resolve(ROOT, vendorPath), "utf8");
  write(vendorPath, `${vendorSource}\n// stale installed runtime\n`);
  const staleVendor = run();
  assert.notEqual(staleVendor.status, 0, "receipts for prior Composer-installed runtime bytes must not verify");
  assert.match(staleVendor.stderr, /Composer-installed runtime tree changed/u);
});
