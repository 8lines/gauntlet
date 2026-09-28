import type {
  AdapterManifest,
  CreateRunRequest,
  OperationDefinition,
  Problem,
  DataSourcePage,
  Run,
  SessionLaunchResponse,
  TargetState,
  UploadResponse,
} from "@8lines/gauntlet-protocol";

/** Shape returned by `GET /api/v1/targets` (see apps/server/src/manifest-service.ts). */
export interface TargetSnapshot {
  readonly id: string;
  readonly label: string;
  readonly tags: readonly string[];
  readonly state: TargetState;
  readonly manifest?: AdapterManifest;
  readonly problem?: Problem;
  readonly refreshedAt: string;
}

export type Result<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly problem: Problem };

const NETWORK_PROBLEM: Problem = Object.freeze({
  type: "urn:gauntlet:problem:network-unreachable",
  title: "Could not connect to Gauntlet",
  status: 0,
  detail: "Check that the control plane is running and that you are on its network.",
});

function problemFromResponse(status: number, body: unknown): Problem {
  if (typeof body === "object" && body !== null && "title" in body && "type" in body) {
    return body as Problem;
  }
  return Object.freeze({
    type: "urn:gauntlet:problem:unexpected-response",
    title: "Unexpected server response",
    status,
  });
}

async function request<T>(path: string, init?: RequestInit): Promise<Result<T>> {
  let response: Response;
  try {
    const headers = new Headers(init?.headers);
    headers.set("accept", "application/json");
    if (typeof init?.body === "string" && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    response = await fetch(path, {
      ...init,
      headers,
    });
  } catch {
    return { ok: false, problem: NETWORK_PROBLEM };
  }

  let body: unknown;
  try {
    const text = await response.text();
    body = text.length === 0 ? undefined : JSON.parse(text);
  } catch {
    return { ok: false, problem: problemFromResponse(response.status, undefined) };
  }

  if (!response.ok) return { ok: false, problem: problemFromResponse(response.status, body) };
  return { ok: true, data: body as T };
}

export const api = {
  targets: async (): Promise<Result<readonly TargetSnapshot[]>> => {
    const result = await request<{ readonly targets: readonly TargetSnapshot[] }>("/api/v1/targets");
    return result.ok ? { ok: true, data: result.data.targets } : result;
  },

  operation: (targetId: string, operationId: string): Promise<Result<OperationDefinition>> =>
    request(`/api/v1/targets/${encodeURIComponent(targetId)}/operations/${encodeURIComponent(operationId)}`),

  createRun: (
    targetId: string,
    operationId: string,
    runRequest: {
      readonly operationRevision: CreateRunRequest["operationRevision"];
      readonly input: Record<string, unknown>;
      readonly context: Record<string, unknown>;
      readonly dryRun: boolean;
      readonly idempotencyKey?: string;
      readonly confirmation?: CreateRunRequest["confirmation"];
    },
  ): Promise<Result<Run>> =>
    request(
      `/api/v1/targets/${encodeURIComponent(targetId)}/operations/${encodeURIComponent(operationId)}/runs`,
      { method: "POST", body: JSON.stringify(runRequest) },
    ),

  run: (targetId: string, runId: string): Promise<Result<Run>> =>
    request(`/api/v1/targets/${encodeURIComponent(targetId)}/runs/${encodeURIComponent(runId)}`),


  queryDataSource: (
    targetId: string,
    dataSourceId: string,
    query: { readonly search?: string; readonly limit?: number; readonly dependencies?: Record<string, unknown>; readonly context: Record<string, unknown> },
  ): Promise<Result<DataSourcePage>> =>
    request(
      `/api/v1/targets/${encodeURIComponent(targetId)}/data-sources/${encodeURIComponent(dataSourceId)}/query`,
      { method: "POST", body: JSON.stringify(query) },
    ),

  cancelRun: (targetId: string, runId: string): Promise<Result<Run>> =>
    request(`/api/v1/targets/${encodeURIComponent(targetId)}/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" }),

  uploadFile: (targetId: string, file: File): Promise<Result<UploadResponse>> => {
    const form = new FormData();
    form.append("file", file, file.name);
    return request(`/api/v1/targets/${encodeURIComponent(targetId)}/uploads`, {
      method: "POST",
      body: form,
    });
  },

  launchArtifact: (
    targetId: string,
    runId: string,
    artifactId: string,
  ): Promise<Result<SessionLaunchResponse>> =>
    request(
      `/api/v1/targets/${encodeURIComponent(targetId)}/runs/${encodeURIComponent(runId)}`
        + `/artifacts/${encodeURIComponent(artifactId)}/launch`,
      { method: "POST" },
    ),
};

/** A run state after which there is nothing left to poll. */
export function isRunFinished(run: Run): boolean {
  return run.state !== "queued" && run.state !== "running";
}
