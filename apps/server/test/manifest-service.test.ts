import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAdapterClient,
  type AdapterClient,
  type AdapterTarget,
  type ClientResult,
  type ManifestFetchResult,
} from "@8lines/gauntlet-dashboard-client";
import {
  computeRevision,
  type AdapterHealth,
  type AdapterManifest,
  type JsonObject,
  type Problem,
} from "@8lines/gauntlet-protocol";
import manifestDocument from "@8lines/gauntlet-protocol/fixtures/v1/manifest.valid.json" with { type: "json" };
import { createApp } from "../src/app.js";
import { createInMemoryGauntletStore } from "../src/in-memory-gauntlet-store.js";
import { createManifestService } from "../src/manifest-service.js";
import { createStaticTargetProvider } from "../src/static-target-provider.js";
import { createTargetRegistry } from "../src/target-registry.js";
import {
  createFakeAdapter,
  createManifestWithEnvironment,
  fakeTarget,
} from "./support/fake-adapter.js";
import { adapterEnvironment, serverEnvironment } from "./support/environment.js";

const validManifest = structuredClone(manifestDocument) as AdapterManifest;
const health: AdapterHealth = { status: "ok", protocolVersion: "1.0" };
const unavailable: Problem = {
  type: "urn:gauntlet:problem:adapter-unavailable",
  title: "Adapter unavailable",
  status: 503,
};
const invalidResponse: Problem = {
  type: "urn:gauntlet:problem:adapter-invalid-response",
  title: "Invalid adapter response",
  status: 502,
};

function registry(ids: readonly string[]) {
  return createTargetRegistry([createStaticTargetProvider(ids.map((id) => ({
    id,
    label: id.toUpperCase(),
    adapterUrl: `http://${id}.internal`,
    expectedEnvironment: adapterEnvironment,
    tags: ["test"],
  })))]);
}

function client(overrides: Partial<AdapterClient> = {}): AdapterClient {
  const unused = async <T>(): Promise<ClientResult<T>> => ({ ok: false, problem: unavailable });
  return {
    health: async () => ({ ok: true, value: health }),
    getManifest: async () => ({ ok: true, value: { notModified: false, manifest: validManifest } }),
    getOperation: unused,
    createRun: unused,
    getRun: unused,
    queryDataSource: unused,
    resolveDataSource: unused,
    createSessionLaunch: unused,
    ...overrides,
  };
}

function service(ids: readonly string[], adapterClient: AdapterClient) {
  return createManifestService({
    registry: registry(ids),
    client: adapterClient,
    store: createInMemoryGauntletStore(),
    clock: () => new Date("2026-08-29T12:00:00.123Z"),
  });
}

test("list refreshes targets in parallel while preserving registry order and failure isolation", async () => {
  const releases = new Map<string, () => void>();
  const started: string[] = [];
  const adapterClient = client({
    health: async (target) => {
      started.push(target.id);
      await new Promise<void>((resolve) => releases.set(target.id, resolve));
      return target.id === "offline"
        ? { ok: false, problem: unavailable }
        : { ok: true, value: health };
    },
  });
  const manifestService = service(["offline", "online"], adapterClient);

  const listing = manifestService.listTargets();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started.sort(), ["offline", "online"]);
  releases.get("online")?.();
  releases.get("offline")?.();

  const snapshots = await listing;
  assert.deepEqual(snapshots.map(({ id, state }) => [id, state]), [
    ["offline", "offline"],
    ["online", "online"],
  ]);
  assert.equal(snapshots[1]?.refreshedAt, "2026-08-29T12:00:00.123Z");
});

test("304 reuses the last validated manifest and sends its ETag", async () => {
  const etags: Array<string | undefined> = [];
  const quotedRevision = `"${validManifest.manifestRevision}"`;
  let request = 0;
  const manifestService = service(["acme"], client({
    getManifest: async (_target, etag) => {
      etags.push(etag);
      request += 1;
      return request === 1
        ? { ok: true, value: { notModified: false, manifest: validManifest }, etag: quotedRevision }
        : { ok: true, value: { notModified: true }, etag: quotedRevision };
    },
  }));

  await manifestService.refresh("acme");
  const second = await manifestService.refresh("acme");
  assert.deepEqual(etags, [undefined, quotedRevision]);
  assert.equal(second.manifest?.manifestRevision, validManifest.manifestRevision);
  assert.equal(second.state, "online");
});

