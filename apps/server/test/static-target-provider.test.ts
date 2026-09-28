import assert from "node:assert/strict";
import { test } from "node:test";
import { parseStaticTargetsJson } from "../src/config.js";
import {
  createStaticTargetProvider,
  isCanonicalWebOrigin,
  validateStaticTargets,
} from "../src/static-target-provider.js";
import { createTargetRegistry } from "../src/target-registry.js";

const expectedEnvironment = { name: "dev", kind: "development" } as const;

function poisonedTypeError(): TypeError {
  return new Proxy(new TypeError("safe"), {
    get(target, property, receiver) {
      if (property === "message") throw new Error("sentinel-secret");
      return Reflect.get(target, property, receiver);
    },
  });
}

function assertGenericStaticTargetError(action: () => unknown, name: string): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  assert.equal(caught instanceof TypeError, true, name);
  assert.equal(
    Object.getOwnPropertyDescriptor(caught, "message")?.value,
    "Invalid static target configuration",
    name,
  );
  assert.doesNotMatch(String(caught), /sentinel-secret/i, name);
}

test("target registry rejects duplicate IDs without replacing the first target", () => {
  assert.throws(() => createTargetRegistry([
    createStaticTargetProvider([
      { id: "acme", label: "Acme", adapterUrl: "http://acme:8080", expectedEnvironment },
      { id: "acme", label: "Again", adapterUrl: "http://other:8080", expectedEnvironment },
    ]),
  ]), /duplicate target id.*acme/i);
});

test("target registry rejects duplicate IDs across providers", () => {
  assert.throws(() => createTargetRegistry([
    createStaticTargetProvider([{ id: "acme", label: "Acme", adapterUrl: "http://acme:8080", expectedEnvironment }]),
    createStaticTargetProvider([{ id: "acme", label: "Again", adapterUrl: "http://other:8080", expectedEnvironment }]),
  ]), /duplicate target id.*acme/i);
});

test("static targets are normalized to immutable owned origins", () => {
  const source = {
    id: "acme",
    label: "Acme",
    adapterUrl: "http://acme:8080/",
    publicUrl: "https://app.example.test:443/",
    expectedEnvironment: { ...expectedEnvironment },
    tags: ["symfony", "internal", "symfony"],
  };
  const registry = createTargetRegistry([createStaticTargetProvider([source])]);
  source.label = "Changed";
  source.expectedEnvironment.name = "changed";
  source.tags.push("changed");

  const target = registry.require("acme");
  assert.deepEqual(target, {
    id: "acme",
    label: "Acme",
    adapterUrl: "http://acme:8080",
    publicUrl: "https://app.example.test",
    expectedEnvironment,
    tags: ["symfony", "internal"],
  });
  assert.equal(Object.isFrozen(target), true);
  assert.equal(Object.isFrozen(target.expectedEnvironment), true);
  assert.equal(Object.isFrozen(target.tags), true);
  assert.equal(Object.isFrozen(registry.list()), true);
  assert.throws(() => (target.tags as string[]).push("nope"), TypeError);
});

test("static target validation rejects unknown keys and unsafe scalar values", () => {
  const invalid: readonly unknown[] = [
    [{ id: "acme", label: "Acme", adapterUrl: "http://acme:8080", expectedEnvironment, token: "secret" }],
    [{ id: "unsafe/id", label: "Acme", adapterUrl: "http://acme:8080", expectedEnvironment }],
    [{ id: "acme", label: "", adapterUrl: "http://acme:8080", expectedEnvironment }],
    [{ id: "acme", label: "Acme", adapterUrl: "http://acme:8080", expectedEnvironment, tags: [""] }],
    [{ id: "acme", label: "Acme", adapterUrl: "http://acme:8080", expectedEnvironment, tags: ["one", 2] }],
    [{ id: "acme", label: "Acme", adapterUrl: "http://acme:8080" }],
    [{ id: "acme", label: "Acme", adapterUrl: "http://acme:8080", expectedEnvironment: { name: "prod", kind: "staging" } }],
    [{ id: "acme", label: "Acme", adapterUrl: "http://acme:8080", expectedEnvironment: { ...expectedEnvironment, extra: true } }],
  ];
  for (const input of invalid) {
    assert.throws(() => createStaticTargetProvider(input), /invalid static target/i);
  }
});

test("static target labels and tags reject lone surrogates for injected and environment config", () => {
  for (const scalar of ["\ud800", "\udc00"]) {
    for (const target of [
      { id: "acme", label: scalar, adapterUrl: "http://acme:8080", expectedEnvironment },
      { id: "acme", label: "Acme", adapterUrl: "http://acme:8080", expectedEnvironment, tags: [scalar] },
    ]) {
      assert.throws(
        () => createStaticTargetProvider([target]),
        /invalid static target/i,
      );
      assert.throws(
        () => parseStaticTargetsJson(JSON.stringify([target])),
        /invalid static target/i,
      );
    }
  }
});

