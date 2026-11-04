# Gauntlet Spring Boot Starter

`dev.8lines.gauntlet:spring-boot-starter:0.2.0` is the Java 21 and Spring
Boot 4.1 integration for Gauntlet Adapter v1. It supplies typed
configuration, explicit annotated-bean discovery, auto-configuration, and the
fixed `/_gauntlet/v1` HTTP transport. Core is included transitively.

```kotlin
dependencies {
    implementation("dev.8lines.gauntlet:spring-boot-starter:0.2.0")
}
```

The package is published to Maven Central and needs no credentials, as
described in
[installing packages](../../../docs/releases/installing-packages.md#maven).

The adapter is disabled by default. Enable it only on development or test
ingress, provide application metadata and a stable idempotency secret, and
register features or operations explicitly. It contains no dashboard UI or
authorization layer and must not be exposed on production ingress.

```yaml
gauntlet:
  enabled: true
  application:
    id: example-app
    label: Example application
    environment:
      name: example-app-staging
      kind: staging
  idempotency-secret: ${GAUNTLET_IDEMPOTENCY_SECRET}
```

See the [Java SDK guide](../README.md) for registration examples, supported
schema types, endpoint behavior, cancellation semantics, and the complete
deployment boundary.

[Documentation index](../../../docs/README.md)
