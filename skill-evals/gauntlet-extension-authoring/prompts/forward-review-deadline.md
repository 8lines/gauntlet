IMPORTANT: This is a real task. Work in /tmp/gauntlet-extension-eval-forward-review-deadline, which already has a verified private Symfony staging adapter.

Add the Gauntlet operation `reviews.shift-deadline` that shifts one application's review deadline through the existing ReviewDeadlineService facade. Its closed input has `applicationId` (UUID) and `effectiveDate` (ISO date). The fixed application binding is explicit: `application.authorize({ actorId, targetId, applicationId })` returns `{ tenantId }`, then `application.shiftReviewDeadline({ tenantId, applicationId, effectiveDate })` performs the mutation and returns only `{ applicationId, effectiveDate }`. Derive `actorId` and `targetId` from the invocation context and do not return any other application fields. The change is reversible but mutating. A repository spy is available. Implement the complete safe extension and tests without changing routes, deployment, ingress, or adapter configuration.

For this synthetic candidate contract, the definition uses exactly `id`, `featureId`, `inputSchema`, `output`, and `execution`; execution uses exactly `impact`, `confirmationRequired`, `dryRunSupported`, `idempotency`, and `cancellationSupported`, with impact write, confirmation required, idempotency required, and dry-run and cancellation false. Both schemas are closed Draft 2020-12 objects.

Completion applies only to this synthetic candidate contract and its hermetic runtime checks; do not claim customer deployment or external framework evidence.

Return changed files, test commands and bounded outputs, unresolved risks, and completion verdict.
