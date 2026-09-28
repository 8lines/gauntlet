import type { TargetSnapshot } from "../api.ts";
import { Icon, type IconName } from "../Icon.tsx";
import { describeProblem } from "../copy.ts";

/** Full-body message for panel states that have no catalog to show. */
export function PanelNotice({ title, detail, icon = "panel", tone = "sub" }: {
  title: string;
  detail?: string | undefined;
  icon?: IconName;
  tone?: "sub" | "stop";
}) {
  return (
    <div role="status" className="flex flex-col items-center gap-2 px-6 py-16 text-center">
      <span className="empty-icon mb-3"><Icon name={icon} className="h-6 w-6" /></span>
      <p className={`text-[14px] font-medium ${tone === "stop" ? "text-stop" : ""}`}>{title}</p>
      {detail !== undefined && <p className="max-w-sm text-[12px] leading-relaxed text-muted-foreground">{detail}</p>}
    </div>
  );
}

/** The target's own problem (offline, stale manifest) above the lists, as on the dashboard. */
export function TargetProblem({ snapshot }: { snapshot: TargetSnapshot }) {
  if (snapshot.problem === undefined) return null;
  const { title, advice } = describeProblem(snapshot.problem);
  return (
    <div className="mx-4 mt-4 rounded-card border border-stop-bd bg-stop-bg p-4">
      <p className="text-[13px] font-medium text-stop">{title}</p>
      <p className="mt-1 text-[12px] text-muted-foreground">{advice}</p>
    </div>
  );
}
