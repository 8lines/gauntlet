import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_RECENT_RUNS, RECENT_RUNS_KEY, readRecentRuns, rememberRun, type RecentRun, type StorageLike } from "../src/widget/recent-runs.ts";

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { readonly data: Record<string, string> } {
  const data: Record<string, string> = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key]! : null),
    setItem: (key, value) => { data[key] = value; },
  };
}

function run(overrides: Partial<RecentRun> = {}): RecentRun {
  return {
    targetId: "portal",
    operationId: "op-1",
    label: "Operation",
    runId: "run-1",
    startedAt: "2026-09-26T10:00:00.000Z",
    ...overrides,
  };
}

describe("readRecentRuns", () => {
  it("returns an empty list when storage is empty", () => {
    assert.deepEqual(readRecentRuns(memoryStorage()), []);
  });

  it("treats malformed JSON as empty", () => {
    const storage = memoryStorage({ [RECENT_RUNS_KEY]: "{not json" });
    assert.deepEqual(readRecentRuns(storage), []);
  });

  it("treats a non-array value as empty", () => {
    const storage = memoryStorage({ [RECENT_RUNS_KEY]: JSON.stringify({ not: "an array" }) });
    assert.deepEqual(readRecentRuns(storage), []);
  });

  it("drops bad entries from an array but keeps good ones", () => {
    const good = run();
    const storage = memoryStorage({
      [RECENT_RUNS_KEY]: JSON.stringify([good, { targetId: "portal" }, "not an object", null, 42]),
    });
    assert.deepEqual(readRecentRuns(storage), [good]);
  });
});

describe("rememberRun", () => {
  it("puts the newest run first", () => {
    const storage = memoryStorage();
    rememberRun(storage, run({ runId: "run-1" }));
    const result = rememberRun(storage, run({ runId: "run-2" }));
    assert.deepEqual(result.map((r) => r.runId), ["run-2", "run-1"]);
  });

  it("moves a duplicate targetId+runId to the top instead of duplicating it", () => {
    const storage = memoryStorage();
    rememberRun(storage, run({ runId: "run-1", label: "First" }));
    rememberRun(storage, run({ runId: "run-2" }));
    const result = rememberRun(storage, run({ runId: "run-1", label: "Updated" }));
    assert.deepEqual(result.map((r) => r.runId), ["run-1", "run-2"]);
    assert.equal(result[0]!.label, "Updated");
  });

  it("does not treat the same runId under a different targetId as a duplicate", () => {
    const storage = memoryStorage();
    rememberRun(storage, run({ targetId: "portal", runId: "run-1" }));
    const result = rememberRun(storage, run({ targetId: "billing", runId: "run-1" }));
    assert.equal(result.length, 2);
  });

  it("trims the list to MAX_RECENT_RUNS entries", () => {
    const storage = memoryStorage();
    let result: readonly RecentRun[] = [];
    for (let i = 0; i < MAX_RECENT_RUNS + 5; i += 1) {
      result = rememberRun(storage, run({ runId: `run-${i}` }));
    }
    assert.equal(result.length, MAX_RECENT_RUNS);
    assert.equal(result[0]!.runId, `run-${MAX_RECENT_RUNS + 4}`);
  });

  it("does not throw when setItem throws (quota exceeded)", () => {
    const storage: StorageLike = {
      getItem: () => null,
      setItem: () => { throw new DOMException("quota exceeded"); },
    };
    assert.doesNotThrow(() => rememberRun(storage, run()));
  });
});
