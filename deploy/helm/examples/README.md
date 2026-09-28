# Private ingress overlays

These files are narrow ingress overlays. Apply one of them after a complete,
environment-specific values file such as `deploy/helm/ci/staging-values.yaml`.
They do not contain the required Gauntlet instance or adapter configuration.

Gauntlet v0.1 has no authentication. A private route, TLS certificate, VPN,
or tailnet does not authenticate a caller. Keep the dashboard and adapter APIs
outside public ingress, and independently enforce firewall rules, identity-aware
access policy, and least-privilege network access.

## Private ALB

`private-alb-values.yaml` selects the AWS Load Balancer Controller, requires an
internal ALB with Pod IP targets, and starts with `10.0.0.0/8` as a deliberately
broad private-network example. Replace that CIDR with the smallest verified
tester/VPN ranges before deploying. In v0.1 every entry must be a canonical,
network-aligned RFC1918 IPv4 CIDR: a subnet of `10.0.0.0/8`, `172.16.0.0/12`,
or `192.168.0.0/16`. Public ranges, IPv6, CGNAT, invalid/host-bit notation and
prefixes broader than their enclosing private block are rejected. Supporting a
different source range requires a separately reviewed chart change; do not
weaken this check in a values overlay. Internet-facing ALBs, public frontend
NLBs, and frontend EIP allocations are also rejected.

The chart does not install or configure the AWS Load Balancer Controller, DNS,
certificates, security groups, or authentication. Those remain external operator
responsibilities. Audit every additional annotation against the controller
version and the environment's actual network boundary.

## Tailscale

`tailscale-values.yaml` uses the Tailscale Kubernetes operator's hostless HTTP
rule and asks the operator for the short MagicDNS label `gauntlet`. The
operator supplies the tailnet suffix and controller-managed TLS material. Install
and configure the operator separately, review tailnet ACLs/grants, and verify the
route from a tester device. The chart rejects Tailscale Funnel even when its
annotation value is the string `false`; do not publish this service with Funnel.

## Other controllers

The generic chart shape can target another explicitly named ingress class, but
the chart cannot prove that an arbitrary controller is private. Treat such an
overlay as untrusted until its routes, source allow-list, TLS handling, and
public-ingress denial have been independently reviewed and tested.

[Documentation index](../../../docs/README.md)
