package dev.eightlines.gauntlet.spring.catalog;

import dev.eightlines.gauntlet.core.json.JsonList;
import dev.eightlines.gauntlet.core.json.JsonObject;
import dev.eightlines.gauntlet.core.json.JsonOwnership;
import dev.eightlines.gauntlet.core.json.JsonValue;
import dev.eightlines.gauntlet.core.model.DataSourceDefinition;
import dev.eightlines.gauntlet.core.model.DataSourceReference;
import dev.eightlines.gauntlet.core.model.ExecutionPolicy;
import dev.eightlines.gauntlet.core.model.Idempotency;
import dev.eightlines.gauntlet.core.model.InputHandling;
import dev.eightlines.gauntlet.core.model.OperationDefinition;
import dev.eightlines.gauntlet.core.model.OperationImpact;
import dev.eightlines.gauntlet.core.model.OperationOutput;
import dev.eightlines.gauntlet.core.model.OperationPlacement;
import dev.eightlines.gauntlet.core.model.OperationPreset;
import dev.eightlines.gauntlet.core.model.OperationUiSchema;
import dev.eightlines.gauntlet.core.model.ProtocolRequirements;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Maps already-owned classpath documents into the closed Core protocol model. */
final class ProtocolDocumentMapper {
  OperationDefinition operation(JsonObject value) {
    requireKeys(
        value,
        Set.of(
            "id",
            "revision",
            "label",
            "featureId",
            "order",
            "tags",
            "inputSchema",
            "dataSources",
            "presets",
            "execution",
            "output"),
        Set.of(
            "id",
            "revision",
            "label",
            "featureId",
            "description",
            "icon",
            "order",
            "tags",
            "requirements",
            "placements",
            "inputSchema",
            "inputHandling",
            "contextSchema",
            "uiSchema",
            "dataSources",
            "presets",
            "execution",
            "output",
            "extensions"));
    var definition =
        new OperationDefinition(
            string(value, "id"),
            string(value, "featureId"),
            string(value, "label"),
            optionalString(value, "description"),
            object(value, "inputSchema"),
            value.get("inputHandling") == null
                ? null
                : inputHandling(object(value, "inputHandling")),
            optionalObject(value, "contextSchema"),
            value.get("uiSchema") == null ? null : uiSchema(object(value, "uiSchema")),
            objects(value, "dataSources").stream().map(this::dataSourceReference).toList(),
            objects(value, "presets").stream().map(this::preset).toList(),
            execution(object(value, "execution")),
            output(object(value, "output")),
            optionalString(value, "icon"),
            integer(value, "order"),
            strings(value, "tags"),
            value.get("requirements") == null ? null : requirements(object(value, "requirements")),
            extensions(value),
            value.get("placements") == null ? List.of() : placements(value.get("placements")));
    if (!string(value, "revision").equals(definition.revision())) {
      throw new IllegalArgumentException("operation resource revision is invalid");
    }
    return definition;
  }

  DataSourceDefinition dataSource(JsonObject value) {
    requireKeys(
        value,
        Set.of("id", "label", "capabilities"),
        Set.of(
            "id",
            "label",
            "description",
            "capabilities",
            "dependencySchema",
            "contextSchema",
            "extensions"));
    JsonObject capabilities = object(value, "capabilities");
    requireKeys(
        capabilities,
        Set.of("search", "pagination", "resolve", "defaultLimit", "maxLimit"),
        Set.of("search", "pagination", "resolve", "defaultLimit", "maxLimit"));
    return new DataSourceDefinition(
        string(value, "id"),
        string(value, "label"),
        optionalString(value, "description"),
        bool(capabilities, "search"),
        string(capabilities, "pagination"),
        bool(capabilities, "resolve"),
        integer(capabilities, "defaultLimit"),
        integer(capabilities, "maxLimit"),
        optionalObject(value, "dependencySchema"),
        optionalObject(value, "contextSchema"),
        extensions(value));
  }

  private InputHandling inputHandling(JsonObject value) {
    requireKeys(value, Set.of("rules"), Set.of("rules", "extensions"));
    return new InputHandling(objects(value, "rules"), extensions(value));
  }

  private OperationUiSchema uiSchema(JsonObject value) {
    requireKeys(value, Set.of("profile", "root"), Set.of("profile", "root", "extensions"));
    return new OperationUiSchema(
        string(value, "profile"), object(value, "root"), extensions(value));
  }

  private DataSourceReference dataSourceReference(JsonObject value) {
    requireKeys(
        value,
        Set.of("id", "inputPointer", "dependencyPointers"),
        Set.of(
            "id",
            "inputPointer",
            "dependencyPointers",
            "contextPointers",
            "required",
            "extensions"));
    return new DataSourceReference(
        string(value, "id"),
        string(value, "inputPointer"),
        strings(value, "dependencyPointers"),
        value.get("contextPointers") == null ? List.of() : strings(value, "contextPointers"),
        optionalBoolean(value, "required"),
        extensions(value));
  }

  private OperationPreset preset(JsonObject value) {
    requireKeys(
        value,
        Set.of("id", "label", "input"),
        Set.of("id", "label", "description", "input", "lockedPointers", "extensions"));
    return new OperationPreset(
        string(value, "id"),
        string(value, "label"),
        optionalString(value, "description"),
        object(value, "input"),
        value.get("lockedPointers") == null ? List.of() : strings(value, "lockedPointers"),
        extensions(value));
  }

