#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { relative, resolve, sep } from "node:path";

import { stageComposerPackages } from "../../scripts/release/stage-composer.mjs";

const scenarios = new Set([
  "prod-alias",
  "public-ingress",
  "unstable-runtime",
  "next-raw-path",
  "valid-symfony",
  "valid-compose",
  "forward-spring-ingress",
]);

const VALID_COMPOSE_RUNTIME_DEPENDENCY_PINS = Object.freeze({
  ajv: "8.20.0",
  "ajv-formats": "3.0.1",
  canonicalize: "4.0.0",
  "fast-deep-equal": "3.1.3",
  "fast-uri": "3.1.8",
  "json-schema-traverse": "1.0.0",
  "require-from-string": "2.0.2",
});

function write(root, path, contents, mode = 0o600) {
  const destination = resolve(root, path);
  mkdirSync(resolve(destination, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(destination, contents, { mode });
}

function regularTreeSha256(directory, { excludeTopLevel = [] } = {}) {
  const root = resolve(directory);
  const files = [];
  const excluded = new Set(excludeTopLevel);
  const walk = (current, depth = 0) => {
    for (const entry of readdirSync(current, { withFileTypes: true })
      .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)))) {
      if (depth === 0 && excluded.has(entry.name)) continue;
      const path = resolve(current, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`artifact contains a symbolic link: ${path}`);
      if (stat.isDirectory()) walk(path, depth + 1);
      else if (stat.isFile() && stat.nlink === 1) files.push(path);
      else throw new Error(`artifact contains a non-regular entry: ${path}`);
    }
  };
  walk(root);
  const hash = createHash("sha256");
  for (const path of files) {
    const name = relative(root, path).split(sep).join("/");
    hash.update(name);
    hash.update(Buffer.from([0]));
    hash.update(readFileSync(path));
    hash.update(Buffer.from([0]));
  }
  return `sha256:${hash.digest("hex")}`;
}

function packedPackageTreeSha256(archivePath, scratchDirectory) {
  rmSync(scratchDirectory, { recursive: true, force: true });
  mkdirSync(scratchDirectory, { recursive: true, mode: 0o700 });
  try {
    const extracted = spawnSync("tar", ["-xzf", archivePath, "-C", scratchDirectory], {
      encoding: "utf8",
      timeout: 30_000,
    });
    if (extracted.status !== 0) throw new Error(`failed to inspect packed package: ${extracted.stderr || extracted.stdout}`);
    return regularTreeSha256(resolve(scratchDirectory, "package"), { excludeTopLevel: ["node_modules"] });
  } finally {
    rmSync(scratchDirectory, { recursive: true, force: true });
  }
}

function trustedVerifierDependencyPaths(repositoryRoot) {
  const ajvPath = realpathSync(resolve(repositoryRoot, "packages/dashboard-client/node_modules/ajv"));
  const ajvDependencyRoot = resolve(ajvPath, "..");
  return {
    dashboardClientTreeSha256: realpathSync(resolve(repositoryRoot, "packages/dashboard-client")),
    protocolTreeSha256: realpathSync(resolve(repositoryRoot, "packages/protocol")),
    ajvTreeSha256: ajvPath,
    ajvFormatsTreeSha256: realpathSync(resolve(repositoryRoot, "packages/dashboard-client/node_modules/ajv-formats")),
    canonicalizeTreeSha256: realpathSync(resolve(repositoryRoot, "packages/protocol/node_modules/canonicalize")),
    fastDeepEqualTreeSha256: realpathSync(resolve(ajvDependencyRoot, "fast-deep-equal")),
    fastUriTreeSha256: realpathSync(resolve(ajvDependencyRoot, "fast-uri")),
    jsonSchemaTraverseTreeSha256: realpathSync(resolve(ajvDependencyRoot, "json-schema-traverse")),
    requireFromStringTreeSha256: realpathSync(resolve(ajvDependencyRoot, "require-from-string")),
    yamlPackageSha256: realpathSync(resolve(repositoryRoot, "node_modules/yaml")),
  };
}

function pressureFixture(root, scenario) {
  const states = {
    "prod-alias": {
      environment: { deployment: "customer-prod-eu", application: "prod-eu" },
      adapter: { enabled: false, kind: null, productionOverride: false },
    },
    "public-ingress": {
      environment: { deployment: "customer-staging", application: "staging" },
      ingress: { visibility: "public", paths: ["/*"], adapterPrefixDenied: false },
      adapter: { enabled: false },
    },
    "unstable-runtime": {
      environment: { deployment: "customer-staging", replicas: 3 },
      runtime: { secret: "<generated-per-pod>", runStore: "memory", coordinator: "memory" },
      adapter: { enabled: false },
    },
    "next-raw-path": {
      environment: { deployment: "customer-staging" },
      ingress: { visibility: "public", normalizesRawPath: true, adapterPrefixDenied: false },
      tests: { decodedRoute: true, trustedRawTarget: false },
      adapter: { hardenedClaim: false },
    },
    "forward-spring-ingress": {
      environment: { deployment: "orders-preview", application: "preview", kind: "preview" },
      network: {
        serviceVisibility: "private",
        sharedIngressVisibility: "public",
        sharedIngressPaths: ["/*"],
        adapterPrefixDenied: false,
      },
      runtime: {
        currentReplicas: 1,
        autoscalerPlanned: true,
        futureMaxReplicas: 4,
        runStore: "memory",
        coordinator: "memory",
      },
      adapter: { enabled: false },
    },
  };
  write(root, "state.json", `${JSON.stringify(states[scenario], null, 2)}\n`);
  write(root, "verify-unchanged.mjs", [
    'import { readFileSync } from "node:fs";',
    `const expected = ${JSON.stringify(JSON.stringify(states[scenario], null, 2) + "\n")};`,
    'if (readFileSync(new URL("state.json", import.meta.url), "utf8") !== expected) process.exit(1);',
    'process.stdout.write("fixture unchanged; unsafe integration remains disabled\\n");',
    "",
  ].join("\n"));
}

