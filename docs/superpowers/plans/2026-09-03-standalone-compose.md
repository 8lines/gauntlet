# Standalone Docker Compose Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide an operational Docker Compose distribution that starts the published all-in-one Gauntlet image with one command after configuration and can privately reach adapters from many independent Compose applications.

**Architecture:** The distribution mounts the versioned control-plane YAML read-only, publishes only the dashboard/control-plane port on loopback or an explicitly supplied private address, and joins a shared external `gauntlet` network. A small wrapper creates that network idempotently and delegates lifecycle commands to Docker Compose; an independent smoke topology builds locally and verifies two adapters without turning fixtures into deployment defaults.

**Tech Stack:** Docker Engine 29-compatible Compose v2, OCI image `ghcr.io/8lines/gauntlet`, Node.js 24 verification scripts, YAML configuration version 1.

**Spec:** `docs/superpowers/specs/2026-09-02-release-standalone-safety-skills-design.md`

## Global Constraints

- The operational distribution uses a prebuilt versioned or digest-pinned image; it has no `build` key.
- The default browser bind is exactly `127.0.0.1`; `0.0.0.0` is never a documented default.
- A user may explicitly set a concrete private Tailscale or VPN address.
- No adapter port is published by Gauntlet or by the target-application integration example.
- All target URLs remain in a read-only configuration file and are never supplied by a browser.
- One Gauntlet instance controls one explicit non-production environment and may list many targets.
- `EnvironmentDescriptor` and `assertNonProductionEnvironment` are consumed indirectly through the server configuration loader; Compose does not implement a weaker shell-level production check.
- The adapter network is the explicitly named external Docker network `gauntlet`.
- The product remains single-replica with in-memory dashboard/run projection state.
- Authentication is not present in v0.1; the dashboard and API must stay behind loopback, Tailscale, VPN, or another trusted private boundary.
- Configuration changes and upgrades restart the one container; live reload is not supported.
- Runtime containers use a read-only root filesystem, a bounded `/tmp`, no added Linux capabilities, and `no-new-privileges`.

---

### Task 1: Operational Compose Contract and Static Verifier

**Files:**
- Create: `deploy/compose/compose.yaml`
- Create: `deploy/compose/.env.example`
- Create: `deploy/compose/config.example.yaml`
- Create: `scripts/verify-compose-distribution.mjs`
- Modify: `.gitignore`
- Modify: `package.json`

**Interfaces:**
- Consumes: product image environment defaults `GAUNTLET_CONFIG_FILE=/etc/gauntlet/config.yaml` and `GAUNTLET_DASHBOARD_DIR=/app/dashboard`.
- Consumes: versioned configuration schema from `config/gauntlet-config-v1.schema.json`.
- Produces: `deploy/compose/compose.yaml` with service `gauntlet`, networks `ingress` and external `adapters`, and read-only `/etc/gauntlet/config.yaml` mount.
- Produces: root script `test:compose:distribution` invoking `node scripts/verify-compose-distribution.mjs`.

- [ ] **Step 1: Add a failing rendered-Compose verifier**

```js
// scripts/verify-compose-distribution.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const result = spawnSync("docker", [
  "compose",
  "--env-file", "deploy/compose/.env.example",
  "-f", "deploy/compose/compose.yaml",
  "config", "--format", "json",
], { encoding: "utf8" });
assert.equal(result.status, 0, result.stderr);
const model = JSON.parse(result.stdout);
const service = model.services["gauntlet"];
assert.equal("build" in service, false);
assert.match(service.image, /^ghcr\.io\/8lines\/gauntlet:(?!latest$).+/);
assert.deepEqual(service.cap_drop, ["ALL"]);
assert.equal(service.read_only, true);
assert.equal(service.security_opt.includes("no-new-privileges:true"), true);
assert.equal(service.ports[0].host_ip, "127.0.0.1");
assert.equal(model.networks.adapters.external, true);
assert.equal(model.networks.adapters.name, "gauntlet");
const serialized = JSON.stringify(service);
assert.equal(serialized.includes("/_gauntlet/v1"), false);
assert.equal(serialized.includes("/ready"), true);
```

