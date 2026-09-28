#!/usr/bin/env node

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  canonicalizeForRevision,
  computeRevision,
  type JsonObject,
} from "@8lines/gauntlet-protocol";
import { loadAdapterV1Scenario, type AdapterV1Scenario } from "./scenario.js";
import {
  assertEndpointDocument,
  type EndpointDocument,
} from "./schema-validator.js";

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const JSON_MEDIA = "application/json";
const PROBLEM_MEDIA = "application/problem+json";

export type FixtureMode =
  | "async-success"
  | "sync-success"
  | "invalid-terminal"
  | "session-disabled"
  | "secret-echo";

export interface FixtureRequestRecord {
  readonly method: string;
  readonly rawPath: string;
  readonly ifNoneMatch?: string;
  readonly contentType?: string;
  readonly bodyBytes: number;
  readonly bodyClass:
    | "none"
    | "stale-create"
    | "invalid-create"
    | "dry-run-create"
    | "fresh-create"
    | "replay-create"
    | "data-source-query"
    | "data-source-resolve";
}

export interface FixtureAdapterHandle {
  readonly baseUrl: string;
  readonly requests: readonly FixtureRequestRecord[];
  close(): Promise<void>;
}

interface FixtureDocuments {
  readonly operation: Record<string, unknown>;
  readonly manifest: Record<string, unknown>;
  readonly activeRun: Record<string, unknown>;
  readonly terminalRun: Record<string, unknown>;
  readonly invalidTerminalRun: Record<string, unknown>;
}

