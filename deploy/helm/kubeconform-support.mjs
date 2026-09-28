import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { types as utilTypes } from "node:util";
import {
  parseLocalDockerEndpoint,
  repositoryRoot,
  sanitizedHelmEnvironment,
} from "./test-support.mjs";
import { parseDocument } from "yaml";

export const KUBECONFORM_IMAGE = "ghcr.io/yannh/kubeconform:v0.8.0@sha256:faffaf43f95aa6425306e1ab8d6fcad72acb9049158f38e574c085ea1ec0f64e";
export const schemaRoot = join(repositoryRoot, "deploy", "helm", "schemas");

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const SAFE_ENVIRONMENT_KEYS = new Set([
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "PATH",
  "TERM",
  "TMPDIR",
]);
const SUPPORTED_KUBERNETES_VERSIONS = new Set(["1.35.0", "1.36.0", "1.37.0"]);
const RESULT_STATUSES = new Map([
  ["statusValid", "valid"],
  ["statusInvalid", "invalid"],
  ["statusError", "errors"],
  ["statusSkipped", "skipped"],
]);

function isPlainRecord(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && !utilTypes.isProxy(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function validateClosedObject(value, allowedKeys, label) {
  if (!isPlainRecord(value)) {
    throw new TypeError(`${label} must be a closed object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      throw new TypeError(`${label} must be a closed object`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
      throw new TypeError(`${label} must be a closed object`);
    }
  }
}

function captureEnvironmentRecord(value) {
  try {
    if (!isPlainRecord(value)) throw new Error();
    const captured = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || !SAFE_ENVIRONMENT_KEYS.has(key)) throw new Error();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || descriptor.enumerable !== true
          || !("value" in descriptor) || typeof descriptor.value !== "string") {
        throw new Error();
      }
      Object.defineProperty(captured, key, {
        configurable: false,
        enumerable: true,
        value: descriptor.value,
        writable: false,
      });
    }
    return Object.freeze(captured);
  } catch {
    throw new TypeError("Kubeconform runner dependencies are invalid");
  }
}

function validateKubernetesVersion(kubeVersion) {
  if (!SUPPORTED_KUBERNETES_VERSIONS.has(kubeVersion)) {
    throw new TypeError("Kubernetes version must be one maintained exact version");
  }
}

export function buildKubeconformDockerArgs(kubeVersion) {
  validateKubernetesVersion(kubeVersion);
  if (schemaRoot.includes(",") || schemaRoot.includes("\u0000")) {
    throw new Error("Vendored schema path is unsafe");
  }
  return [
    "run",
    "--rm",
    "--interactive",
    "--pull=never",
    "--network=none",
    "--read-only",
    "--user", "65534:65534",
    "--cap-drop=ALL",
    "--security-opt", "no-new-privileges",
    "--memory=256m",
    "--memory-swap=256m",
    "--cpus=1",
    "--pids-limit=128",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777,uid=65534,gid=65534",
    "--mount", `type=bind,src=${schemaRoot},dst=/schemas,readonly`,
    KUBECONFORM_IMAGE,
    "-strict",
    "-summary",
    "-verbose",
    "-n", "1",
    "-output", "json",
    "-kubernetes-version", kubeVersion,
    "-schema-location",
    "/schemas/{{.NormalizedKubernetesVersion}}-standalone-strict/{{.ResourceKind}}{{.KindSuffix}}.json",
    "-",
  ];
}

function validateBoundedString(value, maximumBytes) {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= maximumBytes;
}

export function parseKubeconformOutput(output) {
  try {
    if (!validateBoundedString(output, MAX_OUTPUT_BYTES) || output.length === 0) throw new Error();
    const result = JSON.parse(output);
    const syntax = parseDocument(output, {
      maxAliasCount: 0,
      prettyErrors: false,
      schema: "json",
      strict: true,
      uniqueKeys: true,
    });
    if (syntax.errors.length > 0 || syntax.warnings.length > 0) throw new Error();
    validateClosedObject(result, new Set(["resources", "summary"]), "result");
    if (!Array.isArray(result.resources) || result.resources.length > 1024) throw new Error();
    validateClosedObject(
      result.summary,
      new Set(["valid", "invalid", "errors", "skipped"]),
      "summary",
    );
    const expectedCounts = { valid: 0, invalid: 0, errors: 0, skipped: 0 };
    for (const key of Object.keys(expectedCounts)) {
      if (!Number.isSafeInteger(result.summary[key]) || result.summary[key] < 0) throw new Error();
    }
    for (const resource of result.resources) {
      validateClosedObject(
        resource,
        new Set([
          "filename",
          "kind",
          "name",
          "version",
          "status",
          "msg",
          "validationErrors",
        ]),
        "resource",
      );
      for (const [key, maximumBytes] of [
        ["filename", 4096],
        ["kind", 256],
        ["name", 1024],
        ["version", 256],
        ["msg", 1024 * 1024],
      ]) {
        if (!validateBoundedString(resource[key], maximumBytes)) throw new Error();
      }
      if (!RESULT_STATUSES.has(resource.status)) throw new Error();
      expectedCounts[RESULT_STATUSES.get(resource.status)] += 1;
      if (resource.validationErrors !== undefined) {
        if (!Array.isArray(resource.validationErrors) || resource.validationErrors.length > 4096) {
          throw new Error();
        }
        for (const validationError of resource.validationErrors) {
          validateClosedObject(validationError, new Set(["path", "msg"]), "validation error");
          if (!validateBoundedString(validationError.path, 4096)
              || !validateBoundedString(validationError.msg, 65_536)) {
            throw new Error();
          }
        }
      }
    }
    if (Object.keys(expectedCounts)
      .some((key) => expectedCounts[key] !== result.summary[key])) throw new Error();
    return result;
  } catch {
    throw new Error("Pinned kubeconform output is not safe JSON");
  }
}

export function createKubeconformRunner(options = {}) {
  validateClosedObject(
    options,
    new Set(["environment", "spawn"]),
    "Kubeconform runner options",
  );
  const environmentDescriptor = Object.getOwnPropertyDescriptor(options, "environment");
  const environment = environmentDescriptor === undefined
    ? captureEnvironmentRecord(sanitizedHelmEnvironment(process.env))
    : captureEnvironmentRecord(environmentDescriptor.value);
  const spawn = options.spawn ?? spawnSync;
  if (typeof spawn !== "function") {
    throw new TypeError("Kubeconform runner dependencies are invalid");
  }

  return function validate(manifest, invocationOptions = {}) {
    validateClosedObject(
      invocationOptions,
      new Set(["expectedStatus", "kubeVersion"]),
      "Kubeconform invocation options",
    );
    const { kubeVersion } = invocationOptions;
    const expectedStatus = invocationOptions.expectedStatus ?? 0;
    validateKubernetesVersion(kubeVersion);
    if (!validateBoundedString(manifest, MAX_INPUT_BYTES)
        || Buffer.byteLength(manifest, "utf8") === 0) {
      throw new TypeError("Kubeconform manifest input is invalid");
    }
    if (!Number.isSafeInteger(expectedStatus) || expectedStatus < 0 || expectedStatus > 255) {
      throw new TypeError("Kubeconform expected status is invalid");
    }

    const processEnvironment = sanitizedHelmEnvironment(environment);
    const context = spawn(
      "docker",
      ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: processEnvironment,
        killSignal: "SIGKILL",
        maxBuffer: MAX_OUTPUT_BYTES,
        stdio: "pipe",
        timeout: 10_000,
      },
    );
    if (context.error !== undefined || context.status !== 0 || context.signal !== null) {
      throw new Error("Local Docker context inspection failed");
    }
    let dockerHost;
    try {
      dockerHost = parseLocalDockerEndpoint(context.stdout);
    } catch {
      throw new Error("Kubeconform verification requires a local Docker daemon");
    }

    const dockerConfiguration = mkdtempSync(join(tmpdir(), "gauntlet-kubeconform-docker-"));
    try {
      writeFileSync(join(dockerConfiguration, "config.json"), "{}\n", {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      const result = spawn(
        "docker",
        buildKubeconformDockerArgs(kubeVersion),
        {
          cwd: repositoryRoot,
          encoding: "utf8",
          env: {
            ...processEnvironment,
            DOCKER_CONFIG: dockerConfiguration,
            DOCKER_HOST: dockerHost,
          },
          input: manifest,
          killSignal: "SIGKILL",
          maxBuffer: MAX_OUTPUT_BYTES,
          stdio: "pipe",
          timeout: 60_000,
        },
      );
      if (result.error !== undefined || result.signal !== null) {
        throw new Error("Pinned kubeconform could not complete");
      }
      if (result.status !== expectedStatus) {
        throw new Error(
          `Pinned kubeconform failed with unexpected status ${String(result.status)} (expected ${String(expectedStatus)})`,
        );
      }
      return parseKubeconformOutput(result.stdout);
    } finally {
      rmSync(dockerConfiguration, { recursive: true, force: true });
    }
  };
}

export const validateKubernetesManifests = createKubeconformRunner();
