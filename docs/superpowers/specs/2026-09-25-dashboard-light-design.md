# Gauntlet — light dashboard redesign

The supplied Academy/shadcn screenshot is the visual reference authorized by the user. Use a neutral light gray application shell, a matching sidebar with outline icons, a quiet top toolbar, and a large white workspace with a thin border and rounded corners. Violet (#6f63e6) identifies primary actions, selection and the brand; semantic success/warning/error colors remain distinct.

All surfaces use one semantic radius scale defined in the Tailwind theme: `badge` 4px, `control` 8px, `card` 12px, `surface` 16px. Circular status indicators, brand marks and switch tracks retain their circular/pill shape. Use the same scale on mobile and in both themes. Cards share `.surface-card` for radius, border, background and shadow. Shadows are named by role (control/card/overlay/dialog); quiet interactive controls share the accent hover color. Form and preference switches share `.switch-track` and `.switch-thumb`.

Apply this system across the environment overview, operation forms, run artifacts, empty/error/loading states and confirmation dialogs. Preserve the existing API, routes, confirmation rules, uploads, polling and follow-up actions. Typography uses locally hosted Inter with JetBrains Mono limited to machine values. The top toolbar and sidebar brand row are 56px tall. The header and workspace share their horizontal margins through layout variables, with no extra desktop toolbar padding. With desktop navigation collapsed, both have equal 24px side gutters. Both have 16px gutters on tablets; the mobile toolbar retains 12px padding for touch controls.

The overview presents real manifest counts and grouped operation links. Navigation supports a desktop collapse control and the existing mobile drawer. A searchable command dialog opens from the toolbar or Cmd/Ctrl+K, searches loaded environments and operations, and respects operation availability. Only expose functional controls; do not add placeholder account fields or notifications.

Environment selection and status live in a toolbar dropdown, including application, environment kind and last refresh. Remove their duplicate sidebar sections and overview information card. Sidebar operations show their actual impact and confirmation requirement, loaded from revision-matched definitions with bounded concurrency and an explicit unavailable fallback. The profile button's right edge aligns with the workspace edge on desktop.

Mobile layouts retain 44px touch targets, stacked operation actions, contained result scrolling and keyboard focus handling. Verify the production build, existing dashboard unit/browser suites, command search, sidebar collapse, overview navigation and screenshots at desktop/mobile sizes.

Operation actions remain in a white footer pinned to the workspace bottom, separated by a thin border. Only the operation content scrolls; the footer reserves its own height, adapts to collapsed navigation, stacks buttons on mobile and respects the bottom safe area.

User settings are available from the user icon in the header. A native modal keeps the operation mounted while the user chooses light (default), dark or system theme, reduced motion, and collapsed desktop navigation. Preferences use versioned browser storage, tolerate unavailable or invalid storage, synchronize across tabs and include a reset to defaults. System appearance changes are reflected live; system reduced-motion preferences are always respected. All surfaces use shared theme tokens, including dialogs, inputs, results and the pinned action footer.

## Consistency audit

The header and sidebar brand row share `--app-header-height`. Breadcrumbs, page headings, page bodies and the action footer share `--page-inset`. Buttons, fields and toolbar controls share `--control-height` (40px desktop, 44px mobile). Dialog surfaces share their radius, border, shadow, backdrop and viewport limit; scrollable dialog content reserves space for the header and footer.

The action footer responds to the actual workspace width using a container query. Its buttons can wrap long labels and remain inside the footer with either sidebar state. The search trigger also responds to available toolbar width, using an icon when its label and keyboard shortcut would become cramped. Breadcrumbs stay on one line, with full labels retained in accessible names and title attributes.

Verified in Chrome with desktop/mobile browser suites, a 320/390/640/768/1024/1280/1440px width matrix, long operation and environment labels, 360px-tall dialogs, light/dark themes and screenshots from the local fixture application. Production build, 29 unit tests and 24 browser cases pass; six browser cases are intentionally skipped for the inapplicable viewport project. No Safari or Firefox verification was performed.
