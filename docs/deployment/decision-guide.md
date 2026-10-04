# Deployment decision guide

Deploy one Gauntlet instance for one coherent, explicitly named
non-production environment. Do not build one global control plane that can
switch between development, staging, UAT, and production.

| Situation | Supported choice | Why |
| --- | --- | --- |
| Several small applications share one Docker Engine or VPS | [Standalone Compose](../../deploy/compose/README.md) | One container joins the applications' external private bridge; only the dashboard binds to loopback or one reviewed private interface. |
| Applications run in one Kubernetes namespace | [Helm](../../deploy/helm/README.md) in that namespace | Internal Service DNS stays environment-local and the chart requests no discovery/RBAC privileges. |
| A cluster has several environment namespaces | One Helm release in each selected non-production namespace | Each instance has one identity and one set of matching targets. Do not route across the production namespace. |
| Every environment has its own cluster or machines | One Helm/Compose instance in each enabled non-production environment | The physical boundary reinforces, but does not replace, adapter-side disablement. |
| Many small applications need a shared staging tool | One standalone instance attached only to their staging network | Add explicit targets; do not mount the Docker socket or scan the network. |
| A static Kubernetes manifest installation already exists | Follow the [migration pointer](../../deploy/kubernetes/README.md) | Helm is the maintained distribution. |

## Required decisions

Before installation, record:

- the exact instance environment `name` and allowed non-production `kind`;
- every adapter's internal origin and matching `expectedEnvironment`;
- the private user access path (loopback tunnel, VPN/Tailscale ACL, private
  ingress with an allowlist, or an authenticating reverse proxy such as basic
  authentication or SSO in front of the dashboard);
- whether Gauntlet itself requires a password
  ([authentication](authentication.md)), and who holds `GAUNTLET_AUTH_SECRET`;
- the exact image version or digest and chart/package versions;
- how public ingress denies `/_gauntlet/v1` for every application;
- who owns firewall, ingress, DNS, registry, and adapter enablement evidence;
- the single-replica constraint and the accepted loss of in-memory history.

Gauntlet's optional password authentication narrows who can use an instance
that is already private; it is not a reason to expose one. A TLS certificate, private DNS
name, Kubernetes NetworkPolicy, Tailscale route, or container network does not
identify a user. Treat each as one layer of the deployment boundary, not as
application authorization.

## Reject these topologies

Do not deploy when any of the following is true:

- the instance or a target is production, `prod-*`, or ambiguously named;
- a public wildcard ingress forwards the adapter prefix;
- the dashboard is bound to a public wildcard interface;
- a target URL is supplied by a browser or discovered at runtime;
- the container has a Docker socket, Kubernetes token, cluster-wide RBAC, host
  networking, or privileged mode;
- multiple control-plane replicas are requested;
- a multi-replica adapter claims idempotency, cancellation, FIFO, or durable
  runs while using process-local state or per-pod secrets.

There is no production override. Fix the environment or leave the adapter
disabled.

## Standalone does not mean public

The standalone distribution is useful when one Gauntlet controls many
small staging applications. It is still attached only to their private
environment network. For remote testers, terminate an SSH tunnel or approved
VPN/Tailscale route at the loopback-bound dashboard. Never solve reachability
by publishing adapter ports or exposing the dashboard to the Internet.
