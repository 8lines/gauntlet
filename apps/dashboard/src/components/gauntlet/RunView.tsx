import type { Run } from "@8lines/gauntlet-protocol";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { formatRelativeTime } from "../../copy.ts";
import { ArtifactView } from "./ArtifactView.tsx";
import { FollowUpList } from "./FollowUpList.tsx";
import { ProblemAlert } from "./ProblemAlert.tsx";
import { RunStateBadge } from "./RunStateBadge.tsx";

export function RunView(
  { targetId, run, onCancel, onRunAgain }:
  { targetId: string; run: Run; onCancel?: (() => void) | undefined; onRunAgain: () => void },
) {
  const active = run.state === "queued" || run.state === "running";
  const progress = run.progress;
  const determinate = progress?.total !== undefined && progress.current !== undefined && progress.total > 0;
  const startedAt = run.startedAt ?? run.createdAt;

  return (
    <div className="min-w-0 space-y-6">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <RunStateBadge state={run.state} />
          <span className="font-mono text-xs/4 text-muted-foreground">{run.id}</span>
          <time dateTime={startedAt} title={startedAt} className="text-xs/4 text-muted-foreground">
            {formatRelativeTime(startedAt)}
          </time>
        </div>
        {run.summary !== undefined && (
          <div>
            <p className="text-base/6 font-semibold">{run.summary.title}</p>
            {run.summary.message !== undefined && (
              <p className="max-w-[68ch] text-sm/5 text-muted-foreground">{run.summary.message}</p>
            )}
          </div>
        )}
      </div>

      {active && progress !== undefined && (
        <div className="space-y-2">
          <div className="flex items-baseline justify-between gap-4">
            <span className="font-mono text-xs/4 text-muted-foreground">{progress.phase ?? "in progress"}</span>
            {determinate && (
              <span className="text-xs/4 tabular-nums text-muted-foreground">{progress.current} of {progress.total}</span>
            )}
          </div>
          {determinate
            ? <Progress aria-label="Run progress" value={Math.min(100, Math.round((progress.current! / progress.total!) * 100))} />
            : <Progress aria-label="Run progress" />}
          {progress.message !== undefined && (
            <p className="text-[13px]/[18px] text-muted-foreground">{progress.message}</p>
          )}
        </div>
      )}

      {active && (
        <div className="flex flex-wrap items-center gap-2">
          {onCancel !== undefined
            ? <Button variant="outline" onClick={onCancel}>Cancel</Button>
            : (
              <p className="max-w-[68ch] text-[13px]/[18px] text-muted-foreground">
                This application does not allow cancelling an operation once it has started.
              </p>
            )}
        </div>
      )}

      {run.problem !== undefined && (
        <ProblemAlert
          problem={run.problem}
          {...(run.problem.correlationId === undefined ? {} : { correlationId: run.problem.correlationId })}
        />
      )}

      {run.artifacts.length > 0 && (
        <div className="space-y-6">
          {run.artifacts.map((artifact) => (
            <ArtifactView key={artifact.id} artifact={artifact} targetId={targetId} runId={run.id} />
          ))}
        </div>
      )}

      {run.actions.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-base/6 font-semibold">What next</h3>
          <FollowUpList targetId={targetId} runId={run.id} actions={run.actions} />
        </section>
      )}

      {!active && (
        <div>
          <Button onClick={onRunAgain}>Run again</Button>
        </div>
      )}
    </div>
  );
}
