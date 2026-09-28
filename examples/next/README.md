# Next.js reference adapter

This fixture mounts the Gauntlet bridge in the Next.js App Router using the
shared TypeScript conformance catalog. It demonstrates application transport
wiring; it is not the Gauntlet dashboard.

The [Next.js integration guide](../../packages/typescript/next/README.md)
explains the literal `_gauntlet` mount, Node runtime settings and required
trusted ingress. Raw request-target handling belongs at that ingress because
Next.js has already normalized requests by the time a route handler sees them.

## Verify

From the repository root:

```sh
pnpm --filter @8lines/gauntlet-next-example... build
pnpm --filter @8lines/gauntlet-next-example test
```

The tests start real Next.js fixture processes and exercise base/extended
conformance through the trusted ingress. They also check hostile raw targets,
streaming and disconnect behavior. An independently disabled instance is part
of the conformance boundary.

For a simple dashboard demo, use the [Node-based local stack](../../docs/local-development.md#run-the-local-demo).
To integrate your own Next.js application, follow
[application integration](../../docs/integrations/index.md).

[TypeScript catalog](../typescript-fixture/README.md) · [Documentation index](../../docs/README.md)
