import type { ProtocolId, Run, RunEvent, SessionLaunchResponse, UploadResponse } from "@8lines/gauntlet-protocol";

export interface RunCancellationEndpoint { cancel(runId: ProtocolId): Run | Promise<Run>; }
export interface RunEventsEndpoint { events(runId: ProtocolId, lastEventId?: string): AsyncIterable<RunEvent>; }
export interface UploadEndpoint { create(file: Blob): UploadResponse | Promise<UploadResponse>; }
export interface SessionLaunchEndpoint { create(runId: ProtocolId, artifactId: ProtocolId): SessionLaunchResponse | Promise<SessionLaunchResponse>; }