- [ ] **Step 2: Run the verifier and confirm RED**

Run: `node scripts/verify-compose-distribution.mjs`

Expected: FAIL because the operational Compose distribution does not exist.

- [ ] **Step 3: Allow only the committed environment example through `.gitignore`**

Append exact negations after the existing `.env` rules:

```gitignore
!deploy/compose/.env.example
```

Do not unignore arbitrary `.env.example` files repository-wide.

- [ ] **Step 4: Create the environment and configuration examples**

```dotenv
# deploy/compose/.env.example
GAUNTLET_IMAGE=ghcr.io/8lines/gauntlet:0.1.0
GAUNTLET_BIND=127.0.0.1
GAUNTLET_PORT=8080
GAUNTLET_CONFIG_PATH=./config.yaml
```

```yaml
# deploy/compose/config.example.yaml
# yaml-language-server: $schema=../../config/gauntlet-config-v1.schema.json
version: 1
instance:
  name: small-apps-dev
  environment:
    name: dev
    kind: development
targets:
  - id: billing
    label: Billing
    adapterUrl: http://billing:8080
    expectedEnvironment:
      name: dev
      kind: development
    tags: [node, payments]
  - id: portal
    label: Portal
    adapterUrl: http://portal:8080
    expectedEnvironment:
      name: dev
      kind: development
    tags: [symfony]
```

- [ ] **Step 5: Create the hardened operational service**

```yaml
# deploy/compose/compose.yaml
name: gauntlet

services:
  gauntlet:
    image: ${GAUNTLET_IMAGE:?GAUNTLET_IMAGE is required}
    restart: unless-stopped
    init: true
    environment:
      GAUNTLET_HOST: "0.0.0.0"
      GAUNTLET_PORT: "8080"
      GAUNTLET_CONFIG_FILE: /etc/gauntlet/config.yaml
    ports:
      - "${GAUNTLET_BIND:-127.0.0.1}:${GAUNTLET_PORT:-8080}:8080"
    volumes:
      - "${GAUNTLET_CONFIG_PATH:-./config.yaml}:/etc/gauntlet/config.yaml:ro"
    networks:
      - ingress
      - adapters
    read_only: true
    tmpfs:
      - /tmp:size=16m,mode=1777
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    pids_limit: 128
    stop_grace_period: 10s
    healthcheck:
      test:
        - CMD
        - node
        - -e
        - >-
          fetch('http://127.0.0.1:8080/ready', { signal: AbortSignal.timeout(1500) }).then((response) => process.exit(response.status === 200 ? 0 : 1)).catch(() => process.exit(1))
      interval: 10s
      timeout: 2s
      retries: 6
      start_period: 5s

networks:
  ingress: {}
  adapters:
    name: gauntlet
    external: true
```

- [ ] **Step 6: Add the root verification script and confirm GREEN**

```json
{
  "scripts": {
    "test:compose:distribution": "node scripts/verify-compose-distribution.mjs"
  }
}
```

Run: `pnpm test:compose:distribution`

Expected: PASS and no Compose warning about obsolete schema fields.

- [ ] **Step 7: Commit the operational contract**

```bash
git add .gitignore deploy/compose/compose.yaml deploy/compose/.env.example \
  deploy/compose/config.example.yaml scripts/verify-compose-distribution.mjs package.json
git commit -m "feat(deploy): add standalone Compose distribution"
```

### Task 2: Idempotent Lifecycle Wrapper and Local Build Override

**Files:**
- Create: `deploy/compose/gauntlet`
- Create: `deploy/compose/compose.build.yaml`
- Create: `deploy/compose/test/wrapper.test.mjs`

