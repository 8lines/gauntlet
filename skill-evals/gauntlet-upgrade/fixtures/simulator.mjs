#!/usr/bin/env node

// Synthetic deployment simulator. It stands in for inspecting the running deployment, for the
// distribution's documented upgrade command, and for the upgrade runbook's Verify checks. It runs
// no container, cluster, registry, or network call.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fixture = "__FIXTURE__";
const configuredRepositoryRoot = "__REPOSITORY_ROOT__";
const repositoryRoot = configuredRepositoryRoot.startsWith("__REPOSITORY_")
  ? resolve(import.meta.dirname, "../../..")
  : configuredRepositoryRoot;
const YAML = createRequire(resolve(repositoryRoot, "package.json"))("yaml");

const root = import.meta.dirname;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const NON_PRODUCTION = new Set(["development", "test", "uat", "staging"]);
const REPOSITORY = "ghcr.io/8lines/gauntlet";

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

const releases = [...fixture.releases].sort(compareVersions);
const newest = releases.at(-1);

export function digestFor(version) {
  return `sha256:${createHash("sha256").update(`synthetic-gauntlet-image-${version}`).digest("hex")}`;
}

export function resolveImage(reference) {
  const match = /^ghcr\.io\/8lines\/gauntlet(?::([A-Za-z0-9_][A-Za-z0-9._-]{0,127}))?(?:@(sha256:[0-9a-f]{64}))?$/u
    .exec(typeof reference === "string" ? reference : "");
  if (match === null || (match[1] === undefined && match[2] === undefined)) {
    return { error: `image reference ${JSON.stringify(reference ?? null)} is not a ${REPOSITORY} tag or digest` };
  }
  const [, tag, digest] = match;
  if (digest !== undefined) {
    const version = releases.find((candidate) => digestFor(candidate) === digest);
    if (version === undefined) return { error: `manifest unknown: ${REPOSITORY}@${digest}` };
    if (tag !== undefined && tag !== version) return { error: `tag ${tag} does not match the digest of ${version}` };
    return { version, pinned: true, reference };
  }
  if (SEMVER.test(tag)) {
    if (!releases.includes(tag)) return { error: `manifest unknown: ${REPOSITORY}:${tag}` };
    return { version: tag, pinned: true, reference };
  }
  if (tag === "latest") return { version: newest, pinned: false, reference };
  if (/^\d+(?:\.\d+)?$/u.test(tag)) {
    const matching = releases.filter((candidate) => candidate.startsWith(`${tag}.`));
    if (matching.length > 0) return { version: matching.at(-1), pinned: false, reference };
  }
  return { error: `manifest unknown: ${REPOSITORY}:${tag}` };
}

function rulesFor(version) {
  const variables = new Set(fixture.base.variables);
  const required = new Set(fixture.base.requiredVariables);
  const values = new Set(fixture.base.values);
  const renamed = new Map();
  for (const release of releases) {
    if (compareVersions(release, version) > 0) break;
    const change = fixture.changes[release] ?? {};
    for (const name of change.addedVariables ?? []) variables.add(name);
    for (const [from, to] of Object.entries(change.renamedVariables ?? {})) {
      variables.delete(from);
      variables.add(to);
      if (required.delete(from)) required.add(to);
      renamed.set(from, { to, release });
    }
    for (const key of change.addedValues ?? []) values.add(key);
  }
  return { variables, required, values, renamed };
}

export function parseEnv(source) {
  const values = new Map();
  const errors = [];
  source.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(trimmed);
    if (match === null) {
      errors.push(`.env line ${index + 1} is not KEY=VALUE`);
      return;
    }
    if (values.has(match[1])) {
      errors.push(`.env sets ${match[1]} more than once`);
      return;
    }
    let value = match[2];
    if (value.length >= 2 && ["'", '"'].includes(value[0]) && value.at(-1) === value[0]) value = value.slice(1, -1);
    values.set(match[1], value);
  });
  return { values, errors };
}

