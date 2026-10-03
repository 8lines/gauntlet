import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import { applyTargetsResult, createLatestGate, type TargetsState } from "./targets-state.ts";

/**
 * Loads the environments once on mount; `refresh` reloads them and reports `refreshing` while in flight.
 * Only the most recently started request is applied, so a slow older response cannot overwrite a newer one.
 */
export function useTargets(): TargetsState & { readonly refreshing: boolean; refresh(): void } {
  const [state, setState] = useState<TargetsState>({});
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(true);
  const gate = useRef(createLatestGate());

  const load = useCallback(async () => {
    const token = gate.current.begin();
    const result = await api.targets();
    if (!mounted.current || !gate.current.isLatest(token)) return false;
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
