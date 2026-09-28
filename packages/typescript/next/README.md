# Gauntlet Next.js bridge

This thin App Router bridge accepts only a normalized Web `Request`. It does not
see the original raw target and never claims native raw-target equivalence. It
contains no dashboard UI. A trusted ingress is mandatory: it alone receives
untrusted traffic, rejects percent escapes, dot segments, repeated slashes,
backslashes, query/fragment syntax, and literal SP/HTAB before forwarding,
strips every client-supplied `X-TC-*` and `X-Forwarded-*` header, and returns a
fixed malformed 400 even when the upstream adapter is disabled.

```ts
// app/%5Fgauntlet/v1/[...gauntlet]/route.ts
import { createGauntletRouteHandler } from "@8lines/gauntlet-next-adapter";
import { catalog } from "../../../../gauntlet/catalog.js";

const handler = createGauntletRouteHandler({
  enabled: process.env.GAUNTLET_ENABLED === "true",
  catalog,
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
export const HEAD = handler;
```

The relative import above points to the application's
`gauntlet/catalog.ts`. Build that module with the
[compile-checked Core example](../core/README.md#build-a-catalog). The
repository's runnable Next fixture shows the same composition in its
[route module](../../../examples/next/app/%255Fgauntlet/v1/%5B...gauntlet%5D/route.ts).

Use `runtime = "nodejs"`, `dynamic = "force-dynamic"`, and `revalidate = 0`.
Next treats a leading `_` directory as private, so the literal URL segment
`_gauntlet` must use its documented filesystem escape `%5Fgauntlet`;
never replace it with a dynamic first segment.
`skipTrailingSlashRedirect` and `skipProxyUrlNormalize` are useful hardening,
not raw-target recovery. Use native Node when the package must own the complete
raw-target and disabled-precedence contract. Deny `/_gauntlet/*` at public
ingress, expose it only on private environment networking, and leave
`GAUNTLET_ENABLED` absent outside non-production environments. The adapter
publishes only registered Core operations/capabilities and is never a generic
application-route proxy or arbitrary executor.

[Documentation index](../../../docs/README.md)
