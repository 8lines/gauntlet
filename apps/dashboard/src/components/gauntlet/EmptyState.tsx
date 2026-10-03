import type { ReactNode } from "react";

export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed px-6 py-8 text-center">
      <p className="text-sm/5 font-medium">{title}</p>
      <p className="mx-auto mt-1 max-w-[52ch] text-[13px]/[18px] text-muted-foreground">{description}</p>
      {action !== undefined && <div className="mt-4">{action}</div>}
    </div>
  );
}
