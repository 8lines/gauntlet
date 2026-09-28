# Runs, idempotency, and execution policy

## Create a run

A create-run request identifies the exact operation revision and carries typed
input, invocation context, optional dry-run intent, and an optional or
operation-required idempotency key:

~~~json
{
  "operationRevision": "sha256:<64 lowercase hex characters>",
  "input": {
    "applicationId": "11111111-1111-4111-8111-111111111111",
    "reason": "Tester-requested transition"
  },
  "context": {
    "requestId": "manual-test-001",
    "target": {
      "id": "portal",
      "environment": "staging"
    }
  },
  "dryRun": false,
  "idempotencyKey": "manual-test-001"
}
~~~

The revision above is a placeholder. Fetch the current definition before
submitting a request. If `confirmationRequired` is true, also supply a
`confirmation` containing the matching `operationId`, `operationRevision` and
`impact`. Acknowledgement records intent; it does not authenticate the caller.

## Admission, cancellation and timeout

The SDK runtime owns admission and lifecycle semantics:

- omitted concurrency or `allow` admits independent handlers;
- `forbid` returns `operation-busy` with status 409 while another run owns the
  operation; replay of the same idempotency key is resolved first and returns
  the original run instead of a busy error;
- `queue` accepts runs in FIFO order and starts one handler at a time;
- queue waiting does not consume the operation timeout;
- timeout starts after the handler enters `running`;
- timeout terminalizes the run with `run-timed-out` status 504;
- supported explicit cancellation terminalizes it with `run-cancelled` status
  409;
- an operation with `cancellationSupported: false` always returns
  `run-not-cancellable` status 409 without mutating the run, including when the
  stored run is already terminal;
- cancellation and timeout signal cooperatively and prevent late context
  writes or handler results from mutating the terminal run;
- exactly one immutable terminal transition wins;
- late handler output cannot overwrite cancellation or timeout;
- an execution lease remains held until application code actually settles, so
  side effects from an uncooperative handler cannot overlap a later queued run.

## Persistence and replicas

Raw idempotency keys are HMAC-fingerprinted before persistence. Every replica
sharing a store must use the same stable secret of at least 32 bytes.

In-memory stores and coordinators are intentionally process-local defaults for
tests and single-process development. An adapter spanning multiple processes,
replicas, or pods must provide all of the following:

- a shared durable `RunStore`;
- one stable idempotency secret;
- a distributed `ExecutionCoordinator` for admission, FIFO leases, and
  cancellation publication;
- shared event history and a live event-stream backplane when SSE is exposed;
- recovery rules for a worker that disappears while owning a run.

A shared store alone is not enough to claim cross-replica `forbid`, FIFO,
cancellation, or event guarantees.

## Control-plane history and MCP

REST and MCP share one in-memory projection store. A run created through
either interface can be polled through the other. Lookup, cancellation and
session launch require a run already known to this Gauntlet process; the
control plane does not import arbitrary adapter run IDs.

Restarting Gauntlet loses its projections and dashboard history. It neither
cancels accepted application runs nor undoes their side effects. Disconnecting
an MCP client is also separate from application cancellation.

The dashboard can follow runs through polling or optional REST SSE. MCP uses
`gauntlet_get_run` polling and explicit `gauntlet_cancel_run`; it does not
expose run-event subscriptions.

[REST API](control-plane-api.md) · [MCP](../mcp.md) · [Architecture](../architecture.md)
