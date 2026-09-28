# Gauntlet Starter API Consumer Test

`starter-api-consumer-test` is a compile-time Java 21 fixture that depends only
on `spring-boot-starter`. It proves that the starter exposes the documented
Core, Spring, Jakarta Validation, and multipart types needed by an application
without an additional direct Core dependency.

This module is internal test infrastructure, not a published Maven artifact.
The Java release gate runs `:starter-api-consumer-test:check` before staging the
publishable modules.

See the [Spring Boot starter guide](../spring-boot-starter/README.md) for the
consumer-facing dependency and configuration contract.

[Documentation index](../../../docs/README.md)
