import type {
  AdapterRunEventStream,
  ClientResult,
} from "@8lines/gauntlet-dashboard-client";
import {
  isProtocolId,
  type Problem,
  type RunEvent,
} from "@8lines/gauntlet-protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Readable } from "node:stream";
import type { DataSourceService } from "./data-source-service.js";
import type { ManifestService } from "./manifest-service.js";
import {
  INVALID_PATH_PROBLEM,
  INVALID_REQUEST_PROBLEM,
  PAYLOAD_TOO_LARGE_PROBLEM,
  sendProblem,
} from "./problem-response.js";
import { principalActor, requestPrincipal } from "./auth/principal.js";
import type { RunProxyService } from "./run-proxy-service.js";

export interface RouteDependencies {
  readonly dataSources: DataSourceService;
  readonly manifests: ManifestService;
  readonly runs: RunProxyService;
  readonly maxUploadBytes: number;
}

/** The named path parameters when every one is a protocol id, otherwise undefined. */
export function pathIds(request: FastifyRequest, keys: readonly string[]): readonly string[] | undefined {
  if (request.params === null || typeof request.params !== "object" || Array.isArray(request.params)) {
    return undefined;
  }
  const params = request.params as Readonly<Record<string, unknown>>;
  const values = keys.map((key) => params[key]);
  return values.every(isProtocolId) ? values as readonly string[] : undefined;
}

function sendResult<T>(reply: FastifyReply, result: ClientResult<T>, status = 200): FastifyReply {
  return result.ok ? reply.code(status).send(result.value) : sendProblem(reply, result.problem);
}

type UploadBodyResult =
  | { readonly ok: true; readonly file: Blob; readonly name: string }
  | { readonly ok: false; readonly problem: Problem };

async function uploadBody(request: FastifyRequest, maxUploadBytes: number): Promise<UploadBodyResult> {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !Buffer.isBuffer(request.body)) {
    return { ok: false, problem: INVALID_REQUEST_PROBLEM };
  }
  try {
    const encoded = new Request("http://gauntlet.invalid", {
      method: "POST",
      headers: { "content-type": contentType },
      body: new Uint8Array(request.body),
    });
    const form = await encoded.formData();
    const entries = [...form.entries()];
    if (entries.length !== 1 || entries[0]![0] !== "file") {
      return { ok: false, problem: INVALID_REQUEST_PROBLEM };
    }
    const file = entries[0]![1];
    if (typeof file === "string" || !(file instanceof Blob)) {
      return { ok: false, problem: INVALID_REQUEST_PROBLEM };
    }
    const name = (file as Blob & { readonly name?: unknown }).name;
    if (typeof name !== "string") return { ok: false, problem: INVALID_REQUEST_PROBLEM };
    if (file.size > maxUploadBytes) return { ok: false, problem: PAYLOAD_TOO_LARGE_PROBLEM };
    return { ok: true, file, name };
  } catch {
    return { ok: false, problem: INVALID_REQUEST_PROBLEM };
  }
}

