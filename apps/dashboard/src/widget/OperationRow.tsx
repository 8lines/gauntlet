import type { OperationSummary } from "@8lines/gauntlet-protocol";
import type { PageSubject } from "@8lines/gauntlet-widget-channel";
import { Skeleton } from "@/components/ui/skeleton";
import { describeProblem } from "../copy.ts";
import { routePath } from "../route.ts";
import { subjectChip } from "./placements.ts";
import type { OperationDescription } from "./usePanelCatalog.ts";

/** Link to the same place in the full dashboard, always in a new tab. */
export function DashboardLink({ targetId, operationId }: { targetId: string; operationId: string }) {
  return (
    <a
      href={routePath({ targetId, operationId })}
      target="_blank"
      rel="noopener"
      className="shrink-0 rounded-sm py-3 text-[13px]/[18px] font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      Open in Gauntlet ↗
    </a>
  );
}

/**
 * One operation in the panel lists. Unavailable operations stay listed but cannot be opened
 * (same as the dashboard search); the dashboard link still explains why.
 */
export function OperationRow({ targetId, operation, description, subject, onOpen }: {
  targetId: string;
  operation: OperationSummary;
  description: OperationDescription;
  subject?: PageSubject | undefined;
  onOpen: () => void;
}) {
  const available = operation.availability.state === "available";
  return (
    <li className="flex items-start gap-3">
      <button
        type="button"
        disabled={!available}
        onClick={onOpen}
        className="flex min-w-0 flex-1 flex-col gap-1 rounded-sm py-3 text-left outline-none enabled:hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed"
      >
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm/5 font-medium break-words">{operation.label}</span>
          {subject !== undefined && (
            <span className="text-[13px]/[18px] text-muted-foreground">{`for ${subjectChip(subject)}`}</span>
          )}
        </span>
        {description.loading
          ? (
            // Reserves the description's line while the definition loads, so rows below do not shift under the pointer.
            <Skeleton aria-hidden="true" className="h-[18px] w-2/3" />
          )
          : description.text !== undefined && (
            <span className="text-[13px]/[18px] text-muted-foreground">{description.text}</span>
          )}
        {operation.availability.state === "unavailable" && (
          <span className="text-[13px]/[18px] text-muted-foreground">
            {`Unavailable. ${describeProblem(operation.availability.problem).title}`}
          </span>
        )}
      </button>
      <DashboardLink targetId={targetId} operationId={operation.id} />
    </li>
  );
}
