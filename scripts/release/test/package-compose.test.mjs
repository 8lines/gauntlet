import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { crc32, inflateRawSync } from "node:zlib";

let packager = {};
try {
  packager = await import("../package-compose.mjs");
} catch {
  // The first RED run is expressed by the missing contract below.
}

const REPOSITORY_ROOT = realpathSync(resolve(import.meta.dirname, "../../.."));
const RELEASE_FILES = Object.freeze([
  ".env.example",
  "LICENSE",
  "README.md",
  "compose.yaml",
  "config.example.yaml",
  "gauntlet",
  "gauntlet-config-v1.schema.json",
]);
const ARCHIVE_NAMES = RELEASE_FILES.map((name) => `gauntlet/${name}`);
const NORMALIZED_MTIME = 946_684_800;

function binaryCompare(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function createFixture() {
  const sandbox = realpathSync(mkdtempSync(resolve(tmpdir(), "gauntlet-compose-package-test-")));
  const root = resolve(sandbox, "repository");
  mkdirSync(resolve(root, "deploy"), { recursive: true, mode: 0o700 });
  writeFileSync(resolve(root, "VERSION"), readFileSync(resolve(REPOSITORY_ROOT, "VERSION")), { mode: 0o644 });
  cpSync(resolve(REPOSITORY_ROOT, "deploy/compose"), resolve(root, "deploy/compose"), {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
  return Object.freeze({
    sandbox,
    root,
    compose: resolve(root, "deploy/compose"),
    output(name = "output") {
      const path = resolve(sandbox, name);
      mkdirSync(path, { mode: 0o700 });
      chmodSync(path, 0o700);
      return path;
    },
    cleanup() {
      rmSync(sandbox, { recursive: true, force: true });
    },
  });
}

function invoke(options) {
  return Promise.resolve().then(() => packager.packageComposeBundle(options));
}

function tarText(header, offset, length) {
  const field = header.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  const end = nul === -1 ? field.length : nul;
  assert.equal(field.subarray(end).every((byte) => byte === 0), true);
  return field.subarray(0, end).toString("ascii");
}

function tarOctal(header, offset, length) {
  const field = header.subarray(offset, offset + length);
  assert.equal(field.at(-1), 0);
  const digits = field.subarray(0, -1).toString("ascii");
  assert.match(digits, /^[0-7]+$/);
  return Number.parseInt(digits, 8);
}

function parseStrictArchive(archive) {
  assert.equal(Buffer.isBuffer(archive), true);
  assert.deepEqual(
    archive.subarray(0, 10),
    Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x02, 0x03]),
    "gzip header is canonical and platform-independent",
  );
  const inflated = inflateRawSync(archive.subarray(10), { info: true, maxOutputLength: 16 * 1024 * 1024 });
  const tar = inflated.buffer;
  const trailerOffset = 10 + inflated.engine.bytesWritten;
  assert.equal(trailerOffset + 8, archive.length, "the gzip stream has exactly one member");
  assert.equal(archive.readUInt32LE(trailerOffset), crc32(tar) >>> 0);
  assert.equal(archive.readUInt32LE(trailerOffset + 4), tar.length >>> 0);
  assert.equal(tar.length % 512, 0);

  const entries = [];
  let offset = 0;
  while (offset < tar.length) {
    const header = tar.subarray(offset, offset + 512);
    assert.equal(header.length, 512);
    if (header.every((byte) => byte === 0)) {
      assert.equal(tar.length - offset, 1024, "tar has exactly two end blocks");
      assert.equal(tar.subarray(offset).every((byte) => byte === 0), true);
      offset = tar.length;
      break;
    }

    assert.deepEqual(header.subarray(257, 265), Buffer.from("ustar\0" + "00", "ascii"));
    assert.equal(header.subarray(157, 257).every((byte) => byte === 0), true);
    assert.equal(header.subarray(265, 345).every((byte) => byte === 0), true);
    assert.equal(header.subarray(345, 512).every((byte) => byte === 0), true);
    assert.equal(header[156], 0x30);
    assert.match(header.subarray(148, 156).toString("ascii"), /^[0-7]{6}\0 $/);
    const storedChecksum = Number.parseInt(header.subarray(148, 154).toString("ascii"), 8);
    let computedChecksum = 0;
    for (let index = 0; index < 512; index += 1) {
      computedChecksum += index >= 148 && index < 156 ? 0x20 : header[index];
    }
    assert.equal(storedChecksum, computedChecksum);

    const size = tarOctal(header, 124, 12);
    const payloadOffset = offset + 512;
    const payloadEnd = payloadOffset + size;
    const recordEnd = payloadOffset + Math.ceil(size / 512) * 512;
    assert.ok(recordEnd <= tar.length);
    assert.equal(tar.subarray(payloadEnd, recordEnd).every((byte) => byte === 0), true);
    entries.push(Object.freeze({
      name: tarText(header, 0, 100),
      mode: tarOctal(header, 100, 8),
      uid: tarOctal(header, 108, 8),
      gid: tarOctal(header, 116, 8),
      mtime: tarOctal(header, 136, 12),
      payload: tar.subarray(payloadOffset, payloadEnd),
    }));
    offset = recordEnd;
  }
  assert.equal(offset, tar.length);
  return Object.freeze(entries);
}

function sourceSnapshot(composeDirectory) {
  return RELEASE_FILES.map((name) => {
    const path = resolve(composeDirectory, name);
    const stat = lstatSync(path, { bigint: true });
    return Object.freeze({
      name,
      mode: stat.mode,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
      sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    });
  });
}

test("packages only the seven standalone Compose files as a canonical archive", async () => {
  assert.equal(typeof packager.packageComposeBundle, "function");
  const fixture = createFixture();
  const outputDirectory = fixture.output();
  const before = sourceSnapshot(fixture.compose);
  try {
    const receipt = await invoke({ root: fixture.root, outputDirectory });
    assert.deepEqual(Object.keys(receipt), ["kind", "name", "version", "path", "sha256"]);
    assert.deepEqual(receipt, {
      kind: "compose",
      name: "gauntlet-compose",
      version: "0.1.0",
      path: resolve(outputDirectory, "gauntlet-compose-0.1.0.tar.gz"),
      sha256: receipt.sha256,
    });
    assert.equal(Object.isFrozen(receipt), true);
    assert.match(receipt.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(readdirSync(outputDirectory), ["gauntlet-compose-0.1.0.tar.gz"]);
    assert.equal(statSync(receipt.path).mode & 0o777, 0o600);
    const archive = readFileSync(receipt.path);
    assert.equal(createHash("sha256").update(archive).digest("hex"), receipt.sha256);

    const entries = parseStrictArchive(archive);
    assert.deepEqual(entries.map(({ name }) => name), ARCHIVE_NAMES);
    for (const [index, entry] of entries.entries()) {
      const sourceName = RELEASE_FILES[index];
      assert.equal(entry.mode, sourceName === "gauntlet" ? 0o755 : 0o644);
      assert.equal(entry.uid, 0);
      assert.equal(entry.gid, 0);
      assert.equal(entry.mtime, NORMALIZED_MTIME);
      assert.deepEqual(entry.payload, readFileSync(resolve(fixture.compose, sourceName)));
    }
    const archived = new Map(entries.map(({ name, payload }) => [name, payload.toString("utf8")]));
    const archivedReadme = archived.get("gauntlet/README.md");
    const archivedConfig = archived.get("gauntlet/config.example.yaml");
    const archivedSchema = archived.get("gauntlet/gauntlet-config-v1.schema.json");
    assert.match(archivedReadme, /source checkout[^\n]+`cd deploy\/compose`/i);
    assert.match(archivedReadme, /release archive[^\n]+`cd gauntlet`/i);
    assert.match(archivedConfig, /^# yaml-language-server: \$schema=\.\/gauntlet-config-v1\.schema\.json$/m);
    assert.equal(archivedSchema, readFileSync(resolve(REPOSITORY_ROOT, "config/gauntlet-config-v1.schema.json"), "utf8"));
    assert.deepEqual(sourceSnapshot(fixture.compose), before);
  } finally {
    fixture.cleanup();
  }
});

test("fsyncs the completed archive directory before promotion and closes its parent descriptor once", () => {
  const source = readFileSync(resolve(REPOSITORY_ROOT, "scripts/release/package-compose.mjs"), "utf8");
  const readyFsync = source.indexOf("fsyncSync(readyGuard.descriptor);");
  const promotion = source.indexOf("renameSync(readyDirectory, outputDirectory);");
  assert.notEqual(readyFsync, -1);
  assert.equal(readyFsync < promotion, true);
  const parentHelper = source.match(/function fsyncParentDirectory\(path\) \{([\s\S]+?)\n\}/)?.[1] ?? "";
  assert.equal(parentHelper.match(/closeSync\(descriptor\)/g)?.length, 1);
});

test("is byte-deterministic and changes when a selected source changes", async () => {
  const fixture = createFixture();
  try {
    const first = await invoke({ root: fixture.root, outputDirectory: fixture.output("first") });
    const second = await invoke({ root: fixture.root, outputDirectory: fixture.output("second") });
    assert.deepEqual(readFileSync(first.path), readFileSync(second.path));
    assert.equal(first.sha256, second.sha256);

    const changed = resolve(fixture.compose, "README.md");
    writeFileSync(changed, Buffer.concat([readFileSync(changed), Buffer.from("\nchanged fixture\n")]), { mode: 0o644 });
    const third = await invoke({ root: fixture.root, outputDirectory: fixture.output("third") });
    assert.notEqual(third.sha256, first.sha256);
    assert.notDeepEqual(readFileSync(third.path), readFileSync(first.path));
  } finally {
    fixture.cleanup();
  }
});

test("rejects additions, operator configuration, links, hardlinks, and special inputs without leaking names", async (t) => {
  const cases = [
    ["extra", (fixture) => writeFileSync(resolve(fixture.compose, "secret-name-sentinel-68421"), "secret\n")],
    ["operator env", (fixture) => writeFileSync(resolve(fixture.compose, ".env"), "TOKEN=secret\n")],
    ["operator config", (fixture) => writeFileSync(resolve(fixture.compose, "config.yaml"), "targets: []\n")],
    ["symlink", (fixture) => {
      const path = resolve(fixture.compose, "README.md");
      unlinkSync(path);
      symlinkSync(resolve(REPOSITORY_ROOT, "README.md"), path);
    }],
    ["hardlink", (fixture) => {
      const outside = resolve(fixture.sandbox, "outside-readme");
      writeFileSync(outside, readFileSync(resolve(fixture.compose, "README.md")));
      unlinkSync(resolve(fixture.compose, "README.md"));
      linkSync(outside, resolve(fixture.compose, "README.md"));
    }],
    ["fifo", (fixture) => {
      const path = resolve(fixture.compose, "config.example.yaml");
      unlinkSync(path);
      const result = spawnSync("mkfifo", [path], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const fixture = createFixture();
      const outputDirectory = fixture.output();
      try {
        mutate(fixture);
        await assert.rejects(invoke({ root: fixture.root, outputDirectory }), (error) => {
          assert.equal(error.message, "Compose bundle packaging failed closed");
          assert.doesNotMatch(error.message, /(?:secret|token|config\.yaml|\.env)/i);
          return true;
        });
        assert.deepEqual(readdirSync(outputDirectory), []);
      } finally {
        fixture.cleanup();
      }
    });
  }
});

test("rejects exotic option objects without invoking accessors", async () => {
  const fixture = createFixture();
  const outputDirectory = fixture.output();
  let getterCalls = 0;
  const getterOptions = { outputDirectory };
  Object.defineProperty(getterOptions, "root", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return fixture.root;
    },
  });
  const symbolOptions = { root: fixture.root, outputDirectory };
  symbolOptions[Symbol("hostile")] = true;
  try {
    for (const options of [
      null,
      [],
      { root: fixture.root },
      { root: fixture.root, outputDirectory, extra: true },
      getterOptions,
      symbolOptions,
      new Proxy({ root: fixture.root, outputDirectory }, {}),
    ]) {
      await assert.rejects(invoke(options), {
        name: "TypeError",
        message: "Compose bundle options must be a closed data object",
      });
    }
    assert.equal(getterCalls, 0);
    assert.deepEqual(readdirSync(outputDirectory), []);
  } finally {
    fixture.cleanup();
  }
});

test("rejects unsafe, shared, nested, and occupied outputs without removing foreign bytes", async () => {
  const fixture = createFixture();
  try {
    const permissive = fixture.output("permissive");
    chmodSync(permissive, 0o755);
    await assert.rejects(invoke({ root: fixture.root, outputDirectory: permissive }), {
      name: "TypeError",
      message: "Compose bundle output must be a safe private canonical directory",
    });

    const realOutput = fixture.output("real-output");
    const linkedOutput = resolve(fixture.sandbox, "linked-output");
    symlinkSync(realOutput, linkedOutput, "dir");
    await assert.rejects(invoke({ root: fixture.root, outputDirectory: linkedOutput }), {
      name: "TypeError",
      message: "Compose bundle output must be a safe private canonical directory",
    });

    const occupied = fixture.output("occupied");
    const foreignPath = resolve(occupied, "gauntlet-compose-0.1.0.tar.gz");
    const foreignBytes = Buffer.from("FOREIGN BYTES\n");
    writeFileSync(foreignPath, foreignBytes, { mode: 0o600 });
    await assert.rejects(invoke({ root: fixture.root, outputDirectory: occupied }), {
      message: "Compose bundle packaging failed closed",
    });
    assert.deepEqual(readFileSync(foreignPath), foreignBytes);
    assert.deepEqual(readdirSync(occupied), ["gauntlet-compose-0.1.0.tar.gz"]);

    const nested = resolve(fixture.root, "release-output");
    mkdirSync(nested, { mode: 0o700 });
    await assert.rejects(invoke({ root: fixture.root, outputDirectory: nested }), {
      message: "Compose bundle packaging failed closed",
    });
    assert.deepEqual(readdirSync(nested), []);
  } finally {
    fixture.cleanup();
  }
});
