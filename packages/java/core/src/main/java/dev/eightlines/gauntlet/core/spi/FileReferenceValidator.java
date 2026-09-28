package dev.eightlines.gauntlet.core.spi;

import dev.eightlines.gauntlet.core.model.FileReference;
import dev.eightlines.gauntlet.core.model.InputHandling;
import dev.eightlines.gauntlet.core.model.ValidationError;
import java.time.Instant;
import java.util.List;

public interface FileReferenceValidator {
  List<ValidationError> validate(ValidationRequest request);

  record ValidationRequest(
      FileReference reference,
      InputHandling.FileRule rule,
      String instancePath,
      String operationId,
      String operationRevision,
      Instant validatedAt) {}
}
