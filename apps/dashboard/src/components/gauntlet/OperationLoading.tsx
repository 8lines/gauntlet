import { Skeleton } from "@/components/ui/skeleton";

/**
 * Placeholder in the shape of an operation screen. Used both while the screen's chunk loads
 * (Suspense fallback) and while its definition loads, so one skeleton appears throughout.
 */
export function OperationLoading({ label = "Loading operation", compact = false }: { label?: string; compact?: boolean }) {
  return (
    <div className="@container flex w-full flex-col gap-6 px-4 py-4 sm:px-6" aria-busy="true">
      <p className="sr-only" role="status">{label}</p>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-64 max-w-full" />
        <Skeleton className="h-4 w-40" />
      </div>
      <div className={`grid gap-5 ${compact ? "" : "@min-[640px]:grid-cols-2"}`}>
        <Skeleton className="h-80 w-full" />
        <div className="flex flex-col gap-3">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    </div>
  );
}
