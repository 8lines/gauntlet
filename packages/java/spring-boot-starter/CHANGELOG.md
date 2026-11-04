# Changelog: `spring-boot-starter`

All notable changes to `dev.8lines.gauntlet:spring-boot-starter` are recorded here in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. Versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html); before 1.0 a breaking change is a minor
release. Released versions are immutable; a correction is a new version.

Releases up to 0.1.8 were published together with the application and are recorded in the
[root changelog](../../../CHANGELOG.md).

## Unreleased

## [0.3.0] - 2026-11-04

### Changed

- Every protocol profile, capability, conformance format and idempotency key now uses the `gauntlet-` prefix instead of the legacy `tc-` prefix, with no aliases for the old names, `TcSchemaCore` is now `GauntletSchemaCore` in PHP and Java, and `assertTcSchemaCore` is now `assertGauntletSchemaCore` in `@8lines/gauntlet-protocol`.
- Updated `java-core` to 0.3.0.

### Upgrade

- This version has required upgrade steps; follow the [upgrade guide](https://github.com/8lines/gauntlet/blob/spring-boot-starter-v0.3.0/docs/upgrades/spring-boot-starter/0.3.0.md).

## [0.2.0] - 2026-11-04

### Changed

- The Java packages moved to Maven Central under the group `dev.8lines.gauntlet`, so they need no token and no extra repository.
- Updated `java-core` to 0.2.0.

### Upgrade

- This version has required upgrade steps; follow the [upgrade guide](https://github.com/8lines/gauntlet/blob/spring-boot-starter-v0.2.0/docs/upgrades/spring-boot-starter/0.2.0.md).
