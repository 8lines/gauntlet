# Extension safety gates

Apply these gates to the application and exact environment being changed. An
environment label is evidence about declared intent, not proof of physical
infrastructure identity.

## Entry boundary

Proceed only when the existing integration evidence establishes all of these:

- adapter enabled only for a recognized non-production environment;
- dashboard and adapter prefix private, with no public wildcard or alternate
  path reaching the adapter;
- exactly one normalized `/_gauntlet/v1` transport already mounted;
- stable secret and runtime/store/coordinator choices truthful for the actual
  process and replica count;
- target expectation equal to the adapter manifest environment.

If any item is absent, stale, or ambiguous, do not edit deployment or transport
as part of extension work. Leave the new extension unregistered and hand the
integration problem to `$gauntlet-app-integration`. Never add a production
override, temporary public route, second transport, or direct browser-to-adapter
call.

## Binding provenance

A handler needs a fixed application service, an authorization and tenant
source, and a complete outcome contract. Take each one only from the user's
request or from existing application code. Verifiers, graders, test oracles,
harness scripts, and scorecards check work; they never supply a binding, so do
not read them to find operation IDs, field names, or service methods. When a
binding is missing, choosing the safe option does not authorize an
implementation: keep every handler export unregistered or null, write no
executable handler, and report `refused-incomplete` with the decisions the
application owner must make.

## Request-selection boundary

The only safe dispatch shape is:

1. a stable registered feature/operation or data-source ID selects code;
2. a closed schema validates business inputs;
3. one fixed handler maps those inputs into application value objects;
4. the handler calls a known application service or fixed command/event binding.

Request data may not select or contain executable machinery: SQL or query
fragments, shell commands, arbitrary URLs, routes, controllers, methods,
classes, container service IDs, command names, queue topics, event types,
filesystem paths, template names resolved as paths, or reflection targets.
Prefix checks, namespace restrictions, hidden fields, named raw-query lists,
path normalization, and an internal-only network do not turn a generic executor
into a narrow application capability.

Fixed fixture IDs are safe only when each ID maps in application code to one
reviewed loader and cannot be transformed into a path. Fixed event operations
bind to a concrete event type and topic in code; payload fields remain typed
business values.

## Execution truth table

| Concern | Required declaration and evidence |
| --- | --- |
| Read | `impact=read`; no side effect on any path. |
| Reversible mutation | `impact=write`; confirmation when an accidental run is material; choose idempotency from actual retry behavior. |
| Permanent or broadly destructive mutation | `impact=destructive`, `confirmationRequired=true`, `idempotency=required`; denial, original-run replay, and same-key/different-input zero-second-mutation tests. |
| Dry-run | `dryRunSupported=true` only when the flag reaches a real non-mutating handler branch and dependency-level mutation/publisher sentinels stay at zero calls. Otherwise `false` or a separate read-only preview operation. |
| Cancellation | `cancellationSupported=true` only when dispatch is targetable while active and application work cooperatively observes cancellation. |
| Timeout | Bound work and test terminalization; a timeout does not undo a side effect already committed. |
| `queue` or `forbid` | Match the verified coordinator to every process/replica. Process-local coordination provides no cluster-wide guarantee. |

Confirmation acknowledgement is bound to operation ID, revision, and impact by
the runtime. It prevents an accidental click; it does not identify the caller,
grant tenant membership, or bypass application authorization.

Exercise those checks through registered create-run admission. Send the
idempotency key to runtime/store admission; never implement replay with
`requestId` or a handler-local helper. The same operation/key replays the
original Run after changed valid input or correlation ID and performs no second
domain mutation.

## Application authorization and tenancy

Treat invocation `actor`, `target`, locale, time zone, extensions, and all input
as untrusted claims. Resolve them through application-owned authorization and
tenant services before reading or mutating domain state. Use the authorized
scope as the sole tenant scope; never fall back to `target.id`. Validate entity
membership, allowed transition, synthetic-data status, and other invariants in
the same boundary used by normal application behavior. Denial must occur before
the fixed service or repository mutates.

Gauntlet v0.1 has no built-in authentication. A private network reduces
exposure but is not application-domain authorization. If the existing
integration cannot provide a trustworthy identity/context source, do not build
a capability whose safety depends on one; bind it to a fixed reviewed scope or
leave it incomplete.

## Secrets, files, and retained values

- Mark secret inputs with a `secret` handling rule and `retention=none`.
- Never put secret values in presets, defaults, locked fields, dependency maps,
  logs, Problems, summaries, output, artifacts, actions, or test snapshots.
- Mark files with a `file` rule, explicit media types, count, and byte bound.
  Resolve only adapter-issued file references through the installed upload SPI;
  never accept server paths.
- Do not serialize a deferred handler closure/task, invocation context, secret,
  or file payload to a general-purpose queue.
- Return owned bounded JSON, never ORM entities, framework responses, raw
  exceptions, credentials, filesystem contents, or internal service metadata.

Keep the extension disabled when any boundary cannot be demonstrated. Report
the missing evidence precisely; do not reinterpret an unresolved gate as a
warning.
