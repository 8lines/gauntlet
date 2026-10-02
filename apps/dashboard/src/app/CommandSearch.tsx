import { useEffect, useMemo } from "react";
import type { TargetSnapshot } from "../api.ts";
import { browserStorage } from "../browser-storage.ts";
import { formatRelativeTime } from "../copy.ts";
import { readRecentRuns } from "../recent-runs.ts";
import { navigate, useRoute, type Route } from "../route.ts";
import { useReturnFocus } from "./useReturnFocus.ts";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";

const MAX_RECENT_RUNS_SHOWN = 5;
// Long labels wrap; on a narrow dialog the detail goes under the label instead of squeezing it.
const ITEM = "flex-col items-start gap-0.5 text-sm/5 sm:flex-row sm:items-baseline sm:gap-2";
const LABEL = "min-w-0 wrap-anywhere";
const DETAIL = "text-[13px]/[18px] wrap-anywhere text-muted-foreground sm:ml-auto sm:max-w-[40%] sm:text-right";

export function CommandSearch({ targets, open, onOpenChange }: {
  targets: readonly TargetSnapshot[] | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const route = useRoute();
  const returnFocus = useReturnFocus();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return;
      // Another modal dialog (settings, a confirmation, the mobile navigation) keeps its focus.
      const own = document.querySelector("[cmdk-root]")?.closest('[role="dialog"]');
      const other = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')]
        .some((dialog) => dialog !== own);
      if (other) return;
      event.preventDefault();
      onOpenChange(!open);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  // Read when the dialog opens, so a run started since the last time is listed.
  const recentRuns = useMemo(
    () => open && route.targetId !== undefined
      ? readRecentRuns(browserStorage)
        .filter((run) => run.targetId === route.targetId)
        .slice(0, MAX_RECENT_RUNS_SHOWN)
      : [],
    [open, route.targetId],
  );

  const operations = (targets ?? []).flatMap((target) =>
    (target.manifest?.operations ?? []).map((operation) => ({ target, operation })),
  );

  const select = (destination: Route) => {
    onOpenChange(false);
    navigate(destination);
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search operations"
      description="Search environments, operations and recent runs"
      showCloseButton={false}
      contentProps={returnFocus}
      className="top-[38%] gap-0 sm:max-w-xl"
    >
      <CommandInput
        placeholder="Search environments and operations"
        aria-label="Search environments and operations"
        className="text-sm/5"
      />
      {/* The dialog is centred at 38% of the viewport, so it has to stay under 76% of its height. */}
      <CommandList className="max-h-[min(400px,calc(76dvh-6rem))]">
        <CommandEmpty className="py-6 text-center text-sm/5">No matching results</CommandEmpty>
        {targets !== undefined && targets.length > 0 && (
          <CommandGroup heading="Environments">
            {targets.map((target) => (
              <CommandItem
                key={target.id}
                value={target.label}
                className={ITEM}
                onSelect={() => select({ targetId: target.id })}
              >
                <span className={LABEL}>{target.label}</span>
                <span className={DETAIL}>Environment overview</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {operations.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Operations">
              {operations.map(({ target, operation }) => {
                const unavailable = operation.availability.state !== "available";
                return (
                  <CommandItem
                    key={`${target.id}:${operation.id}`}
                    value={`${operation.label} ${target.label}`}
                    keywords={[operation.id]}
                    disabled={unavailable}
                    className={ITEM}
                    onSelect={() => select({ targetId: target.id, operationId: operation.id })}
                  >
                    <span className={LABEL}>{operation.label}</span>
                    <span className={DETAIL}>
                      {unavailable ? `${target.label} · unavailable` : target.label}
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </>
        )}
        {recentRuns.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Recent runs">
              {recentRuns.map((run) => (
                <CommandItem
                  key={run.runId}
                  value={`${run.label} ${run.runId}`}
                  className={ITEM}
                  onSelect={() => select({ targetId: run.targetId, operationId: run.operationId, runId: run.runId })}
                >
                  <span className={LABEL}>{run.label}</span>
                  <span className={DETAIL}>
                    {formatRelativeTime(run.startedAt)}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
      <p className="border-t px-3 py-2 text-xs/4 text-muted-foreground">↑ ↓ select, ↵ open, Esc close</p>
    </CommandDialog>
  );
}
