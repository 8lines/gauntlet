# Gauntlet Backend and Adapter Architecture

Date: 2026-08-29  
Status: approved for implementation

## Purpose

Gauntlet is an environment-scoped control plane used by testers to inspect and manipulate applications deployed on non-production environments. Testers use a browser against a deployed Gauntlet instance; they do not need a local checkout, application CLI, database access, or cluster access.

Target applications install a language and framework integration package. Application code explicitly declares the features and operations that Gauntlet may expose. The integration package publishes a technology-neutral HTTP API. The Gauntlet backend discovers these APIs, validates their contracts, and invokes them without knowing whether a target uses Symfony, Spring, Next.js, or another framework.

## Goals

- Define one versioned, language-neutral adapter protocol.
- Support one Gauntlet deployment per non-production environment scope.
- Allow one Gauntlet instance to control multiple applications and services.
- Make adding an operation natural in PHP/Symfony, Java/Spring, and TypeScript/Next.js.
- Generate rich operation definitions suitable for a future dynamic UI.
- Support synchronous and asynchronous operations through one run lifecycle.
- Support application-owned data sources for selectors and autocomplete.
- Normalize results, progress, artifacts, validation errors, and business errors.
- Provide black-box conformance tests shared by every SDK.
- Deliver a reference Symfony integration against an example portal application.

## Deferred Scope

- The graphical dashboard is deferred until the backend and adapter protocol are proven.
- End-user authentication and authorization in Gauntlet are deferred. The architecture reserves transport and user-context extension points.
- Production deployment is unsupported. Gauntlet is absent from production, and adapters are disabled by default.
- Arbitrary database editors, arbitrary class dispatch, arbitrary SQL, and automatic exposure of application routes are not supported.
- A full plugin marketplace and custom dashboard widgets are deferred.

## Deployment Boundary

A Gauntlet instance belongs to exactly one environment scope:

- one Kubernetes namespace or an explicitly configured set of namespaces;
- one non-production Docker Compose stack;
- or an equivalent isolated environment boundary.

It may control multiple target applications inside that scope. Production has no Gauntlet deployment. Every adapter additionally requires explicit enablement such as `GAUNTLET_ENABLED=true`; environment-name heuristics are not sufficient.

The browser calls only the Gauntlet backend. The backend calls adapter APIs server-to-server over the environment's internal network. Adapter routes should be denied at public ingress. A later transport-authentication mechanism can be added without changing operation definitions.

## System Architecture

```text
Tester browser
    |
    v
Gauntlet backend (Fastify / TypeScript)
    |-- target registry and discovery
    |-- manifest cache and compatibility checks
    |-- adapter client and proxy
    |-- run-history projection
    `-- preset and runtime store
    |
    v
Target adapter HTTP API
    |-- framework integration
    |-- language core SDK
    |-- feature / operation / data-source registry
    |-- run manager
    `-- application handlers, DI, database, command bus, and queue
```

The adapter is the source of truth for operation execution. Gauntlet stores a projection for discovery and history. Restarting Gauntlet must not cancel a run already accepted by an adapter.

## Repository Layout

```text
gauntlet/
├── apps/
│   ├── server/                         # Fastify control plane
│   `── web/                            # deferred React dashboard
├── packages/
│   ├── protocol/                       # JSON Schema, OpenAPI, fixtures
│   ├── dashboard-client/               # adapter client used by server
│   ├── ui-renderer/                    # deferred dynamic UI
│   ├── typescript/
│   │   ├── core/
│   │   ├── node/
│   │   `── next/
│   ├── php/
│   │   ├── core/
│   │   `── symfony-bundle/
│   `── java/
│       ├── core/
│       `── spring-boot-starter/
├── conformance/
│   ├── runner/
│   `── scenarios/
├── examples/
│   ├── symfony/
│   ├── next/
│   `── spring/
`── docs/
```

The logical modules are more important than publishing mechanics. Protocol version, SDK package version, and individual operation revision are independent.

## Standards Baseline

