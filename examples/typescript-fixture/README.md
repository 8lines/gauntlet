# TypeScript catalog examples

This package supplies application-owned definitions used by the reference
transports and tests. It does not start an HTTP server.

- [`src/index.ts`](src/index.ts) exports `createConformanceCatalog()`, a
  deterministic in-memory catalog used by the Node and Next.js fixtures.
- [`src/catalog-example.ts`](src/catalog-example.ts) shows a richer application
  catalog with form layout, presets, data-source bindings and explicit service
  dependencies. It is compile-checked; the consuming application supplies the
  implementations.

Use the [local demo](../../docs/local-development.md#run-the-local-demo) to try
the conformance catalog. Use [authoring an operation](../../docs/extensions/authoring.md)
and [TypeScript Core](../../packages/typescript/core/README.md) to build your own.

The fixture environment is `typescript-fixture-test` with kind `test`.
Its code and sample idempotency secret are for process-local tests. A real
replicated adapter needs stable secret provisioning, shared storage and shared
execution coordination.

## Verify

```sh
pnpm --filter @8lines/gauntlet-typescript-fixture... build
pnpm --filter @8lines/gauntlet-typescript-fixture test
```

[Native Node fixture](../node-adapter/README.md) · [Next.js fixture](../next/README.md) · [Documentation index](../../docs/README.md)
