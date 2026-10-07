/**
 * Last known catalog per target, persisted in `localStorage` so the widget panel (a fresh iframe
 * on every host page load) and the dashboard overview can show it at once while they refresh.
 * Definitions are kept by operation and only reused while their `revision` matches the
 * manifest's, so a changed operation is always read again. Storage content is untrusted
 * (another tab, a stale schema, manual tampering) and is read defensively.
 */

import type { OperationDefinition } from "@8lines/gauntlet-protocol";
import type { TargetSnapshot } from "./api.ts";
import type { StorageLike } from "./recent-runs.ts";

export const CATALOG_CACHE_KEY = "gauntlet.catalog-cache.v1";

interface CachedTarget {
  readonly snapshot?: TargetSnapshot;
  readonly definitions: Readonly<Record<string, OperationDefinition>>;
}

type CatalogCache = Readonly<Record<string, CachedTarget>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSnapshot(value: unknown, targetId: string): value is TargetSnapshot {
  if (!isRecord(value) || value.id !== targetId || typeof value.label !== "string") return false;
  return value.manifest === undefined || (isRecord(value.manifest) && Array.isArray(value.manifest.operations));
}

function isDefinition(value: unknown, operationId: string): value is OperationDefinition {
  return isRecord(value) && value.id === operationId && typeof value.revision === "string" && isRecord(value.execution);
}

function readCache(storage: StorageLike): CatalogCache {
  const raw = storage.getItem(CATALOG_CACHE_KEY);
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  return isRecord(parsed) ? (parsed as CatalogCache) : {};
}

function readTarget(storage: StorageLike, targetId: string): CachedTarget {
  const cache = readCache(storage);
  const entry: unknown = Object.hasOwn(cache, targetId) ? cache[targetId] : undefined;
  if (!isRecord(entry)) return { definitions: {} };
  const definitions: Record<string, OperationDefinition> = {};
  if (isRecord(entry.definitions)) {
    for (const [operationId, definition] of Object.entries(entry.definitions)) {
      if (isDefinition(definition, operationId)) definitions[operationId] = definition;
    }
  }
  return isSnapshot(entry.snapshot, targetId) ? { snapshot: entry.snapshot, definitions } : { definitions };
}

function writeTarget(storage: StorageLike, targetId: string, entry: CachedTarget): void {
  try {
    storage.setItem(CATALOG_CACHE_KEY, JSON.stringify({ ...readCache(storage), [targetId]: entry }));
  } catch {
    // Blocked or full storage: the next visit simply loads everything again.
  }
}

export function readCachedSnapshot(storage: StorageLike, targetId: string): TargetSnapshot | undefined {
  return readTarget(storage, targetId).snapshot;
}

/** Stores a fresh snapshot and forgets definitions of operations its manifest no longer lists. */
export function rememberSnapshot(storage: StorageLike, snapshot: TargetSnapshot): void {
  const cached = readTarget(storage, snapshot.id);
  const listed = new Set(snapshot.manifest?.operations.map((operation) => operation.id) ?? []);
  const definitions = Object.fromEntries(Object.entries(cached.definitions).filter(([id]) => listed.has(id)));
  writeTarget(storage, snapshot.id, { snapshot, definitions });
}

/** Cached definitions of the given operations, only those still at the manifest's revision. */
export function readCachedDefinitions(
  storage: StorageLike,
  targetId: string,
  operations: readonly { readonly id: string; readonly revision: string }[],
): Readonly<Record<string, OperationDefinition>> {
  const { definitions } = readTarget(storage, targetId);
  const current: Record<string, OperationDefinition> = {};
  for (const operation of operations) {
    const definition = Object.hasOwn(definitions, operation.id) ? definitions[operation.id] : undefined;
    if (definition?.revision === operation.revision) current[operation.id] = definition;
  }
  return current;
}

export function rememberDefinition(storage: StorageLike, targetId: string, definition: OperationDefinition): void {
  const cached = readTarget(storage, targetId);
  writeTarget(storage, targetId, { ...cached, definitions: { ...cached.definitions, [definition.id]: definition } });
}

/** Signing out drops everything read with that session. */
export function clearCatalogCache(storage: StorageLike): void {
  try {
    storage.setItem(CATALOG_CACHE_KEY, "{}");
  } catch {
    // Nothing more can be done about blocked storage.
  }
}
