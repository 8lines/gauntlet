import type { AdapterClientOptions } from "@8lines/gauntlet-dashboard-client";
import {
  computeRevision,
  type AdapterManifest,
  type CreateRunRequest,
  type DataSourcePage,
  type DataSourceResolveResponse,
  type EnvironmentDescriptor,
  type JsonObject,
  type OperationDefinition,
  type Problem,
  type Run,
  type RunEvent,
  type SessionLaunchResponse,
  type UploadResponse,
} from "@8lines/gauntlet-protocol";
import createRunRequestDocument from "@8lines/gauntlet-protocol/fixtures/v1/create-run-request.valid.json" with { type: "json" };
import dataSourcePageDocument from "@8lines/gauntlet-protocol/fixtures/v1/data-source-page.valid.json" with { type: "json" };
import dataSourceResolveDocument from "@8lines/gauntlet-protocol/fixtures/v1/data-source-resolve-response.valid.json" with { type: "json" };
import manifestDocument from "@8lines/gauntlet-protocol/fixtures/v1/manifest.valid.json" with { type: "json" };
import operationDocument from "@8lines/gauntlet-protocol/fixtures/v1/operation.valid.json" with { type: "json" };
import type { StaticTargetConfig } from "../../src/static-target-provider.js";
import { adapterEnvironment } from "./environment.js";

export const fakeTarget: StaticTargetConfig = Object.freeze({
  id: "acme",
  label: "Acme",
  adapterUrl: "http://acme.internal",
  publicUrl: "https://app.example.test",
  expectedEnvironment: adapterEnvironment,
  tags: Object.freeze(["symfony"]),
});

export function createHappyOperation(): OperationDefinition {
  const operation = structuredClone(operationDocument) as OperationDefinition;
  const mutable = operation as unknown as JsonObject & {
    revision: string;
    requirements: { profiles: string[]; capabilities: string[] };
  };
  mutable.requirements.capabilities = [
    "tc-uploads@1",
    "tc-run-cancellation@1",
    "tc-run-sse@1",
    "tc-session-launch@1",
  ];
  mutable.revision = computeRevision(mutable);
  return operation;
}

export function createHappyManifest(operation = createHappyOperation()): AdapterManifest {
  const manifest = structuredClone(manifestDocument) as AdapterManifest;
  const mutable = manifest as unknown as JsonObject & {
    manifestRevision: string;
    capabilities: string[];
    operations: Array<Record<string, unknown>>;
  };
  mutable.capabilities = [
    "tc-uploads@1",
    "tc-run-cancellation@1",
    "tc-run-sse@1",
    "tc-session-launch@1",
  ];
  mutable.operations = [{
    id: operation.id,
    revision: operation.revision,
    label: operation.label,
    featureId: operation.featureId,
    availability: { state: "available" },
    ...(operation.requirements === undefined ? {} : { requirements: structuredClone(operation.requirements) }),
  }];
  mutable.manifestRevision = computeRevision(mutable, "manifestRevision");
  return manifest;
}

export function createManifestWithEnvironment(
  environment: EnvironmentDescriptor,
  operation = createHappyOperation(),
): AdapterManifest {
  const manifest = createHappyManifest(operation);
  const mutable = manifest as unknown as JsonObject & {
    application: { environment: EnvironmentDescriptor };
    manifestRevision: string;
  };
  mutable.application.environment = structuredClone(environment);
  mutable.manifestRevision = computeRevision(mutable, "manifestRevision");
  return manifest;
}

export function createQueuedRun(operation = createHappyOperation()): Run {
  return {
    id: "run-1",
    operationId: operation.id,
    operationRevision: operation.revision,
    sequence: 0,
    state: "queued",
    createdAt: "2026-08-29T12:00:00Z",
    updatedAt: "2026-08-29T12:00:00Z",
    summary: { title: "Queued", tone: "neutral" },
    artifacts: [{ id: "launch-1", kind: "browser-launch", label: "Open application" }],
    actions: [{ kind: "browser-launch", label: "Open application", artifactId: "launch-1" }],
  };
}

export const happyOperation = createHappyOperation();
export const happyManifest = createHappyManifest(happyOperation);
export const validCreateRunRequest: CreateRunRequest = (() => {
  const request = structuredClone(createRunRequestDocument) as CreateRunRequest;
  const mutable = request as unknown as {
    operationRevision: string;
    confirmation: { operationRevision: string };
    context: { target: { id: string; environment: string } };
  };
  mutable.operationRevision = happyOperation.revision;
  mutable.confirmation.operationRevision = happyOperation.revision;
  mutable.context.target.id = fakeTarget.id;
  return request;
})();
export const queuedRun = createQueuedRun(happyOperation);

export interface FakeAdapterCall {
  readonly method: string;
  readonly url: string;
  readonly pathname: string;
  readonly headers: Headers;
  readonly body?: unknown;
}

export interface FakeAdapterOptions {
  readonly manifest?: AdapterManifest;
  readonly operation?: OperationDefinition;
  readonly createdRun?: Run;
  readonly polledRuns?: readonly Run[];
  readonly dataSourcePage?: DataSourcePage;
  readonly resolveResponse?: DataSourceResolveResponse;
  readonly launch?: SessionLaunchResponse;
  readonly upload?: UploadResponse;
  readonly cancelledRun?: Run;
  readonly events?: readonly RunEvent[];
  readonly responseFor?: (call: FakeAdapterCall) => Response | undefined | Promise<Response | undefined>;
}

