import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import filesystem from "node:fs";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";

import * as treeArchive from "../tree-archive.mjs";

const { packageCanonicalTree } = treeArchive;
const FAILURE = "Canonical tree packaging failed closed";

function fixture(t) {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), "gauntlet-tree-archive-test-")));
  chmodSync(root, 0o700);
  const source = resolve(root, "source");
  const first = resolve(root, "first");
  const second = resolve(root, "second");
  for (const path of [source, first, second]) {
    mkdirSync(path, { mode: 0o700 });
    chmodSync(path, 0o700);
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { first, root, second, source };
}

function tarEntries(archive) {
  const tar = gunzipSync(archive);
  const entries = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    const octal = (start, length) => Number.parseInt(text(start, length).trim() || "0", 8);
    const leaf = text(0, 100);
    const prefix = text(345, 155);
    const name = prefix === "" ? leaf : `${prefix}/${leaf}`;
    const size = octal(124, 12);
    const type = String.fromCharCode(header[156]);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    entries.push({
      body,
      gid: octal(116, 8),
      mode: octal(100, 8),
      mtime: octal(136, 12),
      name,
      size,
      type,
      uid: octal(108, 8),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.equal(tar.subarray(offset).every((byte) => byte === 0), true);
  assert.equal(tar.length - offset >= 1024, true);
  return entries;
}

function rawOctal(header, offset, length, value) {
  const digits = value.toString(8).padStart(length - 1, "0");
  assert.equal(digits.length, length - 1);
  header.write(digits, offset, length - 1, "ascii");
  header[offset + length - 1] = 0;
}

function rawTarHeader({ body = Buffer.alloc(0), declaredSize = body.length, linkname = "", mode = 0o644, name, type = "0" }) {
  const header = Buffer.alloc(512);
  header.write(name, 0, Buffer.byteLength(name), "ascii");
  rawOctal(header, 100, 8, mode);
  rawOctal(header, 108, 8, 0);
  rawOctal(header, 116, 8, 0);
  rawOctal(header, 124, 12, declaredSize);
  rawOctal(header, 136, 12, 946_684_800);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  if (linkname !== "") header.write(linkname, 157, Buffer.byteLength(linkname), "ascii");
  Buffer.from("ustar\0", "ascii").copy(header, 257);
  Buffer.from("00", "ascii").copy(header, 263);
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  const checksumDigits = checksum.toString(8).padStart(6, "0");
  assert.equal(checksumDigits.length, 6);
  header.write(checksumDigits, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function rawArchive(entries) {
  const chunks = [];
  for (const entry of entries) {
    const body = entry.body ?? Buffer.alloc(0);
    const declaredSize = entry.declaredSize ?? body.length;
    chunks.push(rawTarHeader({ ...entry, body, declaredSize }), body);
    const padding = Math.ceil(body.length / 512) * 512 - body.length;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  const archive = gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
  archive[9] = 0x03;
  return archive;
}

function writeArchiveFixture(files, filename, bytes) {
  const path = resolve(files.root, filename);
  writeFileSync(path, bytes, { mode: 0o600 });
  return {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function materialize(options) {
  return treeArchive.materializeCanonicalTreeArchive(options);
}

function expectMaterializeFailure(options, outputDirectory) {
  assert.throws(() => materialize(options), { message: FAILURE });
  assert.deepEqual(readdirSync(outputDirectory), []);
}

test("packages a canonical, deterministic no-link tree archive", (t) => {
  const files = fixture(t);
  mkdirSync(resolve(files.source, "nested"), { mode: 0o755 });
  writeFileSync(resolve(files.source, "z.txt"), "last\n", { mode: 0o600 });
  writeFileSync(resolve(files.source, "nested/a.txt"), "first\n", { mode: 0o644 });

  const first = packageCanonicalTree({
    sourceDirectory: files.source,
    outputDirectory: files.first,
    filename: "package-0.1.0.tar.gz",
    archivePrefix: "package-0.1.0",
  });
  const second = packageCanonicalTree({
    sourceDirectory: files.source,
    outputDirectory: files.second,
    filename: "package-0.1.0.tar.gz",
    archivePrefix: "package-0.1.0",
  });
  const firstBytes = readFileSync(first.path);
  assert.deepEqual(readFileSync(second.path), firstBytes);
  assert.equal(first.sha256, createHash("sha256").update(firstBytes).digest("hex"));
  assert.equal(first.size, firstBytes.length);
  assert.deepEqual(tarEntries(firstBytes), [
    { body: Buffer.alloc(0), gid: 0, mode: 0o755, mtime: 946684800, name: "package-0.1.0/nested/", size: 0, type: "5", uid: 0 },
    { body: Buffer.from("first\n"), gid: 0, mode: 0o644, mtime: 946684800, name: "package-0.1.0/nested/a.txt", size: 6, type: "0", uid: 0 },
    { body: Buffer.from("last\n"), gid: 0, mode: 0o644, mtime: 946684800, name: "package-0.1.0/z.txt", size: 5, type: "0", uid: 0 },
  ]);
});

test("rejects links, hardlinks, unsafe names, and occupied outputs", (t) => {
  for (const variant of ["symlink", "hardlink"]) {
    const files = fixture(t);
    writeFileSync(resolve(files.source, "owned.txt"), "owned\n", { mode: 0o600 });
    if (variant === "symlink") symlinkSync("owned.txt", resolve(files.source, "linked.txt"));
    else linkSync(resolve(files.source, "owned.txt"), resolve(files.source, "linked.txt"));
    assert.throws(() => packageCanonicalTree({
      sourceDirectory: files.source,
      outputDirectory: files.first,
      filename: "package.tar.gz",
      archivePrefix: "package",
    }), { message: "Canonical tree packaging failed closed" });
  }

  const files = fixture(t);
  writeFileSync(resolve(files.source, "owned.txt"), "owned\n", { mode: 0o600 });
  writeFileSync(resolve(files.first, "package.tar.gz"), "foreign\n", { mode: 0o600 });
  assert.throws(() => packageCanonicalTree({
    sourceDirectory: files.source,
    outputDirectory: files.first,
    filename: "package.tar.gz",
    archivePrefix: "../escape",
  }), { message: "Canonical tree packaging failed closed" });
  assert.equal(readFileSync(resolve(files.first, "package.tar.gz"), "utf8"), "foreign\n");
});

test("uses the USTAR prefix field for safe package paths longer than one hundred bytes", (t) => {
  const files = fixture(t);
  const directory = "a".repeat(80);
  const filename = `${"b".repeat(35)}.php`;
  mkdirSync(resolve(files.source, directory), { mode: 0o700 });
  writeFileSync(resolve(files.source, directory, filename), "<?php\n", { mode: 0o600 });

  const result = packageCanonicalTree({
    sourceDirectory: files.source,
    outputDirectory: files.first,
    filename: "package.tar.gz",
    archivePrefix: "gauntlet-package",
  });
  assert.deepEqual(tarEntries(readFileSync(result.path)).map(({ name }) => name), [
    `gauntlet-package/${directory}/`,
    `gauntlet-package/${directory}/${filename}`,
  ]);
});

test("materializes a verified canonical archive into one private non-executable tree", (t) => {
  const files = fixture(t);
  mkdirSync(resolve(files.source, "nested"), { mode: 0o755 });
  writeFileSync(resolve(files.source, "nested/a.txt"), "first\n", { mode: 0o755 });
  writeFileSync(resolve(files.source, "z.txt"), "last\n", { mode: 0o755 });
  const archive = packageCanonicalTree({
    sourceDirectory: files.source,
    outputDirectory: files.first,
    filename: "package-0.1.0.tar.gz",
    archivePrefix: "scope/package-0.1.0",
  });

  const result = materialize({
    archivePath: archive.path,
    expectedPrefix: "scope/package-0.1.0",
    expectedSha256: archive.sha256,
    outputDirectory: files.second,
  });

  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(Object.keys(result), ["path"]);
  assert.equal(result.path, resolve(files.second, "scope/package-0.1.0"));
  assert.equal(realpathSync(result.path), result.path);
  assert.equal(readFileSync(resolve(result.path, "nested/a.txt"), "utf8"), "first\n");
  assert.equal(readFileSync(resolve(result.path, "z.txt"), "utf8"), "last\n");
  assert.equal(lstatSync(resolve(files.second, "scope")).mode & 0o777, 0o700);
  assert.equal(lstatSync(result.path).mode & 0o777, 0o700);
  assert.equal(lstatSync(resolve(result.path, "nested")).mode & 0o777, 0o700);
  assert.equal(lstatSync(resolve(result.path, "nested/a.txt")).mode & 0o777, 0o600);
  assert.equal(lstatSync(resolve(result.path, "z.txt")).mode & 0o777, 0o600);
  assert.equal(lstatSync(resolve(result.path, "nested/a.txt")).mode & 0o111, 0);
});

test("materializes the packer's maximum-length empty directory path", (t) => {
  const files = fixture(t);
  const segments = ["a".repeat(90), "b".repeat(50), "c".repeat(78)];
  assert.equal(Buffer.byteLength(segments.join("/")), 220);
  let directory = files.source;
  for (const segment of segments) {
    directory = resolve(directory, segment);
    mkdirSync(directory, { mode: 0o700 });
  }
  const archive = packageCanonicalTree({
    sourceDirectory: files.source,
    outputDirectory: files.first,
    filename: "package.tar.gz",
    archivePrefix: "package",
  });

  const result = materialize({
    archivePath: archive.path,
    expectedPrefix: "package",
    expectedSha256: archive.sha256,
    outputDirectory: files.second,
  });

  assert.equal(lstatSync(resolve(result.path, ...segments)).isDirectory(), true);
});

test("materialization rejects non-exact options, wrong identity, prefix, and truncated gzip before writing", (t) => {
  const variants = ["wrong-sha", "wrong-prefix", "truncated", "noncanonical-gzip", "missing-option", "extra-option"];
  for (const variant of variants) {
    const files = fixture(t);
    writeFileSync(resolve(files.source, "owned.txt"), "owned\n", { mode: 0o600 });
    const archive = packageCanonicalTree({
      sourceDirectory: files.source,
      outputDirectory: files.first,
      filename: "package.tar.gz",
      archivePrefix: "package",
    });
    let archivePath = archive.path;
    let expectedPrefix = "package";
    let expectedSha256 = archive.sha256;
    if (variant === "wrong-sha") expectedSha256 = "0".repeat(64);
    if (variant === "wrong-prefix") expectedPrefix = "another-package";
    if (variant === "truncated") {
      const truncated = readFileSync(archive.path).subarray(0, 16);
      const fixtureArchive = writeArchiveFixture(files, "truncated.tar.gz", truncated);
      archivePath = fixtureArchive.path;
      expectedSha256 = fixtureArchive.sha256;
    }
    if (variant === "noncanonical-gzip") {
      const noncanonical = Buffer.from(readFileSync(archive.path));
      noncanonical[9] = noncanonical[9] === 0x03 ? 0x00 : 0x03;
      const fixtureArchive = writeArchiveFixture(files, "noncanonical.tar.gz", noncanonical);
      archivePath = fixtureArchive.path;
      expectedSha256 = fixtureArchive.sha256;
    }
    const options = { archivePath, expectedPrefix, expectedSha256, outputDirectory: files.second };
    if (variant === "missing-option") delete options.expectedSha256;
    if (variant === "extra-option") options.unexpected = true;
    expectMaterializeFailure(options, files.second);
  }
});

test("materialization rejects archive symlinks and hardlinks before writing", (t) => {
  for (const variant of ["symlink", "hardlink"]) {
    const files = fixture(t);
    writeFileSync(resolve(files.source, "owned.txt"), "owned\n", { mode: 0o600 });
    const archive = packageCanonicalTree({
      sourceDirectory: files.source,
      outputDirectory: files.first,
      filename: "package.tar.gz",
      archivePrefix: "package",
    });
    const alias = resolve(files.root, `${variant}.tar.gz`);
    if (variant === "symlink") symlinkSync(archive.path, alias);
    else linkSync(archive.path, alias);
    expectMaterializeFailure({
      archivePath: alias,
      expectedPrefix: "package",
      expectedSha256: archive.sha256,
      outputDirectory: files.second,
    }, files.second);
  }
});

test("materialization rejects traversal, link, duplicate, and oversized tar records before writing", (t) => {
  const cases = [
    ["traversal", [{ name: "package/../escape.txt", body: Buffer.from("escape\n") }]],
    ["absolute", [{ name: "/package/escape.txt", body: Buffer.from("escape\n") }]],
    ["nul", [{ name: "package/owned\0hidden.txt", body: Buffer.from("escape\n") }]],
    ["link", [{ name: "package/link", type: "2", mode: 0o777, linkname: "../../escape", body: Buffer.alloc(0) }]],
    ["duplicate", [
      { name: "package/owned.txt", body: Buffer.from("first\n") },
      { name: "package/owned.txt", body: Buffer.from("second\n") },
    ]],
    ["noncanonical-order", [
      { name: "package/z.txt", body: Buffer.from("last\n") },
      { name: "package/a.txt", body: Buffer.from("first\n") },
    ]],
    ["oversized", [{ name: "package/huge.bin", declaredSize: 128 * 1024 * 1024 + 1, body: Buffer.alloc(0) }]],
  ];
  for (const [name, entries] of cases) {
    const files = fixture(t);
    const archive = writeArchiveFixture(files, `${name}.tar.gz`, rawArchive(entries));
    expectMaterializeFailure({
      archivePath: archive.path,
      expectedPrefix: "package",
      expectedSha256: archive.sha256,
      outputDirectory: files.second,
    }, files.second);
  }
});

test("materialization rolls every journaled entry back after a post-create write failure", (t) => {
  const files = fixture(t);
  writeFileSync(resolve(files.source, "owned.txt"), "owned\n", { mode: 0o600 });
  const archive = packageCanonicalTree({
    sourceDirectory: files.source,
    outputDirectory: files.first,
    filename: "package.tar.gz",
    archivePrefix: "package",
  });
  t.mock.method(filesystem, "fsyncSync", () => {
    throw new Error("deterministic write failure");
  });

  expectMaterializeFailure({
    archivePath: archive.path,
    expectedPrefix: "package",
    expectedSha256: archive.sha256,
    outputDirectory: files.second,
  }, files.second);
});

test("materialization rollback preserves an identity-mismatched replacement", (t) => {
  const files = fixture(t);
  writeFileSync(resolve(files.source, "owned.txt"), "owned\n", { mode: 0o600 });
  const archive = packageCanonicalTree({
    sourceDirectory: files.source,
    outputDirectory: files.first,
    filename: "package.tar.gz",
    archivePrefix: "package",
  });
  const target = resolve(files.second, "package/owned.txt");
  const moved = resolve(files.root, "original-partial-file.txt");
  const realLstat = filesystem.lstatSync.bind(filesystem);
  let replaced = false;
  t.mock.method(filesystem, "fsyncSync", () => {
    throw new Error("deterministic write failure");
  });
  t.mock.method(filesystem, "lstatSync", (path, options) => {
    if (!replaced && path === target) {
      replaced = true;
      renameSync(target, moved);
      writeFileSync(target, "preserve\n", { mode: 0o600 });
    }
    return realLstat(path, options);
  });

  assert.throws(() => materialize({
    archivePath: archive.path,
    expectedPrefix: "package",
    expectedSha256: archive.sha256,
    outputDirectory: files.second,
  }), { message: FAILURE });
  assert.equal(replaced, true);
  assert.equal(readFileSync(target, "utf8"), "preserve\n");
  assert.equal(readFileSync(moved, "utf8"), "owned\n");
});

test("materialization requires a fresh empty exact-0700 output directory", (t) => {
  for (const variant of ["occupied", "permissive"]) {
    const files = fixture(t);
    writeFileSync(resolve(files.source, "owned.txt"), "owned\n", { mode: 0o600 });
    const archive = packageCanonicalTree({
      sourceDirectory: files.source,
      outputDirectory: files.first,
      filename: "package.tar.gz",
      archivePrefix: "package",
    });
    if (variant === "occupied") writeFileSync(resolve(files.second, "foreign.txt"), "foreign\n", { mode: 0o600 });
    else chmodSync(files.second, 0o750);
    assert.throws(() => materialize({
      archivePath: archive.path,
      expectedPrefix: "package",
      expectedSha256: archive.sha256,
      outputDirectory: files.second,
    }), { message: FAILURE });
    if (variant === "occupied") assert.equal(readFileSync(resolve(files.second, "foreign.txt"), "utf8"), "foreign\n");
    else assert.deepEqual(readdirSync(files.second), []);
  }
});
