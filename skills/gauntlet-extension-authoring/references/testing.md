# Extension verification

Write the first failing target-application test before implementation. Test
observable catalog/runtime behavior and the real application boundary; do not
assert that source text contains a phrase or that a mock exists.

## Required layers

1. **Definition:** SDK semantic validation accepts the feature, operation, data
   source, UI pointers, profiles/capabilities, and canonical revision. Invalid
   or duplicate definitions remain unavailable.
2. **Schema boundary:** valid input maps to the intended type. Missing, unknown,
   malformed, oversized, and non-portable values are rejected before the
   handler. Context and output schemas receive the same treatment.
3. **Application boundary:** an authorized synthetic request calls exactly one
   fixed service with mapped business values. Missing actor/context,
   cross-tenant entities, forbidden transitions, and non-synthetic domain data
   are denied before mutation.
4. **Execution runtime:** missing/stale/wrong-impact confirmation is denied when
   required. Pass `idempotencyKey` through create-run/store admission; treat
   `requestId` only as correlation. Test that the same key with changed valid
   input or request ID returns the original Run and causes zero second mutation.
   Exercise concurrency, timeout, and cooperative cancellation only when
   declared.
5. **Retention and output:** invalid handler output becomes the canonical safe
   adapter error. Secret/file inputs, raw idempotency keys, credentials,
   internal exception text, private entity fields, and server paths never
   appear in stores, logs, Problems, output, artifacts, actions, or snapshots.
6. **Framework path:** use the existing Symfony, Node, Next.js, or Spring
   catalog and actual framework transport. Prove the operation/data source is
   discoverable and executable without adding a route. Run the applicable
   language-neutral conformance scenario when it models this catalog.

## Conditional evidence

- `dryRunSupported=true`: invoke through the runtime with dry-run set, prove
  the handler observes it, and keep a dependency-level repository/publisher
  mutation counter at zero. Also test the real mutation path. A returned
  “preview” value is not a sentinel.
- destructive: test missing/wrong acknowledgement, correct acknowledgement,
  original-run replay after changed input, zero second mutation, domain denial,
  and bounded recovery behavior.
- data source: run every bound, cursor, ordering, resolve, tenant, output, and
  leak case in the data-source guide.
- secret/file: test semantic attribution, absence from presets, byte/media/count
  limits, adapter-issued reference validation, non-retention, and sanitized
  failure.
- cancellation/timeout/progress/events/session launch: test the installed SPI,
  terminal-state race behavior, late-output rejection, origin/expiry/single-use
  guarantees, and actual framework response.

## Completion record

Report exact changed files and why each belongs to application extension code.
Record commands, exit status, and bounded decisive output. Separate focused
unit tests, framework integration, synthetic conformance, and any deployed
observation; one does not imply another. Redact secrets, cookies, authorization
headers, raw keys, cursor signing keys, and private data.

Do not complete from a definition snapshot, UI screenshot, type-check, happy
path, or synthetic harness alone. `Unresolved risk` must name every unrun layer
or unverifiable authorization/runtime assumption. The verdict is complete only
when all applicable layers pass and the diff contains no transport, deployment,
ingress, network, or production-enablement change.
