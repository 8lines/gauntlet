// Pure catalog: this module imports nothing, so release-model.mjs can import it without a cycle.
function deeplyFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deeplyFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const npm = (id, directory, name, dependsOn, gates, implementsProtocol = true) => ({
  id,
  kind: "npm",
  version: { type: "json", path: `${directory}/package.json`, keyPath: ["version"] },
  dependsOn,
  ownedPaths: [
    `${directory}/src/**`,
    `${directory}/package.json`,
    ...(id === "protocol" ? [`${directory}/schemas/**`, `${directory}/openapi/**`, `${directory}/fixtures/**`] : []),
  ],
  tagPrefix: `${id}-v`,
  artifacts: [name],
  contracts: implementsProtocol ? { implements: { protocol: 1 } } : {},
  gates,
});

const units = [
  {
    id: "gauntlet",
    kind: "application",
    version: { type: "file", path: "VERSION" },
    dependsOn: ["protocol", "dashboard-client"],
    ownedPaths: [
      "apps/server/src/**", "apps/server/package.json", "apps/dashboard/src/**", "apps/dashboard/index.html",
      "apps/dashboard/widget/**", "apps/dashboard/package.json", "packages/widget-loader/src/**",
      "packages/widget-channel/src/**", "Dockerfile", "deploy/helm/gauntlet/**", "deploy/compose/**",
    ],
    tagPrefix: "v",
    artifacts: ["ghcr.io/8lines/gauntlet", "gauntlet", "gauntlet-compose"],
    contracts: { supports: { protocol: [1], widgetChannel: [1] } },
    gates: ["node", "dashboard", "widget", "widget-panel", "deployment", "security"],
  },
  npm("protocol", "packages/protocol", "@8lines/gauntlet-protocol", [], ["node", "conformance"]),
  npm("dashboard-client", "packages/dashboard-client", "@8lines/gauntlet-dashboard-client", ["protocol"], ["node"]),
  npm("typescript-core", "packages/typescript/core", "@8lines/gauntlet-typescript-core", ["protocol"], ["node", "conformance"]),
  npm("typescript-node", "packages/typescript/node", "@8lines/gauntlet-typescript-node", ["protocol", "typescript-core"], ["node", "conformance"]),
  npm("next-adapter", "packages/typescript/next", "@8lines/gauntlet-next-adapter", ["typescript-node"], ["node", "conformance"]),
  npm("conformance-runner", "conformance/runner", "@8lines/gauntlet-conformance-runner", ["protocol"], ["node", "conformance"]),
  npm("widget", "packages/widget", "@8lines/gauntlet-widget", [], ["node", "widget"], false),
  {
    id: "php-core",
    kind: "composer",
    version: { type: "json", path: "packages/php/core/composer.json", keyPath: ["version"] },
    dependsOn: [],
    ownedPaths: ["packages/php/core/src/**", "packages/php/core/composer.json"],
    tagPrefix: "php-core-v",
    artifacts: ["8lines/gauntlet-php-core"],
    contracts: { implements: { protocol: 1 } },
    gates: ["php", "conformance"],
  },
  {
    id: "symfony-bundle",
    kind: "composer",
    version: { type: "json", path: "packages/php/symfony-bundle/composer.json", keyPath: ["version"] },
    dependsOn: ["php-core"],
    ownedPaths: ["packages/php/symfony-bundle/src/**", "packages/php/symfony-bundle/config/**", "packages/php/symfony-bundle/composer.json"],
    tagPrefix: "symfony-bundle-v",
    artifacts: ["8lines/gauntlet-symfony-bundle"],
    contracts: { implements: { protocol: 1 } },
    gates: ["php", "conformance"],
  },
  {
    id: "java-core",
    kind: "maven",
    version: { type: "file", path: "packages/java/core/VERSION" },
    dependsOn: [],
    ownedPaths: ["packages/java/core/src/main/**", "packages/java/core/build.gradle.kts", "packages/java/core/VERSION"],
    tagPrefix: "java-core-v",
    artifacts: ["dev.eightlines.gauntlet:core"],
    contracts: { implements: { protocol: 1 } },
    gates: ["java", "conformance"],
  },
  {
    id: "spring-boot-starter",
    kind: "maven",
    version: { type: "file", path: "packages/java/spring-boot-starter/VERSION" },
    dependsOn: ["java-core"],
    ownedPaths: [
      "packages/java/spring-boot-starter/src/main/**", "packages/java/spring-boot-starter/build.gradle.kts",
      "packages/java/spring-boot-starter/VERSION",
    ],
    tagPrefix: "spring-boot-starter-v",
    artifacts: ["dev.eightlines.gauntlet:spring-boot-starter"],
    contracts: { implements: { protocol: 1 } },
    gates: ["java", "conformance"],
  },
  {
    id: "skills",
    kind: "skills",
    version: { type: "file", path: "skills/VERSION" },
    dependsOn: [
      "gauntlet", "protocol", "typescript-core", "typescript-node", "next-adapter", "php-core", "symfony-bundle",
      "java-core", "spring-boot-starter",
    ],
    ownedPaths: ["skills/gauntlet-app-integration/**", "skills/gauntlet-extension-authoring/**", "skills/gauntlet-upgrade/**"],
    tagPrefix: "skills-v",
    artifacts: ["gauntlet-skills"],
    contracts: {},
    gates: ["skills"],
  },
];

