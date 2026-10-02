import type { PolicyEffect } from "../../copy.ts";
import { StateMark, type StateShape } from "./StateMark.tsx";

const SHAPE = { ok: "✓", wait: "▲", stop: "✕", info: "•", sub: "•" } as const satisfies Record<PolicyEffect["tone"], StateShape>;

export function PolicyList({ effects }: { effects: readonly PolicyEffect[] }) {
  return (
    <ul className="space-y-2">
      {effects.map((effect) => (
        <li key={effect.text} className="flex gap-2 text-sm/5">
          <StateMark tone={effect.tone} shape={SHAPE[effect.tone]} className="mt-0.5" />
          <span className={effect.tone === "sub" ? "text-muted-foreground" : undefined}>{effect.text}</span>
        </li>
      ))}
    </ul>
  );
}
