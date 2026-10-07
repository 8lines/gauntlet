/** How many operations one principal may pin on one target. */
export const PIN_LIMIT = 100;

export interface Pin {
  readonly operationId: string;
  /** ISO 8601 time of the first pin; re-pinning does not change it. */
  readonly pinnedAt: string;
}

export type PinResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "limit" };

/**
 * Pinned operations of one principal on one target. Operation ids are only unique within one
 * manifest, so a pin never applies to another target.
 */
export interface PinStore {
  /** Oldest first. */
  list(principalId: string, targetId: string): readonly Pin[];
  /** Idempotent; refuses a new pin beyond `PIN_LIMIT`. */
  pin(principalId: string, targetId: string, operationId: string, at: Date): PinResult;
  /** Idempotent. */
  unpin(principalId: string, targetId: string, operationId: string): void;
}
