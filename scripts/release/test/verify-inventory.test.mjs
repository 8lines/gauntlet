import assert from "node:assert/strict";
import test from "node:test";

import {
  parseVerifyInventoryArguments,
  runVerifyInventoryCli,
} from "../verify-inventory.mjs";

const RELEASE_ROOT = "/workspace/gauntlet/.artifacts/release/release-2026-10-03.1";

test("inventory verifier CLI accepts one release-set root and rejects every other shape", () => {
  assert.deepEqual(parseVerifyInventoryArguments(["--release-root", RELEASE_ROOT]), { releaseRoot: RELEASE_ROOT });
  assert.deepEqual(parseVerifyInventoryArguments(["--release-root", "/tmp/release/local-0123456789ab"]), {
    releaseRoot: "/tmp/release/local-0123456789ab",
  });
  for (const argv of [
    [],
    ["--release-root"],
    ["--release-root", "relative"],
    ["--release-root", "/"],
    ["--release-root", "/workspace/gauntlet/.artifacts/release/0.1.0"],
    ["--release-root", "/workspace/gauntlet/.artifacts/release/local-0123"],
    ["--release-root", "/workspace/gauntlet/.artifacts/release/release-2026-13-01.1"],
    ["--release-root", "/tmp/release"],
    ["--release-root", RELEASE_ROOT, "extra"],
    ["--help"],
    "",
  ]) assert.throws(() => parseVerifyInventoryArguments(argv), /Usage: verify-inventory\.mjs --release-root ABSOLUTE_PATH\/\.artifacts\/release\/<set-id>/u);
});

test("inventory verifier CLI emits one closed JSON line and sanitizes failures", async () => {
  const seen = [];
  const success = await runVerifyInventoryCli(["--release-root", RELEASE_ROOT], {
    verifier: (releaseRoot) => {
      seen.push(releaseRoot);
      return Object.freeze({ schemaVersion: 2, ok: true, releaseSet: "release-2026-10-03.1", artifacts: 8 });
    },
  });
  assert.deepEqual(seen, [RELEASE_ROOT]);
  assert.deepEqual(success, {
    exitCode: 0,
    stdout: '{"schemaVersion":2,"ok":true,"releaseSet":"release-2026-10-03.1","artifacts":8}\n',
    stderr: "",
  });

  const failed = await runVerifyInventoryCli(
    ["--release-root", RELEASE_ROOT],
    { verifier: () => { throw new Error("private checksum mismatch"); } },
  );
  assert.deepEqual(failed, {
    exitCode: 1,
    stdout: "",
    stderr: '{"error":{"code":"INVENTORY_INVALID","message":"Staged release inventory verification failed safely"},"ok":false}\n',
  });
  assert.doesNotMatch(JSON.stringify(failed), /private checksum mismatch/u);

  const invalid = await runVerifyInventoryCli(["--release-root", "/workspace/gauntlet/.artifacts/release/0.1.0"]);
  assert.equal(invalid.exitCode, 2);
  assert.match(invalid.stderr, /<set-id>/u);
});
