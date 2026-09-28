# PHP Core and Symfony Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a framework-independent PHP runtime and a Symfony Bundle that exposes the complete mandatory Gauntlet v1 adapter surface with typed operations and data sources.

**Architecture:** Immutable PHP core objects implement owned JSON values, portable schema validation, shared document semantics, canonical revisions, registries, problems, and a synchronous run lifecycle without Symfony dependencies. The Symfony Bundle adds DI autoconfiguration, DTO schema/input mapping, a highest-priority raw-prefix gate, normalized HTTP controllers, optional endpoint SPIs, and an executable reference fixture.

**Tech Stack:** PHP 8.5, PHPUnit 11.5, Symfony 7.4 components, Symfony Validator and Serializer, Composer 2, `opis/json-schema:2.6.0`, and the approved composed JCS boundary using exact `onematrix/tracing-sdk:1.1.0`; tests run through the repository PHP test image because the host has no PHP runtime.

**Spec:** `docs/superpowers/specs/2026-08-29-gauntlet-backend-adapter-architecture-design.md`

## Global Constraints

- The prerequisite order is frozen: accepted shared predicate export
  `6acfafc` and unavailable-operation policy `a0385c3`; accepted semantic
  remediation `1d48d19`; accepted runtime-scalar authority `943dacb`; accepted
  ephemeral invocation-context lease `a658a97`/`0bb090a`
  (`feat(ts-core): expose ephemeral invocation context`); accepted semantic
  vectors `e4cfb4f`/`b2e6212` from
  `.superpowers/sdd/2026-08-29-upstream-remediation/semantic-vectors-brief.md`;
  accepted protocol-control-plane Task 6 using
  `task-6-implementation-brief-v2.md` and its
  unchanged `conformance/scenarios/adapter-v1.json`; then PHP Core, Symfony
  Bundle, the Symfony fixture, and the separate example portal consumer slice.
  No PHP production work may precede those accepted inputs.
- Composer packages are `8lines/gauntlet-php-core` and `8lines/gauntlet-symfony-bundle`.
- PHP namespaces are `EightLines\Gauntlet\Core` and `EightLines\Gauntlet\SymfonyBundle`.
- The bundle is disabled by default and exposes no executable operation not explicitly registered.
- Custom application controllers are internal bindings; external callers use only `/_gauntlet/v1/*`.
- Input FQCNs never appear in serialized protocol documents.
- Stack traces, SQL, secrets, and raw exception messages never appear in default Problems.
- Symfony 7.4 is the required tested baseline because the example portal consumer application uses it.
- PHP 8.5 is the required tested baseline because the example portal consumer application requires `php >=8.5`.
- Every adapter-supplied schema is Draft 2020-12, first passes the port of
  `tc-schema-core@1`, and is then evaluated through a framework-neutral
  `SchemaValidator` SPI. Remote and relative resource retrieval is disabled;
  only fragment `$ref` values inside the supplied schema are resolvable.
- PHP ports the accepted pure `manifestSemanticsAreValid`,
  `operationSemanticsAreValid`, and `resolveSemanticsAreValid` predicates and
  consumes the exact shared pattern/JCS fixtures. In particular,
  `ProtocolSemanticsTest` loads
  `adapter-semantic-vectors.json`,
  `adapter-semantic-vectors.schema.json`,
  `tc-schema-core-pattern-vectors.json`, and
  `jcs-revision-vectors.json` by repository path, verifies source hashes,
  evaluates all document rows and only the four closed workload recipe kinds,
  and enforces the recorded analyzer ceilings. A PHP-only interpretation of
  feature trees, UI/data-source references, requirements, presets, or resolve
  ordering is not allowed.
- The manifest retains every valid operation summary and its declared
  requirements even when availability is `unavailable`. A malformed binding
  is omitted and diagnosed; a diagnostic for an operation whose identity was
  not safely established omits `operationId`.
- Profiles and capabilities describe implemented adapter behavior. A generic
  future versioned capability is retained only when a registered
  `CapabilityProvider` implements it; each of the four core capabilities is
  advertised only when its matching endpoint SPI is installed. No configuration
  string advertises a capability. An absent SPI returns the exact typed 501
  before body parsing or resource lookup.
- Runtime boundaries deep-own JSON without converting an object to a list or a
  list to an object. Empty object is serialized as `{}`, empty list as `[]`,
  null is preserved, hostile keys such as `__proto__` remain ordinary owned
  keys, and lone surrogates are rejected.
- Input, complete raw `InvocationContext`, pointer-keyed data-source
  dependencies, data-source context, handler output, data-source responses,
  secret/file paths, stored Runs, artifacts, and follow-up actions are
  validated before use or persistence. Context and dependency schemas validate
  the complete raw wire objects, never projections.
- Idempotency keys are never stored or logged. Stores receive only
  `HMAC-SHA256(secret, "tc-idempotency:v1\0" + operationId + "\0" + key)`;
  a durable/shared store requires one stable secret across all processes.
  Queued creation plus fingerprint reservation is atomic, duplicates reread
  the winning stored Run, and every update compares the exact previous
  sequence.
- `RunContext::invocationContext()` exposes a deeply owned context only while
  the handler is open and returns `null` after success or failure. The runtime
  never copies context into a Run automatically.
- A highest-priority Symfony `kernel.request` subscriber inspects the raw
  request target for every `/_gauntlet/v1` request before routing,
  controller argument resolution, or body/multipart parsing. Disabled 503 wins
  for the entire prefix; percent, whitespace, query, fragments, unsafe IDs,
  extra/trailing segments, and wrong methods are normalized at that boundary.
- Container commands use the host UID/GID plus writable `/tmp` Composer home
  and cache when writing into bind mounts; no root-owned `vendor` or cache files
  are left in the checkout.
- Do not modify or run tests in the example portal consumer application in this plan; its package-consumer integration follows after the package has a VCS distribution URL.

The HTTP status contract is fixed: health/manifest/definition/poll/query/resolve
are 200; matching strong ETag is a bodyless 304; a terminal create is 201 and
an active create is 202; cancel accepted is 202; upload and session launch are
201; malformed JSON or invalid raw path is 400; a safe missing resource is 404;
a known path with wrong method is 405; stale revision is 409; protocol-invalid
JSON is 422; an unadvertised optional capability is 501; and the disabled prefix
is 503. Successful JSON uses `application/json`; errors use
`application/problem+json` and `Problem.status` equals HTTP status. A failed
Run's nested Problem does not turn polling into an HTTP error.

---

### Task 1: Immutable PHP Core Definitions and Canonical Revisions

**Files:**
- Create: `packages/php/core/composer.json`
- Create: `packages/php/core/composer.lock`
- Create: `packages/php/core/phpunit.xml.dist`
- Create: `packages/php/core/src/Json/JsonObject.php`
- Create: `packages/php/core/src/Json/JsonList.php`
- Create: `packages/php/core/src/Json/JsonValue.php`
- Create: `packages/php/core/src/Json/JsonOwnership.php`
- Create: `packages/php/core/src/Json/Rfc8785CanonicalJson.php`
- Create: `packages/php/core/src/Json/CanonicalJsonException.php`
- Create: `packages/php/core/src/Schema/SchemaValidator.php`
- Create: `packages/php/core/src/Schema/OpisSchemaValidator.php`
- Create: `packages/php/core/src/Schema/TcSchemaCore.php`
- Create: `packages/php/core/src/Schema/ProtocolSemantics.php`
- Create: `packages/php/core/src/Protocol/ProtocolId.php`
- Create: `packages/php/core/src/Protocol/ProtocolRequirements.php`
- Create: `packages/php/core/src/Protocol/ProtocolExtensions.php`
- Create: `packages/php/core/src/Definition/FeatureDefinition.php`
- Create: `packages/php/core/src/Definition/OperationDefinition.php`
- Create: `packages/php/core/src/Definition/ExecutionPolicy.php`
- Create: `packages/php/core/src/Definition/OperationImpact.php`
- Create: `packages/php/core/src/Definition/InputHandling.php`
- Create: `packages/php/core/src/Definition/OperationUiSchema.php`
- Create: `packages/php/core/src/Definition/OperationPreset.php`
- Create: `packages/php/core/src/Definition/OperationOutput.php`
- Create: `packages/php/core/src/Definition/DataSourceReference.php`
- Create: `packages/php/core/src/Definition/DataSourceDefinition.php`
- Create: `packages/php/core/src/Manifest/AdapterManifest.php`
- Create: `packages/php/core/src/Manifest/OperationSummary.php`
- Create: `packages/php/core/src/Manifest/ManifestBuilder.php`
- Create: `packages/php/core/src/Problem/Problem.php`
- Create: `packages/php/core/src/Problem/ValidationError.php`
- Create: `packages/php/core/src/Result/Artifact.php`
- Create: `packages/php/core/src/Result/FileReference.php`
- Create: `packages/php/core/src/Result/OperationResult.php`
- Test: `packages/php/core/tests/Unit/Json/Rfc8785CanonicalJsonTest.php`
- Test: `packages/php/core/tests/Unit/Json/JsonOwnershipTest.php`
- Test: `packages/php/core/tests/Unit/Schema/SharedPatternVectorsTest.php`
- Test: `packages/php/core/tests/Unit/Schema/SchemaValidatorTest.php`
- Test: `packages/php/core/tests/Unit/Schema/ProtocolSemanticsTest.php`
- Test: `packages/php/core/tests/Unit/Definition/OperationDefinitionTest.php`
- Test: `packages/php/core/tests/Unit/Problem/ProblemTest.php`
- Test: `packages/php/core/tests/Unit/Manifest/ManifestBuilderTest.php`
- Create: `packages/php/Dockerfile`

