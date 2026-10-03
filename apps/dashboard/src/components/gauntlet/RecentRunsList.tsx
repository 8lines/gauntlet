import type { MouseEvent, ReactNode } from "react";
import { formatRelativeTime } from "../../copy.ts";
import { followRoute, routePath } from "../../route.ts";
import type { RecentRun } from "../../recent-runs.ts";
import type { RecentRunEntry } from "../../recent-run-state.ts";
import { useRecentRunStates } from "../../useRecentRunStates.ts";
import { RunStateBadge } from "./RunStateBadge.tsx";

const TARGET = "flex min-w-0 flex-1 flex-col gap-1 rounded-sm py-3 text-left outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

type RowAction =
  | { readonly href: string; readonly onClick: (event: MouseEvent<HTMLAnchorElement>) => void }
  | { readonly onOpen: () => void };

/**
 * One remembered run: label, its state and when it started. The dashboard row links to the run's
 * URL; the panel row opens the run inside the panel, and may carry a `trailing` link of its own.
 */
export function RecentRunRow({ entry, state, action, trailing }: {
  entry: RecentRun;
  state: RecentRunEntry | undefined;
  action: RowAction;
  trailing?: ReactNode;
}) {
  const content = (
    <>
      <span className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 text-sm/5 font-medium break-words">{entry.label}</span>
        {state?.run !== undefined && <RunStateBadge state={state.run.state} />}
        {state?.missing === true && <span className="shrink-0 text-[13px]/[18px] text-muted-foreground">No longer available</span>}
      </span>
      <span className="text-[13px]/[18px] text-muted-foreground">Started {formatRelativeTime(entry.startedAt)}</span>
    </>
  );
  return (
    <li className="flex items-start gap-3">
      {"href" in action
        ? <a href={action.href} onClick={action.onClick} className={TARGET}>{content}</a>
        : <button type="button" onClick={action.onOpen} className={TARGET}>{content}</button>}
      {trailing}
    </li>
  );
}

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
        return (
          <RecentRunRow
            key={`${entry.targetId}/${entry.runId}`}
            entry={entry}
            state={states.get(entry.runId)}
            action={{ href: routePath(route), onClick: (event) => followRoute(event, route) }}
          />
        );
      })}
    </ul>
  );
}
