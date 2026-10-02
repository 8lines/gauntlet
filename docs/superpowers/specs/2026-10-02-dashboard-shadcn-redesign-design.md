# Gauntlet: dashboard redesign on shadcn/ui

Status: approved design, 2026-10-02. Target release: 0.1.8.

## Intent

Replace the dashboard's presentation layer with stock shadcn/ui components,
composed according to the design judgment of https://vercel.com/design.md.
The visual reference is `docs/mockups/dashboard-shadcn.html` (variant 1 of five
explored mockups). Nobody uses the dashboard in production yet, so this is a
single rewrite released as 0.1.8, not a staged migration: copy, selectors,
classes and the widget's recent-runs storage key may change.

Success means: every current dashboard and widget feature works in the new
UI, the additions below work, the rules below hold on every screen in light
and dark themes at desktop and 390 px, and the existing unit and browser
suites (rewritten where they test presentation) pass.

## Scope

In scope:

- `apps/dashboard` presentation: app shell, environment overview, operation
  screen, run view, command search, settings, empty/loading/error states.
- The widget panel (`apps/dashboard/src/widget`) on the same components.
- Additions: catalog as a filterable table with impact and a policy summary,
  Refresh, impact breakdown in the stats, a run URL, and recent runs in the
  dashboard.
- `copy.ts` rewritten without em dashes.
- Docs, changelog and the 0.1.8 release preparation.

Out of scope: protocol, adapter and control-plane API changes. The run URL
uses the existing `GET /api/v1/targets/{targetId}/runs/{runId}`.

Kept unchanged (logic without UI, with its unit tests): `api.ts`,
`json-pointer.ts`, `create-run-request.ts`, the policy logic in `copy.ts`,
`useOperationDetails.ts`, and the widget's `handshake`, `placements`,
`prefill`, `search`, `view`, `usePanelChannel`, `usePanelTarget`,
`usePanelCatalog` modules. `recent-runs.ts` keeps its behaviour with a new key.

## Design rules

These apply to the app UI. Vercel branding (wordmark, triangle,
`vercel-brand.css`, `vbg-*` classes) is not used; Gauntlet keeps its own name
and a monochrome mark.

### Tokens

Fonts are self-hosted: `@fontsource-variable/geist` and
`@fontsource-variable/geist-mono` (no Google Fonts requests, which matters for
private deployments). Geist for everything; Geist Mono only for identifiers and
machine text: operation, run and correlation ids, field pointers, JSON, logs,
log timestamps, commands, config URLs, keyboard keys. Only the identifier is
set in mono, never the surrounding sentence or row.

Type roles. No other sizes or weights; tabular numerals for numbers.

| Role | Size / line height | Weight |
|---|---|---|
| page title, one per screen | 24 / 32 | 600 |
| section heading | 20 / 28 | 600 |
| subsection | 16 / 24 | 600 |
| body: prose, ordinary table cells | 14 / 20 | 400 |
| label: names, controls, table row labels and headers | 14 / 20 | 500 |
| compact: help text, secondary lines | 13 / 18 | 400 |
| metadata: ids, timestamps, key hints, never sentences | 12 / 16 | 400 |

shadcn CSS variables take these values. Light / dark:

| Token | Light | Dark | Use |
|---|---|---|---|
| `--background` | `#ffffff` | `#0a0a0a` | canvas |
| `--muted`, `--sidebar` | `#fafafa` | `#111111` | sidebar, table head, code blocks |
| `--foreground`, `--primary` | `#171717` | `#ededed` | text, primary button fill |
| `--muted-foreground` | `#666666` | `#a1a1a1` | secondary text |
| `--border` | `#ebebeb` | `#242424` | rules, rows, container edges |
| `--input` | `#d4d4d4` | `#3d3d3d` | inputs, hover |
| `--ring`, `--focus` | `#0a72ef` | `#3b9eff` | focus ring, links, selection |
| `--ok` | `#107d32` | `#4cc274` | read only, done, online |
| `--warn` | `#a35200` | `#f0a23b` | changes data, partial, degraded, warnings |
| `--err`, `--destructive` | `#cb2a2f` | `#ff6166` | deletes data, failed, unavailable, errors |

`--primary-foreground` is `--background`. Spacing uses 4, 8, 12, 16, 24, 32,
48, 64 px. Radius: 6 px controls, 8 px containers, dialogs and popovers.
Shadows only on overlays (dialog, popover, sheet, command palette, menus).

### Rules

1. Monochrome first. Colour only for state with meaning (impact, run state,
   environment health, validation, destructive action), always paired with a
   word and, where useful, a shape mark: ○ read only, ◐ changes data,
   ● deletes data.
2. No colour fields: no tinted panels or cards, highlighter marks, coloured
   side rails, stripes or tab tops. Warning and error callouts use a 1 px
   state-coloured border and a leading mark, no fill. Only the destructive
   action button is red.
