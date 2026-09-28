package dev.eightlines.gauntlet.core.json;

import dev.eightlines.gauntlet.core.json.internal.jcs.NumberToJSON;
import java.io.IOException;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.databind.json.JsonMapper;

/** Converts application values into immutable portable JSON without invoking arbitrary objects. */
public final class JsonOwnership {
  private static final long MAX_SAFE_INTEGER = 9_007_199_254_740_991L;

  private JsonOwnership() {}

  public static JsonValue ownRuntime(Object value) {
    return own(value, false);
  }

  public static JsonValue ownRevision(Object value) {
    return own(value, true);
  }

  public static JsonObject object(Map<String, ?> value) {
    JsonValue owned = ownRuntime(value);
    if (owned instanceof JsonObject object) return object;
    throw new IllegalArgumentException("JSON root must be an object");
  }

  public static JsonObject revisionObject(Map<String, ?> value) {
    JsonValue owned = ownRevision(value);
    if (owned instanceof JsonObject object) return object;
    throw new IllegalArgumentException("JSON root must be an object");
  }

  /** Parses a complete UTF-8 JSON value with duplicate-name detection enabled. */
  public static JsonValue parseRuntime(byte[] utf8) {
    return parse(utf8, false);
  }

  /** Parses revision material, accepting and normalizing negative zero. */
  public static JsonValue parseRevision(byte[] utf8) {
    return parse(utf8, true);
  }

  public static Object toJava(JsonValue root) {
    IdentityHashMap<JsonValue, Object> completed = new IdentityHashMap<>();
    ArrayDeque<MaterializeJavaFrame> work = new ArrayDeque<>();
    work.push(new MaterializeJavaFrame(root, false));
    while (!work.isEmpty()) {
      var frame = work.pop();
      if (completed.containsKey(frame.value)) continue;
      if (frame.value instanceof JsonValue.Scalar scalar) {
        completed.put(frame.value, scalar.value());
        continue;
      }
      if (!frame.visited) {
        work.push(new MaterializeJavaFrame(frame.value, true));
        if (frame.value instanceof JsonObject object) {
          for (JsonValue child : object.values().values()) {
            work.push(new MaterializeJavaFrame(child, false));
          }
        } else {
          for (JsonValue child : ((JsonList) frame.value).values()) {
            work.push(new MaterializeJavaFrame(child, false));
          }
        }
        continue;
      }
      if (frame.value instanceof JsonObject object) {
        var copy = new LinkedHashMap<String, Object>();
        object.values().forEach((key, child) -> copy.put(key, completed.get(child)));
        completed.put(frame.value, java.util.Collections.unmodifiableMap(copy));
      } else {
        var copy = new ArrayList<Object>();
        for (JsonValue child : ((JsonList) frame.value).values()) copy.add(completed.get(child));
        completed.put(frame.value, java.util.Collections.unmodifiableList(copy));
      }
    }
    return completed.get(root);
  }

  private static JsonValue parse(byte[] utf8, boolean revision) {
    try {
      if (!revision && containsNegativeZeroNumber(utf8)) {
        throw new IllegalArgumentException("negative zero is not a runtime value");
      }
      var mapper =
          JsonMapper.builder().enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build();
      Object decoded = mapper.readValue(utf8, Object.class);
      return own(decoded, revision);
    } catch (RuntimeException exception) {
      throw new IllegalArgumentException("invalid JSON");
    }
  }

