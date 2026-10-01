# Deployment

Choose one deployment model for one coherent non-production application set. Never connect one control plane to both non-production and production targets.

Before selecting it, map the organization's production accounts/projects/subscriptions, clusters, namespaces or Compose projects, DNS zones, hostnames, and aliases (for example `prd` when used). The built-in token checks are only a minimum. An unknown or ambiguous identity blocks deployment with adapters disabled.

## Standalone Docker Compose

- Use exact image `ghcr.io/8lines/gauntlet:0.1.7` or an approved digest.
- Start from the released Compose distribution/wrapper and keep the control plane at exactly one replica.
- Set `GAUNTLET_CONFIG_FILE=/etc/gauntlet/config.yaml` and mount an operator-owned config read-only.
- Bind the dashboard to `127.0.0.1` or one reviewed private interface; do not publish adapter ports.
- Join Gauntlet and each application project to the pre-existing external network named `gauntlet`; use explicit stable aliases.
- Define every target statically with its internal URL and exact structured `expectedEnvironment`.
- Verify the selected host and Compose project against the organization-specific production mapping; a custom project name is not non-production evidence.
- Do not mount the Docker socket, scan networks, or add runtime discovery.

The application adapter remains part of the application container. The browser calls only Gauntlet `/api/v1`; it never calls an adapter directly.

## Kubernetes

- Use exact chart `oci://ghcr.io/8lines/charts/gauntlet` version `0.1.7` and exact image `0.1.7` or a reviewed digest.
- Require Kubernetes `>=1.35` and Helm `4.0.4`; pre-create the namespace. The image and chart are public; add a registry pull Secret only for an authenticated mirror.
- Pull the exact chart archive, render and review that file, then install the same file with `--reset-values`; do not preview one input and install another.
- Deploy one Gauntlet replica in the selected non-production namespace, with a `ClusterIP` Service and ingress disabled by default.
- Disable service-account token automount and create no Gauntlet RBAC, Docker socket, cluster discovery, or dynamic target discovery.
- Configure explicit targets at internal Service DNS names with exact `expectedEnvironment` values.
- Verify account/project/subscription, cluster, namespace, and DNS identity against the organization-specific production mapping; labels alone are not evidence.
- Prove a private path through Tailscale/VPN, an internal load balancer, port-forward bound to `127.0.0.1`, or reviewed private ingress.
- Apply NetworkPolicy or equivalent evidence for intended dashboard ingress and control-plane-to-adapter egress. Explicitly deny the adapter prefix on public ingress.

Use a release/digest that actually exists in the public registries. Rendering valid Compose/YAML/Helm proves configuration shape, not deployed reachability, public denial, or live conformance.

## Exact control-plane document

Use the closed v1 shape; `adapterUrl` is a private bare HTTP(S) origin without credentials, path, query, or fragment:

```yaml
version: 1
instance:
  name: billing-staging
  environment:
    name: staging
    kind: staging
targets:
  - id: billing
    label: Billing
    adapterUrl: http://billing.staging.svc.cluster.local:8080
    expectedEnvironment:
      name: staging
      kind: staging
```

Add target `publicUrl` only when `tc-session-launch@1` is advertised; it is the canonical public application origin and every returned launch URL must match it. When selecting `GAUNTLET_CONFIG_FILE`, remove all four legacy inputs (`GAUNTLET_TARGETS_JSON`, `GAUNTLET_INSTANCE_NAME`, `GAUNTLET_ENVIRONMENT_NAME`, `GAUNTLET_ENVIRONMENT_KIND`) because mixing sources must fail startup.
