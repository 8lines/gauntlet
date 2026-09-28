#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { redactKnownSecrets } from "./adapter-v1-runner.js";
import {
  runAdapterV1ExtendedConformance,
  type AdapterV1ExtendedConformanceOptions,
} from "./extended-runner.js";
import { ConfigurationError } from "./http-client.js";
import { loadAdapterV1ExtendedScenario } from "./extended-scenario.js";

export const EXTENDED_RUNNER_USAGE = "Usage: gauntlet-conformance-extended"
  + " --enabled-base-url ABSOLUTE_HTTP_ORIGIN"
  + " --disabled-base-url ABSOLUTE_HTTP_ORIGIN"
  + " --scenario PATH";

interface ExtendedRunnerArguments {
  readonly enabledBaseUrl: string;
  readonly disabledBaseUrl: string;
  readonly scenarioPath: string;
}

export interface ExtendedCliOutcome {
  readonly exitCode: 0 | 1 | 2;
  readonly stderr: string;
}

function parseArguments(arguments_: readonly string[]): ExtendedRunnerArguments {
  if (arguments_.length !== 6) throw new TypeError("usage");
  const allowed = new Set(["--enabled-base-url", "--disabled-base-url", "--scenario"]);
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (flag === undefined
      || value === undefined
      || flag.includes("=")
      || !allowed.has(flag)
      || values.has(flag)
      || value.startsWith("--")
      || value.length === 0) {
      throw new TypeError("usage");
    }
    values.set(flag, value);
  }
  const enabledBaseUrl = values.get("--enabled-base-url");
  const disabledBaseUrl = values.get("--disabled-base-url");
  const scenarioPath = values.get("--scenario");
  if (enabledBaseUrl === undefined || disabledBaseUrl === undefined || scenarioPath === undefined) {
    throw new TypeError("usage");
  }
  return { enabledBaseUrl, disabledBaseUrl, scenarioPath };
}

function safeLine(value: string, secrets: readonly string[]): string {
  const redacted = redactKnownSecrets(value, secrets).replace(/[\r\n]+/g, " ").trim();
  return `${(redacted.length === 0 ? "Extended adapter conformance failed" : redacted).slice(0, 8_192)}\n`;
}

export async function executeExtendedConformanceCli(
  enabledBaseUrl: string,
  disabledBaseUrl: string,
  scenarioPath: string | URL,
  runnerOptions: Pick<AdapterV1ExtendedConformanceOptions, "pollIntervalMs"> = {},
): Promise<ExtendedCliOutcome> {
  let scenario;
  try {
    scenario = await loadAdapterV1ExtendedScenario(scenarioPath);
  } catch {
    return { exitCode: 2, stderr: "Extended conformance configuration failed\n" };
  }
  try {
    await runAdapterV1ExtendedConformance({
      enabledBaseUrl,
      disabledBaseUrl,
      scenario,
      ...runnerOptions,
    });
    return { exitCode: 0, stderr: "" };
  } catch (error) {
    if (error instanceof ConfigurationError) {
      return { exitCode: 2, stderr: "Extended conformance configuration failed\n" };
    }
    const message = error instanceof Error ? error.message : "Extended adapter conformance failed";
    return { exitCode: 1, stderr: safeLine(message, scenario.secretSentinels) };
  }
}

async function cliMain(): Promise<void> {
  let arguments_: ExtendedRunnerArguments;
  try {
    arguments_ = parseArguments(process.argv.slice(2));
  } catch {
    process.stderr.write(`${EXTENDED_RUNNER_USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  const outcome = await executeExtendedConformanceCli(
    arguments_.enabledBaseUrl,
    arguments_.disabledBaseUrl,
    arguments_.scenarioPath,
  );
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
