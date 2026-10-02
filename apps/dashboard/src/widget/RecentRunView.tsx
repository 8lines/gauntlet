import { useEffect, useState } from "react";
import type { Problem, Run } from "@8lines/gauntlet-protocol";
import { api, isRunFinished } from "../api.ts";
import { RunDetails } from "../RunDetails.tsx";
import { Card } from "../ui.tsx";
import { describeProblem } from "../copy.ts";
import type { RecentRun } from "../recent-runs.ts";

type Loaded =
  | { readonly kind: "loading" }
  | { readonly kind: "run"; readonly run: Run }
  | { readonly kind: "gone" }
  | { readonly kind: "problem"; readonly problem: Problem };

/**
 * A run from the "Recent runs" list. Run projections live in the Gauntlet process's memory, so
 * after a restart `GET …/runs/{id}` answers 404 and the entry says so instead of failing.
 */
export function RecentRunView({ entry, onRunAgain, onResultShown }: {
  entry: RecentRun;
  onRunAgain: () => void;
  /** `true` only while a run result is on screen (not while loading, on 404 or on a problem). */
  onResultShown: (shown: boolean) => void;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const shown = loaded.kind === "run";
  useEffect(() => { onResultShown(shown); }, [shown, onResultShown]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const result = await api.run(entry.targetId, entry.runId);
      if (!active) return;
      if (result.ok) {
        setLoaded({ kind: "run", run: result.data });
        if (!isRunFinished(result.data)) timer = setTimeout(() => void load(), 1500);
        return;
      }
      setLoaded(result.problem.status === 404 ? { kind: "gone" } : { kind: "problem", problem: result.problem });
    };
    setLoaded({ kind: "loading" });
    void load();
    return () => { active = false; clearTimeout(timer); };
  }, [entry.targetId, entry.runId]);

  return (
    <div className="space-y-4 p-4">
      <div>
        <p className="page-eyebrow">Run</p>
        <h1 className="mt-1 wrap-anywhere text-[17px] font-semibold tracking-tight">{entry.label}</h1>
      </div>
      {loaded.kind === "loading" && <p className="text-[13px] text-muted-foreground">Loading run…</p>}
      {loaded.kind === "run" && <RunDetails targetId={entry.targetId} run={loaded.run} onRetry={onRunAgain} />}
      {loaded.kind === "gone" && (
        <Card>
          <p className="p-5 text-[13px] font-medium text-muted-foreground">Unavailable after a Gauntlet restart</p>
        </Card>
      )}
      {loaded.kind === "problem" && (
        <Card>
          <div className="p-5">
            <p className="text-[13px] font-medium text-stop">{describeProblem(loaded.problem).title}</p>
            <p className="mt-1 text-[13px] text-muted-foreground">{describeProblem(loaded.problem).advice}</p>
          </div>
        </Card>
      )}
    </div>
  );
}
