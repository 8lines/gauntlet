import assert from "node:assert/strict";
import { test } from "node:test";
import type { Problem, Run } from "@8lines/gauntlet-protocol";
import { nextRecentRunState } from "../src/recent-run-state.ts";

const run = (state: Run["state"]) => ({ id: "r1", state }) as unknown as Run;
const failure = (status: number): { ok: false; problem: Problem } => ({
  ok: false,
  problem: { type: "urn:gauntlet:problem:x", title: "Failed", status },
});

test("an unfinished run is shown and polled again", () => {
  const next = nextRecentRunState(undefined, { ok: true, data: run("running") });
  assert.deepEqual(next, { entry: { run: run("running"), missing: false }, keepPolling: true });
});

test("a finished run is shown and no longer polled", () => {
  const next = nextRecentRunState({ run: run("running"), missing: false }, { ok: true, data: run("succeeded") });
  assert.deepEqual(next, { entry: { run: run("succeeded"), missing: false }, keepPolling: false });
});

test("a 404 marks the run missing and stops polling", () => {
  const next = nextRecentRunState({ run: run("running"), missing: false }, failure(404));
  assert.deepEqual(next, { entry: { missing: true }, keepPolling: false });
});

test("another failure keeps the last known run and keeps polling", () => {
  const previous = { run: run("running"), missing: false };
  assert.deepEqual(nextRecentRunState(previous, failure(503)), { entry: previous, keepPolling: true });
  assert.deepEqual(nextRecentRunState(previous, failure(0)), { entry: previous, keepPolling: true });
});

test("a first load failing with another error shows nothing yet and keeps polling", () => {
  assert.deepEqual(nextRecentRunState(undefined, failure(500)), { entry: { missing: false }, keepPolling: true });
});
