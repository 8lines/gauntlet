import type {
  Artifact,
  FollowUpAction,
  InvocationContext,
  ProtocolId,
  RunProgress,
} from "@8lines/gauntlet-protocol";
import type { StructuredLogEntry } from "./operation.js";

export interface RunContext {
  readonly runId: ProtocolId;
  readonly operationId: ProtocolId;
  readonly dryRun: boolean;
  /** Available only while the operation handler is active. */
  readonly invocationContext?: InvocationContext;
  readonly signal: AbortSignal;
  report(progress: Omit<RunProgress, "updatedAt">): void;
  addArtifact(artifact: Artifact): void;
  addAction(action: FollowUpAction): void;
  log(entry: StructuredLogEntry): void;
  warn(message: string): void;
  throwIfCancelled(): void;
}
