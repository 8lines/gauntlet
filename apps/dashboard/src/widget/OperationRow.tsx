import type { OperationSummary } from "@8lines/gauntlet-protocol";
import type { PageSubject } from "@8lines/gauntlet-widget-channel";
import { Badge } from "../ui.tsx";
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
      className="shrink-0 rounded-badge text-[12px] font-medium text-primary hover:underline"
    >
      Open in Gauntlet
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
    <div className="flex items-start gap-3 px-4 py-3">
      <button
        type="button"
        disabled={!available}
        onClick={onOpen}
        className="min-w-0 flex-1 rounded-control text-left enabled:hover:text-primary disabled:opacity-45"
      >
        <span className="flex flex-wrap items-center gap-2">
          <span className="wrap-anywhere text-[13px] font-medium">{operation.label}</span>
          {subject !== undefined && <Badge tone="info">{subjectChip(subject)}</Badge>}
        </span>
        {description.loading
          ? (
            // Reserves the description's line while the definition loads, so rows below do not shift under the pointer.
            <span aria-hidden="true" className="mt-0.5 block text-[12px] leading-relaxed">
              <span className="inline-block h-2.5 w-2/3 rounded-badge bg-muted align-middle" />
            </span>
          )
          : description.text !== undefined && (
            <span className="mt-0.5 block text-[12px] leading-relaxed text-muted-foreground">{description.text}</span>
          )}
        {operation.availability.state === "unavailable" && (
          <span className="mt-0.5 block text-[12px] text-wait">
            Unavailable · {describeProblem(operation.availability.problem).title}
          </span>
        )}
      </button>
      <DashboardLink targetId={targetId} operationId={operation.id} />
    </div>
  );
}
