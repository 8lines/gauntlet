#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { executeConformanceCli } from "./cli.js";

async function envMain(): Promise<void> {
  if (process.argv.length !== 2) {
    process.stderr.write("Environment conformance runner accepts no arguments\n");
    process.exitCode = 2;
    return;
  }
  const baseUrl = process.env.GAUNTLET_ADAPTER_URL;
  if (baseUrl === undefined || baseUrl.length === 0) {
    process.stderr.write("Missing GAUNTLET_ADAPTER_URL\n");
    process.exitCode = 2;
    return;
  }
  const scenarioPath = process.env.GAUNTLET_SCENARIO;
  if (scenarioPath === undefined || scenarioPath.length === 0) {
    process.stderr.write("Missing GAUNTLET_SCENARIO\n");
    process.exitCode = 2;
    return;
  }
  const outcome = await executeConformanceCli(baseUrl, scenarioPath);
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
if (isMain) void envMain();
