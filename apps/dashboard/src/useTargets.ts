import { useCallback, useEffect, useRef, useState } from "react";
import type { Problem } from "@8lines/gauntlet-protocol";
import { api, type TargetSnapshot } from "./api.ts";

interface TargetsState {
  readonly targets?: readonly TargetSnapshot[];
  readonly problem?: Problem;
}

/** Loads the environments once on mount; `refresh` reloads them and reports `refreshing` while in flight. */
export function useTargets(): TargetsState & { readonly refreshing: boolean; refresh(): void } {
  const [state, setState] = useState<TargetsState>({});
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    const result = await api.targets();
    if (!mounted.current) return;
    setState(result.ok ? { targets: result.data } : { problem: result.problem });
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
    void load().finally(() => {
      if (mounted.current) setRefreshing(false);
    });
  }, [load]);

  return { ...state, refreshing, refresh };
}