test("marks exact environment-name mismatch unavailable without accepting its ETag", async () => {
  const mismatchingManifest = createManifestWithEnvironment({
    name: "other-dev",
    kind: "development",
  });
  const requestedEtags: Array<string | undefined> = [];
  const mismatchEtag = `"${mismatchingManifest.manifestRevision}"`;
  const manifestService = service(["acme"], client({
    getManifest: async (_target, etag) => {
      requestedEtags.push(etag);
      return {
        ok: true,
        value: { notModified: false, manifest: mismatchingManifest },
        etag: mismatchEtag,
      };
    },
  }));

  const first = await manifestService.refresh("acme");
  const second = await manifestService.refresh("acme");

  for (const snapshot of [first, second]) {
    assert.equal(snapshot.state, "incompatible");
    assert.deepEqual(snapshot.problem, {
      type: "urn:gauntlet:problem:target-environment-mismatch",
      title: "Target environment mismatch",
      status: 503,
    });
    assert.equal(snapshot.manifest, undefined);
  }
  assert.deepEqual(requestedEtags, [undefined, undefined]);
});

test("requires an exact environment-kind match", async () => {
  const manifest = createManifestWithEnvironment({ name: "development", kind: "test" });
  const snapshot = await service(["acme"], client({
    getManifest: async () => ({ ok: true, value: { notModified: false, manifest } }),
  })).refresh("acme");

  assert.equal(snapshot.state, "incompatible");
  assert.equal(snapshot.problem?.type, "urn:gauntlet:problem:target-environment-mismatch");
});

test("mismatch preserves the matching LKG and ETag so a matching 304 can recover", async () => {
  const mismatchingManifest = createManifestWithEnvironment({
    name: "other-dev",
    kind: "development",
  });
  const matchingEtag = `"${validManifest.manifestRevision}"`;
  const mismatchingEtag = `"${mismatchingManifest.manifestRevision}"`;
  const requestedEtags: Array<string | undefined> = [];
  let request = 0;
  const manifestService = service(["acme"], client({
    getManifest: async (_target, etag) => {
      requestedEtags.push(etag);
      request += 1;
      if (request === 1) {
        return { ok: true, value: { notModified: false, manifest: validManifest }, etag: matchingEtag };
      }
      if (request === 2) {
        return { ok: true, value: { notModified: false, manifest: mismatchingManifest }, etag: mismatchingEtag };
      }
      return { ok: true, value: { notModified: true }, etag: matchingEtag };
    },
  }));

  const firstMatching = await manifestService.refresh("acme");
  const nextMismatching = await manifestService.refresh("acme");
  const recoveredMatching = await manifestService.refresh("acme");

  assert.equal(firstMatching.state, "online");
  assert.equal(nextMismatching.state, "incompatible");
  assert.equal(nextMismatching.manifest?.manifestRevision, firstMatching.manifest?.manifestRevision);
  assert.equal(recoveredMatching.state, "online");
  assert.equal(recoveredMatching.manifest?.manifestRevision, firstMatching.manifest?.manifestRevision);
  assert.deepEqual(requestedEtags, [undefined, matchingEtag, matchingEtag]);
});

test("environment mismatch is isolated from targets with a matching environment", async () => {
  const mismatchingManifest = createManifestWithEnvironment({
    name: "other-dev",
    kind: "development",
  });
  const manifestService = service(["mismatch", "healthy"], client({
    getManifest: async (target) => ({
      ok: true,
      value: {
        notModified: false,
        manifest: target.id === "mismatch" ? mismatchingManifest : validManifest,
      },
    }),
  }));

  const snapshots = await manifestService.listTargets();

  assert.deepEqual(snapshots.map(({ id }) => id).sort(), ["healthy", "mismatch"]);
  assert.equal(snapshots.find(({ id }) => id === "healthy")?.state, "online");
  assert.equal(snapshots.find(({ id }) => id === "mismatch")?.state, "incompatible");
});

test("a successful 200 without ETag clears the previous validator", async () => {
  const etags: Array<string | undefined> = [];
  const quotedRevision = `"${validManifest.manifestRevision}"`;
  let request = 0;
  const manifestService = service(["acme"], client({
    getManifest: async (_target, etag) => {
      etags.push(etag);
      request += 1;
      if (request === 1) {
        return { ok: true, value: { notModified: false, manifest: validManifest }, etag: quotedRevision };
      }
      return { ok: true, value: { notModified: false, manifest: validManifest } };
    },
  }));

  await manifestService.refresh("acme");
  await manifestService.refresh("acme");
  await manifestService.refresh("acme");
  assert.deepEqual(etags, [undefined, quotedRevision, undefined]);
});

