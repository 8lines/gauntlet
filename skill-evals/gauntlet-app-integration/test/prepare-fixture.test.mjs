import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const EVAL_ROOT = resolve(import.meta.dirname, "..");
const PREPARE = resolve(EVAL_ROOT, "prepare-fixture.mjs");
const FIXTURE_SUFFIX = `-suite-${process.pid}`;
const EXPECTED_RUNTIME_DEPENDENCY_PINS = {
  ajv: "8.20.0",
  "ajv-formats": "3.0.1",
  canonicalize: "4.0.0",
  "fast-deep-equal": "3.1.3",
  "fast-uri": "3.1.6",
  "json-schema-traverse": "1.0.0",
  "require-from-string": "2.0.2",
};

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

const sha256 = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function write(root, path, source) {
  const target = resolve(root, path);
  mkdirSync(resolve(target, ".."), { recursive: true });
  writeFileSync(target, source);
}

function prepare(scenario) {
  const result = spawnSync(process.execPath, [PREPARE, scenario], {
    encoding: "utf8",
    env: { ...process.env, TC_EVAL_FIXTURE_SUFFIX: FIXTURE_SUFFIX },
  });
  assert.equal(result.status, 0, result.stderr);
  const root = result.stdout.trim();
  assert.equal(readFileSync(resolve(root, "PROMPT.md"), "utf8"), readFileSync(resolve(EVAL_ROOT, "prompts", `${scenario}.md`), "utf8"));
  assert.equal(lstatSync(resolve(root, "PROMPT.md")).mode & 0o222, 0);
  return root;
}

function verify(root) {
  return spawnSync(process.execPath, [resolve(root, "verify.mjs")], { cwd: root, encoding: "utf8" });
}

function probe(root, key) {
  return spawnSync(process.execPath, [resolve(root, "verify.mjs"), "--probe", key], {
    cwd: root,
    encoding: "utf8",
    timeout: 180_000,
  });
}

function proveAll(root, keys) {
  for (const key of keys) {
    const result = probe(root, key);
    assert.equal(result.status, 0, `${key}: ${result.stderr}`);
    assert.match(result.stdout, new RegExp(`${key}: PASS`));
  }
}

function assertBoundedSyntheticEvidence(root, keys, { observationsOnly = false, expectedRuns = 1 } = {}) {
  const evidence = JSON.parse(readFileSync(resolve(root, "evidence.json"), "utf8"));
  assert.equal(evidence.scope, "synthetic-ephemeral-loopback-http");
  assert.equal(evidence.customerDeploymentVerified, false);
  assert.deepEqual(Object.keys(evidence.observations).sort(), [...keys].sort());
  for (const key of keys) {
    if (observationsOnly) assert.equal(key in evidence, false);
    else assert.equal(evidence[key], true);
    assert.equal(evidence.observations[key].passed, true);
    assert.ok(evidence.observations[key].httpExchanges > 0, `${key} must contain an observed HTTP exchange`);
    assert.equal(evidence.probeRuns[key], expectedRuns);
    assert.equal(evidence.observations[key].probeRun, expectedRuns);
    assert.equal(evidence.observationHistory[key].length, expectedRuns);
    assert.deepEqual(evidence.observationHistory[key].map(({ probeRun }) => probeRun),
      Array.from({ length: expectedRuns }, (_, index) => index + 1));
    assert.ok(["http-loopback", "configuration-and-http-loopback", "startup-guard"].includes(
      evidence.observations[key].evidenceType,
    ));
    assert.doesNotMatch(JSON.stringify(evidence.observations[key]), /:\d{4,5}\b/u, "ephemeral ports must not leak");
  }
}

