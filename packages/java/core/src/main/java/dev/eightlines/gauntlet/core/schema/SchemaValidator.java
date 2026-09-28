package dev.eightlines.gauntlet.core.schema;

import dev.eightlines.gauntlet.core.json.JsonObject;
import dev.eightlines.gauntlet.core.json.JsonValue;
import dev.eightlines.gauntlet.core.model.ValidationError;
import java.util.List;

public interface SchemaValidator {
  List<ValidationError> validate(JsonObject schema, JsonValue instance);
}
