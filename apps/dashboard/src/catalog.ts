import type { OperationDefinition, OperationSummary } from "@8lines/gauntlet-protocol";

export type Impact = OperationDefinition["execution"]["impact"];

/** A short line about what to expect before running, used in the catalog table. */
export function policySummary(definition: OperationDefinition): string {
  const { execution } = definition;
  const parts: string[] = [];
  if (execution.confirmationRequired) parts.push("asks you to confirm");
  if (execution.dryRunSupported) parts.push("dry run");
  if (execution.concurrency === "queue") parts.push("waits in a queue");
  parts.push(execution.cancellationSupported ? "can cancel" : "cannot be cancelled");
  const presets = definition.presets?.length ?? 0;
  if (presets > 0) parts.push(presets === 1 ? "1 preset" : `${presets} presets`);
  const sentence = parts.join(", ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

export function impactCounts(definitions: readonly OperationDefinition[]): Readonly<Record<Impact, number>> {
  const counts: Record<Impact, number> = { read: 0, write: 0, destructive: 0 };
  for (const definition of definitions) counts[definition.execution.impact] += 1;
  return counts;
}

export function impactBreakdown(counts: Readonly<Record<Impact, number>>): string {
  const parts: string[] = [];
  if (counts.read > 0) parts.push(`${counts.read} read only`);
  if (counts.write > 0) parts.push(`${counts.write} ${counts.write === 1 ? "changes" : "change"} data`);
  if (counts.destructive > 0) parts.push(`${counts.destructive} ${counts.destructive === 1 ? "deletes" : "delete"} data`);
  return parts.join(", ");
}

export function filterOperations(operations: readonly OperationSummary[], query: string): readonly OperationSummary[] {
  const needle = query.trim().toLocaleLowerCase("en");
  if (needle === "") return operations;
  return operations.filter((o) => `${o.label} ${o.id}`.toLocaleLowerCase("en").includes(needle));
}
