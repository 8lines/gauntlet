import { validateStaticTargets, type StaticTargetConfig } from "./static-target-provider.js";
import type { TargetProvider } from "./target-provider.js";

export interface TargetRegistry {
  list(): readonly StaticTargetConfig[];
  get(id: string): StaticTargetConfig | undefined;
  require(id: string): StaticTargetConfig;
}

export function createTargetRegistry(providers: readonly TargetProvider[]): TargetRegistry {
  const targets: StaticTargetConfig[] = [];
  const byId = new Map<string, StaticTargetConfig>();
  for (const provider of providers) {
    const provided = validateStaticTargets(provider.targets());
    for (const target of provided) {
      if (byId.has(target.id)) {
        throw new TypeError(`Duplicate target id: ${target.id}`);
      }
      byId.set(target.id, target);
      targets.push(target);
    }
  }
  const ownedTargets = Object.freeze(targets);

  return Object.freeze({
    list(): readonly StaticTargetConfig[] {
      return ownedTargets;
    },
    get(id: string): StaticTargetConfig | undefined {
      return byId.get(id);
    },
    require(id: string): StaticTargetConfig {
      const target = byId.get(id);
      if (target === undefined) {
        throw new TypeError(`Unknown target: ${id}`);
      }
      return target;
    },
  });
}
