package dev.eightlines.gauntlet.example;

import dev.eightlines.gauntlet.core.json.JsonOwnership;
import dev.eightlines.gauntlet.core.model.DataSourceItem;
import dev.eightlines.gauntlet.core.model.DataSourcePage;
import dev.eightlines.gauntlet.core.model.DataSourceQuery;
import dev.eightlines.gauntlet.core.model.DataSourceResolveRequest;
import dev.eightlines.gauntlet.core.model.DataSourceResolveResponse;
import dev.eightlines.gauntlet.spring.annotation.GauntletDataSource;
import dev.eightlines.gauntlet.spring.spi.TypedDataSource;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

@Component
@GauntletDataSource(
    id = "pending-applications",
    label = "Pending applications",
    definitionResource = "gauntlet/pending-applications.json")
public final class PendingApplicationsDataSource implements TypedDataSource {
  private static final List<DataSourceItem> ITEMS =
      List.of(
          item("11111111-1111-4111-8111-111111111111", "Alice Brown"),
          item("22222222-2222-4222-8222-222222222222", "Bob Brown"),
          item("33333333-3333-4333-8333-333333333333", "Carla Green"));

  @Override
  public DataSourcePage query(DataSourceQuery request) {
    List<DataSourceItem> matches =
        ITEMS.stream()
            .filter(
                item ->
                    request.search() == null
                        || item.label()
                            .toLowerCase(java.util.Locale.ROOT)
                            .contains(request.search().toLowerCase(java.util.Locale.ROOT)))
            .toList();
    int start = cursorOffset(request.cursor(), matches.size());
    int limit = request.limit() == null ? 2 : request.limit();
    int end = Math.min(start + limit, matches.size());
    String nextCursor = end < matches.size() ? "offset-" + end : null;
    return new DataSourcePage(matches.subList(start, end), nextCursor, empty());
  }

  @Override
  public DataSourceResolveResponse resolve(DataSourceResolveRequest request) {
    List<DataSourceResolveResponse.Result> results =
        request.values().stream()
            .map(
                value ->
                    new DataSourceResolveResponse.Result(
                        value,
                        ITEMS.stream()
                            .filter(item -> item.value().equals(value))
                            .findFirst()
                            .orElse(null)))
            .toList();
    return DataSourceResolveResponse.forRequest(request, results, empty());
  }

  private static int cursorOffset(String cursor, int size) {
    if (cursor == null) return 0;
    if (!cursor.matches("^offset-[1-9][0-9]*$")) return size;
    try {
      return Math.min(Integer.parseInt(cursor.substring("offset-".length())), size);
    } catch (NumberFormatException exception) {
      return size;
    }
  }

  private static DataSourceItem item(String value, String label) {
    return new DataSourceItem(value, label, null, "Pending", false, empty(), empty());
  }

  private static dev.eightlines.gauntlet.core.json.JsonObject empty() {
    return JsonOwnership.object(Map.of());
  }
}