**Interfaces:**
- Consumes: `docker network inspect/create` and the Task 1 Compose file.
- Produces: executable `deploy/compose/gauntlet` supporting `init`, `up`, `pull`, `logs`, `restart`, `down`, and every other Compose subcommand by delegation.
- Produces: contributor override `compose.build.yaml` that changes only the image source to local Docker target `runtime`.

- [ ] **Step 1: Write a failing wrapper contract test with a fake Docker executable**

The test prepends a temporary directory containing a recording `docker` executable to `PATH`, copies only the wrapper and example files to another temporary directory, and asserts the exact subprocess sequence.

```js
test("up creates the shared network before delegating to Compose", () => {
  const result = runWrapper(["up", "-d", "--wait"], {
    existingNetwork: false,
    withInitializedFiles: true,
  });
  assert.equal(result.status, 0);
  assert.deepEqual(result.calls, [
    ["network", "inspect", "gauntlet"],
    ["network", "create", "gauntlet"],
    [
      "compose", "--project-directory", result.distribution,
      "--env-file", `${result.distribution}/.env`,
      "-f", `${result.distribution}/compose.yaml`,
      "up", "-d", "--wait",
    ],
  ]);
});

test("init copies examples once and never overwrites operator configuration", () => {
  const first = runWrapper(["init"], { existingNetwork: false, withInitializedFiles: false });
  assert.equal(first.envContents.includes("GAUNTLET_BIND=127.0.0.1"), true);
  const second = runWrapper(["init"], { existingNetwork: true, withInitializedFiles: true });
  assert.equal(second.status, 1);
  assert.equal(second.envContents, first.envContents);
});
```

- [ ] **Step 2: Run the wrapper test and confirm RED**

Run: `node --test deploy/compose/test/wrapper.test.mjs`

Expected: FAIL because the wrapper does not exist.

- [ ] **Step 3: Implement exact init and delegation behavior**

```sh
#!/bin/sh
set -eu

distribution_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ "${1:-}" = "init" ]; then
  test ! -e "$distribution_dir/.env"
  test ! -e "$distribution_dir/config.yaml"
  cp "$distribution_dir/.env.example" "$distribution_dir/.env"
  cp "$distribution_dir/config.example.yaml" "$distribution_dir/config.yaml"
  printf '%s\n' "Created .env and config.yaml; edit target origins before running up."
  exit 0
fi

test -f "$distribution_dir/.env"
test -f "$distribution_dir/config.yaml"
docker network inspect gauntlet >/dev/null 2>&1 || docker network create gauntlet >/dev/null
exec docker compose \
  --project-directory "$distribution_dir" \
  --env-file "$distribution_dir/.env" \
  -f "$distribution_dir/compose.yaml" \
  "$@"
```

The wrapper must be executable. It never sources `.env`, never evaluates user data, and never prints its contents.

- [ ] **Step 4: Add the contributor-only build override**

```yaml
# deploy/compose/compose.build.yaml
services:
  gauntlet:
    image: gauntlet:local
    build:
      context: ../..
      target: runtime
```

Contributor invocation is explicit and does not modify the operational file:

```bash
docker compose \
  --env-file deploy/compose/.env.example \
  -f deploy/compose/compose.yaml \
  -f deploy/compose/compose.build.yaml \
  up --build
```

- [ ] **Step 5: Run wrapper and rendered-model tests to confirm GREEN**

Run: `node --test deploy/compose/test/wrapper.test.mjs`

Expected: PASS without invoking the real Docker daemon.

Run: `pnpm test:compose:distribution`

Expected: PASS and continued absence of `build` from the operational model.

- [ ] **Step 6: Commit lifecycle tooling**

```bash
git add deploy/compose/gauntlet deploy/compose/compose.build.yaml deploy/compose/test/wrapper.test.mjs
git commit -m "feat(deploy): add safe Compose lifecycle wrapper"
```

### Task 3: Two-Adapter Product Smoke Topology