test("concurrent refreshes share one in-flight health and manifest request", async () => {
  const gate = Promise.withResolvers<void>();
  let healthCalls = 0;
  let manifestCalls = 0;
  const manifestService = service(["acme"], client({
    health: async () => {
      healthCalls += 1;
      await gate.promise;
      return { ok: true, value: health };
    },
    getManifest: async () => {
      manifestCalls += 1;
      return { ok: true, value: { notModified: false, manifest: validManifest } };
    },
  }));

  const first = manifestService.refresh("acme");
  const second = manifestService.refresh("acme");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(healthCalls, 1);
  gate.resolve();
  assert.deepEqual(await first, await second);
  assert.equal(manifestCalls, 1);
});

test("major mismatch is trusted only from the client failure discriminator", async () => {
  const spoofed: Problem = {
    type: "urn:gauntlet:problem:adapter-protocol-incompatible",
    title: "Spoofed",
    status: 502,
  };
  const classified = service(["classified"], client({
    health: async () => ({ ok: false, problem: spoofed, failureKind: "protocol-major-mismatch" }),
  }));
  const unclassified = service(["spoofed"], client({
    health: async () => ({ ok: false, problem: spoofed }),
  }));

  assert.equal((await classified.refresh("classified")).state, "incompatible");
  assert.equal((await unclassified.refresh("spoofed")).state, "degraded");
});

test("transport failure is offline while compatible health plus invalid manifest is degraded", async () => {
  const offline = service(["offline"], client({ health: async () => ({ ok: false, problem: unavailable }) }));
  const degraded = service(["degraded"], client({
    getManifest: async () => ({ ok: false, problem: invalidResponse }),
  }));
  assert.equal((await offline.refresh("offline")).state, "offline");
  assert.equal((await degraded.refresh("degraded")).state, "degraded");
});

test("last-known-good manifest survives later invalid and unavailable refreshes", async () => {
  let pass = 0;
  const manifestService = service(["acme"], client({
    health: async () => {
      pass += 1;
      return pass === 3 ? { ok: false, problem: unavailable } : { ok: true, value: health };
    },
    getManifest: async (): Promise<ClientResult<ManifestFetchResult>> => pass === 1
      ? { ok: true, value: { notModified: false, manifest: validManifest }, etag: `"${validManifest.manifestRevision}"` }
      : { ok: false, problem: invalidResponse },
  }));

  assert.equal((await manifestService.refresh("acme")).state, "online");
  const degraded = await manifestService.refresh("acme");
  assert.equal(degraded.state, "degraded");
  assert.equal(degraded.manifest?.manifestRevision, validManifest.manifestRevision);
  const offline = await manifestService.refresh("acme");
  assert.equal(offline.state, "offline");
  assert.equal(offline.manifest?.manifestRevision, validManifest.manifestRevision);
});

test("unsupported operation requirements do not change the target state", async () => {
  const future = structuredClone(validManifest) as AdapterManifest;
  const document = future as unknown as JsonObject & { manifestRevision: string; profiles: string[] };
  document.profiles = [...future.profiles, "urn:future-ui@1"];
  document.manifestRevision = computeRevision(document, "manifestRevision");
  const manifestService = service(["future"], client({
    getManifest: async () => ({ ok: true, value: { notModified: false, manifest: future } }),
  }));

  const snapshot = await manifestService.refresh("future");
  const support = manifestService.checkRequirements({ profiles: ["urn:future-ui@1"] });
  assert.equal(snapshot.state, "online");
  assert.equal(support.ok, false);
  if (!support.ok) {
    assert.equal(support.problem.status, 501);
    assert.equal(support.problem.type, "urn:gauntlet:problem:unsupported-capability");
    assert.equal(support.problem.capability, "urn:future-ui@1");
  }
  assert.equal(manifestService.snapshot("future")?.state, "online");
});

test("supported requirement sets are explicit and injectable", () => {
  const defaultService = service(["acme"], client());
  assert.equal(defaultService.checkRequirements({ profiles: ["tc-schema-core@1", "tc-rich-forms@1", "tc-rich-results@1"] }).ok, true);
  assert.equal(defaultService.checkRequirements({ capabilities: ["tc-session-launch@1"] }).ok, true);
  assert.equal(defaultService.checkRequirements({ capabilities: ["tc-uploads@1"] }).ok, true);
  assert.equal(defaultService.checkRequirements({ capabilities: ["tc-run-cancellation@1"] }).ok, true);
  assert.equal(defaultService.checkRequirements({ capabilities: ["tc-run-sse@1"] }).ok, true);

  const injected = createManifestService({
    registry: registry(["acme"]),
    client: client(),
    store: createInMemoryGauntletStore(),
    supportedProfiles: ["tc-schema-core@1"],
    supportedCapabilities: ["tc-uploads@1"],
  });
  assert.equal(injected.checkRequirements({ capabilities: ["tc-uploads@1"] }).ok, true);
  assert.equal(injected.checkRequirements({ profiles: ["tc-rich-forms@1"] }).ok, false);
});

