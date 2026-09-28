package dev.eightlines.gauntlet.core.run;

import dev.eightlines.gauntlet.core.json.CanonicalJson;
import dev.eightlines.gauntlet.core.json.JsonObject;
import dev.eightlines.gauntlet.core.json.JsonOwnership;
import dev.eightlines.gauntlet.core.model.Artifact;
import dev.eightlines.gauntlet.core.model.FollowUpAction;
import dev.eightlines.gauntlet.core.model.OperationDefinition;
import dev.eightlines.gauntlet.core.model.Run;
import dev.eightlines.gauntlet.core.model.RunState;
import dev.eightlines.gauntlet.core.registry.OperationRegistry;
import dev.eightlines.gauntlet.core.schema.SchemaValidator;
import dev.eightlines.gauntlet.core.spi.FileReferenceValidator;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.HashMap;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

public final class RuntimeGuard {
  private RuntimeGuard() {}

  public static boolean runTransitionIsValid(Run previous, Run next) {
    try {
      if (!next.id().equals(previous.id())
          || !next.operationId().equals(previous.operationId())
          || !next.operationRevision().equals(previous.operationRevision())
          || !next.createdAt().equals(previous.createdAt())
          || next.sequence() < previous.sequence()) {
        return false;
      }
      if (next.sequence() == previous.sequence()) return next.equals(previous);
      if (previous.state().terminal()
          || previous.state() == RunState.RUNNING && next.state() == RunState.QUEUED
          || timestamp(next.updatedAt()).isBefore(timestamp(previous.updatedAt()))) {
        return false;
      }
      if (previous.startedAt() != null && !previous.startedAt().equals(next.startedAt())
          || previous.completedAt() != null && !previous.completedAt().equals(next.completedAt())) {
        return false;
      }
      return previous.progress() == null
          || next.progress() == null
          || !timestamp(next.progress().updatedAt())
              .isBefore(timestamp(previous.progress().updatedAt()));
    } catch (RuntimeException exception) {
      return false;
    }
  }

  public static Optional<Run> storeRead(
      Run run, String expectedId, String expectedOperationId, String expectedRevision) {
    if (run == null) return Optional.empty();
    try {
      if (!hasExactExecutionTerminalProblem(run)) return Optional.empty();
      CanonicalJson.encode(run.toProtocolMap());
      if (expectedId != null && !expectedId.equals(run.id())) return Optional.empty();
      if (expectedOperationId != null && !expectedOperationId.equals(run.operationId()))
        return Optional.empty();
      if (expectedRevision != null && !expectedRevision.equals(run.operationRevision()))
        return Optional.empty();
      var artifacts = new HashMap<String, Artifact>();
      for (Artifact artifact : run.artifacts()) {
        if (artifacts.putIfAbsent(artifact.id(), artifact) != null) {
          return Optional.empty();
        }
      }
      for (FollowUpAction action : run.actions()) {
        if ("browser-launch".equals(action.kind())) {
          Artifact artifact = artifacts.get(action.artifactId());
          if (artifact == null || !"browser-launch".equals(artifact.kind())) {
            return Optional.empty();
          }
        }
      }
      return Optional.of(run);
    } catch (RuntimeException exception) {
      return Optional.empty();
    }
  }

  /** Validates a durable or capability-supplied snapshot against its authoritative catalog. */
  public static boolean storedRunIsValid(
      Run run,
      String expectedId,
      OperationDefinition definition,
      OperationRegistry operations,
      SchemaValidator validator,
      FileReferenceValidator fileReferenceValidator,
      Instant now) {
    try {
      Objects.requireNonNull(definition, "definition");
      Objects.requireNonNull(operations, "operations");
      Objects.requireNonNull(validator, "validator");
      Objects.requireNonNull(now, "now");
      if (storeRead(run, expectedId, definition.id(), definition.revision()).isEmpty()) {
        return false;
      }
      if (run.output() != null
          && !Objects.requireNonNull(
                  validator.validate(definition.output().schema(), run.output()),
                  "output validation errors")
              .isEmpty()) {
        return false;
      }
      for (FollowUpAction action : run.actions()) {
        if (!"invoke-operation".equals(action.kind())) continue;
        var target = operations.find(action.operationId()).orElse(null);
        if (target == null) return false;
        JsonObject input = action.input() == null ? JsonOwnership.object(Map.of()) : action.input();
        OperationDefinition targetDefinition = target.definition();
        if (!Objects.requireNonNull(
                validator.validate(targetDefinition.inputSchema(), input),
                "action input validation errors")
            .isEmpty()) {
          return false;
        }
        if (!InputHandlingGuard.secretGuard(targetDefinition, input).isEmpty()
            || !InputHandlingGuard.validateFiles(
                    targetDefinition, input, fileReferenceValidator, now)
                .isEmpty()) {
          return false;
        }
      }
      return true;
    } catch (RuntimeException exception) {
      return false;
    }
  }

  private static java.time.Instant timestamp(String value) {
    return OffsetDateTime.parse(value).toInstant();
  }

  private static boolean hasExactExecutionTerminalProblem(Run run) {
    if (run.state() == RunState.CANCELLED) {
      return problemMatches(run, "urn:gauntlet:problem:run-cancelled", "Run cancelled", 409);
    }
    if (run.state() == RunState.TIMED_OUT) {
      return problemMatches(run, "urn:gauntlet:problem:run-timed-out", "Run timed out", 504);
    }
    return true;
  }

  private static boolean problemMatches(Run run, String type, String title, int status) {
    return run.problem() != null
        && type.equals(run.problem().type())
        && title.equals(run.problem().title())
        && status == run.problem().status();
  }
}