interface BindOptions {
  readonly host: "127.0.0.1";
  readonly port: number;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function buildDocuments(scenario: AdapterV1Scenario, sessionEnabled: boolean): FixtureDocuments {
  const operationWithoutRevision = {
    id: scenario.operationId,
    label: "Finalize agency application",
    featureId: "agency-applications",
    description: "Finalize a pending agency application.",
    order: 10,
    tags: ["agency", "applications"],
    requirements: {
      profiles: [...scenario.requiredProfiles],
      capabilities: [...scenario.requiredCapabilities],
    },
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      required: ["applicationId", "confirmationCode"],
      properties: {
        applicationId: { type: "string", format: "uuid" },
        confirmationCode: { type: "string", pattern: "^[0-9]{6}$" },
      },
      additionalProperties: false,
    },
    inputHandling: {
      rules: [{ kind: "secret", schemaPointer: "/properties/confirmationCode", retention: "none" }],
    },
    dataSources: [{
      id: scenario.dataSourceId,
      inputPointer: "/applicationId",
      dependencyPointers: ["/workflowState"],
      contextPointers: ["/target/id"],
      required: true,
    }],
    presets: [],
    execution: {
      impact: "write",
      confirmationRequired: true,
      dryRunSupported: false,
      idempotency: "required",
      cancellationSupported: false,
      concurrency: "queue",
    },
    output: {
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        required: ["applicationId", "finalized"],
        properties: {
          applicationId: { type: "string", format: "uuid" },
          finalized: { const: true },
        },
        additionalProperties: false,
      },
      presentation: { profile: "tc-rich-results@1", defaultView: "summary" },
    },
  };
  const operation = {
    ...operationWithoutRevision,
    revision: computeRevision(operationWithoutRevision as unknown as JsonObject),
  };

  const dataSource = {
    id: scenario.dataSourceId,
    label: "Pending applications",
    description: "Applications eligible for finalization.",
    capabilities: {
      search: true,
      pagination: "cursor",
      resolve: true,
      defaultLimit: 2,
      maxLimit: 20,
    },
    dependencySchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      required: ["/workflowState"],
      properties: { "/workflowState": { const: "pending" } },
      additionalProperties: false,
    },
    contextSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      required: ["requestId", "target"],
      properties: {
        requestId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
        locale: { type: "string" },
        timeZone: { type: "string" },
        actor: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
            displayName: { type: "string" },
          },
          additionalProperties: false,
        },
        target: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
            environment: { type: "string" },
          },
          additionalProperties: false,
        },
        extensions: {
          type: "object",
          propertyNames: { pattern: "^urn:[A-Za-z0-9][A-Za-z0-9:._/-]*$" },
        },
      },
      additionalProperties: false,
    },
  };

  const manifestWithoutRevision = {
    protocolVersion: "1.0",
    schemaDialect: "https://json-schema.org/draft/2020-12/schema",
    profiles: unique(["tc-schema-core@1", "tc-rich-forms@1", "tc-rich-results@1", ...scenario.requiredProfiles]),
    capabilities: unique([
      ...scenario.requiredCapabilities,
      ...(sessionEnabled ? ["tc-session-launch@1"] : []),
    ]),
    application: {
      id: "conformance-adapter",
      label: "Conformance fixture",
      environment: { name: "conformance-fixture-test", kind: "test" },
    },
    features: [{ id: "agency-applications", label: "Agency applications", order: 10 }],
    operations: [{
      id: operation.id,
      revision: operation.revision,
      label: operation.label,
      featureId: operation.featureId,
      availability: { state: "available" },
      requirements: operation.requirements,
    }],
    dataSources: [dataSource],
  };
  const manifest = {
    ...manifestWithoutRevision,
    manifestRevision: computeRevision(manifestWithoutRevision as unknown as JsonObject, "manifestRevision"),
  };

  const activeRun = {
    id: "conformance-run-01",
    operationId: scenario.operationId,
    operationRevision: operation.revision,
    sequence: 0,
    state: "queued",
    createdAt: "2026-08-29T12:00:00Z",
    updatedAt: "2026-08-29T12:00:00Z",
    progress: { current: 0, total: 1, phase: "queued", updatedAt: "2026-08-29T12:00:00Z" },
    artifacts: [],
    actions: [],
  };
  const browserArtifacts = sessionEnabled && scenario.browserLaunch !== undefined
    ? [{ id: scenario.browserLaunch.artifactId, kind: "browser-launch", label: "Open finalized application" }]
    : [];
  const browserActions = sessionEnabled && scenario.browserLaunch !== undefined
    ? [{ kind: "browser-launch", label: "Open finalized application", artifactId: scenario.browserLaunch.artifactId }]
    : [];
  const terminalRun = {
    id: activeRun.id,
    operationId: activeRun.operationId,
    operationRevision: activeRun.operationRevision,
    sequence: 1,
    state: scenario.expectedTerminalState,
    createdAt: activeRun.createdAt,
    updatedAt: "2026-08-29T12:00:02Z",
    startedAt: "2026-08-29T12:00:01Z",
    completedAt: "2026-08-29T12:00:02Z",
    progress: { current: 1, total: 1, phase: "complete", updatedAt: "2026-08-29T12:00:02Z" },
    summary: { title: "Application finalized", message: "Finalization completed.", tone: "success" },
    output: { applicationId: scenario.input.applicationId, finalized: true },
    artifacts: [
      { id: "conformance-summary", kind: "notice", level: "success", message: "Application finalized." },
      ...browserArtifacts,
    ],
    actions: [
      { kind: "invoke-operation", label: "Finalize another", operationId: scenario.operationId },
      ...browserActions,
    ],
  };
  const invalidTerminalRun = {
    ...terminalRun,
    state: "failed",
    summary: { title: "Fixture failure", tone: "error" },
  };
  return { operation, manifest, activeRun, terminalRun, invalidTerminalRun };
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

function writeJson(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": JSON_MEDIA,
    "content-length": String(Buffer.byteLength(body)),
    ...headers,
  });
  response.end(body);
}

