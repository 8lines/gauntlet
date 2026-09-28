package dev.eightlines.gauntlet.core.json;

import dev.eightlines.gauntlet.core.json.internal.jcs.NumberToJSON;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/** RFC 8785 structural serializer. Decimal selection is delegated to the pinned reference port. */
public final class Rfc8785Canonicalizer {
  private static final char[] HEX = "0123456789abcdef".toCharArray();

  public byte[] canonicalize(JsonValue value) {
    StringBuilder output = new StringBuilder();
    ArrayDeque<Object> work = new ArrayDeque<>();
    work.push(value);
    while (!work.isEmpty()) {
      Object part = work.pop();
      if (part instanceof String literal) {
        output.append(literal);
        continue;
      }
      if (part instanceof JsonObject object) {
        List<String> keys = new ArrayList<>(object.values().keySet());
        keys.sort(Comparator.naturalOrder());
        work.push("}");
        for (int i = keys.size() - 1; i >= 0; i--) {
          String key = keys.get(i);
          if (i < keys.size() - 1) work.push(",");
          work.push(object.values().get(key));
          work.push(":");
          work.push(quote(key));
        }
        work.push("{");
        continue;
      }
      if (part instanceof JsonList list) {
        work.push("]");
        for (int i = list.values().size() - 1; i >= 0; i--) {
          if (i < list.values().size() - 1) work.push(",");
          work.push(list.values().get(i));
        }
        work.push("[");
        continue;
      }
      Object scalar = ((JsonValue.Scalar) part).value();
      if (scalar == null) output.append("null");
      else if (scalar instanceof String string) output.append(quote(string));
      else if (scalar instanceof Boolean bool) output.append(bool);
      else if (scalar instanceof Long number) output.append(number);
      else
        try {
          output.append(NumberToJSON.serializeNumber((Double) scalar));
        } catch (IOException exception) {
          throw new IllegalArgumentException("invalid binary64 JSON number");
        }
    }
    return output.toString().getBytes(StandardCharsets.UTF_8);
  }

  private static String quote(String value) {
    StringBuilder out = new StringBuilder("\"");
    for (int i = 0; i < value.length(); i++) {
      char c = value.charAt(i);
      switch (c) {
        case '"' -> out.append("\\\"");
        case '\\' -> out.append("\\\\");
        case '\b' -> out.append("\\b");
        case '\t' -> out.append("\\t");
        case '\n' -> out.append("\\n");
        case '\f' -> out.append("\\f");
        case '\r' -> out.append("\\r");
        default -> {
          if (c <= 0x1f) {
            out.append("\\u00").append(HEX[c >>> 4]).append(HEX[c & 0x0f]);
          } else {
            out.append(c);
          }
        }
      }
    }
    return out.append('"').toString();
  }
}