3. One continuous canvas. Hierarchy from typography, spacing and alignment.
   A Card only where a real group needs a container (the operation form,
   dialogs). No cards inside cards.
4. Badges only for state (run state, impact, unavailable). Environment kind,
   feature group, field types, capabilities, "dry run" and "preset" are plain
   or mono text.
5. Icons (lucide-react) only where they speed recognition: search, close,
   chevrons, settings, copy, external link, upload, lock, sidebar toggle. No
   icon per navigation item or row, no icon tiles.
6. Stats as one strip (label, value, detail) without boxes.
7. Tables are semantic, full width of their section, text left-aligned,
   numbers and their headers right-aligned, cells baseline-aligned, feature
   groups as row groups rather than a repeated column.
8. Copy in sentence case, no all-caps or tracked labels, no em dashes in any
   user-facing string. No "→" on buttons; "↗" only for external links.
9. Prose at most 68 characters per line; sentences never at metadata size.
10. Stillness: no pulsing dots, spinners as decoration, gradients, glows or
    entrance animations. Motion only for state changes. Reduce motion (system
    or the Gauntlet preference) disables transitions.
11. One focal object per screen: overview = catalog, operation = form with its
    policy, run = outcome.
12. Accessibility: landmarks, one `h1` per screen, visible 2 px focus ring with
    2 px offset, labels on every control, WCAG AA contrast, never colour alone.

## Architecture

shadcn/ui is installed with its CLI: `components.json` (style new-york, base
colour neutral, Tailwind v4, CSS variables, alias `@/` to `src/`). New
dependencies: `radix-ui`, `class-variance-authority`, `clsx`,
`tailwind-merge`, `lucide-react`, `cmdk`, `@fontsource-variable/geist`,
`@fontsource-variable/geist-mono`; dev: `@axe-core/playwright`. Removed:
Manrope, JetBrains Mono, `Icon.tsx`, the hand-written primitives in `ui.tsx`
and the bespoke CSS in `index.css`.

Source layout under `apps/dashboard/src`:

- `components/ui/`: shadcn components as generated, edited only through the
  CLI or for token wiring. Expected: sidebar, button, badge, card, input,
  textarea, label, select, checkbox, switch, tabs, table, dialog, alert-dialog,
  command, sheet, dropdown-menu, popover, tooltip, progress, separator,
  skeleton, collapsible, scroll-area, alert, sonner.
- `components/gauntlet/`: Gauntlet composites built on `ui/`: `ImpactBadge`,
  `RunStateBadge`, `StateMark`, `PolicyList`, `StatStrip`, `ProblemAlert`,
  `ArtifactView` (one renderer per artifact kind), `OperationForm` (the JSON
  Schema / uiSchema renderer, logic preserved), `FollowUpList`,
  `RecentRunsList`.
- `app/`: `AppShell` (sidebar, header, breadcrumb), `EnvironmentSwitcher`,
  `CommandSearch`, `SettingsDialog` (Appearance and MCP tabs).
- `screens/`: `OverviewScreen`, `OperationScreen`, `RunView`.
- `widget/`: the panel, composed from the same components.

Theme: dark mode moves to shadcn's `.dark` class on `<html>`.
`preferences.ts` keeps its storage key, decoding and cross-tab sync; only
`applyPreferences` changes (toggle `.dark`, set `data-motion`).

## Screens

### Shell

shadcn Sidebar in the sidebar-07 arrangement:

- Header: Gauntlet mark and name, then the environment switcher
  (DropdownMenu) showing name, status word with mark, kind as text, and in the
  menu every environment with application, kind, status and "Refreshed 2 min
  ago".
- Content: Overview with the operation count; feature groups as labelled
  groups of operations without icons; unavailable operations disabled with
  "Unavailable".
- Footer: Settings and the version.
- Desktop collapse hides the sidebar completely (offcanvas; the collapsed
  preference persists). Mobile uses the Sheet variant.
- Top bar: sidebar trigger, breadcrumb `Environment / Group / Operation`, and
  a Search button showing ⌘K.

### Overview

- Title (environment label), a line with application, kind, status and
  refresh time, and a Refresh button that refetches `GET /api/v1/targets`.
- Stat strip: All operations, Ready to run, Need attention, with details such
  as "4 read only, 3 change data, 1 deletes data" (from loaded definitions;
  shown as "Loading details" until they arrive).
- Catalog table (the focal object): row groups per feature; columns
  Operation (label, id in mono), Impact (ImpactBadge), Before you run (policy
  summary such as "Dry run, can cancel, 2 presets"). A filter input above it
  matches label and id, with a "3 of 9" count and an empty state.
- Right column: Needs attention (diagnostics with severity and code,
  unavailable operations with advice), Your recent runs, the "Details first,
  then action" note, and collapsible Adapter capabilities as a mono list.
