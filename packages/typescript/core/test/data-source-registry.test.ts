import assert from "node:assert/strict";
import test from "node:test";
import { DataSourceRegistry, type DataSource } from "../src/index.js";

const definition = (id: string, label: string) => ({
  id,
  label,
  capabilities: { search: true, pagination: "cursor" as const, resolve: true as const, defaultLimit: 10, maxLimit: 20 },
});

test("registry keeps the first source when an ID is registered twice", () => {
  const source = (id: string, label: string): DataSource => ({
    definition: definition(id, label), query: () => ({ items: [] }), resolve: ({ values }) => ({ results: values.map((value) => ({ value, item: null })) }),
  });
  const registry = new DataSourceRegistry();
  registry.register(source("applications", "First"));
  assert.throws(() => registry.register(source("applications", "Second")), /duplicate data source id/i);
  assert.equal(registry.require("applications").definition.label, "First");
});

test("registry owns and freezes definitions without invoking accessors", () => {
  const capabilities = {
    search: true,
    pagination: "cursor" as const,
    resolve: true as const,
    defaultLimit: 10,
    maxLimit: 20,
  };
  const source: DataSource = {
    definition: { id: "applications", label: "Applications", capabilities },
    query: () => ({ items: [] }),
    resolve: ({ values }) => ({
      results: values.map((value) => ({ value, item: null })),
    }),
  };
  const registry = new DataSourceRegistry();
  registry.register(source);
  capabilities.maxLimit = 999;

  assert.equal(registry.require("applications").definition.capabilities.maxLimit, 20);
  assert.equal(Object.isFrozen(registry.require("applications").definition.capabilities), true);

  let reads = 0;
  const hostile = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(hostile, "id", {
    enumerable: true,
    get() {
      reads += 1;
      return "hostile";
    },
  });
  assert.throws(() => registry.register({
    definition: hostile as never,
    query: () => ({ items: [] }),
    resolve: () => ({ results: [] }),
  }), /canonical plain JSON/i);
  assert.equal(reads, 0);
});
