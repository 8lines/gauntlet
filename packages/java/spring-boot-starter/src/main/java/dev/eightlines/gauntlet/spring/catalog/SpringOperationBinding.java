package dev.eightlines.gauntlet.spring.catalog;

import dev.eightlines.gauntlet.core.json.CanonicalJson;
import dev.eightlines.gauntlet.core.json.JsonObject;
import dev.eightlines.gauntlet.core.model.OperationDefinition;
import dev.eightlines.gauntlet.core.model.OperationResult;
import dev.eightlines.gauntlet.core.model.ValidationError;
import dev.eightlines.gauntlet.core.spi.OperationHandler;
import dev.eightlines.gauntlet.core.spi.RunContext;
import dev.eightlines.gauntlet.spring.spi.TypedOperationHandler;
import jakarta.validation.ConstraintViolation;
import jakarta.validation.ElementKind;
import jakarta.validation.Path;
import jakarta.validation.Validator;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import tools.jackson.databind.ObjectMapper;

/** A validated typed Spring bean exposed through the framework-neutral Core operation SPI. */
public final class SpringOperationBinding implements OperationHandler<JsonObject> {
  private final OperationDefinition definition;
  private final Class<?> inputType;
  private final TypedOperationHandler<?> handler;
  private final ObjectMapper objectMapper;
  private final Validator validator;

  public SpringOperationBinding(
      OperationDefinition definition,
      Class<?> inputType,
      TypedOperationHandler<?> handler,
      ObjectMapper objectMapper,
      Validator validator) {
    this.definition = Objects.requireNonNull(definition, "definition");
    this.inputType = Objects.requireNonNull(inputType, "inputType");
    this.handler = Objects.requireNonNull(handler, "handler");
    this.objectMapper = Objects.requireNonNull(objectMapper, "objectMapper");
    this.validator = Objects.requireNonNull(validator, "validator");
  }

  @Override
  public OperationDefinition definition() {
    return definition;
  }

  public Class<?> inputType() {
    return inputType;
  }

  @Override
  public List<ValidationError> validateInput(JsonObject input) {
    Object mapped;
    try {
      mapped = bind(input);
    } catch (RuntimeException exception) {
      return List.of(error("", "binding"));
    }
    return validationErrors(mapped);
  }

  private List<ValidationError> validationErrors(Object mapped) {
    try {
      var errors = new ArrayList<ValidationError>();
      for (ConstraintViolation<Object> violation : validator.validate(mapped)) {
        errors.add(error(pointer(violation.getPropertyPath()), "jakarta-validation"));
      }
      errors.sort(
          Comparator.comparing(ValidationError::instancePath)
              .thenComparing(ValidationError::keyword));
      return List.copyOf(errors);
    } catch (RuntimeException exception) {
      return List.of(error("", "jakarta-validation"));
    }
  }

  @Override
  public OperationResult execute(JsonObject input, RunContext context) throws Exception {
    Object mapped = bind(input);
    if (!validationErrors(mapped).isEmpty()) {
      throw new IllegalArgumentException("operation input validation failed");
    }
    return executeTyped(mapped, context);
  }

  private Object bind(JsonObject input) {
    try {
      return objectMapper.readValue(CanonicalJson.encode(input), inputType);
    } catch (RuntimeException exception) {
      throw new IllegalArgumentException("operation input binding failed");
    }
  }

  private static String pointer(Path path) {
    var result = new StringBuilder();
    for (Path.Node node : path) {
      if (node.getKind() == ElementKind.PROPERTY && node.getName() != null) {
        result.append('/').append(token(node.getName()));
      }
      if (node.getIndex() != null) result.append('/').append(node.getIndex());
    }
    return result.toString();
  }

  private static String token(String value) {
    return value.replace("~", "~0").replace("/", "~1");
  }

  private static ValidationError error(String instancePath, String keyword) {
    return new ValidationError(
        instancePath,
        "#",
        keyword,
        "value does not satisfy schema",
        dev.eightlines.gauntlet.core.json.JsonOwnership.object(Map.of()));
  }

  @SuppressWarnings("unchecked")
  private OperationResult executeTyped(Object input, RunContext context) throws Exception {
    return ((TypedOperationHandler<Object>) handler).execute(input, context);
  }
}