- JSON payload schemas use JSON Schema Draft 2020-12 and declare `$schema` explicitly.
- HTTP APIs are documented with OpenAPI 3.2.
- Error responses use RFC 9457 Problem Details with Gauntlet extensions.
- JSON Pointer locates input validation failures and UI-bound fields.
- Remote `$ref` resolution is forbidden. Definitions use local `$defs` or bundled, allow-listed schema resources.
- Protocol IDs use the transport-safe alphabet `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`; percent-encoded and slash-containing IDs are invalid so Symfony, Spring, Node, proxies, and ingresses route them identically.
- Content-derived revisions use RFC 8785 JSON Canonicalization Scheme plus SHA-256.
- Core protocol objects are closed; optional forward-compatible data belongs in a namespaced `extensions` bag, while required behavior is declared through versioned profiles and capabilities.

OpenAPI documents the transport but is not the runtime operation catalog. The catalog contains Gauntlet concepts such as features, UI schemas, data sources, execution policies, run states, and result artifacts.

## Protocol Documents

The protocol is a family of independently testable documents rather than one unbounded manifest:

```text
AdapterManifest
├── protocol and capability negotiation
├── application and environment metadata
├── feature tree
`── operation summaries

OperationDefinition
├── input schema
├── context schema
├── UI schema
├── data-source references
├── execution policy
`── output contract

Run
├── lifecycle and progress
├── summary and artifacts
├── follow-up actions
`── problem details
```

### Version and Capability Negotiation

The manifest declares:

- `protocolVersion`, using major/minor semantics;
- `manifestRevision`, as a stable content digest;
- `schemaDialect`;
- supported versioned profiles such as `tc-schema-core@1`, `tc-rich-forms@1`, `tc-rich-results@1`, and `tc-async-runs@1`;
- optional capabilities such as uploads, cancellation, SSE, and session launch (polling remains mandatory).

Unknown namespaced extensions are ignored. A `1.x` consumer accepts later `1.x` manifests when every required profile and capability is supported. Profiles and capabilities on the manifest describe behavior implemented by that adapter. An `available` operation may require only entries the manifest advertises. An operation with an unmet requirement remains in the catalog as `unavailable`, retains its complete declared requirements, carries a safe schema-valid Problem, and must not run. Minor versions do not silently widen closed core fields or enums. No executable JavaScript or other executable content is accepted from a target manifest.

### Manifest and Feature Tree

Features form a tree using stable `id` and optional `parentId`. Each operation belongs to one primary feature and may have tags. Operation summaries contain stable ID, revision, label, feature ID, availability, and requirements. A binding that is invalid rather than merely unavailable is omitted from summaries and reported through a safe diagnostic. Once its ID has independently passed the protocol ID envelope check, that diagnostic may carry the omitted operation ID; diagnostic identity never makes the binding executable. Large definitions are not inlined into the manifest. The definition endpoint is derived from the fixed protocol route and operation ID; the manifest never supplies an executable URL. HTTP `ETag` supports caching.

### Operation Definition

An operation definition includes:

- stable `id` and content-derived `revision`;
- feature, label, description, icon token, ordering, and tags;
- input JSON Schema rooted at an object;
- optional context schema for system-supplied values;
- separate versioned UI schema;
- referenced data sources and presets;
- execution policy: impact, confirmation, dry-run, idempotency, cancellation, timeout, and concurrency behavior;
- output schema and presentation contract.

The UI schema describes controls, layout, conditional visibility, and presentation without changing data validity. JSON Schema remains the source of truth for structure and validation. Unknown optional widgets fall back to a renderer inferred from JSON Schema, then to a JSON editor. Conditions are declarative and contain no application-supplied code.

### Dynamic Data Sources

Static enums are used only for bounded lists. Dynamic selectors use adapter-owned data sources with normalized query and resolve endpoints. Queries support search text, cursor pagination, limit, dependencies on current form values, and declared context. Results use normalized items with `value`, `label`, optional description, group, disabled state, and metadata.

The adapter executes data-source code inside the target application. Gauntlet never receives database credentials or arbitrary upstream URLs.

### Files and Secrets

Large file content is not embedded in operation JSON. Uploads use a separate adapter-owned lifecycle and operation input contains an opaque, expiring file reference. Operation definitions carry machine-enforceable input-handling rules for file pointers and write-only secret pointers. Secret inputs use a no-retention policy and are removed from history, Problems, events, artifacts, actions, and logs. UI widgets and JSON Schema annotations alone do not enforce these policies; SDK runtime code does.

## Adapter HTTP API

The initial normalized surface is:

```text
GET  /_gauntlet/v1/health
GET  /_gauntlet/v1/manifest
GET  /_gauntlet/v1/operations/{operationId}
POST /_gauntlet/v1/operations/{operationId}/runs
GET  /_gauntlet/v1/runs/{runId}
POST /_gauntlet/v1/runs/{runId}/cancel
GET  /_gauntlet/v1/runs/{runId}/events
POST /_gauntlet/v1/data-sources/{dataSourceId}/query
POST /_gauntlet/v1/data-sources/{dataSourceId}/resolve
POST /_gauntlet/v1/uploads
POST /_gauntlet/v1/runs/{runId}/artifacts/{artifactId}/launch
```

Unsupported optional endpoints return a typed capability problem. Dynamic IDs are validated against the common safe-segment profile before routing and are otherwise treated as opaque values. Operation definitions never expose arbitrary application endpoints to the dashboard.

## Operation Runs

Every invocation creates a run, including synchronous operations. Run states are:

```text
queued -> running -> succeeded
                  -> failed
                  -> partial
                  -> cancelled
                  -> timed_out
                  -> expired
