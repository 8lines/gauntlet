import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TargetSnapshot } from "../src/api.ts";
import { environmentGroups, environmentNames, environmentTitle } from "../src/app/environment-groups.ts";

function target(id: string, application?: { id: string; label: string; name: string; kind: string }): TargetSnapshot {
  return {
    id,
    label: `Target ${id}`,
    tags: [],
    state: application === undefined ? "offline" : "online",
    refreshedAt: "2026-10-11T09:00:00.000Z",
    ...(application === undefined ? {} : {
      manifest: {
        application: {
          id: application.id,
          label: application.label,
          environment: { name: application.name, kind: application.kind },
        },
      },
    }),
  } as unknown as TargetSnapshot;
}

const portalDev = target("portal-dev", { id: "portal", label: "Portal", name: "dev-v2", kind: "development" });
const billing = target("billing", { id: "billing", label: "Billing", name: "development", kind: "development" });
const portalQa = target("portal-qa", { id: "portal", label: "Portal", name: "qa", kind: "test" });
const offline = target("offline");

describe("environmentNames", () => {
  it("names the application and environment from the manifest, not the configured label", () => {
    assert.deepEqual(environmentNames(portalDev), { application: "Portal", environment: "dev-v2", kind: "development" });
    assert.equal(environmentTitle(portalDev), "Portal, dev-v2");
  });

  it("leaves out a kind that only repeats the environment name", () => {
    assert.deepEqual(environmentNames(billing), { application: "Billing", environment: "development" });
  });

  it("falls back to the configured label without a manifest", () => {
    assert.deepEqual(environmentNames(offline), { application: "Target offline" });
    assert.equal(environmentTitle(offline), "Target offline");
  });
});

describe("environmentGroups", () => {
  it("groups environments by application in first-seen order and lists targets without a manifest last", () => {
    const groups = environmentGroups([portalDev, offline, billing, portalQa]);
    assert.deepEqual(
      groups.map((group) => [group.label, group.targets.map((entry) => entry.id)]),
      [["Portal", ["portal-dev", "portal-qa"]], ["Billing", ["billing"]], [undefined, ["offline"]]],
    );
  });

  it("returns no ungrouped section when every target sent a manifest", () => {
    assert.equal(environmentGroups([billing]).length, 1);
  });
});
