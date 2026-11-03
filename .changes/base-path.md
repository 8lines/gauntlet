---
type: added
units:
  gauntlet: patch
upgrade: optional
---
Gauntlet can be served below a URL path prefix such as `/tester` on a host shared with other applications, set with `basePath` in the configuration or `GAUNTLET_BASE_PATH`, with the dashboard, API, widget, MCP endpoint and session cookie all below the prefix and `/health` and `/ready` still at the root.

## Upgrade

Nothing changes unless you set a base path: the default `basePath: ""` serves
Gauntlet at the root as before, and the dashboard and widget files are served
unchanged.

To serve Gauntlet below a prefix, for example `https://qa.example/tester`:

- Route the prefix to Gauntlet without stripping it; Gauntlet expects requests
  to arrive as `/tester/...`.
- Source, Compose or a custom container: set `basePath: /tester` at the top of
  the configuration file, or set `GAUNTLET_BASE_PATH=/tester` in the
  environment. A non-empty `GAUNTLET_BASE_PATH` overrides `basePath`; unset or
  empty uses the configuration. The value starts with `/`, has no trailing
  slash, query, fragment, `%`-escape or dot segment; an invalid value fails
  startup.
- Helm: set the new top-level value `basePath: /tester` (default `""`), which
  the chart passes as `GAUNTLET_BASE_PATH`, and an Ingress path `/tester` with
  `pathType: Prefix`. The probes keep calling `/ready` and `/health` at the
  root, which stay available.

With a base path, the dashboard opens at `/tester/`, `/tester` redirects there,
the API is `/tester/api/v1`, MCP clients connect to `/tester/mcp`, and pages
embedding the widget include `https://qa.example/tester/widget/loader.js`.
Every other path outside the prefix answers `404`. In password mode keep
`auth.publicUrl` an origin (`https://qa.example`); testers sign in again once,
because the session cookie is now sent with `Path=/tester`.
