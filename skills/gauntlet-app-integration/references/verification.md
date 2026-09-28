# Verification and completion

Keep captured output bounded and redact secret values, authorization headers, cookies, raw idempotency keys, and registry credentials. Record exact command, exit status, relevant response status/media type/problem type, environment endpoint, and observation time.

## Required evidence

1. **Disabled prefix:** with the adapter disabled, probe canonical and malformed adapter requests through each real proxy path; application handlers must remain unreachable and the documented disabled response must win where the stack owns the request.
2. **Startup denial:** start or compile configuration with the built-in production-like names/kinds and with each required metadata/secret reference missing. Separately prove that every organization-specific production alias and physical identity mapping (account/project/subscription, cluster, namespace/project, hostname) blocks deployment or enablement. Unknown or ambiguous identity remains disabled.
3. **Environment mismatch:** make the target expectation differ by name and by kind, one at a time, through every control-plane proxy path. Discovery and execution must stop.
4. **One transport:** inspect framework routes and make requests to canonical, trailing-slash, duplicate-slash, encoded, and ordinary application paths. Exactly one normalized mount owns the prefix.
5. **Live protocol contract:** exercise the deployed private adapter, not an in-process handler or synthetic receipt. Use application-specific disposable inputs and assert its real catalog, schema rejection, run lifecycle, data sources, and every advertised optional capability. The released base/extended conformance scenarios are SDK-fixture-specific; use them only when the application intentionally implements that exact fixture catalog. If using the runner with another scenario, author and review the complete matching scenario, and provide separate enabled and disabled origins for extended mode.
6. **Public denial:** from outside the private boundary, probe canonical, encoded, case/underscore, duplicate-slash, and absolute-form variants on every public hostname. A 404 generated only after forwarding is not proof of ingress denial; capture the responsible edge policy/log or equivalent evidence.
7. **Private dashboard:** prove its bind/Service/ingress/ACL path and prove browsers cannot reach application adapters directly.
8. **Runtime truth:** record current and planned application replica/process count, stable secret reference identity, store, coordinator, process-local non-serializing dispatcher, cancellation publication, and process-loss behavior. Prove either a singleton process-bound lifecycle with no durability claim, or leases/heartbeats that terminalize orphaned/stale runs and recover through a new application execution. Shared state may coordinate admission and cancellation visibility but cannot replay or resume the lost closure/task; never claim durable execution replay. When SSE is advertised, include shared durable event history and its live-stream backplane, without conflating event durability with execution durability. Do not print the secret.
9. **Session launch:** when advertised, prove the configured target `publicUrl`, returned-origin equality, single-use behavior, and browser isolation.

When a required environment is unavailable, preserve the exact runnable command and state `not run`; do not write `PASS`. Configuration parsing, fixture-specific `--probe` commands, unit tests, and rendered manifests remain useful evidence but cannot replace live HTTP/network observations.

## Completion report

Use this shape:

```text
Changed files
- exact path and purpose

Environment evidence
- actual account/project/subscription, cluster, namespace/Compose project, hostname, organization-specific production mapping, and adapter manifest identity

Network evidence
- private dashboard path, private adapter path, public-denial observations

Runtime evidence
- current/planned replicas/processes, secret reference, store/coordinator/cancellation ownership, and singleton or orphan/stale-run terminalization evidence

Tests
- command => exit/status and bounded decisive output

Unresolved risk
- none, or each missing live/infrastructure proof

Verdict
- complete only when every gate and live check passed; otherwise incomplete with adapter disabled
```

Before a complete verdict, confirm `Unresolved risk` says `none`, the target expectation equals the live manifest, and evidence comes from the exact deployment being enabled. A fixture/configuration may be complete while the integration remains incomplete.
