package dev.eightlines.gauntlet.spring;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import dev.eightlines.gauntlet.core.json.JsonOwnership;
import dev.eightlines.gauntlet.core.model.ExecutionPolicy;
import dev.eightlines.gauntlet.core.model.Idempotency;
import dev.eightlines.gauntlet.core.model.OperationDefinition;
import dev.eightlines.gauntlet.core.model.OperationImpact;
import dev.eightlines.gauntlet.core.model.OperationOutput;
import dev.eightlines.gauntlet.core.model.OperationResult;
import dev.eightlines.gauntlet.spring.catalog.SpringOperationBinding;
import dev.eightlines.gauntlet.spring.spi.TypedOperationHandler;
import jakarta.validation.Validation;
import jakarta.validation.constraints.NotBlank;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

class SpringOperationBindingTest {
  @Test
  void executeValidatesTheSecondBindingBeforeCallingTheTypedHandler() {
    StatefulInput.CONSTRUCTIONS.set(0);
    var handlerCalls = new AtomicInteger();
    TypedOperationHandler<StatefulInput> handler =
        (input, context) -> {
          handlerCalls.incrementAndGet();
          return OperationResult.succeeded(JsonOwnership.object(Map.of()));
        };
    try (var validatorFactory = Validation.buildDefaultValidatorFactory()) {
      var binding =
          new SpringOperationBinding(
              definition(),
              StatefulInput.class,
              handler,
              new ObjectMapper(),
              validatorFactory.getValidator());
      var input = JsonOwnership.object(Map.of("value", "safe"));

      assertThat(binding.validateInput(input)).isEmpty();
      assertThatThrownBy(() -> binding.execute(input, null))
          .isInstanceOf(IllegalArgumentException.class)
          .hasMessageNotContaining("safe");
      assertThat(handlerCalls).hasValue(0);
    }
  }

  private static OperationDefinition definition() {
    var schema =
        JsonOwnership.object(
            Map.of("$schema", "https://json-schema.org/draft/2020-12/schema", "type", "object"));
    return new OperationDefinition(
        "applications.stateful",
        "applications",
        "Stateful",
        null,
        schema,
        null,
        null,
        null,
        List.of(),
        List.of(),
        new ExecutionPolicy(
            OperationImpact.WRITE,
            false,
            false,
            Idempotency.OPTIONAL,
            false,
            null,
            "allow",
            JsonOwnership.object(Map.of())),
        new OperationOutput(schema, null, JsonOwnership.object(Map.of())),
        null,
        0,
        List.of(),
        null,
        JsonOwnership.object(Map.of()));
  }

  private record StatefulInput(@NotBlank String value) {
    private static final AtomicInteger CONSTRUCTIONS = new AtomicInteger();

    private StatefulInput {
      if (CONSTRUCTIONS.incrementAndGet() == 2) value = " ";
    }
  }
}
