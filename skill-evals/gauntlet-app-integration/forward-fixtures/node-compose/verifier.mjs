import { createHash } from "node:crypto";
import { once } from "node:events";
import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { relative, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { parseDocument } from "__YAML_URL__";

const root = import.meta.dirname;
const scope = "synthetic-ephemeral-loopback-http";
const prefix = "/_gauntlet/v1";
const malformedAdapterTargets = [
  `${prefix}/manifest`,
  `http://attacker.invalid${prefix}/manifest`,
  "/%5Fgauntlet/v1/manifest",
  "/_gauntlet\\v1\\manifest",
  "/_g%61untlet/v1/manifest",
  "//_gauntlet//v1//manifest",
  "/ordinary/../_gauntlet/v1/manifest",
];
const malformedAdapterRequestLines = [
  ...malformedAdapterTargets.map((target) => `GET ${target}`),
  `get ${prefix}/manifest`,
  `CUSTOMMETHODEXTENSION ${prefix}/manifest`,
  `M-SEARCH ${prefix}/manifest`,
];
const exceptionalRequestCases = [
  {
    channel: "trace", adapterRequestLine: `TRACE ${prefix}/manifest HTTP/1.1`,
    unrelatedRequestLine: "TRACE /host-health HTTP/1.1", headers: ["Host: adapter", "Connection: close"],
    enabledStatus: 405, unrelatedStatus: 405,
  },
  {
    channel: "track", adapterRequestLine: `TRACK ${prefix}/manifest HTTP/1.1`,
    unrelatedRequestLine: "TRACK /host-health HTTP/1.1", headers: ["Host: adapter", "Connection: close"],
    enabledStatus: 400, unrelatedStatus: 400,
  },
  {
    channel: "connect", adapterRequestLine: `CONNECT ${prefix}/manifest HTTP/1.1`,
    unrelatedRequestLine: "CONNECT /host-health HTTP/1.1", headers: ["Host: adapter", "Connection: close"],
    enabledStatus: 405, unrelatedStatus: 400,
  },
  {
    channel: "upgrade", adapterRequestLine: `GET ${prefix}/manifest HTTP/1.1`,
    unrelatedRequestLine: "GET /host-health HTTP/1.1", headers: ["Host: adapter", "Connection: Upgrade", "Upgrade: synthetic"],
    enabledStatus: 405, unrelatedStatus: 400,
  },
  {
    channel: "expectation", adapterRequestLine: `GET ${prefix}/manifest HTTP/1.1`,
    unrelatedRequestLine: "GET /host-health HTTP/1.1", headers: ["Host: adapter", "Expect: synthetic", "Connection: close"],
    enabledStatus: 417, unrelatedStatus: 417,
  },
];
const probeKeys = ["disabledBoundary", "mismatchDenied", "syntheticProtocolExercise", "deploymentBoundary"];
const archiveHashes = __ARCHIVE_HASHES__;
const packageTreeHashes = __PACKAGE_TREE_HASHES__;
const expectedRuntimeDependencyHashes = __RUNTIME_DEPENDENCY_HASHES__;
const runtimeDependencyPins = __RUNTIME_DEPENDENCY_PINS__;
const yamlPackagePath = "__YAML_PACKAGE_PATH__";
const expectedYamlPackageSha256 = "__YAML_PACKAGE_SHA256__";
const requiredReceiptDigests = [
  "configurationSha256", "runnerSha256", "runtimeArtifactsSha256", "runtimeDependencyTreesSha256",
  "yamlPackageSha256",
];
const installedPackageNames = [
  "@8lines/gauntlet-protocol",
  "@8lines/gauntlet-typescript-core",
  "@8lines/gauntlet-typescript-node",
];
let httpExchanges = 0;

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const text = (path) => readFileSync(resolve(root, path), "utf8");
const json = (path) => JSON.parse(text(path));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonicalJson = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
};
const digest = (value) => `sha256:${sha256(value)}`;
const regularTreeSha256 = (directory, { excludeTopLevel = [] } = {}) => {
  const treeRoot = resolve(directory);
  const files = [];
  const excluded = new Set(excludeTopLevel);
  const visit = (current, depth = 0) => {
    for (const entry of readdirSync(current, { withFileTypes: true })
      .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)))) {
      if (depth === 0 && excluded.has(entry.name)) continue;
      const path = resolve(current, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`installed package contains a symbolic link: ${path}`);
      if (stat.isDirectory()) visit(path, depth + 1);
      else if (stat.isFile() && stat.nlink === 1) files.push(path);
      else throw new Error(`installed package contains a non-regular entry: ${path}`);
    }
  };
  visit(treeRoot);
  const hash = createHash("sha256");
  for (const path of files) {
    hash.update(relative(treeRoot, path).split(sep).join("/"));
    hash.update(Buffer.from([0]));
    hash.update(readFileSync(path));
    hash.update(Buffer.from([0]));
  }
  return `sha256:${hash.digest("hex")}`;
};
const digestFiles = (paths) => digest(canonicalJson(paths.map((path) => ({
  path,
  sha256: digest(readFileSync(resolve(root, path))),
}))));
const filesBelow = (directory) => {
  const files = [];
  const visit = (relative) => {
    const entries = readdirSync(resolve(root, directory, relative), { withFileTypes: true })
      .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const entry of entries) {
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) files.push(`${directory}/${child}`);
      else throw new Error(`installed package contains a non-regular entry: ${directory}/${child}`);
    }
  };
  visit("");
  return files;
};
const mapping = (value, label, expectedKeys) => {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be a mapping`);
  assert(
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expectedKeys].sort()),
    `${label} has missing or unknown keys`,
  );
  return value;
};
const sequence = (value, label, length) => {
  assert(Array.isArray(value) && value.length === length, `${label} must contain exactly ${length} entries`);
  return value;
};
const yaml = (path) => {
  const document = parseDocument(text(path), {
    merge: false,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  assert(document.errors.length === 0, `${path} is not strict YAML: ${document.errors[0]?.message ?? "unknown error"}`);
  assert(document.warnings.length === 0, `${path} contains ambiguous YAML`);
  try {
    return document.toJS({ maxAliasCount: 0, mapAsMap: false });
  } catch (error) {
    throw new Error(`${path} contains forbidden aliases: ${error instanceof Error ? error.message : "unknown error"}`);
  }
};
const assertEnvironment = (value, label) => {
  const environment = mapping(value, label, ["name", "kind"]);
  assert(environment.name === "small-apps-staging" && environment.kind === "staging", `${label} is not staging`);
};

const expectedRuntimeDependencyEdgeHashes = {
  "node->protocol": packageTreeHashes["@8lines/gauntlet-protocol"],
  "node->core": packageTreeHashes["@8lines/gauntlet-typescript-core"],
  "core->protocol": packageTreeHashes["@8lines/gauntlet-protocol"],
  "core->ajv": expectedRuntimeDependencyHashes.ajvTreeSha256,
  "core->ajv-formats": expectedRuntimeDependencyHashes.ajvFormatsTreeSha256,
  "core-ajv-formats->ajv": expectedRuntimeDependencyHashes.ajvTreeSha256,
  "protocol->ajv": expectedRuntimeDependencyHashes.ajvTreeSha256,
  "protocol->ajv-formats": expectedRuntimeDependencyHashes.ajvFormatsTreeSha256,
  "protocol-ajv-formats->ajv": expectedRuntimeDependencyHashes.ajvTreeSha256,
  "protocol->canonicalize": expectedRuntimeDependencyHashes.canonicalizeTreeSha256,
  "core-ajv->fast-deep-equal": expectedRuntimeDependencyHashes.fastDeepEqualTreeSha256,
  "core-ajv->fast-uri": expectedRuntimeDependencyHashes.fastUriTreeSha256,
  "core-ajv->json-schema-traverse": expectedRuntimeDependencyHashes.jsonSchemaTraverseTreeSha256,
  "core-ajv->require-from-string": expectedRuntimeDependencyHashes.requireFromStringTreeSha256,
  "protocol-ajv->fast-deep-equal": expectedRuntimeDependencyHashes.fastDeepEqualTreeSha256,
  "protocol-ajv->fast-uri": expectedRuntimeDependencyHashes.fastUriTreeSha256,
  "protocol-ajv->json-schema-traverse": expectedRuntimeDependencyHashes.jsonSchemaTraverseTreeSha256,
  "protocol-ajv->require-from-string": expectedRuntimeDependencyHashes.requireFromStringTreeSha256,
};
const installedRuntimeDependencyHashes = () => {
  const directProtocol = realpathSync(resolve(root, "app/node_modules/@8lines/gauntlet-protocol"));
  const directCore = realpathSync(resolve(root, "app/node_modules/@8lines/gauntlet-typescript-core"));
  const directNode = realpathSync(resolve(root, "app/node_modules/@8lines/gauntlet-typescript-node"));
  const scopedDependency = (packageRoot, name) => realpathSync(resolve(packageRoot, "..", "..", name));
  const plainDependency = (packageRoot, name) => realpathSync(resolve(packageRoot, "..", name));
  const nodeProtocol = scopedDependency(directNode, "@8lines/gauntlet-protocol");
  const nodeCore = scopedDependency(directNode, "@8lines/gauntlet-typescript-core");
  const coreProtocol = scopedDependency(directCore, "@8lines/gauntlet-protocol");
  const coreAjv = scopedDependency(directCore, "ajv");
  const coreAjvFormats = scopedDependency(directCore, "ajv-formats");
  const protocolAjv = scopedDependency(directProtocol, "ajv");
  const protocolAjvFormats = scopedDependency(directProtocol, "ajv-formats");
  const edges = {
    "node->protocol": nodeProtocol,
    "node->core": nodeCore,
    "core->protocol": coreProtocol,
    "core->ajv": coreAjv,
    "core->ajv-formats": coreAjvFormats,
    "core-ajv-formats->ajv": plainDependency(coreAjvFormats, "ajv"),
    "protocol->ajv": protocolAjv,
    "protocol->ajv-formats": protocolAjvFormats,
    "protocol-ajv-formats->ajv": plainDependency(protocolAjvFormats, "ajv"),
    "protocol->canonicalize": scopedDependency(directProtocol, "canonicalize"),
    "core-ajv->fast-deep-equal": plainDependency(coreAjv, "fast-deep-equal"),
    "core-ajv->fast-uri": plainDependency(coreAjv, "fast-uri"),
    "core-ajv->json-schema-traverse": plainDependency(coreAjv, "json-schema-traverse"),
    "core-ajv->require-from-string": plainDependency(coreAjv, "require-from-string"),
    "protocol-ajv->fast-deep-equal": plainDependency(protocolAjv, "fast-deep-equal"),
    "protocol-ajv->fast-uri": plainDependency(protocolAjv, "fast-uri"),
    "protocol-ajv->json-schema-traverse": plainDependency(protocolAjv, "json-schema-traverse"),
    "protocol-ajv->require-from-string": plainDependency(protocolAjv, "require-from-string"),
  };
  return Object.fromEntries(Object.entries(edges)
    .map(([edge, path]) => [edge, regularTreeSha256(path, { excludeTopLevel: ["node_modules"] })]));
};

const currentReceiptDigests = () => ({
  configurationSha256: digestFiles([
    "artifacts/runtime-pins.json",
    "app/package.json",
    "app/pnpm-workspace.yaml",
    "app/pnpm-lock.yaml",
    "app/adapter.json",
    "app/compose.yaml",
    "reference/server.mjs",
    "gauntlet/compose.yaml",
    "gauntlet/config.yaml",
  ]),
  runnerSha256: digest(readFileSync(import.meta.filename)),
  runtimeArtifactsSha256: digestFiles([
    "app/src/server.mjs",
    "app/src/catalog.mjs",
    "artifacts/8lines-gauntlet-protocol-0.1.4.tgz",
    "artifacts/8lines-gauntlet-typescript-core-0.1.4.tgz",
    "artifacts/8lines-gauntlet-typescript-node-0.1.4.tgz",
    ...installedPackageNames.flatMap((name) => filesBelow(`app/node_modules/${name}`)),
  ]),
  runtimeDependencyTreesSha256: digest(canonicalJson(installedRuntimeDependencyHashes())),
  yamlPackageSha256: regularTreeSha256(yamlPackagePath),
});

function assertStaticContract() {
  assert(regularTreeSha256(yamlPackagePath) === expectedYamlPackageSha256,
    "semantic YAML parser bytes changed");
  const runtimePinsSource = text("artifacts/runtime-pins.json");
  const declaredRuntimePins = mapping(
    json("artifacts/runtime-pins.json"),
    "runtime dependency pins",
    Object.keys(runtimeDependencyPins),
  );
  assert(runtimePinsSource === `${JSON.stringify(runtimeDependencyPins, null, 2)}\n`,
    "runtime dependency pins must use the supplied canonical JSON bytes");
  assert(canonicalJson(declaredRuntimePins) === canonicalJson(runtimeDependencyPins),
    "runtime dependency pins differ from the trusted fixture versions");
  const secretPath = resolve(root, "secrets/gauntlet-idempotency");
  const secretStat = lstatSync(secretPath);
  assert(secretStat.isFile() && secretStat.nlink === 1
    && readFileSync(secretPath).byteLength >= 32, "stable synthetic secret file is missing or too short");
  for (const [archive, expectedHash] of Object.entries(archiveHashes)) {
    const path = resolve(root, "artifacts", archive);
    assert(sha256(readFileSync(path)) === expectedHash, `supplied candidate archive changed: ${archive}`);
    const metadata = spawnSync("tar", ["-xOf", path, "package/package.json"], { encoding: "utf8" });
    assert(metadata.status === 0, `supplied candidate archive is unreadable: ${archive}`);
    const packageMetadata = JSON.parse(metadata.stdout);
    assert(packageMetadata.version === "0.1.4", `supplied candidate archive version changed: ${archive}`);
  }
  assert(canonicalJson(installedRuntimeDependencyHashes()) === canonicalJson(expectedRuntimeDependencyEdgeHashes),
    "installed runtime import-edge bytes differ from the trusted fixture dependency graph");
  const manifest = json("app/package.json");
  const dependencies = {
    "@8lines/gauntlet-protocol": "file:../artifacts/8lines-gauntlet-protocol-0.1.4.tgz",
    "@8lines/gauntlet-typescript-core": "file:../artifacts/8lines-gauntlet-typescript-core-0.1.4.tgz",
    "@8lines/gauntlet-typescript-node": "file:../artifacts/8lines-gauntlet-typescript-node-0.1.4.tgz",
  };
  assert(Object.keys(manifest.dependencies ?? {}).length === Object.keys(dependencies).length, "unexpected SDK dependency set");
  for (const [name, specifier] of Object.entries(dependencies)) {
    assert(manifest.dependencies?.[name] === specifier, `exact 0.1.4 SDK archive missing: ${name}`);
    const installed = json(`app/node_modules/${name}/package.json`);
    assert(installed.name === name && installed.version === "0.1.4", `installed SDK is not exact 0.1.4: ${name}`);
    assert(regularTreeSha256(resolve(root, `app/node_modules/${name}`), { excludeTopLevel: ["node_modules"] }) === packageTreeHashes[name],
      `installed SDK bytes differ from the packed archive: ${name}`);
  }
  const workspace = mapping(yaml("app/pnpm-workspace.yaml"), "pnpm workspace", ["packages", "overrides"]);
  assert(JSON.stringify(sequence(workspace.packages, "pnpm workspace packages", 1)) === JSON.stringify(["."]),
    "pnpm workspace must contain only the synthetic application");
  const expectedOverrides = { ...dependencies, ...runtimeDependencyPins };
  const overrides = mapping(workspace.overrides, "pnpm workspace overrides", Object.keys(expectedOverrides));
  for (const [name, specifier] of Object.entries(dependencies)) {
    assert(overrides[name] === specifier, `transitive SDK override missing: ${name}`);
  }
  for (const [name, version] of Object.entries(runtimeDependencyPins)) {
    assert(overrides[name] === version, `runtime dependency override missing: ${name}`);
  }
  assert(/8lines-gauntlet-typescript-node-0\.1\.4\.tgz/u.test(text("app/pnpm-lock.yaml")), "offline lockfile does not bind the Node SDK archive");

const source = text("app/src/server.mjs");
  assert(sha256(source) === "__GOLDEN_SERVER_SHA256__",
    "application must use the reviewed golden synthetic SDK call path");
  assert(source === text("reference/server.mjs"),
    "application must use the supplied transparent synthetic reference server");
  assert(sha256(text("app/src/catalog.mjs")) === "__GOLDEN_CATALOG_SHA256__",
    "application must use the reviewed secret-aware Core runtime catalog");
  assert((source.match(/createAdapterFetchHandler\s*\(/gu) ?? []).length === 1, "exactly one adapter transport is required");
  assert(/const\s+rawTarget\s*=\s*incoming\.url/u.test(source), "raw target must be captured at the Node server boundary");
  assert(/handler\s*\(\s*\{\s*kind:\s*["']raw["'][\s\S]*?rawTarget/u.test(source), "raw-target handler invocation missing");
  assert(source.indexOf("await handler") >= 0
    && source.indexOf("await handler") < source.lastIndexOf("serveApplication(incoming, outgoing)"),
  "adapter handler must run before the host router");
  const adapter = json("app/adapter.json");
  assert(adapter.mountedTransports === 1 && adapter.prefix === prefix && adapter.rawTargetBoundary === "node:http",
    "normalized one-transport metadata missing");
  assert(adapter.environment?.name === "small-apps-staging" && adapter.environment?.kind === "staging",
    "adapter environment missing");
  assert(adapter.idempotencySecretReference === "GAUNTLET_IDEMPOTENCY_SECRET_FILE", "stable secret reference missing");

  const appCompose = mapping(yaml("app/compose.yaml"), "application Compose root", ["services", "secrets", "networks"]);
  const appServices = mapping(appCompose.services, "application Compose services", ["payments"]);
  const appService = mapping(appServices.payments, "payments service", ["image", "environment", "secrets", "networks"]);
  assert(appService.image === "synthetic/payments:staging", "payments image is not pinned");
  const appEnvironment = mapping(appService.environment, "payments environment", [
    "HOST",
    "PORT",
    "GAUNTLET_ENABLED",
    "GAUNTLET_APPLICATION_ID",
    "GAUNTLET_APPLICATION_LABEL",
    "GAUNTLET_ENVIRONMENT_NAME",
    "GAUNTLET_ENVIRONMENT_KIND",
    "GAUNTLET_IDEMPOTENCY_SECRET_FILE",
  ]);
  assert(appEnvironment.HOST === "0.0.0.0" && appEnvironment.PORT === "8080",
    "private container listener must match the target port");
  assert(appEnvironment.GAUNTLET_ENABLED === "true", "adapter is not explicitly enabled for staging");
  assert(appEnvironment.GAUNTLET_APPLICATION_ID === "payments", "application id mismatch");
  assert(appEnvironment.GAUNTLET_APPLICATION_LABEL === "Payments", "application label mismatch");
  assert(appEnvironment.GAUNTLET_ENVIRONMENT_NAME === "small-apps-staging"
    && appEnvironment.GAUNTLET_ENVIRONMENT_KIND === "staging", "adapter environment mismatch");
  assert(appEnvironment.GAUNTLET_IDEMPOTENCY_SECRET_FILE === "/run/secrets/gauntlet_idempotency",
    "secret-file environment missing");
  const appSecretMount = mapping(sequence(appService.secrets, "payments service secrets", 1)[0],
    "payments secret mount", ["source", "target"]);
  assert(appSecretMount.source === "gauntlet_idempotency" && appSecretMount.target === "gauntlet_idempotency",
    "Compose secret mount missing");
  const appServiceNetworks = mapping(appService.networks, "payments service networks", ["gauntlet"]);
  const appAttachedNetwork = mapping(appServiceNetworks["gauntlet"], "payments Gauntlet network", ["aliases"]);
  assert(JSON.stringify(sequence(appAttachedNetwork.aliases, "payments network aliases", 1))
    === JSON.stringify(["small-apps-staging-payments"]), "private network alias mismatch");
  const appSecrets = mapping(appCompose.secrets, "application Compose secrets", ["gauntlet_idempotency"]);
  const appSecret = mapping(appSecrets.gauntlet_idempotency, "application secret", ["file"]);
  assert(appSecret.file === "../secrets/gauntlet-idempotency", "stable Compose secret source missing");
  const appNetworks = mapping(appCompose.networks, "application Compose networks", ["gauntlet"]);
  const appNetwork = mapping(appNetworks["gauntlet"], "application external network", ["external", "name"]);
  assert(appNetwork.external === true && appNetwork.name === "gauntlet", "external Gauntlet network missing");

  const controlCompose = mapping(yaml("gauntlet/compose.yaml"), "dashboard Compose root", ["services", "networks"]);
  const controlServices = mapping(controlCompose.services, "dashboard Compose services", ["gauntlet"]);
  const controlService = mapping(controlServices["gauntlet"], "dashboard service",
    ["image", "environment", "ports", "volumes", "networks"]);
  assert(controlService.image === "ghcr.io/8lines/gauntlet:0.1.4", "exact standalone image missing");
  const controlEnvironment = mapping(controlService.environment, "dashboard environment", ["GAUNTLET_CONFIG_FILE"]);
  assert(controlEnvironment.GAUNTLET_CONFIG_FILE === "/etc/gauntlet/config.yaml", "control config selector missing");
  assert(JSON.stringify(sequence(controlService.ports, "dashboard ports", 1)) === JSON.stringify(["127.0.0.1:8080:8080"]),
    "dashboard is not loopback-only");
  assert(JSON.stringify(sequence(controlService.volumes, "dashboard volumes", 1))
    === JSON.stringify(["./config.yaml:/etc/gauntlet/config.yaml:ro"]), "dashboard config mount mismatch");
  assert(JSON.stringify(sequence(controlService.networks, "dashboard networks", 1)) === JSON.stringify(["gauntlet"]),
    "dashboard Gauntlet network attachment missing");
  const controlNetworks = mapping(controlCompose.networks, "dashboard Compose networks", ["gauntlet"]);
  const controlNetwork = mapping(controlNetworks["gauntlet"], "dashboard external network", ["external", "name"]);
  assert(controlNetwork.external === true && controlNetwork.name === "gauntlet", "dashboard external network missing");

  const control = mapping(yaml("gauntlet/config.yaml"), "control-plane config", ["version", "instance", "targets"]);
  assert(control.version === 1, "control-plane config version must be 1");
  const instance = mapping(control.instance, "control-plane instance", ["name", "environment"]);
  assert(instance.name === "small-apps-staging", "control-plane instance name mismatch");
  assertEnvironment(instance.environment, "control-plane environment");
  const target = mapping(sequence(control.targets, "control-plane targets", 1)[0], "payments target",
    ["id", "label", "adapterUrl", "expectedEnvironment"]);
  assert(target.id === "payments" && target.label === "Payments", "explicit target identity mismatch");
  const expectedOrigin = "http://small-apps-staging-payments:8080";
  assert(target.adapterUrl === expectedOrigin, "explicit target adapter origin mismatch");
  const parsedTarget = new URL(target.adapterUrl);
  assert(parsedTarget.origin === expectedOrigin && parsedTarget.pathname === "/" && parsedTarget.search === ""
    && parsedTarget.hash === "" && parsedTarget.username === "" && parsedTarget.password === "",
  "adapterUrl must be a bare private origin");
  assertEnvironment(target.expectedEnvironment, "target expected environment");
}

function blankEvidence() {
  return {
    scope,
    customerDeploymentVerified: false,
    receiptMode: "observations-only",
    minimumProbeRuns: 1,
    selfHashMeaning: "integrity-only-not-trust-or-attestation",
    requiredReceiptDigests,
    observations: {},
    observationHistory: {},
    probeRuns: {},
    commands: [],
  };
}

function assertInitialEvidence(receipt) {
  mapping(receipt, "initial evidence envelope", [
    "scope", "customerDeploymentVerified", "observations", "probeRuns", "commands",
  ]);
  assert(receipt.scope === scope && receipt.customerDeploymentVerified === false, "initial evidence scope changed");
  mapping(receipt.observations, "initial observations", []);
  mapping(receipt.probeRuns, "initial probe runs", []);
  assert(Array.isArray(receipt.commands) && receipt.commands.length === 0, "initial commands must be empty");
}

function assertEvidence(receipt, { requireAll = false } = {}) {
  mapping(receipt, "evidence envelope", [
    "scope", "customerDeploymentVerified", "receiptMode", "minimumProbeRuns", "selfHashMeaning",
    "requiredReceiptDigests", "observations", "observationHistory", "probeRuns", "commands",
  ]);
  assert(receipt.scope === scope && receipt.customerDeploymentVerified === false, "invalid synthetic evidence scope");
  assert(receipt.receiptMode === "observations-only" && receipt.minimumProbeRuns === 1,
    "invalid observations-only evidence policy");
  assert(receipt.selfHashMeaning === "integrity-only-not-trust-or-attestation", "receipt self-hash meaning changed");
  assert(JSON.stringify(receipt.requiredReceiptDigests) === JSON.stringify(requiredReceiptDigests),
    "receipt digest policy changed");
  const observations = mapping(receipt.observations, "observations",
    requireAll ? probeKeys : Object.keys(receipt.observations));
  const observedKeys = probeKeys.filter((probe) => observations[probe] !== undefined);
  assert(Object.keys(observations).every((probe) => probeKeys.includes(probe)), "unknown observation key");
  const histories = mapping(receipt.observationHistory, "observation histories", observedKeys);
  const probeRuns = mapping(receipt.probeRuns, "probe runs", observedKeys);
  const expectedCommands = observedKeys.map((probe) => `node verify.mjs --probe ${probe} => PASS (${scope})`);
  assert(JSON.stringify(receipt.commands) === JSON.stringify(expectedCommands), "command/output evidence missing");
  const currentDigests = currentReceiptDigests();
  for (const key of observedKeys) {
    assert(Number.isSafeInteger(probeRuns[key]) && probeRuns[key] >= receipt.minimumProbeRuns,
      `${key} run count missing`);
    const observation = mapping(observations[key], `observation ${key}`, [
      "passed", "evidenceType", "scope", "observedAt", "httpExchanges", "checks",
      "probeRun", "previousReceiptSha256", ...requiredReceiptDigests, "receiptSha256",
    ]);
    assert(observation.passed === true && observation.scope === scope, `${key} evidence scope changed`);
    assert(["http-loopback", "configuration-and-http-loopback", "startup-guard"].includes(observation.evidenceType),
      `${key} evidence type is invalid`);
    assert(Number.isSafeInteger(observation.httpExchanges) && observation.httpExchanges > 0,
      `${key} lacks observed HTTP evidence`);
    assert(typeof observation.observedAt === "string" && !Number.isNaN(Date.parse(observation.observedAt))
      && new Date(observation.observedAt).toISOString() === observation.observedAt, `${key} observation time is invalid`);
    assert(Array.isArray(observation.checks) && observation.checks.length > 0 && observation.checks.length <= 12,
      `${key} checks are invalid`);
    assert(observation.probeRun === probeRuns[key], `${key} receipt replay counter mismatch`);
    const history = histories[key];
    assert(Array.isArray(history) && history.length === probeRuns[key]
      && history.length >= receipt.minimumProbeRuns && history.length <= 8, `${key} receipt history is invalid`);
    let previousReceiptSha256 = null;
    for (let index = 0; index < history.length; index += 1) {
      const historicalReceipt = history[index];
      mapping(historicalReceipt, `historical observation ${key}`, Object.keys(observation));
      assert(historicalReceipt.passed === true && historicalReceipt.scope === scope
        && ["http-loopback", "configuration-and-http-loopback", "startup-guard"].includes(historicalReceipt.evidenceType),
      `${key} historical evidence scope is invalid`);
      assert(Number.isSafeInteger(historicalReceipt.httpExchanges) && historicalReceipt.httpExchanges > 0,
        `${key} historical receipt lacks HTTP evidence`);
      assert(typeof historicalReceipt.observedAt === "string" && !Number.isNaN(Date.parse(historicalReceipt.observedAt))
        && new Date(historicalReceipt.observedAt).toISOString() === historicalReceipt.observedAt,
      `${key} historical observation time is invalid`);
      assert(Array.isArray(historicalReceipt.checks) && historicalReceipt.checks.length > 0
        && historicalReceipt.checks.length <= 12, `${key} historical checks are invalid`);
      assert(historicalReceipt?.probeRun === index + 1, `${key} receipt history is non-consecutive`);
      assert(historicalReceipt.previousReceiptSha256 === previousReceiptSha256, `${key} receipt chain is broken`);
      const { receiptSha256: historicalHash, ...historicalPayload } = historicalReceipt;
      assert(historicalHash === digest(canonicalJson(historicalPayload)), `${key} historical receipt is tampered`);
      for (const digestName of requiredReceiptDigests) {
        assert(historicalReceipt[digestName] === currentDigests[digestName],
          `stale historical receipt digest ${digestName}: ${key}`);
      }
      previousReceiptSha256 = historicalHash;
      assert(JSON.stringify(historicalReceipt).length <= 8_192, `${key} historical receipt is oversized`);
      assert(!/:\d{4,5}\b/u.test(JSON.stringify(historicalReceipt)), `${key} historical receipt leaks an ephemeral port`);
    }
    assert(canonicalJson(history.at(-1)) === canonicalJson(observation), `${key} latest observation differs from history`);
    for (const digestName of requiredReceiptDigests) {
      assert(observation[digestName] === currentDigests[digestName], `stale receipt digest ${digestName}: ${key}`);
    }
    const { receiptSha256, ...payload } = observation;
    assert(receiptSha256 === digest(canonicalJson(payload)), `tampered receipt: ${key}`);
    assert(JSON.stringify(observation).length <= 8_192, `${key} receipt is oversized`);
    assert(!/:\d{4,5}\b/u.test(JSON.stringify(observation)), `${key} leaks an ephemeral port`);
  }
  if (requireAll) assert(observedKeys.length === probeKeys.length, "all probes must run");
}

function record(key, observation) {
  const existing = json("evidence.json");
  let receipt;
  if (existing.receiptMode === undefined) {
    assertInitialEvidence(existing);
    receipt = blankEvidence();
  } else {
    assertEvidence(existing);
    receipt = existing;
  }
  const history = receipt.observationHistory[key] ?? [];
  assert(Array.isArray(history) && history.length < 8, `${key} receipt history is invalid or full`);
  const probeRun = (receipt.probeRuns[key] ?? 0) + 1;
  const payload = {
    ...observation,
    passed: true,
    scope,
    observedAt: new Date().toISOString(),
    httpExchanges,
    probeRun,
    previousReceiptSha256: history.length === 0 ? null : history.at(-1).receiptSha256,
    ...currentReceiptDigests(),
  };
  const recorded = { ...payload, receiptSha256: digest(canonicalJson(payload)) };
  receipt.observations[key] = recorded;
  receipt.observationHistory[key] = [...history, recorded];
  receipt.probeRuns[key] = probeRun;
  receipt.commands = probeKeys.filter((probe) => receipt.observations[probe])
    .map((probe) => `node verify.mjs --probe ${probe} => PASS (${scope})`);
  assertEvidence(receipt);
  writeFileSync(resolve(root, "evidence.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
}

function validateEvidence() {
  assertEvidence(json("evidence.json"), { requireAll: true });
}

async function startApplication(enabled) {
  const child = spawn(process.execPath, [resolve(root, "app/src/server.mjs")], {
    cwd: resolve(root, "app"),
    env: {
      PATH: process.env.PATH,
      HOST: "127.0.0.1",
      PORT: "0",
      GAUNTLET_ENABLED: enabled ? "true" : "false",
      GAUNTLET_APPLICATION_ID: "payments",
      GAUNTLET_APPLICATION_LABEL: "Payments",
      GAUNTLET_ENVIRONMENT_NAME: "small-apps-staging",
      GAUNTLET_ENVIRONMENT_KIND: "staging",
      GAUNTLET_IDEMPOTENCY_SECRET_FILE: resolve(root, "secrets/gauntlet-idempotency"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const ready = await new Promise((resolveReady, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`application readiness timed out: ${stderr}`)), 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const newline = output.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      try { resolveReady(JSON.parse(output.slice(0, newline))); } catch (error) { reject(error); }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`application exited before readiness (${code}): ${stderr}`));
    });
  });
  assert(ready.scope === scope && ready.customerDeploymentVerified === false, "application readiness scope is not synthetic");
  assert(ready.address === "127.0.0.1" && Number.isInteger(ready.port), "application did not bind ephemeral loopback");
  return {
    child,
    origin: `http://127.0.0.1:${ready.port}`,
    async close() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await once(child, "exit");
    },
  };
}

