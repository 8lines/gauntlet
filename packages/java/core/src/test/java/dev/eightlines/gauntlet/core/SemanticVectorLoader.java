package dev.eightlines.gauntlet.core;

import com.networknt.schema.InputFormat;
import com.networknt.schema.SchemaRegistry;
import com.networknt.schema.SchemaRegistryConfig;
import com.networknt.schema.dialect.Dialects;
import dev.eightlines.gauntlet.core.json.CanonicalJson;
import dev.eightlines.gauntlet.core.json.JsonList;
import dev.eightlines.gauntlet.core.json.JsonObject;
import dev.eightlines.gauntlet.core.json.JsonOwnership;
import dev.eightlines.gauntlet.core.json.JsonValue;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import tools.jackson.databind.ObjectMapper;

/** Strict local loader and materializer for {@code tc-adapter-semantic-vectors@1}. */
final class SemanticVectorLoader {
  private static final String ARTIFACT_NAME = "adapter-semantic-vectors.json";
  private static final String SCHEMA_NAME = "adapter-semantic-vectors.schema.json";
  private static final int DEFINITION_LIMIT = 256 * 1024;
  private static final int SOURCE_LIMIT = 4 * 1024 * 1024;
  private static final Pattern SAFE_ID = Pattern.compile("[a-z0-9]+(?:[.-][a-z0-9]+)*");
  private static final Pattern SAFE_SIBLING =
      Pattern.compile("(?!.*(?:\\.\\.|[\\\\/?:#]))[A-Za-z0-9][A-Za-z0-9._-]*\\.json");
  private static final Pattern CANONICAL_INDEX = Pattern.compile("(?:0|[1-9][0-9]*)");
  private static final Set<String> WORKLOAD_KINDS =
      Set.of("deep-chain", "rules-presets-cartesian", "dense-mutual-reference", "wide-array");
  private static final ObjectMapper MAPPER = new ObjectMapper();

  private SemanticVectorLoader() {}

  static Loaded load() {
    Path directory = fixtureDirectory();
    byte[] schemaBytes = readBoundBytes(directory, SCHEMA_NAME, DEFINITION_LIMIT, "schema");
    JsonObject schema = parseObject(schemaBytes, "schema");
    assertOnlyLocalDefinitionReferences(schema);

    byte[] artifactBytes = readBoundBytes(directory, ARTIFACT_NAME, DEFINITION_LIMIT, "artifact");
    for (byte value : artifactBytes) {
      if ((value & 0xff) > 0x7f) {
        throw invalid("artifact");
      }
    }
    JsonObject artifact = parseObject(artifactBytes, "artifact");
    validateArtifactAgainstCompanion(schema, artifact);

    Map<String, JsonObject> sources = new LinkedHashMap<>();
    for (JsonObject fixture : objects(artifact.get("sourceFixtures"))) {
      String id = requiredString(fixture, "id");
      String file = requiredString(fixture, "file");
      if (sources.containsKey(id)) {
        throw invalid("artifact");
      }
      byte[] bytes = readBoundBytes(directory, file, SOURCE_LIMIT, id);
      if (!requiredString(fixture, "sha256").equals("sha256:" + sha256(bytes))) {
        throw invalid(id);
      }
      sources.put(id, parseObject(bytes, id));
    }
    Loaded loaded = new Loaded(artifact, Map.copyOf(sources));
    assertGlobalIntegrity(loaded);
    return loaded;
  }