- States: loading skeleton, no environments configured, could not load
  environments (with Try again), environment unreachable.

### Operation

- Header: title, ImpactBadge, id in mono, description; the preset Select with
  its description and "This preset locks 2 fields." beside it.
- Left: "Fix the input" Alert for general errors, then the form in the one
  Card: tabs, groups, columns, conditional fields, required markers, help
  text, per-field errors, locked fields with a lock icon, file upload progress.
- Right: "What this operation does" (PolicyList) and the result area with its
  empty state.
- Sticky action bar: operation name and environment, Dry run when supported,
  and the main button labelled with the operation name. A destructive
  operation's button is red and opens an AlertDialog listing the policy
  effects.

### Run view

Shown in place of the result area after a run starts, and at the run URL.

- RunStateBadge for all eight states, run id in mono, relative start time,
  duration, "dry run", summary message, progress with phase and "3 of 8".
- Cancel when supported, otherwise the sentence saying it cannot be
  cancelled. Failure as ProblemAlert with title, advice and correlation id.
- Artifacts: notice, metrics, key-value, table, markdown, diff, timeline, log,
  download, link, browser-launch, JSON, and the unknown-kind fallback, without
  a card around each. Log, diff and JSON in code blocks on `--muted`.
- "What next" follow-ups (prefilled operation, external link ↗, browser
  launch) and Run again, which keeps the input.

### Run URL

New route `/t/:targetId/o/:operationId/r/:runId`. `route.ts` parses and
builds it. Opening it loads the operation definition and the run
(`GET …/runs/{runId}`), shows the run view and resumes polling, as the
operation screen does today, while the run is unfinished. Starting a run navigates to its URL with `replace`, so
reload and sharing work. A 404 shows "This run is no longer available" with a
link back to the operation.

### Recent runs

- `recent-runs.ts` key becomes `gauntlet.recent-runs.v1`, shared by the
  dashboard and the widget panel (same origin). The old
  `gauntlet.widget.recent.v1` key is not migrated.
- The dashboard records a run when it is created, like the widget does.
- Overview lists up to 10 runs for the current environment, newest first:
  operation label, relative time, live state. Only unfinished runs are
  polled. A run returning 404 shows "No longer available". Each entry links to
  its run URL.

### Command search

CommandDialog opened by the Search button or ⌘K / Ctrl K, with groups
Environments, Operations (unavailable ones disabled with "unavailable") and
Recent runs. Keyboard hints in the footer.

### Settings

Dialog with Tabs:

- Appearance: theme as three options (Light, Dark, System) with previews,
  Switches for Reduce motion and Collapsed navigation, the saved/not-saved
  status line, Restore defaults, Done.
- MCP: server URL input with validation ("Enter an HTTP or HTTPS URL ending in
  /mcp."), "Streamable HTTP" as text, the copyable client configuration, and
  the collapsible Server setup (Local, Compose, Helm).

### Widget panel

Header, back bar, operation lists, the operation and run screens, recent
runs and notices use the shared components. Handshake, placements, prefill
and bindings behaviour is unchanged.

## Copy

`copy.ts` keeps its functions and meaning, without em dashes, for example:

- "You can do a dry run first. You will see the result, but nothing will change."
- "Repeating with the same key is safe. It will not duplicate the effect."
- "One-time entry. Opening it uses up the link."
- `runButtonLabel` returns the operation label for every impact; the
  destructive styling and confirmation carry the warning.

## Testing

- Existing logic unit tests stay green.
- New unit tests: run route parse and build; recent-runs key; the "Before you
  run" policy summary; impact counts for the stat strip; no em dash in
  user-facing strings from `copy.ts`.
- Playwright suites rewritten for the new UI against the existing API
  fixture: navigation (desktop collapse, mobile sheet), overview filter and
  Refresh, form validation, presets with locked fields, tabs, dry run,
  destructive confirmation, run view with artifacts and follow-ups, reload on
  the run URL, recent runs, ⌘K, settings theme and MCP. Widget suite updated.
- `@axe-core/playwright` scan of overview, operation, run, search and
  settings in light and dark; no serious or critical violations.
- Manual screenshots compared with the mockup in both themes at 1440 and
  390 px.
- Widget panel bundle size recorded before and after; a large increase is
  reported before continuing.

## Release

- Work on `feat/dashboard-shadcn`, branched from `origin/main` (0.1.7).
- Update `apps/dashboard/README.md`, `docs/user-guide.md`,
  `docs/reference/repository.md` (source map), `docs/integrations/widget.md`
  (recent-runs key) and `docs/mockups/README.md`.
- CHANGELOG 0.1.8: redesigned dashboard on shadcn/ui, run URLs, recent runs in
  the dashboard, shared recent-runs storage key.
- Prepare the release with `docs/releases/releasing.md`
  (`release:version`, `release:dry-run`). Tagging and publishing happen only
  after explicit approval.