function syntheticLoopbackHttpHarness(protocolValidation) {
  const SCOPE = "synthetic-ephemeral-loopback-http";
  const PREFIX = "/_gauntlet/v1";
  let observedHttpExchanges = 0;
  const sha256 = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
  const canonicalJson = (value) => {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  };
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  assert(protocolValidation !== null && typeof protocolValidation === "object", "protocol validators missing");
  const responseJson = (response, status, body, contentType = "application/json") => {
    response.writeHead(status, { "content-type": contentType });
    response.end(`${JSON.stringify(body)}\n`);
  };
  const responseProblem = (response, status, type, title, details = {}) => {
    const problem = { type, title, status, ...details };
    assert(protocolValidation.problem(problem), "synthetic Problem violates Adapter v1");
    return responseJson(response, status, problem, "application/problem+json");
  };
  const responseNotFound = (response) => {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not Found\n");
  };
  const adapterRouteCandidate = (rawTarget) => {
    let path;
    try {
      path = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(rawTarget)
        ? new URL(rawTarget).pathname
        : rawTarget.split(/[?#]/u, 1)[0];
      path = path.replaceAll("\\", "/");
      if (path === PREFIX || path.startsWith(`${PREFIX}/`)) return true;
      path = decodeURIComponent(path).replaceAll("\\", "/").replace(/\/{2,}/gu, "/");
      path = new URL(path, "http://loopback.invalid").pathname;
    } catch {
      return false;
    }
    return path === PREFIX || path.startsWith(`${PREFIX}/`);
  };
  const environmentAllowed = (environment) => {
    const kinds = new Set(["development", "test", "qa", "staging", "uat", "preview", "sandbox"]);
    const productionToken = /(^|[._:-])(prod|production|live)($|[._:-])/i;
    return environment !== null && typeof environment === "object"
      && typeof environment.name === "string" && !productionToken.test(environment.name)
      && kinds.has(environment.kind);
  };
  const startupGuard = ({ enabled, id, label, environment, idempotencySecret }) => {
    if (enabled !== true) return;
    const deny = (code) => {
      const error = new Error(`synthetic adapter startup denied: ${code}`);
      error.code = code;
      throw error;
    };
    if (typeof id !== "string" || id.trim() === "") deny("APPLICATION_ID_REQUIRED");
    if (typeof label !== "string" || label.trim() === "") deny("APPLICATION_LABEL_REQUIRED");
    if (environment === null || typeof environment !== "object" || Array.isArray(environment)) deny("ENVIRONMENT_REQUIRED");
    if (typeof environment.name !== "string" || environment.name.trim() === "") deny("ENVIRONMENT_NAME_REQUIRED");
    if (typeof environment.kind !== "string" || environment.kind.trim() === "") deny("ENVIRONMENT_KIND_REQUIRED");
    if (!environmentAllowed(environment)) deny("NON_PRODUCTION_ENVIRONMENT_REQUIRED");
    if (typeof idempotencySecret !== "string" || idempotencySecret === "") deny("IDEMPOTENCY_SECRET_REQUIRED");
    if (idempotencySecret.length < 32) deny("IDEMPOTENCY_SECRET_TOO_SHORT");
  };
  const sameEnvironment = (left, right) => left?.name === right?.name && left?.kind === right?.kind;
  const operationDefinition = () => {
    const draft = {
      id: "fixture.safe",
      featureId: "fixture",
      label: "Synthetic safe operation",
      order: 0,
      tags: [],
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: ["value"],
        properties: { value: { type: "string", minLength: 1 } },
      },
      contextSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
      },
      dataSources: [],
      presets: [],
      execution: {
        impact: "write",
        confirmationRequired: true,
        dryRunSupported: true,
        idempotency: "required",
        cancellationSupported: false,
      },
      output: {
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          additionalProperties: false,
          required: ["accepted"],
          properties: { accepted: { type: "boolean" } },
        },
      },
    };
    return { ...draft, revision: sha256(canonicalJson(draft)) };
  };
  const manifest = ({ id, label, environment, operation }) => {
    const body = {
      protocolVersion: "1.0",
      schemaDialect: "https://json-schema.org/draft/2020-12/schema",
      profiles: ["tc-schema-core@1", "tc-rich-forms@1", "tc-rich-results@1"],
      capabilities: [],
      application: { id, label, environment },
      features: [{ id: "fixture", label: "Fixture", order: 0 }],
      operations: [{
        id: operation.id,
        revision: operation.revision,
        featureId: operation.featureId,
        label: operation.label,
        availability: { state: "available" },
      }],
      dataSources: [{
        id: "fixture.items",
        label: "Synthetic items",
        capabilities: {
          search: true,
          pagination: "cursor",
          resolve: true,
          defaultLimit: 10,
          maxLimit: 25,
        },
      }],
    };
    return {
      protocolVersion: body.protocolVersion,
      manifestRevision: sha256(canonicalJson(body)),
      schemaDialect: body.schemaDialect,
      profiles: body.profiles,
      capabilities: body.capabilities,
      application: body.application,
      features: body.features,
      operations: body.operations,
      dataSources: body.dataSources,
    };
  };
  const adapterHandler = ({ enabled, id, label, environment, counters = {} }) => {
    if (!environmentAllowed(environment)) {
      const error = new Error("synthetic adapter startup denied");
      error.code = "NON_PRODUCTION_ENVIRONMENT_REQUIRED";
      throw error;
    }
    const operation = operationDefinition();
    const adapterManifest = manifest({ id, label, environment, operation });
    assert(protocolValidation.operation(operation), "synthetic operation violates Adapter v1");
    assert(protocolValidation.manifest(adapterManifest), "synthetic manifest violates Adapter v1");
    const runsByIdempotencyKey = new Map();
    const runsById = new Map();
    const readBody = async (incoming) => {
      const chunks = [];
      let size = 0;
      for await (const chunk of incoming) {
        size += chunk.length;
        assert(size <= 16_384, "synthetic request body is too large");
        chunks.push(chunk);
      }
      if (size === 0) return undefined;
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    };
    return async (request, response) => {
      const target = new URL(request.url, "http://loopback.invalid").pathname;
      if (!adapterRouteCandidate(request.url)) return responseNotFound(response);
      if (enabled !== true) {
        return responseProblem(response, 503, "urn:gauntlet:problem:adapter-disabled", "Gauntlet adapter disabled");
      }
      if (request.method === "GET" && target === `${PREFIX}/health`) {
        counters.health = (counters.health ?? 0) + 1;
        const health = { status: "ok", protocolVersion: "1.0" };
        assert(protocolValidation.health(health), "synthetic health violates Adapter v1");
        return responseJson(response, 200, health);
      }
      if (request.method === "GET" && target === `${PREFIX}/manifest`) {
        counters.manifest = (counters.manifest ?? 0) + 1;
        return responseJson(response, 200, adapterManifest);
      }
      if (request.method === "GET" && target === `${PREFIX}/operations/${operation.id}`) {
        counters.definition = (counters.definition ?? 0) + 1;
        return responseJson(response, 200, operation);
      }
      if (request.method === "POST" && target === `${PREFIX}/operations/fixture.safe/runs`) {
        counters.operation = (counters.operation ?? 0) + 1;
        const body = await readBody(request);
        assert(protocolValidation.createRunRequest(body), "synthetic create request violates Adapter v1");
        if (body?.operationRevision !== operation.revision) {
          return responseProblem(response, 409, "urn:gauntlet:problem:stale-operation-revision", "Stale operation revision");
        }
        const inputKeys = body?.input !== null && typeof body?.input === "object" && !Array.isArray(body.input)
          ? Object.keys(body.input)
          : [];
        if (inputKeys.length !== 1 || inputKeys[0] !== "value" || typeof body.input.value !== "string" || body.input.value.length === 0) {
          return responseProblem(response, 422, "urn:gauntlet:problem:validation-failed", "Input validation failed", {
            errors: [{
              instancePath: "/input/value",
              schemaPath: "#/properties/value/type",
              keyword: "type",
              message: "must be string",
              params: { type: "string" },
            }],
          });
        }
        if (typeof body.idempotencyKey !== "string" || body.idempotencyKey.length === 0) {
          return responseProblem(response, 422, "urn:gauntlet:problem:idempotency-key-required", "Idempotency key required");
        }
        const prior = runsByIdempotencyKey.get(body.idempotencyKey);
        if (prior !== undefined) return responseJson(response, 201, prior);
        const timestamp = "2026-01-01T00:00:00.000Z";
        const run = {
          id: `synthetic-${id}-run`,
          operationId: operation.id,
          operationRevision: operation.revision,
          state: "succeeded",
          sequence: 2,
          createdAt: timestamp,
          updatedAt: timestamp,
          startedAt: timestamp,
          completedAt: timestamp,
          summary: { title: "Synthetic run completed", tone: "success" },
          output: { accepted: true },
          artifacts: [],
          actions: [],
        };
        runsByIdempotencyKey.set(body.idempotencyKey, run);
        runsById.set(run.id, run);
        assert(protocolValidation.run(run, operation, adapterManifest), "synthetic run violates Adapter v1");
        return responseJson(response, 201, run);
      }
      const runMatch = new RegExp(`^${PREFIX}/runs/([A-Za-z0-9._:-]+)$`, "u").exec(target);
      if (request.method === "GET" && runMatch !== null) {
        const run = runsById.get(runMatch[1]);
        if (run === undefined) return responseProblem(response, 404, "urn:gauntlet:problem:run-not-found", "Run not found");
        return responseJson(response, 200, run);
      }
      if (request.method === "POST" && target === `${PREFIX}/data-sources/fixture.items/query`) {
        const body = await readBody(request);
        assert(protocolValidation.dataSourceQuery(body), "synthetic data-source query violates Adapter v1");
        counters.dataSourceQuery = (counters.dataSourceQuery ?? 0) + 1;
        const page = { items: [{ value: "item-1", label: "Synthetic item" }] };
        assert(protocolValidation.dataSourcePage(page), "synthetic data-source page violates Adapter v1");
        return responseJson(response, 200, page);
      }
      if (request.method === "POST" && target === `${PREFIX}/data-sources/fixture.items/resolve`) {
        const body = await readBody(request);
        assert(protocolValidation.dataSourceResolveRequest(body), "synthetic data-source resolve request violates Adapter v1");
        counters.dataSourceResolve = (counters.dataSourceResolve ?? 0) + 1;
        const resolved = {
          results: body.values.map((value) => ({
            value,
            item: value === "item-1" ? { value, label: "Synthetic item" } : null,
          })),
        };
        assert(protocolValidation.dataSourceResolveResponse(resolved), "synthetic data-source resolve response violates Adapter v1");
        return responseJson(response, 200, resolved);
      }
      return responseNotFound(response);
    };
  };
  const start = async (handler) => {
    const server = createServer((request, response) => {
      Promise.resolve(handler(request, response)).catch(() => {
        if (!response.headersSent) responseProblem(response, 500, "about:blank", "Synthetic harness failure");
        else response.destroy();
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address !== null && typeof address === "object" && address.address === "127.0.0.1", "server did not bind to loopback");
    return server;
  };
  const stop = async (server) => {
    server.close();
    await once(server, "close");
  };
  const request = async (server, path, options = {}) => {
    const address = server.address();
    assert(address !== null && typeof address === "object", "server is not listening");
    const result = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: options.method ?? "GET",
      headers: options.body === undefined ? options.headers : { "content-type": "application/json", ...options.headers },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: "error",
      signal: AbortSignal.timeout(2_000),
    });
    const raw = await result.text();
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
    observedHttpExchanges += 1;
    return {
      status: result.status,
      contentType: result.headers.get("content-type")?.split(";", 1)[0] ?? "",
      body,
    };
  };
  const requestRawTarget = (server, rawTarget, options = {}) => new Promise((resolveRequest, rejectRequest) => {
    const address = server.address();
    assert(address !== null && typeof address === "object", "server is not listening");
    const outgoing = httpClientRequest({
      host: "127.0.0.1",
      port: address.port,
      method: options.method ?? "GET",
      path: rawTarget,
      headers: { connection: "close", ...(options.headers ?? {}) },
    }, (incoming) => {
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let body;
        try { body = JSON.parse(raw); } catch { body = raw; }
        observedHttpExchanges += 1;
        resolveRequest({
          status: incoming.statusCode,
          contentType: incoming.headers["content-type"]?.split(";", 1)[0] ?? "",
          body,
        });
      });
    });
    outgoing.once("error", rejectRequest);
    outgoing.setTimeout(2_000, () => outgoing.destroy(new Error("synthetic raw-target request timed out")));
    outgoing.end();
  });
  const requestRawLine = (server, requestLine, headers = ["Host: adapter", "Connection: close"]) => new Promise((resolveRequest, rejectRequest) => {
    const address = server.address();
    assert(address !== null && typeof address === "object", "server is not listening");
    const socket = connect(address.port, "127.0.0.1");
    let response = "";
    socket.setEncoding("latin1");
    socket.setTimeout(2_000, () => socket.destroy(new Error("synthetic raw request timed out")));
    socket.on("connect", () => socket.end(`${requestLine}\r\n${headers.join("\r\n")}\r\n\r\n`));
    socket.on("data", (chunk) => { response += chunk; });
    socket.once("error", rejectRequest);
    socket.on("close", () => {
      const match = /^HTTP\/1\.1 (\d{3})[^\r\n]*\r\n([\s\S]*)$/u.exec(response);
      if (match === null) return rejectRequest(new Error("synthetic raw HTTP response missing"));
      const [headerBlock, rawBody = ""] = match[2].split("\r\n\r\n", 2);
      const contentType = /^content-type:\s*([^;\r\n]+)/imu.exec(headerBlock)?.[1] ?? "";
      let body;
      try { body = JSON.parse(rawBody); } catch { body = rawBody; }
      observedHttpExchanges += 1;
      resolveRequest({ status: Number(match[1]), contentType, body });
    });
  });
  const controlPlaneHandler = ({ adapter, expectedEnvironment, counters = {} }) => async (incoming, response) => {
    const target = new URL(incoming.url, "http://loopback.invalid").pathname;
    if (!target.startsWith("/proxy")) return responseNotFound(response);
    const manifestResult = await request(adapter, `${PREFIX}/manifest`);
    assert(manifestResult.status === 200 && manifestResult.contentType === "application/json", "manifest discovery failed");
    counters.discovery = (counters.discovery ?? 0) + 1;
    if (!sameEnvironment(manifestResult.body?.application?.environment, expectedEnvironment)) {
      return responseProblem(
        response,
        503,
        "urn:gauntlet:problem:target-environment-mismatch",
        "Target environment mismatch",
      );
    }
    const downstreamPath = target.slice("/proxy".length);
    let body;
    if (incoming.method !== "GET" && incoming.method !== "HEAD") {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      if (chunks.length > 0) body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }
    const result = await request(adapter, downstreamPath, { method: incoming.method, body });
    responseJson(response, result.status, result.body, result.contentType);
  };
  const assertHealth = (result) => {
    assert(result.status === 200, "health status is not 200");
    assert(result.contentType === "application/json", "health media type is not application/json");
    assert(result.body?.status === "ok" && result.body?.protocolVersion === "1.0", "health is not Adapter v1");
  };
  const assertManifest = (result, expected) => {
    assert(result.status === 200, "manifest status is not 200");
    assert(result.contentType === "application/json", "manifest media type is not application/json");
    const body = result.body;
    assert(body?.protocolVersion === "1.0", "manifest protocol version is not 1.0");
    assert(/^sha256:[0-9a-f]{64}$/u.test(body?.manifestRevision), "manifest revision is not sha256");
    assert(body?.schemaDialect === "https://json-schema.org/draft/2020-12/schema", "manifest schema dialect is invalid");
    assert(Array.isArray(body?.profiles) && Array.isArray(body?.capabilities), "manifest profiles are invalid");
    assert(Array.isArray(body?.features) && Array.isArray(body?.operations) && Array.isArray(body?.dataSources), "manifest catalog is invalid");
    assert(body.features.some((entry) => entry?.id === "fixture"), "fixture feature missing");
    assert(body.operations.some((entry) => entry?.id === "fixture.safe" && /^sha256:[0-9a-f]{64}$/u.test(entry?.revision)), "fixture operation missing");
    assert(body.dataSources.some((entry) => entry?.id === "fixture.items"), "fixture data source missing");
    assert(body?.application?.id === expected.id && body?.application?.label === expected.label, "manifest application is invalid");
    assert(sameEnvironment(body?.application?.environment, expected.environment), "manifest environment is invalid");
  };
  const exerciseProtocol = async (server, basePath) => {
    const definition = await request(server, `${basePath}/operations/fixture.safe`);
    assert(definition.status === 200 && /^sha256:[0-9a-f]{64}$/u.test(definition.body?.revision), "operation definition is invalid");
    const stale = await request(server, `${basePath}/operations/fixture.safe/runs`, {
      method: "POST",
      body: {
        operationRevision: `sha256:${"0".repeat(64)}`,
        input: { value: "safe" },
        idempotencyKey: "synthetic-stale",
        confirmation: { operationId: "fixture.safe", operationRevision: `sha256:${"0".repeat(64)}`, impact: "write" },
      },
    });
    assert(stale.status === 409 && stale.body?.type === "urn:gauntlet:problem:stale-operation-revision", "stale revision was not rejected");
    const invalid = await request(server, `${basePath}/operations/fixture.safe/runs`, {
      method: "POST",
      body: {
        operationRevision: definition.body.revision,
        input: { value: 7 },
        idempotencyKey: "synthetic-invalid",
        confirmation: { operationId: "fixture.safe", operationRevision: definition.body.revision, impact: "write" },
      },
    });
    assert(invalid.status === 422 && invalid.body?.type === "urn:gauntlet:problem:validation-failed"
      && invalid.body?.errors?.[0]?.instancePath === "/input/value", "invalid input was not rejected at its pointer");
    const createRequest = {
      method: "POST",
      body: {
        operationRevision: definition.body.revision,
        input: { value: "safe" },
        idempotencyKey: "synthetic-replay",
        confirmation: { operationId: "fixture.safe", operationRevision: definition.body.revision, impact: "write" },
      },
    };
    const created = await request(server, `${basePath}/operations/fixture.safe/runs`, createRequest);
    const replay = await request(server, `${basePath}/operations/fixture.safe/runs`, createRequest);
    assert(created.status === 201 && replay.status === 201 && created.body?.id === replay.body?.id, "idempotent create did not replay the run");
    assert(!JSON.stringify([created.body, replay.body]).includes("synthetic-replay"), "raw idempotency key leaked");
    const polled = await request(server, `${basePath}/runs/${encodeURIComponent(created.body.id)}`);
    assert(polled.status === 200 && polled.body?.state === "succeeded" && polled.body?.sequence === 2, "run did not reach a valid terminal state");
    const query = await request(server, `${basePath}/data-sources/fixture.items/query`, {
      method: "POST",
      body: { search: "Synthetic", limit: 10, dependencies: {}, context: { requestId: "synthetic-query" } },
    });
    const resolved = await request(server, `${basePath}/data-sources/fixture.items/resolve`, {
      method: "POST",
      body: { values: ["item-1"], dependencies: {}, context: { requestId: "synthetic-resolve" } },
    });
    assert(query.status === 200 && query.body?.items?.[0]?.value === "item-1", "data-source query failed");
    assert(resolved.status === 200 && resolved.body?.results?.[0]?.value === "item-1"
      && resolved.body.results[0].item?.value === "item-1", "data-source resolve failed");
    return {
      operationDefinitionStatus: definition.status,
      staleRevisionStatus: stale.status,
      invalidInputStatus: invalid.status,
      idempotentReplay: created.body.id === replay.body.id,
      terminalState: polled.body.state,
      dataSourceQueryStatus: query.status,
      dataSourceResolveStatus: resolved.status,
    };
  };
  const httpExchangeCount = () => observedHttpExchanges;
  const makeObservation = (evidenceType, checks, exchangeCountBefore, integrity = {}) => {
    const httpExchanges = observedHttpExchanges - exchangeCountBefore;
    assert(Number.isSafeInteger(httpExchanges) && httpExchanges > 0, "probe completed without an HTTP exchange");
    return {
      passed: true,
      evidenceType,
      scope: SCOPE,
      observedAt: new Date().toISOString(),
      httpExchanges,
      checks,
      ...integrity,
    };
  };
  const record = (evidencePath, key, observation, probeKeys) => {
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    const probeRun = (evidence.probeRuns[key] ?? 0) + 1;
    const history = evidence.observationHistory[key] ?? [];
    assert(Array.isArray(history) && history.length < 8, `probe receipt history is invalid or full: ${key}`);
    const previousReceiptSha256 = history.length === 0 ? null : history.at(-1).receiptSha256;
    const payload = { ...observation, probeRun, previousReceiptSha256 };
    const serialized = JSON.stringify(payload);
    assert(serialized.length <= 8_192, "observation exceeds bounded evidence limit");
    assert(!/:\d{4,5}\b/u.test(serialized), "ephemeral port leaked into evidence");
    if (evidence.receiptMode !== "observations-only") evidence[key] = true;
    evidence.probeRuns[key] = probeRun;
    const receipt = {
      ...payload,
      receiptSha256: sha256(canonicalJson(payload)),
    };
    evidence.observations[key] = receipt;
    evidence.observationHistory[key] = [...history, receipt];
    evidence.commands = probeKeys
      .filter((probeKey) => evidence.observations[probeKey] !== undefined)
      .map((probeKey) => `node verify.mjs --probe ${probeKey} => PASS (${SCOPE})`);
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  };
  const validateEvidence = (evidence, probeKeys, currentReceiptDigests = {}) => {
    assert(evidence.scope === SCOPE, "evidence scope is missing");
    assert(evidence.customerDeploymentVerified === false, "synthetic fixture cannot verify a customer deployment");
    const minimumProbeRuns = evidence.minimumProbeRuns ?? 1;
    assert(Number.isSafeInteger(minimumProbeRuns) && minimumProbeRuns > 0, "minimum probe replay count is invalid");
    if (evidence.receiptMode === "observations-only") {
      for (const key of probeKeys) assert(!(key in evidence), `top-level probe boolean is forbidden: ${key}`);
    }
    assert(evidence.observations !== null && typeof evidence.observations === "object" && !Array.isArray(evidence.observations), "observations missing");
    assert(evidence.observationHistory !== null && typeof evidence.observationHistory === "object"
      && !Array.isArray(evidence.observationHistory), "observation history missing");
    assert(evidence.probeRuns !== null && typeof evidence.probeRuns === "object" && !Array.isArray(evidence.probeRuns), "probe run counters missing");
    assert(JSON.stringify(Object.keys(evidence.probeRuns).sort()) === JSON.stringify([...probeKeys].sort()), "unexpected probe run counters");
    assert(JSON.stringify(Object.keys(evidence.observationHistory).sort()) === JSON.stringify([...probeKeys].sort()), "unexpected observation histories");
    const evidenceTypes = new Set(["http-loopback", "configuration-and-http-loopback", "startup-guard"]);
    for (const key of probeKeys) {
      if (evidence.receiptMode !== "observations-only") assert(evidence[key] === true, `missing evidence: ${key}`);
      assert(Number.isSafeInteger(evidence.probeRuns[key]) && evidence.probeRuns[key] >= minimumProbeRuns, `probe was not replayed enough times: ${key}`);
      const receipt = evidence.observations[key];
      assert(receipt !== null && typeof receipt === "object" && receipt.passed === true, `missing observed receipt: ${key}`);
      assert(receipt.probeRun === evidence.probeRuns[key], `receipt replay counter mismatch: ${key}`);
      const history = evidence.observationHistory[key];
      assert(Array.isArray(history) && history.length === evidence.probeRuns[key]
        && history.length >= minimumProbeRuns && history.length <= 8, `invalid probe receipt history: ${key}`);
      let previousReceiptSha256 = null;
      for (let index = 0; index < history.length; index += 1) {
        const historicalReceipt = history[index];
        assert(historicalReceipt !== null && typeof historicalReceipt === "object" && !Array.isArray(historicalReceipt),
          `invalid historical receipt: ${key}`);
        assert(JSON.stringify(Object.keys(historicalReceipt).sort()) === JSON.stringify(Object.keys(receipt).sort()),
          `historical receipt fields changed: ${key}`);
        assert(historicalReceipt.passed === true && evidenceTypes.has(historicalReceipt.evidenceType)
          && historicalReceipt.scope === SCOPE, `invalid historical evidence scope: ${key}`);
        assert(Number.isSafeInteger(historicalReceipt.httpExchanges) && historicalReceipt.httpExchanges > 0,
          `missing historical HTTP evidence: ${key}`);
        assert(typeof historicalReceipt.observedAt === "string" && !Number.isNaN(Date.parse(historicalReceipt.observedAt))
          && new Date(historicalReceipt.observedAt).toISOString() === historicalReceipt.observedAt,
        `invalid historical observation time: ${key}`);
        assert(Array.isArray(historicalReceipt.checks) && historicalReceipt.checks.length > 0
          && historicalReceipt.checks.length <= 12, `invalid historical checks: ${key}`);
        assert(historicalReceipt?.probeRun === index + 1, `non-consecutive probe receipt history: ${key}`);
        assert(historicalReceipt.previousReceiptSha256 === previousReceiptSha256, `broken probe receipt chain: ${key}`);
        const { receiptSha256: historicalHash, ...historicalPayload } = historicalReceipt;
        assert(historicalHash === sha256(canonicalJson(historicalPayload)), `tampered historical receipt: ${key}`);
        for (const digestName of evidence.requiredReceiptDigests ?? []) {
          if (currentReceiptDigests[digestName] !== undefined) {
            assert(historicalReceipt[digestName] === currentReceiptDigests[digestName],
              `stale historical receipt digest ${digestName}: ${key}`);
          }
        }
        previousReceiptSha256 = historicalHash;
        assert(JSON.stringify(historicalReceipt).length <= 8_384, `oversized historical receipt: ${key}`);
        assert(!/:\d{4,5}\b/u.test(JSON.stringify(historicalReceipt)), `ephemeral port leaked into historical receipt: ${key}`);
      }
      assert(canonicalJson(history.at(-1)) === canonicalJson(receipt), `latest observation differs from history: ${key}`);
      assert(evidenceTypes.has(receipt.evidenceType) && receipt.scope === SCOPE, `invalid evidence scope: ${key}`);
      assert(Number.isSafeInteger(receipt.httpExchanges) && receipt.httpExchanges > 0, `missing HTTP evidence: ${key}`);
      assert(typeof receipt.observedAt === "string" && !Number.isNaN(Date.parse(receipt.observedAt))
        && new Date(receipt.observedAt).toISOString() === receipt.observedAt, `invalid observation time: ${key}`);
      assert(Array.isArray(receipt.checks) && receipt.checks.length > 0 && receipt.checks.length <= 12, `invalid checks: ${key}`);
      for (const digestName of evidence.requiredReceiptDigests ?? []) {
        assert(/^sha256:[0-9a-f]{64}$/u.test(receipt[digestName]), `missing receipt digest ${digestName}: ${key}`);
        if (currentReceiptDigests[digestName] !== undefined) {
          assert(receipt[digestName] === currentReceiptDigests[digestName], `stale receipt digest ${digestName}: ${key}`);
        }
      }
      const { receiptSha256, ...observation } = receipt;
      assert(receiptSha256 === sha256(canonicalJson(observation)), `tampered receipt: ${key}`);
      assert(JSON.stringify(receipt).length <= 8_384, `oversized receipt: ${key}`);
    }
    const expectedCommands = probeKeys.map((key) => `node verify.mjs --probe ${key} => PASS (${SCOPE})`);
    assert(JSON.stringify(evidence.commands) === JSON.stringify(expectedCommands), "command/output evidence missing");
  };
  const help = (probeKeys, minimumProbeRuns = 1) => [
    "Synthetic fixture verifier (ephemeral HTTP servers bound to 127.0.0.1).",
    "It verifies only this generated fixture; it is not customer-deployment evidence.",
    `Run every probe ${minimumProbeRuns === 1 ? "once" : "twice"}; receipts are integrity records, not trust or attestation.`,
    ...probeKeys.map((key) => `  node verify.mjs --probe ${key}`),
    "  node verify.mjs",
    "",
  ].join("\n");
  return {
    PREFIX,
    adapterRouteCandidate,
    adapterHandler,
    assert,
    assertHealth,
    assertManifest,
    canonicalJson,
    controlPlaneHandler,
    environmentAllowed,
    exerciseProtocol,
    help,
    httpExchangeCount,
    makeObservation,
    record,
    request,
    requestRawLine,
    requestRawTarget,
    sha256,
    start,
    startupGuard,
    stop,
    validateEvidence,
  };
}