  private static JsonValue own(Object input, boolean allowNegativeZero) {
    Holder root = new Holder();
    ArrayDeque<Frame> frames = new ArrayDeque<>();
    frames.push(new Frame(input, value -> root.value = value));
    IdentityHashMap<Object, Boolean> active = new IdentityHashMap<>();
    while (!frames.isEmpty()) {
      Frame frame = frames.pop();
      if (frame.deactivate != null) {
        active.remove(frame.deactivate);
        continue;
      }
      Object value = frame.input;
      if (value instanceof JsonValue owned) {
        frame.accept.accept(owned);
        continue;
      }
      if (value instanceof Map<?, ?> map) {
        if (active.put(map, Boolean.TRUE) != null) throw new IllegalArgumentException("JSON cycle");
        Map<String, JsonValue> target = new LinkedHashMap<>();
        frame.accept.accept(new DeferredObject(target));
        List<Map.Entry<?, ?>> entries = new ArrayList<>(map.entrySet());
        frames.push(new Frame(null, null, map));
        for (int i = entries.size() - 1; i >= 0; i--) {
          Map.Entry<?, ?> entry = entries.get(i);
          if (!(entry.getKey() instanceof String key))
            throw new IllegalArgumentException("JSON object keys must be strings");
          validateString(key);
          frames.push(new Frame(entry.getValue(), child -> target.put(key, child)));
        }
        continue;
      }
      if (value instanceof List<?> listInput) {
        if (active.put(listInput, Boolean.TRUE) != null)
          throw new IllegalArgumentException("JSON cycle");
        List<?> elements = new ArrayList<>(listInput);
        List<JsonValue> target = new ArrayList<>();
        frame.accept.accept(new DeferredList(target));
        frames.push(new Frame(null, null, listInput));
        for (int i = elements.size() - 1; i >= 0; i--) {
          final int index = i;
          frames.push(
              new Frame(
                  elements.get(i),
                  child -> {
                    while (target.size() <= index) target.add(null);
                    target.set(index, child);
                  }));
        }
        continue;
      }
      frame.accept.accept(scalar(value, allowNegativeZero));
    }
    return materialize(root.value);
  }

  private static JsonValue materialize(JsonValue root) {
    IdentityHashMap<JsonValue, JsonValue> completed = new IdentityHashMap<>();
    ArrayDeque<MaterializeFrame> work = new ArrayDeque<>();
    work.push(new MaterializeFrame(root, false));
    while (!work.isEmpty()) {
      MaterializeFrame frame = work.pop();
      JsonValue value = frame.value;
      if (completed.containsKey(value)) continue;
      if (!(value instanceof DeferredObject) && !(value instanceof DeferredList)) {
        completed.put(value, value);
        continue;
      }
      if (!frame.visited) {
        work.push(new MaterializeFrame(value, true));
        if (value instanceof DeferredObject object)
          for (JsonValue child : object.values.values())
            work.push(new MaterializeFrame(child, false));
        if (value instanceof DeferredList list)
          for (JsonValue child : list.values) work.push(new MaterializeFrame(child, false));
        continue;
      }
      if (value instanceof DeferredObject object) {
        Map<String, JsonValue> copy = new LinkedHashMap<>();
        for (var entry : object.values.entrySet())
          copy.put(entry.getKey(), completed.get(entry.getValue()));
        completed.put(value, new JsonObject(copy));
      } else {
        DeferredList list = (DeferredList) value;
        List<JsonValue> copy = new ArrayList<>();
        for (JsonValue child : list.values) copy.add(completed.get(child));
        completed.put(value, new JsonList(copy));
      }
    }
    return completed.get(root);
  }

