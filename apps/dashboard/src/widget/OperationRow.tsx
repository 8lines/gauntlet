import type { OperationSummary } from "@8lines/gauntlet-protocol";
import type { PageSubject } from "@8lines/gauntlet-widget-channel";
import { ArrowUpRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ImpactBadge } from "@/components/gauntlet/ImpactBadge";
import { describeProblem } from "../copy.ts";
import { routePath } from "../route.ts";
import { subjectChip } from "./placements.ts";
import type { OperationDescription } from "./usePanelCatalog.ts";

/** Icon link to the same place in the full dashboard, always in a new tab. */
export function DashboardLink({ targetId, operationId }: { targetId: string; operationId: string }) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button asChild variant="ghost" size="icon-sm" className="shrink-0 text-muted-foreground hover:text-foreground">
            <a href={routePath({ targetId, operationId })} target="_blank" rel="noopener" aria-label="Open in Gauntlet">
              <ArrowUpRight aria-hidden="true" />
            </a>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left" sideOffset={4}>Open in Gauntlet</TooltipContent>
      </Tooltip>
    </TooltipProvider>
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
    <li className="flex items-start gap-2">
      <button
        type="button"
        disabled={!available}
        onClick={onOpen}
        className="flex min-w-0 flex-1 flex-col gap-1 rounded-sm py-3 text-left outline-none enabled:hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed"
      >
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 text-sm/5 font-medium break-words">{operation.label}</span>
          {!description.loading && description.impact !== undefined && <ImpactBadge impact={description.impact} />}
          {!available && <Badge variant="outline" className="font-normal">Unavailable</Badge>}
        </span>
        {subject !== undefined && (
          <span className="text-[13px]/[18px] break-words text-muted-foreground">{`for ${subjectChip(subject)}`}</span>
        )}
        {description.loading
          ? (
            // Reserves the description's line while the definition loads, so rows below do not shift under the pointer.
            <Skeleton aria-hidden="true" className="h-[18px] w-2/3" />
          )
          : description.text !== undefined && (
            <span className="line-clamp-2 text-[13px]/[18px] break-words text-muted-foreground" title={description.text}>
              {description.text}
            </span>
          )}
        {operation.availability.state === "unavailable" && (
          <span className="text-[13px]/[18px] text-muted-foreground">{describeProblem(operation.availability.problem).title}</span>
        )}
      </button>
      <span className="pt-2"><DashboardLink targetId={targetId} operationId={operation.id} /></span>
    </li>
  );
}
