# Pinned operations

A person using Gauntlet can pin operations they use often. Pinned operations move to a "Pinned" section at the top of the dashboard sidebar and at the top of the widget's operation lists. Pins are stored by the Gauntlet server, so the dashboard, the widget on every host application and every device show the same pins.

## Scope

- A pin belongs to one principal and one target: `(principal, targetId, operationId)`. Pinning an operation on one target does not pin an operation with the same id on another target, because operation ids are only unique within one manifest.
- Pins work in every authentication mode. The key is `principal.id`: each `user:*` and `token:*` principal has its own pins, everyone signed in with the shared password shares the `shared` pins, and with authentication disabled (`none`) everyone shares the `anonymous` pins.
- Pins are ordered by the time they were pinned, oldest first. A new pin appears at the bottom of the Pinned section.
- A principal can hold at most 100 pins per target.
- Out of scope: manual reordering, a pin control on the operation screen, pins shared across targets.

## Database

Gauntlet gets a small SQLite database using the built-in `node:sqlite` module (`DatabaseSync`). No runtime dependency is added; Node 24 (the supported, CI and container version) provides it.

- `apps/server/src/database.ts` opens the database, enables WAL for a file database, and applies numbered migrations recorded in a `schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)` table, each in its own transaction. Applying the migrations to an up-to-date database changes nothing. The database is closed in the Fastify `onClose` hook.
- The file is `$GAUNTLET_DATA_DIR/gauntlet.sqlite`. `GAUNTLET_DATA_DIR` must name an existing, writable directory; otherwise startup fails with a generic error that names the variable.
- Without `GAUNTLET_DATA_DIR` the database is in memory (`:memory:`) and the server emits a startup warning (code `GAUNTLET_DATA_EPHEMERAL`) that pins are lost on restart. Development, tests and the smoke compose stack work without configuration.
- `createApp` accepts an optional `dataDir`; `main.ts` reads it from the environment like the other `GAUNTLET_*` variables.

Migration 1:

```sql
CREATE TABLE pins (
  principal_id TEXT NOT NULL,
  target_id    TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  pinned_at    TEXT NOT NULL,
  PRIMARY KEY (principal_id, target_id, operation_id)
) WITHOUT ROWID;
```

## Pin store

`apps/server/src/pin-store.ts` defines the interface; `apps/server/src/sqlite-pin-store.ts` implements it with prepared statements.

```ts
interface Pin { readonly operationId: string; readonly pinnedAt: string }
interface PinStore {
  list(principalId: string, targetId: string): readonly Pin[];        // oldest first
  pin(principalId: string, targetId: string, operationId: string, at: Date): PinResult;
  unpin(principalId: string, targetId: string, operationId: string): void;
}
type PinResult = { readonly ok: true } | { readonly ok: false; readonly reason: "limit" };
```

Pinning an already pinned operation keeps its original `pinnedAt`. Unpinning an operation that is not pinned does nothing. The clock comes from `createApp`'s `clock`.

## API

Routes are registered with the other `/api/v1` routes and are protected by the existing guard (including its origin check for cookie-authenticated mutations).

- `GET /api/v1/targets/:targetId/pins` → `200 { "pins": [{ "operationId": "...", "pinnedAt": "..." }] }`.
- `PUT /api/v1/targets/:targetId/pins/:operationId` → `204`. Idempotent.
- `DELETE /api/v1/targets/:targetId/pins/:operationId` → `204`. Idempotent.

Rules:

- Path ids are validated with `isProtocolId`; invalid ids get the existing invalid-path problem.
- An unknown target gets the existing target-not-found problem. The operation is not checked against the manifest: a pin for an operation that disappears stays stored and reappears with the operation; clients do not show it meanwhile.
- The 101st pin gets `409` with `urn:gauntlet:problem:pin-limit` ("Too many pinned operations").
- A database error gets `500` with `urn:gauntlet:problem:pins-unavailable` ("Pinned operations are unavailable"). Both new problem types are added to the fixed titles in `safe-problem.ts`.
- The principal key is `principal.id`, or `anonymous` for the anonymous principal.

The control-plane API reference documents the three routes.

## Clients

