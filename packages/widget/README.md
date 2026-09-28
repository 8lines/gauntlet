# Gauntlet widget

`@8lines/gauntlet-widget` provides typed, SSR-safe command functions and types for
embedding the Gauntlet widget in a web application. The widget is a floating panel
that displays operations matching the current page, with inputs prefilled from
page context (URL parameters, page state, or explicit subject data).

## Quick start: inline snippet

For a single-file HTML page or simple setup:

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

## NPM usage

Install the package:

```bash
npm install @8lines/gauntlet-widget
```

Load the widget and configure it:

```typescript
import { boot, loadGauntletWidget } from '@8lines/gauntlet-widget';

// Inject the loader script once
loadGauntletWidget('https://gauntlet.internal');

// Boot the widget with your target and URL-to-subject mappings
boot({
  target: 'shop',
  routes: [
    { pattern: '/orders/:orderId', subject: 'order' },
    { pattern: '/customers/:customerId', subject: 'customer' },
  ],
});
```

## Page subjects and context

Define page subjects manually:

```typescript
import { setSubject, removeSubject } from '@8lines/gauntlet-widget';

// On an order page, set the order ID
setSubject('order', { orderId: '12345' });

// Remove it when the page changes
removeSubject('order');
```

### React hook example

Use a hook to keep page context in sync:

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

## Security and production gating

**Include the widget only in non-production builds.** Gate it with an environment
flag:

```typescript
if (process.env.NODE_ENV !== 'production') {
  loadGauntletWidget('https://gauntlet.internal');
  boot({ target: 'shop', routes: [...] });
}
```

The widget is unusable without proper configuration; see **Origin allowlist** below.

## Origin allowlist

The page origin must be explicitly configured in Gauntlet. Enable the widget and
add the application's origin to the target configuration:

```yaml
widget:
  enabled: true
targets:
  - id: shop
    label: Shop
    adapterUrl: http://shop-dev:8080
    expectedEnvironment: { name: dev, kind: development }
    widget:
      origins:
        - https://shop.dev.example
        - https://shop.staging.example
```

Without this configuration, the widget will not function. This prevents unauthorized
origins from accessing the Gauntlet instance.

## API reference

| Function | Purpose |
| --- | --- |
| `loadGauntletWidget(gauntletUrl)` | Inject the loader script once (idempotent) |
| `boot(options)` | Initialize the widget with target and route rules |
| `setSubject(type, values)` | Set or update page context for a subject type |
| `removeSubject(type)` | Remove page context for a subject type |
| `open()` | Programmatically open the widget panel |
| `close()` | Close the widget panel |
| `shutdown()` | Disable the widget |

## SSR safety

All functions are SSR-safe. When `window` is not available (Node.js, early SSR phases),
commands silently become no-ops. No errors or warnings are emitted.

---

[Documentation index](../../docs/README.md)