  static MaterializedDocument materializeDocumentVector(Loaded loaded, JsonObject vector) {
    String id = requiredString(vector, "id");
    String predicate = requiredString(vector, "predicate");
    boolean expected = requiredBoolean(vector, "expected");
    if ("manifest".equals(predicate) || "operation".equals(predicate)) {
      JsonObject directive = object(vector.get("document"));
      String sourceId = requiredString(directive, "source");
      JsonObject source = requiredSource(loaded, sourceId, id);
      String revisionField = "manifest".equals(predicate) ? "manifestRevision" : "revision";
      Map<String, Object> document =
          applyPatches(source, objects(directive.get("patches")), id, revisionField);
      JsonObject revision = object(directive.get("revision"));
      String mode = requiredString(revision, "mode");
      if ("set".equals(mode)) {
        document.put(revisionField, requiredString(revision, "value"));
      } else if (!"preserve".equals(mode)) {
        throw invalid(id);
      }
      JsonObject owned = ownObject(document, id);
      boolean matches =
          requiredString(owned, revisionField).equals(CanonicalJson.revision(owned, revisionField));
      boolean expectedMatch = "match".equals(requiredString(revision, "expect"));
      if (matches != expectedMatch) {
        throw invalid(id);
      }
      return new MaterializedDocument(id, predicate, owned, null, null, expected);
    }
    if (!"resolve".equals(predicate)) {
      throw invalid(id);
    }
    JsonObject requestDirective = object(vector.get("request"));
    JsonObject responseDirective = object(vector.get("response"));
    JsonObject request =
        ownObject(
            applyPatches(
                requiredSource(loaded, requiredString(requestDirective, "source"), id),
                objects(requestDirective.get("patches")),
                id,
                null),
            id);
    JsonObject response =
        ownObject(
            applyPatches(
                requiredSource(loaded, requiredString(responseDirective, "source"), id),
                objects(responseDirective.get("patches")),
                id,
                null),
            id);
    return new MaterializedDocument(id, predicate, null, request, response, expected);
  }

  static MaterializedOperation materializePresetCase(
      Loaded loaded, JsonObject suite, JsonObject presetCase) {
    String id = requiredString(suite, "id") + "." + requiredString(presetCase, "id");
    Map<String, Object> operation = mutableObject(requiredSource(loaded, "operation", id), id);
    operation.put("inputSchema", mutableValue(object(suite.get("inputSchema")), id));
    List<Object> rules = new ArrayList<>();
    for (String pointer : strings(suite.get("secretPointers"))) {
      rules.add(
          new LinkedHashMap<>(
              Map.of("kind", "secret", "schemaPointer", pointer, "retention", "none")));
    }
    operation.put("inputHandling", new LinkedHashMap<>(Map.of("rules", rules)));
    operation.put("dataSources", new ArrayList<>());
    operation.remove("uiSchema");
    List<Object> presets = new ArrayList<>();
    List<JsonObject> presetInputs = objects(presetCase.get("presetInputs"));
    for (int index = 0; index < presetInputs.size(); index++) {
      Map<String, Object> preset = new LinkedHashMap<>();
      preset.put("id", "preset-" + index);
      preset.put("label", "Preset " + index);
      preset.put("input", mutableValue(presetInputs.get(index), id));
      presets.add(preset);
    }
    operation.put("presets", presets);
    String expectedRevision = requiredString(presetCase, "expectedRevision");
    operation.put("revision", expectedRevision);
    JsonObject owned = ownObject(operation, id);
    if (!expectedRevision.equals(CanonicalJson.revision(owned, "revision"))) {
      throw invalid(id);
    }
    return new MaterializedOperation(id, owned, requiredBoolean(presetCase, "expected"));
  }

  static MaterializedOperation materializeWorkload(Loaded loaded, JsonObject workload) {
    String id = requiredString(workload, "id");
    JsonObject recipe = object(workload.get("recipe"));
    String kind = requiredString(recipe, "kind");
    if (!WORKLOAD_KINDS.contains(kind)) {
      throw invalid(id);
    }
    Map<String, Object> source = mutableObject(requiredSource(loaded, "operation", id), id);
    Map<String, Object> operation =
        switch (kind) {
          case "deep-chain" -> deepChain(source, recipe, workload, id);
          case "rules-presets-cartesian" -> cartesian(source, recipe, workload, id);
          case "dense-mutual-reference" -> dense(source, recipe, workload, id);
          case "wide-array" -> wide(source, recipe, workload, id);
          default -> throw invalid(id);
        };
    JsonObject owned = ownObject(operation, id);
    String expectedRevision = requiredString(workload, "expectedRevision");
    if (!expectedRevision.equals(CanonicalJson.revision(owned, "revision"))) {
      throw invalid(id);
    }
    int canonicalBytes = canonicalBytesForRevision(owned);
    if (canonicalBytes != requiredLong(workload, "canonicalBytes")) {
      throw invalid(id);
    }
    return new MaterializedOperation(id, owned, requiredBoolean(workload, "expected"));
  }

