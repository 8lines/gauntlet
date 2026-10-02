# Repository guide

~~~text
.
├── apps/
│   ├── dashboard/                  Responsive schema-driven browser UI
│   └── server/                     Fastify control plane and static UI host
├── packages/
│   ├── protocol/                   Canonical Adapter v1 contract
│   ├── dashboard-client/           Validated server-to-adapter HTTP client
│   ├── typescript/
│   │   ├── core/                   Framework-neutral TypeScript runtime
│   │   ├── node/                   Native Node HTTP transport
│   │   └── next/                   Next.js App Router bridge
│   ├── php/
│   │   ├── core/                   Framework-neutral PHP runtime
│   │   └── symfony-bundle/         Symfony transport and DI integration
│   └── java/
│       ├── core/                   Framework-neutral Java runtime
│       ├── spring-boot-starter/    Spring Boot transport and auto-configuration
│       ├── spring-example/         Executable Spring reference application
│       └── starter-api-consumer-test/ Compile-time public API fixture
├── conformance/
│   ├── runner/                     Language-neutral HTTP conformance runner
│   ├── scenarios/                  Frozen P0 and extended scenarios
│   └── smoke/                      Control-plane smoke adapter and test
├── examples/
│   ├── typescript-fixture/         Test catalog and compile-checked example
│   ├── node-adapter/               Native Node reference host
│   ├── next/                       Next.js App Router reference host
│   └── symfony/                    Runnable Symfony reference adapter
├── deploy/
│   ├── compose/                    Standalone Docker Compose deployment
│   ├── helm/                       Supported OCI Helm chart and runbook
│   └── kubernetes/                 Legacy manifest migration pointer
├── docs/
│   ├── getting-started.md          Installation and first use
│   ├── user-guide.md               Everyday dashboard workflow
│   ├── local-development.md        Local demo and contributor commands
│   ├── architecture.md             System boundaries and data flow
│   ├── reference/                  API, protocol, runs, and repository guides
│   ├── deployment, safety, releases/ Operator and maintainer runbooks
│   ├── integrations, extensions/    Application developer guides
│   └── superpowers/                 Historical design and implementation records
├── scripts/                        Verification, release, docs, and skill tooling
├── skills/                         Evaluated AI integration/extension workflows
├── Dockerfile                      Production control-plane and smoke images
└── compose.smoke.yaml              Isolated Docker Compose smoke topology
~~~

## Directory responsibilities

| Path | What belongs there |
| --- | --- |
| [`apps/dashboard`](../../apps/dashboard) | The responsive browser UI. It renders target catalogs, rich forms, execution policy, run progress, results, artifacts, and follow-up actions using only `/api/v1`. |
| [`apps/server`](../../apps/server) | The Fastify process, REST API, and optional MCP endpoint. It validates static targets, performs adapter discovery, proxies normalized operations and capabilities, sanitizes Problems, stores validated in-memory projections, and can serve the built dashboard. It contains no application framework adapter. |
| [`packages/protocol`](../../packages/protocol) | The normative Adapter v1 OpenAPI file, closed JSON Schemas, TypeScript wire types, semantic validation, canonical revision rules, portable regular-expression profile, and shared cross-language fixtures. Change this package first when the wire contract changes. |
| [`packages/dashboard-client`](../../packages/dashboard-client) | A defensive HTTP client used by the control plane to communicate with adapters. It owns bounded fetches, response validation, ETag checks, SSE parsing, and safe protocol Problems. |
| [`packages/typescript`](../../packages/typescript) | The TypeScript catalog/runtime plus Node and Next transport integrations. Application-specific operations stay in the consuming application. |
| [`packages/php`](../../packages/php) | The PHP 8.3+ catalog/runtime and Symfony 7.4/8.x bundle. `packages/php/Dockerfile` supplies the reproducible compatibility-test image. |
| [`packages/java`](../../packages/java) | The Gradle multi-project containing Java Core, the Spring Boot starter, an executable example, and a compile-time consumer fixture that protects the public starter API. |
| [`conformance`](../../conformance) | Framework-neutral black-box verification. It talks only over Adapter v1 HTTP and never imports an SDK. |
| [`examples`](../../examples) | Executable or compile-checked examples showing how an application owns a catalog and mounts one transport. They are fixtures, not generic production backends. |
| [`deploy/compose`](../../deploy/compose) | The supported standalone deployment for a private development or staging Docker network. |
| [`deploy/helm`](../../deploy/helm) | The supported OCI Helm chart, deterministic packager, private-ingress examples, offline Kubernetes validation, and complete per-environment operator runbook. |
| [`deploy/kubernetes`](../../deploy/kubernetes) | The bounded migration pointer for retiring installations made from the former static manifests. |
| [`docs`](../../docs/README.md) | Architecture, deployment choice, safety, integration, extension, private-registry, release, upgrade, rollback, and AI-skill documentation. Historical records remain under `docs/superpowers`. |
| [`scripts`](../../scripts) | Repository-level verification, clean external consumers, deterministic staging, security gates, release rehearsal, documentation checks, and skill validation/installation. |

## Important root files

| File | Purpose |
| --- | --- |
| [`Dockerfile`](../../Dockerfile) | Builds the production Fastify image and the minimal fake-adapter image used by smoke tests. |
| [`compose.smoke.yaml`](../../compose.smoke.yaml) | Connects Gauntlet to two fake adapters on a private network and exposes only Gauntlet on loopback. |
| [`package.json`](../../package.json) | Workspace-wide build, typecheck, test, package, smoke, and conformance commands. |
| [`pnpm-workspace.yaml`](../../pnpm-workspace.yaml) | Declares the TypeScript packages, applications, conformance runner, and examples in the pnpm workspace. |
| [`tsconfig.base.json`](../../tsconfig.base.json) | Shared strict TypeScript compiler configuration. |

## Dashboard source map

| Path | Responsibility |
| --- | --- |
| `apps/dashboard/src/components/ui/` | shadcn/ui primitives generated by the shadcn CLI (Radix, `new-york` style). |
| `apps/dashboard/src/components/gauntlet/` | Gauntlet composites: run view, artifacts, recent runs list, error boundary and loading states. |
| `apps/dashboard/src/components/gauntlet/operation-form/` | Schema-driven form renderer. |
| `apps/dashboard/src/app/` | Application shell: sidebar, header, environment switcher, command search, settings and MCP connection. |
| `apps/dashboard/src/screens/` | Environment overview, catalog table and the operation screen with its invocation lifecycle. |
| `apps/dashboard/src/widget/` | Embeddable widget panel. |
| `apps/dashboard/src/api.ts` | Typed control-plane client. |
| `apps/dashboard/src/route.ts` | Route parsing for `/t/:targetId/o/:operationId/r/:runId`. |
| `apps/dashboard/src/recent-runs.ts` | Recent runs stored in the browser, shared with the widget. |
| `apps/dashboard/src/copy.ts` | User-facing execution-policy and Problem text. |
| `apps/dashboard/src/json-pointer.ts` | JSON pointers and visibility conditions. |
| `apps/dashboard/e2e/` | Playwright suites, including the axe accessibility gate. |

[Documentation index](../README.md) · [Local development](../local-development.md) · [Architecture](../architecture.md)
