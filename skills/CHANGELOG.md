# Changelog: `skills`

All notable changes to `gauntlet-skills` are recorded here in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. Versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html); before 1.0 a breaking change is a minor
release. Released versions are immutable; a correction is a new version.

Releases up to 0.1.8 were published together with the application and are recorded in the
[root changelog](../CHANGELOG.md).

## Unreleased

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