export function validateUnits(candidate) {
  const ids = candidate.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new Error("Release unit catalog contains a duplicate id");
  const known = new Set(ids);
  for (const unit of candidate) {
    for (const dependency of unit.dependsOn) {
      if (!known.has(dependency)) throw new Error(`Release unit ${unit.id} has an unknown dependency ${dependency}`);
    }
  }
  const visiting = new Set();
  const done = new Set();
  const byId = new Map(candidate.map((unit) => [unit.id, unit]));
  const visit = (id) => {
    if (done.has(id)) return;
    if (visiting.has(id)) throw new Error(`Release unit catalog contains a dependency cycle at ${id}`);
    visiting.add(id);
    for (const dependency of byId.get(id).dependsOn) visit(dependency);
    visiting.delete(id);
    done.add(id);
  };
  for (const id of ids) visit(id);
  const prefixes = candidate.map(({ tagPrefix }) => tagPrefix);
  if (new Set(prefixes).size !== prefixes.length) throw new Error("Release unit catalog contains a duplicate tag prefix");
  const artifacts = candidate.flatMap(({ artifacts }) => artifacts);
  if (new Set(artifacts).size !== artifacts.length) throw new Error("Release unit catalog assigns an artifact twice");
}

validateUnits(units);
export const RELEASE_UNITS = deeplyFreeze(units);
const BY_ID = new Map(RELEASE_UNITS.map((unit) => [unit.id, unit]));

export function unitById(id) {
  const unit = BY_ID.get(id);
  if (unit === undefined) throw new Error(`Unknown release unit ${id}`);
  return unit;
}

export function unitTag(unit, version) {
  return `${unit.tagPrefix}${version}`;
}

export function dependencyOrder(ids = RELEASE_UNITS.map(({ id }) => id)) {
  const wanted = new Set(ids.map((id) => unitById(id).id));
  const ordered = [];
  const placed = new Set();
  const place = (id) => {
    if (placed.has(id)) return;
    for (const dependency of unitById(id).dependsOn) place(dependency);
    placed.add(id);
    if (wanted.has(id)) ordered.push(id);
  };
  for (const unit of RELEASE_UNITS) if (wanted.has(unit.id)) place(unit.id);
  return Object.freeze(ordered);
}

export function dependentsOf(id) {
  unitById(id);
  const reached = new Set();
  let frontier = [id];
  while (frontier.length > 0) {
    const next = [];
    for (const unit of RELEASE_UNITS) {
      if (!reached.has(unit.id) && unit.dependsOn.some((dependency) => frontier.includes(dependency))) {
        reached.add(unit.id);
        next.push(unit.id);
      }
    }
    frontier = next;
  }
  return dependencyOrder([...reached]);
}
