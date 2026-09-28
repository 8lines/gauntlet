# Java and Spring extension

Use the already-integrated exact
`dev.eightlines.gauntlet:spring-boot-starter` version. Spring discovers only
explicit annotated beans. Keep the operation and its definition resource in
application code; do not add a controller, servlet filter, or route.

## Fixed operation

```java
package app.gauntlet;

import dev.eightlines.gauntlet.core.json.JsonOwnership;
import dev.eightlines.gauntlet.core.model.InvocationContext;
import dev.eightlines.gauntlet.core.model.OperationResult;
import dev.eightlines.gauntlet.core.spi.RunContext;
import dev.eightlines.gauntlet.spring.annotation.GauntletFeature;
import dev.eightlines.gauntlet.spring.annotation.GauntletOperation;
import dev.eightlines.gauntlet.spring.spi.TypedOperationHandler;
import jakarta.validation.constraints.NotNull;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import org.springframework.stereotype.Component;

@Component
@GauntletFeature(id = "notifications", label = "Notifications")
final class NotificationsFeature {}

record ResendWelcomeEmailInput(@NotNull UUID userId) {}

record Delivery(UUID deliveryId, Status status) {
  Delivery {
    Objects.requireNonNull(deliveryId);
    Objects.requireNonNull(status);
  }
}

enum Status {
  QUEUED("queued"), ALREADY_QUEUED("already-queued");
  final String wire;
  Status(String wire) { this.wire = wire; }
}

interface GauntletScope {
  String requireUserAccess(InvocationContext context, UUID userId);
}

interface WelcomeEmailService {
  Delivery resend(String tenantId, UUID userId);
}

@Component
@GauntletOperation(
    id = "notifications.resend-welcome-email",
    featureId = "notifications",
    label = "Resend welcome email",
    input = ResendWelcomeEmailInput.class,
    definitionResource = "gauntlet/notifications.resend-welcome-email.json")
final class ResendWelcomeEmailOperation
    implements TypedOperationHandler<ResendWelcomeEmailInput> {
  private final GauntletScope scope;
  private final WelcomeEmailService emails;

  ResendWelcomeEmailOperation(GauntletScope scope, WelcomeEmailService emails) {
    this.scope = scope;
    this.emails = emails;
  }

  @Override
  public OperationResult execute(ResendWelcomeEmailInput input, RunContext context) {
    var invocation = context.invocationContext()
        .orElseThrow(() -> new IllegalStateException("domain access denied"));
    String tenantId = scope.requireUserAccess(invocation, input.userId());
    Delivery delivery = emails.resend(tenantId, input.userId());
    return OperationResult.succeeded(JsonOwnership.object(Map.of(
        "deliveryId", delivery.deliveryId().toString(),
        "status", delivery.status().wire)));
  }
}
```

`GauntletScope` and `WelcomeEmailService` are fixed application-owned
interfaces. The scope resolves actor/target claims and enforces tenant and
synthetic-domain rules before the email service runs.

Place this closed definition at
`src/main/resources/gauntlet/notifications.resend-welcome-email.json`:

```json
{
  "id": "notifications.resend-welcome-email",
  "revision": "sha256:1c05e9c6c80de76baf035babf9b50857f0af0521f724a3d5bb1376f9522e8107",
  "label": "Resend welcome email",
  "featureId": "notifications",
  "description": "Queues one welcome email for an authorized synthetic user.",
  "order": 10,
  "tags": ["notifications", "email"],
  "inputSchema": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "required": ["userId"],
    "properties": {"userId": {"type": "string", "format": "uuid"}},
    "additionalProperties": false
  },
  "contextSchema": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "required": ["requestId", "actor", "target"],
    "properties": {
      "requestId": {"type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"},
      "locale": {"type": "string", "maxLength": 128},
      "timeZone": {"type": "string", "maxLength": 128},
      "actor": {
        "type": "object",
        "required": ["id"],
        "properties": {
          "id": {"type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"},
          "displayName": {"type": "string", "maxLength": 256}
        },
        "additionalProperties": false
      },
      "target": {
        "type": "object",
        "required": ["id"],
        "properties": {
          "id": {"type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"},
          "environment": {"type": "string", "maxLength": 128}
        },
        "additionalProperties": false
      }
    },
    "additionalProperties": false
  },
  "dataSources": [],
  "presets": [],
  "execution": {
    "impact": "write",
    "confirmationRequired": true,
    "dryRunSupported": false,
    "idempotency": "required",
    "cancellationSupported": false,
    "timeoutSeconds": 30,
    "concurrency": "allow"
  },
  "output": {
    "schema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "required": ["deliveryId", "status"],
      "properties": {
        "deliveryId": {"type": "string", "format": "uuid"},
        "status": {"type": "string", "enum": ["queued", "already-queued"]}
      },
      "additionalProperties": false
    }
  }
}
```

The resource loader rejects URLs, absolute paths, traversal, identity mismatch,
and a stale revision. After any definition change, parse the classpath bytes
with `JsonOwnership.parseRevision`, cast to `JsonObject`, and assert its
`revision` member equals `CanonicalJson.revision(document, "revision")` in a
build test; update the recorded value from that computation.

## Focused tests

In JUnit, construct the handler with a scope spy and email-service spy. Supply a
real `InvocationContext` through a test `RunContext`. Assert scope-before-email,
one service call with returned tenant ID and UUID, and an owned output map with
exactly `deliveryId` and `status`. Make the scope throw in a second test and
verify zero email interactions.

Then use the existing Spring test application and HTTP client to prove record
and Jakarta validation, definition-resource revision, acknowledgement denial,
same-key original-Run replay after changed valid input/request ID with one
service mutation, runtime invalid-output normalization, tenant denial, leak
resistance, and single catalog registration. Send `idempotencyKey` through
create-run admission; `requestId` is correlation only. Do not change adapter
properties or web configuration.
