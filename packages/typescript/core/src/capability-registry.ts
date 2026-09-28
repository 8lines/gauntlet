import type { CapabilityId, CoreCapabilityId } from "@8lines/gauntlet-protocol";
import type { RunCancellationEndpoint, RunEventsEndpoint, SessionLaunchEndpoint, UploadEndpoint } from "./capability-endpoints.js";

export interface CapabilityProvider { readonly id: CapabilityId; }
const core = new Set<CoreCapabilityId>(["tc-uploads@1", "tc-run-cancellation@1", "tc-run-sse@1", "tc-session-launch@1"]);

export class CapabilityRegistry {
  #cancel?: RunCancellationEndpoint;
  #events?: RunEventsEndpoint;
  #uploads?: UploadEndpoint;
  #sessions?: SessionLaunchEndpoint;
  readonly #providers = new Map<CapabilityId, CapabilityProvider>();
  registerCancellation(endpoint: RunCancellationEndpoint): void { if (this.#cancel) throw new TypeError("Duplicate run cancellation endpoint"); this.#cancel = endpoint; }
  registerEvents(endpoint: RunEventsEndpoint): void { if (this.#events) throw new TypeError("Duplicate run events endpoint"); this.#events = endpoint; }
  registerUploads(endpoint: UploadEndpoint): void { if (this.#uploads) throw new TypeError("Duplicate upload endpoint"); this.#uploads = endpoint; }
  registerSessionLaunch(endpoint: SessionLaunchEndpoint): void { if (this.#sessions) throw new TypeError("Duplicate session launch endpoint"); this.#sessions = endpoint; }
  registerProvider(provider: CapabilityProvider): void {
    if (core.has(provider.id as CoreCapabilityId)) throw new TypeError("A generic provider cannot claim a core capability");
    if (this.#providers.has(provider.id)) throw new TypeError(`Duplicate capability provider: ${provider.id}`);
    this.#providers.set(provider.id, provider);
  }
  cancellation(): RunCancellationEndpoint | undefined { return this.#cancel; }
  events(): RunEventsEndpoint | undefined { return this.#events; }
  uploads(): UploadEndpoint | undefined { return this.#uploads; }
  sessionLaunch(): SessionLaunchEndpoint | undefined { return this.#sessions; }
  ids(): readonly CapabilityId[] {
    return [
      ...(this.#cancel ? ["tc-run-cancellation@1" as const] : []), ...(this.#events ? ["tc-run-sse@1" as const] : []),
      ...(this.#uploads ? ["tc-uploads@1" as const] : []), ...(this.#sessions ? ["tc-session-launch@1" as const] : []), ...this.#providers.keys(),
    ].sort();
  }
}
