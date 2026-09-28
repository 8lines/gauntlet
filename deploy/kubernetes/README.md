# Legacy Kubernetes migration

The static Kustomize manifests formerly kept in this directory are retired.
The [supported OCI Helm chart](../helm/README.md) is now the only maintained
Kubernetes deployment path. This directory remains solely as a migration
pointer for installations created from the old manifests.

Migration is an explicit replacement, not an in-place conversion. Helm does not adopt ownership of the old Deployment, Service, or ConfigMap. Before removing
anything, preserve the current image and preserve the current configuration,
then map both into a complete environment values file described by the Helm
guide. Confirm the namespace and object names against the actual installation;
the commands below intentionally use the documented `acme-staging` example.

## Migration procedure

1. Stop new tester activity and save the legacy configuration and workload
   record outside the repository.

<!-- gauntlet:legacy-backup -->
```sh
kubectl --namespace acme-staging get configmap/gauntlet -o yaml > legacy-configmap.backup.yaml
kubectl --namespace acme-staging get deployment/gauntlet -o yaml > legacy-deployment.backup.yaml
```

2. Copy the exact image reference and targets into a complete
   `values.acme-staging.yaml`. Pull and render the exact chart archive by
   following the [Helm deployment](../helm/README.md). Review the rendered
   namespace, image, configuration, private exposure, and policy. Because the
   supported Deployment has one replica with `Recreate`, schedule downtime.

3. During that maintenance window, remove exactly the three legacy objects.
   This is the only destructive command in this guide.

<!-- gauntlet:legacy-remove -->
```sh
kubectl --namespace acme-staging delete deployment/gauntlet service/gauntlet configmap/gauntlet
```

4. Install the reviewed local chart archive with the complete environment
   values, then perform every status, readiness, target-state, and log check in
   the Helm guide.

The migration does not delete the namespace or any separately managed Secret,
Ingress, policy, controller, DNS record, or adapter deployment. It also does not
migrate process-local state: the control plane's run projections are lost when
the legacy Pod stops. Adapter-owned runs and event history follow the target
application's own persistence policy. Keep the backups until the Helm release
and every configured target have been verified.

[Documentation index](../../docs/README.md)
