import { Skeleton } from "@/components/ui/skeleton";

/** Suspense fallback while the operation screen chunk loads; mirrors the title, form fields and action row. */
export function OperationLoading() {
  return (
    <div role="status" aria-label="Loading operation" className="mx-auto flex w-full max-w-[1240px] flex-col gap-6 px-4 py-6 sm:px-8 sm:py-8">
      <Skeleton className="h-8 w-64 max-w-full" />
      <div aria-hidden="true" className="flex flex-col gap-4">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
      <Skeleton aria-hidden="true" className="h-9 w-32" />
    </div>
  );
}
