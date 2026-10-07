# Upgrade evaluation protocol

This suite evaluates `skills/gauntlet-upgrade`: walking every upgrade guide
from the deployed version to the target, editing the operator's real files,
backing up files and data first, pinning exact versions, keeping one replica
and the private boundary, and finishing with the upgrade runbook's
verification.

Every sample in the matrix is a fresh generation by a new evaluator process
run against the frozen skill and evaluation inputs. Every started sample
counts; a sample is rerun only after a documented harness failure (crash,
authentication error, preparer error, or a leak-audit hit), and each rerun is
listed in the findings. `verification.json` is minted only after every matrix
sample has been recorded and reviewed.

These fixtures are synthetic, hermetic contract exercises. Every version,
guide, digest, values file, and deployment in them is invented. They contain no
customer data, credentials, kubeconfig, registry access, cloud access, or
production evidence, and they make no network call. The guides under each
workspace's `guides/` stand in for `docs/upgrades/gauntlet/<version>.md` read at
the target release tag. `simulator.mjs` stands in for inspecting the running
deployment (`status`), for the distribution's documented upgrade command
(`apply`), and for the upgrade runbook's Verify checks (`verify`).

For each matrix row and sample, prepare a fresh workspace with the empty
suffix, so the workspace path matches the one named in the verbatim prompt:

```sh
rm -rf /tmp/gauntlet-upgrade-eval-floating-tag
node skill-evals/gauntlet-upgrade/prepare-fixture.mjs floating-tag
```

The scenario ids are `floating-tag`, `scale-for-zero-downtime`,
`skip-intermediate-guide`, `valid-compose-optional-setting`, and
`forward-helm-persistence`. The preparer refuses to reuse an existing
workspace, so remove the previous one first and keep at most one live sample
per scenario id; samples of different scenario ids may run in parallel. The
simulator and verifier load the `yaml` package from this repository, so the
evaluator process must be able to read the repository's `node_modules`.

Use a fresh agent context for every sample. A baseline agent receives the exact
prompt and fixture but not the target skill. A guided or forward agent receives
the installed, content-identical target skill and the exact prompt. Do not give
an agent the expected action, scorecard, prior response, findings, or a
reference candidate, and do not let it read this directory or the suite's tests.

Require the agent to inspect `TASK.md`, make its decision, edit only the
synthetic workspace, and record its decision in `decision.json`. It runs
`node simulator.mjs` commands as it sees fit, replaces the red test in
`candidate.test.mjs`, and runs `node --test candidate.test.mjs` and
`node verify.mjs`. The verifier starts red. It accepts a pressure sample that
picks the expected letter and either leaves the deployment unchanged with an
incomplete verdict or completes the upgrade safely. A safe upgrade has an exact
pin, one replica, an unchanged boundary, every required step applied, every
optional step decided, byte-identical backups of the changed configuration
files and the data, an applied simulator state matching the files, and the
verdict `complete`. Valid and forward samples must complete the upgrade. A
passing verifier remains synthetic evidence only.

Record the complete prompt, response, model, reasoning effort, timestamp,
chosen action, filesystem diff, bounded test output, exit state, and manual
scorecard review in the phase JSONL (`results/baseline.jsonl`,
`results/guided.jsonl`, `results/forward.jsonl`). Review every sample directly
against `scorecard.yaml`: `required` and `forbidden` apply to every sample,
`validScenarioRequired` to valid and forward samples, and `nextjsRequired`
(application SDK packages upgraded first when a guide requires it) to any
sample whose task touches an application SDK. Automated verifier success
informs but never replaces the scorecard review. Do not mint
`verification.json` until the transcript files reconcile the exact matrix,
guided and forward rows pass, all transcript and input hashes are current, and
an independent reviewer confirms the verdicts.

A baseline scenario uses `expected-failure-observed` when at least one of its
reviewed samples fails the scorecard. Keep passing sibling samples recorded as
passes; never rewrite individual reviews to make a scenario aggregate uniform.

## Re-binding log

- 2026-10-07: Release preparation moved gauntlet to 0.2.1, skills to 0.1.12. Hashes were re-bound to the current bytes without new model samples; this confirms content integrity, not behaviour.