**Interfaces:**
- Consumes: canonical wire schemas and the exact published
  `packages/protocol/fixtures/v1/adapter-semantic-vectors.json`, companion
  `adapter-semantic-vectors.schema.json`, `tc-schema-core-pattern-vectors.json`,
  and `jcs-revision-vectors.json` artifacts accepted before Task 6.
- Produces: immutable definitions with `toProtocolArray()` and content-derived
  `revision()`, owned `JsonObject`/`JsonList` values, `SchemaValidator`,
  `OpisSchemaValidator`, `TcSchemaCore`, and `ProtocolSemantics`.

- [ ] **Step 0: Verify the approved composed JCS engine before production work**

In an isolated PHP 8.5 Composer consumer, resolve only exact
`onematrix/tracing-sdk:1.1.0` at commit
`a1592326fd45cb3e0f0aa8295cfbb2338de9855b`. Verify the measured distribution
SHA-256 `025d30484f3fb4bd94990185d3ef11eed3ad0f5ff008880c760c9f7dcb161065`,
MIT metadata, the declared `ext-json`, `ext-dom`, `ext-libxml`, `ext-curl`, and
`ext-mbstring` requirements, `composer audit --locked`, and
`composer check-platform-reqs`. Plugins and ignored platform requirements are
forbidden.

The known 16-row JCS artifact has 13 successes, three controlled rejections,
algorithm `RFC8785+SHA-256`, and SHA-256
`63f9ba7a02c03e062dada836757d8d885c3fd1304d13993fa2cda7aa4a823152`.
The composed public boundary must pass all 71/71 ownership/shape/scalar/
Unicode/depth/cycle/alias/precision assertions and the engine must pass all
26/26 RFC 8785 Appendix B rows. `root23/php-json-canonicalization:1.0.1` is a
rejected candidate because it fails the `5e-324` and `1e-320` cases; it is not
a production dependency. The raw OneMatrix engine is intentionally only 15/16
without the Gauntlet scalar guard: the application rejects its unsafe
non-exponential integral before raw JSON reaches the engine. Never repair,
trim, decode/re-encode, regex-rewrite, or otherwise alter vendor output. Any
receipt, platform, audit, vector, 71/71, or Appendix B failure is a STOP and
reopens the architecture decision.

- [ ] **Step 1: Add Composer metadata and failing canonicalization tests**

`packages/php/core/composer.json` defines the package and the only core test
runtime. Keep the package version explicit until these path repositories are
replaced by a tagged VCS distribution:

```json
{
  "name": "8lines/gauntlet-php-core",
  "version": "0.1.0",
  "type": "library",
  "require": {
    "php": ">=8.5",
    "ext-curl": "*",
    "ext-dom": "*",
    "ext-hash": "*",
    "ext-json": "*",
    "ext-libxml": "*",
    "ext-mbstring": "*",
    "onematrix/tracing-sdk": "1.1.0",
    "opis/json-schema": "2.6.0"
  },
  "require-dev": { "phpunit/phpunit": "^11.5" },
  "autoload": { "psr-4": { "EightLines\\Gauntlet\\Core\\": "src/" } },
  "autoload-dev": { "psr-4": { "EightLines\\Gauntlet\\Core\\Tests\\": "tests/" } }
}
```

`packages/php/Dockerfile` is the only image used by Core and Bundle package tests. It installs the PHPUnit-required `mbstring`, XML/DOM, and Composer tooling rather than assuming they exist in `php:8.5-cli`:

```dockerfile
FROM php:8.5-cli
RUN apt-get update \
 && apt-get install -y --no-install-recommends git unzip libcurl4-openssl-dev libonig-dev libxml2-dev \
 && docker-php-ext-install curl mbstring dom xml xmlwriter \
 && rm -rf /var/lib/apt/lists/*
COPY --from=composer:2 /usr/bin/composer /usr/local/bin/composer
WORKDIR /workspace
```

`packages/php/core/phpunit.xml.dist` contains one suite named `unit`:

```xml
<phpunit bootstrap="vendor/autoload.php">
  <testsuites>
    <testsuite name="unit"><directory>tests/Unit</directory></testsuite>
  </testsuites>
</phpunit>
```

```php
public function testItSortsObjectKeysRecursivelyWithoutReorderingLists(): void
{
    self::assertSame(
        '{"a":{"c":3,"d":4},"z":[{"a":1,"b":2},3]}',
        Rfc8785CanonicalJson::encode(JsonOwnership::object([
            'z' => [['b' => 2, 'a' => 1], 3],
            'a' => ['d' => 4, 'c' => 3],
        ])),
    );
}

public function testDefinitionRevisionDoesNotIncludeItself(): void
{
    $definition = Fixtures::operation();
    self::assertMatchesRegularExpression('/^sha256:[a-f0-9]{64}$/', $definition->revision());
    self::assertSame($definition->revision(), Fixtures::operation()->revision());
}

public function testOwnedEmptyObjectAndListKeepDifferentWireShapes(): void
{
    $value = JsonOwnership::object([
        'emptyObject' => new \stdClass(),
        'emptyList' => [],
        'value' => null,
    ])->jsonSerialize();

    self::assertInstanceOf(\stdClass::class, $value['emptyObject']);
    self::assertSame('{}', json_encode($value['emptyObject'], JSON_THROW_ON_ERROR));
    self::assertSame([], $value['emptyList']);
    self::assertSame('[]', json_encode($value['emptyList'], JSON_THROW_ON_ERROR));
    self::assertNull($value['value']);
}

public function testItUsesRfc8785EcmascriptNumberSerialization(): void
{
    self::assertSame(
        '{"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27]}',
        Rfc8785CanonicalJson::encode(JsonOwnership::object([
            'numbers' => [333333333.33333329, 1E30, 4.50, 2e-3, 1e-27],
        ])),
    );
}

public function testProtocolIdRejectsUnsafeRouteCharacters(): void
{
    foreach (['a/b', 'a%2Fb', 'a b', 'a?b', 'a#b', str_repeat('a', 129)] as $id) {
        try {
            ProtocolId::assert($id);
            self::fail('Expected unsafe ID to be rejected: ' . $id);
        } catch (\InvalidArgumentException) {
        }
    }
}
```

The RED suite loads the shared fixtures by repository path rather than copying
them into PHP. It asserts every portable-pattern row, every JCS success/error
row (including own `__proto__`, UTF-16 ordering, lone surrogates, `-0`,
`5e-324`, and `1e-320`), and representative manifest/operation/resolve semantic
cases. Expected canonical JSON and hashes come only from the checked-in vectors.

- [ ] **Step 2: Install and run core tests to verify failure**

Run:

```bash
docker build -f packages/php/Dockerfile -t gauntlet-php-test .
docker run --rm --user "$(id -u):$(id -g)" -e COMPOSER_HOME=/tmp/composer -e COMPOSER_CACHE_DIR=/tmp/composer-cache -v "$PWD:/workspace" -w /workspace/packages/php/core gauntlet-php-test composer install --no-interaction --prefer-dist
docker run --rm --user "$(id -u):$(id -g)" -e COMPOSER_HOME=/tmp/composer -e COMPOSER_CACHE_DIR=/tmp/composer-cache -v "$PWD:/workspace" -w /workspace/packages/php/core gauntlet-php-test vendor/bin/phpunit --testsuite unit
```

Expected: FAIL because core classes are absent.

- [ ] **Step 3: Implement canonical JSON and definitions**

