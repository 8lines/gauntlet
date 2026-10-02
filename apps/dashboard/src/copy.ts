import type { ExecutionPolicy, OperationDefinition, Problem, Run, RunState } from "@8lines/gauntlet-protocol";
import type { Impact } from "./catalog.ts";

export type Tone = "ok" | "wait" | "stop" | "info" | "sub";

export interface PolicyEffect {
  readonly tone: Tone;
  readonly text: string;
}

/**
 * Turns an execution policy into sentences in the user's terms.
 * This is the core of the interface: a tester does not read `impact: write`,
 * they read "changes data in the application".
 */
export function policyEffects(policy: ExecutionPolicy): readonly PolicyEffect[] {
  const effects: PolicyEffect[] = [];

  if (policy.impact === "read") {
    effects.push({ tone: "ok", text: "Only reads data. Changes nothing in the application." });
  } else if (policy.impact === "write") {
    effects.push({ tone: "wait", text: "Changes data in the application." });
  } else {
    effects.push({ tone: "stop", text: "Deletes data. This cannot be undone." });
  }

  if (policy.dryRunSupported) {
    effects.push({ tone: "ok", text: "You can do a dry run first. You will see the result, but nothing will change." });
  }

  effects.push(policy.cancellationSupported
    ? { tone: "ok", text: "You can cancel it while it runs." }
    : { tone: "wait", text: "Once started, it cannot be cancelled." });

  if (policy.timeoutSeconds !== undefined) {
    effects.push({ tone: "sub", text: `If it takes longer than ${formatDuration(policy.timeoutSeconds)}, it will be stopped.` });
  }

  if (policy.concurrency === "forbid") {
    effects.push({ tone: "wait", text: "Will not start while another run of this operation is in progress." });
  } else if (policy.concurrency === "queue") {
    effects.push({ tone: "sub", text: "If someone else has already started it, your run will wait in the queue." });
  }

  if (policy.idempotency === "required") {
    effects.push({ tone: "sub", text: "Repeating with the same key is safe. It will not duplicate the effect." });
  }

  return effects;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? "a minute" : `${minutes} min`;
}

/** Run button label: never "Execute", always the operation name. */
export function runButtonLabel(definition: OperationDefinition): string {
  return definition.label;
}

const IMPACT_LABELS: Readonly<Record<Impact, string>> = { read: "read only", write: "changes data", destructive: "deletes data" };
export const IMPACT_MARK: Readonly<Record<Impact, "○" | "◐" | "●">> = { read: "○", write: "◐", destructive: "●" };
export const impactLabel = (impact: Impact) => IMPACT_LABELS[impact];

const RUN_STATES: Readonly<Record<RunState, { readonly label: string; readonly tone: Tone }>> = {
  queued: { label: "Queued", tone: "info" },
  running: { label: "Running", tone: "info" },
  succeeded: { label: "Done", tone: "ok" },
  failed: { label: "Failed", tone: "stop" },
  partial: { label: "Partial", tone: "wait" },
  cancelled: { label: "Cancelled", tone: "sub" },
  timed_out: { label: "Timed out", tone: "wait" },
  expired: { label: "Expired", tone: "sub" },
};
export const runStateLabel = (state: RunState) => RUN_STATES[state];

/** An RFC 7807 Problem reduced to one sentence and a hint about what to do next. */
export function describeProblem(problem: Problem): { readonly title: string; readonly advice: string } {
  const advice: Readonly<Record<string, string>> = {
    "urn:gauntlet:problem:validation-failed": "Fix the highlighted fields and try again. Nothing was sent to the application.",
    "urn:gauntlet:problem:unsupported-capability": "This application does not provide this feature. Its team has to register it in their integration.",
    "urn:gauntlet:problem:target-not-found": "The environment is no longer in the configuration. Refresh the environment list.",
    "urn:gauntlet:problem:adapter-protocol-incompatible": "The application speaks a different protocol version. This is for the team that maintains it.",
    "urn:gauntlet:problem:network-unreachable": "Check your connection to the network Gauntlet runs in.",
  };
  return {
    title: problem.title,
    advice: advice[problem.type] ?? (problem.detail ?? "Try again. If it happens again, give the team the correlation ID."),
  };
}

export function formatRelativeTime(timestamp: string, now: Date = new Date()): string {
  const seconds = Math.round((now.getTime() - new Date(timestamp).getTime()) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}
