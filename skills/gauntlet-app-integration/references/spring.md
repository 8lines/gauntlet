# Java and Spring Boot

Support Java 21 and Spring Boot 4.1. The starter is on GitHub Packages Maven (`https://maven.pkg.github.com/8lines/gauntlet`), which requires a GitHub token with `read:packages` even for public packages; supply those credentials outside project files and install the exact starter; Core is transitive:

```kotlin
dependencies {
    implementation("dev.eightlines.gauntlet:spring-boot-starter:0.1.6")
}
```

Enable only in a selected non-production profile. Configure structured application metadata and a deployment-owned secret reference:

```yaml
gauntlet:
  enabled: true
  application:
    id: billing-api
    label: Billing API
    environment:
      name: staging
      kind: staging
  idempotency-secret: ${GAUNTLET_IDEMPOTENCY_SECRET}
```

Map the deployment's organization-specific production aliases and infrastructure identities before enabling; passing the built-in token check is only a minimum and an ambiguous identity blocks enablement.

The starter auto-configures exactly one `/_gauntlet/v1` transport. Register only explicit typed application beans/annotations; do not add a second controller or generic executor. Confirm startup denial for missing metadata, a production-like structured environment, and a missing/short secret.

The default store and coordinator are process-local. A multi-threaded server may use them only where guarantees remain within one JVM; replicas, distributed FIFO/forbid, or cross-replica cancellation require application beans backed by shared infrastructure for both `RunStore` and `ExecutionCoordinator`. A dispatcher schedules the supplied task in its current process and never serializes or drops it. Shared components provide distributed admission and cancellation visibility, but cannot replay or resume that task after process loss. Use a verified singleton execution process with no durability claim, or leases/heartbeats that terminalize orphaned/stale runs and recover through a newly created application execution. Never claim durable execution replay. When SSE is advertised, add shared durable event history and a live event backplane without conflating event durability with execution durability. Account for the autoscaler's future maximum, not only today's replica count.

Tomcat may reject malformed targets before servlet filters. Require a trusted private ingress that rejects unsafe original targets before normalization and an explicit public denial for the adapter prefix. Do not claim uniform raw-target behavior from MVC tests alone.

Configure one internal target with exact `expectedEnvironment`. Run locked Gradle verification on Java 21, context/startup denial, exact one-transport inspection, target mismatch on every proxy path, raw-ingress negative probes, application-specific live Adapter v1 checks, and public denial. Prefer released `0.1.6` metadata and `packages/java/spring-example` from the matching release; reject `0.1.6-SNAPSHOT` coordinates or scalar-environment examples.