```php
final readonly class OperationDefinition
{
    /**
     * @param list<DataSourceReference> $dataSources
     * @param list<OperationPreset> $presets
     * @param list<string> $tags
     */
    public function __construct(
        public string $id,
        public string $featureId,
        public string $label,
        public ?string $description,
        public JsonObject $inputSchema,
        public ?InputHandling $inputHandling,
        public ?JsonObject $contextSchema,
        public ?OperationUiSchema $uiSchema,
        public array $dataSources,
        public array $presets,
        public ExecutionPolicy $execution,
        public OperationOutput $output,
        public ?string $icon = null,
        public int $order = 0,
        public array $tags = [],
        public ?ProtocolRequirements $requirements = null,
        public ?ProtocolExtensions $extensions = null,
        public ?string $inputClass = null,
    ) {
        ProtocolId::assert($id);
        ProtocolId::assert($featureId);
    }

    public function revision(): string
    {
        return 'sha256:' . hash('sha256', Rfc8785CanonicalJson::encode(
            JsonOwnership::object($this->toProtocolArray(false)),
        ));
    }

    /** @return array<string, mixed> */
    public function toProtocolArray(bool $withRevision = true): array
    {
        $document = [
            'id' => $this->id,
            'featureId' => $this->featureId,
            'label' => $this->label,
            'inputSchema' => $this->inputSchema,
            'dataSources' => array_map(static fn (DataSourceReference $reference): array => $reference->toProtocolArray(), $this->dataSources),
            'presets' => array_map(static fn (OperationPreset $preset): array => $preset->toProtocolArray(), $this->presets),
            'execution' => $this->execution->toProtocolArray(),
            'output' => $this->output->toProtocolArray(),
            'order' => $this->order,
            'tags' => $this->tags,
        ];

        if ($this->description !== null) {
            $document['description'] = $this->description;
        }
        if ($this->contextSchema !== null) {
            $document['contextSchema'] = $this->contextSchema;
        }
        if ($this->inputHandling !== null) {
            $document['inputHandling'] = $this->inputHandling->toProtocolArray();
        }
        if ($this->uiSchema !== null) {
            $document['uiSchema'] = $this->uiSchema->toProtocolArray();
        }
        if ($this->icon !== null) {
            $document['icon'] = $this->icon;
        }
        if ($this->requirements !== null) {
            $document['requirements'] = $this->requirements->toProtocolArray();
        }
        if ($this->extensions !== null) {
            $document['extensions'] = $this->extensions->toProtocolArray();
        }

        if ($withRevision) {
            $document['revision'] = $this->revision();
        }

        return $document;
    }
}
```

Add `ProtocolId::assert(string $id): void` as the single restricted-ID validator used
by definitions, registries, and routes. It accepts only `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`; slash, percent, whitespace, query, and fragment characters are rejected before route construction, rather than URL-encoded. `toProtocolArray()` omits `inputClass`, adds `revision` only after hashing, and emits exactly the v1 field names.
`JsonOwnership` deep-copies only scalars, arrays, owned values, and decoded
`stdClass` into distinct immutable `JsonObject`/`JsonList` shapes. It preserves
null, `__proto__`, numeric object keys, aliases, and depths 0–511, while
rejecting sparse ambiguous integer-key arrays, resources, closures,
`JsonSerializable`, `DateTimeInterface`, enums, custom objects, magic/accessor
execution, active object/array-reference cycles, depth 512, non-finite values,
programmatic negative zero, unsafe non-exponential integral binary64 values,
invalid UTF-8, and lone surrogates. Parsed raw `-0` is already zero and emits
`0`; finite cases including `5e-324`, `1e-320`, the smallest normal, and `1e21`
remain supported.

`Rfc8785CanonicalJson` accepts and revalidates only an owned object/list root.
It creates a local transport tree, scopes `serialize_precision=-1` around
`json_encode` with `JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES |
JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION`, and restores the prior
setting in `finally` without fiber/await/callback. It instantiates only
`Tracing\Sdk\Canonicalize\JsonCanonicalizer`, safely maps
`Tracing\Sdk\Exception\CanonicalizationException`, returns the vendor bytes
unchanged, and hashes those exact UTF-8 bytes. Revision projection removes
only the selected root `revision`/`manifestRevision` member. No output repair,
formatter, normalization, partial-output flag, subprocess, or alternate
runtime is allowed.

OneMatrix is a broad, low-maturity tracing SDK with unrelated curl/XML/RPC/auth
code, no transitive Composer packages, an empty Packagist `dist.shasum`, and an
unsigned source commit. Pin and receipt-check this exact release, import only
the two allowlisted classes above, register no vendor service, investigate
archive drift, and rerun 71/71 plus Appendix B for every lock/coordinate
change. If policy requires a standalone upstream MIT license file, legal
acceptance or an upstream release is a pre-production gate.

`TcSchemaCore` ports the accepted scanner and productive-reference checks; it
validates both `pattern` and `patternProperties` against the shared vector file.
`SchemaValidator` has the framework-neutral API below. `OpisSchemaValidator`
uses Draft 2020-12 from `opis/json-schema:2.6.0`, turns off custom filters,
casting, `$data`, remote/relative loaders, and every nonstandard keyword, and
returns normalized safe pointer errors without including instance values.

```php
interface SchemaValidator
{
    /** @return list<ValidationError> */
    public function validate(JsonObject $schema, JsonValue $instance): array;
}
```

`ProtocolSemantics` ports the three accepted predicates without framework or
I/O dependencies. It validates operation/manifest revisions, stable and unique
IDs, feature graphs, availability/requirements, diagnostics, embedded schema
profiles, data-source/UI references, limits, preset secret reachability, and
resolve value identity/order. The bounded preset analyzer retains the same
depth, width, and cycle ceilings as the protocol package.

Constructor validation rejects blank IDs/labels, non-object roots for both input/context schemas, data-source bindings whose `id`, `inputPointer`, dependency pointers, or context pointers violate the canonical profile, secret-containing presets, and inconsistent dry-run/cancellation execution settings. `ExecutionPolicy` emits exactly `impact`, `confirmationRequired`, `dryRunSupported`, `idempotency` (`none`, `optional`, or `required`), `cancellationSupported`, and optional timeout/concurrency fields. `FileReference` contains only
the opaque adapter-owned file ID and safe metadata; it never contains file
contents. `Artifact` is a closed typed union covering notice, metrics, key-value, table, JSON, Markdown, diff, timeline, log, download, link, browser-launch, and namespaced artifacts. `OperationResult` carries typed summary, output, artifacts, and follow-up actions; it cannot accept a raw `Throwable` or arbitrary result array. Browser-launch artifacts carry only their opaque artifact ID/label—never a session URL.

`OperationDefinitionTest` asserts that emitted JSON has exactly `id`, `revision`, `featureId`, `label`, optional `description`, optional `icon`, `order`, `tags`, optional `requirements`, explicit Draft 2020-12 object `inputSchema`, optional `inputHandling`, optional Draft 2020-12 object `contextSchema`, optional `uiSchema`, `dataSources`, `presets`, `execution`, `output`, and optional namespaced `extensions`. It must assert that it has no `availability`, `definitionUrl`, `invocation`, `inputClass`, PHP namespace separator, service ID, or exception data.

`ManifestBuilder` emits a document with exactly `protocolVersion`, `manifestRevision`, `schemaDialect`, `profiles`, `capabilities`, `application`, `features`, `operations`, `dataSources`, optional `diagnostics`, and optional namespaced `extensions`. `ManifestBuilderTest` fixes the complete expected array, verifies that `manifestRevision` is an RFC 8785 plus SHA-256 digest of the document without that root field, verifies stable ID ordering of features/operations/data sources, and verifies that operation summaries expose only `id`, `revision`, `label`, `featureId`, `availability`, optional `requirements`, and optional `extensions`. Profiles are the validated adapter implementation profiles. Core capabilities are derived from installed endpoint SPIs; future non-core IDs come from `CapabilityProvider`; no capability can be inserted as an arbitrary configuration string. Every valid operation summary retains its complete declared requirements when available or unavailable; invalid bindings are omitted with safe diagnostics. Diagnostics contain only `severity`, stable `code`, safe `message`, optional safely established opaque `operationId`, and optional namespaced `extensions`; they never contain a class name, exception message, trace, or serialized exception object.

- [ ] **Step 4: Run core definition tests**

Run: `docker run --rm --user "$(id -u):$(id -g)" -e COMPOSER_HOME=/tmp/composer -e COMPOSER_CACHE_DIR=/tmp/composer-cache -v "$PWD:/workspace" -w /workspace/packages/php/core gauntlet-php-test vendor/bin/phpunit --testsuite unit`

Expected: all definition, canonicalization, and Problem tests pass.

- [ ] **Step 5: Commit PHP definitions**

```bash
git add packages/php/core packages/php/Dockerfile
git commit -m "feat(php-core): add protocol definitions and revisions"
```

### Task 2: PHP Registries, Data Sources, and Run Lifecycle