async function request(origin, path, init) {
  httpExchanges += 1;
  const response = await fetch(`${origin}${path}`, init);
  const raw = await response.text();
  let body;
  try { body = JSON.parse(raw); } catch { body = raw; }
  return { status: response.status, mediaType: response.headers.get("content-type")?.split(";", 1)[0] ?? null, body };
}

async function rawRequest(application, requestLine, headers = ["Host: adapter", "Connection: close"]) {
  httpExchanges += 1;
  const url = new URL(application.origin);
  return new Promise((resolveResponse, reject) => {
    const socket = connect(Number(url.port), "127.0.0.1");
    let response = "";
    socket.setEncoding("latin1");
    socket.on("connect", () => socket.end(`${requestLine}\r\n${headers.join("\r\n")}\r\n\r\n`));
    socket.on("data", (chunk) => { response += chunk; });
    socket.on("error", reject);
    socket.on("close", () => {
      const match = /^HTTP\/1\.1 (\d{3})[^\r\n]*\r\n([\s\S]*)$/u.exec(response);
      if (match === null) return reject(new Error("raw HTTP response missing"));
      const [headers, rawBody = ""] = match[2].split("\r\n\r\n", 2);
      const mediaType = /^content-type:\s*([^;\r\n]+)/imu.exec(headers)?.[1] ?? "";
      let body;
      try { body = JSON.parse(rawBody); } catch { body = rawBody; }
      resolveResponse({ status: Number(match[1]), mediaType, body });
    });
  });
}
const rawStatus = async (application, target) => (await rawRequest(application, `GET ${target} HTTP/1.1`)).status;

