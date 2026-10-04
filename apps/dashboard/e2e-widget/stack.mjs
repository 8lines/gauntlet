// End-to-end stack for the Gauntlet widget. Starts, from the built artifacts:
// - the example adapter (conformance catalog) on a random port,
// - the Gauntlet control plane on http://localhost:4411 with the dashboard, the widget
//   panel (dist-widget) and one target "shop" whose widget origins list only the host,
// - the host application on http://127.0.0.1:4410 (listed for "shop"),
// - the same host application on http://127.0.0.1:4412 (listed for no target, so the
//   panel's frame-ancestors policy keeps it from loading there).
// - a second control plane on http://localhost:4413 with password authentication (shared
//   password "widget-password"), the same adapter, and its host application on
//   http://127.0.0.1:4414: plain HTTP and cross-site, so the panel cannot keep a cookie.
// The first control plane listens last, so its /ready answering means the whole stack is up.
// Requires `pnpm build` first.
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { startServer } from "../../../examples/node-adapter/dist/server.js";
import { createApp } from "../../server/dist/app.js";
import { authConfiguration } from "../../server/dist/auth/config.js";
import { hashPassword } from "../../server/dist/auth/passwords.js";

const HOST_PORT = 4410;
const GAUNTLET_PORT = 4411;
const UNLISTED_PORT = 4412;
const GAUNTLET = `http://localhost:${GAUNTLET_PORT}`;
const AUTH_HOST_PORT = 4414;
const AUTH_GAUNTLET_PORT = 4413;
const AUTH_GAUNTLET = `http://localhost:${AUTH_GAUNTLET_PORT}`;

// The example adapter's environment, see examples/typescript-fixture/src/index.ts.
const environment = { name: "typescript-fixture-test", kind: "test" };

const hostPage = (gauntlet) => `<!doctype html>
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
<script src="${gauntlet}/widget/loader.js" async></script>
</body>
</html>`;

const hostHandler = (page) => (_request, response) => {
  // Every path serves the same page, so pushState and reload behave like an SPA.
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(page);
};

function listen(port, gauntlet = GAUNTLET) {
  return new Promise((resolve, reject) => {
    const server = createServer(hostHandler(hostPage(gauntlet)));
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

const adapter = await startServer();
const hosts = await Promise.all([listen(HOST_PORT), listen(UNLISTED_PORT), listen(AUTH_HOST_PORT, AUTH_GAUNTLET)]);
const authenticatedApp = await createApp({
  environment,
  dashboardDir: fileURLToPath(new URL("../dist", import.meta.url)),
  widget: { enabled: true, dir: fileURLToPath(new URL("../dist-widget", import.meta.url)) },
  auth: {
    configuration: authConfiguration({
      mode: "password",
      publicUrl: AUTH_GAUNTLET,
      password: { shared: { hash: await hashPassword("widget-password") } },
    }),
    secret: Buffer.alloc(32, 7),
  },
  targets: [
    {
      id: "shop",
      label: "Example shop",
      adapterUrl: adapter.url,
      expectedEnvironment: environment,
      widget: { origins: [`http://127.0.0.1:${AUTH_HOST_PORT}`] },
    },
  ],
});
await authenticatedApp.listen({ host: "localhost", port: AUTH_GAUNTLET_PORT });
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
  await authenticatedApp.close();
  await adapter.close();
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