**Files:**
- Create: `packages/php/core/src/Contract/FeatureProvider.php`
- Create: `packages/php/core/src/Contract/CapabilityProvider.php`
- Create: `packages/php/core/src/Contract/OperationHandler.php`
- Create: `packages/php/core/src/Contract/DataSource.php`
- Create: `packages/php/core/src/Contract/RunContext.php`
- Create: `packages/php/core/src/Contract/RunStore.php`
- Create: `packages/php/core/src/Registry/FeatureRegistry.php`
- Create: `packages/php/core/src/Registry/OperationRegistry.php`
- Create: `packages/php/core/src/Registry/DataSourceRegistry.php`
- Create: `packages/php/core/src/Registry/RegistryDiagnostic.php`
- Create: `packages/php/core/src/DataSource/DataSourceQuery.php`
- Create: `packages/php/core/src/DataSource/DataSourceResolveRequest.php`
- Create: `packages/php/core/src/DataSource/DataSourceResolveResponse.php`
- Create: `packages/php/core/src/DataSource/DataSourceValue.php`
- Create: `packages/php/core/src/DataSource/DataSourceItem.php`
- Create: `packages/php/core/src/DataSource/DataSourcePage.php`
- Create: `packages/php/core/src/Run/RunStatus.php`
- Create: `packages/php/core/src/Run/Run.php`
- Create: `packages/php/core/src/Run/CreateRunRequest.php`
- Create: `packages/php/core/src/Run/RunCreationResult.php`
- Create: `packages/php/core/src/Run/RunProgress.php`
- Create: `packages/php/core/src/Run/RunSummary.php`
- Create: `packages/php/core/src/Run/FollowUpAction.php`
- Create: `packages/php/core/src/Run/RunEvent.php`
- Create: `packages/php/core/src/Run/InvocationContext.php`
- Create: `packages/php/core/src/Run/InvocationContextLease.php`
- Create: `packages/php/core/src/Run/IdempotencyFingerprint.php`
- Create: `packages/php/core/src/Run/RunStoreCreateResult.php`
- Create: `packages/php/core/src/Run/RuntimeGuard.php`
- Create: `packages/php/core/src/Run/InputHandlingGuard.php`
- Create: `packages/php/core/src/Contract/FileReferenceValidator.php`
- Create: `packages/php/core/src/Run/InMemoryRunStore.php`
- Create: `packages/php/core/src/Run/DefaultRunContext.php`
- Create: `packages/php/core/src/Run/RunManager.php`
- Test: `packages/php/core/tests/Unit/Registry/OperationRegistryTest.php`
- Test: `packages/php/core/tests/Unit/Registry/DataSourceRegistryTest.php`
- Test: `packages/php/core/tests/Unit/Run/RunManagerTest.php`
- Test: `packages/php/core/tests/Unit/Run/RunManagerConcurrencyTest.php`
- Test: `packages/php/core/tests/Unit/Run/RuntimeGuardTest.php`

**Interfaces:**
- Consumes: Task 1 definition/result/problem objects, `SchemaValidator`, and
  shared protocol semantics.
- Produces: non-throwing diagnostic registries, an atomic fingerprint-only
  `RunStore`, framework-neutral `CapabilityProvider`, short-lived
  `InvocationContextLease`, plus
  `RunManager::create()` and `RunManager::get()`.

- [ ] **Step 1: Write failing registry tests**

```php
public function testDuplicateOperationBecomesDiagnosticAndKeepsFirstHandler(): void
{
    $registry = new OperationRegistry([HandlerFixture::named('same'), HandlerFixture::named('same')]);
    self::assertCount(1, $registry->definitions());
    self::assertSame('duplicate_operation_id', $registry->diagnostics()[0]->code);
}

public function testUnknownFeatureMakesOperationInvalid(): void
{
    $registry = RegistryFixture::withoutFeature('missing');
    self::assertNull($registry->find('operation'));
    self::assertSame('unknown_feature', $registry->diagnostics()[0]->code);
}
```

The same RED suite serializes a query with empty owned dependencies as `{}`, a
resolve request with `values: []`, and a request containing `values: [""]`.
It asserts those three shapes survive construction, registry dispatch, and
response serialization without object/list coercion or rejection.

- [ ] **Step 2: Run registry tests and verify failure**

Run: `docker run --rm --user "$(id -u):$(id -g)" -e COMPOSER_HOME=/tmp/composer -e COMPOSER_CACHE_DIR=/tmp/composer-cache -v "$PWD:/workspace" -w /workspace/packages/php/core gauntlet-php-test vendor/bin/phpunit --testsuite unit --filter Registry`

Expected: FAIL because registries and contracts do not exist.

- [ ] **Step 3: Implement contracts and diagnostic registries**

```php
interface CapabilityProvider
{
    public function capabilityId(): string;
}

interface OperationHandler
{
    public const TAG = 'gauntlet.operation';

    public function definition(): OperationDefinition;

    public function execute(object $input, RunContext $context): OperationResult;
}

interface DataSource
{
    public const TAG = 'gauntlet.data_source';

    public function definition(): DataSourceDefinition;
    public function query(DataSourceQuery $query): DataSourcePage;

    public function resolve(DataSourceResolveRequest $request): DataSourceResolveResponse;
}
```

`RunContext` mirrors the accepted TypeScript surface: run/operation IDs,
`invocationContext()`, cancellation signal/check, progress, artifact, action,
structured safe log, and warning methods. `InvocationContextLease` is the only
runtime-owned context reference and is cleared in `finally` before terminal
persistence completes; a retained context object exposes `null` afterwards.

`DataSourceValue` is an opaque string and explicitly permits `""`; it is never
a numeric/boolean/mixed JSON value. `DataSourceResolveRequest` permits an empty
`values` list and contains pointer-keyed `dependencies` plus canonical optional
`InvocationContext`. `DataSourceResolveResponse` emits canonical `results`, one
result per requested value in exactly the original order, echoes each value,
and uses `item: null` when unresolved. Registries catch definition exceptions,
collect safe diagnostics, keep the first valid stable ID, sort protocol output
by ID, and never make malformed operations executable.

- [ ] **Step 4: Write failing run-manager tests**

```php
public function testStaleRevisionReturnsConflictWithoutSavingRun(): void
{
    $result = $this->manager->create('test.echo', new CreateRunRequest(
        'sha256:' . str_repeat('f', 64),
        JsonOwnership::object([]),
        null,
        false,
        null,
    ));
    self::assertFalse($result->isSuccess());
    self::assertSame(409, $result->problem?->status);
    self::assertSame([], $this->store->all());
}

public function testSameIdempotencyKeyReturnsSameCompletedRun(): void
{
    $first = $this->manager->create('test.echo', $this->request('same'));
    $second = $this->manager->create('test.echo', $this->request('same'));
    self::assertSame($first->run?->id, $second->run?->id);
    self::assertSame(1, $this->handler->executions);
}

public function testIdempotencyPolicyRejectsForbiddenAndMissingKeys(): void
{
    $forbidden = $this->managerFor('test.none')->create('test.none', $this->request('not-allowed'));
    self::assertSame(422, $forbidden->problem?->status);

    $required = $this->managerFor('test.required')->create('test.required', $this->request(null));
    self::assertSame(422, $required->problem?->status);
}

public function testTerminalRunContainsCanonicalSequenceProgressArtifactsAndActions(): void
{
    $result = $this->manager->create('test.echo', $this->request('rich-run'));
    self::assertTrue($result->isSuccess());
    $run = $result->run;
    self::assertSame('succeeded', $run->state->value);
    self::assertGreaterThan(0, $run->sequence);
    self::assertNotNull($run->completedAt);
    self::assertSame('success', $run->summary?->tone);
    self::assertSame('key-value', $run->artifacts[0]->kind);
    self::assertSame('invoke-operation', $run->actions[0]->kind);
    self::assertNull($run->problem);
}

public function testConcurrentDuplicateCreateStoresAndExecutesExactlyOnce(): void
{
    [$first, $second] = $this->raceIdenticalCreates('raw-key-never-stored');
    self::assertSame($first->run?->id, $second->run?->id);
    self::assertSame(1, $this->handler->executions);
    self::assertFalse($this->store->containsText('raw-key-never-stored'));
}

public function testRetainedContextLeaseClosesAfterSuccessAndFailure(): void
{
    $this->manager->create('test.echo', $this->request('context-key', requestId: 'context-sentinel'));
    self::assertNull($this->handler->retainedContext?->invocationContext());
    self::assertFalse($this->store->containsText('context-sentinel'));
}
```

- [ ] **Step 5: Implement synchronous run lifecycle**

```php
interface RunStore
{
    public function createQueued(Run $run, ?string $idempotencyFingerprint = null): RunStoreCreateResult;
    public function get(string $runId): ?Run;
    public function findByIdempotencyFingerprint(string $operationId, string $fingerprint): ?Run;
    public function updateExactSequence(Run $run, int $expectedPreviousSequence): bool;
}

final readonly class RunManager
{
    public function create(string $operationId, CreateRunRequest $request): RunCreationResult;
    public function get(string $runId): ?Run;
}
```

```php
final readonly class RunCreationResult
{
    private function __construct(public ?Run $run, public ?Problem $problem) {}

    public static function success(Run $run): self
    {
        return new self($run, null);
    }

    public static function failure(Problem $problem): self
    {
        return new self(null, $problem);
    }

    public function isSuccess(): bool
    {
        return $this->run !== null;
    }
}
```

The manager validates the canonical create envelope, restricted operation ID,
exact RFC 8785 revision, declared dry-run support, complete raw input/context,
and idempotency mode before persistence. `none` rejects a supplied key,
`optional` accepts an absent key and replays the prior run for a supplied key,
and `required` rejects a missing/blank key with a typed 422 Problem. A supplied
key is immediately converted with domain-separated HMAC-SHA256; only the
fingerprint crosses the store boundary. `InMemoryRunStore::createQueued()` is
atomic and returns either `created` or the winning stored duplicate, while
`updateExactSequence()` rejects stale writers. Tests race at least 32 identical
creates and prove one run, one handler execution, no raw key, and valid stored
reads.

