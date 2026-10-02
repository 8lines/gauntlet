import { Badge } from "@/components/ui/badge";
import type { Impact } from "../../catalog.ts";
import { IMPACT_MARK, impactLabel } from "../../copy.ts";
import { StateMark } from "./StateMark.tsx";

const IMPACT_TONE = { read: "ok", write: "wait", destructive: "stop" } as const;

export function ImpactBadge({ impact }: { impact: Impact }) {
  return (
    <Badge variant="outline" className="gap-1.5 font-normal">
      <StateMark tone={IMPACT_TONE[impact]} shape={IMPACT_MARK[impact]} />
      {impactLabel(impact)}
    </Badge>
  );
}
