---
name: gauntlet-upgrade
description: Use when upgrading an existing Gauntlet deployment (Docker Compose wrapper, Helm chart, or source checkout) or a Gauntlet SDK package to a newer version, or when asked to bump, pin, float, or scale a Gauntlet image, chart, or package during an upgrade.
---

# Upgrading Gauntlet

## Core Principle

An upgrade is the ordered walk through every upgrade guide between the deployed version and the target, applied to the operator's real files, with backups taken before anything is replaced and the runbook's verification at the end. Pressure to stay current, avoid downtime, or skip old guides never shortens the walk.

## Required Routing

Read [guides](references/guides.md) first. Then read the guide for the distribution you found: [Docker Compose](references/compose.md), [Helm](references/helm.md), or [source checkouts and application packages](references/packages.md). Read the packages guide as well whenever an application SDK is involved. Always finish with [verification](references/verification.md).

## Establish the Deployment

Before reading any guide, record the deployed version and distribution from the deployment itself: the running image tag or digest, the Helm release's chart version and values, the Compose `.env`, or the checked-out tag. A version from memory, a ticket, or a chat message is a claim to check, not evidence. When the evidence is missing or disagrees, stop and report it.

## Walk the Guides

Guides live at `docs/upgrades/<unit>/<version>.md` in the Gauntlet repository; read them at the target's release tag, never from a branch. Read every guide whose version is after the deployed version and at most the target, oldest first, and check that each `from` matches the previous `to`. A guide's `action` describes only its own version: the newest guide never summarizes older ones. Versions before 0.2.0 have no guides; read `CHANGELOG.md` at the target tag for them.

Apply every `required` step. Decide every `optional` step explicitly: apply it, or skip it with a stated reason. Upgrade application SDK packages first when a guide or the compatibility notes require it.

## Change Only Real Files

Edit the operator's existing files in place: the Compose `.env` and wrapper configuration, or the complete Helm values file and the command or script that names the chart. Never add an override file, a second values file, or `--set` flags instead of editing. Before replacing anything, back up every operator-owned file and the data (the SQLite database under `GAUNTLET_DATA_DIR` or its volume) to the private operator store.

## Invariants

- Pin exact versions: an exact image tag or digest and an exact chart version. Never `latest`, a minor tag, or a range.
- Keep exactly one replica. SQLite sits on a ReadWriteOnce volume and run projections live in memory; a short interruption is the expected cost of an upgrade, never a reason to scale.
- Keep the private boundary, the public denial of `/_gauntlet/v1`, and the non-production environment identity unchanged.
- When verification fails, stop and follow rollback. Never delete data, weaken security, or scale up to make a check pass.

## Completion Evidence

Return `Deployment evidence`, `Guides read`, `Applied steps`, `Skipped optional steps` (each with its reason), `Changed files`, `Backups`, `Verification`, `Rollback`, `Unresolved risk`, and `Verdict`. Include exact commands and bounded outputs. Say `complete` only when every required step is applied, every optional step is decided, and the runbook's verification passed against the upgraded deployment.
