import type { Run } from "@8lines/gauntlet-protocol";
import type { TargetSnapshot } from "./manifest-service.js";

export interface GauntletStore {
  getSnapshot(targetId: string): TargetSnapshot | undefined;
  saveSnapshot(snapshot: TargetSnapshot): void;
  getRun(targetId: string, runId: string): Run | undefined;
  saveRun(targetId: string, run: Run): void;
}
