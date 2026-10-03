import type { Problem } from "@8lines/gauntlet-protocol";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/gauntlet/EmptyState";
import { ProblemAlert } from "@/components/gauntlet/ProblemAlert";

const PAGE = "mx-auto flex w-full max-w-[1240px] flex-col gap-6 px-4 py-6 sm:px-8 sm:py-8";

export function LoadingState() {
  return (
    <div role="status" aria-label="Loading environments" className={PAGE}>
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-5 w-full max-w-md" />
      <div aria-hidden="true" className="grid gap-4 sm:grid-cols-3">
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
      </div>
    </div>
  );
}

export function NoEnvironments() {
  return (
    <div className={PAGE}>
      <EmptyState
        title="No environments configured"
        description="Add an environment to the Gauntlet configuration, then restart the server."
      />
    </div>
  );
}

export function LoadFailed({ problem, refreshing = false, onRetry }: {
  problem: Problem;
  refreshing?: boolean;
  onRetry: () => void;
}) {
  return (
    <div className={PAGE}>
      <ProblemAlert problem={problem} title="Could not load environments" />
      <div>
        <Button variant="outline" disabled={refreshing} onClick={onRetry}>Try again</Button>
      </div>
    </div>
  );
}
