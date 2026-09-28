# Authoring operations and extensions

An extension is application-owned code registered through an SDK catalog. It
does not add an arbitrary proxy route or teach Gauntlet how the application
works. The operation definition describes its form, execution policy and result
presentation for the dashboard, and its typed invocation contract for MCP
clients. Keep descriptions useful for both human and AI callers.

## Start from one outcome

Name a narrow tester-visible outcome, for example
`applications.change-decision-date`, `payments.replay-known-event`, or
`users.create-test-session`. Identify the specific application service that is
already allowed to produce that outcome. If the proposal is “execute any
command,” “edit any database field,” or “publish any event,” split it into
finite, reviewed operations first.

Register a stable feature for dashboard grouping, then define the operation:

- stable ID, label, description, order, and tags;
- closed Draft 2020-12 object input schema;
- declarative rich-form layout, field widgets, conditional visibility, and
  presets where useful;
- bounded data-source query/resolve bindings for dynamic choices;
- secret/file input handling;
- exact impact, confirmation, dry-run, idempotency, cancellation, timeout, and
  concurrency policy;
- closed output schema and rich-result presentation;
- optional progress, warnings, logs, artifacts, and follow-up actions.

Use the compile-checked examples for each stack: the
[TypeScript catalog](../../examples/typescript-fixture/src/catalog-example.ts),
[Symfony operations](../../examples/symfony/src/Gauntlet), and
[Java/Spring guide](../../packages/java/README.md#register-application-features).

## Place an operation on application pages

An operation may declare `placements` so the [embeddable widget](../integrations/widget.md)
knows where to surface it inside an application page. Each placement is one of
two kinds:

- `{ "kind": "global" }` — the operation is offered everywhere the widget is
  mounted, with no page context. At most one `global` placement is allowed per
  operation.
- `{ "kind": "subject", "subjectType": "<portableId>", "bindings"?: { "<pointer>": "<key>" } }`
  — the operation is offered on pages about a subject of that type, such as an
  order or a customer. Each `subjectType` may appear at most once per
  operation. `bindings` map input JSON Pointers to portable keys the host page
  supplies (for example the current order ID), letting the widget prefill the
  operation's input from page context.

`placements`, when present, must have at least one entry. A binding pointer
must resolve through `properties` only, down to a schema whose `enum` is a
non-empty list of scalars, whose `const` is a scalar, or whose `type` is
exactly one of `string`, `number`, `integer`, or `boolean`; it may not pass
through a node owning `$ref`, `allOf`, `anyOf`, `oneOf`, `not`, `if`, `then`,
or `else`. A binding's schema pointer also must not equal, or be nested under,
any of the operation's secret or file `inputHandling` rule pointers. Any
manifest with at least one placed operation summary must advertise the
`gauntlet-page-placements@1` profile — SDKs add it to the manifest
automatically once any registered operation has placements.

```ts
// TypeScript
import { subjectPlacement } from "@8lines/gauntlet-typescript-core";

placements: [subjectPlacement("order", { "/orderId": "orderId" })];
```

```php
// PHP/Symfony
use EightLines\Gauntlet\Core\Definition\OperationPlacement;

placements: [OperationPlacement::subject('order', ['/orderId' => 'orderId'])];
```

```java
// Java/Spring
@GauntletOperation(
    id = "orders.refund",
    featureId = "orders",
    label = "Refund order",
    input = RefundInput.class,
    subjectPlacements = @SubjectPlacement(
        subjectType = "order",
        bindings = @PlacementBinding(pointer = "/orderId", key = "orderId")))
```

## Handler boundary

Bind the operation ID directly to one handler in application code. Map validated
input into application value objects or commands, repeat domain validation, and
call a known service. Never use request data to resolve a container service,
class, method, route, SQL fragment, table, queue, event type, filesystem path,
or URL.

The handler reports through its run context. Do not return framework objects,
ORM entities, exception text, credentials, or unbounded payloads. Use typed
artifacts for downloads and browser-session launch; the adapter capability SPI
owns delivery and origin validation.

## Truthful execution declarations

- `impact` describes the highest possible effect, not the common path.
- `confirmationRequired` protects against accidental execution but does not
  authorize a caller.
- `dryRunSupported` is true only with handler-level observation and a mutation
  sentinel that remains zero.
- idempotency is `required` when a retry could duplicate a side effect; every
  replica sharing state must use the same stable secret.
- cancellation is supported only when the application path cooperates and
  terminal state cannot be overwritten by late output.
- timeouts do not undo a completed side effect; document domain recovery.
- multi-replica FIFO/forbid semantics require shared coordination, not only a
  shared run table.

See [run lifecycle](../reference/run-lifecycle.md) for the shared admission
and persistence semantics.

## Required tests

Add negative schema and domain cases, stale revision rejection, confirmation
binding checks, idempotent replay, secret-leak assertions, and output-schema
validation. Where declared, add timeout/cancellation/concurrency tests. A
mutating operation that advertises dry-run needs a dependency-level mutation
sentinel. Then run the SDK suite and the language-neutral live conformance
scenario through the actual framework transport.

Review the generated definition in the mobile and desktop dashboard. UI
rendering is necessary evidence for complex schemas, but it never replaces the
runtime tests.

## Completion checklist

An extension is complete only when its implementation, definition, tests,
transport exposure, and deployed enablement all agree. Report unresolved
authorization, distributed-state, network, or rollback risks. Keep it disabled
if the target environment or public-route boundary has not already passed the
integration checks in the [safety guide](../safety/non-production-boundary.md).

The `$gauntlet-extension-authoring` Codex skill provides the same checklist
as an implementation workflow once installed; see [AI skills](../ai-skills.md).