test("static target validation rejects credentials, paths, queries, fragments, and non-http URLs", () => {
  const urls = [
    "https://user:password@app.example.test",
    "https://app.example.test/internal",
    "https://app.example.test?token=x",
    "https://app.example.test#fragment",
    "ftp://app.example.test",
    "https://app.example.test//",
    " https://app.example.test",
    "https://app.example.test\n",
  ];
  for (const adapterUrl of urls) {
    assert.throws(
      () => createStaticTargetProvider([{ id: "acme", label: "Acme", adapterUrl, expectedEnvironment }]),
      /invalid static target/i,
      adapterUrl,
    );
  }
});

test("origin validation rejects forbidden lexical forms before URL normalization", () => {
  const forbidden = [
    "https://app.example.test?",
    "https://app.example.test#",
    "https://app.example.test/.",
    "https://app.example.test/foo/..",
    "https://app.example.test/%2e%2e",
    "https://exa\tmple.test",
    "https://exa\nmple.test",
    "https://@app.example.test",
    "https://app.example.test\\private",
  ];

  for (const field of ["adapterUrl", "publicUrl"] as const) {
    for (const candidate of forbidden) {
      const target = {
        id: "acme",
        label: "Acme",
        adapterUrl: "http://acme:8080",
        expectedEnvironment,
        ...(field === "adapterUrl" ? { adapterUrl: candidate } : { publicUrl: candidate }),
      };
      assert.throws(
        () => createStaticTargetProvider([target]),
        /invalid static target/i,
        `injected ${field}: ${JSON.stringify(candidate)}`,
      );
      assert.throws(
        () => parseStaticTargetsJson(JSON.stringify([target])),
        /invalid static target/i,
        `environment ${field}: ${JSON.stringify(candidate)}`,
      );
    }
  }
});

test("origin validation retains valid IPv6 origins and normalizes default ports", () => {
  const injected = createStaticTargetProvider([{
    id: "ipv6",
    label: "IPv6",
    adapterUrl: "http://[::1]:80/",
    publicUrl: "https://[2001:db8::1]:443",
    expectedEnvironment,
  }]).targets();
  const environment = parseStaticTargetsJson(JSON.stringify([{
    id: "ipv6",
    label: "IPv6",
    adapterUrl: "https://[::1]:443",
    publicUrl: "http://[2001:db8::1]:80/",
    expectedEnvironment,
  }]));

  assert.equal(injected[0]?.adapterUrl, "http://[::1]");
  assert.equal(injected[0]?.publicUrl, "https://[2001:db8::1]");
  assert.equal(environment[0]?.adapterUrl, "https://[::1]");
  assert.equal(environment[0]?.publicUrl, "http://[2001:db8::1]");
});

test("environment JSON and injected arrays use the same validation path", () => {
  const parsed = parseStaticTargetsJson('[{"id":"acme","label":"Acme","adapterUrl":"http://acme:8080/","expectedEnvironment":{"name":"dev","kind":"development"}}]');
  const injected = createStaticTargetProvider([{ id: "acme", label: "Acme", adapterUrl: "http://acme:8080/", expectedEnvironment }]).targets();
  assert.deepEqual(parsed, injected);
  assert.deepEqual(parseStaticTargetsJson(undefined), []);
  assert.throws(() => parseStaticTargetsJson("{}"), /array/i);
  assert.throws(() => parseStaticTargetsJson("not-json"), /valid json/i);
});

test("exotic objects, accessors, symbols, sparse arrays, and proxies are rejected safely", () => {
  let getterCalls = 0;
  const withGetter = Object.defineProperty({}, "id", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "acme";
    },
  });
  Object.assign(withGetter, { label: "Acme", adapterUrl: "http://acme:8080", expectedEnvironment });

  const symbolKeyed = { id: "acme", label: "Acme", adapterUrl: "http://acme:8080", expectedEnvironment, [Symbol("hidden")]: true };
  const sparse = new Array(1);
  const classInstance = new (class Target {
    id = "acme";
    label = "Acme";
    adapterUrl = "http://acme:8080";
    expectedEnvironment = expectedEnvironment;
  })();
  const throwingProxy = new Proxy({}, {
    getOwnPropertyDescriptor() { throw new Error("do not leak"); },
    ownKeys() { throw new Error("do not leak"); },
  });

  for (const input of [[withGetter], [symbolKeyed], sparse, [classInstance], [throwingProxy]]) {
    assert.throws(() => createStaticTargetProvider(input), /invalid static target/i);
  }
  assert.equal(getterCalls, 0);
});

test("target environment accessors and proxies are rejected without exposing their errors", () => {
  let getterCalls = 0;
  const accessor = Object.defineProperty({ name: "dev" }, "kind", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "development";
    },
  });
  const throwingProxy = new Proxy({}, {
    ownKeys() { throw new Error("sentinel-secret"); },
  });

  for (const environment of [accessor, throwingProxy]) {
    assert.throws(
      () => createStaticTargetProvider([{
        id: "acme",
        label: "Acme",
        adapterUrl: "http://acme:8080",
        expectedEnvironment: environment,
      }]),
      new TypeError("Invalid static target configuration"),
    );
  }
  assert.equal(getterCalls, 0);
});

