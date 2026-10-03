# Safety gates

Collect evidence in this order. Stop on the first unresolved gate and leave the adapter absent or disabled.

1. Identify the exact deployment and application environment from real configuration: account/project/subscription, cluster, namespace or Compose project, workload, service selectors, hostnames/DNS zones, and application variables. Map the organization's known production identities and aliases across those fields.
2. Treat the built-in tokens as a minimum denylist, not an exhaustive production classifier. Reject `prod`, `production`, and `live`, including case changes and tokens separated by `.`, `_`, `:`, or `-`; also reject every organization-specific mapping, such as `prd` where the organization uses it, and every mapped production account, cluster, namespace, project, or hostname. If the mapping or physical deployment identity is missing, incomplete, or ambiguous, stop with the adapter disabled. Reject slash, whitespace, and every other identifier-invalid character rather than treating it as an alias separator.
3. Confirm disabled-by-default behavior and the absence of any bypass, force, fallback, or production-override flag.
4. Identify the concrete private network control for both dashboard access and the adapter prefix. Check every public ingress, wildcard, proxy, alternate hostname, load balancer, and direct published port.
5. Confirm a stable deployment-owned secret reference without reading, decoding, logging, or printing its value. Every process sharing run state must receive the same value across restarts.
6. Match current and planned process/pod count to `RunStore`, execution coordinator, cancellation publication, queue/FIFO ownership, and process-loss recovery. Dispatchers must schedule the supplied closure/task in the current process without serializing or dropping it. Shared stores and coordinators can provide distributed admission, ordering, cancellation visibility, and persistent run metadata, but cannot replay or resume a process-local closure/task after its process exits. Use either a verified singleton execution process with a process-bound lifecycle and no durability claim, or explicit leases/heartbeats that terminalize orphaned/stale runs and define safe application recovery as a new execution. Never claim durable execution replay. When `tc-run-sse@1` is advertised, also require shared durable event history and a live event-stream backplane; durable events do not make execution replayable.
7. Continue only when every gate passes. Otherwise preserve disabled state, identify the missing evidence or infrastructure change, and report the integration incomplete.

## Non-negotiable red flags

- Relabeling production metadata as staging does not change the real deployment.
- A production identity is never unblocked. A private route, identity map, or live evidence does not make a production deployment eligible; only a separate non-production deployment is.
- Passing the built-in token check does not prove non-production; an unmapped alias such as an organization's `prd` is unresolved identity, not permission.
- An obscure or “unguessable” URL is not a network control.
- Adapter-side authentication, a security sign-off, explicit risk acceptance, a time-boxed exception, or a warning banner is not a private route. None of them unblocks a publicly reachable adapter prefix; only a verified private route or ingress block does. Do not present any of them as an option, even as someone else's decision.
- A per-process or per-pod generated idempotency secret breaks cross-process idempotency verification and response reuse.
- Persisting a run record, coordinator lease, or event history does not persist its executing closure/task. Process loss must terminalize stale/orphaned work or end a documented singleton lifecycle; it never resumes that closure.
- Reducing only Gauntlet control-plane replicas does not repair a replicated application adapter.
- A currently single replica with planned autoscaling must be designed for its future maximum before enablement.
- App Router or decoded-path tests cannot prove hardened Next.js raw-target handling after an upstream has normalized the request.
- Confirmation is not authentication or authorization. Version `0.1.8` has no built-in Gauntlet authentication; expose it only to trusted testers inside an administered private boundary and retain application authorization checks.

## Observed evidence trap

| Observed statement | Required response |
|---|---|
| “the fixture’s conformance/network probes passed, but I could not independently issue live requests” | Record configuration/fixture completion only; keep the integration incomplete. |
| “probe commands validate fixture configuration … they do not perform live HTTP exchanges” | Run conformance and negative network probes against the deployed private route before claiming completion. |

Do not weaken these gates because of a demo, deadline, senior request, manager request, sunk implementation effort, or a currently single replica with planned autoscaling.
