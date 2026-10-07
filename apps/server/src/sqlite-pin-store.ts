import type { Database } from "./database.js";
import { PIN_LIMIT, type Pin, type PinResult, type PinStore } from "./pin-store.js";

const PINNED: PinResult = Object.freeze({ ok: true });
const LIMIT_REACHED: PinResult = Object.freeze({ ok: false, reason: "limit" });

/** A pin store over the `pins` table of Gauntlet's database. */
export function createSqlitePinStore(database: Database): PinStore {
  const list = database.prepare(`
    SELECT operation_id, pinned_at FROM pins
    WHERE principal_id = :principal AND target_id = :target
    ORDER BY pinned_at, operation_id`);
  // One statement checks the limit and inserts, so concurrent writers cannot exceed it.
  const insert = database.prepare(`
    INSERT INTO pins (principal_id, target_id, operation_id, pinned_at)
    SELECT :principal, :target, :operation, :pinnedAt
    WHERE (SELECT COUNT(*) FROM pins WHERE principal_id = :principal AND target_id = :target) < :limit
    ON CONFLICT (principal_id, target_id, operation_id) DO NOTHING`);
  const exists = database.prepare(`
    SELECT 1 FROM pins
    WHERE principal_id = :principal AND target_id = :target AND operation_id = :operation`);
  const remove = database.prepare(`
    DELETE FROM pins
    WHERE principal_id = :principal AND target_id = :target AND operation_id = :operation`);

  return Object.freeze({
    list(principalId: string, targetId: string): readonly Pin[] {
      return Object.freeze(list.all({ principal: principalId, target: targetId }).map((row) => Object.freeze({
        operationId: String(row.operation_id),
        pinnedAt: String(row.pinned_at),
      })));
    },
    pin(principalId: string, targetId: string, operationId: string, at: Date): PinResult {
      const key = { principal: principalId, target: targetId, operation: operationId };
      const inserted = insert.run({ ...key, pinnedAt: at.toISOString(), limit: PIN_LIMIT });
      if (Number(inserted.changes) > 0) return PINNED;
      // Nothing inserted: either it was already pinned (keep its pinnedAt) or the limit is reached.
      return exists.get(key) === undefined ? LIMIT_REACHED : PINNED;
    },
    unpin(principalId: string, targetId: string, operationId: string): void {
      remove.run({ principal: principalId, target: targetId, operation: operationId });
    },
  });
}
