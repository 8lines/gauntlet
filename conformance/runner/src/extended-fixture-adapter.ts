import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  canonicalizeForRevision,
  computeRevision,
  type JsonObject,
} from "@8lines/gauntlet-protocol";
import { assertEndpointDocument } from "./schema-validator.js";
import type { AdapterV1ExtendedScenario } from "./extended-scenario.js";

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const JSON_MEDIA = "application/json";
const PROBLEM_MEDIA = "application/problem+json";
const SECOND_ITEM = "22222222-2222-4222-8222-222222222222";
const NEXT_CURSOR = "extended-page-2";

export interface ExtendedFixtureRequestRecord {
  readonly method: string;
  readonly rawPath: string;
  readonly bodyBytes: number;
}

export interface ExtendedFixtureAdapterHandle {
  readonly baseUrl: string;
  readonly requests: readonly ExtendedFixtureRequestRecord[];
  close(): Promise<void>;
}

interface ExtendedDocuments {
  readonly manifest: Record<string, unknown>;
  readonly operations: ReadonlyMap<string, Record<string, unknown>>;
  readonly failedRun: Record<string, unknown>;
  readonly customRun: Record<string, unknown>;
}

function operation(
  id: string,
  label: string,
  requiredProfiles: readonly string[],
  outputSchema: JsonObject,
): Record<string, unknown> {
  const document = {
    id,
    label,
    featureId: "agency-applications",
    order: 10,
    tags: ["extended-conformance"],
    requirements: { profiles: requiredProfiles, capabilities: [] },
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
    dataSources: [],
    presets: [],
    execution: {
      impact: "write",
      confirmationRequired: true,
      dryRunSupported: false,
      idempotency: "required",
      cancellationSupported: false,
      concurrency: "forbid",
    },
    output: { schema: outputSchema },
  };
  return { ...document, revision: computeRevision(document as unknown as JsonObject) };
}

function buildDocuments(scenario: AdapterV1ExtendedScenario): ExtendedDocuments {
  const failure = operation(
    scenario.handlerFailure.operationId,
    "Fail agency application",
    ["tc-schema-core@1"],
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
    },
  );
  const custom = operation(
    scenario.customBinding.operationId,
    "Finalize agency application",
    ["tc-schema-core@1", "tc-rich-forms@1", "tc-rich-results@1"],
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      required: ["finalized"],
      properties: { finalized: { type: "boolean" } },
      additionalProperties: false,
    },
  );
  const dataSource = {
    id: scenario.pagination.dataSourceId,
    label: "Pending applications",
    capabilities: {
      search: true,
      pagination: "cursor",
      resolve: true,
      defaultLimit: 20,
      maxLimit: 100,
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
        requestId: { type: "string" },
        target: {
          type: "object",
          required: ["id", "environment"],
          properties: { id: { type: "string" }, environment: { type: "string" } },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  };
  const summaries = [failure, custom].map((definition) => ({
    id: definition.id,
    revision: definition.revision,
    label: definition.label,
    featureId: definition.featureId,
    availability: { state: "available" },
    requirements: definition.requirements,
  }));
  const manifestWithoutRevision = {
    protocolVersion: "1.0",
    schemaDialect: "https://json-schema.org/draft/2020-12/schema",
    profiles: ["tc-schema-core@1", "tc-rich-forms@1", "tc-rich-results@1"],
    capabilities: [],
    application: {
      id: "extended-conformance-adapter",
      label: "Extended conformance fixture",
      environment: { name: "conformance-fixture-test", kind: "test" },
    },
    features: [{ id: "agency-applications", label: "Agency applications", order: 10 }],
    operations: summaries,
    dataSources: [dataSource],
  };
  const manifest = {
    ...manifestWithoutRevision,
    manifestRevision: computeRevision(manifestWithoutRevision as unknown as JsonObject, "manifestRevision"),
  };
  const failedRun = {
    id: "conformance-extended-failed-run",
    operationId: failure.id,
    operationRevision: failure.revision,
    sequence: 1,
    state: "failed",
    createdAt: "2026-08-29T12:00:00Z",
    updatedAt: "2026-08-29T12:00:01Z",
    startedAt: "2026-08-29T12:00:00Z",
    completedAt: "2026-08-29T12:00:01Z",
    problem: {
      type: "urn:gauntlet:problem:handler-failed",
      title: "Operation failed",
      status: 500,
      correlationId: scenario.handlerFailure.context.requestId,
    },
    artifacts: [],
    actions: [],
  };
  const customRun = {
    id: "conformance-extended-custom-run",
    operationId: custom.id,
    operationRevision: custom.revision,
    sequence: 1,
    state: "succeeded",
    createdAt: "2026-08-29T12:00:00Z",
    updatedAt: "2026-08-29T12:00:01Z",
    startedAt: "2026-08-29T12:00:00Z",
    completedAt: "2026-08-29T12:00:01Z",
    summary: { title: "Application finalized", tone: "success" },
    output: scenario.customBinding.expectedOutput,
    artifacts: [{
      id: scenario.customBinding.expectedArtifactId,
      kind: "notice",
      level: "success",
      message: "Custom binding executed.",
    }],
    actions: [],
  };
  return {
    manifest,
    operations: new Map([[String(failure.id), failure], [String(custom.id), custom]]),
    failedRun,
    customRun,
  };
}

function writeJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  mediaType = JSON_MEDIA,
  headers: Readonly<Record<string, string>> = {},
): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": mediaType,
    "content-length": String(Buffer.byteLength(body)),
    ...headers,
  });
  response.end(body);
}

