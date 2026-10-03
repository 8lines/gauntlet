import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { types as utilTypes } from "node:util";
import { parse as parseYaml, parseAllDocuments } from "yaml";

export const HELM_IMAGE = "alpine/helm:4.0.4@sha256:adb87b125214fd356ecc1a24a1e86e4afed0ee03de5d4391de4925777de7fd42";
export const repositoryRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
export const helmChart = "deploy/helm/gauntlet";
export const stagingValues = "deploy/helm/ci/staging-values.yaml";

// Chart.yaml is the single source of the chart and application version the Helm tests assert.
export function readChartVersion(chartDirectory = join(repositoryRoot, helmChart)) {
  const chart = parseYaml(readFileSync(join(chartDirectory, "Chart.yaml"), "utf8"));
  const { version, appVersion } = chart ?? {};
  if (typeof version !== "string" || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version)) {
    throw new Error("Chart.yaml version must be an exact release version");
  }
  if (appVersion !== version) throw new Error("Chart.yaml version and appVersion must match");
  return version;
}

export const CHART_VERSION = readChartVersion();

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

export function sanitizedHelmEnvironment(source) {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([key, value]) => SAFE_ENVIRONMENT_KEYS.has(key) && typeof value === "string",
    ),
  );
}

export function parseLocalDockerEndpoint(output) {
  let endpoint;
  try {
    endpoint = JSON.parse(output.trim());
  } catch {
    throw new Error("Helm verification requires a local Docker daemon");
  }
  if (typeof endpoint !== "string" || !/^unix:\/\/\/[^\u0000-\u0020\u007f]+$/.test(endpoint)) {
    throw new Error("Helm verification requires a local Docker daemon");
  }
  return endpoint;
}

function validateRepositoryRoot(value) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value
      || value === "/" || /[,\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError("Helm repository root must be a safe absolute path");
  }
}

function validateOutputDirectory(value) {
  let stat;
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value
      || value === "/" || /[,\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError("Helm output directory must be a safe absolute directory");
  }
  try {
    stat = lstatSync(value);
    if (realpathSync(value) !== value) throw new Error();
  } catch {
    throw new TypeError("Helm output directory must be a safe absolute directory");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new TypeError("Helm output directory must be a safe absolute directory");
  }
}

function validateHelmArguments(args) {
  if (!Array.isArray(args) || args.length === 0
      || args.some((value) => typeof value !== "string" || value.length === 0
        || /[\u0000-\u001f\u007f]/.test(value))) {
    throw new TypeError("Helm arguments must be non-empty safe strings");
  }
}

function validateClosedOptions(value, allowedKeys, label) {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value)
      || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${label} must be a closed object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string"
      || !allowedKeys.has(key)
      || descriptors[key].enumerable !== true
      || !("value" in descriptors[key]))) {
    throw new TypeError(`${label} must be a closed object`);
  }
}

function optionValue(options, key) {
  return Object.getOwnPropertyDescriptor(options, key)?.value;
}

export function parseHelmDocuments(output) {
  if (typeof output !== "string") {
    throw new TypeError("Pinned Helm output must be a string");
  }
  try {
    const documents = parseAllDocuments(output, {
      prettyErrors: false,
      strict: true,
      uniqueKeys: true,
    });
    if (documents.some((document) => document.errors.length > 0)) throw new Error();
    return documents
      .map((document) => document.toJS({ maxAliasCount: 0 }))
      .filter((resource) => resource !== null)
      .map((resource) => {
        if (typeof resource !== "object" || Array.isArray(resource)
            || typeof resource.apiVersion !== "string" || resource.apiVersion.length === 0
            || typeof resource.kind !== "string" || resource.kind.length === 0
            || resource.metadata === null || typeof resource.metadata !== "object"
            || Array.isArray(resource.metadata)
            || typeof resource.metadata.name !== "string" || resource.metadata.name.length === 0) {
          throw new Error();
        }
        return resource;
      });
  } catch {
    throw new Error("Pinned Helm output is not a strict Kubernetes manifest");
  }
}

