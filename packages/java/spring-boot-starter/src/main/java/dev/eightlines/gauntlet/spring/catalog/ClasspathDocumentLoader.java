package dev.eightlines.gauntlet.spring.catalog;

import dev.eightlines.gauntlet.core.json.JsonList;
import dev.eightlines.gauntlet.core.json.JsonObject;
import dev.eightlines.gauntlet.core.json.JsonOwnership;
import dev.eightlines.gauntlet.core.json.JsonValue;
import java.io.IOException;
import java.io.InputStream;
import java.util.Objects;

/** Strict classpath-only JSON resource loader with optional local JSON Pointer fragments. */
final class ClasspathDocumentLoader {
  private static final int MAX_BYTES = 1024 * 1024;

  JsonObject load(Class<?> owner, String resource) {
    Objects.requireNonNull(owner, "owner");
    ResourceTarget target = parse(resource);
    ClassLoader loader = owner.getClassLoader();
    try (InputStream input = loader.getResourceAsStream(target.path())) {
      if (input == null) throw invalid();
      byte[] bytes = input.readNBytes(MAX_BYTES + 1);
      if (bytes.length == 0 || bytes.length > MAX_BYTES || input.read() != -1) throw invalid();
      JsonValue root = JsonOwnership.parseRuntime(bytes);
      JsonValue selected = resolve(root, target.fragment());
      if (selected instanceof JsonObject object) return object;
      throw invalid();
    } catch (IOException | RuntimeException exception) {
      throw new IllegalArgumentException("classpath JSON resource is invalid or unreadable");
    }
  }

  private static ResourceTarget parse(String value) {
    if (value == null || value.isEmpty() || value.length() > 512) throw invalid();
    int hash = value.indexOf('#');
    if (hash != value.lastIndexOf('#')) throw invalid();
    String path = hash < 0 ? value : value.substring(0, hash);
    String fragment = hash < 0 ? "" : value.substring(hash + 1);
    if (path.isEmpty()
        || path.startsWith("/")
        || path.contains(":")
        || path.contains("\\")
        || path.contains("//")
        || path.contains("?")
        || path.equals("..")
        || path.startsWith("../")
        || path.endsWith("/..")
        || path.contains("/../")
        || (!fragment.isEmpty() && !fragment.startsWith("/"))) {
      throw invalid();
    }
    return new ResourceTarget(path, fragment);
  }

  private static JsonValue resolve(JsonValue root, String pointer) {
    if (pointer.isEmpty()) return root;
    JsonValue current = root;
    for (String encoded : pointer.substring(1).split("/", -1)) {
      String token = decode(encoded);
      if (current instanceof JsonObject object) {
        current = object.get(token);
      } else if (current instanceof JsonList list && token.matches("0|[1-9][0-9]*")) {
        try {
          int index = Integer.parseInt(token);
          current = index < list.values().size() ? list.values().get(index) : null;
        } catch (NumberFormatException exception) {
          throw invalid();
        }
      } else {
        throw invalid();
      }
      if (current == null) throw invalid();
    }
    return current;
  }

  private static String decode(String token) {
    StringBuilder value = new StringBuilder(token.length());
    for (int index = 0; index < token.length(); index++) {
      char character = token.charAt(index);
      if (character != '~') {
        value.append(character);
        continue;
      }
      if (index + 1 >= token.length()) throw invalid();
      char escaped = token.charAt(++index);
      if (escaped == '0') value.append('~');
      else if (escaped == '1') value.append('/');
      else throw invalid();
    }
    return value.toString();
  }

  private static IllegalArgumentException invalid() {
    return new IllegalArgumentException("invalid classpath resource");
  }

  private record ResourceTarget(String path, String fragment) {}
}
