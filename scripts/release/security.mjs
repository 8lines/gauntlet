#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { parseReleaseSetId } from "./plan.mjs";
import { readReleaseVersion, RELEASE_ARTIFACTS } from "./release-model.mjs";

const MAX_SCANNED_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024;
const MAX_AUDIT_REPORT_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_ARCHIVE_BYTES = 16 * 1024 * 1024 * 1024;
const FAILURE = "Release security gate failed closed";
const COMMAND_FAILURE = "Release security command failed safely";
const SEVERITIES = ["info", "low", "moderate", "high", "critical"];
const COMPOSER_PROJECTS = Object.freeze([
  Object.freeze({ directory: "examples/symfony", name: "8lines/gauntlet-symfony-example" }),
  ...RELEASE_ARTIFACTS.composer.map(({ directory, name }) => Object.freeze({ directory, name })),
].sort((left, right) => byteCompare(left.directory, right.directory)));
const COMPOSER_LOCKFILES = Object.freeze(COMPOSER_PROJECTS.map(({ directory }) => `${directory}/composer.lock`));
const COMPOSER_IMAGE = "composer:2.10.3@sha256:4d045ea9f71d5d111a95e608400da61d187e487adf9eaf2dfe068998a8d4f584";
export const TRIVY_IMAGE = "aquasec/trivy:0.66.0@sha256:086971aaf400beebd94e8300fd8ea623774419597169156cec56eec5b00dfb1e";
const COMPOSER_AUDIT_MANIFEST = '{"name":"gauntlet/release-security-audit","type":"metapackage","config":{"allow-plugins":false}}\n';
const FIXED_NPMRC = [
  "registry=https://registry.npmjs.org/",
  "@8lines:registry=https://registry.npmjs.org/",
  "ignore-scripts=true",
  "update-notifier=false",
  "",
].join("\n");
const REPORT_NAMES = [
  "composer-audit.json",
  "credential-material.json",
  "pnpm-audit.json",
  "production-defaults.json",
  "source-snapshot.json",
  "trivy-filesystem.json",
  "trivy-image.json",
];
const REPOSITORY_ROOT = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));

function failClosed() {
  throw new Error(FAILURE);
}

function byteCompare(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function isReferencePath(path) {
  if (COMPOSER_LOCKFILES.includes(path)) return false;
  const name = path.slice(path.lastIndexOf("/") + 1);
  return /^skill-evals\/[^/]+\/prepare-fixture\.mjs$/.test(path)
    || /(?:^|\/)(?:\.superpowers|docs|fixtures?|tests?|__tests__)(?:\/|$)/.test(path)
    || /(?:^|\.)\b(?:test|spec)\.[^/]+$/.test(path)
    || /^(?:test|spec)[-_.].*\.(?:[cm]?[jt]sx?|ya?ml)$/i.test(name)
    || /\.(?:md|mdx|rst|adoc)$/i.test(name);
}

function validateRelativePath(path) {
  if (typeof path !== "string" || path === "" || isAbsolute(path) || path.includes("\\")
      || /[\u0000-\u001f\u007f]/.test(path)
      || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    failClosed();
  }
}

function sameRegularFile(left, right) {
  return left.isFile() && right.isFile() && !left.isSymbolicLink() && !right.isSymbolicLink()
    && left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.uid === right.uid && left.gid === right.gid && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs && left.nlink === 1n && right.nlink === 1n;
}

function readBoundedFile(root, relativePath) {
  let descriptor;
  try {
    validateRelativePath(relativePath);
    const path = resolve(root, relativePath);
    if (path === root || !path.startsWith(`${root}${sep}`) || realpathSync(path) !== path) failClosed();
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
        || before.size < 0n || before.size > BigInt(MAX_SCANNED_FILE_BYTES)) failClosed();
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!sameRegularFile(before, opened)) failClosed();
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const pathnameAfter = lstatSync(path, { bigint: true });
    if (BigInt(bytes.length) !== opened.size || !sameRegularFile(opened, after)
        || !sameRegularFile(after, pathnameAfter) || realpathSync(path) !== path) failClosed();
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function statIdentity(stat) {
  return Object.freeze({
    device: String(stat.dev),
    inode: String(stat.ino),
    mode: String(stat.mode),
    uid: String(stat.uid),
    gid: String(stat.gid),
    size: String(stat.size),
    modified: String(stat.mtimeNs),
    changed: String(stat.ctimeNs),
    links: String(stat.nlink),
  });
}

function sameIdentity(left, right) {
  return Object.keys(left).every((key) => left[key] === right[key]);
}

function boundedSourceRecord(root, relativePath) {
  const bytes = readBoundedFile(root, relativePath);
  const stat = lstatSync(resolve(root, relativePath), { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || BigInt(bytes.length) !== stat.size) failClosed();
  return Object.freeze({
    bytes,
    path: relativePath,
    sha256: sha256(bytes),
    identity: statIdentity(stat),
  });
}

function ensureSnapshotParent(snapshotRoot, relativePath, directories) {
  const parent = dirname(resolve(snapshotRoot, relativePath));
  if (parent !== snapshotRoot && !parent.startsWith(`${snapshotRoot}${sep}`)) failClosed();
  mkdirSync(parent, { mode: 0o700, recursive: true });
  let cursor = parent;
  while (cursor !== snapshotRoot) {
    directories.add(cursor);
    cursor = dirname(cursor);
  }
}

function sealSnapshot(snapshotRoot, records, directories) {
  for (const { path } of records) chmodSync(resolve(snapshotRoot, path), 0o400);
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) chmodSync(directory, 0o500);
  chmodSync(snapshotRoot, 0o500);
}

function createRepositorySnapshot(root, snapshotRoot, paths) {
  ensureSafeDirectory(snapshotRoot);
  const directories = new Set();
  const records = [];
  let totalBytes = 0;
  for (const path of paths) {
    const source = boundedSourceRecord(root, path);
    totalBytes += source.bytes.length;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_SNAPSHOT_BYTES) failClosed();
    ensureSnapshotParent(snapshotRoot, path, directories);
    writeFileSync(resolve(snapshotRoot, path), source.bytes, { flag: "wx", mode: 0o600 });
    records.push(Object.freeze({
      path,
      sha256: source.sha256,
      sourceIdentity: source.identity,
    }));
  }
  sealSnapshot(snapshotRoot, records, directories);
  verifyRepositorySnapshot(root, snapshotRoot, records);
  return Object.freeze(records);
}

function verifyRepositorySnapshot(root, snapshotRoot, records) {
  try {
    for (const expected of records) {
      const source = boundedSourceRecord(root, expected.path);
      if (source.sha256 !== expected.sha256 || !sameIdentity(source.identity, expected.sourceIdentity)) failClosed();
      const snapshotPath = resolve(snapshotRoot, expected.path);
      const stat = lstatSync(snapshotPath, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || (stat.mode & 0o777n) !== 0o400n
          || sha256(readBoundedFile(snapshotRoot, expected.path)) !== expected.sha256) failClosed();
    }
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  }
}

function makeSnapshotWritable(path) {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      chmodSync(path, 0o700);
      for (const name of readdirSync(path)) makeSnapshotWritable(resolve(path, name));
    } else if (stat.isFile()) {
      chmodSync(path, 0o600);
    }
  } catch {
    // Cleanup remains best effort and scoped to the unique task workspace.
  }
}