function eventFrame(event: RunEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function registerRoutes(app: FastifyInstance, dependencies: RouteDependencies): void {
  app.get("/health", async (_request, reply) => reply.code(200).send({ status: "ok" }));
  app.get("/ready", async (_request, reply) => reply.code(200).send({ status: "ready" }));

  app.get("/api/v1/targets", async (_request, reply) => {
    const targets = await dependencies.manifests.listTargets();
    return reply.code(200).send({ targets });
  });

  app.get("/api/v1/targets/:targetId/operations/:operationId", async (request, reply) => {
    const ids = pathIds(request, ["targetId", "operationId"]);
    if (ids === undefined) return sendProblem(reply, INVALID_PATH_PROBLEM);
    const [targetId, operationId] = ids as readonly [string, string];
    const result = await dependencies.runs.resolveOperation(targetId, operationId);
    return result.ok ? reply.code(200).send(result.definition) : sendProblem(reply, result.problem);
  });

  app.post("/api/v1/targets/:targetId/operations/:operationId/runs", async (request, reply) => {
    const ids = pathIds(request, ["targetId", "operationId"]);
    if (ids === undefined) return sendProblem(reply, INVALID_PATH_PROBLEM);
    const [targetId, operationId] = ids as readonly [string, string];
    const result = await dependencies.runs.create(targetId, operationId, request.body, principalActor(requestPrincipal(request)));
    if (!result.ok) return sendProblem(reply, result.problem);
    const status = result.value.state === "queued" || result.value.state === "running" ? 202 : 201;
    return reply.code(status).send(result.value);
  });

  app.get("/api/v1/targets/:targetId/runs/:runId", async (request, reply) => {
    const ids = pathIds(request, ["targetId", "runId"]);
    if (ids === undefined) return sendProblem(reply, INVALID_PATH_PROBLEM);
    const [targetId, runId] = ids as readonly [string, string];
    return sendResult(reply, await dependencies.runs.get(targetId, runId));
  });

  app.post("/api/v1/targets/:targetId/uploads", async (request, reply) => {
    const ids = pathIds(request, ["targetId"]);
    if (ids === undefined) return sendProblem(reply, INVALID_PATH_PROBLEM);
    const body = await uploadBody(request, dependencies.maxUploadBytes);
    if (!body.ok) return sendProblem(reply, body.problem);
    return sendResult(reply, await dependencies.runs.createUpload(ids[0]!, body.file, body.name), 201);
  });

  app.post("/api/v1/targets/:targetId/runs/:runId/cancel", async (request, reply) => {
    const ids = pathIds(request, ["targetId", "runId"]);
    if (ids === undefined) return sendProblem(reply, INVALID_PATH_PROBLEM);
    const [targetId, runId] = ids as readonly [string, string];
    return sendResult(reply, await dependencies.runs.cancel(targetId, runId), 202);
  });

  app.get("/api/v1/targets/:targetId/runs/:runId/events", async (request, reply) => {
    const ids = pathIds(request, ["targetId", "runId"]);
    if (ids === undefined) return sendProblem(reply, INVALID_PATH_PROBLEM);
    const cursor = request.headers["last-event-id"];
    if (Array.isArray(cursor)
      || (cursor !== undefined && (typeof cursor !== "string" || !isProtocolId(cursor)))) {
      return sendProblem(reply, INVALID_PATH_PROBLEM);
    }
    const [targetId, runId] = ids as readonly [string, string];
    let disconnected = reply.raw.destroyed;
    let source: AdapterRunEventStream | undefined;
    const close = (): void => {
      disconnected = true;
      if (source !== undefined) void source.cancel();
    };
    reply.raw.once("close", close);
    let result: Awaited<ReturnType<RunProxyService["streamEvents"]>>;
    try {
      result = await dependencies.runs.streamEvents(targetId, runId, cursor);
    } catch (error) {
      reply.raw.off("close", close);
      if (disconnected) return reply;
      throw error;
    }
    if (!result.ok) {
      reply.raw.off("close", close);
      return disconnected ? reply : sendProblem(reply, result.problem);
    }
    source = result.value;
    if (disconnected || reply.raw.destroyed) {
      reply.raw.off("close", close);
      await source.cancel();
      return reply;
    }
    const body = Readable.from((async function* (): AsyncGenerator<string> {
      try {
        for await (const event of source) yield eventFrame(event);
      } catch {
        // Headers may already be committed. End the public stream without exposing upstream details.
      } finally {
        reply.raw.off("close", close);
        await source.cancel();
      }
    })());
    return reply
      .code(200)
      .type("text/event-stream; charset=utf-8")
      .header("cache-control", "no-cache, no-store")
      .header("x-accel-buffering", "no")
      .send(body);
  });

  app.post("/api/v1/targets/:targetId/data-sources/:dataSourceId/query", async (request, reply) => {
    const ids = pathIds(request, ["targetId", "dataSourceId"]);
    if (ids === undefined) return sendProblem(reply, INVALID_PATH_PROBLEM);
    return sendResult(reply, await dependencies.dataSources.query(ids[0]!, ids[1]!, request.body));
  });

  app.post("/api/v1/targets/:targetId/data-sources/:dataSourceId/resolve", async (request, reply) => {
    const ids = pathIds(request, ["targetId", "dataSourceId"]);
    if (ids === undefined) return sendProblem(reply, INVALID_PATH_PROBLEM);
    return sendResult(reply, await dependencies.dataSources.resolve(ids[0]!, ids[1]!, request.body));
  });

  app.post("/api/v1/targets/:targetId/runs/:runId/artifacts/:artifactId/launch", async (request, reply) => {
    const ids = pathIds(request, ["targetId", "runId", "artifactId"]);
    if (ids === undefined) return sendProblem(reply, INVALID_PATH_PROBLEM);
    const [targetId, runId, artifactId] = ids as readonly [string, string, string];
    return sendResult(reply, await dependencies.runs.createSessionLaunch(targetId, runId, artifactId));
  });
}
