# Changelog: `protocol`

All notable changes to `@8lines/gauntlet-protocol` are recorded here in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. Versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html); before 1.0 a breaking change is a minor
release. Released versions are immutable; a correction is a new version.

Releases up to 0.1.8 were published together with the application and are recorded in the
[root changelog](../../CHANGELOG.md).

## Unreleased

## [0.2.0] - 2026-11-04

### Changed

- Every protocol profile, capability, conformance format and idempotency key now uses the `gauntlet-` prefix instead of the legacy `tc-` prefix, with no aliases for the old names, `TcSchemaCore` is now `GauntletSchemaCore` in PHP and Java, and `assertTcSchemaCore` is now `assertGauntletSchemaCore` in `@8lines/gauntlet-protocol`.

### Upgrade

- This version has required upgrade steps; follow the [upgrade guide](https://github.com/8lines/gauntlet/blob/protocol-v0.2.0/docs/upgrades/protocol/0.2.0.md).
