package dev.eightlines.gauntlet.core.model;

import dev.eightlines.gauntlet.core.json.JsonObject;
import java.util.List;
import java.util.Objects;

public record DataSourcePage(List<DataSourceItem> items, String nextCursor, JsonObject extensions) {
  public DataSourcePage {
    items = List.copyOf(Objects.requireNonNull(items, "items"));
    extensions = ProtocolValidation.requireExtensions(extensions);
  }

  public JsonObject toProtocolMap() {
    return ProtocolMap.build(
        values -> {
          values.put("items", items.stream().map(DataSourceItem::toProtocolMap).toList());
          ProtocolMap.optional(values, "nextCursor", nextCursor);
          if (!extensions.values().isEmpty()) values.put("extensions", extensions);
        });
  }
}
