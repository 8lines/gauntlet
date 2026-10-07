import { useEffect, useMemo, useState } from "react";
import type { OperationDefinition, OperationSummary } from "@8lines/gauntlet-protocol";
import { api } from "./api.ts";
import { browserStorage } from "./browser-storage.ts";
import { readCachedDefinitions, rememberDefinition } from "./catalog-cache.ts";

interface OperationDetails {
  readonly label: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly definition?: OperationDefinition;
}

function detailsOf(definition: OperationDefinition): OperationDetails {
  const { execution, description, tags } = definition;
  const impact = execution.impact === "read" ? "Read only" : execution.impact === "write" ? "Changes data" : "Deletes data";
  return {
    label: `${impact}${execution.confirmationRequired ? " · Confirmation" : ""}`,
    ...(description === undefined ? {} : { description }),
    tags,
    definition,
  };
}

// The manifest contains identities and availability, but no execution policy.
// Read definitions with bounded concurrency; never infer impact from a name.
// A definition cached at the manifest's revision is the same definition, so it is not read again.
export function useOperationDetails(targetId: string, operations: readonly OperationSummary[]) {
  const cached = useMemo(() => {
    const definitions = readCachedDefinitions(browserStorage, targetId, operations);
    return Object.fromEntries(Object.entries(definitions).map(([id, definition]) => [id, detailsOf(definition)]));
  }, [targetId, operations]);
  const [state, setState] = useState<{
    targetId: string;
    operations: readonly OperationSummary[];
    details: Record<string, OperationDetails>;
  }>({ targetId, operations, details: cached });

  useEffect(() => {
    let active = true;
    const queue = operations.filter((o) => o.availability.state === "available" && cached[o.id] === undefined);
    setState({ targetId, operations, details: cached });
    const loadNext = async () => {
      while (active && queue.length > 0) {
        const operation = queue.shift()!;
        const result = await api.operation(targetId, operation.id);
        if (!active) return;
        let detail: OperationDetails = { label: "Details unavailable" };
        if (result.ok && result.data.revision === operation.revision) {
          detail = detailsOf(result.data);
          rememberDefinition(browserStorage, targetId, result.data);
        }
        setState((current) => ({ ...current, details: { ...current.details, [operation.id]: detail } }));
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, queue.length) }, loadNext));
    return () => { active = false; };
  }, [targetId, operations, cached]);

  return state.targetId === targetId && state.operations === operations ? state.details : cached;
}
