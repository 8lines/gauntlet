import type { Problem } from "@8lines/gauntlet-protocol";
import type { Result, TargetSnapshot } from "./api.ts";

export interface TargetsState {
  readonly targets?: readonly TargetSnapshot[];
  readonly problem?: Problem;
}

/**
 * A successful load replaces everything. A failed load keeps the last known environments
 * (a transient error must not blank the app) and reports the problem next to them.
 */
export function applyTargetsResult(state: TargetsState, result: Result<readonly TargetSnapshot[]>): TargetsState {
  if (result.ok) return { targets: result.data };
  return state.targets === undefined ? { problem: result.problem } : { targets: state.targets, problem: result.problem };
}

export interface LatestGate {
  /** Starts a request; every earlier token stops being the latest. */
  begin(): number;
  isLatest(token: number): boolean;
}

/** Lets only the most recently started request apply its result, so a slow older response is ignored. */
export function createLatestGate(): LatestGate {
  let latest = 0;
  return {
    begin: () => ++latest,
    isLatest: (token) => token === latest,
  };
}
