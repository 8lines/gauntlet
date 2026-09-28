# Rollback runbook

Rollback restores the preceding Gauntlet software/configuration pair. It
does not undo domain mutations already performed by target applications and it
cannot restore the control plane's in-memory run history.

## When to roll back

Use rollback for a control-plane, dashboard, packaging, or compatibility
regression after installation. If the actual environment might be production,
an adapter became public, or target identity is uncertain, disable access first
and treat the event as a safety incident rather than relying on rollback.

## Procedure

1. Stop new tester activity and preserve bounded logs and the candidate's exact
   artifact identities.
2. Restore the preceding reviewed operator configuration only if configuration
   changed; never reconstruct it from logs.
3. Select the preceding immutable image digest and matching Compose bundle or
   Helm chart archive.
4. Preview the effective model. Confirm one replica, the correct non-production
   environment, private binding/Ingress, and unchanged adapter origins.
5. Apply the normal distribution-specific recreate command:
   [Compose rollback](../../deploy/compose/README.md#rollback) or
   [Helm rollback guidance](../../deploy/helm/README.md#rollback).
6. Repeat readiness, exact target-environment, disabled/mismatch, public-route,
   and representative-operation checks from the upgrade runbook.

Do not delete the failed release tag or overwrite a registry version. Keep the
evidence, fix forward with a new semantic version, and document any target-side
domain recovery separately.

## Target application rollback

An SDK rollback is an application release and must use that application's own
deployment and database compatibility policy. The Adapter v1 conformance suite
must pass for the final combination. If the preceding application version does
not understand the current Gauntlet contract, leave its adapter disabled
rather than exposing a partially compatible transport.
