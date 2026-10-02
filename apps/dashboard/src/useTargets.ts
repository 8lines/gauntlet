import { useCallback, useEffect, useRef, useState } from "react";
import type { Problem } from "@8lines/gauntlet-protocol";
import { api, type Result, type TargetSnapshot } from "./api.ts";

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

/**
 * Loads the environments once on mount; `refresh` reloads them and reports `refreshing` while in flight.
 * Only the most recently started request is applied, so a slow older response cannot overwrite a newer one.
 */
export function useTargets(): TargetsState & { readonly refreshing: boolean; refresh(): void } {
  const [state, setState] = useState<TargetsState>({});
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(true);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const sequence = ++latest.current;
    const result = await api.targets();
    if (!mounted.current || sequence !== latest.current) return false;
    setState((current) => applyTargetsResult(current, result));
    return true;
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    void load().then((applied) => {
      if (applied && mounted.current) setRefreshing(false);
    });
  }, [load]);

  return { ...state, refreshing, refresh };
}