  private static Map<String, Object> deepChain(
      Map<String, Object> source, JsonObject recipe, JsonObject workload, String id) {
    Map<String, Object> target = new LinkedHashMap<>(Map.of("type", "string"));
    Map<String, Object> node = new LinkedHashMap<>();
    node.put("type", "object");
    node.put(
        "properties",
        new LinkedHashMap<>(
            Map.of(
                "secret", new LinkedHashMap<>(Map.of("$ref", "#/$defs/target")),
                "next", new LinkedHashMap<>(Map.of("$ref", "#/$defs/node")))));
    Map<String, Object> schema = objectSchema();
    schema.put(
        "properties",
        new LinkedHashMap<>(Map.of("chain", new LinkedHashMap<>(Map.of("$ref", "#/$defs/node")))));
    schema.put("$defs", new LinkedHashMap<>(Map.of("node", node, "target", target)));

    Map<String, Object> value =
        "secret".equals(requiredString(recipe, "leaf"))
            ? new LinkedHashMap<>(Map.of("secret", "seeded"))
            : new LinkedHashMap<>();
    int depth = Math.toIntExact(requiredLong(recipe, "depth"));
    for (int index = 0; index < depth; index++) {
      value = new LinkedHashMap<>(Map.of("next", value));
    }
    List<String> pointers =
        requiredBoolean(recipe, "secretPointer") ? List.of("/$defs/target") : List.of();
    return assemblePresetOperation(
        source,
        schema,
        pointers,
        List.of(new LinkedHashMap<>(Map.of("chain", value))),
        requiredString(workload, "expectedRevision"));
  }

  private static Map<String, Object> cartesian(
      Map<String, Object> source, JsonObject recipe, JsonObject workload, String id) {
    int propertyCount = Math.toIntExact(requiredLong(recipe, "propertyCount"));
    int ruleCopies = Math.toIntExact(requiredLong(recipe, "ruleCopies"));
    int presetCount = Math.toIntExact(requiredLong(recipe, "presetCount"));
    Map<String, Object> properties = new LinkedHashMap<>();
    List<String> pointers = new ArrayList<>();
    for (int index = 0; index < propertyCount; index++) {
      properties.put("secret" + index, new LinkedHashMap<>(Map.of("type", "string")));
      pointers.add("/properties/secret" + index);
    }
    Map<String, Object> schema = objectSchema();
    schema.put("properties", properties);
    schema.put("additionalProperties", false);
    List<Object> rules = new ArrayList<>();
    for (int copy = 0; copy < ruleCopies; copy++) {
      for (String pointer : pointers) {
        rules.add(
            new LinkedHashMap<>(
                Map.of("kind", "secret", "schemaPointer", pointer, "retention", "none")));
      }
    }
    source.put("inputSchema", schema);
    source.put("inputHandling", new LinkedHashMap<>(Map.of("rules", rules)));
    source.put("dataSources", new ArrayList<>());
    source.remove("uiSchema");
    List<Object> presets = new ArrayList<>();
    for (int index = 0; index < presetCount; index++) {
      presets.add(
          new LinkedHashMap<>(
              Map.of(
                  "id", "empty-" + index,
                  "label", "Empty " + index,
                  "input", new LinkedHashMap<>())));
    }
    source.put("presets", presets);
    source.put("revision", requiredString(workload, "expectedRevision"));
    return source;
  }

