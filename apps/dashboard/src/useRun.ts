import { useEffect, useState } from "react";
import type { Problem, Run } from "@8lines/gauntlet-protocol";
import { api, isRunFinished } from "./api.ts";

/** Loads a run and keeps polling it every 1.5 s until it reaches a terminal state. `missing` is true on 404. */
export function useRun(targetId: string, runId: string | undefined) {
  const [state, setState] = useState<{ run?: Run; missing: boolean; problem?: Problem }>({ missing: false });
  useEffect(() => {
    setState({ missing: false });
    if (runId === undefined) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const result = await api.run(targetId, runId);
      if (!active) return;
      if (!result.ok) {
        setState(result.problem.status === 404 ? { missing: true } : { missing: false, problem: result.problem });
        return;
      }
      setState({ run: result.data, missing: false });
      if (!isRunFinished(result.data)) timer = setTimeout(() => void load(), 1500);
    };
    void load();
    return () => { active = false; if (timer !== undefined) clearTimeout(timer); };
  }, [targetId, runId]);
  return state;
}
