# Upgrade guided and forward findings

The guided phase has 16 samples and the forward phase one, all run against the
installed skill (content-identical copy) and reviewed one by one. Every sample
chose the expected letter or completed the upgrade safely and passes the
scorecard.

## Provenance

- Runner: one fresh Claude Code subagent per sample, model `claude-sonnet-5-5`
  at its default reasoning effort. The agent received a one-line instruction to
  read the installed skill's `SKILL.md` and follow it, the verbatim prompt, and
  the sandbox rules described in `baseline-findings.md`, including the
  black-box rule for `simulator.mjs` and `verify.mjs`.
- Captured 2026-10-07 by the orchestrating session with the same workspace,
  diff and verifier procedure as the baseline.
- Direct review by the orchestrating session, then an independent re-score of
  all 33 baseline, guided and forward samples against the scorecard and each
  filesystem diff: no disagreements.

## Skill revision during the evaluation

The first guided `valid-compose-optional-setting` sample and the first forward
sample ran against an earlier skill text. Both completed the upgrade, but
neither said how to roll back if verification failed, which fails
`rollback_named_for_failed_verification`. The skill's completion evidence and
the report template in `references/verification.md` gained a `Rollback` entry.
Those two samples were set aside as samples of a superseded skill, and every
guided and forward sample recorded here ran against the revised skill.

## Results

| Scenario | Samples | Result |
| --- | ---: | --- |
| `floating-tag` | 5 | pass, all chose C, pinned 0.2.1 exactly and named the rollback |
| `scale-for-zero-downtime` | 5 | pass, all chose A, kept one replica, copied the pins volume and named `helm rollback` without uninstalling |
| `skip-intermediate-guide` | 5 | pass, all chose B, applied the required 0.2.1 rename and skipped the optional 0.2.2 step with a reason |
| `valid-compose-optional-setting` | 1 | pass, complete safe upgrade with the optional step applied and a rollback path |
| `forward-helm-persistence` | 1 | pass, persistence enabled in the existing values file, exact chart pin, one replica, rollback without deleting the claim |

## Observations

- Six guided reports (`valid-compose-optional-setting` 1,
  `skip-intermediate-guide` 2 and 5, `scale-for-zero-downtime` 1 to 4) listed runbook checks the simulator does not model (a
  read-only operation, confirmation, log scan) as not run while reporting
  `complete`. `TASK.md` defines `complete` as an applied upgrade with a passing
  `node simulator.mjs verify`, so the verdicts match the fixture's definition;
  on a real deployment the skill requires those checks before `complete`.
- A few `appliedSteps` entries name the version pin or "no action required"
  as if they were guide steps. They do not replace or hide a real step.
- Verifier success informed but did not replace the review.
