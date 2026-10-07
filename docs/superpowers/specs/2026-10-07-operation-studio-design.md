# Operation studio

The operation workspace fills the available dashboard width. A compact header contains the operation label, impact, id and a Details toggle. The title displays at most two lines and the id one line, with full values available in their titles and in Details; long labels must not push the form or actions outside short viewports. Presets belong with Input. Input and Result are equal columns when the workspace has at least 640px; they stack below that width.

Details is a 320px right sidebar on desktop (viewport at least 1280px), open initially and collapsible without changing form or run state. On smaller screens the same content opens in a focus-managed sheet. Its independently collapsible sections contain the description and execution policy, recent runs for this target and operation, and definition metadata/JSON. Long content scrolls within the panel, rather than growing the header. History uses existing browser storage and its missing-run/polling behavior; it is not a server-wide audit log. Source file locations are not part of the current protocol, so no path is inferred.

The embedded widget has no details sidebar or sheet. Below the header, "What this operation does" (description and execution policy) starts collapsed, followed by two tabs: Run (Input, Result and the operation's recent runs, stacked) and Advanced (definition metadata including the revision, and the definition JSON). The Run tab stays mounted while Advanced is shown, so switching tabs never resets the form. Recent runs open inside the panel.

In the widget lists each operation shows its impact badge next to the label (or "Unavailable"), its description clamped to two lines, and an icon-only "Open in Gauntlet" link. The panel caches the last target snapshot and the operation definitions in `localStorage` (`gauntlet.catalog-cache.v1`): a new panel shows the cached lists at once while it refreshes, and a definition is reused only while its revision equals the manifest's. Opening an operation (widget or dashboard) uses the cached definition at the manifest's revision instead of reading it again. Signing out clears the cache. On the server, discovery and operation reads reuse a target's last online snapshot for five seconds and read each definition once per revision (see docs/reference/control-plane-api.md).

All run creation, confirmation, presets, validation, uploads and result interactions retain their existing semantics.

Shared dialog footers allow buttons to wrap their labels and grow vertically. Dialogs remain bounded by the viewport and scroll vertically; no label is clipped horizontally. Existing design tokens, Geist typography and impact colors remain in use.

Verification covers desktop expansion/collapse, mobile sheet focus, history filtering and navigation, newly created runs, long confirmation labels, short viewports, existing dashboard and widget flows, typechecking and builds.
