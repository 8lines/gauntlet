---
type: changed
upgrade: required
units:
  gauntlet: minor
  protocol: minor
  dashboard-client: minor
  typescript-core: minor
  typescript-node: minor
  conformance-runner: minor
  php-core: minor
  symfony-bundle: minor
  java-core: minor
  spring-boot-starter: minor
  skills: minor
---
Every protocol profile, capability, conformance format and idempotency key now uses the `gauntlet-` prefix instead of the legacy `tc-` prefix, with no aliases for the old names, `TcSchemaCore` is now `GauntletSchemaCore` in PHP and Java, and `assertTcSchemaCore` is now `assertGauntletSchemaCore` in `@8lines/gauntlet-protocol`.

## Upgrade

This is a breaking rename with no compatibility aliases. Upgrade the Gauntlet application and every adapter together: the protocol stays at major 1, so the version check does not reject a mismatch, and a mixed pair fails on unknown profiles and capabilities instead. This applies to Compose, Helm and source deployments.

Replace these identifiers wherever your application names them, for example in `ProtocolRequirements`, the Spring `gauntlet.profiles` list, or custom capability providers:

- `tc-schema-core@1` becomes `gauntlet-schema-core@1`
- `tc-rich-forms@1` becomes `gauntlet-rich-forms@1`
- `tc-rich-results@1` becomes `gauntlet-rich-results@1`
- `tc-uploads@1` becomes `gauntlet-uploads@1`
- `tc-run-cancellation@1` becomes `gauntlet-run-cancellation@1`
- `tc-run-sse@1` becomes `gauntlet-run-sse@1`
- `tc-session-launch@1` becomes `gauntlet-session-launch@1`

Replace `TcSchemaCore` with `GauntletSchemaCore` in PHP and Java code that imports it, and `assertTcSchemaCore` with `assertGauntletSchemaCore` in TypeScript code.

Revisions are computed from definition content, so every `operationRevision` and `manifestRevision` that contains one of these identifiers changes. Regenerate any revision you pinned in application fixtures or tests. Runs already stored keep their old revision.

The idempotency key prefix is now `gauntlet-idempotency:v1`, which also changes the stored fingerprint. A client that retries with an existing `Idempotency-Key` after the upgrade starts a new run instead of finding the earlier one, so let in-flight retries finish first.

Error `correlationId` values from the Symfony and Spring adapters now start with `gauntlet-`. Update any log query that matches the `tc-` prefix.

If a trusted ingress strips client-supplied `X-TC-*` headers, change that rule to `X-Gauntlet-*`.
