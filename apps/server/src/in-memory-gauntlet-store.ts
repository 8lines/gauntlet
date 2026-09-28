import type { Run } from "@8lines/gauntlet-protocol";
import type { TargetSnapshot } from "./manifest-service.js";
import { ownFrozenJson } from "./ownership.js";
import type { GauntletStore } from "./gauntlet-store.js";

export function createInMemoryGauntletStore(): GauntletStore {
  const snapshots = new Map<string, TargetSnapshot>();
  const runs = new Map<string, Run>();
  const runKey = (targetId: string, runId: string): string => `${targetId.length}:${targetId}${runId}`;

  return Object.freeze({
    getSnapshot(targetId: string): TargetSnapshot | undefined {
      const snapshot = snapshots.get(targetId);
      return snapshot === undefined ? undefined : ownFrozenJson(snapshot);
    },
    saveSnapshot(snapshot: TargetSnapshot): void {
      snapshots.set(snapshot.id, ownFrozenJson(snapshot));
    },
    getRun(targetId: string, runId: string): Run | undefined {
      const run = runs.get(runKey(targetId, runId));
      return run === undefined ? undefined : ownFrozenJson(run);
    },
    saveRun(targetId: string, run: Run): void {
      runs.set(runKey(targetId, run.id), ownFrozenJson(run));
    },
  });
}
