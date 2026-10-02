import { useEffect } from "react";
import { EmptyState } from "../components/gauntlet/EmptyState.tsx";
import { ProblemAlert } from "../components/gauntlet/ProblemAlert.tsx";
import { RunView } from "../components/gauntlet/RunView.tsx";
import type { RecentRun } from "../recent-runs.ts";
import { useRun } from "../useRun.ts";

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
  const { run, missing, problem } = useRun(entry.targetId, entry.runId);
  const shown = run !== undefined;
  useEffect(() => { onResultShown(shown); }, [shown, onResultShown]);

  return (
    <div className="space-y-4 p-4">
      <div>
        <p className="page-eyebrow">Run</p>
        <h1 className="mt-1 wrap-anywhere text-xl/7 font-semibold">{entry.label}</h1>
      </div>
      {run === undefined && !missing && problem === undefined && (
        <p className="text-sm/5 text-muted-foreground">Loading run…</p>
      )}
      {run !== undefined && <RunView targetId={entry.targetId} run={run} onRunAgain={onRunAgain} />}
      {missing && (
        <EmptyState
          title="This run is no longer available"
          description="Gauntlet keeps run results in memory, so they are gone after a restart."
        />
      )}
      {problem !== undefined && <ProblemAlert problem={problem} />}
    </div>
  );
}
