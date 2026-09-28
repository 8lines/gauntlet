import type { EnvironmentDescriptor } from "@8lines/gauntlet-protocol";

export const serverEnvironment: EnvironmentDescriptor = Object.freeze({
  name: "gauntlet-dev",
  kind: "development",
});

export const adapterEnvironment: EnvironmentDescriptor = Object.freeze({
  name: "development",
  kind: "development",
});