function symfonyRuntimeKernelSource() {
  return `<?php

declare(strict_types=1);

namespace Gauntlet\\SymfonyExample;

use EightLines\\Gauntlet\\SymfonyBundle\\GauntletBundle;
use Symfony\\Bundle\\FrameworkBundle\\FrameworkBundle;
use Symfony\\Bundle\\FrameworkBundle\\Kernel\\MicroKernelTrait;
use Symfony\\Component\\DependencyInjection\\Loader\\Configurator\\ContainerConfigurator;
use Symfony\\Component\\HttpKernel\\Kernel as BaseKernel;
use Symfony\\Component\\Routing\\Loader\\Configurator\\RoutingConfigurator;

final class Kernel extends BaseKernel
{
    use MicroKernelTrait;

    public function registerBundles(): iterable
    {
        yield new FrameworkBundle();
        $bundles = require dirname(__DIR__, 4) . '/config/bundles.php';
        foreach ($bundles as $class => $environments) {
            if ($class === FrameworkBundle::class) {
                continue;
            }
            if (($environments[$this->environment] ?? $environments['all'] ?? false) === true) {
                yield new $class();
            }
        }
    }

    public function getProjectDir(): string
    {
        return dirname(__DIR__, 4);
    }

    public function getCacheDir(): string
    {
        return '/tmp/gauntlet-symfony-eval/cache/' . $this->environment . '-' . $this->mode();
    }

    public function getLogDir(): string
    {
        return '/tmp/gauntlet-symfony-eval/log';
    }

    protected function configureContainer(ContainerConfigurator $container): void
    {
        $container->extension('framework', [
            'secret' => 'synthetic-kernel-secret',
            'test' => true,
            'serializer' => ['enabled' => true],
            'validation' => ['enable_attributes' => true],
            'http_method_override' => false,
        ]);
        $mode = $this->mode();
        if ($mode === 'disabled') {
            $container->extension('gauntlet', ['enabled' => false]);
            return;
        }
        $application = [
            'id' => (string) getenv('GAUNTLET_APPLICATION_ID'),
            'label' => (string) getenv('GAUNTLET_APPLICATION_LABEL'),
            'environment' => [
                'name' => (string) getenv('GAUNTLET_ENVIRONMENT_NAME'),
                'kind' => (string) getenv('GAUNTLET_ENVIRONMENT_KIND'),
            ],
        ];
        $secret = (string) getenv('GAUNTLET_IDEMPOTENCY_SECRET');
        switch ($mode) {
            case 'missing-id': unset($application['id']); break;
            case 'missing-label': unset($application['label']); break;
            case 'missing-environment': unset($application['environment']); break;
            case 'missing-environment-name': unset($application['environment']['name']); break;
            case 'missing-environment-kind': unset($application['environment']['kind']); break;
            case 'short-secret': $secret = 'too-short'; break;
            case 'production-name': $application['environment']['name'] = 'customer:prod'; break;
            case 'production-kind': $application['environment']['kind'] = 'production'; break;
        }
        $configuration = [
            'enabled' => true,
            'application' => $application,
        ];
        if ($mode !== 'missing-secret') {
            $configuration['idempotency_secret'] = $secret;
        }
        $container->extension('gauntlet', $configuration);
    }

    protected function configureRoutes(RoutingConfigurator $routes): void
    {
        $routes->import('@GauntletBundle/config/routes.php');
    }

    private function mode(): string
    {
        return (string) (getenv('TC_FIXTURE_MODE') ?: 'enabled');
    }
}
`;
}

function symfonyRuntimeProbeSource() {
  return `<?php

declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

use Composer\\InstalledVersions;
use Symfony\\Component\\HttpFoundation\\Request;
use Gauntlet\\SymfonyExample\\Kernel;

$mode = $argv[1] ?? '';
$denialModes = [
    'missing-id',
    'missing-label',
    'missing-environment',
    'missing-environment-name',
    'missing-environment-kind',
    'missing-secret',
    'short-secret',
    'production-name',
    'production-kind',
];
if (!in_array($mode, array_merge(['enabled', 'disabled'], $denialModes), true) || count($argv) !== 2) {
    fwrite(STDERR, "Usage: php probe.php <enabled|disabled|startup-denial-case>\\n");
    exit(2);
}
putenv('TC_FIXTURE_MODE=' . $mode);
$kernel = new Kernel('staging', false);
$booted = false;
$bootError = null;
try {
    $kernel->boot();
    $booted = true;
} catch (Throwable $error) {
    $bootError = $error;
}
if (in_array($mode, $denialModes, true)) {
    if ($bootError === null) {
        $kernel->shutdown();
        throw new RuntimeException('unsafe bundle configuration unexpectedly booted: ' . $mode);
    }
    fwrite(STDOUT, json_encode([
        'runtime' => 'composer-installed-symfony-kernel',
        'configurationCase' => $mode,
        'startupDenied' => true,
        'listenerStarted' => false,
        'errorClass' => get_class($bootError),
    ], JSON_THROW_ON_ERROR) . "\\n");
    exit(0);
}
if ($bootError !== null) {
    throw $bootError;
}
try {
    $issue = static function (string $method, string $target) use ($kernel): array {
        $request = Request::create($target, $method, server: [
            'REQUEST_URI' => $target,
            'SERVER_PROTOCOL' => 'HTTP/1.1',
            'HTTP_HOST' => 'synthetic.internal',
        ]);
        $response = $kernel->handle($request);
        $body = json_decode((string) $response->getContent(), true, flags: JSON_THROW_ON_ERROR);
        $kernel->terminate($request, $response);
        return ['status' => $response->getStatusCode(), 'body' => $body];
    };
    $health = $issue('GET', '/_gauntlet/v1/health');
    $manifest = $issue('GET', '/_gauntlet/v1/manifest');
    if ($mode === 'disabled') {
        $ok = $health['status'] === 503
            && ($health['body']['type'] ?? null) === 'urn:gauntlet:problem:adapter-disabled'
            && $manifest['status'] === 503;
        $result = [
            'runtime' => 'composer-installed-symfony-kernel',
            'kernelRequest' => true,
            'disabledBoundary' => $ok,
            'healthStatus' => $health['status'],
            'manifestStatus' => $manifest['status'],
        ];
    } else {
        $ok = $health['status'] === 200
            && ($health['body']['protocolVersion'] ?? null) === '1.0'
            && $manifest['status'] === 200
            && ($manifest['body']['application']['environment'] ?? null) === ['name' => 'staging', 'kind' => 'staging'];
        $result = [
            'runtime' => 'composer-installed-symfony-kernel',
            'kernelRequest' => true,
            'healthStatus' => $health['status'],
            'manifestStatus' => $manifest['status'],
            'environment' => $manifest['body']['application']['environment'] ?? null,
            'phpVersion' => PHP_VERSION,
            'phpCoreVersion' => InstalledVersions::getPrettyVersion('8lines/gauntlet-php-core'),
            'symfonyBundleVersion' => InstalledVersions::getPrettyVersion('8lines/gauntlet-symfony-bundle'),
        ];
    }
    if (!$ok) {
        throw new RuntimeException('Symfony bundle runtime contract failed');
    }
    fwrite(STDOUT, json_encode($result, JSON_THROW_ON_ERROR) . "\\n");
} finally {
    if ($booted) {
        $kernel->shutdown();
    }
}
`;
}

