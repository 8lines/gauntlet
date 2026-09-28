# Protocol and operation definitions

The canonical contract is [`packages/protocol`](../../packages/protocol). Its
[OpenAPI document](../../packages/protocol/openapi/adapter-v1.yaml) describes the
transport, while [`schemas/v1`](../../packages/protocol/schemas/v1) and
[`fixtures/v1`](../../packages/protocol/fixtures/v1) define the closed document
shapes and language-neutral behavior.

An operation definition is deliberately large enough to drive a universal UI.
It can describe:

- identity, feature grouping, order, labels, descriptions, and tags;
- arbitrary multi-field Draft 2020-12 object input within the portable schema
  profile;
- declarative groups, columns, fields, widgets, conditional visibility, and
  data-source-backed controls;
- presets with initial values and locked JSON Pointers;
- secret and file input handling;
- required protocol profiles and optional capabilities;
- write/read impact, confirmation, dry-run support, idempotency,
  cancellation, timeout, and concurrency;
- an output schema and rich-result presentation;
- progress, logs, warnings, artifacts, and typed follow-up actions;
- page placements used by the embeddable widget.

Features and operation definitions are data; application behavior is code.
SDKs expose the fixed Adapter v1 endpoints for definitions and runs. A custom
operation does not add a custom HTTP route: it registers an application-owned
handler behind the normalized create-run route. Applications may implement the
typed upload, event, cancellation-fallback, and session-launch SPIs. Advertising
an additional capability ID as requirements metadata never creates a custom
executor or HTTP endpoint.

Read [the protocol README](../../packages/protocol/README.md) before changing schemas,
revision calculation, execution semantics, or semantic fixtures.

## Profiles and capabilities

Profiles describe document features, such as portable schemas, rich forms and
rich results. Capabilities describe optional endpoints, such as upload,
cancellation, run events and session launch. The manifest declares both;
operation requirements can restrict an operation to a supported combination.
An unavailable or incompatible operation is blocked before execution.

`gauntlet-page-placements@1` is the profile a manifest must advertise when any
operation summary carries `placements`, describing where the embeddable widget
may surface that operation on an application page. See
[Place an operation on application pages](../extensions/authoring.md#place-an-operation-on-application-pages).

Both dashboard forms and AI clients read the same operation definition. MCP
uses the input schema and execution policy but does not render the UI schema.
See [MCP tools](../mcp.md) for the AI invocation workflow.

## Where behavior lives

A core SDK owns catalog validation and the run lifecycle. A transport mounts
the normalized HTTP endpoints. The application supplies domain handlers and
optional endpoint implementations. Gauntlet stores validated projections;
it does not take ownership of application data.

[Architecture](../architecture.md) · [Author an operation](../extensions/authoring.md) · [Documentation index](../README.md)
