#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { KUBECONFORM_IMAGE } from "../deploy/helm/kubeconform-support.mjs";
import { HELM_IMAGE } from "../deploy/helm/test-support.mjs";
import { LOCAL_REGISTRY_IMAGE } from "./release/dry-run.mjs";
import { MAVEN_TOOLCHAIN } from "./release/stage-maven.mjs";

export const CI_IMAGES = Object.freeze([
  Object.freeze({ image: HELM_IMAGE }),
  Object.freeze({ image: KUBECONFORM_IMAGE }),
  Object.freeze({ image: LOCAL_REGISTRY_IMAGE }),
  Object.freeze({ image: MAVEN_TOOLCHAIN.image, platform: MAVEN_TOOLCHAIN.platform }),
]);

export function pullArguments({ image, platform }) {
  return ["image", "pull", ...(platform === undefined ? [] : ["--platform", platform]), image];
}

function prepareCiImages(argv) {
  if (argv.length !== 2) {
    process.stderr.write("Usage: node scripts/prepare-ci-images.mjs\n");
    return 2;
  }
  for (const entry of CI_IMAGES) {
    const result = spawnSync("docker", pullArguments(entry), {
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    if (result.error !== undefined || result.signal !== null || result.status !== 0) {
      process.stderr.write("Failed to preload a pinned CI image\n");
      return 1;
    }
  }
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = prepareCiImages(process.argv);
}