async function disabledProbe() {
  const application = await startApplication(false);
  try {
    const routeFamilies = [];
    for (const [family, method, path] of [
      ["health", "GET", `${prefix}/health`],
      ["manifest", "GET", `${prefix}/manifest`],
      ["operation-definition", "GET", `${prefix}/operations/fixtures.set-clock`],
      ["operation-run", "POST", `${prefix}/operations/fixtures.set-clock/runs`],
      ["run", "GET", `${prefix}/runs/synthetic-run`],
      ["data-source-query", "POST", `${prefix}/data-sources/accounts/query`],
      ["data-source-resolve", "POST", `${prefix}/data-sources/accounts/resolve`],
      ["cancel", "POST", `${prefix}/runs/synthetic-run/cancel`],
      ["events", "GET", `${prefix}/runs/synthetic-run/events`],
      ["upload", "POST", `${prefix}/uploads`],
      ["session-launch", "POST", `${prefix}/runs/synthetic-run/artifacts/synthetic-artifact/launch`],
    ]) {
      const disabled = await request(application.origin, path, { method });
      assert(disabled.status === 503 && disabled.mediaType === "application/problem+json"
        && disabled.body?.type === "urn:gauntlet:problem:adapter-disabled"
        && disabled.body?.status === 503, `disabled ${family} boundary is not canonical`);
      routeFamilies.push({ family, method, status: disabled.status, problemType: disabled.body.type });
    }
    const rawTargetVariants = [];
    for (const rawTarget of [
      `http://public.invalid${prefix}/health`,
      "/%5Fgauntlet/v1/health",
      "//_gauntlet//v1//health",
      "/ordinary/../_gauntlet/v1/health",
      `${prefix}/health/`,
      "/_gauntlet%2fv1/health",
      "/_gauntlet\\v1\\health",
      "/_g%61untlet/v1/health",
      "/_gauntlet/v1/operations/unsafe%ZZid",
      "/_gauntlet/v1/manifest?query=1",
      "/_gauntlet/v1/manifest#fragment",
    ]) {
      const status = await rawStatus(application, rawTarget);
      assert(status === 503, `disabled raw target escaped gate: ${rawTarget}`);
      rawTargetVariants.push({ rawTarget, status });
    }
    const host = await request(application.origin, "/host-health");
    assert(host.status === 200 && host.body?.status === "ok", "host route did not fall through");
    const malformedAdapterStatuses = [];
    for (const requestLine of malformedAdapterRequestLines) {
      const malformedAdapter = await rawRequest(application, `${requestLine} bad HTTP/1.1`);
      assert(malformedAdapter.status === 503
        && malformedAdapter.body?.type === "urn:gauntlet:problem:adapter-disabled",
      `disabled malformed adapter request escaped clientError ownership: ${requestLine}`);
      malformedAdapterStatuses.push(malformedAdapter.status);
    }
    const malformedHost = await rawRequest(application, "GET /host health HTTP/1.1");
    assert(malformedHost.status === 400 && malformedHost.mediaType === "",
      "unrelated malformed request was not a generic 400");
    const exceptionalAdapterStatuses = [];
    const exceptionalUnrelatedStatuses = [];
    for (const requestCase of exceptionalRequestCases) {
      const exceptionalAdapter = await rawRequest(application, requestCase.adapterRequestLine, requestCase.headers);
      assert(exceptionalAdapter.status === 503
        && exceptionalAdapter.mediaType === "application/problem+json"
        && exceptionalAdapter.body?.type === "urn:gauntlet:problem:adapter-disabled",
      `disabled ${requestCase.channel} adapter request escaped the gate`);
      exceptionalAdapterStatuses.push(exceptionalAdapter.status);
      const unrelated = await rawRequest(application, requestCase.unrelatedRequestLine, requestCase.headers);
      assert(unrelated.status === requestCase.unrelatedStatus && unrelated.mediaType === "",
      `unrelated ${requestCase.channel} request did not remain generic: ${JSON.stringify(unrelated)}`);
      exceptionalUnrelatedStatuses.push(unrelated.status);
    }
    return { evidenceType: "http-loopback", checks: [{
      routeFamilies,
      rawTargetVariants,
      hostFallback: { request: "GET /host-health", status: 200, hostApplicationAlive: true },
      clientErrorBoundary: {
        adapterRequests: {
          requestLines: malformedAdapterRequestLines,
          statuses: malformedAdapterStatuses,
          problemType: "urn:gauntlet:problem:adapter-disabled",
        },
        unrelatedRequest: { status: malformedHost.status, mediaType: malformedHost.mediaType },
      },
      exceptionalBoundary: {
        channels: exceptionalRequestCases.map(({ channel }) => channel),
        adapterStatuses: exceptionalAdapterStatuses,
        unrelatedStatuses: exceptionalUnrelatedStatuses,
      },
    }] };
  } finally { await application.close(); }
}

