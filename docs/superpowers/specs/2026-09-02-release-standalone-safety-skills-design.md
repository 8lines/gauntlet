# Gauntlet v0.1 Release, Standalone, Safety, and AI Skills Design

Date: 2026-09-02  
Status: approved for implementation

## Purpose

This specification takes the existing Adapter v1 protocol, control plane, dashboard work, SDKs, examples, and conformance suite to a releasable internal v0.1. Gauntlet must be simple to deploy as one standalone service, able to control multiple explicitly integrated applications, and mechanically unavailable in production deployments.

The release is an internal, private 8lines product. Authentication inside Gauntlet remains deferred for v0.1, so every supported deployment keeps both the dashboard and adapter routes behind a trusted private network boundary.

## Decisions

- The canonical source repository is the private `8lines/gauntlet` repository.
- The repository stays a monorepo and `main` is the integration branch.
- The product image contains the browser dashboard and Fastify control plane in one immutable OCI image.
- Docker Compose and Helm are the supported deployment paths.
- One Gauntlet instance controls one non-production environment scope and may contain many targets.
- Target discovery remains explicit configuration; Gauntlet receives no Docker or Kubernetes discovery privileges.
- Environment identity is structured and mandatory. Production is not a supported environment kind and there is no override switch.
- SDK adapters remain disabled by default and fail closed when enabled without valid non-production metadata.
- The control plane independently verifies its environment and every target's advertised environment before enabling execution.
- Registry artifacts are private and versioned together for v0.1.
- Two repository-owned AI skills cover application integration and feature authoring. Both use hard safety gates and evidence-based verification.

## Goals

- Build and publish one image that serves both UI and API.
- Provide a one-command standalone Docker Compose installation.
- Provide a reusable Helm chart with secure non-production defaults.
- Support multiple small applications through one standalone instance.
- Make target configuration readable, versioned, schema-validatable, and mountable as a file.
- Prevent accidental production activation in the server and every supported SDK.
- Prevent a Gauntlet instance from invoking an adapter from a different environment.
- Make confirmation and dry-run declarations truthful runtime behavior.
- Publish installable TypeScript, PHP/Symfony, and Java/Spring integrations.
- Add reproducible CI and tag-based release automation.
- Supply tested AI skills for safe integration and extension authoring.
- Bring documentation in line with the actual shipped UI, deployment model, package distribution, and limitations.

## Non-goals for v0.1

- End-user login, roles, and authorization in the Gauntlet UI.
- Production operation or a break-glass production mode.
- Public adapter routes.
- Automatic application, Docker, namespace, or Kubernetes service discovery.
- Arbitrary SQL, shell, HTTP proxying, route invocation, command class selection, queue topic selection, or reflection-based exposure.
- Multiple control-plane replicas or durable dashboard history.
- A bundled distributed adapter run store, coordinator, or event backplane.
- A public package release or open-source licensing decision.
- A plugin marketplace or application-supplied executable UI code.

## Product Topology

```text
trusted tester browser
        |
        | private ingress, VPN, Tailscale, or loopback
        v
+-------------------------------------------+
| Gauntlet image                          |
| dashboard static files + Fastify /api/v1  |
+-------------------------------------------+
        |
        | private server-to-server HTTP
        +--------------------+---------------------+
        v                    v                     v
 Symfony adapter       Spring adapter       Node/Next adapter
        |                    |                     |
 explicit handlers     explicit handlers     explicit handlers
```

The browser never calls an adapter. Each application mounts exactly one normalized `/_gauntlet/v1` transport and exposes only explicitly registered features, operations, and data sources.

## Environment Identity and Production Denial

### Structured environment descriptor

Environment names are project-specific, so safety cannot depend only on string heuristics. The protocol uses a structured descriptor:

```json
{
  "name": "pp-dev",
  "kind": "staging"
}
```

`name` is the deployment's human and machine-readable identity. `kind` is one of:

- `development`
- `test`
- `qa`
- `staging`
- `uat`
- `preview`
- `sandbox`

There is intentionally no `production` value. The normalized descriptor replaces the current optional free-form application environment string before the first published protocol release.

### Adapter startup gate

Every framework integration implements the same rules:

1. disabled is the default;
2. a disabled adapter keeps the entire prefix closed with the canonical disabled response;
3. `enabled: true` requires application ID, label, structured environment, and stable idempotency secret;
4. missing or unsupported environment configuration fails during application construction or startup, before a handler can be reached;
5. conventional production aliases in `environment.name` (`prod`, `production`, and `live`, including common separated suffixes) are rejected as an additional accidental-misconfiguration guard;
6. there is no environment variable or API option that bypasses the guard.