**Files:**
- Rename: `compose.example.yml` to `compose.smoke.yaml`
- Create: `conformance/smoke/gauntlet.config.yaml`
- Modify: `conformance/smoke/fake-adapter.mjs`
- Modify: `conformance/smoke/control-plane.test.mjs`
- Create: `scripts/run-compose-smoke.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: Dockerfile targets `runtime` and `smoke-adapter`, configuration v1, structured environment manifest fixtures, and `GAUNTLET_URL` used by the current smoke test.
- Produces: an isolated local topology containing `gauntlet`, `fake-adapter-a`, and `fake-adapter-b`.
- Produces: root script `smoke:compose` that owns setup, verification, and unconditional cleanup.

- [ ] **Step 1: Extend the smoke assertions before changing the topology**

```js
test("the product image serves dashboard assets and two configured adapters", async () => {
  const origin = configuredOrigin();
  const index = await fetch(`${origin}/`, { headers: { accept: "text/html" } });
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-type") ?? "", /^text\/html/);
  const html = await index.text();
  const assetPath = html.match(/(?:src|href)="(\/assets\/[^"]+)"/)?.[1];
  assert.ok(assetPath);
  assert.equal((await fetch(`${origin}${assetPath}`)).status, 200);

  const response = await fetch(`${origin}/api/v1/targets`);
  const body = await response.json();
  assert.deepEqual(body.targets.map(({ id }) => id), ["fixture-a", "fixture-b"]);
  assert.deepEqual(body.targets.map(({ state }) => state), ["online", "online"]);
  assertNoInternalTransport(body);
});
```

- [ ] **Step 2: Run the existing one-target topology and confirm RED**

Run: `docker compose -f compose.example.yml up --build -d --wait`

Expected: the existing one-target topology becomes healthy.

Run: `GAUNTLET_URL=http://127.0.0.1:8080 pnpm smoke`

Expected: FAIL because only one target is returned and the current runtime image does not serve the dashboard.

Run: `docker compose -f compose.example.yml down --volumes --remove-orphans`

Expected: the characterization topology is removed.

- [ ] **Step 3: Replace inline target JSON with a mounted v1 file and two adapters**

```yaml
# conformance/smoke/gauntlet.config.yaml
version: 1
instance:
  name: compose-smoke
  environment:
    name: compose-smoke
    kind: test
targets:
  - id: fixture-a
    label: Fixture A
    adapterUrl: http://fake-adapter-a:8081
    expectedEnvironment: { name: compose-smoke, kind: test }
  - id: fixture-b
    label: Fixture B
    adapterUrl: http://fake-adapter-b:8081
    expectedEnvironment: { name: compose-smoke, kind: test }
```

`compose.smoke.yaml` mounts that file at `/etc/gauntlet/config.yaml:ro`, builds target `runtime`, starts two independent services from target `smoke-adapter`, publishes only `127.0.0.1:8080`, and leaves both adapter services on an internal network with `expose: 8081` and no `ports`.

- [ ] **Step 4: Make the fake adapter advertise the exact smoke environment**

The fake adapter's protocol-valid manifest must contain:

```json
{
  "application": {
    "id": "fixture-adapter",
    "label": "Fixture adapter",
    "environment": {
      "name": "compose-smoke",
      "kind": "test"
    }
  }
}
```

Keep the manifest revision canonical after this change by updating the shared fixture through the protocol safety task rather than mutating it after serialization in the smoke server.

- [ ] **Step 5: Add an always-cleaning Compose smoke runner**

```js
// scripts/run-compose-smoke.mjs
import { spawnSync } from "node:child_process";

function run(command, args, environment = process.env, allowFailure = false) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: environment,
    stdio: "pipe",
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${command} ${args.join(" ")} exited ${String(result.status)}`);
  }
  return result;
}

