// Browser-test fixture for the Gauntlet widget loader. Starts four servers:
// - host pages on http://127.0.0.1:4390 (an origin listed for target "shop"),
// - a fake Gauntlet on http://localhost:4391 (a different origin: the host name differs),
//   which also serves /evil-same-origin.html, a frame that is not the panel,
// - the same host pages on http://127.0.0.1:4392 (listed only for target "admin", so
//   the panel may be framed but rejects target "shop"), plus /evil.html,
// - the same host pages on http://127.0.0.1:4393 (listed for no target, so the
//   panel's frame-ancestors policy keeps it from loading at all).
// Like production, the fake panel is served with frame-ancestors set to the union
// of all configured origins.
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

const HOST_PORT = 4390;
const GAUNTLET_PORT = 4391;
const OTHER_PORT = 4392;
const UNLISTED_PORT = 4393;
const GAUNTLET = `http://localhost:${GAUNTLET_PORT}`;
const loaderFile = new URL("../dist/loader.js", import.meta.url);
const config = { targets: { shop: [`http://127.0.0.1:${HOST_PORT}`], admin: [`http://127.0.0.1:${OTHER_PORT}`] } };
const FRAME_ANCESTORS = `frame-ancestors ${[...new Set(Object.values(config.targets).flat())].join(" ")}`;

const STUB = "window.Gauntlet ||= function () { (Gauntlet.q ||= []).push(arguments); };";
const BOOT = 'Gauntlet("boot", { target: "shop", routes: [{ pattern: "/orders/:orderId", subject: "order" }] });';
const LOADER = `${GAUNTLET}/widget/loader.js`;

/** Each scenario: the inline script after the stub, and the loader tags that follow. */
const SCENARIOS = {
  basic: { script: BOOT, loaders: [LOADER] },
  queued: { script: `Gauntlet("setSubject", "cart", { cartId: "c1" });\n${BOOT}`, loaders: [LOADER] },
  silent: { script: BOOT, loaders: [`${GAUNTLET}/silent/widget/loader.js`] },
  evil: {
    script: `${BOOT}
for (const src of ["http://127.0.0.1:${OTHER_PORT}/evil.html", "${GAUNTLET}/evil-same-origin.html"]) {
  const evil = document.createElement("iframe");
  evil.src = src;
  evil.title = "evil";
  document.body.append(evil);
}`,
    loaders: [LOADER],
  },
  double: { script: BOOT, loaders: [LOADER, LOADER] },
  // Stub, boot and a blocking loader tag all in <head>: the loader runs before <body> exists.
  head: { script: BOOT, loaders: [LOADER], inHead: true },
};

function hostPage(scenarioName) {
  const scenario = SCENARIOS[scenarioName] ?? SCENARIOS.basic;
  const inHead = scenario.inHead === true;
  const loaderTags = scenario.loaders.map((src) => `<script src="${src}"${inHead ? "" : " async"}></script>`).join("\n");
  const scripts = `<script>
window.originalPushState = history.pushState;
window.originalReplaceState = history.replaceState;
${STUB}
</script>
<script>
${scenario.script}
</script>
${loaderTags}`;
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Widget host</title>
<!-- A permissive page policy, so only the panel iframe's own policy keeps the path out of its referrer. -->
<meta name="referrer" content="unsafe-url">
${inHead ? scripts : ""}
</head>
<body>
<h1>Widget host</h1>
${inHead ? "" : scripts}
</body>
</html>`;
}

const FAKE_PANEL = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Fake Gauntlet panel</title></head>
<body>
<p>Fake Gauntlet panel</p>
<script>
window.received = [];
window.connects = 0;
window.port = undefined;
window.oldPort = undefined;
let config;

function listen(port) {
  port.onmessage = (event) => {
    window.received.push(event.data);
    if (event.data && event.data.type === "gauntlet:context") {
      port.postMessage({ channel: 1, type: "gauntlet:state", contextualCount: event.data.context.subjects.length, globalCount: 1 });
    }
  };
}

window.addEventListener("message", (event) => {
  if (event.source !== parent) return;
  const data = event.data;
  if (!data || data.channel !== 1 || data.type !== "gauntlet:connect") return;
  const origins = config.targets[data.target] ?? [];
  if (!origins.includes(event.origin)) {
    parent.postMessage({ channel: 1, type: "gauntlet:rejected" }, "*");
    return;
  }
  window.connects += 1;
  if (window.port) window.oldPort = window.port;
  window.port = event.ports[0];
  listen(window.port);
});

window.panelSend = (message) => window.port.postMessage(message);
window.announceReady = () => parent.postMessage({ channel: 1, type: "gauntlet:ready" }, "*");

fetch("/widget/config.json")
  .then((response) => response.json())
  .then((loaded) => {
    config = loaded;
    window.announceReady();
  });
</script>
</body>
</html>`;

const SILENT_PANEL = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Silent panel</title></head>
<body><p>This panel never posts ready.</p></body>
</html>`;

const EVIL_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Evil frame</title></head>
<body>
<script>
window.gotPort = false;
window.addEventListener("message", (event) => {
  if (event.ports.length > 0) window.gotPort = true;
});
let sent = 0;
const timer = setInterval(() => {
  parent.postMessage({ channel: 1, type: "gauntlet:ready" }, "*");
  if (++sent >= 30) clearInterval(timer);
}, 100);
</script>
</body>
</html>`;

function send(response, status, type, body, headers = {}) {
  response.writeHead(status, { "content-type": type, "cache-control": "no-store", ...headers });
  response.end(body);
}

const HTML = "text/html; charset=utf-8";

function isHostPath(pathname) {
  return pathname === "/host.html" || pathname === "/plain" || pathname.startsWith("/orders/") || pathname.startsWith("/customers/");
}

function hostHandler(allowEvil) {
  return (request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    if (isHostPath(url.pathname)) return send(response, 200, HTML, hostPage(url.searchParams.get("scenario") ?? "basic"));
    if (allowEvil && url.pathname === "/evil.html") return send(response, 200, HTML, EVIL_PAGE);
    return send(response, 404, "text/plain", "not found");
  };
}

async function gauntletHandler(request, response) {
  const { pathname } = new URL(request.url ?? "/", "http://fixture.invalid");
  switch (pathname) {
    case "/widget/loader.js":
    case "/silent/widget/loader.js":
      try {
        return send(response, 200, "text/javascript; charset=utf-8", await readFile(loaderFile));
      } catch {
        return send(response, 404, "text/plain", "dist/loader.js is missing; run the build first");
      }
    case "/widget/":
      return send(response, 200, HTML, FAKE_PANEL, { "content-security-policy": FRAME_ANCESTORS });
    case "/widget/config.json":
      return send(response, 200, "application/json", JSON.stringify(config));
    case "/silent/widget/":
      return send(response, 200, HTML, SILENT_PANEL);
    case "/evil-same-origin.html":
      return send(response, 200, HTML, EVIL_PAGE);
    default:
      return send(response, 404, "text/plain", "not found");
  }
}

function listen(handler, port) {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

const servers = await Promise.all([
  listen(hostHandler(false), HOST_PORT),
  listen(gauntletHandler, GAUNTLET_PORT),
  listen(hostHandler(true), OTHER_PORT),
  listen(hostHandler(false), UNLISTED_PORT),
]);

function shutdown() {
  for (const server of servers) server.close();
  for (const server of servers) server.closeAllConnections();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
console.log(`widget fixture: host :${HOST_PORT}, gauntlet :${GAUNTLET_PORT}, other :${OTHER_PORT}, unlisted :${UNLISTED_PORT}`);
