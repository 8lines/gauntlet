import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createApp,
  createManifestService,
  createStaticTargetProvider,
  createTargetRegistry,
} from "../src/app.js";
import { fakeTarget } from "./support/fake-adapter.js";

test("server entrypoint exposes the control-plane composition interfaces", () => {
  assert.equal(typeof createApp, "function");
  assert.equal(typeof createManifestService, "function");
  assert.equal(typeof createStaticTargetProvider, "function");
  assert.equal(typeof createTargetRegistry, "function");
});

test("refuses to construct a control plane without an environment", async () => {
  await assert.rejects(
    () => createApp({ targets: [fakeTarget] } as never),
    new TypeError("Invalid non-production environment descriptor"),
  );
});

test("refuses unsafe control-plane environments before constructing collaborators", async () => {
  for (const environment of [
    { name: "gauntlet-prod", kind: "staging" },
    { name: "gauntlet-dev", kind: "production" },
  ]) {
    let targetsRead = 0;
    const targets = Object.create(null, {
      [Symbol.iterator]: {
        get() {
          targetsRead += 1;
          throw new Error("target registry must not be constructed");
        },
      },
    });
    await assert.rejects(
      () => createApp({ environment, targets, maxUploadBytes: 0 } as never),
      new TypeError("Invalid non-production environment descriptor"),
    );
    assert.equal(targetsRead, 0);
  }
});
