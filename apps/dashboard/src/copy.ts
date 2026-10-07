import type { ExecutionPolicy, Problem, Run, RunState } from "@8lines/gauntlet-protocol";
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
    effects.push({ tone: "sub", text: `If it takes longer than ${formatElapsed(policy.timeoutSeconds * 1000)}, it will be stopped.` });
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

/** The sentence under a failed sign-in; `fields` says whether a username was asked for. */
export function loginProblemMessage(problem: Problem, fields: readonly string[]): string {
  if (problem.type === "urn:gauntlet:problem:invalid-credentials") {
    return fields.includes("username") ? "Incorrect username or password." : "Incorrect password.";
  }
  if (problem.type === "urn:gauntlet:problem:rate-limited") return "Too many attempts. Try again in a few minutes.";
  if (problem.type === "urn:gauntlet:problem:network-unreachable") {
    return "Could not connect to Gauntlet. Check your connection to the network Gauntlet runs in.";
  }
  return "Could not sign in. Try again.";
}

const UNKNOWN_TIME = "at an unknown time";

/** "just now", "12 s ago", "5 min ago", "3 h ago", "2 d ago"; a timestamp that does not parse reads "at an unknown time". */
export function formatRelativeTime(timestamp: string, now: Date = new Date()): string {
  const time = new Date(timestamp).getTime();
  if (Number.isNaN(time) || Number.isNaN(now.getTime())) return UNKNOWN_TIME;
  const seconds = Math.round((now.getTime() - time) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** Milliseconds from `startedAt` to `completedAt`, or `undefined` when either is missing, unparsable or out of order. */
export function elapsedMilliseconds(startedAt: string | undefined, completedAt: string | undefined): number | undefined {
  if (startedAt === undefined || completedAt === undefined) return undefined;
  const elapsed = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  return Number.isNaN(elapsed) || elapsed < 0 ? undefined : elapsed;
}

/** How long something took: "850 ms", "3.4 s", "42 s", "2 min 5 s", "1 h 5 min". */
export function formatElapsed(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "an unknown time";
  if (Math.round(milliseconds) < 1000) return `${Math.round(milliseconds)} ms`;
  const tenths = Math.round(milliseconds / 100);
  if (tenths < 100) return `${(tenths / 10).toFixed(1).replace(/\.0$/, "")} s`;
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 === 0 ? `${minutes} min` : `${minutes} min ${seconds % 60} s`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
}