async function mismatchProbe() {
  const application = await startApplication(true);
  try {
    const checks = [];
    for (const [mismatchAxis, expectedEnvironment] of [
      ["name", { name: "qa", kind: "staging" }],
      ["kind", { name: "small-apps-staging", kind: "qa" }],
    ]) {
      const routeFamilies = [];
      let manifestDiscoveryRequests = 0;
      let upstreamApplicationRequests = 0;
      const proxy = createServer(async (_incoming, outgoing) => {
        const manifest = await request(application.origin, `${prefix}/manifest`);
        manifestDiscoveryRequests += 1;
        const actual = manifest.body?.application?.environment;
        if (actual?.name !== expectedEnvironment.name || actual?.kind !== expectedEnvironment.kind) {
          outgoing.writeHead(503, { "content-type": "application/problem+json" });
          outgoing.end('{"type":"urn:gauntlet:problem:target-environment-mismatch","title":"Target environment mismatch","status":503}\n');
          return;
        }
        upstreamApplicationRequests += 1;
        outgoing.writeHead(500).end();
      });
      proxy.listen(0, "127.0.0.1");
      await once(proxy, "listening");
      const address = proxy.address();
      assert(address !== null && typeof address === "object" && address.address === "127.0.0.1", "proxy escaped loopback");
      try {
        for (const [proxyFamily, method, path] of [
          ["operation-definition", "GET", `/proxy${prefix}/operations/fixtures.set-clock`],
          ["operation-run", "POST", `/proxy${prefix}/operations/fixtures.set-clock/runs`],
          ["run", "GET", `/proxy${prefix}/runs/synthetic-run`],
          ["upload", "POST", `/proxy${prefix}/uploads`],
          ["cancel", "POST", `/proxy${prefix}/runs/synthetic-run/cancel`],
          ["events", "GET", `/proxy${prefix}/runs/synthetic-run/events`],
          ["data-source-query", "POST", `/proxy${prefix}/data-sources/accounts/query`],
          ["data-source-resolve", "POST", `/proxy${prefix}/data-sources/accounts/resolve`],
          ["session-launch", "POST", `/proxy${prefix}/runs/synthetic-run/artifacts/synthetic-artifact/launch`],
        ]) {
          const result = await request(`http://127.0.0.1:${address.port}`, path, { method });
          assert(result.status === 503 && result.mediaType === "application/problem+json"
            && result.body?.type === "urn:gauntlet:problem:target-environment-mismatch"
            && result.body?.status === 503, `${mismatchAxis} ${proxyFamily} mismatch was not denied`);
          assert(upstreamApplicationRequests === 0, `${mismatchAxis} ${proxyFamily} mismatch reached application execution`);
          routeFamilies.push({
            proxyFamily,
            status: result.status,
          });
        }
      } finally {
        proxy.closeAllConnections();
        proxy.close();
        await once(proxy, "close");
      }
      checks.push({
        mismatchAxis,
        routeFamilies,
        status: 503,
        problemType: "urn:gauntlet:problem:target-environment-mismatch",
        manifestDiscoveryRequests,
        upstreamApplicationRequests,
      });
    }
    return { evidenceType: "http-loopback", checks };
  } finally {
    await application.close();
  }
}

