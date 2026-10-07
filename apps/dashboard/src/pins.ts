import { request, type Result } from "./api.ts";

/** One pinned operation, as `GET /api/v1/targets/:targetId/pins` returns it (oldest first). */
export interface Pin {
  readonly operationId: string;
  readonly pinnedAt: string;
}

function pinsPath(targetId: string): string {
  return `/api/v1/targets/${encodeURIComponent(targetId)}/pins`;
}

function pinPath(targetId: string, operationId: string): string {
  return `${pinsPath(targetId)}/${encodeURIComponent(operationId)}`;
}

export async function listPins(targetId: string): Promise<Result<readonly Pin[]>> {
  const result = await request<{ readonly pins: readonly Pin[] }>(pinsPath(targetId));
  return result.ok ? { ok: true, data: result.data.pins } : result;
}

/** Idempotent: pinning a pinned operation keeps its place. */
export function pin(targetId: string, operationId: string): Promise<Result<undefined>> {
  return request(pinPath(targetId, operationId), { method: "PUT" });
}

/** Idempotent: unpinning an operation that is not pinned does nothing. */
export function unpin(targetId: string, operationId: string): Promise<Result<undefined>> {
  return request(pinPath(targetId, operationId), { method: "DELETE" });
}