Before handler dispatch the manager uses `SchemaValidator` on input and the
complete raw optional context, validates secret/file rules through resolved
local refs and combinators, and delegates file
expiry/cardinality/media/size/operation/revision ownership checks to the
framework-neutral `FileReferenceValidator` SPI. A definition containing a file
rule is non-executable unless that validator is installed; Task 3 separately
requires the HTTP upload endpoint SPI before advertising `tc-uploads@1`. It
stores `queued`, `running`, then `succeeded` or a sanitized terminal failure.
Output is schema-validated before success; every artifact/action is
closed, target IDs exist, invoke-operation input validates against the target
schema and contains no target secret, browser actions reference same-Run
browser artifacts, and every store read is revalidated. Secret sentinels are
absent from Runs, validation errors, Problems, logs, output, artifacts, and
actions. Each immutable Run has protocol ID, operation ID/revision, monotonic
`sequence`, RFC 3339 timestamps, optional progress/typed summary/output, typed
artifacts, follow-up actions, and the state-discriminated required/forbidden
`problem` and `completedAt` fields. `RunEvent` contains a full snapshot. The
initial implementation is synchronous but preserves every state snapshot so
the HTTP response and polling model match future queued runners.

- [ ] **Step 6: Run all PHP Core tests**

Run: `docker run --rm --user "$(id -u):$(id -g)" -e COMPOSER_HOME=/tmp/composer -e COMPOSER_CACHE_DIR=/tmp/composer-cache -v "$PWD:/workspace" -w /workspace/packages/php/core gauntlet-php-test vendor/bin/phpunit --testsuite unit`

Expected: all tests pass.

- [ ] **Step 7: Commit PHP runtime**

```bash
git add packages/php/core
git commit -m "feat(php-core): add registries data sources and runs"
```

### Task 3: Symfony Bundle DI, Attributes, and Input Mapping

**Files:**
- Create: `packages/php/symfony-bundle/composer.json`
- Create: `packages/php/symfony-bundle/phpunit.xml.dist`
- Create: `packages/php/symfony-bundle/src/GauntletBundle.php`
- Create: `packages/php/symfony-bundle/src/DependencyInjection/Configuration.php`
- Create: `packages/php/symfony-bundle/src/DependencyInjection/GauntletExtension.php`
- Create: `packages/php/symfony-bundle/src/DependencyInjection/Compiler/TaggedAdapterServicesPass.php`
- Create: `packages/php/symfony-bundle/src/Attribute/AsGauntletFeature.php`
- Create: `packages/php/symfony-bundle/src/Attribute/AsGauntletOperation.php`
- Create: `packages/php/symfony-bundle/src/Attribute/AsGauntletDataSource.php`
- Create: `packages/php/symfony-bundle/src/Registry/SymfonyFeatureRegistry.php`
- Create: `packages/php/symfony-bundle/src/Registry/SymfonyOperationRegistry.php`
- Create: `packages/php/symfony-bundle/src/Registry/SymfonyDataSourceRegistry.php`
- Create: `packages/php/symfony-bundle/src/Registry/SymfonyAdapterCatalog.php`
- Create: `packages/php/symfony-bundle/src/Input/SymfonyJsonSchemaFactory.php`
- Create: `packages/php/symfony-bundle/src/Input/SymfonyInputMapper.php`
- Create: `packages/php/symfony-bundle/src/Capability/CapabilityRegistry.php`
- Create: `packages/php/symfony-bundle/src/Capability/CancelRunEndpoint.php`
- Create: `packages/php/symfony-bundle/src/Capability/RunEventsEndpoint.php`
- Create: `packages/php/symfony-bundle/src/Capability/UploadEndpoint.php`
- Create: `packages/php/symfony-bundle/src/Capability/SessionLaunchEndpoint.php`
- Create: `packages/php/symfony-bundle/src/Support/AdapterConfiguration.php`
- Test: `packages/php/symfony-bundle/tests/Unit/Input/SymfonyJsonSchemaFactoryTest.php`
- Test: `packages/php/symfony-bundle/tests/Unit/Input/SymfonyInputMapperTest.php`
- Test: `packages/php/symfony-bundle/tests/Integration/DependencyInjectionTest.php`
- Test: `packages/php/symfony-bundle/tests/Integration/CapabilityRegistryTest.php`

**Interfaces:**
- Consumes: PHP Core contracts, `SchemaValidator`, protocol definitions, and
  the four optional endpoint SPI contracts.
- Produces: autoconfigured tagged services, capability-derived immutable
  adapter configuration, DTO JSON Schema generation, and validated DTO mapping.

- [ ] **Step 1: Write failing container and disabled-default tests**

```php
public function testBundleIsDisabledByDefaultAndAutoconfiguresExplicitContracts(): void
{
    $container = $this->compileContainer([]);
    self::assertFalse($container->get(AdapterConfiguration::class)->enabled);
    self::assertTrue($container->has('fixture.operation'));
    self::assertArrayHasKey(OperationHandler::TAG, $container->getDefinition('fixture.operation')->getTags());
}
```

- [ ] **Step 2: Install bundle dependencies and verify tests fail**

Run:

```bash
docker run --rm --user "$(id -u):$(id -g)" -e COMPOSER_HOME=/tmp/composer -e COMPOSER_CACHE_DIR=/tmp/composer-cache -v "$PWD:/workspace" -w /workspace/packages/php/symfony-bundle gauntlet-php-test composer install --no-interaction --prefer-dist
docker run --rm --user "$(id -u):$(id -g)" -e COMPOSER_HOME=/tmp/composer -e COMPOSER_CACHE_DIR=/tmp/composer-cache -v "$PWD:/workspace" -w /workspace/packages/php/symfony-bundle gauntlet-php-test vendor/bin/phpunit --testsuite all
```

Expected: FAIL because the bundle, extension, and configuration do not exist.

- [ ] **Step 3: Implement bundle configuration and service collection**

`packages/php/symfony-bundle/composer.json` must resolve the core package from
the sibling directory while the repository is still monorepo-local:

```json
{
  "name": "8lines/gauntlet-symfony-bundle",
  "version": "0.1.0",
  "type": "symfony-bundle",
  "repositories": [
    { "type": "path", "url": "../core", "options": { "symlink": false } }
  ],
  "require": {
    "php": ">=8.5",
    "8lines/gauntlet-php-core": "^0.1",
    "symfony/config": "^7.4",
    "symfony/dependency-injection": "^7.4",
    "symfony/framework-bundle": "^7.4",
    "symfony/http-foundation": "^7.4",
    "symfony/property-access": "^7.4",
    "symfony/property-info": "^7.4",
    "symfony/routing": "^7.4",
    "symfony/serializer": "^7.4",
    "symfony/validator": "^7.4"
  },
  "require-dev": {
    "phpunit/phpunit": "^11.5",
    "symfony/browser-kit": "^7.4"
  },
  "autoload": { "psr-4": { "EightLines\\Gauntlet\\SymfonyBundle\\": "src/" } },
  "autoload-dev": { "psr-4": { "EightLines\\Gauntlet\\SymfonyBundle\\Tests\\": "tests/" } }
}
```

`packages/php/symfony-bundle/phpunit.xml.dist` defines `unit`, `integration`,
and `all` (the complete `tests` directory) suites, so every command below names
one valid suite:

```xml
<phpunit bootstrap="vendor/autoload.php">
  <testsuites>
    <testsuite name="unit"><directory>tests/Unit</directory></testsuite>
    <testsuite name="integration"><directory>tests/Integration</directory></testsuite>
    <testsuite name="all"><directory>tests</directory></testsuite>
  </testsuites>
</phpunit>
```

```php
// Supported configuration shape
return [
    'enabled' => false,
    'application' => [
        'id' => 'application-id',
        'label' => 'Application label',
        'environment' => 'uat',
    ],
    'profiles' => ['tc-schema-core@1', 'tc-rich-forms@1'],
];
```

The extension autoconfigures `FeatureProvider`, `OperationHandler`,
`DataSource`, `CapabilityProvider`, and each exact optional endpoint SPI. The
compiler pass injects tagged iterators/service locators into Symfony registries.
Enabled adapters require a valid application ID and non-blank label.
`AdapterConfiguration`
validates versioned profile IDs but accepts no capability advertisement.
`CapabilityRegistry` retains a future non-core ID only from one registered core
`CapabilityProvider` and derives
`tc-run-cancellation@1`, `tc-run-sse@1`, `tc-uploads@1`, and
`tc-session-launch@1` only from exactly one installed matching SPI. Duplicate
providers/SPIs are a safe diagnostic and do not advertise or route the
capability; a generic provider is forbidden from claiming a core ID.
`CapabilityRegistryTest` proves those rejection cases and retains one future
non-core ID only while its provider bean exists.

`SymfonyAdapterCatalog` owns one immutable ID-indexed `OperationSummary` map
used for both manifest serialization and invocation. Its public
`operationSummary(string $operationId): ?OperationSummary` is the authoritative
availability gate. A missing required profile or matching endpoint SPI returns
the exact deeply owned safe Problem stored in the summary; no second Problem or
availability calculation is allowed.

