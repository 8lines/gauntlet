# Upgrade runbook

Upgrade one non-production Gauntlet instance at a time. The control plane
runs one replica and stores run projections in memory, so an upgrade causes a
short interruption and loses current dashboard run history. Pinned operations
survive only when `GAUNTLET_DATA_DIR` points at persistent storage (Helm
`persistence.enabled`). Domain effects and adapter-owned run state remain the
responsibility of each target application.

Every version has an [upgrade guide](../upgrades/README.md) that lists the
required and optional steps for operators. An AI agent can run this procedure
with the `gauntlet-upgrade` [skill](../ai-skills.md).

## Prepare

1. Read the [upgrade guide](../upgrades/README.md#upgrading-with-the-guides)
   of the candidate release and of every intermediate version, oldest first
   (`CHANGELOG.md` for versions before 0.2.0). Plan every `required` step and
   decide every `optional` one.
2. Verify that the candidate artifacts are available from their
   [registries](installing-packages.md) and record the current exact
   image/chart or Compose artifact identity.
3. Back up operator-owned `.env`, `config.yaml`, and complete Helm values in a
   private store, and snapshot the volume behind `GAUNTLET_DATA_DIR` when
   persistence is enabled. Do not copy credentials into the repository.
4. Confirm the destination is still non-production and every public ingress
   still denies `/_gauntlet/v1`.
5. Upgrade application SDKs first when the compatibility notes require it.
   Run their framework tests and live conformance before upgrading the control
   plane.
6. Render or inspect the candidate deployment with the exact artifacts of the
   target release (see the [current versions](installing-packages.md#current-versions)) and
   review image, namespace/network, target origins, environment identity,
   ingress, and policy changes.

## Apply

Apply the guides' steps to the operator files first. For Docker Compose, follow the exact [pull and recreate](../../deploy/compose/README.md#upgrade)
sequence using the wrapper. For Kubernetes, pull the chart archive, render that
same archive with the complete environment values, and follow the
[Helm upgrade procedure](../../deploy/helm/README.md#upgrade-and-preview).

Do not install from a floating image tag. Do not scale above one replica during
the rollout. Do not weaken the private boundary to work around a readiness or
target-connectivity problem.

## Verify

After replacement:

- `/health` and `/ready` succeed through the private access path;
- every configured target appears once and reports the exact expected
  environment name and kind;
- mismatched and disabled adapters remain blocked;
- the public application route still denies the adapter prefix;
- one read-only or low-impact operation completes with valid progress/result;
- a confirmation-required operation still requires revision-bound
  acknowledgement;
- logs contain no secret input, credential, raw idempotency key, or internal
  exception detail.

Keep the preceding artifact identity and backup until the verification window
ends. If a safety boundary or compatibility check fails, stop tester access and
follow the [rollback runbook](rollback.md).
