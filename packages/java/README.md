# Gauntlet Java SDK

The Java SDK exposes an application's explicitly registered Gauntlet
operations through the framework-neutral Adapter v1 protocol. It is an
internal development and test-environment integration: it is disabled by
default, contains no dashboard UI or authorization layer, and must not be
enabled on production ingress.

## Modules and requirements

Release `0.1.5` publishes two Java 21 consumer artifacts:

- `dev.eightlines.gauntlet:core:0.1.5` — Java 21 protocol models,
  schema/semantics validation, canonical JSON, registries, run lifecycle,
  HMAC idempotency, and framework-neutral SPIs;
- `dev.eightlines.gauntlet:spring-boot-starter:0.1.5` — Spring Boot
  4.1.1 auto-configuration, annotated bean catalog, typed bindings, and the
  complete Adapter v1 HTTP transport.

The workspace-only `spring-example` module is an executable live conformance
fixture, not a published consumer dependency.

The Spring modules use Java 21 and Jackson 3 (`tools.jackson.*`). A released
Gradle consumer can depend on the starter with the exact release coordinate:

```kotlin
dependencies {
    implementation("dev.eightlines.gauntlet:spring-boot-starter:0.1.5")
}
```

## Register application features

Only application beans explicitly annotated with `@GauntletFeature`,
`@GauntletOperation`, or `@GauntletDataSource` enter the catalog. The
starter does not component-scan its own package and never derives a controller
or bean name from request data.

```java
@Component
@GauntletFeature(id = "applications", label = "Applications")
final class ApplicationsFeature {}

record FinalizeInput(@NotNull UUID applicationId) {}

@Component
@GauntletOperation(
    id = "applications.finalize",
    featureId = "applications",
    label = "Finalize application",
    input = FinalizeInput.class,
    idempotency = Idempotency.REQUIRED)
final class FinalizeOperation implements TypedOperationHandler<FinalizeInput> {
  @Override
  public OperationResult execute(FinalizeInput input, RunContext context) {
    return OperationResult.succeeded(JsonOwnership.object(Map.of("finalized", true)));
  }
}
```

`TypedDataSource` supplies cursor query and ordered resolve behavior. The
starter installs a `CancelRunEndpoint` backed by Core's run manager, so
`tc-run-cancellation@1` is available without application glue; one application
`CancelRunEndpoint` bean replaces that bridge. The remaining optional HTTP
capabilities are advertised only when exactly one matching SPI bean exists:
`RunEventsEndpoint`, `UploadEndpoint`, or `SessionLaunchEndpoint`.
Configuration strings cannot advertise an endpoint. An absent SPI returns a
typed 501 before body, multipart, store, or handler processing.

Portable Java records may use strings, characters, byte/short/int/long/double
primitives and wrappers, booleans, `BigDecimal`, `UUID`, enums, and scalar
`List<T>` components. `float`/`Float` are rejected because JSON values can
overflow or underflow them during binding. Jakarta nullability, size, numeric,
and portable pattern constraints are reflected in a closed JSON Schema;
constraints on incompatible types and unmodeled constraints fail closed.
`@NotBlank` is intentionally unsupported: its exact
`Character.isWhitespace` complement cannot be expressed by the frozen portable
regular-expression profile, which forbids C0/C1 literals and character-class
escapes. Use a portable explicit `@Pattern` when the accepted character domain
can be narrowed. Unsupported or unsafe definitions are omitted with value-free
diagnostics.

## Asynchronous execution policy

Creating a run validates and reserves it, persists the `queued` snapshot, and
returns HTTP `202`; handlers execute asynchronously. Clients must read
`GET /_gauntlet/v1/runs/{runId}` (or use an installed run-events SPI) until
the run reaches a terminal state. A replay of an idempotency key returns the
same authoritative run and may therefore already be terminal.

`@GauntletOperation` maps directly to the portable execution policy:

