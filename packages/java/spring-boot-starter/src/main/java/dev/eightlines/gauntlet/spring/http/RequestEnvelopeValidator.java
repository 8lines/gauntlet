package dev.eightlines.gauntlet.spring.http;

import dev.eightlines.gauntlet.core.json.JsonList;
import dev.eightlines.gauntlet.core.json.JsonObject;
import dev.eightlines.gauntlet.core.json.JsonOwnership;
import dev.eightlines.gauntlet.core.json.JsonValue;
import dev.eightlines.gauntlet.core.model.ConfirmationAcknowledgement;
import dev.eightlines.gauntlet.core.model.CreateRunRequest;
import dev.eightlines.gauntlet.core.model.DataSourceQuery;
import dev.eightlines.gauntlet.core.model.DataSourceResolveRequest;
import dev.eightlines.gauntlet.core.model.InvocationContext;
import dev.eightlines.gauntlet.core.model.OperationImpact;
import dev.eightlines.gauntlet.core.model.ProtocolId;
import dev.eightlines.gauntlet.core.model.ValidationError;
import jakarta.servlet.http.HttpServletRequest;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Closed request-envelope mapper that parses bytes through Core duplicate-safe ownership. */
public final class RequestEnvelopeValidator {
  static final int MAX_JSON_BYTES = 4 * 1024 * 1024;

  public JsonObject parse(HttpServletRequest request, byte[] body) {
    String contentType = request.getContentType();
    if (contentType == null) throw problem("unsupported-media-type", "Unsupported media type", 415);
    String media = contentType.split(";", 2)[0].trim().toLowerCase(java.util.Locale.ROOT);
    if (!media.equals("application/json")
        && !media.matches("^application/[a-z0-9!#$&^_.+-]+\\+json$")) {
      throw problem("unsupported-media-type", "Unsupported media type", 415);
    }
    if (body != null && body.length > MAX_JSON_BYTES) {
      throw problem("request-too-large", "Request too large", 413);
    }
    if (body == null || body.length == 0) {
      throw problem("invalid-json", "Invalid JSON", 400);
    }
    try {
      JsonValue value = JsonOwnership.parseRuntime(body);
      if (value instanceof JsonObject object) return object;
      throw validation("", "#", "type");
    } catch (RequestProblemException exception) {
      throw exception;
    } catch (RuntimeException exception) {
      throw problem("invalid-json", "Invalid JSON", 400);
    }
  }

  public CreateRunRequest createRun(JsonObject envelope) {
    requireAllowed(
        envelope,
        Set.of(
            "operationRevision",
            "input",
            "context",
            "dryRun",
            "idempotencyKey",
            "confirmation",
            "extensions"));
    String revision = requiredString(envelope, "operationRevision");
    if (!revision.matches("^sha256:[0-9a-f]{64}$")) {
      throw validation("/operationRevision", "#/properties/operationRevision/pattern", "pattern");
    }
    JsonObject input = requiredObject(envelope, "input", "/input");
    InvocationContext context = optionalContext(envelope.get("context"), "/context");
    boolean dryRun = optionalBoolean(envelope, "dryRun", false);
    String idempotencyKey = optionalString(envelope, "idempotencyKey");
    if (idempotencyKey != null && idempotencyKey.isEmpty()) {
      throw validation("/idempotencyKey", "#/properties/idempotencyKey/minLength", "minLength");
    }
    ConfirmationAcknowledgement confirmation = optionalConfirmation(envelope.get("confirmation"));
    return new CreateRunRequest(
        revision, input, context, dryRun, idempotencyKey, confirmation, extensions(envelope, ""));
  }

