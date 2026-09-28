package dev.eightlines.gauntlet.core.schema;

import dev.eightlines.gauntlet.core.json.CanonicalJson;
import dev.eightlines.gauntlet.core.json.JsonList;
import dev.eightlines.gauntlet.core.json.JsonObject;
import dev.eightlines.gauntlet.core.json.JsonValue;
import dev.eightlines.gauntlet.core.model.AdapterManifest;
import dev.eightlines.gauntlet.core.model.DataSourceResolveRequest;
import dev.eightlines.gauntlet.core.model.DataSourceResolveResponse;
import dev.eightlines.gauntlet.core.model.EnvironmentDescriptor;
import dev.eightlines.gauntlet.core.model.OperationDefinition;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** The three shared cross-SDK semantic predicates. */
public final class ProtocolSemantics {
  private ProtocolSemantics() {}

  public static boolean manifestIsValid(AdapterManifest manifest) {
    return manifestMapIsValid(manifest.toProtocolMap());
  }

  public static boolean operationIsValid(OperationDefinition operation) {
    return operationMapIsValid(operation.toProtocolMap());
  }

  public static List<JsonValue.Scalar> operationSecretAtoms(
      OperationDefinition operation, JsonObject input) {
    return PresetSecretAnalyzer.collectOperationSecretAtoms(operation.toProtocolMap(), input);
  }

  public static List<InputLocation> operationInputLocations(
      OperationDefinition operation, JsonObject input, String schemaPointer) {
    return PresetSecretAnalyzer.resolveOperationInputLocations(
            operation.toProtocolMap(), input, schemaPointer)
        .stream()
        .map(location -> new InputLocation(location.instancePointer(), location.value()))
        .toList();
  }

  public record InputLocation(String instancePointer, JsonValue value) {}

  public static boolean resolveSemanticsAreValid(
      DataSourceResolveRequest request, DataSourceResolveResponse response) {
    if (request.values().size() != response.results().size()) return false;
    for (int index = 0; index < request.values().size(); index++) {
      var result = response.results().get(index);
      if (!request.values().get(index).equals(result.value())
          || (result.item() != null && !result.value().equals(result.item().value()))) return false;
    }
    return true;
  }

  public static boolean manifestMapIsValid(JsonObject manifest) {
    try {
      JsonObject application = object(manifest.get("application"));
      EnvironmentDescriptor.fromProtocolValue(application.get("environment"));
      if (!revisionMatches(manifest, "manifestRevision")) return false;
      List<JsonObject> features = objects(manifest.get("features"));
      List<JsonObject> operations = objects(manifest.get("operations"));
      List<JsonObject> sources = objects(manifest.get("dataSources"));
      if (!uniqueIds(features) || !uniqueIds(operations) || !uniqueIds(sources)) return false;

      Map<String, String> parents = new HashMap<>();
      for (JsonObject feature : features)
        parents.put(requiredString(feature, "id"), string(feature.get("parentId")));
      for (String feature : parents.keySet()) {
        var seen = new HashSet<String>();
        String cursor = feature;
        while (cursor != null) {
          if (!seen.add(cursor) || !parents.containsKey(cursor)) return false;
          cursor = parents.get(cursor);
        }
      }

      Set<String> featureIds = parents.keySet();
      Set<String> profiles = new HashSet<>(strings(manifest.get("profiles")));
      Set<String> capabilities = new HashSet<>(strings(manifest.get("capabilities")));
      for (JsonObject operation : operations) {
        if (!featureIds.contains(requiredString(operation, "featureId"))) return false;
        JsonObject availability = object(operation.get("availability"));
        if ("available".equals(requiredString(availability, "state"))
            && !requirementsSatisfied(
                objectOrNull(operation.get("requirements")), profiles, capabilities)) {
          return false;
        }
        if (operation.get("placements") != null && !profiles.contains(PlacementRules.PROFILE)) {
          return false;
        }
      }

      for (JsonObject source : sources) {
        JsonObject sourceCapabilities = object(source.get("capabilities"));
        long defaultLimit = number(sourceCapabilities.get("defaultLimit")).longValue();
        long maxLimit = number(sourceCapabilities.get("maxLimit")).longValue();
        if (defaultLimit > maxLimit) return false;
        if (source.get("dependencySchema") != null)
          TcSchemaCore.assertValid(object(source.get("dependencySchema")), true);
        if (source.get("contextSchema") != null)
          TcSchemaCore.assertValid(object(source.get("contextSchema")), true);
      }
      return true;
    } catch (RuntimeException exception) {
      return false;
    }
  }

