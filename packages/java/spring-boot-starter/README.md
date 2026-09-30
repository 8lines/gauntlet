# Gauntlet Spring Boot Starter

`dev.eightlines.gauntlet:spring-boot-starter:0.1.3` is the Java 21 and Spring
Boot 4.1 integration for Gauntlet Adapter v1. It supplies typed
configuration, explicit annotated-bean discovery, auto-configuration, and the
fixed `/_gauntlet/v1` HTTP transport. Core is included transitively.

```kotlin
dependencies {
    implementation("dev.eightlines.gauntlet:spring-boot-starter:0.1.3")
}
```

The package is published to the 8lines GitHub Packages Maven repository,
`https://maven.pkg.github.com/8lines/gauntlet`. GitHub Packages requires
authentication even for public packages, so reading it needs a GitHub account
and a personal access token (classic) with the `read:packages` scope. Supply
those credentials through the build environment, as described in
[installing packages](../../../docs/releases/installing-packages.md#maven); do
not commit account data to Gradle settings or project files.

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
