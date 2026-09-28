package dev.eightlines.gauntlet.spring.http;

import dev.eightlines.gauntlet.core.json.CanonicalJson;
import dev.eightlines.gauntlet.core.json.JsonObject;
import dev.eightlines.gauntlet.core.json.JsonOwnership;
import dev.eightlines.gauntlet.core.model.OperationDefinition;
import dev.eightlines.gauntlet.core.model.Problem;
import dev.eightlines.gauntlet.core.model.Run;
import dev.eightlines.gauntlet.spring.catalog.SpringAdapterCatalog;
import dev.eightlines.gauntlet.spring.catalog.SpringAdapterException;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/** Applies the same catalog, schema, input-handling, and action guards used by normal runs. */
public final class CatalogCapabilityRunValidator implements CapabilityRunValidator {
  private final SpringAdapterCatalog catalog;
  private final ProblemResponseFactory problems;

  public CatalogCapabilityRunValidator(
      SpringAdapterCatalog catalog, ProblemResponseFactory problems) {
    this.catalog = Objects.requireNonNull(catalog, "catalog");
    this.problems = Objects.requireNonNull(problems, "problems");
  }

  @Override
  public Run validate(
      Run candidate, String expectedRunId, String expectedOperationId, Origin origin) {
    try {
      Run run = sanitizeProblem(Objects.requireNonNull(candidate, "run"));
      if (expectedRunId != null && !expectedRunId.equals(run.id())
          || expectedOperationId != null && !expectedOperationId.equals(run.operationId())) {
        throw new IllegalArgumentException("capability run identity mismatch");
      }
      OperationDefinition definition =
          catalog.operation(run.operationId()).orElseThrow(IllegalArgumentException::new);
      if (catalog.operationSummary(run.operationId()).isEmpty()
          || !definition.revision().equals(run.operationRevision())
          || !catalog.runProjectionIsValid(
              run, expectedRunId == null ? run.id() : expectedRunId, expectedOperationId)) {
        throw new IllegalArgumentException("capability run is not catalog-valid");
      }
      CanonicalJson.encode(run.toProtocolMap());
      return run;
    } catch (SpringAdapterException exception) {
      throw exception;
    } catch (RuntimeException exception) {
      throw rejected(origin);
    }
  }

  private Run sanitizeProblem(Run run) {
    if (run.problem() == null) return run;
    Problem safe = problems.sanitizeEmbedded(run.problem());
    return new Run(
        run.id(),
        run.operationId(),
        run.operationRevision(),
        run.sequence(),
        run.state(),
        run.createdAt(),
        run.updatedAt(),
        run.startedAt(),
        run.completedAt(),
        run.progress(),
        run.summary(),
        run.output(),
        run.artifacts(),
        run.actions(),
        safe,
        run.extensions());
  }

  private static SpringAdapterException rejected(Origin origin) {
    boolean capability = origin == Origin.CAPABILITY;
    return new SpringAdapterException(
        new Problem(
            capability
                ? "urn:gauntlet:problem:adapter-invalid-response"
                : "urn:gauntlet:problem:adapter-internal-error",
            capability ? "Invalid adapter response" : "Adapter internal error",
            capability ? 502 : 500,
            null,
            null,
            null,
            List.of(),
            null,
            empty()));
  }

  private static JsonObject empty() {
    return JsonOwnership.object(Map.of());
  }
}
