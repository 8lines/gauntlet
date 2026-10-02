import type { Tone } from "../../copy.ts";
import { cn } from "@/lib/utils";

const TONE_CLASS: Readonly<Record<Tone, string>> = {
  ok: "text-ok",
  wait: "text-warn",
  stop: "text-err",
  info: "text-focus",
  sub: "text-muted-foreground",
};

export type StateShape = "○" | "◐" | "●" | "▲" | "✓" | "✕" | "!" | "•";

export function StateMark({ tone, shape = "●", className }: { tone: Tone; shape?: StateShape; className?: string }) {
  return (
    <span aria-hidden="true" className={cn("inline-block w-3 text-center leading-none", TONE_CLASS[tone], className)}>
      {shape}
    </span>
  );
}
