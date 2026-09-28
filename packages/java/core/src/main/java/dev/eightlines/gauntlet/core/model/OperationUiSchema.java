package dev.eightlines.gauntlet.core.model;

import dev.eightlines.gauntlet.core.json.JsonList;
import dev.eightlines.gauntlet.core.json.JsonObject;
import dev.eightlines.gauntlet.core.json.JsonValue;
import java.util.ArrayDeque;
import java.util.Objects;
import java.util.Set;
import java.util.regex.Pattern;

/** Validated {@code tc-rich-forms@1} UI tree. */
public record OperationUiSchema(String profile, JsonObject root, JsonObject extensions) {
  private static final Set<String> BUILT_IN_WIDGETS =
      Set.of(
          "text",
          "textarea",
          "integer",
          "number",
          "toggle",
          "select",
          "multi-select",
          "autocomplete",
          "date",
          "date-time",
          "duration",
          "code",
          "json",
          "secret",
          "file");
  private static final Pattern CUSTOM_WIDGET =
      Pattern.compile("^urn:[A-Za-z0-9][A-Za-z0-9:._/-]*$");

  public OperationUiSchema {
    if (!"tc-rich-forms@1".equals(profile)) {
      throw new IllegalArgumentException("unsupported UI profile");
    }
    root = Objects.requireNonNull(root, "root");
    validateTree(root);
    extensions = ProtocolValidation.requireExtensions(extensions);
  }

  public JsonObject toProtocolMap() {
    return ProtocolMap.build(
        values -> {
          values.put("profile", profile);
          values.put("root", root);
          if (!extensions.values().isEmpty()) {
            values.put("extensions", extensions);
          }
        });
  }

  private static void validateTree(JsonObject root) {
    ArrayDeque<JsonObject> nodes = new ArrayDeque<>();
    ArrayDeque<JsonObject> conditions = new ArrayDeque<>();
    nodes.push(root);
    while (!nodes.isEmpty()) {
      JsonObject node = nodes.pop();
      String type = requireString(node, "type");
      switch (type) {
        case "field" -> validateField(node, conditions);
        case "group", "columns" -> validateContainer(node, nodes, conditions);
        case "tabs" -> validateTabs(node, nodes);
        default -> throw new IllegalArgumentException("unsupported UI node type");
      }
    }
    while (!conditions.isEmpty()) {
      validateCondition(conditions.pop(), conditions);
    }
  }

  private static void validateField(JsonObject node, ArrayDeque<JsonObject> conditions) {
    requireAllowed(
        node,
        Set.of(
            "type",
            "pointer",
            "widget",
            "dataSourceId",
            "label",
            "help",
            "options",
            "visibleWhen",
            "enabledWhen"));
    DataSourceReference.validatePointer(requireString(node, "pointer"));
    String widget = optionalString(node, "widget");
    if (node.get("widget") != null
        && (widget == null
            || !BUILT_IN_WIDGETS.contains(widget) && !CUSTOM_WIDGET.matcher(widget).matches())) {
      throw new IllegalArgumentException("unsupported UI widget");
    }
    String dataSourceId = optionalString(node, "dataSourceId");
    if (node.get("dataSourceId") != null) {
      ProtocolId.require(dataSourceId);
    }
    requireOptionalString(node, "label");
    requireOptionalString(node, "help");
    if (node.get("options") != null && !(node.get("options") instanceof JsonObject)) {
      throw new IllegalArgumentException("UI field options must be an object");
    }
    addOptionalCondition(node, "visibleWhen", conditions);
    addOptionalCondition(node, "enabledWhen", conditions);
  }

  private static void validateContainer(
      JsonObject node, ArrayDeque<JsonObject> nodes, ArrayDeque<JsonObject> conditions) {
    requireAllowed(node, Set.of("type", "label", "children", "visibleWhen"));
    requireOptionalString(node, "label");
    pushObjects(requireList(node, "children"), nodes, "UI child");
    addOptionalCondition(node, "visibleWhen", conditions);
  }

  private static void validateTabs(JsonObject node, ArrayDeque<JsonObject> nodes) {
    requireAllowed(node, Set.of("type", "tabs"));
    JsonList tabs = requireList(node, "tabs");
    for (JsonValue value : tabs.values()) {
      JsonObject tab = requireObject(value, "UI tab");
      requireAllowed(tab, Set.of("id", "label", "children"));
      ProtocolId.require(requireString(tab, "id"));
      requireString(tab, "label");
      pushObjects(requireList(tab, "children"), nodes, "UI child");
    }
  }

  private static void validateCondition(JsonObject condition, ArrayDeque<JsonObject> conditions) {
    String operation = requireString(condition, "op");
    switch (operation) {
      case "present" -> {
        requireAllowed(condition, Set.of("op", "pointer"));
        DataSourceReference.validatePointer(requireString(condition, "pointer"));
      }
      case "equals" -> {
        requireAllowed(condition, Set.of("op", "pointer", "value"));
        DataSourceReference.validatePointer(requireString(condition, "pointer"));
        requirePresent(condition, "value");
      }
      case "in" -> {
        requireAllowed(condition, Set.of("op", "pointer", "values"));
        DataSourceReference.validatePointer(requireString(condition, "pointer"));
        requireList(condition, "values");
      }
      case "all", "any" -> {
        requireAllowed(condition, Set.of("op", "conditions"));
        JsonList nested = requireList(condition, "conditions");
        if (nested.values().isEmpty()) {
          throw new IllegalArgumentException("UI condition list must not be empty");
        }
        pushObjects(nested, conditions, "UI condition");
      }
      case "not" -> {
        requireAllowed(condition, Set.of("op", "condition"));
        conditions.push(requireObject(condition.get("condition"), "UI condition"));
      }
      default -> throw new IllegalArgumentException("unsupported UI condition");
    }
  }

  private static void addOptionalCondition(
      JsonObject object, String key, ArrayDeque<JsonObject> conditions) {
    JsonValue value = object.get(key);
    if (value != null) {
      conditions.push(requireObject(value, "UI condition"));
    }
  }

  private static void pushObjects(JsonList values, ArrayDeque<JsonObject> target, String name) {
    for (JsonValue value : values.values()) {
      target.push(requireObject(value, name));
    }
  }

  private static void requireAllowed(JsonObject object, Set<String> allowed) {
    if (!allowed.containsAll(object.values().keySet())) {
      throw new IllegalArgumentException("UI object contains an unknown member");
    }
  }

  private static void requirePresent(JsonObject object, String key) {
    if (!object.values().containsKey(key)) {
      throw new IllegalArgumentException("UI object is missing " + key);
    }
  }

  private static String requireString(JsonObject object, String key) {
    String value = optionalString(object, key);
    if (value == null) {
      throw new IllegalArgumentException("UI " + key + " must be a string");
    }
    return value;
  }

  private static void requireOptionalString(JsonObject object, String key) {
    if (object.get(key) != null && optionalString(object, key) == null) {
      throw new IllegalArgumentException("UI " + key + " must be a string");
    }
  }

  private static String optionalString(JsonObject object, String key) {
    JsonValue value = object.get(key);
    return value != null && value.unwrap() instanceof String string ? string : null;
  }

  private static JsonList requireList(JsonObject object, String key) {
    JsonValue value = object.get(key);
    if (!(value instanceof JsonList list)) {
      throw new IllegalArgumentException("UI " + key + " must be an array");
    }
    return list;
  }

  private static JsonObject requireObject(JsonValue value, String name) {
    if (!(value instanceof JsonObject object)) {
      throw new IllegalArgumentException(name + " must be an object");
    }
    return object;
  }
}
