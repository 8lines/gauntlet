# Operation and UI contract

An operation is a versioned contract that lets a generic dashboard render and
invoke one application-owned outcome. Design the definition before binding the
handler, and derive its revision through the SDK rather than hard-coding it.

## Identity and grouping

- Register a stable feature ID and human label. Use parent features only for
  real hierarchy; use order for presentation, not identity.
- Give each operation a stable ID such as
  `notifications.resend-welcome-email`, label, concise outcome description,
  order, and useful tags. IDs survive wording and UI changes.
- Declare only protocol profiles and optional capabilities that the existing
  adapter actually implements. Missing requirements make the operation
  unavailable rather than partially functional.

## Input and context

Use Draft 2020-12 with an object root, explicit `required`, declared
`properties`, and `additionalProperties: false`. Bound every variable-size
value with an enum, format, length, numeric range, item count, media type, or
application rule. Stay within the portable `tc-schema-core@1` profile; use only
local, statically attributable schema references. Do not use remote references
or a generic JSON object to smuggle dispatch choices.

If the handler requires invocation context, publish a closed `contextSchema`
for the exact actor/target members it consumes. Schema validation establishes
shape only. The handler must still resolve the actor, tenant, target, entity,
and transition through application authorization and domain services.

For secret or file fields, add input-handling rules pointing to their schema
locations. Secret retention is always `none`. File rules state whether multiple
files are accepted plus media-type and size bounds. A schema widget alone does
not enforce retention or file validation.

## Declarative form metadata

UI metadata describes presentation; it never weakens the schemas or handler:

- `group`, `columns`, and `tabs` compose layout;
- `field` nodes bind to JSON Pointers and may choose text, textarea, integer,
  number, toggle, select, multi-select, autocomplete, date, date-time,
  duration, code, JSON, secret, file, or a negotiated custom widget;
- `visibleWhen` and `enabledWhen` express `present`, `equals`, `in`, `all`,
  `any`, and `not` conditions over declared inputs;
- autocomplete fields refer to registered bounded data sources; dependencies
  and context pointers are declared explicitly;
- presets contain only ordinary business input. They never retain secrets,
  upload references, authorization decisions, implementation selectors, or
  environment-specific credentials. Locked pointers improve ergonomics, not
  security.

Every UI pointer must resolve into the input schema, and every UI data-source
ID must appear in the operation's data-source references. Complex forms should
be rendered on mobile and desktop after runtime tests pass.

## Execution policy

Set `impact` to the highest possible effect. Choose confirmation independently
from authorization. Choose idempotency from retry consequences; destructive
operations require it. Set dry-run, cancellation, timeout, and concurrency only
to behavior the application path and verified runtime can deliver. Prefer a
separate read-only preview when mutation-free simulation is not natural.

For `idempotency=required`, pass the caller's `idempotencyKey` into registered
create-run admission and durable store lookup. `requestId` is correlation only
and must never substitute for it. The current runtime keys replay by operation
ID plus idempotency key: the same key returns the original Run even when valid
input or request ID changed, and must cause zero second handler/domain mutation.

One operation ID binds to one code path. Convert owned validated JSON into
application value objects, resolve authorization/tenant scope, repeat domain
invariants, then call one fixed service, command, or event publisher. Request
values may shape that service's business arguments but cannot select which
implementation is called.

## Results and optional capabilities

Publish a closed output schema for the smallest tester-useful result. Return
only owned JSON scalars, arrays, and objects that satisfy it. A summary may add
bounded title/message/tone. Progress, warnings, structured logs, artifacts, and
follow-up actions are part of the declared result experience and must remain
bounded and secret-free.

Download and browser-session artifacts require already-installed upload or
session-launch SPIs and exact origin/single-use/expiry checks. Open-link actions
use application-owned destinations; they are not request-selected URL proxies.
SSE and cancellation require their real runtime capabilities. Extension work
may implement an existing SPI binding but never mounts a route or changes
network exposure.

For a test-session operation, accept a finite persona/role enum or one scoped
application user ID, revalidate allowed tenant and role transitions, and bind to
the application's fixed session service. Put only a browser-launch artifact in
the result. Cookies, bearer tokens, session IDs, reset links, and impersonation
secrets never enter output, logs, Problems, presets, or generic open-link
actions; the session-launch SPI owns short-lived, single-use delivery.

## Definition review

Before registration, confirm identity uniqueness, canonical revision, closed
schemas, semantic validation, accurate requirement availability, safe presets,
resolvable UI pointers, fixed binding, truthful policies, bounded outputs, and
no secret-bearing or executable request field. Invalid definitions stay out of
the catalog.
