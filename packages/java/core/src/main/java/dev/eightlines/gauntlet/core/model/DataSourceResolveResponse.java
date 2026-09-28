package dev.eightlines.gauntlet.core.model;

import dev.eightlines.gauntlet.core.json.JsonObject;
import java.util.List;
import java.util.Objects;

public record DataSourceResolveResponse(List<Result> results, JsonObject extensions) {
  public DataSourceResolveResponse {
    results = List.copyOf(Objects.requireNonNull(results, "results"));
    extensions = ProtocolValidation.requireExtensions(extensions);
  }

  public static DataSourceResolveResponse forRequest(
      DataSourceResolveRequest request, List<Result> results, JsonObject extensions) {
    var response = new DataSourceResolveResponse(results, extensions);
    if (request.values().size() != response.results.size()) {
      throw new IllegalArgumentException("resolve response length differs from request");
    }
    for (int index = 0; index < request.values().size(); index++) {
      if (!request.values().get(index).equals(response.results.get(index).value())) {
        throw new IllegalArgumentException("resolve response does not preserve value order");
      }
    }
    return response;
  }

  public JsonObject toProtocolMap() {
    return ProtocolMap.build(
        values -> {
          values.put("results", results.stream().map(Result::toProtocolMap).toList());
          if (!extensions.values().isEmpty()) values.put("extensions", extensions);
        });
  }

  public record Result(String value, DataSourceItem item) {
    public Result {
      value = Objects.requireNonNull(value, "value");
      if (item != null && !value.equals(item.value())) {
        throw new IllegalArgumentException("resolved item must echo its value");
      }
    }

    JsonObject toProtocolMap() {
      return ProtocolMap.build(
          values -> {
            values.put("value", value);
            values.put("item", item == null ? null : item.toProtocolMap());
          });
    }
  }
}
