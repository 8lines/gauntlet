# Embeddable widget

The Gauntlet widget is a floating button and panel that a tested application
embeds on its own pages. It shows operations relevant to the current page —
prefilled from the URL or from values the host page supplies — lets a tester
run them, and tracks recent runs, without leaving the application under test.
The panel reuses the dashboard's own form, confirmation and run-progress views
over the existing `/api/v1` API; it adds no new adapter surface.

This guide covers enabling the widget on the Gauntlet server, embedding it in
a host page by script tag or npm package, declaring where operations appear,
and the resulting security posture. For registering operations and data
sources in the first place, see [application integration](index.md) and
[authoring](../extensions/authoring.md).

## Enable it

The widget is off by default. Add a top-level `widget` object and, on each
target whose pages should embed it, a `widget.origins` list to the v1
configuration:

```yaml
widget:
  enabled: true
targets:
  - id: shop
    label: Shop
    adapterUrl: http://shop-dev:8080
    expectedEnvironment: { name: dev, kind: development }
    widget:
      origins: [https://shop.dev.example]
```

`widget.enabled` defaults to `false`. `targets[].widget.origins` entries must
be exact canonical HTTP(S) origins: no wildcards, credentials, paths, or
trailing slash. An uppercase host or a default port (`:443` for `https`, `:80`
for `http`) is rejected too — for example `https://shop.dev.example:443` is
rejected in favor of `https://shop.dev.example`. This matches the existing MCP
origin rules. An invalid `widget` value fails startup the same way any other
invalid configuration field does. See the [configuration
reference](../../config/README.md#widget) for the complete rules.

When the widget is enabled, `GAUNTLET_WIDGET_DIR` must also point at a
directory containing a built, regular `index.html`, `loader.js` and optional
`assets/`; an invalid or missing directory fails startup. The release image
already sets `GAUNTLET_WIDGET_DIR=/app/widget` and ships the built panel and
loader there, so a Compose or Helm deployment only needs the `widget` and
`targets[].widget` configuration above. See the [server
README](../../apps/server/README.md#widget-routes) for the served routes and
headers.

## Script integration

Add the boot snippet and the loader script to the host page, typically once in
a shared layout:

```html
<script>
  window.Gauntlet ||= function () { (Gauntlet.q ||= []).push(arguments); };
  Gauntlet("boot", {
    target: "shop",
    routes: [
      { pattern: "/orders/:orderId", subject: "order" },
      { pattern: "/customers/:customerId/orders/:orderId", subjects: { customer: ["customerId"], order: ["orderId"] } },
    ],
  });
</script>
<script src="https://gauntlet.internal/widget/loader.js" async></script>
```

`target` must match a configured target's `id`. Commands issued before the
loader script runs are queued and replayed in order, so the snippet above can
load in any order relative to `loader.js`.

### Route rules

Each entry in `routes` maps a URL pattern to one or more page subjects:

- A pattern starts with `/`. `:name` captures one decoded path segment into a
  named parameter; a trailing `*` matches the rest of the path and captures
  nothing. One trailing slash is optional.
- A rule needs exactly one of two forms:
  - `{ pattern, subject: "order" }` — every captured parameter becomes a value
    of the `order` subject.
  - `{ pattern, subjects: { order: ["orderId"], customer: ["customerId"] } }`
    — maps selected captured parameter names to each named subject type.
- The first rule whose pattern matches `location.pathname` wins; later rules
  are not evaluated.
- Subjects are recomputed on `popstate` and after `history.pushState` /
  `history.replaceState`, and only sent to the panel when they change.

### `setSubject` and `removeSubject`

Call these when a subject is not derivable from the URL, or to override a
route-derived one:

```html
<script>
  Gauntlet("setSubject", "order", { orderId: "12345" });
  // later, when the page no longer concerns that order:
  Gauntlet("removeSubject", "order");
</script>
```

An explicit subject replaces a URL-derived subject of the same type; removing
it makes the URL-derived subject, if any, visible again.

### `open`, `close`, `shutdown` and position

`Gauntlet("open")` and `Gauntlet("close")` control the panel programmatically;
both require `boot` to have run first. `Gauntlet("shutdown")` removes the
button, the iframe and all listeners, and clears any explicit subjects, so a
later `boot` starts clean.

`boot`'s optional `position` selects which bottom corner hosts the button and
which side the panel opens from: `"bottom-right"` (the default) or
`"bottom-left"`.

## npm integration

Install the typed package instead of hand-writing the queue stub:

```sh
npm install @8lines/gauntlet-widget@0.1.8
```

The package is published publicly on npmjs.org; see
[installing packages](../releases/installing-packages.md).

```typescript
import { boot, loadGauntletWidget } from '@8lines/gauntlet-widget';

// Inject the loader script once (idempotent); origin comes from your Gauntlet deployment.
loadGauntletWidget('https://gauntlet.internal');

boot({
  target: 'shop',
  routes: [
    { pattern: '/orders/:orderId', subject: 'order' },
    { pattern: '/customers/:customerId', subject: 'customer' },
  ],
});
```

`boot`, `setSubject`, `removeSubject`, `open`, `close` and `shutdown` are
exported as typed functions over the same `window.Gauntlet` queue; they are
SSR-safe no-ops when `window` is unavailable. A React hook that keeps a page
subject in sync:

```typescript
import { useEffect } from 'react';
import { setSubject, removeSubject } from '@8lines/gauntlet-widget';

export function OrderPage({ orderId }: { orderId: string }) {
  // Depend on the primitive value, not on a values object that is new on every render.
  useEffect(() => {
    setSubject('order', { orderId });
    return () => removeSubject('order');
  }, [orderId]);
  // ...
}
```

See the [package README](../../packages/widget/README.md) for the complete
API reference.

## Recent runs

The panel remembers the runs started from it in the browser's `localStorage`
under `gauntlet.recent-runs.v1`. The dashboard reads and writes the same key.
When the host application and Gauntlet are on the same site, both show the
same recent runs. Browsers that partition third-party storage give the panel
iframe its own storage under each host site, so there the widget keeps a list
separate from the dashboard's. The key used by
earlier widget versions, `gauntlet.widget.recent.v1`, is ignored; runs recorded
there are not carried over. The panel's recent list shows no live run state;
open a run to see its current state.

## Declaring placements

The widget shows an operation only when it declares `placements`; an
operation without one is reachable through the panel's search only, same as
today. A `global` placement lists the operation on every page; a `subject`
placement lists it when the page context contains a subject of that type, and
its optional `bindings` prefill the operation's input from that subject's
values. See [declaring placements](../extensions/authoring.md#place-an-operation-on-application-pages)
for the schema, SDK builders and the semantic rules bindings must satisfy.

## Production gating

Gauntlet has no production environment kind and no override — a target's
`expectedEnvironment` must already prove the adapter is non-production before
the control plane will use it. The widget adds no separate check: insert the
boot snippet, the loader script tag, or the `loadGauntletWidget`/`boot` calls
only in non-production builds of the host application, using the same
environment flag that already gates the application's own adapter.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Button shows the tooltip "Cannot reach Gauntlet" (`data-gauntlet-reason="unreachable"` on the `[data-gauntlet-widget]` element) | No handshake from the panel within 10 seconds: `widget.enabled` is not `true`, the panel/loader is unreachable, or the origin is missing from `frame-ancestors` | Check `widget.enabled` and `GAUNTLET_WIDGET_DIR`; the browser console names the target and origin to add |
| Button shows the tooltip "Gauntlet rejected this page (origin or target) — see the browser console" (`data-gauntlet-reason="rejected"`), and a console warning names the origin as rejected | `boot`'s `target` does not match any configured target `id` that declares `widget.origins`, or the host page's origin is not in that target's `widget.origins` | Check the `target` value passed to `boot` against the configuration, then add the printed origin to `targets[].widget.origins` for that target |
| An operation never appears in the panel | It has no `placements`, or none matches the current page's subject type | Add a `global` or `subject` placement; confirm the route rule's `subject`/`subjects` produces the expected subject type |
| A prefilled value is rejected on submit | The bound value does not satisfy the operation's input schema, or the target pointer is locked by the selected preset | The form shows the standard validation error, or a note that the field is locked by the preset; no run is created |

## Security notes

- **Framing policy.** `/widget/` sends `Content-Security-Policy: frame-ancestors`
  restricted to the union of configured `widget.origins` (`'none'` when no
  target declares any); the dashboard's own HTML always sends
  `frame-ancestors 'none'`, so only the widget panel can be framed, and only
  by the origins its targets configure.
- **No URL is sent.** The loader only ever sends the derived page context
  (target and subjects) to the panel; it never sends the page's URL, query
  string or fragment. The panel iframe is created with
  `referrerPolicy="origin"`, so loading it reveals only the host page's
  origin in the `Referer` header, never its path or query.
- **No CORS.** The `/widget/*` routes add no CORS headers; embedding relies
  on the framing policy above, not on cross-origin fetches.
- **The private network boundary is unchanged.** Gauntlet's v0.1
  authentication is still deferred; the widget does not add authentication,
  so the dashboard, REST API, MCP endpoint and widget routes must all stay
  behind the same verified private boundary.

[Documentation index](../README.md)
