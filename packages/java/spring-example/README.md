# Gauntlet Spring Example

`spring-example` is the executable Java 21 conformance fixture for the Test
Center Spring Boot starter. It exercises explicit feature, operation, and data
source registration together with classpath-backed Adapter v1 definitions.

This module is an internal build fixture, not a library for application
dependencies and not a published Maven artifact. The release gate builds its
Spring Boot executable archive with `:spring-example:bootJar` so changes to the
published starter are checked against a real application.

See the [Java SDK guide](../README.md) for the supported registration model and
deployment boundary.

[Documentation index](../../../docs/README.md)
