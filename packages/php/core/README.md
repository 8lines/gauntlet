# Gauntlet PHP Core

Framework-neutral contracts and runtime for exposing an application's explicitly registered Gauntlet features, operations, and data sources. This package is intended for internal development and non-production test environments. It does not provide HTTP routing, authentication, authorization, or a user interface.

## Install

Version 0.1 requires PHP 8.3 or newer. Releases are published on
[Packagist](https://packagist.org/packages/8lines/gauntlet-php-core) from the
public `8lines/gauntlet-php-core` split repository, so no custom `repositories`
entry or credential is needed:

```bash
composer require 8lines/gauntlet-php-core:^0.1.0
```

The split repository is a read-only release mirror of `packages/php/core` in
[8lines/gauntlet](https://github.com/8lines/gauntlet); send changes there.

## Adapter contracts

- Implement `FeatureProvider` for feature definitions.
- Implement `OperationHandler` for an `OperationDefinition` and its typed execution handler.
- Implement `DataSource` for a `DataSourceDefinition`, cursor query, and ordered value resolution.
- Collect implementations in `FeatureRegistry`, `OperationRegistry`, and `DataSourceRegistry`. Registries keep only safe definitions and expose diagnostics for malformed or duplicate providers.

The core values serialize the Gauntlet v1 wire contract but have no Symfony, JavaScript, HTTP, database, or queue dependency.

## Run lifecycle

`RunManager` validates the request and operation revision, maps input when an `InputMapper` is configured, atomically reserves a queued run, and persists every immutable lifecycle snapshot through `RunStore`.

Provide an explicit stable idempotency HMAC secret of at least 32 bytes. All processes that share a durable `RunStore` must use the same secret. Raw idempotency keys never cross the store boundary.

Implement `RunStore::createQueued()` as an atomic run-and-fingerprint reservation. `updateExactSequence()` must compare the exact previous sequence. Returned store values are treated as untrusted and revalidated by the runtime.

### Execution policy, dispatch and cancellation

`RunManager` enforces `OperationDefinition.execution` rather than treating it
as display metadata:

- `concurrency: null` and `allow` admit executions without an operation limit;
- `forbid` returns `urn:gauntlet:problem:operation-busy` with status 409
  before creating another Run while the operation has a queued or running Run;
- `queue` admits Runs in FIFO order and allows one active handler for the
  operation at a time;
- a positive `timeoutSeconds` deadline is visible through
  `RunContext::isCancelled()` and produces one terminal `timed_out` Run when
  the handler cooperates or returns after the deadline;
- `RunManager::cancel()` signals the active context and uses an exact-sequence
  store transition so cancellation, timeout and a late handler result cannot
  create two terminal states. The operation must declare
  `cancellationSupported: true` even when the addressed Run is already
  terminal; a supported terminal Run is replayed unchanged.

PHP cannot safely hard-kill arbitrary application code inside the current
process. Timeout and active cancellation are therefore cooperative. Handlers
performing long work must call `RunContext::isCancelled()` between bounded
units of work. Context progress, artifact, action, log and warning writes check
the same signal; writes and results observed after cancellation or timeout are
ignored. A handler that never returns or checks the context cannot be forcibly
stopped by this library.

`InlineRunDispatcher` is the backward-compatible default and finishes the task
inside `create()`. Bind an application-owned `RunDispatcher` to retain the
`ExecutionTask` in memory, return the queued Run immediately, and run the task
after the response when an active Run must be cancellable from another request.
`ExecutionTask::run()` returns `true` when no later invocation is required. It
returns `false` when a FIFO predecessor still owns the turn (or another caller
is currently running the same task); the scheduler must keep that same object
and retry it later. The handler itself starts at most once. Queued cancellation
discards the callback so captured input and secrets can be released promptly.
`ExecutionTask` deliberately rejects serialization: it can retain mapped input,
invocation context and secret values, so it must never be placed on a durable or
general-purpose queue. A dispatcher that cannot retain an accepted task must
throw from `dispatch()`.

`InMemoryExecutionCoordinator` is process-local and only suitable for tests or
a genuinely single-process runtime. Multiple PHP workers or pods must bind the
public `ExecutionCoordinator` SPI to a shared DB/Redis implementation and use a
shared `RunStore`. Registration, publication, FIFO turn ownership,
cancellation signals and release must be atomic in that implementation. It
receives only the HMAC idempotency fingerprint, never the raw key. A distributed
implementation also owns lease/recovery for a worker that disappears between
registration and release. Using the in-memory coordinator in a replicated
deployment provides no cross-process concurrency or cancellation guarantee.

`OperationResult::output` is optional and accepts every protocol JSON value.
Use `JsonOwnership::object()` for an explicitly object-shaped root,
`JsonOwnership::list()` for a list, or `JsonOwnership::value()` when the root
may also be a string, number, boolean, or JSON null. `new OperationResult()`
omits `Run.output`; `new OperationResult(output: JsonOwnership::value(null))`
emits an explicit `"output": null`. All variants cross the same deep-ownership,
schema, secret-retention, and RFC 8785 validation boundaries.

Progress counters accept PHP `int` and finite `float` values. They must be
non-negative, may not be negative zero, and `current` may not exceed `total`.

## Schema and input handling

`OpisSchemaValidator` evaluates the supported Draft 2020-12 profile through the pinned Opis engine. Definitions and runtime payloads first pass the portable `tc-schema-core@1` restrictions, including local fragment references and bounded combinators.

Secret and file behavior is declared with `InputHandling`. Secret-handled values are prohibited from persisted runs, problems, logs, output, artifacts, and actions. File-handled operations require a `FileReferenceValidator`; without it, invocation fails with the typed `tc-uploads@1` unsupported-capability problem. Framework adapters may provide their own `InputMapper` and file ownership/expiry validator.

## Verify

From the repository root, use the non-production PHP 8.3 test image. Its PHP
and Composer defaults are immutable digest pins. `PHP_IMAGE` and
`COMPOSER_IMAGE` remain selectable for boundary testing; any override should
also use an immutable digest:

```bash
docker build -f packages/php/Dockerfile -t gauntlet-php-test .
docker build -f packages/php/Dockerfile \
  --build-arg PHP_IMAGE=php:8.3.33-cli-bookworm@sha256:177529735599a8244b2c903522f029839dce1c2ac4be122fdc00ada4b45a20e4 \
  --build-arg COMPOSER_IMAGE=composer:2.10.3@sha256:4d045ea9f71d5d111a95e608400da61d187e487adf9eaf2dfe068998a8d4f584 \
  -t gauntlet-php-test .
docker run --rm --user "$(id -u):$(id -g)" \
  -e COMPOSER_HOME=/tmp/composer \
  -e COMPOSER_CACHE_DIR=/tmp/composer-cache \
  -v "$PWD:/workspace" \
  -w /workspace/packages/php/core \
  gauntlet-php-test composer install --no-interaction --prefer-dist
docker run --rm --user "$(id -u):$(id -g)" \
  -e COMPOSER_HOME=/tmp/composer \
  -e COMPOSER_CACHE_DIR=/tmp/composer-cache \
  -v "$PWD:/workspace" \
  -w /workspace/packages/php/core \
  gauntlet-php-test vendor/bin/phpunit --testsuite unit --do-not-cache-result
docker run --rm --user "$(id -u):$(id -g)" \
  -e COMPOSER_HOME=/tmp/composer \
  -e COMPOSER_CACHE_DIR=/tmp/composer-cache \
  -v "$PWD:/workspace" \
  -w /workspace/packages/php/core \
  gauntlet-php-test composer check-platform-reqs
docker run --rm --user "$(id -u):$(id -g)" \
  -e COMPOSER_HOME=/tmp/composer \
  -e COMPOSER_CACHE_DIR=/tmp/composer-cache \
  -v "$PWD:/workspace" \
  -w /workspace/packages/php/core \
  gauntlet-php-test composer audit --locked --no-interaction
```

[Documentation index](../../../docs/README.md)
