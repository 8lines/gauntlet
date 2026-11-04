// Publishes one staged Maven unit to Maven Central through the Central Publisher API.
//
// The bundle is built from the bytes the release already staged and verified, so the published jar
// is the staged jar. The credentials arrive as per-command environment variables:
//   MAVEN_CENTRAL_TOKEN  "username:password" of a Central Portal user token
//   MAVEN_SIGNING_KEY    ASCII-armored private key without a passphrase
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { crc32 } from "node:zlib";

import { RELEASE_ARTIFACTS } from "./release-model.mjs";

const run = promisify(execFile);
const CENTRAL_API = "https://central.sonatype.com/api/v1/publisher";
const ARTIFACT_IDS = Object.freeze({ "java-core": "core", "spring-boot-starter": "spring-boot-starter" });
const PRIMARY_SUFFIXES = Object.freeze([".jar", "-sources.jar", "-javadoc.jar", ".pom", ".module"]);
const CHECKSUMS = Object.freeze([["md5", ".md5"], ["sha1", ".sha1"], ["sha256", ".sha256"], ["sha512", ".sha512"]]);
const IN_PROGRESS = new Set(["PENDING", "VALIDATING", "VALIDATED", "PUBLISHING"]);

export function repositoryPath(unit, version) {
  const artifactId = ARTIFACT_IDS[unit];
  if (artifactId === undefined) throw new TypeError(`Unknown Maven unit: ${unit}`);
  const record = RELEASE_ARTIFACTS.maven.find(({ name }) => name.endsWith(`:${artifactId}`));
  const [group] = record.name.split(":");
  return { artifactId, path: `${group.replaceAll(".", "/")}/${artifactId}/${version}`, repository: record.repository };
}

// Every primary file travels with its detached signature, and both with their checksums.
export async function bundleEntries({ unit, version, primaries, sign }) {
  const { artifactId, path } = repositoryPath(unit, version);
  const entries = [];
  const add = (name, bytes) => {
    entries.push({ name: `${path}/${name}`, bytes });
    for (const [algorithm, extension] of CHECKSUMS) {
      entries.push({
        name: `${path}/${name}${extension}`,
        bytes: Buffer.from(createHash(algorithm).update(bytes).digest("hex"), "ascii"),
      });
    }
  };
  for (const suffix of PRIMARY_SUFFIXES) {
    const name = `${artifactId}-${version}${suffix}`;
    const bytes = primaries.get(name);
    if (bytes === undefined) throw new Error(`Staged Maven file is missing: ${name}`);
    add(name, bytes);
    add(`${name}.asc`, await sign(bytes));
  }
  return entries;
}

// A stored (uncompressed) archive: jars are already compressed, and it needs no dependency.
export function zipStored(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, bytes } of entries) {
    const encodedName = Buffer.from(name, "utf8");
    const checksum = crc32(bytes);
    const fields = (header) => {
      header.writeUInt16LE(20, 0);
      header.writeUInt16LE(0x0800, 2);
      header.writeUInt16LE(0, 4);
      header.writeUInt32LE(0x00210000, 6);
      header.writeUInt32LE(checksum, 10);
      header.writeUInt32LE(bytes.length, 14);
      header.writeUInt32LE(bytes.length, 18);
      header.writeUInt16LE(encodedName.length, 22);
      header.writeUInt16LE(0, 24);
      return header;
    };
    const local = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), fields(Buffer.alloc(26)), encodedName, bytes]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    fields(Buffer.alloc(26)).copy(central, 6);
    central.writeUInt32LE(offset, 42);
    locals.push(local);
    centrals.push(Buffer.concat([central, encodedName]));
    offset += local.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function authorization(token) {
  if (typeof token !== "string" || !/^[^:\s]+:[^:\s]+$/u.test(token)) {
    throw new Error("MAVEN_CENTRAL_TOKEN must be username:password of a Central Portal user token");
  }
  return `Bearer ${Buffer.from(token, "utf8").toString("base64")}`;
}

