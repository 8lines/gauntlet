# Gauntlet Helm deployment

The supported Kubernetes distribution is the OCI Helm chart in
[`gauntlet`](gauntlet). Install one release for one coherent,
non-production environment. The chart does not discover workloads or request a
Kubernetes API token: every adapter origin is explicit in environment values.

Maintainers can create the normalized release artifact with
`node deploy/helm/package-chart.mjs --destination /absolute/private/output`.
The packager uses pinned Helm 4.0.4, refuses to overwrite an existing artifact,
and reports its SHA-256 digest. Publish that reviewed artifact to
`oci://ghcr.io/8lines/charts/gauntlet`; operators consume it by exact chart
version as shown below.

## Safety boundary

Gauntlet v0.1 has no authentication. A private address, VPN, TLS certificate,
Ingress, or NetworkPolicy is not authentication or authorization. Give access
only to trusted testers through an independently administered private boundary
or an authenticating reverse proxy (for example basic authentication or SSO) in
front of the dashboard, and keep every adapter API off public routes. The chart
and image are public; that does not make a public deployment safe.

The control plane checks declared environment metadata, but metadata cannot
prove the physical environment. Gauntlet and every application adapter must
be disabled independently in production. There is deliberately no production
bypass switch. An operator must review target origins, image identity, namespace,
Ingress, and policy selectors before every installation or upgrade.

## Prerequisites

- a pre-existing namespace dedicated to the selected development, test, UAT, or
  staging environment (this guide uses `acme-staging`);
- Helm 4.0.4 and a compatible `kubectl` context pointing at that environment;
- a published Gauntlet image and an explicit version tag or immutable digest;
- any selected Ingress controller, DNS, certificate, VPN, and NetworkPolicy-capable
  CNI installed and operated outside this chart; and
- application adapters already enabled only in this non-production environment.

The OCI chart and the `ghcr.io/8lines/gauntlet` image are public, so neither
Helm nor the cluster needs registry credentials to pull them. If the cluster
must pull through an authenticated registry mirror instead, provision a
separate imagePullSecret through the platform's approved secret manager and
list it in the optional `imagePullSecrets` value (empty by default). The chart
neither creates nor accepts registry passwords; never place a secret in a
command argument, values file, rendered manifest, or source control.

## Complete environment values

Create a reviewed `values.acme-staging.yaml`. This is a complete values file,
not an overlay; keep one complete file per environment and protect changes with
normal code review. The example uses the exact `0.1.2` application tag: stable tags are versioned; only digests are immutable. For digest pinning, set `tag` to
an empty string and set `digest` to the reviewed `sha256:...` value.

<!-- gauntlet:environment-values -->
```yaml
replicaCount: 1

image:
  repository: ghcr.io/8lines/gauntlet
  tag: "0.1.2"
  digest: ""
  pullPolicy: IfNotPresent
imagePullSecrets: []

config:
  version: 1
  instance:
    name: acme-staging
    environment:
      name: staging
      kind: staging
  targets:
    - id: organizations
      label: Organizations staging
      adapterUrl: http://organizations.acme-staging.svc.cluster.local:8080
      expectedEnvironment:
        name: staging
        kind: staging
      tags:
        - symfony

service:
  type: ClusterIP
  port: 8080

ingress:
  enabled: false
  className: ""
  annotations: {}
  hosts: []
  tls: []

networkPolicy:
  enabled: false
  dns:
    namespaceSelector:
      matchLabels:
        kubernetes.io/metadata.name: kube-system
    podSelector:
      matchLabels:
        k8s-app: kube-dns
  ingressPeers: []
  egressRules: []

resources:
  requests:
    cpu: "50m"
    memory: 64Mi
  limits:
    cpu: "500m"
    memory: 256Mi

podAnnotations: {}
podLabels: {}
nodeSelector: {}
tolerations: []
affinity: {}
```

`adapterUrl` is an internal origin, never a browser URL. Do not put credentials,
paths, queries, or fragments in a target. Confirm target reachability from the
Gauntlet network boundary before installation; the chart never infers network
rules from URLs.

