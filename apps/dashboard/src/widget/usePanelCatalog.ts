import { useCallback, useMemo } from "react";
import type { OperationSummary } from "@8lines/gauntlet-protocol";
import type { PageContext, PageSubject } from "@8lines/gauntlet-widget-channel";
import { useOperationDetails } from "../useOperationDetails.ts";
import { panelLists } from "./placements.ts";
import { bindingValues, type BindingValue } from "./prefill.ts";
import { searchOperations } from "./search.ts";

/** An operation's description, which arrives with its definition after the catalog. */
export type OperationDescription =
  | { readonly loading: true }
  | { readonly loading: false; readonly text: string | undefined };

/**
 * Derives everything the panel shows from the target's catalog and the page context:
 * contextual/global lists, search results (label, description and tags — the latter two
 * come from the operation definitions, read with bounded concurrency), and the placement
 * bindings to prefill when a contextual operation is opened.
 */
export function usePanelCatalog(
  targetId: string,
  operations: readonly OperationSummary[],
  context: PageContext | undefined,
  query: string,
) {
  const details = useOperationDetails(targetId, operations);
  const lists = useMemo(() => panelLists(operations, context), [operations, context]);

  const searchable = useMemo(
    () => operations.map((operation) => ({
      ...operation,
      description: details[operation.id]?.description,
      tags: details[operation.id]?.tags,
    })),
    [operations, details],
  );
  const results = useMemo(() => searchOperations(searchable, query), [searchable, query]);

  const subjectOf = useCallback(
    (operationId: string): PageSubject | undefined =>
      lists.contextual.find((entry) => entry.operation.id === operationId)?.subject,
    [lists],
  );

  /** Unavailable operations are never read, so only available ones are ever "loading". */
  const describe = useCallback((operation: OperationSummary): OperationDescription => {
    const detail = details[operation.id];
    if (detail !== undefined) return { loading: false, text: detail.description };
    return operation.availability.state === "available" ? { loading: true } : { loading: false, text: undefined };
  }, [details]);

  /** `undefined` when the operation has no subject matching the page, so the form is not prefilled. */
  const bindingsFor = useCallback((operationId: string): readonly BindingValue[] | undefined => {
    const match = lists.contextual.find((entry) => entry.operation.id === operationId);
    if (match === undefined) return undefined;
    const placement = match.operation.placements?.find(
      (candidate) => candidate.kind === "subject" && candidate.subjectType === match.subject.type,
    );
    return placement?.kind === "subject" ? bindingValues(placement.bindings, match.subject) : [];
  }, [lists]);

  return { lists, results, describe, subjectOf, bindingsFor };
}
