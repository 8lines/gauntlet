import { Skeleton } from "@/components/ui/skeleton";

/**
 * Placeholder in the shape of an operation screen. Used both while the screen's chunk loads
 * (Suspense fallback) and while its definition loads, so one skeleton appears throughout.
 */
export function OperationLoading({ label = "Loading operation" }: { label?: string }) {
  return (
    <div className="mx-auto flex w-full max-w-[1240px] flex-col gap-8 px-4 py-6 sm:px-8 sm:py-8" aria-busy="true">
      <p className="sr-only" role="status">{label}</p>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-64 max-w-full" />
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.8fr)] xl:gap-12">
        <Skeleton className="h-80 w-full" />
        <div className="flex flex-col gap-3">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    </div>
  );
}