const project = `gauntlet-smoke-${process.pid}`;
try {
  run("docker", ["compose", "-p", project, "-f", "compose.smoke.yaml", "up", "--build", "-d", "--wait"]);
  run(process.execPath, ["--test", "conformance/smoke/control-plane.test.mjs"], {
    ...process.env,
    GAUNTLET_URL: "http://127.0.0.1:8080",
  });
} finally {
  run("docker", [
    "compose", "-p", project, "-f", "compose.smoke.yaml",
    "down", "--volumes", "--remove-orphans",
  ], process.env, true);
}
```

The helper records stdout and stderr from every phase, throws on nonzero setup/test exit, and permits cleanup failure only from the `finally` block.

- [ ] **Step 6: Add the root command and confirm GREEN**

```json
{
  "scripts": {
    "smoke:compose": "node scripts/run-compose-smoke.mjs"
  }
}
```

Run: `pnpm smoke:compose`

Expected: PASS; two targets are online, UI assets load from the product image, and cleanup runs.

- [ ] **Step 7: Commit the isolated smoke topology**

```bash
git add compose.smoke.yaml conformance/smoke/gauntlet.config.yaml \
  conformance/smoke/fake-adapter.mjs conformance/smoke/control-plane.test.mjs \
  scripts/run-compose-smoke.mjs package.json
git rm compose.example.yml
git commit -m "test(deploy): smoke test two standalone adapters"
```

### Task 4: Operator Runbook for Many Small Applications

**Files:**
- Create: `deploy/compose/README.md`
- Create: `deploy/compose/test/README.test.mjs`

**Interfaces:**
- Consumes: Task 1 environment/config examples and Task 2 lifecycle wrapper.
- Produces: exact installation, private networking, target-change, upgrade, rollback, logs, and removal commands.
- Produces: a target-application Compose fragment joining only the adapter-bearing application service to the external `gauntlet` network.

- [ ] **Step 1: Add a failing runbook-content test**

```js
test("the runbook covers private lifecycle and never publishes an adapter", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  for (const text of [
    "docker login ghcr.io",
    "./gauntlet init",
    "./gauntlet up -d --wait",
    "./gauntlet logs -f",
    "./gauntlet restart",
    "./gauntlet pull",
    "./gauntlet down",
    "127.0.0.1",
    "Tailscale",
    "rollback",
    "authentication",
    "one replica",
  ]) assert.equal(readme.includes(text), true, text);
  const adapterExample = readme.slice(readme.indexOf("services:\n  billing:"));
  assert.equal(adapterExample.includes("ports:"), false);
  assert.equal(adapterExample.includes("external: true"), true);
});
```

- [ ] **Step 2: Run the runbook test and confirm RED**

Run: `node --test deploy/compose/test/README.test.mjs`

Expected: FAIL because the operational README does not exist.

- [ ] **Step 3: Write the exact first-run and application-network instructions**

The first-run sequence is:

```bash
cd deploy/compose
docker login ghcr.io
./gauntlet init
# edit config.yaml and keep every target in the declared non-production environment
./gauntlet up -d --wait
```

The target application fragment is:

```yaml
services:
  billing:
    expose:
      - "8080"
    networks:
      - default
      - gauntlet

networks:
  gauntlet:
    external: true
    name: gauntlet
```

Document that `GAUNTLET_BIND` may be `127.0.0.1` or one concrete private interface address, never a public wildcard. Changes to `config.yaml` use `./gauntlet restart`. Upgrade changes `GAUNTLET_IMAGE` to an immutable version/digest, then runs `pull` and `up -d --wait`. Rollback restores the preceding value and repeats those two commands. `logs -f`, health inspection, stop, and removal commands use the wrapper.

- [ ] **Step 4: Run all Compose documentation and model checks to confirm GREEN**

Run: `node --test deploy/compose/test/wrapper.test.mjs deploy/compose/test/README.test.mjs`

Expected: PASS.

Run: `pnpm test:compose:distribution`

Expected: PASS.

- [ ] **Step 5: Commit the runbook**

```bash
git add deploy/compose/README.md deploy/compose/test/README.test.mjs
git commit -m "docs(deploy): document standalone Compose operations"
```