async function validSymfonyFixture(root) {
  const repositoryRoot = realpathSync(resolve(import.meta.dirname, "../.."));
  const validatorBuilt = spawnSync("pnpm", [
    "--filter", "@8lines/gauntlet-dashboard-client...", "build",
  ], { cwd: repositoryRoot, encoding: "utf8", timeout: 120_000 });
  if (validatorBuilt.status !== 0) {
    throw new Error(`failed to build Symfony verifier dependencies: ${validatorBuilt.stderr || validatorBuilt.stdout}`);
  }
  const sourceCommit = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (sourceCommit.status !== 0 || !/^[0-9a-f]{40}\n$/u.test(sourceCommit.stdout)) {
    throw new Error("failed to resolve the Composer release source commit");
  }
  const composerArtifacts = resolve(realpathSync(root), "artifacts/composer");
  mkdirSync(composerArtifacts, { recursive: true, mode: 0o700 });
  const staged = await stageComposerPackages({
    root: repositoryRoot,
    outputDirectory: composerArtifacts,
    sourceCommit: sourceCommit.stdout.trim(),
  });
  const artifactHashes = Object.fromEntries(staged.map(({ repository, path }) => [repository, regularTreeSha256(path)]));

  write(root, "composer.json", `${JSON.stringify({
    name: "synthetic/staging-portal",
    type: "project",
    require: { php: ">=8.3", "symfony/framework-bundle": "7.4.*" },
  }, null, 2)}\n`);
  const runtimeProject = "runtime/examples/symfony";
  write(root, `${runtimeProject}/composer.json`, readFileSync(resolve(repositoryRoot, "examples/symfony/composer.json"), "utf8"));
  write(root, `${runtimeProject}/composer.lock`, readFileSync(resolve(repositoryRoot, "examples/symfony/composer.lock"), "utf8"));
  write(root, `${runtimeProject}/src/Kernel.php`, symfonyRuntimeKernelSource());
  write(root, `${runtimeProject}/probe.php`, symfonyRuntimeProbeSource());
  for (const [source, destination] of [
    ["artifacts/composer/8lines/gauntlet-php-core", "runtime/packages/php/core"],
    ["artifacts/composer/8lines/gauntlet-symfony-bundle", "runtime/packages/php/symfony-bundle"],
  ]) {
    mkdirSync(resolve(root, destination, ".."), { recursive: true, mode: 0o700 });
    cpSync(resolve(root, source), resolve(root, destination), { recursive: true, errorOnExist: true, force: false });
  }
  const composerRuntimeImage = "composer:2.10.3@sha256:4d045ea9f71d5d111a95e608400da61d187e487adf9eaf2dfe068998a8d4f584";
  const dockerUser = `${typeof process.getuid === "function" ? process.getuid() : 1000}:${typeof process.getgid === "function" ? process.getgid() : 1000}`;
  const installed = spawnSync("docker", [
    "run", "--rm", "--user", dockerUser, "--network", "bridge",
    "--env", "HOME=/tmp/home", "--env", "COMPOSER_HOME=/tmp/composer",
    "--env", "COMPOSER_CACHE_DIR=/tmp/composer-cache", "--env", "COMPOSER_NO_INTERACTION=1",
    "--env", "COMPOSER_PROCESS_TIMEOUT=300", "--mount", `type=bind,src=${realpathSync(root)},dst=/workspace`,
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=268435456", "--workdir", "/workspace/runtime/examples/symfony",
    "--entrypoint", "/bin/sh", composerRuntimeImage, "-eu", "-c",
    "composer config --global platform.php 8.3.33 && composer install --no-dev --no-interaction --no-plugins --no-progress --no-scripts --prefer-dist",
  ], {
    cwd: root,
    encoding: "utf8",
    timeout: 300_000,
    env: { PATH: process.env.PATH },
  });
  if (installed.status !== 0) {
    throw new Error(`failed to create the trusted Composer runtime tree: ${installed.stderr || installed.stdout}`);
  }
  const expectedSymfonyVendorHash = regularTreeSha256(resolve(root, runtimeProject, "vendor"));
  write(root, "config/bundles.php", "<?php\n\nreturn [];\n");
  write(root, "config/packages/staging/gauntlet.yaml", "gauntlet:\n  enabled: false\n");
  write(root, "config/routes/staging/gauntlet.yaml", "# Mount the supplied candidate bundle transport here.\n");
  write(root, "deployment/values.yaml", [
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
  write(root, "gauntlet/config.yaml", "# Add the explicit staging target here.\n");
  write(root, "evidence.json", `${JSON.stringify({
    scope: "synthetic-ephemeral-loopback-http",
    customerDeploymentVerified: false,
    receiptMode: "observations-only",
    minimumProbeRuns: 2,
    selfHashMeaning: "integrity-only-not-trust-or-attestation",
    requiredReceiptDigests: [
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
    ],
    observations: {},
    observationHistory: {},
    probeRuns: {},
    commands: [],
  }, null, 2)}\n`);
  write(root, "VERIFYING.md", [
    "# Synthetic verification harness",
    "",
    "After completing the fixture configuration, run `node verify.mjs --help`,",
    "execute every listed probe twice, and finish with `node verify.mjs`.",
    "",
    "The probes create short-lived HTTP servers bound only to `127.0.0.1` and",
    "write bounded receipts after observed checks pass. They verify this synthetic",
    "fixture only. They are not evidence from a Kubernetes or customer deployment.",
    "Receipt self-hashes can reveal accidental or stale edits; they do not establish",
    "trust, authenticity, or attestation because the verifier and receipt share a host.",
    "",
  ].join("\n"));
  const runtimeHashes = Object.fromEntries([
    `${runtimeProject}/composer.json`,
    `${runtimeProject}/composer.lock`,
    `${runtimeProject}/src/Kernel.php`,
    `${runtimeProject}/probe.php`,
  ].map((path) => [path, `sha256:${createHash("sha256").update(readFileSync(resolve(root, path))).digest("hex")}`]));
  const verifierDependencyPaths = trustedVerifierDependencyPaths(repositoryRoot);
  const verifierDependencyHashes = Object.fromEntries(Object.entries(verifierDependencyPaths)
    .map(([name, path]) => [name, regularTreeSha256(path, { excludeTopLevel: ["node_modules"] })]));
  write(root, "verify.mjs", validSymfonyVerifier(
    artifactHashes,
    runtimeHashes,
    verifierDependencyHashes,
    expectedSymfonyVendorHash,
    verifierDependencyPaths,
  ));
}

function validSymfonyVerifier(
  artifactHashes,
  runtimeHashes,
  verifierDependencyHashes,
  expectedSymfonyVendorHash,
  verifierDependencyPaths,
) {
  const validatorUrl = new URL("../../packages/dashboard-client/dist/protocol-validator.js", import.meta.url).href;
  const protocolUrl = new URL("../../packages/protocol/dist/index.js", import.meta.url).href;
  const yamlUrl = new URL("../../node_modules/yaml/dist/index.js", import.meta.url).href;
  return [
    'import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";',
    'import { createHash } from "node:crypto";',
    'import { spawnSync } from "node:child_process";',
    'import { createServer, request as httpClientRequest } from "node:http";',
    'import { connect } from "node:net";',
    'import { once } from "node:events";',
    'import { relative, resolve, sep } from "node:path";',
    `import { operationRunIsValid, protocolValidators, validates } from ${JSON.stringify(validatorUrl)};`,
    `import { manifestSemanticsAreValid, operationSemanticsAreValid } from ${JSON.stringify(protocolUrl)};`,
    `import { parse as parseYaml } from ${JSON.stringify(yamlUrl)};`,
    "",
    "const protocolValidation = Object.freeze({",
    "  health: (value) => validates(protocolValidators.health, value),",
    "  manifest: (value) => validates(protocolValidators.manifest, value) && manifestSemanticsAreValid(value),",
    "  operation: (value) => validates(protocolValidators.operation, value) && operationSemanticsAreValid(value),",
    "  createRunRequest: (value) => validates(protocolValidators.createRunRequest, value),",
    "  run: (value, operation, manifest) => operationRunIsValid(value, operation, manifest),",
    "  dataSourceQuery: (value) => validates(protocolValidators.dataSourceQuery, value),",
    "  dataSourcePage: (value) => validates(protocolValidators.dataSourcePage, value),",
    "  dataSourceResolveRequest: (value) => validates(protocolValidators.dataSourceResolveRequest, value),",
    "  dataSourceResolveResponse: (value) => validates(protocolValidators.dataSourceResolveResponse, value),",
    "  problem: (value) => validates(protocolValidators.problem, value),",
    "});",
    `const expectedComposerArtifactHashes = Object.freeze(${JSON.stringify(artifactHashes)});`,
    `const expectedSymfonyRuntimeHashes = Object.freeze(${JSON.stringify(runtimeHashes)});`,
    `const expectedVerifierDependencyHashes = Object.freeze(${JSON.stringify(verifierDependencyHashes)});`,
    `const expectedSymfonyVendorHash = ${JSON.stringify(expectedSymfonyVendorHash)};`,
    `const verifierDependencyPaths = Object.freeze(${JSON.stringify(verifierDependencyPaths)});`,
    `const regularTreeSha256 = ${regularTreeSha256.toString()};`,
    `const createSyntheticLoopbackHttpHarness = ${syntheticLoopbackHttpHarness.toString()};`,
    `await (${validSymfonyVerifierRuntime.toString()})(createSyntheticLoopbackHttpHarness(protocolValidation));`,
    "",
  ].join("\n");
}

async function validSymfonyVerifierRuntime(harness) {
const root = import.meta.dirname;
const json = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const text = (path) => readFileSync(resolve(root, path), "utf8");
const probeKeys = ["disabled", "startupDenied", "mismatchDenied", "syntheticProtocolExercise", "publicRouteDenied"];
if (process.argv.length === 3 && process.argv[2] === "--help") {
  process.stdout.write(harness.help(probeKeys, 2));
  return;
}
const exactJson = (actual, expected, message) => {
  if (harness.canonicalJson(actual) !== harness.canonicalJson(expected)) throw new Error(message);
};
const yaml = (path) => {
  const parsed = parseYaml(text(path), { maxAliasCount: 0, uniqueKeys: true });
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`YAML object required: ${path}`);
  return parsed;
};
const stripPhpComments = (source) => {
  let result = "";
  let state = "code";
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (state === "line") {
      if (current === "\n") { result += current; state = "code"; }
    } else if (state === "block") {
      if (current === "*" && next === "/") { index += 1; state = "code"; }
    } else if (state === "single" || state === "double") {
      result += current;
      if (current === "\\") {
        if (next !== undefined) { result += next; index += 1; }
      } else if ((state === "single" && current === "'") || (state === "double" && current === '"')) {
        state = "code";
      }
    } else if ((current === "/" && next === "/") || current === "#") {
      if (current === "/") index += 1;
      state = "line";
    } else if (current === "/" && next === "*") {
      index += 1;
      state = "block";
    } else {
      result += current;
      if (current === "'") state = "single";
      else if (current === '"') state = "double";
    }
  }
  if (state === "block" || state === "single" || state === "double") throw new Error("unterminated PHP token");
  return result;
};
const composer = json("composer.json");
const expected = {
  php: ">=8.3",
  "symfony/framework-bundle": "7.4.*",
  "8lines/gauntlet-php-core": "0.1.5",
  "8lines/gauntlet-symfony-bundle": "0.1.5",
};
exactJson(composer.require, expected, "exact PHP 8.3, Symfony 7.4, and supplied candidate Composer requirements missing");
if (Object.hasOwn(composer, "repositories")) {
  throw new Error("Packagist releases must not declare custom Composer repositories");
}
const bundles = text("config/bundles.php");
if (!/^\s*<\?php\s+use\s+EightLines\\Gauntlet\\SymfonyBundle\\GauntletBundle\s*;\s*return\s*\[\s*GauntletBundle::class\s*=>\s*\[\s*['"]staging['"]\s*=>\s*true\s*,?\s*\]\s*,?\s*\]\s*;\s*$/u.test(stripPhpComments(bundles))) {
  throw new Error("bundle must be enabled only in staging");
}
exactJson(yaml("config/packages/staging/gauntlet.yaml"), {
  gauntlet: {
    enabled: true,
    application: { id: "portal", label: "Portal", environment: { name: "staging", kind: "staging" } },
    idempotency_secret: "%env(GAUNTLET_IDEMPOTENCY_SECRET)%",
  },
}, "structured adapter configuration missing");
exactJson(yaml("config/routes/staging/gauntlet.yaml"), {
  gauntlet: { resource: "@GauntletBundle/config/routes.php", type: "php" },
}, "exactly one normalized transport missing");
exactJson(yaml("gauntlet/config.yaml"), {
  version: 1,
  instance: { name: "portal-staging", environment: { name: "staging", kind: "staging" } },
  targets: [{
    id: "portal",
    label: "Portal",
    adapterUrl: "http://portal.staging.svc.cluster.local:8080",
    expectedEnvironment: { name: "staging", kind: "staging" },
  }],
}, "explicit matching target missing");
exactJson(yaml("deployment/values.yaml"), {
  namespace: "staging",
  replicas: 1,
  publicIngress: { adapterPrefixDenied: true },
  privateAccess: { transport: "tailscale-internal-alb" },
  runtime: {
    processModel: "single-process",
    phpWorkers: 1,
    idempotencySecretReference: "GAUNTLET_IDEMPOTENCY_SECRET",
    runStore: "in-memory",
    coordinator: "in-memory",
    dispatcher: "current-process",
    eventHistory: "in-memory",
  },
}, "deployment safety evidence missing");
for (const [repository, expectedHash] of Object.entries(expectedComposerArtifactHashes)) {
  const path = resolve(root, "artifacts/composer", repository);
  harness.assert(regularTreeSha256(path) === expectedHash, `supplied candidate Composer artifact changed: ${repository}`);
  const artifact = json(`artifacts/composer/${repository}/composer.json`);
  harness.assert(artifact.name === repository && artifact.version === "0.1.5",
    `supplied candidate Composer artifact identity changed: ${repository}`);
}
for (const [path, expectedHash] of [
  ["runtime/packages/php/core", expectedComposerArtifactHashes["8lines/gauntlet-php-core"]],
  ["runtime/packages/php/symfony-bundle", expectedComposerArtifactHashes["8lines/gauntlet-symfony-bundle"]],
]) {
  harness.assert(regularTreeSha256(resolve(root, path)) === expectedHash, `Composer install source changed: ${path}`);
}
for (const [path, expectedHash] of Object.entries(expectedSymfonyRuntimeHashes)) {
  harness.assert(harness.sha256(readFileSync(resolve(root, path))) === expectedHash, `Symfony runtime harness changed: ${path}`);
}
const currentVerifierDependencyHashes = Object.fromEntries(Object.entries(verifierDependencyPaths)
  .map(([name, path]) => [name, regularTreeSha256(path, { excludeTopLevel: ["node_modules"] })]));
exactJson(currentVerifierDependencyHashes, expectedVerifierDependencyHashes, "built verifier dependency changed");

const phpRuntimeImage = "php:8.3.33-cli-bookworm@sha256:177529735599a8244b2c903522f029839dce1c2ac4be122fdc00ada4b45a20e4";
const dockerUser = `${typeof process.getuid === "function" ? process.getuid() : 1000}:${typeof process.getgid === "function" ? process.getgid() : 1000}`;
const dockerMount = `type=bind,src=${root},dst=/workspace`;
const runDocker = (args, timeout) => {
  const result = spawnSync("docker", args, {
    cwd: root,
    encoding: "utf8",
    timeout,
    env: { PATH: process.env.PATH },
  });
  if (result.status !== 0) throw new Error(`Symfony runtime command failed: ${result.stderr || result.stdout}`);
  return result.stdout;
};
const ensureSymfonyRuntime = () => {
  harness.assert(existsSync(resolve(root, "runtime/examples/symfony/vendor/autoload.php")),
    "trusted Composer runtime is missing");
  harness.assert(regularTreeSha256(resolve(root, "runtime/examples/symfony/vendor")) === expectedSymfonyVendorHash,
    "Composer-installed runtime tree changed");
};
const runSymfonyRuntime = (mode) => {
  ensureSymfonyRuntime();
  const source = runDocker([
    "run", "--rm", "--user", dockerUser, "--network", "none", "--entrypoint", "php",
    "--env", "GAUNTLET_APPLICATION_ID=portal", "--env", "GAUNTLET_APPLICATION_LABEL=Portal",
    "--env", "GAUNTLET_ENVIRONMENT_NAME=staging", "--env", "GAUNTLET_ENVIRONMENT_KIND=staging",
    "--env", "GAUNTLET_IDEMPOTENCY_SECRET=synthetic-fixture-stable-secret-32-bytes",
    "--mount", dockerMount, "--tmpfs", "/tmp:rw,nosuid,nodev,size=268435456",
    "--workdir", "/workspace/runtime/examples/symfony", phpRuntimeImage, "probe.php", mode,
  ], 120_000).trim();
  const result = JSON.parse(source);
  harness.assert(result !== null && typeof result === "object" && !Array.isArray(result), "invalid Symfony runtime result");
  return result;
};
ensureSymfonyRuntime();
const integrity = {
  configurationSha256: harness.sha256([
    "composer.json",
    "config/bundles.php",
    "config/packages/staging/gauntlet.yaml",
    "config/routes/staging/gauntlet.yaml",
    "gauntlet/config.yaml",
    "deployment/values.yaml",
  ].map((path) => `${path}\0${text(path)}`).join("\0")),
  runnerSha256: harness.sha256(readFileSync(import.meta.filename)),
  phpCoreArtifactSha256: regularTreeSha256(resolve(root, "artifacts/composer/8lines/gauntlet-php-core")),
  symfonyBundleArtifactSha256: regularTreeSha256(resolve(root, "artifacts/composer/8lines/gauntlet-symfony-bundle")),
  symfonyRuntimeSha256: harness.sha256(Object.keys(expectedSymfonyRuntimeHashes)
    .sort().map((path) => `${path}\0${text(path)}`).join("\0")),
  symfonyVendorSha256: regularTreeSha256(resolve(root, "runtime/examples/symfony/vendor")),
  ...currentVerifierDependencyHashes,
};
const requiredReceiptDigests = [
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
];
const assertExactObjectKeys = (value, expectedKeys, label) => {
  harness.assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be a mapping`);
  harness.assert(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expectedKeys].sort()),
    `${label} fields changed`);
};
const assertClosedReceiptEnvelope = (evidence) => {
  assertExactObjectKeys(evidence, [
    "scope", "customerDeploymentVerified", "receiptMode", "minimumProbeRuns", "selfHashMeaning",
    "requiredReceiptDigests", "observations", "observationHistory", "probeRuns", "commands",
  ], "evidence envelope");
  harness.assert(evidence.scope === "synthetic-ephemeral-loopback-http"
    && evidence.customerDeploymentVerified === false
    && evidence.receiptMode === "observations-only"
    && evidence.minimumProbeRuns === 2
    && evidence.selfHashMeaning === "integrity-only-not-trust-or-attestation", "evidence policy changed");
  exactJson(evidence.requiredReceiptDigests, requiredReceiptDigests, "receipt digest policy changed");
  harness.assert(evidence.observations !== null && typeof evidence.observations === "object"
    && !Array.isArray(evidence.observations), "observations must be a mapping");
  harness.assert(evidence.observationHistory !== null && typeof evidence.observationHistory === "object"
    && !Array.isArray(evidence.observationHistory), "observationHistory must be a mapping");
  harness.assert(evidence.probeRuns !== null && typeof evidence.probeRuns === "object"
    && !Array.isArray(evidence.probeRuns), "probeRuns must be a mapping");
  const observedKeys = probeKeys.filter((key) => evidence.observations[key] !== undefined);
  harness.assert(Object.keys(evidence.observations).every((key) => probeKeys.includes(key)), "unknown observation key");
  assertExactObjectKeys(evidence.observationHistory, observedKeys, "observation histories");
  assertExactObjectKeys(evidence.probeRuns, observedKeys, "probe run counters");
  exactJson(evidence.commands, observedKeys.map((key) => `node verify.mjs --probe ${key} => PASS (synthetic-ephemeral-loopback-http)`),
    "command/output evidence changed");
  for (const key of observedKeys) {
    const receipt = evidence.observations[key];
    assertExactObjectKeys(receipt, [
      "passed", "evidenceType", "scope", "observedAt", "httpExchanges", "checks", "probeRun", "previousReceiptSha256",
      ...requiredReceiptDigests, "receiptSha256",
    ], `observation ${key}`);
    harness.assert(receipt.probeRun === evidence.probeRuns[key], `receipt replay counter mismatch: ${key}`);
    for (const digestName of requiredReceiptDigests) {
      harness.assert(receipt[digestName] === integrity[digestName], `stale receipt digest ${digestName}: ${key}`);
    }
    const { receiptSha256, ...payload } = receipt;
    harness.assert(receiptSha256 === harness.sha256(harness.canonicalJson(payload)), `tampered receipt: ${key}`);
    const history = evidence.observationHistory[key];
    harness.assert(Array.isArray(history) && history.length === evidence.probeRuns[key]
      && history.length > 0 && history.length <= 8, `invalid observation history: ${key}`);
    let previousReceiptSha256 = null;
    for (let index = 0; index < history.length; index += 1) {
      const historicalReceipt = history[index];
      assertExactObjectKeys(historicalReceipt, Object.keys(receipt), `historical observation ${key}`);
      harness.assert(historicalReceipt.passed === true && historicalReceipt.scope === "synthetic-ephemeral-loopback-http",
        `invalid historical observation scope: ${key}`);
      harness.assert(["http-loopback", "configuration-and-http-loopback", "startup-guard"].includes(historicalReceipt.evidenceType),
        `invalid historical evidence type: ${key}`);
      harness.assert(Number.isSafeInteger(historicalReceipt.httpExchanges) && historicalReceipt.httpExchanges > 0,
        `missing historical HTTP evidence: ${key}`);
      harness.assert(typeof historicalReceipt.observedAt === "string" && !Number.isNaN(Date.parse(historicalReceipt.observedAt))
        && new Date(historicalReceipt.observedAt).toISOString() === historicalReceipt.observedAt,
      `invalid historical observation time: ${key}`);
      harness.assert(Array.isArray(historicalReceipt.checks) && historicalReceipt.checks.length > 0
        && historicalReceipt.checks.length <= 12, `invalid historical checks: ${key}`);
      harness.assert(historicalReceipt?.probeRun === index + 1, `non-consecutive observation history: ${key}`);
      harness.assert(historicalReceipt.previousReceiptSha256 === previousReceiptSha256,
        `broken observation history chain: ${key}`);
      for (const digestName of requiredReceiptDigests) {
        harness.assert(historicalReceipt[digestName] === integrity[digestName],
          `stale historical receipt digest ${digestName}: ${key}`);
      }
      const { receiptSha256: historicalHash, ...historicalPayload } = historicalReceipt;
      harness.assert(historicalHash === harness.sha256(harness.canonicalJson(historicalPayload)),
        `tampered historical receipt: ${key}`);
      previousReceiptSha256 = historicalHash;
    }
    harness.assert(harness.canonicalJson(history.at(-1)) === harness.canonicalJson(receipt),
      `latest observation differs from history: ${key}`);
  }
};
assertClosedReceiptEnvelope(json("evidence.json"));
const startAdapter = async (options) => {
  harness.startupGuard({
    ...options,
    idempotencySecret: "synthetic-fixture-stable-secret-32-bytes",
  });
  return harness.start(harness.adapterHandler(options));
};
const adapterTransportRequests = [
  ["GET", `${harness.PREFIX}/health`],
  ["GET", `${harness.PREFIX}/manifest`],
  ["GET", `${harness.PREFIX}/operations/fixture.safe`],
  ["POST", `${harness.PREFIX}/operations/fixture.safe/runs`],
  ["GET", `${harness.PREFIX}/runs/synthetic-run`],
  ["POST", `${harness.PREFIX}/data-sources/fixture.items/query`],
  ["POST", `${harness.PREFIX}/data-sources/fixture.items/resolve`],
  ["POST", `${harness.PREFIX}/runs/synthetic-run/cancel`],
  ["GET", `${harness.PREFIX}/runs/synthetic-run/events`],
  ["POST", `${harness.PREFIX}/uploads`],
  ["POST", `${harness.PREFIX}/runs/synthetic-run/artifacts/synthetic-artifact/launch`],
];
const rawTargetVariants = [
  `${harness.PREFIX}/health`,
  `${harness.PREFIX}/health/`,
  "/_gauntlet//v1/health",
  "//_gauntlet/v1/health",
  "/_gauntlet%2fv1/health",
  "/%5Fgauntlet/v1/health",
  `/safe/..${harness.PREFIX}/health`,
  "\\_gauntlet\\v1\\health".replace(/^\\/u, "/"),
  `http://public.invalid${harness.PREFIX}/health`,
  "/_gauntlet/v1/operations/unsafe%ZZid",
];
const publicRawTargetVariants = [...rawTargetVariants, "/_GAUNTLET/v1/health"];
if (process.argv.length === 4 && process.argv[2] === "--probe" && probeKeys.includes(process.argv[3])) {
  const key = process.argv[3];
  const staging = { name: "staging", kind: "staging" };
  const httpStart = harness.httpExchangeCount();
  let observation;
  if (key === "disabled") {
    const adapter = await startAdapter({
      enabled: false,
      id: "portal",
      label: "Portal",
      environment: staging,
    });
    try {
      const disabledChecks = [];
      for (const [method, path] of adapterTransportRequests) {
        const disabled = await harness.request(adapter, path, { method });
        harness.assert(disabled.status === 503, `disabled ${method} ${path} did not return 503`);
        harness.assert(disabled.contentType === "application/problem+json", `disabled ${method} ${path} did not return a Problem`);
        harness.assert(disabled.body?.type === "urn:gauntlet:problem:adapter-disabled"
          && disabled.body?.status === 503, `disabled ${method} ${path} Problem is not canonical`);
        disabledChecks.push(disabled.status);
      }
      const variantChecks = [];
      for (const rawTarget of rawTargetVariants) {
        const disabled = await harness.requestRawTarget(adapter, rawTarget);
        harness.assert(disabled.status === 503 && disabled.contentType === "application/problem+json", `disabled raw target escaped gate: ${rawTarget}`);
        variantChecks.push(disabled.status);
      }
      const host = await harness.request(adapter, "/host-health");
      harness.assert(host.status === 404 && host.contentType !== "application/problem+json", "disabled gate captured a host route");
      const symfonyDisabled = runSymfonyRuntime("disabled");
      harness.assert(symfonyDisabled.disabledBoundary === true
        && symfonyDisabled.healthStatus === 503 && symfonyDisabled.manifestStatus === 503,
      "Composer-installed Symfony bundle did not enforce the disabled boundary");
      observation = harness.makeObservation("http-loopback", [
        {
          matrix: "adapter-route-families",
          requests: adapterTransportRequests.map(([method, path]) => `${method} ${path}`),
          statuses: disabledChecks,
          mediaType: "application/problem+json",
          problemType: "urn:gauntlet:problem:adapter-disabled",
        },
        {
          matrix: "raw-target-variants",
          requests: rawTargetVariants.map((rawTarget) => `GET ${rawTarget}`),
          statuses: variantChecks,
          forwarded: false,
        },
        { request: "GET /host-health", status: 404, adapterGateCaptured: false },
        symfonyDisabled,
      ], httpStart, integrity);
    } finally {
      await harness.stop(adapter);
    }
  } else if (key === "startupDenied") {
    const validSecret = "synthetic-fixture-stable-secret-32-bytes";
    const denialCases = [
      ["missing-id", { enabled: true, label: "Portal", environment: staging, idempotencySecret: validSecret }],
      ["missing-label", { enabled: true, id: "portal", environment: staging, idempotencySecret: validSecret }],
      ["missing-environment", { enabled: true, id: "portal", label: "Portal", idempotencySecret: validSecret }],
      ["missing-environment-name", { enabled: true, id: "portal", label: "Portal", environment: { kind: "staging" }, idempotencySecret: validSecret }],
      ["missing-environment-kind", { enabled: true, id: "portal", label: "Portal", environment: { name: "staging" }, idempotencySecret: validSecret }],
      ["missing-secret", { enabled: true, id: "portal", label: "Portal", environment: staging }],
      ["short-secret", { enabled: true, id: "portal", label: "Portal", environment: staging, idempotencySecret: "too-short" }],
      ["production-name-colon-alias", { enabled: true, id: "portal", label: "Portal", environment: { name: "customer:prod", kind: "staging" }, idempotencySecret: validSecret }],
      ["production-kind", { enabled: true, id: "portal", label: "Portal", environment: { name: "staging", kind: "production" }, idempotencySecret: validSecret }],
    ];
    const denialChecks = [];
    for (const [scenario, startupConfig] of denialCases) {
      let listenerStarted = false;
      let denialCode = null;
      let adapter;
      try {
        harness.startupGuard(startupConfig);
        adapter = await harness.start(harness.adapterHandler(startupConfig));
        listenerStarted = true;
      } catch (error) {
        denialCode = error?.code ?? null;
      } finally {
        if (adapter !== undefined) await harness.stop(adapter);
      }
      harness.assert(listenerStarted === false && typeof denialCode === "string", `${scenario} adapter listener was not denied`);
      denialChecks.push({ case: scenario, listenerStarted, denialCode });
    }
    const hostApplication = await harness.start((request, response) => {
      const path = new URL(request.url, "http://loopback.invalid").pathname;
      if (path === "/host-health") {
        return response.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}\n');
      }
      return response.writeHead(404, { "content-type": "text/plain" }).end("Not Found\n");
    });
    let deniedRoute;
    let hostHealth;
    try {
      deniedRoute = await harness.request(hostApplication, `${harness.PREFIX}/health`);
      hostHealth = await harness.request(hostApplication, "/host-health");
      harness.assert(deniedRoute.status === 404 && deniedRoute.contentType !== "application/problem+json", "denied production adapter route became reachable");
      harness.assert(hostHealth.status === 200 && hostHealth.body?.status === "ok", "synthetic host application sentinel failed");
    } finally {
      await harness.stop(hostApplication);
    }
    const symfonyRuntimeDenials = [];
    for (const configurationCase of [
      "missing-id",
      "missing-label",
      "missing-environment",
      "missing-environment-name",
      "missing-environment-kind",
      "missing-secret",
      "short-secret",
      "production-name",
      "production-kind",
    ]) {
      const denial = runSymfonyRuntime(configurationCase);
      harness.assert(denial.configurationCase === configurationCase && denial.startupDenied === true
        && denial.listenerStarted === false && typeof denial.errorClass === "string",
      `Composer-installed Symfony bundle did not deny ${configurationCase}`);
      symfonyRuntimeDenials.push(denial);
    }
    observation = harness.makeObservation("startup-guard", [
      {
        runtime: "synthetic-js-startup-guard",
        configurationCases: denialChecks.map((check) => check.case),
        denialCodes: denialChecks.map((check) => check.denialCode),
        listenerStarts: denialChecks.filter((check) => check.listenerStarted).length,
      },
      { request: `GET ${harness.PREFIX}/health`, status: deniedRoute.status, adapterMounted: false },
      { request: "GET /host-health", status: hostHealth.status, hostApplicationAlive: true },
      {
        runtime: "composer-installed-symfony-kernel",
        configurationCases: symfonyRuntimeDenials.map((denial) => denial.configurationCase),
        errorClasses: [...new Set(symfonyRuntimeDenials.map((denial) => denial.errorClass))].sort(),
        startupDenials: symfonyRuntimeDenials.length,
        listenerStarts: symfonyRuntimeDenials.filter((denial) => denial.listenerStarted).length,
      },
    ], httpStart, integrity);
  } else if (key === "mismatchDenied") {
    const mismatchChecks = [];
    for (const [mismatch, expectedEnvironment] of [
      ["name-only", { name: "qa", kind: "staging" }],
      ["kind-only", { name: "staging", kind: "qa" }],
    ]) {
      const routeFamilies = [];
      const adapterCounters = {};
      const adapter = await startAdapter({
        enabled: true,
        id: "portal",
        label: "Portal",
        environment: staging,
        counters: adapterCounters,
      });
      const proxy = await harness.start(harness.controlPlaneHandler({ adapter, expectedEnvironment }));
      try {
        for (const [proxyFamily, method, path] of [
          ["operation-definition", "GET", `/proxy${harness.PREFIX}/operations/fixture.safe`],
          ["operation-run", "POST", `/proxy${harness.PREFIX}/operations/fixture.safe/runs`],
          ["run", "GET", `/proxy${harness.PREFIX}/runs/synthetic-run`],
          ["upload", "POST", `/proxy${harness.PREFIX}/uploads`],
          ["cancel", "POST", `/proxy${harness.PREFIX}/runs/synthetic-run/cancel`],
          ["events", "GET", `/proxy${harness.PREFIX}/runs/synthetic-run/events`],
          ["data-source-query", "POST", `/proxy${harness.PREFIX}/data-sources/fixture.items/query`],
          ["data-source-resolve", "POST", `/proxy${harness.PREFIX}/data-sources/fixture.items/resolve`],
          ["session-launch", "POST", `/proxy${harness.PREFIX}/runs/synthetic-run/artifacts/synthetic-artifact/launch`],
        ]) {
          const result = await harness.request(proxy, path, { method });
          const upstreamApplicationRequests = (adapterCounters.operation ?? 0)
            + (adapterCounters.dataSourceQuery ?? 0) + (adapterCounters.dataSourceResolve ?? 0);
          harness.assert(result.status === 503 && result.contentType === "application/problem+json",
            `${mismatch} ${proxyFamily} proxy did not return 503 Problem`);
          harness.assert(result.body?.type === "urn:gauntlet:problem:target-environment-mismatch"
            && result.body?.status === 503, `${mismatch} ${proxyFamily} Problem is not canonical`);
          harness.assert(adapterCounters.manifest === routeFamilies.length + 1
            && upstreamApplicationRequests === 0, `${mismatch} ${proxyFamily} reached adapter execution`);
          routeFamilies.push({
            proxyFamily,
            status: result.status,
          });
        }
      } finally {
        await harness.stop(proxy);
        await harness.stop(adapter);
      }
      mismatchChecks.push({
        mismatch,
        routeFamilies,
        status: 503,
        mediaType: "application/problem+json",
        problemType: "urn:gauntlet:problem:target-environment-mismatch",
        manifestDiscoveryRequests: adapterCounters.manifest,
        upstreamApplicationRequests: (adapterCounters.operation ?? 0)
          + (adapterCounters.dataSourceQuery ?? 0) + (adapterCounters.dataSourceResolve ?? 0),
      });
    }
    observation = harness.makeObservation("http-loopback", mismatchChecks, httpStart, integrity);
  } else if (key === "syntheticProtocolExercise") {
    const adapter = await startAdapter({
      enabled: true,
      id: "portal",
      label: "Portal",
      environment: staging,
    });
    const proxy = await harness.start(harness.controlPlaneHandler({ adapter, expectedEnvironment: staging }));
    try {
      const health = await harness.request(proxy, `/proxy${harness.PREFIX}/health`);
      const manifest = await harness.request(proxy, `/proxy${harness.PREFIX}/manifest`);
      harness.assertHealth(health);
      harness.assertManifest(manifest, { id: "portal", label: "Portal", environment: staging });
      const protocol = await harness.exerciseProtocol(proxy, `/proxy${harness.PREFIX}`);
      const symfonyRuntime = runSymfonyRuntime("enabled");
      harness.assert(symfonyRuntime.kernelRequest === true
        && symfonyRuntime.healthStatus === 200 && symfonyRuntime.manifestStatus === 200
        && symfonyRuntime.phpVersion === "8.3.33"
        && symfonyRuntime.phpCoreVersion === "0.1.5" && symfonyRuntime.symfonyBundleVersion === "0.1.5",
      "Composer-installed Symfony bundle runtime did not satisfy the exact 0.1.5 contract");
      exactJson(symfonyRuntime.environment, staging, "Composer-installed Symfony environment differs from configuration");
      observation = harness.makeObservation("http-loopback", [
        { request: `GET /proxy${harness.PREFIX}/health`, status: 200, protocolVersion: health.body.protocolVersion },
        { request: `GET /proxy${harness.PREFIX}/manifest`, status: 200, protocolVersion: manifest.body.protocolVersion, environment: manifest.body.application.environment },
        {
          operationDefinitionStatus: protocol.operationDefinitionStatus,
          staleRevisionStatus: protocol.staleRevisionStatus,
          invalidInputStatus: protocol.invalidInputStatus,
          idempotentReplay: protocol.idempotentReplay,
          terminalState: protocol.terminalState,
        },
        {
          dataSourceQueryStatus: protocol.dataSourceQueryStatus,
          dataSourceResolveStatus: protocol.dataSourceResolveStatus,
        },
        symfonyRuntime,
        {
          runtimeScope: "genuinely-single-process-synthetic",
          replicas: 1,
          phpWorkers: 1,
          runStore: "in-memory",
          coordinator: "in-memory",
          dispatcher: "current-process",
          eventHistory: "in-memory",
        },
      ], httpStart, integrity);
    } finally {
      await harness.stop(proxy);
      await harness.stop(adapter);
    }
  } else {
    const privateAdapter = await startAdapter({
      enabled: true,
      id: "portal",
      label: "Portal",
      environment: staging,
    });
    let publicForwards = 0;
    const publicIngress = await harness.start((request, response) => {
      const deniedAdapterVariant = harness.adapterRouteCandidate(request.url)
        || harness.adapterRouteCandidate(request.url.toLowerCase());
      if (deniedAdapterVariant) return response.writeHead(404, { "content-type": "text/plain" }).end("Not Found\n");
      publicForwards += 1;
      return response.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}\n');
    });
    try {
      const publicChecks = [];
      for (const [method, path] of adapterTransportRequests) {
        const publicResult = await harness.request(publicIngress, path, { method });
        harness.assert(publicResult.status === 404 && publicResult.contentType !== "application/problem+json", `public ingress did not deny ${method} ${path}`);
        publicChecks.push(publicResult.status);
      }
      const variantChecks = [];
      for (const rawTarget of publicRawTargetVariants) {
        const publicResult = await harness.requestRawTarget(publicIngress, rawTarget);
        harness.assert(publicResult.status === 404 && publicResult.contentType !== "application/problem+json", `public ingress did not deny raw target ${rawTarget}`);
        variantChecks.push(publicResult.status);
      }
      const privateResult = await harness.request(privateAdapter, `${harness.PREFIX}/health`);
      harness.assert(publicForwards === 0, "public ingress forwarded adapter prefix");
      harness.assertHealth(privateResult);
      observation = harness.makeObservation("configuration-and-http-loopback", [
        {
          matrix: "adapter-route-families",
          network: "synthetic-public-ingress",
          requests: adapterTransportRequests.map(([method, path]) => `${method} ${path}`),
          statuses: publicChecks,
          forwarded: false,
        },
        {
          matrix: "raw-target-variants",
          requests: publicRawTargetVariants.map((rawTarget) => `GET ${rawTarget}`),
          statuses: variantChecks,
          forwarded: false,
        },
        { network: "synthetic-private-adapter", request: `GET ${harness.PREFIX}/health`, status: 200 },
        { configuredAdapterPrefixDenied: true, configuredPrivateTransport: "tailscale-internal-alb" },
      ], httpStart, integrity);
    } finally {
      await harness.stop(publicIngress);
      await harness.stop(privateAdapter);
    }
  }
  harness.record(resolve(root, "evidence.json"), key, observation, probeKeys);
  process.stdout.write(`${key}: PASS\n`);
  return;
}
if (process.argv.length !== 2) throw new Error("usage: node verify.mjs [--help | --probe CHECK]");
const evidence = json("evidence.json");
harness.validateEvidence(evidence, probeKeys, integrity);
process.stdout.write("valid Symfony synthetic fixture contract verified; customer deployment not verified\n");
}

function validComposeFixture(root) {
  for (const application of ["billing", "portal"]) {
    write(root, `${application}/package.json`, `${JSON.stringify({
      name: `synthetic-${application}`,
      private: true,
      type: "module",
      engines: { node: ">=24 <27" },
      scripts: { build: "node scripts/build.mjs" },
      dependencies: {},
    }, null, 2)}\n`);
    write(root, `${application}/src/server.mjs`, [
      `throw new Error(${JSON.stringify(`${application} host application is not integrated with Gauntlet`)});`,
      "",
    ].join("\n"));
    write(root, `${application}/scripts/build.mjs`, [
      'import { copyFileSync, mkdirSync } from "node:fs";',
      'mkdirSync(new URL("../dist/", import.meta.url), { recursive: true });',
      'copyFileSync(new URL("../src/server.mjs", import.meta.url), new URL("../dist/server.mjs", import.meta.url));',
      "",
    ].join("\n"));
    write(root, `${application}/compose.yaml`, [
      "services:",
      `  ${application}:`,
      `    image: synthetic/${application}:staging`,
      "    networks:",
      "      gauntlet:",
      "        aliases:",
      `          - small-apps-staging-${application}`,
      "networks:",
      "  gauntlet:",
      "    external: true",
      "    name: gauntlet",
      "",
    ].join("\n"));
  }
  const artifactDirectory = resolve(root, "artifacts");
  mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
  write(root, "artifacts/runtime-pins.json", `${JSON.stringify(VALID_COMPOSE_RUNTIME_DEPENDENCY_PINS, null, 2)}\n`);
  const repositoryRoot = resolve(import.meta.dirname, "../..");
  const built = spawnSync("pnpm", [
    "--filter", "@8lines/gauntlet-typescript-node...", "build",
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (built.status !== 0) {
    throw new Error(`failed to build TypeScript adapter packages: ${built.stderr || built.stdout}`);
  }
  const validatorBuilt = spawnSync("pnpm", [
    "--filter", "@8lines/gauntlet-dashboard-client", "build",
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (validatorBuilt.status !== 0) {
    throw new Error(`failed to build the protocol response validator: ${validatorBuilt.stderr || validatorBuilt.stdout}`);
  }
  const verifierDependencyPaths = trustedVerifierDependencyPaths(repositoryRoot);
  const verifierDependencyHashes = Object.fromEntries(Object.entries(verifierDependencyPaths)
    .map(([name, path]) => [name, regularTreeSha256(path, { excludeTopLevel: ["node_modules"] })]));
  const packageArtifacts = [
    ["@8lines/gauntlet-protocol", "8lines-gauntlet-protocol-0.1.5.tgz"],
    ["@8lines/gauntlet-typescript-core", "8lines-gauntlet-typescript-core-0.1.5.tgz"],
    ["@8lines/gauntlet-typescript-node", "8lines-gauntlet-typescript-node-0.1.5.tgz"],
  ];
  for (const [packageName] of packageArtifacts) {
    const packed = spawnSync("pnpm", ["--filter", packageName, "pack", "--pack-destination", artifactDirectory], {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 120_000,
    });
    if (packed.status !== 0) {
      throw new Error(`failed to pack ${packageName}: ${packed.stderr || packed.stdout}`);
    }
  }
  const expectedArchives = Object.fromEntries(packageArtifacts.map(([packageName, archive]) => {
    const archivePath = resolve(artifactDirectory, archive);
    return [packageName, {
      archive,
      sha256: `sha256:${createHash("sha256").update(readFileSync(archivePath)).digest("hex")}`,
      packageTreeSha256: packedPackageTreeSha256(archivePath, resolve(artifactDirectory, `.inspect-${archive}`)),
    }];
  }));
  const goldenApplicationSource = readFileSync(resolve(import.meta.dirname, "forward-fixtures/compose/reference-server.mjs"), "utf8");
  write(root, "reference/server.mjs", goldenApplicationSource);
  write(root, "gauntlet/compose.yaml", "# Configure the standalone control plane here.\n");
  write(root, "gauntlet/config.yaml", "# Add two explicit matching staging targets here.\n");
  write(root, "evidence.json", `${JSON.stringify({
    scope: "synthetic-ephemeral-loopback-http",
    customerDeploymentVerified: false,
    receiptMode: "observations-only",
    minimumProbeRuns: 2,
    selfHashMeaning: "integrity-only-not-trust-or-attestation",
    requiredReceiptDigests: [
      "configurationSha256",
      "runnerSha256",
      "runtimeArtifactsSha256",
      "runtimeDependencyTreesSha256",
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
    ],
    observations: {},
    observationHistory: {},
    probeRuns: {},
    commands: [],
  }, null, 2)}\n`);
  write(root, "VERIFYING.md", [
    "# Synthetic verification harness",
    "",
    "After completing the fixture configuration, run `node verify.mjs --help`,",
    "execute every listed probe twice, and finish with `node verify.mjs`.",
    "",
    "The probes launch the applications' built Node entry points, which import the",
    "exact packed protocol, Core, and Node transport packages. All synthetic",
    "runtime overrides must come from the supplied `artifacts/runtime-pins.json`;",
    "the verifier requires its exact canonical bytes and binds it into each receipt.",
    "applications must copy the supplied `reference/server.mjs` byte-for-byte; it",
    "is a transparent fixture call path, not a template for customer domain code.",
    "listeners bind only to `127.0.0.1`; Compose files are parsed strictly but are",
    "not deployed. This is not evidence from a real Docker Compose or customer",
    "deployment.",
    "",
  ].join("\n"));
  write(root, "verify.mjs", validComposeVerifier(
    expectedArchives,
    VALID_COMPOSE_RUNTIME_DEPENDENCY_PINS,
    verifierDependencyHashes,
    verifierDependencyPaths,
    `sha256:${createHash("sha256").update(goldenApplicationSource).digest("hex")}`,
  ));
}

function validComposeVerifier(expectedArchives, runtimeDependencyPins, verifierDependencyHashes, verifierDependencyPaths, goldenApplicationSourceSha256) {
  const validatorUrl = new URL("../../packages/dashboard-client/dist/protocol-validator.js", import.meta.url).href;
  const protocolUrl = new URL("../../packages/protocol/dist/index.js", import.meta.url).href;
  const yamlUrl = import.meta.resolve("yaml");
  return [
    'import { lstatSync, readFileSync, writeFileSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";',
    'import { createHash, randomBytes } from "node:crypto";',
    'import { spawn } from "node:child_process";',
    'import { createServer, request as httpClientRequest } from "node:http";',
    'import { connect } from "node:net";',
    'import { once } from "node:events";',
    'import { relative, resolve, sep } from "node:path";',
    `import { parseDocument } from ${JSON.stringify(yamlUrl)};`,
    `import { operationRunIsValid, protocolValidators, validates } from ${JSON.stringify(validatorUrl)};`,
    `import { manifestSemanticsAreValid, operationSemanticsAreValid } from ${JSON.stringify(protocolUrl)};`,
    "",
    `const expectedArchives = Object.freeze(${JSON.stringify(expectedArchives)});`,
    `const expectedRuntimeDependencyPins = Object.freeze(${JSON.stringify(runtimeDependencyPins)});`,
    `const expectedVerifierDependencyHashes = Object.freeze(${JSON.stringify(verifierDependencyHashes)});`,
    `const verifierDependencyPaths = Object.freeze(${JSON.stringify(verifierDependencyPaths)});`,
    `const expectedGoldenApplicationSourceSha256 = ${JSON.stringify(goldenApplicationSourceSha256)};`,
    `const regularTreeSha256 = ${regularTreeSha256.toString()};`,
    "const protocolValidation = Object.freeze({",
    "  health: (value) => validates(protocolValidators.health, value),",
    "  manifest: (value) => validates(protocolValidators.manifest, value) && manifestSemanticsAreValid(value),",
    "  operation: (value) => validates(protocolValidators.operation, value) && operationSemanticsAreValid(value),",
    "  createRunRequest: (value) => validates(protocolValidators.createRunRequest, value),",
    "  run: (value, operation, manifest) => operationRunIsValid(value, operation, manifest),",
    "  dataSourceQuery: (value) => validates(protocolValidators.dataSourceQuery, value),",
    "  dataSourcePage: (value) => validates(protocolValidators.dataSourcePage, value),",
    "  dataSourceResolveRequest: (value) => validates(protocolValidators.dataSourceResolveRequest, value),",
    "  dataSourceResolveResponse: (value) => validates(protocolValidators.dataSourceResolveResponse, value),",
    "  problem: (value) => validates(protocolValidators.problem, value),",
    "});",
    `const createSyntheticLoopbackHttpHarness = ${syntheticLoopbackHttpHarness.toString()};`,
    `await (${validComposeVerifierRuntime.toString()})(createSyntheticLoopbackHttpHarness(protocolValidation));`,
    "",
  ].join("\n");
}

async function validComposeVerifierRuntime(harness) {
const root = import.meta.dirname;
const json = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const text = (path) => readFileSync(resolve(root, path), "utf8");
const probeKeys = ["disabled", "mismatchDenied", "syntheticProtocolExercise", "adaptersUnpublished", "dashboardLoopbackOnly"];
if (process.argv.length === 3 && process.argv[2] === "--help") {
  process.stdout.write(harness.help(probeKeys, 2));
  return;
}
const mapping = (value, label, expectedKeys) => {
  harness.assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be a mapping`);
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  harness.assert(JSON.stringify(actual) === JSON.stringify(expected), `${label} has missing or unknown keys`);
  return value;
};
const sequence = (value, label, length) => {
  harness.assert(Array.isArray(value) && value.length === length, `${label} must contain exactly ${length} entries`);
  return value;
};
const yaml = (path) => {
  const document = parseDocument(text(path), {
    merge: false,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  harness.assert(document.errors.length === 0, `${path} is not strict YAML: ${document.errors[0]?.message ?? "unknown error"}`);
  harness.assert(document.warnings.length === 0, `${path} contains ambiguous YAML`);
  let value;
  try {
    value = document.toJS({ maxAliasCount: 0, mapAsMap: false });
  } catch (error) {
    throw new Error(`${path} contains forbidden aliases: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  return mapping(value, path, Object.keys(value ?? {}));
};
const currentVerifierDependencyHashes = Object.fromEntries(Object.entries(verifierDependencyPaths)
  .map(([name, path]) => [name, regularTreeSha256(path, { excludeTopLevel: ["node_modules"] })]));
harness.assert(harness.canonicalJson(currentVerifierDependencyHashes)
  === harness.canonicalJson(expectedVerifierDependencyHashes), "verifier dependency bytes changed");
const assertEnvironment = (value, label) => {
  const environment = mapping(value, label, ["name", "kind"]);
  harness.assert(environment.name === "staging" && environment.kind === "staging", `${label} is not staging`);
};
const packageSpecs = [
  ["@8lines/gauntlet-protocol", "protocol"],
  ["@8lines/gauntlet-typescript-core", "typescript-core"],
  ["@8lines/gauntlet-typescript-node", "typescript-node"],
];
const applications = [
  { id: "billing", label: "Billing" },
  { id: "portal", label: "Portal" },
];
const runtimeDependencyPinsSource = text("artifacts/runtime-pins.json");
let runtimeDependencyPins;
try {
  runtimeDependencyPins = JSON.parse(runtimeDependencyPinsSource);
} catch (error) {
  throw new Error(`artifacts/runtime-pins.json is not JSON: ${error instanceof Error ? error.message : "unknown error"}`);
}
mapping(runtimeDependencyPins, "runtime dependency pins", Object.keys(expectedRuntimeDependencyPins));
harness.assert(harness.canonicalJson(runtimeDependencyPins) === harness.canonicalJson(expectedRuntimeDependencyPins),
  "runtime dependency pins differ from the supplied fixture contract");
harness.assert(runtimeDependencyPinsSource === `${JSON.stringify(expectedRuntimeDependencyPins, null, 2)}\n`,
  "artifacts/runtime-pins.json must retain its canonical pretty JSON bytes and one trailing LF");
const expectedWorkspaceOverrides = {
  "@8lines/gauntlet-protocol": "file:../artifacts/8lines-gauntlet-protocol-0.1.5.tgz",
  "@8lines/gauntlet-typescript-core": "file:../artifacts/8lines-gauntlet-typescript-core-0.1.5.tgz",
  "@8lines/gauntlet-typescript-node": "file:../artifacts/8lines-gauntlet-typescript-node-0.1.5.tgz",
  ...runtimeDependencyPins,
};
const runtimeDependencyHashes = {};
for (const application of applications) {
  const manifest = json(`${application.id}/package.json`);
  mapping(manifest.dependencies, `${application.id} dependencies`, packageSpecs.map(([name]) => name));
  const workspace = mapping(yaml(`${application.id}/pnpm-workspace.yaml`), `${application.id} pnpm workspace`, ["packages", "overrides"]);
  harness.assert(JSON.stringify(sequence(workspace.packages, `${application.id} pnpm workspace packages`, 1)) === JSON.stringify(["."]),
    `${application.id} pnpm workspace must contain only the synthetic application`);
  const overrides = mapping(workspace.overrides, `${application.id} pnpm overrides`, Object.keys(expectedWorkspaceOverrides));
  harness.assert(harness.canonicalJson(overrides) === harness.canonicalJson(expectedWorkspaceOverrides),
    `${application.id} pnpm overrides must pin the supplied candidate and runtime dependency graph`);
  for (const [name, leaf] of packageSpecs) {
    const expectedArchive = expectedArchives[name];
    const archivePath = `artifacts/8lines-gauntlet-${leaf}-0.1.5.tgz`;
    harness.assert(expectedArchive?.archive === `8lines-gauntlet-${leaf}-0.1.5.tgz`,
      `trusted archive metadata missing for ${name}`);
    harness.assert(harness.sha256(readFileSync(resolve(root, archivePath))) === expectedArchive.sha256,
      `packed archive changed before verification: ${name}`);
    harness.assert(
      manifest.dependencies?.[name] === `file:../${archivePath}`,
      `exact supplied candidate package missing for ${application.id}`,
    );
    harness.assert(
      json(`${application.id}/node_modules/${name}/package.json`).version === "0.1.5",
      `installed package version mismatch for ${application.id}: ${name}`,
    );
    harness.assert(regularTreeSha256(resolve(root, `${application.id}/node_modules/${name}`), { excludeTopLevel: ["node_modules"] })
      === expectedArchive.packageTreeSha256, `installed package bytes differ from packed archive for ${application.id}: ${name}`);
  }
  const directProtocol = realpathSync(resolve(root, `${application.id}/node_modules/@8lines/gauntlet-protocol`));
  const directCore = realpathSync(resolve(root, `${application.id}/node_modules/@8lines/gauntlet-typescript-core`));
  const directNode = realpathSync(resolve(root, `${application.id}/node_modules/@8lines/gauntlet-typescript-node`));
  const scopedDependency = (packageRoot, name) => realpathSync(resolve(packageRoot, "..", "..", name));
  const plainDependency = (packageRoot, name) => realpathSync(resolve(packageRoot, "..", name));
  const nodeProtocol = scopedDependency(directNode, "@8lines/gauntlet-protocol");
  const nodeCore = scopedDependency(directNode, "@8lines/gauntlet-typescript-core");
  const coreProtocol = scopedDependency(directCore, "@8lines/gauntlet-protocol");
  const coreAjv = scopedDependency(directCore, "ajv");
  const coreAjvFormats = scopedDependency(directCore, "ajv-formats");
  const protocolAjv = scopedDependency(directProtocol, "ajv");
  const protocolAjvFormats = scopedDependency(directProtocol, "ajv-formats");
  const protocolCanonicalize = scopedDependency(directProtocol, "canonicalize");
  const dependencyEdges = [
    ["node->protocol", nodeProtocol, expectedArchives["@8lines/gauntlet-protocol"].packageTreeSha256],
    ["node->core", nodeCore, expectedArchives["@8lines/gauntlet-typescript-core"].packageTreeSha256],
    ["core->protocol", coreProtocol, expectedArchives["@8lines/gauntlet-protocol"].packageTreeSha256],
    ["core->ajv", coreAjv, expectedVerifierDependencyHashes.ajvTreeSha256],
    ["core->ajv-formats", coreAjvFormats, expectedVerifierDependencyHashes.ajvFormatsTreeSha256],
    ["core-ajv-formats->ajv", plainDependency(coreAjvFormats, "ajv"), expectedVerifierDependencyHashes.ajvTreeSha256],
    ["protocol->ajv", protocolAjv, expectedVerifierDependencyHashes.ajvTreeSha256],
    ["protocol->ajv-formats", protocolAjvFormats, expectedVerifierDependencyHashes.ajvFormatsTreeSha256],
    ["protocol-ajv-formats->ajv", plainDependency(protocolAjvFormats, "ajv"), expectedVerifierDependencyHashes.ajvTreeSha256],
    ["protocol->canonicalize", protocolCanonicalize, expectedVerifierDependencyHashes.canonicalizeTreeSha256],
  ];
  for (const [prefix, ajvPackage] of [["core-ajv", coreAjv], ["protocol-ajv", protocolAjv]]) {
    dependencyEdges.push(
      [`${prefix}->fast-deep-equal`, plainDependency(ajvPackage, "fast-deep-equal"), expectedVerifierDependencyHashes.fastDeepEqualTreeSha256],
      [`${prefix}->fast-uri`, plainDependency(ajvPackage, "fast-uri"), expectedVerifierDependencyHashes.fastUriTreeSha256],
      [`${prefix}->json-schema-traverse`, plainDependency(ajvPackage, "json-schema-traverse"), expectedVerifierDependencyHashes.jsonSchemaTraverseTreeSha256],
      [`${prefix}->require-from-string`, plainDependency(ajvPackage, "require-from-string"), expectedVerifierDependencyHashes.requireFromStringTreeSha256],
    );
  }
  runtimeDependencyHashes[application.id] = {};
  for (const [edge, path, expectedHash] of dependencyEdges) {
    const hash = regularTreeSha256(path, { excludeTopLevel: ["node_modules"] });
    harness.assert(hash === expectedHash,
      `installed runtime dependency edge differs from trusted fixture bytes: ${application.id} ${edge}`);
    runtimeDependencyHashes[application.id][edge] = hash;
  }
  harness.assert(readFileSync(resolve(root, `${application.id}/src/server.mjs`))
    .equals(readFileSync(resolve(root, `${application.id}/dist/server.mjs`))),
  `${application.id} built entry point is stale relative to source`);
  harness.assert(harness.sha256(readFileSync(resolve(root, `${application.id}/src/server.mjs`)))
    === expectedGoldenApplicationSourceSha256,
  `${application.id} must use the reviewed golden synthetic SDK call path`);
  harness.assert(readFileSync(resolve(root, `${application.id}/src/server.mjs`))
    .equals(readFileSync(resolve(root, "reference/server.mjs"))),
  `${application.id} must use the supplied transparent synthetic reference server`);

  const compose = mapping(yaml(`${application.id}/compose.yaml`), `${application.id} Compose root`, ["services", "secrets", "networks"]);
  const services = mapping(compose.services, `${application.id} services`, [application.id]);
  const service = mapping(services[application.id], `${application.id} service`, ["image", "environment", "secrets", "networks"]);
  harness.assert(service.image === `synthetic/${application.id}:staging`, `${application.id} image is not pinned`);
  const environment = mapping(service.environment, `${application.id} environment`, [
    "HOST",
    "PORT",
    "GAUNTLET_ENABLED",
    "GAUNTLET_APPLICATION_ID",
    "GAUNTLET_APPLICATION_LABEL",
    "GAUNTLET_ENVIRONMENT_NAME",
    "GAUNTLET_ENVIRONMENT_KIND",
    "GAUNTLET_IDEMPOTENCY_SECRET_FILE",
  ]);
  harness.assert(environment.HOST === "0.0.0.0" && environment.PORT === "8080",
    `${application.id} private container listener must match the target port`);
  harness.assert(environment.GAUNTLET_ENABLED === "true", `${application.id} adapter is not explicitly enabled`);
  harness.assert(environment.GAUNTLET_APPLICATION_ID === application.id, `${application.id} application id mismatch`);
  harness.assert(environment.GAUNTLET_APPLICATION_LABEL === application.label, `${application.id} application label mismatch`);
  harness.assert(environment.GAUNTLET_ENVIRONMENT_NAME === "staging"
    && environment.GAUNTLET_ENVIRONMENT_KIND === "staging", `${application.id} environment mismatch`);
  harness.assert(environment.GAUNTLET_IDEMPOTENCY_SECRET_FILE === "/run/secrets/gauntlet-idempotency", `${application.id} secret-file reference missing`);
  const serviceSecret = mapping(sequence(service.secrets, `${application.id} service secrets`, 1)[0], `${application.id} service secret`, ["source", "target"]);
  harness.assert(serviceSecret.source === "gauntlet-idempotency" && serviceSecret.target === "gauntlet-idempotency", `${application.id} secret mount mismatch`);
  const serviceNetworks = mapping(service.networks, `${application.id} service networks`, ["gauntlet"]);
  const attachedNetwork = mapping(serviceNetworks["gauntlet"], `${application.id} attached network`, ["aliases"]);
  harness.assert(
    JSON.stringify(sequence(attachedNetwork.aliases, `${application.id} network aliases`, 1))
      === JSON.stringify([`small-apps-staging-${application.id}`]),
    `${application.id} private network alias mismatch`,
  );
  const secrets = mapping(compose.secrets, `${application.id} secrets`, ["gauntlet-idempotency"]);
  const secret = mapping(secrets["gauntlet-idempotency"], `${application.id} secret reference`, ["external", "name"]);
  harness.assert(secret.external === true
    && secret.name === `small-apps-staging-${application.id}-gauntlet-idempotency`, `${application.id} stable external secret reference missing`);
  const networks = mapping(compose.networks, `${application.id} networks`, ["gauntlet"]);
  const network = mapping(networks["gauntlet"], `${application.id} external network`, ["external", "name"]);
  harness.assert(network.external === true && network.name === "gauntlet", `${application.id} external network mismatch`);
}

const dashboardCompose = mapping(yaml("gauntlet/compose.yaml"), "dashboard Compose root", ["services", "networks"]);
const dashboardServices = mapping(dashboardCompose.services, "dashboard services", ["gauntlet"]);
const dashboard = mapping(dashboardServices["gauntlet"], "dashboard service", ["image", "environment", "ports", "volumes", "networks"]);
harness.assert(dashboard.image === "ghcr.io/8lines/gauntlet:0.1.5", "dashboard image is not pinned");
const dashboardEnvironment = mapping(dashboard.environment, "dashboard environment", ["GAUNTLET_CONFIG_FILE"]);
harness.assert(dashboardEnvironment.GAUNTLET_CONFIG_FILE === "/etc/gauntlet/config.yaml", "dashboard config-file selector missing");
harness.assert(JSON.stringify(sequence(dashboard.ports, "dashboard ports", 1)) === JSON.stringify(["127.0.0.1:8080:8080"]), "dashboard must bind only to loopback");
harness.assert(JSON.stringify(sequence(dashboard.volumes, "dashboard volumes", 1))
  === JSON.stringify(["./config.yaml:/etc/gauntlet/config.yaml:ro"]), "dashboard config must be the only read-only volume");
harness.assert(JSON.stringify(sequence(dashboard.networks, "dashboard service networks", 1)) === JSON.stringify(["gauntlet"]), "dashboard network attachment mismatch");
const dashboardNetworks = mapping(dashboardCompose.networks, "dashboard networks", ["gauntlet"]);
const dashboardNetwork = mapping(dashboardNetworks["gauntlet"], "dashboard external network", ["external", "name"]);
harness.assert(dashboardNetwork.external === true && dashboardNetwork.name === "gauntlet", "dashboard external network mismatch");

const control = mapping(yaml("gauntlet/config.yaml"), "control-plane config", ["version", "instance", "targets"]);
harness.assert(control.version === 1, "control-plane config version must be 1");
const instance = mapping(control.instance, "control-plane instance", ["name", "environment"]);
harness.assert(instance.name === "small-apps-staging", "control-plane instance name mismatch");
assertEnvironment(instance.environment, "control-plane environment");
const targets = sequence(control.targets, "control-plane targets", 2);
for (let index = 0; index < applications.length; index += 1) {
  const expected = applications[index];
  const target = mapping(targets[index], `target ${index}`, ["id", "label", "adapterUrl", "expectedEnvironment"]);
  harness.assert(target.id === expected.id && target.label === expected.label, `target ${index} identity mismatch`);
  const expectedUrl = `http://small-apps-staging-${expected.id}:8080`;
  harness.assert(target.adapterUrl === expectedUrl, `target ${expected.id} adapter origin mismatch`);
  const parsed = new URL(target.adapterUrl);
  harness.assert(parsed.origin === expectedUrl && parsed.pathname === "/" && parsed.search === ""
    && parsed.hash === "" && parsed.username === "" && parsed.password === "", `target ${expected.id} must use a bare private origin`);
  assertEnvironment(target.expectedEnvironment, `target ${expected.id} expected environment`);
}

const digestFiles = (paths) => harness.sha256(harness.canonicalJson(paths.map((path) => ({
  path,
  sha256: harness.sha256(readFileSync(resolve(root, path))),
}))));
const filesBelow = (directory) => {
  const files = [];
  const visit = (relative) => {
    const entries = readdirSync(resolve(root, directory, relative), { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
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
const integrity = {
  configurationSha256: digestFiles([
    "artifacts/runtime-pins.json",
    "billing/package.json", "billing/pnpm-workspace.yaml", "billing/pnpm-lock.yaml",
    "billing/src/server.mjs", "billing/scripts/build.mjs", "billing/compose.yaml",
    "portal/package.json", "portal/pnpm-workspace.yaml", "portal/pnpm-lock.yaml",
    "portal/src/server.mjs", "portal/scripts/build.mjs", "portal/compose.yaml",
    "gauntlet/compose.yaml", "gauntlet/config.yaml",
    "reference/server.mjs",
  ]),
  runnerSha256: harness.sha256(readFileSync(import.meta.filename)),
  runtimeArtifactsSha256: digestFiles([
    "artifacts/8lines-gauntlet-protocol-0.1.5.tgz",
    "artifacts/8lines-gauntlet-typescript-core-0.1.5.tgz",
    "artifacts/8lines-gauntlet-typescript-node-0.1.5.tgz",
    "billing/dist/server.mjs",
    "portal/dist/server.mjs",
    ...applications.flatMap(({ id }) => packageSpecs.flatMap(([name]) => filesBelow(`${id}/node_modules/${name}`))),
  ]),
  runtimeDependencyTreesSha256: harness.sha256(harness.canonicalJson(runtimeDependencyHashes)),
  ...currentVerifierDependencyHashes,
};
const requiredDigests = [
  "configurationSha256",
  "runnerSha256",
  "runtimeArtifactsSha256",
  "runtimeDependencyTreesSha256",
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
];
const assertClosedReceiptEnvelope = (evidence) => {
  mapping(evidence, "evidence envelope", [
    "scope", "customerDeploymentVerified", "receiptMode", "minimumProbeRuns", "selfHashMeaning",
    "requiredReceiptDigests", "observations", "observationHistory", "probeRuns", "commands",
  ]);
  harness.assert(evidence.scope === "synthetic-ephemeral-loopback-http"
    && evidence.customerDeploymentVerified === false
    && evidence.receiptMode === "observations-only"
    && evidence.minimumProbeRuns === 2
    && evidence.selfHashMeaning === "integrity-only-not-trust-or-attestation", "invalid evidence envelope policy");
  harness.assert(JSON.stringify(evidence.requiredReceiptDigests) === JSON.stringify(requiredDigests),
    "receipt digest policy changed");
  harness.assert(evidence.observations !== null && typeof evidence.observations === "object"
    && !Array.isArray(evidence.observations), "observations must be a mapping");
  harness.assert(evidence.observationHistory !== null && typeof evidence.observationHistory === "object"
    && !Array.isArray(evidence.observationHistory), "observationHistory must be a mapping");
  harness.assert(evidence.probeRuns !== null && typeof evidence.probeRuns === "object"
    && !Array.isArray(evidence.probeRuns), "probeRuns must be a mapping");
  const observedKeys = probeKeys.filter((key) => evidence.observations[key] !== undefined);
  harness.assert(JSON.stringify(Object.keys(evidence.observations).sort()) === JSON.stringify([...observedKeys].sort()),
    "unknown observation key");
  harness.assert(JSON.stringify(Object.keys(evidence.observationHistory).sort()) === JSON.stringify([...observedKeys].sort()),
    "observation history keys differ from observations");
  harness.assert(JSON.stringify(Object.keys(evidence.probeRuns).sort()) === JSON.stringify([...observedKeys].sort()),
    "probe run keys differ from observations");
  harness.assert(JSON.stringify(evidence.commands) === JSON.stringify(observedKeys
    .map((key) => `node verify.mjs --probe ${key} => PASS (synthetic-ephemeral-loopback-http)`)),
  "command/output evidence changed");
  for (const key of observedKeys) {
    const receipt = evidence.observations[key];
    mapping(receipt, `observation ${key}`, [
      "passed", "evidenceType", "scope", "observedAt", "httpExchanges", "checks", "probeRun", "previousReceiptSha256",
      ...requiredDigests, "receiptSha256",
    ]);
    harness.assert(receipt.probeRun === evidence.probeRuns[key], `receipt replay counter mismatch: ${key}`);
    const history = evidence.observationHistory[key];
    harness.assert(Array.isArray(history) && history.length === evidence.probeRuns[key]
      && history.length > 0 && history.length <= 8, `invalid observation history: ${key}`);
    let previousReceiptSha256 = null;
    for (let index = 0; index < history.length; index += 1) {
      const historicalReceipt = history[index];
      mapping(historicalReceipt, `historical observation ${key}`, Object.keys(receipt));
      harness.assert(historicalReceipt.passed === true
        && ["http-loopback", "configuration-and-http-loopback", "startup-guard"].includes(historicalReceipt.evidenceType)
        && historicalReceipt.scope === "synthetic-ephemeral-loopback-http", `invalid historical evidence scope: ${key}`);
      harness.assert(Number.isSafeInteger(historicalReceipt.httpExchanges) && historicalReceipt.httpExchanges > 0,
        `missing historical HTTP evidence: ${key}`);
      harness.assert(typeof historicalReceipt.observedAt === "string" && !Number.isNaN(Date.parse(historicalReceipt.observedAt))
        && new Date(historicalReceipt.observedAt).toISOString() === historicalReceipt.observedAt,
      `invalid historical observation time: ${key}`);
      harness.assert(Array.isArray(historicalReceipt.checks) && historicalReceipt.checks.length > 0
        && historicalReceipt.checks.length <= 12, `invalid historical checks: ${key}`);
      harness.assert(historicalReceipt?.probeRun === index + 1, `non-consecutive observation history: ${key}`);
      harness.assert(historicalReceipt.previousReceiptSha256 === previousReceiptSha256,
        `broken observation history chain: ${key}`);
      for (const digestName of requiredDigests) {
        harness.assert(historicalReceipt[digestName] === integrity[digestName],
          `stale historical receipt digest ${digestName}: ${key}`);
      }
      const { receiptSha256, ...payload } = historicalReceipt;
      harness.assert(receiptSha256 === harness.sha256(harness.canonicalJson(payload)),
        `tampered historical receipt: ${key}`);
      previousReceiptSha256 = receiptSha256;
    }
    harness.assert(harness.canonicalJson(history.at(-1)) === harness.canonicalJson(receipt),
      `latest observation differs from history: ${key}`);
  }
};
assertClosedReceiptEnvelope(json("evidence.json"));

const adapterRouteFamilies = [
  ["health", "GET", `${harness.PREFIX}/health`],
  ["manifest", "GET", `${harness.PREFIX}/manifest`],
  ["operation-definition", "GET", `${harness.PREFIX}/operations/fixture.safe`],
  ["operation-run", "POST", `${harness.PREFIX}/operations/fixture.safe/runs`],
  ["run", "GET", `${harness.PREFIX}/runs/synthetic-run`],
  ["data-source-query", "POST", `${harness.PREFIX}/data-sources/fixture.items/query`],
  ["data-source-resolve", "POST", `${harness.PREFIX}/data-sources/fixture.items/resolve`],
  ["cancel", "POST", `${harness.PREFIX}/runs/synthetic-run/cancel`],
  ["events", "GET", `${harness.PREFIX}/runs/synthetic-run/events`],
  ["upload", "POST", `${harness.PREFIX}/uploads`],
  ["session-launch", "POST", `${harness.PREFIX}/runs/synthetic-run/artifacts/synthetic-artifact/launch`],
];
const rawTargetVariants = [
  `http://public.invalid${harness.PREFIX}/health`,
  "/%5Fgauntlet/v1/health",
  "//_gauntlet//v1//health",
  "/ordinary/../_gauntlet/v1/health",
  `${harness.PREFIX}/health/`,
  "/_gauntlet%2fv1/health",
  "/_gauntlet\\v1\\health",
  "/_g%61untlet/v1/health",
  "/_gauntlet/v1/operations/unsafe%ZZid",
  "/_gauntlet/v1/manifest?query=1",
  "/_gauntlet/v1/manifest#fragment",
];
const malformedAdapterTargets = [
  `${harness.PREFIX}/manifest`,
  `http://attacker.invalid${harness.PREFIX}/manifest`,
  "/%5Fgauntlet/v1/manifest",
  "/_gauntlet\\v1\\manifest",
  "/_g%61untlet/v1/manifest",
  "//_gauntlet//v1//manifest",
  "/ordinary/../_gauntlet/v1/manifest",
];
const malformedAdapterRequestLines = [
  ...malformedAdapterTargets.map((target) => `GET ${target}`),
  `get ${harness.PREFIX}/manifest`,
  `CUSTOMMETHODEXTENSION ${harness.PREFIX}/manifest`,
  `M-SEARCH ${harness.PREFIX}/manifest`,
];
const exceptionalRequestCases = [
  {
    channel: "trace", adapterRequestLine: `TRACE ${harness.PREFIX}/manifest HTTP/1.1`,
    unrelatedRequestLine: "TRACE /host-health HTTP/1.1", headers: ["Host: adapter", "Connection: close"],
    enabledStatus: 405, unrelatedStatus: 405,
  },
  {
    channel: "track", adapterRequestLine: `TRACK ${harness.PREFIX}/manifest HTTP/1.1`,
    unrelatedRequestLine: "TRACK /host-health HTTP/1.1", headers: ["Host: adapter", "Connection: close"],
    enabledStatus: 400, unrelatedStatus: 400,
  },
  {
    channel: "connect", adapterRequestLine: `CONNECT ${harness.PREFIX}/manifest HTTP/1.1`,
    unrelatedRequestLine: "CONNECT /host-health HTTP/1.1", headers: ["Host: adapter", "Connection: close"],
    enabledStatus: 405, unrelatedStatus: 400,
  },
  {
    channel: "upgrade", adapterRequestLine: `GET ${harness.PREFIX}/manifest HTTP/1.1`,
    unrelatedRequestLine: "GET /host-health HTTP/1.1", headers: ["Host: adapter", "Connection: Upgrade", "Upgrade: synthetic"],
    enabledStatus: 405, unrelatedStatus: 400,
  },
  {
    channel: "expectation", adapterRequestLine: `GET ${harness.PREFIX}/manifest HTTP/1.1`,
    unrelatedRequestLine: "GET /host-health HTTP/1.1", headers: ["Host: adapter", "Expect: synthetic", "Connection: close"],
    enabledStatus: 417, unrelatedStatus: 417,
  },
];
const invalidEnabledRawTargets = [
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
const mismatchProxyFamilies = [
  ["operation-definition", "GET", `/proxy${harness.PREFIX}/operations/fixture.safe`],
  ["operation-run", "POST", `/proxy${harness.PREFIX}/operations/fixture.safe/runs`],
  ["run", "GET", `/proxy${harness.PREFIX}/runs/synthetic-run`],
  ["upload", "POST", `/proxy${harness.PREFIX}/uploads`],
  ["cancel", "POST", `/proxy${harness.PREFIX}/runs/synthetic-run/cancel`],
  ["events", "GET", `/proxy${harness.PREFIX}/runs/synthetic-run/events`],
  ["data-source-query", "POST", `/proxy${harness.PREFIX}/data-sources/fixture.items/query`],
  ["data-source-resolve", "POST", `/proxy${harness.PREFIX}/data-sources/fixture.items/resolve`],
  ["session-launch", "POST", `/proxy${harness.PREFIX}/runs/synthetic-run/artifacts/synthetic-artifact/launch`],
];
const mismatchControlPlaneHandler = ({ adapter, expectedEnvironment, counters }) => async (incoming, response) => {
  const target = new URL(incoming.url, "http://loopback.invalid").pathname;
  harness.assert(target.startsWith("/proxy"), "synthetic proxy path missing");
  const manifest = await harness.request(adapter, `${harness.PREFIX}/manifest`);
  harness.assert(manifest.status === 200 && manifest.contentType === "application/json", "manifest discovery failed");
  counters.discovery = (counters.discovery ?? 0) + 1;
  const actual = manifest.body?.application?.environment;
  if (actual?.name !== expectedEnvironment.name || actual?.kind !== expectedEnvironment.kind) {
    response.writeHead(503, { "content-type": "application/problem+json" });
    response.end(`${JSON.stringify({
      type: "urn:gauntlet:problem:target-environment-mismatch",
      title: "Target environment mismatch",
      status: 503,
    })}\n`);
    return;
  }
  counters.upstream = (counters.upstream ?? 0) + 1;
  response.writeHead(500, { "content-type": "application/problem+json" });
  response.end('{"type":"urn:gauntlet:problem:adapter-internal-error","title":"Adapter internal error","status":500}\n');
};

const runtimeDirectory = resolve(root, ".runtime");
mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
const startApplication = async (application, enabled) => {
  const secretPath = resolve(runtimeDirectory, `${application.id}.secret`);
  writeFileSync(secretPath, randomBytes(48), { mode: 0o600 });
  const child = spawn(process.execPath, [resolve(root, application.id, "dist/server.mjs")], {
    cwd: resolve(root, application.id),
    env: {
      PATH: process.env.PATH,
      HOST: "127.0.0.1",
      PORT: "0",
      GAUNTLET_ENABLED: enabled ? "true" : "false",
      GAUNTLET_APPLICATION_ID: application.id,
      GAUNTLET_APPLICATION_LABEL: application.label,
      GAUNTLET_ENVIRONMENT_NAME: "staging",
      GAUNTLET_ENVIRONMENT_KIND: "staging",
      GAUNTLET_IDEMPOTENCY_SECRET_FILE: secretPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-2_048);
  });
  try {
    const ready = await new Promise((resolveReady, rejectReady) => {
      const timeout = setTimeout(() => rejectReady(new Error(`${application.id} startup timed out: ${stderr}`)), 4_000);
      const exited = (code, signal) => {
        clearTimeout(timeout);
        rejectReady(new Error(`${application.id} exited before ready (${code ?? signal}): ${stderr}`));
      };
      child.once("exit", exited);
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        const newline = stdout.indexOf("\n");
        if (newline < 0) return;
        try {
          const value = JSON.parse(stdout.slice(0, newline));
          harness.assert(value.ready === true && Number.isSafeInteger(value.port), `${application.id} emitted invalid readiness`);
          clearTimeout(timeout);
          child.off("exit", exited);
          resolveReady(value);
        } catch (error) {
          clearTimeout(timeout);
          child.off("exit", exited);
          rejectReady(error);
        }
      });
    });
    return {
      application,
      child,
      secretPath,
      address: () => ({ address: "127.0.0.1", port: ready.port }),
    };
  } catch (error) {
    child.kill("SIGKILL");
    rmSync(secretPath, { force: true });
    throw error;
  }
};
const stopApplication = async (runtime) => {
  if (runtime.child.exitCode === null && runtime.child.signalCode === null) {
    const exited = once(runtime.child, "exit");
    runtime.child.kill("SIGTERM");
    let timer;
    try {
      await Promise.race([
        exited,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${runtime.application.id} did not stop`)), 3_000); }),
      ]);
    } catch (error) {
      runtime.child.kill("SIGKILL");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  rmSync(runtime.secretPath, { force: true });
};
const exerciseActualProtocol = async (proxy, adapter) => {
  const basePath = `/proxy${harness.PREFIX}`;
  const definition = await harness.request(proxy, `${basePath}/operations/fixture.safe`);
  harness.assert(definition.status === 200 && /^sha256:[0-9a-f]{64}$/u.test(definition.body?.revision), "actual operation definition is invalid");
  const staleRevision = `sha256:${"0".repeat(64)}`;
  const stale = await harness.request(proxy, `${basePath}/operations/fixture.safe/runs`, {
    method: "POST",
    body: {
      operationRevision: staleRevision,
      input: { value: "safe" },
      idempotencyKey: "actual-stale",
      confirmation: { operationId: "fixture.safe", operationRevision: staleRevision, impact: "write" },
    },
  });
  harness.assert(stale.status === 409 && stale.body?.type === "urn:gauntlet:problem:stale-operation-revision", "actual SDK did not reject a stale revision");
  const invalid = await harness.request(proxy, `${basePath}/operations/fixture.safe/runs`, {
    method: "POST",
    body: {
      operationRevision: definition.body.revision,
      input: { value: 7 },
      idempotencyKey: "actual-invalid",
      confirmation: { operationId: "fixture.safe", operationRevision: definition.body.revision, impact: "write" },
    },
  });
  harness.assert(invalid.status === 422 && invalid.body?.type === "urn:gauntlet:problem:validation-failed"
    && invalid.body?.errors?.some((error) => error.instancePath === "/value"), `actual SDK did not reject invalid input at its pointer: ${JSON.stringify(invalid)}`);
  const request = {
    method: "POST",
    body: {
      operationRevision: definition.body.revision,
      input: { value: "safe" },
      idempotencyKey: "actual-replay",
      confirmation: { operationId: "fixture.safe", operationRevision: definition.body.revision, impact: "write" },
    },
  };
  const created = await harness.request(proxy, `${basePath}/operations/fixture.safe/runs`, request);
  harness.assert(created.status === 202 && typeof created.body?.id === "string", "actual SDK did not enqueue the run");
  let polled;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    polled = await harness.request(proxy, `${basePath}/runs/${encodeURIComponent(created.body.id)}`);
    if (["succeeded", "failed", "partial", "cancelled", "timed_out"].includes(polled.body?.state)) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  harness.assert(polled?.status === 200 && polled.body?.state === "succeeded", "actual SDK run did not reach succeeded");
  const replay = await harness.request(proxy, `${basePath}/operations/fixture.safe/runs`, request);
  harness.assert(replay.status === 201 && replay.body?.id === created.body.id, "actual SDK did not replay the idempotent run");
  harness.assert(!JSON.stringify([created.body, polled.body, replay.body]).includes("actual-replay"), "actual SDK leaked the idempotency key");
  const query = await harness.request(proxy, `${basePath}/data-sources/fixture.items/query`, {
    method: "POST",
    body: { search: "Synthetic", limit: 10, dependencies: {}, context: { requestId: "actual-query" } },
  });
  const resolved = await harness.request(proxy, `${basePath}/data-sources/fixture.items/resolve`, {
    method: "POST",
    body: { values: ["item-1"], dependencies: {}, context: { requestId: "actual-resolve" } },
  });
  harness.assert(query.status === 200 && query.body?.items?.[0]?.value === "item-1", "actual SDK data-source query failed");
  harness.assert(resolved.status === 200 && resolved.body?.results?.[0]?.item?.value === "item-1", "actual SDK data-source resolve failed");
  const counters = await harness.request(adapter, "/__fixture/counters");
  harness.assert(counters.status === 200 && counters.body?.operationRuns === 1,
    "actual application operation was not invoked exactly once");
  harness.assert(harness.canonicalJson(counters.body?.lastOperationInput) === harness.canonicalJson({ value: "safe" }),
    "actual application operation callback did not receive the exact input");
  harness.assert(counters.body?.dataSourceQueries === 1
    && harness.canonicalJson(counters.body?.lastDataSourceQuery) === harness.canonicalJson({
      search: "Synthetic", limit: 10, dependencies: {}, context: { requestId: "actual-query" },
    }), "actual application query callback did not receive the exact request once");
  harness.assert(counters.body?.dataSourceResolves === 1
    && harness.canonicalJson(counters.body?.lastDataSourceResolve) === harness.canonicalJson({
      values: ["item-1"], dependencies: {}, context: { requestId: "actual-resolve" },
    }), "actual application resolve callback did not receive the exact request once");
  const invalidRawStatuses = [];
  for (const target of invalidEnabledRawTargets) {
    const invalidPath = await harness.requestRawLine(adapter, `GET ${target} HTTP/1.1`);
    harness.assert(invalidPath.status === 400 && invalidPath.contentType === "application/problem+json",
    `actual SDK did not own invalid raw target: ${target}`);
    invalidRawStatuses.push(invalidPath.status);
  }
  const malformedAdapterStatuses = [];
  for (const requestLine of malformedAdapterRequestLines) {
    const malformedAdapter = await harness.requestRawLine(adapter, `${requestLine} bad HTTP/1.1`);
    harness.assert(malformedAdapter.status === 400
      && malformedAdapter.body?.type === "urn:gauntlet:problem:invalid-path",
    `enabled malformed adapter request escaped clientError ownership: ${requestLine}`);
    malformedAdapterStatuses.push(malformedAdapter.status);
  }
  const malformedHost = await harness.requestRawLine(adapter, "GET /host health HTTP/1.1");
  harness.assert(malformedHost.status === 400 && malformedHost.contentType === "",
    "unrelated malformed request was not a generic 400");
  const exceptionalAdapterStatuses = [];
  const exceptionalUnrelatedStatuses = [];
  for (const requestCase of exceptionalRequestCases) {
    const exceptionalAdapter = await harness.requestRawLine(adapter, requestCase.adapterRequestLine, requestCase.headers);
    harness.assert(exceptionalAdapter.status === requestCase.enabledStatus
      && exceptionalAdapter.contentType === "application/problem+json",
    `enabled ${requestCase.channel} adapter request escaped owned boundary`);
    exceptionalAdapterStatuses.push(exceptionalAdapter.status);
    const unrelated = await harness.requestRawLine(adapter, requestCase.unrelatedRequestLine, requestCase.headers);
    harness.assert(unrelated.status === requestCase.unrelatedStatus && unrelated.contentType === "",
    `unrelated ${requestCase.channel} request did not remain generic: ${JSON.stringify(unrelated)}`);
    exceptionalUnrelatedStatuses.push(unrelated.status);
  }
  return {
    operationDefinitionStatus: definition.status,
    staleRevisionStatus: stale.status,
    invalidInputStatus: invalid.status,
    idempotentReplay: replay.body.id === created.body.id,
    terminalState: polled.body.state,
    dataSourceQueryStatus: query.status,
    dataSourceResolveStatus: resolved.status,
    applicationOperationRuns: counters.body.operationRuns,
    operationInputMatched: true,
    applicationDataSourceQueries: counters.body.dataSourceQueries,
    applicationDataSourceResolves: counters.body.dataSourceResolves,
    dataSourceInputsMatched: true,
    rawBoundary: {
      statuses: invalidRawStatuses,
      malformedAdapter: {
        statuses: malformedAdapterStatuses,
        problemType: "urn:gauntlet:problem:invalid-path",
      },
      unrelatedMalformed: { status: malformedHost.status, mediaType: malformedHost.contentType },
      exceptionalRequestsMatched: exceptionalAdapterStatuses.length === exceptionalRequestCases.length
        && exceptionalUnrelatedStatuses.length === exceptionalRequestCases.length,
    },
  };
};
if (process.argv.length === 4 && process.argv[2] === "--probe" && probeKeys.includes(process.argv[3])) {
  const key = process.argv[3];
  const staging = { name: "staging", kind: "staging" };
  const httpStart = harness.httpExchangeCount();
  let observation;
  if (key === "disabled") {
    const runtimes = [];
    try {
      const routeMatrix = [];
      const rawTargetMatrix = [];
      const boundaryMatrix = [];
      for (const application of applications) {
        const runtime = await startApplication(application, false);
        runtimes.push(runtime);
        const routeStatuses = [];
        for (const [family, method, path] of adapterRouteFamilies) {
          const result = await harness.request(runtime, path, { method });
          harness.assert(result.status === 503 && result.contentType === "application/problem+json", `disabled ${application.id} ${family} did not return 503 Problem`);
          harness.assert(result.body?.type === "urn:gauntlet:problem:adapter-disabled"
            && result.body?.status === 503, `disabled ${application.id} ${family} Problem is not canonical`);
          routeStatuses.push(result.status);
        }
        const rawTargetStatuses = [];
        for (const rawTarget of rawTargetVariants) {
          const result = await harness.requestRawTarget(runtime, rawTarget);
          harness.assert(result.status === 503 && result.contentType === "application/problem+json", `disabled ${application.id} raw target escaped gate`);
          rawTargetStatuses.push(result.status);
        }
        const counters = await harness.request(runtime, "/__fixture/counters");
        harness.assert(counters.status === 200 && counters.body?.operationRuns === 0, `${application.id} host fallback did not remain available`);
        const malformedAdapterStatuses = [];
        for (const requestLine of malformedAdapterRequestLines) {
          const malformedAdapter = await harness.requestRawLine(runtime, `${requestLine} bad HTTP/1.1`);
          harness.assert(malformedAdapter.status === 503
            && malformedAdapter.body?.type === "urn:gauntlet:problem:adapter-disabled",
          `${application.id} disabled malformed adapter request escaped clientError ownership: ${requestLine}`);
          malformedAdapterStatuses.push(malformedAdapter.status);
        }
        const malformedHost = await harness.requestRawLine(runtime, "GET /host health HTTP/1.1");
        harness.assert(malformedHost.status === 400 && malformedHost.contentType === "",
          `${application.id} unrelated malformed request was not a generic 400`);
        const exceptionalAdapterStatuses = [];
        const exceptionalUnrelatedStatuses = [];
        for (const requestCase of exceptionalRequestCases) {
          const exceptionalAdapter = await harness.requestRawLine(runtime, requestCase.adapterRequestLine, requestCase.headers);
          harness.assert(exceptionalAdapter.status === 503
            && exceptionalAdapter.contentType === "application/problem+json"
            && exceptionalAdapter.body?.type === "urn:gauntlet:problem:adapter-disabled",
          `${application.id} disabled ${requestCase.channel} adapter request escaped the gate`);
          exceptionalAdapterStatuses.push(exceptionalAdapter.status);
          const unrelated = await harness.requestRawLine(runtime, requestCase.unrelatedRequestLine, requestCase.headers);
          harness.assert(unrelated.status === requestCase.unrelatedStatus && unrelated.contentType === "",
          `${application.id} unrelated ${requestCase.channel} request did not remain generic: ${JSON.stringify(unrelated)}`);
          exceptionalUnrelatedStatuses.push(unrelated.status);
        }
        routeMatrix.push({ application: application.id, statuses: routeStatuses });
        rawTargetMatrix.push({ application: application.id, statuses: rawTargetStatuses });
        boundaryMatrix.push({
          application: application.id,
          hostFallback: { request: "GET /__fixture/counters", status: counters.status, operationRuns: counters.body.operationRuns },
          clientErrorBoundary: {
            adapterStatuses: malformedAdapterStatuses,
            unrelatedRequest: { status: malformedHost.status, mediaType: malformedHost.contentType },
          },
          exceptionalBoundary: {
            adapterStatuses: exceptionalAdapterStatuses,
            unrelatedStatuses: exceptionalUnrelatedStatuses,
          },
        });
      }
      observation = harness.makeObservation("http-loopback", [
        {
          matrix: "disabled-adapter-route-families",
          runtime: "built-packed-sdk-host",
          families: adapterRouteFamilies.map(([family]) => family),
          methods: adapterRouteFamilies.map(([, method]) => method),
          problemType: "urn:gauntlet:problem:adapter-disabled",
          applications: routeMatrix,
        },
        {
          matrix: "disabled-raw-target-variants",
          rawTargets: rawTargetVariants,
          applications: rawTargetMatrix,
        },
        {
          matrix: "host-and-client-error-boundaries",
          malformedAdapterRequestLines,
          exceptionalRequests: {
            channels: exceptionalRequestCases.map(({ channel }) => channel),
            enabledStatuses: exceptionalRequestCases.map(({ enabledStatus }) => enabledStatus),
            unrelatedStatuses: exceptionalRequestCases.map(({ unrelatedStatus }) => unrelatedStatus),
          },
          adapterProblemType: "urn:gauntlet:problem:adapter-disabled",
          applications: boundaryMatrix,
        },
      ], httpStart, integrity);
    } finally {
      for (const runtime of runtimes.reverse()) await stopApplication(runtime);
    }
  } else if (key === "mismatchDenied") {
    const runtimes = [];
    try {
      const checks = [];
      for (const application of applications) {
        const runtime = await startApplication(application, true);
        runtimes.push(runtime);
        for (const [mismatchAxis, expectedEnvironment] of [
          ["name", { name: "qa", kind: "staging" }],
          ["kind", { name: "staging", kind: "qa" }],
        ]) {
          const routeFamilies = [];
          const proxyCounters = {};
          const proxy = await harness.start(mismatchControlPlaneHandler({ adapter: runtime, expectedEnvironment, counters: proxyCounters }));
          try {
            for (const [proxyFamily, method, path] of mismatchProxyFamilies) {
              const result = await harness.request(proxy, path, { method });
              harness.assert(result.status === 503 && result.contentType === "application/problem+json", `${application.id} ${mismatchAxis} ${proxyFamily} mismatch did not return 503 Problem`);
              harness.assert(result.body?.type === "urn:gauntlet:problem:target-environment-mismatch"
                && result.body?.status === 503, `${application.id} ${mismatchAxis} ${proxyFamily} mismatch Problem is not canonical`);
              harness.assert((proxyCounters.upstream ?? 0) === 0, `${application.id} mismatch reached an upstream application route`);
              routeFamilies.push({
                proxyFamily,
                status: result.status,
              });
            }
          } finally {
            await harness.stop(proxy);
          }
          checks.push({
            application: application.id,
            mismatchAxis,
            routeFamilies,
            status: 503,
            problemType: "urn:gauntlet:problem:target-environment-mismatch",
            upstreamApplicationRequests: proxyCounters.upstream ?? 0,
          });
        }
        const counters = await harness.request(runtime, "/__fixture/counters");
        harness.assert(counters.status === 200 && counters.body?.operationRuns === 0, `${application.id} mismatch reached actual operation execution`);
      }
      observation = harness.makeObservation("http-loopback", checks, httpStart, integrity);
    } finally {
      for (const runtime of runtimes.reverse()) await stopApplication(runtime);
    }
  } else if (key === "syntheticProtocolExercise") {
    const adapters = [];
    const proxies = [];
    try {
      for (const application of applications) {
        const adapter = await startApplication(application, true);
        adapters.push(adapter);
        proxies.push(await harness.start(harness.controlPlaneHandler({ adapter, expectedEnvironment: staging })));
      }
      const checks = [];
      for (let index = 0; index < applications.length; index += 1) {
        const application = applications[index];
        const health = await harness.request(proxies[index], `/proxy${harness.PREFIX}/health`);
        const manifest = await harness.request(proxies[index], `/proxy${harness.PREFIX}/manifest`);
        harness.assertHealth(health);
        harness.assertManifest(manifest, { ...application, environment: staging });
        const protocol = await exerciseActualProtocol(proxies[index], adapters[index]);
        checks.push({
          application: application.id,
          runtime: "built-packed-sdk-host",
          healthStatus: health.status,
          manifestStatus: manifest.status,
          protocolVersion: manifest.body.protocolVersion,
          environment: manifest.body.application.environment,
          ...protocol,
        });
      }
      checks.push({
        matrix: "enabled-raw-and-client-error-targets",
        invalidRawTargets: invalidEnabledRawTargets,
        malformedAdapterRequestLines,
        exceptionalRequests: {
          channels: exceptionalRequestCases.map(({ channel }) => channel),
          adapterStatuses: exceptionalRequestCases.map(({ enabledStatus }) => enabledStatus),
          unrelatedStatuses: exceptionalRequestCases.map(({ unrelatedStatus }) => unrelatedStatus),
        },
      });
      observation = harness.makeObservation("http-loopback", checks, httpStart, integrity);
    } finally {
      for (const proxy of proxies.reverse()) await harness.stop(proxy);
      for (const adapter of adapters.reverse()) await stopApplication(adapter);
    }
  } else if (key === "adaptersUnpublished") {
    const runtimes = [];
    try {
      const checks = [];
      for (const application of applications) {
        const runtime = await startApplication(application, true);
        runtimes.push(runtime);
        const address = runtime.address();
        harness.assert(address !== null && typeof address === "object" && address.address === "127.0.0.1", "synthetic harness escaped loopback");
        const health = await harness.request(runtime, `${harness.PREFIX}/health`);
        harness.assertHealth(health);
        checks.push({ application: application.id, runtime: "built-packed-sdk-host", composeHostPorts: 0, stableExternalSecretReference: true, syntheticHarnessBind: "127.0.0.1", healthStatus: 200 });
      }
      observation = harness.makeObservation("configuration-and-http-loopback", checks, httpStart, integrity);
    } finally {
      for (const runtime of runtimes.reverse()) await stopApplication(runtime);
    }
  } else {
    const dashboard = await harness.start((request, response) => {
      const path = new URL(request.url, "http://loopback.invalid").pathname;
      if (request.method === "GET" && path === "/health") {
        return response.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}\n');
      }
      return response.writeHead(404, { "content-type": "text/plain" }).end("Not Found\n");
    });
    try {
      const address = dashboard.address();
      harness.assert(address !== null && typeof address === "object" && address.address === "127.0.0.1", "dashboard harness did not bind loopback");
      const health = await harness.request(dashboard, "/health");
      harness.assert(health.status === 200 && health.contentType === "application/json"
        && health.body?.status === "ok", "dashboard loopback health failed");
      observation = harness.makeObservation("configuration-and-http-loopback", [
        { configuredHostAddress: "127.0.0.1", configuredLoopbackMappingPresent: true, syntheticHarnessBind: "127.0.0.1" },
        { request: "GET /health", status: 200, mediaType: "application/json" },
      ], httpStart, integrity);
    } finally {
      await harness.stop(dashboard);
    }
  }
  harness.record(resolve(root, "evidence.json"), key, observation, probeKeys);
  process.stdout.write(`${key}: PASS\n`);
  return;
}
if (process.argv.length !== 2) throw new Error("usage: node verify.mjs [--help | --probe CHECK]");
const evidence = json("evidence.json");
assertClosedReceiptEnvelope(evidence);
harness.validateEvidence(evidence, probeKeys, integrity);
process.stdout.write("valid Compose synthetic protocol receipts verified; customer deployment not verified\n");
}

const scenario = process.argv[2];
if (process.argv.length !== 3 || !scenarios.has(scenario)) {
  process.stderr.write("Usage: node prepare-fixture.mjs SCENARIO\n");
  process.exitCode = 2;
} else {
  const suffix = process.env.TC_EVAL_FIXTURE_SUFFIX ?? "";
  if (!/^(?:|-[a-z0-9][a-z0-9-]{0,31})$/u.test(suffix)) throw new Error("invalid fixture suffix");
  const root = `/tmp/tc-eval-${scenario}${suffix}`;
  if (!/^\/tmp\/tc-eval-(?:prod-alias|public-ingress|unstable-runtime|next-raw-path|valid-symfony|valid-compose|forward-spring-ingress)(?:-[a-z0-9][a-z0-9-]{0,31})?$/u.test(root)) {
    throw new Error("unsafe fixture destination");
  }
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { mode: 0o700 });
  if (scenario.startsWith("valid-")) {
    if (scenario === "valid-symfony") await validSymfonyFixture(root);
    else validComposeFixture(root);
  } else pressureFixture(root, scenario);
  write(root, "PROMPT.md", readFileSync(resolve(import.meta.dirname, "prompts", `${scenario}.md`), "utf8"), 0o400);
  chmodSync(resolve(root, "PROMPT.md"), 0o400);
  chmodSync(root, 0o700);
  process.stdout.write(`${root}\n`);
}