  private static Map<String, Object> dense(
      Map<String, Object> source, JsonObject recipe, JsonObject workload, String id) {
    int graphSize = Math.toIntExact(requiredLong(recipe, "graphSize"));
    List<String> names = new ArrayList<>();
    for (int index = 0; index < graphSize; index++) {
      names.add("n" + index);
    }
    Map<String, Object> definitions = new LinkedHashMap<>();
    for (String name : names) {
      Map<String, Object> properties = new LinkedHashMap<>();
      for (int index = 0; index < names.size(); index++) {
        properties.put(
            "p" + index, new LinkedHashMap<>(Map.of("$ref", "#/$defs/" + names.get(index))));
      }
      definitions.put(
          name, new LinkedHashMap<>(Map.of("type", "object", "properties", properties)));
    }
    Map<String, Object> schema = objectSchema();
    schema.put(
        "properties",
        new LinkedHashMap<>(
            Map.of(
                "start", new LinkedHashMap<>(Map.of("$ref", "#/$defs/n0")),
                "secret", new LinkedHashMap<>(Map.of("type", "string")))));
    schema.put("$defs", definitions);
    source.put("inputSchema", schema);
    source.put(
        "inputHandling",
        new LinkedHashMap<>(
            Map.of(
                "rules",
                List.of(
                    new LinkedHashMap<>(
                        Map.of(
                            "kind", "secret",
                            "schemaPointer", "/properties/secret",
                            "retention", "none"))))));
    source.put("dataSources", new ArrayList<>());
    source.remove("uiSchema");
    source.put(
        "presets",
        List.of(
            new LinkedHashMap<>(
                Map.of(
                    "id", "empty",
                    "label", "Empty",
                    "input", new LinkedHashMap<>()))));
    source.put("revision", requiredString(workload, "expectedRevision"));
    return source;
  }

  private static Map<String, Object> wide(
      Map<String, Object> source, JsonObject recipe, JsonObject workload, String id) {
    Map<String, Object> schema = objectSchema();
    schema.put(
        "properties",
        new LinkedHashMap<>(
            Map.of(
                "values",
                new LinkedHashMap<>(
                    Map.of(
                        "type",
                        "array",
                        "items",
                        new LinkedHashMap<>(Map.of("$ref", "#/$defs/target")))))));
    schema.put(
        "$defs",
        new LinkedHashMap<>(Map.of("target", new LinkedHashMap<>(Map.of("type", "string")))));
    int itemCount = Math.toIntExact(requiredLong(recipe, "itemCount"));
    source.put("inputSchema", schema);
    if (requiredBoolean(recipe, "secretRule")) {
      source.put(
          "inputHandling",
          new LinkedHashMap<>(
              Map.of(
                  "rules",
                  List.of(
                      new LinkedHashMap<>(
                          Map.of(
                              "kind", "secret",
                              "schemaPointer", "/$defs/target",
                              "retention", "none"))))));
    } else {
      source.remove("inputHandling");
    }
    source.put("dataSources", new ArrayList<>());
    source.remove("uiSchema");
    source.put(
        "presets",
        List.of(
            new LinkedHashMap<>(
                Map.of(
                    "id", "wide",
                    "label", "Wide",
                    "input",
                        new LinkedHashMap<>(
                            Map.of(
                                "values",
                                new ArrayList<>(
                                    java.util.Collections.nCopies(itemCount, "x"))))))));
    source.put("revision", requiredString(workload, "expectedRevision"));
    return source;
  }

  private static Map<String, Object> assemblePresetOperation(
      Map<String, Object> operation,
      Map<String, Object> inputSchema,
      List<String> secretPointers,
      List<Map<String, Object>> presetInputs,
      String expectedRevision) {
    return assemblePresetOperation(
        operation, inputSchema, secretPointers, presetInputs, expectedRevision, true);
  }