test("public snapshots are owned, immutable, and omit internal target URLs", async () => {
  const mutable = structuredClone(validManifest) as AdapterManifest;
  const manifestService = service(["acme"], client({
    getManifest: async () => ({ ok: true, value: { notModified: false, manifest: mutable } }),
  }));
  const snapshot = await manifestService.refresh("acme");
  (mutable as unknown as { application: { label: string } }).application.label = "Mutated";

  assert.equal(snapshot.manifest?.application.label, "Acme Portal");
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.manifest), true);
  assert.deepEqual(snapshot.tags, ["test"]);
  assert.deepEqual(snapshot.expectedEnvironment, adapterEnvironment);
  assert.notEqual(snapshot.expectedEnvironment, adapterEnvironment);
  assert.equal(Object.isFrozen(snapshot.expectedEnvironment), true);
  assert.equal("adapterUrl" in snapshot, false);
  assert.equal("publicUrl" in snapshot, false);
});

test("every public manifest projection has canonical identity while raw LKG identity remains internal", async () => {
  const sentinelUrl = "https://adapter.internal/private-schema";
  const sentinelSecret = "manifest-super-secret";
  const unsafeManifest = structuredClone(validManifest) as AdapterManifest;
  const mutable = unsafeManifest as unknown as JsonObject & {
    manifestRevision: string;
    operations: Array<{ availability: unknown }>;
  };
  mutable.operations[0]!.availability = {
    state: "unavailable",
    problem: {
      type: "urn:gauntlet:problem:adapter-disabled",
      title: sentinelSecret,
      status: 503,
      detail: sentinelUrl,
      instance: `${sentinelUrl}/instance`,
      errors: [{
        instancePath: sentinelUrl,
        schemaPath: `${sentinelUrl}#/${sentinelSecret}`,
        keyword: "required",
        message: sentinelSecret,
        params: { secret: sentinelSecret },
      }],
    },
  };
  mutable.manifestRevision = computeRevision(mutable, "manifestRevision");

  const rawRevision = unsafeManifest.manifestRevision;
  const rawEtag = `"${rawRevision}"`;
  const rawSerialized = JSON.stringify(unsafeManifest);
  const receivedEtags: Array<string | undefined> = [];
  let manifestCalls = 0;
  const testStore = createInMemoryGauntletStore();
  const manifestService = createManifestService({
    registry: registry(["acme"]),
    client: client({
      getManifest: async (_target, etag) => {
        receivedEtags.push(etag);
        manifestCalls += 1;
        return manifestCalls === 1
          ? { ok: true, value: { notModified: false, manifest: unsafeManifest }, etag: rawEtag }
          : { ok: true, value: { notModified: true }, etag: rawEtag };
      },
    }),
    store: testStore,
    clock: () => new Date("2026-08-29T12:00:00.123Z"),
    // Every call below has to reach the adapter to show the ETag it sends.
    maxAgeMs: 0,
  });

  const refreshed = await manifestService.refresh("acme");
  const snapshotted = manifestService.snapshot("acme");
  const listed = await manifestService.listTargets();
  const repeated = await manifestService.refresh("acme");

  const routeFake = createFakeAdapter({ manifest: unsafeManifest });
  const app = await createApp({ environment: serverEnvironment, targets: [fakeTarget], fetch: routeFake.fetch });
  let routeManifest: AdapterManifest;
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/targets" });
    assert.equal(response.statusCode, 200);
    routeManifest = response.json().targets[0].manifest as AdapterManifest;
  } finally {
    await app.close();
  }

  const publicManifests = [
    refreshed.manifest!,
    snapshotted!.manifest!,
    listed[0]!.manifest!,
    repeated.manifest!,
    routeManifest,
  ];
  const projectedSerialized = JSON.stringify(publicManifests[0]);
  for (const manifest of publicManifests) {
    const serialized = JSON.stringify(manifest);
    assert.equal(serialized.includes(sentinelUrl), false);
    assert.equal(serialized.includes(sentinelSecret), false);
    assert.equal(serialized, projectedSerialized);
    assert.equal(
      manifest.manifestRevision,
      computeRevision(manifest as unknown as JsonObject, "manifestRevision"),
    );

    const publicClient = createAdapterClient({
      fetch: async () => Response.json(manifest, {
        headers: { "content-type": "application/json" },
      }),
    });
    const accepted = await publicClient.getManifest({
      id: "projection-consumer",
      adapterUrl: "http://projection-consumer.internal",
    });
    assert.equal(accepted.ok, true);
  }
  const publicProblem = refreshed.manifest?.operations[0]?.availability;
  assert.equal(publicProblem?.state, "unavailable");
  if (publicProblem?.state === "unavailable") {
    assert.deepEqual(publicProblem.problem, {
      type: "urn:gauntlet:problem:adapter-disabled",
      title: "Adapter unavailable",
      status: 503,
    });
  }

  const internal = testStore.getSnapshot("acme");
  assert.equal(JSON.stringify(internal?.manifest), rawSerialized);
  assert.equal(internal?.manifest?.manifestRevision, rawRevision);
  const compatible = await manifestService.requireCompatibleTarget("acme");
  assert.equal(compatible.ok, true);
  if (compatible.ok) {
    assert.equal(JSON.stringify(compatible.manifest), rawSerialized);
    assert.equal(compatible.manifest.manifestRevision, rawRevision);
  }
  assert.deepEqual(receivedEtags, [undefined, rawEtag, rawEtag, rawEtag]);

  const plain = await service(["plain"], client()).refresh("plain");
  assert.equal(plain.manifest?.manifestRevision, validManifest.manifestRevision);
});

