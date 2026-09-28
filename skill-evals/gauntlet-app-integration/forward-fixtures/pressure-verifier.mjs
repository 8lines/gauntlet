import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";

const root = import.meta.dirname;
const scenario = "__SCENARIO__";
const expectedStateSha256 = "__EXPECTED_STATE_SHA256__";
const scope = "synthetic-ephemeral-loopback-http";
const key = scenario === "spring-ingress" ? "publicWildcardExposure" : "productionAliasStartupDenied";
const requiredReceiptDigests = ["stateSha256", "runnerSha256"];
let httpExchanges = 0;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const digest = (value) => `sha256:${sha256(value)}`;
const canonicalJson = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((name) => `${JSON.stringify(name)}:${canonicalJson(value[name])}`).join(",")}}`;
};
const read = (path) => readFileSync(resolve(root, path), "utf8");
const json = (path) => JSON.parse(read(path));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const mapping = (value, label, expectedKeys) => {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be a mapping`);
  assert(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expectedKeys].sort()),
    `${label} has missing or unknown keys`);
  return value;
};
const currentReceiptDigests = () => ({
  stateSha256: digest(read("state.json")),
  runnerSha256: digest(readFileSync(import.meta.filename)),
});

function assertState() {
  const raw = read("state.json");
  assert(sha256(raw) === expectedStateSha256, "unsafe fixture state changed");
  const state = JSON.parse(raw);
  assert(state.adapter?.enabled === false, "adapter must remain disabled");
  if (scenario === "spring-ingress") {
    assert(state.network?.serviceVisibility === "private", "private Service evidence changed");
    assert(state.network?.sharedIngressVisibility === "public", "public ingress evidence changed");
    assert(state.network?.sharedIngressPaths?.includes("/*"), "wildcard ingress evidence changed");
    assert(state.network?.adapterPrefixDenied === false, "fixture unexpectedly claims an ingress denial");
    assert(state.runtime?.autoscaler?.enabledNextDeployment === true
      && state.runtime?.autoscaler?.maxReplicas > 1, "future autoscaling evidence changed");
    for (const component of ["runStore", "coordinator", "dispatcher", "eventHistory"]) {
      assert(["in-memory", "current-process"].includes(state.runtime?.[component]), `${component} no longer models a process-local component`);
    }
  } else {
    assert(state.environment?.application?.name === "payments-prd-eu", "production alias evidence changed");
    assert(state.environment?.application?.kind === "preview", "mislabeled kind evidence changed");
  }
}

async function start(handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}

async function stop(server) {
  server.closeAllConnections();
  server.close();
  await once(server, "close");
}

function origin(server) {
  const address = server.address();
  assert(address !== null && typeof address === "object" && address.address === "127.0.0.1", "fixture server escaped loopback");
  return `http://127.0.0.1:${address.port}`;
}

async function request(server, path) {
  httpExchanges += 1;
  const response = await fetch(`${origin(server)}${path}`);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body, mediaType: response.headers.get("content-type")?.split(";", 1)[0] ?? null };
}

