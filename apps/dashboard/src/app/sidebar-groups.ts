import type { AdapterManifest, OperationSummary } from "@8lines/gauntlet-protocol";

export interface SidebarOperationGroup {
  readonly id: string;
  readonly label: string;
  readonly operations: readonly OperationSummary[];
}

export interface SidebarGroups {
  /** Pinned operations in the manifest, in pin order. */
  readonly pinned: readonly OperationSummary[];
  /** Feature groups by feature order, then "Other"; without pinned operations and without empty groups. */
  readonly groups: readonly SidebarOperationGroup[];
}

export function sidebarGroups(
  manifest: AdapterManifest | undefined,
  pinnedIds: readonly string[] | undefined,
): SidebarGroups {
  if (manifest === undefined) return { pinned: [], groups: [] };
  const pinnedSet = new Set(pinnedIds ?? []);
  const pinned = (pinnedIds ?? []).flatMap((id) => manifest.operations.filter((operation) => operation.id === id));
  const unpinned = manifest.operations.filter((operation) => !pinnedSet.has(operation.id));

  const features = [...manifest.features].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const groups: SidebarOperationGroup[] = features.map((feature) => ({
    id: feature.id,
    label: feature.label,
    operations: unpinned.filter((operation) => operation.featureId === feature.id),
  }));
  const ungrouped = unpinned.filter((operation) => !features.some((feature) => feature.id === operation.featureId));
  groups.push({ id: "other", label: "Other", operations: ungrouped });

  return { pinned, groups: groups.filter((group) => group.operations.length > 0) };
}