function lineNumber(source, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function addMatches(findings, source, path, rule, expression) {
  for (const match of source.matchAll(expression)) {
    findings.push({ line: lineNumber(source, match.index), path, rule });
  }
}

function isCredentialKey(key, allowGenericToken) {
  const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
  if (["auth", "authorization", "credential", "credentials", "password", "passwd", "secret", "token"].includes(normalized)) {
    return true;
  }
  if (["password", "passwd", "secret", "apikey", "privatekey", "accesstoken", "refreshtoken", "authtoken"]
    .some((suffix) => normalized.endsWith(suffix))) return true;
  return allowGenericToken && normalized.endsWith("token") && normalized !== "automountserviceaccounttoken";
}

function isLiteralCredentialValue(value) {
  const normalized = value.trim();
  return normalized !== "" && !/^(?:true|false|null|nil|undefined|[0-9]+)$/i.test(normalized)
    && !/^(?:\$|\{\{|<)[\s\S]*(?:\}|>|$)/.test(normalized);
}

function literalCredentialFindings(path, source) {
  const findings = [];
  const name = path.slice(path.lastIndexOf("/") + 1);
  const configuration = /(?:^|\.)(?:env|ya?ml|toml|ini|properties|conf|config)$/i.test(name) || name === ".npmrc";
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    let match;
    if (configuration) {
      match = /^\s*([A-Za-z0-9_.-]+)\s*[:=]\s*(.*?)\s*$/.exec(line);
    } else {
      match = /^\s*(?:export\s+)?(?:(?:const|let|var)\s+)?([A-Za-z_$][A-Za-z0-9_$.-]*)\s*[:=]\s*(["'][^"'\r\n]*["'])/.exec(line);
    }
    let found = false;
    if (match !== null && isCredentialKey(match[1], configuration)) {
      let value = match[2].replace(/\s+#.*$/, "").trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      // GitHub Actions' `id-token: write` is an OIDC permission grant, not a credential.
      const workflowPermission = path.startsWith(".github/workflows/") && match[1] === "id-token"
        && /^(?:read|write|none)$/.test(value);
      found = !workflowPermission && isLiteralCredentialValue(value);
    }
    if (!found) {
      const phpPair = /^\s*["']([A-Za-z_$][A-Za-z0-9_$.-]*)["']\s*=>\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)')/.exec(line);
      found = phpPair !== null && isCredentialKey(phpPair[1], true)
        && isLiteralCredentialValue(phpPair[2] ?? phpPair[3]);
    }
    if (!found) {
      const inline = /(?:^|[{,])\s*["']?([A-Za-z_$][A-Za-z0-9_$.-]*)["']?\s*:\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)')/g;
      for (const candidate of line.matchAll(inline)) {
        if (isCredentialKey(candidate[1], true)
            && isLiteralCredentialValue(candidate[2] ?? candidate[3])) {
          found = true;
          break;
        }
      }
    }
    if (found) findings.push({ line: index + 1, path, rule: "literal-credential" });
  }
  return findings;
}

function credentialFindings(path, bytes, { includeLowConfidence }) {
  const findings = [];
  if (/(?:^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)|[^/]+\.(?:key|p12|pfx|jks|keystore))$/i.test(path)) {
    findings.push({ line: 1, path, rule: "credential-file" });
  }
  if (bytes.includes(0)) return findings;
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return findings;
  }
  addMatches(findings, source, path, "github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{20,255})\b/g);
  addMatches(findings, source, path, "aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g);
  addMatches(findings, source, path, "npm-token", /\bnpm_[A-Za-z0-9]{36,255}\b/g);
  addMatches(findings, source, path, "slack-token", /\bxox[baprs]-[A-Za-z0-9-]{10,255}\b/g);
  addMatches(findings, source, path, "gitlab-token", /\bglpat-[A-Za-z0-9_-]{20,255}\b/g);
  addMatches(findings, source, path, "google-api-key", /\bAIza[A-Za-z0-9_-]{35}\b/g);
  addMatches(findings, source, path, "stripe-secret-key", /\bsk_(?:live|test)_[A-Za-z0-9]{16,255}\b/g);
  addMatches(
    findings,
    source,
    path,
    "npm-auth-assignment",
    /^\s*(?:(?:\/\/[^\s/]+\/?)?:)?_auth(?:Token)?\s*=\s*(?!\$\{|\{\{|<)[^\s#;]+/gim,
  );
  addMatches(
    findings,
    source,
    path,
    "pem-private-key",
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]{16,}?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
  );
  if (includeLowConfidence) {
    addMatches(
      findings,
      source,
      path,
      "credential-url",
      /\b(?:https?|git\+https):\/\/[^\s/@:]+:[^\s/@]+@[^\s/]+/gi,
    );
    findings.push(...literalCredentialFindings(path, source));
  }
  return findings;
}

function unsafeDefaultFindings(path, bytes) {
  if (bytes.includes(0)) return [];
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return [];
  }
  const findings = [];
  const dockerfile = /(?:^|\/)Dockerfile(?:\.[A-Za-z0-9._-]+)?$/i.test(path);
  if (dockerfile) {
    addMatches(findings, source, path, "root-container-user", /^\s*USER\s+(?:0|root)(?::(?:0|root))?(?:\s|$)/gim);
    addMatches(
      findings,
      source,
      path,
      "floating-image-tag",
      /^\s*FROM\s+(?!scratch(?:\s|$)|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?(?:\s|$))[^#\s:@]+(?:\s|$)/gim,
    );
    addMatches(findings, source, path, "floating-image-tag", /^\s*FROM\s+[^#\s"']+:latest(?:\s|$)/gim);
  }
  const rules = [
    ["floating-image-tag", /(?:^|(?<=[{,\n]))[\t ]*["']?(?:image|GAUNTLET_IMAGE)["']?[\t ]*[:=][\t ]*["']?[^#\s"'}]+:latest\b/gim],
    ["floating-image-tag", /(?:^|(?<=[{,\n]))[\t ]*["']?tag["']?[\t ]*:[\t ]*["']?latest\b/gim],
    ["public-bind", /(?:^|(?<=[{,\n]))[\t ]*["']?(?:host_ip|GAUNTLET_BIND)["']?[\t ]*[:=][\t ]*["']?(?:0\.0\.0\.0|\[?::\]?|\*)(?=$|[\s"',}#])/gim],
    ["privileged-container", /(?:^|(?<=[{,\n]))[\t ]*["']?privileged["']?[\t ]*:[\t ]*true\b/gim],
    ["privilege-escalation", /(?:^|(?<=[{,\n]))[\t ]*["']?allowPrivilegeEscalation["']?[\t ]*:[\t ]*true\b/gim],
    ["non-root-disabled", /(?:^|(?<=[{,\n]))[\t ]*["']?runAsNonRoot["']?[\t ]*:[\t ]*false\b/gim],
    ["writable-root-filesystem", /(?:^|(?<=[{,\n]))[\t ]*["']?readOnlyRootFilesystem["']?[\t ]*:[\t ]*false\b/gim],
    ["public-network", /(?:^|[\s"'])(?:0\.0\.0\.0\/0|::\/0)(?=$|[\s,"'])/gim],
    ["host-network", /(?:^|(?<=[{,\n]))[\t ]*["']?network_mode["']?[\t ]*:[\t ]*["']?host["']?(?=$|[\s,}#])/gim],
    ["public-published-port", /(?:^|[\s"'])0\.0\.0\.0:[0-9]{1,5}:[0-9]{1,5}(?=$|[\s"',}])/gim],
    ["production-environment", /(?:^|(?<=[{,\n]))[\t ]*["']?(?:kind|environment(?:\.kind)?)["']?[\t ]*[:=][\t ]*["']?(?:prod|production|live)["']?(?=$|[\s,}#])/gim],
  ];
  if (path === "pnpm-workspace.yaml") {
    rules.push(
      ["audit-suppression", /(?:^|(?<=[{,\n]))[\t ]*["']?(?:audit|auditConfig)["']?[\t ]*:/gim],
      ["audit-suppression", /(?:^|(?<=[{,\n]))[\t ]*["']?(?:ignoreGhsas|ignoreCves)["']?[\t ]*:/gim],
    );
  }
  for (const [rule, expression] of rules) addMatches(findings, source, path, rule, expression);
  return findings;
}

export function scanRepositoryFiles({ root, paths }) {
  try {
    if (typeof root !== "string" || !isAbsolute(root) || root === sep || /[\u0000-\u001f\u007f]/.test(root)
        || !Array.isArray(paths) || paths.some((path) => typeof path !== "string")) failClosed();
    const canonicalRoot = realpathSync(root);
    const rootStat = lstatSync(root);
    if (canonicalRoot !== root || !rootStat.isDirectory() || rootStat.isSymbolicLink()) failClosed();
    const unique = [...new Set(paths)];
    if (unique.length !== paths.length) failClosed();
    const scannedPaths = unique.sort(byteCompare);
    const credentials = [];
    const unsafeProductionDefaults = [];
    let productionDefaultFiles = 0;
    for (const path of scannedPaths) {
      const bytes = readBoundedFile(canonicalRoot, path);
      const reference = isReferencePath(path);
      credentials.push(...credentialFindings(path, bytes, { includeLowConfidence: !reference }));
      if (!reference) {
        productionDefaultFiles += 1;
        unsafeProductionDefaults.push(...unsafeDefaultFindings(path, bytes));
      }
    }
    credentials.sort((left, right) => byteCompare(left.path, right.path)
      || left.line - right.line || byteCompare(left.rule, right.rule));
    unsafeProductionDefaults.sort((left, right) => byteCompare(left.path, right.path)
      || left.line - right.line || byteCompare(left.rule, right.rule));
    return { credentials, productionDefaultFiles, scannedFiles: scannedPaths.length, unsafeProductionDefaults };
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  }
}

function safeBufferText(value, maximumBytes) {
  if (!Buffer.isBuffer(value) || value.length > maximumBytes) failClosed();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    failClosed();
  }
}

function normalizedAdvisoryId(key, advisory) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(key) || !Number.isSafeInteger(advisory.id)
      || String(advisory.id) !== key) failClosed();
  const ghsa = advisory.github_advisory_id;
  if (ghsa === "" || ghsa === undefined) return `PNPM-${key}`;
  const match = /^GHSA-([23456789cfghjmpqrvwx]{4})-([23456789cfghjmpqrvwx]{4})-([23456789cfghjmpqrvwx]{4})$/i.exec(ghsa);
  if (match === null) failClosed();
  return `GHSA-${match[1].toLowerCase()}-${match[2].toLowerCase()}-${match[3].toLowerCase()}`;
}

export function normalizePnpmAuditResult(result) {
  try {
    if (result === null || typeof result !== "object" || Array.isArray(result)
        || ![0, 1].includes(result.status) || result.signal !== null) failClosed();
    const source = safeBufferText(result.stdout, MAX_AUDIT_REPORT_BYTES);
    safeBufferText(result.stderr, MAX_AUDIT_REPORT_BYTES);
    const parsed = JSON.parse(source);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
        || parsed.advisories === null || typeof parsed.advisories !== "object" || Array.isArray(parsed.advisories)
        || parsed.metadata === null || typeof parsed.metadata !== "object" || Array.isArray(parsed.metadata)) failClosed();
    const vulnerabilities = [];
    const identities = new Set();
    for (const [key, advisory] of Object.entries(parsed.advisories)) {
      if (advisory === null || typeof advisory !== "object" || Array.isArray(advisory)
          || !SEVERITIES.includes(advisory.severity)
          || typeof advisory.module_name !== "string" || advisory.module_name.length > 214
          || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(advisory.module_name)
          || !Array.isArray(advisory.findings) || advisory.findings.length === 0) failClosed();
      const id = normalizedAdvisoryId(key, advisory);
      if (identities.has(id)) failClosed();
      identities.add(id);
      if (advisory.patched_versions_unpublished !== undefined
          && advisory.patched_versions_unpublished !== true) failClosed();
      if (advisory.patched_versions_unpublished === true && advisory.patched_versions !== null) failClosed();
      let fixability = "unknown";
      if (advisory.patched_versions_unpublished === true) {
        fixability = "unavailable";
      } else if (advisory.patched_versions !== undefined && advisory.patched_versions !== null) {
        if (typeof advisory.patched_versions !== "string" || advisory.patched_versions.length === 0
            || advisory.patched_versions.length > 256 || /[\u0000-\u001f\u007f]/.test(advisory.patched_versions)) failClosed();
        fixability = "available";
      }
      vulnerabilities.push({ fixability, id, package: advisory.module_name, severity: advisory.severity });
    }
    if (result.status !== (vulnerabilities.length === 0 ? 0 : 1)) failClosed();
    vulnerabilities.sort((left, right) => byteCompare(left.package, right.package) || byteCompare(left.id, right.id));
    const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
    for (const vulnerability of vulnerabilities) counts[vulnerability.severity] += 1;
    const metadataCounts = parsed.metadata.vulnerabilities;
    if (metadataCounts === null || typeof metadataCounts !== "object" || Array.isArray(metadataCounts)
        || Object.keys(metadataCounts).length !== SEVERITIES.length
        || SEVERITIES.some((severity) => !Object.hasOwn(metadataCounts, severity)
          || !Number.isSafeInteger(metadataCounts[severity]) || metadataCounts[severity] < 0
          || metadataCounts[severity] !== counts[severity])) failClosed();
    const blockingCount = vulnerabilities.filter(
      ({ fixability, severity }) => fixability !== "unavailable" && (severity === "high" || severity === "critical"),
    ).length;
    return {
      schemaVersion: 1,
      scanner: "pnpm-audit",
      scope: "production",
      counts,
      blockingCount,
      ok: blockingCount === 0,
      vulnerabilities,
    };
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  }
}

const TRIVY_SEVERITIES = Object.freeze(["unknown", "low", "medium", "high", "critical"]);
const TRIVY_UNAVAILABLE_STATUSES = new Set(["will_not_fix"]);

function trivyText(value, maximumLength = 512) {
  if (typeof value !== "string" || value === "" || value.length > maximumLength
      || /[\u0000-\u001f\u007f]/.test(value)) failClosed();
  return value;
}

function trivySeverity(value) {
  if (typeof value !== "string") failClosed();
  const severity = value.toLowerCase();
  if (!TRIVY_SEVERITIES.includes(severity)) failClosed();
  return severity;
}

function trivyCollection(result, key) {
  if (!(key in result) || result[key] === null) return [];
  if (!Array.isArray(result[key])) failClosed();
  return result[key];
}

function trivyRemediation(vulnerability) {
  const fixed = vulnerability.FixedVersion;
  const status = vulnerability.Status;
  if (!(status === undefined || status === null || status === "")) trivyText(status, 64);
  if (fixed !== undefined && fixed !== null && fixed !== "") {
    return { fixability: "available", fixedVersion: trivyText(fixed, 512) };
  }
  return {
    fixability: TRIVY_UNAVAILABLE_STATUSES.has(status) ? "unavailable" : "unknown",
    fixedVersion: null,
  };
}

export function normalizeTrivyResult(kind, result) {
  try {
    if (!(["filesystem", "image"].includes(kind))
        || result === null || typeof result !== "object" || Array.isArray(result)
        || result.status !== 0 || result.signal !== null) failClosed();
    const source = safeBufferText(result.stdout, MAX_AUDIT_REPORT_BYTES);
    safeBufferText(result.stderr, MAX_AUDIT_REPORT_BYTES);
    const parsed = JSON.parse(source);
    const expectedArtifact = kind === "filesystem"
      ? { name: "/repository", type: "filesystem" }
      : { name: "/image/archive.tar", type: "container_image" };
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
        || parsed.SchemaVersion !== 2 || parsed.ArtifactName !== expectedArtifact.name
        || parsed.ArtifactType !== expectedArtifact.type
        || !(parsed.Results === null || Array.isArray(parsed.Results))) failClosed();
    const findings = [];
    for (const entry of parsed.Results ?? []) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) failClosed();
      const path = trivyText(entry.Target, 2_048);
      for (const vulnerability of trivyCollection(entry, "Vulnerabilities")) {
        if (vulnerability === null || typeof vulnerability !== "object" || Array.isArray(vulnerability)) failClosed();
        findings.push({
          ...trivyRemediation(vulnerability),
          kind: "vulnerability",
          package: trivyText(vulnerability.PkgName, 512),
          path,
          rule: trivyText(vulnerability.VulnerabilityID, 256),
          severity: trivySeverity(vulnerability.Severity),
          version: trivyText(vulnerability.InstalledVersion, 512),
        });
      }
      for (const misconfiguration of trivyCollection(entry, "Misconfigurations")) {
        if (misconfiguration === null || typeof misconfiguration !== "object" || Array.isArray(misconfiguration)
            || misconfiguration.Status !== "FAIL") failClosed();
        findings.push({
          kind: "misconfiguration",
          path,
          rule: trivyText(misconfiguration.ID, 256),
          severity: trivySeverity(misconfiguration.Severity),
        });
      }
      for (const secret of trivyCollection(entry, "Secrets")) {
        if (secret === null || typeof secret !== "object" || Array.isArray(secret)
            || !Number.isSafeInteger(secret.StartLine) || secret.StartLine < 1) failClosed();
        findings.push({
          kind: "secret",
          line: secret.StartLine,
          path,
          rule: trivyText(secret.RuleID, 256),
          severity: trivySeverity(secret.Severity),
        });
      }
    }
    findings.sort((left, right) => byteCompare(left.path, right.path)
      || byteCompare(left.kind, right.kind) || byteCompare(left.rule, right.rule)
      || (left.line ?? 0) - (right.line ?? 0));
    const counts = { vulnerabilities: 0, secrets: 0, misconfigurations: 0 };
    for (const finding of findings) {
      if (finding.kind === "vulnerability") counts.vulnerabilities += 1;
      else if (finding.kind === "secret") counts.secrets += 1;
      else counts.misconfigurations += 1;
    }
    const blockingCount = findings.filter((finding) => finding.kind === "secret"
      || ((finding.severity === "high" || finding.severity === "critical")
        && (finding.kind === "misconfiguration" || finding.fixability !== "unavailable"))).length;
    return {
      schemaVersion: 1,
      scanner: `trivy-${kind}`,
      scope: kind === "filesystem" ? "repository-snapshot" : "staged-image",
      counts,
      blockingCount,
      ok: blockingCount === 0,
      findings,
    };
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  }
}

function collectionEntries(value) {
  if (Array.isArray(value)) {
    if (value.length !== 0) failClosed();
    return [];
  }
  if (value === null || typeof value !== "object") failClosed();
  return Object.entries(value);
}

function composerPackageName(value) {
  return typeof value === "string" && value.length <= 214
    && /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(value);
}

function composerAdvisoryId(value) {
  if (typeof value !== "string") failClosed();
  const match = /^(?:(PKSA|GHSA)-([a-z0-9]{4})-([a-z0-9]{4})-([a-z0-9]{4})|(CVE)-(\d{4})-(\d{4,}))$/.exec(value);
  if (match === null) failClosed();
  return match[1] === undefined
    ? `${match[5]}-${match[6]}-${match[7]}`
    : `${match[1]}-${match[2]}-${match[3]}-${match[4]}`;
}

function readComposerProjectName(root, manifestPath) {
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readBoundedFile(root, manifestPath)));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
        || !composerPackageName(parsed.name)) failClosed();
    return parsed.name;
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  }
}

export function deriveComposerAuditLockfiles({ root, paths }) {
  try {
    if (typeof root !== "string" || !isAbsolute(root) || !Array.isArray(paths)
        || paths.some((path) => typeof path !== "string") || new Set(paths).size !== paths.length) failClosed();
    const pathSet = new Set(paths);
    for (const { directory, name } of COMPOSER_PROJECTS) {
      const manifest = `${directory}/composer.json`;
      const lockfile = `${directory}/composer.lock`;
      if (!pathSet.has(manifest) || !pathSet.has(lockfile) || readComposerProjectName(root, manifest) !== name) failClosed();
    }
    const excludedReferenceLockfiles = [];
    for (const lockfile of paths.filter((path) => path === "composer.lock" || path.endsWith("/composer.lock")).sort(byteCompare)) {
      if (COMPOSER_LOCKFILES.includes(lockfile)) continue;
      const manifest = lockfile === "composer.lock"
        ? "composer.json"
        : `${lockfile.slice(0, -"composer.lock".length)}composer.json`;
      if (pathSet.has(manifest) && readComposerProjectName(root, manifest).startsWith("8lines/")) failClosed();
      if (!isReferencePath(lockfile)) failClosed();
      excludedReferenceLockfiles.push(lockfile);
    }
    return {
      auditedLockfiles: [...COMPOSER_LOCKFILES],
      excludedReferenceLockfiles,
    };
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  }
}

export function normalizeComposerAuditResult(lockfile, result) {
  try {
    if (!COMPOSER_LOCKFILES.includes(lockfile)
        || result === null || typeof result !== "object" || Array.isArray(result)
        || ![0, 1].includes(result.status) || result.signal !== null) failClosed();
    const source = safeBufferText(result.stdout, MAX_AUDIT_REPORT_BYTES);
    safeBufferText(result.stderr, MAX_AUDIT_REPORT_BYTES);
    const parsed = JSON.parse(source);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
        || !("advisories" in parsed) || !("abandoned" in parsed) || !("filter" in parsed)) failClosed();
    if (("ignored-advisories" in parsed && collectionEntries(parsed["ignored-advisories"]).length !== 0)
        || ("unreachable-repositories" in parsed
          && collectionEntries(parsed["unreachable-repositories"]).length !== 0)
        || collectionEntries(parsed.filter).length !== 0) failClosed();

    const vulnerabilities = [];
    const identities = new Set();
    for (const [packageName, advisories] of collectionEntries(parsed.advisories)) {
      if (!composerPackageName(packageName) || !Array.isArray(advisories) || advisories.length === 0) failClosed();
      for (const advisory of advisories) {
        if (advisory === null || typeof advisory !== "object" || Array.isArray(advisory)
            || advisory.packageName !== packageName
            || !(advisory.severity === null
              || ["low", "medium", "moderate", "high", "critical"].includes(advisory.severity))) failClosed();
        const id = composerAdvisoryId(advisory.advisoryId);
        const identity = `${packageName}\0${id}`;
        if (identities.has(identity)) failClosed();
        identities.add(identity);
        vulnerabilities.push({
          id,
          package: packageName,
          severity: advisory.severity ?? "unknown",
        });
      }
    }
    vulnerabilities.sort((left, right) => byteCompare(left.package, right.package)
      || byteCompare(left.id, right.id));

    const abandonedPackages = [];
    for (const [packageName, replacement] of collectionEntries(parsed.abandoned)) {
      if (!composerPackageName(packageName)
          || !(replacement === null || composerPackageName(replacement))) failClosed();
      abandonedPackages.push({ package: packageName, replacementAvailable: replacement !== null });
    }
    abandonedPackages.sort((left, right) => byteCompare(left.package, right.package));
    const blockingCount = vulnerabilities.length + abandonedPackages.length;
    if (result.status !== (blockingCount === 0 ? 0 : 1)) failClosed();
    return {
      lockfile,
      advisoryCount: vulnerabilities.length,
      abandonedCount: abandonedPackages.length,
      blockingCount,
      ok: blockingCount === 0,
      vulnerabilities,
      abandonedPackages,
    };
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  }
}

function validateCanonicalDirectory(path) {
  try {
    if (typeof path !== "string" || !isAbsolute(path) || path === sep || resolve(path) !== path
        || /[\u0000-\u001f\u007f]/.test(path)) failClosed();
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) failClosed();
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  }
}

function ensureSafeDirectory(path, { privateDirectory = true } = {}) {
  try {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const stat = lstatSync(path);
    const effectiveUid = typeof process.geteuid === "function" ? process.geteuid() : stat.uid;
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path
        || stat.uid !== effectiveUid || (stat.mode & (privateDirectory ? 0o077 : 0o022)) !== 0) failClosed();
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  }
}

function exactFileDigest(path, maximumBytes) {
  let descriptor;
  try {
    if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path || path === sep
        || path.includes(",") || /[\u0000-\u001f\u007f]/.test(path) || realpathSync(path) !== path) failClosed();
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size <= 0n
        || before.size > BigInt(maximumBytes)) failClosed();
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!sameRegularFile(before, opened)) failClosed();
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let total = 0;
    while (true) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      total += count;
      if (!Number.isSafeInteger(total) || total > maximumBytes) failClosed();
      hash.update(buffer.subarray(0, count));
    }
    const after = fstatSync(descriptor, { bigint: true });
    const pathname = lstatSync(path, { bigint: true });
    if (BigInt(total) !== opened.size || !sameRegularFile(opened, after)
        || !sameRegularFile(after, pathname) || realpathSync(path) !== path) failClosed();
    return Object.freeze({
      path,
      size: total,
      sha256: hash.digest("hex"),
      identity: statIdentity(after),
    });
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

const STAGED_IMAGE_ARCHIVE = /^\.artifacts\/release\/([A-Za-z0-9.-]+)\/image\/gauntlet-((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))\.docker\.tar$/u;

// The release directory is always a release-set id; the archive name carries the gauntlet version.
function stagedImageArchivePath(relativePath) {
  const match = typeof relativePath === "string" ? STAGED_IMAGE_ARCHIVE.exec(relativePath) : null;
  if (match === null) return null;
  const [, directory, version] = match;
  try {
    parseReleaseSetId(directory);
  } catch {
    return null;
  }
  return Object.freeze({ directory, version });
}

export function validateStagedImageArchive(root, imageArchive) {
  try {
    validateCanonicalDirectory(root);
    const version = readReleaseVersion(root);
    if (typeof imageArchive !== "string" || !imageArchive.startsWith(`${root}${sep}`)) failClosed();
    const relativePath = imageArchive.slice(root.length + 1).split(sep).join("/");
    const staged = stagedImageArchivePath(relativePath);
    if (staged === null || staged.version !== version || imageArchive !== resolve(root, relativePath)) failClosed();
    const record = exactFileDigest(imageArchive, MAX_IMAGE_ARCHIVE_BYTES);
    const stat = lstatSync(imageArchive, { bigint: true });
    if ((stat.mode & 0o077n) !== 0n) failClosed();
    return Object.freeze({ ...record, relativePath });
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  }
}

function verifyStagedImageArchive(expected) {
  const current = exactFileDigest(expected.path, MAX_IMAGE_ARCHIVE_BYTES);
  if (current.sha256 !== expected.sha256 || current.size !== expected.size
      || !sameIdentity(current.identity, expected.identity)) failClosed();
}

function createPnpmAuditSnapshot(repositorySnapshot, workspace, paths) {
  const directory = resolve(workspace, "pnpm-audit");
  ensureSafeDirectory(directory);
  const selected = paths.filter((path) => path === "package.json" || path === "pnpm-lock.yaml"
    || path === "pnpm-workspace.yaml" || path.endsWith("/package.json")).sort(byteCompare);
  if (!selected.includes("package.json") || !selected.includes("pnpm-lock.yaml")) failClosed();
  const directories = new Set();
  const records = [];
  for (const path of selected) {
    ensureSnapshotParent(directory, path, directories);
    const bytes = readBoundedFile(repositorySnapshot, path);
    writeFileSync(resolve(directory, path), bytes, { flag: "wx", mode: 0o600 });
    records.push(Object.freeze({ path, sha256: sha256(bytes) }));
  }
  const npmrcPath = ".npmrc";
  writeFileSync(resolve(directory, npmrcPath), FIXED_NPMRC, { flag: "wx", mode: 0o600 });
  records.push(Object.freeze({ path: npmrcPath, sha256: sha256(Buffer.from(FIXED_NPMRC)) }));
  sealSnapshot(directory, records, directories);
  verifyPnpmAuditSnapshot(directory, records);
  return Object.freeze({ directory, records: Object.freeze(records), userconfig: resolve(directory, npmrcPath) });
}

function verifyPnpmAuditSnapshot(directory, records) {
  for (const record of records) {
    const stat = lstatSync(resolve(directory, record.path), { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || (stat.mode & 0o777n) !== 0o400n
        || sha256(readBoundedFile(directory, record.path)) !== record.sha256) failClosed();
  }
}

function safeDockerMountSource(path) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path
      || path.includes(",") || path.includes("\0")) failClosed();
  return path;
}

function trivyArguments({ configDirectory, imageArchive, kind, repositorySnapshot }) {
  if (!(["filesystem", "image"].includes(kind))) failClosed();
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const gid = typeof process.getgid === "function" ? process.getgid() : 0;
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) failClosed();
  const inputMount = kind === "filesystem"
    ? `type=bind,src=${safeDockerMountSource(repositorySnapshot)},dst=/repository,readonly`
    : `type=bind,src=${safeDockerMountSource(imageArchive)},dst=/image/archive.tar,readonly`;
  const command = kind === "filesystem" ? "filesystem" : "image";
  return [
    "run", "--rm", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--network", "bridge", "--user", `${uid}:${gid}`,
    "--env", "HOME=/tmp/home", "--env", "TRIVY_CACHE_DIR=/tmp/trivy-cache",
    "--mount", inputMount,
    "--mount", `type=bind,src=${safeDockerMountSource(configDirectory)},dst=/trivy-config,readonly`,
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=2147483648,mode=1777",
    TRIVY_IMAGE,
    "--config", "/trivy-config/config.yaml", "--cache-dir", "/tmp/trivy-cache", "--quiet", "--timeout", "5m0s",
    command,
    "--format", "json", "--exit-code", "0",
    "--scanners", "vuln,misconfig,secret", "--ignorefile", "/trivy-config/ignore", "--skip-version-check",
    ...(kind === "filesystem" ? ["--include-dev-deps", "/repository"] : ["--input", "/image/archive.tar"]),
  ];
}

function initialCheckReport(scanner, scope) {
  return {
    schemaVersion: 1,
    scanner,
    ...(scope === undefined ? {} : { scope }),
    status: "not-run",
    reason: "gate-incomplete",
    ok: false,
  };
}

function checkSummary(name, report, required = true) {
  if (report.status === "not-run") {
    return { name, required, status: "not-run", reason: report.reason };
  }
  return { name, required, status: report.ok === true ? "passed" : "failed" };
}

function securitySummary({ composer, credentials, mode, pnpm, productionDefaults, sourceCommit, sourceSnapshot,
  trivyFilesystem, trivyImage }) {
  const checks = [
    checkSummary("source-snapshot", sourceSnapshot),
    checkSummary("composer-audit", composer),
    checkSummary("credential-material", credentials),
    checkSummary("pnpm-audit", pnpm),
    checkSummary("production-defaults", productionDefaults),
    checkSummary("trivy-filesystem", trivyFilesystem),
    checkSummary("trivy-image", trivyImage, mode === "release"),
  ];
  const sourceChecksOk = [sourceSnapshot, composer, credentials, pnpm, productionDefaults, trivyFilesystem]
    .every((report) => report.ok === true);
  return {
    schemaVersion: 1,
    mode,
    scope: mode === "release" ? "exact-commit-and-staged-image" : "working-tree-snapshot",
    ...(sourceCommit === undefined ? {} : { sourceCommit }),
    sourceChecksOk,
    ok: mode === "release" && sourceChecksOk && trivyImage.ok === true,
    checks,
    reports: REPORT_NAMES,
  };
}

function writeSecurityState(outputDirectory, state) {
  writeReport(outputDirectory, "composer-audit.json", state.composer);
  writeReport(outputDirectory, "credential-material.json", state.credentials);
  writeReport(outputDirectory, "pnpm-audit.json", state.pnpm);
  writeReport(outputDirectory, "production-defaults.json", state.productionDefaults);
  writeReport(outputDirectory, "source-snapshot.json", state.sourceSnapshot);
  writeReport(outputDirectory, "trivy-filesystem.json", state.trivyFilesystem);
  writeReport(outputDirectory, "trivy-image.json", state.trivyImage);
  const summary = securitySummary(state);
  writeReport(outputDirectory, "summary.json", summary);
  return summary;
}

function invalidateSecuritySummary(outputDirectory, state) {
  const path = resolve(outputDirectory, "summary.json");
  try {
    try {
      const stat = lstatSync(path);
      if (stat.isDirectory()) failClosed();
      rmSync(path);
    } catch (error) {
      if (error instanceof Error && error.message === FAILURE) throw error;
      if (error?.code !== "ENOENT") throw error;
    }
    writeFileSync(path, jsonBytes(securitySummary(state)), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  }
}

function assertOnlyManagedReports(outputDirectory) {
  const managed = new Set([...REPORT_NAMES, "summary.json"]);
  const effectiveUid = typeof process.geteuid === "function" ? process.geteuid() : undefined;
  for (const name of readdirSync(outputDirectory)) {
    if (!managed.has(name)) failClosed();
    const stat = lstatSync(resolve(outputDirectory, name));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
        || (effectiveUid !== undefined && stat.uid !== effectiveUid) || (stat.mode & 0o077) !== 0) failClosed();
  }
}

function stageComposerAuditInputs(root, workspace, lockfiles) {
  const staged = [];
  if (!Array.isArray(lockfiles) || lockfiles.length !== COMPOSER_LOCKFILES.length
      || lockfiles.some((lockfile, index) => lockfile !== COMPOSER_LOCKFILES[index])) failClosed();
  for (let index = 0; index < lockfiles.length; index += 1) {
    const lockfile = lockfiles[index];
    const directory = resolve(workspace, `composer-audit-${index}`);
    ensureSafeDirectory(directory);
    writeFileSync(resolve(directory, "composer.json"), COMPOSER_AUDIT_MANIFEST, { flag: "wx", mode: 0o600 });
    writeFileSync(resolve(directory, "composer.lock"), readBoundedFile(root, lockfile), { flag: "wx", mode: 0o600 });
    staged.push({ directory, lockfile });
  }
  return staged;
}

function composerAuditArguments(directory) {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const gid = typeof process.getgid === "function" ? process.getgid() : 0;
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0
      || typeof directory !== "string" || directory.includes(",") || directory.includes("\0")) failClosed();
  return [
    "run", "--rm", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--network", "bridge", "--user", `${uid}:${gid}`,
    "--env", "HOME=/tmp/home", "--env", "COMPOSER_HOME=/tmp/composer",
    "--env", "COMPOSER_CACHE_DIR=/tmp/composer-cache", "--env", "COMPOSER_NO_INTERACTION=1",
    "--env", "COMPOSER_PROCESS_TIMEOUT=60", "--env", "CI=1",
    "--mount", `type=bind,src=${directory},dst=/audit,readonly`,
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=67108864,mode=1777",
    "--workdir", "/audit",
    COMPOSER_IMAGE,
    "composer", "audit", "--locked", "--no-interaction", "--format=json", "--abandoned=fail",
    "--no-plugins", "--no-scripts",
  ];
}

function composerAuditReport(auditedLockfiles, excludedReferenceLockfiles) {
  if (!Array.isArray(auditedLockfiles) || auditedLockfiles.length !== COMPOSER_LOCKFILES.length
      || auditedLockfiles.some(({ lockfile }, index) => lockfile !== COMPOSER_LOCKFILES[index])
      || !Array.isArray(excludedReferenceLockfiles)
      || excludedReferenceLockfiles.some((lockfile) => typeof lockfile !== "string" || !isReferencePath(lockfile))) {
    failClosed();
  }
  const advisoryCount = auditedLockfiles.reduce((total, report) => total + report.advisoryCount, 0);
  const abandonedCount = auditedLockfiles.reduce((total, report) => total + report.abandonedCount, 0);
  const blockingCount = auditedLockfiles.reduce((total, report) => total + report.blockingCount, 0);
  return {
    schemaVersion: 1,
    scanner: "composer-audit",
    scope: "all-locked-dependencies",
    excludedReferenceLockfiles,
    auditedLockfiles,
    advisoryCount,
    abandonedCount,
    blockingCount,
    ok: blockingCount === 0,
  };
}

function parseGitPathList(bytes) {
  const source = safeBufferText(bytes, MAX_AUDIT_REPORT_BYTES);
  if (source === "" || !source.endsWith("\0")) failClosed();
  const paths = source.slice(0, -1).split("\0");
  if (paths.length === 0 || new Set(paths).size !== paths.length) failClosed();
  for (const path of paths) validateRelativePath(path);
  return paths.sort(byteCompare);
}

function checkedCommandResult(result) {
  if (result === null || typeof result !== "object" || result.status !== 0 || result.signal !== null) failClosed();
  safeBufferText(result.stderr, MAX_AUDIT_REPORT_BYTES);
  return safeBufferText(result.stdout, MAX_AUDIT_REPORT_BYTES);
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeReport(outputDirectory, name, value) {
  const temporary = resolve(outputDirectory, `.${name}.tmp`);
  try {
    try {
      lstatSync(temporary);
      failClosed();
    } catch (error) {
      if (error instanceof Error && error.message === FAILURE) throw error;
      if (error?.code !== "ENOENT") throw error;
    }
    writeFileSync(temporary, jsonBytes(value), { flag: "wx", mode: 0o600 });
    renameSync(temporary, resolve(outputDirectory, name));
  } catch (error) {
    try {
      const stat = lstatSync(temporary);
      if (stat.isFile() && !stat.isSymbolicLink()) rmSync(temporary);
    } catch {
      // Cleanup is best effort; the gate still fails closed.
    }
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  }
}

function assertPinnedPnpm(root, paths) {
  if (!paths.includes("package.json") || !paths.includes("pnpm-lock.yaml")) failClosed();
  try {
    const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readBoundedFile(root, "package.json")));
    if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)
        || manifest.packageManager !== "pnpm@11.24.0") failClosed();
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  }
}

function closedSecurityOptions(options) {
  try {
    if (options === null || typeof options !== "object" || Array.isArray(options)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) failClosed();
    const descriptors = Object.getOwnPropertyDescriptors(options);
    const mode = descriptors.mode?.value;
    const expected = mode === "source-only"
      ? ["root", "outputDirectory", "environment", "run", "mode"]
      : ["root", "outputDirectory", "environment", "run", "mode", "imageArchive"];
    const keys = Reflect.ownKeys(descriptors);
    if (!(["release", "source-only"].includes(mode)) || keys.length !== expected.length
        || expected.some((key) => !keys.includes(key))
        || keys.some((key) => typeof key !== "string" || !expected.includes(key)
          || descriptors[key].enumerable !== true || !("value" in descriptors[key]))) failClosed();
    return Object.freeze(Object.fromEntries(expected.map((key) => [key, descriptors[key].value])));
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  }
}

function gitPathArguments(root, mode) {
  return mode === "release"
    ? ["-C", root, "ls-files", "-z", "--cached", "--", ".", ":(exclude).artifacts/**"]
    : ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ".",
      ":(exclude).artifacts/**"];
}

async function readGitView(invoke, root, mode) {
  const topLevel = checkedCommandResult(await invoke("git", ["-C", root, "rev-parse", "--show-toplevel"]));
  if (topLevel !== `${root}\n`) failClosed();
  const sourceCommit = checkedCommandResult(await invoke(
    "git", ["-C", root, "rev-parse", "--verify", "HEAD^{commit}"],
  ));
  if (!/^[0-9a-f]{40}\n$/.test(sourceCommit)) failClosed();
  if (mode === "release") {
    const status = checkedCommandResult(await invoke("git", [
      "-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ".",
      ":(exclude).artifacts/**",
    ]));
    if (status !== "") failClosed();
  }
  const listed = checkedCommandResult(await invoke("git", gitPathArguments(root, mode)));
  return Object.freeze({
    sourceCommit: sourceCommit.slice(0, -1),
    paths: Object.freeze(parseGitPathList(Buffer.from(listed, "utf8"))),
  });
}

function samePaths(left, right) {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

function failedScannerReport(scanner, scope, reason = "scanner-failed") {
  return {
    schemaVersion: 1,
    scanner,
    ...(scope === undefined ? {} : { scope }),
    status: "failed",
    reason,
    ok: false,
  };
}

function snapshotTreeSha256(records) {
  const hash = createHash("sha256");
  for (const record of records) hash.update(record.path).update("\0").update(record.sha256).update("\n");
  return hash.digest("hex");
}

export async function runReleaseSecurity(options) {
  let workspace;
  let state;
  let outputDirectory;
  try {
    const values = closedSecurityOptions(options);
    const { environment, imageArchive, mode, root, run } = values;
    outputDirectory = values.outputDirectory;
    validateCanonicalDirectory(root);
    if (outputDirectory !== resolve(root, ".artifacts/security")) failClosed();
    const artifacts = resolve(root, ".artifacts");
    ensureSafeDirectory(artifacts, { privateDirectory: false });
    ensureSafeDirectory(outputDirectory);
    state = {
      mode,
      sourceCommit: undefined,
      sourceSnapshot: initialCheckReport("source-snapshot", mode === "release" ? "exact-commit" : "working-tree"),
      composer: initialCheckReport("composer-audit", "all-locked-dependencies"),
      credentials: initialCheckReport("credential-material"),
      pnpm: initialCheckReport("pnpm-audit", "production"),
      productionDefaults: initialCheckReport("production-defaults"),
      trivyFilesystem: initialCheckReport("trivy-filesystem", "repository-snapshot"),
      trivyImage: {
        ...initialCheckReport("trivy-image", "staged-image"),
        reason: mode === "source-only" ? "excluded-by-source-only-mode" : "release-image-not-provided",
      },
    };
    invalidateSecuritySummary(outputDirectory, state);
    assertOnlyManagedReports(outputDirectory);
    writeSecurityState(outputDirectory, state);
    if (typeof environment?.PATH !== "string" || environment.PATH === "" || environment.PATH.includes("\0")
        || typeof run !== "function") failClosed();

    const temporaryRoot = realpathSync(tmpdir());
    validateCanonicalDirectory(temporaryRoot);
    workspace = realpathSync(mkdtempSync(resolve(temporaryRoot, "gauntlet-release-security-")));
    chmodSync(workspace, 0o700);
    ensureSafeDirectory(workspace);
    for (const name of ["home", "tmp", "cache"]) ensureSafeDirectory(resolve(workspace, name));
    const fixedUserconfig = resolve(workspace, "npmrc");
    writeFileSync(fixedUserconfig, FIXED_NPMRC, { flag: "wx", mode: 0o600 });
    const trivyConfig = resolve(workspace, "trivy-config");
    ensureSafeDirectory(trivyConfig);
    writeFileSync(resolve(trivyConfig, "config.yaml"), "{}\n", { flag: "wx", mode: 0o400 });
    writeFileSync(resolve(trivyConfig, "ignore"), "", { flag: "wx", mode: 0o400 });
    chmodSync(trivyConfig, 0o500);
    const commandEnvironment = sanitizedSecurityEnvironment(environment, {
      home: resolve(workspace, "home"),
      temporary: resolve(workspace, "tmp"),
      cache: resolve(workspace, "cache"),
      userconfig: fixedUserconfig,
    });
    const invoke = async (command, args, timeoutMs = 30_000, workingDirectory = root) => await run({
      command,
      args,
      environment: commandEnvironment,
      timeoutMs,
      workingDirectory,
    });

    const gitView = await readGitView(invoke, root, mode);
    state.sourceCommit = gitView.sourceCommit;
    const repositorySnapshot = resolve(workspace, "repository");
    const snapshotRecords = createRepositorySnapshot(root, repositorySnapshot, gitView.paths);
    state.sourceSnapshot = {
      schemaVersion: 1,
      scanner: "source-snapshot",
      scope: mode === "release" ? "exact-commit" : "working-tree",
      sourceCommit: gitView.sourceCommit,
      files: snapshotRecords.length,
      treeSha256: snapshotTreeSha256(snapshotRecords),
      ok: true,
    };

    let stagedImage;
    if (mode === "release" && imageArchive !== undefined) stagedImage = validateStagedImageArchive(root, imageArchive);
    const failSnapshotIntegrity = () => {
      state.sourceSnapshot = failedScannerReport(
        "source-snapshot", mode === "release" ? "exact-commit" : "working-tree", "source-mutated",
      );
      writeSecurityState(outputDirectory, state);
      failClosed();
    };
    const verifyLocalSnapshot = () => {
      try {
        verifyRepositorySnapshot(root, repositorySnapshot, snapshotRecords);
      } catch {
        failSnapshotIntegrity();
      }
    };

    let composerInventory;
    try {
      composerInventory = deriveComposerAuditLockfiles({ root: repositorySnapshot, paths: gitView.paths });
    } catch {
      state.composer = failedScannerReport("composer-audit", "all-locked-dependencies", "lockfile-coverage-invalid");
      writeSecurityState(outputDirectory, state);
      failClosed();
    }
    const staticReport = scanRepositoryFiles({ root: repositorySnapshot, paths: gitView.paths });
    assertPinnedPnpm(repositorySnapshot, gitView.paths);
    state.credentials = {
      schemaVersion: 1,
      scanner: "credential-material",
      scannedFiles: staticReport.scannedFiles,
      findings: staticReport.credentials,
      ok: staticReport.credentials.length === 0,
    };
    state.productionDefaults = {
      schemaVersion: 1,
      scanner: "production-defaults",
      scannedFiles: staticReport.productionDefaultFiles,
      findings: staticReport.unsafeProductionDefaults,
      ok: staticReport.unsafeProductionDefaults.length === 0,
    };
    if (!state.credentials.ok || !state.productionDefaults.ok) {
      state.pnpm = { ...initialCheckReport("pnpm-audit", "production"), reason: "repository-static-failed" };
      state.composer = {
        ...initialCheckReport("composer-audit", "all-locked-dependencies"), reason: "repository-static-failed",
      };
      state.trivyFilesystem = {
        ...initialCheckReport("trivy-filesystem", "repository-snapshot"), reason: "repository-static-failed",
      };
      writeSecurityState(outputDirectory, state);
      failClosed();
    }

    const pnpmSnapshot = createPnpmAuditSnapshot(repositorySnapshot, workspace, gitView.paths);
    const composerInputs = stageComposerAuditInputs(
      repositorySnapshot,
      workspace,
      composerInventory.auditedLockfiles,
    );
    let pnpmResult;
    try {
      pnpmResult = await invoke(
        "pnpm",
        [
          "--config.registry=https://registry.npmjs.org/",
          `--config.userconfig=${fixedUserconfig}`,
          "--ignore-workspace",
          "audit", "--prod", "--audit-level", "low", "--json",
        ],
        60_000,
        pnpmSnapshot.directory,
      );
    } catch {
      state.pnpm = failedScannerReport("pnpm-audit", "production");
    }
    if (pnpmResult !== undefined) {
      verifyLocalSnapshot();
      try {
        verifyPnpmAuditSnapshot(pnpmSnapshot.directory, pnpmSnapshot.records);
        state.pnpm = normalizePnpmAuditResult(pnpmResult);
      } catch {
        state.pnpm = failedScannerReport("pnpm-audit", "production");
      }
    }

    const auditedLockfiles = [];
    let composerFailed = false;
    for (const { directory, lockfile } of composerInputs) {
      let result;
      try {
        result = await invoke("docker", composerAuditArguments(directory), 90_000, workspace);
      } catch {
        composerFailed = true;
      }
      if (result !== undefined) {
        verifyLocalSnapshot();
        try {
          auditedLockfiles.push(normalizeComposerAuditResult(lockfile, result));
        } catch {
          composerFailed = true;
        }
      }
    }
    if (composerFailed) {
      state.composer = failedScannerReport("composer-audit", "all-locked-dependencies");
    } else {
      state.composer = composerAuditReport(auditedLockfiles, composerInventory.excludedReferenceLockfiles);
    }

    let trivyFilesystemResult;
    try {
      trivyFilesystemResult = await invoke("docker", trivyArguments({
        configDirectory: trivyConfig,
        kind: "filesystem",
        repositorySnapshot,
      }), 360_000, workspace);
    } catch {
      state.trivyFilesystem = failedScannerReport("trivy-filesystem", "repository-snapshot");
    }
    if (trivyFilesystemResult !== undefined) {
      verifyLocalSnapshot();
      try {
        state.trivyFilesystem = normalizeTrivyResult("filesystem", trivyFilesystemResult);
      } catch {
        state.trivyFilesystem = failedScannerReport("trivy-filesystem", "repository-snapshot");
      }
    }

    if (mode === "release" && stagedImage !== undefined) {
      let trivyImageResult;
      try {
        verifyStagedImageArchive(stagedImage);
        trivyImageResult = await invoke("docker", trivyArguments({
          configDirectory: trivyConfig,
          imageArchive: stagedImage.path,
          kind: "image",
        }), 360_000, workspace);
      } catch {
        state.trivyImage = failedScannerReport("trivy-image", "staged-image");
      }
      if (trivyImageResult !== undefined) {
        try {
          verifyStagedImageArchive(stagedImage);
        } catch {
          state.trivyImage = failedScannerReport("trivy-image", "staged-image", "artifact-mutated");
          writeSecurityState(outputDirectory, state);
          failClosed();
        }
        verifyLocalSnapshot();
        try {
          state.trivyImage = {
            ...normalizeTrivyResult("image", trivyImageResult),
            artifact: {
              path: stagedImage.relativePath,
              sha256: stagedImage.sha256,
              size: stagedImage.size,
            },
          };
        } catch {
          state.trivyImage = failedScannerReport("trivy-image", "staged-image");
        }
      }
    }

    verifyLocalSnapshot();
    let finalGitView;
    try {
      finalGitView = await readGitView(invoke, root, mode);
    } catch {
      failSnapshotIntegrity();
    }
    if (finalGitView.sourceCommit !== gitView.sourceCommit || !samePaths(finalGitView.paths, gitView.paths)) {
      failSnapshotIntegrity();
    }
    if (stagedImage !== undefined) {
      try {
        verifyStagedImageArchive(stagedImage);
      } catch {
        state.trivyImage = failedScannerReport("trivy-image", "staged-image", "artifact-mutated");
        writeSecurityState(outputDirectory, state);
        failClosed();
      }
    }
    const summary = writeSecurityState(outputDirectory, state);
    if (mode === "release" ? !summary.ok : !summary.sourceChecksOk) failClosed();
    return summary;
  } catch (error) {
    if (error instanceof Error && error.message === FAILURE) throw error;
    failClosed();
  } finally {
    if (workspace !== undefined) {
      makeSnapshotWritable(workspace);
      try {
        rmSync(workspace, { force: true, recursive: true });
      } catch {
        // Cleanup is best effort and scoped to the uniquely created workspace.
      }
    }
  }
}

export function createSecurityProcessRunner({
  maximumOutputBytes = MAX_AUDIT_REPORT_BYTES,
  terminationGraceMs = 1_000,
} = {}) {
  if (!Number.isSafeInteger(maximumOutputBytes) || maximumOutputBytes < 1
      || !Number.isSafeInteger(terminationGraceMs) || terminationGraceMs < 1) {
    throw new TypeError("Security process limits must be positive integers");
  }
  return async function run({ command, args, environment, timeoutMs, workingDirectory }) {
    if (typeof command !== "string" || command === "" || /[\u0000-\u001f\u007f]/.test(command)
        || !Array.isArray(args) || args.some((argument) => typeof argument !== "string" || argument.includes("\0"))
        || environment === null || typeof environment !== "object" || Array.isArray(environment)
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1
        || typeof workingDirectory !== "string" || !isAbsolute(workingDirectory)) {
      throw new Error(COMMAND_FAILURE);
    }
    return await new Promise((resolvePromise, rejectPromise) => {
      let child;
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let failure;
      let killTimer;
      const fail = () => {
        if (failure !== undefined) return;
        failure = new Error(COMMAND_FAILURE);
        try {
          if (process.platform === "win32" || child?.pid === undefined) child?.kill("SIGTERM");
          else process.kill(-child.pid, "SIGTERM");
        } catch {
          try {
            child?.kill("SIGTERM");
          } catch {
            // The process may already have exited.
          }
        }
        killTimer = setTimeout(() => {
          try {
            if (process.platform === "win32" || child?.pid === undefined) child?.kill("SIGKILL");
            else process.kill(-child.pid, "SIGKILL");
          } catch {
            try {
              child?.kill("SIGKILL");
            } catch {
              // The process may already have exited.
            }
          }
        }, terminationGraceMs);
        killTimer.unref();
      };
      try {
        child = spawn(command, args, {
          cwd: workingDirectory,
          detached: process.platform !== "win32",
          env: environment,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch {
        rejectPromise(new Error(COMMAND_FAILURE));
        return;
      }
      const append = (current, chunk) => {
        if (stdout.length + stderr.length + chunk.length > maximumOutputBytes) {
          fail();
          return current;
        }
        return Buffer.concat([current, chunk]);
      };
      child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
      child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
      const deadline = setTimeout(fail, timeoutMs);
      deadline.unref();
      child.once("error", fail);
      child.once("close", (status, signal) => {
        clearTimeout(deadline);
        clearTimeout(killTimer);
        if (failure !== undefined) {
          rejectPromise(failure);
          return;
        }
        resolvePromise({ status, signal, stdout, stderr });
      });
    });
  };
}

const SECURITY_USAGE = "Usage: security.mjs [--source-only | --image-archive <path>]";

export function parseSecurityArguments(argv) {
  if (!Array.isArray(argv) || argv.some((argument) => typeof argument !== "string")) {
    throw new TypeError(SECURITY_USAGE);
  }
  if (argv.length === 0) return { mode: "release", imageArchive: undefined };
  if (argv.length === 1 && argv[0] === "--source-only") return { mode: "source-only" };
  if (argv.length === 2 && argv[0] === "--image-archive" && stagedImageArchivePath(argv[1]) !== null) {
    return { mode: "release", imageArchive: argv[1] };
  }
  throw new TypeError(SECURITY_USAGE);
}

export async function runSecurityCli(argv, options) {
  let parsed;
  try {
    parsed = parseSecurityArguments(argv);
  } catch {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `${JSON.stringify({ error: { code: "INVALID_ARGUMENTS", message: SECURITY_USAGE }, ok: false })}\n`,
    };
  }
  try {
    const base = options;
    if (base === null || typeof base !== "object" || Array.isArray(base)) failClosed();
    const summary = await runReleaseSecurity(parsed.mode === "source-only" ? {
      root: base.root,
      outputDirectory: base.outputDirectory,
      environment: base.environment,
      run: base.run,
      mode: "source-only",
    } : {
      root: base.root,
      outputDirectory: base.outputDirectory,
      environment: base.environment,
      run: base.run,
      mode: "release",
      imageArchive: parsed.imageArchive === undefined ? undefined : resolve(base.root, parsed.imageArchive),
    });
    return { exitCode: 0, stdout: `${JSON.stringify(summary)}\n`, stderr: "" };
  } catch {
    return {
      exitCode: 1,
      stdout: "",
      stderr: '{"error":{"code":"RELEASE_SECURITY_FAILED","message":"Release security gate failed safely"},"ok":false}\n',
    };
  }
}

export function sanitizedSecurityEnvironment(source, workspace) {
  return {
    PATH: source.PATH,
    HOME: workspace.home,
    TMPDIR: workspace.temporary,
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    CI: "true",
    NO_COLOR: "1",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    PNPM_CONFIG_USERCONFIG: workspace.userconfig,
    PNPM_CONFIG_CACHE_DIR: workspace.cache,
    PNPM_CONFIG_IGNORE_SCRIPTS: "true",
    PNPM_CONFIG_UPDATE_NOTIFIER: "false",
    PNPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
  };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = await runSecurityCli(process.argv.slice(2), {
    root: REPOSITORY_ROOT,
    outputDirectory: resolve(REPOSITORY_ROOT, ".artifacts/security"),
    environment: process.env,
    run: createSecurityProcessRunner(),
  });
  if (result.stdout !== "") process.stdout.write(result.stdout);
  if (result.stderr !== "") process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
