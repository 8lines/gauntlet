import type { TargetSnapshot } from "../api.ts";

export interface EnvironmentNames {
  /** What the application calls itself, or the configured target label when the manifest is missing. */
  readonly application: string;
  /** The environment name from the manifest; undefined when the manifest is missing. */
  readonly environment?: string;
  /** The environment kind, left out when it only repeats the name. */
  readonly kind?: string;
}

export interface EnvironmentGroup {
  readonly id: string;
  /** Undefined for targets that sent no manifest; their own label names them. */
  readonly label?: string;
  readonly targets: readonly TargetSnapshot[];
}

export function environmentNames(target: TargetSnapshot): EnvironmentNames {
  const application = target.manifest?.application;
  if (application === undefined) return { application: target.label };
  const { name, kind } = application.environment;
  return { application: application.label, environment: name, ...(kind === name ? {} : { kind }) };
}

/** Accessible name: the application and the environment, as the switcher shows them. */
export function environmentTitle(target: TargetSnapshot): string {
  const names = environmentNames(target);
  return names.environment === undefined ? names.application : `${names.application}, ${names.environment}`;
}

/** Targets grouped by application in first-seen order; targets without a manifest come last, ungrouped. */
export function environmentGroups(targets: readonly TargetSnapshot[]): readonly EnvironmentGroup[] {
  const groups = new Map<string, { id: string; label: string; targets: TargetSnapshot[] }>();
  const unknown: TargetSnapshot[] = [];
  for (const target of targets) {
    const application = target.manifest?.application;
    if (application === undefined) {
      unknown.push(target);
      continue;
    }
    const group = groups.get(application.id) ?? { id: application.id, label: application.label, targets: [] };
    group.targets.push(target);
    groups.set(application.id, group);
  }
  return [...groups.values(), ...(unknown.length === 0 ? [] : [{ id: "", targets: unknown }])];
}