The schema factory emits only explicit Draft 2020-12 object roots, validates
the portable `tc-schema-core@1` subset, and delegates instances to the injected
core `SchemaValidator`. Operation authors bind declarative `InputHandling`, UI,
data-source references, and presets through core value objects; the bundle
rejects a preset containing a secret-handled pointer, never retains secret
values in a Run, and accepts file rules only when upload SPI support exists.
Malformed definitions become safe diagnostics during registry initialization
and do not fail container compilation. All valid summaries retain the exact
operation requirements even when unavailable.

- [ ] **Step 4: Write failing DTO schema and mapping tests**

```php
final readonly class InputFixture
{
    public function __construct(
        #[Assert\NotBlank]
        #[Assert\Uuid]
        public string $applicationId,
        #[Assert\Length(max: 1000)]
        public ?string $reason = null,
    ) {}
}

public function testItGeneratesRequiredNullableAndConstraintKeywords(): void
{
    $schema = $this->factory->forClass(InputFixture::class);
    self::assertSame(['applicationId'], $schema['required']);
    self::assertSame(['string', 'null'], $schema['properties']['reason']['type']);
    self::assertSame(1000, $schema['properties']['reason']['maxLength']);
    self::assertSame('https://json-schema.org/draft/2020-12/schema', $schema['$schema']);
    self::assertSame('object', $schema['type']);
}
```

- [ ] **Step 5: Implement schema generation and input mapping**

Support constructor-promoted scalar `string`, `int`, `float`, `bool`, nullable
variants, list arrays with explicit item metadata, and Validator constraints
`NotBlank`, `Length`, `Regex`, `Uuid`, and `Choice`. A Symfony `Regex` is emitted
only if its pattern passes the shared portable pattern vectors; otherwise the
binding is diagnosed. Unsupported DTO shapes require an explicit input schema.
Mapping starts from a deeply owned `JsonObject`, rejects unknown keys, uses
Symfony Serializer, validates the object, and normalizes violations to JSON
Pointer errors without values. It never maps a list-shaped root to a DTO.

- [ ] **Step 6: Run bundle DI/input checks**

Run: `docker run --rm --user "$(id -u):$(id -g)" -e COMPOSER_HOME=/tmp/composer -e COMPOSER_CACHE_DIR=/tmp/composer-cache -v "$PWD:/workspace" -w /workspace/packages/php/symfony-bundle gauntlet-php-test vendor/bin/phpunit --testsuite all`

Expected: all tests pass.

- [ ] **Step 7: Commit Symfony integration core**

```bash
git add packages/php/symfony-bundle
git commit -m "feat(symfony): add bundle registration and typed inputs"
```

### Task 4: Symfony Adapter HTTP Surface

**Files:**
- Create: `packages/php/symfony-bundle/config/services.php`
- Create: `packages/php/symfony-bundle/config/routes.php`
- Create: `packages/php/symfony-bundle/src/Controller/V1/HealthAction.php`
- Create: `packages/php/symfony-bundle/src/Controller/V1/ManifestAction.php`
- Create: `packages/php/symfony-bundle/src/Controller/V1/OperationDefinitionAction.php`
- Create: `packages/php/symfony-bundle/src/Controller/V1/CreateRunAction.php`
- Create: `packages/php/symfony-bundle/src/Controller/V1/GetRunAction.php`
- Create: `packages/php/symfony-bundle/src/Controller/V1/QueryDataSourceAction.php`
- Create: `packages/php/symfony-bundle/src/Controller/V1/ResolveDataSourceAction.php`
- Create: `packages/php/symfony-bundle/src/Controller/V1/UnsupportedCapabilityAction.php`
- Create: `packages/php/symfony-bundle/src/Controller/V1/CapabilityAction.php`
- Create: `packages/php/symfony-bundle/src/Http/ProblemResponseFactory.php`
- Create: `packages/php/symfony-bundle/src/Http/ProtocolResponseFactory.php`
- Create: `packages/php/symfony-bundle/src/Http/JsonRequestDecoder.php`
- Create: `packages/php/symfony-bundle/src/Http/RawAdapterTargetGuard.php`
- Create: `packages/php/symfony-bundle/src/EventSubscriber/AdapterPrefixGuardSubscriber.php`
- Create: `packages/php/symfony-bundle/src/Run/AdapterRunManager.php`
- Create: `packages/php/symfony-bundle/src/Support/AdapterEnabledGate.php`
- Test fixture: `packages/php/symfony-bundle/tests/Fixture/App/FixtureKernel.php`
- Test fixture: `packages/php/symfony-bundle/tests/Fixture/App/EchoOperation.php`
- Test fixture: `packages/php/symfony-bundle/tests/Fixture/App/FailingOperation.php`
- Test fixture: `packages/php/symfony-bundle/tests/Fixture/App/UsersDataSource.php`
- Test: `packages/php/symfony-bundle/tests/Integration/AdapterHttpTest.php`
- Test: `packages/php/symfony-bundle/tests/Integration/AdapterDisabledHttpTest.php`
- Test: `packages/php/symfony-bundle/tests/Integration/AdapterRawBoundaryTest.php`
- Test: `packages/php/symfony-bundle/tests/Integration/AdvertisedCapabilityHttpTest.php`

**Interfaces:**
- Consumes: Task 3 registries/input mapper and Task 2 run lifecycle.
- Produces: complete mandatory adapter HTTP API and typed 501 responses for optional unsupported capabilities.

- [ ] **Step 1: Write failing HTTP tests for enablement and discovery**

```php
public function testDisabledAdapterReturnsTyped503(): void
{
    $client = self::createClient(['environment' => 'disabled']);
    self::assertFalse(self::getContainer()->getParameter('gauntlet.enabled'));
    $client->request('GET', '/_gauntlet/v1/manifest');
    self::assertResponseStatusCodeSame(503);
    self::assertJsonContains(['type' => 'urn:gauntlet:problem:adapter-disabled']);
}

public function testManifestHasStableEtagAndSupportsNotModified(): void
{
    $client = self::createClient();
    $client->request('GET', '/_gauntlet/v1/manifest');
    $etag = $client->getResponse()->headers->get('ETag');
    $client->request('GET', '/_gauntlet/v1/manifest', server: ['HTTP_IF_NONE_MATCH' => $etag]);
    self::assertResponseStatusCodeSame(304);
}

public function testManifestAndDefinitionUseCanonicalFieldsWithoutPhpLeaks(): void
{
    $client = self::createClient();
    $client->request('GET', '/_gauntlet/v1/manifest');
    self::assertJsonContains([
        'protocolVersion' => '1.0',
        'schemaDialect' => 'https://json-schema.org/draft/2020-12/schema',
        'profiles' => ['tc-schema-core@1', 'tc-rich-forms@1'],
        'capabilities' => [],
        'dataSources' => [[
            'id' => 'fixture.users',
            'capabilities' => ['search' => true, 'pagination' => 'cursor', 'resolve' => true, 'defaultLimit' => 20, 'maxLimit' => 100],
        ]],
    ]);

    $client->request('GET', '/_gauntlet/v1/operations/fixture.echo');
    $definition = $client->getResponse()->getContent();
    self::assertJsonContains([
        'id' => 'fixture.echo',
        'contextSchema' => [
            '$schema' => 'https://json-schema.org/draft/2020-12/schema',
            'type' => 'object',
            'required' => ['requestId'],
        ],
        'uiSchema' => ['profile' => 'tc-rich-forms@1'],
        'dataSources' => [['id' => 'fixture.users', 'inputPointer' => '/applicationId', 'dependencyPointers' => []]],
        'presets' => [['id' => 'fixture.default', 'label' => 'Default', 'input' => new \stdClass()]],
        'execution' => ['impact' => 'read'],
        'output' => ['schema' => ['type' => 'object']],
    ]);
    self::assertStringNotContainsString('EightLines\\', $definition);
    self::assertStringNotContainsString('inputClass', $definition);
    self::assertStringNotContainsString('invocation', $definition);
    self::assertStringNotContainsString('definitionUrl', $definition);
}

public function testDefinitionHasStableEtagAndSupportsNotModified(): void
{
    $client = self::createClient();
    $uri = '/_gauntlet/v1/operations/fixture.echo';
    $client->request('GET', $uri);
    $etag = $client->getResponse()->headers->get('ETag');
    self::assertSame('"' . $this->responseJson($client->getResponse())['revision'] . '"', $etag);
    $client->request('GET', $uri, server: ['HTTP_IF_NONE_MATCH' => $etag]);
    self::assertResponseStatusCodeSame(304);
}

public function testUnadvertisedOptionalRoutesReturnTypedCapabilityProblems(): void
{
    $client = self::createClient();
    foreach ([
        ['POST', '/_gauntlet/v1/runs/run-1/cancel'],
        ['GET', '/_gauntlet/v1/runs/run-1/events'],
        ['POST', '/_gauntlet/v1/uploads'],
        ['POST', '/_gauntlet/v1/runs/run-1/artifacts/launch-1/launch'],
    ] as [$method, $uri]) {
        $client->request($method, $uri);
        self::assertResponseStatusCodeSame(501);
        self::assertJsonContains(['type' => 'urn:gauntlet:problem:unsupported-capability']);
    }
}

public function testDisabledGateWinsBeforeRoutingAndBodyParsingForTheWholePrefix(): void
{
    $client = self::createClient(['environment' => 'disabled']);
    self::assertFalse(self::getContainer()->getParameter('gauntlet.enabled'));
    foreach ([
        ['GET', '/_gauntlet/v1/operations/unsafe%21id', null],
        ['POST', '/_gauntlet/v1/uploads', '{not-json'],
        ['PATCH', '/_gauntlet/v1/manifest?query=forbidden', null],
    ] as [$method, $uri, $body]) {
        $client->request($method, $uri, content: $body);
        self::assertResponseStatusCodeSame(503);
        self::assertJsonContains(['type' => 'urn:gauntlet:problem:adapter-disabled']);
    }
}
```

