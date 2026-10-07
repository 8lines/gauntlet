# Upgrade guides

Every released version of every release unit has an upgrade guide,
`docs/upgrades/<unit>/<version>.md`. It lists what changed and what an operator
must or may change in a deployment when moving to that version from the one
before it: environment variables, Helm values, Compose files, configuration and
data. The guides are written for people and for AI agents; the
[`gauntlet-upgrade` skill](../ai-skills.md) follows them.

## Format

```md
---
unit: gauntlet
from: 0.2.0
to: 0.2.1
date: 2026-10-07
action: optional
---
# Upgrade `gauntlet` from 0.2.0 to 0.2.1

## Changes

## Steps

### Pinned operations (optional)

## Verify
```

- `unit` is the release unit (see [release units](../releases/releasing.md#release-units)),
  `from` the previous version and `to` the version the guide upgrades to. The
  guides of a unit form a chain through `from`.
- `action` is the strongest step of the version: `required` (the deployment
  breaks or loses data without it), `optional` (the deployment keeps working;
  the step enables or keeps a feature) or `none`.
- **Changes** repeats the changelog entries of the version.
- **Steps** holds one subsection per change with upgrade steps, required steps
  first, each naming the exact variable, value or file, its default and the
  distributions it applies to. Without steps it says "No action is required."
- **Verify** says how to check the result.

`pnpm release:prepare` writes the guides from the `## Upgrade` sections of the
change files (see [CONTRIBUTING.md](../../CONTRIBUTING.md#upgrade-steps)), and
links a guide with steps from the version's changelog section and GitHub
release notes. Guides are never edited after their release; a correction is a
note in a later guide.

## Upgrading with the guides

1. Establish the deployed version from the deployment itself: the image tag or
   digest in the Compose `.env` (`GAUNTLET_IMAGE`) or the Helm release
   (`helm list`, `image.tag`), or the package versions in an application's
   lockfile.
2. Read the guides whose `to` is after the deployed version and at most the
   target version, oldest first, from the repository at the target's release
   tag: `v<version>` for `gauntlet`, `<unit>-v<version>` for every other unit,
   for example
   `https://github.com/8lines/gauntlet/blob/v0.2.1/docs/upgrades/gauntlet/0.2.1.md`.
3. Apply every `required` step. Decide every `optional` step explicitly and
   record why a skipped step was skipped. Edit the deployment's real operator
   files (the installed Compose `.env` and `config.yaml`, the complete Helm
   values file) rather than creating new ones.
4. Upgrade with the exact version, never a floating tag, following the
   [upgrade runbook](../releases/upgrading.md), and finish with its
   verification.

Guides start with `gauntlet` 0.2.0 and, for every other unit, with the first
version released after 0.2.0. For earlier versions read the unit's
`CHANGELOG.md`.
