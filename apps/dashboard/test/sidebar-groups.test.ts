import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdapterManifest, OperationSummary } from "@8lines/gauntlet-protocol";
import { sidebarGroups } from "../src/app/sidebar-groups.ts";

function operation(id: string, featureId: string): OperationSummary {
  return {
    id,
    revision: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    label: `Operation ${id}`,
    featureId,
    availability: { state: "available" },
  } as OperationSummary;
}

const invite = operation("invite", "users");
const remove = operation("remove", "users");
const reset = operation("reset", "data");
const orphan = operation("orphan", "missing");

const manifest = {
  features: [
    { id: "users", label: "Users", order: 20 },
    { id: "data", label: "Data", order: 10 },
  ],
  operations: [invite, remove, reset, orphan],
} as unknown as AdapterManifest;

const ids = (groups: ReturnType<typeof sidebarGroups>["groups"]) =>
  groups.map((group) => [group.id, group.operations.map((entry) => entry.id)]);

describe("sidebarGroups", () => {
  it("groups operations by feature order, in manifest order, with an Other group last", () => {
    const result = sidebarGroups(manifest, undefined);
    assert.deepEqual(result.pinned, []);
    assert.deepEqual(ids(result.groups), [
      ["data", ["reset"]],
      ["users", ["invite", "remove"]],
      ["other", ["orphan"]],
    ]);
    assert.equal(result.groups.at(-1)?.label, "Other");
  });

  it("moves pinned operations into pinned, in pin order, out of their groups", () => {
    const result = sidebarGroups(manifest, ["remove", "reset"]);
    assert.deepEqual(result.pinned, [remove, reset]);
    assert.deepEqual(ids(result.groups), [
      ["users", ["invite"]],
      ["other", ["orphan"]],
    ]);
  });

  it("drops a group left empty by pins, the Other group included", () => {
    const result = sidebarGroups(manifest, ["orphan", "invite", "remove"]);
    assert.deepEqual(result.pinned, [orphan, invite, remove]);
    assert.deepEqual(ids(result.groups), [["data", ["reset"]]]);
  });

  it("ignores pinned ids that are not in the manifest", () => {
    const result = sidebarGroups(manifest, ["gone", "invite"]);
    assert.deepEqual(result.pinned, [invite]);
    assert.deepEqual(ids(result.groups), [
      ["data", ["reset"]],
      ["users", ["remove"]],
      ["other", ["orphan"]],
    ]);
  });

  it("returns nothing without a manifest", () => {
    assert.deepEqual(sidebarGroups(undefined, ["invite"]), { pinned: [], groups: [] });
  });
});