The guard prevents accidental configuration. It cannot prove physical infrastructure identity when an operator deliberately supplies false metadata. Deployment review and private network isolation remain required controls.

### Control-plane gate

The control plane has its own required environment descriptor and refuses to start without a recognized non-production value. Each target contains `expectedEnvironment`; discovery compares it with the adapter manifest. A mismatch produces a sanitized unavailable target and blocks every operation, data-source, upload, cancel, event, and launch proxy route for that target.

Comparison is exact for both `name` and `kind`. This prevents a staging Gauntlet from silently controlling an adapter advertising a different environment.

## Standalone Configuration

The server supports a versioned YAML or JSON file selected by `GAUNTLET_CONFIG_FILE`. The container default is `/etc/gauntlet/config.yaml`. The existing `GAUNTLET_TARGETS_JSON` remains a deprecated compatibility input for the initial migration, but it cannot omit the instance environment or target expectations.

```yaml
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
    publicUrl: https://dev.billing.example
    expectedEnvironment:
      name: dev
      kind: development
    tags:
      - node
      - payments

  - id: portal
    label: Portal
    adapterUrl: http://portal:8080
    expectedEnvironment:
      name: dev
      kind: development
    tags:
      - symfony
```

The configuration is validated as a closed document before the server listens. Unknown fields, duplicate IDs, credential-bearing URLs, URLs with paths/queries/fragments, invalid environment identities, and empty target lists fail startup with safe diagnostics. Target URLs remain deployment-owned and are never supplied by a browser request.

Configuration reload is not part of v0.1. A configuration change restarts the single replica. Helm includes a ConfigMap checksum so this happens automatically.

## Docker Compose Deployment

`deploy/compose` is an operational distribution rather than a smoke fixture. It contains:

- `compose.yaml` using a prebuilt immutable GHCR image;
- `.env.example` with image version and loopback/private bind options;
- `config.example.yaml` with multiple targets;
- a health check and hardened container settings;
- instructions for upgrades, rollback, logs, and target changes;
- an optional local build override for contributors.

The default browser port binds to `127.0.0.1`. A user may explicitly bind it to a private Tailscale/VPN address. No adapter port is published by this deployment.

For many small Compose applications, Gauntlet and the target services join a shared external network named `gauntlet`. Each application adds only its adapter-bearing service to that network. This avoids host-published adapter ports and allows one dashboard to control applications from separate Compose projects.

The existing root Compose file remains the isolated smoke topology and is renamed or clearly labeled so it cannot be confused with the deployment distribution.

## Kubernetes Deployment

The supported Kubernetes artifact is an OCI Helm chart. Defaults are:

- one replica;
- `ClusterIP` service;
- ingress disabled;
- no service-account token mounting;
- no RBAC and no cluster discovery;
- non-root, read-only filesystem, dropped capabilities, seccomp, and bounded resources;
- explicit target URLs;
- chart schema validation for environment and targets;
- ConfigMap checksum rollout;
- liveness for the process and readiness for valid server initialization;
- pod disruption behavior compatible with a single in-memory control plane.

Optional examples show private ALB, Tailscale/VPN, and namespace-scoped NetworkPolicy integration. NetworkPolicy examples cover both ingress to Gauntlet and egress from Gauntlet to adapters, including explicitly configured namespaces and ports. The chart never enables public ingress by default and cannot render with a production environment kind.

## Dashboard Packaging

The existing dashboard work is incorporated into the product rather than distributed as a separate service:

1. the Docker build compiles protocol, dashboard client, dashboard, and server;
2. only runtime dependencies, server output, and static dashboard output enter the final image;
3. Fastify serves dashboard files at `/` and API routes at `/api/v1`;
4. SPA fallback applies only to browser `GET` routes outside `/api` and `/health`;
5. malformed and unknown API routes keep RFC 9457 behavior;
6. a missing dashboard directory is an explicit startup error in the release image, while the server library may still be instantiated headlessly in tests.

Responsive behavior is verified at small mobile and desktop viewports. Core actions, confirmations, validation messages, progress, and results must remain usable without horizontal page scrolling.

## Execution Safety Corrections

### Confirmation acknowledgement

