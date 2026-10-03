import type { RunState } from "@8lines/gauntlet-protocol";
import { Badge } from "@/components/ui/badge";
import { runStateLabel } from "../../copy.ts";
import { StateMark, type StateShape } from "./StateMark.tsx";

const SHAPE: Readonly<Record<RunState, StateShape>> = {
  queued: "◐",
  running: "◐",
  succeeded: "✓",
  failed: "✕",
  partial: "!",
  timed_out: "!",
  cancelled: "○",
  expired: "○",
};

export function RunStateBadge({ state }: { state: RunState }) {
  const { label, tone } = runStateLabel(state);
  return (
    <Badge variant="outline" className="gap-1.5 font-normal">
      <StateMark tone={tone} shape={SHAPE[state]} />
      {label}
    </Badge>
  );
}
