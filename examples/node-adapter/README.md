# Native Node reference adapter

This is a runnable HTTP fixture for the Node transport, backed by the
[TypeScript conformance catalog](../typescript-fixture/README.md). It exposes
registered Adapter v1 operations on an operating-system-assigned loopback port.
It is test infrastructure, not an application deployment template.

## Try it

The [local demo](../../docs/local-development.md#run-the-local-demo) starts this
adapter together with the dashboard, control plane and MCP endpoint.
`src/server.ts` exports `startServer()`; running the compiled module alone does
not start a listener. The returned handle provides its URL and a `close()` method.

## Verify

From the repository root:

```sh
pnpm --filter @8lines/gauntlet-node-example... build
pnpm --filter @8lines/gauntlet-node-example test
```

The tests cover live conformance, enabled/disabled behavior and exceptional raw
HTTP paths. The application-owned boundary helpers in
[`src/client-error.ts`](src/client-error.ts) are used by the
[Node integration guide](../../packages/typescript/node/README.md).

[Application integration](../../docs/integrations/index.md) · [Documentation index](../../docs/README.md)
