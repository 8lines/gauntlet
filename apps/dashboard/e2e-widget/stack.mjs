// End-to-end stack for the Gauntlet widget. Starts, from the built artifacts:
// - the example adapter (conformance catalog) on a random port,
// - the Gauntlet control plane on http://localhost:4411 with the dashboard, the widget
//   panel (dist-widget) and one target "shop" whose widget origins list only the host,
// - the host application on http://127.0.0.1:4410 (listed for "shop"),
// - the same host application on http://127.0.0.1:4412 (listed for no target, so the
//   panel's frame-ancestors policy keeps it from loading there).
// The control plane listens last, so its /ready answering means the whole stack is up.
// Requires `pnpm build` first.
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { startServer } from "../../../examples/node-adapter/dist/server.js";
import { createApp } from "../../server/dist/app.js";

const HOST_PORT = 4410;
const GAUNTLET_PORT = 4411;
const UNLISTED_PORT = 4412;
const GAUNTLET = `http://localhost:${GAUNTLET_PORT}`;

// The example adapter's environment, see examples/typescript-fixture/src/index.ts.
const environment = { name: "typescript-fixture-test", kind: "test" };

const HOST_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Widget host application</title></head>
<body>
<h1>Widget host application</h1>
<script>
window.Gauntlet ||= function () { (Gauntlet.q ||= []).push(arguments); };
Gauntlet("boot", {
  target: "shop",
  routes: [{ pattern: "/applications/:applicationId", subject: "agency-application" }],
});
</script>
<script src="${GAUNTLET}/widget/loader.js" async></script>
</body>
</html>`;

function hostHandler(_request, response) {
  // Every path serves the same page, so pushState and reload behave like an SPA.
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(HOST_PAGE);
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = createServer(hostHandler);
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

const adapter = await startServer();
const hosts = await Promise.all([listen(HOST_PORT), listen(UNLISTED_PORT)]);
const app = await createApp({
  environment,
  dashboardDir: fileURLToPath(new URL("../dist", import.meta.url)),
  widget: { enabled: true, dir: fileURLToPath(new URL("../dist-widget", import.meta.url)) },
  targets: [
    {
      id: "shop",
      label: "Example shop",
      adapterUrl: adapter.url,
      expectedEnvironment: environment,
      widget: { origins: [`http://127.0.0.1:${HOST_PORT}`] },
    },
  ],
});
await app.listen({ host: "localhost", port: GAUNTLET_PORT });
console.log(`widget e2e stack: host :${HOST_PORT}, gauntlet :${GAUNTLET_PORT}, unlisted :${UNLISTED_PORT}, adapter ${adapter.url}`);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const server of hosts) {
    server.close();
    server.closeAllConnections();
  }
  await app.close();
  await adapter.close();
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
