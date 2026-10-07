import { useEffect, useMemo, useState } from "react";
import type { OperationSummary, Problem } from "@8lines/gauntlet-protocol";
import { api, type TargetSnapshot } from "../api.ts";
import { browserStorage } from "../browser-storage.ts";
import { readCachedSnapshot, rememberSnapshot } from "../catalog-cache.ts";

export type PanelTarget =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly problem: Problem }
  | { readonly kind: "unknown" }
  | { readonly kind: "found"; readonly snapshot: TargetSnapshot };

const NO_OPERATIONS: readonly OperationSummary[] = [];

/**
 * Looks the host's target up in `GET /api/v1/targets`; `refreshKey` changes (each
 * `gauntlet:open`) re-read the snapshot so a panel preloaded long ago shows current state.
 * The returned `operations` keep their identity while the manifest revision is unchanged,
 * so per-operation definition lookups are not repeated on every refresh. When a refresh fails
 * after the target was found, the last snapshot stays and `refreshProblem` reports the failure.
 * The panel starts from the snapshot cached by a previous page load, so the lists show at once
 * while the first read is still on its way.
 */
export function usePanelTarget(targetId: string | undefined, refreshKey: number) {
  const [target, setTarget] = useState<PanelTarget>(() => {
    const cached = targetId === undefined ? undefined : readCachedSnapshot(browserStorage, targetId);
    return cached === undefined ? { kind: "loading" } : { kind: "found", snapshot: cached };
  });
  const [refreshProblem, setRefreshProblem] = useState<Problem>();

  useEffect(() => {
    if (targetId === undefined) return;
    let active = true;
    void api.targets().then((result) => {
      if (!active) return;
      if (!result.ok) {
        // A failed refresh must not unmount an open operation or run: keep the last snapshot.
        setTarget((current) => (current.kind === "found" ? current : { kind: "error", problem: result.problem }));
        setRefreshProblem(result.problem);
        return;
      }
      setRefreshProblem(undefined);
      const snapshot = result.data.find((candidate) => candidate.id === targetId);
      if (snapshot !== undefined) rememberSnapshot(browserStorage, snapshot);
      setTarget(snapshot === undefined ? { kind: "unknown" } : { kind: "found", snapshot });
    });
    return () => { active = false; };
  }, [targetId, refreshKey]);

  const manifest = target.kind === "found" ? target.snapshot.manifest : undefined;
  // Keyed on the revision on purpose: a refreshed snapshot of the same manifest keeps the list.
  const operations = useMemo(() => manifest?.operations ?? NO_OPERATIONS, [manifest?.manifestRevision]);

  return { target, operations, refreshProblem };
}