  private static JsonValue scalar(Object value, boolean allowNegativeZero) {
    if (value == null || value instanceof Boolean) return new JsonValue.Scalar(value);
    if (value instanceof String string) {
      validateString(string);
      return new JsonValue.Scalar(string);
    }
    if (value instanceof Byte
        || value instanceof Short
        || value instanceof Integer
        || value instanceof Long) {
      long number = ((Number) value).longValue();
      if (number < -MAX_SAFE_INTEGER || number > MAX_SAFE_INTEGER) {
        throw new IllegalArgumentException("unsafe JSON integer");
      }
      return new JsonValue.Scalar(number);
    }
    if (value instanceof BigInteger integer) {
      if (integer.abs().compareTo(BigInteger.valueOf(MAX_SAFE_INTEGER)) > 0)
        throw new IllegalArgumentException("unsafe JSON integer");
      return new JsonValue.Scalar(integer.longValueExact());
    }
    if (value instanceof Float)
      throw new IllegalArgumentException("Float is not a portable JSON number");
    if (value instanceof Double number) {
      if (!Double.isFinite(number)) throw new IllegalArgumentException("non-finite JSON number");
      if (!allowNegativeZero && Double.doubleToRawLongBits(number) == Long.MIN_VALUE)
        throw new IllegalArgumentException("negative zero is not a runtime value");
      if (number == 0d) return new JsonValue.Scalar(0d);
      try {
        String serialized = NumberToJSON.serializeNumber(number);
        if (number == Math.rint(number)
            && !serialized.contains("e")
            && Math.abs(number) > MAX_SAFE_INTEGER)
          throw new IllegalArgumentException("unsafe JSON integer");
      } catch (IOException exception) {
        throw new IllegalArgumentException("invalid JSON number");
      }
      return new JsonValue.Scalar(number);
    }
    if (value instanceof BigDecimal decimal) {
      double number = decimal.doubleValue();
      if (!Double.isFinite(number)) throw new IllegalArgumentException("non-finite JSON number");
      try {
        if (new BigDecimal(NumberToJSON.serializeNumber(number)).compareTo(decimal) != 0)
          throw new IllegalArgumentException("precision-losing BigDecimal");
      } catch (IOException exception) {
        throw new IllegalArgumentException("invalid JSON number");
      }
      return scalar(number, allowNegativeZero);
    }
    throw new IllegalArgumentException("unsupported JSON value: " + value.getClass().getName());
  }

  static void validateString(String value) {
    for (int i = 0; i < value.length(); i++) {
      char c = value.charAt(i);
      if (Character.isHighSurrogate(c)) {
        if (++i == value.length() || !Character.isLowSurrogate(value.charAt(i)))
          throw new IllegalArgumentException("lone surrogate");
      } else if (Character.isLowSurrogate(c)) throw new IllegalArgumentException("lone surrogate");
    }
  }

  private static boolean containsNegativeZeroNumber(byte[] utf8) {
    boolean inString = false;
    boolean escaped = false;
    for (int index = 0; index < utf8.length; index++) {
      int current = utf8[index] & 0xff;
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (current == '\\') {
          escaped = true;
        } else if (current == '"') {
          inString = false;
        }
        continue;
      }
      if (current == '"') {
        inString = true;
        continue;
      }
      if (current != '-' || index + 1 >= utf8.length || utf8[index + 1] != '0') {
        continue;
      }

      int cursor = index + 2;
      boolean nonZeroMantissa = false;
      if (cursor < utf8.length && utf8[cursor] == '.') {
        cursor++;
        while (cursor < utf8.length && isDigit(utf8[cursor])) {
          nonZeroMantissa |= utf8[cursor] != '0';
          cursor++;
        }
      }
      if (!nonZeroMantissa
          && (cursor >= utf8.length
              || utf8[cursor] == 'e'
              || utf8[cursor] == 'E'
              || isNumberDelimiter(utf8[cursor]))) {
        return true;
      }
    }
    return false;
  }

  private static boolean isDigit(byte value) {
    return value >= '0' && value <= '9';
  }

  private static boolean isNumberDelimiter(byte value) {
    return value == ','
        || value == ']'
        || value == '}'
        || value == ' '
        || value == '\t'
        || value == '\r'
        || value == '\n';
  }

  private interface Sink {
    void accept(JsonValue value);
  }

  private record Frame(Object input, Sink accept, Object deactivate) {
    private Frame(Object input, Sink accept) {
      this(input, accept, null);
    }
  }

  private record MaterializeFrame(JsonValue value, boolean visited) {}

  private record MaterializeJavaFrame(JsonValue value, boolean visited) {}

  private static final class Holder {
    JsonValue value;
  }

  static final class DeferredObject implements JsonValue {
    private final Map<String, JsonValue> values;

    DeferredObject(Map<String, JsonValue> values) {
      this.values = values;
    }

    @Override
    public Object unwrap() {
      return values;
    }
  }

  static final class DeferredList implements JsonValue {
    private final List<JsonValue> values;

    DeferredList(List<JsonValue> values) {
      this.values = values;
    }

    @Override
    public Object unwrap() {
      return values;
    }
  }
}