- [ ] **Step 2: Run HTTP tests and verify route failures**

Run: `docker run --rm --user "$(id -u):$(id -g)" -e COMPOSER_HOME=/tmp/composer -e COMPOSER_CACHE_DIR=/tmp/composer-cache -v "$PWD:/workspace" -w /workspace/packages/php/symfony-bundle gauntlet-php-test vendor/bin/phpunit --testsuite integration --filter AdapterHttpTest`

Expected: FAIL with missing routes/controllers.

- [ ] **Step 3: Implement health, manifest, and operation-definition controllers**

All routes begin with `/_gauntlet/v1`.
`AdapterPrefixGuardSubscriber` runs at a priority above RouterListener and reads
the server-provided raw request target, not a decoded route variable. For every
prefix request it first applies the disabled gate, then rejects query/fragment,
percent, whitespace, encoded separators, empty/trailing/extra segments, and
unsafe dynamic IDs. It returns typed 405 for a known path with a wrong method
and typed 404 for unmatched safe paths while leaving non-Gauntlet host routes
untouched. The disabled 503 therefore wins before routing, controller lookup,
JSON parsing, multipart parsing, or any registry/SPI access.

`GET /health` returns the canonical health document. `GET /manifest` emits the
canonical manifest (including implementation profiles, SPI-derived
capabilities, embedded data-source definitions, valid available/unavailable
summaries with complete requirements, and safe diagnostics) and
`GET /operations/{operationId}` emits the full standalone canonical
`OperationDefinition`; neither response may expose `inputClass`, a service ID,
a PHP namespace, exception data, `availability`, `definitionUrl`, or an
invocation path. `UnsupportedCapabilityAction` gates cancel, events, multipart
upload, and session launch before parsing/lookup when their SPI is absent;
`CapabilityAction` dispatches only to the exact installed SPI when advertised.
Manifest revision and operation revisions are RFC 8785 content hashes.
Responses use `application/json`; Problems use `application/problem+json` and
their top-level `status` equals HTTP status; a 304 is bodyless, has no content
type, and retains the strong quoted ETag.

- [ ] **Step 4: Write failing run and data-source HTTP tests**

```php
public function testRunValidationReturnsJsonPointersAndValidRunCanBePolled(): void
{
    $this->postRun(['operationRevision' => $this->revision(), 'input' => new \stdClass()]);
    self::assertResponseStatusCodeSame(422);
    self::assertJsonContains(['errors' => [['instancePath' => '/applicationId']]]);

    $run = $this->responseJson($this->postRun([
        'operationRevision' => $this->revision(),
        'input' => ['applicationId' => self::UUID],
    ]));
    self::assertSame('succeeded', $this->responseJson($this->getRun($run['id']))['state']);
}

public function testUnhandledHandlerFailureBecomesASafeFailedRun(): void
{
    $response = $this->postRunFor('fixture.failing', [
        'operationRevision' => $this->revision('fixture.failing'),
        'input' => ['applicationId' => self::UUID],
    ]);
    self::assertResponseStatusCodeSame(201);
    self::assertJsonContains([
        'state' => 'failed',
        'problem' => [
            'type' => 'urn:gauntlet:problem:handler-failed',
            'title' => 'Operation failed',
            'status' => 500,
        ],
    ]);
    $body = $response->getContent();
    self::assertStringNotContainsString('fixture exception detail', $body);
    self::assertStringNotContainsString('RuntimeException', $body);
    self::assertArrayHasKey('correlationId', $this->responseJson($response)['problem']);
}

public function testResolvePassesValuesDependenciesAndContextToTheDataSource(): void
{
    $client = self::createClient();
    $client->request('POST', '/_gauntlet/v1/data-sources/fixture.users/resolve', server: ['CONTENT_TYPE' => 'application/json'], content: json_encode([
        'values' => ['user-1'],
        'dependencies' => ['/agencyId' => 'agency-1'],
        'context' => ['requestId' => 'resolve-request-1', 'extensions' => ['urn:fixture:brandId' => 'brand-1']],
    ], JSON_THROW_ON_ERROR));
    self::assertResponseIsSuccessful();
    self::assertJsonContains(['results' => [[
        'value' => 'user-1',
        'item' => ['value' => 'user-1', 'label' => 'Acme Insurance'],
    ]]);
    self::assertSame(
        ['values' => ['user-1'], 'dependencies' => ['/agencyId' => 'agency-1'], 'context' => ['requestId' => 'resolve-request-1', 'extensions' => ['urn:fixture:brandId' => 'brand-1']]],
        self::getContainer()->get(UsersDataSource::class)->lastResolveRequest()->toProtocolArray(),
    );
}

/** @return array<string, mixed> */
private function responseJson(Response $response): array
{
    $content = $response->getContent();
    self::assertIsString($content);

    return json_decode($content, true, flags: JSON_THROW_ON_ERROR);
}
```

`FixtureKernel` has an explicit `disabled` environment branch which loads
bundle configuration with `enabled: false`; tests switch environments only
through supported kernel options and call `ensureKernelShutdown()` when
necessary. `KernelBrowser` responses are decoded only by `responseJson()`;
HttpFoundation `Response` has no HttpClient `toArray()` API.

- [ ] **Step 5: Implement create/poll run and query/resolve data-source controllers**

Create-run decodes only the bounded canonical HTTP envelope, then calls the
same immutable `SymfonyAdapterCatalog::operationSummary()` lookup used by the
manifest before adapter-supplied schema validation, DTO mapping, file
validation, scheduling, store access, or `RunManager::create()`. An unavailable
summary returns its exact deeply owned manifest Problem without manufacturing a
second Problem; an unknown safe ID remains the typed 404 path. Integration
tests count the schema validator, input mapper, file validator, scheduler,
store, and handler for missing-profile, missing-core-endpoint-SPI, and
available cases; all counters remain zero for both unavailable cases.

The available path validates the canonical closed envelope, checks revision
before input mapping, then uses `SchemaValidator` on
raw input and the complete raw optional context. It returns 201 for a terminal
synchronous run or 202 for a non-terminal run. A stale revision returns
`409 urn:gauntlet:problem:stale-operation-revision`; malformed input returns
`422 urn:gauntlet:problem:validation-failed` with normalized JSON Pointers;
unknown operation/data-source IDs return their typed 404 Problems. Query and
resolve validate their canonical envelopes, complete pointer-keyed dependencies
and context against the declared schemas, then validate the returned page or
ordered resolve response and `resolveSemanticsAreValid` before serialization.
Empty query dependencies, empty-string values, and an empty resolve list retain
their canonical object/list shapes. Known safe domain problems retain their
mapped status; every other `Throwable` is logged only with its correlation ID
and becomes a terminal `failed` Run whose nested Problem has type
`urn:gauntlet:problem:handler-failed`, title `Operation failed`, status 500,
correlation ID, and no raw detail. Advertised optional route tests cover one
successful implementation of each SPI; unadvertised routes remain exact 501s.

- [ ] **Step 6: Run all Symfony Bundle checks**

Run: `docker run --rm --user "$(id -u):$(id -g)" -e COMPOSER_HOME=/tmp/composer -e COMPOSER_CACHE_DIR=/tmp/composer-cache -v "$PWD:/workspace" -w /workspace/packages/php/symfony-bundle gauntlet-php-test vendor/bin/phpunit --testsuite all`

Expected: all tests pass.

- [ ] **Step 7: Commit the Symfony HTTP adapter**

```bash
git add packages/php/symfony-bundle
git commit -m "feat(symfony): expose adapter protocol v1"
```

### Task 5: Executable Symfony Reference Adapter and PHP Conformance

