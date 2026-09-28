#!/usr/bin/env node

import { isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { types as utilTypes } from "node:util";

import { verifyStagedReleaseInventory } from "./inventory.mjs";

const USAGE = "Usage: verify-inventory.mjs --release-root ABSOLUTE_PATH";
const FAILURE = "Staged release inventory verification failed safely";

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

export function parseVerifyInventoryArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== "--release-root"
      || typeof argv[1] !== "string" || !isAbsolute(argv[1]) || resolve(argv[1]) !== argv[1]
      || argv[1] === sep || argv[1].includes("\0")) throw new TypeError(USAGE);
  return { releaseRoot: argv[1] };
}

function cliOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options) || utilTypes.isProxy(options)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) throw new TypeError();
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => key !== "verifier" || descriptors[key].enumerable !== true || !("value" in descriptors[key]))) {
    throw new TypeError();
  }
  const verifier = descriptors.verifier?.value ?? verifyStagedReleaseInventory;
  if (typeof verifier !== "function") throw new TypeError();
  return verifier;
}

export async function runVerifyInventoryCli(argv, options = {}) {
  let releaseRoot;
  let verifier;
  try {
    ({ releaseRoot } = parseVerifyInventoryArguments(argv));
    verifier = cliOptions(options);
  } catch {
    return {
      exitCode: 2,
      stdout: "",
      stderr: jsonLine({ error: { code: "INVALID_ARGUMENTS", message: USAGE }, ok: false }),
    };
  }
  try {
    const report = await verifier(releaseRoot);
    return { exitCode: 0, stdout: jsonLine(report), stderr: "" };
  } catch {
    return {
      exitCode: 1,
      stdout: "",
      stderr: jsonLine({ error: { code: "INVENTORY_INVALID", message: FAILURE }, ok: false }),
    };
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runVerifyInventoryCli(process.argv.slice(2));
  if (result.stdout !== "") process.stdout.write(result.stdout);
  if (result.stderr !== "") process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