- an empty concurrency value or `allow` admits runs independently;
- `forbid` rejects another queued/running run of that operation with
  `urn:gauntlet:problem:operation-busy` (409);
- `queue` admits in FIFO order and invokes only one handler for that operation
  at a time. Waiting turns do not occupy worker threads;
- `timeoutSeconds` starts when the handler starts, not while it is queued;
- `cancellationSupported = true` permits the cancellation endpoint to close
  the run context and request cooperative cancellation. Otherwise the run
  returns `urn:gauntlet:problem:run-not-cancellable` (409) unchanged.

Cancellation and timeout publish exactly one terminal snapshot
(`run-cancelled`, status 409, or `run-timed-out`, status 504). The context is
closed immediately, interruption is best-effort, and late progress, artifacts,
actions, or handler results are ignored. Application handlers should also poll
`RunContext.isCancellationRequested()` or call
`RunContext.throwIfCancellationRequested()` around long-running work.

Core exposes `ExecutionCoordinator` as a replaceable SPI. The default
`InMemoryExecutionCoordinator` is deliberately process-local: its FIFO,
`forbid`, and cancellation guarantees cover only managers in one JVM. A
multi-replica deployment must provide a distributed `ExecutionCoordinator`
bean together with a shared `RunStore`; installing only one of them does not
create a global guarantee. The coordinator implementation must keep a running
reservation until the handler has actually settled, even after cancellation,
timeout, or manager shutdown.

`RunManager` is `AutoCloseable`. Direct Core users should close it (for example,
with try-with-resources) so its owned virtual-thread executor and daemon timeout
scheduler are stopped. Executors supplied through the injection constructor
remain application-owned and are never closed by the manager. Spring closes
the catalog, and therefore its manager, with the application context.

## Complete classpath definitions

For rich UI schemas, input handling, data-source references, presets, or
custom output presentation, set `definitionResource` on the annotation:

```java
@GauntletOperation(
    id = "applications.finalize",
    featureId = "applications",
    label = "Finalize application",
    input = FinalizeInput.class,
    definitionResource = "gauntlet/applications.finalize.json")
```

Resources are loaded only from the application classpath. A local JSON Pointer
fragment such as `gauntlet/operations.json#/finalize` is supported. Absolute
paths, URLs, filesystem fallback, traversal, unreadable resources, mismatched
annotation identity, invalid `tc-schema-core@1` documents, or incorrect JCS
revisions fail closed and never become executable. Data sources offer the
analogous `definitionResource`, `dependencySchemaResource`, and
`contextSchemaResource` attributes.

## Configuration

The adapter stays unavailable unless `gauntlet.enabled` is exactly `true`.
An enabled adapter requires application metadata and a stable secret:

```yaml
gauntlet:
  enabled: true
  application:
    id: example-app
    label: Example application
    environment:
      name: example-app-staging
      kind: staging
  profiles:
    - tc-rich-forms@1
  idempotency-secret: ${GAUNTLET_IDEMPOTENCY_SECRET}
```

`tc-schema-core@1` is always included. Additional `profiles` must be genuine
implemented profile IDs; capabilities are SPI-derived only. Spring
configuration metadata is generated for the typed properties and augmented
with the secret contract under `META-INF/spring-configuration-metadata.json`.

The secret must contain at least 32 UTF-8 bytes. It is never serialized or
rendered and is used only for HMAC fingerprints. All replicas and process
restarts that share a durable `RunStore` must receive the same secret, or
idempotent replay cannot be reliable. The default `InMemoryRunStore` and
`InMemoryExecutionCoordinator` are single-process and non-durable; provide
application beans for both SPIs in a shared, multi-replica environment. A
process-local random secret exists only while the adapter is disabled.

The starter owns only `/_gauntlet/v1` and its fixed protocol routes. It does
not expose arbitrary application endpoints. Place that prefix behind
internal-only ingress or network policy and add environment-appropriate access
control outside this starter. Do not deploy or enable it for production.

### Raw request-target boundary

