# Using Gauntlet

Gauntlet shows the actions that your applications explicitly expose. The
available operations, input fields and results depend on the connected
application. This guide assumes an operator has already provided your private
dashboard address; see [getting started](getting-started.md) for installation.

## Navigate the dashboard

- **Sidebar.** Lists the selected environment's features and operations.
  On narrow screens it opens from the navigation button in the header.
- **Environment switcher.** At the top of the sidebar; choose another
  application (target) and see its status and when it was last refreshed.
- **Search.** Press <kbd>⌘ K</kbd> (<kbd>Ctrl K</kbd> on Windows and Linux) or
  use the header search to jump to an environment, an operation or one of your
  recent runs.
- **Settings.** The Settings entry at the bottom of the sidebar holds
  appearance preferences and the MCP connection details.

## Choose an application and operation

Check the environment before doing anything. Select an application (called a
*target*), then choose an operation from its feature group. For example, a
Payments feature might contain an operation for creating a test invoice.

Only compatible online targets can execute operations. An unavailable target
can still show its last-known catalog. A visible operation can also be
unavailable because the application disabled it or requires unsupported features.

Read the description and impact before entering data:

| Impact | What it means |
| --- | --- |
| Read | The operation is declared to read data. |
| Write | The operation can change application state. |
| Destructive | The operation may delete or irreversibly change data. |

These declarations come from the application. Use operations only for work you
are authorized to perform.

The environment overview shows the catalog as a table with each operation's
impact and what to expect before running it. Use **Filter operations** to
narrow the list, and **Refresh** to reload the environment's definitions from
its application. Run buttons carry the operation's name for every impact;
destructive operations are marked by colour and ask for confirmation.

## Fill in the form

The form is generated from the operation definition. Required fields, validation
rules, default presets and dependent field choices are supplied by the application.

- A preset fills common values; locked preset values cannot be changed.
- Searchable fields use the application's declared data sources. Other fields
  may need to be filled first so the application can return relevant choices.
- File fields upload a file and pass an expiring reference to the operation.
  Respect the displayed type and size requirements.
- Secret fields have special retention rules. Avoid putting passwords or
  tokens into ordinary text fields, notes or descriptions.

If validation fails, correct the indicated fields and submit again. If an
operation changes while you are filling the form, reload its current definition
and review any changed fields and execution policy.

## Review and run

Use dry-run mode only when the operation supports it. Dry run is an
application-implemented preview, not a universal undo mechanism. An operation
may still require confirmation for a dry run.

Review any confirmation, then submit once. Confirmation prevents accidental
execution; it is not a login or authorization step. If the network interrupts
after submission, check whether a run was accepted before submitting new work.
For API or AI clients, reuse the original idempotency key when retrying an
uncertain invocation.

## Follow the result

| Run state | Meaning |
| --- | --- |
| `queued` | Accepted and waiting for execution. |
| `running` | Application code is executing. |
| `succeeded` | Finished successfully. Inspect its output and artifacts. |
| `failed` | Finished with an error. Inspect the reported Problem. |
| `cancelled` | Cancellation ended the run; completed side effects may remain. |
| `partial` | Finished with only part of the intended result; inspect its Problem and artifacts. |
| `expired` | The run has expired according to the adapter lifecycle. |
| `timed_out` | The execution deadline was reached; completed side effects may remain. |

Progress, logs, warnings, result tables and artifacts are operation-specific.
Follow-up actions can launch another operation or open a result. Review them
as separate actions. A browser-session launch may assume a test user's role
and returns a short-lived link; request a fresh launch if it expires.

Use cancellation when the operation supports it. Cancellation asks application
code to stop cooperatively. Closing a tab or disconnecting an AI client does
not cancel the application run, and cancellation does not roll back changes.

## Run URLs and recent runs

Every run has its own address, `/t/<target>/o/<operation>/r/<run>`, so a result
can be reloaded, shared with a colleague who uses the same Gauntlet server and
reopened later. Run history is held in the Gauntlet server's memory; a link to a
run that the server no longer has shows "This run is no longer available".

The environment overview and search list your recent runs. They are stored in
this browser only, so they do not follow you to another browser or device. The
embedded widget shares the list when the application that embeds it and
Gauntlet are on the same site; browsers that partition third-party storage
keep a separate list in the widget.

## History and AI clients

Dashboard and MCP calls share the same server-side run projections. They are
stored in memory: restarting Gauntlet loses that history. Application runs
and their effects have a separate lifecycle; lost history does not mean the
application rolled back the work.

An AI client can use the same catalog through [MCP](mcp.md). It must inspect the
operation definition, follow its input and execution requirements, and poll
accepted runs before reporting completion. Application descriptions and results
do not authorize the AI to take further actions.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Dashboard cannot be reached | Verify the private URL, tunnel/VPN and server status. Ask the operator rather than publishing a port. |
| Server is ready but a target is offline | The server can start independently of adapters. Check adapter enablement, its private hostname, port and network connection. |
| Target is incompatible or reports environment mismatch | Ask the operator to compare the actual application environment with `expectedEnvironment`. Do not relabel production to bypass the check. |
| Operation is missing or unavailable | Confirm that the application registered and enabled it, and that its required profiles/capabilities are supported. |
| Stale operation revision | Reload the definition, review the changes and submit using the current revision. |
| Operation is busy or queued | Another invocation may hold the execution slot. Wait or inspect that run before retrying. |
| Upload is rejected or expired | Check the file's type/size and obtain a fresh upload reference. MCP also has a JSON body limit. |
| Run failed or timed out | Read the reported Problem and ask the application owner whether any domain recovery is needed. |
| Run history disappeared | Check whether Gauntlet restarted. Its projection history is currently in memory. |
| MCP URL returns 404 | Verify MCP is enabled and the URL ends in `/mcp` on the control-plane listener. |
| MCP request returns 403 | A supplied Origin must match the configured allow-list. See the MCP access settings. |

[Get started](getting-started.md) · [MCP](mcp.md) · [Technical run lifecycle](reference/run-lifecycle.md) · [Documentation index](README.md)
