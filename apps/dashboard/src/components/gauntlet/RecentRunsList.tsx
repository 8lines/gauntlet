import type { Run } from "@8lines/gauntlet-protocol";
import { formatRelativeTime } from "../../copy.ts";
import { followRoute, routePath } from "../../route.ts";
import type { RecentRun } from "../../recent-runs.ts";
import { useRecentRunStates } from "../../useRecentRunStates.ts";
import { RunStateBadge } from "./RunStateBadge.tsx";

const LINK = "flex flex-col gap-1 rounded-sm py-3 outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/** Runs started in this browser for one environment, newest first, each linking to its run URL. */
export function RecentRunsList({ targetId, entries }: { targetId: string; entries: readonly RecentRun[] }) {
  const states = useRecentRunStates(entries);
  if (entries.length === 0) {
    return <p className="max-w-[68ch] text-sm/5 text-muted-foreground">Runs you start in this browser appear here.</p>;
  }
  return (
    <ul className="flex flex-col divide-y border-y">
      {entries.map((entry) => {
        const route = { targetId, operationId: entry.operationId, runId: entry.runId };
        const state: { run?: Run; missing: boolean } | undefined = states.get(entry.runId);
        return (
          <li key={`${entry.targetId}/${entry.runId}`}>
            <a href={routePath(route)} onClick={(event) => followRoute(event, route)} className={LINK}>
              <span className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 text-sm/5 font-medium break-words">{entry.label}</span>
                {state?.run !== undefined && <RunStateBadge state={state.run.state} />}
                {state?.missing === true && <span className="shrink-0 text-[13px]/[18px] text-muted-foreground">No longer available</span>}
              </span>
              <span className="text-[13px]/[18px] text-muted-foreground">Started {formatRelativeTime(entry.startedAt)}</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}