The highest-precedence servlet filter applies disabled `503`, path/method
validation, and optional-capability checks before Spring MVC and multipart/body
handling, but only after the servlet container has accepted the request target.
Default Tomcat rejects some malformed percent escapes, encoded slashes,
backslashes, and inconsistent absolute-form `Host` targets before any servlet
filter can run. Those connector-owned failures can therefore be container
responses, and an upstream-disabled adapter cannot replace them with its `503`.

The environment ingress in front of this prefix is part of the deployment
contract. It must accept only canonical origin-form Adapter v1 targets and
return a fixed `400` for every malformed or ambiguous original target before
forwarding, in both enabled and disabled upstream modes. In particular, reject
percent-encoded paths, backslashes, absolute-form targets, whitespace,
fragments, queries, repeated or dot segments, trailing slashes, and unsafe path
IDs. Do not normalize and then forward these requests. A uniform protocol
response may use `application/problem+json` with
`urn:gauntlet:problem:invalid-path`. The starter deliberately does not
replace Tomcat's connector or change keep-alive behavior for host application
routes.

## Canonical JSON receipt

Core vendors only the RFC 8785 number serializer sources
`DoubleCoreSerializer.java` and `NumberToJSON.java` from
[`cyberphone/json-canonicalization` commit
`19d51d7fe467d4706a3ff08adf8a748f29fc21e0`](https://github.com/cyberphone/json-canonicalization/commit/19d51d7fe467d4706a3ff08adf8a748f29fc21e0),
with a package-only relocation. No JCS Maven coordinate is present. The
executable receipt in
[`JcsSourceReceiptTest.java`](core/src/test/java/dev/eightlines/gauntlet/core/JcsSourceReceiptTest.java)
reconstructs and hashes both pristine sources plus the complete upstream
Apache-2.0 license. The shared vector gate covers all 16 canonicalization
vectors, the six upstream input/output pairs, and RFC 8785 Appendix B 26/26;
[`CanonicalJsonTest.java`](core/src/test/java/dev/eightlines/gauntlet/core/CanonicalJsonTest.java)
also includes the `1e-320` decision vector.

`core.jar` includes `META-INF/THIRD_PARTY_NOTICES.md` and
`META-INF/licenses/json-canonicalization-LICENSE`. Exact commit, source hashes,
and the license hash are recorded in
[`THIRD_PARTY_NOTICES.md`](core/THIRD_PARTY_NOTICES.md).

## Reproducible verification

From the repository root, run the Java gates in the pinned Gradle/JDK image and
mount the shared protocol fixtures instead of copying them:

```sh
docker run --rm --user "$(id -u):$(id -g)" \
  -e GRADLE_USER_HOME=/gradle-cache \
  -v "$PWD/packages/java/.gradle-user:/gradle-cache" \
  -v "$PWD/packages/java:/workspace" \
  -v "$PWD/packages/protocol:/protocol:ro" \
  -w /workspace gradle:9.2.1-jdk21 \
  ./gradlew -DgauntletProtocolFixtures=/protocol/fixtures/v1 \
  :core:check :spring-boot-starter:check :spring-example:bootJar
```

After the cache is populated, dependency verification and offline closure are
checked with:

```sh
docker run --rm --network none --user "$(id -u):$(id -g)" \
  -e GRADLE_USER_HOME=/gradle-cache \
  -v "$PWD/packages/java/.gradle-user:/gradle-cache" \
  -v "$PWD/packages/java:/workspace" \
  -v "$PWD/packages/protocol:/protocol:ro" \
  -w /workspace gradle:9.2.1-jdk21 \
  ./gradlew --offline -DgauntletProtocolFixtures=/protocol/fixtures/v1 \
  :core:check :spring-boot-starter:check :spring-example:bootJar
```

The SDK rollout order is PHP/Symfony, Node/Next, then Java/Spring. This module
is the application-side adapter layer; the universal dashboard is a separate
consumer of the exposed protocol.

[Documentation index](../../docs/README.md)
