import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const USAGE = "Usage: node scripts/release/verify-protocol-sdk.mjs [--node-only]";
const NODE_ONLY_NOTICE = [
  "verify:protocol-sdk covers only the protocol and Node/TypeScript SDK build, typecheck, tests,",
  "and packed-consumer checks (including conformance); PHP and Java run in separate release gates.",
].join(" ");
const COMMANDS = Object.freeze([
  Object.freeze({ phase: "build", command: "pnpm", args: Object.freeze(["build"]) }),
  Object.freeze({ phase: "typecheck", command: "pnpm", args: Object.freeze(["typecheck"]) }),
  Object.freeze({ phase: "test", command: "pnpm", args: Object.freeze(["test"]) }),
  Object.freeze({ phase: "pack", command: "pnpm", args: Object.freeze(["test:packages"]) }),
]);

function invalidArguments() {
  throw new TypeError("Invalid verify:protocol-sdk arguments");
}

export function planProtocolSdkVerification(argv) {
  if (!Array.isArray(argv)
      || (argv.length !== 0 && (argv.length !== 1 || argv[0] !== "--node-only"))) {
    invalidArguments();
  }

  return COMMANDS.map(({ phase, command, args }) => ({
    phase,
    command,
    args: [...args],
  }));
}

function executionFailure(phase) {
  return {
    code: "EXECUTION_FAILED",
    exitCode: 1,
    ok: false,
    phase,
  };
}

export function runProtocolSdkVerification(
  argv,
  { root = REPOSITORY_ROOT, runner = spawnSync } = {},
) {
  let commands;
  try {
    commands = planProtocolSdkVerification(argv);
  } catch {
    return {
      code: "INVALID_ARGUMENTS",
      exitCode: 2,
      ok: false,
      phase: null,
    };
  }

  if (typeof root !== "string" || root.length === 0 || typeof runner !== "function") {
    return executionFailure(null);
  }

  for (const { phase, command, args } of commands) {
    try {
      const result = runner(command, args, {
        cwd: root,
        env: process.env,
        shell: false,
        stdio: "inherit",
        windowsHide: true,
      });
      if (result === null || typeof result !== "object"
          || result.error !== undefined || result.signal !== null
          || !Number.isInteger(result.status) || result.status < 0 || result.status > 255) {
        return executionFailure(phase);
      }
      if (result.status !== 0) {
        return {
          code: "PHASE_FAILED",
          exitCode: result.status,
          ok: false,
          phase,
        };
      }
    } catch {
      return executionFailure(phase);
    }
  }

  return { exitCode: 0, ok: true };
}

function reportFailure(result) {
  if (result.code === "INVALID_ARGUMENTS") {
    process.stderr.write(`${USAGE}\n${NODE_ONLY_NOTICE}\n`);
    return;
  }
  process.stderr.write(`verify:protocol-sdk failed closed in ${result.phase ?? "setup"}\n`);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  try {
    planProtocolSdkVerification(argv);
    process.stdout.write(`${NODE_ONLY_NOTICE}\n`);
  } catch {
    // The structured result below owns invalid-argument handling.
  }
  const result = runProtocolSdkVerification(argv);
  if (!result.ok) reportFailure(result);
  process.exitCode = result.exitCode;
}