  public DataSourceQuery dataSourceQuery(JsonObject envelope) {
    requireAllowed(
        envelope, Set.of("search", "cursor", "limit", "dependencies", "context", "extensions"));
    String search = optionalString(envelope, "search");
    String cursor = optionalString(envelope, "cursor");
    Integer limit = optionalPositiveInteger(envelope, "limit");
    JsonObject dependencies = pointerMap(envelope.get("dependencies"), "/dependencies");
    InvocationContext context = optionalContext(envelope.get("context"), "/context");
    return new DataSourceQuery(
        search, limit, cursor, dependencies, context, extensions(envelope, ""));
  }

  public DataSourceResolveRequest dataSourceResolve(JsonObject envelope) {
    requireAllowed(envelope, Set.of("values", "dependencies", "context", "extensions"));
    JsonValue valuesNode = envelope.get("values");
    if (!(valuesNode instanceof JsonList values)) {
      throw validation("/values", "#/properties/values/type", "type");
    }
    var strings = new ArrayList<String>();
    for (int index = 0; index < values.values().size(); index++) {
      Object raw = values.values().get(index).unwrap();
      if (!(raw instanceof String string)) {
        throw validation("/values/" + index, "#/properties/values/items/type", "type");
      }
      strings.add(string);
    }
    JsonObject dependencies = pointerMap(envelope.get("dependencies"), "/dependencies");
    InvocationContext context = optionalContext(envelope.get("context"), "/context");
    return new DataSourceResolveRequest(strings, dependencies, context, extensions(envelope, ""));
  }

  private static InvocationContext optionalContext(JsonValue value, String path) {
    if (value == null) return null;
    if (!(value instanceof JsonObject context)) throw validation(path, "#/type", "type");
    requireAllowed(
        context, Set.of("requestId", "locale", "timeZone", "actor", "target", "extensions"), path);
    String requestId = portableId(context, "requestId", path);
    JsonObject actor = identity(context.get("actor"), path + "/actor", Set.of("id", "displayName"));
    JsonObject target =
        identity(context.get("target"), path + "/target", Set.of("id", "environment"));
    return new InvocationContext(
        requestId,
        optionalString(context, "locale", path),
        optionalString(context, "timeZone", path),
        actor,
        target,
        extensions(context, path));
  }

  private static ConfirmationAcknowledgement optionalConfirmation(JsonValue value) {
    if (value == null) return null;
    if (!(value instanceof JsonObject confirmation)) {
      throw validation("/confirmation", "#/$defs/confirmationAcknowledgement/type", "type");
    }
    requireAllowed(
        confirmation,
        Set.of("operationId", "operationRevision", "impact", "extensions"),
        "/confirmation");
    String operationId = requiredString(confirmation, "operationId", "/confirmation");
    try {
      ProtocolId.require(operationId);
    } catch (RuntimeException exception) {
      throw validation("/confirmation/operationId", "#/$defs/portableId/pattern", "pattern");
    }
    String revision = requiredString(confirmation, "operationRevision", "/confirmation");
    if (!revision.matches("^sha256:[0-9a-f]{64}$")) {
      throw validation(
          "/confirmation/operationRevision",
          "#/$defs/confirmationAcknowledgement/properties/operationRevision/pattern",
          "pattern");
    }
    String impactValue = requiredString(confirmation, "impact", "/confirmation");
    OperationImpact impact;
    try {
      impact = OperationImpact.fromWireValue(impactValue);
    } catch (RuntimeException exception) {
      throw validation(
          "/confirmation/impact",
          "#/$defs/confirmationAcknowledgement/properties/impact/enum",
          "enum");
    }
    return new ConfirmationAcknowledgement(
        operationId, revision, impact, extensions(confirmation, "/confirmation"));
  }

  private static JsonObject identity(JsonValue value, String path, Set<String> allowed) {
    if (value == null) return null;
    if (!(value instanceof JsonObject object)) throw validation(path, "#/type", "type");
    requireAllowed(object, allowed, path);
    portableId(object, "id", path);
    for (String key : allowed) {
      if (!key.equals("id") && object.get(key) != null) optionalString(object, key, path);
    }
    return object;
  }