export function buildHelmDockerArgs(args, options = {}) {
  validateClosedOptions(
    options,
    new Set(["interactive", "outputDirectory", "repositoryRoot"]),
    "Helm Docker options",
  );
  const interactive = optionValue(options, "interactive");
  const outputDirectory = optionValue(options, "outputDirectory");
  const requestedRepositoryRoot = optionValue(options, "repositoryRoot");
  if (interactive !== undefined && typeof interactive !== "boolean") {
    throw new TypeError("Helm Docker options must contain a boolean interactive flag");
  }
  const mountedRepositoryRoot = requestedRepositoryRoot ?? repositoryRoot;
  validateRepositoryRoot(mountedRepositoryRoot);
  if (outputDirectory !== undefined) validateOutputDirectory(outputDirectory);
  validateHelmArguments(args);
  return [
    "run",
    "--rm",
    ...(interactive === true ? ["--interactive"] : []),
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
    "--tmpfs", "/helm-cache:rw,noexec,nosuid,nodev,size=16m,mode=0700,uid=65534,gid=65534",
    "--tmpfs", "/helm-config:rw,noexec,nosuid,nodev,size=1m,mode=0700,uid=65534,gid=65534",
    "--tmpfs", "/helm-data:rw,noexec,nosuid,nodev,size=16m,mode=0700,uid=65534,gid=65534",
    "--env", "HOME=/tmp",
    "--env", "HELM_CACHE_HOME=/helm-cache",
    "--env", "HELM_CONFIG_HOME=/helm-config",
    "--env", "HELM_DATA_HOME=/helm-data",
    "--mount", `type=bind,src=${mountedRepositoryRoot},dst=/workspace,readonly`,
    ...(outputDirectory === undefined
      ? []
      : ["--mount", `type=bind,src=${outputDirectory},dst=/output`]),
    "--workdir", "/workspace",
    HELM_IMAGE,
    ...args,
  ];
}

