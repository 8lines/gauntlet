# Helm upgrades

The supported Kubernetes distribution is the OCI chart `oci://ghcr.io/8lines/charts/gauntlet`. Each environment keeps one complete values file (not an overlay) under review, and the operator's command or script names the exact chart version.

## Before the change

- Read the deployed chart version and revision from `helm list` and `helm history`, the effective values from `helm get values --all`, and the image of the running Pod.
- Save the effective values (`helm get values gauntlet --namespace <ns> --all > values.before-upgrade.yaml`) and a copy of the complete values file in the private operator store.
- When `persistence.enabled` is true, the pins database lives on a ReadWriteOnce PersistentVolumeClaim mounted at `/var/lib/gauntlet`. Take a volume snapshot with the platform's tooling before the upgrade. Never delete, recreate, or resize the claim to make an upgrade pass.

## Editing

- Edit the existing complete values file. Never add a second values file, a `--set` flag, or `--reuse-values` in place of an edit; keep `--reset-values` so the reviewed file stays authoritative.
- Set `image.tag` to the exact target (or empty `tag` with the reviewed `image.digest`) and change the chart version in the operator's pull and upgrade commands to the same exact target. Never use `latest`, a minor tag, or a version range.
- Keep `replicaCount: 1`. The chart always uses the `Recreate` strategy; the volume is `ReadWriteOnce` and run coordination is in memory, so a second replica cannot share the volume or preserve execution ownership. Zero downtime is not available: announce the short interruption instead of scaling, and never switch the claim to a shared or `ReadWriteMany` volume.
- Apply each guide step to the key it names. A new optional key may be added with its documented default shape or left out with a recorded reason. Leave `ingress`, `networkPolicy`, `service`, and `config` unchanged unless a step requires it.

## Applying

Pull the exact candidate archive, render that same archive for review, and upgrade with that archive:

```sh
helm pull oci://ghcr.io/8lines/charts/gauntlet --version <target> --destination .
helm template gauntlet ./gauntlet-<target>.tgz --namespace <ns> -f <values-file> > rendered.upgrade.yaml
helm upgrade gauntlet ./gauntlet-<target>.tgz --namespace <ns> -f <values-file> --reset-values --wait --timeout 5m
```

Review the rendered image, replica count, persistence, Ingress, and NetworkPolicy before the upgrade. Do not install from an OCI URL after previewing a different input.

## Rollback

Review `helm history`, choose the exact preceding revision, and run `helm rollback gauntlet <revision> --namespace <ns> --wait --timeout 5m`. Rollback does not roll back pins on the volume or restore in-memory run history; restore the volume snapshot only when the data itself is damaged. Never uninstall the release as a rollback: uninstalling can delete a chart-managed claim.