```

A create-run request includes operation revision, typed input, declared context, dry-run choice, and optional idempotency key. The adapter rejects a stale definition revision so the UI cannot submit data rendered from a materially different schema.

Run progress may include current, total, phase, message, and timestamp. Every immutable snapshot has a monotonic sequence plus created, updated, started, and terminal timestamps as applicable. Polling is mandatory. SSE and cancellation are optional capabilities. SSE v1 carries complete Run snapshots so replay is idempotent. The adapter provides a `RunStore` abstraction and ships an in-memory implementation for tests plus framework-appropriate persistence extension points.

Results contain a normalized summary and typed artifacts. Core artifact kinds include notice, metrics, key-value/detail, table, JSON, Markdown, diff, timeline, log, download, link, and browser launch. Large artifacts may be referenced by URL rather than embedded.

A browser-launch artifact supports session setup across domains. The run stores only the artifact ID and label. On click, Gauntlet asks the fixed launch endpoint to mint a short-lived, single-use URL, validates its origin against the configured public origin, and returns it without fetching it. The browser navigates to the target application, and that application creates its own cookie or session before redirecting to the requested page.

## Application Authoring Model

Each SDK exposes the same conceptual types:

```text
FeatureDefinition
OperationDefinition
OperationHandler<Input>
RunContext
OperationResult
DataSource
DataSourceQuery
DataSourcePage
DataSourceItem
FileReference
Artifact
Problem
```

SDK syntax is idiomatic per language, while emitted protocol JSON is identical.

Three authoring styles are supported:

1. typed operation using a DTO/record/schema, metadata, and handler;
2. fluent definition builder for advanced schemas and layouts;
3. custom framework endpoint explicitly bound as an operation.

Custom endpoints are internal bindings. Gauntlet still invokes the normalized adapter run endpoint, and the adapter normalizes inputs and outputs. Automatic exposure of all application routes is forbidden.

PHP uses attributes, typed DTOs, Symfony Validator metadata, and services. Java uses annotations, records, Bean Validation, Jackson, and Spring beans. TypeScript uses a JSON-Schema-native typed builder and framework handlers. Explicit JSON Schema overrides are permitted when they remain compatible with the typed input contract.

`RunContext` supplies progress, structured logs, warnings, cancellation checks, artifact creation, and correlation metadata. Operation handlers do not depend on HTTP request or response objects.

## Gauntlet Backend

The backend is a Node.js application written in TypeScript with Fastify. The first version has no graphical UI. It exposes a backend API and is testable using HTTP clients.

Its components are:

- `TargetRegistry`: merges configured discovery providers;
- `StaticTargetProvider`: reads target configuration for every platform;
- `KubernetesTargetProvider`: later optional provider based on service annotations;
- `AdapterClient`: validates and calls one target adapter;
- `ManifestService`: caches manifests and records compatibility state;
- `RunProxyService`: creates and observes adapter-owned runs;
- `GauntletStore`: persistence interface;
- in-memory store for tests and initial local execution;
- SQLite and PostgreSQL implementations added without changing API contracts.

The portable baseline is explicit target configuration containing stable target ID, label, internal URL, optional public URL, and tags. Docker socket access is not required. Kubernetes discovery is a provider rather than a core assumption.

Target states are `online`, `offline`, `incompatible`, and `degraded`. A broken target must not prevent healthy targets from being listed or invoked.

## Error Model

Transport, compatibility, validation, availability, and handler failures are distinct problem types. RFC 9457 fields identify the type, title, status, detail, and occurrence. Validation problems add a normalized `errors` collection containing instance JSON Pointer, schema path, keyword, safe message, and parameters.

SDKs must not serialize stack traces, secrets, SQL, credentials, or raw internal exception messages into default responses. They may attach a correlation ID and record richer diagnostics in application logs. Gauntlet preserves partial artifacts when a run ends in `partial` or `failed` after producing useful output.

## Safety Without Initial Authorization

Initial user authentication is deferred, but the first version still enforces structural safety:

- adapters are disabled by default and explicitly enabled per environment;
- only explicitly registered operations and data sources exist;
- arbitrary commands, services, routes, SQL, and URLs cannot be supplied by callers;
- input is validated again inside the adapter;
- operation impact and confirmation metadata are part of the contract;
- ingress should block direct public access to adapter routes;
- transport authentication and actor context have reserved extension points;
- operation and run IDs provide correlation for later audit support.

## Conformance and Testing

The repository provides language-neutral fixtures and black-box scenarios. Each SDK starts a sample adapter and must pass the same HTTP tests. Required scenarios include:

- manifest and operation-definition schema validation;
- stable revisions and ETags;
- feature hierarchy and unique identifiers;
- a successful synchronous operation;
- invalid input with field pointers;
- unknown operation and data source;
- handler failure normalization;
- stale operation revision rejection;
- idempotent create-run behavior;
- run polling and terminal states;
- data-source query, pagination, and resolve;
- capability negotiation and unsupported capability behavior;
- disabled adapter behavior;
- secret redaction;
- custom endpoint binding through the normalized route.

Package-level unit tests cover pure registries, schema generation, state transitions, and error mapping. Framework integration tests cover routing and DI. The Gauntlet backend uses fake adapter servers for deterministic integration tests.

Every SDK exposes a validation command suitable for CI. Invalid operations are reported as adapter diagnostics on a running environment instead of crashing the host application; CI validation fails.

## Reference Vertical Slice

The first complete slice is:

1. protocol meta-schemas, OpenAPI, and golden fixtures;
2. TypeScript core models and validation;
3. Fastify backend with static target registry and adapter proxy;
4. PHP Core and Symfony Bundle with handler, data-source, manifest, and run routes;
5. an example portal application integration exposing one agency-application workflow operation and one searchable application data source;
6. shared black-box conformance tests;
7. minimal Node/Next and Java/Spring package foundations that compile against the protocol and establish extension points.

The reference workflow uses the application's existing command/service boundary and preserves its transaction and domain behavior. It does not mutate Doctrine entities directly and does not expose arbitrary command classes.

## Acceptance Criteria

- A deployed Gauntlet backend can list a configured Symfony target and its features without framework-specific code.
- It can fetch and validate an operation definition containing multiple input parameters.
- It can query a dynamic application data source.
- It can create a run, poll it, and receive a normalized terminal result.
- The Symfony handler can call an existing application command or service through DI.
- A malformed adapter or operation is isolated and reported without taking down the control plane.
- The same protocol fixtures are consumable by TypeScript, PHP, and Java package foundations.
- No graphical dashboard code is required for the vertical slice.