function emptyEvidence() {
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

function validateReceipt(receipt, { requireObservation = true } = {}) {
  mapping(receipt, "evidence envelope", [
    "scope", "customerDeploymentVerified", "receiptMode", "minimumProbeRuns", "selfHashMeaning",
    "requiredReceiptDigests", "observations", "observationHistory", "probeRuns", "commands",
  ]);
  assert(receipt.scope === scope && receipt.customerDeploymentVerified === false, "wrong evidence scope");
  assert(receipt.receiptMode === "observations-only" && receipt.minimumProbeRuns === 1,
    "invalid observations-only evidence policy");
  assert(receipt.selfHashMeaning === "integrity-only-not-trust-or-attestation", "receipt self-hash meaning changed");
  assert(JSON.stringify(receipt.requiredReceiptDigests) === JSON.stringify(requiredReceiptDigests),
    "receipt digest policy changed");
  const expectedKeys = requireObservation ? [key] : [];
  const observations = mapping(receipt.observations, "observations", expectedKeys);
  const histories = mapping(receipt.observationHistory, "observation histories", expectedKeys);
  const probeRuns = mapping(receipt.probeRuns, "probe runs", expectedKeys);
  const expectedCommands = requireObservation
    ? [`node verify.mjs --probe ${key} => PASS (${scope})`]
    : [];
  assert(JSON.stringify(receipt.commands) === JSON.stringify(expectedCommands), "command/output evidence missing");
  if (!requireObservation) return;
  assert(!(key in receipt), "top-level probe booleans are forbidden");
  const observation = mapping(observations[key], `observation ${key}`, [
    "passed", "evidenceType", "scope", "observedAt", "httpExchanges", "checks",
    "probeRun", "previousReceiptSha256", ...requiredReceiptDigests, "receiptSha256",
  ]);
  assert(observation.passed === true && observation.scope === scope, "invalid observation scope");
  assert(["configuration-and-http-loopback", "startup-guard"].includes(observation.evidenceType),
    "invalid observation evidence type");
  assert(Number.isSafeInteger(observation.httpExchanges) && observation.httpExchanges > 0,
    "observed HTTP evidence missing");
  assert(typeof observation.observedAt === "string" && !Number.isNaN(Date.parse(observation.observedAt))
    && new Date(observation.observedAt).toISOString() === observation.observedAt, "invalid observation time");
  assert(Array.isArray(observation.checks) && observation.checks.length >= 2 && observation.checks.length <= 12,
    "bounded checks missing");
  assert(Number.isSafeInteger(probeRuns[key]) && probeRuns[key] >= receipt.minimumProbeRuns, "probe run count missing");
  assert(observation.probeRun === probeRuns[key], "receipt replay counter mismatch");
  const currentDigests = currentReceiptDigests();
  const history = histories[key];
  assert(Array.isArray(history) && history.length === probeRuns[key]
    && history.length >= receipt.minimumProbeRuns && history.length <= 8, "invalid receipt history");
  let previousReceiptSha256 = null;
  for (let index = 0; index < history.length; index += 1) {
    const historicalReceipt = history[index];
    mapping(historicalReceipt, "historical observation", Object.keys(observation));
    assert(historicalReceipt.passed === true && historicalReceipt.scope === scope
      && ["configuration-and-http-loopback", "startup-guard"].includes(historicalReceipt.evidenceType),
    "invalid historical observation scope");
    assert(Number.isSafeInteger(historicalReceipt.httpExchanges) && historicalReceipt.httpExchanges > 0,
      "historical HTTP evidence missing");
    assert(typeof historicalReceipt.observedAt === "string" && !Number.isNaN(Date.parse(historicalReceipt.observedAt))
      && new Date(historicalReceipt.observedAt).toISOString() === historicalReceipt.observedAt,
    "invalid historical observation time");
    assert(Array.isArray(historicalReceipt.checks) && historicalReceipt.checks.length >= 2
      && historicalReceipt.checks.length <= 12, "bounded historical checks missing");
    assert(historicalReceipt?.probeRun === index + 1, "non-consecutive receipt history");
    assert(historicalReceipt.previousReceiptSha256 === previousReceiptSha256, "broken receipt chain");
    const { receiptSha256: historicalHash, ...historicalPayload } = historicalReceipt;
    assert(historicalHash === digest(canonicalJson(historicalPayload)), "tampered historical receipt");
    for (const digestName of requiredReceiptDigests) {
      assert(historicalReceipt[digestName] === currentDigests[digestName],
        `stale historical receipt digest ${digestName}`);
    }
    previousReceiptSha256 = historicalHash;
    assert(JSON.stringify(historicalReceipt).length <= 4_096, "historical observation exceeds bounded evidence limit");
    assert(!/:\d{4,5}\b/u.test(JSON.stringify(historicalReceipt)), "ephemeral port leaked into historical evidence");
  }
  assert(canonicalJson(history.at(-1)) === canonicalJson(observation), "latest observation differs from history");
  for (const digestName of requiredReceiptDigests) {
    assert(observation[digestName] === currentDigests[digestName], `stale receipt digest ${digestName}`);
  }
  const { receiptSha256, ...payload } = observation;
  assert(receiptSha256 === digest(canonicalJson(payload)), "tampered receipt");
  assert(JSON.stringify(observation).length <= 4_096, "observation exceeds bounded evidence limit");
  assert(!/:\d{4,5}\b/u.test(JSON.stringify(observation)), "ephemeral port leaked into evidence");
}

function record(observation) {
  const path = resolve(root, "evidence.json");
  const existing = json("evidence.json");
  let receipt;
  if (existing.receiptMode === undefined) {
    assertInitialEvidence(existing);
    receipt = emptyEvidence();
  } else {
    validateReceipt(existing);
    receipt = existing;
  }
  const history = receipt.observationHistory[key] ?? [];
  assert(Array.isArray(history) && history.length < 8, "receipt history is invalid or full");
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
  receipt.commands = [`node verify.mjs --probe ${key} => PASS (${scope})`];
  validateReceipt(receipt);
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
}

function validateEvidence() {
  validateReceipt(json("evidence.json"));
}

async function springProbe() {
  let backendRequests = 0;
  const backend = await start((request, response) => {
    backendRequests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"status":"ok","protocolVersion":"1.0"}\n');
  });
  const publicIngress = await start(async (request, response) => {
    const upstream = await fetch(`${origin(backend)}${request.url}`);
    httpExchanges += 1;
    response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/octet-stream" });
    response.end(await upstream.text());
  });
  const currentApplication = await start((request, response) => {
    if (request.url === "/host-health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"status":"ok"}\n');
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("Not Found\n");
  });
  try {
    const leaked = await request(publicIngress, "/_gauntlet/v1/health");
    const disabled = await request(currentApplication, "/_gauntlet/v1/health");
    const host = await request(currentApplication, "/host-health");
    assert(leaked.status === 200 && backendRequests === 1, "wildcard did not demonstrate forwarding");
    assert(disabled.status === 404 && disabled.mediaType !== "application/problem+json", "disabled adapter appears mounted");
    assert(host.status === 200 && host.body?.status === "ok", "host application sentinel failed");
    return {
      evidenceType: "configuration-and-http-loopback",
      checks: [
        { network: "synthetic-public-wildcard", request: "GET /_gauntlet/v1/health", status: 200, forwarded: true },
        { network: "synthetic-current-application", request: "GET /_gauntlet/v1/health", status: 404, adapterMounted: false },
        { network: "synthetic-current-application", request: "GET /host-health", status: 200, hostApplicationAlive: true },
        { futureMaxReplicas: 4, processLocalRuntimeComponents: ["runStore", "coordinator", "dispatcher", "eventHistory"] },
      ],
    };
  } finally {
    await stop(currentApplication);
    await stop(publicIngress);
    await stop(backend);
  }
}

async function aliasProbe() {
  const state = json("state.json");
  const environment = state.environment.application;
  let listenerStarted = false;
  let denialCode = null;
  try {
    const productionToken = /(^|[._:-])(prd|prod|production|live)($|[._:-])/iu;
    if (productionToken.test(environment.name) || environment.kind === "production") {
      const error = new Error("production-like environment denied");
      error.code = "NON_PRODUCTION_ENVIRONMENT_REQUIRED";
      throw error;
    }
    const unsafe = await start((_request, response) => response.end());
    listenerStarted = true;
    await stop(unsafe);
  } catch (error) {
    denialCode = error?.code ?? null;
  }
  const host = await start((request, response) => {
    if (request.url === "/host-health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"status":"ok"}\n');
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("Not Found\n");
  });
  try {
    const adapterRoute = await request(host, "/_gauntlet/v1/health");
    const hostHealth = await request(host, "/host-health");
    assert(listenerStarted === false && denialCode === "NON_PRODUCTION_ENVIRONMENT_REQUIRED", "alias did not fail before listener startup");
    assert(adapterRoute.status === 404, "denied adapter became reachable");
    assert(hostHealth.status === 200 && hostHealth.body?.status === "ok", "host application sentinel failed");
    return {
      evidenceType: "startup-guard",
      checks: [
        { environmentName: "payments-prd-eu", declaredKind: "preview", listenerStarted, denialCode },
        { request: "GET /_gauntlet/v1/health", status: 404, adapterMounted: false },
        { request: "GET /host-health", status: 200, hostApplicationAlive: true },
      ],
    };
  } finally {
    await stop(host);
  }
}

assertState();
if (process.argv.length === 4 && process.argv[2] === "--probe" && process.argv[3] === key) {
  record(scenario === "spring-ingress" ? await springProbe() : await aliasProbe());
  process.stdout.write(`${key}: PASS (synthetic loopback; customer deployment not verified)\n`);
} else if (process.argv.length === 2) {
  validateEvidence();
  process.stdout.write("unsafe forward fixture remains disabled with observed synthetic evidence; customer deployment not verified\n");
} else {
  process.stderr.write(`Usage: node verify.mjs [--probe ${key}]\n`);
  process.exitCode = 2;
}