function assertProbeReplayAndRejection(root, key, expectedRuns = 2) {
  const replay = probe(root, key);
  assert.equal(replay.status, 0, replay.stderr);
  const replayed = JSON.parse(readFileSync(resolve(root, "evidence.json"), "utf8"));
  assert.equal(replayed.probeRuns[key], expectedRuns, "a repeated probe must execute and replace its receipt");
  assert.equal(replayed.commands.filter((command) => command.includes(`--probe ${key} `)).length, 1);

  const beforeRejected = readFileSync(resolve(root, "evidence.json"), "utf8");
  for (const args of [["--probe", "unknown"], ["--probe", key, "extra"]]) {
    const rejected = spawnSync(process.execPath, [resolve(root, "verify.mjs"), ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.notEqual(rejected.status, 0, `arguments ${args.join(" ")} must be rejected`);
    assert.equal(readFileSync(resolve(root, "evidence.json"), "utf8"), beforeRejected, "rejected probe mutated evidence");
  }
}

test("Symfony fixture rejects the observed legacy-shaped false positive", () => {
  const root = prepare("valid-symfony");
  write(root, "composer.json", `${JSON.stringify({
    name: "synthetic/staging-portal",
    type: "project",
    require: {
      php: ">=8.3",
      "symfony/framework-bundle": "7.4.*",
      "8lines/gauntlet-php-core": "0.1.0",
      "8lines/gauntlet-symfony-bundle": "0.1.0",
    },
  }, null, 2)}\n`);
  write(root, "config/bundles.php", "<?php\nuse EightLines\\Gauntlet\\SymfonyBundle\\GauntletBundle;\nreturn [GauntletBundle::class => ['staging' => true]];\n");
  write(root, "config/packages/staging/gauntlet.yaml", [
    "gauntlet:", "  enabled: true", "  adapter:", "    id: portal", "    label: Portal",
    "  environment:", "    name: staging", "    kind: staging",
    "  idempotency_secret: '%env(GAUNTLET_IDEMPOTENCY_SECRET)%'", "",
  ].join("\n"));
  write(root, "config/routes/staging/gauntlet.yaml", "gauntlet:\n  resource: '@GauntletBundle/config/routes.php'\n  type: php\n");
  write(root, "gauntlet/config.yaml", [
    "targets:", "  - adapterUrl: http://portal.staging.svc.cluster.local:8080",
    "    environment:", "      name: staging", "      kind: staging",
    "    expectedEnvironment:", "      name: staging", "      kind: staging", "",
  ].join("\n"));
  const result = verify(root);
  assert.notEqual(result.status, 0, "legacy-shaped package and control-plane config must fail");

  write(root, "config/packages/staging/gauntlet.yaml", [
    "gauntlet:", "  enabled: true", "  application:", "    id: portal", "    label: Portal",
    "    environment:", "      name: staging", "      kind: staging",
    "  idempotency_secret: '%env(GAUNTLET_IDEMPOTENCY_SECRET)%'", "",
  ].join("\n"));
  write(root, "gauntlet/config.yaml", [
    "version: 1", "instance:", "  name: portal-staging", "  environment:",
    "    name: staging", "    kind: staging", "targets:", "  - id: portal", "    label: Portal",
    "    adapterUrl: http://portal.staging.svc.cluster.local:8080", "    expectedEnvironment:",
    "      name: staging", "      kind: staging", "",
  ].join("\n"));
  const correctedWithoutEvidence = verify(root);
  assert.notEqual(correctedWithoutEvidence.status, 0, "configuration alone must not masquerade as live evidence");

  const keys = ["disabled", "startupDenied", "mismatchDenied", "syntheticProtocolExercise", "publicRouteDenied"];
  proveAll(root, keys);
  proveAll(root, keys);
  assertBoundedSyntheticEvidence(root, keys, { observationsOnly: true, expectedRuns: 2 });
  const observed = JSON.parse(readFileSync(resolve(root, "evidence.json"), "utf8")).observations;
  assert.equal(observed.disabled.checks[0].matrix, "adapter-route-families");
  assert.equal(observed.disabled.checks[0].statuses[0], 503);
  assert.equal(observed.disabled.checks[0].mediaType, "application/problem+json");
  assert.equal(observed.startupDenied.checks[0].listenerStarts, 0);
  assert.equal(observed.startupDenied.checks[0].configurationCases.length, 9);
  assert.deepEqual(observed.startupDenied.checks.slice(1, 3).map(({ status }) => status), [404, 200]);
  assert.equal(observed.startupDenied.checks[3].startupDenials, 9);
  assert.equal(observed.startupDenied.checks[3].listenerStarts, 0);
  assert.ok(observed.mismatchDenied.checks.every(({ upstreamApplicationRequests }) => upstreamApplicationRequests === 0));
  assert.ok(observed.mismatchDenied.checks.every(({ routeFamilies }) => routeFamilies.length === 9));
  assert.deepEqual(observed.syntheticProtocolExercise.checks[1].environment, { name: "staging", kind: "staging" });
  assert.deepEqual(observed.syntheticProtocolExercise.checks[2], {
    operationDefinitionStatus: 200,
    staleRevisionStatus: 409,
    invalidInputStatus: 422,
    idempotentReplay: true,
    terminalState: "succeeded",
  });
  assert.deepEqual(observed.syntheticProtocolExercise.checks[3], {
    dataSourceQueryStatus: 200,
    dataSourceResolveStatus: 200,
  });
  assert.deepEqual(observed.publicRouteDenied.checks[0].statuses, Array(11).fill(404));
  const corrected = verify(root);
  assert.equal(corrected.status, 0, corrected.stderr);
  assertProbeReplayAndRejection(root, "disabled", 3);

  const forged = JSON.parse(readFileSync(resolve(root, "evidence.json"), "utf8"));
  delete forged.observations.disabled;
  forged.disabled = true;
  write(root, "evidence.json", `${JSON.stringify(forged, null, 2)}\n`);
  assert.notEqual(verify(root).status, 0, "a boolean without its observed network receipt must fail");
});

function legacyIntegratedNodeHostSourceSnapshot() {
  return [
    'import { readFileSync } from "node:fs";',
    'import { createServer } from "node:http";',
    'import { Readable } from "node:stream";',
    'import { pipeline } from "node:stream/promises";',
    'import { assertNonProductionEnvironment } from "@8lines/gauntlet-protocol";',
    'import {',
    '  AjvSchemaValidator, CapabilityRegistry, DataSourceRegistry, InMemoryRunStore,',
    '  OperationRegistry, RunManager, createAdapterCatalog, defineOperation,',
    '} from "@8lines/gauntlet-typescript-core";',
    'import { createAdapterFetchHandler, isAdapterTarget } from "@8lines/gauntlet-typescript-node";',
    '',
    'const prefix = "/_gauntlet/v1";',
    'const environment = assertNonProductionEnvironment({',
    '  name: process.env.GAUNTLET_ENVIRONMENT_NAME,',
    '  kind: process.env.GAUNTLET_ENVIRONMENT_KIND,',
    '});',
    'const secretPath = process.env.GAUNTLET_IDEMPOTENCY_SECRET_FILE;',
    'if (typeof secretPath !== "string" || secretPath.length === 0) throw new Error("secret-file reference required");',
    'const idempotencySecret = readFileSync(secretPath);',
    'if (idempotencySecret.byteLength < 32) throw new Error("stable idempotency secret must contain 32 bytes");',
    'const application = {',
    '  id: process.env.GAUNTLET_APPLICATION_ID,',
    '  label: process.env.GAUNTLET_APPLICATION_LABEL,',
    '  environment,',
    '};',
    'if (typeof application.id !== "string" || typeof application.label !== "string") throw new Error("application metadata required");',
    '',
    'const operations = new OperationRegistry();',
    'operations.registerFeature({ id: "fixture", label: "Fixture", order: 0 });',
    'let operationRuns = 0;',
    'let dataSourceQueries = 0;',
    'let dataSourceResolves = 0;',
    'let lastDataSourceQuery = null;',
    'let lastDataSourceResolve = null;',
    'operations.register(defineOperation({',
    '  id: "fixture.safe", featureId: "fixture", label: "Synthetic safe operation", order: 0, tags: [],',
    '  inputSchema: {',
    '    $schema: "https://json-schema.org/draft/2020-12/schema", type: "object",',
    '    required: ["value"], properties: { value: { type: "string", minLength: 1 } }, additionalProperties: false,',
    '  },',
    '  dataSources: [], presets: [],',
    '  execution: {',
    '    impact: "write", confirmationRequired: true, dryRunSupported: true,',
    '    idempotency: "required", cancellationSupported: false,',
    '  },',
    '  output: { schema: {',
    '    $schema: "https://json-schema.org/draft/2020-12/schema", type: "object",',
    '    required: ["accepted"], properties: { accepted: { type: "boolean" } }, additionalProperties: false,',
    '  } },',
    '}, async () => {',
    '  operationRuns += 1;',
    '  return { summary: { title: "Synthetic run completed", tone: "success" }, output: { accepted: true } };',
    '}));',
    '',
    'const dataSources = new DataSourceRegistry();',
    'dataSources.register({',
    '  definition: {',
    '    id: "fixture.items", label: "Synthetic items",',
    '    capabilities: { search: true, pagination: "cursor", resolve: true, defaultLimit: 10, maxLimit: 25 },',
    '  },',
    '  query: (input) => {',
    '    dataSourceQueries += 1;',
    '    lastDataSourceQuery = input;',
    '    return { items: [{ value: "item-1", label: "Synthetic item" }] };',
    '  },',
    '  resolve: (input) => {',
    '    dataSourceResolves += 1;',
    '    lastDataSourceResolve = input;',
    '    return { results: input.values.map((value) => ({',
    '      value, item: value === "item-1" ? { value, label: "Synthetic item" } : null,',
    '    })) };',
    '  },',
    '});',
    '',
    'const schemaValidator = new AjvSchemaValidator();',
    'const runs = new RunManager(operations, new InMemoryRunStore(), {',
    '  validateSchema: ({ schema, value }) => schemaValidator.validate(schema, value),',
    '  validateFileReference: () => [],',
    '  idempotencySecret,',
    '});',
    'const catalog = createAdapterCatalog({',
    '  application, profiles: ["tc-schema-core@1", "tc-rich-forms@1", "tc-rich-results@1"],',
    '  capabilities: new CapabilityRegistry(), operations, dataSources, runs, schemaValidator,',
    '});',
    'const adapter = createAdapterFetchHandler({',
    '  enabled: process.env.GAUNTLET_ENABLED === "true", catalog, schemaValidator,',
    '});',
    '',
    'async function sendWebResponse(response, outgoing, method) {',
    '  outgoing.writeHead(response.status, Object.fromEntries(response.headers));',
    '  if (response.body === null || method === "HEAD") return outgoing.end();',
    '  await pipeline(Readable.fromWeb(response.body), outgoing);',
    '}',
    '',
    'const server = createServer(async (incoming, outgoing) => {',
    '  try {',
    '    const rawTarget = incoming.url;',
    '    if (typeof rawTarget !== "string") return outgoing.writeHead(400, { "content-length": "0" }).end();',
    '    const requestTarget = rawTarget.startsWith("/") ? rawTarget : "/";',
    '    const request = new Request(`http://adapter${requestTarget}`, {',
    '      method: incoming.method, headers: incoming.headers,',
    '      body: ["GET", "HEAD"].includes(incoming.method ?? "") ? undefined : incoming, duplex: "half",',
    '    });',
    '    const response = await adapter({ kind: "raw", request, rawTarget });',
    '    const canonicalMount = rawTarget === prefix || rawTarget.startsWith(`${prefix}/`);',
    '    if (!canonicalMount && rawTarget.startsWith("/") && response.status === 404) {',
    '      await response.body?.cancel();',
    '      if (incoming.method === "GET" && rawTarget === "/__fixture/counters") {',
    '        outgoing.writeHead(200, { "content-type": "application/json" });',
    '        return outgoing.end(`${JSON.stringify({',
    '          operationRuns, dataSourceQueries, dataSourceResolves, lastDataSourceQuery, lastDataSourceResolve,',
    '        })}\\n`);',
    '      }',
    '      return outgoing.writeHead(404, { "content-type": "text/plain" }).end("Not Found\\n");',
    '    }',
    '    await sendWebResponse(response, outgoing, incoming.method);',
    '  } catch {',
    '    if (!outgoing.headersSent) outgoing.writeHead(500, { "content-length": "0" });',
    '    outgoing.end();',
    '  }',
    '});',
    'const generic400 = "HTTP/1.1 400 Bad Request\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n";',
    'function fixedProblem(status, type, title) {',
    '  const body = JSON.stringify({ type, title, status });',
    '  const reason = status === 400 ? "Bad Request" : "Service Unavailable";',
    '  return `HTTP/1.1 ${status} ${reason}\\r\\nContent-Type: application/problem+json; charset=utf-8\\r\\nContent-Length: ${Buffer.byteLength(body)}\\r\\nConnection: close\\r\\n\\r\\n${body}`;',
    '}',
    'function handleClientError(socket, packet, enabled) {',
    '  if (socket.destroyed || socket.writableEnded) return;',
    '  const bounded = packet?.subarray(0, 8192).toString("latin1") ?? "";',
    "  const requestTarget = /^[!#$%&'*+\\-.^_`|~0-9A-Za-z]+ ([^ \\t\\r\\n]{1,8192})(?:[ \\t]|$)/u.exec(bounded)?.[1];",
    '  const adapterPacket = requestTarget !== undefined && isAdapterTarget(requestTarget);',
    '  if (!adapterPacket) return socket.end(generic400);',
    '  socket.end(enabled',
    '    ? fixedProblem(400, "urn:gauntlet:problem:invalid-path", "Invalid path")',
    '    : fixedProblem(503, "urn:gauntlet:problem:adapter-disabled", "Adapter disabled"));',
    '}',
    'server.on("clientError", (error, socket) => handleClientError(socket, error.rawPacket, process.env.GAUNTLET_ENABLED === "true"));',
    'server.listen(Number(process.env.PORT ?? 8080), process.env.HOST ?? "127.0.0.1", () => {',
    '  const address = server.address();',
    '  if (address === null || typeof address === "string") throw new Error("listener unavailable");',
    '  process.stdout.write(`${JSON.stringify({ ready: true, port: address.port })}\\n`);',
    '});',
    'process.on("SIGTERM", () => server.close(() => process.exit(0)));',
    '',
  ].join("\n");
}

function integratedNodeHostSource() {
  return readFileSync(resolve(import.meta.dirname, "../forward-fixtures/compose/reference-server.mjs"), "utf8");
}

function configureComposeApplication(root, application, label) {
  const runtimeDependencyPins = JSON.parse(readFileSync(resolve(root, "artifacts/runtime-pins.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(resolve(root, `${application}/package.json`), "utf8"));
  manifest.dependencies = {
    "@8lines/gauntlet-protocol": "file:../artifacts/8lines-gauntlet-protocol-0.1.0.tgz",
    "@8lines/gauntlet-typescript-core": "file:../artifacts/8lines-gauntlet-typescript-core-0.1.0.tgz",
    "@8lines/gauntlet-typescript-node": "file:../artifacts/8lines-gauntlet-typescript-node-0.1.0.tgz",
  };
  write(root, `${application}/package.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  write(root, `${application}/pnpm-workspace.yaml`, [
    "packages:", "  - .", "overrides:",
    "  '@8lines/gauntlet-protocol': 'file:../artifacts/8lines-gauntlet-protocol-0.1.0.tgz'",
    "  '@8lines/gauntlet-typescript-core': 'file:../artifacts/8lines-gauntlet-typescript-core-0.1.0.tgz'",
    "  '@8lines/gauntlet-typescript-node': 'file:../artifacts/8lines-gauntlet-typescript-node-0.1.0.tgz'",
    ...Object.entries(runtimeDependencyPins).map(([name, version]) => `  ${name}: '${version}'`),
    "",
  ].join("\n"));
  write(root, `${application}/compose.yaml`, [
    "services:", `  ${application}:`, `    image: synthetic/${application}:staging`,
    "    environment:", "      GAUNTLET_ENABLED: 'true'",
    "      HOST: 0.0.0.0", "      PORT: '8080'",
    `      GAUNTLET_APPLICATION_ID: ${application}`, `      GAUNTLET_APPLICATION_LABEL: ${label}`,
    "      GAUNTLET_ENVIRONMENT_NAME: staging", "      GAUNTLET_ENVIRONMENT_KIND: staging",
    "      GAUNTLET_IDEMPOTENCY_SECRET_FILE: /run/secrets/gauntlet-idempotency",
    "    secrets:", "      - source: gauntlet-idempotency", "        target: gauntlet-idempotency",
    "    networks:", "      gauntlet:", "        aliases:", `          - small-apps-staging-${application}`,
    "secrets:", "  gauntlet-idempotency:", "    external: true",
    `    name: small-apps-staging-${application}-gauntlet-idempotency`,
    "networks:", "  gauntlet:", "    external: true", "    name: gauntlet", "",
  ].join("\n"));
}

test("Compose fixture rejects the observed incomplete standalone contract", () => {
  const root = prepare("valid-compose");
  const runtimePinsSource = readFileSync(resolve(root, "artifacts/runtime-pins.json"), "utf8");
  assert.equal(runtimePinsSource, `${JSON.stringify(EXPECTED_RUNTIME_DEPENDENCY_PINS, null, 2)}\n`,
    "runtime pins must be supplied visibly as canonical pretty JSON with one trailing LF");
  assert.deepEqual(JSON.parse(runtimePinsSource), EXPECTED_RUNTIME_DEPENDENCY_PINS);
  assert.equal(
    readFileSync(resolve(root, "reference/server.mjs"), "utf8"),
    integratedNodeHostSource(),
    "the exact golden call path must be visible in the generated fixture",
  );
  for (const application of ["billing", "portal"]) {
    const manifest = JSON.parse(readFileSync(resolve(root, `${application}/package.json`), "utf8"));
    assert.equal(manifest.type, "module");
    assert.equal(manifest.scripts?.build, "node scripts/build.mjs");
    assert.match(readFileSync(resolve(root, `${application}/src/server.mjs`), "utf8"), /host application is not integrated/u);
    assert.doesNotThrow(() => readFileSync(resolve(root, `${application}/scripts/build.mjs`), "utf8"));
    assert.throws(() => readFileSync(resolve(root, `${application}/adapter.json`), "utf8"));
  }
  for (const artifact of ["protocol", "typescript-core", "typescript-node"]) {
    const archive = resolve(root, `artifacts/8lines-gauntlet-${artifact}-0.1.0.tgz`);
    assert.deepEqual([...readFileSync(archive).subarray(0, 2)], [0x1f, 0x8b], `${artifact} must be a gzip archive`);
    const listed = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /^package\/package\.json$/m);
  }
  configureComposeApplication(root, "billing", "Billing");
  configureComposeApplication(root, "portal", "Portal");
  write(root, "gauntlet/compose.yaml", [
    "services:", "  gauntlet:", "    image: ghcr.io/8lines/gauntlet:0.1.0",
    "    environment:", "      GAUNTLET_CONFIG_FILE: /etc/gauntlet/config.yaml",
    "    ports:", "      - 127.0.0.1:8080:8080", "    volumes:",
    "      - ./config.yaml:/etc/gauntlet/config.yaml:ro", "    networks:", "      - gauntlet",
    "networks:", "  gauntlet:", "    external: true", "    name: gauntlet", "",
  ].join("\n"));
  write(root, "gauntlet/config.yaml", [
    "version: 1", "instance:", "  name: small-apps-staging", "  environment:",
    "    name: staging", "    kind: staging", "targets:",
    "  - id: billing", "    label: Billing", "    adapterUrl: http://small-apps-staging-billing:8080",
    "    expectedEnvironment:", "      name: staging", "      kind: staging",
    "  - id: portal", "    label: Portal", "    adapterUrl: http://small-apps-staging-portal:8080",
    "    expectedEnvironment:", "      name: staging", "      kind: staging", "",
  ].join("\n"));

  for (const application of ["billing", "portal"]) {
    write(root, `${application}/adapter.json`, `${JSON.stringify({
      mountedTransports: 1,
      prefix: "/_gauntlet/v1",
      environment: { name: "staging", kind: "staging" },
      idempotencySecretReference: "GAUNTLET_IDEMPOTENCY_SECRET_FILE",
    })}\n`);
  }
  const metadataOnly = probe(root, "disabled");
  assert.notEqual(metadataOnly.status, 0, "invented adapter metadata must not substitute for an executable SDK integration");

  for (const application of ["billing", "portal"]) {
    write(root, `${application}/src/server.mjs`, readFileSync(resolve(root, "reference/server.mjs"), "utf8"));
    write(root, `${application}/adapter.json`, "{ invalid metadata deliberately ignored\n");
    const installed = spawnSync("pnpm", ["install", "--offline", "--ignore-scripts", "--frozen-lockfile=false"], {
      cwd: resolve(root, application), encoding: "utf8", timeout: 60_000,
    });
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);
    const built = spawnSync("pnpm", ["run", "build"], {
      cwd: resolve(root, application), encoding: "utf8", timeout: 30_000,
    });
    assert.equal(built.status, 0, built.stderr || built.stdout);
  }
  const correctedWithoutEvidence = verify(root);
  assert.notEqual(correctedWithoutEvidence.status, 0, "configuration alone must not masquerade as live evidence");

  const keys = ["disabled", "mismatchDenied", "syntheticProtocolExercise", "adaptersUnpublished", "dashboardLoopbackOnly"];
  proveAll(root, keys);
  proveAll(root, keys);
  assertBoundedSyntheticEvidence(root, keys, { observationsOnly: true, expectedRuns: 2 });
  const receiptEnvelope = JSON.parse(readFileSync(resolve(root, "evidence.json"), "utf8"));
  assert.deepEqual(Object.keys(receiptEnvelope).sort(), [
    "commands", "customerDeploymentVerified", "minimumProbeRuns", "observations", "observationHistory", "probeRuns",
    "receiptMode", "requiredReceiptDigests", "scope", "selfHashMeaning",
  ].sort(), "observations-only receipt envelope must be closed");
  assert.deepEqual(receiptEnvelope.requiredReceiptDigests, [
    "configurationSha256", "runnerSha256", "runtimeArtifactsSha256", "runtimeDependencyTreesSha256",
    "dashboardClientTreeSha256", "protocolTreeSha256", "ajvTreeSha256",
    "ajvFormatsTreeSha256", "canonicalizeTreeSha256", "fastDeepEqualTreeSha256",
    "fastUriTreeSha256", "jsonSchemaTraverseTreeSha256", "requireFromStringTreeSha256",
    "yamlPackageSha256",
  ]);
  const observed = receiptEnvelope.observations;
  for (const receipt of Object.values(observed)) {
    assert.deepEqual(Object.keys(receipt).sort(), [
      "checks", "configurationSha256", "evidenceType", "httpExchanges", "observedAt", "passed",
      "previousReceiptSha256", "probeRun", "receiptSha256", "runnerSha256", "runtimeArtifactsSha256",
      "runtimeDependencyTreesSha256", "scope",
      "dashboardClientTreeSha256", "protocolTreeSha256", "ajvTreeSha256",
      "ajvFormatsTreeSha256", "canonicalizeTreeSha256", "fastDeepEqualTreeSha256",
      "fastUriTreeSha256", "jsonSchemaTraverseTreeSha256", "requireFromStringTreeSha256",
      "yamlPackageSha256",
    ].sort(), "observation receipt must be closed");
    for (const digest of receiptEnvelope.requiredReceiptDigests) {
      assert.match(receipt[digest], /^sha256:[0-9a-f]{64}$/u);
    }
    const { receiptSha256, ...canonicalPayload } = receipt;
    assert.equal(receiptSha256, sha256(canonicalJson(canonicalPayload)), "receipt hash must use canonical JSON");
  }
  const [disabledRoutes, disabledRawTargets, disabledBoundaries] = observed.disabled.checks;
  assert.equal(disabledRoutes.matrix, "disabled-adapter-route-families");
  assert.deepEqual(disabledRoutes.families, [
    "health", "manifest", "operation-definition", "operation-run", "run",
    "data-source-query", "data-source-resolve", "cancel", "events", "upload", "session-launch",
  ]);
  assert.deepEqual(disabledRoutes.applications.map(({ application }) => application), ["billing", "portal"]);
  assert.ok(disabledRoutes.applications.every(({ statuses }) => statuses.every((status) => status === 503)));
  assert.equal(disabledRawTargets.matrix, "disabled-raw-target-variants");
  assert.deepEqual(disabledRawTargets.rawTargets, [
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
  assert.ok(disabledRawTargets.applications.every(({ statuses }) => statuses.every((status) => status === 503)));
  assert.equal(disabledBoundaries.matrix, "host-and-client-error-boundaries");
  assert.equal(disabledBoundaries.malformedAdapterRequestLines.length, 10);
  assert.deepEqual(disabledBoundaries.exceptionalRequests.channels, [
    "trace", "track", "connect", "upgrade", "expectation",
  ]);
  assert.deepEqual(disabledBoundaries.exceptionalRequests.enabledStatuses, [405, 400, 405, 405, 417]);
  assert.deepEqual(disabledBoundaries.exceptionalRequests.unrelatedStatuses, [405, 400, 400, 400, 417]);
  for (const check of disabledBoundaries.applications) {
    assert.equal(check.hostFallback.status, 200);
    assert.deepEqual(check.clientErrorBoundary.adapterStatuses, Array(10).fill(503));
    assert.equal(check.clientErrorBoundary.unrelatedRequest.status, 400);
    assert.deepEqual(check.exceptionalBoundary.adapterStatuses, Array(5).fill(503));
    assert.deepEqual(check.exceptionalBoundary.unrelatedStatuses, [405, 400, 400, 400, 417]);
  }
  assert.equal(observed.mismatchDenied.checks.length, 4, "both apps and both environment axes must be denied");
  assert.deepEqual(new Set(observed.mismatchDenied.checks.map(({ application }) => application)), new Set(["billing", "portal"]));
  assert.deepEqual(new Set(observed.mismatchDenied.checks.map(({ mismatchAxis }) => mismatchAxis)), new Set(["name", "kind"]));
  for (const check of observed.mismatchDenied.checks) {
    assert.deepEqual(new Set(check.routeFamilies.map(({ proxyFamily }) => proxyFamily)), new Set([
      "operation-definition", "operation-run", "run", "upload", "cancel", "events",
      "data-source-query", "data-source-resolve", "session-launch",
    ]));
    assert.equal(check.status, 503);
    assert.equal(check.upstreamApplicationRequests, 0);
  }
  const protocolApplicationChecks = observed.syntheticProtocolExercise.checks.filter(({ application }) => application !== undefined);
  assert.deepEqual(protocolApplicationChecks.map(({ application }) => application), ["billing", "portal"]);
  for (const check of protocolApplicationChecks) {
    assert.equal(check.operationDefinitionStatus, 200);
    assert.equal(check.staleRevisionStatus, 409);
    assert.equal(check.invalidInputStatus, 422);
    assert.equal(check.idempotentReplay, true);
    assert.equal(check.terminalState, "succeeded");
    assert.equal(check.dataSourceQueryStatus, 200);
    assert.equal(check.dataSourceResolveStatus, 200);
    assert.equal(check.applicationOperationRuns, 1);
    assert.equal(check.operationInputMatched, true);
    assert.equal(check.applicationDataSourceQueries, 1);
    assert.equal(check.applicationDataSourceResolves, 1);
    assert.equal(check.dataSourceInputsMatched, true);
    assert.deepEqual(check.rawBoundary.statuses, Array(13).fill(400));
    assert.deepEqual(check.rawBoundary.malformedAdapter.statuses, Array(10).fill(400));
    assert.equal(check.rawBoundary.unrelatedMalformed.status, 400);
    assert.equal(check.rawBoundary.exceptionalRequestsMatched, true);
  }
  const rawBoundaryMatrix = observed.syntheticProtocolExercise.checks.find(({ matrix }) => matrix === "enabled-raw-and-client-error-targets");
  assert.equal(rawBoundaryMatrix.invalidRawTargets.length, 13);
  assert.equal(rawBoundaryMatrix.malformedAdapterRequestLines.length, 10);
  assert.deepEqual(rawBoundaryMatrix.exceptionalRequests.channels, [
    "trace", "track", "connect", "upgrade", "expectation",
  ]);
  assert.deepEqual(rawBoundaryMatrix.exceptionalRequests.adapterStatuses, [405, 400, 405, 405, 417]);
  assert.deepEqual(rawBoundaryMatrix.exceptionalRequests.unrelatedStatuses, [405, 400, 400, 400, 417]);
  assert.deepEqual(observed.adaptersUnpublished.checks.map(({ composeHostPorts }) => composeHostPorts), [0, 0]);
  assert.equal(observed.dashboardLoopbackOnly.checks[0].syntheticHarnessBind, "127.0.0.1");
  const corrected = verify(root);
  assert.equal(corrected.status, 0, corrected.stderr);
  assertProbeReplayAndRejection(root, "dashboardLoopbackOnly", 3);

  const receiptBeforeStaleMutation = readFileSync(resolve(root, "evidence.json"), "utf8");
  for (const mutation of [
    { path: "artifacts/runtime-pins.json", change: (source) => `${source}\n` },
    { path: "billing/compose.yaml", change: (source) => `${source}\n` },
    { path: "portal/dist/server.mjs", change: (source) => `${source}\n// stale runtime artifact\n` },
    { path: "portal/node_modules/@8lines/gauntlet-typescript-node/dist/adapter-handler.js", change: (source) => `${source}\n// stale loaded SDK module\n` },
    { path: "billing/node_modules/@8lines/gauntlet-typescript-core/package.json", change: (source) => `${source} ` },
    { path: "verify.mjs", change: (source) => `${source}\n// stale verifier revision\n` },
    { path: "artifacts/8lines-gauntlet-typescript-node-0.1.0.tgz", change: (source) => Buffer.concat([source, Buffer.from("stale")]) },
  ]) {
    const path = resolve(root, mutation.path);
    const original = readFileSync(path);
    write(root, mutation.path, mutation.change(mutation.path.endsWith(".tgz") ? original : original.toString("utf8")));
    assert.notEqual(verify(root).status, 0, `stale receipt must reject changed ${mutation.path}`);
    write(root, mutation.path, original);
    assert.equal(verify(root).status, 0, `restored ${mutation.path} must match the receipt again`);
  }
  const corePackage = realpathSync(resolve(root, "billing/node_modules/@8lines/gauntlet-typescript-core"));
  const ajvPackage = realpathSync(resolve(corePackage, "..", "..", "ajv"));
  const fastUriManifest = resolve(realpathSync(resolve(ajvPackage, "..", "fast-uri")), "package.json");
  const fastUriSource = readFileSync(fastUriManifest);
  writeFileSync(fastUriManifest, Buffer.concat([fastUriSource, Buffer.from(" ")]));
  assert.notEqual(verify(root).status, 0, "changed transitive runtime bytes must fail closed");
  writeFileSync(fastUriManifest, fastUriSource);
  assert.equal(verify(root).status, 0, "restored transitive runtime bytes must match the receipt");

  const unknownEnvelope = JSON.parse(receiptBeforeStaleMutation);
  unknownEnvelope.unexpected = true;
  write(root, "evidence.json", `${JSON.stringify(unknownEnvelope, null, 2)}\n`);
  assert.notEqual(verify(root).status, 0, "unknown receipt envelope fields must be rejected");
  const unknownObservation = JSON.parse(receiptBeforeStaleMutation);
  unknownObservation.observations.disabled.unexpected = "field";
  const { receiptSha256: _oldReceiptHash, ...unknownPayload } = unknownObservation.observations.disabled;
  unknownObservation.observations.disabled.receiptSha256 = sha256(canonicalJson(unknownPayload));
  write(root, "evidence.json", `${JSON.stringify(unknownObservation, null, 2)}\n`);
  assert.notEqual(verify(root).status, 0, "unknown observation fields must fail even with a recomputed canonical hash");
  write(root, "evidence.json", receiptBeforeStaleMutation);

  const builtEntryPath = "billing/dist/server.mjs";
  const builtEntry = readFileSync(resolve(root, builtEntryPath), "utf8");
  write(root, builtEntryPath, "this is not executable JavaScript {\n");
  const brokenRuntime = probe(root, "disabled");
  assert.notEqual(brokenRuntime.status, 0, "a probe must fail when the real built host cannot start");
  write(root, builtEntryPath, builtEntry);

  const adversarialConfigurations = [
    {
      name: "duplicate YAML key",
      path: "billing/compose.yaml",
      mutate: (source) => source.replace("services:\n", "services:\nservices:\n"),
    },
    {
      name: "unknown root key",
      path: "portal/compose.yaml",
      mutate: (source) => `${source}undocumented: true\n`,
    },
    {
      name: "wrongly nested secret-file setting",
      path: "billing/compose.yaml",
      mutate: (source) => source.replace("    secrets:\n", "    GAUNTLET_IDEMPOTENCY_SECRET_FILE: /tmp/wrong-level\n    secrets:\n"),
    },
    {
      name: "legacy inline secret environment value",
      path: "portal/compose.yaml",
      mutate: (source) => source.replace("      GAUNTLET_IDEMPOTENCY_SECRET_FILE:", "      GAUNTLET_IDEMPOTENCY_SECRET: plaintext-is-forbidden\n      GAUNTLET_IDEMPOTENCY_SECRET_FILE:"),
    },
    {
      name: "host network",
      path: "billing/compose.yaml",
      mutate: (source) => source.replace("    networks:\n", "    network_mode: host\n    networks:\n"),
    },
    {
      name: "privileged service",
      path: "portal/compose.yaml",
      mutate: (source) => source.replace("    networks:\n", "    privileged: true\n    networks:\n"),
    },
    {
      name: "wildcard dashboard port",
      path: "gauntlet/compose.yaml",
      mutate: (source) => source.replace("127.0.0.1:8080:8080", "0.0.0.0:8080:8080"),
    },
    {
      name: "missing private network alias",
      path: "billing/compose.yaml",
      mutate: (source) => source.replace("        aliases:\n          - small-apps-staging-billing\n", ""),
    },
    {
      name: "secret file source instead of external stable reference",
      path: "portal/compose.yaml",
      mutate: (source) => source.replace("    external: true\n    name: small-apps-staging-portal-gauntlet-idempotency", "    file: ./plaintext-secret\n    name: small-apps-staging-portal-gauntlet-idempotency"),
    },
  ];
  for (const attack of adversarialConfigurations) {
    const original = readFileSync(resolve(root, attack.path), "utf8");
    write(root, attack.path, attack.mutate(original));
    const rejected = verify(root);
    assert.notEqual(rejected.status, 0, `${attack.name} must be rejected semantically`);
    write(root, attack.path, original);
  }

  const forged = JSON.parse(readFileSync(resolve(root, "evidence.json"), "utf8"));
  forged.observations.dashboardLoopbackOnly.passed = false;
  forged.dashboardLoopbackOnly = true;
  write(root, "evidence.json", `${JSON.stringify(forged, null, 2)}\n`);
  assert.notEqual(verify(root).status, 0, "tampered observation must fail even when the boolean remains true");
});
