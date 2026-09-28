package dev.eightlines.gauntlet.core.model;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

public record OperationPlacement(String kind, String subjectType, Map<String, String> bindings) {
  public OperationPlacement {
    var copy = new LinkedHashMap<String, String>();
    if (bindings != null) {
      for (var entry : bindings.entrySet()) {
        if (entry.getKey() == null || entry.getValue() == null)
          throw new IllegalArgumentException("placement bindings must not contain nulls");
        copy.put(entry.getKey(), entry.getValue());
      }
    }
    if ("global".equals(kind)) {
      if (subjectType != null || !copy.isEmpty())
        throw new IllegalArgumentException("global placement has no subject type or bindings");
    } else if ("subject".equals(kind)) {
      ProtocolId.require(subjectType);
      copy.values().forEach(ProtocolId::require);
    } else {
      throw new IllegalArgumentException("placement kind must be global or subject");
    }
    // Insertion-ordered so emitted definition JSON is stable across JVM runs.
    bindings = Collections.unmodifiableMap(copy);
  }

  public static OperationPlacement global() {
    return new OperationPlacement("global", null, Map.of());
  }

  public static OperationPlacement subject(String subjectType, Map<String, String> bindings) {
    return new OperationPlacement("subject", subjectType, bindings);
  }

  public Map<String, Object> toProtocolMap() {
    if ("global".equals(kind)) return Map.of("kind", "global");
    var values = new LinkedHashMap<String, Object>();
    values.put("kind", "subject");
    values.put("subjectType", subjectType);
    if (!bindings.isEmpty()) values.put("bindings", bindings);
    return values;
  }
}
