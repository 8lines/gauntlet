# Contributing

Gauntlet is open source under the [Apache License 2.0](LICENSE) and is
maintained by 8lines. Contributions are welcome as GitHub issues and pull
requests on [8lines/gauntlet](https://github.com/8lines/gauntlet). The
Composer split repositories `8lines/gauntlet-php-core` and
`8lines/gauntlet-symfony-bundle` are read-only release mirrors; send changes to
the monorepo instead.

Report suspected vulnerabilities privately as described in the
[security policy](SECURITY.md), never in a public issue, pull request, or
discussion.

## Licensing of contributions

Gauntlet uses inbound=outbound licensing. Unless you explicitly state
otherwise, any contribution you intentionally submit for inclusion in Gauntlet
is licensed under the Apache License 2.0, as described in section 5 of the
license, without any additional terms or conditions. Submit only work you have
the right to license this way. Do not include code, data, names, hostnames, or
credentials that belong to an employer, customer, or other third party; use
synthetic examples such as `acme` and `*.example.test` instead.

Start with [local development](docs/local-development.md) for build, demo and
focused verification commands. The [repository guide](docs/reference/repository.md)
explains where changes belong.

## Development contract

Use RED–GREEN–REFACTOR for behavior changes: first add the smallest failing test, observe the intended failure, implement the change, then refactor while the test remains green. Diagnose an unexpected failure before changing behavior, and preserve unrelated work already present in the checkout.

Protocol changes are protocol-first. Update the OpenAPI document, closed JSON schemas, language-neutral fixtures, semantic vectors, affected SDKs, and black-box conformance together. A wire behavior is not complete when only one language adapter accepts it.

The supported runtime boundary is:

- Node.js 24–26 for the control plane and TypeScript packages;
- PHP 8.3 or newer with Symfony 7.4, or PHP 8.4 or newer with Symfony 8.x, for the PHP integration;
- Java 21 for Core and the Spring Boot starter.

Do not silently widen or reduce this matrix. Dependency changes must update lockfiles, staged package contracts, external consumer tests, vulnerability checks, and documentation together.

## Safety rules

Application-specific operations belong in consuming applications. Register one finite ID and bind it to one reviewed application service. Never add a generic arbitrary SQL executor, shell runner, URL proxy, request-selected class/route/topic/filesystem path, runtime reflection dispatcher, or automatic database/controller discovery.

Gauntlet must remain disabled in production. Do not add an allow-production flag, environment relabeling, public adapter example, wildcard dashboard bind, floating image/package version, embedded credential, or route that lets a browser call an adapter directly. Confirmation is an accident-prevention control, not authentication or application authorization. A claimed dry-run must reach handler code and have a mutation-sentinel test.

For replicated adapters, use stable secret references and shared components for every advertised run guarantee. Do not hide process-local state behind a multi-replica deployment.

## Verification

Run the narrow test during development, then before requesting review run:

```sh
pnpm install --frozen-lockfile
pnpm release:verify
```

Changes touching a public package also run its clean packed or repository-backed consumer. Adapter changes run the shared base and extended conformance suites. Dashboard changes run both mobile and desktop browser projects. Deployment changes render and verify Compose and Helm distributions. Release changes exercise a clean, non-publishing dry-run.

Never convert a missing tool, registry timeout, skipped scanner, or unavailable environment into a passing result. Record the unresolved check and keep the completion verdict false.

## Change files

A pull request that changes what a release unit publishes adds a change file,
`.changes/<name>.md`, with a lowercase, hyphenated name:

```md
---
type: fixed            # added | changed | fixed | removed | security
units:
  gauntlet: patch      # patch | minor | major | none
---
The dashboard keeps the sidebar width after a reload.
```

The body is one changelog sentence for users, in sentence case, without em
dashes. Name every unit whose released paths the change touches, with the
semantic version bump it needs; the units are listed in the
[release runbook](docs/releases/releasing.md#release-units). Before 1.0 a
breaking change is `minor`. Several change files for one unit resolve to the
highest bump, and units that depend on a released unit are released with a
patch automatically.

Use `none`, with the reason as the body, when a change touches a unit's
released paths but needs no release, for example a refactor with identical
behaviour. The required `changes` CI check, also available as
`pnpm release:changes --check`, fails a pull request that touches a unit's
released paths without a change file naming that unit. Tests, READMEs and
changelogs never need one. Release preparation turns change files into
changelog entries, so do not edit `CHANGELOG.md` files by hand.

## Review and history

Keep commits focused and include test evidence. Describe user-visible behavior, security boundaries, public APIs, package requirements, or deployment changes in a [change file](#change-files). Add migration and rollback notes before merging a breaking or operational change. Do not rewrite, delete, or overwrite an existing release artifact; publish a new version.
