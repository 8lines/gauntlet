# Non-production safety boundary

Gauntlet deliberately makes application state easier to manipulate. It is
therefore supported only in development, test, QA, staging, UAT, preview, and
sandbox environments. Production enablement is not a configuration option.

## Defense in depth

The boundary has independent layers:

1. The adapter package defaults to disabled and refuses a production-like
   environment before application handlers are reachable.
2. The adapter manifest declares a structured environment name and kind.
3. The control-plane configuration declares its own environment and an exact
   `expectedEnvironment` for every target.
4. Discovery and execution stop when either name or kind differs.
5. Adapter routes remain on an internal application listener or are explicitly
   denied by every public ingress.
6. The dashboard, REST API and optional MCP endpoint are exposed only through
   an independently reviewed private boundary or an authenticating reverse
   proxy (for example basic authentication or SSO) in front of Gauntlet.
7. Every operation is an allow-listed handler with typed input and truthful
   impact, confirmation, dry-run, idempotency, timeout, cancellation, and
   concurrency declarations.

No single layer proves infrastructure identity. A process can be given false
metadata, DNS can point at the wrong service, and a private network can contain
an unintended peer. Release and deployment review must verify the actual host,
cluster, namespace, account, ingress, and service selectors.

## Authentication status

Gauntlet v0.1 authentication is deferred. Confirmation is accidental-click
protection; it is not authentication, authorization, approval, or audit. A VPN,
Tailscale ACL, TLS connection, private IP, or Kubernetes NetworkPolicy narrows
reachability but does not replace caller identity or application authorization.

Until authentication is implemented, give dashboard and MCP access only to
trusted users and clients within an administered private boundary, or put an
authenticating reverse proxy in front of Gauntlet. Such a proxy protects only
the Gauntlet dashboard, API, and MCP endpoint; adapter routes must still stay
internal and denied by every public ingress. Gauntlet being open source does
not make a public deployment safe. MCP Origin
validation narrows accepted browser-origin requests but does not identify or
authorize a user. Keep sensitive authorization
and domain checks in the target application. Never send reusable credentials,
session cookies, API tokens, or secret input values to logs, manifests,
operation revisions, idempotency storage, results, or URLs.

## Operation rules

Safe operations expose a narrow tester outcome such as “move this known
application to review” or “create a test session for this selected user.” They
do not expose generic powers. Reject designs that accept:

- SQL, expressions, shell fragments, arbitrary class or method names;
- arbitrary route, host, webhook, queue, event, or command identifiers;
- unrestricted table, field, filesystem, object-storage, or cache keys;
- caller-selected code, template, serializer, or deserializer types.

Bind finite choices in application code. Validate both the JSON shape and
domain invariants. Treat every dynamic data source as a bounded read API with
pagination and explicit query/resolve behavior.

Set `dryRunSupported: true` only when application code observes the dry-run
flag and a mutation-sentinel test proves that the path does not call the
mutating dependency. Otherwise declare it false or create a separate read-only
preview operation. Required confirmation is still required for a dry run.

## Secrets, sessions, and roles

Use secret references, not secret values, in deployment configuration. SDK
idempotency secrets must be stable for every process that shares run state.
When an operation creates a test session or assumes a role:

- select only an explicitly eligible non-production identity;
- keep permission checks in the target application;
- make the session short-lived and bind launch URLs to the configured public
  target origin;
- return a typed browser-session artifact instead of a cookie or bearer token;
- never include credentials in query strings, logs, or Gauntlet config.

## Evidence before enablement

An integration is complete only after evidence shows:

- disabled behavior and production-like startup denial;
- exact environment mismatch denial;
- live Adapter v1 conformance against the deployed private route;
- denial of the adapter prefix on every public route, including encoded and
  duplicate-slash variants where the framework/ingress can normalize paths;
- the dashboard is private and the adapter is not browser-reachable;
- stable shared runtime components, or a truthful single-process constraint.

If evidence is unavailable, leave the adapter disabled and report the
integration as incomplete. Time pressure, an imminent demo, or sunk effort is
not a safety exception.
