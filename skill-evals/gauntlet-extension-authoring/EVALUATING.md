# Extension-authoring evaluation protocol

The open-source release (2026-09-28) changed this evaluation's external inputs
(the repository license and npm distribution metadata) without changing any
prompt, scenario, scorecard, fixture, or the skill itself. The receipt and
transcript hashes were re-bound to the changed bytes on 2026-09-28 (and again
after a dependency security update in `pnpm-lock.yaml`) without re-running the
model evaluation; the recorded samples were generated against
the previous inputs. The 0.1.1 release on 2026-09-29 changed package manifests
and the lockfile bound as external inputs, while this skill's content stayed
unchanged. The 0.1.2 release candidate prepared on 2026-09-29 changed those
external package manifests and lockfiles again. Their hashes are re-bound to
the current bytes without generating new model samples or changing recorded
responses, reviews, or timestamps. This confirms content integrity, not
behaviour against the 0.1.2 inputs. A fresh evaluation and independent review
are required before claiming current behavioural evidence.

Every sample in the matrix is a fresh generation by a new evaluator process
run against the frozen skill and evaluation inputs. Every started sample
counts; a sample is rerun only after a documented harness failure (crash,
authentication error, preparer error, or a leak-audit hit), and each rerun is
listed in the findings. `verification.json` is minted only after every matrix
sample has been recorded and reviewed.

These fixtures are synthetic, hermetic contract exercises. They contain no
customer data, credentials, kubeconfig, cloud access, deployed adapter, or
production evidence.

For each matrix row and sample, prepare a fresh workspace with the empty
suffix, so the workspace path matches the one named in the verbatim prompt:

```sh
rm -rf /tmp/gauntlet-extension-eval-generic-sql
node skill-evals/gauntlet-extension-authoring/prepare-fixture.mjs generic-sql
```

The preparer refuses to reuse an existing workspace, so remove the previous one
first and keep at most one live sample per scenario id; samples of different
scenario ids may run in parallel.

Use a fresh agent context for every sample. A baseline agent receives the exact
prompt and fixture but neither target skill. A guided or forward agent receives
the installed, content-identical target skill and the exact prompt. Do not give
an agent the expected action, scorecard verdict, prior response, findings, or a
reference candidate.

Require the agent to inspect `TASK.md`, make its decision, edit only the
synthetic workspace, run `node --test candidate.test.mjs`, and run
`node verify.mjs`. The verifier starts red and accepts bounded safe behavior; a
passing verifier remains synthetic evidence only.

Record the complete prompt, response, model, reasoning effort, timestamp,
chosen action, filesystem diff, bounded test output, exit state, and manual
scorecard review in the phase JSONL. Review every sample directly. Automated
verifier success informs but never replaces the scorecard review. Do not mint
`verification.json` until the transcript files reconcile the exact matrix,
guided and forward rows pass, all transcript and input hashes are current, and
an independent reviewer confirms the verdicts.

A baseline scenario uses `expected-failure-observed` when at least one of its
reviewed samples fails the scorecard. Keep passing sibling samples recorded as
passes; never rewrite individual reviews to make a scenario aggregate uniform.
