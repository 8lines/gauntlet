import type { StaticTargetConfig } from "./static-target-provider.js";

export interface TargetProvider {
  targets(): readonly StaticTargetConfig[];
}
