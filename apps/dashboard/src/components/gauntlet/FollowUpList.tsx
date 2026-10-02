import type { FollowUpAction } from "@8lines/gauntlet-protocol";
import { Button } from "@/components/ui/button";
import { executeFollowUp } from "../../run-actions.ts";
import { LaunchButton } from "./LaunchButton.tsx";

function describe(action: FollowUpAction): string {
  if (action.kind === "open-link") return action.url;
  if (action.kind === "browser-launch") return "Opens the application in a new tab";
  return "Opens the next operation with the form filled in";
}

export function FollowUpList(
  { targetId, runId, actions }: { targetId: string; runId: string; actions: readonly FollowUpAction[] },
) {
  return (
    <ul className="divide-y border-y">
      {actions.map((action, i) => (
        <li key={i} className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm/5">{action.label}</p>
            <p className="truncate text-[13px]/[18px] text-muted-foreground">{describe(action)}</p>
          </div>
          {action.kind === "invoke-operation" && (
            <Button variant="outline" size="sm" onClick={() => executeFollowUp(action, targetId)}>Open</Button>
          )}
          {action.kind === "open-link" && (
            <a
              href={action.url}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex min-h-11 shrink-0 items-center text-sm/5 font-medium text-focus underline-offset-4 hover:underline sm:min-h-0"
            >Open ↗</a>
          )}
          {action.kind === "browser-launch" && (
            <LaunchButton targetId={targetId} runId={runId} artifactId={action.artifactId} />
          )}
        </li>
      ))}
    </ul>
  );
}
