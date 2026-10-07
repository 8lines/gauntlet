# Upgrade guides

## Deployment evidence

Establish three facts before reading a guide: the release unit, the deployed version, and the distribution. Write down where each fact came from.

| Distribution | Unit | Evidence of the deployed version |
| --- | --- | --- |
| Compose wrapper | `gauntlet` | `GAUNTLET_IMAGE` in the installed `.env`, confirmed by `./gauntlet ps` and the running container's image tag or digest |
| Helm chart | `gauntlet` | `helm list` and `helm history` (chart `gauntlet-<version>`), `helm get values --all`, and the running Pod's image |
| Source checkout | `gauntlet` | `git describe --tags` of the checkout that actually runs, plus its `VERSION` file |
| Application SDK | its package unit | the lockfile entry (`pnpm-lock.yaml`, `composer.lock`, `gradle.lockfile`), not the manifest range |

The running deployment wins over a file that names a different version. When they disagree (for example `.env` names a newer tag than the container runs), the deployed version is what runs; report the drift and do not assume the newer file was ever applied. A version stated in a request, ticket, or memory is only a claim until the deployment confirms it.

## Finding the chain

1. Name the target version and its release tag: `v<version>` for the `gauntlet` unit, `<unit>-v<version>` for every other unit (for example `typescript-node-v<version>` or `symfony-bundle-v<version>`).
2. Read guides from the repository at that tag, for example `https://raw.githubusercontent.com/8lines/gauntlet/v<target>/docs/upgrades/gauntlet/<version>.md`, or `git show v<target>:docs/upgrades/gauntlet/<version>.md` in a checkout. Do not read guides from `main` or another branch. When a task supplies local copies that stand in for the tag, read those.
3. List `docs/upgrades/<unit>/` at the tag and select every version after the deployed version and at most the target. Sort them by semantic version, oldest first.
4. Check the chain: the first guide's `from` is the deployed version, and each later `from` equals the previous `to`. A gap or mismatch means a guide is missing or you misread the deployed version: stop and report it rather than guess.
5. Guides exist from gauntlet 0.2.0 on. For a deployment before 0.2.0, read every `CHANGELOG.md` section after the deployed version at the target tag (the unit's own changelog for non-`gauntlet` units), then walk the guides from 0.2.0. The 0.2.0 guide is the starting point for an upgrade from 0.1.x.

`docs/upgrades/README.md` at the target tag describes the same walk; read it when the format looks different from the one below.

## Guide format

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

- `action` is the strongest action of that version alone: `required`, then `optional`, then `none`. With `none` the Steps section says "No action is required."
- Each change with operator work has one `### <Title> (<action>)` heading under Steps. A step names the exact variable, value, or file, its default, and the distributions it applies to.
- Verify points to the upgrade runbook; follow it after the last guide.

## Applying steps

- **Required:** the deployment breaks or loses data without it (a renamed variable, a removed value, a manual migration). Apply it exactly as written for your distribution. A rename moves the existing value to the new name and removes the old name.
- **Optional:** the deployment keeps working without it. Decide: apply it when it serves the purpose of this upgrade or the operator's stated goal, or skip it with a concrete reason. Silence is not a decision.
- A step that names only another distribution does not apply; record it as not applicable with that reason.
- Apply steps in guide order. When a later guide changes a value an earlier guide introduced, the end state follows the later guide, but the earlier step still counts as applied.
- A guide with `none` still counts as read; list it.
- Never skip a required step because the newest guide says `optional` or `none`, because the tag change looks small, or because a deadline is close.

Record each step as `<version>: <title>` with its decision so the report can list applied and skipped steps exactly.
