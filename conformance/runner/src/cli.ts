#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  redactKnownSecrets,
  runAdapterV1Conformance,
} from "./adapter-v1-runner.js";
import { ConfigurationError } from "./http-client.js";
import { loadAdapterV1Scenario } from "./scenario.js";

export const RUNNER_USAGE = "Usage: gauntlet-conformance --base-url ABSOLUTE_HTTP_ORIGIN --scenario PATH";

interface RunnerArguments {
  readonly baseUrl: string;
  readonly scenarioPath: string;
}

export interface CliOutcome {
  readonly exitCode: 0 | 1 | 2;
  readonly stderr: string;
}

function parseArguments(arguments_: readonly string[]): RunnerArguments {
  if (arguments_.length !== 4) throw new TypeError("usage");
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (flag === undefined
      || value === undefined
      || flag.includes("=")
      || !["--base-url", "--scenario"].includes(flag)
      || values.has(flag)
      || value.startsWith("--")) {
      throw new TypeError("usage");
    }
    values.set(flag, value);
  }
  const baseUrl = values.get("--base-url");
  const scenarioPath = values.get("--scenario");
  if (baseUrl === undefined || scenarioPath === undefined || baseUrl.length === 0 || scenarioPath.length === 0) {
    throw new TypeError("usage");
  }
  return { baseUrl, scenarioPath };
}

function oneSafeLine(value: string, secrets: readonly string[]): string {
  const redacted = redactKnownSecrets(value, secrets).replace(/[\r\n]+/g, " ").trim();
  return `${(redacted.length === 0 ? "Adapter conformance failed" : redacted).slice(0, 8_192)}\n`;
}

export async function executeConformanceCli(baseUrl: string, scenarioPath: string): Promise<CliOutcome> {
  let scenario;
  try {
    scenario = await loadAdapterV1Scenario(scenarioPath);
  } catch {
    return { exitCode: 2, stderr: "Conformance configuration failed\n" };
  }
  const secret = typeof scenario.input.confirmationCode === "string" ? scenario.input.confirmationCode : "";
  try {
    await runAdapterV1Conformance({ baseUrl, scenario });
    return { exitCode: 0, stderr: "" };
  } catch (error) {
    if (error instanceof ConfigurationError) {
      return { exitCode: 2, stderr: "Conformance configuration failed\n" };
    }
    const message = error instanceof Error ? error.message : "Adapter conformance failed";
    return { exitCode: 1, stderr: oneSafeLine(message, [secret]) };
  }
}

async function cliMain(): Promise<void> {
  let arguments_: RunnerArguments;
  try {
    arguments_ = parseArguments(process.argv.slice(2));
  } catch {
    process.stderr.write(`${RUNNER_USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  const outcome = await executeConformanceCli(arguments_.baseUrl, arguments_.scenarioPath);
  if (outcome.stderr !== "") process.stderr.write(outcome.stderr);
  process.exitCode = outcome.exitCode;
}

const isMain = (() => {
  try {
    return process.argv[1] !== undefined
      && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) void cliMain();
