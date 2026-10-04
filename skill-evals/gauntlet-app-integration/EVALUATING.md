# Application-integration evaluation protocol

The open-source release (2026-09-28) changed this evaluation's bound inputs
without changing any prompt, scenario, scorecard, or verifier: the repository
license (Apache-2.0), npm/Composer distribution metadata, the Symfony fixture
(which now installs from Packagist without custom Composer repositories), and
the registry wording in the skill's installation guidance. The receipt and
transcript hashes were re-bound to the changed bytes on 2026-09-28 (and again
after a dependency security update in `pnpm-lock.yaml`) without re-running the
model evaluation; the recorded samples were generated against
the previous inputs. The 0.1.2 release candidate prepared on 2026-09-29
changed exact package coordinates in the integration skill and its bound
repository inputs. The 0.1.5 candidate prepared on 2026-09-30 updates the exact candidate
coordinates and fixtures again. The hashes are re-bound to current bytes without
generating new model samples or changing recorded responses, reviews, or
timestamps. This confirms content integrity, not behaviour against the 0.1.5
packages. A fresh evaluation and independent review are required before claiming
current behavioural evidence.

The 0.1.7 release candidate updates the exact candidate coordinates again. The
external-input, skill, evaluation, and transcript hashes are re-bound to the
current bytes without generating new model samples or changing recorded
responses, reviews, or timestamps. This confirms content integrity, not
behaviour against the 0.1.7 packages. A fresh evaluation and independent review
are required before claiming current behavioural evidence.

The 0.1.8 release candidate updates the exact candidate coordinates again. The
external-input, skill, evaluation, and transcript hashes are re-bound to the
current bytes without generating new model samples or changing recorded
responses, reviews, or timestamps. This confirms content integrity, not
behaviour against the 0.1.8 packages. A fresh evaluation and independent review
are required before claiming current behavioural evidence.

The release unit model (2026-10-03) changed bound inputs without changing
prompts, scenarios or scorecards. The verifier text changed only because it
embeds the fixture contracts, whose versions are now read from each unit's
manifest. Hashes were re-bound to current bytes without generating new model
samples. This confirms content integrity, not behaviour.

Plan-driven publishing (2026-10-03) changed bound release tooling and the
skill's version wording (each reference now names its own exact version and
the unit release it comes from) without changing prompts, scenarios,
scorecards or verifiers. Hashes were re-bound to current bytes without
generating new model samples. This confirms content integrity, not behaviour.

The preserved prompts, results, and evidence describe the original evaluation
and have not been rewritten. The forward Node Compose fixture remains pinned
to 0.1.6 so its recorded response is checked against the exact package version
named in its frozen prompt. Passing self-tests do not establish that the
recorded model samples ran on the current package versions. A new model
evaluation would need prompts and samples prepared for those versions.

Every sample in the matrix is a fresh generation by a new evaluator process
run against the frozen skill and evaluation inputs. Every started sample
counts; a sample is rerun only after a documented harness failure (crash,
authentication error, preparer error, or a leak-audit hit), and each rerun is
listed in the findings. `verification.json` is minted only after every matrix
sample has been recorded and reviewed.

These fixtures are synthetic, hermetic contract exercises. They contain no
customer credentials, kubeconfig, cloud access, deployed adapter, or production
evidence.

Prepare a new workspace for every sample with the empty suffix, so the
workspace path matches the one named in the verbatim prompt:

```sh
node skill-evals/gauntlet-app-integration/prepare-fixture.mjs valid-compose
node skill-evals/gauntlet-app-integration/prepare-forward-fixture.mjs spring-ingress
```

The preparer replaces any existing workspace at that path, so keep at most one
live sample per scenario id; samples of different scenario ids may run in
parallel. Prepare the fixtures that pack workspace packages (`valid-compose`,
`node-compose`) one at a time.

Use a fresh evaluator context where practical. A baseline evaluator receives
the exact prompt and fixture but not the target skill, scorecard, expected
review, prior response, or findings. A guided evaluator additionally reads the
content-identical skill and only the references it routes for that task. A
forward evaluator receives the frozen skill and a previously unseen prompt.

Do not require a baseline failure. A self-contained task may pass without the
skill, and that result must be recorded honestly. Exact-copy positive fixtures
primarily check candidate/fixture consistency; they do not by themselves prove
that the skill caused an improvement.

Require the evaluator to edit only its synthetic workspace, use the documented
verification interface, and preserve the verifier. Record the complete prompt,
response, model, reasoning effort, millisecond UTC timestamp, chosen action,
filesystem diff, bounded test output, exit state, and direct scorecard review in
the phase JSONL. Automated probes inform but never replace manual review.

The receipt binds the skill, evaluation inputs, and transcripts by SHA-256 and
reconciles every matrix sample. It is a repository content-integrity record, not
external model attestation. Do not mint `verification.json` until all current
records reconcile, guided and forward rows pass, evidence claims distinguish
synthetic execution from customer deployment, and an independent reviewer has
checked the final bytes.

## Re-binding log

- 2026-10-04: Added the skills:rebind workspace script. Hashes were re-bound to the current bytes without new model samples; this confirms content integrity, not behaviour.
- 2026-10-04: Release version slots now cover every documented package, image and chart pin. Hashes were re-bound to the current bytes without new model samples; this confirms content integrity, not behaviour.
