/**
 * The panel's "recent runs" list, persisted in `localStorage`. See
 * docs/superpowers/specs/2026-09-25-embeddable-widget-design.md, "Recent
 * runs": at most `MAX_RECENT_RUNS` entries, newest first, de-duplicated by
 * `targetId`+`runId`. Storage content is untrusted (another tab, a stale
 * schema, manual tampering) so it is read defensively; a run whose
 * `GET …/runs/{id}` later 404s is a display concern for the caller, not this
 * module.
 */

export interface RecentRun {
  readonly targetId: string;
  readonly operationId: string;
  readonly label: string;
  readonly runId: string;
  readonly startedAt: string;
}

export const RECENT_RUNS_KEY = "gauntlet.widget.recent.v1";
export const MAX_RECENT_RUNS = 20;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function isRecentRun(value: unknown): value is RecentRun {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.targetId === "string" &&
    typeof record.operationId === "string" &&
    typeof record.label === "string" &&
    typeof record.runId === "string" &&
    typeof record.startedAt === "string"
  );
}

/** Malformed storage content (bad JSON, a non-array, bad entries) reads as `[]` / drops the offending entries. */
export function readRecentRuns(storage: StorageLike): readonly RecentRun[] {
  const raw = storage.getItem(RECENT_RUNS_KEY);
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isRecentRun);
}

/** Records a run, newest first, de-duplicated by `targetId`+`runId`, trimmed to `MAX_RECENT_RUNS`. */
export function rememberRun(storage: StorageLike, run: RecentRun): readonly RecentRun[] {
  const withoutDuplicate = readRecentRuns(storage).filter(
    (existing) => !(existing.targetId === run.targetId && existing.runId === run.runId),
  );
  const next = [run, ...withoutDuplicate].slice(0, MAX_RECENT_RUNS);
  try {
    storage.setItem(RECENT_RUNS_KEY, JSON.stringify(next));
  } catch {
    // A full/blocked storage (quota, privacy mode) must not break the caller;
    // it simply won't persist across reloads.
  }
  return next;
}
