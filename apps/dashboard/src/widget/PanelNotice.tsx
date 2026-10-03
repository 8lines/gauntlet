import { CircleX } from "lucide-react";
import type { TargetSnapshot } from "../api.ts";
import { describeProblem } from "../copy.ts";
import { EmptyState } from "@/components/gauntlet/EmptyState";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/**
 * Full-body message for panel states that have no catalog to show. `tone="stop"` is a problem
 * the user has to act on; the default only explains why there is nothing to show yet.
 */
export function PanelNotice({ title, detail, tone = "sub" }: {
  title: string;
  detail?: string | undefined;
  tone?: "sub" | "stop";
}) {
  if (tone === "stop") {
    return (
      <div className="p-4">
        <Alert role="status" className="border-err [&>svg]:text-err">
          <CircleX aria-hidden="true" />
          <AlertTitle className="line-clamp-none">{title}</AlertTitle>
          {detail !== undefined && <AlertDescription>{detail}</AlertDescription>}
        </Alert>
      </div>
    );
  }
  return (
    <div role="status" className="p-4">
      {detail === undefined
        ? <p className="px-6 py-8 text-center text-sm/5 font-medium">{title}</p>
        : <EmptyState title={title} description={detail} />}
    </div>
  );
}

/** The target's own problem (offline, stale manifest) above the lists, as on the dashboard. */
export function TargetProblem({ snapshot }: { snapshot: TargetSnapshot }) {
  if (snapshot.problem === undefined) return null;
  const { title, advice } = describeProblem(snapshot.problem);
  return (
    <div className="px-4 pt-4">
      <Alert className="border-err [&>svg]:text-err">
        <CircleX aria-hidden="true" />
        <AlertTitle className="line-clamp-none">{title}</AlertTitle>
        <AlertDescription>{advice}</AlertDescription>
      </Alert>
    </div>
  );
}