test("poisoned caught values cannot escape array validation", () => {
  const validTarget = {
    id: "acme",
    label: "Acme",
    adapterUrl: "http://acme:8080",
    expectedEnvironment,
  };
  const hostileArray = new Proxy([validTarget], {
    getOwnPropertyDescriptor(target, property) {
      if (property === "length") throw poisonedTypeError();
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });
  assertGenericStaticTargetError(
    () => createStaticTargetProvider(hostileArray),
    "array catch boundary",
  );
});

test("poisoned caught values cannot escape record validation", () => {
  const hostileRecord = new Proxy({
    id: "acme",
    label: "Acme",
    adapterUrl: "http://acme:8080",
    expectedEnvironment,
  }, {
    ownKeys() {
      throw poisonedTypeError();
    },
  });
  assertGenericStaticTargetError(
    () => createStaticTargetProvider([hostileRecord]),
    "record catch boundary",
  );
});

test("poisoned caught values cannot escape URL validation", () => {
  const validTarget = {
    id: "acme",
    label: "Acme",
    adapterUrl: "http://acme:8080",
    expectedEnvironment,
  };
  const urlDescriptor = Object.getOwnPropertyDescriptor(globalThis, "URL");
  assert.notEqual(urlDescriptor, undefined);
  Object.defineProperty(globalThis, "URL", {
    ...urlDescriptor,
    value: class PoisonedURL {
      constructor() {
        throw poisonedTypeError();
      }
    },
  });
  try {
    assertGenericStaticTargetError(
      () => createStaticTargetProvider([validTarget]),
      "URL catch boundary",
    );
  } finally {
    Object.defineProperty(globalThis, "URL", urlDescriptor!);
  }
});

test("array ownership never reads an injected length getter trap", () => {
  let lengthReads = 0;
  const source = new Proxy([
    { id: "acme", label: "Acme", adapterUrl: "http://acme:8080", expectedEnvironment },
  ], {
    get(target, property, receiver) {
      if (property === "length") lengthReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const targets = createStaticTargetProvider(source).targets();
  assert.equal(targets[0]?.id, "acme");
  assert.equal(lengthReads, 0);
});

test("target widget origins are exact canonical HTTP(S) origins", () => {
  const base = {
    id: "shop",
    label: "Shop",
    adapterUrl: "http://shop:8080",
    expectedEnvironment: { name: "dev", kind: "development" },
  };
  const [target] = validateStaticTargets([{
    ...base,
    widget: { origins: ["https://shop.dev.example", "http://localhost:5173", "http://[fd00::12]:8080"] },
  }]);
  assert.deepEqual(target?.widget, {
    origins: ["https://shop.dev.example", "http://localhost:5173", "http://[fd00::12]:8080"],
  });
  assert.equal(Object.isFrozen(target?.widget), true);
  assert.equal(Object.isFrozen(target?.widget?.origins), true);

  for (const widget of [
    {},
    { origins: [] },
    { origins: "https://shop.dev.example" },
    { origins: ["https://shop.dev.example/"] },
    { origins: ["https://Shop.dev.example"] },
    { origins: ["https://shop.dev.example:443"] },
    { origins: ["https://*.dev.example"] },
    { origins: ["https://user:pw@shop.dev.example"] },
    { origins: ["https://shop.dev.example/path"] },
    { origins: ["ftp://shop.dev.example"] },
    { origins: ["null"] },
    { origins: ["https://shop.dev.example", "https://shop.dev.example"] },
    { origins: ["https://shop.dev.example"], extra: true },
  ]) {
    assert.throws(() => validateStaticTargets([{ ...base, widget }]), TypeError, JSON.stringify(widget));
  }
});

test("canonical web origin predicate matches the MCP origin rule", () => {
  assert.equal(isCanonicalWebOrigin("https://shop.dev.example"), true);
  assert.equal(isCanonicalWebOrigin("http://127.0.0.1:8080"), true);
  for (const value of [
    "https://shop.dev.example/",
    "HTTPS://shop.dev.example",
    "https://shop.dev.example:443",
    "",
    1,
    null,
    "http://a;b.example",
    "http://a,b.example",
    "http://'none'",
    "http://a_b.example",
  ]) {
    assert.equal(isCanonicalWebOrigin(value), false, String(value));
  }
});

test("registry get and require do not expose mutable provider state", () => {
  const providerTargets = [{ id: "acme", label: "Acme", adapterUrl: "http://acme:8080", expectedEnvironment }];
  const registry = createTargetRegistry([{ targets: () => providerTargets }]);
  providerTargets[0]!.label = "Changed";
  assert.equal(registry.get("acme")?.label, "Acme");
  assert.equal(registry.get("missing"), undefined);
  assert.throws(() => registry.require("missing"), /unknown target/i);
});
