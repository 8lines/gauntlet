import type { ReactNode } from "react";
import type { OperationSummary } from "@8lines/gauntlet-protocol";
import type { PageSubject } from "@8lines/gauntlet-widget-channel";
import { RecentRunRow } from "@/components/gauntlet/RecentRunsList";
import { DashboardLink, OperationRow } from "./OperationRow.tsx";
import { applyPins, type PanelLists } from "./placements.ts";
import type { RecentRun } from "../recent-runs.ts";
import type { Pins } from "../usePins.ts";
import type { OperationDescription } from "./usePanelCatalog.ts";

/**
 * Panel body while no operation or run is open: "Pinned" (when not empty), "On this page", "Global"
 * and "Recent runs", or search results in their own order instead while a query is entered.
 */
export function OperationLists({
  targetId, query, lists, pins, results, recent, describe, subjectOf, onOpenOperation, onOpenRun,
}: {
  targetId: string;
  query: string;
  lists: PanelLists;
  pins: Pins;
  results: readonly OperationSummary[];
  recent: readonly RecentRun[];
  describe: (operation: OperationSummary) => OperationDescription;
  subjectOf: (operationId: string) => PageSubject | undefined;
  onOpenOperation: (operation: OperationSummary) => void;
  onOpenRun: (run: RecentRun) => void;
}) {
  const row = (operation: OperationSummary, subject: PageSubject | undefined) => (
    <OperationRow
      key={operation.id}
      targetId={targetId}
      operation={operation}
      description={describe(operation)}
      subject={subject}
      pin={pins.pinnedIds === undefined
        ? undefined
        : { pinned: pins.isPinned(operation.id), onToggle: () => pins.toggle(operation.id) }}
      onOpen={() => onOpenOperation(operation)}
    />
  );

  if (query.trim() !== "") {
    return (
      <div className="flex flex-col gap-6 p-4">
        <Section title="Search results" count={results.length} empty="No matching operations.">
          {results.map((operation) => row(operation, subjectOf(operation.id)))}
        </Section>
      </div>
    );
  }

  const { pinned, contextual, global } = applyPins(lists, pins.pinnedIds);
  return (
    <div className="flex flex-col gap-6 p-4">
      {pinned.length > 0 && (
        <Section title="Pinned" count={pinned.length} empty="">
          {pinned.map(({ operation, subject }) => row(operation, subject))}
        </Section>
      )}
      <Section title="On this page" count={contextual.length} empty="No operations for this place in the application.">
        {contextual.map(({ operation, subject }) => row(operation, subject))}
      </Section>
      <Section title="Global" count={global.length} empty="No operations available from everywhere.">
        {global.map((operation) => row(operation, undefined))}
      </Section>
      <Section title="Recent runs" count={recent.length} empty="Runs started from this widget will appear here.">
        {recent.map((run) => (
          <RecentRunRow
            key={run.runId}
            entry={run}
            // The panel does not fetch run states for this list; a run's result loads when it is opened.
            state={undefined}
            action={{ onOpen: () => onOpenRun(run) }}
            trailing={<DashboardLink targetId={run.targetId} operationId={run.operationId} />}
          />
        ))}
      </Section>
    </div>
  );
}

function Section({ title, count, empty, children }: {
  title: string;
  count: number;
  empty: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-base/6 font-semibold">{title}</h2>
        <span className="text-xs/4 text-muted-foreground tabular-nums">{count}</span>
      </div>
      {count === 0
        ? <p className="text-[13px]/[18px] text-muted-foreground">{empty}</p>
        : <ul className="flex flex-col divide-y border-y">{children}</ul>}
    </section>
  );
}