  private static Map<String, Object> assemblePresetOperation(
      Map<String, Object> operation,
      Map<String, Object> inputSchema,
      List<String> secretPointers,
      List<Map<String, Object>> presetInputs,
      String expectedRevision,
      boolean includeEmptyHandling) {
    operation.put("inputSchema", inputSchema);
    List<Object> rules = new ArrayList<>();
    for (String pointer : secretPointers) {
      rules.add(
          new LinkedHashMap<>(
              Map.of("kind", "secret", "schemaPointer", pointer, "retention", "none")));
    }
    if (includeEmptyHandling || !rules.isEmpty()) {
      operation.put("inputHandling", new LinkedHashMap<>(Map.of("rules", rules)));
    } else {
      operation.remove("inputHandling");
    }
    operation.put("dataSources", new ArrayList<>());
    operation.remove("uiSchema");
    List<Object> presets = new ArrayList<>();
    for (int index = 0; index < presetInputs.size(); index++) {
      Map<String, Object> preset = new LinkedHashMap<>();
      preset.put("id", "preset-" + index);
      preset.put("label", "Preset " + index);
      preset.put("input", presetInputs.get(index));
      presets.add(preset);
    }
    operation.put("presets", presets);
    operation.put("revision", expectedRevision);
    return operation;
  }

  private static Map<String, Object> objectSchema() {
    return new LinkedHashMap<>(
        Map.of(
            "$schema", "https://json-schema.org/draft/2020-12/schema",
            "type", "object"));
  }

  private static void assertGlobalIntegrity(Loaded loaded) {
    JsonObject artifact = loaded.artifact;
    requireEquals(artifact, "format", "tc-adapter-semantic-vectors@1");
    requireEquals(artifact, "patchProfile", "rfc6902-test-subset@1");
    requireEquals(artifact, "presetAssemblyProfile", "tc-preset-operation@1");
    requireEquals(artifact, "workloadProfile", "tc-preset-workloads@1");
    List<JsonObject> documents = objects(artifact.get("documentVectors"));
    List<JsonObject> suites = objects(artifact.get("presetSuites"));
    List<JsonObject> workloads = objects(artifact.get("workloads"));
    int presetCount = suites.stream().mapToInt(suite -> objects(suite.get("cases")).size()).sum();
    if (documents.size() != 56 || presetCount != 54 || workloads.size() != 7) {
      throw invalid("artifact");
    }

    Set<String> ids = new HashSet<>();
    List<String> mismatchIds = new ArrayList<>();
    for (JsonObject vector : documents) {
      String id = requiredString(vector, "id");
      requireUniqueSafeId(ids, id);
      MaterializedDocument materialized = materializeDocumentVector(loaded, vector);
      if (materialized.document != null) {
        JsonObject revision = object(object(vector.get("document")).get("revision"));
        if ("mismatch".equals(requiredString(revision, "expect"))) {
          mismatchIds.add(id);
        }
      }
    }
    for (JsonObject suite : suites) {
      for (JsonObject presetCase : objects(suite.get("cases"))) {
        String id = requiredString(suite, "id") + "." + requiredString(presetCase, "id");
        requireUniqueSafeId(ids, id);
        materializePresetCase(loaded, suite, presetCase);
      }
    }
    for (JsonObject workload : workloads) {
      String id = requiredString(workload, "id");
      requireUniqueSafeId(ids, id);
      if (!WORKLOAD_KINDS.contains(requiredString(object(workload.get("recipe")), "kind"))) {
        throw invalid(id);
      }
    }
    mismatchIds.sort(String::compareTo);
    if (ids.size() != 117
        || !mismatchIds.equals(List.of("manifest.stale-revision", "operation.stale-revision"))) {
      throw invalid("artifact");
    }
  }

  private static void requireUniqueSafeId(Set<String> ids, String id) {
    if (!SAFE_ID.matcher(id).matches() || !ids.add(id)) {
      throw invalid("artifact");
    }
  }

  private static void requireEquals(JsonObject object, String key, String expected) {
    if (!expected.equals(requiredString(object, key))) {
      throw invalid("artifact");
    }
  }

