/**
 * Panel-side placement matching: which operations from a target's catalog
 * show up under the current page context ("contextual") versus always
 * ("global"). An operation with both a matching subject placement and a
 * global placement is listed once, under contextual — see
 * docs/superpowers/specs/2026-09-25-embeddable-widget-design.md.
 */

import type { OperationSummary } from "@8lines/gauntlet-protocol";
import type { PageContext, PageSubject } from "@8lines/gauntlet-widget-channel";

export interface ContextualOperation {
  readonly operation: OperationSummary;
  readonly subject: PageSubject;
}

export interface PanelLists {
  readonly contextual: readonly ContextualOperation[];
  readonly global: readonly OperationSummary[];
}

function matchingSubject(operation: OperationSummary, context: PageContext): PageSubject | undefined {
  for (const placement of operation.placements ?? []) {
    if (placement.kind !== "subject") continue;
    const subject = context.subjects.find((candidate) => candidate.type === placement.subjectType);
    if (subject !== undefined) return subject;
  }
  return undefined;
}

function isGlobal(operation: OperationSummary): boolean {
  return (operation.placements ?? []).some((placement) => placement.kind === "global");
}

export function panelLists(
  operations: readonly OperationSummary[],
  context: PageContext | undefined,
): PanelLists {
  const contextual: ContextualOperation[] = [];
  const global: OperationSummary[] = [];
  for (const operation of operations) {
    if (operation.placements === undefined) continue;
    const subject = context === undefined ? undefined : matchingSubject(operation, context);
    if (subject !== undefined) {
      contextual.push({ operation, subject });
      continue;
    }
    if (isGlobal(operation)) global.push(operation);
  }
  return { contextual, global };
}

/** Short label for a matched subject, e.g. `{ type: "order", values: { orderId: "123" } }` → "order 123". */
export function subjectChip(subject: PageSubject): string {
  const values = Object.values(subject.values).map((value) => String(value)).join(", ");
  return values === "" ? subject.type : `${subject.type} ${values}`;
}
