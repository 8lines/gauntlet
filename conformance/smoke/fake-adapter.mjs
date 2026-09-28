import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

const root = new URL("../../", import.meta.url);
const health = await readFile(new URL("packages/protocol/fixtures/v1/health.valid.json", root));
const manifest = await readFile(new URL("conformance/smoke/manifest.json", root));
const manifestDocument = JSON.parse(manifest.toString("utf8"));
if (typeof manifestDocument.manifestRevision !== "string") {
  throw new TypeError("Canonical manifest fixture has no revision");
}
const manifestEtag = `"${manifestDocument.manifestRevision}"`;
const routeNotFound = Buffer.from(JSON.stringify({
  type: "urn:gauntlet:problem:route-not-found",
  title: "Route not found",
  status: 404,
}));

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/_gauntlet/v1/health") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(health);
    return;
  }

  if (request.method === "GET" && request.url === "/_gauntlet/v1/manifest") {
    if (request.headers["if-none-match"] === manifestEtag) {
      response.writeHead(304, { etag: manifestEtag });
      response.end();
      return;
    }
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      etag: manifestEtag,
    });
    response.end(manifest);
    return;
  }

  response.writeHead(404, { "content-type": "application/problem+json; charset=utf-8" });
  response.end(routeNotFound);
});

server.requestTimeout = 5_000;
server.headersTimeout = 5_000;
server.keepAliveTimeout = 1_000;
server.connectionsCheckingInterval = 1_000;
server.maxHeadersCount = 100;
server.listen(8081, "0.0.0.0");

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  const forceClose = setTimeout(() => {
    server.closeAllConnections();
    process.exit(1);
  }, 5_000);
  forceClose.unref();
  server.close((error) => {
    clearTimeout(forceClose);
    process.exit(error === undefined ? 0 : 1);
  });
}

server.on("error", () => {
  process.stderr.write("Fixture adapter failed to start\n");
  process.exitCode = 1;
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, shutdown);
}