export function createHelmRunner(options = {}) {
  validateClosedOptions(
    options,
    new Set(["environment", "mountedRepositoryRoot", "outputDirectory", "spawn"]),
    "Helm runner options",
  );
  const configuredEnvironment = optionValue(options, "environment");
  const configuredRepositoryRoot = optionValue(options, "mountedRepositoryRoot");
  const configuredSpawn = optionValue(options, "spawn");
  const environment = configuredEnvironment === undefined ? process.env : configuredEnvironment;
  const mountedRepositoryRoot = configuredRepositoryRoot === undefined
    ? repositoryRoot
    : configuredRepositoryRoot;
  const outputDirectory = optionValue(options, "outputDirectory");
  const spawn = configuredSpawn === undefined ? spawnSync : configuredSpawn;
  if (environment === null || typeof environment !== "object" || Array.isArray(environment)) {
    throw new TypeError("Helm runner options must contain an environment object");
  }
  if (typeof spawn !== "function") throw new TypeError("Helm process boundary must be callable");
  validateRepositoryRoot(mountedRepositoryRoot);
  if (outputDirectory !== undefined) validateOutputDirectory(outputDirectory);

  return function runHelm(args, expectedStatus = 0, options = {}) {
    validateHelmArguments(args);
    if (!Number.isSafeInteger(expectedStatus) || expectedStatus < 0 || expectedStatus > 255) {
      throw new TypeError("Expected Helm status must be an integer from 0 through 255");
    }
    try {
      validateClosedOptions(options, new Set(["input"]), "Helm invocation options");
    } catch {
      throw new TypeError("Helm invocation options must be a closed object");
    }
    const input = optionValue(options, "input");
    if (input !== undefined && typeof input !== "string") {
      throw new TypeError("Helm invocation options must contain string stdin when provided");
    }

    const discoveryEnvironment = sanitizedHelmEnvironment(environment);
    const context = spawn(
      "docker",
      ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"],
      {
        cwd: mountedRepositoryRoot,
        encoding: "utf8",
        env: discoveryEnvironment,
        killSignal: "SIGKILL",
        maxBuffer: MAX_OUTPUT_BYTES,
        stdio: "pipe",
        timeout: 10_000,
      },
    );
    if (context.error !== undefined || context.status !== 0) {
      throw new Error("Local Docker context inspection failed");
    }
    const dockerHost = parseLocalDockerEndpoint(context.stdout);
    const dockerConfiguration = mkdtempSync(join(tmpdir(), "gauntlet-helm-docker-"));

    try {
      writeFileSync(join(dockerConfiguration, "config.json"), "{}\n", {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      const result = spawn(
        "docker",
        buildHelmDockerArgs(args, {
          interactive: input !== undefined,
          outputDirectory,
          repositoryRoot: mountedRepositoryRoot,
        }),
        {
          cwd: mountedRepositoryRoot,
          encoding: "utf8",
          env: {
            ...discoveryEnvironment,
            DOCKER_CONFIG: dockerConfiguration,
            DOCKER_HOST: dockerHost,
          },
          input,
          killSignal: "SIGKILL",
          maxBuffer: MAX_OUTPUT_BYTES,
          stdio: "pipe",
          timeout: 60_000,
        },
      );
      if (result.error !== undefined || result.signal !== null) {
        throw new Error("Pinned Helm command could not complete");
      }
      if (result.status !== expectedStatus) {
        throw new Error(
          `Pinned Helm command failed with unexpected status ${String(result.status)} (expected ${expectedStatus})`,
        );
      }
      return result.stdout;
    } finally {
      rmSync(dockerConfiguration, { recursive: true, force: true });
    }
  };
}

export const helm = createHelmRunner();

const RENDER_OVERRIDE_FLAGS = new Set(["--set", "--set-json", "--set-string"]);
const SUPPORTED_KUBERNETES_VERSIONS = new Set(["1.35.0", "1.36.0", "1.37.0"]);

function validateRenderValuesFiles(valuesFiles) {
  if (!Array.isArray(valuesFiles) || valuesFiles.length === 0
      || valuesFiles.some((value) => typeof value !== "string" || value.length === 0
        || (value !== "-" && (!/^deploy\/helm\/[A-Za-z0-9._/-]+\.ya?ml$/.test(value)
          || value.split("/").some((segment) => segment === "" || segment === "." || segment === ".."))))) {
    throw new TypeError("Helm render values files must be safe chart-relative YAML paths");
  }
}

function validateRenderOverrides(extraArgs) {
  if (!Array.isArray(extraArgs) || extraArgs.length % 2 !== 0) {
    throw new TypeError("Helm render overrides must be flag-value pairs");
  }
  for (let index = 0; index < extraArgs.length; index += 2) {
    if (!RENDER_OVERRIDE_FLAGS.has(extraArgs[index])) {
      throw new TypeError("Helm render overrides use an unsupported flag");
    }
  }
  try {
    if (extraArgs.length > 0) validateHelmArguments(extraArgs);
  } catch {
    throw new TypeError("Helm render overrides must be safe strings");
  }
}

export function render(
  valuesFiles = [stagingValues],
  extraArgs = [],
  options = {},
) {
  validateRenderValuesFiles(valuesFiles);
  validateRenderOverrides(extraArgs);
  try {
    validateClosedOptions(
      options,
      new Set(["expectedStatus", "input", "kubeVersion"]),
      "Helm render options",
    );
  } catch {
    throw new TypeError("Helm render options must be a closed object");
  }
  const expectedStatus = options.expectedStatus ?? 0;
  const kubeVersion = options.kubeVersion ?? "1.35.0";
  if (!Number.isSafeInteger(expectedStatus) || expectedStatus < 0 || expectedStatus > 255) {
    throw new TypeError("Helm render expected status must be an integer from 0 through 255");
  }
  if (!SUPPORTED_KUBERNETES_VERSIONS.has(kubeVersion)) {
    throw new TypeError("Helm render Kubernetes version is unsupported");
  }
  const stdinCount = valuesFiles.filter((value) => value === "-").length;
  if (stdinCount > 1 || (options.input === undefined) !== (stdinCount === 0)
      || (options.input !== undefined && typeof options.input !== "string")) {
    throw new TypeError("Helm render stdin must correspond to exactly one values file");
  }

  const args = [
    "template",
    "gauntlet",
    helmChart,
    "--namespace",
    "acme-staging",
    "--kube-version",
    kubeVersion,
  ];
  for (const valuesFile of valuesFiles) args.push("-f", valuesFile);
  args.push(...extraArgs);
  const output = helm(args, expectedStatus, options.input === undefined ? {} : { input: options.input });
  return expectedStatus === 0 ? parseHelmDocuments(output) : [];
}

export function parseHelmInstallNotes(output) {
  if (typeof output !== "string") {
    throw new TypeError("Pinned Helm install output must be a string");
  }
  try {
    const result = JSON.parse(output);
    const notes = result?.info?.notes;
    if (typeof notes !== "string" || notes.trim().length === 0
        || Buffer.byteLength(notes, "utf8") > 65_536) {
      throw new Error();
    }
    return notes;
  } catch {
    throw new Error("Pinned Helm install did not return safe NOTES");
  }
}

function copyRegularTree(source, destination) {
  const sourceStat = lstatSync(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error("Helm NOTES projection source must be a regular directory tree");
  }
  mkdirSync(destination, { mode: 0o700 });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    const stat = lstatSync(sourcePath);
    if (stat.isSymbolicLink()) {
      throw new Error("Helm NOTES projection source must not contain links");
    }
    if (stat.isDirectory()) {
      copyRegularTree(sourcePath, destinationPath);
    } else if (stat.isFile()) {
      writeFileSync(destinationPath, readFileSync(sourcePath), { flag: "wx", mode: 0o600 });
    } else {
      throw new Error("Helm NOTES projection source must contain only regular files");
    }
  }
}

function copyRegularFile(source, destination) {
  const stat = lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Helm NOTES projection source must be a regular file");
  }
  writeFileSync(destination, readFileSync(source), { flag: "wx", mode: 0o600 });
}