`apps/dashboard/src/pins.ts` adds `listPins`, `pin` and `unpin` to the API client, using the existing `request` helper (bearer token and cookie handling unchanged). `usePins(targetId)` returns `{ pinnedIds: ReadonlySet<string> | undefined, isPinned(id), toggle(id) }`:

- It loads the pins when the target changes and again when the document becomes visible, so a pin made in the widget shows up in the dashboard after switching back, and the reverse.
- `toggle` updates the set at once and calls the API; on failure it restores the previous set and exposes a short message ("Could not pin the operation." / "Could not unpin the operation."). The dashboard has no toasts: the sidebar shows the message as one line of muted text with `role="alert"` above its groups, and the widget shows it above its lists in the same way. The message clears on the next toggle or after five seconds.
- If loading fails, `pinnedIds` stays undefined and the lists render exactly as today, without a Pinned section and without pin controls.

## Dashboard sidebar

- A "Pinned" group sits below "Overview" and above the feature groups. It is rendered only when at least one pinned operation is in the manifest.
- Pinned operations are removed from their feature groups. A feature group left empty is hidden. The "Other" group follows the same rule.
- Every operation item (pinned or not) gets a `SidebarMenuAction showOnHover` with a lucide `Pin` icon (`PinOff` for a pinned item), `aria-label` "Pin <label>" or "Unpin <label>", and a tooltip "Pin" or "Unpin". On mobile the action is always visible, as the component already does.
- The "Unavailable" badge moves left of the action so they never overlap.
- Grouping is a pure function `sidebarGroups(manifest, pinnedIds)` in `apps/dashboard/src/app/sidebar-groups.ts`, returning `{ pinned, groups }`.

## Widget

- A "Pinned" section is the first section, above "On this page". It contains the pinned operations that currently appear in "On this page" or "Global", in pin order, keeping each operation's page subject so prefill keeps working. Those operations are removed from "On this page" and "Global". Operations without placements, and contextual operations whose place is not on the current page, are not shown. The section is rendered only when it is not empty.
- While a query is entered, search results keep their order; each row shows its pin state.
- `OperationRow` gets an icon-only pin button next to the `DashboardLink`, with the same icons, labels and tooltips as the sidebar.
- Splitting is a pure function `applyPins(lists, pinnedIds)` in `apps/dashboard/src/widget/placements.ts`, returning `{ pinned, contextual, global }`.

Copy follows the dashboard rules: sentence case, no em dashes.

## Helm

The chart gains a `persistence` section:

```yaml
persistence:
  enabled: false
  size: 1Gi
  storageClass: ""
  existingClaim: ""
```

When enabled, the chart creates a `ReadWriteOnce` PersistentVolumeClaim (unless `existingClaim` is set), mounts it at `/var/lib/gauntlet`, sets `GAUNTLET_DATA_DIR=/var/lib/gauntlet` and uses the `Recreate` deployment strategy. `readOnlyRootFilesystem` stays true. When disabled, the chart behaves as today and pins are in memory. The values schema, the schema tests and the rendered-manifest tests cover both cases; the chart README documents the section.

## Testing

- `apps/server/test/database.test.ts`: migrations on a new database, re-applying them is a no-op, a file database keeps data after reopening, a missing data directory fails startup.
- `apps/server/test/sqlite-pin-store.test.ts`: order, idempotent pin keeps `pinnedAt`, unpin, limit, isolation by principal and target.
- `apps/server/test/pins-routes.test.ts` (`app.inject`): two users see only their own pins, `anonymous` pins with auth disabled, shared-password users share pins, invalid ids, unknown target, limit problem, unauthenticated requests rejected when auth is enabled.
- `apps/dashboard/test/sidebar-groups.test.ts` and additions to `widget-placements.test.ts`: pinned operations move, empty groups disappear, unknown pinned ids are ignored, subjects are kept.
- Dashboard e2e (`e2e/pins.spec.ts`, mocked API in `api-fixture.ts`): pinning from the sidebar moves the operation to Pinned, unpinning moves it back, on desktop and mobile.
- Widget e2e (real stack): pinning a row moves it to Pinned and survives reopening the panel.

## Release

One change file, `type: added`, `units: gauntlet: minor`, describing pinned operations and `GAUNTLET_DATA_DIR`. The configuration reference documents `GAUNTLET_DATA_DIR` and the in-memory default.
