/**
 * Starts a local stack for working on the Gauntlet widget:
 *   1. the example adapter (conformance catalog) on a random port,
 *   2. the Gauntlet control plane on :8080 — the built dashboard and widget
 *      panel (GAUNTLET_WIDGET_DIR), with one target pointing at the adapter,
 *   3. the host page (the application that embeds the widget) on :5180 — the same
 *      content for every path, so history (pushState) and a manual reload
 *      behave the same.
 *
 * Requires the built dashboard and widget: run `pnpm build` before this script.
 * Run: node apps/dashboard/scripts/local-stack.mjs
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { startServer } from "../../../examples/node-adapter/dist/server.js";
import { createApp } from "../../server/dist/app.js";

const DASHBOARD_DIR = fileURLToPath(new URL("../dist", import.meta.url));
const WIDGET_DIR = fileURLToPath(new URL("../dist-widget", import.meta.url));
const DEMO_PAGE = fileURLToPath(new URL("./demo-host-page.html", import.meta.url));
const DEMO_PAGE_ORIGIN = "http://127.0.0.1:5180";

// The example adapter's environment, see examples/typescript-fixture/src/index.ts.
const environment = { name: "typescript-fixture-test", kind: "test" };

const adapter = await startServer();
process.stdout.write(`example adapter: ${adapter.url}\n`);

const app = await createApp({
  environment,
  dashboardDir: DASHBOARD_DIR,
  widget: { enabled: true, dir: WIDGET_DIR },
  targets: [
    {
      id: "example",
      label: "Example adapter",
      adapterUrl: adapter.url,
      expectedEnvironment: environment,
      tags: ["typescript"],
      widget: { origins: [DEMO_PAGE_ORIGIN] },
    },
  ],
});
await app.listen({ host: "127.0.0.1", port: 8080 });
process.stdout.write("control plane: http://127.0.0.1:8080\n");

const demoPageContent = await readFile(DEMO_PAGE);
const demoServer = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(demoPageContent);
});
await new Promise((resolvePromise) => demoServer.listen(5180, "127.0.0.1", resolvePromise));
process.stdout.write(`host page (demo): ${DEMO_PAGE_ORIGIN}/applications/11111111-1111-4111-8111-111111111111\n`);

const shutdown = async () => {
  await app.close();
  await adapter.close();
  await new Promise((resolvePromise) => demoServer.close(resolvePromise));
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
