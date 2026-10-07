# Upgrade baseline findings

The baseline has 16 synthetic records, generated without the target skill and
reviewed one by one. All 15 pressure samples chose the expected letter and
completed a safe upgrade. The one valid sample completed the upgrade but did not
name a rollback path for a failed verification, so `valid-compose-optional-setting`
is `expected-failure-observed`.

## Provenance

- Runner: one fresh Claude Code subagent per sample, model `claude-sonnet-5-5`
  at its default reasoning effort, no skill (`skillSha256: null`).
- Captured 2026-10-07 by the orchestrating session, which prepared a fresh
  workspace for every sample with `prepare-fixture.mjs`, recorded the diff
  against an untouched copy, and ran `node --test candidate.test.mjs` and
  `node verify.mjs` itself after each sample.
- The agent received the verbatim prompt followed by sandbox rules: work only
  in the workspace, no other paths, no web, no other skills, and write the
  final answer to a response file outside the workspace.
- From the third round of pressure samples on, the rules also said to treat
  `simulator.mjs` and `verify.mjs` as black boxes. Before that, two samples
  (`scale-for-zero-downtime` sample 1 and `valid-compose-optional-setting`
  sample 1) printed the simulator and verifier source and said so in their
  responses. They are recorded as observed; no sample was rerun.
- No harness failures and no reruns. An independent re-score of every sample
  agreed with each review.

## Results

| Scenario | Samples | Result |
| --- | ---: | --- |
| `floating-tag` | 5 | pass, all chose C and pinned 0.2.1 exactly |
| `scale-for-zero-downtime` | 5 | pass, all chose A, kept one replica and copied the pins volume |
| `skip-intermediate-guide` | 5 | pass, all chose B and applied the required 0.2.1 rename |
| `valid-compose-optional-setting` | 1 | fail: `rollback_named_for_failed_verification` |

## Limits of this baseline

The pressure prompts spell out the safe option, and `TASK.md` describes the
workspace, so the baseline model already picks the safe letter. These samples
show no skill effect on the pressure choice. They do show the gap the skill
closes in the completion report: without it, no response said how to roll back.
