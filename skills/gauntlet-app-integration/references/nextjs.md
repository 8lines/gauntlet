# Next.js App Router

Support Next.js on Node.js 24–26. Install exact releases from the public npm registry; no scope mapping or registry token is needed:

```sh
pnpm add @8lines/gauntlet-protocol@0.1.6 \
  @8lines/gauntlet-typescript-core@0.1.6 \
  @8lines/gauntlet-next-adapter@0.1.6
```

Build one explicit application-owned Core catalog with a stable secret and runtime components truthful for the process topology. Mount one catch-all route at `app/%5Fgauntlet/v1/[...gauntlet]/route.ts`; a leading `_` directory is private to Next, so keep the documented `%5Fgauntlet` filesystem escape. Export all supported methods from one `createGauntletRouteHandler`, with `runtime = "nodejs"`, `dynamic = "force-dynamic"`, and `revalidate = 0`.

Map the deployment's organization-specific production aliases and infrastructure identities before enabling; passing the built-in token check is only a minimum and an ambiguous identity blocks enablement.

Operation closures remain in the serving Node process. Shared stores/coordinators can provide distributed admission, cancellation visibility, and persistent run metadata, but cannot replay or resume a closure after process loss. Use a verified singleton execution process with no durability claim, or explicit leases/heartbeats that terminalize orphaned/stale runs and recover through a new application execution. Never claim durable execution replay.

The bridge sees a normalized Web `Request`, not the original request target. Put a trusted raw-request ingress in front of it which, before normalization or forwarding:

- accepts only canonical origin-form Adapter v1 targets;
- rejects percent escapes, backslashes, absolute-form targets, SP/HTAB, query or fragment syntax, repeated slashes, dot segments, trailing slashes, and unsafe path IDs;
- strips client-supplied `X-TC-*` and `X-Forwarded-*` headers;
- gives fixed malformed responses in enabled and disabled upstream modes;
- denies `/_gauntlet/v1` on every public listener and forwards it only on the private path.

`skipTrailingSlashRedirect`, `skipProxyUrlNormalize`, route-handler tests, and decoded `pathname` assertions are defense in depth, not raw-target evidence. If the deployed proxy normalizes before a trusted component can reject, stop the hardened claim and keep the adapter private and incomplete.

Verify raw bytes through the deployed trusted ingress for encoded slash/underscore/dot variants, duplicate slash, backslash, absolute form, query, fragment, whitespace, malformed IDs, disabled precedence, and ordinary application routes. Also run live Adapter v1 conformance and public-prefix denial. Use `packages/typescript/next/README.md` and `examples/next` in a Gauntlet checkout as the authoritative route contract.