**Files:**
- Create: `examples/symfony/composer.json`
- Create: `examples/symfony/phpunit.xml.dist`
- Create: `examples/symfony/config/bundles.php`
- Create: `examples/symfony/config/services.php`
- Create: `examples/symfony/config/routes.php`
- Create: `examples/symfony/public/index.php`
- Create: `examples/symfony/src/Kernel.php`
- Create: `examples/symfony/src/Gauntlet/AgencyApplicationFeature.php`
- Create: `examples/symfony/src/Gauntlet/FinalizeAgencyApplicationInput.php`
- Create: `examples/symfony/src/Gauntlet/FinalizeAgencyApplicationOperation.php`
- Create: `examples/symfony/src/Gauntlet/PendingApplicationsDataSource.php`
- Create: `examples/symfony/src/Gauntlet/FixtureSessionLaunchEndpoint.php`
- Create: `examples/symfony/src/Gauntlet/CustomFinalizeController.php`
- Create: `examples/symfony/tests/AdapterConformanceTest.php`
- Create: `examples/symfony/Dockerfile`
- Consume unchanged: `conformance/scenarios/adapter-v1.json`

**Interfaces:**
- Consumes: complete Symfony Bundle, canonical protocol fixtures, and the shared scenario created by Task 6 of `2026-08-29-protocol-control-plane.md`.
- Produces: a runnable adapter with a two-field destructive operation and searchable data source, ready to be replaced by the example portal consumer application's domain services.

- [ ] **Step 1: Write the failing reference conformance test**

Precondition: execute protocol-control-plane Task 6 through scenario creation before this task, so `conformance/scenarios/adapter-v1.json` is present and schema-owned before the Symfony example consumes it.

The example's `composer.json` uses the two local packages through paths that
remain valid both from the repository checkout and from
`/workspace/examples/symfony` in the image:

```json
{
  "name": "8lines/gauntlet-symfony-example",
  "type": "project",
  "repositories": [
    { "type": "path", "url": "../../packages/php/core", "options": { "symlink": false } },
    { "type": "path", "url": "../../packages/php/symfony-bundle", "options": { "symlink": false } }
  ],
  "require": {
    "php": ">=8.5",
    "8lines/gauntlet-php-core": "^0.1",
    "8lines/gauntlet-symfony-bundle": "^0.1",
    "symfony/framework-bundle": "^7.4"
  },
  "require-dev": {
    "phpunit/phpunit": "^11.5",
    "symfony/browser-kit": "^7.4"
  },
  "autoload": { "psr-4": { "Gauntlet\\SymfonyExample\\": "src/" } },
  "autoload-dev": { "psr-4": { "Gauntlet\\SymfonyExample\\Tests\\": "tests/" } }
}
```

`examples/symfony/phpunit.xml.dist` names the one executable suite used by the
Docker command:

```xml
<phpunit bootstrap="vendor/autoload.php">
  <testsuites>
    <testsuite name="all"><directory>tests</directory></testsuite>
  </testsuites>
</phpunit>
```

```php
public function testReferenceAdapterPublishesAndExecutesFinalizeOperation(): void
{
    $scenario = json_decode(
        file_get_contents(dirname(__DIR__, 3) . '/conformance/scenarios/adapter-v1.json'),
        true,
        flags: JSON_THROW_ON_ERROR,
    );

    $manifest = $this->getJson('/_gauntlet/v1/manifest');
    self::assertContains($scenario['operationId'], array_column($manifest['operations'], 'id'));

    $page = $this->postJson(
        '/_gauntlet/v1/data-sources/' . $scenario['dataSourceId'] . '/query',
        $scenario['dataSourceQuery'],
    );
    self::assertSame('Alice Brown', $page['items'][0]['label']);

    $run = $this->postJson('/_gauntlet/v1/operations/' . $scenario['operationId'] . '/runs', [
        'operationRevision' => $this->operationRevision($scenario['operationId']),
        'input' => $scenario['input'],
        'context' => ['requestId' => 'symfony-example-create-01'],
        'idempotencyKey' => $scenario['idempotencyKey'],
    ]);
    self::assertSame('succeeded', $run['state']);
}
```

`conformance/scenarios/adapter-v1.json` is created and schema-owned by Task 6 of `2026-08-29-protocol-control-plane.md`; this task consumes it unchanged. It must contain the runner-required `operationId`, `dataSourceId`, `dataSourceQuery`, `dataSourceResolveRequest`, valid `input`, `invalidInput`, `expectedValidationPointer`, `idempotencyKey`, and `expectedTerminalState` fields. The shared IDs already match the reference example; the example never creates or modifies a parallel scenario and never hard-codes an operation revision.

- [ ] **Step 2: Run the example test and verify failure**

The Docker build context is the repository root (not `examples/symfony`), so
the local Core and Bundle path repositories are available. The Dockerfile
copies those directories to the paths declared above:

```dockerfile
FROM php:8.5-cli
RUN apt-get update \
 && apt-get install -y --no-install-recommends git unzip libonig-dev libxml2-dev \
 && docker-php-ext-install mbstring dom xml xmlwriter \
 && rm -rf /var/lib/apt/lists/*
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer
WORKDIR /workspace/examples/symfony
COPY packages/php/core /workspace/packages/php/core
COPY packages/php/symfony-bundle /workspace/packages/php/symfony-bundle
COPY examples/symfony /workspace/examples/symfony
COPY conformance /workspace/conformance
RUN composer install --no-interaction --prefer-dist
EXPOSE 8080
CMD ["php", "-S", "0.0.0.0:8080", "-t", "public", "public/index.php"]
```

Run: `docker build -f examples/symfony/Dockerfile -t gauntlet-symfony-example . && docker run --rm gauntlet-symfony-example vendor/bin/phpunit --testsuite all`

Expected: FAIL because the example operation and data source are absent.

- [ ] **Step 3: Implement the reference feature, DTO, handler, and data source**

The input requires UUID `applicationId` and six-digit `confirmationCode`. The reference
registers the exact shared IDs `agency-applications.finalize` and
`pending-applications`. The standalone operation definition declares
`tc-schema-core@1`, `tc-rich-forms@1`, and `tc-rich-results@1`; marks
`/properties/confirmationCode` as secret with retention `none`; omits `contextSchema`
because it has no additional context restriction; includes rich UI, a
pointer-bound searchable data source, empty secret-free presets, destructive
impact/required confirmation/dry-run unsupported/required idempotency, and a
typed rich output contract. It contains no transport path. The handler sees
the canonical invocation context while open and returns a key-value artifact
plus the scenario browser-launch artifact/action without echoing `confirmationCode`.

The example installs `FixtureSessionLaunchEndpoint`, so and only so the
manifest advertises `tc-session-launch@1`; it mints a short-lived single-use URL
on `https://portal.example.test` and never stores the URL in the Run. The other
three optional endpoints are absent and return their exact 501 Problems. The
fixture service records the call instead of sending mail or touching external
systems. The data source accepts the scenario's `/workflowState` dependency,
canonical context, empty-string values, and empty resolve list; query implements
cursor pagination and resolve preserves order. `CustomFinalizeController` is
an internal binding exercised through the same normalized create-run route;
its application route is never published. No fixture document contains a PHP
class name, service ID, stack trace, caught exception message, or session URL.

- [ ] **Step 4: Run package and black-box conformance checks**

Run:

```bash
docker build -f examples/symfony/Dockerfile -t gauntlet-symfony-example .
docker run --rm gauntlet-symfony-example vendor/bin/phpunit --testsuite all
pnpm --filter @8lines/gauntlet-conformance-runner test
container_name="gauntlet-symfony-conformance-$$"
cleanup_symfony() { docker rm -f "$container_name" >/dev/null 2>&1 || true; }
trap cleanup_symfony EXIT INT TERM
docker run -d --name "$container_name" -p 127.0.0.1::8080 gauntlet-symfony-example
host_port="$(docker port "$container_name" 8080/tcp | sed -n 's/.*://p' | tail -1)"
test -n "$host_port"
ready=''
for attempt in $(seq 1 30); do
  if node -e 'fetch(process.argv[1]).then(response => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))' \
    "http://127.0.0.1:${host_port}/_gauntlet/v1/health"; then ready=1; break; fi
  sleep 1
done
test "$ready" = 1
GAUNTLET_ADAPTER_URL="http://127.0.0.1:${host_port}" \
  GAUNTLET_SCENARIO=conformance/scenarios/adapter-v1.json \
  pnpm conformance:adapter-v1
```

Expected: PHP kernel tests and the external language-neutral runner both pass.
The reference additionally proves disabled-prefix precedence, handler-failure
sanitization, pagination traversal, installed session-launch success, the other
three exact 501s, custom-controller binding through the normalized route,
context lease closure, atomic idempotent replay, and absence of the secret
sentinel from every captured response. The runner validates live HTTP documents
and endpoint behavior rather than trusting PHP fixtures.

- [ ] **Step 5: Commit the reference adapter**

```bash
git add examples/symfony
git commit -m "test(symfony): add executable reference adapter"
```

## Execution Handoff

After Task 5 is independently accepted, publish/tag the two Composer packages,
then implement the separate example portal consumer vertical slice against those
artifacts. Complete that slice before starting TypeScript Node/Next. Java/Spring
starts only after PHP/Symfony, the example portal consumer, Node, and the real Next fixture are
accepted.