export interface FakeAdapter {
  readonly fetch: NonNullable<AdapterClientOptions["fetch"]>;
  readonly calls: FakeAdapterCall[];
}

function json(document: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(document, {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function adapterProblem(type: `urn:gauntlet:problem:${string}`, title: string, status: number): Response {
  const document: Problem = { type, title, status };
  return Response.json(document, {
    status,
    headers: { "content-type": "application/problem+json" },
  });
}

export function createFakeAdapter(options: FakeAdapterOptions = {}): FakeAdapter {
  const manifest = options.manifest ?? happyManifest;
  const operation = options.operation ?? happyOperation;
  const createdRun = options.createdRun ?? createQueuedRun(operation);
  const polledRuns = options.polledRuns ?? [createdRun];
  const dataSourcePage = options.dataSourcePage ?? structuredClone(dataSourcePageDocument) as DataSourcePage;
  const resolveResponse = options.resolveResponse ?? structuredClone(dataSourceResolveDocument) as DataSourceResolveResponse;
  const launch = options.launch ?? {
    url: "https://app.example.test/gauntlet/session/launch-1?token=one#continue",
    expiresAt: "2026-08-29T12:10:00Z",
    singleUse: true,
  };
  const upload = options.upload ?? {
    file: {
      kind: "file",
      uploadId: "upload-1",
      name: "fixture.txt",
      mediaType: "text/plain",
      sizeBytes: 7,
      expiresAt: "2026-08-29T13:00:00Z",
    },
  };
  const cancelledRun = options.cancelledRun ?? {
    ...createdRun,
    sequence: createdRun.sequence + 1,
    state: "cancelled",
    updatedAt: "2026-08-29T12:00:02Z",
    completedAt: "2026-08-29T12:00:02Z",
    problem: {
      type: "urn:gauntlet:problem:run-cancelled",
      title: "Run cancelled",
      status: 409,
    },
  };
  const events = options.events ?? [{
    id: "event-1",
    sequence: createdRun.sequence,
    occurredAt: createdRun.updatedAt,
    type: "run.updated",
    run: createdRun,
  }];
  const calls: FakeAdapterCall[] = [];
  let pollIndex = 0;

  const fetch: FakeAdapter["fetch"] = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    let body: unknown;
    if (typeof init?.body === "string") {
      body = JSON.parse(init.body) as unknown;
    } else if (init?.body !== undefined) {
      body = init.body;
    }
    const call: FakeAdapterCall = {
      method: init?.method ?? "GET",
      url: url.href,
      pathname: url.pathname,
      headers: new Headers(init?.headers),
      ...(body === undefined ? {} : { body }),
    };
    calls.push(call);
    const custom = await options.responseFor?.(call);
    if (custom !== undefined) return custom;

    if (call.method === "GET" && call.pathname === "/_gauntlet/v1/health") {
      return json({ status: "ok", protocolVersion: "1.0" });
    }
    if (call.method === "GET" && call.pathname === "/_gauntlet/v1/manifest") {
      const etag = `"${manifest.manifestRevision}"`;
      if (call.headers.get("if-none-match") === etag) {
        return new Response(null, { status: 304, headers: { etag } });
      }
      return json(manifest, 200, { etag });
    }
    if (call.method === "GET" && call.pathname === `/_gauntlet/v1/operations/${operation.id}`) {
      return json(operation, 200, { etag: `"${operation.revision}"` });
    }
    if (call.method === "POST" && call.pathname === `/_gauntlet/v1/operations/${operation.id}/runs`) {
      const status = createdRun.state === "queued" || createdRun.state === "running" ? 202 : 201;
      return json(createdRun, status);
    }
    if (call.method === "GET" && call.pathname === `/_gauntlet/v1/runs/${createdRun.id}`) {
      const result = polledRuns[Math.min(pollIndex, polledRuns.length - 1)] ?? createdRun;
      pollIndex += 1;
      return json(result);
    }
    if (call.method === "POST" && call.pathname === "/_gauntlet/v1/data-sources/application-catalog/query") {
      return json(dataSourcePage);
    }
    if (call.method === "POST" && call.pathname === "/_gauntlet/v1/data-sources/application-catalog/resolve") {
      return json(resolveResponse);
    }
    if (call.method === "POST" && call.pathname === `/_gauntlet/v1/runs/${createdRun.id}/artifacts/launch-1/launch`) {
      return json(launch, 201);
    }
    if (call.method === "POST" && call.pathname === "/_gauntlet/v1/uploads") {
      return json(upload, 201);
    }
    if (call.method === "POST" && call.pathname === `/_gauntlet/v1/runs/${createdRun.id}/cancel`) {
      return json(cancelledRun, 202);
    }
    if (call.method === "GET" && call.pathname === `/_gauntlet/v1/runs/${createdRun.id}/events`) {
      const document = events.map((event) =>
        `id: ${event.id}\nevent: run.updated\ndata: ${JSON.stringify(event)}\n\n`).join("");
      return new Response(document, {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      });
    }
    return adapterProblem("urn:gauntlet:problem:route-not-found", "Not found", 404);
  };

  return { fetch, calls };
}

export const fakeAdapter = createFakeAdapter();
