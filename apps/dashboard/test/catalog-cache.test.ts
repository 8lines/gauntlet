import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OperationDefinition, OperationSummary } from "@8lines/gauntlet-protocol";
import type { TargetSnapshot } from "../src/api.ts";
import {
  CATALOG_CACHE_KEY,
  clearCatalogCache,
  readCachedDefinitions,
  readCachedSnapshot,
  rememberDefinition,
  rememberSnapshot,
} from "../src/catalog-cache.ts";
import type { StorageLike } from "../src/recent-runs.ts";

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { readonly data: Record<string, string> } {
  const data: Record<string, string> = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key]! : null),
    setItem: (key, value) => { data[key] = value; },
  };
}

function summary(id: string, revision: string): OperationSummary {
  return { id, revision, label: id, featureId: "feature", availability: { state: "available" } };
}

function snapshot(targetId: string, operations: readonly OperationSummary[]): TargetSnapshot {
  return {
    id: targetId,
    label: targetId,
    tags: [],
    state: "online",
    refreshedAt: "2026-10-07T10:00:00.000Z",
    manifest: { operations } as unknown as TargetSnapshot["manifest"],
  };
}

function definition(id: string, revision: string): OperationDefinition {
  return { id, revision, label: id, featureId: "feature", execution: { impact: "read" } } as unknown as OperationDefinition;
}

describe("catalog cache", () => {
  it("reads nothing from empty or malformed storage", () => {
    assert.equal(readCachedSnapshot(memoryStorage(), "portal"), undefined);
    assert.equal(readCachedSnapshot(memoryStorage({ [CATALOG_CACHE_KEY]: "{not json" }), "portal"), undefined);
    assert.equal(readCachedSnapshot(memoryStorage({ [CATALOG_CACHE_KEY]: "[]" }), "portal"), undefined);
    assert.deepEqual(readCachedDefinitions(memoryStorage({ [CATALOG_CACHE_KEY]: "42" }), "portal", [summary("a", "r1")]), {});
  });

  it("returns the remembered snapshot of each target", () => {
    const storage = memoryStorage();
    rememberSnapshot(storage, snapshot("portal", [summary("a", "r1")]));
    rememberSnapshot(storage, snapshot("admin", []));
    assert.equal(readCachedSnapshot(storage, "portal")?.manifest?.operations[0]?.id, "a");
    assert.equal(readCachedSnapshot(storage, "admin")?.id, "admin");
    assert.equal(readCachedSnapshot(storage, "other"), undefined);
  });

  it("reuses a definition only while its revision matches the manifest", () => {
    const storage = memoryStorage();
    rememberDefinition(storage, "portal", definition("a", "r1"));
    rememberDefinition(storage, "portal", definition("b", "r1"));
    const cached = readCachedDefinitions(storage, "portal", [summary("a", "r1"), summary("b", "r2"), summary("c", "r1")]);
    assert.deepEqual(Object.keys(cached), ["a"]);
    assert.deepEqual(readCachedDefinitions(storage, "admin", [summary("a", "r1")]), {});
  });

  it("forgets definitions of operations a new snapshot no longer lists", () => {
    const storage = memoryStorage();
    rememberDefinition(storage, "portal", definition("a", "r1"));
    rememberDefinition(storage, "portal", definition("b", "r1"));
    rememberSnapshot(storage, snapshot("portal", [summary("b", "r1")]));
    assert.deepEqual(Object.keys(readCachedDefinitions(storage, "portal", [summary("a", "r1"), summary("b", "r1")])), ["b"]);
  });

  it("drops entries whose shape does not match their key", () => {
    const storage = memoryStorage({
      [CATALOG_CACHE_KEY]: JSON.stringify({
        portal: { snapshot: { id: "admin", label: "Admin" }, definitions: { a: definition("b", "r1"), c: "nope" } },
      }),
    });
    assert.equal(readCachedSnapshot(storage, "portal"), undefined);
    assert.deepEqual(readCachedDefinitions(storage, "portal", [summary("a", "r1"), summary("b", "r1"), summary("c", "r1")]), {});
  });

  it("clears every target on sign out", () => {
    const storage = memoryStorage();
    rememberSnapshot(storage, snapshot("portal", [summary("a", "r1")]));
    rememberDefinition(storage, "portal", definition("a", "r1"));
    clearCatalogCache(storage);
    assert.equal(readCachedSnapshot(storage, "portal"), undefined);
    assert.deepEqual(readCachedDefinitions(storage, "portal", [summary("a", "r1")]), {});
  });

  it("ignores storage that refuses writes", () => {
    const storage: StorageLike = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
    assert.doesNotThrow(() => rememberSnapshot(storage, snapshot("portal", [])));
    assert.doesNotThrow(() => rememberDefinition(storage, "portal", definition("a", "r1")));
    assert.doesNotThrow(() => clearCatalogCache(storage));
  });
});