function writeProblem(
  response: ServerResponse,
  status: number,
  type: string,
  extra: Record<string, unknown> = {},
): void {
  const body = JSON.stringify({ type, title: "Conformance fixture problem", status, ...extra });
  response.writeHead(status, {
    "content-type": PROBLEM_MEDIA,
    "content-length": String(Buffer.byteLength(body)),
  });
  response.end(body);
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error("request too large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

function parseBody(bytes: Buffer): Record<string, unknown> | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = JSON.parse(text) as unknown;
    canonicalizeForRevision(value as Parameters<typeof canonicalizeForRevision>[0]);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function recordRequest(
  requests: FixtureRequestRecord[],
  request: IncomingMessage,
  bodyBytes: number,
  bodyClass: FixtureRequestRecord["bodyClass"],
  secret: string,
): void {
  const sanitize = (value: string | undefined): string | undefined => value === undefined
    ? undefined
    : (secret.length > 0 && value.includes(secret) ? "[REDACTED]" : value);
  const ifNoneMatch = sanitize(headerValue(request, "if-none-match"));
  const contentType = sanitize(headerValue(request, "content-type"));
  requests.push({
    method: request.method ?? "",
    rawPath: request.url ?? "",
    ...(ifNoneMatch === undefined ? {} : { ifNoneMatch }),
    ...(contentType === undefined ? {} : { contentType }),
    bodyBytes,
    bodyClass,
  });
}

function endpointDocumentIsValid(endpoint: EndpointDocument, value: Record<string, unknown>): boolean {
  try {
    assertEndpointDocument(endpoint, value);
    return true;
  } catch {
    return false;
  }
}

function changedRevision(revision: string): string {
  const last = revision.at(-1)!;
  return `${revision.slice(0, -1)}${last === "0" ? "1" : "0"}`;
}

function expectedCreate(
  operation: Record<string, unknown>,
  operationRevision: string,
  input: JsonObject,
  requestId: string,
  idempotencyKey: string,
  dryRun = false,
): JsonObject {
  const execution = operation.execution as Record<string, unknown>;
  return {
    operationRevision,
    input,
    context: {
      requestId,
      target: { id: "conformance-target", environment: "test" },
    },
    dryRun,
    idempotencyKey,
    ...(execution.confirmationRequired === true
      ? {
          confirmation: {
            operationId: String(operation.id),
            operationRevision,
            impact: String(execution.impact),
          },
        }
      : {}),
  };
}

function isExactDocument(value: Record<string, unknown>, expected: JsonObject): boolean {
  return canonicalizeForRevision(value as unknown as JsonObject) === canonicalizeForRevision(expected);
}

function makeHandler(
  scenario: AdapterV1Scenario,
  mode: FixtureMode,
  documents: FixtureDocuments,
  requests: FixtureRequestRecord[],
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  let freshSeen = false;
  const operationTag = `"${String(documents.operation.revision)}"`;
  const manifestTag = `"${String(documents.manifest.manifestRevision)}"`;
  const secret = typeof scenario.input.confirmationCode === "string" ? scenario.input.confirmationCode : "";

  return async (request, response) => {
    const method = request.method ?? "";
    const path = request.url ?? "";
    const log = (bodyBytes: number, bodyClass: FixtureRequestRecord["bodyClass"]): void => {
      recordRequest(requests, request, bodyBytes, bodyClass, secret);
    };

    if (method === "GET" && path === "/_gauntlet/v1/health") {
      log(0, "none");
      writeJson(response, 200, { status: "ok", protocolVersion: "1.0" });
      return;
    }
    if (method === "GET" && path === "/_gauntlet/v1/manifest") {
      log(0, "none");
      if (headerValue(request, "if-none-match") === manifestTag) {
        response.writeHead(304, { etag: manifestTag }).end();
      } else {
        writeJson(response, 200, documents.manifest, { etag: manifestTag });
      }
      return;
    }
    if (method === "GET" && path === `/_gauntlet/v1/operations/${scenario.operationId}`) {
      log(0, "none");
      if (headerValue(request, "if-none-match") === operationTag) {
        response.writeHead(304, { etag: operationTag }).end();
      } else {
        writeJson(response, 200, documents.operation, { etag: operationTag });
      }
      return;
    }
    if (method === "GET" && path === "/_gauntlet/v1/operations/unsafe!id") {
      log(0, "none");
      writeProblem(response, 400, "urn:gauntlet:problem:invalid-path");
      return;
    }
    if (method === "GET" && path === "/_gauntlet/v1/operations/conformance-missing-operation") {
      log(0, "none");
      writeProblem(response, 404, "urn:gauntlet:problem:operation-not-found");
      return;
    }
    if (method === "GET" && path === "/_gauntlet/v1/runs/conformance-missing-run") {
      log(0, "none");
      writeProblem(response, 404, "urn:gauntlet:problem:run-not-found");
      return;
    }
    if (method === "POST" && path === "/_gauntlet/v1/uploads") {
      log(0, "none");
      writeProblem(response, 501, "urn:gauntlet:problem:unsupported-capability", { capability: "tc-uploads@1" });
      return;
    }
    if (method === "POST" && path === "/_gauntlet/v1/runs/conformance-run-01/cancel") {
      log(0, "none");
      writeProblem(response, 501, "urn:gauntlet:problem:unsupported-capability", { capability: "tc-run-cancellation@1" });
      return;
    }
    if (method === "GET" && path === "/_gauntlet/v1/runs/conformance-run-01/events") {
      log(0, "none");
      writeProblem(response, 501, "urn:gauntlet:problem:unsupported-capability", { capability: "tc-run-sse@1" });
      return;
    }

    const launchMatch = /^\/_gauntlet\/v1\/runs\/([^/]+)\/artifacts\/([^/]+)\/launch$/.exec(path);
    if (method === "POST" && launchMatch !== null) {
      log(0, "none");
      if (mode === "session-disabled") {
        writeProblem(response, 501, "urn:gauntlet:problem:unsupported-capability", { capability: "tc-session-launch@1" });
      } else if (launchMatch[1] === "conformance-run-01"
        && launchMatch[2] === scenario.browserLaunch?.artifactId
        && scenario.browserLaunch !== undefined) {
        writeJson(response, 201, {
          url: `${scenario.browserLaunch.expectedPublicOrigin}/gauntlet/session/conformance-launch-01`,
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
          singleUse: true,
        });
      } else {
        writeProblem(response, 404, "urn:gauntlet:problem:run-not-found");
      }
      return;
    }

    if (method === "GET" && path === "/_gauntlet/v1/runs/conformance-run-01") {
      log(0, "none");
      writeJson(response, 200, mode === "invalid-terminal" ? documents.invalidTerminalRun : documents.terminalRun);
      return;
    }

    const createPath = `/_gauntlet/v1/operations/${scenario.operationId}/runs`;
    if (method === "POST" && path === createPath) {
      let body: Buffer;
      try {
        body = await readBody(request);
      } catch {
        writeProblem(response, 413, "urn:gauntlet:problem:validation-failed");
        return;
      }
      const document = parseBody(body);
      if (document === undefined) {
        log(body.byteLength, "invalid-create");
        writeProblem(response, 400, "urn:gauntlet:problem:invalid-json");
        return;
      }
      if (!endpointDocumentIsValid("createRunRequest", document)) {
        log(body.byteLength, "invalid-create");
        writeProblem(response, 422, "urn:gauntlet:problem:validation-failed");
        return;
      }

      const expectedStale = expectedCreate(
        documents.operation,
        changedRevision(String(documents.operation.revision)),
        scenario.input,
        "conformance-stale-01",
        "conformance-finalize-01-stale",
      );
      if (isExactDocument(document, expectedStale)) {
        log(body.byteLength, "stale-create");
        writeProblem(response, 409, "urn:gauntlet:problem:stale-operation-revision");
        return;
      }

      const expectedInvalid = expectedCreate(
        documents.operation,
        String(documents.operation.revision),
        scenario.invalidInput,
        "conformance-invalid-01",
        "conformance-finalize-01-invalid",
      );
      if (isExactDocument(document, expectedInvalid)) {
        log(body.byteLength, "invalid-create");
        writeProblem(response, 422, "urn:gauntlet:problem:validation-failed", {
          errors: [{
            instancePath: "/applicationId",
            schemaPath: "#/properties/applicationId/format",
            keyword: "format",
            message: "must match format uuid",
            params: { format: "uuid" },
          }],
        });
        return;
      }

      const expectedDryRun = expectedCreate(
        documents.operation,
        String(documents.operation.revision),
        scenario.input,
        "conformance-dry-run-01",
        "conformance-finalize-01-dry-run",
        true,
      );
      if (isExactDocument(document, expectedDryRun)) {
        log(body.byteLength, "dry-run-create");
        writeProblem(response, 422, "urn:gauntlet:problem:validation-failed", {
          errors: [{
            instancePath: "/dryRun",
            schemaPath: "#/properties/dryRun/const",
            keyword: "const",
            message: "must be equal to constant",
            params: { allowedValue: false },
          }],
        });
        return;
      }

      const expectedFresh = expectedCreate(
        documents.operation,
        String(documents.operation.revision),
        scenario.input,
        "conformance-run-01",
        scenario.idempotencyKey,
      );
      if (!isExactDocument(document, expectedFresh)) {
        log(body.byteLength, "invalid-create");
        writeProblem(response, 422, "urn:gauntlet:problem:validation-failed");
        return;
      }
      const input = document.input as Record<string, unknown>;
      const replay = freshSeen;
      freshSeen = true;
      log(body.byteLength, replay ? "replay-create" : "fresh-create");
      if (mode === "secret-echo") {
        writeJson(response, 202, { echo: input?.confirmationCode });
      } else if (mode === "sync-success" || replay) {
        writeJson(response, 201, documents.terminalRun);
      } else {
        writeJson(response, 202, documents.activeRun);
      }
      return;
    }

    const queryPath = `/_gauntlet/v1/data-sources/${scenario.dataSourceId}/query`;
    const missingQueryPath = "/_gauntlet/v1/data-sources/conformance-missing-data-source/query";
    if (method === "POST" && (path === queryPath || path === missingQueryPath)) {
      const body = await readBody(request);
      const document = parseBody(body);
      log(body.byteLength, "data-source-query");
      if (document === undefined
        || !endpointDocumentIsValid("dataSourceQuery", document)
        || !isExactDocument(document, scenario.dataSourceQuery as unknown as JsonObject)) {
        writeProblem(response, 422, "urn:gauntlet:problem:validation-failed");
      } else if (path === missingQueryPath) {
        writeProblem(response, 404, "urn:gauntlet:problem:data-source-not-found");
      } else {
        const values = scenario.dataSourceResolveRequest.values;
        writeJson(response, 200, {
          items: values.slice(0, scenario.dataSourceQuery.limit ?? values.length).map((value, index) => ({
            value,
            label: index === 0 ? "Brown application" : "Second pending application",
          })),
        });
      }
      return;
    }

    const resolvePath = `/_gauntlet/v1/data-sources/${scenario.dataSourceId}/resolve`;
    if (method === "POST" && path === resolvePath) {
      const body = await readBody(request);
      const document = parseBody(body);
      log(body.byteLength, "data-source-resolve");
      if (document === undefined
        || !endpointDocumentIsValid("dataSourceResolveRequest", document)
        || !isExactDocument(document, scenario.dataSourceResolveRequest as unknown as JsonObject)) {
        writeProblem(response, 422, "urn:gauntlet:problem:validation-failed");
      } else {
        const values = document.values as readonly string[];
        writeJson(response, 200, {
          results: values.map((value, index) => ({
            value,
            item: { value, label: index === 0 ? "Brown application" : "Second pending application" },
          })),
        });
      }
      return;
    }

    log(0, "none");
    writeProblem(response, 404, "urn:gauntlet:problem:route-not-found");
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve();
    };
    const deadline = setTimeout(() => {
      server.closeIdleConnections();
      server.closeAllConnections();
      finish();
    }, 2_000);
    server.close(finish);
  });
}