`confirmationRequired` currently describes UI only. Before v0.1, create-run gains a typed confirmation acknowledgement bound to the operation ID, exact operation revision, and declared impact. SDK runtimes reject a request when acknowledgement is required and absent, stale, or inconsistent.

Semantic rules require:

- `destructive` operations to set `confirmationRequired: true`;
- `destructive` operations to set `idempotency: required`;
- confirmation to be checked before admission and handler execution.

This protects against accidental execution and stale UI state. It is not caller authentication or application-domain authorization.

### Dry-run propagation

`dryRunSupported` is truthful only if the selected mode reaches application code. Run context in TypeScript, PHP, and Java gains a read-only dry-run indicator. The runtime rejects dry-run when unsupported and passes the verified mode when supported.

Every SDK includes a mutation-sentinel test proving a dry-run handler path does not call the fixture's mutating dependency. The feature-authoring skill permits `dryRunSupported: true` only when the consumer supplies an equivalent test. Otherwise it writes `false` or creates a separate read-only preview operation.

### Existing controls retained

The release preserves explicit allow-listing, fixed routes, closed schemas, canonical revisions, response validation, secret non-retention, HMAC idempotency fingerprints, bounded uploads and data sources, capability negotiation, cancellation semantics, and one-replica warnings.

## Package Distribution

All v0.1 artifacts share version `0.1.0`, while Adapter protocol compatibility remains independently declared as v1. Supported consumer baselines are Node.js 24-26, PHP 8.3+ with Symfony 7.2+, and Java 21 with the documented Spring Boot line. The PHP/Symfony baseline intentionally matches the first planned production integration rather than only the newest local toolchain.

### npm

The protocol, dashboard client, TypeScript Core, Node transport, Next bridge, and conformance runner publish to GitHub Packages under `@8lines`. Packages contain README, proprietary license metadata, repository links, types, runtime output, and no `workspace:` dependencies.

### Composer

Composer cannot directly consume package definitions located in monorepo subdirectories. A tag release therefore splits:

- `packages/php/core` to private `8lines/gauntlet-php-core`;
- `packages/php/symfony-bundle` to private `8lines/gauntlet-symfony-bundle`.

Both split repositories receive the same immutable version tag. The consuming application configures them as authenticated VCS repositories. Cross-repository publishing uses a narrowly scoped organization secret or GitHub App; the default workflow token is not assumed to have cross-repository write access.

### Maven

Java Core and the Spring Boot starter publish to GitHub Packages Maven with generated POM metadata, sources JARs, Javadoc JARs, reproducible archives, and release versions without `-SNAPSHOT`.

### OCI image and Helm chart

The all-in-one image and chart publish to GHCR. Release automation emits immutable semantic and commit tags, digests, SBOMs, vulnerability scan results, and GitHub build provenance. Deployment examples use a version or digest, never `latest`.

## Versioning and Release Automation

A root release version is the source of truth. A repository script checks or updates npm manifests, Composer manifests, Gradle, chart metadata, examples, and documentation. A tag is accepted only when every artifact version matches it.

CI on pull requests and `main` runs:

- clean pnpm install, build, typecheck, unit tests, dashboard tests, and packed-consumer tests;
- PHP Core, Symfony bundle, and Symfony example verification in the supported PHP matrix;
- Java Core, starter, example, and consumer fixture verification;
- Adapter v1 conformance;
- all-in-one image build and Compose smoke test;
- Helm lint, schema validation, and rendered-manifest checks;
- production dependency audit and container vulnerability scan;
- documentation and release metadata checks.

Tag-based release runs the same gates before publishing. It produces a GitHub release with changelog, checksums, package/archive inventory, image and chart digests, and upgrade notes. Publication never runs from a dirty checkout or an untagged branch.

## Repository Policy and Documentation

The repository adds:

- proprietary project license notice;
- `CHANGELOG.md`;
- `SECURITY.md` describing private reporting and the non-production boundary;
- `CONTRIBUTING.md` with protocol-first and TDD rules;
- package-level release metadata and missing README files;
- an architecture index and deployment decision guide;
- a release runbook and rollback instructions.

The root README is updated to stop describing the dashboard and registry publication as deferred. It distinguishes shipped production-quality internal artifacts from fixtures and documents every top-level directory.

## AI Skill: Application Integration

`skills/gauntlet-app-integration` installs and verifies Gauntlet in an existing application or deployment. It does not author domain operations.

The skill:

