# Gauntlet Java Core

`dev.eightlines.gauntlet:core:0.1.1` is the framework-neutral Java 21
implementation of the Gauntlet Adapter v1 contract. It contains protocol
models, validation, registries, run lifecycle services, canonical JSON, and
the application-facing SPI. It does not expose HTTP routes or start a server.

Most Spring applications should depend on the
[`spring-boot-starter`](../spring-boot-starter/README.md), which brings Core in
transitively. Use Core directly when integrating another framework or when
implementing an adapter around the SPI.

```kotlin
dependencies {
    implementation("dev.eightlines.gauntlet:core:0.1.1")
}
```

The package requires Java 21. Gauntlet Java packages are published to the
8lines GitHub Packages Maven repository,
`https://maven.pkg.github.com/8lines/gauntlet`. GitHub Packages requires
authentication even for public packages, so reading them needs a GitHub
account and a personal access token (classic) with the `read:packages` scope.
Supply those credentials through your build environment, as described in
[installing packages](../../../docs/releases/installing-packages.md#maven),
rather than storing account data in a Gradle file.

The default run store and execution coordinator are in-memory and
process-local. Close `RunManager` when using Core directly, and replace both
SPIs together when a durable, multi-replica deployment is required.

See the [Java SDK guide](../README.md) for the supported model surface,
execution policy, canonical JSON receipt, and reproducible verification.

[Documentation index](../../../docs/README.md)
