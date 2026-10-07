# Operation Studio Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement inline.

**Goal:** Full-width operation studio with accessible responsive details and contained dialog actions.

**Architecture:** OperationScreen owns the working columns and panel visibility. OperationDetails owns contextual sections and filtered run history, reusing existing state polling and routing. Dialog primitives handle wrapping centrally.

**Tech Stack:** React 19, Radix UI, Tailwind 4, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-07-operation-studio-design.md`

## Global Constraints

- Preserve existing design tokens, run semantics and embedded-widget navigation.
- History is browser-local and filtered by target id and operation id.
- Do not infer a source file path absent from the protocol.
- Desktop sidebar is 320px at viewport widths >=1280px; columns split at workspace widths >=640px.

## Review Focus

- Long labels and revision hashes must not cause horizontal overflow.
- Closed panels must not retain keyboard focus or keep hidden run polling alive.
- History links must preserve current input and use the correct target.
- Resizing must close the mobile sheet when the desktop panel becomes available.
- Widget run navigation must remain inside its iframe.

### Task 1: Studio and dialog containment

**Files:** OperationScreen.tsx, new OperationDetails.tsx, OperationLoading.tsx, App.tsx, widget/Panel.tsx, ui/alert-dialog.tsx, ui/dialog.tsx, new e2e/operation-studio.spec.ts.

**Interfaces:** OperationDetails consumes OperationDefinition, targetId, environment, recentRunsVersion, currentRunId and optional onOpenRun(RecentRun). OperationScreen adds recentRunsVersion and optional onOpenRecentRun(RecentRun), forwarded by dashboard and widget respectively.

- [x] Add tests for full-width equal columns and collapse without resetting input, mobile sheet focus, matching history navigation and long dialog labels across widths.
- [x] Run the new tests against the current build and confirm failures caused by the missing studio/overflow.
- [x] Implement responsive studio, detail sections, history integration, matching loading state and shared dialog wrapping.
- [x] Build dashboard and widget; run unit tests and dashboard/widget browser suites.
- [x] Inspect desktop/mobile test screenshots and responsive geometry checks; review the diff.

## Verification record

- Dashboard/widget production builds and dashboard typechecking passed.
- Dashboard unit suite: 133 passing tests.
- Dashboard browser suite: 98 passing tests, 16 skips from project-specific scenarios.
- Widget browser suite: 11 passing tests, including compact stacked layout.
- Independent review identified a short-screen header overflow. A new test reproduced actions ending at 478px in a 360px viewport; bounding the title and id fixed it.
- Collaborative preview could not reach the local dev server (chrome-error page). Visual inspection used screenshots produced by the browser regression tests.
- History links close the mobile sheet after navigation; form values survive panel collapse and history navigation.