  private static void validateArtifactAgainstCompanion(
      JsonObject schemaDocument, JsonObject artifact) {
    try {
      var config = SchemaRegistryConfig.builder().formatAssertionsEnabled(true).build();
      var registry =
          SchemaRegistry.withDialect(
              Dialects.getDraft202012(), builder -> builder.schemaRegistryConfig(config));
      var schema = registry.getSchema(CanonicalJson.encodeString(schemaDocument), InputFormat.JSON);
      var errors =
          schema.validate(
              CanonicalJson.encodeString(artifact),
              InputFormat.JSON,
              context ->
                  context.executionConfig(execution -> execution.formatAssertionsEnabled(true)));
      if (!errors.isEmpty()) {
        throw invalid("artifact");
      }
    } catch (RuntimeException exception) {
      throw invalid("artifact");
    }
  }

  private static void assertOnlyLocalDefinitionReferences(JsonObject schema) {
    ArrayDeque<JsonValue> pending = new ArrayDeque<>();
    pending.push(schema);
    while (!pending.isEmpty()) {
      JsonValue value = pending.pop();
      if (value instanceof JsonObject object) {
        String reference = string(object.get("$ref"));
        if (reference != null) {
          if (!reference.startsWith("#/$defs/")
              || resolvePointer(schema, reference.substring(1)) == null) {
            throw invalid("schema");
          }
        }
        pending.addAll(object.values().values());
      } else if (value instanceof JsonList list) {
        pending.addAll(list.values());
      }
    }
  }

  private static JsonValue resolvePointer(JsonValue root, String pointer) {
    JsonValue current = root;
    for (String token : decodePointer(pointer, "schema")) {
      if (!(current instanceof JsonObject object)) {
        return null;
      }
      current = object.get(token);
      if (current == null) {
        return null;
      }
    }
    return current;
  }