test("requireCompatibleTarget returns safe problems for unknown and non-online targets", async () => {
  const manifestService = service(["offline"], client({ health: async () => ({ ok: false, problem: unavailable }) }));
  const missing = await manifestService.requireCompatibleTarget("missing");
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.problem.status, 404);

  const offline = await manifestService.requireCompatibleTarget("offline");
  assert.equal(offline.ok, false);
  if (!offline.ok) assert.equal(offline.problem.status, 503);
});

test("an unexpected client throw is isolated to its target during listing", async () => {
  const manifestService = service(["broken", "online"], client({
    health: async (target: AdapterTarget) => {
      if (target.id === "broken") throw new Error("sensitive internal failure");
      return { ok: true, value: health };
    },
  }));
  const snapshots = await manifestService.listTargets();
  assert.deepEqual(snapshots.map(({ id, state }) => [id, state]), [
    ["broken", "degraded"],
    ["online", "online"],
  ]);
  assert.equal(JSON.stringify(snapshots).includes("sensitive"), false);
});

test("listing and compatibility checks reuse a recent online snapshot; refresh always asks", async () => {
  let healthCalls = 0;
  let time = 0;
  const manifestService = createManifestService({
    registry: registry(["acme"]),
    client: client({ health: async () => { healthCalls += 1; return { ok: true, value: health }; } }),
    store: createInMemoryGauntletStore(),
    maxAgeMs: 1_000,
    now: () => time,
  });

  assert.equal((await manifestService.listTargets())[0]?.state, "online");
  assert.equal(healthCalls, 1);
  time = 999;
  assert.equal((await manifestService.listTargets())[0]?.state, "online");
  assert.equal((await manifestService.requireCompatibleTarget("acme")).ok, true);
  assert.equal(healthCalls, 1);

  assert.equal((await manifestService.requireCompatibleTarget("acme", { fresh: true })).ok, true);
  assert.equal(healthCalls, 2);
  await manifestService.refresh("acme");
  assert.equal(healthCalls, 3);

  time = 999 + 1_000;
  await manifestService.listTargets();
  assert.equal(healthCalls, 4);
});

test("a snapshot that is not online is never reused", async () => {
  let healthCalls = 0;
  const manifestService = createManifestService({
    registry: registry(["acme"]),
    client: client({ health: async () => { healthCalls += 1; return { ok: false, problem: unavailable }; } }),
    store: createInMemoryGauntletStore(),
    now: () => 0,
  });

  assert.equal((await manifestService.listTargets())[0]?.state, "offline");
  assert.equal((await manifestService.requireCompatibleTarget("acme")).ok, false);
  assert.equal(healthCalls, 2);
});

test("a negative or non-finite maxAgeMs is refused", () => {
  for (const maxAgeMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => createManifestService({
      registry: registry(["acme"]),
      client: client(),
      store: createInMemoryGauntletStore(),
      maxAgeMs,
    }), TypeError);
  }
});
