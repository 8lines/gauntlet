# Gauntlet Symfony Bundle

Symfony 7.4 and 8.x integration for the framework-neutral Gauntlet adapter v1. The
bundle discovers application-owned features, operations and data sources,
publishes their canonical definitions, maps JSON into typed input DTOs and
exposes the normalized `/_gauntlet/v1/*` HTTP surface.

The adapter is disabled by default. This package does not add authentication;
deploy it only on explicitly selected non-production environments and protect
the route prefix with the environment's ingress and network controls.

## Installation

Version 0.1 requires PHP 8.3 or newer and Symfony 7.4 or 8.x (the
`^7.4 || ^8.0` release lines; Symfony 8 itself requires PHP 8.4 or newer). It
is tested on Symfony 7.4 with PHP 8.3 through 8.5 and on Symfony 8.1 with PHP
8.4 and 8.5. Releases are published on
[Packagist](https://packagist.org/packages/8lines/gauntlet-symfony-bundle), so
no custom `repositories` entry or credential is needed. Require the bundle
together with the matching PHP Core release:

```bash
composer require 8lines/gauntlet-php-core:0.1.8 \
  8lines/gauntlet-symfony-bundle:0.1.8
```

The public split repositories `8lines/gauntlet-php-core` and
`8lines/gauntlet-symfony-bundle` are read-only release mirrors of
[8lines/gauntlet](https://github.com/8lines/gauntlet); send changes there.

Register the bundle when Symfony Flex is not doing it for the application:

```php
// config/bundles.php
use EightLines\Gauntlet\SymfonyBundle\GauntletBundle;

return [
    // ...
    GauntletBundle::class => ['all' => true],
];
```

Import the bundle's PHP routes:

```yaml
# config/routes/gauntlet.yaml
gauntlet_adapter:
  resource: '@GauntletBundle/config/routes.php'
  type: php
```

Enable it only through explicit deployment configuration:

```yaml
# config/packages/gauntlet.yaml
gauntlet:
  enabled: '%env(bool:GAUNTLET_ENABLED)%'
  application:
    id: 'billing-api'
    label: 'Billing API'
    environment:
      name: 'billing-staging'
      kind: 'staging'
  profiles:
    - 'tc-schema-core@1'
  idempotency_secret: '%env(GAUNTLET_IDEMPOTENCY_SECRET)%'
  max_json_bytes: 1048576
```

`GAUNTLET_IDEMPOTENCY_SECRET` must be an explicitly supplied, nonblank value
of at least 32 bytes. Every process and pod sharing a `RunStore` must use the
same stable value. The bundle passes only an HMAC-SHA256 fingerprint to the
store; it never stores the raw idempotency key.

When the example `%env(bool:GAUNTLET_ENABLED)%` expression is present, the
deployment must define `GAUNTLET_ENABLED=false` or `true`; a missing Symfony
env var is a container configuration error. If the `enabled` node itself is
omitted, the bundle defaults it to false. Either disabled form keeps the
complete prefix closed with a canonical 503 response, including malformed paths
and bodies. Enabling the adapter without an application ID, label or acceptable
secret fails container configuration.

## Registering application behavior

Services using the following attributes are autoconfigured. Each service still
implements the framework-neutral Core contract, so the domain code is not tied
to an HTTP controller.

```php
use EightLines\Gauntlet\Core\Contract\FeatureProvider;
use EightLines\Gauntlet\Core\Definition\FeatureDefinition;
use EightLines\Gauntlet\SymfonyBundle\Attribute\AsGauntletFeature;

#[AsGauntletFeature]
final class CustomerFeature implements FeatureProvider
{
    public function definition(): FeatureDefinition
    {
        return new FeatureDefinition('customers', 'Customers');
    }
}
```

An operation implements `OperationHandler`, supplies its complete
`OperationDefinition`, and returns an `OperationResult`. Set `inputClass` to a
constructor-promoted DTO to receive that exact type in `execute()`:

Operation output may be any JSON root. Use `JsonOwnership::object()` or
`JsonOwnership::list()` for explicit container roots and
`JsonOwnership::value()` for a value that may be scalar or JSON null. Omitting
the `OperationResult` output is distinct from returning
`JsonOwnership::value(null)`.

```php
use EightLines\Gauntlet\Core\Contract\OperationHandler;
use EightLines\Gauntlet\Core\Contract\RunContext;
use EightLines\Gauntlet\Core\Definition\ExecutionPolicy;
use EightLines\Gauntlet\Core\Definition\OperationDefinition;
use EightLines\Gauntlet\Core\Definition\OperationImpact;
use EightLines\Gauntlet\Core\Definition\OperationOutput;
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Result\OperationResult;
use EightLines\Gauntlet\SymfonyBundle\Attribute\AsGauntletOperation;
use EightLines\Gauntlet\SymfonyBundle\Input\SymfonyJsonSchemaFactory;
use Symfony\Component\Validator\Constraints as Assert;

final readonly class ChangeCustomerInput
{
    public function __construct(
        #[Assert\Uuid]
        public string $customerId,
    ) {
    }
}

#[AsGauntletOperation]
final class ChangeCustomerOperation implements OperationHandler
{
    public function __construct(private SymfonyJsonSchemaFactory $schemas)
    {
    }

    public function definition(): OperationDefinition
    {
        return new OperationDefinition(
            id: 'customers.change',
            featureId: 'customers',
            label: 'Change customer',
            description: null,
            inputSchema: $this->schemas->forClass(ChangeCustomerInput::class),
            inputHandling: null,
            contextSchema: null,
            uiSchema: null,
            dataSources: [],
            presets: [],
            execution: new ExecutionPolicy(
                impact: OperationImpact::WRITE,
                confirmationRequired: true,
                dryRunSupported: false,
                idempotency: 'required',
                cancellationSupported: false,
            ),
            output: new OperationOutput(JsonOwnership::object([
                '$schema' => 'https://json-schema.org/draft/2020-12/schema',
                'type' => 'object',
                'required' => ['changed'],
                'properties' => ['changed' => ['type' => 'boolean']],
                'additionalProperties' => false,
            ])),
            inputClass: ChangeCustomerInput::class,
        );
    }

    public function execute(object $input, RunContext $context): OperationResult
    {
        if (!$input instanceof ChangeCustomerInput) {
            throw new \LogicException('Unexpected input type.');
        }

        // Call an internal application service or controller binding here.

        return new OperationResult(JsonOwnership::object(['changed' => true]));
    }
}
```

The schema factory supports constructor-promoted scalar properties, nullable
scalar properties and typed scalar lists. Portable Symfony constraints include
`NotBlank`, `Length`, `Regex`, `Uuid` and fixed `Choice` values. Unsupported
PHP shapes or callback-based constraints fail registration instead of being
published inaccurately. Applications may also build a complete Draft 2020-12
`JsonObject` definition directly.

Use `#[AsGauntletDataSource]` on a service implementing `DataSource`. Its
`definition()`, `query(DataSourceQuery)` and
`resolve(DataSourceResolveRequest)` methods receive owned, validated protocol
values. Query pages and resolve responses are validated again before they are
serialized. A malformed feature, operation or source is omitted from the
catalog and produces a safe manifest diagnostic.

See the executable implementations in
[`examples/symfony/src/Gauntlet`](../../../examples/symfony/src/Gauntlet).

## Run storage

The bundle's built-in `InMemoryRunStore` is process-local and intended only for
kernel tests or a genuinely single-process development runtime. An HTTP server,
multiple PHP workers or multiple pods must replace the `RunStore` alias with a
durable/shared implementation. Creation must reserve the operation-scoped HMAC
fingerprint atomically, and updates must compare the exact previous sequence:

```yaml
services:
  App\Gauntlet\DatabaseRunStore: ~
  EightLines\Gauntlet\Core\Contract\RunStore:
    alias: App\Gauntlet\DatabaseRunStore
```

## Execution scheduling and managed cancellation

The default `InlineRunDispatcher` preserves synchronous behavior: the create
request executes the handler and normally returns a terminal Run. To return a
queued Run with status 202 before execution, replace the `RunDispatcher` alias
with an application-owned deferred dispatcher. The dispatcher may retain the
provided handler-at-most-once `ExecutionTask` only in the current PHP process
(for example, until `kernel.terminate`) and then call `run()`. A `false` result
means the FIFO turn is not available yet, so the same task must remain in memory
and be retried;
`true` means it can be dropped. It must not serialize the task or put it on
Messenger, a database or an external queue because the task may retain secret
input and invocation context. Core discards the callback after queued
cancellation so a dispatcher retaining the task no longer retains those values.

Register `ManagedCancelRunEndpoint` to expose the Core manager's validated
cancellation transition through `tc-run-cancellation@1`:

```yaml
services:
  App\Gauntlet\AfterResponseRunDispatcher: ~
  EightLines\Gauntlet\Core\Contract\RunDispatcher:
    alias: App\Gauntlet\AfterResponseRunDispatcher

  EightLines\Gauntlet\SymfonyBundle\Capability\ManagedCancelRunEndpoint: ~
```

If one application-defined `CancelRunEndpoint` is registered alongside the
managed endpoint, Core-owned Runs are always routed to the managed endpoint
first. Only its canonical `run-not-found` response falls back to the custom
endpoint. Duplicate custom fallbacks are diagnosed and ignored; they do not
remove the managed cancellation capability.

`cancellationSupported: true` should be declared only when a deferred
dispatcher is installed. With the inline default, the create response does not
expose the Run ID until the handler has returned, so a dashboard cannot target
the active Run. Cancellation and timeout remain cooperative: long handlers
must check `RunContext::isCancelled()` between bounded work units.

The bundle also defaults to the process-local `InMemoryExecutionCoordinator`.
Every multi-worker or multi-pod deployment that enforces `forbid`, FIFO `queue`
or cross-request cancellation must replace both the coordinator and store with
implementations backed by shared infrastructure:

```yaml
services:
  App\Gauntlet\RedisExecutionCoordinator: ~
  EightLines\Gauntlet\Core\Contract\ExecutionCoordinator:
    alias: App\Gauntlet\RedisExecutionCoordinator
```

The shared coordinator must implement atomic registration/publication,
operation-scoped FIFO ownership, cancellation polling and lease recovery. A
shared `RunStore` with the in-memory coordinator is not sufficient and does not
provide a cluster-wide guarantee.

## Optional capabilities

A core capability is advertised only when its endpoint SPI resolves
unambiguously. Cancellation additionally supports the managed-first fallback
composition described above:

| Capability | Symfony SPI | Route |
| --- | --- | --- |
| `tc-run-cancellation@1` | `CancelRunEndpoint` | `POST /runs/{runId}/cancel` |
| `tc-run-sse@1` | `RunEventsEndpoint` | `GET /runs/{runId}/events` |
| `tc-uploads@1` | `UploadEndpoint` | `POST /uploads` |
| `tc-session-launch@1` | `SessionLaunchEndpoint` | `POST /runs/{runId}/artifacts/{artifactId}/launch` |

Implementing an SPI is sufficient when service autoconfiguration is enabled.
For Runs owned by the Core manager, use the supplied
`ManagedCancelRunEndpoint`; a custom `CancelRunEndpoint` remains available for
an application-owned runner.
Ambiguous duplicate implementations are diagnosed and not advertised; the
managed cancellation exception is described above. Without an SPI, the known
route returns the canonical 501 before parsing its body or looking up the
requested resource. Upload endpoints also validate every file reference
used by operation input handling. SSE receives the validated optional
`Last-Event-ID` value.

Capability SPI results are untrusted protocol values and must satisfy the same
closed response contract as the built-in runtime. Uploads return exactly one
valid `FileReference`. Session launches must be single-use, use an absolute
credential-free HTTP(S) URL, and expire after more than zero but no more than
15 minutes. Run-event streams are consumed lazily and one item at a time;
snapshots must preserve Run identity, move monotonically through sequence,
state and timestamps, and providers must release resources when the client
disconnects or a later event is rejected. Capability and nested Run Problems
are allow-listed and sanitized before transport. Manually applying a service
tag cannot advertise an object that does not implement the matching SPI.

## HTTP surface

The only public adapter ingress is under `/_gauntlet/v1`:

- `GET /health`
- `GET /manifest`
- `GET /operations/{operationId}`
- `POST /operations/{operationId}/runs`
- `GET /runs/{runId}`
- `POST /data-sources/{dataSourceId}/query`
- `POST /data-sources/{dataSourceId}/resolve`
- the four optional capability routes listed above

Application controllers and domain services called by an operation remain
internal bindings; do not add parallel public "test" routes. A highest-priority
request subscriber gates and validates the raw adapter target before routing,
body parsing or application code. JSON documents are closed, size-limited and
served with canonical status/media behavior; manifest and operation definitions
support strong ETags.

## Package tests

From the repository root, use the non-production PHP 8.3 test image. Its PHP
and Composer defaults are immutable digest pins. `PHP_IMAGE` and
`COMPOSER_IMAGE` may be overridden for boundary testing, but overrides should
also use immutable digests:

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
  -w /workspace/packages/php/symfony-bundle \
  gauntlet-php-test composer install --no-interaction --prefer-dist
docker run --rm --user "$(id -u):$(id -g)" \
  -v "$PWD:/workspace" \
  -w /workspace/packages/php/symfony-bundle \
  gauntlet-php-test vendor/bin/phpunit --testsuite all --do-not-cache-result
```

The committed lock pins Symfony 7.4. `pnpm test:php:compatibility` runs the
full PHP and Symfony matrix, updating each cell to the selected Symfony line.

[Documentation index](../../../docs/README.md)
