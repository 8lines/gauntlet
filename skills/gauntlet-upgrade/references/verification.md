# Verification and completion

## Runbook verification

After the replacement, follow the Verify section of the upgrade runbook (`docs/releases/upgrading.md#verify`) at the target tag:

- `/health` and `/ready` succeed through the private access path;
- the running image, chart, or package is exactly the target version;
- exactly one replica or process runs;
- every configured target appears once with the exact expected environment name and kind;
- mismatched and disabled adapters stay blocked;
- the public application route still denies `/_gauntlet/v1`;
- one read-only or low-impact operation completes, and a confirmation-required operation still requires acknowledgement;
- logs contain no secret, credential, raw idempotency key, or internal exception detail;
- each applied guide step has the effect it describes (for example persistence: no `GAUNTLET_DATA_EPHEMERAL` warning after enabling `GAUNTLET_DATA_DIR` or `persistence.enabled`).

When an environment needed for a check is unavailable, keep the exact command, state `not run`, and do not report `complete`.

## When verification fails

Stop tester access and follow the rollback runbook (`docs/releases/rollback.md`) with the backups you took: restore the preceding operator files and the preceding exact image, chart, or package, then repeat these checks. If production identity, public exposure, or target identity is in doubt, disable access first and treat it as a safety incident.

Never delete or reset data, remove a volume or claim, widen a bind or ingress, disable authentication, relabel an environment, use a floating tag, or add replicas to make a check pass. Keep the failed artifact identity and logs as evidence.

## Completion report

```text
Deployment evidence
- distribution, unit, deployed version, and the commands or files that proved it

Guides read
- every version in order, with its action, and the tag it was read at

Applied steps
- <version>: <title> => what changed in which file

Skipped optional steps
- <version>: <title> => reason

Changed files
- exact operator file paths

Backups
- what was copied where, including data or volume snapshots

Verification
- command => exit status and bounded decisive output

Rollback
- the backups and the exact steps that restore the preceding version if verification fails, now or later

Unresolved risk
- none, or each check not run or failed

Verdict
- complete only when every required step is applied, every optional step is decided, and verification passed
```
