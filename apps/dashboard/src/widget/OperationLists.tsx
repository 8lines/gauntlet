import type { ReactNode } from "react";
import type { OperationSummary } from "@8lines/gauntlet-protocol";
import type { PageSubject } from "@8lines/gauntlet-widget-channel";
import { Card, Rows } from "../ui.tsx";
import type { IconName } from "../Icon.tsx";
import { DashboardLink, OperationRow } from "./OperationRow.tsx";
import type { PanelLists } from "./placements.ts";
import type { RecentRun } from "./recent-runs.ts";
import type { OperationDescription } from "./usePanelCatalog.ts";

/**
 * Panel body while no operation or run is open: "On this page", "Global" and
 * "Recent runs", or search results instead of all three while a query is entered.
 */
export function OperationLists({
  targetId, query, lists, results, recent, describe, subjectOf, onOpenOperation, onOpenRun,
}: {
  targetId: string;
  query: string;
  lists: PanelLists;
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
      onOpen={() => onOpenOperation(operation)}
    />
  );

  if (query.trim() !== "") {
    return (
      <div className="space-y-4 p-4">
        <Section title="Search results" icon="search" count={results.length} empty="No matching operations.">
          {results.map((operation) => row(operation, subjectOf(operation.id)))}
        </Section>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      <Section title="On this page" icon="eye" count={lists.contextual.length} empty="No operations for this place in the application.">
        {lists.contextual.map(({ operation, subject }) => row(operation, subject))}
      </Section>
      <Section title="Global" icon="grid" count={lists.global.length} empty="No operations available from everywhere.">
        {lists.global.map((operation) => row(operation, undefined))}
      </Section>
      <Section title="Recent runs" icon="clock" count={recent.length} empty="Runs started from this widget will appear here.">
        {recent.map((run) => (
          <div key={run.runId} className="flex items-start gap-3 px-4 py-3">
            <button
              type="button"
              onClick={() => onOpenRun(run)}
              className="min-w-0 flex-1 rounded-control text-left hover:text-primary"
            >
              <span className="block wrap-anywhere text-[13px] font-medium">{run.label}</span>
              <span className="mt-0.5 block text-[12px] text-muted-foreground">{startedAt(run.startedAt)}</span>
            </button>
            <DashboardLink targetId={run.targetId} operationId={run.operationId} />
          </div>
        ))}
      </Section>
    </div>
  );
}

function Section({ title, icon, count, empty, children }: {
  title: string;
  icon: IconName;
  count: number;
  empty: string;
  children: ReactNode;
}) {
  return (
    <Card title={title} icon={icon} action={<span className="text-[12px] tabular-nums text-muted-foreground">{count}</span>}>
      {count === 0
        ? <p className="px-4 py-3 text-[12px] text-muted-foreground">{empty}</p>
        : <Rows>{children}</Rows>}
    </Card>
  );
}

function startedAt(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString("en", { dateStyle: "short", timeStyle: "short" });
}