export async function publishBundle({
  bundle, name, token, jarUrl,
  fetch = globalThis.fetch,
  wait = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); }),
  pollMilliseconds = 15_000,
  attempts = 240,
}) {
  const headers = { Authorization: authorization(token) };
  const form = new FormData();
  form.set("bundle", new Blob([bundle], { type: "application/octet-stream" }), `${name}.zip`);
  const upload = await fetch(`${CENTRAL_API}/upload?publishingType=AUTOMATIC&name=${encodeURIComponent(name)}`, {
    method: "POST", headers, body: form,
  });
  if (upload.status !== 201) throw new Error(`Central upload failed with status ${upload.status}: ${await upload.text()}`);
  const deployment = (await upload.text()).trim();

  for (let attempt = 0; ; attempt += 1) {
    if (attempt === attempts) throw new Error(`Central deployment ${deployment} did not finish`);
    const response = await fetch(`${CENTRAL_API}/status?id=${encodeURIComponent(deployment)}`, { method: "POST", headers });
    if (response.status !== 200) throw new Error(`Central status failed with status ${response.status}`);
    const status = await response.json();
    if (status.deploymentState === "PUBLISHED") break;
    if (!IN_PROGRESS.has(status.deploymentState)) {
      throw new Error(`Central deployment ${deployment} is ${status.deploymentState}: ${JSON.stringify(status.errors ?? {})}`);
    }
    await wait(pollMilliseconds);
  }

  // PUBLISHED can precede the repository by minutes; the caller verifies these bytes next.
  for (let attempt = 0; ; attempt += 1) {
    if (attempt === attempts) throw new Error(`${jarUrl} did not appear on Maven Central`);
    const response = await fetch(jarUrl, { method: "HEAD" });
    if (response.status === 200) return deployment;
    if (response.status !== 404) throw new Error(`Maven Central answered ${response.status} for ${jarUrl}`);
    await wait(pollMilliseconds);
  }
}

async function readStagedPrimaries({ archive, artifactId, version, workspace }) {
  await run("tar", ["-xzf", archive, "-C", workspace]);
  const root = join(workspace, `gauntlet-${artifactId}-${version}`);
  const available = new Set(readdirSync(root));
  const primaries = new Map();
  for (const suffix of PRIMARY_SUFFIXES) {
    const name = `${artifactId}-${version}${suffix}`;
    if (available.has(name)) primaries.set(name, readFileSync(join(root, name)));
  }
  return primaries;
}

async function gpgSigner({ key, home }) {
  const environment = { PATH: process.env.PATH, GNUPGHOME: home };
  const keyPath = join(home, "signing.asc");
  writeFileSync(keyPath, key, { mode: 0o600 });
  await run("gpg", ["--batch", "--quiet", "--import", keyPath], { env: environment });
  rmSync(keyPath);
  let index = 0;
  return async (bytes) => {
    index += 1;
    const input = join(home, `input-${index}`);
    writeFileSync(input, bytes, { mode: 0o600 });
    await run("gpg", ["--batch", "--yes", "--quiet", "--armor", "--detach-sign", "--output", `${input}.asc`, input], { env: environment });
    return readFileSync(`${input}.asc`);
  };
}

async function main() {
  const { values } = parseArgs({
    options: { archive: { type: "string" }, unit: { type: "string" }, version: { type: "string" } },
  });
  const { archive, unit, version } = values;
  if (!archive || !unit || !version) throw new TypeError("Usage: publish-maven-central.mjs --archive PATH --unit ID --version X.Y.Z");
  const key = process.env.MAVEN_SIGNING_KEY;
  if (!key) throw new Error("MAVEN_SIGNING_KEY is not set");
  const { artifactId, path, repository } = repositoryPath(unit, version);
  // A short path: gpg-agent's socket must fit the platform's limit.
  const workspace = mkdtempSync(join(tmpdir(), "gauntlet-central-"));
  const home = mkdtempSync(join(tmpdir(), "gnupg-"));
  try {
    const primaries = await readStagedPrimaries({ archive, artifactId, version, workspace });
    const sign = await gpgSigner({ key, home });
    const entries = await bundleEntries({ unit, version, primaries, sign });
    await publishBundle({
      bundle: zipStored(entries),
      name: `${artifactId}-${version}`,
      token: process.env.MAVEN_CENTRAL_TOKEN,
      jarUrl: `${repository}/${path}/${artifactId}-${version}.jar`,
    });
  } finally {
    await run("gpgconf", ["--kill", "gpg-agent"], { env: { PATH: process.env.PATH, GNUPGHOME: home } }).catch(() => {});
    rmSync(workspace, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
