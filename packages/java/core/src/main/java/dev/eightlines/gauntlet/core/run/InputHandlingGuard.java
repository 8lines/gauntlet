package dev.eightlines.gauntlet.core.run;

import dev.eightlines.gauntlet.core.json.JsonList;
import dev.eightlines.gauntlet.core.json.JsonObject;
import dev.eightlines.gauntlet.core.json.JsonOwnership;
import dev.eightlines.gauntlet.core.json.JsonValue;
import dev.eightlines.gauntlet.core.model.FileReference;
import dev.eightlines.gauntlet.core.model.InputHandling;
import dev.eightlines.gauntlet.core.model.OperationDefinition;
import dev.eightlines.gauntlet.core.model.ValidationError;
import dev.eightlines.gauntlet.core.schema.ProtocolSemantics;
import dev.eightlines.gauntlet.core.spi.FileReferenceValidator;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

public final class InputHandlingGuard {
  private InputHandlingGuard() {}

  public static List<ValidationError> validateFiles(
      OperationDefinition operation,
      JsonObject input,
      FileReferenceValidator validator,
      Instant now) {
    if (operation.inputHandling() == null || operation.inputHandling().fileRules().isEmpty())
      return List.of();
    var errors = new ArrayList<ValidationError>();
    for (InputHandling.FileRule rule : operation.inputHandling().fileRules()) {
      List<ProtocolSemantics.InputLocation> locations;
      try {
        locations =
            ProtocolSemantics.operationInputLocations(operation, input, rule.schemaPointer());
      } catch (RuntimeException exception) {
        errors.add(error("", "schemaPointer", "file schema pointer is not instance-addressable"));
        continue;
      }
      for (ProtocolSemantics.InputLocation inputLocation : locations) {
        String pointer = inputLocation.instancePointer();
        JsonValue value = inputLocation.value();
        if (validator == null) {
          errors.add(error(pointer, "file-validator", "file rule has no installed validator"));
          continue;
        }
        List<JsonValue> references;
        if (rule.multiple()) {
          if (!(value instanceof JsonList list)) {
            errors.add(error(pointer, "type", "file rule requires an array"));
            continue;
          }
          references = list.values();
        } else {
          if (value instanceof JsonList) {
            errors.add(error(pointer, "type", "file rule requires one file"));
            continue;
          }
          references = List.of(value);
        }
        for (int index = 0; index < references.size(); index++) {
          String referencePointer = rule.multiple() ? pointer + "/" + index : pointer;
          try {
            FileReference reference = fileReference(references.get(index));
            if (!OffsetDateTime.parse(reference.expiresAt()).toInstant().isAfter(now)) {
              errors.add(error(referencePointer, "expiresAt", "file reference has expired"));
              continue;
            }
            if (!rule.mediaTypes().isEmpty()
                && !rule.mediaTypes().contains(reference.mediaType())) {
              errors.add(error(referencePointer, "mediaType", "file media type is not allowed"));
              continue;
            }
            if (rule.maxBytes() != null && reference.sizeBytes() > rule.maxBytes()) {
              errors.add(error(referencePointer, "maxBytes", "file exceeds the maximum size"));
              continue;
            }
            errors.addAll(
                Objects.requireNonNull(
                    validator.validate(
                        new FileReferenceValidator.ValidationRequest(
                            reference,
                            rule,
                            referencePointer,
                            operation.id(),
                            operation.revision(),
                            now)),
                    "file validation errors"));
          } catch (RuntimeException exception) {
            errors.add(error(referencePointer, "file-reference", "invalid file reference"));
          }
        }
      }
    }
    return List.copyOf(errors);
  }

  public static SecretGuard secretGuard(OperationDefinition operation, JsonObject input) {
    return new SecretGuard(ProtocolSemantics.operationSecretAtoms(operation, input));
  }

  public static final class SecretGuard {
    private final Set<String> strings = new HashSet<>();
    private final Set<Long> numbers = new HashSet<>();
    private final boolean containsTrue;
    private final boolean containsFalse;
    private final boolean containsNull;

    private SecretGuard(List<JsonValue.Scalar> atoms) {
      boolean foundTrue = false;
      boolean foundFalse = false;
      boolean foundNull = false;
      for (JsonValue.Scalar atom : atoms) {
        Object value = atom.value();
        if (value instanceof String string) {
          strings.add(string);
        } else if (value instanceof Number number) {
          numbers.add(Double.doubleToLongBits(number.doubleValue()));
        } else if (Boolean.TRUE.equals(value)) {
          foundTrue = true;
        } else if (Boolean.FALSE.equals(value)) {
          foundFalse = true;
        } else if (value == null) {
          foundNull = true;
        }
      }
      containsTrue = foundTrue;
      containsFalse = foundFalse;
      containsNull = foundNull;
    }

    public boolean isEmpty() {
      return strings.isEmpty()
          && numbers.isEmpty()
          && !containsTrue
          && !containsFalse
          && !containsNull;
    }

