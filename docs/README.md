# Gauntlet documentation

Gauntlet lets your team operate explicitly registered application actions
through a dashboard or AI client. Choose the guide for the job you are doing.

## Start here

| Your goal | Guide |
| --- | --- |
| Understand what Gauntlet does | [Project README](../README.md) |
| Try it with sample data | [Local demo](local-development.md#run-the-local-demo) |
| Install it and connect your first application | [Getting started](getting-started.md) |
| Run an operation or troubleshoot the dashboard | [User guide](user-guide.md) |
| Connect an AI client to application capabilities | [MCP setup and tools](mcp.md) |

## Application developers

Start with [application integration](integrations/index.md) to install an
adapter, then [author an operation or data source](extensions/authoring.md).
Your registered catalog is used by both the dashboard and MCP.

| Stack | SDK and transport | Example |
| --- | --- | --- |
| Node.js | [TypeScript Core](../packages/typescript/core/README.md), [Node adapter](../packages/typescript/node/README.md) | [Native Node fixture](../examples/node-adapter/README.md) |
| Next.js | [TypeScript Core](../packages/typescript/core/README.md), [Next.js bridge](../packages/typescript/next/README.md) | [Next.js fixture](../examples/next/README.md) |
| Symfony | [PHP Core](../packages/php/core/README.md), [Symfony bundle](../packages/php/symfony-bundle/README.md) | [Symfony fixture](../examples/symfony/README.md) |
| Spring Boot | [Java SDK](../packages/java/README.md), [Spring starter](../packages/java/spring-boot-starter/README.md) | [Spring fixture](../packages/java/spring-example/README.md) |

For another framework, start with the relevant Core runtime and the
[Adapter v1 protocol](../packages/protocol/README.md). Package installation is
covered in [installing packages](releases/installing-packages.md). Optional
[AI authoring skills](ai-skills.md) help implement integrations and extensions;
they are separate from runtime MCP access.

## Operators

| Task | Guide |
| --- | --- |
| Choose where to run Gauntlet | [Deployment decision guide](deployment/decision-guide.md) |
| Configure environments and application origins | [Configuration reference](../config/README.md) |
| Operate a standalone Docker installation | [Compose runbook](../deploy/compose/README.md) |
| Operate Kubernetes | [Helm runbook](../deploy/helm/README.md) and [private ingress examples](../deploy/helm/examples/README.md) |
| Migrate retired Kubernetes manifests | [Migration procedure](../deploy/kubernetes/README.md) |
| Review access and production restrictions | [Non-production boundary](safety/non-production-boundary.md) |
| Upgrade or recover a deployment | [Upgrade](releases/upgrading.md), [rollback](releases/rollback.md) |

## Architecture and technical reference

[Architecture](architecture.md) describes the current components, trust
boundaries, request flow and state ownership. Details live in focused references:

| Topic | Reference |
| --- | --- |
| REST endpoints, request/response behavior and errors | [Control-plane HTTP API](reference/control-plane-api.md) |
| Operation definitions, profiles and capabilities | [Protocol model](reference/protocol-model.md) |
| Idempotency, timeout, cancellation and scaling | [Run lifecycle](reference/run-lifecycle.md) |
| Source directories and responsibilities | [Repository guide](reference/repository.md) |
| Canonical Adapter v1 wire contract | [Protocol package](../packages/protocol/README.md), [OpenAPI](../packages/protocol/openapi/adapter-v1.yaml), [JSON Schemas](../packages/protocol/schemas/v1) |
| Server process and environment variables | [Server README](../apps/server/README.md) |
| Defensive server-to-adapter client | [Adapter client README](../packages/dashboard-client/README.md) |

## Contributors and maintainers

- [Local development](local-development.md): build, run and verify changes.
- [Contributing](../CONTRIBUTING.md): development and review requirements.
- [Dashboard README](../apps/dashboard/README.md): frontend commands.
- [Adapter conformance](../conformance/README.md): cross-stack HTTP checks.
- [Release runbook](releases/releasing.md): private artifacts and release gates.
- [Changelog](../CHANGELOG.md), [security policy](../SECURITY.md), [license](../LICENSE).

## Keeping documentation current

The root README is an introduction and starting point. Cross-project guides and
architecture live here; exact SDK APIs and deployment procedures stay beside
their packages and distributions. Prefer links to those sources over repeating
configuration and commands in several places.

[The documentation manifest](documentation-manifest.json) lists the maintained
pages checked by `pnpm docs:check`. Update it when adding a guide. Verify
commands against the current code and keep package versions aligned with
`VERSION`.

[`superpowers`](superpowers) contains historical design records and implementation
plans. [`mockups`](mockups/README.md) preserves an early visual reference. Neither
is the source of current installation instructions.
