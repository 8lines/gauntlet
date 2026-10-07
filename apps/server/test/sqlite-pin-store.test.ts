import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../src/database.js";
import { PIN_LIMIT, type PinStore } from "../src/pin-store.js";
import { createSqlitePinStore } from "../src/sqlite-pin-store.js";

function at(minute: number): Date {
  return new Date(Date.UTC(2026, 9, 7, 10, minute));
}

function usingStore(action: (store: PinStore) => void): void {
  const database = openDatabase();
  try {
    action(createSqlitePinStore(database));
  } finally {
    database.close();
  }
}

test("pins are listed oldest first", () => {
  usingStore((store) => {
    assert.deepEqual(store.list("shared", "acme"), []);
    assert.deepEqual(store.pin("shared", "acme", "zeta", at(1)), { ok: true });
    assert.deepEqual(store.pin("shared", "acme", "alpha", at(2)), { ok: true });
    assert.deepEqual(store.pin("shared", "acme", "mid", at(3)), { ok: true });
    assert.deepEqual(store.list("shared", "acme"), [
      { operationId: "zeta", pinnedAt: "2026-10-07T10:01:00.000Z" },
      { operationId: "alpha", pinnedAt: "2026-10-07T10:02:00.000Z" },
      { operationId: "mid", pinnedAt: "2026-10-07T10:03:00.000Z" },
    ]);
    const listed = store.list("shared", "acme");
    assert.equal(Object.isFrozen(listed), true);
    assert.equal(Object.isFrozen(listed[0]), true);
  });
});

test("pinning an already pinned operation keeps its original pinnedAt", () => {
  usingStore((store) => {
    store.pin("shared", "acme", "first", at(1));
    store.pin("shared", "acme", "second", at(2));
    assert.deepEqual(store.pin("shared", "acme", "first", at(9)), { ok: true });
    assert.deepEqual(store.list("shared", "acme"), [
      { operationId: "first", pinnedAt: "2026-10-07T10:01:00.000Z" },
      { operationId: "second", pinnedAt: "2026-10-07T10:02:00.000Z" },
    ]);
  });
});

test("unpinning removes the pin and does nothing for an operation that is not pinned", () => {
  usingStore((store) => {
    store.pin("shared", "acme", "first", at(1));
    store.pin("shared", "acme", "second", at(2));
    store.unpin("shared", "acme", "first");
    store.unpin("shared", "acme", "first");
    store.unpin("shared", "acme", "never");
    assert.deepEqual(store.list("shared", "acme"), [{ operationId: "second", pinnedAt: "2026-10-07T10:02:00.000Z" }]);
    store.pin("shared", "acme", "first", at(5));
    assert.deepEqual(store.list("shared", "acme").map(({ operationId }) => operationId), ["second", "first"]);
  });
});

test("a principal holds at most 100 pins per target", () => {
  assert.equal(PIN_LIMIT, 100);
  usingStore((store) => {
    for (let index = 0; index < PIN_LIMIT; index += 1) {
      assert.deepEqual(store.pin("shared", "acme", `operation-${index}`, at(0)), { ok: true });
    }
    assert.deepEqual(store.pin("shared", "acme", "one-too-many", at(1)), { ok: false, reason: "limit" });
    assert.equal(store.list("shared", "acme").length, PIN_LIMIT);
    // Re-pinning at the limit is still idempotent, and other principals and targets have their own limit.
    assert.deepEqual(store.pin("shared", "acme", "operation-0", at(1)), { ok: true });
    assert.deepEqual(store.pin("shared", "other", "one-too-many", at(1)), { ok: true });
    assert.deepEqual(store.pin("user:anna", "acme", "one-too-many", at(1)), { ok: true });
    store.unpin("shared", "acme", "operation-7");
    assert.deepEqual(store.pin("shared", "acme", "one-too-many", at(1)), { ok: true });
  });
});

test("pins are isolated by principal and by target", () => {
  usingStore((store) => {
    store.pin("user:anna", "acme", "reset-password", at(1));
    store.pin("user:ben", "acme", "seed-orders", at(2));
    store.pin("user:anna", "billing", "seed-orders", at(3));
    assert.deepEqual(store.list("user:anna", "acme").map(({ operationId }) => operationId), ["reset-password"]);
    assert.deepEqual(store.list("user:ben", "acme").map(({ operationId }) => operationId), ["seed-orders"]);
    assert.deepEqual(store.list("user:anna", "billing").map(({ operationId }) => operationId), ["seed-orders"]);
    assert.deepEqual(store.list("user:ben", "billing"), []);
    store.unpin("user:anna", "billing", "seed-orders");
    assert.deepEqual(store.list("user:ben", "acme").map(({ operationId }) => operationId), ["seed-orders"]);
  });
});