1. detects the application stack and reads the matching SDK guide;
2. establishes explicit evidence that the requested deployment is non-production;
3. refuses production, ambiguous, or public-adapter work;
4. installs the released package rather than copying monorepo source;
5. configures structured environment metadata and a stable secret;
6. mounts exactly one framework transport;
7. keeps the adapter route private and records the network control used;
8. configures single-process or distributed runtime components truthfully;
9. adds or updates the explicit Gauntlet target;
10. verifies disabled behavior, environment mismatch behavior, live conformance, and the public-ingress denial.

For Next.js, the skill additionally requires real trusted raw-request ingress handling and adversarial raw-path tests. It cannot claim the integration hardened based only on application route code.

The skill stops without marking the integration complete when non-production identity, private routing, a required secret, or verification evidence is missing.

## AI Skill: Feature and Extension Authoring

`skills/gauntlet-extension-authoring` creates features, operations, data sources, and optional capability bindings inside an already integrated application. It does not mount transports or broaden network exposure.

The skill enforces:

- one narrow application-owned behavior behind each operation;
- no request-selected class, route, SQL, command name, topic, filesystem path, or arbitrary URL;
- closed portable input, output, dependency, and context schemas;
- bounded data sources with cursor semantics and stable resolve ordering;
- explicit secret and file handling;
- truthful impact, confirmation, dry-run, idempotency, cancellation, timeout, and concurrency policies;
- domain validation and tenant boundaries in the handler;
- negative tests, mutation-sentinel tests, idempotency replay tests, output validation, and leak checks;
- conformance or framework-equivalent integration verification.

The skill treats confirmation as an accident-prevention gate, not authorization. It never infers that Gauntlet invocation bypasses application security rules.

## Skill Verification

Each skill is developed independently using pressure scenarios before its instruction files are written. Scenarios include attempts to:

- integrate into a production or ambiguously named deployment;
- publish an adapter route through public ingress;
- enable an adapter without a stable secret;
- copy fixture defaults into a deployed service;
- create an arbitrary SQL or command dispatcher;
- mark a mutating handler as dry-run safe without a sentinel test;
- rely on UI confirmation as authentication;
- claim success without conformance and negative-path evidence.

The skill passes only when an independent agent follows it and consistently refuses unsafe shortcuts while completing valid non-production cases.

## Error Handling and Diagnostics

- Invalid instance configuration prevents server startup with a bounded diagnostic that does not echo secrets.
- Invalid adapter configuration fails application startup when enabled.
- Disabled adapters return the canonical 503 response before body parsing or handler lookup.
- Environment mismatch appears as target unavailability and never falls through to proxy execution.
- One malformed target does not hide healthy targets.
- UI errors use sanitized RFC 9457 Problems and preserve a correlation/request ID.
- Health remains process liveness; readiness additionally proves that configuration loaded and the HTTP server initialized. Target health is reported per target and does not restart the control plane.

## Migration

The repository has no published v0.1 consumers, so the environment metadata and create-run changes are completed before the first tag rather than carried as legacy protocol behavior. All fixtures, SDK models, examples, and conformance vectors change together.

Existing uncommitted dashboard and Fastify static-serving work is treated as input to the release implementation. It is reviewed, tested, and either incorporated or replaced; it is never silently discarded.

## Acceptance Criteria

The release is ready only when all of the following are proven from a clean checkout:

1. the repository is clean, has an `8lines/gauntlet` private remote, and all intended source is committed on `main`;
2. one documented command runs the complete release verification suite;
3. the release image serves a usable mobile and desktop dashboard plus the complete API;
4. the operational Compose distribution starts from published-style artifacts and discovers at least two adapters;
5. the Helm chart lints and renders secure defaults plus representative private-ingress and cross-namespace values;
6. the server and every SDK fail closed for missing, production-like, or unsupported environments;
7. target environment mismatch prevents every proxy execution path;
8. confirmation acknowledgement and destructive-operation semantic rules are runtime-enforced;
9. dry-run reaches handlers and mutation-sentinel tests pass in every SDK;
10. clean external consumers install and use every publishable package artifact;
11. CI and a local release dry-run prove version, archive, image, chart, SBOM, and metadata generation;
12. both AI skills pass their pressure scenarios and their installation instructions work;
13. root and package documentation accurately describe installation, architecture, directories, safety boundaries, deployment, operation authoring, release, upgrade, and rollback;
14. authentication, one-replica limits, and all other deferred scope are explicit and cannot be mistaken for implemented guarantees.
