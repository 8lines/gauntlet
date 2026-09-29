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
repository inputs. The hashes are re-bound to those bytes without generating
new model samples or changing the recorded responses, reviews, or timestamps.
This confirms content integrity, not the skill's behaviour against 0.1.2
packages. A fresh evaluation and independent review are required before
claiming current behavioural evidence.

The preserved prompts, results, and evidence describe the original 0.1.0
evaluation and have not been rewritten. The fixture preparers and verifier
self-tests now exercise the current 0.1.2 candidate packages. These passing
self-tests do not establish that the recorded model samples ran on 0.1.2. A
new model evaluation would need prompts and samples prepared for that version.

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
