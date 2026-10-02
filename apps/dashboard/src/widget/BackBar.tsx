import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DashboardLink } from "./OperationRow.tsx";

/** Bar above an open operation or run: back to the lists, and the same view in the dashboard. */
export function BackBar({ onBack, targetId, operationId }: { onBack: () => void; targetId: string; operationId: string }) {
  return (
    <div className="flex shrink-0 items-center gap-3 border-b bg-background px-4 py-2">
      <Button type="button" variant="ghost" size="sm" onClick={onBack}>
        <ChevronLeft aria-hidden="true" />
        Back
      </Button>
      <span className="flex-1" />
      <DashboardLink targetId={targetId} operationId={operationId} />
    </div>
  );
}
