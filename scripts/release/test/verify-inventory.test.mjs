import assert from "node:assert/strict";
import test from "node:test";

import {
  parseVerifyInventoryArguments,
  runVerifyInventoryCli,
} from "../verify-inventory.mjs";

test("inventory verifier CLI accepts one release root and rejects every other shape", () => {
  assert.deepEqual(parseVerifyInventoryArguments(["--release-root", "/workspace/gauntlet/.artifacts/release/0.1.0"]), {
    releaseRoot: "/workspace/gauntlet/.artifacts/release/0.1.0",
  });
  for (const argv of [
    [],
    ["--release-root"],
    ["--release-root", "relative"],
    ["--release-root", "/"],
    ["--release-root", "/tmp/release", "extra"],
    ["--help"],
    "",
  ]) assert.throws(() => parseVerifyInventoryArguments(argv), /Usage: verify-inventory\.mjs/u);
});

test("inventory verifier CLI emits one closed JSON line and sanitizes failures", async () => {
  const success = await runVerifyInventoryCli(
    ["--release-root", "/workspace/gauntlet/.artifacts/release/0.1.0"],
    {
      verifier: () => Object.freeze({ schemaVersion: 1, ok: true, artifacts: 19 }),
    },
  );
  assert.deepEqual(success, {
    exitCode: 0,
    stdout: '{"schemaVersion":1,"ok":true,"artifacts":19}\n',
    stderr: "",
  });

  const failed = await runVerifyInventoryCli(
    ["--release-root", "/workspace/gauntlet/.artifacts/release/0.1.0"],
    { verifier: () => { throw new Error("private checksum mismatch"); } },
  );
  assert.deepEqual(failed, {
    exitCode: 1,
    stdout: "",
    stderr: '{"error":{"code":"INVENTORY_INVALID","message":"Staged release inventory verification failed safely"},"ok":false}\n',
  });
  assert.doesNotMatch(JSON.stringify(failed), /private checksum mismatch/u);
});