    public boolean contains(JsonValue value) {
      if (value == null || isEmpty()) {
        return false;
      }
      var pending = new ArrayDeque<JsonValue>();
      pending.push(value);
      while (!pending.isEmpty()) {
        JsonValue current = pending.pop();
        if (current instanceof JsonValue.Scalar scalar && containsScalar(scalar.value())) {
          return true;
        }
        if (current instanceof JsonObject object) {
          for (Map.Entry<String, JsonValue> entry : object.values().entrySet()) {
            if (containsString(entry.getKey())) {
              return true;
            }
            pending.push(entry.getValue());
          }
        } else if (current instanceof JsonList list) {
          pending.addAll(list.values());
        }
      }
      return false;
    }

    public boolean containsString(String value) {
      if (value == null) {
        return false;
      }
      for (String secret : strings) {
        if (secret.isEmpty() ? value.isEmpty() : value.contains(secret)) {
          return true;
        }
      }
      return false;
    }

    public List<ValidationError> sanitizeValidationErrors(List<ValidationError> errors) {
      if (errors.isEmpty() || isEmpty()) {
        return List.copyOf(errors);
      }
      var sanitized = new ArrayList<ValidationError>(errors.size());
      for (ValidationError error : errors) {
        sanitized.add(
            new ValidationError(
                safe(error.instancePath(), ""),
                safe(error.schemaPath(), "#"),
                safe(error.keyword(), "validation"),
                safe(error.message(), "value does not satisfy schema"),
                contains(error.params())
                    ? JsonOwnership.object(Collections.emptyMap())
                    : error.params(),
                contains(error.extensions())
                    ? JsonOwnership.object(Collections.emptyMap())
                    : error.extensions()));
      }
      return List.copyOf(sanitized);
    }

    private String safe(String value, String fallback) {
      return containsString(value) ? fallback : value;
    }

    private boolean containsScalar(Object value) {
      if (value instanceof String string) {
        return containsString(string);
      }
      if (value instanceof Number number) {
        return numbers.contains(Double.doubleToLongBits(number.doubleValue()));
      }
      if (Boolean.TRUE.equals(value)) {
        return containsTrue;
      }
      if (Boolean.FALSE.equals(value)) {
        return containsFalse;
      }
      return value == null && containsNull;
    }
  }

  private static FileReference fileReference(JsonValue value) {
    if (!(value instanceof JsonObject object))
      throw new IllegalArgumentException("file reference must be object");
    if (!Set.of(
                "kind",
                "uploadId",
                "name",
                "mediaType",
                "sizeBytes",
                "sha256",
                "expiresAt",
                "extensions")
            .containsAll(object.values().keySet())
        || !"file".equals(nullableString(object, "kind"))) {
      throw new IllegalArgumentException("file reference has invalid members");
    }
    return new FileReference(
        string(object, "uploadId"),
        string(object, "name"),
        string(object, "mediaType"),
        integer(object, "sizeBytes"),
        optionalString(object, "sha256"),
        string(object, "expiresAt"),
        optionalObject(object, "extensions"));
  }

  private static String string(JsonObject object, String key) {
    String result = nullableString(object, key);
    if (result == null) throw new IllegalArgumentException("missing " + key);
    return result;
  }

  private static String nullableString(JsonObject object, String key) {
    JsonValue value = object.get(key);
    return value != null && value.unwrap() instanceof String string ? string : null;
  }

  private static String optionalString(JsonObject object, String key) {
    JsonValue value = object.get(key);
    if (value == null) return null;
    if (value.unwrap() instanceof String string) return string;
    throw new IllegalArgumentException("invalid " + key);
  }

  private static long integer(JsonObject object, String key) {
    JsonValue value = object.get(key);
    if (value == null) {
      throw new IllegalArgumentException("invalid " + key);
    }
    Object raw = value.unwrap();
    long number;
    if (raw instanceof Long integer) {
      number = integer;
    } else if (raw instanceof Double decimal
        && Double.isFinite(decimal)
        && decimal == Math.rint(decimal)
        && Double.doubleToRawLongBits(decimal) != Double.doubleToRawLongBits(-0.0d)) {
      number = (long) decimal.doubleValue();
    } else {
      throw new IllegalArgumentException("invalid " + key);
    }
    if (number < 0 || number > JsonValue.MAX_SAFE_INTEGER) {
      throw new IllegalArgumentException("invalid " + key);
    }
    return number;
  }

  private static JsonObject optionalObject(JsonObject object, String key) {
    JsonValue value = object.get(key);
    if (value == null) return JsonOwnership.object(Map.of());
    if (value instanceof JsonObject result) return result;
    throw new IllegalArgumentException("invalid " + key);
  }

  private static ValidationError error(String path, String keyword, String message) {
    return new ValidationError(
        path, "#/inputHandling", keyword, message, JsonOwnership.object(Map.of()));
  }
}
