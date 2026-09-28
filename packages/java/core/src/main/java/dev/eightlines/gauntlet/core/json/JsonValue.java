package dev.eightlines.gauntlet.core.json;

import dev.eightlines.gauntlet.core.json.internal.jcs.NumberToJSON;
import java.io.IOException;

/** Closed, deeply-owned JSON value. */
public sealed interface JsonValue
    permits JsonValue.Scalar,
        JsonObject,
        JsonList,
        JsonOwnership.DeferredObject,
        JsonOwnership.DeferredList {
  long MAX_SAFE_INTEGER = 9_007_199_254_740_991L;

  Object unwrap();

  record Scalar(Object value) implements JsonValue {
    public Scalar {
      if (value != null
          && !(value instanceof String)
          && !(value instanceof Boolean)
          && !(value instanceof Long)
          && !(value instanceof Double)) {
        throw new IllegalArgumentException("unsupported owned JSON scalar");
      }
      if (value instanceof String string) JsonOwnership.validateString(string);
      if (value instanceof Double number && !Double.isFinite(number)) {
        throw new IllegalArgumentException("non-finite JSON number");
      }
      if (value instanceof Long number
          && (number < -MAX_SAFE_INTEGER || number > MAX_SAFE_INTEGER)) {
        throw new IllegalArgumentException("unsafe JSON integer");
      }
      if (value instanceof Double number) {
        if (Double.doubleToRawLongBits(number) == Long.MIN_VALUE) {
          throw new IllegalArgumentException("negative zero is not an owned JSON value");
        }
        try {
          String serialized = NumberToJSON.serializeNumber(number);
          if (number == Math.rint(number)
              && !serialized.contains("e")
              && Math.abs(number) > MAX_SAFE_INTEGER) {
            throw new IllegalArgumentException("unsafe JSON integer");
          }
        } catch (IOException exception) {
          throw new IllegalArgumentException("invalid binary64 JSON number");
        }
      }
    }

    @Override
    public Object unwrap() {
      return value;
    }
  }
}
