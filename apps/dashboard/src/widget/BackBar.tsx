import { Icon } from "../Icon.tsx";
import { DashboardLink } from "./OperationRow.tsx";

/** Bar above an open operation or run: back to the lists, and the same view in the dashboard. */
export function BackBar({ onBack, targetId, operationId }: { onBack: () => void; targetId: string; operationId: string }) {
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-border bg-background px-4 py-2">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 rounded-control px-2 py-1 text-[13px] font-medium hover:bg-accent"
      >
        <Icon name="chevron" className="h-3.5 w-3.5 rotate-180" />
        Back
      </button>
      <span className="flex-1" />
      <DashboardLink targetId={targetId} operationId={operationId} />
    </div>
  );
}
