import type { Run } from "@8lines/gauntlet-protocol";
import { isRunFinished, type Result } from "./api.ts";

export interface RecentRunEntry {
  readonly run?: Run;
  readonly missing: boolean;
}

/**
 * What a recent run's list entry shows after one load, and whether to load it again in a while.
 * Only a 404 means the run is gone; any other failure keeps what was last known and keeps trying.
 */
export function nextRecentRunState(
  previous: RecentRunEntry | undefined,
  result: Result<Run>,
): { readonly entry: RecentRunEntry; readonly keepPolling: boolean } {
  if (result.ok) return { entry: { run: result.data, missing: false }, keepPolling: !isRunFinished(result.data) };
  if (result.problem.status === 404) return { entry: { missing: true }, keepPolling: false };
  return {
    entry: previous?.run === undefined ? { missing: false } : { run: previous.run, missing: false },
    keepPolling: true,
  };
}
