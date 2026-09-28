import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  DEFAULT_CONFIG_FILE,
  MAX_CONFIG_BYTES,
  GauntletConfigurationError,
  loadServerConfiguration,
  type ConfigurationErrorCode,
} from "../src/config.js";

const encoder = new TextEncoder();
const fixture = (name: string) => readFile(new URL(`../../../config/fixtures/${name}`, import.meta.url));
const expectedEnvironment = { name: "dev", kind: "development" } as const;
const sentinel = "sentinel-secret";
const sentinelUrl = `https://user:${sentinel}@app.example.test/private?token=${sentinel}#fragment`;

function validDocument(): Record<string, unknown> {
  return {
    version: 1,
    instance: {
      name: "small-apps-dev",
      environment: { ...expectedEnvironment },
    },
    targets: [{
      id: "billing",
      label: "Billing",
      adapterUrl: "http://billing:8080",
      expectedEnvironment: { ...expectedEnvironment },
    }],
  };
}

function jsonBytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function validLegacyEnvironment(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Readonly<Record<string, string | undefined>> {
  return {
    GAUNTLET_TARGETS_JSON: JSON.stringify([{
      id: "billing",
      label: "Billing",
      adapterUrl: "http://billing:8080",
      expectedEnvironment: { ...expectedEnvironment },
    }]),
    GAUNTLET_INSTANCE_NAME: "small-apps-dev",
    GAUNTLET_ENVIRONMENT_NAME: "dev",
    GAUNTLET_ENVIRONMENT_KIND: "development",
    ...overrides,
  };
}

function legacyConfiguration(): Record<string, unknown> {
  return {
    version: 1,
    instance: {
      name: "small-apps-dev",
      environment: { ...expectedEnvironment },
    },
    targets: [{
      id: "billing",
      label: "Billing",
      adapterUrl: "http://billing:8080",
      expectedEnvironment: { ...expectedEnvironment },
    }],
  };
}

async function rejectsConfiguration(
  path: string,
  bytes: Uint8Array,
  code: ConfigurationErrorCode,
  name: string,
): Promise<void> {
  await assert.rejects(
    loadServerConfiguration(
      { GAUNTLET_CONFIG_FILE: path },
      async () => bytes,
    ),
    (error: unknown) => {
      assert.equal(error instanceof GauntletConfigurationError, true, name);
      assert.equal((error as GauntletConfigurationError).code, code, name);
      assert.doesNotMatch(String(error), new RegExp(sentinel, "i"), name);
      assert.doesNotMatch(String(error), /https?:\/\//i, name);
      return true;
    },
  );
}

test("loads equivalent deeply owned immutable YAML and JSON v1 documents", async () => {
  const yaml = await loadServerConfiguration(
    { GAUNTLET_CONFIG_FILE: "/config.yaml" },
    async (path) => {
      assert.equal(path, "/config.yaml");
      return await fixture("config.valid.yaml");
    },
  );
  const json = await loadServerConfiguration(
    { GAUNTLET_CONFIG_FILE: "/config.json" },
    async () => await fixture("config.valid.json"),
  );

  assert.deepEqual(yaml, json);
  assert.equal(Object.isFrozen(yaml), true);
  assert.equal(Object.isFrozen(yaml.instance), true);
  assert.equal(Object.isFrozen(yaml.instance.environment), true);
  assert.equal(Object.isFrozen(yaml.targets), true);
  assert.equal(Object.isFrozen(yaml.targets[0]), true);
  assert.equal(Object.isFrozen(yaml.targets[0]?.expectedEnvironment), true);
  assert.equal(Object.isFrozen(yaml.targets[0]?.tags), true);
  assert.equal(Object.isFrozen(yaml.widget), true);
  assert.equal(Object.isFrozen(yaml.targets[0]?.widget?.origins), true);
});

test("widget configuration defaults to disabled and is frozen when present", async () => {
  const omitted = await loadServerConfiguration(
    { GAUNTLET_CONFIG_FILE: "/config.json" },
    async () => jsonBytes(validDocument()),
  );
  assert.deepEqual(omitted.widget, { enabled: false });
  assert.equal(Object.isFrozen(omitted.widget), true);

  const empty = await loadServerConfiguration(
    { GAUNTLET_CONFIG_FILE: "/config.json" },
    async () => jsonBytes({ ...validDocument(), widget: {} }),
  );
  assert.deepEqual(empty.widget, { enabled: false });

  const document = validDocument() as Record<string, any>;
  document.widget = { enabled: true };
  document.targets[0].widget = { origins: ["https://billing.dev.example"] };
  const enabled = await loadServerConfiguration(
    { GAUNTLET_CONFIG_FILE: "/config.json" },
    async () => jsonBytes(document),
  );
  assert.deepEqual(enabled.widget, { enabled: true });
  assert.deepEqual(enabled.targets[0]?.widget, { origins: ["https://billing.dev.example"] });
});

test("uses the container default when no explicit source is supplied", async () => {
  let requested = "";
  await loadServerConfiguration({}, async (path) => {
    requested = path;
    return await fixture("config.valid.yaml");
  });
  assert.equal(requested, DEFAULT_CONFIG_FILE);
});

test("loads the standalone Compose example through the bounded configuration path", async () => {
  const exampleUrl = new URL("../../../deploy/compose/config.example.yaml", import.meta.url);
  const contents = await readFile(exampleUrl);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(contents);
  const schemaComment = /^# yaml-language-server: \$schema=(\S+)$/m.exec(text);
  assert.notEqual(schemaComment, null);
  assert.equal(
    new URL(schemaComment?.[1] ?? "", exampleUrl).href,
    new URL("../../../deploy/compose/gauntlet-config-v1.schema.json", import.meta.url).href,
  );
  assert.equal(
    await readFile(new URL("../../../deploy/compose/gauntlet-config-v1.schema.json", import.meta.url), "utf8"),
    await readFile(new URL("../../../config/gauntlet-config-v1.schema.json", import.meta.url), "utf8"),
  );

  const configuration = await loadServerConfiguration(
    { GAUNTLET_CONFIG_FILE: "/etc/gauntlet/config.yaml" },
    async (path) => {
      assert.equal(path, "/etc/gauntlet/config.yaml");
      return contents;
    },
  );

  assert.deepEqual(configuration, {
    version: 1,
    instance: {
      name: "small-apps-dev",
      environment: { name: "dev", kind: "development" },
    },
    widget: { enabled: false },
    targets: [
      {
        id: "billing",
        label: "Billing",
        adapterUrl: "http://small-apps-dev-billing:8080",
        expectedEnvironment: { name: "dev", kind: "development" },
        tags: ["node", "payments"],
      },
      {
        id: "portal",
        label: "Portal",
        adapterUrl: "http://small-apps-dev-portal:8080",
        expectedEnvironment: { name: "dev", kind: "development" },
        tags: ["symfony"],
      },
    ],
  });
  assert.equal(Object.isFrozen(configuration), true);
  assert.equal(Object.isFrozen(configuration.targets), true);
  assert.equal(Object.isFrozen(configuration.targets[0]?.expectedEnvironment), true);
});

test("loads the isolated Compose smoke configuration with two exact targets", async () => {
  const smokeUrl = new URL("../../../conformance/smoke/gauntlet.config.yaml", import.meta.url);
  const contents = await readFile(smokeUrl);
  const configuration = await loadServerConfiguration(
    { GAUNTLET_CONFIG_FILE: "/etc/gauntlet/config.yaml" },
    async (path) => {
      assert.equal(path, "/etc/gauntlet/config.yaml");
      return contents;
    },
  );

  assert.deepEqual(configuration, {
    version: 1,
    instance: {
      name: "compose-smoke",
      environment: { name: "compose-smoke", kind: "test" },
    },
    widget: { enabled: false },
    targets: [
      {
        id: "fixture-a",
        label: "Fixture A",
        adapterUrl: "http://fake-adapter-a:8081",
        expectedEnvironment: { name: "compose-smoke", kind: "test" },
      },
      {
        id: "fixture-b",
        label: "Fixture B",
        adapterUrl: "http://fake-adapter-b:8081",
        expectedEnvironment: { name: "compose-smoke", kind: "test" },
      },
    ],
  });
  assert.equal(Object.isFrozen(configuration), true);
  assert.equal(Object.isFrozen(configuration.targets), true);
  assert.equal(Object.isFrozen(configuration.targets[0]?.expectedEnvironment), true);
  assert.equal(Object.isFrozen(configuration.targets[1]?.expectedEnvironment), true);
});

test("does not warn before an invalid legacy document has passed v1 validation", async () => {
  const originalEmitWarning = process.emitWarning;
  let warnings = 0;
  process.emitWarning = ((..._args: unknown[]) => {
    warnings += 1;
  }) as typeof process.emitWarning;
  try {
    await assert.rejects(
      loadServerConfiguration(validLegacyEnvironment({ GAUNTLET_TARGETS_JSON: "[]" }), async () => {
        throw new Error("legacy configuration must not read the default file");
      }),
      (error: unknown) => error instanceof GauntletConfigurationError
        && error.code === "invalid-document",
    );
    assert.equal(warnings, 0);
  } finally {
    process.emitWarning = originalEmitWarning;
  }
});

test("emits exactly one guarded deprecation warning for concurrent valid legacy loads", async () => {
  const originalEmitWarning = process.emitWarning;
  const attempts: unknown[][] = [];
  process.emitWarning = ((...args: unknown[]) => {
    attempts.push(args);
    throw new Error(`warning failure ${sentinelUrl}`);
  }) as typeof process.emitWarning;

  try {
    const configurations = await Promise.all(
      Array.from({ length: 4 }, () => loadServerConfiguration(validLegacyEnvironment(), async () => {
        throw new Error("legacy configuration must not read the default file");
      })),
    );
    assert.equal(configurations.length, 4);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.[1] instanceof Object, true);
    assert.deepEqual(attempts[0]?.[1], { code: "GAUNTLET_TARGETS_JSON_DEPRECATED" });
    assert.doesNotMatch(String(attempts[0]?.[0]), new RegExp(sentinel, "i"));
  } finally {
    process.emitWarning = originalEmitWarning;
  }
});

test("loads a fully identified legacy document through the v1 validation path", async () => {
  const legacy = await loadServerConfiguration(validLegacyEnvironment({ GAUNTLET_CONFIG_FILE: undefined }), async () => {
    throw new Error("legacy configuration must not read the default file");
  });
  const v1 = await loadServerConfiguration(
    { GAUNTLET_CONFIG_FILE: "/config.json" },
    async () => jsonBytes(legacyConfiguration()),
  );

  assert.deepEqual(legacy, v1);
  assert.equal(Object.isFrozen(legacy), true);
  assert.equal(Object.isFrozen(legacy.instance), true);
  assert.equal(Object.isFrozen(legacy.targets), true);
  assert.equal(Object.isFrozen(legacy.targets[0]?.expectedEnvironment), true);
});

test("legacy source conflicts with an explicit non-empty file before either source is read", async () => {
  let reads = 0;
  await assert.rejects(
    loadServerConfiguration(
      validLegacyEnvironment({ GAUNTLET_CONFIG_FILE: "/config.yaml" }),
      async () => {
        reads += 1;
        return jsonBytes(validDocument());
      },
    ),
    (error: unknown) => error instanceof GauntletConfigurationError
      && error.code === "source-conflict",
  );
  assert.equal(reads, 0);
});

test("legacy source requires every explicit identity input once any legacy key is present", async () => {
  for (const key of [
    "GAUNTLET_TARGETS_JSON",
    "GAUNTLET_INSTANCE_NAME",
    "GAUNTLET_ENVIRONMENT_NAME",
    "GAUNTLET_ENVIRONMENT_KIND",
  ] as const) {
    const environment = validLegacyEnvironment();
    delete (environment as Record<string, string | undefined>)[key];
    await assert.rejects(
      loadServerConfiguration(environment, async () => {
        throw new Error("legacy configuration must not read the default file");
      }),
      (error: unknown) => error instanceof GauntletConfigurationError
        && error.code === "legacy-environment-missing",
      key,
    );
  }
});

test("legacy targets keep their own required expected environment", async () => {
  const environment = validLegacyEnvironment({
    GAUNTLET_TARGETS_JSON: JSON.stringify([{
      id: "billing",
      label: "Billing",
      adapterUrl: "http://billing:8080",
    }]),
  });
  await assert.rejects(
    loadServerConfiguration(environment, async () => {
      throw new Error("legacy configuration must not read the default file");
    }),
    (error: unknown) => error instanceof GauntletConfigurationError
      && error.code === "invalid-document",
  );
});

test("legacy JSON is bounded, parsed as an array, and validated as a non-empty v1 document", async () => {
  const cases: readonly {
    readonly name: string;
    readonly value: string;
    readonly code: ConfigurationErrorCode;
  }[] = [
    { name: "invalid JSON", value: `[{"secret":"${sentinel}"}`, code: "invalid-syntax" },
    { name: "non-array JSON", value: JSON.stringify({ secret: sentinel }), code: "invalid-document" },
    { name: "empty targets", value: "[]", code: "invalid-document" },
    { name: "oversized JSON", value: " ".repeat(MAX_CONFIG_BYTES + 1), code: "file-too-large" },
  ];

  for (const entry of cases) {
    await assert.rejects(
      loadServerConfiguration(validLegacyEnvironment({ GAUNTLET_TARGETS_JSON: entry.value }), async () => {
        throw new Error("legacy configuration must not read the default file");
      }),
      (error: unknown) => {
        assert.equal(error instanceof GauntletConfigurationError, true, entry.name);
        assert.equal((error as GauntletConfigurationError).code, entry.code, entry.name);
        assert.doesNotMatch(String(error), new RegExp(sentinel, "i"), entry.name);
        return true;
      },
    );
  }
});

test("legacy instance and target production identities are rejected by the v1 validator", async () => {
  const cases = [
    validLegacyEnvironment({ GAUNTLET_ENVIRONMENT_KIND: "production" }),
    validLegacyEnvironment({ GAUNTLET_ENVIRONMENT_NAME: "eu-prod" }),
    validLegacyEnvironment({
      GAUNTLET_TARGETS_JSON: JSON.stringify([{
        id: "billing",
        label: "Billing",
        adapterUrl: "http://billing:8080",
        expectedEnvironment: { name: "production", kind: "staging" },
      }]),
    }),
  ];
  for (const environment of cases) {
    await assert.rejects(
      loadServerConfiguration(environment, async () => {
        throw new Error("legacy configuration must not read the default file");
      }),
      (error: unknown) => error instanceof GauntletConfigurationError
        && error.code === "invalid-document",
    );
  }
});

test("legacy values reject hostile own descriptors and ignore inherited values without reading files", async () => {
  let getterCalls = 0;
  let reads = 0;
  const valid = validLegacyEnvironment();
  const accessor = Object.defineProperty({}, "GAUNTLET_TARGETS_JSON", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error(sentinelUrl);
    },
  }) as Readonly<Record<string, string | undefined>>;
  const nonEnumerable = Object.defineProperty({}, "GAUNTLET_TARGETS_JSON", {
    enumerable: false,
    value: valid.GAUNTLET_TARGETS_JSON,
  }) as Readonly<Record<string, string | undefined>>;
  const nonString = { GAUNTLET_TARGETS_JSON: 42 } as Readonly<Record<string, string | undefined>>;
  const undefinedValue = { GAUNTLET_TARGETS_JSON: undefined };
  const proxy = new Proxy(valid, {
    getOwnPropertyDescriptor(target, key) {
      if (key === "GAUNTLET_TARGETS_JSON") {
        throw new Error(sentinelUrl);
      }
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });

  for (const environment of [accessor, nonEnumerable, nonString, undefinedValue, proxy]) {
    await assert.rejects(
      loadServerConfiguration(environment, async () => {
        reads += 1;
        return jsonBytes(validDocument());
      }),
      (error: unknown) => {
        assert.equal(error instanceof GauntletConfigurationError, true);
        assert.equal((error as GauntletConfigurationError).code, "legacy-environment-missing");
        assert.doesNotMatch(String(error), new RegExp(sentinel, "i"));
        assert.doesNotMatch(String(error), /https?:\/\//i);
        return true;
      },
    );
  }

  const inherited = Object.create(validLegacyEnvironment()) as Readonly<Record<string, string | undefined>>;
  await loadServerConfiguration(inherited, async (path) => {
    reads += 1;
    assert.equal(path, DEFAULT_CONFIG_FILE);
    return await fixture("config.valid.yaml");
  });
  assert.equal(getterCalls, 0);
  assert.equal(reads, 1);
});

test("maps unreadable and empty file sources to generic code-only errors", async () => {
  await assert.rejects(
    loadServerConfiguration(
      { GAUNTLET_CONFIG_FILE: `/private/${sentinel}.yaml` },
      async () => { throw new Error(`cannot read ${sentinelUrl}`); },
    ),
    (error: unknown) => {
      assert.equal(error instanceof GauntletConfigurationError, true);
      assert.equal((error as GauntletConfigurationError).code, "file-unreadable");
      assert.doesNotMatch(String(error), new RegExp(sentinel, "i"));
      assert.doesNotMatch(String(error), /https?:\/\//i);
      return true;
    },
  );

  let reads = 0;
  await assert.rejects(
    loadServerConfiguration(
      { GAUNTLET_CONFIG_FILE: "" },
      async () => {
        reads += 1;
        return jsonBytes(validDocument());
      },
    ),
    (error: unknown) => error instanceof GauntletConfigurationError
      && error.code === "file-unreadable",
  );
  assert.equal(reads, 0);
});

test("source selection rejects hostile descriptors without invoking accessors", async () => {
  let getterCalls = 0;
  let reads = 0;
  const accessor = Object.defineProperty({}, "GAUNTLET_CONFIG_FILE", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error(sentinelUrl);
    },
  }) as Readonly<Record<string, string | undefined>>;
  const poisonedDescriptor = new Proxy(
    { GAUNTLET_CONFIG_FILE: "/config.json" },
    {
      getOwnPropertyDescriptor() {
        throw new Error(sentinelUrl);
      },
    },
  );

  for (const environment of [accessor, poisonedDescriptor]) {
    await assert.rejects(
      loadServerConfiguration(environment, async () => {
        reads += 1;
        return jsonBytes(validDocument());
      }),
      (error: unknown) => {
        assert.equal(error instanceof GauntletConfigurationError, true);
        assert.equal((error as GauntletConfigurationError).code, "file-unreadable");
        assert.doesNotMatch(String(error), new RegExp(sentinel, "i"));
        assert.doesNotMatch(String(error), /https?:\/\//i);
        return true;
      },
    );
  }
  assert.equal(getterCalls, 0);
  assert.equal(reads, 0);
});

test("source selection accepts only own enumerable string data values", async () => {
  let requested = "";
  const inherited = Object.create({
    GAUNTLET_CONFIG_FILE: `/private/${sentinel}.json`,
  }) as Readonly<Record<string, string | undefined>>;
  await loadServerConfiguration(inherited, async (path) => {
    requested = path;
    return await fixture("config.valid.yaml");
  });
  assert.equal(requested, DEFAULT_CONFIG_FILE);

  for (const environment of [
    Object.defineProperty({}, "GAUNTLET_CONFIG_FILE", {
      enumerable: false,
      value: "/config.json",
    }),
    { GAUNTLET_CONFIG_FILE: 42 },
  ]) {
    await assert.rejects(
      loadServerConfiguration(
        environment as Readonly<Record<string, string | undefined>>,
        async () => jsonBytes(validDocument()),
      ),
      (error: unknown) => error instanceof GauntletConfigurationError
        && error.code === "file-unreadable",
    );
  }
});

test("rejects malformed encodings and YAML streams before document validation", async () => {
  const duplicateKey = `
version: 1
version: 1
instance: { name: dev, environment: { name: dev, kind: development } }
targets: []
secret: ${sentinel}
`;
  const twoDocuments = `
---
version: 1
instance: { name: dev, environment: { name: dev, kind: development } }
targets: []
---
secret: ${sentinel}
url: ${sentinelUrl}
`;
  const alias = `
version: 1
instance: &instance
  name: dev
  environment: { name: dev, kind: development }
targets:
  - id: billing
    label: Billing
    adapterUrl: http://billing:8080
    expectedEnvironment: *instance
`;
  const cases: readonly {
    readonly name: string;
    readonly path: string;
    readonly bytes: Uint8Array;
    readonly code: ConfigurationErrorCode;
  }[] = [
    {
      name: "unsupported suffix",
      path: `/config.${sentinel}`,
      bytes: jsonBytes(validDocument()),
      code: "unsupported-extension",
    },
    {
      name: "suffix with query text",
      path: `/config.json?token=${sentinel}`,
      bytes: jsonBytes(validDocument()),
      code: "unsupported-extension",
    },
    {
      name: "invalid UTF-8",
      path: "/config.json",
      bytes: Uint8Array.from([0xc3, 0x28]),
      code: "invalid-syntax",
    },
    {
      name: "oversized invalid bytes are bounded before decoding",
      path: "/config.json",
      bytes: Object.assign(new Uint8Array(MAX_CONFIG_BYTES + 1), { 0: 0xff }),
      code: "file-too-large",
    },
    {
      name: "invalid JSON",
      path: "/config.json",
      bytes: encoder.encode(`{"secret":"${sentinel}",`),
      code: "invalid-syntax",
    },
    {
      name: "duplicate JSON key",
      path: "/config.json",
      bytes: encoder.encode(`{"version":1,"version":1,"instance":{"name":"dev","environment":{"name":"dev","kind":"development"}},"targets":[{"id":"billing","label":"Billing","adapterUrl":"http://billing:8080","expectedEnvironment":{"name":"dev","kind":"development"}}],"secret":"${sentinel}"}`),
      code: "invalid-syntax",
    },
    {
      name: "duplicate YAML key",
      path: "/config.yaml",
      bytes: encoder.encode(duplicateKey),
      code: "invalid-syntax",
    },
    {
      name: "two YAML documents",
      path: "/config.yml",
      bytes: encoder.encode(twoDocuments),
      code: "invalid-syntax",
    },
    {
      name: "YAML alias",
      path: "/config.yaml",
      bytes: encoder.encode(alias),
      code: "invalid-syntax",
    },
  ];

  for (const entry of cases) {
    await rejectsConfiguration(entry.path, entry.bytes, entry.code, entry.name);
  }
});

test("rejects every invalid closed v1 document with generic diagnostics", async () => {
  const cases: readonly {
    readonly name: string;
    readonly edit: (document: Record<string, any>) => void;
  }[] = [
    { name: "non-object root", edit: (document) => { document.root = null; } },
    { name: "wrong version", edit: (document) => { document.version = 2; } },
    { name: "missing version", edit: (document) => { delete document.version; } },
    { name: "unknown root property", edit: (document) => { document.secret = sentinel; } },
    { name: "missing instance name", edit: (document) => { delete document.instance.name; } },
    { name: "unknown instance property", edit: (document) => { document.instance.secret = sentinel; } },
    { name: "unknown instance environment property", edit: (document) => { document.instance.environment.secret = sentinel; } },
    { name: "invalid instance environment kind", edit: (document) => { document.instance.environment.kind = "production"; } },
    { name: "production-like instance name", edit: (document) => { document.instance.environment.name = "eu-prod"; } },
    { name: "zero targets", edit: (document) => { document.targets = []; } },
    { name: "duplicate target IDs", edit: (document) => { document.targets.push({ ...document.targets[0] }); } },
    { name: "missing target id", edit: (document) => { delete document.targets[0].id; } },
    { name: "unknown target property", edit: (document) => { document.targets[0].secret = sentinel; } },
    { name: "missing expected target environment", edit: (document) => { delete document.targets[0].expectedEnvironment; } },
    { name: "unknown target environment property", edit: (document) => { document.targets[0].expectedEnvironment.secret = sentinel; } },
    { name: "invalid target environment kind", edit: (document) => { document.targets[0].expectedEnvironment.kind = "production"; } },
    { name: "production-like target environment name", edit: (document) => { document.targets[0].expectedEnvironment.name = "live-eu"; } },
    { name: "credential-bearing URL", edit: (document) => { document.targets[0].adapterUrl = sentinelUrl; } },
    { name: "URL path", edit: (document) => { document.targets[0].adapterUrl = `https://app.example.test/${sentinel}`; } },
    { name: "URL query", edit: (document) => { document.targets[0].adapterUrl = `https://app.example.test?token=${sentinel}`; } },
    { name: "URL fragment", edit: (document) => { document.targets[0].adapterUrl = `https://app.example.test#${sentinel}`; } },
    { name: "unknown widget property", edit: (document) => { document.widget = { enabled: true, secret: sentinel }; } },
    { name: "non-boolean widget switch", edit: (document) => { document.widget = { enabled: "true" }; } },
    { name: "non-object widget", edit: (document) => { document.widget = true; } },
    { name: "target widget without origins", edit: (document) => { document.targets[0].widget = {}; } },
    { name: "target widget origin with path", edit: (document) => { document.targets[0].widget = { origins: [`https://app.example.test/${sentinel}`] }; } },
  ];

  for (const entry of cases) {
    const document = validDocument() as Record<string, any>;
    if (entry.name === "non-object root") {
      await rejectsConfiguration("/config.json", jsonBytes(null), "invalid-document", entry.name);
      continue;
    }
    entry.edit(document);
    await rejectsConfiguration("/config.json", jsonBytes(document), "invalid-document", entry.name);
  }
});

test("treats JSON __proto__ keys as untrusted data rather than object structure", async () => {
  const text = `{"version":1,"instance":{"name":"dev","environment":{"name":"dev","kind":"development"}},"targets":[],"__proto__":{"secret":"${sentinel}","url":"${sentinelUrl}"}}`;
  await rejectsConfiguration(
    "/config.json",
    encoder.encode(text),
    "invalid-document",
    "prototype-named own property",
  );
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, "secret"), false);
});
