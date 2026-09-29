# Changelog

All notable changes to this project are recorded here. Released artifacts are immutable; corrections receive a new semantic version.

## Unreleased

## [0.1.1] - 2026-09-29

### Added

- Dashboard settings now include an MCP connection section with an editable server URL and a copyable Streamable HTTP client configuration.
- The dashboard footer displays the application version.

### Changed

- Refined dashboard typography, spacing, surfaces, and controls, with subtle motion that respects reduced-motion preferences.

### Fixed

- Release verification follows GitHub Packages redirects when checking published Maven artifacts.

## [0.1.0] - 2026-09-28

### Added

- A responsive dashboard and Fastify control plane shipped together in one production image.
- Adapter v1 with definition-driven forms, presets, data sources, confirmation, dry-run policy, synchronous and asynchronous runs, progress, results, artifacts, follow-up actions, cancellation, uploads, SSE, and browser-session launch.
- Framework-neutral and transport packages for Node.js, Next.js, PHP, Symfony, Java, and Spring Boot.
- Shared base and extended HTTP conformance suites for every official adapter.
- Supported standalone Docker Compose and Helm deployment distributions for one explicitly configured environment and multiple application targets.
- Deterministic release staging for npm, Composer, Maven, Compose, Helm, OCI images, checksums, attestations, SBOMs, and installable AI skills.
- Operation placements: operations may declare a `global` or `subject`-scoped `placements` entry so the embeddable widget knows where to surface them on an application page, with optional JSON-Pointer bindings to prefill input from page context. A manifest with any placed operation advertises the `gauntlet-page-placements@1` profile.
- The `gauntlet_list_targets` MCP tool accepts an optional `subjectType` filter that limits returned operation summaries to those placed on that page subject.
- Embeddable widget server support: optional `widget.enabled` switch and per-target `widget.origins` in the v1 configuration, and `/widget/loader.js`, `/widget/`, `/widget/config.json` and `/widget/assets/*` served from `GAUNTLET_WIDGET_DIR` when enabled. Enabling the widget requires a Gauntlet image that ships the widget build at `GAUNTLET_WIDGET_DIR`, otherwise startup fails.
- `@8lines/gauntlet-widget` npm package with typed widget commands.
- Embeddable widget panel: a dashboard entry built into `dist-widget` and served from `GAUNTLET_WIDGET_DIR`, shown for a page's contextual and global placed operations, with search across the target's operations (label, description and tags), prefill from page context, recent runs, and closing through its own close button or Escape. The product image ships the built panel and loader alongside the dashboard.
- A local widget demo (`apps/dashboard/scripts/local-stack.mjs`) that starts a sample adapter, a widget-enabled control plane, and a host page for interactive testing across two origins.
- Gauntlet is open source under the Apache License 2.0. Every package, chart, Compose archive, and JAR ships the license text, and the repository carries a `NOTICE` file.
- Public distribution: the npm packages are published to `registry.npmjs.org`, the PHP packages to Packagist from the public `8lines/gauntlet-php-core` and `8lines/gauntlet-symfony-bundle` split repositories, and the image and Helm chart to public `ghcr.io/8lines`. The Java packages are published to GitHub Packages Maven, which requires a GitHub token to read.

### Security

- Adapters are disabled by default and reject production-like environment aliases without an override switch.
- Gauntlet compares structured instance and target environment identity before proxying an operation.
- Dynamic behavior is limited to explicitly registered typed operations and data sources; there is no generic SQL, shell, URL, route, topic, or class dispatcher.
- Release and consumer gates use pinned toolchains, isolated inputs, negative-path tests, private network topologies, and fail-closed artifact validation.
- Dashboard HTML responses send `Content-Security-Policy: frame-ancestors 'none'`; the widget panel may only be framed by configured target origins.
- Composer split repositories are published with per-repository SSH deploy keys against pinned GitHub host keys, and every published artifact is verified anonymously from its public registry.

### Known limitations

- Authentication is deferred in v0.1; both browser and adapter endpoints require a separately managed private network boundary.
- The control plane supports one replica and keeps dashboard run projections in process memory, so restarts lose local history.
- Durable application work, rollback data, authorization, audit trails, and shared execution state remain application responsibilities.
- Gauntlet supports non-production use only; there is no production environment kind or bypass.

[0.1.1]: https://github.com/8lines/gauntlet/releases/tag/v0.1.1
[0.1.0]: https://github.com/8lines/gauntlet/releases/tag/v0.1.0