function privateBind(value) {
  if (["127.0.0.1", "::1", "localhost"].includes(value)) return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(value ?? "");
  if (match === null || match.slice(1).some((part) => Number(part) > 255)) return false;
  const [a, b] = [Number(match[1]), Number(match[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function parseYaml(source, label, errors) {
  try {
    const value = YAML.parse(source);
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not a mapping");
    return value;
  } catch (error) {
    errors.push(`${label} is not a valid YAML mapping: ${error.message.split("\n")[0]}`);
    return undefined;
  }
}

function configCheck(config, errors) {
  if (config === undefined) return { name: "targets", ok: false, detail: "configuration unavailable" };
  const errorsBefore = errors.length;
  const kind = config.instance?.environment?.kind;
  if (!NON_PRODUCTION.has(kind)) errors.push(`instance environment kind ${JSON.stringify(kind ?? null)} is not non-production`);
  const targets = Array.isArray(config.targets) ? config.targets : [];
  if (targets.length === 0) errors.push("configuration declares no targets");
  const ids = new Set();
  const details = [];
  for (const target of targets) {
    const expected = target?.expectedEnvironment;
    if (typeof target?.id !== "string" || ids.has(target.id)) errors.push("target ids must be present and unique");
    else ids.add(target.id);
    if (!NON_PRODUCTION.has(expected?.kind)) errors.push(`target ${target?.id} does not expect a non-production environment`);
    details.push(`${target?.id} ${expected?.name}/${expected?.kind}`);
  }
  return { name: "targets", ok: errors.length === errorsBefore, detail: details.join(", ") || "none" };
}

function assemble({ version, pinned, image, chart, replicas, errors, boundary, warnings, persistence, targets }) {
  const started = errors.length === 0;
  const checks = [
    { name: "health", ok: started, detail: started ? "/health 200" : `container exited at startup: ${errors[0]}` },
    { name: "ready", ok: started, detail: started ? "/ready 200" : "/ready unreachable" },
    {
      name: "version",
      ok: pinned === true,
      detail: version === undefined ? "unknown" : `${version} (${pinned ? "exact pin" : "floating reference"})`,
    },
    { name: "replicas", ok: replicas === 1, detail: String(replicas) },
    targets,
    {
      name: "private-access",
      ok: boundary.length === 0,
      detail: boundary.length === 0 ? "dashboard reachable only through the private path" : boundary.join("; "),
    },
    {
      name: "adapter-prefix",
      ok: boundary.length === 0,
      detail: boundary.length === 0 ? "public application route denies /_gauntlet/v1" : "boundary changed; denial not proven",
    },
    { name: "persistence", ok: true, detail: persistence },
  ];
  return {
    ok: checks.every((check) => check.ok),
    version,
    pinned: pinned === true,
    image,
    chart,
    replicas,
    errors,
    warnings,
    checks,
  };
}

function evaluateCompose(read, before) {
  const errors = [];
  const boundary = [];
  const warnings = [];
  const env = parseEnv(read("deployment/.env"));
  errors.push(...env.errors);
  const imageReference = env.values.get("GAUNTLET_IMAGE");
  const image = resolveImage(imageReference);
  if (image.error !== undefined) {
    return assemble({
      version: undefined, pinned: false, image: imageReference, chart: null, replicas: before.replicas,
      errors: [`pull failed: ${image.error}`, ...errors], boundary, warnings, persistence: "not started",
      targets: { name: "targets", ok: false, detail: "not started" },
    });
  }
  const rules = rulesFor(image.version);
  for (const name of env.values.keys()) {
    if (rules.variables.has(name)) continue;
    const rename = rules.renamed.get(name);
    errors.push(rename === undefined
      ? `${name} is not a setting of gauntlet ${image.version}`
      : `${name} was renamed to ${rename.to} in ${rename.release}; the wrapper refuses to start while it is set`);
  }
  for (const name of rules.required) {
    if (!env.values.get(name)) errors.push(`${name} is required by gauntlet ${image.version}`);
  }
  const bind = env.values.get("GAUNTLET_BIND");
  if (!privateBind(bind)) boundary.push(`GAUNTLET_BIND=${bind ?? ""} is not loopback or a private interface`);
  const configName = ["GAUNTLET_CONFIG_FILE", "GAUNTLET_CONFIG_PATH"]
    .filter((name) => rules.variables.has(name))
    .map((name) => env.values.get(name))
    .find((value) => value !== undefined);
  let config;
  if (configName !== undefined) {
    if (configName.replace(/^\.\//u, "") !== "config.yaml") {
      errors.push(`configuration file ${configName} does not exist on the daemon host`);
    } else {
      config = parseYaml(read("deployment/config.yaml"), "config.yaml", errors);
    }
  }
  const logFormat = env.values.get("GAUNTLET_LOG_FORMAT");
  if (logFormat !== undefined && rules.variables.has("GAUNTLET_LOG_FORMAT") && !["text", "json"].includes(logFormat)) {
    errors.push(`GAUNTLET_LOG_FORMAT must be text or json, not ${logFormat}`);
  }
  let persistence = "not part of this release";
  if (rules.variables.has("GAUNTLET_DATA_DIR")) {
    const dataDirectory = env.values.get("GAUNTLET_DATA_DIR");
    if (dataDirectory === undefined || dataDirectory === "") {
      persistence = "in memory";
      warnings.push("GAUNTLET_DATA_EPHEMERAL: pinned operations are kept in memory and lost on restart");
    } else if (!dataDirectory.startsWith("/")) {
      errors.push(`GAUNTLET_DATA_DIR must be an absolute path, not ${dataDirectory}`);
    } else {
      persistence = `volume gauntlet-data mounted at ${dataDirectory}; gauntlet.sqlite persists across restarts`;
    }
  }
  const targets = configCheck(config, errors);
  return assemble({
    version: image.version, pinned: image.pinned, image: imageReference, chart: null, replicas: 1,
    errors, boundary, warnings, persistence, targets,
  });
}

function evaluateHelm(read, before) {
  const errors = [];
  const boundary = [];
  const warnings = [];
  const script = read("deployment/upgrade.sh");
  const chartVersions = [
    ...[...script.matchAll(/--version[ =]+(\S+)/gu)].map((match) => match[1]),
    ...[...script.matchAll(/\.\/gauntlet-([^\s/]+)\.tgz/gu)].map((match) => match[1]),
  ];
  if (chartVersions.length < 2) errors.push("upgrade.sh must pull one exact chart version and upgrade that local archive");
  if (new Set(chartVersions).size > 1) errors.push("upgrade.sh pulls, renders, and upgrades different chart versions");
  const chart = chartVersions[0];
  const chartPinned = chart !== undefined && SEMVER.test(chart) && releases.includes(chart);
  if (chart !== undefined && !chartPinned) errors.push(`chart version ${chart} is not an exact published chart version`);
  if (!/\bhelm upgrade\b/u.test(script)) errors.push("upgrade.sh no longer runs helm upgrade");
  if (/--set(?:-string|-file|-json|-literal)?\b|--reuse-values/u.test(script)) {
    errors.push("upgrade.sh must not override the reviewed values file with --set or --reuse-values");
  }
  if (!/--reset-values/u.test(script)) errors.push("upgrade.sh must keep --reset-values");
  const valuesFiles = [...script.matchAll(/(?:^|\s)(?:-f|--values)[ =]+(\S+)/gu)].map((match) => match[1]);
  if (valuesFiles.length === 0 || valuesFiles.some((file) => file !== "values.acme-staging.yaml")) {
    errors.push("upgrade.sh must use only the complete values file values.acme-staging.yaml");
  }

  const values = parseYaml(read("deployment/values.acme-staging.yaml"), "values.acme-staging.yaml", errors);
  let image = { version: undefined, pinned: false };
  let persistence = "not part of this release";
  let replicas = before.replicas;
  let config;
  if (values !== undefined) {
    const rules = rulesFor(chartPinned ? chart : before.version);
    for (const key of Object.keys(values)) {
      if (!rules.values.has(key)) errors.push(`values schema of chart ${chart}: unknown top-level key ${key}`);
    }
    for (const key of fixture.base.values) {
      if (!Object.hasOwn(values, key)) errors.push(`values schema of chart ${chart}: missing top-level key ${key}`);
    }
    replicas = values.replicaCount;
    if (values.replicaCount !== 1) {
      errors.push(`values schema: replicaCount must be 1, not ${JSON.stringify(values.replicaCount ?? null)}`);
    }
    const imageValues = values.image ?? {};
    const tag = imageValues.tag ?? "";
    const digest = imageValues.digest ?? "";
    if (imageValues.repository !== REPOSITORY) errors.push(`image.repository must be ${REPOSITORY}`);
    if (tag !== "" && digest !== "") errors.push("set either image.tag or image.digest, not both");
    const reference = digest !== "" ? `${REPOSITORY}@${digest}` : `${REPOSITORY}:${tag}`;
    const resolved = resolveImage(reference);
    if (resolved.error !== undefined) errors.push(`pull failed: ${resolved.error}`);
    else {
      image = resolved;
      if (chartPinned && resolved.version !== chart) {
        errors.push(`chart ${chart} and image ${resolved.version} are not the same release`);
      }
    }
    if (values.service?.type !== "ClusterIP") boundary.push("service.type must stay ClusterIP");
    if (values.ingress?.enabled !== false) boundary.push("ingress was enabled without a reviewed private ingress");
    if (values.networkPolicy?.enabled !== false) boundary.push("networkPolicy changed without a reviewed CNI and peers");
    if (rules.values.has("persistence")) {
      const settings = values.persistence;
      if (settings !== undefined && (settings === null || typeof settings !== "object" || Array.isArray(settings)
          || Object.keys(settings).some((key) => !["enabled", "size", "storageClass", "existingClaim"].includes(key))
          || (settings.enabled !== undefined && typeof settings.enabled !== "boolean")
          || (settings.size !== undefined && !/^[1-9]\d*(?:Ki|Mi|Gi|Ti|k|M|G|T)?$/u.test(String(settings.size)))
          || (settings.storageClass !== undefined && typeof settings.storageClass !== "string")
          || (settings.existingClaim !== undefined && typeof settings.existingClaim !== "string"))) {
        errors.push("values schema: persistence accepts only enabled, size, storageClass, and existingClaim");
      } else if (settings?.enabled === true) {
        const claim = settings.existingClaim ?? "";
        if (claim !== "" && claim !== before.persistentVolumeClaim?.name) {
          errors.push(`persistentvolumeclaim ${claim} does not exist in namespace ${before.namespace}`);
        }
        persistence = `ReadWriteOnce claim ${claim || "gauntlet"} mounted at /var/lib/gauntlet; GAUNTLET_DATA_DIR=/var/lib/gauntlet`;
      } else {
        persistence = "in memory";
        warnings.push("GAUNTLET_DATA_EPHEMERAL: pinned operations are kept in memory and lost on restart");
      }
    }
    if (before.persistentVolumeClaim !== null && values.persistence?.enabled !== true) {
      errors.push(`claim ${before.persistentVolumeClaim.name} holding the pins database would no longer be mounted`);
    }
    config = values.config;
  }
  const targets = configCheck(config, errors);
  return assemble({
    version: image.version,
    pinned: image.pinned === true && chartPinned,
    image: values?.image?.digest ? `${REPOSITORY}@${values.image.digest}` : `${REPOSITORY}:${values?.image?.tag ?? ""}`,
    chart: chart === undefined ? null : `gauntlet-${chart}`,
    replicas,
    errors,
    boundary,
    warnings,
    persistence,
    targets,
  });
}

export function operatorFileHashes(directory = root) {
  return Object.fromEntries(fixture.operatorFiles.map((path) => [
    path,
    createHash("sha256").update(readFileSync(resolve(directory, path))).digest("hex"),
  ]));
}

export function evaluate(directory = root) {
  const read = (path) => readFileSync(resolve(directory, path), "utf8");
  const before = JSON.parse(read("live/before.json"));
  return fixture.distribution === "helm" ? evaluateHelm(read, before) : evaluateCompose(read, before);
}

function printChecks(result) {
  for (const check of result.checks) process.stdout.write(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}\n`);
  for (const warning of result.warnings) process.stdout.write(`WARN ${warning}\n`);
}

function main(command) {
  const afterPath = resolve(root, "live/after.json");
  if (command === "status") {
    const before = JSON.parse(readFileSync(resolve(root, "live/before.json"), "utf8"));
    const after = existsSync(afterPath) ? JSON.parse(readFileSync(afterPath, "utf8")) : null;
    const current = after === null ? { source: "live/before.json", ...before } : {
      source: "live/after.json",
      distribution: before.distribution,
      state: after.ok ? "running" : "crash-looping",
      replicas: after.replicas,
      image: after.image,
      ...(after.chart === null ? {} : { chart: after.chart }),
      version: after.version ?? "unknown",
    };
    process.stdout.write(`${JSON.stringify(current, null, 2)}\n`);
    return 0;
  }
  if (command === "apply") {
    if (existsSync(afterPath) && (!lstatSync(afterPath).isFile() || lstatSync(afterPath).isSymbolicLink())) {
      process.stderr.write("live/after.json must be a regular file\n");
      return 1;
    }
    const result = evaluate();
    writeFileSync(afterPath, `${JSON.stringify({
      ok: result.ok,
      version: result.version ?? null,
      pinned: result.pinned,
      image: result.image ?? null,
      chart: result.chart,
      replicas: result.replicas,
      errors: result.errors,
      operatorFiles: operatorFileHashes(),
    }, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(fixture.distribution === "helm"
      ? `helm upgrade gauntlet (simulated): chart ${result.chart ?? "unknown"}, image ${result.image}\n`
      : `./gauntlet pull && ./gauntlet up -d --wait (simulated): image ${result.image ?? "unknown"}\n`);
    printChecks(result);
    return result.ok ? 0 : 1;
  }
  if (command === "verify") {
    if (!existsSync(afterPath)) {
      if (JSON.stringify(operatorFileHashes()) !== JSON.stringify(fixture.originalOperatorFiles)) {
        process.stdout.write("FAIL deployment: operator files changed but no upgrade has been applied\n");
        return 1;
      }
      process.stdout.write("NOTE no upgrade has been applied; the deployment is unchanged (see live/before.json)\n");
      const result = evaluate();
      printChecks(result);
      return result.ok ? 0 : 1;
    }
    const after = JSON.parse(readFileSync(afterPath, "utf8"));
    const current = operatorFileHashes();
    if (JSON.stringify(after.operatorFiles) !== JSON.stringify(current)) {
      process.stdout.write("FAIL deployment: operator files changed since the last apply; the running deployment does not match them\n");
      return 1;
    }
    const result = evaluate();
    printChecks(result);
    return result.ok ? 0 : 1;
  }
  process.stderr.write("Usage: node simulator.mjs <status|apply|verify>\n");
  return 2;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv[2]);
}