function lockProjectionTree(path) {
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) lockProjectionTree(join(path, entry));
    chmodSync(path, 0o555);
  } else {
    chmodSync(path, 0o444);
  }
}

function removeProjectionTree(path) {
  if (!lstatSync(path).isDirectory()) throw new Error("Helm NOTES projection root is invalid");
  const unlock = (entryPath) => {
    const stat = lstatSync(entryPath);
    if (stat.isDirectory()) {
      chmodSync(entryPath, 0o700);
      for (const entry of readdirSync(entryPath)) unlock(join(entryPath, entry));
    } else {
      chmodSync(entryPath, 0o600);
    }
  };
  unlock(path);
  rmSync(path, { recursive: true, force: false });
}

export function createHelmNotesProjection(...args) {
  if (args.length !== 0) {
    throw new TypeError("Helm NOTES projection does not accept options");
  }
  const projectionRoot = mkdtempSync(join(tmpdir(), "gauntlet-helm-notes-"));
  try {
    const projectedHelmRoot = join(projectionRoot, "deploy", "helm");
    mkdirSync(join(projectionRoot, "deploy"), { mode: 0o700 });
    mkdirSync(projectedHelmRoot, { mode: 0o700 });
    copyRegularTree(
      join(repositoryRoot, "deploy", "helm", "gauntlet"),
      join(projectedHelmRoot, "gauntlet"),
    );
    mkdirSync(join(projectedHelmRoot, "ci"), { mode: 0o700 });
    copyRegularFile(
      join(repositoryRoot, "deploy", "helm", "ci", "staging-values.yaml"),
      join(projectedHelmRoot, "ci", "staging-values.yaml"),
    );

    const projectedChartPath = join(projectedHelmRoot, "gauntlet", "Chart.yaml");
    const originalChart = readFileSync(projectedChartPath);
    const required = Buffer.from('kubeVersion: ">=1.33.0-0"', "utf8");
    const offset = originalChart.indexOf(required);
    if (offset < 0 || originalChart.indexOf(required, offset + 1) >= 0) {
      throw new Error("Helm NOTES projection expected one Kubernetes compatibility scalar");
    }
    const projectedChart = Buffer.from(originalChart);
    const versionByte = offset + required.indexOf(Buffer.from("33")) + 1;
    projectedChart[versionByte] = "2".charCodeAt(0);
    const changedOffsets = [];
    for (let index = 0; index < originalChart.length; index += 1) {
      if (originalChart[index] !== projectedChart[index]) changedOffsets.push(index);
    }
    if (changedOffsets.length !== 1 || changedOffsets[0] !== versionByte
        || originalChart[versionByte] !== "3".charCodeAt(0)
        || projectedChart[versionByte] !== "2".charCodeAt(0)) {
      throw new Error("Helm NOTES projection changed more than compatibility metadata");
    }
    writeFileSync(projectedChartPath, projectedChart, { flag: "w", mode: 0o600 });
    lockProjectionTree(projectionRoot);

    let disposed = false;
    return Object.freeze({
      root: projectionRoot,
      dispose() {
        if (disposed) return;
        disposed = true;
        removeProjectionTree(projectionRoot);
      },
    });
  } catch (error) {
    try {
      if (lstatSync(projectionRoot).isDirectory()) {
        const unlock = (entryPath) => {
          const stat = lstatSync(entryPath);
          if (stat.isDirectory()) {
            chmodSync(entryPath, 0o700);
            for (const entry of readdirSync(entryPath)) unlock(join(entryPath, entry));
          }
        };
        unlock(projectionRoot);
      }
      rmSync(projectionRoot, { recursive: true, force: true });
    } catch {
      // Preserve the projection failure while making a best-effort cleanup.
    }
    throw error;
  }
}

export function renderNotes(...args) {
  if (args.length !== 0) {
    throw new TypeError("Helm NOTES renderer does not accept options");
  }
  const projection = createHelmNotesProjection();
  try {
    const projectedHelm = createHelmRunner({ mountedRepositoryRoot: projection.root });
    const output = projectedHelm([
      "install",
      "gauntlet",
      helmChart,
      "--namespace",
      "acme-staging",
      "--dry-run=client",
      "--output=json",
      "-f",
      stagingValues,
    ]);
    return parseHelmInstallNotes(output);
  } finally {
    projection.dispose();
  }
}