  public static boolean operationMapIsValid(JsonObject operation) {
    try {
      JsonObject execution = object(operation.get("execution"));
      if ("destructive".equals(requiredString(execution, "impact"))
          && (!requiredBoolean(execution, "confirmationRequired")
              || !"required".equals(requiredString(execution, "idempotency")))) {
        return false;
      }
      if (!revisionMatches(operation, "revision")) return false;
      TcSchemaCore.assertValid(object(operation.get("inputSchema")), true);
      if (operation.get("contextSchema") != null)
        TcSchemaCore.assertValid(object(operation.get("contextSchema")), true);
      TcSchemaCore.assertValid(object(object(operation.get("output")).get("schema")), false);
      List<JsonObject> dataSources = objects(operation.get("dataSources"));
      List<JsonObject> presets = objects(operation.get("presets"));
      if (!uniqueIds(dataSources) || !uniqueIds(presets)) return false;
      if (!PresetSecretAnalyzer.operationPresetsOmitSecrets(operation)) return false;

      JsonValue placements = operation.get("placements");
      if (placements != null) {
        var guarded = new ArrayList<String>();
        JsonObject handling = objectOrNull(operation.get("inputHandling"));
        if (handling != null)
          for (JsonObject rule : objects(handling.get("rules")))
            guarded.add(requiredString(rule, "schemaPointer"));
        if (!(placements instanceof JsonList list)
            || !PlacementRules.areValid(object(operation.get("inputSchema")), guarded, list))
          return false;
      }

      Set<String> sourceIds = new HashSet<>();
      for (JsonObject source : dataSources) sourceIds.add(requiredString(source, "id"));
      JsonValue ui = operation.get("uiSchema");
      if (ui != null) {
        var pending = new ArrayDeque<JsonValue>();
        pending.push(ui);
        while (!pending.isEmpty()) {
          JsonValue current = pending.pop();
          if (current instanceof JsonObject currentObject) {
            String sourceId = string(currentObject.get("dataSourceId"));
            if (sourceId != null && !sourceIds.contains(sourceId)) return false;
            pending.addAll(currentObject.values().values());
          } else if (current instanceof JsonList list) pending.addAll(list.values());
        }
      }
      return true;
    } catch (RuntimeException exception) {
      return false;
    }
  }

  public static boolean resolveMapsAreValid(JsonObject request, JsonObject response) {
    try {
      List<String> values = strings(request.get("values"));
      List<JsonObject> results = objects(response.get("results"));
      if (values.size() != results.size()) return false;
      for (int index = 0; index < values.size(); index++) {
        JsonObject result = results.get(index);
        String value = requiredString(result, "value");
        if (!values.get(index).equals(value)) return false;
        JsonValue itemValue = result.get("item");
        if (!(itemValue instanceof JsonValue.Scalar scalar && scalar.value() == null)
            && !value.equals(requiredString(object(itemValue), "value"))) return false;
      }
      return true;
    } catch (RuntimeException exception) {
      return false;
    }
  }

  private static boolean revisionMatches(JsonObject value, String field) {
    return requiredString(value, field).equals(CanonicalJson.revision(value, field));
  }

  private static boolean requirementsSatisfied(
      JsonObject requirements, Set<String> profiles, Set<String> capabilities) {
    if (requirements == null) return true;
    return profiles.containsAll(stringsOrEmpty(requirements.get("profiles")))
        && capabilities.containsAll(stringsOrEmpty(requirements.get("capabilities")));
  }

  private static boolean uniqueIds(List<JsonObject> values) {
    var ids = new HashSet<String>();
    for (JsonObject value : values) if (!ids.add(requiredString(value, "id"))) return false;
    return true;
  }

  private static List<JsonObject> objects(JsonValue value) {
    if (!(value instanceof JsonList list)) throw new IllegalArgumentException("expected array");
    return list.values().stream().map(ProtocolSemantics::object).toList();
  }

  private static List<String> strings(JsonValue value) {
    if (!(value instanceof JsonList list))
      throw new IllegalArgumentException("expected string array");
    return list.values().stream().map(ProtocolSemantics::string).toList();
  }

  private static List<String> stringsOrEmpty(JsonValue value) {
    return value == null ? List.of() : strings(value);
  }

  private static JsonObject object(JsonValue value) {
    if (!(value instanceof JsonObject object))
      throw new IllegalArgumentException("expected object");
    return object;
  }

  private static JsonObject objectOrNull(JsonValue value) {
    return value == null ? null : object(value);
  }

  private static String requiredString(JsonObject value, String key) {
    String result = string(value.get(key));
    if (result == null) throw new IllegalArgumentException("missing " + key);
    return result;
  }

  private static String string(JsonValue value) {
    return value != null && value.unwrap() instanceof String string ? string : null;
  }

  private static Number number(JsonValue value) {
    if (value == null || !(value.unwrap() instanceof Number number))
      throw new IllegalArgumentException("expected number");
    return number;
  }

  private static boolean requiredBoolean(JsonObject value, String key) {
    JsonValue candidate = value.get(key);
    if (candidate == null || !(candidate.unwrap() instanceof Boolean result)) {
      throw new IllegalArgumentException("expected boolean");
    }
    return result;
  }
}
