/**
 * Panel search over a target's operation catalog: case-insensitive substring
 * match on label, description and tags (`toLocaleLowerCase("en")`, matching
 * the dashboard's own search — see GlobalSearch.tsx). `OperationSummary`
 * itself only carries `label`; `description`/`tags` are optional extras a
 * caller may attach once it has fetched the full operation definitions for
 * the target's catalog.
 */

import type { OperationSummary } from "@8lines/gauntlet-protocol";

type SearchableOperation = OperationSummary & {
  readonly description?: string;
  readonly tags?: readonly string[];
};

const SEPARATOR = "\u0000";

function searchableText(operation: OperationSummary): string {
  const entry: SearchableOperation = operation;
  return [entry.label, entry.description, ...(entry.tags ?? [])]
    .filter((part): part is string => typeof part === "string")
    .join(SEPARATOR);
}

export function searchOperations(
  operations: readonly OperationSummary[],
  query: string,
): readonly OperationSummary[] {
  const trimmed = query.trim();
  if (trimmed === "") return [];
  const needle = trimmed.toLocaleLowerCase("en");
  return operations.filter((operation) => searchableText(operation).toLocaleLowerCase("en").includes(needle));
}