function writeProblem(response: ServerResponse, status: number, type: string, title: string): void {
  writeJson(response, status, { type, title, status }, PROBLEM_MEDIA);
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

function parseDocument(bytes: Buffer): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    canonicalizeForRevision(value as Parameters<typeof canonicalizeForRevision>[0]);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function sameDocument(left: unknown, right: unknown): boolean {
  return canonicalizeForRevision(left as Parameters<typeof canonicalizeForRevision>[0])
    === canonicalizeForRevision(right as Parameters<typeof canonicalizeForRevision>[0]);
}

function expectedCreate(
  definition: Record<string, unknown>,
  invocation: AdapterV1ExtendedScenario["handlerFailure"] | AdapterV1ExtendedScenario["customBinding"],
): JsonObject {
  const execution = definition.execution as Record<string, unknown>;
  return {
    operationRevision: String(definition.revision),
    input: invocation.input,
    context: invocation.context as unknown as JsonObject,
    idempotencyKey: invocation.idempotencyKey,
    ...(execution.confirmationRequired === true
      ? {
          confirmation: {
            operationId: String(definition.id),
            operationRevision: String(definition.revision),
            impact: String(execution.impact),
          },
        }
      : {}),
  };
}

function makeHandler(
  scenario: AdapterV1ExtendedScenario,
  enabled: boolean,
  documents: ExtendedDocuments,
  requests: ExtendedFixtureRequestRecord[],
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    const method = request.method ?? "";
    const path = request.url ?? "";
    const log = (bodyBytes: number): void => {
      requests.push({ method, rawPath: path, bodyBytes });
    };
    if (!enabled && (path === "/_gauntlet/v1" || path.startsWith("/_gauntlet/v1/"))) {
      log(0);
      writeProblem(response, 503, "urn:gauntlet:problem:adapter-disabled", "Adapter disabled");
      return;
    }
    if (method === "GET" && path === "/_gauntlet/v1/manifest") {
      log(0);
      const revision = String(documents.manifest.manifestRevision);
      writeJson(response, 200, documents.manifest, JSON_MEDIA, { etag: `"${revision}"` });
      return;
    }
    const operationMatch = /^\/_gauntlet\/v1\/operations\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/.exec(path);
    if (method === "GET" && operationMatch !== null) {
      log(0);
      const definition = documents.operations.get(operationMatch[1]!);
      if (definition === undefined) {
        writeProblem(response, 404, "urn:gauntlet:problem:operation-not-found", "Operation not found");
      } else {
        writeJson(response, 200, definition, JSON_MEDIA, { etag: `"${String(definition.revision)}"` });
      }
      return;
    }
    const createMatch = /^\/_gauntlet\/v1\/operations\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/runs$/.exec(path);
    if (method === "POST" && createMatch !== null) {
      const bytes = await readBody(request);
      log(bytes.byteLength);
      const document = parseDocument(bytes);
      const id = createMatch[1]!;
      const definition = documents.operations.get(id);
      const invocation = id === scenario.handlerFailure.operationId
        ? scenario.handlerFailure
        : id === scenario.customBinding.operationId
          ? scenario.customBinding
          : undefined;
      if (document === undefined
        || definition === undefined
        || invocation === undefined
        || !sameDocument(document, expectedCreate(definition, invocation))) {
        writeProblem(response, 422, "urn:gauntlet:problem:validation-failed", "Request validation failed");
      } else {
        writeJson(
          response,
          201,
          id === scenario.handlerFailure.operationId ? documents.failedRun : documents.customRun,
        );
      }
      return;
    }
    const queryPath = `/_gauntlet/v1/data-sources/${scenario.pagination.dataSourceId}/query`;
    if (method === "POST" && path === queryPath) {
      const bytes = await readBody(request);
      log(bytes.byteLength);
      const document = parseDocument(bytes);
      let valid = document !== undefined;
      try {
        if (document !== undefined) assertEndpointDocument("dataSourceQuery", document);
      } catch {
        valid = false;
      }
      const cursor = document?.cursor;
      const base = document === undefined ? undefined : { ...document };
      if (base !== undefined) delete base.cursor;
      if (!valid
        || !sameDocument(base, scenario.pagination.query)
        || (cursor !== undefined && cursor !== NEXT_CURSOR)) {
        writeProblem(response, 422, "urn:gauntlet:problem:validation-failed", "Request validation failed");
      } else if (cursor === undefined) {
        writeJson(response, 200, {
          items: [{ value: String(scenario.customBinding.input.applicationId), label: "First pending application" }],
          nextCursor: NEXT_CURSOR,
        });
      } else {
        writeJson(response, 200, {
          items: [{ value: SECOND_ITEM, label: "Second pending application" }],
        });
      }
      return;
    }
    log(0);
    writeProblem(response, 404, "urn:gauntlet:problem:route-not-found", "Route not found");
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

export async function startExtendedFixtureAdapter(options: {
  readonly scenario: AdapterV1ExtendedScenario;
  readonly enabled: boolean;
}): Promise<ExtendedFixtureAdapterHandle> {
  const documents = buildDocuments(options.scenario);
  const requests: ExtendedFixtureRequestRecord[] = [];
  const handler = makeHandler(options.scenario, options.enabled, documents, requests);
  const server = createServer({ maxHeaderSize: 16_384 }, (request, response) => {
    void handler(request, response).catch(() => {
      if (!response.headersSent) {
        writeProblem(response, 500, "urn:gauntlet:problem:adapter-internal-error", "Adapter internal error");
      } else {
        response.destroy();
      }
    });
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  server.on("connection", (socket) => socket.setTimeout(10_000, () => socket.destroy()));
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
    server.listen(0, "127.0.0.1");
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("Extended fixture failed to bind TCP");
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