  private static Path fixtureDirectory() {
    String configured = System.getProperty("gauntletProtocolFixtures");
    if (configured == null || configured.isBlank()) {
      throw invalid("fixture-directory");
    }
    Path path = Path.of(configured);
    if (!path.isAbsolute()
        || Files.isSymbolicLink(path)
        || !Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)) {
      throw invalid("fixture-directory");
    }
    return path;
  }

  private static byte[] readBoundBytes(Path directory, String name, int limit, String id) {
    if (!SAFE_SIBLING.matcher(name).matches()) {
      throw invalid(id);
    }
    Path path = directory.resolve(name);
    try {
      if (Files.isSymbolicLink(path) || !Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) {
        throw invalid(id);
      }
      long size = Files.size(path);
      if (size <= 0 || size >= limit) {
        throw invalid(id);
      }
      byte[] bytes = Files.readAllBytes(path);
      if (bytes.length != size
          || startsWithBom(bytes)
          || containsCarriageReturn(bytes)
          || bytes[bytes.length - 1] != '\n'
          || (bytes.length > 1 && bytes[bytes.length - 2] == '\n')) {
        throw invalid(id);
      }
      StandardCharsets.UTF_8
          .newDecoder()
          .onMalformedInput(CodingErrorAction.REPORT)
          .onUnmappableCharacter(CodingErrorAction.REPORT)
          .decode(ByteBuffer.wrap(bytes));
      return bytes;
    } catch (IOException exception) {
      throw invalid(id);
    }
  }

  private static boolean startsWithBom(byte[] bytes) {
    return bytes.length >= 3
        && (bytes[0] & 0xff) == 0xef
        && (bytes[1] & 0xff) == 0xbb
        && (bytes[2] & 0xff) == 0xbf;
  }

  private static boolean containsCarriageReturn(byte[] bytes) {
    for (byte value : bytes) {
      if (value == '\r') {
        return true;
      }
    }
    return false;
  }

  private static JsonObject parseObject(byte[] bytes, String id) {
    try {
      JsonValue value = JsonOwnership.parseRevision(bytes);
      if (value instanceof JsonObject object) {
        return object;
      }
      throw invalid(id);
    } catch (IllegalArgumentException exception) {
      throw invalid(id);
    }
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> mutableObject(JsonObject value, String id) {
    Object result = mutableValue(value, id);
    if (!(result instanceof Map<?, ?> map)) {
      throw invalid(id);
    }
    return (Map<String, Object>) map;
  }

  private static Object mutableValue(JsonValue value, String id) {
    try {
      return MAPPER.readValue(CanonicalJson.encode(value), Object.class);
    } catch (RuntimeException exception) {
      throw invalid(id);
    }
  }

  @SuppressWarnings("unchecked")
  private static Object mutableCopy(Object value, String id) {
    try {
      return MAPPER.readValue(MAPPER.writeValueAsBytes(value), Object.class);
    } catch (RuntimeException exception) {
      throw invalid(id);
    }
  }

  private static Map<String, Object> applyPatches(
      JsonObject source, List<JsonObject> patches, String id, String protectedRevisionField) {
    Map<String, Object> document = mutableObject(source, id);
    for (JsonObject patch : patches) {
      String operation = requiredString(patch, "op");
      String path = requiredString(patch, "path");
      List<String> pathTokens = decodePointer(path, id);
      if (protectedRevisionField != null
          && !pathTokens.isEmpty()
          && protectedRevisionField.equals(pathTokens.getFirst())) {
        throw invalid(id);
      }
      Object value;
      if ("copy".equals(operation)) {
        String from = requiredString(patch, "from");
        List<String> fromTokens = decodePointer(from, id);
        if (protectedRevisionField != null
            && !fromTokens.isEmpty()
            && protectedRevisionField.equals(fromTokens.getFirst())) {
          throw invalid(id);
        }
        value = mutableCopy(existingValue(document, fromTokens, id), id);
      } else if ("remove".equals(operation)) {
        value = null;
      } else if ("add".equals(operation) || "replace".equals(operation)) {
        JsonValue patchValue = patch.get("value");
        if (patchValue == null) {
          throw invalid(id);
        }
        value = mutableValue(patchValue, id);
      } else {
        throw invalid(id);
      }

      Parent parent = patchParent(document, pathTokens, id);
      if (parent.value instanceof List<?> listValue) {
        @SuppressWarnings("unchecked")
        List<Object> list = (List<Object>) listValue;
        boolean append = "add".equals(operation) || "copy".equals(operation);
        int index = arrayIndex(parent.token, list.size(), append, id);
        if (append) {
          list.add(index, value);
        } else if ("remove".equals(operation)) {
          list.remove(index);
        } else {
          list.set(index, value);
        }
      } else if (parent.value instanceof Map<?, ?> mapValue) {
        @SuppressWarnings("unchecked")
        Map<String, Object> map = (Map<String, Object>) mapValue;
        boolean add = "add".equals(operation) || "copy".equals(operation);
        if (!add && !map.containsKey(parent.token)) {
          throw invalid(id);
        }
        if ("remove".equals(operation)) {
          map.remove(parent.token);
        } else {
          map.put(parent.token, value);
        }
      } else {
        throw invalid(id);
      }
    }
    return document;
  }

  private static Object existingValue(Object document, List<String> path, String id) {
    Object current = document;
    for (String token : path) {
      if (current instanceof List<?> list) {
        current = list.get(arrayIndex(token, list.size(), false, id));
      } else if (current instanceof Map<?, ?> map) {
        if (!map.containsKey(token)) {
          throw invalid(id);
        }
        current = map.get(token);
      } else {
        throw invalid(id);
      }
    }
    return current;
  }

  private static Parent patchParent(Object document, List<String> path, String id) {
    if (path.isEmpty()) {
      throw invalid(id);
    }
    Object parent = document;
    for (int index = 0; index < path.size() - 1; index++) {
      String token = path.get(index);
      if (parent instanceof List<?> list) {
        parent = list.get(arrayIndex(token, list.size(), false, id));
      } else if (parent instanceof Map<?, ?> map) {
        if (!map.containsKey(token)) {
          throw invalid(id);
        }
        parent = map.get(token);
      } else {
        throw invalid(id);
      }
    }
    return new Parent(parent, path.getLast());
  }

  private static List<String> decodePointer(String pointer, String id) {
    if (pointer.isEmpty() || !pointer.startsWith("/")) {
      throw invalid(id);
    }
    List<String> result = new ArrayList<>();
    for (String token : pointer.substring(1).split("/", -1)) {
      if (token.matches(".*~(?:[^01]|$).*$")) {
        throw invalid(id);
      }
      result.add(token.replace("~1", "/").replace("~0", "~"));
    }
    return result;
  }

  private static int arrayIndex(String token, int length, boolean allowAppend, String id) {
    if (allowAppend && "-".equals(token)) {
      return length;
    }
    if (!CANONICAL_INDEX.matcher(token).matches()) {
      throw invalid(id);
    }
    try {
      int index = Integer.parseInt(token);
      int maximum = allowAppend ? length : length - 1;
      if (index > maximum) {
        throw invalid(id);
      }
      return index;
    } catch (NumberFormatException exception) {
      throw invalid(id);
    }
  }

  private static int canonicalBytesForRevision(JsonObject operation) {
    return CanonicalJson.encode(operation).length;
  }

  private static JsonObject ownObject(Map<String, Object> value, String id) {
    try {
      JsonValue owned = JsonOwnership.ownRevision(value);
      if (owned instanceof JsonObject object) {
        return object;
      }
      throw invalid(id);
    } catch (IllegalArgumentException exception) {
      throw invalid(id);
    }
  }

  private static JsonObject requiredSource(Loaded loaded, String sourceId, String id) {
    JsonObject source = loaded.sources.get(sourceId);
    if (source == null) {
      throw invalid(id);
    }
    return source;
  }

  private static List<JsonObject> objects(JsonValue value) {
    if (!(value instanceof JsonList list)) {
      throw invalid("artifact");
    }
    return list.values().stream().map(SemanticVectorLoader::object).toList();
  }

  private static List<String> strings(JsonValue value) {
    if (!(value instanceof JsonList list)) {
      throw invalid("artifact");
    }
    return list.values().stream()
        .map(
            item -> {
              String result = string(item);
              if (result == null) {
                throw invalid("artifact");
              }
              return result;
            })
        .toList();
  }

  private static JsonObject object(JsonValue value) {
    if (!(value instanceof JsonObject object)) {
      throw invalid("artifact");
    }
    return object;
  }

  private static String requiredString(JsonObject object, String key) {
    String value = string(object.get(key));
    if (value == null) {
      throw invalid("artifact");
    }
    return value;
  }

  private static boolean requiredBoolean(JsonObject object, String key) {
    JsonValue value = object.get(key);
    if (value != null && value.unwrap() instanceof Boolean result) {
      return result;
    }
    throw invalid("artifact");
  }

  private static long requiredLong(JsonObject object, String key) {
    JsonValue value = object.get(key);
    if (value != null && value.unwrap() instanceof Long result) {
      return result;
    }
    throw invalid("artifact");
  }

  private static String string(JsonValue value) {
    return value != null && value.unwrap() instanceof String string ? string : null;
  }

  private static String sha256(byte[] bytes) {
    try {
      return java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    } catch (NoSuchAlgorithmException exception) {
      throw new IllegalStateException("SHA-256 is unavailable", exception);
    }
  }

  private static IllegalArgumentException invalid(String id) {
    return new IllegalArgumentException("invalid semantic vector: " + id);
  }

  record Loaded(JsonObject artifact, Map<String, JsonObject> sources) {}

  record MaterializedDocument(
      String id,
      String predicate,
      JsonObject document,
      JsonObject request,
      JsonObject response,
      boolean expected) {}

  record MaterializedOperation(String id, JsonObject operation, boolean expected) {}

  private record Parent(Object value, String token) {}
}
