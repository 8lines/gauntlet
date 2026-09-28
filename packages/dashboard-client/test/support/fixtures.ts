import type {
  AdapterHealth,
  AdapterManifest,
  CreateRunRequest,
  DataSourcePage,
  DataSourceQuery,
  DataSourceResolveRequest,
  DataSourceResolveResponse,
  OperationDefinition,
  Problem,
  Run,
  RunEvent,
  SessionLaunchResponse,
  UploadResponse,
} from "@8lines/gauntlet-protocol";
import healthDocument from "@8lines/gauntlet-protocol/fixtures/v1/health.valid.json" with { type: "json" };
import manifestValidDocument from "@8lines/gauntlet-protocol/fixtures/v1/manifest.valid.json" with { type: "json" };
import manifestDocument from "@8lines/gauntlet-protocol/fixtures/v1/manifest.minor-forward.valid.json" with { type: "json" };
import operationDocument from "@8lines/gauntlet-protocol/fixtures/v1/operation.valid.json" with { type: "json" };
import createRunRequestDocument from "@8lines/gauntlet-protocol/fixtures/v1/create-run-request.valid.json" with { type: "json" };
import runDocument from "@8lines/gauntlet-protocol/fixtures/v1/run.queued.valid.json" with { type: "json" };
import dataSourceQueryDocument from "@8lines/gauntlet-protocol/fixtures/v1/data-source-query.valid.json" with { type: "json" };
import dataSourcePageDocument from "@8lines/gauntlet-protocol/fixtures/v1/data-source-page.valid.json" with { type: "json" };
import resolveRequestDocument from "@8lines/gauntlet-protocol/fixtures/v1/data-source-resolve-request.valid.json" with { type: "json" };
import resolveResponseDocument from "@8lines/gauntlet-protocol/fixtures/v1/data-source-resolve-response.valid.json" with { type: "json" };
import problemDocument from "@8lines/gauntlet-protocol/fixtures/v1/problem.valid.json" with { type: "json" };
import sessionLaunchDocument from "@8lines/gauntlet-protocol/fixtures/v1/session-launch.valid.json" with { type: "json" };
import runEventDocument from "@8lines/gauntlet-protocol/fixtures/v1/run-event.valid.json" with { type: "json" };
import uploadDocument from "@8lines/gauntlet-protocol/fixtures/v1/upload-response.valid.json" with { type: "json" };

import type { AdapterTarget } from "../../src/index.js";

export const target: AdapterTarget = {
  id: "fixture-adapter",
  adapterUrl: "http://adapter.internal",
};

export const validHealth = healthDocument as AdapterHealth;
export const validManifest = manifestValidDocument as unknown as AdapterManifest;
export const validMinorForwardManifest = manifestDocument as unknown as AdapterManifest;
export const validOperation = operationDocument as unknown as OperationDefinition;
export const validCreateRunRequest = createRunRequestDocument as unknown as CreateRunRequest;
export const validRun = runDocument as unknown as Run;
export const validDataSourceQuery = dataSourceQueryDocument as unknown as DataSourceQuery;
export const validDataSourcePage = dataSourcePageDocument as unknown as DataSourcePage;
export const validResolveRequest = resolveRequestDocument as unknown as DataSourceResolveRequest;
export const validResolveResponse = resolveResponseDocument as unknown as DataSourceResolveResponse;
export const validProblem = problemDocument as unknown as Problem;
export const validSessionLaunch = sessionLaunchDocument as SessionLaunchResponse;
export const validRunEvent = runEventDocument as unknown as RunEvent;
export const validUpload = uploadDocument as unknown as UploadResponse;

export function jsonResponse(value: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  if (!responseHeaders.has("content-type")) {
    responseHeaders.set("content-type", "application/json");
  }
  return new Response(JSON.stringify(value), { status, headers: responseHeaders });
}

export function problemResponse(problem: Problem): Response {
  return jsonResponse(problem, problem.status, { "content-type": "application/problem+json" });
}