async function syntheticProtocolExerciseProbe() {
  const application = await startApplication(true);
  const post = (path, body) => request(application.origin, path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    const health = await request(application.origin, `${prefix}/health`);
    const manifest = await request(application.origin, `${prefix}/manifest`);
    const operation = await request(application.origin, `${prefix}/operations/fixtures.set-clock`);
    assert(health.status === 200 && health.body?.protocolVersion === "1.0", "health failed");
    assert(manifest.status === 200 && manifest.body?.application?.environment?.name === "small-apps-staging", "manifest environment failed");
    assert(operation.status === 200 && /^sha256:[0-9a-f]{64}$/u.test(operation.body?.revision), "operation definition failed");
    const confirmation = { operationId: operation.body.id, operationRevision: operation.body.revision, impact: "write" };
    const stale = await post(`${prefix}/operations/${operation.body.id}/runs`, {
      operationRevision: `sha256:${"f".repeat(64)}`, input: { value: "2030-01-01" }, dryRun: true,
      idempotencyKey: "forward-stale", confirmation,
    });
    const invalid = await post(`${prefix}/operations/${operation.body.id}/runs`, {
      operationRevision: operation.body.revision, input: {}, dryRun: true,
      idempotencyKey: "forward-invalid", confirmation,
    });
    const validRequest = {
      operationRevision: operation.body.revision, input: { value: "2030-01-01" }, dryRun: true,
      idempotencyKey: "forward-valid", confirmation,
    };
    const created = await post(`${prefix}/operations/${operation.body.id}/runs`, validRequest);
    let polled;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      polled = await request(application.origin, `${prefix}/runs/${encodeURIComponent(created.body?.id ?? "")}`);
      if (["succeeded", "failed", "partial", "cancelled", "timed_out"].includes(polled.body?.state)) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
    const replay = await post(`${prefix}/operations/${operation.body.id}/runs`, validRequest);
    const query = await post(`${prefix}/data-sources/accounts/query`, {
      search: "account", limit: 10, dependencies: {}, context: { requestId: "forward-query" },
    });
    const resolved = await post(`${prefix}/data-sources/accounts/resolve`, {
      values: ["account-1", "missing"], dependencies: {}, context: { requestId: "forward-resolve" },
    });
    assert(stale.status === 409 && stale.body?.type === "urn:gauntlet:problem:stale-operation-revision", "stale revision semantics failed");
    assert(invalid.status === 422 && invalid.body?.type === "urn:gauntlet:problem:validation-failed", "input validation semantics failed");
    assert(created.status === 202 && typeof created.body?.id === "string", "run creation failed");
    assert(polled?.status === 200 && polled.body?.state === "succeeded", "run did not reach succeeded");
    assert(replay.status === 201 && replay.body?.id === created.body.id, "idempotent replay failed");
    assert(!JSON.stringify([created.body, polled.body, replay.body]).includes("forward-valid"),
      "raw idempotency key leaked from the secret-aware RunManager");
    assert(query.status === 200 && query.body?.items?.[0]?.value === "account-1", "data-source query failed");
    assert(resolved.status === 200 && resolved.body?.results?.length === 2, "data-source resolve failed");
    const counters = await request(application.origin, "/__fixture/counters");
    assert(counters.status === 200 && counters.body?.operationRuns === 1,
      "secret-aware RunManager did not invoke the application operation exactly once");
    assert(canonicalJson(counters.body?.lastOperationInput) === canonicalJson({ value: "2030-01-01" }),
      "application operation callback did not receive the exact input");
    assert(counters.body?.dataSourceQueries === 1
      && canonicalJson(counters.body?.lastDataSourceQuery) === canonicalJson({
        search: "account", limit: 10, dependencies: {}, context: { requestId: "forward-query" },
      }), "application query callback did not receive the exact request once");
    assert(counters.body?.dataSourceResolves === 1
      && canonicalJson(counters.body?.lastDataSourceResolve) === canonicalJson({
        values: ["account-1", "missing"], dependencies: {}, context: { requestId: "forward-resolve" },
      }), "application resolve callback did not receive the exact request once");
    const invalidRawTargets = [
      "/_gauntlet/v1/operations/a/../b",
      "/_gauntlet/v1/operations/a/./b",
      "/_gauntlet/v1/manifest/..",
      "/_gauntlet/v1/manifest/.",
      "/_gauntlet/v1//manifest",
      "/_gauntlet/v1/operations/a%2fb",
      "/_gauntlet/v1/operations/a\\b",
      "/_gauntlet/v1/manifest?query=1",
      "/_gauntlet/v1/manifest#fragment",
      "/_gauntlet/v1/manifest/",
      "/_gauntlet/v1/manifest/extra",
      "/_gauntlet/v1/operations/bad$id",
      "/_gauntlet/v1/operations/unsafe%ZZid",
    ];
    const invalidRawStatuses = [];
    for (const target of invalidRawTargets) {
      const invalidPath = await rawRequest(application, `GET ${target} HTTP/1.1`);
      assert(invalidPath.status === 400 && invalidPath.mediaType === "application/problem+json",
      `SDK did not own invalid raw target: ${target}`);
      invalidRawStatuses.push(invalidPath.status);
    }
    const malformedAdapterStatuses = [];
    for (const requestLine of malformedAdapterRequestLines) {
      const malformedAdapter = await rawRequest(application, `${requestLine} bad HTTP/1.1`);
      assert(malformedAdapter.status === 400
        && malformedAdapter.body?.type === "urn:gauntlet:problem:invalid-path",
      `enabled malformed adapter request escaped clientError ownership: ${requestLine}`);
      malformedAdapterStatuses.push(malformedAdapter.status);
    }
    const malformedHost = await rawRequest(application, "GET /host health HTTP/1.1");
    assert(malformedHost.status === 400 && malformedHost.mediaType === "",
      "unrelated malformed request was not a generic 400");
    const exceptionalAdapterStatuses = [];
    const exceptionalUnrelatedStatuses = [];
    for (const requestCase of exceptionalRequestCases) {
      const exceptionalAdapter = await rawRequest(application, requestCase.adapterRequestLine, requestCase.headers);
      assert(exceptionalAdapter.status === requestCase.enabledStatus
        && exceptionalAdapter.mediaType === "application/problem+json",
      `enabled ${requestCase.channel} adapter request escaped owned boundary`);
      exceptionalAdapterStatuses.push(exceptionalAdapter.status);
      const unrelated = await rawRequest(application, requestCase.unrelatedRequestLine, requestCase.headers);
      assert(unrelated.status === requestCase.unrelatedStatus && unrelated.mediaType === "",
      `unrelated ${requestCase.channel} request did not remain generic: ${JSON.stringify(unrelated)}`);
      exceptionalUnrelatedStatuses.push(unrelated.status);
    }
    return { evidenceType: "http-loopback", checks: [{
      healthStatus: health.status, manifestStatus: manifest.status, operationStatus: operation.status,
      staleRevisionStatus: stale.status, invalidInputStatus: invalid.status,
      createStatus: created.status, terminalState: polled.body.state, idempotentReplay: replay.body.id === created.body.id,
      dataSourceQueryStatus: query.status, dataSourceResolveStatus: resolved.status,
      applicationOperationRuns: counters.body.operationRuns,
      operationInputMatched: true,
      applicationDataSourceQueries: counters.body.dataSourceQueries,
      applicationDataSourceResolves: counters.body.dataSourceResolves,
      dataSourceInputsMatched: true,
      rawBoundary: {
        invalidTargets: invalidRawTargets,
        statuses: invalidRawStatuses,
        malformedAdapter: {
          requestLines: malformedAdapterRequestLines,
          statuses: malformedAdapterStatuses,
          problemType: "urn:gauntlet:problem:invalid-path",
        },
        unrelatedMalformed: { status: malformedHost.status, mediaType: malformedHost.mediaType },
        exceptionalRequests: {
          channels: exceptionalRequestCases.map(({ channel }) => channel),
          adapterStatuses: exceptionalAdapterStatuses,
          unrelatedStatuses: exceptionalUnrelatedStatuses,
        },
      },
    }] };
  } finally { await application.close(); }
}

