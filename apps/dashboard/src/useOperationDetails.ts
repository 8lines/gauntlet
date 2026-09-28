import { useEffect, useState } from "react";
import type { OperationSummary } from "@8lines/gauntlet-protocol";
import { api } from "./api.ts";

interface OperationDetails {
  readonly label: string;
  readonly description?: string;
  readonly tags?: readonly string[];
}

// The manifest contains identities and availability, but no execution policy.
// Read definitions with bounded concurrency; never infer impact from a name.
export function useOperationDetails(targetId: string, operations: readonly OperationSummary[]) {
  const [state, setState] = useState<{
    targetId: string;
    operations: readonly OperationSummary[];
    details: Record<string, OperationDetails>;
  }>({ targetId, operations, details: {} });

  useEffect(() => {
    let active = true;
    const queue = operations.filter((o) => o.availability.state === "available");
    setState({ targetId, operations, details: {} });
    const loadNext = async () => {
      while (active && queue.length > 0) {
        const operation = queue.shift()!;
        const result = await api.operation(targetId, operation.id);
        if (!active) return;
        let detail: OperationDetails = { label: "Details unavailable" };
        if (result.ok && result.data.revision === operation.revision) {
          const { execution, description, tags } = result.data;
          const impact = execution.impact === "read" ? "Read only" : execution.impact === "write" ? "Changes data" : "Deletes data";
          detail = {
            label: `${impact}${execution.confirmationRequired ? " · Confirmation" : ""}`,
            ...(description === undefined ? {} : { description }),
            tags,
          };
        }
        setState((current) => ({ ...current, details: { ...current.details, [operation.id]: detail } }));
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, queue.length) }, loadNext));
    return () => { active = false; };
  }, [targetId, operations]);

  return state.targetId === targetId && state.operations === operations ? state.details : {};
}