`config.widget` and each target's `config.targets[].widget.origins` pass
through to the rendered configuration file unchanged. `config.widget.enabled`
defaults to `false`, and every target origin must be an exact canonical
HTTP(S) origin (no wildcard, credentials, path, trailing slash, uppercase
host, or default port — `https://shop.example:443` is rejected in favor of
`https://shop.example`); the chart schema rejects an invalid value the same
way it rejects any other malformed target field, except the default-port
case, which the schema cannot express and which only fails at server startup
with `invalid-document`. See
[widget configuration](../../config/README.md#widget) for the full contract.
Enabling `config.widget.enabled` also requires an `image` that ships the
widget build at `GAUNTLET_WIDGET_DIR`; an image without it fails startup the
same way a missing `GAUNTLET_WIDGET_DIR` does.

## Registry access and first installation

The chart is public, so `helm pull` needs no `helm registry login`. When you
pull through an authenticated mirror, log in by standard input so the token is
never an argument (`--password-stdin`).

Pull the exact `0.1.2` chart to a local immutable input, render that same archive
for review, and install that same archive. Do not install directly from an OCI
URL after previewing a different input. The namespace must already exist.

<!-- gauntlet:pull-render-install -->
```sh
helm pull oci://ghcr.io/8lines/charts/gauntlet --version 0.1.2 --destination .
helm template gauntlet ./gauntlet-0.1.2.tgz \
  --namespace acme-staging \
  -f values.acme-staging.yaml > rendered.yaml
helm upgrade --install gauntlet ./gauntlet-0.1.2.tgz \
  --namespace acme-staging \
  -f values.acme-staging.yaml \
  --reset-values \
  --wait \
  --timeout 5m
```

Review `rendered.yaml` before the install. In particular, check the namespace,
image, target origins, absence or exact shape of Ingress, and every policy peer.
`--reset-values` makes the reviewed environment file authoritative instead of
silently retaining settings from an older release.

## Private access

With Ingress disabled, use a loopback-only port-forward from a tester workstation:

<!-- gauntlet:private-access -->
```sh
kubectl --namespace acme-staging port-forward --address 127.0.0.1 service/gauntlet 8080:8080
```

While it runs, the dashboard is available only at `http://127.0.0.1:8080` on
that workstation. Never change the bind address to a wildcard. If persistent
private access is required, use one reviewed overlay from
[`examples`](examples/README.md) and keep the Service as `ClusterIP`.

## Configuration and rollout

The values file is the source of truth for instance and target configuration.
The chart stores it in a ConfigMap and adds `checksum/config` to the Pod template,
so a changed configuration causes a replacement rollout. The Deployment always
uses one replica and `Recreate`; configuration and image changes therefore have
an expected interruption.

Run coordination and history are process-local and in-memory. There is no
persistent volume and no PodDisruptionBudget. Do not scale this Deployment:
multiple independent replicas cannot preserve execution ownership, cancellation,
or event-stream guarantees. A restart, rollout, reschedule, rollback, or uninstall
loses current runs and history.

## Status, readiness, and logs

Inspect the Helm release, controller state, selected Pod, and bounded recent
logs:

<!-- gauntlet:observe -->
```sh
helm status gauntlet --namespace acme-staging
kubectl --namespace acme-staging get deployment/gauntlet
kubectl --namespace acme-staging get pods -l app.kubernetes.io/instance=gauntlet
kubectl --namespace acme-staging logs deployment/gauntlet --all-containers=true --tail=200
```

The startup and readiness probes call `/ready`; the liveness probe calls
`/health`. After the Pod is Ready, use the private access path to inspect
`/api/v1/targets`. Every expected target must be present, report the intended
environment, and complete discovery without a reachability error before testers
execute operations.

## Upgrade and preview

First save the currently effective non-secret values. Pull the exact candidate
chart version and render that same local archive with the complete environment
file:

<!-- gauntlet:backup-preview -->
```sh
helm get values gauntlet --namespace acme-staging --all > values.before-upgrade.yaml
helm pull oci://ghcr.io/8lines/charts/gauntlet --version 0.1.2 --destination .
helm template gauntlet ./gauntlet-0.1.2.tgz \
  --namespace acme-staging \
  -f values.acme-staging.yaml > rendered.upgrade.yaml
```

Compare the rendered candidate with the live release and review image identity,
configuration, Ingress, and NetworkPolicy changes. Values backups may disclose
internal topology; store and delete them according to project policy.

Apply exactly the reviewed local archive:

<!-- gauntlet:upgrade -->
```sh
helm upgrade gauntlet ./gauntlet-0.1.2.tgz \
  --namespace acme-staging \
  -f values.acme-staging.yaml \
  --reset-values \
  --wait \
  --timeout 5m
```

Repeat the status, readiness, target-state, and log checks after the rollout.

## Rollback

List release history and choose the exact rollback revision after reviewing its
chart and values. Revision `3` below is an explicit example, never a placeholder
to copy without checking history.

<!-- gauntlet:rollback -->
```sh
helm history gauntlet --namespace acme-staging
helm rollback gauntlet 3 --namespace acme-staging --wait --timeout 5m
```

A rollback replaces the Pod but does not restore process-local run history. It
also does not recreate or roll back external image secrets, controllers,
certificates, DNS, adapter deployments, ACLs, or other environment infrastructure.
Verify readiness and all target state again.

## Uninstall and data loss

Export anything needed for diagnosis before removal. Uninstalling removes the
release-managed Deployment, Service, ConfigMap, Ingress, and NetworkPolicy. It
does not delete the namespace or any imagePullSecret you provisioned.

<!-- gauntlet:uninstall -->
```sh
helm uninstall gauntlet --namespace acme-staging --wait
```

Uninstall permanently discards all process-local runs and event history. The
same loss already occurs whenever the single Pod is replaced. The command does
not disable adapters; application owners must manage their independent
non-production enablement.

## Ingress and NetworkPolicy limits

[`examples/private-alb-values.yaml`](examples/private-alb-values.yaml) and
[`examples/tailscale-values.yaml`](examples/tailscale-values.yaml) are narrow
Ingress overlays, not complete environment values. The chart does not install an
Ingress controller, issue a certificate, configure DNS, or configure upstream
firewalls. For Tailscale, separately audit the operator and Tailscale ACL; Funnel
is forbidden because it creates public exposure. ALB mode requires an internal,
IP-target ALB and canonical bounded RFC1918 source CIDRs, but those annotations
still require infrastructure review.

[`examples/acme-network-policy-values.yaml`](examples/acme-network-policy-values.yaml)
shows strict selector-only ingress and egress. Enable it only with a CNI that
actually enforces Kubernetes NetworkPolicy. NetworkPolicies are additive, so
another policy can allow more traffic, and network isolation is not authentication.
The chart adds no rule from an adapter URL: configure exact combined namespace
and Pod selectors and exact ports for each adapter.

The selector-only v0.1 policy cannot safely admit ALB data-plane sources. The
chart rejects ALB Ingress together with this NetworkPolicy; do not broaden a peer
or add an empty selector to work around that boundary. For Tailscale, select the
data-plane proxy Pods rather than the operator control-plane Pod. Verify CNI
enforcement, DNS labels, Ingress-controller labels, every target, and any other
additive policies in the real cluster.

## Migrating from the legacy manifests

The former static manifests are retired. Follow the bounded handoff in the
[`legacy Kubernetes migration`](../kubernetes/README.md) before installing the
supported OCI chart. Helm does not adopt the old objects; preserve the current
image and configuration, render the exact chart, and schedule downtime for the
single-replica `Recreate` transition.

## MCP access for AI clients

Set `mcp.enabled: true` in the environment values file and upgrade the release
through the procedure above. The endpoint is `/mcp` on the same private Service
and ingress as the dashboard. `mcp.allowedOrigins` defaults to `[]`; configure
exact HTTP(S) origins only for clients that send an Origin header. These
settings do not change the private access boundary. See
[MCP setup, tools and limits](../../docs/mcp.md).

[Documentation index](../../docs/README.md)
