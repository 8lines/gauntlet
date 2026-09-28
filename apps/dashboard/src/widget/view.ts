/**
 * What the embedded panel shows — the lists, one operation, or one recent run — and the
 * pure transitions between those views. An operation view freezes the page subject and
 * the bindings it was opened with: the form keeps prefilling from them (initial values,
 * preset changes) even after SPA navigation changes the page context, until the user
 * explicitly re-seeds them from the current page.
 */

import type { OperationSummary } from "@8lines/gauntlet-protocol";
import type { PageSubject } from "@8lines/gauntlet-widget-channel";
import type { BindingValue } from "./prefill.ts";
import type { RecentRun } from "./recent-runs.ts";

export type View =
  | { readonly kind: "lists" }
  | {
    readonly kind: "operation";
    readonly targetId: string;
    readonly operation: OperationSummary;
    readonly subject: PageSubject | undefined;
    readonly bindings: readonly BindingValue[] | undefined;
    readonly runShown: boolean;
  }
  | { readonly kind: "run"; readonly entry: RecentRun; readonly runShown: boolean };

export type OperationView = Extract<View, { kind: "operation" }>;

export function openOperationView(
  targetId: string,
  operation: OperationSummary,
  subject: PageSubject | undefined,
  bindings: readonly BindingValue[] | undefined,
): OperationView {
  return { kind: "operation", targetId, operation, subject, bindings, runShown: false };
}

/**
 * A run was created for `operationId` on `targetId`. The request is async, so the user may
 * have left that operation meanwhile: only the view still showing it widens for the result.
 */
export function runCreatedIn(view: View, targetId: string, operationId: string): View {
  if (view.kind !== "operation" || view.targetId !== targetId || view.operation.id !== operationId) return view;
  return view.runShown ? view : { ...view, runShown: true };
}

/** Replaces the frozen subject and bindings with the current page's ("Use values from the page"). */
export function reseedOperationView(
  view: OperationView,
  subject: PageSubject | undefined,
  bindings: readonly BindingValue[] | undefined,
): OperationView {
  return { ...view, subject, bindings };
}

function sameSubject(a: PageSubject, b: PageSubject): boolean {
  if (a.type !== b.type) return false;
  const aKeys = Object.keys(a.values);
  if (aKeys.length !== Object.keys(b.values).length) return false;
  return aKeys.every((key) => Object.hasOwn(b.values, key) && a.values[key] === b.values[key]);
}

/**
 * Whether the page now offers different values for an open operation than the frozen ones:
 * the page has a subject for it, that subject differs from the frozen one, and it binds at
 * least one value (otherwise re-seeding would change nothing).
 */
export function pageSubjectDrifted(
  frozen: PageSubject | undefined,
  current: PageSubject | undefined,
  currentBindings: readonly BindingValue[] | undefined,
): boolean {
  if (current === undefined || currentBindings === undefined || currentBindings.length === 0) return false;
  return frozen === undefined || !sameSubject(frozen, current);
}
