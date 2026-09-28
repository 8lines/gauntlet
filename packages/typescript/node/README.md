# Gauntlet Node adapter

Framework-neutral Web `Request`/`Response` transport for an explicitly enabled
Gauntlet adapter. It is an internal, non-production endpoint and contains no
dashboard UI. The adapter exposes only operations and data sources registered
in the Core catalog; it is not a route, class, command, URL, or SQL executor.

```ts
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createAdapterFetchHandler } from "@8lines/gauntlet-typescript-node";
import { createAjvSchemaValidator } from "@8lines/gauntlet-typescript-core";
import { catalog } from "./gauntlet/catalog.js";
import {
  handleClientError,
  handleExceptionalResponse,
  handleExceptionalSocket,
} from "./gauntlet-http-boundary.js";

const enabled = process.env.GAUNTLET_ENABLED === "true";
const handler = createAdapterFetchHandler({
  enabled,
  catalog,
  schemaValidator: createAjvSchemaValidator(),
});

const server = createServer(async (incoming, outgoing) => {
  const rawTarget = incoming.url;
  if (typeof rawTarget !== "string") {
    outgoing.writeHead(400, { "content-length": "0", connection: "close" });
    outgoing.end();
    return;
  }
  if (["CONNECT", "TRACE", "TRACK"].includes(incoming.method ?? "")) {
    handleExceptionalResponse(
      incoming, outgoing, enabled, 405,
      "urn:gauntlet:problem:unsupported-method", "Unsupported method",
    );
    return;
  }
  const canonicalMount = rawTarget === "/_gauntlet/v1"
    || rawTarget.startsWith("/_gauntlet/v1/");
  const requestTarget = rawTarget.startsWith("/") ? rawTarget : "/";
  const request = new Request(`http://adapter${requestTarget}`, {
    method: incoming.method,
    headers: incoming.headers as HeadersInit,
    body: ["GET", "HEAD"].includes(incoming.method ?? "") ? undefined : incoming as never,
    duplex: "half",
  } as RequestInit);
  const response = await handler({ kind: "raw", request, rawTarget });
  if (!rawTarget.startsWith("/") && response.status === 404) {
    await response.body?.cancel();
    outgoing.writeHead(400, { "content-length": "0", connection: "close" });
    outgoing.end();
    return;
  }
  if (!canonicalMount && rawTarget.startsWith("/") && response.status === 404) {
    await response.body?.cancel();
    // Delegate this untouched IncomingMessage to the normal application router.
    // serveApplication(incoming, outgoing);
    outgoing.writeHead(404).end();
    return;
  }
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body === null || incoming.method === "HEAD") {
    outgoing.end();
    return;
  }
  await pipeline(Readable.fromWeb(response.body as never), outgoing);
});

server.on("clientError", (error: Error & { rawPacket?: Buffer }, socket) => {
  handleClientError(socket, error.rawPacket, enabled);
});
server.on("connect", (incoming, socket) => handleExceptionalSocket(
  incoming, socket, enabled, 405,
  "urn:gauntlet:problem:unsupported-method", "Unsupported method",
));
server.on("upgrade", (incoming, socket) => handleExceptionalSocket(
  incoming, socket, enabled, 405,
  "urn:gauntlet:problem:unsupported-method", "Unsupported method",
));
server.on("checkExpectation", (incoming, outgoing) => handleExceptionalResponse(
  incoming, outgoing, enabled, 417,
  "urn:gauntlet:problem:expectation-failed", "Expectation failed",
));
```

`./gauntlet/catalog.js` is application-owned. Build and export it with the
Core registries, manager, and catalog factory shown in the
[compile-checked Core example](../core/README.md#build-a-catalog). The
repository's runnable host uses the
[conformance catalog](../../../examples/node-adapter/src/server.ts); a deployed
application should inject its own durable/shared `RunStore` and stable
idempotency secret.

The complete application-owned boundary helper is compile-checked in the
[native Node example](../../../examples/node-adapter/src/client-error.ts). Copy
that helper from the matching release rather than reimplementing target
classification. It uses the package-exported `isAdapterTarget` for bounded
`clientError` parsing and for Node's parser-valid paths which bypass the normal
request callback: `connect`, `upgrade`, and non-100 `checkExpectation` events.
It also handles Fetch-forbidden `TRACE`/`TRACK` before constructing a Web
`Request`. Adapter-equivalent requests receive the disabled 503 whenever the
adapter is off; enabled special requests receive an owned 405/417 Problem;
unrelated traffic receives a generic response and never an adapter Problem.

Capture `incoming.url` before constructing `URL` or `Request`; pass that exact
value as `rawTarget`. The handler recognizes adapter-equivalent lossy and
absolute-form targets before disabled precedence. Only a canonical origin-form
404 may fall through to the normal application router; every non-origin-form
404 becomes a fixed bodyless 400. A missing `IncomingMessage.url` is also a
fixed bodyless 400 and is never dispatched.

Native Node's exceptional HTTP events must be owned as shown above. The same helper
is exercised by the repository's reference fixture; it
inspects at most the first 8192 bytes of `rawPacket`, decodes them as exact
Latin-1 byte values, never logs or retains them, guards against a second write,
and uses the package's bounded raw-target ownership classifier. When disabled,
an identifiable adapter-equivalent request is 503; otherwise malformed adapter
syntax is 400. Unknown host traffic receives a generic bodyless 400. Socket
lifecycle and response bytes remain application-owned.

Managed cancellation is advertised by a real Core `RunManager`; its route
publishes cancellation through the configured execution coordinator so the
active handler's `AbortSignal` is reached even in another replica. A registered
cancellation SPI is used only as a fallback for external run IDs. Events,
upload, and session-launch routes still exist only through their typed Core
SPIs. Absent optional SPIs return the exact 501 capability Problem before body
parsing or resource lookup. JSON and multipart bodies are bounded, SSE is
streamed with backpressure, downstream disconnects cancel the Web stream, and
session URLs are returned but never fetched.

Deploy this route only on private environment networking behind workload
identity, a VPN, or an ingress allow-list. `GAUNTLET_ENABLED` must be exactly
`"true"`; leave it absent in production artifacts. See the
[integration overview](../../../docs/integrations/index.md) for other supported
stacks.

[Documentation index](../../../docs/README.md)
