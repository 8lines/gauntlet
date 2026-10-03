import { useMemo, useState } from "react";
import type { OperationSummary, Problem } from "@8lines/gauntlet-protocol";
import { ChevronDown, RefreshCw, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { targetStateLabel, targetStateTone } from "../app/EnvironmentSwitcher.tsx";
import type { TargetSnapshot } from "../api.ts";
import { browserStorage } from "../browser-storage.ts";
import { EmptyState } from "../components/gauntlet/EmptyState.tsx";
import { ProblemAlert } from "../components/gauntlet/ProblemAlert.tsx";
import { RecentRunsList } from "../components/gauntlet/RecentRunsList.tsx";
import { StatStrip } from "../components/gauntlet/StatStrip.tsx";
import { StateMark } from "../components/gauntlet/StateMark.tsx";
import { filterOperations, impactBreakdown, impactCounts } from "../catalog.ts";
import { describeProblem, formatRelativeTime } from "../copy.ts";
import { readRecentRuns } from "../recent-runs.ts";
import { useOperationDetails } from "../useOperationDetails.ts";
import { CatalogTable, groupOperations } from "./CatalogTable.tsx";

const NO_OPERATIONS: readonly OperationSummary[] = [];
const MAX_RECENT_RUNS_SHOWN = 10;

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function OverviewScreen({ target, recentRunsVersion = 0, refreshing, refreshProblem, onRefresh }: {
  target: TargetSnapshot;
  /** Changes when a run is remembered, so the recent runs are read again. */
  recentRunsVersion?: number;
  refreshing: boolean;
  /** Set when the last refresh failed; the environments shown are from the last successful load. */
  refreshProblem?: Problem | undefined;
  onRefresh: () => void;
}) {
  const manifest = target.manifest;
  const operations = manifest?.operations ?? NO_OPERATIONS;
  // A refresh yields a new manifest object even when nothing changed; definitions are only
  // reloaded when an operation appears, disappears, changes revision or changes availability.
  const catalogKey = operations.map((o) => `${o.id}:${o.revision}:${o.availability.state}`).join("|");
  const stableOperations = useMemo(() => operations, [target.id, catalogKey]);
  const details = useOperationDetails(target.id, stableOperations);
  const [query, setQuery] = useState("");
  const recentRuns = useMemo(
    () => readRecentRuns(browserStorage).filter((entry) => entry.targetId === target.id).slice(0, MAX_RECENT_RUNS_SHOWN),
    [target.id, recentRunsVersion],
  );

  const unavailable = operations.filter((operation) => operation.availability.state !== "available");
  const available = operations.length - unavailable.length;
  const diagnostics = manifest?.diagnostics ?? [];
  const attention = diagnostics.length + unavailable.length;
  const groups = manifest === undefined ? [] : groupOperations(manifest, operations);
  const visible = manifest === undefined ? [] : groupOperations(manifest, filterOperations(operations, query));
  const visibleCount = visible.reduce((total, group) => total + group.operations.length, 0);
  const filtering = query.trim() !== "";
  const application = manifest?.application;

  const loadedDefinitions = Object.values(details).flatMap((detail) => detail.definition === undefined ? [] : [detail.definition]);
  const detailsSettled = Object.keys(details).length >= available;
  const readyDetail = available === 0
    ? "Nothing is available to run"
    : !detailsSettled
      ? "Loading details"
      : loadedDefinitions.length === 0
        ? "Details unavailable"
        : impactBreakdown(impactCounts(loadedDefinitions));
  const attentionParts = [
    ...(diagnostics.length === 0 ? [] : [plural(diagnostics.length, "diagnostic", "diagnostics")]),
    ...(unavailable.length === 0 ? [] : [plural(unavailable.length, "unavailable operation", "unavailable operations")]),
  ];

  return (
    <div className="mx-auto flex w-full max-w-[1240px] flex-col gap-8 px-4 py-6 sm:px-8 sm:py-8">
      {refreshProblem !== undefined && <ProblemAlert problem={refreshProblem} title="Could not refresh environments" />}
      {target.problem !== undefined && <ProblemAlert problem={target.problem} title="This environment is unreachable" />}

      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="text-2xl/8 font-semibold break-words">{target.label}</h1>
          <p className="flex flex-wrap items-center gap-x-2 text-[13px]/[18px] text-muted-foreground">
            {application !== undefined && (
              <>
                <span>{application.label}</span>
                <span aria-hidden="true">·</span>
                <span>{application.environment.kind}</span>
                <span aria-hidden="true">·</span>
              </>
            )}
            <span className="flex items-center gap-2 text-foreground">
              <StateMark tone={targetStateTone(target)} />
              {targetStateLabel(target)}
            </span>
            <span aria-hidden="true">·</span>
            <span>Refreshed {formatRelativeTime(target.refreshedAt)}</span>
          </p>
          <p className="max-w-[68ch] text-sm/5">
            {manifest === undefined
              ? "The environment did not send a valid operation catalog."
              : `${plural(operations.length, "operation", "operations")} in the catalog. Choose one to prepare a run.`}
          </p>
        </div>
        <Button variant="outline" size="sm" disabled={refreshing} onClick={onRefresh} className="shrink-0 self-start">
          <RefreshCw aria-hidden="true" className={refreshing ? "motion-safe:animate-spin" : undefined} />
          Refresh
        </Button>
      </header>

      {manifest !== undefined && (
        <StatStrip
          items={[
            { label: "All operations", value: operations.length, detail: `In ${plural(groups.length, "feature group", "feature groups")}` },
            { label: "Ready to run", value: available, detail: readyDetail },
            {
              label: "Need attention",
              value: attention,
              detail: attention === 0 ? "No reported problems" : attentionParts.join(", "),
            },
          ]}
        />
      )}

      {manifest !== undefined && (
        <div className="grid items-start gap-12 xl:grid-cols-[minmax(0,1fr)_320px]">
          <section aria-labelledby="catalog-heading" className="flex min-w-0 flex-col gap-4">
            <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
              <div className="flex min-w-64 flex-1 flex-col gap-1">
                <h2 id="catalog-heading" className="text-xl/7 font-semibold">Operation catalog</h2>
                <p className="max-w-[68ch] text-[13px]/[18px] text-muted-foreground">
                  Grouped by feature. Open an operation to see what it does before you run it.
                </p>
              </div>
              {operations.length > 0 && (
                <div className="flex w-full items-center sm:w-auto">
                  <div className="relative min-w-0 flex-1 sm:flex-none">
                    <Search aria-hidden="true" className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" />
                    <Input
                      aria-label="Filter operations"
                      placeholder="Filter operations"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      className="w-full pl-9 sm:w-56"
                    />
                  </div>
                  {/* `role="status"`, not an `aria-live` attribute: Radix keeps `[aria-live]` regions out of the page it hides behind a dialog. */}
                  <span role="status" className="shrink-0 pl-3 text-[13px]/[18px] text-muted-foreground tabular-nums empty:pl-0 sm:w-20 sm:text-right">
                    {filtering ? `${visibleCount} of ${operations.length}` : ""}
                  </span>
                </div>
              )}
            </div>
            {operations.length === 0 ? (
              <EmptyState
                title="The catalog is empty"
                description="No operations have been made available in this environment yet."
              />
            ) : visibleCount === 0 ? (
              <EmptyState title="No operations match" description="Try a different name or operation id." />
            ) : (
              <CatalogTable targetId={target.id} targetLabel={target.label} groups={visible} details={details} />
            )}
          </section>

          <aside aria-label="Environment details" className="flex min-w-0 flex-col gap-8">
            {attention > 0 && (
              <section aria-labelledby="attention-heading" className="flex flex-col gap-3">
                <h2 id="attention-heading" className="text-base/6 font-semibold">Needs attention</h2>
                <ul className="flex flex-col divide-y border-y">
                  {diagnostics.map((diagnostic, index) => (
                    <li key={`${index}:${diagnostic.code}`} className="flex flex-col gap-1 py-3">
                      <span className="flex items-center gap-2 text-[13px]/[18px]">
                        <StateMark tone={diagnostic.severity === "error" ? "stop" : "wait"} shape={diagnostic.severity === "error" ? "✕" : "▲"} />
                        {diagnostic.severity === "error" ? "Error" : "Warning"}
                      </span>
                      <p className="max-w-[68ch] text-sm/5 break-words">{diagnostic.message}</p>
                      <p className="font-mono text-xs/4 break-all text-muted-foreground">{diagnostic.code}</p>
                    </li>
                  ))}
                  {unavailable.map((operation) => (
                    <li key={operation.id} className="flex flex-col gap-1 py-3">
                      <span className="flex items-baseline justify-between gap-3">
                        <span className="text-sm/5 font-medium break-words">{operation.label}</span>
                        <Badge variant="outline" className="font-normal">Unavailable</Badge>
                      </span>
                      <p className="max-w-[68ch] text-sm/5 text-muted-foreground">
                        {operation.availability.state === "unavailable" ? describeProblem(operation.availability.problem).advice : ""}
                      </p>
                      <p className="font-mono text-xs/4 break-all text-muted-foreground">{operation.id}</p>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section aria-labelledby="recent-heading" className="flex flex-col gap-3">
              <h2 id="recent-heading" className="text-base/6 font-semibold">Your recent runs</h2>
              <RecentRunsList targetId={target.id} entries={recentRuns} />
            </section>

            <section aria-labelledby="note-heading" className="flex flex-col gap-1">
              <h2 id="note-heading" className="text-sm/5 font-medium">Details first, then action</h2>
              <p className="max-w-[68ch] text-sm/5 text-muted-foreground">
                Before a run you will see what the operation does. Operations that need confirmation will ask for your approval.
              </p>
            </section>

            {manifest.capabilities.length > 0 && (
              <Collapsible defaultOpen className="border-t pt-3">
                <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
                  <span className="flex flex-col gap-1">
                    <span className="text-sm/5 font-medium">Adapter capabilities</span>
                    <span className="text-[13px]/[18px] text-muted-foreground">
                      {manifest.capabilities.length} reported by {manifest.application.label}
                    </span>
                  </span>
                  <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs/4">
                    {manifest.capabilities.map((capability) => <li key={capability} className="break-all">{capability}</li>)}
                  </ul>
                </CollapsibleContent>
              </Collapsible>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
