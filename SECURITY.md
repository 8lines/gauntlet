# Security policy

Gauntlet is an open-source tool, licensed under Apache-2.0, for explicitly approved non-production environments. Version line `0.1.x` receives security fixes while it is the current release line.

Public source code is not public deployment. Publishing the source and the packages does not make it safe to expose a Gauntlet dashboard or any application adapter to the internet.

## Reporting a vulnerability

Report suspected vulnerabilities privately through GitHub private vulnerability reporting: open [a new security advisory](https://github.com/8lines/gauntlet/security/advisories/new) on `8lines/gauntlet`. Include the affected version, a minimal reproduction, impact, and any known containment steps. Do not include real credentials, customer data, or production endpoints. The report stays visible only to you and the maintainers until an advisory is published.

Do not open a public issue, pull request, or discussion for a vulnerability. If private vulnerability reporting is unavailable, open a public issue that only asks the maintainers for a private contact, without any details of the vulnerability, and share only the minimum information needed to establish a secure hand-off.

## What counts as a security issue

Treat at least the following as security issues:

- an adapter or Gauntlet instance that can start against a production-like environment;
- a public adapter route, a public Gauntlet dashboard, or a network policy that exposes either boundary more broadly than reviewed;
- credentials, idempotency secrets, session artifacts, internal origins, or sensitive application output appearing in source, configuration, logs, reports, or UI;
- arbitrary SQL, shell execution, URL proxying, filesystem access, request-selected command classes, routes, or queue topics;
- a way to bypass operation registration, schema validation, confirmation, application authorization, environment matching, or immutable release checks;
- incorrect run ownership, idempotency, cancellation, or concurrency behavior in a replicated deployment;
- a release report that claims a scanner, conformance suite, or artifact verification passed when it did not run.

## Deployment boundary

Built-in authentication is optional and off by default: the `auth` configuration can require a shared password, per-user passwords and static API tokens for the dashboard, widget, REST API and MCP endpoint (see [authentication](docs/deployment/authentication.md)). Sessions are stateless, so logging out does not revoke a token already copied elsewhere before it expires; rotating `GAUNTLET_AUTH_SECRET` revokes every session. Authentication does not replace the private boundary. A private address is not authentication, so defense in depth is mandatory: Gauntlet and every adapter must be disabled independently in production, adapter routes must remain internal, and tester access must pass through a separately administered loopback, VPN, Tailscale, private ingress, firewall, authenticating reverse proxy in front of the Gauntlet dashboard (for example basic authentication or SSO), or equivalent trusted boundary. An authenticating proxy protects only the dashboard: adapter routes must still stay internal and unreachable from outside the private network.

The control plane supports exactly one replica and keeps projection history in memory. Applications with multiple replicas need a stable shared idempotency secret and truthful shared run-store, coordination, cancellation, and event ownership. Confirmation reduces accidental execution; it is not user authentication or domain authorization.

Never weaken these boundaries to reproduce a report. Use synthetic data and a disposable development, test, QA, staging, UAT, preview, or sandbox environment. If the physical environment is ambiguous or production-like, keep the adapter disabled.

## Release and dependency handling

Release automation must fail closed. Images, packages, actions, build frontends, scanners, and generated attestations use reviewed immutable versions or digests. A timeout, unavailable registry, missing scan database, malformed report, mixed remote publication state, or unverifiable artifact is a failure—not a skipped success.

Security fixes that alter Adapter v1 behavior require coordinated protocol fixtures, every affected SDK, black-box conformance, upgrade notes, and a changelog entry.