  private static JsonObject pointerMap(JsonValue value, String path) {
    if (value == null) return empty();
    if (!(value instanceof JsonObject object)) throw validation(path, "#/type", "type");
    for (String key : object.values().keySet()) {
      if (!key.matches("^(?:/(?:[^~/]|~[01])*)*$")) {
        throw validation(path + "/" + pointerToken(key), "#/propertyNames", "pattern");
      }
    }
    return object;
  }

  private static JsonObject extensions(JsonObject owner, String prefix) {
    JsonValue value = owner.get("extensions");
    if (value == null) return empty();
    if (!(value instanceof JsonObject object)) {
      throw validation(prefix + "/extensions", "#/$defs/extensions/type", "type");
    }
    for (String key : object.values().keySet()) {
      if (!key.matches("^urn:[A-Za-z0-9][A-Za-z0-9:._/-]*$")) {
        throw validation(
            prefix + "/extensions/" + pointerToken(key),
            "#/$defs/extensions/propertyNames",
            "pattern");
      }
    }
    return object;
  }

  private static Integer optionalPositiveInteger(JsonObject owner, String key) {
    JsonValue value = owner.get(key);
    if (value == null) return null;
    if (value.unwrap() instanceof Long number && number > 0 && number <= Integer.MAX_VALUE) {
      return number.intValue();
    }
    throw validation("/" + key, "#/properties/" + key, "minimum");
  }

  private static boolean optionalBoolean(JsonObject owner, String key, boolean fallback) {
    JsonValue value = owner.get(key);
    if (value == null) return fallback;
    if (value.unwrap() instanceof Boolean bool) return bool;
    throw validation("/" + key, "#/properties/" + key + "/type", "type");
  }

  private static String requiredString(JsonObject owner, String key) {
    return requiredString(owner, key, "");
  }

  private static String requiredString(JsonObject owner, String key, String prefix) {
    String value = optionalString(owner, key, prefix);
    if (value != null) return value;
    throw validation(prefix + "/" + key, "#/required", "required");
  }

  private static String optionalString(JsonObject owner, String key) {
    return optionalString(owner, key, "");
  }

  private static String optionalString(JsonObject owner, String key, String prefix) {
    JsonValue value = owner.get(key);
    if (value == null) return null;
    if (value.unwrap() instanceof String string) return string;
    throw validation(prefix + "/" + key, "#/properties/" + key + "/type", "type");
  }

  private static String portableId(JsonObject owner, String key, String prefix) {
    String value = requiredString(owner, key, prefix);
    try {
      return ProtocolId.require(value);
    } catch (RuntimeException exception) {
      throw validation(prefix + "/" + key, "#/$defs/portableId/pattern", "pattern");
    }
  }

  private static JsonObject requiredObject(JsonObject owner, String key, String path) {
    JsonValue value = owner.get(key);
    if (value instanceof JsonObject object) return object;
    throw validation(path, "#/properties/" + key + "/type", "type");
  }

  private static void requireAllowed(JsonObject object, Set<String> allowed) {
    requireAllowed(object, allowed, "");
  }

  private static void requireAllowed(JsonObject object, Set<String> allowed, String prefix) {
    for (String key : object.values().keySet()) {
      if (!allowed.contains(key)) {
        throw validation(
            prefix + "/" + pointerToken(key), "#/additionalProperties", "additionalProperties");
      }
    }
  }

  private static RequestProblemException validation(
      String instancePath, String schemaPath, String keyword) {
    return new RequestProblemException(
        ProblemResponseFactory.validation(
            List.of(
                new ValidationError(
                    instancePath, schemaPath, keyword, "value does not satisfy schema", empty()))));
  }

  private static RequestProblemException problem(String slug, String title, int status) {
    return new RequestProblemException(ProblemResponseFactory.problem(slug, title, status));
  }

  private static String pointerToken(String value) {
    return value.replace("~", "~0").replace("/", "~1");
  }

  private static JsonObject empty() {
    return JsonOwnership.object(Map.of());
  }
}
