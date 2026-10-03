import { useEffect, useState } from "react";
import type { Problem, Run } from "@8lines/gauntlet-protocol";
import { api, isRunFinished } from "./api.ts";

interface RunState {
  readonly runId?: string;
  readonly run?: Run;
  readonly missing: boolean;
  readonly problem?: Problem;
}

const IDLE: RunState = { missing: false };

/** Loads a run and keeps polling it every 1.5 s until it reaches a terminal state. `missing` is true on 404. */
export function useRun(targetId: string, runId: string | undefined): Omit<RunState, "runId"> {
  const [state, setState] = useState<RunState>(IDLE);
  useEffect(() => {
    setState(IDLE);
    if (runId === undefined) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const result = await api.run(targetId, runId);
      if (!active) return;
      if (!result.ok) {
        setState(result.problem.status === 404 ? { runId, missing: true } : { runId, missing: false, problem: result.problem });
        return;
      }
      setState({ runId, run: result.data, missing: false });
      if (!isRunFinished(result.data)) timer = setTimeout(() => void load(), 1500);
    };
    void load();
    return () => { active = false; if (timer !== undefined) clearTimeout(timer); };
  }, [targetId, runId]);
  // Until the effect resets it, the state may still describe the previous run id; never report that one.
  return state.runId === runId ? state : IDLE;
}
