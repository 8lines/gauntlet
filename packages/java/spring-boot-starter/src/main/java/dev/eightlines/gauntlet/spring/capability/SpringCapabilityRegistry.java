package dev.eightlines.gauntlet.spring.capability;

import dev.eightlines.gauntlet.core.json.JsonOwnership;
import dev.eightlines.gauntlet.core.model.AdapterDiagnostic;
import dev.eightlines.gauntlet.core.model.Problem;
import dev.eightlines.gauntlet.core.model.ProtocolRequirements;
import dev.eightlines.gauntlet.core.spi.CapabilityProvider;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/** Resolves capability advertisement from concrete endpoint SPIs, never configuration strings. */
public final class SpringCapabilityRegistry {
  public static final String CANCELLATION = "tc-run-cancellation@1";
  public static final String EVENTS = "tc-run-sse@1";
  public static final String UPLOADS = "tc-uploads@1";
  public static final String SESSION_LAUNCH = "tc-session-launch@1";

  private static final Set<String> CORE = Set.of(CANCELLATION, EVENTS, UPLOADS, SESSION_LAUNCH);

  private final List<String> ids;
  private final List<AdapterDiagnostic> diagnostics;
  private final CancelRunEndpoint cancellation;
  private final RunEventsEndpoint events;
  private final UploadEndpoint uploads;
  private final SessionLaunchEndpoint sessionLaunch;

  public SpringCapabilityRegistry(
      List<CancelRunEndpoint> cancellation,
      List<RunEventsEndpoint> events,
      List<UploadEndpoint> uploads,
      List<SessionLaunchEndpoint> sessionLaunch,
      List<CapabilityProvider> genericProviders) {
    var collectedIds = new ArrayList<String>();
    var collectedDiagnostics = new ArrayList<AdapterDiagnostic>();
    this.cancellation = single(cancellation, CANCELLATION, collectedIds, collectedDiagnostics);
    this.events = single(events, EVENTS, collectedIds, collectedDiagnostics);
    this.uploads = single(uploads, UPLOADS, collectedIds, collectedDiagnostics);
    this.sessionLaunch = single(sessionLaunch, SESSION_LAUNCH, collectedIds, collectedDiagnostics);

    var future = new LinkedHashMap<String, List<CapabilityProvider>>();
    for (CapabilityProvider provider : List.copyOf(genericProviders)) {
      try {
        String id = provider.capabilityId();
        new ProtocolRequirements(List.of(), List.of(id));
        if (CORE.contains(id)) {
          collectedDiagnostics.add(diagnostic("core-capability-provider-mismatch"));
        } else {
          future.computeIfAbsent(id, ignored -> new ArrayList<>()).add(provider);
        }
      } catch (RuntimeException exception) {
        collectedDiagnostics.add(diagnostic("invalid-capability-provider"));
      }
    }
    future.entrySet().stream()
        .sorted(Map.Entry.comparingByKey())
        .forEach(
            entry -> {
              if (entry.getValue().size() == 1) {
                collectedIds.add(entry.getKey());
              } else {
                collectedDiagnostics.add(diagnostic("duplicate-capability-provider"));
              }
            });
    collectedIds.sort(String::compareTo);
    this.ids = List.copyOf(collectedIds);
    this.diagnostics = List.copyOf(collectedDiagnostics);
  }

  public List<String> ids() {
    return ids;
  }

  public List<AdapterDiagnostic> diagnostics() {
    return diagnostics;
  }

  public boolean supports(String id) {
    return ids.contains(id);
  }

  public Optional<CancelRunEndpoint> cancellation() {
    return Optional.ofNullable(cancellation);
  }

  public Optional<RunEventsEndpoint> events() {
    return Optional.ofNullable(events);
  }

  public Optional<UploadEndpoint> uploads() {
    return Optional.ofNullable(uploads);
  }

  public Optional<SessionLaunchEndpoint> sessionLaunch() {
    return Optional.ofNullable(sessionLaunch);
  }

  public Problem unavailable(String capability) {
    if (!CORE.contains(capability)) {
      throw new IllegalArgumentException("unsupported core capability ID");
    }
    return new Problem(
        "urn:gauntlet:problem:unsupported-capability",
        "Unsupported capability",
        501,
        "The adapter does not advertise or implement this capability.",
        null,
        null,
        List.of(),
        capability,
        JsonOwnership.object(Map.of()));
  }

  private static <T> T single(
      List<T> candidates, String id, List<String> ids, List<AdapterDiagnostic> diagnostics) {
    List<T> copy = List.copyOf(candidates);
    if (copy.size() == 1) {
      ids.add(id);
      return copy.getFirst();
    }
    if (copy.size() > 1) diagnostics.add(diagnostic("duplicate-capability-provider"));
    return null;
  }

  private static AdapterDiagnostic diagnostic(String code) {
    return new AdapterDiagnostic(
        "error",
        code,
        "A capability provider was ignored because its binding is invalid.",
        null,
        JsonOwnership.object(Map.of()));
  }
}