async function deploymentProbe() {
  const dashboard = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"status":"ok"}\n');
      return;
    }
    response.writeHead(404).end();
  });
  dashboard.listen(0, "127.0.0.1");
  await once(dashboard, "listening");
  const address = dashboard.address();
  assert(address !== null && typeof address === "object" && address.address === "127.0.0.1", "dashboard escaped loopback");
  try {
    const health = await request(`http://127.0.0.1:${address.port}`, "/health");
    assert(health.status === 200 && health.body?.status === "ok", "dashboard health failed");
    return { evidenceType: "configuration-and-http-loopback", checks: [
      { applicationComposeHostPorts: 0, explicitTarget: "payments", externalNetwork: "gauntlet" },
      { dashboardConfiguredBind: "127.0.0.1", syntheticHarnessBind: "127.0.0.1", healthStatus: 200 },
    ] };
  } finally { dashboard.closeAllConnections(); dashboard.close(); await once(dashboard, "close"); }
}

assertStaticContract();
if (process.argv.length === 4 && process.argv[2] === "--probe" && probeKeys.includes(process.argv[3])) {
  const key = process.argv[3];
  const observation = key === "disabledBoundary" ? await disabledProbe()
    : key === "mismatchDenied" ? await mismatchProbe()
      : key === "syntheticProtocolExercise" ? await syntheticProtocolExerciseProbe()
        : await deploymentProbe();
  record(key, observation);
  process.stdout.write(`${key}: PASS (synthetic loopback; customer deployment not verified)\n`);
} else if (process.argv.length === 3 && process.argv[2] === "--help") {
  process.stdout.write(`${probeKeys.map((key) => `node verify.mjs --probe ${key}`).join("\n")}\n`);
} else if (process.argv.length === 2) {
  validateEvidence();
  process.stdout.write("safe Node Compose synthetic fixture verified; customer deployment not verified\n");
} else {
  process.stderr.write("Usage: node verify.mjs [--help | --probe CHECK]\n");
  process.exitCode = 2;
}
