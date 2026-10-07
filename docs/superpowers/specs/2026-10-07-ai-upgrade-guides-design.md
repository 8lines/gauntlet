# AI upgrade guides

Every released version of every unit gets an upgrade guide that an AI agent (or a person) can follow step by step: what changed, what the operator must or may change in the deployment (environment variables, Helm values, Compose files, configuration), and how to verify the result. A new skill, `gauntlet-upgrade`, teaches an agent to walk those guides from the deployed version to the target version.

## Change files

A change file may carry upgrade steps for operators. They live in an optional `## Upgrade` section after the changelog sentence, and the front matter names how much they matter:

```md
---
type: added
units:
  gauntlet: patch
upgrade: optional      # required | optional
---
You can pin the operations you use often...

## Upgrade

Set `GAUNTLET_DATA_DIR` to keep pins across restarts...
```

- `upgrade` is present exactly when the `## Upgrade` section is present.
- `required`: the deployment breaks or loses data without the step (a renamed variable, a removed value, a manual migration). `optional`: the deployment keeps working, and the step enables or keeps a feature (a new variable with a safe default).
- The section is Markdown, at most 8000 characters, without em dashes. Steps name the exact variable, value or file, its default, and which distributions they apply to (Compose, Helm, source).
- The changelog sentence keeps its rules (one paragraph, sentence case, at most 1000 characters).

## Operator surface guard

`pnpm release:changes --check` also fails when a pull request adds an operator setting without upgrade steps naming it:

- a new `GAUNTLET_*` row in the environment table of `apps/server/README.md` (the documented registry of server environment variables, already checked against the server source by `apps/server/test/config-schema.test.ts`);
- a new top-level key in `deploy/helm/gauntlet/values.yaml`.

Each new name must appear in the `## Upgrade` section of a change file added or edited in the same pull request. A setting that needs no operator action still gets a one-line `optional` step that says so, so the guide states it explicitly.

## Guides

`pnpm release:prepare` writes `docs/upgrades/<unit>/<version>.md` for every released unit, including units released only because a dependency moved and units without upgrade steps, so the guides of a unit form an unbroken chain:

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

- Added: ...
- Changed: ...

## Steps

### Pinned operations (optional)

...

## Verify

Follow the [upgrade runbook](../../releases/upgrading.md#verify).
```

- `action` is the strongest action of the version: `required`, then `optional`, then `none`. With `none` the Steps section says "No action is required."
- Each step heading is the change file name in sentence case, with its action.
- The guide is rendered and validated before anything is written, like the changelogs, and is part of the all-or-nothing restore. A guide that already exists refuses preparation.
- When the action is not `none`, the unit's changelog section gets an `### Upgrade` subsection with one bullet linking the guide at the unit's release tag, so the GitHub release notes point at it.
- `docs/upgrades/README.md` (hand-written) explains the format and the walk: list the guides whose `to` is after the deployed version and at most the target version, apply them oldest first, never skip a `required` step.

Gauntlet 0.2.0 introduced authentication; its guide is written by hand once, so an upgrade from 0.1.x has a starting point. Versions before 0.2.0 have no guides; their changelog is the source.

## Skill

`skills/gauntlet-upgrade` (released with the `skills` unit) is used when upgrading an existing Gauntlet deployment or SDK package to a newer version. It requires the agent to:

- establish the deployed version and distribution (Compose wrapper, Helm chart, or source) from the deployment itself, not from memory;
- read every guide between the deployed and target versions, from the repository at the target's release tag;
- apply every `required` step and decide each `optional` step explicitly, editing the operator's real files (Compose `.env`, Helm values) instead of inventing new ones;
- pin exact versions, keep one replica, keep the private boundary, back up operator-owned files and data before replacing anything, and stop for rollback instead of deleting data when verification fails;
- finish with the upgrade runbook's verification and report what was applied and skipped.

The skill has an evaluation suite in `skill-evals/gauntlet-upgrade` with the same protocol as the existing skills: synthetic fixtures, pressure scenarios with five samples each, a valid scenario, a forward scenario, baseline without the skill, guided and forward with it, and a minted `verification.json`.

## Release

Change files: the tooling and guides need none for a unit (release scripts and docs are not released paths); the skill is `added`, `skills: patch`.