async function startBoundFixture(
  options: { readonly scenario: AdapterV1Scenario; readonly mode?: FixtureMode },
  bind: BindOptions,
): Promise<FixtureAdapterHandle> {
  const mode = options.mode ?? "async-success";
  const sessionEnabled = mode !== "session-disabled";
  const documents = buildDocuments(options.scenario, sessionEnabled);
  const requests: FixtureRequestRecord[] = [];
  const handler = makeHandler(options.scenario, mode, documents, requests);
  const server = createServer(
    { maxHeaderSize: 16_384 },
    (request, response) => {
      void handler(request, response).catch(() => {
        if (!response.headersSent) writeProblem(response, 500, "urn:gauntlet:problem:adapter-internal-error");
        else response.destroy();
      });
    },
  );
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  server.on("connection", (socket) => socket.setTimeout(10_000, () => socket.destroy()));

  const listening = new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  server.listen(bind.port, bind.host);
  try {
    await listening;
  } catch (error) {
    server.closeAllConnections();
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("Fixture failed to bind TCP");
  }

  let closePromise: Promise<void> | undefined;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close() {
      closePromise ??= closeServer(server);
      return closePromise;
    },
  };
}

export async function startFixtureAdapter(options: {
  readonly scenario: AdapterV1Scenario;
  readonly mode?: FixtureMode;
}): Promise<FixtureAdapterHandle> {
  return await startBoundFixture(options, { host: "127.0.0.1", port: 0 });
}

