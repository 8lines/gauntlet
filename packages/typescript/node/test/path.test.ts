import assert from "node:assert/strict";
import test from "node:test";
import { isAdapterTarget, parseAdapterPath } from "../src/path.js";

test("accepts safe protocol IDs and rejects non-protocol dynamic IDs", () => {
  assert.deepEqual(parseAdapterPath("/_gauntlet/v1/operations/applications.finalize/runs"), ["operations", "applications.finalize", "runs"]);
  assert.equal(parseAdapterPath("/_gauntlet/v1/operations/bad$id/runs"), undefined);
  assert.equal(parseAdapterPath("/_gauntlet/v1/operations/a/b/runs"), undefined);
});

test("adapter ownership detects lossy and absolute-form equivalents without matching lookalikes", () => {
  for (const target of [
    "/_gauntlet/v1/health",
    "/%5Fgauntlet/v1/health",
    "/%2525255Fgauntlet/v1/health",
    "/%25%35%46gauntlet/v1/health",
    "/ordinary/../_gauntlet/v1/health",
    "http://attacker.invalid/_gauntlet/v1/health",
    "http://attacker.invalid/_g%61untlet/v1/health",
    "http://attacker.invalid\\_gauntlet\\v1\\health",
    "http:////attacker.invalid/_gauntlet/v1/health",
  ]) {
    assert.equal(isAdapterTarget(target), true, target);
  }
  for (const target of [
    "/ordinary/health",
    "/_gauntletish/v1/health",
    "http://attacker.invalid/ordinary/health",
  ]) {
    assert.equal(isAdapterTarget(target), false, target);
  }
});
