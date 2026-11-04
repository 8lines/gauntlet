import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { crc32 } from "node:zlib";

import { bundleEntries, publishBundle, repositoryPath, zipStored } from "../publish-maven-central.mjs";

const VERSION = "1.2.3";
const PATH = `dev/8lines/gauntlet/core/${VERSION}`;
const JAR_URL = `https://repo1.maven.org/maven2/${PATH}/core-${VERSION}.jar`;
const SUFFIXES = [".jar", "-sources.jar", "-javadoc.jar", ".pom", ".module"];

const primaries = () => new Map(SUFFIXES.map((suffix) => [`core-${VERSION}${suffix}`, Buffer.from(`bytes${suffix}`)]));
const sign = async (bytes) => Buffer.concat([Buffer.from("signature:"), bytes]);

function central(states, { published = [200] } = {}) {
  const calls = [];
  const remainingStates = [...states];
  const remainingHeads = [...published];
  const fetch = async (input, options = {}) => {
    const url = new URL(input);
    calls.push({ url, options });
    if (url.pathname.endsWith("/upload")) return new Response("deployment-1\n", { status: 201 });
    if (url.pathname.endsWith("/status")) {
      return Response.json({ deploymentState: remainingStates.shift(), errors: { pom: ["missing developers"] } });
    }
    return new Response(null, { status: remainingHeads.shift() });
  };
  return { calls, fetch };
}

const publish = (fetch, overrides = {}) => publishBundle({
  bundle: Buffer.from("zip"), name: "core-1.2.3", token: "user:secret", jarUrl: JAR_URL, fetch, wait: async () => {}, ...overrides,
});

test("the Central repository path follows the release model", () => {
  assert.deepEqual(repositoryPath("java-core", VERSION), {
    artifactId: "core", path: PATH, repository: "https://repo1.maven.org/maven2",
  });
  assert.throws(() => repositoryPath("gauntlet", VERSION), /Unknown Maven unit/u);
});

test("the bundle signs every staged file and checksums files and signatures", async () => {
  const entries = await bundleEntries({ unit: "java-core", version: VERSION, primaries: primaries(), sign });
  const byName = new Map(entries.map(({ name, bytes }) => [name, bytes]));
  assert.equal(entries.length, SUFFIXES.length * 10);
  for (const suffix of SUFFIXES) {
    const name = `${PATH}/core-${VERSION}${suffix}`;
    assert.deepEqual(byName.get(name), Buffer.from(`bytes${suffix}`));
    assert.deepEqual(byName.get(`${name}.asc`), Buffer.from(`signature:bytes${suffix}`));
    for (const file of [name, `${name}.asc`]) {
      for (const [algorithm, extension] of [["md5", ".md5"], ["sha1", ".sha1"], ["sha256", ".sha256"], ["sha512", ".sha512"]]) {
        assert.equal(byName.get(`${file}${extension}`).toString(), createHash(algorithm).update(byName.get(file)).digest("hex"));
      }
    }
  }
});

test("a bundle without a staged file is refused", async () => {
  const incomplete = primaries();
  incomplete.delete(`core-${VERSION}.pom`);
  await assert.rejects(bundleEntries({ unit: "java-core", version: VERSION, primaries: incomplete, sign }), /core-1\.2\.3\.pom/u);
});

test("the stored archive records each entry with its size and checksum", () => {
  const entries = [{ name: "a/b.txt", bytes: Buffer.from("first") }, { name: "a/c.txt", bytes: Buffer.from("second!") }];
  const archive = zipStored(entries);
  const end = archive.subarray(archive.length - 22);
  assert.equal(end.readUInt32LE(0), 0x06054b50);
  assert.equal(end.readUInt16LE(10), entries.length);
  let central = end.readUInt32LE(16);
  for (const { name, bytes } of entries) {
    assert.equal(archive.readUInt32LE(central), 0x02014b50);
    assert.equal(archive.readUInt32LE(central + 16), crc32(bytes));
    assert.equal(archive.readUInt32LE(central + 24), bytes.length);
    const nameLength = archive.readUInt16LE(central + 28);
    assert.equal(archive.subarray(central + 46, central + 46 + nameLength).toString(), name);
    const local = archive.readUInt32LE(central + 42);
    assert.equal(archive.readUInt32LE(local), 0x04034b50);
    const data = local + 30 + archive.readUInt16LE(local + 26);
    assert.deepEqual(archive.subarray(data, data + bytes.length), bytes);
    central += 46 + nameLength;
  }
});

test("publishing waits for Central and for the repository", async () => {
  const { calls, fetch } = central(["PENDING", "VALIDATED", "PUBLISHING", "PUBLISHED"], { published: [404, 200] });
  assert.equal(await publish(fetch), "deployment-1");
  const upload = calls[0];
  assert.equal(upload.url.searchParams.get("publishingType"), "AUTOMATIC");
  assert.equal(upload.options.headers.Authorization, `Bearer ${Buffer.from("user:secret").toString("base64")}`);
  assert.equal(calls.filter(({ url }) => url.pathname.endsWith("/status")).length, 4);
  const heads = calls.filter(({ url }) => url.href === JAR_URL);
  assert.equal(heads.length, 2);
  assert.equal(heads.every(({ options }) => options.headers === undefined), true, "the repository gets no credential");
});

test("a failed deployment reports Central's errors", async () => {
  await assert.rejects(publish(central(["VALIDATING", "FAILED"]).fetch), /FAILED: .*missing developers/u);
});

test("a deployment that never finishes fails", async () => {
  await assert.rejects(publish(central(Array(3).fill("PENDING")).fetch, { attempts: 3 }), /did not finish/u);
});

test("a malformed token is refused before any upload", async () => {
  const { calls, fetch } = central([]);
  await assert.rejects(publish(fetch, { token: "only-a-password" }), /username:password/u);
  assert.equal(calls.length, 0);
});