  private ExecutionPolicy execution(JsonObject value) {
    requireKeys(
        value,
        Set.of(
            "impact",
            "confirmationRequired",
            "dryRunSupported",
            "idempotency",
            "cancellationSupported"),
        Set.of(
            "impact",
            "confirmationRequired",
            "dryRunSupported",
            "idempotency",
            "cancellationSupported",
            "timeoutSeconds",
            "concurrency",
            "extensions"));
    return new ExecutionPolicy(
        OperationImpact.fromWireValue(string(value, "impact")),
        bool(value, "confirmationRequired"),
        bool(value, "dryRunSupported"),
        Idempotency.fromWireValue(string(value, "idempotency")),
        bool(value, "cancellationSupported"),
        optionalInteger(value, "timeoutSeconds"),
        optionalString(value, "concurrency"),
        extensions(value));
  }

  private OperationOutput output(JsonObject value) {
    requireKeys(value, Set.of("schema"), Set.of("schema", "presentation", "extensions"));
    return new OperationOutput(
        object(value, "schema"), optionalObject(value, "presentation"), extensions(value));
  }

  private List<OperationPlacement> placements(JsonValue value) {
    if (!(value instanceof JsonList list)) throw invalid();
    var result = new ArrayList<OperationPlacement>();
    for (JsonValue item : list.values()) {
      if (!(item instanceof JsonObject placement)) throw invalid();
      String kind = string(placement, "kind");
      if ("global".equals(kind)) {
        requireKeys(placement, Set.of("kind"), Set.of("kind"));
        result.add(OperationPlacement.global());
      } else if ("subject".equals(kind)) {
        requireKeys(
            placement, Set.of("kind", "subjectType"), Set.of("kind", "subjectType", "bindings"));
        Map<String, String> bindings = new LinkedHashMap<>();
        if (placement.get("bindings") != null) {
          JsonObject bindingsObject = object(placement, "bindings");
          // The canonical wire form never carries an empty bindings object.
          if (bindingsObject.values().isEmpty())
            throw new IllegalArgumentException("placement bindings must be omitted when empty");
          for (var entry : bindingsObject.values().entrySet()) {
            if (!(entry.getValue().unwrap() instanceof String bindingKey)) throw invalid();
            bindings.put(entry.getKey(), bindingKey);
          }
        }
        result.add(OperationPlacement.subject(string(placement, "subjectType"), bindings));
      } else {
        throw invalid();
      }
    }
    return List.copyOf(result);
  }

  private ProtocolRequirements requirements(JsonObject value) {
    requireKeys(value, Set.of(), Set.of("profiles", "capabilities"));
    return new ProtocolRequirements(
        value.get("profiles") == null ? List.of() : strings(value, "profiles"),
        value.get("capabilities") == null ? List.of() : strings(value, "capabilities"));
  }

  private static JsonObject extensions(JsonObject value) {
    JsonObject extensions = optionalObject(value, "extensions");
    return extensions == null ? JsonOwnership.object(Map.of()) : extensions;
  }

  private static String string(JsonObject object, String key) {
    JsonValue value = object.get(key);
    if (value != null && value.unwrap() instanceof String string) return string;
    throw invalid();
  }

  private static String optionalString(JsonObject object, String key) {
    if (object.get(key) == null) return null;
    return string(object, key);
  }

  private static boolean bool(JsonObject object, String key) {
    JsonValue value = object.get(key);
    if (value != null && value.unwrap() instanceof Boolean bool) return bool;
    throw invalid();
  }

  private static Boolean optionalBoolean(JsonObject object, String key) {
    return object.get(key) == null ? null : bool(object, key);
  }

  private static int integer(JsonObject object, String key) {
    JsonValue value = object.get(key);
    if (value != null
        && value.unwrap() instanceof Long number
        && number >= Integer.MIN_VALUE
        && number <= Integer.MAX_VALUE) {
      return number.intValue();
    }
    throw invalid();
  }

  private static Integer optionalInteger(JsonObject object, String key) {
    return object.get(key) == null ? null : integer(object, key);
  }

  private static JsonObject object(JsonObject owner, String key) {
    JsonValue value = owner.get(key);
    if (value instanceof JsonObject object) return object;
    throw invalid();
  }

  private static JsonObject optionalObject(JsonObject owner, String key) {
    return owner.get(key) == null ? null : object(owner, key);
  }

  private static List<JsonObject> objects(JsonObject owner, String key) {
    JsonValue value = owner.get(key);
    if (!(value instanceof JsonList list)) throw invalid();
    var result = new ArrayList<JsonObject>();
    for (JsonValue item : list.values()) {
      if (!(item instanceof JsonObject object)) throw invalid();
      result.add(object);
    }
    return List.copyOf(result);
  }

  private static List<String> strings(JsonObject owner, String key) {
    JsonValue value = owner.get(key);
    if (!(value instanceof JsonList list)) throw invalid();
    var result = new ArrayList<String>();
    for (JsonValue item : list.values()) {
      if (!(item.unwrap() instanceof String string)) throw invalid();
      result.add(string);
    }
    return List.copyOf(result);
  }

  private static void requireKeys(JsonObject value, Set<String> required, Set<String> allowed) {
    if (!value.values().keySet().containsAll(required)
        || !allowed.containsAll(value.values().keySet())) {
      throw invalid();
    }
  }

  private static IllegalArgumentException invalid() {
    return new IllegalArgumentException("protocol resource has an invalid shape");
  }
}
