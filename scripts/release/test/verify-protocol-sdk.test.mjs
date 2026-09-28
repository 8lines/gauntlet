import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  planProtocolSdkVerification,
  runProtocolSdkVerification,
} from "../verify-protocol-sdk.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../verify-protocol-sdk.mjs", import.meta.url));
const EXPECTED_COMMANDS = [
  { phase: "build", command: "pnpm", args: ["build"] },
  { phase: "typecheck", command: "pnpm", args: ["typecheck"] },
  { phase: "test", command: "pnpm", args: ["test"] },
  { phase: "pack", command: "pnpm", args: ["test:packages"] },
];

function successfulChild() {
  return { error: undefined, signal: null, status: 0 };
}

test("the CI flag runs every Task 19 protocol/Node phase in exact order without a shell", () => {
  const calls = [];
  const result = runProtocolSdkVerification(["--node-only"], {
    root: REPOSITORY_ROOT,
    runner(command, args, options) {
      calls.push({ command, args, options });
      return successfulChild();
    },
  });

  assert.deepEqual(
    calls.map(({ command, args }) => ({ command, args })),
    EXPECTED_COMMANDS.map(({ command, args }) => ({ command, args })),
  );
  for (const call of calls) {
    assert.equal(call.options.cwd, REPOSITORY_ROOT);
    assert.equal(call.options.env, process.env);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.stdio, "inherit");
    assert.equal(call.options.windowsHide, true);
  }
  assert.deepEqual(result, { exitCode: 0, ok: true });
});

test("no-argument invocation remains the same Node-only gate", () => {
  assert.deepEqual(planProtocolSdkVerification([]), EXPECTED_COMMANDS);
  assert.deepEqual(planProtocolSdkVerification(["--node-only"]), EXPECTED_COMMANDS);
});

test("a failed phase stops later commands and preserves its numeric status", () => {
  const phases = [];
  const result = runProtocolSdkVerification([], {
    root: REPOSITORY_ROOT,
    runner(_command, args) {
      phases.push(args[0]);
      return args[0] === "typecheck"
        ? { error: undefined, signal: null, status: 7 }
        : successfulChild();
    },
  });

  assert.deepEqual(phases, ["build", "typecheck"]);
  assert.deepEqual(result, {
    code: "PHASE_FAILED",
    exitCode: 7,
    ok: false,
    phase: "typecheck",
  });
});

test("execution anomalies fail closed before the next phase", async (t) => {
  const cases = [
    ["spawn error", () => ({ error: new Error("sensitive detail"), signal: null, status: null })],
    ["signal", () => ({ error: undefined, signal: "SIGTERM", status: null })],
    ["malformed result", () => undefined],
    ["thrown exception", () => { throw new Error("sensitive detail"); }],
  ];

  for (const [name, runner] of cases) {
    await t.test(name, () => {
      let calls = 0;
      const result = runProtocolSdkVerification([], {
        root: REPOSITORY_ROOT,
        runner(...args) {
          calls += 1;
          return runner(...args);
        },
      });

      assert.equal(calls, 1);
      assert.deepEqual(result, {
        code: "EXECUTION_FAILED",
        exitCode: 1,
        ok: false,
        phase: "build",
      });
      assert.doesNotMatch(JSON.stringify(result), /sensitive detail/);
    });
  }
});

test("unsupported and duplicate arguments fail before running commands", () => {
  for (const argv of [["--all"], ["--node-only", "--node-only"]]) {
    let called = false;
    const result = runProtocolSdkVerification(argv, {
      root: REPOSITORY_ROOT,
      runner() {
        called = true;
        return successfulChild();
      },
    });

    assert.equal(called, false);
    assert.deepEqual(result, {
      code: "INVALID_ARGUMENTS",
      exitCode: 2,
      ok: false,
      phase: null,
    });
  }
});

test("the standalone CLI documents the language boundary and rejects unsupported flags", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "--all"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    env: process.env,
    shell: false,
    windowsHide: true,
  });

  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /--node-only/);
  assert.match(result.stderr, /protocol and Node\/TypeScript SDK/i);
  assert.match(result.stderr, /PHP and Java.*separate/i);
});
