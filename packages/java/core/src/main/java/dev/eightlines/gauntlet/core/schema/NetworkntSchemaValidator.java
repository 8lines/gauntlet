package dev.eightlines.gauntlet.core.schema;

import com.networknt.schema.InputFormat;
import com.networknt.schema.Schema;
import com.networknt.schema.SchemaRegistry;
import com.networknt.schema.SchemaRegistryConfig;
import com.networknt.schema.dialect.Dialects;
import dev.eightlines.gauntlet.core.json.CanonicalJson;
import dev.eightlines.gauntlet.core.json.JsonObject;
import dev.eightlines.gauntlet.core.json.JsonOwnership;
import dev.eightlines.gauntlet.core.json.JsonValue;
import dev.eightlines.gauntlet.core.model.ValidationError;
import java.util.Comparator;
import java.util.List;
import java.util.Map;

/** Offline Draft 2020-12 validation backed by Networknt/Jackson 3. */
public final class NetworkntSchemaValidator implements SchemaValidator {
  private final SchemaRegistry registry;

  public NetworkntSchemaValidator() {
    var config =
        SchemaRegistryConfig.builder()
            .formatAssertionsEnabled(true)
            .regularExpressionFactory(source -> value -> PortablePattern.matches(source, value))
            .build();
    this.registry =
        SchemaRegistry.withDialect(
            Dialects.getDraft202012(), builder -> builder.schemaRegistryConfig(config));
  }

  @Override
  public List<ValidationError> validate(JsonObject schemaDocument, JsonValue instance) {
    TcSchemaCore.assertValid(schemaDocument, false);
    try {
      Schema schema =
          registry.getSchema(CanonicalJson.encodeString(schemaDocument), InputFormat.JSON);
      return schema
          .validate(
              CanonicalJson.encodeString(instance),
              InputFormat.JSON,
              context ->
                  context.executionConfig(
                      configuration -> configuration.formatAssertionsEnabled(true)))
          .stream()
          .map(
              error ->
                  new ValidationError(
                      normalizeInstancePath(error),
                      normalizeSchemaPath(error.getEvaluationPath().toString()),
                      safeKeyword(error.getKeyword()),
                      "value does not satisfy schema",
                      JsonOwnership.object(Map.of())))
          .sorted(
              Comparator.comparing(ValidationError::instancePath)
                  .thenComparing(ValidationError::schemaPath)
                  .thenComparing(ValidationError::keyword))
          .toList();
    } catch (RuntimeException exception) {
      throw new IllegalArgumentException("invalid or unsupported JSON Schema", exception);
    }
  }

  private static String normalizePointer(String value) {
    if (value == null || value.isEmpty() || "#".equals(value)) return "";
    return value.startsWith("#") ? value.substring(1) : value;
  }

  private static String normalizeInstancePath(com.networknt.schema.Error error) {
    String path = normalizePointer(error.getInstanceLocation().toString());
    if (!"required".equals(error.getKeyword()) || error.getProperty() == null) return path;
    return path + "/" + pointerToken(error.getProperty());
  }

  private static String pointerToken(String value) {
    return value.replace("~", "~0").replace("/", "~1");
  }

  private static String normalizeSchemaPath(String value) {
    String pointer = normalizePointer(value);
    return pointer.isEmpty() ? "#" : "#" + pointer;
  }

  private static String safeKeyword(String value) {
    return value == null || value.isBlank() ? "validation" : value;
  }
}
