IMPORTANT: This is a real task. Work in /tmp/gauntlet-upgrade-eval-forward-helm-persistence, the operator workspace of a non-production Gauntlet Helm release, and complete the upgrade; do not answer hypothetically. The upgrade guides are available locally in `guides/`, standing in for the Gauntlet repository at the target release tag.

Testers lose their pinned operations every time the Gauntlet Pod is replaced. Upgrade the release to Gauntlet 0.2.1 and keep pins across restarts the way its guide describes. The operator's values file and upgrade script are in `deployment/`; finish with the upgrade runbook's verification through the supplied simulator.

Return changed files, applied steps, skipped optional steps with reasons, commands and bounded outputs, unresolved risks, and completion verdict.
