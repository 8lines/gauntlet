# Native Node.js

Support Node.js 24–26. Install matching exact releases from the public npm registry; no scope mapping or registry token is needed:

```sh
pnpm add @8lines/gauntlet-protocol@0.1.0 \
  @8lines/gauntlet-typescript-core@0.1.0 \
  @8lines/gauntlet-typescript-node@0.1.0
```

Build one application-owned catalog from explicit Core registries, a schema validator, a `RunManager`, a stable secret decoded to at least 32 high-entropy bytes, and a `RunStore`/execution coordinator appropriate to the runtime topology. Do not expose arbitrary routes, classes, commands, events, SQL, or URLs.

Map the deployment's organization-specific production aliases and infrastructure identities before enabling; passing the built-in `prod`/`production`/`live` check is only a minimum and an ambiguous identity blocks enablement.

Operation closures execute in the current Node process. A shared store/coordinator can provide distributed admission, cancellation visibility, and persistent run metadata, but cannot replay or resume a closure after that process exits. Use a verified singleton execution process with no durability claim, or explicit leases/heartbeats that terminalize orphaned/stale runs and define safe recovery as a new application execution. Never claim durable execution replay.

Create one `createAdapterFetchHandler` and invoke it once at the raw HTTP server boundary for every ordinary request, before Express, Fastify, or another path-aware router can normalize or select a route. Enable only when `GAUNTLET_ENABLED` is exactly `true`. Capture `IncomingMessage.url` before constructing a `URL` or Web `Request`, pass the unchanged value as `rawTarget`, and let only the handler's documented non-adapter canonical-origin-form 404 fall through to the application router. Never prefilter on decoded `pathname`.

Own every native Node path that can bypass that callback. Before constructing a Web `Request`, classify Fetch-forbidden methods such as `TRACE` and `TRACK`. Install bounded `clientError`, `connect`, `upgrade`, and non-100 `checkExpectation` listeners. For each, classify the unchanged or bounded extracted request target with the package-exported `isAdapterTarget`, never a prefix regex. An adapter-equivalent request must receive the canonical disabled 503 while disabled and an owned fixed 4xx while enabled; unrelated traffic gets only a generic host response. Use the complete compile-checked helper in `examples/node-adapter/src/client-error.ts` from the matching release.

Keep the application port unpublished or behind a private service. Explicitly deny the adapter prefix on every public ingress. Use one control-plane target whose internal `adapterUrl` and `expectedEnvironment` exactly match the adapter manifest.

Verify the disabled prefix, malformed raw targets, `TRACE`, `TRACK`, `CONNECT`, upgrade, non-100 `Expect`, ordinary-route fallthrough, exact one-handler routing, target mismatch, application callback inputs, application-specific live protocol checks, public denial, and browser-to-adapter isolation. Use `packages/typescript/node/README.md` and `examples/node-adapter` in a matching Gauntlet checkout as API examples; adapt them to the target application rather than copying package sources.
