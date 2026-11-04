# Changelog: `skills`

All notable changes to `gauntlet-skills` are recorded here in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. Versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html); before 1.0 a breaking change is a minor
release. Released versions are immutable; a correction is a new version.

Releases up to 0.1.8 were published together with the application and are recorded in the
[root changelog](../CHANGELOG.md).

## Unreleased

## [0.2.0] - 2026-11-04

### Changed

- Every protocol profile, capability, conformance format and idempotency key now uses the `gauntlet-` prefix instead of the legacy `tc-` prefix, with no aliases for the old names, `TcSchemaCore` is now `GauntletSchemaCore` in PHP and Java, and `assertTcSchemaCore` is now `assertGauntletSchemaCore` in `@8lines/gauntlet-protocol`.
- Updated `protocol` to 0.2.0.
- Updated `gauntlet` to 0.3.0.
- Updated `typescript-core` to 0.2.0.
- Updated `typescript-node` to 0.2.0.
- Updated `next-adapter` to 0.1.9.
- Updated `php-core` to 0.2.0.
- Updated `symfony-bundle` to 0.2.0.
- Updated `java-core` to 0.3.0.
- Updated `spring-boot-starter` to 0.3.0.

### Upgrade

- This version has required upgrade steps; follow the [upgrade guide](https://github.com/8lines/gauntlet/blob/skills-v0.2.0/docs/upgrades/skills/0.2.0.md).

## [0.1.17] - 2026-11-04

### Changed

- The Java packages moved to Maven Central under the group `dev.8lines.gauntlet`, so they need no token and no extra repository.
- Updated `java-core` to 0.2.0.
- Updated `spring-boot-starter` to 0.2.0.

### Upgrade

- This version has required upgrade steps; follow the [upgrade guide](https://github.com/8lines/gauntlet/blob/skills-v0.1.17/docs/upgrades/skills/0.1.17.md).

## [0.1.16] - 2026-11-03

### Changed

- Updated `gauntlet` to 0.2.5.

## [0.1.15] - 2026-11-03

### Changed

- Updated `gauntlet` to 0.2.4.
- Updated `symfony-bundle` to 0.1.9.

## [0.1.14] - 2026-10-12

### Changed

- Updated `gauntlet` to 0.2.3.

## [0.1.13] - 2026-10-12

### Changed

- Updated `gauntlet` to 0.2.2.

## [0.1.12] - 2026-10-07

### Added

- The `gauntlet-upgrade` skill upgrades a Gauntlet deployment or SDK package by walking every upgrade guide from the deployed version to the target, backing up operator files and data first, pinning exact versions and finishing with the upgrade runbook's verification.

### Changed

- Updated `gauntlet` to 0.2.1.

## [0.1.11] - 2026-10-04

### Changed

- Updated `gauntlet` to 0.2.0.

## [0.1.10] - 2026-10-04

### Changed

- Updated `gauntlet` to 0.1.9.

## [0.1.9] - 2026-10-04

### Changed

- The integration skill tells agents to install each package's own released version instead of one shared version for every package.
