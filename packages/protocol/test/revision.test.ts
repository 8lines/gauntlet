import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  assertCanonicalJsonData,
  assertRuntimeJsonData,
  canonicalizeForRevision,
  computeRevision,
} from "../src/revision.js";

interface JcsSuccessVector {
  readonly name: string;
  readonly revisionField: "revision" | "manifestRevision";
  readonly inputJson: string;
  readonly expectedCanonicalJson: string;
  readonly expectedRevision: string;
}

interface JcsErrorVector {
  readonly name: string;
  readonly revisionField: "revision" | "manifestRevision";
  readonly inputJson: string;
  readonly expectedError: "lone-surrogate" | "unsafe-integer";
}

type JcsVector = JcsSuccessVector | JcsErrorVector;

interface JcsVectorFixture {
  readonly algorithm: string;
  readonly vectors: readonly JcsVector[];
}

function withoutRootRevision(
  document: Record<string, unknown>,
  revisionField: "revision" | "manifestRevision",
): never {
  const projected = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(document)) {
    if (key !== revisionField) {
      projected[key] = value;
    }
  }
  return projected as never;
}

test("JCS revision vectors freeze canonical JSON, SHA-256, and rejection boundaries", async () => {
  const raw = await readFile(new URL("../fixtures/v1/jcs-revision-vectors.json", import.meta.url), "utf8");
  assert.equal([...raw].every((character) => character.codePointAt(0)! < 0x80), true);

  const fixture = JSON.parse(raw) as JcsVectorFixture;
  assert.equal(fixture.algorithm, "RFC8785+SHA-256");
  assert.equal(new Set(fixture.vectors.map(({ name }) => name)).size, fixture.vectors.length);

  for (const vector of fixture.vectors) {
    const document = JSON.parse(vector.inputJson) as Record<string, unknown>;
    const hasCanonical = Object.hasOwn(vector, "expectedCanonicalJson");
    const hasRevision = Object.hasOwn(vector, "expectedRevision");
    const hasError = Object.hasOwn(vector, "expectedError");
    assert.equal(hasCanonical, hasRevision, `${vector.name}: success outcome must be a complete pair`);
    assert.notEqual(hasCanonical, hasError, `${vector.name}: expected exactly one outcome`);

    if (hasError) {
      const expected = vector.expectedError === "lone-surrogate"
        ? {
            name: "TypeError",
            message: vector.name.includes("property-name")
              ? "Object key at / contains a lone surrogate"
              : "String at /value contains a lone surrogate",
          }
        : /safe integer/i;
      assert.throws(
        () => computeRevision(document as never, vector.revisionField),
        expected,
        vector.name,
      );
      continue;
    }

    const success = vector as JcsSuccessVector;
    assert.equal(
      canonicalizeForRevision(withoutRootRevision(document, vector.revisionField)),
      success.expectedCanonicalJson,
      `${vector.name}: canonical JSON`,
    );
    assert.equal(
      computeRevision(document as never, vector.revisionField),
      success.expectedRevision,
      `${vector.name}: revision`,
    );
  }
});

test("RFC 8785 canonicalization is independent of object insertion order", () => {
  assert.equal(canonicalizeForRevision({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(computeRevision({}), "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
});

test("RFC 8785 uses ECMAScript number serialization", () => {
  assert.equal(
    canonicalizeForRevision({ numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 1e-27] }),
    '{"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27]}',
  );
});

test("runtime JSON rejects negative zero without changing the JCS revision domain", () => {
  assert.doesNotThrow(() => assertCanonicalJsonData({ value: -0 }));
  assert.equal(canonicalizeForRevision({ value: -0 }), '{"value":0}');
  assert.throws(() => assertRuntimeJsonData({ value: -0 }), /negative zero/i);
  assert.doesNotThrow(() => assertRuntimeJsonData({ value: 0 }));
});

test("revision excludes only the root revision and rejects non-portable numbers", () => {
  assert.equal(computeRevision({ revision: `sha256:${"0".repeat(64)}`, a: 1 }), computeRevision({ a: 1 }));
  assert.throws(() => computeRevision({ value: Number.MAX_SAFE_INTEGER + 1 }), /safe integer/i);
  assert.throws(() => computeRevision({ value: Number.NaN }), /finite/i);
});

test("canonicalization rejects non-JSON values, sparse arrays, and cycles", () => {
  assert.throws(() => canonicalizeForRevision({ value: undefined } as never), /undefined.*non-JSON/i);
  assert.throws(() => canonicalizeForRevision({ values: Array(1) } as never), /sparse array/i);
  assert.throws(() => canonicalizeForRevision({ value: Number.POSITIVE_INFINITY }), /finite/i);

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalizeForRevision(cyclic as never), /cycle/i);
});

test("golden operation and manifest revisions match their canonical content", async () => {
  const operation = JSON.parse(await readFile(new URL("../fixtures/v1/operation.valid.json", import.meta.url), "utf8"));
  const manifest = JSON.parse(await readFile(new URL("../fixtures/v1/manifest.valid.json", import.meta.url), "utf8"));
  assert.equal(operation.revision, computeRevision(operation));
  assert.equal(manifest.manifestRevision, computeRevision(manifest, "manifestRevision"));
});

test("revision hashing preserves a root __proto__ JSON member without prototype mutation", () => {
  const document = JSON.parse('{"__proto__":{"polluted":true},"a":1}');
  const originalPrototype = Object.getPrototypeOf(document);

  assert.equal(
    computeRevision(document),
    "sha256:acb9124c160bde29f1302ed9ea8d241871f4ee6f634b8368cc11c9d09afe837a",
  );
  assert.equal(Object.hasOwn(document, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(document), originalPrototype);
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});