interface FixtureCliOptions {
  readonly scenarioPath: string;
  readonly host: "127.0.0.1";
  readonly port: number;
}

function parseFixtureArguments(arguments_: readonly string[]): FixtureCliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (flag === undefined
      || value === undefined
      || flag.includes("=")
      || !["--scenario", "--host", "--port"].includes(flag)
      || values.has(flag)
      || value.startsWith("--")) {
      throw new ConfigurationError();
    }
    values.set(flag, value);
  }
  const scenarioPath = values.get("--scenario");
  const host = values.get("--host") ?? "127.0.0.1";
  const portText = values.get("--port") ?? "0";
  if (scenarioPath === undefined
    || scenarioPath.length === 0
    || host !== "127.0.0.1"
    || !/^(0|[1-9][0-9]{0,4})$/.test(portText)
    || Number(portText) > 65_535) {
    throw new ConfigurationError();
  }
  return { scenarioPath, host, port: Number(portText) };
}

class ConfigurationError extends Error {}

async function fixtureMain(): Promise<void> {
  let options: FixtureCliOptions;
  let scenario: AdapterV1Scenario;
  try {
    options = parseFixtureArguments(process.argv.slice(2));
    scenario = await loadAdapterV1Scenario(options.scenarioPath);
  } catch {
    process.stderr.write("Fixture configuration failed\n");
    process.exitCode = 2;
    return;
  }

  let handle: FixtureAdapterHandle;
  try {
    handle = await startBoundFixture({ scenario }, { host: options.host, port: options.port });
  } catch {
    process.stderr.write("Fixture failed\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${handle.baseUrl}\n`);
  const close = (): void => {
    void handle.close().then(
      () => { process.exitCode = 0; },
      () => { process.exitCode = 1; },
    );
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

const isMain = (() => {
  try {
    return process.argv[1] !== undefined
      && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) void fixtureMain();
